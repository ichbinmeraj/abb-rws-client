/**
 * Functional RAPID execution without motion, per controller, through
 * RobotManager: the task list and execution state of an idle program; a
 * ZZ_PROBE module with a counter loop (WaitTime between counts) loaded and
 * the program pointer set to its routine and to main; start, running seen in
 * the manager's state and in its events, stop, stopped seen; a second start
 * continuing where the stop left off; the refusal to move the program pointer
 * while the program runs; a routine run to its end, with the execution cycle
 * set to once; a string with '%' in it written through the client and
 * checked from the RAPID side (StrLen and a compare with a RAPID literal);
 * and the typed refusals of a start the controller state or another
 * session's access does not allow.
 *
 * Nothing here moves an axis: the modules only count, wait, compare strings
 * and set flags.
 *
 * - The '%' string (live 2026-10-01): on RW 6.16.03 and RW 7.21.4 the
 *   routine measures the written text at its full length and equal to the
 *   literal, and a string the routine assigned reads back as assigned. Not
 *   run on RW 8.2.1 (motors on is a pendant action there).
 * Starting RAPID still needs the motors on, so the run tests go through
 * `ctx.prepareMotion(t, { kind: 'rapid-start' })`: on RW6 and RW7 it switches
 * the motors on (restore puts the baseline back); on RW8 motors on is a
 * pendant action, so the run tests skip there unless the motors are already
 * on ("needs motors on from the RW8 pendant"). RW8 also refuses a start from
 * a remote station until that session declares motion control (403
 * -1073435864 on RW 8.2.1, also for these counters, which move nothing;
 * 2026-10-18), so the run tests there need
 * RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<the controller's system name>, set by a
 * person at its virtual FlexPendant: prepareMotion then allows motion control
 * in the manager's session, and the lane's teardown and the client's
 * disconnect withdraw it. Without it they skip with the reason.
 *
 * Expectations per build, from the client's doc comments and the recorded
 * live behaviour of these virtual controllers:
 * - Whether the station program has a `main` depends on how the VC was set
 *   up. On 2026-09-29 all three VCs (RW 6.16.03, 7.21.4, 8.2.1) had a Module1
 *   with an empty global `PROC main`; after their restart on 2026-09-30 none
 *   of them has a Module1 (the task holds only system modules: BASE, and
 *   `user` on RW 6.16.03), and at idle the program pointer is unset on all
 *   three. The counter modules therefore declare no `main` of their own; tests
 *   move the program pointer to `<module>_main` and never run a station main.
 * - resetRapid (program pointer to main) on a task with no `main`: 404
 *   -1073442816 on all three builds (live 2026-09-30, RW 6.16.03, 7.21.4 and
 *   8.2.1); the manager types it RESOURCE_NOT_FOUND "no main routine". The
 *   resetRapid test asserts that refusal when the station has no main, then
 *   loads a ZZ_PROBE module with a global `PROC main` (only then, so there is
 *   never a second main) and asserts the reset lands there. With a station
 *   main it asserts the reset lands outside the ZZ_PROBE module.
 * - The execution cycle reads `forever` on all three (live-verified
 *   2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1); set-cycle takes once and
 *   forever.
 * - RW 7.21: a start with no program pointer is refused 403 -1073442809
 *   (SYS_CTRL_E_EXEC_STATE), and that check runs before the mastership check
 *   (recorded 2026-09-15 on RW 7.21). With the program pointer set and the
 *   motors off, RW 7.21.4 answers 403 -1073445806 instead (live-verified
 *   2026-09-30), and so does RW 7.21.0+229 (2026-10-03). The client types
 *   both WRONG_MODE, refusal kind `wrong-state`.
 * - RW8 in guard stop, with write access and the PP set: 403 -1073445806 on
 *   RW 8.2.1 (live 2026-09-30) and on RW 8.1.1+614 (2026-10-03), the same
 *   answer RW 7.21.4 gives with the PP set and the motors off. The -1073442809
 *   recorded on RW 8.1.1 in guard stop on 2026-09-15 is not what the test's
 *   preconditions give; that record most likely had no PP set. The client
 *   explains -1073445806 as the generic controller-state refusal or from the
 *   known safety state. RobotManager takes write access before the start, so
 *   the state refusal is the one it meets.
 * - RW 6.16.03: in Auto with the motors off and the program pointer set, a
 *   start answers 400 -1073445881 with "org_code: -4506" in the message
 *   (live-verified 2026-09-30). The client types it WRONG_MODE with a
 *   `wrong-state` refusal on the motors; its RWS 1.0 path gives MOTORS_OFF
 *   for a 400 whose detail mentions the motors, so both codes are accepted.
 * - Another RW8 control station holding write access refuses this station's
 *   request with -1073435870 (typed MASTERSHIP_REQUIRED, `held-by-other`).
 *   On RW6/RW7 a mastership held by another session is -1073445862
 *   (SYS_CTRL_E_RESOURCE_HELD), typed the same.
 * - `startRapid` never moves the program pointer (client 1.3.x change), and
 *   `setPPToRoutine` refuses while the program runs unless `stopIfRunning`
 *   is given - the client's own rule, typed WRONG_MODE `wrong-state`.
 *
 * Tests titled "records ..." assert only what must hold and write the
 * observed value to the lane's trace: the evidence does not settle them.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import { it, expect } from 'vitest';
import {
  RwsError,
  type ControlStationIdentity, type IRWSAdapter, type RapidTask, type RobotManager,
} from '../../src/index.js';
import {
  forEachController, expectRwsError, waitFor, waitUntil, zzExecModule,
  type FunctionalContext, type GeneratedModule, type TestHandle,
} from './helpers/index.js';

/** The long-running counter: 600 counts, 0.1 s apart (about a minute), stopped by the tests. */
const LONG = zzExecModule({ name: 'ZZ_PROBE_X08' });
/** A short counter that runs to its end in about a second. */
const SHORT = zzExecModule({ name: 'ZZ_PROBE_X08S', loops: 10, waitSec: 0.1 });

