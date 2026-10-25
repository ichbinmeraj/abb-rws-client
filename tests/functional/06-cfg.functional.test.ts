/**
 * Functional: the configuration database (`/rw/cfg`), reads only.
 *
 * Per controller, through the client's own API (RobotManager first; the
 * adapter for the attribute schema, on both generations):
 * the domains, the types of MOC, EIO and SYS, instance lists with paging
 * (EIO_SIGNAL on RobotWare 8.2.1 has more than 70 rows, which the controller
 * serves in pages of 70), single instances read by name (including a name
 * with a space), the MOC chain from the mechanical unit to the arm bounds of
 * every axis (radians, checked against the live joint position in degrees),
 * and how unknown types, instances and domains come back.
 *
 * Per build: SYS/CONTROL_STATION (the RW8 control-station configuration) is a
 * type on RW 8.2.1+1023 (2026-09-29) and not on RW 8.1.1+614, whose 28 SYS
 * types are the same as RW 7.21.0+229's (a read of the type answers 400
 * -1073437695 "Invalid type id", 2026-10-03). It is asserted from RW 8.2 on.
 *
 * Nothing here writes: no CFG write, load or save. The last test checks the
 * controller is as the baseline found it.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import { it, expect } from 'vitest';
import { RwsError, type IRWSAdapter, type RobotManager } from '../../src/index.js';
import { forEachController, diffSnapshots, type FunctionalContext } from './helpers/index.js';

const RAD_TO_DEG = 180 / Math.PI;
const SIGNAL_TYPES = ['DI', 'DO', 'AI', 'AO', 'GI', 'GO'];
/** The controller's page size for CFG instance lists (RWS 2.0). */
const CFG_PAGE = 70;
/** Names that exist on no controller. `ZZ_PROBE` marks them as the suite's own. */
const NO_TYPE = 'ZZ_PROBE_NO_TYPE';
const NO_INSTANCE = 'ZZ_PROBE_NO_INSTANCE';
const NO_DOMAIN = 'ZZ_PROBE';

type Attrs = Record<string, string>;
type SchemaReader = { listCfgTypeAttributes?: (domain: string, type: string) => Promise<Array<Record<string, string>>> };

/** One instance's attributes through the manager, typed. */
async function cfg(m: RobotManager, domain: string, type: string, instance: string): Promise<Attrs> {
  return (await m.getCfgInstance(domain, type, instance)) as Attrs;
}

/**
 * An attribute by name, case-insensitive: RWS 2.0 and RWS 1.0 agree on the
 * spelling of the MOC attributes (`upper_joint_bound`, `use_robot`), but
 * a read should not depend on the case of an attribute a build may rename.
 */
function attr(attrs: Attrs, name: string): string | undefined {
  if (name in attrs) { return attrs[name]; }
  const key = Object.keys(attrs).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : attrs[key];
}

function num(attrs: Attrs, name: string): number {
  const raw = attr(attrs, name);
  const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(v)) { throw new Error(`attribute ${name} is not a number: ${JSON.stringify(raw)}`); }
  return v;
}

/** Whether a RobotWare version is `major.minor` or later ('8.2.1+1023' is 8.2 or later). */
function rwAtLeast(rwVersion: string, major: number, minor: number): boolean {
  const [a, b] = rwVersion.split(/[.+]/).map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && (a > major || (a === major && b >= minor));
}

function unique(names: string[]): boolean {
  return new Set(names).size === names.length;
}

/** The six robot axes of a mechanical unit, walked through MOC. */
interface AxisChain {
  joint: string;
  logicalAxis: number;
  arm: string;
  transmission: string;
  lowerRad: number;
  upperRad: number;
  rotatingMove: string | undefined;
}

