import * as http from 'http';
import * as https from 'https';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { classifyControllerError } from '../ControllerError.js';
import { parseBody, subscriptionGroupId, subscriptionGroupsFrom, subscriptionMembersFrom } from '../commonReads.js';
import { holderFromMastership, holderFromWriteAccess, isFlexPendantStation } from '../refusal.js';
import {
  AccessManager, bindAccess, type AccessGeneration, type AccessLock, type AccessState, type AllLocksWire, type MotionControlCause,
} from '../access/AccessManager.js';
import {
  bindMotionControl, MOTION_CONTROL_WITHDRAWAL_TRIGGERS,
  type LocalStationStatus, type WithdrawalOutcome, type WithdrawalTrigger,
} from '../access/motionControl.js';
import { MastershipWatchdog, heartBeatFromAttributes, type HeartBeatConfig, type WatchdogState } from '../access/MastershipWatchdog.js';
import { isRmmpPending, isRmmpServiceUnsupported, normaliseRmmpPrivilege, rmmpLevel, rmmpUnsupportedOnRw8 } from '../access/rmmp.js';
import { bindWriteAccessStatusReader, writeAccessStatusFrom } from '../access/writeAccessStatus.js';
import { HalJsonParser } from '../HalJsonParser.js';
import { checkedTimeout } from '../HttpSession.js';
import { Logger } from '../Logger.js';
import { strictTlsCaOption, warnUnverifiedTls } from '../tlsTrust.js';
import * as R2 from '../ResourceMapper2.js';
import type { WsSubscribeOptions } from '../WsSubscriber.js';
import { XhtmlParser } from '../XhtmlParser.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import { CFG_ELOG_DIPC, FILES_VISION, SYSTEM_MASTERSHIP, USERS_UAS } from '../paths/index.js';
import { redactBody } from '../redact.js';
import { assertSignalName } from '../signalName.js';
import { asSubscriptionUpdateError } from '../subscriptionUpdateError.js';
import {
  otherPanelSpelling, respellableRefusal, subscriptionBodyResources, swapSubscriptionResources, unboundPanelResources, UNRESOLVED_URL,
} from './subscriptionBind.js';
import { addedResourcePaths, distinctPaths, dropFromGroup, subscriptionFrameEntries } from '../subscriptionKinds.js';
import type {
AnySubscriptionResource,
MastershipDomain,
RefusalContext,
RmmpLevel,
Signal,
SubscriptionEvent,
SubscriptionGroupInfo,
SubscriptionGroupMember,
SubscriptionHandle,
WriteAccessStatus
} from '../types.js';
import { RwsError, stripRapidDomain, type RwsErrorCode } from '../types.js';

// ─── Shared response helpers ────────────────────────────────────────────────
// Module-level, stateless functions used by the transport core AND every domain
// mixin. They were `private static` on the class; lifting them out lets the
// domain modules (src/rws2/*) share one copy without re-exposing class internals.

/** GET paths that must keep the XHTML Accept: fileservice serves raw file bytes
 *  (a content-type-based negotiation retry would double every file read, and the
 *  service rejects some Accept values), and /logout's body is ignored anyway. */
/** Primary GET representation. Officially supported on RWS 2.0; live-verified
 *  2026-07-09 on OmniCore VC RW7.21 for every GET endpoint family in this client. */
const ACCEPT_HAL = 'application/hal+json;v=2.0';
/** Representation for writes, fileservice, subscriptions, and the fallback GET
 *  path. Exported so a domain method that must pin XHTML (e.g. getDeviceTree,
 *  which promises a raw XHTML document) can pass it as an Accept override. */
export const ACCEPT_XHTML = 'application/xhtml+xml;v=2.0';

/** A motion-control withdrawal in progress: what started it, and the allowance POST number it covers so far. */
interface Withdrawal { trigger: WithdrawalTrigger; covered: number; done: Promise<WithdrawalOutcome> }

// The subscription service answers its GETs (`/subscription`,
// `/subscription/{group}`) in XHTML even to a hal+json Accept (RW 7.21.4+417
// and 8.2.1+1023, 2026-09-29). Negotiating there would send every read twice
// and, worse, switch the whole client to XHTML for every later GET.
function isXhtmlOnlyPath(path: string): boolean {
  return path.startsWith('/fileservice') || path === '/logout'
    || path === '/subscription' || path.startsWith('/subscription/');
}

/** Picks the parser for a response body: HAL JSON (primary GET representation)
 *  or XHTML (fallback GETs, form-POST responses). Both expose the same reads.
 *  One implementation with the RWS 1.0 adapter's reads (commonReads.parseBody). */
export function parse(body: string): XhtmlParser | HalJsonParser {
  return parseBody(body);
}

/** Error block from either representation (JSON status.code/msg or XHTML spans). */
function extractError(body: string): { code: string; msg: string } | null {
  return parse(body).getError();
}

/**
 * Read a state block that MUST be present, throwing `PARSE_ERROR` when it is
 * not - instead of letting a caller's `?? default` invent an answer.
 *
 * `getState()` returns `{}` both when a block is absent and when it is present
 * but empty, so `getState('pnl-opmode')['opmode'] ?? 'MANR'` cannot tell a
 * genuine reading from an unparseable response - and answers `MANR` either
 * way. For a robotics client that is not a cosmetic difference: a garbled or
 * truncated response would report a specific, plausible, safety-relevant state
 * that the controller never sent. RWS 1.0's parser throws `PARSE_ERROR` for
 * the same input, so this also removes a real behavioural fork between the two
 * generations.
 *
 * Field-level `??` defaults stay: a block that IS present but omits one span
 * is a different situation from no block at all.
 *
 * Found by structural cell S12 (malformed/truncated responses), 2026-08-09.
 */
export function requireState(
  p: XhtmlParser | HalJsonParser, classes: string[], what: string,
): Record<string, string> {
  for (const c of classes) {
    const d = p.getState(c);
    if (Object.keys(d).length > 0) { return d; }
  }
  throw new RwsError(
    `RWS2 ${what}: response carried no ${classes.join(' / ')} block - unparseable or truncated`,
    'PARSE_ERROR',
  );
}

/**
 * True for the keep-alive race: a pooled socket the controller closed while it
 * sat idle, which fails as ECONNRESET / "socket hang up" with no response.
 */
function isStaleSocketError(e: unknown): boolean {
  if (!(e instanceof RwsError) || e.code !== 'NETWORK_ERROR') { return false; }
  return /socket hang up|ECONNRESET|EPIPE/i.test(e.message);
}

/**
 * The attributes of one CFG instance (`/rw/cfg/{domain}/{type}/instances/{instance}`):
 * each `cfg-ia-t` item's title and value.
 */
export function cfgInstanceAttributes(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const attr of parse(body).getAllStates('cfg-ia-t')) {
    const name = attr['_title'];
    if (name) { result[name] = attr['value'] ?? ''; }
  }
  return result;
}

/**
 * Every instance of one page of a CFG instance list
 * (`/rw/cfg/{domain}/{type}/instances`) with its attributes, in the
 * controller's order. The list carries each instance's attributes inline:
 * in HAL JSON a `cfg-dt-instance-li` with an `attrib` array of `cfg-ia-t`
 * entries (recorded on RW 7.21.4 and 8.2.1, SYS/SYSSIG_OUT, 2026-09-29),
 * which the parser lists in document order, each instance before its
 * attributes. In XHTML each instance item holds its attribute items, which
 * the shared item pattern would cut at the first nested `</li>`, so the body
 * is split at the instance items and each part read as one instance.
 * Null for a body that is neither JSON nor an XHTML state block, so a caller
 * can tell an empty list from an answer it could not read.
 */
export function cfgInstanceList(body: string): Array<{ name: string; attributes: Record<string, string> }> | null {
  const out: Array<{ name: string; attributes: Record<string, string> }> = [];
  if (HalJsonParser.looksLikeJson(body)) {
    const parser = new HalJsonParser(body);
    // A listing, empty or not, carries its entries as an array (RW 8.2.1:
    // `_embedded.resources: []` for an empty type); JSON without one is not a listing.
    if (!parser.parsed || !isJsonListing(body)) { return null; }
    let current: { name: string; attributes: Record<string, string> } | null = null;
    for (const entry of parser.getAllEntries()) {
      if (entry['_type'] === 'cfg-dt-instance-li') {
        current = { name: entry['_title'] ?? '', attributes: {} };
        out.push(current);
      } else if ((entry['_type'] === 'cfg-ia-t' || entry['_type'] === 'cfg-ia-t-li') && current && entry['_title']) {
        current.attributes[entry['_title']] = entry['value'] ?? '';
      }
    }
    return out;
  }
  if (!/<div class="state"/.test(body)) { return null; }
  for (const part of body.split('<li class="cfg-dt-instance-li"').slice(1)) {
    const title = /^[^>]*\btitle="([^"]*)"/.exec(part)?.[1] ?? '';
    out.push({ name: title, attributes: cfgInstanceAttributes(part) });
  }
  return out;
}

function isJsonListing(body: string): boolean {
  try {
    const embedded = (JSON.parse(body) as { _embedded?: Record<string, unknown> })._embedded;
    return !!embedded && (Array.isArray(embedded['resources']) || Array.isArray(embedded['_state']));
  } catch { return false; }
}

// The next-page link of a paged listing: shared with the RWS 1.0 side, so it
// lives in commonReads.ts; re-exported here for the RWS 2.0 modules and tests
// that import it from this file.
export { nextPagePath } from '../commonReads.js';

/**
 * Where a signal lives, read from its `ios-signal-li` entry: `{ n, d }` for a
 * signal bound to a device (title `network/device/name`), `{ n: '', d: '' }`
 * for a signal with no device (title = the bare name), or null when the entry
 * does not say (no title, a title of another shape, or a title whose last
 * part is not the entry's name).
 *
 * The title is the source, not the entry's self link: on a single-signal read
 * that link points at the device (`devices/{device}`, or `devices/` for none),
 * not at the signal. Observed 2026-09-27 on RobotWare 7.21 and 8.1.1
 * virtual controllers: every device-bound signal's title carries
 * network/device/name, and the signals with no device (the safety
 * controller's SCnCBC* signals, and on 8.1.1 CollaborativeOperationIsActive)
 * carry the bare name. A single-signal read also gives `devicenm`: empty for
 * a signal with no device, so a bare title with a device name is not trusted.
 */
export function signalLocation(entry: Record<string, string>): { n: string; d: string } | null {
  const title = entry['_title'];
  if (!title) { return null; }
  const parts = title.split('/');
  const name = entry['name'];
  if (name !== undefined && name !== parts[parts.length - 1]) { return null; }
  if (parts.length === 3 && parts.every(Boolean)) { return { n: parts[0], d: parts[1] }; }
  if (parts.length === 1 && (entry['devicenm'] ?? '') === '') { return { n: '', d: '' }; }
  return null;
}

/**
 * RWS 2.0 protocol client for ABB OmniCore controllers (RobotWare 7.x).
 *
 * Companion to `RwsClient` (RWS 1.0 / IRC5 / RobotWare 6.x). If you don't know
 * which protocol your controller uses, prefer `createClient(host)` from this
 * package - it probes the auth challenge and returns the right client.
 *
 * Key differences vs RWS 1.0 (all confirmed by live virtual-controller probing):
 * - HTTP Basic auth instead of Digest
 * - Path-based actions: /rw/rapid/execution/stop (not ?action=stop)
 * - GETs are negotiated as HAL JSON (Accept: application/hal+json;v=2.0 -
 *   live-verified 2026-07-09 on RW7.21 for every GET family) with an automatic
 *   per-instance fallback to application/xhtml+xml;v=2.0 for older RW7
 *   releases; form-POST responses and subscription events are XHTML-only
 * - Mastership domains: 'edit' replaces both 'cfg' and 'rapid'
 * - FileService home: 'HOME' not '$HOME'
 * - Self-signed TLS on all shipping controllers → verification is OFF by default;
 *   pass `{ rejectUnauthorized: true }` to keep it on (e.g. controllers with a
 *   properly installed certificate). Off, the first connection to a host and
 *   port off this PC's loopback logs a warning saying so (tlsTrust.ts).
 */
export class Rws2Core {
  private lastReqTime = 0;
  private static readonly MIN_MS = 100;
  /** Tail of the pacing chain; see takeRequestSlot. */
  private reqSlot: Promise<void> = Promise.resolve();
  private readonly authHeader: string;
  /** The UAS user this session logs in as, named in a grant refusal. */
  private readonly uasUser: string;
  private readonly httpsAgent: https.Agent;
  private readonly httpAgent: http.Agent;
  private readonly isHttps: boolean;
  /** Per-request timeout in ms (constructor `opts.timeout`, default 10000). */
  private readonly timeoutMs: number;
  /** Largest response body, and subscription event frame, accepted in bytes
   *  (constructor `opts.maxResponseBytes`, default 64 MiB). */
  private readonly maxResponseBytes: number;
  /** Absolute limit for one request in ms (constructor `opts.requestDeadlineMs`);
   *  0 when the deadline is off. */
  private readonly requestDeadlineMs: number;
  private static readonly DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
  private static readonly DEFAULT_REQUEST_DEADLINE_MS = 120000;
  /** Longest delay setTimeout holds; it fires anything longer after 1 ms. */
  private static readonly MAX_TIMER_MS = 2 ** 31 - 1;
  /** When true, TLS certificate verification stays ON everywhere (requests, subscription POST, WebSocket). */
  private readonly rejectUnauthorized: boolean;
  /**
   * With verification on over https: the authorities a controller's
   * certificate is checked against, the same as the discovery and protocol
   * probes' (tlsTrust.ts); set on the agent and on every request, as
   * `rejectUnauthorized` is. Empty otherwise, which leaves Node's default.
   */
  private readonly tlsCa: { ca?: string[] };

  /** Session cookie set by the controller on first auth - REQUIRED to avoid creating
   *  a new session per request (controller's session pool fills in seconds otherwise). */
  private sessionCookie: string | null = null;

  /**
   * Set when the controller answered 401 to a request that carried the
   * session cookie and no credentials: the session that cookie names is gone
   * (an idle expiry after about 5 minutes, a restart, a logout; live on RW
   * 7.21.4 and 8.2.1, 2026-09-29: 401 "Access denied. Login required" with
   * `WWW-Authenticate: Basic` and no Set-Cookie). From then on the cookie is
   * not sent and the credentials are, until the controller issues a new
   * cookie (adoptSessionCookie). The old value is kept, not nulled, so the
   * new one is compared with it and everything the old session held is
   * forgotten there. See authHeaders and withLogin.
   */
  private sessionGone = false;

  /**
   * The login in progress after a 401 to the session cookie (logIn): a
   * request that meets the same 401 meanwhile, or would log in on its own,
   * waits for it, then is sent with what it left, so the requests in flight
   * at an expiry log in once, not once each.
   */
  private relogin: Promise<void> | null = null;

  /**
   * The AUTH_FAILED errors of 401 answers to a request that carried the
   * session cookie and no credentials (attemptReq, createSubscription), which
   * withLogin sends once more after a login (logIn).
   */
  private readonly goneSessionAnswers = new WeakSet<RwsError>();

  /**
   * Set by disconnect(), cleared by connect(). While set, every request is
   * refused with NOT_CONNECTED before it is sent, so nothing is sent after
   * disconnect(). A fresh client that never
   * connected is not closed, so the connect()-less use the tests and probes
   * rely on still works.
   */
  private closed = false;

  /** The error a request on a closed client is refused with. */
  private closedError(method: string, path: string): RwsError {
    return new RwsError(
      `RWS2 ${method} ${path}: client is disconnected - call connect() first`,
      'NOT_CONNECTED',
    );
  }

  /**
   * Signal name → where it lives, for `writeSignal` with empty network/device:
   * `{ n, d }` for a device-bound signal, both '' for a signal with no device.
   * Filled by `listAllSignals`, the signal searches and `writeSignal`'s own
   * lookup; an entry the controller answers 404 for is dropped.
   */
  protected readonly sigCoords = new Map<string, { n: string; d: string }>();

  /** RobotWare major version, parsed from /rw/system on connect (null before). */
  private rwMajor: number | null = null;
  /** Raw rwversion string from /rw/system, e.g. '8.1.1+614'. */
  private rwVersionRaw: string | null = null;
  /** How write access is acquired: RW7 mastership or RW8 control-station.
   *  Resolved from the version on connect, or lazily when /rw/mastership
   *  answers 410 GONE (RW8 removed it). */
  private writeAccessMode: 'mastership' | 'controlstation' | null = null;
  /** True once THIS session registered its control station (registration is
   *  session-scoped on RW8 - a reconnect must re-register). */
  private controlStationRegistered = false;
  /** True while this session holds RW8 control-station write access. */
  private writeAccessHeld = false;
  /**
   * True once this session has sent a write-access request, answered or not:
   * `disconnect()` then releases to be sure (the controller answers "does not
   * have SPoC" when nothing is held, which is taken as already cleared).
   * RobotWare 8 write access persists past the session, so a request the
   * controller granted after this client stopped waiting must not be left.
   */
  private writeAccessRequested = false;
  /**
   * Set at the start of `disconnect()`, in the same tick: from then on a new
   * request from outside an operation in progress is refused as
   * NOT_CONNECTED, while the operation in progress (its turn) and the
   * teardown's own releases still go out ahead of /logout.
   */
  private closing = false;
  /** Marks the teardown's own requests, which `closing` lets through. */
  private readonly teardownCtx = new AsyncLocalStorage<true>();
  /**
   * Set once the teardown's drain has ended: from then on no request for
   * mastership or write access goes out, from any operation, including one
   * still holding the turn past the drain bound. The teardown's release
   * would otherwise be followed by a fresh request, and the hold would stand
   * at /logout.
   */
  private accessClosed = false;
  // Not readonly: registerControlStationRemote() may be called with an explicit
  // identity, and that identity has to become this session's, because
  // getWriteAccessStatus() derives heldByMe by comparing the holder id with csId.
  private csName: string;
  private csId: string;
  private csPincode: string;
  /** Sends `release-write-access-when-lost=TRUE` with the registration. */
  private readonly csReleaseWhenLost: boolean;
  /** Whether the caller supplied the name / the id, or the defaults are in use. */
  private csNameSupplied: boolean;
  private csIdSupplied: boolean;
  /** Set once the anonymous-station note has been logged for this client. */
  private csAnonymousNoted = false;
  /**
   * How the registered station identity was chosen: the constructor's
   * `controlStation` option, an explicit `registerControlStationRemote(name,
   * id, pincode)` call, or the anonymous default. Null while not registered.
   */
  private csIdentity: 'option' | 'explicit' | 'default' | null = null;
  /**
   * The station's motion-control allowance as this client last set it, or
   * read it on a registered session; null until then, after a set that got
   * no answer, and after a re-issued session. A session that is not a
   * registered control station reads false whatever the station allows (RW
   * 8.2.1, 2026-10-21), so nothing is read before the registration.
   */
  private allowMotionControlKnown: boolean | null = null;
  /** The ISO time of this client's set that made the allowance true; null while it does not read true. */
  private allowMotionControlSince: string | null = null;
  /** True while the read after a registration, or the read back of a leftover's withdrawal, is out. */
  private checkingLeftover = false;
  /** `setAllowMotionControl(true)` calls in progress: the allowance reads null meanwhile. */
  private allowInFlight = 0;
  /** Number of the last allow-motion-control POST sent: an answer counts only when it is the latest. */
  private allowanceSeq = 0;
  /**
   * True from the moment a POST `true` is sent, before its answer, until a
   * POST `false` sent as the station that allowed it is taken, or a
   * registered session of that station reads false (never while a POST
   * `true` that got no answer may still be taken). It survives a teardown and
   * a re-issued session of this client: every withdrawal keys on it, so a new
   * session of the same station never inherits an allowance unseen.
   */
  private maybeDeclared = false;
  /**
   * Set when a POST `true` got no answer: the controller may still take it,
   * after any read. From then on only a POST `false` that is taken ends
   * `maybeDeclared`, never a read of false.
   */
  private unansweredAllow = false;
  /**
   * The control station (name and id) this client was registered as when it
   * sent the POST `true` behind `maybeDeclared`. A session registered as
   * another station cannot withdraw that allowance, and its reads say
   * nothing about it.
   */
  private declaredStation: { name: string; id: string } | null = null;
  /**
   * The allowance POST number covered by this disconnect's withdrawal attempt
   * (the manager's, made before the teardown): the number of the attempt's
   * own POST `false`, or the latest number when the attempt began if it sent
   * none. Null until one ran, and cleared by connect(). The teardown skips its
   * own step while no POST was made since, so a refused or unanswered
   * withdrawal is not tried twice, and a POST `true` made while that attempt
   * was on the wire is still withdrawn.
   */
  private teardownAttemptSeq: number | null = null;
  /**
   * The withdrawal in progress: what started it, and the allowance POST
   * number it covers so far. A second trigger joins it; a disconnect waits
   * for one started for another trigger, then makes its own.
   */
  private withdrawing: Withdrawal | null = null;
  /**
   * Marks a withdrawal's own requests (the registration it needs and the
   * POST `false`): they go out while `disconnect()` is closing, ahead of
   * /logout, even when the withdrawal began outside the teardown.
   */
  private readonly withdrawalCtx = new AsyncLocalStorage<true>();
  /** Longest a withdrawal may take, so a controller that does not answer cannot hold a disconnect. */
  static WITHDRAW_DEADLINE_MS = 3000;
  /**
   * Mastership taken with `requestMastershipWithId` on this session, with the
   * id the controller answered, oldest first. Released with the id on
   * `disconnect()`; forgotten by `releaseMastershipWithId`. Before, nothing
   * released such a hold at session end.
   */
  private withIdTokens: Array<{ domain: MastershipDomain; id: number }> = [];

