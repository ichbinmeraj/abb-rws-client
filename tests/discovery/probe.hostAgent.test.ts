import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { TEST_TLS_KEY, TEST_TLS_CERT } from '../TlsFixture.js';
import { probeOne, RWS_REALM } from '../../src/discovery/probe.js';

// A host that hands every `http.request` an agent of its own, the way the VS Code extension
// host does by default (`http.proxySupport: "override"`). Node then sends the request through
// that agent and ignores `createConnection`, so a probe that relied on it sent plain HTTP to the
// HTTPS port and every RWS 2.0 controller looked like "not RWS". The probe must send its request
// on the socket it opened itself, whatever the host did to the `http` module.
const require = createRequire(import.meta.url);
const httpModule = require('node:http') as typeof http & Record<string, unknown>;
const original = { request: httpModule.request, get: httpModule.get };

function withHostAgent<T extends (...a: never[]) => http.ClientRequest>(fn: T): T {
  return ((...args: unknown[]) => {
    const at = args.findIndex(a => a !== null && typeof a === 'object' && !(a instanceof URL));
    const options = { ...(at >= 0 ? args[at] as http.RequestOptions : {}), agent: new http.Agent() };
    const rest = args.filter((_, i) => i !== at && typeof args[i] === 'function');
    return (fn as unknown as (...a: unknown[]) => http.ClientRequest)(options, ...rest);
  }) as unknown as T;
}

const CERT_FP = new X509Certificate(TEST_TLS_CERT).fingerprint256;
const OPTS = { timeoutMs: 2000, strictTls: false };
const servers: net.Server[] = [];

async function rwsServer(secure: boolean, challenge: string): Promise<{ port: number; connections: () => number }> {
  let count = 0;
  const handler: http.RequestListener = (_req, res) => {
    res.setHeader('WWW-Authenticate', challenge);
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Access denied');
  };
  const server = secure
    ? https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler)
    : http.createServer(handler);
  // Every TCP connection counts, so a second one opened by the host's agent shows.
  server.on('connection', () => { count += 1; });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as AddressInfo).port, connections: () => count };
}

beforeAll(() => {
  httpModule.request = withHostAgent(original.request);
  httpModule.get = withHostAgent(original.get);
  syncBuiltinESMExports();
});

afterAll(() => {
  httpModule.request = original.request;
  httpModule.get = original.get;
  syncBuiltinESMExports();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => {
    (s as http.Server).closeAllConnections?.();
    s.close(() => r());
  })));
});

describe('probeOne under a host that swaps the http agent (VS Code extension host)', () => {
  it('the host patch is active in this file', () => {
    expect(http.request).not.toBe(original.request);
  });

  it('RWS 2.0: a Basic 401 over HTTPS is still rws/basic with the leaf SHA-256', async () => {
    const { port, connections } = await rwsServer(true, 'Basic realm="validusers@robapi.abb"');
    const out = await probeOne('127.0.0.1', port, true, OPTS);
    expect(out).toMatchObject({ kind: 'rws', authType: 'basic', realm: RWS_REALM, tlsFingerprint: CERT_FP });
    expect(connections()).toBe(1);
  });

  it('RWS 1.0: a Digest 401 over HTTP is rws/digest, on the probe\'s own single connection', async () => {
    const { port, connections } = await rwsServer(false, 'Digest realm="validusers@robapi.abb", qop="auth", nonce="n"');
    const out = await probeOne('127.0.0.1', port, false, OPTS);
    expect(out).toMatchObject({ kind: 'rws', authType: 'digest', realm: RWS_REALM });
    expect(connections()).toBe(1);
  });
});