async function walkRobotChain(ctx: FunctionalContext, m: RobotManager): Promise<{
  robot: string; robotType: string; singles: string[]; axes: AxisChain[];
}> {
  const unit = await cfg(m, 'MOC', 'MECHANICAL_UNIT', ctx.mechunit);
  const robot = attr(unit, 'use_robot') ?? '';
  expect(robot, `MOC/MECHANICAL_UNIT/${ctx.mechunit}.use_robot`).not.toBe('');
  const singles = [0, 1, 2, 3, 4, 5].map(i => attr(unit, `use_single_${i}`) ?? '');

  const rob = await cfg(m, 'MOC', 'ROBOT', robot);
  const joints = [0, 1, 2, 3, 4, 5].map(i => attr(rob, `use_joint_${i}`) ?? '');
  expect(joints.every(j => j !== ''), `MOC/ROBOT/${robot}.use_joint_0..5 ${JSON.stringify(joints)}`).toBe(true);
  expect(unique(joints)).toBe(true);

  const axes: AxisChain[] = [];
  for (const joint of joints) {
    const j = await cfg(m, 'MOC', 'JOINT', joint);
    const arm = attr(j, 'use_arm') ?? '';
    const transmission = attr(j, 'use_transmission') ?? '';
    expect(arm, `MOC/JOINT/${joint}.use_arm`).not.toBe('');
    expect(transmission, `MOC/JOINT/${joint}.use_transmission`).not.toBe('');
    const a = await cfg(m, 'MOC', 'ARM', arm);
    const tr = await cfg(m, 'MOC', 'TRANSMISSION', transmission);
    axes.push({
      joint,
      logicalAxis: num(j, 'logical_axis'),
      arm,
      transmission,
      lowerRad: num(a, 'lower_joint_bound'),
      upperRad: num(a, 'upper_joint_bound'),
      rotatingMove: attr(tr, 'rotating_move'),
    });
  }
  return { robot, robotType: attr(rob, 'use_robot_type') ?? '', singles, axes };
}

