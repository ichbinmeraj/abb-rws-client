import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '../Logger.js';
import { RwsError, type MastershipDomain, type RefusalContext, type RefusalHolder } from '../types.js';
import { asLostRefusal, builtRefusal, explainRefusal } from '../refusal.js';
import type { WatchdogState } from './MastershipWatchdog.js';

/**
 * A lock the controller itself arbitrates, as opposed to the domain name a
 * caller passes.
 *
 * - RobotWare 6 (RWS 1.0): three mastership domains, `cfg`, `motion` and
 *   `rapid`, each requested and released on its own (ABB Robot Web Services
 *   1.0 manual, Mastership: "CFG, MOTION and RAPID resources are supported").
 * - RobotWare 7 (RWS 2.0): two, `edit` (RAPID program or configuration: the
 *   `rapid` and `cfg` names both land here) and `motion` (ABB RWS 2.0
 *   Mastership service). For the caller's own session they behave as two
 *   locks: a RAPID start ran with only `edit` held and was refused with
 *   `edit` plus `motion` held (live-verified 2026-09-15 on an RW 7.21 VC).
 *   Whether one client's hold on one of them blocks another client's request
 *   for the other is not established (the PC SDK says RobotWare 7 mastership
 *   "is not separated between domains"); nothing here depends on it, and
 *   holds stay per operation either way.
 * - RobotWare 8: one, the control station's write access. Mastership is
 *   gone, and every domain name maps to this single lock (ABB "Changed
 *   features in RobotWare 8").
 */
export type AccessLock = 'cfg' | 'motion' | 'rapid' | 'edit' | 'writeaccess';

/** The RobotWare generation whose access model a session follows. */
export type AccessGeneration = 'rw6' | 'rw7' | 'rw8';

/**
 * Why this client stopped relying on a hold it counted. The hold may have
 * ended on the controller, or may have ended; either way the client no longer
 * counts it, and the next write requests access afresh.
 *
 * - `unknown`: the controller answered a write of the operation, or the
 *   release of the hold, as "this session does not hold it", and did not say
 *   why.
 * - `session-reissued`: the controller issued a new session (after a restart
 *   or an expired session, say). Mastership and control-station registration
 *   belong to the session they were taken on.
 * - `opmode`: the operating mode changed. ABB documents that a change between
 *   Auto and manual ends mastership (RobotWare 6: both directions; RobotWare 7:
 *   Auto to manual). On RobotWare 8, where write access is documented to
 *   persist, only when the controller no longer names this station as holder,
 *   or could not be asked.
 * - `holder-changed`: RobotWare 8, after a mode change: the controller names
 *   another control station as holder (`by` on the event).
 * - `watchdog`: RobotWare 7.8+: the controller refused a reset of the
 *   edit-mastership watchdog, or no reset was accepted within the HeartBeat
 *   Timeout.
 * - `connection-lost`: the connection failed (`RobotManager` disconnects after
 *   three failed polls in a row).
 *
 * More reasons may be added in minor releases; handle unknown ones generically.
 */
export type AccessLossReason =
  | 'unknown' | 'session-reissued' | 'opmode' | 'holder-changed' | 'watchdog' | 'connection-lost';

/**
 * Why a hold that is still counted may no longer be honoured:
 * - `watchdog`: a reset of RobotWare 7's edit-mastership watchdog did not
 *   reach the controller, while the HeartBeat Timeout had not yet run out
 *   (see MastershipWatchdog). Once it runs out, the hold is lost.
 */
export type AccessRiskReason = 'watchdog';

/**
 * Why RobotWare 8's motion-control allowance changed, or may have
 * (`motionControl` event):
 * - `set`: `setAllowMotionControl` was answered (or got no answer: `allowed`
 *   null). `read`: a read after a registration, or a caller's read, found a
 *   new value.
 * - `session-reissued`: the controller issued a new session; `allowed` is
 *   null. It says the session changed, not that the allowance ended.
 * - `withdrawn-at-disconnect`, `withdrawn-after-reissue`,
 *   `withdrawn-at-registration`, `withdrawn-on-mode-change`,
 *   `withdrawn-on-take-back`: the client withdrew an allowance it may have
 *   made (withdrawing only removes the permission and is not a stop; the
 *   client never allows on its own).
 * - `withdrawn-leftover`: a registration found the station allowed although
 *   this client made no allowance in this run (an earlier run with the same
 *   station id that ended without a withdrawal, or another live session
 *   registered with that id), and the client withdrew it. A person allows it
 *   again before a start or a jog; the client never does.
 * - `withdraw-failed`: such a withdrawal was refused or got no answer; the
 *   client tries again at the next registration of the same station and at
 *   the disconnect. After a leftover's failed withdrawal `allowed` is null
 *   (not known), never true.
 */
export type MotionControlCause =
  | 'set' | 'read' | 'session-reissued'
  | 'withdrawn-at-disconnect' | 'withdrawn-after-reissue' | 'withdrawn-at-registration'
  | 'withdrawn-leftover' | 'withdrawn-on-mode-change' | 'withdrawn-on-take-back' | 'withdraw-failed';

/** What the access manager observed. */
export type AccessObservation =
  | { type: 'acquired'; lock: AccessLock }
  | { type: 'released'; lock: AccessLock; alreadyCleared?: boolean }
  | { type: 'lost'; lock: AccessLock; reason: AccessLossReason; detail: string; by?: string }
  | { type: 'releaseFailed'; lock: AccessLock; error: unknown }
  | { type: 'atRisk'; lock: AccessLock; reason: AccessRiskReason; detail: string; error?: unknown }
  | { type: 'warning'; lock: AccessLock; kind: AccessWarningKind; detail: string }
  | { type: 'uncertain'; lock: AccessLock; detail: string }
  | { type: 'motionControl'; lock: 'writeaccess'; allowed: boolean | null; cause: MotionControlCause };

/**
 * What a `warning` observation is about:
 * - `heartbeat-required`: RobotWare 8, HeartBeat `Select` is true, and a RAPID
 *   start is about to go out under this session's write access. ABB's
 *   controller text (event 10139) says a station holding write access while
 *   RAPID runs must send a periodic watchdog command or execution stops; no
 *   RWS way to send it on RobotWare 8 is documented, so the start is sent
 *   with this warning, not blocked.
 */
export type AccessWarningKind = 'heartbeat-required';

/**
 * One change to what this session holds, as `RobotManager.onAccessEvent`
 * reports it (`at`: when, in ms since the epoch).
 *
 * - `acquired`: the first hold on a lock was granted (nested holds are not
 *   reported).
 * - `released`: the last hold on a lock was released. `alreadyCleared`: no
 *   release took effect on the wire because the hold had already ended there:
 *   the controller answered that this session held nothing any more, or ended
 *   the hold itself (a restart it accepted), so none was sent.
 * - `lost`: this client stopped relying on a hold it counted
 *   (`AccessLossReason`); `by` names the station now holding it, when the
 *   controller says (RobotWare 8; a station name, never its id).
 * - `releaseFailed`: a release did not go through (`error`); the lock may
 *   stay held until the session ends.
 * - `atRisk`: a hold is still counted but may not be honoured much longer.
 * - `warning`: something about the next write the consumer should show
 *   (`AccessWarningKind`); nothing is blocked.
 * - `uncertain`: a request for the lock did not answer, and whether the
 *   controller granted it could not be read either (`detail`): the lock is
 *   `uncertain` and nothing is counted; the next write requests it afresh.
 * - `motionControl`: RobotWare 8: the station's motion-control allowance is
 *   now `allowed` (true, false, or null for not known), for `cause`
 *   (`MotionControlCause`). `lock` is always `writeaccess`, the station the
 *   allowance belongs to.
 *
 * More event types may be added in minor releases; ignore types you do not
 * handle.
 */
