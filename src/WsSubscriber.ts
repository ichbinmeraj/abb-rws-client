/**
 * WsSubscriber - WebSocket subscription manager for ABB IRC5 RWS events.
 *
 * Flow:
 *   1. POST /subscription via HttpSession to register resources → get subscription ID
 *   2. Open WebSocket to ws://{host}/subscription/{id} with robapi2_subscription subprotocol
 *   3. subscribe() resolves only once the WebSocket is open; if the socket errors or
 *      closes before opening, subscribe() rejects and best-effort DELETEs the
 *      registration so the controller-side subscription slot is not leaked
 *   4. Parse incoming XML event messages → emit typed SubscriptionEvent objects
 *   5. Auto-reconnect when an established stream drops (any close the client
 *      did not ask for, a clean one included): capped exponential backoff
 *      (1 s doubling to 30 s, 6 attempts ~ 61 s by default, all tunable via
 *      WsSubscribeOptions). Each attempt first retries the stored poll URL -
 *      IRC5 poll URLs are reusable after a drop (live-verified 2026-08-02 on
 *      RW6.16 VC: reopen of the same /poll/{id} upgrades fine; RWS 2.0 poll
 *      URLs also reopen while their group lives, 7.21.4 and 8.2.1,
 *      2026-09-29). On RW 6.16.03, while the client owns any group, /poll/{id}
 *      upgrades for any id, even a deleted or never-created one, and answers
 *      404 only once the client owns no group (2026-09-29; which events such
 *      a socket then carries was not tested) -
 *      then falls back to re-POSTing /subscription (controller restarts
 *      invalidate the old registration). onRestored fires after every successful
 *      reconnect so the consumer can resync; onLost fires exactly once when the
 *      budget is exhausted. Reconnects ride the same HTTP session: IRC5 sessions
 *      are identified by the -http-session- cookie and survive TCP connection
 *      churn (live-verified 2026-08-02). ABBCX names the controller's client,
 *      not the connection: RW 6.16.03 issues a new one only when its client
 *      is gone, as after a drop, where it answers the first request under a
 *      new client and sets the new ABBCX on that answer, even an error answer
 *      (live 2026-10-22).
 *   6. Heartbeat: ws protocol ping each pingIntervalMs; the IRC5 WS answers
 *      RFC6455 pings (live-verified 2026-08-02). No text frame is ever sent:
 *      on RW 6.16.03 a text 'PING' or 'ping' closes the socket at once with
 *      1008 "Client cannot send data." (the group survives), as on RWS 2.0
 *      (live-verified 2026-09-29). An unanswered ping at the next tick
 *      terminates the half-open socket so the reconnect path runs.
 *   7. Partial binds: a create that drops a panel resource held elsewhere in
 *      the other spelling is re-created once with that spelling (see
 *      `register`). Any other resource the controller drops is listed on the
 *      handle as `unbound`, so the caller can poll it.
 *
 * Always connects through the 'ws' package: the RWS upgrade request must carry the
 * session Cookie header, and native (undici) WebSocket has no headers option - it
 * silently ignores the ws-style third constructor argument, so the handshake goes
 * out unauthenticated. Live-verified 2026-07-08 against the RobotWare 6.16 virtual controller: native WS is
 * rejected with HTTP 403, 'ws' with the same Cookie opens and delivers events.
 */

import type { HttpSession } from './HttpSession.js';
import type { AnySubscriptionResource, SubscriptionEvent } from './types.js';
import { RwsError, stripRapidDomain } from './types.js';
import { subscriptions } from './ResourceMapper.js';
import { parseSubscriptionId } from './ResponseParser.js';
import { Logger } from './Logger.js';
import { assertSignalName } from './signalName.js';
import { addedResourcePaths, distinctPaths, subscriptionFrameEntries } from './subscriptionKinds.js';

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_CAP_MS = 30000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;
const DEFAULT_PING_INTERVAL_MS = 10000;
const DEFAULT_OPEN_TIMEOUT_MS = 8000;
/** Added to the session's timeout for the group create only (see createGroup). */
const CREATE_GROUP_EXTRA_MS = 5000;

/** ws-package extras beyond the WHATWG WebSocket surface, used for the heartbeat. */
interface WsHeartbeatCapable {
  ping?: () => void;
  terminate?: () => void;
  on?: (event: string, cb: () => void) => void;
}

