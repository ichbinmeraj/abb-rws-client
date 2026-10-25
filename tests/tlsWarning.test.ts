import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Logger } from '../src/Logger.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';
import * as tlsTrust from '../src/tlsTrust.js';

// Certificate checks stay off by default (the virtual controllers and, by
// ABB default, OmniCore controllers present a self-signed certificate), and
// the client says so once per process for each host and port, through the
// Logger at warn level, naming the option that turns the check on and how to
// trust a controller's certificate. Not for this PC's loopback, where the
// client reaches the virtual controllers (src/tlsTrust.ts says why).

vi.mock('../src/tlsTrust.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/tlsTrust.js')>();
  return { ...real, warnUnverifiedTls: vi.fn(real.warnUnverifiedTls) };
});

/**
 * A controller's own self-signed certificate for 127.0.0.1 (CA:FALSE, as a
 * device certificate is), and its key. Test fixture only, valid to 2076.
 */
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIBtTCCAVqgAwIBAgIUK8Z2cNeBrAiPE5CapT5RTjGcY9swCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAyNTAxNDQzNloYDzIwNzYxMDEy
MDE0NDM2WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAR2Tb1BaECV69z3FMWyEami4I8iqnHJW5GE8ib/l/thr9CpITjut5R3
SSYwUuKbe4Fzd98tROEVPA3TOJ6da/Nto4GHMIGEMB0GA1UdDgQWBBSBPBTv2axN
8iz4vo099HVdYZa41TAfBgNVHSMEGDAWgBSBPBTv2axN8iz4vo099HVdYZa41TAP
BgNVHREECDAGhwR/AAABMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgeAMBMG
A1UdJQQMMAoGCCsGAQUFBwMBMAoGCCqGSM49BAMCA0kAMEYCIQCWm8XvZ2gLUz9m
3Ye1hNeK9vtVIMjkzGndAE9C3po7GAIhAItk6K9+ATGwlV6pwWntFOaZs0KK4Fjz
MLPkX2M/XtEm
-----END CERTIFICATE-----
`;

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZShGXvQz8qi8Q+0S
t9kuf5istma7NjcFrpUkC3G8Rq+hRANCAAR2Tb1BaECV69z3FMWyEami4I8iqnHJ
W5GE8ib/l/thr9CpITjut5R3SSYwUuKbe4Fzd98tROEVPA3TOJ6da/Nt
-----END PRIVATE KEY-----
`;

/** Another certificate for 127.0.0.1, signed by a test CA (tests/fix151-stricttls.test.ts), and its key. */
const OTHER_CERT = `-----BEGIN CERTIFICATE-----
MIIBtDCCAVugAwIBAgIUPztwKRBQMXVU1DfG1cfqvFhSMkowCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNVGVzdCBQbGFudCBDQTAgFw0yNjEwMjQyMzEyNDVaGA8yMDc2
MDIwNDIzMTI0NVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEmsDBFjSDFNExT4R83PmgP5iG+TbsXExDsZGRFEWbgjBqMBbh
lniBVX2idLsQ+0//3QS0QVU+CQlJlW0h3TZdvKOBhDCBgTAPBgNVHREECDAGhwR/
AAABMAkGA1UdEwQCMAAwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUF
BwMBMB0GA1UdDgQWBBQOr5IO3jwr6saJB00E5UIDzSbi6zAfBgNVHSMEGDAWgBSQ
/vHm6TkyOh1pQzz4iwR53wXcYTAKBggqhkjOPQQDAgNHADBEAiBwSjCIdavmpVkJ
wQcVC5quxKdQwUm1a+26/vNUB3QAHAIgGFhAeu28Q6nPLslbCy5TxA5GQEAyYxYM
KdFXjHFLdg0=
-----END CERTIFICATE-----
`;