export type AccessEvent = AccessObservation & { at: number };

/**
 * A lock's state for this session:
 * - `idle`: this session holds nothing on it.
 * - `held`: this session counts at least one hold on it. An observation, never
 *   permission: the controller decides every write, and on RobotWare 8 the
 *   FlexPendant can take write access at any time.
 * - `uncertain`: a release did not go through, or a request did not answer
 *   and whether it was granted could not be read, so the controller may still
 *   count the lock as this session's.
 * - `lost`: the last hold was lost (see `lost`); stays until the next hold is
 *   granted or the session ends.
 */
export type AccessLockStatus = 'idle' | 'held' | 'uncertain' | 'lost';

/** One lock of the session, as `RobotState.access.locks` reports it. */
export interface AccessLockState {
  lock: AccessLock;
  state: AccessLockStatus;
  /** Holds this session counts on the lock now: operations in progress and the caller's own. */
  count: number;
  /**
   * When the lock entered `state`, in ms since the epoch: for `held`, when the
   * first of the current holds was granted. Null while it has been idle since
   * the session began.
   */
  since: number | null;
  /** While `state` is `lost`: why, and who holds it now when the controller said. */
  lost?: { reason: AccessLossReason; detail: string; by?: string };
}

/**
 * What this session holds, as `RobotState.access` reports it. Every field is
 * an observation of this client's own bookkeeping and of what the controller
 * last answered; none of it is permission to write.
 */
export interface AccessState {
  /** The session's RobotWare generation, once known (after `connect()`). */
  generation: AccessGeneration | null;
  /**
   * Every lock of the generation (RobotWare 6: cfg, motion, rapid;
   * RobotWare 7: edit, motion; RobotWare 8: writeaccess). `RobotState.access`
   * lists none while not connected.
   */
  locks: AccessLockState[];
  /** RobotWare 7.8+: the edit-mastership watchdog; null where it does not apply. */
  watchdog: WatchdogState | null;
  /**
   * RobotWare 8: this session's control station - whether this client has
   * registered the session, the station name it registers as (never the id or
   * the PIN), where that identity came from once registered (`option`: the
   * `controlStation` option; `explicit`: a `registerControlStationRemote(name,
   * id, pincode)` or `registerControlStationLocal` call, which overrides the
   * option for the session; `default`: the anonymous default), and the
   * station's motion-control allowance: `allowMotionControl` as this client
   * last set or read it after the session registered, null while it is not
   * known (before the registration, while a `setAllowMotionControl(true)` is
   * on the wire, after a set that got no answer, after a re-issued session),
   * and `allowMotionControlSince`, the ISO time of the set this client made
   * while it reads true (null otherwise, and when it reads true without a set
   * of this client). Null on RobotWare 6 and 7.
   */
  rw8: {
    registered: boolean;
    stationName: string;
    identity: 'option' | 'explicit' | 'default' | null;
    allowMotionControl: boolean | null;
    allowMotionControlSince: string | null;
  } | null;
}

/**
 * Controller codes that mean "this session does not hold the access the write
 * needs":
 * - -1073445859 SYS_CTRL_E_MASTER_REJECT: the user does not have the required
 *   mastership (RWS 1.0 and 2.0 return-code lists; captured on RW 7.21).
 * - -1073445880 SYS_CTRL_E_RESOURCE_NOT_HELD: the resource is not held by the
 *   caller. In ABB's return-code lists; never observed on our controllers.
 * - -1073435873: the control station does not have write access (RobotWare 8;
 *   captured on RW 8.1.1).
 * - -1073435871: the session is not part of a control station (RobotWare 8;
 *   a new session is unregistered, captured on RW 8.1.1).
 */
export const NOT_HELD_CODES: ReadonlySet<number> = new Set([
  -1073445859, -1073445880, -1073435873, -1073435871,
]);

/** True when `e` is a controller refusal with one of the NOT_HELD_CODES. */
export function isNotHeldRefusal(e: unknown): e is RwsError {
  return e instanceof RwsError && e.controllerCode !== undefined && NOT_HELD_CODES.has(e.controllerCode);
}

/**
 * The wire side of one session's access: how a lock is requested and
 * released, and how a caller's domain name maps onto the controller's locks.
 * Every call goes out exactly as the adapter always sent it; the manager only
 * decides WHEN a request or a release is needed.
 */
export interface AccessDriver {
  /** Prefix for log lines, e.g. 'RWS1'. */
  readonly label: string;
  /** Every real lock of this controller generation (for the all-domains calls). */
  locks(): readonly AccessLock[];
  lockOf(domain: MastershipDomain): AccessLock;
  /** The domain name to send when one lock is requested or released on its own. */
  domainOf(lock: AccessLock): MastershipDomain;
  request(lock: AccessLock, domain: MastershipDomain): Promise<void>;
  release(lock: AccessLock, domain: MastershipDomain): Promise<void>;
  /** The session's generation, when known. Absent: unknown. */
  generation?(): AccessGeneration | null;
  /** The edit-mastership watchdog's state where it applies (RobotWare 7.8+), else null. */
  watchdog?(): WatchdogState | null;
  /** RobotWare 8: the session's control-station registration, else null. */
  station?(): AccessState['rw8'];
  /**
   * For a lock ABB documents as kept across an operating-mode change
   * (RobotWare 8 write access, "a persistent state"): one status read of
   * whether this session still holds it, and who does when another station
   * does. Returns null for a lock a mode change ends, or may end; that lock is
   * then taken as lost without a read.
   */
  confirmHeld?(lock: AccessLock): Promise<{ held: boolean; by?: string }> | null;
  /**
   * For a lock whose holder the controller reports in a way this session can
   * recognise as itself (RobotWare 8 write access, by the registered station
   * id): one status read of whether this session holds it now. Used when a
   * request did not answer (a timeout, a dropped connection), which is not
   * "not held": the controller may have granted it. Returns null for a lock
   * with no such read; that request's error is then passed on as before.
   */
  heldByMe?(lock: AccessLock): Promise<boolean> | null;
  /**
   * The operating mode changed from `from` to `to` (`noteModeChange`), with
   * or without a hold counted. RobotWare 8: the client may withdraw a
   * motion-control allowance it made (this only removes the permission and
   * is not a stop). Must not throw.
   */
  onModeChange?(from: string, to: string): void;
}

/**
 * The operation in progress (one `exclusive()` turn). `lost` is set when a
 * hold this operation took is lost; from then on the operation requests no
 * access again (see `acquire`).
 */
