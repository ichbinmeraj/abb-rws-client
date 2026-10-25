import { describe, it, expect, afterEach } from 'vitest';
import { RobotManager, type RobotState } from '../src/RobotManager.js';
import { MultiRobotManager } from '../src/MultiRobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import type { AccessEvent } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';
import { RwsError } from '../src/types.js';

/**
 * RobotManager reports what the session holds (RobotState.access) and every
 * change to it (onAccessEvent, and onDidChange), and turns what it observes -
 * an operating-mode change, a failed connection - into a lost hold. A lost
 * hold is never restored behind anyone's back: the next write requests
 * afresh.
 *
 * RWS 2.0 adapters here are real ones whose transport is replaced by a
 * recorder (no network), with the generation set the way connect() sets it.
 * The RWS 1.0-style adapter is a plain object without an access manager of
 * its own, so the manager keeps one over its request and release calls.
 */

const EMPTY_ACCESS = { generation: null, locks: [], watchdog: null, rw8: null };
const STATION_ID = '{AAAAAAAA-0000-4000-8000-000000000001}';
const STATUS = '/rw/controlstation/writeaccess/status';

function statusBody(held: boolean, id: string, name: string): string {
  return `{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"controlstation-write-access-status","_title":"write-access-status",`
    + `"held-by-control-station-Id":"${id}","held-by-control-station-name":"${name}",`
    + `"control-station-write-access-held":"${held}","control-station-external-control-enabled":"true"}]}`;
}

function rws2(generation: 'rw7' | 'rw8', bodies: Record<string, () => string> = {}) {
  const wire: string[] = [];
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p', {
    controlStation: { name: 'Line 3 cell PC', id: STATION_ID, pincode: '4711' },
  });
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  a.req = async (method: string, path: string) => {
    wire.push(`${method} ${path}`);
    return bodies[path]?.() ?? '';
  };
  return { adapter, wire };
}

/** A minimal RWS 1.0-style adapter: enough for the manager's poll, and mastership calls recorded. */
function plainAdapter() {
  const wire: string[] = [];
  const ctl = { opmode: 'AUTO', failPolls: false };
  const read = async <T>(v: T): Promise<T> => {
    if (ctl.failPolls) { throw new RwsError('RWS1 GET /rw/panel/opmode: fetch failed', 'NETWORK_ERROR'); }
    return v;
  };
  const adapter = {
    requestMastership: async (d: string) => { wire.push(`request ${d}`); },
    releaseMastership: async (d: string) => { wire.push(`release ${d}`); },
    setSpeedRatio: async (n: number) => { wire.push(`speed ${n}`); },
    disconnect: async () => { wire.push('logout'); },
    getRapidExecutionInfo: () => read({ state: 'stopped', cycle: 'once' }),
    getControllerState: () => read('motoron'),
    getOperationMode: () => read(ctl.opmode),
    getSpeedRatio: () => read(100),
    getRapidTasks: () => read([{ name: 'T_ROB1', type: 'normal', taskstate: 'started', excstate: 'stopped', active: true, motiontask: true }]),
    getJointPositions: () => read({ rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 0, rax_6: 0 }),
    getCartesianFull: () => read({ x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0 }),
    listModules: () => read([] as string[]),
    getCollisionDetectionState: () => read(null),
    getControllerIdentity: async () => null,
    getSystemInfo: async () => null,
    getEventLog: async () => [],
    listMechunits: async () => ['ROB_1'],
    listAllSignals: async () => [],
  };
  return { adapter, wire, ctl };
}

function manager(adapter: unknown, state: Partial<RobotState> = {}): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
  m.adapter = adapter;
  Object.assign(m._state, { connected: true, opmode: 'AUTO', ctrlstate: 'motoron' }, state);
  return mgr;
}

type Internals = {
  handleSubscriptionEvent(e: { resource: string; value: string }): void;
  fetchAll(generation?: number): Promise<void>;
};
const internals = (mgr: RobotManager): Internals => mgr as unknown as Internals;

