import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { AccessManager, type AccessDriver, type AccessObservation, type AccessLock } from '../src/access/AccessManager.js';
import { MastershipWatchdog, heartBeatFromAttributes, type HeartBeatConfig } from '../src/access/MastershipWatchdog.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type MastershipDomain } from '../src/types.js';

/**
 * The RobotWare 7 edit-mastership watchdog on its own, over a RobotWare 7
 * access manager and a recording driver, with fake timers:
 * - it resets at min(Timeout / 2, 1000 ms) while edit is held, and only then,
 * - it stops when the last hold ends and when the session ends,
 * - it reads the HeartBeat configuration once per connection and never writes it,
 * - a refused reset, or no accepted reset within the Timeout, is a lost hold:
 *   the count ends, the lock is released once to be sure, and the resets stop,
 * - a reset that did not get through while the Timeout has not run out is a
 *   hold at risk, and the hold stays counted.
 */

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

interface Options {
  applies?: boolean;
  config?: HeartBeatConfig | Error;
  kick?: () => Promise<void>;
}

function setup(opts: Options = {}) {
  const wire: string[] = [];
  const events: AccessObservation[] = [];
  const m = new AccessManager(rw7Driver(wire));
  m.on(e => events.push(e));
  const ctl = { applies: opts.applies ?? true };
  const kicks: number[] = [];
  const wd = new MastershipWatchdog(m, {
    label: 'TEST',
    applies: () => ctl.applies,
    kick: async () => {
      kicks.push(Date.now());
      wire.push('kick');
      if (opts.kick) { await opts.kick(); }
    },
    readHeartBeat: async () => {
      wire.push('read heartbeat');
      if (opts.config instanceof Error) { throw opts.config; }
      return opts.config ?? { select: null, timeoutMs: null };
    },
  });
  return { m, wd, wire, events, kicks, ctl, t0: Date.now() };
}

const logs = { warn: [] as string[], info: [] as string[] };

beforeEach(() => {
  vi.useFakeTimers();
  logs.warn = [];
  logs.info = [];
  setLogger({ info(m) { logs.info.push(m); }, warn(m) { logs.warn.push(m); }, error() {}, show() {} });
});

afterEach(() => {
  vi.useRealTimers();
  setLogger({ info() {}, warn() {}, error() {}, show() {} });
});

const refusal = (): RwsError => new RwsError('RWS2 POST /rw/mastership/watchdog: forbidden', 'GRANT_DENIED', 403);

