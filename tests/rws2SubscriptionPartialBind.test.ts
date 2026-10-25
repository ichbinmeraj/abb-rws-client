import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { RwsClient2 } from '../src/RwsClient2.js';
import { Rws2Core } from '../src/rws2/core.js';
import {
  otherPanelSpelling, subscriptionBodyResources, swapSubscriptionResources, unboundPanelResources,
} from '../src/rws2/subscriptionBind.js';

/**
 * RWS 2.0: a create answer that leaves a panel resource out. A RobotWare
 * 8.2.1 virtual controller answered the manager's six-resource create 201 and
 * listed five members, without `/rw/panel/speedratio;speedratio`, on some days
 * (2026-10-01, 2026-10-18), and all six on others with the same body. The
 * subscriber now checks the answer and, like the RWS 1.0 one, re-creates the
 * group once with that resource in its other spelling.
 *
 * The answers below are put together from the entries RW 8.2.1 and 7.21.4
 * sent on 2026-09-29: one `...-ev` entry per bound resource, the panel ones
 * with a self link without the suffix (`/rw/panel/ctrl-state`), execution with
 * `;ctrlexecstate`, the event log as its newest message; and the group listing
 * as one `sub-resource` per member, as sent. The six-resource RW8 answer
 * itself was not recorded.
 */

const ENTRY: Record<string, string> = {
  '/rw/panel/ctrl-state': '<li class="pnl-ctrlstate-ev" title="ctrlstate"><a href="/rw/panel/ctrl-state" rel="self"></a><span class="ctrlstate">motoron</span></li>',
  '/rw/panel/opmode': '<li class="pnl-opmode-ev" title="opmode"><a href="/rw/panel/opmode" rel="self"></a><span class="opmode">AUTO</span></li>',
  '/rw/panel/speedratio': '<li class="pnl-speedratio-ev" title="speedratio"><a href="/rw/panel/speedratio" rel="self"></a><span class="speedratio">100</span></li>',
  '/rw/rapid/execution': '<li class="rap-ctrlexecstate-ev" title="ctrlexecstate"><a href="/rw/rapid/execution;ctrlexecstate" rel="self"></a><span class="ctrlexecstate">stopped</span></li>',
  '/rw/panel/coldetstate': '<li class="pnl-coldetstate-ev" title="coldetstate"><a href="/rw/panel/coldetstate" rel="self"></a><span class="coldetstate">INIT</span></li>',
  '/rw/elog/0': '<li class="elog-message-ev" title="message"><a href="/rw/elog/0/52" rel="self"></a><span class="seqnum">52</span></li>',
};

/** A 201 answer for group `id` listing initial events for `bound` (paths without suffix) and a status block for each of `refused`. */
function created(id: number, port: number, bound: string[], refused: string[] = []): string {
  const status = refused.map(r => `<div class="status"> <a href="${r}" rel="self"> </a> <span class="code">-1073445866</span> `
    + '<span class="msg">Invalid resource URI in Create Subscription request</span></div> ').join('');
  return '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head><base href="https://127.0.0.1:80/"/> </head> <body> '
    + `${status}<div class="state"><a href="subscription/${id}" rel="group"></a><a href="ws://127.0.0.1:${port}/poll/${id}" rel="self"></a> <ul> `
    + bound.map(b => ENTRY[b]).join(' ') + ' </ul> </div> </body></html>';
}

/** A `GET /subscription/{id}` answer listing `members` as the group stores them. */
function listing(id: number, members: string[]): string {
  return '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <base href="https://127.0.0.1:80/" /></head> '
    + `<body><div class="state"> <a href="subscription/${id}" rel="self"></a> <ul>`
    + members.map((m, i) => `<li class="sub-resource" title="${i + 1}"><a href="${m}" rel="self"></a> </li>`).join('')
    + '</ul></div> </body></html>';
}

/** The body RobotManager sends for its six resources. */
const MANAGER_BODY = Rws2Core.buildSubscriptionBody([
  'controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 },
]) as string;
const ALL = Object.keys(ENTRY);
const WITHOUT_SPEED = ALL.filter(p => p !== '/rw/panel/speedratio');
/** The members the manager's group lists when every resource bound (the resources as sent). */
const MEMBERS = subscriptionBodyResources(MANAGER_BODY);

interface Scripted {
  /** The 201 for the nth POST (1-based) and the body that was posted. */
  answer: (n: number, body: string, port: number) => string;
  /** The group listing for `GET /subscription/{id}`; null answers 404. */
  members?: (id: number) => string[] | null;
  /** Holds the answer to the nth POST until it settles. */
  hold?: (n: number) => Promise<void>;
}

