import { describe, it, expect, afterEach, vi } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';
import { setLogger } from '../src/Logger.js';
import type { ElogMessage } from '../src/types.js';

/**
 * RobotManager and a subscription group the controller created without some
 * of its resources (the handle's `unbound`). RW 6.16.03 left `/rw/elog/0`
 * out of every group the manager created for a whole run (2026-10-22,
 * on the virtual controller): the quality stayed `live`, no elog event ever came, and
 * the poll read the event log only every 30th time, so `state.eventLog` went
 * stale with no sign. Now the poll reads what the group left out and the
 * quality reason says so; a group that binds everything changes nothing.
 */

const warns: string[] = [];
setLogger({ info() {}, warn(m) { warns.push(m); }, error() {}, show() {} });

const msg = (seqnum: number): ElogMessage => ({
  seqnum, code: 10000 + seqnum, msgtype: 1, timestamp: '2026-10-22 T 22:29:41', srcName: '', title: `m${seqnum}`,
  desc: '', causes: '', consequences: '', actions: '', args: [],
});

const DIGEST_PROBE = { port: 80, useHttps: false, authType: 'digest' as const };
const REFRESH_MS = 400;
const SLOW_MS = 5 * REFRESH_MS;

/** An adapter of another make covering what connect and the poll touch; its subscribe hands back `handle`. */
function makeFakeAdapter(handle: () => Promise<void>) {
  const callbacks: { onLost?: () => void; onRestored?: () => void } = {};
  let eventLog: ElogMessage[] = [];
  const fake = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getSessionCookie: vi.fn((): string | null => null),
    subscribe: vi.fn(async (_r: unknown, _h: unknown, lost?: () => void, restored?: () => void) => {
      callbacks.onLost = lost;
      callbacks.onRestored = restored;
      return handle;
    }),
    getRapidExecutionInfo: vi.fn(async () => ({ state: 'stopped', cycle: 'forever' })),
    getControllerState: vi.fn(async () => 'motoron'),
    getOperationMode: vi.fn(async () => 'AUTO'),
    getSpeedRatio: vi.fn(async () => 100),
    getRapidTasks: vi.fn(async () => [
      { name: 'T_ROB1', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
    ]),
    listModules: vi.fn(async () => ['MainModule']),
    getJointPositions: vi.fn(async () => ({ rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 0, rax_6: 0 })),
    getCartesianFull: vi.fn(async () => ({ x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 })),
    getCollisionDetectionState: vi.fn(async () => 'On'),
    getControllerIdentity: vi.fn(async () => ({ name: 'vc' })),
    getSystemInfo: vi.fn(async () => ({ name: 'vc' })),
    getEventLog: vi.fn(async () => eventLog),
    listMechunits: vi.fn(async () => ['ROB_1']),
    listAllSignals: vi.fn(async (): Promise<unknown[]> => []),
    releaseMastership: vi.fn(async () => {}),
  };
  return { fake, callbacks, setEventLog: (log: ElogMessage[]) => { eventLog = log; } };
}

/** A subscribe handle whose `unbound` reads `current.unbound` live, as the package's adapters do. */
function handleWith(current: { unbound?: string[] }): () => Promise<void> {
  const stop = async (): Promise<void> => {};
  Object.defineProperty(stop, 'unbound', { get: () => current.unbound, enumerable: true });
  return stop;
}

let mgr: RobotManager | null = null;

async function connected(handle: () => Promise<void>) {
  vi.useFakeTimers();
  mgr = new RobotManager({ refreshIntervalMs: REFRESH_MS });
  const rig = makeFakeAdapter(handle);
  (mgr as any).adapter = rig.fake;
  (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
  vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);
  await mgr.connect('vc-a', 'u', 'p', 80);
  return { m: mgr, ...rig };
}