describe('MastershipWatchdog: when it resets', () => {
  it('resets every 1000 ms while edit is held (ABB default Timeout 2000 ms), and stops when the hold ends', async () => {
    const { m, wd, wire, kicks, t0 } = setup();
    const h = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(999);
    expect(kicks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(kicks.map(t => t - t0)).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(kicks.map(t => t - t0)).toEqual([1000, 2000, 3000, 4000]);
    expect(wd.state()).toMatchObject({ running: true, intervalMs: 1000, lastKick: { ok: true } });

    await m.release(h);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kicks).toHaveLength(4);
    expect(wd.state().running).toBe(false);
    expect(wire).toEqual(['request edit', 'read heartbeat', 'kick', 'kick', 'kick', 'kick', 'release edit']);
  });

  it('a hold shorter than one interval sends no reset', async () => {
    const { m, kicks } = setup();
    await m.withAccess(['rapid'], async () => { await vi.advanceTimersByTimeAsync(900); });
    await vi.advanceTimersByTimeAsync(5000);
    expect(kicks).toEqual([]);
  });

  it('keeps resetting while any hold on edit is left: rapid and cfg are the same lock', async () => {
    const { m, kicks } = setup();
    const outer = await m.acquire('cfg');
    const inner = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    await m.release(inner);
    await vi.advanceTimersByTimeAsync(2000);
    expect(kicks).toHaveLength(3);
    await m.release(outer);
    await vi.advanceTimersByTimeAsync(3000);
    expect(kicks).toHaveLength(3);
  });

  it('a motion hold alone sends nothing: the watchdog is edit mastership\'s', async () => {
    const { m, wire, kicks } = setup();
    const h = await m.acquire('motion');
    await vi.advanceTimersByTimeAsync(5000);
    await m.release(h);
    expect(kicks).toEqual([]);
    expect(wire).toEqual(['request motion', 'release motion']);
  });

  it('an all-domains hold starts it too', async () => {
    const { m, kicks } = setup();
    await m.requestPublicAll();
    await vi.advanceTimersByTimeAsync(2000);
    expect(kicks).toHaveLength(2);
    await m.releasePublicAll();
    await vi.advanceTimersByTimeAsync(3000);
    expect(kicks).toHaveLength(2);
  });

  it('sends nothing where the watchdog does not apply (before RobotWare 7.8, RobotWare 8, not connected)', async () => {
    const { m, wire, kicks } = setup({ applies: false });
    const h = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(5000);
    await m.release(h);
    expect(kicks).toEqual([]);
    expect(wire).toEqual(['request edit', 'release edit']);
  });

  it('stops at once when the session ends, even with a hold still counted', async () => {
    const { m, wd, kicks } = setup();
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    wd.sessionEnded();
    await vi.advanceTimersByTimeAsync(5000);
    expect(kicks).toHaveLength(1);
    expect(m.count('edit')).toBe(1);
  });

  it('stops when the client closes between two resets', async () => {
    const { m, kicks, ctl } = setup();
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    ctl.applies = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(kicks).toHaveLength(1);
  });

  it('stops when a re-issued session ends the holds', async () => {
    const { m, kicks } = setup();
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    m.sessionEnded('session-reissued');
    await vi.advanceTimersByTimeAsync(5000);
    expect(kicks).toHaveLength(1);
  });

  it('never has two resets on the wire at once', async () => {
    let slow: (() => void) | null = null;
    // A long Timeout, so the late answer below is still within it (a reset
    // accepted after the Timeout is a lost hold, tested further down).
    const { m, kicks } = setup({ config: { select: true, timeoutMs: 10_000 }, kick: () => new Promise<void>(r => { slow = r; }) });
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(3500);
    expect(kicks).toHaveLength(1);
    slow!();
    await vi.advanceTimersByTimeAsync(500);
    expect(kicks).toHaveLength(2);
  });
});

describe('MastershipWatchdog: the HeartBeat configuration (read only)', () => {
  it('reads it once per connection, one moment after the hold is taken, never on the wire of the request itself', async () => {
    const { m, wd, wire } = setup({ config: { select: true, timeoutMs: 2000 } });
    const a = await m.acquire('rapid');
    expect(wire).toEqual(['request edit']);
    await vi.advanceTimersByTimeAsync(0);
    expect(wire).toEqual(['request edit', 'read heartbeat']);
    await m.release(a);
    const b = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    await m.release(b);
    expect(wire.filter(w => w === 'read heartbeat')).toHaveLength(1);
    expect(wd.state()).toMatchObject({ enforced: true, timeoutMs: 2000 });

    wd.sessionEnded();
    const c = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(0);
    await m.release(c);
    expect(wire.filter(w => w === 'read heartbeat')).toHaveLength(2);
  });

  it('a Timeout of 600 ms makes it reset every 300 ms', async () => {
    const { m, wd, kicks, t0 } = setup({ config: { select: true, timeoutMs: 600 } });
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    expect(wd.state().intervalMs).toBe(300);
    expect(kicks.map(t => t - t0)).toEqual([300, 600, 900]);
  });

  it('a long Timeout still resets every second; a tiny one no faster than every 100 ms', async () => {
    const long = setup({ config: { select: true, timeoutMs: 10_000 } });
    await long.m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(3000);
    expect(long.kicks).toHaveLength(3);
    long.wd.sessionEnded();

    // 150 ms: half of it (75) is below the 100 ms floor. (A Timeout below
    // 100 ms can never be met at that floor, so every reset would be late,
    // which is a lost hold.)
    const tiny = setup({ config: { select: true, timeoutMs: 150 } });
    await tiny.m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    expect(tiny.wd.state().intervalMs).toBe(100);
    expect(tiny.kicks).toHaveLength(10);
    tiny.wd.sessionEnded();
  });

  it('an unreadable configuration means ABB\'s default, and is not read again on the same connection', async () => {
    const { m, wd, wire, kicks } = setup({ config: new RwsError('RWS2 GET: 400 Invalid type id', 'RESOURCE_NOT_FOUND', 400) });
    const a = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(2000);
    expect(kicks).toHaveLength(2);
    expect(wd.state()).toMatchObject({ enforced: null, timeoutMs: null, intervalMs: 1000 });
    await m.release(a);
    const b = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(0);
    await m.release(b);
    expect(wire.filter(w => w === 'read heartbeat')).toHaveLength(1);
  });

  it('parses Select and Timeout from the instance attributes, without regard to case', () => {
    expect(heartBeatFromAttributes({ Select: 'TRUE', Timeout: '1500' })).toEqual({ select: true, timeoutMs: 1500 });
    expect(heartBeatFromAttributes({ select: 'false', timeout: '2000' })).toEqual({ select: false, timeoutMs: 2000 });
    expect(heartBeatFromAttributes({})).toEqual({ select: null, timeoutMs: null });
    expect(heartBeatFromAttributes({ Select: 'maybe', Timeout: 'soon' })).toEqual({ select: null, timeoutMs: null });
    expect(heartBeatFromAttributes({ Select: '', Timeout: '0' })).toEqual({ select: null, timeoutMs: null });
  });
});