/** Reconnect backoff: base doubling per attempt, capped. Attempt is 0-based. */
export function backoffDelay(
  attempt: number,
  baseMs = DEFAULT_RECONNECT_BASE_MS,
  capMs = DEFAULT_RECONNECT_CAP_MS,
): number {
  return Math.min(baseMs * 2 ** attempt, capMs);
}

/** Tuning and lifecycle callbacks for a WebSocket subscription. */
export interface WsSubscribeOptions {
  /** Called at most once, when reconnect attempts are exhausted and the stream is terminally lost. */
  onLost?: () => void;
  /**
   * Called after every successful reconnect or re-registration - events may have
   * been missed during the gap, so the consumer should resync (e.g. a full poll).
   */
  onRestored?: () => void;
  /** Consecutive failed reconnect attempts before giving up (default 6 ~ 61 s of backoff). */
  maxReconnectAttempts?: number;
  /** First reconnect delay in ms; doubles per attempt (default 1000). */
  reconnectBaseMs?: number;
  /** Upper bound for the reconnect delay in ms (default 30000). */
  reconnectCapMs?: number;
  /**
   * Heartbeat cadence in ms (default 10000). A ping is sent each interval; a
   * ping that is still unanswered at the next interval marks the connection
   * half-open and force-closes it so the reconnect path runs. Detection is
   * therefore bounded by ~2× this interval.
   */
  pingIntervalMs?: number;
  /**
   * WebSocket upgrade handshake timeout in ms (default 8000, mirroring the
   * RWS 2.0 client). Without it a half-open network hangs a reconnect attempt
   * forever - the TCP connect succeeds but the 101 never arrives.
   */
  openTimeoutMs?: number;
}

/** WebSocket constructor shape used by WsSubscriber - ws-style options 3rd arg */
type WebSocketCtor = new (
  url: string,
  protocols: string[],
  options: { headers: Record<string, string>; handshakeTimeout?: number },
) => WebSocket;

/** The 'ws' constructor once loaded; later subscriptions reuse it without waiting. */
let wsPackageCtor: WebSocketCtor | undefined;

/**
 * Load the 'ws' package constructor. Never returns native globalThis.WebSocket -
 * it cannot send the Cookie header the controller requires for WS auth.
 *
 * A dynamic `import('ws')`, as the RWS 2.0 client loads it. The earlier
 * `createRequire(import.meta.url)` failed inside a CommonJS bundle (the VS Code
 * extension's esbuild bundle turns `import.meta` into `{}`, and
 * `createRequire(undefined)` throws), so there every RWS 1.0 subscription failed
 * with NETWORK_ERROR and RobotManager fell back to polling.
 *
 * A package that cannot be loaded is `UNSUPPORTED_OPERATION` since 1.5.1: no
 * subscription can open in this process, so RobotManager does not try the
 * subscribe again on the connection (a NETWORK_ERROR would be retried each
 * minute). subscribe() loads it before anything is sent.
 */
async function resolveWebSocket(): Promise<WebSocketCtor> {
  if (wsPackageCtor) { return wsPackageCtor; }
  const notLoaded = (): RwsError => new RwsError(
    'The "ws" package is required for RWS 1.0 subscriptions but could not be loaded.',
    'UNSUPPORTED_OPERATION',
  );
  let mod: { default?: unknown; WebSocket?: unknown };
  try {
    mod = await import('ws') as unknown as { default?: unknown; WebSocket?: unknown };
  } catch {
    throw notLoaded();
  }
  const ctor = typeof mod.default === 'function' ? mod.default : mod.WebSocket;
  if (typeof ctor !== 'function') { throw notLoaded(); }
  wsPackageCtor = ctor as WebSocketCtor;
  return wsPackageCtor;
}

// ─── Path builder for subscription resources ─────────────────────────────────

/** Ensure a symbol path carries the leading `RAPID/` domain that RWS 1.0 requires. */
function withRapidDomain(name: string): string {
  return `RAPID/${stripRapidDomain(name)}`;
}

/**
 * Map a subscription resource to its RWS 1.0 event paths (with ;state suffix where needed):
 * one path, except mastership of every domain, which is one per domain (see addedResourcePaths).
 * Paths are NOT percent-encoded - semicolons must be literal in the subscription body.
 */
