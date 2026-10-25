import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsClient } from '../src/RwsClient.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { nextPagePath } from '../src/rws2/core.js';
import { WsSubscriber, refusedSubscriptionResources, otherPanelSpelling } from '../src/WsSubscriber.js';
import type { HttpSession } from '../src/HttpSession.js';

// Behaviour fixed against bodies recorded from RobotWare 6.16.03, 7.21.4 and
// 8.2.1 virtual controllers on 2026-09-29. The bodies below are those answers,
// shortened where they carried many identical entries.

/** A fake RwsClient for RWS1Adapter: answers each GET from `respond`. */
function fakeRws1(respond: (url: string) => { status: number; body: string }): { client: RwsClient; urls: string[] } {
  const urls: string[] = [];
  const client = {
    request: async (_m: string, url: string) => { urls.push(url); return respond(url); },
  } as unknown as RwsClient;
  return { client, urls };
}

/** A local HTTP server for RwsClient2; `respond` returns [status, body]. */
async function withServer(
  respond: (url: string, accept: string) => [number, string],
  run: (client: RwsClient2, seen: Array<{ url: string; accept: string }>) => Promise<void>,
): Promise<void> {
  const seen: Array<{ url: string; accept: string }> = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const accept = String(req.headers['accept'] ?? '');
    seen.push({ url, accept });
    const [status, body] = respond(url, accept);
    res.writeHead(status, { 'Content-Type': 'application/hal+json;v=2.0' });
    res.end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p'), seen);
  } finally { server.close(); }
}

// ─── RWS 1.0 text range: XML entities in the JSON text value ────────────────

describe('RWS1Adapter.getModuleTextRange (RW 6.16.03 range body)', () => {
  const RANGE_BODY = '{"_links":{"base": { "href": "http://127.0.0.1:4578/rw/rapid/" } },"_embedded" :{  "_state":[ { "_links": { "self": { "href": "?task=T_ROB1&startrow=2&startcol=1&endrow=3&endcol=0" } },"_type":"rap-mod-text","_title":"pgm_txt","text":"  VAR string zz_probe_s := &quot;a&lt;b&gt;c&amp;d&quot;&quot;e&apos;f&quot;;\\n" } ] }}';

  it('decodes the XML entities of the range text instead of returning them escaped', async () => {
    const { client } = fakeRws1(() => ({ status: 200, body: RANGE_BODY }));
    const text = await new RWS1Adapter(client).getModuleTextRange('T_ROB1', 'ZZ_PROBE', 2, 1, 2, -1);
    expect(text).toBe('  VAR string zz_probe_s := "a<b>c&d""e\'f";\n');
  });

  it('keeps a literal % in RAPID text (it neither throws nor gets URL-decoded)', async () => {
    const body = JSON.stringify({ _embedded: { _state: [{ _type: 'rap-mod-text', text: '  TPWrite "100%20 done 50%";\n' }] } });
    const { client } = fakeRws1(() => ({ status: 200, body }));
    expect(await new RWS1Adapter(client).getModuleTextRange('T_ROB1', 'M', 1, 1, 1, -1)).toBe('  TPWrite "100%20 done 50%";\n');
  });
});

// ─── RWS 1.0 single elog message: nearest lower message for a missing seqnum ─

describe('RWS1Adapter.getEventLogMessage (RW 6.16.03 nearest-lower answer)', () => {
  // GET /rw/elog/0/26?json=1 when 26 does not exist: 200 with message 25.
  const NEAREST_BODY = '{"_links":{"base": { "href":"http://127.0.0.1:4578/rw/elog/" }},"_embedded" :{  "_state":[ {"_type":"elog-message","_title":"/rw/elog/0/25" ,"msgtype":"1", "code":"10064", "src-name":"MC0", "tstamp":"2026-09-29 T 15:44:09", "argc":"2" ,"argv":[{"type":"string","value":"ZZ_PROBE"} ,{"type":"string","value":"T_ROB1"} ] } ] }}';

  it('returns null when the controller answers with a message of another seqnum', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: NEAREST_BODY }));
    expect(await new RWS1Adapter(client).getEventLogMessage(0, 26)).toBeNull();
    expect(urls[0]).toContain('/rw/elog/0/26');
  });

  it('returns the message when its title names the requested seqnum', async () => {
    const { client } = fakeRws1(() => ({ status: 200, body: NEAREST_BODY }));
    const m = await new RWS1Adapter(client).getEventLogMessage(0, 25);
    expect(m?.seqnum).toBe(25);
    expect(m?.code).toBe(10064);
  });
});

