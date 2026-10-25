import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpSession } from '../src/HttpSession.js';
import { RwsError } from '../src/types.js';
import { answer, scriptedServer, type RecordedRequest, type ScriptedServer } from './helpers/scriptedHttp.js';

// RWS 1.0: the cookies a 401 sets are not the session's. They go out with
// the same request's next attempt (the digest answer) and become the
// session's only when an answer to that request is not a 401; the final
// AUTH_FAILED drops them. From 2026-10-22 until 1.5.1 every answer's cookies
// were kept as the session's, a 401's too: on a controller that sets a new
// -http-session- on every 401, each rejected call after the first then
// started with a "held" cookie, cost a third request (the fresh-session
// attempt) and reported a replaced session. RW 6.16.03 sets no cookie on a
// 401; the controller here is scripted.
//
// Both transports run, as in HttpSession.test.ts: fetch on a port it
// accepts, node:http on one it refuses.

const forced = vi.hoisted(() => ({ transport: undefined as 'fetch' | 'node:http' | undefined }));

vi.mock('../src/badPorts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/badPorts.js')>();
  return {
    ...actual,
    fetchRefusesUrl: (baseUrl: string): boolean =>
      forced.transport === undefined ? actual.fetchRefusesUrl(baseUrl) : forced.transport === 'node:http',
  };
});

const WWW_AUTH =
  'Digest realm="robot", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth", algorithm=MD5, opaque="5ccc069c403ebaf9f0171e9517f40e41"';

const challenge = (setCookie?: string) => answer(401, '', {
  'www-authenticate': WWW_AUTH,
  ...(setCookie ? { 'set-cookie': setCookie } : {}),
});

const cookieOf = (r: RecordedRequest | undefined): string => r?.headers.cookie ?? '';

