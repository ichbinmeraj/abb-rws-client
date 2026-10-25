/**
 * `forEachController` - the functional suite's describe-per-controller
 * scaffolding, and the context every test body gets.
 *
 *   await forEachController('10-rapid', ctx => {
 *     it('loads and runs a module', async t => { ... ctx.manager ... });
 *   });
 *
 * One `describe('<fileTag>/<lane>')` per lane (rw6, rw7, rw8). A lane is
 * skipped - never passed - when RWS_FUNCTIONAL is not '1' (a plain
 * `npm test`: nothing is discovered or sent), when no controller of that
 * RobotWare major is running, or when RWS_FUNCTIONAL_ONLY leaves it out.
 * A lane fails instead when discovery found a controller that could have
 * taken it but could not use it (a failed login, mostly): its beforeAll
 * throws, naming the controller's address and the reason.
 * The call must be awaited at the top level of the test file: discovery is
 * asynchronous and vitest collects the file's describes when its top-level
 * awaits have settled.
 *
 * Per lane, the harness owns everything that must not be left to discipline:
 *   beforeAll  trace routed to <lane>.jsonl; the lane's RobotManager
 *              connected and checked to be the RobotWare major of the lane;
 *              leftovers of an earlier run (ZZ_PROBE modules, files, queues)
 *              cleaned; the baseline snapshot taken. A lane whose mode reads
 *              a pending change (AUTO_CH, ...) or anything but Auto is an
 *              environment blocker: no baseline, every test skipped with
 *              "confirm Auto at the <lane> pendant".
 *   afterAll   deferred undo steps (ctx.defer, last first); the extra
 *              sessions the context handed out logged out; restore to the
 *              baseline (RAPID stopped, ZZ_PROBE unloaded and deleted,
 *              program pointer, speed ratio, operation mode, motors, holds
 *              released); observer and manager logged out. A restore that
 *              leaves differences fails the hook, after the cleanup, naming
 *              them.
 *
 * Test infrastructure only - never shipped in the package.
 */

import { describe, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  RobotManager, RwsError, createAdapter, createClient,
  type AnyClient, type ConnectOptions, type IRWSAdapter, type RobotManagerOptions,
} from '../../../src/index.js';
import {
  FUNCTIONAL_ENABLED, FUNCTIONAL_STATION, HOST, LANES, LANE_GENERATION, LANE_MAJOR, TEST_PASS, TEST_USER,
  assertLocalhost, onlyLanes, type Generation, type Lane, type RwMajor,
} from './config.js';
import { discoverFleet, fleetController, forgetFleet, laneForVersion, laneUnusable, type FleetController } from './fleet.js';
import { MOTION_LIMITS, allowed, isVirtualIdentity, type GuardDecision, type GuardFacts, type GuardKind } from './guard.js';
import { unload, uploadAndLoad, type GeneratedModule, type LoadedModule, type RapidTarget } from './rapid.js';
import {
  baselineBlocker, probeModules, readPanel, restoreState, snapshotState, volumeRoots, waitUntil,
  type PanelState, type RestoreReport, type StateSnapshot, type StateTarget,
} from './state.js';
import {
  harnessNote, installTrace, labelSession, recordHookFailure, recordSkip, setTraceLane, withTraceSession, writeTrace,
} from './trace.js';
import { managerRws2 } from './vc.js';

/** The part of vitest's test context the harness uses (pass the test's `t`). */
export interface TestHandle {
  task: { name: string };
  skip: () => void;
}

