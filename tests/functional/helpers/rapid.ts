/**
 * RAPID modules for functional tests, and loading them through the client.
 *
 * Every module name starts with ZZ_PROBE (restore unloads and deletes
 * anything so named), and every symbol and routine in a generated module is
 * prefixed with the module name in lower case, so two generated modules never
 * collide and none collides with the station's own program.
 *
 * No module generated here declares a global `PROC main`: a station program
 * with a Module1 has one, and a second global main would make the program
 * ambiguous. Do not count on a station main either: after the VC restart of
 * 2026-09-30 none of the three virtual controllers has a Module1 or a `main`
 * (T_ROB1 holds only BASE, plus `user` on RW 6.16.03) and the program pointer
 * reads empty at idle. Tests move the program pointer to the module's entry
 * routine instead (`RobotManager.setPPToRoutine`); a test that needs a `main`
 * (08, for `resetRapid`) loads its own.
 *
 * Motion is only ever joint moves relative to where the robot stands when the
 * routine starts (CJointT), inside `MOTION_LIMITS`, with MoveAbsJ, zone fine
 * and tool0, and back to the start joints. Never a Cartesian target.
 *
 * Test infrastructure only - never shipped in the package.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RobotManager } from '../../../src/index.js';
import { PROBE_PREFIX, RUN_DIR, type Generation } from './config.js';
import { MOTION_LIMITS } from './guard.js';
import { volumeRoots } from './state.js';
import { harnessNote } from './trace.js';

/** A generated module: its name, text, and the names of what it declares. */
export interface GeneratedModule {
  name: string;
  text: string;
  /** Data symbols by role, e.g. `{ num: 'zz_probe_data_num' }`. */
  symbols: Record<string, string>;
  /** Routines by role, e.g. `{ entry: 'zz_probe_exec_main', second: 'zz_probe_exec_second' }`. */
  routines: Record<string, string>;
}

/** Module names: ZZ_PROBE, then up to 16 more letters, digits or underscores (room for symbol suffixes). */
const MODULE_NAME = /^ZZ_PROBE[A-Za-z0-9_]{0,16}$/;

/** Throw unless `name` is a valid ZZ_PROBE module name. */
export function assertProbeModuleName(name: string): void {
  if (!MODULE_NAME.test(name)) {
    throw new Error(`functional module name ${JSON.stringify(name)} must match ${MODULE_NAME} (start with ${PROBE_PREFIX}, at most 24 characters)`);
  }
}

const num = (n: number): string => {
  if (!Number.isFinite(n)) { throw new Error(`not a finite number: ${n}`); }
  return String(Math.round(n * 1e6) / 1e6);
};

/**
 * `n` as the right-hand side of an addition, with the operator carrying the
 * sign: `+ 3`, `- 3`, `+ 0`. Rounded as `num` rounds, so a value that rounds
 * to zero (a joint at rest can read float noise such as 1.98e-16) is `+ 0`.
 *
 * RAPID accepts a sign only at the start of an expression. `x + -3` loads
 * (loadmod answers 200), but the task program then has a syntax error and
 * the next program-pointer move is refused (RW 7.21.4, 2026-09-30: HTTP 400,
 * controller code -1073442803).
 */
export function signedTerm(n: number): string {
  if (!Number.isFinite(n)) { throw new Error(`not a finite number: ${n}`); }
  const r = Math.round(n * 1e6) / 1e6;
  return r < 0 ? `- ${num(-r)}` : `+ ${num(r)}`;
}

/**
 * Data module: one of each common declaration kind, for symbol reads, writes,
 * properties, search and subscriptions. Symbols (role -> name):
 * num (PERS num 0), var (VAR num 1), const (CONST num 42), bool (PERS bool
 * FALSE), str (PERS string "zz"), arr (VAR num{5} [1,2,3,4,5]), matrix
 * (VAR num{2,3}), pos (PERS pos [1,2,3]), jt (PERS jointtarget).
 */
export function zzDataModule(opts: { name?: string } = {}): GeneratedModule {
  const name = opts.name ?? 'ZZ_PROBE_DATA';
  assertProbeModuleName(name);
  const p = name.toLowerCase();
  const symbols = {
    num: `${p}_num`, var: `${p}_var`, const: `${p}_const`, bool: `${p}_bool`, str: `${p}_str`,
    arr: `${p}_arr`, matrix: `${p}_matrix`, pos: `${p}_pos`, jt: `${p}_jt`,
  };
  const text = [
    `MODULE ${name}`,
    `  PERS num ${symbols.num} := 0;`,
    `  VAR num ${symbols.var} := 1;`,
    `  CONST num ${symbols.const} := 42;`,
    `  PERS bool ${symbols.bool} := FALSE;`,
    `  PERS string ${symbols.str} := "zz";`,
    `  VAR num ${symbols.arr}{5} := [1,2,3,4,5];`,
    `  VAR num ${symbols.matrix}{2,3} := [[1,2,3],[4,5,6]];`,
    `  PERS pos ${symbols.pos} := [1,2,3];`,
    `  PERS jointtarget ${symbols.jt} := [[0,0,0,0,30,0],[9E9,9E9,9E9,9E9,9E9,9E9]];`,
    'ENDMODULE',
    '',
  ].join('\n');
  return { name, text, symbols, routines: {} };
}

