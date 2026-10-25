import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { TEST_TLS_KEY, TEST_TLS_CERT } from '../TlsFixture.js';

// Pass-through spy on net.connect: records the options of every outgoing connection so the
// tests can assert the address family and that an aborted probe opens nothing. Only loopback
// servers are used in this file, and no DNS lookup is made.
const spy = vi.hoisted(() => ({ connects: [] as Array<{ host?: string; port?: number; family?: number }> }));
const UNREACHABLE = vi.hoisted(() => '198.51.100.250');
// A documentation address whose connect is started 300 ms late, against 127.0.0.1, the way a host
// that defers net.connect does (the VS Code extension host while it loads system certificates).
const LATE = vi.hoisted(() => '198.51.100.251');
vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>();
  const connect = ((...args: unknown[]) => {
    const o = args[0] as { host?: string; port?: number; family?: number };
    spy.connects.push({ host: o.host, port: o.port, family: o.family });
    // A documentation address stands for a host whose TCP connect never completes: a socket
    // that is never connected, so nothing leaves this PC.
    if (o.host === UNREACHABLE) { return new actual.Socket(); }
    if (o.host === LATE) {
      const late = new actual.Socket();
      setTimeout(() => late.connect({ host: '127.0.0.1', port: o.port ?? 0, family: 4 }), 300);
      return late;
    }
    // A host name is recorded but never looked up: the connection goes to 127.0.0.1 instead.
    if (o.host !== undefined && actual.isIP(o.host) === 0) {
      return actual.connect({ host: '127.0.0.1', port: o.port ?? 0, family: 4 });
    }
    return (actual.connect as (...a: unknown[]) => net.Socket)(...args);
  }) as typeof actual.connect;
  return { ...actual, connect, default: { ...actual, connect } };
});

import {
  probeOne, classifyAnswer, parseChallenges, toLegacyProbeResult, sameFingerprint,
  defaultUserAgent, RWS_REALM, probeRequest, parseAnswerHead, MAX_ANSWER_HEAD_BYTES,
} from '../../src/discovery/probe.js';
import type { ProbeOptions } from '../../src/discovery/types.js';

const RWS1_CHALLENGE = 'Digest realm="validusers@robapi.abb", qop="auth", nonce="abc", opaque="xyz"';
const RWS2_CHALLENGE = 'Basic realm="validusers@robapi.abb"';
const CERT_FP = new X509Certificate(TEST_TLS_CERT).fingerprint256;

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders }

