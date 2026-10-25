import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RobotManager, mergeEventLogPage, compareElogSeqnum, type EventLogShape } from '../src/RobotManager.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type ElogMessage } from '../src/types.js';

/**
 * An elog subscription event reads only the newest page of the domain-0 log
 * and merges it into the manager's log by sequence number. Before, every
 * event re-read the whole log oldest first: on RW 7.21.4 with 548 messages
 * that was 12 pages and 1.6-2.1 s, and a speed-ratio event arriving during it
 * was 1.1-1.5 s late (functional suite, 10-subscriptions, 2026-09-30). The
 * whole read stays for the first read after connect and the slow poll.
 */

const msg = (seqnum: number, code = 10000 + (seqnum % 100)): ElogMessage => ({
  seqnum, code, msgtype: 1, timestamp: '2026-09-30 T 16:00:00', srcName: '', title: `m${seqnum}`,
  desc: '', causes: '', consequences: '', actions: '', args: [],
});
const range = (from: number, to: number): ElogMessage[] => {
  const out: ElogMessage[] = [];
  for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? 1 : -1) { out.push(msg(n)); }
  return out;
};
const seqs = (log: readonly ElogMessage[]): number[] => log.map(m => m.seqnum);

const RWS2: EventLogShape = { wrap: false, newestFirst: false, limit: 1000, pageSize: 50 };
const RWS1: EventLogShape = { wrap: true, newestFirst: true, limit: 50, pageSize: 50 };

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('compareElogSeqnum', () => {
  it('compares plainly without wrap', () => {
    expect(compareElogSeqnum(5, 3, false)).toBeGreaterThan(0);
    expect(compareElogSeqnum(3, 5, false)).toBeLessThan(0);
    expect(compareElogSeqnum(65535, 2, false)).toBeGreaterThan(0);
  });
  it('RWS 1.0: 16-bit serial numbers, so 2 follows 65,534 and 0 follows 65,535', () => {
    expect(compareElogSeqnum(2, 65534, true)).toBe(1);
    expect(compareElogSeqnum(65534, 2, true)).toBe(-1);
    expect(compareElogSeqnum(0, 65535, true)).toBe(1);
    expect(compareElogSeqnum(7, 7, true)).toBe(0);
    expect(compareElogSeqnum(40000, 100, true)).toBe(-1);   // more than half the span ahead: the older one
  });
});

describe('mergeEventLogPage: RWS 2.0 (oldest first, up to 1000)', () => {
  it('merges a newest-first page into the held log, oldest first, the page authoritative for its range', () => {
    const log = range(1, 548);
    const page = range(551, 502);                       // newest first, as v=2.1 lists it
    const merged = mergeEventLogPage(log, page, RWS2)!;
    expect(merged).not.toBeNull();
    expect(seqs(merged)).toEqual([...seqs(range(1, 548)), 549, 550, 551]);
    expect(merged.at(-1)!.title).toBe('m551');
  });

  it('returns the held array itself when the page adds nothing', () => {
    const log = range(1, 548);
    expect(mergeEventLogPage(log, range(548, 499), RWS2)).toBe(log);
  });

  it('keeps the newest 1000 when the merge passes the bound', () => {
    const log = range(1, 1000);
    const merged = mergeEventLogPage(log, range(1003, 954), RWS2)!;
    expect(merged).toHaveLength(1000);
    expect(merged[0].seqnum).toBe(4);
    expect(merged.at(-1)!.seqnum).toBe(1003);
  });

  it('a page that does not reach back to the held log (more new messages than one page) cannot be merged', () => {
    expect(mergeEventLogPage(range(1, 548), range(700, 651), RWS2)).toBeNull();
  });

  it('the page is authoritative for everything from its oldest on: a log renumbered from 1 replaces the held one', () => {
    const merged = mergeEventLogPage(range(1, 548), range(12, 1), RWS2)!;
    expect(seqs(merged)).toEqual(seqs(range(1, 12)));
  });

  it('a shorter page than expected (another page size) still merges by overlap and never shrinks the log', () => {
    const merged = mergeEventLogPage(range(1, 548), range(549, 530), RWS2)!;
    expect(merged).toHaveLength(549);
  });

  it('onto an empty log (cleared by this manager): a short page is everything since, a full page cannot be merged', () => {
    expect(seqs(mergeEventLogPage([], range(603, 601), RWS2)!)).toEqual([601, 602, 603]);
    expect(mergeEventLogPage([], range(100, 51), RWS2)).toBeNull();
  });

  it('an empty page, or a message without a sequence number, cannot be merged', () => {
    expect(mergeEventLogPage(range(1, 548), [], RWS2)).toBeNull();
    const page = range(551, 502);
    page[3] = { ...page[3], seqnum: 0 };                 // the parser's value for a missing one
    expect(mergeEventLogPage(range(1, 548), page, RWS2)).toBeNull();
  });

  it('a log cleared by another client, whose numbers go on, cannot be merged: the whole read replaces it', () => {
    expect(mergeEventLogPage(range(1, 548), range(560, 558), RWS2)).toBeNull();
  });

  it('seqnum gaps (numbers held by other domains) merge by number, not by position', () => {
    const log = [msg(10), msg(12), msg(15), ...range(20, 66)];
    const page = [msg(80), msg(77), ...range(66, 19)];
    expect(page).toHaveLength(50);
    const merged = mergeEventLogPage(log, page, RWS2)!;
    expect(seqs(merged).slice(-3)).toEqual([66, 77, 80]);
    expect(seqs(merged).slice(0, 4)).toEqual([10, 12, 15, 19]);
  });
});

