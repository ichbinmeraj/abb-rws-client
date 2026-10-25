/**
 * Offline checks of the functional fleet discovery (fleet.ts): which controller
 * takes which lane, when a login is made and when it is not, the order the
 * lanes are filled in, and which lane a controller that answered but could
 * not be used is named for, and when a run's cached fleet.json is reused. No
 * socket and no file: `findControllers`, the trace and `fs` are fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FindControllersOptions, FoundController } from '../../../src/index.js';

const fake = vi.hoisted(() => ({
  calls: [] as unknown[],
  scan: (): unknown[] => [],
  login: (_port: number): unknown[] => [],
  /** The run's fleet.json, as readFileSync returns it; null: no such file. */
  cached: null as string | null,
}));

vi.mock('../../../src/index.js', () => ({
  findControllers: vi.fn(async (o: { identify?: string; manual?: Array<{ port: number }> }) => {
    fake.calls.push(o);
    const controllers = o.identify === 'with-credentials' ? fake.login(o.manual?.[0]?.port ?? 0) : fake.scan();
    return {
      controllers, aborted: false, environment: { wsl: false }, tlsFailures: [], unmatchedCredentials: [],
      notes: [], localScan: { status: 'ok', attempts: [], vcFilter: 'on', sweep: false },
    };
  }),
  RobotManager: { probeSpecificPort: vi.fn(async () => null) },
}));

vi.mock('./trace.js', () => ({
  harnessNote: (): void => {},
  withTraceSession: <T>(_label: string, fn: () => T): T => fn(),
}));

