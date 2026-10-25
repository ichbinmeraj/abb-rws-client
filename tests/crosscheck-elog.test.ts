import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseElogMessages, elogMsgtype } from '../src/ResponseParser.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsClient } from '../src/RwsClient.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RobotManager } from '../src/RobotManager.js';

// Event-log parsing and refresh, checked against ABB's RobotWare release
// notes (2026-09-29): entity decoding order, the msgtype default on both
// protocols, and the coalesced re-read on elog subscription events.

const elogLi = (spans: string, seq = 7): string =>
  `<ul><li class="elog-message-li" title="/rw/elog/0/${seq}"><a href="0/${seq}?lang=en" rel="self"></a>${spans}</li></ul>`;

// ─── 1. decodeEntities: &amp; last, &apos; decoded ──────────────────────────

describe('event-log entity decoding', () => {
  it('leaves a plain string untouched', () => {
    const [m] = parseElogMessages(elogLi('<span class="msgtype">1</span><span class="code">10015</span><span class="title">Program started</span>'));
    expect(m.title).toBe('Program started');
  });

  it('decodes &amp; LAST so a doubly-escaped &amp;lt; stays the literal text "&lt;"', () => {
    // Before: &amp; was decoded first, so "&amp;lt;" became "&lt;" and then "<".
    const [m] = parseElogMessages(elogLi('<span class="code">1</span><span class="title">a &amp;lt; b</span><span class="desc">x &lt; y &amp; z &gt; w</span>'));
    expect(m.title).toBe('a &lt; b');
    expect(m.desc).toBe('x < y & z > w');
  });

  it('decodes the XML &apos; as well as the HTML &#39;', () => {
    const [m] = parseElogMessages(elogLi('<span class="code">1</span><span class="title">it&apos;s &#39;quoted&#39; &quot;here&quot;</span>'));
    expect(m.title).toBe(`it's 'quoted' "here"`);
  });
});

// ─── 2. msgtype: missing or mangled → 0 = unknown, never 1 = info ───────────

describe('event-log msgtype default', () => {
  it('elogMsgtype keeps 1/2/3 and maps absent, empty or non-numeric to 0', () => {
    expect(elogMsgtype('1')).toBe(1);
    expect(elogMsgtype('2')).toBe(2);
    expect(elogMsgtype(3)).toBe(3);
    expect(elogMsgtype(undefined)).toBe(0);
    expect(elogMsgtype(null)).toBe(0);
    expect(elogMsgtype('')).toBe(0);
    expect(elogMsgtype('warning')).toBe(0);
    expect(elogMsgtype('-1')).toBe(0);
    expect(elogMsgtype('1.5')).toBe(0);
    // parseInt would have read "3abc" as 3; a mangled field is unknown, not error.
    expect(elogMsgtype('3abc')).toBe(0);
  });

  it('RWS 1.0 XHTML listing: a message without a msgtype span is unknown (0), not info', () => {
    const [m] = parseElogMessages(elogLi('<span class="code">10014</span><span class="title">System failure state</span>'));
    expect(m.msgtype).toBe(0);
    expect(m.code).toBe(10014);
  });

  it('RWS 1.0 XHTML listing: a non-numeric msgtype is unknown (0); a real one is kept', () => {
    const xml = elogLi('<span class="msgtype">error</span><span class="code">10014</span>', 2)
      + elogLi('<span class="msgtype">3</span><span class="code">10014</span>', 3);
    const msgs = parseElogMessages(xml);
    expect(msgs.map(m => m.msgtype)).toEqual([0, 3]);
  });

  it('RWS 1.0 ?json=1 Message Get: a missing msgtype is unknown (0)', async () => {
    const body = JSON.stringify({ _embedded: { _state: [
      { _type: 'elog-message', _title: '/rw/elog/0/5', code: '10014', tstamp: '2026-09-29 T 10:00:00', title: 'System failure state' },
    ] } });
    const fake = {
      request: async (_m: string, _url: string) => ({ status: 200, body }),
    };
    const adapter = new RWS1Adapter(fake as unknown as RwsClient);
    const m = await adapter.getEventLogMessage(0, 5);
    expect(m?.code).toBe(10014);
    expect(m?.msgtype).toBe(0);
  });

  it('RWS 2.0 hal+json: listing and both single-message reads give 0 when msgtype is absent or mangled', async () => {
    const list = '{"_links":{"base":{"href":"https://x/rw/elog/"},"self":{"href":"0?lang=en"}},"_embedded":{"resources":['
      + '{"_links":{"self":{"href":"0/1?lang=en"}},"_type":"elog-message-li","_title":"/rw/elog/0/1","code":"10046","tstamp":"2026-07-08 T 18:04:04","title":"System reset","argc":"0"},'
      + '{"_links":{"self":{"href":"0/2?lang=en"}},"_type":"elog-message-li","_title":"/rw/elog/0/2","msgtype":"x","code":"10014","tstamp":"2026-07-08 T 18:04:05","title":"System failure state","argc":"0"},'
      + '{"_links":{"self":{"href":"0/3?lang=en"}},"_type":"elog-message-li","_title":"/rw/elog/0/3","msgtype":"2","code":"10014","tstamp":"2026-07-08 T 18:04:06","title":"Warning","argc":"0"}'
      + ']}}';
    const single = '{"_links":{"base":{"href":"https://x/"}},"status":{"code":294912},"state":[{"_type":"elog-message","_title":"/rw/elog/0/1","code":"10046","tstamp":"2026-08-04 T 03:26:39","title":"System reset","desc":"Loading done"}]}';
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(/\/rw\/elog\/0\?/.test(req.url ?? '') ? list : single);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const log = await client.getEventLog(0, 'en', 1);
      expect(log.map(m => [m.seqnum, m.msgtype])).toEqual([[1, 0], [2, 0], [3, 2]]);
      expect((await client.getEventLogMessage(0, 1))?.msgtype).toBe(0);
      expect((await client.getEventLogMessageBySeqnum(1))?.msgtype).toBe(0);
    } finally { server.close(); }
  });
});