describe('mergeEventLogPage: RWS 1.0 (newest first, one page of 50, wrap-aware)', () => {
  it('orders across the 16-bit wrap newest first, and keeps the newest 50', () => {
    const held = [...range(13, 0), ...range(65535, 65500)];                     // newest first: 13..0, 65535..65500
    expect(held).toHaveLength(50);
    // Listed out of order on purpose: the merge orders by wrap-aware number.
    const page = [...range(65502, 65535), ...range(0, 15)];                    // two new: 14, 15
    const merged = mergeEventLogPage(held, page, RWS1)!;
    expect(seqs(merged).slice(0, 4)).toEqual([15, 14, 13, 12]);
    expect(seqs(merged).slice(15, 18)).toEqual([0, 65535, 65534]);
    expect(merged).toHaveLength(50);
    expect(seqs(merged).at(-1)).toBe(65502);
  });

  it('keeps the held array when a new listing holds the same messages', () => {
    const held = range(100, 51);
    expect(mergeEventLogPage(held, range(100, 51), RWS1)).toBe(held);
  });
});

// ─── RobotManager's event path ──────────────────────────────────────────────

type Call = unknown[];

/** A manager on a fake RWS 2.0 adapter (its prototype, so instanceof holds) whose reads the test answers. */
function rig(kind: 'rws2' | 'rws1' = 'rws2') {
  const mgr = new RobotManager();
  (mgr as any)._state.connected = true;
  const calls: Call[] = [];
  const pending: Array<{ args: Call; resolve: (v: ElogMessage[]) => void; reject: (e: unknown) => void }> = [];
  const adapter = Object.create((kind === 'rws2' ? RWS2Adapter : RWS1Adapter).prototype);
  adapter.getEventLog = vi.fn((...args: Call) => {
    calls.push(args);
    return new Promise<ElogMessage[]>((resolve, reject) => { pending.push({ args, resolve, reject }); });
  });
  adapter.disconnect = async () => {};
  (mgr as any).adapter = adapter;
  let notified = 0;
  mgr.onDidChange(() => { notified++; });
  const fire = (): void => (mgr as any).handleSubscriptionEvent({ resource: '/rw/elog/0', value: '', timestamp: new Date(0) });
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  return { mgr, calls, pending, fire, settle, notifiedCount: () => notified };
}

/** RWS 2.0 whole read: the newest 20 pages, newest first (then put oldest first). */
const WHOLE_NEWEST = [0, 'en', 20, 'newest'];
/** RWS 1.0 whole read, and the RWS 2.0 oldest-first walk after a refused newest-first read. */
const WHOLE = [0, 'en'];
const NEWEST_PAGE = [0, 'en', 1, 'newest'];