for (const transport of ['fetch', 'node:http'] as const) {
  describe(`HttpSession - the cookies of a 401 [${transport}]`, () => {
    let srv: ScriptedServer;
    const why: string[] = [];

    beforeEach(async () => {
      forced.transport = transport;
      why.length = 0;
      srv = await scriptedServer();
    });

    afterEach(async () => {
      forced.transport = undefined;
      await srv.close();
    });

    function makeSession(overrides: Partial<ConstructorParameters<typeof HttpSession>[0]> = {}): HttpSession {
      return new HttpSession({
        baseUrl: srv.baseUrl,
        username: 'Default User',
        password: 'robotics',
        requestIntervalMs: 0,
        timeoutMs: 1000,
        onSessionReplaced: w => why.push(w),
        ...overrides,
      });
    }

    /** A controller that rejects every request and sets a new -http-session- on every 401. */
    function newCookieOnEvery401(): void {
      let n = 0;
      srv.alwaysBy(() => challenge(`-http-session-=N${++n}; path=/`));
    }

    /** Requests per call, for `calls` rejected calls in a row. */
    async function costs(session: HttpSession, calls: number): Promise<number[]> {
      const out: number[] = [];
      for (let i = 0; i < calls; i += 1) {
        const before = srv.requests.length;
        await expect(session.get('/rw/system?json=1')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
        out.push(srv.requests.length - before);
      }
      return out;
    }

    it('wrong credentials, no cookie held: each call costs 2 requests and reports no replaced session', async () => {
      newCookieOnEvery401();
      const session = makeSession({ password: 'wrong' });

      expect(await costs(session, 4)).toEqual([2, 2, 2, 2]);
      expect(why).toEqual([]);
      // The digest answer carries the cookie the first 401 set ...
      expect(cookieOf(srv.requests[1])).toBe('-http-session-=N1');
      // ... and the next call starts without it.
      expect(cookieOf(srv.requests[2])).toBe('');
      expect(session.getSessionCookie()).toBeNull();
    });

    it('wrong credentials with a saved cookie: the first call tries a fresh session once (3), the rest cost 2', async () => {
      newCookieOnEvery401();
      const session = makeSession({ password: 'wrong', sessionCookie: '-http-session-=SAVED' });

      expect(await costs(session, 4)).toEqual([3, 2, 2, 2]);
      expect(why).toEqual([
        'the controller no longer accepted the session cookie, so the request was sent again on a new session',
      ]);
      expect(cookieOf(srv.requests[2])).toBe('');
      expect(session.getSessionCookie()).toBeNull();
    });

    it('a 401 that sets a session cookie, then a 2xx: the cookie is the session\'s, and the change is reported once', async () => {
      const session = makeSession({ sessionCookie: '-http-session-=S1; ABBCX=c1' });
      srv.once(
        challenge('-http-session-=S2; path=/'),
        answer(200, '{}'),
        answer(200, '{}'),
      );

      await session.get('/rw/system?json=1');
      await session.get('/rw/panel/opmode?json=1');

      // The digest answer carries the 401's value in place of the old one.
      expect(cookieOf(srv.requests[1])).toBe('-http-session-=S2; ABBCX=c1');
      expect(cookieOf(srv.requests[2])).toBe('-http-session-=S2; ABBCX=c1');
      expect(session.getSessionCookie()).toBe('-http-session-=S2; ABBCX=c1');
      expect(why).toEqual(['the controller issued a new session cookie']);
    });

    it('the same value on the 401 and on the 2xx after it is one session, not two', async () => {
      const session = makeSession();
      srv.once(
        challenge('-http-session-=A; path=/'),
        answer(200, '{}', { 'set-cookie': '-http-session-=A; path=/' }),
      );

      await session.get('/rw/system?json=1');

      expect(session.getSessionCookie()).toBe('-http-session-=A');
      expect(why).toEqual([]);
    });

    it('a dead saved cookie still recovers on a fresh session, also when the 401s set cookies', async () => {
      const session = makeSession({ sessionCookie: '-http-session-=STALE; ABBCX=1' });
      srv.once(
        challenge('-http-session-=X; path=/'),   // stale cookie, no credentials
        challenge('-http-session-=Y; path=/'),   // digest answer, X in place of STALE
        answer(200, '{}', { 'set-cookie': '-http-session-=FRESH; path=/' }),
        answer(200, '{}'),
      );

      expect((await session.get('/rw/system?json=1')).status).toBe(200);
      await session.get('/rw/system?json=1');

      expect(srv.requests).toHaveLength(4);
      expect(cookieOf(srv.requests[1])).toBe('-http-session-=X; ABBCX=1');
      // The fresh-session attempt carries nothing: neither the dead cookies nor the 401s'.
      expect(cookieOf(srv.requests[2])).toBe('');
      expect(cookieOf(srv.requests[3])).toBe('-http-session-=FRESH');
      expect(why).toEqual([
        'the controller no longer accepted the session cookie, so the request was sent again on a new session',
      ]);
    });

    it('a dead saved cookie with 401s that set none recovers as before (3 requests)', async () => {
      const session = makeSession({ sessionCookie: '-http-session-=STALE; ABBCX=1' });
      srv.once(challenge(), challenge(), answer(200, '{}', { 'set-cookie': '-http-session-=FRESH; path=/' }));

      expect((await session.get('/rw/system?json=1')).status).toBe(200);

      expect(srv.requests).toHaveLength(3);
      expect(cookieOf(srv.requests[1])).toContain('STALE');
      expect(cookieOf(srv.requests[2])).toBe('');
      expect(session.getSessionCookie()).toBe('-http-session-=FRESH');
    });

    it('a 401 without a challenge drops the cookies it set', async () => {
      const session = makeSession();
      srv.once(answer(401, '', { 'set-cookie': '-http-session-=Z; path=/' }), answer(200, '{}'));

      await expect(session.get('/rw/system?json=1')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
      await session.get('/rw/system?json=1');

      expect(cookieOf(srv.requests[1])).toBe('');
      expect(session.getSessionCookie()).toBeNull();
    });

    // The 2026-10-22 drop (RW 6.16.03): the controller let go of the client's
    // ABBCX and answered the first request after it with an error that set
    // the new one. Error answers other than a 401 still give the session its
    // cookies.
    it('the drop recovery still works: a 400 that sets ABBCX, then a POST through a nonce challenge', async () => {
      const session = makeSession({ sessionCookie: '-http-session-=s1; ABBCX=gone' });
      srv.once(
        answer(400, '', { 'Set-Cookie': 'ABBCX=client1; Path=/' }),
        challenge('ABBCX=other; path=/'),
        answer(201, '', { Location: '/poll/68' }),
        answer(200, '{}'),
      );

      await expect(session.delete('/subscription/67')).rejects.toBeInstanceOf(RwsError);
      expect((await session.post('/subscription', 'resources=1')).status).toBe(201);
      await session.get('/rw/system?json=1');

      expect(cookieOf(srv.requests[1])).toBe('-http-session-=s1; ABBCX=client1');
      // The 401's ABBCX went out with the digest answer, which the controller took.
      expect(cookieOf(srv.requests[2])).toBe('-http-session-=s1; ABBCX=other');
      expect(cookieOf(srv.requests[3])).toBe('-http-session-=s1; ABBCX=other');
      expect(why).toEqual([]);
    });

    it('the drop recovery still works: a 503 that sets ABBCX, and its retry carries it', async () => {
      const session = makeSession({ sessionCookie: '-http-session-=s1; ABBCX=gone' });
      srv.once(answer(503, '', { 'Set-Cookie': 'ABBCX=new; Path=/' }), answer(201, ''), answer(200, '{}'));

      expect((await session.post('/subscription', 'resources=1')).status).toBe(201);
      await session.get('/rw/system?json=1');

      expect(cookieOf(srv.requests[1])).toBe('-http-session-=s1; ABBCX=new');
      expect(cookieOf(srv.requests[2])).toBe('-http-session-=s1; ABBCX=new');
    });
  });
}
