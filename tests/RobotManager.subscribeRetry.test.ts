import { describe, it, expect, afterEach, vi } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';
import { CUT_CREATE } from '../src/HttpSession.js';
import { RwsError } from '../src/types.js';
import { Logger } from '../src/Logger.js';

// While connected without an event stream (the subscribe at connect failed,
// or the adapter gave the stream up), RobotManager subscribes again on a
// backoff: 5, 10, 20, 40 s, then each minute, checked at the end of each poll
// that succeeded. Until 1.5.1 a failed subscribe at connect was never tried
// again: an IRC5 virtual controller that did not answer POST /subscription
// within the 5 s timeout, in a connect of three controllers at once, was
// fast-polled for the whole connection (2026-10-25). After three creates in a
// row that got no answer the retries are 10 minutes apart.
//
// Every timer is fake (Date included), so the poll runs on its own timer at
// the fast rate (1 s) and the slow rate (5 s), and the test moves the clock.

const DIGEST_PROBE = { port: 80, useHttps: false, authType: 'digest' as const };
const T0 = Date.parse('2026-10-25T08:00:00Z');
const TIMED_OUT = 'Request timed out after 5000ms: POST /subscription';

type Handle = () => Promise<void>;
type Subscribe = (resources: unknown, handler: unknown, onLost?: () => void, onRestored?: () => void) => Promise<Handle>;

/** In-memory adapter covering everything connect and the poll touch. */
function makeFakeAdapter() {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getSessionCookie: vi.fn((): string | null => null),
    subscribe: vi.fn<Parameters<Subscribe>, ReturnType<Subscribe>>(async () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); }),
    getRapidExecutionInfo: vi.fn(async () => ({ state: 'stopped', cycle: 'forever' })),
    getControllerState: vi.fn(async () => 'motoron'),
    getOperationMode: vi.fn(async () => 'AUTO'),
    getSpeedRatio: vi.fn(async () => 100),
    getRapidTasks: vi.fn(async () => [
      { name: 'T_ROB1', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
    ]),
    listModules: vi.fn(async (..._args: unknown[]) => ['MainModule']),
    getJointPositions: vi.fn(async () => ({ rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 0, rax_6: 0 })),
    getCartesianFull: vi.fn(async () => ({ x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 })),
    getCollisionDetectionState: vi.fn(async () => 'On'),
    getControllerIdentity: vi.fn(async () => ({ name: 'vc' })),
    getSystemInfo: vi.fn(async () => ({ name: 'vc' })),
    getEventLog: vi.fn(async () => []),
    listMechunits: vi.fn(async () => ['ROB_1']),
    listAllSignals: vi.fn(async (): Promise<unknown[]> => []),
    releaseMastership: vi.fn(async () => {}),
  };
}
type FakeAdapter = ReturnType<typeof makeFakeAdapter>;

/** A manager on `fake`, polling every 1 s without a stream and every 5 s with one. */
function managerWith(fake: FakeAdapter): RobotManager {
  const m = new RobotManager({ refreshIntervalMs: 1000 });
  (m as any).adapter = fake;
  (m as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
  vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);
  return m;
}

/** The clock (seconds since T0) at each subscribe the adapter got (recordSubscribes). */
const times = new WeakMap<FakeAdapter, number[]>();
const subscribeTimes = (fake: FakeAdapter): number[] => [...times.get(fake)!];
/** Record the clock at each subscribe, then answer as `impl` does. */
function recordSubscribes(fake: FakeAdapter, impl: Subscribe): void {
  const at: number[] = [];
  times.set(fake, at);
  fake.subscribe.mockImplementation(async (...args) => { at.push((Date.now() - T0) / 1000); return impl(...args); });
}

const polls = (fake: FakeAdapter): number => fake.getControllerState.mock.calls.length;
const subscribeLines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('WS subscriptions'));

