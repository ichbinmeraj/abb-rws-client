/**
 * Functional test, per controller: one warm restart sent through the client
 * (`RobotManager.restartController`), and what the client does about it - the
 * connection quality it reports while the controller is away, its one
 * host-approved reconnect, finding the same controller again through
 * `RobotManager.connect` (on a new port if the restart moved it), state reads
 * afterwards, and the operating mode, RAPID state and speed ratio compared
 * with before.
 *
 * Opt-in per lane: a restart is sent only to the lanes listed in
 * RWS_FUNCTIONAL_ALLOW_RESTART (`rw7`, say), and never to rw6 or rw8 whatever
 * it lists (the never-restart list in tests/helpers/restartPolicy.ts, which
 * helpers/guard.ts applies: the test suites never restart the RW6 virtual
 * controller; an RW8 restart resets the pendant's Remote Access). Every
 * other lane is skipped with that reason, and no session is opened on it.
 *
 * One restart per lane. The tests below observe that one event in order;
 * a later test skips, naming the earlier step, when the step it builds on did
 * not happen, so a failure is reported once, where it happened.
 *
 * What the evidence says:
 * - RobotWare 7.21: a restart needs edit mastership, which the client takes
 *   (RwsClient2.restartController, live-verified 2026-08-02 on RW 7.21), and
 *   is refused while a switch to Auto awaits confirmation. The RW 7.21
 *   virtual controller came back within seconds after some restarts and after
 *   about 6.5 minutes after another, with a drain phase of up to about two
 *   minutes in which HTTP still answers, the WebSocket is closed and writes
 *   are refused (live-observed 2026-08-02 to 2026-09-23). It kept its RWS port
 *   across a warm restart; a RobotStudio IRC5 virtual controller comes back
 *   on a new one.
 * - The client forgets the hold the restart took once the controller has
 *   accepted it (AccessManager.withAccess, `releaseOnSuccess: false`), adopts
 *   the session cookie the controller issues afterwards, and RobotManager
 *   disconnects after three failed polls in a row and then calls the host's
 *   error listener, whose 'Reconnect' answer runs ONE connect with the prior
 *   configuration. There is no reconnect loop in the client: a host that must
 *   stay connected supervises reconnects itself. So "comes back by itself" is
 *   recorded here, and the recovery that is asserted is the consumer's
 *   `connect` to the port it knew, which must find the controller again.
 * - RobotWare 7.21.4 (7.21.4+417 virtual controller, two runs on 2026-09-30):
 *   after a warm restart in Auto with the motors off, the controller state
 *   reads init, then motors off, then, about 9-11 s after the restart, motors
 *   on (read in one run) and guard stop, and later motors off again by itself.
 *   The first reads made afterwards found motors off 37 s after one restart
 *   and 136 s after the other; when the guard stop ended is not known. No
 *   motors or state request was sent, and the restore has no RWS action for a
 *   guard stop. In a third run (2026-09-30 evening) it went motors on at
 *   +8.9 s, guard stop at +10.1 s, motors off at +12.1 s and motors on again at
 *   +13.1 s, and stayed motors on for more than three minutes, again with
 *   nothing but reads sent. So the restart may end in either rest state, and
 *   the lane sends nothing but controller-state reads until the state has held
 *   one rest state (REST_STATES) for SETTLE_HOLD_MS in a row (longer than the
 *   motors-off phase before the transient, about 6 s), then checks that the
 *   manager follows it:
 *   once before the tests that compare state with before, again after the
 *   speed-ratio write, and a last time at the end of the lane, before the
 *   restore (a backstop with a shorter window, inside afterAll's budget).
 * - Not settled by the evidence, recorded in the lane's trace: whether the
 *   speed ratio survives a warm restart, whether the port moved, whether the
 *   restart count rises, and where the joints read afterwards. Also whether
 *   the guard stop above comes without a write: in both runs it was first
 *   read within 0.2 s after the edit release of the speed-ratio write test
 *   (motors on had been read before that write in one of them). One settle
 *   test runs before the write test and one after it, each with its own
 *   window, so a transient with no write sent and one that follows the write
 *   are recorded apart in the same run.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers. The speed ratio is put back in the test and again by
 * the harness restore.
 */

import { describe, it, expect } from 'vitest';
import { RWS2Adapter, RobotManager, RwsError, findControllers, type AccessEvent } from '../../src/index.js';
import type { ConnectionQuality, JointTarget } from '../../src/types.js';
import {
  FUNCTIONAL_ENABLED, HOST, LANES, LANE_HOOK_TIMEOUT_MS, LANE_REQUEST_TIMEOUT_MS, TEST_PASS, TEST_USER,
  allowed, assertLocalhost, discoverFleet, forEachController, recordSkip, waitFor, waitUntil,
  type FunctionalContext, type Generation, type TestHandle,
} from './helpers/index.js';

