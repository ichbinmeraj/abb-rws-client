import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MdnsController } from '../../src/MdnsDiscovery.js';
import { Logger } from '../../src/Logger.js';
import { runDiscovery, SERVICE_ADDRESS, type DiscoveryDeps } from '../../src/discovery/findControllers.js';
import type {
  DiscoveryProgress, ListeningPort, LocalListeners, LocalScanStatus, ProbeOutcome, VcProcessDetails,
} from '../../src/discovery/types.js';

// Every outside effect goes through injected fakes here: no socket, process, file or DNS lookup.
// Addresses are RFC 5737 documentation addresses; 192.0.2.10 plays this PC's LAN address.

const LAN = '192.0.2.10';
const REALM = 'validusers@robapi.abb';
const RWS2: ProbeOutcome = { kind: 'rws', authType: 'basic', realm: REALM, tlsFingerprint: 'AA:BB', challenge: `Basic realm="${REALM}"` };
const RWS1: ProbeOutcome = { kind: 'rws', authType: 'digest', realm: REALM, challenge: `Digest realm="${REALM}", nonce="n"` };

const row = (port: number, bind = '0.0.0.0', pid?: number): ListeningPort =>
  ({ port, bind, source: 'netstat -ano', ...(pid !== undefined ? { pid } : {}) });

function listening(rows: ListeningPort[], status: LocalScanStatus = 'ok'): LocalListeners {
  return {
    ports: status === 'ok' ? rows : [],
    report: { status, source: 'netstat -ano', attempts: [{ source: 'netstat -ano', status }], vcFilter: 'off', sweep: false },
  };
}

/** Fake I/O. `answers` maps 'host:port/https|http' to an outcome; anything else is refused. */
function fakes(answers: Record<string, ProbeOutcome> = {}, over: Partial<DiscoveryDeps> = {}) {
  const probed: string[] = [];
  const d = {
    platform: 'win32' as NodeJS.Platform,
    probe: vi.fn<Parameters<DiscoveryDeps['probe']>, ReturnType<DiscoveryDeps['probe']>>(async (host, port, https) => {
      const k = `${host}:${port}/${https ? 'https' : 'http'}`;
      probed.push(k);
      return answers[k] ?? { kind: 'refused' };
    }),
    localListeners: vi.fn<Parameters<DiscoveryDeps['localListeners']>, ReturnType<DiscoveryDeps['localListeners']>>(async () => listening([])),
    pidImages: vi.fn<Parameters<DiscoveryDeps['pidImages']>, ReturnType<DiscoveryDeps['pidImages']>>(async () => ({ status: 'ok' as const, images: new Map() })),
    vcProcessDetails: vi.fn<Parameters<DiscoveryDeps['vcProcessDetails']>, ReturnType<DiscoveryDeps['vcProcessDetails']>>(async () => ({ details: new Map(), notes: [] })),
    identifyOverNetwork: vi.fn<Parameters<DiscoveryDeps['identifyOverNetwork']>, ReturnType<DiscoveryDeps['identifyOverNetwork']>>(
      async () => ({ outcomes: [], unmatchedCredentials: [], notes: [] })),
    mdns: vi.fn<Parameters<DiscoveryDeps['mdns']>, ReturnType<DiscoveryDeps['mdns']>>(async () => []),
    resolveIPv4: vi.fn<Parameters<DiscoveryDeps['resolveIPv4']>, ReturnType<DiscoveryDeps['resolveIPv4']>>(async name => ({ name, ipv4: '192.0.2.50' })),
    detectEnvironment: vi.fn(() => ({ wsl: false })),
    localAddressChecker: () => (h: string): boolean => h === 'localhost' || h === '::1' || h.startsWith('127.') || h === LAN,
    ipv4InterfaceAddresses: vi.fn(() => [LAN]),
    sweep: vi.fn<Parameters<DiscoveryDeps['sweep']>, ReturnType<DiscoveryDeps['sweep']>>(async () => ({ open: [], complete: true })),
    ...over,
  };
  return { d, probed };
}

afterEach(() => { vi.restoreAllMocks(); });

