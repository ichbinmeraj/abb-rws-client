import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { TEST_TLS_KEY, TEST_TLS_CERT } from '../TlsFixture.js';

// Network properties of findControllers, checked on the real probe path with recorders on every
// way out of this process: TCP connects (node:net), multicast sockets (dgram), name lookups
// (dns) and child processes (child_process). Only loopback test servers are ever reached:
// a connect to any other address is recorded and redirected to a closed loopback port, a dgram
// socket or a lookup is recorded and refused, and a child process is recorded and never started.

const rec = vi.hoisted(() => ({
  connects: [] as Array<{ host?: string; port?: number }>,
  sockets: [] as Array<{ destroyed: boolean; closed?: boolean }>,
  dgram: 0,
  lookups: [] as string[],
  execs: [] as string[],
}));

vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>();
  const connect = ((...args: unknown[]) => {
    const o = args[0] as { host?: string; port?: number; family?: number };
    rec.connects.push({ host: o.host, port: o.port });
    const loopback = o.host === '127.0.0.1' || o.host === '::1';
    const s = loopback
      ? (actual.connect as (...a: unknown[]) => net.Socket)(...args)
      : actual.connect({ host: '127.0.0.1', port: 9, family: 4 });   // never off this PC
    rec.sockets.push(s);
    return s;
  }) as typeof actual.connect;
  return { ...actual, connect, default: { ...actual, connect } };
});
vi.mock('dgram', async importOriginal => {
  const actual = await importOriginal<typeof import('dgram')>();
  const createSocket = ((): never => { rec.dgram++; throw new Error('no multicast in this test'); }) as typeof actual.createSocket;
  return { ...actual, createSocket, default: { ...actual, createSocket } };
});
vi.mock('dns', async importOriginal => {
  const actual = await importOriginal<typeof import('dns')>();
  const lookup = ((name: string, ...rest: unknown[]) => {
    rec.lookups.push(name);
    const cb = rest.find(x => typeof x === 'function') as ((e: Error) => void) | undefined;
    setImmediate(() => cb?.(Object.assign(new Error('no lookups in this test'), { code: 'ENOTFOUND' })));
  }) as unknown as typeof actual.lookup;
  return { ...actual, lookup, default: { ...actual, lookup } };
});
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = ((file: string, ...rest: unknown[]) => {
    rec.execs.push(file);
    const cb = rest.find(x => typeof x === 'function') as ((e: Error) => void) | undefined;
    setImmediate(() => cb?.(Object.assign(new Error('no processes in this test'), { code: 'ENOENT' })));
    return {};
  }) as unknown as typeof actual.execFile;
  return { ...actual, execFile, default: { ...actual, execFile } };
});

import { findControllers, runDiscovery } from '../../src/discovery/findControllers.js';
import type { ListeningPort, LocalListeners } from '../../src/discovery/types.js';

const REALM = 'validusers@robapi.abb';
interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders }

const servers: net.Server[] = [];
const serverSockets = new Set<net.Socket>();
async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on('connection', (s: net.Socket) => { serverSockets.add(s); s.once('close', () => serverSockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}
async function challengeServer(secure: boolean, challenge: string): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const handler: http.RequestListener = (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('WWW-Authenticate', challenge);
    res.writeHead(401);
    res.end();
  };
  const server = secure ? https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler) : http.createServer(handler);
  return { port: await listen(server), seen };
}

let rws2: { port: number; seen: Seen[] };
let rws1: { port: number; seen: Seen[] };
let foreign: { port: number; seen: Seen[] };
let freePort = 0;