describe('RobotManager subscribes again while connected without an event stream', () => {
  let mgr: RobotManager | null = null;

  afterEach(async () => {
    await mgr?.disconnect().catch(() => {});
    mgr = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function start(): { info: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn> } {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    return {
      info: vi.spyOn(Logger, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(Logger, 'warn').mockImplementation(() => {}),
    };
  }

  it('a subscribe that timed out at connect is tried again 5 s later; on success the stream is live, the poll slows and one poll resyncs', async () => {
    const { info, warn } = start();
    const fake = makeFakeAdapter();
    const handle = vi.fn(async () => {});
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockResolvedValueOnce(handle);
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(mgr.state.quality).toBe('polling');
    expect(mgr.state.qualityReason).toBe('WebSocket unavailable - fast polling');
    expect((mgr as any).pollEveryMs).toBe(1000);
    expect(subscribeLines(info)).toEqual([`WS subscriptions unavailable, using polling only: ${TIMED_OUT}; subscribing again in 5 s`]);

    // Four fast polls inside the wait, no subscribe.
    const atConnect = polls(fake);
    await vi.advanceTimersByTimeAsync(4999);
    expect(polls(fake)).toBe(atConnect + 4);
    expect(fake.subscribe).toHaveBeenCalledTimes(1);

    // The poll at 5 s subscribes again, and the stream starts.
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect(fake.subscribe.mock.calls[1][0]).toEqual(fake.subscribe.mock.calls[0][0]);
    expect((mgr as any).subscriptionActive).toBe(true);
    expect((mgr as any).unsubscribeFn).toBe(handle);
    expect(mgr.state.quality).toBe('live');
    expect(mgr.state.qualityReason).toBe('WebSocket events streaming after a retry');
    expect((mgr as any).pollEveryMs).toBe(5000);
    // The 5 s poll and one resync poll right after the stream started.
    expect(polls(fake)).toBe(atConnect + 6);
    expect(subscribeLines(info).at(-1)).toBe('WS subscriptions started on retry 1 - events streaming, resyncing state');
    expect(warn).not.toHaveBeenCalled();

    // From here the slow rate: the next poll 5 s later.
    await vi.advanceTimersByTimeAsync(4999);
    expect(polls(fake)).toBe(atConnect + 6);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls(fake)).toBe(atConnect + 7);

    // No subscribe while the stream is up; the disconnect lets the group go.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    await mgr.disconnect();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('failures in a row are tried again after 5, 10, 20, 40 s, then each minute, each logged once at info', async () => {
    const { info, warn } = start();
    const fake = makeFakeAdapter();
    const BUSY = 'Controller busy (503) - retry later';
    recordSubscribes(fake, async () => { throw new RwsError(BUSY, 'CONTROLLER_BUSY', 503); });
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(255_000);

    expect(subscribeTimes(fake)).toEqual([0, 5, 15, 35, 75, 135, 195, 255]);
    expect(subscribeLines(info)).toEqual([
      `WS subscriptions unavailable, using polling only: ${BUSY}; subscribing again in 5 s`,
      `WS subscriptions: retry 1 failed (${BUSY}); polling continues, the next retry in 10 s`,
      `WS subscriptions: retry 2 failed (${BUSY}); polling continues, the next retry in 20 s`,
      `WS subscriptions: retry 3 failed (${BUSY}); polling continues, the next retry in 40 s`,
      `WS subscriptions: retry 4 failed (${BUSY}); polling continues, the next retry in 60 s`,
      `WS subscriptions: retry 5 failed (${BUSY}); polling continues, the next retry in 60 s`,
      `WS subscriptions: retry 6 failed (${BUSY}); polling continues, the next retry in 60 s`,
      `WS subscriptions: retry 7 failed (${BUSY}); polling continues, the next retry in 60 s`,
    ]);
    expect(warn).not.toHaveBeenCalled();
    // The fast poll went on throughout.
    expect(mgr.state.quality).toBe('polling');
    expect((mgr as any).pollEveryMs).toBe(1000);
  });

  it('a retry still out holds the next one back, and the poll goes on', async () => {
    start();
    const fake = makeFakeAdapter();
    let land!: (h: Handle) => void;
    const handle = vi.fn(async () => {});
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockImplementationOnce(() => new Promise<Handle>(r => { land = r; }));
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    const before = polls(fake);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect(polls(fake)).toBe(before + 120);

    land(handle);
    await (mgr as any).subscribeRetry.done;
    expect(mgr.state.quality).toBe('live');
    expect((mgr as any).subscribeRetry).toBeNull();
  });

  it('a disconnect while a retry is out: the group it lands with is unsubscribed and the manager stays disconnected', async () => {
    start();
    const fake = makeFakeAdapter();
    let land!: (h: Handle) => void;
    const late = vi.fn(async () => {});
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockImplementationOnce(() => new Promise<Handle>(r => { land = r; }));
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    const retry: Promise<void> = (mgr as any).subscribeRetry.done;

    await mgr.disconnect();
    land(late);
    await retry;

    expect(late).toHaveBeenCalledTimes(1);
    expect(mgr.state.connected).toBe(false);
    expect(mgr.state.quality).toBe('disconnected');
    expect((mgr as any).subscriptionActive).toBe(false);
    expect((mgr as any).unsubscribeFn).toBeNull();
    expect((mgr as any).subscribeRetry).toBeNull();
    expect((mgr as any).timer).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
  });

  it('a reconnect while a retry is out: the connect\'s own subscribe waits for it, and its late group is unsubscribed first', async () => {
    start();
    const fake = makeFakeAdapter();
    let land!: (h: Handle) => void;
    const late = vi.fn(async () => {});
    const fresh = vi.fn(async () => {});
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockImplementationOnce(() => new Promise<Handle>(r => { land = r; }))
      .mockResolvedValueOnce(fresh);
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(5000);
    await mgr.disconnect();
    const reconnect = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);   // never two subscribes out

    land(late);
    await reconnect;
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.invocationCallOrder[0]).toBeLessThan(fake.subscribe.mock.invocationCallOrder[2]);
    expect(fake.subscribe).toHaveBeenCalledTimes(3);
    expect((mgr as any).unsubscribeFn).toBe(fresh);
    expect(mgr.state.quality).toBe('live');
    expect(mgr.state.qualityReason).toBe('WebSocket events streaming');
  });

  it('a reconnect starts the backoff again from 5 s', async () => {
    start();
    const fake = makeFakeAdapter();
    recordSubscribes(fake, async () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); });
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(6000);           // retry 1 at 5 s failed: the next due at 15 s
    expect(subscribeTimes(fake)).toEqual([0, 5]);
    await mgr.disconnect();
    expect((mgr as any).subscribeRetryDueAt).toBeNull();
    await mgr.connect('vc-a', 'u', 'p', 80);           // at 6 s: fails, the next due at 11 s
    await vi.advanceTimersByTimeAsync(9000);
    expect(subscribeTimes(fake)).toEqual([0, 5, 6, 11]);
  });

  it('no subscribe again while the stream is up', async () => {
    start();
    const fake = makeFakeAdapter();
    fake.subscribe.mockResolvedValue(vi.fn(async () => {}));
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(mgr.state.quality).toBe('live');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect((mgr as any).subscribeRetryDueAt).toBeNull();
  });

  it('a stream the adapter gave up is subscribed again on the same backoff; the lost handle is let go first', async () => {
    const { info, warn } = start();
    const fake = makeFakeAdapter();
    let onLost: (() => void) | undefined;
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const BUSY = 'Controller busy (503) - retry later';
    recordSubscribes(fake, async (_r, _h, lost) => {
      const n = times.get(fake)!.length;
      if (n === 1) { onLost = lost; return first; }
      if (n === 2) { throw new RwsError(BUSY, 'CONTROLLER_BUSY', 503); }
      return second;
    });
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(mgr.state.quality).toBe('live');
    await vi.advanceTimersByTimeAsync(10_000);
    onLost!();
    expect(mgr.state.quality).toBe('polling');
    expect(mgr.state.qualityReason).toBe('live event stream lost - fast polling');
    expect(warn).toHaveBeenCalledWith('live event stream lost - resuming fast polling, subscribing again in 5 s');
    expect((mgr as any).pollEveryMs).toBe(1000);

    await vi.advanceTimersByTimeAsync(4999);
    expect(subscribeTimes(fake)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);              // 15 s: the lost handle goes, the retry fails
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(fake.subscribe.mock.invocationCallOrder[1]);
    expect(subscribeTimes(fake)).toEqual([0, 15]);
    expect(subscribeLines(info).at(-1)).toBe(`WS subscriptions: retry 1 failed (${BUSY}); polling continues, the next retry in 10 s`);

    await vi.advanceTimersByTimeAsync(10_000);         // 25 s: the stream is back
    expect(subscribeTimes(fake)).toEqual([0, 15, 25]);
    expect(mgr.state.quality).toBe('live');
    expect(mgr.state.qualityReason).toBe('WebSocket events streaming after a retry');
    expect((mgr as any).pollEveryMs).toBe(5000);
    expect((mgr as any).unsubscribeFn).toBe(second);

    await mgr.disconnect();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('an adapter that cannot subscribe (UNSUPPORTED_OPERATION, or no subscribe at all) is not tried again', async () => {
    const { info } = start();
    const fake = makeFakeAdapter();
    fake.subscribe.mockRejectedValue(new RwsError('no subscriptions on this controller', 'UNSUPPORTED_OPERATION'));
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(mgr.state.quality).toBe('polling');
    expect(subscribeLines(info)).toEqual([
      'WS subscriptions unavailable, using polling only: no subscriptions on this controller; the adapter cannot subscribe, so the subscribe is not tried again on this connection',
    ]);
    await mgr.disconnect();

    // A retry refused that way ends the schedule as well.
    info.mockClear();
    fake.subscribe.mockReset();
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockRejectedValue(new RwsError('no subscriptions on this controller', 'UNSUPPORTED_OPERATION'));
    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect(subscribeLines(info).at(-1)).toBe('WS subscriptions: retry 1 failed (no subscriptions on this controller); the adapter cannot subscribe, so polling continues without further retries on this connection');
    await mgr.disconnect();

    // An adapter without subscribe().
    info.mockClear();
    const bare = makeFakeAdapter() as Partial<FakeAdapter>;
    delete bare.subscribe;
    mgr = managerWith(bare as FakeAdapter);
    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mgr.state.connected).toBe(true);
    expect(mgr.state.quality).toBe('polling');
    expect(subscribeLines(info)).toEqual([
      'WS subscriptions unavailable, using polling only: this adapter has no subscribe(); the adapter cannot subscribe, so the subscribe is not tried again on this connection',
    ]);
  });

  it('a clock set back does not hold the retry off', async () => {
    start();
    const fake = makeFakeAdapter();
    recordSubscribes(fake, async () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); });
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);           // due at 5 s
    await vi.advanceTimersByTimeAsync(2000);
    vi.setSystemTime(T0 - 3600_000);                   // an hour back
    await vi.advanceTimersByTimeAsync(1000);           // the next poll subscribes: due 10 s from here
    expect(subscribeTimes(fake)).toEqual([0, -3599]);
    await vi.advanceTimersByTimeAsync(9000);
    expect(subscribeTimes(fake)).toEqual([0, -3599]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(subscribeTimes(fake)).toEqual([0, -3599, -3589]);
  });

  it('a failed poll holds the retry off until a poll succeeds again', async () => {
    start();
    const fake = makeFakeAdapter();
    const handle = vi.fn(async () => {});
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockResolvedValueOnce(handle);
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(4000);
    fake.getControllerState.mockRejectedValueOnce(new RwsError('Request timed out after 5000ms: GET /rw/panel/ctrlstate', 'NETWORK_ERROR'));
    await vi.advanceTimersByTimeAsync(1000);           // 5 s: the poll fails, no subscribe
    expect(mgr.state.quality).toBe('stale');
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);           // 6 s: the poll succeeds, then the subscribe
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect(mgr.state.quality).toBe('live');
  });

  it('after three creates in a row that got no answer, the retries are 10 minutes apart until one is answered', async () => {
    // Each unanswered create may leave a group on the controller, and on
    // RWS 1.0 it holds the session's requests for up to 10 s.
    const { info, warn } = start();
    const fake = makeFakeAdapter();
    const BUSY = 'Controller busy (503) - retry later';
    const RWS2_TIMED_OUT = 'RWS2 subscribe POST timed out after 10000 ms';
    const answers: Array<() => never> = [
      () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); },        // 0 s, at connect
      () => { throw new RwsError(RWS2_TIMED_OUT, 'NETWORK_ERROR'); },   // 5 s
      () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); },        // 15 s: the third in a row
      () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); },        // 615 s
      () => { throw new RwsError(BUSY, 'CONTROLLER_BUSY', 503); },     // 1215 s: answered
    ];
    const handle = vi.fn(async () => {});
    recordSubscribes(fake, async () => {
      const next = answers[times.get(fake)!.length - 1];
      if (next) { next(); }
      return handle;
    });
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(1215_000);
    expect(subscribeTimes(fake)).toEqual([0, 5, 15, 615, 1215]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(subscribeTimes(fake)).toEqual([0, 5, 15, 615, 1215]);
    await vi.advanceTimersByTimeAsync(1000);           // a minute after the answered refusal: the stream starts
    expect(subscribeTimes(fake)).toEqual([0, 5, 15, 615, 1215, 1275]);
    expect(mgr.state.quality).toBe('live');

    const slow = '10 minutes (3 creates in a row got no answer, and each may leave a group on the controller)';
    expect(subscribeLines(info)).toEqual([
      `WS subscriptions unavailable, using polling only: ${TIMED_OUT}; subscribing again in 5 s`,
      `WS subscriptions: retry 1 failed (${RWS2_TIMED_OUT}); polling continues, the next retry in 10 s`,
      `WS subscriptions: retry 2 failed (${TIMED_OUT}); polling continues, the next retry in ${slow}`,
      `WS subscriptions: retry 3 failed (${TIMED_OUT}); polling continues, the next retry in ${slow.replace('3 creates', '4 creates')}`,
      `WS subscriptions: retry 4 failed (${BUSY}); polling continues, the next retry in 60 s`,
      'WS subscriptions started on retry 5 - events streaming, resyncing state',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failed mechanical-unit read leaves the list as it was, never a guessed ROB_1', async () => {
    start();
    const fake = makeFakeAdapter();
    fake.listMechunits
      .mockRejectedValueOnce(new RwsError('Request timed out after 5000ms: GET /rw/motionsystem/mechunits', 'NETWORK_ERROR'))
      .mockResolvedValueOnce(['ROB_1', 'ROB_2'])
      .mockRejectedValueOnce(new RwsError('Controller busy (503) - retry later', 'CONTROLLER_BUSY', 503));
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(fake.listMechunits).toHaveBeenCalledTimes(1);
    expect(mgr.state.mechunits).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);   // the list is read again every 30th poll
    expect(fake.listMechunits).toHaveBeenCalledTimes(2);
    expect(mgr.state.mechunits).toEqual(['ROB_1', 'ROB_2']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.listMechunits).toHaveBeenCalledTimes(3);
    expect(mgr.state.mechunits).toEqual(['ROB_1', 'ROB_2']);
  });

  it('a create cut short for a stop (RWS 1.0) neither adds to the unanswered creates in a row nor ends them', async () => {
    const { info } = start();
    const fake = makeFakeAdapter();
    const CUT = `${CUT_CREATE}POST /rw/rapid/execution?action=stop`;
    const answers: Array<() => never> = [
      () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); },                 // 0 s, at connect: 1 unanswered
      () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); },                 // 5 s: 2
      () => { throw new RwsError(CUT, 'NETWORK_ERROR'); },                       // 15 s: still 2
      () => { throw new RwsError(TIMED_OUT, 'NETWORK_ERROR'); },                 // 35 s: 3
      () => { throw new RwsError('Controller busy (503) - retry later', 'CONTROLLER_BUSY', 503); }, // 635 s: answered
    ];
    const handle = vi.fn(async () => {});
    recordSubscribes(fake, async () => {
      const next = answers[times.get(fake)!.length - 1];
      if (next) { next(); }
      return handle;
    });
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(695_000);
    expect(subscribeTimes(fake)).toEqual([0, 5, 15, 35, 635, 695]);
    expect(subscribeLines(info)[2]).toBe(`WS subscriptions: retry 2 failed (${CUT}); polling continues, the next retry in 20 s`);
    expect(mgr.state.quality).toBe('live');
  });

  it('a retry whose group leaves a status resource unbound ends at the fast rate, `polling`, the reason naming it', async () => {
    start();
    const fake = makeFakeAdapter();
    const handle = Object.assign(vi.fn(async () => {}), { unbound: ['/rw/rapid/execution;ctrlexecstate'] });
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockResolvedValueOnce(handle);
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect((mgr as any).subscriptionActive).toBe(true);
    expect([...(mgr as any).unboundResources]).toEqual(['/rw/rapid/execution;ctrlexecstate']);
    expect(mgr.state.quality).toBe('polling');
    expect(mgr.state.qualityReason).toBe('WebSocket events streaming after a retry, but the controller did not bind '
      + '/rw/rapid/execution;ctrlexecstate, so the execution state is polled (fast polling)');
    expect((mgr as any).pollEveryMs).toBe(1000);
    expect((mgr as any).subscribeRetryDueAt).toBeNull();
  });

  it('a retry that fails after a reconnect leaves the new connection\'s backoff alone', async () => {
    const { info } = start();
    const fake = makeFakeAdapter();
    let fail!: (e: unknown) => void;
    const BUSY = 'Controller busy (503) - retry later';
    recordSubscribes(fake, async () => {
      const n = times.get(fake)!.length;
      if (n === 2) { return new Promise<Handle>((_resolve, reject) => { fail = reject; }); }
      throw new RwsError(TIMED_OUT, 'NETWORK_ERROR');
    });
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(5000);           // 5 s: the retry goes out
    await mgr.disconnect();
    const reconnect = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(0);
    fail(new RwsError(BUSY, 'CONTROLLER_BUSY', 503));  // the old retry fails late
    await reconnect;                                   // its own subscribe at 5 s fails: the next at 10 s
    await vi.advanceTimersByTimeAsync(5000);
    expect(subscribeTimes(fake)).toEqual([0, 5, 5, 10]);
    expect(subscribeLines(info).filter(l => l.includes(BUSY))).toEqual([]);
  });

  it('a retry that lands while a poll failed keeps `stale` until the next poll that succeeds', async () => {
    start();
    const fake = makeFakeAdapter();
    let land!: (h: Handle) => void;
    const handle = vi.fn(async () => {});
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockImplementationOnce(() => new Promise<Handle>(r => { land = r; }));
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(5000);           // 5 s: the retry goes out
    fake.getControllerState.mockRejectedValueOnce(new RwsError('Request timed out after 5000ms: GET /rw/panel/ctrlstate', 'NETWORK_ERROR'));
    await vi.advanceTimersByTimeAsync(1000);           // 6 s: a poll fails
    expect(mgr.state.quality).toBe('stale');

    let answer!: (v: string) => void;
    fake.getControllerState.mockImplementationOnce(() => new Promise<string>(r => { answer = r; }));
    land(handle);
    await (mgr as any).subscribeRetry.done;
    expect((mgr as any).subscriptionActive).toBe(true);
    expect((mgr as any).pollEveryMs).toBe(5000);
    expect(mgr.state.quality).toBe('stale');           // the resync poll is still out

    answer('motoron');
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.state.quality).toBe('live');
    expect(mgr.state.qualityReason).toBe('poll succeeded - connection recovered');
  });

  it('no retry from the first poll of a connect still in flight, however long that poll takes', async () => {
    start();
    const fake = makeFakeAdapter();
    fake.subscribe
      .mockRejectedValueOnce(new RwsError(TIMED_OUT, 'NETWORK_ERROR'))
      .mockResolvedValueOnce(vi.fn(async () => {}));
    fake.getControllerState.mockImplementationOnce(() => new Promise<string>(r => { setTimeout(() => r('motoron'), 6000); }));
    mgr = managerWith(fake);

    const connecting = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.advanceTimersByTimeAsync(6000);           // the first poll ends after the retry was due
    await connecting;
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(mgr.state.quality).toBe('polling');
    await vi.advanceTimersByTimeAsync(1000);           // the next poll, after the connect: the retry
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect(mgr.state.quality).toBe('live');
  });
});
