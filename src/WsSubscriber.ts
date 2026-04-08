/**
 * WsSubscriber — WebSocket subscription manager for ABB IRC5 RWS events.
 *
 * Flow:
 *   1. POST /subscription via HttpSession to register resources → get subscription ID
 *   2. Open WebSocket to ws://{host}/subscription/{id} with robapi2_subscription subprotocol
 *   3. Parse incoming XML event messages → emit typed SubscriptionEvent objects
 *   4. Auto-reconnect on unexpected close: max 3 retries, exponential backoff 1s/2s/4s
 *
 * Uses Node 18+ built-in WebSocket (undici). Requires --experimental-websocket flag on
 * Node 18; available by default in Node 21+.
 */

import { RwsError } from './types.js';
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
  if (resource === 'execution') return '/rw/rapid/execution;state';
  if (resource === 'controllerstate') return '/rw/panel/ctrlstate;state';
  if (resource === 'operationmode') return '/rw/panel/opmode;state';
  if (resource.type === 'signal') {
    // Signal path requires network/device/name but SubscriptionResource only gives the
    // signal name. Use a direct path that the user is expected to pass as the full path.
    // Convention: name can be 'network/device/signalname' or just 'signalname' for
    // simple virtual/local signals.
    const parts = resource.name.split('/');
    if (parts.length === 3) {
      return `/rw/iosystem/signals/${resource.name};state`;
    }
    // Fallback: treat as a virtual signal on 'Virtual1/DRV1' — not universally correct,
    // but the best we can do without network/device context in this resource type.
    return `/rw/iosystem/signals/${resource.name};state`;
  }
  if (resource.type === 'persvar') {
    // RAPID persistent variable subscription path
    return `/rw/rapid/symbol/data/${resource.name};value`;
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
    if (!globalThis.WebSocket) {
      throw new RwsError(
        'WebSocket is not available in this Node.js version. ' +
          'Requires Node 21+ or Node 18 with --experimental-websocket flag.',
        'NETWORK_ERROR',
      );
    }

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

    // Step 2: Convert Location URL to WebSocket URL
    // Location may be http://host/subscription/1 → ws://host/subscription/1
    // or just a path like /subscription/1 → ws://host:port/subscription/1
    let wsUrl: string;
    if (locationHeader.startsWith('http://') || locationHeader.startsWith('https://')) {
      wsUrl = locationHeader.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    } else {
      wsUrl = `ws://${this.host}:${this.port}${locationHeader}`;
    }

    const sub: ActiveSubscription = {
      id: subscriptionId,
      wsUrl,
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
      await this.session.delete(`${subscriptions()}/${subscriptionId}`).catch(() => undefined);
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
        this.session.delete(`${subscriptions()}/${sub.id}`).then(() => undefined).catch(() => undefined),
      );
    }
    this.subscriptions.clear();
    await Promise.allSettled(promises);
  }

  // ─── WebSocket lifecycle ────────────────────────────────────────────────────

  private openWebSocket(sub: ActiveSubscription): void {
    const cookieHeader = this.session.getCookieHeader();

    // Node 18 undici WebSocket supports custom headers via the third constructor argument.
    // The 'headers' option is undici-specific and not part of the WHATWG WebSocket spec.
    // We use a type cast here because the WHATWG WebSocket constructor type does not
    // include this undici extension.
    const WS = globalThis.WebSocket as new (
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
