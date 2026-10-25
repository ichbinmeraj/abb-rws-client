import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import {
  validateFindOptions, checkManualHost, DiscoveryOptionError, DISCOVERY_LIMITS,
  MAX_MANUAL_TARGETS, MAX_EXTRA_PORTS,
} from '../../src/discovery/validate.js';
import type { FindControllersOptions } from '../../src/discovery/types.js';
import { RwsError } from '../../src/types.js';

/**
 * findControllers option rules: every INVALID_ARGUMENT case, before anything is sent.
 * Addresses are private, loopback or RFC 5737 documentation addresses.
 */

function refused(opts: unknown, platform: NodeJS.Platform = 'win32'): DiscoveryOptionError {
  try { validateFindOptions(opts as FindControllersOptions, platform); } catch (e) {
    expect(e).toBeInstanceOf(RwsError);
    expect(e).toBeInstanceOf(DiscoveryOptionError);
    expect((e as RwsError).code).toBe('INVALID_ARGUMENT');
    expect((e as Error).message).toMatch(/^findControllers: .+\. Nothing was sent\.$/);
    return e as DiscoveryOptionError;
  }
  throw new Error(`expected a refusal for ${JSON.stringify(opts)}`);
}

describe('defaults', () => {
  it('no options: loopback-only defaults, nothing off this PC', () => {
    const n = validateFindOptions(undefined, 'win32');
    expect(n).toEqual({
      loopbackOnly: false, local: true, serviceAddress: false, manual: [],
      ranges: { ranges: [], intervals: [], totalHosts: 0 }, ports: [], mdns: false,
      identify: 'anonymous', credentials: {}, strictTls: false, pinnedFingerprints: {},
      filterToVcProcesses: true, knownPortsOnly: false, localFallback: { powershell: false, sweep: false },
      timeoutMs: 1500,
      pacing: { local: { concurrency: 32, minGapMs: 0 }, remote: { concurrency: 8, minGapMs: 100 }, identifyConcurrency: 1 },
      maxRangeHosts: 256, allowPublicRanges: false,
    });
    expect(validateFindOptions({}, 'win32')).toEqual(n);
  });

  it('filterToVcProcesses: default true on Windows only; false off Windows even when asked', () => {
    expect(validateFindOptions({}, 'win32').filterToVcProcesses).toBe(true);
    expect(validateFindOptions({ filterToVcProcesses: false }, 'win32').filterToVcProcesses).toBe(false);
    expect(validateFindOptions({}, 'linux').filterToVcProcesses).toBe(false);
    expect(validateFindOptions({ filterToVcProcesses: true }, 'darwin').filterToVcProcesses).toBe(false);
  });

  it('knownPortsOnly: default true off Windows, false when filterToVcProcesses is false, never on Windows', () => {
    expect(validateFindOptions({}, 'linux').knownPortsOnly).toBe(true);
    expect(validateFindOptions({}, 'darwin').knownPortsOnly).toBe(true);
    expect(validateFindOptions({ filterToVcProcesses: false }, 'linux').knownPortsOnly).toBe(false);
    expect(validateFindOptions({}, 'win32').knownPortsOnly).toBe(false);
    expect(validateFindOptions({ filterToVcProcesses: false }, 'win32').knownPortsOnly).toBe(false);
  });

  it('keeps given values, signal and onProgress', () => {
    const ac = new AbortController();
    const onProgress = (): void => undefined;
    const n = validateFindOptions({
      serviceAddress: 'auto', mdns: true, identify: 'none', strictTls: true, local: false,
      localFallback: { sweep: true }, timeoutMs: 100,
      pacing: { local: { concurrency: 1, minGapMs: 1000 }, remote: { minGapMs: 10000 }, identifyConcurrency: 4 },
      maxRangeHosts: 4096, allowPublicRanges: true, signal: ac.signal, onProgress,
    }, 'linux');
    expect(n).toMatchObject({
      serviceAddress: 'auto', mdns: true, identify: 'none', strictTls: true, local: false,
      localFallback: { powershell: false, sweep: true }, timeoutMs: 100,
      pacing: { local: { concurrency: 1, minGapMs: 1000 }, remote: { concurrency: 8, minGapMs: 10000 }, identifyConcurrency: 4 },
      maxRangeHosts: 4096, allowPublicRanges: true,
    });
    expect(n.signal).toBe(ac.signal);
    expect(n.onProgress).toBe(onProgress);
  });

  it('refuses a non-object options value', () => {
    for (const v of [null, 42, 'x', []]) { expect(refused(v).field).toBe('options'); }
  });
});