beforeAll(async () => {
  rws2 = await challengeServer(true, `Basic realm="${REALM}"`);
  rws1 = await challengeServer(false, `Digest realm="${REALM}", qop="auth", nonce="n1", opaque="o1"`);
  foreign = await challengeServer(false, 'Basic realm="router"');
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  freePort = (s.address() as AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
});
afterAll(async () => {
  for (const s of serverSockets) { s.destroy(); }
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
});
beforeEach(() => {
  rec.connects.length = 0; rec.sockets.length = 0; rec.dgram = 0; rec.lookups.length = 0; rec.execs.length = 0;
  for (const s of [rws2, rws1, foreign]) { s.seen.length = 0; }
});
afterEach(() => { vi.restoreAllMocks(); });

const row = (port: number, bind: string, pid: number): ListeningPort => ({ port, bind, pid, source: 'netstat -ano' });
const listening = (rows: ListeningPort[]): LocalListeners => ({
  ports: rows,
  report: { status: 'ok', source: 'netstat -ano', attempts: [{ source: 'netstat -ano', status: 'ok' }], vcFilter: 'off', sweep: false },
});

describe('the recorders see every way out (so the zero counts below mean something)', () => {
  it('a host name is looked up, mDNS opens a dgram socket, the scan starts netstat; all blocked here', async () => {
    const r = await findControllers({ mdns: true, manual: [{ host: 'robot.example', port: 443 }], identify: 'none' });
    expect(rec.lookups).toEqual(['robot.example']);
    expect(rec.dgram).toBe(1);
    expect(rec.execs.some(f => /netstat\.exe$/i.test(f))).toBe(process.platform === 'win32');
    expect(rec.connects.filter(c => c.host !== '127.0.0.1' && c.host !== '::1')).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/robot\.example: name lookup failed/);
  });
});