describe('RobotManager: elog events on RWS 2.0', () => {
  it('reads the whole log until a whole read has landed, then only the newest page, merged in oldest first', async () => {
    const { mgr, calls, pending, fire, settle } = rig();
    fire();
    expect(calls).toEqual([WHOLE_NEWEST]);                      // first read after connect: whole
    pending[0].resolve(range(1, 548));
    await settle();
    expect(mgr.state.eventLog).toHaveLength(548);

    fire();
    expect(calls[1]).toEqual(NEWEST_PAGE);
    pending[1].resolve(range(549, 500));
    await settle();
    expect(calls).toHaveLength(2);                       // one request for the event, no walk
    expect(seqs(mgr.state.eventLog).slice(-2)).toEqual([548, 549]);
    expect(mgr.state.eventLog).toHaveLength(549);
    expect(mgr.state.eventLog[0].seqnum).toBe(1);
  });

  it('the slow poll\'s (or refreshEventLog\'s) whole read is the base too', async () => {
    const { mgr, calls, pending, fire, settle } = rig();
    const refresh = mgr.refreshEventLog();
    pending[0].resolve(range(1, 60));
    await refresh;
    fire();
    expect(calls[1]).toEqual(NEWEST_PAGE);
    pending[1].resolve(range(61, 12));
    await settle();
    expect(seqs(mgr.state.eventLog)).toEqual(seqs(range(1, 61)));
  });

  it('a page that does not reach the held log falls back to one whole read', async () => {
    const { mgr, calls, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(1, 100));
    await settle();
    fire();
    pending[1].resolve(range(300, 251));
    await settle();
    expect(calls[2]).toEqual(WHOLE_NEWEST);
    pending[2].resolve(range(1, 300));
    await settle();
    expect(mgr.state.eventLog).toHaveLength(300);
    expect(calls).toHaveLength(3);
  });

  it('a controller that refuses the newest-first read gets whole reads for the rest of the connection', async () => {
    const { mgr, calls, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(1, 100));
    await settle();
    fire();
    pending[1].reject(new RwsError('RWS2 GET /rw/elog/0: 406', 'UNKNOWN', 406));
    await settle();
    expect(calls[2]).toEqual(WHOLE);
    pending[2].resolve(range(1, 101));
    await settle();
    expect(mgr.state.eventLog).toHaveLength(101);
    fire();
    expect(calls[3]).toEqual(WHOLE);
  });

  it('a page read that does not get through fails that read only; the queued follow-up still runs', async () => {
    const { mgr, calls, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(1, 100));
    await settle();
    fire(); fire();                                      // one page read in flight, one queued
    pending[1].reject(new RwsError('RWS2 timeout', 'NETWORK_ERROR'));
    await settle();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(NEWEST_PAGE);               // no whole read for a network failure
    expect(mgr.state.eventLog).toHaveLength(100);
    pending[2].resolve(range(101, 52));
    await settle();
    expect(mgr.state.eventLog).toHaveLength(101);
  });

  it('a page that adds nothing keeps the same array and does not notify', async () => {
    const { mgr, pending, fire, settle, notifiedCount } = rig();
    fire();
    pending[0].resolve(range(1, 100));
    await settle();
    const before = mgr.state.eventLog;
    const n = notifiedCount();
    fire();
    pending[1].resolve(range(100, 51));
    await settle();
    expect(mgr.state.eventLog).toBe(before);
    expect(notifiedCount()).toBe(n);
  });

  it('keeps the poll-generation pin: a page that lands after a reconnect is dropped, and the next connection starts with a whole read', async () => {
    const { mgr, calls, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(1, 100));
    await settle();
    fire();
    (mgr as any).pollGeneration++;                       // reconnected, still connected
    (mgr as any)._state.eventLog = [];
    pending[1].resolve(range(101, 52));
    await settle();
    expect(mgr.state.eventLog).toEqual([]);
    fire();
    expect(calls.at(-1)).toEqual(WHOLE_NEWEST);
  });

  it('merges into the log as it is when the page lands, not as it was when the event came', async () => {
    const { mgr, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(1, 100));
    await settle();
    fire();
    // A whole read (the slow poll) lands while the page is in flight.
    (mgr as any)._state.eventLog = range(1, 102);
    pending[1].resolve(range(103, 54));
    await settle();
    expect(seqs(mgr.state.eventLog)).toEqual(seqs(range(1, 103)));
  });

  it('a burst of events still costs one read in flight plus one more', async () => {
    const { calls, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(1, 100));
    await settle();
    for (let i = 0; i < 5; i++) { fire(); }
    expect(calls).toHaveLength(2);
    pending[1].resolve(range(101, 52));
    await settle();
    expect(calls).toHaveLength(3);
    pending[2].resolve(range(102, 53));
    await settle();
    expect(calls).toHaveLength(3);
  });
});