async function startServer(script: Scripted) {
  const posts: string[] = [];
  const deletes: string[] = [];
  const gets: string[] = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && req.url === '/subscription') {
        posts.push(body);
        const n = posts.length;
        void Promise.resolve(script.hold?.(n)).then(() => {
          res.writeHead(201, { Location: `ws://127.0.0.1:${port}/poll/${n}`, 'Content-Type': 'application/xhtml+xml;v=2.0' });
          res.end(script.answer(n, body, port));
        });
        return;
      }
      if (req.method === 'DELETE') { deletes.push(req.url ?? ''); res.writeHead(200); res.end(); return; }
      const group = /^\/subscription\/(\d+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && group) {
        gets.push(req.url ?? '');
        const members = script.members?.(Number(group[1])) ?? null;
        if (members === null) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end(listing(Number(group[1]), members));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end('<html><body><div class="state"><ul><li class="pnl-ctrlstate"><span class="ctrlstate">motoron</span></li></ul></div></body></html>');
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  const wss = new WebSocketServer({ server, handleProtocols: p => [...p][0] ?? false });
  const sockets: Array<{ terminate: () => void }> = [];
  wss.on('connection', ws => { sockets.push(ws); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  return {
    port, posts, deletes, gets, sockets,
    close: () => { wss.close(); server.close(); },
  };
}

function until(cond: () => boolean, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) { clearInterval(timer); resolve(); } else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('condition not met in time')); }
    }, 20);
  });
}

/** The three judged lists of unboundPanelResources (its `bound` list is checked separately). */
function judged(body: string, answer: string): { refused: string[]; suspect: string[]; otherRefused: string[] } {
  const { refused, suspect, otherRefused } = unboundPanelResources(body, answer);
  return { refused, suspect, otherRefused };
}

const tuning = Rws2Core as unknown as { WS_RECONNECT_BASE_MS: number };
const baseMs = tuning.WS_RECONNECT_BASE_MS;
afterEach(() => { tuning.WS_RECONNECT_BASE_MS = baseMs; });