describe('findControllers: what leaves this PC', () => {
  it('with the defaults: connects to 127.0.0.1 (and ::1 only after a refusal), no multicast, no lookup', async () => {
    // The listening-port scan is replaced (it would list this PC's real listeners); probes are real.
    const r = await runDiscovery(undefined, {
      platform: 'win32',
      localListeners: async () => listening([row(rws2.port, '0.0.0.0', 2101), row(rws1.port, '0.0.0.0', 2102), row(freePort, '::', 2103)]),
      pidImages: async () => ({ status: 'ok', images: new Map([[2101, 'Vrchost64.exe'], [2102, 'RobVC.exe'], [2103, 'Vrchost64.exe']]) }),
      vcProcessDetails: async () => ({ details: new Map(), notes: [] }),
    });
    expect(rec.connects.length).toBeGreaterThan(0);
    for (const c of rec.connects) { expect(['127.0.0.1', '::1']).toContain(c.host); }
    expect(rec.connects.filter(c => c.host === '::1').map(c => c.port)).toEqual(expect.arrayContaining([freePort]));
    expect(rec.connects.filter(c => c.host === '::1').every(c => c.port === freePort)).toBe(true);
    expect(rec.dgram).toBe(0);
    expect(rec.lookups).toEqual([]);
    expect(rec.execs).toEqual([]);
    expect(r.controllers.map(c => [c.key, c.generation, c.https])).toEqual(expect.arrayContaining([
      [`local:${rws2.port}`, 'rws2', true],
      [`local:${rws1.port}`, 'rws1', false],
    ]));
  });

  it('serviceAddress false, mdns false and loopback manual targets: zero sockets off this PC', async () => {
    const r = await findControllers({
      local: false, serviceAddress: false, mdns: false, timeoutMs: 2000,
      manual: [{ host: '127.0.0.1', port: rws2.port }, { host: 'localhost', port: rws1.port }],
    });
    expect(rec.connects.length).toBeGreaterThan(0);
    for (const c of rec.connects) { expect(c.host).toBe('127.0.0.1'); }
    expect(rec.dgram + rec.lookups.length + rec.execs.length).toBe(0);
    expect(r.controllers).toHaveLength(2);
    expect(r.controllers.find(c => c.port === rws1.port)?.name).toBe('localhost');
  });

  it('every cap and rule rejects before any socket, process, lookup or multicast', async () => {
    const bad: unknown[] = [
      { manual: Array.from({ length: 17 }, () => ({ host: '127.0.0.1' })) },
      { ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { ranges: Array.from({ length: 17 }, (_, i) => `10.0.${i}.0/30`) },
      { ranges: ['10.0.0.0/23'] },
      { ranges: ['10.0.0.0/24'], maxRangeHosts: 100 },
      { ranges: ['224.0.0.0/30'] },
      { ranges: ['198.51.100.0/30'] },
      { manual: [{ host: '::1' }] },
      { manual: [{ host: '127.0.0.1', port: 70000 }] },
      { timeoutMs: 50 },
      { pacing: { local: { concurrency: 101 } } },
      { pacing: { remote: { concurrency: 17 } } },
      { maxRangeHosts: 5000 },
      { credentials: { x: { username: 'u', password: 'p' } } },
      { identify: 'with-credentials', credentials: { x: { username: '', password: 'p' } } },
      { loopbackOnly: true, manual: [{ host: 'robot.example' }] },
      { loopbackOnly: true, serviceAddress: 'auto' },
      { loopbackOnly: true, mdns: true },
      { pinnedFingerprints: { x: 'not-hex' } },
    ];
    for (const options of bad) {
      await expect(findControllers(options as never), JSON.stringify(options)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(rec.connects).toEqual([]);
    expect(rec.execs).toEqual([]);
    expect(rec.lookups).toEqual([]);
    expect(rec.dgram).toBe(0);
  });
});

describe('findControllers: identify never logs in without credentials mode', () => {
  for (const identify of ['none', 'anonymous'] as const) {
    it(`'${identify}': each probe is one unauthenticated GET /rw/system with the discovery User-Agent`, async () => {
      const r = await findControllers({ local: false, identify, manual: [{ host: '127.0.0.1', port: rws2.port, https: true }, { host: '127.0.0.1', port: rws1.port, https: false }] });
      expect(r.controllers).toHaveLength(2);
      const seen = [...rws2.seen, ...rws1.seen];
      expect(seen).toHaveLength(2);
      for (const s of seen) {
        expect(s.method).toBe('GET');
        expect(s.url).toBe('/rw/system');
        expect(s.headers.authorization).toBeUndefined();
        expect(s.headers['user-agent']).toMatch(/^abb-rws-client(\/\S+)? discovery$/);
      }
      expect(rec.execs).toEqual([]);   // local: false, so no process at all
    });
  }

  it("'with-credentials' never logs in to a 401 from another realm, even with a matching entry", async () => {
    const r = await findControllers({
      local: false, identify: 'with-credentials',
      manual: [{ host: '127.0.0.1', port: foreign.port, https: false }],
      credentials: { [`127.0.0.1:${foreign.port}`]: { username: 'u', password: 'secret-pass' } },
    });
    expect(foreign.seen).toHaveLength(1);
    expect(foreign.seen[0].headers.authorization).toBeUndefined();
    expect(r.controllers).toEqual([expect.objectContaining({ identified: false, realm: 'router', generation: null })]);
    expect(r.notes.join(' ')).toMatch(/did not identify as an ABB controller/);
    expect(r.notes.join(' ')).not.toContain('secret-pass');
  });
});

describe('findControllers: cancel', () => {
  it('resolves with aborted: true only after every socket it opened has closed', async () => {
    const closedOnServer: Array<Promise<void>> = [];
    const silent = net.createServer(sock => {
      closedOnServer.push(new Promise<void>(r => sock.once('close', () => r())));
      sock.on('error', () => { /* client destroyed it */ });
      sock.resume();
    });
    const port = await listen(silent);
    const ac = new AbortController();
    const started = Date.now();
    const done = findControllers({ local: false, timeoutMs: 20000, manual: [{ host: '127.0.0.1', port }], signal: ac.signal });
    await new Promise(r => setTimeout(r, 150));
    expect(rec.sockets.length).toBe(2);       // HTTPS and HTTP at once on an unlisted loopback port
    ac.abort();
    const r = await done;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.aborted).toBe(true);
    expect(r.controllers).toEqual([]);
    for (const s of rec.sockets) { expect(s.destroyed).toBe(true); }
    for (const s of rec.sockets) { expect(s.closed).toBe(true); }
    await Promise.race([Promise.all(closedOnServer), new Promise((_, no) => setTimeout(() => no(new Error('server side still open')), 2000))]);
  });
});