describe('loopbackOnly', () => {
  const lo = { loopbackOnly: true } as const;

  it('accepts loopback manual hosts, localhost and loopback ranges', () => {
    const n = validateFindOptions({
      ...lo, serviceAddress: false, mdns: false,
      manual: [{ host: '127.0.0.1', port: 9403 }, { host: 'localhost' }, { host: 'LOCALHOST.' }, { host: '127.0.0.53' }],
      ranges: ['127.0.0.1-127.0.0.1'],
    }, 'win32');
    expect(n.manual.map((m) => m.host)).toEqual(['127.0.0.1', 'localhost', 'LOCALHOST.', '127.0.0.53']);
    expect(n.ranges.totalHosts).toBe(1);
  });

  it('refuses serviceAddress true and auto', () => {
    expect(refused({ ...lo, serviceAddress: true }).field).toBe('serviceAddress');
    expect(refused({ ...lo, serviceAddress: 'auto' }).field).toBe('serviceAddress');
  });

  it('refuses mdns', () => {
    expect(refused({ ...lo, mdns: true }).field).toBe('mdns');
  });

  it('refuses a LAN address, any other host name, and ::1 as a manual host', () => {
    expect(refused({ ...lo, manual: [{ host: '192.0.2.10' }] }).field).toBe('manual[0].host');
    expect(refused({ ...lo, manual: [{ host: '127.0.0.1' }, { host: 'robot.local' }] }).field).toBe('manual[1].host');
    expect(refused({ ...lo, manual: [{ host: '::1' }] }).message).toMatch(/IPv6/);
  });

  it('refuses a range outside 127/8', () => {
    expect(refused({ ...lo, ranges: ['10.0.5.0/30'] }).message).toMatch(/loopbackOnly/);
  });
});

describe('manual', () => {
  it('accepts IPv4 literals and host names, trims, keeps port and https', () => {
    const n = validateFindOptions({
      manual: [
        { host: ' 192.0.2.10 ', port: 443, https: true },
        { host: 'robot-7.example.test', https: false },
        { host: 'IRC5-cell.local.' },
        { host: 'a' },
      ],
    }, 'win32');
    expect(n.manual).toEqual([
      { host: '192.0.2.10', port: 443, https: true },
      { host: 'robot-7.example.test', https: false },
      { host: 'IRC5-cell.local.' },
      { host: 'a' },
    ]);
  });

  it('refuses IPv6 literals with the RobotWare reason', () => {
    for (const h of ['::1', '[::1]', 'fe80::1%eth0', '2001:db8::5', '[2001:db8::5]']) {
      expect(refused({ manual: [{ host: h }] }).message, h).toMatch(/RobotWare does not support IPv6/);
    }
  });

  it('refuses malformed hosts, host:port and broken IPv4 literals', () => {
    for (const h of ['', '   ', 'bad host', '10.0.0.5:8080', 'robot_1.local', '-robot.local', 'robot-.local',
      'a..b', '.robot', '10.0.0.256', '10.0.0', '010.0.0.1', `${'a'.repeat(64)}.local`,
      `${'abcdefghi.'.repeat(26)}com`, 'http://192.0.2.10', '192.0.2.10/32']) {
      expect(refused({ manual: [{ host: h }] }).field, h).toBe('manual[0].host');
    }
    expect(refused({ manual: [{ host: 42 }] }).field).toBe('manual[0].host');
  });

  it('refuses bad ports and https values', () => {
    for (const port of [0, 65536, -1, 1.5, NaN, Infinity, '443', null]) {
      expect(refused({ manual: [{ host: '192.0.2.10', port }] }).field).toBe('manual[0].port');
    }
    expect(refused({ manual: [{ host: '192.0.2.10', https: 'yes' }] }).field).toBe('manual[0].https');
  });

  it(`at most ${MAX_MANUAL_TARGETS} entries; entries must be objects`, () => {
    const ok = Array.from({ length: MAX_MANUAL_TARGETS }, (_, i) => ({ host: `192.0.2.${i + 1}` }));
    expect(validateFindOptions({ manual: ok }, 'win32').manual).toHaveLength(MAX_MANUAL_TARGETS);
    const e = refused({ manual: [...ok, { host: '192.0.2.99' }] });
    expect(e.field).toBe('manual');
    expect(e.limit).toBe(MAX_MANUAL_TARGETS);
    expect(refused({ manual: ['192.0.2.10'] }).field).toBe('manual[0]');
    expect(refused({ manual: { host: '192.0.2.10' } }).field).toBe('manual');
  });

  it('checkManualHost is usable on its own', () => {
    expect(checkManualHost('192.0.2.10')).toBe('192.0.2.10');
    expect(() => checkManualHost('10.0.0.5:8080', 'extraHosts[0]')).toThrow(/extraHosts\[0\]/);
  });
});

