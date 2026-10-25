import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildSession, identifyOverNetwork, loginAndRead, loginRefusalReason, normaliseFingerprint, parseCallerKey,
  type IdentifyRow, type IdentifySession, type LoginTarget, type SessionFactory,
} from '../../src/discovery/identify.js';
import { RWS1Adapter } from '../../src/RWS1Adapter.js';
import { RWS2Adapter } from '../../src/RWS2Adapter.js';
import { RwsError } from '../../src/types.js';

/*
 * Every address here is loopback or an RFC 5737 documentation address, and no test opens a
 * socket to anything but a mock controller on 127.0.0.1. Credentials are made up.
 */

const LOCAL = (h: string): boolean => h === 'localhost' || h.startsWith('127.') || h === '::1' || h === '198.51.100.7';
const CRED = { username: 'tester', password: 'not-a-real-secret' };
const FP = 'AB:CD:' + 'ef'.repeat(30);

function row(p: Partial<IdentifyRow> & Pick<IdentifyRow, 'host' | 'port'>): IdentifyRow {
  return {
    key: `${LOCAL(p.host) ? 'local' : p.host}:${p.port}`,
    https: true, generation: 'rws2', identified: true, realm: 'validusers@robapi.abb', ...p,
  };
}

interface FakeLog { targets: LoginTarget[]; logouts: string[]; inFlight: number; maxInFlight: number }

/** A fake client per login. `mode` decides how connect behaves. */
function fakeFactory(mode: (t: LoginTarget) => 'ok' | 'throw-after-auth' | 'refused' | 'read-fails' = () => 'ok', delayMs = 5): { factory: SessionFactory; log: FakeLog } {
  const log: FakeLog = { targets: [], logouts: [], inFlight: 0, maxInFlight: 0 };
  const factory: SessionFactory = t => {
    log.targets.push(t);
    let cookie: string | null = null;
    const where = `${t.host}:${t.port}`;
    const s: IdentifySession = {
      async connect() {
        log.inFlight++; log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        await new Promise(r => setTimeout(r, delayMs));
        const m = mode(t);
        if (m === 'refused') { throw new RwsError(`HTTP 401 for user ${t.username} password ${t.password}`, 'AUTH_FAILED'); }
        cookie = '-http-session-=abc';
        if (m === 'throw-after-auth') { throw new RwsError('PARSE_ERROR: unexpected body', 'PARSE_ERROR'); }
      },
      async getSystemInfo() {
        if (mode(t) === 'read-fails') { throw new RwsError('HTTP 500', 'UNKNOWN'); }
        return { name: `SYS_${t.port}`, rwVersion: '8.2.1+1023', sysid: `{ID-${t.port}}`, startTime: '', options: [] };
      },
      async getRobotType() { return { type: 'IRB 1600-6/1.2' }; },
      getSessionCookie() { return cookie; },
      async disconnect() { log.logouts.push(where); log.inFlight--; cookie = null; },
    };
    return s;
  };
  return { factory, log };
}

