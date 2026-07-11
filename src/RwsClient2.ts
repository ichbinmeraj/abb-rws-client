import * as https from 'https';
import * as http from 'http';
import { XhtmlParser } from './XhtmlParser.js';
import { HalJsonParser } from './HalJsonParser.js';
import { Logger } from './Logger.js';
import { RwsError, type RwsErrorCode } from './types.js';
import type {
  ControllerState, OperationMode, ExecutionState, ExecutionCycle,
  ExecutionInfo, CollisionDetectionState, RapidTask, JointTarget,
  CartesianFull, RobTarget, SystemInfo, ControllerIdentity, ControllerClock,
  ElogMessage, Signal, IoNetwork, IoDevice, FileEntry,
  RapidSymbolProperties, RapidSymbolInfo, RapidSymbolSearchParams,
  UiInstruction, RestartMode, MastershipDomain,
  SubscriptionResource, SubscriptionEvent,
} from './types.js';

/**
 * RWS 2.0 protocol client for ABB OmniCore controllers (RobotWare 7.x).
 *
 * Companion to `RwsClient` (RWS 1.0 / IRC5 / RobotWare 6.x). If you don't know
 * which protocol your controller uses, prefer `createClient(host)` from this
 * package — it probes the auth challenge and returns the right client.
 *
 * Key differences vs RWS 1.0 (all confirmed by live virtual-controller probing):
 * - HTTP Basic auth instead of Digest
 * - Path-based actions: /rw/rapid/execution/stop (not ?action=stop)
 * - GETs are negotiated as HAL JSON (Accept: application/hal+json;v=2.0 —
 *   live-verified 2026-07-09 on RW7.21 for every GET family) with an automatic
 *   per-instance fallback to application/xhtml+xml;v=2.0 for older RW7
 *   releases; form-POST responses and subscription events are XHTML-only
 * - Mastership domains: 'edit' replaces both 'cfg' and 'rapid'
 * - FileService home: 'HOME' not '$HOME'
 * - Self-signed TLS on all shipping controllers → verification is OFF by default;
 *   pass `{ rejectUnauthorized: true }` to keep it on (e.g. controllers with a
 *   properly installed certificate).
 */
export class RwsClient2 {
  private lastReqTime = 0;
  private static readonly MIN_MS = 55;
  private readonly authHeader: string;
  private readonly httpsAgent: https.Agent;
  private readonly httpAgent: http.Agent;
  private readonly isHttps: boolean;
  /** Per-request timeout in ms (constructor `opts.timeout`, default 10000). */
  private readonly timeoutMs: number;
  /** When true, TLS certificate verification stays ON everywhere (requests, subscription POST, WebSocket). */
  private readonly rejectUnauthorized: boolean;

  /** Session cookie set by the controller on first auth — REQUIRED to avoid creating
   *  a new session per request (controller's session pool fills in seconds otherwise). */
  private sessionCookie: string | null = null;

  /** Signal name → {network, device} — populated by listAllSignals for writeSignal lookups */
  private readonly sigCoords = new Map<string, { n: string; d: string }>();

