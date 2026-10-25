import { Logger } from '../Logger.js';
import { RwsError } from '../types.js';
import type { AccessObservation, AccessManager } from './AccessManager.js';

/**
 * The controller's HeartBeat configuration (`SYS/MASTER_BOOL/HeartBeat`), as
 * read. A field is null when it could not be read.
 */
export interface HeartBeatConfig {
  /**
   * `Select`. ABB's PC SDK: when it is true, a client that holds mastership
   * must send heartbeats during program execution, or execution stops and
   * the controller goes to motors off.
   */
  select: boolean | null;
  /** `Timeout`, in milliseconds: the longest allowed gap between two heartbeats. */
  timeoutMs: number | null;
}

/** The wire side of the watchdog. */
export interface WatchdogDriver {
  /** Prefix for log lines, e.g. 'RWS2'. */
  readonly label: string;
  /** True while this session's controller has the watchdog (RobotWare 7.8 or later, connected). */
  applies(): boolean;
  /** One watchdog reset (`POST /rw/mastership/watchdog`). */
  kick(): Promise<void>;
  /** Read the HeartBeat configuration. It is only ever read, never written. */
  readHeartBeat(): Promise<HeartBeatConfig>;
}

/**
 * What the controller's HeartBeat watchdog means for this session
 * (`RobotState.access.watchdog`): on RobotWare 7.8 and later the
 * edit-mastership watchdog this client resets while it holds `edit`; on
 * RobotWare 8 the write-access supervision of the same HeartBeat
 * configuration, which this client cannot reset (`resettable: false`): ABB
 * documents no RWS way to send the heartbeat there, and a RAPID start under a
 * hold is warned about, not blocked (see RobotManager).
 */
export interface WatchdogState {
  /** True while resets are being sent (this session holds edit mastership on RobotWare 7.8+). */
  running: boolean;
  /**
   * True where this client can reset the watchdog (RobotWare 7.8+ mastership
   * service); false on RobotWare 8, where it only reads the configuration.
   */
  resettable: boolean;
  /** HeartBeat `Select` as read; null until read, or when it could not be read. */
  enforced: boolean | null;
  /** HeartBeat `Timeout` in ms as read; null until read, or when it could not be read. */
  timeoutMs: number | null;
  /** The interval resets are sent at, in ms; 0 where the client cannot reset it. */
  intervalMs: number;
  /** The last reset sent: when (ms since the epoch), and whether the controller accepted it. */
  lastKick: { at: number; ok: boolean } | null;
}

/**
 * The HeartBeat configuration from a CFG instance's attributes. Attribute
 * names are matched without regard to case. `Timeout` is taken as
 * milliseconds, the unit ABB's PC SDK gives for it (default 2000 ms); an
 * empty, non-numeric or non-positive value reads as unknown.
 */
