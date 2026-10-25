import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * RobotWare 8's motion-control allowance through its lifecycle, against a
 * stand-in controller: nothing is read before the session registers and one
 * read follows each registration; a set reads null while it is on the wire;
 * the withdrawal is the first request of every disconnect, registering first
 * when needed and with a short deadline; a withdrawal that did not go
 * through is sent again at the next registration of the same station and
 * after a re-issued session; the optional withdrawals on a mode change and a
 * FlexPendant take-back; MultiRobotManager.disconnectAll and removeRobot; no
 * RWS 2.0 cookie in the session file. Nothing here allows motion control on
 * the client's own: every POST true is the test's own call.
 */

// A temporary home directory: the session file must never be the real one here.
const home = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'abb-rws-home-'));
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

const { RobotManager } = await import('../src/RobotManager.js');
const { MultiRobotManager } = await import('../src/MultiRobotManager.js');
const { RWS2Adapter } = await import('../src/RWS2Adapter.js');
const { RWS1Adapter } = await import('../src/RWS1Adapter.js');
const { RwsClient2 } = await import('../src/RwsClient2.js');
const { Rws2Core } = await import('../src/rws2/core.js');
const { accessOf } = await import('../src/access/AccessManager.js');
const { motionControlOf, MOTION_CONTROL_WITHDRAWAL_TRIGGERS } = await import('../src/access/motionControl.js');
const { setLogger } = await import('../src/Logger.js');
type AccessEvent = import('../src/access/AccessManager.js').AccessEvent;
type AccessObservation = import('../src/access/AccessManager.js').AccessObservation;
type RobotManagerT = InstanceType<typeof RobotManager>;
type RwsClient2T = InstanceType<typeof RwsClient2>;

const SESSION_FILE = path.join(home, '.abb-rws-session');
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

// ─── The stand-in controller ────────────────────────────────────────────────

interface Hit { method: string; url: string; body: string; session: string; at: number }
interface Rw8State {
  session: number;
  registered: Set<string>;
  allowed: boolean;
  /** The next request to this URL is answered on a new session. */
  reissueOn: string | null;
}
interface Rw8Opts {
  /** ms before the answer. */
  delay?: (h: Hit) => number | undefined;
  /** Never answered. */
  hang?: (h: Hit) => boolean;
  /** Taken this many ms after it arrives (after later requests), and never answered. */
  late?: (h: Hit) => number | undefined;
  /** A canned answer instead of the stand-in's own. */
  answer?: (h: Hit, s: Rw8State) => { status: number; body?: string } | undefined;
}

const hal = (type: string, fields: Record<string, string>): string =>
  JSON.stringify({ _links: { base: { href: 'https://x/' } }, state: [{ _type: type, _title: 'x', ...fields }] });
const refusalBody = (code: number, msg: string): string =>
  JSON.stringify({ _links: { base: { href: 'https://x/' } }, status: { code, msg: `${msg} code:${code}` } });
const SYSTEM = '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.2.1+1023"}]}';
const MC = '/rw/controlstation/allowmotioncontrol';

async function rw8(opts: Rw8Opts = {}): Promise<{ port: number; hits: Hit[]; state: Rw8State; close: () => void }> {
  const hits: Hit[] = [];
  const state: Rw8State = { session: 1, registered: new Set(), allowed: false, reissueOn: null };
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (state.reissueOn !== null && url === state.reissueOn) { state.session++; state.reissueOn = null; }
      const session = `S${state.session}`;
      const h: Hit = { method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8'), session, at: Date.now() };
      hits.push(h);
      // A hung request is never processed and never answered.
      if (opts.hang?.(h)) { return; }
      // The controller acts on a request as it arrives; only the answer may be late.
      const act = (): { status: number; body?: string } => {
        const canned = opts.answer?.(h, state);
        if (canned) { return canned; }
        if (url === '/rw/system') { return { status: 200, body: SYSTEM }; }
        if (url.startsWith('/rw/cfg/')) { return { status: 404 }; }
        if (url === '/rw/controlstation/register/remote') {
          if (state.registered.has(session)) { return { status: 403, body: refusalBody(-1073435874, 'A control station has already been registered') }; }
          state.registered.add(session);
          return { status: 204 };
        }
        if (url === MC) {
          if (h.method === 'GET') { return { status: 200, body: hal('controstation-allow-motion-control', { 'is-enabled': String(state.allowed) }) }; }
          if (!state.registered.has(session)) { return { status: 403, body: refusalBody(-1073435871, 'Session is not part of a Control Station') }; }
          state.allowed = /allow-motion-control=true/.test(h.body);
          return { status: 204 };
        }
        return { status: 204 };
      };
      const lateMs = opts.late?.(h);
      if (lateMs) { setTimeout(act, lateMs); return; }
      const out = act();
      const send = (): void => {
        if (res.destroyed) { return; }
        res.writeHead(out.status, { 'Content-Type': 'application/hal+json;v=2.0', 'Set-Cookie': [`-http-session-=${session}; path=/`] });
        res.end(out.body ?? '');
      };
      const ms = opts.delay?.(h);
      if (ms) { setTimeout(send, ms); } else { send(); }
    });
  });
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port, hits, state,
    close: () => { for (const s of sockets) { s.destroy(); } server.close(); },
  };
}

const line = (h: Hit): string => `${h.method} ${h.url}${h.url === MC && h.method === 'POST' ? ` ${h.body}` : ''}`;
const lines = (hits: Hit[], from = 0): string[] => hits.slice(from).map(line);
/** Without the configuration reads (the HeartBeat read after a re-issued session). */
const noCfg = (l: string[]): string[] => l.filter(x => !x.startsWith('GET /rw/cfg/'));
const POST_TRUE = `POST ${MC} allow-motion-control=true`;
const POST_FALSE = `POST ${MC} allow-motion-control=false`;
const GET_MC = `GET ${MC}`;
const REGISTER = 'POST /rw/controlstation/register/remote';
const WA_REQ = 'POST /rw/controlstation/writeaccess/request';
const WA_REL = 'POST /rw/controlstation/writeaccess/release';
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const settle = <T>(p: Promise<T>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

// ─── Logs and events ────────────────────────────────────────────────────────

let warns: string[] = [];
let infos: string[] = [];
beforeEach(() => {
  warns = []; infos = [];
  setLogger({ info(m: string) { infos.push(m); }, warn(m: string) { warns.push(m); }, error() {}, show() {} });
});
const DEADLINE = Rws2Core.WITHDRAW_DEADLINE_MS;
afterEach(() => {
  vi.restoreAllMocks();
  Rws2Core.WITHDRAW_DEADLINE_MS = DEADLINE;
  MOTION_CONTROL_WITHDRAWAL_TRIGGERS.modeChange = false;
  MOTION_CONTROL_WITHDRAWAL_TRIGGERS.takeBack = false;
});

const motionEvents = (seen: Array<AccessObservation | AccessEvent>): Array<{ allowed: boolean | null; cause: string }> =>
  seen.filter(e => e.type === 'motionControl').map(e => {
    const m = e as Extract<AccessObservation, { type: 'motionControl' }>;
    return { allowed: m.allowed, cause: m.cause };
  });

/** A connected RobotWare 8 client (RWS 2.0, no manager). */
async function client(port: number, o: { timeout?: number } = {}): Promise<{ c: RwsClient2T; seen: AccessObservation[] }> {
  const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { ...(o.timeout ? { timeout: o.timeout } : {}) });
  await c.connect();
  const seen: AccessObservation[] = [];
  accessOf(c)!.on(e => seen.push(e));
  return { c, seen };
}
const rw8Of = (c: RwsClient2T) => accessOf(c)!.snapshot().rw8!;