  constructor(
    private readonly baseUrl: string,
    username: string,
    password: string,
    opts: { timeout?: number; rejectUnauthorized?: boolean } = {},
  ) {
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.isHttps = baseUrl.startsWith('https');
    this.timeoutMs = opts.timeout ?? 10000;
    this.rejectUnauthorized = opts.rejectUnauthorized ?? false;
    // keepAlive reuses the TCP connection so we don't churn sessions on every poll.
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      ...(this.rejectUnauthorized ? {} : { rejectUnauthorized: false }),
    });
    this.httpAgent  = new http.Agent({ keepAlive: true });
  }

  // ─── HTTP transport ────────────────────────────────────────────────────────

  /** Primary GET representation. Officially supported on RWS 2.0; live-verified
   *  2026-07-09 on OmniCore VC RW7.21 for every GET endpoint family in this client. */
  private static readonly ACCEPT_HAL = 'application/hal+json;v=2.0';
  /** Representation for writes, fileservice, subscriptions, and the fallback GET path. */
  private static readonly ACCEPT_XHTML = 'application/xhtml+xml;v=2.0';

  /** Set once a controller rejects hal+json (HTTP 406 or a non-JSON reply to a
   *  hal+json GET) — older RW7 releases predate HAL JSON. All subsequent GETs on
   *  this instance then go straight to XHTML instead of re-negotiating each time. */
  private preferXhtml = false;

  /** GET paths that must keep the XHTML Accept: fileservice serves raw file bytes
   *  (a content-type-based negotiation retry would double every file read, and the
   *  service rejects some Accept values), and /logout's body is ignored anyway. */
  private static isXhtmlOnlyPath(path: string): boolean {
    return path.startsWith('/fileservice') || path === '/logout';
  }

  /** Picks the parser for a response body: HAL JSON (primary GET representation)
   *  or XHTML (fallback GETs, form-POST responses). Both expose the same reads. */
  private static parse(body: string): XhtmlParser | HalJsonParser {
    return HalJsonParser.looksLikeJson(body) ? new HalJsonParser(body) : new XhtmlParser(body);
  }

  /** Error block from either representation (JSON status.code/msg or XHTML spans). */
  private static extractError(body: string): { code: string; msg: string } | null {
    return RwsClient2.parse(body).getError();
  }

  /**
   * Core HTTP request. acceptExtra lists additional success status codes beyond 200/204.
   * Used by subscribe() to accept HTTP 201 (Created) from POST /subscription.
   * acceptOverride pins the Accept header for callers that must not negotiate
   * (e.g. getDeviceTree, which promises a raw XHTML document).
   */
  private async req(
    method: string,
    path: string,
    body?: Record<string, string>,
    rawBody?: string,
    rawContentType?: string,
    acceptExtra: number[] = [],
    acceptOverride?: string,
  ): Promise<string> {
    const wait = RwsClient2.MIN_MS - (Date.now() - this.lastReqTime);
    if (wait > 0) { await new Promise(r => setTimeout(r, wait)); }
    this.lastReqTime = Date.now();

    const url = new URL(path, this.baseUrl);
    const bodyStr = rawBody ?? (body ? new URLSearchParams(body).toString() : undefined);

    // RWS 2.0 requires Content-Type on all POST/PUT/DELETE requests, even with no body
    // (mastership and a few other endpoints return HTTP 406 without it).
    const writingMethod = method === 'POST' || method === 'PUT' || method === 'DELETE';
    // GETs negotiate HAL JSON; writes stay XHTML (form-POST responses are XHTML-only).
    const wantsHal = method === 'GET' && !this.preferXhtml
      && !acceptOverride && !RwsClient2.isXhtmlOnlyPath(path);
    const accept = acceptOverride
      ?? (wantsHal ? RwsClient2.ACCEPT_HAL : RwsClient2.ACCEPT_XHTML);
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
      bodyPreview: bodyStr ? bodyStr.slice(0, 200) : undefined,
    });

    return new Promise((resolve, reject) => {
      const transport = this.isHttps ? https : http;
      const req = (transport as typeof https).request(options as https.RequestOptions, res => {
        // Capture session cookie on first response (controller assigns it on first auth).
        // Without this we leak one session per request → controller pool fills in seconds.
        const setCookies = res.headers['set-cookie'];
        if (setCookies && setCookies.length > 0 && !this.sessionCookie) {
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
              Logger.trace?.('http.res', `RWS2 ${method} ${path} → ${status} (hal+json not served — falling back to XHTML for this client)`, {
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
            const err = RwsClient2.extractError(raw);
            Logger.trace?.('http.err', `RWS2 ${method} ${path} → ${status}`, { protocol: 'rws2', method, path, status, durationMs, errCode: err?.code, errMsg: err?.msg, bodyPreview: raw.slice(0, 300) });
            const code: RwsErrorCode =
              status === 401 ? 'AUTH_FAILED' :
              status === 503 ? 'CONTROLLER_BUSY' :
              status === 429 ? 'RATE_LIMITED' : 'UNKNOWN';
            reject(new RwsError(
              `RWS2 ${method} ${path}: HTTP ${status}` +
              (err ? ` — ${err.msg}` : ''),
              code, status, err?.msg
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

  async connect(): Promise<void> { await this.req('GET', '/rw/system'); }

  async disconnect(): Promise<void> {
    // /logout invalidates the session server-side (frees the slot in the controller's pool).
    await this.req('GET', '/logout').catch(() => {});
    this.sessionCookie = null;
    // Drop pooled keep-alive sockets so the next connect() starts clean.
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }

  getSessionCookie(): string | null { return this.sessionCookie; }

  // ─── Panel ─────────────────────────────────────────────────────────────────

  async getControllerState(): Promise<ControllerState> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/panel/ctrl-state'));
    return (p.getState('pnl-ctrlstate')['ctrlstate'] ?? 'init') as ControllerState;
  }

  setControllerState(state: 'motoron' | 'motoroff'): Promise<void> {
    return this.req('POST', '/rw/panel/ctrl-state', { 'ctrl-state': state }).then(() => {});
  }

  async getOperationMode(): Promise<OperationMode> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/panel/opmode'));
    return (p.getState('pnl-opmode')['opmode'] ?? 'MANR') as OperationMode;
  }

  async getSpeedRatio(): Promise<number> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/panel/speedratio'));
    return Number(p.getState('pnl-speedratio')['speedratio'] ?? 100);
  }

  /**
   * Set the speed ratio (0-100). Live-verified format on OmniCore VC RW7.21
   * via scripts/probe-speedratio.js (2026-05-07):
   *   ✓ POST /rw/panel/speedratio?action=setspeedratio  body speed-ratio=N
   *     (RWS 1.0 wire format — OmniCore kept the legacy path)
   *     Requires `edit` mastership: 403 "user does not have required
   *     mastership" without it.
   *   ✗ POST /rw/panel/speedratio  body speedratio=N  → 400 "Invalid input form data"
   *   ✗ POST /rw/panel/speedratio/set                 → 404 (path doesn't exist)
   *
   * Acquires `edit` mastership internally and releases it after.
   */
  async setSpeedRatio(ratio: number): Promise<void> {
    const v = Math.round(Math.max(0, Math.min(100, ratio)));
    await this.requestMastership('rapid');   // 'rapid' is renamed to 'edit' internally
    try {
      await this.req('POST', '/rw/panel/speedratio?action=setspeedratio', { 'speed-ratio': String(v) });
    } finally {
      await this.releaseMastership('rapid').catch(() => {});
    }
  }

  async getCollisionDetectionState(): Promise<CollisionDetectionState> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/panel/coldetstate'));
    return (p.getState('pnl-coldetstate')['coldetstate'] ?? 'INIT') as CollisionDetectionState;
  }

  lockOperationMode(pin: string, permanent = false): Promise<void> {
    // POST /rw/panel/opmode/lock with pin and permanent flag
    return this.req('POST', '/rw/panel/opmode/lock', {
      pin,
      permanent: permanent ? '1' : '0',
    }).then(() => {});
  }

  unlockOperationMode(): Promise<void> {
    return this.req('POST', '/rw/panel/opmode/unlock').then(() => {});
  }

  /**
   * Switch the controller's operation mode. **Virtual controllers only** —
   * real hardware respects the FlexPendant key switch.
   *
   * Endpoint + wire format — ALL live-verified on OmniCore VC RW7.x via
   * scripts/probe-opmode-write.js (2026-05-07):
   *   ✓ POST /rw/panel/opmode  body opmode=auto  → AUTO (200 OK)
   *   ✓ POST /rw/panel/opmode  body opmode=man   → MANR (200 OK)
   *   ✓ POST /rw/panel/opmode  body opmode=manf  → MANF (200 OK) — NOTE: `manf`,
   *      NOT `manfs` as RWS 1.0 uses. RWS 2.0 dropped the 's'.
   *   ✗ POST /rw/panel/opmode/set                → 404 (path doesn't exist)
   *   ✗ POST /rw/panel/opmode  body opmode=AUTO  → 400 invalid value
   *   ✗ POST /rw/panel/opmode  body opmode=manr  → 400 invalid value
   *
   * The wire value is lowercase and uses the RWS 1.0 abbreviations *except*
   * for MANF (`manf` on RWS 2.0 vs `manfs` on RWS 1.0). And NEITHER matches
   * the GET-response casing (`AUTO`/`MANR`/`MANF`). This asymmetry is one
   * of the documented protocol quirks of RWS 2.0.
   *
   * Side note: the controller pops up a confirmation dialog on the FlexPendant
   * after the call returns 200 OK; the operator must approve before the mode
   * actually flips. There is no API path to bypass this — UAS-grant changes
   * are FlexPendant-only by design.
   */
  setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void> {
    const wire = mode === 'AUTO' ? 'auto' : mode === 'MANR' ? 'man' : 'manf';
    return this.req('POST', '/rw/panel/opmode', { opmode: wire }).then(() => {});
  }

  // ─── RAPID execution ────────────────────────────────────────────────────────

  async getRapidExecutionState(): Promise<ExecutionState> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/rapid/execution'));
    return (p.getState('rap-execution')['ctrlexecstate'] ?? 'stopped') as ExecutionState;
  }

  async getRapidExecutionInfo(): Promise<ExecutionInfo> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/rapid/execution'));
    // Live: <li class="rap-execution"><span class="ctrlexecstate">stopped</span><span class="cycle">forever</span>
    const d = p.getState('rap-execution');
    return {
      state: (d['ctrlexecstate'] ?? 'stopped') as ExecutionState,
      cycle: d['cycle'] ?? 'asis',
    };
  }

  startRapid(): Promise<void> {
    return this.req('POST', '/rw/rapid/execution/start', {
      regain: 'continue', execmode: 'continue', cycle: 'asis',
      condition: 'none', stopatbp: 'disabled', alltaskbytsp: 'false',
    }).then(() => {});
  }

  stopRapid(): Promise<void> {
    return this.req('POST', '/rw/rapid/execution/stop', { stopmode: 'stop' }).then(() => {});
  }

  resetRapid(): Promise<void> {
    return this.req('POST', '/rw/rapid/execution/resetpp').then(() => {});
  }

  setExecutionCycle(cycle: ExecutionCycle): Promise<void> {
    return this.req('POST', '/rw/rapid/execution/cycle', { cycle }).then(() => {});
  }

  async getRapidTasks(): Promise<RapidTask[]> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/rapid/tasks'));
    return p.getAllStates('rap-task-li').map(t => ({
      name:       t['name'] ?? '',
      type:       t['type'] ?? 'normal',
      taskstate:  t['taskstate'] ?? '',
      excstate:   (t['excstate'] === 'running' ? 'running' : 'stopped') as ExecutionState,
      active:     t['active'] === 'On' || t['active'] === 'true',
      motiontask: t['motiontask'] === 'TRUE' || t['motiontask'] === 'True',
    }));
  }

  async activateRapidTask(task: string): Promise<void> {
    await this.requestMastership('rapid');
    try {
      await this.req('POST', '/rw/rapid/tasks/activate', { task });
    } finally {
      await this.releaseMastership('rapid').catch(() => {});
    }
  }

  async deactivateRapidTask(task: string): Promise<void> {
    await this.requestMastership('rapid');
    try {
      await this.req('POST', '/rw/rapid/tasks/deactivate', { task });
    } finally {
      await this.releaseMastership('rapid').catch(() => {});
    }
  }

  async activateAllRapidTasks(): Promise<void> {
    // Get task list then activate each
    const tasks = await this.getRapidTasks();
    await this.requestMastership('rapid');
    try {
      for (const t of tasks) {
        await this.req('POST', '/rw/rapid/tasks/activate', { task: t.name }).catch(() => {});
      }
    } finally {
      await this.releaseMastership('rapid').catch(() => {});
    }
  }

  async deactivateAllRapidTasks(): Promise<void> {
    const tasks = await this.getRapidTasks();
    await this.requestMastership('rapid');
    try {
      for (const t of tasks) {
        await this.req('POST', '/rw/rapid/tasks/deactivate', { task: t.name }).catch(() => {});
      }
    } finally {
      await this.releaseMastership('rapid').catch(() => {});
    }
  }

  // ─── RAPID modules & variables ──────────────────────────────────────────────

  async listModules(task: string): Promise<string[]> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/modules`));
    return p.getAllStates('rap-module-info-li').map(m => m['name']).filter(Boolean) as string[];
  }

  /**
   * Returns each loaded module's name + type (SysMod | ProgMod | …).
   * Single round-trip — same endpoint as `listModules` but exposes more fields.
   */
  async listModulesDetailed(task: string): Promise<Array<{ name: string; type: string }>> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/modules`));
    return p.getAllStates('rap-module-info-li')
      .map(m => ({ name: m['name'] ?? '', type: m['type'] ?? '' }))
      .filter(m => m.name);
  }

  async loadModule(task: string, path: string, replace = false): Promise<void> {
    // RWS 2.0 module-load endpoint: POST /rw/rapid/tasks/{task}/loadmod with `modulepath`.
    // (The /program/load endpoint is for full multi-module .pgf programs and uses a different
    // "virtual root" path scheme that doesn't accept user-uploaded HOME/* files.)
    //
    // The path needs to be in fileservice form WITHOUT the leading `$` — translate
    // `$HOME/...` → `HOME/...` so the same code works for callers passing either format.
    const modulePath = path.replace(/^\$HOME\//, 'HOME/').replace(/^\$/, '');
    const body: Record<string, string> = { modulepath: modulePath };
    if (replace) { body['replace'] = 'true'; }
    await this.req('POST', `/rw/rapid/tasks/${task}/loadmod`, body);
  }

  unloadModule(task: string, name: string): Promise<void> {
    // RWS 2.0 unload is path-based action: POST /rw/rapid/tasks/{task}/unloadmod
    // (DELETE on the module URL returns 405; only POST + body works.)
    return this.req('POST', `/rw/rapid/tasks/${task}/unloadmod`, { module: name }).then(() => {});
  }

  async getRapidVariable(task: string, module: string, symbol: string): Promise<string> {
    // RWS 2.0 symbol API: suffix-style — /rw/rapid/symbol/{symburl}/data
    // (RWS 1.0 puts /data at the front: /rw/rapid/symbol/data/{symburl})
    const p = RwsClient2.parse(
      await this.req('GET', `/rw/rapid/symbol/RAPID/${task}/${module}/${symbol}/data`)
    );
    return p.get('value') ?? '';
  }

  setRapidVariable(task: string, module: string, symbol: string, value: string): Promise<void> {
    return this.req('POST', `/rw/rapid/symbol/RAPID/${task}/${module}/${symbol}/data`, { value }).then(() => {});
  }

  async validateRapidValue(task: string, value: string, datatype: string): Promise<boolean> {
    // RWS 2.0: endpoint path differs — use per-task validate
    try {
      await this.req('POST', `/rw/rapid/symbol/RAPID/${task}/data?action=validate`, {
        value, dattyp: datatype,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getRapidSymbolProperties(task: string, module: string, symbol: string): Promise<RapidSymbolProperties> {
    const p = RwsClient2.parse(
      await this.req('GET', `/rw/rapid/symbol/RAPID/${task}/${module}/${symbol}/properties`)
    );
    const d = p.getState('rap-sympropvar') || p.getState('rap-sympropvar-li') || p.getState('rap-symbol-properties');
    return {
      symburl: d['symburl'] ?? `RAPID/${task}/${module}/${symbol}`,
      symtyp:  d['symtyp']  ?? '',
      named:   d['named']   === 'true',
      dattyp:  d['dattyp']  ?? '',
      ndim:    Number(d['ndim']   ?? 0),
      dim:     d['dim']     ?? '',
      heap:    d['heap']    === 'true',
      linked:  d['linked']  === 'true',
      local:   d['local']   === 'true',
      ro:      d['rdonly']  === 'true' || d['ro'] === 'true',
      taskvar: d['taskvar'] === 'true',
      storage: d['storage'] ?? '',
      typurl:  d['typurl']  ?? '',
    };
  }

  async searchRapidSymbols(params: RapidSymbolSearchParams): Promise<RapidSymbolInfo[]> {
    // RWS 2.0 /rw/rapid/symbols/search expects view=block + blockurl + symtyp=any
    // (NOT a `task` field — that returns 400 "Invalid parameter").
    // It returns one <li> per match. The `class` of the <li> tells you the kind:
    //   rap-sympropvar-li  → variable (VAR)
    //   rap-syproppers-li  → persistent (PERS)
    //   rap-sympropconst-li → constant (CONST)
    //   rap-sympropproc-li → procedure (PROC)
    //   rap-sympropfun-li  → function (FUNC)
    //   rap-sympropmod-li  → module
    // Earlier versions only parsed vars — missing all the routines.
    const body: Record<string, string> = {};
    if (params.view)      { body['view']      = params.view; }
    if (params.vartyp)    { body['vartyp']    = params.vartyp; }
    if (params.symtyp)    { body['symtyp']    = params.symtyp; }
    if (params.dattyp)    { body['dattyp']    = params.dattyp; }
    if (params.regexp)    { body['regexp']    = params.regexp; }
    if (params.recursive !== undefined) { body['recursive'] = String(params.recursive); }
    if (params.blockurl)  { body['blockurl']  = params.blockurl; }
    // Sensible defaults so callers can pass just `{ blockurl }`
    if (!body['view'])      { body['view']     = 'block'; }
    if (!body['symtyp'])    { body['symtyp']   = 'any'; }
    if (!body['recursive']) { body['recursive']= 'TRUE'; }

    const xhtml = await this.req('POST', '/rw/rapid/symbols/search', body);
    const liClasses = [
      'rap-sympropvar-li',
      'rap-syproppers-li',
      'rap-sympropconst-li',
      'rap-sympropproc-li',
      'rap-sympropfun-li',
      'rap-sympropmod-li',
      'rap-symproptrap-li',
    ];
    const out: RapidSymbolInfo[] = [];
    for (const cls of liClasses) {
      const p = RwsClient2.parse(xhtml);
      for (const s of p.getAllStates(cls)) {
        out.push({
          symburl: s['symburl'] ?? '',
          name:    s['name']    ?? '',
          symtyp:  s['symtyp']  ?? '',
          dattyp:  s['dattyp']  ?? '',
          ndim:    Number(s['ndim'] ?? 0),
          local:   s['local']   === 'true',
          ro:      s['rdonly']  === 'true',
          taskvar: s['taskvar'] === 'true',
        });
      }
    }
    return out;
  }

  async getActiveUiInstruction(): Promise<UiInstruction | null> {
    try {
      const p = RwsClient2.parse(await this.req('GET', '/rw/rapid/uiinstr/active'));
      const d = p.getState('rap-uiinstr-li') || p.getState('rap-uiinstr');
      if (!d['instr']) { return null; }
      return { instr: d['instr'], event: d['event'] ?? '', stack: d['stack'] ?? '', execlv: d['execlv'] ?? '', msg: d['msg'] ?? '' };
    } catch { return null; }
  }

  setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void> {
    // RWS 2.0: POST /rw/rapid/uiinstr/active/param/{stackurl}/{uiparam}
    return this.req(
      'POST',
      `/rw/rapid/uiinstr/active/param/${encodeURIComponent(stackurl)}/${encodeURIComponent(uiparam)}`,
      { value }
    ).then(() => {});
  }

  // ─── Motion ─────────────────────────────────────────────────────────────────

  async getJointPositions(mechunit = 'ROB_1'): Promise<JointTarget> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}/jointtarget`));
    const d = p.getState('ms-jointtarget');
    return {
      rax_1: +d['rax_1'], rax_2: +d['rax_2'], rax_3: +d['rax_3'],
      rax_4: +d['rax_4'], rax_5: +d['rax_5'], rax_6: +d['rax_6'],
    };
  }

  async getCartesianFull(mechunit = 'ROB_1'): Promise<CartesianFull> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}/cartesian`));
    // Live: cf1/cf4/cf6/cfx in RWS 2.0 map to j1/j4/j6/jx in CartesianFull type
    const d = p.getState('ms-mechunit-cartesian');
    return {
      x: +d['x'], y: +d['y'], z: +d['z'],
      q1: +d['q1'], q2: +d['q2'], q3: +d['q3'], q4: +d['q4'],
      j1: +d['cf1'], j4: +d['cf4'], j6: +d['cf6'], jx: +d['cfx'],
    };
  }

  async listMechunits(): Promise<string[]> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/motionsystem/mechunits'));
    // Live: <li class="ms-mechunit-li" title="ROB_1">
    return p.getAllStates('ms-mechunit-li')
      .map(m => m['_title'])
      .filter(Boolean) as string[];
  }

  // ─── System info ─────────────────────────────────────────────────────────────

  async getSystemInfo(): Promise<SystemInfo> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/system'));
    const d = p.getState('sys-system');
    // Type-name drift between representations (live-verified 2026-07-09, RW7.21):
    // XHTML lists options as class="sys-option"; HAL JSON nests them under the
    // sys-options-li resource as _type="sys-options". Collect both.
    const opts = [...p.getAllStates('sys-option'), ...p.getAllStates('sys-options')]
      .map(o => o['option']).filter(Boolean) as string[];
    return { name: d['name'] ?? '', rwVersion: d['rwversion'] ?? '', sysid: d['sysid'] ?? '', startTime: d['starttm'] ?? '', options: opts };
  }

  async getControllerIdentity(): Promise<ControllerIdentity> {
    const p = RwsClient2.parse(await this.req('GET', '/ctrl/identity'));
    const d = p.getState('ctrl-identity-info');
    return { name: d['ctrl-name'] ?? '', id: '', type: d['ctrl-type'] ?? '', mac: '' };
  }

  async getControllerClock(): Promise<ControllerClock> {
    const p = RwsClient2.parse(await this.req('GET', '/ctrl/clock'));
    return { datetime: p.getState('ctrl-clock-info')['datetime'] ?? '' };
  }

  setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void> {
    // PUT /ctrl/clock — field names confirmed from RwsClient ResourceMapper
    return this.req('PUT', '/ctrl/clock', {
      'sys-clock-year':  String(year),
      'sys-clock-month': String(month),
      'sys-clock-day':   String(day),
      'sys-clock-hour':  String(hour),
      'sys-clock-min':   String(min),
      'sys-clock-sec':   String(sec),
    }).then(() => {});
  }

  restartController(mode: RestartMode = 'restart'): Promise<void> {
    return this.req('POST', '/ctrl/restart', { 'restart-mode': mode }).then(() => {});
  }

  // ─── Event log ───────────────────────────────────────────────────────────────

  async getEventLog(domain = 0): Promise<ElogMessage[]> {
    // lang=en required to get title/desc/causes/actions (confirmed by live probe)
    const p = RwsClient2.parse(await this.req('GET', `/rw/elog/${domain}?lang=en`));
    return p.getAllStates('elog-message-li').map(m => {
      const parts = (m['_title'] ?? '').split('/');
      return {
        seqnum:       Number(parts[parts.length - 1] ?? 0),
        code:         Number(m['code']    ?? 0),
        msgtype:      Number(m['msgtype'] ?? 1) as 1 | 2 | 3,
        timestamp:    m['tstamp']  ?? '',
        srcName:      m['src-name'] ?? '',
        title:        m['title']   ?? `Event ${m['code']}`,
        desc:         m['desc']    ?? '',
        causes:       m['causes']  ?? '',
        consequences: m['conseqs'] ?? '',
        actions:      m['actions'] ?? '',
      };
    });
  }

  clearEventLog(domain = 0): Promise<void> {
    return this.req('POST', `/rw/elog/${domain}/clear`).then(() => {});
  }

  clearAllEventLogs(): Promise<void> {
    // Live confirmed: POST /rw/elog/clearall → 204
    return this.req('POST', '/rw/elog/clearall').then(() => {});
  }

  // ─── I/O signals ─────────────────────────────────────────────────────────────

  async listAllSignals(start = 0, limit = 200): Promise<Signal[]> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/iosystem/signals?start=${start}&limit=${limit}`));
    return p.getAllStates('ios-signal-li').map(s => {
      const name  = s['name'] ?? s['_title']?.split('/').pop() ?? '';
      const parts = (s['_title'] ?? '').split('/');
      if (parts.length >= 3) { this.sigCoords.set(name, { n: parts[0], d: parts[1] }); }
      return { name, value: s['lvalue'] ?? '0', type: (s['type'] ?? 'DI') as Signal['type'], lvalue: s['lvalue'] ?? '0' };
    });
  }

  async readSignal(network: string, device: string, name: string): Promise<Signal> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/iosystem/signals/${network}/${device}/${name}`));
    const d = p.getState('ios-signal-li');
    return { name: d['name'] ?? name, value: d['lvalue'] ?? '0', type: (d['type'] ?? 'DI') as Signal['type'], lvalue: d['lvalue'] ?? '0' };
  }

  writeSignal(network: string, device: string, name: string, value: string): Promise<void> {
    let n = network, d = device;
    if (!n || !d) {
      const c = this.sigCoords.get(name);
      if (!c) {
        // Without coordinates the URL would degenerate to /signals///{name}/set-value.
        return Promise.reject(new RwsError(
          `writeSignal: network/device unknown for signal "${name}" — pass them explicitly or call listAllSignals() first`,
          'UNKNOWN',
        ));
      }
      n = c.n; d = c.d;
    }
    return this.req('POST', `/rw/iosystem/signals/${n}/${d}/${name}/set-value`, { lvalue: value }).then(() => {});
  }

  async listNetworks(): Promise<IoNetwork[]> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/iosystem/networks'));
    // Live: <li class="ios-network-li" title="IntegratedIONetwork">
    //   <span class="name">IntegratedIONetwork</span><span class="pstate">running</span><span class="lstate">started</span>
    return p.getAllStates('ios-network-li').map(n => ({
      name:   n['name']   ?? n['_title'] ?? '',
      pstate: n['pstate'] ?? '',
      lstate: n['lstate'] ?? '',
    }));
  }

  async listDevices(network: string): Promise<IoDevice[]> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/iosystem/devices?network=${encodeURIComponent(network)}`));
    // Live: <li class="ios-device-li" title="IntBus/EPanel">
    //   <span class="name">EPanel</span><span class="lstate">enabled</span><span class="pstate">running</span><span class="address"></span>
    return p.getAllStates('ios-device-li').map(d => ({
      name:    d['name']    ?? d['_title']?.split('/').pop() ?? '',
      network,
      lstate:  d['lstate']  ?? '',
      pstate:  d['pstate']  ?? '',
      address: d['address'] ?? '',
    }));
  }

  // ─── File system ──────────────────────────────────────────────────────────────

  private rws2Path(path: string): string {
    // Percent-encode per segment so names with spaces, '#', '%', etc. survive
    // URL parsing ('#' would otherwise be treated as a fragment and truncate the path).
    return path.replace(/\$HOME/g, 'HOME')
      .split('/').map(encodeURIComponent).join('/');
  }

  async listDirectory(path: string): Promise<FileEntry[]> {
    const p = RwsClient2.parse(await this.req('GET', `/fileservice/${this.rws2Path(path)}`));
    const dirs  = p.getAllStates('fs-dir').map(d => ({ name: d['_title'] ?? '', type: 'dir' as const, modified: d['fs-mdate'] }));
    const files = p.getAllStates('fs-file').map(f => ({ name: f['_title'] ?? '', type: 'file' as const, size: f['fs-size'] ? +f['fs-size'] : undefined, created: f['fs-cdate'], modified: f['fs-mdate'], readonly: f['fs-readonly'] === 'true' }));
    return [...dirs, ...files];
  }

  readFile(path: string): Promise<string> { return this.req('GET', `/fileservice/${this.rws2Path(path)}`); }

  uploadFile(path: string, content: string): Promise<void> {
    // RWS 2.0 requires the versioned content type: 'text/plain;v=2.0' or
    // 'application/octet-stream;v=2.0'. Plain 'text/plain' returns HTTP 415.
    return this.req('PUT', `/fileservice/${this.rws2Path(path)}`, undefined, content, 'text/plain;v=2.0').then(() => {});
  }

  deleteFile(path: string): Promise<void> {
    return this.req('DELETE', `/fileservice/${this.rws2Path(path)}`).then(() => {});
  }

  /**
   * Create a directory under `parentPath`. Live-verified RWS 2.0 API:
   *   POST /fileservice/{parent}/create
   *   body: fs-newname={dirName}
   *
   * The earlier shape (`/fileservice/{parent}/{dirName}/create` with no body)
   * returned 404 because the controller treated `{parent}/{dirName}` as the
   * parent and looked for an already-existing `{dirName}` segment.
   */
  createDirectory(parentPath: string, dirName: string): Promise<void> {
    return this.req('POST', `/fileservice/${this.rws2Path(parentPath)}/create`, { 'fs-newname': dirName }).then(() => {});
  }

  copyFile(sourcePath: string, destPath: string): Promise<void> {
    return this.req('POST', `/fileservice/${this.rws2Path(sourcePath)}/copy`, { destination: destPath }).then(() => {});
  }

  // ─── Configuration database `/rw/cfg` ───────────────────────────────────────

  async listCfgDomains(): Promise<string[]> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/cfg'));
    return p.getAllStates('cfg-domain-li').map(d => d['_title'] ?? d['name']).filter(Boolean) as string[];
  }

  /**
   * Next-page path from a paginated list response, resolved relative to the
   * parent of the current request path (matches the controller's relative
   * hrefs; live-verified on the XHTML `rel="next"` links and, 2026-07-09 on
   * RW7.21, on the HAL `_links.next.href` form). Both representations XML-escape
   * ampersands in the href — even inside JSON strings — hence the unescape.
   * Returns '' when there is no further page.
   */
  private static nextPagePath(responseBody: string, currentPath: string): string {
    const rel = HalJsonParser.looksLikeJson(responseBody)
      ? new HalJsonParser(responseBody).nextHref()
      : responseBody.match(/<a\s+href="([^"]+)"\s+rel="next"/)?.[1];
    if (!rel) { return ''; }
    return currentPath.replace(/[^/]*$/, '') + rel.replace(/&amp;/g, '&');
  }

  async listCfgTypes(domain: string): Promise<string[]> {
    // Live-verified class: cfg-dt-li (datatype-li). Paginated — controller returns 70/page.
    // Pagination quirk: the `rel="next"` href is relative to the response's <base href>
    // which is /rw/cfg/, NOT to /rw/. Resolve relative to the current request's parent path.
    const types: string[] = [];
    let path = `/rw/cfg/${domain}`;
    let pages = 0;
    while (path && pages < 50) {
      const html = await this.req('GET', path);
      const p = RwsClient2.parse(html);
      types.push(...p.getAllStates('cfg-dt-li').map(t => t['_title'] ?? t['name']).filter(Boolean) as string[]);
      path = RwsClient2.nextPagePath(html, path);
      pages++;
    }
    return types;
  }

  async listCfgInstances(domain: string, type: string): Promise<string[]> {
    // Live-verified: instances live under /{domain}/{type}/instances (with /instances/ suffix).
    // Each is class="cfg-dt-instance-li" with the instance name as the title attribute.
    // Paginated: controller returns 70/page with `rel="next"` link.
    // Note: a few "types" returned by listCfgTypes are placeholders (e.g. SYS/SYSTEM_NAME)
    // that error with HTTP 400 "Invalid type id" — return [] silently for those.
    const instances: string[] = [];
    let path = `/rw/cfg/${domain}/${type}/instances`;
    let pages = 0;
    while (path && pages < 50) {
      let html: string;
      try { html = await this.req('GET', path); }
      catch { return instances; } // invalid type or no permission — silent empty
      const p = RwsClient2.parse(html);
      instances.push(...p.getAllStates('cfg-dt-instance-li').map(i => i['_title'] ?? '').filter(Boolean));
      path = RwsClient2.nextPagePath(html, path);
      pages++;
    }
    return instances;
  }

  async getCfgInstance(domain: string, type: string, instance: string): Promise<Record<string, string>> {
    // Live-verified: /{domain}/{type}/instances/{instance}
    // Returns an outer cfg-dt-instance li with NESTED cfg-ia-t li elements.
    // Each attribute: <li class="cfg-ia-t" title="ATTR_NAME"><span class="value">VALUE</span></li>
    const html = await this.req('GET', `/rw/cfg/${domain}/${type}/instances/${encodeURIComponent(instance)}`);
    const p = RwsClient2.parse(html);
    const attribs = p.getAllStates('cfg-ia-t');
    const result: Record<string, string> = {};
    for (const attr of attribs) {
      const name = attr['_title'];
      const value = attr['value'] ?? '';
      if (name) { result[name] = value; }
    }
    return result;
  }

  /**
   * Update attributes on an existing configuration instance. Requires 'edit'
   * mastership (callers hold it; RobotManager wraps these with mastership).
   *
   * Live-verified 2026-07-09 on OmniCore VC RW7.21 via probe-cfg-rws2.mjs:
   *   ✓ POST /rw/cfg/{domain}/{type}/instances/{instance}
   *     body: each attribute in BRACKET representation `Attr=[value,1]` joined
   *     by '&', values literal (not percent-encoded), Content-Type
   *     application/x-www-form-urlencoded;v=2.0 → 204. Partial attribute sets
   *     are accepted; unknown attribute names → 400 "Error set attribute".
   *   ✗ POST /rw/cfg/{domain}/{type}/{instance} (no /instances/) → 404
   */
  async setCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
    const body = Object.entries(attrs).map(([k, v]) => `${k}=[${v},1]`).join('&');
    await this.req(
      'POST',
      `/rw/cfg/${domain}/${type}/instances/${encodeURIComponent(instance)}`,
      undefined,
      body,
      'application/x-www-form-urlencoded;v=2.0',
    );
  }

  /**
   * Create a new configuration instance, then apply `attrs`. Requires 'edit'
   * mastership. Live-verified 2026-07-09 on OmniCore VC RW7.21:
   *   ✓ POST /rw/cfg/{domain}/{type}/instances/create-default  body name={instance} → 201,
   *     followed by the setCfgInstance shape above for the attribute values.
   *   ✗ POST /rw/cfg/{domain}/{type}/{instance}/create → 404 (endpoint doesn't exist)
   */
  async createCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
    await this.req('POST', `/rw/cfg/${domain}/${type}/instances/create-default`,
      undefined, `name=${instance}`, 'application/x-www-form-urlencoded;v=2.0');
    if (Object.keys(attrs).length > 0) {
      await this.setCfgInstance(domain, type, instance, attrs);
    }
  }

  /**
   * Delete a configuration instance. Requires 'edit' mastership.
   * Live-verified 2026-07-09 on OmniCore VC RW7.21:
   *   ✓ DELETE /rw/cfg/{domain}/{type}/instances/{instance} → 204 (readback → 404)
   */
  async removeCfgInstance(domain: string, type: string, instance: string): Promise<void> {
    await this.req('DELETE', `/rw/cfg/${domain}/${type}/instances/${encodeURIComponent(instance)}`);
  }

  async loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset' = 'replace'): Promise<void> {
    await this.req('POST', '/rw/cfg', { 'action-type': action, filepath });
  }

  async saveCfgFile(domain: string, filepath: string): Promise<void> {
    await this.req('POST', `/rw/cfg/${domain}/save`, { filepath });
  }

  // ─── Backup / Restore `/ctrl/backup` ────────────────────────────────────────

  async listBackups(): Promise<Array<{ name: string; created?: string; size?: number }>> {
    // Backups live under /fileservice/BACKUP — list that volume
    try {
      const p = RwsClient2.parse(await this.req('GET', '/fileservice/BACKUP'));
      return p.getAllStates('fs-dir').map(d => ({
        name: d['_title'] ?? '',
        created: d['fs-cdate'],
      }));
    } catch { return []; }
  }

  async createBackup(name: string): Promise<void> {
    await this.req('POST', '/ctrl/backup/create', { 'backup': `BACKUP/${name}` });
  }

  async restoreBackup(name: string): Promise<void> {
    await this.req('POST', '/ctrl/backup/restore', { 'backup': `BACKUP/${name}` });
  }

  async getBackupStatus(): Promise<{ active: boolean; progress?: number; phase?: string }> {
    const p = RwsClient2.parse(await this.req('GET', '/ctrl/backup'));
    const d = p.getState('ctrl-backup-info-li') || p.getState('ctrl-backup-info');
    const phase = d['progress-state'] ?? d['phase'] ?? '';
    return {
      active: phase !== '' && phase !== 'idle' && phase !== 'finished',
      progress: d['progress'] ? +d['progress'] : undefined,
      phase,
    };
  }

  // ─── Tool / WObj management ─────────────────────────────────────────────────
  // RWS exposes these via the mechunit's tool-name / wobj-name attributes;
  // setting requires updating the active task's tooldata/wobjdata RAPID symbols.

  async getActiveTool(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}`));
    const d = p.getState('ms-mechunit');
    return { name: d['tool-name'] ?? 'tool0' };
  }

  async getActiveWobj(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}`));
    const d = p.getState('ms-mechunit');
    return { name: d['wobj-name'] ?? 'wobj0' };
  }

  async getActivePayload(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}`));
    const d = p.getState('ms-mechunit');
    return { name: d['total-payload-name'] ?? d['payload-name'] ?? 'load0' };
  }

  async setActiveTool(mechunit: string, toolName: string): Promise<void> {
    await this.req('POST', `/rw/motionsystem/mechunits/${mechunit}`, { 'tool': toolName });
  }

  async setActiveWobj(mechunit: string, wobjName: string): Promise<void> {
    await this.req('POST', `/rw/motionsystem/mechunits/${mechunit}`, { 'wobj': wobjName });
  }

  // ─── Service routine / PROC call ────────────────────────────────────────────

  async callServiceRoutine(task: string, routineName: string, args: Record<string, string> = {}): Promise<void> {
    await this.req('POST', `/rw/rapid/tasks/${task}/serviceroutine`, { routine: routineName, ...args });
  }

  // ─── DIPC `/rw/dipc` ───────────────────────────────────────────────────────

  async listDipcQueues(): Promise<Array<{ name: string; size?: number }>> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/dipc'));
    return p.getAllStates('dipc-queue-li').map(q => ({
      name: q['queue-name'] ?? q['_title'] ?? '',
      size: q['queue-size'] ? +q['queue-size'] : undefined,
    }));
  }

  async createDipcQueue(name: string, options: { maxsize?: number; maxmessages?: number } = {}): Promise<void> {
    const body: Record<string, string> = { 'dipc-queue-name': name };
    if (options.maxsize)     { body['dipc-max-size']    = String(options.maxsize); }
    if (options.maxmessages) { body['dipc-max-number-of-messages'] = String(options.maxmessages); }
    await this.req('POST', '/rw/dipc', body);
  }

  async sendDipcMessage(queue: string, payload: string, type: 'string' | 'num' | 'dnum' | 'bool' = 'string'): Promise<void> {
    await this.req('POST', `/rw/dipc/${encodeURIComponent(queue)}`, {
      'dipc-src-queue-name': queue,
      'dipc-cmd': '111',  // SEND
      'dipc-data': payload,
      'dipc-msgtype': type === 'string' ? '0' : type === 'num' ? '1' : type === 'dnum' ? '2' : '3',
    });
  }

  async readDipcMessage(queue: string, timeoutMs = 0): Promise<{ payload: string; type: string } | null> {
    try {
      const p = RwsClient2.parse(await this.req('POST', `/rw/dipc/${encodeURIComponent(queue)}/read`, {
        'dipc-timeout': String(timeoutMs),
      }));
      const d = p.getState('dipc-message');
      if (!d['dipc-data']) { return null; }
      return { payload: d['dipc-data'], type: d['dipc-msgtype'] ?? 'string' };
    } catch { return null; }
  }

  async removeDipcQueue(name: string): Promise<void> {
    await this.req('DELETE', `/rw/dipc/${encodeURIComponent(name)}`);
  }

  // ─── Mastership ───────────────────────────────────────────────────────────────

  private rws2Domain(domain: MastershipDomain): string {
    // RWS 2.0 renames: 'rapid' and 'cfg' both become 'edit' (confirmed: /rapid/request → 404)
    return (domain === 'rapid' || domain === 'cfg') ? 'edit' : domain;
  }

  requestMastership(domain: MastershipDomain): Promise<void> {
    return this.req('POST', `/rw/mastership/${this.rws2Domain(domain)}/request`).then(() => {});
  }

  releaseMastership(domain: MastershipDomain): Promise<void> {
    return this.req('POST', `/rw/mastership/${this.rws2Domain(domain)}/release`).then(() => {});
  }

  /** Request mastership on ALL domains at once (RWS 2.0). Cheaper than calling per-domain. */
  requestMastershipAll(): Promise<void> {
    return this.req('POST', '/rw/mastership/request').then(() => {});
  }

  /** Release mastership on ALL domains at once (RWS 2.0). */
  releaseMastershipAll(): Promise<void> {
    return this.req('POST', '/rw/mastership/release').then(() => {});
  }

  /**
   * Request mastership on `domain` and receive a numeric ID token. Use the ID
   * with `releaseMastershipWithId()` from a different session — useful when a
   * client needs mastership to outlive the cookie that acquired it (e.g. a
   * webapp that periodically reconnects). Token-based release is the only way
   * to free a stuck mastership after session loss without a controller restart.
   */
  async requestMastershipWithId(domain: MastershipDomain): Promise<number> {
    const xhtml = await this.req('POST', `/rw/mastership/${this.rws2Domain(domain)}/request-with-id`);
    const id = RwsClient2.parse(xhtml).get('mastership-id');
    if (!id) { throw new Error('RWS2 request-with-id: no mastership-id in response'); }
    return Number(id);
  }

  /**
   * Release mastership previously acquired via `requestMastershipWithId()`.
   * Body parameter is `mastershipid` (no dash — controller-specific naming
   * confirmed via 400 "Invalid value" probing; the dash variant returns the
   * same error code as a missing value).
   */
  releaseMastershipWithId(domain: MastershipDomain, id: number): Promise<void> {
    return this.req('POST', `/rw/mastership/${this.rws2Domain(domain)}/release-with-id`,
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
    return this.req('POST', '/rw/mastership/watchdog').then(() => {});
  }

  /** Read mastership status for one domain — returns 'nomaster' | 'remote' | 'local' | similar. */
  async getMastershipStatus(domain: MastershipDomain): Promise<{ mastership: string; uid?: string; application?: string }> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/mastership/${this.rws2Domain(domain)}`));
    const d = p.getState('msh-resource');
    return { mastership: d['mastership'] ?? 'unknown', uid: d['uid'], application: d['application'] };
  }

  /** List all mastership domains the controller exposes (typically `['edit', 'motion']`). */
  async listMastershipDomains(): Promise<string[]> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/mastership'));
    return p.getAllStates('msh-resource-li').map(d => d['_title']).filter(Boolean) as string[];
  }

  // ─── Devices `/rw/devices` ──────────────────────────────────────────────────

  /**
   * List the top-level device groupings (typically HW_DEVICES, SW_RESOURCES).
   * This is the entry point for the controller's hardware inventory tree.
   * Drill into each group with `getDeviceTree(group)`.
   */
  async listSystemDevices(): Promise<Array<{ id: string; name: string }>> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/devices'));
    return p.getAllStates('dev-id-li').map(d => ({
      id:   d['_title'] ?? '',
      name: d['name']   ?? '',
    }));
  }

  /** Drill into a device group (e.g. 'HW_DEVICES'). Returns sub-tree as raw XHTML map.
   *  Accept is pinned to XHTML so the promised raw format never changes under
   *  the HAL JSON negotiation. */
  async getDeviceTree(group: string): Promise<string> {
    return this.req('GET', `/rw/devices/${encodeURIComponent(group)}`,
      undefined, undefined, undefined, [], RwsClient2.ACCEPT_XHTML);
  }

  /**
   * List ALL configured I/O devices across every network in one call.
   * (`listDevices(network)` is the per-network variant — both are fine; this
   * one's handy when you want a flat overview without enumerating networks first.)
   */
  async listAllIoDevices(): Promise<Array<{ name: string; network: string; lstate: string; pstate: string; address: string }>> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/iosystem/devices'));
    return p.getAllStates('ios-device-li').map(d => {
      const title = d['_title'] ?? '';
      const network = title.split('/')[0] ?? '';
      return {
        name:    d['name']   ?? '',
        network,
        lstate:  d['lstate'] ?? '',
        pstate:  d['pstate'] ?? '',
        address: d['address'] ?? '',
      };
    });
  }

  // ─── Forward Kinematics ─────────────────────────────────────────────────────

  /**
   * Forward kinematics: compute Cartesian pose from joint angles.
   * Mirror of `calcJointsFromCartesian()` (which is inverse kinematics).
   *
   * Note: like IK, virtual controllers without the PC Interface (616-1) option
   * generally reject this — the response comes back HTTP 200 but the body
   * contains a retcode error link instead of the result. Real hardware with
   * PC Interface licensed returns a valid pose.
   */
  async calcCartesianFromJoints(
    joints: JointTarget,
    mechunit = 'ROB_1',
    tool = 'tool0',
    wobj = 'wobj0',
  ): Promise<RobTarget> {
    const body = new URLSearchParams({
      curr_joints: `[${joints.rax_1},${joints.rax_2},${joints.rax_3},${joints.rax_4},${joints.rax_5},${joints.rax_6}]`,
      curr_ext_joints: '[9E9,9E9,9E9,9E9,9E9,9E9]',
      tool, wobj,
    }).toString();
    const xhtml = await this.req('POST', `/rw/motionsystem/mechunits/${mechunit}?action=CalcRobTFromJoints`, undefined, body);
    const p = RwsClient2.parse(xhtml);
    if (p.getError()) {
      throw new Error(`FK rejected: ${p.getError()?.msg ?? 'unknown'} (likely missing PC Interface 616-1 license)`);
    }
    // RWS 2.0 sometimes returns HTTP 200 with the error embedded as
    // `<a href="…/retcode?code=N" rel="error"/>` — no <span class="code"> block.
    // Match either attribute order (href-first or rel-first).
    const errLink = xhtml.match(/<a [^>]*retcode\?code=(-?\d+)[^>]*rel="error"|<a [^>]*rel="error"[^>]*retcode\?code=(-?\d+)/);
    if (errLink) {
      const code = errLink[1] ?? errLink[2];
      throw new Error(`FK rejected: controller return code ${code} (likely missing PC Interface 616-1 license, or pose unreachable)`);
    }
    const d = p.getState('ms-robtarget') || p.getState('ms-cartesian');
    const x = +d['x'];
    if (Number.isNaN(x)) {
      throw new Error(`FK returned no valid pose data (response had no <li class="ms-robtarget|ms-cartesian">; check controller logs)`);
    }
    return {
      x, y: +d['y'], z: +d['z'],
      q1: +d['q1'], q2: +d['q2'], q3: +d['q3'], q4: +d['q4'],
    };
  }

  // ─── Vision `/rw/vision` ────────────────────────────────────────────────────

  async listVisionSystems(): Promise<Array<{ name: string; status?: string }>> {
    try {
      const p = RwsClient2.parse(await this.req('GET', '/rw/vision'));
      return p.getAllStates('vision-system-li').map(s => ({
        name: s['_title'] ?? s['name'] ?? '',
        status: s['status'],
      }));
    } catch { return []; }
  }

  async getVisionSystemInfo(name: string): Promise<Record<string, string>> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/vision/${encodeURIComponent(name)}`));
    return p.getState('vision-system');
  }

  async listVisionJobs(system: string): Promise<Array<{ name: string; active?: boolean }>> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/vision/${encodeURIComponent(system)}/jobs`));
    return p.getAllStates('vision-job-li').map(j => ({
      name: j['name'] ?? j['_title'] ?? '',
      active: j['active'] === 'true',
    }));
  }

  async triggerVisionJob(system: string, job: string): Promise<void> {
    await this.req('POST', `/rw/vision/${encodeURIComponent(system)}/jobs/${encodeURIComponent(job)}/trigger`);
  }

  // ─── Safety controller `/ctrl/safety` ──────────────────────────────────────

  async getSafetyStatus(): Promise<{ state: string; details?: Record<string, string> }> {
    try {
      const p = RwsClient2.parse(await this.req('GET', '/ctrl/safety'));
      const d = p.getState('ctrl-safety') || p.getState('ctrl-safety-info');
      return { state: d['state'] ?? 'unknown', details: d };
    } catch { return { state: 'unavailable' }; }
  }

  async listSafetyZones(): Promise<Array<Record<string, string>>> {
    try {
      const p = RwsClient2.parse(await this.req('GET', '/ctrl/safety/zones'));
      return p.getAllStates('ctrl-safety-zone-li');
    } catch { return []; }
  }

  async runCyclicBrakeCheck(): Promise<void> {
    await this.req('POST', '/ctrl/safety/cyclic-brake-check');
  }

  // ─── Virtual time `/ctrl/virtualtime` ─────────────────────────────────────

  async getVirtualTime(): Promise<{ time: number; running: boolean; speed?: number; timeSlice?: number }> {
    // Live-verified: /ctrl/virtualtime is a directory of 4 sub-resources (vttime, vtspeed, vtstate, vttimeslice).
    // Fetch each and assemble the result.
    // Live-verified field names (RobotWare 7.21):
    //   /vttime  → class="ctrl-vttime"  → span "vtcounter"   (microseconds since boot)
    //   /vtstate → class="ctrl-vtstate" → span "vtcurrstate" ("running"/"stopped")
    //   /vtspeed → class="ctrl-vtspeed" → span "vtcurrspeed" (1.0=real, 10=10x)
    const fetch = async (sub: string) => {
      try {
        const p = RwsClient2.parse(await this.req('GET', `/ctrl/virtualtime/${sub}`));
        return p.getState(`ctrl-${sub}`) || {};
      } catch { return {}; }
    };
    const [time, state, speed] = await Promise.all([
      fetch('vttime'),
      fetch('vtstate'),
      fetch('vtspeed'),
    ]);
    return {
      time:    Number(time['vtcounter'] ?? time['time'] ?? 0),
      running: (state['vtcurrstate'] ?? state['state'] ?? '').toLowerCase() === 'running',
      speed:   speed['vtcurrspeed'] !== undefined ? +speed['vtcurrspeed'] : undefined,
    };
  }

  async setVirtualTimeRunning(running: boolean): Promise<void> {
    await this.req('POST', '/ctrl/virtualtime/vtstate', { vtcurrstate: running ? 'running' : 'stopped' });
  }

  async setVirtualTimeScale(scale: number): Promise<void> {
    await this.req('POST', '/ctrl/virtualtime/vtspeed', { vtcurrspeed: String(scale) });
  }

  // ─── Certificate store `/ctrl/certstore` ──────────────────────────────────

  async listCertificates(): Promise<Array<{ name: string; subject?: string; expires?: string }>> {
    try {
      const p = RwsClient2.parse(await this.req('GET', '/ctrl/certstore'));
      return p.getAllStates('ctrl-cert-li').map(c => ({
        name: c['name'] ?? c['_title'] ?? '',
        subject: c['subject'],
        expires: c['expires'] ?? c['valid-to'],
      }));
    } catch { return []; }
  }

  async uploadCertificate(name: string, pem: string): Promise<void> {
    await this.req('POST', `/ctrl/certstore/${encodeURIComponent(name)}`, undefined, pem, 'application/x-pem-file');
  }

  async removeCertificate(name: string): Promise<void> {
    await this.req('DELETE', `/ctrl/certstore/${encodeURIComponent(name)}`);
  }

  // ─── Registry `/ctrl/registry` ────────────────────────────────────────────

  async getRegistry(): Promise<Record<string, string>> {
    try {
      const p = RwsClient2.parse(await this.req('GET', '/ctrl/registry'));
      return p.getState('ctrl-registry');
    } catch { return {}; }
  }

  // ─── Compress `/ctrl/compress` ────────────────────────────────────────────

  async compressPath(source: string, destination: string): Promise<void> {
    await this.req('POST', '/ctrl/compress', { source, destination });
  }

  // ─── File service — list volumes ──────────────────────────────────────────

  async listFileVolumes(): Promise<string[]> {
    try {
      const p = RwsClient2.parse(await this.req('GET', '/fileservice'));
      return p.getAllStates('fs-volume').map(v => v['_title'] ?? v['name']).filter(Boolean) as string[];
    } catch {
      // Fallback: known standard volumes
      return ['HOME', 'BACKUP', 'DATA', 'ADDINDATA', 'PRODUCTS', 'RAMDISK', 'TEMP'];
    }
  }

  // ─── PP control & RAPID debugger backbone ─────────────────────────────────

  async setProgramPointer(task: string, params: { module?: string; routine: string; row?: number; col?: number }): Promise<void> {
    const body: Record<string, string> = { routine: params.routine };
    if (params.module) { body['module'] = params.module; }
    if (params.row !== undefined) { body['begin-position-row'] = String(params.row); }
    if (params.col !== undefined) { body['begin-position-col'] = String(params.col); }
    await this.req('POST', `/rw/rapid/tasks/${task}/pcp/routine`, body);
  }

  async setPPToCursor(task: string, module: string, row: number, col: number): Promise<void> {
    await this.req('POST', `/rw/rapid/tasks/${task}/pcp/cursor`, {
      module,
      'begin-position-row': String(row),
      'begin-position-col': String(col),
    });
  }

  async stepRapid(task: string, mode: 'into' | 'over' | 'out'): Promise<void> {
    const stepMode = mode === 'into' ? 'step-in' : mode === 'over' ? 'step-over' : 'step-out';
    await this.req('POST', `/rw/rapid/tasks/${task}/step`, { 'step-mode': stepMode });
  }

  async holdToRun(task: string, action: 'press' | 'release'): Promise<void> {
    await this.req('POST', `/rw/rapid/tasks/${task}/holdtorun`, { action });
  }

  async listBreakpoints(task: string): Promise<Array<{ module: string; row: number; col?: number }>> {
    try {
      // Live-verified: /rw/rapid/tasks/{task}/program/breakpoints (not /breakpoint at task root)
      const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/program/breakpoints`));
      return p.getAllStates('rap-breakpoint-li').map(b => ({
        module: b['modulename'] ?? b['modulemame'] ?? b['module'] ?? '',
        row: +(b['begin-position-row'] ?? '0'),
        col: b['begin-position-col'] ? +b['begin-position-col'] : undefined,
      }));
    } catch { return []; }
  }

  async setBreakpoint(task: string, module: string, row: number, col?: number): Promise<void> {
    const body: Record<string, string> = { module, 'begin-position-row': String(row) };
    if (col !== undefined) { body['begin-position-col'] = String(col); }
    await this.req('POST', `/rw/rapid/tasks/${task}/program/breakpoints`, body);
  }

  async removeBreakpoint(task: string, module: string, row: number, col?: number): Promise<void> {
    const params = new URLSearchParams({ module, 'begin-position-row': String(row) });
    if (col !== undefined) { params.set('begin-position-col', String(col)); }
    await this.req('DELETE', `/rw/rapid/tasks/${task}/breakpoint?${params.toString()}`);
  }

  // ─── Mechunit detailed endpoints ────────────────────────────────────────────

  async getMechunitBaseFrame(mechunit = 'ROB_1'): Promise<{ x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }> {
    // Live-verified class: ms-mechunit-baseframe (not ms-baseframe)
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}/baseframe`));
    const d = p.getState('ms-mechunit-baseframe') || p.getState('ms-baseframe');
    return {
      x: +d['x'], y: +d['y'], z: +d['z'],
      q1: +d['q1'], q2: +d['q2'], q3: +d['q3'], q4: +d['q4'],
    };
  }

  async setMechunitBaseFrame(mechunit: string, frame: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void> {
    await this.req('POST', `/rw/motionsystem/mechunits/${mechunit}/baseframe`, {
      x:  String(frame.x),  y:  String(frame.y),  z:  String(frame.z),
      q1: String(frame.q1), q2: String(frame.q2), q3: String(frame.q3), q4: String(frame.q4),
    });
  }

  async getMechunitAxes(mechunit = 'ROB_1'): Promise<Array<Record<string, string>>> {
    // Live-verified: /axes returns a count + sub-resource links (axes/1..N).
    // Fetch each axis individually and assemble the result.
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}/axes`));
    const total = p.getState('ms-mechunit-axes');
    const axisCount = +(total['axes'] ?? 0);
    if (axisCount === 0) { return []; }

    const axes: Array<Record<string, string>> = [];
    for (let i = 1; i <= axisCount; i++) {
      try {
        const ap = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}/axes/${i}`));
        const ad = ap.getState('ms-mechunit-axis') || ap.getState('ms-axis');
        axes.push({ axis: String(i), ...ad });
      } catch { axes.push({ axis: String(i), error: 'unreachable' }); }
    }
    return axes;
  }

  async getMechunitPjoints(mechunit = 'ROB_1'): Promise<Record<string, number>> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}/pjoints`));
    const d = p.getState('ms-pjoints');
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(d)) { if (!k.startsWith('_')) { out[k] = +v; } }
    return out;
  }

  async getMechunitInfo(mechunit = 'ROB_1'): Promise<Record<string, string>> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}`));
    return p.getState('ms-mechunit');
  }

  // ─── Module detailed endpoints ──────────────────────────────────────────────

  async getModuleSource(task: string, moduleName: string): Promise<string> {
    // Program memory is the source of truth — the save round-trip reads it
    // directly, so it is the PRIMARY path. A direct file read can return a
    // stale on-disk copy (module edited in memory, or a leftover HOME file
    // shadowing a module that was actually loaded from .pgf / RobotStudio),
    // and module metadata exposes no reliable backing path to trust: the
    // per-module GET only carries a bare `filename` span (live-verified
    // 2026-07-09 on OmniCore VC RW7.21 — no path/file-path field exists).
    try {
      return await this.readModuleViaSave(task, moduleName);
    } catch {
      // Save endpoint failed (permissions, disk, transient) — fall back to the
      // backing file named by metadata, or the conventional HOME location.
      const info = await this.getModuleInfo(task, moduleName).catch(() => ({} as Record<string, string>));
      const filepath = info['path'] ?? info['file-path']
        ?? (info['filename'] ? `HOME/${info['filename']}` : `$HOME/${moduleName}.mod`);
      return this.readFile(filepath);
    }
  }

  /**
   * Read a module's source by round-tripping it through the TEMP volume.
   * Live-verified 2026-07-08 on OmniCore VC RW7.21:
   *   POST /rw/rapid/tasks/{task}/modules/{module}/save  body name=<tmp>&path=TEMP:
   *   → 204, no mastership required. The controller ALWAYS appends '.modx' to
   *   the given name (even for SysMod modules — never '.sysx'), so the name is
   *   passed without extension. TEMP: avoids any risk of clobbering HOME files.
   */
  private async readModuleViaSave(task: string, moduleName: string): Promise<string> {
    const tmp = `${moduleName}_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
    await this.req(
      'POST',
      `/rw/rapid/tasks/${task}/modules/${encodeURIComponent(moduleName)}/save`,
      undefined,
      `name=${tmp}&path=TEMP:`,
    );
    try {
      return await this.readFile(`TEMP/${tmp}.modx`);
    } finally {
      await this.deleteFile(`TEMP/${tmp}.modx`).catch(() => {});
    }
  }

  async getModuleInfo(task: string, moduleName: string): Promise<Record<string, string>> {
    // Live-verified 2026-07-09 on OmniCore VC RW7.21: the per-module GET returns
    // <li class="rap-module" title="{task}/{module}"> with spans modname,
    // filename (bare name like 'BASE.sysx' — NO path) and attribute.
    // (rap-module-info-li is the class used by the module LIST endpoint.)
    const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/modules/${encodeURIComponent(moduleName)}`));
    const d = p.getState('rap-module');
    if (Object.keys(d).length > 0) { return d; }
    return p.getState('rap-module-info-li') || p.getState('rap-module-info');
  }

  async listModuleSymbols(task: string, moduleName: string): Promise<Array<{ name: string; type: string; dattyp?: string }>> {
    const symbols = await this.searchRapidSymbols({ task, blockurl: `RAPID/${task}/${moduleName}`, recursive: false });
    return symbols.map(s => ({ name: s.name, type: s.symtyp, dattyp: s.dattyp }));
  }

  // ─── Per-task additional endpoints ──────────────────────────────────────────

  async getTaskStructuralChangeCount(task: string): Promise<number> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/structural-changecount`));
    return Number(p.get('change-count') ?? p.get('structural-changecount') ?? 0);
  }

  async getTaskMotion(task: string): Promise<Record<string, string>> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/motion`));
    return p.getState('rap-task-motion') || {};
  }

  async getTaskActivationRecord(task: string): Promise<Record<string, string>> {
    const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/activation-record`));
    return p.getState('rap-activation-record') || {};
  }

  async getTaskProgramInfo(task: string): Promise<Record<string, string>> {
    // Endpoint returns 204 (no content) when no program is loaded — caller handles this.
    const xml = await this.req('GET', `/rw/rapid/tasks/${task}/program`);
    if (!xml) { return {}; }
    return RwsClient2.parse(xml).getState('rap-program-info') || {};
  }

  // ─── WebSocket subscriptions ──────────────────────────────────────────────────

  /**
   * Maps a SubscriptionResource to the RWS 2.0 path;stateParam string.
   * Semicolons must NOT be URL-encoded — the controller requires them literal.
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
      case 'signal':     return `/rw/iosystem/signals/${r.name};lvalue`;
      case 'persvar':    return `/rw/rapid/symbol/data/RAPID/${r.name};value`;
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
  /** Give up re-subscribing after this many consecutive failed attempts. */
  private static readonly WS_RECONNECT_MAX_ATTEMPTS = 6;
  /** How long to wait for the WebSocket upgrade to complete before treating the attempt as failed. */
  private static readonly WS_OPEN_TIMEOUT_MS = 8000;

  /**
   * POST /subscription — accept HTTP 201 (Created).
   * Captures the Location header (authoritative WS URL) and the group resource
   * path (`/subscription/{id}` — the URL a DELETE must target to free the group).
   *
   * Rides the client's main HTTP session: live-verified 2026-07-09 on OmniCore
   * VC RW7.21 (probe-sub-session.mjs) — POST /subscription with the existing
   * session Cookie returns 201 with NO Set-Cookie (no new session minted) and
   * the WebSocket authenticates with that same cookie. Without the Cookie the
   * controller mints one session per subscribe, and reconnect loops would burn
   * through the 5-sessions-per-IP budget.
   */
  private createSubscription(bodyStr: string): Promise<{
    wsUrl: string; deleteUrl: string; cookieStr: string;
  }> {
    return new Promise((resolve, reject) => {
      const url = new URL('/subscription', this.baseUrl);
      const encoded = Buffer.from(bodyStr);
      const options: http.RequestOptions & { agent?: https.Agent; rejectUnauthorized?: boolean } = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port ? +url.port : (this.isHttps ? 443 : 80),
        path: '/subscription',
        headers: {
          Authorization:  this.authHeader,
          Accept:         'application/xhtml+xml;v=2.0',
          'Content-Type': 'application/x-www-form-urlencoded;v=2.0',
          'Content-Length': String(encoded.length),
          ...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
        },
        // Per-request as well as on the agent — see req() for why (issue #2).
        ...(this.isHttps
          ? { agent: this.httpsAgent, ...(this.rejectUnauthorized ? {} : { rejectUnauthorized: false }) }
          : {}),
      };
      const transport = this.isHttps ? https : http;
      const req = (transport as typeof https).request(options as https.RequestOptions, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
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

          // Capture the session cookie if this POST minted one (first-ever request
          // on this client) — same capture rule as req(). The WebSocket authenticates
          // with Cookie, NOT Authorization.
          const setCookies = (res.headers['set-cookie'] ?? []) as string[];
          if (setCookies.length > 0 && !this.sessionCookie) {
            this.sessionCookie = setCookies.map((c: string) => c.split(';')[0]).join('; ');
          }
          const cookieStr = this.sessionCookie ?? '';

          if (!wsUrl) { reject(new Error('RWS2 subscribe: no WebSocket URL')); return; }
          resolve({ wsUrl, deleteUrl, cookieStr });
        });
      });
      req.on('error', reject);
      req.write(encoded);
      req.end();
    });
  }

  async subscribe(
    resources: SubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    onLost?: () => void,
  ): Promise<() => Promise<void>> {
    // 1. Build subscription body
    const paths = resources.map(r => RwsClient2.rws2ResourcePath(r)).filter(Boolean) as string[];
    if (paths.length === 0) { return async () => {}; }

    const parts = [`resources=${paths.length}`];
    paths.forEach((p, i) => {
      // Format: <idx>=<path;stateParam>&<idx>-p=<priority>
      // Semicolons must be LITERAL — do NOT encodeURIComponent
      parts.push(`${i + 1}=${p}&${i + 1}-p=1`);
    });
    const bodyStr = parts.join('&');

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
    // client's main one — orphaned groups would pile up on every reconnect.
    const dropGroup = (path: string): Promise<void> =>
      path ? this.req('DELETE', path).then(() => {}, () => {}) : Promise.resolve();

    // The subscription rides the main HTTP session (see createSubscription), so a
    // dropped WebSocket does NOT invalidate the group — but its poll URL is spent.
    // Every (re)connect drops the previous group, then POSTs a fresh /subscription
    // on the same session; no extra sessions are ever minted.
    const open = async (): Promise<void> => {
      if (conn.deleteUrl) {
        await dropGroup(conn.deleteUrl);
        conn.deleteUrl = '';
      }
      const { wsUrl, deleteUrl, cookieStr } = await this.createSubscription(bodyStr);
      conn.deleteUrl = deleteUrl;

      // 2. Open WebSocket and wait for confirmation it actually connected.
      //    Auth: Cookie from subscription response (NOT Authorization header).
      //    Subprotocol: "rws_subscription" — the RWS 2.0 name. Live-verified 2026-07-08
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
          reject(new Error(`WebSocket connection timed out after ${RwsClient2.WS_OPEN_TIMEOUT_MS} ms`));
        }, RwsClient2.WS_OPEN_TIMEOUT_MS);

        ws.on('open', () => {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          resolve();
        });

        // unexpected-response fires when the HTTP upgrade is rejected (e.g. 400)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ws.on('unexpected-response', (_req: unknown, res: any) => {
          clearTimeout(timer);
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            if (settled) { return; }
            settled = true;
            const body = (Buffer.concat(chunks).toString().trim() || '').slice(0, 120);
            ws.terminate();
            dropGroup(deleteUrl);
            reject(new Error(`RWS2 WebSocket upgrade rejected (HTTP ${res.statusCode}): ${body}`));
          });
        });

        ws.on('error', (err: Error) => {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          dropGroup(deleteUrl);
          reject(err);
        });
      });

      // Unsubscribed while the handshake was in flight — discard the connection.
      if (conn.closed) {
        ws.close();
        dropGroup(deleteUrl);
        return;
      }
      conn.ws = ws;

      // 3. Ping every 25 s (controller closes if no activity within 30 s)
      conn.pingTimer = setInterval(() => {
        if ((ws as { readyState: number }).readyState === 1 /* OPEN */) { ws.send('PING'); }
      }, 25000);

      // 4. Parse incoming events (same approach as abb-rws-client WsSubscriber)
      ws.on('message', (data: Buffer | string) => {
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
            resource:  RwsClient2.resourcePathToName(hrefM[1]),
            value:     spanM[1].trim(),
            timestamp: new Date(),
          });
        }
      });

      // Non-fatal error after open — the matching 'close' event drives cleanup/reconnect.
      ws.on('error', (err: Error) => {
        console.warn('[RWS2] WebSocket error:', err.message);
      });

      ws.on('close', () => {
        if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
        if (!conn.closed) { scheduleReconnect(); }
      });
    };

    const scheduleReconnect = (): void => {
      // unsubscribe() clears the pending timer, but an open() already in
      // flight lands here through its .catch — without this guard it would
      // keep retrying (and eventually fire onLost) after the consumer left.
      if (conn.closed) { return; }
      if (conn.attempts >= RwsClient2.WS_RECONNECT_MAX_ATTEMPTS) {
        const msg = `RWS2 subscription lost — giving up after ${conn.attempts} reconnect attempts`;
        Logger.error(msg);
        console.error(`[RWS2] ${msg}`);
        void dropGroup(conn.deleteUrl);
        conn.deleteUrl = '';
        if (!conn.lostNotified) {
          conn.lostNotified = true;
          try { onLost?.(); } catch { /* consumer callback — never let it break us */ }
        }
        return;
      }
      const delay = RwsClient2.WS_RECONNECT_BASE_MS * 2 ** conn.attempts;
      conn.attempts++;
      Logger.trace?.('subscription', `RWS2 WebSocket dropped — reconnect attempt ${conn.attempts} in ${delay} ms`);
      conn.reconnectTimer = setTimeout(() => {
        open()
          .then(() => {
            if (conn.closed) {
              // unsubscribe() won the race against this reconnect — tear the
              // fresh socket/group down instead of leaving a zombie stream.
              conn.ws?.close();
              const url = conn.deleteUrl;
              conn.deleteUrl = '';
              void dropGroup(url);
              return;
            }
            conn.attempts = 0;
          })
          .catch(e => {
            Logger.warn(`RWS2 subscription reconnect failed: ${e instanceof Error ? e.message : String(e)}`);
            scheduleReconnect();
          });
      }, delay);
    };

    await open();

    // 5. Return unsubscribe — close WS and DELETE the subscription group
    return async () => {
      conn.closed = true;
      if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); }
      if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
      conn.ws?.close();
      await dropGroup(conn.deleteUrl);
    };
  }

  // ─── Remote Mastership Privilege (RMMP) ────────────────────────────────────────
  // ABB safety: RWS users cannot send "modify" operations (jog, RAPID variable writes,
  // etc.) until they have RMMP. Requesting it triggers a FlexPendant popup that an
  // interactive operator must approve. After approval, the privilege persists for
  // the session.

  /**
   * Effective RMMP privilege held by THIS session.
   * The controller's /users/rmmp returns whoever currently holds the privilege —
   * we have to check `rmmpheldbyme` to know whether it's us or some other user.
   * Returns 'none' if another user holds it (we'd need to re-request for our own session).
   */
  async getRmmpPrivilege(): Promise<string> {
    const xml = await this.req('GET', '/users/rmmp');
    const p = RwsClient2.parse(xml);
    const priv     = p.get('privilege') ?? 'none';
    const heldByMe = (p.get('rmmpheldbyme') ?? 'false').toLowerCase() === 'true';
    if (priv === 'none') { return 'none'; }
    if (priv.startsWith('pending')) { return priv; }
    return heldByMe ? priv : 'none';
  }

  /** Request 'modify' privilege. Triggers a FlexPendant approval popup. */
  async requestRmmp(level: 'modify' | 'exclusive' = 'modify'): Promise<void> {
    await this.req('POST', '/users/rmmp', { privilege: level });
  }

  // ─── Jogging ─────────────────────────────────────────────────────────────────

  /** Monotonic counter required by /rw/motionsystem/jog (controller rejects same value twice). */
  private jogCcount = 0;

  async jog(params: {
    mode: 'Joint' | 'Cartesian';
    axes: [number, number, number, number, number, number];
    speed: number;
    mechunit?: string;
  }): Promise<void> {
    const { mode, axes, speed } = params;
    const mechunit = params.mechunit ?? 'ROB_1';
    this.jogCcount++;

    const body = [
      `jogmode=${mode}`,
      `mechunit=${mechunit}`,
      ...axes.map((v, i) => `axis${i + 1}=${v}`),
      `cjogspeed=${speed}`,
      `ccount=${this.jogCcount}`,
    ].join('&');

    await this.req(
      'POST',
      '/rw/motionsystem/jog',
      undefined,
      body,
      'application/x-www-form-urlencoded;v=2.0',
    );
  }

  // ─── Simulation panel (virtual controllers only) ─────────────────────────────
  // RobotWare 7 VCs expose the panel hardware (e-stop chain, enabling device) and
  // a joint-teleport endpoint for simulation. Real controllers do not serve these
  // paths (404) — the FlexPendant hardware is the source of truth there — so every
  // method below translates a 404 into a clear "virtual controllers only" error.
  // All wire shapes live-verified 2026-07-09 on an OmniCore VC RW7.21.

  /** Shared POST for the VC-only simulation endpoints. */
  private async simPost(
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
          `${label}: ${path} returned 404 — simulation endpoints exist only on RobotWare 7 virtual controllers (not on real hardware or RW6)`,
          'UNKNOWN', 404, e.rwsDetail,
        );
      }
      throw e;
    }
  }

  /**
   * Engage the (internal) emergency stop — controller state goes to
   * `emergencystop`. Live-verified 2026-07-09 on OmniCore VC RW7.21:
   *   POST /rw/panel/emergency-stop  body `state=off` → 204.
   * The polarity is INVERTED from the ABB Swagger example: state=off OPENS the
   * safety chain (engages the stop), state=on closes it again. Fully reversible
   * on a VC via {@link simResetEmergencyStop} — no physical reset step exists
   * there (unlike real hardware, which latches until the button is released).
   */
  simEmergencyStop(): Promise<void> {
    return this.simPost('simEmergencyStop', '/rw/panel/emergency-stop', { state: 'off' });
  }

  /** Release the simulated emergency stop (`state=on`) — controller returns to
   *  `motoroff`. See {@link simEmergencyStop} for the polarity note. */
  simResetEmergencyStop(): Promise<void> {
    return this.simPost('simResetEmergencyStop', '/rw/panel/emergency-stop', { state: 'on' });
  }

  /**
   * Engage the general stop (controller state → `guardstop`); pass `false` to
   * release it again (→ `motoroff`). Live-verified 2026-07-09 on OmniCore VC
   * RW7.21: POST /rw/panel/general-stop, `state=off` engages / `state=on`
   * releases (same inverted polarity as the e-stop endpoints).
   */
  simGeneralStop(engage = true): Promise<void> {
    return this.simPost('simGeneralStop', '/rw/panel/general-stop', { state: engage ? 'off' : 'on' });
  }

  /**
   * Engage the automatic stop (controller state → `guardstop`); pass `false` to
   * release it. Live-verified 2026-07-09 on OmniCore VC RW7.21:
   * POST /rw/panel/auto-stop, `state=off` engages / `state=on` releases.
   */
  simAutoStop(engage = true): Promise<void> {
    return this.simPost('simAutoStop', '/rw/panel/auto-stop', { state: engage ? 'off' : 'on' });
  }

  /**
   * Press (`true`) or release (`false`) the simulated three-position enabling
   * device. Live-verified 2026-07-09 on OmniCore VC RW7.21:
   *   POST /rw/panel/enable-switch  body `state=on|off` → 204.
   * This endpoint's polarity is direct (no inversion). In AUTO the controller
   * accepts the call as a no-op; driving motors on requires manual mode.
   */
  simEnableSwitch(on: boolean): Promise<void> {
    return this.simPost('simEnableSwitch', '/rw/panel/enable-switch', { state: on ? 'on' : 'off' });
  }

  /**
   * Teleport a mechanical unit to absolute joint values (degrees) — the VC
   * equivalent of dragging the robot in RobotStudio; no motors, mastership, or
   * program stop needed. Live-verified 2026-07-09 on OmniCore VC RW7.21:
   *   POST /rw/motionsystem/mechunits/{mechunit}/position
   *   body `rob_joint=[j1,j2,j3,j4,j5,j6]&ext_joint=[e1,e2,e3,e4,e5,e6]` → 204
   * BOTH keys are required by the controller (omitting either → 400
   * "No rob_joint parameter"), which is why `extJoints` defaults to six zeros.
   * The readback (`getJointPositions`) may show sub-µdeg float rounding.
   * Caveat (live-verified 2026-07-09): while an operation-mode change is
   * pending (opmode AUTO_CH — FlexPendant acknowledge outstanding) the endpoint
   * answers 403 "Operation not allowed for user in current operation mode".
   */
  async teleportMechunit(mechunit: string, joints: number[], extJoints?: number[]): Promise<void> {
    if (joints.length !== 6 || (extJoints !== undefined && extJoints.length !== 6)) {
      throw new RwsError(
        'teleportMechunit: exactly 6 robot joint values (and 6 external-axis values, if given) are required',
        'UNKNOWN',
      );
    }
    const ext = extJoints ?? [0, 0, 0, 0, 0, 0];
    await this.simPost(
      'teleportMechunit',
      `/rw/motionsystem/mechunits/${mechunit}/position`,
      undefined,
      `rob_joint=[${joints.join(',')}]&ext_joint=[${ext.join(',')}]`,
    );
  }

  // ─── System detail endpoints ────────────────────────────────────────────────

  async getLicenseInfo(): Promise<{ entries: Array<Record<string, string>> }> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/system/license'));
    return { entries: p.getAllStates('sys-license') };
  }

  async listProducts(): Promise<Array<Record<string, string>>> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/system/products'));
    // Live-verified class: sys-product-li (with -li suffix). Each product has a _title
    // (the product name e.g. "RobotControl") plus version and version-name spans.
    return p.getAllStates('sys-product-li').map(p => ({
      name: p['_title'] ?? '',
      version: p['version'] ?? '',
      versionName: p['version-name'] ?? '',
    }));
  }

  async getRobotType(): Promise<{ type: string; variant?: string }> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/system/robottype'));
    const d = p.getState('sys-robottype');
    // Live-verified: span class is 'robot-type' (with hyphen), not 'robottype'
    return { type: d['robot-type'] ?? d['robottype'] ?? d['type'] ?? '', variant: d['variant'] };
  }

  async getEnergyStats(): Promise<Record<string, string>> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/system/energy'));
    // Live-verified class: sys-energy-state (not sys-energy)
    return p.getState('sys-energy-state');
  }

  // ─── Return-code lookup ─────────────────────────────────────────────────────

  async getReturnCode(code: number, lang = 'en'): Promise<{ code: number; title: string; desc: string } | null> {
    try {
      const p = RwsClient2.parse(await this.req('GET', `/rw/retcode?code=${code}&lang=${lang}`));
      const d = p.getState('rw-retcode') || p.getState('rw-retcode-li');
      if (!d['title'] && !d['desc']) { return null; }
      return { code, title: d['title'] ?? '', desc: d['desc'] ?? '' };
    } catch { return null; }
  }

  // ─── Controller detail endpoints ────────────────────────────────────────────

  async listControllerOptions(): Promise<Array<{ name: string; description?: string }>> {
    const p = RwsClient2.parse(await this.req('GET', '/ctrl/options'));
    return p.getAllStates('ctrl-option').map(o => ({
      name: o['option'] ?? o['name'] ?? '',
      description: o['description'],
    }));
  }

  async listFeatures(): Promise<Array<Record<string, string>>> {
    const p = RwsClient2.parse(await this.req('GET', '/ctrl/features'));
    return p.getAllStates('ctrl-feature');
  }

  // ─── Motion detail endpoints ────────────────────────────────────────────────

  async getMotionChangeCount(): Promise<number> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/motionsystem?resource=change-count'));
    return Number(p.get('change-count') ?? 0);
  }

  async getMotionErrorState(): Promise<{ state: string; details?: Record<string, string> }> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/motionsystem/errorstate'));
    const d = p.getState('ms-errorstate-li') || p.getState('ms-errorstate');
    return { state: d['err-state'] ?? d['state'] ?? 'unknown', details: d };
  }

  async getNonMotionExecution(): Promise<boolean> {
    // Live-verified: class="ms-nonmotionexecution", span "mode" returns quoted "OFF" or "ON".
    const p = RwsClient2.parse(await this.req('GET', '/rw/motionsystem/nonmotionexecution'));
    const v = (p.get('mode') ?? p.get('state') ?? 'OFF').replace(/"/g, '').toUpperCase();
    return v === 'ON';
  }

  async setNonMotionExecution(enabled: boolean): Promise<void> {
    await this.req('POST', '/rw/motionsystem/nonmotionexecution', { mode: enabled ? 'ON' : 'OFF' });
  }

  async getCollisionPredictionMode(): Promise<string> {
    // Live-verified: class="ms-collision-prediction-mode" with span "collision-prediction-mode-enabled"
    // returning "true" / "false". Map back to ON/OFF for caller convenience.
    const p = RwsClient2.parse(await this.req('GET', '/rw/motionsystem/collisionprediction'));
    const enabled = p.get('collision-prediction-mode-enabled') ?? p.get('mode') ?? 'false';
    return enabled.toLowerCase() === 'true' ? 'ON' : 'OFF';
  }

  async setCollisionPredictionMode(mode: string): Promise<void> {
    await this.req('POST', '/rw/motionsystem/collisionprediction', { mode });
  }

  // ─── Panel detail endpoints ─────────────────────────────────────────────────

  async getEnableRequest(): Promise<{ state: string; raw: Record<string, string> }> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/panel/enreq'));
    const d = p.getState('pnl-enreq') || p.getState('pnl-enreq-li');
    return { state: d['state'] ?? d['enreq'] ?? 'unknown', raw: d };
  }

  // ─── RAPID detail endpoints ─────────────────────────────────────────────────

  async listAliasIO(): Promise<Array<{ alias: string; signal: string }>> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/rapid/aliasio'));
    return p.getAllStates('rap-aliasio-li').map(a => ({
      alias: a['name'] ?? a['alias'] ?? '',
      signal: a['signal'] ?? a['_title'] ?? '',
    }));
  }

  async getTaskSelection(): Promise<{ selected: string[]; available: string[] }> {
    const p = RwsClient2.parse(await this.req('GET', '/rw/rapid/taskselection'));
    const sel = p.getAllStates('rap-taskselection-li').map(t => t['name']).filter(Boolean) as string[];
    const all = p.getAllStates('rap-task-li').map(t => t['name']).filter(Boolean) as string[];
    return { selected: sel, available: all };
  }

  async setTaskSelection(tasks: string[]): Promise<void> {
    const body = tasks.map((t, i) => `task-${i + 1}=${encodeURIComponent(t)}`).join('&');
    await this.req('POST', '/rw/rapid/taskselection', undefined, body, 'application/x-www-form-urlencoded;v=2.0');
  }

  async getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; executionType?: string }> {
    // Live-verified: class="pcp-info" with spans:
    //   modulemame (sic — controller typo for modulename)
    //   routinename
    //   beginposition  → "row,col" combined string
    //   endposition    → "row,col"
    //   changecount, executiontype
    const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/pcp`));
    const d = p.getState('pcp-info') || p.getState('program-pointer-state') || p.getState('rap-pcp-li');
    const begin = (d['beginposition'] ?? '').split(',');
    return {
      module:  d['modulename'] ?? d['modulemame'] ?? d['module'],
      routine: d['routinename'] ?? d['routine'],
      row:     begin[0] ? +begin[0] : (d['begin-position-row'] ? +d['begin-position-row'] : undefined),
      col:     begin[1] ? +begin[1] : (d['begin-position-col'] ? +d['begin-position-col'] : undefined),
      executionType: d['executiontype'],
    };
  }

  async getMotionPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; state?: string }> {
    // Live-verified: /syncstate/motion-pointer returns class="rap-task-sync-state"
    // with a single span class="motion-pointer-state" containing 'Off' or position info.
    const p = RwsClient2.parse(await this.req('GET', `/rw/rapid/tasks/${task}/syncstate/motion-pointer`));
    const d = p.getState('rap-task-sync-state');
    const stateVal = d['motion-pointer-state'] ?? '';
    return {
      module:  d['modulename'] ?? d['modulemame'] ?? d['module'],
      routine: d['routinename'] ?? d['routine'],
      row:     d['begin-position-row'] ? +d['begin-position-row'] : undefined,
      col:     d['begin-position-col'] ? +d['begin-position-col'] : undefined,
      state:   stateVal,
    };
  }

  // ─── Inverse kinematics ───────────────────────────────────────────────────────

  async calcJointsFromCartesian(
    pos: RobTarget,
    seedJoints?: JointTarget,
    mechunit = 'ROB_1',
  ): Promise<JointTarget> {
    const seed = seedJoints
      ? `[${seedJoints.rax_1},${seedJoints.rax_2},${seedJoints.rax_3},${seedJoints.rax_4},${seedJoints.rax_5},${seedJoints.rax_6}]`
      : '[0,0,0,0,0,0]';

    const bodyStr = [
      `curr_position=[${pos.x},${pos.y},${pos.z}]`,
      `curr_orientation=[${pos.q1},${pos.q2},${pos.q3},${pos.q4}]`,
      `curr_ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]`,
      `old_rob_joints=${seed}`,
      `old_ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]`,
      `robot_fixed_object=false`,
      `tool_frame_position=[0,0,0]`,
      `tool_frame_orientation=[1,0,0,0]`,
      `wobj_frame_position=[0,0,0]`,
      `wobj_frame_orientation=[1,0,0,0]`,
      `robot_configuration=[0,0,0,0]`,
      `elog_at_error=false`,
    ].join('&');

    const html = await this.req(
      'POST',
      `/rw/motionsystem/mechunits/${mechunit}/joints-from-cartesian`,
      undefined,
      bodyStr,
      'application/x-www-form-urlencoded;v=2.0',
    );
    const p = RwsClient2.parse(html);
    const d = p.getState('ms-jointtarget');
    if (!d['rax_1']) { throw new Error('IK: no joint values in response'); }
    return {
      rax_1: +d['rax_1'], rax_2: +d['rax_2'], rax_3: +d['rax_3'],
      rax_4: +d['rax_4'], rax_5: +d['rax_5'], rax_6: +d['rax_6'],
    };
  }

}
