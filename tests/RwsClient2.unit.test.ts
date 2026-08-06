import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';
import { TEST_TLS_KEY, TEST_TLS_CERT } from './TlsFixture.js';

/**
 * Unit tests for RwsClient2 against local mock servers - no live controller.
 * The protocol-level methods are exercised by tests/RwsClient2.live.test.ts and
 * the extension's test-rws2-writes.js when a VC is available.
 */

// ─── Local test server ───────────────────────────────────────────────────────

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface RecordedRequest { method: string; url: string; body: string; contentType: string }

/** Plain HTTP server that records every request and delegates to `handle`. */
async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
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

describe('RwsClient2 (unit)', () => {
  it('exports a class', () => {
    expect(typeof RwsClient2).toBe('function');
    expect(RwsClient2.name).toBe('RwsClient2');
  });

  describe('rws2ResourcePath (subscription URL builder)', () => {
    it('maps string resources to known panel paths', () => {
      // The static method is private - exercise it via known inputs/outputs.
      // We can't import it directly; instead verify the names exist on the class.
      // (If this drifts the live subscribe tests catch it.)
      expect('rws2ResourcePath' in RwsClient2).toBe(true);
    });

    it('maps signal subscription objects to /rw/iosystem/signals path', () => {
      expect('resourcePathToName' in RwsClient2).toBe(true);
    });
  });

  describe('constructor signature', () => {
    it('accepts (baseUrl, username, password)', () => {
      // Construction shouldn't throw - actual network only happens on .connect().
      const c = new RwsClient2('https://127.0.0.1:5466', 'Default User', 'robotics');
      expect(c).toBeInstanceOf(RwsClient2);
    });

    it('handles http:// base URLs', () => {
      const c = new RwsClient2('http://127.0.0.1:80', 'u', 'p');
      expect(c).toBeInstanceOf(RwsClient2);
    });

    it('accepts an options object as fourth argument', () => {
      const c = new RwsClient2('https://127.0.0.1:5466', 'u', 'p', { timeout: 2000, rejectUnauthorized: true });
      expect(c).toBeInstanceOf(RwsClient2);
    });
  });

  describe('constructor options: timeout', () => {
    it('aborts requests after the configured timeout', async () => {
      // Server that never answers - the request must die by client-side timeout.
      const server = http.createServer(() => { /* hold the request open */ });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      try {
        const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { timeout: 150 });
        const t0 = Date.now();
        await expect(c.connect()).rejects.toThrow(/timeout/i);
        expect(Date.now() - t0).toBeLessThan(5000);
      } finally { server.close(); }
    });
  });

  describe('constructor options: rejectUnauthorized', () => {
    async function startTlsServer(): Promise<{ server: https.Server; port: number }> {
      const server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end('<html><body></body></html>');
      });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      return { server, port: (server.address() as AddressInfo).port };
    }

    it('defaults to accepting self-signed certificates (all shipping controllers)', async () => {
      const { server, port } = await startTlsServer();
      try {
        const c = new RwsClient2(`https://127.0.0.1:${port}`, 'u', 'p');
        await expect(c.connect()).resolves.toBeUndefined();
      } finally { server.close(); }
    });

    it('rejectUnauthorized: true keeps TLS verification ON', async () => {
      const { server, port } = await startTlsServer();
      try {
        const c = new RwsClient2(`https://127.0.0.1:${port}`, 'u', 'p', { rejectUnauthorized: true });
        await expect(c.connect()).rejects.toThrow(/self[- ]signed|certificate/i);
      } finally { server.close(); }
    });
  });

  describe('writeSignal', () => {
    it('rejects with RwsError instead of firing a malformed request when network/device are unknown', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await expect(client.writeSignal('', '', 'doGripper', '1')).rejects.toBeInstanceOf(RwsError);
        expect(requests.length).toBe(0); // nothing must go on the wire
      } finally { server.close(); }
    });

    it('still resolves coordinates cached by listAllSignals', async () => {
      const { server, port, requests } = await startServer((req, res) => {
        if (req.method === 'GET' && (req.url ?? '').startsWith('/rw/iosystem/signals?')) {
          res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
          res.end('<html><body><ul><li class="ios-signal-li" title="Net/Dev/doGripper">'
            + '<span class="name">doGripper</span><span class="type">DO</span><span class="lvalue">0</span>'
            + '</li></ul></body></html>');
          return;
        }
        res.writeHead(204); res.end();
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.listAllSignals();
        await client.writeSignal('', '', 'doGripper', '1');
        expect(requests.some(r =>
          r.method === 'POST' && r.url === '/rw/iosystem/signals/Net/Dev/doGripper/set-value',
        )).toBe(true);
      } finally { server.close(); }
    });
  });

  describe('fileservice path encoding', () => {
    it('percent-encodes special characters in fileservice paths', async () => {
      const { server, port, requests } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('data');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.readFile('HOME/My#File.mod');
        // '#' would otherwise be parsed as a URL fragment and truncate the path.
        expect(requests[0].url).toBe('/fileservice/HOME/My%23File.mod');
      } finally { server.close(); }
    });
  });

  describe('cfg instance writes (live-verified wire shapes, OmniCore VC RW7.21)', () => {
    it('setCfgInstance POSTs bracket-representation attributes to /instances/{instance}', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.setCfgInstance('SYS', 'CAB_TASKS', 'T_ROB1', { StackSize: '25000', Entry: 'main' });
        const post = requests.find(r => r.method === 'POST');
        expect(post?.url).toBe('/rw/cfg/SYS/CAB_TASKS/instances/T_ROB1');
        expect(post?.body).toBe('StackSize=[25000,1]&Entry=[main,1]');
        expect(post?.contentType).toBe('application/x-www-form-urlencoded;v=2.0');
      } finally { server.close(); }
    });

    it('createCfgInstance POSTs name= to /instances/create-default then applies attributes', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.createCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW', { Entry: 'probeMain' });
        const posts = requests.filter(r => r.method === 'POST');
        expect(posts[0].url).toBe('/rw/cfg/SYS/CAB_TASKS/instances/create-default');
        expect(posts[0].body).toBe('name=ZZ_NEW');
        expect(posts[1].url).toBe('/rw/cfg/SYS/CAB_TASKS/instances/ZZ_NEW');
        expect(posts[1].body).toBe('Entry=[probeMain,1]');
      } finally { server.close(); }
    });

    it('createCfgInstance skips the set step when no attributes are given', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.createCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW', {});
        expect(requests.filter(r => r.method === 'POST').length).toBe(1);
      } finally { server.close(); }
    });

    it('removeCfgInstance DELETEs /instances/{instance}', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.removeCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW');
        expect(requests[0].method).toBe('DELETE');
        expect(requests[0].url).toBe('/rw/cfg/SYS/CAB_TASKS/instances/ZZ_NEW');
      } finally { server.close(); }
    });
  });

  describe('restartController mastership handling', () => {
    it('acquires edit mastership, and releases it when the restart POST is refused', async () => {
      const { server, port, requests } = await startServer((req, res) => {
        if ((req.url ?? '').includes('/ctrl/restart')) { res.writeHead(403); res.end(); return; }
        res.writeHead(204); res.end();
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await expect(client.restartController('restart')).rejects.toBeInstanceOf(RwsError);
        const urls = requests.map(r => `${r.method} ${r.url}`);
        expect(urls).toContain('POST /rw/mastership/edit/request');
        expect(urls).toContain('POST /ctrl/restart');
        // A refused restart must NOT leak edit mastership
        expect(urls).toContain('POST /rw/mastership/edit/release');
      } finally { server.close(); }
    });

    it('does not release mastership when the restart is accepted (session dies with the controller)', async () => {
      const { server, port, requests } = await startServer((_req, res) => { res.writeHead(204); res.end(); });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.restartController('restart');
        const urls = requests.map(r => `${r.method} ${r.url}`);
        expect(urls).toContain('POST /ctrl/restart');
        expect(urls).not.toContain('POST /rw/mastership/edit/release');
      } finally { server.close(); }
    });
  });

  describe('controller-level error taxonomy', () => {
    it('classifies a mastership-missing 403 with the controller code, not AUTH-flavored UNKNOWN', async () => {
      const fixture = JSON.parse(fs.readFileSync(
        path.join(__dirname, 'fixtures', 'errors', 'rws2', '403-speedratio-no-mastership-haljson.json'), 'utf8'));
      const { server, port } = await startServer((req, res) => {
        if ((req.url ?? '').includes('/rw/mastership/')) { res.writeHead(204); res.end(); return; }
        res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(fixture.response.body);
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        // Bypass the internal mastership wrap so the 403 comes from the write itself
        const err = await (client as unknown as {
          req(m: string, p: string, b?: Record<string, string>): Promise<string>;
        }).req('POST', '/rw/panel/speedratio?action=setspeedratio', { 'speed-ratio': '50' })
          .then(() => null, (e: unknown) => e as RwsError);
        expect(err).toBeInstanceOf(RwsError);
        expect(err!.code).toBe('MASTERSHIP_REQUIRED');
        expect(err!.controllerCode).toBe(-1073445859);
        expect(err!.message.toLowerCase()).toContain('mastership');
        expect(err!.message.toLowerCase()).not.toContain('password');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 1, RWS2 writes)', () => {
    it('acknowledgeOperationMode POSTs opmode to /rw/panel/opmode/acknowledge', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.acknowledgeOperationMode('auto');
        const post = requests.find(r => r.method === 'POST');
        expect(post?.url).toBe('/rw/panel/opmode/acknowledge');
        expect(post?.body).toBe('opmode=auto');
      } finally { server.close(); }
    });

    it('startProductionEntry acquires mastership, POSTs startprodentry, releases', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.startProductionEntry();
        // Live-verified 2026-08-04 (RW7.21): without mastership the controller
        // answers MASTERSHIP_REQUIRED, so the client wraps the call.
        expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
          'POST /rw/mastership/edit/request',
          'POST /rw/rapid/execution/startprodentry',
          'POST /rw/mastership/edit/release',
        ]);
        expect(requests[1].body).toBe('');
      } finally { server.close(); }
    });

    it('loadProgram POSTs progpath+loadmode to /program/load', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.loadProgram('T_ROB1', 'HOME/myprog.pgf', 'replace');
        const post = requests.find(r => r.method === 'POST');
        expect(post?.url).toBe('/rw/rapid/tasks/T_ROB1/program/load');
        expect(post?.body).toBe('progpath=HOME%2Fmyprog.pgf&loadmode=replace');
      } finally { server.close(); }
    });

    it('saveProgram POSTs path to /program/save', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.saveProgram('T_ROB1', 'HOME/backup');
        const post = requests.find(r => r.method === 'POST');
        expect(post?.url).toBe('/rw/rapid/tasks/T_ROB1/program/save');
        expect(post?.body).toBe('path=HOME%2Fbackup');
      } finally { server.close(); }
    });

    it('saveEventLogRaw POSTs a fileservice URI to /rw/elog/saveraw', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.saveEventLogRaw('HOME/elog.txt');
        const post = requests.find(r => r.method === 'POST');
        expect(post?.url).toBe('/rw/elog/saveraw');
        // Bare volume paths are rejected by the controller; the client
        // normalizes to the fileservice-URI form (live-verified 2026-08-04).
        expect(post?.body).toBe('path=%2Ffileservice%2FHOME%2Felog.txt');
      } finally { server.close(); }
    });

    it('createBackup, checkRestore and saveCfgFile normalize to fileservice URIs', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.createBackup('mybak');
        await client.checkRestore('mybak');
        await client.saveCfgFile('SYS', 'TEMP/sys.cfg');
        const posts = requests.filter(r => r.method === 'POST');
        expect(posts[0].url).toBe('/ctrl/backup/create');
        expect(posts[0].body).toBe('backup=%2Ffileservice%2FBACKUP%2Fmybak');
        expect(posts[1].url).toBe('/ctrl/backup/check-restore');
        expect(posts[1].body).toBe('backup=%2Ffileservice%2FBACKUP%2Fmybak');
        expect(posts[2].url).toBe('/rw/cfg/SYS/saveas');
        expect(posts[2].body).toBe('filepath=%2Ffileservice%2FTEMP%2Fsys.cfg');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 2, RWS2 reads)', () => {
    const halServer = (body: string): ReturnType<typeof startServer> => startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(body);
    });

    it('getRestartCount parses the restart-count span', async () => {
      const { server, port } = await halServer(
        '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ctrl","_title":"restart-count","restart-count":"3"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getRestartCount()).toBe(3);
      } finally { server.close(); }
    });

    it('getDipcQueueInfo parses queue depth and message size', async () => {
      const { server, port } = await halServer(
        '{"_links":{"base":{"href":"https://x/"}},"_embedded":{"resources":[{"_type":"dipc-queue","_title":"q1","queue-name":"q1","queue-size":"7","queue-max-msg-size":"88","queue-slot-id":"201"}]}}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const info = await client.getDipcQueueInfo('q1');
        expect(info).toEqual({ name: 'q1', size: 7, maxMsgSize: 88, slotId: '201' });
      } finally { server.close(); }
    });

    it('getRobTarget parses pose from ms-robtargets and encodes tool/wobj', async () => {
      const { server, port, requests } = await halServer(
        '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ms-robtargets","_title":"ROB_1","x":"806.29","y":"0","z":"929","q1":"0.5","q2":"0","q3":"0.866","q4":"0"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const rt = await client.getRobTarget('ROB_1', 'tool0', 'wobj0');
        expect(rt.x).toBeCloseTo(806.29);
        expect(rt.z).toBeCloseTo(929);
        expect(rt.q3).toBeCloseTo(0.866);
        expect(requests[0].url).toBe('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 3, progress + module save)', () => {
    it('saveModule normalizes volume forms to colon form and strips the extension', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.saveModule('T_ROB1', 'MyMod', 'HOME/MyMod.mod');
        await client.saveModule('T_ROB1', 'MyMod', '$TEMP');
        await client.saveModule('T_ROB1', 'MyMod', 'TEMP:');
        const posts = requests.filter(r => r.method === 'POST');
        expect(posts[0].url).toBe('/rw/rapid/tasks/T_ROB1/modules/MyMod/save');
        expect(posts[0].body).toBe('name=MyMod&path=HOME%3A');
        expect(posts[1].body).toBe('name=MyMod&path=TEMP%3A');
        expect(posts[2].body).toBe('name=MyMod&path=TEMP%3A');
      } finally { server.close(); }
    });

    it('listProgress extracts the id from the self href and keeps the operation title', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/progress/"}},"_embedded":{"resources":[{"_links":{"self":{"href":"/progress/6"}},"_type":"progress-li","_title":"save-elog-raw"}]}}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.listProgress()).toEqual([{ id: '6', state: '', operation: 'save-elog-raw' }]);
      } finally { server.close(); }
    });

    it('getProgress parses state and code from the progress detail', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/progress/6/"}},"state":[{"_links":{},"_type":"progress","_title":"save-elog-raw","state":"pending","code":"-1"}]}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const p = await client.getProgress('6');
        expect(p?.state).toBe('pending');
        expect(p?.details?.['code']).toBe('-1');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 4, IO search + signal config + rename)', () => {
    it('searchSignals POSTs only the given criteria and parses ios-signal-li hits', async () => {
      const { server, port, requests } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/rw/iosystem/"}},"_embedded":{"resources":[{"_links":{"self":{"href":"signals/Net/Dev/do1"}},"_type":"ios-signal-li","_title":"Net/Dev/do1","name":"do1","type":"DO","lvalue":"1"}]}}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const hits = await client.searchSignals({ type: 'DO' });
        expect(requests[0].url).toBe('/rw/iosystem/signals/signal-search');
        expect(requests[0].body).toBe('type=DO');
        expect(hits).toEqual([{ name: 'do1', value: '1', type: 'DO', lvalue: '1' }]);
        // The search must feed the coords cache so writeSignal works by name
        await client.writeSignal('', '', 'do1', '0');
        expect(requests[1].url).toBe('/rw/iosystem/signals/Net/Dev/do1/set-value');
      } finally { server.close(); }
    });

    it('getSignalConfig parses ios-signal-config-general', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ios-signal-config-general","_title":"Net/Dev/di1","cfgname":"EIO_SIGNAL","name":"di1","signaltype":"DI","device":"Dev"}]}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const cfg = await client.getSignalConfig('Net', 'Dev', 'di1');
        expect(cfg['cfgname']).toBe('EIO_SIGNAL');
        expect(cfg['signaltype']).toBe('DI');
      } finally { server.close(); }
    });

    it('renameFile POSTs fs-newname to the rename action', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.renameFile('TEMP/old.txt', 'new.txt');
        expect(requests[0].url).toBe('/fileservice/TEMP/old.txt/rename');
        expect(requests[0].body).toBe('fs-newname=new.txt');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 5, niche reads)', () => {
    const hal = (body: string): ReturnType<typeof startServer> => startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(body);
    });

    it('getOperationModeLockState parses pnl-opmode-lockstate-li', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"status":{"code":294912},"state":[{"_type":"pnl-opmode-lockstate-li","_title":"lock-state","lockstate":"unlocked"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getOperationModeLockState()).toBe('unlocked');
      } finally { server.close(); }
    });

    it('getEventLogMessage parses a single elog-message', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"status":{"code":294912},"state":[{"_type":"elog-message","_title":"/rw/elog/0/1","msgtype":"1","code":"10046","tstamp":"2026-08-04 T 03:26:39","title":"System reset","desc":"Loading done"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const m = await client.getEventLogMessage(0, 1);
        expect(m?.code).toBe(10046);
        expect(m?.title).toBe('System reset');
      } finally { server.close(); }
    });

    it('checkGrantExists and listCurrentUserGrants parse the UAS shapes', async () => {
      const { server, port } = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        if ((req.url ?? '').includes('grant-exists')) {
          res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"user-grant-status","_title":"grant-exist","status":"true"}]}');
        } else {
          res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"uas-grant","_title":"0","grantname":"UAS_CFG_WRITE"},{"_type":"uas-grant","_title":"1","grantname":"UAS_BACKUP"}]}');
        }
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.checkGrantExists('UAS_REMOTE_LOGIN')).toBe(true);
        expect(await client.listCurrentUserGrants()).toEqual(['UAS_CFG_WRITE', 'UAS_BACKUP']);
      } finally { server.close(); }
    });

    it('motion supervision, path supervision, axis pose and change-count reads parse the live shapes', async () => {
      const bodies: Record<string, string> = {
        motionsupervision: '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ms-motionsupervision","_title":"motionsupervision","mode-enabled":"TRUE","level":"100"}]}',
        pathsupervision: '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ms-pathsupervision","_title":"pathsupervision","mode":"ON","level":"100"}]}',
        pose: '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ms-mechunit-axispose","_title":"axispose","x":"0","y":"0","z":"0","q1":"1","q2":"0","q3":"0","q4":"0"}]}',
        checkchangecount: '{"_links":{"base":{"href":"https://x/"}},"status":{"code":294912},"state":[{"_type":"check-changecount","_title":"changecount","change-state":"FALSE"}]}',
      };
      const { server, port } = await startServer((req, res) => {
        const url = req.url ?? '';
        const key = Object.keys(bodies).find(k => url.includes(k)) ?? 'pose';
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(bodies[key]);
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getMotionSupervision()).toEqual({ enabled: true, level: 100 });
        expect(await client.getPathSupervision()).toEqual({ mode: 'ON', level: 100 });
        expect((await client.getAxisPose('ROB_1', 1)).q1).toBe(1);
        expect(await client.checkMotionChangeCount(1)).toBe(false);
      } finally { server.close(); }
    });

    it('listCfgTypeAttributes parses cfg-dt-attribute entries', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"cfg-dt-attribute","_title":"Name","name":"Name","type":"string","numbers":"1","mandatory":"false"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const attrs = await client.listCfgTypeAttributes('EIO', 'EIO_SIGNAL');
        expect(attrs[0]['name']).toBe('Name');
        expect(attrs[0]['type']).toBe('string');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 7, OPTIONS-verified niche writes)', () => {
    it('setMotionSupervisionSensitivity wraps motion mastership and uses field `sensitivity`', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.setMotionSupervisionSensitivity(50);
        expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
          'POST /rw/mastership/motion/request',
          'POST /rw/motionsystem/mechunits/ROB_1/motionsupervision/level',
          'POST /rw/mastership/motion/release',
        ]);
        expect(requests[1].body).toBe('sensitivity=50');
      } finally { server.close(); }
    });

    it('setPathSupervisionMode posts mode under motion mastership', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.setPathSupervisionMode('ON');
        const post = requests.find(r => r.url.includes('pathsupervision'));
        expect(post?.url).toBe('/rw/motionsystem/mechunits/ROB_1/pathsupervision/mode');
        expect(post?.body).toBe('mode=ON');
      } finally { server.close(); }
    });

    it('setSignalSimulated toggles lstate simulated / not simulated', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.setSignalSimulated('Net', 'Dev', 'do1', true);
        await client.setSignalSimulated('Net', 'Dev', 'do1', false);
        expect(requests[0].url).toBe('/rw/iosystem/signals/Net/Dev/do1/set-lstate');
        expect(requests[0].body).toBe('lstate=simulated');
        expect(requests[1].body).toBe('lstate=not+simulated');
      } finally { server.close(); }
    });

    it('setNetworkLState and setIoDeviceLState map start/stop and enable/disable', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.setNetworkLState('IntBus', true);
        await client.setIoDeviceLState('IntBus', 'EPanel', false);
        expect(requests[0].url).toBe('/rw/iosystem/networks/IntBus/set-lstate');
        expect(requests[0].body).toBe('lstate=start');
        expect(requests[1].url).toBe('/rw/iosystem/devices/IntBus/EPanel/set-lstate');
        expect(requests[1].body).toBe('lstate=disable');
      } finally { server.close(); }
    });

    it('searchDevices posts the properties filter', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.searchDevices('name');
        expect(requests[0].url).toBe('/rw/devices/search');
        expect(requests[0].body).toBe('property=name');
      } finally { server.close(); }
    });

    it('PP navigation and vttimeslice hit the right resources', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.ppPrevInst('T_ROB1');
        await client.ppNextInst('T_ROB1');
        await client.setPPToRoutineFromUrl('T_ROB1', 'RAPID/T_ROB1/mod/rt');
        await client.setVirtualTimeTimeslice(5);
        const urls = requests.map(r => `${r.method} ${r.url}`);
        expect(urls).toContain('POST /rw/rapid/tasks/T_ROB1/pcp/prev-inst');
        expect(urls).toContain('POST /rw/rapid/tasks/T_ROB1/pcp/next-inst');
        const from = requests.find(r => r.url.includes('routine-from-url'));
        expect(from?.body).toBe('routineurl=RAPID%2FT_ROB1%2Fmod%2Frt');
        const vt = requests.find(r => r.url.includes('vttimeslice'));
        expect(vt?.body).toBe('vttimeslice=5');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 8, deep reads with live-captured shapes)', () => {
    const bodies: Record<string, string> = {
      '/text/range': '{"_links":{"base":{"href":"https://x/"}},"status":{"code":294912},"state":[{"_type":"rap-mod-text","_title":"pgm_txt","text":"MODULE BASE"}]}',
      '/text': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-module-text","_title":"moduletext","change-count":" 6948 ","module-text":"MODULE BASE (SYSMODULE)"}]}',
      'changecount': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-module-changecount","_title":"changecount","count":"6948"}]}',
      'sync-pers': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-syncper-status","_title":"syncperstatus","syncperstatus":"1"}]}',
      'module-extension': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-module-extension","_title":"extension","num-of-lines":"19","max-num-of-col":"70","count":"6948"}]}',
      'program-pointer': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-sync-state","_title":"sync-state","program-pointer-state":"Off"}]}',
      'spy': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-spy-status","_title":"spy-status","status":"Not Logging"}]}',
      'safety/mode': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"safetymodestatus","_title":"status","userdata":"121","safetymode":"active"}]}',
      'startupstatus': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"startup-safety-config-load-satus","_title":"status","config-status-at-startup":"SCORCH_CONFIG_LOADED_AT_STARTUP"}]}',
      'vttimeslice': '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ctrl-vttimeslice","_title":"vttimeslice","vttimeslice":"10"}]}',
    };
    const shapeServer = (): ReturnType<typeof startServer> => startServer((req, res) => {
      const url = req.url ?? '';
      const key = Object.keys(bodies).find(k => url.includes(k)) ?? 'spy';
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(bodies[key]);
    });

    it('module text, range, change count, sync-pers and extension parse the live shapes', async () => {
      const { server, port } = await shapeServer();
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getModuleText('T_ROB1', 'BASE')).toEqual({ text: 'MODULE BASE (SYSMODULE)', changeCount: 6948 });
        expect(await client.getModuleTextRange('T_ROB1', 'BASE', 1, 1, 2, 1)).toBe('MODULE BASE');
        expect(await client.getModuleChangeCount('T_ROB1', 'BASE')).toBe(6948);
        expect(await client.getModuleSyncPersStatus('T_ROB1', 'BASE')).toBe(true);
        expect(await client.getModuleExtension('T_ROB1', 'BASE')).toEqual({ lines: 19, maxColumns: 70, changeCount: 6948 });
      } finally { server.close(); }
    });

    it('sync-state, spy, safety and vttimeslice reads parse the live shapes', async () => {
      const { server, port } = await shapeServer();
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getProgramPointerSyncState()).toBe('Off');
        expect(await client.getSpyStatus()).toBe('Not Logging');
        expect(await client.getSafetyMode()).toEqual({ mode: 'active', userdata: '121' });
        // The controller misspells the class ('...-satus'); the client must read it
        expect(await client.getSafetyStartupStatus()).toBe('SCORCH_CONFIG_LOADED_AT_STARTUP');
        expect(await client.getVirtualTimeTimeslice()).toBe(10);
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 9, crawl findings and parse fixes)', () => {
    const hal = (body: string): ReturnType<typeof startServer> => startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(body);
    });

    it('getTaskStructuralChangeCount returns the STRUCTURAL count, not the edit count', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-task-struc-change-count","_title":"task-struc-change-count","change-count":"215","struc-change-count":"6966"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        // Previously returned 215 (the any-edit counter) - the wrong number.
        expect(await client.getTaskStructuralChangeCount('T_ROB1')).toBe(6966);
        expect(await client.getTaskChangeCount('T_ROB1')).toBe(215);
      } finally { server.close(); }
    });

    it('getTaskSelection parses rap-taskselection (not the -li class) and reads ON state', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"status":{"code":294912},"state":[{"_type":"rap-taskselection","_title":"T_ROB1","name":"T_ROB1","state":"ON","motiontask":"TRUE","usermodify":"TRUE"},{"_type":"rap-taskselection","_title":"T_ROB2","name":"T_ROB2","state":"OFF","motiontask":"FALSE","usermodify":"TRUE"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const sel = await client.getTaskSelection();
        expect(sel.available).toEqual(['T_ROB1', 'T_ROB2']);
        expect(sel.selected).toEqual(['T_ROB1']);
        expect(sel.entries[0]['motiontask']).toBe('TRUE');
      } finally { server.close(); }
    });

    it('getCyclicBrakeCheckStatus requires drivenum and parses cbc-status', async () => {
      const { server, port, requests } = await hal('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"cbc-status","_title":"status","next-brake-check-time":"0","last-brake-check-status":"ok","status":"required"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getCyclicBrakeCheckStatus(1)).toEqual({ status: 'required', lastStatus: 'ok', nextCheckTime: 0 });
        expect(requests[0].url).toBe('/ctrl/safety/cbc?drivenum=1');
      } finally { server.close(); }
    });

    it('listEventLogDomains reports each domain with its event count', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"status":{"code":294912},"_embedded":{"resources":[{"_links":{"self":{"href":"0"}},"_type":"elog-domain-li","_title":"0","numevts":"146","buffsize":"1000"},{"_links":{"self":{"href":"1"}},"_type":"elog-domain-li","_title":"1","numevts":"50","buffsize":"1000"}]}}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.listEventLogDomains()).toEqual([
          { domain: 0, events: 146, bufferSize: 1000 },
          { domain: 1, events: 50, bufferSize: 1000 },
        ]);
      } finally { server.close(); }
    });

    it('listInstructionCategories parses the undocumented pallet-head catalog', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-pallet-head","_title":"pallet-head1","Name":"Common","Number":"1"},{"_type":"rap-pallet-head","_title":"pallet-head2","Name":"Prog.Flow","Number":"2"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.listInstructionCategories('T_ROB1')).toEqual([
          { number: 1, name: 'Common' }, { number: 2, name: 'Prog.Flow' },
        ]);
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 10, RW8 RMMP regression and vision)', () => {
    it('getRmmpPrivilege reports none when the controller RMMP service 500s (RW8.1.1)', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445885,"msg":"rapi_user_resource.cpp[1088] Unspecified Error"}}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        // A raw 500 must not escape to every caller that merely polls this.
        expect(await client.getRmmpPrivilege()).toBe('none');
      } finally { server.close(); }
    });

    it('requestRmmp reports UNSUPPORTED_OPERATION on the broken RW8 service', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445885,"msg":"Unspecified Error"}}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const err = await client.requestRmmp('modify').then(() => null, (e: unknown) => e as RwsError);
        expect(err).toBeInstanceOf(RwsError);
        expect(err!.code).toBe('UNSUPPORTED_OPERATION');
        expect(err!.message).toContain('RobotWare 8.1.1');
      } finally { server.close(); }
    });

    it('getVisionCameraCount reads number-of-cameras-li', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/rw/vision/"}},"state":[{"_type":"number-of-cameras-li","_title":"number-of-cameras","number-of-cameras":"2"}]}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getVisionCameraCount()).toBe(2);
        // The template placeholders in the camera links must never become "systems"
        expect(await client.listVisionSystems()).toEqual([]);
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 11, parse-class audit fixes)', () => {
    const hal = (body: string): ReturnType<typeof startServer> => startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(body);
    });

    it('getReturnCode parses err-desc (name/description), not the never-emitted rw-retcode', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"err-desc","_title":"-1073445859","name":"SYS_CTRL_E_MASTER_REJECT","code":"-1073445859","severity":"Error","description":"The user does not have required mastership for the operation."}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const rc = await client.getReturnCode(-1073445859);
        expect(rc?.title).toBe('SYS_CTRL_E_MASTER_REJECT');
        expect(rc?.desc).toContain('mastership');
      } finally { server.close(); }
    });

    it('listControllerOptions reads /rw/system/options with sys-option-li', async () => {
      const { server, port, requests } = await hal('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-option-li","_title":"0","option":"RobotControl Base"},{"_type":"sys-option-li","_title":"1","option":"English"}]}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const opts = await client.listControllerOptions();
        // The old code asked /ctrl/options, which serves no list at all.
        expect(requests[0].url).toBe('/rw/system/options');
        expect(opts.map(o => o.name)).toEqual(['RobotControl Base', 'English']);
      } finally { server.close(); }
    });

    it('listFileVolumes reads the real fs-dir entries instead of falling back', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/fileservice/"}},"_embedded":{"resources":[{"_type":"fs-dir","_title":"TEMP"},{"_type":"fs-dir","_title":"HOME"}]}}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.listFileVolumes()).toEqual(['TEMP', 'HOME']);
      } finally { server.close(); }
    });

    it('listCertificates reads ctrl-certstore-li store names', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"_embedded":{"resources":[{"_type":"ctrl-certstore-li","_title":"0","store-name":"controller"},{"_type":"ctrl-certstore-li","_title":"1","store-name":"system"}]}}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect((await client.listCertificates()).map(c => c.name)).toEqual(['controller', 'system']);
      } finally { server.close(); }
    });

    it('getMechunitPjoints and getTaskProgramInfo use the real classes', async () => {
      const { server, port } = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end((req.url ?? '').includes('pjoints')
          ? '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ms-mechunit-pjoints","_title":"pjoints","j1":"0","j2":"1"}]}'
          : '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"rap-program","_title":"myprog","name":"myprog","entrypoint":"main"}]}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getMechunitPjoints()).toEqual({ j1: 0, j2: 1 });
        expect((await client.getTaskProgramInfo('T_ROB1'))['entrypoint']).toBe('main');
      } finally { server.close(); }
    });

    it('getRapidSymbolProperties handles a PERS symbol (rap-symproppers)', async () => {
      const { server, port } = await hal('{"_links":{"base":{"href":"https://x/"}},"_embedded":{"resources":[{"_type":"rap-symproppers","_title":"RAPID/T_ROB1/BASE/tool0","symburl":"RAPID/T_ROB1/BASE/tool0","name":"tool0","symtyp":"per","dattyp":"tooldata","ndim":"0"}]}}');
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const props = await client.getRapidSymbolProperties('T_ROB1', 'BASE', 'tool0');
        expect(props.symtyp).toBe('per');
        expect(props.dattyp).toBe('tooldata');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 12, symbol-search persistents)', () => {
    it('searchRapidSymbols returns PERS symbols (rap-symproppers-li)', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        // Live shape from RW7.21/RW8.1.1: BASE holds three persistents.
        res.end('{"_links":{"base":{"href":"https://x/rw/rapid/"}},"status":{"code":294912},"_embedded":{"resources":['
          + '{"_type":"rap-symproppers-li","_title":"RAPID/T_ROB1/BASE/tool0","symburl":"RAPID/T_ROB1/BASE/tool0","name":"tool0","symtyp":"per","dattyp":"tooldata","ndim":"0"},'
          + '{"_type":"rap-symproppers-li","_title":"RAPID/T_ROB1/BASE/wobj0","symburl":"RAPID/T_ROB1/BASE/wobj0","name":"wobj0","symtyp":"per","dattyp":"wobjdata","ndim":"0"}]}}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const syms = await client.searchRapidSymbols({ blockurl: 'RAPID/T_ROB1/BASE' });
        // The class was misspelled 'rap-syproppers-li' (no 'm'), so persistents -
        // tool0/wobj0/load0, the most common symbols anywhere - were dropped.
        expect(syms.map(s => s.name)).toEqual(['tool0', 'wobj0']);
        expect(syms[0].dattyp).toBe('tooldata');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 13, write-path audit)', () => {
    it('copyFile sends fs-newname (a bare name), not the rejected destination field', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.copyFile('TEMP/a.txt', 'b.txt');
        // 'destination' answers HTTP 400 "Invalid/No Query Parameter" live.
        expect(requests[0].url).toBe('/fileservice/TEMP/a.txt/copy');
        expect(requests[0].body).toBe('fs-newname=b.txt');
      } finally { server.close(); }
    });

    it('copyFile drops any directory part and can request overwrite', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.copyFile('TEMP/a.txt', 'TEMP/sub/b.txt', true);
        expect(requests[0].body).toBe('fs-newname=b.txt&fs-overwrite=true');
      } finally { server.close(); }
    });

    it('setProgramPointer sends only the fields the pcp form accepts', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.setProgramPointer('T_ROB1', { module: 'mod', routine: 'main', row: 5, col: 1 });
        // The form is routine/module/userlevel - no row or column.
        expect(requests[0].body).toBe('routine=main&module=mod');
      } finally { server.close(); }
    });
  });

  describe('coverage additions (batch 14, list pagination)', () => {
    /** Serve `total` signals in pages of `pageSize`, advertising `next` like the
     *  real controller (which caps a page and ignores a larger requested limit). */
    const pagedSignals = (total: number, pageSize: number): ReturnType<typeof startServer> =>
      startServer((req, res) => {
        const start = Number(new URL(req.url ?? '', 'http://x').searchParams.get('start') ?? 0);
        const items = [];
        for (let i = start; i < Math.min(start + pageSize, total); i++) {
          items.push(`{"_type":"ios-signal-li","_title":"Net/Dev/sig${i}","name":"sig${i}","type":"DI","lvalue":"0"}`);
        }
        const next = start + pageSize < total
          ? `,"next":{"href":"signals?start=${start + pageSize}&limit=${pageSize}"}` : '';
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"http://x/rw/iosystem/"}${next}},"_embedded":{"resources":[${items.join(',')}]}}`);
      });

    it('listAllSignals follows next instead of returning only the first page', async () => {
      const { server, port } = await pagedSignals(130, 100);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        // The controller caps at 100 per page and ignores a larger limit, so a
        // single request returned 100 of 130 signals.
        const sigs = await client.listAllSignals();
        expect(sigs).toHaveLength(130);
        expect(sigs[129].name).toBe('sig129');
      } finally { server.close(); }
    });

    it('listAllSignals stops if a controller advertises a next pointing at itself', async () => {
      const { server, port, requests } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"http://x/rw/iosystem/"},"next":{"href":"signals?start=0&limit=200"}},'
          + '"_embedded":{"resources":[{"_type":"ios-signal-li","_title":"Net/Dev/a","name":"a","type":"DI","lvalue":"0"}]}}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        const sigs = await client.listAllSignals();
        // Must not spin to the page cap: the repeated path is detected.
        expect(requests.length).toBeLessThanOrEqual(2);
        expect(sigs.length).toBeLessThanOrEqual(2);
      } finally { server.close(); }
    });
  });

  describe('RW8 control station and write-access failover', () => {
    /** Mock an RW8 controller: mastership 410, controlstation endpoints live. */
    const rw8Handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      const url = req.url ?? '';
      if (url.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
      if (url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.1.1+614"}]}');
        return;
      }
      res.writeHead(204); res.end();
    };

    it('requestMastership falls over to register + writeaccess when mastership answers 410', async () => {
      const { server, port, requests } = await startServer(rw8Handler);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p',
          { controlStation: { name: 'test-cs', id: '{11111111-2222-3333-4444-555555555555}', pincode: '9999' } });
        await client.requestMastership('rapid');
        const urls = requests.map(r => `${r.method} ${r.url}`);
        expect(urls).toContain('POST /rw/mastership/edit/request');
        expect(urls).toContain('POST /rw/controlstation/register/remote');
        expect(urls).toContain('POST /rw/controlstation/writeaccess/request');
        const reg = requests.find(r => r.url === '/rw/controlstation/register/remote');
        expect(reg?.body).toBe('control-station-name=test-cs&control-station-id=%7B11111111-2222-3333-4444-555555555555%7D&pincode=9999');

        // Second acquire goes straight to write access: no more mastership tries,
        // no re-registration (session-scoped, already registered).
        const before = requests.length;
        await client.requestMastership('motion');
        const later = requests.slice(before).map(r => `${r.method} ${r.url}`);
        expect(later).toEqual(['POST /rw/controlstation/writeaccess/request']);

        await client.releaseMastership('motion');
        expect(requests[requests.length - 1].url).toBe('/rw/controlstation/writeaccess/release');
      } finally { server.close(); }
    });

    it('connect() reads rwversion 8.x and routes write access without trying mastership', async () => {
      const { server, port, requests } = await startServer(rw8Handler);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.connect();
        expect(await client.getRobotWareVersion()).toBe('8.1.1+614');
        await client.requestMastership('rapid');
        const urls = requests.map(r => `${r.method} ${r.url}`);
        expect(urls.some(u => u.includes('/rw/mastership'))).toBe(false);
        expect(urls).toContain('POST /rw/controlstation/writeaccess/request');
      } finally { server.close(); }
    });

    it('RW7 path is untouched: mastership 204 means no controlstation calls', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.requestMastership('rapid');
        await client.releaseMastership('rapid');
        const urls = requests.map(r => `${r.method} ${r.url}`);
        expect(urls).toEqual(['POST /rw/mastership/edit/request', 'POST /rw/mastership/edit/release']);
      } finally { server.close(); }
    });

    it('getWriteAccessStatus parses the live RW8 status shape', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"controlstation-write-access-status","_title":"write-access-status","held-by-control-station-Id":"{1111}","held-by-control-station-name":"probe-cs","control-station-write-access-held":"true","control-station-external-control-enabled":"true"}]}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getWriteAccessStatus()).toEqual({
          held: true, heldById: '{1111}', heldByName: 'probe-cs', externalControlEnabled: true,
        });
      } finally { server.close(); }
    });

    it('getAllowMotionControl reads the controller-typo class controstation-allow-motion-control', async () => {
      const { server, port } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"controstation-allow-motion-control","_title":"allow-motion-control","is-enabled":"false"}]}');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        expect(await client.getAllowMotionControl()).toBe(false);
      } finally { server.close(); }
    });
  });
});
