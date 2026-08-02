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
 *   5. Auto-reconnect when an established stream drops: capped exponential backoff
 *      (1 s doubling to 30 s, 6 attempts ~ 61 s by default, all tunable via
 *      WsSubscribeOptions). Each attempt first retries the stored poll URL -
 *      unlike RWS 2.0, IRC5 poll URLs are REUSABLE after a drop (live-verified
 *      2026-08-02 on RW6.16 VC: reopen of the same /poll/{id} upgrades fine) -
 *      then falls back to re-POSTing /subscription (controller restarts
 *      invalidate the old registration). onRestored fires after every successful
 *      reconnect so the consumer can resync; onLost fires exactly once when the
 *      budget is exhausted. Reconnects ride the same HTTP session: IRC5 sessions
 *      are identified by the -http-session- cookie and survive TCP connection
 *      churn (ABBCX is re-issued per connection; live-verified 2026-08-02).
 *   6. Heartbeat: ws protocol ping each pingIntervalMs; the IRC5 WS answers
 *      RFC6455 pings (live-verified 2026-08-02; app-level 'PING' text gets no
 *      reply, that is RWS 2.0 only). An unanswered ping at the next tick
 *      terminates the half-open socket so the reconnect path runs.
 *
 * Always connects through the 'ws' package: the RWS upgrade request must carry the
 * session Cookie header, and native (undici) WebSocket has no headers option - it
 * silently ignores the ws-style third constructor argument, so the handshake goes
 * out unauthenticated. Live-verified 2026-07-08 against IRC5 RW6.16: native WS is
 * rejected with HTTP 403, 'ws' with the same Cookie opens and delivers events.
 */

import { createRequire } from 'module';
import type { HttpSession } from './HttpSession.js';
import type { SubscriptionResource, SubscriptionEvent } from './types.js';
import { RwsError } from './types.js';
import { subscriptions } from './ResourceMapper.js';
import { parseSubscriptionId } from './ResponseParser.js';
import { Logger } from './Logger.js';

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_CAP_MS = 30000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;
const DEFAULT_PING_INTERVAL_MS = 10000;
const DEFAULT_OPEN_TIMEOUT_MS = 8000;

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

/**
 * Resolve the 'ws' package constructor. Never returns native globalThis.WebSocket -
 * it cannot send the Cookie header the controller requires for WS auth.
 */
function resolveWebSocket(): WebSocketCtor {
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return require('ws') as any;
  } catch {
    throw new RwsError(
      'The "ws" package is required for RWS 1.0 subscriptions but could not be loaded.',
      'NETWORK_ERROR',
    );
  }
}

// ─── Path builder for subscription resources ─────────────────────────────────

/**
 * Map a SubscriptionResource to its RWS 1.0 event path (with ;state suffix where needed).
 * Paths are NOT percent-encoded - semicolons must be literal in the subscription body.
 */
function resourceToPath(resource: SubscriptionResource): string {
  if (resource === 'execution')     return '/rw/rapid/execution;ctrlexecstate';
  if (resource === 'controllerstate') return '/rw/panel/ctrlstate;ctrlstate';
  if (resource === 'operationmode') return '/rw/panel/opmode;opmode';
  if (resource === 'speedratio')    return '/rw/panel/speedratio;speedratio';
  if (resource === 'coldetstate')   return '/rw/panel/coldetstate;coldetstate';
  if (resource === 'uiinstr')       return '/rw/rapid/uiinstr;uievent';
  if (resource.type === 'signal') {
    // Convention: name can be 'network/device/signalname' (3 parts) for a physical signal,
    // or just 'signalname' for virtual/flat signals.
    return `/rw/iosystem/signals/${resource.name};state`;
  }
  if (resource.type === 'persvar') {
    // RAPID persistent variable subscription path (full path: RAPID/task/module/symbol)
    return `/rw/rapid/symbol/data/${resource.name};value`;
  }
  if (resource.type === 'taskchange') {
    return `/rw/rapid/tasks/${encodeURIComponent(resource.task)};taskchange`;
  }
  if (resource.type === 'execycle') {
    return '/rw/rapid/execution;rapidexeccycle';
  }
  if (resource.type === 'elog') {
    return `/rw/elog/${resource.domain}`;
  }
  // TypeScript exhaustiveness check
  const _: never = resource;
  void _;
  throw new RwsError('Unknown subscription resource type', 'UNKNOWN');
}