// Two VCs on this PC: an OmniCore VC (Vrchost64.exe) on 5466, an IRC5 VC (RobVC.exe) on 39127.
const VC_ROWS = [row(5466, '0.0.0.0', 2101), row(5466, '::', 2101), row(39127, '0.0.0.0', 2102), row(135, '0.0.0.0', 1001)];
const VC_IMAGES = new Map<number, string>([[2101, 'Vrchost64.exe'], [2102, 'RobVC.exe'], [1001, 'svchost.exe']]);
const VC_ANSWERS: Record<string, ProbeOutcome> = {
  '127.0.0.1:5466/https': RWS2,
  '127.0.0.1:39127/https': { kind: 'tls-failed' },
  '127.0.0.1:39127/http': RWS1,
};
const MDNS_5466: MdnsController = {
  instanceName: 'RobotWebServices_FromMdns', systemName: 'FromMdns', host: LAN, port: 5466,
  rwVersion: '7.21.4', sysGuid: '{11111111-2222-3333-4444-555555555555}', probableProtocol: 'rws2',
};
const FOLDER_2101: VcProcessDetails = { pid: 2101, image: 'Vrchost64.exe', systemName: 'FromFolder', rwVersion: '8.2.1+1023' };

function vcFakes(over: Partial<DiscoveryDeps> = {}) {
  return fakes(VC_ANSWERS, {
    localListeners: vi.fn(async () => listening(VC_ROWS)),
    pidImages: vi.fn(async () => ({ status: 'ok' as const, images: VC_IMAGES })),
    vcProcessDetails: vi.fn(async () => ({ details: new Map([[2101, FOLDER_2101]]), notes: [] })),
    mdns: vi.fn(async () => [MDNS_5466]),
    identifyOverNetwork: vi.fn(async rows => ({
      outcomes: rows.filter(r => r.identified).map(r => ({
        key: r.key, status: 'identified' as const, generation: r.generation ?? undefined,
        systemName: `Login${r.port}`, rwVersion: 'from-login', robotType: 'IRB 1600',
      })),
      unmatchedCredentials: [], notes: [],
    })),
    ...over,
  });
}

describe('identify and mdns truth table (one test per row)', () => {
  it("'none', mdns false: no mDNS packet, no folder read, no login", async () => {
    const { d } = vcFakes();
    const r = await runDiscovery({ identify: 'none', mdns: false }, d);
    expect(d.mdns).not.toHaveBeenCalled();
    expect(d.vcProcessDetails).not.toHaveBeenCalled();
    expect(d.identifyOverNetwork).not.toHaveBeenCalled();
    expect(r.controllers.map(c => c.key)).toEqual(['local:5466', 'local:39127']);
    expect(r.controllers[0].systemName).toBeUndefined();
    expect(r.controllers[0]).toMatchObject({ generation: 'rws2', identified: true, process: { pid: 2101, image: 'Vrchost64.exe' }, isVirtual: true });
    expect(r.controllers[1]).toMatchObject({ generation: 'rws1', https: false, process: { pid: 2102, image: 'RobVC.exe' } });
  });

  it("'none', mdns true: one mDNS query, TXT fields attached, no folder read, no login", async () => {
    const { d } = vcFakes();
    const r = await runDiscovery({ identify: 'none', mdns: true }, d);
    expect(d.mdns).toHaveBeenCalledTimes(1);
    expect(d.vcProcessDetails).not.toHaveBeenCalled();
    expect(d.identifyOverNetwork).not.toHaveBeenCalled();
    const c = r.controllers.find(x => x.key === 'local:5466');
    expect(c).toMatchObject({ systemName: 'FromMdns', rwVersion: '7.21.4', sources: ['this-pc', 'mdns'] });
  });

  it("'anonymous', mdns false: no mDNS packet, the local folder is read, no login", async () => {
    const { d } = vcFakes();
    const r = await runDiscovery({ identify: 'anonymous', mdns: false }, d);
    expect(d.mdns).not.toHaveBeenCalled();
    expect(d.vcProcessDetails).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.vcProcessDetails).mock.calls[0][0]).toEqual(expect.arrayContaining([{ pid: 2101, image: 'Vrchost64.exe' }]));
    expect(d.identifyOverNetwork).not.toHaveBeenCalled();
    expect(r.controllers.find(x => x.key === 'local:5466')).toMatchObject({ systemName: 'FromFolder', rwVersion: '8.2.1+1023' });
  });

  it("'anonymous', mdns true: mDNS sent, folder read, no login; the folder outranks mDNS TXT", async () => {
    const { d } = vcFakes();
    const r = await runDiscovery({ identify: 'anonymous', mdns: true }, d);
    expect(d.mdns).toHaveBeenCalledTimes(1);
    expect(d.vcProcessDetails).toHaveBeenCalledTimes(1);
    expect(d.identifyOverNetwork).not.toHaveBeenCalled();
    expect(r.controllers.find(x => x.key === 'local:5466')).toMatchObject({ systemName: 'FromFolder', sources: ['this-pc', 'mdns'] });
  });

  it("'with-credentials': mDNS as the flag says, folder read, logins only through identifyOverNetwork with the caller's map", async () => {
    for (const mdns of [false, true]) {
      const { d } = vcFakes();
      const credentials = { 'local:5466': { username: 'u', password: 'p' } };
      const r = await runDiscovery({ identify: 'with-credentials', mdns, credentials, pacing: { identifyConcurrency: 2 } }, d);
      expect(d.mdns).toHaveBeenCalledTimes(mdns ? 1 : 0);
      expect(d.vcProcessDetails).toHaveBeenCalledTimes(1);
      expect(d.identifyOverNetwork).toHaveBeenCalledTimes(1);
      const [rows, opts] = vi.mocked(d.identifyOverNetwork).mock.calls[0];
      expect(rows.map(x => x.key)).toEqual(['local:5466', 'local:39127']);
      expect(opts).toMatchObject({ credentials, concurrency: 2, strictTls: false });
      expect(r.controllers.find(x => x.key === 'local:5466')).toMatchObject({ systemName: 'Login5466', robotType: 'IRB 1600', rwVersion: 'from-login' });
    }
  });
});

