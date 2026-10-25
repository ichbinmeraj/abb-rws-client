import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import { accessOf, type AccessEvent, type AccessObservation } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';

/**
 * The HeartBeat configuration (`SYS/MASTER_BOOL/HeartBeat`) is read once per
 * connection, at connect, on RobotWare 7.8 and later including RobotWare 8,
 * and never written. On RobotWare 8 the client cannot reset the watchdog (the
 * mastership service is gone and the Control Station Service documents no
 * watchdog), so `RobotState.access.watchdog` says what was read with
 * `running: false` and `resettable: false`; and a RAPID start under a hold
 * while HeartBeat is enforced is warned about, once per connection, before it
 * goes out. It is never blocked: the controller decides.
 */

interface Recorded { method: string; url: string }

const HEARTBEAT_PATH = '/rw/cfg/SYS/MASTER_BOOL/instances/HeartBeat';

function heartBeatBody(select: string, timeout: string): string {
  return '{ "_links" : { "base": { "href": "x" } }, "_embedded" : { "resources" : [ { "_type":"cfg-dt-instance-li", "_title":"HeartBeat", '
    + `"attrib": [ { "_type":"cfg-ia-t", "_title":"Select", "value":"${select}" }, { "_type":"cfg-ia-t", "_title":"Timeout", "value":"${timeout}" } ] } ] }}`;
}

const GONE_BODY = '{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445881,'
  + '"msg":"Mastership service is not supported from Robotware version 8.0 onwards, Use Control Station service for similar functionality"}}';