export interface FunctionalContext extends StateTarget, RapidTarget {
  readonly fileTag: string;
  readonly lane: Lane;
  readonly generation: Generation;
  readonly rwMajor: RwMajor;
  /** False when the lane is skipped; `skipReason` says why. */
  readonly active: boolean;
  readonly skipReason: string | null;
  /**
   * Set in beforeAll when the lane's mode is not fit for a baseline (a
   * pending change such as AUTO_CH, or a mode other than Auto): an
   * environment blocker, never a baseline. Every test of the lane is then
   * skipped with it, and afterAll restores nothing.
   */
  readonly blocker: string | null;
  /** The discovered controller (throws on a skipped lane). */
  readonly controller: FleetController;
  readonly host: string;
  /** Port and scheme of the controller (0 / false on a skipped lane). */
  readonly port: number;
  readonly https: boolean;
  readonly rwVersion: string;
  readonly systemName: string;
  /** The motion task (resolved in beforeAll; T_ROB1 until then). */
  readonly task: string;
  /** The first mechanical unit (resolved in beforeAll; ROB_1 until then). */
  readonly mechunit: string;
  /** `$HOME` / `HOME` and `$TEMP` / `TEMP` for the lane's generation. */
  readonly home: string;
  readonly temp: string;

  /** The lane's RobotManager, connected in beforeAll (throws before that and after afterAll). */
  readonly manager: RobotManager;
  connectedManager(): RobotManager | null;
  ensureManager(): Promise<RobotManager>;
  /**
   * Disconnect and connect the lane's manager again; with `rediscover`, forget
   * the fleet first and pick up the lane's controller on its new port (after a
   * restart), replacing the observer session too.
   */
  reconnect(opts?: { rediscover?: boolean }): Promise<RobotManager>;

  /**
   * An IRWSAdapter for direct reads (never the manager's cached state). RWS
   * 2.0: the harness's own session. RWS 1.0 (rw6): the manager's own adapter
   * while it is connected (the RW6 virtual controller refuses a further
   * session then), else an extra adapter the test opened, else a harness
   * session. Ask for it at each use; do not keep it across a reconnect.
   */
  observer(): Promise<IRWSAdapter>;
  /**
   * A new connected adapter session (createAdapter), logged out by the
   * harness. On rw6 this is refused while `manager` is connected: disconnect
   * it first for a two-session test (restore reconnects it).
   */
  newAdapter(opts?: Partial<ConnectOptions>): Promise<IRWSAdapter>;
  /** A new connected protocol client (createClient), logged out by the harness. Same rw6 rule. */
  newClient(opts?: Partial<ConnectOptions>): Promise<AnyClient>;
  /** A second RobotManager on the same controller (anonymous RW8 station unless given one). Same rw6 rule. */
  newManager(opts?: RobotManagerOptions): Promise<RobotManager>;
  /** Log out one session the context handed out, now instead of in afterAll. */
  release(session: IRWSAdapter | AnyClient | RobotManager): Promise<void>;

  /** The snapshot taken in beforeAll (throws before that). */
  readonly baseline: StateSnapshot;
  snapshot(): Promise<StateSnapshot>;
  /** Restore to `to` (default: the baseline) now. Never throws. */
  restore(to?: StateSnapshot): Promise<RestoreReport>;
  /** Opmode, ctrlstate, speed ratio and execution state, read through the observer. */
  panel(): Promise<PanelState>;
  /** Register an undo step, run in afterAll (last registered first) before the restore. */
  defer(label: string, fn: () => unknown): void;

  /** The guard's decision for this lane (pure; see guard.ts). */
  allowed(kind: GuardKind, facts?: GuardFacts): GuardDecision;
  /** The guard's decision with the live facts it needs read first. */
  allowedNow(kind: GuardKind): Promise<GuardDecision>;
  /** Skip the test with the guard's reason unless `kind` is allowed now. */
  requireAllowed(t: TestHandle, kind: GuardKind): Promise<GuardDecision>;
  /** Skip the test, recording the reason (vitest 1.x has no skip note). */
  skip(t: TestHandle, reason: string): never;
  /**
   * Get ready for a RAPID run: the guard for `kind` checked (default
   * `motion`; `rapid-start` for a program without motion), skipping with the
   * reason; Auto required; RAPID stopped; motors on where the lane allows it
   * (RW8: skips unless the pendant already has them on); speed ratio lowered
   * to `speedRatio` (default and ceiling 50). RW8: the motion-control
   * declaration made in the manager's own session, which a RAPID start from
   * a remote station needs there, only under the person's opt-in (guard kind
   * `motion-control`; the test skips with the reason otherwise) and withdrawn
   * in afterAll. Restore puts all of it back.
   */
  prepareMotion(t: TestHandle, opts?: { speedRatio?: number; kind?: 'motion' | 'rapid-start' }): Promise<{ speedRatio: number }>;