// ─── RWS 2.0 paging: next href relative to the response's base ──────────────

describe('nextPagePath resolves against the response base', () => {
  // RW 8.2.1 EIO_SIGNAL instances, page 1 (two of its 70 entries kept).
  const CFG_PAGE1 = '{ "_links" : { "base": { "href": "https://127.0.0.1:80/rw/cfg/" },"self": { "href": "EIO/EIO_SIGNAL/instances?limit=70"} , "next": {"href":"EIO/EIO_SIGNAL/instances?start=70&limit=70"} }  , "_embedded" : { "resources" : [ '
    + '{ "_links": { "self": { "href": "EIO/EIO_SIGNAL/instances/IIO_di1" } }, "_type":"cfg-dt-instance-li", "_title":"IIO_di1", "rdonly":"false", "instanceid":"6949384", "attrib": [  { "_type":"cfg-ia-t", "_title":"Name", "value":"IIO_di1" } ] } , '
    + '{ "_links": { "self": { "href": "EIO/EIO_SIGNAL/instances/IIO_di2" } }, "_type":"cfg-dt-instance-li", "_title":"IIO_di2", "rdonly":"false", "instanceid":"6949385", "attrib": [  { "_type":"cfg-ia-t", "_title":"Name", "value":"IIO_di2" } ] } ] }}';
  // Page 2 (one of its 24 entries kept): no next link.
  const CFG_PAGE2 = '{ "_links" : { "base": { "href": "https://127.0.0.1:80/rw/cfg/" },"self": { "href": "EIO/EIO_SIGNAL/instances"} }  , "_embedded" : { "resources" : [ '
    + '{ "_links": { "self": { "href": "EIO/EIO_SIGNAL/instances/SC3CBCERR" } }, "_type":"cfg-dt-instance-li", "_title":"SC3CBCERR", "rdonly":"true", "instanceid":"6625176", "attrib": [  { "_type":"cfg-ia-t", "_title":"Name", "value":"SC3CBCERR" } ] } ] }}';
  const NOT_FOUND = '{ "_links":{ "base": { "href": "https://127.0.0.1:80/" } } ,"status" : {"code":-1073445866, "msg":"rws_services.cpp[127] Resource not found code:-1073445866 icode:-1"}}';

  it('HAL: a CFG instances next link resolves under /rw/cfg/, not under the request path', () => {
    expect(nextPagePath(CFG_PAGE1, '/rw/cfg/EIO/EIO_SIGNAL/instances'))
      .toBe('/rw/cfg/EIO/EIO_SIGNAL/instances?start=70&limit=70');
    expect(nextPagePath(CFG_PAGE2, '/rw/cfg/EIO/EIO_SIGNAL/instances')).toBe('');
  });

  it('XHTML: resolves against <base href>, and falls back to the request parent without one', () => {
    const withBase = '<html><head><base href="https://h/rw/cfg/"/></head><body><a href="EIO/EIO_SIGNAL/instances?start=70&amp;limit=70" rel="next"></a></body></html>';
    expect(nextPagePath(withBase, '/rw/cfg/EIO/EIO_SIGNAL/instances')).toBe('/rw/cfg/EIO/EIO_SIGNAL/instances?start=70&limit=70');
    const noBase = '<html><body><a href="signals?start=100&amp;limit=100" rel="next"></a></body></html>';
    expect(nextPagePath(noBase, '/rw/iosystem/signals')).toBe('/rw/iosystem/signals?start=100&limit=100');
  });

  it('the event log and signal lists resolve as before (their base is the request parent)', () => {
    const elog = '{"_links":{"base":{"href":"https://127.0.0.1:80/rw/elog/"},"self":{"href":"0?lang=en"},"next":{"href":"0?order=fifo&amp;lang=en&amp;start=2&amp;limit=50"}},"_embedded":{"resources":[]}}';
    expect(nextPagePath(elog, '/rw/elog/0')).toBe('/rw/elog/0?order=fifo&lang=en&start=2&limit=50');
    const signals = '{"_links":{"base":{"href":"https://x/rw/iosystem/"},"next":{"href":"signals?start=100&amp;limit=100"}},"_embedded":{"resources":[]}}';
    expect(nextPagePath(signals, '/rw/iosystem/signals')).toBe('/rw/iosystem/signals?start=100&limit=100');
  });

  it('listCfgInstances reads every page (it stopped at 70 on the doubled path)', async () => {
    await withServer(url => {
      if (url === '/rw/cfg/EIO/EIO_SIGNAL/instances') { return [200, CFG_PAGE1]; }
      if (url === '/rw/cfg/EIO/EIO_SIGNAL/instances?start=70&limit=70') { return [200, CFG_PAGE2]; }
      return [404, NOT_FOUND];
    }, async (client, seen) => {
      expect(await client.listCfgInstances('EIO', 'EIO_SIGNAL')).toEqual(['IIO_di1', 'IIO_di2', 'SC3CBCERR']);
      expect(seen.map(s => s.url)).not.toContain('/rw/cfg/EIO/EIO_SIGNAL/EIO/EIO_SIGNAL/instances?start=70&limit=70');
    });
  });
});

