/**
 * Functional: the virtual controller's simulated panel and the
 * mechanical-unit teleport, through RobotManager, each step asserted on what
 * the controller reads back afterwards, not only on the call returning.
 *
 * ABB's RWS 2.0 virtual controllers serve simulation endpoints that stand in
 * for a person's hands at the cell: the enable switch (direct polarity), the
 * emergency, general and auto stop (inverted polarity: `state=off` engages)
 * and a teleport of a mechanical unit to given joints. They exist only on
 * virtual controllers; the client product never depends on them. Every test
 * here runs only when the lane is RWS 2.0 and the controller identifies
 * itself as a virtual controller (guard kind `vc-sim`), and releases what it
 * engaged before it ends (with a deferred backstop).
 *
 * - Emergency stop: the controller and the manager's state read
 *   `emergencystop`; after the reset the controller rests where the build
 *   puts it: motors off on RobotWare 7, guard stop awaiting a Reset on
 *   RobotWare 8.
 * - General stop and auto stop, in Auto: guard stop while engaged, the rest
 *   state again once released (RW 7.21.4+417, 2026-09-30 and 2026-10-03; on
 *   RobotWare 8 the rest state is guard stop already). RW 7.21.0+229
 *   (2026-10-03, twice): the general stop's `state=off` answered 204 but the
 *   controller read motors off for the full 10 s, and the release
 *   (`state=on`, 204) left it in motors off. Whether that build takes the
 *   opposite polarity is not settled, so on a RobotWare 7 build other than
 *   7.21.4 the engaged state is recorded, not asserted; the rest state after
 *   the release still is.
 * - The enable switch in Auto: pressed and released, with the operating mode
 *   and the controller state read throughout (the enabling device belongs to
 *   manual mode, so nothing should change).
 * - Teleport: axis 6 moved by a few degrees from the current joints (inside
 *   the suite's motion limits), read back, teleported back to the start
 *   joints, read back; after each teleport the operating mode and the
 *   controller state come to rest by themselves where the build puts them.
 *   RobotWare 7 passes through a guard stop and rests in motors off about 5 s
 *   later, whether the motors were on or off before; when they were on, the
 *   test switches them on again after each teleport. RW 8.2.1 does not
 *   change. A failure half way still teleports the robot back before the
 *   test ends, so the last test finds it at its baseline joints.
 * - RobotWare 6 (RWS 1.0): RobotManager refuses every simulation call as
 *   UNSUPPORTED_OPERATION before anything is sent; the rest of the lane skips
 *   (RWS 1.0 has no simulation endpoints).
 *
 * RobotWare 8 in motors on: the stop, enable-switch and teleport tests skip,
 * since the motors came on with a Reset at the pendant that a simulated stop
 * would undo, and nothing on record shows the other two leave it alone.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import type { JointTarget, RobotManager } from '../../src/index.js';
import {
  forEachController, expectRwsError, traceFile, waitUntil, diffSnapshots,
  describeError, followPanel, jointDeltas, maxAbs, round3, nothingEngaged, readJointsNow, releaseSimPanel,
  teleportBack, teleportJoints, MOTION_LIMITS,
  type FunctionalContext, type PanelState, type SimEngaged, type TestHandle, type TraceLine,
} from './helpers/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Where the controller rests in Auto once a simulated stop is released, before anyone switches the motors on. */
const REST_AFTER_STOP: Readonly<Record<'rw7' | 'rw8', string>> = {
  // Live-verified 2026-07-09 on an RW 7.21 virtual controller (doc comments of the client's sim methods).
  rw7: 'motoroff',
  // RobotWare 8: motion restarts only after a Reset (ABB, "Changed features in RobotWare 8", About Reset).
  rw8: 'guardstop',
};
/** How long a stop may take to show in the controller state, ms. */
const STATE_TIMEOUT_MS = 10_000;
/** A released stop counts as settled when the controller state stays the same this long, ms. */
const SETTLE_MS = 2_000;
/** Teleport read-back tolerance, degrees (the readback may show sub-microdegree rounding). */
const TELEPORT_TOL_DEG = 0.01;
/** How far the teleport moves axis 6, degrees (inside the suite's wrist limit). */
const TELEPORT_AXIS6_DEG = 5;
/**
 * How long the state may take to come to rest by itself after a teleport, ms.
 * RobotWare 7 reads guard stop 0.25 to 0.45 s after it and motors off 4.4 to
 * 5.2 s after it, both counted from the teleport (every recorded run, RW
 * 7.21.0 and 7.21.4), then holds SETTLE_MS; 30 s lets a wrong expectation fail in half a minute, not in the
 * five minutes the 300 s here took until 2026-10-22.
 */