vi.mock('node:fs', () => {
  const api = {
    readFileSync: (): string => {
      if (fake.cached !== null) { return fake.cached; }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    writeFileSync: (): void => {},
    mkdirSync: (): undefined => undefined,
    rmSync: (): void => {},
  };
  return { default: api, ...api };
});

import { discoverFleet, forgetFleet, laneUnusable } from './fleet.js';

function row(port: number, generation: 'rws1' | 'rws2', over: Partial<FoundController> = {}): FoundController {
  const https = generation === 'rws2';
  return {
    key: `local:${port}`, host: '127.0.0.1', port, https, generation, identified: true,
    authType: https ? 'basic' : 'digest',
    probe: { host: '127.0.0.1', port, useHttps: https, authType: https ? 'basic' : 'digest' },
    sources: ['this-pc'], addresses: [{ host: '127.0.0.1', port, https, sources: ['this-pc'] }],
    ...over,
  } as FoundController;
}

type Opts = FindControllersOptions & { credentials?: Record<string, unknown> };
const logins = (): Opts[] => (fake.calls as Opts[]).filter(c => c.identify === 'with-credentials');
const ENV = { ...process.env };

beforeEach(() => {
  fake.calls.length = 0;
  fake.scan = () => [];
  fake.login = () => [];
  fake.cached = null;
  for (const k of ['RWS_TEST_PORT_RW6', 'RWS_TEST_PORT_RW7', 'RWS_TEST_PORT_RW8', 'RWS_FUNCTIONAL_RUN_ID']) { delete process.env[k]; }
  forgetFleet();
});
afterEach(() => { process.env = { ...ENV }; });

describe('fleet lanes', () => {
  it('an RWS 2.0 VC whose version and name were read from its folder takes its lane with no login', async () => {
    fake.scan = () => [row(9403, 'rws2', { rwVersion: '7.21.4+417', systemName: 'IRB1600_6_120_5' })];
    const report = await discoverFleet();
    expect(logins()).toHaveLength(0);
    expect(report.controllers).toEqual([expect.objectContaining({
      lane: 'rw7', port: 9403, https: true, rwVersion: '7.21.4+417', systemName: 'IRB1600_6_120_5', source: 'scan',
    })]);
    expect(fake.calls[0]).toMatchObject({
      loopbackOnly: true, serviceAddress: false, mdns: false, filterToVcProcesses: true, identify: 'anonymous',
    });
  });

  it('RWS 1.0 takes rw6 with exactly one login (for its name and version), for this port only, and a second one is a duplicate', async () => {
    fake.scan = () => [row(39127, 'rws1'), row(41000, 'rws1')];
    fake.login = port => [row(port, 'rws1', { rwVersion: '6.16.3007', systemName: 'IRB1600_6_120_6' })];
    const report = await discoverFleet();
    expect(logins()).toHaveLength(1);
    expect(logins()[0]).toMatchObject({
      loopbackOnly: true, local: false, serviceAddress: false, mdns: false,
      manual: [{ host: '127.0.0.1', port: 39127, https: false }],
    });
    expect(Object.keys(logins()[0].credentials ?? {})).toEqual(['local:39127']);
    expect(report.controllers.map(c => [c.lane, c.port, c.systemName])).toEqual([['rw6', 39127, 'IRB1600_6_120_6']]);
    expect(report.duplicates.map(c => [c.lane, c.port])).toEqual([['rw6', 41000]]);
  });

  it('an RWS 2.0 VC with no version read is logged in to before its lane is known', async () => {
    fake.scan = () => [row(9805, 'rws2')];
    fake.login = port => [row(port, 'rws2', { rwVersion: '8.2.1+1023', systemName: 'IRB1600_6_120_4' })];
    const report = await discoverFleet();
    expect(logins()).toHaveLength(1);
    expect(report.controllers.map(c => [c.lane, c.port])).toEqual([['rw8', 9805]]);
  });

  it('a failed login or a version outside 6-8 makes the controller unusable, not a lane', async () => {
    fake.scan = () => [row(9805, 'rws2'), row(5466, 'rws2', { rwVersion: '9.0.0', systemName: 'X' })];
    fake.login = () => [];
    const report = await discoverFleet();
    expect(report.controllers).toEqual([]);
    expect(report.unusable.map(u => u.port).sort()).toEqual([5466, 9805]);
    // The lanes each could have taken: unknown version, both RWS 2.0 lanes; RobotWare 9, none.
    expect(report.unusable.find(u => u.port === 9805)?.lanes).toEqual(['rw7', 'rw8']);
    expect(report.unusable.find(u => u.port === 5466)?.lanes).toEqual([]);
  });

  it('an RWS 1.0 controller that answers but refuses the login fails the rw6 lane, naming its address and the reason', async () => {
    fake.scan = () => [row(7, 'rws1'), row(9403, 'rws2', { rwVersion: '7.21.4+417', systemName: 'B' })];
    fake.login = () => [];
    const report = await discoverFleet();
    expect(report.controllers.map(c => c.lane)).toEqual(['rw7']);
    expect(report.unusable).toEqual([expect.objectContaining({ port: 7, https: false, lanes: ['rw6'] })]);
    const why = laneUnusable(report, 'rw6');
    expect(why).toMatch(/^a RobotWare 6 controller was found at http:\/\/127\.0\.0\.1:7 but cannot be used: login or system read failed: /);
    expect(laneUnusable(report, 'rw7')).toBeNull();
    expect(laneUnusable(report, 'rw8')).toBeNull();
  });

  it('an RWS 2.0 controller whose version could not be read is named for each RWS 2.0 lane it may belong to', async () => {
    fake.scan = () => [row(9805, 'rws2')];
    fake.login = () => [];
    const report = await discoverFleet();
    for (const lane of ['rw7', 'rw8'] as const) {
      expect(laneUnusable(report, lane)).toMatch(/^an RWS 2\.0 controller whose RobotWare version could not be read \(it may be RobotWare [78]\) was found at https:\/\/127\.0\.0\.1:9805 but cannot be used: login or system read failed/);
    }
    expect(laneUnusable(report, 'rw6')).toBeNull();
  });

  it('no controller found for a lane, or one from an older fleet.json without lanes, names nothing', () => {
    const base = { controllers: [], duplicates: [], discoveredAt: '' };
    expect(laneUnusable({ ...base, unusable: [] }, 'rw6')).toBeNull();
    expect(laneUnusable({ ...base, unusable: [{ port: 7, https: false, reason: 'login or system read failed: x' }] }, 'rw6')).toBeNull();
  });

  it('lane order: env-named port first (probed as a manual target), then RobotWare major, then port', async () => {
    process.env.RWS_TEST_PORT_RW7 = '9403';
    fake.scan = () => [
      row(5466, 'rws2', { rwVersion: '7.21.0+229', systemName: 'A' }),
      row(9403, 'rws2', { rwVersion: '7.21.4+417', systemName: 'B' }),
      row(80, 'rws2', { rwVersion: '8.1.1+614', systemName: 'C' }),
      row(9805, 'rws2', { rwVersion: '8.2.1+1023', systemName: 'D' }),
    ];
    const report = await discoverFleet();
    expect(fake.calls[0]).toMatchObject({ manual: [{ host: '127.0.0.1', port: 9403 }] });
    expect(report.controllers.map(c => [c.lane, c.port, c.source])).toEqual([['rw7', 9403, 'env'], ['rw8', 80, 'scan']]);
    expect(report.duplicates.map(c => c.port)).toEqual([5466, 9805]);
  });

  it('a cached fleet.json naming a controller that could not take its lane is not reused: discovery runs again', async () => {
    process.env.RWS_FUNCTIONAL_RUN_ID = 'cache-check';
    fake.cached = JSON.stringify({
      controllers: [], duplicates: [], discoveredAt: '2026-10-22T00:00:00.000Z',
      unusable: [{ port: 7, https: false, lanes: ['rw6'], reason: 'login or system read failed: still starting' }],
    });
    fake.scan = () => [row(7, 'rws1')];
    fake.login = port => [row(port, 'rws1', { rwVersion: '6.16.3007', systemName: 'R6' })];
    const report = await discoverFleet();
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(report.controllers.map(c => [c.lane, c.port])).toEqual([['rw6', 7]]);
    expect(laneUnusable(report, 'rw6')).toBeNull();
  });

  it('a cached fleet.json with no such controller is reused without a scan', async () => {
    process.env.RWS_FUNCTIONAL_RUN_ID = 'cache-check';
    fake.cached = JSON.stringify({
      controllers: [], duplicates: [], discoveredAt: '2026-10-22T00:00:00.000Z',
      unusable: [{ port: 5466, https: true, lanes: [], reason: 'RobotWare 9.0.0 is not 6, 7 or 8' }],
    });
    const report = await discoverFleet();
    expect(fake.calls).toEqual([]);
    expect(report.discoveredAt).toBe('2026-10-22T00:00:00.000Z');
  });

  it('refuses a discovery result with a host off this PC', async () => {
    fake.scan = () => [row(9403, 'rws2', { host: '192.0.2.10' })];
    await expect(discoverFleet()).rejects.toThrow(/192\.0\.2\.10/);
  });
});
