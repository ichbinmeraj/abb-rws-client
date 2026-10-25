import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessManager, accessOf, type AccessDriver, type AccessEvent, type AccessLock } from '../src/access/AccessManager.js';
import { MastershipWatchdog, WATCHDOG_BUSY_CODES, isWatchdogBusy, type HeartBeatConfig } from '../src/access/MastershipWatchdog.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type MastershipDomain } from '../src/types.js';

/**
 * A watchdog reset the controller answers as busy is not a lost hold.
 *
 * Recorded 2026-09-30 on RW 7.21.4+417 (functional suite, 09-motion): while a
 * RAPID start of the same session was in progress (the start POST took
 * 8.6 s, and was accepted), `POST /rw/mastership/watchdog` answered 403 with
 * code -1073445799, "Orchestration already active" (icode -802). The client
 * took that as a refused reset, recorded edit mastership as lost and released
 * it in the middle of the start. A busy answer now keeps the hold and the
 * reset is retried with a bounded backoff; only another refusal, real
 * silence past the Timeout, or busy answers past BUSY_LIMIT_MS end it.
 */

/** The recorded answer body (XHTML, as RW 7.21.4 sent it for this 403). */
const BUSY_BODY = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:5466/"/></head>'
  + '<body><div class="status"><span class="code">-1073445799</span>'
  + '<span class="msg">rws_resource_mastership.cpp[254] Orchestration already active code:-1073445799 icode:-802</span></div></body></html>';

const BUSY_CODE = -1073445799;

/** The busy answer as the transport types it (checked end to end further down). */
const busyError = (): RwsError => new RwsError(
  'Controller refused to reset the mastership watchdog. Controller: HTTP 403 from POST /rw/mastership/watchdog, code -1073445799 (0xC0048459): Orchestration already active code:-1073445799 icode:-802.',
  'UNKNOWN', 403, undefined, BUSY_CODE, 'Orchestration already active code:-1073445799 icode:-802');

function rw7Driver(wire: string[]): AccessDriver {
  return {
    label: 'TEST',
    locks: (): readonly AccessLock[] => ['edit', 'motion'],
    lockOf: (d: MastershipDomain): AccessLock => (d === 'motion' ? 'motion' : 'edit'),
    domainOf: (l: AccessLock): MastershipDomain => (l === 'motion' ? 'motion' : 'rapid'),
    request: async (l: AccessLock) => { wire.push(`request ${l}`); },
    release: async (l: AccessLock) => { wire.push(`release ${l}`); },
  };
}

function setup(kick: () => Promise<void>, config: HeartBeatConfig = { select: false, timeoutMs: 2000 }) {
  const wire: string[] = [];
  const events: AccessEvent[] = [];
  const m = new AccessManager(rw7Driver(wire));
  m.on(e => events.push(e as AccessEvent));
  const kicks: number[] = [];
  const wd = new MastershipWatchdog(m, {
    label: 'TEST',
    applies: () => true,
    kick: async () => { kicks.push(Date.now()); wire.push('kick'); await kick(); },
    readHeartBeat: async () => config,
  });
  return { m, wd, wire, events, kicks, t0: Date.now() };
}

const logs = { warn: [] as string[], info: [] as string[] };
const quiet = { info() {}, warn() {}, error() {}, show() {} };

