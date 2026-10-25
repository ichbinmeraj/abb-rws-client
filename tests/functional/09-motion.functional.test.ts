/**
 * Functional: motion on a virtual controller, per controller.
 *
 * Through the client's own API (RobotManager first; the adapter only for the
 * direct reads the harness's observer makes):
 *
 * - Motors: off and on over RWS in Auto on RobotWare 6 and 7, followed by the
 *   manager's state, with no access left held. RobotWare 8 in guard stop: the
 *   documented refusal of motors on over RWS (the Reset is made at the
 *   controller), typed, with the write access released.
 * - Speed ratio: set to 50 and back; an out-of-range value refused before
 *   anything is sent.
 * - A ZZ_PROBE motion module built by the harness (MoveAbsJ relative to the
 *   joints the robot stands at, out and back, tool0, zone fine), run from its
 *   entry routine: the manager's state shows the joints and the robot target
 *   change while it runs, and the robot ends at its start joints within 0.1
 *   degree. A stop in the middle of a move stops the robot short of the
 *   target; a start from there finishes the cycle. RobotWare 8 refuses the
 *   start from a remote station without the station's motion-control
 *   declaration in that session, so these runs need, besides the motors on
 *   from the pendant, RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<the controller's
 *   system name>, set by a person at its virtual FlexPendant; the harness then
 *   allows motion control in the manager's session and withdraws it in
 *   afterAll (the client's disconnect withdraws it too), and without it the
 *   runs skip with the reason.
 * - A RAPID start with the motors off (program pointer set), refused and
 *   typed as a state refusal: 403 -1073445806 on RW 7.21.4, 400 -1073445881
 *   (org_code -4506) on RW 6.16.03 (both live-verified 2026-09-30).
 * - Mechanical-unit reads (type, axes, mode, task, base frame) and the
 *   motion-system change count.
 * - Inverse and forward kinematics: both must solve on the virtual
 *   controller on every build (live-verified 2026-09-30 on RW 6.16.03, 7.21.4
 *   and 8.2.1, once the client sent SI units and ABB's actions). Forward
 *   kinematics must solve for tool0/wobj0, the only pair the client sends; any
 *   other pair is refused before sending, as a typed error.
 * - Jogging in Auto: RobotManager reads the mode and the motors only to
 *   explain a refusal, so the jog is sent and the controller refuses it; the
 *   refusal is typed (WRONG_MODE, a wrong-mode or wrong-state refusal; on
 *   RobotWare 8 the motion-control code -1073435864 would be GRANT_DENIED,
 *   motion-control-off) and nothing moves. In manual reduced speed
 *   only when RWS_FUNCTIONAL_ALLOW_MANUAL lists the lane, which says someone
 *   is at the virtual FlexPendant: on RWS 2.0 virtual controllers the
 *   simulated enable switch stands in for the person's enabling device, the
 *   jog goes through RobotManager's pre-flight (RMMP and motion mastership on
 *   RobotWare 7, control-station write access on RobotWare 8), and the joints
 *   are read back from the controller: axis 1 moves in the jog's direction
 *   and no other axis moves. RobotWare 7: the RMMP request waits for the
 *   person to press Grant (the virtual controller does not grant it itself);
 *   without the grant the controller's refusal is recorded. RobotWare 6 has no
 *   enable-switch endpoint; its lane records the refusals.
 * - RobotWare 8 program motion in manual reduced speed, with the simulated
 *   enable switch held (the RobotWare 8 virtual controller has no
 *   hold-to-run), under the same opt-in.
 * - The way back: the switch from MANR to Auto over RWS waits in AUTO_CH
 *   until the person confirms it at the FlexPendant (RW 7.21.4 and 8.2.1,
 *   live-verified 2026-09-30); the test asks for it on the console, waits,
 *   and does not send the confirmation.
 * - A pendant session (RWS_FUNCTIONAL_PENDANT=1, `npm run functional:pendant`,
 *   the owner at the pendants): RobotWare 7 keeps the RMMP request alive up
 *   to 90 s while asking "Press Grant on the RW7 pendant"; the way back asks
 *   "Confirm Auto on the <lane> pendant" and waits until the mode reads AUTO;
 *   RobotWare 6, which takes no mode change over RWS, asks for the key switch
 *   to manual (waiting for MANR) and back to Auto.
 * - RobotWare 8 leaves Auto only when this user holds the 8.2 grant "Allow
 *   remote access in manual mode" (read from the held-grant list; without it
 *   the station takes no write access in manual mode, so neither the jog nor
 *   the switch back to Auto could be sent) and the motors are not on (a mode
 *   change would undo the Reset given at the pendant). The grant does not
 *   cover the confirmation of the switch back to Auto, and while that waits
 *   no remote station can take write access (RW 8.2.1, 2026-09-30). So the
 *   station's motion-control declaration the test makes is put back while
 *   still in MANR, before the switch back, with a deferred backstop and the
 *   harness restore behind it.
 *
 * The simulated panel and the teleport are sent only when the lane's
 * controller identifies as a virtual controller (guard kind `vc-sim`).
 *
 * Safety: motion only through the harness's limits (axis 1 at most 5 degrees,
 * axes 4 and 6 at most 10, v20 or slower here, speed ratio 50 or less, fine,
 * tool0), never a Cartesian target. Every motion test registers a step that
 * puts the robot back at its start joints, and the harness restores the rest
 * (RAPID stopped, ZZ_PROBE modules unloaded and deleted, program pointer,
 * execution cycle, speed ratio, operation mode, motors).
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import {
  RwsError,
  type CartesianFull, type JogParams, type JointTarget, type RobTarget, type RobotManager,
} from '../../src/index.js';
import {
  forEachController, expectRwsError, assertSafeJog, diffSnapshots, traceFile, waitFor, waitUntil,
  zzExecModule, zzMotionModule, MOTION_LIMITS,
  describeError, jointDeltas, maxAbs, round3, withinMotionLimits, managerRws2, followPanel,
  nothingEngaged, releaseSimPanel, teleportBack, releaseHolds, askAtPendant, opmodeOnly, isPendingModeChange,
  pendantSession, waitForPerson, PERSON_WAIT_MS,
  type FunctionalContext, type PersonWait, type GeneratedModule, type PanelState, type PanelStep, type SimEngaged, type TestHandle, type TraceLine,
} from './helpers/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** How close (degrees) the robot must come back to its start joints. */
const BACK_AT_START_DEG = 0.1;
/** A joint difference (degrees) that counts as "the robot moved". */
const MOVED_DEG = 0.1;
/**
 * A generated routine's run is followed while it makes progress (see
 * `followRoutine`): RAPID reads running and the loop counter or the joints
 * changed within the last RUN_STALL_MS, ms. A fixed budget (90 s until
 * 2026-10-22) could not tell a slow VC from a stopped run: in the full test of
 * 2026-10-22 the RW 6.16.03 VC, short of CPU, took about 95 s for the
 * out-and-back routine that takes 19 to 25 s on a quiet PC (its start was
 * answered after 4.6 s, normally 57 to 453 ms), and the wait ran out about
 * 5 s before the routine ended by itself.
 */
const RUN_STALL_MS = 20_000;
/** Longest a generated motion routine is followed however it progresses, ms. */
const RUN_CAP_MS = 240_000;
/**
 * The same for the return move (one MoveAbsJ, a few seconds on a quiet PC),
 * ms. It runs as a deferred step in afterAll, which shares its hook timeout
 * (LANE_HOOK_TIMEOUT_MS, 180 s) with the other deferred steps and the restore.
 */
const RETURN_CAP_MS = 75_000;
/**
 * RAPID must read not running this long in a row, ms, before a run counts as
 * stopped short of its end: the routine sets `done` just before it ends, so a
 * single round can read done = 0 and then stopped.
 */
const RUN_STOPPED_MS = 3_000;
/** A joint change (degrees) since the last progress that counts as progress. */
const PROGRESS_DEG = 0.01;
/** Per-test timeout for the tests that move the robot: a run followed up to the cap, and the rest of the test. */
const MOTION_TEST_MS = RUN_CAP_MS + 120_000;
/**
 * The stop-and-restart test: a run followed up to the cap after the restart,
 * and its other bounded waits (preparing the motion, the axis moving 30 s,
 * the stop 15 s, two settles, the manager reading stopped 15 s, the restore),
 * about 145 s, so the follow reports before vitest's timeout does.
 */
const STOP_RESTART_TEST_MS = RUN_CAP_MS + 180_000;

const AXES = [1, 2, 3, 4, 5, 6] as const;
const rax = (i: number): keyof JointTarget => `rax_${i}` as keyof JointTarget;

/**
 * RWS_FUNCTIONAL_PENDANT=1 (`npm run functional:pendant`): the owner sits at
 * the virtual pendants and answers console prompts (waitForPerson). The RMMP
 * request is kept alive up to RMMP_GRANT_MS for the Grant, the switch back to
 * Auto waits up to PERSON_WAIT_MS for the confirmation, and on RobotWare 6,
 * which takes no mode change over RWS, the owner turns the key switch to
 * manual and back.
 */
const PENDANT = pendantSession();
/** Pendant session: how long the RMMP request waits for the Grant at the RW7 pendant. */
const RMMP_GRANT_MS = 90_000;
/** How long the way back waits for the person at the FlexPendant to confirm the switch to Auto (AUTO_CH). */
const PENDANT_CONFIRM_MS = PENDANT ? PERSON_WAIT_MS : 120_000;
/**
 * Per-test timeout of the manual-mode tests: mode switches, an RMMP wait of
 * up to 30 s (RMMP_GRANT_MS in a pendant session), jogs out and back, the
 * wait for the confirmation at the FlexPendant (PENDANT_CONFIRM_MS) and, in
 * the RobotWare 8 program run, the run followed up to RUN_CAP_MS. A pendant
 * session on RobotWare 6 waits twice for the key switch. (Until 2026-10-22
 * 720 s and 480 s, with the run's budget at 90 s.)
 */
const MANUAL_TEST_MS = (PENDANT ? 630_000 : 390_000) + RUN_CAP_MS;
/** A jog is seen when axis 1 reads at least this far (degrees) from the reading before it. */
const JOG_STEP_SEEN_DEG = 0.001;
/** Axis 1 must read at least this far (degrees) from the start after the jogs out. */
const JOG_MOVED_DEG = 0.005;
/** No other axis may move more than this (degrees) during the jogs. */
const JOG_OTHERS_DEG = 0.005;
/** Small increments never add up to this (degrees); a reading past it stops the test at once. */
const JOG_RUNAWAY_DEG = 1;
/** Most jogs sent out (and back, plus a few) in one direction. */
const MAX_JOGS = 10;

// ─── Small helpers ───────────────────────────────────────────────────────────

/** A step of `magnitude` toward zero from `value` (away from the nearer joint limit). */
function towardZero(value: number, magnitude: number): number {
  return value > 0 ? -magnitude : magnitude;
}

/** Position distance (mm) and largest quaternion component difference (sign-independent). */
function poseDelta(a: RobTarget, b: RobTarget): { mm: number; quat: number } {
  const mm = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const qa = [a.q1, a.q2, a.q3, a.q4];
  const qb = [b.q1, b.q2, b.q3, b.q4];
  const same = maxAbs(qa.map((v, i) => qb[i] - v));
  const flipped = maxAbs(qa.map((v, i) => qb[i] + v));
  return { mm, quat: Math.min(same, flipped) };
}

/** Codes that say the request never got an answer: not an answer about the operation. */
const TRANSPORT_CODES = ['NOT_CONNECTED', 'NETWORK_ERROR', 'SESSION_EXPIRED', 'CONTROLLER_BUSY', 'RATE_LIMITED'];

/** Locks this session still counts as held. */
function heldLocks(m: RobotManager): string[] {
  return (m.state.access?.locks ?? []).filter(l => l.state === 'held' && l.count > 0).map(l => `${l.lock} x${l.count}`);
}