describe('ports', () => {
  it('removes duplicates', () => {
    expect(validateFindOptions({ ports: [8080, 8443, 8080] }, 'win32').ports).toEqual([8080, 8443]);
  });

  it(`at most ${MAX_EXTRA_PORTS} distinct ports`, () => {
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 8000 + i);
    expect(validateFindOptions({ ports: [...eight, ...eight] }, 'win32').ports).toHaveLength(8);
    const e = refused({ ports: [...eight, 9000] });
    expect(e.field).toBe('ports');
    expect(e.limit).toBe(MAX_EXTRA_PORTS);
  });

  it('refuses out-of-range or non-integer ports', () => {
    for (const p of [0, 65536, 80.5, NaN, '80']) {
      expect(refused({ ports: [443, p] }).field).toBe('ports[1]');
    }
    expect(refused({ ports: 443 }).field).toBe('ports');
  });
});

describe('ranges', () => {
  it('plans ranges against maxRangeHosts and allowPublicRanges', () => {
    expect(validateFindOptions({ ranges: ['10.0.5.0/24'] }, 'win32').ranges.totalHosts).toBe(254);
    expect(refused({ ranges: ['10.0.5.0/24'], maxRangeHosts: 100 }).limit).toBe(100);
    expect(refused({ ranges: ['10.0.4.0/23'] }).field).toBe('ranges[0]');
    expect(refused({ ranges: ['10.0.5.0/24', '10.0.6.0/25'] }).field).toBe('ranges');
    expect(refused({ ranges: ['198.51.100.0/28'] }).message).toMatch(/allowPublicRanges/);
    expect(validateFindOptions({ ranges: ['198.51.100.0/28'], allowPublicRanges: true }, 'win32').ranges.totalHosts).toBe(14);
  });

  it('refuses /0, multicast and IPv6 ranges', () => {
    refused({ ranges: ['0.0.0.0/0'] });
    refused({ ranges: ['0.0.0.0/0'], maxRangeHosts: 4096, allowPublicRanges: true });
    expect(refused({ ranges: ['224.0.0.0/28'], allowPublicRanges: true }).message).toMatch(/multicast/);
    expect(refused({ ranges: ['fd00::/120'] }).message).toMatch(/IPv6/);
  });

  it('refuses more than 16 entries', () => {
    const many = Array.from({ length: 17 }, (_, i) => `10.0.${i}.1-10.0.${i}.1`);
    expect(refused({ ranges: many }).field).toBe('ranges');
  });
});