describe('MastershipWatchdog: a reset answered busy (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logs.warn = [];
    logs.info = [];
    setLogger({ info(s) { logs.info.push(s); }, warn(s) { logs.warn.push(s); }, error() {}, show() {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    setLogger(quiet);
  });

  it('recognises the recorded code, and nothing else, as busy', () => {
    expect(WATCHDOG_BUSY_CODES.has(BUSY_CODE)).toBe(true);
    expect(isWatchdogBusy(busyError())).toBe(true);
    expect(isWatchdogBusy(new RwsError('not held', 'MASTERSHIP_REQUIRED', 403, undefined, -1073445859))).toBe(false);
    expect(isWatchdogBusy(new RwsError('forbidden', 'GRANT_DENIED', 403))).toBe(false);
    expect(isWatchdogBusy(new Error(String(BUSY_CODE)))).toBe(false);
  });

  it('one busy answer: the hold stays counted, nothing is released, and the reset is retried after 200 ms', async () => {
    let n = 0;
    const { m, wd, wire, events, kicks, t0 } = setup(async () => { n++; if (n === 1) { throw busyError(); } });
    const h = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    expect(kicks.map(t => t - t0)).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(200);
    expect(kicks.map(t => t - t0)).toEqual([1000, 1200]);
    // Back on the regular cadence from the accepted retry.
    await vi.advanceTimersByTimeAsync(1000);
    expect(kicks.map(t => t - t0)).toEqual([1000, 1200, 2200]);

    expect(m.count('edit')).toBe(1);
    expect(events.filter(e => e.type !== 'acquired')).toEqual([]);
    expect(logs.warn).toEqual([]);
    expect(wd.state()).toMatchObject({ running: true, lastKick: { ok: true } });
    expect(wire.filter(w => w === 'release edit')).toEqual([]);

    await m.release(h);
    expect(wire.filter(w => w === 'release edit')).toHaveLength(1);
  });

  it('busy for 8.6 s, as long as the recorded start: kept, at risk once, retried with a bounded backoff, never lost', async () => {
    let busyUntil = 0;
    const { m, events, kicks, wire, t0 } = setup(async () => { if (Date.now() < busyUntil) { throw busyError(); } });
    busyUntil = t0 + 1000 + 8600;
    const h = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000 + 8600 + 1000);

    // Backoff 200, 400, 800, then the 1000 ms interval, never longer.
    const gaps = kicks.slice(1).map((t, i) => t - kicks[i]);
    expect(gaps.slice(0, 4)).toEqual([200, 400, 800, 1000]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1000);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(200);

    expect(events.some(e => e.type === 'lost')).toBe(false);
    const risks = events.filter(e => e.type === 'atRisk');
    expect(risks).toHaveLength(1);
    expect((risks[0] as { detail: string }).detail).toMatch(/answers them as busy/);
    expect((risks[0] as { detail: string }).detail).not.toMatch(/it is taken as lost/);
    expect(logs.info.some(i => /accepted on time again/.test(i))).toBe(true);
    expect(m.count('edit')).toBe(1);
    expect(wire.filter(w => w.startsWith('release'))).toEqual([]);
    await m.release(h);
  });

  it('the operation holding edit is not interrupted: its next step still runs under the same hold', async () => {
    let busy = true;
    const { m, wire } = setup(async () => { if (busy) { throw busyError(); } });
    const steps: string[] = [];
    await m.withAccess(['rapid'], async () => {
      steps.push('start');
      await vi.advanceTimersByTimeAsync(3500);       // the start keeps the controller busy
      busy = false;
      await vi.advanceTimersByTimeAsync(1000);
      await m.withAccess(['rapid'], async () => { steps.push('next step'); });
    });
    expect(steps).toEqual(['start', 'next step']);
    expect(wire.filter(w => w === 'request edit')).toHaveLength(1);
    expect(wire.filter(w => w === 'release edit')).toHaveLength(1);
    expect(wire.at(-1)).toBe('release edit');
  });

  it('busy answers for longer than BUSY_LIMIT_MS are a lost hold, released once', async () => {
    const { m, events, wire } = setup(async () => { throw busyError(); });
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000 + MastershipWatchdog.BUSY_LIMIT_MS - 1000);
    expect(events.some(e => e.type === 'lost')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    const lost = events.filter(e => e.type === 'lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ lock: 'edit', reason: 'watchdog' });
    expect((lost[0] as { detail: string }).detail).toMatch(/answered every watchdog reset as busy for \d+ ms, longer than the 120000 ms/);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.count('edit')).toBe(0);
    expect(wire.filter(w => w === 'release edit')).toHaveLength(1);
  });

  it('a refusal with a real loss code still ends the hold at once', async () => {
    const notHeld = new RwsError('not held', 'MASTERSHIP_REQUIRED', 403, undefined, -1073445859);
    const { m, events, wire } = setup(async () => { throw notHeld; });
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(e => e.type === 'lost')).toHaveLength(1);
    expect(m.count('edit')).toBe(0);
    expect(wire).toContain('release edit');
  });

  it('busy, then no answer at all: silence past the Timeout counts from the last busy answer and ends the hold', async () => {
    let n = 0;
    const { m, events } = setup(async () => {
      n++;
      if (n === 1) { throw busyError(); }
      throw new RwsError('RWS2 timeout: /rw/mastership/watchdog', 'NETWORK_ERROR');
    });
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);          // busy at 1000
    await vi.advanceTimersByTimeAsync(1200);          // retries at 1200 and 2200 do not get through
    expect(events.some(e => e.type === 'lost')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);          // 3200: 2200 ms since the busy answer
    await vi.advanceTimersByTimeAsync(0);
    const lost = events.find(e => e.type === 'lost');
    expect(lost).toMatchObject({ lock: 'edit', reason: 'watchdog' });
    expect((lost as { detail: string }).detail).toMatch(/has not answered a watchdog reset for 2200 ms since it last answered one as busy/);
    expect(m.count('edit')).toBe(0);
  });
});