async function readJoints(ctx: FunctionalContext): Promise<JointTarget> {
  return (await ctx.observer()).getJointPositions();
}

async function readNum(ctx: FunctionalContext, mod: GeneratedModule, role: string): Promise<number> {
  return Number(await ctx.manager.getRapidVariable(ctx.task, mod.name, mod.symbols[role]));
}

/** Two joint reads a moment apart that agree: the robot is standing still. */
async function settledJoints(ctx: FunctionalContext, timeoutMs = 10_000): Promise<JointTarget> {
  const seen: { last: JointTarget | null; settled: JointTarget | null } = { last: null, settled: null };
  const ok = await waitFor(async () => {
    const now = await readJoints(ctx);
    const still = seen.last !== null && maxAbs(jointDeltas(seen.last, now)) < 0.005;
    seen.last = now;
    if (still) { seen.settled = now; }
    return still;
  }, timeoutMs, 300);
  if (!ok || !seen.settled) { throw new Error(`the joints did not settle within ${timeoutMs} ms`); }
  return seen.settled;
}

/** Write a marker into the lane's trace and return it. */
let markerSeq = 0;
function mark(ctx: FunctionalContext, label: string): string {
  const m = `09-motion marker ${++markerSeq} ${label} ${Date.now()}`;
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

/**
 * Point the program at a generated module's entry routine, with the
 * execution cycle `once` so the run ends at the routine's end. The harness
 * puts the cycle and the program pointer back.
 */
async function pointAtEntry(ctx: FunctionalContext, mod: GeneratedModule): Promise<void> {
  const m = ctx.manager;
  const cycle = (await (await ctx.observer()).getRapidExecutionInfo()).cycle;
  if (cycle !== 'once') {
    ctx.note(`execution cycle ${cycle} -> once for the run`);
    await m.setExecutionCycle('once');
  }
  await m.setPPToRoutine(ctx.task, mod.name, mod.routines.entry);
  const pp = await m.getCurrentPP(ctx.task);
  expect(pp?.module?.toUpperCase(), 'program pointer module').toBe(mod.name.toUpperCase());
  expect(pp?.routine?.toLowerCase(), 'program pointer routine').toBe(mod.routines.entry.toLowerCase());
}

/**
 * Start RAPID. On RobotWare 8 a start needs more than the motors on: the
 * station's motion-control declaration, which prepareMotion makes under the
 * person's opt-in (guard kind `motion-control`). A refusal there is recorded
 * and the test skipped with it; on the other lanes it fails the test.
 */
async function startOrExplain(ctx: FunctionalContext, t: TestHandle): Promise<void> {
  try {
    await ctx.manager.startRapid();
  } catch (e) {
    ctx.note('RAPID start refused', describeError(e));
    if (ctx.lane === 'rw8' && e instanceof RwsError) {
      ctx.skip(t, `RobotWare 8 refused the RAPID start: ${e.code} ${e.controllerCode ?? ''} ${e.refusal?.kind ?? ''} - ${e.message}`);
    }
    throw e;
  }
}

/** A routine that moves the robot back to `target` joints (absolute jointtarget, only used within the motion limits). */
function zzReturnModule(target: JointTarget): GeneratedModule {
  const name = 'ZZ_PROBE_RETURN';
  const p = name.toLowerCase();
  const symbols = { target: `${p}_target`, done: `${p}_done` };
  const routines = { entry: `${p}_main` };
  const n = (v: number): string => {
    if (!Number.isFinite(v)) { throw new Error(`not a finite joint value: ${v}`); }
    return String(Math.round(v * 1e6) / 1e6);
  };
  const text = [
    `MODULE ${name}`,
    `  VAR jointtarget ${symbols.target};`,
    `  PERS num ${symbols.done} := 0;`,
    `  PROC ${routines.entry}()`,
    `    ${symbols.done} := 0;`,
    `    ${symbols.target} := CJointT();`,
    ...AXES.map(i => `    ${symbols.target}.robax.rax_${i} := ${n(target[rax(i)])};`),
    `    MoveAbsJ ${symbols.target}, v20, fine, tool0;`,
    `    ${symbols.done} := 1;`,
    '  ENDPROC',
    'ENDMODULE',
    '',
  ].join('\n');
  return { name, text, symbols, routines };
}

/**
 * Put the robot back at `start` if a test left it elsewhere: stop RAPID, and
 * when the difference is inside the motion limits run a return move at v20
 * with the speed ratio at 50 or less. Registered with `ctx.defer` by every
 * test that moves the robot, so it also runs when the test failed half way.
 */
async function returnToStart(ctx: FunctionalContext, start: JointTarget): Promise<void> {
  const m = await ctx.ensureManager();
  const o = await ctx.observer();
  if ((await o.getRapidExecutionState()) === 'running') {
    await m.stopRapid();
    await waitUntil(async () => (await ctx.panel()).execstate === 'stopped', 15_000, 250, 'RAPID stopped');
  }
  const now = await settledJoints(ctx);
  const d = jointDeltas(start, now);
  if (maxAbs(d) <= BACK_AT_START_DEG) { return; }
  if (!withinMotionLimits(d)) {
    throw new Error(`the robot is ${JSON.stringify(round3(d))} deg from its start joints, outside the motion limits - not moved back`);
  }
  const p = await ctx.panel();
  if (p.ctrlstate !== 'motoron') {
    if (ctx.lane === 'rw8') { throw new Error('the robot is not at its start joints and the motors are off (RW8: motors on is a pendant action)'); }
    await m.setMotorsOn();
    await waitUntil(async () => (await ctx.panel()).ctrlstate === 'motoron', 10_000, 250, 'motors on');
  }
  if ((p.speedRatio ?? 100) > MOTION_LIMITS.maxSpeedRatio) { await m.setSpeedRatio(MOTION_LIMITS.maxSpeedRatio); }
  const mod = zzReturnModule(start);
  await ctx.loadModule(mod);
  let run: RoutineRun;
  try {
    await pointAtEntry(ctx, mod);
    const sentAt = Date.now();
    await m.startRapid();
    run = await followRoutine(ctx, mod, { joints: () => readJoints(ctx), startMs: Date.now() - sentAt, capMs: RETURN_CAP_MS });
    if (!run.finished) { throw new Error(`return move not finished: ${unfinished(run)}`); }
  } finally {
    await ctx.unloadModule(mod.name).catch(e => ctx.note('unload of the return module failed', describeError(e)));
  }
  ctx.note('robot moved back to its start joints', { from: round3(d), run });
}

/** How a followed routine run ended (see `followRoutine`). */
interface RoutineRun {
  /** `done` read 1 and RAPID read stopped. */
  finished: boolean;
  /**
   * Why the follow ended: `finished`; `stopped`, RAPID read not running with
   * done not 1 for RUN_STOPPED_MS (RUN_STALL_MS before it ever read running),
   * counted over rounds where both reads answered, at least two of them;
   * `stalled`, neither the loop counter nor the joints changed for
   * RUN_STALL_MS; `cap`, still progressing at the cap.
   */
  ended: 'finished' | 'stopped' | 'stalled' | 'cap';
  /** ms from the start of the follow to its end. */
  ms: number;
  /** How long the start request took to be answered, ms (the 2026-10-22 slow VC: 4622, normally 57 to 453). */
  startMs: number;
  rounds: number;
  /** RAPID read running (straight from the controller) at least once. */
  sawRunning: boolean;
  /** The last execution state, `done` and loop counter read (null: never read). */
  exec: string | null;
  done: number | null;
  loops: number | null;
  /** ms since the last progress when the follow ended. */
  sinceProgressMs: number;
  /** ms since the execution state was last read when the follow ended (the whole follow when never). */
  sinceExecReadMs: number;
  /** Reads that failed (each counts as no reading this round), and the last error. */
  failedReads: number;
  lastError: string | null;
}

/**
 * Follow a generated routine's run until it finishes (`done` reads 1 and
 * RAPID stopped), reading each round the joints (`opts.joints`), `done`, the
 * execution state straight from the controller and the loop counter when the
 * module has one. It keeps going while the run progresses: a change of the
 * loop counter, or of the joints by more than PROGRESS_DEG since the last
 * progress, within the last RUN_STALL_MS. It ends without the finish when
 * RAPID reads not running for RUN_STOPPED_MS with done not 1 (a real stop;
 * see RoutineRun.ended for which readings count), when the run stalls, or at
 * the cap (`opts.capMs`, default RUN_CAP_MS) while it still progresses (a
 * slow VC). A read that fails counts as no reading.
 * Never throws: the record says what was seen, `unfinished` puts it in words.
 */
async function followRoutine(
  ctx: FunctionalContext, mod: GeneratedModule,
  opts: { joints: () => Promise<JointTarget | null>; startMs: number; capMs?: number; pollMs?: number },
): Promise<RoutineRun> {
  const capMs = opts.capMs ?? RUN_CAP_MS;
  const pollMs = opts.pollMs ?? 250;
  const t0 = Date.now();
  const r: RoutineRun = {
    finished: false, ended: 'cap', ms: 0, startMs: opts.startMs, rounds: 0, sawRunning: false,
    exec: null, done: null, loops: null, sinceProgressMs: 0, sinceExecReadMs: 0, failedReads: 0, lastError: null,
  };
  const read = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) {
      r.failedReads++;
      r.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  };
  let mark: JointTarget | null = null;
  let progressAt = t0;
  let execReadAt = t0;
  // The not-running readings that count towards a stop: only rounds where
  // both `done` and the execution state answered, done not 1 and RAPID not
  // running. A round with a failed read neither counts nor resets them, so
  // one race reading (done = 0, then stopped, as the routine ends) followed
  // by slow or failed reads on an overloaded VC is not taken for a stop.
  let notRunningSince: number | null = null;
  let notRunningReads = 0;
  for (;;) {
    r.rounds++;
    const joints = await read(opts.joints);
    // done before the execution state: a routine that ends between the two
    // reads done = 1 and then stopped, never the other way round.
    const done = await read(() => readNum(ctx, mod, 'done'));
    const exec = await read(async () => (await ctx.observer()).getRapidExecutionState());
    const loops = mod.symbols.loops ? await read(() => readNum(ctx, mod, 'loops')) : null;
    const now = Date.now();
    if (done !== null) { r.done = done; }
    if (exec !== null) { r.exec = exec; execReadAt = now; }
    if (loops !== null && Number.isFinite(loops) && loops !== r.loops) { r.loops = loops; progressAt = now; }
    if (joints && (!mark || maxAbs(jointDeltas(mark, joints)) > PROGRESS_DEG)) { mark = joints; progressAt = now; }
    if (exec === 'running') {
      r.sawRunning = true;
      notRunningSince = null;
      notRunningReads = 0;
    } else if (exec !== null && done !== null && done !== 1) {
      notRunningSince ??= now;
      notRunningReads++;
    }
    r.ms = now - t0;
    r.sinceProgressMs = now - progressAt;
    r.sinceExecReadMs = now - execReadAt;
    // Not running for how long, counted from two such readings on.
    const stoppedForMs = notRunningSince !== null && notRunningReads >= 2 ? now - notRunningSince : 0;
    if (done === 1 && exec === 'stopped') { r.finished = true; r.ended = 'finished'; return r; }
    if (r.sawRunning && stoppedForMs >= RUN_STOPPED_MS) { r.ended = 'stopped'; return r; }
    if (r.sinceProgressMs >= RUN_STALL_MS) { r.ended = 'stalled'; return r; }
    // Before RAPID ever read running, a stop needs as long as a stall: a slow
    // VC may not have started the routine yet.
    if (!r.sawRunning && stoppedForMs >= RUN_STALL_MS) { r.ended = 'stopped'; return r; }
    if (r.ms >= capMs) { r.ended = 'cap'; return r; }
    await new Promise(res => setTimeout(res, pollMs));
  }
}