export function resourcePaths(resource: AnySubscriptionResource): string[] {
  if (resource === 'execution')     return ['/rw/rapid/execution;ctrlexecstate'];
  if (resource === 'controllerstate') return ['/rw/panel/ctrlstate;ctrlstate'];
  if (resource === 'operationmode') return ['/rw/panel/opmode;opmode'];
  if (resource === 'speedratio')    return ['/rw/panel/speedratio;speedratio'];
  if (resource === 'coldetstate')   return ['/rw/panel/coldetstate;coldetstate'];
  if (resource === 'uiinstr')       return ['/rw/rapid/uiinstr;uievent'];
  if (resource.type === 'signal') {
    // Convention: name can be 'network/device/signalname' (3 parts) for a physical signal,
    // or just 'signalname' for virtual/flat signals. Checked first, as on RWS 2.0:
    // it goes into the body unencoded, where a '&' or '=' would add form fields.
    assertSignalName(resource.name);
    return [`/rw/iosystem/signals/${resource.name};state`];
  }
  if (resource.type === 'persvar') {
    // RAPID persistent variable subscription path (full path: RAPID/task/module/symbol).
    // RWS 1.0 needs the leading RAPID/ domain; without it the controller answers
    // 400 "Resource does not exist on the controller" (live-verified 2026-08 on
    // RW6.16). Callers may pass it either way - RWS 2.0 takes the bare form, so
    // normalize here and the same resource object works on both protocols.
    return [`/rw/rapid/symbol/data/${withRapidDomain(resource.name)};value`];
  }
  if (resource.type === 'taskchange') {
    return [`/rw/rapid/tasks/${encodeURIComponent(resource.task)};taskchange`];
  }
  if (resource.type === 'execycle') {
    return ['/rw/rapid/execution;rapidexeccycle'];
  }
  if (resource.type === 'elog') {
    return [`/rw/elog/${resource.domain}`];
  }
  if (resource.type === 'mastership' || resource.type === 'motionerrorstate') {
    // Rev M: /rw/mastership/{domain}, one per domain for every domain, and the
    // motion system's errorstate;erroreventchange (see addedResourcePaths).
    return addedResourcePaths(resource, 'rws1') as string[];
  }
  // TypeScript exhaustiveness check
  const _: never = resource;
  void _;
  throw new RwsError('Unknown subscription resource type', 'UNKNOWN');
}

/**
 * Build the application/x-www-form-urlencoded body for POST /subscription.
 * Paths are NOT percent-encoded; the semicolons are literal as expected by RWS.
 *
 * `resources=<i>` is repeated once PER resource - it names a resource index, it
 * is not a count. A single `resources=N` makes the controller bind only
 * resource N and silently drop the rest, while still answering 201. A path
 * two resources map to is sent once.
 */
export function buildSubscriptionBody(resources: AnySubscriptionResource[]): string {
  return distinctPaths(resources.flatMap(resourcePaths)).map((path, index) => {
    const i = index + 1;
    // Do NOT encodeURIComponent the path - RWS expects literal semicolons
    return `resources=${i}&${i}=${path}&${i}-p=1`;
  }).join('&');
}

// ─── Partial binds (RWS 1.0 panel spellings) ─────────────────────────────────

/**
 * The panel resources the controller accepts in two spellings, bare
 * (`/rw/panel/opmode`) and suffixed (`/rw/panel/opmode;opmode`).
 */
const PANEL_TWO_SPELLINGS = new Set(['ctrlstate', 'opmode', 'speedratio', 'coldetstate']);

/**
 * The resource URIs a create-subscription answer names as refused: one
 * `<div class="status">` block per refused resource, whose self link is the
 * URI as sent. On RW 6.16.03 a multi-resource create still answers 201 when
 * one resource is refused; only that resource is dropped, and it is named
 * only in such a block (code -1073445866, "Invalid resource URI in Create
 * Subscription request"). Live-verified 2026-09-29.
 */
export function refusedSubscriptionResources(responseBody: string): string[] {
  const out: string[] = [];
  for (const [, block] of responseBody.matchAll(/<div class="status">([\s\S]*?)<\/div>/g)) {
    const href = block.match(/<a[^>]*href="([^"]+)"[^>]*rel="self"/)?.[1];
    if (href) { out.push(href.replace(/&amp;/g, '&')); }
  }
  return out;
}

/** The other spelling of a two-spelling panel resource, or null for any other URI. */
export function otherPanelSpelling(uri: string): string | null {
  const m = /^\/rw\/panel\/([a-z]+)(?:;([a-z]+))?$/.exec(uri);
  if (!m || !PANEL_TWO_SPELLINGS.has(m[1])) { return null; }
  if (m[2] === undefined) { return `/rw/panel/${m[1]};${m[1]}`; }
  return m[2] === m[1] ? `/rw/panel/${m[1]}` : null;
}