const servers: Array<net.Server> = [];
const serverSockets = new Set<net.Socket>();

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on('connection', (s: net.Socket) => { serverSockets.add(s); s.once('close', () => serverSockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

/** A loopback HTTP or HTTPS server that answers every request with `status` and the given auth headers. */
async function rwsServer(
  secure: boolean, status: number, auth: string | string[] | undefined,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const handler: http.RequestListener = (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (auth !== undefined) res.setHeader('WWW-Authenticate', auth);
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end('Access denied');
  };
  const server = secure
    ? https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler)
    : http.createServer(handler);
  return { port: await listen(server), seen };
}

/** A server that accepts TCP and never answers; resolves each server-side socket's close. */
async function silentServer(): Promise<{ port: number; closed: Promise<void>[] }> {
  const closed: Promise<void>[] = [];
  const server = net.createServer(sock => {
    closed.push(new Promise<void>(r => sock.once('close', () => r())));
    sock.on('error', () => { /* client destroyed it */ });
    // Read (and drop) so the end of the connection is noticed; a paused socket never sees it.
    sock.resume();
  });
  return { port: await listen(server), closed };
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

const OPTS: ProbeOptions = { timeoutMs: 2000, strictTls: false };

beforeEach(() => { spy.connects.length = 0; });
afterEach(async () => {
  for (const s of serverSockets) s.destroy();
  serverSockets.clear();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
});

describe('probeOne: RWS answers', () => {
  it('RWS 1.0: a Digest 401 with the RWS realm over HTTP is rws/digest; the request is one bare GET /rw/system', async () => {
    const { port, seen } = await rwsServer(false, 401, RWS1_CHALLENGE);
    const out = await probeOne('127.0.0.1', port, false, OPTS);
    expect(out).toMatchObject({ kind: 'rws', authType: 'digest', realm: RWS_REALM });
    expect(out).not.toHaveProperty('tlsFingerprint');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toBe('/rw/system');
    expect(seen[0].headers.accept).toBe('application/xhtml+xml;v=2.0');
    expect(seen[0].headers['user-agent']).toMatch(/^abb-rws-client\/\d+\.\d+\.\d+\S* discovery$/);
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers.cookie).toBeUndefined();
  });

  it('RWS 2.0: a Basic 401 with the RWS realm over HTTPS is rws/basic with the leaf SHA-256', async () => {
    const { port, seen } = await rwsServer(true, 401, RWS2_CHALLENGE);
    const out = await probeOne('127.0.0.1', port, true, OPTS);
    expect(out).toEqual({ kind: 'rws', authType: 'basic', realm: RWS_REALM, tlsFingerprint: CERT_FP, challenge: RWS2_CHALLENGE });
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['user-agent']).toBe(defaultUserAgent());
  });

  it('matches the scheme case-insensitively and accepts an unquoted realm', async () => {
    const { port } = await rwsServer(false, 401, 'basic realm=validusers@robapi.abb');
    const out = await probeOne('127.0.0.1', port, false, OPTS);
    expect(out).toMatchObject({ kind: 'rws', authType: 'basic', realm: RWS_REALM });
  });

  it('finds the RWS challenge among several WWW-Authenticate headers', async () => {
    const { port } = await rwsServer(false, 401, ['Negotiate', RWS1_CHALLENGE]);
    expect(await probeOne('127.0.0.1', port, false, OPTS)).toMatchObject({ kind: 'rws', authType: 'digest' });
  });
});

describe('probeOne: other answers', () => {
  it('a Basic 401 with a foreign realm is other-401 with that realm (listed, not identified)', async () => {
    const { port } = await rwsServer(true, 401, 'Basic realm="Router admin"');
    const out = await probeOne('127.0.0.1', port, true, OPTS);
    expect(out).toMatchObject({ kind: 'other-401', authType: 'basic', realm: 'Router admin', tlsFingerprint: CERT_FP });
  });

  it('a Digest 401 without a realm is other-401 without realm', async () => {
    const { port } = await rwsServer(false, 401, 'Digest nonce="1"');
    const out = await probeOne('127.0.0.1', port, false, OPTS);
    expect(out).toMatchObject({ kind: 'other-401', authType: 'digest' });
    expect(out).not.toHaveProperty('realm');
  });

  it('a 401 with another scheme, a 401 without a challenge and a 200 are not-rws', async () => {
    const a = await rwsServer(false, 401, 'Bearer realm="validusers@robapi.abb"');
    const b = await rwsServer(false, 401, undefined);
    const c = await rwsServer(false, 200, undefined);
    expect(await probeOne('127.0.0.1', a.port, false, OPTS)).toEqual({ kind: 'not-rws' });
    expect(await probeOne('127.0.0.1', b.port, false, OPTS)).toEqual({ kind: 'not-rws' });
    expect(await probeOne('127.0.0.1', c.port, false, OPTS)).toEqual({ kind: 'not-rws' });
  });

  it('HTTPS against a plain HTTP port is tls-failed (open, not TLS)', async () => {
    const { port } = await rwsServer(false, 401, RWS1_CHALLENGE);
    expect(await probeOne('127.0.0.1', port, true, OPTS)).toEqual({ kind: 'tls-failed' });
  });

  it('plain HTTP against a TLS port is not-rws', async () => {
    const { port, seen } = await rwsServer(true, 401, RWS2_CHALLENGE);
    expect(await probeOne('127.0.0.1', port, false, OPTS)).toEqual({ kind: 'not-rws' });
    expect(seen).toHaveLength(0);
  });

  it('a closed port is refused, over both schemes', async () => {
    const port = await freePort();
    expect(await probeOne('127.0.0.1', port, false, OPTS)).toEqual({ kind: 'refused' });
    expect(await probeOne('127.0.0.1', port, true, OPTS)).toEqual({ kind: 'refused' });
  });

  it('a port outside 0-65535 is refused without throwing', async () => {
    expect(await probeOne('127.0.0.1', 70000, false, OPTS)).toEqual({ kind: 'refused' });
  });

  it('a silent port times out within the budget and its socket is closed', async () => {
    const { port, closed } = await silentServer();
    const t0 = Date.now();
    expect(await probeOne('127.0.0.1', port, false, { ...OPTS, timeoutMs: 200 })).toEqual({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(closed).toHaveLength(1);
    await closed[0];
  });

  it('an open port that leaves the TLS handshake unanswered is tls-timeout, and its socket is closed', async () => {
    // A plain-HTTP server waiting silently for its request line, as the RW 6.16.03 VC does.
    const { port, closed } = await silentServer();
    const t0 = Date.now();
    expect(await probeOne('127.0.0.1', port, true, { ...OPTS, timeoutMs: 200 })).toEqual({ kind: 'tls-timeout' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(closed).toHaveLength(1);
    await closed[0];
  });

  it('HTTPS to a host whose TCP connect never completes is a plain timeout, not tls-timeout', async () => {
    expect(await probeOne(UNREACHABLE, 443, true, { ...OPTS, timeoutMs: 200 })).toEqual({ kind: 'timeout' });
    expect(await probeOne(UNREACHABLE, 80, false, { ...OPTS, timeoutMs: 200 })).toEqual({ kind: 'timeout' });
  });
});

describe('probeOne: strictTls', () => {
  it('a certificate that fails verification gives tls-unverified with the fingerprint, and no HTTP request is sent', async () => {
    const { port, seen } = await rwsServer(true, 401, RWS2_CHALLENGE);
    const out = await probeOne('127.0.0.1', port, true, { ...OPTS, strictTls: true });
    expect(out.kind).toBe('tls-unverified');
    if (out.kind !== 'tls-unverified') throw new Error('unreachable');
    expect(out.fingerprint).toBe(CERT_FP);
    expect(out.error).toMatch(/SELF_SIGNED|self.signed|UNABLE_TO_VERIFY/i);
    // Give the server a moment: had a GET been written, it would have arrived by now.
    await new Promise(r => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
  });

  it('strictTls has no effect on plain HTTP', async () => {
    const { port } = await rwsServer(false, 401, RWS1_CHALLENGE);
    expect(await probeOne('127.0.0.1', port, false, { ...OPTS, strictTls: true })).toMatchObject({ kind: 'rws' });
  });
});

describe('probeOne: abort, User-Agent, address family', () => {
  it('an already aborted signal opens no socket', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await probeOne('127.0.0.1', 9, false, { ...OPTS, signal: ac.signal })).toEqual({ kind: 'aborted' });
    expect(spy.connects).toHaveLength(0);
  });

  it('an abort in flight resolves aborted, before the timeout, after the socket has closed', async () => {
    const { port, closed } = await silentServer();
    const ac = new AbortController();
    const t0 = Date.now();
    const p = probeOne('127.0.0.1', port, true, { ...OPTS, timeoutMs: 10000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect(await p).toEqual({ kind: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(closed).toHaveLength(1);
    await closed[0];
  });

  it('a custom User-Agent is sent; an empty one sends none', async () => {
    const { port, seen } = await rwsServer(false, 401, RWS1_CHALLENGE);
    await probeOne('127.0.0.1', port, false, { ...OPTS, userAgent: 'my-tool/2.0' });
    await probeOne('127.0.0.1', port, false, { ...OPTS, userAgent: '' });
    expect(seen[0].headers['user-agent']).toBe('my-tool/2.0');
    expect(seen[1].headers['user-agent']).toBeUndefined();
  });

  it('connects over IPv4 for an IPv4 literal or a name, and over IPv6 only for an IPv6 literal', async () => {
    const port = await freePort();
    await probeOne('127.0.0.1', port, false, OPTS);
    await probeOne('::1', port, false, OPTS);
    await probeOne('localhost', port, false, OPTS);
    expect(spy.connects.map(c => [c.host, c.family])).toEqual([['127.0.0.1', 4], ['::1', 6], ['localhost', 4]]);
  });

  it('only ever connects to the host it was given', async () => {
    const { port } = await rwsServer(true, 401, RWS2_CHALLENGE);
    await probeOne('127.0.0.1', port, true, OPTS);
    expect(spy.connects).toEqual([{ host: '127.0.0.1', port, family: 4 }]);
  });
});

/** A server that writes `chunks` as raw bytes, one write each with a short pause, then ends (unless `end` is false). */
async function rawServer(chunks: string[], end = true): Promise<number> {
  const server = net.createServer(sock => {
    sock.on('error', () => { /* client destroyed it */ });
    sock.once('data', async () => {
      for (const c of chunks) {
        if (sock.destroyed) return;
        sock.write(c, 'latin1');
        await new Promise(r => setTimeout(r, 10));
      }
      if (end && !sock.destroyed) sock.end();
    });
  });
  return listen(server);
}

describe('probeOne: reading the answer by hand', () => {
  it('a head split across several packets is put back together', async () => {
    const port = await rawServer([
      'HTTP/1.1 40', '1 Unauthorized\r\nWWW-Authent', 'icate: Basic realm="validusers@robapi.abb"\r', '\n\r\nbody',
    ]);
    expect(await probeOne('127.0.0.1', port, false, OPTS)).toMatchObject({ kind: 'rws', authType: 'basic' });
  });

  it('an answer that is not HTTP, or that closes before its head ends, is not-rws', async () => {
    const notHttp = await rawServer(['SSH-2.0-OpenSSH_9.6\r\n\r\n']);
    expect(await probeOne('127.0.0.1', notHttp, false, OPTS)).toEqual({ kind: 'not-rws' });
    const cut = await rawServer(['HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="validusers@robapi.abb"\r\n']);
    expect(await probeOne('127.0.0.1', cut, false, OPTS)).toEqual({ kind: 'not-rws' });
  });

  it('a head longer than the limit is not-rws without waiting for the timeout', async () => {
    const filler = `X-Filler: ${'a'.repeat(1000)}\r\n`;
    const port = await rawServer(
      ['HTTP/1.1 401 Unauthorized\r\n', filler.repeat(Math.ceil(MAX_ANSWER_HEAD_BYTES / filler.length) + 1)], false,
    );
    const started = Date.now();
    expect(await probeOne('127.0.0.1', port, false, { ...OPTS, timeoutMs: 5000 })).toEqual({ kind: 'not-rws' });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('a head over the limit is not-rws even when its end arrives in the same read', async () => {
    const big = `X-Filler: ${'a'.repeat(MAX_ANSWER_HEAD_BYTES + 100)}\r\n`;
    const port = await rawServer([`HTTP/1.1 401 Unauthorized\r\n${big}WWW-Authenticate: ${RWS2_CHALLENGE}\r\n\r\n`]);
    expect(await probeOne('127.0.0.1', port, false, OPTS)).toEqual({ kind: 'not-rws' });
  });

  it('a service that answers something other than HTTP and keeps the connection open is not-rws at once', async () => {
    const port = await rawServer(['SSH-2.0-OpenSSH_9.6\r\n'], false);
    const started = Date.now();
    expect(await probeOne('127.0.0.1', port, false, { ...OPTS, timeoutMs: 5000 })).toEqual({ kind: 'not-rws' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('interim 1xx answers before the 401 are skipped; 101 is final', async () => {
    const challenge = `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${RWS2_CHALLENGE}\r\n\r\n`;
    const port = await rawServer(['HTTP/1.1 100 Continue\r\n\r\n', 'HTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\n', challenge]);
    expect(await probeOne('127.0.0.1', port, false, OPTS)).toMatchObject({ kind: 'rws', authType: 'basic' });
    const together = await rawServer([`HTTP/1.1 100 Continue\r\n\r\n${challenge}`]);
    expect(await probeOne('127.0.0.1', together, false, OPTS)).toMatchObject({ kind: 'rws', authType: 'basic' });
    const upgrade = await rawServer([`HTTP/1.1 101 Switching Protocols\r\n\r\n${challenge}`]);
    expect(await probeOne('127.0.0.1', upgrade, false, OPTS)).toEqual({ kind: 'not-rws' });
  });

  it('bare LF line endings and empty lines before the status line are read like CRLF', async () => {
    const lf = await rawServer([`HTTP/1.1 401 Unauthorized\nWWW-Authenticate: ${RWS1_CHALLENGE}\n\n`]);
    expect(await probeOne('127.0.0.1', lf, false, OPTS)).toMatchObject({ kind: 'rws', authType: 'digest' });
    const leading = await rawServer([`\r\n\r\nHTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${RWS1_CHALLENGE}\r\n\r\n`]);
    expect(await probeOne('127.0.0.1', leading, false, OPTS)).toMatchObject({ kind: 'rws', authType: 'digest' });
  });

  it('a connect that completes after the probe ended sends nothing and is closed', async () => {
    let connections = 0;
    let received = 0;
    let closed = 0;
    const server = net.createServer(sock => {
      connections += 1;
      sock.on('data', d => { received += d.length; });
      sock.on('error', () => { /* client destroyed it */ });
      sock.once('close', () => { closed += 1; });
    });
    const port = await listen(server);
    for (const https of [false, true]) {
      expect(await probeOne(LATE, port, https, { ...OPTS, timeoutMs: 100 })).toEqual({ kind: 'timeout' });
    }
    await new Promise(r => setTimeout(r, 800));
    expect(received).toBe(0);
    expect(closed).toBe(connections);
  });

  it('a User-Agent with a control character sends nothing and is not-rws', async () => {
    const { port, seen } = await rwsServer(false, 401, RWS1_CHALLENGE);
    expect(await probeOne('127.0.0.1', port, false, { ...OPTS, userAgent: 'a\r\nX-Injected: 1' })).toEqual({ kind: 'not-rws' });
    expect(seen).toHaveLength(0);
  });
});

describe('pure helpers', () => {
  it('probeRequest: one GET with Host, Accept, User-Agent and Connection: close', () => {
    expect(probeRequest('127.0.0.1', 9403, true, 'ua/1')).toBe(
      'GET /rw/system HTTP/1.1\r\nHost: 127.0.0.1:9403\r\nAccept: application/xhtml+xml;v=2.0\r\n'
      + 'User-Agent: ua/1\r\nConnection: close\r\n\r\n');
    expect(probeRequest('10.0.0.5', 443, true, '')).toBe(
      'GET /rw/system HTTP/1.1\r\nHost: 10.0.0.5\r\nAccept: application/xhtml+xml;v=2.0\r\nConnection: close\r\n\r\n');
    expect(probeRequest('10.0.0.5', 80, false, '')).toContain('\r\nHost: 10.0.0.5\r\n');
    expect(probeRequest('10.0.0.5', 80, true, '')).toContain('\r\nHost: 10.0.0.5:80\r\n');
    expect(probeRequest('::1', 8080, false, '')).toContain('\r\nHost: [::1]:8080\r\n');
    expect(probeRequest('a\nb', 80, false, '')).toBeUndefined();
    expect(probeRequest('10.0.0.5', 80, false, 'x\u0000')).toBeUndefined();
  });

  it('parseAnswerHead: the status and every WWW-Authenticate value, header names in any case', () => {
    expect(parseAnswerHead('HTTP/1.1 401 Unauthorized\r\nwww-authenticate:  Basic realm="r"  \r\nX: y\r\nWWW-Authenticate: Negotiate'))
      .toEqual({ status: 401, authValues: ['Basic realm="r"', 'Negotiate'] });
    expect(parseAnswerHead('HTTP/1.0 200 OK')).toEqual({ status: 200, authValues: [] });
    expect(parseAnswerHead('HTTP/1.1 401')).toEqual({ status: 401, authValues: [] });
    expect(parseAnswerHead('HTTP/1.1 401 x\nWWW-Authenticate: Basic realm="r"')).toEqual({ status: 401, authValues: ['Basic realm="r"'] });
    expect(parseAnswerHead('HTTP/2 401 x')).toBeUndefined();
    expect(parseAnswerHead('SSH-2.0-OpenSSH')).toBeUndefined();
  });

  it('parseChallenges: escaped quotes, several challenges in one header, other schemes skipped', () => {
    expect(parseChallenges(['Basic realm="a \\"b\\" c"'])).toEqual([{ authType: 'basic', realm: 'a "b" c' }]);
    expect(parseChallenges(['Negotiate, Basic realm="x", Digest realm="validusers@robapi.abb", nonce="n"'])).toEqual([
      { authType: 'basic', realm: 'x' },
      { authType: 'digest', realm: 'validusers@robapi.abb' },
    ]);
    expect(parseChallenges(['Bearer realm="x"', 'NTLM'])).toEqual([]);
    expect(parseChallenges(['DigestX realm="x"'])).toEqual([]);
  });

  it('classifyAnswer: only a 401 counts; the realm must match exactly', () => {
    expect(classifyAnswer(200, [RWS2_CHALLENGE])).toEqual({ kind: 'not-rws' });
    expect(classifyAnswer(401, ['Basic realm="Validusers@robapi.abb"'])).toMatchObject({ kind: 'other-401' });
    expect(classifyAnswer(401, [RWS2_CHALLENGE], 'AA:BB')).toMatchObject({ kind: 'rws', tlsFingerprint: 'AA:BB' });
  });

  it('toLegacyProbeResult keeps the old case-sensitive rule and ignores the realm', () => {
    expect(toLegacyProbeResult(80, false, classifyAnswer(401, [RWS1_CHALLENGE]))).toEqual({ port: 80, useHttps: false, authType: 'digest' });
    expect(toLegacyProbeResult(443, true, classifyAnswer(401, ['Basic realm="other"']))).toEqual({ port: 443, useHttps: true, authType: 'basic' });
    expect(toLegacyProbeResult(80, false, classifyAnswer(401, ['basic realm="validusers@robapi.abb"']))).toBeNull();
    expect(toLegacyProbeResult(80, false, classifyAnswer(401, ['Negotiate', RWS1_CHALLENGE]))).toBeNull();
    for (const kind of ['not-rws', 'tls-failed', 'tls-timeout', 'refused', 'timeout', 'aborted'] as const) {
      expect(toLegacyProbeResult(80, false, { kind })).toBeNull();
    }
    expect(toLegacyProbeResult(80, true, { kind: 'tls-unverified', error: 'x' })).toBeNull();
  });

  it('sameFingerprint ignores separators and case, and never matches an empty value', () => {
    expect(sameFingerprint('AA:bb:01', 'aabb01')).toBe(true);
    expect(sameFingerprint('AA:BB', 'AA:BC')).toBe(false);
    expect(sameFingerprint(undefined, 'AA')).toBe(false);
    expect(sameFingerprint(':', ':')).toBe(false);
  });

  it('defaultUserAgent names the package and its version', () => {
    expect(defaultUserAgent()).toMatch(/^abb-rws-client\/\d+\.\d+\.\d+\S* discovery$/);
  });
});