const TELEPORT_SETTLE_MS = 30_000;
/** How long the motors may take to read on after a motors on, ms. */
const MOTORS_ON_MS = 10_000;
/**
 * Timeout of the teleport test: two settles, two motors on, the moves, the
 * teleport back in the finally (it waits out its own guard stop, up to a
 * settle) and the restore.
 */
const TELEPORT_TEST_MS = 3 * TELEPORT_SETTLE_MS + 2 * MOTORS_ON_MS + 120_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

let markerSeq = 0;
function mark(ctx: FunctionalContext, label: string): string {
  const m = `14-vc-sim-panel marker ${++markerSeq} ${label} ${Date.now()}`;
  ctx.note(m);
  return m;
}

/** HTTP requests in the lane's trace after `marker`. */
function requestsAfter(ctx: FunctionalContext, marker: string): Array<{ method?: string; path?: string }> {
  const lines = fs.readFileSync(traceFile(ctx.lane), 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l) as TraceLine; } catch { return null; } })
    .filter((l): l is TraceLine => l !== null);
  const from = lines.findIndex(l => l.level === 'test' && l.msg === marker);
  expect(from, `marker "${marker}" in the ${ctx.lane} trace`).toBeGreaterThanOrEqual(0);
  return lines.slice(from + 1)
    .filter(l => l.cat === 'http.req')
    .map(l => (l.data ?? {}) as { method?: string; path?: string });
}

/** The lane's rest state after a released stop (RWS 2.0 lanes only). */
function restState(ctx: FunctionalContext): string {
  return REST_AFTER_STOP[ctx.lane as 'rw7' | 'rw8'];
}

/**
 * Where the controller state rests by itself in Auto after a teleport (RWS
 * 2.0 lanes only). RobotWare 7: motors off, whatever it read before. Every
 * run up to 2026-10-17 teleported from motors off, so motors off looked like
 * "back to where it was"; the full test of 2026-10-22 was the first to start
 * from motors on (RW 7.21.4) and read the same guard stop (437 ms) and motors
 * off (4440 ms), which then held: nothing switches the motors on by itself.
 * RobotWare 8: what it read before (guard stop awaiting a Reset; every
 * recorded teleport there showed no change, and motors on skips).
 */
function restAfterTeleport(ctx: FunctionalContext, before: PanelState): string | null {
  return ctx.lane === 'rw7' ? 'motoroff' : before.ctrlstate;
}

/**
 * Whether a simulated general or auto stop, engaged from motors off in Auto,
 * is known to read guard stop on this build: RW 7.21.4 (2026-09-30 and
 * 2026-10-03), and RobotWare 8, which rests in guard stop in Auto anyway. On
 * RW 7.21.0+229 it read motors off throughout (2026-10-03), polarity not
 * settled; other RobotWare 7 builds are not on record.
 */
function stopShowsGuardStop(ctx: FunctionalContext): boolean {
  return ctx.lane === 'rw8' || ctx.rwVersion.split('+')[0].trim() === '7.21.4';
}

/**
 * The checks every simulated-panel test starts with: an RWS 2.0 lane whose
 * controller identifies as virtual (else skipped with the reason), Auto, RAPID
 * stopped. Returns the panel as read.
 */
async function preflight(ctx: FunctionalContext, t: TestHandle): Promise<PanelState> {
  await ctx.requireAllowed(t, 'vc-sim');
  await ctx.ensureManager();
  const p = await ctx.panel();
  if (p.opmode !== 'AUTO') { ctx.skip(t, `the simulated-panel tests start from Auto; the controller reads ${p.opmode}`); }
  if (p.execstate === 'running') { throw new Error('RAPID is running - the simulated-panel tests need it stopped'); }
  return p;
}

/**
 * RobotWare 8 with the motors on: they came on with a Reset at the pendant,
 * which only a person can give again. A simulated stop would undo it, and
 * nothing on record shows that the enable switch in Auto or a teleport
 * leaves it alone, so those skip too.
 */