describe('RobotManager: the poll\'s whole read and the event path', () => {
  function pollRig(eventLog: () => Promise<ElogMessage[]>) {
    const mgr = new RobotManager();
    (mgr as any)._state.connected = true;
    const calls: Call[] = [];
    const adapter = Object.create(RWS2Adapter.prototype);
    Object.assign(adapter, {
      getRapidExecutionInfo: async () => ({ state: 'stopped', cycle: 'once' }),
      getControllerState: async () => 'motoroff',
      getOperationMode: async () => 'AUTO',
      getSpeedRatio: async () => 100,
      getRapidTasks: async () => [{ name: 'T_ROB1', type: 'normal', taskstate: 'initiated', excstate: 'stopped', active: true, motiontask: true }],
      getJointPositions: async () => ({ rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 0, rax_6: 0 }),
      getCartesianFull: async () => ({ x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0 }),
      listModules: async () => ['BASE'],
      getCollisionDetectionState: async () => null,
      getControllerIdentity: async () => ({ name: 'vc', id: 'x', type: 'Virtual Controller' }),
      getSystemInfo: async () => ({ name: 'vc', rwVersion: '7.21.4+417', sysid: '{A}' }),
      listMechunits: async () => ['ROB_1'],
      listAllSignals: async () => [],
      getEventLog: vi.fn((...args: Call) => { calls.push(args); return args[2] === 1 ? Promise.resolve(range(61, 12)) : eventLog(); }),
      disconnect: async () => {},
    });
    (mgr as any).adapter = adapter;
    const fire = (): void => (mgr as any).handleSubscriptionEvent({ resource: '/rw/elog/0', value: '', timestamp: new Date(0) });
    return { mgr, calls, fire };
  }

  it('a slow poll\'s whole read is the base: the next event reads the newest page', async () => {
    const { mgr, calls, fire } = pollRig(async () => range(1, 60));
    await (mgr as any).fetchAll((mgr as any).pollGeneration);
    expect(calls).toEqual([WHOLE_NEWEST]);
    fire();
    await vi.waitFor(() => expect(mgr.state.eventLog).toHaveLength(61));
    expect(calls).toEqual([WHOLE_NEWEST, NEWEST_PAGE]);
  });

  it('a slow poll whose whole read failed leaves no base: the next event reads the whole log', async () => {
    const warn = vi.fn();
    setLogger({ info() {}, warn, error() {}, show() {} });
    let fail = false;
    const { mgr, calls, fire } = pollRig(async () => { if (fail) { throw new RwsError('503', 'CONTROLLER_BUSY', 503); } return range(1, 60); });
    await (mgr as any).fetchAll((mgr as any).pollGeneration);
    fail = true;
    (mgr as any).fetchCount = 29;                        // the next poll is a slow one
    await (mgr as any).fetchAll((mgr as any).pollGeneration);
    expect(mgr.state.eventLog).toEqual([]);              // emptied, as before
    fail = false;
    fire();
    await vi.waitFor(() => expect(mgr.state.eventLog).toHaveLength(60));
    expect(calls).toEqual([WHOLE_NEWEST, WHOLE_NEWEST, WHOLE_NEWEST]);
  });
});