/**
 * A program module whose only routine is a global `PROC main` with an empty
 * body, for resetRapid on a station that has no main of its own. Loaded only
 * after the controller has refused the reset for want of a main, so it is
 * never a second main; unloaded again by the test (and by restore, being a
 * ZZ_PROBE module). Never started.
 */
const MAIN: GeneratedModule = {
  name: 'ZZ_PROBE_X08M',
  text: [
    'MODULE ZZ_PROBE_X08M',
    '  PROC main()',
    '    ! Entry routine for the resetRapid test; never started.',
    '  ENDPROC',
    'ENDMODULE',
    '',
  ].join('\n'),
  symbols: {},
  routines: { entry: 'main' },
};

/**
 * The RAPID-side check of a string written through the client with '%' in it:
 * the routine measures the written PERS with StrLen, compares it with a RAPID
 * literal of the same text, and assigns that literal to a second PERS that is
 * then read over RWS. Never moves anything.
 */
const PCT_TEXT = '100% a%25b%41c&d=e+f<g>h%';
const PCT: GeneratedModule = (() => {
  const p = 'zz_probe_x08p';
  const symbols = { written: `${p}_s`, copy: `${p}_copy`, len: `${p}_len`, eq: `${p}_eq`, done: `${p}_done` };
  const routines = { entry: `${p}_main` };
  const text = [
    'MODULE ZZ_PROBE_X08P',
    `  PERS string ${symbols.written} := "";`,
    `  PERS string ${symbols.copy} := "";`,
    `  PERS num ${symbols.len} := -1;`,
    `  PERS bool ${symbols.eq} := FALSE;`,
    `  PERS num ${symbols.done} := 0;`,
    `  PROC ${routines.entry}()`,
    `    ${symbols.len} := StrLen(${symbols.written});`,
    `    ${symbols.eq} := ${symbols.written} = "${PCT_TEXT}";`,
    `    ${symbols.copy} := "${PCT_TEXT}";`,
    `    ${symbols.done} := 1;`,
    '  ENDPROC',
    'ENDMODULE',
    '',
  ].join('\n');
  return { name: 'ZZ_PROBE_X08P', text, symbols, routines };
})();

/** Controller code of resetpp on a task with no main routine (404 on RW 6.16.03, 7.21.4, 8.2.1; live 2026-09-30). */
const NO_MAIN_CODE = -1073442816;

/**
 * The RobotWare 8 control station that holds write access in the
 * held-by-other test. A fixed id, like the harness's own station, so every
 * run registers as the same station.
 */
const HOLDER_STATION: ControlStationIdentity = {
  name: 'abb-rws-client functional holder',
  id: process.env.RWS_FUNCTIONAL_HOLDER_STATION_ID ?? '{6A1D3C52-8E0B-4F7A-9C3D-2B5E8F1A7C08}',
  pincode: '1234',
};

/** RAPID names compare without regard to case (some listings change it). */
const same = (a: string | undefined | null, b: string | undefined | null): boolean =>
  !!a && !!b && a.toUpperCase() === b.toUpperCase();

/** The locks the manager counts as held right now. */
const heldLocks = (m: RobotManager): string[] =>
  (m.state.access?.locks ?? []).filter(l => l.state === 'held' && l.count > 0).map(l => l.lock);

/** The fields of a refusal worth keeping in the trace. */
const errFacts = (e: RwsError): Record<string, unknown> => ({
  code: e.code, httpStatus: e.httpStatus, controllerCode: e.controllerCode,
  refusal: e.refusal ? { kind: e.refusal.kind, condition: e.refusal.condition, grantor: e.refusal.grantor } : null,
  message: e.message,
});

