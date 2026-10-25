import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import dns from 'node:dns';
import { probeProtocol, createClient, createAdapter, KNOWN_RWS_PORTS } from '../src/detect.js';
import { KNOWN_RWS_PORTS as KNOWN_FROM_SCHEME, REMOTE_RWS_PORTS, VC_RWS_PORTS, schemeForPort, candidatesForPort, describeRwsPorts } from '../src/discovery/scheme.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsError } from '../src/types.js';

function listen(handler: http.RequestListener): { server: http.Server; port: number } {
  const server = http.createServer(handler);
  server.listen(0); // OS picks free port
  const addr = server.address();
  if (!addr || typeof addr === 'string') { throw new Error('server has no port'); }
  return { server, port: addr.port };
}

// Self-signed localhost certificate for TLS-verification tests (CN=localhost,
// SAN 127.0.0.1, valid until 2046). Exactly what a controller's own cert looks
// like to a client: valid TLS, untrusted issuer.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUf1Ikd59HsHwQdokNWXSUz+3uAF8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcwODIxMTM1N1oXDTQ2MDcw
MzIxMTM1N1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApI16tgi0MRvVnVIuZT8F0okins0R+ZeYc8H4DnIJRVVr
4gfGkthYQgn6B55Dslq9uX/p9zry7oTrd+cIFIqbebOweeMwB+DdWwRGx954OS52
Pu7Xk0md0ilJPFxYFfksNekzgd+5lFhID4W0v5lXuV/hMH4f3DNyPyxgdllD1hRM
TL3w45QusOAAEmb+XR16IS9N9YZUNb5KB4Jzu3ftfFLPUkrSz4+IHV+6trKKEIKp
ShkSqdWeZwBYcuvCmuECn+0dnCgBH599GRn8qHcJIekoW7cQP+gJnY6GJVG2TSqs
67Je6FUkUHANwUveqllchOU4QjNJ7wlu2bTxWy4W6wIDAQABo28wbTAdBgNVHQ4E
FgQU4MPmJ9Nb9RzyOH/VDx2yvxl63cAwHwYDVR0jBBgwFoAU4MPmJ9Nb9RzyOH/V
Dx2yvxl63cAwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBACH4sbzJxc4RCbCoSFpB6zGX7Exe8nRz
YgDOTmDcYrDy1roagmTvi+FRY9q8oyWdjBXTD5njlKla6W0e+htb5UCaVcXx114y
ABPT9PGqmJvmvVKe5GuMltjP1pikiTgc1GpEp6TCMfliaadyn9jkmZMXGsH/cUTg
WXmuWDWzKGgEgiGvgYJvTRB2VcJ255vqVhkzNIRQTW+YEtCkloagkAC1d2FpuiZe
UUpkbyxIX7hFiTYXZCjIK0DXxXEDoJ7Cupis1mPG+zGXqz1bdVgwJPfIbdg7o1DL
+5bBCd/dVBda3sc52jyelTkGXr81BtQDku72kGsrBz1VZHqV3gnSunA=
-----END CERTIFICATE-----`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCkjXq2CLQxG9Wd
Ui5lPwXSiSKezRH5l5hzwfgOcglFVWviB8aS2FhCCfoHnkOyWr25f+n3OvLuhOt3
5wgUipt5s7B54zAH4N1bBEbH3ng5LnY+7teTSZ3SKUk8XFgV+Sw16TOB37mUWEgP
hbS/mVe5X+Ewfh/cM3I/LGB2WUPWFExMvfDjlC6w4AASZv5dHXohL031hlQ1vkoH
gnO7d+18Us9SStLPj4gdX7q2sooQgqlKGRKp1Z5nAFhy68Ka4QKf7R2cKAEfn30Z
Gfyodwkh6ShbtxA/6AmdjoYlUbZNKqzrsl7oVSRQcA3BS96qWVyE5ThCM0nvCW7Z
tPFbLhbrAgMBAAECggEAK02aCdZviO7gv6ZVVEqJ/zYceLrRrKOiuG/GlhKXcvoA
SnquXI13aGWUuTWCbiin/e12Bhwquu8awjJ3s2QodxX87o6FYMVhqyaMc+ONMssR
zgzviTCZyikYPzyz55BrfIJyjg5wmWPEDuWqQ7OYXM2pBqhiPQIC4jIM7ogeLHM9
hStEsOYo9pYOkI1o33cg6f8L8/Pf4eDCz0Ltbuhuwa6CML7RiZFreVSwblM7Ivy5
/2TB/Ss5zBsMl0HTz3bLaxoAotDqSWl5QtKwdu1xbqIpPMGOutqNyZouVGkkKG7T
OzEMgkQMsMJX4i39DiKzylTUwOiqxsgljJc2BkulPQKBgQDhO3VT1Ei/K/gORVY0
bJXkUCWespyKoFoctjL2WVeTWwmhPdtV5utBe/iE40FqO7a9yMsLmOdX8dig+tqq
kXzny8BW+MA2pTo+ZyJBumxFQT9KaekTRndJvwSkY1lk2JFlu0E2MxEgVQBm/iVC
R3aJggsLW0DSNYgPbeGrO4uOFQKBgQC7CAJxSJQLiz5zZDIsVQka0hmH6TkwMY0a
/izqicDad0zv9KPw5A5AR/fVvFmsCmJLDS/f5R3hDl97K3e2zKZFmECj+zCOcDdi
ECTC6fntW1v6JgrTKUq9iVoI2NCQ5z5UNtfG9zy2kXmDSw+GjpMGtfufybimLawl
pXs6OfFQ/wKBgELVeOhKKtgHfREHBCCERCo+mhswVwFPuc2hRxgQxMrmDcJ573bb
Ed4ZolIUeVnDpGNGjPHBCozvJ+AE8BQDHfROYqGsKKVOfCz+P40Pe4dFaDl1mgLt
OwJ4GzGIhYNGPEbavOwPVTqp3nexXG8Bc6w0GYDiMCbwWZJyga9k+PFNAoGAJVtK
MZpPh6a+SIoAw34QnXzNgKoCtC+RgYy3J/lvvbMKePsiK6FBf3FgfR5rwsMoMtll
cJDw0NzwEUfzV1208D2i2532atzbEwkqbowRUWloC6TBkL+0n/rpMs8riWXGu0dg
/eqwA782yBSb+0JK95ItuhKugPKqabKN1GlyW70CgYBEzvasYbSMk1zDhiJOIgj0
vun42/0faIerq34FATQvXZ0+9nsnKYsrCWOIiXgxMMx2kHojAK7Cv0APK4/8DWl3
wEn3NeFF5ZAiUB9iyl2Qx9/nKFyT/z1l3Nl1cjnasY2Zq9DSlFYQOsOFPaQTn0/a
4BEtSKH7MRrsLWHewEH0dA==
-----END PRIVATE KEY-----`;

