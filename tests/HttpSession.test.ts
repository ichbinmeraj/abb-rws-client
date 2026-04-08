import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpSession } from '../src/HttpSession.js';
import { RwsError } from '../src/types.js';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeHeaders(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

function makeResponse(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: makeHeaders(headers) });
}

const WWW_AUTH_HEADER =
  'Digest realm="robot", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth", algorithm=MD5, opaque="5ccc069c403ebaf9f0171e9517f40e41"';

const WWW_AUTH_NO_QOP =
  'Digest realm="robot", nonce="simplnonce", algorithm=MD5';

function makeSession(overrides: Partial<ConstructorParameters<typeof HttpSession>[0]> = {}): HttpSession {
  return new HttpSession({
    baseUrl: 'http://192.168.1.1',
    username: 'Default User',
    password: 'robotics',
    requestIntervalMs: 0, // disable rate limiting for tests
    timeoutMs: 1000,
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HttpSession — digest authentication', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let session: HttpSession;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    session = makeSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends unauthenticated first request, then retries with Authorization on 401', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(200, '<html/>'));

    await session.get('/rw/panel/ctrlstate');

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstCallHeaders: Record<string, string> = fetchMock.mock.calls[0][1].headers;
    expect(firstCallHeaders['Authorization']).toBeUndefined();

    const secondCallHeaders: Record<string, string> = fetchMock.mock.calls[1][1].headers;
    expect(secondCallHeaders['Authorization']).toBeDefined();
    expect(secondCallHeaders['Authorization']).toMatch(/^Digest /);
  });

  it('Authorization header contains realm, nonce, nc, cnonce, response, opaque', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(200, ''));

    await session.get('/rw/panel/ctrlstate');

    const auth: string = fetchMock.mock.calls[1][1].headers['Authorization'];
    expect(auth).toContain('realm="robot"');
    expect(auth).toContain('nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"');
    expect(auth).toContain('nc=00000001');   // nc is NOT quoted
    expect(auth).toMatch(/cnonce="[0-9a-f]+"/);
    expect(auth).toMatch(/response="[0-9a-f]{32}"/);
    expect(auth).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('nc is NOT quoted in the Authorization header', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(200, ''));

    await session.get('/path');

    const auth: string = fetchMock.mock.calls[1][1].headers['Authorization'];
    // nc=00000001 (no quotes), NOT nc="00000001"
    expect(auth).toMatch(/\bnc=00000001\b/);
    expect(auth).not.toMatch(/nc="00000001"/);
  });

  it('uri field in Authorization matches the request path, not the full URL', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(200, ''));

    await session.get('/rw/rapid/execution?action=start');

    const auth: string = fetchMock.mock.calls[1][1].headers['Authorization'];
    expect(auth).toContain('uri="/rw/rapid/execution?action=start"');
    expect(auth).not.toContain('http://'); // full URL must NOT appear in uri field
  });

  it('falls back to RFC 2069 mode (no nc/cnonce/qop) when WWW-Authenticate has no qop', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_NO_QOP }))
      .mockResolvedValueOnce(makeResponse(200, ''));

    await session.get('/path');

    const auth: string = fetchMock.mock.calls[1][1].headers['Authorization'];
    expect(auth).toMatch(/^Digest /);
    expect(auth).toMatch(/response="[0-9a-f]{32}"/);
    // In RFC 2069 mode these fields may still be present but qop should not be asserted
  });

  it('throws RwsError AUTH_FAILED when a second 401 is received', async () => {
    fetchMock.mockResolvedValue(
      makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }),
    );

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(session.get('/path')).rejects.toBeInstanceOf(RwsError);
  });

  it('throws RwsError AUTH_FAILED when 401 has no WWW-Authenticate header', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401, ''));

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('nonce count increments on successive requests with the same challenge', async () => {
    // First call: 401 + auth challenge
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(200, ''))
      // Second call: no 401 — reuse existing challenge
      .mockResolvedValueOnce(makeResponse(200, ''));

    await session.get('/path1');
    await session.get('/path2');

    // Second request should use nc=00000002
    const secondRequestAuth: string = fetchMock.mock.calls[2][1].headers['Authorization'];
    expect(secondRequestAuth).toMatch(/\bnc=00000002\b/);
  });
});

