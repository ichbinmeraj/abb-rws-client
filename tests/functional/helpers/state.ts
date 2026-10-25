/**
 * Snapshot and restore of what a functional test may change on a controller,
 * and polling with a deadline.
 *
 * The snapshot is read through the harness's observer (its own session on
 * RWS 2.0; the manager's own adapter on RWS 1.0, see harness.ts), never from
 * the manager's cached state, so it records what the controller says at the
 * time. Restore goes through the manager under test, because that
 * is the session that may hold mastership or write access, and every write
 * there takes the access it needs the normal way.
 *
 * `restoreState` is idempotent and never throws: each step is tried, logged to
 * the lane's trace and reported, and the next step runs whatever happened.
 * Run twice on a clean controller it does nothing.
 *
 * Test infrastructure only - never shipped in the package.
 */

import type { IRWSAdapter, JointTarget, MastershipDomain, RobotManager } from '../../../src/index.js';
import { isProbeName, type Generation, type Lane } from './config.js';
import { harnessNote } from './trace.js';
import { followPanel, managerRws2 } from './vc.js';

/** How long restoreState waits for a guard stop to clear before motors on, ms (RobotWare 7 after a teleport: about 5 s). */
const GUARD_STOP_WAIT_MS = 30_000;
/** The controller state after that guard stop counts as at rest when it holds this long, ms. */
const GUARD_STOP_HOLD_MS = 2_000;

// ─── Polling ─────────────────────────────────────────────────────────────────