await forEachController('08-rapid-exec', ctx => {
  // ─── Helpers over the lane's context ──────────────────────────────────────

  const execState = async (): Promise<string | null> => (await ctx.panel()).execstate;

  const waitExec = (state: 'running' | 'stopped', timeoutMs = 10000): Promise<void> =>
    waitUntil(async () => (await execState()) === state, timeoutMs, 250, `execution ${state}`);

  /** Stop RAPID if it runs and wait until it reads stopped. */
  const ensureStopped = async (): Promise<void> => {
    if ((await execState()) === 'running') {
      await (await ctx.ensureManager()).stopRapid();
      await waitExec('stopped', 15000);
    }
  };

  /** Load the module unless the task already has it (RAPID must be stopped). */
  const ensureLoaded = async (mod: GeneratedModule): Promise<void> => {
    const m = await ctx.ensureManager();
    const listed = await m.listModulesDetailed(ctx.task);
    if (!listed.some(x => same(x.name, mod.name))) { await ctx.loadModule(mod); }
  };

  /** A PERS num of a generated module, read through the manager. */
  const readNum = async (mod: GeneratedModule, role: string): Promise<number> => {
    const raw = await ctx.manager.getRapidVariable(ctx.task, mod.name, mod.symbols[role]);
    const n = Number(raw);
    if (!Number.isFinite(n)) { throw new Error(`${mod.symbols[role]} read ${JSON.stringify(raw)}, not a number`); }
    return n;
  };

  const pp = (): Promise<{ module?: string; routine?: string; row?: number; col?: number }> =>
    ctx.manager.getProgramPointer(ctx.task);

  /** Ready to start: motors on where the lane allows (RW8 skips unless on), module loaded, stopped. */
  const readyToRun = async (t: TestHandle, mod: GeneratedModule): Promise<RobotManager> => {
    await ctx.prepareMotion(t, { kind: 'rapid-start' });
    await ensureLoaded(mod);
    await ensureStopped();
    return ctx.manager;
  };

  /** Program pointer to the module's entry routine, start, and wait until it reads running. */
  const startEntry = async (m: RobotManager, mod: GeneratedModule): Promise<void> => {
    await m.setPPToRoutine(ctx.task, mod.name, mod.routines.entry);
    await m.startRapid();
    await waitExec('running');
  };

  /** Set the execution cycle and wait until the controller reads it. */
  const setCycle = async (m: RobotManager, cycle: 'once' | 'forever'): Promise<void> => {
    await m.setExecutionCycle(cycle);
    await waitUntil(async () => (await (await ctx.observer()).getRapidExecutionInfo()).cycle === cycle,
      10000, 250, `execution cycle ${cycle}`);
  };

  /** Put the cycle back to the one read before a test changed it (restore does it too). */
  const restoreCycle = async (cycle: string | null): Promise<void> => {
    if (cycle !== 'once' && cycle !== 'forever') { return; }
    const m = await ctx.ensureManager();
    await ensureStopped();
    if ((await (await ctx.observer()).getRapidExecutionInfo()).cycle !== cycle) { await setCycle(m, cycle); }
  };

  /** Run the SHORT module's routine to its end with the cycle set to once. */
  const runShortToEnd = async (m: RobotManager): Promise<void> => {
    await setCycle(m, 'once');
    await m.setRapidVariable(ctx.task, SHORT.name, SHORT.symbols.done, '0');
    await m.setPPToRoutine(ctx.task, SHORT.name, SHORT.routines.entry);
    await m.startRapid();
    await waitUntil(async () => (await readNum(SHORT, 'done')) === 1, 20000, 250, `${SHORT.symbols.done} = 1`);
    await waitExec('stopped', 10000);
  };

  /**
   * Follow the manager's execution state: every value `onDidChange` shows
   * (consecutive repeats dropped) and every execution event on its
   * subscription stream.
   */
  const watchExecution = (m: RobotManager) => {
    const seen: string[] = [m.state.execstate ?? 'null'];
    const events: Array<{ resource: string; value: string }> = [];
    let listening = true;
    // onDidChange has no removal: the flag turns this handler off.
    m.onDidChange(() => {
      if (!listening) { return; }
      const v = m.state.execstate ?? 'null';
      if (seen[seen.length - 1] !== v) { seen.push(v); }
    });
    const off = m.onSubscriptionEvent(e => {
      if (listening && /execution|execstate/i.test(e.resource)) { events.push({ resource: e.resource, value: e.value }); }
    });
    return { seen, events, stop: () => { listening = false; off(); } };
  };

  // ─── Idle program ────────────────────────────────────────────────────────

  it('reports the task list and a stopped execution state that agree with a direct read', async () => {
    const m = ctx.manager;
    expect(ctx.baseline.execstate).toBe('stopped');
    const o = await ctx.observer();
    const direct = await o.getRapidTasks();
    expect(direct.map(x => x.name)).toContain(ctx.task);
    const motion = direct.find(x => x.name === ctx.task)!;
    expect(motion.motiontask).toBe(true);
    expect(motion.active).toBe(true);
    expect(motion.excstate).toBe('stopped');
    for (const task of direct) {
      expect(typeof task.type).toBe('string');
      expect(typeof task.taskstate).toBe('string');
      expect(['running', 'stopped']).toContain(task.excstate);
    }
    ctx.note('records: task list at idle', direct);

    const info = await o.getRapidExecutionInfo();
    expect(info.state).toBe('stopped');
    expect(['once', 'forever']).toContain(info.cycle);
    await waitUntil(() => m.state.execstate === 'stopped' && m.state.execCycle === info.cycle
      && m.state.tasks.map(x => x.name).sort().join(',') === direct.map(x => x.name).sort().join(','),
    15000, 250, 'manager state equal to the direct read');
  });

  it('loads the ZZ_PROBE module and points the program pointer at its routine', async () => {
    await ensureStopped();
    await ensureLoaded(LONG);
    const m = ctx.manager;
    expect((await m.listModulesDetailed(ctx.task)).some(x => same(x.name, LONG.name))).toBe(true);

    await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.entry);
    const p = await pp();
    expect(same(p.module, LONG.name)).toBe(true);
    expect(same(p.routine, LONG.routines.entry)).toBe(true);
    // The manager's own read of the pointer says the same.
    const current = await m.getCurrentPP(ctx.task);
    expect(same(current?.routine, LONG.routines.entry)).toBe(true);
    expect(await execState()).toBe('stopped');
  });

  it('resetRapid moves the program pointer to main', async () => {
    await ensureStopped();
    await ensureLoaded(LONG);
    const m = ctx.manager;
    // Pointer away from any main first, so the reset has to move it.
    await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.entry);

    let refusal: RwsError | null = null;
    try {
      await m.resetRapid();
    } catch (e) {
      if (!(e instanceof RwsError) || e.code !== 'RESOURCE_NOT_FOUND') { throw e; }
      refusal = e;
    }

    if (!refusal) {
      // The station program has a main (the VCs as set up on 2026-09-29).
      const p = await pp();
      ctx.note('program pointer after resetRapid (station main)', p);
      expect(same(p.routine, 'main')).toBe(true);
      expect(same(p.module, LONG.name)).toBe(false);
      expect(await execState()).toBe('stopped');
      await waitUntil(() => heldLocks(m).length === 0, 5000, 250, 'no access left held after resetRapid');
      return;
    }

    // No main in the task (the VCs restarted on 2026-09-30, all three builds):
    // the controller answers 404 -1073442816 and the manager types it.
    ctx.note('resetRapid refused: the task has no main routine', errFacts(refusal));
    expect(refusal.httpStatus).toBe(404);
    expect(refusal.controllerCode).toBe(NO_MAIN_CODE);
    expect(refusal.message).toMatch(/no main routine/);
    expect(refusal.message).toContain(ctx.task);
    // Refused: still stopped and nothing held. Where the controller leaves the
    // pointer after a refused reset is not established, so it is recorded.
    expect(await execState()).toBe('stopped');
    ctx.note('records: program pointer after the refused resetRapid', await pp());
    await waitUntil(() => heldLocks(m).length === 0, 5000, 250, 'no access left held after the refused resetRapid');
    // The refusal agrees with the task's own listing: no program module declares a main.
    const programModules = (await m.listModulesDetailed(ctx.task))
      .filter(x => !/sys/i.test(x.type) && !same(x.name, 'BASE'));
    for (const mod of programModules) {
      const routines = await m.listRoutines(ctx.task, mod.name);
      expect(routines.some(r => same(r.name, 'main')), `${mod.name} declares main`).toBe(false);
    }

    // With a main provided by a ZZ_PROBE module, the reset lands there.
    await ctx.loadModule(MAIN);
    try {
      expect((await m.listRoutines(ctx.task, MAIN.name)).some(r => same(r.name, MAIN.routines.entry))).toBe(true);
      await m.resetRapid();
      const p = await pp();
      ctx.note('program pointer after resetRapid (ZZ_PROBE main)', p);
      expect(same(p.module, MAIN.name)).toBe(true);
      expect(same(p.routine, MAIN.routines.entry)).toBe(true);
      expect(await execState()).toBe('stopped');
      await waitUntil(() => heldLocks(m).length === 0, 5000, 250, 'no access left held after resetRapid');
    } finally {
      // Back to a task without a main, as the station has it (restore unloads it too).
      await ctx.unloadModule(MAIN.name);
    }
  });

  // ─── Running ─────────────────────────────────────────────────────────────

  it('starts the routine, reports running in its state and events, and stops it', async t => {
    const m = await readyToRun(t, LONG);
    const watch = watchExecution(m);
    const live = m.state.quality === 'live';
    try {
      await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.entry);
      const startedAt = Date.now();
      await m.startRapid();
      await waitExec('running');
      await waitUntil(() => m.state.execstate === 'running', 20000, 100, 'manager execstate running');
      ctx.note('manager state read running', { afterMs: Date.now() - startedAt, quality: m.state.quality });

      // The program really executes: the counter climbs.
      const c1 = await readNum(LONG, 'count');
      await waitUntil(async () => (await readNum(LONG, 'count')) > c1, 5000, 250, 'counter climbing');

      await m.stopRapid();
      await waitExec('stopped');
      await waitUntil(() => m.state.execstate === 'stopped', 20000, 100, 'manager execstate stopped');

      // Stopped means stopped: the counter no longer moves, and the routine did not finish.
      const frozen = await readNum(LONG, 'count');
      expect(await waitFor(async () => (await readNum(LONG, 'count')) !== frozen, 1500)).toBe(false);
      expect(await readNum(LONG, 'done')).toBe(0);
      await waitUntil(() => heldLocks(m).length === 0, 5000, 250, 'no access left held after start and stop');
    } finally {
      watch.stop();
    }

    ctx.note('execution changes seen by the manager', { seen: watch.seen, events: watch.events, live });
    const running = watch.seen.indexOf('running');
    expect(running).toBeGreaterThanOrEqual(0);
    expect(watch.seen.lastIndexOf('stopped')).toBeGreaterThan(running);
    if (live) {
      // With the event stream up, the change arrives as an execution event.
      const values = watch.events.map(e => e.value);
      expect(values).toContain('running');
      expect(values.lastIndexOf('stopped')).toBeGreaterThan(values.indexOf('running'));
    }
  });

  it('a start after a stop continues from the program pointer and does not restart the routine', async t => {
    const m = await readyToRun(t, LONG);
    await startEntry(m, LONG);
    await waitUntil(async () => (await readNum(LONG, 'count')) >= 15, 20000, 250, 'counter at 15');
    await m.stopRapid();
    await waitExec('stopped');
    const atStop = await readNum(LONG, 'count');
    const ppAtStop = await pp();
    expect(same(ppAtStop.routine, LONG.routines.entry)).toBe(true);

    await m.startRapid();
    await waitExec('running');
    // The routine sets the counter to 0 at its top: a restart from the top
    // would show values below the one at the stop.
    let low = Number.POSITIVE_INFINITY;
    await waitUntil(async () => {
      const c = await readNum(LONG, 'count');
      low = Math.min(low, c);
      return c > atStop + 5;
    }, 10000, 200, 'counter past the value at the stop');
    await m.stopRapid();
    await waitExec('stopped');
    ctx.note('continue after stop', { atStop, lowestAfterRestart: low, ppAtStop });
    expect(low).toBeGreaterThanOrEqual(atStop);
  });

  it('refuses to move the program pointer while the program runs; stopIfRunning stops it first', async t => {
    const m = await readyToRun(t, LONG);
    await startEntry(m, LONG);

    const e = await expectRwsError(() => m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.second));
    ctx.note('setPPToRoutine while running', errFacts(e));
    expect(e.code).toBe('WRONG_MODE');
    expect(e.refusal?.kind).toBe('wrong-state');
    expect(e.refusal?.grantor).toBe('this-tool');
    expect(e.message).toMatch(/running/i);
    expect(e.message).toMatch(/stopIfRunning/);
    // Refused means untouched: still running, pointer still in the entry routine.
    expect(await execState()).toBe('running');
    expect(same((await pp()).routine, LONG.routines.entry)).toBe(true);

    await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.second, { stopIfRunning: true });
    await waitExec('stopped');
    const p = await pp();
    expect(same(p.module, LONG.name)).toBe(true);
    expect(same(p.routine, LONG.routines.second)).toBe(true);
  });

  it('records the per-task execution state the task list reports while the program runs', async t => {
    const m = await readyToRun(t, LONG);
    await startEntry(m, LONG);
    try {
      const direct: RapidTask[] = await (await ctx.observer()).getRapidTasks();
      const mine = direct.find(x => x.name === ctx.task);
      expect(mine).toBeDefined();
      expect(mine!.active).toBe(true);
      const managerSawRunning = await waitFor(
        () => m.state.tasks.find(x => x.name === ctx.task)?.excstate === 'running', 10000);
      ctx.note('records: per-task execution state while RAPID runs', {
        direct, managerTask: m.state.tasks.find(x => x.name === ctx.task) ?? null, managerSawRunning,
        executionState: await execState(),
      });
      expect(await execState()).toBe('running');
    } finally {
      await ensureStopped();
    }
  });

  it('records a second routine run from its program pointer to its end', async t => {
    const m = await readyToRun(t, LONG);
    const before = await readNum(LONG, 'calls');
    await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.second);
    await m.startRapid();
    // The routine is one assignment: it may be over before a read sees it running.
    await waitUntil(async () => (await readNum(LONG, 'calls')) >= before + 100, 10000, 250, `${LONG.symbols.calls} + 100`);
    const stoppedByItself = await waitFor(async () => (await execState()) === 'stopped', 10000);
    const after = await readNum(LONG, 'calls');
    const info = await (await ctx.observer()).getRapidExecutionInfo();
    ctx.note('records: a routine run from its program pointer to its end', {
      before, after, stoppedByItself, cycle: info.cycle, pp: await pp(),
    });
    await ensureStopped();
    expect(after).toBeGreaterThanOrEqual(before + 100);
    expect((after - before) % 100).toBe(0);
  });

  it('with the cycle set to once, the routine runs to its end and execution stops by itself', async t => {
    const m = await readyToRun(t, SHORT);
    const cycleBefore = (await (await ctx.observer()).getRapidExecutionInfo()).cycle;
    try {
      await runShortToEnd(m);
      expect(await readNum(SHORT, 'count')).toBe(10);
      expect(await readNum(SHORT, 'done')).toBe(1);
      await waitUntil(() => m.state.execstate === 'stopped', 20000, 250, 'manager execstate stopped');
      const after = await (await ctx.observer()).getRapidExecutionInfo();
      ctx.note('records: execution cycle after a once run ended', { cycleBefore, cycleAfter: after.cycle, pp: await pp() });
      expect(['once', 'oncedone']).toContain(after.cycle);
    } finally {
      await restoreCycle(cycleBefore);
    }
  });

  it('records what a start does after the routine ran to its end', async t => {
    const m = await readyToRun(t, SHORT);
    const cycleBefore = (await (await ctx.observer()).getRapidExecutionInfo()).cycle;
    try {
      await runShortToEnd(m);
      const ppAfterEnd = await pp();
      const inProbe = same(ppAfterEnd.module, SHORT.name);
      const unset = !ppAfterEnd.module && !ppAfterEnd.routine;
      if (!inProbe && !unset) {
        // Never start the station's own program: record where the pointer went and stop here.
        ctx.note('records: program pointer after the routine ended (left the ZZ_PROBE module; no start sent)', ppAfterEnd);
        return;
      }
      await m.setRapidVariable(ctx.task, SHORT.name, SHORT.symbols.done, '0');
      let outcome: Record<string, unknown>;
      try {
        await m.startRapid();
        const ranAgain = await waitFor(async () => (await readNum(SHORT, 'done')) === 1, 5000);
        const stoppedByItself = await waitFor(async () => (await execState()) === 'stopped', 5000);
        outcome = { accepted: true, ranAgain, stoppedByItself, count: await readNum(SHORT, 'count') };
      } catch (e) {
        if (!(e instanceof RwsError)) { throw e; }
        outcome = { accepted: false, ...errFacts(e) };
        // A refusal is typed, whatever this build answers.
        expect(e.code).not.toBe('UNKNOWN');
      }
      ctx.note('records: a start after the routine ran to its end', { ppAfterEnd, outcome });
      await ensureStopped();
      expect(await execState()).toBe('stopped');
    } finally {
      await restoreCycle(cycleBefore);
    }
  });

  it('a string written through the client with percent signs is the same text in RAPID (StrLen and compare)', async t => {
    const m = await readyToRun(t, PCT);
    const cycleBefore = (await (await ctx.observer()).getRapidExecutionInfo()).cycle;
    try {
      await setCycle(m, 'once');
      await m.setRapidVariable(ctx.task, PCT.name, PCT.symbols.done, '0');
      await m.setRapidVariable(ctx.task, PCT.name, PCT.symbols.written, `"${PCT_TEXT}"`);
      await m.setPPToRoutine(ctx.task, PCT.name, PCT.routines.entry);
      await m.startRapid();
      await waitUntil(async () => (await readNum(PCT, 'done')) === 1, 20000, 250, `${PCT.symbols.done} = 1`);
      await waitExec('stopped', 10000);
      const len = await readNum(PCT, 'len');
      const eq = await ctx.manager.getRapidVariable(ctx.task, PCT.name, PCT.symbols.eq);
      const copy = await ctx.manager.getRapidVariable(ctx.task, PCT.name, PCT.symbols.copy);
      ctx.note('records: percent string as RAPID sees it', { len, eq, copy });
      // RAPID holds the text as given: the extra decode is not on the read.
      expect(len).toBe(PCT_TEXT.length);
      expect(eq.trim().toUpperCase()).toBe('TRUE');
      // A string RAPID assigned reads back as assigned over RWS.
      expect(copy).toBe(`"${PCT_TEXT}"`);
    } finally {
      await ensureStopped();
      await restoreCycle(cycleBefore);
    }
  });

  // ─── Refusals ────────────────────────────────────────────────────────────

  it('refuses a start the controller state does not allow (motors off; guard stop on RW8), typed', async t => {
    const m = await ctx.ensureManager();
    if (ctx.lane === 'rw8') {
      const { ctrlstate } = await ctx.panel();
      if (ctrlstate === 'motoron') {
        ctx.skip(t, 'the RW8 motors are on (switched on at the pendant), so there is no guard stop to refuse a start in');
      }
    } else {
      await ctx.requireAllowed(t, 'motors');
      const { opmode } = await ctx.panel();
      if (opmode !== 'AUTO') { ctx.skip(t, `the motors-off refusal is asserted in Auto; the controller reads ${opmode}`); }
    }
    await ensureStopped();
    await ensureLoaded(LONG);
    // A valid program pointer, so the controller state is the only thing missing.
    await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.entry);
    if (ctx.lane !== 'rw8' && (await ctx.panel()).ctrlstate === 'motoron') {
      await m.setMotorsOff();
      await waitUntil(async () => (await ctx.panel()).ctrlstate === 'motoroff', 10000, 250, 'motors off');
    }
    const ctrlstate = (await ctx.panel()).ctrlstate;
    // The refusal is explained from the manager's state: let it catch up first.
    await waitUntil(() => m.state.ctrlstate === ctrlstate, 15000, 250, `manager ctrlstate ${ctrlstate}`);
    const count = await readNum(LONG, 'count');

    const e = await expectRwsError(() => m.startRapid());
    ctx.note('start refused by the controller state', { ctrlstate, ...errFacts(e) });

    // Nothing started.
    expect(await waitFor(async () => (await execState()) === 'running', 1500)).toBe(false);
    expect(await readNum(LONG, 'count')).toBe(count);
    await waitUntil(() => heldLocks(m).length === 0, 5000, 250, 'no access left held after the refused start');

    if (ctx.lane === 'rw6') {
      // Live-verified 2026-09-30 on RW 6.16.03: in Auto with the motors off and
      // the program pointer set, the start answers 400 -1073445881 with
      // "org_code: -4506" in the message. The client types it WRONG_MODE with a
      // wrong-state refusal on the motors (its RWS 1.0 path gives MOTORS_OFF for
      // a 400 whose detail mentions the motors, so that code is accepted too).
      expect(['WRONG_MODE', 'MOTORS_OFF']).toContain(e.code);
      expect(e.httpStatus).toBe(400);
      expect(e.controllerCode).toBe(-1073445881);
      expect(e.controllerMsg ?? '').toMatch(/org_code: -4506/);
      if (e.refusal) {
        expect(e.refusal.kind).toBe('wrong-state');
        expect(e.message).toMatch(/motors/i);
      }
      return;
    }
    expect(e.code).toBe('WRONG_MODE');
    // With the program pointer set, the start answers 403 -1073445806 (not
    // allowed in the current controller state) on every RWS 2.0 build on
    // record: live-verified 2026-09-30 on RW 7.21.4 with the motors off and on
    // RW 8.2.1 in guard stop, and 2026-10-03 on RW 7.21.0+229 (motors off) and
    // RW 8.1.1+614 (guard stop). -1073442809 (EXEC_STATE) is the answer
    // without a program pointer (RW 7.21, 2026-09-15).
    expect(e.controllerCode).toBe(-1073445806);
    expect(e.httpStatus).toBe(403);
    expect(e.refusal?.kind).toBe('wrong-state');
    // The client explains -1073445806 on a start either as the generic
    // controller-state refusal (2026-09-30, RW 7.21.4 motors off and RW 8.2.1
    // guard stop) or from the known state (2026-10-03: the motors on RW 7.21.0,
    // the safety state on RW 8.1.1). Either is accepted; a state-specific one
    // must name the state.
    if (ctrlstate === 'motoroff') {
      expect(['motors', 'controller-state']).toContain(e.refusal?.condition);
      if (e.refusal?.condition === 'motors') { expect(e.message).toMatch(/motors are off/i); }
    } else if (ctrlstate === 'guardstop') {
      expect(['safety-state', 'controller-state']).toContain(e.refusal?.condition);
      if (e.refusal?.condition === 'safety-state') { expect(e.message).toMatch(/guard stop/i); }
    }
    if (e.refusal?.condition === 'controller-state') {
      expect(e.message).toMatch(/current state/i);
    }
  });

  it('refuses a start while another session holds the RAPID access, typed', async t => {
    if (ctx.lane === 'rw6') {
      await refuseWhileHeldRw6(ctx, t);
      return;
    }
    if (ctx.lane === 'rw7') {
      // Motors on and a valid pointer, so the other session's hold is the only thing missing.
      await ctx.prepareMotion(t, { kind: 'rapid-start' });
    }
    await ensureLoaded(LONG);
    await ensureStopped();
    const m = ctx.manager;
    await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.entry);

    // RW7: a second session takes edit mastership. RW8: a second control
    // station takes write access. Both the normal way, through the client.
    let holder: IRWSAdapter | RobotManager;
    if (ctx.lane === 'rw8') {
      holder = await ctx.newManager({ controlStation: HOLDER_STATION });
    } else {
      holder = await ctx.newAdapter();
    }
    let held = false;
    try {
      await holder.requestMastership('rapid');
      held = true;

      const e = await expectRwsError(() => m.startRapid());
      ctx.note('start refused while another session holds the access', errFacts(e));
      expect(e.code).toBe('MASTERSHIP_REQUIRED');
      expect(e.refusal?.kind).toBe('held-by-other');
      if (ctx.lane === 'rw8') { expect(e.controllerCode).toBe(-1073435870); }
      expect(await waitFor(async () => (await execState()) === 'running', 1500)).toBe(false);
      await waitUntil(() => heldLocks(m).length === 0, 5000, 250, 'the refused manager holds nothing');
    } finally {
      if (held) {
        await holder.releaseMastership('rapid').catch(err => ctx.note('holder release failed', String(err)));
      }
      await ctx.release(holder);
    }

    // Released, the access is this manager's to take again.
    if (ctx.lane === 'rw7') {
      await m.startRapid();
      await waitExec('running');
      await m.stopRapid();
      await waitExec('stopped');
    } else {
      // RW8 in guard stop cannot start; a program-pointer move proves write access is back.
      await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.entry);
    }
    await waitUntil(() => heldLocks(m).length === 0, 5000, 250, 'no access left held');
  });

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  it('unloads the ZZ_PROBE modules and the task lists the modules it had before', async () => {
    await ensureStopped();
    await ctx.unloadModule(LONG.name);
    await ctx.unloadModule(SHORT.name);
    await ctx.unloadModule(MAIN.name);
    await ctx.unloadModule(PCT.name);
    // The same listing the baseline snapshot was taken with.
    const names = await (await ctx.observer()).listModules(ctx.task);
    expect(names.some(n => [LONG.name, SHORT.name, MAIN.name, PCT.name].some(p => same(n, p)))).toBe(false);
    const before = ctx.baseline.modulesByTask[ctx.task];
    if (before) { expect([...names].sort()).toEqual([...before].sort()); }
  });
});