describe('validation and loopbackOnly: refused before anything runs', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['serviceAddress true', { loopbackOnly: true, serviceAddress: true }],
    ["serviceAddress 'auto'", { loopbackOnly: true, serviceAddress: 'auto' }],
    ['mdns', { loopbackOnly: true, mdns: true }],
    ['a LAN manual host', { loopbackOnly: true, manual: [{ host: '192.0.2.50' }] }],
    ['a manual host name', { loopbackOnly: true, manual: [{ host: 'robot.example' }] }],
    ['a range off loopback', { loopbackOnly: true, ranges: ['10.0.0.0/30'] }],
    ['credentials without with-credentials', { credentials: { 'local:5466': { username: 'u', password: 'p' } } }],
    ['too many ports', { ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
    ['a range above the cap', { ranges: ['10.0.0.0/16'] }],
    ['a remote pacing faster than the floor', { pacing: { remote: { minGapMs: 10 } } }],
  ];
  for (const [label, options] of cases) {
    it(`rejects ${label} with INVALID_ARGUMENT and starts nothing`, async () => {
      const { d } = fakes();
      await expect(runDiscovery(options as never, d)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(d.localListeners).not.toHaveBeenCalled();
      expect(d.pidImages).not.toHaveBeenCalled();
      expect(d.probe).not.toHaveBeenCalled();
      expect(d.mdns).not.toHaveBeenCalled();
      expect(d.resolveIPv4).not.toHaveBeenCalled();
    });
  }

  it('loopbackOnly with loopback targets runs and probes loopback only', async () => {
    const { d, probed } = fakes();
    await runDiscovery({ loopbackOnly: true, local: false, manual: [{ host: 'localhost', port: 9403 }], ranges: ['127.0.0.2-127.0.0.3'] }, d);
    expect(probed.length).toBeGreaterThan(0);
    expect(probed.every(p => p.startsWith('127.'))).toBe(true);
    expect(d.resolveIPv4).not.toHaveBeenCalled();
  });
});

describe('what is probed', () => {
  it('a bare call scans this PC only: no service address, no mDNS, no lookup, nothing remote', async () => {
    const { d, probed } = vcFakes();
    await runDiscovery(undefined, d);
    expect(probed.every(p => p.startsWith('127.0.0.1:'))).toBe(true);
    expect(d.mdns).not.toHaveBeenCalled();
    expect(d.resolveIPv4).not.toHaveBeenCalled();
  });

  it('PID filter on: only virtual-controller ports; one scheme for a one-scheme port, both for any other', async () => {
    const { d, probed } = vcFakes();
    const r = await runDiscovery({ identify: 'none' }, d);
    expect(r.localScan.vcFilter).toBe('on');
    expect(probed.sort()).toEqual(['127.0.0.1:39127/http', '127.0.0.1:39127/https', '127.0.0.1:5466/https']);
  });

  it('PID lookup failed: unfiltered, vcFilter failed, a note, and the deny-list still applies', async () => {
    const { d, probed } = fakes({}, {
      localListeners: vi.fn(async () => listening([row(502, '0.0.0.0', 9), row(5466, '0.0.0.0', 2101), row(8080, '0.0.0.0', 77)])),
      pidImages: vi.fn(async () => ({ status: 'timeout' as const })),
    });
    const r = await runDiscovery({ identify: 'none' }, d);
    expect(r.localScan.vcFilter).toBe('failed');
    expect(r.notes.join(' ')).toMatch(/process list timed out/);
    expect(probed.some(p => p.includes(':8080/'))).toBe(true);
    expect(probed.some(p => p.includes(':502/'))).toBe(false);
  });

  it("filter off and identify 'none' starts no process list", async () => {
    const { d } = vcFakes();
    const r = await runDiscovery({ identify: 'none', filterToVcProcesses: false }, d);
    expect(d.pidImages).not.toHaveBeenCalled();
    expect(r.localScan.vcFilter).toBe('off');
  });

  it('off Windows: no process list, no folder read', async () => {
    const { d } = vcFakes({ platform: 'linux' });
    const r = await runDiscovery({}, d);
    expect(d.pidImages).not.toHaveBeenCalled();
    expect(d.vcProcessDetails).not.toHaveBeenCalled();
    expect(r.localScan.vcFilter).toBe('off');
  });

  it('a port bound to IPv6 "any" only: 127.0.0.1 first, ::1 once after a refusal', async () => {
    const { d, probed } = fakes({ '::1:5466/https': RWS2 }, {
      localListeners: vi.fn(async () => listening([row(5466, '::', 2101)])),
      pidImages: vi.fn(async () => ({ status: 'ok' as const, images: VC_IMAGES })),
    });
    const r = await runDiscovery({ identify: 'none' }, d);
    expect(probed).toEqual(['127.0.0.1:5466/https', '::1:5466/https']);
    expect(r.controllers).toHaveLength(1);
    expect(r.controllers[0]).toMatchObject({ key: 'local:5466', host: '::1' });
  });

  it('another host: 443 and 80 over HTTPS; plain HTTP on 80 only after a TLS failure there', async () => {
    const { d, probed } = fakes({
      '192.0.2.50:80/https': { kind: 'tls-failed' },
      '192.0.2.50:80/http': RWS1,
    });
    const r = await runDiscovery({ local: false, manual: [{ host: '192.0.2.50' }] }, d);
    expect(probed.sort()).toEqual(['192.0.2.50:443/https', '192.0.2.50:80/http', '192.0.2.50:80/https']);
    expect(r.controllers).toEqual([expect.objectContaining({ key: '192.0.2.50:80', https: false, generation: 'rws1', sources: ['manual'] })]);
  });

  it('another host: a refused port or one that never accepted TCP gets no second scheme; at most 3 attempts for the base list', async () => {
    const { d, probed } = fakes({ '192.0.2.51:80/https': { kind: 'timeout' } });
    await runDiscovery({ local: false, manual: [{ host: '192.0.2.51' }] }, d);
    expect(probed.sort()).toEqual(['192.0.2.51:443/https', '192.0.2.51:80/https']);
  });

  it('another host: an open port that leaves the TLS handshake unanswered (an IRC5 on 80) is tried over plain HTTP', async () => {
    for (const source of ['manual', 'manual-port', 'range', 'service-address'] as const) {
      const host = source === 'service-address' ? SERVICE_ADDRESS : '192.0.2.54';
      const { d, probed } = fakes({
        [`${host}:80/https`]: { kind: 'tls-timeout' },
        [`${host}:80/http`]: RWS1,
      });
      const opts = source === 'manual' ? { manual: [{ host }] }
        : source === 'manual-port' ? { manual: [{ host, port: 80 }] }
          : source === 'range' ? { ranges: [`${host}-${host}`], allowPublicRanges: true }
            : { serviceAddress: true as const };
      const r = await runDiscovery({ local: false, ...opts }, d);
      expect(probed.filter(p => p.includes(':80/')).sort(), source).toEqual([`${host}:80/http`, `${host}:80/https`]);
      expect(r.controllers, source).toEqual([expect.objectContaining({ key: `${host}:80`, https: false, generation: 'rws1' })]);
    }
  });

  it('another host: a tls-timeout on a port with a fixed scheme, or with https given, gets no HTTP attempt', async () => {
    const { d, probed } = fakes({
      '192.0.2.55:443/https': { kind: 'tls-timeout' },
      '192.0.2.56:80/https': { kind: 'tls-timeout' },
    });
    await runDiscovery({ local: false, manual: [{ host: '192.0.2.55', port: 443 }, { host: '192.0.2.56', port: 80, https: true }] }, d);
    expect(probed.sort()).toEqual(['192.0.2.55:443/https', '192.0.2.56:80/https']);
  });

  it('extra ports: at most 2 attempts each on another host; a given port and scheme is the only attempt', async () => {
    const { d, probed } = fakes({ '192.0.2.52:8443/https': { kind: 'tls-failed' } });
    await runDiscovery({ local: false, manual: [{ host: '192.0.2.52' }, { host: '192.0.2.53', port: 8080, https: false }], ports: [8443] }, d);
    expect(probed.filter(p => p.startsWith('192.0.2.52:8443')).sort()).toEqual(['192.0.2.52:8443/http', '192.0.2.52:8443/https']);
    expect(probed.filter(p => p.startsWith('192.0.2.53'))).toEqual(['192.0.2.53:8080/http']);
  });

  it("the service address only when asked; 'auto' only with an interface in 192.168.125.0/24", async () => {
    const on = fakes();
    await runDiscovery({ local: false, serviceAddress: true }, on.d);
    expect(on.probed.every(p => p.startsWith(`${SERVICE_ADDRESS}:`))).toBe(true);
    expect(on.probed.length).toBe(2);

    const autoOff = fakes();
    await runDiscovery({ local: false, serviceAddress: 'auto' }, autoOff.d);
    expect(autoOff.probed).toEqual([]);

    const autoOn = fakes({}, { ipv4InterfaceAddresses: vi.fn(() => [LAN, '192.168.125.50']) });
    await runDiscovery({ local: false, serviceAddress: 'auto' }, autoOn.d);
    expect(autoOn.probed.length).toBe(2);
  });

  it("a loopback range '127.0.0.1-127.0.0.1' plans exactly like manual 127.0.0.1 without a port, as source 'range'", async () => {
    const asRange = fakes({ '127.0.0.1:9403/https': RWS2 });
    const r1 = await runDiscovery({ local: false, ranges: ['127.0.0.1-127.0.0.1'] }, asRange.d);
    const asManual = fakes({ '127.0.0.1:9403/https': RWS2 });
    const r2 = await runDiscovery({ local: false, manual: [{ host: '127.0.0.1' }] }, asManual.d);
    expect(asRange.probed.sort()).toEqual(asManual.probed.sort());
    expect(asRange.probed).toEqual(expect.arrayContaining(['127.0.0.1:80/https', '127.0.0.1:80/http', '127.0.0.1:9805/https', '127.0.0.1:28447/http']));
    expect(r1.controllers[0].sources).toEqual(['range']);
    expect(r2.controllers[0].sources).toEqual(['manual']);
  });

  it('the same connection asked for twice is made once and keeps both sources', async () => {
    const { d, probed } = vcFakes();
    const r = await runDiscovery({ identify: 'none', manual: [{ host: '127.0.0.1', port: 5466 }] }, d);
    expect(probed.filter(p => p === '127.0.0.1:5466/https')).toHaveLength(1);
    expect(r.controllers.find(c => c.key === 'local:5466')?.sources).toEqual(['this-pc', 'manual']);
  });

  it('a manual host name is looked up once, IPv4; the typed name is kept; a name without IPv4 gets a note', async () => {
    const { d } = fakes({ '192.0.2.50:443/https': RWS2 }, {
      resolveIPv4: vi.fn(async (name: string) => (name === 'robot.example'
        ? { name, ipv4: '192.0.2.50' } : { name, note: `${name}: only an IPv6 address; RobotWare does not support IPv6` })),
    });
    const r = await runDiscovery({ local: false, manual: [{ host: 'robot.example' }, { host: 'robot.example', port: 443 }, { host: 'v6only.example' }] }, d);
    expect(d.resolveIPv4).toHaveBeenCalledTimes(2);
    expect(r.controllers).toEqual([expect.objectContaining({ key: '192.0.2.50:443', name: 'robot.example' })]);
    expect(r.notes).toContain('v6only.example: only an IPv6 address; RobotWare does not support IPv6');
  });

  it('an unverified certificate under strictTls is listed in tlsFailures, not dropped silently', async () => {
    const { d } = fakes({ '192.0.2.50:443/https': { kind: 'tls-unverified', fingerprint: 'AB:CD', error: 'self-signed certificate' } });
    const r = await runDiscovery({ local: false, strictTls: true, manual: [{ host: '192.0.2.50', port: 443 }] }, d);
    expect(r.tlsFailures).toEqual([{ host: '192.0.2.50', port: 443, fingerprint: 'AB:CD', error: 'self-signed certificate' }]);
    expect(vi.mocked(d.probe).mock.calls[0][3]).toMatchObject({ strictTls: true });
  });

  it('local: false runs no scan; the report says skipped', async () => {
    const { d } = fakes();
    const r = await runDiscovery({ local: false }, d);
    expect(d.localListeners).not.toHaveBeenCalled();
    expect(r.localScan).toEqual({ status: 'skipped', attempts: [], vcFilter: 'off', sweep: false });
  });

  it('inside WSL the result carries the note', async () => {
    const { d } = fakes({}, { detectEnvironment: vi.fn(() => ({ wsl: true })) });
    const r = await runDiscovery({ local: false }, d);
    expect(r.environment).toEqual({ wsl: true });
    expect(r.notes[0]).toMatch(/Running inside WSL/);
  });
});

describe('sweep fallback (opt-in)', () => {
  it('runs only when asked, on Windows, after the OS sources failed', async () => {
    const failed = vi.fn(async () => listening([], 'failed'));
    const notAsked = fakes({}, { localListeners: failed });
    const r0 = await runDiscovery({}, notAsked.d);
    expect(notAsked.d.sweep).not.toHaveBeenCalled();
    expect(r0.localScan).toMatchObject({ status: 'failed', sweep: false });

    const asked = fakes({ '127.0.0.1:41000/https': RWS2 }, {
      localListeners: failed,
      sweep: vi.fn(async () => ({ open: [41000], complete: true })),
    });
    const r1 = await runDiscovery({ localFallback: { sweep: true } }, asked.d);
    expect(asked.d.sweep).toHaveBeenCalledWith('127.0.0.1', expect.anything());
    expect(r1.localScan).toMatchObject({ status: 'failed', sweep: true });
    expect(r1.controllers.map(c => c.key)).toEqual(['local:41000']);

    const okEmpty = fakes({}, { localListeners: vi.fn(async () => listening([])) });
    await runDiscovery({ localFallback: { sweep: true } }, okEmpty.d);
    expect(okEmpty.d.sweep).not.toHaveBeenCalled();

    const linux = fakes({}, { platform: 'linux', localListeners: failed });
    await runDiscovery({ localFallback: { sweep: true } }, linux.d);
    expect(linux.d.sweep).not.toHaveBeenCalled();
  });

  it.each([
    ['win32', [['netstat -ano', 'missing']]],
    ['win32', [['netstat -ano', 'failed'], ['Get-NetTCPConnection', 'timeout']]],
    ['linux', [['/proc/net/tcp', 'failed'], ['ss -ltn', 'missing']]],
    ['darwin', [['netstat -an -p tcp', 'unrecognised'], ['lsof', 'missing']]],
  ] as const)('%s: when every listening-port source fails and no sweep runs, a note says this PC was not searched', async (platform, tried) => {
    const attempts = tried.map(([source, status]) => ({ source, status }));
    const last = attempts[attempts.length - 1];
    const { d } = fakes({}, {
      platform,
      localListeners: vi.fn(async () => ({ ports: [], report: { status: last.status, source: last.source, attempts, vcFilter: 'off' as const, sweep: false } })),
    });
    const r = await runDiscovery({}, d);
    const note = r.notes.find(n => n.startsWith("Could not list this PC's listening ports"));
    expect(note).toBeDefined();
    for (const a of attempts) { expect(note).toContain(a.source); }
    expect(note).toContain('virtual controllers on this PC were not searched');
    expect(note).toContain('127.0.0.1:<port>');
  });

  it('no scan note when the scan answered (even empty), when local is off, or when the sweep ran instead', async () => {
    const scanNote = (notes: string[]): boolean => notes.some(n => n.startsWith("Could not list this PC's listening ports"));
    const ok = fakes();
    expect(scanNote((await runDiscovery({}, ok.d)).notes)).toBe(false);
    const off = fakes({}, { localListeners: vi.fn(async () => listening([], 'failed')) });
    expect(scanNote((await runDiscovery({ local: false, manual: [{ host: '127.0.0.1', port: 9805 }] }, off.d)).notes)).toBe(false);
    const swept = fakes({}, { localListeners: vi.fn(async () => listening([], 'failed')) });
    expect(scanNote((await runDiscovery({ localFallback: { sweep: true } }, swept.d)).notes)).toBe(false);
  });

  it('Linux and macOS: by default only listeners on the known RWS ports and `ports` are probed', async () => {
    // A developer box: sshd, a DNS stub, Redis, PostgreSQL, memcached, a dev server, and a
    // tunnel to a controller on 9805 and on 18080.
    const rows = [row(22), row(53, '127.0.0.53'), row(6379, '127.0.0.1'), row(5432, '127.0.0.1'),
      row(11211, '127.0.0.1'), row(3000), row(9805, '127.0.0.1'), row(18080, '127.0.0.1')];
    for (const platform of ['linux', 'darwin'] as const) {
      const byDefault = fakes({}, { platform, localListeners: vi.fn(async () => listening(rows)) });
      await runDiscovery({ identify: 'none' }, byDefault.d);
      expect(byDefault.probed, platform).toEqual(['127.0.0.1:9805/https']);

      const withPorts = fakes({}, { platform, localListeners: vi.fn(async () => listening(rows)) });
      await runDiscovery({ identify: 'none', ports: [18080] }, withPorts.d);
      expect(withPorts.probed.filter(p => p.startsWith('127.0.0.1:18080/')).sort(), platform)
        .toEqual(['127.0.0.1:18080/http', '127.0.0.1:18080/https']);
      expect(withPorts.probed.some(p => /:(6379|5432|11211|22|3000)\//.test(p)), platform).toBe(false);

      const everything = fakes({}, { platform, localListeners: vi.fn(async () => listening(rows)) });
      await runDiscovery({ identify: 'none', filterToVcProcesses: false }, everything.d);
      expect(new Set(everything.probed.map(p => Number(p.split(':')[1].split('/')[0]))), platform)
        .toEqual(new Set([22, 53, 6379, 5432, 11211, 3000, 9805, 18080]));
    }
  });

  it('passes the PowerShell opt-in to the scan', async () => {
    const { d } = fakes();
    await runDiscovery({ localFallback: { powershell: true } }, d);
    expect(vi.mocked(d.localListeners).mock.calls[0][0]).toMatchObject({ powershell: true, platform: 'win32' });
  });
});

describe('progress', () => {
  it('reports the scan, every probe with growing counts, and done last', async () => {
    const events: DiscoveryProgress[] = [];
    const { d } = fakes({ '192.0.2.50:80/https': { kind: 'tls-failed' }, '192.0.2.50:80/http': RWS1 }, {
      localListeners: vi.fn(async () => listening([row(9403, '0.0.0.0', 2103)])),
      pidImages: vi.fn(async () => ({ status: 'ok' as const, images: new Map([[2103, 'Vrchost64.exe']]) })),
    });
    await runDiscovery({ identify: 'none', manual: [{ host: '192.0.2.50' }], onProgress: e => events.push(e) }, d);
    expect(events[0]).toMatchObject({ phase: 'local-scan', probed: 0 });
    expect(events[0].localScan).toBeUndefined();
    expect(events.find(e => e.phase === 'local-scan' && e.localScan)?.localScan).toMatchObject({ status: 'ok', vcFilter: 'on' });
    const probes = events.filter(e => e.phase === 'probe');
    expect(probes.map(e => e.probed)).toEqual([1, 2, 3, 4]);
    expect(probes[0].total).toBe(3);                 // 9403, 443, 80/https planned
    expect(probes[probes.length - 1].total).toBe(4); // 80/http added after the TLS failure
    expect(probes.map(e => e.current)).toEqual(expect.arrayContaining(['192.0.2.50:80/http', '127.0.0.1:9403/https']));
    expect(events[events.length - 1]).toMatchObject({ phase: 'done', found: 1 });
  });

  it('an onProgress that throws is logged once and the run completes', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => { /* quiet */ });
    const { d } = vcFakes();
    const r = await runDiscovery({ identify: 'none', onProgress: () => { throw new Error('ui gone'); } }, d);
    expect(r.controllers).toHaveLength(2);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('onProgress threw'))).toHaveLength(1);
  });
});