describe('HttpSession — cookie handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let session: HttpSession;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    session = makeSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores ABBCX cookie from Set-Cookie response header', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(
        makeResponse(200, '', { 'Set-Cookie': 'ABBCX=token123; Path=/' }),
      )
      .mockResolvedValueOnce(makeResponse(200, ''));

    await session.get('/path1');
    await session.get('/path2');

    // Third fetch call (path2 authenticated request) should include the cookie
    const thirdHeaders: Record<string, string> = fetchMock.mock.calls[2][1].headers;
    expect(thirdHeaders['Cookie']).toContain('ABBCX=token123');
  });

  it('stores -http-session- cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(
        makeResponse(200, '', { 'Set-Cookie': '-http-session-=sess456; Path=/' }),
      )
      .mockResolvedValueOnce(makeResponse(200, ''));

    await session.get('/path1');
    await session.get('/path2');

    const thirdHeaders: Record<string, string> = fetchMock.mock.calls[2][1].headers;
    expect(thirdHeaders['Cookie']).toContain('-http-session-=sess456');
  });

  it('sends both cookies when both are set', async () => {
    // Simulate multiple Set-Cookie headers by creating a response manually
    const mockHeaders = new Headers();
    mockHeaders.append('Set-Cookie', 'ABBCX=abc; Path=/');
    mockHeaders.append('Set-Cookie', '-http-session-=xyz; Path=/');
    const multiCookieResponse = new Response('', { status: 200, headers: mockHeaders });

    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(multiCookieResponse)
      .mockResolvedValueOnce(makeResponse(200, ''));

    await session.get('/path1');
    await session.get('/path2');

    const thirdHeaders: Record<string, string> = fetchMock.mock.calls[2][1].headers;
    const cookieHeader = thirdHeaders['Cookie'] ?? '';
    expect(cookieHeader).toContain('ABBCX=abc');
    expect(cookieHeader).toContain('-http-session-=xyz');
  });

  it('getCookieHeader returns current cookie string', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(
        makeResponse(200, '', { 'Set-Cookie': 'ABBCX=cookieVal; Path=/' }),
      );

    await session.get('/path');

    expect(session.getCookieHeader()).toContain('ABBCX=cookieVal');
  });
});

describe('HttpSession — rate limiting', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enforces minimum interval between requests', async () => {
    const intervalMs = 50;
    const session = makeSession({ requestIntervalMs: intervalMs });
    fetchMock.mockResolvedValue(makeResponse(200, ''));

    const timestamps: number[] = [];
    fetchMock.mockImplementation(() => {
      timestamps.push(Date.now());
      return Promise.resolve(makeResponse(200, ''));
    });

    // Fire 3 requests concurrently; they must be serialised with >= intervalMs gap
    await Promise.all([session.get('/p1'), session.get('/p2'), session.get('/p3')]);

    expect(timestamps).toHaveLength(3);
    if (timestamps.length >= 2) {
      expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(intervalMs - 5); // 5ms tolerance
    }
    if (timestamps.length >= 3) {
      expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(intervalMs - 5);
    }
  });

  it('does not add delay when requestIntervalMs is 0', async () => {
    const session = makeSession({ requestIntervalMs: 0 });
    fetchMock.mockResolvedValue(makeResponse(200, ''));

    const start = Date.now();
    await Promise.all([session.get('/p1'), session.get('/p2'), session.get('/p3')]);
    const elapsed = Date.now() - start;

    // Without rate limiting, 3 requests should complete quickly
    expect(elapsed).toBeLessThan(500);
  });

  it('queue continues processing after a failed request', async () => {
    const session = makeSession({ requestIntervalMs: 0 });
    fetchMock
      .mockResolvedValueOnce(makeResponse(500, 'error'))
      .mockResolvedValueOnce(makeResponse(200, 'ok'));

    const p1 = session.get('/fail').catch(() => 'caught');
    const p2 = session.get('/ok');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('caught');
    expect((r2 as { body: string }).body).toBe('ok');
  });
});

describe('HttpSession — 503 retry', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let session: HttpSession;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    session = makeSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries once after 503 and succeeds on the retry', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(503, ''))
      .mockResolvedValueOnce(makeResponse(200, 'ok'));

    const result = await session.get('/path');
    expect(result.body).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws RwsError CONTROLLER_BUSY when 503 persists after retry', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(503, ''))
      .mockResolvedValueOnce(makeResponse(503, ''));

    await expect(session.get('/path')).rejects.toMatchObject({
      code: 'CONTROLLER_BUSY',
      httpStatus: 503,
    });
  });
});

describe('HttpSession — session expiry', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('re-authenticates transparently after 5-minute inactivity', async () => {
    vi.useFakeTimers();

    const session = makeSession({ requestIntervalMs: 0 });

    // First auth cycle: 401 → 200 (with cookie)
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(200, '', { 'Set-Cookie': 'ABBCX=tok; Path=/' }));

    await session.get('/path1');

    // Advance clock past 5-minute session timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

    // Second request after expiry: should trigger a new digest handshake
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(200, 'fresh'));

    const result = await session.get('/path2');
    expect(result.body).toBe('fresh');

    // Total of 4 fetch calls: 2 for first auth + 2 for re-auth after expiry
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('HttpSession — network errors', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let session: HttpSession;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    session = makeSession({ timeoutMs: 100, requestIntervalMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws RwsError NETWORK_ERROR when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws RwsError NETWORK_ERROR (not plain Error) on fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));

    await expect(session.get('/path')).rejects.toBeInstanceOf(RwsError);
  });
});

describe('HttpSession — HTTP error codes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let session: HttpSession;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Pre-load a digest challenge so we skip the 401 flow
    session = makeSession({ requestIntervalMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps 404 to MODULE_NOT_FOUND', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(404, 'not found'));

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' });
  });

  it('maps 429 to RATE_LIMITED', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, '', { 'www-authenticate': WWW_AUTH_HEADER }))
      .mockResolvedValueOnce(makeResponse(429, 'slow down'));

    await expect(session.get('/path')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
