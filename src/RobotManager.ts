import { RwsClient } from './RwsClient.js';
import type {
  RapidTask, JointTarget, RobTarget, CartesianFull, ElogMessage,
  FileEntry, SystemInfo, ControllerIdentity, CollisionDetectionState,
  RapidSymbolProperties, RapidSymbolInfo, RapidSymbolSearchParams,
  UiInstruction, RestartMode, Signal, IoNetwork, IoDevice,
  SubscriptionEvent, ConnectionQuality, SubscriptionResource, AnySubscriptionResource,
  SignalSearchExCriteria, CfgValidateRequest, ModifyPositionOptions,
  DiagnosticsInfo, UserRegistration, MastershipDomain,
  JointTargetFull, MechunitDetails, JogParams, RmmpLevel, RmmpRequestOptions, RmmpResult,
  RefusalContext, RefusalHolder,
  CfgTypeInfo, DipcQueueInfo, FileMetadata, RapidRoutineInfo,
  SubscriptionGroupInfo, SubscriptionGroupMember, MotionSupervisionState, PathSupervisionState,
  MechunitMotorCalib, LeadThroughState, WriteAccessStatus, RobotWareCompatibility,
} from './types.js';
import { RwsError } from './types.js';
import { CUT_CREATE } from './HttpSession.js';
import {
  explainRefusal, holderFromMastership, holderFromWriteAccess, holderSentence, refusalError, withReport, builtRefusal,
  MOTION_CONTROL_DECLARE, MOTION_CONTROL_MISSING, MOTION_CONTROL_OFF_CODE, MOTION_CONTROL_RULE, motionControlRemedies, remedy,
} from './refusal.js';
import { toMechunitDetails } from './mechunit.js';
import { scryptSync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IRWSAdapter } from './IRWSAdapter.js';
import { RWS1Adapter } from './RWS1Adapter.js';
import { RWS2Adapter } from './RWS2Adapter.js';
import { Rws2Core } from './rws2/core.js';
import {
  AccessManager, NOT_HELD_CODES, accessOf, mastershipDriver,
  type AccessEvent, type AccessGeneration, type AccessHold, type AccessObservation, type AccessState,
} from './access/AccessManager.js';
import { checkJog, isJogPostError, rws2JogUnitSegment } from './jog.js';
import { Logger } from './Logger.js';
import { decodeUtf8Strict } from './utf8.js';
import { discoverControllersMdns } from './MdnsDiscovery.js';
import type { MdnsController } from './MdnsDiscovery.js';
import { KNOWN_RWS_PORTS } from './detect.js';
import { describeRwsPorts, schemeForPort } from './discovery/scheme.js';
import { RWS_REALM, probeOne, toLegacyProbeResult } from './discovery/probe.js';
import { loginAndRead } from './discovery/identify.js';
import { findControllers as runFindControllers, runDiscovery } from './discovery/findControllers.js';
import { checkManualHost } from './discovery/validate.js';
import { isLocalAddress } from './discovery/addresses.js';
import { isLoopbackHost, sweepOpenPorts } from './discovery/scheduler.js';
import { compareByAddress } from './discovery/merge.js';
import { parseMacNetstat, parseProcNetTcp, recogniseMacNetstat, recogniseProcNetTcp } from './discovery/listeningPorts.js';
import type { FindControllersOptions, FindControllersResult, LocalScanStatus } from './discovery/types.js';
import { checkControlStationIdentity, type ControlStationIdentity } from './controlStation.js';
import {
  isRmmpGranted, normaliseRmmpPrivilege, rmmpCovers, rmmpLevel, rmmpUnsupportedOnRw8, rmmpWaitOptions, waitForRmmp,
  type RmmpPort,
} from './access/rmmp.js';
import { writeAccessStatusReaderOf } from './access/writeAccessStatus.js';
import { motionControlOf, type LocalStationStatus } from './access/motionControl.js';
import { virtualTimeRunningUnsupported } from './paths/ctrl.js';
import { ADAPTER_READ_NAMES, isAdapterReadName, type AdapterReadName, type AdapterReads } from './adapterReads.js';
import { controllerJobName, type ControllerJobName } from './controllerJobs.js';

/**
 * Listener signature for `onError`. The host (VS Code extension, CLI, etc.) can
 * decide how to surface the error - e.g. `vscode.window.showErrorMessage` with
 * the supplied action labels, or a CLI prompt, or just logging.
 *
 * The promise resolves to the action the user chose, or `undefined` if dismissed.
 * RobotManager respects 'Reconnect' specifically (re-runs connect with the prior config).
 */
export type ErrorListener = (msg: string, actions: string[]) => Promise<string | undefined>;

const SESSION_FILE = path.join(os.homedir(), '.abb-rws-session');

export interface RobotManagerOptions {
  /**
   * Fast-poll cadence in ms, used when WebSocket subscriptions are unavailable.
   * Default 1000, clamped to ≥200 (below that the controller's ~20 req/s limit
   * starts rejecting the poll burst). When subscriptions are active, polling
   * drops to 5× this value (positions only).
   */
  refreshIntervalMs?: number;
  /**
   * Verify TLS certificates on HTTPS controllers. Default false - virtual and
   * real controllers alike ship self-signed certs, so verification stays off
   * unless the deployment has a CA-signed cert on the controller. Applies to
   * port probing and to the RWS 2.0 client this manager constructs, which
   * check a certificate against the same authorities: Node's default ones
   * and the operating system's store (tlsTrust.ts). Off, the RWS 2.0 client
   * logs a warning once per host and port (not on this PC's loopback); the
   * README's "TLS certificates" says how to trust a controller's certificate.
   */
  strictTls?: boolean;
  /**
   * The RobotWare 8 control station this manager registers as: a name, a
   * stored braced GUID and a PIN you supply, and optionally
   * `releaseWriteAccessWhenLost` (default false, pending live confirmation).
   * See `ControlStationIdentity`. Every client the manager builds uses it, so
   * the station stays the same across reconnects, including when a virtual
   * controller's port moves. Checked by the constructor, which throws
   * `INVALID_ARGUMENT` for a malformed value. Ignored on RobotWare 6 and 7.
   * Without it the manager registers as an anonymous station, as before, and
   * the client logs that once.
   */
  controlStation?: ControlStationIdentity;
}

export interface RobotState {
  connected: boolean;
  /** Connection health; `qualityReason` explains it in human terms. */
  quality: ConnectionQuality;
  qualityReason: string;
  host: string;
  ctrlstate: string | null;
  opmode: string | null;
  execstate: string | null;
  execCycle: string | null;      // 'once' | 'forever' | 'asis' | 'oncedone'
  speedRatio: number | null;
  coldetstate: CollisionDetectionState | null;
  tasks: RapidTask[];
  modules: string[];             // modules of the primary (active) task - see modulesByTask
  /**
   * Modules of EVERY active task, keyed by task name. MultiMove systems run
   * several active motion tasks with separate module sets; `modules` alone
   * only ever described the first of them.
   */
  modulesByTask: Record<string, string[]>;
  /** The controller's mechanical units (e.g. ['ROB_1']). [] until a read of the list succeeded on this connection; a failed read never puts a guessed unit here. */
  mechunits: string[];
  joints: JointTarget | null;
  cartesian: RobTarget | null;
  cartesianFull: CartesianFull | null;
  identity: ControllerIdentity | null;
  systemInfo: SystemInfo | null;
  /**
   * The domain-0 event log, in the order the controller lists it: newest
   * first on RWS 1.0 (its first page, up to 50 messages), oldest first on
   * RWS 2.0 (the newest 1000 at most). Read whole after connect and on the slow poll; on
   * an elog subscription event only the newest page is read and merged in
   * by sequence number. Replaced by a new array whenever it changes.
   */
  eventLog: ElogMessage[];
  /**
   * Every signal, with its value as of the last whole walk of the signal
   * table (listAllSignals, one request per page of signals). Walked at the
   * first poll of a connection and then at the first poll a minute after
   * the last walk that landed; a failed walk is tried again after 5 s, 10 s,
   * 20 s, 40 s, then each minute. `refreshIoSignals()` walks at once. A value
   * here can be a minute old: for a live one read the signal
   * (`readIoSignal`), or add it to the manager's subscription group
   * (`updateSubscriptionGroup`) and take its events from
   * `onSubscriptionEvent`; `writeIoSignal` updates the entry it wrote.
   */
  ioSignals: Signal[];
  /**
   * True once `ioSignals` was loaded on the CURRENT connection. False while
   * connecting, after every disconnect, and until the first successful
   * signal-table load - so `ioSignals: []` with this false means "not loaded
   * yet", not "this controller has no signals".
   */
  ioSignalsLoaded: boolean;
  /**
   * What this session holds - mastership (RobotWare 6/7) or control-station
   * write access (RobotWare 8) - per lock and since when, whether a hold was
   * lost and why, the RobotWare 7.8+ watchdog, and the RobotWare 8 station
   * name. Updated on every access event (`onAccessEvent`), each of which also
   * fires `onDidChange`, and on every poll. An observation, never permission:
   * the controller decides every write, and a hold in doubt is no longer
   * counted. Empty (`locks: []`) while not connected.
   */
  access: AccessState;
}

export type ChangeHandler = () => void;

export interface ProbeResult {
  port: number;
  useHttps: boolean;
  authType: 'digest' | 'basic';
}

/** In-flight connect attempt - args plus the connectEpoch the attempt runs under. */
interface ConnectAttempt {
  host: string;
  username: string;
  password: string;
  port?: number;
  useHttps?: boolean;
  /**
   * connectEpoch value this attempt is running under. disconnect() bumps the
   * epoch, marking the attempt cancelled - connect() must stop coalescing onto
   * it, or callers get a resolved promise while the manager ends disconnected.
   */
  epoch: number;
  /**
   * Set by a user-initiated disconnect(). The epoch alone can't carry this:
   * doConnect legitimately re-reads the epoch after its own internal teardowns
   * (supersede, already-connected), which would launder a user cancellation
   * back into validity.
   */
  cancelled?: boolean;
}

export interface DiscoveredController extends ProbeResult {
  host: string;
}

export class RobotManager {
  private adapter: IRWSAdapter | null = null;
  private adapterConfig: { host: string; username: string; password: string; port: number } | null = null;
  private errorListener: ErrorListener | null = null;
  /** System id the caller says this manager's controller must have (see setExpectedSystemId). */
  private expectedSystemId: string | null = null;
  /** System id of the controller this manager last read successfully. */
  private knownSystemId: string | null = null;
  private _state: RobotState = {
    connected: false, quality: 'disconnected', qualityReason: 'not connected',
    host: '', ctrlstate: null, opmode: null,
    execstate: null, execCycle: null, speedRatio: null, coldetstate: null,
    tasks: [], modules: [], modulesByTask: {}, mechunits: [], joints: null,
    cartesian: null, cartesianFull: null, identity: null, systemInfo: null,
    eventLog: [], ioSignals: [], ioSignalsLoaded: false,
    access: { generation: null, locks: [], watchdog: null, rw8: null },
  };

  private handlers: ChangeHandler[] = [];
  /** `onAccessEvent` listeners. */
  private accessListeners: Array<(e: AccessEvent) => void> = [];
  /** The access manager whose events this manager follows, and how to stop. */
  private accessWatch: { manager: AccessManager; off: () => void } | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Unsubscribe function returned by adapter.subscribe(); null when not using WebSockets. */
  private unsubscribeFn: (() => Promise<void>) | null = null;
  /** Raw subscription-event taps (`onSubscriptionEvent`). */
  private eventTaps: Array<(event: SubscriptionEvent) => void> = [];

  /**
   * Resource path of the live RWS 2.0 subscription group this manager owns, or
   * `undefined` when there is no group (not connected, polling-only, or an
   * RWS 1.0 controller, whose subscribe handle carries no group path; there
   * `listSubscriptionGroups()` lists the session's groups, and the group
   * edits below take their `groupPath`).
   *
   * Pass it to `updateSubscriptionGroup` / `unsubscribeResource` to add or drop
   * resources on the manager's own stream without tearing it down. Read it
   * fresh each time - a reconnect mints a new group.
   */
  get subscriptionGroupPath(): string | undefined {
    const handle = this.unsubscribeFn as ((() => Promise<void>) & { groupPath?: string }) | null;
    return handle?.groupPath || undefined;
  }
  /** True when WebSocket subscriptions are active (drives reduced polling interval). */
  private subscriptionActive = false;
  /**
   * When the next subscribe retry is due (Date.now() ms), or null when none
   * is: the stream is up, the adapter cannot subscribe, or not connected.
   * See retrySubscriptionsIfDue.
   */
  private subscribeRetryDueAt: number | null = null;
  /** The wait subscribeRetryDueAt was set with: a due time further out means the clock was set back. */
  private subscribeRetryWaitMs = 0;
  /** Subscribe attempts that failed in a row on this connection, the one at connect included: the retry's step. */
  private subscribeFails = 0;
  /** Of those, the latest in a row whose group create got no answer in time (subscribeAttemptFailed). */
  private subscribeUnanswered = 0;
  /**
   * The subscribe retry in flight, at most one, with the adapter it runs
   * on; null when none is. It outlives a disconnect until it settles (a late
   * group is unsubscribed then), so no other retry starts meanwhile, and the
   * next connect's own attempt on that adapter waits for it.
   */
  private subscribeRetry: { adapter: IRWSAdapter; done: Promise<void> } | null = null;
  /**
   * The resources the controller left out of this manager's subscription
   * group while still creating it (the handle's `unbound`, see
   * IRWSAdapter.subscribe): no event comes for them, so the poll reads them.
   * Read from the handle when the subscription starts and after every
   * restore (a reconnect creates a new group, judged on its own answer);
   * empty without a subscription. RW 6.16.03 left `/rw/elog/0` out of every
   * group this manager created for a whole run (2026-10-22);
   * before 1.5.0 the event log then went stale with the quality still `live`.
   */
  private unboundResources: ReadonlySet<string> = new Set();
  /** The interval of the poll timer now installed (installPollTimer); 0 without one. */
  private pollEveryMs = 0;
  /**
   * Subscription events are numbered; each state field remembers the number of
   * the last event that set it. A poll notes the number when it starts reading
   * and does not overwrite a field an event set after that - the poll's value
   * is older than the event's. Live 2026-09-24: without this, speed 50 was
   * reported and then 100 again, written back by a poll that read it earlier.
   */
  private eventSeq = 0;
  private readonly fieldEventSeq = new Map<'ctrlstate' | 'opmode' | 'speedRatio' | 'execstate' | 'coldetstate', number>();
  /** In-flight connect promise - used to dedupe rapid-clicks so we never run two connects in parallel. */
  private connectingPromise: Promise<void> | null = null;
  /** Args of the in-flight connect, so a repeat call can tell "same target" from "new target". */
  private connectingArgs: ConnectAttempt | null = null;
  /** Monotonic counter so old polling timers can detect they've been superseded and self-cancel. */
  private pollGeneration = 0;
  /**
   * Coalescing state for the event-driven event-log re-read (see
   * `refreshEventLogOnEvent`): at most one read in flight, and at most one
   * more queued behind it however many elog events arrive meanwhile.
   * `elogRefreshInFlight` holds the pollGeneration the in-flight read was
   * pinned to (null when none), so a read that outlives its connection can
   * neither block nor unblock the next connection's reads.
   */
  private elogRefreshInFlight: number | null = null;
  private elogRefreshQueued = false;
  /**
   * The pollGeneration in which a whole read of the event log last landed in
   * state (null before any): until one has on the current connection, an
   * elog event reads the whole log; after it, only the newest page, merged
   * in (see refreshEventLogOnEvent).
   */
  private elogFullReadGen: number | null = null;
  /** The pollGeneration on which the controller refused the newest-first page read: events read the whole log there. */
  private elogPageRefusedGen: number | null = null;
  /**
   * Counts writes of `state.eventLog` (writeEventLog). A whole read notes it
   * when it is sent: a different count when it lands means another read
   * (an event's page merge) wrote the log meanwhile, and its newer messages
   * are kept (landWholeEventLog).
   */
  private elogWrites = 0;
  /** Bumped by disconnect() so an in-flight doConnect() can detect it was cancelled and unwind. */
  private connectEpoch = 0;
  /**
   * The connectEpoch the current session came up under; null before the first
   * connect. disconnectInternal() bumps connectEpoch as its FIRST step, so
   * `sessionEpoch === connectEpoch` turns false the moment a teardown starts,
   * while `_state.connected` still reads true until its LAST step. See
   * `sessionAdapter()`.
   */
  private sessionEpoch: number | null = null;
  /**
   * Teardowns (disconnectInternal) between their first step and their last:
   * meanwhile `setAllowMotionControl(true)` is refused before anything is
   * sent, while the teardown withdraws.
   */
  private teardownsRunning = 0;

  private readonly refreshIntervalMs: number;
  private readonly strictTls: boolean;
  /** The checked RobotWare 8 station identity, or null for an anonymous station. */
  private controlStation: ControlStationIdentity | null;
  /** The identity the current adapter was built with (see doConnect). */
  private adapterControlStation: ControlStationIdentity | null = null;

  constructor(opts: RobotManagerOptions = {}) {
    this.refreshIntervalMs = Math.max(200, opts.refreshIntervalMs ?? 1000);
    this.strictTls = opts.strictTls === true;
    this.controlStation = opts.controlStation === undefined
      ? null
      : checkControlStationIdentity(opts.controlStation, 'RobotManagerOptions.controlStation');
  }

  /**
   * Replace the RobotWare 8 control-station identity (null or undefined: back
   * to an anonymous station). Checked at once; a malformed value throws
   * `INVALID_ARGUMENT` and changes nothing. It takes effect when the manager
   * next builds its client, that is at the next `connect()` that is not
   * already connected: RobotWare 8 lets a session register only once, so a
   * session in progress keeps the station it registered as.
   */
  setControlStation(identity: ControlStationIdentity | null | undefined): void {
    this.controlStation = identity === undefined || identity === null
      ? null
      : checkControlStationIdentity(identity, 'controlStation');
  }

  get state(): RobotState { return this._state; }
  /** The port currently in use (or last attempted). Useful for persisting auto-recovered port changes. */
  get currentPort(): number | undefined { return this.adapterConfig?.port; }
  /** The HTTPS flag matching `currentPort`. */
  get currentUseHttps(): boolean | undefined {
    if (!this.adapter || !this.adapterConfig) { return undefined; }
    // RWS2Adapter is HTTPS, RWS1Adapter is HTTP. instanceof, not constructor.name -
    // minified bundles rename classes, which made this persist the wrong protocol.
    return this.adapter instanceof RWS2Adapter;
  }
  onDidChange(fn: ChangeHandler) { this.handlers.push(fn); }

  /**
   * Tap the manager's raw subscription-event stream (2026-09-27, for the
   * daemon's I/O watch - slice 5). Every event the manager's own subscription
   * group delivers passes through here, INCLUDING resources the manager does
   * not consume itself: a consumer that adds resources to the live group (e.g.
   * `{ type: 'signal', name }` via `updateSubscriptionGroup` on RWS 2.0, see
   * `subscriptionGroupPath`) receives their events only through this tap -
   * they are not part of `RobotState`. Events arrive only while connected.
   * Returns a function that removes the tap.
   */
  onSubscriptionEvent(fn: (event: SubscriptionEvent) => void): () => void {
    this.eventTaps.push(fn);
    return () => {
      const i = this.eventTaps.indexOf(fn);
      if (i >= 0) { this.eventTaps.splice(i, 1); }
    };
  }

  /**
   * Follow what this session holds: every `AccessEvent` of the connected
   * controller's session - a lock granted (`acquired`) or released
   * (`released`), a hold lost (`lost`, with the reason: a write or release
   * refused as not held, a re-issued session, an operating-mode change, a
   * lapsed RobotWare 7.8+ watchdog, a lost connection), a release that failed
   * (`releaseFailed`), a hold at risk (`atRisk`). `RobotState.access` is
   * updated first, and each event also fires `onDidChange`. Nested holds
   * (a write inside your own `requestMastership` hold) produce no event.
   * Returns a function that removes the listener.
   *
   * After a loss the client does not take the access back by itself: the
   * operation that held it fails at its next step that needs access, and the
   * next operation requests afresh.
   */
  onAccessEvent(fn: (event: AccessEvent) => void): () => void {
    this.accessListeners.push(fn);
    if (this.adapter) { this.watchAccess(this.accessIfAny(this.adapter)); }
    return () => {
      const i = this.accessListeners.indexOf(fn);
      if (i >= 0) { this.accessListeners.splice(i, 1); }
    };
  }

  /** Follow `m`'s events (the current adapter's session), and only `m`'s. */
  private watchAccess(m: AccessManager | undefined): void {
    if (!m || this.accessWatch?.manager === m) { return; }
    this.unwatchAccess();
    const off = m.on(e => this.onAccessObservation(m, e));
    // A refusal of this session is explained with what this manager knows.
    m.setRefusalContextSource(() => this.refusalContextNow());
    this.accessWatch = { manager: m, off: () => { off(); m.setRefusalContextSource(null); } };
  }

  /**
   * What this manager knows about its controller, to explain a refusal of its
   * session in plain words (RwsError.refusal). The operating mode and the
   * controller state are given only while polling keeps them current (quality
   * `live` or `polling`); RMMP only as this manager requested it. Nothing
   * here is read from the controller for the purpose.
   */
  private refusalContextNow(): RefusalContext {
    const s = this._state;
    const current = s.connected && (s.quality === 'live' || s.quality === 'polling');
    const type = s.identity?.type ?? '';
    return {
      opmode: current ? s.opmode : null,
      ctrlstate: current ? s.ctrlstate : null,
      rmmp: this.rmmpGranted ? 'granted' : this.rmmpWait ? 'pending' : null,
      // The /rw/system name first: /ctrl/identity's ctrl-name is the controller
      // property, which a virtual IRC5 reports as the PC's name (RW 6.16.03).
      robot: s.systemInfo?.name || s.identity?.name || null,
      rwVersion: s.systemInfo?.rwVersion || null,
      virtual: /virtual/i.test(type) ? true : /real/i.test(type) ? false : null,
    };
  }

  private unwatchAccess(): void {
    this.accessWatch?.off();
    this.accessWatch = null;
  }