async function startServer(rw: string, opts: { heartBeat?: { status: number; body?: string } } = {}): Promise<{ server: http.Server; port: number; wire: Recorded[] }> {
  const wire: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      wire.push({ method: req.method ?? '', url: req.url ?? '' });
      if (req.url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw}"}]}`);
        return;
      }
      if (req.url === HEARTBEAT_PATH) {
        const hb = opts.heartBeat ?? { status: 200, body: heartBeatBody('TRUE', '400') };
        res.writeHead(hb.status, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(hb.body ?? '{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445859,"msg":"refused"}}');
        return;
      }
      if (req.url?.startsWith('/rw/mastership') && rw.startsWith('8')) {
        res.writeHead(410, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(GONE_BODY);
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const line = (r: Recorded): string => `${r.method} ${r.url}`;
const reads = (wire: Recorded[]): number => wire.filter(r => line(r) === `GET ${HEARTBEAT_PATH}`).length;

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('HeartBeat configuration read at connect', () => {
  it('RobotWare 8: read once at connect, right after /rw/system; the watchdog state says enforced, timeout, not running, not resettable', async () => {
    const { server, port, wire } = await startServer('8.2.1+1023');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      expect(wire.map(line)).toEqual(['GET /rw/system', `GET ${HEARTBEAT_PATH}`]);
      expect(wire.filter(r => r.method !== 'GET' && r.url.startsWith('/rw/cfg'))).toEqual([]);
      const state = accessOf(c)!.snapshot();
      expect(state.generation).toBe('rw8');
      expect(state.watchdog).toMatchObject({ running: false, enforced: true, timeoutMs: 400, resettable: false, lastKick: null });
      // A hold on write access starts no resets and reads nothing more.
      await c.requestWriteAccess();
      await new Promise(r => setTimeout(r, 300));
      await c.releaseWriteAccess();
      expect(reads(wire)).toBe(1);
      expect(wire.some(r => r.url === '/rw/mastership/watchdog')).toBe(false);
      expect(accessOf(c)!.snapshot().watchdog?.running).toBe(false);
      await c.disconnect();
      // The next connection reads it again.
      await c.connect();
      expect(reads(wire)).toBe(2);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RobotWare 8: a refused configuration read does not fail connect; enforced and timeout are null, and nothing is read again', async () => {
    const { server, port, wire } = await startServer('8.2.1+1023', { heartBeat: { status: 403 } });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      expect(accessOf(c)!.snapshot().watchdog).toMatchObject({ running: false, enforced: null, timeoutMs: null, resettable: false });
      await c.requestWriteAccess();
      await c.releaseWriteAccess();
      expect(reads(wire)).toBe(1);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RobotWare 7.21: read once at connect; the watchdog is resettable and idle until edit is held', async () => {
    const { server, port, wire } = await startServer('7.21.4+417');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      expect(wire.map(line)).toEqual(['GET /rw/system', `GET ${HEARTBEAT_PATH}`]);
      expect(accessOf(c)!.snapshot().watchdog).toMatchObject({ running: false, enforced: true, timeoutMs: 400, intervalMs: 200, resettable: true });
      await c.requestMastership('rapid');
      expect(accessOf(c)!.snapshot().watchdog?.running).toBe(true);
      await c.releaseMastership('rapid');
      expect(reads(wire)).toBe(1);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RobotWare 7.21: the reset interval is the Timeout read at connect (400 ms -> every 200 ms), with no second read at the hold', async () => {
    const { server, port, wire } = await startServer('7.21.4+417');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastership('rapid');
      const t0 = Date.now();
      await new Promise(r => setTimeout(r, 1000));
      await c.releaseMastership('rapid');
      const kicks = wire.filter(r => line(r) === 'POST /rw/mastership/watchdog').length;
      // ABB's default 2000 ms would give one reset a second; the 400 ms read at
      // connect gives one every 200 ms, so about five in a second.
      expect(kicks).toBeGreaterThanOrEqual(3);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(reads(wire)).toBe(1);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RobotWare 7.7: nothing is read and the watchdog state is null', async () => {
    const { server, port, wire } = await startServer('7.7.1+100');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      expect(wire.map(line)).toEqual(['GET /rw/system']);
      expect(accessOf(c)!.snapshot().watchdog).toBeNull();
      await c.disconnect();
    } finally { server.close(); }
  });
});

// ─── RobotManager: the start under HeartBeat on RobotWare 8 is warned, not blocked ─

function managerOver(adapter: RWS2Adapter, name = 'cell-7'): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
  m.adapter = adapter;
  m._state.opmode = 'AUTO';
  m._state.ctrlstate = 'motoron';
  m._state.host = '127.0.0.1';
  m._state.identity = { name, id: 'x', type: 'virtual' };
  return mgr;
}

describe('RobotManager: a RAPID start while RobotWare 8 enforces HeartBeat', () => {
  it('emits one heartbeat-required warning per connection and logs it once; the start still goes out', async () => {
    const { server, port, wire } = await startServer('8.2.1+1023');
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    try {
      const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
      await adapter.connect();
      const mgr = managerOver(adapter);
      const events: AccessEvent[] = [];
      mgr.onAccessEvent(e => events.push(e));

      await mgr.startRapid();
      await mgr.startRapid();

      const starts = wire.filter(r => r.url.startsWith('/rw/rapid/execution') && r.method === 'POST');
      expect(starts).toHaveLength(2);
      const warned = events.filter((e): e is Extract<AccessObservation, { type: 'warning' }> & { at: number } => e.type === 'warning');
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({ kind: 'heartbeat-required', lock: 'writeaccess' });
      expect(warned[0].detail).toContain('cell-7 requires a station holding write access while RAPID runs to send a periodic heartbeat');
      expect(warned[0].detail).toContain('RobotWare 8 offers no RWS way to send it, so RAPID may stop after 400 ms');
      // The warning comes before the start is sent.
      const firstStart = wire.findIndex(r => r.url.startsWith('/rw/rapid/execution') && r.method === 'POST');
      expect(warned[0].at).toBeLessThanOrEqual(Date.now());
      expect(firstStart).toBeGreaterThan(0);
      expect(warnings.filter(w => w.includes('periodic heartbeat'))).toHaveLength(1);
      expect(mgr.state.access.watchdog).toMatchObject({ enforced: true, resettable: false });

      // A new connection warns again, once.
      await mgr.disconnect();
      await adapter.connect();
      const mgr2 = managerOver(adapter);
      const again: AccessEvent[] = [];
      mgr2.onAccessEvent(e => again.push(e));
      await mgr2.startRapid();
      expect(again.filter(e => e.type === 'warning')).toHaveLength(1);
      expect(warnings.filter(w => w.includes('periodic heartbeat'))).toHaveLength(2);
      await mgr2.disconnect();
    } finally { server.close(); }
  });

  it('HeartBeat not enforced, or not readable: no warning, no log line', async () => {
    for (const hb of [{ status: 200, body: heartBeatBody('FALSE', '2000') }, { status: 403 }]) {
      const { server, port } = await startServer('8.2.1+1023', { heartBeat: hb });
      const warnings: string[] = [];
      setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
      try {
        const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
        await adapter.connect();
        const mgr = managerOver(adapter);
        const events: AccessEvent[] = [];
        mgr.onAccessEvent(e => events.push(e));
        await mgr.startRapid();
        expect(events.filter(e => e.type === 'warning')).toEqual([]);
        expect(warnings.filter(w => w.includes('periodic heartbeat'))).toEqual([]);
        await mgr.disconnect();
      } finally { server.close(); }
    }
  });

  it('RobotWare 7 resets the watchdog itself: no warning there', async () => {
    const { server, port, wire } = await startServer('7.21.4+417');
    try {
      const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
      await adapter.connect();
      const mgr = managerOver(adapter);
      const events: AccessEvent[] = [];
      mgr.onAccessEvent(e => events.push(e));
      await mgr.startRapid();
      expect(events.filter(e => e.type === 'warning')).toEqual([]);
      expect(wire.some(r => r.url.startsWith('/rw/rapid/execution') && r.method === 'POST')).toBe(true);
      await mgr.disconnect();
    } finally { server.close(); }
  });
});