describe('identify: key parsing and rules', () => {
  it('parseCallerKey: discoveryKey, host:port, [v6]:port, host only; this PC is local', () => {
    expect(parseCallerKey('local:5466', LOCAL)).toEqual({ host: 'local', port: 5466 });
    expect(parseCallerKey('127.0.0.1:80', LOCAL)).toEqual({ host: 'local', port: 80 });
    expect(parseCallerKey('localhost', LOCAL)).toEqual({ host: 'local' });
    expect(parseCallerKey('[::1]:9805', LOCAL)).toEqual({ host: 'local', port: 9805 });
    expect(parseCallerKey('198.51.100.7:443', LOCAL)).toEqual({ host: 'local', port: 443 });
    expect(parseCallerKey('192.0.2.10:443', LOCAL)).toEqual({ host: '192.0.2.10', port: 443 });
    expect(parseCallerKey('Robot1.Example.:443', LOCAL)).toEqual({ host: 'robot1.example', port: 443 });
    expect(parseCallerKey('192.0.2.10', LOCAL)).toEqual({ host: '192.0.2.10' });
    expect(parseCallerKey('192.0.2.10:x', LOCAL)).toBeUndefined();
    expect(parseCallerKey('192.0.2.10:70000', LOCAL)).toBeUndefined();
    expect(parseCallerKey(' ', LOCAL)).toBeUndefined();
  });

  it('loginRefusalReason: not identified, unknown protocol or scheme, plain HTTP off this PC, RWS 1.0 over HTTPS', () => {
    expect(loginRefusalReason(row({ host: '192.0.2.10', port: 443, identified: false, realm: 'other' }), LOCAL)).toMatch(/realm "other"/);
    expect(loginRefusalReason(row({ host: '192.0.2.10', port: 443, generation: null }), LOCAL)).toMatch(/protocol/);
    expect(loginRefusalReason(row({ host: '192.0.2.10', port: 443, https: null }), LOCAL)).toMatch(/never probed/);
    expect(loginRefusalReason(row({ host: '192.0.2.10', port: 80, https: false }), LOCAL)).toMatch(/plain HTTP/);
    expect(loginRefusalReason(row({ host: '127.0.0.1', port: 39127, https: false, generation: 'rws1' }), LOCAL)).toBeNull();
    expect(loginRefusalReason(row({ host: '192.0.2.10', port: 443, generation: 'rws1' }), LOCAL)).toMatch(/RWS 1.0 over HTTPS/);
    expect(loginRefusalReason(row({ host: '192.0.2.10', port: 443 }), LOCAL)).toBeNull();
  });

  it('normaliseFingerprint drops colons and case', () => {
    expect(normaliseFingerprint('AB:cd :EF')).toBe('abcdef');
  });

  it('buildSession builds the same adapters createAdapter builds, never with defaults', () => {
    const t = { host: '127.0.0.1', port: 39127, https: false, username: 'u', password: 'p' };
    expect(buildSession({ ...t, generation: 'rws1' })).toBeInstanceOf(RWS1Adapter);
    expect(buildSession({ ...t, port: 9805, https: true, generation: 'rws2' })).toBeInstanceOf(RWS2Adapter);
    expect(() => buildSession({ ...t, generation: 'rws1', https: true })).toThrow(/RWS 1.0 over HTTPS/);
    expect(() => buildSession({ ...t, generation: 'rws2', username: '' })).toThrow(RwsError);
  });
});