  private onAccessObservation(m: AccessManager, observed: AccessObservation): void {
    const event = { ...observed, at: Date.now() } as AccessEvent;
    if (this.adapter && this.accessIfAny(this.adapter) === m) { this._state.access = m.snapshot(); }
    // Like notify(): outside any operation's turn, so a listener that starts
    // a write queues behind the one in progress instead of running inside it.
    m.detach(() => {
      for (const fn of [...this.accessListeners]) {
        try { fn(event); } catch (e) {
          Logger.warn(`onAccessEvent listener threw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
    this.notify();
  }

  /**
   * A new operating-mode reading (a poll or a subscription event). When it
   * differs from the last one this connection read, the session's access
   * manager checks every hold it counts (see AccessManager.noteModeChange):
   * RobotWare 6/7 mastership is taken as lost, RobotWare 8 write access is
   * checked with one status read. The first reading after a connect is not a
   * change. Values are compared without regard to case.
   */
  private observeOpmode(next: string | null | undefined): void {
    const prev = this._state.opmode;
    if (!prev || !next || prev.toUpperCase() === next.toUpperCase()) { return; }
    const m = this.adapter ? this.accessIfAny(this.adapter) : undefined;
    m?.noteModeChange(prev, next);
  }

  /** `RobotState.access` for the current adapter's session. */
  private accessSnapshot(): AccessState {
    const m = this.adapter ? this.accessIfAny(this.adapter) : undefined;
    return m ? m.snapshot() : { generation: null, locks: [], watchdog: null, rw8: null };
  }

  /**
   * Consumer callbacks must never throw into manager internals: an exception
   * escaping here inside fetchAll would be counted as a poll failure and could
   * cascade to a false stale/auto-disconnect.
   */
  private notify() {
    // A handler that starts a write from here queues behind the write in
    // progress instead of running inside it.
    const run = (): void => {
      for (const h of this.handlers) {
        try { h(); } catch (e) {
          Logger.warn(`onDidChange handler threw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    const access = this.adapter ? this.accessIfAny(this.adapter) : undefined;
    if (access) { access.detach(run); } else { run(); }
  }

  /**
   * Central connection-quality transition point: updates quality + reason and
   * notifies consumers, but only when something actually changed (poll loops
   * hit this every cycle).
   */
  private setQuality(quality: ConnectionQuality, reason: string): void {
    if (this._state.quality === quality && this._state.qualityReason === reason) { return; }
    this._state.quality = quality;
    this._state.qualityReason = reason;
    Logger.trace?.('quality', `${quality}: ${reason}`);
    this.notify();
  }

  /**
   * Install an error listener. Called when the manager auto-disconnects after 3 failed
   * polls. Hosts can route to UI dialogs (vscode.window.showErrorMessage), prompts, or
   * alerting systems. The listener returns the chosen action; only 'Reconnect' is acted
   * on internally - others are passed through for the host to handle.
   */
  onError(fn: ErrorListener) { this.errorListener = fn; }

  /**
   * Declare which controller this manager is for, by its system id (the GUID
   * from `getSystemInfo().sysid`). When the saved port stops answering and the
   * host is scanned for the controller, only a candidate with this id is
   * adopted. Without it the manager uses the id it read on its last successful
   * connection, if any. Pass null to clear.
   */
  setExpectedSystemId(id: string | null | undefined): void {
    this.expectedSystemId = id ? id : null;
  }

  /**
   * Decide which scanned candidate, if any, is the controller whose saved port
   * became unreachable. Never crosses protocol generation. With a known system
   * id, a candidate is adopted only if `identify` returns the same id. Without
   * one, a candidate is adopted only if it is the single one of its generation
   * - with two or more, any choice would be a guess, and a wrong guess connects
   * to a different robot.
   *
   * `expectedAuth` null means the generation is not known (a saved port that
   * serves either scheme, such as 80, saved without its scheme): every
   * candidate is then considered, and the same rules apply.
   */
  static async chooseRecoveryCandidate(
    candidates: ProbeResult[],
    expectedAuth: 'digest' | 'basic' | null,
    expectedSystemId: string | null,
    identify: (c: ProbeResult) => Promise<string | null>,
  ): Promise<{ match: ProbeResult | null; reason: string }> {
    const sameGeneration = expectedAuth === null ? [...candidates] : candidates.filter(c => c.authType === expectedAuth);
    if (sameGeneration.length === 0) {
      return { match: null, reason: `no ${expectedAuth ?? 'RWS'} candidate among ${candidates.length}` };
    }
    if (expectedSystemId) {
      const want = normaliseSystemId(expectedSystemId);
      for (const c of sameGeneration) {
        const got = await identify(c).catch(() => null);
        if (got && normaliseSystemId(got) === want) {
          return { match: c, reason: `system id ${expectedSystemId} confirmed on port ${c.port}` };
        }
      }
      return { match: null, reason: `none of ${sameGeneration.length} candidate(s) has system id ${expectedSystemId}` };
    }
    if (sameGeneration.length === 1) {
      return {
        match: sameGeneration[0],
        reason: expectedAuth === null
          ? 'only candidate; protocol and system id unknown, not verified'
          : 'only candidate of its protocol; system id unknown, not verified',
      };
    }
    return {
      match: null,
      reason: expectedAuth === null
        ? `${sameGeneration.length} candidates and neither the protocol nor a system id to tell them apart`
        : `${sameGeneration.length} candidates of the same protocol and no system id to tell them apart`,
    };
  }

  /**
   * Sign in to a candidate once, read its system id, sign out. The protocol
   * client is built directly with the given credentials (no protocol probe,
   * no default user), and `/logout` is sent whenever the controller handed
   * out a session - also when connecting throws after the login was accepted.
   */
  private async identifyCandidate(host: string, c: ProbeResult, username: string, password: string): Promise<string | null> {
    const read = await loginAndRead({
      host, port: c.port, https: c.useHttps,
      generation: c.authType === 'digest' ? 'rws1' : 'rws2',
      username, password, strictTls: this.strictTls,
    });
    return read.systemId || null;
  }

  /**
   * The protocol a saved port implies when it stops answering: the saved
   * scheme when there is one, else the scheme the port table names for the
   * port ('https' = RWS 2.0 Basic, 'http' = RWS 1.0 Digest), else unknown
   * (null) for a port that serves either scheme (80, or a port outside the
   * table).
   */
  private static expectedAuthFor(port: number, useHttps: boolean | undefined): 'basic' | 'digest' | null {
    if (useHttps !== undefined) { return useHttps ? 'basic' : 'digest'; }
    const scheme = schemeForPort(port);
    return scheme === 'https' ? 'basic' : scheme === 'http' ? 'digest' : null;
  }

  /**
   * How to try a saved port that no scanned candidate replaces: the saved
   * scheme; else the one scheme the port table names; else (a port that
   * serves either scheme) one more probe of both schemes, and only when that
   * finds nothing a logged guess of HTTPS.
   */
  private async savedPortAttempt(host: string, port: number, useHttps: boolean | undefined): Promise<ProbeResult> {
    if (useHttps !== undefined) { return { port, useHttps, authType: useHttps ? 'basic' : 'digest' }; }
    const scheme = schemeForPort(port);
    if (scheme === 'https') { return { port, useHttps: true, authType: 'basic' }; }
    if (scheme === 'http') { return { port, useHttps: false, authType: 'digest' }; }
    const again = await RobotManager.probeSpecificPort(host, port, this.strictTls);
    if (again) { return again; }
    Logger.warn(`port ${port} serves either scheme and did not answer the probe again - guessing HTTPS (RWS 2.0)`);
    return { port, useHttps: true, authType: 'basic' };
  }

  // ─── Auto-detection ─────────────────────────────────────────────────────────

  /**
   * Find ABB RWS controllers from every source the options allow - this PC's
   * listening ports, the service address, hosts and ranges you name, mDNS -
   * and return one merged entry per controller. The same as the standalone
   * `findControllers`; see `FindControllersOptions` for every switch and what
   * each one sends. With no options nothing leaves this PC.
   */
  static findControllers(options?: FindControllersOptions): Promise<FindControllersResult> {
    return runFindControllers(options);
  }

  /**
   * One unauthenticated `GET /rw/system` (the shared discovery probe), mapped
   * to the legacy result: any 401 whose challenge starts with `Digest` or
   * `Basic` is a hit, whatever its realm.
   */
  private static async probePort(
    host: string, port: number, useHttps: boolean, timeoutMs = 3000, strictTls = false
  ): Promise<ProbeResult | null> {
    const outcome = await probeOne(host, port, useHttps, { timeoutMs, strictTls });
    return toLegacyProbeResult(port, useHttps, outcome);
  }

  /**
   * Common ports to check on any host - derived from the single shared
   * `KNOWN_RWS_PORTS` list so the discovery layer and the protocol layer
   * (`detect.probeHost`) can never drift apart. Port 80 is listed twice
   * (HTTPS, then HTTP).
   */
  private static readonly PROBE_PORTS: ReadonlyArray<{ port: number; useHttps: boolean }> =
    KNOWN_RWS_PORTS.map(p => ({ port: p.port, useHttps: p.https }));

  /**
   * `detectAllControllers` with the realm of each answer, so recovery can tell
   * a challenge from an ABB controller ("validusers@robapi.abb") from any other
   * Digest or Basic challenge.
   */
  private static async detectAllDetailed(
    host: string, strictTls = false,
  ): Promise<Array<{ result: ProbeResult; realm?: string }>> {
    const found = await Promise.all(RobotManager.PROBE_PORTS.map(async c => {
      const outcome = await probeOne(host, c.port, c.useHttps, { timeoutMs: 3000, strictTls });
      const result = toLegacyProbeResult(c.port, c.useHttps, outcome);
      if (!result) { return null; }
      const realm = outcome.kind === 'rws' || outcome.kind === 'other-401' ? outcome.realm : undefined;
      return realm !== undefined ? { result, realm } : { result };
    }));
    return found.filter((r): r is { result: ProbeResult; realm?: string } => r !== null);
  }

  /** Returns ALL responding controllers on a single host, on the `KNOWN_RWS_PORTS`. */
  static async detectAllControllers(host: string, strictTls = false): Promise<ProbeResult[]> {
    return (await RobotManager.detectAllDetailed(host, strictTls)).map(d => d.result);
  }

  /**
   * Legacy discovery; prefer `findControllers`, which sends nothing off this
   * PC unless asked, paces probes to other hosts and merges every source.
   *
   * Two paths run at the same time:
   *   - **This PC**: `discoverLocalControllers('127.0.0.1')`, the OS's listening
   *     ports probed on loopback, whatever port a RobotStudio VC took.
   *   - **Other hosts**: the ABB service address 192.168.125.1 - always, which
   *     is why this method sends to the network on every call - plus
   *     `extraHosts`, each probed on every `KNOWN_RWS_PORTS` entry.
   *
   * Each extra host must be an IPv4 address or a host name; anything else
   * (`'10.0.0.5:8080'`, an IPv6 address, a name with spaces) is dropped with a
   * warning, never an error. Results: the local ones by port, then the others
   * by numeric address and port; one per host:port.
   */
  static async discoverControllers(extraHosts: string[] = [], strictTls = false): Promise<DiscoveredController[]> {
    const valid: string[] = [];
    for (const h of Array.isArray(extraHosts) ? extraHosts : []) {
      try {
        valid.push(checkManualHost(h, 'extraHosts'));
      } catch {
        Logger.warn(`discoverControllers: extra host ${JSON.stringify(h)} dropped - not an IPv4 address or a host name (no port, no IPv6)`);
      }
    }
    // 192.168.125.1 is the ABB standard service address for a directly-cabled
    // IRC5 or OmniCore; extra hosts come from the caller (a robot on the LAN).
    const remoteHosts = [...new Set(['192.168.125.1', ...valid])];

    const probeRemote = (host: string): Promise<DiscoveredController[]> =>
      Promise.all(
        RobotManager.PROBE_PORTS.map(c =>
          RobotManager.probePort(host, c.port, c.useHttps, 1500, strictTls)
            .then((r): DiscoveredController | null =>
              r ? { host, port: r.port, useHttps: r.useHttps, authType: r.authType } : null)
        )
      ).then(rs => rs.filter((r): r is DiscoveredController => r !== null));

    const [local, ...remotePer] = await Promise.all([
      RobotManager.discoverLocalControllers('127.0.0.1', strictTls),
      ...remoteHosts.map(probeRemote),
    ]);

    const remote = remotePer.flat()
      .sort((a, b) => compareByAddress({ ...a, key: `${a.host}:${a.port}` }, { ...b, key: `${b.host}:${b.port}` }));
    // One per exact host:port, so a host passed twice never yields a controller twice.
    const seen = new Set<string>();
    return [...local, ...remote].filter(c => {
      const key = `${c.host}:${c.port}`;
      if (seen.has(key)) { return false; }
      seen.add(key);
      return true;
    });
  }

  /**
   * Discover controllers via mDNS/Bonjour - additive alternative to the TCP
   * probing of `discoverControllers` (`findControllers({ mdns: true })` merges
   * both). Real controllers and RobotStudio VCs advertise
   * `RobotWebServices_<systemname>` on `_http._tcp.local`, and RobotWare 7
   * attaches metadata (version, GUID, ports) in TXT records. A VC announces
   * itself only when a Bonjour responder runs on its PC, so an empty answer
   * does not mean no VC runs: the listening-port scan finds those.
   *
   * `probableProtocol` is a heuristic from the advertisement (RW7 attaches
   * TXT metadata, RW6 does not) - confirm with `probeSpecificPort` before
   * connecting. See MdnsDiscovery.ts for the live-verified wire details.
   */
  static async discoverControllersMdns(opts?: { timeoutMs?: number }): Promise<MdnsController[]> {
    return discoverControllersMdns(opts);
  }

  /** Returns only the first responding controller (used internally during connect). */
  static async detectController(host: string, strictTls = false): Promise<ProbeResult | null> {
    const all = await RobotManager.detectAllControllers(host, strictTls);
    return all[0] ?? null;
  }

  /**
   * Probe an exact host:port to discover its auth type and protocol.
   * Tries HTTPS and HTTP at the same time (the shared discovery probe, once per
   * scheme), HTTPS winning a tie. Returns null only if neither answers with a
   * Digest or Basic 401 - protects against guessing wrong (e.g.
   * RobotStudio-assigned port 5466 is HTTPS but doesn't fit any heuristic).
   */
  static async probeSpecificPort(host: string, port: number, strictTls = false, timeoutMs = 2000): Promise<ProbeResult | null> {
    // Probe both schemes CONCURRENTLY and take whichever answers. A port is one
    // or the other, so this changes no result - but it halves the worst case,
    // which matters when probing many listening ports at once: a non-ABB port
    // that stalls the request stalls once, not once per scheme. HTTPS wins ties
    // (OmniCore), matching the old https-first order.
    const [asHttps, asHttp] = await Promise.all([
      RobotManager.probePort(host, port, true,  timeoutMs, strictTls),
      RobotManager.probePort(host, port, false, timeoutMs, strictTls),
    ]);
    return asHttps ?? asHttp;
  }

  /**
   * HTTP-probe a list of ports with BOUNDED concurrency and return the ABB
   * controllers among them. `probeSpecificPort` opens two sockets per port
   * (HTTP + HTTPS in parallel), so a worker pool of `concurrency` keeps at most
   * `concurrency × 2` sockets open at once on a machine with hundreds of
   * listening ports.
   */
  private static async probePortsPooled(
    host: string, ports: number[], strictTls: boolean, timeoutMs: number, concurrency = 100,
  ): Promise<DiscoveredController[]> {
    const found: DiscoveredController[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ports.length) {
        const port = ports[next++];
        const r = await RobotManager.probeSpecificPort(host, port, strictTls, timeoutMs);
        if (r) { found.push({ host, port: r.port, useHttps: r.useHttps, authType: r.authType }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
    return found.sort((a, b) => a.port - b.port);
  }

  /**
   * Pure parser for `netstat`/`ss` output → the set of local listening ports.
   * Split out from the shell-out so its locale-independence (foreign `:0`, never
   * the translated state word) is unit-tested against real English AND German
   * netstat captures, not just asserted. Exported-internal for tests only.
   *
   * `'win32'`: Windows `netstat -ano` (every TCP listener, LAN-only binds
   * included). Elsewhere: Linux `ss -ltn`; when that reading finds nothing,
   * text that reads as `/proc/net/tcp` or macOS `netstat -an` is recognised
   * by its content and parsed as such.
   */
  static parseListeningPorts(output: string, platform: NodeJS.Platform): number[] {
    const ports = new Set<number>();
    const addLocalPort = (localAddr: string): void => {
      const m = localAddr.match(/:(\d{1,5})$/);
      if (!m) { return; }
      const p = Number(m[1]);
      if (p > 0 && p < 65536) { ports.add(p); }
    };
    for (const line of output.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (platform === 'win32') {
        // netstat -ano columns: Proto | Local | Foreign | State | PID.
        // Foreign `:0` = no peer = a listening socket (locale-independent, unlike
        // the State word which is translated on a localized Windows).
        if (cols[0] !== 'TCP' || cols.length < 3 || !cols[2].endsWith(':0')) { continue; }
        addLocalPort(cols[1]);
      } else {
        // `ss -ltn` already lists listeners only; grab the bind address token.
        for (const c of cols) {
          if (/^(?:0\.0\.0\.0|127\.0\.0\.1|\[::1?\]|\*):\d{1,5}$/.test(c)) { addLocalPort(c); }
        }
      }
    }
    if (platform !== 'win32' && ports.size === 0) {
      // Content sniffing only where the ss reading found nothing, so every
      // input that parsed before still gives the same ports.
      if (recogniseProcNetTcp(output)) {
        const v6 = /^\s*\d+:\s+[0-9A-Fa-f]{32}:/m.test(output);
        return [...new Set(parseProcNetTcp(output, v6).map(r => r.port))];
      }
      if (recogniseMacNetstat(output)) {
        return [...new Set(parseMacNetstat(output).map(r => r.port))];
      }
    }
    return [...ports];
  }

  /**
   * Discover every RWS controller listening on this PC. Asks the OS which TCP
   * ports listen (Windows `netstat -ano` by absolute path, Linux
   * `/proc/net/tcp` then `ss`, macOS `netstat` then `lsof`; read-only) and
   * probes `host` on each of them over HTTPS and HTTP at once, so a RobotStudio
   * VC is found wherever its port landed. Left out: ports bound only to `::1`
   * or only to a LAN address of this PC, and ports of industrial protocols
   * (Modbus/TCP, OPC UA, EtherNet/IP, ...) where an unexpected request is not
   * harmless. Results are in port order and carry `host` as given; for
   * `'localhost'` the probes go to 127.0.0.1.
   *
   * Only when the OS cannot be asked at all (every source missing, timed out,
   * failed or not understood) and `host` is this PC's loopback, this falls back
   * to the blind `wideHostScan`. An OS answer with no controller is the
   * answer. Never rejects.
   */
  static async discoverLocalControllers(host = '127.0.0.1', strictTls = false): Promise<DiscoveredController[]> {
    let run: Awaited<ReturnType<typeof runDiscovery>>;
    try {
      run = await runDiscovery({
        local: true,
        identify: 'none',
        filterToVcProcesses: false,
        strictTls: strictTls === true,
        timeoutMs: 1200,
        localProbeHost: host,
        compat: true,
      });
    } catch (err) {
      Logger.warn(`local scan failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const byPort = new Map<number, { https?: ProbeResult; http?: ProbeResult }>();
    const probedPorts = new Set<number>();
    for (const h of run.hits) {
      probedPorts.add(h.unit.port);
      const r = toLegacyProbeResult(h.unit.port, h.unit.https, h.outcome);
      if (!r) { continue; }
      const slot = byPort.get(r.port) ?? {};
      slot[r.useHttps ? 'https' : 'http'] = r;
      byPort.set(r.port, slot);
    }
    const found: DiscoveredController[] = [...byPort.keys()].sort((a, b) => a - b).map(port => {
      const slot = byPort.get(port) ?? {};
      const r = (slot.https ?? slot.http) as ProbeResult;   // HTTPS wins a tie, as probeSpecificPort
      return { host, port: r.port, useHttps: r.useHttps, authType: r.authType };
    });
    const status: LocalScanStatus = run.localScan.status;
    if (status === 'ok' || status === 'skipped') {
      Logger.info(`local scan: ${probedPorts.size} listening port(s) probed, ${found.length} ABB controller(s) on ${host}`);
      return found;
    }
    if (!isLoopbackHost(host)) {
      Logger.info(`local scan: OS listening-port query unavailable (${status}); no blind scan of ${host}, which is not this PC's loopback`);
      return found;
    }
    // OS query unavailable (stripped-down env) - last-resort bounded blind scan.
    Logger.info(`OS listening-port query unavailable (${status}) - falling back to a blind port scan of ${host}…`);
    return RobotManager.wideHostScan(host, strictTls);
  }

  /**
   * Bounded blind TCP port scan of this PC's loopback - the LAST-RESORT
   * fallback for local VC discovery when `discoverLocalControllers`' OS query
   * is unavailable. Two-phase: TCP-connect ports 80, 443 and 1024-65535 fast
   * (400 at a time, 250 ms each, at most 120 s), then HTTP-probe only ports
   * that accepted. Ports of industrial protocols (Modbus/TCP, OPC UA,
   * EtherNet/IP, ...) are skipped. Prefer `discoverLocalControllers`, which
   * is faster and has no range cap.
   *
   * @throws RwsError `INVALID_ARGUMENT` when `host` is not this PC's loopback
   *   (127.0.0.0/8, `::1` or `'localhost'`): another machine is never swept.
   */
  static async wideHostScan(host: string, strictTls = false): Promise<DiscoveredController[]> {
    if (!isLoopbackHost(host)) {
      throw new RwsError(
        `wideHostScan sweeps this PC's loopback address only (127.0.0.0/8, ::1 or 'localhost'), not ${JSON.stringify(host)}; `
          + 'use findControllers with manual hosts or ranges for another machine',
        'INVALID_ARGUMENT');
    }
    const { open, complete } = await sweepOpenPorts(host);
    Logger.info(`wide scan: ${open.length} open TCP port(s) on ${host}${complete ? '' : ' (stopped at the time limit)'}, HTTP-probing each…`);
    // HTTP-probe the TCP-open ports (bounded concurrency) - filter to controllers.
    return RobotManager.probePortsPooled(host, open, strictTls, 2000);
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Connect to a controller.
   * @param port     If provided, skip auto-detection and use this port directly.
   *                 Required when two controllers share the same host IP.
   * @param useHttps If provided alongside port, sets the protocol explicitly.
   *
   * Rapid duplicate calls with the SAME target are coalesced - concurrent
   * callers receive the same in-flight promise. Without this, fast double-clicks
   * would spawn parallel adapters/timers and overwhelm the controller's session
   * pool. A call with a DIFFERENT target instead cancels the in-flight attempt
   * and connects fresh - otherwise the caller ends up connected, but not to
   * what it asked for. Same for a SAME-target call after a disconnect() has
   * cancelled the in-flight attempt: coalescing onto it would hand the caller
   * a promise that resolves with the manager still disconnected.
   */
  connect(host: string, username: string, password: string, port?: number, useHttps?: boolean): Promise<void> {
    if (this.connectingPromise) {
      const pending = this.connectingArgs;
      const sameArgs = !!pending
        && pending.host === host && pending.username === username
        && pending.password === password && pending.port === port
        && pending.useHttps === useHttps;
      const stillCurrent = !!pending && pending.epoch === this.connectEpoch && !pending.cancelled;
      if (sameArgs && stillCurrent) {
        Logger.info(`connect → ${host}${port !== undefined ? ':' + port : ''} ignored (same connect already in flight)`);
        return this.connectingPromise;
      }
      Logger.info(`connect → ${host}${port !== undefined ? ':' + port : ''} supersedes ${sameArgs ? 'cancelled' : 'in-flight'} connect to ${pending?.host ?? '?'}`);
      return this.startConnect(host, username, password, port, useHttps, this.connectingPromise);
    }
    return this.startConnect(host, username, password, port, useHttps);
  }

  private startConnect(host: string, username: string, password: string, port?: number, useHttps?: boolean, supersedes?: Promise<void>): Promise<void> {
    const attempt: ConnectAttempt = { host, username, password, port, useHttps, epoch: this.connectEpoch };
    this.connectingArgs = attempt;
    const p = (async () => {
      if (supersedes) {
        await this.disconnectInternal();   // bumps connectEpoch → the in-flight doConnect unwinds
        attempt.epoch = this.connectEpoch; // our own cancel of the old attempt doesn't invalidate this one
        await supersedes.catch(() => {});  // let it finish unwinding before we start fresh
      }
      this.setQuality('reconnecting', `connecting to ${host}${port !== undefined ? ':' + port : ''}`);
      try {
        await this.doConnect(host, username, password, port, useHttps, attempt);
      } catch (e) {
        this.setQuality('disconnected', `connect failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      // Superseded/cancelled attempts leave quality to their successor
      if (this._state.connected) {
        this.setQuality(
          this.subscriptionActive ? this.streamQuality() : 'polling',
          this.subscriptionActive
            ? this.liveQualityReason('WebSocket events streaming')
            : 'WebSocket unavailable - fast polling',
        );
      }
    })().finally(() => {
      // Only clear if we're still the current attempt - a superseding connect
      // may have replaced these fields while we were settling.
      if (this.connectingPromise === p) {
        this.connectingPromise = null;
        this.connectingArgs = null;
      }
    });
    this.connectingPromise = p;
    return p;
  }

  private async doConnect(host: string, username: string, password: string, port?: number, useHttps?: boolean, attempt?: ConnectAttempt): Promise<void> {
    // If we're already connected to the same controller, this is a no-op.
    // Without this, every accidental click of the Connect button burns a session
    // through the disconnect → /logout → /rw/system reconnect cycle.
    const cfg = this.adapterConfig;
    if (this._state.connected && cfg
        && cfg.host === host
        && (port === undefined || cfg.port === port)
        && cfg.username === username
        && cfg.password === password) {
      Logger.info(`connect → ${host}${port !== undefined ? ':' + port : ''} skipped (already connected)`);
      return;
    }

    if (this._state.connected) { await this.disconnectInternal(); }

    // Any disconnect() after this point (user click, removeRobot) bumps the
    // epoch; we re-check after every await so an aborted connect can't
    // resurrect timers or subscriptions. The attempt record mirrors the value
    // so connect() knows whether coalescing onto this attempt is still valid.
    // User cancellations additionally set attempt.cancelled, which survives
    // this re-read - otherwise a disconnect() racing our own teardown above
    // would be erased here and the connection resurrected.
    const epoch = this.connectEpoch;
    if (attempt) { attempt.epoch = epoch; }
    const aborted = (): boolean => attempt?.cancelled === true || epoch !== this.connectEpoch;
    if (attempt?.cancelled) {
      Logger.info(`connect → ${host} aborted (disconnected before probing)`);
      return;
    }

    Logger.info(`connect → ${host}${port !== undefined ? ':' + port : ' (auto-detect)'} as "${username}"`);

    let probe: ProbeResult;
    if (port !== undefined) {
      // Port is pinned in config - verify it's actually reachable with the right protocol.
      let verified = await RobotManager.probeSpecificPort(host, port, this.strictTls);
      // Reachable is not enough: VCs restarting together can swap ports, so the
      // saved port may now answer as a DIFFERENT controller. Live 2026-09-23: an
      // RW7 entry's saved 9403 was taken by another RW8 VC and the manager
      // connected to it. When the expected identity is known, check it, and treat
      // a stranger on the saved port exactly like a dead port - recover.
      const expectedHere = this.expectedSystemId ?? this.knownSystemId;
      let savedPortIsStranger = false;
      if (verified && expectedHere) {
        const got = await this.identifyCandidate(host, verified, username, password).catch(() => null);
        if (got && normaliseSystemId(got) !== normaliseSystemId(expectedHere)) {
          Logger.warn(`saved port ${port} now answers as a different controller (system id ${got}, expected ${expectedHere}) - recovering`);
          verified = null;
          savedPortIsStranger = true;
        }
      }
      if (verified) {
        probe = verified;
        Logger.info(`port ${port} verified: ${verified.useHttps ? 'HTTPS' : 'HTTP'}/${verified.authType}`);
      } else {
        // Saved port didn't respond - RobotStudio reassigns VC ports each restart.
        Logger.warn(`saved port ${port} not responding - scanning ${host} for an active controller…`);
        // The saved scheme, else the scheme the port table names; null for a
        // port that serves either (80, or one outside the table).
        const expectedAuth = RobotManager.expectedAuthFor(port, useHttps);
        const onThisPc = isLocalAddress(host);

        // Phase 1: quick scan of the standard ports
        let candidates: ProbeResult[];
        if (onThisPc) {
          candidates = await RobotManager.detectAllControllers(host, this.strictTls);
        } else {
          // Another machine: the user's credentials go only to a candidate that
          // identified as an ABB controller (401 realm "validusers@robapi.abb"),
          // and never as Basic over plain HTTP, where they would cross the
          // network readable. A candidate that fails either rule is neither
          // logged in to nor adopted.
          const detailed = await RobotManager.detectAllDetailed(host, this.strictTls);
          candidates = [];
          for (const d of detailed) {
            const c = d.result;
            if (d.realm !== RWS_REALM) {
              Logger.warn(`recovery: ${host}:${c.port} is not considered - its challenge did not identify an ABB controller${d.realm !== undefined ? ` (realm "${d.realm}")` : ''}`);
            } else if (!c.useHttps && c.authType === 'basic') {
              Logger.warn(`recovery: ${host}:${c.port} is not considered - it would take Basic credentials over plain HTTP`);
            } else {
              candidates.push(c);
            }
          }
        }

        // Phase 2: on localhost, ALWAYS add the OS's listening ports (fast, no
        // range cap - finds a VC on any reassigned port). This used to run only
        // when phase 1 found nothing at all, so one VC on a standard port hid
        // every other VC: live 2026-09-23, an RW6 VC moved 33806 -> 50959 while
        // an RW8 VC sat on 5466, phase 1 returned only the RW8, and the RW6 was
        // never considered. Recovery only runs when the saved port is dead, so
        // the extra scan is cheap.
        if (host === '127.0.0.1' || host === 'localhost') {
          Logger.info(`scanning ${host} listening ports for the reassigned VC…`);
          const local = await RobotManager.discoverLocalControllers(host, this.strictTls);
          const seen = new Set(candidates.map(c => c.port));
          for (const c of local) {
            if (!seen.has(c.port)) { candidates.push({ port: c.port, useHttps: c.useHttps, authType: c.authType }); }
          }
          Logger.info(`${candidates.length} ABB controller(s) on ${host} after the local scan`);
        }

        // Several controllers on one host is the normal RobotStudio setup, and the
        // only one where ports move. "First controller of the same protocol" is
        // then just whichever answered first - a DIFFERENT robot. Adopt a
        // candidate only when it is provably the same controller.
        const expectedId = this.expectedSystemId ?? this.knownSystemId;
        const { match, reason } = await RobotManager.chooseRecoveryCandidate(
          candidates, expectedAuth, expectedId,
          c => this.identifyCandidate(host, c, username, password),
        );
        if (match) {
          probe = match;
          Logger.info(`recovered: ${match.useHttps ? 'HTTPS' : 'HTTP'}/${match.authType} on port ${match.port} (saved was ${port}; ${reason})`);
        } else if (savedPortIsStranger) {
          // Falling back to the saved port would connect to the stranger on it.
          throw new RwsError(
            `controller ${expectedHere} not found on ${host}: port ${port} now belongs to a different controller (${reason})`,
            'PROTOCOL_DETECT_FAILED');
        } else if (candidates.length > 0 && expectedId) {
          // The saved port already failed the probe; retrying it would only
          // replace this conclusion with its network error. Live 2026-09-24: the
          // RW6 entry's VC was off while another RW6 system ran on 17186 - the
          // caller saw "fetch failed" and not why nothing was adopted.
          throw new RwsError(
            `controller ${expectedId} not found on ${host}: saved port ${port} is not responding and ${reason}`,
            'PROTOCOL_DETECT_FAILED');
        } else if (candidates.length > 0) {
          probe = await this.savedPortAttempt(host, port, useHttps);
          Logger.warn(`saved port ${port} not responding and no candidate on ${host} is provably this controller (${reason}) - keeping the saved port`);
        } else {
          // Last resort: try the saved port anyway - maybe a firewall blocks the probe but lets through auth
          probe = await this.savedPortAttempt(host, port, useHttps);
          Logger.warn(`no controller found anywhere on ${host} - falling back to saved port ${port}`);
        }
      }
    } else {
      // Auto-detect: probe all common ports
      const ports = describeRwsPorts();
      Logger.info(`auto-detecting controller at ${host} (ports ${ports})`);
      const found = await RobotManager.detectController(host, this.strictTls);
      if (!found) {
        const err = `No ABB RWS controller found at ${host}.\nChecked ports: ${ports}.\nEnsure the controller is reachable and RWS is enabled.`;
        Logger.error(`auto-detect failed for ${host}`);
        throw new RwsError(err, 'PROTOCOL_DETECT_FAILED');
      }
      probe = found;
      Logger.info(`auto-detected: port ${probe.port} ${probe.useHttps ? 'HTTPS' : 'HTTP'}/${probe.authType}`);
    }

    if (aborted()) {
      Logger.info(`connect → ${host} aborted (disconnected while probing)`);
      return;
    }

    // This connection's entry in the shared session file, computed once and
    // only when a cookie is loaded or saved (see sessionFileKey).
    let cookieKey: string | null = null;
    const sessionKey = (): string => (cookieKey ??= RobotManager.sessionFileKey(host, probe.port, username, password));
    const prevCfg = this.adapterConfig;
    const sameConfig = prevCfg
      && prevCfg.host === host && prevCfg.username === username
      && prevCfg.password === password && prevCfg.port === probe.port
      && this.adapterControlStation === this.controlStation;

    if (!this.adapter || !sameConfig) {
      // A new client is another control station (another port, credentials
      // or identity). An allowance the old one may have left stays with the
      // old station: this client cannot withdraw it.
      if (this.adapter && motionControlOf(this.adapter)?.maybeDeclared()) {
        Logger.warn('RobotWare 8: the previous connection may have left motion control allowed for its control station (its withdrawal did not go through); '
          + 'this connection is another station and cannot withdraw it. Withdraw it at the FlexPendant, or reconnect with the previous settings.');
      }
      if (probe.authType === 'basic') {
        const scheme = probe.useHttps ? 'https' : 'http';
        // Every adapter gets the configured station identity, so a new adapter
        // (another port, new credentials) registers as the same station.
        const station = this.controlStation;
        this.adapter = new RWS2Adapter(`${scheme}://${host}:${probe.port}`, username, password, {
          rejectUnauthorized: this.strictTls,
          ...(station ? { controlStation: { ...station } } : {}),
        });
      } else {
        // Session cookie keyed by host:port so two controllers on same IP don't
        // clobber each other, and by the credentials: a cookie is reused only
        // by a connect with the credentials that created it (sessionFileKey).
        const cookie = this.loadSessionCookie(sessionKey()) ?? undefined;
        const rwsClient = new RwsClient({ host, port: probe.port, username, password, sessionCookie: cookie });
        this.adapter = new RWS1Adapter(rwsClient, { host, port: probe.port, username, password });
      }
      this.adapterConfig = { host, username, password, port: probe.port };
      this.adapterControlStation = this.controlStation;
    }
    // From here on, what this session holds is reported (RobotState.access,
    // onAccessEvent), including the holds the adapter's own writes take.
    this.watchAccess(this.accessIfAny(this.adapter));

    try {
      await this.adapter.connect();
    } catch (e) {
      Logger.error(`adapter.connect() failed for ${host}:${probe.port}`, e);
      throw e;
    }
    if (aborted()) {
      Logger.info(`connect → ${host} aborted (disconnected mid-connect) - closing session`);
      await this.adapter.disconnect().catch(() => {});
      return;
    }
    // Only RWS 1.0 reuses a saved cookie (above). An RWS 2.0 cookie on disk
    // after a crash would name a session that may hold a RobotWare 8
    // motion-control allowance, so it is not written.
    const cookie = this.adapter instanceof RWS2Adapter ? null : this.adapter.getSessionCookie();
    if (cookie) {
      const key = sessionKey();
      this.saveSessionCookie(key, cookie);
      this.savedSessionCookie = { key, cookie };
    }

    this._state.connected = true;
    this._state.host = host;
    this._state.access = this.accessSnapshot();
    this.sessionEpoch = epoch;
    Logger.info(`connected to ${host}:${probe.port}`);
    this.notify();

    // Start WebSocket subscriptions for instant state-change events.
    // If subscriptions succeed, polling runs at 5× refreshIntervalMs (positions only).
    // If they fail, polling runs at refreshIntervalMs (full state coverage as before)
    // and the subscribe is tried again on a backoff (startSubscriptions).
    await this.startSubscriptions();
    if (aborted()) {
      Logger.info(`connect → ${host} aborted (disconnected during subscription setup)`);
      if (this.unsubscribeFn) { await this.unsubscribeFn().catch(() => {}); this.unsubscribeFn = null; }
      this.subscriptionActive = false;
      this.unboundResources = new Set();
      await this.adapter.disconnect().catch(() => {});
      return;
    }

    // Every connect() invalidates older polling cycles so any timer that
    // wasn't cleared (race between disconnect/reconnect) self-cancels.
    const myGeneration = ++this.pollGeneration;
    this.consecutiveFails = 0;
    // The first poll walks the whole signal table (see signalTableDue).
    this.resetSignalTableSchedule();

    await this.fetchAll(myGeneration);
    if (aborted()) { return; }
    this.installPollTimer(myGeneration);
  }

  /**
   * (Re)install the poll timer for `generation` at the interval the
   * subscription allows now (pollIntervalMs).
   *
   * Single-flight guard: if a fetchAll is still running when the timer
   * fires, skip this tick. Prevents the request pile-up that caused
   * 10-second timeouts on /cartesian and /tasks during heavy motion
   * (controller's RWS layer queues behind the motion planner - responses
   * can take >1s when joints are moving fast). Without this, a slow poll
   * would stack against the next-second poll, causing both to timeout.
   */
  private installPollTimer(generation: number): void {
    if (this.timer) { clearInterval(this.timer); }
    const pollMs = this.pollIntervalMs();
    this.pollEveryMs = pollMs;
    this.timer = setInterval(() => {
      if (this.fetchInFlight) { return; }
      this.fetchAll(generation);
    }, pollMs);
  }

  /**
   * The poll interval: 5 × refreshIntervalMs while the event stream brings
   * every state field the poll reads, refreshIntervalMs otherwise - without
   * a stream, and while the controller left one of those status resources
   * out of the group (an unbound event log alone keeps the slow rate; the
   * poll reads it, see fetchAll).
   */
  private pollIntervalMs(): number {
    return this.streamBringsStatus() ? 5 * this.refreshIntervalMs : this.refreshIntervalMs;
  }

  /** Whether the event stream brings every status field the poll reads (the slow rate; see pollIntervalMs). */
  private streamBringsStatus(): boolean {
    return this.subscriptionActive && !this.unboundNames().some(isPolledStatus);
  }

  /**
   * The quality while the event stream is up: `live` only while the poll
   * runs at the slow rate, as `live` is documented (ConnectionQuality), and
   * `polling` while the controller left a status resource the poll reads out
   * of the group, so the poll runs at the fast rate. A consumer that budgets
   * its own requests on the quality (the daemon reserves about 2 req/s for
   * the manager on `live`, the fast rate's 12 on `polling`) then counts
   * what is sent. An unbound event log alone keeps `live`: the rate stays
   * slow. The reason (liveQualityReason) says what is polled either way.
   */
  private streamQuality(): 'live' | 'polling' {
    return this.streamBringsStatus() ? 'live' : 'polling';
  }

  /**
   * Every how many polls an unbound event log is read: each poll at the slow
   * rate, every fifth at the fast rate (an unbound status resource), so the
   * log is read about once per 5 × refreshIntervalMs either way: on RWS 1.0
   * each read is a whole page of 50 messages with their texts.
   */
  private unboundElogEvery(): number {
    if (this.pollEveryMs <= 0) { return 1; }
    return Math.max(1, Math.round((5 * this.refreshIntervalMs) / this.pollEveryMs));
  }

  /** The unbound resources by the names the event handler uses (`elog`, `execution`, ...). */
  private unboundNames(): string[] {
    return [...this.unboundResources].map(u => Rws2Core.resourcePathToName(u));
  }

  /**
   * `base` for a 'live' quality, and, while the controller left resources out
   * of the group, what this manager polls instead, in plain words: "...,
   * but the controller did not bind /rw/elog/0, so the event log is polled".
   */
  private liveQualityReason(base: string): string {
    if (this.unboundResources.size === 0) { return base; }
    return `${base}, but the controller did not bind ${[...this.unboundResources].join(', ')}, so ${this.unboundConsequence()}`;
  }

  /**
   * What the unbound resources mean for this manager's state, in plain
   * words: "the event log is polled", "the execution state and the event log
   * are polled (fast polling)", or "no events come for <uri>" for a resource
   * the poll does not read.
   */
  private unboundConsequence(): string {
    const uris = [...this.unboundResources];
    const labels = [...new Set(uris.map(unboundLabel).filter((l): l is string => l !== undefined))];
    const unread = uris.filter(u => unboundLabel(u) === undefined);
    const parts: string[] = [];
    if (labels.length > 0) {
      const fast = this.unboundNames().some(isPolledStatus) ? ' (fast polling)' : '';
      parts.push(`${joinAnd(labels)} ${labels.length === 1 ? 'is' : 'are'} polled${fast}`);
    }
    if (unread.length > 0) { parts.push(`no events come for ${unread.join(', ')}`); }
    return parts.join(' and ');
  }

  /**
   * Take the unbound resources of the subscription handle now held into
   * `unboundResources` (empty for a handle without `unbound`, an adapter of
   * another make, and without an active subscription). Logs a change.
   */
  private noteUnboundResources(): void {
    const handle = this.unsubscribeFn as ((() => Promise<void>) & { unbound?: unknown }) | null;
    const read: unknown[] = this.subscriptionActive && Array.isArray(handle?.unbound) ? handle.unbound : [];
    const next = new Set(read.filter((u): u is string => typeof u === 'string' && u !== ''));
    const same = next.size === this.unboundResources.size && [...next].every(u => this.unboundResources.has(u));
    if (same) { return; }
    this.unboundResources = next;
    if (next.size > 0) {
      Logger.warn(`subscription: the controller did not bind ${[...next].join(', ')}, so ${this.unboundConsequence()}`);
    } else if (this.subscriptionActive) {
      Logger.info('subscription: the controller now binds every resource of the group');
    }
  }

  async disconnect(): Promise<void> {
    // A user disconnect permanently cancels any in-flight connect attempt.
    // The flag (not just the epoch) is what makes it stick: doConnect re-reads
    // the epoch after its own internal teardowns, which would otherwise erase
    // this cancellation and resurrect the connection.
    if (this.connectingArgs) { this.connectingArgs.cancelled = true; }
    return this.disconnectInternal();
  }

  /**
   * Teardown used by doConnect/startConnect for their own reconnect cycles -
   * must not cancel the attempt that invoked it. After the synchronous steps
   * (the epochs, the poll timer), the first request is RobotWare 8's
   * motion-control withdrawal, when this manager's client may have an
   * allowance standing; then the jog's hold, RMMP, the subscription and the
   * client's own teardown.
   */
  private async disconnectInternal(): Promise<void> {
    this.teardownsRunning++;
    try {
      await this.teardown();
    } finally {
      this.teardownsRunning--;
    }
  }

  private async teardown(): Promise<void> {
    // Bump generation FIRST so any in-flight fetchAll calls bail before they
    // can trigger another disconnect cascade. The epoch likewise cancels any
    // in-flight doConnect() so it can't re-install timers/subscriptions.
    this.connectEpoch++;
    this.sessionEpoch = null; // sampler reads refuse from here on (sessionAdapter)
    this.pollGeneration++;
    // Clear the event-driven elog read's flags in the same synchronous step
    // as the generation bump. An event-driven read still pending belongs to
    // the old generation: its result is dropped by the generation pin, and it
    // must neither park the next connection's event-driven reads behind
    // itself nor carry a queued follow-up over to them
    // (refreshEventLogOnEvent). Clearing them after the awaits below left a
    // window in which a read settling mid-teardown, with a follow-up queued,
    // still saw its own generation recorded and sent one more GET to the
    // adapter being torn down.
    this.elogRefreshInFlight = null;
    this.elogRefreshQueued = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.pollEveryMs = 0;
    // The safety step first: withdraw a motion-control allowance this client
    // may have made (RobotWare 8; nothing is sent otherwise). A closing window
    // gives little time, and a start in flight that races it is refused,
    // which is right at a disconnect. A refusal is logged and the teardown goes on.
    const motionControl = this.adapter ? motionControlOf(this.adapter) : undefined;
    if (motionControl) { await motionControl.withdraw('disconnect'); }
    // Release any held motion mastership BEFORE closing the adapter
    await this.releaseJogMastership();
    // Give back RMMP this manager asked for, on the session that holds it.
    await this.endRmmp();
    // Unsubscribe WebSocket before closing adapter so DELETE /subscription fires correctly
    if (this.unsubscribeFn) {
      await this.unsubscribeFn().catch(() => {});
      this.unsubscribeFn = null;
    }
    this.subscriptionActive = false;
    this.unboundResources = new Set();
    if (this.adapter) {
      await this.adapter.disconnect().catch(() => {});
      // The adapter logged its session out, so the cookie saved for it at
      // connect is dead (live-verified 2026-09-30 on RW 6.16.03: a logged-out
      // session's cookie answers 401). Drop the entry, so a later connect by
      // another manager or process signs in instead of first sending it.
      const saved = this.savedSessionCookie;
      this.savedSessionCookie = null;
      if (saved) { this.forgetSessionCookie(saved.key, saved.cookie); }
      // Caller-held mastership is session-scoped - it dies with the session.
      // An adapter from this package ends its own manager's holds on
      // disconnect; one without a manager is ended here.
      if (!accessOf(this.adapter)) { this.fallbackAccess.get(this.adapter)?.sessionEnded('disconnect'); }
    }
    // Reset the auto-disconnect failure counter. It is otherwise only cleared on
    // a successful doConnect, so after an *auto*-disconnect (which happens at
    // consecutiveFails>=3) a single later failing poll would immediately re-cross
    // the threshold and re-pop the "Reconnect" dialog the user just dismissed.
    this.consecutiveFails = 0;
    // The next connection's first poll must load the slow reads again, which
    // key on fetchCount === 1, and the signal table, which is due at once
    // again. A count carried over from the previous connection pushed the
    // reloads out, and the table read empty until then.
    this.fetchCount = 0;
    this.resetSignalTableSchedule();
    // No subscribe retry for a connection that is gone; the next one starts
    // its backoff from the first step. A retry still in flight settles on its
    // own and unsubscribes what it got (retrySubscriptions).
    this.resetSubscribeRetry();
    this._state = {
      connected: false, quality: 'disconnected', qualityReason: 'disconnected',
      host: '', ctrlstate: null, opmode: null,
      execstate: null, execCycle: null, speedRatio: null, coldetstate: null,
      tasks: [], modules: [], modulesByTask: {}, mechunits: [], joints: null,
      cartesian: null, cartesianFull: null, identity: null, systemInfo: null,
      eventLog: [], ioSignals: [], ioSignalsLoaded: false,
      access: { generation: null, locks: [], watchdog: null, rw8: null },
    };
    // The session's holds ended with it (reported above, as the adapter
    // disconnected); the next connect follows its manager again.
    this.unwatchAccess();
    this.notify();
  }

  /**
   * Pinned to the current poll generation: an unpinned fetch would bypass the
   * staleness guard and could resurrect state (and quality) after a
   * disconnect/reconnect that raced it.
   */
  async refresh(): Promise<void> {
    // A refresh after an intentional disconnect must be a no-op: the adapter is
    // torn down, and fetchAll's generation guard passes (this.pollGeneration is
    // read live, so it equals itself) so nothing would otherwise stop it from
    // repopulating a "disconnected" _state - or, on the dead session, climbing
    // consecutiveFails and re-firing the auto-disconnect dialog.
    if (!this._state.connected) { return; }
    await this.fetchAll(this.pollGeneration);
  }

  // ─── Panel control ──────────────────────────────────────────────────────────

  /**
   * Switch the motors on, holding mastership (RobotWare 6/7) or control-station
   * write access (RobotWare 8) around the request. ABB documents remote
   * motors-on for Auto; in manual mode a person holds the enabling device.
   *
   * RobotWare 8: motors come on with the Reset at the controller (the
   * FlexPendant thumb button in Auto, or a configured safe input) after a
   * safety stop, a mode change or a restart. A virtual controller in guard
   * stop refused this request with 403 -1073445806 ("not allowed in current
   * controller state") even under write access; the error's refusal says so
   * (`safety-state`, grantor `cell-safety`) instead of pointing at a grant.
   *
   * @throws {RwsError} NOT_CONNECTED before connect(); otherwise the
   *   controller's refusal, explained in `refusal`.
   */
  async setMotorsOn(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    await this.access(adapter).withAccess(['rapid'], () => adapter.setControllerState('motoron'));
  }

  /**
   * Switch the motors off. The request is sent first and never
   * waits for mastership or write access. Only when the controller refuses it
   * because this session holds no access does the manager request access,
   * send once more and release right after; any other refusal is passed on
   * unretried, naming the holder when the controller says who.
   *
   * Motors off over RWS is not a safety function; use the emergency stop for safety.
   *
   * @throws {RwsError} NOT_CONNECTED before connect(); otherwise the controller's
   *   refusal with its own code, the holder named when the controller says who.
   */
  async setMotorsOff(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    await this.sendFirst('motors-off', adapter, () => adapter.setControllerState('motoroff'));
  }

  async setSpeedRatio(ratio: number): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.setSpeedRatio(ratio);
    this._state.speedRatio = ratio;
    // A write we just made is newer than any poll already in flight.
    this.fieldEventSeq.set('speedRatio', ++this.eventSeq);
    this.notify();
  }

  async lockOperationMode(pin: string, permanent?: boolean): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.lockOperationMode(pin, permanent);
  }

  /** Unlock the operation-mode selector with the PIN the lock set (required
   *  by the controller form on both generations). */
  async unlockOperationMode(pin?: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.unlockOperationMode(pin);
  }

  /**
   * Switch operation mode (AUTO/MANR/MANF). VC-only - real hardware respects
   * the FlexPendant key switch.
   *
   * State-machine constraints (ABB safety design):
   *   AUTO ↔ MANR: direct transition allowed.
   *   MANR ↔ MANF: direct transition allowed.
   *   AUTO ↔ MANF: NOT allowed direct - must go through MANR.
   *     Controller rejects with HTTP 500 "Operation failed" on the direct call.
   *     We auto-handle this by routing through MANR (two POSTs).
   *
   * Privilege:
   *   RobotWare 6 (RWS 1.0): no operating-mode change exists; refused with
   *     UNSUPPORTED_OPERATION before any request, mastership included.
   *   RobotWare 7, going TO MANR/MANF: sent without mastership (the safer
   *     direction; accepted that way on RW 7.21.4, live 2026-09-30). In
   *     manual mode mastership needs RMMP first, and a change from Auto to
   *     manual ends mastership, so none is taken.
   *   RobotWare 7, going TO AUTO: `edit` mastership is held around the
   *     request; a refused mastership request still lets the switch be tried.
   *   RobotWare 8: control-station write access is held around EVERY switch
   *     (ABB: a remote control station needs write access to set operating
   *     modes). Without it RW 8.2.1 refused a switch from Auto to MANR with
   *     403 -1073435873 (live 2026-09-30). A refused write-access request
   *     fails the switch, which is then not sent, and the refusal says why:
   *     while a switch to Auto waits in AUTO_CH, RW 8.2.1 refuses every
   *     write-access request (403 -1073414145, live 2026-09-30).
   *   Local Client: ABB's RWS 2.0 pages for this operation say "Client should
   *     have Local Client privileges". It worked from this remote client on
   *     station virtual controllers (RW 7.21.4 and 8.2.1), which do not enforce
   *     that; a real controller may refuse it, and a refusal says so. Verified
   *     on virtual controllers only.
   *   Going TO AUTO waits for a confirmation at the FlexPendant: the mode
   *     reads AUTO_CH until someone confirms it there (RW 7.21.4 and 8.2.1,
   *     live 2026-09-30). The confirmation is the person's at the
   *     FlexPendant; this method does not send it, and a switch sent again
   *     does not confirm it.
   *   Controller state: none is read before a switch; the controller
   *     decides. RW 8.2.1 (virtual controller) in guard stop accepted the
   *     switch both ways, AUTO to MANR and MANR to AUTO (2026-10-18).
   * @throws {RwsError} UNSUPPORTED_OPERATION on RobotWare 6 (RWS 1.0), before any
   *   request is sent.
   */
  async setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    if (!this.adapter.setOperationMode) { throw new RwsError('setOperationMode not exposed by this adapter', 'UNSUPPORTED_OPERATION'); }
    // RobotWare 6 (RWS 1.0) has no operating-mode change: the adapter refuses
    // before sending, so no MANR transit and no mastership are taken for it.
    if (this.access(this.adapter).generation() === 'rw6') { return this.adapter.setOperationMode(mode); }

    // Detect "must transit through MANR" pairs (AUTO ↔ MANF) and route via MANR.
    const current = this._state.opmode;
    const needsTransit =
      (current === 'AUTO' && mode === 'MANF') ||
      (current === 'MANF' && mode === 'AUTO');
    if (needsTransit) {
      Logger.info(`opmode: routing ${current} → MANR → ${mode} (direct transition not allowed)`);
      await this.setOpmodeOnce('MANR');
      // Brief pause so the controller settles the safety-chain state before the
      // second hop - direct back-to-back POSTs sometimes get the second one
      // rejected as "operation in progress."
      await new Promise(r => setTimeout(r, 600));
      await this.setOpmodeOnce(mode);
      return;
    }
    await this.setOpmodeOnce(mode);
  }

  /**
   * A switch the controller refused, with ABB's rule added: the RWS 2.0 pages
   * for setting the operating mode say "Client should have Local Client
   * privileges" (RWS 2.0 site, Panel service, RobotWare 7 and 8). The switch
   * worked from this remote client on station virtual controllers (RW 7.21.4,
   * 8.2.1), which do not enforce that; a real controller may refuse it. Only a
   * refusal that came from the controller (it carries a controller code) gets
   * the note.
   */
  private static withOpmodeLocalClientNote(e: unknown): unknown {
    if (!(e instanceof RwsError) || e.controllerCode === undefined) { return e; }
    const note = "ABB lists Local Client privileges for changing the operating mode over RWS; it worked from a remote session on virtual "
      + 'controllers only, and a real controller may refuse it. The key switch or mode selector at the controller always can.';
    const refusal = e.refusal ? { ...e.refusal, sentence: `${e.refusal.sentence} ${note}` } : undefined;
    return new RwsError(`${e.message} ${note}`, e.code, e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg, refusal, e.responseBody);
  }

  /** Single hop. Used internally + as the building block for multi-hop transitions. */
  private async setOpmodeOnce(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void> {
    const adapter = this.adapter!;
    const access = this.access(adapter);
    // RobotWare 8: write access around every switch (see setOperationMode).
    const rw8 = access.generation() === 'rw8';
    if (mode !== 'AUTO' && !rw8) {
      try { await adapter.setOperationMode!(mode); } catch (e) { throw RobotManager.withOpmodeLocalClientNote(e); }
      return;
    }
    await access.exclusive(async () => {
      // Only a hold that was granted is released afterwards, so a refusal can
      // never end a hold this session already had.
      let hold: AccessHold | null = null;
      try {
        hold = await access.acquire('rapid');
      } catch (e) {
        // RobotWare 8 refuses every switch from a station without write
        // access, so the switch is not sent and the refusal of the request is
        // what the caller sees (not the switch's "not held" answer, which
        // would point at this client). RobotWare 6/7 to Auto: the switch is
        // still tried (unchanged).
        if (rw8) {
          throw withReport(e, `setOperationMode('${mode}') was not sent: RobotWare 8 changes the operating mode only for a control station `
            + 'that holds write access, and the request for write access was refused.');
        }
      }
      try { await adapter.setOperationMode!(mode); }
      catch (e) { throw RobotManager.withOpmodeLocalClientNote(hold ? access.noteRefusal(e, [access.lockOf('rapid')]) : e); }
      finally { if (hold) { await access.releaseQuietly(hold); } }
    });
  }

  // ─── Simulation panel (virtual controllers, RWS 2.0 only) ──────────────────
  //
  // Thin passthroughs to the RWS2 client's sim* methods - the endpoints exist
  // only on RWS 2.0 virtual controllers (404 on real hardware and on RW6).
  // On an RWS 1.0 connection nothing is sent: UNSUPPORTED_OPERATION, like
  // every other RWS 2.0-only write through the manager.

  private simAdapter(): RWS2Adapter {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    if (!(this.adapter instanceof RWS2Adapter)) {
      throw new RwsError(
        'Simulation panel requires an OmniCore (RWS 2.0) virtual controller: RWS 1.0 has no simulation endpoints. Nothing was sent.',
        'UNSUPPORTED_OPERATION');
    }
    return this.adapter;
  }

  /**
   * RobotWare 8: allow or withdraw motion control for this control station
   * (`POST /rw/controlstation/allowmotioncontrol`). ABB treats allowing it as
   * the station's confirmation that an emergency stop and a normal stop are
   * available (RWS 2.0 site, Control Station Service); a jog or a RAPID start
   * from the station needs it. Call it with true only after a person who has
   * both stops within reach confirmed that (a tool shows them
   * `confirmationFor`'s text); this client never allows it on its own. It
   * withdraws it on its own (withdrawing only removes the permission and is
   * not a stop): as the first request
   * of `disconnect()`, at the next registration of this station or after a
   * re-issued session when an earlier withdrawal did not go through, and at a
   * registration that finds the station allowed when this client made no
   * allowance in this run (`withdrawn-leftover`). The
   * session is registered as a control station first when it is not yet (no
   * write access is taken). On RW 8.2.1, with it true, jogging answered 2xx
   * (2026-10-13) and a RAPID start ran, which was refused without it
   * (2026-10-18).
   *
   * It belongs to the control station, not the session (RW 8.2.1 virtual
   * controller, 2026-10-21): a second session registered with the same
   * station id read it true, and kept it after the session that allowed it
   * logged out; another station read false. It ends with a withdrawal or
   * when the station's last session ends. A process killed after allowing
   * left it standing: a new session of the same station read true 7 min
   * 42 s later. So with a fixed station id (`controlStation`) a new process
   * can find it allowed by an earlier one: the registration that finds it
   * withdraws it (owner decision 2026-10-22), and a person allows it again.
   *
   * `RobotState.access.rw8.allowMotionControl` reads null while a true is on
   * the wire, then the value the controller took (with
   * `allowMotionControlSince` for true); a refused write leaves it as it was;
   * no answer leaves it null, then one read. Listeners get one
   * `motionControl` event (cause `set`) and one change notice.
   *
   * @throws RwsError `NOT_CONNECTED`, also for a true once `disconnect()`
   *   began (nothing is sent; the disconnect withdraws; false is not
   *   refused for that reason);
   *   `UNSUPPORTED_OPERATION` on RobotWare 6 and 7, which have no control
   *   stations, before anything is sent.
   */
  async setAllowMotionControl(allow: boolean): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    if (!(adapter instanceof RWS2Adapter) || this.access(adapter).generation() !== 'rw8') {
      throw new RwsError('setAllowMotionControl is RobotWare 8 only (control stations); nothing was sent', 'UNSUPPORTED_OPERATION');
    }
    if (allow && this.teardownsRunning > 0) {
      throw new RwsError('setAllowMotionControl(true): the manager is disconnecting, and it withdraws motion control; nothing was sent', 'NOT_CONNECTED');
    }
    // The client reads null from this call until the answer: shown at once,
    // without a change notice of its own (the answer brings that).
    const pending = adapter.setAllowMotionControl(allow);
    if (this.adapter === adapter) { this._state.access = this.accessSnapshot(); }
    try {
      await pending;
    } finally {
      // A refused write leaves the value as it was; take whatever the client reports now.
      if (this.adapter === adapter) { this._state.access = this.accessSnapshot(); }
    }
  }

  /**
   * RobotWare 8: read whether motion control is allowed for this control
   * station (`GET /rw/controlstation/allowmotioncontrol`), and update
   * `RobotState.access.rw8.allowMotionControl`. A read: it decides nothing.
   * On a session that is not a registered control station yet it sends
   * nothing and returns null: RW 8.2.1 answers such a session false whatever
   * the station allows (2026-10-21), which is not the station's value. The
   * first write of a connection registers and reads it.
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` on RobotWare 6
   *   and 7, before anything is sent; the controller's error for a refused or
   *   unreadable answer.
   */
  async getAllowMotionControl(): Promise<boolean | null> {
    const port = this.motionControlPort('getAllowMotionControl');
    return port.read();
  }

  /**
   * RobotWare 8: whether the FlexPendant reads as connected, from ABB's two
   * reads, `GET /rw/controlstation/local/isconnected`
   * (`control-station-local-isconnected`) and
   * `GET /rw/controlstation/tpu/safety/protocol/status` (`is-connected`). Each
   * read that fails, or whose answer has no such field, gives null. A read:
   * it explains, for a confirmation text, and decides nothing. The field names
   * are ABB's examples.
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` on RobotWare 6
   *   and 7, before anything is sent.
   */
  async getLocalStationStatus(): Promise<LocalStationStatus> {
    const port = this.motionControlPort('getLocalStationStatus');
    return port.localStationStatus();
  }

  /** The motion-control port of this manager's RobotWare 8 client, or the error to throw. */
  private motionControlPort(op: string): NonNullable<ReturnType<typeof motionControlOf>> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const port = motionControlOf(this.adapter);
    if (!port || this.access(this.adapter).generation() !== 'rw8') {
      throw new RwsError(`${op} is RobotWare 8 only (control stations); nothing was sent`, 'UNSUPPORTED_OPERATION');
    }
    return port;
  }

  async simEmergencyStop(): Promise<void> { return this.simAdapter().simEmergencyStop(); }
  async simResetEmergencyStop(): Promise<void> { return this.simAdapter().simResetEmergencyStop(); }
  async simGeneralStop(engage = true): Promise<void> { return this.simAdapter().simGeneralStop(engage); }
  async simAutoStop(engage = true): Promise<void> { return this.simAdapter().simAutoStop(engage); }
  async simEnableSwitch(on: boolean): Promise<void> { return this.simAdapter().simEnableSwitch(on); }
  async teleportMechunit(mechunit: string, joints: number[], extJoints?: number[]): Promise<void> {
    return this.simAdapter().teleportMechunit(mechunit, joints, extJoints);
  }

  // ─── RAPID execution ────────────────────────────────────────────────────────
  //
  // start/resetpp/cycle all REQUIRE 'edit' mastership on RWS 2.0
  // (RWS 1.0 calls it 'rapid', the adapter aliases internally). Stop is the
  // exception: it is a send-first write (sendFirst).
  // Live-confirmed: calling resetpp without mastership returns
  // HTTP 403 with org_code -4501 / new_code 0xc004841d which the controller
  // misleadingly tags as "RAPID error" - but the real cause is mastership.
  //
  // We acquire+release per-call so the manager doesn't hold mastership
  // longer than necessary (other clients can use the controller meanwhile).

  /**
   * Wrap an op with auto-acquire-and-release of 'rapid'/'edit' mastership.
   *
   * NOTE: We deliberately do NOT proactively check RMMP here. Doing so caused
   * false-positive errors when:
   *   - the controller is in AUTO mode and grants are sufficient without RMMP
   *   - the logged-in user lacks UAS grant to even *request* RMMP
   *   - the controller is a VC with no FlexPendant target for the popup
   *
   * Mastership-only is the right default. If the op fails because RMMP is
   * actually missing, the caller's error handler can offer a Request-RMMP
   * action - but it's a recovery path, not a precondition.
   */
  private async withMastership<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    // Counted by the session's access manager: inside a hold the caller took
    // through requestMastership() (or one an adapter write takes inside this
    // op) nothing more is requested, and only the release that ends the last
    // hold goes on the wire - so this wrap never ends the caller's hold.
    return this.access(this.adapter).withAccess(['rapid'], fn);
  }

  /** Managers for adapters that do not bring their own (not built by this package). */
  private readonly fallbackAccess = new WeakMap<IRWSAdapter, AccessManager>();

  /**
   * The access manager of `adapter`'s session: the adapter's own when it was
   * built by this package, so the manager's wraps, the adapter's internal
   * wraps and a caller's holds all share one count per lock; otherwise one
   * kept here over the adapter's request and release calls.
   */
  private access(adapter: IRWSAdapter): AccessManager {
    let m = this.accessIfAny(adapter);
    if (!m) {
      m = new AccessManager(mastershipDriver(adapter, adapter instanceof RWS2Adapter ? 'rws2' : 'rws1'));
      this.fallbackAccess.set(adapter, m);
    }
    if (adapter === this.adapter) { this.watchAccess(m); }
    return m;
  }

  private accessIfAny(adapter: IRWSAdapter): AccessManager | undefined {
    return accessOf(adapter) ?? this.fallbackAccess.get(adapter);
  }

  // ─── RMMP (Request Manual Mode Privileges) ────────────────────────────────
  // The manual-mode counterpart of a mastership request in Auto: in manual
  // mode, mastership (and with it a jog, or a RAPID variable write on
  // RobotWare 6) needs RMMP granted by an operator at the FlexPendant first
  // (ABB RWS 1.0 and 2.0 Mastership and User pages). RobotWare 8 has no RMMP.

  /** The RMMP wait in progress (requestRmmp), if any. */
  private rmmpWait: { abort: AbortController; done: Promise<RmmpResult> } | null = null;
  /** True from a granted requestRmmp until cancelRmmp or disconnect. */
  private rmmpGranted = false;

  /**
   * This session's RMMP privilege: `none`, `pending modify`, `modify` or
   * `exec` (ABB's values), `none` when another user holds it, and
   * `unsupported` on RobotWare 8 (nothing is sent) or when the adapter has no
   * RMMP. A failed read is thrown, never reported as `none`.
   */
  async getRmmpPrivilege(): Promise<string> {
    if (!this.adapter?.getRmmpPrivilege) { return 'unsupported'; }
    return this.adapter.getRmmpPrivilege();
  }

  /**
   * Request RMMP and wait for the operator at the FlexPendant to grant it.
   * Start it only from a person's action and show that person the wait
   * (`onPending`): an operator at the controller must press Grant.
   *
   * `level` is `modify` (default) or `exec`, ABB's documented values;
   * `exclusive` is the deprecated alias of `exec`. Both are sent as asked and
   * the controller decides. RobotWare 7 refused `exec` in MANR with 403
   * -1073445800 when it saw the enabling device released (virtual-controller run 2026-10-12),
   * and refused it the same way with Enable held at the virtual FlexPendant and
   * MANR and motors on read back (RW 7.21.4, 2026-10-18); that refusal is
   * thrown with its explanation. ABB's RobotStudio manual says
   * a remote user cannot set the program pointer in manual mode, and RW 7.21.4
   * refused program-pointer moves under `modify`; whether `exec` lifts that
   * is not established.
   *
   * Before sending: RobotWare 8 is refused (UNSUPPORTED_OPERATION; it has no
   * RMMP), and so is a second request while one of this session waits
   * (CONTROLLER_BUSY). The operating mode is not read: ABB says RobotWare 7 accepts the
   * request in MANR only ("Can be performed in MANR mode only"), and outside
   * MANR the controller answers -1073445800, which is passed on as
   * rmmp-wrong-mode. On RobotWare 6 ABB documents no mode rule. A privilege
   * this session already holds that covers the level asked for (`exec` covers
   * `modify`) is reported as `granted` and nothing is sent. `exec` asked for
   * while this session holds `modify` resolves `held-lower` and nothing is
   * sent: ABB documents the RMMP flow as request, grant, then cancel of the
   * held privilege, and documents no step that raises a held level, so call
   * `cancelRmmp()` first and then request `exec`.
   *
   * Then: `POST /users/rmmp privilege=<level>`, and a poll every `pollMs`
   * (default 1 s) that keeps the request alive past ABB's 10 s window, until
   * the privilege reads as this session's (`granted`), the controller reports
   * a denial (`denied`), the request stops being pending without a grant, or
   * `waitMs` (default 30 s) runs out (`expired`, cancelled), or `signal`
   * aborts (`cancelled`, cancelled). A refused request or a failed read is
   * thrown; a read that failed is never taken as `none`. One wait at a time
   * per session (CONTROLLER_BUSY otherwise).
   *
   * A granted privilege stays until `cancelRmmp()` (pair them, as with
   * mastership) or the connection ends: `disconnect()` cancels it, and stops
   * a wait in progress with a cancel. ABB states no lifetime; on RW 7.21.4 a
   * granted `modify` was still held after 180 s with nothing but reads sent
   * (2026-10-18), and a longer hold was not measured. While a remote client holds mastership
   * granted in manual mode the FlexPendant is locked (ABB PC SDK manual,
   * Mastership).
   */
  async requestRmmp(level: RmmpLevel | 'exclusive' = 'modify', options: RmmpRequestOptions = {}): Promise<RmmpResult> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    // 'modify' and 'exec' are both sent; the controller decides ('exclusive' is
    // the deprecated alias of 'exec'). ABB's RWS pages document both levels,
    // and a refusal (RobotWare 7: 403 -1073445800 when the enabling device is
    // not held, seen on a 7.21.4 virtual controller) is passed through with its
    // explanation. Nothing is sent, as the README says, on RobotWare 8 (no
    // RMMP), and in two cases of this session's own state: a level it already
    // holds or covers (`granted`), and a higher level while it holds a lower
    // one (`held-lower`). A second wait while one is in progress is refused
    // (CONTROLLER_BUSY), also before sending.
    const wanted = rmmpLevel(level);
    rmmpWaitOptions(options);
    const generation = this.access(adapter).generation();
    if (generation === 'rw8') { throw rmmpUnsupportedOnRw8('requestRmmp', this._state.systemInfo?.rwVersion || null); }
    const { requestRmmp, pollRmmp, getRmmpPrivilege, cancelRmmp } = adapter;
    if (!requestRmmp || !pollRmmp || !getRmmpPrivilege || !cancelRmmp) {
      throw new RwsError('RMMP not supported on this controller', 'UNSUPPORTED_OPERATION');
    }
    if (this.rmmpWait) {
      throw new RwsError(
        'requestRmmp: an RMMP request of this session is already waiting for the operator at the FlexPendant. '
        + 'Wait for it, or call cancelRmmp(), before asking again. Nothing was sent.',
        'CONTROLLER_BUSY');
    }
    // RobotWare 7 accepts an RMMP request only in MANR (ABB). The request is
    // sent in any mode and the controller decides: outside MANR it answers
    // -1073445800 SYS_CTRL_E_RMMP_E_REJECT, explained as rmmp-wrong-mode.
    const current = await getRmmpPrivilege.call(adapter);
    if (current === 'unsupported') { throw rmmpUnsupportedOnRw8('requestRmmp', this._state.systemInfo?.rwVersion || null); }
    if (isRmmpGranted(current)) {
      // Held by this session: give it back on disconnect, whatever was asked for.
      this.rmmpGranted = true;
      const held = normaliseRmmpPrivilege(current);
      if (rmmpCovers(held, wanted)) {
        return { outcome: 'granted', privilege: held, detail: `RMMP '${held}' is already granted to this session. Nothing was sent.` };
      }
      return {
        outcome: 'held-lower', privilege: held,
        detail: `This session holds RMMP '${held}', which does not cover '${wanted}'. Nothing was sent. `
          + `Call cancelRmmp() to give '${held}' back first, then request '${wanted}'.`,
      };
    }

    const abort = new AbortController();
    const onCallerAbort = (): void => { abort.abort(); };
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (options.signal?.aborted) { abort.abort(); }
    const port: RmmpPort = {
      request: l => requestRmmp.call(adapter, l),
      poll: () => pollRmmp.call(adapter),
      read: () => getRmmpPrivilege.call(adapter),
      cancel: () => cancelRmmp.call(adapter),
    };
    const wait = { abort, done: waitForRmmp(port, wanted, { ...options, signal: abort.signal }, generation) };
    this.rmmpWait = wait;
    try {
      const result = await wait.done;
      if (result.outcome === 'granted') { this.rmmpGranted = true; }
      return result;
    } finally {
      options.signal?.removeEventListener('abort', onCallerAbort);
      if (this.rmmpWait === wait) { this.rmmpWait = null; }
    }
  }

  /** Poll a pending RMMP request - keeps it alive past ABB's 10 s window and reports its status. */
  async pollRmmp(): Promise<string> {
    if (!this.adapter?.pollRmmp) { return 'unsupported'; }
    return this.adapter.pollRmmp();
  }

  /**
   * Cancel this session's pending or held RMMP (withdraws the FlexPendant
   * request, or gives the privilege back). A `requestRmmp` wait in progress
   * is stopped and its request cancelled. RobotWare 8: UNSUPPORTED_OPERATION,
   * nothing sent.
   */
  async cancelRmmp(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    if (!adapter.cancelRmmp) { throw new RwsError('RMMP not supported on this controller', 'UNSUPPORTED_OPERATION'); }
    const wait = this.rmmpWait;
    if (wait) {
      wait.abort.abort();
      const result = await wait.done.catch(() => null);
      // The wait cancels its own request; only a grant it reached first is left to give back.
      if (result?.outcome !== 'granted') { this.rmmpGranted = false; return; }
    }
    await adapter.cancelRmmp();
    this.rmmpGranted = false;
  }

  /**
   * On disconnect: stop an RMMP wait (its cancel goes out on this session
   * before the logout), and give back a privilege this manager was granted.
   * ABB's session rule names only subscriptions and mastership as released
   * at logout, not RMMP, so the cancel is sent explicitly. Best effort: a
   * failure is logged.
   */
  private async endRmmp(): Promise<void> {
    const wait = this.rmmpWait;
    if (wait) {
      wait.abort.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        wait.done.catch(() => null),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); }),
      ]);
      if (timer) { clearTimeout(timer); }
    }
    const adapter = this.adapter;
    if (this.rmmpGranted && adapter?.cancelRmmp) {
      try {
        await adapter.cancelRmmp();
      } catch (e) {
        Logger.warn(`RMMP: the cancel on disconnect failed (${e instanceof Error ? e.message : String(e)}); ABB does not document whether a logout ends the privilege`);
      }
    }
    this.rmmpGranted = false;
  }

  /**
   * Start RAPID execution from where the program pointer is. This method never
   * moves the program pointer. Up to 1.3.x it moved the pointer back to the
   * routine of the last `setPPToRoutine` whenever the program was stopped,
   * which also restarted a routine from its top after a Stop in the middle of
   * it. To run a routine from its start, call `setPPToRoutine` first, then
   * `startRapid`.
   *
   * On RobotWare 6 and 7 a start right after a jog first ends the jog's own
   * motion hold, which would otherwise last until 2 s after the last jog: ABB
   * says a start does not succeed while the client holds motion mastership. A
   * motion hold the caller took with `requestMastership('motion')` or
   * `requestMastershipAll()` is left alone. See `withStartMastership`.
   *
   * On RobotWare 8 the controller refuses a start from a station that has not
   * allowed motion control (-1073435864); the refusal is `GRANT_DENIED`,
   * `refusal.kind` `motion-control-off`, and its remedy is
   * `declare-motion-control`: it names `setAllowMotionControl(true)` and the
   * confirmation a person gives; the client never calls it.
   */
  async startRapid(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.withStartMastership(() => this.adapter!.startRapid());
  }

  /** Active task name - the task flagged active, else the first task, else T_ROB1. */
  private activeTaskName(): string {
    const active = this._state.tasks.find(t => t.active);
    return active?.name ?? this._state.tasks[0]?.name ?? 'T_ROB1';
  }

  /**
   * Re-list one task's modules after a load/unload: into the per-task map,
   * and into the flat `modules` snapshot when it is the primary task.
   * Returns the list read ([] when not connected).
   */
  private async refreshTaskModules(taskName: string): Promise<string[]> {
    if (!this.adapter) { return []; }
    const list = await this.adapter.listModules(taskName);
    this._state.modulesByTask = { ...this._state.modulesByTask, [taskName]: list };
    if (taskName === this.activeTaskName()) { this._state.modules = list; }
    return list;
  }

  /**
   * Stop RAPID execution. The stop is sent first and never
   * waits for mastership or write access, so another client's hold cannot
   * delay it at this client's acquire step. Only when the controller refuses
   * it because this session holds no access does the manager request access,
   * send once more and release right after; any other refusal is passed on
   * unretried, naming the holder when the controller says who.
   *
   * A stop over RWS is a program stop, not a safety stop. Use the emergency
   * stop for safety.
   *
   * @throws {RwsError} NOT_CONNECTED before connect(); otherwise the controller's
   *   refusal with its own code, the holder named when the controller says who.
   */
  async stopRapid(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    await this.sendFirst('stop', adapter, () => adapter.stopRapid());
  }

  // ─── Send-first writes: stop and motors off ─────────────────────────────────

  /**
   * Controller codes that mean "this session holds no access for the write".
   * Only these trigger the one acquire-and-retry of a send-first write.
   *
   * - -1073445859 SYS_CTRL_E_MASTER_REJECT: the user does not have the required
   *   mastership (RWS 1.0 and 2.0 return-code lists; captured on RW 7.21).
   * - -1073445880 SYS_CTRL_E_RESOURCE_NOT_HELD: the resource is not held by the
   *   caller. In ABB's return-code lists; never observed on our controllers.
   * - -1073435873: the control station does not have write access (RobotWare 8).
   * - -1073435871: the session is not part of a control station (RobotWare 8).
   *   A new or re-issued session is unregistered; the acquire registers it,
   *   then requests write access, which is the same designed path. Seen only
   *   on the write-access request itself so far.
   */
  private static readonly NOT_HELD_CODES: ReadonlySet<number> = NOT_HELD_CODES;

  /**
   * Controller codes that mean another client or station holds the access.
   * - -1073445862 SYS_CTRL_E_RESOURCE_HELD (RobotWare 6 and 7). RWS 2.0 has
   *   also answered it for a resource blocked by an operation in progress.
   * - -1073435870: write access is already taken by another control station
   *   (RobotWare 8).
   */
  private static readonly HELD_BY_OTHER_CODES: ReadonlySet<number> = new Set([
    -1073445862, -1073435870,
  ]);

  /** -1073445867 SYS_CTRL_E_UAS_REJECT: not allowed for the logged-in user. */
  private static readonly UAS_REJECT = -1073445867;

  private static isNotHeld(e: unknown): boolean {
    return e instanceof RwsError && e.controllerCode !== undefined
      && RobotManager.NOT_HELD_CODES.has(e.controllerCode);
  }

  private static isHeldByOther(e: unknown): boolean {
    return e instanceof RwsError && e.controllerCode !== undefined
      && RobotManager.HELD_BY_OTHER_CODES.has(e.controllerCode);
  }

  /**
   * Run a write that moves the cell toward rest (a RAPID stop, motors off).
   *
   * 1. Send it at once, with no acquire in front of it. A stop is never made
   *    to wait for access.
   * 2. If the controller refuses it because this session holds no mastership
   *    (RobotWare 6/7) or no control-station write access (RobotWare 8),
   *    request access through the controller's normal request, send it once
   *    more, and release the access right after, on every path. There is no
   *    second retry.
   * 3. Any other refusal is passed on unretried, with the controller's code.
   *    When another client or station holds the access, the controller is
   *    asked who, and the error names the holder if the controller says.
   *
   * Pending live verification, so the conservative choices are explicit here:
   * - Whether a stop or motors off without any hold is accepted is not yet
   *   observed on every generation. ABB's RWS 2.0 reference lists no
   *   prerequisite for execution/stop ("Pre-requisites: None") and none for
   *   the ctrl-state resource; the RWS 1.0 pages state no mastership either.
   *   Sending first and acquiring only on a not-held refusal covers both
   *   outcomes without guessing.
   * - The retry takes the same lock the manager has always taken for these
   *   writes: 'rapid' (RobotWare 6), which the adapter maps to 'edit'
   *   (RobotWare 7) and to control-station write access (RobotWare 8).
   * - A remote stop in Auto may need the 'Remote Start and Stop in Auto'
   *   grant: ABB's RobotStudio operating manual says so, while the RWS
   *   reference and the 'Execute program' grant say stop is always allowed.
   *   A user refusal therefore names both and claims neither.
   * - The holder values a mastership status carries while a lock is held
   *   ('local', 'remote', 'internal') come from ABB's reference; an
   *   unexpected value is shown as the controller sent it.
   *
   * Access requests go through the controller's documented request only; no
   * RMMP request is raised here (that needs a person at the FlexPendant).
   */
  private async sendFirst(
    op: 'stop' | 'motors-off', adapter: IRWSAdapter, send: () => Promise<void>,
  ): Promise<void> {
    let first: unknown;
    try {
      await send();
      return;
    } catch (e) {
      if (!RobotManager.isNotHeld(e)) { throw await this.safeRefusal(op, adapter, e, 'send'); }
      first = e;
      Logger.info(`${RobotManager.safeLabel(op)}: refused as not holding access - requesting it once and sending again`);
    }

    // RobotWare 8 has one global write access, so there every lock this
    // session counts is the one the controller says is not held; on 6/7 it is
    // the lock this write needs ('rapid', which RWS 2.0 calls 'edit').
    const access = this.access(adapter);
    const rw8NotHeld = first instanceof RwsError
      && (first.controllerCode === -1073435873 || first.controllerCode === -1073435871);
    const refused = rw8NotHeld ? access.heldLocks() : [access.lockOf('rapid')];
    if (refused.some(l => access.count(l) > 0)) {
      // A hold this session counted (the caller's, through requestMastership(),
      // or an operation's in progress) was not honoured by the controller: it
      // has ended (a mode change, a restart, a lost session or the pendant
      // taking it back). That is recorded as a loss, and the hold is not
      // restored behind anyone's back - the access taken below is released as
      // soon as the retry returns.
      access.recordLoss(refused, 'unknown', `${RobotManager.safeLabel(op)} was refused as not holding access although this session held it; that hold has ended`);
    }

    let hold: AccessHold;
    try {
      hold = await access.acquire('rapid');
    } catch (acquireErr) {
      throw await this.safeRefusal(op, adapter, acquireErr, 'acquire');
    }

    let retryFailed = false;
    let retryErr: unknown;
    try {
      await send();
    } catch (e) {
      retryFailed = true;
      retryErr = e;
    } finally {
      // A failed release is logged by the access manager ("may stay held until
      // this session ends"), never thrown over the stop's own result.
      await access.releaseQuietly(hold);
    }
    if (retryFailed) { throw await this.safeRefusal(op, adapter, retryErr, 'retry'); }
  }

  private static safeLabel(op: 'stop' | 'motors-off'): string {
    return op === 'stop' ? 'RAPID stop' : 'Motors off';
  }

  /**
   * Turn a send-first failure into the error the caller sees: the
   * controller's code, HTTP status and text are kept, and the message says
   * what was refused, who holds the access when the controller names a
   * holder, and that an RWS stop is not a safety stop.
   */
  private async safeRefusal(
    op: 'stop' | 'motors-off', adapter: IRWSAdapter, err: unknown,
    phase: 'send' | 'acquire' | 'retry',
  ): Promise<RwsError> {
    const what = RobotManager.safeLabel(op);
    const safety = op === 'stop'
      ? 'A stop over RWS is a program stop, not a safety stop. Use the emergency stop for safety.'
      : 'Motors off over RWS is not a safety function. Use the emergency stop for safety.';
    if (!(err instanceof RwsError)) {
      return new RwsError(`${what} failed: ${err instanceof Error ? err.message : String(err)}. ${safety}`, 'UNKNOWN');
    }

    const original = err.message.replace(/\.\s*$/, '');
    const parts: string[] = [];
    if (phase === 'acquire') {
      parts.push(`${what} was refused because this session held no access, and the request for access was refused too: ${original}.`);
    } else if (phase === 'retry') {
      parts.push(`${what} was refused again after access was taken: ${original}.`);
    } else {
      parts.push(`${what} was refused: ${original}.`);
    }

    // The refusal keeps the controller's answer and gains the holder when one
    // was read (RwsError.refusal).
    let refused = err;
    if (RobotManager.isHeldByOther(err)) {
      // The access manager may have named the holder already (in the
      // refusal and its message); then no second read is made.
      if (!err.refusal?.holder) {
        const { sentence, holder } = await this.describeHolder(adapter, err);
        parts.push(sentence);
        if (holder) { refused = explainRefusal(err, { holder }); }
      }
      parts.push(op === 'stop'
        ? 'Use the FlexPendant stop or the emergency stop.'
        : 'Use the FlexPendant or the emergency stop.');
    } else if (op === 'stop' && err.controllerCode === RobotManager.UAS_REJECT) {
      parts.push(this.stopGrantHint(adapter));
    }
    parts.push(safety);

    return new RwsError(parts.join(' '), err.code, err.httpStatus, err.rwsDetail,
      err.controllerCode, err.controllerMsg, refused.refusal);
  }

  /**
   * One status read to name the holder of the access the controller said is
   * held by another. RobotWare 8: the control-station name from the
   * write-access status (the station id is compared, never shown). RobotWare
   * 6/7: the mastership status of the RAPID domain. When the read fails or
   * names nobody, the sentence says so rather than guessing.
   */
  private async describeHolder(adapter: IRWSAdapter, err: RwsError): Promise<{ sentence: string; holder: RefusalHolder | null }> {
    const unknown = { sentence: 'The controller did not say who holds it.', holder: null };
    try {
      if (err.controllerCode === -1073435870) {
        if (!(adapter instanceof RWS2Adapter)) { return unknown; }
        const holder = holderFromWriteAccess(await adapter.getWriteAccessStatus());
        return holder?.name ? { sentence: holderSentence(holder, 'rw8'), holder } : unknown;
      }
      if (!adapter.getMastershipStatus) { return unknown; }
      const s = await adapter.getMastershipStatus('rapid');
      const holder = holderFromMastership(s);
      switch (s.mastership) {
        case 'local':
        case 'remote':
        case 'internal':
          return { sentence: holderSentence(holder, null), holder };
        case 'nomaster':
          return { sentence: 'The controller reports no holder now; the refusal may have come from an operation in progress.', holder: null };
        case 'unknown':
        case '':
          return unknown;
        default: {
          const who = [
            s.application ? `application '${s.application}'` : '',
            s.uid ? `user id ${s.uid}` : '',
          ].filter(Boolean).join(', ');
          return { sentence: `The controller reports mastership '${s.mastership}'${who ? ` (${who})` : ''}.`, holder };
        }
      }
    } catch (e) {
      Logger.trace?.('mastership', `holder lookup after a refused stop or motors-off write failed: ${e instanceof Error ? e.message : String(e)}`);
      return unknown;
    }
  }

  /**
   * The grant sentence for a stop refused for the logged-in user. ABB's
   * documents disagree: the RobotStudio operating manual requires 'Remote
   * Start and Stop in Auto' to start or stop from a remote client in Auto,
   * while its 'Execute program' grant row says "stop is always allowed", and
   * the OmniCore RWS reference calls stop "always allowed". The sentence
   * names both and claims neither. The identifier of the Auto grant is named
   * only for OmniCore, where ABB lists it; RobotWare 6's RWS grant list does
   * not include it.
   */
  private stopGrantHint(adapter: IRWSAdapter): string {
    const admin = 'An administrator can check the user\'s grants in RobotStudio (Authenticate > View UAS Grants).';
    const manual = this._state.opmode === 'MANR' || this._state.opmode === 'MANF';
    if (manual) { return `The controller refused the stop for this user. ${admin}`; }
    const omnicore = adapter instanceof RWS2Adapter;
    const autoGrant = omnicore
      ? '\'Remote Start and Stop in Auto\' (UAS_REMOTE_START_STOP_IN_AUTO)'
      : '\'Remote Start Stop in Auto\'';
    const alwaysAllowed = omnicore
      ? 'the RWS reference and the \'Execute program\' grant (UAS_RAPID_EXECUTE) say stop is always allowed'
      : 'the \'Execute program\' grant (UAS_RAPID_EXECUTE) says stop is always allowed';
    return `The controller refused the stop for this user. ABB's documents disagree on whether a remote stop needs a grant: the RobotStudio operating manual requires ${autoGrant} to start or stop from a remote client in Auto, while ${alwaysAllowed}. ${admin}`;
  }
  async resetRapid(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    try {
      await this.withMastership(() => this.adapter!.resetRapid());
    } catch (e) {
      // Live-verified 2026-09-24 on an RW 7.21 VC:
      // a task with no `main` routine answers POST resetpp with 404, which reads
      // as "Resource does not exist" - the path exists; the routine does not.
      // Only a real 404: RobotWare 6 answered a manual-mode refusal with HTTP
      // 400 and a generic code (RW 6.16.03, 2026-10-13), which is not a
      // missing routine.
      if (e instanceof RwsError && e.code === 'RESOURCE_NOT_FOUND' && e.httpStatus === 404) {
        throw new RwsError(
          `Cannot set the program pointer to main: task ${this.activeTaskName()} has no main routine`,
          'RESOURCE_NOT_FOUND', e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg);
      }
      throw e;
    }
  }

  /**
   * Set the RAPID execution cycle, then read it back once so
   * `RobotState.execCycle` shows what the controller holds right away. Before,
   * the state kept the old cycle until the next full refresh: virtual-controller run 2026-10-12
   * on RobotWare 6.16.03, 7.21.4 and 8.2.1 read the old value 300 ms after a
   * set the controller had logged (elog 10153 "Run mode has been changed to
   * single cycle"). The state takes the controller's answer, not the value
   * asked for; a failed read-back leaves the state as it was and does not fail
   * the set, which the controller accepted.
   */
  async setExecutionCycle(cycle: 'once' | 'forever' | 'asis'): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    await this.withMastership(() => adapter.setExecutionCycle(cycle));
    try {
      const info = await adapter.getRapidExecutionInfo();
      if (this.adapter === adapter && info.cycle && this._state.execCycle !== info.cycle) {
        this._state.execCycle = info.cycle;
        this.notify();
      }
    } catch (e) {
      Logger.trace?.('rapid', `setExecutionCycle('${cycle}') was accepted; reading the cycle back failed (${e instanceof Error ? e.message : String(e)}), the next refresh reads it`);
    }
  }

  async activateRapidTask(task: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.activateRapidTask(task);
  }

  async deactivateRapidTask(task: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.deactivateRapidTask(task);
  }

  /**
   * Activate every RAPID task. RWS 1.0 sends ABB's one all-tasks action and the
   * controller answers for all tasks at once; RWS 2.0 has no such action, so
   * the adapter activates each task in turn and throws when the controller
   * refused any of them, naming each refused task with its reason and the
   * tasks that were activated. The code and refusal are the first refused
   * task's.
   */
  async activateAllRapidTasks(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.activateAllRapidTasks();
  }

  /** Deactivate every RAPID task; refusals are reported as for `activateAllRapidTasks`. */
  async deactivateAllRapidTasks(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.deactivateAllRapidTasks();
  }

  // ─── RAPID variables ────────────────────────────────────────────────────────

  async getRapidVariable(task: string, module: string, symbol: string): Promise<string> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.getRapidVariable(task, module, symbol);
  }

  async setRapidVariable(task: string, module: string, symbol: string, value: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.setRapidVariable(task, module, symbol, value);
  }

  /**
   * Ask the controller to validate a value against a RAPID data type, writing
   * nothing. Not a check of the value on RW 6.16.03, 7.21.4 or 8.2.1: each
   * answered 204 (`true`) to every value sent on 2026-10-01, a malformed
   * literal and a value of another type included, so `true` means only that
   * the controller did not refuse the request.
   */
  async validateRapidValue(task: string, value: string, datatype: string): Promise<boolean> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.validateRapidValue(task, value, datatype);
  }

  async getRapidSymbolProperties(task: string, module: string, symbol: string): Promise<RapidSymbolProperties> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.getRapidSymbolProperties(task, module, symbol);
  }

  async searchRapidSymbols(params: RapidSymbolSearchParams): Promise<RapidSymbolInfo[]> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.searchRapidSymbols(params);
  }

  /**
   * Detailed list of loaded modules - each entry has `name` + `type` (SysMod / ProgMod).
   * Used by the Modules tree to render system vs program modules differently.
   * Falls back to bare names from `listModules` if the adapter doesn't support details.
   */
  async listModulesDetailed(task: string): Promise<Array<{ name: string; type: string }>> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    if (this.adapter.listModulesDetailed) {
      return this.adapter.listModulesDetailed(task);
    }
    const names = await this.adapter.listModules(task);
    return names.map(n => ({ name: n, type: '' }));
  }

  /**
   * Current program-pointer location for a task (module + routine + line).
   * Returns null if the controller can't currently report a PP (e.g. no
   * program loaded). Surfaces the data the Modules tree uses to highlight
   * which routine is "active".
   */
  async getCurrentPP(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number } | null> {
    if (!this.adapter?.getProgramPointer) { return null; }
    try { return await this.adapter.getProgramPointer(task); }
    catch { return null; }
  }

  /**
   * List the routines (PROCs, FUNCs, TRAPs) defined in a loaded module.
   * Uses the controller's symbol search rather than parsing the source -
   * works even when the module file isn't on disk anymore (e.g. it was
   * loaded then the file was deleted / never persisted).
   *
   * Returns: array of `{ name, symtyp }` where `symtyp` is one of:
   *   - 'prc'  procedure (no return value, callable)
   *   - 'fun'  function (returns a value)
   *   - 'trp'  trap (interrupt handler)
   * Routines from the controller's BASE / system modules are NOT included
   * unless `includeSystem=true`.
   */
  async listRoutines(
    task: string,
    moduleName: string,
    includeSystem = false,
  ): Promise<Array<{ name: string; symtyp: string; symburl: string; local: boolean }>> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const symbols = await this.adapter.searchRapidSymbols({
      task,
      blockurl: `RAPID/${task}/${moduleName}`,
      symtyp:   'any',
      // `recursive` accepts boolean in our type; the wire format is upper-case 'TRUE'
      // and the adapter stringifies. Lib's default already sets 'TRUE' if omitted.
    });
    const routineKinds = new Set(['prc', 'fun', 'trp']);
    return symbols
      .filter(s => routineKinds.has(s.symtyp.toLowerCase()))
      .filter(s => includeSystem || !s.local /* keep public; refine if needed */)
      .map(s => ({ name: s.name, symtyp: s.symtyp, symburl: s.symburl, local: s.local }));
  }

  /**
   * Set the program pointer to a specific routine, optionally in a specific module.
   * If `module` is omitted, the controller picks based on its current scope.
   * Holds RAPID mastership (RobotWare 6), `edit` (RobotWare 7) or write access
   * (RobotWare 8) around it.
   *
   * After this returns successfully, the user can click Start and execution
   * will begin at this routine instead of `main`.
   *
   * A running program is never stopped unasked: the execution state is read
   * first, and with `options.stopIfRunning` the program is stopped before the
   * move (a failed stop fails the call). Without it the move is sent anyway:
   * ABB lists no execution-state prerequisite for it, so the controller
   * decides, and a refusal while the program ran is explained as such
   * (`WRONG_MODE`, `refusal.kind` `wrong-state`). Up to 1.3.x the call always
   * sent a stop and ignored its failure.
   */
  async setPPToRoutine(task: string, moduleName: string, routine: string, options: { stopIfRunning?: boolean } = {}): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    if (!this.adapter.setProgramPointer) { throw new RwsError('setProgramPointer not supported on this protocol', 'UNSUPPORTED_OPERATION'); }
    const adapter = this.adapter;
    await this.withMastership(async () => {
      const running = await this.stopIfAsked(adapter, options.stopIfRunning === true);
      try {
        await adapter.setProgramPointer!(task, { module: moduleName, routine });
      } catch (e) {
        throw running ? this.programRunningRefusal(adapter, 'setPPToRoutine', 'The program pointer was not moved.', e) : e;
      }
    });
  }

  /**
   * The read in front of a write that must not silently stop the program: one
   * fresh read of the RAPID execution state. Running and `stopIfRunning`: the
   * program is stopped (a failed stop throws). Returns true when the program
   * runs and was not stopped: the write is still sent (ABB lists no
   * execution-state prerequisite for load, unload or PP to routine, and the
   * owner's write policy is that the controller decides), and a refusal is
   * explained with `programRunningRefusal`.
   */
  private async stopIfAsked(adapter: IRWSAdapter, stopIfRunning: boolean): Promise<boolean> {
    if ((await adapter.getRapidExecutionState()) !== 'running') { return false; }
    if (!stopIfRunning) { return true; }
    await adapter.stopRapid();
    return false;
  }

  /**
   * A controller refusal of an operation sent while the RAPID program ran,
   * explained with that reading and the way to stop it first; the controller's
   * code and text are kept. Any other error is returned as it is.
   */
  private programRunningRefusal(adapter: IRWSAdapter, op: string, notDone: string, e: unknown): unknown {
    if (!RobotManager.isStateLikeRefusal(e)) { return e; }
    const fix = `Stop the program first (stopRapid), or call ${op} with { stopIfRunning: true } to stop it as part of the call.`;
    const sentence = `${op}: the controller refused it while the RAPID program was running, and ${op} does not stop it unless asked to. ${fix} ${notDone}`;
    const generation = this.access(adapter).generation();
    return new RwsError(`${sentence} Controller: ${e.message}`, 'WRONG_MODE', e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg, builtRefusal({
      kind: 'wrong-state', condition: 'controller-state', generation, grantor: 'this-tool',
      missing: 'a stopped RAPID program', fix, sentence, evidence: 'unverified',
      remedy: remedy.stopProgramFirst(generation),
      otherRemedies: [remedy.doAtPendant(generation, { detail: 'Stop the program at the FlexPendant, then run the operation again.', afterwards: 'run-again' })],
    }), e.responseBody);
  }

  async getActiveUiInstruction(): Promise<UiInstruction | null> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.getActiveUiInstruction();
  }

  /**
   * Answer the active UI instruction: set one of its parameters. The names are
   * the instruction's own; the controller lists them at
   * `GET /rw/rapid/uiinstr/active/params/{stackurl}`. A TPReadNum on RW 6.16.03
   * took `TPAnswer` then `TPCompleted` = 'TRUE' (2026-10-13) and refused
   * `Result` (400 -1073445879).
   */
  async setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.setUiInstructionParam(stackurl, uiparam, value);
  }

  // ─── File system ────────────────────────────────────────────────────────────

  async listDirectory(remotePath: string): Promise<FileEntry[]>  {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.listDirectory(remotePath);
  }

  async readFile(remotePath: string): Promise<string> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.readFile(remotePath);
  }

  /** Write an arbitrary file to the controller filesystem (no module load - see loadProgram for that). */
  async uploadFile(remotePath: string, content: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.uploadFile(remotePath, content);
  }

  async deleteControllerFile(remotePath: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.deleteFile(remotePath);
  }

  /**
   * Create a directory on the controller filesystem.
   * If `parentPath` itself doesn't exist, recursively creates the missing
   * parents under the volume root ($HOME / HOME / BACKUP / …). This is
   * mkdir -p semantics - friendlier than the bare ABB endpoint which
   * returns 404 "Path does not exist" if any intermediate is missing.
   */
  async createDirectory(parentPath: string, dirName: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    try {
      await this.adapter.createDirectory(parentPath, dirName);
      return;
    } catch (e) {
      // 404 "Path does not exist" → ensure parents exist, then retry once.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/HTTP 404|Path does not exist/i.test(msg)) { throw e; }
      await this.ensureDirectory(parentPath);
      await this.adapter.createDirectory(parentPath, dirName);
    }
  }

  /**
   * Walk down `path` from the volume root, creating each missing segment.
   * Volumes ($HOME, HOME, BACKUP, DATA, …) themselves are NEVER created -
   * they're controller-managed.
   */
  private async ensureDirectory(targetPath: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    // Strip leading slash if any; first segment is the volume name.
    const cleaned = targetPath.replace(/^\/+/, '');
    const segments = cleaned.split('/').filter(Boolean);
    if (segments.length <= 1) { return; } // just a volume - caller can't create that
    // Walk: $HOME, $HOME/a, $HOME/a/b, ...
    let cursor = segments[0]; // the volume
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      try {
        await this.adapter.createDirectory(cursor, seg);
      } catch (e) {
        // 409-ish "already exists" or 200 - treat as ok. Other errors propagate.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/already exists|HTTP 200|HTTP 204|409/i.test(msg)) {
          // Path didn't exist AND we couldn't create it - keep walking but
          // re-throw at the end if the final create fails. (One forgiving pass.)
          if (!/HTTP 404|Path does not exist/i.test(msg)) { throw e; }
        }
      }
      cursor = `${cursor}/${seg}`;
    }
  }

  async copyControllerFile(sourcePath: string, destPath: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.copyFile(sourcePath, destPath);
  }

  // ─── Event log ──────────────────────────────────────────────────────────────

  /**
   * Re-read the whole domain-0 event log into `state.eventLog` (on RWS 2.0
   * the newest 1000 messages, see readWholeEventLog). A read that lands
   * after a reconnect or disconnect is dropped.
   */
  async refreshEventLog(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) { return; }
    const gen = this.pollGeneration;
    const writes = this.elogWrites;
    try {
      const log = await this.readWholeEventLog(adapter, gen);
      if (gen !== this.pollGeneration) { return; }
      this.elogFullReadGen = gen;
      this.writeEventLog(this.landWholeEventLog(adapter, log, writes));
      this.notify();
    } catch { /* non-fatal */ }
  }

  /**
   * Fetch one event-log domain directly (domain 0 = common/all) without
   * touching state - refreshEventLog() stays the state-updating path. The
   * adapters in this package read every page, up to 20 (about 1000
   * messages): RWS 1.0 newest first, following the listing's `next` link
   * (up to 1.4.x only its first 50 messages), RWS 2.0 oldest first.
   * `state.eventLog` keeps the newest page on RWS 1.0. One call sends one
   * request per page on either generation, up to 20 for a full log, so a
   * poller paces by pages (one per 50 messages), not by calls.
   */
  async getEventLog(domain = 0, lang = 'en'): Promise<ElogMessage[]> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.getEventLog(domain, lang);
  }

  async clearEventLog(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.clearEventLog(0);
    this.writeEventLog([]);
    this.notify();
  }

  async clearAllEventLogs(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.clearAllEventLogs();
    this.writeEventLog([]);
    this.notify();
  }

  // ─── Controller info ─────────────────────────────────────────────────────────

  async restartController(mode: RestartMode): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.restartController(mode);
  }

  async getControllerClock(): Promise<string> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return (await this.adapter.getControllerClock()).datetime;
  }

  async setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.setControllerClock(year, month, day, hour, min, sec);
  }

  // ─── I/O ─────────────────────────────────────────────────────────────────────

  async refreshIoSignals(): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    // listAllSignals follows the controller's own pagination on both
    // generations (RWS 1.0 since 1.5.0), so one call returns every signal.
    // Looping over it again here re-fetched from an offset and appended
    // duplicates.
    // Pinned to the connection it started on: a table read on a connection
    // that has gone since must not land in, or mark loaded, the next one.
    const generation = this.pollGeneration;
    const mark = this.signalTableStart();
    const all = await this.adapter.listAllSignals();
    if (generation !== this.pollGeneration) { return; }
    // A whole walk: the poll's next one is a full interval from now. When a
    // walk that started after this one has landed already, its newer table
    // stays (see SIGNAL_TABLE_REFRESH_MS).
    if (!this.signalTableLanded(mark)) { return; }
    this._state.ioSignals = all;
    this._state.ioSignalsLoaded = true;
    this.notify();
  }

  /**
   * Set a signal's value by its name alone. On RWS 2.0 the client learns the
   * signal's network and device, or that it has none, from the signal table
   * or from one read of the signal first, so this also works before the table
   * has loaded and for signals with no device (see `RwsClient2.writeSignal`).
   */
  async writeIoSignal(name: string, value: string): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    await this.adapter.writeSignal('', '', name, value);
    const sig = this._state.ioSignals.find(s => s.name === name);
    if (sig) { sig.lvalue = value; sig.value = value; this.notify(); }
  }

  async readIoSignal(network: string, device: string, name: string): Promise<Signal> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.readSignal(network, device, name);
  }

  async listNetworks(): Promise<IoNetwork[]> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.listNetworks();
  }

  async listDevices(network: string): Promise<IoDevice[]> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.listDevices(network);
  }

  /**
   * Simulate a signal, or end its simulation, on both generations (RWS 1.0
   * built from ABB's page, not yet run; it needs network, device and name).
   * Like a value write it takes no mastership or write access: the
   * controller decides. `unblockSignals()` ends every simulation at once.
   */
  async setSignalSimulated(network: string, device: string, name: string, simulated: boolean): Promise<void> {
    return this.requireOp(this.adapter?.setSignalSimulated, 'setSignalSimulated', 'its adapter has no signal simulation')
      .call(this.adapter, network, device, name, simulated);
  }

  /** End the simulation of every simulated signal, on both generations (RWS 1.0 built, not yet run). No hold is taken. */
  async unblockSignals(): Promise<void> {
    return this.requireOp(this.adapter?.unblockSignals, 'unblockSignals', 'its adapter has no signal unblock').call(this.adapter);
  }

  /**
   * Enable or disable an I/O device, on both generations (RWS 1.0 built from
   * ABB's page, not yet run; it names the device without its network). A
   * disabled device's signals are unavailable until it is enabled again. No
   * hold is taken: the controller decides.
   */
  async setIoDeviceLState(network: string, device: string, enable: boolean): Promise<void> {
    return this.requireOp(this.adapter?.setIoDeviceLState, 'setIoDeviceLState', 'its adapter has no device state write')
      .call(this.adapter, network, device, enable);
  }

  // ─── Program loading ─────────────────────────────────────────────────────────

  /**
   * Upload a single .mod / .sys file and load it into a task.
   *
   * Steps, in order, as one operation under one RAPID mastership (RobotWare
   * 6), `edit` (RobotWare 7) or write-access (RobotWare 8) hold:
   *   1. Read the RAPID execution state. While the program runs the load is
   *      refused (`WRONG_MODE`, `refusal.kind` `wrong-state`) and nothing is
   *      changed, unless `options.stopIfRunning` is true: then the program is
   *      stopped first. Up to 1.3.x the program was always stopped, silently.
   *   2. **If a module with the same name (= file basename without ext) is
   *      already loaded, unload it first.** Live-verified gotcha: passing
   *      `replace=true` to loadmod refreshes the *file* but the program's
   *      symbol table still references the OLD module's procedures, so
   *      `resetRapid()` afterwards reports "no main" even though the new
   *      file has one. Explicit unload + load fixes this.
   *   3. Upload the file to $HOME (or HOME/ on RWS 2.0 - adapter rewrites).
   *   4. loadModule the new file, and list the task's modules again.
   *   5. **If the new module declares `PROC main()`, set the program pointer
   *      to main** (detected by a regex over the file content), so the user
   *      can click Start at once; `options.resetPP: false` leaves the program
   *      pointer where it is.
   *   6. **Does NOT unload OTHER modules.** Old versions unloaded every
   *      non-system module, which destroyed the controller's pre-existing
   *      program (e.g. OmniCore's `Module1`).
   *
   * Every step's failure fails the call (up to 1.3.x a failed stop, module
   * list, unload or PP to main was ignored). The error keeps the failed step's
   * code, HTTP status and refusal, and its message starts with which step
   * failed and what was already done - for one, that the module was loaded
   * but the program pointer was not moved, or that the old module was unloaded
   * and the new one did not load. A local file that cannot be read, that is
   * not valid UTF-8, or that has no text throws `INVALID_ARGUMENT` before
   * anything is sent; the message of a file that is not UTF-8 names the line
   * of its first bad byte sequence. A byte order mark is sent as it is.
   *
   * A controller can load a module under another name: RobotWare 7.21.4
   * listed a module whose name clashed with one of its own names as
   * `<NAME>#2`. The report then names the module as the controller listed
   * it, from the list read after the load; when the load is refused or that
   * list was not read, the module list is read once more for it. A
   * successful load under another name is logged as a warning.
   */
  async loadProgram(
    localFilePath: string, taskName: string,
    options: { stopIfRunning?: boolean; resetPP?: boolean } = {},
  ): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;

    const fileName   = path.basename(localFilePath);
    const moduleName = fileName.replace(/\.(mod|sys)$/i, '');
    const remotePath = `$HOME/${fileName}`;
    let bytes: Uint8Array;
    try {
      bytes = fs.readFileSync(localFilePath);
    } catch (e) {
      throw new RwsError(
        `loadProgram: the file ${localFilePath} cannot be read (${e instanceof Error ? e.message : String(e)}). Nothing was sent to the controller.`,
        'INVALID_ARGUMENT');
    }
    // Up to 1.5.1 the file was read as 'utf8', which uploads U+FFFD in place
    // of every byte sequence that is not UTF-8 (see src/utf8.ts).
    const decoded = decodeUtf8Strict(bytes);
    if ('fault' in decoded) {
      const hex = decoded.fault.byte.toString(16).toUpperCase().padStart(2, '0');
      throw new RwsError(
        `loadProgram: the file ${localFilePath} is not valid UTF-8. Line ${decoded.fault.line} has a byte sequence that is not UTF-8, `
        + `starting with byte 0x${hex} (files saved as Windows-1252, Latin-1 or UTF-16 have such bytes). `
        + 'Save the file as UTF-8 and load it again. Nothing was sent to the controller.',
        'INVALID_ARGUMENT');
    }
    const content = decoded.text;
    // A file with no text holds no module, and loading it would first unload
    // the loaded module of the same name. trim() takes a byte order mark too.
    if (content.trim() === '') {
      throw new RwsError(
        `loadProgram: the file ${localFilePath} has no text, so it holds no module. Nothing was sent to the controller.`,
        'INVALID_ARGUMENT');
    }
    // Match `PROC main(` allowing whitespace + comments above.
    const setMain = options.resetPP !== false && /\bPROC\s+main\s*\(/i.test(content);

    // What the operation has done so far, and the step in progress, for the
    // message of a step that fails.
    const done: string[] = [];
    let step = 'get its turn and take mastership or write access';
    let running = false;
    // Set while a step that changes the program (unload, load) is on the wire.
    let changing = false;
    // The task's modules before the load, and whether the load was sent and
    // the modules listed after it: a module can be loaded under another name.
    let before: string[] = [];
    let loadSent = false;
    let listedAfterLoad = false;
    try {
      // One write in progress for the whole sequence, under one 'rapid' hold:
      // the adapter's own holds inside it (resetRapid's) are nested and do not
      // end it.
      await this.access(adapter).withAccess(['rapid'], async () => {
        step = 'read whether the RAPID program is running';
        if ((await adapter.getRapidExecutionState()) === 'running') {
          if (options.stopIfRunning !== true) {
            // Sent anyway; the controller decides, and a refusal is
            // explained as the running program (see programRunningRefusal).
            running = true;
          } else {
            step = 'stop the RAPID program';
            await adapter.stopRapid();
            done.push('stopped the RAPID program');
          }
        }

        step = `list the modules loaded in ${taskName}`;
        const existing = await adapter.listModules(taskName);
        before = existing;
        if (existing.includes(moduleName)) {
          step = `unload the loaded module ${moduleName} from ${taskName}`;
          changing = true;
          await adapter.unloadModule(taskName, moduleName);
          changing = false;
          done.push(`unloaded the old module ${moduleName} from ${taskName}`);
        }

        step = `upload ${fileName} to ${remotePath}`;
        await adapter.uploadFile(remotePath, content);
        done.push(`uploaded ${fileName} to ${remotePath}`);

        step = `load module ${moduleName} into ${taskName}`;
        changing = true;
        loadSent = true;
        await adapter.loadModule(taskName, remotePath, true);
        changing = false;
        done.push(`loaded module ${moduleName} into ${taskName}`);

        step = `list the modules loaded in ${taskName} after the load`;
        const after = await this.refreshTaskModules(taskName);
        listedAfterLoad = true;
        this.notify();
        const given = renamedOnLoad(moduleName, before, after);
        if (given !== null) {
          done[done.length - 1] = loadedAsSentence(moduleName, taskName, given);
          Logger.warn(`loadProgram: ${loadedAsSentence(moduleName, taskName, given)}`);
        }

        if (setMain) {
          step = 'set the program pointer to main';
          await adapter.resetRapid();
        }
      });
    } catch (caught) {
      // The old module's unload refused for a reason the controller wrote in
      // its event log: explained as unloadModule explains it.
      const e = changing && !loadSent ? await this.explainUnloadRefusal(adapter, taskName, moduleName, caught) : caught;
      // A load that failed, or whose module list was not read, may still
      // have loaded the module under another name: one list read says.
      if (loadSent && !listedAfterLoad) {
        const listed = await adapter.listModules(taskName).catch(() => null);
        const given = listed === null ? null : renamedOnLoad(moduleName, before, listed);
        if (given !== null) { done.push(loadedAsSentence(moduleName, taskName, given)); }
      }
      const report = done.length > 0
        ? `Done before it: ${done.join('; ')}.`
        : 'Nothing was changed on the controller before it.';
      if (running && changing && RobotManager.isStateLikeRefusal(e)) {
        throw this.programRunningRefusal(adapter, 'loadProgram', `It could not ${step}. ${report}`, e);
      }
      throw withReport(e, `loadProgram(${fileName} into ${taskName}) could not ${step}. ${report}`);
    }
  }

  /** @deprecated use loadProgram */
  uploadAndLoad(p: string, t: string) { return this.loadProgram(p, t); }

  /**
   * Unload a single RAPID module from a task. Useful for resolving a
   * `main`-proc collision: if two modules both define `PROC main()`, RWS
   * refuses PP-to-Main with a semantic error - unload one and the other
   * becomes the program's entry point.
   *
   * A running program is never stopped unasked: the execution state is read
   * first, and with `options.stopIfRunning` the program is stopped before the
   * unload (a failed stop fails the call). Without it the unload is sent
   * anyway (ABB: "Pre-requisites: None"), and a refusal while the program ran
   * is explained as such. Up to 1.3.x the call always sent a stop and ignored
   * its failure.
   *
   * A refusal of the unload request itself with -1073414145, whose text says
   * the reason is in the event log, carries the newest event-log message (one
   * read) and, when the held module list shows the module under a name the
   * controller gave it, that name. A refusal of any other request in the call
   * (the access request, the stop, the module-list read) keeps its own
   * explanation.
   */
  async unloadModule(taskName: string, moduleName: string, options: { stopIfRunning?: boolean } = {}): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    // True only while the unload request is out: its refusal, and no other,
    // may be explained from the event log.
    let unloading = false;
    try {
      await this.access(adapter).withAccess(['rapid'], async () => {
        const running = await this.stopIfAsked(adapter, options.stopIfRunning === true);
        try {
          unloading = true;
          await adapter.unloadModule(taskName, moduleName);
          unloading = false;
        } catch (e) {
          throw running ? this.programRunningRefusal(adapter, 'unloadModule', 'No module was unloaded.', e) : e;
        }
        await this.refreshTaskModules(taskName);
        this.notify();
      });
    } catch (e) {
      throw unloading ? await this.explainUnloadRefusal(adapter, taskName, moduleName, e) : e;
    }
  }

  /**
   * Unload the program from a task, the counterpart of a program load: ABB's
   * RWS 2.0 `POST .../program/unload` and RWS 1.0
   * `POST .../program?action=unloadprog` (no body on either). `unloadModule`
   * takes out one module only.
   *
   * Held under RAPID mastership (RobotWare 7: edit; RobotWare 8: write
   * access), as a load. A running program is never stopped unasked: the
   * execution state is read first, and with `options.stopIfRunning` the
   * program is stopped before the unload. Without it the unload is sent
   * anyway and the controller decides; a refusal while the program ran is
   * explained as such, as for `unloadModule`. The task's module list is read
   * again afterwards (`state.modulesByTask`). It takes out every program
   * module of the task and leaves the system modules: on RW 6.16.03 the
   * controller's own Module1 went with the module loaded before it, and RW
   * 7.21.4 and 8.2.1 kept BASE (2026-10-21).
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the adapter
   *   has no program unload; otherwise the controller's typed error.
   */
  async unloadProgram(taskName: string, options: { stopIfRunning?: boolean } = {}): Promise<void> {
    const op = this.requireOp(this.adapter?.unloadProgram, 'unloadProgram', 'its adapter has no program unload');
    const adapter = this.adapter as IRWSAdapter;
    await this.access(adapter).withAccess(['rapid'], async () => {
      const running = await this.stopIfAsked(adapter, options.stopIfRunning === true);
      try {
        await op.call(adapter, taskName);
      } catch (e) {
        throw running ? this.programRunningRefusal(adapter, 'unloadProgram', 'The program was not unloaded.', e) : e;
      }
      await this.refreshTaskModules(taskName);
      this.notify();
    });
  }

  /**
   * An unload the controller refused with -1073414145 and a text saying the
   * reason is in the event log ("Reason written in elog" on RW 7.21.4),
   * explained with what can be read without changing anything: the newest
   * message of the event log, which may be about something else (one read;
   * the sentence says when it cannot be read), and the renamed module the
   * held module list shows, when there is one (see renamedOnLoad). The code,
   * HTTP status and controller answer are kept. The code alone is generic
   * (ABB: SYS_CTRL_E_UNEXPECTED), so the same code with another text, and
   * any other error, is returned as it is. Callers pass only the unload
   * request's own error.
   */
  private async explainUnloadRefusal(adapter: IRWSAdapter, taskName: string, moduleName: string, e: unknown): Promise<unknown> {
    if (!(e instanceof RwsError) || e.controllerCode !== REASON_IN_EVENT_LOG) { return e; }
    if (!REASON_IN_EVENT_LOG_TEXT.test(e.controllerMsg ?? '')) { return e; }
    if (e.refusal && e.refusal.kind !== 'unknown') { return e; }
    let newest: ElogMessage | null = null;
    let logRead = true;
    try { newest = await newestEventLogMessage(adapter); } catch { logRead = false; }
    const listed = this._state.modulesByTask[taskName] ?? (taskName === this.activeTaskName() ? this._state.modules : []);
    const renamed = renamedOnLoad(moduleName, [], listed);
    const robot = this.refusalContextNow().robot;
    const parts = [`${robot ? `Controller '${robot}'` : 'The controller'} refused to unload module ${moduleName} from ${taskName} `
      + 'and wrote its reason in the event log.'];
    if (newest !== null) {
      const desc = (newest.desc ?? '').trim();
      parts.push(`The newest event-log message, which may not be about this unload, is ${newest.code} "${(newest.title ?? '').trim()}"${desc ? `: ${desc}` : '.'}`);
    } else {
      parts.push(logRead ? 'The event log has no message.' : 'The event log could not be read.');
    }
    if (renamed !== null) {
      parts.push(`The task lists the module as ${renamed}, the name the controller gave it on load; unload it by that name.`);
    }
    const sentence = parts.join(' ');
    const missing = 'not known to this client: the controller wrote the reason in its event log';
    // The newest message's own actions are not copied: it may be about
    // something else.
    const fix = renamed !== null
      ? `Unload the module by the name the task lists, ${renamed}.`
      : "Read the reason in the controller's event log.";
    const old = e.refusal;
    const generation = this.access(adapter).generation();
    // The reason is in the event log: read it there, or unload the module by
    // the name the controller gave it.
    const next = renamed !== null
      ? remedy.fixInput(generation, { detail: `Unload the module by the name the task lists, ${renamed}.`, evidence: 'vc' })
      : remedy.checkState(generation, { detail: "Read the reason in the controller's event log, then run the operation again.", evidence: 'vc' });
    // Stamped with the refusal it joins: its generation and its request.
    const stamped = {
      ...next,
      appliesTo: { ...next.appliesTo, generation: old ? old.generation : next.appliesTo.generation, ...(old?.controller.request ? { operation: old.controller.request } : {}) },
    };
    const refusal = old
      ? { ...old, missing, fix, sentence, remedy: stamped }
      : builtRefusal({
        kind: 'unknown', condition: 'unknown', generation, grantor: null,
        missing, fix, sentence, evidence: 'unverified', remedy: next,
      });
    // The old refusal's other ways were for its own explanation.
    delete refusal.otherRemedies;
    const message = old && e.message.startsWith(old.sentence)
      ? `${sentence}${e.message.slice(old.sentence.length)}`
      : `${sentence} Controller: ${e.message}`;
    return new RwsError(message, e.code, e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg, refusal, e.responseBody);
  }

  // ─── New verified endpoints (exposed for commands) ────────────────────────

  async getLicenseInfo() { return this.adapter?.getLicenseInfo?.() ?? { entries: [] }; }
  async listProducts()    { return this.adapter?.listProducts?.() ?? []; }
  /** The first robot's type in `type`, every robot's in `types` (MultiMove lists each); `{ type: '' }` when the adapter has no such read. */
  async getRobotType(): Promise<{ type: string; variant?: string; types?: string[] }> { return this.adapter?.getRobotType?.() ?? { type: '' }; }
  async getEnergyStats()  { return this.adapter?.getEnergyStats?.() ?? {}; }
  async getReturnCode(code: number, lang = 'en') { return this.adapter?.getReturnCode?.(code, lang) ?? null; }
  async listControllerOptions() { return this.adapter?.listControllerOptions?.() ?? []; }
  async listFeatures()    { return this.adapter?.listFeatures?.() ?? []; }
  async getMotionChangeCount() { return this.adapter?.getMotionChangeCount?.() ?? 0; }
  async getMotionErrorState()  { return this.adapter?.getMotionErrorState?.() ?? { state: 'unknown' }; }
  async getNonMotionExecution(){ return this.adapter?.getNonMotionExecution?.() ?? false; }
  /** Writes below never do nothing quietly: an adapter without the method refuses with UNSUPPORTED_OPERATION (see requireOp). */
  async setNonMotionExecution(enabled: boolean): Promise<void> {
    return this.requireOp(this.adapter?.setNonMotionExecution, 'setNonMotionExecution', 'its adapter has no non-motion execution write').call(this.adapter, enabled);
  }
  async getCollisionPredictionMode()      { return this.adapter?.getCollisionPredictionMode?.() ?? 'OFF'; }
  async setCollisionPredictionMode(m: string): Promise<void> {
    return this.requireOp(this.adapter?.setCollisionPredictionMode, 'setCollisionPredictionMode', 'its adapter has no collision-prediction write').call(this.adapter, m);
  }
  async getEnableRequest() { return this.adapter?.getEnableRequest?.() ?? { state: 'unknown', raw: {} }; }
  async listAliasIO()     { return this.adapter?.listAliasIO?.() ?? []; }
  /**
   * Every task and the ones the task panel has selected (state ON), from
   * `/rw/rapid/taskselection` on both generations (RWS 1.0 too: a RobotWare
   * 6.16.03 virtual controller answered it). The controller's refusal passes
   * through; an empty selection only when the adapter has no such read.
   */
  async getTaskSelection(){ return this.adapter?.getTaskSelection?.() ?? { selected: [], available: [] }; }
  async setTaskSelection(tasks: string[]): Promise<void> {
    return this.requireOp(this.adapter?.setTaskSelection, 'setTaskSelection', 'its adapter has no task-selection write').call(this.adapter, tasks);
  }
  async getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> { return this.adapter?.getProgramPointer?.(task) ?? {}; }
  /**
   * The task's motion pointer, from the entry ABB titles `motionpointer` in
   * the task's pcp resource on both generations; `{}` while the controller
   * reports no position, or when the adapter has no such read.
   */
  async getMotionPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> { return this.adapter?.getMotionPointer?.(task) ?? {}; }
  /**
   * One controller environment variable (`HOME`, `TEMP`, `SYSTEM`, ...; a
   * leading `$` is accepted), ABB's `GET /ctrl/${ENVNAME}` on both generations;
   * null when the adapter has no such read. An unknown name is the
   * controller's 404, passed through.
   */
  async getEnv(name: string): Promise<string | null> {
    if (!this.adapter?.getEnv) { return null; }
    return this.adapter.getEnv(name);
  }
  /**
   * Whether the controller hardware can run a RobotWare version: ABB's
   * `GET /ctrl/compatibility/{robotware version}` on both generations, real
   * controllers only (the virtual controllers answer 404). `compatible` is
   * the controller's `status`; a refusal is the controller's typed error,
   * never `compatible: false`. Without a version the adapter asks about the
   * version the controller runs, the `rwversion` of `GET /rw/system`, sent
   * as the controller wrote it. From an adapter of another make that answers
   * the 1.4.0 result, `{ compatible, details? }`, `details` is its details
   * (`{}` without them) and `status` its `details.status`, or `'true'` or
   * `'false'` from `compatible`.
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the
   *   adapter has no such read; `INVALID_ARGUMENT` for an empty version,
   *   before sending; otherwise the controller's typed error.
   */
  async getCompatibility(robotWareVersion?: string): Promise<RobotWareCompatibility> {
    const answer = await this.requireOp(this.adapter?.getCompatibility, 'getCompatibility', 'its adapter has no compatibility read')
      .call(this.adapter, robotWareVersion);
    if ('status' in answer && typeof answer.status === 'string' && answer.details) { return answer; }
    const details = answer.details ?? {};
    return { compatible: answer.compatible, status: details['status'] ?? String(answer.compatible), details };
  }

  // CFG
  async listCfgDomains()  { return this.adapter?.listCfgDomains?.() ?? []; }
  async listCfgTypes(d: string) { return this.adapter?.listCfgTypes?.(d) ?? []; }
  async listCfgInstances(d: string, t: string) { return this.adapter?.listCfgInstances?.(d, t) ?? []; }
  async getCfgInstance(d: string, t: string, i: string) { return this.adapter?.getCfgInstance?.(d, t, i) ?? {}; }
  // The CFG writes hold the configuration lock: CFG mastership on RobotWare 6
  // (they used to hold RAPID mastership there, which configuration writes do
  // not use), `edit` on RobotWare 7, write access on RobotWare 8. The adapters
  // in this package take the same hold themselves (this wrap then costs no
  // request); it also covers an adapter built outside this package.
  async setCfgInstance(d: string, t: string, i: string, attrs: Record<string, string>): Promise<void> {
    if (!this.adapter?.setCfgInstance) { throw new RwsError('setCfgInstance not supported', 'UNSUPPORTED_OPERATION'); }
    await this.withCfgAccess(() => this.adapter!.setCfgInstance!(d, t, i, attrs));
  }
  async createCfgInstance(d: string, t: string, i: string, attrs: Record<string, string>): Promise<void> {
    if (!this.adapter?.createCfgInstance) { throw new RwsError('createCfgInstance not supported', 'UNSUPPORTED_OPERATION'); }
    await this.withCfgAccess(() => this.adapter!.createCfgInstance!(d, t, i, attrs));
  }
  async removeCfgInstance(d: string, t: string, i: string): Promise<void> {
    if (!this.adapter?.removeCfgInstance) { throw new RwsError('removeCfgInstance not supported', 'UNSUPPORTED_OPERATION'); }
    await this.withCfgAccess(() => this.adapter!.removeCfgInstance!(d, t, i));
  }
  async loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset' = 'add'): Promise<void> {
    if (!this.adapter?.loadCfgFile) { throw new RwsError('loadCfgFile not supported', 'UNSUPPORTED_OPERATION'); }
    await this.withCfgAccess(() => this.adapter!.loadCfgFile!(filepath, action));
  }
  async saveCfgFile(domain: string, filepath: string): Promise<void> {
    if (!this.adapter?.saveCfgFile) { throw new RwsError('saveCfgFile not supported', 'UNSUPPORTED_OPERATION'); }
    await this.withCfgAccess(() => this.adapter!.saveCfgFile!(domain, filepath));
  }

  private async withCfgAccess<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.access(this.adapter).withAccess(['cfg'], fn);
  }

  // Backup / restore
  async listBackups()      { return this.adapter?.listBackups?.() ?? []; }
  async createBackup(n: string) {
    if (!this.adapter?.createBackup) { throw new RwsError('createBackup not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.createBackup(n);
  }
  async restoreBackup(n: string, opts?: { deleteBackup?: boolean }) {
    if (!this.adapter?.restoreBackup) { throw new RwsError('restoreBackup not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.restoreBackup(n, opts);
  }
  /**
   * Check that a backup can be restored, without restoring it (RWS 2.0
   * `POST /ctrl/backup/check-restore`; RWS 1.0 `GET
   * /ctrl/backup?action=check-restore&backup=...`, as ABB's RWS 1.0 manual
   * documents and RW 6.16.03 answered on 2026-10-10). Resolves when the
   * controller accepts the backup.
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the adapter
   *   has no check; otherwise the adapter's typed error.
   */
  async checkRestore(name: string): Promise<void> {
    return this.requireOp(this.adapter?.checkRestore, 'checkRestore', 'its adapter has no backup check').call(this.adapter, name);
  }
  async getBackupStatus(): Promise<{ active: boolean; progress?: number; phase?: string; failed?: boolean }> { return this.adapter?.getBackupStatus?.() ?? { active: false }; }

  // Common reads on both generations (2026-10-01). Each answers an empty value
  // when the adapter lacks the read (an adapter built outside this package),
  // as the other optional reads here do; the controller's refusals pass through.
  /** One RAPID task's state and properties; `{}` when the adapter has no such read. */
  async getRapidTask(task: string): Promise<Record<string, string>> {
    if (!this.adapter?.getRapidTask) { return {}; }
    return this.adapter.getRapidTask(task);
  }
  /** One configuration type's attribute and instance counts; null when the adapter has no such read. */
  async getCfgType(domain: string, type: string): Promise<CfgTypeInfo | null> {
    if (!this.adapter?.getCfgType) { return null; }
    return this.adapter.getCfgType(domain, type);
  }
  /** The attribute definitions of a configuration type; `[]` when the adapter has no such read. */
  async listCfgTypeAttributes(domain: string, type: string): Promise<Array<Record<string, string>>> {
    if (!this.adapter?.listCfgTypeAttributes) { return []; }
    return this.adapter.listCfgTypeAttributes(domain, type);
  }
  /** A DIPC queue's information; null when the queue does not exist or the adapter has no such read. */
  async getDipcQueueInfo(queue: string): Promise<DipcQueueInfo | null> {
    if (!this.adapter?.getDipcQueueInfo) { return null; }
    return this.adapter.getDipcQueueInfo(queue);
  }
  /** One I/O network; `{}` when the adapter has no such read. */
  async getIoNetwork(network: string): Promise<Record<string, string>> {
    if (!this.adapter?.getIoNetwork) { return {}; }
    return this.adapter.getIoNetwork(network);
  }
  /** One I/O device (RWS 1.0 ignores `network`); `{}` when the adapter has no such read. */
  async getIoDeviceInfo(network: string, device: string): Promise<Record<string, string>> {
    if (!this.adapter?.getIoDeviceInfo) { return {}; }
    return this.adapter.getIoDeviceInfo(network, device);
  }
  /** One signal's configuration (`ios-signal-config-general`); `{}` when the adapter has no such read. */
  async getSignalConfig(network: string, device: string, name: string): Promise<Record<string, string>> {
    if (!this.adapter?.getSignalConfig) { return {}; }
    return this.adapter.getSignalConfig(network, device, name);
  }
  /** One I/O network's configuration; `{}` when the adapter has no such read. */
  async getIoNetworkConfig(network: string): Promise<Record<string, string>> {
    if (!this.adapter?.getIoNetworkConfig) { return {}; }
    return this.adapter.getIoNetworkConfig(network);
  }
  /** One I/O device's configuration (RWS 1.0 ignores `network`); `{}` when the adapter has no such read. */
  async getIoDeviceConfig(network: string, device: string): Promise<Record<string, string>> {
    if (!this.adapter?.getIoDeviceConfig) { return {}; }
    return this.adapter.getIoDeviceConfig(network, device);
  }
  /** The routines of one module; `[]` when the adapter has no such read. */
  async listModuleRoutines(task: string, moduleName: string): Promise<RapidRoutineInfo[]> {
    if (!this.adapter?.listModuleRoutines) { return []; }
    return this.adapter.listModuleRoutines(task, moduleName);
  }
  /** A file's metadata without downloading it; null when the adapter has no such read. */
  async getFileMetadata(path: string): Promise<FileMetadata | null> {
    if (!this.adapter?.getFileMetadata) { return null; }
    return this.adapter.getFileMetadata(path);
  }

  // Niche reads on both generations (2026-10-01), same shape as the common
  // reads above: an empty value when the adapter lacks the read, the
  // controller's refusals passed through.
  /**
   * The subscription groups of the adapter's session (the manager's own group
   * included; its path is `subscriptionGroupPath`). The list is per session, so
   * it finds a group a crashed caller left behind only when the restarted caller
   * reuses that session's cookie. `[]` when the adapter has no such read.
   */
  async listSubscriptionGroups(): Promise<SubscriptionGroupInfo[]> {
    if (!this.adapter?.listSubscriptionGroups) { return []; }
    return this.adapter.listSubscriptionGroups();
  }
  /** The resources bound to one group (id or `/subscription/{id}`); `[]` when the adapter has no such read. */
  async getSubscriptionGroup(group: string): Promise<SubscriptionGroupMember[]> {
    if (!this.adapter?.getSubscriptionGroup) { return []; }
    return this.adapter.getSubscriptionGroup(group);
  }
  /** Motion (jog) supervision of a mechunit; null when the adapter has no such read. */
  async getMotionSupervision(mechunit?: string): Promise<MotionSupervisionState | null> {
    if (!this.adapter?.getMotionSupervision) { return null; }
    return this.adapter.getMotionSupervision(mechunit);
  }
  /** Path supervision of a mechunit; null when the adapter has no such read. */
  async getPathSupervision(mechunit?: string): Promise<PathSupervisionState | null> {
    if (!this.adapter?.getPathSupervision) { return null; }
    return this.adapter.getPathSupervision(mechunit);
  }
  /** A mechunit's SMB data; `{}` when the adapter has no such read. */
  async getMechunitSmbData(mechunit?: string): Promise<Record<string, string>> {
    if (!this.adapter?.getMechunitSmbData) { return {}; }
    return this.adapter.getMechunitSmbData(mechunit);
  }
  /** A mechunit's motor calibration names; `[]` when the adapter has no such read. */
  async getMechunitMotorCalib(mechunit?: string): Promise<MechunitMotorCalib[]> {
    if (!this.adapter?.getMechunitMotorCalib) { return []; }
    return this.adapter.getMechunitMotorCalib(mechunit);
  }
  /** A mechunit's compliance lead-through state; null when the adapter has no such read. */
  async getLeadThrough(mechunit?: string): Promise<LeadThroughState | null> {
    if (!this.adapter?.getLeadThrough) { return null; }
    return this.adapter.getLeadThrough(mechunit);
  }

  // Module info / source / symbols / service-routine / tool-wobj activation
  // (getModuleSource, listModuleSymbols, calcCartesianFromJoints already
  // defined further below in this file.)
  async getModuleInfo(task: string, moduleName: string): Promise<Record<string, string>> {
    if (!this.adapter?.getModuleInfo) { return {}; }
    return this.adapter.getModuleInfo(task, moduleName);
  }
  /** The task's service routines (name and routine URL, `RAPID/{task}/{module}/{routine}`),
   *  from GET /rw/rapid/tasks/{task}/serviceroutine on both generations. [] on an
   *  adapter without the read. Run one with `setPPToRoutine` and a start. */
  async listServiceRoutines(task: string): Promise<Array<{ name: string; url: string }>> {
    return this.adapter?.listServiceRoutines?.(task) ?? [];
  }
  /** RWS has no operation that calls a service routine: on RWS 2.0 the adapter
   *  throws `UNSUPPORTED_OPERATION` before sending. Set the program pointer to
   *  the routine (`setPPToServiceRoutine`) and start instead. */
  async callServiceRoutine(task: string, routineName: string, args?: Record<string, string>): Promise<void> {
    if (!this.adapter?.callServiceRoutine) { throw new RwsError('callServiceRoutine not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.callServiceRoutine(task, routineName, args);
  }

  /**
   * Set the program pointer to a service routine, for the caller to start.
   * The controller decides the mode: for a remote client ABB documents
   * PP to routine in Auto on RobotWare 6 and 7 (RWS 1.0 manual, PP to
   * routine: "Controller needs to be in auto mode"; RobotWare 7: "Allowed
   * operator mode AUTO", in manual only with RMMP exec), and the Execute
   * program grant covers "Execute service routines" with no mode (RobotStudio
   * operating manual 3HAC032104-001 Rev BC §18.2). RobotWare 8.2.1 in MANR
   * with write access accepted it (2026-10-12). A refusal is explained per
   * generation.
   *
   * 1. The operating mode is read. One case is held back before anything is
   *    sent: RobotWare 8 in Auto, where no run has shown the move to a
   *    service routine works. That is the client's own hold, until a run
   *    shows it does.
   * 2. The task's service-routine listing is read (`listServiceRoutines`).
   *    A routine not in it is refused (`INVALID_ARGUMENT`) and nothing more
   *    is sent. `moduleName`, when given, must match the module of the listed
   *    routine; when omitted it is taken from the listed routine's URL
   *    (`RAPID/{task}/{module}/{routine}`).
   * 3. `setPPToRoutine(task, module, routine, options)`: its execution-state
   *    check and holds apply unchanged.
   *
   * `setPPToRoutine` itself has no mode rule: moving the pointer to an
   * ordinary routine in automatic mode is normal use.
   */
  async setPPToServiceRoutine(task: string, routineName: string, moduleName?: string, options: { stopIfRunning?: boolean } = {}): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    const op = 'setPPToServiceRoutine';
    const mode = String(await adapter.getOperationMode()).trim().toUpperCase();
    const generation = this.access(adapter).generation();
    if (generation === 'rw8' && mode === 'AUTO') {
      const fix = 'Move the pointer to the service routine at the FlexPendant, or from this tool in manual mode (MANR or MANF) with write access.';
      throw refusalError('WRONG_MODE', {
        kind: 'wrong-state', condition: 'operating-mode', generation, grantor: 'key-switch',
        missing: 'a manual operating mode (MANR or MANF) on RobotWare 8', fix,
        sentence: `${op}: not sent on RobotWare 8 in Auto: no run has shown a pointer move to a service routine works there. ${fix} The program pointer was not moved.`,
        evidence: 'vc',
        remedy: remedy.doAtPendant(generation, { detail: 'Move the program pointer to the service routine at the FlexPendant.', evidence: 'vc' }),
        otherRemedies: [remedy.mode(generation, 'MANR', {
          detail: 'Someone at the controller switches to manual reduced speed (MANR); this tool then moves the pointer with write access.',
        })],
      });
    }
    if (!adapter.listServiceRoutines) {
      throw new RwsError(`${op}: this adapter cannot list service routines. The program pointer was not moved.`, 'UNSUPPORTED_OPERATION');
    }
    const listed = await adapter.listServiceRoutines(task);
    const want = routineName.trim().toUpperCase();
    const wantModule = moduleName?.trim().toUpperCase();
    const moduleOf = (url: string): string => {
      const seg = url.split('/').filter(Boolean);
      return seg.length >= 4 ? seg[seg.length - 2] : '';
    };
    const hit = listed.find(r => r.name.trim().toUpperCase() === want
      && (!wantModule || moduleOf(r.url).toUpperCase() === wantModule));
    if (!hit) {
      const where = moduleName ? `${routineName} in module ${moduleName}` : routineName;
      throw new RwsError(
        `${op}: ${where} is not in the service-routine listing of task ${task} `
        + `(${listed.length ? `listed: ${listed.map(r => r.name).join(', ')}` : 'the listing read empty'}). The program pointer was not moved.`,
        'INVALID_ARGUMENT');
    }
    await this.setPPToRoutine(task, moduleName ?? moduleOf(hit.url), hit.name, options);
  }
  async setActiveTool(mechunit: string, toolName: string): Promise<void> {
    if (!this.adapter?.setActiveTool) { throw new RwsError('setActiveTool not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.setActiveTool(mechunit, toolName);
  }
  async setActiveWobj(mechunit: string, wobjName: string): Promise<void> {
    if (!this.adapter?.setActiveWobj) { throw new RwsError('setActiveWobj not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.setActiveWobj(mechunit, wobjName);
  }

  // DIPC - Distributed Inter-Process Communication. Lets RAPID and external
  // clients exchange typed messages through named queues.
  async listDipcQueues() {
    if (!this.adapter?.listDipcQueues) { return []; }
    return this.adapter.listDipcQueues();
  }
  async createDipcQueue(name: string, options?: { maxsize?: number; maxmessages?: number }) {
    if (!this.adapter?.createDipcQueue) { throw new RwsError('DIPC not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.createDipcQueue(name, options);
  }
  async sendDipcMessage(queue: string, payload: string, type: 'string' | 'num' | 'dnum' | 'bool' = 'string') {
    if (!this.adapter?.sendDipcMessage) { throw new RwsError('DIPC not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.sendDipcMessage(queue, payload, type);
  }
  async readDipcMessage(queue: string, timeoutMs?: number) {
    if (!this.adapter?.readDipcMessage) { throw new RwsError('DIPC not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.readDipcMessage(queue, timeoutMs);
  }
  async removeDipcQueue(name: string) {
    if (!this.adapter?.removeDipcQueue) { throw new RwsError('DIPC not supported', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.removeDipcQueue(name);
  }

  // File volumes (HOME, BACKUP, DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP)
  async listFileVolumes(): Promise<string[]> {
    if (!this.adapter?.listFileVolumes) { return ['HOME']; }   // safe default
    return this.adapter.listFileVolumes();
  }

  /**
   * Compress a controller file or directory into an archive, both
   * generations. The controller answers 202 and builds the archive after
   * that: this resolves at the 202 and returns nothing, as in 1.4.0. To wait
   * for the archive, start it with `startJob('compressPath', source,
   * destination)`, which returns the job's progress id.
   */
  async compressPath(source: string, destination: string): Promise<void> {
    if (!this.adapter?.compressPath) { throw new RwsError('Compress not supported on this protocol', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.compressPath(source, destination);
  }

  /**
   * Start a controller job and return its progress id, both generations:
   * `compressPath` or `decompressPath`, the same request as that method. The
   * controller answers 202 and runs the job after that; the id comes from
   * the `Location: /progress/{id}` header ABB documents. To wait, poll
   * `getProgress(id)` until its `state` is no longer `pending` (ABB's
   * finished state is `ready`); `details.code` is then the controller's
   * return code, negative when the job failed. `undefined` when the answer
   * names no job, and from an adapter of another make that has no
   * `startJob`: the job's own method then starts it.
   *
   * @throws RwsError `INVALID_ARGUMENT` for a name that is not one of these
   *   jobs (`CONTROLLER_JOB_NAMES`); `NOT_CONNECTED`, also once
   *   `disconnect()` began; `UNSUPPORTED_OPERATION` when the adapter can
   *   start neither; nothing is sent for these. Otherwise the controller's
   *   typed error.
   */
  async startJob(name: ControllerJobName, source: string, destination: string): Promise<string | undefined> {
    const job = controllerJobName(name, 'startJob');
    const adapter = this.sessionAdapter(`startJob('${job}')`);
    if (adapter.startJob) { return adapter.startJob(job, source, destination); }
    await this.requireOp(adapter[job], job, 'its adapter has no such job').call(adapter, source, destination);
    return undefined;
  }

  /**
   * One controller job (compress, decompress, backup) by the progress id
   * `startJob` returned, GET /progress/{id}. `null`
   * when the controller refuses the read or names no such job.
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the
   *   adapter has no progress read.
   */
  async getProgress(id: string): Promise<{ state: string; details?: Record<string, string> } | null> {
    return this.requireOp(this.adapter?.getProgress, 'getProgress', 'its adapter has no progress read').call(this.adapter, id);
  }

  // Tool/WObj
  async getActiveTool(m?: string)    { return this.adapter?.getActiveTool?.(m) ?? { name: '' }; }
  async getActiveWobj(m?: string)    { return this.adapter?.getActiveWobj?.(m) ?? { name: '' }; }
  async getActivePayload(m?: string) { return this.adapter?.getActivePayload?.(m) ?? { name: '' }; }

  // Vision/Safety/VirtualTime
  async listVisionSystems() { return this.adapter?.listVisionSystems?.() ?? []; }
  async getSafetyStatus()   { return this.adapter?.getSafetyStatus?.() ?? { state: 'unavailable' }; }
  async getVirtualTime()    { return this.adapter?.getVirtualTime?.() ?? { time: 0, running: false }; }
  /** RobotWare 6: refused before sending by the RWS 1.0 adapter (the client sends no virtual-time write there in this release, although ABB documents one). RobotWare 7 and 8: sent. */
  async setVirtualTimeScale(s: number): Promise<void> {
    return this.requireOp(this.adapter?.setVirtualTimeScale, 'setVirtualTimeScale', 'its adapter has no virtual-time scale write').call(this.adapter, s);
  }
  /**
   * Sends nothing and throws `UNSUPPORTED_OPERATION`, connected or not: pause
   * and resume the virtual clock from RobotStudio's Simulation tab.
   * @deprecated Kept so code written for 1.3.x still compiles; removed at the next major version (2.0).
   */
  async setVirtualTimeRunning(_running: boolean): Promise<void> {
    throw virtualTimeRunningUnsupported();
  }

  // Mechunit details
  async getMechunitBaseFrame(m?: string) { return this.adapter?.getMechunitBaseFrame?.(m) ?? null; }
  async getMechunitAxes(m?: string)      { return this.adapter?.getMechunitAxes?.(m) ?? []; }
  async getMechunitInfo(m?: string)      { return this.adapter?.getMechunitInfo?.(m) ?? {}; }

  // ─── Motion reads for an external sampler (2026-09-25) ──────────────────────
  // Joint positions are not subscribable on any generation (checked live
  // 2026-09-23), so a consumer that wants them live polls these. Each is ONE
  // request on this manager's own session, so the session's request spacing
  // (>=100 ms) keeps the sampler and this manager's own polling together under
  // the controller's <20 req/s ceiling. Unlike the neutral-value reads above,
  // these THROW when not connected: a sampler must see "no data", never a
  // plausible-looking empty value.
  //
  // "Not connected" includes a teardown in progress (see sessionAdapter): a
  // read issued while disconnect() is releasing mastership or logging out
  // would otherwise queue behind /logout, and a request on a logged-out
  // session makes the controller open a new one that nobody logs out.

  /**
   * The adapter, but only while this manager's session is up and no teardown
   * has started - else NOT_CONNECTED. `_state.connected` alone is not enough:
   * disconnectInternal() resets it only as its last step, after /logout.
   */
  private sessionAdapter(what: string): IRWSAdapter {
    if (!this.adapter || !this._state.connected || this.sessionEpoch !== this.connectEpoch) {
      throw new RwsError(`${what}: not connected`, 'NOT_CONNECTED');
    }
    return this.adapter;
  }

  /**
   * Every axis slot of one mechanical unit: `rax_1..rax_6` and `eax_a..eax_f`,
   * in degrees (revolute) / mm (prismatic) as RWS reports them. Both
   * generations. `9E9` marks an absent axis (`isJointValuePresent`), but unused
   * slots may also read 0 - which slots a unit uses comes from
   * `getMechunitDetails()`, see `JointTargetFull`.
   * Throws NOT_CONNECTED, UNSUPPORTED_OPERATION (adapter without it), or the
   * read's own RwsError (PARSE_ERROR when a robot axis field is missing).
   */
  async getJointTargetFull(mechunit = 'ROB_1'): Promise<JointTargetFull> {
    const adapter = this.sessionAdapter('getJointTargetFull');
    if (!adapter.getJointTargetFull) {
      throw new RwsError('getJointTargetFull is not available on this adapter', 'UNSUPPORTED_OPERATION');
    }
    return adapter.getJointTargetFull(mechunit);
  }

  /**
   * TCP pose + configuration of a mechanical unit (`/cartesian`: x/y/z in mm,
   * q1..q4, cf1/cf4/cf6/cfx as j1/j4/j6/jx). Both generations; one request.
   * The adapter method was already on `IRWSAdapter`; this exposes it without
   * going through the polled `RobotState`. Throws NOT_CONNECTED.
   */
  async getCartesianFull(mechunit = 'ROB_1'): Promise<CartesianFull> {
    return this.sessionAdapter('getCartesianFull').getCartesianFull(mechunit);
  }

  /**
   * A mechanical unit's own description, typed: unit type (e.g. `TCPRobot`),
   * axis count (`axes`, `axesTotal`), the RAPID task that drives it, mode,
   * status, active tool/wobj, coordinate system. One request
   * (`GET /rw/motionsystem/mechunits/{unit}`), both generations - the RW 6 JSON
   * spellings (`task`, `*-unitname`) are normalised. Fields the
   * controller did not send are null; `raw` keeps the resource as received.
   * Throws NOT_CONNECTED or UNSUPPORTED_OPERATION (adapter without
   * getMechunitInfo), PARSE_ERROR when the response carried none of the
   * fields above (no `ms-mechunit` block: garbled or truncated), else the
   * read's own RwsError.
   */
  async getMechunitDetails(mechunit = 'ROB_1'): Promise<MechunitDetails> {
    const adapter = this.sessionAdapter('getMechunitDetails');
    if (!adapter.getMechunitInfo) {
      throw new RwsError('getMechunitDetails is not available on this adapter', 'UNSUPPORTED_OPERATION');
    }
    const details = toMechunitDetails(mechunit, await adapter.getMechunitInfo(mechunit));
    // Both adapters answer {} when the block is missing (RWS 2.0 getState, RWS
    // 1.0 a null state), and an all-null description is not a description: a
    // caller that caches it would treat the unit as typeless and axis-less for
    // the whole connection, with no error to show. Same rule as structural cell
    // S12 (requireState): a response without its block is PARSE_ERROR. Single
    // missing fields stay null.
    const described = Object.entries(details).some(([k, v]) => k !== 'name' && k !== 'raw' && v !== null);
    if (!described) {
      throw new RwsError(
        `getMechunitDetails(${mechunit}): response carried no ms-mechunit fields - unparseable or truncated`,
        'PARSE_ERROR',
      );
    }
    return details;
  }

  // ─── Reads by name (1.5.0) ──────────────────────────────────────────────────

  /**
   * One read of the connected adapter, by its name, for the reads that have
   * no manager method of their own: the event-log message reads and the
   * domain list, the RobotWare 8 control-station reads, the logged-in user's
   * grants and a return code with its severity. `AdapterReads` lists each
   * one's arguments, answer and generation. The adapter's own method runs on
   * the manager's session, and its answer and errors pass through unchanged.
   *
   * ```ts
   * const type = await manager.read('getControlStationType');
   * const message = await manager.read('getEventLogMessage', 0, 1234);
   * ```
   *
   * @throws RwsError `INVALID_ARGUMENT` for a name that is not one of these
   *   reads; `NOT_CONNECTED`, also once `disconnect()` began;
   *   `UNSUPPORTED_OPERATION` when the adapter has no such read (RobotWare 6
   *   has no control stations, for one), nothing sent; otherwise the read's
   *   own error.
   */
  async read<K extends AdapterReadName>(name: K, ...args: Parameters<AdapterReads[K]>): Promise<Awaited<ReturnType<AdapterReads[K]>>> {
    if (!isAdapterReadName(name)) {
      throw new RwsError(`read: ${JSON.stringify(name)} is not one of the reads RobotManager.read takes (${ADAPTER_READ_NAMES.join(', ')})`, 'INVALID_ARGUMENT');
    }
    const adapter = this.sessionAdapter(`read('${name}')`);
    const fn = (adapter as unknown as Partial<Record<AdapterReadName, (...a: unknown[]) => Promise<unknown>>>)[name];
    if (typeof fn !== 'function') {
      throw new RwsError(`read('${name}') is not available on this controller's adapter; nothing was sent`, 'UNSUPPORTED_OPERATION');
    }
    return fn.apply(adapter, args) as Promise<Awaited<ReturnType<AdapterReads[K]>>>;
  }

  /**
   * RobotWare 8: ask the control station that holds write access to release
   * it (ABB's `POST /rw/controlstation/writeaccess/release/appeal`, no body).
   * The holder decides; follow the answer with
   * `read('getWriteAccessAppealChangeCount')` and `getWriteAccessStatus()`.
   * A write of its own, so not one of `read`'s reads; it takes no write
   * access. ABB lists "Registered as a Control station" as its prerequisite,
   * so the adapter registers this session as a control station first when it
   * is not yet, as for `setAllowMotionControl`, and a -1073435871 answer
   * registers once and appeals once more. RW 8.2.1 answered it 204 from a
   * registered session with nobody holding write access, and the appeal
   * count went from 0 to 1 (2026-10-12).
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the adapter
   *   has no such write (RWS 1.0); otherwise the controller's typed error
   *   (RobotWare 7 answers 404).
   */
  async appealWriteAccessRelease(): Promise<void> {
    const adapter = this.adapter as (IRWSAdapter & { appealWriteAccessRelease?: () => Promise<void> }) | null;
    return this.requireOp(adapter?.appealWriteAccessRelease, 'appealWriteAccessRelease', 'RobotWare 8 only (control stations)').call(adapter);
  }

  // Task details
  async getTaskStructuralChangeCount(t: string) { return this.adapter?.getTaskStructuralChangeCount?.(t) ?? 0; }
  async getTaskMotion(t: string)            { return this.adapter?.getTaskMotion?.(t) ?? {}; }
  async getTaskActivationRecord(t: string)  { return this.adapter?.getTaskActivationRecord?.(t) ?? {}; }
  async getTaskProgramInfo(t: string)       { return this.adapter?.getTaskProgramInfo?.(t) ?? {}; }

  // Module
  async getModuleSource(t: string, n: string) { return this.adapter?.getModuleSource?.(t, n) ?? ''; }
  async listModuleSymbols(t: string, n: string) { return this.adapter?.listModuleSymbols?.(t, n) ?? []; }

  // ─── Endpoint-completion surface (2026-08-09) ───────────────────────────────
  // Most endpoints below are RWS 2.0 only: their paths answer 404 on the IRC5
  // controllers, or ABB documents an RWS 1.0 form this client does not wrap
  // (each such write names it). Those with an RWS 1.0 form say so. Reads
  // degrade to a neutral value the way the rest of this class does; WRITES
  // throw instead, because a write that silently does nothing is worse than
  // one that fails loudly.

  /** Throw a typed error rather than let a write no-op on a controller that lacks it. */
  private requireOp<T>(op: T | undefined, name: string, why = 'RWS 2.0 only'): NonNullable<T> {
    if (!this.adapter) {
      throw new RwsError(`${name}: not connected`, 'NOT_CONNECTED');
    }
    if (op === undefined || op === null) {
      throw new RwsError(
        `${name} is not available on this controller (${why})`,
        'UNSUPPORTED_OPERATION',
      );
    }
    return op as NonNullable<T>;
  }

  // Panel / controller
  async setPanelLanguage(code: string): Promise<void> {
    return this.requireOp(this.adapter?.setPanelLanguage, 'setPanelLanguage').call(this.adapter, code);
  }
  async setControllerLanguage(lang: string): Promise<void> {
    return this.requireOp(this.adapter?.setControllerLanguage, 'setControllerLanguage').call(this.adapter, lang);
  }
  /** Simulated external e-stop circuit (RWS 2.0, virtual controllers): `on` closes it, `off` opens it (stop active); `active` / `reset` map to off / on. */
  async setExternalEmergencyStop(state: 'on' | 'off' | 'active' | 'reset'): Promise<void> {
    return this.requireOp(this.adapter?.setExternalEmergencyStop, 'setExternalEmergencyStop').call(this.adapter, state);
  }
  /**
   * Motors on without the key switch (Keyless Mode Switch option), on both
   * generations. RWS 2.0 posts to `/rw/panel/ctrl-state/keyless-motoron`.
   * RWS 1.0 posts to `/rw/cfg?action=keyless` (ABB Rev M; 204 on a RobotWare
   * 6.16.03 virtual controller). The adapter holds the access a motors-on
   * takes (RobotWare 6: RAPID mastership, 7: `edit`, 8: write access); the
   * controller decides whether the option is there.
   */
  async setKeylessMotorOn(): Promise<void> {
    return this.requireOp(this.adapter?.setKeylessMotorOn, 'setKeylessMotorOn', 'its adapter has no keyless motors-on').call(this.adapter);
  }

  // In-place module source editing (the read side is getModuleText/…Range)
  async setModuleText(task: string, module: string, text: string, path?: string): Promise<void> {
    return this.requireOp(this.adapter?.setModuleText, 'setModuleText').call(this.adapter, task, module, text, path);
  }
  async setModuleTextRange(
    task: string, module: string,
    range: { startRow: number; startCol: number; endRow: number; endCol: number },
    text: string,
    opts?: { replaceMode?: string; queryMode?: string },
  ): Promise<void> {
    return this.requireOp(this.adapter?.setModuleTextRange, 'setModuleTextRange')
      .call(this.adapter, task, module, range, text, opts);
  }

  // I/O and CFG
  async searchSignalsEx(criteria: SignalSearchExCriteria[]): Promise<Signal[]> {
    return this.requireOp(this.adapter?.searchSignalsEx, 'searchSignalsEx').call(this.adapter, criteria);
  }
  async validateCfgInstances(request: CfgValidateRequest): Promise<boolean> {
    return this.requireOp(this.adapter?.validateCfgInstances, 'validateCfgInstances').call(this.adapter, request);
  }

  // ─── Endpoint-completion surface (2026-08-11) - both generations ────────────
  // These answer on BOTH protocols, so both concrete adapters implement them and
  // `requireOp` only ever guards the not-connected case (its unsupported branch
  // is unreachable here). Forwarded so consumers reaching the client through
  // RobotManager (e.g. the VS Code extension via MultiRobotManager) can call the
  // read/search side, not only the write side that was already wired.
  async searchSignals(criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Promise<Signal[]> {
    return this.requireOp(this.adapter?.searchSignals, 'searchSignals').call(this.adapter, criteria);
  }
  async searchIoDevices(criteria: { name?: string; lstate?: 'enabled' | 'disabled' | 'unknown'; network?: string }): Promise<IoDevice[]> {
    return this.requireOp(this.adapter?.searchIoDevices, 'searchIoDevices').call(this.adapter, criteria);
  }
  async renameFile(path: string, newName: string): Promise<void> {
    return this.requireOp(this.adapter?.renameFile, 'renameFile').call(this.adapter, path, newName);
  }
  async getModuleText(task: string, module: string): Promise<{ text: string; changeCount: number }> {
    return this.requireOp(this.adapter?.getModuleText, 'getModuleText').call(this.adapter, task, module);
  }
  async getModuleTextRange(task: string, module: string, startRow: number, startCol: number, endRow: number, endCol: number): Promise<string> {
    return this.requireOp(this.adapter?.getModuleTextRange, 'getModuleTextRange')
      .call(this.adapter, task, module, startRow, startCol, endRow, endCol);
  }
  async checkMotionChangeCount(changecount: number): Promise<boolean> {
    return this.requireOp(this.adapter?.checkMotionChangeCount, 'checkMotionChangeCount').call(this.adapter, changecount);
  }
  async saveEventLogRaw(destination: string): Promise<void> {
    return this.requireOp(this.adapter?.saveEventLogRaw, 'saveEventLogRaw').call(this.adapter, destination);
  }
  /** Resolves at the controller's 202; `startJob('decompressPath', ...)` returns the job's progress id. */
  async decompressPath(source: string, destination: string): Promise<void> {
    return this.requireOp(this.adapter?.decompressPath, 'decompressPath').call(this.adapter, source, destination);
  }
  async getVirtualTimeTimeslice(): Promise<number> {
    return this.requireOp(this.adapter?.getVirtualTimeTimeslice, 'getVirtualTimeTimeslice').call(this.adapter);
  }
  /**
   * Validate a configuration file on the controller without loading it (a
   * load dry-run). Both generations: RWS 1.0 through the CFG collection's
   * validate action, RWS 2.0 through POST /rw/cfg/validate (a well-formed
   * file passed and a malformed one was refused on RW 6.16.03, 7.21.4 and
   * 8.2.1, 2026-10-01). Throws a typed `RwsError`
   * when the controller refuses the file or its answer is not recognised as a pass.
   */
  async validateCfgFile(filepath: string, actionType: 'add' | 'replace' | 'add-with-reset' = 'add'): Promise<void> {
    return this.requireOp(this.adapter?.validateCfgFile, 'validateCfgFile').call(this.adapter, filepath, actionType);
  }
  /** RWS 1.0 only - throws UNSUPPORTED_OPERATION on OmniCore. */
  async validateInstanceBeforeDelete(name: string): Promise<void> {
    return this.requireOp(this.adapter?.validateInstanceBeforeDelete, 'validateInstanceBeforeDelete').call(this.adapter, name);
  }

  // Motion
  async getCollisionPredictionModelName(robotNumber = 0): Promise<string> {
    return this.adapter?.getCollisionPredictionModelName?.(robotNumber) ?? '';
  }
  async saveCollisionAvoidanceSnapshot(filePath: string, motionGroup: string): Promise<void> {
    return this.requireOp(this.adapter?.saveCollisionAvoidanceSnapshot, 'saveCollisionAvoidanceSnapshot')
      .call(this.adapter, filePath, motionGroup);
  }
  async loadCollisionAvoidanceConfig(): Promise<void> {
    return this.requireOp(this.adapter?.loadCollisionAvoidanceConfig, 'loadCollisionAvoidanceConfig').call(this.adapter);
  }

  // RAPID
  async modifyPosition(task: string, module: string, opts: ModifyPositionOptions): Promise<void> {
    return this.requireOp(this.adapter?.modifyPosition, 'modifyPosition', 'this client has no RWS 1.0 form for it, although ABB documents one').call(this.adapter, task, module, opts);
  }
  async resetTaskProgramPointer(task: string): Promise<void> {
    return this.requireOp(this.adapter?.resetTaskProgramPointer, 'resetTaskProgramPointer').call(this.adapter, task);
  }

  // Diagnostics and system
  async getDiagnostics(): Promise<DiagnosticsInfo> {
    return this.adapter?.getDiagnostics?.() ?? { empty: true, entries: [] };
  }
  async saveDiagnostics(destination?: string): Promise<void> {
    return this.requireOp(this.adapter?.saveDiagnostics, 'saveDiagnostics').call(this.adapter, destination);
  }
  /** RWS 2.0: copies the installation files into `path`; list that directory to see them. `fileType` is optional. */
  async saveSystemInfo(path: string, fileType?: string): Promise<void> {
    return this.requireOp(this.adapter?.saveSystemInfo, 'saveSystemInfo').call(this.adapter, path, fileType);
  }

  // Users and UAS
  async registerUser(reg: UserRegistration): Promise<void> {
    return this.requireOp(this.adapter?.registerUser, 'registerUser', 'this client has no RWS 1.0 form for it, although ABB documents one').call(this.adapter, reg);
  }
  async impersonateUser(uid: string): Promise<void> {
    return this.requireOp(this.adapter?.impersonateUser, 'impersonateUser', 'this client has no RWS 1.0 form for it, although ABB documents one').call(this.adapter, uid);
  }
  async isPasswordChangeAllowed(): Promise<boolean> {
    return this.adapter?.isPasswordChangeAllowed?.() ?? false;
  }
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    return this.requireOp(this.adapter?.changePassword, 'changePassword').call(this.adapter, oldPassword, newPassword);
  }

  // Subscription group editing. Both take every kind this package's
  // subscribers take (AnySubscriptionResource); IRWSAdapter declares the
  // 1.4.0 kinds only, so an adapter of another make may refuse the 1.5.0 ones.
  async updateSubscriptionGroup(groupPath: string, resources: AnySubscriptionResource[]): Promise<string> {
    return this.requireOp(this.adapter?.updateSubscriptionGroup, 'updateSubscriptionGroup')
      .call(this.adapter, groupPath, resources as SubscriptionResource[]);
  }
  async unsubscribeResource(groupPath: string, resource: AnySubscriptionResource): Promise<void> {
    return this.requireOp(this.adapter?.unsubscribeResource, 'unsubscribeResource')
      .call(this.adapter, groupPath, resource as SubscriptionResource);
  }

  // ─── Wrapper-surface completion (2026-08-15) ────────────────────────────────
  // Adapter members that existed on IRWSAdapter but had no RobotManager path,
  // so consumers (extension, panel) had to reach around with adapter casts.
  // Same house rules as the endpoint-completion surface: reads degrade to a
  // neutral value, writes throw rather than silently no-op. Execution/PP
  // writes wrap in withMastership like their existing siblings; everything
  // else is a thin passthrough, and the adapters in this package hold the
  // access each of those writes needs themselves (hold-to-run, breakpoints,
  // module text, ModPos, the per-task PP reset). RMMP stays a recovery path,
  // not a precondition (see the withMastership design note above).

  // RAPID debugger backbone. Stepping and PP moves post to the same
  // execution/pcp endpoint family as startRapid/setPPToRoutine, which requires
  // 'edit'/'rapid' mastership (live-verified: 403 org_code -4501 without it) -
  // so they get the same withMastership wrap as their siblings. A caller-held
  // requestMastership('rapid') hold is respected, not churned.
  async setPPToCursor(task: string, module: string, row: number, col: number, routine?: string): Promise<void> {
    const op = this.requireOp(this.adapter?.setPPToCursor, 'setPPToCursor');
    return this.withMastership(() => op.call(this.adapter, task, module, row, col, routine));
  }
  /**
   * Move the program pointer back one instruction (manual mode): RWS 2.0
   * `POST .../pcp/prev-inst`, RWS 1.0 `?action=set-pp-prev-inst` (the RW
   * 6.16.03 form, 2026-09-29). Holds RAPID mastership like the other PP
   * moves. Run on RWS 1.0 (RobotWare 6.16.03).
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the adapter
   *   lacks it; otherwise the adapter's typed error.
   */
  async ppPrevInst(task: string): Promise<void> {
    const op = this.requireOp(this.adapter?.ppPrevInst, 'ppPrevInst', 'its adapter has no PP step');
    return this.withMastership(() => op.call(this.adapter, task));
  }
  /**
   * Move the program pointer forward one instruction (manual mode): RWS 2.0
   * `POST .../pcp/next-inst`, RWS 1.0 `?action=set-pp-next-inst` (the RW
   * 6.16.03 form, 2026-09-29). Holds RAPID mastership like the other PP
   * moves. Run on RWS 1.0 (RobotWare 6.16.03).
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the adapter
   *   lacks it; otherwise the adapter's typed error.
   */
  async ppNextInst(task: string): Promise<void> {
    const op = this.requireOp(this.adapter?.ppNextInst, 'ppNextInst', 'its adapter has no PP step');
    return this.withMastership(() => op.call(this.adapter, task));
  }
  /**
   * Step RAPID (manual mode). A step is a start with a step execmode on every
   * generation (RobotWare 6: ABB's RWS 1.0 start form with
   * `execmode=stepin|stepover|stepout`, built, not yet run), so it is held like
   * `startRapid`: on RobotWare 6 and 7 the jog's own motion hold is ended
   * first (see `withStartMastership`). A refusal for a missing RobotWare 8
   * motion-control declaration is explained as for `startRapid`.
   */
  async stepRapid(task: string, mode: 'into' | 'over' | 'out'): Promise<void> {
    const op = this.requireOp(this.adapter?.stepRapid, 'stepRapid');
    return this.withStartMastership(() => op.call(this.adapter, task, mode));
  }
  /**
   * Hold to run: `press`, then `held` about every 2 s while the motion should
   * go on (ABB documents the 2 s interval), then `release`. ABB documents it
   * for a virtual controller in manual mode, for a local client (RobotWare 8:
   * a local control station); this client connects as a remote client, so a
   * controller may refuse it.
   *
   * RWS 2.0 posts `state` to `/rw/rapid/execution/holdtorun` inside an edit
   * hold (RobotWare 8: write access). RWS 1.0 posts `state` to
   * `/rw/rapid/execution?action=holdtorun-state` inside a RAPID mastership
   * hold, like start, PP to main and cycle; that is the form RW 6.16.03
   * advertises and ABB's RWS 1.0 manual documents, and it was accepted on
   * RobotWare 6.16.03. `task` is not sent on either generation. The
   * adapter takes the hold around each call; a caller that sends `held`
   * repeatedly can take it once with `requestMastership('rapid')`, so the
   * calls request and release nothing of their own.
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the adapter
   *   lacks it; otherwise the adapter's typed error.
   */
  async holdToRun(task: string, action: 'press' | 'held' | 'release'): Promise<void> {
    return this.requireOp(this.adapter?.holdToRun, 'holdToRun').call(this.adapter, task, action);
  }
  async listBreakpoints(task: string): Promise<Array<{ module: string; row: number; col?: number }>> {
    return this.adapter?.listBreakpoints?.(task) ?? [];
  }
  async setBreakpoint(task: string, module: string, row: number, col?: number): Promise<void> {
    return this.requireOp(this.adapter?.setBreakpoint, 'setBreakpoint').call(this.adapter, task, module, row, col);
  }
  async removeBreakpoint(task: string, module: string, row: number, col?: number): Promise<void> {
    return this.requireOp(this.adapter?.removeBreakpoint, 'removeBreakpoint').call(this.adapter, task, module, row, col);
  }

  // Vision drill-in (listVisionSystems was already wrapped above)
  async getVisionSystemInfo(name: string): Promise<Record<string, string>> {
    return this.adapter?.getVisionSystemInfo?.(name) ?? {};
  }
  async listVisionJobs(system: string): Promise<Array<{ name: string; active?: boolean }>> {
    return this.adapter?.listVisionJobs?.(system) ?? [];
  }
  /**
   * Trigger a vision job. Neither RWS 1.0 nor RWS 2.0 documents such an
   * operation, so both built-in adapters throw `UNSUPPORTED_OPERATION` before
   * sending. An adapter of your own whose `triggerVisionJob` takes no job
   * name is refused here as well, so it never runs a job other than the one
   * named.
   */
  async triggerVisionJob(system: string, job: string): Promise<void> {
    const op = this.requireOp(this.adapter?.triggerVisionJob, 'triggerVisionJob');
    if (op.length < 2) {
      throw new RwsError('This adapter cannot address a specific vision job (its triggerVisionJob takes no job name); nothing was sent', 'UNSUPPORTED_OPERATION');
    }
    return op.call(this.adapter, system, job);
  }

  // Safety (getSafetyStatus was already wrapped above)
  /** Safety zones: no RWS resource on either generation; both adapters answer [] without a request. */
  async listSafetyZones(): Promise<Array<Record<string, string>>> {
    return this.adapter?.listSafetyZones?.() ?? [];
  }
  /** A cyclic brake check: no RWS operation starts one on either generation; both adapters throw `UNSUPPORTED_OPERATION` before sending. */
  async runCyclicBrakeCheck(): Promise<void> {
    return this.requireOp(this.adapter?.runCyclicBrakeCheck, 'runCyclicBrakeCheck').call(this.adapter);
  }

  // Mechunit write side + permanent joints
  /**
   * Set the base frame transform. It changes the unit's calibration: read the
   * frame first with `getMechunitBaseFrame` to be able to write it back.
   * On RWS 2.0 the wrap requests 'rapid', which RobotWare 7 folds into the
   * 'edit' domain and RobotWare 8 into write access (a caller-held hold is
   * respected). On RWS 1.0 (202 on a RobotWare 6.16.03 virtual controller)
   * the adapter holds motion mastership itself, as for the tool set on the
   * same unit, and no RAPID mastership is taken.
   */
  async setMechunitBaseFrame(mechunit: string, frame: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void> {
    const op = this.requireOp(this.adapter?.setMechunitBaseFrame, 'setMechunitBaseFrame', 'its adapter has no base-frame write');
    if (this.adapter instanceof RWS1Adapter) { return op.call(this.adapter, mechunit, frame); }
    return this.withMastership(() => op.call(this.adapter, mechunit, frame));
  }
  async getMechunitPjoints(mechunit?: string): Promise<Record<string, number>> {
    return this.adapter?.getMechunitPjoints?.(mechunit) ?? {};
  }

  // Certificate store
  async listCertificates(): Promise<Array<{ name: string; subject?: string; expires?: string }>> {
    return this.adapter?.listCertificates?.() ?? [];
  }
  async uploadCertificate(name: string, pem: string): Promise<void> {
    return this.requireOp(this.adapter?.uploadCertificate, 'uploadCertificate').call(this.adapter, name, pem);
  }
  /** Remove every certificate from one store (RWS 2.0 only). */
  async clearCertificateStore(scope: string, store: string): Promise<void> {
    return this.requireOp(this.adapter?.clearCertificateStore, 'clearCertificateStore').call(this.adapter, scope, store);
  }
  /** @deprecated RWS has no per-certificate removal; use `clearCertificateStore`. */
  async removeCertificate(name: string): Promise<void> {
    return this.requireOp(this.adapter?.removeCertificate, 'removeCertificate').call(this.adapter, name);
  }

  // Controller device groups (HW_DEVICES / SW_RESOURCES - distinct from I/O devices)
  async listDeviceGroups(): Promise<string[]> {
    return this.adapter?.listDeviceGroups?.() ?? [];
  }
  async listControllerDevices(group: string): Promise<Array<{ id: string; name: string }>> {
    return this.adapter?.listControllerDevices?.(group) ?? [];
  }

  // ─── Inverse + Forward Kinematics ───────────────────────────────────────────

  /**
   * Inverse kinematics: the joint angles (degrees) that put tool0 (the
   * flange) at `pos` (millimetres, quaternion), nearest `seedJoints`.
   *
   * `pos` must be the tool0 pose in the base frame (wobj0). There is no tool
   * or work-object argument, so a pose taken with another tool or work
   * object is not refused: it is solved as a flange pose at that point and
   * gives plausible but wrong joints. `getCartesianFull()` and
   * `RobotState.cartesian` come from `/cartesian`, which takes no tool or
   * work object and is not verified to report tool0 in wobj0 when another
   * one is active; read the pose with tool0 and wobj0 named (the adapters'
   * `getRobTarget(mechunit, 'tool0', 'wobj0')`) when that matters.
   * A pose out of reach is `INVALID_ARGUMENT`. Throws NOT_CONNECTED.
   */
  async calcJointsFromCartesian(
    pos: RobTarget,
    seedJoints?: JointTarget,
    mechunit?: string,
  ): Promise<JointTarget> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.calcJointsFromCartesian(pos, seedJoints, mechunit);
  }

  async calcCartesianFromJoints(joints: JointTarget, mechunit = 'ROB_1', tool = 'tool0', wobj = 'wobj0'): Promise<RobTarget> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    if (!this.adapter.calcCartesianFromJoints) { throw new RwsError('Forward kinematics not supported on this protocol', 'UNSUPPORTED_OPERATION'); }
    return this.adapter.calcCartesianFromJoints(joints, mechunit, tool, wobj);
  }

  // ─── Devices ─────────────────────────────────────────────────────────────────

  async listSystemDevices(): Promise<Array<{ id: string; name: string }>> {
    if (!this.adapter?.listSystemDevices) { return []; }
    return this.adapter.listSystemDevices();
  }
  async listAllIoDevices(): Promise<Array<{ name: string; network: string; lstate: string; pstate: string; address: string }>> {
    if (!this.adapter?.listAllIoDevices) { return []; }
    return this.adapter.listAllIoDevices();
  }

  // ─── Mastership extras ───────────────────────────────────────────────────────

  /** Hold every lock of the generation at once. Counted like requestMastership:
   *  pair it with one releaseMastershipAll. */
  async requestMastershipAll(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter?.requestMastershipAll) { throw new RwsError('requestMastershipAll not supported', 'UNSUPPORTED_OPERATION'); }
    // An adapter from this package counts its own all-domains holds.
    if (accessOf(adapter)) { return adapter.requestMastershipAll(); }
    return this.access(adapter).requestPublicAll(RobotManager.allDomainsWire(adapter));
  }
  async releaseMastershipAll(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter?.releaseMastershipAll) { throw new RwsError('releaseMastershipAll not supported', 'UNSUPPORTED_OPERATION'); }
    if (accessOf(adapter)) { return adapter.releaseMastershipAll(); }
    return this.access(adapter).releasePublicAll(RobotManager.allDomainsWire(adapter));
  }

  private static allDomainsWire(adapter: IRWSAdapter): { request(): Promise<void>; release(): Promise<void> } {
    return {
      request: () => adapter.requestMastershipAll!(),
      release: () => adapter.releaseMastershipAll!(),
    };
  }
  async requestMastershipWithId(domain: 'rapid' | 'cfg' | 'motion'): Promise<number> {
    if (!this.adapter?.requestMastershipWithId) { throw this.notOnRws1('Token-based mastership requires RWS 2.0', 'Mastership with an id'); }
    return this.adapter.requestMastershipWithId(domain);
  }
  async releaseMastershipWithId(domain: 'rapid' | 'cfg' | 'motion', id: number): Promise<void> {
    if (!this.adapter?.releaseMastershipWithId) { throw this.notOnRws1('Token-based mastership requires RWS 2.0', 'Mastership with an id'); }
    return this.adapter.releaseMastershipWithId(domain, id);
  }
  /**
   * Reset the RobotWare 7 edit-mastership watchdog by hand. The RWS 2.0
   * adapter already resets it while its session holds `edit` on RobotWare 7.8
   * or later, so this is only needed for a hold it does not count
   * (`requestMastershipWithId`). RobotWare 6 has no watchdog and RobotWare 8
   * no mastership: both `UNSUPPORTED_OPERATION`.
   */
  async resetMastershipWatchdog(): Promise<void> {
    if (!this.adapter?.resetMastershipWatchdog) { throw this.notOnRws1('Mastership watchdog requires RobotWare 7.8+', 'The mastership watchdog'); }
    return this.adapter.resetMastershipWatchdog();
  }

  /**
   * An operation RWS 1.0 does not have (n/a, not a client gap): ABB documents
   * mastership with an id and the mastership watchdog on RWS 2.0 only, and
   * RobotWare 6 has neither (the RW 6.16.03 write run of 2026-10-13 found no
   * form for them). Nothing is sent.
   */
  private notOnRws1(message: string, what: string): RwsError {
    if (!this.adapter) { return new RwsError(message, 'UNSUPPORTED_OPERATION'); }
    const sentence = `${what} does not exist on RWS 1.0 (RobotWare 6): ABB documents it for RWS 2.0 only.`;
    const fix = 'None on this controller: it does not have this function.';
    const generation = this.access(this.adapter).generation();
    return new RwsError(`${message}. ${sentence}`, 'UNSUPPORTED_OPERATION', undefined, undefined, undefined, undefined, builtRefusal({
      kind: 'unsupported', condition: 'none', generation, grantor: 'nobody',
      missing: 'RWS 2.0', fix, sentence, evidence: 'abb',
      remedy: remedy.notAvailable(generation, { detail: 'RobotWare 6 (RWS 1.0) does not have this function; ABB documents it for RWS 2.0 only.', evidence: 'abb' }),
    }));
  }

  /** Query who currently holds mastership on a domain. Returns null if adapter doesn't support it. */
  async getMastershipStatus(domain: 'rapid' | 'cfg' | 'motion' = 'rapid'): Promise<{ mastership: string; uid?: string; application?: string } | null> {
    if (!this.adapter?.getMastershipStatus) { return null; }
    try { return await this.adapter.getMastershipStatus(domain); }
    catch { return null; }
  }

  /**
   * The controller's control-station write-access status (RobotWare 8): whether
   * a station holds write access, whether it is this client's own station, the
   * holding station's name, and the controller's "external control enabled"
   * flag. One GET of `/rw/controlstation/writeaccess/status` on the manager's
   * session; it registers no control station and requests nothing.
   *
   * Each field is what the answer said: a flag is true only for the text
   * `true` and false only for `false`, and any other text or an absent field
   * is null, never false. `heldByMe` compares the holder id with the id this
   * client registers as (false when `held` is false, null when the holder id
   * is not given). No station id is in the result. See `WriteAccessStatus`.
   *
   * RobotWare 6 (RWS 1.0) and RobotWare 7 have no write-access status, only
   * mastership (`getMastershipStatus`): there it throws `UNSUPPORTED_OPERATION`
   * and sends nothing (RobotWare 7.21.4 answers 404 for `/rw/controlstation`,
   * 2026-09-29). Check `state.access.generation === 'rw8'` first. On an RWS 2.0
   * connection whose generation is not known (the controller reported no
   * usable RobotWare version) the GET is sent and the controller's answer
   * decides.
   *
   * Never answers null. Throws `RwsError`: `NOT_CONNECTED` before a connect;
   * `UNSUPPORTED_OPERATION` as above; `PARSE_ERROR` when the answer carries no
   * write-access status at all (an empty body included); otherwise the
   * adapter's own error for the request.
   */
  async getWriteAccessStatus(): Promise<WriteAccessStatus> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const adapter = this.adapter;
    const read = writeAccessStatusReaderOf(adapter);
    if (!read) {
      throw new RwsError(
        'The write-access status is a RobotWare 8 read; this connection is not an RWS 2.0 client of this package '
        + '(RWS 1.0 is RobotWare 6, which has mastership: use getMastershipStatus). Nothing was sent.',
        'UNSUPPORTED_OPERATION');
    }
    if (this.accessIfAny(adapter)?.generation() === 'rw7') {
      throw new RwsError(
        'The write-access status is a RobotWare 8 read; this controller runs RobotWare 7, which has mastership: '
        + 'use getMastershipStatus. Nothing was sent.',
        'UNSUPPORTED_OPERATION');
    }
    return read();
  }

  /**
   * Acquire mastership on one domain and KEEP it - for multi-step edits where
   * per-call acquire/release would churn. Holds are counted per real lock by
   * the session's access manager, shared with every write the manager and the
   * adapter make: inside this hold, withMastership-wrapped writes (startRapid,
   * cfg writes, stepping), the adapter's own wraps (speed ratio, PP to main,
   * supervision) and jog() request nothing more and never end it (stopRapid
   * and setMotorsOff never acquire before sending). A request for a lock the
   * session already holds sends nothing. The caller owns the release: always
   * pair with releaseMastership(domain) in a finally.
   */
  async requestMastership(domain: MastershipDomain): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const access = this.access(this.adapter);
    await access.requestPublic(domain);
    // The caller's hold takes over the jog's own motion hold: it ends now
    // (only counted, so nothing is released on the wire) and the caller's
    // release ends the lock.
    if (access.lockOf(domain) === access.lockOf('motion')) { await this.endJogHold(access, false); }
  }
  /**
   * Release a hold taken with requestMastership(domain). Ends the caller's most
   * recent hold on the same lock; the controller is told only when no other
   * hold of this session (an operation in progress) is still on it. With no
   * caller hold on the motion lock, it ends the jog's own motion hold at once
   * instead of 2 s after the last jog.
   */
  async releaseMastership(domain: MastershipDomain): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const access = this.access(this.adapter);
    const lock = access.lockOf(domain);
    if (lock === access.lockOf('motion') && !access.hasLivePublicHold(lock) && this.jogHold?.live) {
      await this.endJogHold(access, true);
      return;
    }
    return access.releasePublic(domain);
  }
  /** Enumerate the mastership domains this controller exposes. */
  async listMastershipDomains(): Promise<string[]> {
    return this.adapter?.listMastershipDomains?.() ?? [];
  }

  // ─── Jogging ──────────────────────────────────────────────────────────────────

  /** The jog's own motion hold (RW8: write access), ended 2 s after the last jog. */
  private jogHold: AccessHold | null = null;
  private jogReleaseTimer: NodeJS.Timeout | null = null;

  /** True while this session counts any hold on the motion lock (the jog's own, a caller's, an operation's). */
  private get motionMastershipHeld(): boolean {
    if (!this.adapter) { return false; }
    const access = this.access(this.adapter);
    return access.count(access.lockOf('motion')) > 0;
  }

  /**
   * Jog the robot: one jog request (see `IRWSAdapter.jog` for what is sent),
   * after a pre-flight for this RobotWare generation, holding motion access.
   * A named `mechunit` that is not the controller's jog selection is selected
   * first, under the same motion hold, and the jog is sent only when the
   * controller then names it. That selection is not restored after the jog:
   * the controller's (and the FlexPendant's) jog unit stays changed. A bad
   * unit name, including on RWS 2.0 one that names a sibling resource of
   * /rw/motionsystem, is refused (INVALID_ARGUMENT) before the pre-flight.
   *
   * Pre-flight, read fresh from the controller inside this controller's one
   * write turn. Nothing read is required; the jog is sent and the controller
   * decides. A refusal of the jog itself that the controller does not explain
   * more specifically is explained with what was read:
   * - The operating mode. ABB documents jogging in manual mode, and ABB's IRC5
   *   operating manual says jogging is disabled in manual full speed. A
   *   refusal outside MANR/MANF, or on RobotWare 6 in MANF, is reported as
   *   WRONG_MODE naming the mode read.
   * - The motors are read, not required: the jog is sent and the controller
   *   decides. A refusal while they read off is reported as MOTORS_OFF with
   *   that reading (in manual mode a person holds the enabling device at the
   *   FlexPendant to switch them on).
   * - RobotWare 6/7: nothing about RMMP. ABB's jog pages require a local
   *   client with mastership ("Login as Local client and get mastership"), and
   *   RMMP does not make a remote tool local, so the client adds no RMMP check
   *   of its own: the motion mastership request and the jog are sent, and a
   *   refusal of either carries that rule in its sentence.
   * - RobotWare 8: once write access is held, the station's motion-control
   *   declaration is read, not required: the jog is sent, and a refusal while
   *   it reads off is explained as motion-control-off (virtual-controller run 2026-10-13: with it
   *   true, Reset and Enable at the pendant, RW 8.2.1 jogged, the first
   *   RobotWare 8 motion-tier 2xx). ABB: a station needs an emergency stop and a normal stop
   *   "to start RAPID or jogging", and setting allow-motion-control is the
   *   station's confirmation that both are available. Only a person makes
   *   that declaration (`setAllowMotionControl` on the RWS 2.0 client); this
   *   client never makes it on its own. RobotWare 8 sends no RMMP call.
   *
   * Access: motion mastership (RobotWare 6/7) or control-station write access
   * (RobotWare 8), requested at the first jog and released 2 s after the last
   * one, so successive jogs do not churn it. On RobotWare 6 and 7 a
   * `startRapid` or a `stepRapid` ends that hold first: ABB's RobotWare 7 start page says a
   * start does not succeed while the client holds motion mastership; on
   * RobotWare 6 ending it is a precaution. A caller that holds the motion lock through
   * requestMastership() or requestMastershipAll() covers the
   * jogs: no hold of the jog's own and no timer, and a start does not end
   * the caller's hold. The 2 s release only ends the jog's own hold, so it
   * never ends a caller's hold or an operation's on the same lock (on
   * RobotWare 8 every domain is one lock).
   *
   * What one call does: one jog step, not a move to a position. The six
   * `axes` values are sent as ABB's `axis1`..`axis6`, which ABB documents only
   * as `{axis1}`..`{axis6}` with a sample of `axis1=900` and `inc-mode=Large`
   * (RWS 1.0 manual Rev M and RWS 2.0 Rev L, Perform Jogging), with no unit.
   * They are not degrees or millimetres: the sign of each sets the direction
   * of the step for that axis (or Cartesian direction), zero leaves it still,
   * and what the magnitude does is not documented. The step's size comes from
   * the increment (`incMode`, default `Small`): on RW 8.2.1 one call with axis
   * 5 set to 1 and `Small` moved axis 5 by about 0.01 degree (30.00 to 30.01,
   * then -1 to 29.99, read back; 2026-10-13). Call again to step further.
   *
   * RobotWare 6 and 7 in manual mode: ABB's jog pages say "Login as Local
   * client and get mastership". RW 7.21.4 refused a remote jog in MANR with
   * motion mastership, RMMP modify and the motors on (-1073445860,
   * 2026-10-13); the refusal is explained by that rule. RobotWare 8 in MANR,
   * with Reset and Enable at the pendant, the station registered and
   * allow-motion-control true, jogged (2026-10-13).
   */
  async jog(params: JogParams): Promise<void> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    checkJog(params);
    const adapter = this.adapter;
    if (adapter instanceof RWS2Adapter && params.mechunit !== undefined) { rws2JogUnitSegment(params.mechunit, 'jog'); }
    const access = this.access(adapter);
    const generation = access.generation();
    await access.exclusive(async () => {
      const { mode, ctrl } = await this.jogPreflight(adapter, generation);
      // The jog is sent and the controller decides. A refusal is explained
      // with what was read before it: the motors off, or on RobotWare 8 the
      // station's motion-control declaration off; otherwise, on RobotWare 6
      // and 7 in manual mode, ABB's local-client rule, which RMMP does not
      // satisfy.
      const localRule = (generation === 'rw6' || generation === 'rw7') && /^MAN/i.test(mode);
      const read = { motionControlOff: false, jogSent: false };
      try {
        await this.jogUnderAccess(adapter, access, params, generation, read);
      } catch (e) {
        // The controller's own motion-control code (-1073435864, RobotWare 8)
        // is explained by its code, whichever adapter sent the jog: the
        // `jogSent` tag below is set only by this package's adapters. It is
        // RobotWare 8's answer, so the RobotWare 6/7 local-client note does
        // not apply.
        if (e instanceof RwsError && e.controllerCode === MOTION_CONTROL_OFF_CODE) {
          throw e.refusal?.kind === 'motion-control-off' ? e : RobotManager.jogMotionControlOffRefusal(e, 'code');
        }
        // A reading is used as a hint only for a refusal of the jog POST
        // itself (`jogSent`: the adapter tagged the error as that request's)
        // that the controller's answer does not explain more specifically: a
        // refused motion-system read or unit selection before the POST, a
        // mastership or write-access refusal, a local-client refusal
        // (-1073445860) and every other classified kind keep their own
        // explanation.
        const unexplained = read.jogSent && RobotManager.isControllerRefusal(e) && (!e.refusal || e.refusal.kind === 'unknown');
        const manual = mode === 'MANR' || mode === 'MANF';
        if (unexplained && (!manual || (generation === 'rw6' && mode === 'MANF'))) { throw RobotManager.jogModeRefusal(e, mode, generation); }
        if (unexplained && ctrl !== 'motoron') { throw RobotManager.jogMotorsOffRefusal(e, ctrl, generation); }
        if (unexplained && read.motionControlOff) { throw RobotManager.jogMotionControlOffRefusal(e); }
        throw localRule ? RobotManager.withJogLocalClientNote(e) : e;
      }
    });
  }

  /**
   * A refusal of a manual-mode jog on RobotWare 6 or 7, with ABB's rule added:
   * the jog pages ask for "Login as Local client and get mastership", and RMMP
   * does not make a remote tool a local client.
   */
  private static withJogLocalClientNote(e: unknown): unknown {
    if (!(e instanceof RwsError)) { return e; }
    // The controller's own refusal of the jog is already explained with the
    // rule (refusal.ts, -1073445860 on a jog); say it once.
    if (/local client/i.test(e.refusal?.sentence ?? e.message)) { return e; }
    const note = "ABB's jog pages require a local client with mastership for a jog in manual mode, and RMMP does not make this tool local, "
      + 'so a real controller may refuse the jog even with RMMP granted.';
    const refusal = e.refusal ? { ...e.refusal, sentence: `${e.refusal.sentence} ${note}` } : undefined;
    return new RwsError(`${e.message} ${note}`, e.code, e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg, refusal, e.responseBody);
  }

  private async jogUnderAccess(adapter: IRWSAdapter, access: AccessManager, params: JogParams, generation: AccessGeneration | null,
    read: { motionControlOff: boolean; jogSent: boolean }): Promise<void> {
    {
      const motion = access.lockOf('motion');
      // A caller holding the motion lock through requestMastership() covers
      // the jog; its hold is theirs to release.
      if (!access.hasLivePublicHold(motion)) {
        // A hold that was lost is not revived: the next jog requests afresh.
        if (!this.jogHold?.live) { this.jogHold = await access.acquire('motion'); }
        // Reset the auto-release timer on every jog so it only fires after 2 s
        // of no jogging.
        if (this.jogReleaseTimer) { clearTimeout(this.jogReleaseTimer); }
        this.jogReleaseTimer = setTimeout(() => { this.releaseJogMastership().catch(() => {}); }, 2000);
      }
      if (generation === 'rw8' && adapter instanceof RWS2Adapter) {
        // Read, not required: a jog with the declaration off is sent and the
        // controller decides; its refusal is explained with this reading.
        try { read.motionControlOff = !(await adapter.getAllowMotionControl()); } catch { read.motionControlOff = false; }
      }
      try {
        await adapter.jog(params);
      } catch (e) {
        // Whether the jog POST itself answered with this error, not a read or
        // the unit selection the adapter makes before it.
        read.jogSent = isJogPostError(e);
        // Refused as not held while this session counted the motion lock: the
        // hold was lost; the next jog requests afresh.
        throw access.noteRefusal(e, [motion]);
      }
    }
  }

  /**
   * Select the mechanical unit that jogging acts on: RWS 2.0
   * `POST /rw/motionsystem/{mechunit}` (ABB Motion_System Rev L), RWS 1.0
   * `POST /rw/motionsystem?action=set-mechunit` with `mechunit-name` (RW
   * 6.16.03 form, 2026-09-29). The adapter holds motion mastership
   * (RobotWare 8: write access) around it. `jog()` selects a named unit
   * itself, so this is for selecting without jogging. Run live only as a
   * selection of the unit already selected.
   *
   * @throws RwsError `NOT_CONNECTED`; `UNSUPPORTED_OPERATION` when the adapter
   *   lacks it; `INVALID_ARGUMENT` for a bad unit name; otherwise the
   *   adapter's typed error.
   */
  async setMechunitForJogging(mechunit: string): Promise<void> {
    const op = this.requireOp(this.adapter?.setMechunitForJogging, 'setMechunitForJogging', 'its adapter has no jog unit selection');
    return op.call(this.adapter, mechunit);
  }

  /** jog()'s pre-flight before any access is requested; see jog(). */
  private async jogPreflight(adapter: IRWSAdapter, _generation: AccessGeneration | null): Promise<{ mode: string; ctrl: string }> {
    const mode = String(await adapter.getOperationMode()).trim().toUpperCase();
    // The mode is read, not required (owner's write policy, 2026-10-13): a jog
    // outside a manual mode, or on RobotWare 6 in MANF, is sent, and an
    // unexplained refusal is explained with this reading (jogModeRefusal).
    // The motors are read, not required: the controller decides (owner's
    // write policy, 2026-10-13). A refusal is explained with this reading.
    const ctrl = String(await adapter.getControllerState()).trim().toLowerCase();
    return { mode, ctrl };
  }

  /**
   * True for a controller refusal that a running program can explain: a 400
   * or 403 for the execution state (-1073442809 SYS_CTRL_E_EXEC_STATE), or one
   * the controller left unexplained. A mode refusal (-1073445860
   * SYS_CTRL_E_MODE_REJECT) is wrapped only when the classifier left it
   * unexplained; classified, it keeps its operating-mode explanation. A missing
   * resource, a bad argument, and a mastership, write-access or RMMP refusal
   * keep their own explanation.
   */
  private static isStateLikeRefusal(e: unknown): e is RwsError {
    if (!RobotManager.isControllerRefusal(e) || (e.httpStatus !== 400 && e.httpStatus !== 403)) { return false; }
    if (e.code === 'RESOURCE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND' || e.code === 'INVALID_ARGUMENT') { return false; }
    // A refusal the classifier already explained more specifically (RMMP,
    // local only, held by another, the mode...) keeps its explanation: telling
    // the user to stop the program would send them the wrong way, and the
    // retry would be refused for the real reason. The mode and execution-state
    // codes are wrapped only while nothing more specific was found.
    const kind = e.refusal?.kind;
    if (e.controllerCode === -1073445860 || e.controllerCode === -1073442809) {
      return !kind || kind === 'unknown' || kind === 'wrong-state';
    }
    return !kind || kind === 'unknown';
  }

  /** True for an HTTP refusal the controller answered (not a network or client error). */
  private static isControllerRefusal(e: unknown): e is RwsError {
    return e instanceof RwsError && (e.httpStatus ?? 0) >= 400;
  }

  /**
   * A controller refusal of a jog sent outside a manual mode, or on RobotWare 6
   * in MANF, explained with the mode read before it: ABB documents jogging in
   * manual mode, and the IRC5 operating manual says jogging is disabled in
   * manual full speed.
   */
  private static jogModeRefusal(e: RwsError, mode: string, generation: AccessGeneration | null): RwsError {
    const toMANR = 'Switch to manual reduced speed (MANR) with the mode selector at the controller.';
    const sentence = generation === 'rw6' && mode === 'MANF'
      ? "The controller refused the jog in manual full speed (MANF), where ABB's IRC5 operating manual says jogging is disabled. " + toMANR
      : `The controller refused the jog in ${mode || 'the mode it reported'}: ABB documents jogging in manual mode (MANR or MANF). ${toMANR}`;
    return new RwsError(`${sentence} Controller: ${e.message}`, 'WRONG_MODE', e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg, builtRefusal({
      kind: 'wrong-mode', condition: 'operating-mode', generation, grantor: 'key-switch',
      missing: generation === 'rw6' && mode === 'MANF' ? 'manual reduced speed (MANR)' : 'a manual operating mode (MANR or MANF)',
      fix: toMANR, sentence, evidence: 'abb',
      remedy: remedy.mode(generation, 'MANR'),
    }), e.responseBody);
  }

  /** A controller refusal of a jog sent while the motors read off, explained with that reading. */
  private static jogMotorsOffRefusal(e: RwsError, ctrl: string, generation: AccessGeneration | null): RwsError {
    const enable = 'In manual mode a person switches them on by holding the enabling device at the FlexPendant.';
    const sentence = `The controller refused the jog, and the motors were off when it was sent (controller state: ${ctrl}). ${enable}`;
    return new RwsError(`${sentence} Controller: ${e.message}`, 'MOTORS_OFF', e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg, builtRefusal({
      kind: 'wrong-state', condition: 'motors', generation, grantor: 'pendant-operator',
      missing: 'motors on', fix: enable, sentence, evidence: 'abb',
      remedy: remedy.motorsOnAtPendant(generation, 'enabling-device'),
    }), e.responseBody);
  }

  /**
   * A refused jog explained as RobotWare 8's missing motion-control
   * declaration. `code`: the controller answered -1073435864 itself, from any
   * adapter; the error then carries `GRANT_DENIED`, the code the refusal table
   * gives it, and the remedy is to allow motion control. `reading`: motion
   * control read as not allowed before the jog was sent, and the controller's
   * answer said nothing more specific; motion control may be the reason, so
   * the remedy is to check, and allowing it is another way (evidence
   * `unverified`).
   */
  private static jogMotionControlOffRefusal(e: RwsError, by: 'reading' | 'code' = 'reading'): RwsError {
    const sentence = (by === 'code'
      ? 'The controller refused the jog: motion control is not allowed for this control station. '
      : 'The controller refused the jog and did not say why. Motion control may be the reason: it read as not allowed for this control station '
        + 'before the jog was sent. ')
      + MOTION_CONTROL_RULE;
    const code = by === 'code' ? 'GRANT_DENIED' : e.code;
    return new RwsError(`${sentence} Controller: ${e.message}`, code, e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg, builtRefusal({
      kind: 'motion-control-off', condition: 'motion-control', generation: 'rw8', grantor: 'this-tool',
      missing: MOTION_CONTROL_MISSING, fix: MOTION_CONTROL_DECLARE, sentence, evidence: by === 'code' ? 'vc' : 'unverified',
      ...motionControlRemedies(by),
    }), e.responseBody);
  }

  /** End the jog's own motion hold immediately (called by disconnect and the auto-release timer). */
  private async releaseJogMastership(): Promise<void> {
    if (!this.adapter) {
      if (this.jogReleaseTimer) { clearTimeout(this.jogReleaseTimer); this.jogReleaseTimer = null; }
      this.jogHold = null;
      return;
    }
    await this.endJogHold(this.access(this.adapter), false);
  }

  /** Clear the jog timer and end the jog's own hold; `rethrow` passes a failed release on. */
  private async endJogHold(access: AccessManager, rethrow: boolean): Promise<void> {
    if (this.jogReleaseTimer) { clearTimeout(this.jogReleaseTimer); this.jogReleaseTimer = null; }
    const hold = this.jogHold;
    this.jogHold = null;
    if (!hold) { return; }
    if (rethrow) { await access.release(hold); } else { await access.releaseQuietly(hold); }
  }

  /**
   * `withMastership` for a RAPID start or step (a step is a start with a step
   * execmode, on RobotWare 6 as well).
   * ABB's RWS start page says a start needs edit mastership and does not
   * succeed while the client holds motion mastership. RobotWare 7 refused a
   * start sent while this session held motion mastership it had requested
   * itself with 500 -1073445844 (2026-09-15, RW 7.21 VC). A start sent right
   * after a jog, and a step under a motion hold, have not been recorded.
   *
   * On RobotWare 6 and 7, where motion is a lock of its own, the jog's own
   * idle motion hold is ended first, with its 2 s timer, so no release fires
   * after the start. The end and the start run in one write turn: a jog asked
   * for meanwhile waits for the start instead of taking motion again in
   * between. A motion hold the caller took with `requestMastership('motion')`
   * or `requestMastershipAll()` is theirs and stays: the controller then
   * refuses the start, and the refusal says which hold to release. On
   * RobotWare 8 motion and RAPID are one write-access lock, which the start
   * reuses: nothing is released before it. RobotWare 6 has not been seen
   * refusing such a start (RW 6.16's code dictionary does not know
   * -1073445844), but motion is a lock of its own there too, and ending an
   * idle jog hold costs one release.
   */
  private async withStartMastership<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    const access = this.access(this.adapter);
    return access.exclusive(async () => {
      const motion = access.lockOf('motion');
      if (motion !== access.lockOf('rapid') && this.jogHold?.live && !access.hasLivePublicHold(motion)) {
        await this.endJogHold(access, false);
      }
      this.warnHeartBeatBeforeStart(access);
      return this.withMastership(fn);
    });
  }

  /** The connection the HeartBeat warning was given for (see warnHeartBeatBeforeStart). */
  private heartBeatWarnedEpoch: number | null = null;

  /**
   * RobotWare 8 with HeartBeat `Select` true: ABB's controller text (event
   * 10139) says a station holding write access while RAPID runs must send a
   * periodic watchdog command, or execution stops as a safety measure, and
   * RobotWare 8 documents no RWS way to send it (the RobotWare 7 watchdog
   * answers 410 there). The start still goes out - the controller decides -
   * with one warning per connection: a log line and an access event
   * (`warning`, `heartbeat-required`) a consumer can show before the start.
   * Nothing when the configuration says false or could not be read.
   */
  private warnHeartBeatBeforeStart(access: AccessManager): void {
    if (this.heartBeatWarnedEpoch === this.connectEpoch) { return; }
    const s = access.snapshot();
    if (s.generation !== 'rw8' || s.watchdog?.enforced !== true) { return; }
    this.heartBeatWarnedEpoch = this.connectEpoch;
    const robot = this.refusalContextNow().robot ?? (this._state.host || 'this controller');
    const after = s.watchdog.timeoutMs !== null ? `${s.watchdog.timeoutMs} ms` : 'the HeartBeat timeout';
    const detail = `${robot} requires a station holding write access while RAPID runs to send a periodic heartbeat; `
      + `RobotWare 8 offers no RWS way to send it, so RAPID may stop after ${after}`;
    Logger.warn(detail);
    access.noteWarning(access.lockOf('rapid'), 'heartbeat-required', detail);
  }

  async downloadModule(moduleName: string): Promise<string> {
    if (!this.adapter) { throw new RwsError('Not connected', 'NOT_CONNECTED'); }
    return this.adapter.readFile(`$HOME/${moduleName}.mod`);
  }

  // ─── Session cookie (RWS 1.0 only) ──────────────────────────────────────────

  // ─── WebSocket subscriptions ──────────────────────────────────────────────────

  /**
   * Subscribe to state-change events for instant UI updates, once per
   * connection, at connect. Non-fatal: if the subscribe fails, polling
   * covers all state at full frequency, and the subscribe is tried again on
   * a backoff while connected (retrySubscriptionsIfDue): 5 s after this
   * attempt, then 10, 20, 40 s, then each minute, and 10 minutes apart
   * after three unanswered creates in a row (see subscribeAttemptFailed). An
   * adapter that answers `UNSUPPORTED_OPERATION` (or has no `subscribe`)
   * cannot subscribe at all and is not tried again on this connection.
   * Until 1.5.1 a failed attempt was never repeated: an IRC5 virtual
   * controller that did not answer `POST /subscription` within the 5 s
   * timeout, in a connect of three controllers at once, was fast-polled for
   * the whole connection (2026-10-25, three rounds out of three).
   *
   * A group the controller creates without some of these resources is kept
   * (a refused panel resource already fails the subscribe in the adapter):
   * the handle's `unbound` names them, and the poll reads them instead
   * (noteUnboundResources, pollIntervalMs, fetchAll), with the quality
   * `live` while the poll keeps the slow rate (an unbound event log), or
   * `polling` while it runs fast (an unbound status resource; see
   * streamQuality), and its reason naming what is polled.
   */
  private async startSubscriptions(): Promise<void> {
    if (!this.adapter) { return; }
    const adapter = this.adapter;
    const epoch = this.connectEpoch;
    // A new connection's schedule: its first retry comes 5 s after this
    // attempt fails, whatever the previous connection's step was.
    this.resetSubscribeRetry();
    // One subscribe at a time: a retry of the previous connection still out
    // on this adapter settles first (its late group is unsubscribed then).
    const stale = this.subscribeRetry;
    if (stale && stale.adapter === adapter) { await stale.done; }
    // Torn down meanwhile: doConnect unwinds (aborted), nothing to subscribe for.
    if (epoch !== this.connectEpoch || adapter !== this.adapter) { return; }
    try {
      this.unsubscribeFn = await this.subscribeStatusGroup(adapter);
      this.subscriptionActive = true;
      this.noteUnboundResources();
    } catch (e) {
      this.subscriptionActive = false;
      this.unboundResources = new Set();
      // A teardown during the subscribe: no retry for a connection that is gone.
      if (epoch !== this.connectEpoch) { return; }
      const waitMs = this.subscribeAttemptFailed(e);
      // Not an error - polling is the fallback
      Logger.info(`WS subscriptions unavailable, using polling only: ${e instanceof Error ? e.message : String(e)}; ${
        waitMs === undefined
          ? 'the adapter cannot subscribe, so the subscribe is not tried again on this connection'
          : `subscribing again in ${this.subscribeWaitText(waitMs)}`}`);
    }
  }

  /**
   * The manager's one status group, with its event, loss and restore
   * handlers (startSubscriptions, retrySubscriptions). An adapter without a
   * `subscribe` is refused as `UNSUPPORTED_OPERATION`, and a throw is a
   * rejection.
   */
  private async subscribeStatusGroup(adapter: IRWSAdapter): Promise<() => Promise<void>> {
    if (typeof adapter.subscribe !== 'function') {
      throw new RwsError('this adapter has no subscribe()', 'UNSUPPORTED_OPERATION');
    }
    return adapter.subscribe(
      [
        'controllerstate',
        'operationmode',
        'speedratio',
        'execution',
        'coldetstate',
        { type: 'elog', domain: 0 },
      ],
      event => this.handleSubscriptionEvent(event),
      () => this.handleSubscriptionLost(),
      () => this.handleSubscriptionRestored(),
    );
  }

  /** The wait after the first failed subscribe; it doubles per failure in a row up to SUBSCRIBE_RETRY_CAP_MS, as the signal table's does. */
  private static readonly SUBSCRIBE_RETRY_MS = 5_000;
  /** The longest wait between two subscribe retries, but after unanswered creates (SUBSCRIBE_RETRY_SLOW_MS). */
  private static readonly SUBSCRIBE_RETRY_CAP_MS = 60_000;
  /** Unanswered creates in a row after which the retries are SUBSCRIBE_RETRY_SLOW_MS apart (subscribeAttemptFailed). */
  private static readonly SUBSCRIBE_UNANSWERED_MAX = 3;
  /** The wait between two subscribe retries once SUBSCRIBE_UNANSWERED_MAX creates in a row went unanswered. */
  private static readonly SUBSCRIBE_RETRY_SLOW_MS = 600_000;

  /** No subscribe retry is due, and the next failure is the first in a row (a new connection; teardown; a lost stream). */
  private resetSubscribeRetry(): void {
    this.subscribeRetryDueAt = null;
    this.subscribeRetryWaitMs = 0;
    this.subscribeFails = 0;
    this.subscribeUnanswered = 0;
  }

  /**
   * Whether a subscribe failed because the group create got no answer in
   * time: the RWS 1.0 session's timeout on `POST /subscription`, or the RWS
   * 2.0 subscribe POST's timeout or deadline. Such a create may still leave
   * a group on the controller (see WsSubscriber.createGroup), and on RWS 1.0
   * it held the session's one-at-a-time requests while it waited.
   */
  private static isUnansweredCreate(e: unknown): boolean {
    if (!(e instanceof RwsError) || e.code !== 'NETWORK_ERROR') { return false; }
    return /^Request timed out after \d+ms: POST \/subscription$/.test(e.message)
      || /^RWS2 subscribe POST (?:timed out after|did not complete within)/.test(e.message);
  }

  /**
   * A subscribe attempt failed: the next retry is due after the backoff,
   * returned in ms. Undefined when the adapter cannot subscribe at all
   * (`UNSUPPORTED_OPERATION`): no retry then on this connection. Any other
   * failure (a timeout, a 503, a group the controller refused) may pass.
   *
   * After SUBSCRIBE_UNANSWERED_MAX creates in a row that got no answer in
   * time (isUnansweredCreate; the one at connect counts), the retries are
   * SUBSCRIBE_RETRY_SLOW_MS (10 minutes) apart until a create is answered,
   * refused or not: each unanswered create may leave a group on the
   * controller, and on RWS 1.0 it holds the session's requests behind it for
   * up to 10 s, all but a stop, motors off, deleting a group or the logout
   * (WsSubscriber.createGroup).
   */
  private subscribeAttemptFailed(e: unknown): number | undefined {
    if (e instanceof RwsError && e.code === 'UNSUPPORTED_OPERATION') {
      this.subscribeRetryDueAt = null;
      return undefined;
    }
    // A create this client cut short for a stop, a release or the logout
    // (RWS 1.0, HttpSession.enqueue) was neither answered nor timed out: the
    // count of unanswered creates in a row stays as it was.
    if (!RobotManager.isCutCreate(e)) {
      this.subscribeUnanswered = RobotManager.isUnansweredCreate(e) ? this.subscribeUnanswered + 1 : 0;
    }
    return this.scheduleSubscribeRetry();
  }

  /** A group create the RWS 1.0 session cut short so a reducing request could go out (HttpSession.enqueue). */
  private static isCutCreate(e: unknown): boolean {
    return e instanceof RwsError && e.code === 'NETWORK_ERROR' && e.message.startsWith(CUT_CREATE);
  }

  /**
   * One more failure in a row: the next subscribe retry is due after the
   * backoff (5, 10, 20, 40, then 60 s; 10 minutes after unanswered creates,
   * see subscribeAttemptFailed), returned in ms.
   */
  private scheduleSubscribeRetry(): number {
    this.subscribeFails++;
    const waitMs = this.subscribeUnanswered >= RobotManager.SUBSCRIBE_UNANSWERED_MAX
      ? RobotManager.SUBSCRIBE_RETRY_SLOW_MS
      : RobotManager.backoffMs(this.subscribeFails, RobotManager.SUBSCRIBE_RETRY_MS, RobotManager.SUBSCRIBE_RETRY_CAP_MS);
    this.subscribeRetryDueAt = Date.now() + waitMs;
    this.subscribeRetryWaitMs = waitMs;
    return waitMs;
  }

  /** The wait a failed subscribe's log line names: in seconds, and why it is long after unanswered creates. */
  private subscribeWaitText(waitMs: number): string {
    if (waitMs < RobotManager.SUBSCRIBE_RETRY_SLOW_MS) { return `${waitMs / 1000} s`; }
    return `${waitMs / 60_000} minutes (${this.subscribeUnanswered} creates in a row got no answer, and each may leave a group on the controller)`;
  }

  /**
   * Run at the end of every poll that succeeded (only there: a failed poll
   * holds it off): while connected without an event stream (the subscribe
   * at connect failed, or the adapter gave the stream up,
   * handleSubscriptionLost), subscribe again once the backoff is over, timed
   * by the clock as the signal table's walk is (a due time further out than
   * the wait it was set with means the clock was set back: due now). Not
   * while a connect is in flight, while a retry is in flight (one at a time,
   * across connections too), nor for a poll of an older connection. Not
   * awaited: the poll does not wait for the subscribe.
   */
  private retrySubscriptionsIfDue(generation: number): void {
    if (this.subscriptionActive || this.subscribeRetryDueAt === null || this.subscribeRetry) { return; }
    if (!this.adapter || !this._state.connected || this.connectingPromise) { return; }
    // A backstop: fetchAll returns before this for a poll of an older
    // generation, and the teardown moves both epochs with the generation.
    if (generation !== this.pollGeneration || this.sessionEpoch !== this.connectEpoch) { return; }
    if (!RobotManager.dueByClock(this.subscribeRetryDueAt, this.subscribeRetryWaitMs)) { return; }
    const adapter = this.adapter;
    const done: Promise<void> = this.retrySubscriptions(adapter)
      .catch(e => { Logger.warn(`WS subscriptions: the retry failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { if (this.subscribeRetry?.done === done) { this.subscribeRetry = null; } });
    this.subscribeRetry = { adapter, done };
  }

  /**
   * One subscribe retry (retrySubscriptionsIfDue). On success the manager
   * ends as a subscribe at connect leaves it: the stream active, its unbound
   * resources read, the poll timer at the rate pollIntervalMs gives, the
   * quality `live` (or `polling` while a status resource is unbound) with
   * the reason "WebSocket events streaming after a retry", and one
   * immediate full poll to resync, as a restored stream gets (unless a poll
   * is in flight). A failure is logged once at info, with the next wait.
   * A subscribe that lands after a disconnect, a reconnect or a supersede
   * (another connection, poll generation or adapter) unsubscribes the group
   * it got and changes nothing.
   */
  private async retrySubscriptions(adapter: IRWSAdapter): Promise<void> {
    const epoch = this.connectEpoch;
    const generation = this.pollGeneration;
    const retry = this.subscribeFails;
    const current = (): boolean => epoch === this.connectEpoch && generation === this.pollGeneration
      && adapter === this.adapter && this._state.connected && !this.subscriptionActive;
    // The handle of a stream the adapter gave up (handleSubscriptionLost) is
    // let go first: ABB's RWS 1.0 allows two groups per client.
    const lost = this.unsubscribeFn;
    if (lost) {
      this.unsubscribeFn = null;
      await lost().catch(() => {});
      if (!current()) { return; }
    }
    let handle: () => Promise<void>;
    try {
      handle = await this.subscribeStatusGroup(adapter);
    } catch (e) {
      if (!current()) { return; }
      const why = e instanceof Error ? e.message : String(e);
      const waitMs = this.subscribeAttemptFailed(e);
      // Info, not warn: polling is the designed fallback.
      Logger.info(waitMs === undefined
        ? `WS subscriptions: retry ${retry} failed (${why}); the adapter cannot subscribe, so polling continues without further retries on this connection`
        : `WS subscriptions: retry ${retry} failed (${why}); polling continues, the next retry in ${this.subscribeWaitText(waitMs)}`);
      return;
    }
    if (!current()) {
      // Not this connection's group: let it go, change nothing.
      await handle().catch(() => {});
      return;
    }
    this.unsubscribeFn = handle;
    this.subscriptionActive = true;
    this.resetSubscribeRetry();
    this.noteUnboundResources();
    if (this.timer) { this.installPollTimer(this.pollGeneration); }
    Logger.info(`WS subscriptions started on retry ${retry} - events streaming, resyncing state`);
    // A failed poll meanwhile keeps `stale`; the next poll that succeeds heals it to the stream's quality.
    if (this._state.quality !== 'stale') {
      this.setQuality(this.streamQuality(), this.liveQualityReason('WebSocket events streaming after a retry'));
    }
    if (this.fetchInFlight) { return; }
    void this.fetchAll(this.pollGeneration);
  }

  /**
   * Adapter reports the event stream as terminally lost (WS reconnect attempts
   * exhausted). Drop back to the fast polling cadence so state stays fresh -
   * without this the manager keeps the 5× slow poll and the UI goes stale.
   * While connected, the manager subscribes again on the backoff a failed
   * subscribe at connect gets, from its first step (5 s; see
   * retrySubscriptionsIfDue).
   */
  private handleSubscriptionLost(): void {
    if (!this.subscriptionActive) { return; }
    this.subscriptionActive = false;
    // No group is left: nothing is unbound, everything is polled.
    this.unboundResources = new Set();
    // Not connected, or a teardown has begun (sessionEpoch): nothing to poll or retry for.
    if (!this._state.connected || this.sessionEpoch !== this.connectEpoch) {
      Logger.warn('live event stream lost - resuming fast polling');
      return;
    }
    this.resetSubscribeRetry();
    const waitMs = this.scheduleSubscribeRetry();
    Logger.warn(`live event stream lost - resuming fast polling, subscribing again in ${this.subscribeWaitText(waitMs)}`);
    // Quality only changes while still connected: a loss racing a teardown
    // must not overwrite the 'disconnected' state the teardown set.
    if (!this.timer) { return; }
    this.setQuality('polling', 'live event stream lost - fast polling');
    this.installPollTimer(this.pollGeneration);
  }

  /**
   * Adapter reports the event stream reconnected after a gap. State changes
   * during the gap produced no events, so run one immediate full poll to
   * resync; the slow subscription cadence stays in place.
   *
   * The reconnect created a new group, judged on its own answer: its
   * unbound resources are read again, and the poll timer moves to the fast
   * or the slow rate when that changes what the stream brings.
   */
  private handleSubscriptionRestored(): void {
    if (!this.subscriptionActive || !this._state.connected) { return; }
    Logger.info('live event stream restored - resyncing state');
    this.noteUnboundResources();
    if (this.timer && this.pollEveryMs !== this.pollIntervalMs()) { this.installPollTimer(this.pollGeneration); }
    this.setQuality(this.streamQuality(), this.liveQualityReason('live event stream restored'));
    if (this.fetchInFlight) { return; }
    void this.fetchAll(this.pollGeneration);
  }

  private handleSubscriptionEvent(event: SubscriptionEvent): void {
    if (!this._state.connected) { return; }
    // Raw tap first: consumers of resources the manager does not consume
    // (e.g. signals) must see the event even when nothing below matches it.
    // Same throw-guard rule as notify().
    for (const tap of [...this.eventTaps]) {
      try { tap(event); } catch (e) {
        Logger.warn(`onSubscriptionEvent tap threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    let changed = false;

    // event.resource is a friendly name ('controllerstate') from the RWS 2.0
    // client, which maps its hrefs itself, or the raw href
    // ('/rw/panel/ctrlstate') from the RWS 1.0 subscriber. Both go through the
    // same anchored mapping, so only the panel and execution resources match -
    // never a signal (or any other path) that merely contains one of their
    // names, as the unanchored fragments here used to.
    const r = Rws2Core.resourcePathToName(event.resource);

    const isCtrlState = r === 'controllerstate';
    const isOpMode    = r === 'operationmode';
    const isSpeed     = r === 'speedratio';
    const isExec      = r === 'execution';
    const isColdet    = r === 'coldetstate';
    const isElog      = r === 'elog';

    const stamp = (f: 'ctrlstate' | 'opmode' | 'speedRatio' | 'execstate' | 'coldetstate'): void => {
      this.fieldEventSeq.set(f, ++this.eventSeq);
    };

    if (isCtrlState) {
      stamp('ctrlstate');
      if (this._state.ctrlstate !== event.value) { this._state.ctrlstate = event.value; changed = true; }
    } else if (isOpMode) {
      stamp('opmode');
      this.observeOpmode(event.value);
      if (this._state.opmode !== event.value) { this._state.opmode = event.value; changed = true; }
    } else if (isSpeed) {
      const n = Number(event.value);
      if (!isNaN(n)) { stamp('speedRatio'); }
      if (!isNaN(n) && this._state.speedRatio !== n) { this._state.speedRatio = n; changed = true; }
    } else if (isExec) {
      stamp('execstate');
      if (this._state.execstate !== event.value) { this._state.execstate = event.value; changed = true; }
    } else if (isColdet) {
      stamp('coldetstate');
      if (this._state.coldetstate !== event.value) {
        this._state.coldetstate = event.value as CollisionDetectionState;
        changed = true;
      }
    } else if (isElog) {
      // New elog message arrived - refresh the log asynchronously, coalesced.
      this.refreshEventLogOnEvent();
      return; // notify() called inside the refresh
    }

    if (changed) { this.notify(); }
  }

  /**
   * Re-read the domain-0 event log because a subscription event said it
   * changed.
   *
   * Only the newest page is read, and merged into the log by sequence number
   * (mergeEventLogPage): on RWS 2.0 one newest-first page (`v=2.1`, 50
   * messages), where a whole read walks up to 20 pages (readWholeEventLog);
   * on RWS 1.0 the same single request as a whole read, whose first page is
   * already the newest 50. The whole log is still read after connect (until
   * a whole read has landed on this connection), on the slow poll, when the
   * newest page does not reach back to the messages already held (more new
   * messages than one page), and when the controller refuses the
   * newest-first read. The whole walk cost 12 pages and 1.6-2.1 s on
   * RW 7.21.4 with 548 messages in domain 0, and delayed a speed-ratio event
   * that arrived during it by 1.1-1.5 s (functional suite, 10-subscriptions,
   * 2026-09-30); a list page takes 130-260 ms there.
   *
   * Coalesced: while a read is in flight, further elog events only set a
   * flag, and exactly one more read runs when the in-flight one settles.
   * N events during a read cost two reads, never N; under a continuous
   * flood the reads run back to back, one at a time. Without this, a
   * controller that floods the log would drive this manager into a
   * continuous re-read - a hypothetical from a release-note title, not an
   * observed event: ABB RobotWare release notes 7.21.1 §2.3 Corrections,
   * "Corrected spamming of elog 36500" (release notes, 2026-09-29), which
   * names no trigger; that it affects RW7 before 7.21.1 is inferred from the
   * fix version, and our 7.21.0 VC did not show it.
   *
   * The poll generation is pinned per read: a disconnect (or a reconnect to
   * another controller) between the dispatch and the response would otherwise
   * write the late log into the fresh/disconnected _state and notify(),
   * surfacing event data on a robot that is no longer connected (or one
   * controller's log on another). The in-flight flag carries the same
   * generation, and disconnectInternal() clears both flags in the same
   * synchronous step as its generation bump (before it awaits the mastership,
   * RMMP and subscription teardown): a read that outlives its connection is
   * ignored when it settles, even mid-teardown, so it never parks
   * the next connection's event-driven reads behind itself nor hands them a
   * queued follow-up. A queued read that becomes due after a disconnect is
   * dropped; the next connection's first poll reads the log.
   */
  private refreshEventLogOnEvent(): void {
    const gen = this.pollGeneration;
    if (this.elogRefreshInFlight === gen) { this.elogRefreshQueued = true; return; }
    const adapter = this.adapter;
    if (!adapter) { return; }
    this.elogRefreshInFlight = gen;
    this.elogRefreshQueued = false;
    // A third-party adapter whose getEventLog throws synchronously (not an
    // async function) must not leave the in-flight flag set for good: the
    // read below is an async function, so such a throw is a rejection.
    this.readEventLogOnEvent(adapter, gen).catch(() => {}).finally(() => {
      // Superseded (a disconnect cleared the flag, or a newer generation
      // started its own read): leave that generation's flags alone.
      if (this.elogRefreshInFlight !== gen) { return; }
      this.elogRefreshInFlight = null;
      if (!this.elogRefreshQueued) { return; }
      this.elogRefreshQueued = false;
      if (this._state.connected) { this.refreshEventLogOnEvent(); }
    });
  }

  /**
   * One event-driven read (see refreshEventLogOnEvent), written to state
   * only while `gen` is still the current, connected generation. The merge
   * runs against the log as it is when the page lands, so a whole read that
   * landed in the meantime is merged into, not overwritten.
   */
  private async readEventLogOnEvent(adapter: IRWSAdapter, gen: number): Promise<void> {
    const current = (): boolean => gen === this.pollGeneration && this._state.connected;
    const plan = eventLogPagePlan(adapter);
    if (plan && (plan.pageIsWholeRead || (this.elogFullReadGen === gen && this.elogPageRefusedGen !== gen))) {
      let page: ElogMessage[] | null = null;
      try {
        page = await plan.readPage();
      } catch (e) {
        // A controller that refuses the newest-first read (a build without
        // v=2.1 listing) gets whole reads on this connection instead; any
        // other failure fails this read, as a whole read's would.
        if (plan.pageIsWholeRead || !isReadRefusal(e)) { throw e; }
        if (!current()) { return; }
        this.elogPageRefusedGen = gen;
        Logger.info(`the controller refused the newest-first event-log read (${e instanceof Error ? e.message : String(e)}); elog events read the whole log on this connection`);
      }
      if (!current()) { return; }
      if (page) {
        // RWS 1.0: this page is what a whole read returns, so the result holds
        // exactly its messages (in wrap-aware order, and the held array itself
        // when they are the same); nothing older is kept past it.
        const shape = plan.pageIsWholeRead ? { ...plan.shape, limit: Math.min(plan.shape.limit, page.length) } : plan.shape;
        const merged = mergeEventLogPage(this._state.eventLog, page, shape);
        if (plan.pageIsWholeRead) { this.elogFullReadGen = gen; }
        if (merged) { this.setEventLog(merged); return; }
        if (plan.pageIsWholeRead) { this.setEventLog(page); return; }
        Logger.trace?.('elog', 'the newest event-log page does not reach back to the messages already held; reading the whole log');
      }
    }
    const writes = this.elogWrites;
    const log = await this.readWholeEventLog(adapter, gen);
    if (!current()) { return; }
    this.elogFullReadGen = gen;
    this.setEventLog(this.landWholeEventLog(adapter, log, writes));
  }

  /**
   * A whole read of the domain-0 log, as `state.eventLog` holds it.
   *
   * RWS 2.0: the newest 1000 messages (20 pages of 50), read newest first
   * (`v=2.1`, paged by `elogseqnum`, see RwsClient2.getEventLog) and put
   * oldest first by sequence number, the order the manager has always
   * exposed. The oldest-first walk it replaces stops after 20 pages too, so
   * once a domain holds more than 1000 messages it would return the OLDEST
   * 1000: the newest would be missing from state, and no elog event's page
   * could reach the held log, so every event would fall back to a 20-page
   * walk. RW 7.21.4 held 548 messages in domain 0 after three full suite
   * runs (functional suite, 2026-09-30); whether it caps the domain at 1000
   * is not known. A controller that refuses the newest-first read gets the
   * oldest-first walk for the rest of the connection, as events do.
   *
   * RWS 1.0: the newest page, newest first, as `state.eventLog` has always
   * held it there (RWS1_EVENT_LOG); `getEventLog()` reads every page. Adapters
   * of another make: the adapter's own whole read.
   */
  private async readWholeEventLog(adapter: IRWSAdapter, gen: number | undefined): Promise<ElogMessage[]> {
    if (adapter instanceof RWS1Adapter) { return adapter.getEventLog(0, 'en', 1); }
    if (adapter instanceof RWS2Adapter && (gen === undefined || this.elogPageRefusedGen !== gen)) {
      try {
        const log = await adapter.getEventLog(0, 'en', RWS2_EVENT_LOG.limit / RWS2_EVENT_LOG.pageSize, 'newest');
        return [...log].sort((a, b) => compareElogSeqnum(a.seqnum, b.seqnum, false));
      } catch (e) {
        if (!isReadRefusal(e)) { throw e; }
        if (gen !== undefined && gen === this.pollGeneration) { this.elogPageRefusedGen = gen; }
        Logger.info(`the controller refused the newest-first event-log read (${e instanceof Error ? e.message : String(e)}); the whole log is read oldest first on this connection`);
      }
    }
    return adapter.getEventLog(0, 'en');
  }

  /**
   * The log to hold once a whole read sent at write count `writesAtSend`
   * lands. Unchanged when nothing wrote the log meanwhile. Otherwise an
   * event's page merge that landed first may hold messages newer than the
   * read's newest, and replacing the log with the read would drop them
   * until the next elog event: those are kept (keepNewerEventLog).
   */
  private landWholeEventLog(adapter: IRWSAdapter, log: ElogMessage[], writesAtSend: number): ElogMessage[] {
    if (this.elogWrites === writesAtSend) { return log; }
    const shape = eventLogPagePlan(adapter)?.shape;
    return shape ? keepNewerEventLog(log, this._state.eventLog, shape) : log;
  }

  /** The one place `state.eventLog` is written on a live connection (counted, see elogWrites). */
  private writeEventLog(log: ElogMessage[]): void {
    this.elogWrites++;
    this._state.eventLog = log;
  }

  /** Put `log` in state and notify, unless it is the log already there. */
  private setEventLog(log: ElogMessage[]): void {
    if (log === this._state.eventLog) { return; }
    this.writeEventLog(log);
    this.notify();
  }

  // ─── Session cookie ──────────────────────────────────────────────────────────

  /**
   * The session file's key for one connection: `host:port#verifier`, where
   * the verifier is a scrypt hash (node:crypto) of the username and password,
   * salted with the host, port and username. The file never holds the
   * password.
   *
   * A saved cookie is reused only by a connect with the same host, port,
   * username and password. Every other connect logs in with the credentials
   * it was given, and a refused login is reported as AUTH_FAILED.
   *
   * Entries under the old `host:port` key are left alone (clients up to
   * 1.3.x read and write them) and are never read here. The values stay
   * plain cookie strings, so those clients still read the file.
   */
  private static sessionFileKey(host: string, port: number, username: string, password: string): string {
    const verifier = scryptSync(`${username}\n${password}`, `abb-rws-session\n${host}:${port}\n${username}`, 16, { N: 4096 });
    return `${host}:${port}#${verifier.toString('hex')}`;
  }

  /** This connection's entry in the session file, as saved at connect; removed after its logout. */
  private savedSessionCookie: { key: string; cookie: string } | null = null;

  private loadSessionCookie(key: string): string | null {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))[key];
      return typeof value === 'string' && value ? value : null;
    } catch { return null; }
  }

  private saveSessionCookie(key: string, cookie: string): void {
    try {
      let data: Record<string, string> = {};
      try { data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { /* new file */ }
      data[key] = cookie;
      this.writeSessionFile(data);
    } catch { /* non-fatal */ }
  }

  /**
   * Remove `key` from the session file while it still holds `cookie`. A
   * different value was saved since by another manager with the same
   * credentials, for its own session, and stays.
   */
  private forgetSessionCookie(key: string, cookie: string): void {
    try {
      let data: Record<string, string>;
      try { data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return; /* no file */ }
      if (data[key] !== cookie) { return; }
      delete data[key];
      this.writeSessionFile(data);
    } catch { /* non-fatal */ }
  }

  private writeSessionFile(data: Record<string, string>): void {
    try {
      // The file is shared across every RobotManager (and every host process),
      // so replace it atomically: write a temp file in the same directory,
      // then rename over the real one. A plain write lets a concurrent
      // manager read a half-written file and drop entries.
      const tmp = `${SESSION_FILE}.${process.pid}.${Date.now()}.tmp`;
      // Owner-only: the file holds live session cookies. The mode is set as
      // the temp file is created and carries over with the rename.
      fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      try {
        fs.renameSync(tmp, SESSION_FILE);
      } catch {
        // A concurrent writer beat us to the rename (Windows briefly locks the
        // destination) - drop our temp file and let the other writer win; the
        // cookie is re-saved on the next connect anyway.
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      }
      // A file written before this rule, or by an older client that won the
      // rename, may still be readable by other users (0644 under a usual
      // umask). Windows has no POSIX modes; the profile's ACL covers it there.
      if (process.platform !== 'win32') {
        try { fs.chmodSync(SESSION_FILE, 0o600); } catch { /* best effort */ }
      }
    } catch { /* non-fatal */ }
  }

  // ─── Polling ─────────────────────────────────────────────────────────────────

  private fetchCount = 0;

  /**
   * The poll walks the whole signal table (listAllSignals, one request per
   * page of signals) at connect, then once SIGNAL_TABLE_REFRESH_MS after the
   * last walk that landed, timed by the clock and not by the number of
   * polls. A failed walk is tried again after SIGNAL_TABLE_RETRY_MS, doubling
   * per failure in a row up to SIGNAL_TABLE_REFRESH_MS (5, 10, 20, 40, then
   * 60 s), never on every poll. Before, the table was walked on the first
   * poll, every fifth poll and every poll until a load succeeded: on an IRC5
   * with about 3000 signals that is about 30 requests, and the poll waits
   * for them. `refreshIoSignals()` walks at once and restarts the interval.
   *
   * The poll's walk and a `refreshIoSignals()` can run at the same time. A
   * walk that started before the one whose table is in the state was read
   * earlier, so when it lands it changes neither the table nor the schedule;
   * a walk that fails after another landed while it ran leaves the schedule
   * alone, as the table is fresh (signalTableStart, signalTableLanded,
   * signalTableFailed).
   */
  private static readonly SIGNAL_TABLE_REFRESH_MS = 60_000;
  /** The wait after the first failed walk; see SIGNAL_TABLE_REFRESH_MS. */
  private static readonly SIGNAL_TABLE_RETRY_MS = 5_000;
  /** When the next walk is due (Date.now() ms); 0 means on the next poll. */
  private signalTableDueAt = 0;
  /** Walks that failed in a row on this connection: the retry's step. */
  private signalTableFails = 0;
  /** Counts each walk's start and each landing, in the order they happen. */
  private signalTableSeq = 0;
  /** The start mark of the walk whose table is in the state. */
  private signalTableShown = 0;
  /** The mark of the last landing. */
  private signalTableLastLanding = 0;

  /** The next poll walks the signal table (a new connection). */
  private resetSignalTableSchedule(): void {
    this.signalTableDueAt = 0;
    this.signalTableFails = 0;
  }

  /**
   * Whether this poll walks the signal table. A due time further out than
   * the longest wait (SIGNAL_TABLE_REFRESH_MS) means the clock was set back
   * since it was set: the walk is due now, not that much later.
   */
  private signalTableDue(): boolean {
    return RobotManager.dueByClock(this.signalTableDueAt, RobotManager.SIGNAL_TABLE_REFRESH_MS);
  }

  /**
   * Whether a due time (Date.now() ms) has come. One further out than
   * `capMs`, the longest wait it can have been set to, means the clock was
   * set back since: due now, not that much later. Shared by the signal
   * table's walk and the subscribe retry.
   */
  private static dueByClock(dueAt: number, capMs: number): boolean {
    const left = dueAt - Date.now();
    return left <= 0 || left > capMs;
  }

  /** The wait after `fails` failures in a row: `firstMs` doubling per failure, at most `capMs`. */
  private static backoffMs(fails: number, firstMs: number, capMs: number): number {
    return Math.min(firstMs * 2 ** (fails - 1), capMs);
  }

  /** A walk starts: its mark, for signalTableLanded and signalTableFailed. */
  private signalTableStart(): number {
    return ++this.signalTableSeq;
  }

  /**
   * The walk that started at `mark` landed. False when the table in the
   * state comes from a walk that started later: this one's is older, and is
   * dropped. True otherwise, and the next walk is due a full interval from
   * now; the caller puts the table in the state.
   */
  private signalTableLanded(mark: number): boolean {
    if (mark < this.signalTableShown) { return false; }
    this.signalTableShown = mark;
    this.signalTableLastLanding = ++this.signalTableSeq;
    this.signalTableFails = 0;
    this.signalTableDueAt = Date.now() + RobotManager.SIGNAL_TABLE_REFRESH_MS;
    return true;
  }

  /**
   * The walk that started at `mark` failed: the next one is due after the
   * backoff, returned in ms. Undefined when another walk landed while this
   * one ran: the table is fresh and its schedule stands.
   */
  private signalTableFailed(mark: number): number | undefined {
    if (this.signalTableLastLanding > mark) { return undefined; }
    this.signalTableFails++;
    const waitMs = RobotManager.backoffMs(this.signalTableFails, RobotManager.SIGNAL_TABLE_RETRY_MS, RobotManager.SIGNAL_TABLE_REFRESH_MS);
    this.signalTableDueAt = Date.now() + waitMs;
    return waitMs;
  }

  /** Consecutive poll failures - only disconnects after 3, so transient blips don't drop the connection. */
  private consecutiveFails = 0;

  private fetchInFlight = false;

  private async fetchAll(generation?: number): Promise<void> {
    // Bail if this fetch belongs to an old generation (we've reconnected or
    // disconnected since). Re-checked after every await below - a disconnect
    // mid-poll clears _state, and a late-resolving request must not resurrect
    // the stale snapshot into it.
    const stale = (): boolean => generation !== undefined && generation !== this.pollGeneration;
    if (stale()) { return; }
    if (!this.adapter) { return; }
    if (this.fetchInFlight) { return; }
    this.fetchInFlight = true;
    // Events numbered above this arrived after the reads below were issued.
    const pollSeq = this.eventSeq;
    const newerEvent = (f: 'ctrlstate' | 'opmode' | 'speedRatio' | 'execstate' | 'coldetstate'): boolean =>
      (this.fieldEventSeq.get(f) ?? 0) > pollSeq;
    try {
      const [execInfo, ctrlstate, opmode, speedRatio, tasks, joints, cartesianFull] =
        await Promise.all([
          this.adapter.getRapidExecutionInfo(),
          this.adapter.getControllerState(),
          this.adapter.getOperationMode(),
          this.adapter.getSpeedRatio(),
          this.adapter.getRapidTasks(),
          this.adapter.getJointPositions(),
          this.adapter.getCartesianFull(),
        ]);
      if (stale()) { return; }

      // Module lists need task names - resolve them from the tasks we just
      // fetched, not a hardcoded T_ROB1 (multi-task systems and OmniCore
      // single-arm variants name their tasks differently). MultiMove systems
      // run several ACTIVE motion tasks, each with its own module set, so
      // every active task is listed: `modules` stays the primary task's list,
      // `modulesByTask` carries all of them. The primary list is required (a
      // failure there fails the poll, as before); the others degrade to empty.
      this._state.tasks = tasks;
      const primaryTask = this.activeTaskName();
      const taskNames = [primaryTask, ...tasks.filter(t => t.active && t.name !== primaryTask).map(t => t.name)];
      const lists = await Promise.all(taskNames.map((name, i) =>
        i === 0 ? this.adapter!.listModules(name) : this.adapter!.listModules(name).catch(() => [] as string[])));
      if (stale()) { return; }
      const modulesByTask: Record<string, string[]> = {};
      taskNames.forEach((name, i) => { modulesByTask[name] = lists[i]; });
      const modules = lists[0];

      const cartesian = { x: cartesianFull.x, y: cartesianFull.y, z: cartesianFull.z, q1: cartesianFull.q1, q2: cartesianFull.q2, q3: cartesianFull.q3, q4: cartesianFull.q4 };
      if (!newerEvent('opmode')) { this.observeOpmode(opmode); }
      Object.assign(this._state, {
        execCycle: execInfo.cycle, tasks, modules, modulesByTask, joints, cartesian, cartesianFull,
        // Subscribed fields: keep a value an event set while this poll was in flight.
        ...(newerEvent('ctrlstate') ? {} : { ctrlstate }),
        ...(newerEvent('opmode') ? {} : { opmode }),
        ...(newerEvent('execstate') ? {} : { execstate: execInfo.state }),
        ...(newerEvent('speedRatio') ? {} : { speedRatio }),
      });

      const coldetstate = await this.adapter.getCollisionDetectionState().catch(() => null);
      if (stale()) { return; }
      if (!newerEvent('coldetstate')) { this._state.coldetstate = coldetstate; }

      this.fetchCount++;
      // Identity / systemInfo / eventLog / mechunits - only refresh occasionally,
      // BUT keep retrying every poll until they're populated (so a transient first-poll
      // failure doesn't leave the Status panel stuck on the IP fallback forever).
      const needSlowFetch =
        this.fetchCount === 1 ||
        this.fetchCount % 30 === 0 ||
        !this._state.systemInfo ||
        !this._state.identity;

      if (needSlowFetch) {
        const adapter = this.adapter;
        const elogWrites = this.elogWrites;
        const [identity, systemInfo, eventLog, mechunits] = await Promise.all([
          this.adapter.getControllerIdentity().catch(e => { Logger.warn(`getControllerIdentity failed: ${e instanceof Error ? e.message : String(e)}`); return null; }),
          this.adapter.getSystemInfo().catch(e => { Logger.warn(`getSystemInfo failed: ${e instanceof Error ? e.message : String(e)}`); return null; }),
          this.readWholeEventLog(adapter, generation).catch(e => { Logger.warn(`getEventLog failed: ${e instanceof Error ? e.message : String(e)}`); return null; }),
          // A failed read leaves the list as it was: [] on a new connection, never a guessed unit.
          this.adapter.listMechunits().catch(e => { Logger.warn(`listMechunits failed: ${e instanceof Error ? e.message : String(e)}`); return null; }),
        ]);
        if (stale()) { return; }
        if (identity)   { this._state.identity   = identity; }
        if (systemInfo) {
          this._state.systemInfo = systemInfo;
          // Remembered so a later port recovery can prove it found THIS controller.
          if (systemInfo.sysid) { this.knownSystemId = systemInfo.sysid; }
        }
        // A failed read empties the log, as before, and leaves no base for the
        // page merges of later elog events: they read it whole until a whole
        // read lands again.
        this.writeEventLog(eventLog ? this.landWholeEventLog(adapter, eventLog, elogWrites) : []);
        if (generation !== undefined) { this.elogFullReadGen = eventLog ? generation : null; }
        if (mechunits) { this._state.mechunits = mechunits; }
      } else if (this.subscriptionActive && this.unboundNames().includes('elog') && this.fetchCount % this.unboundElogEvery() === 0) {
        // The controller did not bind the event log to the group, so no elog
        // event will ever say it changed: the poll stands in for them, on
        // the event's own path (refreshEventLogOnEvent: the newest page,
        // merged, coalesced and pinned to this generation; the whole log
        // until a whole read has landed). Not awaited, as an event's read is
        // not; it notifies when it lands.
        this.refreshEventLogOnEvent();
      }

      // The signal table: at connect, then a minute after the last walk that
      // landed; a failed walk is tried again after a backoff, so a 503 in the
      // connect burst is retried in 5 s, not on every poll (see
      // SIGNAL_TABLE_REFRESH_MS).
      if (this.signalTableDue()) {
        const mark = this.signalTableStart();
        try {
          // One call returns every signal: the adapter walks the controller's
          // pagination itself (an outer loop here would duplicate entries).
          const all = await this.adapter.listAllSignals();
          if (stale()) { return; }
          if (this.signalTableLanded(mark)) {
            this._state.ioSignals = all;
            this._state.ioSignalsLoaded = true;
          }
        } catch (e) {
          // Non-fatal to the poll, but not silent: until a load succeeds,
          // ioSignalsLoaded stays false and the table is not this connection's.
          if (stale()) { return; }
          const why = e instanceof Error ? e.message : String(e);
          const waitMs = this.signalTableFailed(mark);
          Logger.warn(waitMs === undefined
            ? `listAllSignals failed: ${why}; another read of the signal table landed meanwhile, so that table stands`
            : `listAllSignals failed: ${why}; the signal table is read again in ${waitMs / 1000} s`);
        }
      }

      if (stale()) { return; }
      this.consecutiveFails = 0;
      // Refreshes what only changes without an event (the watchdog's last reset).
      this._state.access = this.accessSnapshot();
      // A successful poll heals a stale connection back to its real quality
      if (this._state.quality === 'stale') {
        this.setQuality(
          this.subscriptionActive ? this.streamQuality() : 'polling',
          this.subscriptionActive
            ? this.liveQualityReason('poll succeeded - connection recovered')
            : 'poll succeeded - connection recovered',
        );
      }
      this.notify();
      // Without an event stream on this connection: subscribe again once the
      // backoff is over (retrySubscriptionsIfDue; not awaited).
      this.retrySubscriptionsIfDue(generation ?? this.pollGeneration);
    } catch (e) {
      // Stale poll (disconnect or reconnect happened mid-flight) - don't count this failure.
      if (stale()) { return; }

      this.consecutiveFails++;
      // First failure is usually transient (controller queued behind motion).
      // Log at info-level for the first; only warn from the second onward.
      const msg = `poll failed (${this.consecutiveFails}/3) - ${e instanceof Error ? e.message : String(e)}`;
      if (this.consecutiveFails >= 2) { Logger.warn(msg); }
      else                            { Logger.info(msg); }
      if (this.consecutiveFails < 3) {
        this.setQuality('stale', `${this.consecutiveFails} consecutive poll failure${this.consecutiveFails > 1 ? 's' : ''} - data may be outdated`);
      }
      if (this.consecutiveFails >= 3) {
        const reason = e instanceof Error ? e.message : String(e);
        Logger.error(`disconnecting after 3 failed polls`, e);
        Logger.show();
        // Holds still counted cannot be relied on once the connection is gone
        // (ABB documents lost communication among the ways mastership is
        // lost): reported as lost, not as released, before the teardown.
        const access = this.adapter ? this.accessIfAny(this.adapter) : undefined;
        const held = access?.heldLocks() ?? [];
        if (access && held.length > 0) {
          access.recordLoss(held, 'connection-lost', `the connection to the controller failed (3 polls in a row: ${reason}), so this client can no longer rely on the hold`);
        }
        // Capture config BEFORE disconnect (which clears it) so the Reconnect button works.
        // Internal variant: this tears down the DEAD connection - it must not
        // cancel a fresh connect attempt the user may have started meanwhile.
        const cfg = this.adapterConfig;
        await this.disconnectInternal();
        this.setQuality('disconnected', `auto-disconnected after 3 failed polls: ${reason}`);
        // Hand off to the host's error listener (VS Code extension, CLI, etc.).
        // If no listener is installed, the failure is silent beyond the log lines above.
        if (this.errorListener) {
          this.errorListener(`ABB Robot disconnected: ${reason}`, ['Show Logs', 'Reconnect']).then(choice => {
            if (choice === 'Show Logs') { Logger.show(); }
            if (choice === 'Reconnect' && cfg) {
              this.connect(cfg.host, cfg.username, cfg.password, cfg.port)
                .catch(err => Logger.error('reconnect failed', err));
            }
          });
        }
      }
    } finally {
      this.fetchInFlight = false;
    }
  }
}

// ─── Resources the controller did not bind ────────────────────────────────────

/**
 * The status resources of the manager's group that every poll reads (by the
 * names Rws2Core.resourcePathToName gives them), and what each is called in
 * the quality reason. While one of them is unbound the poll runs at the fast
 * rate (pollIntervalMs).
 */
const POLLED_STATUS: Readonly<Record<string, string>> = {
  controllerstate: 'the controller state',
  operationmode: 'the operating mode',
  speedratio: 'the speed ratio',
  execution: 'the execution state',
  coldetstate: 'the collision detection state',
};

/** Every unbound resource the poll reads, with its name in the quality reason: the status resources and the event log. */
const UNBOUND_LABEL: Readonly<Record<string, string>> = { ...POLLED_STATUS, elog: 'the event log' };

/** True for a resource name (resourcePathToName) of POLLED_STATUS. */
function isPolledStatus(name: string): boolean {
  return Object.hasOwn(POLLED_STATUS, name);
}

/** The quality reason's name for an unbound resource the poll reads, or undefined for one it does not read. */
function unboundLabel(uri: string): string | undefined {
  const name = Rws2Core.resourcePathToName(uri);
  return Object.hasOwn(UNBOUND_LABEL, name) ? UNBOUND_LABEL[name] : undefined;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** System ids are GUIDs; compare them without braces or case. */
function normaliseSystemId(id: string): string {
  return id.trim().replace(/^\{|\}$/g, '').toLowerCase();
}

// ─── Event-log page merge ─────────────────────────────────────────────────────

/** Messages per event-log list page: 50 on RWS 2.0 (see RwsClient2.getEventLog) and on RW 6.16's RWS 1.0 listing. */
const ELOG_PAGE_SIZE = 50;

/** RWS 1.0 sequence numbers are 16-bit and start again after 65,535. */
const RWS1_SEQNUM_SPAN = 65536;

/** How one generation's event log is ordered and bounded in `RobotState.eventLog`. */
export interface EventLogShape {
  /** RWS 1.0: sequence numbers wrap at 2^16 and are compared as serial numbers. */
  wrap: boolean;
  /** Newest first (RWS 1.0, as it lists), or oldest first (RWS 2.0, as a whole read walks it). */
  newestFirst: boolean;
  /** Most messages kept: as many as the generation's whole read returns. */
  limit: number;
  /** Messages per list page: a shorter page, read onto an empty log, holds every message since it was emptied. */
  pageSize: number;
}

/** RWS 2.0: a whole read is the newest 20 pages, held oldest first (RobotManager.readWholeEventLog). */
const RWS2_EVENT_LOG: EventLogShape = { wrap: false, newestFirst: false, limit: 20 * ELOG_PAGE_SIZE, pageSize: ELOG_PAGE_SIZE };
/** RWS 1.0: the manager's whole read is the first page, newest first (RWS1Adapter.getEventLog with one page). */
const RWS1_EVENT_LOG: EventLogShape = { wrap: true, newestFirst: true, limit: ELOG_PAGE_SIZE, pageSize: ELOG_PAGE_SIZE };

/**
 * Which of two event-log sequence numbers is later: negative when `a` is
 * earlier, positive when later, 0 when equal. With `wrap` (RWS 1.0) they are
 * 16-bit serial numbers, as the daemon compares them: `a` is later when it is
 * less than half the span ahead of `b`, counting on past 65,535, so 2 follows
 * 65,534. RW 6.13.02 wrapped the count at 2^16 in listings and events (ABB
 * tech-community thread 10673; "Elog Issue using RWS on IRC5" is a 6.13.04
 * correction, title only; release notes, 2026-09-29). Without `wrap`, plainly.
 */
export function compareElogSeqnum(a: number, b: number, wrap: boolean): number {
  if (!wrap) { return a - b; }
  const ahead = (((a - b) % RWS1_SEQNUM_SPAN) + RWS1_SEQNUM_SPAN) % RWS1_SEQNUM_SPAN;
  if (ahead === 0) { return 0; }
  return ahead < RWS1_SEQNUM_SPAN / 2 ? 1 : -1;
}

/**
 * Merge the newest page of the domain-0 log into the log already held, by
 * sequence number. Returns the log to expose (in `shape`'s order, at most
 * `shape.limit` messages, the newest kept), `log` itself when nothing
 * changed, or null when the page cannot be merged and the whole log must be
 * read instead:
 * - an empty page (an elog event announced a message), or a message without
 *   a usable sequence number (the parsers report a missing one as 0, which
 *   is a number only on RWS 1.0, where the count passes 0);
 * - a page whose oldest message is newer than every message held: more
 *   messages may have arrived than one page holds, and the ones between are
 *   unknown (sequence numbers are shared across domains, so a gap in the
 *   numbers proves nothing). A log cleared by another client, whose numbers
 *   go on, lands here too, and the whole read replaces it;
 * - nothing held yet (a log this manager cleared) and a full page.
 *
 * Otherwise the page is authoritative for its own range, the newest there
 * is: held messages older than its oldest are kept, and any in its range or
 * newer that it does not list are dropped. A page shorter than a full one
 * onto an empty log holds every message since the log was emptied.
 */
export function mergeEventLogPage(
  log: readonly ElogMessage[], page: readonly ElogMessage[], shape: EventLogShape,
): ElogMessage[] | null {
  const usable = (m: ElogMessage): boolean =>
    Number.isInteger(m.seqnum) && m.seqnum >= 0 && (shape.wrap || m.seqnum > 0);
  if (page.length === 0 || !page.every(usable)) { return null; }
  const cmp = (a: ElogMessage, b: ElogMessage): number => compareElogSeqnum(a.seqnum, b.seqnum, shape.wrap);
  const newestFirst = (a: ElogMessage, b: ElogMessage): number => cmp(b, a);
  const inOrder = (list: ElogMessage[]): ElogMessage[] => list.sort(shape.newestFirst ? newestFirst : cmp);
  const bounded = (list: ElogMessage[]): ElogMessage[] => {
    if (list.length <= shape.limit) { return list; }
    return shape.newestFirst ? list.slice(0, shape.limit) : list.slice(list.length - shape.limit);
  };
  const seen = new Set<number>();
  const fresh = page.filter(m => (seen.has(m.seqnum) ? false : (seen.add(m.seqnum), true)));

  let merged: ElogMessage[];
  if (log.length === 0) {
    if (fresh.length >= shape.pageSize) { return null; }
    merged = bounded(inOrder(fresh));
  } else {
    if (!log.every(usable)) { return null; }
    const oldestInPage = fresh.reduce((o, m) => (cmp(m, o) < 0 ? m : o));
    const newestHeld = log.reduce((n, m) => (cmp(m, n) > 0 ? m : n));
    if (cmp(oldestInPage, newestHeld) > 0) { return null; }
    const older = log.filter(m => cmp(m, oldestInPage) < 0 && !seen.has(m.seqnum));
    merged = bounded(inOrder([...fresh, ...older]));
  }
  const same = merged.length === log.length && merged.every((m, i) => m.seqnum === log[i].seqnum);
  return same ? (log as ElogMessage[]) : merged;
}

/**
 * A whole read of the log (`whole`) that lands after another read wrote the
 * log it replaces (`held`): the whole read, plus the held messages newer
 * than its newest, in `shape`'s order and bound. Such messages were logged
 * after the whole read was served (an event's page merge landed first), so
 * dropping them would hide them until the next elog event. Returns `whole`
 * itself when there are none, when it is empty (a cleared log), or when a
 * sequence number is not usable (see mergeEventLogPage).
 */
export function keepNewerEventLog(
  whole: ElogMessage[], held: readonly ElogMessage[], shape: EventLogShape,
): ElogMessage[] {
  const usable = (m: ElogMessage): boolean =>
    Number.isInteger(m.seqnum) && m.seqnum >= 0 && (shape.wrap || m.seqnum > 0);
  if (whole.length === 0 || held.length === 0 || !whole.every(usable) || !held.every(usable)) { return whole; }
  const cmp = (a: ElogMessage, b: ElogMessage): number => compareElogSeqnum(a.seqnum, b.seqnum, shape.wrap);
  const newestInWhole = whole.reduce((n, m) => (cmp(m, n) > 0 ? m : n));
  const newer = held.filter(m => cmp(m, newestInWhole) > 0);
  if (newer.length === 0) { return whole; }
  const list = [...whole, ...newer].sort(shape.newestFirst ? (a, b): number => cmp(b, a) : cmp);
  if (list.length <= shape.limit) { return list; }
  return shape.newestFirst ? list.slice(0, shape.limit) : list.slice(list.length - shape.limit);
}

/**
 * How an elog event reads the newest page on `adapter`, or null for an
 * adapter of another make, which reads its whole log as before.
 */
function eventLogPagePlan(adapter: IRWSAdapter): {
  shape: EventLogShape; readPage: () => Promise<ElogMessage[]>; pageIsWholeRead: boolean;
} | null {
  if (adapter instanceof RWS2Adapter) {
    // One newest-first page (v=2.1, order=lifo; live-verified 2026-09-29 on
    // RW 7.21.4+417 and 8.2.1+1023, see RwsClient2.getEventLog).
    return { shape: RWS2_EVENT_LOG, readPage: () => adapter.getEventLog(0, 'en', 1, 'newest'), pageIsWholeRead: false };
  }
  if (adapter instanceof RWS1Adapter) {
    // One page: RWS1Adapter.getEventLog reads every page unless asked for one.
    return { shape: RWS1_EVENT_LOG, readPage: () => adapter.getEventLog(0, 'en', 1), pageIsWholeRead: true };
  }
  return null;
}

/** A read the controller refused as a request it does not serve (as opposed to a failure to get through). */
function isReadRefusal(e: unknown): boolean {
  return e instanceof RwsError && e.httpStatus !== undefined && [400, 404, 405, 406, 415].includes(e.httpStatus);
}

/**
 * The name the controller gave a module it loaded under another name, or
 * null. A RobotWare 7.21.4 virtual controller loaded a module that clashed
 * with a name of its own as `<NAME>#2` (2026-10-12). Read from the task's
 * modules before and after the load: null while the module is listed under
 * its own name (RAPID names ignore case); otherwise the newest-listed
 * `<NAME>#<n>` that was not there before.
 */
export function renamedOnLoad(moduleName: string, before: readonly string[], after: readonly string[]): string | null {
  const lower = moduleName.toLowerCase();
  if (after.some(m => m.toLowerCase() === lower)) { return null; }
  const had = new Set(before.map(m => m.toLowerCase()));
  const renamed = after.filter(m => {
    const l = m.toLowerCase();
    return l.startsWith(`${lower}#`) && /^\d+$/.test(l.slice(lower.length + 1)) && !had.has(l);
  });
  return renamed.length > 0 ? renamed[renamed.length - 1] : null;
}

/** "loaded module X into T as X#2, ..." for loadProgram's report. */
function loadedAsSentence(moduleName: string, taskName: string, given: string): string {
  return `loaded module ${moduleName} into ${taskName} as ${given}, the name the controller gave it (unload it by that name)`;
}

/**
 * -1073414145 (0xC004FFFF) "Unknown Error": a generic controller code. RW
 * 7.21.4 answered an unload by a module's original name, after the module
 * had been loaded renamed, with 403 and this code, its text "Reason written
 * in elog" (2026-10-12).
 */
const REASON_IN_EVENT_LOG = -1073414145;

/**
 * The controller's text that says its reason is in the event log. The code
 * alone is generic: other answers carry it for other reasons.
 */
const REASON_IN_EVENT_LOG_TEXT = /\bwritten in elog\b/i;

/** The newest message of the domain-0 event log, or null when the log is empty. */
async function newestEventLogMessage(adapter: IRWSAdapter): Promise<ElogMessage | null> {
  const plan = eventLogPagePlan(adapter);
  const log = plan ? await plan.readPage() : await adapter.getEventLog(0, 'en');
  const wrap = plan?.shape.wrap ?? false;
  let newest: ElogMessage | null = null;
  for (const m of log) {
    if (newest === null || compareElogSeqnum(m.seqnum, newest.seqnum, wrap) > 0) { newest = m; }
  }
  return newest;
}