describe('RWS 2.0 create answer: which panel resources were bound', () => {
  it('knows the other spelling of the four RWS 2.0 panel resources only', () => {
    expect(otherPanelSpelling('/rw/panel/speedratio;speedratio')).toBe('/rw/panel/speedratio');
    expect(otherPanelSpelling('/rw/panel/speedratio')).toBe('/rw/panel/speedratio;speedratio');
    expect(otherPanelSpelling('/rw/panel/ctrl-state;ctrlstate')).toBe('/rw/panel/ctrl-state');
    expect(otherPanelSpelling('/rw/panel/ctrl-state')).toBe('/rw/panel/ctrl-state;ctrlstate');
    expect(otherPanelSpelling('/rw/panel/opmode;opmode')).toBe('/rw/panel/opmode');
    expect(otherPanelSpelling('/rw/panel/coldetstate')).toBe('/rw/panel/coldetstate;coldetstate');
    // The RWS 1.0 spelling of the controller state is not an RWS 2.0 one.
    expect(otherPanelSpelling('/rw/panel/ctrlstate;ctrlstate')).toBeNull();
    expect(otherPanelSpelling('/rw/panel/opmode;ctrlstate')).toBeNull();
    expect(otherPanelSpelling('/rw/rapid/execution;ctrlexecstate')).toBeNull();
    expect(otherPanelSpelling('/rw/elog/0')).toBeNull();
  });

  it('reads the resources a body names, in order', () => {
    expect(MEMBERS).toEqual([
      '/rw/panel/ctrl-state;ctrlstate', '/rw/panel/opmode;opmode', '/rw/panel/speedratio;speedratio',
      '/rw/rapid/execution;ctrlexecstate', '/rw/panel/coldetstate;coldetstate', '/rw/elog/0',
    ]);
  });

  it('reads RW 8.2.1 answers as recorded: both bound, and speedratio left out', () => {
    // 2026-09-29, a speedratio + coldetstate create. With the index written
    // once (`resources=2`) the controller bound only coldetstate; with the
    // index repeated it bound both. Judged against the well-formed body.
    const body = 'resources=1&1=/rw/panel/speedratio;speedratio&1-p=1&resources=2&2=/rw/panel/coldetstate;coldetstate&2-p=1';
    const onlyColdet = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head><base href="https://127.0.0.1:80/"/> </head> <body>  <div class="state"><a href="subscription/1" rel="group"></a><a href="wss://127.0.0.1:80/poll/1" rel="self"></a> <ul> <li class="pnl-coldetstate-ev" title="coldetstate"><a href="/rw/panel/coldetstate" rel="self"></a><span class="coldetstate">INIT</span></li>  </ul> </div> </body></html>';
    const both = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head><base href="https://127.0.0.1:80/"/> </head> <body>  <div class="state"><a href="subscription/3" rel="group"></a><a href="wss://127.0.0.1:80/poll/3" rel="self"></a> <ul> <li class="pnl-coldetstate-ev" title="coldetstate"><a href="/rw/panel/coldetstate" rel="self"></a><span class="coldetstate">INIT</span></li>  <li class="pnl-speedratio-ev" title="speedratio"><a href="/rw/panel/speedratio" rel="self"></a><span class="speedratio">100</span></li>  </ul> </div> </body></html>';
    expect(judged(body, both)).toEqual({ refused: [], suspect: [], otherRefused: [] });
    expect(judged(body, onlyColdet).suspect).toEqual(['/rw/panel/speedratio;speedratio']);
    expect(unboundPanelResources(body, both).bound).toEqual(['/rw/panel/coldetstate', '/rw/panel/speedratio']);
    // Execution keeps its own path and the event log stands for its domain.
    expect(unboundPanelResources(MANAGER_BODY, created(1, 80, ALL)).bound.sort()).toEqual([...ALL].sort());
  });

  it('finds nothing unbound when every resource has its initial event', () => {
    expect(judged(MANAGER_BODY, created(1, 80, ALL))).toEqual({ refused: [], suspect: [], otherRefused: [] });
  });

  it('suspects a panel resource with no initial event, and takes one a status block names as refused', () => {
    expect(judged(MANAGER_BODY, created(1, 80, WITHOUT_SPEED)))
      .toEqual({ refused: [], suspect: ['/rw/panel/speedratio;speedratio'], otherRefused: [] });
    expect(judged(MANAGER_BODY, created(1, 80, WITHOUT_SPEED, ['/rw/panel/speedratio;speedratio'])))
      .toEqual({ refused: ['/rw/panel/speedratio;speedratio'], suspect: [], otherRefused: [] });
  });

  it('judges nothing from an answer that lists no initial event, and reports a refused resource that is not a panel one', () => {
    expect(judged(MANAGER_BODY, created(1, 80, [])).suspect).toEqual([]);
    const body = Rws2Core.buildSubscriptionBody(['speedratio', { type: 'signal', name: 'no_such' }]) as string;
    expect(judged(body, created(1, 80, ['/rw/panel/speedratio'], ['/rw/iosystem/signals/no_such;state'])))
      .toEqual({ refused: [], suspect: [], otherRefused: ['/rw/iosystem/signals/no_such;state'] });
  });

  it('names a refused resource as the request sent it, as RWS 1.0 does: two resources on one path stay apart', () => {
    const body = Rws2Core.buildSubscriptionBody(['execution', { type: 'execycle' }]) as string;
    const [exec, cycle] = subscriptionBodyResources(body);
    expect([exec, cycle]).toEqual(['/rw/rapid/execution;ctrlexecstate', '/rw/rapid/execution;rapidexeccycle']);
    // The status block names the URI as sent: only that one.
    expect(judged(body, created(1, 80, ['/rw/rapid/execution'], [cycle])).otherRefused).toEqual([cycle]);
    expect(judged(body, created(1, 80, [], [`https://127.0.0.1:80${exec}`])).otherRefused).toEqual([exec]);
    // It names the path only: every URI sent on that path.
    expect(judged(body, created(1, 80, [], ['/rw/rapid/execution'])).otherRefused).toEqual([exec, cycle]);
    // A path the request did not send: as the answer names it, without the suffix.
    expect(judged(body, created(1, 80, ['/rw/rapid/execution'], ['/rw/elog/9;x'])).otherRefused).toEqual(['/rw/elog/9']);
    // The event log, as RW 6.16.03 left it out on RWS 1.0 (2026-10-22).
    expect(judged(MANAGER_BODY, created(1, 80, WITHOUT_SPEED.filter(p => p !== '/rw/elog/0'), ['/rw/elog/0'])).otherRefused)
      .toEqual(['/rw/elog/0']);
  });

  it('swaps only the named resource in a body', () => {
    const swapped = swapSubscriptionResources(MANAGER_BODY, [['/rw/panel/speedratio;speedratio', '/rw/panel/speedratio']]);
    expect(subscriptionBodyResources(swapped)).toEqual([
      '/rw/panel/ctrl-state;ctrlstate', '/rw/panel/opmode;opmode', '/rw/panel/speedratio',
      '/rw/rapid/execution;ctrlexecstate', '/rw/panel/coldetstate;coldetstate', '/rw/elog/0',
    ]);
    expect(swapped).toContain('&3-p=1&');
  });
});