/**
 * Poll `predicate` every `pollMs` until it returns true or `timeoutMs` has
 * passed. Resolves true when met, false on timeout; never throws (a predicate
 * that throws counts as not met).
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>, timeoutMs: number, pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await predicate()) { return true; } } catch { /* not met yet */ }
    if (Date.now() >= deadline) { return false; }
    await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * Like `waitFor`, but throws `"<label> not met within <timeoutMs> ms"` on
 * timeout, with the predicate's last error when it threw.
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>, timeoutMs: number, pollMs = 250, label = 'condition',
): Promise<void> {
  let lastError: unknown;
  const met = await waitFor(async () => {
    try { return await predicate(); } catch (e) { lastError = e; return false; }
  }, timeoutMs, pollMs);
  if (!met) {
    const why = lastError === undefined ? '' : ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
    throw new Error(`${label} not met within ${timeoutMs} ms${why}`);
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** The file-system roots of a generation: RWS 1.0 `$HOME`/`$TEMP`, RWS 2.0 `HOME`/`TEMP`. */
export function volumeRoots(generation: Generation): { home: string; temp: string } {
  return generation === 'rws1' ? { home: '$HOME', temp: '$TEMP' } : { home: 'HOME', temp: 'TEMP' };
}

export interface PanelState {
  opmode: string | null;
  ctrlstate: string | null;
  speedRatio: number | null;
  execstate: string | null;
}

/** Operation mode, controller state, speed ratio and RAPID execution state, straight from the controller. */
export async function readPanel(adapter: IRWSAdapter): Promise<PanelState> {
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
  const [opmode, ctrlstate, speedRatio, execstate] = await Promise.all([
    safe(() => adapter.getOperationMode()),
    safe(() => adapter.getControllerState()),
    safe(() => adapter.getSpeedRatio()),
    safe(() => adapter.getRapidExecutionState()),
  ]);
  return { opmode, ctrlstate, speedRatio, execstate };
}

export interface ProgramPointer { module?: string; routine?: string; row?: number; col?: number }

export interface ProbeEntry { path: string; type: 'file' | 'dir' }

export interface StateSnapshot {
  lane: Lane;
  takenAt: string;
  opmode: string | null;
  ctrlstate: string | null;
  speedRatio: number | null;
  execstate: string | null;
  execCycle: string | null;
  tasks: Array<{ name: string; active: boolean; motiontask: boolean }>;
  /** Modules of every task, as listed by the controller. */
  modulesByTask: Record<string, string[]>;
  /** Program pointer per task; `{}` when the task has none set. */
  programPointers: Record<string, ProgramPointer>;
  joints: JointTarget | null;
  /** ZZ_PROBE files and directories at the top of HOME and TEMP. */
  probeEntries: ProbeEntry[];
  /** ZZ_PROBE DIPC queues. */
  probeQueues: string[];
  /**
   * RobotWare 8: the allow-motion-control declaration, read through the
   * lane's manager (the suite's own control station, whose declaration the
   * manual-mode tests make); null on other lanes, while the manager is not
   * connected, or when the read failed (noted in the trace, not in `errors`).
   */
  allowMotionControl: boolean | null;
  /** Reads that failed, `"<what>: <message>"`. A snapshot never throws. */
  errors: string[];
}

/** An operating mode that reads a change waiting for its confirmation at the FlexPendant (AUTO_CH, ...). */
export function isPendingModeChange(opmode: string | null | undefined): boolean {
  return typeof opmode === 'string' && /_CH$/.test(opmode);
}

/**
 * The environment blocker of a lane whose baseline does not read Auto, or
 * null when the mode is fit for a baseline. A pending change (AUTO_CH, ...)
 * waits for someone at the FlexPendant, and a manual mode was left by a
 * person or an earlier run; either way the restore must not put it back, so
 * it is never taken as the baseline and the lane is skipped. An unread mode
 * (null) is not a blocker here: the snapshot reports the failed read.
 */
export function baselineBlocker(lane: Lane, opmode: string | null | undefined): string | null {
  if (opmode === null || opmode === undefined || opmode === 'AUTO') { return null; }
  const what = isPendingModeChange(opmode)
    ? `a change of operating mode waits for its confirmation at the FlexPendant (${opmode})`
    : `the controller is in ${opmode}, not Auto`;
  return `environment blocker: ${what} - confirm Auto at the ${lane.toUpperCase()} pendant`;
}

/** What state.ts needs from the harness context. */
export interface StateTarget {
  readonly lane: Lane;
  readonly generation: Generation;
  /** The manager under test while it is connected, else null. */
  connectedManager(): RobotManager | null;
  /** The session restore writes through (reconnected first if a test disconnected it). */
  ensureManager(): Promise<RobotManager>;
  /** An independent read session owned by the harness. */
  observer(): Promise<IRWSAdapter>;
}

/** Joint difference (degrees) below which the robot counts as back where it was. */
export const JOINT_TOLERANCE_DEG = 0.5;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * RobotWare 8: the allow-motion-control declaration of the suite's station,
 * read through the lane's manager. The declaration belongs to a control
 * station, and the manager's session is the suite's station (the harness's
 * observer is another session). Never throws.
 */
async function readAllowMotionControl(target: StateTarget): Promise<boolean | null> {
  if (target.lane !== 'rw8') { return null; }
  const m = target.connectedManager();
  const a = m ? managerRws2(m) : null;
  if (!a) { return null; }
  try {
    return await a.getAllowMotionControl();
  } catch (e) {
    harnessNote('allow-motion-control could not be read through the manager', { error: msg(e) });
    return null;
  }
}

/** Read everything restore may put back. Never throws; failed reads land in `errors`. */
export async function snapshotState(target: StateTarget): Promise<StateSnapshot> {
  const errors: string[] = [];
  const snap: StateSnapshot = {
    lane: target.lane, takenAt: new Date().toISOString(),
    opmode: null, ctrlstate: null, speedRatio: null, execstate: null, execCycle: null,
    tasks: [], modulesByTask: {}, programPointers: {}, joints: null,
    probeEntries: [], probeQueues: [], allowMotionControl: null, errors,
  };
  let adapter: IRWSAdapter;
  try { adapter = await target.observer(); } catch (e) { errors.push(`observer session: ${msg(e)}`); return snap; }
  const read = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) { errors.push(`${what}: ${msg(e)}`); return null; }
  };

  const [opmode, ctrlstate, speedRatio, exec, tasks, joints] = await Promise.all([
    read('opmode', () => adapter.getOperationMode()),
    read('ctrlstate', () => adapter.getControllerState()),
    read('speed ratio', () => adapter.getSpeedRatio()),
    read('execution', () => adapter.getRapidExecutionInfo()),
    read('tasks', () => adapter.getRapidTasks()),
    read('joints', () => adapter.getJointPositions()),
  ]);
  snap.opmode = opmode;
  snap.ctrlstate = ctrlstate;
  snap.speedRatio = speedRatio;
  snap.execstate = exec?.state ?? null;
  snap.execCycle = exec?.cycle ?? null;
  snap.joints = joints;
  snap.tasks = (tasks ?? []).map(t => ({ name: t.name, active: t.active, motiontask: t.motiontask }));

  for (const t of snap.tasks) {
    const mods = await read(`modules of ${t.name}`, () => adapter.listModules(t.name));
    if (mods) { snap.modulesByTask[t.name] = mods; }
    if (adapter.getProgramPointer) {
      const pp = await read(`program pointer of ${t.name}`, () => adapter.getProgramPointer!(t.name));
      snap.programPointers[t.name] = pp ? stripPointer(pp) : {};
    }
  }

  const roots = volumeRoots(target.generation);
  for (const root of [roots.home, roots.temp]) {
    const entries = await read(`listing of ${root}`, () => adapter.listDirectory(root));
    for (const e of entries ?? []) {
      if (isProbeName(e.name)) { snap.probeEntries.push({ path: `${root}/${e.name}`, type: e.type }); }
    }
  }
  if (adapter.listDipcQueues) {
    const queues = await read('DIPC queues', () => adapter.listDipcQueues!());
    snap.probeQueues = (queues ?? []).map(q => q.name).filter(isProbeName);
  }
  snap.allowMotionControl = await readAllowMotionControl(target);
  return snap;
}