// ─── 4. RobotManager: coalesced elog re-read ────────────────────────────────

describe('RobotManager elog-event re-read coalescing', () => {
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

  function rig() {
    const mgr = new RobotManager();
    (mgr as any)._state.connected = true;
    const pending: Array<{ resolve: (v: unknown[]) => void; reject: (e: unknown) => void }> = [];
    const getEventLog = vi.fn(() => new Promise<unknown[]>((resolve, reject) => { pending.push({ resolve, reject }); }));
    (mgr as any).adapter = { getEventLog, disconnect: async () => {} };
    const fire = (): void => (mgr as any).handleSubscriptionEvent({ resource: '/rw/elog/0', value: '', timestamp: new Date(0) });
    return { mgr, pending, getEventLog, fire };
  }

  it('a read that outlives disconnectInternal() neither parks the next connection\'s reads nor hands them a queued follow-up', async () => {
    const { mgr, pending, getEventLog, fire } = rig();
    fire(); fire();                                     // one in flight, one queued
    expect(getEventLog).toHaveBeenCalledTimes(1);

    await (mgr as any).disconnectInternal();            // the real teardown, flags cleared
    expect((mgr as any).elogRefreshInFlight).toBeNull();
    expect((mgr as any).elogRefreshQueued).toBe(false);

    // Reconnected (a new poll generation, a new adapter) while the old read is still pending.
    const next: Array<{ resolve: (v: unknown[]) => void }> = [];
    const getEventLog2 = vi.fn(() => new Promise<unknown[]>(resolve => { next.push({ resolve }); }));
    (mgr as any).adapter = { getEventLog: getEventLog2, disconnect: async () => {} };
    (mgr as any).pollGeneration++;
    (mgr as any)._state.connected = true;

    fire();                                             // not parked behind the old read
    expect(getEventLog2).toHaveBeenCalledTimes(1);

    // The old read settles late: its log is dropped, and it must not clear the
    // NEW read's in-flight flag (a further event stays queued, not a parallel read).
    pending[0].resolve([{ seqnum: 99, code: 1, msgtype: 3 }]);
    await settle();
    expect((mgr as any)._state.eventLog).toEqual([]);
    fire();
    expect(getEventLog2).toHaveBeenCalledTimes(1);
    expect((mgr as any).elogRefreshQueued).toBe(true);

    const fresh = [{ seqnum: 1, code: 2, msgtype: 1 }];
    next[0].resolve(fresh);
    await settle();
    expect((mgr as any)._state.eventLog).toEqual(fresh);
    expect(getEventLog2).toHaveBeenCalledTimes(2);      // the one queued follow-up, from this connection's events
    next[1].resolve(fresh);
    await settle();
    expect(getEventLog2).toHaveBeenCalledTimes(2);
    expect(getEventLog).toHaveBeenCalledTimes(1);       // the old adapter was never read again
  });

  it('a read that settles while disconnectInternal() is still awaiting its teardown starts no stray follow-up on the dying adapter', async () => {
    const { mgr, pending, getEventLog, fire } = rig();
    fire(); fire();                                     // one in flight, one queued
    expect(getEventLog).toHaveBeenCalledTimes(1);

    // Start the real teardown but do not await it: it bumps pollGeneration
    // synchronously, then awaits mastership/RMMP release and the unsubscribe
    // (a DELETE on the wire, so it takes real time here). The in-flight read
    // settles inside that window, with a follow-up queued.
    let unsubscribed = false;
    (mgr as any).unsubscribeFn = (): Promise<void> => new Promise(r => setTimeout(() => { unsubscribed = true; r(); }, 20));
    const teardown: Promise<void> = (mgr as any).disconnectInternal();
    pending[0].resolve([{ seqnum: 9, code: 1, msgtype: 1 }]);
    await settle();
    expect(unsubscribed).toBe(false);                   // the read settled while the teardown was still awaiting
    await teardown;
    await settle();

    // The flags were cleared with the generation bump, so the settling read
    // saw itself superseded: no second GET on the adapter being torn down,
    // and nothing queued or in flight is carried into the next connection.
    expect(getEventLog).toHaveBeenCalledTimes(1);
    expect((mgr as any)._state.eventLog).toEqual([]);
    expect((mgr as any).elogRefreshInFlight).toBeNull();
    expect((mgr as any).elogRefreshQueued).toBe(false);
  });

  it('an adapter whose getEventLog throws synchronously does not silence later re-reads', async () => {
    const mgr = new RobotManager();
    (mgr as any)._state.connected = true;
    const getEventLog = vi.fn(() => { throw new Error('not async'); });
    (mgr as any).adapter = { getEventLog };
    const fire = (): void => (mgr as any).handleSubscriptionEvent({ resource: '/rw/elog/0', value: '', timestamp: new Date(0) });
    fire();
    await settle();
    expect((mgr as any).elogRefreshInFlight).toBeNull();
    fire();
    await settle();
    expect(getEventLog).toHaveBeenCalledTimes(2);
  });

  it('a burst of 5 events costs one read in flight plus exactly one more, never five', async () => {
    const { mgr, pending, getEventLog, fire } = rig();
    for (let i = 0; i < 5; i++) { fire(); }
    expect(getEventLog).toHaveBeenCalledTimes(1);

    const first = [{ seqnum: 1, code: 10015, msgtype: 1 }];
    pending[0].resolve(first);
    await settle();
    expect((mgr as any)._state.eventLog).toEqual(first);
    // The four events that arrived during the read collapsed into one follow-up.
    expect(getEventLog).toHaveBeenCalledTimes(2);

    const second = [{ seqnum: 1, code: 10015, msgtype: 1 }, { seqnum: 2, code: 10016, msgtype: 2 }];
    pending[1].resolve(second);
    await settle();
    expect((mgr as any)._state.eventLog).toEqual(second);
    // Nothing was queued behind the follow-up, so it stops there.
    expect(getEventLog).toHaveBeenCalledTimes(2);

    // Quiet again: the next event starts a fresh read.
    fire();
    expect(getEventLog).toHaveBeenCalledTimes(3);
  });

  it('a failed read still clears the in-flight flag and runs the queued follow-up', async () => {
    const { pending, getEventLog, fire } = rig();
    fire(); fire(); fire();
    pending[0].reject(new Error('503'));
    await settle();
    expect(getEventLog).toHaveBeenCalledTimes(2);
    pending[1].resolve([]);
    await settle();
    expect(getEventLog).toHaveBeenCalledTimes(2);
  });

  it('keeps the poll-generation pin: a read from before a disconnect is dropped, and so is its queued follow-up', async () => {
    const { mgr, pending, getEventLog, fire } = rig();
    fire(); fire();
    // Disconnect while the read is in flight.
    (mgr as any).pollGeneration++;
    (mgr as any)._state.connected = false;
    pending[0].resolve([{ seqnum: 9, code: 1, msgtype: 1 }]);
    await settle();
    expect((mgr as any)._state.eventLog).toEqual([]);
    expect(getEventLog).toHaveBeenCalledTimes(1);
  });

  it('a generation change alone drops the late log but still lets the queued follow-up read the new connection', async () => {
    const { mgr, pending, getEventLog, fire } = rig();
    fire(); fire();
    (mgr as any).pollGeneration++;      // reconnected to another controller, still connected
    pending[0].resolve([{ seqnum: 9, code: 1, msgtype: 1 }]);
    await settle();
    expect((mgr as any)._state.eventLog).toEqual([]);   // the stale log never landed
    expect(getEventLog).toHaveBeenCalledTimes(2);       // the follow-up reads the current controller
    const fresh = [{ seqnum: 1, code: 2, msgtype: 1 }];
    pending[1].resolve(fresh);
    await settle();
    expect((mgr as any)._state.eventLog).toEqual(fresh);
  });
});