describe('identify: identifyOverNetwork (fake clients)', () => {
  it('logs in only to identified entries with a matching key, with that entry\'s credentials', async () => {
    const { factory, log } = fakeFactory();
    const rows = [
      row({ host: '127.0.0.1', port: 5466 }),
      row({ host: '127.0.0.1', port: 9805 }),
      row({ host: '192.0.2.10', port: 443, identified: false, realm: 'someone-else' }),
      row({ host: '127.0.0.1', port: 39127, https: false, generation: 'rws1' }),
    ];
    const r = await identifyOverNetwork(rows, {
      credentials: { 'local:5466': CRED, '192.0.2.10:443': CRED, '127.0.0.1:39127': { username: 'other', password: 'x' } },
      isLocal: LOCAL, createSession: factory,
    });
    expect(log.targets.map(t => [t.host, t.port, t.username, t.generation, t.https])).toEqual([
      ['127.0.0.1', 5466, 'tester', 'rws2', true],
      ['127.0.0.1', 39127, 'other', 'rws1', false],
    ]);
    expect(log.logouts).toEqual(['127.0.0.1:5466', '127.0.0.1:39127']);
    expect(r.outcomes).toEqual([
      { key: 'local:5466', status: 'identified', generation: 'rws2', systemName: 'SYS_5466', systemId: '{ID-5466}', rwVersion: '8.2.1+1023', robotType: 'IRB 1600-6/1.2' },
      { key: '192.0.2.10:443', status: 'skipped', note: expect.stringMatching(/did not identify as an ABB controller \(realm "someone-else"\)/) },
      { key: 'local:39127', status: 'identified', generation: 'rws1', systemName: 'SYS_39127', systemId: '{ID-39127}', rwVersion: '8.2.1+1023', robotType: 'IRB 1600-6/1.2' },
    ]);
    expect(r.unmatchedCredentials).toEqual([]);
    expect(r.notes).toHaveLength(1);
  });

  it('a controller without a matching entry is never logged in to, and stray keys are reported', async () => {
    const { factory, log } = fakeFactory();
    const r = await identifyOverNetwork([row({ host: '127.0.0.1', port: 5466 })], {
      credentials: { 'local:9999': CRED, '203.0.113.5': CRED, 'garbage:key:x': CRED }, isLocal: LOCAL, createSession: factory,
    });
    expect(log.targets).toHaveLength(0);
    expect(r.outcomes).toEqual([]);
    expect(r.unmatchedCredentials).toEqual(['local:9999', '203.0.113.5', 'garbage:key:x']);
  });

  it('matches host:port before host, and the typed name, localhost and this PC\'s LAN address', async () => {
    const { factory, log } = fakeFactory();
    await identifyOverNetwork([
      row({ host: '192.0.2.10', port: 443, name: 'Robot1.example' }),
      row({ host: '127.0.0.1', port: 80 }),
    ], {
      credentials: {
        'robot1.example': { username: 'by-name', password: 'p' },
        '192.0.2.10:443': { username: 'by-address-port', password: 'p' },
        '198.51.100.7:80': { username: 'by-lan-address', password: 'p' },
        localhost: { username: 'by-localhost', password: 'p' },
      },
      isLocal: LOCAL, createSession: factory,
    });
    expect(log.targets.map(t => t.username)).toEqual(['by-address-port', 'by-lan-address']);
  });

  it('a key naming a folded address never sends its password to the entry\'s own host', async () => {
    // 198.51.100.5 claimed the same system id (an unauthenticated mDNS SysGuid) and became the
    // entry; 198.51.100.6, the host the caller named, was folded into its addresses.
    const { factory, log } = fakeFactory();
    const folded = row({
      host: '198.51.100.5', port: 443,
      addresses: [
        { host: '198.51.100.5', port: 443, https: true, sources: ['range'] },
        { host: '198.51.100.6', port: 443, https: true, sources: ['range'] },
      ],
    });
    const r = await identifyOverNetwork([folded], {
      credentials: { '198.51.100.6:443': CRED, '198.51.100.6': { username: 'by-host', password: 'p' } },
      isLocal: LOCAL, createSession: factory,
    });
    expect(log.targets).toHaveLength(0);
    expect(r.outcomes).toEqual([{ key: '198.51.100.5:443', status: 'skipped', note: expect.stringMatching(/names another address of this entry/) }]);
    expect(r.unmatchedCredentials).toEqual([]);
    expect(r.notes[0]).not.toContain(CRED.password);

    // A key for the entry's own address still logs in there, and only there.
    const own = fakeFactory();
    await identifyOverNetwork([folded], { credentials: { '198.51.100.5:443': CRED }, isLocal: LOCAL, createSession: own.factory });
    expect(own.log.targets.map(t => `${t.host}:${t.port}`)).toEqual(['198.51.100.5:443']);
  });

  it('a pinned fingerprint on a folded address still stops a login whose certificate differs', async () => {
    const { factory, log } = fakeFactory();
    const r = await identifyOverNetwork([row({
      host: '198.51.100.5', port: 443, tlsFingerprint: FP,
      addresses: [{ host: '198.51.100.6', port: 443, https: true, sources: ['range'] }],
    })], {
      credentials: { '198.51.100.5:443': CRED }, pinnedFingerprints: { '198.51.100.6:443': '00'.repeat(32) },
      isLocal: LOCAL, createSession: factory,
    });
    expect(log.targets).toHaveLength(0);
    expect(r.notes[0]).toMatch(/does not match the pinned fingerprint/);
  });

  it('never sends credentials over plain HTTP to another computer', async () => {
    const { factory, log } = fakeFactory();
    const r = await identifyOverNetwork([row({ host: '192.0.2.10', port: 80, https: false })], {
      credentials: { '192.0.2.10:80': CRED }, isLocal: LOCAL, createSession: factory,
    });
    expect(log.targets).toHaveLength(0);
    expect(r.outcomes[0]).toMatchObject({ status: 'skipped' });
    expect(r.notes[0]).toBe('Not logged in to 192.0.2.10:80: credentials are never sent over plain HTTP to another computer.');
  });

  it('skips an address in tlsFailures and one whose pinned fingerprint differs; logs in when it matches', async () => {
    const { factory, log } = fakeFactory();
    const rows = [
      row({ host: '192.0.2.10', port: 443, tlsFingerprint: FP }),
      row({ host: '192.0.2.11', port: 443, tlsFingerprint: FP }),
      row({ host: '192.0.2.12', port: 443 }),
      row({ host: '192.0.2.13', port: 443, tlsFingerprint: FP }),
    ];
    const r = await identifyOverNetwork(rows, {
      credentials: { '192.0.2.10': CRED, '192.0.2.11': CRED, '192.0.2.12': CRED, '192.0.2.13': CRED },
      pinnedFingerprints: { '192.0.2.10:443': normaliseFingerprint(FP), '192.0.2.11:443': '00'.repeat(32), '192.0.2.12:443': FP },
      tlsFailures: [{ host: '192.0.2.13', port: 443 }],
      isLocal: LOCAL, createSession: factory,
    });
    expect(log.targets.map(t => t.host)).toEqual(['192.0.2.10']);
    expect(r.outcomes.map(o => o.status)).toEqual(['identified', 'skipped', 'skipped', 'skipped']);
    expect(r.notes[0]).toMatch(/does not match the pinned fingerprint/);
    expect(r.notes[1]).toMatch(/does not match the pinned fingerprint/);
    expect(r.notes[2]).toMatch(/certificate failed verification/);
  });

  it('one login at a time by default; identifyConcurrency allows more', async () => {
    const rows = [5466, 9403, 9805, 80].map(port => row({ host: '127.0.0.1', port }));
    const one = fakeFactory(undefined, 20);
    await identifyOverNetwork(rows, { credentials: { localhost: CRED }, isLocal: LOCAL, createSession: one.factory });
    expect(one.log.targets).toHaveLength(4);
    expect(one.log.maxInFlight).toBe(1);
    const two = fakeFactory(undefined, 20);
    await identifyOverNetwork(rows, { credentials: { localhost: CRED }, isLocal: LOCAL, createSession: two.factory, concurrency: 2 });
    expect(two.log.maxInFlight).toBe(2);
  });

  it('logs out when connect() throws after authentication; a refused login sends no logout', async () => {
    const { factory, log } = fakeFactory(t => (t.port === 5466 ? 'throw-after-auth' : t.port === 9403 ? 'refused' : 'read-fails'));
    const r = await identifyOverNetwork([5466, 9403, 9805].map(port => row({ host: '127.0.0.1', port })), {
      credentials: { localhost: CRED }, isLocal: LOCAL, createSession: factory,
    });
    expect(log.logouts).toEqual(['127.0.0.1:5466', '127.0.0.1:9805']);
    expect(r.outcomes.map(o => o.status)).toEqual(['failed', 'failed', 'failed']);
    expect(r.notes[0]).toMatch(/^Login to 127\.0\.0\.1:5466 failed: PARSE_ERROR/);
    // The password never appears in a note, even when an error message carries it.
    expect(r.notes.join('\n')).not.toContain(CRED.password);
    expect(r.notes[1]).toContain('***');
  });

  it('a cancel stops new logins; the login in flight finishes and logs out', async () => {
    const ac = new AbortController();
    const { factory, log } = fakeFactory(undefined, 30);
    const rows = [5466, 9403, 9805].map(port => row({ host: '127.0.0.1', port }));
    const run = identifyOverNetwork(rows, {
      credentials: { localhost: CRED }, isLocal: LOCAL, createSession: factory, signal: ac.signal,
      onLogin: () => ac.abort(),
    });
    const r = await run;
    expect(log.targets).toHaveLength(1);
    expect(log.logouts).toEqual(['127.0.0.1:5466']);
    expect(r.outcomes.map(o => o.status)).toEqual(['identified', 'skipped', 'skipped']);
    expect(r.notes[0]).toMatch(/cancelled/);
  });
});