  /** Upload and load a ZZ_PROBE module through the client (see rapid.ts). */
  loadModule(mod: Pick<GeneratedModule, 'name' | 'text'>, opts?: { task?: string }): Promise<LoadedModule>;
  /** Unload a ZZ_PROBE module and delete its file (idempotent). */
  unloadModule(name: string, opts?: { task?: string; keepFile?: boolean }): Promise<void>;

  /** Append a note to the lane's trace. */
  note(msg: string, data?: unknown): void;
}

type Session = { kind: 'adapter'; s: IRWSAdapter } | { kind: 'client'; s: AnyClient } | { kind: 'manager'; s: RobotManager };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Pauses before each retry of a new session the controller refused as busy (503). */
const BUSY_RETRY_MS = [2000, 5000];

/**
 * Timeout of each lane's beforeAll and afterAll. The deferred steps, the
 * session logouts and the restore all share afterAll's; a hook that times out
 * never reaches its finally block, so its sessions are not logged out.
 */
export const LANE_HOOK_TIMEOUT_MS = 180000;
/** Request timeout of every session the context opens. */
export const LANE_REQUEST_TIMEOUT_MS = 8000;

/**
 * Open a session, retrying a CONTROLLER_BUSY refusal twice with a pause. The
 * RW6 virtual controller answers a new session 503 for a while when it is
 * under session pressure; a short wait is often enough, and a longer one is
 * not the harness's to hide.
 */
async function openSession<T>(label: string, open: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await open();
    } catch (e) {
      if (!(e instanceof RwsError && e.code === 'CONTROLLER_BUSY') || attempt >= BUSY_RETRY_MS.length) { throw e; }
      harnessNote(`${label}: the controller answered a new session busy (503) - retrying in ${BUSY_RETRY_MS[attempt]} ms`);
      await new Promise(r => setTimeout(r, BUSY_RETRY_MS[attempt]));
    }
  }
}

