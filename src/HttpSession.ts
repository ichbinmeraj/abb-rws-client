/**
 * HttpSession - HTTP communication layer for ABB IRC5 controllers.
 *
 * Features:
 * - HTTP Digest Authentication (RFC 2617) implemented from scratch using node:crypto
 * - ABBCX + -http-session- cookie management
 * - Request queue enforcing minimum interval between requests (<20 req/sec RWS limit)
 * - Automatic re-authentication on session expiry (5-minute inactivity)
 * - 401 retry with fresh digest handshake; 503 retry with 200ms backoff
 *   (through node:http on a new connection)
 * - One timeout per request that covers the body as well as the headers,
 *   extended per request by a hold the controller takes on purpose (a DIPC
 *   read waiting for a message)
 *
 * Sends through Node's global fetch, as up to 1.4.0, on every port fetch
 * accepts; on a port fetch refuses (the Fetch standard's bad ports, see
 * badPorts.ts) through node:http / node:https with one keep-alive agent per
 * session. Chosen once per session from the base URL; see rawFetch. Uses
 * node:crypto for the digest. Zero external dependencies.
 */

import * as http from 'http';
import * as https from 'https';
import * as zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { RwsError } from './types.js';
import { Logger } from './Logger.js';
import { redactBody } from './redact.js';
import { classifyControllerError } from './ControllerError.js';
import { effectivePort, fetchRefusesUrl } from './badPorts.js';
import type { DigestChallenge, HttpResponse, RefusalContext } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Longest delay a Node timer takes (2^31-1 ms, about 24.8 days); a longer one fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The `timeout` option of a client, one rule for both generations
 * (`RwsClient` here, `RwsClient2` in rws2/core.ts): `fallback` when it is
 * left out (undefined or null); the value as given when it is a finite number
 * above 0 and at most MAX_TIMER_MS; anything else is refused with
 * INVALID_ARGUMENT, at construction, before anything is sent.
 *
 * The value goes to Node's timers, which take nothing else as given. On RWS
 * 1.0 setTimeout fires 0, a negative value, NaN and a delay above 2^31-1 ms
 * (Infinity included) after 1 ms, with a Node warning for each but 0, so
 * every request failed as timed out; on RWS 2.0 the socket's idle timer
 * threw a RangeError for Infinity, a negative value or NaN, and capped a
 * longer one with a TimeoutOverflowWarning. The connect factories and probes
 * (detect.ts) apply the same rule before their first probe. 0 has
 * never been documented as "no timeout", and the timeout is what ends a
 * request a controller never answers, so no value turns it off.
 */
export function checkedTimeout(value: unknown, fallback: number, who: string): number {
  if (value === undefined || value === null) { return fallback; }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS) {
    return value;
  }
  const shown = typeof value === 'number' ? String(value)
    : typeof value === 'string' ? JSON.stringify(value)
      : `a value of type ${typeof value}`;
  throw new RwsError(
    `${who}: timeout must be a number of milliseconds above 0 and at most ${MAX_TIMER_MS} (about 24.8 days), got ${shown}`,
    'INVALID_ARGUMENT',
  );
}

/** The cookie that names the controller session. */
const SESSION_COOKIE = '-http-session-';

/** What one request brought back: the status, the headers and the whole body. */
interface RawResponse { status: number; headers: Headers; body: string }

/**
 * How a session sends its requests (see rawFetch): Node's global fetch, or
 * node:http / node:https for a port fetch refuses.
 */
type Transport = 'fetch' | 'node:http';

/**
 * One attempt at a request. `staleSocket` marks a failure that looks like a
 * pooled keep-alive connection the controller had already closed (see
 * viaNodeHttp): a reused connection, no answer yet, a reset or hang-up, and
 * within STALE_WINDOW_MS of the request going out.
 */
type Attempt = { response: RawResponse } | { error: RwsError; staleSocket: boolean };

/**
 * Node's response headers as a WHATWG Headers object, the type callers have
 * always received (`HttpResponse.headers`). Built from the raw name/value
 * pairs so that every Set-Cookie line stays its own entry for
 * `getSetCookie()`; Node's parsed `res.headers` joins repeated headers. A
 * header the Headers class refuses is left out rather than failing the
 * whole answer.
 */
function toHeaders(raw: string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try { headers.append(raw[i], raw[i + 1]); } catch { /* left out, see above */ }
  }
  return headers;
}

/**
 * "Network error: " and Node's own message, with its code (ECONNREFUSED,
 * ECONNRESET, ...) when the message does not already name it.
 *
 * A host name with several addresses (`localhost`: ::1 and 127.0.0.1) fails
 * on Node 20+ as an AggregateError whose own message is empty; the message of
 * each address's error is used instead ("connect ECONNREFUSED ::1:7; connect
 * ECONNREFUSED 127.0.0.1:7"), so the error still says where it tried.
 */
function networkError(e: unknown): RwsError {
  const err = e instanceof Error ? e as NodeJS.ErrnoException : undefined;
  let message = err ? err.message : String(e);
  if (e instanceof AggregateError && Array.isArray(e.errors) && e.errors.length > 0) {
    const inner = [...new Set(e.errors.map((x: unknown) => (x instanceof Error ? x.message : String(x))))]
      .filter(m => m.length > 0).join('; ');
    if (inner) { message = message ? `${message}: ${inner}` : inner; }
  }
  const code = err?.code;
  const detail = code && !message.includes(code) ? `${message} (${code})`.trim() : message;
  return new RwsError(`Network error: ${detail}`, 'NETWORK_ERROR');
}

/**
 * A failed fetch as a NETWORK_ERROR. fetch rejects with a TypeError whose
 * message is only "fetch failed"; what went wrong is its `cause` (Node's
 * connect error, undici's "other side closed", ...), which is named the way
 * networkError names node:http's errors. 1.4.0 said only "Network error:
 * TypeError: fetch failed". A rejection without a cause (a URL that does not
 * parse, a header value fetch refuses) is named by its own message.
 *
 * Cause "bad port": fetch refused the port and sent nothing. A session on a
 * port of FETCH_BAD_PORTS never goes through fetch (port 0 aside, which
 * Node 24.19 accepts; see badPorts.ts), so this is a port the running Node
 * refuses and the list lacks (another release of the undici it bundles);
 * the error says so instead of "fetch failed".
 */
function fetchError(e: unknown, baseUrl: string): RwsError {
  const cause = (e as { cause?: unknown } | undefined)?.cause;
  if (cause instanceof Error && /^bad port$/i.test(cause.message)) {
    const port = effectivePort(baseUrl);
    return new RwsError(
      `Network error: Node's fetch refuses port ${port ?? '(unknown)'} ("bad port" in the Fetch standard) and sent nothing; `
      + 'this client sends the ports it knows fetch refuses through node:http instead, and this one is not on its list',
      'NETWORK_ERROR',
    );
  }
  return networkError(cause ?? e);
}