const FILE_TAG = '13-restart';

/** How long the controller is given to go down and come back (RW 7.21 once took about 6.5 minutes). */
const RESTART_WINDOW_MS = 480000;
/** Cadence of the outage watch: one unauthenticated probe, and a local scan while the port is silent. */
const CHASE_STEP_MS = 3000;
/**
 * How long quality may keep claiming a working connection after the
 * controller became unreachable: a poll cycle (5 s with the event stream up),
 * three failed polls and their request timeouts. Past this it is not latency.
 */
const DETECT_BUDGET_MS = 90000;
/** With no down phase seen by then, the restart was faster than the watch: a port that answers is back. */
const DOWN_SEEN_DEADLINE_MS = 240000;
/** How long the manager is given to come back by itself once the controller answers again. */
const SELF_RECOVERY_WAIT_MS = 60000;
/** How long the consumer keeps reconnecting (a freshly booted controller refuses logins for a while). */
const CONSUMER_RECONNECT_MS = 240000;
/** How long a write may be refused right after the restart (a freshly booted VC answered 403 for a few seconds). */
const WRITE_SETTLE_MS = 60000;
/**
 * How long the controller state is given to come back by itself after the
 * restart. RW 7.21.4 read motors off again by 37 s after one restart and by
 * 136 s after another (only bounded there), and the hold comes on top.
 */
const SETTLE_WINDOW_MS = 180000;
/**
 * The same wait at the end of the lane, a backstop behind the two settle
 * tests. It runs inside afterAll, which still has the session logouts and the
 * restore to run: the budget check below refuses a value that crowds them.
 */
const LANE_END_SETTLE_MS = 90000;
/**
 * How long the state must read what it read before the restart, without a
 * break, to count as settled. RW 7.21.4 read motors off for about 6 s before
 * the motors-on / guard-stop phase began, so a single read is not enough.
 */
const SETTLE_HOLD_MS = 20000;
/** Cadence of the settle reads: one controller-state GET each. */
const SETTLE_POLL_MS = 1000;
/** Controller states a restart may end in; init and guard stop are transients. */
const REST_STATES: ReadonlySet<string> = new Set(['motoron', 'motoroff']);
/** How far a settle may run past its window: one last read that runs into the request timeout, and one pause. */
const SETTLE_OVERRUN_MS = LANE_REQUEST_TIMEOUT_MS + SETTLE_POLL_MS;
/** How long the manager is given to follow the controller state once it settled. */
const FOLLOW_WAIT_MS = 10000;
/** Timeout of a settle test: its window, the overrun, the follow wait and a margin. */
const SETTLE_TEST_MS = SETTLE_WINDOW_MS + SETTLE_OVERRUN_MS + FOLLOW_WAIT_MS + 10000;
/**
 * What afterAll must keep after the lane-end settle: the other deferred
 * steps, the session logouts and the restore. A hook that times out never
 * reaches its finally block and leaves sessions logged in, so a
 * LANE_END_SETTLE_MS that eats into this is refused when the file loads.
 */
const RESTORE_RESERVE_MS = 80000;
if (LANE_END_SETTLE_MS + SETTLE_OVERRUN_MS + RESTORE_RESERVE_MS > LANE_HOOK_TIMEOUT_MS) {
  throw new Error(`${FILE_TAG}: the lane-end settle (${LANE_END_SETTLE_MS} + ${SETTLE_OVERRUN_MS} ms) leaves less than `
    + `${RESTORE_RESERVE_MS} ms of afterAll's ${LANE_HOOK_TIMEOUT_MS} ms for the logouts and the restore`);
}

const STEADY: ReadonlySet<ConnectionQuality> = new Set<ConnectionQuality>(['live', 'polling']);

const T = {
  restart: 'a warm restart sent through RobotManager is accepted in Auto with RAPID stopped',
  outage: 'while the controller is away, quality stops claiming a working connection, and every change carries a reason',
  self: 'records whether RobotManager came back by itself (its one host-approved reconnect)',
  refind: 'RobotManager.connect to the known port finds the same controller again, on its new port if the restart moved it',
  reads: 'state reads work after the restart and agree with direct reads',
  settle: 'the controller state settles by itself after the restart (motors on or off), with nothing but reads sent, and the manager follows it',
  panel: 'operation mode and RAPID state are as before the restart; records the speed ratio it came back with',
  write: 'a speed-ratio write works again after the restart and leaves no hold counted',
  resettle: 'the controller state settles again after the write, with nothing but reads sent, and the manager follows it',
} as const;

interface Transition { at: number; quality: ConnectionQuality; reason: string; connected: boolean }

