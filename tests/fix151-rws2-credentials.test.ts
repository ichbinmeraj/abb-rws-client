import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';

// RWS 2.0 sends the Basic credentials only until it holds a session cookie,
// then the cookie alone; the credentials go out again only after the
// controller answered 401 to the cookie (the session is gone: an idle expiry,
// a restart, a logout), once, without the cookie. Until 1.5.1 every request
// carried the credentials beside the cookie, the subscription POST too.
//
// The controller below keeps sessions as RW 7.21.4 and 8.2.1 did on
// 2026-09-29: a request with the cookie of a live session is taken whatever
// else it carries; one without (or with a dead one) and with correct Basic
// credentials logs in, and the answer sets a new -http-session- and ABBCX;
// anything else answers 401 "Login required" with a Basic challenge and no
// Set-Cookie. On RobotWare 8 a session registers as a control station before
// it may request write access (403 -1073435871 otherwise). A login can be
// made slow (setLoginDelay), a 401 can set a cookie of its own (cookieOn401;
// the VCs set none), and GET /held answers after HELD_MS, as a DIPC read
// waiting for a message does.

interface Seen { t: number; method: string; url: string; auth: boolean; cookie: string; body: string; status: number }

interface Controller {
  port: number;
  url: string;
  seen: Seen[];
  upgrades: Array<{ auth: boolean; cookie: string; accepted: boolean }>;
  /** End every session, as an idle expiry or a restart does. */
  expireAll(): void;
  /** Refuse the Basic credentials from now on (a changed password). */
  rejectCredentials(on: boolean): void;
  /** Answer every login this many ms late (0: at once). */
  setLoginDelay(ms: number): void;
  /** The sessions the controller still knows. */
  liveSessions(): string[];
  /** Sessions logged in so far. */
  readonly logins: number;
  close(): Promise<void>;
}

/** How long GET /held keeps a live session's request open before it answers. */
const HELD_MS = 1500;

const BASIC = 'Basic ' + Buffer.from('u:p').toString('base64');
const NOT_A_STATION = '{"_links":{"base":{"href":"http://x/"}},"status":{"code":-1073435871,'
  + '"msg":"rws_resource_controlstation.cpp[1] Session is not part of a Control Station code:-1073435871 icode:-20101"}}';

