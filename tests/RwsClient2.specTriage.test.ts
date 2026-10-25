import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';
import { CTRL } from '../src/paths/ctrl.js';

/**
 * Wire-shape tests for the client defects the 2026-10-07 spec check found and
 * the 2026-10-07/09 re-check confirmed. Each test locks the method, path, field names and values that
 * ABB's Rev L Swagger and the controller forms on RW 7.21.4 and 8.2.1 agree
 * on. No live controller.
 */

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface Recorded { method: string; url: string; body: string; contentType: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    void collectBody(req).then(body => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', body,
        contentType: (req.headers['content-type'] ?? '') as string,
      });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const ok204 = (_req: http.IncomingMessage, res: http.ServerResponse): void => { res.writeHead(204); res.end(); };
const halState = (type: string, fields: Record<string, string>): string =>
  JSON.stringify({ _links: { base: { href: 'https://x/' } }, state: [{ _type: type, _title: type, ...fields }] });

const client = (port: number): RwsClient2 => new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');

describe('spec check 2026-10-07: controller service', () => {
  it('saveDiagnostics sends the documented dstpath field as a fileservice URI', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      await client(port).saveDiagnostics('$TEMP/diag.log');
      expect(requests).toHaveLength(1);
      expect(`${requests[0].method} ${requests[0].url}`).toBe('POST /ctrl/diagnostics/save');
      expect(requests[0].body).toBe('dstpath=%2Ffileservice%2F%24TEMP%2Fdiag.log');
      expect(requests[0].contentType).toBe('application/x-www-form-urlencoded;v=2.0');
    } finally { server.close(); }
  });

  it('saveDiagnostics without a destination is refused before anything is sent (ABB marks dstpath required)', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      const err = await client(port).saveDiagnostics().catch(e => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).code).toBe('INVALID_ARGUMENT');
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('the installed-system row uses the RWS 2.0 resource name /ctrl/system', () => {
    expect(CTRL.getSystems.rws2?.path).toBe('/ctrl/system');
  });

  it('listSafetyZones answers [] without a request: no ABB document has /ctrl/safety/zones', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      await expect(client(port).listSafetyZones()).resolves.toEqual([]);
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('runCyclicBrakeCheck throws UNSUPPORTED_OPERATION without a request and points to the status read', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      const err = await client(port).runCyclicBrakeCheck().catch(e => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).code).toBe('UNSUPPORTED_OPERATION');
      expect(String((err as Error).message)).toMatch(/getCyclicBrakeCheckStatus/);
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  describe('certificate store', () => {
    const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

    it('uploadCertificate puts the PEM in TEMP, posts filepath to the store, then deletes the temp file', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        await client(port).uploadCertificate('/controller/trust_ca_store', PEM);
        expect(requests.map(r => r.method)).toEqual(['PUT', 'POST', 'DELETE']);
        const [put, post, del] = requests;
        expect(put.url).toMatch(/^\/fileservice\/\$TEMP\/abb-rws-cert-\d+-[a-z0-9]+\.pem$/);
        expect(put.contentType).toBe('text/plain;v=2.0');
        expect(put.body).toBe(PEM);
        expect(post.url).toBe('/ctrl/certstore/controller/trust_ca_store');
        expect(post.contentType).toBe('application/x-www-form-urlencoded;v=2.0');
        const tmp = put.url.replace(/^\/fileservice\//, '');
        expect(post.body).toBe(`filepath=${encodeURIComponent(`/fileservice/${tmp}`)}`);
        expect(del.url).toBe(put.url);
      } finally { server.close(); }
    });

    it('uploadCertificate deletes the temp file even when the store refuses the add', async () => {
      const { server, port, requests } = await startServer((req, res) => {
        if (req.method === 'POST') { res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' }); res.end('<html/>'); return; }
        res.writeHead(204); res.end();
      });
      try {
        await expect(client(port).uploadCertificate('controller/trust_ca_store', PEM)).rejects.toBeInstanceOf(RwsError);
        expect(requests.map(r => r.method)).toEqual(['PUT', 'POST', 'DELETE']);
      } finally { server.close(); }
    });

    it('uploadCertificate refuses an empty store path or PEM before sending', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        await expect(client(port).uploadCertificate('', PEM)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        await expect(client(port).uploadCertificate('controller/trust_ca_store', '  ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        expect(requests).toHaveLength(0);
      } finally { server.close(); }
    });

    it('clearCertificateStore posts an empty form to .../{scope}/{store}/clear', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        await client(port).clearCertificateStore('controller', 'trust_ca_store');
        expect(requests).toHaveLength(1);
        expect(`${requests[0].method} ${requests[0].url}`).toBe('POST /ctrl/certstore/controller/trust_ca_store/clear');
        expect(requests[0].contentType).toBe('application/x-www-form-urlencoded;v=2.0');
        expect(requests[0].body).toBe('');
      } finally { server.close(); }
    });

    it('clearCertificateStore refuses a missing scope or store before sending', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        await expect(client(port).clearCertificateStore('', 'trust_ca_store')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        await expect(client(port).clearCertificateStore('controller', '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        expect(requests).toHaveLength(0);
      } finally { server.close(); }
    });

    it('removeCertificate throws UNSUPPORTED_OPERATION without a request: one certificate cannot be removed', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const err = await client(port).removeCertificate('controller/trust_ca_store').catch(e => e);
        expect(err).toBeInstanceOf(RwsError);
        expect((err as RwsError).code).toBe('UNSUPPORTED_OPERATION');
        expect(String((err as Error).message)).toMatch(/clearCertificateStore/);
        expect(requests).toHaveLength(0);
      } finally { server.close(); }
    });
  });

  describe('virtual time', () => {
    const vtServer = (state: string, speed: string): ReturnType<typeof startServer> => startServer((req, res) => {
      const url = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      if (url.includes('vttime')) { res.end(halState('ctrl-vttime', { vtcounter: '123456' })); return; }
      if (url.includes('vtstate')) { res.end(halState('ctrl-vtstate', { vtcurrstate: state })); return; }
      res.end(halState('ctrl-vtspeed', { vtcurrspeed: speed }));
    });

    it('getVirtualTime reads VTFREERUN as running, a percent as a factor, and milliseconds as they are', async () => {
      const { server, port } = await vtServer('VTFREERUN', '100');
      try {
        expect(await client(port).getVirtualTime()).toEqual({ time: 123456, running: true, speed: 1, state: 'VTFREERUN' });
      } finally { server.close(); }
    });

    it('getVirtualTime reads VTSTOP as stopped and VTRUNSLICE as running', async () => {
      const stopped = await vtServer('VTSTOP', '1000');
      try {
        expect(await client(stopped.port).getVirtualTime()).toMatchObject({ running: false, speed: 10, state: 'VTSTOP' });
      } finally { stopped.server.close(); }
      const slice = await vtServer('VTRUNSLICE', '-1');
      try {
        expect(await client(slice.port).getVirtualTime()).toMatchObject({ running: true, speed: Infinity, state: 'VTRUNSLICE' });
      } finally { slice.server.close(); }
    });

    it('has no virtual-time state write row: there is no pause or resume over RWS; use RobotStudio\'s Simulation tab', () => {
      expect((CTRL as Record<string, unknown>).setVirtualTimeRunning).toBeUndefined();
    });

    it('the deprecated setVirtualTimeRunning sends nothing and throws UNSUPPORTED_OPERATION', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        for (const running of [true, false]) {
          const err = await client(port).setVirtualTimeRunning(running).catch(e => e);
          expect(err).toBeInstanceOf(RwsError);
          expect((err as RwsError).code).toBe('UNSUPPORTED_OPERATION');
          expect(String((err as Error).message)).toMatch(/RobotStudio's Simulation tab/);
        }
        expect(requests).toHaveLength(0);
      } finally { server.close(); }
    });

    it('setVirtualTimeScale posts vtspeed=<percent> with no action: 1 -> 100, 10 -> 1000, 0.5 -> 50, Infinity -> -1', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const c = client(port);
        await c.setVirtualTimeScale(1);
        await c.setVirtualTimeScale(10);
        await c.setVirtualTimeScale(0.5);
        await c.setVirtualTimeScale(Infinity);
        expect(requests.every(r => r.url === '/ctrl/virtualtime/vtspeed')).toBe(true);
        expect(requests.map(r => r.body)).toEqual(['vtspeed=100', 'vtspeed=1000', 'vtspeed=50', 'vtspeed=-1']);
      } finally { server.close(); }
    });

    it('setVirtualTimeScale refuses 0, a negative value and NaN before sending', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        for (const bad of [0, -1, Number.NaN]) {
          await expect(client(port).setVirtualTimeScale(bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        }
        expect(requests).toHaveLength(0);
      } finally { server.close(); }
    });
  });

  describe('backup status', () => {
    const stateServer = (state: string): ReturnType<typeof startServer> => startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(halState('ctrl-backup-state', { 'backup-state': state }));
    });

    it('getBackupStatus polls /ctrl/backup/state and reads the busy states as active', async () => {
      for (const busy of ['Init State', 'Backup in Progress']) {
        const { server, port, requests } = await stateServer(busy);
        try {
          expect(await client(port).getBackupStatus()).toMatchObject({ active: true, phase: busy, failed: false });
          expect(`${requests[0].method} ${requests[0].url}`).toBe('GET /ctrl/backup/state');
        } finally { server.close(); }
      }
    });

    it('getBackupStatus reads Backup Ready and None as idle, and the error states as failed', async () => {
      for (const idle of ['Backup Ready', 'None']) {
        const { server, port } = await stateServer(idle);
        try { expect(await client(port).getBackupStatus()).toMatchObject({ active: false, phase: idle, failed: false }); }
        finally { server.close(); }
      }
      for (const bad of ['Error during backup', 'Invalid']) {
        const { server, port } = await stateServer(bad);
        try { expect(await client(port).getBackupStatus()).toMatchObject({ active: false, phase: bad, failed: true }); }
        finally { server.close(); }
      }
    });
  });
});