// ---------------------------------------------------------------------------
// Real protocol clients against mock controllers on 127.0.0.1
// ---------------------------------------------------------------------------

interface Wire { method: string; url: string; auth?: string }

async function mockController(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number; wire: Wire[] }> {
  const wire: Wire[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      wire.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      handler(req, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

describe('identify: loginAndRead with the real clients', () => {
  it('RWS 1.0: connect() fails to parse the state after Digest succeeded, and /logout is still sent', async () => {
    const m = await mockController((req, res) => {
      if (!req.headers.authorization && !req.headers.cookie) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="validusers@robapi.abb", nonce="n0", qop="auth"' });
        res.end(); return;
      }
      if (req.url === '/logout') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Set-Cookie': '-http-session-=s1; Path=/', 'Content-Type': 'application/xhtml+xml' });
      res.end('<html><body>not a controller state</body></html>');
    });
    servers.push(m.server);
    await expect(loginAndRead({ host: '127.0.0.1', port: m.port, https: false, generation: 'rws1', username: 'tester', password: 'pw' }))
      .rejects.toBeInstanceOf(RwsError);
    expect(m.wire.map(w => w.url)).toContain('/logout');
    expect(m.wire[m.wire.length - 1].url).toBe('/logout');
  });

  it('RWS 2.0: reads name, id, version and robot type, then logs out', async () => {
    const m = await mockController((req, res) => {
      if (req.url === '/logout') { res.writeHead(204); res.end(); return; }
      if (!req.headers.cookie && !req.headers.authorization) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="validusers@robapi.abb"' }); res.end(); return; }
      const cookie = { 'Set-Cookie': '-http-session-=s2; Path=/', 'Content-Type': 'application/hal+json;v=2.0' };
      if (req.url === '/rw/system') {
        res.writeHead(200, cookie);
        res.end('{"_links":{"base":{"href":"http://x/"}},"state":[{"_type":"sys-system","_title":"system","name":"SYS_A","rwversion":"7.21.4+417","sysid":"{11111111-2222-3333-4444-555555555555}","starttm":""}]}');
        return;
      }
      if (req.url === '/rw/system/robottype') {
        res.writeHead(200, cookie);
        res.end('{"_links":{"base":{"href":"http://x/"}},"state":[{"_type":"sys-robottype","_title":"robottype","robot-type":"IRB 1600-6/1.2"}]}');
        return;
      }
      res.writeHead(404); res.end();
    });
    servers.push(m.server);
    const read = await loginAndRead(
      { host: '127.0.0.1', port: m.port, https: false, generation: 'rws2', username: 'tester', password: 'pw' },
      { readRobotType: true },
    );
    expect(read).toEqual({ systemName: 'SYS_A', systemId: '{11111111-2222-3333-4444-555555555555}', rwVersion: '7.21.4+417', robotType: 'IRB 1600-6/1.2' });
    expect(m.wire[m.wire.length - 1].url).toBe('/logout');
    // The user given is the user sent; no default account is tried.
    const basic = m.wire.map(w => w.auth).find(a => a?.startsWith('Basic '));
    expect(Buffer.from(basic!.slice(6), 'base64').toString()).toBe('tester:pw');
  });

  it('RWS 2.0: a refused login sends no /logout', async () => {
    const m = await mockController((_req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="validusers@robapi.abb"' }); res.end(); });
    servers.push(m.server);
    await expect(loginAndRead({ host: '127.0.0.1', port: m.port, https: false, generation: 'rws2', username: 'tester', password: 'wrong' }))
      .rejects.toBeInstanceOf(RwsError);
    expect(m.wire.map(w => w.url)).not.toContain('/logout');
  });
});