function listen(mgr: RobotManager): { events: AccessEvent[]; changes: () => number } {
  const events: AccessEvent[] = [];
  let changes = 0;
  mgr.onAccessEvent(e => events.push(e));
  mgr.onDidChange(() => { changes++; });
  return { events, changes: () => changes };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('RobotState.access: the default literals', () => {
  it('is empty before a connect, after a disconnect, and on a MultiRobotManager with no robot', async () => {
    const mgr = new RobotManager();
    expect(mgr.state.access).toEqual(EMPTY_ACCESS);
    await mgr.disconnect();
    expect(mgr.state.access).toEqual(EMPTY_ACCESS);
    expect(new MultiRobotManager().state.access).toEqual(EMPTY_ACCESS);
  });
});

describe('RobotManager: access events and RobotState.access', () => {
  it('a write reports acquired and released with a time, updates state.access and fires onDidChange', async () => {
    const { adapter } = rws2('rw7');
    const mgr = manager(adapter);
    const { events, changes } = listen(mgr);
    const before = Date.now();
    await mgr.setSpeedRatio(40);
    expect(events.map(e => [e.type, e.lock])).toEqual([['acquired', 'edit'], ['released', 'edit']]);
    for (const e of events) { expect(e.at).toBeGreaterThanOrEqual(before); }
    expect(changes()).toBeGreaterThanOrEqual(2);
    expect(mgr.state.access.generation).toBe('rw7');
    expect(mgr.state.access.locks.map(l => [l.lock, l.state])).toEqual([['edit', 'idle'], ['motion', 'idle']]);
  });

  it('state.access shows a caller\'s hold as held, with its count and since when', async () => {
    const { adapter } = rws2('rw7');
    const mgr = manager(adapter);
    listen(mgr);
    await mgr.requestMastership('rapid');
    const edit = mgr.state.access.locks.find(l => l.lock === 'edit');
    expect(edit).toMatchObject({ state: 'held', count: 1 });
    expect(typeof edit?.since).toBe('number');
    await mgr.releaseMastership('rapid');
    expect(mgr.state.access.locks.find(l => l.lock === 'edit')).toMatchObject({ state: 'idle', count: 0 });
  });

  it('RobotWare 8: state.access names the station, never its id', async () => {
    const { adapter } = rws2('rw8');
    const mgr = manager(adapter);
    listen(mgr);
    await mgr.setSpeedRatio(40);
    expect(mgr.state.access).toMatchObject({
      generation: 'rw8',
      locks: [{ lock: 'writeaccess', state: 'idle', count: 0 }],
      rw8: { registered: true, stationName: 'Line 3 cell PC' },
      watchdog: null,
    });
    expect(JSON.stringify(mgr.state.access)).not.toContain('AAAAAAAA');
  });

  it('MultiRobotManager passes each event on with the robot\'s id', async () => {
    const multi = new MultiRobotManager();
    multi.addRobot({ id: 'cell-A', name: 'A', host: '127.0.0.1', username: 'u', password: 'p' });
    const got: Array<[string, string]> = [];
    multi.onAccessEvent((id, e) => got.push([id, e.type]));
    const { adapter } = rws2('rw7');
    const mgr = multi.entries[0].manager;
    (mgr as unknown as { adapter: unknown }).adapter = adapter;
    await mgr.requestMastership('rapid');
    expect(got).toEqual([['cell-A', 'acquired']]);
  });
});

describe('RobotManager: an operating-mode change loses mastership (RobotWare 6/7)', () => {
  it('seen as a subscription event while a caller holds edit: lost, released once, and the next write requests afresh', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    const { events } = listen(mgr);
    await mgr.requestMastership('rapid');
    internals(mgr).handleSubscriptionEvent({ resource: '/rw/panel/opmode', value: 'MANR' });
    await tick();

    expect(events.filter(e => e.type === 'lost')).toEqual([
      expect.objectContaining({ type: 'lost', lock: 'edit', reason: 'opmode' }),
    ]);
    expect(mgr.state.access.locks.find(l => l.lock === 'edit')).toMatchObject({ state: 'lost', lost: { reason: 'opmode' } });
    expect(wire).toEqual(['POST /rw/mastership/edit/request', 'POST /rw/mastership/edit/release']);

    // The caller's own release has nothing left to end.
    await mgr.releaseMastership('rapid');
    expect(wire).toHaveLength(2);
    await mgr.setSpeedRatio(40);
    expect(wire.slice(2)).toEqual([
      'POST /rw/mastership/edit/request', 'POST /rw/panel/speedratio?action=setspeedratio', 'POST /rw/mastership/edit/release',
    ]);
  });

  it('seen by a poll on an adapter without its own access manager: the same', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const { adapter, wire, ctl } = plainAdapter();
    const mgr = manager(adapter, { opmode: null });
    const { events } = listen(mgr);
    await internals(mgr).fetchAll();            // first reading: not a change
    await mgr.requestMastership('rapid');
    ctl.opmode = 'MANR';
    await internals(mgr).fetchAll();
    await tick();
    expect(events.filter(e => e.type === 'lost')).toEqual([
      expect.objectContaining({ lock: 'rapid', reason: 'opmode' }),
    ]);
    expect(mgr.state.access.generation).toBe('rw6');
    expect(wire).toEqual(['request rapid', 'release rapid']);
  });

  it('with nothing held, a mode change sends nothing and reports nothing', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    const { events } = listen(mgr);
    internals(mgr).handleSubscriptionEvent({ resource: '/rw/panel/opmode', value: 'MANR' });
    await tick();
    expect(events).toEqual([]);
    expect(wire).toEqual([]);
  });

  it('the same mode in another case is not a change', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    const { events } = listen(mgr);
    await mgr.requestMastership('rapid');
    internals(mgr).handleSubscriptionEvent({ resource: '/rw/panel/opmode', value: 'auto' });
    await tick();
    expect(events.some(e => e.type === 'lost')).toBe(false);
    expect(wire).toEqual(['POST /rw/mastership/edit/request']);
  });
});