export function heartBeatFromAttributes(attrs: Record<string, string>): HeartBeatConfig {
  const byName = new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const sel = byName.get('select')?.toUpperCase();
  const select = sel === 'TRUE' ? true : sel === 'FALSE' ? false : null;
  const raw = byName.get('timeout');
  const t = raw ? Number(raw) : NaN;
  return { select, timeoutMs: Number.isFinite(t) && t > 0 ? t : null };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Controller codes that answer a watchdog reset with "busy, not now" rather
 * than a refusal of the hold:
 * - -1073445799, "Orchestration already active" (icode -802), HTTP 403.
 *   Recorded 2026-09-30 on RW 7.21.4+417 by the functional suite (09-motion):
 *   a reset sent while a RAPID start of the same session was still in
 *   progress (that start POST took 8.6 s and was accepted); the resets
 *   before it in the same start were accepted. Taken as a lost hold, it
 *   released edit mastership in the middle of the start.
 */
export const WATCHDOG_BUSY_CODES: ReadonlySet<number> = new Set([-1073445799]);

/** True when `e` is the controller answering a watchdog reset as busy (WATCHDOG_BUSY_CODES). */
export function isWatchdogBusy(e: unknown): e is RwsError {
  return e instanceof RwsError && e.controllerCode !== undefined && WATCHDOG_BUSY_CODES.has(e.controllerCode);
}

/**
 * Resets RobotWare 7's edit-mastership watchdog while this session holds
 * `edit`, and only then.
 *
 * ABB's RWS 2.0 Mastership service documents `POST /rw/mastership/watchdog`
 * ("Reset Edit Mastership Watchdog"): mastership edit "is only valid for a
 * period of time", and the call starts that period again; the timeout is
 * configured in `SYS/MASTER_BOOL/HeartBeat`. The page gives no interval, no
 * RobotWare version and no effect of expiry. ABB's PC SDK documents the
 * matching heartbeat from RobotWare 7.8: with `Select` true, a client that
 * holds mastership must send one within `Timeout` (default 2000 ms) during
 * program execution, or execution stops and the controller goes to motors
 * off. That the RWS watchdog is that heartbeat is inferred, since ABB never
 * says so; whether the controller enforces it on a hold outside execution,
 * and what a refused or missed reset does to the hold, are not documented
 * and have not been observed.
 *
 * What this does, and why:
 * - It runs whenever `edit` is held on RobotWare 7.8 or later, whatever
 *   `Select` says, because the RWS page does not limit the watchdog to
 *   execution. It starts when the first hold on `edit` is taken and stops
 *   when the last one ends, when the session ends or is re-issued, and on
 *   disconnect. Holds are per operation, so it runs during an operation that
 *   holds `edit` for longer than one interval, and while a caller keeps its
 *   own hold. It never runs to keep a hold alive that nothing holds.
 * - It resets every `min(Timeout / 2, 1000 ms)`, never faster than every
 *   100 ms; before the configuration is read, or when it cannot be, with
 *   ABB's documented default Timeout of 2000 ms, which gives 1000 ms.
 * - It reads the HeartBeat configuration once per connection, one moment
 *   after the first hold is taken, so the operation's own next request goes
 *   out first. It never writes it: the configuration decides whether a silent
 *   holder stops program execution and drops the motors, which is the cell
 *   integrator's choice.
 * - The hold is lost (`lost`, reason `watchdog`) when the controller refuses a
 *   reset (it answers with an HTTP error status, and not as busy - see
 *   below), or when the controller has not answered a reset for longer than
 *   the Timeout (resets that did not get through, or one accepted later than
 *   that after the controller's previous answer). Whether the
 *   controller then ends the hold is not documented and has not been
 *   observed, so the client takes the conservative reading: it stops relying
 *   on the hold, the operation holding it requests no access again, and the
 *   lock is released once, to be sure. The next operation requests afresh.
 * - A reset that did not get through (a network error, a timeout, the
 *   controller busy) while the Timeout has not yet run out is a hold at risk:
 *   a warning and an `atRisk` access event, once until a reset is accepted on
 *   time again. The hold stays counted; the next reset decides.
 * - A reset the controller answers as busy (`WATCHDOG_BUSY_CODES`: an
 *   operation such as a RAPID start of this same session is still in
 *   progress there) is not a refusal of the hold, and not silence either:
 *   the hold stays counted and the reset is sent again after a backoff that
 *   starts at `BUSY_RETRY_MIN_MS` and doubles up to the reset interval. The
 *   Timeout counts from the controller's last answer, busy or accepted.
 *   Once no reset has been accepted for longer than the Timeout, the hold is
 *   reported at risk (once), and when the controller has answered every
 *   reset as busy for longer than `BUSY_LIMIT_MS`, the hold is taken as lost.
 *   Only a refusal with any other code, or real silence, ends it sooner.
 * - At most one reset is on the wire at a time; a reset that is still
 *   waiting for its answer when the next one is due is not doubled.
 */
export class MastershipWatchdog {
  /** ABB's documented default HeartBeat Timeout (PC SDK), in ms. */
  static readonly DEFAULT_TIMEOUT_MS = 2000;
  /** Longest interval between two resets, in ms. */
  static readonly MAX_INTERVAL_MS = 1000;
  /** Shortest interval between two resets, in ms (at most 10 per second). */
  static readonly MIN_INTERVAL_MS = 100;
  /**
   * First retry after a reset answered busy, in ms; each further busy answer
   * in a row doubles it, up to the reset interval.
   */
  static readonly BUSY_RETRY_MIN_MS = 200;
  /**
   * Longest the hold stays counted while the controller answers every reset
   * as busy, in ms: the RWS 2.0 client's default limit for one request, so
   * an operation of this session that keeps the controller busy (the start
   * recorded took 8.6 s) is covered while its request can still be running.
   */
  static readonly BUSY_LIMIT_MS = 120_000;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the last reset was sent, or the hold began. */
  private anchor = 0;
  /** When the controller last accepted a reset, or the hold began. */
  private lastOkAt = 0;
  /** When the controller last answered a reset as busy, since the last accepted one; null when it has not. */
  private lastBusyAt: number | null = null;
  /** When the current run of busy answers began; null outside one. */
  private busySince: number | null = null;
  /** Busy answers in a row (sets the retry backoff). */
  private busyStreak = 0;
  private kickInFlight = false;
  /**
   * Bumped whenever resets stop (the hold ended, the session ended, disconnect).
   * A kick captures it when sent and its answer is ignored if the epoch has
   * moved since - so a reset still on the wire from a hold that has ended never
   * counts for, or against, the next hold. Same guard as configEpoch, for kicks.
   */
  private kickEpoch = 0;
  /** A risk was reported and no reset has been accepted on time since. */
  private atRisk = false;
  private lastKick: { at: number; ok: boolean } | null = null;
  private config: HeartBeatConfig | null = null;
  private configPending = false;
  /** Bumped when the configuration is forgotten; a read begun before is dropped. */
  private configEpoch = 0;

  constructor(private readonly access: AccessManager, private readonly driver: WatchdogDriver) {
    access.on(e => this.onAccess(e));
  }

  /** The interval resets are sent at, from the Timeout read or ABB's default. */
  intervalMs(): number {
    const half = Math.floor(this.timeoutMs() / 2);
    return Math.min(MastershipWatchdog.MAX_INTERVAL_MS, Math.max(MastershipWatchdog.MIN_INTERVAL_MS, half));
  }

  state(): WatchdogState {
    const resettable = this.driver.applies();
    return {
      running: this.running,
      resettable,
      enforced: this.config?.select ?? null,
      timeoutMs: this.config?.timeoutMs ?? null,
      intervalMs: resettable ? this.intervalMs() : 0,
      lastKick: this.lastKick,
    };
  }

  /**
   * Take the HeartBeat configuration read at connect (one GET per connection,
   * RobotWare 7.8 and later including 8). With it in hand, the first hold on
   * `edit` reads nothing more; `sessionEnded` forgets it, so the next
   * connection reads again.
   */
  adoptConfig(c: HeartBeatConfig): void {
    this.configEpoch++;
    this.adopt(c);
  }

  /** Stop resetting. The next hold on `edit` starts it again. */
  stop(): void {
    this.running = false;
    this.atRisk = false;
    this.clearBusy();
    // A reset may still be on the wire from the hold that just ended. Retire
    // this kick generation so its answer, when it comes, does nothing: it must
    // not credit or fault the next hold, which never sent it.
    this.kickEpoch++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /**
   * The session ended (disconnect) or the controller issued a new one: stop,
   * and read the configuration again on the next connection's first hold.
   */
  sessionEnded(): void {
    this.stop();
    this.config = null;
    this.configPending = false;
    this.configEpoch++;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private timeoutMs(): number {
    return this.config?.timeoutMs ?? MastershipWatchdog.DEFAULT_TIMEOUT_MS;
  }

  private holding(): boolean {
    return this.running && this.access.count('edit') > 0 && this.driver.applies();
  }

  private onAccess(e: AccessObservation): void {
    if (e.type === 'atRisk' || e.type === 'warning' || e.type === 'uncertain' || e.lock !== 'edit') { return; }
    if (e.type === 'acquired') { this.start(); return; }
    // released, lost, releaseFailed: the last hold on edit has ended.
    if (this.access.count('edit') === 0) { this.stop(); }
  }

  private start(): void {
    if (this.running || !this.driver.applies()) { return; }
    this.running = true;
    this.atRisk = false;
    // A fresh hold sends its own resets. Any kick still marked in flight is from
    // an earlier hold (its generation was retired by stop()); clear the marker so
    // this hold's ticks are not muzzled waiting for a reset that will never count.
    this.kickInFlight = false;
    const now = Date.now();
    this.anchor = now;
    this.lastOkAt = now;
    this.clearBusy();
    // Outside the operation that took the hold: the timers belong to the
    // session, not to that operation's turn.
    this.access.detach(() => {
      this.readConfigOnce();
      this.schedule(now + this.intervalMs());
    });
  }

  private schedule(at: number): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.running) { return; }
    const t = setTimeout(() => { this.timer = null; this.tick(); }, Math.max(0, at - Date.now()));
    // The watchdog alone never keeps a process alive.
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
  }

  private tick(): void {
    if (!this.running) { return; }
    if (!this.holding()) { this.stop(); return; }
    const now = Date.now();
    this.anchor = now;
    this.schedule(now + this.intervalMs());
    if (this.kickInFlight) {
      Logger.trace?.('mastership', `${this.driver.label}: the previous watchdog reset is still waiting for its answer - not sending another`);
      return;
    }
    this.kickInFlight = true;
    // The generation this kick belongs to. If the hold ends (stop() bumps the
    // epoch) before the answer arrives, the settlement below does nothing.
    const epoch = this.kickEpoch;
    void Promise.resolve()
      .then(() => this.driver.kick())
      .then(
        () => { if (epoch !== this.kickEpoch) { return; } this.kickInFlight = false; this.accepted(); },
        (e: unknown) => { if (epoch !== this.kickEpoch) { return; } this.kickInFlight = false; this.refused(e); },
      );
  }

  private accepted(): void {
    const now = Date.now();
    // Measured from the controller's last answer: a busy answer in between
    // was an answer, not silence.
    const busyBefore = this.lastBusyAt;
    const gap = now - Math.max(this.lastOkAt, busyBefore ?? 0);
    const busyFor = this.busySince === null ? null : now - this.busySince;
    this.lastOkAt = now;
    this.clearBusy();
    this.lastKick = { at: now, ok: true };
    if (!this.holding()) { return; }
    const limit = this.timeoutMs();
    if (gap > limit) {
      this.lose(busyBefore === null
        ? `${gap} ms passed between two accepted watchdog resets, more than the ${limit} ms heartbeat timeout${this.timeoutNote()}`
        : `${gap} ms passed between the controller's last answer to a watchdog reset (busy) and this accepted one, more than the ${limit} ms heartbeat timeout${this.timeoutNote()}`);
      return;
    }
    if (busyFor !== null) {
      Logger.trace?.('mastership', `${this.driver.label}: a watchdog reset was accepted again after ${busyFor} ms of busy answers; the hold was kept`);
    }
    if (this.atRisk) {
      this.atRisk = false;
      Logger.info(`${this.driver.label}: edit-mastership watchdog resets are accepted on time again`);
    }
  }

  private refused(e: unknown): void {
    const now = Date.now();
    this.lastKick = { at: now, ok: false };
    // The hold ended, or the client closed, while the reset was on the wire:
    // there is no hold left to lose.
    if (!this.holding()) { return; }
    if (isWatchdogBusy(e)) {
      this.busy(e, now);
      return;
    }
    if (MastershipWatchdog.isRefusal(e)) {
      this.lose(`the controller refused the watchdog reset: ${message(e)}`);
      return;
    }
    const busyBefore = this.lastBusyAt;
    const silent = now - Math.max(this.lastOkAt, busyBefore ?? 0);
    const limit = this.timeoutMs();
    if (silent > limit) {
      this.lose(busyBefore === null
        ? `no watchdog reset was accepted for ${silent} ms, more than the ${limit} ms heartbeat timeout${this.timeoutNote()} (the last one did not get through: ${message(e)})`
        : `the controller has not answered a watchdog reset for ${silent} ms since it last answered one as busy, more than the ${limit} ms heartbeat timeout${this.timeoutNote()} (the last one did not get through: ${message(e)})`);
      return;
    }
    this.reportRisk(`a watchdog reset did not get through: ${message(e)}`, e);
  }

  /**
   * The controller answered a reset as busy (`WATCHDOG_BUSY_CODES`). The
   * hold stays counted and the reset goes out again after a backoff: 200 ms,
   * doubling with each busy answer in a row, never longer than the reset
   * interval. At risk once no reset has been accepted for longer than the
   * Timeout; lost once every reset has been answered busy for longer than
   * `BUSY_LIMIT_MS`.
   */
  private busy(e: RwsError, now: number): void {
    if (this.busySince === null) { this.busySince = now; }
    this.lastBusyAt = now;
    this.busyStreak++;
    const busyFor = now - this.busySince;
    if (busyFor > MastershipWatchdog.BUSY_LIMIT_MS) {
      this.lose(`the controller has answered every watchdog reset as busy for ${busyFor} ms, longer than the ${MastershipWatchdog.BUSY_LIMIT_MS} ms this client keeps a hold on busy answers (${message(e)})`);
      return;
    }
    const retryMs = Math.min(this.intervalMs(),
      MastershipWatchdog.BUSY_RETRY_MIN_MS * 2 ** Math.min(this.busyStreak - 1, 16));
    Logger.trace?.('mastership', `${this.driver.label}: the controller answered the watchdog reset as busy (code ${e.controllerCode}); edit mastership stays counted, next reset in ${retryMs} ms`);
    const unaccepted = now - this.lastOkAt;
    const limit = this.timeoutMs();
    if (unaccepted > limit) {
      this.reportRisk(
        `no watchdog reset has been accepted for ${unaccepted} ms, more than the ${limit} ms heartbeat timeout${this.timeoutNote()}: the controller answers them as busy (${message(e)})`,
        e,
        'Whether the controller still counts the hold while it answers busy is not documented. The hold is still counted and the reset is retried; '
        + `a refusal with another code, no answer within the timeout, or busy answers for longer than ${MastershipWatchdog.BUSY_LIMIT_MS} ms end it.`);
    }
    this.schedule(now + retryMs);
  }

  private clearBusy(): void {
    this.lastBusyAt = null;
    this.busySince = null;
    this.busyStreak = 0;
  }

  /**
   * True when the controller answered the reset with a refusal: an HTTP error
   * status other than "busy" (503) and "too many requests" (429). A network
   * error, a timeout or a busy controller means the reset did not get through,
   * which is not yet a loss while the Timeout has not run out. A 403 with a
   * busy code (WATCHDOG_BUSY_CODES) never gets here: `refused` handles it
   * first, as busy.
   */
  private static isRefusal(e: unknown): boolean {
    return e instanceof RwsError
      && e.httpStatus !== undefined && e.httpStatus >= 400
      && e.code !== 'NETWORK_ERROR' && e.code !== 'CONTROLLER_BUSY' && e.code !== 'RATE_LIMITED';
  }

  private timeoutNote(): string {
    return this.config?.timeoutMs == null ? ' (ABB\'s default; the configured value was not read)' : '';
  }

  /** What the HeartBeat configuration says a missed heartbeat does, for the message. */
  private heartBeatNote(): string {
    const select = this.config?.select;
    return select === true
      ? 'The HeartBeat configuration has Select set, and ABB documents that a missed heartbeat then stops program execution and switches the motors off.'
      : select === false
        ? 'The HeartBeat configuration has Select cleared; ABB does not document whether the controller still ends the hold.'
        : 'The HeartBeat configuration could not be read; with its Select set, ABB documents that a missed heartbeat stops program execution and switches the motors off.';
  }

  private reportRisk(what: string, error?: unknown, next?: string): void {
    if (this.atRisk) {
      Logger.trace?.('mastership', `${this.driver.label}: ${what} (hold already reported at risk)`);
      return;
    }
    this.atRisk = true;
    this.access.reportAtRisk('edit', 'watchdog',
      `${what}. ABB documents that edit mastership stays valid only while the watchdog is reset. ${this.heartBeatNote()} `
      + (next ?? `The hold is still counted; if no reset is accepted within the ${this.timeoutMs()} ms timeout, it is taken as lost.`),
      error);
  }

  /**
   * The hold lapsed, or may have. Whether the controller ends it is not
   * documented, so the client stops relying on it and releases it once, to be
   * sure (see AccessManager.recordLoss). The loss ends every hold on edit,
   * which stops the resets.
   */
  private lose(what: string): void {
    this.atRisk = false;
    this.access.recordLoss(['edit'], 'watchdog',
      `${what}. ABB documents that edit mastership stays valid only while the watchdog is reset. ${this.heartBeatNote()} `
      + 'Whether the controller ended the hold is not known, so this client no longer relies on it: the lock is released to be sure, and the next write requests it afresh.',
      { release: true });
  }

  private readConfigOnce(): void {
    if (this.config || this.configPending) { return; }
    this.configPending = true;
    const epoch = this.configEpoch;
    // One moment later, so the operation that took the hold sends its own
    // next request first: the read never delays a write.
    const t = setTimeout(() => {
      if (epoch !== this.configEpoch) { return; }
      if (!this.driver.applies()) { this.configPending = false; return; }
      void Promise.resolve()
        .then(() => this.driver.readHeartBeat())
        .then(
          c => { if (epoch === this.configEpoch) { this.adopt(c); } },
          (e: unknown) => {
            if (epoch !== this.configEpoch) { return; }
            Logger.trace?.('mastership', `${this.driver.label}: the HeartBeat configuration could not be read (${message(e)}); watchdog resets use ABB's default timeout of ${MastershipWatchdog.DEFAULT_TIMEOUT_MS} ms`);
            this.adopt({ select: null, timeoutMs: null });
          },
        );
    }, 0);
    (t as { unref?: () => void }).unref?.();
  }

  private adopt(c: HeartBeatConfig): void {
    this.configPending = false;
    this.config = c;
    Logger.trace?.('mastership', `${this.driver.label}: HeartBeat configuration read - Select ${c.select ?? 'unknown'}, Timeout ${c.timeoutMs ?? 'unknown'} ms; watchdog resets every ${this.intervalMs()} ms while edit mastership is held`);
    // A shorter interval takes effect from the last reset sent.
    if (this.running && this.timer) { this.schedule(this.anchor + this.intervalMs()); }
  }
}