describe('cancel', () => {
  it('resolves with aborted: true and the entries found before the abort; nothing starts after it', async () => {
    const ac = new AbortController();
    const started: string[] = [];
    const { d } = fakes({}, {
      probe: vi.fn(async (host: string, port: number, https: boolean, opts: { signal?: AbortSignal }) => {
        started.push(`${host}:${port}`);
        if (port === 5466) { return RWS2; }
        // Hang until the abort, then settle as probeOne does once its socket closed.
        return new Promise<ProbeOutcome>(resolve => opts.signal?.addEventListener('abort', () => setTimeout(() => resolve({ kind: 'aborted' }), 20), { once: true }));
      }),
      localListeners: vi.fn(async () => listening([row(5466), ...Array.from({ length: 20 }, (_, i) => row(30000 + i))])),
    });
    const done = runDiscovery({ identify: 'none', filterToVcProcesses: false, pacing: { local: { concurrency: 2 } }, signal: ac.signal }, d);
    await new Promise(r => setTimeout(r, 50));
    const before = started.length;
    ac.abort();
    const r = await done;
    expect(r.aborted).toBe(true);
    expect(started.length).toBe(before);
    expect(r.controllers.map(c => c.key)).toEqual(['local:5466']);
  });

  it('an abort before the start runs no scan and no probe', async () => {
    const ac = new AbortController();
    ac.abort();
    const { d } = fakes({}, { localListeners: vi.fn(async () => ({ ports: [], report: { status: 'skipped' as const, source: 'netstat -ano', attempts: [{ source: 'netstat -ano', status: 'skipped' as const, detail: 'cancelled' }], vcFilter: 'off' as const, sweep: false } })) });
    const r = await runDiscovery({ signal: ac.signal, mdns: false, manual: [{ host: '127.0.0.1' }] }, d);
    expect(r.aborted).toBe(true);
    expect(d.probe).not.toHaveBeenCalled();
    expect(r.controllers).toEqual([]);
  });

  it('logins: identify gets the signal, so a cancel stops new logins', async () => {
    const ac = new AbortController();
    const { d } = vcFakes();
    await runDiscovery({ identify: 'with-credentials', credentials: { 'local:5466': { username: 'u', password: 'p' } }, signal: ac.signal }, d);
    expect(vi.mocked(d.identifyOverNetwork).mock.calls[0][1].signal).toBe(ac.signal);
  });
});

