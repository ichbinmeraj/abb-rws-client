import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import type { Socket } from 'node:net';
import { HttpSession } from '../src/HttpSession.js';
import { RwsError } from '../src/types.js';
import { answer, listenOnPort, scriptedServer, type RecordedRequest, type ScriptedServer } from './helpers/scriptedHttp.js';

// These drive the real transports against a scripted local server.
// `srv.requests[i]` is the i-th request the "controller" received, as a fetch
// mock's `mock.calls[i]` was before.
//
// HttpSession sends through Node's global fetch on every port fetch accepts
// and through node:http on a port it refuses (src/badPorts.ts). The scripted
// servers listen on free ports that fetch accepts (listenOnPort), so
// `forced.transport` makes the choice for a block of tests: 'node:http'
// sends as for a refused port, 'fetch' as for any other. Every test that
// holds for both runs on both (forEachTransport); undefined leaves the real
// choice, which the transport tests use with real ports.

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
type Transport = typeof TRANSPORTS[number];

/** `body` once per transport, each in a describe of its own that forces it. */
function forEachTransport(name: string, body: (transport: Transport) => void): void {
  for (const transport of TRANSPORTS) {
    describe(`${name} [${transport}]`, () => {
      beforeEach(() => { forced.transport = transport; });
      afterEach(() => { forced.transport = undefined; });
      body(transport);
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

const WWW_AUTH_HEADER =
  'Digest realm="robot", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth", algorithm=MD5, opaque="5ccc069c403ebaf9f0171e9517f40e41"';

const WWW_AUTH_NO_QOP =
  'Digest realm="robot", nonce="simplnonce", algorithm=MD5';

const WWW_AUTH_AUTH_INT_ONLY =
  'Digest realm="robot", nonce="int-only-nonce", qop="auth-int", algorithm=MD5';

const WWW_AUTH_BOTH_QOPS =
  'Digest realm="robot", nonce="both-qops-nonce", qop="auth,auth-int", algorithm=MD5';

const WWW_AUTH_PLAIN =
  'Digest realm="robot", nonce="plain-auth-nonce", qop="auth", algorithm=MD5';

const challenge = (www = WWW_AUTH_HEADER) => answer(401, '', { 'www-authenticate': www });

function makeSession(
  srv: { baseUrl: string },
  overrides: Partial<ConstructorParameters<typeof HttpSession>[0]> = {},
): HttpSession {
  return new HttpSession({
    baseUrl: srv.baseUrl,
    username: 'Default User',
    password: 'robotics',
    requestIntervalMs: 0, // disable rate limiting for tests
    timeoutMs: 1000,
    ...overrides,
  });
}

/** The Authorization header of a recorded request. */
const authOf = (r: RecordedRequest | undefined): string | undefined => r?.headers['authorization'];

/** Recompute the expected qop=auth response hash from the Authorization header fields */
function expectedAuthResponse(auth: string, method: string, uri: string): string {
  const nonce = auth.match(/nonce="([^"]+)"/)![1];
  const nc = auth.match(/\bnc=([0-9a-f]{8})\b/)![1];
  const cnonce = auth.match(/cnonce="([0-9a-f]+)"/)![1];
  const ha1 = md5(`Default User:robot:robotics`);
  const ha2 = md5(`${method}:${uri}`);
  return md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
}

/** Wait until `done()` holds, polling; fails the test after `ms`. */
async function until(done: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise(r => setTimeout(r, 10));
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

forEachTransport('HttpSession - digest authentication', () => {
  let srv: ScriptedServer;
  let session: HttpSession;

  beforeEach(async () => {
    srv = await scriptedServer();
    session = makeSession(srv);
  });

  afterEach(async () => {
    await srv.close();
  });

  it('sends unauthenticated first request, then retries with Authorization on 401', async () => {
    srv.once(challenge(), answer(200, '<html/>'));

    await session.get('/rw/panel/ctrlstate');

    expect(srv.requests).toHaveLength(2);
    expect(authOf(srv.requests[0])).toBeUndefined();
    expect(authOf(srv.requests[1])).toBeDefined();
    expect(authOf(srv.requests[1])).toMatch(/^Digest /);
  });

  it('Authorization header contains realm, nonce, nc, cnonce, response, opaque', async () => {
    srv.once(challenge(), answer(200, ''));

    await session.get('/rw/panel/ctrlstate');

    const auth = authOf(srv.requests[1])!;
    expect(auth).toContain('realm="robot"');
    expect(auth).toContain('nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"');
    expect(auth).toContain('nc=00000001');   // nc is NOT quoted
    expect(auth).toMatch(/cnonce="[0-9a-f]+"/);
    expect(auth).toMatch(/response="[0-9a-f]{32}"/);
    expect(auth).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('nc is NOT quoted in the Authorization header', async () => {
    srv.once(challenge(), answer(200, ''));

    await session.get('/path');

    const auth = authOf(srv.requests[1])!;
    // nc=00000001 (no quotes), NOT nc="00000001"
    expect(auth).toMatch(/\bnc=00000001\b/);
    expect(auth).not.toMatch(/nc="00000001"/);
  });

  it('uri field in Authorization matches the request path, not the full URL', async () => {
    srv.once(challenge(), answer(200, ''));

    await session.get('/rw/rapid/execution?action=start');

    const auth = authOf(srv.requests[1])!;
    expect(auth).toContain('uri="/rw/rapid/execution?action=start"');
    expect(auth).not.toContain('http://'); // full URL must NOT appear in uri field
    // ...and the request itself went to that path and query.
    expect(srv.requests[1].path).toBe('/rw/rapid/execution?action=start');
  });

  it('falls back to RFC 2069 mode (no nc/cnonce/qop) when WWW-Authenticate has no qop', async () => {
    srv.once(challenge(WWW_AUTH_NO_QOP), answer(200, ''));

    await session.get('/path');

    const auth = authOf(srv.requests[1])!;
    expect(auth).toMatch(/^Digest /);
    expect(auth).toMatch(/response="[0-9a-f]{32}"/);
    // In RFC 2069 mode these fields may still be present but qop should not be asserted
  });

  it('throws RwsError AUTH_FAILED when a second 401 is received', async () => {
    srv.always(challenge());

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(session.get('/path')).rejects.toBeInstanceOf(RwsError);
  });

  it('throws RwsError AUTH_FAILED when 401 has no WWW-Authenticate header', async () => {
    srv.once(answer(401, ''));

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('nonce count increments on successive requests with the same challenge', async () => {
    srv.once(
      // First call: 401 + auth challenge
      challenge(),
      answer(200, ''),
      // Second call: no 401 - reuse existing challenge
      answer(200, ''),
    );

    await session.get('/path1');
    await session.get('/path2');

    // Second request should use nc=00000002
    expect(authOf(srv.requests[2])).toMatch(/\bnc=00000002\b/);
  });
});

forEachTransport('HttpSession - digest qop negotiation', () => {
  let srv: ScriptedServer;
  let session: HttpSession;

  beforeEach(async () => {
    srv = await scriptedServer();
    session = makeSession(srv);
  });

  afterEach(async () => {
    await srv.close();
  });

  it('throws AUTH_FAILED naming auth-int when the challenge offers only qop=auth-int', async () => {
    srv.once(challenge(WWW_AUTH_AUTH_INT_ONLY)).always(answer(200, 'should not get here'));

    const err = await session.get('/rw/panel/ctrlstate').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect((err as RwsError).code).toBe('AUTH_FAILED');
    expect((err as RwsError).message).toContain('auth-int');
  });

  it('does not send an Authorization header computed for auth against an auth-int-only challenge', async () => {
    srv.once(challenge(WWW_AUTH_AUTH_INT_ONLY)).always(answer(200, ''));

    await session.get('/path').catch(() => undefined);

    // Only the initial unauthenticated request should have gone out - no retry
    // carrying a bogus qop=auth response for a challenge that never offered auth.
    expect(srv.requests.length).toBeGreaterThan(0);
    for (const r of srv.requests) {
      expect(authOf(r)).toBeUndefined();
    }
  });

  it('picks qop=auth when the challenge offers both auth and auth-int', async () => {
    srv.once(challenge(WWW_AUTH_BOTH_QOPS), answer(200, 'ok'));

    const result = await session.get('/rw/panel/ctrlstate');
    expect(result.body).toBe('ok');

    const auth = authOf(srv.requests[1])!;
    expect(auth).toContain('qop=auth');
    expect(auth).not.toContain('qop=auth-int');
    // The response hash must actually be computed in qop=auth mode - not RFC 2069
    const responseHash = auth.match(/response="([0-9a-f]{32})"/)![1];
    expect(responseHash).toBe(expectedAuthResponse(auth, 'GET', '/rw/panel/ctrlstate'));
  });

  it('still handles a plain qop=auth challenge correctly', async () => {
    srv.once(challenge(WWW_AUTH_PLAIN), answer(200, 'ok'));

    const result = await session.get('/rw/rapid/execution');
    expect(result.body).toBe('ok');

    const auth = authOf(srv.requests[1])!;
    expect(auth).toContain('qop=auth');
    const responseHash = auth.match(/response="([0-9a-f]{32})"/)![1];
    expect(responseHash).toBe(expectedAuthResponse(auth, 'GET', '/rw/rapid/execution'));
  });
});

forEachTransport('HttpSession - cookie handling', () => {
  let srv: ScriptedServer;
  let session: HttpSession;

  beforeEach(async () => {
    srv = await scriptedServer();
    session = makeSession(srv);
  });

  afterEach(async () => {
    await srv.close();
  });

  it('stores ABBCX cookie from Set-Cookie response header', async () => {
    srv.once(
      challenge(),
      answer(200, '', { 'Set-Cookie': 'ABBCX=token123; Path=/' }),
      answer(200, ''),
    );

    await session.get('/path1');
    await session.get('/path2');

    // Third request (path2 authenticated request) should include the cookie
    expect(srv.requests[2].headers.cookie).toContain('ABBCX=token123');
  });

  it('stores -http-session- cookie', async () => {
    srv.once(
      challenge(),
      answer(200, '', { 'Set-Cookie': '-http-session-=sess456; Path=/' }),
      answer(200, ''),
    );

    await session.get('/path1');
    await session.get('/path2');

    expect(srv.requests[2].headers.cookie).toContain('-http-session-=sess456');
  });

  it('sends both cookies when both are set', async () => {
    // Two separate Set-Cookie header lines in one response.
    srv.once(
      challenge(),
      answer(200, '', { 'Set-Cookie': ['ABBCX=abc; Path=/', '-http-session-=xyz; Path=/'] }),
      answer(200, ''),
    );

    await session.get('/path1');
    await session.get('/path2');

    const cookieHeader = srv.requests[2].headers.cookie ?? '';
    expect(cookieHeader).toContain('ABBCX=abc');
    expect(cookieHeader).toContain('-http-session-=xyz');
  });

  it('getCookieHeader returns current cookie string', async () => {
    srv.once(
      challenge(),
      answer(200, '', { 'Set-Cookie': 'ABBCX=cookieVal; Path=/' }),
    );

    await session.get('/path');

    expect(session.getCookieHeader()).toContain('ABBCX=cookieVal');
  });

  it('every Set-Cookie line reaches getSetCookie() and the cookie jar', async () => {
    srv.once(answer(200, 'ok', { 'Set-Cookie': ['ABBCX=one; Path=/', '-http-session-=two; Path=/'] }), answer(200, ''));

    const res = await session.get('/x');

    expect(res.headers).toBeInstanceOf(Headers);
    expect(res.headers.getSetCookie()).toEqual(['ABBCX=one; Path=/', '-http-session-=two; Path=/']);
    await session.get('/y');
    expect(srv.requests[1].headers.cookie).toBe('ABBCX=one; -http-session-=two');
  });
});

forEachTransport('HttpSession - rate limiting', () => {
  let srv: ScriptedServer;

  beforeEach(async () => {
    srv = await scriptedServer();
  });

  afterEach(async () => {
    await srv.close();
  });

  it('enforces minimum interval between requests', async () => {
    const intervalMs = 50;
    const session = makeSession(srv, { requestIntervalMs: intervalMs });
    srv.always(answer(200, ''));

    // One request first, so the three below all go out on an open
    // connection: the times are taken where the requests ARRIVE, and a new
    // connection's setup would skew the first gap.
    await session.get('/warm');

    // Fire 3 requests concurrently; they must be serialised with >= intervalMs gap
    await Promise.all([session.get('/p1'), session.get('/p2'), session.get('/p3')]);

    const timestamps = srv.requests.slice(1).map(r => r.at);
    expect(timestamps).toHaveLength(3);
    if (timestamps.length >= 2) {
      expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(intervalMs - 5); // 5ms tolerance
    }
    if (timestamps.length >= 3) {
      expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(intervalMs - 5);
    }
  });

  it('does not add delay when requestIntervalMs is 0', async () => {
    const session = makeSession(srv, { requestIntervalMs: 0 });
    srv.always(answer(200, ''));

    const start = Date.now();
    await Promise.all([session.get('/p1'), session.get('/p2'), session.get('/p3')]);
    const elapsed = Date.now() - start;

    // Without rate limiting, 3 requests should complete quickly
    expect(elapsed).toBeLessThan(500);
  });

  it('queue continues processing after a failed request', async () => {
    const session = makeSession(srv, { requestIntervalMs: 0 });
    srv.once(answer(500, 'error'), answer(200, 'ok'));

    const p1 = session.get('/fail').catch(() => 'caught');
    const p2 = session.get('/ok');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('caught');
    expect((r2 as { body: string }).body).toBe('ok');
  });
});

forEachTransport('HttpSession - 503 retry', (transport) => {
  let srv: ScriptedServer;
  let session: HttpSession;

  beforeEach(async () => {
    srv = await scriptedServer();
    session = makeSession(srv);
  });

  afterEach(async () => {
    await srv.close();
  });

  it('retries once after 503 and succeeds on the retry', async () => {
    srv.once(challenge(), answer(503, ''), answer(200, 'ok'));

    const result = await session.get('/path');
    expect(result.body).toBe('ok');
    expect(srv.requests).toHaveLength(3);
  });

  it('throws RwsError CONTROLLER_BUSY when 503 persists after retry', async () => {
    srv.once(challenge(), answer(503, ''), answer(503, ''));

    await expect(session.get('/path')).rejects.toMatchObject({
      code: 'CONTROLLER_BUSY',
      httpStatus: 503,
    });
  });

  // Through fetch the connections belong to fetch's pool, which picks them
  // itself; there is no pool of the session's own to empty.
  if (transport === 'node:http') {
    it('the retry goes out on a new connection, and the requests after it stay there', async () => {
      srv.once(answer(200, 'warm'), answer(503, ''), answer(200, 'ok'), answer(200, 'after'));

      await session.get('/warm');
      expect((await session.get('/path')).body).toBe('ok');
      await session.get('/after');

      expect(srv.requests.map(r => r.connection)).toEqual([1, 1, 2, 2]);
    });
  }

  it('the retry carries a cookie the 503 set', async () => {
    srv.once(answer(503, '', { 'Set-Cookie': 'ABBCX=new; Path=/' }), answer(200, 'ok'));

    await session.get('/path');

    expect(srv.requests[1].headers.cookie).toContain('ABBCX=new');
  });
});

forEachTransport('HttpSession - the cookies of an error answer are kept', () => {
  let srv: ScriptedServer;
  let session: HttpSession;

  beforeEach(async () => {
    srv = await scriptedServer();
    session = makeSession(srv, { sessionCookie: '-http-session-=s1; ABBCX=old' });
  });

  afterEach(async () => {
    await srv.close();
  });

  it('the request after a 400 that set ABBCX carries the new value', async () => {
    srv.once(answer(400, '', { 'Set-Cookie': 'ABBCX=new; Path=/' }), answer(201, ''));

    await expect(session.delete('/subscription/67')).rejects.toBeInstanceOf(RwsError);
    await session.post('/subscription', 'resources=1');

    expect(srv.requests[1].headers.cookie).toBe('-http-session-=s1; ABBCX=new');
  });

  it('a different -http-session- on an error answer is a new session', async () => {
    const why: string[] = [];
    session = makeSession(srv, { sessionCookie: '-http-session-=s1', onSessionReplaced: w => why.push(w) });
    srv.once(answer(404, '', { 'Set-Cookie': '-http-session-=s2; Path=/' }));

    await expect(session.get('/rw/missing')).rejects.toBeInstanceOf(RwsError);

    expect(session.getSessionCookie()).toBe('-http-session-=s2');
    expect(why).toEqual(['the controller issued a new session cookie']);
  });
});

// Live 2026-10-22, RW 6.16.03 VC, functional test 10-subscriptions: a relay cut
// every connection of the client, and the subscription never came back. Once
// the controller has let go of a client's ABBCX, the first request on a new
// connection is answered under a new client (the DELETE of the old group:
// 400, "does not belong to Client 30"), and every later request carrying the
// old ABBCX on that kept connection gets 503. The scripted controller below
// does that. RW 6.16.03 sets the new ABBCX on that 400 (seen in the trace of
// the fixed run, 2026-10-22); a controller that sets none is hypothetical,
// and both cases run.
//
// Through fetch the session has no say in which connection a request takes
// (fetch's pool picks it), so there the connections are not asserted: what
// must hold is that the cookie the refusal set is enough on its own, at the
// tests' pace and at the client's default pace (55 ms).
forEachTransport('HttpSession - re-registering after the controller let go of the client (live 2026-10-22)', (transport) => {
  let srv: ScriptedServer;

  beforeEach(async () => {
    srv = await scriptedServer();
  });

  afterEach(async () => {
    await srv.close();
  });

  function controllerThatLetGo(errorSetsCookie: boolean): void {
    const known = new Set<string>();
    const used = new Set<number>();
    let clients = 0;
    srv.alwaysBy((r) => {
      const abbcx = /(?:^|;\s*)ABBCX=([^;]*)/.exec(r.headers.cookie ?? '')?.[1];
      const firstOnConnection = !used.has(r.connection);
      used.add(r.connection);
      const status = r.method === 'DELETE' && r.path === '/subscription/67' ? 400 : 201;
      const headers = { Location: '/poll/68' };
      if (abbcx !== undefined && known.has(abbcx)) { return answer(status, '', headers); }
      if (!firstOnConnection) { return answer(503, ''); }
      const client = `client${++clients}`;
      known.add(client);
      const setCookie: Record<string, string> = status < 300 || errorSetsCookie ? { 'Set-Cookie': `ABBCX=${client}; Path=/` } : {};
      return answer(status, '', { ...headers, ...setCookie });
    });
  }

  async function reRegister(session: HttpSession): Promise<number> {
    await session.delete('/subscription/67').catch(() => undefined);
    return (await session.post('/subscription', 'resources=1')).status;
  }

  for (const requestIntervalMs of [0, 55]) {
    it(`the POST after a refused DELETE is answered when the refusal set the new ABBCX (${requestIntervalMs} ms apart)`, async () => {
      controllerThatLetGo(true);
      const session = makeSession(srv, { sessionCookie: '-http-session-=s1; ABBCX=gone', requestIntervalMs });

      expect(await reRegister(session)).toBe(201);
      expect(srv.requests.map(r => r.method)).toEqual(['DELETE', 'POST']);
      // The cookie the refusal set is what the POST carried.
      expect(srv.requests[1].headers.cookie).toBe('-http-session-=s1; ABBCX=client1');
      if (transport === 'node:http') {
        expect(srv.requests.map(r => `${r.method}#${r.connection}`)).toEqual(['DELETE#1', 'POST#1']);
      }
    });
  }

  if (transport === 'node:http') {
    it('the POST after a refused DELETE is answered when the refusal set no cookie (its 503 retry goes out on a new connection)', async () => {
      controllerThatLetGo(false);
      const session = makeSession(srv, { sessionCookie: '-http-session-=s1; ABBCX=gone' });

      expect(await reRegister(session)).toBe(201);
      expect(srv.requests.map(r => `${r.method}#${r.connection}`)).toEqual(['DELETE#1', 'POST#1', 'POST#2']);
      // The ABBCX of the answered retry is the one the next request carries.
      await session.get('/rw/system');
      expect(srv.requests[3].headers.cookie).toBe('-http-session-=s1; ABBCX=client2');
    });
  }
});

forEachTransport('HttpSession - session expiry', () => {
  let srv: ScriptedServer;

  beforeEach(async () => {
    srv = await scriptedServer();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await srv.close();
  });

  it('re-authenticates transparently after 5-minute inactivity', async () => {
    // Only the clock is faked: the requests run on real sockets and timers.
    vi.useFakeTimers({ toFake: ['Date'] });

    const session = makeSession(srv, { requestIntervalMs: 0 });

    // First auth cycle: 401 → 200 (with cookie)
    srv.once(challenge(), answer(200, '', { 'Set-Cookie': 'ABBCX=tok; Path=/' }));

    await session.get('/path1');

    // Advance clock past 5-minute session timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

    // Second request after expiry: should trigger a new digest handshake
    srv.once(challenge(), answer(200, 'fresh'));

    const result = await session.get('/path2');
    expect(result.body).toBe('fresh');

    // Total of 4 requests: 2 for first auth + 2 for re-auth after expiry
    expect(srv.requests).toHaveLength(4);
    expect(authOf(srv.requests[2])).toBeUndefined();
  });
});

forEachTransport('HttpSession - network errors', (transport) => {
  let srv: ScriptedServer;
  let session: HttpSession;

  beforeEach(async () => {
    srv = await scriptedServer();
    session = makeSession(srv, { timeoutMs: 100, requestIntervalMs: 0 });
  });

  afterEach(async () => {
    await srv.close();
  });

  it('throws RwsError NETWORK_ERROR when the connection drops without an answer', async () => {
    srv.once('destroy');

    const err = await session.get('/path').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    // Node's error, by its code: "socket hang up (ECONNRESET)" or the like;
    // through fetch undici's "other side closed (UND_ERR_SOCKET)", where
    // 1.4.0 said only "TypeError: fetch failed".
    expect((err as RwsError).message).toMatch(transport === 'fetch'
      ? /^Network error: .*(other side closed|UND_ERR_SOCKET|ECONNRESET)/
      : /^Network error: .*(ECONNRESET|EPIPE|hang up)/);
  });

  it('throws RwsError NETWORK_ERROR naming ECONNREFUSED (not plain Error) when nothing listens', async () => {
    const gone = await scriptedServer();
    const port = gone.port;
    await gone.close();
    // A refused connect to 127.0.0.1 takes about 2 s on Windows (SYN retries).
    const refused = makeSession({ baseUrl: `http://127.0.0.1:${port}` }, { timeoutMs: 8000 });

    const err = await refused.get('/path').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect((err as RwsError).message).toMatch(/^Network error: .*ECONNREFUSED/);
  });

  it('a host name with several addresses (localhost) still names where it tried, not an empty message', async () => {
    const gone = await scriptedServer();
    const port = gone.port;
    await gone.close();
    // On Node 20+ `localhost` that resolves to ::1 and 127.0.0.1 fails as an
    // AggregateError with an empty message of its own.
    const refused = makeSession({ baseUrl: `http://localhost:${port}` }, { timeoutMs: 10000 });

    const err = await refused.get('/path').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    const message = (err as RwsError).message;
    expect(message).toMatch(/^Network error: \S/);
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain(`:${port}`);
  }, 15000);
});

forEachTransport('HttpSession - HTTP error codes', () => {
  let srv: ScriptedServer;
  let session: HttpSession;

  beforeEach(async () => {
    srv = await scriptedServer();
    session = makeSession(srv, { requestIntervalMs: 0 });
  });

  afterEach(async () => {
    await srv.close();
  });

  it('maps a body-less 403 on an authed request to an unexplained refusal, not AUTH_FAILED', async () => {
    // Until 1.4.0 this was GRANT_DENIED with fixed RMMP / UAS advice. A 403
    // with no controller code names no cause, so the client claims none: the
    // refusal is UNKNOWN, keeps the controller's answer, and advises nothing.
    srv.once(challenge(), answer(403, ''));

    const err = await session.post('/rw/something', 'x=1').catch((e: RwsError) => e);
    expect(err).toMatchObject({ code: 'UNKNOWN', httpStatus: 403 });
    expect((err as RwsError).refusal).toMatchObject({ kind: 'unknown', grantor: null, generation: 'rw6' });
    expect((err as RwsError).message).toContain('HTTP 403 from POST /rw/something');
    expect((err as RwsError).message).not.toMatch(/RMMP|grant/i);
  });

  it('maps a generic 404 to RESOURCE_NOT_FOUND', async () => {
    srv.once(challenge(), answer(404, 'not found'));

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('maps a module-path 404 to MODULE_NOT_FOUND', async () => {
    srv.once(challenge(), answer(404, 'not found'));

    await expect(session.get('/rw/rapid/tasks/T_ROB1/modules/Gone')).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' });
  });

  it('maps 429 to RATE_LIMITED', async () => {
    srv.once(challenge(), answer(429, 'slow down'));

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

/**
 * Regression for the untimed-body-read bug found by structural cell S12.
 *
 * A REAL local server, because the bug lives in the two phases of a response:
 * the headers arrive, then the body. The timer used to be cleared when the
 * headers arrived (on fetch, which resolves there), leaving the body read
 * unbounded. One timer now runs until the last byte of the body, on both
 * transports.
 */
forEachTransport('HttpSession - the timeout must cover the response BODY, not just the headers', () => {
  let server: import('node:http').Server;
  let port = 0;
  /** Sockets parked mid-body, destroyed in afterEach so the suite can exit. */
  let parked: Socket[] = [];

  beforeEach(async () => {
    const http = await import('node:http');
    parked = [];
    server = http.createServer((req, res) => {
      if (req.url === '/stall-body') {
        // Headers complete, body never does, socket stays healthy. This is what
        // a stalled peer, a stalled proxy or a congested link looks like.
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml', 'Content-Length': '4096' });
        res.write('<html><body><div class="state"><span class="ctrlstate">moto');
        parked.push(res.socket as Socket);
        return; // deliberately never res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml' });
      res.end('<html><body>ok</body></html>');
    });
    // A port fetch accepts, so [fetch] means fetch (see listenOnPort).
    port = await listenOnPort(server);
  });

  afterEach(async () => {
    for (const s of parked) { s.destroy(); }
    await new Promise<void>(r => server.close(() => r()));
  });

  it('aborts a response whose body never arrives, instead of hanging forever', async () => {
    const live = new HttpSession({
      baseUrl: `http://127.0.0.1:${port}`,
      username: 'u', password: 'p',
      requestIntervalMs: 0,
      timeoutMs: 400,
    });

    const startedAt = Date.now();
    await expect(live.get('/stall-body')).rejects.toBeInstanceOf(RwsError);
    const elapsed = Date.now() - startedAt;

    // The assertion that matters is the bound: before the fix this never settled
    // at all. Allow generous slack for a loaded machine, but far below "forever".
    expect(elapsed).toBeLessThan(8000);
  }, 20000);

  it('reports the stalled body as a timeout, naming the configured budget, and drops the connection', async () => {
    const live = new HttpSession({
      baseUrl: `http://127.0.0.1:${port}`,
      username: 'u', password: 'p',
      requestIntervalMs: 0,
      timeoutMs: 300,
    });

    await expect(live.get('/stall-body')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'Request timed out after 300ms: GET /stall-body',
    });
    // The request's socket is destroyed, not left half-read in the pool: the
    // server sees its end of the connection close.
    expect(parked).toHaveLength(1);
    await until(() => parked[0].destroyed || parked[0].readableEnded, 3000, 'the stalled connection to close');
  }, 20000);

  it('a hung request does not poison the queue for the requests behind it', async () => {
    // The real damage: this client serialises requests, so one unbounded read
    // stalls every later request too. After the timeout fires, normal traffic
    // must flow again.
    const live = new HttpSession({
      baseUrl: `http://127.0.0.1:${port}`,
      username: 'u', password: 'p',
      requestIntervalMs: 0,
      timeoutMs: 400,
    });

    await expect(live.get('/stall-body')).rejects.toBeInstanceOf(RwsError);
    const after = await live.get('/fine');
    expect(after.status).toBe(200);
    expect(after.body).toContain('ok');
  }, 20000);

  it('a hold (holdMs) extends the timeout of that one request', async () => {
    const live = new HttpSession({
      baseUrl: `http://127.0.0.1:${port}`,
      username: 'u', password: 'p',
      requestIntervalMs: 0,
      timeoutMs: 200,
    });

    await expect(live.get('/stall-body', 300)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'Request timed out after 500ms: GET /stall-body',
    });
  }, 20000);
});

forEachTransport('HttpSession - a dead session cookie (live 2026-09-25, IRC5 VC)', () => {
  let srv: ScriptedServer;
  beforeEach(async () => { srv = await scriptedServer(); });
  afterEach(async () => { await srv.close(); });

  const cookieOf = (r: RecordedRequest): string => r.headers.cookie ?? '';

  it('drops the cookie and signs in on a fresh session when 401 persists after the digest handshake', async () => {
    const session = makeSession(srv, { sessionCookie: '-http-session-=STALE; ABBCX=1' });
    srv.once(
      challenge(),   // stale cookie, no auth
      challenge(),   // digest + stale cookie
      answer(200, '{}', { 'set-cookie': '-http-session-=FRESH; path=/' }),
    );
    const res = await session.get('/rw/system?json=1');
    expect(res.status).toBe(200);
    expect(srv.requests).toHaveLength(3);
    expect(cookieOf(srv.requests[1])).toContain('STALE');
    expect(cookieOf(srv.requests[2])).not.toContain('STALE');
  });

  it('wrong credentials without a cookie still fail after one handshake (no extra request)', async () => {
    const session = makeSession(srv, { password: 'wrong' });
    srv.once(challenge(), challenge());
    await expect(session.get('/rw/system?json=1')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(srv.requests).toHaveLength(2);
  });

  it('wrong credentials without a cookie fail after one handshake, also when the 401 sets a cookie (no false session replaced)', async () => {
    const why: string[] = [];
    const session = makeSession(srv, { password: 'wrong', onSessionReplaced: w => why.push(w) });
    const setsCookie = answer(401, '', { 'www-authenticate': WWW_AUTH_HEADER, 'set-cookie': '-http-session-=NEW; path=/' });
    srv.once(setsCookie, setsCookie);
    await expect(session.get('/rw/system?json=1')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(srv.requests).toHaveLength(2);
    expect(cookieOf(srv.requests[1])).toContain('-http-session-=NEW');
    expect(why).toEqual([]);
  });

  it('wrong credentials with a cookie fail after the fresh-session attempt', async () => {
    const session = makeSession(srv, { password: 'wrong', sessionCookie: '-http-session-=STALE' });
    srv.always(challenge());
    await expect(session.get('/rw/system?json=1')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(srv.requests).toHaveLength(3);
  });
});

forEachTransport('HttpSession - close() / reopen()', (transport) => {
  // RwsClient.disconnect() closes the session in the tick it queues /logout, so
  // nothing is sent after the logout.
  let srv: ScriptedServer;

  beforeEach(async () => {
    srv = await scriptedServer();
  });

  afterEach(async () => {
    await srv.close();
  });

  it('refuses requests queued after close() with NOT_CONNECTED; those queued before still go out, in order', async () => {
    const session = makeSession(srv, { requestIntervalMs: 0 });
    srv.always(answer(200, 'ok'));

    expect(session.isClosed).toBe(false);
    const before = session.get('/before');
    const logout = session.get('/logout');
    session.close();
    expect(session.isClosed).toBe(true);
    const after = session.get('/after');

    await expect(after).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect((await before).body).toBe('ok');
    expect((await logout).body).toBe('ok');
    expect(srv.requests.map(r => r.path)).toEqual(['/before', '/logout']);
  });

  it('the refusal is an RwsError and nothing is sent for it', async () => {
    const session = makeSession(srv, { requestIntervalMs: 0 });
    session.close();
    const err = await session.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect((err as RwsError).code).toBe('NOT_CONNECTED');
    expect(srv.requests).toHaveLength(0);
    expect(srv.connections).toBe(0);
  });

  it('reopen() accepts requests again and keeps the session state (no new handshake)', async () => {
    const session = makeSession(srv, { requestIntervalMs: 0 });
    srv.always(answer(200, 'ok', { 'set-cookie': '-http-session-=abc; Path=/' }));
    await session.get('/first');
    const cookie = session.getSessionCookie();
    session.close();
    session.reopen();
    expect(session.isClosed).toBe(false);
    expect((await session.get('/second')).body).toBe('ok');
    expect(session.getSessionCookie()).toBe(cookie);
    expect(srv.requests).toHaveLength(2);
  });

  // The session's own connection exists through node:http only; through
  // fetch the connections belong to fetch's pool (see HttpSession.close).
  if (transport === 'node:http') {
    it('close() drops the pooled connection once the requests queued before it have gone out', async () => {
      const session = makeSession(srv, { requestIntervalMs: 0 });
      srv.always(answer(200, 'ok'));
      await session.get('/first');
      // Keep-alive: the connection stays open between requests.
      expect(srv.openConnections).toBe(1);

      const logout = session.get('/logout');
      session.close();
      await logout;
      await until(() => srv.openConnections === 0, 3000, 'the client to close its pooled connection');
      expect(srv.requests.map(r => r.path)).toEqual(['/first', '/logout']);
      expect(srv.connections).toBe(1);

      // The session can be opened again: a new connection.
      session.reopen();
      expect((await session.get('/again')).body).toBe('ok');
      expect(srv.connections).toBe(2);
    });

    it('a reopen() before the queue drains keeps the connection', async () => {
      const session = makeSession(srv, { requestIntervalMs: 0 });
      srv.always(answer(200, 'ok'));
      await session.get('/first');
      const pending = session.get('/second');
      session.close();
      session.reopen();
      await pending;
      expect((await session.get('/third')).body).toBe('ok');
      expect(srv.connections).toBe(1);
    });
  }
});

describe('HttpSession - transport: fetch on every port it accepts, node:http on one it refuses', () => {
  let srv: ScriptedServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    forced.transport = undefined;
    await srv?.close();
    srv = undefined;
  });

  it('a session on a port fetch accepts sends through the global fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    srv = await scriptedServer();
    srv.once(challenge(), answer(200, 'ok'));

    const res = await makeSession(srv).get('/rw/panel/ctrlstate');

    expect(res).toMatchObject({ status: 200, body: 'ok' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${srv.baseUrl}/rw/panel/ctrlstate`);
    expect(srv.requests).toHaveLength(2);
  });

  it('reaches a controller on a port the global fetch refuses, without calling fetch (live 2026-10-22: an RW6 VC on port 7)', async () => {
    // The first free one of nineteen such ports; none free fails the test
    // (tests/helpers/refusedPorts.ts). Until 1.5.1 six were tried, and the
    // test skipped with a warning when all six were taken.
    srv = await scriptedServer('fetch-refused');
    // What 1.4.0 did on this port: refused before sending.
    const viaFetch = await fetch(`${srv.baseUrl}/rw/system`).then(
      () => 'answered',
      (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
    );
    expect(viaFetch).toMatch(/bad port/i);
    expect(srv.requests).toHaveLength(0);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    srv.once(challenge(), answer(200, '<html><body>ok</body></html>'));
    const res = await makeSession(srv).get('/rw/system');
    expect(res.status).toBe(200);
    expect(res.body).toContain('ok');
    expect(srv.requests.map(r => r.path)).toEqual(['/rw/system', '/rw/system']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a node:http session works while the global fetch throws (fetch is not used)', async () => {
    forced.transport = 'node:http';
    const fetchSpy = vi.fn(() => { throw new Error('the global fetch must not be used on this path'); });
    vi.stubGlobal('fetch', fetchSpy);
    srv = await scriptedServer();
    srv.once(challenge(), answer(200, 'ok'));

    const res = await makeSession(srv).get('/rw/panel/ctrlstate');

    expect(res).toMatchObject({ status: 200, body: 'ok' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(srv.requests).toHaveLength(2);
  });

  it('if fetch refuses a port anyway (a port the list lacks), the error names the port plainly', async () => {
    // Port 7 through fetch, as a Node that refuses a port this client does
    // not list would send it. fetch refuses it before connecting.
    forced.transport = 'fetch';
    const session = makeSession({ baseUrl: 'http://127.0.0.1:7' });

    const err = await session.get('/rw/system').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect((err as RwsError).message).toMatch(/^Network error: Node's fetch refuses port 7 \("bad port"/);
    expect((err as RwsError).message).toContain('sent nothing');
    expect((err as RwsError).message).not.toContain('fetch failed');
  });
});

forEachTransport('HttpSession - the wire', (transport) => {
  let srv: ScriptedServer;

  beforeEach(async () => {
    srv = await scriptedServer();
  });

  afterEach(async () => {
    await srv.close();
  });

  it('a Uint8Array body arrives byte for byte with its Content-Length; a form body as UTF-8', async () => {
    srv.always(answer(200, ''));
    const session = makeSession(srv);
    // Every byte value, so a text round trip anywhere would show.
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

    await session.put('/fileservice/$HOME/x.bin', bytes);
    await session.post('/rw/cfg?action=x', 'name=Grüße €');
    await session.post('/rw/panel?action=resetpp');

    const [put, form, empty] = srv.requests;
    expect(put.method).toBe('PUT');
    expect(put.headers['content-type']).toBe('application/octet-stream');
    expect(put.headers['content-length']).toBe('256');
    expect(Buffer.compare(put.body, Buffer.from(bytes))).toBe(0);

    expect(form.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(form.headers['content-length']).toBe(String(Buffer.byteLength('name=Grüße €')));
    expect(form.body.toString('utf8')).toBe('name=Grüße €');

    // A POST without a body says so, as fetch does.
    expect(empty.headers['content-length']).toBe('0');
    expect(empty.body.length).toBe(0);
  });

  it('the answer is decoded as UTF-8 (a leading byte order mark dropped, as fetch does)', async () => {
    srv.once(answer(200, '﻿<span class="name">Grüße</span>'));
    const res = await makeSession(srv).get('/x');
    expect(res.body).toBe('<span class="name">Grüße</span>');
  });

  it(`a compressed answer is unpacked (gzip, deflate, raw deflate, br); ${transport === 'fetch' ? 'fetch asks for gzip and deflate, as in 1.4.0' : 'node:http asks for identity'}`, async () => {
    const text = '<span class="name">Grüße</span>';
    const packed = (encoding: string, bytes: Buffer) => (_req: unknown, res: import('node:http').ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml', 'Content-Encoding': encoding });
      res.end(bytes);
    };
    srv.once(
      answer(200, text),
      packed('gzip', gzipSync(text)),
      packed('deflate', deflateSync(text)),
      packed('deflate', deflateRawSync(text)),
      packed('br', brotliCompressSync(text)),
    );
    const session = makeSession(srv);

    for (const path of ['/plain', '/gzip', '/deflate', '/raw-deflate', '/br']) {
      expect((await session.get(path)).body, path).toBe(text);
    }
    const asked = srv.requests.map(r => r.headers['accept-encoding']);
    if (transport === 'node:http') {
      expect(asked).toEqual(Array(5).fill('identity'));
    } else {
      for (const a of asked) { expect(a).toMatch(/gzip/); }
    }
  });

  it('a GET that fails without an answer on a kept connection is sent again only through node:http', async () => {
    srv.once(answer(200, 'first'), 'destroy').always(answer(200, 'again'));
    const session = makeSession(srv);

    await session.get('/one');
    const outcome = await session.get('/two').then(r => r.body, (e: unknown) => e);

    if (transport === 'node:http') {
      // See the node:http block below for the rule and its limits.
      expect(outcome).toBe('again');
      expect(srv.requests.map(r => r.path)).toEqual(['/one', '/two', '/two']);
    } else {
      // fetch never sent a request twice, as in 1.4.0.
      expect(outcome).toBeInstanceOf(RwsError);
      expect(outcome).toMatchObject({ code: 'NETWORK_ERROR' });
      expect(srv.requests.map(r => r.path)).toEqual(['/one', '/two']);
    }
  });

  it(`a redirect is ${transport === 'fetch' ? 'followed, as fetch did in 1.4.0' : 'not followed: the 3xx is thrown with its status'}`, async () => {
    srv.once(answer(302, '', { Location: '/elsewhere' })).always(answer(200, 'followed'));

    const outcome = await makeSession(srv).get('/rw/system').catch((e: unknown) => e);

    if (transport === 'fetch') {
      expect(outcome).toMatchObject({ status: 200, body: 'followed' });
      expect(srv.requests.map(r => r.path)).toEqual(['/rw/system', '/elsewhere']);
    } else {
      expect(outcome).toBeInstanceOf(RwsError);
      expect(outcome).toMatchObject({ httpStatus: 302 });
      expect(srv.requests.map(r => r.path)).toEqual(['/rw/system']);
    }
  });
});

// The node:http path's own behaviour: its keep-alive agent, its retry rule on
// a dead kept connection, and its content decoding.
describe('HttpSession - node:http path (a port fetch refuses)', () => {
  let srv: ScriptedServer | undefined;

  beforeEach(() => { forced.transport = 'node:http'; });

  afterEach(async () => {
    forced.transport = undefined;
    await srv?.close();
    srv = undefined;
  });

  it('keep-alive: two requests in a row share one connection', async () => {
    srv = await scriptedServer();
    srv.always(answer(200, 'ok'));
    const session = makeSession(srv);

    await session.get('/one');
    await session.get('/two');

    expect(srv.requests).toHaveLength(2);
    expect(srv.requests[1].connection).toBe(srv.requests[0].connection);
    expect(srv.connections).toBe(1);
  });

  it('a GET that fails on a pooled connection the controller had closed is sent once more on a new one', async () => {
    srv = await scriptedServer();
    // The second request arrives on the kept connection and the "controller"
    // drops it unanswered, as one that closed the idle connection would.
    srv.once(answer(200, 'first'), 'destroy', answer(200, 'again'));
    const session = makeSession(srv);

    await session.get('/one');
    const res = await session.get('/two');

    expect(res.body).toBe('again');
    expect(srv.requests.map(r => r.path)).toEqual(['/one', '/two', '/two']);
    expect(srv.requests[1].connection).toBe(srv.requests[0].connection);
    expect(srv.requests[2].connection).not.toBe(srv.requests[1].connection);
  });

  it('a write that fails on a pooled connection is NOT sent again', async () => {
    srv = await scriptedServer();
    srv.once(answer(200, 'first'), 'destroy').always(answer(204, ''));
    const session = makeSession(srv);

    await session.get('/one');
    const err = await session.post('/rw/rapid/execution?action=start', 'regain=continue').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(srv.requests.map(r => r.path)).toEqual(['/one', '/rw/rapid/execution?action=start']);
  });

  it('a GET that fails on a NEW connection is not sent again', async () => {
    srv = await scriptedServer();
    srv.once('destroy').always(answer(200, 'unexpected'));

    await expect(makeSession(srv).get('/one')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(srv.requests).toHaveLength(1);
  });

  it('an answer in an encoding this client does not read is a NETWORK_ERROR naming it, not garbled text', async () => {
    srv = await scriptedServer();
    srv.once((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml', 'Content-Encoding': 'compress' });
      res.end(Buffer.from([0x1f, 0x9d, 0x90, 0x00]));
    });

    const err = await makeSession(srv).get('/x').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect((err as RwsError).message).toMatch(/^Network error: .*"compress"/);
  });

  // The retry rule's limits (reviewed 2026-10-22): the error alone cannot tell
  // a dead pooled connection from a controller that read the request and then
  // dropped the connection, so a request that changes something, a held one,
  // and one that failed long after it went out are never sent twice.

  it('a GET whose connection drops more than a second after it went out is not sent again', async () => {
    srv = await scriptedServer();
    srv.once(
      answer(200, 'first'),
      (req) => { setTimeout(() => req.socket.destroy(), 1200); },
    ).always(answer(200, 'sent twice'));
    const session = makeSession(srv, { timeoutMs: 5000 });

    await session.get('/one');
    const err = await session.get('/two').catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(srv.requests.map(r => r.path)).toEqual(['/one', '/two']);
  });

  it('a DIPC read and /logout are never sent again (each changes something on the controller)', async () => {
    for (const path of ['/rw/dipc/q?action=dipc-read', '/rw/dipc/q?action=dipc-read&timeout=0', '/logout']) {
      const s = await scriptedServer();
      try {
        s.once(answer(200, 'first'), 'destroy').always(answer(200, 'sent twice'));
        const session = makeSession(s);
        await session.get('/one');
        await expect(session.get(path), path).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
        expect(s.requests.map(r => r.path), path).toEqual(['/one', path]);
      } finally {
        await s.close();
      }
    }
  });

  it('a GET the controller holds on purpose (holdMs) is never sent again', async () => {
    srv = await scriptedServer();
    srv.once(answer(200, 'first'), 'destroy').always(answer(200, 'sent twice'));
    const session = makeSession(srv);

    await session.get('/one');
    await expect(session.get('/rw/panel/ctrlstate', 500)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(srv.requests.map(r => r.path)).toEqual(['/one', '/rw/panel/ctrlstate']);
  });

  it('the retry gets what is left of the time budget, not a new one', async () => {
    srv = await scriptedServer();
    srv.once(
      answer(200, 'first'),
      (req) => { setTimeout(() => req.socket.destroy(), 400); },
      () => { /* never answers */ },
    );
    const session = makeSession(srv, { timeoutMs: 1000 });

    await session.get('/one');
    const started = Date.now();
    const err = await session.get('/two').catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(srv.requests.map(r => r.path)).toEqual(['/one', '/two', '/two']);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect((err as RwsError).message).toBe('Request timed out after 1000ms: GET /two');
    // A fresh timer for the retry would end at about 1400 ms.
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1250);
  });

  it('the retry waits for the queue interval like any request', async () => {
    const intervalMs = 100;
    srv = await scriptedServer();
    srv.once(answer(200, 'first'), 'destroy', answer(200, 'again'));
    const session = makeSession(srv, { requestIntervalMs: intervalMs });

    await session.get('/one');
    expect((await session.get('/two')).body).toBe('again');

    expect(srv.requests.map(r => r.path)).toEqual(['/one', '/two', '/two']);
    // Times are taken where the requests arrive; 10 ms for the trip.
    expect(srv.requests[2].at - srv.requests[1].at).toBeGreaterThanOrEqual(intervalMs - 10);
  });
});