function listenTls(handler: http.RequestListener): { server: https.Server; port: number } {
  const server = https.createServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, handler);
  server.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') { throw new Error('server has no port'); }
  return { server, port: addr.port };
}

function close(s: { server: http.Server | https.Server }): void {
  s.server.closeAllConnections();
  s.server.close();
}

/** 401 responder that emits the given WWW-Authenticate challenge. */
function authHandler(challenge: string): http.RequestListener {
  return (_req, res) => {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', challenge);
    res.setHeader('Content-Type', 'text/plain');
    res.end('Unauthorized');
  };
}

describe('detect.probeProtocol challenge handling', () => {
  let digestSrv: ReturnType<typeof listen>;
  let basicSrv: ReturnType<typeof listen>;
  let bearerSrv: ReturnType<typeof listen>;
  let plainSrv: ReturnType<typeof listen>;
  let notFoundSrv: ReturnType<typeof listen>;

  beforeAll(() => {
    digestSrv = listen(authHandler('Digest realm="validusers@robapi.abb", qop="auth", nonce="abc"'));
    basicSrv  = listen(authHandler('Basic realm="ROBAPI"'));
    bearerSrv = listen(authHandler('Bearer realm="something"'));
    plainSrv = listen((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body>router admin</body></html>');
    });
    notFoundSrv = listen((_req, res) => {
      res.statusCode = 404;
      res.end('Not Found');
    });
  });

  afterAll(() => {
    close(digestSrv); close(basicSrv); close(bearerSrv); close(plainSrv); close(notFoundSrv);
  });

  it('detects Digest as RWS 1.0', async () => {
    const proto = await probeProtocol('127.0.0.1', digestSrv.port, false, 1000);
    expect(proto).toBe('rws1');
  });

  it('detects Basic as RWS 2.0', async () => {
    const proto = await probeProtocol('127.0.0.1', basicSrv.port, false, 1000);
    expect(proto).toBe('rws2');
  });

  it('a Bearer challenge is not an RWS controller', async () => {
    const proto = await probeProtocol('127.0.0.1', bearerSrv.port, false, 1000);
    expect(proto).toBeNull();
  });

  it('a random web server answering 200 on /rw/system is not an RWS controller', async () => {
    const proto = await probeProtocol('127.0.0.1', plainSrv.port, false, 1000);
    expect(proto).toBeNull();
  });

  it('a 404 without a challenge is not an RWS controller', async () => {
    const proto = await probeProtocol('127.0.0.1', notFoundSrv.port, false, 1000);
    expect(proto).toBeNull();
  });

  it('returns null for unreachable port', async () => {
    // Port 1 is reliably refused on most systems
    const proto = await probeProtocol('127.0.0.1', 1, false, 500);
    expect(proto).toBeNull();
  });
});