interface Before {
  port: number;
  https: boolean;
  systemName: string;
  rwVersion: string;
  sysid: string;
  opmode: string;
  ctrlstate: string | null;
  execstate: string;
  /** The speed ratio found, which the test puts back. */
  speedRatio: number;
  /** The speed ratio set just before the restart, to see whether it survives. */
  marker: number;
  restartCount: number | null;
  modules: string[];
  joints: JointTarget | null;
  /** Ports of every other controller on this machine: never taken for this one. */
  otherPorts: number[];
}

interface RunRecord {
  before: Before | null;
  restartedAt: number | null;
  recording: boolean;
  listening: boolean;
  transitions: Transition[];
  errorCalls: Array<{ at: number; msg: string; actions: string[] }>;
  accessEvents: Array<{ at: number; type: string; lock: string; reason?: string }>;
  back: { at: number; how: string; movedTo: number | null; sawDown: boolean; downMs: number | null } | null;
  recovered: { port: number; https: boolean } | null;
  reconnected: boolean;
  /** True from the restart until the lane-end settle: the manager's controller-state changes are kept. */
  watchState: boolean;
  /** Every controller state the manager took on after the restart (its events and polls), ms after the restart. */
  managerStates: Array<{ at: number; ctrlstate: string }>;
  /** The first settle test's outcome (null until it ran). */
  settled: boolean | null;
  /** When the speed-ratio write after the restart returned, ms after the restart (null until it did). */
  wroteAt: number | null;
}

/** One change in the controller state read during a settle, ms after the restart. */
interface StateSeen { at: number; ctrlstate: string | null; error?: string }

interface SettleRecord {
  settled: boolean;
  want: string;
  /** When the final unbroken run of `want` began, ms after the restart. */
  holdFrom: number | null;
  waitedMs: number;
  seen: StateSeen[];
}