function stripPointer(pp: ProgramPointer): ProgramPointer {
  const out: ProgramPointer = {};
  if (pp.module) { out.module = pp.module; }
  if (pp.routine) { out.routine = pp.routine; }
  if (pp.row !== undefined && Number.isFinite(pp.row)) { out.row = pp.row; }
  if (pp.col !== undefined && Number.isFinite(pp.col)) { out.col = pp.col; }
  return out;
}

/** ZZ_PROBE modules loaded in any task of a snapshot, as `[task, module]`. */
export function probeModules(s: StateSnapshot): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [task, mods] of Object.entries(s.modulesByTask)) {
    for (const m of mods) { if (isProbeName(m)) { out.push([task, m]); } }
  }
  return out;
}

/**
 * The differences restore cares about between two snapshots, as sentences
 * (`speed ratio 50, expected 100`). Joints, timestamps and read errors are not
 * compared; a program pointer is compared only where `expected` had one. The
 * RobotWare 8 allow-motion-control declaration is compared in one direction
 * only: reading true where `expected` read false is a declaration left behind;
 * the other way round is the safe side, and no test turns a declaration off.
 */
export function diffSnapshots(expected: StateSnapshot, actual: StateSnapshot): string[] {
  const out: string[] = [];
  const cmp = (what: string, want: unknown, got: unknown): void => {
    if (want !== null && want !== undefined && want !== got) { out.push(`${what} ${String(got)}, expected ${String(want)}`); }
  };
  cmp('opmode', expected.opmode, actual.opmode);
  cmp('ctrlstate', expected.ctrlstate, actual.ctrlstate);
  cmp('speed ratio', expected.speedRatio, actual.speedRatio);
  cmp('execution', expected.execstate, actual.execstate);
  if (expected.execCycle === 'once' || expected.execCycle === 'forever') {
    cmp('execution cycle', expected.execCycle, actual.execCycle);
  }
  if (expected.joints && actual.joints) {
    for (let i = 1; i <= 6; i++) {
      const k = `rax_${i}` as keyof JointTarget;
      const d = Math.abs(actual.joints[k] - expected.joints[k]);
      if (d > JOINT_TOLERANCE_DEG) {
        out.push(`axis ${i} at ${actual.joints[k].toFixed(3)} deg, expected ${expected.joints[k].toFixed(3)} (the robot is not back where it was)`);
      }
    }
  }
  for (const [task, mods] of Object.entries(expected.modulesByTask)) {
    const got = actual.modulesByTask[task];
    if (!got) { continue; }
    const want = mods.filter(m => !isProbeName(m)).sort().join(',');
    const have = got.filter(m => !isProbeName(m)).sort().join(',');
    if (want !== have) { out.push(`modules of ${task} [${have}], expected [${want}]`); }
  }
  for (const [task, mod] of probeModules(actual)) { out.push(`${mod} still loaded in ${task}`); }
  for (const e of actual.probeEntries) { out.push(`${e.path} still on the controller`); }
  for (const q of actual.probeQueues) { out.push(`DIPC queue ${q} still exists`); }
  for (const [task, pp] of Object.entries(expected.programPointers)) {
    if (!pp.module || !pp.routine || isProbeName(pp.module)) { continue; }
    const got = actual.programPointers[task] ?? {};
    if (got.module !== pp.module || got.routine !== pp.routine) {
      out.push(`program pointer of ${task} ${got.module ?? '-'}/${got.routine ?? '-'}, expected ${pp.module}/${pp.routine}`);
    }
  }
  if (expected.allowMotionControl === false && actual.allowMotionControl === true) {
    out.push('allow-motion-control true, expected false (a motion-control declaration left behind for the suite\'s station)');
  }
  return out;
}