/**
 * Execution module, no motion: the entry routine counts `loops` times with
 * `WaitTime waitSec` between counts (default 600 x 0.1 s, about a minute, so a
 * test can see it running and stop it), then sets `done` to 1. The second
 * routine adds 100 to `calls` and returns. Symbols: count, done, calls
 * (PERS num). Routines: entry, second.
 */
export function zzExecModule(opts: { name?: string; loops?: number; waitSec?: number } = {}): GeneratedModule {
  const name = opts.name ?? 'ZZ_PROBE_EXEC';
  assertProbeModuleName(name);
  const loops = opts.loops ?? 600;
  const waitSec = opts.waitSec ?? 0.1;
  if (!Number.isInteger(loops) || loops < 1 || loops > 100000) { throw new Error(`loops must be an integer 1..100000, got ${loops}`); }
  if (!(waitSec >= 0.01 && waitSec <= 10)) { throw new Error(`waitSec must be 0.01..10, got ${waitSec}`); }
  const p = name.toLowerCase();
  const symbols = { count: `${p}_count`, done: `${p}_done`, calls: `${p}_calls` };
  const routines = { entry: `${p}_main`, second: `${p}_second` };
  const text = [
    `MODULE ${name}`,
    `  PERS num ${symbols.count} := 0;`,
    `  PERS num ${symbols.done} := 0;`,
    `  PERS num ${symbols.calls} := 0;`,
    `  PROC ${routines.entry}()`,
    `    ${symbols.count} := 0;`,
    `    ${symbols.done} := 0;`,
    `    FOR i FROM 1 TO ${loops} DO`,
    `      Incr ${symbols.count};`,
    `      WaitTime ${num(waitSec)};`,
    '    ENDFOR',
    `    ${symbols.done} := 1;`,
    '  ENDPROC',
    `  PROC ${routines.second}()`,
    `    ${symbols.calls} := ${symbols.calls} + 100;`,
    '  ENDPROC',
    'ENDMODULE',
    '',
  ].join('\n');
  return { name, text, symbols, routines };
}

export type MotionSpeed = typeof MOTION_LIMITS.speeds[number];

export interface MotionModuleOptions {
  name?: string;
  /** Degrees added to axis 1 (|a| <= 5). Default 2. */
  axis1Deg?: number;
  /** Degrees added to axes 4 and 6 (|b| <= 10). Default 5. */
  wristDeg?: number;
  /** Speed data, v100 or slower. Default v100. */
  speed?: MotionSpeed;
  /** Out-and-back cycles (1..20). Default 1. */
  loops?: number;
}

/**
 * Motion module: the entry routine reads the current joints (CJointT), moves
 * axis 1 by `axis1Deg` and axes 4 and 6 by `wristDeg` with MoveAbsJ (zone
 * fine, tool0), moves back to the start joints, `loops` times, counting
 * finished cycles in `loops` and setting `done` to 1 at the end. Offsets may
 * have either sign; they are written with the operator carrying the sign
 * (`signedTerm`), the only form RAPID accepts after an operand.
 * Symbols: start, target (VAR jointtarget), loops, done (PERS num).
 * Routines: entry. Throws for anything outside `MOTION_LIMITS`.
 */