  /**
   * The one place this session's mastership (RobotWare 7) or control-station
   * write access (RobotWare 8) is requested and released: reference counts per
   * real lock, and one write at a time. See AccessManager.
   */
  private readonly access = new AccessManager({
    label: 'RWS2',
    locks: (): readonly AccessLock[] => (this.writeAccessMode === 'controlstation' ? ['writeaccess'] : ['edit', 'motion']),
    lockOf: (d): AccessLock => (this.writeAccessMode === 'controlstation' ? 'writeaccess' : (d === 'motion' ? 'motion' : 'edit')),
    domainOf: (l): MastershipDomain => (l === 'motion' ? 'motion' : 'rapid'),
    request: (lock, d): Promise<void> => (lock === 'writeaccess' ? this.acquireWriteAccess() : this.wireRequestMastership(d)),
    release: (lock, d): Promise<void> => (lock === 'writeaccess' ? this.dropWriteAccess() : this.wireReleaseMastership(d)),
    generation: (): AccessGeneration | null => (
      this.writeAccessMode === 'controlstation' ? 'rw8' : this.writeAccessMode === 'mastership' ? 'rw7' : null),
    watchdog: (): WatchdogState | null => (this.heartBeatApplies() ? this.watchdog.state() : null),
    station: (): AccessState['rw8'] => {
      if (this.writeAccessMode !== 'controlstation') { return null; }
      const allowed = this.reportedAllowance();
      return {
        registered: this.controlStationRegistered, stationName: this.csName,
        identity: this.controlStationRegistered ? this.csIdentity : null,
        allowMotionControl: allowed,
        allowMotionControlSince: allowed === true ? this.allowMotionControlSince : null,
      };
    },
    // RobotWare 8: a mode change may end an allowance this client made.
    onModeChange: (): void => { this.triggerWithdrawal('mode-change'); },
    confirmHeld: (lock): Promise<{ held: boolean; by?: string }> | null => (
      lock === 'writeaccess' ? this.readOwnWriteAccess() : null),
    // RobotWare 8 names the holder by station id, which this session knows as
    // its own. RobotWare 7's mastership status carries a numeric uid this
    // session cannot match to itself, so there a request that did not answer
    // is passed on as before (and mastership dies with the session anyway).
    heldByMe: (lock): Promise<boolean> | null => (
      lock === 'writeaccess' ? this.readOwnWriteAccess().then(s => s.held) : null),
  });

  /**
   * Resets RobotWare 7.8+'s edit-mastership watchdog while this session holds
   * `edit`, reading the HeartBeat configuration (never writing it) for the
   * interval. See MastershipWatchdog.
   */
  private readonly watchdog = new MastershipWatchdog(this.access, {
    label: 'RWS2',
    applies: (): boolean => this.watchdogApplies(),
    kick: (): Promise<void> => this.wireResetWatchdog(),
    readHeartBeat: (): Promise<HeartBeatConfig> => this.readHeartBeatConfig(),
  });

  /** The all-domains request and release (one wire call each). */
  private readonly allDomainsWire: AllLocksWire = {
    request: () => this.wireRequestMastershipAll(),
    release: () => this.wireReleaseMastershipAll(),
  };