interface Turn {
  active: boolean;
  lost?: { lock: AccessLock; reason: AccessLossReason; detail: string };
}

/** The all-domains request and release of a generation (one wire call each). */
export interface AllLocksWire {
  request(): Promise<void>;
  release(): Promise<void>;
}

/** One acquisition. Only the release that ends the last live hold on a lock goes on the wire. */
export class AccessHold {
  /** False once released, forgotten, or ended by a recorded loss. */
  live = true;
  constructor(
    readonly domain: MastershipDomain,
    /** Set when the hold names its lock directly (RobotWare 8 write access). */
    readonly fixedLock?: AccessLock,
    /** The operation that took the hold, if it was taken inside one. */
    readonly turn?: Turn,
  ) {}
}

/** What a lock's record remembers between snapshots. */
interface LockRecord {
  /** When the current run of holds began (count 0 -> 1). */
  heldSince: number | null;
  /** How the last run of holds ended, and when; null before the first ended. */
  end: 'idle' | 'uncertain' | 'lost' | null;
  endAt: number | null;
  lost?: { reason: AccessLossReason; detail: string; by?: string };
}

/**
 * Controller codes a release can answer when this session held nothing:
 * - -1073435873 (RobotWare 8): the control station does not have write access
 *   ("The control station does not have SPoC", icode -20107; live-verified
 *   2026-09-15 and 2026-09-27 on an RW 8.1.1 VC).
 * - -1073445880 SYS_CTRL_E_RESOURCE_NOT_HELD (RobotWare 6/7): "The resource is
 *   not held by caller", from ABB's return-code lists. Never observed on our
 *   controllers; it is treated like the RobotWare 8 answer on that basis.
 */
const RELEASE_NOT_HELD_CODES: ReadonlySet<number> = new Set([-1073435873, -1073445880]);

/**
 * -1073445872 SYS_CTRL_E_RESOURCE_ALREADY_HELD, "already held by caller"
 * (ABB return-code lists, RobotWare 6/7). Never observed on our controllers:
 * the manager sends no request for a lock it already counts, so this can only
 * come back when its count and the controller disagree. It is then taken for
 * what the code says - the lock is this session's - and counted.
 */
const ALREADY_HELD_BY_CALLER = -1073445872;