// ─── Restore ─────────────────────────────────────────────────────────────────

export interface RestoreStep { step: string; ok: boolean; detail?: string }

export interface RestoreReport {
  /** True when every action succeeded and nothing differs from the baseline afterwards. */
  ok: boolean;
  /** What restore did (only steps that had something to do). Empty on a clean controller. */
  actions: RestoreStep[];
  /** Differences left after restore (`diffSnapshots(baseline, after)`), plus known limits. */
  residual: string[];
  /** The state read after restore, or null when it could not be read. */
  after: StateSnapshot | null;
}

/** The public mastership domain that owns a lock of `RobotState.access`. */
function domainOfLock(lock: string): MastershipDomain {
  if (lock === 'motion') { return 'motion'; }
  if (lock === 'cfg') { return 'cfg'; }
  return 'rapid'; // rapid (RW6), edit (RW7), writeaccess (RW8)
}

/** Release every hold the manager still counts. Returns the steps taken. */
export async function releaseHolds(manager: RobotManager): Promise<RestoreStep[]> {
  const steps: RestoreStep[] = [];
  for (let round = 0; round < 8; round++) {
    const held = (manager.state.access?.locks ?? []).filter(l => l.state === 'held' && l.count > 0);
    if (held.length === 0) { break; }
    let progressed = false;
    for (const l of held) {
      const domain = domainOfLock(l.lock);
      try {
        await manager.releaseMastership(domain);
        steps.push({ step: `release ${l.lock} (${domain})`, ok: true });
        progressed = true;
      } catch (e) {
        steps.push({ step: `release ${l.lock} (${domain})`, ok: false, detail: msg(e) });
      }
    }
    if (!progressed) { break; }
  }
  return steps;
}

/** Delete a controller path; a directory is emptied first (its entries listed through the observer). */
async function deleteTree(manager: RobotManager, observer: IRWSAdapter, entry: ProbeEntry, steps: RestoreStep[], depth = 0): Promise<void> {
  if (entry.type === 'dir' && depth < 6) {
    let children: Array<{ name: string; type: 'file' | 'dir' }> = [];
    try { children = await observer.listDirectory(entry.path); } catch (e) {
      steps.push({ step: `list ${entry.path}`, ok: false, detail: msg(e) });
    }
    for (const c of children) {
      await deleteTree(manager, observer, { path: `${entry.path}/${c.name}`, type: c.type }, steps, depth + 1);
    }
  }
  try {
    await manager.deleteControllerFile(entry.path);
    if (depth === 0) { steps.push({ step: `delete ${entry.path}`, ok: true }); }
  } catch (e) {
    steps.push({ step: `delete ${entry.path}`, ok: false, detail: msg(e) });
  }
}

/**
 * Put the controller back to `baseline`, in this order: release the
 * manager's holds; stop RAPID; motors off if the baseline had them off;
 * unload every ZZ_PROBE module; delete ZZ_PROBE files and directories in
 * HOME and TEMP and ZZ_PROBE DIPC queues; program pointer back where the
 * baseline had one; speed ratio; RobotWare 8: the allow-motion-control
 * declaration back to false where the baseline read false; operation mode;
 * motors on if the baseline had them on; release holds again. Idempotent,
 * never throws.
 *
 * Known limits, reported in `residual` rather than worked around: RobotWare 8
 * refuses motors on over RWS (the pendant does it), and a switch to Auto may
 * wait for a confirmation at the FlexPendant (AUTO_CH). A controller that
 * reads such a pending change is never sent the switch again: the
 * confirmation is the person's at the FlexPendant, and setOperationMode does
 * not send it; a switch sent again does not give it (RW 7.21.4 answered
 * 500 -1073414146 and RW 8.2.1 refused write access; live 2026-09-30). Nor
 * are the motors switched on then (the mode is not Auto yet). And while
 * RobotWare 8 reads a pending change no remote station can take write access
 * (RW 8.2.1 refused every request with 403 -1073414145, live 2026-09-30), so
 * nothing is written then at all: confirm the change at the FlexPendant and
 * restore again.
 */