/**
 * The body bytes with the answer's Content-Encoding undone. The request asks
 * for `identity` (see viaNodeHttp), so a controller that honours it never
 * compresses; one that compresses anyway is read as fetch read it (gzip,
 * deflate, br), and any other encoding fails as NETWORK_ERROR naming it
 * instead of reaching the parser as garbled text.
 */
function decodeContent(raw: Buffer, contentEncoding: string | undefined): Buffer {
  if (!contentEncoding) { return raw; }
  // Codings are listed in the order they were applied; undo them in reverse.
  const codings = contentEncoding.split(',').map(c => c.trim().toLowerCase()).filter(c => c.length > 0);
  let bytes = raw;
  for (const coding of codings.reverse()) {
    if (coding === 'identity') { continue; }
    if (coding === 'gzip' || coding === 'x-gzip') {
      bytes = zlib.gunzipSync(bytes);
    } else if (coding === 'deflate') {
      // "deflate" is meant to be zlib-wrapped, but some servers send it raw.
      try { bytes = zlib.inflateSync(bytes); } catch { bytes = zlib.inflateRawSync(bytes); }
    } else if (coding === 'br') {
      bytes = zlib.brotliDecompressSync(bytes);
    } else {
      throw new RwsError(
        `Network error: the controller answered in the content encoding "${coding}", which this client does not read`,
        'NETWORK_ERROR',
      );
    }
  }
  return bytes;
}

/**
 * The names (never the values) of the cookies an answer sets, for a trace:
 * `{ setCookie: ['ABBCX'] }`, or nothing when it sets none.
 */
function cookieNames(headers: Headers): { setCookie?: string[] } {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie !== 'function') { return {}; }
  const names = getSetCookie.call(headers)
    .map(c => c.split(';')[0].split('=')[0].trim())
    .filter(n => n.length > 0);
  return names.length > 0 ? { setCookie: names } : {};
}

/** The errors of a keep-alive connection the peer had already closed. */
function isStaleSocketError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNRESET' || code === 'EPIPE'
    || (e instanceof Error && /socket hang up/i.test(e.message));
}

// ─── HttpSession options ─────────────────────────────────────────────────────

export interface HttpSessionOptions {
  baseUrl: string;
  username: string;
  password: string;
  requestIntervalMs: number;
  /**
   * The request timeout in ms (`RwsClient`'s `timeout`): above 0 and at most
   * 2^31-1, or the constructor throws INVALID_ARGUMENT (see checkedTimeout).
   */
  timeoutMs: number;
  /** Pre-load a saved -http-session- cookie to reuse an existing controller session slot */
  sessionCookie?: string;
  /**
   * Called when the controller session this client used was replaced by a
   * new one: the fresh-session retry after a 401 that persists with a cookie,
   * or a response that sets a different `-http-session-` value. Everything
   * tied to the old session, mastership among it, belongs to that session.
   */
  onSessionReplaced?: (why: string) => void;
  /**
   * What the owner knows about the controller when a request is refused
   * (generation, mode, user...), used to explain the refusal in plain words.
   */
  refusalContext?: () => RefusalContext;
}

// ─── HttpSession ─────────────────────────────────────────────────────────────

export class HttpSession {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly requestIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly onSessionReplaced?: (why: string) => void;
  private readonly refusalContext?: () => RefusalContext;

  /** Stored session cookies: '-http-session-' and 'ABBCX' */
  private cookies: Map<string, string> = new Map();

  /**
   * The cookies a 401 answer set during the request in progress. They go out
   * with that request's next attempt (the digest answer), and become the
   * session's own only when a later answer to it is not a 401; the request's
   * final AUTH_FAILED drops them, and the next request starts without them.
   * See storeCookies.
   */
  private challengeCookies: Map<string, string> = new Map();

  /** Last parsed digest challenge from WWW-Authenticate */
  private digestChallenge: DigestChallenge | null = null;

  /** Nonce use counter - reset to 0 whenever a new nonce is received */
  private nonceCount = 0;

  /** Timestamp of the most recent request sent */
  private lastRequestTime = 0;

  /** Timestamp of the most recent successful response - used for session expiry */
  private lastActivityTime = 0;

  /** Promise chain that serialises all outbound requests */
  private requestQueue: Promise<void> = Promise.resolve();

  /** Set by close(), cleared by reopen(); see close(). */
  private closed = false;

  /** Counts close() calls, so a later close owns the release of the pooled connection. */
  private closeSeq = 0;

  /** True when the base URL is https: picks node:https and its agent. */
  private readonly isHttps: boolean;

  /**
   * How this session sends: fetch, or node:http for a port fetch refuses.
   * Chosen once, from the base URL, which does not change. See rawFetch.
   */
  private readonly transport: Transport;

  /**
   * The keep-alive agent of a session that sends through node:http (none
   * through fetch), http or https by the base URL: one connection is reused
   * from request to request (the queue sends one at a time). fetch's pool
   * did not keep to one: a request sent in the same tick the previous answer
   * ended went out on a second connection (measured on Node 24.19,
   * 2026-10-22), which is how a 503 on a kept connection used to clear
   * itself; on this path a 503 is sent again on a new connection on purpose
   * (see execute()). Its sockets are destroyed once the session is closed
   * and what was queued before has gone out (see close()).
   *
   * Not inside VS Code (RAPID Live) while its `http.proxySupport` is not
   * `off`: there `@vscode/proxy-agent` (0.45.0) puts its own agent, with
   * keep-alive off, in front of every request, so each request goes out on a
   * connection of its own with `Connection: close`, for every host, loopback
   * included; this agent at most opens the socket. RWS 2.0 runs that way in
   * the extension host too. Through fetch RWS 1.0 kept its connection there,
   * which is why fetch stays the transport on every port it accepts (owner
   * decision 2026-10-23). See rawFetch.
   */
  private readonly agent: http.Agent | undefined;

  /** 5-minute session inactivity timeout (milliseconds) */
  private static readonly SESSION_TIMEOUT_MS = 5 * 60 * 1000;

  /** Longest delay a Node timer takes; a longer one fires after 1 ms. */
  private static readonly MAX_TIMER_MS = MAX_TIMER_MS;

