import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as https from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { probeOne } from '../src/discovery/probe.js';
import { probeProtocol } from '../src/detect.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';
import { resetStrictTlsCa, strictTlsCa } from '../src/tlsTrust.js';

// Under strictTls the discovery probe, the protocol probe and RWS 2.0's
// requests check a controller's certificate against one set of authorities:
// Node's default ones and the operating system's store (src/tlsTrust.ts).
// Before 1.5.1 the probe's plain tls.connect got Node's default only, while
// inside VS Code the client's https requests also got the system store, so a
// controller whose certificate a company CA signed was listed as unverified
// and then connected fine.
//
// The "company CA" here is a test CA that signs a certificate for 127.0.0.1;
// the operating system's store is simulated by replacing Node's
// tls.getCACertificates('system') (the same CommonJS module object the client
// reads it from). Test fixtures only (CA valid to 2076, leaf to 2076).

const COMPANY_CA = `-----BEGIN CERTIFICATE-----
MIIBlzCCAT2gAwIBAgIUcZA6zFNQq4zOLjrOvnykYyJgokEwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNVGVzdCBQbGFudCBDQTAgFw0yNjEwMjQyMzEyMzRaGA8yMDc2
MTAxMTIzMTIzNFowGDEWMBQGA1UEAwwNVGVzdCBQbGFudCBDQTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABH9aET/Et+fA4FpFMhYcJgaDR6Bi9JoB506rWLAZjPNm
TdI2+EUbbk2cmbNHReEenccJ1GdsxgUp1uKfXH+w8wejYzBhMB0GA1UdDgQWBBSQ
/vHm6TkyOh1pQzz4iwR53wXcYTAfBgNVHSMEGDAWgBSQ/vHm6TkyOh1pQzz4iwR5
3wXcYTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQD
AgNIADBFAiBdGGJ4P4Q0g+Q6Xyqc8Ey9k+LR9N+0xhZb2uvql8pR5gIhANMYWWB2
uoxjgpvZF36NL/M1h2K/Vi5FDrFaKb3Nxuau
-----END CERTIFICATE-----
`;

const CONTROLLER_CERT = `-----BEGIN CERTIFICATE-----
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

const CONTROLLER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJ4JKeuspXs7aOuG8
LrUlw4XNvsxEBcLbhvLueVXhMZmhRANCAASawMEWNIMU0TFPhHzc+aA/mIb5Nuxc
TEOxkZEURZuCMGowFuGWeIFVfaJ0uxD7T//dBLRBVT4JCUmVbSHdNl28
-----END PRIVATE KEY-----
`;

type CaReader = (type?: string) => string[];
const require = createRequire(import.meta.url);
const tlsModule = require('node:tls') as { getCACertificates?: CaReader; rootCertificates: readonly string[] };
const originalReader = tlsModule.getCACertificates;

/** Make the operating system's store read `system` (undefined: this Node has no reader at all). */
function systemStore(system: string[] | undefined): void {
  if (system === undefined) {
    delete tlsModule.getCACertificates;
  } else {
    tlsModule.getCACertificates = (type?: string): string[] =>
      type === 'system' ? system : originalReader!.call(tlsModule, type);
  }
  resetStrictTlsCa();
}

/** An RWS 2.0 controller over https with the company-CA certificate: 401 Basic without credentials. */
async function controller(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = https.createServer({ key: CONTROLLER_KEY, cert: CONTROLLER_CERT }, (req, res) => {
    if (!req.headers.authorization) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="validusers@robapi.abb"', 'Content-Type': 'text/plain' });
      res.end('Access denied');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0', 'Set-Cookie': '-http-session-=S1; path=/' });
    res.end(JSON.stringify({ _links: {}, state: [{ _type: 'sys-system', _title: 'system', rwversion: '7.21.4+417' }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** What the request path makes of the certificate: true when a verifying RwsClient2 connects. */
async function requestPathVerifies(port: number): Promise<boolean> {
  const client = new RwsClient2(`https://127.0.0.1:${port}`, 'u', 'p', { rejectUnauthorized: true, timeout: 3000 });
  try {
    await client.connect();
    return true;
  } catch (e) {
    expect(e).toBeInstanceOf(RwsError);
    expect((e as RwsError).code).toBe('NETWORK_ERROR');
    return false;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

const hasReader = typeof originalReader === 'function';

describe('strictTls: the probes and the requests trust the same authorities', () => {
  let srv: { port: number; close: () => Promise<void> };

  beforeEach(async () => { srv = await controller(); });
  afterEach(async () => {
    if (originalReader) { tlsModule.getCACertificates = originalReader; } else { delete tlsModule.getCACertificates; }
    resetStrictTlsCa();
    await srv.close();
  });

  it.runIf(hasReader)('the set is Node\'s default authorities plus the system store', () => {
    systemStore([COMPANY_CA]);
    const ca = strictTlsCa();
    expect(ca).toBeDefined();
    expect(ca).toContain(COMPANY_CA);
    // Node's bundled authorities are part of the default set.
    expect(ca).toContain(tlsModule.rootCertificates[0]);
  });

  it.runIf(hasReader)('a company CA in the system store: the discovery probe, the protocol probe and the client all verify it', async () => {
    systemStore([COMPANY_CA]);

    const outcome = await probeOne('127.0.0.1', srv.port, true, { timeoutMs: 3000, strictTls: true });
    expect(outcome.kind).toBe('rws');
    expect(await probeProtocol('127.0.0.1', srv.port, true, 3000, true)).toBe('rws2');
    expect(await requestPathVerifies(srv.port)).toBe(true);
  });

  it.runIf(hasReader)('the company CA in no store: all three refuse the certificate, the probe without sending a request', async () => {
    systemStore([]);

    const outcome = await probeOne('127.0.0.1', srv.port, true, { timeoutMs: 3000, strictTls: true });
    expect(outcome.kind).toBe('tls-unverified');
    expect(await probeProtocol('127.0.0.1', srv.port, true, 3000, true)).toBeNull();
    expect(await requestPathVerifies(srv.port)).toBe(false);
  });

  it('a Node that cannot read its authorities keeps its own default everywhere', async () => {
    systemStore(undefined);
    expect(strictTlsCa()).toBeUndefined();

    const outcome = await probeOne('127.0.0.1', srv.port, true, { timeoutMs: 3000, strictTls: true });
    expect(outcome.kind).toBe('tls-unverified');
    expect(await requestPathVerifies(srv.port)).toBe(false);
  });

  it.runIf(hasReader)('without strictTls nothing is verified, whatever the store holds', async () => {
    systemStore([]);
    const outcome = await probeOne('127.0.0.1', srv.port, true, { timeoutMs: 3000, strictTls: false });
    expect(outcome.kind).toBe('rws');
    const client = new RwsClient2(`https://127.0.0.1:${srv.port}`, 'u', 'p', { timeout: 3000 });
    await client.connect();
    await client.disconnect();
  });

  it.runIf(hasReader)('the set is read once per process, not per connection', async () => {
    let reads = 0;
    tlsModule.getCACertificates = (type?: string): string[] => {
      reads += 1;
      return type === 'system' ? [COMPANY_CA] : originalReader!.call(tlsModule, type);
    };
    resetStrictTlsCa();
    await probeOne('127.0.0.1', srv.port, true, { timeoutMs: 3000, strictTls: true });
    await probeOne('127.0.0.1', srv.port, true, { timeoutMs: 3000, strictTls: true });
    expect(await requestPathVerifies(srv.port)).toBe(true);
    expect(reads).toBe(2);   // 'default' and 'system', once
  });
});
