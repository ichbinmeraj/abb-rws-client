import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CUT_CREATE, HttpSession } from '../src/HttpSession.js';
import { RwsClient } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';

// RWS 1.0 sends one request at a time per session, and the subscription group
// create (POST /subscription) waits 10 s for its answer (WsSubscriber.createGroup).
// Up to 1.5.2 a create the controller never answered held Stop RAPID, and every
// request queued behind it, for those 10 s. Now Stop RAPID, motors off, deleting
// a group and /logout cut short every create queued before them (one in flight
// is aborted, one not yet sent is never sent), and a mastership or RMMP release
// cuts the ones not yet sent.
// The stub controller here never answers a create. The stop must go out
// within STOP_BOUND_MS of the call; up to 1.5.2 it went out after 10 s.

const forced = vi.hoisted(() => ({ transport: undefined as 'fetch' | 'node:http' | undefined }));
vi.mock('../src/badPorts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/badPorts.js')>();
  return {
    ...actual,
    fetchRefusesUrl: (baseUrl: string): boolean =>
      forced.transport === undefined ? actual.fetchRefusesUrl(baseUrl) : forced.transport === 'node:http',
  };
});
const TRANSPORTS = ['fetch', 'node:http'] as const;

/** The longest a reducing request may wait behind an unanswered create: one request interval (100 ms) and the stub's own time, with room for a loaded test run. */
const STOP_BOUND_MS = 1000;

const STOP = 'POST /rw/rapid/execution?action=stop';
const CREATE = 'POST /subscription';

