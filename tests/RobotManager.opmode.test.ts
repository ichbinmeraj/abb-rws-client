import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyControllerError } from '../src/ControllerError.js';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { setLogger } from '../src/Logger.js';
import type { RwsError } from '../src/types.js';

/**
 * RobotManager.setOperationMode and the access it holds, per RobotWare
 * generation, over a fake controller (the real RWS 2.0 transport, so the
 * refusals are classified with what the manager knows).
 *
 * - RobotWare 8 changes the operating mode only for a control station that
 *   holds write access. RW 8.2.1 refused a switch to MANR sent without it
 *   (403 -1073435873, live 2026-09-30), so write access is held around every
 *   switch, not only a switch to Auto.
 * - While a switch to Auto waits for the confirmation at the FlexPendant
 *   (AUTO_CH), RW 8.2.1 refuses every write-access request with 403
 *   -1073414145, "Unknown Error", icode -4502 (live 2026-09-30). The switch is
 *   then not sent, and the refusal names the pending confirmation, not a
 *   client error.
 * - RobotWare 7 is unchanged: no mastership for a switch to a manual mode,
 *   edit mastership around a switch to Auto.
 *
 * The two controller answers are the bodies recorded from the RW 8.2.1
 * virtual controller, up to and including the message; the closing tags after
 * it are rebuilt.
 */