// ─── RWS 2.0 newest-first event log: elogseqnum paging, entity decoding ─────

describe('RwsClient2.getEventLog newest-first paging', () => {
  const entry = (seq: number, extra = ''): string =>
    `{"_links":{"self":{"href":"0/${seq}?lang=en"}},"_type":"elog-message-li","_title":"/rw/elog/0/${seq}","msgtype":"1","code":"10015","tstamp":"2026-09-29 T 10:00:00","title":"Event ${seq}"${extra},"argc":"0"}`;
  // The v=2.1 answer: the emitted next link repeats page 1 (start=2^32-limit).
  const page = (seqs: number[]): string =>
    '{"_links":{"base":{"href":"https://127.0.0.1:80/rw/elog/"},"self":{"href":"0?lang=en"},"next":{"href":"0?order=lifo&lang=en&start=4294967293&limit=3"}},"_embedded":{"resources":['
    + seqs.map(s => entry(s)).join(',') + ']}}';

  it('asks for elogseqnum = lowest - 1 instead of following the non-advancing next link', async () => {
    // Stored: 102, 88, 87, 75, 71, 70, 7, 6 (gaps included); three per page.
    const stored = [102, 88, 87, 75, 71, 70, 7, 6];
    await withServer(url => {
      const u = new URL(url, 'http://h');
      const n = u.searchParams.get('elogseqnum');
      const atOrBelow = n === null ? stored : stored.filter(s => s <= Number(n));
      return [200, page(atOrBelow.slice(0, 3))];
    }, async (client, seen) => {
      const log = await client.getEventLog(0, 'en', 20, 'newest');
      expect(log.map(m => m.seqnum)).toEqual(stored);
      expect(seen.every(s => s.accept.includes('v=2.1'))).toBe(true);
      expect(seen.map(s => s.url)).toEqual([
        '/rw/elog/0?lang=en&order=lifo',
        '/rw/elog/0?lang=en&elogseqnum=86',
        '/rw/elog/0?lang=en&elogseqnum=69',
        '/rw/elog/0?lang=en&elogseqnum=5',
      ]);
    });
  });

  it('stops on a page with no new seqnum', async () => {
    await withServer(() => [200, page([44, 40, 39])], async (client, seen) => {
      const log = await client.getEventLog(0, 'en', 20, 'newest');
      expect(log.map(m => m.seqnum)).toEqual([44, 40, 39]);
      expect(seen).toHaveLength(2);
    });
  });

  it('a failed elogseqnum page ends the walk with the entries already read (no capture of that answer)', async () => {
    // Synthetic: the answer below the oldest stored entry was never captured,
    // so any refusal there must not lose the pages already read.
    await withServer(url => {
      if (url.includes('elogseqnum=86')) { return [200, page([75, 71, 70])]; }
      if (url.includes('elogseqnum')) { return [400, '{"status":{"code":-1073445879,"msg":"Invalid argument"}}']; }
      return [200, page([102, 88, 87])];
    }, async (client, seen) => {
      const log = await client.getEventLog(0, 'en', 20, 'newest');
      expect(log.map(m => m.seqnum)).toEqual([102, 88, 87, 75, 71, 70]);
      expect(seen).toHaveLength(3);
    });
  });

  it('a failed first page still throws', async () => {
    await withServer(() => [400, '{"status":{"code":-1073445879,"msg":"Invalid argument"}}'], async client => {
      await expect(client.getEventLog(0, 'en', 20, 'newest')).rejects.toThrow();
    });
  });

  it('oldest-first still follows the next link', async () => {
    const p1 = '{"_links":{"base":{"href":"https://127.0.0.1:80/rw/elog/"},"self":{"href":"0?lang=en"},"next":{"href":"0?order=fifo&amp;lang=en&amp;start=2&amp;limit=50"}},"_embedded":{"resources":[' + entry(1) + ']}}';
    const p2 = '{"_links":{"base":{"href":"https://127.0.0.1:80/rw/elog/"},"self":{"href":"0?lang=en"}},"_embedded":{"resources":[' + entry(2) + ']}}';
    await withServer(url => [200, url.includes('start=2') ? p2 : p1], async (client, seen) => {
      expect((await client.getEventLog(0, 'en')).map(m => m.seqnum)).toEqual([1, 2]);
      expect(seen[1].url).toBe('/rw/elog/0?order=fifo&lang=en&start=2&limit=50');
    });
  });
});