/**
 * The RW6 held-by-other case. The RW6 virtual controller refuses a further
 * session while a RobotManager is connected, and its connect makes one more
 * short login first, so this case runs on two plain adapter sessions with the
 * lane's manager disconnected: one holds RAPID mastership, the other starts.
 * The adapter's start takes the mastership itself, as the manager's does.
 * Evidence does not settle what RW 6.16 answers here, so the refusal is
 * recorded and the minimum asserted: a typed RwsError, and nothing started.
 */
async function refuseWhileHeldRw6(ctx: FunctionalContext, t: TestHandle): Promise<void> {
  await ctx.prepareMotion(t, { kind: 'rapid-start' });
  const m = ctx.manager;
  if (!(await m.listModulesDetailed(ctx.task)).some(x => same(x.name, LONG.name))) { await ctx.loadModule(LONG); }
  if ((await ctx.panel()).execstate === 'running') {
    await m.stopRapid();
    await waitUntil(async () => (await ctx.panel()).execstate === 'stopped', 15000, 250, 'execution stopped');
  }
  await m.setPPToRoutine(ctx.task, LONG.name, LONG.routines.entry);
  await m.disconnect();

  const holder = await ctx.newAdapter();
  let starter: IRWSAdapter | null = null;
  let held = false;
  try {
    await holder.requestMastership('rapid');
    held = true;
    starter = await ctx.newAdapter();
    const s = starter;
    const e = await expectRwsError(() => s.startRapid());
    ctx.note('records: RW6 start refused while another session holds RAPID mastership', errFacts(e));
    expect(e.code).not.toBe('UNKNOWN');
    expect(await waitFor(async () => (await holder.getRapidExecutionState()) === 'running', 1500)).toBe(false);
  } finally {
    if (held) { await holder.releaseMastership('rapid').catch(err => ctx.note('holder release failed', String(err))); }
    if (starter) { await ctx.release(starter); }
    await ctx.release(holder);
    await ctx.ensureManager();
  }
}