const networkError = (): RwsError => new RwsError('RWS2 timeout: /rw/mastership/watchdog', 'NETWORK_ERROR');

describe('MastershipWatchdog: a refused or lapsed reset is a lost hold', () => {
  it('a refused reset: the count ends, edit is released once to be sure, and the resets stop', async () => {
    const { m, wd, wire, events } = setup({
      config: { select: true, timeoutMs: 2000 },
      kick: async () => { throw refusal(); },
    });
    const h = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    const lost = events.filter(e => e.type === 'lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ type: 'lost', lock: 'edit', reason: 'watchdog' });
    expect((lost[0] as { detail: string }).detail).toMatch(/the controller refused the watchdog reset/);
    expect(events.some(e => e.type === 'atRisk')).toBe(false);
    expect(logs.warn.some(w => /edit mastership was lost: the controller refused the watchdog reset/.test(w) && /Select set/.test(w) && /motors off/.test(w))).toBe(true);
    expect(m.count('edit')).toBe(0);
    expect(wd.state().running).toBe(false);
    // The one release after the loss; the controller may still count the hold.
    expect(wire).toEqual(['request edit', 'read heartbeat', 'kick', 'release edit']);
    expect(m.snapshot().locks.find(l => l.lock === 'edit')).toMatchObject({ state: 'lost', count: 0, lost: { reason: 'watchdog' } });

    await vi.advanceTimersByTimeAsync(5000);
    expect(wire.filter(w => w === 'kick')).toHaveLength(1);
    // The holder's own release has nothing left to end.
    await m.release(h);
    expect(wire).toEqual(['request edit', 'read heartbeat', 'kick', 'release edit']);
  });

  it('a reset that did not get through while the Timeout has not run out is a hold at risk; the hold stays', async () => {
    let fail = true;
    const { m, wire, events } = setup({
      config: { select: true, timeoutMs: 2500 },
      kick: async () => { if (fail) { fail = false; throw networkError(); } },
    });
    const h = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    const risks = events.filter(e => e.type === 'atRisk');
    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({ lock: 'edit', reason: 'watchdog' });
    expect((risks[0] as { error?: unknown }).error).toBeInstanceOf(RwsError);
    expect(logs.warn.some(w => /edit mastership may be at risk: a watchdog reset did not get through/.test(w))).toBe(true);
    expect(m.count('edit')).toBe(1);

    // The next reset is accepted 2000 ms after the hold began, within 2500 ms.
    await vi.advanceTimersByTimeAsync(1000);
    expect(logs.info.some(i => /accepted on time again/.test(i))).toBe(true);
    expect(events.some(e => e.type === 'lost')).toBe(false);
    await m.release(h);
    expect(wire.at(-1)).toBe('release edit');
    expect(wire.filter(w => w === 'release edit')).toHaveLength(1);
  });

  it('resets that do not get through for longer than the Timeout are a lost hold', async () => {
    const { m, wire, events } = setup({
      config: { select: false, timeoutMs: 2000 },
      kick: async () => { throw networkError(); },
    });
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.filter(e => e.type === 'atRisk')).toHaveLength(1);
    expect(events.some(e => e.type === 'lost')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    const lost = events.find(e => e.type === 'lost');
    expect(lost).toMatchObject({ lock: 'edit', reason: 'watchdog' });
    expect((lost as { detail: string }).detail).toMatch(/no watchdog reset was accepted for 3000 ms, more than the 2000 ms heartbeat timeout/);
    expect((lost as { detail: string }).detail).toMatch(/Select cleared/);
    expect(m.count('edit')).toBe(0);
    expect(wire.at(-1)).toBe('release edit');
  });

  it('a reset accepted later than the Timeout is a lost hold', async () => {
    const { m, events, kicks, wire } = setup({
      config: { select: null, timeoutMs: 2000 },
      kick: () => new Promise<void>(r => setTimeout(r, 2500)),
    });
    await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(3400);
    expect(kicks).toHaveLength(1);
    expect(events.filter(e => e.type === 'lost')).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    const lost = events.find(e => e.type === 'lost');
    expect(lost).toMatchObject({ lock: 'edit', reason: 'watchdog' });
    expect((lost as { detail: string }).detail).toMatch(/3500 ms passed between two accepted watchdog resets, more than the 2000 ms heartbeat timeout/);
    await vi.advanceTimersByTimeAsync(3000);
    expect(kicks).toHaveLength(1);
    expect(wire.at(-1)).toBe('release edit');
  });

  it('a reset that fails after the hold ended is not reported', async () => {
    let fail: ((e: unknown) => void) | null = null;
    const { m, events } = setup({ kick: () => new Promise<void>((_r, j) => { fail = j; }) });
    const h = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    await m.release(h);
    fail!(refusal());
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(e => e.type === 'atRisk')).toEqual([]);
    expect(logs.warn).toEqual([]);
  });

  // Regression: a reset still on the wire when hold A ends must not fault, or
  // credit, the NEXT hold B. Before the kick-generation guard, A's stale reset
  // left kickInFlight true across the handoff, so B sent no resets and A's late
  // failure dropped B's valid hold.
  it('a reset from an ended hold never touches the hold that takes over', async () => {
    let n = 0;
    let failFirst: ((e: unknown) => void) | null = null;
    const { m, wd, events, wire } = setup({
      config: { select: true, timeoutMs: 2000 },
      kick: () => {
        n += 1;
        // Hold A's first reset hangs until we fail it; every later reset (B's) is fine.
        if (n === 1) { return new Promise<void>((_r, j) => { failFirst = j; }); }
        return Promise.resolve();
      },
    });
    const a = await m.acquire('rapid');
    await vi.advanceTimersByTimeAsync(1000);
    expect(wire.filter(w => w === 'kick')).toHaveLength(1); // A's reset is on the wire, pending

    await m.release(a);            // A ends while its reset is still unanswered
    const b = await m.acquire('rapid'); // B takes edit afresh
    failFirst!(networkError());    // A's stale reset now fails
    await vi.advanceTimersByTimeAsync(0);

    // B keeps its hold: the stale answer belonged to a retired generation.
    expect(events.some(e => e.type === 'lost')).toBe(false);
    expect(events.some(e => e.type === 'atRisk')).toBe(false);
    expect(m.count('edit')).toBe(1);

    // And B is not muzzled: it sends its own resets on time.
    await vi.advanceTimersByTimeAsync(2000);
    expect(wd.state().running).toBe(true);
    expect(wire.filter(w => w === 'kick').length).toBeGreaterThanOrEqual(2);
    await m.release(b);
  });
});