/** A RobotManager connected over RWS 2.0 to the stand-in: no probe, no subscription, no poll. */
function stubConnect(): void {
  vi.spyOn(RobotManager, 'probeSpecificPort').mockImplementation(async (_h: string, port: number) => ({ port, useHttps: false, authType: 'basic' as const }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);
  vi.spyOn(RWS2Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
}
async function manager(port: number): Promise<{ mgr: RobotManagerT; events: AccessEvent[] }> {
  stubConnect();
  const mgr = new RobotManager();
  const events: AccessEvent[] = [];
  mgr.onAccessEvent(e => events.push(e));
  await mgr.connect('127.0.0.1', 'u', 'p', port);
  return { mgr, events };
}
const adapterOf = (mgr: RobotManagerT): RwsClient2T => (mgr as unknown as { adapter: RwsClient2T }).adapter;

// ─── 1, 15. Nothing is read before the registration ─────────────────────────

describe('1, 15. no read before the registration; one read after it', () => {
  it('connect sends no GET of the allowance and the state reads null; the first write registers, then reads once', async () => {
    const s = await rw8();
    try {
      const { mgr } = await manager(s.port);
      expect(lines(s.hits)).not.toContain(GET_MC);
      expect(mgr.state.access.rw8).toMatchObject({ registered: false, allowMotionControl: null, allowMotionControlSince: null });
      const from = s.hits.length;
      await mgr.setSpeedRatio(50);
      expect(lines(s.hits, from)).toEqual([REGISTER, GET_MC, WA_REQ, 'POST /rw/panel/speedratio?action=setspeedratio', WA_REL]);
      expect(mgr.state.access.rw8).toMatchObject({ registered: true, allowMotionControl: false });
      await mgr.disconnect();
    } finally { s.close(); }
  });

  it('getAllowMotionControl on a session that is not registered yet: null, nothing sent', async () => {
    const s = await rw8();
    try {
      const { mgr } = await manager(s.port);
      const from = s.hits.length;
      await expect(mgr.getAllowMotionControl()).resolves.toBeNull();
      expect(s.hits.length).toBe(from);
      await mgr.setSpeedRatio(50);
      s.state.allowed = true;   // as another tool of the same station might have left it
      await expect(mgr.getAllowMotionControl()).resolves.toBe(true);
      expect(mgr.state.access.rw8?.allowMotionControl).toBe(true);
      // Read true without a set of this client: no "since".
      expect(mgr.state.access.rw8?.allowMotionControlSince).toBeNull();
      s.state.allowed = false;
      await mgr.disconnect();
    } finally { s.close(); }
  });
});

// ─── 2, 3. Set: null in flight, one notice; refused; no answer ──────────────

describe('2, 3. setAllowMotionControl and the state', () => {
  it('true reads null while the POST is in flight, true after, with one change notice and one event (cause set) and the time', async () => {
    const s = await rw8({ delay: h => (h.url === MC && h.method === 'POST' ? 300 : undefined) });
    try {
      const { mgr, events } = await manager(s.port);
      await mgr.setSpeedRatio(50);   // registered
      let changes = 0;
      mgr.onDidChange(() => { changes++; });
      const before = events.length;
      const p = mgr.setAllowMotionControl(true);
      expect(mgr.state.access.rw8?.allowMotionControl).toBeNull();
      await sleep(150);
      expect(mgr.state.access.rw8?.allowMotionControl).toBeNull();
      expect(rw8Of(adapterOf(mgr)).allowMotionControl).toBeNull();
      await p;
      expect(mgr.state.access.rw8?.allowMotionControl).toBe(true);
      expect(Date.parse(mgr.state.access.rw8!.allowMotionControlSince!)).toBeGreaterThan(Date.now() - 5000);
      expect(changes).toBe(1);
      expect(motionEvents(events.slice(before))).toEqual([{ allowed: true, cause: 'set' }]);
      await mgr.setAllowMotionControl(false);
      expect(mgr.state.access.rw8).toMatchObject({ allowMotionControl: false, allowMotionControlSince: null });
      await mgr.disconnect();
    } finally { s.close(); }
  });

  it('a refused set leaves the value as it was; a set with no answer reads null, then one read', async () => {
    let refuse = true;
    const s = await rw8({
      answer: h => (refuse && h.url === MC && h.method === 'POST' ? { status: 403, body: refusalBody(-1073435872, 'External control not enabled') } : undefined),
      hang: h => !refuse && h.url === MC && h.method === 'POST' && h.body.includes('true'),
    });
    try {
      const { c, seen } = await client(s.port, { timeout: 300 });
      await c.requestWriteAccess();          // registered; the read gives false
      await c.releaseWriteAccess();
      expect(rw8Of(c).allowMotionControl).toBe(false);
      const refused = await settle(c.setAllowMotionControl(true));
      expect(refused).toBe('MASTERSHIP_REQUIRED');
      expect(rw8Of(c).allowMotionControl).toBe(false);
      expect(motionEvents(seen).filter(e => e.cause === 'set')).toEqual([]);

      refuse = false;
      const from = s.hits.length;
      const unanswered = await settle(c.setAllowMotionControl(true));
      expect(unanswered).toBe('NETWORK_ERROR');
      // null, then one read: the controller's value (false here) is what it reads.
      expect(lines(s.hits, from)).toEqual([POST_TRUE, GET_MC]);
      expect(motionEvents(seen).slice(-2)).toEqual([{ allowed: null, cause: 'set' }, { allowed: false, cause: 'read' }]);
      expect(rw8Of(c).allowMotionControl).toBe(false);
      await c.disconnect();
    } finally { s.close(); }
  });

  it('a true with no answer that the controller takes after the read: still counted, and withdrawn first at disconnect', async () => {
    const s = await rw8({ late: h => (h.url === MC && h.method === 'POST' && h.body.includes('true') ? 500 : undefined) });
    try {
      const { c } = await client(s.port, { timeout: 200 });
      await c.requestWriteAccess();          // registered; the read gives false
      await c.releaseWriteAccess();
      const from = s.hits.length;
      expect(await settle(c.setAllowMotionControl(true))).toBe('NETWORK_ERROR');
      // The read went out before the controller took the POST: it reads false.
      expect(lines(s.hits, from)).toEqual([POST_TRUE, GET_MC]);
      expect(rw8Of(c).allowMotionControl).toBe(false);
      expect(s.state.allowed).toBe(false);
      expect(motionControlOf(c)!.maybeDeclared()).toBe(true);
      expect(warns.some(w => /allowing motion control .* got no answer .* may still take it/.test(w))).toBe(true);
      await sleep(500);                       // now the controller takes it
      expect(s.state.allowed).toBe(true);
      // A read of false would not end it either; this one reads true.
      const before = s.hits.length;
      await c.disconnect();
      expect(lines(s.hits, before)).toEqual([POST_FALSE, 'GET /logout']);
      expect(s.state.allowed).toBe(false);
      expect(motionControlOf(c)!.maybeDeclared()).toBe(false);
    } finally { s.close(); }
  });
});

// ─── 4, 5, 9, 13. The withdrawal is the first request of the teardown ───────

describe('4, 5, 9. the withdrawal is the first request of a disconnect', () => {
  it('with an allowance: POST false first, before the jog release, the subscription DELETE, the write-access release and /logout, even with a slow DELETE', async () => {
    const s = await rw8({ delay: h => (h.method === 'DELETE' ? 600 : undefined) });
    try {
      const { mgr, events } = await manager(s.port);
      await mgr.setAllowMotionControl(true);
      const adapter = adapterOf(mgr);
      const m = mgr as unknown as { jogHold: unknown; unsubscribeFn: (() => Promise<void>) | null };
      m.jogHold = await accessOf(adapter)!.acquire('motion');
      m.unsubscribeFn = async () => { await (adapter as unknown as { req(m: string, p: string): Promise<string> }).req('DELETE', '/subscription/1'); };
      const from = s.hits.length;
      await mgr.disconnect();
      expect(lines(s.hits, from)).toEqual([POST_FALSE, WA_REL, 'DELETE /subscription/1', 'GET /logout']);
      expect(motionEvents(events).at(-1)).toEqual({ allowed: false, cause: 'withdrawn-at-disconnect' });
      expect(infos.some(l => l.includes("motion control withdrawn at disconnect for control station 'abb-rws-client'"))).toBe(true);
      expect(s.state.allowed).toBe(false);
      expect(motionControlOf(adapter)!.maybeDeclared()).toBe(false);
    } finally { s.close(); }
  });

  it('without an allowance of this client: nothing is withdrawn', async () => {
    const s = await rw8();
    try {
      const { mgr } = await manager(s.port);
      await mgr.setAllowMotionControl(true);
      await mgr.setAllowMotionControl(false);
      const from = s.hits.length;
      await mgr.disconnect();
      expect(lines(s.hits, from)).toEqual(['GET /logout']);
    } finally { s.close(); }
  });

  it('the client alone (no manager) withdraws as the first request of its own teardown', async () => {
    const s = await rw8();
    try {
      const { c, seen } = await client(s.port);
      await c.setAllowMotionControl(true);
      await c.requestWriteAccess();
      const from = s.hits.length;
      await c.disconnect();
      expect(lines(s.hits, from)).toEqual([POST_FALSE, WA_REL, 'GET /logout']);
      expect(motionEvents(seen).at(-1)).toEqual({ allowed: false, cause: 'withdrawn-at-disconnect' });
    } finally { s.close(); }
  });

  it('a refused withdrawal in a manager disconnect is sent once: the client\'s own teardown does not try again', async () => {
    Rws2Core.WITHDRAW_DEADLINE_MS = 300;
    const s = await rw8({ answer: h => (h.url === MC && h.body.includes('false') ? { status: 403, body: refusalBody(-1073435872, 'x') } : undefined) });
    try {
      const { mgr } = await manager(s.port);
      await mgr.setAllowMotionControl(true);
      const from = s.hits.length;
      await mgr.disconnect();
      expect(lines(s.hits, from)).toEqual([POST_FALSE, 'GET /logout']);
    } finally { s.close(); }
  });

  it('a true sent after the manager\'s step found nothing is still withdrawn by the client\'s teardown', async () => {
    const s = await rw8();
    try {
      const { mgr } = await manager(s.port);
      const adapter = adapterOf(mgr);
      await expect(motionControlOf(adapter)!.withdraw('disconnect')).resolves.toBe('nothing');
      await adapter.setAllowMotionControl(true);
      const from = s.hits.length;
      await adapter.disconnect();
      expect(lines(s.hits, from)).toEqual([POST_FALSE, 'GET /logout']);
      expect(s.state.allowed).toBe(false);
      await mgr.disconnect();
    } finally { s.close(); }
  });

  it('a set true once the disconnect began is refused at the manager and not sent', async () => {
    const s = await rw8({ delay: h => (h.url === MC && h.method === 'POST' ? 200 : undefined) });
    try {
      const { mgr } = await manager(s.port);
      await mgr.setAllowMotionControl(true);
      const teardown = mgr.disconnect();
      const late = await settle(mgr.setAllowMotionControl(true));
      await teardown;
      expect(late).toBe('NOT_CONNECTED');
      expect(lines(s.hits).filter(l => l === POST_TRUE)).toHaveLength(1);
      expect(s.state.allowed).toBe(false);
    } finally { s.close(); }
  });

  it('a set true whose POST is in flight when the disconnect starts: the teardown withdraws it', async () => {
    const s = await rw8({ delay: h => (h.url === MC && h.method === 'POST' && h.body.includes('true') ? 400 : undefined) });
    try {
      const { mgr } = await manager(s.port);
      await mgr.setSpeedRatio(50);   // registered
      const set = settle(mgr.setAllowMotionControl(true));
      await sleep(150);
      await mgr.disconnect();
      await set;
      const l = lines(s.hits);
      expect(l.indexOf(POST_FALSE)).toBeGreaterThan(l.indexOf(POST_TRUE));
      expect(l.at(-1)).toBe('GET /logout');
      expect(s.state.allowed).toBe(false);
    } finally { s.close(); }
  });

  it('a set true whose POST is made while the manager\'s withdrawal is on the wire: the client\'s teardown withdraws again', async () => {
    // The registration is forgotten, so the set registers, withdraws (refused)
    // and reads; the disconnect starts while that read is on the wire, and the
    // set's POST true goes out while the manager's POST false waits for its answer.
    let armed = false;
    let refuseFalse = true;
    const s = await rw8({
      answer: h => (refuseFalse && h.url === MC && h.method === 'POST' && h.body.includes('false')
        ? { status: 403, body: refusalBody(-1073435872, 'External control not enabled') } : undefined),
      delay: h => {
        if (!armed || h.url !== MC) { return undefined; }
        if (h.method === 'GET') { return 200; }
        return h.body.includes('false') ? 400 : undefined;
      },
    });
    try {
      const { mgr } = await manager(s.port);
      await mgr.setAllowMotionControl(true);
      (adapterOf(mgr) as unknown as { controlStationRegistered: boolean }).controlStationRegistered = false;
      s.state.registered.clear();
      armed = true;
      const from = s.hits.length;
      const set = settle(mgr.setAllowMotionControl(true));
      while (!lines(s.hits, from).includes(GET_MC)) { await sleep(10); }
      refuseFalse = false;
      await mgr.disconnect();
      expect(await set).toBe('ok');
      const l = lines(s.hits, from);
      expect(l.slice(0, 3)).toEqual([REGISTER, POST_FALSE, GET_MC]);
      // The manager's POST false, then the set's POST true while it was on the
      // wire, then the client's own withdrawal, then /logout.
      expect(l.slice(3)).toEqual([POST_FALSE, POST_TRUE, POST_FALSE, 'GET /logout']);
      expect(s.state.allowed).toBe(false);
      expect(motionControlOf(adapterOf(mgr))!.maybeDeclared()).toBe(false);
    } finally { s.close(); }
  });

  it('a disconnect while a re-issued session\'s withdrawal waits for its registration: its POST false still goes out before /logout', async () => {
    let slowRegister = false;
    const s = await rw8({ delay: h => (slowRegister && h.url === '/rw/controlstation/register/remote' ? 300 : undefined) });
    try {
      const { c, seen } = await client(s.port);
      await c.setAllowMotionControl(true);
      s.state.reissueOn = '/rw/panel/ctrl-state';
      slowRegister = true;
      const from = s.hits.length;
      await c.getControllerState().catch(() => undefined);   // answered on a new session
      while (!lines(s.hits, from).includes(REGISTER)) { await sleep(10); }
      await c.disconnect();                                   // while that registration waits for its answer
      const l = noCfg(lines(s.hits, from));
      expect(l).toEqual(['GET /rw/panel/ctrl-state', REGISTER, POST_FALSE, 'GET /logout']);
      expect(s.state.allowed).toBe(false);
      expect(motionControlOf(c)!.maybeDeclared()).toBe(false);
      expect(motionEvents(seen).at(-1)).toEqual({ allowed: false, cause: 'withdrawn-after-reissue' });
      expect(warns.filter(w => /did not go through/.test(w))).toEqual([]);
    } finally { s.close(); }
  });
});

// ─── 6, 7, 8. Fail closed: register first, refused, timed out, reconnect ────

describe('6, 7, 8. the withdrawal fails closed', () => {
  it('on a session no longer registered: register, then POST false', async () => {
    const s = await rw8();
    try {
      const { c } = await client(s.port);
      await c.setAllowMotionControl(true);
      // The client knows the registration is gone (a re-issued session would say so).
      (c as unknown as { controlStationRegistered: boolean }).controlStationRegistered = false;
      s.state.registered.clear();
      const from = s.hits.length;
      await c.disconnect();
      expect(lines(s.hits, from)).toEqual([REGISTER, POST_FALSE, 'GET /logout']);
    } finally { s.close(); }
  });

  it('a -1073435871 answer: one register and one more POST', async () => {
    const s = await rw8();
    try {
      const { c } = await client(s.port);
      await c.setAllowMotionControl(true);
      s.state.registered.clear();          // the controller forgot it; the client did not see that
      const from = s.hits.length;
      await c.disconnect();
      expect(lines(s.hits, from)).toEqual([POST_FALSE, REGISTER, POST_FALSE, 'GET /logout']);
      expect(s.state.allowed).toBe(false);
    } finally { s.close(); }
  });

  for (const how of ['refused', 'timed out'] as const) {
    it(`a withdrawal ${how} at disconnect: a warning, withdraw-failed, /logout still sent, and it stays to withdraw; the reconnect withdraws at the registration`, async () => {
      Rws2Core.WITHDRAW_DEADLINE_MS = 300;
      let failing = true;
      const s = await rw8({
        answer: h => (failing && how === 'refused' && h.url === MC && h.body.includes('false')
          ? { status: 403, body: refusalBody(-1073435872, 'External control not enabled') } : undefined),
        delay: h => (failing && how === 'timed out' && h.url === MC && h.body.includes('false') ? 1500 : undefined),
      });
      try {
        const { c, seen } = await client(s.port);
        await c.setAllowMotionControl(true);
        const from = s.hits.length;
        await c.disconnect();
        expect(lines(s.hits, from)[0]).toBe(POST_FALSE);
        expect(lines(s.hits, from).at(-1)).toBe('GET /logout');
        expect(motionEvents(seen).at(-1)?.cause).toBe('withdraw-failed');
        expect(warns.some(w => /withdrawing motion control at disconnect .* did not go through/.test(w))).toBe(true);
        expect(motionControlOf(c)!.maybeDeclared()).toBe(true);
        if (how === 'refused') { expect(warns.some(w => w.includes('-1073435872'))).toBe(true); }

        // 8. The same client connects again: its first registration is followed
        // by POST false, then a read. Nothing is allowed again.
        failing = false;
        await sleep(how === 'timed out' ? 1300 : 0);   // let the late answer land first
        await c.connect();
        const again = s.hits.length;
        await c.requestWriteAccess();
        await c.releaseWriteAccess();
        expect(lines(s.hits, again)).toEqual([REGISTER, POST_FALSE, GET_MC, WA_REQ, WA_REL]);
        // The read after it finds the same value, so it adds no event.
        expect(motionEvents(seen).at(-1)).toEqual({ allowed: false, cause: 'withdrawn-at-registration' });
        expect(motionControlOf(c)!.maybeDeclared()).toBe(false);
        expect(lines(s.hits, again)).not.toContain(POST_TRUE);
        await c.disconnect();
      } finally { s.close(); }
    });
  }

  it('registered again as another station: a warning, no POST false and no read that ends it; registered as the first station again, it is withdrawn', async () => {
    Rws2Core.WITHDRAW_DEADLINE_MS = 300;
    // A stand-in that keeps one allowance per station id and starts a new session at /logout.
    const stationOf = new Map<string, string>();
    const allowedBy = new Map<string, boolean>();
    let refuseFalse = true;
    const s = await rw8({
      answer: (h, st) => {
        if (h.url === '/logout') { st.session++; return { status: 204 }; }
        if (h.url === '/rw/controlstation/register/remote') {
          if (stationOf.has(h.session)) { return { status: 403, body: refusalBody(-1073435874, 'A control station has already been registered') }; }
          stationOf.set(h.session, (new URLSearchParams(h.body).get('control-station-id') ?? '').toLowerCase());
          st.registered.add(h.session);
          return { status: 204 };
        }
        if (h.url === MC) {
          const id = stationOf.get(h.session);
          if (h.method === 'GET') { return { status: 200, body: hal('controstation-allow-motion-control', { 'is-enabled': String(id ? allowedBy.get(id) ?? false : false) }) }; }
          if (!id) { return { status: 403, body: refusalBody(-1073435871, 'Session is not part of a Control Station') }; }
          if (refuseFalse && h.body.includes('false')) { return { status: 403, body: refusalBody(-1073435872, 'External control not enabled') }; }
          allowedBy.set(id, h.body.includes('true'));
          return { status: 204 };
        }
        return undefined;
      },
    });
    try {
      const { c, seen } = await client(s.port);
      const first = c as unknown as { csName: string; csId: string; csPincode: string };
      const station = { name: first.csName, id: first.csId, key: first.csId.toLowerCase(), pincode: first.csPincode };
      await c.setAllowMotionControl(true);
      expect(allowedBy.get(station.key)).toBe(true);
      await c.disconnect();                     // its withdrawal is refused
      expect(motionControlOf(c)!.maybeDeclared()).toBe(true);

      // Another station in the next session: it cannot withdraw the first one's allowance.
      refuseFalse = false;
      await c.connect();
      warns = [];
      const other = '{11111111-1111-1111-1111-111111111111}';
      let from = s.hits.length;
      await c.registerControlStationRemote('other-tool', other, '1234');
      expect(lines(s.hits, from)).toEqual([REGISTER, GET_MC]);
      expect(motionControlOf(c)!.maybeDeclared()).toBe(true);
      expect(warns.some(w => w.includes(`control station '${station.name}' may still allow motion control`) && w.includes("'other-tool'"))).toBe(true);
      expect(warns.join(' ').toLowerCase()).not.toContain(station.key);
      expect(infos.some(l => /motion control withdrawn/.test(l))).toBe(false);
      // A read as the other station says nothing about the first one.
      await c.getAllowMotionControl();
      expect(motionControlOf(c)!.maybeDeclared()).toBe(true);
      from = s.hits.length;
      await c.disconnect();
      expect(lines(s.hits, from)).toEqual(['GET /logout']);
      expect(warns.some(w => /withdrawing motion control at disconnect .* did not go through: this client is now registered as another control station/.test(w))).toBe(true);
      expect(motionEvents(seen).at(-1)?.cause).toBe('withdraw-failed');
      expect(allowedBy.get(station.key)).toBe(true);

      // Registered as the first station again: the registration withdraws it.
      await c.connect();
      from = s.hits.length;
      await c.registerControlStationRemote(station.name, station.id, station.pincode);
      expect(lines(s.hits, from)).toEqual([REGISTER, POST_FALSE, GET_MC]);
      expect(allowedBy.get(station.key)).toBe(false);
      expect(motionControlOf(c)!.maybeDeclared()).toBe(false);
      await c.disconnect();
    } finally { s.close(); }
  });
});

// ─── 10. A re-issued session ────────────────────────────────────────────────

describe('10. a re-issued session', () => {
  it('with an allowance of this client: null (session-reissued), then register, POST false, read; nothing allowed again', async () => {
    const s = await rw8();
    try {
      const { c, seen } = await client(s.port);
      await c.setAllowMotionControl(true);
      s.state.reissueOn = '/rw/panel/ctrl-state';
      const from = s.hits.length;
      await c.getControllerState().catch(() => undefined);   // answered on a new session
      await sleep(1200);
      // (The HeartBeat configuration is read again after a re-issue as before; left out here.)
      expect(noCfg(lines(s.hits, from))).toEqual(['GET /rw/panel/ctrl-state', REGISTER, POST_FALSE, GET_MC]);
      const ev = motionEvents(seen);
      expect(ev.slice(-2)).toEqual([{ allowed: null, cause: 'session-reissued' }, { allowed: false, cause: 'withdrawn-after-reissue' }]);
      expect(rw8Of(c).allowMotionControl).toBe(false);
      expect(lines(s.hits, from)).not.toContain(POST_TRUE);
      await c.disconnect();
    } finally { s.close(); }
  });

  it('without one: null (session-reissued), nothing sent', async () => {
    const s = await rw8();
    try {
      const { c, seen } = await client(s.port);
      await c.requestWriteAccess();
      await c.releaseWriteAccess();
      s.state.reissueOn = '/rw/panel/ctrl-state';
      const from = s.hits.length;
      await c.getControllerState().catch(() => undefined);
      await sleep(600);
      expect(noCfg(lines(s.hits, from))).toEqual(['GET /rw/panel/ctrl-state']);
      expect(motionEvents(seen).at(-1)).toEqual({ allowed: null, cause: 'session-reissued' });
      expect(rw8Of(c).allowMotionControl).toBeNull();
      await c.disconnect();
    } finally { s.close(); }
  });
});

// ─── 11. Mode change and FlexPendant take-back ──────────────────────────────

describe('11. the withdrawals on a mode change and on a FlexPendant take-back', () => {
  it('held off by default: nothing is sent', async () => {
    const s = await rw8();
    try {
      const { c } = await client(s.port);
      await c.setAllowMotionControl(true);
      const from = s.hits.length;
      accessOf(c)!.noteModeChange('AUTO', 'MANR');
      accessOf(c)!.recordLoss(['writeaccess'], 'holder-changed', 'the FlexPendant took it', { by: 'FlexPendant' });
      await sleep(600);
      expect(lines(s.hits, from)).not.toContain(POST_FALSE);
      await c.disconnect();
    } finally { s.close(); }
  });

  it('turned on: one POST false on a mode change (withdrawn-on-mode-change), one on a take-back (withdrawn-on-take-back)', async () => {
    MOTION_CONTROL_WITHDRAWAL_TRIGGERS.modeChange = true;
    MOTION_CONTROL_WITHDRAWAL_TRIGGERS.takeBack = true;
    const s = await rw8();
    try {
      const { c, seen } = await client(s.port);
      await c.setAllowMotionControl(true);
      let from = s.hits.length;
      accessOf(c)!.noteModeChange('AUTO', 'MANR');
      await sleep(600);
      expect(lines(s.hits, from)).toEqual([POST_FALSE]);
      expect(motionEvents(seen).at(-1)).toEqual({ allowed: false, cause: 'withdrawn-on-mode-change' });

      await c.setAllowMotionControl(true);
      from = s.hits.length;
      accessOf(c)!.recordLoss(['writeaccess'], 'holder-changed', 'the FlexPendant took it', { by: 'FlexPendant' });
      await sleep(600);
      expect(lines(s.hits, from)).toEqual([POST_FALSE]);
      expect(motionEvents(seen).at(-1)).toEqual({ allowed: false, cause: 'withdrawn-on-take-back' });

      // Another station taking it is no take-back by the FlexPendant.
      await c.setAllowMotionControl(true);
      from = s.hits.length;
      accessOf(c)!.recordLoss(['writeaccess'], 'holder-changed', 'a PLC took it', { by: 'Line PLC' });
      await sleep(600);
      expect(lines(s.hits, from)).toEqual([]);
      await c.disconnect();
    } finally { s.close(); }
  });

  it('turned on: a write refused because the FlexPendant holds write access is a take-back', async () => {
    MOTION_CONTROL_WITHDRAWAL_TRIGGERS.takeBack = true;
    let pendant = false;
    const s = await rw8({
      answer: h => {
        if (!pendant) { return undefined; }
        if (h.url === '/rw/controlstation/writeaccess/request') { return { status: 403, body: refusalBody(-1073435870, 'Cannot take SPoC when it is taken') }; }
        if (h.url === '/rw/controlstation/writeaccess/status') {
          return { status: 200, body: hal('controlstation-write-access-status', {
            'control-station-write-access-held': 'true', 'held-by-control-station-Id': '{AAAAAAAA-0000-0000-0000-000000000000}',
            'held-by-control-station-name': 'FlexPendant', 'control-station-external-control-enabled': 'true',
          }) };
        }
        return undefined;
      },
    });
    try {
      const { c } = await client(s.port);
      await c.setAllowMotionControl(true);
      pendant = true;
      const e = await c.setSpeedRatio(50).then(() => null, (x: unknown) => x as { refusal?: { remedy?: { kind: string } } });
      expect(e?.refusal?.remedy?.kind).toBe('release-pendant-write-access');
      await sleep(600);
      expect(lines(s.hits)).toContain(POST_FALSE);
      expect(s.state.allowed).toBe(false);
      pendant = false;
      await c.disconnect();
    } finally { s.close(); }
  });
});

// ─── 12, 13. MultiRobotManager ──────────────────────────────────────────────

describe('12, 13. MultiRobotManager.disconnectAll and removeRobot', () => {
  it('disconnectAll: both withdrawals go out before either robot\'s slow teardown step ends', async () => {
    const a = await rw8({ delay: h => (h.method === 'DELETE' ? 800 : undefined) });
    const b = await rw8();
    try {
      stubConnect();
      const multi = new MultiRobotManager();
      multi.addRobot({ id: 'a', name: 'A', host: '127.0.0.1', port: a.port, username: 'u', password: 'p' });
      multi.addRobot({ id: 'b', name: 'B', host: '127.0.0.1', port: b.port, username: 'u', password: 'p' });
      await multi.connectRobot('a');
      await multi.connectRobot('b');
      for (const { manager: m } of multi.entries) { await m.setAllowMotionControl(true); }
      const ma = multi.entries.find(e => e.id === 'a')!.manager;
      const adapterA = adapterOf(ma);
      (ma as unknown as { unsubscribeFn: () => Promise<void> }).unsubscribeFn = async () => {
        await (adapterA as unknown as { req(m: string, p: string): Promise<string> }).req('DELETE', '/subscription/1');
      };
      await multi.disconnectAll();
      const withdrawalA = a.hits.find(h => line(h) === POST_FALSE)!;
      const withdrawalB = b.hits.find(h => line(h) === POST_FALSE)!;
      const deleteA = a.hits.find(h => h.method === 'DELETE')!;
      expect(withdrawalA.at).toBeLessThanOrEqual(deleteA.at);
      // B's withdrawal went out while A's DELETE was still unanswered.
      expect(withdrawalB.at).toBeLessThan(deleteA.at + 800);
      expect(lines(a.hits).at(-1)).toBe('GET /logout');
      expect(lines(b.hits).at(-1)).toBe('GET /logout');
      expect(a.state.allowed).toBe(false);
      expect(b.state.allowed).toBe(false);
      // The robots stay configured.
      expect(multi.entries.map(e => e.id)).toEqual(['a', 'b']);
    } finally { a.close(); b.close(); }
  });

  it('removeRobot leaves the lists at once and returns a promise that settles after the withdrawal and /logout', async () => {
    const s = await rw8();
    try {
      stubConnect();
      const multi = new MultiRobotManager();
      multi.addRobot({ id: 'a', name: 'A', host: '127.0.0.1', port: s.port, username: 'u', password: 'p' });
      await multi.connectRobot('a');
      await multi.entries[0].manager.setAllowMotionControl(true);
      const from = s.hits.length;
      const removed = multi.removeRobot('a');
      expect(multi.entries).toEqual([]);
      expect(removed).toBeInstanceOf(Promise);
      await removed;
      expect(lines(s.hits, from)).toEqual([POST_FALSE, 'GET /logout']);
      await expect(multi.removeRobot('nobody')).resolves.toBeUndefined();
      await expect(new MultiRobotManager().disconnectAll()).resolves.toBeUndefined();
    } finally { s.close(); }
  });

  it('the connect cycle\'s own teardown withdraws too; a new client after a failed withdrawal warns that the old station may still allow it', async () => {
    Rws2Core.WITHDRAW_DEADLINE_MS = 300;
    const a = await rw8({ answer: h => (h.url === MC && h.body.includes('false') ? { status: 403, body: refusalBody(-1073435872, 'x') } : undefined) });
    const b = await rw8();
    try {
      const { mgr } = await manager(a.port);
      await mgr.setAllowMotionControl(true);
      await mgr.connect('127.0.0.1', 'u', 'p', b.port);   // another controller: the first is torn down
      expect(lines(a.hits)).toContain(POST_FALSE);
      expect(warns.some(w => w.includes('may have left motion control allowed for its control station'))).toBe(true);
      await mgr.disconnect();
    } finally { a.close(); b.close(); }
  });
});

// ─── 14. The session file ───────────────────────────────────────────────────

describe('14. the session file', () => {
  it('an RWS 2.0 connect writes nothing to it; an RWS 1.0 connect still saves its cookie', async () => {
    fs.rmSync(SESSION_FILE, { force: true });
    const s = await rw8();
    try {
      const { mgr } = await manager(s.port);
      expect(fs.existsSync(SESSION_FILE)).toBe(false);
      await mgr.disconnect();

      // RWS 1.0: an adapter of another make (the manager treats it as RWS 1.0).
      const rws1 = new RobotManager();
      const fake = {
        connect: async () => {}, disconnect: async () => {}, getSessionCookie: () => '-http-session-=R1; ABBCX=1',
        subscribe: async () => { throw new Error('no ws'); },
      };
      (rws1 as unknown as { adapter: unknown; adapterConfig: unknown }).adapter = fake;
      (rws1 as unknown as { adapterConfig: unknown }).adapterConfig = { host: 'vc6', username: 'u', password: 'p', port: 80 };
      vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue({ port: 80, useHttps: false, authType: 'digest' });
      await rws1.connect('vc6', 'u', 'p', 80);
      const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as Record<string, string>;
      expect(Object.values(saved)).toEqual(['-http-session-=R1; ABBCX=1']);
      await rws1.disconnect();
    } finally { s.close(); fs.rmSync(SESSION_FILE, { force: true }); }
  });
});

// ─── 16. The FlexPendant connection reads ───────────────────────────────────

describe('16. getLocalStationStatus', () => {
  it('ABB\'s example answers parse; a 404 or a missing field gives null', async () => {
    let mode: 'abb' | 'missing' | '404' = 'abb';
    const s = await rw8({
      answer: h => {
        if (h.url === '/rw/controlstation/local/isconnected') {
          if (mode === '404') { return { status: 404 }; }
          return { status: 200, body: hal('controlstation-local-connected', mode === 'abb' ? { 'control-station-local-isconnected': 'true' } : { other: 'x' }) };
        }
        if (h.url === '/rw/controlstation/tpu/safety/protocol/status') {
          if (mode === '404') { return { status: 404 }; }
          return { status: 200, body: hal('controlstation-tpu-safety-protocol-status', mode === 'abb' ? { 'is-connected': 'false' } : {}) };
        }
        return undefined;
      },
    });
    try {
      const { mgr } = await manager(s.port);
      await expect(mgr.getLocalStationStatus()).resolves.toEqual({ flexPendantConnected: true, safetyProtocolConnected: false });
      mode = 'missing';
      await expect(mgr.getLocalStationStatus()).resolves.toEqual({ flexPendantConnected: null, safetyProtocolConnected: null });
      mode = '404';
      await expect(mgr.getLocalStationStatus()).resolves.toEqual({ flexPendantConnected: null, safetyProtocolConnected: null });
      // Reads only.
      expect(lines(s.hits).filter(l => l.startsWith('POST'))).toEqual([]);
      await mgr.disconnect();
    } finally { s.close(); }
  });
});

describe('15, 16. after disconnect() the two reads throw NOT_CONNECTED', () => {
  it('getAllowMotionControl and getLocalStationStatus: NOT_CONNECTED, nothing sent; a new connection reads again', async () => {
    const s = await rw8();
    try {
      const { mgr } = await manager(s.port);
      await mgr.setSpeedRatio(50);   // registered
      await expect(mgr.getAllowMotionControl()).resolves.toBe(false);
      await mgr.disconnect();
      const from = s.hits.length;
      await expect(mgr.getAllowMotionControl()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
      await expect(mgr.getLocalStationStatus()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
      await expect(mgr.getWriteAccessStatus()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
      expect(s.hits.length).toBe(from);
      await mgr.connect('127.0.0.1', 'u', 'p', s.port);
      await expect(mgr.getAllowMotionControl()).resolves.toBeNull();   // not registered yet
      await mgr.disconnect();
    } finally { s.close(); }
  });
});

describe('the package exports the types of the new read and event', () => {
  it('LocalStationStatus and MotionControlCause can be imported from the package entry', async () => {
    const ts = (await import('typescript')).default;
    const entry = path.resolve('src/index.ts');
    const program = ts.createProgram([entry], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, strict: true });
    const checker = program.getTypeChecker();
    const names = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry)!)!).map(s => s.getName());
    expect(names).toEqual(expect.arrayContaining(['LocalStationStatus', 'MotionControlCause', 'AccessEvent', 'WriteAccessStatus']));
  }, 60_000);
});

// ─── 17. RobotWare 6 and 7 ──────────────────────────────────────────────────

describe('17. RobotWare 6 and 7 have no control stations: refused, nothing sent', () => {
  it('getAllowMotionControl, getLocalStationStatus and setAllowMotionControl', async () => {
    const wire: string[] = [];
    const rw7 = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    (rw7 as unknown as Record<string, unknown>).writeAccessMode = 'mastership';
    (rw7 as unknown as Record<string, unknown>).req = async (m: string, p: string) => { wire.push(`${m} ${p}`); return ''; };
    const m7 = new RobotManager();
    (m7 as unknown as { adapter: unknown }).adapter = rw7;
    const m6 = new RobotManager();
    (m6 as unknown as { adapter: unknown }).adapter = new RWS1Adapter({} as never);
    for (const m of [m7, m6]) {
      await expect(m.getAllowMotionControl()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      await expect(m.getLocalStationStatus()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      await expect(m.setAllowMotionControl(true)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    }
    await expect(new RobotManager().getAllowMotionControl()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(new RobotManager().getLocalStationStatus()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(wire).toEqual([]);
  });
});

// ─── 18. The write-access release appeal registers first ───────────────────

describe('18. appealWriteAccessRelease registers the session first (ABB\'s prerequisite), takes no write access', () => {
  // ABB, RobotWare 8 Control Station Service Rev C, POST
  // /rw/controlstation/writeaccess/release/appeal: "Pre-requisites: Registered
  // as a Control station." The stand-in refuses an unregistered session with
  // 403 -1073435871, as RW 8.2.1 refused allowmotioncontrol (2026-10-13).
  const APPEAL = 'POST /rw/controlstation/writeaccess/release/appeal';
  const refuseUnregistered = (h: Hit, st: Rw8State): { status: number; body?: string } | undefined =>
    (h.url === '/rw/controlstation/writeaccess/release/appeal' && !st.registered.has(h.session)
      ? { status: 403, body: refusalBody(-1073435871, 'Session is not part of a Control Station') } : undefined);

  it('a session that has not registered: one registration, the read after it, then the appeal; no write access', async () => {
    const s = await rw8({ answer: refuseUnregistered });
    try {
      const { c } = await client(s.port);
      const from = s.hits.length;
      await c.appealWriteAccessRelease();
      expect(lines(s.hits, from)).toEqual([REGISTER, GET_MC, APPEAL]);
      expect(lines(s.hits, from)).not.toContain(WA_REQ);
      await c.disconnect();
    } finally { s.close(); }
  });

  it('through RobotManager the same', async () => {
    const s = await rw8({ answer: refuseUnregistered });
    try {
      const { mgr } = await manager(s.port);
      const from = s.hits.length;
      await mgr.appealWriteAccessRelease();
      expect(noCfg(lines(s.hits, from))).toEqual([REGISTER, GET_MC, APPEAL]);
      await mgr.disconnect();
    } finally { s.close(); }
  });

  it('a registration the controller dropped unseen: the -1073435871 registers once and appeals once more', async () => {
    const s = await rw8({ answer: refuseUnregistered });
    try {
      const { c } = await client(s.port);
      await c.appealWriteAccessRelease();
      s.state.registered.clear();          // the controller forgot it; the client did not see that
      const from = s.hits.length;
      await c.appealWriteAccessRelease();
      expect(lines(s.hits, from)).toEqual([APPEAL, REGISTER, GET_MC, APPEAL]);
      await c.disconnect();
    } finally { s.close(); }
  });

  it('a second -1073435871 is passed on, typed, after one retry', async () => {
    const s = await rw8({
      answer: h => (h.url === '/rw/controlstation/writeaccess/release/appeal'
        ? { status: 403, body: refusalBody(-1073435871, 'Session is not part of a Control Station') } : undefined),
    });
    try {
      const { c } = await client(s.port);
      const from = s.hits.length;
      await expect(c.appealWriteAccessRelease()).rejects.toMatchObject({ controllerCode: -1073435871 });
      expect(lines(s.hits, from).filter(l => l === APPEAL)).toHaveLength(2);
      await c.disconnect();
    } finally { s.close(); }
  });
});

// ─── 19. An allowance this client did not make, found at registration ───────
//
// RW 8.2.1 (2026-10-21): the allowance belongs to the control station, and a
// process killed after allowing left it standing; a new session registered
// with the same id read it true 7 min 42 s later. Owner decision 2026-10-22:
// such an allowance is withdrawn at the registration that finds it (fail
// closed); a person allows it again, the client never does.

describe('19. a leftover allowance is withdrawn at the registration that finds it', () => {
  const SPEED = 'POST /rw/panel/speedratio?action=setspeedratio';

  it('a station that reads false: nothing more is sent', async () => {
    const s = await rw8();
    try {
      const { mgr, events } = await manager(s.port);
      const from = s.hits.length;
      await mgr.setSpeedRatio(50);
      expect(lines(s.hits, from)).toEqual([REGISTER, GET_MC, WA_REQ, SPEED, WA_REL]);
      expect(motionEvents(events).map(e => e.cause)).not.toContain('withdrawn-leftover');
      expect(warns.filter(w => /earlier run/.test(w))).toEqual([]);
      await mgr.disconnect();
      expect(lines(s.hits, from)).not.toContain(POST_FALSE);
    } finally { s.close(); }
  });

  it('a station that reads true: withdrawn and read back before the write, one warning, the event, reads false', async () => {
    const s = await rw8();
    try {
      const { mgr, events } = await manager(s.port);
      s.state.allowed = true;   // left by an earlier run of this station
      const from = s.hits.length;
      await mgr.setSpeedRatio(50);
      expect(lines(s.hits, from)).toEqual([REGISTER, GET_MC, POST_FALSE, GET_MC, WA_REQ, SPEED, WA_REL]);
      expect(s.state.allowed).toBe(false);
      expect(mgr.state.access.rw8).toMatchObject({ allowMotionControl: false, allowMotionControlSince: null });
      expect(motionEvents(events)).toContainEqual({ allowed: false, cause: 'withdrawn-leftover' });
      // Never true in the state on the way.
      expect(motionEvents(events).some(e => e.allowed === true)).toBe(false);
      expect(warns.filter(w => /still allowed for control station .* from an earlier run .*withdrawn\. A person allows it again/.test(w))).toHaveLength(1);
      // Nothing is allowed again on the person's behalf, and the disconnect has nothing left to withdraw.
      const before = s.hits.length;
      await mgr.disconnect();
      expect(lines(s.hits, before)).not.toContain(POST_TRUE);
      expect(lines(s.hits, before)).not.toContain(POST_FALSE);
      expect(lines(s.hits, from)).not.toContain(POST_TRUE);
    } finally { s.close(); }
  });

  it('this client\'s own allowance in this run is kept: later writes and reads send no withdrawal', async () => {
    const s = await rw8();
    try {
      const { mgr } = await manager(s.port);
      await mgr.setSpeedRatio(50);   // registered, reads false
      await mgr.setAllowMotionControl(true);
      const from = s.hits.length;
      await mgr.setSpeedRatio(60);
      await expect(mgr.getAllowMotionControl()).resolves.toBe(true);
      // The same identity registered again in the same session: the controller keeps the first, nothing is withdrawn.
      await adapterOf(mgr).registerControlStationRemote();
      expect(lines(s.hits, from)).not.toContain(POST_FALSE);
      expect(mgr.state.access.rw8?.allowMotionControl).toBe(true);
      expect(s.state.allowed).toBe(true);
      await mgr.disconnect();   // withdraws its own, first
      expect(s.state.allowed).toBe(false);
    } finally { s.close(); }
  });

  it('a person allowing as the first write: the leftover is not withdrawn first, their confirmation counts', async () => {
    const s = await rw8();
    try {
      const { mgr } = await manager(s.port);
      s.state.allowed = true;
      const from = s.hits.length;
      await mgr.setAllowMotionControl(true);
      expect(lines(s.hits, from)).toEqual([REGISTER, GET_MC, POST_TRUE]);
      expect(mgr.state.access.rw8?.allowMotionControl).toBe(true);
      expect(warns.filter(w => /earlier run/.test(w))).toEqual([]);
      await mgr.disconnect();
      expect(s.state.allowed).toBe(false);
    } finally { s.close(); }
  });

  it('a refused withdrawal: not known (never true), a warning, and the disconnect withdraws again first', async () => {
    let refusals = 0;
    const s = await rw8({
      answer: h => (h.url === MC && h.method === 'POST' && /=false/.test(h.body) && refusals++ === 0
        ? { status: 403, body: refusalBody(-1073445867, 'The request was denied') } : undefined),
    });
    try {
      const { mgr, events } = await manager(s.port);
      s.state.allowed = true;
      const from = s.hits.length;
      await mgr.setSpeedRatio(50);
      expect(lines(s.hits, from)).toEqual([REGISTER, GET_MC, POST_FALSE, WA_REQ, SPEED, WA_REL]);
      expect(mgr.state.access.rw8?.allowMotionControl).toBeNull();
      expect(motionEvents(events)).toContainEqual({ allowed: null, cause: 'withdraw-failed' });
      expect(motionEvents(events).some(e => e.allowed === true)).toBe(false);
      expect(warns.some(w => /did not go through/.test(w))).toBe(true);
      const before = s.hits.length;
      await mgr.disconnect();
      expect(lines(s.hits, before)[0]).toBe(POST_FALSE);
      expect(s.state.allowed).toBe(false);
    } finally { s.close(); }
  });

  it('a withdrawal with no answer: not known after the deadline, the write goes on, nothing allowed', async () => {
    Rws2Core.WITHDRAW_DEADLINE_MS = 300;
    let hung = 0;
    const s = await rw8({ hang: h => h.url === MC && h.method === 'POST' && /=false/.test(h.body) && hung++ === 0 });
    try {
      const { mgr, events } = await manager(s.port);
      s.state.allowed = true;
      await mgr.setSpeedRatio(50);
      expect(mgr.state.access.rw8?.allowMotionControl).toBeNull();
      expect(motionEvents(events)).toContainEqual({ allowed: null, cause: 'withdraw-failed' });
      expect(lines(s.hits)).not.toContain(POST_TRUE);
      await mgr.disconnect();
    } finally { s.close(); }
  });

  it('a withdrawal taken that still reads true: not known, a warning, withdrawn again at the disconnect', async () => {
    let taken = 0;
    const s = await rw8({
      // The first POST false is answered 204 and left untaken.
      answer: h => (h.url === MC && h.method === 'POST' && /=false/.test(h.body) && taken++ === 0 ? { status: 204 } : undefined),
    });
    try {
      const { mgr, events } = await manager(s.port);
      s.state.allowed = true;
      const from = s.hits.length;
      await mgr.setSpeedRatio(50);
      expect(lines(s.hits, from).slice(0, 4)).toEqual([REGISTER, GET_MC, POST_FALSE, GET_MC]);
      expect(mgr.state.access.rw8?.allowMotionControl).toBeNull();
      expect(motionEvents(events).some(e => e.allowed === true)).toBe(false);
      expect(warns.some(w => /still reads allowed after the withdrawal/.test(w))).toBe(true);
      const before = s.hits.length;
      await mgr.disconnect();
      expect(lines(s.hits, before)[0]).toBe(POST_FALSE);
      expect(s.state.allowed).toBe(false);
    } finally { s.close(); }
  });
});