const LOCK_LABEL: Record<AccessLock, string> = {
  cfg: 'CFG mastership',
  motion: 'motion mastership',
  rapid: 'RAPID mastership',
  edit: 'edit mastership',
  writeaccess: 'control-station write access',
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One per controller session: the only place that decides when mastership or
 * RobotWare 8 write access is requested and released.
 *
 * **Reference counts per real lock.** Every acquisition - a caller's own
 * `requestMastership`, a `RobotManager` wrap, an adapter's internal wrap around
 * one write - is a hold. The first hold on a lock sends the request; a nested
 * one costs no request; only the release that ends the last live hold sends
 * the release. RWS itself keeps no count: one release ends a hold however many
 * requests came before it (live-verified 2026-09-27 on an RW 8.1.1 VC: ten
 * requests, one release). So without this, a write that wrapped itself in
 * request and release ended any hold its caller had taken - on RobotWare 8,
 * where every domain is one lock, any write did.
 *
 * **One write at a time.** `exclusive()` and `withAccess()` run one operation
 * at a time per controller, first come first served. A write that waits
 * longer than `queueTimeoutMs` (default 10 s) is refused with
 * `CONTROLLER_BUSY` and never sent. An operation that calls further
 * access-taking writes from inside itself does not wait on itself. Plain
 * holds (`requestPublic`, a jog's motion hold, a stop's retry) take no turn:
 * they only count, and a stop never waits.
 *
 * **Losses are recorded, never dropped, and never papered over.** A hold is
 * lost when the controller answers a release of it, or a write of the
 * operation holding it, with "this session does not hold it"; when the
 * session is re-issued; when the operating mode changes (RobotWare 8: only if
 * the controller no longer names this station as holder, or cannot be
 * asked); and when the RobotWare 7 edit-mastership watchdog lapses. A loss is logged as a warning
 * and emitted as `lost`, and every hold on that lock ends: a later release of
 * such a hold sends nothing, and the operation that held it requests no
 * access again (its next step that needs access fails with
 * `MASTERSHIP_REQUIRED`). The next operation requests afresh, and the
 * controller decides. Where the controller may still count the lock as this
 * session's (a mode change, a lapsed watchdog), it is also released once, to
 * be sure. A count is never taken as permission: once a hold is in doubt it is
 * no longer counted.
 */
export class AccessManager {
  /** Longest a write waits for the one before it; then it is refused. */
  static readonly QUEUE_TIMEOUT_MS = 10_000;
  queueTimeoutMs = AccessManager.QUEUE_TIMEOUT_MS;

  private readonly holds = new Set<AccessHold>();
  /** Holds taken through the public per-domain request, oldest first. */
  private publicHolds: AccessHold[] = [];
  /** Hold groups taken through the public all-domains request, oldest first. */
  private publicAll: AccessHold[][] = [];
  /** Per lock: when its holds began and how they last ended (for `snapshot`). */
  private readonly records = new Map<AccessLock, LockRecord>();

  /** Every wire request and release, in order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Steps queued or running on `chain`. */
  private inFlight = 0;
  /** The lock whose counted release is on the wire right now. */
  private releasing: AccessLock | null = null;
  private releaseAnsweredNotHeld = false;
  /** True while the release that follows a loss is on the wire (see `recordLoss`). */
  private releasingAfterLoss = false;

  private mutexBusy = false;
  private readonly waiters: Array<() => void> = [];
  /** Waiters' rejections, in the same order as `waiters` (see refuseNewTurns). */
  private readonly waiterRefusals: Array<(e: RwsError) => void> = [];
  /** Set by the session's teardown: no new turn is granted (see refuseNewTurns). */
  private turnsRefused = false;
  private readonly turn = new AsyncLocalStorage<Turn>();

  private readonly listeners = new Set<(e: AccessObservation) => void>();

  /** See setRefusalContextSource. */
  private refusalSource: (() => RefusalContext) | null = null;
  /** See setHolderLookup. */
  private holderLookup: ((lock: AccessLock) => Promise<RefusalHolder | null>) | null = null;

  constructor(private readonly driver: AccessDriver) {}

  // ─── Observation ──────────────────────────────────────────────────────────

  lockOf(domain: MastershipDomain): AccessLock { return this.driver.lockOf(domain); }

  /** The session's RobotWare generation, or null while it is not known. */
  generation(): AccessGeneration | null { return this.driver.generation?.() ?? null; }

  /**
   * What this session holds, per lock of the generation, and since when, plus
   * the watchdog and (RobotWare 8) the station. See `AccessState`.
   */
  snapshot(): AccessState {
    const locks: AccessLock[] = [...this.driver.locks()];
    // A lock outside the generation's set (the set can change once, when a
    // RobotWare 8 controller answers the first mastership request with 410)
    // is still shown while something is recorded for it.
    for (const l of [...this.heldLocks(), ...this.records.keys()]) {
      if (!locks.includes(l)) { locks.push(l); }
    }
    return {
      generation: this.driver.generation?.() ?? null,
      locks: locks.map(l => this.lockState(l)),
      watchdog: this.driver.watchdog?.() ?? null,
      rw8: this.driver.station?.() ?? null,
    };
  }

  private lockState(lock: AccessLock): AccessLockState {
    const count = this.count(lock);
    const rec = this.records.get(lock);
    if (count > 0) { return { lock, state: 'held', count, since: rec?.heldSince ?? null }; }
    if (!rec?.end) { return { lock, state: 'idle', count: 0, since: null }; }
    return {
      lock, state: rec.end, count: 0, since: rec.endAt,
      ...(rec.end === 'lost' && rec.lost ? { lost: { ...rec.lost } } : {}),
    };
  }

  private record(lock: AccessLock): LockRecord {
    let rec = this.records.get(lock);
    if (!rec) { rec = { heldSince: null, end: null, endAt: null }; this.records.set(lock, rec); }
    return rec;
  }

  /** A run of holds on `lock` began (its count went from 0 to 1). */
  private markHeld(lock: AccessLock): void {
    this.teardownFailed.delete(lock);
    this.record(lock).heldSince = Date.now();
  }

  /** The run of holds on `lock` ended, as `how`. */
  private markEnded(lock: AccessLock, how: 'idle' | 'uncertain' | 'lost', lost?: LockRecord['lost']): void {
    const rec = this.record(lock);
    rec.end = how;
    rec.endAt = Date.now();
    rec.lost = lost;
  }

  /** Live holds on `lock`. */
  count(lock: AccessLock): number {
    let n = 0;
    for (const h of this.holds) { if (this.lockOfHold(h) === lock) { n++; } }
    return n;
  }

  /** Locks with at least one live hold. */
  heldLocks(): AccessLock[] {
    const out = new Set<AccessLock>();
    for (const h of this.holds) { out.add(this.lockOfHold(h)); }
    return [...out];
  }

  /** True while a caller holds `lock` through the public request methods. */
  hasLivePublicHold(lock: AccessLock): boolean {
    return this.publicHolds.some(h => h.live && this.lockOfHold(h) === lock)
      || this.publicAll.some(g => g.some(h => h.live && this.lockOfHold(h) === lock));
  }

  /** Report a warning about the next write (`AccessWarningKind`); the write is not held back. */
  noteWarning(lock: AccessLock, kind: AccessWarningKind, detail: string): void {
    this.emit({ type: 'warning', lock, kind, detail });
  }

  /**
   * RobotWare 8: the station's motion-control allowance is now `allowed`
   * (null: not known), for `cause`. The session's `station()` already
   * reports the new value; this tells the followers (`RobotState.access`,
   * `onAccessEvent`).
   */
  noteMotionControl(allowed: boolean | null, cause: MotionControlCause): void {
    this.emit({ type: 'motionControl', lock: 'writeaccess', allowed, cause });
  }

  /**
   * A release sent outside the manager's own bookkeeping (the session's
   * teardown) was refused: observed as `releaseFailed`, and the lock is
   * `uncertain` when nothing is counted on it, as for a counted release.
   */
  noteReleaseFailed(lock: AccessLock, error: unknown): void {
    this.markEnded(lock, 'uncertain');
    this.teardownFailed.add(lock);
    this.emit({ type: 'releaseFailed', lock, error });
  }

  /** Locks whose teardown release the controller refused: they stay `uncertain` past sessionEnded. */
  private readonly teardownFailed = new Set<AccessLock>();

  /** True inside an operation's turn (`exclusive` / `withAccess`). */
  inTurn(): boolean { return this.turn.getStore()?.active === true; }

  /**
   * The session is being torn down (`disconnect()`): from now on no new
   * operation gets the turn, and every operation waiting for it is refused,
   * all with NOT_CONNECTED. The operation that already holds the turn may
   * finish. Before this, a write started after disconnect() could take the
   * turn once the one in progress ended, and its request for write access
   * went out after the teardown's release, so RobotWare 8 write access was
   * held at /logout. `allowTurns()` reopens on the next connect.
   */
  refuseNewTurns(): void {
    this.turnsRefused = true;
    const refusals = this.waiterRefusals.splice(0);
    this.waiters.splice(0);
    for (const reject of refusals) { reject(this.turnsRefusedError()); }
  }

  /** New operations may take the turn again (the client reconnected). */
  allowTurns(): void { this.turnsRefused = false; }

  private turnsRefusedError(): RwsError {
    return new RwsError(`${this.driver.label}: the client is disconnecting - this write was not sent; call connect() first`, 'NOT_CONNECTED');
  }

  /**
   * Wait until no wire step is queued and no operation holds the turn, or
   * `timeoutMs` has passed. For a teardown: the write in progress finishes
   * before the session's holds are released and it logs out. Returns true when
   * everything was idle in time.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const idle = (): boolean => this.inFlight === 0 && !this.mutexBusy;
    const deadline = Date.now() + timeoutMs;
    while (!idle()) {
      const left = deadline - Date.now();
      if (left <= 0) { return false; }
      // A timer, never a settled promise: waiting on microtasks alone would
      // starve the sockets the write in progress is waiting on.
      await new Promise<void>(r => setTimeout(r, Math.min(25, left)));
    }
    return true;
  }

  /** Subscribe to access events; returns the unsubscribe function. */
  on(listener: (e: AccessObservation) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ─── One write at a time ──────────────────────────────────────────────────

  /**
   * Run `fn` as this controller's one write in progress. Called from inside
   * another `exclusive()` operation of the same manager, it runs at once.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.turn.getStore()?.active) { return fn(); }
    if (this.turnsRefused) { throw this.turnsRefusedError(); }
    await this.enterTurn();
    const token: Turn = { active: true };
    try {
      return await this.turn.run(token, fn);
    } finally {
      token.active = false;
      this.leaveTurn();
    }
  }

  /**
   * Run `fn` outside any operation's turn, so work it starts (a consumer's
   * change handler that issues a write, say) queues like any other write
   * instead of slipping into the operation that happens to be running.
   */
  detach<T>(fn: () => T): T { return this.turn.exit(fn); }

  /**
   * Take a turn, hold every domain in `domains`, run `fn`, and release the
   * holds on every path. A hold that cannot be taken fails the operation
   * before `fn` runs, and releases the holds taken before it.
   *
   * `releaseOnSuccess: false` is for a controller restart: once the controller
   * has accepted it, it goes down and takes the session and its mastership
   * with it, so the holds are forgotten instead of released.
   *
   * When `fn` fails because the controller says this session does not hold
   * the access (`NOT_HELD_CODES`) while the operation's holds were still
   * counted, those holds were lost: the loss is recorded (`unknown`), and the
   * refusal is passed on with the controller's code and text as a `lost`
   * refusal. The controller does not say which lock it missed, so every lock
   * the operation held is taken as lost.
   */
  async withAccess<T>(
    domains: readonly MastershipDomain[], fn: () => Promise<T>,
    opts: { releaseOnSuccess?: boolean } = {},
  ): Promise<T> {
    return this.exclusive(async () => {
      const taken: AccessHold[] = [];
      let succeeded = false;
      try {
        for (const d of domains) { taken.push(await this.acquire(d)); }
        let result: T;
        try {
          result = await fn();
        } catch (e) {
          throw this.noteRefusal(e, [...new Set(taken.filter(h => h.live).map(h => this.lockOfHold(h)))]);
        }
        succeeded = true;
        return result;
      } finally {
        for (const h of taken.reverse()) {
          if (succeeded && opts.releaseOnSuccess === false) { await this.forget(h); }
          else { await this.releaseQuietly(h); }
        }
      }
    });
  }

  /**
   * A write made under holds on `locks` failed with `e`. When `e` is a
   * refusal as "not held" (`NOT_HELD_CODES`) and this session still counts a
   * hold on any of those locks, the controller no longer honours it: a loss
   * (`unknown`), whatever ended it (the FlexPendant taking control back, a
   * mode change the client has not seen yet, the session ending). No release
   * follows: the controller has just said there is nothing to release.
   *
   * Returns the error to throw: after a loss, the same refusal explained as
   * `lost` (same code, HTTP status and controller answer); any other error
   * unchanged.
   */
  noteRefusal(e: unknown, locks: readonly AccessLock[]): unknown {
    if (!isNotHeldRefusal(e)) { return e; }
    const counted = locks.filter(l => this.count(l) > 0);
    if (counted.length === 0) { return e; }
    this.recordLoss(counted, 'unknown',
      `the controller refused a write of this operation as not holding access (code ${e.controllerCode}) although this session held ${counted.map(l => LOCK_LABEL[l]).join(' and ')}`);
    // The error the caller sees says the hold was lost, not that it was never
    // taken; the controller's code and text are kept.
    return asLostRefusal(e);
  }

  // ─── Explaining refusals ──────────────────────────────────────────────────

  /**
   * Where what the session's owner knows about the controller comes from
   * (operating mode, controller state, RMMP, the controller's name): the
   * clients read it to explain a refusal in plain words. `RobotManager`
   * sets it for the session it manages. Null clears it.
   */
  setRefusalContextSource(source: (() => RefusalContext) | null): void { this.refusalSource = source; }

  /** The context a refusal of this session is explained with; never throws. */
  refusalContext(): RefusalContext {
    let context: RefusalContext = {};
    try {
      context = this.refusalSource?.() ?? {};
    } catch (e) {
      Logger.trace?.('access', `${this.driver.label}: the refusal context could not be read: ${message(e)}`);
    }
    const generation = this.driver.generation?.() ?? null;
    return generation ? { ...context, generation } : context;
  }

  /**
   * How to read who holds a lock (one status read), so that a request
   * refused as held by someone else names the holder. RobotWare 8 names the
   * holding station by name only, never by id.
   */
  setHolderLookup(lookup: ((lock: AccessLock) => Promise<RefusalHolder | null>) | null): void { this.holderLookup = lookup; }

  /**
   * A request for `lock` was refused. When the controller said someone else
   * holds it, read the holder once and name it in the refusal; a failed read
   * leaves the refusal as the controller gave it.
   */
  private async explainRequestRefusal(e: unknown, lock: AccessLock): Promise<unknown> {
    if (!(e instanceof RwsError) || !e.refusal || !this.holderLookup) { return e; }
    if (e.controllerCode !== -1073445862 && e.controllerCode !== -1073435870) { return e; }
    try {
      const holder = await this.holderLookup(lock);
      return holder ? explainRefusal(e, { holder }) : e;
    } catch (err) {
      Logger.trace?.('access', `${this.driver.label}: reading who holds ${LOCK_LABEL[lock]} failed: ${message(err)}`);
      return e;
    }
  }

  // ─── Holds ────────────────────────────────────────────────────────────────

  /**
   * Hold `domain`. Sends the request only when this session holds nothing on
   * the same lock; a refused request throws and leaves nothing counted.
   * `lock` names the lock directly (RobotWare 8 write access requested as such).
   *
   * Inside an operation that has lost a hold, nothing is requested: the call
   * fails with `MASTERSHIP_REQUIRED` naming the loss. Re-requesting there
   * would quietly restore access halfway through a sequence the controller
   * interrupted; the next operation requests afresh instead.
   */
  acquire(domain: MastershipDomain, opts: { lock?: AccessLock } = {}): Promise<AccessHold> {
    // Read here, synchronously in the caller's context: the operation (if
    // any) this hold belongs to.
    const current = this.turn.getStore();
    const turn = current?.active ? current : undefined;
    if (turn?.lost) { return Promise.reject(this.lostInOperation(turn.lost)); }
    return this.enqueue(async () => {
      if (turn?.lost) { throw this.lostInOperation(turn.lost); }
      const lock = opts.lock ?? this.driver.lockOf(domain);
      const nested = this.count(lock) > 0;
      if (!nested) {
        try {
          await this.driver.request(lock, domain);
        } catch (e) {
          if (e instanceof RwsError && e.controllerCode === ALREADY_HELD_BY_CALLER) {
            Logger.info(`${this.driver.label}: the controller says ${LOCK_LABEL[lock]} is already this session's - counting it as held`);
          } else if (!(await this.grantedAfterAll(e, lock))) {
            throw await this.explainRequestRefusal(e, lock);
          }
        }
      }
      const hold = new AccessHold(domain, opts.lock, turn);
      const held = this.lockOfHold(hold);
      if (this.count(held) === 0) { this.markHeld(held); }
      this.holds.add(hold);
      if (!nested) { this.emit({ type: 'acquired', lock: held }); }
      return hold;
    });
  }

  /**
   * A request that did not answer (NETWORK_ERROR) may still have been granted.
   * Where the driver can read whether this session holds the lock, read it
   * once: held -> true (the caller counts the hold); not held -> false (the
   * error is passed on, nothing counted); the read fails -> the lock is
   * `uncertain`, an `uncertain` observation goes out, and the error is passed
   * on. Any other error, or a driver without the read: false.
   */
  private async grantedAfterAll(e: unknown, lock: AccessLock): Promise<boolean> {
    if (!(e instanceof RwsError && e.code === 'NETWORK_ERROR') || !this.driver.heldByMe) { return false; }
    const read = this.driver.heldByMe(lock);
    if (!read) { return false; }
    const what = `the request for ${LOCK_LABEL[lock]} did not answer (${message(e)})`;
    let held: boolean;
    try {
      held = await read;
    } catch (err) {
      const detail = `${what}, and whether the controller granted it could not be read (${message(err)}); `
        + 'the controller may count it as this session\'s. Nothing is counted here; the next write requests it afresh.';
      Logger.warn(`${this.driver.label}: ${detail}`);
      if (this.count(lock) === 0) { this.markEnded(lock, 'uncertain'); }
      this.emit({ type: 'uncertain', lock, detail });
      return false;
    }
    if (held) {
      Logger.info(`${this.driver.label}: ${what}, and the controller says this session holds it - counting it as held`);
      return true;
    }
    Logger.trace?.('access', `${this.driver.label}: ${what}, and the controller says this session does not hold it`);
    return false;
  }

  private lostInOperation(lost: NonNullable<Turn['lost']>): RwsError {
    const sentence = `${this.driver.label}: ${LOCK_LABEL[lost.lock]} was lost during this operation (${lost.detail}). `
      + 'This step and the rest of the operation were not sent, and access is not requested again inside the same operation; '
      + 'run the operation again to request access afresh.';
    return new RwsError(sentence, 'MASTERSHIP_REQUIRED', undefined, undefined, undefined, undefined, builtRefusal({
      kind: 'lost',
      condition: lost.lock === 'writeaccess' ? 'write-access' : 'mastership',
      generation: this.driver.generation?.() ?? null,
      missing: `${LOCK_LABEL[lost.lock]}, which this session held when the operation began`,
      grantor: 'this-tool',
      fix: 'Run the operation again: it requests access afresh, and the controller decides.',
      sentence,
      // ABB documents that a mode change, a restart, a lost connection and
      // the FlexPendant end mastership (PC SDK, "Losing mastership") and that
      // the FlexPendant can take RobotWare 8 write access at any time.
      evidence: 'abb',
    }));
  }

  /** End a hold; its failure to release on the wire is thrown. */
  release(hold: AccessHold): Promise<void> { return this.releaseHold(hold, true); }

  /** End a hold; a failure to release on the wire is logged, not thrown. */
  releaseQuietly(hold: AccessHold): Promise<void> { return this.releaseHold(hold, false); }

  /**
   * End a hold without a wire release: the controller ends it itself (a
   * restart it accepted takes the session, and the mastership taken on it,
   * down with it). When this was the last hold on its lock, the lock is idle
   * and `released` is emitted with `alreadyCleared: true`, as for a release
   * the controller answered "not held": a follower of the access events
   * (`RobotManager`'s `RobotState.access`) sees the hold end. Before, nothing
   * was emitted and the manager kept reporting the lock held after a warm
   * restart (seen 2026-09-30 on RW 7.21.4 by the functional suite's restart
   * test), so a consumer then released it again on the new session.
   */
  forget(hold: AccessHold): Promise<void> {
    return this.enqueue(async () => {
      if (!hold.live) { return; }
      hold.live = false;
      this.holds.delete(hold);
      const lock = this.lockOfHold(hold);
      if (this.count(lock) > 0) { return; }
      this.markEnded(lock, 'idle');
      this.emit({ type: 'released', lock, alreadyCleared: true });
    });
  }

  private releaseHold(hold: AccessHold, rethrow: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!hold.live) { return; }
      hold.live = false;
      this.holds.delete(hold);
      const lock = this.lockOfHold(hold);
      if (this.count(lock) > 0) { return; }
      await this.wireRelease([lock], () => this.driver.release(lock, hold.domain), { counted: true, rethrow });
    });
  }

  // ─── The public request / release pair ────────────────────────────────────

  /** A caller's own hold (`requestMastership`, `requestWriteAccess`). */
  async requestPublic(domain: MastershipDomain, opts: { lock?: AccessLock } = {}): Promise<void> {
    const hold = await this.acquire(domain, opts);
    this.publicHolds.push(hold);
  }

  /**
   * The release paired with `requestPublic`. It ends the caller's most recent
   * hold on the same lock, and the lock is released on the wire only when no
   * other hold of this session (an operation in progress, another of the
   * caller's) is still on it.
   *
   * With no hold of the caller's to end, the release is sent as asked when
   * this session counts nothing on the lock - an explicit release of a lock
   * the session may hold without having counted it - and is not sent while an
   * operation in progress holds the lock, because it would end that hold.
   */
  async releasePublic(domain: MastershipDomain, opts: { lock?: AccessLock } = {}): Promise<void> {
    const lock = opts.lock ?? this.driver.lockOf(domain);
    const hold = this.takePublicHold(lock);
    if (hold) {
      if (hold.live) { return this.release(hold); }
      Logger.trace?.('access', `${this.driver.label}: release of ${LOCK_LABEL[lock]} matches a hold that had already ended - nothing sent`);
      return;
    }
    return this.enqueue(async () => {
      if (this.count(lock) > 0) {
        Logger.trace?.('access', `${this.driver.label}: release of ${LOCK_LABEL[lock]} not sent - an operation of this session still holds it`);
        return;
      }
      await this.wireRelease([lock], () => this.driver.release(lock, domain), { counted: false, rethrow: true });
    });
  }

  /** A caller's hold on every lock of the generation (`requestMastershipAll`). */
  async requestPublicAll(wire?: AllLocksWire): Promise<void> {
    const group = await this.acquireAll(wire);
    this.publicAll.push(group);
  }

  /**
   * The release paired with `requestPublicAll`: ends the caller's most recent
   * all-locks hold. With none, it ends every hold the caller took through the
   * public methods. Either way, only locks no other hold of this session is on
   * are released on the wire.
   */
  async releasePublicAll(wire?: AllLocksWire): Promise<void> {
    const group = this.publicAll.pop();
    const ending = group ?? this.publicHolds.splice(0);
    return this.enqueue(async () => {
      const affected = new Set<AccessLock>();
      for (const h of ending) {
        if (!h.live) { continue; }
        affected.add(this.lockOfHold(h));
        h.live = false;
        this.holds.delete(h);
      }
      // Without a hold of its own, the caller asks for everything it may hold
      // to be let go: every lock this session counts nothing on.
      const candidates = group ? [...affected] : this.driver.locks();
      const free = candidates.filter(l => this.count(l) === 0);
      if (free.length === 0) { return; }
      await this.releaseLocks(free, wire, group !== undefined, true);
    });
  }

  private acquireAll(wire?: AllLocksWire): Promise<AccessHold[]> {
    return this.enqueue(async () => {
      const locks = this.driver.locks();
      const free = locks.filter(l => this.count(l) === 0);
      if (free.length > 0 && wire && free.length === locks.length) {
        await wire.request();
      } else if (free.length > 0) {
        const done: AccessLock[] = [];
        try {
          for (const l of free) { await this.driver.request(l, this.driver.domainOf(l)); done.push(l); }
        } catch (e) {
          for (const l of done.reverse()) {
            await this.driver.release(l, this.driver.domainOf(l)).catch((re: unknown) => {
              Logger.warn(`${this.driver.label}: releasing ${LOCK_LABEL[l]} after a refused all-domains request failed; it may stay held until this session ends: ${message(re)}`);
            });
          }
          throw e;
        }
      }
      // The lock set is read again: the request can reveal the generation
      // (a RobotWare 8 controller answers the mastership request with 410).
      const group = this.driver.locks().map(l => new AccessHold(this.driver.domainOf(l)));
      for (const h of group) {
        const lock = this.lockOfHold(h);
        if (this.count(lock) === 0) { this.markHeld(lock); this.emit({ type: 'acquired', lock }); }
        this.holds.add(h);
      }
      return group;
    });
  }

  private async releaseLocks(locks: AccessLock[], wire: AllLocksWire | undefined, counted: boolean, rethrow: boolean): Promise<void> {
    if (wire && locks.length === this.driver.locks().length) {
      await this.wireRelease(locks, () => wire.release(), { counted, rethrow });
      return;
    }
    for (const l of locks) {
      await this.wireRelease([l], () => this.driver.release(l, this.driver.domainOf(l)), { counted, rethrow });
    }
  }

  private takePublicHold(lock: AccessLock): AccessHold | undefined {
    const pick = (live: boolean): number => {
      for (let i = this.publicHolds.length - 1; i >= 0; i--) {
        const h = this.publicHolds[i];
        if (h.live === live && this.lockOfHold(h) === lock) { return i; }
      }
      return -1;
    };
    let i = pick(true);
    if (i < 0) { i = pick(false); }
    return i < 0 ? undefined : this.publicHolds.splice(i, 1)[0];
  }

  // ─── Losses and session ends ──────────────────────────────────────────────

  /**
   * The controller answered a release with "this session holds nothing"
   * (RobotWare 8: -1073435873, "The control station does not have SPoC").
   * When this session still counted a hold on the lock - the release that was
   * ending it, or holds still live - the hold ended some other way than this
   * client's release: a loss, recorded as one. Otherwise there was nothing of
   * this session's to lose, and only the release is noted.
   */
  noteReleaseNotHeld(lock: AccessLock): void {
    this.releaseAnsweredNotHeld = true;
    this.emit({ type: 'released', lock, alreadyCleared: true });
    if (this.releasingAfterLoss) {
      // The release that follows a recorded loss: "not held" is the answer
      // expected when the controller had ended the hold itself.
      Logger.trace?.('access', `${this.driver.label}: release of ${LOCK_LABEL[lock]} after its loss answered "not held"; the controller had ended it`);
    } else if (this.releasing === lock || this.count(lock) > 0) {
      this.recordLoss([lock], 'unknown',
        'the controller answered the release with "not held", so the hold had already ended without this client releasing it'
        + (lock === 'writeaccess' ? ' (the FlexPendant, for one, can take write access back at any time)' : ''));
    } else {
      this.markEnded(lock, 'idle');
      Logger.trace?.('access', `${this.driver.label}: release of ${LOCK_LABEL[lock]} answered "not held"; this session counted no hold on it`);
    }
  }

  /**
   * Something threatens a hold this session still counts on `lock`, while it
   * is not yet known to be lost - for one, a reset of RobotWare 7's
   * edit-mastership watchdog did not reach the controller, and the HeartBeat
   * Timeout has not run out. Nothing is dropped: the count stays. If the
   * threat turns into a loss, `recordLoss` follows.
   */
  reportAtRisk(lock: AccessLock, reason: AccessRiskReason, detail: string, error?: unknown): void {
    Logger.warn(`${this.driver.label}: ${LOCK_LABEL[lock]} may be at risk: ${detail}`);
    this.emit(error === undefined
      ? { type: 'atRisk', lock, reason, detail }
      : { type: 'atRisk', lock, reason, detail, error });
  }

  /**
   * End every hold on `locks`: the controller no longer honours them, or may
   * not. Their later releases send nothing, and an operation that held one
   * requests no access again (see `acquire`); the next operation requests
   * afresh.
   *
   * `release`: the controller may still count the lock as this session's (a
   * mode change whose effect ABB documents only for some directions, a lapsed
   * watchdog whose effect ABB does not document), so it is released once, to
   * be sure - unless a hold granted since has taken the lock again. "Not held"
   * is then the expected answer and is not a second loss. `by`: the station
   * the controller names as holder now (RobotWare 8), never an id.
   */
  recordLoss(
    locks: readonly AccessLock[], reason: AccessLossReason, detail: string,
    opts: { release?: boolean; by?: string } = {},
  ): void {
    for (const h of [...this.holds]) {
      const lock = this.lockOfHold(h);
      if (!locks.includes(lock)) { continue; }
      h.live = false;
      this.holds.delete(h);
      // The operation that took this hold must not quietly take it again.
      if (h.turn?.active && !h.turn.lost) { h.turn.lost = { lock, reason, detail }; }
    }
    const by = opts.by ? { by: opts.by } : {};
    for (const lock of locks) {
      this.markEnded(lock, 'lost', { reason, detail, ...by });
      Logger.warn(`${this.driver.label}: ${LOCK_LABEL[lock]} was lost: ${detail}`);
      this.emit({ type: 'lost', lock, reason, detail, ...by });
    }
    if (opts.release) {
      for (const lock of locks) { this.releaseAfterLoss(lock); }
    }
  }

  /** The one release that follows a loss the controller may not have made itself. */
  private releaseAfterLoss(lock: AccessLock): void {
    // Outside the operation that happened to be running when the loss was
    // seen: this release belongs to the session.
    this.detach(() => {
      void this.enqueue(async () => {
        if (this.count(lock) > 0) {
          Logger.trace?.('access', `${this.driver.label}: ${LOCK_LABEL[lock]} was granted again since its loss - no release sent`);
          return;
        }
        await this.wireRelease([lock], () => this.driver.release(lock, this.driver.domainOf(lock)),
          { counted: false, rethrow: false, afterLoss: true });
      }).catch(() => { /* logged by wireRelease */ });
    });
  }

  /**
   * The session ended: this client's count of every hold taken on it ends.
   * On a disconnect that is this client's own doing; when the controller
   * re-issued the session, a hold that was still counted is recorded as lost,
   * and the next write requests access afresh on the new session.
   */
  sessionEnded(reason: 'disconnect' | 'session-reissued'): void {
    const held = this.heldLocks();
    if (reason === 'session-reissued' && held.length > 0) {
      // Recorded first, so an operation in progress that held one of them
      // learns of the loss and requests nothing on the new session.
      this.recordLoss(held, 'session-reissued', 'the controller re-issued the session it was taken on; the next write requests it afresh');
    }
    for (const h of this.holds) { h.live = false; }
    this.holds.clear();
    for (const h of this.publicHolds) { h.live = false; }
    for (const g of this.publicAll) { for (const h of g) { h.live = false; } }
    this.publicHolds = [];
    this.publicAll = [];
    if (reason === 'disconnect') {
      // A lock whose teardown release was refused is not reported released:
      // the controller may still count it as this session's, and the final
      // state keeps it uncertain.
      for (const lock of held) { if (!this.teardownFailed.has(lock)) { this.emit({ type: 'released', lock }); } }
      for (const lock of [...this.records.keys()]) { if (!this.teardownFailed.has(lock)) { this.records.delete(lock); } }
      this.teardownFailed.clear();
    }
  }

  /**
   * The controller's operating mode changed from `from` to `to`, as this
   * client observed it (a poll or a subscription event). Every lock this
   * session counts a hold on is checked:
   *
   * - RobotWare 6 and 7 (mastership): ABB documents that a change between
   *   Auto and manual ends mastership - in both directions for IRC5
   *   (RobotStudio operating manual), from Auto to manual for OmniCore (PC SDK,
   *   "Losing mastership"). Manual to Auto is not documented for RobotWare 7
   *   and is treated the same way. The hold is recorded as lost (`opmode`)
   *   and the lock is released once, to be sure.
   * - RobotWare 8 (write access): ABB documents write access as a persistent
   *   state that a mode change does not alter, but the FlexPendant can take it
   *   at any time, and on a virtual controller it held write access whenever
   *   the controller was in manual. So the status is read once
   *   (`confirmHeld`): still this station's - nothing changes; another
   *   station's - lost (`holder-changed`, naming it); nobody's, or the read
   *   failed - lost (`opmode`). A lost hold is released once, to be sure.
   *
   * With nothing counted, a mode change is not a loss and nothing is sent.
   */
  noteModeChange(from: string, to: string): void {
    try { this.driver.onModeChange?.(from, to); } catch (e) {
      Logger.warn(`${this.driver.label}: the mode-change step failed: ${message(e)}`);
    }
    const change = `the operating mode changed from ${from} to ${to}`;
    const gen = this.driver.generation?.() ?? null;
    for (const lock of this.heldLocks()) {
      const check = this.driver.confirmHeld?.(lock) ?? null;
      if (!check) {
        const documented = gen === 'rw6'
          ? 'ABB documents that a change between Auto and manual ends mastership on IRC5'
          : gen === 'rw7'
            ? 'ABB documents that a change from Auto to manual ends mastership on OmniCore; the other direction is not documented and is treated the same way'
            : 'a mode change can end mastership';
        this.recordLoss([lock], 'opmode', `${change}; ${documented}`, { release: true });
        continue;
      }
      // Only the holds counted at the change are in question: once they have
      // all ended, a hold on the lock came with its own request.
      const affected = [...this.holds].filter(h => this.lockOfHold(h) === lock);
      const stillCounted = (): boolean => affected.some(h => h.live);
      void check.then(
        s => {
          if (!stillCounted()) { return; }
          if (s.held) {
            Logger.trace?.('access', `${this.driver.label}: ${change}; the controller still names this station as holder of ${LOCK_LABEL[lock]}`);
            return;
          }
          if (s.by) {
            this.recordLoss([lock], 'holder-changed', `${change}, and the controller now names control station '${s.by}' as holder`, { release: true, by: s.by });
          } else {
            this.recordLoss([lock], 'opmode', `${change}, and the controller no longer names this station as holder`, { release: true });
          }
        },
        (e: unknown) => {
          if (!stillCounted()) { return; }
          this.recordLoss([lock], 'opmode', `${change}, and whether this station still holds it could not be read (${message(e)})`, { release: true });
        },
      );
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private lockOfHold(h: AccessHold): AccessLock { return h.fixedLock ?? this.driver.lockOf(h.domain); }

  /**
   * Run wire steps strictly one after another, whatever the previous one did.
   * With nothing in flight a step starts at once, so a request goes out in
   * the order the calls were made, as it did before holds were counted.
   */
  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const idle = this.inFlight === 0;
    this.inFlight++;
    const run = idle ? step() : this.chain.then(step);
    const done = (): void => { this.inFlight--; };
    this.chain = run.then(done, done);
    return run;
  }

  /**
   * Send one release. `counted`: it ends the last counted hold on the lock.
   * `afterLoss`: the release that follows a recorded loss; the lock keeps its
   * `lost` state whatever the answer.
   */
  private async wireRelease(
    locks: AccessLock[], send: () => Promise<void>,
    opts: { counted: boolean; rethrow: boolean; afterLoss?: boolean },
  ): Promise<void> {
    const afterLoss = opts.afterLoss === true;
    this.releasing = opts.counted && locks.length === 1 ? locks[0] : null;
    this.releaseAnsweredNotHeld = false;
    this.releasingAfterLoss = afterLoss;
    try {
      try {
        await send();
      } catch (e) {
        if (!(e instanceof RwsError && e.controllerCode !== undefined && RELEASE_NOT_HELD_CODES.has(e.controllerCode))) { throw e; }
        for (const l of locks) { this.noteReleaseNotHeld(l); }
      }
      if (!this.releaseAnsweredNotHeld) {
        for (const l of locks) {
          if (!afterLoss && this.count(l) === 0) { this.markEnded(l, 'idle'); }
          this.emit({ type: 'released', lock: l });
        }
      }
    } catch (e) {
      for (const l of locks) {
        // The controller may still count the lock as this session's.
        if (!afterLoss && this.count(l) === 0) { this.markEnded(l, 'uncertain'); }
        this.emit({ type: 'releaseFailed', lock: l, error: e });
      }
      if (opts.rethrow) { throw e; }
      Logger.warn(`${this.driver.label}: releasing ${locks.map(l => LOCK_LABEL[l]).join(', ')} failed; it may stay held until this session ends: ${message(e)}`);
    } finally {
      this.releasing = null;
      this.releasingAfterLoss = false;
    }
  }

  private enterTurn(): Promise<void> {
    if (!this.mutexBusy) { this.mutexBusy = true; return Promise.resolve(); }
    const waitMs = this.queueTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => { clearTimeout(timer); resolve(); };
      const refuse = (e: RwsError): void => { clearTimeout(timer); reject(e); };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) { this.waiters.splice(i, 1); this.waiterRefusals.splice(i, 1); }
        reject(new RwsError(
          `${this.driver.label}: another write to this controller is in progress; this one waited ${waitMs} ms and was not sent`,
          'CONTROLLER_BUSY'));
      }, waitMs);
      this.waiters.push(grant);
      this.waiterRefusals.push(refuse);
    });
  }

  private leaveTurn(): void {
    const next = this.waiters.shift();
    this.waiterRefusals.shift();
    if (next) { next(); } else { this.mutexBusy = false; }
  }

  private emit(e: AccessObservation): void {
    for (const l of this.listeners) {
      try { l(e); } catch (err) { Logger.warn(`access listener threw: ${message(err)}`); }
    }
  }
}

