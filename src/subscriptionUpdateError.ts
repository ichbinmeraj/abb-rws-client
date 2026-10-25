/**
 * The error a subscription group edit (`updateSubscriptionGroup`, PUT
 * /subscription/{group}) throws when the controller refuses resources in it,
 * with what the answer says was bound.
 *
 * A PUT naming an unknown resource among valid ones answers 400 -1073445866
 * "Invalid resource URI in Update Subscription request" and still binds the
 * valid ones (live-verified 2026-09-27 on RW 7.21.0 and 8.1.1, and 2026-09-29
 * on RW 7.21.4+417 and 8.2.1+1023; the group's own listing shows them
 * afterwards). The 400 body carries a status div whose self link names the
 * refused resource, then a state div with one `...-ev` entry per bound
 * resource and its current value - in an order that need not match the
 * request's - for example:
 *
 *   <div class="status"> <a href="/rw/iosystem/signals/no_such;state" rel="self"> </a>
 *     <span class="code">-1073445866</span> <span class="msg">Invalid resource URI in Update Subscription request</span></div>
 *   <div class="state"> <ul> <li class="ios-signalstate-ev" title="di_b">
 *     <a href="/rw/iosystem/signals/di_b;state" rel="self"/><span class="lvalue">1</span>... </li> ... </ul> </div>
 *
 * A PUT naming only unknown resources gets the same 400 with an empty state
 * div. An answer may carry one status div per refused resource (the RWS 1.0
 * create reader handles them the same way), so every status div is read.
 */

import { parseBody } from './commonReads.js';
import { RwsError } from './types.js';

/**
 * A subscription group edit the controller refused resources in: an HTTP 400
 * answer, or on RWS 1.0 also a 2xx answer whose status divs name refused
 * resources (`httpStatus` is then that 2xx). Same `code`, `httpStatus`,
 * `controllerCode`, `controllerMsg` and `message` as the `RwsError` it
 * replaces, plus what the answer lists: `bound`, the resources the controller
 * bound despite the refusal, and `refused`, the ones its status divs name. The
 * resources in neither list were not reported either way: read the group
 * (`getSubscriptionGroup`) to know.
 */
export class SubscriptionUpdateError extends RwsError {
  /**
   * Resource paths the controller bound, e.g. `/rw/iosystem/signals/di_a`:
   * the self links of the answer's `...-ev` entries without the `;state`
   * style suffix, each once, in the answer's order. An event-log entry links
   * to its newest message (`/rw/elog/0/52`) and is given as the domain it
   * belongs to (`/rw/elog/0`), the path the request names. Match them to the
   * request by path, not by position. Empty when the answer lists none or
   * cannot be read.
   */
  readonly bound: string[];
  /**
   * Resource paths the answer's status divs name as refused, one per div,
   * without the suffix; empty when they name none.
   */
  readonly refused: string[];
  /**
   * The raw answer body. Its entries carry the bound resources' current values
   * (the starting values a WebSocket does not send). On RWS 2.0 no longer than
   * the client's `maxResponseBytes`.
   */
  readonly body: string;

  constructor(
    source: RwsError,
    parts: { bound?: readonly string[]; refused?: readonly string[]; body?: string } = {},
  ) {
    const body = parts.body ?? source.responseBody ?? '';
    super(
      source.message, source.code, source.httpStatus, source.rwsDetail,
      source.controllerCode, source.controllerMsg, source.refusal, body,
    );
    this.name = 'SubscriptionUpdateError';
    this.bound = [...(parts.bound ?? [])];
    this.refused = [...(parts.refused ?? [])];
    this.body = body;
  }
}

/**
 * A resource path from a self link: scheme and host dropped, the `;state`
 * style suffix and any query cut off, a leading `/` ensured. `undefined` for
 * an empty link.
 */
function resourcePath(href: string | undefined): string | undefined {
  if (!href) { return undefined; }
  const path = href.trim()
    .replace(/&amp;/g, '&')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .split(/[;?#]/)[0];
  if (path === '') { return undefined; }
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * The subscribed resource an `...-ev` entry's self link stands for: its
 * resource path, except that an event-log message link
 * (`/rw/elog/{domain}/{seqnum}`) stands for its domain (`/rw/elog/{domain}`).
 */
function boundResourcePath(href: string | undefined): string | undefined {
  const path = resourcePath(href);
  return path?.replace(/^(\/rw\/elog\/\d+)\/\d+$/, '$1');
}

/**
 * What a group PUT's answer says: the resources bound (`...-ev` entries with
 * a self link) and the ones refused (the self links of every status div).
 * Both are empty when the body cannot be read; nothing here throws.
 */
export function readSubscriptionUpdateAnswer(body: string): { bound: string[]; refused: string[] } {
  const bound: string[] = [];
  const refused: string[] = [];
  try {
    for (const e of parseBody(body).getAllEntries()) {
      if (!(e['_type'] ?? '').endsWith('-ev')) { continue; }
      const path = boundResourcePath(e['_href']);
      if (path && !bound.includes(path)) { bound.push(path); }
    }
    for (const [, status] of body.matchAll(/<div class="status"[^>]*>([\s\S]*?)<\/div>/g)) {
      for (const [, attrs] of status.matchAll(/<a\b([^>]*)>/g)) {
        if (!/\brel="self"/.test(attrs)) { continue; }
        const path = resourcePath(/\bhref="([^"]*)"/.exec(attrs)?.[1]);
        if (path && !refused.includes(path)) { refused.push(path); }
      }
    }
  } catch {
    return { bound: [], refused: [] };
  }
  return { bound, refused };
}

/**
 * `err` as a `SubscriptionUpdateError` when it is an `RwsError` for an HTTP
 * 400 answer read in full, with the lists read from `body` (default: the
 * error's `responseBody`). Any other error is returned as it is - among them
 * a 400 whose body was cut off (a `NETWORK_ERROR` with no body), where empty
 * lists would wrongly say that nothing was bound.
 */
export function asSubscriptionUpdateError(err: unknown, body?: string): unknown {
  if (!(err instanceof RwsError) || err instanceof SubscriptionUpdateError || err.httpStatus !== 400) {
    return err;
  }
  const text = body ?? err.responseBody;
  if (text === undefined) { return err; }
  return new SubscriptionUpdateError(err, { ...readSubscriptionUpdateAnswer(text), body: text });
}
