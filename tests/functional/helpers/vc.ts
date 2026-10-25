/**
 * Virtual-controller helpers for the functional suite: the simulated panel
 * (enable switch, emergency, general and auto stop) and the mechanical-unit
 * teleport, driven through RobotManager, plus the controller reads the tests
 * assert on.
 *
 * These endpoints exist only on RWS 2.0 virtual controllers, where they stand
 * in for a person's hands. Every caller checks `ctx.requireAllowed(t,
 * 'vc-sim')` first: the lane is RWS 2.0 and the controller's identity reads
 * virtual (guard.ts). The client product never depends on them.
 *
 * Test infrastructure only - never shipped in the package.
 */

import { RWS2Adapter, RwsError, type JointTarget, type RobotManager } from '../../../src/index.js';
import type { FunctionalContext } from './harness.js';
import { MOTION_LIMITS } from './guard.js';
import type { PanelState } from './state.js';

const AXES = [1, 2, 3, 4, 5, 6] as const;
const rax = (i: number): keyof JointTarget => `rax_${i}` as keyof JointTarget;

/** An error as a record for the trace: the typed code and what the controller said. */
export function describeError(e: unknown): Record<string, unknown> {
  if (e instanceof RwsError) {
    return {
      code: e.code, httpStatus: e.httpStatus ?? null, controllerCode: e.controllerCode ?? null,
      controllerMsg: e.controllerMsg ?? null, message: e.message,
      refusal: e.refusal
        ? { kind: e.refusal.kind, condition: e.refusal.condition, grantor: e.refusal.grantor, evidence: e.refusal.evidence }
        : null,
    };
  }
  return { error: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e) };
}

/** `b - a` per robot axis, degrees. */
export function jointDeltas(a: JointTarget, b: JointTarget): number[] {
  return AXES.map(i => b[rax(i)] - a[rax(i)]);
}

export function maxAbs(xs: number[]): number {
  return xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
}

export const round3 = (xs: number[]): number[] => xs.map(x => Math.round(x * 1000) / 1000);

/**
 * The six robot joints as the teleport takes them, degrees, rounded to 1e-6
 * so no value is written in exponent notation (a joint at rest can read float
 * noise such as 1.98e-16).
 */
export function teleportJoints(j: JointTarget): number[] {
  return AXES.map(i => {
    const v = j[rax(i)];
    if (!Number.isFinite(v)) { throw new Error(`not a finite joint value on axis ${i}: ${v}`); }
    const r = Math.round(v * 1e6) / 1e6;
    return Object.is(r, -0) ? 0 : r;
  });
}

/** True when `d` (start to now, per axis) is a move the suite's motion limits allow (with 0.5 deg slack). */
export function withinMotionLimits(d: number[]): boolean {
  return Math.abs(d[0]) <= MOTION_LIMITS.axis1MaxDeg + 0.5
    && Math.abs(d[3]) <= MOTION_LIMITS.wristMaxDeg + 0.5
    && Math.abs(d[5]) <= MOTION_LIMITS.wristMaxDeg + 0.5
    && Math.abs(d[1]) <= 0.5 && Math.abs(d[2]) <= 0.5 && Math.abs(d[4]) <= 0.5;
}

/**
 * The manager's own RWS 2.0 adapter (its registered control station on
 * RobotWare 8), for the few RWS 2.0 client calls RobotManager does not wrap;
 * null on RWS 1.0 or while disconnected.
 */
export function managerRws2(m: RobotManager): RWS2Adapter | null {
  const a = m.state.connected ? (m as unknown as { adapter: unknown }).adapter : null;
  return a instanceof RWS2Adapter ? a : null;
}

export interface PanelStep { atMs: number; opmode: string | null; ctrlstate: string | null }

export interface PanelTrail {
  /** Each change of opmode or controller state, with ms since the watch began. */
  seen: PanelStep[];
  last: PanelState;
  /** `until` held for `stableMs` in a row before the timeout. */
  met: boolean;
  ms: number;
}

/**
 * Read the panel every `pollMs` and keep each change of the operating mode or
 * the controller state, until `until` has held for `stableMs` in a row (0:
 * the first reading that meets it) or `timeoutMs` has passed. Never throws
 * for an unmet condition: the trail is the record.
 */