describe('probeProtocol TLS verification', () => {
  let tlsBasicSrv: ReturnType<typeof listenTls>;

  beforeAll(() => {
    tlsBasicSrv = listenTls(authHandler('Basic realm="ROBAPI"'));
  });

  afterAll(() => { close(tlsBasicSrv); });

  it('accepts a self-signed certificate by default (controllers ship self-signed)', async () => {
    expect(await probeProtocol('127.0.0.1', tlsBasicSrv.port, true, 2000)).toBe('rws2');
  });

  it('rejects a self-signed certificate when strictTls is set', async () => {
    expect(await probeProtocol('127.0.0.1', tlsBasicSrv.port, true, 2000, true)).toBeNull();
  });

  it('createAdapter with strictTls refuses a self-signed controller outright', async () => {
    await expect(
      createAdapter({ host: '127.0.0.1', port: tlsBasicSrv.port, https: true, timeout: 2000, strictTls: true }),
    ).rejects.toThrow(/No RWS auth challenge/);
  });
});

describe('opts.timeout reaches the protocol probe', () => {
  let blackHole: ReturnType<typeof listen>;

  beforeAll(() => {
    // Accepts the connection but never answers - forces the probe to time out.
    blackHole = listen(() => {});
  });

  afterAll(() => { close(blackHole); });

  it('createClient with a pinned port fails within the caller timeout, not the 3 s default', async () => {
    const t0 = Date.now();
    await expect(
      createClient({ host: '127.0.0.1', port: blackHole.port, https: false, timeout: 300 }),
    ).rejects.toThrow(/No RWS auth challenge/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('createAdapter with a pinned port fails within the caller timeout, not the 3 s default', async () => {
    const t0 = Date.now();
    await expect(
      createAdapter({ host: '127.0.0.1', port: blackHole.port, https: false, timeout: 300 }),
    ).rejects.toThrow(/No RWS auth challenge/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

/**
 * TCP proxy that holds every chunk, in each direction, for `delayMs`: a link
 * whose round trip is 2 x delayMs, like a controller reached over a VPN.
 */
async function startDelayProxy(targetPort: number, delayMs: number): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(client => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    for (const [from, to] of [[client, upstream], [upstream, client]]) {
      sockets.add(from);
      from.on('error', () => { /* either side may drop */ });
      from.on('data', d => setTimeout(() => to.write(d), delayMs));
      // The end of a stream travels with the same delay as the data before it.
      from.on('end', () => setTimeout(() => to.end(), delayMs));
      from.on('close', () => sockets.delete(from));
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => { for (const s of sockets) { s.destroy(); } server.close(); },
  };
}

/** dns.lookup that answers 127.0.0.1 for `name` after `delayMs`, or never when null. */
function slowLookup(name: string, delayMs: number | null): typeof dns.lookup {
  const real = dns.lookup;
  return ((hostname: string, options: unknown, callback?: unknown) => {
    if (hostname !== name) { return (real as (...a: unknown[]) => void)(hostname, options, callback); }
    const cb = (typeof options === 'function' ? options : callback) as (...a: unknown[]) => void;
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    if (delayMs === null) { return; }
    setTimeout(() => (all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)), delayMs);
  }) as unknown as typeof dns.lookup;
}

describe('probeProtocol timing: timeoutMs bounds each wait, not the whole exchange', () => {
  // The probe's timeout was one absolute timer over the name lookup, the TCP
  // connect, the TLS handshake and the 401. A link whose round trips each fit
  // in timeoutMs but whose exchange as a whole did not answered null, and
  // auto-detect failed with PROTOCOL_DETECT_FAILED where it used to succeed.
  afterEach(() => { vi.restoreAllMocks(); });

  it('answers over a high-latency TLS 1.2 link whose whole exchange takes longer than timeoutMs', async () => {
    const tls12 = https.createServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY, maxVersion: 'TLSv1.2' },
      authHandler('Basic realm="ROBAPI"'));
    await new Promise<void>(r => tls12.listen(0, '127.0.0.1', r));
    // 120 ms each way: three round trips (two for the handshake, one for the
    // 401) take ~720 ms; no silence lasts longer than ~240 ms.
    const proxy = await startDelayProxy((tls12.address() as net.AddressInfo).port, 120);
    try {
      const t0 = Date.now();
      expect(await probeProtocol('127.0.0.1', proxy.port, true, 500)).toBe('rws2');
      expect(Date.now() - t0).toBeGreaterThan(500);
    } finally {
      proxy.close();
      tls12.closeAllConnections();
      tls12.close();
    }
  });

  it('does not count a slow name lookup against the connect budget', async () => {
    const srv = listen(authHandler('Digest realm="validusers@robapi.abb", qop="auth", nonce="abc"'));
    vi.spyOn(dns, 'lookup').mockImplementation(slowLookup('slow-name.test', 400));
    try {
      expect(await probeProtocol('slow-name.test', srv.port, false, 200)).toBe('rws1');
    } finally { close(srv); }
  });

  it('ends a lookup that never answers at four times timeoutMs', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(slowLookup('stalled-name.test', null));
    const t0 = Date.now();
    expect(await probeProtocol('stalled-name.test', 80, false, 100)).toBeNull();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(390);
    expect(took).toBeLessThan(1500);
  });

  it('a peer that accepts the connection and stays silent still answers null after timeoutMs', async () => {
    const silent = listen(() => { /* never answers */ });
    try {
      const t0 = Date.now();
      expect(await probeProtocol('127.0.0.1', silent.port, false, 200)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(700);
    } finally { close(silent); }
  });
});

describe('detect.createClient', () => {
  it('throws PROTOCOL_DETECT_FAILED when no port answers', async () => {
    await expect(
      createClient({ host: '127.0.0.1', port: 1, https: false }),
    ).rejects.toThrow(/PROTOCOL_DETECT_FAILED|RWS|host|connect/i);
  });
});

describe('strictTls and timeout reach the RWS 2.0 client constructors', () => {
  let basicSrv: ReturnType<typeof listen>;

  beforeAll(() => {
    basicSrv = listen(authHandler('Basic realm="ROBAPI"'));
  });

  afterAll(() => { close(basicSrv); });

  afterEach(() => {
    vi.doUnmock('../src/RwsClient2.js');
    vi.doUnmock('../src/RWS2Adapter.js');
    vi.resetModules();
  });

  /** Re-import detect with the RWS 2.0 client classes replaced by arg-capturing stubs. */
  async function detectWithCapture() {
    vi.resetModules();
    const ctorArgs: unknown[][] = [];
    class Capture {
      constructor(...args: unknown[]) { ctorArgs.push(args); }
      async connect(): Promise<void> {}
    }
    vi.doMock('../src/RwsClient2.js', () => ({ RwsClient2: Capture }));
    vi.doMock('../src/RWS2Adapter.js', () => ({ RWS2Adapter: Capture }));
    const detect = await import('../src/detect.js');
    return { detect, ctorArgs };
  }

  it('createClient maps strictTls to rejectUnauthorized and forwards the timeout', async () => {
    const { detect, ctorArgs } = await detectWithCapture();
    await detect.createClient({ host: '127.0.0.1', port: basicSrv.port, https: false, timeout: 1234, strictTls: true });
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0][0]).toBe(`http://127.0.0.1:${basicSrv.port}`);
    expect(ctorArgs[0][3]).toEqual({ timeout: 1234, rejectUnauthorized: true });
  });

  it('createAdapter keeps the insecure default when strictTls is unset', async () => {
    const { detect, ctorArgs } = await detectWithCapture();
    await detect.createAdapter({ host: '127.0.0.1', port: basicSrv.port, https: false, timeout: 800 });
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0][3]).toEqual({ timeout: 800, rejectUnauthorized: false });
  });

  it('createClient and createAdapter hand the checked control-station identity to the RWS 2.0 client', async () => {
    const { detect, ctorArgs } = await detectWithCapture();
    const controlStation = { name: 'RWS Daemon on cell-7', id: '{6F1C2A3B-4D5E-4F60-8A7B-9C0D1E2F3A4B}', pincode: '4711' };
    await detect.createClient({ host: '127.0.0.1', port: basicSrv.port, https: false, timeout: 800, controlStation });
    await detect.createAdapter({ host: '127.0.0.1', port: basicSrv.port, https: false, timeout: 800,
      controlStation: { ...controlStation, releaseWriteAccessWhenLost: true } });
    expect(ctorArgs).toHaveLength(2);
    expect(ctorArgs[0][3]).toEqual({ timeout: 800, rejectUnauthorized: false,
      controlStation: { ...controlStation, releaseWriteAccessWhenLost: false } });
    expect(ctorArgs[1][3]).toEqual({ timeout: 800, rejectUnauthorized: false,
      controlStation: { ...controlStation, releaseWriteAccessWhenLost: true } });
  });
});

/**
 * A refused login is AUTH_FAILED naming the host, port and user, and no other
 * account is tried. These tests used to assert the opposite - a silent second
 * login as 'Default User' when the default 'Admin' was refused - which
 * switched the UAS grants in force without the caller knowing; the fallback
 * is gone, and the tests now pin its absence.
 */
async function authFailure(p: Promise<unknown>): Promise<RwsError> {
  const e = await p.then(() => { throw new Error('the login was expected to fail'); }, (err: unknown) => err);
  expect(e).toBeInstanceOf(RwsError);
  expect((e as RwsError).code).toBe('AUTH_FAILED');
  return e as RwsError;
}

describe('createAdapter: a refused RWS 2.0 login tries no other account', () => {
  let basic401: ReturnType<typeof listen>;
  const users: string[] = [];

  beforeAll(() => {
    // Always rejects, but records which Basic-auth usernames were attempted.
    basic401 = listen((req, res) => {
      const auth = req.headers.authorization ?? '';
      if (auth.startsWith('Basic ')) {
        users.push(Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':')[0]);
      }
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm="ROBAPI"');
      res.end('Unauthorized');
    });
  });

  afterAll(() => { close(basic401); });

  it('the default Admin login refused: AUTH_FAILED, and "Default User" is never tried', async () => {
    users.length = 0;
    const e = await authFailure(createAdapter({ host: '127.0.0.1', port: basic401.port, https: false, timeout: 1000 }));
    expect(new Set(users)).toEqual(new Set(['Admin']));
    expect(e.httpStatus).toBe(401);
    expect(e.message).toContain(`Login to 127.0.0.1:${basic401.port} as 'Admin' was refused`);
    expect(e.message).toContain('HTTP 401');                       // the client's own message is kept
    expect(e.message).toMatch(/No username was given, so the default 'Admin' was used; the client does not try another account/);
    expect(e.message).not.toContain('robotics');                   // never the password
  });

  it('an explicit user refused: AUTH_FAILED naming that user, no other account tried', async () => {
    users.length = 0;
    const e = await authFailure(createAdapter({
      host: '127.0.0.1', port: basic401.port, https: false, timeout: 1000, username: 'operator1', password: 'secret-pw',
    }));
    expect(new Set(users)).toEqual(new Set(['operator1']));
    expect(e.message).toContain(`as 'operator1' was refused`);
    expect(e.message).toContain('Check the username and password');
    expect(e.message).not.toContain('secret-pw');
  });
});