afterEach(async () => {
  await mgr?.disconnect().catch(() => {});
  mgr = null;
  warns.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('RobotManager: an event log the controller did not bind', () => {
  it('stays live, says the event log is polled, and every slow poll re-reads the log', async () => {
    const { m, fake, setEventLog } = await connected(handleWith({ unbound: ['/rw/elog/0'] }));
    expect(m.state.quality).toBe('live');
    expect(m.state.qualityReason).toBe('WebSocket events streaming, but the controller did not bind /rw/elog/0, so the event log is polled');
    expect(warns).toContain('subscription: the controller did not bind /rw/elog/0, so the event log is polled');
    expect(fake.getEventLog).toHaveBeenCalledTimes(1);                 // the first poll's whole read

    // The slow rate stays: the stream still brings every state field.
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(fake.getControllerState).toHaveBeenCalledTimes(1);

    // A message arrives on the controller; no elog event will say so.
    setEventLog([msg(52)]);
    await vi.advanceTimersByTimeAsync(SLOW_MS - REFRESH_MS);
    expect(fake.getControllerState).toHaveBeenCalledTimes(2);
    expect(fake.getEventLog).toHaveBeenCalledTimes(2);
    expect(m.state.eventLog.map(e => e.seqnum)).toEqual([52]);

    setEventLog([msg(52), msg(53)]);
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(fake.getEventLog).toHaveBeenCalledTimes(3);
    expect(m.state.eventLog.map(e => e.seqnum)).toEqual([52, 53]);
  });

  it('keeps saying so after a stale poll recovers', async () => {
    const { m, fake } = await connected(handleWith({ unbound: ['/rw/elog/0'] }));
    fake.getControllerState.mockRejectedValueOnce(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(m.state.quality).toBe('stale');
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(m.state.quality).toBe('live');
    expect(m.state.qualityReason).toBe('poll succeeded - connection recovered, but the controller did not bind /rw/elog/0, so the event log is polled');
  });

  it('a group that binds everything changes nothing: no note, the log read only on the slow fetch', async () => {
    for (const current of [{ unbound: [] as string[] }, {}]) {      // {}: a handle without `unbound` (an adapter of another make)
      const { m, fake } = await connected(handleWith(current));
      expect(m.state.quality).toBe('live');
      expect(m.state.qualityReason).toBe('WebSocket events streaming');
      await vi.advanceTimersByTimeAsync(3 * SLOW_MS);
      expect(fake.getControllerState).toHaveBeenCalledTimes(4);    // slow rate
      expect(fake.getEventLog).toHaveBeenCalledTimes(1);           // only the first poll's whole read
      expect(warns.filter(w => w.includes('did not bind'))).toEqual([]);
      await m.disconnect();
      vi.useRealTimers();
    }
  });
});

describe('RobotManager: a status resource the controller did not bind', () => {
  it('polls at the fast rate, reads polling, and says why; an unbound event log is then read every fifth poll', async () => {
    const { m, fake } = await connected(handleWith({ unbound: ['/rw/rapid/execution;ctrlexecstate', '/rw/elog/0'] }));
    // `live` means the slow rate (ConnectionQuality); a consumer that budgets
    // on the quality counts the fast rate's requests on `polling`.
    expect(m.state.quality).toBe('polling');
    expect(m.state.qualityReason).toBe('WebSocket events streaming, but the controller did not bind /rw/rapid/execution;ctrlexecstate, /rw/elog/0, '
      + 'so the execution state and the event log are polled (fast polling)');
    await vi.advanceTimersByTimeAsync(10 * REFRESH_MS);
    expect(fake.getRapidExecutionInfo).toHaveBeenCalledTimes(11);    // fast rate: the first poll and ten more
    expect(fake.getEventLog).toHaveBeenCalledTimes(3);              // the first poll, then polls 5 and 10
  });

  it('a stale poll recovers to polling, not live, while the fast rate runs', async () => {
    const { m, fake } = await connected(handleWith({ unbound: ['/rw/rapid/execution;ctrlexecstate'] }));
    fake.getControllerState.mockRejectedValueOnce(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(m.state.quality).toBe('stale');
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(m.state.quality).toBe('polling');
    expect(m.state.qualityReason).toBe('poll succeeded - connection recovered, but the controller did not bind /rw/rapid/execution;ctrlexecstate, so the execution state is polled (fast polling)');
  });

  it('names a resource the poll does not read as one no events come for', async () => {
    const { m } = await connected(handleWith({ unbound: ['/rw/iosystem/signals/di1;state'] }));
    expect(m.state.qualityReason).toBe('WebSocket events streaming, but the controller did not bind /rw/iosystem/signals/di1;state, so no events come for /rw/iosystem/signals/di1;state');
  });
});

describe('RobotManager: unbound resources across a restore and a loss', () => {
  it('a restore re-reads them: the note, the event-log polling and the poll rate follow the new group', async () => {
    const current: { unbound?: string[] } = { unbound: ['/rw/elog/0'] };
    const { m, fake, callbacks } = await connected(handleWith(current));

    // The reconnect created a group that binds everything.
    current.unbound = [];
    callbacks.onRestored!();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.state.quality).toBe('live');
    expect(m.state.qualityReason).toBe('live event stream restored');
    const reads = fake.getEventLog.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * SLOW_MS);
    expect(fake.getEventLog.mock.calls.length).toBe(reads);

    // The next one leaves the execution state out: the fast rate.
    current.unbound = ['/rw/rapid/execution;ctrlexecstate'];
    callbacks.onRestored!();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.state.quality).toBe('polling');
    expect(m.state.qualityReason).toBe('live event stream restored, but the controller did not bind /rw/rapid/execution;ctrlexecstate, so the execution state is polled (fast polling)');
    const polls = fake.getControllerState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * REFRESH_MS);
    expect(fake.getControllerState.mock.calls.length).toBe(polls + 2);

    // And one that binds it again: back to the slow rate and live.
    current.unbound = [];
    callbacks.onRestored!();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.state.quality).toBe('live');
    expect(m.state.qualityReason).toBe('live event stream restored');
  });

  it('a lost stream leaves nothing unbound: everything is polled fast, as before', async () => {
    const { m, callbacks } = await connected(handleWith({ unbound: ['/rw/elog/0'] }));
    callbacks.onLost!();
    expect(m.state.quality).toBe('polling');
    expect(m.state.qualityReason).toBe('live event stream lost - fast polling');
    expect((m as any).unboundResources.size).toBe(0);
  });

  it('a disconnect forgets them', async () => {
    const { m } = await connected(handleWith({ unbound: ['/rw/elog/0'] }));
    await m.disconnect();
    expect((m as any).unboundResources.size).toBe(0);
  });
});