describe('numbers: finite integers within bounds, refused not clamped', () => {
  const cases: Array<[string, (v: unknown) => unknown, number, number]> = [
    ['timeoutMs', (v) => ({ timeoutMs: v }), DISCOVERY_LIMITS.timeoutMs.min, DISCOVERY_LIMITS.timeoutMs.max],
    ['pacing.local.concurrency', (v) => ({ pacing: { local: { concurrency: v } } }), 1, 100],
    ['pacing.local.minGapMs', (v) => ({ pacing: { local: { minGapMs: v } } }), 0, 10000],
    ['pacing.remote.concurrency', (v) => ({ pacing: { remote: { concurrency: v } } }), 1, 16],
    ['pacing.remote.minGapMs', (v) => ({ pacing: { remote: { minGapMs: v } } }), 100, 10000],
    ['pacing.identifyConcurrency', (v) => ({ pacing: { identifyConcurrency: v } }), 1, 4],
    ['maxRangeHosts', (v) => ({ maxRangeHosts: v }), 1, 4096],
  ];

  for (const [field, build, min, max] of cases) {
    it(`${field}: ${min}-${max}`, () => {
      expect(() => validateFindOptions(build(min) as FindControllersOptions, 'win32')).not.toThrow();
      expect(() => validateFindOptions(build(max) as FindControllersOptions, 'win32')).not.toThrow();
      for (const bad of [min - 1, max + 1, min + 0.5, NaN, Infinity, -Infinity, String(min), null]) {
        const e = refused(build(bad));
        expect(e.field).toBe(field);
        expect(e.limit).toBe(`${min}-${max}`);
      }
    });
  }

  it('the remote lane cannot be sped past its defaults', () => {
    refused({ pacing: { remote: { concurrency: 17 } } });
    refused({ pacing: { remote: { minGapMs: 99 } } });
    refused({ pacing: { remote: { minGapMs: 0 } } });
  });

  it('pacing blocks must be objects', () => {
    expect(refused({ pacing: 5 }).field).toBe('pacing');
    expect(refused({ pacing: { local: [] } }).field).toBe('pacing.local');
    expect(refused({ pacing: { remote: 'fast' } }).field).toBe('pacing.remote');
  });
});

describe('flags and enums', () => {
  it('refuses non-boolean flags', () => {
    for (const f of ['loopbackOnly', 'local', 'mdns', 'strictTls', 'filterToVcProcesses', 'allowPublicRanges']) {
      expect(refused({ [f]: 'true' }).field).toBe(f);
      expect(refused({ [f]: 1 }).field).toBe(f);
    }
    expect(refused({ localFallback: { powershell: 'yes' } }).field).toBe('localFallback.powershell');
    expect(refused({ localFallback: { sweep: 1 } }).field).toBe('localFallback.sweep');
    expect(refused({ localFallback: true }).field).toBe('localFallback');
  });

  it('serviceAddress: true, false or auto only', () => {
    expect(validateFindOptions({ serviceAddress: true }, 'win32').serviceAddress).toBe(true);
    expect(refused({ serviceAddress: 'yes' }).field).toBe('serviceAddress');
    expect(refused({ serviceAddress: 1 }).field).toBe('serviceAddress');
  });

  it('identify: none, anonymous or with-credentials only', () => {
    expect(refused({ identify: 'full' }).field).toBe('identify');
    expect(refused({ identify: null }).field).toBe('identify');
  });

  it('signal must be an AbortSignal; onProgress a function', () => {
    expect(refused({ signal: {} }).field).toBe('signal');
    expect(refused({ signal: true }).field).toBe('signal');
    expect(refused({ onProgress: 'log' }).field).toBe('onProgress');
  });
});