function skipIfRw8MotorsOn(ctx: FunctionalContext, t: TestHandle, p: PanelState, what: string): void {
  if (ctx.lane === 'rw8' && p.ctrlstate === 'motoron') {
    ctx.skip(t, `the RW8 motors are on from a Reset at the pendant; ${what} could need another Reset there`);
  }
}

/** Wait until the manager's cached controller state reads `want` (it polls, and follows the controller's events). */
async function managerFollows(m: RobotManager, want: string): Promise<void> {
  await waitUntil(() => m.state.ctrlstate === want, 15_000, 250, `manager ctrlstate ${want}`);
}

/**
 * Engage, release and read back one simulated stop. The trails go into `out`
 * as they are read, so the note keeps them when an expectation fails. With
 * `assertEngaged` false the engaged state is recorded only (the operating
 * mode must still read Auto); the rest state after the release is asserted
 * either way.
 */
async function stopCycle(
  ctx: FunctionalContext, name: 'general stop' | 'auto stop', flag: 'generalStop' | 'autoStop',
  send: (engage: boolean) => Promise<void>, engaged: SimEngaged,
  out: Record<string, unknown>, assertEngaged: boolean,
): Promise<void> {
  const m = ctx.manager;
  engaged[flag] = true;
  await send(true);
  const on = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate === 'guardstop', timeoutMs: STATE_TIMEOUT_MS });
  out.engagedTrail = on.seen;
  expect(on.last.opmode, `${name} engaged: the operating mode`).toBe('AUTO');
  if (assertEngaged) {
    expect(on.last.ctrlstate, `${name} engaged: the controller state (${JSON.stringify(on.seen)})`).toBe('guardstop');
    await managerFollows(m, 'guardstop');
  } else {
    out.engagedReadGuardStop = on.met;
  }

  await send(false);
  engaged[flag] = false;
  const rest = restState(ctx);
  const off = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate === rest, stableMs: SETTLE_MS, timeoutMs: STATE_TIMEOUT_MS + SETTLE_MS });
  out.releasedTrail = off.seen;
  expect(off.last.ctrlstate, `${name} released: the controller state (${JSON.stringify(off.seen)})`).toBe(rest);
  await managerFollows(m, rest);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