describe('legacy compatibility mode (internal)', () => {
  it('probes the given host on every listening port over both schemes, with no process list and no folder read', async () => {
    const { d, probed } = vcFakes();
    const r = await runDiscovery({ local: true, identify: 'none', filterToVcProcesses: false, localProbeHost: 'localhost', compat: true }, d);
    expect(d.pidImages).not.toHaveBeenCalled();
    expect(d.vcProcessDetails).not.toHaveBeenCalled();
    expect(probed.sort()).toEqual([
      '127.0.0.1:135/http', '127.0.0.1:135/https', '127.0.0.1:39127/http', '127.0.0.1:39127/https',
      '127.0.0.1:5466/http', '127.0.0.1:5466/https',
    ]);
    expect(r.hits.length).toBe(6);
  });

  it('the public entry point returns the documented shape, without the internal hits', async () => {
    const { findControllers } = await import('../../src/discovery/findControllers.js');
    // local: false and nothing else to probe: no scan, no socket, no process.
    const r = await findControllers({ local: false, compat: true, localProbeHost: '127.0.0.1' } as never);
    expect(Object.keys(r).sort()).toEqual(
      ['aborted', 'controllers', 'environment', 'localScan', 'notes', 'tlsFailures', 'unmatchedCredentials']);
    expect(r.localScan.status).toBe('skipped');
  });
});
