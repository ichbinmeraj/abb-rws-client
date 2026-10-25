import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { TEST_TLS_KEY, TEST_TLS_CERT } from './TlsFixture.js';

// The legacy RobotManager discovery wrappers on top of the discovery modules. The OS
// listening-port scan is replaced (it would list this PC's real listeners), every TCP connect
// is recorded, and only loopback test servers are reached: a connect to any other address is
// redirected to a closed loopback port.

const rec = vi.hoisted(() => ({
  connects: [] as Array<{ host?: string; port?: number }>,
  scan: null as null | { rows: Array<{ port: number; bind: string; pid?: number; source: string }>; status: string },
}));

vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>();
  const connect = ((...args: unknown[]) => {
    const o = args[0] as { host?: string; port?: number };
    rec.connects.push({ host: o.host, port: o.port });
    const loopback = o.host === '127.0.0.1' || o.host === '::1' || o.host === 'localhost';
    return loopback
      ? (actual.connect as (...a: unknown[]) => net.Socket)(...args)
      : actual.connect({ host: '127.0.0.1', port: 9, family: 4 });
  }) as typeof actual.connect;
  return { ...actual, connect, default: { ...actual, connect } };
});
vi.mock('../src/discovery/listeningPorts.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/discovery/listeningPorts.js')>();
  return {
    ...actual,
    localListeners: vi.fn(async () => {
      const s = rec.scan ?? { rows: [], status: 'ok' };
      return {
        ports: s.status === 'ok' ? s.rows : [],
        report: { status: s.status, source: 'netstat -ano', attempts: [{ source: 'netstat -ano', status: s.status }], vcFilter: 'off', sweep: false },
      };
    }),
  };
});
vi.mock('../src/discovery/scheduler.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/discovery/scheduler.js')>();
  return { ...actual, sweepOpenPorts: vi.fn(actual.sweepOpenPorts) };
});
vi.mock('../src/discovery/identify.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/discovery/identify.js')>();
  return { ...actual, loginAndRead: vi.fn(actual.loginAndRead) };
});
vi.mock('../src/discovery/findControllers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/discovery/findControllers.js')>();
  return { ...actual, findControllers: vi.fn(actual.findControllers) };
});

import { RobotManager } from '../src/RobotManager.js';
import { Logger } from '../src/Logger.js';
import * as schedulerModule from '../src/discovery/scheduler.js';
import * as identifyModule from '../src/discovery/identify.js';
import * as findModule from '../src/discovery/findControllers.js';

