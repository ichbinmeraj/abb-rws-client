import { RwsClient } from './RwsClient.js';
import type {
  RapidTask, JointTarget, RobTarget, CartesianFull, ElogMessage,
  FileEntry, SystemInfo, ControllerIdentity, CollisionDetectionState,
  RapidSymbolProperties, RapidSymbolInfo, RapidSymbolSearchParams,
  UiInstruction, RestartMode, Signal, IoNetwork, IoDevice,
  SubscriptionEvent,
} from './types.js';
import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IRWSAdapter } from './IRWSAdapter.js';
import { RWS1Adapter } from './RWS1Adapter.js';
import { RWS2Adapter } from './RWS2Adapter.js';
import { Logger } from './Logger.js';

/**
 * Listener signature for `onError`. The host (VS Code extension, CLI, etc.) can
 * decide how to surface the error — e.g. `vscode.window.showErrorMessage` with
 * the supplied action labels, or a CLI prompt, or just logging.
 *
 * The promise resolves to the action the user chose, or `undefined` if dismissed.
 * RobotManager respects 'Reconnect' specifically (re-runs connect with the prior config).
 */
export type ErrorListener = (msg: string, actions: string[]) => Promise<string | undefined>;

const SESSION_FILE = path.join(os.homedir(), '.abb-rws-session');

export interface RobotManagerOptions {
  /**
   * Fast-poll cadence in ms, used when WebSocket subscriptions are unavailable.
   * Default 1000, clamped to ≥200 (below that the controller's ~20 req/s limit
   * starts rejecting the poll burst). When subscriptions are active, polling
   * drops to 5× this value (positions only).
   */
  refreshIntervalMs?: number;
  /**
   * Verify TLS certificates on HTTPS controllers. Default false — virtual and
   * real controllers alike ship self-signed certs, so verification stays off
   * unless the deployment has a CA-signed cert on the controller. Applies to
   * port probing and to the RWS 2.0 client this manager constructs.
   */
  strictTls?: boolean;
}

export interface RobotState {
  connected: boolean;
  host: string;
  ctrlstate: string | null;
  opmode: string | null;
  execstate: string | null;
  execCycle: string | null;      // 'once' | 'forever' | 'asis' | 'oncedone'
  speedRatio: number | null;
  coldetstate: CollisionDetectionState | null;
  tasks: RapidTask[];
  modules: string[];
  mechunits: string[];           // list of mechanical unit names (e.g. ['ROB_1'])
  joints: JointTarget | null;
  cartesian: RobTarget | null;
  cartesianFull: CartesianFull | null;
  identity: ControllerIdentity | null;
  systemInfo: SystemInfo | null;
  eventLog: ElogMessage[];
  ioSignals: Signal[];
}

export type ChangeHandler = () => void;

export interface ProbeResult {
  port: number;
  useHttps: boolean;
  authType: 'digest' | 'basic';
}

/** In-flight connect attempt — args plus the connectEpoch the attempt runs under. */
interface ConnectAttempt {
  host: string;
  username: string;
  password: string;
  port?: number;
  useHttps?: boolean;
  /**
   * connectEpoch value this attempt is running under. disconnect() bumps the
   * epoch, marking the attempt cancelled — connect() must stop coalescing onto
   * it, or callers get a resolved promise while the manager ends disconnected.
   */
  epoch: number;
  /**
   * Set by a user-initiated disconnect(). The epoch alone can't carry this:
   * doConnect legitimately re-reads the epoch after its own internal teardowns
   * (supersede, already-connected), which would launder a user cancellation
   * back into validity.
   */
  cancelled?: boolean;
}

export interface DiscoveredController extends ProbeResult {
  host: string;
}

export class RobotManager {
  private adapter: IRWSAdapter | null = null;
  private adapterConfig: { host: string; username: string; password: string; port: number } | null = null;
  private errorListener: ErrorListener | null = null;
  private _state: RobotState = {
    connected: false, host: '', ctrlstate: null, opmode: null,
    execstate: null, execCycle: null, speedRatio: null, coldetstate: null,
    tasks: [], modules: [], mechunits: [], joints: null,
    cartesian: null, cartesianFull: null, identity: null, systemInfo: null,
    eventLog: [], ioSignals: [],
  };