/** What a run that did not finish showed, in words, for the failure message ('' when it finished). */
function unfinished(r: RoutineRun): string {
  const s = (ms: number): string => `${Math.round(ms / 1000)} s`;
  const seen = `done = ${r.done}, loops = ${r.loops}, execution ${r.exec}, `
    + `the start answered after ${r.startMs} ms, ${r.rounds} rounds, ${r.failedReads} failed reads`
    + (r.lastError ? ` (last: ${r.lastError})` : '');
  switch (r.ended) {
    case 'finished':
      return '';
    case 'cap': {
      const state = r.exec === 'running' ? 'still running'
        : r.exec === null ? 'the execution state never answered' : `execution read ${r.exec}`;
      return `${state} after ${s(r.ms)}, and the run still progressing - the VC ran slow (${seen})`;
    }
    case 'stalled':
      if (r.sinceExecReadMs >= RUN_STALL_MS / 2) {
        return `the controller answered no execution-state read for the last ${s(r.sinceExecReadMs)} and neither the loop counter `
          + `nor the joints changed for ${s(r.sinceProgressMs)} (after ${s(r.ms)}) - the VC is overloaded or hangs (${seen})`;
      }
      return r.exec === 'running'
        ? `still running after ${s(r.ms)}, but neither the loop counter nor the joints changed for ${s(r.sinceProgressMs)} - the VC ran slow or hangs (${seen})`
        : `neither the loop counter nor the joints changed for ${s(r.sinceProgressMs)} (after ${s(r.ms)}), and RAPID did not read running (${seen})`;
    case 'stopped':
      return `RAPID stopped with done = ${r.done} after ${s(r.ms)} - a real stop, not a slow VC (${seen})`;
  }
}

interface RunWatch {
  finished: boolean;
  /** The manager's state read running during the run. */
  sawRunning: boolean;
  samples: number;
  /** Largest |joint - start| per axis the manager's state showed, degrees. */
  maxAxisDeg: number[];
  maxMm: number;
  maxQuat: number;
  /** How the follow went (`followRoutine`). */
  run: RoutineRun;
}

/**
 * Follow a run of `mod` (see `followRoutine`) through the manager's state,
 * refreshed each round, whose joints are the progress the follow watches;
 * keeps the largest joint and pose difference from the start that the state
 * showed. `startMs`: how long the start request took to be answered.
 */
async function watchRun(
  ctx: FunctionalContext, mod: GeneratedModule, start: JointTarget, startPose: RobTarget, startMs: number,
): Promise<RunWatch> {
  const m = ctx.manager;
  const w = { sawRunning: false, samples: 0, maxAxisDeg: [0, 0, 0, 0, 0, 0], maxMm: 0, maxQuat: 0 };
  const run = await followRoutine(ctx, mod, {
    startMs, pollMs: 200,
    joints: async () => {
      await m.refresh();
      const s = m.state;
      w.samples++;
      if (s.execstate === 'running') { w.sawRunning = true; }
      if (s.joints) {
        jointDeltas(start, s.joints).forEach((d, i) => { w.maxAxisDeg[i] = Math.max(w.maxAxisDeg[i], Math.abs(d)); });
      }
      if (s.cartesian) {
        const pd = poseDelta(startPose, s.cartesian);
        w.maxMm = Math.max(w.maxMm, pd.mm);
        w.maxQuat = Math.max(w.maxQuat, pd.quat);
      }
      return s.joints ?? null;
    },
  });
  return { finished: run.finished, ...w, run };
}

const poseOf = (c: CartesianFull): RobTarget => ({ x: c.x, y: c.y, z: c.z, q1: c.q1, q2: c.q2, q3: c.q3, q4: c.q4 });

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

// ─── Manual mode ─────────────────────────────────────────────────────────────

/**
 * What a manual-mode test changed and saw. `record` goes to the trace at the
 * end; `leaveManual` puts back everything else, whatever happened.
 */
/** How the switch back to Auto went (see `switchBackToAuto`). */
interface BackToAuto {
  /** The switch was sent through RobotManager and accepted (false: refused, or the mode already read a pending change). */
  sent: boolean;
  /** Each change of the operating mode (and controller state) read afterwards, ms from the switch. */
  trail: PanelStep[];
  /** A pending change (AUTO_CH) was read on the way. */
  sawPending: boolean;
  /** The person at the FlexPendant confirmed it while the test waited; null when no wait was needed. */
  confirmedAtPendant: boolean | null;
  waitedMs: number;
  /** The operating mode read last. */
  opmode: string | null;
  /** Where the controller state came to rest in Auto (RobotWare 8: guard stop, awaiting a Reset). */
  restTrail: PanelStep[] | null;
  rest: string | null;
}

interface ManualRun {
  record: Record<string, unknown>;
  /** What the test engaged on the simulated panel. */
  engaged: SimEngaged;
  /** RobotWare 7: how the RMMP request went (null before it was made). */
  rmmp: { outcome: string | null; pendingAtMs: number | null; ms: number } | null;
  /** RMMP granted to the manager's session (RobotWare 7). */
  rmmpGranted: boolean;
  /** RobotWare 8: the station's motion-control declaration as read before, and whether the test set it. */
  motionControl: { before: boolean | null; declared: boolean };
  /** The controller read MANR after the switch (the mode actually changed). */
  reachedManual: boolean;
  /** The way back to Auto, once `leaveManual` switched (null: no switch was needed or made). */
  backToAuto: BackToAuto | null;
}

function newManualRun(ctx: FunctionalContext): ManualRun {
  return {
    record: { lane: ctx.lane, rwVersion: ctx.rwVersion },
    engaged: nothingEngaged(),
    rmmp: null,
    rmmpGranted: false,
    motionControl: { before: null, declared: false },
    reachedManual: false,
    backToAuto: null,
  };
}

/** The RobotWare 8.2 grant a remote control station needs to keep write access in manual mode. */
const MAN_MODE_GRANT = 'UAS_ALLOW_REMOTE_ACCESS_IN_MAN_MODE';

/**
 * RobotWare 8, before anything changes: a reason to skip, or null.
 *
 * In manual mode a remote station takes write access only with the 8.2
 * grant "Allow remote access in manual mode" (read from the held-grant list,
 * never with a per-grant query), and without write access nothing this test
 * does in MANR can be sent: not the jog or the program start, not the put-back
 * of the motion-control declaration, and not the switch back to Auto
 * (RobotWare 8 changes the mode only for a station holding write access).
 * The grant took write access in MANR for the jogs on RW 8.2.1 (2026-09-30).
 *
 * The grant does not cover the confirmation of the switch back: that waits in
 * AUTO_CH for the person at the FlexPendant, whom RWS_FUNCTIONAL_ALLOW_MANUAL
 * stands for (live-verified 2026-09-30 on RW 8.2.1+1023). And with the motors
 * on (from a Reset at the pendant) a mode change would undo that Reset, which
 * only a person can give again.
 */
async function rw8ManualPrecheck(ctx: FunctionalContext, run: ManualRun, p0: PanelState): Promise<string | null> {
  if (p0.ctrlstate === 'motoron') {
    return 'the RW8 motors are on from a Reset at the pendant; a switch to manual mode and back would need another Reset there';
  }
  const a = managerRws2(await ctx.ensureManager());
  if (!a) { throw new Error('the RobotWare 8 lane has no RWS 2.0 manager session'); }
  const held = await a.listCurrentUserGrants();
  run.record.manModeGrant = held.includes(MAN_MODE_GRANT);
  if (!held.includes(MAN_MODE_GRANT)) {
    return `this user does not hold ${MAN_MODE_GRANT} ("Allow remote access in manual mode"): in MANR the station could take no `
      + 'write access, so neither the jog nor the switch back to Auto could be sent, and the lane would stay in manual mode until '
      + 'someone switched it at the pendant';
  }
  return null;
}

/**
 * Pendant session: ask the owner on the console and wait for `check`
 * (waitForPerson), with the prompt and the outcome in the lane's trace.
 */
async function askPerson(
  ctx: FunctionalContext, prompt: string, check: () => Promise<boolean>, timeoutMs = PERSON_WAIT_MS,
): Promise<PersonWait> {
  ctx.note(`asked at the FlexPendant: ${prompt}`, { timeoutMs });
  const w = await waitForPerson(`${ctx.fileTag}/${ctx.lane} (RobotWare ${ctx.rwVersion}): ${prompt}`, check, timeoutMs);
  ctx.note(w.met ? `done at the FlexPendant: ${prompt}` : `not done at the FlexPendant: ${prompt}`, w);
  return w;
}

/** The operating mode straight from the controller (one request), or null when the read failed. */
async function readOpmode(ctx: FunctionalContext): Promise<string | null> {
  return (await opmodeOnly(ctx)().catch(() => null))?.opmode ?? null;
}

/**
 * Pendant session, RobotWare 6: the RWS 1.0 lane takes no mode change over
 * RWS, so the owner turns the key switch to manual reduced speed and the test
 * waits for MANR. Returns a skip reason when it did not read MANR in time.
 */
async function keySwitchToManr(ctx: FunctionalContext, run: ManualRun): Promise<string | null> {
  const w = await askPerson(ctx, 'Turn the RW6 key switch to manual (manual reduced speed)',
    async () => (await readOpmode(ctx)) === 'MANR');
  run.record.toManual = { by: 'the key switch at the RW6 pendant', met: w.met, ms: w.ms };
  // Whatever it reads now: leaveManual reads the mode again and asks for Auto if it changed.
  run.reachedManual = w.met;
  return w.met ? null : `the RW6 controller did not read MANR within ${PERSON_WAIT_MS / 1000} s of asking for the key switch`;
}

/**
 * Switch to manual reduced speed through RobotManager and wait for the
 * controller to read MANR. RobotWare 8: RobotManager holds control-station
 * write access around the switch; RW 8.2.1 refused a switch sent without it
 * with 403 -1073435873 (live 2026-09-30, before RobotManager took it for a
 * switch to a manual mode), so the trace must show the write-access request
 * before the switch.
 */
async function switchToManr(ctx: FunctionalContext, run: ManualRun): Promise<void> {
  const m = ctx.manager;
  const heldBefore = heldLocks(m);
  const marker = mark(ctx, 'switch to MANR');
  await m.setOperationMode('MANR');
  run.record.toManual = 'sent through RobotManager';
  if (ctx.lane === 'rw8') {
    const posts = requestsAfter(ctx, marker).filter(r => r.method === 'POST').map(r => (r.path ?? '').split('?')[0]);
    run.record.toManualPosts = posts;
    const switchAt = posts.indexOf('/rw/panel/opmode');
    expect(switchAt, 'the switch to MANR on the wire').toBeGreaterThanOrEqual(0);
    if (heldBefore.length === 0) {
      expect(posts.slice(0, switchAt), 'RobotManager requested write access before the switch').toContain('/rw/controlstation/writeaccess/request');
    }
  }
  const trail = await followPanel(() => ctx.panel(), { until: p => p.opmode === 'MANR', timeoutMs: 10_000 });
  run.record.toManualTrail = trail.seen;
  run.reachedManual = trail.met;
  if (!trail.met) { throw new Error(`the operation mode did not read MANR within 10 s: ${JSON.stringify(trail.seen)}`); }
}

/**
 * Hold the simulated enable switch - the stand-in for the person's enabling
 * device - and record what the controller state does. Returns how the motors
 * came on, or null when the switch alone did not do it. RobotWare 8: in
 * manual mode the enabling device is the Reset from guard stop (ABB,
 * "Changed features in RobotWare 8", About Reset), so the switch alone is
 * the only way (RWS motors on is refused in guard stop).
 */
