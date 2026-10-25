import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpSession } from '../src/HttpSession.js';
import { RwsClient } from '../src/RwsClient.js';
import { accessOf, type AccessObservation } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';
import { answer, scriptedServer, type ScriptedServer } from './helpers/scriptedHttp.js';

/**
 * RWS 1.0: a new controller session holds nothing. HttpSession tells its
 * owner when the session it used was replaced - the fresh-session retry after
 * a 401 that persists with a cookie, or a response that sets a different
 * -http-session- value - and RwsClient records the mastership it counted on
 * the old session as lost, so the next write requests it afresh.
 *
 * The "controller" is a scripted local server, real HTTP whichever transport
 * HttpSession picks (fetch, or node:http on a port fetch refuses).
 */

const WWW_AUTH = 'Digest realm="robot", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth", algorithm=MD5, opaque="5ccc069c403ebaf9f0171e9517f40e41"';
const OPMODE = '<html><body><li class="pnl-opmode"><span class="opmode">AUTO</span></li></body></html>';

const challenge = () => answer(401, '', { 'www-authenticate': WWW_AUTH });

let srv: ScriptedServer;

beforeEach(async () => {
  srv = await scriptedServer();
});

afterEach(async () => {
  await srv.close();
  setLogger({ info() {}, warn() {}, error() {}, show() {} });
});

function session(onSessionReplaced: (why: string) => void, sessionCookie?: string): HttpSession {
  return new HttpSession({
    baseUrl: srv.baseUrl, username: 'Default User', password: 'robotics',
    requestIntervalMs: 0, timeoutMs: 1000, onSessionReplaced,
    ...(sessionCookie ? { sessionCookie } : {}),
  });
}

describe('HttpSession: onSessionReplaced', () => {
  it('fires once on the fresh-session retry', async () => {
    const calls: string[] = [];
    const s = session(why => calls.push(why), '-http-session-=STALE; ABBCX=1');
    srv.once(
      challenge(),
      challenge(),
      answer(200, '{}', { 'set-cookie': '-http-session-=FRESH; path=/' }),
    );
    await s.get('/rw/system?json=1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/new session/);
  });

  it('fires when a response sets a different -http-session- value, not for the first one or the same one', async () => {
    const calls: string[] = [];
    const s = session(why => calls.push(why));
    srv.once(
      challenge(),
      answer(200, '', { 'set-cookie': '-http-session-=A; path=/' }),
      answer(200, '', { 'set-cookie': '-http-session-=A; path=/' }),
      answer(200, '', { 'set-cookie': 'ABBCX=other; path=/' }),
      answer(200, '', { 'set-cookie': '-http-session-=B; path=/' }),
    );
    await s.get('/1');
    await s.get('/2');
    await s.get('/3');
    expect(calls).toEqual([]);
    await s.get('/4');
    expect(calls).toEqual(['the controller issued a new session cookie']);
  });

  it('a throwing handler does not break the request', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const s = session(() => { throw new Error('boom'); }, '-http-session-=OLD');
    srv.once(answer(200, 'ok', { 'set-cookie': '-http-session-=NEW; path=/' }));
    await expect(s.get('/x')).resolves.toMatchObject({ status: 200 });
  });
});

describe('RwsClient: mastership counted on a replaced session is lost', () => {
  function client(): { c: RwsClient; events: AccessObservation[] } {
    const c = new RwsClient({ host: '127.0.0.1', port: srv.port, requestIntervalMs: 0 });
    const events: AccessObservation[] = [];
    accessOf(c)!.on(e => events.push(e));
    return { c, events };
  }

  it('a new -http-session- value: the hold is lost and no longer counted', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const { c, events } = client();
    srv.once(
      challenge(),
      answer(204, '', { 'set-cookie': '-http-session-=A; path=/' }),
      answer(200, OPMODE, { 'set-cookie': '-http-session-=B; path=/' }),
    );
    await c.requestMastership('rapid');
    await c.getOperationMode();
    expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'rapid', reason: 'session-reissued' }));
    expect(accessOf(c)!.count('rapid')).toBe(0);
    expect(accessOf(c)!.snapshot().locks.find(l => l.lock === 'rapid')).toMatchObject({ state: 'lost', lost: { reason: 'session-reissued' } });
  });

  it('the fresh-session retry: the hold is lost once', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const { c, events } = client();
    srv.once(
      challenge(),
      answer(204, '', { 'set-cookie': '-http-session-=A; path=/' }),
      challenge(),
      challenge(),
      answer(200, OPMODE, { 'set-cookie': '-http-session-=B; path=/' }),
    );
    await c.requestMastership('rapid');
    await c.getOperationMode();
    expect(events.filter(e => e.type === 'lost')).toEqual([
      expect.objectContaining({ lock: 'rapid', reason: 'session-reissued' }),
    ]);
  });
});
