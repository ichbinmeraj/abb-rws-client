/**
 * Offline checks of the conformance classifier (scripts/conformance-classify.mjs)
 * and of what the crawl walk reports about itself (scripts/conformance-crawl.mjs).
 *
 * A crawl below /rw meets resource families whose members are instances, not
 * operations: one node per hardware device and per device property under
 * /rw/devices, one per RAPID task, mechanical unit, axis, I/O network and
 * device. The classifier counts each family once. The fixture nodes are
 * taken from the 2026-10-09 and 2026-10-10 crawls of RW 6.16.03, 7.21.4 and 8.1.1 virtual
 * controllers. No socket.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs script without type declarations
import * as classifyMod from '../scripts/conformance-classify.mjs';
// @ts-expect-error - plain .mjs script without type declarations
import * as crawlMod from '../scripts/conformance-crawl.mjs';

type Gen = 'rws1' | 'rws2';
interface Spec { domain: string; operation: string; generation: Gen; spec: { path: string; gap?: string } }
interface Row { gen: Gen; resource: string; verdict: string; by: string; match: string; instances: number; reason?: string }
interface Claim { gens: Gen[]; family: string; verdict: string; methods: string[]; reason: string }

const k = classifyMod as {
  familyOf(p: string): string;
  CLAIMS: Claim[];
  classify(advertised: string[], gen: Gen, specs: Spec[]): Row[];
  orphans(advertised: string[], gen: Gen, specs: Spec[], pruned: (p: string) => boolean): Row[];
  summarise(rows: Row[]): Record<string, number>;
};
const c = crawlMod as {
  crawlTree(
    get: (p: string) => Promise<{ status: number; body: string }>,
    gen: 1 | 2,
    opts?: { roots?: string[]; maxNodes?: number; deadlineMs?: number; stats?: Record<string, unknown> },
  ): Promise<string[]>;
};

// ─── fixture nodes, as the crawls listed them ─────────────────────

const RW6_DEVICES = [
  '/rw/devices',
  '/rw/devices/HW_DEVICES',
  '/rw/devices/HW_DEVICES/CONTROLLER',
  '/rw/devices/HW_DEVICES/CONTROLLER/COMPUTER_SYSTEM',
  '/rw/devices/HW_DEVICES/CONTROLLER/COMPUTER_SYSTEM/SERIAL_PORTS/COM1_PORT/PROPERTY_COM1_PORT_BAUDRATE',
  '/rw/devices/HW_DEVICES/MECH_UNITS/ROB1/SIS_DATA_ROB1/PROPERTY_PRODTIME_R1',
  '/rw/devices/SW_RESOURCES',
  '/rw/devices/SW_RESOURCES/RAPID/RAPID_MEMORY/PROPERTY_RAPID_MEM_FREE',
  '/rw/devices/SW_RESOURCES/SYSTEM/MEMORY/MEMORYPOOLS/MEMORYPOOL12/PROPERTY_MEMORY_POOL_12_SIZE',
];
const RW7_DEVICES = [
  '/rw/devices',
  '/rw/devices/HW_DEVICES',
  '/rw/devices/HW_DEVICES/DRIVE_LINK1',
  '/rw/devices/HW_DEVICES/DRIVE_LINK1/DRIVELINK1_FW_INFO/PROPERTY_DRIVELINK1_FW_REVISION',
  '/rw/devices/HW_DEVICES/DRIVE_LINK2/DRIVELINK2_FW_INFO',
  '/rw/devices/SW_RESOURCES',
  '/rw/devices/SW_RESOURCES/ROBAPI/ROBAPI_SUB_IO/PROPERTY_ROBAPI_SUB_IO_PEAK',
];
const RW7_TASKS = [
  '/rw/rapid/tasks',
  '/rw/rapid/tasks/SC_CBC',
  '/rw/rapid/tasks/SC_CBC/motion',
  '/rw/rapid/tasks/SC_CBC/pallet/9',
  '/rw/rapid/tasks/T_ROB1',
  '/rw/rapid/tasks/T_ROB1/motion',
  '/rw/rapid/tasks/T_ROB1/motion/robtarget',
  '/rw/rapid/tasks/T_ROB1/pallet/9',
  '/rw/rapid/tasks/spy',
  '/rw/rapid/tasks/syncstate/motion-pointer',
];

// ─── fixture table entries, in the shape flatten(ALL_TABLES) returns ─────────

const SPECS: Spec[] = [
  { domain: 'ctrl', operation: 'setControllerLanguage', generation: 'rws1', spec: { path: '/ctrl' } },
  { domain: 'ctrl', operation: 'getControllerClock', generation: 'rws1', spec: { path: '/ctrl/clock' } },
  { domain: 'ctrl', operation: 'ctrlOptionsVerify', generation: 'rws2', spec: { path: '/ctrl/options', gap: 'empty verify endpoint' } },
  { domain: 'rapid', operation: 'getRapidTasks', generation: 'rws2', spec: { path: '/rw/rapid/tasks' } },
  { domain: 'rapid', operation: 'getRapidTasks', generation: 'rws1', spec: { path: '/rw/rapid/tasks' } },
  { domain: 'rapid', operation: 'getTaskMotion', generation: 'rws2', spec: { path: '/rw/rapid/tasks/{task}/motion' } },
  { domain: 'rapid', operation: 'getRobTarget', generation: 'rws2', spec: { path: '/rw/rapid/tasks/{task}/motion/robtarget' } },
  { domain: 'rapid', operation: 'getTaskSelection', generation: 'rws2', spec: { path: '/rw/rapid/taskselection' } },
  { domain: 'rapid', operation: 'getRapidExecutionState', generation: 'rws1', spec: { path: '/rw/rapid/execution' } },
];

describe('conformance classifier - instance nodes collapse into families', () => {
  it('every node below a /rw/devices group is one family, whatever the device or property', () => {
    expect(k.familyOf('/rw/devices')).toBe('/rw/devices');
    expect(k.familyOf('/rw/devices/HW_DEVICES')).toBe('/rw/devices/{group}');
    expect(k.familyOf('/rw/devices/SW_RESOURCES')).toBe('/rw/devices/{group}');
    for (const p of [...RW6_DEVICES, ...RW7_DEVICES].filter(p => p.split('/').length > 4)) {
      expect(k.familyOf(p)).toBe('/rw/devices/{group}/{node...}');
    }
  });

  it('task, pallet, mechanical unit, axis, I/O network and device names are parameters', () => {
    expect(k.familyOf('/rw/rapid/tasks/T_ROB1/motion/robtarget')).toBe('/rw/rapid/tasks/{task}/motion/robtarget');
    expect(k.familyOf('/rw/rapid/tasks/SC_CBC/pallet/9')).toBe('/rw/rapid/tasks/{task}/pallet/{n}');
    expect(k.familyOf('/rw/motionsystem/mechunits/ROB_1/axes/3/pose')).toBe('/rw/motionsystem/mechunits/{mechunit}/axes/{axis}/pose');
    expect(k.familyOf('/rw/iosystem/devices/IntBus/DrvSys')).toBe('/rw/iosystem/devices/{network}/{device}');
    expect(k.familyOf('/rw/iosystem/networks/EtherNetIP')).toBe('/rw/iosystem/networks/{network}');
    expect(k.familyOf('/rw/cfg/MOC')).toBe('/rw/cfg/{domain}');
    expect(k.familyOf('/rw/mastership/motion')).toBe('/rw/mastership/{domain}');
    expect(k.familyOf('/rw/motionsystem/checkchangecount/0')).toBe('/rw/motionsystem/checkchangecount/{n}');
  });

  it('static resources beside the task instances are not taken for tasks', () => {
    expect(k.familyOf('/rw/rapid/tasks/spy')).toBe('/rw/rapid/tasks/spy');
    expect(k.familyOf('/rw/rapid/tasks/syncstate/motion-pointer')).toBe('/rw/rapid/tasks/syncstate/motion-pointer');
    expect(k.familyOf('/rw/rapid/tasks')).toBe('/rw/rapid/tasks');
  });

  it('two builds with different tasks and devices give the same families', () => {
    const a = k.classify(['/rw/rapid/tasks/T_ROB1/motion', '/rw/devices/HW_DEVICES/CONTROLLER'], 'rws2', SPECS);
    const b = k.classify(['/rw/rapid/tasks/SC_CBC/motion', '/rw/devices/HW_DEVICES/DRIVE_LINK1'], 'rws2', SPECS);
    expect(a.map(r => r.resource)).toEqual(b.map(r => r.resource));
  });
});

describe('conformance classifier - verdicts', () => {
  it('the /rw/devices tree counts as three families, implemented by the device methods, not one row per node', () => {
    for (const [gen, nodes] of [['rws1', RW6_DEVICES], ['rws2', RW7_DEVICES]] as const) {
      const rows = k.classify(nodes, gen, SPECS);
      expect(rows.map(r => r.resource)).toEqual(['/rw/devices', '/rw/devices/{group}', '/rw/devices/{group}/{node...}']);
      expect(rows.every(r => r.verdict === 'implemented')).toBe(true);
      expect(rows[2].by).toMatch(/listControllerDevices/);
      expect(rows[2].instances).toBe(nodes.length - 1 - 2);
    }
  });

  it('/rw/retcode is getReturnCode on both generations (the code goes in ?code=)', () => {
    for (const gen of ['rws1', 'rws2'] as const) {
      const [row] = k.classify(['/rw/retcode'], gen, SPECS);
      expect(row.verdict).toBe('implemented');
      expect(row.by).toMatch(/getReturnCode/);
    }
  });

  it('RWS 1.0 /rw/rim is a deliberate gap with a reason; the same path on RWS 2.0 is not excused', () => {
    const rows = k.classify(['/rw/rim', '/rw/rim/infra'], 'rws1', SPECS);
    expect(rows.map(r => r.verdict)).toEqual(['deliberate-gap', 'deliberate-gap']);
    expect(rows[0].reason).toMatch(/\S{10,}/);
    expect(k.classify(['/rw/rim'], 'rws2', SPECS)[0].verdict).toBe('unmapped');
  });

  it('RWS 1.0 /rw/rapid/taskselection is unmapped: the table claims it on RWS 2.0 only', () => {
    const [rws1] = k.classify(['/rw/rapid/taskselection'], 'rws1', SPECS);
    expect(rws1.verdict).toBe('unmapped');
    expect(rws1.reason).toMatch(/RWS 2.0 resource only/);
    expect(k.classify(['/rw/rapid/taskselection'], 'rws2', SPECS)[0].verdict).toBe('implemented');
  });

  it('names the most specific table entry and says how it matched', () => {
    const rows = k.classify(['/ctrl/clock', '/ctrl/backup'], 'rws1', SPECS);
    expect(rows[0]).toMatchObject({ resource: '/ctrl/backup', by: 'ctrl.setControllerLanguage', match: 'ancestor' });
    expect(rows[1]).toMatchObject({ resource: '/ctrl/clock', by: 'ctrl.getControllerClock', match: 'exact' });
    const tasks = k.classify(RW7_TASKS, 'rws2', SPECS);
    expect(tasks.find(r => r.resource === '/rw/rapid/tasks/{task}/motion/robtarget'))
      .toMatchObject({ by: 'rapid.getRobTarget', match: 'exact', instances: 1 });
    expect(tasks.find(r => r.resource === '/rw/rapid/tasks/{task}/motion'))
      .toMatchObject({ by: 'rapid.getTaskMotion', match: 'exact', instances: 2 });
  });

  it('a deliberate gap stays a gap; summarise counts families', () => {
    const rows = k.classify(['/ctrl/options', ...RW7_TASKS], 'rws2', SPECS);
    expect(rows.find(r => r.resource === '/ctrl/options')?.verdict).toBe('deliberate-gap');
    const s = k.summarise(rows);
    expect(s.implemented + s['deliberate-gap'] + s.unmapped).toBe(rows.length);
    expect(rows.length).toBeLessThan(RW7_TASKS.length + 1);
  });

  it('an orphan is a static table path no advertised node sits at or under', () => {
    const o = k.orphans(['/ctrl', '/ctrl/clock'], 'rws1', SPECS, () => false);
    expect(o.map(r => r.resource)).toEqual(['/rw/rapid/tasks', '/rw/rapid/execution']);
  });

  it('every method a claim outside the path tables names exists in the adapter of that generation', () => {
    const root = path.resolve(__dirname, '..');
    const rws1 = fs.readFileSync(path.join(root, 'src', 'RWS1Adapter.ts'), 'utf8');
    const rws2 = fs.readdirSync(path.join(root, 'src', 'rws2'))
      .map(f => fs.readFileSync(path.join(root, 'src', 'rws2', f), 'utf8')).join('\n');
    for (const claim of k.CLAIMS) {
      if (claim.verdict !== 'implemented') { continue; }
      for (const gen of claim.gens) {
        for (const m of claim.methods) {
          expect(gen === 'rws1' ? rws1 : rws2, `${gen} ${m}`).toMatch(new RegExp(`async ${m}\\(`));
        }
      }
    }
  });
});

describe('conformance crawl - completeness', () => {
  const tree = (n: number) => {
    const answers: Record<string, string> = {
      '/rw': JSON.stringify({ _links: { base: { href: '/' } }, _embedded: { resources: Array.from({ length: n }, (_, i) => ({ _links: { self: { href: `rw/n${i}` } } })) } }),
    };
    return async (p: string) => (p in answers ? { status: 200, body: answers[p] } : { status: 200, body: '{}' });
  };

  it('reports a complete walk', async () => {
    const stats: Record<string, unknown> = {};
    const found = await c.crawlTree(tree(3), 2, { roots: ['/rw'], stats });
    expect(found).toHaveLength(4);
    expect(stats).toMatchObject({ probed: 4, deadlineHit: false, nodeCapHit: false, complete: true });
  });

  it('reports a walk the node cap cut short', async () => {
    const stats: Record<string, unknown> = {};
    await c.crawlTree(tree(10), 2, { roots: ['/rw'], maxNodes: 5, stats });
    expect(stats).toMatchObject({ probed: 5, nodeCapHit: true, complete: false });
  });

  it('reports a walk the deadline cut short', async () => {
    const stats: Record<string, unknown> = {};
    await c.crawlTree(tree(10), 2, { roots: ['/rw'], deadlineMs: -1, stats });
    expect(stats).toMatchObject({ deadlineHit: true, complete: false });
  });
});

describe('conformance crawl - reads only', () => {
  it('the crawl scripts name no write method, and the request function refuses anything but GET and OPTIONS', () => {
    const dir = path.resolve(__dirname, '..', 'scripts');
    for (const f of ['conformance.mjs', 'conformance-crawl.mjs', 'conformance-links.mjs', 'conformance-classify.mjs']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/['"`](POST|PUT|DELETE|PATCH)['"`]/);
    }
    const main = fs.readFileSync(path.join(dir, 'conformance.mjs'), 'utf8');
    expect(main).toMatch(/method !== 'GET' && method !== 'OPTIONS'.*refuses/s);
  });

  it('the virtual-time resources are walked with plain GETs (reads), like every other node', async () => {
    const got: string[] = [];
    const ctrl = JSON.stringify({ _links: { base: { href: '/ctrl/' } }, _embedded: { resources: [
      { _links: { self: { href: 'virtualtime' } } }] } });
    const vt = JSON.stringify({ _links: { base: { href: '/ctrl/virtualtime/' } }, _embedded: { resources: [
      { _links: { self: { href: 'vtstate' } } }, { _links: { self: { href: 'vtspeed' } } }] } });
    const answers: Record<string, string> = { '/ctrl': ctrl, '/ctrl/virtualtime': vt };
    // The walk's only way to reach a controller is this function, and it takes a path, not a method.
    const get = async (p: string) => { got.push(p); return { status: 200, body: answers[p] ?? '{}' }; };
    await c.crawlTree(get, 2, { roots: ['/ctrl'] });
    expect(got).toEqual(['/ctrl', '/ctrl/virtualtime', '/ctrl/virtualtime/vtstate', '/ctrl/virtualtime/vtspeed']);
  });
});

describe('conformance crawl - a controller that stops answering', () => {
  it('gives up after three reads in a row with no answer, and says where', async () => {
    const answers: Record<string, string> = {
      '/rw': JSON.stringify({ _links: { base: { href: '/' } }, _embedded: { resources:
        Array.from({ length: 8 }, (_, i) => ({ _links: { self: { href: `rw/n${i}` } } })) } }),
    };
    const got: string[] = [];
    const get = async (p: string) => {
      got.push(p);
      if (p === '/rw' || p === '/rw/n0') { return { status: 200, body: answers[p] ?? '{}' }; }
      return { status: 0, body: '' };
    };
    const stats: Record<string, unknown> = {};
    const found = await c.crawlTree(get, 2, { roots: ['/rw'], stats });
    expect(found).toEqual(['/rw', '/rw/n0']);
    expect(got).toEqual(['/rw', '/rw/n0', '/rw/n1', '/rw/n2', '/rw/n3']);
    expect(stats).toMatchObject({ stoppedAnswering: '/rw/n3', complete: false });
  });
});