describe('RobotManager: an operating-mode change on RobotWare 8 is checked with one status read', () => {
  it('the controller still names this station: nothing changes', async () => {
    const { adapter, wire } = rws2('rw8', { [STATUS]: () => statusBody(true, STATION_ID, 'Line 3 cell PC') });
    const mgr = manager(adapter);
    const { events } = listen(mgr);
    await mgr.requestMastership('rapid');
    internals(mgr).handleSubscriptionEvent({ resource: '/rw/panel/opmode', value: 'MANR' });
    await tick(); await tick();
    expect(events.some(e => e.type === 'lost')).toBe(false);
    expect(mgr.state.access.locks[0]).toMatchObject({ state: 'held', count: 1 });
    expect(wire.slice(-1)).toEqual([`GET ${STATUS}`]);
  });

  it('another station holds it now: lost, naming that station (not its id), released once', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const { adapter, wire } = rws2('rw8', { [STATUS]: () => statusBody(true, '{BBBBBBBB-0000-4000-8000-000000000002}', 'Paint line PLC') });
    const mgr = manager(adapter);
    const { events } = listen(mgr);
    await mgr.requestMastership('rapid');
    internals(mgr).handleSubscriptionEvent({ resource: '/rw/panel/opmode', value: 'MANR' });
    await tick(); await tick();
    const lost = events.find(e => e.type === 'lost');
    expect(lost).toMatchObject({ lock: 'writeaccess', reason: 'holder-changed', by: 'Paint line PLC' });
    expect(JSON.stringify(lost)).not.toContain('BBBBBBBB');
    expect(mgr.state.access.locks[0]).toMatchObject({ state: 'lost', lost: { reason: 'holder-changed', by: 'Paint line PLC' } });
    expect(wire.slice(-2)).toEqual([`GET ${STATUS}`, 'POST /rw/controlstation/writeaccess/release']);
  });
});

describe('RobotManager: a jog refused as not held', () => {
  it('RobotWare 7: the jog\'s motion hold is lost, and the next jog requests afresh', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const { adapter, wire } = rws2('rw7');
    const a = adapter as unknown as Record<string, unknown>;
    let refuse = true;
    // The jog pre-flight reads the controller fresh: MANR, motors on, RMMP granted.
    a.getOperationMode = async () => 'MANR';
    a.getControllerState = async () => 'motoron';
    a.getRmmpPrivilege = async () => 'modify';
    a.jog = async () => {
      wire.push('JOG');
      if (refuse) {
        refuse = false;
        throw new RwsError('The user does not have required mastership for the operation', 'MASTERSHIP_REQUIRED', 403, undefined, -1073445859);
      }
    };
    const mgr = manager(adapter, { opmode: 'MANR' });
    const { events } = listen(mgr);
    const JOG = { mode: 'Joint' as const, axes: [1, 0, 0, 0, 0, 0] as [number, number, number, number, number, number], speed: 10 };
    await expect(mgr.jog(JOG)).rejects.toMatchObject({ controllerCode: -1073445859 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'motion', reason: 'unknown' }));
    await mgr.jog(JOG);
    expect(wire).toEqual([
      'POST /rw/mastership/motion/request', 'JOG',
      'POST /rw/mastership/motion/request', 'JOG',
    ]);
    await mgr.disconnect();
  });
});

describe('RobotManager: a failed connection', () => {
  it('after three failed polls a counted hold is reported lost (connection-lost), not released', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const { adapter, wire, ctl } = plainAdapter();
    const mgr = manager(adapter);
    const { events } = listen(mgr);
    await mgr.requestMastership('rapid');
    ctl.failPolls = true;
    await internals(mgr).fetchAll();
    await internals(mgr).fetchAll();
    expect(events.some(e => e.type === 'lost')).toBe(false);
    await internals(mgr).fetchAll();
    expect(events.filter(e => e.type === 'lost')).toEqual([
      expect.objectContaining({ lock: 'rapid', reason: 'connection-lost' }),
    ]);
    expect(events.some(e => e.type === 'released')).toBe(false);
    expect(mgr.state.connected).toBe(false);
    expect(mgr.state.access).toEqual(EMPTY_ACCESS);
    // No release was attempted over the failed connection; the adapter only logged out.
    expect(wire).toEqual(['request rapid', 'logout']);
  });
});
