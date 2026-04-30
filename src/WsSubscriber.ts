/**
 * WsSubscriber — WebSocket subscription manager for ABB IRC5 RWS events.
 *
 * Flow:
 *   1. POST /subscription via HttpSession to register resources → get subscription ID
 *   2. Open WebSocket to ws://{host}/subscription/{id} with robapi2_subscription subprotocol
 *   3. Parse incoming XML event messages → emit typed SubscriptionEvent objects
 *   4. Auto-reconnect on unexpected close: max 3 retries, exponential backoff 1s/2s/4s
 *
 * Uses native globalThis.WebSocket when available (Node 22+, browsers).
 * Falls back to the 'ws' npm package for Node 18/21 where native WebSocket is experimental.
 */

import { RwsError } from './types.js';
import { createRequire } from 'module';

/**
 * Resolve a WebSocket constructor: prefer native globalThis.WebSocket,
 * fall back to the 'ws' package if available.
 */
function resolveWebSocket(): typeof WebSocket {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return require('ws') as any;
  } catch {
    throw new RwsError(
      'WebSocket is not available. Install the "ws" package or use Node 22+.',
      'NETWORK_ERROR',
    );
  }
}
import type { HttpSession } from './HttpSession.js';
import type { SubscriptionResource, SubscriptionEvent } from './types.js';
import { subscriptions } from './ResourceMapper.js';
import { parseSubscriptionId } from './ResponseParser.js';

const BACKOFF_MS = [1000, 2000, 4000] as const;
const MAX_RETRIES = 3;

// ─── Path builder for subscription resources ─────────────────────────────────

/**
 * Map a SubscriptionResource to its RWS 1.0 event path (with ;state suffix where needed).
 * Paths are NOT percent-encoded — semicolons must be literal in the subscription body.
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
    // Do NOT encodeURIComponent the path — RWS expects literal semicolons
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
  wsUrl: string;
  deleteUrl: string;  // HTTP URL used to DELETE the subscription on close
  ws: WebSocket | null;
  handler: (event: SubscriptionEvent) => void;
  retryCount: number;
  closed: boolean;
}

export class WsSubscriber {
  private readonly session: HttpSession;
  private readonly host: string;
  private readonly port: number;
  private subscriptions: Map<string, ActiveSubscription> = new Map();

  constructor(session: HttpSession, host: string, port: number) {
    this.session = session;
    this.host = host;
    this.port = port;
  }

  /**
   * Subscribe to one or more RWS resources. Returns an unsubscribe function.
   *
   * @param resources - Array of resources to subscribe to
   * @param handler   - Called for each incoming event
   * @returns         - Async function that cancels the subscription and closes the WebSocket
   */
  async subscribe(
    resources: SubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
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

    const subscriptionId = parseSubscriptionId(locationHeader);

    // Step 2: Derive WebSocket URL and HTTP delete URL from Location header.
    // IRC5 may return ws://host/poll/{id} or http://host/subscription/{id} or a path.
    let wsUrl: string;
    let deleteUrl: string;
    if (locationHeader.startsWith('ws://') || locationHeader.startsWith('wss://')) {
      wsUrl = locationHeader;
      deleteUrl = locationHeader.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    } else if (locationHeader.startsWith('http://') || locationHeader.startsWith('https://')) {
      wsUrl = locationHeader.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
      deleteUrl = locationHeader;
    } else {
      wsUrl = `ws://${this.host}:${this.port}${locationHeader}`;
      deleteUrl = `http://${this.host}:${this.port}${locationHeader}`;
    }

    const sub: ActiveSubscription = {
      id: subscriptionId,
      wsUrl,
      deleteUrl,
      ws: null,
      handler,
      retryCount: 0,
      closed: false,
    };

    this.subscriptions.set(subscriptionId, sub);
    this.openWebSocket(sub);

    // Return unsubscribe function
    return async () => {
      sub.closed = true;
      if (sub.ws) {
        sub.ws.close();
        sub.ws = null;
      }
      this.subscriptions.delete(subscriptionId);
      // Best-effort DELETE — ignore errors (controller may have already cleaned up)
      await this.session.delete(sub.deleteUrl).catch(() => undefined);
    };
  }

  /** Close all active subscriptions */
  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const sub of this.subscriptions.values()) {
      sub.closed = true;
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

  // ─── WebSocket lifecycle ────────────────────────────────────────────────────

  private openWebSocket(sub: ActiveSubscription): void {
    const cookieHeader = this.session.getCookieHeader();
    const WS = resolveWebSocket() as new (
      url: string,
      protocols: string[],
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new WS(sub.wsUrl, ['robapi2_subscription'], {
      headers: { Cookie: cookieHeader },
    });

    sub.ws = ws;

    ws.onopen = (): void => {
      sub.retryCount = 0;
    };

    ws.onmessage = (event: MessageEvent): void => {
      try {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        const events = parseWsMessage(data);
        for (const e of events) {
          sub.handler(e);
        }
      } catch {
        // Silently discard unparseable messages — don't crash the subscriber
      }
    };

    ws.onerror = (): void => {
      // onclose fires after onerror; reconnect logic lives there
    };

    ws.onclose = (event: Event & { wasClean?: boolean }): void => {
      if (sub.closed) return; // intentional close — do not reconnect

      if (!event.wasClean && sub.retryCount < MAX_RETRIES) {
        const delay = BACKOFF_MS[sub.retryCount] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        sub.retryCount++;
        setTimeout(() => {
          if (!sub.closed) this.openWebSocket(sub);
        }, delay);
      }
    };
  }
}