describe('credentials', () => {
  const cred = { username: 'operator', password: 'pw-for-test' };

  it('accepted with identify with-credentials', () => {
    const n = validateFindOptions({ identify: 'with-credentials', credentials: { 'local:9403': cred, '192.0.2.10': { username: 'u', password: '' } } }, 'win32');
    expect(n.credentials).toEqual({ 'local:9403': cred, '192.0.2.10': { username: 'u', password: '' } });
  });

  it('refused without identify with-credentials (an empty map is let through)', () => {
    expect(refused({ credentials: { 'local:9403': cred } }).field).toBe('credentials');
    expect(refused({ identify: 'none', credentials: { 'local:9403': cred } }).field).toBe('credentials');
    expect(validateFindOptions({ credentials: {} }, 'win32').credentials).toEqual({});
  });

  it('refuses a missing or empty username and a missing password, never echoing a credential', () => {
    const base = { identify: 'with-credentials' } as const;
    const e1 = refused({ ...base, credentials: { 'local:9403': { password: 'pw-for-test' } } });
    expect(e1.field).toBe('credentials["local:9403"].username');
    const e2 = refused({ ...base, credentials: { 'local:9403': { username: '', password: 'pw-for-test' } } });
    expect(e2.field).toBe('credentials["local:9403"].username');
    const e3 = refused({ ...base, credentials: { 'local:9403': { username: 'operator' } } });
    expect(e3.field).toBe('credentials["local:9403"].password');
    const e4 = refused({ ...base, credentials: { 'local:9403': { username: 'operator', password: 12345 } } });
    expect(e4.field).toBe('credentials["local:9403"].password');
    const e5 = refused({ ...base, credentials: { 'local:9403': 'operator:pw-for-test' } });
    expect(e5.field).toBe('credentials["local:9403"]');
    for (const e of [e1, e2, e3, e4, e5]) {
      expect(e.message).not.toMatch(/pw-for-test|12345|operator/);
      expect(e.value).toBeUndefined();
    }
  });

  it('refuses an empty key and a non-object map', () => {
    expect(refused({ identify: 'with-credentials', credentials: { ' ': cred } }).field).toBe('credentials');
    expect(refused({ identify: 'with-credentials', credentials: [cred] }).field).toBe('credentials');
  });
});

describe('pinnedFingerprints', () => {
  const hex = 'AB'.repeat(32);

  it('accepts 64 hex digits, colons allowed; normalises to lower case without colons', () => {
    const colons = hex.match(/../g)?.join(':') as string;
    const n = validateFindOptions({ pinnedFingerprints: { 'local:9805': colons, '192.0.2.10:443': hex } }, 'win32');
    expect(n.pinnedFingerprints).toEqual({ 'local:9805': 'ab'.repeat(32), '192.0.2.10:443': 'ab'.repeat(32) });
  });

  it('refuses wrong lengths, non-hex and non-strings', () => {
    for (const fp of ['ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), 42, '']) {
      expect(refused({ pinnedFingerprints: { 'local:9805': fp } }).field).toBe('pinnedFingerprints["local:9805"]');
    }
    expect(refused({ pinnedFingerprints: 'x' }).field).toBe('pinnedFingerprints');
  });
});

describe('nothing is sent while validating', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('no socket, child process or DNS lookup for any refused or accepted option set', () => {
    const spies = [
      vi.spyOn(net, 'connect'), vi.spyOn(net, 'createConnection'), vi.spyOn(tls, 'connect'),
      vi.spyOn(http, 'request'), vi.spyOn(http, 'get'), vi.spyOn(https, 'request'), vi.spyOn(https, 'get'),
      vi.spyOn(dgram, 'createSocket'), vi.spyOn(dns, 'lookup'), vi.spyOn(dns.promises, 'lookup'),
      vi.spyOn(childProcess, 'execFile'), vi.spyOn(childProcess, 'spawn'), vi.spyOn(childProcess, 'exec'),
    ];
    const sets: unknown[] = [
      { ranges: ['10.0.0.0/8'] },
      { ranges: ['10.0.5.0/24', '10.0.6.0/24'] },
      { manual: Array.from({ length: 17 }, () => ({ host: 'robot.example.test' })) },
      { ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { maxRangeHosts: 5000 },
      { loopbackOnly: true, manual: [{ host: 'robot.example.test' }] },
      { loopbackOnly: true, mdns: true },
      { credentials: { 'local:80': { username: 'u', password: 'p' } } },
      { manual: [{ host: 'robot.example.test' }], ranges: ['10.0.5.0/24'], serviceAddress: true, mdns: true },
    ];
    for (const s of sets) {
      try { validateFindOptions(s as FindControllersOptions, 'win32'); } catch { /* refusals expected */ }
    }
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); }
  });
});