describe('RwsClient2 event-log text entities (RW 7.21.4 / 8.2.1 hal+json)', () => {
  it('decodes entities in title, desc, causes, consequences and actions on every read', async () => {
    const fields = '"title":"Can&apos;t start","desc":"The task&apos;s program &lt;main&gt;","causes":"A &amp; B","conseqs":"&quot;x&quot;","actions":"a &amp;lt; b"';
    const list = '{"_links":{"base":{"href":"https://x/rw/elog/"},"self":{"href":"0?lang=en"}},"_embedded":{"resources":['
      + `{"_links":{"self":{"href":"0/8?lang=en"}},"_type":"elog-message-li","_title":"/rw/elog/0/8","msgtype":"1","code":"10015",${fields}}]}}`;
    const single = `{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"elog-message","_title":"/rw/elog/0/8","msgtype":"1","code":"10015",${fields}}]}`;
    await withServer(url => [200, /\/rw\/elog\/0\?/.test(url) ? list : single], async client => {
      const expected = {
        title: "Can't start", desc: "The task's program <main>", causes: 'A & B',
        consequences: '"x"', actions: 'a &lt; b',
      };
      const [m] = await client.getEventLog(0, 'en', 1);
      expect(m).toMatchObject(expected);
      expect(await client.getEventLogMessage(0, 8)).toMatchObject(expected);
      expect(await client.getEventLogMessageBySeqnum(8)).toMatchObject(expected);
    });
  });
});

// ─── RWS 1.0 subscription: a panel resource dropped under a 201 ──────────────