async function startController(rwversion: string, opts: { cookieOn401?: boolean } = {}): Promise<Controller> {
  const seen: Seen[] = [];
  const upgrades: Controller['upgrades'] = [];
  const live = new Set<string>();
  const registered = new Set<string>();
  let logins = 0;
  let refuse = false;
  let groups = 0;
  let port = 0;
  let loginDelay = 0;
  let refusals = 0;

  const sessionOf = (cookie: string): string | undefined => /-http-session-=([^;]+)/.exec(cookie)?.[1];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = req.method ?? '';
      const url = req.url ?? '';
      const cookie = String(req.headers.cookie ?? '');
      const auth = req.headers.authorization;
      const entry: Seen = { t: Date.now(), method, url, auth: auth !== undefined, cookie, body: Buffer.concat(chunks).toString('utf8'), status: 0 };
      seen.push(entry);
      const answer = (status: number, headers: http.OutgoingHttpHeaders = {}, body = ''): void => {
        entry.status = status;
        res.writeHead(status, headers);
        res.end(body);
      };

      let found = sessionOf(cookie);
      const headers: http.OutgoingHttpHeaders = {};
      let delay = 0;
      if (found === undefined || !live.has(found)) {
        if (auth !== BASIC || refuse) {
          const refused: http.OutgoingHttpHeaders = { 'WWW-Authenticate': 'Basic realm="validusers@robapi.abb"', 'Content-Type': 'text/plain' };
          if (opts.cookieOn401) { refusals += 1; refused['Set-Cookie'] = [`-http-session-=R${refusals}; path=/`]; }
          answer(401, refused, 'Access denied. Login required');
          return;
        }
        logins += 1;
        found = `S${logins}`;
        live.add(found);
        headers['Set-Cookie'] = [`-http-session-=${found}; path=/`, `ABBCX=X${logins}; path=/`];
        delay = loginDelay;
      }
      const session = found;
      if (delay > 0) { setTimeout(() => route(session, headers, method, url, answer), delay); } else { route(session, headers, method, url, answer); }
    });
  });

  function route(
    session: string, headers: http.OutgoingHttpHeaders, method: string, url: string,
    answer: (status: number, headers?: http.OutgoingHttpHeaders, body?: string) => void,
  ): void {
    const path = url.split('?')[0];
    if (path === '/held') {
      setTimeout(() => answer(200, { ...headers, 'Content-Type': 'application/hal+json;v=2.0' }, '{"_links":{},"state":[]}'), HELD_MS);
      return;
    }
    if (path === '/logout') { live.delete(session); answer(204, headers); return; }
    if (path === '/rw/system') {
      answer(200, { ...headers, 'Content-Type': 'application/hal+json;v=2.0' }, JSON.stringify({
        _links: { self: { href: '/rw/system' } },
        state: [{ _type: 'sys-system', _title: 'system', rwversion, name: 'MOCK' }],
      }));
      return;
    }
    if (path === '/rw/panel/ctrl-state') {
      answer(200, { ...headers, 'Content-Type': 'application/hal+json;v=2.0' }, JSON.stringify({
        _links: { self: { href: '/rw/panel/ctrl-state' } },
        state: [{ _type: 'pnl-ctrlstate', _title: 'ctrl-state', ctrlstate: 'motoron' }],
      }));
      return;
    }
    if (path.startsWith('/rw/mastership') && rwversion.startsWith('8')) { answer(410, headers); return; }
    if (path === '/rw/controlstation/register/remote') { registered.add(session); answer(204, headers); return; }
    if (path === '/rw/controlstation/writeaccess/request' && !registered.has(session)) {
      answer(403, { ...headers, 'Content-Type': 'application/hal+json;v=2.0' }, NOT_A_STATION);
      return;
    }
    if (method === 'POST' && path === '/subscription') {
      groups += 1;
      answer(201, {
        ...headers,
        Location: `ws://127.0.0.1:${port}/poll/${groups}`,
        'Content-Type': 'application/xhtml+xml;v=2.0',
      }, `<html><body><div class="state"><a href="subscription/${groups}" rel="group"></a>`
        + `<a href="ws://127.0.0.1:${port}/poll/${groups}" rel="self"></a></div></body></html>`);
      return;
    }
    if (method === 'GET') {
      answer(200, { ...headers, 'Content-Type': 'application/hal+json;v=2.0' }, '{"_links":{},"state":[]}');
      return;
    }
    answer(method === 'DELETE' ? 200 : 204, headers);
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const cookie = String(req.headers.cookie ?? '');
    const session = sessionOf(cookie);
    const accepted = session !== undefined && live.has(session);
    upgrades.push({ auth: req.headers.authorization !== undefined, cookie, accepted });
    if (!accepted) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => { ws.on('error', () => undefined); });
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    seen,
    upgrades,
    expireAll: () => { live.clear(); registered.clear(); },
    rejectCredentials: (on: boolean) => { refuse = on; },
    setLoginDelay: (ms: number) => { loginDelay = ms; },
    liveSessions: () => [...live],
    get logins() { return logins; },
    close: () => new Promise<void>(resolve => {
      for (const c of wss.clients) { c.terminate(); }
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The protected one-request path, for a plain write the tests can name, and a request held open (holdMs). */
type WithReq = {
  req(
    method: string, path: string, body?: Record<string, string>, rawBody?: string, rawContentType?: string,
    acceptExtra?: number[], acceptOverride?: string, onHeaders?: undefined, holdMs?: number,
  ): Promise<string>;
};

const open: Array<{ client?: RwsClient2; controller: Controller }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.client?.disconnect().catch(() => undefined);
    await o.controller.close();
  }
});

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const sessionOf = (cookie: string): string | undefined => /-http-session-=([^;]+)/.exec(cookie)?.[1];

async function setUp(rwversion = '7.21.4+417', opts: { cookieOn401?: boolean } = {}): Promise<{ client: RwsClient2; controller: Controller }> {
  const controller = await startController(rwversion, opts);
  const client = new RwsClient2(controller.url, 'u', 'p', { timeout: 3000 });
  open.push({ client, controller });
  return { client, controller };
}