// ─── End to end: the recorded 403 body through the RWS 2.0 transport ────────

const HEARTBEAT_PATH = '/rw/cfg/SYS/MASTER_BOOL/instances/HeartBeat';

function heartBeatBody(select: string, timeout: string): string {
  return '{ "_links" : { "base": { "href": "x" } }, "_embedded" : { "resources" : [ { "_type":"cfg-dt-instance-li", "_title":"HeartBeat", '
    + `"attrib": [ { "_type":"cfg-ia-t", "_title":"Select", "value":"${select}" }, { "_type":"cfg-ia-t", "_title":"Timeout", "value":"${timeout}" } ] } ] }}`;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('RWS 2.0 client: the recorded busy answer keeps edit mastership', () => {
  afterEach(() => { setLogger(quiet); });

  it('RobotWare 7.21.4: a reset answered 403 -1073445799 is retried and the hold is kept; no release is sent', async () => {
    let busyAnswers = 3;
    const wire: string[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        wire.push(`${req.method} ${req.url}`);
        if (req.url === '/rw/system') {
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
          res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"7.21.4+417"}]}');
          return;
        }
        if (req.url === HEARTBEAT_PATH) {
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
          res.end(heartBeatBody('FALSE', '400'));   // interval 200 ms
          return;
        }
        if (req.method === 'POST' && req.url === '/rw/mastership/watchdog' && busyAnswers > 0) {
          busyAnswers--;
          res.writeHead(403, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
          res.end(BUSY_BODY);
          return;
        }
        res.writeHead(204); res.end();
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const events: AccessEvent[] = [];
      accessOf(c)!.on(e => events.push(e as AccessEvent));
      await c.requestMastership('rapid');
      await sleep(1500);

      const resets = wire.filter(l => l === 'POST /rw/mastership/watchdog').length;
      expect(resets).toBeGreaterThan(3);                    // the three busy answers were retried, then accepted
      expect(events.some(e => e.type === 'lost')).toBe(false);
      expect(wire).not.toContain('POST /rw/mastership/edit/release');
      expect(accessOf(c)!.count('edit')).toBe(1);
      expect(accessOf(c)!.snapshot()).toMatchObject({ watchdog: { running: true, lastKick: { ok: true } } });

      await c.releaseMastership('rapid');
      expect(wire.filter(l => l === 'POST /rw/mastership/edit/release')).toHaveLength(1);
      await c.disconnect();
    } finally { server.close(); }
  });
});