async function holdEnableSwitch(ctx: FunctionalContext, run: ManualRun): Promise<string | null> {
  const before = (await ctx.panel()).ctrlstate;
  // Flagged before the call: a request that timed out may still have landed.
  run.engaged.enableSwitch = true;
  await ctx.manager.simEnableSwitch(true);
  const bySwitch = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate === 'motoron', timeoutMs: 5_000 });
  run.record.enableSwitch = { before, trail: bySwitch.seen, motorsOn: bySwitch.met };
  if (!bySwitch.met) { return null; }
  return ctx.lane === 'rw8' ? 'the enable switch alone (the Reset from guard stop)' : 'the enable switch alone';
}

/**
 * RobotWare 7, when the held switch alone left the motors off: RWS motors on
 * through RobotManager while the switch is held. Call it after RMMP was
 * requested: the manager takes edit mastership around the request, and in
 * manual mode ABB grants mastership only after RMMP.
 */
async function rwsMotorsOnWhileHeld(ctx: FunctionalContext, run: ManualRun): Promise<string | null> {
  try {
    await ctx.manager.setMotorsOn();
    run.record.rwsMotorsOn = 'accepted';
  } catch (e) {
    run.record.rwsMotorsOn = describeError(e);
    return null;
  }
  const byRws = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate === 'motoron', timeoutMs: 5_000 });
  run.record.rwsMotorsOnTrail = byRws.seen;
  return byRws.met ? 'RWS motors on while the enable switch is held' : null;
}

/**
 * RobotWare 7: request RMMP through RobotManager (the jog pre-flight needs it
 * granted) and record how the virtual controller answers: `pendingAtMs` null
 * with a grant means the request never waited for an operator; a grant after
 * a pending phase means the dialog was answered (by a person, or by the
 * virtual controller itself); otherwise denied or expired after 30 s.
 */
async function requestRmmpForJog(ctx: FunctionalContext, run: ManualRun): Promise<void> {
  const m = ctx.manager;
  const t0 = Date.now();
  const seen: { pendingAtMs: number | null } = { pendingAtMs: null };
  if (PENDANT) { await requestRmmpWithPerson(ctx, run, t0, seen); return; }
  askAtPendant(ctx, 'press Grant on the RMMP (remote access) dialog within 30 s');
  try {
    const r = await m.requestRmmp('modify', { waitMs: 30_000, onPending: () => { seen.pendingAtMs = Date.now() - t0; } });
    run.rmmpGranted = r.outcome === 'granted';
    run.rmmp = { outcome: r.outcome, pendingAtMs: seen.pendingAtMs, ms: Date.now() - t0 };
    run.record.rmmp = {
      outcome: r.outcome, privilege: r.privilege, detail: r.detail, refusal: r.refusal?.kind ?? null,
      pendingAtMs: seen.pendingAtMs, ms: Date.now() - t0,
    };
  } catch (e) {
    run.rmmp = { outcome: null, pendingAtMs: seen.pendingAtMs, ms: Date.now() - t0 };
    run.record.rmmp = { refused: describeError(e), pendingAtMs: seen.pendingAtMs, ms: Date.now() - t0 };
  }
}

/**
 * Pendant session, RobotWare 7: the RMMP request stays alive through the
 * client's own wait (requestRmmp polls it every second, past ABB's 10 s
 * window) while the owner is asked to press Grant, up to RMMP_GRANT_MS. The
 * request's own wait runs a little longer; when the owner's wait runs out
 * first, the request is aborted (cancelled by the client).
 */
async function requestRmmpWithPerson(
  ctx: FunctionalContext, run: ManualRun, t0: number, seen: { pendingAtMs: number | null },
): Promise<void> {
  const abort = new AbortController();
  const state: { settled: boolean } = { settled: false };
  // Both outcomes handled here, so a refusal while the owner is being asked is never an unhandled rejection.
  const request = ctx.manager.requestRmmp('modify', {
    waitMs: RMMP_GRANT_MS + 5_000, signal: abort.signal, onPending: () => { seen.pendingAtMs = Date.now() - t0; },
  }).then(r => ({ r, e: null }), (e: unknown) => ({ r: null, e }))
    .finally(() => { state.settled = true; });
  const w = await askPerson(ctx, 'Press Grant on the RW7 pendant', async () => state.settled, RMMP_GRANT_MS);
  if (!w.met) { abort.abort(); }
  const { r, e } = await request;
  const ms = Date.now() - t0;
  if (r) {
    run.rmmpGranted = r.outcome === 'granted';
    run.rmmp = { outcome: r.outcome, pendingAtMs: seen.pendingAtMs, ms };
    run.record.rmmp = {
      outcome: r.outcome, privilege: r.privilege, detail: r.detail, refusal: r.refusal?.kind ?? null,
      pendingAtMs: seen.pendingAtMs, ms, askedForMs: RMMP_GRANT_MS,
    };
  } else {
    run.rmmp = { outcome: null, pendingAtMs: seen.pendingAtMs, ms };
    run.record.rmmp = { refused: describeError(e), pendingAtMs: seen.pendingAtMs, ms, askedForMs: RMMP_GRANT_MS };
  }
}

/**
 * RobotWare 8: set this control station's motion-control declaration
 * (allow-motion-control) to `allow`, under a write-access hold the test takes
 * (so the station is registered), and return what it reads afterwards.
 */
async function setMotionControl(ctx: FunctionalContext, allow: boolean | null, run: ManualRun): Promise<boolean> {
  const m = await ctx.ensureManager();
  const a = managerRws2(m);
  if (!a) { throw new Error('the RobotWare 8 lane has no RWS 2.0 manager session'); }
  await m.requestMastership('rapid');
  try {
    if (allow !== null) { await a.setAllowMotionControl(allow); }
    return await a.getAllowMotionControl();
  } finally {
    await m.releaseMastership('rapid').catch(e => { run.record.motionControlRelease = describeError(e); });
  }
}

/**
 * RobotWare 8: RobotManager.jog refuses a jog unless this control station
 * declared that an emergency stop and a stop are within reach. Listing rw8
 * in RWS_FUNCTIONAL_ALLOW_MANUAL stands for the person at the virtual
 * FlexPendant (guard kind `manual-mode`), so the test makes the declaration
 * for the suite's station when it reads off, in Auto, and `leaveManual` puts
 * the value back while still in MANR.
 */
async function declareMotionControl(ctx: FunctionalContext, run: ManualRun): Promise<void> {
  run.motionControl.before = await setMotionControl(ctx, null, run);
  if (!run.motionControl.before) {
    run.motionControl.declared = true;
    // Backstop in afterAll, before the harness restore (which also puts a
    // declaration left true back to false): RobotWare 8 keeps station
    // settings, so a failed put-back in leaveManual (or one it never reached)
    // must not leave it on. Nothing to do once leaveManual has put it back.
    // Like the put-back, it needs write access, which RobotWare 8 refuses
    // while a switch to Auto waits in AUTO_CH.
    ctx.defer('motion-control declaration put back', async () => {
      if (!run.motionControl.declared) { return; }
      const reads = await setMotionControl(ctx, false, run);
      if (reads) { throw new Error('allow-motion-control still reads true after the put-back'); }
      run.motionControl.declared = false;
    });
    const reads = await setMotionControl(ctx, true, run);
    run.record.motionControl = { before: false, declaredByTest: true, reads };
    expect(reads, 'allow-motion-control reads true after the declaration').toBe(true);
  } else {
    run.record.motionControl = { before: true, declaredByTest: false };
  }
}

/**
 * The switch back to Auto through RobotManager (`from`: the mode as read),
 * followed until the controller reads AUTO. A switch to Auto over RWS waits
 * in AUTO_CH until someone confirms it at the FlexPendant (live-verified
 * 2026-09-30 on RW 7.21.4+417 and 8.2.1+1023, read about 230-310 ms after the
 * switch): the person there is asked on the console and waited for, up to
 * PENDANT_CONFIRM_MS, reading the mode once a second. The test does not send
 * the confirmation: the confirmation is the person's at the FlexPendant, and
 * setOperationMode does not send it; a switch sent again does not give it, so
 * a mode that already reads a pending change gets no switch at all.
 */
async function switchBackToAuto(
  ctx: FunctionalContext, m: RobotManager, from: string | null,
  step: (name: string, fn: () => Promise<unknown>) => Promise<boolean>,
): Promise<BackToAuto> {
  const back: BackToAuto = {
    sent: false, trail: [], sawPending: isPendingModeChange(from), confirmedAtPendant: null, waitedMs: 0, opmode: from, restTrail: null, rest: null,
  };
  // Pendant session, RobotWare 6: no mode change over RWS there; the owner turns the key switch.
  const byKey = PENDANT && ctx.lane === 'rw6';
  if (!isPendingModeChange(from) && !byKey) {
    back.sent = await step('switch to Auto sent through RobotManager', () => m.setOperationMode('AUTO'));
  }
  // In a pendant session the owner is asked as soon as the change reads pending.
  const toAuto = await followPanel(() => ctx.panel(), {
    until: p => p.opmode === 'AUTO' || (PENDANT && isPendingModeChange(p.opmode)), timeoutMs: byKey ? 0 : 10_000,
  });
  back.trail = [...toAuto.seen];
  back.opmode = toAuto.last.opmode;
  if (PENDANT && toAuto.last.opmode !== 'AUTO') {
    const offset = toAuto.ms;
    const t0 = Date.now();
    const lane = ctx.lane.toUpperCase();
    const prompt = byKey ? 'Turn the RW6 key switch back to Auto (and confirm it on the pendant if it asks)'
      : isPendingModeChange(toAuto.last.opmode) ? `Confirm Auto on the ${lane} pendant`
        : `Switch to Auto on the ${lane} pendant and confirm it (the controller reads ${toAuto.last.opmode ?? 'an unread mode'})`;
    const w = await askPerson(ctx, prompt, async () => {
      const op = await readOpmode(ctx);
      if (back.trail[back.trail.length - 1]?.opmode !== op) { back.trail.push({ atMs: offset + Date.now() - t0, opmode: op, ctrlstate: null }); }
      if (op !== null) { back.opmode = op; }
      return op === 'AUTO';
    }, PENDANT_CONFIRM_MS);
    back.confirmedAtPendant = w.met;
    back.waitedMs = w.ms;
  } else if (!toAuto.met && isPendingModeChange(toAuto.last.opmode)) {
    askAtPendant(ctx, `confirm the switch to Auto now (the controller reads ${toAuto.last.opmode}); the test waits up to ${PENDANT_CONFIRM_MS / 1000} s`);
    const confirm = await followPanel(opmodeOnly(ctx), { until: p => p.opmode === 'AUTO', timeoutMs: PENDANT_CONFIRM_MS, pollMs: 1_000 });
    back.trail.push(...confirm.seen.map(s => ({ ...s, atMs: s.atMs + toAuto.ms })));
    back.confirmedAtPendant = confirm.met;
    back.waitedMs = confirm.ms;
    back.opmode = confirm.last.opmode ?? back.opmode;
    ctx.note(confirm.met ? 'the switch to Auto was confirmed at the FlexPendant' : 'nobody confirmed the switch to Auto at the FlexPendant',
      { waitedMs: confirm.ms, opmode: back.opmode });
  }
  back.sawPending ||= back.trail.some(s => isPendingModeChange(s.opmode));
  if (back.opmode === 'AUTO') {
    const rest = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate !== null && p.ctrlstate !== 'init', stableMs: 3_000, timeoutMs: 15_000 });
    back.restTrail = rest.seen;
    back.rest = rest.last.ctrlstate;
  }
  return back;
}

/**
 * The way back, whatever happened; each step recorded, none throwing, in
 * this order: the jog's motion hold ended, RAPID stopped, the enable switch
 * released (and what the controller reads then), the robot teleported back
 * to its start joints if it is not there (RWS 2.0 virtual controllers; the
 * lane's deferred step tries again in Auto), the motion-control declaration
 * put back (RobotWare 8), the switch to Auto (see `switchBackToAuto`;
 * RobotWare 8 then rests in guard stop), and RMMP cancelled after it (a
 * switch back from MANR takes mastership, which needs RMMP there). The
 * harness restore runs after it.
 *
 * The declaration goes back before the switch, while write access can still
 * be taken: in MANR (the precheck made sure this user holds the 8.2 grant),
 * or in Auto when the mode never changed. Once the switch to Auto waits in
 * AUTO_CH no remote station can take write access (RW 8.2.1 refused every
 * request with 403 -1073414145, live 2026-09-30), and a put-back after the
 * switch failed there.
 */