describe('spec check 2026-10-07: RAPID, panel, motion and retcode (verified 2026-10-09)', () => {
  const writesTo = (requests: Recorded[], part: string): Recorded[] => requests.filter(r => r.method === 'POST' && r.url.includes(part));

  it('activateRapidTask / deactivateRapidTask post to the per-task resource with no body', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      const c = client(port);
      await c.activateRapidTask('T_ROB1');
      await c.deactivateRapidTask('T_ROB2');
      const [act] = writesTo(requests, '/activate');
      const [deact] = writesTo(requests, '/deactivate');
      expect(act.url).toBe('/rw/rapid/tasks/T_ROB1/activate');
      expect(act.body).toBe('');
      expect(deact.url).toBe('/rw/rapid/tasks/T_ROB2/deactivate');
      expect(deact.body).toBe('');
      expect(requests.some(r => r.url === '/rw/rapid/tasks/activate' || r.url === '/rw/rapid/tasks/deactivate')).toBe(false);
    } finally { server.close(); }
  });

  it('setPPToCursor sends the form fields module, line, column', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      await client(port).setPPToCursor('T_ROB1', 'M1', 6, 14);
      const [post] = writesTo(requests, '/pcp/cursor');
      expect(post.url).toBe('/rw/rapid/tasks/T_ROB1/pcp/cursor');
      expect(post.body).toBe('module=M1&line=6&column=14');
    } finally { server.close(); }
  });

  it('callServiceRoutine throws UNSUPPORTED_OPERATION without a request: the resource is a GET listing', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      const err = await client(port).callServiceRoutine('T_ROB1', 'rService').catch(e => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).code).toBe('UNSUPPORTED_OPERATION');
      expect(String((err as Error).message)).toMatch(/setPPToRoutine/);
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('unlockOperationMode posts the pin the lock set, and refuses a call without one before sending', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      const c = client(port);
      await expect(c.unlockOperationMode()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(c.unlockOperationMode('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(requests).toHaveLength(0);
      await c.unlockOperationMode('1234');
      expect(`${requests[0].method} ${requests[0].url}`).toBe('POST /rw/panel/opmode/unlock');
      expect(requests[0].body).toBe('pin=1234');
    } finally { server.close(); }
  });

  it("setMotionSupervisionMode and setCollisionPredictionMode send ABB's true/false token", async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      const c = client(port);
      await c.setMotionSupervisionMode(false);
      await c.setMotionSupervisionMode('ON');
      await c.setMotionSupervisionMode('off', 'ROB_2');
      await c.setCollisionPredictionMode(true);
      await c.setCollisionPredictionMode('OFF');
      const ms = writesTo(requests, '/motionsupervision/mode');
      expect(ms.map(r => `${r.url} ${r.body}`)).toEqual([
        '/rw/motionsystem/mechunits/ROB_1/motionsupervision/mode mode=false',
        '/rw/motionsystem/mechunits/ROB_1/motionsupervision/mode mode=true',
        '/rw/motionsystem/mechunits/ROB_2/motionsupervision/mode mode=false',
      ]);
      expect(writesTo(requests, '/collisionprediction').map(r => r.body)).toEqual(['mode=true', 'mode=false']);
      await expect(c.setMotionSupervisionMode('maybe')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally { server.close(); }
  });

  it('getReturnCode asks for the code only: no lang query (the controller serves English only)', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(halState('err-desc', { name: 'SYS_CTRL_E_MASTER_REJECT', code: '-1073445859', description: 'Mastership is held by someone else' }));
    });
    try {
      const r = await client(port).getReturnCode(-1073445859, 'de');
      expect(requests[0].url).toBe('/rw/retcode?code=-1073445859');
      expect(r).toEqual({ code: -1073445859, title: 'SYS_CTRL_E_MASTER_REJECT', desc: 'Mastership is held by someone else' });
    } finally { server.close(); }
  });
});

