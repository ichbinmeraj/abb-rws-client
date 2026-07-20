import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import { probeProtocol, createClient, createAdapter } from '../src/detect.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';

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
});

describe('createAdapter Default-User fallback', () => {
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

  it('retries with "Default User" when the default Admin login is rejected', async () => {
    await expect(
      createAdapter({ host: '127.0.0.1', port: basic401.port, https: false, timeout: 1000 }),
    ).rejects.toThrow(/401/);
    expect(users).toContain('Admin');
    expect(users).toContain('Default User');
  });
});

describe('Default-User fallback against RWS 1.0 AUTH_FAILED errors', () => {
  // RwsClient surfaces a rejected login as RwsError('Authentication failed - …',
  // 'AUTH_FAILED') - no "401" or "unauthorized" in the message, so a message-regex
  // fallback never fires for RWS 1.0. Live-verified against the IRC5 VC.
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

  it('createAdapter retries with "Default User"', async () => {
    await expect(
      createAdapter({ host: '127.0.0.1', port: digest401.port, https: false, timeout: 1000 }),
    ).rejects.toThrow(/Authentication failed/);
    expect(users).toContain('Admin');
    expect(users).toContain('Default User');
  });

  it('createClient retries with "Default User"', async () => {
    users.length = 0;
    await expect(
      createClient({ host: '127.0.0.1', port: digest401.port, https: false, timeout: 1000 }),
    ).rejects.toThrow(/Authentication failed/);
    expect(users).toContain('Admin');
    expect(users).toContain('Default User');
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