describe('a refused RWS 1.0 login tries no other account', () => {
  // RwsClient surfaces a rejected login as RwsError('Authentication failed - …',
  // 'AUTH_FAILED') - no "401" or "unauthorized" in the message. Live-verified
  // against the IRC5 VC.
  let digest401: ReturnType<typeof listen>;
  const users: string[] = [];

  beforeAll(() => {
    // Always rejects, but records the digest usernames that were attempted.
    digest401 = listen((req, res) => {
      const m = /username="([^"]*)"/.exec(req.headers.authorization ?? '');
      if (m) { users.push(m[1]); }
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Digest realm="validusers@robapi.abb", qop="auth", nonce="abc", opaque="799d5", algorithm="MD5"');
      res.end('Unauthorized');
    });
  });

  afterAll(() => { close(digest401); });

  it('createAdapter: AUTH_FAILED, only Admin tried', async () => {
    users.length = 0;
    const e = await authFailure(createAdapter({ host: '127.0.0.1', port: digest401.port, https: false, timeout: 1000 }));
    expect(new Set(users)).toEqual(new Set(['Admin']));
    expect(e.message).toMatch(/as 'Admin' was refused \(Authentication failed/);
  });

  it('createClient: AUTH_FAILED, only Admin tried', async () => {
    users.length = 0;
    const e = await authFailure(createClient({ host: '127.0.0.1', port: digest401.port, https: false, timeout: 1000 }));
    expect(new Set(users)).toEqual(new Set(['Admin']));
    expect(e.message).toMatch(/as 'Admin' was refused \(Authentication failed/);
  });
});