  private handlers: ChangeHandler[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Unsubscribe function returned by adapter.subscribe(); null when not using WebSockets. */
  private unsubscribeFn: (() => Promise<void>) | null = null;
  /** True when WebSocket subscriptions are active (drives reduced polling interval). */
  private subscriptionActive = false;
  /** In-flight connect promise — used to dedupe rapid-clicks so we never run two connects in parallel. */
  private connectingPromise: Promise<void> | null = null;
  /** Args of the in-flight connect, so a repeat call can tell "same target" from "new target". */
  private connectingArgs: ConnectAttempt | null = null;
  /** Monotonic counter so old polling timers can detect they've been superseded and self-cancel. */
  private pollGeneration = 0;
  /** Bumped by disconnect() so an in-flight doConnect() can detect it was cancelled and unwind. */
  private connectEpoch = 0;

  private readonly refreshIntervalMs: number;
  private readonly strictTls: boolean;

  constructor(opts: RobotManagerOptions = {}) {
    this.refreshIntervalMs = Math.max(200, opts.refreshIntervalMs ?? 1000);
    this.strictTls = opts.strictTls === true;
  }

  get state(): RobotState { return this._state; }
  /** The port currently in use (or last attempted). Useful for persisting auto-recovered port changes. */
  get currentPort(): number | undefined { return this.adapterConfig?.port; }
  /** The HTTPS flag matching `currentPort`. */
  get currentUseHttps(): boolean | undefined {
    if (!this.adapter || !this.adapterConfig) { return undefined; }
    // RWS2Adapter is HTTPS, RWS1Adapter is HTTP. instanceof, not constructor.name —
    // minified bundles rename classes, which made this persist the wrong protocol.
    return this.adapter instanceof RWS2Adapter;
  }
  onDidChange(fn: ChangeHandler) { this.handlers.push(fn); }
  private notify() { this.handlers.forEach(h => h()); }

  /**
   * Install an error listener. Called when the manager auto-disconnects after 3 failed
   * polls. Hosts can route to UI dialogs (vscode.window.showErrorMessage), prompts, or
   * alerting systems. The listener returns the chosen action; only 'Reconnect' is acted
   * on internally — others are passed through for the host to handle.
   */
  onError(fn: ErrorListener) { this.errorListener = fn; }

  // ─── Auto-detection ─────────────────────────────────────────────────────────

  private static probePort(
    host: string, port: number, useHttps: boolean, timeoutMs = 3000, strictTls = false
  ): Promise<ProbeResult | null> {
    return new Promise(resolve => {
      const insecure = useHttps && !strictTls;
      const agent = insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined;
      const options: http.RequestOptions & { agent?: https.Agent; rejectUnauthorized?: boolean } = {
        method: 'GET', hostname: host, port,
        path: '/rw/system',
        headers: { Accept: 'application/xhtml+xml;v=2.0' },
        // rejectUnauthorized must also be per-request: hosts that swap the agent
        // (VS Code extension host, non-localhost targets) drop agent-level TLS
        // settings — real controllers have self-signed certs (issue #2).
        // Under strictTls neither is set, so certs verify normally.
        ...(insecure ? { agent, rejectUnauthorized: false } : {}),
      };
      const tid = setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
      const req = ((useHttps ? https : http) as unknown as typeof https).request(
        options as https.RequestOptions,
        res => {
          clearTimeout(tid);
          const wwwAuth = (res.headers['www-authenticate'] ?? '') as string;
          res.resume();
          if (res.statusCode === 401) {
            if (wwwAuth.startsWith('Digest'))      { resolve({ port, useHttps, authType: 'digest' }); }
            else if (wwwAuth.startsWith('Basic'))  { resolve({ port, useHttps, authType: 'basic' }); }
            else                                   { resolve(null); }
          } else { resolve(null); }
        }
      );
      req.on('error', () => { clearTimeout(tid); resolve(null); });
      req.end();
    });
  }

  /** Common ports to check on any host. */
  private static readonly PROBE_PORTS = [
    { port: 80,    useHttps: false },
    { port: 443,   useHttps: true  },
    { port: 28447, useHttps: false },
    { port: 9403,  useHttps: true  },
  ] as const;

  /** Returns ALL responding controllers on a single host. */
  static async detectAllControllers(host: string, strictTls = false): Promise<ProbeResult[]> {
    const results = await Promise.all(
      RobotManager.PROBE_PORTS.map(c => RobotManager.probePort(host, c.port, c.useHttps, 3000, strictTls))
    );
    return results.filter((r): r is ProbeResult => r !== null);
  }

  /**
   * Scan a set of standard ABB hosts for any responding RWS controller.
   * Uses a shorter timeout (1.5 s) for snappy discovery UX.
   * Returns every found controller with its host attached.
   *
   * If nothing is found on 127.0.0.1 via standard ports, falls back to a wide
   * TCP scan of the local-VC port range — this catches RobotStudio VCs whose
   * ports are randomly assigned each startup.
   */
  static async discoverControllers(extraHosts: string[] = [], strictTls = false): Promise<DiscoveredController[]> {
    const hosts = [
      '127.0.0.1',      // Local virtual controllers (RobotStudio)
      '192.168.125.1',  // ABB standard service port — both IRC5 and OmniCore real robots
      ...extraHosts,
    ];

    const probes = hosts.flatMap(host =>
      RobotManager.PROBE_PORTS.map(c =>
        RobotManager.probePort(host, c.port, c.useHttps, 1500, strictTls)
          .then((r): DiscoveredController | null =>
            r ? { host, port: r.port, useHttps: r.useHttps, authType: r.authType } : null
          )
      )
    );

    const results = await Promise.all(probes);
    const found = results.filter((r): r is DiscoveredController => r !== null);

    // Fallback: nothing on standard ports of 127.0.0.1 — try wide scan
    // (RobotStudio assigns random high ports to VCs each restart).
    const localHits = found.filter(c => c.host === '127.0.0.1' || c.host === 'localhost');
    if (localHits.length === 0) {
      Logger.info(`no controllers on standard ports of 127.0.0.1 — running wide scan…`);
      const wide = await RobotManager.wideHostScan('127.0.0.1', strictTls);
      Logger.info(`wide scan found ${wide.length} ABB controller(s) on 127.0.0.1`);
      found.push(...wide);
    }

    return found;
  }

  /** Returns only the first responding controller (used internally during connect). */
  static async detectController(host: string, strictTls = false): Promise<ProbeResult | null> {
    const all = await RobotManager.detectAllControllers(host, strictTls);
    return all[0] ?? null;
  }

  /**
   * Probe an exact host:port to discover its auth type and protocol.
   * Tries HTTPS first (most OmniCore VCs use it), then HTTP.
   * Returns null only if neither responds — protects against guessing wrong
   * (e.g. RobotStudio-assigned port 5466 is HTTPS but doesn't fit any heuristic).
   */
  static async probeSpecificPort(host: string, port: number, strictTls = false): Promise<ProbeResult | null> {
    return (
      (await RobotManager.probePort(host, port, true,  2000, strictTls)) ??
      (await RobotManager.probePort(host, port, false, 2000, strictTls))
    );
  }

  /** Fast TCP-only check to see if a port is accepting connections. */
  private static tcpPing(host: string, port: number, timeoutMs = 100): Promise<boolean> {
    return new Promise(resolve => {
      const socket = new net.Socket();
      const done = (open: boolean) => { socket.destroy(); resolve(open); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error',   () => done(false));
      socket.connect(port, host);
    });
  }

  /**
   * Wide-range port scan for RobotStudio VCs whose ports get reassigned each restart.
   * Two-phase: TCP probe everything fast, then HTTP-probe only ports that responded.
   *
   * Uses a sliding-window worker pool to keep concurrency below the OS socket limit
   * (Windows in particular drops connections silently above ~500 concurrent sockets).
   *
   * Heavy operation — only call when standard-port detection finds nothing.
   * Prefer host=127.0.0.1; scanning a remote host this aggressively is rude.
   */
  static async wideHostScan(host: string, strictTls = false): Promise<DiscoveredController[]> {
    // RobotStudio assigns RWS ports across a wide range. Observed values include
    // 5466, 9403, 11811, 15120, 16146, 28447 — covering 4000–30000 catches them all.
    const startPort = 1024;
    const endPort   = 30000;
    const concurrency = 300;       // safe on Windows; ~500 is the practical ceiling
    const tcpTimeoutMs = 250;      // generous to avoid false negatives

    const tcpOpen: number[] = [];
    let next = startPort;

    // Worker pool: each worker pulls the next port until we run out
    const worker = async () => {
      while (next <= endPort) {
        const port = next++;
        if (await RobotManager.tcpPing(host, port, tcpTimeoutMs)) { tcpOpen.push(port); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    Logger.info(`wide scan: ${tcpOpen.length} open TCP port(s) on ${host}, HTTP-probing each…`);

    // HTTP-probe TCP-open ports — filter to actual ABB controllers
    const probes = await Promise.all(
      tcpOpen.map(port =>
        RobotManager.probeSpecificPort(host, port, strictTls)
          .then((r): DiscoveredController | null =>
            r ? { host, port: r.port, useHttps: r.useHttps, authType: r.authType } : null
          )
      )
    );
    return probes.filter((r): r is DiscoveredController => r !== null);
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Connect to a controller.
   * @param port     If provided, skip auto-detection and use this port directly.
   *                 Required when two controllers share the same host IP.
   * @param useHttps If provided alongside port, sets the protocol explicitly.
   *
   * Rapid duplicate calls with the SAME target are coalesced — concurrent
   * callers receive the same in-flight promise. Without this, fast double-clicks
   * would spawn parallel adapters/timers and overwhelm the controller's session
   * pool. A call with a DIFFERENT target instead cancels the in-flight attempt
   * and connects fresh — otherwise the caller ends up connected, but not to
   * what it asked for. Same for a SAME-target call after a disconnect() has
   * cancelled the in-flight attempt: coalescing onto it would hand the caller
   * a promise that resolves with the manager still disconnected.
   */
  connect(host: string, username: string, password: string, port?: number, useHttps?: boolean): Promise<void> {
    if (this.connectingPromise) {
      const pending = this.connectingArgs;
      const sameArgs = !!pending
        && pending.host === host && pending.username === username
        && pending.password === password && pending.port === port
        && pending.useHttps === useHttps;
      const stillCurrent = !!pending && pending.epoch === this.connectEpoch && !pending.cancelled;
      if (sameArgs && stillCurrent) {
        Logger.info(`connect → ${host}${port !== undefined ? ':' + port : ''} ignored (same connect already in flight)`);
        return this.connectingPromise;
      }
      Logger.info(`connect → ${host}${port !== undefined ? ':' + port : ''} supersedes ${sameArgs ? 'cancelled' : 'in-flight'} connect to ${pending?.host ?? '?'}`);
      return this.startConnect(host, username, password, port, useHttps, this.connectingPromise);
    }
    return this.startConnect(host, username, password, port, useHttps);
  }

  private startConnect(host: string, username: string, password: string, port?: number, useHttps?: boolean, supersedes?: Promise<void>): Promise<void> {
    const attempt: ConnectAttempt = { host, username, password, port, useHttps, epoch: this.connectEpoch };
    this.connectingArgs = attempt;
    const p = (async () => {
      if (supersedes) {
        await this.disconnectInternal();   // bumps connectEpoch → the in-flight doConnect unwinds
        attempt.epoch = this.connectEpoch; // our own cancel of the old attempt doesn't invalidate this one
        await supersedes.catch(() => {});  // let it finish unwinding before we start fresh
      }
      await this.doConnect(host, username, password, port, useHttps, attempt);
    })().finally(() => {
      // Only clear if we're still the current attempt — a superseding connect
      // may have replaced these fields while we were settling.
      if (this.connectingPromise === p) {
        this.connectingPromise = null;
        this.connectingArgs = null;
      }
    });
    this.connectingPromise = p;
    return p;
  }

  private async doConnect(host: string, username: string, password: string, port?: number, useHttps?: boolean, attempt?: ConnectAttempt): Promise<void> {
    // If we're already connected to the same controller, this is a no-op.
    // Without this, every accidental click of the Connect button burns a session
    // through the disconnect → /logout → /rw/system reconnect cycle.
    const cfg = this.adapterConfig;
    if (this._state.connected && cfg
        && cfg.host === host
        && (port === undefined || cfg.port === port)
        && cfg.username === username
        && cfg.password === password) {
      Logger.info(`connect → ${host}${port !== undefined ? ':' + port : ''} skipped (already connected)`);
      return;
    }

    if (this._state.connected) { await this.disconnectInternal(); }

    // Any disconnect() after this point (user click, removeRobot) bumps the
    // epoch; we re-check after every await so an aborted connect can't
    // resurrect timers or subscriptions. The attempt record mirrors the value
    // so connect() knows whether coalescing onto this attempt is still valid.
    // User cancellations additionally set attempt.cancelled, which survives
    // this re-read — otherwise a disconnect() racing our own teardown above
    // would be erased here and the connection resurrected.
    const epoch = this.connectEpoch;
    if (attempt) { attempt.epoch = epoch; }
    const aborted = (): boolean => attempt?.cancelled === true || epoch !== this.connectEpoch;
    if (attempt?.cancelled) {
      Logger.info(`connect → ${host} aborted (disconnected before probing)`);
      return;
    }

    Logger.info(`connect → ${host}${port !== undefined ? ':' + port : ' (auto-detect)'} as "${username}"`);

    let probe: ProbeResult;
    if (port !== undefined) {
      // Port is pinned in config — verify it's actually reachable with the right protocol.
      const verified = await RobotManager.probeSpecificPort(host, port, this.strictTls);
      if (verified) {
        probe = verified;
        Logger.info(`port ${port} verified: ${verified.useHttps ? 'HTTPS' : 'HTTP'}/${verified.authType}`);
      } else {
        // Saved port didn't respond — RobotStudio reassigns VC ports each restart.
        Logger.warn(`saved port ${port} not responding — scanning ${host} for an active controller…`);
        const expectedAuth = (useHttps ?? (port === 443 || port === 9403)) ? 'basic' : 'digest';

        // Phase 1: quick scan of the standard ports
        let candidates = await RobotManager.detectAllControllers(host, this.strictTls);

        // Phase 2: if nothing on standard ports and we're scanning localhost, do a wide scan
        if (candidates.length === 0 && (host === '127.0.0.1' || host === 'localhost')) {
          Logger.info(`standard ports empty — running wide scan 1024–30000 (this takes ~3 s)…`);
          const wide = await RobotManager.wideHostScan(host, this.strictTls);
          candidates = wide.map(c => ({ port: c.port, useHttps: c.useHttps, authType: c.authType }));
          Logger.info(`wide scan found ${candidates.length} ABB controller(s) on ${host}`);
        }

        const match = candidates.find(c => c.authType === expectedAuth) ?? candidates[0];
        if (match) {
          probe = match;
          Logger.info(`recovered: ${match.useHttps ? 'HTTPS' : 'HTTP'}/${match.authType} on port ${match.port} (saved was ${port})`);
        } else {
          // Last resort: try the saved port anyway — maybe a firewall blocks the probe but lets through auth
          const https_ = useHttps ?? (port === 443 || port === 9403);
          probe = { port, useHttps: https_, authType: https_ ? 'basic' : 'digest' };
          Logger.warn(`no controller found anywhere on ${host} — falling back to saved port ${port}`);
        }
      }
    } else {
      // Auto-detect: probe all common ports
      Logger.info(`auto-detecting controller at ${host} (ports 80, 443, 28447, 9403)`);
      const found = await RobotManager.detectController(host, this.strictTls);
      if (!found) {
        const err = `No ABB RWS controller found at ${host}.\nChecked ports: 80, 443, 28447, 9403.\nEnsure the controller is reachable and RWS is enabled.`;
        Logger.error(`auto-detect failed for ${host}`);
        throw new Error(err);
      }
      probe = found;
      Logger.info(`auto-detected: port ${probe.port} ${probe.useHttps ? 'HTTPS' : 'HTTP'}/${probe.authType}`);
    }

    if (aborted()) {
      Logger.info(`connect → ${host} aborted (disconnected while probing)`);
      return;
    }

    const cookieKey = `${host}:${probe.port}`;
    const prevCfg = this.adapterConfig;
    const sameConfig = prevCfg
      && prevCfg.host === host && prevCfg.username === username
      && prevCfg.password === password && prevCfg.port === probe.port;

    if (!this.adapter || !sameConfig) {
      if (probe.authType === 'basic') {
        const scheme = probe.useHttps ? 'https' : 'http';
        this.adapter = new RWS2Adapter(`${scheme}://${host}:${probe.port}`, username, password, { rejectUnauthorized: this.strictTls });
      } else {
        // Session cookie keyed by host:port so two controllers on same IP don't clobber each other
        const cookie = this.loadSessionCookie(cookieKey) ?? undefined;
        const rwsClient = new RwsClient({ host, port: probe.port, username, password, sessionCookie: cookie });
        this.adapter = new RWS1Adapter(rwsClient, { host, port: probe.port, username, password });
      }
      this.adapterConfig = { host, username, password, port: probe.port };
    }

    try {
      await this.adapter.connect();
    } catch (e) {
      Logger.error(`adapter.connect() failed for ${host}:${probe.port}`, e);
      throw e;
    }
    if (aborted()) {
      Logger.info(`connect → ${host} aborted (disconnected mid-connect) — closing session`);
      await this.adapter.disconnect().catch(() => {});
      return;
    }
    const cookie = this.adapter.getSessionCookie();
    if (cookie) { this.saveSessionCookie(cookieKey, cookie); }

    this._state.connected = true;
    this._state.host = host;
    Logger.info(`connected to ${host}:${probe.port}`);
    this.notify();

    // Start WebSocket subscriptions for instant state-change events.
    // If subscriptions succeed, polling runs at 5× refreshIntervalMs (positions only).
    // If they fail, polling runs at refreshIntervalMs (full state coverage as before).
    await this.startSubscriptions();
    if (aborted()) {
      Logger.info(`connect → ${host} aborted (disconnected during subscription setup)`);
      if (this.unsubscribeFn) { await this.unsubscribeFn().catch(() => {}); this.unsubscribeFn = null; }
      this.subscriptionActive = false;
      await this.adapter.disconnect().catch(() => {});
      return;
    }

    // Every connect() invalidates older polling cycles so any timer that
    // wasn't cleared (race between disconnect/reconnect) self-cancels.
    const myGeneration = ++this.pollGeneration;
    this.consecutiveFails = 0;

    await this.fetchAll(myGeneration);
    if (aborted()) { return; }
    const pollMs = this.subscriptionActive ? 5 * this.refreshIntervalMs : this.refreshIntervalMs;
    // Single-flight guard: if a fetchAll is still running when the timer
    // fires, skip this tick. Prevents the request pile-up that caused
    // 10-second timeouts on /cartesian and /tasks during heavy motion
    // (controller's RWS layer queues behind the motion planner — responses
    // can take >1s when joints are moving fast). Without this, a slow poll
    // would stack against the next-second poll, causing both to timeout.
    this.timer = setInterval(() => {
      if (this.fetchInFlight) { return; }
      this.fetchAll(myGeneration);
    }, pollMs);
  }

  async disconnect(): Promise<void> {
    // A user disconnect permanently cancels any in-flight connect attempt.
    // The flag (not just the epoch) is what makes it stick: doConnect re-reads
    // the epoch after its own internal teardowns, which would otherwise erase
    // this cancellation and resurrect the connection.
    if (this.connectingArgs) { this.connectingArgs.cancelled = true; }
    return this.disconnectInternal();
  }

  /** Teardown used by doConnect/startConnect for their own reconnect cycles — must not cancel the attempt that invoked it. */
  private async disconnectInternal(): Promise<void> {
    // Bump generation FIRST so any in-flight fetchAll calls bail before they
    // can trigger another disconnect cascade. The epoch likewise cancels any
    // in-flight doConnect() so it can't re-install timers/subscriptions.
    this.connectEpoch++;
    this.pollGeneration++;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Release any held motion mastership BEFORE closing the adapter
    await this.releaseJogMastership();
    // Unsubscribe WebSocket before closing adapter so DELETE /subscription fires correctly
    if (this.unsubscribeFn) {
      await this.unsubscribeFn().catch(() => {});
      this.unsubscribeFn = null;
    }
    this.subscriptionActive = false;
    if (this.adapter) { await this.adapter.disconnect().catch(() => {}); }
    this._state = {
      connected: false, host: '', ctrlstate: null, opmode: null,
      execstate: null, execCycle: null, speedRatio: null, coldetstate: null,
      tasks: [], modules: [], mechunits: [], joints: null,
      cartesian: null, cartesianFull: null, identity: null, systemInfo: null,
      eventLog: [], ioSignals: [],
    };
    this.notify();
  }

  async refresh(): Promise<void> { await this.fetchAll(); }

  // ─── Panel control ──────────────────────────────────────────────────────────

  async setMotorsOn(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.requestMastership('rapid');
    try { await this.adapter.setControllerState('motoron'); }
    finally { await this.adapter.releaseMastership('rapid').catch(() => {}); }
  }

  async setMotorsOff(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.requestMastership('rapid');
    try { await this.adapter.setControllerState('motoroff'); }
    finally { await this.adapter.releaseMastership('rapid').catch(() => {}); }
  }

  async setSpeedRatio(ratio: number): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.setSpeedRatio(ratio);
    this._state.speedRatio = ratio;
    this.notify();
  }

  async lockOperationMode(pin: string, permanent?: boolean): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.lockOperationMode(pin, permanent);
  }

  async unlockOperationMode(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.unlockOperationMode();
  }

  /**
   * Switch operation mode (AUTO/MANR/MANF). VC-only — real hardware respects
   * the FlexPendant key switch.
   *
   * State-machine constraints (ABB safety design):
   *   AUTO ↔ MANR: direct transition allowed.
   *   MANR ↔ MANF: direct transition allowed.
   *   AUTO ↔ MANF: NOT allowed direct — must go through MANR.
   *     Controller rejects with HTTP 500 "Operation failed" on the direct call.
   *     We auto-handle this by routing through MANR (two POSTs).
   *
   * Privilege:
   *   Going TO MANR/MANF: usually works without mastership (safer direction).
   *   Going TO AUTO: requires `edit` mastership + a confirmation popup on the
   *     FlexPendant. We wrap with mastership; the popup must be approved
   *     manually (no API path bypasses it — verified live).
   */
  async setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    if (!this.adapter.setOperationMode) { throw new Error('setOperationMode not exposed by this adapter'); }

    // Detect "must transit through MANR" pairs (AUTO ↔ MANF) and route via MANR.
    const current = this._state.opmode;
    const needsTransit =
      (current === 'AUTO' && mode === 'MANF') ||
      (current === 'MANF' && mode === 'AUTO');
    if (needsTransit) {
      Logger.info(`opmode: routing ${current} → MANR → ${mode} (direct transition not allowed)`);
      await this.setOpmodeOnce('MANR');
      // Brief pause so the controller settles the safety-chain state before the
      // second hop — direct back-to-back POSTs sometimes get the second one
      // rejected as "operation in progress."
      await new Promise(r => setTimeout(r, 600));
      await this.setOpmodeOnce(mode);
      return;
    }
    await this.setOpmodeOnce(mode);
  }

  /** Single hop. Used internally + as the building block for multi-hop transitions. */
  private async setOpmodeOnce(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void> {
    const goingToAuto = mode === 'AUTO';
    if (goingToAuto) {
      try { await this.adapter!.requestMastership('rapid'); } catch { /* keep going */ }
      try { await this.adapter!.setOperationMode!(mode); }
      finally { await this.adapter!.releaseMastership('rapid').catch(() => {}); }
      return;
    }
    await this.adapter!.setOperationMode!(mode);
  }

  // ─── RAPID execution ────────────────────────────────────────────────────────
  //
  // start/stop/resetpp/cycle all REQUIRE 'edit' mastership on RWS 2.0
  // (RWS 1.0 calls it 'rapid', the adapter aliases internally).
  // Live-confirmed: calling resetpp without mastership returns
  // HTTP 403 with org_code -4501 / new_code 0xc004841d which the controller
  // misleadingly tags as "RAPID error" — but the real cause is mastership.
  //
  // We acquire+release per-call so the manager doesn't hold mastership
  // longer than necessary (other clients can use the controller meanwhile).

  /**
   * Wrap an op with auto-acquire-and-release of 'rapid'/'edit' mastership.
   *
   * NOTE: We deliberately do NOT proactively check RMMP here. Doing so caused
   * false-positive errors when:
   *   - the controller is in AUTO mode and grants are sufficient without RMMP
   *   - the logged-in user lacks UAS grant to even *request* RMMP
   *   - the controller is a VC with no FlexPendant target for the popup
   *
   * Mastership-only is the right default. If the op fails because RMMP is
   * actually missing, the caller's error handler can offer a Request-RMMP
   * action — but it's a recovery path, not a precondition.
   */
  private async withMastership<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.requestMastership('rapid');
    try { return await fn(); }
    finally { await this.adapter.releaseMastership('rapid').catch(() => {}); }
  }

  // ─── Remote Mastership Privilege (RMMP) ──────────────────────────────────
  /** Get current RMMP — 'none' / 'pending modify' / 'modify' / 'exclusive'. */
  async getRmmpPrivilege(): Promise<string> {
    if (!this.adapter?.getRmmpPrivilege) { return 'unsupported'; }
    return this.adapter.getRmmpPrivilege();
  }
  /** Request RMMP — triggers a FlexPendant popup that the operator must approve. */
  async requestRmmp(level: 'modify' | 'exclusive' = 'modify'): Promise<void> {
    if (!this.adapter?.requestRmmp) { throw new Error('RMMP not supported on this controller'); }
    return this.adapter.requestRmmp(level);
  }

  /**
   * Tracks the last PP target the user explicitly chose via setPPToRoutine.
   * Used by startRapid() to re-apply on next start when execstate is 'stopped'.
   * Reason: when a routine completes (e.g. has `Stop;` at end, or cycle=once),
   * PP advances past the routine's last instruction. The next Start with
   * `execmode=continue` then does nothing visible — controller accepts the
   * call (HTTP 204) but there's nothing left to execute.
   * By re-applying the target on each Start-from-stopped, the user's mental
   * model becomes "Start runs the routine I picked" — every time.
   * Cleared by resetRapid() (PP-to-Main) so the user can then run main again.
   */
  private lastPPTarget: { module: string; routine: string } | null = null;

  /**
   * Start RAPID execution.
   * If the program is currently stopped AND the user previously set PP to a
   * specific routine via setPPToRoutine(), we re-apply that target before
   * starting. This makes "Start" reliable across multiple clicks: the chosen
   * routine runs from the top each time the program has finished and is
   * idle.
   * If the program is paused mid-execution (e.g. user hit Stop in the middle
   * of a long routine), the PP target is NOT re-applied — Start resumes
   * from where the user stopped.
   * Detection: if PP currently lives in `lastPPTarget.routine`, we assume
   * the user is in the "ran-then-stopped" state (PP at end-of-routine).
   * If PP is in some other routine (controller moved it for an interrupt,
   * trap, etc.), we leave it alone.
   */
  async startRapid(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.withMastership(async () => {
      const target = this.lastPPTarget;
      const stopped = this._state.execstate === 'stopped';
      if (target && stopped && this.adapter!.setProgramPointer) {
        // Best-effort: re-apply the target. If PP is still mid-routine
        // (paused, not finished), this is still safe — it just resets PP
        // to the start of the same routine.
        await this.adapter!.setProgramPointer(this.activeTaskName(), {
          module: target.module,
          routine: target.routine,
        }).catch(() => { /* swallow — start will surface its own error if any */ });
      }
      await this.adapter!.startRapid();
    });
  }

  /** Active task name — the task flagged active, else the first task, else T_ROB1. */
  private activeTaskName(): string {
    const active = this._state.tasks.find(t => t.active);
    return active?.name ?? this._state.tasks[0]?.name ?? 'T_ROB1';
  }

  async stopRapid(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.withMastership(() => this.adapter!.stopRapid());
  }
  async resetRapid(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    // PP-to-Main clears the routine target — Start will go to main from now on.
    this.lastPPTarget = null;
    await this.withMastership(() => this.adapter!.resetRapid());
  }

  async setExecutionCycle(cycle: 'once' | 'forever' | 'asis'): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.withMastership(() => this.adapter!.setExecutionCycle(cycle));
  }

  async activateRapidTask(task: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.activateRapidTask(task);
  }

  async deactivateRapidTask(task: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.deactivateRapidTask(task);
  }

  async activateAllRapidTasks(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.activateAllRapidTasks();
  }

  async deactivateAllRapidTasks(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.deactivateAllRapidTasks();
  }

  // ─── RAPID variables ────────────────────────────────────────────────────────

  async getRapidVariable(task: string, module: string, symbol: string): Promise<string> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.getRapidVariable(task, module, symbol);
  }

  async setRapidVariable(task: string, module: string, symbol: string, value: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.setRapidVariable(task, module, symbol, value);
  }

  async validateRapidValue(task: string, value: string, datatype: string): Promise<boolean> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.validateRapidValue(task, value, datatype);
  }

