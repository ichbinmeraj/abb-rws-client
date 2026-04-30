/**
 * HttpSession — HTTP communication layer for ABB IRC5 controllers.
 *
 * Features:
 * - HTTP Digest Authentication (RFC 2617) implemented from scratch using node:crypto
 * - ABBCX + -http-session- cookie management
 * - Request queue enforcing minimum interval between requests (<20 req/sec RWS limit)
 * - Automatic re-authentication on session expiry (5-minute inactivity)
 * - 401 retry with fresh digest handshake; 503 retry with 200ms backoff
 * - AbortController-based timeout
 *
 * Uses Node 18+ built-in fetch and node:crypto. Zero external dependencies.
 */

import { createHash, randomBytes } from 'node:crypto';
import { RwsError } from './types.js';
import type { DigestChallenge, HttpResponse } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── HttpSession options ─────────────────────────────────────────────────────

export interface HttpSessionOptions {
  baseUrl: string;
  username: string;
  password: string;
  requestIntervalMs: number;
  timeoutMs: number;
  /** Pre-load a saved -http-session- cookie to reuse an existing controller session slot */
  sessionCookie?: string;
}

// ─── HttpSession ─────────────────────────────────────────────────────────────

export class HttpSession {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly requestIntervalMs: number;
  private readonly timeoutMs: number;

  /** Stored session cookies: '-http-session-' and 'ABBCX' */
  private cookies: Map<string, string> = new Map();

  /** Last parsed digest challenge from WWW-Authenticate */
  private digestChallenge: DigestChallenge | null = null;

  /** Nonce use counter — reset to 0 whenever a new nonce is received */
  private nonceCount = 0;

  /** Timestamp of the most recent request sent */
  private lastRequestTime = 0;

  /** Timestamp of the most recent successful response — used for session expiry */
  private lastActivityTime = 0;

  /** Promise chain that serialises all outbound requests */
  private requestQueue: Promise<void> = Promise.resolve();

