import * as crypto from 'crypto';
import { RobotManager } from './RobotManager.js';
import type { RobotState, ErrorListener, RobotManagerOptions } from './RobotManager.js';
import type { FileEntry } from './types.js';
import type { AccessEvent } from './access/AccessManager.js';
import { RwsError } from './types.js';
import { checkControlStationIdentity, type ControlStationIdentity } from './controlStation.js';

export interface RobotConfig {
  id: string;
  name: string;
  host: string;
  /** Specific port to use. If omitted, auto-detection probes common ports. */
  port?: number;
  /** Whether HTTPS is required. Derived from auto-detection or stored explicitly. */
  useHttps?: boolean;
  username: string;
  password: string;
  /**
   * System id (GUID from `getSystemInfo().sysid`) of the controller this entry
   * is for. When set, port recovery only adopts a controller with this id -
   * several controllers on one host otherwise make recovery a guess.
   */
  expectedSystemId?: string;
  /**
   * The RobotWare 8 control station this robot's manager registers as (see
   * `ControlStationIdentity`); overrides `controlStation` in the options
   * given to `MultiRobotManager`. Checked by `addRobot` and `updateConfig`,
   * which throw `INVALID_ARGUMENT` for a malformed value and then change
   * nothing. A change through `updateConfig` takes effect at the robot's next
   * connect. Ignored on RobotWare 6 and 7.
   */
  controlStation?: ControlStationIdentity;
}

/**
 * Manages multiple RobotManager instances.
 * One robot is "active" at a time - all panels display that robot's state.
 */
export class MultiRobotManager {
  private managers  = new Map<string, RobotManager>();
  private configMap = new Map<string, RobotConfig>();
  private _activeId: string | null = null;
  /** Robots whose connectRobot call is in flight. */
  private connecting = new Set<string>();
  private handlers: Array<() => void> = [];
  private robotHandlers: Array<(id: string) => void> = [];
  private accessHandlers: Array<(id: string, event: AccessEvent) => void> = [];
  private errorListener: ErrorListener | null = null;

  /**
   * Options forwarded to every RobotManager this instance creates (current and
   * future). A `controlStation` here is the station every robot registers as
   * unless its `RobotConfig` names its own; it is checked here, and a
   * malformed value throws `INVALID_ARGUMENT`.
   */
  constructor(private readonly managerOptions?: RobotManagerOptions) {
    if (managerOptions?.controlStation !== undefined) {
      checkControlStationIdentity(managerOptions.controlStation, 'RobotManagerOptions.controlStation');
    }
  }