// ─── Which manager belongs to which session ────────────────────────────────

const registry = new WeakMap<object, AccessManager>();

/** Record that `owner` (a client or an adapter) speaks for `manager`'s session. */
export function bindAccess(owner: object, manager: AccessManager): void { registry.set(owner, manager); }

/** The access manager of the session `owner` belongs to, if it has one. */
export function accessOf(owner: object | null | undefined): AccessManager | undefined {
  return owner ? registry.get(owner) : undefined;
}

/**
 * A driver over an object that only offers the per-domain request and release
 * calls (a client or adapter with no manager of its own). The lock mapping is
 * the generation's: RWS 2.0 folds `rapid` and `cfg` into `edit`.
 */
export function mastershipDriver(
  target: { requestMastership(d: MastershipDomain): Promise<void>; releaseMastership(d: MastershipDomain): Promise<void> },
  protocol: 'rws1' | 'rws2',
): AccessDriver {
  const rws2 = protocol === 'rws2';
  return {
    label: rws2 ? 'RWS2' : 'RWS1',
    locks: () => (rws2 ? ['edit', 'motion'] : ['cfg', 'motion', 'rapid']),
    lockOf: d => (rws2 ? (d === 'motion' ? 'motion' : 'edit') : d),
    domainOf: l => (l === 'edit' || l === 'writeaccess' ? 'rapid' : l),
    request: (_l, d) => target.requestMastership(d),
    release: (_l, d) => target.releaseMastership(d),
    // RWS 1.0 is RobotWare 6; an RWS 2.0 object of unknown make may be 7 or 8.
    generation: () => (rws2 ? null : 'rw6'),
  };
}