export async function restoreState(target: StateTarget, baseline: StateSnapshot): Promise<RestoreReport> {
  const actions: RestoreStep[] = [];
  const residual: string[] = [];
  const run = async (step: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      actions.push({ step, ok: true });
      return true;
    } catch (e) {
      actions.push({ step, ok: false, detail: msg(e) });
      return false;
    }
  };

  try {
    await target.observer();
  } catch (e) {
    const report: RestoreReport = { ok: false, actions: [{ step: 'open the observer session', ok: false, detail: msg(e) }], residual: ['state could not be read'], after: null };
    harnessNote('restore could not start', report);
    return report;
  }
  // Asked for at each read, never kept: on the RWS 1.0 lane the observer is
  // the manager's own adapter, which changes when the manager reconnects.
  const panel = async (): Promise<PanelState> => readPanel(await target.observer());

  // A connected manager may still count holds a test took; a disconnected one
  // holds nothing (its session ended with them).
  const connected = target.connectedManager();
  if (connected) { actions.push(...await releaseHolds(connected)); }

  const current = await snapshotState(target);
  // Differences restore can act on. Joints are compared but never "restored":
  // restore does not move the robot.
  const writable = diffSnapshots(baseline, current).filter(d => !d.startsWith('axis '));
  const pendingMode = isPendingModeChange(current.opmode);

  if (writable.length > 0 && target.lane === 'rw8' && pendingMode) {
    residual.push(`the controller reads ${current.opmode}: a change of operating mode waits for the confirmation at the FlexPendant, `
      + 'and until it is confirmed RobotWare 8 gives no remote station write access, so nothing was written - confirm it at the FlexPendant '
      + 'and restore again');
  } else if (writable.length > 0) {
    try {
      // Reconnected only when there is something to write.
      const manager = await target.ensureManager();

      if (current.execstate === 'running') {
        await run('stop RAPID', async () => {
          await manager.stopRapid();
          if (!await waitFor(async () => (await panel()).execstate === 'stopped', 15000)) {
            throw new Error('execution did not read stopped within 15 s');
          }
        });
      }

      if (baseline.ctrlstate !== 'motoron' && current.ctrlstate === 'motoron') {
        await run('motors off', async () => {
          await manager.setMotorsOff();
          await waitFor(async () => (await panel()).ctrlstate !== 'motoron', 10000);
        });
      }

      for (const [task, mod] of probeModules(current)) {
        await run(`unload ${mod} from ${task}`, () => manager.unloadModule(task, mod, { stopIfRunning: true }));
      }

      for (const entry of current.probeEntries) {
        const steps: RestoreStep[] = [];
        await deleteTree(manager, await target.observer(), entry, steps);
        actions.push(...steps);
      }

      for (const q of current.probeQueues) {
        await run(`remove DIPC queue ${q}`, () => manager.removeDipcQueue(q).then(() => undefined));
      }

      for (const [task, pp] of Object.entries(baseline.programPointers)) {
        if (!pp.module || !pp.routine || isProbeName(pp.module)) { continue; }
        const got = current.programPointers[task] ?? {};
        if (got.module === pp.module && got.routine === pp.routine) { continue; }
        await run(`program pointer of ${task} to ${pp.module}/${pp.routine}`, () =>
          (pp.routine === 'main' ? manager.resetRapid() : manager.setPPToRoutine(task, pp.module!, pp.routine!, { stopIfRunning: true })));
      }

      if ((baseline.execCycle === 'once' || baseline.execCycle === 'forever') && current.execCycle !== baseline.execCycle) {
        await run(`execution cycle ${current.execCycle} -> ${baseline.execCycle}`, () =>
          manager.setExecutionCycle(baseline.execCycle as 'once' | 'forever'));
      }

      if (baseline.speedRatio !== null && current.speedRatio !== baseline.speedRatio) {
        await run(`speed ratio ${current.speedRatio} -> ${baseline.speedRatio}`, () => manager.setSpeedRatio(baseline.speedRatio!));
      }

      if (baseline.allowMotionControl === false && current.allowMotionControl === true) {
        // Before the operation mode: write access may not be available after
        // a switch (see above). Only ever put back to false, the safe side: a
        // declaration is a person's, and restore never makes one.
        await run('allow-motion-control true -> false', async () => {
          const a = managerRws2(manager);
          if (!a) { throw new Error('the RobotWare 8 lane has no RWS 2.0 manager session'); }
          await manager.requestMastership('rapid');
          try {
            await a.setAllowMotionControl(false);
            if (await a.getAllowMotionControl()) { throw new Error('allow-motion-control still reads true after the put-back'); }
          } finally {
            await manager.releaseMastership('rapid').catch(e => harnessNote('write-access release after the motion-control put-back failed', { error: msg(e) }));
          }
        });
      }

      if (baseline.opmode && current.opmode !== baseline.opmode && pendingMode) {
        // Nothing is sent: see the function comment.
        residual.push(`operation mode reads ${current.opmode}: the switch waits for the confirmation at the FlexPendant - confirm it there `
          + '(sending the switch again does not confirm it, so restore does not)');
      } else if (baseline.opmode && current.opmode !== baseline.opmode) {
        const want = baseline.opmode as 'AUTO' | 'MANR' | 'MANF';
        await run(`operation mode ${current.opmode} -> ${want}`, async () => {
          await manager.setOperationMode(want);
          const landed = await waitFor(async () => (await panel()).opmode === want, 10000);
          if (!landed) {
            const now = (await panel()).opmode;
            throw new Error(now === 'AUTO_CH'
              ? 'the controller reads AUTO_CH: the switch to Auto waits for a confirmation at the FlexPendant'
              : `operation mode reads ${now} after 10 s`);
          }
        });
      }

      if (baseline.ctrlstate === 'motoron' && !pendingMode) {
        let now = (await panel()).ctrlstate;
        if (now === 'guardstop' && target.lane !== 'rw8') {
          // A motors on sent inside a guard stop is refused: on 2026-10-22
          // (RW 7.21.4) one sent 2.1 s after a teleport got 403
          // SYS_CTRL_E_REJECT, and a teleport in Auto there passes through
          // guard stop and rests in motors off about 5 s later. Whatever
          // caller left the controller there (a test that failed right after
          // a teleport, a teleport back that did not wait), the panel is
          // read, nothing else, until the controller state reads something
          // other than guard stop for GUARD_STOP_HOLD_MS, at most
          // GUARD_STOP_WAIT_MS. On RobotWare 8 guard stop is the rest state
          // in Auto and motors on is not sent anyway (below).
          const trail = await followPanel(panel, {
            until: p => p.ctrlstate !== null && p.ctrlstate !== 'guardstop',
            stableMs: GUARD_STOP_HOLD_MS, timeoutMs: GUARD_STOP_WAIT_MS, pollMs: 500,
          });
          harnessNote(trail.met
            ? 'restore: the guard stop cleared before motors on'
            : `restore: the controller state still read guard stop after ${GUARD_STOP_WAIT_MS / 1000} s`,
          { seen: trail.seen, ms: trail.ms });
          now = trail.met ? trail.last.ctrlstate : 'guardstop';
        }
        if (now === 'guardstop' && target.lane !== 'rw8') {
          residual.push(`the controller still reads guard stop after ${GUARD_STOP_WAIT_MS / 1000} s, so motors on was not sent `
            + '(the controller refuses it there)');
        } else if (now !== 'motoron') {
          if (target.lane === 'rw8') {
            residual.push('motors are off: RobotWare 8 refuses motors on over RWS - switch them on at the FlexPendant');
          } else {
            await run('motors on', async () => {
              await manager.setMotorsOn();
              if (!await waitFor(async () => (await panel()).ctrlstate === 'motoron', 10000)) {
                throw new Error(`ctrlstate reads ${(await panel()).ctrlstate} after 10 s`);
              }
            });
          }
        }
      }

      actions.push(...await releaseHolds(manager));
    } catch (e) {
      actions.push({ step: 'restore', ok: false, detail: msg(e) });
    }
  }

  let after: StateSnapshot | null = null;
  try {
    after = actions.length > 0 ? await snapshotState(target) : current;
    for (const d of diffSnapshots(baseline, after)) {
      if (!residual.includes(d)) { residual.push(d); }
    }
  } catch (e) {
    residual.push(`state after restore could not be read: ${msg(e)}`);
  }

  const report: RestoreReport = { ok: actions.every(a => a.ok) && residual.length === 0, actions, residual, after };
  harnessNote(report.ok ? `restore ok (${actions.length} action(s))` : 'restore left differences', {
    actions, residual,
  });
  return report;
}
