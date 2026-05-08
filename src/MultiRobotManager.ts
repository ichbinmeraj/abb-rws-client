import * as crypto from 'crypto';
import { RobotManager } from './RobotManager.js';
import type { RobotState, ErrorListener } from './RobotManager.js';
import type { FileEntry } from './types.js';

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
}

/**
 * Manages multiple RobotManager instances.
 * One robot is "active" at a time — all panels display that robot's state.
 */
export class MultiRobotManager {
  private managers  = new Map<string, RobotManager>();
  private configMap = new Map<string, RobotConfig>();
  private _activeId: string | null = null;
  private handlers: Array<() => void> = [];
  private errorListener: ErrorListener | null = null;

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
      connected: false, host: '', ctrlstate: null, opmode: null,
      execstate: null, execCycle: null, speedRatio: null, coldetstate: null,
      tasks: [], modules: [], mechunits: [], joints: null, cartesian: null,
      cartesianFull: null, identity: null, systemInfo: null, eventLog: [], ioSignals: [],
    };
  }

  onDidChange(fn: () => void): void { this.handlers.push(fn); }

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
    if (!m) { throw new Error('No active robot'); }
    return m.listDirectory(remotePath);
  }

  // ── Robot management ───────────────────────────────────────────────────────

  addRobot(config: RobotConfig): void {
    const mgr = new RobotManager();
    mgr.onDidChange(() => this.notify());
    if (this.errorListener) { mgr.onError(this.errorListener); }
    this.managers.set(config.id, mgr);
    this.configMap.set(config.id, config);
    if (!this._activeId) { this._activeId = config.id; }
    this.notify();
  }

  updateConfig(id: string, patch: Partial<Omit<RobotConfig, 'id'>>): void {
    const existing = this.configMap.get(id);
    if (existing) {
      this.configMap.set(id, { ...existing, ...patch });
      this.notify();
    }
  }

  removeRobot(id: string): void {
    this.managers.get(id)?.disconnect().catch(() => {});
    this.managers.delete(id);
    this.configMap.delete(id);
    if (this._activeId === id) {
      this._activeId = [...this.managers.keys()][0] ?? null;
    }
    this.notify();
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
    if (!mgr || !cfg) { throw new Error(`Robot ${id} not found`); }
    // Pass stored port/useHttps so same-host robots go to different ports
    await mgr.connect(cfg.host, cfg.username, cfg.password, cfg.port, cfg.useHttps);

    // If RobotManager auto-recovered a different port (RobotStudio reassigned it),
    // persist the new port so future connects skip the scan step.
    const actualPort = mgr.currentPort;
    const actualUseHttps = mgr.currentUseHttps;
    if (actualPort !== undefined && actualPort !== cfg.port) {
      this.configMap.set(id, { ...cfg, port: actualPort, useHttps: actualUseHttps });
    }

    if (!this.active?.state.connected) { this._activeId = id; }
    this.notify();
  }

  async disconnectRobot(id: string): Promise<void> {
    await this.managers.get(id)?.disconnect();
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  /** Create a MultiRobotManager from persisted configs, with backward compatibility for legacy single-robot settings. */
  static fromConfigs(configs: RobotConfig[]): MultiRobotManager {
    const m = new MultiRobotManager();
    configs.forEach(c => m.addRobot(c));
    return m;
  }

  /** Generate a new robot config ID. */
  static newId(): string {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private notify(): void { this.handlers.forEach(h => h()); }
}
