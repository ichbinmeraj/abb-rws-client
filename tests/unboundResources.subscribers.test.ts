import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { WsSubscriber } from '../src/WsSubscriber.js';
import { RwsClient } from '../src/RwsClient.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { Rws2Core } from '../src/rws2/core.js';
import { setLogger } from '../src/Logger.js';
import type { HttpSession } from '../src/HttpSession.js';

/**
 * A resource the controller leaves out of a group while still creating it,
 * other than a panel resource (those are re-created in their other
 * spelling): the subscribe handle names it as `unbound`, so RobotManager
 * can poll what no event will bring. RW 6.16.03 created every one of
 * RobotManager's groups without `/rw/elog/0` for a whole run, each create
 * answering 201 and naming the event log in a status block (2026-10-22,
 * on the virtual controller); before, only a log line said so.
 *
 * The RWS 1.0 answers are the recorded RW 6.16.03 ones of
 * recorded-2026-09-29.test.ts, with the event log's entry moved into a
 * status block; the RWS 2.0 ones are put together the way
 * rws2SubscriptionPartialBind.test.ts builds them.
 */

const warns: string[] = [];
setLogger({ info() {}, warn(m) { warns.push(m); }, error() {}, show() {} });
afterEach(() => { warns.length = 0; });

const MANAGER_RESOURCES = ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 }] as const;

// ─── RWS 1.0 ──────────────────────────────────────────────────────────────────

const STATUS_1 = (uri: string): string => `<div class="status"> <a href="${uri}" rel="self"> </a> <span class="code">-1073445866</span> <span class="msg">Invalid resource URI in Create Subscription request</span></div> `;
const ELOG_EV_1 = '<li class="elog-message-ev" title="message"><a href="/rw/elog/0/52" rel="self"/><span class="seqnum">52</span></li>  ';
const OPMODE_EV_1 = '<li class="pnl-opmode-ev" title="opmode"><a href="/rw/panel/opmode" rel="self"></a><span class="opmode">AUTO</span></li>  ';

/** A RW 6.16.03 create answer for group `id`: a status block per `refused` URI, initial events for the rest. */
function created1(id: number, refused: string[]): string {
  const events = [
    '<li class="pnl-coldetstate-ev" title="coldetstate"><a href="/rw/panel/coldetstate" rel="self"></a><span class="coldetstate">INIT</span></li>  ',
    refused.includes('/rw/panel/opmode;opmode') || refused.includes('/rw/panel/opmode') ? '' : OPMODE_EV_1,
    '<li class="pnl-ctrlstate-ev" title="ctrlstate"><a href="/rw/panel/ctrlstate" rel="self"></a><span class="ctrlstate">motoron</span></li>  ',
    '<li class="pnl-speedratio-ev" title="speedratio"><a href="/rw/panel/speedratio" rel="self"></a><span class="speedratio">100</span></li>  ',
    refused.includes('/rw/elog/0') ? '' : ELOG_EV_1,
    '<li class="rap-ctrlexecstate-ev" title="ctrlexecstate"><a href="/rw/rapid/execution;ctrlexecstate" rel="self"/><span class="ctrlexecstate">stopped</span></li>  ',
  ].join('');
  return '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Event</title><base href="http://127.0.0.1:4578/"/> </head> <body> '
    + refused.map(STATUS_1).join('')
    + `<div class="state"><a href="subscription/${id}" rel="group"></a><a href="ws://127.0.0.1:4578/poll/${id}" rel="self"></a><a href="subscription/${id}?action=show" rel="action"></a> <ul> `
    + events + '</ul> </div> </body></html>';
}

/** An HttpSession stand-in answering each POST /subscription with the next scripted answer (the last repeats). */
function scriptedSession(answers: Array<{ id: number; refused: string[] }>) {
  const posts: string[] = [];
  const deletes: string[] = [];
  const session = {
    post: async (_url: string, body: string) => {
      posts.push(body);
      const a = answers[Math.min(posts.length - 1, answers.length - 1)];
      return { status: 201, body: created1(a.id, a.refused), headers: new Headers({ location: `ws://127.0.0.1:4578/poll/${a.id}` }) };
    },
    delete: async (url: string) => { deletes.push(url); return { status: 200, body: '', headers: new Headers() }; },
    getCookieHeader: () => 'ABBCX=a; -http-session-=b',
  } as unknown as HttpSession;
  return { session, posts, deletes };
}