describe('RobotManager: elog events on RWS 1.0', () => {
  it('reads its one-page listing (already the newest 50) and keeps it newest first', async () => {
    const { mgr, calls, pending, fire, settle } = rig('rws1');
    fire();
    pending[0].resolve(range(100, 51));
    await settle();
    fire();
    pending[1].resolve(range(102, 53));
    await settle();
    // One page asked for by name: since 1.5.0 RWS1Adapter.getEventLog reads every page by default.
    const RWS1_PAGE = [0, 'en', 1];
    expect(calls).toEqual([RWS1_PAGE, RWS1_PAGE]);
    expect(seqs(mgr.state.eventLog)).toEqual(seqs(range(102, 53)));
  });

  it('holds exactly the listing\'s messages, newest first across the 16-bit wrap, and keeps the array when nothing changed', async () => {
    const { mgr, pending, fire, settle, notifiedCount } = rig('rws1');
    fire();
    pending[0].resolve([...range(65535, 65520), ...range(0, 3)]);   // listed out of order
    await settle();
    expect(seqs(mgr.state.eventLog)).toEqual([...seqs(range(3, 0)), ...seqs(range(65535, 65520))]);
    const before = mgr.state.eventLog;
    const n = notifiedCount();
    fire();
    pending[1].resolve([...range(3, 0), ...range(65535, 65520)]);
    await settle();
    expect(mgr.state.eventLog).toBe(before);
    expect(notifiedCount()).toBe(n);
    // A shorter listing (fewer messages on the controller): nothing older is kept.
    fire();
    pending[2].resolve(range(5, 0));
    await settle();
    expect(seqs(mgr.state.eventLog)).toEqual([5, 4, 3, 2, 1, 0]);
  });
});

// ─── End to end: one RWS 2.0 request per event ──────────────────────────────

function halList(seqnums: number[]): string {
  const items = seqnums.map(n => `{"_links":{"self":{"href":"0/${n}?lang=en"}},"_type":"elog-message-li","_title":"/rw/elog/0/${n}",`
    + `"msgtype":"1","code":"10015","tstamp":"2026-09-30 T 16:00:00","title":"Manual mode selected","argc":"0"}`);
  return `{"_links":{"base":{"href":"https://x/rw/elog/"},"self":{"href":"0?lang=en"}},"_embedded":{"resources":[${items.join(',')}]}}`;
}

describe('RobotManager + RWS 2.0 client over a mock controller', () => {
  it('after the whole read, an event costs one newest-first request (v=2.1, order=lifo)', async () => {
    const wire: Array<{ url: string; accept: string }> = [];
    let newest = 60;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        wire.push({ url: req.url ?? '', accept: String(req.headers.accept ?? '') });
        const lifo = /order=lifo/.test(req.url ?? '');
        const all = Array.from({ length: newest }, (_, i) => i + 1);
        res.writeHead(200, { 'Content-Type': `application/hal+json;v=${lifo ? '2.1' : '2.0'}` });
        res.end(halList(lifo ? all.reverse().slice(0, 50) : all));
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const mgr = new RobotManager();
      (mgr as any).adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
      (mgr as any)._state.connected = true;
      await mgr.refreshEventLog();
      expect(mgr.state.eventLog).toHaveLength(60);
      wire.length = 0;

      newest = 61;
      (mgr as any).handleSubscriptionEvent({ resource: '/rw/elog/0', value: '', timestamp: new Date(0) });
      await vi.waitFor(() => expect(mgr.state.eventLog).toHaveLength(61), { timeout: 5000 });
      expect(wire).toHaveLength(1);
      expect(wire[0].url).toBe('/rw/elog/0?lang=en&order=lifo');
      expect(wire[0].accept).toContain('application/hal+json;v=2.1');
      expect(seqs(mgr.state.eventLog).slice(0, 2)).toEqual([1, 2]);
      expect(mgr.state.eventLog.at(-1)!.seqnum).toBe(61);
    } finally { server.close(); }
  });
});