describe('spec check 2026-10-07: Integrated Vision paths', () => {
  it('getVisionSystemInfo reads /rw/vision/{camera}/info (class camera-info-li)', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(halState('camera-info-li', { name: 'cam1', 'ip-address': '192.168.125.100' }));
    });
    try {
      const info = await client(port).getVisionSystemInfo('cam1');
      expect(requests[0].url).toBe('/rw/vision/cam1/info');
      expect(info).toMatchObject({ name: 'cam1', 'ip-address': '192.168.125.100' });
    } finally { server.close(); }
  });

  it('listVisionJobs reads the one job name at /rw/vision/{camera}/job-name', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(halState('vision-camera-job', { jobname: 'Inspect.job' }));
    });
    try {
      expect(await client(port).listVisionJobs('cam1')).toEqual([{ name: 'Inspect.job' }]);
      expect(requests[0].url).toBe('/rw/vision/cam1/job-name');
    } finally { server.close(); }
  });

  it('listVisionJobs answers [] when the camera reports no job name', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(halState('vision-camera-job', { jobname: '' }));
    });
    try { expect(await client(port).listVisionJobs('cam1')).toEqual([]); } finally { server.close(); }
  });

  it('triggerVisionJob throws UNSUPPORTED_OPERATION without a request: RWS 2.0 documents no trigger', async () => {
    const { server, port, requests } = await startServer(ok204);
    try {
      const err = await client(port).triggerVisionJob('cam1', 'Inspect.job').catch(e => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).code).toBe('UNSUPPORTED_OPERATION');
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });
});