const REALM = 'validusers@robapi.abb';
const servers: net.Server[] = [];
const serverSockets = new Set<net.Socket>();
async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on('connection', (s: net.Socket) => { serverSockets.add(s); s.once('close', () => serverSockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}
const userAgents: string[] = [];
async function challengeServer(secure: boolean, challenge: string): Promise<number> {
  const handler: http.RequestListener = (req, res) => {
    userAgents.push(String(req.headers['user-agent']));
    res.setHeader('WWW-Authenticate', challenge);
    res.writeHead(401);
    res.end();
  };
  return listen(secure ? https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler) : http.createServer(handler));
}

let RWS2_PORT = 0;
let RWS1_PORT = 0;
let FREE_PORT = 0;
beforeAll(async () => {
  RWS2_PORT = await challengeServer(true, `Basic realm="${REALM}"`);
  RWS1_PORT = await challengeServer(false, `Digest realm="${REALM}", qop="auth", nonce="n", opaque="o"`);
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  FREE_PORT = (s.address() as AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
});
afterAll(async () => {
  for (const s of serverSockets) { s.destroy(); }
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
});
beforeEach(() => { rec.connects.length = 0; rec.scan = null; userAgents.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

const row = (port: number, bind = '0.0.0.0'): { port: number; bind: string; source: string } => ({ port, bind, source: 'netstat -ano' });

describe('RobotManager.discoverLocalControllers', () => {
  it('probes every listening port on 127.0.0.1 for localhost, returns localhost unchanged, in port order', async () => {
    rec.scan = { status: 'ok', rows: [row(RWS2_PORT), row(RWS1_PORT), row(FREE_PORT, '::1'), row(502)] };
    const found = await RobotManager.discoverLocalControllers('localhost');
    const expected = [
      { host: 'localhost', port: RWS2_PORT, useHttps: true, authType: 'basic' },
      { host: 'localhost', port: RWS1_PORT, useHttps: false, authType: 'digest' },
    ].sort((a, b) => a.port - b.port);
    expect(found).toEqual(expected);
    expect(rec.connects.every(c => c.host === '127.0.0.1')).toBe(true);
    // A ::1-only bind is left out; so is a port of an industrial protocol.
    expect(rec.connects.some(c => c.port === FREE_PORT || c.port === 502)).toBe(false);
    // Both schemes on every port, as before.
    expect(rec.connects.filter(c => c.port === RWS2_PORT)).toHaveLength(2);
  });

  it('falls back to the blind scan only when the OS could not be asked, and only on loopback', async () => {
    const wide = vi.spyOn(RobotManager, 'wideHostScan').mockResolvedValue([]);
    rec.scan = { status: 'ok', rows: [] };
    expect(await RobotManager.discoverLocalControllers('127.0.0.1')).toEqual([]);
    expect(wide).not.toHaveBeenCalled();

    rec.scan = { status: 'failed', rows: [] };
    await RobotManager.discoverLocalControllers('127.0.0.1', true);
    expect(wide).toHaveBeenCalledWith('127.0.0.1', true);

    wide.mockClear();
    rec.scan = { status: 'missing', rows: [] };
    expect(await RobotManager.discoverLocalControllers('192.0.2.10')).toEqual([]);
    expect(wide).not.toHaveBeenCalled();
    expect(rec.connects).toEqual([]);
  });

  it('never rejects', async () => {
    rec.scan = { status: 'ok', rows: [row(FREE_PORT)] };
    await expect(RobotManager.discoverLocalControllers('127.0.0.1', 'yes' as unknown as boolean)).resolves.toEqual([]);
  });
});

describe('RobotManager.discoverControllers', () => {
  it('drops a malformed extra host with a warning instead of rejecting', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => { /* quiet */ });
    vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([]);
    const probed: string[] = [];
    vi.spyOn(RobotManager as never, 'probePort').mockImplementation((async (host: string) => { probed.push(host); return null; }) as never);
    await expect(RobotManager.discoverControllers(['bad host', '10.0.0.5:8080', '::1'])).resolves.toEqual([]);
    expect([...new Set(probed)]).toEqual(['192.168.125.1']);
    const dropped = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('dropped'));
    expect(dropped).toHaveLength(3);
    expect(dropped[0]).toContain('"bad host"');
  });

  it('returns the local entries first, then the others by numeric address and port, once each', async () => {
    vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([
      { host: '127.0.0.1', port: 5466, useHttps: true, authType: 'basic' },
      { host: '127.0.0.1', port: 9403, useHttps: true, authType: 'basic' },
    ]);
    vi.spyOn(RobotManager as never, 'probePort').mockImplementation((async (host: string, port: number, useHttps: boolean) => {
      const hit = (host === '192.0.2.20' && port === 443 && useHttps) || (host === '192.0.2.3' && port === 80 && !useHttps)
        || (host === '192.168.125.1' && port === 443 && useHttps);
      return hit ? { port, useHttps, authType: useHttps ? 'basic' : 'digest' } : null;
    }) as never);
    const found = await RobotManager.discoverControllers(['192.0.2.20', '192.0.2.3', '192.0.2.3']);
    expect(found.map(c => `${c.host}:${c.port}`)).toEqual([
      '127.0.0.1:5466', '127.0.0.1:9403', '192.0.2.3:80', '192.0.2.20:443', '192.168.125.1:443',
    ]);
  });
});

describe('RobotManager.wideHostScan', () => {
  it('refuses another machine with INVALID_ARGUMENT and sweeps nothing', async () => {
    await expect(RobotManager.wideHostScan('192.0.2.10')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(schedulerModule.sweepOpenPorts).not.toHaveBeenCalled();
    expect(rec.connects).toEqual([]);
  });

  it('on loopback: probes the ports the sweep found open and returns the host as given', async () => {
    vi.mocked(schedulerModule.sweepOpenPorts).mockResolvedValueOnce({ open: [RWS2_PORT, FREE_PORT], complete: true });
    const found = await RobotManager.wideHostScan('localhost');
    expect(schedulerModule.sweepOpenPorts).toHaveBeenCalledWith('localhost');
    expect(found).toEqual([{ host: 'localhost', port: RWS2_PORT, useHttps: true, authType: 'basic' }]);
  });
});

describe('RobotManager probes', () => {
  it('probeSpecificPort keeps the legacy result and sends the discovery User-Agent', async () => {
    const r = await RobotManager.probeSpecificPort('127.0.0.1', RWS1_PORT);
    expect(r).toEqual({ port: RWS1_PORT, useHttps: false, authType: 'digest' });
    expect(userAgents[0]).toMatch(/^abb-rws-client(\/\S+)? discovery$/);
  });

  it('findControllers delegates to the standalone function', async () => {
    const opts = { local: false } as const;
    const r = await RobotManager.findControllers(opts);
    expect(findModule.findControllers).toHaveBeenCalledWith(opts);
    expect(r.controllers).toEqual([]);
  });
});

describe('RobotManager recovery login (identifyCandidate)', () => {
  it('logs in through the discovery login helper with the saved credentials and the candidate protocol', async () => {
    const login = vi.mocked(identifyModule.loginAndRead).mockResolvedValueOnce({ systemId: '{ABC}' });
    const mgr = new RobotManager({ strictTls: true });
    const id = await (mgr as unknown as { identifyCandidate(h: string, c: object, u: string, p: string): Promise<string | null> })
      .identifyCandidate('127.0.0.1', { port: 39127, useHttps: false, authType: 'digest' }, 'user', 'pw');
    expect(id).toBe('{ABC}');
    expect(login).toHaveBeenCalledWith({
      host: '127.0.0.1', port: 39127, https: false, generation: 'rws1', username: 'user', password: 'pw', strictTls: true,
    });

    login.mockResolvedValueOnce({});
    const none = await (mgr as unknown as { identifyCandidate(h: string, c: object, u: string, p: string): Promise<string | null> })
      .identifyCandidate('127.0.0.1', { port: 9403, useHttps: true, authType: 'basic' }, 'user', 'pw');
    expect(none).toBeNull();
    expect(login.mock.calls[1][0]).toMatchObject({ generation: 'rws2', https: true });
  });
});