/** A WebSocket stand-in: each construction takes the next behaviour of `script` (the last repeats). */
function scriptedWs(script: Array<'open' | 'fail'>) {
  const instances: Array<{ url: string; drop: () => void }> = [];
  const pending = [...script];
  class Ws {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((e: { wasClean?: boolean }) => void) | null = null;
    constructor(readonly url: string) {
      instances.push({ url, drop: () => this.onclose?.({ wasClean: false }) });
      const behaviour = pending.length > 1 ? pending.shift()! : pending[0];
      setTimeout(() => {
        if (behaviour === 'open') { this.onopen?.(); } else { this.onerror?.(); this.onclose?.({ wasClean: false }); }
      }, 1);
    }
    on(): void { /* heartbeat pong listener: not used here */ }
    ping(): void { /* never answered; the heartbeat interval is long in these tests */ }
    terminate(): void { this.onclose?.({ wasClean: false }); }
    close(): void { this.onclose?.({ wasClean: true }); }
  }
  return { Ws: Ws as unknown as typeof WebSocket, instances };
}

function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) { clearInterval(timer); resolve(); } else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('condition not met in time')); }
    }, 5);
  });
}

describe('RWS 1.0 subscribe: a resource the controller did not bind', () => {
  it('keeps the group and names /rw/elog/0 on the handle as unbound (one POST, no delete)', async () => {
    const { session, posts, deletes } = scriptedSession([{ id: 75, refused: ['/rw/elog/0'] }]);
    const { Ws } = scriptedWs(['open']);
    const sub = new WsSubscriber(session, '127.0.0.1', 4578, Ws);
    const handle = await sub.subscribe([...MANAGER_RESOURCES], () => undefined);
    expect(posts).toHaveLength(1);
    expect(deletes).toEqual([]);
    expect(handle.unbound).toEqual(['/rw/elog/0']);
    expect(warns).toEqual(['RWS 1.0 subscription: the controller did not bind /rw/elog/0']);
    await handle();
    expect(deletes).toEqual(['/subscription/75']);
  });

  it('a group that binds every resource has nothing unbound', async () => {
    const { session, posts } = scriptedSession([{ id: 76, refused: [] }]);
    const { Ws } = scriptedWs(['open']);
    const sub = new WsSubscriber(session, '127.0.0.1', 4578, Ws);
    const handle = await sub.subscribe([...MANAGER_RESOURCES], () => undefined);
    expect(posts).toHaveLength(1);
    expect(handle.unbound).toEqual([]);
    expect(warns).toEqual([]);
    await handle();
  });

  it('after a re-create for a panel spelling, only the kept group\'s answer counts', async () => {
    // First answer: opmode held in the other spelling elsewhere, and the event
    // log refused; second answer (opmode bare): the event log bound.
    const a = scriptedSession([{ id: 75, refused: ['/rw/panel/opmode;opmode', '/rw/elog/0'] }, { id: 76, refused: [] }]);
    const first = await new WsSubscriber(a.session, '127.0.0.1', 4578, scriptedWs(['open']).Ws).subscribe([...MANAGER_RESOURCES], () => undefined);
    expect(a.posts).toHaveLength(2);
    expect(a.deletes).toEqual(['/subscription/75']);
    expect(first.unbound).toEqual([]);

    // The other way round: the second answer refuses the event log.
    const b = scriptedSession([{ id: 77, refused: ['/rw/panel/opmode;opmode'] }, { id: 78, refused: ['/rw/elog/0'] }]);
    const second = await new WsSubscriber(b.session, '127.0.0.1', 4578, scriptedWs(['open']).Ws).subscribe([...MANAGER_RESOURCES], () => undefined);
    expect(b.posts).toHaveLength(2);
    expect(second.unbound).toEqual(['/rw/elog/0']);
    expect(warns).toContain('RWS 1.0 subscription: the controller did not bind /rw/elog/0');
  });

  it('a re-registration after a dead poll URL is judged on its own answer, read live on the handle', async () => {
    // The group created at connect left the event log out; the controller
    // restarted (the old poll URL fails), and the new registration binds it.
    const { session, posts } = scriptedSession([{ id: 75, refused: ['/rw/elog/0'] }, { id: 99, refused: [] }]);
    const { Ws, instances } = scriptedWs(['open', 'fail', 'open']);
    const sub = new WsSubscriber(session, '127.0.0.1', 4578, Ws);
    let restored = 0;
    const handle = await sub.subscribe([...MANAGER_RESOURCES], () => undefined, { reconnectBaseMs: 5, onRestored: () => { restored++; } });
    expect(handle.unbound).toEqual(['/rw/elog/0']);
    instances[0].drop();
    await until(() => restored === 1);
    expect(posts).toHaveLength(2);
    expect(instances[2].url).toBe('ws://127.0.0.1:4578/poll/99');
    expect(handle.unbound).toEqual([]);
    await handle();
  });

  it('a stream given up holds no group, so nothing is unbound', async () => {
    const { session } = scriptedSession([{ id: 75, refused: ['/rw/elog/0'] }]);
    const { Ws, instances } = scriptedWs(['open', 'fail']);
    const sub = new WsSubscriber(session, '127.0.0.1', 4578, Ws);
    let lost = 0;
    const handle = await sub.subscribe([...MANAGER_RESOURCES], () => undefined,
      { reconnectBaseMs: 5, maxReconnectAttempts: 2, onLost: () => { lost++; } });
    expect(handle.unbound).toEqual(['/rw/elog/0']);
    instances[0].drop();
    await until(() => lost === 1);
    expect(handle.unbound).toEqual([]);
    await handle();
  });

  it('RwsClient and RWS1Adapter hand back the subscriber\'s own handle, unbound included', async () => {
    const { session } = scriptedSession([{ id: 75, refused: ['/rw/elog/0'] }]);
    const client = new RwsClient({ host: '127.0.0.1', port: 4578, username: 'u', password: 'p' });
    (client as unknown as { subscriber: WsSubscriber }).subscriber = new WsSubscriber(session, '127.0.0.1', 4578, scriptedWs(['open']).Ws);
    const adapter = new RWS1Adapter(client, { host: '127.0.0.1', port: 4578, username: 'u', password: 'p' });
    const handle = await adapter.subscribe([...MANAGER_RESOURCES], () => undefined);
    expect(handle.unbound).toEqual(['/rw/elog/0']);
    await handle();
  });
});