describe('RWS 2.0 subscribe: a panel resource the controller left out', () => {
  it('deletes the group and creates it once more with that resource in its other spelling; reconnects send that body', async () => {
    tuning.WS_RECONNECT_BASE_MS = 20;
    const s = await startServer({
      answer: (n, _body, port) => created(n, port, n === 1 ? WITHOUT_SPEED : ALL),
      members: id => (id === 1 ? MEMBERS.filter(m => !m.startsWith('/rw/panel/speedratio')) : null),
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(
        ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 }], () => {});
      expect(s.posts).toHaveLength(2);
      expect(s.posts[0]).toContain('&3=/rw/panel/speedratio;speedratio&');
      expect(s.posts[1]).toContain('&3=/rw/panel/speedratio&');
      expect(s.posts[1]).toContain('1=/rw/panel/ctrl-state;ctrlstate&');
      expect(s.gets).toEqual(['/subscription/1']);
      expect(s.deletes).toEqual(['/subscription/1']);
      expect(unsubscribe.groupPath).toBe('/subscription/2');

      // A dropped socket re-creates the group with the body that bound.
      await until(() => s.sockets.length >= 1);
      s.sockets[0].terminate();
      await until(() => s.posts.length >= 3);
      expect(s.posts[2]).toBe(s.posts[1]);
      await unsubscribe();
    } finally { s.close(); }
  });

  it('acts on a status block without reading the group', async () => {
    const s = await startServer({
      answer: (n, _body, port) => (n === 1 ? created(n, port, WITHOUT_SPEED, ['/rw/panel/speedratio;speedratio']) : created(n, port, ALL)),
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['controllerstate', 'speedratio'], () => {});
      expect(s.posts).toHaveLength(2);
      expect(s.posts[1]).toBe('resources=1&1=/rw/panel/ctrl-state;ctrlstate&1-p=1&resources=2&2=/rw/panel/speedratio&2-p=1');
      expect(s.gets).toEqual([]);
      expect(s.deletes).toEqual(['/subscription/1']);
      await unsubscribe();
    } finally { s.close(); }
  });

  it('throws after deleting both groups when the resource is left out in either spelling', async () => {
    const s = await startServer({
      answer: (n, _body, port) => created(n, port, WITHOUT_SPEED),
      members: () => MEMBERS.filter(m => !m.startsWith('/rw/panel/speedratio')),
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      await expect(client.subscribe(
        ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 }], () => {},
      )).rejects.toThrow(/did not bind \/rw\/panel\/speedratio in either spelling/);
      expect(s.posts).toHaveLength(2);
      expect(s.deletes).toEqual(['/subscription/1', '/subscription/2']);
      expect(s.sockets).toHaveLength(0);
    } finally { s.close(); }
  });

  it('sends no re-create once disconnect() has begun: a first answer that lands after it ends the subscribe', async () => {
    // A subscribe still out when the client disconnects (RobotManager's
    // teardown does not wait for its retry). The re-create is sent past
    // req(), and after the teardown no cookie is held, so it would go out
    // with the credentials and start a session, with a group, that nothing
    // logs out.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const s = await startServer({
      answer: (n, _body, port) => (n === 1 ? created(n, port, WITHOUT_SPEED, ['/rw/panel/speedratio;speedratio']) : created(n, port, ALL)),
      hold: n => (n === 1 ? gate : Promise.resolve()),
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const pending = client.subscribe(['controllerstate', 'speedratio'], () => {}).then(() => null, (e: unknown) => e);
      await until(() => s.posts.length === 1);
      await client.disconnect();
      release();
      const err = await pending;
      expect(err).toMatchObject({ code: 'NOT_CONNECTED' });
      expect(String((err as Error).message)).toContain('POST /subscription');
      expect(s.posts).toHaveLength(1);
      expect(s.sockets).toHaveLength(0);
    } finally { s.close(); }
  });

  it('keeps the group when its listing shows the resource after all (one create, no delete)', async () => {
    const s = await startServer({ answer: (n, _body, port) => created(n, port, WITHOUT_SPEED), members: () => MEMBERS });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(
        ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 }], () => {});
      expect(s.posts).toHaveLength(1);
      expect(s.gets).toEqual(['/subscription/1']);
      expect(s.deletes).toEqual([]);
      await unsubscribe();
    } finally { s.close(); }
  });

  it('keeps the group when the listing cannot be read', async () => {
    const s = await startServer({ answer: (n, _body, port) => created(n, port, WITHOUT_SPEED), members: () => null });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['controllerstate', 'speedratio'], () => {});
      expect(s.posts).toHaveLength(1);
      expect(s.deletes).toEqual([]);
      await unsubscribe();
    } finally { s.close(); }
  });

  it('sends one create and reads nothing more when every resource has its initial event', async () => {
    const s = await startServer({ answer: (n, _body, port) => created(n, port, ALL) });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(
        ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 }], () => {});
      expect(s.posts).toHaveLength(1);
      expect(s.gets).toEqual([]);
      expect(s.deletes).toEqual([]);
      await unsubscribe();
      expect(s.deletes).toEqual(['/subscription/1']);
    } finally { s.close(); }
  });
});