export function zzMotionModule(opts: MotionModuleOptions = {}): GeneratedModule {
  const name = opts.name ?? 'ZZ_PROBE_MOTION';
  assertProbeModuleName(name);
  const a = opts.axis1Deg ?? 2;
  const b = opts.wristDeg ?? 5;
  const speed = opts.speed ?? 'v100';
  const loops = opts.loops ?? 1;
  if (!Number.isFinite(a) || Math.abs(a) > MOTION_LIMITS.axis1MaxDeg) {
    throw new Error(`axis1Deg must be within +-${MOTION_LIMITS.axis1MaxDeg}, got ${a}`);
  }
  if (!Number.isFinite(b) || Math.abs(b) > MOTION_LIMITS.wristMaxDeg) {
    throw new Error(`wristDeg must be within +-${MOTION_LIMITS.wristMaxDeg}, got ${b}`);
  }
  if (!(MOTION_LIMITS.speeds as readonly string[]).includes(speed)) {
    throw new Error(`speed must be one of ${MOTION_LIMITS.speeds.join(', ')}, got ${speed}`);
  }
  if (!Number.isInteger(loops) || loops < 1 || loops > MOTION_LIMITS.maxLoops) {
    throw new Error(`loops must be an integer 1..${MOTION_LIMITS.maxLoops}, got ${loops}`);
  }
  const p = name.toLowerCase();
  const symbols = { start: `${p}_start`, target: `${p}_target`, loops: `${p}_loops`, done: `${p}_done` };
  const routines = { entry: `${p}_main` };
  const text = [
    `MODULE ${name}`,
    `  VAR jointtarget ${symbols.start};`,
    `  VAR jointtarget ${symbols.target};`,
    `  PERS num ${symbols.loops} := 0;`,
    `  PERS num ${symbols.done} := 0;`,
    `  PROC ${routines.entry}()`,
    `    ${symbols.done} := 0;`,
    `    ${symbols.loops} := 0;`,
    `    ${symbols.start} := CJointT();`,
    `    ${symbols.target} := ${symbols.start};`,
    `    ${symbols.target}.robax.rax_1 := ${symbols.start}.robax.rax_1 ${signedTerm(a)};`,
    `    ${symbols.target}.robax.rax_4 := ${symbols.start}.robax.rax_4 ${signedTerm(b)};`,
    `    ${symbols.target}.robax.rax_6 := ${symbols.start}.robax.rax_6 ${signedTerm(b)};`,
    `    FOR i FROM 1 TO ${loops} DO`,
    `      MoveAbsJ ${symbols.target}, ${speed}, fine, tool0;`,
    `      MoveAbsJ ${symbols.start}, ${speed}, fine, tool0;`,
    `      Incr ${symbols.loops};`,
    '    ENDFOR',
    `    ${symbols.done} := 1;`,
    '  ENDPROC',
    'ENDMODULE',
    '',
  ].join('\n');
  return { name, text, symbols, routines };
}

/** What uploadAndLoad / unload need from the harness context. */
export interface RapidTarget {
  readonly generation: Generation;
  /** The motion task, e.g. T_ROB1. */
  readonly task: string;
  ensureManager(): Promise<RobotManager>;
}

/** Where a module file lives on the controller: `$HOME/<name>.mod` (RWS 1.0) or `HOME/<name>.mod` (RWS 2.0). */
export function remoteModulePath(generation: Generation, name: string): string {
  return `${volumeRoots(generation).home}/${name}.mod`;
}

export interface LoadedModule { task: string; name: string; remotePath: string }

/**
 * Upload `text` as `<name>.mod` and load it into the task, through the
 * client's `RobotManager.loadProgram` - the product path: it takes the access
 * the load needs (mastership on RW6/RW7, write access on RW8), unloads a
 * module of the same name first, uploads to HOME and loads with replace. The
 * program pointer is not moved, and a running program is refused, not
 * stopped. The local copy is kept in the run directory as evidence.
 */
export async function uploadAndLoad(
  target: RapidTarget, name: string, text: string, opts: { task?: string } = {},
): Promise<LoadedModule> {
  assertProbeModuleName(name);
  if (!new RegExp(`^\\s*MODULE\\s+${name}\\b`, 'im').test(text)) {
    throw new Error(`module text does not declare MODULE ${name}`);
  }
  const task = opts.task ?? target.task;
  const dir = path.join(RUN_DIR, 'modules');
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, `${name}.mod`);
  fs.writeFileSync(local, text);
  const manager = await target.ensureManager();
  await manager.loadProgram(local, task, { resetPP: false });
  const loaded = { task, name, remotePath: remoteModulePath(target.generation, name) };
  harnessNote(`loaded ${name} into ${task}`, loaded);
  return loaded;
}

/**
 * Unload the module (stopping RAPID if it runs) and delete its file.
 * Idempotent: a module that is not loaded and a file that is gone are fine.
 */
export async function unload(
  target: RapidTarget, name: string, opts: { task?: string; keepFile?: boolean } = {},
): Promise<void> {
  assertProbeModuleName(name);
  const task = opts.task ?? target.task;
  const manager = await target.ensureManager();
  const listed = await manager.listModulesDetailed(task);
  if (listed.some(m => m.name.toUpperCase() === name.toUpperCase())) {
    await manager.unloadModule(task, name, { stopIfRunning: true });
  }
  if (!opts.keepFile) {
    const remote = remoteModulePath(target.generation, name);
    try {
      await manager.deleteControllerFile(remote);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (!/404|not found|does not exist|no such/i.test(text)) { throw e; }
    }
  }
  harnessNote(`unloaded ${name} from ${task}`);
}