const errText = (e: unknown): string =>
  (e instanceof RwsError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

/** System ids are GUIDs; compare them without braces or case. */
const sameSystemId = (a: string, b: string): boolean => {
  const n = (s: string): string => s.trim().replace(/^\{|\}$/g, '').toLowerCase();
  return n(a) === n(b);
};

/** Locks the manager counts as held now. */
const heldLocks = (m: RobotManager): string[] =>
  (m.state.access?.locks ?? []).filter(l => l.state === 'held' && l.count > 0).map(l => l.lock);

/** Does `port` answer an unauthenticated request with this generation's challenge? */
async function answersAs(port: number, https: boolean, generation: Generation): Promise<boolean> {
  const p = await RobotManager.probeSpecificPort(HOST, port, false, 1500);
  return p !== null && p.useHttps === https && p.authType === (generation === 'rws2' ? 'basic' : 'digest');
}

/** The RobotStudio process that serves RWS for each generation. */
const VC_IMAGE: Readonly<Record<Generation, string>> = { rws1: 'robvc.exe', rws2: 'vrchost64.exe' };

/**
 * Controllers of this generation on this machine, other than the excluded
 * ports: one paced `findControllers` run on this PC's loopback (one probe at a
 * time, at least 1 s apart), this generation's VC process only, and, when the
 * VC's system folder names its system, that system only.
 */
async function otherCandidates(generation: Generation, exclude: ReadonlySet<number>, systemName: string): Promise<number[]> {
  const result = await findControllers({
    loopbackOnly: true, serviceAddress: false, mdns: false, identify: generation === 'rws2' ? 'anonymous' : 'none',
    filterToVcProcesses: true, pacing: { local: { concurrency: 1, minGapMs: 1000 } },
  }).catch(() => null);
  if (!result) { return []; }
  for (const c of result.controllers) { assertLocalhost(c.host); }
  return result.controllers
    .filter(c => c.host === HOST && c.identified && c.generation === generation && !exclude.has(c.port)
      && (c.process?.image === undefined || c.process.image.toLowerCase() === VC_IMAGE[generation])
      && (c.systemName === undefined || c.systemName === systemName))
    .map(c => c.port);
}

/** The restart count on RWS 2.0 (live-verified 2026-08-04 on RW 7.21), or null. */
async function restartCount(ctx: FunctionalContext): Promise<number | null> {
  try {
    const o = await ctx.observer();
    return o instanceof RWS2Adapter ? await o.getRestartCount() : null;
  } catch {
    return null;
  }
}

function restartTests(ctx: FunctionalContext): void {
  const run: RunRecord = {
    before: null, restartedAt: null, recording: false, listening: false,
    transitions: [], errorCalls: [], accessEvents: [],
    back: null, recovered: null, reconnected: false,
    watchState: false, managerStates: [], settled: null, wroteAt: null,
  };

  /**
   * Read the controller state every SETTLE_POLL_MS, sending nothing else,
   * until it has read `want` for SETTLE_HOLD_MS in a row or `windowMs` has
   * passed. Nothing is switched: the RW 7.21.4 guard stop after a restart
   * ends by itself. Every change seen is kept with its time after the restart.
   */
  /**
   * With `want` null, any rest state (REST_STATES) counts, and the record's
   * `want` names the one it settled on: RW 7.21.4 has ended a restart in
   * motors off and in motors on (2026-09-30), with nothing but reads sent.
   */
  const settle = async (want: string | null, windowMs: number): Promise<SettleRecord> => {
    const start = Date.now();
    const since = (at: number): number => at - (run.restartedAt ?? start);
    const seen: StateSeen[] = [];
    let holdFrom = null as number | null;
    let holdValue = null as string | null;
    const settled = await waitFor(async () => {
      const now = Date.now();
      let value: string | null = null;
      let error: string | undefined;
      try { value = await (await ctx.observer()).getControllerState(); } catch (e) { error = errText(e); }
      const last = seen[seen.length - 1];
      if (!last || last.ctrlstate !== value || last.error !== error) {
        seen.push({ at: since(now), ctrlstate: value, ...(error === undefined ? {} : { error }) });
      }
      const accepted = value !== null && (want === null ? REST_STATES.has(value) : value === want);
      if (!accepted) { holdFrom = null; holdValue = null; return false; }
      if (value !== holdValue) { holdFrom = now; holdValue = value; }
      return now - (holdFrom as number) >= SETTLE_HOLD_MS;
    }, windowMs, SETTLE_POLL_MS);
    return {
      settled, want: want ?? holdValue ?? 'a rest state (motoron or motoroff)',
      holdFrom: holdFrom === null ? null : since(holdFrom), waitedMs: Date.now() - start, seen,
    };
  };

  const describeSeen = (seen: StateSeen[]): string =>
    seen.map(s => `${s.ctrlstate ?? `read failed (${s.error ?? 'no value'})`} at +${(s.at / 1000).toFixed(1)} s`).join(', ') || 'nothing';

  /**
   * The body of both settle tests: wait for the state to hold one rest state
   * (motors on or off), record every state seen (and every state the manager
   * took on since the restart, each with its time after it), then assert that
   * it settled and that the manager followed it to that state.
   */
  const settleAndFollow = async (
    label: string, extra: Record<string, unknown>, keep: (r: SettleRecord) => void = () => undefined,
  ): Promise<void> => {
    const m = ctx.manager;
    const r = await settle(null, SETTLE_WINDOW_MS);
    keep(r);
    const transient = [...new Set(r.seen.map(s => s.ctrlstate))].filter(s => s !== null && s !== r.want);
    ctx.note(label, { ...r, transient, ...extra, managerSaw: [...run.managerStates] });
    expect(r.settled, `the controller state did not read ${r.want} for ${SETTLE_HOLD_MS / 1000} s in a row within `
      + `${SETTLE_WINDOW_MS / 1000} s; seen: ${describeSeen(r.seen)}`).toBe(true);
    // The manager followed the controller back: its state is not left on a transient value.
    const followed = await waitFor(() => m.state.ctrlstate === r.want, FOLLOW_WAIT_MS, 250);
    expect(followed, `the manager's controller state reads ${m.state.ctrlstate}, not ${r.want}; `
      + `it took on: ${run.managerStates.map(s => `${s.ctrlstate} at +${(s.at / 1000).toFixed(1)} s`).join(', ') || 'no change'}`).toBe(true);
  };

  /** Skip, naming the earlier step, unless the steps this test builds on happened. */
  const need = (t: TestHandle, step: 'restarted' | 'back' | 'reconnected'): Before => {
    if (!run.before || run.restartedAt === null) { return ctx.skip(t, 'the restart was not sent (see the first test of this lane)'); }
    if (step !== 'restarted' && !run.back) { return ctx.skip(t, 'the controller was not seen back after the restart (see the outage test)'); }
    if (step === 'reconnected' && !run.reconnected) { return ctx.skip(t, 'the manager did not reconnect after the restart (see the reconnect test)'); }
    return run.before;
  };

  it(T.restart, async t => {
    await ctx.requireAllowed(t, 'restart');
    const m = await ctx.ensureManager();
    const p = await ctx.panel();
    if (p.opmode !== 'AUTO') {
      ctx.skip(t, `the restart is sent in Auto only (RW 7.21 refused one while a switch to Auto awaited confirmation); the controller reads ${p.opmode}`);
    }
    if (p.execstate !== 'stopped') { ctx.skip(t, `RAPID reads ${p.execstate}; the restart test starts from a stopped program`); }
    expect(typeof p.speedRatio).toBe('number');
    await waitUntil(() => STEADY.has(m.state.quality), 30000, 250, 'a steady connection quality before the restart');
    const info = m.state.systemInfo;
    expect(info?.sysid, 'the manager read no system id before the restart').toBeTruthy();

    // A speed ratio that differs from the one found, so the reading after the
    // restart tells "kept" from "reset". No motion runs in this file.
    const original = p.speedRatio!;
    const marker = original === 50 ? 40 : 50;
    await m.setSpeedRatio(marker);
    await waitUntil(async () => (await ctx.panel()).speedRatio === marker, 10000, 250, `speed ratio ${marker} before the restart`);

    const fleet = await discoverFleet();
    const otherPorts = [...fleet.controllers, ...fleet.duplicates].map(c => c.port).filter(port => port !== ctx.port);
    const snap = await ctx.snapshot();
    run.before = {
      port: ctx.port, https: ctx.https, systemName: ctx.systemName, rwVersion: ctx.rwVersion, sysid: info!.sysid,
      opmode: p.opmode!, ctrlstate: p.ctrlstate, execstate: p.execstate!, speedRatio: original, marker,
      restartCount: await restartCount(ctx), modules: snap.modulesByTask[ctx.task] ?? [], joints: snap.joints, otherPorts,
    };

    // What the manager reports from here on: every quality change, every
    // access event, and the host's error listener, which answers 'Reconnect'
    // (the answer a person gives in the VS Code extension's dialog) while the
    // restart is being watched, and nothing afterwards.
    if (!run.listening) {
      run.listening = true;
      m.onDidChange(() => {
        const s = m.state;
        const lastState = run.managerStates[run.managerStates.length - 1];
        if (run.watchState && s.ctrlstate !== null && lastState?.ctrlstate !== s.ctrlstate) {
          run.managerStates.push({ at: Date.now() - (run.restartedAt ?? Date.now()), ctrlstate: s.ctrlstate });
        }
        if (!run.recording) { return; }
        const last = run.transitions[run.transitions.length - 1];
        if (last && last.quality === s.quality && last.reason === s.qualityReason && last.connected === s.connected) { return; }
        run.transitions.push({ at: Date.now() - (run.restartedAt ?? Date.now()), quality: s.quality, reason: s.qualityReason, connected: s.connected });
      });
    }
    const offAccess = m.onAccessEvent((e: AccessEvent) => {
      if (!run.recording) { return; }
      run.accessEvents.push({ at: e.at, type: e.type, lock: e.lock, ...(e.type === 'lost' ? { reason: e.reason } : {}) });
    });
    m.onError(async (msg, actions) => {
      run.errorCalls.push({ at: Date.now() - (run.restartedAt ?? Date.now()), msg, actions });
      ctx.note('error listener called', { msg, actions, answer: run.recording ? 'Reconnect' : 'none' });
      return run.recording ? 'Reconnect' : undefined;
    });
    ctx.defer('stop watching the restart', () => {
      run.recording = false;
      offAccess();
      m.onError(async () => undefined);
    });
    run.recording = true;
    ctx.note('restart: before', run.before);

    await m.restartController('restart');
    run.restartedAt = Date.now();
    run.watchState = true;
    ctx.note('restart accepted', { access: m.state.access, quality: m.state.quality });

    // Registered last, so it runs first in afterAll: whatever the tests below
    // did, the restore does not read (or act on) the controller while its
    // state is still passing through the transient after the restart. The
    // settle test after the write waits out a guard stop the write sets off;
    // this is the backstop when that test did not run or did not settle.
    ctx.defer('let the controller state settle before the restore', async () => {
      if (!run.back || run.before?.ctrlstate !== 'motoroff') { run.watchState = false; return; }
      // Any rest state: the restore then puts the motors back to the baseline.
      const r = await settle(null, LANE_END_SETTLE_MS);
      run.watchState = false;
      ctx.note(r.settled
        ? 'records: controller state at the end of the lane, settled'
        : 'controller state not settled at the end of the lane (the restore reports what is left)', {
        ...r, managerSaw: run.managerStates,
      });
    });
  }, 90000);

  it(T.outage, async t => {
    const before = need(t, 'restarted');
    const m = ctx.manager;
    const exclude = new Set([...before.otherPorts, before.port]);
    let misses = 0;
    let sawDown = false;
    let downAt = 0;
    let lie = '';

    const back = await waitFor(async () => {
      const now = Date.now();
      if (!await answersAs(before.port, before.https, ctx.generation)) {
        misses++;
        // One missed probe can be host load; two in a row is a down phase.
        if (misses >= 2 && !sawDown) { sawDown = true; downAt = now; }
        const q = m.state.quality;
        if (sawDown && !lie && now - downAt > DETECT_BUDGET_MS && STEADY.has(q)) {
          lie = `quality read "${q}" ${Math.round((now - downAt) / 1000)} s after the controller became unreachable (${m.state.qualityReason})`;
        }
        if (sawDown) {
          // The restart may have moved the controller: another port of this
          // generation that no other controller holds is taken as this one
          // (confirmed by its system id in the reconnect test).
          const moved = await otherCandidates(ctx.generation, exclude, ctx.systemName);
          if (moved.length === 1) {
            run.back = { at: Date.now(), how: `answers on port ${moved[0]}`, movedTo: moved[0], sawDown, downMs: Date.now() - downAt };
            return true;
          }
          if (moved.length > 1) { ctx.note('several new controllers of this generation - not choosing', { moved }); }
        }
        return false;
      }
      misses = 0;
      if (sawDown) {
        run.back = { at: now, how: 'its port answers again after the down phase', movedTo: null, sawDown, downMs: now - downAt };
        return true;
      }
      // No down phase seen yet: the restart count rising says it restarted
      // faster than the watch could see it go (RW 7.21 was once back in 7 s).
      const count = await restartCount(ctx);
      if (count !== null && before.restartCount !== null && count > before.restartCount) {
        run.back = { at: now, how: `restart count ${before.restartCount} -> ${count} with no down phase seen`, movedTo: null, sawDown, downMs: null };
        return true;
      }
      if (now - run.restartedAt! > DOWN_SEEN_DEADLINE_MS) {
        run.back = { at: now, how: `port answering and no down phase seen within ${DOWN_SEEN_DEADLINE_MS / 1000} s`, movedTo: null, sawDown, downMs: null };
        return true;
      }
      return false;
    }, RESTART_WINDOW_MS, CHASE_STEP_MS);

    ctx.note('restart outage', {
      back: run.back, secondsToBack: run.back ? Math.round((run.back.at - run.restartedAt!) / 1000) : null,
      transitions: run.transitions, accessEvents: run.accessEvents, errorCalls: run.errorCalls, lie,
    });
    expect(back, `the controller did not come back within ${RESTART_WINDOW_MS / 1000} s of the restart`).toBe(true);
    expect(lie, 'connection quality claimed a working connection during the outage').toBe('');
    for (const tr of run.transitions) {
      expect(tr.reason.trim(), `a ${tr.quality} transition without a reason`).not.toBe('');
      if (tr.connected) {
        expect(tr.quality, 'quality "disconnected" while the manager reads connected').not.toBe('disconnected');
      } else {
        expect(['disconnected', 'reconnecting'], `quality "${tr.quality}" while the manager reads not connected (${tr.reason})`).toContain(tr.quality);
      }
    }
    const downMs = run.back?.downMs ?? 0;
    if (sawDown && downMs > DETECT_BUDGET_MS) {
      expect(run.transitions.some(tr => !STEADY.has(tr.quality)),
        `the controller was away ${Math.round(downMs / 1000)} s and quality never left live/polling`).toBe(true);
    }
  }, RESTART_WINDOW_MS + 60000);

  it(T.self, async t => {
    need(t, 'back');
    const m = ctx.manager;
    const selfBack = await waitFor(() => m.state.connected && STEADY.has(m.state.quality), SELF_RECOVERY_WAIT_MS, 500);
    const autoIdx = run.transitions.findIndex(tr => /auto-disconnected after 3 failed polls/.test(tr.reason));
    if (autoIdx >= 0) {
      // The documented hand-off: the listener is called with a 'Reconnect'
      // action, and its 'Reconnect' answer starts one connect.
      await waitUntil(() => run.errorCalls.length > 0, 5000, 100, 'the error listener called after the auto-disconnect');
      expect(run.errorCalls[0].actions).toContain('Reconnect');
      expect(run.errorCalls[0].msg).toMatch(/disconnected/i);
      await waitUntil(() => run.transitions.slice(autoIdx + 1).some(tr => tr.quality === 'reconnecting'), 10000, 100,
        'the one reconnect the listener\'s answer starts');
    }
    const s = m.state;
    if (s.connected) { expect(s.quality).not.toBe('disconnected'); } else { expect(['disconnected', 'reconnecting']).toContain(s.quality); }
    expect(s.qualityReason.trim()).not.toBe('');
    ctx.note('records: came back by itself', {
      selfBack, autoDisconnected: autoIdx >= 0, errorCalls: run.errorCalls.length,
      quality: s.quality, reason: s.qualityReason, port: m.currentPort, heldLocks: heldLocks(m),
      transitions: run.transitions, accessEvents: run.accessEvents,
    });
  }, SELF_RECOVERY_WAIT_MS + 60000);

  it(T.refind, async t => {
    const before = need(t, 'back');
    const m = ctx.manager;
    const errors: string[] = [];
    // The consumer's recovery: connect to the port it knew. The manager
    // checks that port and, when it is silent or answers as another
    // controller, scans this machine and adopts only the controller with the
    // system id it read before.
    const steady = await waitFor(async () => {
      if (m.state.connected && STEADY.has(m.state.quality)) { return true; }
      if (m.state.quality === 'disconnected') {
        await m.connect(HOST, TEST_USER, TEST_PASS, before.port, before.https).catch(e => { errors.push(errText(e)); });
      }
      return m.state.connected && STEADY.has(m.state.quality);
    }, CONSUMER_RECONNECT_MS, 5000);
    for (const e of errors) { ctx.note('connect after the restart refused', { error: e }); }
    expect(steady, `the manager did not reconnect within ${CONSUMER_RECONNECT_MS / 1000} s; `
      + `quality ${m.state.quality} (${m.state.qualityReason}); last errors: ${errors.slice(-3).join(' | ') || 'none'}`).toBe(true);
    await waitUntil(() => !!m.state.systemInfo, 20000, 250, 'system info after the reconnect');
    expect(sameSystemId(m.state.systemInfo!.sysid, before.sysid), 'the manager reconnected to a different controller').toBe(true);
    expect(m.state.systemInfo!.name).toBe(before.systemName);
    expect(m.currentUseHttps).toBe(before.https);
    // The hold the restart took belonged to the old session: none is counted now.
    expect(heldLocks(m)).toEqual([]);
    run.recovered = { port: m.currentPort!, https: m.currentUseHttps! };
    if (run.back?.movedTo !== null && run.back?.movedTo !== undefined) {
      expect(run.recovered.port, 'the manager did not follow the controller to the port it moved to').toBe(run.back.movedTo);
    }

    // The harness follows too, by its own discovery of this machine: an
    // independent check that the port the manager chose is this controller's.
    run.recording = false;
    await ctx.reconnect({ rediscover: true });
    run.reconnected = true;
    expect(ctx.systemName).toBe(before.systemName);
    expect(ctx.rwVersion).toBe(before.rwVersion);
    expect(ctx.port).toBe(run.recovered.port);
    expect(ctx.https).toBe(run.recovered.https);
    // RW 7.21 kept its port across earlier warm restarts; recorded, not asserted.
    ctx.note('records: port after the restart', {
      before: before.port, after: ctx.port, moved: ctx.port !== before.port, connectErrors: errors.length,
    });
  }, CONSUMER_RECONNECT_MS + 60000);

  it(T.reads, async t => {
    const before = need(t, 'reconnected');
    const m = ctx.manager;
    await waitUntil(() => m.state.systemInfo?.rwVersion === before.rwVersion, 30000, 250, 'system info after the restart');
    // A freshly booted controller may refuse reads for a few seconds.
    await waitUntil(async () => {
      const p = await ctx.panel();
      return !!p.opmode && !!p.ctrlstate && p.speedRatio !== null && !!p.execstate;
    }, 60000, 500, 'direct panel and execution reads after the restart');
    // Compared with a fresh direct read each time: right after a restart the
    // controller state still moves (RW 7.21.4 passed through motors on, guard
    // stop and motors off in the first 30 s, 2026-09-30), so one early read can
    // be stale while the manager correctly follows the later state.
    let lastPanel = await ctx.panel();
    const agreed = await waitFor(async () => {
      lastPanel = await ctx.panel();
      return m.state.opmode === lastPanel.opmode
        && m.state.ctrlstate === lastPanel.ctrlstate
        && m.state.speedRatio === lastPanel.speedRatio
        && m.state.execstate === lastPanel.execstate;
    }, 60000, 1000);
    expect(agreed, `manager state never equalled a direct read within 60 s; last direct read ${JSON.stringify(lastPanel)}, `
      + `manager ${JSON.stringify({ opmode: m.state.opmode, ctrlstate: m.state.ctrlstate, speedRatio: m.state.speedRatio, execstate: m.state.execstate })}`).toBe(true);

    expect(m.state.tasks.map(x => x.name)).toContain(ctx.task);
    await waitUntil(() => (m.state.modulesByTask[ctx.task] ?? []).length > 0, 20000, 250, `modules of ${ctx.task}`);
    expect(m.state.mechunits).toContain(ctx.mechunit);
    await waitUntil(() => m.state.joints !== null, 20000, 250, 'joints after the restart');
    for (const v of Object.values(m.state.joints!)) { expect(Number.isFinite(v)).toBe(true); }

    const count = await restartCount(ctx);
    if (before.restartCount !== null) {
      expect(count, 'the restart count read failed after the restart').not.toBeNull();
      expect(count!).toBeGreaterThanOrEqual(before.restartCount);
    }
    const modules = m.state.modulesByTask[ctx.task] ?? [];
    const jointDelta = before.joints && m.state.joints
      ? Math.max(...([1, 2, 3, 4, 5, 6] as const).map(i => {
        const k = `rax_${i}` as keyof JointTarget;
        return Math.abs(m.state.joints![k] - before.joints![k]);
      }))
      : null;
    ctx.note('records: state after the restart', {
      restartCount: { before: before.restartCount, after: count },
      modulesSame: [...modules].sort().join(',') === [...before.modules].sort().join(','),
      modules, maxJointDeltaDeg: jointDelta,
    });
  }, 150000);

  it(T.settle, async t => {
    const before = need(t, 'reconnected');
    if (before.ctrlstate !== 'motoroff') {
      ctx.skip(t, `the settle is observed from motors off, the state the rw7 runs started from; the controller read ${before.ctrlstate} before the restart`);
    }
    // Before the write test on purpose: whether a transient shows up here,
    // with no write sent since the restart, is what the record tells.
    await settleAndFollow('records: controller state after the restart, read until it settled (nothing sent but reads)',
      {}, r => { run.settled = r.settled; });
  }, SETTLE_TEST_MS);

  it(T.panel, async t => {
    const before = need(t, 'reconnected');
    // Read after the settle test, so the controller state recorded here is
    // not a transient one.
    const p = await ctx.panel();
    // The operating mode is the key switch's; a restart does not turn it.
    expect(p.opmode).toBe(before.opmode);
    expect(p.execstate).toBe('stopped');
    expect(typeof p.speedRatio).toBe('number');
    expect(Number.isInteger(p.speedRatio)).toBe(true);
    expect(p.speedRatio!).toBeGreaterThanOrEqual(0);
    expect(p.speedRatio!).toBeLessThanOrEqual(100);
    ctx.note('records: speed ratio and controller state after the restart', {
      speedBeforeRestart: before.marker, speedAfterRestart: p.speedRatio, kept: p.speedRatio === before.marker,
      ctrlstate: { before: before.ctrlstate, after: p.ctrlstate, afterSettle: run.settled },
    });
  }, 60000);

  it(T.write, async t => {
    const before = need(t, 'reconnected');
    const m = ctx.manager;
    const refusals: string[] = [];
    const untyped: string[] = [];
    // waitFor counts a throw as "not yet", so failures are collected here and
    // asserted after it.
    const wrote = await waitFor(async () => {
      try {
        await m.setSpeedRatio(before.speedRatio);
        run.wroteAt = Date.now() - run.restartedAt!;
        return true;
      } catch (e) {
        if (!(e instanceof RwsError)) { untyped.push(errText(e)); }
        refusals.push(errText(e));
        return false;
      }
    }, WRITE_SETTLE_MS, 2000);
    if (refusals.length) { ctx.note('speed-ratio write refused at first after the restart', { refusals }); }
    expect(untyped, 'the write failed with a non-RwsError').toEqual([]);
    expect(wrote, `the speed-ratio write kept failing after the restart: ${refusals.slice(-3).join(' | ')}`).toBe(true);
    await waitUntil(async () => (await ctx.panel()).speedRatio === before.speedRatio, 10000, 250, `speed ratio ${before.speedRatio} read back`);
    await waitUntil(() => m.state.speedRatio === before.speedRatio, 20000, 250, 'the manager state follows the write');
    // The write's hold was released, and nothing from before the restart is counted.
    await waitUntil(() => heldLocks(m).length === 0, 10000, 250, 'no hold counted after the write');
  }, WRITE_SETTLE_MS + 60000);

  it(T.resettle, async t => {
    const before = need(t, 'reconnected');
    if (before.ctrlstate !== 'motoroff') {
      ctx.skip(t, `the settle is observed from motors off, the state the rw7 runs started from; the controller read ${before.ctrlstate} before the restart`);
    }
    if (run.wroteAt === null) { ctx.skip(t, 'the speed-ratio write after the restart was not made (see the write test)'); }
    // After the write on purpose: a guard stop the write sets off begins after
    // the first settle test passed, and is waited out here with the full
    // window, not only by the shorter lane-end backstop. This record, next to
    // the first settle test's, tells a transient that follows the write from
    // one that comes without it.
    await settleAndFollow('records: controller state after the speed-ratio write, read until it settled (nothing sent but reads)',
      { wroteAt: run.wroteAt, settledBeforeWrite: run.settled });
  }, SETTLE_TEST_MS);
}

// Lanes the guard allows a restart on run the tests; every other lane is
// declared skipped with the guard's reason, without opening a session on it.
if (!FUNCTIONAL_ENABLED) {
  await forEachController(FILE_TAG, restartTests);
} else {
  for (const lane of LANES) {
    const decision = allowed('restart', lane);
    if (decision.ok) {
      await forEachController(FILE_TAG, restartTests, { lanes: [lane] });
      continue;
    }
    recordSkip({ file: FILE_TAG, lane, test: '*', reason: decision.reason });
    describe.skip(`${FILE_TAG}/${lane}`, () => {
      for (const title of Object.values(T)) { it(title, () => undefined); }
    });
  }
}