describe('createAdapter returns the matching adapter type', () => {
  let digestOk: ReturnType<typeof listen>;

  beforeAll(() => {
    // Challenges once, then accepts whatever digest response arrives.
    digestOk = listen((req, res) => {
      if (!req.headers.authorization) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Digest realm="validusers@robapi.abb", qop="auth", nonce="abc", opaque="799d5", algorithm="MD5"');
        res.end('Unauthorized');
        return;
      }
      // connect() validates by parsing the controller state - return a minimal one.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><li class="pnl-ctrlstate"><span class="ctrlstate">motoron</span></li></body></html>');
    });
  });

  afterAll(() => { close(digestOk); });

  it('wraps an accepted RWS 1.0 login in an RWS1Adapter', async () => {
    const a = await createAdapter({ host: '127.0.0.1', port: digestOk.port, https: false, timeout: 1000 });
    expect(a).toBeInstanceOf(RWS1Adapter);
  });
});

describe('RwsClient2 instanceof check (used by createClient consumers)', () => {
  it('is a class (function in JS)', () => {
    expect(typeof RwsClient2).toBe('function');
  });
});

describe('port tables and the scheme each port implies', () => {
  const ports = KNOWN_RWS_PORTS.map(p => p.port);

  it('KNOWN_RWS_PORTS is the real-controller ports followed by the virtual-controller ports', () => {
    expect(REMOTE_RWS_PORTS).toEqual([
      { port: 443, https: true }, { port: 80, https: true }, { port: 80, https: false },
    ]);
    expect(VC_RWS_PORTS).toEqual([
      { port: 5466, https: true }, { port: 9403, https: true }, { port: 9805, https: true },
      { port: 11622, https: true }, { port: 11811, https: false }, { port: 28447, https: false },
    ]);
    expect(KNOWN_RWS_PORTS).toEqual([...REMOTE_RWS_PORTS, ...VC_RWS_PORTS]);
  });

  it('detect.js re-exports the same table, so its import path keeps working', () => {
    expect(KNOWN_RWS_PORTS).toBe(KNOWN_FROM_SCHEME);
  });

  it('covers real-controller defaults and the common virtual-controller ports', () => {
    // A regression that drops one of these silently loses a whole class of
    // controller from the fast discovery pass.
    for (const p of [443, 80, 5466, 9403, 9805, 11622, 11811, 28447]) {
      expect(ports, `port ${p} must stay in the known set`).toContain(p);
    }
  });

  it('tries real-controller defaults (443/80) before the virtual-controller ports, HTTPS before HTTP on 80', () => {
    // Closed ports refuse instantly, so real-first costs a VC nothing but makes a
    // physical robot answer on the first probe.
    expect(ports.indexOf(443)).toBeLessThan(ports.indexOf(5466));
    expect(ports.indexOf(80)).toBeLessThan(ports.indexOf(11811));
    expect(KNOWN_RWS_PORTS.filter(p => p.port === 80).map(p => p.https)).toEqual([true, false]);
  });

  it.each([
    [443, 'https'], [80, 'either'], [5466, 'https'], [9403, 'https'], [9805, 'https'], [11622, 'https'],
    [11811, 'http'], [28447, 'http'], [39127, 'either'], [8080, 'either'],
  ] as const)('schemeForPort(%i) is %s', (port, scheme) => {
    expect(schemeForPort(port)).toBe(scheme);
  });

  it('candidatesForPort: the given scheme only; else the known one; else HTTPS then HTTP', () => {
    expect(candidatesForPort(80, false)).toEqual([{ port: 80, https: false }]);
    expect(candidatesForPort(9805, false)).toEqual([{ port: 9805, https: false }]);
    expect(candidatesForPort(443)).toEqual([{ port: 443, https: true }]);
    expect(candidatesForPort(9805)).toEqual([{ port: 9805, https: true }]);
    expect(candidatesForPort(28447)).toEqual([{ port: 28447, https: false }]);
    expect(candidatesForPort(80)).toEqual([{ port: 80, https: true }, { port: 80, https: false }]);
    expect(candidatesForPort(39127)).toEqual([{ port: 39127, https: true }, { port: 39127, https: false }]);
  });

  it('describeRwsPorts lists each port once with its schemes, in table order', () => {
    expect(describeRwsPorts()).toBe(
      '443 (https), 80 (https, http), 5466 (https), 9403 (https), 9805 (https), 11622 (https), 11811 (http), 28447 (http)',
    );
    expect(describeRwsPorts([{ port: 80, https: false }, { port: 80, https: false }])).toBe('80 (http)');
  });
});