/** The subscription body with each `N=<from>` resource entry swapped to `N=<to>`. */
function swapSubscriptionResources(body: string, swaps: Array<[string, string]>): string {
  let out = body;
  for (const [from, to] of swaps) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|&)(\\d+)=${esc}(?=&|$)`), (_all, lead: string, n: string) => `${lead}${n}=${to}`);
  }
  return out;
}

// ─── XML event parsing ────────────────────────────────────────────────────────

/**
 * Parse an incoming RWS WebSocket XML event message.
 * Expected structure (simplified):
 *   <html><body><div class="bind-data"><ul>
 *     <li class="..."><a href="/rw/rapid/execution;state">...</a>
 *       <span class="excstate">running</span>
 *     </li>
 *   </ul></div></body></html>
 * One event per entry: its link (or, for ABB's linkless mastership entry,
 * `/rw/mastership/{title}`; see subscriptionFrameEntries) and its first
 * field's value, '' when it has none.
 */
export function parseWsMessage(data: string): SubscriptionEvent[] {
  return subscriptionFrameEntries(data).map(e => ({ resource: e.resource, value: e.value ?? '', timestamp: new Date() }));
}

// ─── WsSubscriber ─────────────────────────────────────────────────────────────

interface ActiveSubscription {
  id: string;
  body: string;       // registration body, kept for re-POST after a controller restart
  unbound: readonly string[]; // what the group held now left out (register), read by the handle
  wsUrl: string;
  deleteUrl: string;  // HTTP URL used to DELETE the subscription on close
  ws: WebSocket | null;
  handler: (event: SubscriptionEvent) => void;
  opts: WsSubscribeOptions;
  retryCount: number;
  closed: boolean;
  lostNotified: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
}

export class WsSubscriber {
  private readonly session: HttpSession;
  private readonly host: string;
  private readonly port: number;
  private readonly wsCtor: WebSocketCtor | undefined;
  private subscriptions: Map<string, ActiveSubscription> = new Map();

  constructor(session: HttpSession, host: string, port: number, wsCtor?: WebSocketCtor) {
    this.session = session;
    this.host = host;
    this.port = port;
    this.wsCtor = wsCtor;
  }

  /**
   * Subscribe to one or more RWS resources. Returns an unsubscribe function.
   *
   * Resolves only once the event WebSocket is open. If the socket fails before
   * opening (refused connection, failed upgrade), rejects with RwsError after
   * best-effort deleting the subscription registered by the POST - otherwise the
   * caller believes it has live events while the controller streams to nobody.
   *
   * The returned function carries `unbound`: the resources the controller
   * left out of the group it holds now (see `register`), read live, since a
   * re-registration after a controller restart is judged on its own answer.
   * No event comes for them; RobotManager polls the ones it reads.
   *
   * @param resources - Array of resources to subscribe to
   * @param handler   - Called for each incoming event
   * @returns         - Async function that cancels the subscription and closes the WebSocket
   */
  async subscribe(
    resources: AnySubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    opts: WsSubscribeOptions = {},
  ): Promise<(() => Promise<void>) & { readonly unbound: readonly string[] }> {
    // The WebSocket constructor first: without the 'ws' package no socket can
    // open, and nothing is sent (no group created and deleted again).
    if (!this.wsCtor) { await resolveWebSocket(); }
    // Step 1: POST /subscription to register resources (with the one-time
    // re-create in the other spelling when a panel resource was dropped)
    const { location: locationHeader, body, unbound } = await this.register(buildSubscriptionBody(resources), 'POST');

    const { id: subscriptionId, wsUrl, deleteUrl } = this.parseLocation(locationHeader);

    const sub: ActiveSubscription = {
      id: subscriptionId,
      body,
      unbound,
      wsUrl,
      deleteUrl,
      ws: null,
      handler,
      opts,
      retryCount: 0,
      closed: false,
      lostNotified: false,
      reconnectTimer: null,
      pingTimer: null,
    };

    this.subscriptions.set(subscriptionId, sub);

    // Step 3: open the WebSocket and wait for it - a subscription without a live
    // event stream is worse than no subscription (silent staleness).
    try {
      await this.openWebSocket(sub);
    } catch (err) {
      sub.closed = true;
      sub.ws = null;
      this.subscriptions.delete(subscriptionId);
      // Free the controller-side slot registered by the POST - best-effort
      await this.session.delete(sub.deleteUrl).catch(() => undefined);
      throw this.explainSecondSocket(err, sub);
    }

    // Return unsubscribe function
    const stop = async (): Promise<void> => {
      sub.closed = true;
      if (sub.reconnectTimer) {
        clearTimeout(sub.reconnectTimer);
        sub.reconnectTimer = null;
      }
      this.stopHeartbeat(sub);
      if (sub.ws) {
        sub.ws.close();
        sub.ws = null;
      }
      // Key by the sub's CURRENT id - a re-registration may have re-keyed it
      this.subscriptions.delete(sub.id);
      // Best-effort DELETE - ignore errors (controller may have already cleaned up)
      await this.session.delete(sub.deleteUrl).catch(() => undefined);
    };
    return Object.defineProperty(stop, 'unbound', { get: () => sub.unbound, enumerable: true }) as
      typeof stop & { readonly unbound: readonly string[] };
  }

  /**
   * A WebSocket that failed before opening while this session has another
   * subscription's WebSocket open. ABB's RWS 1.0 allows one WebSocket per
   * session (more are refused, Rev M), and RW 6.16.03 failed a second one
   * before it opened, beside RobotManager's own (2026-10-21). The error says
   * so and names the open group; its code is kept. Any other failure is
   * returned as it is.
   */
  private explainSecondSocket(err: unknown, sub: ActiveSubscription): unknown {
    const open = [...this.subscriptions.values()].find(s => s !== sub && !s.closed && s.ws !== null);
    if (!open || !(err instanceof RwsError)) { return err; }
    return new RwsError(
      `${err.message}. This session already has the WebSocket of subscription ${open.id} open, and ABB's RWS 1.0 allows one `
        + `WebSocket per session: add the resources to that group (updateSubscriptionGroup on /subscription/${open.id}), `
        + 'or subscribe from a session of its own.',
      err.code, err.httpStatus, err.rwsDetail, err.controllerCode, err.controllerMsg, err.refusal, err.responseBody,
    );
  }

  /** Close all active subscriptions */
  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const sub of this.subscriptions.values()) {
      sub.closed = true;
      if (sub.reconnectTimer) {
        clearTimeout(sub.reconnectTimer);
        sub.reconnectTimer = null;
      }
      this.stopHeartbeat(sub);
      if (sub.ws) {
        sub.ws.close();
        sub.ws = null;
      }
      promises.push(
        this.session.delete(sub.deleteUrl).then(() => undefined).catch(() => undefined),
      );
    }
    this.subscriptions.clear();
    await Promise.allSettled(promises);
  }

  /**
   * Derive subscription id, WebSocket URL, and HTTP delete path from a POST
   * /subscription Location header. IRC5 may return ws://host/poll/{id},
   * http://host/subscription/{id}, or a bare path - all are normalized:
   *
   * - wsUrl keeps the advertised PATH but is re-anchored on the host:port this
   *   subscriber was configured with, so subscriptions keep working when the
   *   controller is reached through NAT/port-forwarding (and lets tests
   *   interpose a proxy). Live-verified 2026-08-02 on RW6.16 VC
   *   (a probe script): Location is an absolute ws://host:port/poll/{id}
   *   carrying the controller's own authority.
   * - deleteUrl is always `/subscription/{id}` as a PATH. Two reasons, both
   *   live-verified 2026-08-02 on RW6.16 VC: DELETE on the poll URL → 404
   *   (like RWS 2.0, the poll resource is not deletable; /subscription/{id}
   *   → 200), and HttpSession prepends its base URL, so an absolute delete
   *   URL would concatenate into garbage and the best-effort DELETE would
   *   silently fail, leaking the controller-side registration.
   */
  private parseLocation(locationHeader: string): { id: string; wsUrl: string; deleteUrl: string } {
    const id = parseSubscriptionId(locationHeader);
    let path = locationHeader;
    if (/^(https?|wss?):\/\//.test(locationHeader)) {
      try {
        const u = new URL(locationHeader);
        path = `${u.pathname}${u.search}`;
      } catch {
        // Keep the raw header; worst case matches the old behavior
      }
    }
    return {
      id,
      wsUrl: `ws://${this.host}:${this.port}${path}`,
      deleteUrl: `/subscription/${id}`,
    };
  }

  /**
   * Register a fresh controller-side subscription for an existing sub whose
   * stored poll URL is dead (controller restarted). Rides the same HttpSession
   * (cookie reuse - no new session slot); the old registration is dropped
   * best-effort first so slots don't leak when the controller is reachable.
   */
  private async reRegister(sub: ActiveSubscription): Promise<void> {
    await this.session.delete(sub.deleteUrl).catch(() => undefined);
    // The old group is let go: until the new one is created nothing is
    // held, so `unbound` names nothing (not the last group's).
    sub.unbound = [];
    const { location: locationHeader, body, unbound } = await this.register(sub.body, 're-POST');
    const { id, wsUrl, deleteUrl } = this.parseLocation(locationHeader);
    this.subscriptions.delete(sub.id);
    sub.id = id;
    sub.body = body;
    sub.unbound = unbound;
    sub.wsUrl = wsUrl;
    sub.deleteUrl = deleteUrl;
    this.subscriptions.set(id, sub);
    Logger.trace?.('subscription', `re-registered as subscription ${id}`);
  }

  /**
   * One POST /subscription: a 201 with a Location, or an RwsError.
   *
   * This one request gets CREATE_GROUP_EXTRA_MS on top of the session's
   * timeout (5 s by default, so 10 s; HttpSession's `holdMs`). On RW 6.16.03
   * the create is by far the slowest request a connection sends: 0.8 s at
   * the median and at most 1.1 s over 90 creates in four functional runs
   * (2026-10-22 to 2026-10-25), where the median of the other 10856 requests
   * was 18 ms. In a connect of three controllers at once (2026-10-25) no
   * answer to RobotManager's create came within the 5 s timeout, three times
   * out of three, while the connect's other requests were answered. A create
   * the client gives up on may still leave a group on the controller: on RW
   * 7.21.4 (RWS 2.0) an unanswered create left a listed group for 25-35 s
   * that could not be deleted meanwhile (2026-09-29). Whether an RWS 1.0
   * create the controller completes after the client gave up leaves a
   * group, and for how long, was not probed; ABB's RWS 1.0 allows two groups
   * per client. The RWS 2.0 subscribe POST waits 10 s for its answer by
   * default too.
   *
   * The cost: requests go one at a time per session, so a create that is
   * never answered holds the requests behind it (the poll, a write) for up to
   * 10 s, each time it is sent (a 401 or a 503 sends it once more). RobotManager
   * subscribes again while it has no event stream, so this can recur on a
   * connection: after three unanswered creates in a row it waits 10 minutes
   * between tries. Since 1.5.3 Stop RAPID, motors off, deleting a group and
   * the disconnect's /logout do not wait: they cut the create short, and it
   * fails with "Request cut short". A release cuts it only before it is sent
   * (HttpSession.enqueue).
   */
  private async createGroup(body: string, what: string): Promise<{ location: string; responseBody: string }> {
    const response = await this.session.post(subscriptions(), body, CREATE_GROUP_EXTRA_MS);
    if (response.status !== 201) {
      throw new RwsError(
        `Subscription ${what} returned ${response.status}, expected 201`,
        'UNKNOWN',
        response.status,
      );
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new RwsError(`Subscription ${what} missing Location header`, 'UNKNOWN');
    }
    return { location, responseBody: response.body ?? '' };
  }

  /**
   * Register a group and check that every panel resource was bound. Returns
   * the Location and the body that bound (kept for later re-registrations).
   *
   * RW 6.16.03 accepts /rw/panel/{ctrlstate,opmode,speedratio,coldetstate}
   * bare or `;suffix`, but while any live group (another client's, or this
   * session's own) holds one of them in one spelling, a create naming it in
   * the other spelling drops it: a multi-resource create still answers 201,
   * and the dropped resource is named only in a status block of the 201 body.
   * The same spelling co-exists, so the group is deleted and created once
   * more with the refused resource in the other spelling; that binds all of
   * them (live-verified 2026-09-29). If a panel resource is still refused,
   * the group is deleted and this throws, so the caller falls back to polling
   * rather than trusting a group that never sends that resource's events.
   * That drops the whole group, the event log and execution state included,
   * not only the refused resource: RobotManager then polls everything at the
   * fast rate. Another refused resource (not a panel one) is logged and the
   * group is kept without it; it is returned as `unbound` (the URI as sent),
   * from the answer of the group that is kept, and the subscribe handle
   * lists it, so RobotManager polls what no event will bring. RW 6.16.03 left
   * `/rw/elog/0` out of the manager's group this way for a whole run, every
   * create answering 201 (2026-10-22); before 1.5.0 only the
   * log line said so, and the event log went stale with the quality still
   * `live`.
   */
  private async register(body: string, what: string): Promise<{ location: string; body: string; unbound: readonly string[] }> {
    const first = await this.createGroup(body, what);
    const refused = refusedSubscriptionResources(first.responseBody);
    if (refused.length === 0) { return { location: first.location, body, unbound: [] }; }

    const swaps: Array<[string, string]> = [];
    const others: string[] = [];
    for (const uri of refused) {
      const other = otherPanelSpelling(uri);
      if (other) { swaps.push([uri, other]); } else {
        others.push(uri);
        Logger.warn(`RWS 1.0 subscription: the controller did not bind ${uri}`);
      }
    }
    if (swaps.length === 0) { return { location: first.location, body, unbound: Object.freeze(others) }; }

    Logger.info(`RWS 1.0 subscription: ${swaps.map(s => s[0]).join(', ')} held in the other spelling elsewhere - re-creating with ${swaps.map(s => s[1]).join(', ')}`);
    await this.session.delete(this.parseLocation(first.location).deleteUrl).catch(() => undefined);
    const retryBody = swapSubscriptionResources(body, swaps);
    const second = await this.createGroup(retryBody, what);
    const secondRefused = refusedSubscriptionResources(second.responseBody);
    const unbound = secondRefused.filter(u => otherPanelSpelling(u) !== null);
    if (unbound.length > 0) {
      await this.session.delete(this.parseLocation(second.location).deleteUrl).catch(() => undefined);
      throw new RwsError(
        `Subscription ${what}: the controller did not bind ${unbound.join(', ')} in either spelling`,
        'UNKNOWN',
      );
    }
    // The first group was deleted: only the second answer says what the kept group left out.
    const othersKept = secondRefused.filter(u => otherPanelSpelling(u) === null);
    for (const uri of othersKept.filter(u => !others.includes(u))) {
      Logger.warn(`RWS 1.0 subscription: the controller did not bind ${uri}`);
    }
    return { location: second.location, body: retryBody, unbound: Object.freeze(othersKept) };
  }

  // ─── WebSocket lifecycle ────────────────────────────────────────────────────

  /**
   * Open the event WebSocket for a subscription. Resolves once the socket is
   * open; rejects if it errors or closes before ever opening (refused connection,
   * rejected upgrade). Reconnect handling for established streams lives in the
   * close handler, so callers of reconnect attempts must catch rejections.
   */
  private async openWebSocket(sub: ActiveSubscription): Promise<void> {
    const WS = this.wsCtor ?? await resolveWebSocket();
    // Only the first load of 'ws' waits; a subscription closed meanwhile opens nothing.
    if (sub.closed) {
      throw new RwsError(`Subscription ${sub.id} was closed before its WebSocket opened`, 'NETWORK_ERROR');
    }
    return new Promise<void>((resolve, reject) => {
      const cookieHeader = this.session.getCookieHeader();
      const ws = new WS(sub.wsUrl, ['robapi2_subscription'], {
        headers: { Cookie: cookieHeader },
        handshakeTimeout: sub.opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
      });

      sub.ws = ws;
      let opened = false;

      const failBeforeOpen = (): void => {
        reject(new RwsError(
          `WebSocket for subscription ${sub.id} failed before opening`,
          'NETWORK_ERROR',
        ));
      };

      ws.onopen = (): void => {
        opened = true;
        const wasReconnect = sub.retryCount > 0;
        sub.retryCount = 0;
        this.startHeartbeat(sub, ws);
        resolve();
        if (wasReconnect) {
          Logger.info(`RWS 1.0 subscription ${sub.id} restored`);
          try { sub.opts.onRestored?.(); } catch { /* consumer callback - never let it break us */ }
        }
      };

      ws.onmessage = (event: MessageEvent): void => {
        try {
          const data = typeof event.data === 'string' ? event.data : String(event.data);
          const events = parseWsMessage(data);
          for (const e of events) {
            sub.handler(e);
          }
        } catch {
          // Silently discard unparseable messages - don't crash the subscriber
        }
      };

      ws.onerror = (): void => {
        // Post-open errors are followed by onclose; reconnect logic lives there
        if (!opened) failBeforeOpen();
      };

      ws.onclose = (event: Event & { wasClean?: boolean }): void => {
        this.stopHeartbeat(sub);
        if (!opened) {
          // Never established - reject and let the caller decide (subscribe
          // deletes the registration; reconnect attempts consume a retry)
          failBeforeOpen();
          return;
        }
        if (sub.closed) return; // intentional close - do not reconnect

        // Every close this client did not ask for is a lost stream, a clean
        // one too. In the ws package a close is clean once both close frames
        // went, and ws answers the controller's close frame itself, so a
        // close the controller starts (RW 6.16.03 sends close frames, as the
        // 1008 in the header says) reads as clean. Until 1.5.1 such a close
        // neither reconnected nor fired onLost: the stream stopped and the
        // consumer was not told. The RWS 2.0 subscriber reconnects on any
        // close.
        Logger.trace?.('subscription', `RWS 1.0 subscription ${sub.id}: the WebSocket closed (${event?.wasClean ? 'clean' : 'not clean'})`);
        this.scheduleReconnect(sub);
      };
    });
  }

  /**
   * Ping the socket every pingIntervalMs using ws-package protocol frames; a
   * ping still unanswered at the next tick means the connection is half-open
   * (frozen NAT, yanked cable) - terminate it so the close event fires and the
   * reconnect path runs. Mirrors the RWS 2.0 pingTimer; no-op when the injected
   * transport lacks ping/terminate (plain WHATWG sockets can't do heartbeats).
   */
  private startHeartbeat(sub: ActiveSubscription, ws: WebSocket): void {
    const wsx = ws as unknown as WsHeartbeatCapable;
    if (!wsx.ping || !wsx.terminate || !wsx.on) return;
    this.stopHeartbeat(sub);
    let awaitingPong = false;
    wsx.on('pong', () => { awaitingPong = false; });
    const interval = sub.opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    sub.pingTimer = setInterval(() => {
      if (sub.closed || sub.ws !== ws) {
        this.stopHeartbeat(sub);
        return;
      }
      if (awaitingPong) {
        Logger.warn(`RWS 1.0 subscription ${sub.id} heartbeat missed - terminating half-open socket`);
        this.stopHeartbeat(sub);
        wsx.terminate!();
        return;
      }
      awaitingPong = true;
      wsx.ping!();
    }, interval);
  }

  private stopHeartbeat(sub: ActiveSubscription): void {
    if (sub.pingTimer) {
      clearInterval(sub.pingTimer);
      sub.pingTimer = null;
    }
  }

  /**
   * Reconnect a lost (previously open) stream with capped exponential backoff.
   * When the attempt budget is exhausted the stream is terminally lost: onLost
   * fires exactly once and the registration is freed best-effort.
   */
  private scheduleReconnect(sub: ActiveSubscription): void {
    if (sub.closed) return;
    const maxAttempts = sub.opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (sub.retryCount >= maxAttempts) {
      this.giveUp(sub);
      return;
    }
    const delay = backoffDelay(sub.retryCount, sub.opts.reconnectBaseMs, sub.opts.reconnectCapMs);
    sub.retryCount++;
    Logger.trace?.('subscription', `WS dropped - reconnect attempt ${sub.retryCount} in ${delay} ms`);
    sub.reconnectTimer = setTimeout(() => {
      sub.reconnectTimer = null;
      if (sub.closed) return;
      // Try the stored poll URL first (survives plain network drops). If that
      // fails the registration may be gone (controller restart) - re-register
      // fresh and open the new URL. Either failure consumes this attempt.
      this.openWebSocket(sub).catch(async () => {
        if (sub.closed) return;
        try {
          await this.reRegister(sub);
          await this.openWebSocket(sub);
        } catch {
          this.scheduleReconnect(sub);
        }
      });
    }, delay);
  }

  /** Terminal give-up: notify the consumer once and free the controller-side slot. */
  private giveUp(sub: ActiveSubscription): void {
    Logger.warn(`RWS 1.0 subscription ${sub.id} lost - giving up after ${sub.retryCount} reconnect attempts`);
    this.stopHeartbeat(sub);
    this.subscriptions.delete(sub.id);
    sub.ws = null;
    sub.unbound = []; // no group is held any more
    // Best-effort: if the controller is reachable again later this frees the slot;
    // if it is down the DELETE just fails silently.
    void this.session.delete(sub.deleteUrl).catch(() => undefined);
    if (!sub.lostNotified) {
      sub.lostNotified = true;
      try { sub.opts.onLost?.(); } catch { /* consumer callback - never let it break us */ }
    }
  }
}