let server: http.Server | null = null;
afterEach(async () => {
  forced.transport = undefined;
  server?.closeAllConnections();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/**
 * A controller that never answers a create and answers everything else at
 * once (a GET of `/slow` after 300 ms). `seen` records each request with the
 * time it arrived.
 */
async function silentOnCreate(): Promise<{ port: number; seen: Array<{ what: string; at: number }> }> {
  const seen: Array<{ what: string; at: number }> = [];
  server = http.createServer((req, res) => {
    const what = `${req.method} ${req.url}`;
    seen.push({ what, at: Date.now() });
    req.resume();
    if (what === CREATE) { return; }
    const answer = (): void => {
      res.writeHead(what.startsWith('POST') ? 204 : 200, { 'Content-Type': 'application/xhtml+xml' });
      res.end(what.startsWith('POST') ? undefined : '<html><body><div class="state"><ul><li class="pnl-ctrlstate"><span class="ctrlstate">motoron</span></li></ul></div></body></html>');
    };
    if (req.url === '/slow') { setTimeout(answer, 300); } else { answer(); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, seen };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) { throw new Error('condition not met in time'); }
    await new Promise(r => setTimeout(r, 5));
  }
}

const caught = (p: Promise<unknown>): Promise<RwsError> => p.then(() => { throw new Error('resolved'); }, (e: unknown) => e as RwsError);

describe.each(TRANSPORTS)('RWS 1.0 reducing requests past an unanswered subscription create (%s)', (transport) => {
  it(`Stop RAPID goes out within ${STOP_BOUND_MS} ms; the create fails as cut short`, async () => {
    forced.transport = transport;
    const { port, seen } = await silentOnCreate();
    const client = new RwsClient({ host: '127.0.0.1', port, username: 'u', password: 'p' });
    await client.connect();
    const subscribed = caught(client.subscribe(['execution'], () => {}));
    await until(() => seen.some(s => s.what === CREATE));

    const calledAt = Date.now();
    await client.stopRapid();
    const stop = seen.find(s => s.what === STOP)!;
    expect(stop.at - calledAt).toBeLessThan(STOP_BOUND_MS);

    const err = await subscribed;
    expect(err).toBeInstanceOf(RwsError);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toBe(`${CUT_CREATE}${STOP}`);
    expect(seen.map(s => s.what)).toEqual(['GET /rw/panel/ctrlstate', CREATE, STOP]);
  });

  it('disconnect sends /logout at once instead of after the create\'s 10 s', async () => {
    forced.transport = transport;
    const { port, seen } = await silentOnCreate();
    const client = new RwsClient({ host: '127.0.0.1', port, username: 'u', password: 'p' });
    await client.connect();
    const subscribed = caught(client.subscribe(['execution'], () => {}));
    await until(() => seen.some(s => s.what === CREATE));

    const calledAt = Date.now();
    await client.disconnect();
    expect(Date.now() - calledAt).toBeLessThan(STOP_BOUND_MS);
    expect(seen.at(-1)?.what).toBe('GET /logout');
    expect((await subscribed).message).toBe(`${CUT_CREATE}GET /logout`);
  });

  it('a create queued behind another request is never sent when a reducing request is queued after it', async () => {
    forced.transport = transport;
    const { port, seen } = await silentOnCreate();
    const session = new HttpSession({ baseUrl: `http://127.0.0.1:${port}`, username: 'u', password: 'p', requestIntervalMs: 0, timeoutMs: 5000 });
    const slow = session.get('/slow');
    const create = caught(session.post('/subscription', 'resources=1&1=/rw/rapid/execution;ctrlexecstate&1-p=1', 5000));
    const stop = session.post('/rw/rapid/execution?action=stop', 'stopmode=stop');
    await slow;
    expect((await stop).status).toBe(204);
    expect((await create).message).toBe(`${CUT_CREATE}${STOP}`);
    // Still one at a time and in order: the slow read, then the stop.
    expect(seen.map(s => s.what)).toEqual(['GET /slow', STOP]);
  });
});

describe('RWS 1.0: which requests cut a create short', () => {
  const body = 'resources=1&1=/rw/rapid/execution;ctrlexecstate&1-p=1';
  const session = (port: number, timeoutMs: number): HttpSession =>
    new HttpSession({ baseUrl: `http://127.0.0.1:${port}`, username: 'u', password: 'p', requestIntervalMs: 0, timeoutMs });

  it.each([
    ['POST', '/rw/rapid/execution?action=stop', 'stopmode=stop'],
    ['POST', '/rw/panel/ctrlstate?action=setctrlstate', 'ctrl-state=motoroff'],
    ['DELETE', '/subscription/7', undefined],
    ['GET', '/logout', undefined],
  ])('%s %s cuts a create already sent', async (method, path, reqBody) => {
    const { port, seen } = await silentOnCreate();
    const s = session(port, 5000);
    const create = caught(s.post('/subscription', body, 5000));
    await until(() => seen.some(x => x.what === CREATE));
    const reducing = method === 'GET' ? s.get(path) : method === 'DELETE' ? s.delete(path) : s.post(path, reqBody);
    expect((await reducing).status).toBeLessThan(300);
    expect((await create).message).toBe(`${CUT_CREATE}${method} ${path}`);
  });

  it.each([
    ['POST', '/rw/mastership/rapid?action=release'],
    ['POST', '/rw/mastership/motion?action=release'],
    ['POST', '/rw/mastership?action=release&json=1'],
    ['POST', '/users/rmmp?action=cancel&json=1'],
  ])('%s %s cuts a create not yet sent, and waits for one already sent', async (method, path) => {
    const { port, seen } = await silentOnCreate();
    // Not yet sent: queued behind a slow read, never sent.
    const s = session(port, 5000);
    const slow = s.get('/slow');
    const queued = caught(s.post('/subscription', body, 5000));
    const release = s.post(path, '');
    await slow;
    expect((await release).status).toBe(204);
    expect((await queued).message).toBe(`${CUT_CREATE}${method} ${path}`);
    expect(seen.map(x => x.what)).toEqual(['GET /slow', `${method} ${path}`]);
    // Already sent: the release waits for its answer (here its timeout).
    seen.length = 0;
    const t = session(port, 100);
    const sent = caught(t.post('/subscription', body, 100));
    await until(() => seen.some(x => x.what === CREATE));
    const after = t.post(path, '', 2000);
    expect((await sent).message).toBe('Request timed out after 200ms: POST /subscription');
    await after;
    expect(seen.map(x => x.what)).toEqual([CREATE, `${method} ${path}`]);
  });

  it.each([
    ['POST', '/rw/panel/ctrlstate?action=setctrlstate', 'ctrl-state=motoron'],
    ['POST', '/rw/mastership/rapid?action=request', ''],
    ['POST', '/rw/rapid/execution?action=start', 'regain=continue'],
    ['GET', '/rw/panel/ctrlstate', undefined],
  ])('%s %s waits for it, as before', async (method, path, reqBody) => {
    const { port, seen } = await silentOnCreate();
    const s = session(port, 100);
    const create = caught(s.post('/subscription', body, 100));
    await until(() => seen.some(x => x.what === CREATE));
    // A longer wait for this one, so a loaded test run does not time it out.
    const other = method === 'GET' ? s.get(path, 2000) : s.post(path, reqBody, 2000);
    expect((await create).message).toBe('Request timed out after 200ms: POST /subscription');
    await other;
    expect(seen.map(x => x.what)).toEqual([CREATE, `${method} ${path}`]);
  });

  it('a request queued before the reducing one keeps its turn, and a create queued after it is sent', async () => {
    const { port, seen } = await silentOnCreate();
    const s = session(port, 5000);
    const create = caught(s.post('/subscription', body, 5000));
    await until(() => seen.some(x => x.what === CREATE));
    const read = s.get('/rw/panel/ctrlstate');
    const stop = s.post('/rw/rapid/execution?action=stop', 'stopmode=stop');
    const later = caught(s.post('/subscription', body, 5000));
    await Promise.all([read, stop]);
    expect((await create).message).toBe(`${CUT_CREATE}${STOP}`);
    await until(() => seen.filter(x => x.what === CREATE).length === 2);
    expect(seen.map(x => x.what)).toEqual([CREATE, 'GET /rw/panel/ctrlstate', STOP, CREATE]);
    server?.closeAllConnections();
    await later;
  });
});