function makeContext(fileTag: string, lane: Lane, initial: FleetController | null, skipReason: string | null): FunctionalContext & {
  _setup(): Promise<void>;
  _teardown(): Promise<void>;
} {
  let member = initial;
  let main: RobotManager | null = null;
  let obs: IRWSAdapter | null = null;
  let baseline: StateSnapshot | null = null;
  let blocker: string | null = null;
  let task = 'T_ROB1';
  let mechunit = 'ROB_1';
  const sessions: Session[] = [];
  const deferred: Array<{ label: string; fn: () => unknown }> = [];
  const generation = LANE_GENERATION[lane];
  const roots = volumeRoots(generation);

  // Session labels for the trace (trace.ts, labelSession). The lane's manager
  // is `manager#<n>`, n counting its connects; the harness's own observer
  // `observer#<n>`; extra sessions `adapter-<k>`, `client-<k>`, `manager-<k>`.
  let mainConnects = 0;
  let mainLabel = 'manager#0';
  let observerOpens = 0;
  let extraSeq = 0;

  const requireMember = (): FleetController => {
    if (!member) { throw new Error(`${fileTag}/${lane}: no controller (${skipReason ?? 'not discovered'})`); }
    return member;
  };

  const connectOpts = (opts: Partial<ConnectOptions> = {}): ConnectOptions => {
    const m = requireMember();
    const host = opts.host ?? HOST;
    assertLocalhost(host);
    return {
      host, port: m.port, https: m.https, username: TEST_USER, password: TEST_PASS, timeout: LANE_REQUEST_TIMEOUT_MS, ...opts,
    };
  };

  const disconnectSession = async (x: Session): Promise<void> => {
    try { await x.s.disconnect(); } catch (e) { harnessNote(`logout of a ${x.kind} session failed: ${errText(e)}`); }
  };

  /**
   * RWS 1.0 lane: the observer reads through the manager's own session.
   *
   * The RW6 virtual controller refuses a further session (503) while a
   * connected RobotManager - its session plus its subscription - is up, and
   * accepts it again once the manager logs out. Live-verified 2026-09-30 on
   * RW 6.16.03 (6.16.3007): two plain sessions were accepted and a third
   * refused; with a RobotManager connected, every new session was refused
   * until it disconnected. So on this lane the observer is the manager's own
   * adapter (reads straight from the controller, bypassing the manager's
   * cached state, on the same session), and a harness-owned observer session
   * is opened only while the manager is down and closed before it reconnects.
   */
  const sharesManagerSession = generation === 'rws1';
  /** The manager's own adapter, labelled as the manager's session (the same RWS session). */
  const managerAdapter = (): IRWSAdapter | null => {
    const a = main && main.state.connected ? (main as unknown as { adapter: IRWSAdapter | null }).adapter : null;
    return a ? labelSession(a, () => mainLabel) : null;
  };

  const closeOwnObserver = async (): Promise<void> => {
    if (obs) { const o = obs; obs = null; await disconnectSession({ kind: 'adapter', s: o }); }
  };

  /** A new adapter session labelled `label`, its login included. */
  const openAdapter = async (label: string, opts?: Partial<ConnectOptions>): Promise<IRWSAdapter> =>
    labelSession(await openSession(`${lane} ${label}`, () => withTraceSession(label, () => createAdapter(connectOpts(opts)))), label);

  const connectMain = async (): Promise<RobotManager> => {
    const m = requireMember();
    if (!main) { main = labelSession(new RobotManager({ controlStation: FUNCTIONAL_STATION }), () => mainLabel); }
    const mgr = main;
    if (!mgr.state.connected) {
      if (sharesManagerSession) { await closeOwnObserver(); }
      mainLabel = `manager#${++mainConnects}`;
      await openSession(`${lane} manager`, () => mgr.connect(HOST, TEST_USER, TEST_PASS, m.port, m.https));
    }
    return mgr;
  };

  const observer = async (): Promise<IRWSAdapter> => {
    if (sharesManagerSession) {
      const shared = managerAdapter();
      if (shared) { return shared; }
      const extra = sessions.find(x => x.kind === 'adapter');
      if (extra) { return extra.s as IRWSAdapter; }
    }
    if (!obs) { obs = await openAdapter(`observer#${++observerOpens}`); }
    return obs;
  };

  /** A refused extra session on the RW6 lane, explained. */
  const explainBusy = (e: unknown): unknown => {
    if (sharesManagerSession && e instanceof RwsError && e.code === 'CONTROLLER_BUSY' && main?.state.connected) {
      return new Error(
        `${fileTag}/${lane}: the RW6 virtual controller refused another session (503) while the lane's RobotManager is connected. `
        + 'For a test that needs two sessions there, disconnect ctx.manager first (restore reconnects it).');
    }
    return e;
  };

  const skip = (t: TestHandle, reason: string): never => {
    recordSkip({ file: fileTag, lane, test: t.task.name, reason });
    t.skip();
    // t.skip() throws vitest's pending error; this line is for the type checker.
    throw new Error(`skipped: ${reason}`);
  };

  const panel = async (): Promise<PanelState> => readPanel(await observer());

  /**
   * RobotWare 8: the motion-control declaration a RAPID start from this remote
   * station needs (RW 8.2.1 refused the start 403 -1073435864 without it, also
   * for a program that moves nothing, and ran it with it; 2026-10-18). The
   * declaration belongs to the session that made it, so it is made in the
   * manager's own session, through RobotManager, after the guard (kind
   * `motion-control`) allowed it. Nothing is sent when it already reads true.
   * The first declaration registers its withdrawal as a deferred step, which
   * runs in afterAll after the steps of later tests (a robot moved back by a
   * RAPID run still has it) and before the restore.
   */
  let withdrawalRegistered = false;
  const declareMotionControl = async (t: TestHandle, mgr: RobotManager): Promise<void> => {
    const a = managerRws2(mgr);
    if (!a) { throw new Error(`${fileTag}/${lane}: the RobotWare 8 lane has no RWS 2.0 manager session`); }
    if (await a.getAllowMotionControl()) { return; }
    if (!withdrawalRegistered) {
      withdrawalRegistered = true;
      deferred.push({ label: 'motion-control declaration withdrawn', fn: withdrawMotionControl });
    }
    await mgr.setAllowMotionControl(true);
    if (!(await a.getAllowMotionControl())) { throw new Error('allow-motion-control does not read true after the declaration'); }
    harnessNote(`motion control declared in the manager's session for "${t.task.name}"`);
  };
  /** Put the declaration back to false in the manager's current session; nothing is sent when it reads false. */
  const withdrawMotionControl = async (): Promise<void> => {
    const mgr = main && main.state.connected ? main : null;
    const a = mgr ? managerRws2(mgr) : null;
    if (!mgr || !a) { harnessNote('motion-control withdrawal: no manager session (the declaration belonged to a session that has ended)'); return; }
    if (!(await a.getAllowMotionControl())) { return; }
    await mgr.setAllowMotionControl(false);
    if (await a.getAllowMotionControl()) { throw new Error('allow-motion-control still reads true after the withdrawal'); }
    harnessNote('motion control withdrawn in the manager\'s session');
  };

  const ctx: FunctionalContext & { _setup(): Promise<void>; _teardown(): Promise<void> } = {
    fileTag,
    lane,
    generation,
    rwMajor: LANE_MAJOR[lane],
    active: initial !== null && skipReason === null,
    skipReason,
    get blocker() { return blocker; },
    get controller() { return requireMember(); },
    host: HOST,
    get port() { return member?.port ?? 0; },
    get https() { return member?.https ?? false; },
    get rwVersion() { return member?.rwVersion ?? ''; },
    get systemName() { return member?.systemName ?? ''; },
    get task() { return task; },
    get mechunit() { return mechunit; },
    home: roots.home,
    temp: roots.temp,

    get manager(): RobotManager {
      if (!main) { throw new Error(`${fileTag}/${lane}: the manager is not connected yet - use it inside a test or hook`); }
      return main;
    },
    connectedManager: () => (main && main.state.connected ? main : null),
    ensureManager: connectMain,

    async reconnect(opts = {}) {
      if (opts.rediscover) {
        forgetFleet();
        const found = await fleetController(lane);
        if (!found) { throw new Error(`${lane}: no controller found on rediscovery`); }
        if (member && (found.port !== member.port)) { harnessNote(`${lane} moved from :${member.port} to :${found.port}`); }
        member = found;
      }
      if (main) { await main.disconnect().catch(() => undefined); }
      // The observer is replaced only when the controller may have moved;
      // otherwise its session stays (fewer logins on the RW6 controller).
      if (opts.rediscover || sharesManagerSession) { await closeOwnObserver(); }
      if (!sharesManagerSession) { await observer(); }
      return connectMain();
    },

    observer,

    async newAdapter(opts) {
      if (sharesManagerSession) { await closeOwnObserver(); }
      const a = await openAdapter(`adapter-${++extraSeq}`, opts).catch(e => { throw explainBusy(e); });
      sessions.push({ kind: 'adapter', s: a });
      return a;
    },
    async newClient(opts) {
      if (sharesManagerSession) { await closeOwnObserver(); }
      const label = `client-${++extraSeq}`;
      const c = labelSession(
        await openSession(`${lane} ${label}`, () => withTraceSession(label, () => createClient(connectOpts(opts))))
          .catch(e => { throw explainBusy(e); }),
        label,
      );
      sessions.push({ kind: 'client', s: c });
      return c;
    },
    async newManager(opts = {}) {
      const m = requireMember();
      if (sharesManagerSession) { await closeOwnObserver(); }
      const mgr = labelSession(new RobotManager(opts), `manager-${++extraSeq}`);
      // Tracked before connect: a connect that fails partway may still hold a session.
      sessions.push({ kind: 'manager', s: mgr });
      await openSession(`${lane} extra manager`, () => mgr.connect(HOST, TEST_USER, TEST_PASS, m.port, m.https))
        .catch(e => { throw explainBusy(e); });
      return mgr;
    },
    async release(session) {
      const i = sessions.findIndex(x => x.s === session);
      if (i >= 0) { const [x] = sessions.splice(i, 1); await disconnectSession(x); return; }
      if (session === main) { await main.disconnect().catch(() => undefined); }
    },

    get baseline(): StateSnapshot {
      if (!baseline) { throw new Error(`${fileTag}/${lane}: no baseline yet - it is taken in beforeAll`); }
      return baseline;
    },
    snapshot: () => snapshotState(ctx),
    restore: (to?: StateSnapshot) => restoreState(ctx, to ?? ctx.baseline),
    panel,
    defer(label, fn) { deferred.push({ label, fn }); },

    allowed: (kind, facts) => allowed(kind, lane, facts),
    async allowedNow(kind) {
      const facts: GuardFacts = {};
      if (lane === 'rw8' && (kind === 'motion' || kind === 'rapid-start')) {
        facts.ctrlstate = (await panel()).ctrlstate;
      }
      if ((kind === 'vc-sim' && generation === 'rws2') || (kind === 'motion-control' && lane === 'rw8')) {
        // The identity straight from the controller, never the manager's cache.
        const o = await observer();
        const type = await o.getControllerIdentity().then(i => i.type, () => null);
        facts.identityType = type;
        facts.virtual = type === null ? null : isVirtualIdentity(type);
        // The motion-control opt-in names one controller by its system name.
        if (kind === 'motion-control') { facts.systemName = await o.getSystemInfo().then(i => i.name || null, () => null); }
      }
      return allowed(kind, lane, facts);
    },
    async requireAllowed(t, kind) {
      const d = await ctx.allowedNow(kind);
      if (!d.ok) { return skip(t, d.reason); }
      harnessNote(`guard ${kind} allowed for "${t.task.name}": ${d.reason}`);
      return d;
    },
    skip,

    async prepareMotion(t, opts = {}) {
      await ctx.requireAllowed(t, opts.kind ?? 'motion');
      // Checked before anything changes; the declaration itself is made last.
      if (lane === 'rw8') { await ctx.requireAllowed(t, 'motion-control'); }
      const max = Math.min(opts.speedRatio ?? MOTION_LIMITS.maxSpeedRatio, MOTION_LIMITS.maxSpeedRatio);
      const p = await panel();
      if (p.opmode !== 'AUTO') { skip(t, `RAPID motion runs in Auto only; the controller reads ${p.opmode}`); }
      if (p.execstate === 'running') { throw new Error('RAPID is running - stop it before preparing a motion test'); }
      const mgr = await connectMain();
      if (p.ctrlstate !== 'motoron') {
        if (lane === 'rw8') { skip(t, 'needs motors on from the RW8 pendant'); }
        await ctx.requireAllowed(t, 'motors');
        await mgr.setMotorsOn();
        await waitUntil(async () => (await panel()).ctrlstate === 'motoron', 10000, 250, 'motors on');
      }
      let speed = p.speedRatio ?? 100;
      if (speed > max) {
        await mgr.setSpeedRatio(max);
        await waitUntil(async () => (await panel()).speedRatio === max, 10000, 250, `speed ratio ${max}`);
        speed = max;
      }
      if (lane === 'rw8') { await declareMotionControl(t, mgr); }
      harnessNote(`motion prepared for "${t.task.name}"`, { speedRatio: speed });
      return { speedRatio: speed };
    },

    loadModule: (mod, opts) => uploadAndLoad(ctx, mod.name, mod.text, opts),
    unloadModule: (name, opts) => unload(ctx, name, opts),

    note(msg, data) { writeTrace('test', msg, data); },

    async _setup() {
      const m = requireMember();
      setTraceLane(lane, fileTag);
      harnessNote(`lane start: ${m.label}`);
      // RWS 2.0: the observer first, its own session. RWS 1.0: the manager
      // first, and the observer is the manager's adapter (sharesManagerSession).
      if (!sharesManagerSession) { await observer(); }
      const mgr = await connectMain();
      const o = await observer();
      await waitUntil(() => !!mgr.state.systemInfo, 20000, 250, `${lane}: first poll (system info)`);
      const version = mgr.state.systemInfo!.rwVersion;
      if (laneForVersion(version) !== lane) {
        throw new Error(`${fileTag}/${lane}: connected to RobotWare ${version} on :${m.port}, not a ${lane} controller - did the port move? (RWS_TEST_PORT_${lane.toUpperCase()})`);
      }
      const tasks = await o.getRapidTasks();
      task = (tasks.find(x => x.active && x.motiontask) ?? tasks.find(x => x.motiontask) ?? tasks[0])?.name ?? task;
      mechunit = (await o.listMechunits().catch(() => [] as string[]))[0] ?? mechunit;

      let snap = await snapshotState(ctx);
      // Checked before anything is written: a lane in AUTO_CH or out of Auto
      // is the environment's state, not one the restore may put back.
      const blocked = baselineBlocker(lane, snap.opmode);
      if (blocked) {
        blocker = blocked;
        recordSkip({ file: fileTag, lane, test: '*', reason: blocked });
        harnessNote('no baseline taken: environment blocker', { opmode: snap.opmode, reason: blocked });
        return;
      }
      if (probeModules(snap).length || snap.probeEntries.length || snap.probeQueues.length) {
        harnessNote('leftovers of an earlier run found - cleaning them before the baseline', {
          modules: probeModules(snap), entries: snap.probeEntries, queues: snap.probeQueues,
        });
        await restoreState(ctx, { ...snap, modulesByTask: {}, probeEntries: [], probeQueues: [] });
        snap = await snapshotState(ctx);
      }
      baseline = snap;
      harnessNote('baseline', snap);
    },

    async _teardown() {
      const problems: string[] = [];
      try {
        while (deferred.length) {
          const d = deferred.pop()!;
          try { await d.fn(); harnessNote(`deferred ok: ${d.label}`); } catch (e) {
            problems.push(`deferred "${d.label}" failed: ${errText(e)}`);
            harnessNote(`deferred failed: ${d.label}`, { error: errText(e) });
          }
        }
        // Extra sessions go before the restore: they may hold access the
        // restore needs, and on RW6 they use the session slots it needs.
        for (const x of sessions.splice(0).reverse()) { await disconnectSession(x); }
        if (baseline) {
          const report = await restoreState(ctx, baseline);
          if (!report.ok) {
            problems.push(...report.actions.filter(a => !a.ok).map(a => `${a.step}: ${a.detail ?? 'failed'}`));
            problems.push(...report.residual);
          }
        }
      } finally {
        for (const x of sessions.splice(0).reverse()) { await disconnectSession(x); }
        if (obs) { const o = obs; obs = null; await disconnectSession({ kind: 'adapter', s: o }); }
        if (main) { await main.disconnect().catch(e => harnessNote(`manager disconnect failed: ${errText(e)}`)); }
        harnessNote('lane end');
        setTraceLane(null, null);
      }
      if (problems.length) {
        throw new Error(`${fileTag}/${lane}: the controller was not fully restored:\n- ${problems.join('\n- ')}`);
      }
    },
  };
  return ctx;
}