  /** 5-minute session inactivity timeout (milliseconds) */
  private static readonly SESSION_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(options: HttpSessionOptions) {
    this.baseUrl = options.baseUrl;
    this.username = options.username;
    this.password = options.password;
    this.requestIntervalMs = options.requestIntervalMs;
    this.timeoutMs = options.timeoutMs;
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

  get(path: string): Promise<HttpResponse> {
    return this.enqueue(() => this.execute('GET', path));
  }

  post(path: string, body?: string): Promise<HttpResponse> {
    return this.enqueue(() => this.execute('POST', path, body));
  }

  put(path: string, body: string | Uint8Array): Promise<HttpResponse> {
    return this.enqueue(() => this.execute('PUT', path, body));
  }

  delete(path: string): Promise<HttpResponse> {
    return this.enqueue(() => this.execute('DELETE', path));
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

  // ─── Request queue ──────────────────────────────────────────────────────────

  /**
   * Append a function to the serial request queue, enforcing the minimum interval
   * between requests. Error suppression on `this.requestQueue` (not on `result`)
   * ensures queue continues processing even when individual requests fail.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
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
  ): Promise<HttpResponse> {
    // Auto re-authenticate if the session may have expired.
    // Only clear digest auth state — keep the session cookie so the controller
    // reuses the same session slot instead of creating a new one.
    if (this.isSessionExpired()) {
      this.digestChallenge = null;
      this.nonceCount = 0;
    }

    let response = await this.rawFetch(method, path, body);

    // 401 → perform digest handshake then retry once
    if (response.status === 401) {
      const wwwAuth = response.headers.get('www-authenticate');
      if (!wwwAuth) {
        throw new RwsError('401 without WWW-Authenticate header', 'AUTH_FAILED', 401);
      }
      this.digestChallenge = this.parseDigestChallenge(wwwAuth);
      this.nonceCount = 0;

      response = await this.rawFetch(method, path, body);

      if (response.status === 401) {
        // Second 401 — credentials are wrong
        throw new RwsError('Authentication failed — check username and password', 'AUTH_FAILED', 401);
      }
    }

    // 503 → wait 200ms and retry once
    if (response.status === 503) {
      await sleep(200);
      response = await this.rawFetch(method, path, body);
      if (response.status === 503) {
        throw new RwsError('Controller busy (503) — retry later', 'CONTROLLER_BUSY', 503);
      }
    }

    if (!this.isOk(response.status)) {
      const bodyText = await response.text().catch(() => '');
      throw new RwsError(
        `HTTP ${response.status} from ${method} ${path}`,
        this.mapHttpStatus(response.status),
        response.status,
        bodyText,
      );
    }

    // Store cookies from response
    this.storeCookies(response.headers);
    this.lastActivityTime = Date.now();

    const bodyText = await response.text().catch(() => '');
    return { status: response.status, body: bodyText, headers: response.headers };
  }

  /** Issue a single HTTP request with digest auth header if we have a challenge */
  private async rawFetch(
    method: string,
    path: string,
    body?: string | Uint8Array,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

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

    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    if (this.digestChallenge) {
      // The URI in the Authorization header and HA2 computation must be the path + query,
      // NOT the full URL with scheme and host — a common implementation mistake.
      headers['Authorization'] = this.buildAuthHeader(method, path);
    }

    try {
      return await fetch(url, {
        method,
        headers,
        body: body !== undefined ? body : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new RwsError(`Request timed out after ${this.timeoutMs}ms: ${method} ${path}`, 'NETWORK_ERROR');
      }
      throw new RwsError(`Network error: ${String(e)}`, 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
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
   *   response = MD5(HA1:nonce:nc:cnonce:qop:HA2)  — when qop=auth
   *   response = MD5(HA1:nonce:HA2)                — RFC 2069 compat (no qop)
   *
   * Important: the space in 'Default User' is NOT percent-encoded for HA1.
   * The nc value is NOT quoted in the Authorization header.
   * The URI is path+query only, not scheme://host:port/path.
   */
  private buildAuthHeader(method: string, uri: string): string {
    const challenge = this.digestChallenge!;
    const nc = (++this.nonceCount).toString(16).padStart(8, '0');
    const cnonce = randomBytes(16).toString('hex');

    const ha1 = md5(`${this.username}:${challenge.realm}:${this.password}`);
    const ha2 = md5(`${method}:${uri}`);

    let responseHash: string;
    if (challenge.qop === 'auth' || challenge.qop === 'auth-int') {
      // RFC 2617 qop mode
      responseHash = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    } else {
      // RFC 2069 compat — no qop
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

    if (challenge.qop) {
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
   */
  private storeCookies(headers: Headers): void {
    let setCookies: string[];

    // getSetCookie() is the WHATWG-spec method returning string[] — available Node 18.14.1+
    if (typeof (headers as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
      setCookies = (headers as { getSetCookie: () => string[] }).getSetCookie();
    } else {
      // Fallback: merge header may be comma-split incorrectly for complex cookie values,
      // but acceptable for the simple ABBCX and -http-session- cookies IRC5 sends.
      const merged = headers.get('set-cookie');
      setCookies = merged ? merged.split(/,\s*(?=[^;,]+=)/) : [];
    }

    for (const cookie of setCookies) {
      // Only take the name=value part before the first ';'
      const [nameValue] = cookie.split(';');
      if (!nameValue) continue;
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx === -1) continue;
      const name = nameValue.slice(0, eqIdx).trim();
      const value = nameValue.slice(eqIdx + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  private buildCookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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

  private mapHttpStatus(status: number): RwsError['code'] {
    switch (status) {
      case 401:
      case 403:
        return 'AUTH_FAILED';
      case 404:
        return 'MODULE_NOT_FOUND';
      case 429:
        return 'RATE_LIMITED';
      case 503:
        return 'CONTROLLER_BUSY';
      default:
        return 'UNKNOWN';
    }
  }
}
