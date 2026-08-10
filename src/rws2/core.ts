import * as http from 'http';
import * as https from 'https';
import { randomUUID } from 'node:crypto';
import { classifyControllerError } from '../ControllerError.js';
import { HalJsonParser } from '../HalJsonParser.js';
import { Logger } from '../Logger.js';
import * as R2 from '../ResourceMapper2.js';
import type { WsSubscribeOptions } from '../WsSubscriber.js';
import { XhtmlParser } from '../XhtmlParser.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import { FILES_VISION, SYSTEM_MASTERSHIP, USERS_UAS } from '../paths/index.js';
import { redactBody } from '../redact.js';
import type {
MastershipDomain,
Signal,
SubscriptionEvent,
SubscriptionHandle,
SubscriptionResource
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

function isXhtmlOnlyPath(path: string): boolean {
  return path.startsWith('/fileservice') || path === '/logout';
}

/** Picks the parser for a response body: HAL JSON (primary GET representation)
 *  or XHTML (fallback GETs, form-POST responses). Both expose the same reads. */
export function parse(body: string): XhtmlParser | HalJsonParser {
  return HalJsonParser.looksLikeJson(body) ? new HalJsonParser(body) : new XhtmlParser(body);
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

/** Resolve the `rel="next"` pagination link (HAL or XHTML) against the current path. */
export function nextPagePath(responseBody: string, currentPath: string): string {
  const rel = HalJsonParser.looksLikeJson(responseBody)
    ? new HalJsonParser(responseBody).nextHref()
    : responseBody.match(/<a\s+href="([^"]+)"\s+rel="next"/)?.[1];
  if (!rel) { return ''; }
  return currentPath.replace(/[^/]*$/, '') + rel.replace(/&amp;/g, '&');
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
 *   properly installed certificate).
 */
export class Rws2Core {
  private lastReqTime = 0;
  private static readonly MIN_MS = 55;
  /** Tail of the pacing chain; see takeRequestSlot. */
  private reqSlot: Promise<void> = Promise.resolve();
  private readonly authHeader: string;
  private readonly httpsAgent: https.Agent;
  private readonly httpAgent: http.Agent;
  private readonly isHttps: boolean;
  /** Per-request timeout in ms (constructor `opts.timeout`, default 10000). */
  private readonly timeoutMs: number;
  /** When true, TLS certificate verification stays ON everywhere (requests, subscription POST, WebSocket). */
  private readonly rejectUnauthorized: boolean;

  /** Session cookie set by the controller on first auth - REQUIRED to avoid creating
   *  a new session per request (controller's session pool fills in seconds otherwise). */
  private sessionCookie: string | null = null;

  /** Signal name → {network, device} - populated by listAllSignals for writeSignal lookups */
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
  private readonly csName: string;
  private readonly csId: string;
  private readonly csPincode: string;

  constructor(
    private readonly baseUrl: string,
    username: string,
    password: string,
    opts: {
      timeout?: number; rejectUnauthorized?: boolean;
      /** RW8 control-station identity used when the controller requires
       *  registration for write access. Defaults: name 'abb-rws-client',
       *  a per-instance braced GUID, pincode '1234'. */
      controlStation?: { name?: string; id?: string; pincode?: string };
    } = {},
  ) {
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.isHttps = baseUrl.startsWith('https');
    this.timeoutMs = opts.timeout ?? 10000;
    this.rejectUnauthorized = opts.rejectUnauthorized ?? false;
    this.csName = opts.controlStation?.name ?? 'abb-rws-client';
    this.csId = opts.controlStation?.id ?? `{${randomUUID()}}`;
    this.csPincode = opts.controlStation?.pincode ?? '1234';
    // keepAlive reuses the TCP connection so we don't churn sessions on every poll.
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      ...(this.rejectUnauthorized ? {} : { rejectUnauthorized: false }),
    });
    this.httpAgent  = new http.Agent({ keepAlive: true });
  }

  // ─── HTTP transport ────────────────────────────────────────────────────────

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
   * server-side (a DIPC read with `dipc-timeout`, say) still cannot stall
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
   * anything was sent. RWS 1.0 does not show this because it goes through
   * undici, which retries a reused connection itself; the raw agent here does
   * not. Found by structural cell S09 (latency injection), where 500 ms of delay
   * widens the idle window enough to hit the race reliably.
   *
   * ONLY idempotent methods are retried. Re-sending a POST could execute a robot
   * command twice - starting RAPID, jogging, toggling an output - and no
   * reliability gain is worth that.
   */
  protected async req(
    method: string,
    path: string,
    body?: Record<string, string>,
    rawBody?: string,
    rawContentType?: string,
    acceptExtra: number[] = [],
    acceptOverride?: string,
  ): Promise<string> {
    await this.takeRequestSlot();
    try {
      return await this.attemptReq(method, path, body, rawBody, rawContentType, acceptExtra, acceptOverride);
    } catch (e) {
      if (!isStaleSocketError(e) || !Rws2Core.IDEMPOTENT.has(method.toUpperCase())) {
        throw e;
      }
      Logger.trace?.('http.req', `RWS2 ${method} ${path} - retrying once on a fresh connection`, {
        protocol: 'rws2', method, path,
      });
      await this.takeRequestSlot();
      return this.attemptReq(method, path, body, rawBody, rawContentType, acceptExtra, acceptOverride);
    }
  }

  private attemptReq(
    method: string,
    path: string,
    body?: Record<string, string>,
    rawBody?: string,
    rawContentType?: string,
    acceptExtra: number[] = [],
    acceptOverride?: string,
  ): Promise<string> {
    const url = new URL(path, this.baseUrl);
    const bodyStr = rawBody ?? (body ? new URLSearchParams(body).toString() : undefined);

    // RWS 2.0 requires Content-Type on all POST/PUT/DELETE requests, even with no body
    // (mastership and a few other endpoints return HTTP 406 without it).
    const writingMethod = method === 'POST' || method === 'PUT' || method === 'DELETE';
    // GETs negotiate HAL JSON; writes stay XHTML (form-POST responses are XHTML-only).
    const wantsHal = method === 'GET' && !this.preferXhtml
      && !acceptOverride && !isXhtmlOnlyPath(path);
    const accept = acceptOverride
      ?? (wantsHal ? ACCEPT_HAL : ACCEPT_XHTML);
    const options: http.RequestOptions & { agent?: https.Agent | http.Agent; rejectUnauthorized?: boolean } = {
      method,
      hostname: url.hostname,
      port: url.port ? +url.port : (this.isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        Authorization: this.authHeader,
        Accept: accept,
        ...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
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
    };

    const startedAt = Date.now();
    Logger.trace?.('http.req', `RWS2 ${method} ${path}`, {
      protocol: 'rws2', method, path,
      bodyPreview: bodyStr ? redactBody(bodyStr)!.slice(0, 200) : undefined,
    });

    return new Promise((resolve, reject) => {
      const transport = this.isHttps ? https : http;
      const req = (transport as typeof https).request(options as https.RequestOptions, res => {
        // Adopt the session cookie from EVERY response that carries one. First
        // response: without this we leak one session per request (pool fills in
        // seconds). Later responses: a controller restart kills the session and
        // Basic-authed requests mint a fresh cookie - keeping the stale one
        // makes every WS upgrade 401 forever (live-observed on RW7.21
        // 2026-08-02 across a warm restart).
        const setCookies = res.headers['set-cookie'];
        if (setCookies && setCookies.length > 0) {
          this.sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');
        }

        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const durationMs = Date.now() - startedAt;
          const status = res.statusCode ?? 0;
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
              resolve(this.req(method, path, body, rawBody, rawContentType, acceptExtra));
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
            const fallback: RwsErrorCode =
              status === 401 ? 'AUTH_FAILED' :
              status === 503 ? 'CONTROLLER_BUSY' :
              status === 429 ? 'RATE_LIMITED' :
              status === 403 ? 'GRANT_DENIED' : 'UNKNOWN';
            // Classify by the controller's own error body (mastership vs RMMP
            // vs wrong mode vs missing resource) - status alone can't tell.
            const info = classifyControllerError({ httpStatus: status, body: raw, method, path, fallback });
            reject(new RwsError(
              status === 401 ? `RWS2 ${method} ${path}: HTTP 401` : info.message,
              status === 401 ? 'AUTH_FAILED' : info.code,
              status,
              err?.msg,
              info.controllerCode ?? undefined,
              info.controllerMsg ?? undefined,
            ));
            return;
          }
          Logger.trace?.('http.res', `RWS2 ${method} ${path} → ${status} (${raw.length}b)`, { protocol: 'rws2', method, path, status, durationMs, bodyLen: raw.length });
          resolve(raw);
        });
      });
      req.on('error', (e) => {
        Logger.trace?.('http.err', `RWS2 ${method} ${path} → network error`, { protocol: 'rws2', method, path, error: String(e), durationMs: Date.now() - startedAt });
        reject(new RwsError(e instanceof Error ? e.message : String(e), 'NETWORK_ERROR'));
      });
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        Logger.trace?.('http.err', `RWS2 ${method} ${path} → timeout`, { protocol: 'rws2', method, path, durationMs: Date.now() - startedAt });
        reject(new RwsError(`RWS2 timeout: ${path}`, 'NETWORK_ERROR'));
      });
      if (bodyStr) { req.write(bodyStr); }
      req.end();
    });
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
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
  }

  async disconnect(): Promise<void> {
    // RobotWare 8 does NOT drop control-station write access when the session
    // ends. Logging out while holding it leaves the controller believing a
    // station that no longer exists still owns write access, and every other
    // client is refused with "Remote Control Station cannot take SPoC when it
    // is taken" until someone releases it. Mastership on RW7 is released by
    // /logout; this replacement is not. Live-verified 2026-08-06 on RW8.1.1.
    // (Recovery, if it ever does leak: register again with the same
    // control-station id, then release.)
    if (this.writeAccessHeld) { await this.dropWriteAccess().catch(() => {}); }
    // /logout invalidates the session server-side (frees the slot in the controller's pool).
    await this.req('GET', '/logout').catch(() => {});
    this.sessionCookie = null;
    // Registration is session-scoped - the next session must re-register.
    this.controlStationRegistered = false;
    this.writeAccessHeld = false;
    // Drop pooled keep-alive sockets so the next connect() starts clean.
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }

  /** RobotWare version string from /rw/system (e.g. '7.21.0+229', '8.1.1+614'),
   *  cached on connect. Fetches if not connected yet. */
  async getRobotWareVersion(): Promise<string> {
    if (this.rwVersionRaw) { return this.rwVersionRaw; }
    await this.connect();
    return this.rwVersionRaw ?? '';
  }

  getSessionCookie(): string | null { return this.sessionCookie; }

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
      const parts = (s['_title'] ?? '').split('/');
      if (parts.length >= 3) { this.sigCoords.set(name, { n: parts[0], d: parts[1] }); }
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
    if (!this.controlStationRegistered) {
      const { path, body } = R2.registerControlStationRemote(this.csName, this.csId, this.csPincode);
      await this.req('POST', path, body);
      this.controlStationRegistered = true;
    }
    const { path } = R2.requestWriteAccess();
    await this.req('POST', path);
    this.writeAccessHeld = true;
  }

  /**
   * True when `e` is RW8's "you already do not hold write access" refusal.
   *
   * Live-verified 2026-08-09 on OmniCore VC RW8.1.1: performing ANY write clears
   * `control-station-write-access-held` back to false while the session keeps
   * writing successfully (three consecutive speed-ratio writes after a single
   * acquire all succeed). Releasing afterwards therefore releases something the
   * controller thinks is already gone and answers
   *   403 "The control station does not have SPoC." code -1073435873 icode -20107
   * Nothing leaks - the status resource reports held=false throughout. RW7 does
   * not do this; its release after a write is a clean 204.
   */
  private static isWriteAccessAlreadyReleased(e: unknown): boolean {
    return e instanceof RwsError
      && e.httpStatus === 403
      && (e.controllerCode === -1073435873 || /does not have SPoC/i.test(e.controllerMsg ?? ''));
  }

  private async dropWriteAccess(): Promise<void> {
    const { path } = R2.releaseWriteAccess();
    try {
      await this.req('POST', path);
    } catch (e) {
      // The documented usage is acquire -> try -> release-in-finally. Throwing
      // here would surface from the finally and mask the caller's real result
      // (or its real error) for a condition that means "already released".
      if (!Rws2Core.isWriteAccessAlreadyReleased(e)) { throw e; }
      Logger.trace?.('mastership',
        'RWS2 control-station write access was already released (RW8 clears it on write)');
    }
    this.writeAccessHeld = false;
  }

  /**
   * Request mastership. On RobotWare 8 the mastership service is REMOVED
   * (/rw/mastership answers 410 GONE) and write access goes through the Control
   * Station Service instead - this method routes there automatically, keyed off
   * the version detected at connect() or a live 410, so every write method in
   * this client works unchanged on RW7 and RW8. Control-station write access is
   * global: the domain argument is ignored on the RW8 path.
   */
  async requestMastership(domain: MastershipDomain): Promise<void> {
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

  /** Release mastership; routes to control-station write-access release on RW8
   *  (see requestMastership). */
  async releaseMastership(domain: MastershipDomain): Promise<void> {
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

  /** Request mastership on ALL domains at once (RWS 2.0). Cheaper than calling
   *  per-domain. Routes to control-station write access on RW8 (already global). */
  async requestMastershipAll(): Promise<void> {
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

  /** Release mastership on ALL domains at once (RWS 2.0). Routes to
   *  control-station write-access release on RW8. */
  async releaseMastershipAll(): Promise<void> {
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
   * Request mastership on `domain` and receive a numeric ID token. Use the ID
   * with `releaseMastershipWithId()` from a different session - useful when a
   * client needs mastership to outlive the cookie that acquired it (e.g. a
   * webapp that periodically reconnects). Token-based release is the only way
   * to free a stuck mastership after session loss without a controller restart.
   */
  async requestMastershipWithId(domain: MastershipDomain): Promise<number> {
    const xhtml = await this.req('POST', buildPath(SYSTEM_MASTERSHIP.requestMastershipWithId.rws2 as PathSpec, { domain: this.rws2Domain(domain) }));
    const id = parse(xhtml).get('mastership-id');
    if (!id) { throw new RwsError('RWS2 request-with-id: no mastership-id in response', 'PARSE_ERROR'); }
    return Number(id);
  }

  /**
   * Release mastership previously acquired via `requestMastershipWithId()`.
   * Body parameter is `mastershipid` (no dash - controller-specific naming
   * confirmed via 400 "Invalid value" probing; the dash variant returns the
   * same error code as a missing value).
   */
  releaseMastershipWithId(domain: MastershipDomain, id: number): Promise<void> {
    return this.req('POST', buildPath(SYSTEM_MASTERSHIP.releaseMastershipWithId.rws2 as PathSpec, { domain: this.rws2Domain(domain) }),
      { mastershipid: String(id) }).then(() => {});
  }

  /**
   * Reset the edit-mastership watchdog (RobotWare 7.8+). The controller has a
   * heartbeat timer (default 2000 ms, configurable via `SYS/MASTER_BOOL/HeartBeat`);
   * if the holding client doesn't ping during execution, motors go off and execution
   * stops. Call this periodically (every ~1s) when holding mastership during a long
   * RAPID run. No-op on RW6.x and on configurations with `Select=false`.
   */
  resetMastershipWatchdog(): Promise<void> {
    const { path } = R2.mastershipWatchdog();
    return this.req('POST', path).then(() => {});
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
   * overridden. The id must be a braced GUID.
   */
  async registerControlStationRemote(name?: string, id?: string, pincode?: string): Promise<void> {
    const { path, body } = R2.registerControlStationRemote(
      name ?? this.csName, id ?? this.csId, pincode ?? this.csPincode);
    await this.req('POST', path, body);
    this.controlStationRegistered = true;
  }

  /** Register as the LOCAL control station (pendant side). Field from the RW8
   *  migration guide; not exercisable from a remote client without local presence. */
  async registerControlStationLocal(localPresenceKey: number): Promise<void> {
    const { path, body } = R2.registerControlStationLocal(localPresenceKey);
    await this.req('POST', path, body);
    this.controlStationRegistered = true;
  }

  /** Request write access (RW8 successor of mastership). Registers the control
   *  station first if this session has not yet. */
  requestWriteAccess(): Promise<void> { return this.acquireWriteAccess(); }

  /** Release write access. */
  releaseWriteAccess(): Promise<void> { return this.dropWriteAccess(); }

  /** Ask the current write-access holder to release; monitor
   *  getWriteAccessAppealChangeCount() and re-request when it changes. */
  async appealWriteAccessRelease(): Promise<void> {
    const { path } = R2.appealWriteAccessRelease();
    await this.req('POST', path);
  }

  /** Change count of release appeals (class ...-appeal-change-count). */
  async getWriteAccessAppealChangeCount(): Promise<number> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getWriteAccessAppealChangeCount.rws2 as PathSpec)));
    return Number(p.getState('controlstation-release-write-access-appeal-change-count')['changecount'] ?? 0);
  }

  /** Who holds write access, and whether external control is enabled. */
  async getWriteAccessStatus(): Promise<{ held: boolean; heldById: string; heldByName: string; externalControlEnabled: boolean }> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getWriteAccessStatus.rws2 as PathSpec)));
    const d = p.getState('controlstation-write-access-status');
    return {
      held:                   d['control-station-write-access-held'] === 'true',
      heldById:               d['held-by-control-station-Id'] ?? 'none',
      heldByName:             d['held-by-control-station-name'] ?? 'none',
      externalControlEnabled: d['control-station-external-control-enabled'] === 'true',
    };
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
   *  The controller spells the class 'controstation-allow-motion-control'
   *  (missing 'l' - live RW8.1.1); the corrected spelling is read as fallback. */
  async getAllowMotionControl(): Promise<boolean> {
    const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getAllowMotionControl.rws2 as PathSpec)));
    let d = p.getState('controstation-allow-motion-control');
    if (!('is-enabled' in d)) { d = p.getState('controlstation-allow-motion-control'); }
    return d['is-enabled'] === 'true';
  }

  /** Enable or disable motion control for the control station (RW8 motion gating). */
  async setAllowMotionControl(allow: boolean): Promise<void> {
    const { path, body } = R2.setAllowMotionControl(allow);
    await this.req('POST', path, body);
  }

  /** Explicitly disable external control. */
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
  private static rws2ResourcePath(r: SubscriptionResource): string | null {
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
      case 'signal':     return `/rw/iosystem/signals/${r.name};state`;
      // Symbol paths are suffix-style on RWS 2.0 (/symbol/{url}/data), not the
      // RWS 1.0 prefix form (/symbol/data/{url}). Subscribing with the RWS 1.0
      // shape answers HTTP 500 "RW-Subscription service is down".
      case 'persvar':    return `/rw/rapid/symbol/RAPID/${stripRapidDomain(r.name)}/data;value`;
      case 'taskchange': return `/rw/rapid/tasks/${r.task};taskchange`;
      default:           return null;
    }
  }

  /**
   * Map a resource URL path back to its friendly name for handleSubscriptionEvent.
   * Works with both /rw/panel/ctrlstate (RWS 1.0) and /rw/panel/ctrl-state (RWS 2.0).
   */
  static resourcePathToName(path: string): string {
    if (/\/(ctrlstate|ctrl-state)/.test(path)) { return 'controllerstate'; }
    if (/\/opmode/.test(path))                  { return 'operationmode'; }
    if (/\/speedratio/.test(path))              { return 'speedratio'; }
    if (/\/execution/.test(path) && !/execycle/.test(path)) { return 'execution'; }
    if (/\/coldetstate/.test(path))             { return 'coldetstate'; }
    if (/\/elog\//.test(path))                  { return 'elog'; }
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
   * VC RW7.21 (probe-sub-session.mjs) - POST /subscription with the existing
   * session Cookie returns 201 with NO Set-Cookie (no new session minted) and
   * the WebSocket authenticates with that same cookie. Without the Cookie the
   * controller mints one session per subscribe, and reconnect loops would burn
   * through the 5-sessions-per-IP budget.
   */
  private createSubscription(bodyStr: string): Promise<{
    wsUrl: string; deleteUrl: string; cookieStr: string;
  }> {
    return new Promise((resolve, reject) => {
      const subscriptionPath = buildPath(FILES_VISION.createSubscription.rws2 as PathSpec);
      const url = new URL(subscriptionPath, this.baseUrl);
      const encoded = Buffer.from(bodyStr);
      const options: http.RequestOptions & { agent?: https.Agent; rejectUnauthorized?: boolean } = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port ? +url.port : (this.isHttps ? 443 : 80),
        path: subscriptionPath,
        headers: {
          Authorization:  this.authHeader,
          Accept:         'application/xhtml+xml;v=2.0',
          'Content-Type': 'application/x-www-form-urlencoded;v=2.0',
          'Content-Length': String(encoded.length),
          ...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
        },
        // Per-request as well as on the agent - see req() for why (issue #2).
        ...(this.isHttps
          ? { agent: this.httpsAgent, ...(this.rejectUnauthorized ? {} : { rejectUnauthorized: false }) }
          : {}),
      };
      const transport = this.isHttps ? https : http;
      const req = (transport as typeof https).request(options as https.RequestOptions, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        // A response that never completes (connection cut mid-body - a
        // controller restart does this) must NOT hang the reconnect loop
        res.on('aborted', () => reject(new Error('RWS2 subscribe POST aborted mid-response')));
        res.on('error', (e: Error) => reject(e));
        res.on('end', () => {
          if (res.statusCode !== 201) {
            reject(new Error(`RWS2 subscribe POST returned ${res.statusCode}`));
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

          // Adopt the cookie whenever this POST carries one - same rule as
          // req(). Normally the POST rides the existing session (201, no
          // Set-Cookie); after a controller restart the old session is dead and
          // this POST mints a fresh one - the WS MUST present the fresh cookie
          // or the upgrade is rejected 401 (live-observed on RW7.21 2026-08-02).
          const setCookies = (res.headers['set-cookie'] ?? []) as string[];
          if (setCookies.length > 0) {
            this.sessionCookie = setCookies.map((c: string) => c.split(';')[0]).join('; ');
          }
          const cookieStr = this.sessionCookie ?? '';

          if (!wsUrl) { reject(new Error('RWS2 subscribe: no WebSocket URL')); return; }
          resolve({ wsUrl, deleteUrl, cookieStr });
        });
      });
      req.on('error', reject);
      // Without a timeout a half-open network stalls the reconnect loop
      // forever (no onLost, no further attempts)
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(new Error(`RWS2 subscribe POST timed out after ${this.timeoutMs} ms`));
      });
      req.write(encoded);
      req.end();
    });
  }

  /**
   * Build the `resources=N&1=<path>&1-p=<prio>&...` body shared by the create
   * POST and the in-place PUT. Returns null when nothing maps to a real path.
   *
   * Semicolons inside a resource path must stay LITERAL - percent-encoding them
   * makes the controller drop the state parameter.
   */
  private static buildSubscriptionBody(resources: SubscriptionResource[]): string | null {
    const paths = resources.map(r => Rws2Core.rws2ResourcePath(r)).filter(Boolean) as string[];
    if (paths.length === 0) { return null; }
    const parts = [`resources=${paths.length}`];
    paths.forEach((p, i) => {
      parts.push(`${i + 1}=${p}&${i + 1}-p=1`);
    });
    return parts.join('&');
  }

  async subscribe(
    resources: SubscriptionResource[],
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
    const bodyStr = Rws2Core.buildSubscriptionBody(resources);
    if (bodyStr === null) {
      // Nothing subscribable was asked for: hand back an inert handle with no
      // group, rather than failing - same behaviour as before, richer type.
      const noop = async (): Promise<void> => {};
      return Object.defineProperty(noop, 'groupPath', {
        value: '', enumerable: true,
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
    };

    // Best-effort removal of a subscription group (DELETE /subscription/{id}).
    // Groups live as long as the session that owns them, and the session is the
    // client's main one - orphaned groups would pile up on every reconnect.
    const dropGroup = (path: string): Promise<void> =>
      path ? this.req('DELETE', path).then(() => {}, () => {}) : Promise.resolve();

    // The subscription rides the main HTTP session (see createSubscription), so a
    // dropped WebSocket does NOT invalidate the group - but its poll URL is spent.
    // Every (re)connect drops the previous group, then POSTs a fresh /subscription
    // on the same session; no extra sessions are ever minted.
    const open = async (): Promise<void> => {
      if (conn.deleteUrl) {
        await dropGroup(conn.deleteUrl);
        conn.deleteUrl = '';
      }
      const { wsUrl: advertisedUrl, deleteUrl, cookieStr } = await this.createSubscription(bodyStr);
      conn.deleteUrl = deleteUrl;

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

      // 2. Open WebSocket and wait for confirmation it actually connected.
      //    Auth: Cookie from subscription response (NOT Authorization header).
      //    Subprotocol: "rws_subscription" - the RWS 2.0 name. Live-verified 2026-07-08
      //    on OmniCore VC RW7.21: "robapi2_subscription" (the RWS 1.0 name) is rejected
      //    with HTTP 400; "rws_subscription" upgrades with 101.
      const ws = new WsImpl(wsUrl, ['rws_subscription'], {
        ...(this.rejectUnauthorized ? {} : { rejectUnauthorized: false }),
        headers: { Cookie: cookieStr },
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
          res.on('data', (c: Buffer) => chunks.push(c));
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
      //        instead of looking broken.
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

          const liPat = /<li[^>]*>([\s\S]*?)<\/li>/gi;
          let m: RegExpExecArray | null;
          while ((m = liPat.exec(raw)) !== null) {
            const block = m[1];
            const hrefM = block.match(/<a[^>]*href="([^"]+)"/i);
            const spanM = block.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
            if (!hrefM || !spanM) { continue; }
            handler({
              resource:  Rws2Core.resourcePathToName(hrefM[1]),
              value:     spanM[1].trim(),
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
    // Reconnects mint a new group, so read it live rather than snapshotting.
    Object.defineProperty(stop, 'groupPath', {
      get: () => conn.deleteUrl,
      enumerable: true,
    });
    return stop as SubscriptionHandle;
  }

  // ─── Remote Mastership Privilege (RMMP) ────────────────────────────────────────
  // ABB safety: RWS users cannot send "modify" operations (jog, RAPID variable writes,
  // etc.) until they have RMMP. Requesting it triggers a FlexPendant popup that an
  // interactive operator must approve. After approval, the privilege persists for
  // the session.

  /**
   * Effective RMMP privilege held by THIS session.
   * The controller's /users/rmmp returns whoever currently holds the privilege -
   * we have to check `rmmpheldbyme` to know whether it's us or some other user.
   * Returns 'none' if another user holds it (we'd need to re-request for our own session).
   */
  async getRmmpPrivilege(): Promise<string> {
    let xml: string;
    try {
      xml = await this.req('GET', buildPath(USERS_UAS.getRmmpPrivilege.rws2 as PathSpec));
    } catch (e) {
      // The whole RMMP service answers HTTP 500 on RobotWare 8.1.1 (GET, POST
      // and poll alike - live-verified 2026-08 against RW8.1.1 vs a working
      // RW7.21). Report "no privilege held" rather than surfacing a raw 500 to
      // every caller that merely polls this.
      if (e instanceof RwsError && e.httpStatus === 500) { return 'none'; }
      throw e;
    }
    const p = parse(xml);
    const priv     = p.get('privilege') ?? 'none';
    const heldByMe = (p.get('rmmpheldbyme') ?? 'false').toLowerCase() === 'true';
    if (priv === 'none') { return 'none'; }
    if (priv.startsWith('pending')) { return priv; }
    return heldByMe ? priv : 'none';
  }

  /** Request 'modify' privilege. Triggers a FlexPendant approval popup.
   *  On RobotWare 8.1.1 the RMMP service is broken (every verb answers HTTP
   *  500), so this reports UNSUPPORTED_OPERATION there instead of a bare 500. */
  async requestRmmp(level: 'modify' | 'exclusive' = 'modify'): Promise<void> {
    try {
      await this.req('POST', buildPath(USERS_UAS.requestRmmp.rws2 as PathSpec), { privilege: level });
    } catch (e) {
      if (e instanceof RwsError && e.httpStatus === 500) {
        throw new RwsError(
          'requestRmmp: the controller\'s RMMP service returned HTTP 500. RobotWare 8.1.1 ships with this service broken (all RMMP verbs fail); use the FlexPendant to grant privileges there.',
          'UNSUPPORTED_OPERATION', 500,
        );
      }
      throw e;
    }
  }

  /** Info about the logged-in user session (uas-id, user-name, locale,
   *  application). Live-verified 2026-08-04 (RW7.21), class user-login-info. */
  async getLoginInfo(): Promise<Record<string, string>> {
    const p = parse(await this.req('GET', buildPath(USERS_UAS.getLoginInfo.rws2 as PathSpec)));
    return p.getState('user-login-info');
  }

  /** Whether the logged-in user holds a UAS grant. Pre-check before an
   *  operation that would 403. Live-verified 2026-08-04 (RW7.21). */
  async checkGrantExists(grant: string): Promise<boolean> {
    const p = parse(await this.req('GET', `${buildPath(USERS_UAS.checkGrantExists.rws2 as PathSpec)}?grant=${encodeURIComponent(grant)}`));
    return p.getState('user-grant-status')['status'] === 'true';
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

  /** Monotonic counter required by /rw/motionsystem/jog (controller rejects same value twice). */
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
  // Evidence and per-endpoint status: docs/tasks/endpoint-completion.md.









































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
   * @param groupPath the group resource, e.g. `/subscription/2` - take it from
   *   the `groupPath` on the handle `subscribe()` returned. NOT the
   *   `wss://.../poll/{id}` URL, which is not an HTTP resource at all (404).
   * @returns the raw XHTML initial-event payload for the added resources.
   */
  async updateSubscriptionGroup(
    groupPath: string, resources: SubscriptionResource[],
  ): Promise<string> {
    const bodyStr = Rws2Core.buildSubscriptionBody(resources);
    if (bodyStr === null) {
      throw new RwsError(
        'updateSubscriptionGroup needs at least one resource that maps to a path',
        'INVALID_ARGUMENT',
      );
    }
    return this.req(
      'PUT', groupPath, undefined, bodyStr,
      'application/x-www-form-urlencoded;v=2.0',
    );
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
   */
  async unsubscribeResource(
    groupPath: string, resource: SubscriptionResource,
  ): Promise<void> {
    const mapped = Rws2Core.rws2ResourcePath(resource);
    if (!mapped) {
      throw new RwsError(
        `unsubscribeResource: ${JSON.stringify(resource)} maps to no RWS 2.0 path`,
        'INVALID_ARGUMENT',
      );
    }
    await this.req('DELETE', `${groupPath}${mapped}`);
  }

}