describe('RwsClient2: the Basic credentials only until a session cookie is held', () => {
  it('the login request carries the credentials; every request after it the cookie alone, writes too', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    const afterConnect = controller.seen.length;
    for (let i = 0; i < 3; i += 1) { expect(await client.getControllerState()).toBe('motoron'); }
    await (client as unknown as WithReq).req('POST', '/rw/panel/speedratio', { 'speed-ratio': '50' });

    expect(controller.seen[0]).toMatchObject({ url: '/rw/system', auth: true, cookie: '' });
    const later = controller.seen.slice(1);
    expect(later.length).toBeGreaterThanOrEqual(afterConnect - 1 + 4);
    expect(later.filter(r => r.auth).map(r => `${r.method} ${r.url}`)).toEqual([]);
    expect(later.every(r => r.cookie.includes('-http-session-=S1'))).toBe(true);
    expect(controller.logins).toBe(1);
  });

  it('the subscription POST carries the cookie alone, and so does the WebSocket upgrade', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    const unsubscribe = await client.subscribe(['controllerstate'], () => undefined);
    try {
      const post = controller.seen.find(r => r.method === 'POST' && r.url === '/subscription');
      expect(post).toMatchObject({ auth: false, status: 201 });
      expect(post!.cookie).toContain('-http-session-=S1');
      expect(controller.upgrades).toHaveLength(1);
      expect(controller.upgrades[0]).toMatchObject({ auth: false, accepted: true });
      expect(controller.upgrades[0].cookie).toContain('-http-session-=S1');
      expect(controller.logins).toBe(1);
    } finally {
      await unsubscribe();
    }
  });

  it('a 401 to the cookie: one login (GET /rw/system with the credentials and without the cookie), then the request once more with the new cookie alone', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    await client.getControllerState();
    controller.expireAll();

    const before = controller.seen.length;
    expect(await client.getControllerState()).toBe('motoron');
    // The new session also makes the client read the HeartBeat configuration
    // again (RobotWare 7.8 and later), in the background; only the state
    // reads and the login are counted here.
    const reads = (from: number): Seen[] => controller.seen.slice(from).filter(r => r.url.startsWith('/rw/panel/ctrl-state'));
    const call = reads(before);
    expect(call.map(r => [r.url, r.status, r.auth, sessionOf(r.cookie)])).toEqual([
      ['/rw/panel/ctrl-state', 401, false, 'S1'],
      ['/rw/panel/ctrl-state', 200, false, 'S2'],
    ]);
    const logins = controller.seen.slice(before).filter(r => r.auth);
    expect(logins.map(r => [r.method, r.url, r.status, r.cookie])).toEqual([['GET', '/rw/system', 200, '']]);
    expect(controller.seen.indexOf(logins[0])).toBeLessThan(controller.seen.indexOf(call[1]));
    expect(client.getSessionCookie()).toContain('-http-session-=S2');

    const next = controller.seen.length;
    await client.getControllerState();
    expect(reads(next).map(r => [r.status, r.auth, sessionOf(r.cookie)])).toEqual([[200, false, 'S2']]);
    expect(controller.seen.slice(before).filter(r => r.auth)).toHaveLength(1);
    expect(controller.logins).toBe(2);
  });

  it('a write answered 401 to the cookie is sent once more after the login, with its body and the new cookie (the 401 means it was not taken)', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();

    const before = controller.seen.length;
    await (client as unknown as WithReq).req('POST', '/rw/panel/speedratio', { 'speed-ratio': '42' });
    const call = controller.seen.slice(before).filter(r => r.method === 'POST' || r.auth);
    expect(call.map(r => [r.method, r.url, r.status, r.auth, sessionOf(r.cookie) ?? ''])).toEqual([
      ['POST', '/rw/panel/speedratio', 401, false, 'S1'],
      ['GET', '/rw/system', 200, true, ''],
      ['POST', '/rw/panel/speedratio', 204, false, 'S2'],
    ]);
    expect(call.filter(r => r.method === 'POST').map(r => r.body)).toEqual(['speed-ratio=42', 'speed-ratio=42']);
  });

  it('a request held open that meets the 401 does not hold the others: a stop sent meanwhile goes out at once on the new session', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();

    const t0 = Date.now();
    const held = (client as unknown as WithReq).req('GET', '/held', undefined, undefined, undefined, [], undefined, undefined, 5000);
    await sleep(300);
    await (client as unknown as WithReq).req('POST', '/rw/rapid/execution/stop', { stopmode: 'stop' });
    const stopped = Date.now() - t0;
    await held;

    // The held request is answered HELD_MS after it reached the controller
    // again; the stop must not wait for that.
    expect(stopped).toBeLessThan(HELD_MS);
    const stop = controller.seen.filter(r => r.url.startsWith('/rw/rapid/execution/stop'));
    expect(stop.map(r => [r.status, r.auth, sessionOf(r.cookie)])).toEqual([[204, false, 'S2']]);
    const heldSeen = controller.seen.filter(r => r.url === '/held');
    expect(heldSeen.map(r => [r.status, r.auth, sessionOf(r.cookie)])).toEqual([[401, false, 'S1'], [200, false, 'S2']]);
    expect(controller.logins).toBe(2);
  });

  it('a cookie set on a 401 is not kept: the login still carries the credentials and the next requests the cookie it brought', async () => {
    const { client, controller } = await setUp('7.21.4+417', { cookieOn401: true });
    await client.connect();
    controller.expireAll();

    const before = controller.seen.length;
    expect(await client.getControllerState()).toBe('motoron');
    expect(client.getSessionCookie()).toContain('-http-session-=S2');
    expect(await client.getControllerState()).toBe('motoron');
    const reads = controller.seen.slice(before).filter(r => r.url.startsWith('/rw/panel/ctrl-state'));
    expect(reads.map(r => [r.status, sessionOf(r.cookie)])).toEqual([[401, 'S1'], [200, 'S2'], [200, 'S2']]);
    expect(controller.seen.slice(before).filter(r => r.auth).map(r => [r.url, r.status, r.cookie])).toEqual([['/rw/system', 200, '']]);
    expect(controller.seen.some(r => r.cookie.includes('-http-session-=R'))).toBe(false);
    expect(controller.logins).toBe(2);
  });

  it('disconnect() while the login after a 401 is on its way: /logout goes out after it and ends the new session', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();
    controller.setLoginDelay(600);

    const read = client.getControllerState().then(() => null, (e: unknown) => e);
    await sleep(250);
    await client.disconnect();
    await read;

    const logouts = controller.seen.filter(r => r.url === '/logout');
    expect(logouts.map(r => [r.status, r.auth, sessionOf(r.cookie)])).toEqual([[204, false, 'S2']]);
    expect(controller.logins).toBe(2);
    expect(controller.liveSessions()).toEqual([]);
  });

  it('a subscribe started while the login is on its way waits for it: one login, and the group, the upgrade and the client share the new session', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();
    controller.setLoginDelay(600);

    const read = client.getControllerState();
    await sleep(150);
    const unsubscribe = await client.subscribe(['controllerstate'], () => undefined);
    try {
      await read;
      expect(controller.logins).toBe(2);
      const posts = controller.seen.filter(r => r.method === 'POST' && r.url === '/subscription');
      expect(posts.map(r => [r.status, r.auth, sessionOf(r.cookie)])).toEqual([[201, false, 'S2']]);
      expect(controller.upgrades.map(u => [u.accepted, sessionOf(u.cookie)])).toEqual([[true, 'S2']]);
      expect(client.getSessionCookie()).toContain('-http-session-=S2');
    } finally {
      await unsubscribe();
    }
  });

  it('the requests that waited for the login go out paced, not all at once', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();
    controller.setLoginDelay(1000);

    const first = client.getControllerState();
    await sleep(150);
    const rest = [1, 2, 3, 4, 5, 6].map(() => client.getControllerState());
    expect(await Promise.all([first, ...rest])).toEqual(Array(7).fill('motoron'));

    const times = controller.seen.filter(r => r.url.startsWith('/rw/panel/ctrl-state') && r.status === 200).map(r => r.t);
    expect(times).toHaveLength(7);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    // The client keeps 100 ms between requests; timers and the loopback
    // jitter a little, so the check is well under that and far above 0.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60);
    expect(controller.logins).toBe(2);
  });

  it('credentials refused after the session ended: AUTH_FAILED after one login attempt, then one request per call', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();
    controller.rejectCredentials(true);

    const costs: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const before = controller.seen.length;
      const err = await client.getControllerState().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).code).toBe('AUTH_FAILED');
      expect((err as RwsError).httpStatus).toBe(401);
      costs.push(controller.seen.length - before);
    }
    expect(costs).toEqual([2, 1, 1]);
    // After the first call nothing carries the dead cookie.
    expect(controller.seen.slice(-2).every(r => r.auth && r.cookie === '')).toBe(true);
    // And nothing keeps asking once the calls settled.
    const settled = controller.seen.length;
    await new Promise(r => setTimeout(r, 400));
    expect(controller.seen.length).toBe(settled);
  });

  it('/logout answered 401 is not sent again: there is no session left to end', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();

    await client.disconnect();
    const logouts = controller.seen.filter(r => r.url === '/logout');
    expect(logouts.map(r => [r.status, r.auth])).toEqual([[401, false]]);
    expect(controller.seen[controller.seen.length - 1].url).toBe('/logout');
    expect(controller.logins).toBe(1);
  });

  it('requests in flight when the session ended log in once, not once each', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();

    const before = controller.seen.length;
    const states = await Promise.all([1, 2, 3, 4].map(() => client.getControllerState()));
    expect(states).toEqual(['motoron', 'motoron', 'motoron', 'motoron']);
    const after = controller.seen.slice(before);
    expect(after.filter(r => r.auth)).toHaveLength(1);
    expect(controller.logins).toBe(2);
    expect(after.filter(r => r.status === 200).every(r => r.auth || r.cookie.includes('-http-session-=S2'))).toBe(true);
  });

  it('a subscription POST answered 401 to the cookie logs in once, is sent again with the new cookie, and the upgrade presents it', async () => {
    const { client, controller } = await setUp();
    await client.connect();
    controller.expireAll();

    const unsubscribe = await client.subscribe(['controllerstate'], () => undefined);
    try {
      const posts = controller.seen.filter(r => r.method === 'POST' && r.url === '/subscription');
      expect(posts.map(r => [r.status, r.auth, sessionOf(r.cookie)])).toEqual([[401, false, 'S1'], [201, false, 'S2']]);
      expect(controller.seen.filter(r => r.auth).map(r => r.url)).toEqual(['/rw/system', '/rw/system']);
      expect(controller.upgrades.map(u => [u.accepted, u.auth])).toEqual([[true, false]]);
      expect(controller.upgrades[0].cookie).toContain('-http-session-=S2');
    } finally {
      await unsubscribe();
    }
  });

  // As before 1.5.1, a write-access request that is itself the first
  // request after the session ended lands on the new session unregistered
  // (403 -1073435871) and the next one registers it; a read first (a
  // manager's poll) re-registers before the write.
  it('RobotWare 8: after the session ended and a read logged in again, the write-access request registers the new session', async () => {
    const { client, controller } = await setUp('8.2.1+1023');
    await client.connect();
    await client.requestMastership('rapid');
    await client.releaseMastership('rapid');
    expect(controller.seen.filter(r => r.url === '/rw/controlstation/register/remote')).toHaveLength(1);
    controller.expireAll();

    expect(await client.getControllerState()).toBe('motoron');
    await client.requestMastership('rapid');
    const registers = controller.seen.filter(r => r.url === '/rw/controlstation/register/remote');
    expect(registers.map(r => [r.status, r.auth, sessionOf(r.cookie)])).toEqual([
      [204, false, 'S1'],
      [204, false, 'S2'],
    ]);
    const requests = controller.seen.filter(r => r.url === '/rw/controlstation/writeaccess/request');
    expect(requests[requests.length - 1]).toMatchObject({ status: 204, auth: false });
    expect(sessionOf(requests[requests.length - 1].cookie)).toBe('S2');
    expect(controller.logins).toBe(2);
    await client.releaseMastership('rapid');
  });
});