describe('createClient / createAdapter pick the scheme from the port when https is not given', () => {
  let basicTls: ReturnType<typeof listenTls>;
  let digestPlain: ReturnType<typeof listen>;
  const paths: string[] = [];

  beforeAll(() => {
    const record = (h: http.RequestListener): http.RequestListener => (req, res) => { paths.push(req.url ?? ''); h(req, res); };
    basicTls = listenTls(record(authHandler('Basic realm="validusers@robapi.abb"')));
    digestPlain = listen(record(authHandler('Digest realm="validusers@robapi.abb", qop="auth", nonce="abc"')));
  });

  afterAll(() => { close(basicTls); close(digestPlain); });

  afterEach(() => {
    for (const m of ['../src/RwsClient.js', '../src/RwsClient2.js', '../src/RWS2Adapter.js', 'https', 'http']) { vi.doUnmock(m); }
    vi.resetModules();
  });

  /**
   * Re-import detect with the login classes replaced by arg-capturing stubs and,
   * when `redirect` is given, every probe request's port rewritten through it.
   * A port missing from `redirect` makes request() throw, which the probe reads
   * as "no answer": no probe ever reaches a real port 80 or 9805 on this PC.
   */
  async function detectWith(redirect?: Record<number, number>) {
    vi.resetModules();
    const ctorArgs: unknown[][] = [];
    const sent: Array<{ scheme: 'https' | 'http'; port: number }> = [];
    class Capture {
      constructor(...args: unknown[]) { ctorArgs.push(args); }
      async connect(): Promise<void> {}
    }
    vi.doMock('../src/RwsClient.js', () => ({ RwsClient: Capture }));
    vi.doMock('../src/RwsClient2.js', () => ({ RwsClient2: Capture }));
    vi.doMock('../src/RWS2Adapter.js', () => ({ RWS2Adapter: Capture }));
    if (redirect) {
      for (const [scheme, real] of [['https', https], ['http', http]] as const) {
        const request = (options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void): http.ClientRequest => {
          const port = Number(options.port);
          sent.push({ scheme, port });
          const to = redirect[port];
          if (to === undefined) { throw new Error(`test: port ${port} is not redirected`); }
          return (real.request as typeof http.request)({ ...options, port: to }, cb);
        };
        vi.doMock(scheme, () => ({ ...real, request, default: { ...real, request } }));
      }
    }
    const detect = await import('../src/detect.js');
    return { detect, ctorArgs, sent };
  }

  it('port 80 without https against an HTTPS-only controller connects over HTTPS (createClient and createAdapter)', async () => {
    const { detect, ctorArgs, sent } = await detectWith({ 80: basicTls.port });
    await detect.createClient({ host: '127.0.0.1', port: 80, timeout: 2000 });
    await detect.createAdapter({ host: '127.0.0.1', port: 80, timeout: 2000 });
    expect(ctorArgs.map(a => a[0])).toEqual(['https://127.0.0.1:80', 'https://127.0.0.1:80']);
    // Both schemes were tried on 80, and only port 80 was touched.
    expect(new Set(sent.map(s => s.scheme))).toEqual(new Set(['https', 'http']));
    expect(new Set(sent.map(s => s.port))).toEqual(new Set([80]));
  });

  it('port 9805 without https connects over HTTPS and never tries HTTP', async () => {
    const { detect, ctorArgs, sent } = await detectWith({ 9805: basicTls.port });
    await detect.createClient({ host: '127.0.0.1', port: 9805, timeout: 2000 });
    await detect.createAdapter({ host: '127.0.0.1', port: 9805, timeout: 2000 });
    expect(ctorArgs.map(a => a[0])).toEqual(['https://127.0.0.1:9805', 'https://127.0.0.1:9805']);
    expect(sent).toEqual([{ scheme: 'https', port: 9805 }, { scheme: 'https', port: 9805 }]);
  });

  it('port 80 without https against a plain-HTTP IRC5 logs in over RWS 1.0', async () => {
    const { detect, ctorArgs } = await detectWith({ 80: digestPlain.port });
    await detect.createClient({ host: '127.0.0.1', port: 80, timeout: 2000 });
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0][0]).toMatchObject({ host: '127.0.0.1', port: 80 });
  });

  it('an explicit https:false on port 80 tries HTTP only', async () => {
    const { detect, sent } = await detectWith({ 80: basicTls.port });
    await expect(detect.createAdapter({ host: '127.0.0.1', port: 80, https: false, timeout: 1000 }))
      .rejects.toThrow(/No RWS auth challenge from 127\.0\.0\.1:80 \(tried http\)/);
    expect(sent).toEqual([{ scheme: 'http', port: 80 }]);
  });

  it('a port outside the table is probed over both schemes: a TLS controller there is reached over HTTPS', async () => {
    const { detect, ctorArgs } = await detectWith();
    await detect.createAdapter({ host: '127.0.0.1', port: basicTls.port, timeout: 2000 });
    expect(ctorArgs[0][0]).toBe(`https://127.0.0.1:${basicTls.port}`);
  });

  it('a port outside the table is probed over both schemes: a plain-HTTP IRC5 there is reached over HTTP', async () => {
    const { detect, ctorArgs } = await detectWith();
    await detect.createClient({ host: '127.0.0.1', port: digestPlain.port, timeout: 2000 });
    expect(ctorArgs[0][0]).toMatchObject({ host: '127.0.0.1', port: digestPlain.port });
  });

  it('on an either-scheme port the scheme that answers wins at once, and the stalled probe is ended', async () => {
    // A plain-HTTP server that waits forever for a request line a TLS handshake
    // never sends: the HTTPS probe stalls, the HTTP probe answers.
    let tlsSocketClosed: Promise<void> | undefined;
    const server = net.createServer(socket => {
      let buf = '';
      socket.on('error', () => { /* the client may drop */ });
      socket.on('data', d => {
        buf += d.toString('latin1');
        if (!buf.startsWith('GET ')) {
          tlsSocketClosed ??= new Promise(r => socket.once('close', () => r()));
          return;
        }
        if (buf.includes('\r\n\r\n')) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm="validusers@robapi.abb", qop="auth", nonce="abc"\r\n'
            + 'Content-Length: 0\r\nConnection: close\r\n\r\n');
        }
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const { detect, ctorArgs } = await detectWith();
      const t0 = Date.now();
      await detect.createClient({ host: '127.0.0.1', port, timeout: 3000 });
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(ctorArgs[0][0]).toMatchObject({ host: '127.0.0.1', port });
      expect(tlsSocketClosed).toBeDefined();
      await tlsSocketClosed;                     // ended by the winner, not by its own 3 s timer
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      server.close();
    }
  });

  it('probeHost probes port 80 over both schemes at once: a plain-HTTP IRC5 that ignores TLS costs no timeout', async () => {
    // The IRC5's RWS 1.0 server: it waits silently for a request line, so a TLS
    // ClientHello gets no answer at all.
    const server = net.createServer(socket => {
      let buf = '';
      socket.on('error', () => { /* the client may drop */ });
      socket.on('data', d => {
        buf += d.toString('latin1');
        if (buf.startsWith('GET ') && buf.includes('\r\n\r\n')) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm="validusers@robapi.abb", qop="auth", nonce="abc"\r\n'
            + 'Content-Length: 0\r\nConnection: close\r\n\r\n');
        }
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      // Only 80 is redirected; every other known port throws at once (no answer).
      const { detect, sent } = await detectWith({ 80: port });
      const t0 = Date.now();
      const hit = await detect.probeHost('127.0.0.1', 2000);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(hit).toEqual({ protocol: 'rws1', port: 80, https: false });
      expect(sent.filter(s => s.port === 80).map(s => s.scheme).sort()).toEqual(['http', 'https']);
      expect(sent[0]).toEqual({ scheme: 'https', port: 443 });
    } finally {
      server.close();
    }
  });

  it('nothing answering on an either-scheme port names both schemes in the error', async () => {
    const { detect } = await detectWith({});
    const e = await detect.createClient({ host: '127.0.0.1', port: 80, timeout: 500 }).then(() => null, (err: unknown) => err);
    expect((e as RwsError).code).toBe('PROTOCOL_DETECT_FAILED');
    expect((e as Error).message).toContain('127.0.0.1:80 (tried https and http)');
  });

  it('the probe asks for /rw/system (the path-table row)', async () => {
    paths.length = 0;
    expect(await probeProtocol('127.0.0.1', digestPlain.port, false, 2000)).toBe('rws1');
    expect(paths).toEqual(['/rw/system']);
  });

  it('with no port and nothing answering, the error lists every known port and scheme', async () => {
    // A host with a line feed cannot be sent at all, so no probe leaves this PC.
    const e = await createAdapter({ host: 'no\nsuch-host', timeout: 200 }).then(() => null, (err: unknown) => err);
    expect((e as RwsError).code).toBe('PROTOCOL_DETECT_FAILED');
    expect((e as Error).message).toContain(
      'tried ports 443 (https), 80 (https, http), 5466 (https), 9403 (https), 9805 (https), 11622 (https), 11811 (http), 28447 (http)',
    );
  });
});