/**
 * Build the application/x-www-form-urlencoded body for POST /subscription.
 * Paths are NOT percent-encoded; the semicolons are literal as expected by RWS.
 */
function buildSubscriptionBody(resources: SubscriptionResource[]): string {
  const parts: string[] = [`resources=${resources.length}`];
  resources.forEach((resource, index) => {
    const i = index + 1;
    const path = resourceToPath(resource);
    // Do NOT encodeURIComponent the path - RWS expects literal semicolons
    parts.push(`${i}=${path}&${i}-p=1`);
  });
  return parts.join('&');
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
 */
function parseWsMessage(data: string): SubscriptionEvent[] {
  const events: SubscriptionEvent[] = [];

  // Extract all <li> blocks in the message
  const liPattern = /<li[^>]*>(.*?)<\/li>/gis;
  let liMatch: RegExpExecArray | null;

  while ((liMatch = liPattern.exec(data)) !== null) {
    const block = liMatch[1];

    // Extract resource URL from the <a href="..."> anchor
    const hrefMatch = block.match(/<a[^>]*href="([^"]+)"/i);
    if (!hrefMatch) continue;
    const resource = hrefMatch[1];

    // Extract value from the first <span> in this block
    const spanMatch = block.match(/<span[^>]*>(.*?)<\/span>/is);
    const value = spanMatch ? spanMatch[1].trim() : '';

    events.push({ resource, value, timestamp: new Date() });
  }

  return events;
}

// ─── WsSubscriber ─────────────────────────────────────────────────────────────

interface ActiveSubscription {
  id: string;
  body: string;       // registration body, kept for re-POST after a controller restart
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
   * @param resources - Array of resources to subscribe to
   * @param handler   - Called for each incoming event
   * @returns         - Async function that cancels the subscription and closes the WebSocket
   */
  async subscribe(
    resources: SubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    opts: WsSubscribeOptions = {},
  ): Promise<() => Promise<void>> {
    // Step 1: POST /subscription to register resources
    const body = buildSubscriptionBody(resources);
    const response = await this.session.post(subscriptions(), body);

    if (response.status !== 201) {
      throw new RwsError(
        `Subscription POST returned ${response.status}, expected 201`,
        'UNKNOWN',
        response.status,
      );
    }

    const locationHeader = response.headers.get('location');
    if (!locationHeader) {
      throw new RwsError('Subscription POST missing Location header', 'UNKNOWN');
    }

    const { id: subscriptionId, wsUrl, deleteUrl } = this.parseLocation(locationHeader);

    const sub: ActiveSubscription = {
      id: subscriptionId,
      body,
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
      throw err;
    }

    // Return unsubscribe function
    return async () => {
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
   *   (probe-sub-delete.mjs): Location is an absolute ws://host:port/poll/{id}
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
    const response = await this.session.post(subscriptions(), sub.body);
    if (response.status !== 201) {
      throw new RwsError(
        `Subscription re-POST returned ${response.status}, expected 201`,
        'UNKNOWN',
        response.status,
      );
    }
    const locationHeader = response.headers.get('location');
    if (!locationHeader) {
      throw new RwsError('Subscription re-POST missing Location header', 'UNKNOWN');
    }
    const { id, wsUrl, deleteUrl } = this.parseLocation(locationHeader);
    this.subscriptions.delete(sub.id);
    sub.id = id;
    sub.wsUrl = wsUrl;
    sub.deleteUrl = deleteUrl;
    this.subscriptions.set(id, sub);
    Logger.trace?.('subscription', `re-registered as subscription ${id}`);
  }

  // ─── WebSocket lifecycle ────────────────────────────────────────────────────

  /**
   * Open the event WebSocket for a subscription. Resolves once the socket is
   * open; rejects if it errors or closes before ever opening (refused connection,
   * rejected upgrade). Reconnect handling for established streams lives in the
   * close handler, so callers of reconnect attempts must catch rejections.
   */
  private openWebSocket(sub: ActiveSubscription): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cookieHeader = this.session.getCookieHeader();
      const WS = this.wsCtor ?? resolveWebSocket();
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

        if (!event.wasClean) {
          this.scheduleReconnect(sub);
        }
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
    // Best-effort: if the controller is reachable again later this frees the slot;
    // if it is down the DELETE just fails silently.
    void this.session.delete(sub.deleteUrl).catch(() => undefined);
    if (!sub.lostNotified) {
      sub.lostNotified = true;
      try { sub.opts.onLost?.(); } catch { /* consumer callback - never let it break us */ }
    }
  }
}