/**
 * Declare `describe('<fileTag>/<lane>')` for every lane and run `body` in each
 * with that lane's context. Await it at the top level of the test file.
 */
export async function forEachController(
  fileTag: string,
  body: (ctx: FunctionalContext) => void,
  opts: { lanes?: Lane[] } = {},
): Promise<void> {
  const only = onlyLanes();
  const lanes = LANES.filter(l => (opts.lanes ?? LANES).includes(l));

  if (!FUNCTIONAL_ENABLED) {
    for (const lane of lanes) {
      const ctx = makeContext(fileTag, lane, null, 'RWS_FUNCTIONAL is not 1 (run npm run functional)');
      describe.skip(`${fileTag}/${lane}`, () => body(ctx));
    }
    return;
  }

  installTrace();
  const fleet = await discoverFleet().catch(e => {
    harnessNote(`fleet discovery failed: ${errText(e)}`);
    return null;
  });

  for (const lane of lanes) {
    const member = fleet?.controllers.find(c => c.lane === lane) ?? null;
    let reason: string | null = null;
    let unusable: string | null = null;
    if (only && !only.includes(lane)) { reason = `RWS_FUNCTIONAL_ONLY=${process.env.RWS_FUNCTIONAL_ONLY} leaves ${lane} out`; }
    else if (!fleet) { reason = 'fleet discovery failed (see fleet.jsonl)'; }
    else if (!member) {
      unusable = laneUnusable(fleet, lane);
      if (!unusable) { reason = `no RobotWare ${LANE_MAJOR[lane]} controller is running on localhost`; }
    }

    const ctx = makeContext(fileTag, lane, member, reason ?? unusable);
    const title = `${fileTag}/${lane}`;
    if (reason) {
      recordSkip({ file: fileTag, lane, test: '*', reason });
      describe.skip(title, () => body(ctx));
      continue;
    }
    const hook = (name: 'beforeAll' | 'afterAll', fn: () => Promise<void>) => async (): Promise<void> => {
      try { await fn(); } catch (e) {
        recordHookFailure({ file: fileTag, lane, hook: name, error: errText(e) });
        throw e;
      }
    };
    if (unusable) {
      // A controller of this lane answered but could not be used: the lane
      // fails in beforeAll, naming it, instead of being skipped as if no
      // controller were running (such a skip once hid a failed login while
      // the run reported only passes). A lane left out on purpose
      // (RWS_FUNCTIONAL_ONLY, or by vc-ready before vitest starts) is still
      // skipped above.
      const why = `${title}: ${unusable} - the lane fails rather than skipping; leave it out with RWS_FUNCTIONAL_ONLY to run without it`;
      describe(title, () => {
        beforeAll(hook('beforeAll', async () => { throw new Error(why); }));
        body(ctx);
      });
      continue;
    }
    describe(title, () => {
      beforeAll(hook('beforeAll', () => ctx._setup()), LANE_HOOK_TIMEOUT_MS);
      afterAll(hook('afterAll', () => ctx._teardown()), LANE_HOOK_TIMEOUT_MS);
      // The blocker found in beforeAll skips every test of the lane (recorded once, for the lane).
      beforeEach(t => { if (ctx.blocker) { t.skip(); } });
      body(ctx);
    });
  }
}

/**
 * Run `fn` and return the RwsError it threw; fails with what happened
 * instead when it resolved or threw anything else.
 */
export async function expectRwsError(fn: () => Promise<unknown>): Promise<RwsError> {
  let value: unknown;
  try {
    value = await fn();
  } catch (e) {
    if (e instanceof RwsError) { return e; }
    throw new Error(`expected an RwsError, got ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected an RwsError, but the call resolved with ${JSON.stringify(value)?.slice(0, 200)}`);
}