const x2 = (code: number, msg: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:80/"/></head>'
  + `<body><div class="status"><span class="code">${code}</span><span class="msg">${msg}</span></div></body></html>`;

/** RW 8.2.1, POST /rw/controlstation/writeaccess/request while the mode read AUTO_CH. */
const WRITE_ACCESS_IN_AUTO_CH = x2(-1073414145, 'rws_resource_writeaccess.cpp[283] Unknown Error code:-1073414145 icode:-4502');
/** RW 8.2.1, POST /rw/panel/opmode from a station without write access. */
const OPMODE_NOT_HELD = x2(-1073435873, 'rws_resource_panel.cpp[644] User does not have write access code:-1073435873 icode:-4501');

interface Fake {
  gen: 'rw7' | 'rw8';
  opmode: string;
  held: boolean;
}

async function startController(fake: Fake) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const line = `${req.method} ${req.url}`;
      requests.push(line);
      const xhtml = (status: number, text: string): void => {
        res.writeHead(status, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end(text);
      };
      if (line === 'POST /rw/controlstation/writeaccess/request') {
        if (/_CH$/.test(fake.opmode)) { xhtml(403, WRITE_ACCESS_IN_AUTO_CH); return; }
        fake.held = true;
      }
      if (line === 'POST /rw/controlstation/writeaccess/release') { fake.held = false; }
      if (line === 'POST /rw/panel/opmode') {
        if (fake.gen === 'rw8' && !fake.held) { xhtml(403, OPMODE_NOT_HELD); return; }
        const wire = new URLSearchParams(body).get('opmode');
        fake.opmode = wire === 'auto' ? 'AUTO_CH' : wire === 'man' ? 'MANR' : 'MANF';
        res.writeHead(202); res.end();
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

/** A connected manager over the fake, its state as polling left it. */
function managerOver(port: number, fake: Fake, quality: 'polling' | 'stale' = 'polling'): RobotManager {
  const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p', {
    controlStation: { name: 'Test PC', id: '{AAAAAAAA-0000-4000-8000-000000000001}' },
  });
  (adapter as unknown as { writeAccessMode: string }).writeAccessMode = fake.gen === 'rw8' ? 'controlstation' : 'mastership';
  const mgr = new RobotManager();
  const m = mgr as unknown as {
    adapter: unknown; _state: Record<string, unknown>;
    watchAccess(a: unknown): void; accessIfAny(a: unknown): unknown;
  };
  m.adapter = adapter;
  Object.assign(m._state, {
    connected: true, quality, opmode: fake.opmode, ctrlstate: 'guardstop',
    identity: { name: 'IRB1600_6_120_4', id: 'x', type: 'VIRTUAL_CONTROLLER', mac: '' },
  });
  // What connect() does once the adapter is built.
  m.watchAccess(m.accessIfAny(adapter));
  return mgr;
}

const heldLocks = (mgr: RobotManager): string[] =>
  (mgr.state.access?.locks ?? []).filter(l => l.state === 'held' && l.count > 0).map(l => l.lock);

const QUIET = { info() {}, warn() {}, error() {}, show() {} };
beforeEach(() => { setLogger(QUIET); });
afterEach(() => { setLogger(QUIET); });

describe('RobotWare 8: write access around every operation-mode switch', () => {
  it('a switch from Auto to MANR is sent under write access, which is released afterwards', async () => {
    const fake: Fake = { gen: 'rw8', opmode: 'AUTO', held: false };
    const { server, port, requests } = await startController(fake);
    try {
      const mgr = managerOver(port, fake);
      await mgr.setOperationMode('MANR');
      expect(requests).toEqual([
        'POST /rw/controlstation/register/remote',
        // The motion-control allowance is read once after each registration.
        'GET /rw/controlstation/allowmotioncontrol',
        'POST /rw/controlstation/writeaccess/request',
        'POST /rw/panel/opmode',
        'POST /rw/controlstation/writeaccess/release',
      ]);
      expect(fake.opmode).toBe('MANR');
      expect(heldLocks(mgr)).toEqual([]);
    } finally { server.close(); }
  });

  it('a switch inside a hold the caller took reuses it and leaves it held', async () => {
    const fake: Fake = { gen: 'rw8', opmode: 'AUTO', held: false };
    const { server, port, requests } = await startController(fake);
    try {
      const mgr = managerOver(port, fake);
      await mgr.requestMastership('rapid');
      await mgr.setOperationMode('MANR');
      expect(requests.filter(r => /writeaccess/.test(r))).toEqual(['POST /rw/controlstation/writeaccess/request']);
      expect(heldLocks(mgr)).toEqual(['writeaccess']);
      await mgr.releaseMastership('rapid');
      expect(requests[requests.length - 1]).toBe('POST /rw/controlstation/writeaccess/release');
    } finally { server.close(); }
  });

  it('in AUTO_CH the refused write-access request is reported as the pending confirmation, and the switch is not sent', async () => {
    const fake: Fake = { gen: 'rw8', opmode: 'AUTO_CH', held: false };
    const { server, port, requests } = await startController(fake);
    try {
      const mgr = managerOver(port, fake);
      const err = await mgr.setOperationMode('AUTO').then(() => null, (e: unknown) => e as RwsError);
      expect(err).not.toBeNull();
      expect(requests).not.toContain('POST /rw/panel/opmode');
      expect(err!).toMatchObject({ code: 'WRONG_MODE', httpStatus: 403, controllerCode: -1073414145 });
      expect(err!.refusal).toMatchObject({
        kind: 'wrong-mode', condition: 'operating-mode', grantor: 'pendant-operator', generation: 'rw8', evidence: 'vc',
        controller: { code: -1073414145, hex: '0xC004FFFF', icode: -4502, request: 'POST /rw/controlstation/writeaccess/request' },
      });
      expect(err!.message).toMatch(/^setOperationMode\('AUTO'\) was not sent: RobotWare 8 changes the operating mode only for a control station that holds write access/);
      expect(err!.message).toMatch(/waits for the confirmation at the FlexPendant \(it reads AUTO_CH\)/);
      expect(err!.message).toMatch(/sending the switch again does not confirm it/);
      expect(err!.message).not.toMatch(/client error/);
      expect(heldLocks(mgr)).toEqual([]);
    } finally { server.close(); }
  });

  it('with the mode not known the refusal stays unexplained, but the switch is still not sent and no client error is claimed', async () => {
    const fake: Fake = { gen: 'rw8', opmode: 'AUTO_CH', held: false };
    const { server, port, requests } = await startController(fake);
    try {
      const mgr = managerOver(port, fake, 'stale');
      const err = await mgr.setOperationMode('AUTO').then(() => null, (e: unknown) => e as RwsError);
      expect(requests).not.toContain('POST /rw/panel/opmode');
      expect(err!).toMatchObject({ code: 'UNKNOWN', controllerCode: -1073414145 });
      expect(err!.refusal?.kind).toBe('unknown');
      expect(err!.message).toMatch(/^setOperationMode\('AUTO'\) was not sent/);
      expect(err!.message).not.toMatch(/client error/);
    } finally { server.close(); }
  });
});

describe('RobotWare 7: unchanged', () => {
  it('a switch to MANR takes no mastership; a switch to Auto holds edit mastership around the request', async () => {
    const fake: Fake = { gen: 'rw7', opmode: 'AUTO', held: false };
    const { server, port, requests } = await startController(fake);
    try {
      const mgr = managerOver(port, fake);
      await mgr.setOperationMode('MANR');
      expect(requests).toEqual(['POST /rw/panel/opmode']);
      requests.length = 0;
      (mgr as unknown as { _state: Record<string, unknown> })._state.opmode = 'MANR';
      await mgr.setOperationMode('AUTO');
      expect(requests).toEqual(['POST /rw/mastership/edit/request', 'POST /rw/panel/opmode', 'POST /rw/mastership/edit/release']);
      expect(fake.opmode).toBe('AUTO_CH');
      expect(heldLocks(mgr)).toEqual([]);
    } finally { server.close(); }
  });
});

describe('refusalFor: a write-access request refused -1073414145 (RW 8.2.1)', () => {
  const classify = (path: string, opmode: string | null) => classifyControllerError({
    httpStatus: 403, body: WRITE_ACCESS_IN_AUTO_CH, method: 'POST', path, context: { generation: 'rw8', opmode },
  });

  it('is the pending confirmation at the FlexPendant while the mode reads AUTO_CH', () => {
    const info = classify('/rw/controlstation/writeaccess/request', 'AUTO_CH');
    expect(info.code).toBe('WRONG_MODE');
    expect(info.controllerCode).toBe(-1073414145);
    expect(info.controllerMsg).toBe('Unknown Error code:-1073414145 icode:-4502');
    expect(info.refusal).toMatchObject({ kind: 'wrong-mode', grantor: 'pendant-operator', evidence: 'vc' });
    expect(info.message).toMatch(/refused to take control-station write access while a change of operating mode waits for the confirmation at the FlexPendant/);
    expect(info.message).toContain('HTTP 403 from POST /rw/controlstation/writeaccess/request, code -1073414145 (0xC004FFFF)');
  });

  it('another pending change is explained the same way, marked unverified', () => {
    expect(classify('/rw/controlstation/writeaccess/request', 'MANF_CH').refusal).toMatchObject({ kind: 'wrong-mode', evidence: 'unverified' });
  });

  it('stays unexplained in any other mode, with no mode known, or on another request', () => {
    for (const [path, mode] of [
      ['/rw/controlstation/writeaccess/request', 'AUTO'],
      ['/rw/controlstation/writeaccess/request', null],
      ['/rw/panel/speedratio', 'AUTO_CH'],
    ] as const) {
      const info = classify(path, mode);
      expect(info.code, `${path} ${mode}`).toBe('UNKNOWN');
      expect(info.refusal?.kind, `${path} ${mode}`).toBe('unknown');
    }
  });
});