  /** The identity a robot's manager uses: its own, else the shared one. */
  private stationFor(config: Pick<RobotConfig, 'controlStation'>): ControlStationIdentity | undefined {
    if (config.controlStation !== undefined) {
      return checkControlStationIdentity(config.controlStation, 'RobotConfig.controlStation');
    }
    return this.managerOptions?.controlStation;
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /** The currently selected robot's manager, or null if no robots configured. */
  get active(): RobotManager | null {
    return this._activeId ? (this.managers.get(this._activeId) ?? null) : null;
  }

  get activeId(): string | null { return this._activeId; }

  /** All robots with their configs and managers. */
  get entries(): Array<{ id: string; config: RobotConfig; manager: RobotManager }> {
    return [...this.managers.entries()].map(([id, manager]) => ({
      id, config: this.configMap.get(id)!, manager,
    }));
  }

  get configs(): RobotConfig[] { return [...this.configMap.values()]; }

  // ── State interface (satisfies providers that only need state) ─────────────

  get state(): RobotState {
    return this.active?.state ?? {
      connected: false, quality: 'disconnected', qualityReason: 'not connected',
      host: '', ctrlstate: null, opmode: null,
      execstate: null, execCycle: null, speedRatio: null, coldetstate: null,
      tasks: [], modules: [], modulesByTask: {}, mechunits: [], joints: null, cartesian: null,
      cartesianFull: null, identity: null, systemInfo: null, eventLog: [], ioSignals: [], ioSignalsLoaded: false,
      access: { generation: null, locks: [], watchdog: null, rw8: null },
    };
  }

  onDidChange(fn: () => void): void { this.handlers.push(fn); }

  /**
   * Like onDidChange, but tells the consumer WHICH robot changed - fleet UIs
   * can update one row instead of diffing every robot's state. Fires with the
   * robot's id on state changes inside its manager and on add/remove. The
   * zero-arg onDidChange keeps firing exactly as before.
   */
  onRobotChanged(fn: (id: string) => void): void { this.robotHandlers.push(fn); }

  /**
   * Every robot's access events (`RobotManager.onAccessEvent`), with the id of
   * the robot they belong to - current robots and those added later. Each
   * event also fires `onDidChange` and `onRobotChanged`. Returns a function
   * that removes the listener.
   */
  onAccessEvent(fn: (id: string, event: AccessEvent) => void): () => void {
    this.accessHandlers.push(fn);
    return () => {
      const i = this.accessHandlers.indexOf(fn);
      if (i >= 0) { this.accessHandlers.splice(i, 1); }
    };
  }

  /**
   * Install an error listener that gets attached to every current AND future
   * RobotManager. Convenience for hosts that want a single sink for connection
   * failures across all robots.
   */
  onError(fn: ErrorListener): void {
    this.errorListener = fn;
    for (const mgr of this.managers.values()) { mgr.onError(fn); }
  }

  // Delegated methods for providers that call manager methods directly
  async listDirectory(remotePath: string): Promise<FileEntry[]> {
    const m = this.active;
    if (!m) { throw new RwsError('No active robot', 'NOT_CONNECTED'); }
    return m.listDirectory(remotePath);
  }

  // ── Robot management ───────────────────────────────────────────────────────

  addRobot(config: RobotConfig): void {
    const controlStation = this.stationFor(config);
    const mgr = new RobotManager({ ...this.managerOptions, controlStation });
    mgr.onDidChange(() => { this.notify(); this.notifyRobot(config.id); });
    mgr.onAccessEvent(e => {
      for (const h of [...this.accessHandlers]) { try { h(config.id, e); } catch { /* consumer callback */ } }
    });
    if (this.errorListener) { mgr.onError(this.errorListener); }
    mgr.setExpectedSystemId(config.expectedSystemId);
    this.managers.set(config.id, mgr);
    this.configMap.set(config.id, config);
    if (!this._activeId) { this._activeId = config.id; }
    this.notify();
    this.notifyRobot(config.id);
  }

  updateConfig(id: string, patch: Partial<Omit<RobotConfig, 'id'>>): void {
    const existing = this.configMap.get(id);
    if (existing) {
      // Checked before anything changes: a malformed identity throws here.
      if ('controlStation' in patch) { this.managers.get(id)?.setControlStation(this.stationFor(patch)); }
      this.configMap.set(id, { ...existing, ...patch });
      if ('expectedSystemId' in patch) { this.managers.get(id)?.setExpectedSystemId(patch.expectedSystemId); }
      this.notify();
    }
  }

  /**
   * Remove a robot: it leaves the lists at once, and its manager disconnects
   * (on RobotWare 8 withdrawing a motion-control allowance first, then
   * `/logout`). Returns the disconnect's promise, which settles once that is
   * done and never rejects; a caller that ignores it is unchanged.
   */
  removeRobot(id: string): Promise<void> {
    const disconnected = this.managers.get(id)?.disconnect().catch(() => {}) ?? Promise.resolve();
    this.managers.delete(id);
    this.configMap.delete(id);
    if (this._activeId === id) {
      this._activeId = [...this.managers.keys()][0] ?? null;
    }
    this.notify();
    this.notifyRobot(id);
    return disconnected;
  }

  setActive(id: string): void {
    if (this.managers.has(id)) {
      this._activeId = id;
      this.notify();
    }
  }

  // ── Per-robot connect/disconnect ───────────────────────────────────────────

  async connectRobot(id: string): Promise<void> {
    const mgr = this.managers.get(id);
    const cfg = this.configMap.get(id);
    if (!mgr || !cfg) { throw new RwsError(`Robot ${id} not found`, 'RESOURCE_NOT_FOUND'); }
    this.connecting.add(id);
    try {
      // Pass stored port/useHttps so same-host robots go to different ports
      await mgr.connect(cfg.host, cfg.username, cfg.password, cfg.port, cfg.useHttps);
    } catch (err) {
      this.connecting.delete(id);
      const before = this._activeId;
      this.chooseActiveAfter(id, 'failed');
      if (this._activeId !== before) { this.notify(); }
      throw err;
    }
    this.connecting.delete(id);

    // If RobotManager auto-recovered a different port (RobotStudio reassigned it),
    // persist the new port so future connects skip the scan step.
    const actualPort = mgr.currentPort;
    const actualUseHttps = mgr.currentUseHttps;
    if (actualPort !== undefined && actualPort !== cfg.port) {
      this.configMap.set(id, { ...cfg, port: actualPort, useHttps: actualUseHttps });
    }

    this.chooseActiveAfter(id, 'connected');
    this.notify();
  }

  /**
   * Which robot is active once robot `id`'s connect has finished, either way.
   * Several robots may be connecting at once, and they finish in any order:
   * on loopback an RW 8.1.1 VC connects in about 1.5 s and an RW 6.16.03 VC
   * in about 3 s (2026-10-04). `this.connecting` holds the robots still in
   * flight; `this.active` is the current active manager (or null).
   */
  private chooseActiveAfter(id: string, outcome: 'connected' | 'failed'): void {
    const activeId = this._activeId;
    // A connected active robot keeps the slot, and so does one still connecting.
    if (activeId !== null && (this.active?.state.connected || this.connecting.has(activeId))) { return; }
    if (outcome === 'connected') { this._activeId = id; return; }
    // The active robot's own connect failed: move to a robot that is connected, if any.
    if (id === activeId) {
      const connected = [...this.managers.entries()].find(([, m]) => m.state.connected);
      if (connected) { this._activeId = connected[0]; }
    }
  }

  async disconnectRobot(id: string): Promise<void> {
    await this.managers.get(id)?.disconnect();
  }

  /**
   * Disconnect every robot at once (`Promise.allSettled`), for a host that is
   * closing. Each manager sends its RobotWare 8 motion-control withdrawal as
   * its first request, so every withdrawal goes out before any slow step of
   * any robot's teardown. Never rejects; the robots stay configured.
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.managers.values()].map(m => m.disconnect()));
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  /** Create a MultiRobotManager from persisted configs, with backward compatibility for legacy single-robot settings. */
  static fromConfigs(configs: RobotConfig[], opts?: RobotManagerOptions): MultiRobotManager {
    const m = new MultiRobotManager(opts);
    configs.forEach(c => m.addRobot(c));
    return m;
  }

  /** Generate a new robot config ID. */
  static newId(): string {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Guarded like RobotManager.notify: a throwing zero-arg handler must not
   *  starve the per-robot handlers registered after it. */
  private notify(): void {
    for (const h of this.handlers) {
      try { h(); } catch { /* consumer callback - never let it break us */ }
    }
  }
  private notifyRobot(id: string): void {
    this.robotHandlers.forEach(h => { try { h(id); } catch { /* consumer callback */ } });
  }
}