await forEachController('06-cfg', ctx => {
  it('lists the six configuration domains', async () => {
    const m = await ctx.ensureManager();
    const domains = await m.listCfgDomains();
    ctx.note('cfg domains', domains);
    // Live-verified 2026-09-29 on RW 6.16.03, 7.21.4+417 and 8.2.1+1023:
    // EIO, MMC, MOC, PROC, SIO and SYS on all three.
    expect(domains).toEqual(expect.arrayContaining(['EIO', 'MMC', 'MOC', 'PROC', 'SIO', 'SYS']));
    expect(unique(domains)).toBe(true);
  });

  it('lists the MOC, EIO and SYS types the family reads, without repeats', async () => {
    const m = await ctx.ensureManager();
    const moc = await m.listCfgTypes('MOC');
    const eio = await m.listCfgTypes('EIO');
    const sys = await m.listCfgTypes('SYS');
    ctx.note('cfg type counts', { MOC: moc.length, EIO: eio.length, SYS: sys.length });
    ctx.note('cfg SYS types', sys);
    for (const [domain, types] of [['MOC', moc], ['EIO', eio], ['SYS', sys]] as const) {
      expect(types.length, `${domain} types`).toBeGreaterThan(0);
      // A paging walk that re-reads a page would repeat names.
      expect(unique([...types]), `${domain} types repeat`).toBe(true);
    }
    // The joint-limit chain (MECHANICAL_UNIT -> ROBOT -> JOINT -> ARM, plus
    // TRANSMISSION for the unit and SINGLE for additional axes): read on all
    // three builds, live-verified 2026-09-29.
    expect(moc).toEqual(expect.arrayContaining(['MECHANICAL_UNIT', 'ROBOT', 'JOINT', 'ARM', 'TRANSMISSION', 'SINGLE']));
    expect(eio).toContain('EIO_SIGNAL');
    expect(sys).toEqual(expect.arrayContaining(['CAB_TASKS', 'MASTER_BOOL']));

    if (ctx.generation === 'rws1') {
      // RobotWare 6 keeps System Input/Output in EIO; SYS has no SYSSIG_OUT
      // (a read of SYS/SYSSIG_OUT answers 400 "Invalid type id").
      // Live-verified 2026-09-29 on RW 6.16.03.
      expect(sys).not.toContain('SYSSIG_OUT');
    } else {
      // OmniCore files System Output under SYS. Live-verified 2026-09-29 on
      // RW 7.21.4+417 and 8.2.1+1023, which also list MoveInAuto and FAN_CONTROL.
      expect(sys).toEqual(expect.arrayContaining(['SYSSIG_OUT', 'SYSSIG_IN', 'MoveInAuto', 'FAN_CONTROL']));
    }
    // The control-station configuration is a SYS type from RobotWare 8.2 on.
    // Live-verified 2026-09-29: present on RW 8.2.1+1023, absent on 7.21.4+417;
    // 2026-10-03: absent on RW 8.1.1+614 and 7.21.0+229. On another 8.x build
    // (8.0) it is recorded.
    const hasControlStation = sys.some(n => n === 'CONTROL_STATION');
    if (ctx.lane === 'rw8' && rwAtLeast(ctx.rwVersion, 8, 2)) {
      expect(hasControlStation, `SYS/CONTROL_STATION on RW ${ctx.rwVersion}`).toBe(true);
    } else if (ctx.lane === 'rw7' || (ctx.lane === 'rw8' && /^\s*8\.1\./.test(ctx.rwVersion))) {
      expect(hasControlStation, `SYS/CONTROL_STATION on RW ${ctx.rwVersion}`).toBe(false);
    } else if (ctx.lane === 'rw8') {
      ctx.note('records: SYS/CONTROL_STATION listed', { rwVersion: ctx.rwVersion, listed: hasControlStation });
    }
  });

  it('walks MOC from the mechanical unit to the arm bounds of all six axes', async () => {
    const m = await ctx.ensureManager();
    const units = await m.listCfgInstances('MOC', 'MECHANICAL_UNIT');
    expect(units).toContain(ctx.mechunit);

    const chain = await walkRobotChain(ctx, m);
    ctx.note('MOC chain', chain);

    // Logical axes 1..6, one per joint.
    expect(chain.axes.map(a => a.logicalAxis).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const a of chain.axes) {
      expect(a.lowerRad, `${a.arm} lower < upper`).toBeLessThan(a.upperRad);
      // rotating_move is a bool; axis 2 reads true on all three builds
      // (live-verified 2026-09-29), the others are recorded in the trace.
      expect(['true', 'false']).toContain(a.rotatingMove);
      if (a.logicalAxis === 2) { expect(a.rotatingMove).toBe('true'); }
    }

    // No additional axes on these systems: every use_single_N is blank and
    // MOC/SINGLE has no instances (live-verified 2026-09-29 on all three).
    expect(chain.singles).toEqual(['', '', '', '', '', '']);
    expect(await m.listCfgInstances('MOC', 'SINGLE')).toEqual([]);
  });

  it('gives the arm bounds in radians, which bracket the live joints once converted to degrees', async () => {
    const m = await ctx.ensureManager();
    const chain = await walkRobotChain(ctx, m);
    const live = await m.getJointTargetFull(ctx.mechunit);
    const byAxis = new Map(chain.axes.map(a => [a.logicalAxis, a]));

    const report = [1, 2, 3, 4, 5, 6].map(n => {
      const a = byAxis.get(n)!;
      return {
        axis: n, liveDeg: live.rax[n - 1],
        lowerRad: a.lowerRad, upperRad: a.upperRad,
        lowerDeg: a.lowerRad * RAD_TO_DEG, upperDeg: a.upperRad * RAD_TO_DEG,
      };
    });
    ctx.note('joint bounds against the live position', report);

    // The motion system reports joints in degrees while MOC stores the bounds
    // in radians (the SI unit ABB documents for Arm Upper/Lower Joint Bound).
    // Converted, the bounds bracket the live position on every axis.
    for (const r of report) {
      expect(r.liveDeg, `axis ${r.axis} live ${r.liveDeg} deg within ${r.lowerDeg}..${r.upperDeg} deg`)
        .toBeGreaterThanOrEqual(r.lowerDeg - 0.5);
      expect(r.liveDeg).toBeLessThanOrEqual(r.upperDeg + 0.5);
    }

    // IRB 1600-6/1.2 bounds, the same on all three builds: axis 5 +/-115 deg
    // (+/-2.007129 rad; 2.0071299 on 6.16.03) and axis 2 -63..136 deg.
    // Live-verified 2026-09-29 on RW 6.16.03, 7.21.4+417 and 8.2.1+1023. The
    // bounds follow the robot variant, so they are asserted only for it.
    const irb1600_12 = /1600_1\.2/.test(chain.robotType) || /^IRB1600_6_120/i.test(ctx.systemName);
    ctx.note('robot variant', { robotType: chain.robotType, systemName: ctx.systemName, irb1600_12 });
    if (irb1600_12) {
      const ax5 = byAxis.get(5)!;
      const ax2 = byAxis.get(2)!;
      expect(ax5.upperRad).toBeCloseTo(2.007129, 4);
      expect(ax5.lowerRad).toBeCloseTo(-2.007129, 4);
      expect(ax5.upperRad * RAD_TO_DEG).toBeCloseTo(115, 1);
      expect(ax2.lowerRad * RAD_TO_DEG).toBeCloseTo(-63, 1);
      expect(ax2.upperRad * RAD_TO_DEG).toBeCloseTo(136, 1);
    }
  });

  it('reads the motion task by name from SYS/CAB_TASKS', async () => {
    const m = await ctx.ensureManager();
    expect(await m.listCfgInstances('SYS', 'CAB_TASKS')).toContain(ctx.task);
    const task = await cfg(m, 'SYS', 'CAB_TASKS', ctx.task);
    ctx.note(`SYS/CAB_TASKS/${ctx.task}`, task);
    expect(attr(task, 'Name')).toBe(ctx.task);
    // The entry routine is `Entry` (ABB's Main Entry); there is no `Main`
    // attribute. T_ROB1 enters at main on RW 6.16, 7.21 and 8.1.1
    // (live-verified 2026-09-27) and on 6.16.03 (2026-09-29).
    expect(attr(task, 'Entry')).toBe('main');
    expect(attr(task, 'Main')).toBeUndefined();
    const motion = attr(task, 'MotionTask');
    if (motion !== undefined) { expect(motion.toLowerCase()).toBe('true'); }
  });

  it('reads the mastership heartbeat configuration the RWS 2.0 client consults', async t => {
    const m = await ctx.ensureManager();
    const hb = await cfg(m, 'SYS', 'MASTER_BOOL', 'HeartBeat');
    ctx.note('SYS/MASTER_BOOL/HeartBeat', hb);
    if (ctx.generation === 'rws1') {
      // Recorded only: the client reads this instance on RobotWare 7.8 and later.
      ctx.skip(t, `RWS 1.0: HeartBeat is not read by the client; recorded ${JSON.stringify(hb)}`);
    }
    // Select false, TimeOut 2000 ms. Live-verified 2026-09-29 on RW 7.21.4+417
    // and 8.2.1+1023.
    expect(attr(hb, 'Name')).toBe('HeartBeat');
    expect(attr(hb, 'Select')).toBe('false');
    expect(attr(hb, 'TimeOut')).toBe('2000');
  });

  it('pages EIO_SIGNAL instances past the first 70 rows, without repeats', async () => {
    const m = await ctx.ensureManager();
    const names = await m.listCfgInstances('EIO', 'EIO_SIGNAL');
    ctx.note('EIO_SIGNAL instance count', { count: names.length, pageSize: CFG_PAGE });
    expect(names.length).toBeGreaterThan(0);
    expect(names.every(n => n !== '')).toBe(true);
    expect(unique(names), 'a page was read twice').toBe(true);

    if (ctx.lane !== 'rw8') { return; }
    // The RW8 VC template has 94 signals: 70 on the first page, 24 on the
    // second (IIO_di1 opens page 1, SC3CBCERR page 2). The `next` href is
    // relative to the response's base (/rw/cfg/); before the client resolved
    // it there, page 2 was requested at a doubled path, answered 404 and the
    // list stopped at 70. Live-verified 2026-09-29 on RW 8.2.1+1023.
    expect(names.length).toBeGreaterThan(CFG_PAGE);
    if (ctx.rwVersion.startsWith('8.2.1')) {
      expect(names).toEqual(expect.arrayContaining(['IIO_di1', 'SC3CBCERR']));
    }
    // The rows past the first page are real instances, readable by name.
    const tail = names.slice(CFG_PAGE);
    const sample = [...new Set([tail[0], tail[Math.floor(tail.length / 2)], tail[tail.length - 1]])];
    for (const name of sample) {
      const a = await cfg(m, 'EIO', 'EIO_SIGNAL', name);
      expect(attr(a, 'Name'), `EIO_SIGNAL/${name}`).toBe(name);
      expect(SIGNAL_TYPES).toContain(attr(a, 'SignalType'));
    }
  });

  it('records how the EIO_SIGNAL configuration compares with the I/O system signal list', async () => {
    const m = await ctx.ensureManager();
    const o: IRWSAdapter = await ctx.observer();
    const cfgNames = await m.listCfgInstances('EIO', 'EIO_SIGNAL');
    const io = await o.listAllSignals();
    const ioNames = io.map(s => s.name);
    const cfgSet = new Set(cfgNames);
    const ioSet = new Set(ioNames);
    const onlyCfg = cfgNames.filter(n => !ioSet.has(n));
    const onlyIo = ioNames.filter(n => !cfgSet.has(n));
    ctx.note('EIO_SIGNAL vs I/O system', { cfg: cfgNames.length, io: ioNames.length, onlyCfg, onlyIo });
    expect(cfgNames.length).toBeGreaterThan(0);
    expect(ioNames.length).toBeGreaterThan(0);
    // On RW 8.2.1+1023 both lists hold the same 94 signals (live-verified
    // 2026-09-29: 70 + 24 CFG rows, 94 signals in the I/O system). On the
    // other builds the counts are recorded, not asserted.
    if (ctx.lane === 'rw8' && ctx.rwVersion.startsWith('8.2.1')) {
      expect(cfgNames.length).toBe(ioNames.length);
    }
  });

  it('reads a signal\'s configuration in agreement with its I/O system type', async () => {
    const m = await ctx.ensureManager();
    const o: IRWSAdapter = await ctx.observer();
    const cfgSet = new Set(await m.listCfgInstances('EIO', 'EIO_SIGNAL'));
    const io = (await o.listAllSignals()).filter(s => cfgSet.has(s.name));
    expect(io.length, 'no signal is both in EIO_SIGNAL and in the I/O system').toBeGreaterThan(0);
    // One signal of each type the controller has, at most four reads.
    const picks = [...new Map(io.map(s => [s.type, s])).values()].slice(0, 4);
    const seen: Array<{ name: string; io: string; cfg: string | undefined }> = [];
    for (const s of picks) {
      const a = await cfg(m, 'EIO', 'EIO_SIGNAL', s.name);
      seen.push({ name: s.name, io: s.type, cfg: attr(a, 'SignalType') });
      expect(attr(a, 'Name'), `EIO_SIGNAL/${s.name}`).toBe(s.name);
      expect(attr(a, 'SignalType'), `EIO_SIGNAL/${s.name}.SignalType`).toBe(s.type);
    }
    ctx.note('signal type, I/O system against CFG', seen);
  });

  it('reads an instance whose name contains a space', async t => {
    const m = await ctx.ensureManager();
    if (ctx.generation === 'rws1') {
      // RWS 1.0 reads an instance through its type's list (matched by name), so
      // no request path carries the name; FAN_CONTROL is not a SYS type there.
      ctx.skip(t, 'RWS 1.0: no known instance name with a space on this build (FAN_CONTROL is RWS 2.0 only)');
    }
    // SYS/FAN_CONTROL holds "Turn Off Fan", read with the space percent-encoded.
    // Live-verified 2026-09-29 on RW 7.21.4+417 and 8.2.1+1023.
    expect(await m.listCfgInstances('SYS', 'FAN_CONTROL')).toContain('Turn Off Fan');
    const fan = await cfg(m, 'SYS', 'FAN_CONTROL', 'Turn Off Fan');
    ctx.note('SYS/FAN_CONTROL/Turn Off Fan', fan);
    expect(attr(fan, 'Name')).toBe('Turn Off Fan');
    expect(attr(fan, 'Value')).toBeDefined();
  });

  it('reads the RW8 control-station configuration', async t => {
    if (ctx.lane !== 'rw8') { ctx.skip(t, 'SYS/CONTROL_STATION exists on RobotWare 8 only'); }
    if (!rwAtLeast(ctx.rwVersion, 8, 2)) {
      // RW 8.1.1+614 has no such type: 400 -1073437695 "Invalid type id",
      // which listCfgInstances lists as empty (2026-10-03).
      ctx.skip(t, `SYS/CONTROL_STATION is a type from RobotWare 8.2 on; RW ${ctx.rwVersion} does not have it`);
    }
    const m = await ctx.ensureManager();
    expect(await m.listCfgInstances('SYS', 'CONTROL_STATION')).toEqual(['System Signals']);
    const cs = await cfg(m, 'SYS', 'CONTROL_STATION', 'System Signals');
    ctx.note('SYS/CONTROL_STATION/System Signals', cs);
    // One instance, every flag 0. Live-verified 2026-09-29 on RW 8.2.1+1023.
    expect(attr(cs, 'Name')).toBe('System Signals');
    for (const k of ['Index', 'Motioncontrol', 'ImplicitWriteAccess', 'PersistentWriteAccess']) {
      expect(attr(cs, k), `CONTROL_STATION.${k}`).toBe('0');
    }
  });

  it('reads the System Output mapping where the build files it', async () => {
    const m = await ctx.ensureManager();
    if (ctx.generation === 'rws2') {
      // Four mapped outputs in SYS; EIO/SYSSIG_OUT is empty. Live-verified
      // 2026-09-29 on RW 7.21.4+417 and 8.2.1+1023.
      const outs = await m.listCfgInstances('SYS', 'SYSSIG_OUT');
      ctx.note('SYS/SYSSIG_OUT', outs);
      expect(outs).toEqual(expect.arrayContaining(['MotLmpPB', 'AutoModeStatus', 'EStopStatus', 'SysFailStatus']));
      const motLmp = await cfg(m, 'SYS', 'SYSSIG_OUT', 'MotLmpPB');
      expect(attr(motLmp, 'Status')).toBe('MotorOn');
      expect(await m.listCfgInstances('EIO', 'SYSSIG_OUT')).toEqual([]);
    } else {
      // RobotWare 6 answers SYS/SYSSIG_OUT 400 "Invalid type id", which the
      // client lists as empty. Live-verified 2026-09-29 on RW 6.16.03.
      expect(await m.listCfgInstances('SYS', 'SYSSIG_OUT')).toEqual([]);
    }
  });

  it('records how a type whose instances carry no name is listed', async () => {
    const m = await ctx.ensureManager();
    // Instances without a Name attribute come back with an empty title:
    // SYS/SYSSIG_ACTRESTR on RW 7.21.4+417 and 8.2.1+1023, and the one
    // EIO/SYSSIG_OUT instance (MotorOn -> MOTLMP) on RW 6.16.03, which cannot
    // be addressed by name or id (live-verified 2026-09-29). The client lists
    // instance names, so such rows cannot be named in its result.
    const [domain, type] = ctx.generation === 'rws2' ? ['SYS', 'SYSSIG_ACTRESTR'] : ['EIO', 'SYSSIG_OUT'];
    const names = await m.listCfgInstances(domain, type);
    ctx.note(`${domain}/${type} as listed by the client (nameless rows on the controller)`, { count: names.length, names });
    expect(Array.isArray(names)).toBe(true);
    expect(names.every(n => typeof n === 'string' && n !== '')).toBe(true);
  });

  it('lists an unknown type as empty', async () => {
    const m = await ctx.ensureManager();
    // The controller answers 400 "Invalid type id"; listCfgInstances reads that
    // as "no instances" on both generations (placeholder types in a domain's
    // list answer the same way).
    expect(await m.listCfgInstances('SYS', NO_TYPE)).toEqual([]);
  });

  it('answers an unknown instance per generation: RWS 2.0 RESOURCE_NOT_FOUND, RWS 1.0 an empty record', async () => {
    const m = await ctx.ensureManager();
    if (ctx.generation === 'rws2') {
      // GET .../instances/{unknown} answers 404 -1073437691 "Invalid cfg
      // Instance". Live-verified 2026-09-29 on RW 8.2.1+1023.
      let caught: unknown = null;
      try { await m.getCfgInstance('MOC', 'ARM', NO_INSTANCE); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(RwsError);
      const err = caught as RwsError;
      ctx.note('unknown instance', { code: err.code, message: err.message });
      expect(err.code).toBe('RESOURCE_NOT_FOUND');
      expect(err.message).toContain('HTTP 404');
      expect(err.message).toContain(NO_INSTANCE);
    } else {
      // RWS 1.0 reads the type's list and matches the name, so an unknown
      // instance is an empty record, not an error.
      expect(await cfg(m, 'MOC', 'ARM', NO_INSTANCE)).toEqual({});
    }
  });

  it('records how an unknown domain is answered', async () => {
    const m = await ctx.ensureManager();
    let outcome: { resolved?: string[]; code?: string; message?: string };
    try {
      outcome = { resolved: await m.listCfgTypes(NO_DOMAIN) };
    } catch (e) {
      expect(e).toBeInstanceOf(RwsError);
      outcome = { code: (e as RwsError).code, message: (e as RwsError).message };
    }
    ctx.note('unknown cfg domain', outcome);
    // Whatever the build answers, no type is invented.
    expect(outcome.resolved ?? []).toEqual([]);
    // RW 6.16.03 answers GET /rw/cfg/{unknown} with 400 (live-verified
    // 2026-09-29), so the list is refused there rather than empty.
    if (ctx.generation === 'rws1') { expect(outcome.code).toBeDefined(); }
  });

  it('reads a type\'s attribute schema through the adapter, on both generations', async () => {
    const o = (await ctx.observer()) as IRWSAdapter & SchemaReader;
    // RWS1Adapter reads it too (GET /rw/cfg/{domain}/{type}/attributes?json=1).
    expect(typeof o.listCfgTypeAttributes).toBe('function');
    const schema = await o.listCfgTypeAttributes!('SYS', 'MASTER_BOOL');
    ctx.note('SYS/MASTER_BOOL attribute schema', schema);
    const byName = new Map(schema.map(a => [a['name'] ?? a['_title'], a]));
    if (ctx.generation === 'rws1') {
      // RW 6.16.03 has no TimeOut here: Name (string), Select (bool,
      // FALSE..TRUE, init FALSE) and ZeroSpeedEMStop (bool), recorded
      // 2026-10-01 and 2026-10-03 through the same RWS 1.0 read.
      expect([...byName.keys()]).toEqual(expect.arrayContaining(['Name', 'Select', 'ZeroSpeedEMStop']));
      expect(byName.get('Select')).toMatchObject({ type: 'bool', init: 'FALSE' });
    } else {
      // SYS/MASTER_BOOL: Name (string), Select (bool, FALSE..TRUE, init FALSE),
      // TimeOut (long, 0..60000, init 2000). Live-verified 2026-09-29 on
      // RW 7.21.4+417.
      expect([...byName.keys()]).toEqual(expect.arrayContaining(['Name', 'Select', 'TimeOut']));
    }
    if (ctx.lane === 'rw7') {
      expect(byName.get('Select')).toMatchObject({ type: 'bool', init: 'FALSE' });
      expect(byName.get('TimeOut')).toMatchObject({ type: 'long', min: '0', max: '60000', init: '2000' });
    }
    // The arm bound attributes are declared on MOC/ARM; their declared type
    // is recorded. Every build reads them on the ARM instances (the MOC chain
    // test above), so the schema lists them on RWS 1.0 too (not yet run there
    // for MOC/ARM).
    const arm = await o.listCfgTypeAttributes!('MOC', 'ARM');
    const bounds = arm.filter(a => /^(upper|lower)_joint_bound$/.test(a['name'] ?? a['_title'] ?? ''));
    ctx.note('MOC/ARM joint-bound attribute schema', bounds);
    expect(bounds.length).toBe(2);
  });

  it('leaves the controller as the baseline found it', async () => {
    const now = await ctx.snapshot();
    expect(now.errors).toEqual([]);
    expect(diffSnapshots(ctx.baseline, now)).toEqual([]);
  });
});