async function leaveManual(ctx: FunctionalContext, run: ManualRun, start: JointTarget): Promise<void> {
  const steps: Array<Record<string, unknown>> = [];
  const step = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      const value = await fn();
      steps.push(value === undefined ? { step: name, ok: true } : { step: name, ok: true, value });
      return true;
    } catch (e) {
      steps.push({ step: name, ok: false, ...describeError(e) });
      return false;
    }
  };
  let m: RobotManager;
  try { m = await ctx.ensureManager(); } catch (e) {
    run.record.leave = [{ step: 'manager session', ok: false, ...describeError(e) }];
    return;
  }
  // A panel read that throws counts as unread (null), so nothing here escapes.
  const panelNow = async (): Promise<PanelState | null> => {
    try { return await ctx.panel(); } catch (e) {
      steps.push({ step: 'panel read', ok: false, ...describeError(e) });
      return null;
    }
  };
  if (heldLocks(m).length) { await step('holds released', () => releaseHolds(m)); }
  if ((await panelNow())?.execstate === 'running') {
    await step('RAPID stopped', async () => {
      await m.stopRapid();
      await waitUntil(async () => (await ctx.panel()).execstate === 'stopped', 15_000, 250, 'RAPID stopped');
    });
  }
  if (run.engaged.enableSwitch) {
    steps.push(...await releaseSimPanel(m, run.engaged));
    const trail = await followPanel(() => ctx.panel(), { until: p => p.ctrlstate !== 'motoron', stableMs: 2_000, timeoutMs: 8_000 });
    run.record.afterEnableSwitchReleased = trail.seen;
  }
  if (ctx.generation === 'rws2') { await step('robot back at its start joints (teleport, in MANR)', () => teleportBack(ctx, start)); }
  if (run.motionControl.declared) {
    await step('motion-control declaration put back (before the switch to Auto)', async () => {
      const want = run.motionControl.before ?? false;
      const reads = await setMotionControl(ctx, want, run);
      // Left flagged unless it reads back as before: the deferred backstop tries again.
      if (reads !== want) { throw new Error(`allow-motion-control reads ${reads} after the put-back to ${want}`); }
      run.motionControl.declared = false;
      return reads;
    });
  }
  // The mode as read (a few tries): an unread mode sends no switch; the
  // harness restore reads it again and decides.
  const modeRead = await followPanel(async () => (await panelNow()) ?? { opmode: null, ctrlstate: null, speedRatio: null, execstate: null },
    { until: p => p.opmode !== null, timeoutMs: 3_000, pollMs: 500 });
  if (!modeRead.met) {
    steps.push({ step: 'switch to Auto', ok: false, detail: 'the operation mode could not be read; no switch sent (the harness restore reads it again)' });
  } else if (modeRead.last.opmode !== 'AUTO') {
    run.reachedManual = true;
    run.backToAuto = await switchBackToAuto(ctx, m, modeRead.last.opmode, step);
    run.record.backToAuto = run.backToAuto;
  }
  if (run.rmmpGranted) {
    await step('RMMP cancelled', async () => { await m.cancelRmmp(); run.rmmpGranted = false; });
  }
  run.record.leave = steps;
}

/**
 * The way back, asserted after `leaveManual` and the restore, even when the
 * test stopped short of its motion: a lane left out of Auto would fail every
 * later test file. Returns the panel as read.
 */
async function expectBackInAuto(ctx: FunctionalContext, run: ManualRun): Promise<PanelState> {
  const back = run.backToAuto;
  if (back?.sent && (ctx.lane === 'rw7' || ctx.lane === 'rw8')) {
    // Live-verified 2026-09-30 on RW 7.21.4+417 and 8.2.1+1023: the switch
    // from MANR to Auto over RWS is accepted (202) and then waits in AUTO_CH
    // until someone confirms it at the FlexPendant; neither virtual
    // controller confirms it by itself.
    expect(back.sawPending, `RobotWare ${ctx.rwVersion}: the switch back to Auto waits in AUTO_CH for the confirmation at the FlexPendant`)
      .toBe(true);
  }
  const now = await ctx.panel();
  expect(now.opmode, isPendingModeChange(now.opmode)
    ? `the switch back to Auto still waits for the confirmation at the FlexPendant (${now.opmode}) after ${PENDANT_CONFIRM_MS / 1000} s: `
      + `confirm it there (RWS_FUNCTIONAL_ALLOW_MANUAL=${ctx.lane} says someone at the pendant does)`
    : 'operation mode after the way back').toBe('AUTO');
  return now;
}

interface JogLeg {
  sent: number;
  refusal: RwsError | null;
  steps: Array<Record<string, unknown>>;
  last: JointTarget;
}

/**
 * Jog axis 1 in Small increments with `value`, one jog at a time through
 * RobotManager, reading the joints back from the controller after each (up
 * to 3 s for axis 1 to change) until `done(joints)` holds or `maxJogs` were
 * sent. A refused jog ends the leg with the refusal. A reading of axis 1
 * past JOG_RUNAWAY_DEG from the start throws at once (the caller's finally
 * releases the enable switch).
 */
async function jogLeg(
  ctx: FunctionalContext, start: JointTarget, value: number, done: (now: JointTarget) => boolean, maxJogs: number,
): Promise<JogLeg> {
  const params: JogParams = { mode: 'Joint', axes: [value, 0, 0, 0, 0, 0], speed: 10, incMode: 'Small' };
  assertSafeJog(params);
  const leg: JogLeg = { sent: 0, refusal: null, steps: [], last: await readJoints(ctx) };
  for (let i = 0; i < maxJogs && !done(leg.last); i++) {
    const before = leg.last;
    try {
      await ctx.manager.jog(params);
      leg.sent++;
    } catch (e) {
      if (!(e instanceof RwsError)) { throw e; }
      leg.refusal = e;
      leg.steps.push({ n: i + 1, ...describeError(e) });
      break;
    }
    const t0 = Date.now();
    const now: { j: JointTarget; runaway: boolean } = { j: before, runaway: false };
    const seen = await waitFor(async () => {
      now.j = await readJoints(ctx);
      if (Math.abs(now.j.rax_1 - start.rax_1) > JOG_RUNAWAY_DEG) { now.runaway = true; return true; }
      return Math.abs(now.j.rax_1 - before.rax_1) >= JOG_STEP_SEEN_DEG;
    }, 3_000, 150);
    leg.last = now.j;
    leg.steps.push({ n: i + 1, sent: true, seen, ms: Date.now() - t0, axis1FromStart: round6(now.j.rax_1 - start.rax_1) });
    if (now.runaway) {
      throw new Error(`axis 1 reads ${round6(now.j.rax_1 - start.rax_1)} deg from its start after ${leg.sent} Small jogs - stopped`);
    }
  }
  return leg;
}

/**
 * The RWS 1.0 lane in manual reduced speed: it has no enable-switch endpoint,
 * so the manager's refusal of it is asserted (typed, nothing sent), RWS
 * motors on is tried and recorded, and the jog is tried: accepted jogs must
 * read back as a move of axis 1 in the jog's direction only; a refusal is the
 * record (the controller decides: in manual mode only the person's enabling
 * device switches the motors on, and ABB's jog pages ask for a local client).
 */