  /**
   * How long an idle pooled connection is kept: 4 s, what fetch's pool
   * (undici) kept one when the controller announced no `Keep-Alive: timeout`
   * (measured on Node 24, 2026-10-22). Every answer in the 2026-09-29 RW
   * 6.16.03 probe log carries `Connection: Keep-Alive` and no such hint, so
   * on RWS 1.0 this is the time fetch kept. Closing first keeps the client
   * from sending on a connection the controller is about to close, as long as
   * the controller keeps idle connections longer; when it does not, some
   * reads are sent again (see viaNodeHttp). The agent's timeout only closes IDLE
   * sockets; a request in progress is bounded by viaNodeHttp's own timer.
   */
  private static readonly IDLE_SOCKET_MS = 4000;

  /** Methods sent again after a failure on a dead pooled connection. NEVER add a write; see viaNodeHttp. */
  private static readonly IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);

  /**
   * GETs that change something on the controller and so are never sent
   * twice: a DIPC read takes the message it returns off the queue, and
   * /logout ends the session. See viaNodeHttp.
   */
  private static readonly NOT_REPEATABLE = /[?&]action=dipc-read(?:&|$)|^\/logout(?:[?#]|$)/i;

  /**
   * A failure on a dead pooled connection arrives within a round trip of the
   * request going out: the controller's close was already on its way. One
   * that arrives later can follow a request the controller read and worked
   * on, and is not counted as a dead pooled connection. See viaNodeHttp.
   */
  private static readonly STALE_WINDOW_MS = 1000;

  constructor(options: HttpSessionOptions) {
    this.baseUrl = options.baseUrl;
    this.username = options.username;
    this.password = options.password;
    this.requestIntervalMs = options.requestIntervalMs;
    // A value Node's timers cannot hold failed every request; it is refused
    // here, before the agent is made (see checkedTimeout).
    this.timeoutMs = checkedTimeout(options.timeoutMs, 5000, 'RWS1');
    this.onSessionReplaced = options.onSessionReplaced;
    this.refusalContext = options.refusalContext;
    this.isHttps = /^https:/i.test(options.baseUrl);
    this.transport = fetchRefusesUrl(options.baseUrl) ? 'node:http' : 'fetch';
    this.agent = this.transport === 'fetch' ? undefined
      : this.isHttps
        ? new https.Agent({ keepAlive: true, timeout: HttpSession.IDLE_SOCKET_MS })
        : new http.Agent({ keepAlive: true, timeout: HttpSession.IDLE_SOCKET_MS });
    // Pre-load saved cookies so reconnects reuse the same session slot.
    // Accepts the full Cookie header string, e.g. "-http-session-=...; ABBCX=..."
    if (options.sessionCookie) {
      for (const part of options.sessionCookie.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name) this.cookies.set(name, value);
      }
    }
  }

  // ─── Public HTTP methods ────────────────────────────────────────────────────
  //
  // `holdMs` is how long the controller may keep this request open on purpose
  // before it answers (a DIPC read waiting for a message, say). This one
  // request's timeout is extended by it, so the client does not abort such a
  // wait; every other request keeps the instance's timeout. The request still
  // occupies the serial queue for as long as the controller holds it.

  get(path: string, holdMs = 0): Promise<HttpResponse> {
    return this.enqueue('GET', path, () => this.execute('GET', path, undefined, holdMs));
  }

  post(path: string, body?: string, holdMs = 0): Promise<HttpResponse> {
    return this.enqueue('POST', path, () => this.execute('POST', path, body, holdMs));
  }

  put(path: string, body: string | Uint8Array, holdMs = 0): Promise<HttpResponse> {
    return this.enqueue('PUT', path, () => this.execute('PUT', path, body, holdMs));
  }

  delete(path: string, holdMs = 0): Promise<HttpResponse> {
    return this.enqueue('DELETE', path, () => this.execute('DELETE', path, undefined, holdMs));
  }

  /** Returns the current cookie string for use in WebSocket connections */
  getCookieHeader(): string {
    return this.buildCookieHeader();
  }

  /** Returns the full cookie header string (all cookies) for persistence across reloads */
  getSessionCookie(): string | null {
    const header = this.buildCookieHeader();
    return header || null;
  }

  /**
   * Called on disconnect. Intentionally preserves all session state (cookie,
   * digest challenge, nonce) so the next connect() reuses the same controller
   * session slot without triggering a new 401 handshake.
   *
   * The controller limits concurrent sessions (70 max on IRC5). Creating a new
   * session on every reconnect fills the pool and causes persistent 503 errors.
   * If the nonce has gone stale the controller returns 401 and we re-auth inline.
   */
  clearSession(): void {
    // No-op: preserve cookie + digest state across disconnect/reconnect cycles.
  }

  /**
   * Refuse every request from now on (NOT_CONNECTED) until `reopen()`.
   * Requests queued before this call still go out, in order.
   *
   * RwsClient.disconnect() calls this in the same tick it queues /logout, so
   * nothing is sent after the logout.
   *
   * Through node:http, once those queued requests have settled, the pooled
   * keep-alive connection is destroyed, so a disconnected client keeps no
   * socket open to the controller (structural cell S08 counts them across
   * connect/disconnect cycles). Not when reopen() came first, nor when a
   * later close() took over (it releases the connection after its own
   * queue). The agent stays usable: the next request after reopen() opens a
   * new connection.
   *
   * Through fetch the session has no connection of its own to release: the
   * process's fetch pool keeps an idle connection until its own idle timeout
   * (about 4 s), as in 1.4.0. Inside VS Code with proxy support on (its
   * default), the agent holds no kept connection either: every request
   * already went out on its own connection (see `agent`).
   */
  close(): void {
    this.closed = true;
    const seq = ++this.closeSeq;
    // requestQueue never rejects (see enqueue), and destroy() does not throw.
    void this.requestQueue.then(() => {
      if (this.closed && seq === this.closeSeq) { this.agent?.destroy(); }
    });
  }

  /** Accept requests again (RwsClient.connect()). */
  reopen(): void { this.closed = false; }

  /** True between `close()` and `reopen()`. */
  get isClosed(): boolean { return this.closed; }

  // ─── Request queue ──────────────────────────────────────────────────────────

  /**
   * Append a function to the serial request queue, enforcing the minimum interval
   * between requests. Error suppression on `this.requestQueue` (not on `result`)
   * ensures queue continues processing even when individual requests fail.
   */
  private enqueue<T>(method: string, path: string, fn: () => Promise<T>): Promise<T> {
    // Checked when the request is QUEUED, not when it runs: whatever was queued
    // before close() (the /logout among it) must still go out.
    if (this.closed) {
      return Promise.reject(new RwsError(
        `RWS1 ${method} ${path}: session is closed (disconnected) - call connect() first`,
        'NOT_CONNECTED',
      ));
    }
    const result = this.requestQueue.then(async () => {
      const elapsed = Date.now() - this.lastRequestTime;
      if (this.requestIntervalMs > 0 && elapsed < this.requestIntervalMs) {
        await sleep(this.requestIntervalMs - elapsed);
      }
      this.lastRequestTime = Date.now();
      return fn();
    });

    // Detach error from the shared queue chain so a failed request does not block
    // subsequent ones. Callers still receive the rejection via `result`.
    this.requestQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  // ─── Core request execution ─────────────────────────────────────────────────

  private async execute(
    method: string,
    path: string,
    body?: string | Uint8Array,
    holdMs = 0,
  ): Promise<HttpResponse> {
    const startedAt = Date.now();
    const bodyPreview = body
      ? redactBody(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'))!.slice(0, 200)
      : undefined;
    Logger.trace?.('http.req', `RWS1 ${method} ${path}`, { protocol: 'rws1', method, path, bodyPreview });

    // Auto re-authenticate if the session may have expired.
    // Only clear digest auth state - keep the session cookie so the controller
    // reuses the same session slot instead of creating a new one.
    if (this.isSessionExpired()) {
      this.digestChallenge = null;
      this.nonceCount = 0;
    }

    // Whether this request goes out with a cookie held from before it (a
    // saved one, or one an earlier answer other than a 401 set). The cookies
    // a 401 sets are not the session's (storeCookies), so they never count
    // here. See the dead-cookie retry below.
    this.challengeCookies.clear();
    const heldCookie = this.cookies.size > 0;
    let response = await this.rawFetch(method, path, body, holdMs);

    // 401 → perform digest handshake then retry once
    if (response.status === 401) {
      const wwwAuth = response.headers.get('www-authenticate');
      if (!wwwAuth) {
        Logger.trace?.('http.err', `RWS1 ${method} ${path} → 401 (no auth header)`, { protocol: 'rws1', method, path });
        this.challengeCookies.clear();
        throw new RwsError('401 without WWW-Authenticate header', 'AUTH_FAILED', 401);
      }
      this.digestChallenge = this.parseDigestChallenge(wwwAuth);
      this.nonceCount = 0;

      response = await this.rawFetch(method, path, body, holdMs);

      // A session cookie the controller no longer knows keeps it answering 401
      // even to correct digest credentials. Live 2026-09-25 (IRC5 VC, RW6.16):
      // a dead session's cookie, loaded from the shared session file for that
      // host:port, made every later connect fail as "Authentication failed"
      // until the entry was deleted by hand. Forget the cookies and
      // authenticate once more on a fresh session. Only for a cookie held
      // from before this request: one the first 401 set is the controller's
      // own, and a second 401 then means wrong credentials, not a dead
      // session (a third request would report a session replaced that never
      // existed, and RobotManager reads that as mastership lost).
      const retryAuth = response.status === 401 ? response.headers.get('www-authenticate') : null;
      if (retryAuth && heldCookie) {
        Logger.info(`RWS1 ${method} ${path} → 401 with a session cookie - retrying on a fresh session`);
        this.cookies.clear();
        this.challengeCookies.clear();
        // The old session is gone for this client, and with it whatever it
        // held; the request below runs on a new session.
        this.sessionReplaced('the controller no longer accepted the session cookie, so the request was sent again on a new session');
        this.digestChallenge = this.parseDigestChallenge(retryAuth);
        this.nonceCount = 0;
        response = await this.rawFetch(method, path, body, holdMs);
      }

      if (response.status === 401) {
        Logger.trace?.('http.err', `RWS1 ${method} ${path} → 401 (auth failed)`, { protocol: 'rws1', method, path });
        // The cookies these 401s set are dropped with the request: on a
        // controller that set a new -http-session- on every 401, keeping them
        // made the next rejected call start with a "held" cookie, cost a third
        // request (the fresh-session attempt) and report a replaced session
        // that never existed.
        this.challengeCookies.clear();
        throw new RwsError('Authentication failed - check username and password', 'AUTH_FAILED', 401);
      }
    }

    // 503 → wait 200ms and retry once; through node:http on a new connection.
    //
    // Live 2026-10-22 (RW 6.16.03 VC, functional test 10-subscriptions, its
    // connections dropped by a relay): once the controller had let go of this
    // client's ABBCX, the first request on a new connection was answered (a
    // 400 to the best-effort DELETE of the old group) and every later request
    // on that kept connection got 503, so the subscription never came back.
    // Through fetch the same test passed: the POST that followed a 503 went
    // out on a second connection (see `agent`), was its first request, and
    // got 201 with a new ABBCX. Through node:http the retry is sent on a new
    // connection, so it is the first request there; to a controller that is
    // only busy, that costs one connection set-up. Through fetch there is no
    // pool of the session's own to empty: the retry goes where fetch's pool
    // puts it, as in 1.4.0. On both paths the cookies of every answer but a
    // 401 are kept (rawFetch), and RW 6.16.03 sets the new ABBCX on that 400 (seen
    // on the wire 2026-10-22, port 7, through node:http: the POST after it
    // got 201 with no 503), so the requests after it carry the new ABBCX
    // whatever the connection, and through fetch the recovery does not hang
    // on which connection its pool picks. Only a controller that set no
    // cookie on the 400 (none seen) would leave it to fetch's pool: in the
    // tests' scripted drop at the default 55 ms pace, the pool sent the POST
    // and its retry on the kept connection and the POST failed
    // CONTROLLER_BUSY (Node 24.19, 2026-10-23); with no pause it put the POST
    // on a new connection, which recovered.
    if (response.status === 503) {
      const where = this.transport === 'node:http' ? ' on a new connection' : '';
      Logger.trace?.('http.err', `RWS1 ${method} ${path} → 503 - retrying once${where}`, {
        protocol: 'rws1', method, path, status: 503,
        bodyPreview: response.body.slice(0, 300), ...cookieNames(response.headers),
      });
      await sleep(200);
      this.dropIdleConnections();
      response = await this.rawFetch(method, path, body, holdMs);
      if (response.status === 503) {
        Logger.trace?.('http.err', `RWS1 ${method} ${path} → 503 busy`, {
          protocol: 'rws1', method, path,
          bodyPreview: response.body.slice(0, 300), ...cookieNames(response.headers),
        });
        throw new RwsError('Controller busy (503) - retry later', 'CONTROLLER_BUSY', 503);
      }
    }

    if (!this.isOk(response.status)) {
      const bodyText = response.body;
      Logger.trace?.('http.err', `RWS1 ${method} ${path} → ${response.status}`, {
        protocol: 'rws1', method, path, status: response.status,
        durationMs: Date.now() - startedAt,
        bodyPreview: bodyText.slice(0, 300),
        ...cookieNames(response.headers),
        // A redirect through node:http is not followed (see viaNodeHttp); say where it pointed.
        ...(response.status >= 300 && response.status < 400
          ? { location: response.headers.get('location') ?? undefined } : {}),
      });
      // Classify by the controller's OWN error body, not the HTTP status alone -
      // a 403 can mean held mastership, missing RMMP, or a wrong mode, and only
      // a failed auth handshake (handled above) is a credential problem.
      let context: RefusalContext = { generation: 'rw6', user: this.username };
      try { context = { ...context, ...this.refusalContext?.() }; } catch { /* explain without it */ }
      const info = classifyControllerError({
        httpStatus: response.status, body: bodyText, method, path,
        fallback: this.mapHttpStatus(response.status),
        context,
        requestBody: body,
      });
      throw new RwsError(
        info.message,
        info.code,
        response.status,
        bodyText,
        info.controllerCode ?? undefined,
        info.controllerMsg ?? undefined,
        info.refusal,
      );
    }
    Logger.trace?.('http.res', `RWS1 ${method} ${path} → ${response.status}`, {
      protocol: 'rws1', method, path, status: response.status,
      durationMs: Date.now() - startedAt,
      ...cookieNames(response.headers),
    });

    // The answer's cookies are already kept (rawFetch).
    this.lastActivityTime = Date.now();

    return { status: response.status, body: response.body, headers: response.headers };
  }

  /**
   * Issue a single HTTP request with digest auth header if we have a challenge.
   *
   * Two transports, chosen once per session from the base URL (`transport`):
   * - Node's global fetch (viaFetch), as up to 1.4.0, on every port fetch
   *   accepts: nothing changes for a controller that 1.4.0 reached;
   * - node:http, node:https for an https base URL (viaNodeHttp), on a port
   *   fetch refuses. fetch refuses the Fetch standard's "bad ports" (1, 7, 9,
   *   21, 22, 25, ..., 6000, 6665-6669, 10080; the list is in badPorts.ts)
   *   before it sends anything ("fetch failed", cause "bad port"). Live
   *   2026-10-22: a RobotStudio RW 6.16.03 virtual controller came back on
   *   port 7 after a restart and this client could not log in, while
   *   discovery's socket probe and node:http saw it answer. Real IRC5
   *   controllers are no safer: port 80 is only RWS 1.0's default, and plants
   *   reach controllers through NAT and port forwarding on any port. The RWS
   *   2.0 transport (rws2/core.ts) has always used node:http.
   * The port is the base URL's effective one (80 for http, 443 for https
   * when it names none). Why not node:http for every port (client 1.5.0's
   * first fix): inside VS Code the proxy support takes this session's
   * keep-alive agent away, so every RWS 1.0 request to a network IRC5 would
   * open a connection of its own, which fetch did not do and which has not
   * been measured on a controller (see `agent`; owner decision 2026-10-23).
   *
   * Both return the same thing, the status, headers (a WHATWG Headers, every
   * Set-Cookie line its own entry for getSetCookie()) AND the fully-read
   * body, because the timeout has to cover the body too: one time budget runs
   * until the last byte of the body has arrived, and when it runs out the
   * request fails as "Request timed out after <ms>ms: <method> <path>".
   * Until 2026-08-09 (on fetch, which resolves on the HEADERS) the timer was
   * cleared when the headers arrived, which left the body read completely
   * untimed, so a controller that sent headers and then stalled mid-body hung
   * the request forever. That is worse than it sounds: this client serialises
   * every request through one 100 ms queue, so a single hung body read stalls
   * every later request on the connection too, and no configured timeout ever
   * fires. Found by structural cell S12 (malformed/truncated responses),
   * where a body cut inside an element with the socket held open never
   * settled. Every other failure is a NETWORK_ERROR naming Node's error
   * ("Network error: connect ECONNREFUSED 127.0.0.1:7").
   *
   * The cookies of every answer but a 401 are kept here, on both paths,
   * whatever its status; a 401's go out only with the same request's next
   * attempt (see the end of this method and storeCookies).
   *
   * `holdMs` (see the public methods) is added to the timeout of this one
   * request.
   */
  private async rawFetch(
    method: string,
    path: string,
    body?: string | Uint8Array,
    holdMs = 0,
  ): Promise<RawResponse> {
    const response = this.transport === 'fetch'
      ? await this.viaFetch(method, path, body, holdMs)
      : await this.viaNodeHttp(method, path, body, holdMs);
    // The cookies of every answer but a 401 are kept, whatever its status,
    // before anything can throw. Until 2026-10-22 only a 2xx answer's were. On RW
    // 6.16.03 a request carrying an ABBCX the controller has let go of is
    // answered under a new client (Client N in its error texts), and the
    // first such answer after a drop is an error (the best-effort DELETE of
    // the old group, 400); a new ABBCX on it was thrown away. That 400 does
    // set one: the trace of the fixed run (2026-10-22, RW 6.16.03, which
    // names the cookies an answer sets, see cookieNames) shows ABBCX on it,
    // and the POST after it got 201. A 401's cookies are not the session's
    // until an answer to the same request that is not a 401 follows
    // (storeCookies): from 2026-10-22 until 1.5.1 they were kept as the
    // session's, so on a controller that sets a new -http-session- on every
    // 401, each rejected call after the first cost a third request (the
    // fresh-session attempt) and reported a replaced session. RW 6.16.03
    // sets no cookie on a 401 (its logs of 2026-09-27 and 2026-10-06).
    this.storeCookies(response.headers, response.status);
    return response;
  }

  /**
   * The headers both transports send: what the client accepts, the body's
   * type, the session's cookies, and the digest answer when there is a
   * challenge. buildAuthHeader counts the nonce use, so each request on the
   * wire builds its own. It throws for a challenge it cannot answer; that
   * error reaches the caller as it did before, and nothing is sent.
   */
  private requestHeaders(method: string, path: string, body: string | Uint8Array | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/xhtml+xml, application/json',
    };
    if (body !== undefined) {
      if (body instanceof Uint8Array) {
        headers['Content-Type'] = 'application/octet-stream';
      } else {
        // Always set Content-Type for form submissions, even with empty body (e.g. resetpp)
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    // The session's cookies, and those a 401 to this request set (a value of
    // the same name replaces the session's for this attempt).
    const cookieHeader = this.buildCookieHeader(this.challengeCookies.size > 0
      ? new Map([...this.cookies, ...this.challengeCookies]) : this.cookies);
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }
    if (this.digestChallenge) {
      // The URI in the Authorization header and HA2 computation must be the path + query,
      // NOT the full URL with scheme and host - a common implementation mistake.
      headers['Authorization'] = this.buildAuthHeader(method, path);
    }
    return headers;
  }

  /**
   * One request through Node's global fetch, as 1.4.0 sent it: the same
   * headers (fetch adds its own, such as `Accept-Encoding: gzip, deflate`,
   * and unpacks a compressed answer), redirects followed as fetch follows
   * them, and no request sent twice (a request that fails on a connection
   * fetch's pool had kept fails; undici reports UND_ERR_SOCKET, measured on
   * Node 24.19 2026-10-22). fetch resolves on the headers, so the body is read
   * here while the abort timer is STILL armed (see rawFetch); fetch's own
   * limits still apply too (undici gives up after 300 s without headers, or
   * 300 s without body bytes), so a hold longer than that ends there, as in
   * 1.4.0. The connections belong to the process's fetch pool, not to this
   * session.
   */
  private async viaFetch(
    method: string,
    path: string,
    body: string | Uint8Array | undefined,
    holdMs: number,
  ): Promise<RawResponse> {
    const headers = this.requestHeaders(method, path, body);
    const limitMs = this.timeoutFor(holdMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      // Read the body while the abort timer is STILL armed - this is the whole
      // point of the change described in rawFetch.
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text };
    } catch (e) {
      if (controller.signal.aborted || (e as Error | undefined)?.name === 'AbortError') {
        throw new RwsError(`Request timed out after ${limitMs}ms: ${method} ${path}`, 'NETWORK_ERROR');
      }
      throw fetchError(e, this.baseUrl);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One request through node:http / node:https, for a port fetch refuses
   * (see rawFetch), with the session's keep-alive agent (`agent`).
   *
   * One time budget runs from before the connection is opened until the last
   * byte of the body has arrived, a retry on a fresh connection (below)
   * included; when it runs out, the request and its socket are destroyed.
   * That budget is the only bound on this path: fetch's own limits (undici
   * gives up after 300 s without headers, or 300 s without body bytes) do not
   * apply here.
   *
   * All RWS 1.0 responses are text, read whole and decoded as UTF-8 the way
   * fetch's `res.text()` does (a leading byte order mark dropped, bad
   * sequences replaced). The request says `Accept-Encoding: identity`: an
   * uncompressed answer, please. Every answer in the 2026-09-29 RW 6.16.03
   * probe log carries `Vary: Accept-Encoding`, so the controller does read
   * the header, and a request without one would leave it free to pick any
   * encoding. fetch asks for compressed answers and unpacks them; an answer
   * compressed anyway is still unpacked here (decodeContent). fetch's other
   * headers (User-Agent: node, Accept-Language: *, Sec-Fetch-Mode: cors) are
   * not sent.
   *
   * Redirects are not followed; fetch follows them. No RWS 1.0 answer has
   * been a 3xx: none among the RWS 1.0 answers of the functional runs up to
   * 2026-10-22 (rw6.jsonl traces, through fetch) nor in the 2026-09-29 RW
   * 6.16.03 probe log, which was recorded over node:http and would show a
   * 3xx as sent. Work that moves elsewhere is answered 201 or 202 with a
   * Location header, which fetch did not follow either and which reaches the
   * caller unchanged. A 3xx reaches execute() as a status it does not
   * accept and is thrown with that status (the trace names its Location);
   * following it would also need a new digest for the new URI.
   *
   * Keep-alive: the agent reuses one connection, and a controller can close
   * it while it sits idle in the pool; the next request then fails on it at
   * once ("socket hang up", ECONNRESET), before the controller read it. The
   * RWS 2.0 transport met this in structural cell S09 and sends such a
   * request once more (see Rws2Core.req). Here a request is sent once more on
   * a new connection only when all of these hold:
   * - it is a GET, HEAD or OPTIONS. A write is never sent again: re-sending a
   *   POST could start RAPID or set an output twice;
   * - it is not a GET that changes something (NOT_REPEATABLE: a DIPC read,
   *   which takes the message it returns off the queue; /logout) and not one
   *   the controller holds on purpose (`holdMs` above 0);
   * - it failed on a REUSED connection, with a reset or hang-up, before any
   *   answer, and within STALE_WINDOW_MS (1 s) of going out. A dead pooled
   *   connection fails within a round trip. The error alone cannot tell that
   *   from a controller that read the request, worked on it and then dropped
   *   the connection; the time limit keeps a request it held, or worked on
   *   for longer, from being sent twice.
   * The retry waits for the queue's interval like any request and gets what
   * is left of the first attempt's time budget, not a new one. fetch never
   * sends a request again (viaFetch; undici fails it with UND_ERR_SOCKET,
   * measured on Node 24.19 2026-10-22). The pool's idle timeout
   * (IDLE_SOCKET_MS) keeps this case rare. Inside VS Code each request already has a connection of
   * its own (see `agent`), so the case does not arise there. The other
   * request sent on a new connection is the retry after a 503 (execute()).
   *
   * `holdMs` (see the public methods) is added to the timeout of this one
   * request.
   */
  private async viaNodeHttp(
    method: string,
    path: string,
    body: string | Uint8Array | undefined,
    holdMs: number,
  ): Promise<RawResponse> {
    const limitMs = this.timeoutFor(holdMs);
    const deadline = Date.now() + limitMs;
    let attempt = await this.sendOnce(method, path, body, limitMs, limitMs);
    if ('error' in attempt && attempt.staleSocket && HttpSession.mayResend(method, path, holdMs)) {
      // Paced like any request; the queue slot is still this request's.
      const wait = this.requestIntervalMs - (Date.now() - this.lastRequestTime);
      if (this.requestIntervalMs > 0 && wait > 0) { await sleep(wait); }
      const left = deadline - Date.now();
      if (left > 0) {
        this.lastRequestTime = Date.now();
        Logger.trace?.('http.req', `RWS1 ${method} ${path} - retrying once on a fresh connection`, {
          protocol: 'rws1', method, path,
        });
        attempt = await this.sendOnce(method, path, body, left, limitMs);
      }
    }
    if ('error' in attempt) { throw attempt.error; }
    return attempt.response;
  }

  /**
   * Destroy the idle connections the agent keeps, so the next request opens
   * a new one (the 503 retry, see execute()). A request in progress is not
   * touched: the queue sends one at a time, and this runs between two of
   * them. The agent skips a destroyed socket when it picks a free one.
   * Through fetch there is no agent, and nothing to drop.
   */
  private dropIdleConnections(): void {
    if (!this.agent) { return; }
    for (const sockets of Object.values(this.agent.freeSockets)) {
      for (const socket of sockets ?? []) { socket.destroy(); }
    }
  }

  /**
   * Whether a request that failed on a dead pooled connection may be sent
   * again: a read that changes nothing and that the controller does not hold
   * on purpose. See viaNodeHttp.
   */
  private static mayResend(method: string, path: string, holdMs: number): boolean {
    if (!HttpSession.IDEMPOTENT.has(method.toUpperCase())) { return false; }
    if (Number.isFinite(holdMs) && holdMs > 0) { return false; }
    return !HttpSession.NOT_REPEATABLE.test(path);
  }

  /**
   * One request on the wire through node:http, settled exactly once; see
   * viaNodeHttp. `budgetMs` is the time this attempt may take; `limitMs`, the
   * request's whole budget, is what a timeout names.
   */
  private sendOnce(
    method: string,
    path: string,
    body: string | Uint8Array | undefined,
    budgetMs: number,
    limitMs: number,
  ): Promise<Attempt> {
    // requestHeaders throws for a digest challenge it cannot answer; nothing
    // is sent then.
    const headers: Record<string, string> = {
      Accept: 'application/xhtml+xml, application/json',
      'Accept-Encoding': 'identity',
      ...this.requestHeaders(method, path, body),
    };

    // The body as bytes: a string is a form, sent as UTF-8 as fetch sends it.
    const payload = body === undefined ? undefined
      : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    if (payload !== undefined) {
      headers['Content-Length'] = String(payload.byteLength);
    } else if (method === 'POST' || method === 'PUT') {
      // fetch sends Content-Length: 0 for a POST or PUT without a body.
      headers['Content-Length'] = '0';
    }

    return new Promise<Attempt>((resolve) => {
      // Every way this request can end (the whole body, a socket error, the
      // connection closing mid-body, the timer) goes through settle(): the
      // promise settles once and the timer never outlives the request. The
      // 'error' listeners stay attached after that, so an error that trails
      // the end (the socket destroyed by the timer, say) is never unhandled.
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (attempt: Attempt): void => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        resolve(attempt);
      };
      const fail = (error: RwsError, staleSocket = false): void => settle({ error, staleSocket });

      let req: http.ClientRequest;
      try {
        // The same URL fetch was given: its path and query go on the wire as
        // the URL parser serialises them.
        const url = new URL(`${this.baseUrl}${path}`);
        const options: https.RequestOptions = {
          method,
          headers,
          agent: this.agent,
          // https only: certificates are checked, as fetch checked them. Set
          // on the request as well as by the agent's default, as RWS 2.0 sets
          // its TLS option: VS Code's proxy support ("override" mode) puts
          // its own agent in front of this one (see `agent`) and drops this
          // one unless the host name is exactly `localhost` or `127.0.0.1`
          // (`::1` is not one of them; @vscode/proxy-agent 0.45.0), and only
          // the request's own options survive that.
          ...(this.isHttps ? { rejectUnauthorized: true } : {}),
        };
        req = this.isHttps
          ? https.request(url, options)
          : http.request(url, options);
      } catch (e) {
        // A base URL that does not parse, or a header value Node refuses: fetch
        // rejected these as well, as a network error.
        fail(networkError(e));
        return;
      }

      timer = setTimeout(() => {
        fail(new RwsError(`Request timed out after ${limitMs}ms: ${method} ${path}`, 'NETWORK_ERROR'));
        req.destroy();
      }, budgetMs);

      // Stale only before any answer (a connection cut after the controller
      // began to answer is a failure of that answer, not of the pool), and
      // only soon after the request went out (STALE_WINDOW_MS). 'finish' is
      // when the whole request was handed to the operating system; an error
      // before it means the request never fully left.
      let answered = false;
      let sentAt: number | undefined;
      req.on('finish', () => { sentAt = Date.now(); });
      req.on('error', (e) => fail(networkError(e), req.reusedSocket && !answered && isStaleSocketError(e)
        && (sentAt === undefined || Date.now() - sentAt < HttpSession.STALE_WINDOW_MS)));
      req.on('response', (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('error', (e) => fail(networkError(e)));
        // A connection cut mid-body may end the response with no 'end' and,
        // when the peer closed cleanly, with no error either.
        res.on('close', () => {
          if (!res.complete) {
            fail(new RwsError(`Network error: the connection closed before the whole answer arrived: ${method} ${path}`, 'NETWORK_ERROR'));
          }
        });
        res.on('end', () => {
          // Nothing may throw out of an emitter listener.
          try {
            const bytes = decodeContent(Buffer.concat(chunks), res.headers['content-encoding']);
            const text = new TextDecoder('utf-8').decode(bytes);
            settle({ response: { status: res.statusCode ?? 0, headers: toHeaders(res.rawHeaders), body: text } });
          } catch (e) {
            fail(e instanceof RwsError ? e : networkError(e));
          }
        });
      });
      req.end(payload);
    });
  }

  /**
   * The timeout of one request: the instance's, plus the hold when there is
   * one (a positive, finite number of ms), capped at the longest timer delay.
   */
  private timeoutFor(holdMs: number): number {
    if (!Number.isFinite(holdMs) || holdMs <= 0) { return this.timeoutMs; }
    return Math.min(this.timeoutMs + holdMs, HttpSession.MAX_TIMER_MS);
  }

  // ─── Digest auth ────────────────────────────────────────────────────────────

  /**
   * Parse the WWW-Authenticate: Digest ... header into a DigestChallenge.
   * Handles both quoted and unquoted parameter values per RFC 2617.
   */
  private parseDigestChallenge(header: string): DigestChallenge {
    const prefix = 'Digest ';
    if (!header.toLowerCase().startsWith('digest ')) {
      throw new RwsError(`Unsupported auth scheme: "${header}"`, 'AUTH_FAILED');
    }
    const paramString = header.slice(prefix.length);

    // Match key="quoted value" or key=unquoted-value
    const paramPattern = /(\w+)=(?:"([^"]*)"|([\w.!@#$%^&*()\-_+=[\]{};:'<>,./\\?~`|]+))/g;
    const params: Record<string, string> = {};
    let m: RegExpExecArray | null;
    while ((m = paramPattern.exec(paramString)) !== null) {
      // m[2] = quoted value, m[3] = unquoted value
      params[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
    }

    if (!params['realm']) throw new RwsError('WWW-Authenticate missing realm', 'AUTH_FAILED');
    if (!params['nonce']) throw new RwsError('WWW-Authenticate missing nonce', 'AUTH_FAILED');

    return {
      realm: params['realm'],
      nonce: params['nonce'],
      opaque: params['opaque'],
      qop: params['qop'],
      algorithm: params['algorithm'] ?? 'MD5',
      stale: params['stale']?.toLowerCase() === 'true',
      domain: params['domain'],
    };
  }

  /**
   * Build the Authorization: Digest ... header value for the given request.
   * Increments the nonce use counter (nc).
   *
   * RFC 2617 §3.2.2:
   *   HA1 = MD5(username:realm:password)
   *   HA2 = MD5(method:digestURI)
   *   response = MD5(HA1:nonce:nc:cnonce:qop:HA2)  - when qop=auth
   *   response = MD5(HA1:nonce:HA2)                - RFC 2069 compat (no qop)
   *
   * Important: the space in 'Default User' is NOT percent-encoded for HA1.
   * The nc value is NOT quoted in the Authorization header.
   * The URI is path+query only, not scheme://host:port/path.
   */
  private buildAuthHeader(method: string, uri: string): string {
    const challenge = this.digestChallenge!;

    // qop may be a comma-separated list, e.g. qop="auth,auth-int". Pick auth when
    // offered; auth-int (body-hash mode) is not implemented, so an auth-int-only
    // challenge must fail loudly rather than answer with a plain-auth hash.
    let useQopAuth = false;
    if (challenge.qop) {
      const offered = challenge.qop.split(',').map((q) => q.trim());
      if (!offered.includes('auth')) {
        throw new RwsError(
          `Digest qop "${challenge.qop}" is not supported - only qop=auth`,
          'AUTH_FAILED',
        );
      }
      useQopAuth = true;
    }

    const nc = (++this.nonceCount).toString(16).padStart(8, '0');
    const cnonce = randomBytes(16).toString('hex');

    const ha1 = md5(`${this.username}:${challenge.realm}:${this.password}`);
    const ha2 = md5(`${method}:${uri}`);

    let responseHash: string;
    if (useQopAuth) {
      // RFC 2617 qop mode
      responseHash = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    } else {
      // RFC 2069 compat - no qop
      responseHash = md5(`${ha1}:${challenge.nonce}:${ha2}`);
    }

    const parts = [
      `Digest username="${this.username}"`,
      `realm="${challenge.realm}"`,
      `nonce="${challenge.nonce}"`,
      `uri="${uri}"`,
      `algorithm=MD5`,  // nc is NOT quoted
      `nc=${nc}`,
      `cnonce="${cnonce}"`,
      `response="${responseHash}"`,
    ];

    if (useQopAuth) {
      parts.push(`qop=auth`);
    }
    if (challenge.opaque) {
      parts.push(`opaque="${challenge.opaque}"`);
    }

    return parts.join(', ');
  }

  // ─── Cookie management ───────────────────────────────────────────────────────

  /**
   * Extract Set-Cookie headers from a response and store name=value pairs.
   * Uses Headers.getSetCookie() (Node 18.14.1+) to correctly handle multiple
   * Set-Cookie headers. Falls back to headers.get('set-cookie') on older Node 18,
   * though this may misparse cookie values containing commas.
   *
   * A 401's cookies are held apart (challengeCookies): they go out with the
   * same request's next attempt only, and are the session's once an answer to
   * that request is not a 401 (they are stored then, before that answer's
   * own). A 401 says the request was not taken, so a cookie on it is not yet
   * a session this client is on: it never reports a replaced session by
   * itself, and the final AUTH_FAILED drops it (execute()).
   */
  private storeCookies(headers: Headers, status: number): void {
    let setCookies: string[];

    // getSetCookie() is the WHATWG-spec method returning string[] - available Node 18.14.1+
    if (typeof (headers as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
      setCookies = (headers as { getSetCookie: () => string[] }).getSetCookie();
    } else {
      // Fallback: merge header may be comma-split incorrectly for complex cookie values,
      // but acceptable for the simple ABBCX and -http-session- cookies IRC5 sends.
      const merged = headers.get('set-cookie');
      setCookies = merged ? merged.split(/,\s*(?=[^;,]+=)/) : [];
    }

    const set: Array<[string, string]> = [];
    for (const cookie of setCookies) {
      // Only take the name=value part before the first ';'
      const [nameValue] = cookie.split(';');
      if (!nameValue) continue;
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx === -1) continue;
      const name = nameValue.slice(0, eqIdx).trim();
      const value = nameValue.slice(eqIdx + 1).trim();
      if (!name) continue;
      set.push([name, value]);
    }

    if (status === 401) {
      for (const [name, value] of set) { this.challengeCookies.set(name, value); }
      return;
    }

    const taken = [...this.challengeCookies, ...set];
    this.challengeCookies.clear();
    let replaced = false;
    for (const [name, value] of taken) {
      // A different -http-session- value names a different session. On RWS
      // 2.0 the controller issues a new one only once the old session has
      // died (live-verified 2026-08-02 on an RW 7.21 VC across a warm
      // restart). RWS 1.0 has not been observed issuing a new value on a live
      // session either, so it is read the same way here: a new session.
      const before = this.cookies.get(name);
      if (name === SESSION_COOKIE && before !== undefined && before !== value) { replaced = true; }
      this.cookies.set(name, value);
    }
    if (replaced) { this.sessionReplaced('the controller issued a new session cookie'); }
  }

  /** Tell the owner the session was replaced; its callback never breaks a request. */
  private sessionReplaced(why: string): void {
    if (!this.onSessionReplaced) { return; }
    try { this.onSessionReplaced(why); } catch (e) {
      Logger.warn(`RWS1: session-replaced handler threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private buildCookieHeader(cookies: Map<string, string> = this.cookies): string {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // ─── Session expiry ──────────────────────────────────────────────────────────

  private isSessionExpired(): boolean {
    return (
      this.lastActivityTime > 0 &&
      Date.now() - this.lastActivityTime > HttpSession.SESSION_TIMEOUT_MS
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private isOk(status: number): boolean {
    return status >= 200 && status < 300;
  }

  /**
   * Status-only fallback used when the error body carries no controller code
   * this client maps. A 403 never reaches it: the classifier explains every
   * 403 as a refusal, and one without a code it knows as `UNKNOWN` with the
   * controller's text (no cause is claimed). Credential failures throw
   * AUTH_FAILED from the digest handshake path.
   */
  private mapHttpStatus(status: number): RwsError['code'] {
    switch (status) {
      case 401:
        return 'AUTH_FAILED';
      case 404:
        return 'RESOURCE_NOT_FOUND';
      case 429:
        return 'RATE_LIMITED';
      case 503:
        return 'CONTROLLER_BUSY';
      default:
        return 'UNKNOWN';
    }
  }
}