  async getRapidSymbolProperties(task: string, module: string, symbol: string): Promise<RapidSymbolProperties> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.getRapidSymbolProperties(task, module, symbol);
  }

  async searchRapidSymbols(params: RapidSymbolSearchParams): Promise<RapidSymbolInfo[]> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.searchRapidSymbols(params);
  }

  /**
   * Detailed list of loaded modules — each entry has `name` + `type` (SysMod / ProgMod).
   * Used by the Modules tree to render system vs program modules differently.
   * Falls back to bare names from `listModules` if the adapter doesn't support details.
   */
  async listModulesDetailed(task: string): Promise<Array<{ name: string; type: string }>> {
    if (!this.adapter) { throw new Error('Not connected'); }
    if (this.adapter.listModulesDetailed) {
      return this.adapter.listModulesDetailed(task);
    }
    const names = await this.adapter.listModules(task);
    return names.map(n => ({ name: n, type: '' }));
  }

  /**
   * Current program-pointer location for a task (module + routine + line).
   * Returns null if the controller can't currently report a PP (e.g. no
   * program loaded). Surfaces the data the Modules tree uses to highlight
   * which routine is "active".
   */
  async getCurrentPP(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number } | null> {
    if (!this.adapter?.getProgramPointer) { return null; }
    try { return await this.adapter.getProgramPointer(task); }
    catch { return null; }
  }

  /**
   * List the routines (PROCs, FUNCs, TRAPs) defined in a loaded module.
   * Uses the controller's symbol search rather than parsing the source —
   * works even when the module file isn't on disk anymore (e.g. it was
   * loaded then the file was deleted / never persisted).
   *
   * Returns: array of `{ name, symtyp }` where `symtyp` is one of:
   *   - 'prc'  procedure (no return value, callable)
   *   - 'fun'  function (returns a value)
   *   - 'trp'  trap (interrupt handler)
   * Routines from the controller's BASE / system modules are NOT included
   * unless `includeSystem=true`.
   */
  async listRoutines(
    task: string,
    moduleName: string,
    includeSystem = false,
  ): Promise<Array<{ name: string; symtyp: string; symburl: string; local: boolean }>> {
    if (!this.adapter) { throw new Error('Not connected'); }
    const symbols = await this.adapter.searchRapidSymbols({
      task,
      blockurl: `RAPID/${task}/${moduleName}`,
      symtyp:   'any',
      // `recursive` accepts boolean in our type; the wire format is upper-case 'TRUE'
      // and the adapter stringifies. Lib's default already sets 'TRUE' if omitted.
    });
    const routineKinds = new Set(['prc', 'fun', 'trp']);
    return symbols
      .filter(s => routineKinds.has(s.symtyp.toLowerCase()))
      .filter(s => includeSystem || !s.local /* keep public; refine if needed */)
      .map(s => ({ name: s.name, symtyp: s.symtyp, symburl: s.symburl, local: s.local }));
  }

  /**
   * Set the program pointer to a specific routine, optionally in a specific module.
   * If `module` is omitted, the controller picks based on its current scope.
   * Wraps with `edit`/`rapid` mastership.
   *
   * After this returns successfully, the user can click Start and execution
   * will begin at this routine instead of `main`.
   */
  async setPPToRoutine(task: string, moduleName: string, routine: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    if (!this.adapter.setProgramPointer) { throw new Error('setProgramPointer not supported on this protocol'); }
    await this.withMastership(async () => {
      await this.adapter!.stopRapid().catch(() => {});
      await this.adapter!.setProgramPointer!(task, { module: moduleName, routine });
    });
    // Remember so startRapid() can re-apply on subsequent clicks once PP advances past the end.
    this.lastPPTarget = { module: moduleName, routine };
  }

  async getActiveUiInstruction(): Promise<UiInstruction | null> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.getActiveUiInstruction();
  }

  async setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.setUiInstructionParam(stackurl, uiparam, value);
  }

  // ─── File system ────────────────────────────────────────────────────────────

  async listDirectory(remotePath: string): Promise<FileEntry[]>  {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.listDirectory(remotePath);
  }

  async readFile(remotePath: string): Promise<string> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.readFile(remotePath);
  }

  async deleteControllerFile(remotePath: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.deleteFile(remotePath);
  }

  /**
   * Create a directory on the controller filesystem.
   * If `parentPath` itself doesn't exist, recursively creates the missing
   * parents under the volume root ($HOME / HOME / BACKUP / …). This is
   * mkdir -p semantics — friendlier than the bare ABB endpoint which
   * returns 404 "Path does not exist" if any intermediate is missing.
   */
  async createDirectory(parentPath: string, dirName: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    try {
      await this.adapter.createDirectory(parentPath, dirName);
      return;
    } catch (e) {
      // 404 "Path does not exist" → ensure parents exist, then retry once.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/HTTP 404|Path does not exist/i.test(msg)) { throw e; }
      await this.ensureDirectory(parentPath);
      await this.adapter.createDirectory(parentPath, dirName);
    }
  }

  /**
   * Walk down `path` from the volume root, creating each missing segment.
   * Volumes ($HOME, HOME, BACKUP, DATA, …) themselves are NEVER created —
   * they're controller-managed.
   */
  private async ensureDirectory(targetPath: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    // Strip leading slash if any; first segment is the volume name.
    const cleaned = targetPath.replace(/^\/+/, '');
    const segments = cleaned.split('/').filter(Boolean);
    if (segments.length <= 1) { return; } // just a volume — caller can't create that
    // Walk: $HOME, $HOME/a, $HOME/a/b, ...
    let cursor = segments[0]; // the volume
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      try {
        await this.adapter.createDirectory(cursor, seg);
      } catch (e) {
        // 409-ish "already exists" or 200 — treat as ok. Other errors propagate.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/already exists|HTTP 200|HTTP 204|409/i.test(msg)) {
          // Path didn't exist AND we couldn't create it — keep walking but
          // re-throw at the end if the final create fails. (One forgiving pass.)
          if (!/HTTP 404|Path does not exist/i.test(msg)) { throw e; }
        }
      }
      cursor = `${cursor}/${seg}`;
    }
  }

  async copyControllerFile(sourcePath: string, destPath: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.copyFile(sourcePath, destPath);
  }

  // ─── Event log ──────────────────────────────────────────────────────────────

  async refreshEventLog(): Promise<void> {
    if (!this.adapter) { return; }
    try { this._state.eventLog = await this.adapter.getEventLog(0, 'en'); this.notify(); }
    catch { /* non-fatal */ }
  }

  async clearEventLog(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.clearEventLog(0);
    this._state.eventLog = [];
    this.notify();
  }

  async clearAllEventLogs(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.clearAllEventLogs();
    this._state.eventLog = [];
    this.notify();
  }

  // ─── Controller info ─────────────────────────────────────────────────────────

  async restartController(mode: RestartMode): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.restartController(mode);
  }

  async getControllerClock(): Promise<string> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return (await this.adapter.getControllerClock()).datetime;
  }

  async setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.setControllerClock(year, month, day, hour, min, sec);
  }

  // ─── I/O ─────────────────────────────────────────────────────────────────────

  async refreshIoSignals(): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    const PAGE = 100;
    let start = 0;
    const all: Signal[] = [];
    while (true) {
      const page = await this.adapter.listAllSignals(start, PAGE);
      all.push(...page);
      if (page.length < PAGE) { break; }
      start += PAGE;
    }
    this._state.ioSignals = all;
    this.notify();
  }

  async writeIoSignal(name: string, value: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.writeSignal('', '', name, value);
    const sig = this._state.ioSignals.find(s => s.name === name);
    if (sig) { sig.lvalue = value; sig.value = value; this.notify(); }
  }

  async readIoSignal(network: string, device: string, name: string): Promise<Signal> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.readSignal(network, device, name);
  }

  async listNetworks(): Promise<IoNetwork[]> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.listNetworks();
  }

  async listDevices(network: string): Promise<IoDevice[]> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.listDevices(network);
  }

  // ─── Program loading ─────────────────────────────────────────────────────────

  /**
   * Upload a single .mod / .sys file and load it into a task.
   *
   * Behavior:
   *   1. Stop RAPID briefly so the symbol table isn't being mutated mid-load.
   *   2. **If a module with the same name (= file basename without ext) is
   *      already loaded, unload it first.** Live-verified gotcha: passing
   *      `replace=true` to loadmod refreshes the *file* but the program's
   *      symbol table still references the OLD module's procedures, so
   *      `resetRapid()` afterwards reports "no main" even though the new
   *      file has one. Explicit unload + load fixes this.
   *   3. Upload the file to $HOME (or HOME/ on RWS 2.0 — adapter rewrites).
   *   4. loadModule the new file.
   *   5. **If the new module declares `PROC main()`, auto-call PP-to-Main.**
   *      This restores the original v0.1 ergonomics without the destructive
   *      behavior the earlier loadProgram had — the user can immediately
   *      click Start. Failures during the auto-resetpp are swallowed (the
   *      module loaded fine; the user can manually click PP-to-Main if
   *      needed). Detect by regex over the file content.
   *   6. **Does NOT unload OTHER modules.** Old versions unloaded every
   *      non-system module, which destroyed the controller's pre-existing
   *      program (e.g. OmniCore's `Module1`).
   */
  async loadProgram(localFilePath: string, taskName: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }

    await this.adapter.requestMastership('rapid');
    try {
      await this.adapter.stopRapid().catch(() => {});

      const content    = fs.readFileSync(localFilePath, 'utf8');
      const fileName   = path.basename(localFilePath);
      const moduleName = fileName.replace(/\.(mod|sys)$/i, '');
      const remotePath = `$HOME/${fileName}`;

      const existing = await this.adapter.listModules(taskName).catch(() => [] as string[]);
      if (existing.includes(moduleName)) {
        await this.adapter.unloadModule(taskName, moduleName).catch(() => {});
      }

      await this.adapter.uploadFile(remotePath, content);
      await this.adapter.loadModule(taskName, remotePath, true);
      this._state.modules = await this.adapter.listModules(taskName);
      this.notify();

      // If the new module has a main proc, auto-resetpp so the user can Start
      // immediately. Match `PROC main(` allowing whitespace + comments above.
      // Errors here are non-fatal — the module loaded successfully even if
      // PP-to-Main fails (e.g. another module's main collides; user resolves manually).
      const hasMainProc = /\bPROC\s+main\s*\(/i.test(content);
      if (hasMainProc) {
        await this.adapter.resetRapid().catch(() => { /* user can do this manually */ });
      }
    } finally {
      await this.adapter.releaseMastership('rapid').catch(() => {});
    }
  }

  /** @deprecated use loadProgram */
  uploadAndLoad(p: string, t: string) { return this.loadProgram(p, t); }

  /**
   * Unload a single RAPID module from a task. Useful for resolving a
   * `main`-proc collision: if two modules both define `PROC main()`, RWS
   * refuses PP-to-Main with a semantic error — unload one and the other
   * becomes the program's entry point.
   */
  async unloadModule(taskName: string, moduleName: string): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }
    await this.adapter.requestMastership('rapid');
    try {
      await this.adapter.stopRapid().catch(() => {});
      await this.adapter.unloadModule(taskName, moduleName);
      this._state.modules = await this.adapter.listModules(taskName);
      this.notify();
    } finally {
      await this.adapter.releaseMastership('rapid').catch(() => {});
    }
  }

  // ─── New verified endpoints (exposed for commands) ────────────────────────

  async getLicenseInfo() { return this.adapter?.getLicenseInfo?.() ?? { entries: [] }; }
  async listProducts()    { return this.adapter?.listProducts?.() ?? []; }
  async getRobotType(): Promise<{ type: string; variant?: string }> { return this.adapter?.getRobotType?.() ?? { type: '' }; }
  async getEnergyStats()  { return this.adapter?.getEnergyStats?.() ?? {}; }
  async getReturnCode(code: number, lang = 'en') { return this.adapter?.getReturnCode?.(code, lang) ?? null; }
  async listControllerOptions() { return this.adapter?.listControllerOptions?.() ?? []; }
  async listFeatures()    { return this.adapter?.listFeatures?.() ?? []; }
  async getMotionChangeCount() { return this.adapter?.getMotionChangeCount?.() ?? 0; }
  async getMotionErrorState()  { return this.adapter?.getMotionErrorState?.() ?? { state: 'unknown' }; }
  async getNonMotionExecution(){ return this.adapter?.getNonMotionExecution?.() ?? false; }
  async setNonMotionExecution(enabled: boolean) { return this.adapter?.setNonMotionExecution?.(enabled); }
  async getCollisionPredictionMode()      { return this.adapter?.getCollisionPredictionMode?.() ?? 'OFF'; }
  async setCollisionPredictionMode(m: string) { return this.adapter?.setCollisionPredictionMode?.(m); }
  async getEnableRequest() { return this.adapter?.getEnableRequest?.() ?? { state: 'unknown', raw: {} }; }
  async listAliasIO()     { return this.adapter?.listAliasIO?.() ?? []; }
  async getTaskSelection(){ return this.adapter?.getTaskSelection?.() ?? { selected: [], available: [] }; }
  async setTaskSelection(tasks: string[]) { return this.adapter?.setTaskSelection?.(tasks); }
  async getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> { return this.adapter?.getProgramPointer?.(task) ?? {}; }
  async getMotionPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> { return this.adapter?.getMotionPointer?.(task) ?? {}; }

  // CFG
  async listCfgDomains()  { return this.adapter?.listCfgDomains?.() ?? []; }
  async listCfgTypes(d: string) { return this.adapter?.listCfgTypes?.(d) ?? []; }
  async listCfgInstances(d: string, t: string) { return this.adapter?.listCfgInstances?.(d, t) ?? []; }
  async getCfgInstance(d: string, t: string, i: string) { return this.adapter?.getCfgInstance?.(d, t, i) ?? {}; }
  async setCfgInstance(d: string, t: string, i: string, attrs: Record<string, string>): Promise<void> {
    if (!this.adapter?.setCfgInstance) { throw new Error('setCfgInstance not supported'); }
    await this.withMastership(() => this.adapter!.setCfgInstance!(d, t, i, attrs));
  }
  async createCfgInstance(d: string, t: string, i: string, attrs: Record<string, string>): Promise<void> {
    if (!this.adapter?.createCfgInstance) { throw new Error('createCfgInstance not supported'); }
    await this.withMastership(() => this.adapter!.createCfgInstance!(d, t, i, attrs));
  }
  async removeCfgInstance(d: string, t: string, i: string): Promise<void> {
    if (!this.adapter?.removeCfgInstance) { throw new Error('removeCfgInstance not supported'); }
    await this.withMastership(() => this.adapter!.removeCfgInstance!(d, t, i));
  }
  async loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset' = 'add'): Promise<void> {
    if (!this.adapter?.loadCfgFile) { throw new Error('loadCfgFile not supported'); }
    await this.withMastership(() => this.adapter!.loadCfgFile!(filepath, action));
  }
  async saveCfgFile(domain: string, filepath: string): Promise<void> {
    if (!this.adapter?.saveCfgFile) { throw new Error('saveCfgFile not supported'); }
    await this.withMastership(() => this.adapter!.saveCfgFile!(domain, filepath));
  }

  // Backup / restore
  async listBackups()      { return this.adapter?.listBackups?.() ?? []; }
  async createBackup(n: string) {
    if (!this.adapter?.createBackup) { throw new Error('createBackup not supported'); }
    return this.adapter.createBackup(n);
  }
  async restoreBackup(n: string) {
    if (!this.adapter?.restoreBackup) { throw new Error('restoreBackup not supported'); }
    return this.adapter.restoreBackup(n);
  }
  async getBackupStatus(): Promise<{ active: boolean; progress?: number; phase?: string }> { return this.adapter?.getBackupStatus?.() ?? { active: false }; }

  // Module info / source / symbols / service-routine / tool-wobj activation
  // (getModuleSource, listModuleSymbols, calcCartesianFromJoints already
  // defined further below in this file.)
  async getModuleInfo(task: string, moduleName: string): Promise<Record<string, string>> {
    if (!this.adapter?.getModuleInfo) { return {}; }
    return this.adapter.getModuleInfo(task, moduleName);
  }
  async callServiceRoutine(task: string, routineName: string, args?: Record<string, string>): Promise<void> {
    if (!this.adapter?.callServiceRoutine) { throw new Error('callServiceRoutine not supported'); }
    return this.adapter.callServiceRoutine(task, routineName, args);
  }
  async setActiveTool(mechunit: string, toolName: string): Promise<void> {
    if (!this.adapter?.setActiveTool) { throw new Error('setActiveTool not supported'); }
    return this.adapter.setActiveTool(mechunit, toolName);
  }
  async setActiveWobj(mechunit: string, wobjName: string): Promise<void> {
    if (!this.adapter?.setActiveWobj) { throw new Error('setActiveWobj not supported'); }
    return this.adapter.setActiveWobj(mechunit, wobjName);
  }

  // DIPC — Distributed Inter-Process Communication. Lets RAPID and external
  // clients exchange typed messages through named queues.
  async listDipcQueues() {
    if (!this.adapter?.listDipcQueues) { return []; }
    return this.adapter.listDipcQueues();
  }
  async createDipcQueue(name: string, options?: { maxsize?: number; maxmessages?: number }) {
    if (!this.adapter?.createDipcQueue) { throw new Error('DIPC not supported'); }
    return this.adapter.createDipcQueue(name, options);
  }
  async sendDipcMessage(queue: string, payload: string, type: 'string' | 'num' | 'dnum' | 'bool' = 'string') {
    if (!this.adapter?.sendDipcMessage) { throw new Error('DIPC not supported'); }
    return this.adapter.sendDipcMessage(queue, payload, type);
  }
  async readDipcMessage(queue: string, timeoutMs?: number) {
    if (!this.adapter?.readDipcMessage) { throw new Error('DIPC not supported'); }
    return this.adapter.readDipcMessage(queue, timeoutMs);
  }
  async removeDipcQueue(name: string) {
    if (!this.adapter?.removeDipcQueue) { throw new Error('DIPC not supported'); }
    return this.adapter.removeDipcQueue(name);
  }

  // File volumes (HOME, BACKUP, DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP)
  async listFileVolumes(): Promise<string[]> {
    if (!this.adapter?.listFileVolumes) { return ['HOME']; }   // safe default
    return this.adapter.listFileVolumes();
  }

  // (validateRapidValue defined earlier; compressPath kept on adapter only)
  async compressPath(source: string, destination: string): Promise<void> {
    if (!this.adapter?.compressPath) { throw new Error('Compress not supported on this protocol'); }
    return this.adapter.compressPath(source, destination);
  }

  // Tool/WObj
  async getActiveTool(m?: string)    { return this.adapter?.getActiveTool?.(m) ?? { name: '' }; }
  async getActiveWobj(m?: string)    { return this.adapter?.getActiveWobj?.(m) ?? { name: '' }; }
  async getActivePayload(m?: string) { return this.adapter?.getActivePayload?.(m) ?? { name: '' }; }

  // Vision/Safety/VirtualTime
  async listVisionSystems() { return this.adapter?.listVisionSystems?.() ?? []; }
  async getSafetyStatus()   { return this.adapter?.getSafetyStatus?.() ?? { state: 'unavailable' }; }
  async getVirtualTime()    { return this.adapter?.getVirtualTime?.() ?? { time: 0, running: false }; }
  async setVirtualTimeRunning(r: boolean) { return this.adapter?.setVirtualTimeRunning?.(r); }
  async setVirtualTimeScale(s: number)    { return this.adapter?.setVirtualTimeScale?.(s); }

  // Mechunit details
  async getMechunitBaseFrame(m?: string) { return this.adapter?.getMechunitBaseFrame?.(m) ?? null; }
  async getMechunitAxes(m?: string)      { return this.adapter?.getMechunitAxes?.(m) ?? []; }
  async getMechunitInfo(m?: string)      { return this.adapter?.getMechunitInfo?.(m) ?? {}; }

  // Task details
  async getTaskStructuralChangeCount(t: string) { return this.adapter?.getTaskStructuralChangeCount?.(t) ?? 0; }
  async getTaskMotion(t: string)            { return this.adapter?.getTaskMotion?.(t) ?? {}; }
  async getTaskActivationRecord(t: string)  { return this.adapter?.getTaskActivationRecord?.(t) ?? {}; }
  async getTaskProgramInfo(t: string)       { return this.adapter?.getTaskProgramInfo?.(t) ?? {}; }

  // Module
  async getModuleSource(t: string, n: string) { return this.adapter?.getModuleSource?.(t, n) ?? ''; }
  async listModuleSymbols(t: string, n: string) { return this.adapter?.listModuleSymbols?.(t, n) ?? []; }

  // ─── Inverse + Forward Kinematics ───────────────────────────────────────────

  async calcJointsFromCartesian(
    pos: RobTarget,
    seedJoints?: JointTarget,
    mechunit?: string,
  ): Promise<JointTarget> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.calcJointsFromCartesian(pos, seedJoints, mechunit);
  }

  async calcCartesianFromJoints(joints: JointTarget, mechunit = 'ROB_1', tool = 'tool0', wobj = 'wobj0'): Promise<RobTarget> {
    if (!this.adapter) { throw new Error('Not connected'); }
    if (!this.adapter.calcCartesianFromJoints) { throw new Error('Forward kinematics not supported on this protocol'); }
    return this.adapter.calcCartesianFromJoints(joints, mechunit, tool, wobj);
  }

  // ─── Devices ─────────────────────────────────────────────────────────────────

  async listSystemDevices(): Promise<Array<{ id: string; name: string }>> {
    if (!this.adapter?.listSystemDevices) { return []; }
    return this.adapter.listSystemDevices();
  }
  async listAllIoDevices(): Promise<Array<{ name: string; network: string; lstate: string; pstate: string; address: string }>> {
    if (!this.adapter?.listAllIoDevices) { return []; }
    return this.adapter.listAllIoDevices();
  }

  // ─── Mastership extras ───────────────────────────────────────────────────────

  async requestMastershipAll(): Promise<void> {
    if (!this.adapter?.requestMastershipAll) { throw new Error('requestMastershipAll not supported'); }
    return this.adapter.requestMastershipAll();
  }
  async releaseMastershipAll(): Promise<void> {
    if (!this.adapter?.releaseMastershipAll) { throw new Error('releaseMastershipAll not supported'); }
    return this.adapter.releaseMastershipAll();
  }
  async requestMastershipWithId(domain: 'rapid' | 'cfg' | 'motion'): Promise<number> {
    if (!this.adapter?.requestMastershipWithId) { throw new Error('Token-based mastership requires RWS 2.0'); }
    return this.adapter.requestMastershipWithId(domain);
  }
  async releaseMastershipWithId(domain: 'rapid' | 'cfg' | 'motion', id: number): Promise<void> {
    if (!this.adapter?.releaseMastershipWithId) { throw new Error('Token-based mastership requires RWS 2.0'); }
    return this.adapter.releaseMastershipWithId(domain, id);
  }
  async resetMastershipWatchdog(): Promise<void> {
    if (!this.adapter?.resetMastershipWatchdog) { throw new Error('Mastership watchdog requires RobotWare 7.8+'); }
    return this.adapter.resetMastershipWatchdog();
  }

  /** Query who currently holds mastership on a domain. Returns null if adapter doesn't support it. */
  async getMastershipStatus(domain: 'rapid' | 'cfg' | 'motion' = 'rapid'): Promise<{ mastership: string; uid?: string; application?: string } | null> {
    if (!this.adapter?.getMastershipStatus) { return null; }
    try { return await this.adapter.getMastershipStatus(domain); }
    catch { return null; }
  }

  // ─── Jogging ──────────────────────────────────────────────────────────────────

  /** Tracks whether motion mastership is currently held — avoids redundant requests on rapid jog clicks. */
  private motionMastershipHeld = false;
  private jogReleaseTimer: NodeJS.Timeout | null = null;

  /**
   * Jog the robot. Wraps the adapter call with safety checks and mastership.
   * Requests motion mastership on first call, releases 2s after the last call
   * (so rapid successive jogs don't churn mastership).
   */
  async jog(params: {
    mode: 'Joint' | 'Cartesian';
    axes: [number, number, number, number, number, number];
    speed: number;
    mechunit?: string;
  }): Promise<void> {
    if (!this.adapter) { throw new Error('Not connected'); }

    // Safety: only allow jog in manual modes
    const mode = this._state.opmode;
    if (mode === 'AUTO') {
      throw new Error(`Jogging is not allowed in AUTO mode. Switch the controller to MANR or MANF first.`);
    }
    // Safety: motors must be on
    if (this._state.ctrlstate !== 'motoron') {
      throw new Error(`Motors are off (state: ${this._state.ctrlstate}). Turn motors on before jogging.`);
    }

    // Ensure RMMP (Remote Mastership Privilege) — required for ANY modify op via RWS.
    // Without this, jog returns 403 "Operation not allowed for user".
    if (this.adapter.getRmmpPrivilege && this.adapter.requestRmmp) {
      const priv = await this.adapter.getRmmpPrivilege().catch(() => 'none');
      if (priv === 'none') {
        await this.adapter.requestRmmp('modify');
        Logger.warn('RMMP requested — open FlexPendant and approve the remote-control popup, then click jog again');
        throw new Error('Remote control not authorized yet. Open the FlexPendant and approve the popup that asks "Allow remote user to modify?", then click jog again.');
      }
      if (priv.startsWith('pending')) {
        throw new Error('Remote control approval is still pending. Open the FlexPendant and approve the popup, then click jog again.');
      }
      // 'modify' or 'exclusive' — proceed
    }

    if (!this.motionMastershipHeld) {
      await this.adapter.requestMastership('motion');
      this.motionMastershipHeld = true;
    }

    // Reset the auto-release timer on every jog so it only fires after 2 s of no jogging
    if (this.jogReleaseTimer) { clearTimeout(this.jogReleaseTimer); }
    this.jogReleaseTimer = setTimeout(() => { this.releaseJogMastership().catch(() => {}); }, 2000);

    await this.adapter.jog(params);
  }

  /** Release motion mastership immediately (called by disconnect and the auto-release timer). */
  private async releaseJogMastership(): Promise<void> {
    if (this.jogReleaseTimer) { clearTimeout(this.jogReleaseTimer); this.jogReleaseTimer = null; }
    if (this.motionMastershipHeld && this.adapter) {
      await this.adapter.releaseMastership('motion').catch(() => {});
      this.motionMastershipHeld = false;
    }
  }

  async downloadModule(moduleName: string): Promise<string> {
    if (!this.adapter) { throw new Error('Not connected'); }
    return this.adapter.readFile(`$HOME/${moduleName}.mod`);
  }

  // ─── Session cookie (RWS 1.0 only) ──────────────────────────────────────────

  // ─── WebSocket subscriptions ──────────────────────────────────────────────────

  /**
   * Subscribe to state-change events for instant UI updates.
   * Non-fatal: if subscriptions fail (e.g. controller doesn't support WS),
   * polling covers all state at full frequency.
   */
  private async startSubscriptions(): Promise<void> {
    if (!this.adapter) { return; }
    try {
      this.unsubscribeFn = await this.adapter.subscribe(
        [
          'controllerstate',
          'operationmode',
          'speedratio',
          'execution',
          'coldetstate',
          { type: 'elog', domain: 0 },
        ],
        event => this.handleSubscriptionEvent(event),
        () => this.handleSubscriptionLost(),
      );
      this.subscriptionActive = true;
    } catch (e) {
      this.subscriptionActive = false;
      // Not an error — polling is the fallback
      console.log(
        `[RobotManager] WS subscriptions unavailable, using polling only: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  /**
   * Adapter reports the event stream as terminally lost (WS reconnect attempts
   * exhausted). Drop back to the fast polling cadence so state stays fresh —
   * without this the manager keeps the 5× slow poll and the UI goes stale.
   */
  private handleSubscriptionLost(): void {
    if (!this.subscriptionActive) { return; }
    this.subscriptionActive = false;
    Logger.warn('live event stream lost — resuming fast polling');
    if (!this._state.connected || !this.timer) { return; }
    clearInterval(this.timer);
    const myGeneration = this.pollGeneration;
    this.timer = setInterval(() => {
      if (this.fetchInFlight) { return; }
      this.fetchAll(myGeneration);
    }, this.refreshIntervalMs);
  }

  private handleSubscriptionEvent(event: SubscriptionEvent): void {
    if (!this._state.connected) { return; }
    let changed = false;

    // event.resource can be a friendly name ('controllerstate') from RWS 1.0 via abb-rws-client,
    // or a URL path ('/rw/panel/ctrl-state;ctrlstate') from RWS 2.0.
    // RWS2Adapter.resourcePathToName() normalizes before calling here, but we also
    // match URL fragments as a safety net so both paths work regardless of adapter.
    const r = event.resource;

    const isCtrlState = r === 'controllerstate' || /\/(ctrlstate|ctrl-state)/.test(r);
    const isOpMode    = r === 'operationmode'   || /\/opmode/.test(r);
    const isSpeed     = r === 'speedratio'      || /\/speedratio/.test(r);
    const isExec      = (r === 'execution'      || /\/execution/.test(r)) && !/execycle/.test(r);
    const isColdet    = r === 'coldetstate'     || /\/coldetstate/.test(r);
    const isElog      = r === 'elog'            || /\/elog\//.test(r);

    if (isCtrlState) {
      if (this._state.ctrlstate !== event.value) { this._state.ctrlstate = event.value; changed = true; }
    } else if (isOpMode) {
      if (this._state.opmode !== event.value) { this._state.opmode = event.value; changed = true; }
    } else if (isSpeed) {
      const n = Number(event.value);
      if (!isNaN(n) && this._state.speedRatio !== n) { this._state.speedRatio = n; changed = true; }
    } else if (isExec) {
      if (this._state.execstate !== event.value) { this._state.execstate = event.value; changed = true; }
    } else if (isColdet) {
      if (this._state.coldetstate !== event.value) {
        this._state.coldetstate = event.value as CollisionDetectionState;
        changed = true;
      }
    } else if (isElog) {
      // New elog message arrived — refresh the log asynchronously
      this.adapter?.getEventLog(0, 'en').then(log => {
        this._state.eventLog = log;
        this.notify();
      }).catch(() => {});
      return; // notify() called inside the promise above
    }

    if (changed) { this.notify(); }
  }

  // ─── Session cookie ──────────────────────────────────────────────────────────

  private loadSessionCookie(host: string): string | null {
    try { return (JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))[host] as string) ?? null; }
    catch { return null; }
  }

  private saveSessionCookie(host: string, cookie: string): void {
    try {
      let data: Record<string, string> = {};
      try { data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { /* new file */ }
      data[host] = cookie;
      // The file is shared across every RobotManager (and every host process),
      // so replace it atomically: write a temp file in the same directory,
      // then rename over the real one. A plain write lets a concurrent
      // manager read a half-written file and drop entries.
      const tmp = `${SESSION_FILE}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      try {
        fs.renameSync(tmp, SESSION_FILE);
      } catch {
        // A concurrent writer beat us to the rename (Windows briefly locks the
        // destination) — drop our temp file and let the other writer win; the
        // cookie is re-saved on the next connect anyway.
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      }
    } catch { /* non-fatal */ }
  }

  // ─── Polling ─────────────────────────────────────────────────────────────────

  private fetchCount = 0;
  /** Consecutive poll failures — only disconnects after 3, so transient blips don't drop the connection. */
  private consecutiveFails = 0;

  private fetchInFlight = false;

  private async fetchAll(generation?: number): Promise<void> {
    // Bail if this fetch belongs to an old generation (we've reconnected or
    // disconnected since). Re-checked after every await below — a disconnect
    // mid-poll clears _state, and a late-resolving request must not resurrect
    // the stale snapshot into it.
    const stale = (): boolean => generation !== undefined && generation !== this.pollGeneration;
    if (stale()) { return; }
    if (!this.adapter) { return; }
    if (this.fetchInFlight) { return; }
    this.fetchInFlight = true;
    try {
      const [execInfo, ctrlstate, opmode, speedRatio, tasks, joints, cartesianFull] =
        await Promise.all([
          this.adapter.getRapidExecutionInfo(),
          this.adapter.getControllerState(),
          this.adapter.getOperationMode(),
          this.adapter.getSpeedRatio(),
          this.adapter.getRapidTasks(),
          this.adapter.getJointPositions(),
          this.adapter.getCartesianFull(),
        ]);
      if (stale()) { return; }

      // Module list needs a task name — resolve it from the tasks we just
      // fetched, not a hardcoded T_ROB1 (multi-task systems and OmniCore
      // single-arm variants name their tasks differently).
      this._state.tasks = tasks;
      const modules = await this.adapter.listModules(this.activeTaskName());
      if (stale()) { return; }

      const cartesian = { x: cartesianFull.x, y: cartesianFull.y, z: cartesianFull.z, q1: cartesianFull.q1, q2: cartesianFull.q2, q3: cartesianFull.q3, q4: cartesianFull.q4 };
      Object.assign(this._state, {
        ctrlstate, opmode, execstate: execInfo.state, execCycle: execInfo.cycle,
        speedRatio, tasks, modules, joints, cartesian, cartesianFull,
      });

      const coldetstate = await this.adapter.getCollisionDetectionState().catch(() => null);
      if (stale()) { return; }
      this._state.coldetstate = coldetstate;

      this.fetchCount++;
      // Identity / systemInfo / eventLog / mechunits — only refresh occasionally,
      // BUT keep retrying every poll until they're populated (so a transient first-poll
      // failure doesn't leave the Status panel stuck on the IP fallback forever).
      const needSlowFetch =
        this.fetchCount === 1 ||
        this.fetchCount % 30 === 0 ||
        !this._state.systemInfo ||
        !this._state.identity;

      if (needSlowFetch) {
        const [identity, systemInfo, eventLog, mechunits] = await Promise.all([
          this.adapter.getControllerIdentity().catch(e => { Logger.warn(`getControllerIdentity failed: ${e instanceof Error ? e.message : String(e)}`); return null; }),
          this.adapter.getSystemInfo().catch(e => { Logger.warn(`getSystemInfo failed: ${e instanceof Error ? e.message : String(e)}`); return null; }),
          this.adapter.getEventLog(0, 'en').catch(e => { Logger.warn(`getEventLog failed: ${e instanceof Error ? e.message : String(e)}`); return [] as ElogMessage[]; }),
          this.adapter.listMechunits().catch(e => { Logger.warn(`listMechunits failed: ${e instanceof Error ? e.message : String(e)}`); return ['ROB_1']; }),
        ]);
        if (stale()) { return; }
        if (identity)   { this._state.identity   = identity; }
        if (systemInfo) { this._state.systemInfo  = systemInfo; }
        this._state.eventLog  = eventLog;
        this._state.mechunits = mechunits;
      }

      if (this.fetchCount === 1 || this.fetchCount % 5 === 0) {
        const PAGE = 100;
        let start = 0;
        const all: Signal[] = [];
        try {
          while (true) {
            const page = await this.adapter.listAllSignals(start, PAGE);
            if (stale()) { return; }
            all.push(...page);
            if (page.length < PAGE) { break; }
            start += PAGE;
          }
          this._state.ioSignals = all;
        } catch { /* non-fatal */ }
      }

      if (stale()) { return; }
      this.consecutiveFails = 0;
      this.notify();
    } catch (e) {
      // Stale poll (disconnect or reconnect happened mid-flight) — don't count this failure.
      if (stale()) { return; }

      this.consecutiveFails++;
      // First failure is usually transient (controller queued behind motion).
      // Log at info-level for the first; only warn from the second onward.
      const msg = `poll failed (${this.consecutiveFails}/3) — ${e instanceof Error ? e.message : String(e)}`;
      if (this.consecutiveFails >= 2) { Logger.warn(msg); }
      else                            { Logger.info(msg); }
      if (this.consecutiveFails >= 3) {
        const reason = e instanceof Error ? e.message : String(e);
        Logger.error(`disconnecting after 3 failed polls`, e);
        Logger.show();
        // Capture config BEFORE disconnect (which clears it) so the Reconnect button works.
        // Internal variant: this tears down the DEAD connection — it must not
        // cancel a fresh connect attempt the user may have started meanwhile.
        const cfg = this.adapterConfig;
        await this.disconnectInternal();
        // Hand off to the host's error listener (VS Code extension, CLI, etc.).
        // If no listener is installed, the failure is silent beyond the log lines above.
        if (this.errorListener) {
          this.errorListener(`ABB Robot disconnected: ${reason}`, ['Show Logs', 'Reconnect']).then(choice => {
            if (choice === 'Show Logs') { Logger.show(); }
            if (choice === 'Reconnect' && cfg) {
              this.connect(cfg.host, cfg.username, cfg.password, cfg.port)
                .catch(err => Logger.error('reconnect failed', err));
            }
          });
        }
      }
    } finally {
      this.fetchInFlight = false;
    }
  }
}