const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJ4JKeuspXs7aOuG8
LrUlw4XNvsxEBcLbhvLueVXhMZmhRANCAASawMEWNIMU0TFPhHzc+aA/mIb5Nuxc
TEOxkZEURZuCMGowFuGWeIFVfaJ0uxD7T//dBLRBVT4JCUmVbSHdNl28
-----END PRIVATE KEY-----
`;

type CaReader = (type?: string) => string[];
const require = createRequire(import.meta.url);
const tlsModule = require('node:tls') as { getCACertificates?: CaReader };
const originalReader = tlsModule.getCACertificates;
const hasReader = typeof originalReader === 'function';

/** An RWS 2.0 controller: 401 Basic without credentials, the system resource with them. */
function answer(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!req.headers.authorization && !req.headers.cookie) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="validusers@robapi.abb"', 'Content-Type': 'text/plain' });
    res.end('Access denied');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0', 'Set-Cookie': '-http-session-=S1; path=/' });
  res.end(JSON.stringify({ _links: {}, state: [{ _type: 'sys-system', _title: 'system', rwversion: '7.21.4+417' }] }));
}

async function controller(tls: { key: string; cert: string } | null): Promise<{ port: number; close: () => Promise<void> }> {
  const server = tls ? https.createServer(tls, answer) : http.createServer(answer);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const warnSpy = vi.mocked(tlsTrust.warnUnverifiedTls);

describe('the warning for a connection that does not check the certificate', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    tlsTrust.resetUnverifiedTlsWarnings();
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); warnSpy.mockClear(); });

  it('is logged once per host and port, at warn level', () => {
    tlsTrust.warnUnverifiedTls('192.168.125.1', 443);
    tlsTrust.warnUnverifiedTls('192.168.125.1', 443);
    expect(warn).toHaveBeenCalledTimes(1);
    tlsTrust.warnUnverifiedTls('192.168.125.1', 8443);
    tlsTrust.warnUnverifiedTls('omnicore-a.plant.example', 443);
    // Host names compare without case.
    tlsTrust.warnUnverifiedTls('OmniCore-A.plant.example', 443);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(c => /^TLS: the certificate of (\S+) is not checked \(strictTls is off\)/.exec(String(c[0]))?.[1])).toEqual([
      'https://192.168.125.1:443',
      'https://192.168.125.1:8443',
      'https://omnicore-a.plant.example:443',
    ]);
  });

  it('names the option that turns the check on, how to trust a certificate, and that pinning is not offered', () => {
    tlsTrust.warnUnverifiedTls('10.0.0.5', 443);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('strictTls: true');
    expect(line).toContain('rejectUnauthorized: true (RwsClient2)');
    expect(line).toContain('NODE_EXTRA_CA_CERTS');
    // tls.getCACertificates, which reads the store, is Node 22.15 and later.
    expect(line).toContain('on Node 22.15 and later, to this PC\'s certificate store');
    expect(line).toContain('no option that pins one certificate per controller');
    expect(line).toContain('Logged once per host and port.');
    expect(line).not.toMatch(/[\r\n]/);
  });

  it('is never logged for this PC\'s loopback, where the virtual controllers are reached', () => {
    for (const host of ['127.0.0.1', '127.5.6.7', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      tlsTrust.warnUnverifiedTls(host, 5466);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs again for a host after the warnings are reset (tests only)', () => {
    tlsTrust.warnUnverifiedTls('10.0.0.5', 443);
    tlsTrust.resetUnverifiedTlsWarnings();
    tlsTrust.warnUnverifiedTls('10.0.0.5', 443);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('where the RWS 2.0 client asks for it', () => {
  let srv: { port: number; close: () => Promise<void> } | null = null;
  beforeEach(() => { tlsTrust.resetUnverifiedTlsWarnings(); warnSpy.mockClear(); vi.spyOn(Logger, 'warn').mockImplementation(() => {}); });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalReader) { tlsModule.getCACertificates = originalReader; } else { delete tlsModule.getCACertificates; }
    tlsTrust.resetStrictTlsCa();
    await srv?.close();
    srv = null;
  });

  it('every request over https without the check names the host and port it goes to', async () => {
    srv = await controller({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT });
    const client = new RwsClient2(`https://127.0.0.1:${srv.port}`, 'u', 'p', { timeout: 3000 });
    await client.connect();
    await client.disconnect();
    expect(warnSpy).toHaveBeenCalled();
    for (const call of warnSpy.mock.calls) { expect(call).toEqual(['127.0.0.1', srv.port]); }
    // 127.0.0.1 is loopback: the client asked, and nothing was logged.
    expect(Logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('TLS:'));
  });

  it('the subscription POST and its WebSocket ask too, with no request before them', async () => {
    const seen: string[] = [];
    let port = 0;
    const server = https.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/subscription') {
          res.writeHead(201, {
            Location: `wss://127.0.0.1:${port}/poll/1`, 'Set-Cookie': 'ABBCX=t; path=/', 'Content-Type': 'application/xhtml+xml;v=2.0',
          });
          res.end(`<html><body><div class="state"><a href="subscription/1" rel="group"></a><a href="wss://127.0.0.1:${port}/poll/1" rel="self"></a></div></body></html>`);
          return;
        }
        res.writeHead(200);
        res.end();
      });
    });
    const wss = new WebSocketServer({ server, handleProtocols: p => [...p][0] ?? false });
    wss.on('connection', () => { seen.push('WS'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    srv = {
      port,
      close: () => new Promise<void>(r => { wss.close(); server.closeAllConnections(); server.close(() => r()); }),
    };

    const client = new RwsClient2(`https://127.0.0.1:${port}`, 'u', 'p', { timeout: 3000 });
    const unsubscribe = await client.subscribe(['speedratio'], () => {});
    // One call before the POST and one before the WebSocket, and nothing else was sent.
    expect(seen).toEqual(['POST /subscription', 'WS']);
    expect(warnSpy.mock.calls).toEqual([['127.0.0.1', port], ['127.0.0.1', port]]);
    await unsubscribe();
  });

  it('never with the check on, and never over plain http', async () => {
    srv = await controller({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT });
    const strict = new RwsClient2(`https://127.0.0.1:${srv.port}`, 'u', 'p', { rejectUnauthorized: true, timeout: 3000 });
    await expect(strict.connect()).rejects.toBeInstanceOf(RwsError);
    await strict.disconnect().catch(() => undefined);
    await srv.close();

    srv = await controller(null);
    const plain = new RwsClient2(`http://127.0.0.1:${srv.port}`, 'u', 'p', { timeout: 3000 });
    await plain.connect();
    await plain.disconnect();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.runIf(hasReader)('a controller\'s own self-signed certificate, once trusted, verifies with the check on; another certificate for the same address does not', async () => {
    // The operating system's store stands in for NODE_EXTRA_CA_CERTS, which
    // Node reads only when it starts: both land in the set the client checks against.
    tlsModule.getCACertificates = (type?: string): string[] =>
      type === 'system' ? [SELF_SIGNED_CERT] : originalReader!.call(tlsModule, type);
    tlsTrust.resetStrictTlsCa();

    srv = await controller({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT });
    const trusted = new RwsClient2(`https://127.0.0.1:${srv.port}`, 'u', 'p', { rejectUnauthorized: true, timeout: 3000 });
    await trusted.connect();
    await trusted.disconnect();
    await srv.close();

    srv = await controller({ key: OTHER_KEY, cert: OTHER_CERT });
    const other = new RwsClient2(`https://127.0.0.1:${srv.port}`, 'u', 'p', { rejectUnauthorized: true, timeout: 3000 });
    const err = await other.connect().catch((e: unknown) => e);
    await other.disconnect().catch(() => undefined);
    expect(err).toBeInstanceOf(RwsError);
    expect((err as RwsError).code).toBe('NETWORK_ERROR');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