  constructor(
    private readonly baseUrl: string,
    username: string,
    password: string,
    opts: {
      /** Idle limit of one request in ms, default 10000: a finite number above
       *  0 and at most 2^31-1 (about 24.8 days). Anything else (0, a negative
       *  value, NaN, Infinity, a longer one) throws INVALID_ARGUMENT here, as
       *  `RwsClient` does for its own (see checkedTimeout in HttpSession.ts). */
      timeout?: number;
      /** Verify the controller's TLS certificate (default false). When true,
       *  against Node's default authorities and the operating system's
       *  store, the same set as the discovery probe's (tlsTrust.ts). When
       *  false over https, a warning is logged once per host and port in the
       *  process, except on this PC's loopback (warnUnverifiedTls). */
      rejectUnauthorized?: boolean;
      /** Largest response body accepted, in bytes; also caps one subscription
       *  event frame. A larger body is refused with NETWORK_ERROR and its
       *  connection dropped. Default 64 MiB, which leaves room for readFile. */
      maxResponseBytes?: number;
      /** Absolute limit for one request, in ms, from sending it to the last
       *  body byte. `timeout` is an idle limit that every received byte resets,
       *  so a peer trickling a body never trips it; this one it does. Default
       *  120000, or `timeout` when that is longer. 0 or Infinity turns it off;
       *  a value above 2^31-1 ms (about 24.8 days) is capped there. */
      requestDeadlineMs?: number;
      /** RW8 control-station identity used when the controller requires
       *  registration for write access. Defaults: name 'abb-rws-client',
       *  a per-instance braced GUID, pincode '1234'; without a name and an id
       *  the station is anonymous, which is logged once per client instance.
       *  `releaseWriteAccessWhenLost` (default false) adds ABB's optional
       *  `release-write-access-when-lost=TRUE` field to the registration; it
       *  is pending live confirmation (see `ControlStationIdentity`). Not
       *  validated here: `createAdapter`, `RobotManager` and
       *  `MultiRobotManager` check the identity they are given. */
      controlStation?: { name?: string; id?: string; pincode?: string; releaseWriteAccessWhenLost?: boolean };
    } = {},
  ) {
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.uasUser = username;
    this.isHttps = baseUrl.startsWith('https');
    // Refused here, before anything is sent, when Node's timers cannot hold
    // it (see checkedTimeout); the default deadline below is taken from it.
    this.timeoutMs = checkedTimeout(opts.timeout, 10000, 'RWS2');
    this.maxResponseBytes = opts.maxResponseBytes ?? Rws2Core.DEFAULT_MAX_RESPONSE_BYTES;
    const deadline = opts.requestDeadlineMs
      ?? Math.max(Rws2Core.DEFAULT_REQUEST_DEADLINE_MS, this.timeoutMs);
    // The value goes to setTimeout, which fires 0 on the next tick and anything
    // above 2^31-1 (Infinity included) after 1 ms: taken as given, either failed
    // every request at once. 0 and Infinity mean "no deadline"; longer values
    // are capped where the timer can hold them.
    this.requestDeadlineMs = deadline === 0 || deadline === Infinity
      ? 0
      : Math.min(Math.max(1, deadline), Rws2Core.MAX_TIMER_MS);
    this.rejectUnauthorized = opts.rejectUnauthorized ?? false;
    this.csName = opts.controlStation?.name ?? 'abb-rws-client';
    this.csId = opts.controlStation?.id ?? `{${randomUUID()}}`;
    this.csPincode = opts.controlStation?.pincode ?? '1234';
    this.csReleaseWhenLost = opts.controlStation?.releaseWriteAccessWhenLost === true;
    this.csNameSupplied = opts.controlStation?.name !== undefined;
    this.csIdSupplied = opts.controlStation?.id !== undefined;
    bindAccess(this, this.access);
    // RobotManager.getWriteAccessStatus reads the status strictly through this
    // client's session and station id (see readWriteAccessStatusStrict).
    bindWriteAccessStatusReader(this, () => this.readWriteAccessStatusStrict());
    // A request refused as held by someone else names the holder, with one
    // status read: RobotWare 8 by the holding station's name (never its id),
    // RobotWare 7 from the domain's mastership status. A write refused
    // because the FlexPendant holds write access is a take-back.
    this.access.setHolderLookup(async (lock: AccessLock) => {
      if (lock !== 'writeaccess') { return holderFromMastership(await this.getMastershipStatus(lock === 'motion' ? 'motion' : 'rapid')); }
      const holder = holderFromWriteAccess(await this.getWriteAccessStatus());
      if (isFlexPendantStation(holder?.name)) { this.triggerWithdrawal('take-back'); }
      return holder;
    });
    // So is a hold of write access lost to the FlexPendant.
    this.access.on(e => {
      if (e.type === 'lost' && e.lock === 'writeaccess' && isFlexPendantStation(e.by)) { this.triggerWithdrawal('take-back'); }
    });
    // RobotManager reaches the allowance through this port (see access/motionControl.ts).
    // Its reads throw NOT_CONNECTED once disconnect() began, as every read of
    // this client does, instead of reading as not known.
    bindMotionControl(this, {
      withdraw: (trigger: WithdrawalTrigger) => this.withdrawMotionControl(trigger),
      read: () => this.whileOpen('GET', buildPath(SYSTEM_MASTERSHIP.getAllowMotionControl.rws2 as PathSpec), () => this.readAllowanceIfRegistered()),
      localStationStatus: () => this.whileOpen('GET', buildPath(SYSTEM_MASTERSHIP.isLocalControlStationConnected.rws2 as PathSpec), () => this.readLocalStationStatus()),
      maybeDeclared: () => this.maybeDeclared,
    });
    // keepAlive reuses the TCP connection so we don't churn sessions on every poll.
    this.tlsCa = this.rejectUnauthorized && this.isHttps ? strictTlsCaOption() : {};
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      ...(this.rejectUnauthorized ? {} : { rejectUnauthorized: false }),
      ...this.tlsCa,
    });
    this.httpAgent  = new http.Agent({ keepAlive: true });
  }

  // ─── HTTP transport ────────────────────────────────────────────────────────

  /**
   * What this session knows when a request is refused, to explain it in
   * plain words: its owner's view (mode, controller state, RMMP, the
   * controller's name; see AccessManager.setRefusalContextSource), the UAS
   * user, and on RobotWare 8 whether the session is a registered control
   * station.
   */
  private refusalContext(): RefusalContext {
    return {
      ...this.access.refusalContext(),
      user: this.uasUser,
      ...(this.writeAccessMode === 'controlstation' ? { registered: this.controlStationRegistered } : {}),
    };
  }

  /** Set once a controller rejects hal+json (HTTP 406 or a non-JSON reply to a
   *  hal+json GET) - older RW7 releases predate HAL JSON. All subsequent GETs on
   *  this instance then go straight to XHTML instead of re-negotiating each time. */
  private preferXhtml = false;

  /**
   * Wait for this request's turn to start, keeping at least MIN_MS between the
   * starts of any two requests from this client.
   *
   * This used to read `lastReqTime`, await a timer, then write it back. Two
   * callers that arrived together both saw the old timestamp, both computed a
   * zero wait, and both fired: a check-then-act race, not a rate limit. Five
   * concurrent reads went out in 81 ms against a documented ceiling of 20
   * requests per second, and going over that ceiling is what makes the
   * controller answer 503. RWS 1.0's HttpSession always had a proper queue.
   *
   * Only the slot is chained, not the request itself, so a call that blocks
   * server-side (a DIPC read with a `timeout`, say) still cannot stall
   * everything queued behind it.
   */
  private takeRequestSlot(): Promise<void> {
    const previous = this.reqSlot;
    let release!: () => void;
    this.reqSlot = new Promise<void>(resolve => { release = resolve; });
    return (async () => {
      try { await previous; } catch { /* a failed slot must not wedge the chain */ }
      const wait = Rws2Core.MIN_MS - (Date.now() - this.lastReqTime);
      if (wait > 0) { await new Promise(r => setTimeout(r, wait)); }
      this.lastReqTime = Date.now();
      release();
    })();
  }

  /**
   * Core HTTP request. acceptExtra lists additional success status codes beyond 200/204.
   * Used by subscribe() to accept HTTP 201 (Created) from POST /subscription.
   * acceptOverride pins the Accept header for callers that must not negotiate
   * (e.g. getDeviceTree, which promises a raw XHTML document).
   */
  /** Methods that are safe to re-send. NEVER add a write here - see `req`. */
  private static readonly IDEMPOTENT = new Set(['GET', 'OPTIONS', 'HEAD']);

  /**
   * One paced request, retried once if a POOLED connection turned out to be dead.
   *
   * The client keeps connections alive, so a controller that closes an idle one
   * while the client is between paced requests leaves a corpse in the agent's
   * pool; the next request adopts it and fails with "socket hang up" before
   * anything was sent. Found by structural cell S09 (latency injection), where
   * 500 ms of delay widens the idle window enough to hit the race reliably.
   * (RWS 1.0 does not show it in that cell through fetch, its transport on
   * every port fetch accepts; fetch does not send such a request again, it
   * fails it, measured on Node 24.19 2026-10-22. On a port fetch refuses RWS
   * 1.0 uses node:http and sends a read again under a narrower rule: a reused
   * connection, within a second of sending, never a DIPC read, /logout or a
   * held request; see HttpSession.viaNodeHttp.)
   *
   * ONLY idempotent methods are retried. Re-sending a POST could execute a robot
   * command twice - starting RAPID, jogging, toggling an output - and no
   * reliability gain is worth that.
   *
   * `onHeaders` receives the status and headers of a successful answer (below
   * 400) before the body is returned: the file metadata read (HEAD) carries
   * its result in the headers alone.
   *
   * `holdMs` is how long the controller may keep this request open on purpose
   * before it answers (a DIPC read waiting for a message, say). The idle
   * timeout and the deadline of this one request are each extended by it, so
   * the client's own timers do not cut such a wait short; every other request
   * keeps the instance's limits.
   */
  protected async req(
    method: string,
    path: string,
    body?: Record<string, string>,
    rawBody?: string | Uint8Array,
    rawContentType?: string,
    acceptExtra: number[] = [],
    acceptOverride?: string,
    onHeaders?: (status: number, headers: http.IncomingHttpHeaders) => void,
    holdMs = 0,
  ): Promise<string> {
    // Checked BEFORE the slot is taken, and synchronously: disconnect() reserves
    // the /logout slot and closes in the same tick, so everything queued earlier
    // goes out ahead of /logout on the session it belongs to, and nothing can
    // queue behind it.
    if (this.closed || (this.closing && !this.access.inTurn() && !this.teardownCtx.getStore() && !this.withdrawalCtx.getStore())) {
      throw this.closedError(method, path);
    }
    await this.takeRequestSlot();
    // A request that would log in on its own while the login after a 401 is
    // on its way waits for it and goes out with the cookie it brings: one
    // login, not one per request. Rechecked after the wait: disconnect() may
    // have closed meanwhile, which refuses everything but the teardown's own
    // requests (its /logout then ends the new session). The slot taken
    // before the wait has passed, so the request takes a new one: the
    // requests that waited go out paced, not all at once.
    const waited = await this.waitForLogin();
    if (waited && this.closed && !this.teardownCtx.getStore()) { throw this.closedError(method, path); }
    // /logout ends the session its cookie names. With none (the controller
    // said it is gone and no login brought a new one) there is nothing to
    // end, and the credentials would only log in a session for it.
    if (this.sessionGone && path.split('?')[0] === '/logout') { return ''; }
    if (waited) { await this.takeRequestSlot(); }
    const attempt = (): Promise<string> =>
      this.attemptReq(method, path, body, rawBody, rawContentType, acceptExtra, acceptOverride, onHeaders, holdMs);
    try {
      return await this.withLogin(attempt, true, `${method} ${path}`);
    } catch (e) {
      if (!isStaleSocketError(e) || !Rws2Core.IDEMPOTENT.has(method.toUpperCase())) {
        throw e;
      }
      // The retry takes a new slot - behind /logout if the client closed meanwhile.
      if (this.closed) { throw e; }
      Logger.trace?.('http.req', `RWS2 ${method} ${path} - retrying once on a fresh connection`, {
        protocol: 'rws2', method, path,
      });
      await this.takeRequestSlot();
      return this.withLogin(attempt, true, `${method} ${path}`);
    }
  }

  /**
   * The credentials or the session cookie a request carries: the Basic
   * credentials until a session cookie is held, then the cookie alone, and
   * the credentials again, without the cookie, once the controller has said
   * that session is gone (sessionGone). A Basic login on a request without
   * the session cookie starts a new session, so the credentials go out only
   * to log in. The subscription WebSocket always carries the cookie alone.
   */
  private authHeaders(): { Authorization?: string; Cookie?: string } {
    return this.sessionCookie !== null && !this.sessionGone
      ? { Cookie: this.sessionCookie }
      : { Authorization: this.authHeader };
  }

  /**
   * A 401 answered a request that carried `cookie` and no credentials: the
   * session it names is gone (see sessionGone). Only while no answer has
   * brought a new cookie since that request went out.
   */
  private noteSessionGone(cookie: string | undefined): void {
    if (cookie !== undefined && cookie === this.sessionCookie) { this.sessionGone = true; }
  }

  /**
   * `send`, and once more after a login when the controller answered it 401
   * to the session cookie alone (goneSessionAnswers): the session is gone,
   * so the request was not taken, and it is sent again, a write too, with
   * what the login left (the new cookie, or the credentials when the login
   * got none). The cookie the login brings replaces the old one
   * (adoptSessionCookie), which forgets what the old session held. Once
   * only: a 401 to the credentials is final (AUTH_FAILED, this request's own
   * 401). Not once disconnect() has closed the client, and never for /logout
   * (see attemptReq). `pace` takes a request slot before sending again, as
   * req() does.
   */
  private async withLogin<T>(send: () => Promise<T>, pace: boolean, what: string): Promise<T> {
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof RwsError) || !this.goneSessionAnswers.has(e) || this.closed) { throw e; }
      try {
        await this.logIn(what);
      } catch (failed) {
        throw failed instanceof RwsError && failed.code === 'AUTH_FAILED' ? e : failed;
      }
      if (this.closed) { throw e; }
      if (pace) { await this.takeRequestSlot(); }
      return send();
    }
  }

  /**
   * The one login after a 401 to the session cookie: a short request of its
   * own, `GET /rw/system` (the request connect() logs in with) with the
   * credentials and without the cookie, whose answer brings the new cookie.
   * Every request that met the same 401, and every one that would log in on
   * its own meanwhile (waitForLogin), waits for it. The request that met the
   * 401 is not sent as the login itself: one the controller holds open (a
   * DIPC read waiting for a message) or a long upload would hold every other
   * request behind it, a stop too, until it is answered. Rejects when the
   * login fails; a 401 to it is AUTH_FAILED.
   */
  private logIn(what: string): Promise<void> {
    if (this.relogin) { return this.relogin; }
    Logger.info(`RWS2 ${what}: the controller no longer knows the session cookie (401) - logging in again`);
    // Sent past req(), so it never waits for itself (waitForLogin) and a 401
    // to it is never taken for one more login (withLogin); paced, and sent
    // once more on a fresh connection when a pooled one the controller had
    // closed fails at once, as req() does for a read.
    const path = buildPath(SYSTEM_MASTERSHIP.getSystemInfo.rws2 as PathSpec);
    const send = async (): Promise<void> => {
      await this.takeRequestSlot();
      await this.attemptReq('GET', path, undefined, undefined, undefined, [], ACCEPT_XHTML);
    };
    const login: Promise<void> = send()
      .catch(async (e: unknown) => {
        if (!isStaleSocketError(e) || this.closed) { throw e; }
        await send();
      })
      .finally(() => { if (this.relogin === login) { this.relogin = null; } });
    this.relogin = login;
    return login;
  }

  /**
   * Waits for the login in progress after a 401 to the session cookie
   * (logIn) when this request would otherwise carry the credentials and log
   * in on its own; true when it waited, whatever the login's outcome.
   */
  private async waitForLogin(): Promise<boolean> {
    const login = this.relogin;
    if (!login || !this.sessionGone) { return false; }
    await login.catch(() => undefined);
    return true;
  }

  /**
   * Over https without the certificate check: logged once per host and port
   * in this process (warnUnverifiedTls, tlsTrust.ts), before the connection
   * that carries the credentials or the session cookie goes out.
   */
  private noteUncheckedTls(url: URL): void {
    if (!this.isHttps || this.rejectUnauthorized) { return; }
    warnUnverifiedTls(url.hostname, url.port ? +url.port : 443);
  }

  private attemptReq(
    method: string,
    path: string,
    body?: Record<string, string>,
    rawBody?: string | Uint8Array,
    rawContentType?: string,
    acceptExtra: number[] = [],
    acceptOverride?: string,
    onHeaders?: (status: number, headers: http.IncomingHttpHeaders) => void,
    holdMs = 0,
  ): Promise<string> {
    const url = new URL(path, this.baseUrl);
    const bodyStr = rawBody ?? (body ? new URLSearchParams(body).toString() : undefined);
    // A byte body (a file upload) is traced and classified by its size only.
    const bodyText = typeof bodyStr === 'string' ? bodyStr : undefined;
    // A request the controller holds on purpose (see `req`) gets that hold on
    // top of both limits, capped where a timer can hold them; a deadline
    // turned off (0) stays off. The idle limit is never 0 (see the
    // constructor).
    const hold = Number.isFinite(holdMs) && holdMs > 0 ? holdMs : 0;
    const idleMs = Math.min(this.timeoutMs + hold, Rws2Core.MAX_TIMER_MS);
    const deadlineMs = this.requestDeadlineMs > 0
      ? Math.min(this.requestDeadlineMs + hold, Rws2Core.MAX_TIMER_MS)
      : 0;

    // RWS 2.0 requires Content-Type on all POST/PUT/DELETE requests, even with no body
    // (mastership and a few other endpoints return HTTP 406 without it).
    const writingMethod = method === 'POST' || method === 'PUT' || method === 'DELETE';
    // GETs negotiate HAL JSON; writes stay XHTML (form-POST responses are XHTML-only).
    const wantsHal = method === 'GET' && !this.preferXhtml
      && !acceptOverride && !isXhtmlOnlyPath(path);
    const accept = acceptOverride
      ?? (wantsHal ? ACCEPT_HAL : ACCEPT_XHTML);
    // The credentials until a session cookie is held, then the cookie alone.
    const sent = this.authHeaders();
    const options: http.RequestOptions & { agent?: https.Agent | http.Agent; rejectUnauthorized?: boolean } = {
      method,
      hostname: url.hostname,
      port: url.port ? +url.port : (this.isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        ...sent,
        Accept: accept,
        ...(writingMethod ? {
          'Content-Type':   rawContentType ?? 'application/x-www-form-urlencoded;v=2.0',
          'Content-Length': String(bodyStr ? Buffer.byteLength(bodyStr) : 0),
        } : {}),
      },
      agent: this.isHttps ? this.httpsAgent : this.httpAgent,
      // Must ALSO be set per-request, not only on the agent: hosts that replace the
      // agent (VS Code's extension host patches http/https and swaps custom agents for
      // non-localhost targets) would otherwise re-enable TLS verification and fail on
      // the self-signed certs ABB controllers ship. Live-reported on a real OmniCore RC
      // (abb-rws-vscode issue #2, 2026-05-18); localhost VCs never hit this because the
      // extension host doesn't intercept localhost traffic.
      ...(this.isHttps && !this.rejectUnauthorized ? { rejectUnauthorized: false } : {}),
      ...this.tlsCa,
    };
    this.noteUncheckedTls(url);

    const startedAt = Date.now();
    Logger.trace?.('http.req', `RWS2 ${method} ${path}`, {
      protocol: 'rws2', method, path,
      bodyPreview: typeof bodyStr === 'object' ? `<${bodyStr.byteLength} bytes>` : bodyText ? redactBody(bodyText)!.slice(0, 200) : undefined,
    });

    return new Promise((resolve, reject) => {
      const transport = this.isHttps ? https : http;
      // Every way this request can end (response, socket error, idle timeout,
      // deadline, byte cap) goes through claim(): the promise settles once, the
      // deadline never outlives the request, and the events that trail a
      // failure (the 'close' after a socket error, say) are ignored.
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const claim = (): boolean => {
        if (settled) { return false; }
        settled = true;
        clearTimeout(deadline);
        return true;
      };
      const fail = (message: string, status?: number): void => {
        if (claim()) { reject(new RwsError(message, 'NETWORK_ERROR', status)); }
      };
      const req = (transport as typeof https).request(options as https.RequestOptions, res => {
        // Adopt the session cookie from EVERY response that carries one. First
        // response: without this we leak one session per request (pool fills in
        // seconds). Later responses: a controller restart or an idle expiry
        // ends the session, the next request carrying its cookie answers 401,
        // and the login that follows (logIn) mints a fresh cookie - keeping
        // the stale one makes every WS upgrade 401 forever (live-observed on
        // RW7.21 2026-08-02 across a warm restart). Not from a 401: a refused
        // request starts no session, and a cookie it set would replace the
        // one the 401 says is gone, so the login would carry that cookie and
        // not the credentials (the RW 7.21.4 and 8.2.1 VCs set none on a 401).
        const setCookies = res.headers['set-cookie'];
        if (setCookies && setCookies.length > 0 && res.statusCode !== 401) {
          this.adoptSessionCookie(setCookies.map(c => c.split(';')[0]).join('; '));
        }

        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (c: Buffer) => {
          received += c.length;
          if (received > this.maxResponseBytes) {
            req.destroy();
            Logger.trace?.('http.err', `RWS2 ${method} ${path} → body over ${this.maxResponseBytes} bytes`, { protocol: 'rws2', method, path, status: res.statusCode, durationMs: Date.now() - startedAt });
            fail(`RWS2 ${method} ${path}: response body exceeds the ${this.maxResponseBytes}-byte limit - refused`, res.statusCode);
            return;
          }
          chunks.push(c);
        });
        // A connection cut mid-body ends the response with no 'end' and, when
        // the peer closed cleanly, with no error on the request either: the
        // promise used to stay pending for good.
        res.on('error', (e: Error) => fail(`RWS2 ${method} ${path}: response cut off mid-body (${e.message})`, res.statusCode));
        res.on('close', () => {
          if (!res.complete) { fail(`RWS2 ${method} ${path}: connection closed mid-response`, res.statusCode); }
        });
        res.on('end', () => {
          if (!claim()) { return; }
          // Nothing may throw out of an emitter listener: it would surface as an
          // uncaught exception in the host process (a body near V8's string
          // limit throws right here, in toString).
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const durationMs = Date.now() - startedAt;
            const status = res.statusCode ?? 0;
            // Not for an answer the hal+json fallback below re-requests: the retry reports its own.
            if (onHeaders && status < 400 && !(wantsHal && status !== 204 && !/json/i.test(String(res.headers['content-type'] ?? '')))) {
              onHeaders(status, res.headers);
            }
            if (status === 204) {
              Logger.trace?.('http.res', `RWS2 ${method} ${path} → 204`, { protocol: 'rws2', method, path, status, durationMs });
              resolve(''); return;
            }
            // HAL JSON negotiation fallback: a controller predating hal+json either
            // rejects the Accept outright (406) or ignores it and answers XHTML.
            // Retry this one request as XHTML and remember the preference so every
            // later GET on this instance skips the failed negotiation.
            if (wantsHal) {
              const contentType = String(res.headers['content-type'] ?? '');
              if (status === 406 || (status < 400 && !/json/i.test(contentType))) {
                this.preferXhtml = true;
                Logger.trace?.('http.res', `RWS2 ${method} ${path} → ${status} (hal+json not served - falling back to XHTML for this client)`, {
                  protocol: 'rws2', method, path, status, durationMs, contentType,
                });
                resolve(this.req(method, path, body, rawBody, rawContentType, acceptExtra, undefined, onHeaders, holdMs));
                return;
              }
            }
            if (acceptExtra.includes(status)) {
              Logger.trace?.('http.res', `RWS2 ${method} ${path} → ${status}`, { protocol: 'rws2', method, path, status, durationMs, bodyPreview: raw.slice(0, 200) });
              resolve(raw); return;
            }
            if (status >= 400) {
              const err = extractError(raw);
              Logger.trace?.('http.err', `RWS2 ${method} ${path} → ${status}`, { protocol: 'rws2', method, path, status, durationMs, errCode: err?.code, errMsg: err?.msg, bodyPreview: raw.slice(0, 300) });
              // A 403 needs no fallback: the classifier explains every 403, and
              // one without a code it knows as UNKNOWN with the controller's text.
              const fallback: RwsErrorCode =
                status === 401 ? 'AUTH_FAILED' :
                status === 503 ? 'CONTROLLER_BUSY' :
                status === 429 ? 'RATE_LIMITED' : 'UNKNOWN';
              // Classify by the controller's own error body (mastership vs RMMP
              // vs wrong mode vs missing resource) - status alone can't tell.
              const info = classifyControllerError({
                httpStatus: status, body: raw, method, path, fallback,
                context: this.refusalContext(), requestBody: bodyText,
              });
              // RobotWare 8: "Session is not part of a Control Station". The
              // controller no longer has this session registered, whatever this
              // client remembered; the next request for write access registers
              // again instead of trusting the stale flag.
              if (info.controllerCode === Rws2Core.NOT_A_CONTROL_STATION) { this.controlStationRegistered = false; }
              const failure = new RwsError(
                status === 401 ? `RWS2 ${method} ${path}: HTTP 401` : info.message,
                status === 401 ? 'AUTH_FAILED' : info.code,
                status,
                err?.msg,
                info.controllerCode ?? undefined,
                info.controllerMsg ?? undefined,
                status === 401 ? undefined : info.refusal,
                raw,
              );
              // A 401 to the session cookie alone: the session is gone, and
              // withLogin logs in and sends the request once more.
              // Not /logout: there is no session left to end.
              if (status === 401 && sent.Authorization === undefined) {
                this.noteSessionGone(sent.Cookie);
                if (url.pathname !== '/logout') { this.goneSessionAnswers.add(failure); }
              }
              reject(failure);
              return;
            }
            // A hal+json body the controller served but that is not JSON would
            // otherwise vanish: HalJsonParser swallows the JSON.parse failure
            // and every read on it answers empty, so the caller sees an empty
            // list or a `?? default` and no error. Known emitter: ABB's
            // RobotWare 7.10.0 release notes §3.9 say some RWS APIs under
            // /rw/cfg "could return invalid JSON value like """" (four
            // consecutive double quotes)" and that this "is now corrected";
            // no affected range is named, so "RW7 builds before 7.10.0" is
            // this client's inference from the fix version (release notes,
            // 2026-09-29). A reported RW 7.2 file-service listing with invalid
            // JSON cannot reach this check (this client reads /fileservice as
            // XHTML). One warning per request, with the path and the start of
            // the body; the body is still returned unchanged and nothing is
            // thrown here that was not thrown before. Not gated on
            // HalJsonParser.looksLikeJson: a whole body of `""""` does not start
            // with `{`, so parse() hands it to XhtmlParser, which finds no
            // elements and answers empty too - either way the caller sees
            // nothing, which is what the warning is for. The check is one extra
            // native JSON.parse per successful hal+json GET, on top of the one
            // HalJsonParser does later (follow-up: a parse-failed flag on
            // HalJsonParser, with the path passed in, would remove the double
            // parse; that file is a separate change).
            if (wantsHal && raw.length > 0) {
              try { JSON.parse(raw); } catch {
                Logger.warn(`RWS2 ${method} ${path}: the controller answered hal+json that is not valid JSON - the client's parsers (hal+json when the body starts with '{', XHTML otherwise) find nothing in it, so every read of this answer is empty (body starts: ${JSON.stringify(raw.slice(0, 80))})`);
              }
            }
            Logger.trace?.('http.res', `RWS2 ${method} ${path} → ${status} (${raw.length}b)`, { protocol: 'rws2', method, path, status, durationMs, bodyLen: raw.length });
            resolve(raw);
          } catch (e) {
            reject(new RwsError(
              `RWS2 ${method} ${path}: response could not be read - ${e instanceof Error ? e.message : String(e)}`,
              'PARSE_ERROR', res.statusCode,
            ));
          }
        });
      });
      req.on('error', (e) => {
        Logger.trace?.('http.err', `RWS2 ${method} ${path} → network error`, { protocol: 'rws2', method, path, error: String(e), durationMs: Date.now() - startedAt });
        fail(e instanceof Error ? e.message : String(e));
      });
      req.setTimeout(idleMs, () => {
        req.destroy();
        Logger.trace?.('http.err', `RWS2 ${method} ${path} → timeout`, { protocol: 'rws2', method, path, durationMs: Date.now() - startedAt });
        fail(`RWS2 timeout: ${path}`);
      });
      // The idle timeout above restarts with every byte received, so a peer
      // that trickles a body holds the request, and its memory, open for as
      // long as it likes. This deadline does not restart.
      if (deadlineMs > 0) {
        deadline = setTimeout(() => {
          req.destroy();
          Logger.trace?.('http.err', `RWS2 ${method} ${path} → deadline`, { protocol: 'rws2', method, path, durationMs: Date.now() - startedAt });
          fail(`RWS2 timeout: ${path} did not complete within the ${deadlineMs} ms deadline`);
        }, deadlineMs);
      }
      if (bodyStr) { req.write(bodyStr); }
      req.end();
    });
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.closed = false;
    this.closing = false;
    this.accessClosed = false;
    this.teardownAttemptSeq = null;
    this.access.allowTurns();
    const body = await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getSystemInfo.rws2 as PathSpec));
    // Cache the RobotWare version - it decides how write access works: RW7 uses
    // /rw/mastership, RW8 removed it (410 GONE) for the Control Station Service.
    const ver = parse(body).getState('sys-system')['rwversion'] ?? '';
    if (ver) {
      this.rwVersionRaw = ver;
      const major = Number(ver.split('.')[0]);
      if (Number.isFinite(major) && major > 0) {
        this.rwMajor = major;
        this.writeAccessMode = major >= 8 ? 'controlstation' : 'mastership';
      }
    }
    // One read of the HeartBeat configuration per connection, on RobotWare 7.8
    // and later including 8 (ABB's PC SDK gives 7.8 for the heartbeat; the
    // RobotWare 8 event 10139 ties the same configuration to write access).
    // Read only, never written. A refused or failed read leaves the values
    // unknown (null) and never fails the connect; nothing reads it again on
    // this connection.
    if (this.heartBeatApplies()) {
      try {
        this.watchdog.adoptConfig(await this.readHeartBeatConfig());
      } catch (e) {
        Logger.trace?.('mastership', `RWS2: the HeartBeat configuration could not be read at connect (${e instanceof Error ? e.message : String(e)}); whether the controller enforces it is unknown`);
        this.watchdog.adoptConfig({ select: null, timeoutMs: null });
      }
    }
  }

  /** Longest `disconnect()` waits for a write in progress before it releases and logs out. */
  static readonly DISCONNECT_DRAIN_MS = 5000;

  /** The teardown in progress: a second disconnect() joins it and sends nothing of its own. */
  private disconnecting: Promise<void> | null = null;

  /**
   * Teardown, in this order: the watchdog stops; RobotWare 8: a
   * motion-control allowance this client may have made is withdrawn, as the
   * first request (registering first when needed; at most
   * WITHDRAW_DEADLINE_MS; a refusal or no answer is logged and the teardown
   * goes on); the write in progress (if any) finishes, for at most
   * DISCONNECT_DRAIN_MS; RobotWare 8 write access is released when this
   * session ever requested it (a "does not have SPoC" answer means it was
   * already cleared; any other refusal is observed as `releaseFailed` and
   * logged); with-id mastership tokens are released; then `/logout`.
   * Requests from outside the operation in progress are refused from the
   * first tick of this call; the operation's own go out ahead of the logout.
   */
  async disconnect(): Promise<void> {
    if (this.disconnecting) { return this.disconnecting; }
    this.disconnecting = this.teardown().finally(() => { this.disconnecting = null; });
    return this.disconnecting;
  }

  private async teardown(): Promise<void> {
    // No watchdog reset goes out from here on; the next connection reads the
    // HeartBeat configuration again.
    this.watchdog.sessionEnded();
    this.closing = true;
    // No new operation gets the turn from here on; the one in progress may finish.
    this.access.refuseNewTurns();
    {
      await this.teardownCtx.run(true, async () => {
        // The safety step first: a start in flight that races it is refused,
        // which is right at a disconnect. A withdrawal already on its way
        // (after a re-issued session, say) finishes first, ahead of /logout.
        // RobotManager runs the same step as the first request of its own
        // disconnect; then this finds nothing to do, unless an allowance POST
        // was made after that attempt's own.
        while (this.withdrawing) { await this.withdrawing.done; }
        if (this.teardownAttemptSeq === null || this.teardownAttemptSeq !== this.allowanceSeq) {
          await this.withdrawMotionControl('disconnect');
        }
        const drained = await this.access.drain(Rws2Core.DISCONNECT_DRAIN_MS);
        if (!drained) {
          Logger.warn(`RWS2: a write was still in progress ${Rws2Core.DISCONNECT_DRAIN_MS} ms after disconnect() was called; releasing and logging out anyway`);
        }
        // From here on nothing requests access again, drained or not.
        this.accessClosed = true;
        if (this.writeAccessHeld || this.writeAccessRequested) {
          try {
            await this.dropWriteAccess();
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            Logger.warn(`RWS2: releasing control-station write access at disconnect was refused (${m}); the controller may still count it as this station's`);
            this.access.noteReleaseFailed('writeaccess', e);
          }
        }
        if (this.withIdTokens.length > 0) { await this.releaseWithIdTokens(); }
        // /logout invalidates the session server-side (frees the slot in the controller's pool).
        // Its slot is reserved synchronously inside req(), and the client closes in
        // the same tick: every request queued before this point goes out first, on
        // this session; every later one is refused (see `closed`). A second
        // disconnect() sends nothing.
        if (!this.closed) {
          const loggedOut = this.req('GET', '/logout').catch(() => {});
          this.closed = true;
          await loggedOut;
        }
      });
    }
    this.sessionCookie = null;
    this.sessionGone = false;
    // Registration is session-scoped - the next session must re-register.
    this.controlStationRegistered = false;
    this.csIdentity = null;
    // Not known again until the next session registers and reads it.
    // maybeDeclared is kept: a withdrawal that did not go through is sent
    // again at the next registration of this station.
    this.allowMotionControlKnown = null;
    this.allowMotionControlSince = null;
    this.writeAccessHeld = false;
    this.writeAccessRequested = false;
    // Every hold belonged to the session that just ended.
    this.access.sessionEnded('disconnect');
    // Drop pooled keep-alive sockets so the next connect() starts clean.
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }

  /** RobotWare version string from /rw/system (e.g. '7.21.0+229', '8.1.1+614'),
   *  cached on connect. Fetches if not connected yet. */
  async getRobotWareVersion(): Promise<string> {
    if (this.rwVersionRaw) { return this.rwVersionRaw; }
    // Never re-open a client its owner disconnected: that session would leak.
    if (this.closed) { throw this.closedError('GET', '/rw/system'); }
    await this.connect();
    return this.rwVersionRaw ?? '';
  }

  /** The RobotWare version `connect()` cached, or null before it ran (no
   *  request is made): for a domain method that adapts a message to a version
   *  it happens to know, never for a decision that needs the version. */
  protected cachedRobotWareVersion(): string | null { return this.rwVersionRaw; }

  getSessionCookie(): string | null { return this.sessionCookie; }

  /**
   * Adopt a session cookie the controller just issued. When it names a
   * DIFFERENT session than the one this client was using (the controller
   * restarted, or the old session idled out, and the login after the 401 to
   * its cookie minted a fresh one; see logIn), everything session-scoped on
   * the controller side is gone with it: the RW8 control-station registration and any write-access hold
   * (live-verified 2026-09-15 on RW8.1.1: a new session answers "Session is
   * not part of a Control Station" -1073435871 until it registers again).
   * The idle-expiry trigger is observed on RW 8.2.1+1023 (2026-09-29): after
   * about 5 minutes with no request the next one answers 401 with no new
   * cookie, and the session the Basic login then gets is unregistered until
   * it registers again. Forgetting them here is what makes the next write
   * re-register instead of failing on a registration that no longer exists.
   */
  private adoptSessionCookie(cookie: string): void {
    const sessionOf = (c: string | null): string => c?.match(/-http-session-=([^;]+)/)?.[1] ?? c ?? '';
    const previous = this.sessionCookie;
    this.sessionCookie = cookie;
    // A new cookie is a session to send again, whether or not the old one
    // was gone; the credentials go out no more (authHeaders).
    this.sessionGone = false;
    if (previous !== null && sessionOf(previous) !== sessionOf(cookie)) {
      if (this.controlStationRegistered || this.writeAccessHeld) {
        Logger.trace?.('mastership', 'RWS2 session was re-issued - control-station registration and write access forgotten (both are session-scoped)');
      }
      this.controlStationRegistered = false;
      this.csIdentity = null;
      // RobotWare 8: the allowance is not known on the new session. When this
      // client may have made one, it is withdrawn now (register, POST false,
      // read), so the new session does not inherit it unseen. Nothing is
      // allowed again: a person does that.
      this.allowMotionControlKnown = null;
      this.allowMotionControlSince = null;
      if (this.writeAccessMode === 'controlstation') {
        this.access.noteMotionControl(null, 'session-reissued');
        if (this.maybeDeclared && !this.closing && !this.closed) {
          this.outsideTurns(() => {
            void this.withdrawMotionControl('reissue').then(() => this.readAllowanceIfRegistered().catch(() => null));
          });
        }
      }
      this.writeAccessHeld = false;
      // writeAccessRequested and withIdTokens are kept: RobotWare 8 write
      // access outlives the session that took it (ABB documents it as
      // persistent, and a logout does not end it), and a with-id mastership
      // is held by its id, not by the cookie. disconnect() still releases
      // both. Whether the controller lets the new session release the old
      // session's hold is open (it may answer "does not have SPoC", taken as
      // already cleared); a live probe is scheduled.
      // A hold still counted was taken on the old session: it is recorded as
      // lost, and the next operation requests afresh on the new one.
      this.access.sessionEnded('session-reissued');
      // A new session may follow a restart: stop resetting the watchdog, and
      // read the HeartBeat configuration again now, as connect() does, so the
      // RobotWare 8 start warning and the RobotWare 7 reset interval follow the
      // configuration in force (a restart may have changed it). Nothing on
      // RobotWare 8 ever took an edit hold to read it later.
      this.watchdog.sessionEnded();
      if (this.heartBeatApplies()) {
        void this.readHeartBeatConfig().then(
          c => this.watchdog.adoptConfig(c),
          (e: unknown) => {
            Logger.trace?.('mastership', `RWS2: the HeartBeat configuration could not be read after the session was re-issued (${e instanceof Error ? e.message : String(e)})`);
            this.watchdog.adoptConfig({ select: null, timeoutMs: null });
          });
      }
    }
  }

  // ─── I/O signals ─────────────────────────────────────────────────────────────







  /**
   * Parse an `ios-signal-li` list and remember each signal's network/device
   * coordinates. Shared by `searchSignals` and `searchSignalsEx` so both
   * populate the same coordinate cache from the same shape.
   */
  protected parseSignalList(html: string): Signal[] {
    const p = parse(html);
    return p.getAllStates('ios-signal-li').map(s => {
      const name  = s['name'] ?? s['_title']?.split('/').pop() ?? '';
      const loc = signalLocation(s);
      if (loc && name) { this.sigCoords.set(name, loc); }
      return { name, value: s['lvalue'] ?? '0', type: (s['type'] ?? 'DI') as Signal['type'], lvalue: s['lvalue'] ?? '0' };
    });
  }













  // ─── Niche coverage (OPTIONS-verified forms, RW7.21, 2026-08) ────────────────
  // Every form below came from the endpoint's own OPTIONS response. Motion
  // supervision writes acquire motion mastership internally; the IO-network,
  // IO-device and motion writes change controller/robot state, so callers should
  // gate them like any other command.





























  // ─── File system ──────────────────────────────────────────────────────────────

  protected rws2Path(path: string): string {
    // Percent-encode per segment so names with spaces, '#', '%', etc. survive
    // URL parsing ('#' would otherwise be treated as a fragment and truncate the path).
    return path.replace(/\$HOME/g, 'HOME')
      .split('/').map(encodeURIComponent).join('/');
  }















  // ─── Tool / WObj management ─────────────────────────────────────────────────
  // RWS exposes these via the mechunit's tool-name / wobj-name attributes;
  // setting requires updating the active task's tooldata/wobjdata RAPID symbols.











  // ─── Mastership ───────────────────────────────────────────────────────────────

  private rws2Domain(domain: MastershipDomain): string {
    // RWS 2.0 renames: 'rapid' and 'cfg' both become 'edit' (confirmed: /rapid/request → 404)
    return (domain === 'rapid' || domain === 'cfg') ? 'edit' : domain;
  }

  /** True when `e` is the RW8 "mastership is gone" signal (HTTP 410). */
  private static isMastershipGone(e: unknown): boolean {
    return e instanceof RwsError && e.httpStatus === 410;
  }

  /**
   * Acquire write access the RW8 way: register this session as a remote control
   * station (once per session - registration is session-scoped), then request
   * write access. Live-verified 2026-08-04 on OmniCore VC RW8.1.1: register 204,
   * request 204, a real panel write succeeds under the grant, release 204.
   */
  private async acquireWriteAccess(): Promise<void> {
    await this.registerIfNeeded();
    const { path } = R2.requestWriteAccess();
    if (this.accessClosed) { throw this.accessClosedError(path); }
    // Set before the request goes out: a request that is not answered may
    // still be granted, and disconnect() releases whatever was ever requested.
    this.writeAccessRequested = true;
    await this.req('POST', path);
    this.writeAccessHeld = true;
    // A granted control-station request proves the Control Station Service,
    // which RobotWare 7 does not have (its /rw/controlstation answers 404).
    if (this.writeAccessMode === null) { this.writeAccessMode = 'controlstation'; }
  }

  /**
   * Register this session as a remote control station with the configured
   * identity, once per session (registration ends with the session). Used
   * before a write-access request and before writes the controller takes only
   * from a registered station (allow-motion-control).
   *
   * Right after a registration the motion-control allowance is read once
   * (`afterRegistration`), and withdrawn first when this client may have one
   * standing. `afterwards: false` is for the withdrawal step itself.
   */
  private async registerIfNeeded(afterwards = true): Promise<void> {
    if (!this.controlStationRegistered) {
      this.noteAnonymousStation();
      const { path, body } = R2.registerControlStationRemote(this.csName, this.csId, this.csPincode, this.csReleaseWhenLost);
      try {
        await this.req('POST', path, body);
      } catch (e) {
        // 403 "A control station has already been registered" -1073435874
        // (icode -20102): this session IS registered - the flag was simply
        // behind (a caller registered through the public method with its own
        // identity, or state was reset defensively). Live-captured 2026-09-15
        // on RW8.1.1. Anything else is a real refusal.
        if (!Rws2Core.isAlreadyRegistered(e)) { throw e; }
      }
      this.controlStationRegistered = true;
      this.csIdentity = this.csNameSupplied && this.csIdSupplied ? 'option' : 'default';
      if (afterwards) { await this.afterRegistration(); }
    }
  }

  /**
   * Send a write the controller takes only from a registered control station.
   * ABB lists "Registered as a Control station" as the prerequisite of
   * allow-motion-control and of the write-access release appeal (Control
   * Station Service Rev C). On RobotWare 8 this session registers first, once
   * per session, and takes no write access. Before connect() the generation
   * is not known yet (writeAccessMode is null) and the write is sent as is.
   * When the controller answers that the session is no control station
   * (-1073435871: no registration yet, or one that ended unseen), the session
   * registers and the write goes out once more, unless `mayRetry` says no;
   * RobotWare 7 (mastership) never retries. `beforeRetry` runs just before
   * that registration; `afterwards` is passed to `registerIfNeeded`.
   */
  private async sendAsControlStation<T>(
    send: () => Promise<T>,
    o: { afterwards?: boolean; mayRetry?: () => boolean; beforeRetry?: () => void } = {},
  ): Promise<T> {
    const afterwards = o.afterwards ?? true;
    if (this.writeAccessMode === 'controlstation') { await this.registerIfNeeded(afterwards); }
    try {
      return await send();
    } catch (e) {
      const notAStation = e instanceof RwsError && e.controllerCode === Rws2Core.NOT_A_CONTROL_STATION;
      if (!notAStation || this.writeAccessMode === 'mastership' || (o.mayRetry && !o.mayRetry())) { throw e; }
      o.beforeRetry?.();
      await this.registerIfNeeded(afterwards);
      return await send();
    }
  }

  /**
   * The step after each registration of this session: when this client may
   * have an allowance standing (`maybeDeclared`), a POST `false` first; then
   * one read of the allowance, which is what `RobotState.access.rw8`
   * reports from now on. When that read finds the station allowed and this
   * client made no allowance in this run, it is withdrawn at once
   * (`withdrawLeftover`). Never fails the registration or the write that
   * needed it.
   */
  private async afterRegistration(): Promise<void> {
    try {
      if (this.maybeDeclared) {
        if (this.declaredByAnotherStation()) {
          // Registered as another identity: that is another station, which
          // cannot withdraw the old one's allowance, so nothing is sent for it.
          const old = this.declaredStation!;
          Logger.warn(`RWS2: control station '${old.name}' may still allow motion control (an allowance this client made was not withdrawn); `
            + `this session registered as another control station (${old.name === this.csName ? 'the same name, another id' : `'${this.csName}'`}), `
            + 'which cannot withdraw it. Withdraw it at the FlexPendant, or register this client again as that station.');
        } else {
          await this.withdrawMotionControl('registration');
        }
      }
      // A leftover read here is not shown as allowed (noteAllowanceRead).
      this.checkingLeftover = true;
      let allowed: boolean | null;
      try { allowed = await this.readAllowanceIfRegistered(); } finally { this.checkingLeftover = false; }
      if (allowed === true && this.leftoverCandidate()) { await this.withdrawLeftover(); }
    } catch (e) {
      Logger.trace?.('mastership', `RWS2: the motion-control read after the registration failed (${e instanceof Error ? e.message : String(e)}); it reads as not known`);
    }
  }

  /**
   * The station read allowed at a registration, and this client made no
   * allowance in this run. The allowance belongs to the control station: a
   * process killed after allowing left it standing for its station, and a
   * new session registered with the same id read it true 7 min 42 s later
   * (RW 8.2.1, 2026-10-21); another live session registered with the same id
   * reads it too. It is withdrawn here, before the write that needed the
   * registration, and read back: a person confirms again before a start or
   * a jog, and this client never allows it on its own. From the moment it is
   * found it counts as possibly standing for this station (`maybeDeclared`),
   * so a withdrawal that is refused or gets no answer leaves the allowance
   * not known (null, never true) and is sent again at the disconnect and the
   * next registration.
   */
  private async withdrawLeftover(): Promise<void> {
    this.maybeDeclared = true;
    this.declaredStation = { name: this.csName, id: this.csId };
    if (await this.withdrawMotionControl('leftover') !== 'withdrawn') { return; }
    this.checkingLeftover = true;
    let after: boolean | null;
    try { after = await this.readAllowanceIfRegistered(); } catch { after = null; } finally { this.checkingLeftover = false; }
    if (after === true) {
      this.maybeDeclared = true;
      this.declaredStation = { name: this.csName, id: this.csId };
      this.applyAllowance(null, 'withdraw-failed');
      Logger.warn(`RWS2: motion control was still allowed for control station '${this.csName}' from an earlier run, and it still reads allowed after `
        + 'the withdrawal was taken. It reads as not known; the client withdraws it again at the disconnect and the next registration.');
      return;
    }
    Logger.warn(`RWS2: motion control was still allowed for control station '${this.csName}' from an earlier run (or another session registered as it); `
      + 'withdrawn. A person allows it again before a start or a jog.');
  }

  /**
   * Log, once per client instance, that this client is about to register as an
   * anonymous RobotWare 8 control station: the default name, an id generated
   * for this instance, or both. With the default name the controller reports
   * the holder of write access as `abb-rws-client`, like every other tool
   * built on this library; with a generated id every new client is a new
   * station. Behaviour is unchanged; the note says how to name the station.
   * Neither the id nor the PIN is logged.
   */
  private noteAnonymousStation(nameSupplied = this.csNameSupplied, idSupplied = this.csIdSupplied): void {
    if (this.csAnonymousNoted || (nameSupplied && idSupplied)) { return; }
    this.csAnonymousNoted = true;
    const what = [
      nameSupplied ? null : `the default name '${this.csName}'`,
      idSupplied ? null : 'an id generated for this client instance',
    ].filter(Boolean).join(' and ');
    Logger.warn(`RWS2: registering as an anonymous RobotWare 8 control station, with ${what}, so the controller sees a new station for every new client. `
      + 'Pass controlStation { name, id, pincode } (ConnectOptions, RobotManagerOptions or RobotConfig) to register as a named station with a stored id.');
  }

  /**
   * RW8 -1073435871 "Session is not part of a Control Station" (icode -20101):
   * the session is not registered. A new login answers it until it registers
   * (live-captured 2026-09-15 on RW8.1.1, on `writeaccess/request`; on
   * RW 8.2.1+1023 also for the session a Basic login gets after an idle
   * expiry, 2026-09-29).
   */
  private static readonly NOT_A_CONTROL_STATION = -1073435871;

  /** True when `e` is RW8's "A control station has already been registered" refusal. */
  private static isAlreadyRegistered(e: unknown): boolean {
    return e instanceof RwsError
      && e.httpStatus === 403
      && (e.controllerCode === -1073435874 || /already been registered/i.test(e.controllerMsg ?? ''));
  }

  /**
   * True when `e` is RW8's "this station holds no write access" answer to a
   * release: 403 -1073435873 "The control station does not have SPoC."
   * (icode -20107), live-verified 2026-09-15 and 2026-09-27 on an RW 8.1.1 VC.
   *
   * A write does not clear write access: raw speed-ratio writes and a module
   * load each left the hold in place (live-verified 2026-09-27 on RW 8.1.1,
   * and 2026-09-29 on RW 8.2.1+1023).
   * This answer used to follow every write made inside a caller's own hold
   * because the write's own release had already ended that hold. With holds
   * counted, only the release that ends the last hold goes out, so this answer
   * to a counted release means the hold ended some other way - the FlexPendant,
   * for one, can take write access back at any time - and it is recorded as a
   * loss (see AccessManager.noteReleaseNotHeld).
   */
  private static isWriteAccessAlreadyReleased(e: unknown): boolean {
    return e instanceof RwsError
      && e.httpStatus === 403
      && (e.controllerCode === -1073435873 || /does not have SPoC/i.test(e.controllerMsg ?? ''));
  }

  /** The teardown has released this session's access: a request now would be held at /logout. */
  private accessClosedError(path: string): RwsError {
    return new RwsError(`RWS2 POST ${path}: the client is disconnecting and has released its access - not sent; call connect() first`, 'NOT_CONNECTED');
  }

  private async dropWriteAccess(): Promise<void> {
    const { path } = R2.releaseWriteAccess();
    try {
      await this.req('POST', path);
    } catch (e) {
      // The documented usage is acquire -> try -> release-in-finally. Throwing
      // here would surface from the finally and mask the caller's real result
      // (or its real error). The answer is not dropped: the access manager
      // records it, as a loss when this session still counted a hold.
      if (!Rws2Core.isWriteAccessAlreadyReleased(e)) { throw e; }
      this.access.noteReleaseNotHeld('writeaccess');
    }
    this.writeAccessHeld = false;
    // Released, or the controller says nothing is held: a later disconnect has
    // nothing to release unless a request goes out again.
    this.writeAccessRequested = false;
  }

  /**
   * Run `fn` as this controller's one write in progress, holding `domains`
   * (RobotWare 7 mastership, RobotWare 8 write access) around it. A hold this
   * session already has on the same lock is reused, and only the release that
   * ends the last hold goes on the wire, so a write made inside a caller's own
   * hold never ends it.
   */
  protected withAccess<T>(
    domains: readonly MastershipDomain[], fn: () => Promise<T>, opts?: { releaseOnSuccess?: boolean },
  ): Promise<T> {
    return this.access.withAccess(domains, fn, opts);
  }

  /** The mastership request as sent; RobotWare 8 answers it 410 and is routed
   *  to control-station write access from then on. */
  private async wireRequestMastership(domain: MastershipDomain): Promise<void> {
    if (this.accessClosed) { throw this.accessClosedError(`/rw/mastership/${this.rws2Domain(domain)}/request`); }
    if (this.writeAccessMode === 'controlstation') { return this.acquireWriteAccess(); }
    const { path } = R2.requestMastership(this.rws2Domain(domain));
    try {
      await this.req('POST', path);
    } catch (e) {
      if (!Rws2Core.isMastershipGone(e)) { throw e; }
      this.writeAccessMode = 'controlstation';
      await this.acquireWriteAccess();
    }
  }

  private async wireReleaseMastership(domain: MastershipDomain): Promise<void> {
    if (this.writeAccessMode === 'controlstation') { return this.dropWriteAccess(); }
    const { path } = R2.releaseMastership(this.rws2Domain(domain));
    try {
      await this.req('POST', path);
    } catch (e) {
      if (!Rws2Core.isMastershipGone(e)) { throw e; }
      this.writeAccessMode = 'controlstation';
      await this.dropWriteAccess();
    }
  }

  private async wireRequestMastershipAll(): Promise<void> {
    if (this.writeAccessMode === 'controlstation') { return this.acquireWriteAccess(); }
    const { path } = R2.requestMastershipAll();
    try {
      await this.req('POST', path);
    } catch (e) {
      if (!Rws2Core.isMastershipGone(e)) { throw e; }
      this.writeAccessMode = 'controlstation';
      await this.acquireWriteAccess();
    }
  }

  private async wireReleaseMastershipAll(): Promise<void> {
    if (this.writeAccessMode === 'controlstation') { return this.dropWriteAccess(); }
    const { path } = R2.releaseMastershipAll();
    try {
      await this.req('POST', path);
    } catch (e) {
      if (!Rws2Core.isMastershipGone(e)) { throw e; }
      this.writeAccessMode = 'controlstation';
      await this.dropWriteAccess();
    }
  }

  /**
   * Request mastership. On RobotWare 8 the mastership service is REMOVED
   * (/rw/mastership answers 410 GONE) and write access goes through the Control
   * Station Service instead - this method routes there automatically, keyed off
   * the version detected at connect() or a live 410, so every write method in
   * this client works unchanged on RW7 and RW8. Control-station write access is
   * global: every domain is the same single lock on the RW8 path.
   *
   * Holds are counted per real lock (RW7: `edit`, which `rapid` and `cfg` both
   * name, and `motion`; RW8: the one write access). A request for a lock this
   * session already holds sends nothing; pair every request with one
   * `releaseMastership`.
   */
  requestMastership(domain: MastershipDomain): Promise<void> {
    return this.access.requestPublic(domain);
  }

  /** Release mastership; routes to control-station write-access release on RW8
   *  (see requestMastership). Ends this caller's most recent hold on the same
   *  lock; the release is sent when no other hold of this session is on it. */
  releaseMastership(domain: MastershipDomain): Promise<void> {
    return this.access.releasePublic(domain);
  }

  /** Request mastership on ALL domains at once (RWS 2.0). Cheaper than calling
   *  per-domain. Routes to control-station write access on RW8 (already global).
   *  Counts a hold on every lock.
   */
  requestMastershipAll(): Promise<void> {
    return this.access.requestPublicAll(this.allDomainsWire);
  }

  /** Release mastership on ALL domains at once (RWS 2.0). Routes to
   *  control-station write-access release on RW8. Ends this caller's most
   *  recent all-domains hold (or, with none, every hold it took through the
   *  request methods); locks an operation in progress still holds stay held
   *  until it ends.
   */
  releaseMastershipAll(): Promise<void> {
    return this.access.releasePublicAll(this.allDomainsWire);
  }

  /**
   * Request mastership on `domain` and receive a numeric id token
   * (`POST /rw/mastership/{domain}/request-with-id`). ABB's RWS 2.0 Mastership
   * service: "Mastership Id value will be obtained after executing this API.
   * This Id must be used for releasing mastership in release request with
   * mastership Id"; in manual mode "mastership can be gained after getting
   * RMMP" (3HAC073675-001 Rev L, Mastership Service).
   *
   * The id is remembered by this session: `disconnect()` releases every token
   * still held, with its id, before it logs out, so a token-held hold does not
   * outlive the session that took it. Release it earlier with
   * `releaseMastershipWithId`. The hold is not counted by the access manager
   * (a write of this session takes its own hold), and the RobotWare 7.8+
   * watchdog is not reset for it: call `resetMastershipWatchdog()` yourself
   * while RAPID runs under it.
   */
  async requestMastershipWithId(domain: MastershipDomain): Promise<number> {
    const xhtml = await this.req('POST', buildPath(SYSTEM_MASTERSHIP.requestMastershipWithId.rws2 as PathSpec, { domain: this.rws2Domain(domain) }));
    const id = parse(xhtml).get('mastership-id');
    if (!id) { throw new RwsError('RWS2 request-with-id: no mastership-id in response', 'PARSE_ERROR'); }
    const token = Number(id);
    this.withIdTokens.push({ domain, id: token });
    return token;
  }

  /**
   * Release every with-id token this session still holds, each with its own
   * id, oldest first. Called by `disconnect()` before the logout. A refused
   * release is logged as a warning and the next token is still released; the
   * list is cleared either way, because the tokens belonged to this session.
   */
  private async releaseWithIdTokens(): Promise<void> {
    const tokens = this.withIdTokens;
    this.withIdTokens = [];
    for (const t of tokens) {
      try {
        await this.sendReleaseWithId(t.domain, t.id);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        Logger.warn(`RWS2: releasing ${t.domain} mastership id ${t.id} at disconnect was refused (release-with-id: ${m}); `
          + 'the controller may still count it as held until the session expires or the mode changes');
      }
    }
  }

  /**
   * Release mastership previously acquired via `requestMastershipWithId()`.
   * The two calls spell the id differently, and ABB's Mastership service
   * documents both: the request-with-id answer carries it as `mastership-id`
   * (what `requestMastershipWithId` reads), and release-with-id takes it in
   * the form field `mastershipid`, with no dash (what this sends). Sent as
   * `mastership-id`, release-with-id is refused with 400 -1073445879 "Invalid
   * value for mastershipid" and the hold stays (live-verified 2026-09-29 on
   * RW 7.21.4).
   */
  async releaseMastershipWithId(domain: MastershipDomain, id: number): Promise<void> {
    await this.sendReleaseWithId(domain, id);
    this.withIdTokens = this.withIdTokens.filter(t => t.id !== id);
  }

  private sendReleaseWithId(domain: MastershipDomain, id: number): Promise<void> {
    return this.req('POST', buildPath(SYSTEM_MASTERSHIP.releaseMastershipWithId.rws2 as PathSpec, { domain: this.rws2Domain(domain) }),
      { mastershipid: String(id) }).then(() => {});
  }

  /**
   * Reset the edit-mastership watchdog (`POST /rw/mastership/watchdog`).
   *
   * ABB's RWS 2.0 Mastership service: mastership edit "is only valid for a
   * period of time", and this call starts that period again; the timeout is
   * configured in `SYS/MASTER_BOOL/HeartBeat`. ABB's PC SDK documents the
   * matching heartbeat from RobotWare 7.8: with `Select` true, when a holder
   * misses it during program execution, execution stops and the controller
   * goes to motors off (`Timeout` default 2000 ms).
   *
   * This client resets it itself, every `min(Timeout / 2, 1 s)`, while the
   * session holds `edit` mastership on RobotWare 7.8 or later - through
   * `requestMastership('rapid' | 'cfg')`, `requestMastershipAll` or any write
   * that holds it - and stops when the last hold ends or the client
   * disconnects. Calling this by hand is only needed for a hold the client
   * does not count, such as one taken with `requestMastershipWithId`.
   *
   * RobotWare 8 has no mastership service: refused with
   * `UNSUPPORTED_OPERATION`, without sending anything once the version is
   * known from `connect()`.
   */
  async resetMastershipWatchdog(): Promise<void> {
    if (this.writeAccessMode === 'controlstation') {
      throw new RwsError(
        `RWS2 mastership watchdog: ${this.rwVersionRaw ? `RobotWare ${this.rwVersionRaw}` : 'this RobotWare'} has no mastership service (RobotWare 8 uses control-station write access, which has no watchdog)`,
        'UNSUPPORTED_OPERATION');
    }
    await this.wireResetWatchdog();
  }

  /** The watchdog reset as sent. RobotWare 8 answers 410 and is routed to control-station write access from then on. */
  private async wireResetWatchdog(): Promise<void> {
    const { path } = R2.mastershipWatchdog();
    try {
      await this.req('POST', path);
    } catch (e) {
      if (!Rws2Core.isMastershipGone(e)) { throw e; }
      this.writeAccessMode = 'controlstation';
      const g = e as RwsError;
      throw new RwsError(
        `RWS2 mastership watchdog: the controller has no mastership service (HTTP 410${g.controllerMsg ? `: ${g.controllerMsg}` : ''})`,
        'UNSUPPORTED_OPERATION', g.httpStatus, g.rwsDetail, g.controllerCode, g.controllerMsg);
    }
  }

  /**
   * True while this session's watchdog must be reset: connected to RobotWare
   * 7.8 or later (the version ABB's PC SDK gives for the heartbeat) through
   * the mastership service. Unknown before `connect()` has read the version.
   */
  private watchdogApplies(): boolean {
    return this.heartBeatApplies() && this.writeAccessMode === 'mastership';
  }

  /**
   * True while the controller has the HeartBeat configuration this client
   * reads: RobotWare 7.8 or later, RobotWare 8 included (where the client
   * cannot reset the watchdog and only reports what it read). False before
   * `connect()` has read the version and after disconnect.
   */
  private heartBeatApplies(): boolean {
    if (this.closed) { return false; }
    const m = /^(\d+)\.(\d+)/.exec(this.rwVersionRaw ?? '');
    if (m === null) { return false; }
    const major = Number(m[1]);
    return major >= 8 || (major === 7 && Number(m[2]) >= 8);
  }

  /**
   * Read the HeartBeat configuration (`GET /rw/cfg/SYS/MASTER_BOOL/instances/HeartBeat`).
   * A read only: the client never writes this configuration. It decides whether
   * a silent mastership holder stops program execution and switches the
   * motors off, which is the cell integrator's setting.
   */
  private async readHeartBeatConfig(): Promise<HeartBeatConfig> {
    const body = await this.req('GET', buildPath(CFG_ELOG_DIPC.getCfgInstance.rws2 as PathSpec,
      { domain: 'SYS', type: 'MASTER_BOOL', instance: 'HeartBeat' }));
    return heartBeatFromAttributes(cfgInstanceAttributes(body));
  }

  /** Read mastership status for one domain - returns 'nomaster' | 'remote' | 'local' | similar. */
  async getMastershipStatus(domain: MastershipDomain): Promise<{ mastership: string; uid?: string; application?: string }> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getMastershipStatus.rws2 as PathSpec, { domain: this.rws2Domain(domain) })));
    const d = p.getState('msh-resource');
    return { mastership: d['mastership'] ?? 'unknown', uid: d['uid'], application: d['application'] };
  }

  /** List all mastership domains the controller exposes (typically `['edit', 'motion']`). */
  async listMastershipDomains(): Promise<string[]> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.listMastershipDomains.rws2 as PathSpec)));
    return p.getAllStates('msh-resource-li').map(d => d['_title']).filter(Boolean) as string[];
  }

  // ─── Control Station Service `/rw/controlstation` (RobotWare 8) ─────────────
  // RW8 removes Mastership (410 GONE) for this service. requestMastership /
  // releaseMastership route here automatically; the methods below expose the
  // full service directly. All parse classes live-verified 2026-08-04 on an
  // OmniCore VC RW8.1.1. On RW7 these endpoints answer 404.

  /**
   * Register this session as a remote control station. Required once per
   * session before write access on RW8 (registration dies with the session).
   * Uses the identity from the constructor's `controlStation` option unless
   * overridden. The id must be a braced GUID. The constructor's
   * `releaseWriteAccessWhenLost` choice is sent either way.
   *
   * Registering again the identity this session already registered succeeds
   * (the controller answers "already registered"); another identity in the
   * same session is refused, because the controller keeps the first.
   */
  async registerControlStationRemote(name?: string, id?: string, pincode?: string): Promise<void> {
    const useName = name ?? this.csName;
    const useId = id ?? this.csId;
    const usePincode = pincode ?? this.csPincode;
    // Explicit values count as supplied; the defaults do not.
    const nameSupplied = name !== undefined || this.csNameSupplied;
    const idSupplied = id !== undefined || this.csIdSupplied;
    this.noteAnonymousStation(nameSupplied, idSupplied);
    const { path, body } = R2.registerControlStationRemote(useName, useId, usePincode, this.csReleaseWhenLost);
    try {
      await this.req('POST', path, body);
    } catch (e) {
      // 403 -1073435874 "A control station has already been registered": the
      // controller takes one registration per session and keeps the first
      // (live-captured 2026-09-15 on RW 8.1.1). When this session registered
      // exactly this identity already, that is the state the caller asked
      // for. A different identity is not registered, so the refusal stands.
      const same = this.controlStationRegistered
        && useId.toLowerCase() === this.csId.toLowerCase() && useName === this.csName && usePincode === this.csPincode;
      if (!(same && Rws2Core.isAlreadyRegistered(e))) { throw e; }
      return;
    }
    // Adopt the identity actually registered. Without this, a caller that passes
    // an explicit id registers as that id while csId still holds the constructor
    // default, so getWriteAccessStatus().heldByMe compares the holder against the
    // wrong id and reads FALSE even when this session IS the holder.
    // Live-verified 2026-09-23 on RW8.1.1: registering with an explicit id gave
    // held=true/heldByMe=false with heldById matching the id we registered;
    // registering with no args gave held=true/heldByMe=true.
    this.csName = useName;
    this.csId = useId;
    this.csPincode = usePincode;
    this.csNameSupplied = nameSupplied;
    this.csIdSupplied = idSupplied;
    this.controlStationRegistered = true;
    // Recorded in RobotState.access.rw8.identity (the name and the source, never
    // the id or the PIN): an explicit call overrides the constructor's option
    // for this session.
    this.csIdentity = name !== undefined || id !== undefined || pincode !== undefined
      ? 'explicit' : (this.csNameSupplied && this.csIdSupplied ? 'option' : 'default');
    await this.afterRegistration();
  }

  /** Register as the LOCAL control station (pendant side). Field from the RW8
   *  migration guide; not exercisable from a remote client without local presence.
   *
   * @experimental Built from the controller form; never run against an RWS 2.0 controller.
   */
  async registerControlStationLocal(localPresenceKey: number): Promise<void> {
    const { path, body } = R2.registerControlStationLocal(localPresenceKey);
    await this.req('POST', path, body);
    this.controlStationRegistered = true;
    this.csIdentity = 'explicit';
    await this.afterRegistration();
  }

  /** Request write access (RW8 successor of mastership). Registers the control
   *  station first if this session has not yet. Counted like requestMastership:
   *  every domain is this same lock on RW8, so a write inside this hold never
   *  ends it. Pair it with one releaseWriteAccess. */
  requestWriteAccess(): Promise<void> { return this.access.requestPublic('rapid', { lock: 'writeaccess' }); }

  /** Release write access: ends this caller's most recent hold on it, and sends
   *  the release when no other hold of this session is on it. */
  releaseWriteAccess(): Promise<void> { return this.access.releasePublic('rapid', { lock: 'writeaccess' }); }

  /**
   * Ask the current write-access holder to release; monitor
   * getWriteAccessAppealChangeCount() and re-request when it changes. ABB
   * lists "Registered as a Control station" as the appeal's prerequisite
   * (Control Station Service Rev C), so on RobotWare 8 this session registers
   * first when it is not yet, as for allowing motion control, and takes no
   * write access. A -1073435871 answer registers once and appeals once more.
   */
  async appealWriteAccessRelease(): Promise<void> {
    const { path } = R2.appealWriteAccessRelease();
    await this.sendAsControlStation(() => this.req('POST', path));
  }

  /** Change count of release appeals (class ...-appeal-change-count). */
  async getWriteAccessAppealChangeCount(): Promise<number> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getWriteAccessAppealChangeCount.rws2 as PathSpec)));
    return Number(p.getState('controlstation-release-write-access-appeal-change-count')['changecount'] ?? 0);
  }

  /**
   * Who holds write access, and whether external control is enabled.
   *
   * `held` alone does not say whether THIS client can write: `held=true` with
   * another station's id means someone else owns it (a request then answers
   * 403 "cannot take SPoC when it is taken"). `heldByMe` compares the holder
   * id with this client's control-station id - the PC SDK's HeldByMe, which
   * the RWS resource does not carry itself. Live shape 2026-09-15 on RW8.1.1.
   */
  async getWriteAccessStatus(): Promise<{ held: boolean; heldByMe: boolean; heldById: string; heldByName: string; externalControlEnabled: boolean }> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getWriteAccessStatus.rws2 as PathSpec)));
    const d = p.getState('controlstation-write-access-status');
    const held = d['control-station-write-access-held'] === 'true';
    const heldById = d['held-by-control-station-Id'] ?? 'none';
    return {
      held,
      heldByMe:               held && heldById.toLowerCase() === this.csId.toLowerCase(),
      heldById,
      heldByName:             d['held-by-control-station-name'] ?? 'none',
      externalControlEnabled: d['control-station-external-control-enabled'] === 'true',
    };
  }

  /**
   * The strict reading of the same resource, for
   * RobotManager.getWriteAccessStatus: one GET, nothing registered or
   * requested; a field the answer does not carry is null, never `false`, and
   * an answer with no status entry is PARSE_ERROR (writeAccessStatusFrom).
   * getWriteAccessStatus() above keeps its reading unchanged: the holder
   * lookups in this client use it.
   */
  private async readWriteAccessStatusStrict(): Promise<WriteAccessStatus> {
    const path = buildPath(SYSTEM_MASTERSHIP.getWriteAccessStatus.rws2 as PathSpec);
    return writeAccessStatusFrom(await this.req('GET', path), this.csId, `RWS2 GET ${path}`);
  }

  /**
   * One status read for the access manager after an operating-mode change:
   * whether this station still holds write access, and the name (never the
   * id) of the station that does when another one does.
   */
  private async readOwnWriteAccess(): Promise<{ held: boolean; by?: string }> {
    const s = await this.getWriteAccessStatus();
    const other = s.held && !s.heldByMe && s.heldByName && s.heldByName !== 'none';
    return other ? { held: false, by: s.heldByName } : { held: s.heldByMe };
  }

  /** Control-station type of this session: 'none' | 'remote' | 'local'. */
  async getControlStationType(): Promise<string> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getControlStationType.rws2 as PathSpec)));
    return p.getState('controlstation-type')['control-station-type'] ?? 'none';
  }

  /** Control-station id bound to this session ('none' before registration). */
  async getControlStationId(): Promise<string> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getControlStationId.rws2 as PathSpec)));
    return p.getState('control-station')['control-station-Id'] ?? 'none';
  }

  /** Whether a local control station (pendant) is connected. */
  async isLocalControlStationConnected(): Promise<boolean> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.isLocalControlStationConnected.rws2 as PathSpec)));
    return p.getState('controlstation-local-connected')['control-station-local-isconnected'] === 'true';
  }

  /** Whether motion control is currently allowed for the control station.
   *  In hal+json the controller spells the class
   *  'controstation-allow-motion-control' (missing 'l'); in XHTML it is plain
   *  'controlstation' with title 'allow-motion-control' (both live RW8.1.1,
   *  2026-09-27); ABB's documented 'controlstation-allow-motion-control' is
   *  read too. An answer with no `is-enabled` is a PARSE_ERROR, never false.
   *
   *  The GET is sent as asked, registered or not; RW 8.2.1 answers a session
   *  that is not a registered control station false whatever the station
   *  allows (2026-10-21), so only a read on a registered session updates
   *  `RobotState.access.rw8.allowMotionControl`. */
  async getAllowMotionControl(): Promise<boolean> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getAllowMotionControl.rws2 as PathSpec)));
    const d = [
      p.getState('controstation-allow-motion-control'),
      p.getState('controlstation-allow-motion-control'),
      ...p.getAllStates('controlstation'),
    ].find(s => 'is-enabled' in s);
    if (!d) {
      throw new RwsError('getAllowMotionControl: the answer carried no is-enabled field', 'PARSE_ERROR');
    }
    const enabled = d['is-enabled'].trim().toLowerCase() === 'true';
    if (this.controlStationRegistered) { this.noteAllowanceRead(enabled); }
    return enabled;
  }

  /** What a read on a registered session of this station tells the state. */
  private noteAllowanceRead(enabled: boolean): void {
    // A leftover found at a registration is withdrawn, not shown as allowed.
    if (enabled && this.checkingLeftover && this.leftoverCandidate()) { return; }
    // A registered session of the station that allowed it reads false:
    // nothing of this client stands. Not while a POST true of it is on the
    // wire, nor after one got no answer (the controller may take it after
    // this read), nor when this session is another station.
    if (!enabled && this.allowInFlight === 0 && !this.unansweredAllow && !this.declaredByAnotherStation()) {
      this.allowanceEnded();
    }
    this.applyAllowance(enabled, 'read');
  }

  /**
   * Allow or withdraw motion control for this control station
   * (`POST /rw/controlstation/allowmotioncontrol`, RobotWare 8). ABB: "the
   * client must be registered as a control station"; "it's the responsibility
   * of the user to ensure that the required safety functions (emergency stop
   * and normal stop) are available at the control station to allow initiation
   * of motion. Setting this property is considered as a confirmation that those
   * safety functions are available" (RWS 2.0 site, Control Station Service,
   * Allow Motion Control). This client never sets it to true on its own; it
   * withdraws it on its own (this only removes the permission and is not a
   * stop): as the first request of
   * `disconnect()`, at the next registration of this station or after a
   * re-issued session when an earlier withdrawal did not go through, and at a
   * registration that finds the station allowed when this client made no
   * allowance in this run (`withdrawLeftover`). A jog or
   * a RAPID start on RobotWare 8 is refused while it is off.
   *
   * State (`RobotState.access.rw8.allowMotionControl`, `motionControl`
   * events): `true` reads null from the call until the answer; a 2xx gives
   * the value set (and `allowMotionControlSince` for true); a refusal leaves
   * the value as it was; no answer gives null, then one read. A `true` that
   * got no answer counts as possibly taken, whatever a later read says (the
   * controller may take it after the read): it is withdrawn at disconnect.
   * A `true` is refused with NOT_CONNECTED, nothing sent, once
   * `disconnect()` began.
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
   */
  async setAllowMotionControl(allow: boolean): Promise<void> {
    if (allow && (this.closing || this.closed)) {
      throw this.closedError('POST', buildPath(SYSTEM_MASTERSHIP.setAllowMotionControl.rws2 as PathSpec));
    }
    // From here until the answer, the allowance reads as not known (null).
    if (allow) { this.allowInFlight++; }
    let inFlight = allow;
    const done = (): void => { if (inFlight) { inFlight = false; this.allowInFlight--; } };
    // Set when a POST of this call went out and got no answer.
    let unanswered = false;
    const post = (): Promise<number> => this.postAllowance(allow).catch((e: unknown) => {
      if (Rws2Core.isUnanswered(e)) { unanswered = true; }
      throw e;
    });
    let seq: number;
    const standingBefore = this.maybeDeclared;
    try {
      // ABB: "The client must be registered as a control station." RW 8.2.1
      // refused it from an unregistered session with 403 -1073435871 "Session is
      // not part of a Control Station" and accepted it once the session was
      // registered, with no write access held (virtual-controller run 2026-10-13). So this session
      // registers first (once per session), and no write access is taken.
      // Before connect() the generation is not known yet (writeAccessMode is
      // null): the write is sent as is, and that refusal registers the session
      // once and sends it once more. RobotWare 7 answers 404, which is passed on.
      seq = await this.sendAsControlStation(post, {
        // The controller answered that this session is no control station:
        // that first POST left nothing standing, so the registration that
        // follows has nothing of this call's to withdraw.
        beforeRetry: () => { if (allow && !standingBefore && this.allowInFlight === 1) { this.allowanceEnded(); } },
      });
    } catch (e) {
      done();
      // No answer: the controller may have taken it, so it is not known; one read.
      if (unanswered) {
        if (allow) {
          // The read below is a snapshot: a POST true taken after it would
          // stand unseen. Only a POST false that is taken ends it.
          this.unansweredAllow = true;
          Logger.warn(`RWS2: allowing motion control for control station '${this.csName}' got no answer `
            + `(${e instanceof Error ? e.message : String(e)}); the controller may still take it, even after a read of false. `
            + 'This client counts it as possibly allowed and withdraws it at disconnect.');
        }
        this.applyAllowance(null, 'set');
        await this.readAllowanceIfRegistered().catch(() => null);
      }
      throw e;
    }
    done();
    // An answer counts only for the latest POST: a withdrawal sent after this
    // one (a disconnect, say) is not undone by this answer arriving later.
    if (seq === this.allowanceSeq) {
      // A false sent as another station withdraws nothing of the one that allowed it.
      if (!allow && !this.declaredByAnotherStation()) { this.allowanceEnded(); }
      this.applyAllowance(allow, 'set', allow ? new Date().toISOString() : null);
    }
    Logger.info(`RWS2: allow-motion-control set to ${allow} for control station '${this.csName}' - `
      + (allow
        ? 'a person confirmed that an emergency stop and a normal stop are within reach; jogging and RAPID starts from this station are now possible'
        : 'jogging and RAPID starts from this station are refused'));
  }

  /**
   * One POST of allow-motion-control; resolves with its number, which
   * `numbered` also gets as the POST is made. `true` marks `maybeDeclared`,
   * with the station this client is registered as, before it goes out: an
   * unanswered POST may still have been taken. Refused with NOT_CONNECTED,
   * nothing sent, for `true` once the client is closing.
   */
  private postAllowance(allow: boolean, numbered?: (seq: number) => void): Promise<number> {
    const { path, body } = R2.setAllowMotionControl(allow);
    if (allow && (this.closing || this.closed)) { return Promise.reject(this.closedError('POST', path)); }
    const seq = ++this.allowanceSeq;
    if (allow) { this.markDeclared(); }
    numbered?.(seq);
    return this.req('POST', path, body).then(() => seq);
  }

  /** A POST `true` is about to go out as the station this client is registered as. */
  private markDeclared(): void {
    if (this.declaredByAnotherStation()) {
      const old = this.declaredStation!;
      Logger.warn(`RWS2: control station '${old.name}' may still allow motion control (an allowance this client made was not withdrawn); `
        + `this client now follows the allowance of control station '${this.csName}' only. Withdraw the other at the FlexPendant.`);
      this.unansweredAllow = false;
    }
    this.maybeDeclared = true;
    this.declaredStation = { name: this.csName, id: this.csId };
  }

  /**
   * An allowed read now would be a leftover: nothing of this client's own
   * may stand (it made none in this run, or its own was withdrawn), no
   * person's true of it is on the wire, and it is not closing.
   */
  private leftoverCandidate(): boolean {
    return !this.maybeDeclared && this.allowInFlight === 0 && !this.closing && !this.closed;
  }

  /** Nothing of this client's allowance stands any more. */
  private allowanceEnded(): void {
    this.maybeDeclared = false;
    this.unansweredAllow = false;
    this.declaredStation = null;
  }

  /**
   * True while an allowance of this client may stand for a station other
   * than the one it is registered as now (registerControlStationRemote with
   * another id): this session can neither withdraw it nor read it.
   */
  private declaredByAnotherStation(): boolean {
    return this.maybeDeclared && this.declaredStation !== null && this.declaredStation.id.toLowerCase() !== this.csId.toLowerCase();
  }

  /** True for a request that got no answer from the controller (it may have been taken). */
  private static isUnanswered(e: unknown): boolean {
    return !(e instanceof RwsError) || e.code === 'NETWORK_ERROR';
  }

  /** The allowance as `RobotState` shows it: null while a `setAllowMotionControl(true)` is on the wire. */
  private reportedAllowance(): boolean | null {
    return this.allowInFlight > 0 ? null : this.allowMotionControlKnown;
  }

  /**
   * Take a new value of the allowance and tell the followers: always for a
   * set or a withdrawal, for a read only when the value changed.
   * `since` is the time of this client's set that made it true.
   */
  private applyAllowance(value: boolean | null, cause: MotionControlCause, since?: string | null): void {
    const before = this.allowMotionControlKnown;
    this.allowMotionControlKnown = value;
    if (value !== true) { this.allowMotionControlSince = null; } else if (since !== undefined) { this.allowMotionControlSince = since; }
    if (cause === 'read' && before === value) { return; }
    this.access.noteMotionControl(this.reportedAllowance(), cause);
  }

  /** The allowance read once; null, and nothing sent, while this session is not a registered control station. */
  private async readAllowanceIfRegistered(): Promise<boolean | null> {
    if (!this.controlStationRegistered) { return null; }
    return this.getAllowMotionControl();
  }

  /**
   * Withdraw an allowance this client may have made: nothing is sent unless
   * `maybeDeclared`. Registers first when needed (with this client's
   * identity), sends POST `allow-motion-control=false`, and on -1073435871
   * registers once and sends once more. No write access is taken. The whole
   * step has WITHDRAW_DEADLINE_MS. Taken: the allowance reads false,
   * `maybeDeclared` ends, info log. Refused or no answer: warning log and a
   * `withdraw-failed` event; `maybeDeclared` stays, so the next registration
   * of this station withdraws again. Never throws. A second trigger joins
   * the withdrawal in progress; a disconnect first waits for one started for
   * another trigger, then makes its own when an allowance may still stand.
   * Its requests go out while the client is closing (ahead of /logout).
   */
  private async withdrawMotionControl(trigger: WithdrawalTrigger): Promise<WithdrawalOutcome> {
    if (trigger === 'disconnect') {
      while (this.withdrawing && this.withdrawing.trigger !== 'disconnect') { await this.withdrawing.done; }
    }
    if (!this.maybeDeclared) { return 'nothing'; }
    // RobotWare 7 has no control stations: a POST true it answered 404 left nothing.
    if (this.writeAccessMode === 'mastership') { this.allowanceEnded(); return 'nothing'; }
    const running = this.withdrawing ?? this.startWithdrawal(trigger);
    const outcome = await running.done;
    // A disconnect's attempt: its teardown does not try again unless an
    // allowance POST was made after the attempt's own.
    if (trigger === 'disconnect') { this.teardownAttemptSeq = running.covered; }
    return outcome;
  }

  /** Start a withdrawal; its requests carry the withdrawal mark (see withdrawalCtx). */
  private startWithdrawal(trigger: WithdrawalTrigger): Withdrawal {
    const w: Withdrawal = { trigger, covered: this.allowanceSeq, done: Promise.resolve('nothing') };
    w.done = this.withdrawalCtx.run(true, () => this.runWithdrawal(trigger, w))
      .finally(() => { if (this.withdrawing === w) { this.withdrawing = null; } });
    this.withdrawing = w;
    return w;
  }

  private async runWithdrawal(trigger: WithdrawalTrigger, w: Withdrawal): Promise<WithdrawalOutcome> {
    const how: Record<WithdrawalTrigger, { cause: MotionControlCause; when: string }> = {
      'disconnect': { cause: 'withdrawn-at-disconnect', when: 'at disconnect' },
      'registration': { cause: 'withdrawn-at-registration', when: 'at the registration of a new session' },
      'leftover': { cause: 'withdrawn-leftover', when: 'at the registration, where it was still allowed from an earlier run,' },
      'reissue': { cause: 'withdrawn-after-reissue', when: 'after the controller re-issued the session' },
      'mode-change': { cause: 'withdrawn-on-mode-change', when: 'on a change of operating mode' },
      'take-back': { cause: 'withdrawn-on-take-back', when: 'after the FlexPendant took write access' },
    };
    const { cause, when } = how[trigger];
    // Registered as another identity since: that is another station, and a
    // POST false from it withdraws nothing of the one that allowed it.
    if (this.declaredByAnotherStation()) {
      const old = this.declaredStation!;
      Logger.warn(`RWS2: withdrawing motion control ${when} for control station '${old.name}' did not go through: `
        + 'this client is now registered as another control station, which cannot withdraw it. '
        + `The controller may still allow motion control for '${old.name}'. Withdraw it at the FlexPendant, or register this client again as that station.`);
      this.access.noteMotionControl(this.reportedAllowance(), 'withdraw-failed');
      return 'failed';
    }
    // Set at the deadline: the attempt sends nothing more after it.
    let stopped = false;
    const send = (): Promise<number> => (stopped
      ? Promise.reject(new RwsError('the withdrawal deadline passed', 'NETWORK_ERROR'))
      : this.postAllowance(false, seq => { w.covered = seq; }));
    const attempt = this.sendAsControlStation(send, { afterwards: false, mayRetry: () => !stopped });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ms = Rws2Core.WITHDRAW_DEADLINE_MS;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RwsError(`no answer within ${ms} ms`, 'NETWORK_ERROR')), ms);
    });
    try {
      const seq = await Promise.race([attempt, deadline]);
      if (seq === this.allowanceSeq) {
        this.allowanceEnded();
        this.applyAllowance(false, cause);
        Logger.info(`RWS2: motion control withdrawn ${when} for control station '${this.csName}'`);
      } else {
        // An allow-motion-control POST made after this one counts instead
        // (a disconnect withdraws again when it was a true).
        Logger.info(`RWS2: the withdrawal of motion control ${when} for control station '${this.csName}' was taken, `
          + 'but another allow-motion-control request was sent after it, and that one counts');
      }
      return 'withdrawn';
    } catch (e) {
      stopped = true;
      // A late answer is not waited for; the next registration withdraws again.
      attempt.catch(() => {});
      const why = e instanceof RwsError && e.controllerCode !== undefined ? `${e.controllerCode}: ${e.message}` : (e instanceof Error ? e.message : String(e));
      Logger.warn(`RWS2: withdrawing motion control ${when} for control station '${this.csName}' did not go through (${why}); `
        + 'the controller may still allow motion control for this station. It is withdrawn again at the next registration of this station.');
      // An allowance this client did not make is not known now, never true:
      // a person confirms again before it counts.
      if (trigger === 'leftover') { this.applyAllowance(null, 'withdraw-failed'); } else { this.access.noteMotionControl(this.reportedAllowance(), 'withdraw-failed'); }
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * An operating-mode change, or the FlexPendant taking write access, while
   * this client may have an allowance standing: one withdrawal, outside any
   * operation. Each trigger is off until turned on in
   * MOTION_CONTROL_WITHDRAWAL_TRIGGERS.
   */
  private triggerWithdrawal(trigger: 'mode-change' | 'take-back'): void {
    const on = trigger === 'mode-change' ? MOTION_CONTROL_WITHDRAWAL_TRIGGERS.modeChange : MOTION_CONTROL_WITHDRAWAL_TRIGGERS.takeBack;
    if (!on || !this.maybeDeclared || this.closing || this.closed) { return; }
    this.outsideTurns(() => { void this.withdrawMotionControl(trigger); });
  }

  /** Run `fn` outside the teardown's context and outside any operation's turn: its requests belong to the session. */
  private outsideTurns(fn: () => void): void {
    this.teardownCtx.exit(() => this.access.detach(fn));
  }

  /**
   * `read()` while this client is open; once `disconnect()` began, the
   * NOT_CONNECTED error every request of this client gets, and nothing is
   * sent. For the reads the manager makes through the motion-control port,
   * which would otherwise answer "not known" on a closed client.
   */
  private whileOpen<T>(method: string, path: string, read: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) { return Promise.reject(this.closedError(method, path)); }
    return read();
  }

  /**
   * The two RobotWare 8 FlexPendant connection reads, ABB's
   * `control-station-local-isconnected` and the TPU safety protocol's
   * `is-connected`. A read that fails, or whose answer has no such field with
   * `true` or `false`, gives null. Reads only.
   */
  private async readLocalStationStatus(): Promise<LocalStationStatus> {
    const flag = async (path: string, field: string): Promise<boolean | null> => {
      try {
        const entry = parse(await this.req('GET', path)).getAllEntries().find(s => field in s);
        const v = entry?.[field]?.trim().toLowerCase();
        return v === 'true' ? true : v === 'false' ? false : null;
      } catch (e) {
        Logger.trace?.('mastership', `RWS2: GET ${path} for the FlexPendant connection failed (${e instanceof Error ? e.message : String(e)})`);
        return null;
      }
    };
    return {
      flexPendantConnected: await flag(buildPath(SYSTEM_MASTERSHIP.isLocalControlStationConnected.rws2 as PathSpec), 'control-station-local-isconnected'),
      safetyProtocolConnected: await flag(buildPath(SYSTEM_MASTERSHIP.getTpuSafetyProtocolStatus.rws2 as PathSpec), 'is-connected'),
    };
  }

  /**
   * Turn off external control (Remote Access) on RobotWare 8. Only a local
   * control station (the FlexPendant) can: RW 8.2.1 answered a registered
   * remote station 403 -1073435869 "Only supported for Local Control
   * Stations" (2026-10-11); a remote client gets that refusal, which is
   * passed on.
   *
   * @experimental Built from the controller form; never run against an RWS 2.0 controller.
   */
  async disableExternalControl(): Promise<void> {
    const { path } = R2.disableExternalControl();
    await this.req('POST', path);
  }

  /** TPU (pendant) safety-protocol connection state. */
  async getTpuSafetyProtocolStatus(): Promise<boolean> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getTpuSafetyProtocolStatus.rws2 as PathSpec)));
    return p.getState('controlstation-tpu-safety-protocol-status')['is-connected'] === 'true';
  }








  // ─── WebSocket subscriptions ──────────────────────────────────────────────────

  /**
   * Maps a SubscriptionResource to the RWS 2.0 path;stateParam string.
   * Semicolons must NOT be URL-encoded - the controller requires them literal.
   */
  private static rws2ResourcePath(r: AnySubscriptionResource): string | null {
    if (typeof r === 'string') {
      const map: Record<string, string> = {
        controllerstate: '/rw/panel/ctrl-state;ctrlstate',
        operationmode:   '/rw/panel/opmode;opmode',
        speedratio:      '/rw/panel/speedratio;speedratio',
        execution:       '/rw/rapid/execution;ctrlexecstate',
        coldetstate:     '/rw/panel/coldetstate;coldetstate',
        uiinstr:         '/rw/rapid/uiinstr;uievent',
      };
      return map[r] ?? null;
    }
    switch (r.type) {
      case 'execycle':   return '/rw/rapid/execution;rapidexeccycle';
      case 'elog':       return `/rw/elog/${r.domain}`;
      // Signals subscribe on `;state`, NOT `;lvalue`: the controller answers
      // 400 "Invalid resource URI in Create Subscription request" for lvalue,
      // so signal subscriptions never worked on RWS 2.0 (fixed 2026-08, live
      // -verified on RW7.21 and RW8.1.1). The event still carries lvalue.
      // The name is checked first: it goes into the body and paths unencoded.
      case 'signal':
        assertSignalName(r.name);
        return `/rw/iosystem/signals/${r.name};state`;
      // Symbol paths are suffix-style on RWS 2.0 (/symbol/{url}/data), not the
      // RWS 1.0 prefix form (/symbol/data/{url}). Subscribing with the RWS 1.0
      // shape answers HTTP 500 "RW-Subscription service is down".
      case 'persvar':    return `/rw/rapid/symbol/RAPID/${stripRapidDomain(r.name)}/data;value`;
      case 'taskchange': return `/rw/rapid/tasks/${r.task};taskchange`;
      // Rev L: /rw/mastership/{edit|motion} and the motion system's
      // errorstate;erroreventchange (see addedResourcePaths). Mastership of
      // every domain is two paths: rws2ResourcePaths.
      case 'mastership':
      case 'motionerrorstate': {
        const paths = addedResourcePaths(r, 'rws2');
        return paths && paths.length === 1 ? paths[0] : null;
      }
      default:           return null;
    }
  }

  /** The RWS 2.0 paths of one resource: one, or one per domain for mastership of every domain. */
  private static rws2ResourcePaths(r: AnySubscriptionResource): string[] {
    const added = addedResourcePaths(r, 'rws2');
    if (added) { return added; }
    const one = Rws2Core.rws2ResourcePath(r);
    return one ? [one] : [];
  }

  /**
   * Map a resource URL path back to its friendly name for handleSubscriptionEvent.
   * Works with both /rw/panel/ctrlstate (RWS 1.0) and /rw/panel/ctrl-state (RWS 2.0).
   *
   * Anchored to the resources themselves - `/rw/panel/{name}`,
   * `/rw/rapid/execution`, `/rw/elog/` - each followed by `;`, `/`, `?` or the
   * end. The unanchored patterns this replaced matched such a word anywhere in
   * the path, so an I/O signal whose name starts with opmode, execution or
   * speedratio (`/rw/iosystem/signals/opmode_sel;state`) was renamed to a panel
   * resource: its own event never reached the signal's consumer, and the
   * manager's opmode, execstate or speed ratio took the signal's value.
   * Anything else, a friendly name included, comes back unchanged.
   *
   * `execution` is the name of the `;ctrlexecstate` subscription (the one both
   * generations send, see rws2ResourcePath and WsSubscriber) and the consumer
   * of `RobotState.execstate`. ABB's newer resources on the same path,
   * `/rw/rapid/execution;execstate` (an extended execution state: change
   * count, the user or task behind the change, the elog seqnum) and
   * `;execstatechange` (a change count over the RAPID domain: module or
   * program load, unload, delete), carry values that are NOT an execution
   * state, so they get their own names, `execstate` and `execstatechange`,
   * and never overwrite `execstate` in the manager. ABB lists both as new in
   * RobotWare 7.19.1 (release notes 7.19.1 §1.9-§1.10) and again as new in
   * 7.20 (release notes 7.20.0 §1.1) (release notes, 2026-09-29); neither has
   * been subscribed from this client yet.
   */
  static resourcePathToName(path: string): string {
    // An absolute href, or one without the leading slash, maps like its path.
    const p = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\/?/, '/');
    if (/^\/rw\/panel\/(?:ctrlstate|ctrl-state)(?:[;/?]|$)/.test(p)) { return 'controllerstate'; }
    if (/^\/rw\/panel\/opmode(?:[;/?]|$)/.test(p))                    { return 'operationmode'; }
    if (/^\/rw\/panel\/speedratio(?:[;/?]|$)/.test(p))                { return 'speedratio'; }
    // The extended state and the change count share the path with the
    // execution state; they are checked before the general `/rw/rapid/execution`
    // match below so that match cannot claim them. Their own order does not
    // matter: each pattern is anchored with `(?:[;/?]|$)`, so `;execstate`
    // cannot match `;execstatechange` (the next character is `c`).
    if (/^\/rw\/rapid\/execution;execstatechange(?:[;/?]|$)/.test(p)) { return 'execstatechange'; }
    if (/^\/rw\/rapid\/execution;execstate(?:[;/?]|$)/.test(p))       { return 'execstate'; }
    // The execution-cycle resource lives on the same path
    // (`/rw/rapid/execution;rapidexeccycle`) and is not execution state.
    if (/^\/rw\/rapid\/execution(?:[;/?]|$)/.test(p) && !/exec?cycle/.test(p)) { return 'execution'; }
    if (/^\/rw\/panel\/coldetstate(?:[;/?]|$)/.test(p))               { return 'coldetstate'; }
    if (/^\/rw\/elog\//.test(p))                                      { return 'elog'; }
    return path; // fallback: keep full path
  }

  /** First reconnect delay after a dropped subscription WebSocket (doubles per attempt). */
  private static readonly WS_RECONNECT_BASE_MS = 500;
  /** Upper bound for the reconnect delay. */
  private static readonly WS_RECONNECT_CAP_MS = 30000;
  /** Give up re-subscribing after this many consecutive failed attempts. */
  private static readonly WS_RECONNECT_MAX_ATTEMPTS = 6;
  /** How long to wait for the WebSocket upgrade to complete before treating the attempt as failed. */
  private static readonly WS_OPEN_TIMEOUT_MS = 8000;
  /** App-level PING cadence; the controller closes the WS after 30 s without activity. */
  private static readonly WS_PING_INTERVAL_MS = 25000;

  /**
   * POST /subscription - accept HTTP 201 (Created).
   * Captures the Location header (authoritative WS URL) and the group resource
   * path (`/subscription/{id}` - the URL a DELETE must target to free the group).
   *
   * Rides the client's main HTTP session: live-verified 2026-07-09 on OmniCore
   * VC RW7.21 (a probe script) - POST /subscription with the existing
   * session Cookie returns 201 with NO Set-Cookie (no new session minted) and
   * the WebSocket authenticates with that same cookie. Without the Cookie the
   * controller mints one session per subscribe, and reconnect loops would burn
   * through the 5-sessions-per-IP budget.
   */
  private createSubscription(bodyStr: string): Promise<{
    wsUrl: string; deleteUrl: string; cookieStr: string; answer: string;
  }> {
    return new Promise((resolve, reject) => {
      const subscriptionPath = buildPath(FILES_VISION.createSubscription.rws2 as PathSpec);
      const url = new URL(subscriptionPath, this.baseUrl);
      const encoded = Buffer.from(bodyStr);
      // As every request: the credentials until a session cookie is held,
      // then the cookie alone (authHeaders).
      const sent = this.authHeaders();
      const options: http.RequestOptions & { agent?: https.Agent; rejectUnauthorized?: boolean } = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port ? +url.port : (this.isHttps ? 443 : 80),
        path: subscriptionPath,
        headers: {
          ...sent,
          Accept:         'application/xhtml+xml;v=2.0',
          'Content-Type': 'application/x-www-form-urlencoded;v=2.0',
          'Content-Length': String(encoded.length),
        },
        // Per-request as well as on the agent - see req() for why (issue #2).
        ...(this.isHttps
          ? { agent: this.httpsAgent, ...(this.rejectUnauthorized ? {} : { rejectUnauthorized: false }), ...this.tlsCa }
          : {}),
      };
      this.noteUncheckedTls(url);
      const transport = this.isHttps ? https : http;
      // Settles once, through claim(), exactly like attemptReq.
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const claim = (): boolean => {
        if (settled) { return false; }
        settled = true;
        clearTimeout(deadline);
        return true;
      };
      const fail = (message: string, status?: number): void => {
        if (claim()) { reject(new RwsError(message, 'NETWORK_ERROR', status)); }
      };
      const req = (transport as typeof https).request(options as https.RequestOptions, res => {
        // Adopt the cookie whenever this POST's answer carries one, but a
        // 401's - the same rule as attemptReq. Normally the POST rides the
        // existing session (201, no Set-Cookie). After a restart or an idle
        // expiry the old session is gone, this POST carrying its cookie
        // answers 401, and once the login after it (withLogin) brought a
        // fresh cookie the POST is sent again with that one - the WS MUST
        // present the fresh cookie or the upgrade is rejected 401
        // (live-observed on RW7.21 2026-08-02). A POST that went out with the
        // credentials (no cookie held, or the login got none) logs in itself,
        // and its cookie is kept whatever the status, so the session it
        // started is the one the next request uses.
        const setCookies = (res.headers['set-cookie'] ?? []) as string[];
        if (setCookies.length > 0 && res.statusCode !== 401) {
          this.adoptSessionCookie(setCookies.map((c: string) => c.split(';')[0]).join('; '));
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (c: Buffer) => {
          received += c.length;
          if (received > this.maxResponseBytes) {
            req.destroy();
            fail(`RWS2 subscribe POST: response body exceeds the ${this.maxResponseBytes}-byte limit - refused`, res.statusCode);
            return;
          }
          chunks.push(c);
        });
        // A response that never completes (connection cut mid-body - a
        // controller restart does this) must NOT hang the reconnect loop
        res.on('aborted', () => fail('RWS2 subscribe POST aborted mid-response', res.statusCode));
        res.on('error', (e: Error) => fail(`RWS2 subscribe POST: ${e.message}`, res.statusCode));
        const onEnd = (): void => {
          if (res.statusCode !== 201) {
            // The controller's own code and message, so a refused subscribe
            // says why (RW 8.2.1 refused a single-resource speedratio subscribe
            // 400 on 2026-10-01, and this error carried nothing else). The
            // error code stays UNKNOWN, as callers of the reconnect loop expect.
            const raw = Buffer.concat(chunks).toString('utf8');
            const err = raw.trim() ? extractError(raw) : null;
            const controllerCode = err ? Number(err.code) : NaN;
            Logger.trace?.('http.err', `RWS2 POST ${subscriptionPath} → ${res.statusCode}`, {
              protocol: 'rws2', method: 'POST', path: subscriptionPath, status: res.statusCode,
              errCode: err?.code, errMsg: err?.msg, bodyPreview: raw.slice(0, 300), requestPreview: bodyStr.slice(0, 300),
            });
            const failure = new RwsError(
              `RWS2 subscribe POST returned ${res.statusCode}${err?.msg ? `: ${err.msg}` : ''}`,
              'UNKNOWN', res.statusCode, err?.msg || undefined,
              Number.isFinite(controllerCode) ? controllerCode : undefined, err?.msg || undefined,
            );
            // A 401 to the session cookie alone: the session is gone, and
            // withLogin logs in and sends this POST once more.
            if (res.statusCode === 401 && sent.Authorization === undefined) {
              this.noteSessionGone(sent.Cookie);
              this.goneSessionAnswers.add(failure);
            }
            reject(failure);
            return;
          }
          const body = Buffer.concat(chunks).toString('utf8');
          // Location header contains the WebSocket URL (wss://host/poll/{id})
          const location = (res.headers['location'] ?? '') as string;
          let wsUrl: string;
          if (location.startsWith('wss://') || location.startsWith('ws://')) {
            wsUrl = location;
          } else {
            // Fallback: parse from XHTML body
            wsUrl = body.match(/href="(wss?:\/\/[^"]+)"/)?.[1] ?? '';
          }
          // Group resource for cleanup. Live-verified 2026-07-09 on OmniCore VC
          // RW7.21: DELETE /subscription/{id} → 200 and the group disappears;
          // DELETE on the /poll/{id} URL → 404 (it is NOT a deletable resource).
          // The 201 body carries <a href="subscription/{id}" rel="group"/>.
          const groupId =
            body.match(/href="[^"]*subscription\/([^"/]+)"[^>]*rel="group"/)?.[1]
            ?? body.match(/rel="group"[^>]*href="[^"]*subscription\/([^"/]+)"/)?.[1]
            ?? wsUrl.match(/\/poll\/([^/?#]+)/)?.[1]
            ?? '';
          const deleteUrl = groupId ? `/subscription/${groupId}` : '';
          // The cookie this answer brought, if any, was adopted on arrival.
          const cookieStr = this.sessionCookie ?? '';

          if (!wsUrl) { reject(new RwsError('RWS2 subscribe: no WebSocket URL', 'PARSE_ERROR', 201)); return; }
          resolve({ wsUrl, deleteUrl, cookieStr, answer: body });
        };
        res.on('end', () => {
          if (!claim()) { return; }
          // Guarded like attemptReq's: a throw here would be uncaught.
          try {
            onEnd();
          } catch (e) {
            reject(new RwsError(
              `RWS2 subscribe POST: response could not be read - ${e instanceof Error ? e.message : String(e)}`,
              'PARSE_ERROR', res.statusCode,
            ));
          }
        });
      });
      req.on('error', (e: Error) => fail(e.message));
      // Without a timeout a half-open network stalls the reconnect loop
      // forever (no onLost, no further attempts)
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        fail(`RWS2 subscribe POST timed out after ${this.timeoutMs} ms`);
      });
      // Idle timeouts restart with every byte; see attemptReq.
      if (this.requestDeadlineMs > 0) {
        deadline = setTimeout(() => {
          req.destroy();
          fail(`RWS2 subscribe POST did not complete within the ${this.requestDeadlineMs} ms deadline`);
        }, this.requestDeadlineMs);
      }
      req.write(encoded);
      req.end();
    });
  }

  /**
   * Build the `resources=1&1=<path>&1-p=<prio>&resources=2&...` body shared by
   * the create POST and the in-place PUT. Returns null when nothing maps to a
   * real path.
   *
   * `resources=<i>` is repeated once PER resource - it names an index, it is
   * not a count. Live-verified 2026-09-24 on RW 7.21 and 8.1.1 VCs: with a
   * single `resources=6` the 201 lists ONE bound resource (the sixth) and no
   * other events ever arrive; with the index repeated all six are bound.
   *
   * Semicolons inside a resource path must stay LITERAL - percent-encoding them
   * makes the controller drop the state parameter. A path two resources map
   * to is sent once.
   */
  static buildSubscriptionBody(resources: AnySubscriptionResource[]): string | null {
    const paths = distinctPaths(resources.flatMap(r => Rws2Core.rws2ResourcePaths(r)));
    if (paths.length === 0) { return null; }
    return paths.map((p, i) => `resources=${i + 1}&${i + 1}=${p}&${i + 1}-p=1`).join('&');
  }

  // ─── Partial binds (panel resources) ─────────────────────────────────────────

  /**
   * The resources the group `groupPath` has not bound, after a create
   * answered with `answer`: `panel`, the panel resources, and `other`, the
   * rest. Panel resources a status block names count at once; those only
   * missing their initial event are checked against the group's own listing
   * (`GET /subscription/{group}`, the resources as the group stores them),
   * and count only when it leaves them out. When the listing cannot be read
   * they are logged and not counted: the group is kept as it is. `other` is
   * what the status blocks name outside the panel resources (as the request
   * sent them, see subscriptionBind's refusedAsSent): the group is kept
   * without them, and the handle lists them as `unbound`, so a caller can
   * read them some other way.
   */
  private async unboundAfterCreate(bodyStr: string, answer: string, groupPath: string): Promise<{ panel: string[]; other: string[] }> {
    const { refused, suspect, otherRefused, bound } = unboundPanelResources(bodyStr, answer);
    // What the create answer listed, at trace level, so a run's log shows
    // which resources each group bound.
    Logger.trace?.('subscription', `RWS2 subscription group ${groupPath || '(no group link)'} created`, {
      requested: subscriptionBodyResources(bodyStr), bound, refused, suspect, otherRefused,
    });
    if (otherRefused.length > 0) {
      Logger.warn(`RWS2 subscription: the controller did not bind ${otherRefused.join(', ')}`);
    }
    if (suspect.length === 0 || !groupPath) { return { panel: refused, other: otherRefused }; }
    let members: string[];
    try {
      members = (await this.getSubscriptionGroup(groupPath)).map(x => x.resource.split(';')[0]);
    } catch (e) {
      Logger.warn(`RWS2 subscription: the create answer has no initial event for ${suspect.join(', ')}, `
        + `and the group's listing could not be read (${e instanceof Error ? e.message : String(e)}); the group is kept`);
      return { panel: refused, other: otherRefused };
    }
    return { panel: [...refused, ...suspect.filter(u => !members.includes(u.split(';')[0]))], other: otherRefused };
  }

  /**
   * Create a group (createSubscription) and check that every panel resource
   * of the body was bound. A RobotWare 8.2.1 virtual controller left
   * `/rw/panel/speedratio;speedratio` out of a six-resource group while
   * answering 201 (2026-10-01 and 2026-10-18; the same body bound all six on
   * 2026-10-17), and a one-resource create of it answered 400; why is not
   * known. RobotWare 6.16.03 does the same while another live group holds the
   * resource in its other spelling (WsSubscriber.register). So, as the RWS 1.0
   * subscriber does: a group missing a panel resource is deleted and created
   * once more with that resource in its other spelling. If one is still
   * unbound, that group is deleted too and this throws, so the caller falls
   * back to polling (RobotManager polls everything at the full rate) instead
   * of trusting a group that never sends that resource's events. Returns the
   * body that bound, for the reconnects, and the other resources the kept
   * group's create answer names as refused (`unbound`, see
   * unboundAfterCreate).
   *
   * A create of one panel resource that the controller refuses whole (400
   * -1073445866, RW 8.2.1 for `/rw/panel/speedratio;speedratio` alone; see
   * respellableRefusal) is sent once more with the resource in its other
   * spelling. If that is refused the same way, or binds nothing, this throws
   * and names both spellings. Not yet run against RW 8.2.1 in this form.
   */
  private async createBoundSubscription(bodyStr: string): Promise<{
    wsUrl: string; deleteUrl: string; cookieStr: string; bodyStr: string; unbound: string[];
  }> {
    // As req(): a POST that would log in on its own while the login after a
    // 401 is on its way waits for it and goes out with the cookie it brings,
    // so the group, the WebSocket and the requests share one session. And as
    // req(), nothing goes out once disconnect() has begun: createSubscription
    // is sent past req(), and after the teardown no cookie is held, so a
    // create then (the re-create below, after a first answer that came late)
    // would go out with the credentials and start a session nothing logs out.
    const create = async (body: string): ReturnType<Rws2Core['createSubscription']> => {
      if (this.closed || this.closing) { throw this.closedError('POST', '/subscription'); }
      if (await this.waitForLogin() && (this.closed || this.closing)) { throw this.closedError('POST', '/subscription'); }
      return this.createSubscription(body);
    };
    let body = bodyStr;
    let first: Awaited<ReturnType<Rws2Core['createSubscription']>>;
    try {
      first = await this.withLogin(() => create(body), false, 'POST /subscription');
    } catch (e) {
      const refused = e instanceof RwsError ? respellableRefusal(body, e.httpStatus, e.controllerCode) : null;
      if (refused === null) { throw e; }
      const respelled = otherPanelSpelling(refused) as string;
      Logger.info(`RWS2 subscription: the controller refused a create of ${refused} alone (400 ${UNRESOLVED_URL}) - creating it with ${respelled}`);
      body = swapSubscriptionResources(body, [[refused, respelled]]);
      try {
        first = await this.withLogin(() => create(body), false, 'POST /subscription');
      } catch (e2) {
        if (!(e2 instanceof RwsError) || respellableRefusal(body, e2.httpStatus, e2.controllerCode) === null) { throw e2; }
        throw new RwsError(
          `RWS2 subscription: the controller refused ${refused} and ${respelled} alike (${e2.message})`,
          'UNKNOWN', e2.httpStatus, e2.rwsDetail, e2.controllerCode, e2.controllerMsg,
        );
      }
    }
    const { panel: unbound, other } = await this.unboundAfterCreate(body, first.answer, first.deleteUrl);
    if (unbound.length === 0 || !first.deleteUrl) {
      return { wsUrl: first.wsUrl, deleteUrl: first.deleteUrl, cookieStr: first.cookieStr, bodyStr: body, unbound: other };
    }
    if (body !== bodyStr) {
      // Already the other spelling: swapping back would send the refused one.
      await this.req('DELETE', first.deleteUrl).catch(() => undefined);
      throw new RwsError(
        `RWS2 subscription: the controller did not bind ${unbound.map(u => u.split(';')[0]).join(', ')} in either spelling`,
        'UNKNOWN',
      );
    }
    const swaps = unbound.map(u => [u, otherPanelSpelling(u) as string] as const);
    Logger.info(`RWS2 subscription: the controller did not bind ${unbound.join(', ')} - re-creating with ${swaps.map(s => s[1]).join(', ')}`);
    await this.req('DELETE', first.deleteUrl).catch(() => undefined);
    const retryBody = swapSubscriptionResources(bodyStr, swaps);
    const second = await this.withLogin(() => create(retryBody), false, 'POST /subscription');
    const { panel: still, other: otherStill } = await this.unboundAfterCreate(retryBody, second.answer, second.deleteUrl);
    if (still.length > 0) {
      if (second.deleteUrl) { await this.req('DELETE', second.deleteUrl).catch(() => undefined); }
      throw new RwsError(
        `RWS2 subscription: the controller did not bind ${still.map(u => u.split(';')[0]).join(', ')} in either spelling`,
        'UNKNOWN',
      );
    }
    // The first group was deleted: only the second answer says what the kept group left out.
    return { wsUrl: second.wsUrl, deleteUrl: second.deleteUrl, cookieStr: second.cookieStr, bodyStr: retryBody, unbound: otherStill };
  }

  async subscribe(
    resources: AnySubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    onLost?: () => void,
    onRestored?: () => void,
    opts?: Omit<WsSubscribeOptions, 'onLost' | 'onRestored'>,
  ): Promise<SubscriptionHandle> {
    // Effective tuning: per-call opts win over the class defaults.
    const reconnectBaseMs = opts?.reconnectBaseMs ?? Rws2Core.WS_RECONNECT_BASE_MS;
    const reconnectCapMs = opts?.reconnectCapMs ?? Rws2Core.WS_RECONNECT_CAP_MS;
    const maxReconnectAttempts = opts?.maxReconnectAttempts ?? Rws2Core.WS_RECONNECT_MAX_ATTEMPTS;
    const pingIntervalMs = opts?.pingIntervalMs ?? Rws2Core.WS_PING_INTERVAL_MS;
    const openTimeoutMs = opts?.openTimeoutMs ?? Rws2Core.WS_OPEN_TIMEOUT_MS;
    // 1. Build subscription body
    const firstBody = Rws2Core.buildSubscriptionBody(resources);
    if (firstBody === null) {
      // Nothing subscribable was asked for: hand back an inert handle with no
      // group, rather than failing - same behaviour as before, richer type.
      const noop = async (): Promise<void> => {};
      return Object.defineProperties(noop, {
        groupPath: { value: '', enumerable: true },
        unbound: { value: Object.freeze([]), enumerable: true },
      }) as SubscriptionHandle;
    }

    // We dynamically import 'ws' so callers who never subscribe don't pay for it.
    // (ESM-safe; the package is `"type": "module"`, so `require` is undefined.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wsMod = await import('ws') as { default: { new(url: string, protocols: string[], opts: object): any } };
    const WsImpl = wsMod.default;

    // Connection state shared between the reconnect logic and unsubscribe.
    const conn = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ws: null as any,
      deleteUrl: '',
      pingTimer: null as ReturnType<typeof setInterval> | null,
      reconnectTimer: null as ReturnType<typeof setTimeout> | null,
      closed: false,
      attempts: 0,
      lostNotified: false,
      // What the group held now left out (createBoundSubscription), set by
      // every open() and emptied wherever the group is let go (deleteUrl
      // ''), so it never names the last group's; the handle's `unbound`
      // reads it.
      unbound: Object.freeze([]) as readonly string[],
    };

    // Best-effort removal of a subscription group (DELETE /subscription/{id}).
    // Groups live as long as the session that owns them, and the session is the
    // client's main one - orphaned groups would pile up on every reconnect.
    const dropGroup = (path: string): Promise<void> =>
      path ? this.req('DELETE', path).then(() => {}, () => {}) : Promise.resolve();

    // The subscription rides the main HTTP session (see createSubscription), so a
    // dropped WebSocket does NOT invalidate the group, and its poll URL reopens
    // while the group lives (live-verified 2026-09-29 on RW 7.21.4+417 and
    // 8.2.1+1023). Every (re)connect still drops the previous group, then POSTs
    // a fresh /subscription on the same session, so the client never opens the
    // poll URL of a group that may be gone (a controller restart or session
    // expiry ends it); no extra sessions are ever minted.
    // The body that bound: a panel resource the controller left out is sent
    // in its other spelling from then on (createBoundSubscription).
    let bodyStr = firstBody;
    const open = async (): Promise<void> => {
      if (conn.deleteUrl) {
        await dropGroup(conn.deleteUrl);
        conn.deleteUrl = '';
        conn.unbound = Object.freeze([]);
      }
      const created = await this.createBoundSubscription(bodyStr);
      const { wsUrl: advertisedUrl, deleteUrl, cookieStr } = created;
      bodyStr = created.bodyStr;
      conn.deleteUrl = deleteUrl;
      conn.unbound = Object.freeze([...created.unbound]);

      // The Location header carries the controller's OWN authority. Keep the
      // advertised path but connect through the base URL this client was
      // configured with, so subscriptions work across NAT/port-forwarding
      // (parity with the RWS 1.0 subscriber; scheme follows the base URL).
      let wsUrl = advertisedUrl;
      try {
        const u = new URL(advertisedUrl);
        const base = new URL(this.baseUrl);
        u.protocol = this.isHttps ? 'wss:' : 'ws:';
        u.hostname = base.hostname;
        u.port = base.port;
        wsUrl = u.toString();
      } catch { /* keep the advertised URL - worst case matches the old behavior */ }
      try { this.noteUncheckedTls(new URL(wsUrl)); } catch { /* a URL that does not parse: the WebSocket refuses it below */ }

      // 2. Open WebSocket and wait for confirmation it actually connected.
      //    Auth: Cookie from subscription response (NOT Authorization header).
      //    Subprotocol: "rws_subscription" - the RWS 2.0 name. Live-verified 2026-07-08
      //    on OmniCore VC RW7.21: "robapi2_subscription" (the RWS 1.0 name) is rejected
      //    with HTTP 400; "rws_subscription" upgrades with 101.
      const ws = new WsImpl(wsUrl, ['rws_subscription'], {
        ...(this.rejectUnauthorized ? {} : { rejectUnauthorized: false }),
        ...this.tlsCa,
        headers: { Cookie: cookieStr },
        // Event frames are a few KB; one over the response cap closes the
        // socket (1009) and the reconnect path takes over.
        maxPayload: this.maxResponseBytes,
      });

      // Wait for the WebSocket to open.  If the controller rejects the upgrade,
      // we clean up and throw so the caller falls back to polling.
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) { return; }
          settled = true;
          ws.terminate();
          dropGroup(deleteUrl);
          reject(new Error(`WebSocket connection timed out after ${openTimeoutMs} ms`));
        }, openTimeoutMs);

        ws.on('open', () => {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          resolve();
        });

        // unexpected-response fires when the HTTP upgrade is rejected (e.g. 400).
        // The open-timeout stays armed until the promise actually settles: a
        // rejection response whose body never completes (controller restart
        // cuts the connection mid-body) would otherwise hang the reconnect
        // loop forever - no onLost, no further attempts.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ws.on('unexpected-response', (_req: unknown, res: any) => {
          const chunks: Buffer[] = [];
          const settleRejected = (bodyText: string): void => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            ws.terminate();
            dropGroup(deleteUrl);
            reject(new Error(`RWS2 WebSocket upgrade rejected (HTTP ${res.statusCode}): ${bodyText}`));
          };
          // Only the first 120 characters are reported; keep no more than a few KB.
          let kept = 0;
          res.on('data', (c: Buffer) => { if (kept < 4096) { chunks.push(c); kept += c.length; } });
          res.on('end', () => settleRejected((Buffer.concat(chunks).toString().trim() || '').slice(0, 120)));
          res.on('aborted', () => settleRejected('(response aborted)'));
          res.on('error', () => settleRejected('(response error)'));
          res.on('close', () => settleRejected('(connection closed mid-response)'));
        });

        ws.on('error', (err: Error) => {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          dropGroup(deleteUrl);
          reject(err);
        });
      });

      // Unsubscribed while the handshake was in flight - discard the connection.
      if (conn.closed) {
        ws.close();
        dropGroup(deleteUrl);
        return;
      }
      conn.ws = ws;

      // 3. Heartbeat - and the client must NOT send anything on this socket.
      //
      //    The previous implementation sent an app-level 'PING' text frame every
      //    25 s, on the premise that the controller closes an idle WebSocket at
      //    30 s, and terminated the stream if no 'PONG' came back. Both halves of
      //    that premise are false on OmniCore RW7.21, live-verified 2026-08-09 by
      //    structural cell S02:
      //
      //      - The controller REJECTS client data on the subscription socket. Any
      //        frame - 'PING' included - is answered by closing the connection
      //        with code 1008 "Client cannot send data." So the keep-alive was
      //        itself killing every subscription roughly every 25 s; the reconnect
      //        path then rebuilt it, which is why this looked like it worked
      //        instead of looking broken. Shown again 2026-09-29 on RW 7.21.4+417
      //        and 8.2.1+1023, lower-case 'ping' included.
      //      - The socket does NOT need a keep-alive. With the client sending
      //        nothing it stayed open well past 75 s, far beyond the 30 s idle
      //        close the comment claimed.
      //      - And the controller answers neither app-level 'PING' nor a
      //        protocol-level ws ping, so a PONG deadline could never have been a
      //        liveness signal in the first place. On a quiet resource the only
      //        thing that could clear it was an event that never came.
      //
      //    So liveness is established entirely OUT OF BAND: each interval, a cheap
      //    HTTP GET on the same session. Inbound frames still count as proof of
      //    life, so a busy stream never needs the probe to vouch for it. Two
      //    consecutive intervals with neither means the link is genuinely gone -
      //    a frozen link stalls HTTP too - so terminate and let the close event
      //    drive the reconnect path. That keeps detection at two intervals, which
      //    is the bound the freeze cell asserts, while a healthy idle stream is
      //    left completely alone.
      const isOpen = (): boolean => (ws as { readyState: number }).readyState === 1;
      /** Proof of life seen since the previous tick. True now: we just handshook. */
      let alive = true;
      let probeInFlight = false;

      conn.pingTimer = setInterval(() => {
        if (!isOpen()) { return; }

        if (!alive) {
          // Keep the phrase "heartbeat missed" stable: it is the shared wording
          // with the RWS 1.0 subscriber and the only externally observable marker
          // of this decision, so log sinks and tests key on it.
          Logger.warn('RWS2 heartbeat missed (no inbound frame, liveness probe unanswered) - terminating half-open WebSocket');
          if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
          ws.terminate();
          return;
        }

        alive = false;
        // Deliberately NO ws.send() here - see above.
        if (!probeInFlight) {
          probeInFlight = true;
          void this.req('GET', R2.controllerState())
            .then(() => { alive = true; })
            .catch(() => { /* leave `alive` false - the next tick decides */ })
            .finally(() => { probeInFlight = false; });
        }
      }, pingIntervalMs);

      // 4. Parse incoming events (same approach as abb-rws-client WsSubscriber).
      //    The whole dispatch is guarded: a throwing consumer handler must
      //    never propagate into the ws emitter (process crash) or kill the
      //    heartbeat/reconnect state machine.
      ws.on('message', (data: Buffer | string) => {
        // Any inbound frame is proof of life, so a busy event stream never needs
        // the out-of-band probe to vouch for it.
        alive = true;
        try {
          const raw = data.toString();
          if (raw === 'PONG') { return; }

          // One event per entry with a resource and a value; ABB's linkless
          // mastership entry names /rw/mastership/{title} (subscriptionFrameEntries).
          for (const e of subscriptionFrameEntries(raw)) {
            if (e.value === null) { continue; }
            handler({
              resource:  Rws2Core.resourcePathToName(e.resource),
              value:     e.value,
              timestamp: new Date(),
            });
          }
        } catch { /* consumer callback or malformed frame - never let it break us */ }
      });

      // Non-fatal error after open - the matching 'close' event drives cleanup/reconnect.
      ws.on('error', (err: Error) => {
        Logger.warn(`RWS2 WebSocket error: ${err.message}`);
      });

      ws.on('close', () => {
        if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
        if (!conn.closed) { scheduleReconnect(); }
      });
    };

    const scheduleReconnect = (): void => {
      // unsubscribe() clears the pending timer, but an open() already in
      // flight lands here through its .catch - without this guard it would
      // keep retrying (and eventually fire onLost) after the consumer left.
      if (conn.closed) { return; }
      if (conn.attempts >= maxReconnectAttempts) {
        const msg = `RWS2 subscription lost - giving up after ${conn.attempts} reconnect attempts`;
        Logger.error(msg);
        void dropGroup(conn.deleteUrl);
        conn.deleteUrl = '';
        conn.unbound = Object.freeze([]);
        if (!conn.lostNotified) {
          conn.lostNotified = true;
          try { onLost?.(); } catch { /* consumer callback - never let it break us */ }
        }
        return;
      }
      const delay = Math.min(reconnectBaseMs * 2 ** conn.attempts, reconnectCapMs);
      conn.attempts++;
      Logger.trace?.('subscription', `RWS2 WebSocket dropped - reconnect attempt ${conn.attempts} in ${delay} ms`);
      conn.reconnectTimer = setTimeout(() => {
        open()
          .then(() => {
            if (conn.closed) {
              // unsubscribe() won the race against this reconnect - tear the
              // fresh socket/group down instead of leaving a zombie stream.
              conn.ws?.close();
              const url = conn.deleteUrl;
              conn.deleteUrl = '';
              conn.unbound = Object.freeze([]);
              void dropGroup(url);
              return;
            }
            conn.attempts = 0;
            // Events may have been missed while the stream was down - tell the
            // consumer to resync (RobotManager runs one immediate full poll).
            try { onRestored?.(); } catch { /* consumer callback - never let it break us */ }
          })
          .catch(e => {
            Logger.warn(`RWS2 subscription reconnect failed: ${e instanceof Error ? e.message : String(e)}`);
            scheduleReconnect();
          });
      }, delay);
    };

    await open();

    // 5. Return unsubscribe - close WS and DELETE the subscription group.
    // The group resource path rides along on the returned function so callers
    // can edit the group in place (updateSubscriptionGroup /
    // unsubscribeResource) instead of tearing it down. Attaching it keeps the
    // return assignable to the previous `() => Promise<void>` signature.
    const stop = async (): Promise<void> => {
      conn.closed = true;
      if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); }
      if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
      conn.ws?.close();
      await dropGroup(conn.deleteUrl);
    };
    // Reconnects mint a new group, so read it live rather than snapshotting;
    // `unbound` likewise names what the group held now left out.
    Object.defineProperties(stop, {
      groupPath: { get: () => conn.deleteUrl, enumerable: true },
      unbound: { get: () => conn.unbound, enumerable: true },
    });
    return stop as SubscriptionHandle;
  }

  // ─── RMMP (Request Manual Mode Privileges) ─────────────────────────────────────
  // The manual-mode counterpart of a mastership request in Auto: in manual mode
  // mastership can be gained only after an operator at the FlexPendant grants
  // RMMP (ABB RWS 2.0 Mastership service). RobotWare 7 accepts a request in
  // MANR only and needs 'Program debug' (UAS_RAPID_DEBUG) for request, poll and
  // cancel. RobotWare 8 has no RMMP: on a controller known to be RobotWare 8
  // these methods send nothing (see access/rmmp.ts).

  /** The RMMP refusal on RobotWare 8, or null when RMMP may be called. */
  private rmmpOnRw8(op: string): RwsError | null {
    return this.writeAccessMode === 'controlstation' ? rmmpUnsupportedOnRw8(op, this.rwVersionRaw) : null;
  }

  /**
   * This session's RMMP privilege: `none`, `pending modify`, `modify` or
   * `exec` (ABB's values, read lower-case). The controller's `/users/rmmp`
   * names whoever holds the privilege, so a privilege another user holds
   * reads as `none` (`rmmpheldbyme` false).
   *
   * `unsupported` on RobotWare 8, where nothing is sent, and when the
   * controller answers that it does not offer RMMP (500 -1073445885, as RW
   * 8.1.1 does, or 410). Any other failure is thrown: a read that failed is
   * never reported as `none`.
   */
  async getRmmpPrivilege(): Promise<string> {
    if (this.rmmpOnRw8('getRmmpPrivilege')) { return 'unsupported'; }
    let xml: string;
    try {
      xml = await this.req('GET', buildPath(USERS_UAS.getRmmpPrivilege.rws2 as PathSpec));
    } catch (e) {
      // Live-verified 2026-08, 2026-09-15 and 2026-09-27 on RW8.1.1+614: GET
      // and poll answer 500 -1073445885 SYS_CTRL_E_SERVICE_NOT_SUPPORTED.
      if (isRmmpServiceUnsupported(e)) { return 'unsupported'; }
      throw e;
    }
    const p = parse(xml);
    const raw = p.get('privilege');
    if (raw === undefined) {
      throw new RwsError('getRmmpPrivilege: GET /users/rmmp answered without a privilege', 'PARSE_ERROR');
    }
    const priv     = normaliseRmmpPrivilege(raw);
    const heldByMe = (p.get('rmmpheldbyme') ?? 'false').trim().toLowerCase() === 'true';
    if (priv === 'none' || isRmmpPending(priv)) { return priv; }
    return heldByMe ? priv : 'none';
  }

  /**
   * Send an RMMP request (`privilege=modify` or `exec`; `'exclusive'` is a
   * deprecated alias of `'exec'`). Returns once the controller accepted it:
   * the request then waits for the operator at the FlexPendant, and ABB
   * deletes it after 10 s unless it is polled. `RobotManager.requestRmmp`
   * polls and waits.
   *
   * On RobotWare 8 it throws UNSUPPORTED_OPERATION and sends nothing. When
   * the controller answers that it does not offer RMMP (500 -1073445885 or
   * 410) it throws UNSUPPORTED_OPERATION with the controller's code.
   */
  async requestRmmp(level: RmmpLevel | 'exclusive' = 'modify'): Promise<void> {
    const refused = this.rmmpOnRw8('requestRmmp');
    if (refused) { throw refused; }
    const privilege = rmmpLevel(level);
    try {
      await this.req('POST', buildPath(USERS_UAS.requestRmmp.rws2 as PathSpec), { privilege });
    } catch (e) {
      if (isRmmpServiceUnsupported(e)) {
        const rw = this.rwVersionRaw ? `RobotWare ${this.rwVersionRaw}` : 'this RobotWare release';
        throw new RwsError(
          `requestRmmp: ${rw} does not offer RMMP (HTTP ${e.httpStatus}). ABB lists the RMMP service as not supported from RobotWare 8.1 on; `
          + 'on RobotWare 8 a remote station writes with control-station write access, which an operator enables by allowing Remote Access at the FlexPendant.',
          'UNSUPPORTED_OPERATION', e.httpStatus, undefined,
          e.controllerCode, e.controllerMsg,
        );
      }
      throw e;
    }
  }

  /** Poll a pending RMMP request. Call at least every few seconds after
   *  requestRmmp to keep the request alive past ABB's 10 s window, and read its
   *  `status` (ABB documents `NO SUCH REQUEST` when nothing is pending; other
   *  values are not documented). Live-verified 200 on RW7.21 (2026-08-11),
   *  class user-rmmp-poll. `unsupported` on RobotWare 8 (nothing sent) and
   *  when the controller answers that it does not offer RMMP; any other
   *  failure is thrown. */
  async pollRmmp(): Promise<string> {
    if (this.rmmpOnRw8('pollRmmp')) { return 'unsupported'; }
    let xml: string;
    try {
      xml = await this.req('GET', buildPath(USERS_UAS.pollRmmp.rws2 as PathSpec));
    } catch (e) {
      if (isRmmpServiceUnsupported(e)) { return 'unsupported'; }
      throw e;
    }
    const p = parse(xml);
    const status = p.get('status') ?? p.get('privilege');
    if (status === undefined) {
      throw new RwsError('pollRmmp: GET /users/rmmp/poll answered without a status', 'PARSE_ERROR');
    }
    return status;
  }

  /** Cancel this session's pending or held RMMP request (RWS 2.0 path-action
   *  /users/rmmp/cancel). Live-verified 204 on RW7.21 (2026-08-11). On
   *  RobotWare 8 it throws UNSUPPORTED_OPERATION and sends nothing. */
  async cancelRmmp(): Promise<void> {
    const refused = this.rmmpOnRw8('cancelRmmp');
    if (refused) { throw refused; }
    await this.req('POST', buildPath(USERS_UAS.cancelRmmp.rws2 as PathSpec)).then(() => {});
  }

  /** Info about the logged-in user session (uas-id, user-name, locale,
   *  application). Live-verified 2026-08-04 (RW7.21), class user-login-info. */
  async getLoginInfo(): Promise<Record<string, string>> {
    const p = parse(await this.req('GET', buildPath(USERS_UAS.getLoginInfo.rws2 as PathSpec)));
    return p.getState('user-login-info');
  }

  /**
   * Whether the logged-in user holds a UAS grant. Pre-check before an
   * operation that would 403. Live-verified 2026-08-04 (RW7.21).
   *
   * The two representations of this ONE resource spell the value differently:
   * hal+json returns class `user-grant-status` with a `status` field, while
   * XHTML returns the same class with a `grant-exist` span (both live-verified
   * 2026-09-29 on RW 7.21.4). Reading only the JSON spelling made this answer
   * false for a held grant once the client had fallen back to XHTML (after a
   * 406, or a hal+json GET answered with XHTML), and that fallback lasts for
   * the client instance. Both spellings are accepted now. An answer that
   * carries neither, or a value other than true/false, is refused with
   * PARSE_ERROR rather than read as "not held".
   */
  async checkGrantExists(grant: string): Promise<boolean> {
    const p = parse(await this.req('GET', `${buildPath(USERS_UAS.checkGrantExists.rws2 as PathSpec)}?grant=${encodeURIComponent(grant)}`));
    const s = p.getState('user-grant-status');
    const value = (s['status'] ?? s['grant-exist'])?.trim().toLowerCase();
    if (value === 'true') { return true; }
    if (value === 'false') { return false; }
    throw new RwsError(
      `checkGrantExists: GET /users/grant-exists answered without a grant status for ${grant}`,
      'PARSE_ERROR',
    );
  }

  /** All grants DEFINED on the controller (name, description, display name).
   *  Live-verified 2026-08-04 (RW7.21), class grant-info. (The _title of each
   *  entry is an unrendered controller template - fields are correct.) */
  /**
   * All grants DEFINED on the controller.
   *
   * The two representations of this ONE resource disagree: hal+json returns
   * class `grant-info` with a `grant-description` span, while XHTML returns
   * class `uas-grant` with a `description` span (live-verified 2026-08 on
   * RW7.21). Parsing only the JSON spelling made this return an empty list on
   * any controller served over XHTML - the fallback older RobotWare 7 releases
   * use. Both spellings are accepted now.
   */
  async listAllGrants(): Promise<Array<{ name: string; description?: string; displayName?: string }>> {
    const p = parse(await this.req('GET', buildPath(USERS_UAS.listAllGrants.rws2 as PathSpec)));
    const rows = [...p.getAllStates('grant-info'), ...p.getAllStates('uas-grant')];
    return rows.map(g => ({
      name: g['grant-name'] ?? g['grantname'] ?? '',
      description: g['grant-description'] ?? g['description'],
      displayName: g['display-name'],
    })).filter(g => g.name);
  }

  /** Grants HELD by the logged-in user. Live-verified 2026-08-04 (RW7.21),
   *  class uas-grant. (/uas/users and /uas/roles answer 403 without the UAS
   *  administration grant.) */
  async listCurrentUserGrants(): Promise<string[]> {
    const p = parse(await this.req('GET', buildPath(USERS_UAS.listCurrentUserGrants.rws2 as PathSpec)));
    return p.getAllStates('uas-grant').map(g => g['grantname']).filter(Boolean) as string[];
  }

  // ─── Jogging ─────────────────────────────────────────────────────────────────

  /**
   * @deprecated No longer used. A jog sends the controller's current
   * motion-system change count as `ccount`, read right before the jog (see
   * jog()); the private counter it replaced sent 1, 2, 3... against a count
   * the controller had not changed.
   */
  protected jogCcount = 0;



  // ─── Simulation panel (virtual controllers only) ─────────────────────────────
  // RobotWare 7 VCs expose the panel hardware (e-stop chain, enabling device) and
  // a joint-teleport endpoint for simulation. Real controllers do not serve these
  // paths (404) - the FlexPendant hardware is the source of truth there - so every
  // method below translates a 404 into a clear "virtual controllers only" error.
  // All wire shapes live-verified 2026-07-09 on an OmniCore VC RW7.21.

  /** Shared POST for the VC-only simulation endpoints. */
  protected async simPost(
    label: string,
    path: string,
    body?: Record<string, string>,
    rawBody?: string,
  ): Promise<void> {
    try {
      await this.req('POST', path, body, rawBody);
    } catch (e) {
      if (e instanceof RwsError && e.httpStatus === 404) {
        throw new RwsError(
          `${label}: ${path} returned 404 - simulation endpoints exist only on RobotWare 7 virtual controllers (not on real hardware or RW6)`,
          'UNKNOWN', 404, e.rwsDetail,
        );
      }
      throw e;
    }
  }













  // ─── Endpoint completion (2026-08-09) ──────────────────────────────────────
  // Every method below was built from the controller's own OPTIONS form, read
  // with Accept: application/xhtml+xml;v=2.0 - the ONLY representation that
  // serves forms. `*/*` and bare `application/xhtml+xml` both answer 406, which
  // is why an earlier pass recorded several of these as "406 / unsupported"
  // when in fact the request was simply mis-negotiated.









































  // ─── Subscription group editing ────────────────────────────────────────────
  // A group can be edited in place instead of being torn down and rebuilt.
  // The group's own OPTIONS form (live-read 2026-08-09 on RW8.1.1, with the
  // WebSocket held open - the group does not exist otherwise) advertises three
  // actions:
  //   <form method="delete" action="{id}"                 id="unsubscribe-group"/>
  //   <form method="delete" action="{id}/{resource-path}" id="unsubscribe-resource"/>
  //   <form method="put"    action="{id}"                 id="update-resource-priority"/>
  // Both clients previously only ever did the first.

  /**
   * Add resources to a live subscription group, or change their priorities,
   * without dropping and rebuilding the whole group.
   *
   * PUT /subscription/{group} is ADDITIVE, not a replace. Live-verified
   * 2026-08-09 on RW8.1.1: a group holding [/rw/panel/ctrl-state] that is sent
   * a PUT for /rw/panel/speedratio ends up holding BOTH. The 200 response body
   * carries the added resource's INITIAL value event (`pnl-speedratio-ev`), so
   * the caller gets its starting state without waiting for the first change.
   *
   * Two further answers (live-verified 2026-09-29 on RW 7.21.4+417 and
   * 8.2.1+1023): a PUT naming an unknown signal answers 400 -1073445866
   * "Invalid resource URI in Update Subscription request" but still binds the
   * valid resources sent in the same PUT, and its body lists them (one
   * `ios-signalstate-ev` entry each, with its value, in no fixed order) after
   * a status whose self link names the refused one; and a PUT naming only an
   * already-bound resource answers 200 with an empty body (no initial event).
   * The 400 is thrown as a `SubscriptionUpdateError` carrying those lists.
   *
   * @param groupPath the group resource, e.g. `/subscription/2` - take it from
   *   the `groupPath` on the handle `subscribe()` returned. NOT the
   *   `wss://.../poll/{id}` URL, which is not an HTTP resource at all (404).
   * @returns the raw XHTML initial-event payload for the added resources.
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for a signal
   *   name that is not letters, digits and underscores (optionally
   *   `network/device/signal`) - the same check `subscribe()` makes.
   * @throws SubscriptionUpdateError (an `RwsError`, same code and message) for
   *   any 400 answer read in full: `bound` lists the resource paths the
   *   controller bound anyway, `refused` the ones its status divs name, `body`
   *   the raw answer; both lists are empty when the body cannot be read. Any
   *   other failure, a 400 cut off mid-body included, throws the classified
   *   `RwsError`. A 2xx answer is returned as it is: RWS 2.0 answers a partly
   *   refused PUT 400 (above), where RWS 1.0 may answer 2xx (see
   *   `RWS1Adapter.updateSubscriptionGroup`).
   */
  async updateSubscriptionGroup(
    groupPath: string, resources: AnySubscriptionResource[],
  ): Promise<string> {
    const bodyStr = Rws2Core.buildSubscriptionBody(resources);
    if (bodyStr === null) {
      throw new RwsError(
        'updateSubscriptionGroup needs at least one resource that maps to a path',
        'INVALID_ARGUMENT',
      );
    }
    try {
      return await this.req(
        'PUT', groupPath, undefined, bodyStr,
        'application/x-www-form-urlencoded;v=2.0',
      );
    } catch (e) {
      throw asSubscriptionUpdateError(e);
    }
  }

  /**
   * The subscription groups of this session: GET /subscription.
   *
   * Served on RW 7.21.4+417 and 8.2.1+1023 (2026-09-29) though the RWS 2.0
   * Subscription_Service page (Rev L) documents no GET here: one `subsgrp-li`
   * per group, title = id, with a `rel="events"` link to its
   * `wss://.../poll/{id}` URL. Both builds answer XHTML even to a hal+json
   * Accept; both forms are read. Useful to find a group a crashed caller left
   * behind (ABB's Subscription_Service page, Rev L, allows 10 per client):
   * pass its `groupPath` to `getSubscriptionGroup`, or delete it.
   *
   * @returns one entry per group, `[]` when the session has none.
   * @throws RwsError `PARSE_ERROR` when the answer carries typed entries but
   *   no `subsgrp-li`; otherwise the controller's classified error.
   */
  async listSubscriptionGroups(): Promise<SubscriptionGroupInfo[]> {
    const body = await this.req('GET', buildPath(FILES_VISION.listSubscriptionGroups.rws2 as PathSpec));
    return subscriptionGroupsFrom(body, 'RWS2 listSubscriptionGroups');
  }

  /**
   * The resources bound to one subscription group: GET /subscription/{group}.
   *
   * Served on RW 7.21.4+417 and 8.2.1+1023 (2026-09-29; not documented on the
   * RWS 2.0 Subscription_Service page, Rev L): one `sub-resource` per member,
   * title = index, self link = the resource exactly as the group stores it
   * (`/rw/panel/speedratio;speedratio`). The list matches what the subscribe
   * bound, so it shows whether a resource joined. A group that is not this
   * session's, or no longer exists, answers 400 -1073435900 "Group N does not
   * belong to Client M." on both builds.
   *
   * @param group the group id (`'7'`) or its resource (`'/subscription/7'`,
   *   the `groupPath` of a subscription handle or of `listSubscriptionGroups`).
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for a group
   *   that is neither; `PARSE_ERROR` when the answer carries typed entries but
   *   no member; otherwise the controller's classified error.
   */
  async getSubscriptionGroup(group: string): Promise<SubscriptionGroupMember[]> {
    const id = subscriptionGroupId(group, 'RWS2 getSubscriptionGroup');
    const body = await this.req('GET', buildPath(FILES_VISION.getSubscriptionGroup.rws2 as PathSpec, { group: id }));
    return subscriptionMembersFrom(parse(body).getAllEntries(), 'RWS2 getSubscriptionGroup');
  }

  /**
   * Drop ONE resource from a live subscription group, leaving the group and its
   * WebSocket intact.
   *
   * DELETE /subscription/{group}/{resource-path} - the `unsubscribe-resource`
   * action from the group's own OPTIONS form (live-read 2026-08-09), whose
   * action spells the path out verbatim (`action="2/rw/panel/ctrl-state"`).
   *
   * Takes the same resource vocabulary as `subscribe()`, and the `;stateParam`
   * suffix is kept: the controller stores group membership as the EXACT string
   * it was given, so a group joined as `/rw/panel/speedratio;speedratio` must be
   * left by that same string. Live-verified 2026-08-09 on RW8.1.1 - PUT with
   * the suffix stores the suffixed form and a bare DELETE then answers 400
   * "does not have a resource ... in group", while PUT without it stores the
   * bare form and a bare DELETE succeeds.
   *
   * Removing the LAST resource retires the group - the controller then answers
   * 400 to any further PUT or DELETE on it. Call the unsubscribe handle instead
   * when the intent is to tear the whole group down.
   *
   * Mastership of every domain is two resources, edit and motion, so one
   * DELETE each (`dropFromGroup`).
   *
   * Refused with `INVALID_ARGUMENT`, before anything is sent, for an invalid
   * signal name or a resource path that would not stay under `groupPath`.
   */
  async unsubscribeResource(
    groupPath: string, resource: AnySubscriptionResource,
  ): Promise<void> {
    const mapped = Rws2Core.rws2ResourcePaths(resource);
    if (mapped.length === 0) {
      throw new RwsError(
        `unsubscribeResource: ${JSON.stringify(resource)} maps to no RWS 2.0 path`,
        'INVALID_ARGUMENT',
      );
    }
    // Appended verbatim; refused when it would not stay inside the group.
    await dropFromGroup(groupPath, mapped, 'unsubscribeResource', async path => { await this.req('DELETE', path); });
  }

}