describe('WsSubscriber partial bind (RW 6.16.03 spelling lock)', () => {
  // 201 to the client's own six-resource body while another client holds bare
  // /rw/panel/opmode: opmode is dropped, named only in the status block.
  const PARTIAL_201 = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Event</title><base href="http://127.0.0.1:4578/"/> </head> <body> <div class="status"> <a href="/rw/panel/opmode;opmode" rel="self"> </a> <span class="code">-1073445866</span> <span class="msg">Invalid resource URI in Create Subscription request</span></div> <div class="state"><a href="subscription/75" rel="group"></a><a href="ws://127.0.0.1:4578/poll/75" rel="self"></a><a href="subscription/75?action=show" rel="action"></a> <ul> <li class="elog-message-ev" title="message"><a href="/rw/elog/0/52" rel="self"/><span class="seqnum">52</span></li>  <li class="pnl-coldetstate-ev" title="coldetstate"><a href="/rw/panel/coldetstate" rel="self"></a><span class="coldetstate">INIT</span></li>  <li class="pnl-ctrlstate-ev" title="ctrlstate"><a href="/rw/panel/ctrlstate" rel="self"></a><span class="ctrlstate">motoron</span></li>  <li class="pnl-speedratio-ev" title="speedratio"><a href="/rw/panel/speedratio" rel="self"></a><span class="speedratio">100</span></li>  <li class="rap-ctrlexecstate-ev" title="ctrlexecstate"><a href="/rw/rapid/execution;ctrlexecstate" rel="self"/><span class="ctrlexecstate">stopped</span></li>  </ul> </div> </body></html>';
  // 201 to the same body with only opmode sent bare: all six bound.
  const FULL_201 = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Event</title><base href="http://127.0.0.1:4578/"/> </head> <body>  <div class="state"><a href="subscription/76" rel="group"></a><a href="ws://127.0.0.1:4578/poll/76" rel="self"></a><a href="subscription/76?action=show" rel="action"></a> <ul> <li class="pnl-coldetstate-ev" title="coldetstate"><a href="/rw/panel/coldetstate" rel="self"></a><span class="coldetstate">INIT</span></li>  <li class="pnl-opmode-ev" title="opmode"><a href="/rw/panel/opmode" rel="self"></a><span class="opmode">AUTO</span></li>  <li class="pnl-ctrlstate-ev" title="ctrlstate"><a href="/rw/panel/ctrlstate" rel="self"></a><span class="ctrlstate">motoron</span></li>  <li class="pnl-speedratio-ev" title="speedratio"><a href="/rw/panel/speedratio" rel="self"></a><span class="speedratio">100</span></li>  <li class="elog-message-ev" title="message"><a href="/rw/elog/0/52" rel="self"/><span class="seqnum">52</span></li>  <li class="rap-ctrlexecstate-ev" title="ctrlexecstate"><a href="/rw/rapid/execution;ctrlexecstate" rel="self"/><span class="ctrlexecstate">stopped</span></li>  </ul> </div> </body></html>';
  // 400 to a single-resource create in the held spelling.
  const REFUSED_400 = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Event</title><base href="http://127.0.0.1:4578/"/> </head> <body> <div class="status"> <a href="/rw/panel/ctrlstate" rel="self"> </a> <span class="code">-1073445866</span> <span class="msg">Invalid resource URI in Create Subscription request</span></div> <div class="state"> </div> </body></html>';

  const MANAGER_RESOURCES = ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 }] as const;

  function scriptedSession(answers: Array<{ body: string; location: string }>) {
    const posts: string[] = [];
    const deletes: string[] = [];
    const session = {
      post: async (_url: string, body: string) => {
        posts.push(body);
        const a = answers[Math.min(posts.length - 1, answers.length - 1)];
        return { status: 201, body: a.body, headers: new Headers({ location: a.location }) };
      },
      delete: async (url: string) => { deletes.push(url); return { status: 200, body: '', headers: new Headers() }; },
      getCookieHeader: () => 'ABBCX=a; -http-session-=b',
    } as unknown as HttpSession;
    return { session, posts, deletes };
  }

  class OpenWs {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((e: { wasClean?: boolean }) => void) | null = null;
    constructor() { setTimeout(() => this.onopen?.(), 1); }
    close(): void { this.onclose?.({ wasClean: true }); }
  }

  it('reads the refused URIs from the status blocks of a 201 and of a 400', () => {
    expect(refusedSubscriptionResources(PARTIAL_201)).toEqual(['/rw/panel/opmode;opmode']);
    expect(refusedSubscriptionResources(FULL_201)).toEqual([]);
    expect(refusedSubscriptionResources(REFUSED_400)).toEqual(['/rw/panel/ctrlstate']);
  });

  it('knows the other spelling of the four two-spelling panel resources only', () => {
    expect(otherPanelSpelling('/rw/panel/opmode;opmode')).toBe('/rw/panel/opmode');
    expect(otherPanelSpelling('/rw/panel/ctrlstate')).toBe('/rw/panel/ctrlstate;ctrlstate');
    expect(otherPanelSpelling('/rw/panel/speedratio;speedratio')).toBe('/rw/panel/speedratio');
    expect(otherPanelSpelling('/rw/panel/coldetstate')).toBe('/rw/panel/coldetstate;coldetstate');
    expect(otherPanelSpelling('/rw/rapid/execution;ctrlexecstate')).toBeNull();
    expect(otherPanelSpelling('/rw/elog/0')).toBeNull();
  });

  it('deletes the partial group and re-creates it with the dropped resource in the other spelling', async () => {
    const { session, posts, deletes } = scriptedSession([
      { body: PARTIAL_201, location: 'ws://127.0.0.1:4578/poll/75' },
      { body: FULL_201, location: 'ws://127.0.0.1:4578/poll/76' },
    ]);
    const sub = new WsSubscriber(session, '127.0.0.1', 4578, OpenWs as unknown as typeof WebSocket);
    const unsubscribe = await sub.subscribe([...MANAGER_RESOURCES], () => undefined);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain('&2=/rw/panel/opmode;opmode&');
    expect(posts[1]).toContain('&2=/rw/panel/opmode&');
    expect(posts[1]).toContain('1=/rw/panel/ctrlstate;ctrlstate&');   // the others unchanged
    expect(deletes).toEqual(['/subscription/75']);
    await unsubscribe();
    expect(deletes).toEqual(['/subscription/75', '/subscription/76']);
  });

  it('binds on the first create when nothing is dropped (one POST, no delete)', async () => {
    const { session, posts, deletes } = scriptedSession([{ body: FULL_201, location: 'ws://127.0.0.1:4578/poll/76' }]);
    const sub = new WsSubscriber(session, '127.0.0.1', 4578, OpenWs as unknown as typeof WebSocket);
    await sub.subscribe([...MANAGER_RESOURCES], () => undefined);
    expect(posts).toHaveLength(1);
    expect(deletes).toEqual([]);
  });

  it('throws, after deleting the group, when the panel resource is refused in both spellings', async () => {
    const stillRefused = PARTIAL_201.replace('/rw/panel/opmode;opmode', '/rw/panel/opmode');
    const { session, posts, deletes } = scriptedSession([
      { body: PARTIAL_201, location: 'ws://127.0.0.1:4578/poll/75' },
      { body: stillRefused, location: 'ws://127.0.0.1:4578/poll/77' },
    ]);
    const sub = new WsSubscriber(session, '127.0.0.1', 4578, OpenWs as unknown as typeof WebSocket);
    await expect(sub.subscribe([...MANAGER_RESOURCES], () => undefined)).rejects.toThrow(/did not bind \/rw\/panel\/opmode/);
    expect(posts).toHaveLength(2);
    expect(deletes).toEqual(['/subscription/75', '/subscription/77']);
  });
});