// ─── RWS 2.0 ──────────────────────────────────────────────────────────────────

const ENTRY_2: Record<string, string> = {
  '/rw/panel/ctrl-state': '<li class="pnl-ctrlstate-ev" title="ctrlstate"><a href="/rw/panel/ctrl-state" rel="self"></a><span class="ctrlstate">motoron</span></li>',
  '/rw/panel/opmode': '<li class="pnl-opmode-ev" title="opmode"><a href="/rw/panel/opmode" rel="self"></a><span class="opmode">AUTO</span></li>',
  '/rw/panel/speedratio': '<li class="pnl-speedratio-ev" title="speedratio"><a href="/rw/panel/speedratio" rel="self"></a><span class="speedratio">100</span></li>',
  '/rw/rapid/execution': '<li class="rap-ctrlexecstate-ev" title="ctrlexecstate"><a href="/rw/rapid/execution;ctrlexecstate" rel="self"></a><span class="ctrlexecstate">stopped</span></li>',
  '/rw/panel/coldetstate': '<li class="pnl-coldetstate-ev" title="coldetstate"><a href="/rw/panel/coldetstate" rel="self"></a><span class="coldetstate">INIT</span></li>',
  '/rw/elog/0': '<li class="elog-message-ev" title="message"><a href="/rw/elog/0/52" rel="self"></a><span class="seqnum">52</span></li>',
};
const ALL_2 = Object.keys(ENTRY_2);

/** An RWS 2.0 create answer for group `id`: initial events for every resource but `refused`, a status block for each of those. */
function created2(id: number, port: number, refused: string[]): string {
  const status = refused.map(r => `<div class="status"> <a href="${r}" rel="self"> </a> <span class="code">-1073445866</span> `
    + '<span class="msg">Invalid resource URI in Create Subscription request</span></div> ').join('');
  const bound = ALL_2.filter(p => !refused.some(r => r.split(';')[0] === p));
  return '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head><base href="https://127.0.0.1:80/"/> </head> <body> '
    + `${status}<div class="state"><a href="subscription/${id}" rel="group"></a><a href="ws://127.0.0.1:${port}/poll/${id}" rel="self"></a> <ul> `
    + bound.map(b => ENTRY_2[b]).join(' ') + ' </ul> </div> </body></html>';
}

