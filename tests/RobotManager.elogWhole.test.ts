import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RobotManager, keepNewerEventLog, type EventLogShape } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type ElogMessage } from '../src/types.js';

/**
 * The whole read of the domain-0 log (after connect, on the slow poll, and
 * when an elog event's page does not reach the held log). On RWS 2.0 it is
 * the newest 20 pages read newest first and held oldest first: the
 * oldest-first walk stops after 20 pages as well, so past 1000 messages it
 * returned the oldest 1000, the newest never reached state, and every elog
 * event fell back to a 20-page walk.
 */

const msg = (seqnum: number): ElogMessage => ({
  seqnum, code: 10000 + (seqnum % 100), msgtype: 1, timestamp: '2026-09-30 T 16:00:00', srcName: '', title: `m${seqnum}`,
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

const WHOLE_NEWEST = [0, 'en', 20, 'newest'];
const WHOLE_OLDEST = [0, 'en'];
const NEWEST_PAGE = [0, 'en', 1, 'newest'];

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('keepNewerEventLog', () => {
  it('RWS 2.0: keeps held messages newer than the whole read, oldest first', () => {
    const merged = keepNewerEventLog(range(1, 100), range(1, 103), RWS2);
    expect(seqs(merged)).toEqual(seqs(range(1, 103)));
  });

  it('returns the whole read itself when nothing held is newer, when it is empty (a cleared log), or when nothing is held', () => {
    const whole = range(1, 100);
    expect(keepNewerEventLog(whole, range(1, 90), RWS2)).toBe(whole);
    const empty: ElogMessage[] = [];
    expect(keepNewerEventLog(empty, range(1, 90), RWS2)).toBe(empty);
    expect(keepNewerEventLog(whole, [], RWS2)).toBe(whole);
  });

  it('the whole read stays authoritative for its own range: held messages at or below its newest are not brought back', () => {
    const whole = [msg(10), msg(12), msg(20)];
    const merged = keepNewerEventLog(whole, [msg(10), msg(11), msg(12), msg(20), msg(21)], RWS2);
    expect(seqs(merged)).toEqual([10, 12, 20, 21]);
  });

  it('keeps the bound: the newest 1000', () => {
    const merged = keepNewerEventLog(range(1, 1000), range(1, 1002), RWS2);
    expect(merged).toHaveLength(1000);
    expect(merged[0].seqnum).toBe(3);
    expect(merged.at(-1)!.seqnum).toBe(1002);
  });

  it('RWS 1.0: newest first across the 16-bit wrap, the newest 50 kept', () => {
    const whole = [...range(1, 0), ...range(65535, 65488)];          // newest first, 50
    const merged = keepNewerEventLog(whole, [...range(3, 0), ...range(65535, 65490)], RWS1);
    expect(seqs(merged).slice(0, 4)).toEqual([3, 2, 1, 0]);
    expect(merged).toHaveLength(50);
  });

  it('a message without a usable sequence number leaves the whole read as it is', () => {
    const whole = range(1, 100);
    expect(keepNewerEventLog(whole, [...range(1, 101), msg(0)], RWS2)).toBe(whole);
  });
});

type Call = unknown[];

/** A manager on a fake RWS 2.0 adapter (its prototype, so instanceof holds) whose reads the test answers. */
function rig() {
  const mgr = new RobotManager();
  (mgr as any)._state.connected = true;
  const calls: Call[] = [];
  const pending: Array<{ args: Call; resolve: (v: ElogMessage[]) => void; reject: (e: unknown) => void }> = [];
  const adapter = Object.create(RWS2Adapter.prototype);
  adapter.getEventLog = vi.fn((...args: Call) => {
    calls.push(args);
    return new Promise<ElogMessage[]>((resolve, reject) => { pending.push({ args, resolve, reject }); });
  });
  adapter.disconnect = async () => {};
  (mgr as any).adapter = adapter;
  const fire = (): void => (mgr as any).handleSubscriptionEvent({ resource: '/rw/elog/0', value: '', timestamp: new Date(0) });
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  return { mgr, calls, pending, fire, settle };
}

describe('RobotManager: the RWS 2.0 whole read', () => {
  it('reads the newest pages and holds them oldest first', async () => {
    const { mgr, calls, pending } = rig();
    const done = mgr.refreshEventLog();
    expect(calls).toEqual([WHOLE_NEWEST]);
    pending[0].resolve(range(1200, 201));                // newest first, as the walk returns it
    await done;
    expect(mgr.state.eventLog).toHaveLength(1000);
    expect(mgr.state.eventLog[0].seqnum).toBe(201);
    expect(mgr.state.eventLog.at(-1)!.seqnum).toBe(1200);
  });

  it('past 1000 messages an event still costs one page: the held log holds the newest', async () => {
    const { mgr, calls, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(1200, 201));
    await settle();
    fire();
    expect(calls[1]).toEqual(NEWEST_PAGE);
    pending[1].resolve(range(1201, 1152));
    await settle();
    expect(calls).toHaveLength(2);
    expect(mgr.state.eventLog).toHaveLength(1000);
    expect(mgr.state.eventLog.at(-1)!.seqnum).toBe(1201);
    expect(mgr.state.eventLog[0].seqnum).toBe(202);
  });

  it('a controller that refuses the newest-first read gets the oldest-first walk, and events read whole there too', async () => {
    const info = vi.fn();
    setLogger({ info, warn() {}, error() {}, show() {} });
    const { mgr, calls, pending, fire, settle } = rig();
    const done = mgr.refreshEventLog();
    pending[0].reject(new RwsError('RWS2 GET /rw/elog/0: 400', 'UNKNOWN', 400));
    await settle();
    expect(calls[1]).toEqual(WHOLE_OLDEST);
    pending[1].resolve(range(1, 60));
    await done;
    expect(mgr.state.eventLog).toHaveLength(60);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('refused the newest-first event-log read'));
    fire();
    expect(calls[2]).toEqual(WHOLE_OLDEST);
  });

  it('a whole read that does not get through is not taken for a refusal', async () => {
    const { mgr, calls, pending } = rig();
    const done = mgr.refreshEventLog();
    pending[0].reject(new RwsError('RWS2 timeout', 'NETWORK_ERROR'));
    await done;
    expect(calls).toEqual([WHOLE_NEWEST]);
    expect(mgr.state.eventLog).toEqual([]);
    expect((mgr as any).elogFullReadGen).toBeNull();
  });

  it('a whole read that lands after a page merge keeps the messages the merge added', async () => {
    const { mgr, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(100, 1));
    await settle();
    // A slow-poll style whole read is sent, then an event's page lands first.
    const slow = mgr.refreshEventLog();
    fire();
    pending[2].resolve(range(103, 54));
    await settle();
    expect(mgr.state.eventLog.at(-1)!.seqnum).toBe(103);
    pending[1].resolve(range(101, 1));                   // served before 102 and 103 were logged
    await slow;
    expect(seqs(mgr.state.eventLog)).toEqual(seqs(range(1, 103)));
  });

  it('a whole read with no write in between replaces the log as it is', async () => {
    const { mgr, pending, fire, settle } = rig();
    fire();
    pending[0].resolve(range(100, 1));
    await settle();
    const slow = mgr.refreshEventLog();
    pending[1].resolve(range(100, 41));                  // fewer messages now (cleared elsewhere, say)
    await slow;
    expect(seqs(mgr.state.eventLog)).toEqual(seqs(range(41, 100)));
  });

  it('refreshEventLog drops a read that lands after a reconnect', async () => {
    const { mgr, pending } = rig();
    const done = mgr.refreshEventLog();
    (mgr as any).pollGeneration++;
    pending[0].resolve(range(60, 1));
    await done;
    expect(mgr.state.eventLog).toEqual([]);
    expect((mgr as any).elogFullReadGen).toBeNull();
  });
});

// ─── Over a mock controller: 1200 messages in domain 0 ─────────────────────

function halList(seqnums: number[]): string {
  const items = seqnums.map(n => `{"_links":{"self":{"href":"0/${n}?lang=en"}},"_type":"elog-message-li","_title":"/rw/elog/0/${n}",`
    + `"msgtype":"1","code":"10015","tstamp":"2026-09-30 T 16:00:00","title":"Manual mode selected","argc":"0"}`);
  return `{"_links":{"base":{"href":"https://x/rw/elog/"},"self":{"href":"0?lang=en"}},"_embedded":{"resources":[${items.join(',')}]}}`;
}

describe('RobotManager + RWS 2.0 client over a mock controller holding 1200 messages', () => {
  it('holds the newest 1000, and an event costs one request', async () => {
    const wire: string[] = [];
    let newest = 1200;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const url = req.url ?? '';
        wire.push(url);
        // v=2.1 newest first: `order=lifo` is the newest 50, `elogseqnum=N`
        // the newest 50 at or below N. Anything else is refused, so an
        // oldest-first walk would fail this test.
        const below = /elogseqnum=(\d+)/.exec(url);
        if (!/order=lifo/.test(url) && !below) { res.writeHead(400); res.end(); return; }
        const top = below ? Math.min(Number(below[1]), newest) : newest;
        const list: number[] = [];
        for (let n = top; n >= 1 && list.length < 50; n--) { list.push(n); }
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.1' });
        res.end(halList(list));
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const mgr = new RobotManager();
      (mgr as any).adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
      (mgr as any)._state.connected = true;
      await mgr.refreshEventLog();
      // Count the event-log reads only: under a loaded test run a stray request
      // from outside this test can reach this server, and it is no elog read.
      const elogReads = (): string[] => wire.filter(u => u.startsWith('/rw/elog/'));
      expect(elogReads()).toHaveLength(20);
      expect(mgr.state.eventLog).toHaveLength(1000);
      expect(mgr.state.eventLog[0].seqnum).toBe(201);
      expect(mgr.state.eventLog.at(-1)!.seqnum).toBe(1200);
      wire.length = 0;

      newest = 1201;
      (mgr as any).handleSubscriptionEvent({ resource: '/rw/elog/0', value: '', timestamp: new Date(0) });
      await vi.waitFor(() => expect(mgr.state.eventLog.at(-1)!.seqnum).toBe(1201), { timeout: 5000 });
      expect(elogReads()).toEqual(['/rw/elog/0?lang=en&order=lifo']);
      expect(mgr.state.eventLog).toHaveLength(1000);
      expect(mgr.state.eventLog[0].seqnum).toBe(202);
    } finally { server.close(); }
  });
});