export async function followPanel(
  panel: () => Promise<PanelState>,
  opts: { until: (p: PanelState) => boolean; timeoutMs: number; stableMs?: number; pollMs?: number },
): Promise<PanelTrail> {
  const t0 = Date.now();
  const pollMs = opts.pollMs ?? 200;
  const stableMs = opts.stableMs ?? 0;
  const seen: PanelStep[] = [];
  let last: PanelState = { opmode: null, ctrlstate: null, speedRatio: null, execstate: null };
  let heldSince: number | null = null;
  for (;;) {
    try { last = await panel(); } catch { /* a failed read counts as not met */ }
    const now = Date.now();
    const prev = seen[seen.length - 1];
    if (!prev || prev.opmode !== last.opmode || prev.ctrlstate !== last.ctrlstate) {
      seen.push({ atMs: now - t0, opmode: last.opmode, ctrlstate: last.ctrlstate });
    }
    if (opts.until(last)) {
      heldSince ??= now;
      if (now - heldSince >= stableMs) { return { seen, last, met: true, ms: now - t0 }; }
    } else {
      heldSince = null;
    }
    if (now - t0 >= opts.timeoutMs) { return { seen, last, met: false, ms: now - t0 }; }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

/** What a test engaged on the simulated panel; `releaseSimPanel` lets go of it. */
export interface SimEngaged {
  enableSwitch: boolean;
  emergencyStop: boolean;
  generalStop: boolean;
  autoStop: boolean;
}

export const nothingEngaged = (): SimEngaged => ({ enableSwitch: false, emergencyStop: false, generalStop: false, autoStop: false });

/**
 * Release what `engaged` says is engaged, in the safe order (enable switch
 * first, then the stops), each through the manager, clearing each flag that
 * was released. Never throws: the steps are returned for the trace.
 */
export async function releaseSimPanel(m: RobotManager, engaged: SimEngaged): Promise<Array<{ step: string; ok: boolean; detail?: unknown }>> {
  const steps: Array<{ step: string; ok: boolean; detail?: unknown }> = [];
  const run = async (step: string, flag: keyof SimEngaged, fn: () => Promise<void>): Promise<void> => {
    if (!engaged[flag]) { return; }
    try { await fn(); engaged[flag] = false; steps.push({ step, ok: true }); } catch (e) {
      steps.push({ step, ok: false, detail: describeError(e) });
    }
  };
  await run('enable switch released', 'enableSwitch', () => m.simEnableSwitch(false));
  await run('emergency stop released', 'emergencyStop', () => m.simResetEmergencyStop());
  await run('general stop released', 'generalStop', () => m.simGeneralStop(false));
  await run('auto stop released', 'autoStop', () => m.simAutoStop(false));
  return steps;
}

/**
 * A panel read of the operating mode only (one request; the other fields
 * null), through the harness's observer: for a long `followPanel` wait at a
 * slow poll, where the four reads of `ctx.panel()` would load the controller
 * for nothing.
 */
export function opmodeOnly(ctx: FunctionalContext): () => Promise<PanelState> {
  return async () => ({ opmode: await (await ctx.observer()).getOperationMode(), ctrlstate: null, speedRatio: null, execstate: null });
}

/**
 * Ask the person at the virtual FlexPendant to do something now: a note in
 * the lane's trace and a line on the console, which the runner shows as the
 * test runs. Only the manual-mode tests call it, under
 * RWS_FUNCTIONAL_ALLOW_MANUAL, which says someone is there.
 */
export function askAtPendant(ctx: FunctionalContext, what: string): void {
  ctx.note(`asked at the FlexPendant: ${what}`);
  console.warn(`\n>>> ${ctx.fileTag}/${ctx.lane} (RobotWare ${ctx.rwVersion}), at the virtual FlexPendant: ${what}\n`);
}

/** Joints straight from the controller (the harness's observer), never the manager's cache. */
export async function readJointsNow(ctx: FunctionalContext): Promise<JointTarget> {
  return (await ctx.observer()).getJointPositions();
}

/** How long `teleportBack` waits for a teleport's guard stop to clear, ms (RobotWare 7: about 5 s). */
const TELEPORT_GUARD_STOP_MS = 30_000;
/** The state after that guard stop counts as at rest when it holds this long, ms. */
const TELEPORT_REST_HOLD_MS = 2_000;

/** How the controller state came to rest after `teleportBack`'s teleport (see there). */
export interface TeleportRest { seen: PanelStep[]; met: boolean; ms: number }

/**
 * Put the robot back at `start` with the teleport (virtual controllers only;
 * the caller checked `vc-sim`): nothing when it is within `tolDeg` already.
 * Stops RAPID first if it runs. Refuses (throws) a difference outside the
 * suite's motion limits, and throws unless the joints read back within
 * `tolDeg`.
 *
 * After a teleport in Auto, RobotWare 7 reads guard stop 0.25 to 0.45 s later
 * and rests in motors off 4.4 to 5.2 s after the teleport, whether the motors
 * were on or off (RW 7.21.0 and 7.21.4, 2026-09-30 to 2026-10-22). A motors on sent
 * inside that guard stop is refused: on 2026-10-22 the restore after a
 * deferred teleport back sent it 2.1 s later and got 403 SYS_CTRL_E_REJECT.
 * So there it then reads the panel, nothing else, until the controller state
 * reads something other than guard stop for TELEPORT_REST_HOLD_MS in a row
 * (the hold also covers a guard stop that shows only after the first
 * reading), at most TELEPORT_GUARD_STOP_MS, and puts the trail in the trace
 * and in `rest`. It never throws for that: a guard stop that does not clear
 * is the controller's state, which the restore after it reads again and
 * reports, never sends anything against. Also from a guard stop already
 * there: a teleport that failed after it acted (its answer lost, or the
 * joints read late) leaves this one starting inside the first one's guard
 * stop. Not on RobotWare 8, where guard stop is the rest state in Auto
 * (awaiting a Reset), nor outside Auto (nothing on record for that).
 */
export async function teleportBack(
  ctx: FunctionalContext, start: JointTarget, tolDeg = 0.1,
): Promise<{ moved: boolean; from: number[]; after: number[]; rest?: TeleportRest }> {
  const m = await ctx.ensureManager();
  let before = await ctx.panel();
  if (before.execstate === 'running') {
    await m.stopRapid();
    const stopped = await followPanel(() => ctx.panel(), { until: p => p.execstate === 'stopped', timeoutMs: 15_000 });
    if (!stopped.met) { throw new Error('RAPID did not stop within 15 s; the robot was not teleported back'); }
    before = stopped.last;
  }
  const d = jointDeltas(start, await readJointsNow(ctx));
  if (maxAbs(d) <= tolDeg) { return { moved: false, from: round3(d), after: round3(d) }; }
  if (!withinMotionLimits(d)) {
    throw new Error(`the robot is ${JSON.stringify(round3(d))} deg from its start joints, outside the motion limits - not teleported back`);
  }
  await m.teleportMechunit(ctx.mechunit, teleportJoints(start));
  let after = d;
  const t0 = Date.now();
  while (Date.now() - t0 < 5_000) {
    after = jointDeltas(start, await readJointsNow(ctx));
    if (maxAbs(after) <= tolDeg) { break; }
    await new Promise(r => setTimeout(r, 200));
  }
  // Waited out before the joints are judged, so a caller that goes on after
  // a throw (the harness runs the restore after a failed deferred step) does
  // not meet the guard stop either.
  const rest = await waitOutTeleportGuardStop(ctx, before);
  if (maxAbs(after) > tolDeg) {
    throw new Error(`after the teleport the robot reads ${JSON.stringify(round3(after))} deg from its start joints`);
  }
  return { moved: true, from: round3(d), after: round3(after), ...(rest ? { rest } : {}) };
}

/** `teleportBack`'s wait for a teleport's guard stop to clear (RobotWare 7 in Auto); null when it does not apply. */
async function waitOutTeleportGuardStop(ctx: FunctionalContext, before: PanelState): Promise<TeleportRest | null> {
  if (ctx.generation !== 'rws2' || ctx.lane === 'rw8' || before.opmode !== 'AUTO') { return null; }
  const trail = await followPanel(() => ctx.panel(), {
    until: p => p.ctrlstate !== null && p.ctrlstate !== 'guardstop',
    stableMs: TELEPORT_REST_HOLD_MS, timeoutMs: TELEPORT_GUARD_STOP_MS, pollMs: 500,
  });
  const rest: TeleportRest = { seen: trail.seen, met: trail.met, ms: trail.ms };
  ctx.note(trail.met
    ? 'teleport back: the controller state at rest'
    : `teleport back: the controller state still read guard stop after ${TELEPORT_GUARD_STOP_MS / 1000} s`, rest);
  return rest;
}