await forEachController('14-vc-sim-panel', ctx => {
  it('RWS 1.0: RobotManager refuses every simulation call as UNSUPPORTED_OPERATION before anything is sent, and nothing changes', async t => {
    if (ctx.generation !== 'rws1') { ctx.skip(t, 'RWS 2.0 lane: the simulation endpoints are exercised by the tests below'); }
    const m = await ctx.ensureManager();
    const before = await ctx.panel();
    const joints = await readJointsNow(ctx);
    const calls: Array<[string, () => Promise<void>]> = [
      ['simEmergencyStop', () => m.simEmergencyStop()],
      ['simResetEmergencyStop', () => m.simResetEmergencyStop()],
      ['simGeneralStop', () => m.simGeneralStop(true)],
      ['simAutoStop', () => m.simAutoStop(true)],
      ['simEnableSwitch', () => m.simEnableSwitch(true)],
      ['teleportMechunit', () => m.teleportMechunit(ctx.mechunit, teleportJoints(joints))],
    ];
    const marker = mark(ctx, 'simulation calls on RWS 1.0');
    const seen: Record<string, unknown> = {};
    for (const [name, call] of calls) {
      const err = await expectRwsError(call);
      seen[name] = describeError(err);
      expect(err.code, name).toBe('UNSUPPORTED_OPERATION');
      expect(err.message, name).toMatch(/RWS 1\.0 has no simulation endpoints/);
    }
    ctx.note('simulation calls refused on RWS 1.0', seen);
    const simPosts = requestsAfter(ctx, marker)
      .filter(r => r.method === 'POST' && /\/rw\/panel|\/mechunits\/[^/]+\/position/i.test(r.path ?? ''));
    expect(simPosts, 'no panel or teleport POST sent').toEqual([]);
    const after = await ctx.panel();
    expect(after.opmode).toBe(before.opmode);
    expect(after.ctrlstate).toBe(before.ctrlstate);
    expect(maxAbs(jointDeltas(joints, await readJointsNow(ctx)))).toBeLessThan(0.001);
  });

  it('engages the simulated emergency stop: the controller and the manager read emergencystop; after the reset the controller rests in motors off (RW7) or in guard stop awaiting a Reset (RW8)', async t => {
    const p0 = await preflight(ctx, t);
    skipIfRw8MotorsOn(ctx, t, p0, 'a simulated stop');
    const m = ctx.manager;
    const engaged = nothingEngaged();
    ctx.defer('simulated emergency stop released', async () => releaseSimPanel(await ctx.ensureManager(), engaged));
    const record: Record<string, unknown> = { before: p0 };
    try {
      engaged.emergencyStop = true;
      await m.simEmergencyStop();
      const on = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate === 'emergencystop', timeoutMs: STATE_TIMEOUT_MS });
      record.engagedTrail = on.seen;
      expect(on.last.ctrlstate, `the controller state after the emergency stop (${JSON.stringify(on.seen)})`).toBe('emergencystop');
      expect(on.last.opmode).toBe('AUTO');
      await managerFollows(m, 'emergencystop');

      await m.simResetEmergencyStop();
      engaged.emergencyStop = false;
      const rest = restState(ctx);
      const off = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate === rest, stableMs: SETTLE_MS, timeoutMs: STATE_TIMEOUT_MS + SETTLE_MS });
      record.resetTrail = off.seen;
      expect(off.last.ctrlstate, `the controller state after the reset (${JSON.stringify(off.seen)})`).toBe(rest);
      await managerFollows(m, rest);
    } finally {
      record.release = await releaseSimPanel(m, engaged);
      ctx.note('simulated emergency stop', record);
    }
    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
  });

  // RWS 1.0 skips the test (no simulation endpoints); it keeps the asserting title.
  const assertEngaged = ctx.generation === 'rws1' || stopShowsGuardStop(ctx);
  it(assertEngaged
    ? 'engages and releases the simulated general stop and auto stop in Auto: guard stop while engaged, the rest state once released, the manager following'
    : `records the simulated general stop and auto stop in Auto on RW ${ctx.rwVersion} (the engaged state is not settled there); the rest state once released, the manager following`,
  async t => {
    const p0 = await preflight(ctx, t);
    skipIfRw8MotorsOn(ctx, t, p0, 'a simulated stop');
    const m = ctx.manager;
    const engaged = nothingEngaged();
    ctx.defer('simulated general and auto stop released', async () => releaseSimPanel(await ctx.ensureManager(), engaged));
    const generalStop: Record<string, unknown> = {};
    const autoStop: Record<string, unknown> = {};
    const record: Record<string, unknown> = { before: p0, rwVersion: ctx.rwVersion, assertEngaged, generalStop, autoStop };
    try {
      await stopCycle(ctx, 'general stop', 'generalStop', e => m.simGeneralStop(e), engaged, generalStop, assertEngaged);
      await stopCycle(ctx, 'auto stop', 'autoStop', e => m.simAutoStop(e), engaged, autoStop, assertEngaged);
    } finally {
      record.release = await releaseSimPanel(m, engaged);
      ctx.note('simulated general and auto stop', record);
    }
    if (ctx.lane === 'rw8') {
      // RobotWare 8 already rests in guard stop in Auto, so the controller
      // state cannot tell an engaged stop from the pending Reset; recorded.
      ctx.note('RW8: guard stop before, during and after both stops (the state does not tell them apart)');
    }
    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
  });

  it('presses and releases the simulated enable switch in Auto: the operating mode and the controller state do not change', async t => {
    const p0 = await preflight(ctx, t);
    skipIfRw8MotorsOn(ctx, t, p0, 'the enable switch in Auto');
    const m = ctx.manager;
    const engaged = nothingEngaged();
    ctx.defer('simulated enable switch released', async () => releaseSimPanel(await ctx.ensureManager(), engaged));
    const record: Record<string, unknown> = { before: p0 };
    // A reading that failed (null) says nothing either way; at least one must have succeeded.
    const read = (p: { opmode: string | null; ctrlstate: string | null }): boolean => p.opmode !== null && p.ctrlstate !== null;
    const unchanged = (p: { opmode: string | null; ctrlstate: string | null }): boolean => !read(p) || (p.opmode === p0.opmode && p.ctrlstate === p0.ctrlstate);
    try {
      engaged.enableSwitch = true;
      await m.simEnableSwitch(true);
      // Read for 3 s: every reading must match the one before the press.
      const held = await followPanel(() => ctx.panel(), { until: () => false, timeoutMs: 3_000 });
      record.heldTrail = held.seen;
      await m.simEnableSwitch(false);
      engaged.enableSwitch = false;
      const released = await followPanel(() => ctx.panel(), { until: () => false, timeoutMs: 2_000 });
      record.releasedTrail = released.seen;
      expect(held.seen.some(read) && released.seen.some(read), 'the panel was read while pressed and after the release').toBe(true);
      expect(held.seen.every(unchanged), `readings with the switch pressed (${JSON.stringify(held.seen)})`).toBe(true);
      expect(released.seen.every(unchanged), `readings after the release (${JSON.stringify(released.seen)})`).toBe(true);
    } finally {
      record.release = await releaseSimPanel(m, engaged);
      ctx.note('simulated enable switch in Auto', record);
    }
    expect(m.state.ctrlstate).toBe(p0.ctrlstate);
    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
  });

  it(`teleports the robot: axis 6 moved ${TELEPORT_AXIS6_DEG} degrees from the current joints reads back there with no other axis moved, and the teleport back reads the start joints again`, async t => {
    const p0 = await preflight(ctx, t);
    skipIfRw8MotorsOn(ctx, t, p0, 'a teleport');
    // RobotWare 7 drops the motors with every teleport (below). When they were
    // on, the test switches them on again after each teleport, so the guard
    // for that is checked before anything is sent.
    const motorsBackOn = ctx.lane === 'rw7' && p0.ctrlstate === 'motoron';
    if (motorsBackOn) { await ctx.requireAllowed(t, 'motors'); }
    const m = ctx.manager;
    expect(TELEPORT_AXIS6_DEG).toBeLessThanOrEqual(MOTION_LIMITS.wristMaxDeg);
    const start = await readJointsNow(ctx);
    ctx.defer('robot teleported back to its start joints', () => teleportBack(ctx, start));
    const offset = start.rax_6 > 0 ? -TELEPORT_AXIS6_DEG : TELEPORT_AXIS6_DEG;
    const target: JointTarget = { ...start, rax_6: start.rax_6 + offset };
    const rest = restAfterTeleport(ctx, p0);
    const record: Record<string, unknown> = { start, offset, before: p0, rest, motorsBackOn };
    // After each teleport the operating mode and the controller state must
    // come to rest by themselves (nothing but reads is sent) where the build
    // puts them, and hold there. RW 8.2.1 does not change at all. RobotWare 7
    // goes to guard stop 0.25 to 0.45 s after a teleport in Auto and rests in
    // motors off by itself 4.4 to 5.2 s after the teleport (RW 7.21.0 and
    // 7.21.4, 2026-09-30 to 2026-10-17 from motors off, 2026-10-22 from motors
    // on), like its guard stop after a warm restart. The guard stop is
    // asserted there, and the rest counts only once it was read, so an early
    // motors-off reading before it shows does not end the wait.
    const throughGuardStop = ctx.lane === 'rw7';
    const panelAtRest = async (label: string): Promise<void> => {
      const guard = { seen: false };
      const atRest = (p: PanelState): boolean => {
        if (p.ctrlstate === 'guardstop') { guard.seen = true; }
        return p.opmode === p0.opmode && p.ctrlstate === rest && (guard.seen || !throughGuardStop);
      };
      const trail = await followPanel(() => ctx.panel(), { until: atRest, stableMs: SETTLE_MS, timeoutMs: TELEPORT_SETTLE_MS, pollMs: 500 });
      record[label] = { seen: trail.seen, settled: trail.met, ms: trail.ms, sawGuardStop: guard.seen };
      if (throughGuardStop) {
        expect(guard.seen, `${label}: RobotWare 7 passes through guard stop after a teleport in Auto: ${JSON.stringify(trail.seen)}`).toBe(true);
      }
      expect(trail.met, `${label}: the mode and controller state did not come to rest at ${p0.opmode}/${rest} within `
        + `${TELEPORT_SETTLE_MS / 1000} s: ${JSON.stringify(trail.seen)}`).toBe(true);
    };
    // RobotWare 7 from motors on: motors on over RWS was accepted from the
    // motors off a teleport leaves long after its guard stop had cleared (RW
    // 7.21.4, 2026-10-22, twice: minutes later); sent inside the guard stop it
    // is refused (403 SYS_CTRL_E_REJECT), which is why it comes after the
    // rest. Here it goes out once motors off has held SETTLE_MS, a spacing
    // not yet run on a controller; if RobotWare 7 refuses it there, the test
    // fails with that error and the finally still puts the joints back.
    const motorsOnAgain = async (label: string): Promise<void> => {
      if (!motorsBackOn) { return; }
      await m.setMotorsOn();
      const on = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate === 'motoron', timeoutMs: MOTORS_ON_MS, pollMs: 250 });
      record[label] = { seen: on.seen, met: on.met, ms: on.ms };
      expect(on.met, `${label}: the motors did not read on within ${MOTORS_ON_MS / 1000} s: ${JSON.stringify(on.seen)}`).toBe(true);
    };

    try {
      await m.teleportMechunit(ctx.mechunit, teleportJoints(target));
      let d: number[] = [];
      await waitUntil(async () => {
        d = jointDeltas(target, await readJointsNow(ctx));
        return maxAbs(d) <= TELEPORT_TOL_DEG;
      }, 5_000, 200, 'joints read at the teleport target');
      record.atTargetDeltaDeg = round3(d);
      await panelAtRest('panelAfterTeleport');
      await motorsOnAgain('motorsOnAfterTeleport');
      const moved = jointDeltas(start, await readJointsNow(ctx));
      expect(moved[5], 'axis 6 moved by the offset').toBeCloseTo(offset, 2);
      expect(maxAbs(moved.slice(0, 5)), 'no other axis moved').toBeLessThanOrEqual(TELEPORT_TOL_DEG);
      await waitUntil(async () => {
        await m.refresh();
        return !!m.state.joints && Math.abs(m.state.joints.rax_6 - target.rax_6) <= TELEPORT_TOL_DEG;
      }, 10_000, 250, 'manager joints follow the teleport');

      await m.teleportMechunit(ctx.mechunit, teleportJoints(start));
      await waitUntil(async () => {
        d = jointDeltas(start, await readJointsNow(ctx));
        return maxAbs(d) <= TELEPORT_TOL_DEG;
      }, 5_000, 200, 'joints read back at the start');
      record.backDeltaDeg = round3(d);
      await panelAtRest('panelAfterTeleportBack');
      await motorsOnAgain('motorsOnAfterTeleportBack');
      await waitUntil(async () => {
        await m.refresh();
        return !!m.state.joints && maxAbs(jointDeltas(start, m.state.joints)) <= TELEPORT_TOL_DEG;
      }, 10_000, 250, 'manager joints follow the teleport back');
    } finally {
      // Back at the start joints whatever failed above, so the last test of
      // the file finds the robot where the baseline has it (on 2026-10-22 a
      // failed expectation left axis 6 at -5 degrees until afterAll). Nothing
      // is sent when the robot is there already; a teleport here waits out
      // its own guard stop (teleportBack), so the restore's motors on is not
      // sent inside it. The deferred step stays as the backstop.
      record.teleportBackInFinally = await teleportBack(ctx, start).catch(e => ({ failed: describeError(e) }));
      ctx.note('teleport out and back', record);
    }
    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
  }, TELEPORT_TEST_MS);

  it('leaves the controller as the baseline found it, the robot at its baseline joints', async t => {
    if (ctx.generation === 'rws1') {
      // Nothing was sent on this lane beyond reads; the refusal test above is its record.
      ctx.skip(t, 'RWS 1.0 has no simulation endpoints');
    }
    const report = await ctx.restore();
    ctx.note('final restore', { actions: report.actions, residual: report.residual });
    expect(report.residual).toEqual([]);
    const now = await ctx.snapshot();
    expect(now.errors).toEqual([]);
    expect(diffSnapshots(ctx.baseline, now)).toEqual([]);
    if (ctx.baseline.joints && now.joints) {
      expect(maxAbs(jointDeltas(ctx.baseline.joints, now.joints))).toBeLessThanOrEqual(0.1);
    }
  });
});