/** A local RWS 2.0 stand-in: the nth POST /subscription gets `refusedFor(n)` refused; WebSocket upgrades open. */
async function startServer(refusedFor: (n: number) => string[]) {
  const posts: string[] = [];
  const deletes: string[] = [];
  const gets: string[] = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/subscription') {
        posts.push(Buffer.concat(chunks).toString('utf8'));
        const n = posts.length;
        res.writeHead(201, { Location: `ws://127.0.0.1:${port}/poll/${n}`, 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end(created2(n, port, refusedFor(n)));
        return;
      }
      if (req.method === 'DELETE') { deletes.push(req.url ?? ''); res.writeHead(200); res.end(); return; }
      if (req.method === 'GET') {
        gets.push(req.url ?? '');
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
  return { port, posts, deletes, gets, sockets, close: () => { wss.close(); server.close(); } };
}

const tuning = Rws2Core as unknown as { WS_RECONNECT_BASE_MS: number };
const baseMs = tuning.WS_RECONNECT_BASE_MS;
afterEach(() => { tuning.WS_RECONNECT_BASE_MS = baseMs; });

describe('RWS 2.0 subscribe: a resource the controller did not bind', () => {
  it('keeps the group and names /rw/elog/0 on the handle as unbound (one POST, no read, no delete)', async () => {
    const s = await startServer(() => ['/rw/elog/0']);
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const handle = await client.subscribe([...MANAGER_RESOURCES], () => {});
      expect(s.posts).toHaveLength(1);
      expect(s.gets).toEqual([]);
      expect(s.deletes).toEqual([]);
      expect(handle.groupPath).toBe('/subscription/1');
      expect(handle.unbound).toEqual(['/rw/elog/0']);
      expect(warns).toEqual(['RWS2 subscription: the controller did not bind /rw/elog/0']);
      await handle();
    } finally { s.close(); }
  });

  it('a group that binds every resource has nothing unbound', async () => {
    const s = await startServer(() => []);
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const handle = await client.subscribe([...MANAGER_RESOURCES], () => {});
      expect(handle.unbound).toEqual([]);
      expect(warns).toEqual([]);
      await handle();
    } finally { s.close(); }
  });

  it('a subscribe with nothing to subscribe has nothing unbound', async () => {
    const client = new RwsClient2('http://127.0.0.1:1', 'u', 'p');
    const handle = await client.subscribe([], () => {});
    expect(handle.groupPath).toBe('');
    expect(handle.unbound).toEqual([]);
  });

  it('after a re-create for a panel spelling, only the kept group\'s answer counts', async () => {
    // First answer: speedratio refused in the suffixed spelling; second (bare): the event log refused.
    const s = await startServer(n => (n === 1 ? ['/rw/panel/speedratio;speedratio'] : ['/rw/elog/0']));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const handle = await client.subscribe([...MANAGER_RESOURCES], () => {});
      expect(s.posts).toHaveLength(2);
      expect(s.deletes).toEqual(['/subscription/1']);
      expect(handle.unbound).toEqual(['/rw/elog/0']);
      await handle();
    } finally { s.close(); }
  });

  it('each group a reconnect creates is judged on its own answer, read live on the handle', async () => {
    tuning.WS_RECONNECT_BASE_MS = 20;
    const s = await startServer(n => (n === 1 ? ['/rw/elog/0'] : []));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      let restored = 0;
      const handle = await client.subscribe([...MANAGER_RESOURCES], () => {}, undefined, () => { restored++; });
      expect(handle.unbound).toEqual(['/rw/elog/0']);
      await until(() => s.sockets.length >= 1);
      s.sockets[0].terminate();
      await until(() => restored === 1, 20000);
      expect(s.posts).toHaveLength(2);
      expect(handle.groupPath).toBe('/subscription/2');
      expect(handle.unbound).toEqual([]);
      await handle();
    } finally { s.close(); }
  });

  it('a stream given up holds no group: groupPath and unbound both read empty', async () => {
    const s = await startServer(() => ['/rw/elog/0']);
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      let lost = 0;
      const handle = await client.subscribe([...MANAGER_RESOURCES], () => {}, () => { lost++; }, undefined,
        { reconnectBaseMs: 5, maxReconnectAttempts: 2 });
      expect(handle.unbound).toEqual(['/rw/elog/0']);
      await until(() => s.sockets.length >= 1);
      // The server is gone, so every reconnect fails until the subscriber gives up.
      s.close();
      s.sockets[0].terminate();
      await until(() => lost === 1, 15000);
      expect(handle.groupPath).toBe('');
      expect(handle.unbound).toEqual([]);
      await handle();
    } finally { s.close(); }
  }, 20000);
});