async function recordRws1Manual(ctx: FunctionalContext, run: ManualRun, start: JointTarget): Promise<void> {
  const m = ctx.manager;
  const sim = await expectRwsError(() => m.simEnableSwitch(true));
  run.record.enableSwitch = { refused: describeError(sim), why: 'RWS 1.0 has no enable-switch endpoint' };
  expect(sim.code).toBe('UNSUPPORTED_OPERATION');
  try {
    await m.setMotorsOn();
    run.record.motorsOn = { accepted: true, reads: await waitFor(async () => (await ctx.panel()).ctrlstate === 'motoron', 5000) };
  } catch (e) {
    run.record.motorsOn = describeError(e);
    expect(e).toBeInstanceOf(RwsError);
  }
  const value = towardZero(start.rax_1, 50);
  const countBefore = await m.getMotionChangeCount();
  const out = await jogLeg(ctx, start, value, now => Math.abs(now.rax_1 - start.rax_1) >= JOG_MOVED_DEG, MAX_JOGS);
  run.record.jog = {
    value, sent: out.sent, steps: out.steps, refusal: out.refusal ? describeError(out.refusal) : null,
    countBefore, countAfter: await m.getMotionChangeCount(),
  };
  if (out.sent > 0) {
    const d = jointDeltas(start, await settledJoints(ctx));
    expect(Math.abs(d[0]), 'axis 1 after accepted jogs').toBeGreaterThanOrEqual(JOG_MOVED_DEG);
    expect(Math.sign(d[0])).toBe(Math.sign(value));
    expect(maxAbs(d.slice(1))).toBeLessThan(JOG_OTHERS_DEG);
  } else {
    expect(out.refusal, 'the first jog was refused, typed').toBeInstanceOf(RwsError);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

await forEachController('09-motion', ctx => {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  it('reads the mechanical unit: a six-axis TCP robot, activated, driven by the motion task, with a unit-quaternion base frame', async () => {
    const m = await ctx.ensureManager();
    expect(m.state.mechunits).toContain(ctx.mechunit);

    const details = await m.getMechunitDetails(ctx.mechunit);
    const { raw: _raw, ...shown } = details;
    ctx.note('mechanical unit details', shown);
    expect(details.name).toBe(ctx.mechunit);
    // Observed on the RW 7.21 VC (type TCPRobot, 6 axes, Activated,
    // task T_ROB1); RW 6 JSON spells the task field differently and the
    // client normalises it. A unit that runs MoveAbsJ must be activated.
    expect(details.type).toBe('TCPRobot');
    expect(details.axes).toBe(6);
    expect(details.mode).toBe('Activated');
    expect(details.task).toBe(ctx.task);

    const frame = await m.getMechunitBaseFrame(ctx.mechunit);
    ctx.note('base frame', frame);
    expect(frame).not.toBeNull();
    for (const v of Object.values(frame!)) { expect(Number.isFinite(v)).toBe(true); }
    expect(Math.hypot(frame!.q1, frame!.q2, frame!.q3, frame!.q4)).toBeCloseTo(1, 3);

    const axes = await m.getMechunitAxes(ctx.mechunit);
    ctx.note('axes', { count: axes.length, first: axes[0] ?? null });
    // RWS 2.0 lists axes 1-6 (live-verified 2026-09-29 on RW 7.21.4 and 8.2.1).
    if (ctx.generation === 'rws2') { expect(axes.length).toBe(6); } else { expect(Array.isArray(axes)).toBe(true); }

    const full = await m.getJointTargetFull(ctx.mechunit);
    for (const v of full.rax) { expect(Number.isFinite(v)).toBe(true); }
    const joints = await readJoints(ctx);
    expect(maxAbs(full.rax.map((v, i) => v - joints[rax(i + 1)]))).toBeLessThan(0.01);

    ctx.note('motion error state', await m.getMotionErrorState());
  });

  it('reads the motion-system change count, which checkMotionChangeCount confirms and a different count does not', async () => {
    const m = await ctx.ensureManager();
    const count = await m.getMotionChangeCount();
    ctx.note('motion-system change count', { count });
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
    // Live-verified 2026-09-29 on all three builds: TRUE for the current
    // count, FALSE for another; reads do not change the count.
    expect(await m.checkMotionChangeCount(count)).toBe(true);
    expect(await m.checkMotionChangeCount(count + 1)).toBe(false);
    expect(await m.getMotionChangeCount()).toBe(count);
  });

  // ─── Speed ratio ───────────────────────────────────────────────────────────

  it('sets the speed ratio to 50 and back, the manager state and a direct read in agreement, with no access left held', async t => {
    const m = await ctx.ensureManager();
    const p = await ctx.panel();
    if (p.opmode !== 'AUTO') { ctx.skip(t, `speed ratio is written in Auto only; the controller reads ${p.opmode}`); }
    const before = p.speedRatio!;
    const target = before === 50 ? 40 : 50;
    await m.setSpeedRatio(target);
    expect(m.state.speedRatio).toBe(target);
    await waitUntil(async () => (await ctx.panel()).speedRatio === target, 10_000, 250, `speed ratio ${target}`);
    expect(heldLocks(m)).toEqual([]);

    await m.setSpeedRatio(before);
    await waitUntil(async () => (await ctx.panel()).speedRatio === before, 10_000, 250, `speed ratio ${before}`);
    await waitUntil(() => m.state.speedRatio === before, 10_000, 250, 'manager speed ratio back');
    expect(heldLocks(m)).toEqual([]);
  });

  it('refuses a speed ratio above 100 before sending it, as INVALID_ARGUMENT, and the ratio stays', async () => {
    const m = await ctx.ensureManager();
    const before = (await ctx.panel()).speedRatio;
    const marker = mark(ctx, 'speed ratio 101');
    const err = await expectRwsError(() => m.setSpeedRatio(101));
    ctx.note('speed ratio 101', describeError(err));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(requestsAfter(ctx, marker).filter(r => r.method === 'POST' && /speedratio/i.test(r.path ?? ''))).toEqual([]);
    expect((await ctx.panel()).speedRatio).toBe(before);
  });

  // ─── Motors ────────────────────────────────────────────────────────────────

  it('switches the motors off and on over RWS in Auto; the manager state follows and no access is left held', async t => {
    await ctx.requireAllowed(t, 'motors');
    const p = await ctx.panel();
    if (p.opmode !== 'AUTO') { ctx.skip(t, `remote motors on is an Auto operation; the controller reads ${p.opmode}`); }
    if (p.execstate === 'running') { throw new Error('RAPID is running - the motors test needs it stopped'); }
    const m = ctx.manager;
    const order: Array<'motoroff' | 'motoron'> = p.ctrlstate === 'motoron' ? ['motoroff', 'motoron'] : ['motoron', 'motoroff'];
    const timings: Record<string, number> = {};
    for (const want of order) {
      const t0 = Date.now();
      if (want === 'motoron') { await m.setMotorsOn(); } else { await m.setMotorsOff(); }
      await waitUntil(async () => (await ctx.panel()).ctrlstate === want, 10_000, 100, `controller state ${want}`);
      timings[want] = Date.now() - t0;
      await waitUntil(() => m.state.ctrlstate === want, 15_000, 250, `manager state ${want}`);
      expect(heldLocks(m)).toEqual([]);
    }
    ctx.note('motors switched over RWS', { order, msUntilRead: timings });
    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
  });

  it('RW8: refuses motors on over RWS in guard stop, typed as the safety state with the Reset named, and releases the write access', async t => {
    await ctx.requireAllowed(t, 'motors-refusal');
    const p = await ctx.panel();
    if (p.ctrlstate !== 'guardstop') { ctx.skip(t, `the documented refusal is for guard stop; the controller reads ${p.ctrlstate}`); }
    const m = ctx.manager;
    const err = await expectRwsError(() => m.setMotorsOn());
    ctx.note('RW8 motors on refused', describeError(err));
    // Recorded on a RobotWare 8.1.1 virtual controller in guard stop: 403
    // -1073445806 ("not allowed in current controller state") even with write
    // access held; the client explains it as a pending Reset.
    expect(err.code).toBe('WRONG_MODE');
    expect(err.httpStatus).toBe(403);
    expect(err.controllerCode).toBe(-1073445806);
    expect(err.refusal?.kind).toBe('safety-state');
    expect(err.refusal?.grantor).toBe('cell-safety');
    expect(err.message).toMatch(/Reset/);
    expect((await ctx.panel()).ctrlstate).toBe('guardstop');
    expect(heldLocks(m)).toEqual([]);
  });

  // ─── RAPID with motion ───────────────────────────────────────────────────

  it('records the refusal of a RAPID start with the motors off, and execution stays stopped', async t => {
    await ctx.requireAllowed(t, 'motors');
    await ctx.requireAllowed(t, 'rapid-start');
    const p = await ctx.panel();
    if (p.opmode !== 'AUTO') { ctx.skip(t, `the controller reads ${p.opmode}, not AUTO`); }
    if (p.execstate === 'running') { throw new Error('RAPID is running - this test needs it stopped'); }
    const m = ctx.manager;
    // A module without motion: if the start were accepted nothing would move.
    const mod = zzExecModule({ name: 'ZZ_PROBE_NOMOTORS', loops: 20, waitSec: 0.1 });
    await ctx.loadModule(mod);
    await pointAtEntry(ctx, mod);
    if (p.ctrlstate === 'motoron') {
      await m.setMotorsOff();
      await waitUntil(async () => (await ctx.panel()).ctrlstate === 'motoroff', 10_000, 250, 'motors off');
    }
    // The refusal is explained from the manager's state: let it catch up first.
    const ctrlstate = (await ctx.panel()).ctrlstate;
    await waitUntil(() => m.state.ctrlstate === ctrlstate, 15_000, 250, `manager ctrlstate ${ctrlstate}`);
    let accepted = false;
    let err: RwsError | null = null;
    try { await m.startRapid(); accepted = true; } catch (e) {
      if (!(e instanceof RwsError)) { throw e; }
      err = e;
    }
    if (accepted) {
      await m.stopRapid();
      await waitUntil(async () => (await ctx.panel()).execstate === 'stopped', 15_000, 250, 'RAPID stopped');
      throw new Error('the controller accepted a RAPID start with the motors off');
    }
    ctx.note('RAPID start with the motors off', describeError(err));
    // The answer differs per build; the program pointer is set here, so the
    // motors state is the only thing missing.
    if (ctx.lane === 'rw7') {
      // Live-verified 2026-09-30 on RW 7.21.4: 403 -1073445806
      // (SYS_CTRL_E_PERMISSION_CONTROLLER_STATE_REJECT, "Rejected because not
      // allowed in current controller state") with the program pointer set and
      // the motors off. The -1073442809 (SYS_CTRL_E_EXEC_STATE) recorded
      // earlier on RW 7.21 is not what 7.21.4 answers in this state.
      expect(err!.code).toBe('WRONG_MODE');
      expect(err!.httpStatus).toBe(403);
      expect(err!.controllerCode).toBe(-1073445806);
      expect(err!.refusal?.kind).toBe('wrong-state');
    } else if (ctx.lane === 'rw6') {
      // Live-verified 2026-09-30 on RW 6.16.03: 400 -1073445881
      // (SYS_CTRL_E_REJECT), the message carrying org_code -4506. The refusal
      // is the motors state, not a missing grant, so it must be typed as a
      // state refusal - WRONG_MODE, or MOTORS_OFF, which startRapid documents
      // for a motors-off start over RWS 1.0 - and never as GRANT_DENIED.
      expect(['WRONG_MODE', 'MOTORS_OFF']).toContain(err!.code);
      expect(err!.httpStatus).toBe(400);
      expect(err!.controllerCode).toBe(-1073445881);
      expect(err!.controllerMsg ?? '').toMatch(/org_code: -4506/);
      if (err!.refusal) { expect(err!.refusal.kind).toBe('wrong-state'); }
    } else {
      throw new Error(`no motors-off start refusal is on record for lane ${ctx.lane}`);
    }
    expect((await ctx.panel()).execstate).toBe('stopped');
    expect(heldLocks(m)).toEqual([]);
    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
  });

  it('runs a ZZ_PROBE joint move out and back: the manager state shows the joints and the robot target change while it runs, and the robot ends at its start joints within 0.1 degree', async t => {
    const { speedRatio } = await ctx.prepareMotion(t);
    const m = ctx.manager;
    const start = await settledJoints(ctx);
    ctx.defer('robot back at the start joints of the out-and-back run', () => returnToStart(ctx, start));
    const startPose = poseOf(await m.getCartesianFull(ctx.mechunit));
    const axis1Deg = towardZero(start.rax_1, 3);
    const wristDeg = towardZero(start.rax_4, 6);
    const mod = zzMotionModule({ name: 'ZZ_PROBE_MOVE', axis1Deg, wristDeg, speed: 'v20', loops: 2 });
    await ctx.loadModule(mod);
    await pointAtEntry(ctx, mod);
    const countBefore = await m.getMotionChangeCount();

    const sentAt = Date.now();
    await startOrExplain(ctx, t);
    const w = await watchRun(ctx, mod, start, startPose, Date.now() - sentAt);
    ctx.note('out-and-back run', { speedRatio, axis1Deg, wristDeg, ...w, maxAxisDeg: round3(w.maxAxisDeg) });
    expect(w.finished, `the routine finished (done = 1, execution stopped): ${unfinished(w.run)}`).toBe(true);
    expect(w.sawRunning, 'the manager state read running during the run').toBe(true);
    // The moved axes showed in the manager's joints; the others stayed.
    expect(Math.max(w.maxAxisDeg[0], w.maxAxisDeg[3], w.maxAxisDeg[5])).toBeGreaterThan(MOVED_DEG);
    expect(Math.max(w.maxAxisDeg[1], w.maxAxisDeg[2], w.maxAxisDeg[4])).toBeLessThan(MOVED_DEG);
    // The robot target changed with them.
    expect(w.maxMm > 0.1 || w.maxQuat > 1e-4, `robot target change: ${w.maxMm.toFixed(3)} mm, quaternion ${w.maxQuat.toExponential(2)}`).toBe(true);

    expect(await readNum(ctx, mod, 'loops')).toBe(2);
    const end = await settledJoints(ctx);
    const back = jointDeltas(start, end);
    ctx.note('end joints against the start', { delta: round3(back) });
    expect(maxAbs(back)).toBeLessThanOrEqual(BACK_AT_START_DEG);
    await m.refresh();
    await waitUntil(() => m.state.execstate === 'stopped', 15_000, 250, 'manager execution state stopped');
    expect(maxAbs(jointDeltas(start, m.state.joints!))).toBeLessThanOrEqual(BACK_AT_START_DEG);

    // Whether a program move changes the motion-system change count is not
    // settled (every VC read 0 so far): recorded, and the count still checks.
    const countAfter = await m.getMotionChangeCount();
    ctx.note('motion-system change count around a program move', { before: countBefore, after: countAfter });
    expect(await m.checkMotionChangeCount(countAfter)).toBe(true);

    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
  }, MOTION_TEST_MS);

  it('stops the robot in the middle of a move, short of the target, refuses a program-pointer move while running, and finishes the cycle on the next start', async t => {
    await ctx.prepareMotion(t);
    const m = ctx.manager;
    const start = await settledJoints(ctx);
    ctx.defer('robot back at the start joints of the stop run', () => returnToStart(ctx, start));
    const axis1Deg = towardZero(start.rax_1, 4);
    const mod = zzMotionModule({ name: 'ZZ_PROBE_STOP', axis1Deg, wristDeg: towardZero(start.rax_4, 4), speed: 'v10', loops: 1 });
    await ctx.loadModule(mod);
    await pointAtEntry(ctx, mod);

    const sentAt = Date.now();
    await startOrExplain(ctx, t);
    const startMs = Date.now() - sentAt;
    await waitUntil(async () => Math.abs((await readJoints(ctx)).rax_1 - start.rax_1) > 0.3, 30_000, 150, 'axis 1 moving');

    // The client refuses to move the program pointer of a running program
    // unless asked to stop it; nothing is sent and the run goes on.
    const pp = await expectRwsError(() => m.setPPToRoutine(ctx.task, mod.name, mod.routines.entry));
    ctx.note('PP move while running', describeError(pp));
    expect(pp.code).toBe('WRONG_MODE');
    expect(pp.refusal?.kind).toBe('wrong-state');
    expect((await ctx.panel()).execstate).toBe('running');

    await m.stopRapid();
    await waitUntil(async () => (await ctx.panel()).execstate === 'stopped', 15_000, 100, 'RAPID stopped');
    const stoppedAt = await settledJoints(ctx);
    const d1 = stoppedAt.rax_1 - start.rax_1;
    ctx.note('stopped mid-move', { axis1Deg, axis1Moved: Math.round(d1 * 1000) / 1000, startMs });
    expect(Math.abs(d1)).toBeGreaterThan(0.05);
    expect(Math.abs(axis1Deg - d1), 'axis 1 stopped short of its target').toBeGreaterThan(0.05);
    expect(Math.sign(d1)).toBe(Math.sign(axis1Deg));
    expect(await readNum(ctx, mod, 'done')).toBe(0);
    await waitUntil(() => m.state.execstate === 'stopped', 15_000, 250, 'manager execution state stopped');

    // startRapid never moves the program pointer: the stopped move resumes,
    // reaches the target and the routine returns to the start.
    const restartSentAt = Date.now();
    await m.startRapid();
    const rerun = await followRoutine(ctx, mod, { joints: () => readJoints(ctx), startMs: Date.now() - restartSentAt });
    ctx.note('run after the restart', rerun);
    expect(rerun.finished, `the routine finished after the restart (done = 1, execution stopped): ${unfinished(rerun)}`).toBe(true);
    expect(await readNum(ctx, mod, 'loops')).toBe(1);
    const end = await settledJoints(ctx);
    expect(maxAbs(jointDeltas(start, end))).toBeLessThanOrEqual(BACK_AT_START_DEG);

    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
  }, STOP_RESTART_TEST_MS);

  // ─── Kinematics ────────────────────────────────────────────────────────────

  it('inverse kinematics from the current pose returns the current joints', async () => {
    const m = await ctx.ensureManager();
    const joints = await settledJoints(ctx);
    const pose = poseOf(await m.getCartesianFull(ctx.mechunit));
    let solved: JointTarget | null = null;
    let err: unknown = null;
    try { solved = await m.calcJointsFromCartesian(pose, joints, ctx.mechunit); } catch (e) { err = e; }

    // Live-verified 2026-09-30 on RW 6.16.03, 7.21.4 and 8.2.1: sent in metres
    // and radians, the solve works on a virtual controller. The "out of reach"
    // answer every pose used to get came from the units the client sent.
    if (!solved) { ctx.note('inverse kinematics refused', describeError(err)); }
    expect(solved, `RobotWare ${ctx.rwVersion} solves inverse kinematics on a VC`).not.toBeNull();
    const d = jointDeltas(joints, solved as JointTarget);
    ctx.note('inverse kinematics solved on a virtual controller', { pose, joints, solved, delta: round3(d) });
    expect(maxAbs(d)).toBeLessThanOrEqual(BACK_AT_START_DEG);
    expect(heldLocks(m)).toEqual([]);
  });

  it('forward kinematics from the current joints returns the current pose (tool0/wobj0); the unit\'s tool and work object stay', async () => {
    const m = await ctx.ensureManager();
    const before = await m.getMechunitDetails(ctx.mechunit);
    const joints = await settledJoints(ctx);
    const pose = poseOf(await m.getCartesianFull(ctx.mechunit));
    // The current tool and work object are passed: the request carries them,
    // so it names nothing the unit does not already use.
    const tool = before.tool ?? 'tool0';
    const wobj = before.wobj ?? 'wobj0';
    let solved: RobTarget | null = null;
    let err: unknown = null;
    try { solved = await m.calcCartesianFromJoints(joints, ctx.mechunit, tool, wobj); } catch (e) { err = e; }
    // Live-verified 2026-09-30 on RW 6.16.03 (CalcPoseFromJoints), 7.21.4 and
    // 8.2.1 (pose-from-joints): forward kinematics solves on a virtual
    // controller. Both generations refuse a tool other than tool0 or a work
    // object other than wobj0 before sending, so only that pair must solve.
    if (tool === 'tool0' && wobj === 'wobj0') {
      if (!solved) { ctx.note('forward kinematics refused', describeError(err)); }
      expect(solved, `RobotWare ${ctx.rwVersion} solves forward kinematics on a VC`).not.toBeNull();
    }

    if (solved) {
      const d = poseDelta(pose, solved);
      ctx.note('forward kinematics solved on a virtual controller', { joints, pose, solved, delta: d, tool, wobj });
      expect(d.mm).toBeLessThan(1);
      expect(d.quat).toBeLessThan(1e-3);
    } else {
      ctx.note('forward kinematics refused', { ...describeError(err), tool, wobj });
      expect(err).toBeInstanceOf(RwsError);
      expect(TRANSPORT_CODES).not.toContain((err as RwsError).code);
    }
    const after = await m.getMechunitDetails(ctx.mechunit);
    expect(after.tool).toBe(before.tool);
    expect(after.wobj).toBe(before.wobj);
    expect(heldLocks(m)).toEqual([]);
  });

  // ─── Jogging ───────────────────────────────────────────────────────────────

  it('sends a jog in Auto and reports the controller\'s refusal typed (WRONG_MODE, wrong-mode or wrong-state); nothing moves, the change count stays and no access is left held', async t => {
    const m = await ctx.ensureManager();
    const p = await ctx.panel();
    if (p.opmode !== 'AUTO') { ctx.skip(t, `the documented refusal is for Auto; the controller reads ${p.opmode}`); }
    const joints = await settledJoints(ctx);
    const count = await m.getMotionChangeCount();
    const params: JogParams = { mode: 'Joint', axes: [0, 0, 0, 0, 0, towardZero(joints.rax_6, 10)], speed: 10, incMode: 'Small' };
    assertSafeJog(params);

    // RobotManager.jog sends the jog in any mode; the mode and the motors are
    // read only to explain a refusal. ABB documents jogging in manual mode, so
    // the controller refuses it in Auto: a mode refusal, or a state refusal
    // when the motors are off or a guard stop holds (the classifier's
    // explanation is kept).
    const marker = mark(ctx, 'jog in Auto');
    const err = await expectRwsError(() => m.jog(params));
    ctx.note('jog in Auto', describeError(err));
    const jogPosts = requestsAfter(ctx, marker).filter(r => r.method === 'POST' && /jog/i.test(r.path ?? ''));
    expect(jogPosts.length, 'the jog request went out').toBeGreaterThanOrEqual(1);
    expect(err.httpStatus ?? 0, 'refused by the controller').toBeGreaterThanOrEqual(400);
    if (err.controllerCode === -1073435864) {
      // RobotWare 8's own motion-control code. RW 8.2.1 answered a jog in Auto
      // with the mode refusal (motors on, 2026-10-18) or the state refusal
      // (guard stop, 2026-10-17); should it answer this code, the client
      // explains it from the code, whatever the mode.
      expect(ctx.lane).toBe('rw8');
      expect(err.code).toBe('GRANT_DENIED');
      expect(err.refusal?.kind).toBe('motion-control-off');
    } else {
      expect(err.code).toBe('WRONG_MODE');
      expect(['wrong-mode', 'wrong-state']).toContain(err.refusal?.kind);
      if (err.refusal?.kind === 'wrong-mode') { expect(err.message).toMatch(/AUTO/); }
      if (err.refusal?.condition === 'motors') { expect(err.message).toMatch(/Jogging is done in manual mode at the FlexPendant/); }
    }

    // The jog's own motion hold (RobotWare 8: write access) ends 2 s after the last jog.
    await waitUntil(() => heldLocks(m).length === 0, 5_000, 250, 'no access held after the refused jog');
    expect(await m.getMotionChangeCount()).toBe(count);
    expect(maxAbs(jointDeltas(joints, await readJoints(ctx)))).toBeLessThan(0.005);
  });

  // ─── Manual mode (opt-in: RWS_FUNCTIONAL_ALLOW_MANUAL) ─────────────────────

  it('jogs axis 1 in manual reduced speed with the virtual enable switch held, and reads it back from the controller: axis 1 moves in the jog direction, no other axis moves, and the jog back returns it (RWS 1.0 records its refusals)', async t => {
    await ctx.requireAllowed(t, 'manual-mode');
    const vc = ctx.generation === 'rws2';
    if (vc) { await ctx.requireAllowed(t, 'vc-sim'); }
    // RobotWare 7 requests RMMP below: checked before anything changes.
    if (ctx.lane === 'rw7') { await ctx.requireAllowed(t, 'rmmp-manual'); }
    const p0 = await ctx.panel();
    if (p0.opmode !== 'AUTO') { ctx.skip(t, `the test starts from Auto; the controller reads ${p0.opmode}`); }
    if (p0.execstate === 'running') { throw new Error('RAPID is running - the jog test needs it stopped'); }
    const m = ctx.manager;
    const run = newManualRun(ctx);
    run.record.before = p0;
    if (ctx.lane === 'rw8') {
      const why = await rw8ManualPrecheck(ctx, run, p0);
      if (why) { ctx.note('manual-mode jog not started', run.record); ctx.skip(t, why); }
    }
    const start = await settledJoints(ctx);
    // Backstops, run in afterAll if the test's own way back did not finish.
    ctx.defer('robot back at the start joints of the manual jog test', () => (vc ? teleportBack(ctx, start) : returnToStart(ctx, start)));
    ctx.defer('simulated panel released after the manual jog test', async () => releaseSimPanel(await ctx.ensureManager(), run.engaged));

    /** Returns a skip reason when the controller stopped the test short of a jog. */
    const body = async (): Promise<string | null> => {
      if (ctx.lane === 'rw8') { await declareMotionControl(ctx, run); }
      try {
        if (PENDANT && ctx.lane === 'rw6') {
          const notManual = await keySwitchToManr(ctx, run);
          if (notManual) { return notManual; }
        } else {
          await switchToManr(ctx, run);
        }
      } catch (e) {
        if (!(e instanceof RwsError) || ctx.lane === 'rw7') { throw e; }
        run.record.toManualFinal = describeError(e);
        // RWS 1.0 records the refusal as its outcome, as before; RobotWare 8
        // has no switch on record yet, so its refusal is the skip reason.
        return ctx.lane === 'rw8' ? `RobotWare 8 refused the switch to MANR: ${e.code} ${e.controllerCode ?? ''} - ${e.message}` : null;
      }
      run.record.inManual = await ctx.panel();
      if (!vc) { await recordRws1Manual(ctx, run, start); return null; }

      // The switch first: ABB's RMMP refusal names a released enabling device
      // as one of its causes, so RobotWare 7 requests RMMP with it held, and
      // tries RWS motors on only after that (it needs edit mastership).
      let motorsOnBy = await holdEnableSwitch(ctx, run);
      if (ctx.lane === 'rw7') {
        await requestRmmpForJog(ctx, run);
        // Live-verified 2026-09-30 on RW 7.21.4+417: the request waits for
        // the operator at the FlexPendant (pending after 122 ms) and, with
        // nobody there, expires after 30 s. The virtual controller does not
        // grant it by itself.
        expect(typeof run.rmmp?.pendingAtMs, `RobotWare ${ctx.rwVersion}: the RMMP request waits for the operator at the FlexPendant `
          + `(${JSON.stringify(run.record.rmmp)})`).toBe('number');
        motorsOnBy ??= await rwsMotorsOnWhileHeld(ctx, run);
      }
      run.record.motorsOnBy = motorsOnBy;
      if (!motorsOnBy) {
        return `in MANR with the virtual enable switch held the motors did not come on: ${JSON.stringify(run.record.enableSwitch)}`
          + (run.record.rwsMotorsOn ? `; RWS motors on: ${JSON.stringify(run.record.rwsMotorsOn)}` : '')
          + (run.record.rmmp ? `; RMMP: ${JSON.stringify(run.record.rmmp)}` : '');
      }

      const value = towardZero(start.rax_1, 50);
      const countBefore = await m.getMotionChangeCount();
      const jogMarker = mark(ctx, 'manual jog out');
      const out = await jogLeg(ctx, start, value, now => Math.abs(now.rax_1 - start.rax_1) >= JOG_MOVED_DEG, MAX_JOGS);
      run.record.jogOut = { value, sent: out.sent, steps: out.steps, refusal: out.refusal ? describeError(out.refusal) : null, locks: heldLocks(m) };
      if (out.sent === 0) {
        const r = out.refusal!;
        if (ctx.lane === 'rw7' && !run.rmmpGranted) {
          // RobotManager.jog checks no RMMP privilege of its own: the motion
          // mastership request and the jog are sent and the controller
          // decides, so without the grant the refusal is the controller's
          // answer, typed and explained.
          ctx.note('manual jog without RMMP', { posts: requestsAfter(ctx, jogMarker).filter(x => x.method === 'POST').map(x => x.path) });
          expect(r.httpStatus ?? 0, 'refused by the controller, not before sending').toBeGreaterThanOrEqual(400);
          expect(r.refusal, 'the refusal is explained').toBeDefined();
        }
        const rmmp = ctx.lane === 'rw7' ? `RMMP ${JSON.stringify(run.record.rmmp)}; ` : '';
        return `${rmmp}the first jog was refused (${r.code}${r.controllerCode ? ` ${r.controllerCode}` : ''}${r.refusal ? `, ${r.refusal.kind}` : ''}): ${r.message}`;
      }

      // Read back from the controller: axis 1 moved in the jog's direction, nothing else moved.
      const after = await settledJoints(ctx);
      const d = jointDeltas(start, after);
      run.record.readBack = { deltaDeg: d.map(round6), jogs: out.sent };
      expect(Math.abs(d[0]), 'axis 1 moved after the accepted jogs').toBeGreaterThanOrEqual(JOG_MOVED_DEG);
      expect(Math.sign(d[0]), 'axis 1 moved in the direction of the jog').toBe(Math.sign(value));
      expect(maxAbs(d.slice(1)), 'no other axis moved').toBeLessThan(JOG_OTHERS_DEG);
      // The manager's state follows the controller.
      await waitUntil(async () => {
        await m.refresh();
        return !!m.state.joints && Math.abs(m.state.joints.rax_1 - after.rax_1) < JOG_STEP_SEEN_DEG;
      }, 10_000, 250, 'manager joints follow the jog');

      // Jog back the other way until axis 1 reaches or crosses its start.
      const back = await jogLeg(ctx, start, -value, now => {
        const r = now.rax_1 - start.rax_1;
        return Math.sign(r) !== Math.sign(value) || Math.abs(r) < JOG_STEP_SEEN_DEG;
      }, out.sent + 3);
      const end = await settledJoints(ctx);
      const e = jointDeltas(start, end);
      run.record.jogBack = {
        sent: back.sent, steps: back.steps, refusal: back.refusal ? describeError(back.refusal) : null, endDeltaDeg: e.map(round6),
      };
      run.record.changeCount = { before: countBefore, after: await m.getMotionChangeCount() };
      expect(back.refusal, 'the jog back was accepted').toBeNull();
      expect(back.sent, 'jogs sent back').toBeGreaterThan(0);
      expect(Math.sign(e[0]) !== Math.sign(value) || Math.abs(e[0]) < Math.abs(d[0]), 'axis 1 came back toward its start').toBe(true);
      expect(maxAbs(e.slice(1)), 'no other axis moved on the way back').toBeLessThan(JOG_OTHERS_DEG);
      expect(maxAbs(e), 'the robot is back at its start joints').toBeLessThanOrEqual(BACK_AT_START_DEG);
      return null;
    };

    let skipReason: string | null = null;
    try {
      skipReason = await body();
    } finally {
      await leaveManual(ctx, run, start);
      ctx.note('manual-mode jog', run.record);
      const report = await ctx.restore();
      ctx.note('restore after the manual-mode jog', { actions: report.actions, residual: report.residual });
    }
    // The way back is checked even when the jog could not run.
    const now = await expectBackInAuto(ctx, run);
    if (ctx.lane === 'rw8') {
      // RobotWare 8: after a mode change the controller waits in guard stop
      // for a Reset. When the mode never left Auto, the state is as before.
      expect(now.ctrlstate, run.reachedManual ? 'RobotWare 8 back in Auto after MANR' : 'RobotWare 8, the mode never changed')
        .toBe(run.reachedManual ? 'guardstop' : p0.ctrlstate);
    }
    expect(maxAbs(jointDeltas(start, await readJoints(ctx))), 'the robot at its start joints').toBeLessThanOrEqual(BACK_AT_START_DEG);
    if (skipReason) { ctx.skip(t, skipReason); }
  }, MANUAL_TEST_MS);

  it('RW8: runs the ZZ_PROBE joint move out and back in manual reduced speed with the virtual enable switch held; the joints and the robot target change while it runs, and the robot ends at its start joints within 0.1 degree', async t => {
    if (ctx.lane !== 'rw8') {
      ctx.skip(t, 'RobotWare 8 only: RobotWare 6 and 7 run the program move in Auto with RWS motors on (the out-and-back test above)');
    }
    await ctx.requireAllowed(t, 'manual-mode');
    await ctx.requireAllowed(t, 'vc-sim');
    const p0 = await ctx.panel();
    if (p0.opmode !== 'AUTO') { ctx.skip(t, `the test starts from Auto; the controller reads ${p0.opmode}`); }
    if (p0.execstate === 'running') { throw new Error('RAPID is running - this test needs it stopped'); }
    const m = ctx.manager;
    const run = newManualRun(ctx);
    run.record.before = p0;
    const why = await rw8ManualPrecheck(ctx, run, p0);
    if (why) { ctx.note('RW8 manual run not started', run.record); ctx.skip(t, why); }
    const start = await settledJoints(ctx);
    ctx.defer('robot back at the start joints of the RW8 manual run (teleport)', () => teleportBack(ctx, start));
    ctx.defer('simulated panel released after the RW8 manual run', async () => releaseSimPanel(await ctx.ensureManager(), run.engaged));

    // In Auto, before the switch: RobotWare 8 refuses the execution cycle and
    // the speed ratio in manual mode.
    const startPose = poseOf(await m.getCartesianFull(ctx.mechunit));
    const axis1Deg = towardZero(start.rax_1, 3);
    const wristDeg = towardZero(start.rax_4, 6);
    const mod = zzMotionModule({ name: 'ZZ_PROBE_MANR', axis1Deg, wristDeg, speed: 'v20', loops: 1 });
    await ctx.loadModule(mod);
    await pointAtEntry(ctx, mod);
    if ((p0.speedRatio ?? 100) > MOTION_LIMITS.maxSpeedRatio) {
      await m.setSpeedRatio(MOTION_LIMITS.maxSpeedRatio);
      await waitUntil(async () => (await ctx.panel()).speedRatio === MOTION_LIMITS.maxSpeedRatio, 10_000, 250, 'speed ratio 50');
    }

    const body = async (): Promise<string | null> => {
      await declareMotionControl(ctx, run);
      try {
        await switchToManr(ctx, run);
      } catch (e) {
        if (!(e instanceof RwsError)) { throw e; }
        run.record.toManualFinal = describeError(e);
        return `RobotWare 8 refused the switch to MANR: ${e.code} ${e.controllerCode ?? ''} - ${e.message}`;
      }
      const pp = await m.getCurrentPP(ctx.task);
      run.record.ppInManual = pp;
      if (pp?.module?.toUpperCase() !== mod.name.toUpperCase() || pp?.routine?.toLowerCase() !== mod.routines.entry.toLowerCase()) {
        return `the program pointer did not stay at ${mod.name}/${mod.routines.entry} across the switch to MANR (reads ${JSON.stringify(pp)})`;
      }
      const motorsOnBy = await holdEnableSwitch(ctx, run);
      run.record.motorsOnBy = motorsOnBy;
      if (!motorsOnBy) {
        return `in MANR with the virtual enable switch held the motors did not come on: ${JSON.stringify(run.record.enableSwitch)}`;
      }

      const sentAt = Date.now();
      try {
        await m.startRapid();
        run.record.start = 'accepted';
      } catch (e) {
        run.record.start = describeError(e);
        if (!(e instanceof RwsError)) { throw e; }
        return `RobotWare 8 refused the RAPID start in manual reduced speed: ${e.code} ${e.controllerCode ?? ''} ${e.refusal?.kind ?? ''} - ${e.message}`;
      }
      const w = await watchRun(ctx, mod, start, startPose, Date.now() - sentAt);
      run.record.run = { axis1Deg, wristDeg, ...w, maxAxisDeg: round3(w.maxAxisDeg) };
      expect(w.finished, `the routine finished (done = 1, execution stopped): ${unfinished(w.run)}`).toBe(true);
      expect(w.sawRunning, 'the manager state read running during the run').toBe(true);
      expect(Math.max(w.maxAxisDeg[0], w.maxAxisDeg[3], w.maxAxisDeg[5]), 'the moved axes showed in the manager joints').toBeGreaterThan(MOVED_DEG);
      expect(Math.max(w.maxAxisDeg[1], w.maxAxisDeg[2], w.maxAxisDeg[4]), 'axes 2, 3 and 5 stayed').toBeLessThan(MOVED_DEG);
      expect(w.maxMm > 0.1 || w.maxQuat > 1e-4, `robot target change: ${w.maxMm.toFixed(3)} mm, quaternion ${w.maxQuat.toExponential(2)}`).toBe(true);
      expect(await readNum(ctx, mod, 'loops')).toBe(1);
      // Read back from the controller: at the start joints within 0.1 degree.
      const end = await settledJoints(ctx);
      const back = jointDeltas(start, end);
      run.record.endDeltaDeg = back.map(round6);
      expect(maxAbs(back), 'the robot ends at its start joints').toBeLessThanOrEqual(BACK_AT_START_DEG);
      return null;
    };

    let skipReason: string | null = null;
    try {
      skipReason = await body();
    } finally {
      await leaveManual(ctx, run, start);
      ctx.note('RW8 program move in manual reduced speed', run.record);
      const report = await ctx.restore();
      ctx.note('restore after the RW8 manual run', { actions: report.actions, residual: report.residual });
    }
    const now = await expectBackInAuto(ctx, run);
    // Guard stop awaiting a Reset after a mode change; as before when the mode never left Auto.
    expect(now.ctrlstate, run.reachedManual ? 'RobotWare 8 back in Auto waits in guard stop for a Reset' : 'RobotWare 8, the mode never changed')
      .toBe(run.reachedManual ? 'guardstop' : p0.ctrlstate);
    expect(now.execstate).toBe('stopped');
    expect(maxAbs(jointDeltas(start, await readJoints(ctx))), 'the robot at its start joints').toBeLessThanOrEqual(BACK_AT_START_DEG);
    if (skipReason) { ctx.skip(t, skipReason); }
  }, MANUAL_TEST_MS);

  // ─── The end state ─────────────────────────────────────────────────────────

  it('leaves the controller as the baseline found it, the robot at its baseline joints', async () => {
    const report = await ctx.restore();
    ctx.note('final restore', { actions: report.actions, residual: report.residual });
    expect(report.residual).toEqual([]);
    const now = await ctx.snapshot();
    expect(now.errors).toEqual([]);
    expect(diffSnapshots(ctx.baseline, now)).toEqual([]);
    if (ctx.baseline.joints && now.joints) {
      expect(maxAbs(jointDeltas(ctx.baseline.joints, now.joints))).toBeLessThanOrEqual(BACK_AT_START_DEG);
    }
  });
});
