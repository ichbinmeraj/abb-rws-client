import { RwsClient } from './RwsClient.js';
import type {
  ExecutionCycle, JointTarget, RobTarget, RapidSymbolSearchParams,
  RestartMode, MastershipDomain, SubscriptionResource, SubscriptionEvent,
  ElogMessage, ReturnCodeInfo,
} from './types.js';
import { decodeElogArgs, RwsError } from './types.js';
import { classifyControllerError } from './ControllerError.js';
import * as http from 'http';
import * as crypto from 'crypto';
import type { IRWSAdapter } from './IRWSAdapter.js';
import {
  RAPID, MOTION, IO, CFG_ELOG_DIPC, CTRL, SYSTEM_MASTERSHIP, USERS_UAS, FILES_VISION,
} from './paths/index.js';
import { buildPath, type PathSpec } from './paths/PathSpec.js';

interface RWS1Credentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * Build a typed error for the `?json=1` endpoints this adapter adds on top of
 * RwsClient.
 *
 * Those endpoints used to throw a plain `Error` carrying only the controller's
 * message, so roughly fifty methods produced errors with no `code` at all and
 * a caller's `catch (e) { if (e.code === 'RESOURCE_NOT_FOUND') ... }` silently
 * never matched. The endpoints RwsClient itself implements were classified all
 * along; only this side was missing. `classifyControllerError` already reads
 * the RWS 1.0 `_embedded.status` shape, so it just needed to be called.
 */
function rws1Error(method: string, path: string, status: number, body: string): RwsError {
  const info = classifyControllerError({ httpStatus: status, body: body ?? '', method, path });
  return new RwsError(
    info.message, info.code, status, body,
    info.controllerCode ?? undefined, info.controllerMsg ?? undefined,
  );
}

/**
 * RWS 1.0 adapter - thin wrapper around RwsClient (abb-rws-client).
 * Every method delegates directly; zero logic change from pre-adapter behavior.
 * Targets ABB IRC5 controllers running RobotWare 6.x.
 */
export class RWS1Adapter implements IRWSAdapter {
  constructor(
    private readonly client: RwsClient,
    private readonly creds?: RWS1Credentials,
  ) {}

  // ── Connection ──────────────────────────────────────────────────────────
  connect()          { return this.client.connect(); }
  disconnect()       { return this.client.disconnect(); }
  getSessionCookie() { return this.client.getSessionCookie(); }

  // ── Panel ───────────────────────────────────────────────────────────────
  getControllerState()                           { return this.client.getControllerState(); }
  setControllerState(s: 'motoron' | 'motoroff')  { return this.client.setControllerState(s); }
  getOperationMode()                             { return this.client.getOperationMode(); }
  getSpeedRatio()                                { return this.client.getSpeedRatio(); }
  setSpeedRatio(r: number)                       { return this.client.setSpeedRatio(r); }
  getCollisionDetectionState()                   { return this.client.getCollisionDetectionState(); }
  lockOperationMode(pin: string, p?: boolean)    { return this.client.lockOperationMode(pin, p); }
  unlockOperationMode()                          { return this.client.unlockOperationMode(); }
  setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF') { return this.client.setOperationMode(mode); }

  // ── RAPID execution ─────────────────────────────────────────────────────
  getRapidExecutionState()            { return this.client.getRapidExecutionState(); }
  getRapidExecutionInfo()             { return this.client.getRapidExecutionInfo(); }
  startRapid()                        { return this.client.startRapid(); }
  stopRapid()                         { return this.client.stopRapid(); }
  resetRapid()                        { return this.client.resetRapid(); }
  setExecutionCycle(c: ExecutionCycle){ return this.client.setExecutionCycle(c); }
  getRapidTasks()                     { return this.client.getRapidTasks(); }
  activateRapidTask(t: string)        { return this.client.activateRapidTask(t); }
  deactivateRapidTask(t: string)      { return this.client.deactivateRapidTask(t); }
  activateAllRapidTasks()             { return this.client.activateAllRapidTasks(); }
  deactivateAllRapidTasks()           { return this.client.deactivateAllRapidTasks(); }

  // ── RAPID modules & variables ───────────────────────────────────────────
  listModules(task: string)                                    { return this.client.listModules(task); }

  /** RWS 1.0 module-list also exposes name + type (SysMod / ProgMod) per entry. */
  async listModulesDetailed(task: string): Promise<Array<{ name: string; type: string }>> {
    const r = await this.rws1Get(`${buildPath(RAPID.listModulesDetailed.rws1 as PathSpec)}?task=${encodeURIComponent(task)}`);
    return r.states
      .map(s => ({ name: (s as Record<string,string>)['name'] ?? '', type: (s as Record<string,string>)['type'] ?? '' }))
      .filter(m => m.name);
  }
  loadModule(task: string, path: string, r?: boolean)          { return this.client.loadModule(task, path, r); }
  unloadModule(task: string, name: string)                     { return this.client.unloadModule(task, name); }
  getRapidVariable(t: string, m: string, s: string)            { return this.client.getRapidVariable(t, m, s); }
  setRapidVariable(t: string, m: string, s: string, v: string) { return this.client.setRapidVariable(t, m, s, v); }
  validateRapidValue(t: string, v: string, d: string)          { return this.client.validateRapidValue(t, v, d); }
  getRapidSymbolProperties(t: string, m: string, s: string)    { return this.client.getRapidSymbolProperties(t, m, s); }
  searchRapidSymbols(p: RapidSymbolSearchParams)                { return this.client.searchRapidSymbols(p); }
  getActiveUiInstruction()                                     { return this.client.getActiveUiInstruction(); }
  setUiInstructionParam(su: string, up: string, v: string)     { return this.client.setUiInstructionParam(su, up, v); }

  // ── Motion ──────────────────────────────────────────────────────────────
  getJointPositions(u?: string) { return this.client.getJointPositions(u); }
  getCartesianFull(u?: string)  { return this.client.getCartesianFull(u); }
  /** Canonical cross-protocol name for getCartesianPosition - same wire call.
   *  Matches RwsClient2.getRobTarget (pose relative to a chosen tool/wobj). */
  getRobTarget(u?: string, tool?: string, wobj?: string): Promise<RobTarget> {
    return this.client.getCartesianPosition(u, tool, wobj);
  }
  /** List mechanical units from the controller (positioners/track units show up beyond ROB_1). */
  async listMechunits(): Promise<string[]> {
    const r = await this.rws1Get(buildPath(MOTION.listMechunits.rws1 as PathSpec));
    const units = r.states
      .map(s => ((s as Record<string, string>)['_title'] ?? (s as Record<string, string>)['name']))
      .filter(Boolean) as string[];
    // A controller always has at least one mechunit - an empty list means the
    // response shape drifted; fall back to the standard unit rather than none.
    return units.length > 0 ? units : ['ROB_1'];
  }

  // ── System info ─────────────────────────────────────────────────────────
  getSystemInfo()       { return this.client.getSystemInfo(); }
  getControllerIdentity(){ return this.client.getControllerIdentity(); }
  getControllerClock()  { return this.client.getControllerClock(); }
  setControllerClock(Y: number, Mo: number, D: number, H: number, Mi: number, S: number) {
    return this.client.setControllerClock(Y, Mo, D, H, Mi, S);
  }
  restartController(m: RestartMode) { return this.client.restartController(m); }

  // ── Event log ───────────────────────────────────────────────────────────
  getEventLog(d?: number, l?: string) { return this.client.getEventLog(d, l); }
  clearEventLog(d?: number)           { return this.client.clearEventLog(d); }
  clearAllEventLogs()                 { return this.client.clearAllEventLogs(); }

  // ── I/O ────────────────────────────────────────────────────────────────
  listAllSignals(s?: number, l?: number)             { return this.client.listAllSignals(s, l); }
  readSignal(n: string, d: string, name: string)     { return this.client.readSignal(n, d, name); }
  writeSignal(n: string, d: string, name: string, v: string) { return this.client.writeSignal(n, d, name, v); }
  listNetworks()                                     { return this.client.listNetworks(); }
  listDevices(network: string)                       { return this.client.listDevices(network); }

  // ── File system ─────────────────────────────────────────────────────────
  listDirectory(path: string)                  { return this.client.listDirectory(path); }
  readFile(path: string)                       { return this.client.readFile(path); }
  uploadFile(path: string, content: string)    { return this.client.uploadModule(path, content); }
  deleteFile(path: string)                     { return this.client.deleteFile(path); }
  createDirectory(parent: string, dir: string) { return this.client.createDirectory(parent, dir); }
  copyFile(src: string, dst: string)           { return this.client.copyFile(src, dst); }

  // ── Mastership ──────────────────────────────────────────────────────────
  requestMastership(d: MastershipDomain) { return this.client.requestMastership(d); }
  releaseMastership(d: MastershipDomain) { return this.client.releaseMastership(d); }

  /** Request mastership on all domains (cfg + motion + rapid) at once. */
  async requestMastershipAll(): Promise<void> {
    await this.rws1Post(buildPath(SYSTEM_MASTERSHIP.requestMastershipAll.rws1 as PathSpec), '');
  }
  /** Release mastership on all domains at once. */
  async releaseMastershipAll(): Promise<void> {
    await this.rws1Post(buildPath(SYSTEM_MASTERSHIP.releaseMastershipAll.rws1 as PathSpec), '');
  }
  /**
   * RWS 1.0 doesn't expose `request-with-id` / `release-with-id` - those are
   * RWS 2.0 / RobotWare 7+ additions. The `?` in the IRWSAdapter signature
   * means we don't have to implement on this side; calls just throw.
   */
  /**
   * RWS 1.0 doesn't expose a watchdog endpoint - heartbeat is RWS 2.0 only.
   * The optional method on IRWSAdapter is left undefined here so callers can
   * feature-detect (`if ('resetMastershipWatchdog' in adapter)`).
   */
  /** Read mastership status for one domain. */
  async getMastershipStatus(d: MastershipDomain): Promise<{ mastership: string; uid?: string; application?: string }> {
    const r = await this.rws1Get(buildPath(SYSTEM_MASTERSHIP.getMastershipStatus.rws1 as PathSpec, { domain: d }));
    const s = r.state as { mastership?: string; uid?: string; application?: string } | null;
    return { mastership: s?.mastership ?? 'unknown', uid: s?.uid, application: s?.application };
  }
  /** List mastership domains (RWS 1.0: ['cfg', 'motion', 'rapid']). */
  async listMastershipDomains(): Promise<string[]> {
    const r = await this.rws1Get(buildPath(SYSTEM_MASTERSHIP.listMastershipDomains.rws1 as PathSpec));
    return r.states.map(s => (s as Record<string, string>)['_title']).filter(Boolean);
  }

  // ── Devices ────────────────────────────────────────────────────────────
  async listSystemDevices(): Promise<Array<{ id: string; name: string }>> {
    // RWS 1.0 nests the dev-id-li array inside _state[0].devices (different from the
    // RWS 2.0 XHTML layout where each <li class="dev-id-li"> is a top-level child).
    const r = await this.rws1Get('/rw/devices');
    const devices = (r.state as { devices?: Array<Record<string, string>> } | null)?.devices ?? [];
    return devices.map(d => ({
      id:   d['_title'] ?? '',
      name: d['name']   ?? '',
    }));
  }
  async getDeviceTree(group: string): Promise<string> {
    const res = await this.client.request('GET', `/rw/devices/${encodeURIComponent(group)}?json=1`);
    return res.body;
  }
  async listAllIoDevices(): Promise<Array<{ name: string; network: string; lstate: string; pstate: string; address: string }>> {
    const r = await this.rws1Get(buildPath(IO.listAllIoDevices.rws1 as PathSpec));
    return r.states.map(state => {
      const s = state as Record<string, string>;
      const title = s['_title'] ?? '';
      return {
        name:    s['name']   ?? '',
        network: title.split('/')[0] ?? '',
        lstate:  s['lstate'] ?? '',
        pstate:  s['pstate'] ?? '',
        address: s['address'] ?? '',
      };
    });
  }

  // ── Forward kinematics ──────────────────────────────────────────────────
  /**
   * Forward kinematics on RWS 1.0. Same VC-license caveat as IK.
   */
  async calcCartesianFromJoints(
    joints: JointTarget,
    mechunit = 'ROB_1',
    tool = 'tool0',
    wobj = 'wobj0',
  ): Promise<RobTarget> {
    if (!this.creds) { throw new RwsError('FK requires credentials in the adapter constructor', 'INVALID_ARGUMENT'); }
    const { host, port, username, password } = this.creds;
    const body = [
      `curr_joints=[${joints.rax_1},${joints.rax_2},${joints.rax_3},${joints.rax_4},${joints.rax_5},${joints.rax_6}]`,
      `curr_ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]`,
      `tool=${tool}`,
      `wobj=${wobj}`,
    ].join('&');
    const path = `${buildPath(MOTION.calcCartesianFromJoints.rws1 as PathSpec, { mechunit })}&json=1`;
    const result = await this.digestPost(host, port, path, body, username, password) as { _embedded?: { _state?: Array<Record<string, string>> } };
    const state = result._embedded?._state?.[0];
    if (!state) { throw new RwsError('FK: no result in response', 'PARSE_ERROR'); }
    return {
      x: +state.x, y: +state.y, z: +state.z,
      q1: +state.q1, q2: +state.q2, q3: +state.q3, q4: +state.q4,
    };
  }

  subscribe(
    resources: SubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    onLost?: () => void,
    onRestored?: () => void,
  ) {
    return this.client.subscribe(resources, handler, { onLost, onRestored });
  }

  // ── Jogging ─────────────────────────────────────────────────────────────

  /** Monotonic counter required by RWS jog endpoint (rejects duplicate ccount values). */
  private jogCcount = 0;

  async jog(params: {
    mode: 'Joint' | 'Cartesian';
    axes: [number, number, number, number, number, number];
    speed: number;
    mechunit?: string;
  }): Promise<void> {
    if (!this.creds) {
      throw new RwsError('Jog requires credentials - reconnect to enable', 'INVALID_ARGUMENT');
    }
    const { mode, axes, speed } = params;
    const mechunit = params.mechunit ?? 'ROB_1';
    this.jogCcount++;

    const bodyStr = [
      `jogmode=${mode}`,
      `mechunit=${mechunit}`,
      ...axes.map((v, i) => `axis${i + 1}=${v}`),
      `cjogspeed=${speed}`,
      `ccount=${this.jogCcount}`,
    ].join('&');

    const { host, port, username, password } = this.creds;
    const path = `${buildPath(MOTION.jog.rws1 as PathSpec)}&json=1`;
    const result = await this.digestPost(host, port, path, bodyStr, username, password);
    // Successful jog has no useful body - only check for error status.
    const status = (result._embedded as { status?: { msg?: string } } | undefined)?.status;
    if (status?.msg && status.msg.length > 0 && /error|fail/i.test(status.msg)) {
      throw new RwsError(status.msg, 'UNKNOWN');
    }
  }

  // ── RWS 1.0 helper - typed wrapper around client.request() with JSON parsing ──

  /**
   * Generic GET that returns `_embedded._state[0]` (single resource) or [] (list).
   * Most RWS 1.0 endpoints with `?json=1` return this HAL-like envelope.
   * Returns empty result for HTTP 204 (no content) - common on /ctrl/options etc.
   */
  private async rws1Get(path: string): Promise<{ status: number; state: Record<string, unknown> | null; states: Array<Record<string, unknown>>; raw: unknown }> {
    const url = path + (path.includes('?') ? '&' : '?') + 'json=1';
    const res = await this.client.request('GET', url);
    if (res.status === 204 || !res.body) {
      return { status: res.status, state: null, states: [], raw: null };
    }
    if (res.status >= 400) { throw rws1Error('GET', url, res.status, res.body); }
    let parsed: {
      _embedded?: { _state?: Array<Record<string, unknown>>; resources?: Array<Record<string, unknown>> };
      state?: Array<Record<string, unknown>>;
    } = {};
    try { parsed = JSON.parse(res.body); } catch { /* non-JSON ok */ }
    // RobotWare 6 mostly nests entries under _embedded._state, but some
    // resources (e.g. /rw/system/products) answer with a top-level `state`
    // array and others with _embedded.resources - the RWS 2.0 shapes. Reading
    // only _embedded._state made those look empty (live-verified 2026-08).
    const states = parsed._embedded?._state ?? parsed.state ?? parsed._embedded?.resources ?? [];
    return { status: res.status, state: states[0] ?? null, states, raw: parsed };
  }

  /** Generic POST that throws on >=400, returns the parsed JSON body. */
  private async rws1Post(path: string, body?: string): Promise<unknown> {
    const url = path + (path.includes('?') ? '&' : '?') + 'json=1';
    const res = await this.client.request('POST', url, body);
    if (res.status >= 400) { throw rws1Error('POST', url, res.status, res.body); }
    try { return JSON.parse(res.body); } catch { return null; }
  }

  // ── System detail ───────────────────────────────────────────────────────

  async getRobotType(): Promise<{ type: string; variant?: string }> {
    const r = await this.rws1Get(buildPath(SYSTEM_MASTERSHIP.getRobotType.rws1 as PathSpec));
    const s = r.state as { 'robot-type'?: string; type?: string; variant?: string } | null;
    return { type: s?.['robot-type'] ?? s?.type ?? '', variant: s?.variant };
  }

  async getLicenseInfo(): Promise<{ entries: Array<Record<string, string>> }> {
    // RWS 1.0 path is singular `/license`. Doc 6.8 has it as plural `/licenses`
    // but live IRC5 returns 404 for that - singular works.
    const r = await this.rws1Get(buildPath(SYSTEM_MASTERSHIP.getLicenseInfo.rws1 as PathSpec));
    return { entries: r.states as Array<Record<string, string>> };
  }

  async listProducts(): Promise<Array<Record<string, string>>> {
    const r = await this.rws1Get(buildPath(SYSTEM_MASTERSHIP.listProducts.rws1 as PathSpec));
    return r.states as Array<Record<string, string>>;
  }

  async getEnergyStats(): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(buildPath(SYSTEM_MASTERSHIP.getEnergyStats.rws1 as PathSpec));
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  // ── Return code lookup ─────────────────────────────────────────────────

  async getReturnCode(code: number, lang = 'en'): Promise<{ code: number; title: string; desc: string } | null> {
    try {
      const r = await this.rws1Get(`/rw/retcode?code=${code}&lang=${lang}`);
      const s = r.state as { title?: string; desc?: string } | null;
      if (!s) { return null; }
      return { code, title: s.title ?? '', desc: s.desc ?? '' };
    } catch { return null; }
  }

  // ── Controller detail ──────────────────────────────────────────────────

  /**
   * Installed RobotWare options. /ctrl/options answers 204 No Content on
   * RobotWare 6 (live-verified 2026-08 on RW6.16) - exactly as on RobotWare
   * 7/8 - so this returned an empty list. The real list is /rw/system/options,
   * class sys-option-li with an `option` span.
   */
  async listControllerOptions(): Promise<Array<{ name: string; description?: string }>> {
    try {
      const r = await this.rws1Get(buildPath(SYSTEM_MASTERSHIP.listControllerOptions.rws1 as PathSpec));
      return r.states
        .filter(o => (o as Record<string, string>)['_type'] === 'sys-option-li')
        .map(o => ({
          name: (o.option ?? o.name ?? '') as string,
          description: o.description as string | undefined,
        }))
        .filter(o => o.name);
    } catch { return []; }
  }

  // ── Motion detail ──────────────────────────────────────────────────────

  async getMotionChangeCount(): Promise<number> {
    const r = await this.rws1Get(buildPath(MOTION.getMotionChangeCount.rws1 as PathSpec));
    const s = r.state as { 'change-count'?: string } | null;
    return Number(s?.['change-count'] ?? 0);
  }

  async getMotionErrorState(): Promise<{ state: string; details?: Record<string, string> }> {
    const r = await this.rws1Get(buildPath(MOTION.getMotionErrorState.rws1 as PathSpec));
    const s = r.state as Record<string, string> | null;
    return { state: s?.['err-state'] ?? s?.state ?? 'unknown', details: s ?? undefined };
  }

  async getNonMotionExecution(): Promise<boolean> {
    const r = await this.rws1Get(buildPath(MOTION.getNonMotionExecution.rws1 as PathSpec));
    const s = r.state as { mode?: string } | null;
    return (s?.mode ?? '').toUpperCase() === 'ON';
  }

  async setNonMotionExecution(enabled: boolean): Promise<void> {
    await this.rws1Post(buildPath(MOTION.setNonMotionExecution.rws1 as PathSpec), `mode=${enabled ? 'ON' : 'OFF'}`);
  }

  async getMechunitInfo(mechunit = 'ROB_1'): Promise<Record<string, string>> {
    const r = await this.rws1Get(buildPath(MOTION.getMechunitInfo.rws1 as PathSpec, { mechunit }));
    return (r.state as Record<string, string>) ?? {};
  }

  async getMechunitBaseFrame(mechunit = 'ROB_1'): Promise<{ x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }> {
    const r = await this.rws1Get(buildPath(MOTION.getMechunitBaseFrame.rws1 as PathSpec, { mechunit }));
    const s = (r.state as Record<string, string>) ?? {};
    return { x: +s.x, y: +s.y, z: +s.z, q1: +s.q1, q2: +s.q2, q3: +s.q3, q4: +s.q4 };
  }

  async getMechunitAxes(mechunit = 'ROB_1'): Promise<Array<Record<string, string>>> {
    // RWS 1.0 returns 2 entries: an axis-count summary and a sub-resource link list.
    // Fetch each axis individually to get its real data.
    const r = await this.rws1Get(buildPath(MOTION.getMechunitAxes.rws1 as PathSpec, { mechunit }));
    const summary = r.states.find(s => s._type === 'ms-mechunit-axes');
    const count = +((summary as { axes?: string } | undefined)?.axes ?? '0');
    if (count === 0) { return []; }
    const axes: Array<Record<string, string>> = [];
    for (let i = 1; i <= count; i++) {
      try {
        const ar = await this.rws1Get(`/rw/motionsystem/mechunits/${mechunit}/axes/${i}`);
        axes.push({ axis: String(i), ...((ar.state as Record<string, string>) ?? {}) });
      } catch { axes.push({ axis: String(i), error: 'unreachable' }); }
    }
    return axes;
  }

  async getActiveTool(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
    const r = await this.rws1Get(buildPath(MOTION.getActiveTool.rws1 as PathSpec, { mechunit }));
    const s = (r.state as Record<string, string>) ?? {};
    return { name: s['tool-name'] ?? 'tool0' };
  }

  async getActiveWobj(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
    const r = await this.rws1Get(buildPath(MOTION.getActiveWobj.rws1 as PathSpec, { mechunit }));
    const s = (r.state as Record<string, string>) ?? {};
    return { name: s['wobj-name'] ?? 'wobj0' };
  }

  async getActivePayload(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
    const r = await this.rws1Get(buildPath(MOTION.getActivePayload.rws1 as PathSpec, { mechunit }));
    const s = (r.state as Record<string, string>) ?? {};
    return { name: s['total-payload-name'] ?? s['payload-name'] ?? 'load0' };
  }

  // ── RAPID detail ───────────────────────────────────────────────────────

  async listAliasIO(): Promise<Array<{ alias: string; signal: string }>> {
    try {
      const r = await this.rws1Get(buildPath(RAPID.listAliasIO.rws1 as PathSpec));
      return r.states.map(a => ({
        alias: (a.name ?? a.alias ?? '') as string,
        signal: (a.signal ?? a._title ?? '') as string,
      }));
    } catch { return []; }
  }

  async getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> {
    try {
      const r = await this.rws1Get(buildPath(RAPID.getProgramPointer.rws1 as PathSpec, { task }));
      const s = (r.state as Record<string, string>) ?? {};
      const begin = (s.beginposition ?? '').split(',');
      return {
        module:  s.modulename ?? s.modulemame ?? s.module,
        routine: s.routinename ?? s.routine,
        row:     begin[0] ? +begin[0] : undefined,
        col:     begin[1] ? +begin[1] : undefined,
      };
    } catch { return {}; }
  }

  async getMotionPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> {
    // RWS 1.0 path is /rw/rapid/tasks/{task}/motion (per official doc 6.7)
    try {
      const r = await this.rws1Get(buildPath(RAPID.getMotionPointer.rws1 as PathSpec, { task }));
      const s = (r.state as Record<string, string>) ?? {};
      return {
        module:  s.modulename ?? s.modulemame ?? s.module,
        routine: s.routinename ?? s.routine,
      };
    } catch { return {}; }
  }

  // ── CFG database ───────────────────────────────────────────────────────

  async listCfgDomains(): Promise<string[]> {
    const r = await this.rws1Get(buildPath(CFG_ELOG_DIPC.listCfgDomains.rws1 as PathSpec));
    return r.states.map(d => (d._title ?? d.name) as string).filter(Boolean);
  }

  async listCfgTypes(domain: string): Promise<string[]> {
    const types: string[] = [];
    let path = buildPath(CFG_ELOG_DIPC.listCfgTypes.rws1 as PathSpec, { domain });
    let pages = 0;
    while (path && pages < 50) {
      const r = await this.rws1Get(path);
      const ts = r.states.map(t => (t._title ?? t.name) as string).filter(Boolean);
      types.push(...ts);
      // RWS 1.0 pagination: `_links.next.href` in the response
      const links = (r.raw as { _links?: { next?: { href?: string } } } | undefined)?._links;
      const next = links?.next?.href;
      if (next && pages < 49) {
        path = '/rw/cfg/' + next.replace(/^\/+/, '').replace(/^cfg\//, '').replace(/&amp;/g, '&').replace(/[?&]json=1/, '');
      } else { path = ''; }
      pages++;
    }
    return types;
  }

  async listCfgInstances(domain: string, type: string): Promise<string[]> {
    try {
      const r = await this.rws1Get(buildPath(CFG_ELOG_DIPC.listCfgInstances.rws1 as PathSpec, { domain, type }));
      return r.states.map(i => (i._title ?? i.name) as string).filter(Boolean);
    } catch { return []; }
  }

  async getCfgInstance(domain: string, type: string, instance: string): Promise<Record<string, string>> {
    // RWS 1.0 inlines all attribute data in the instance-list response. The single-instance
    // GET also works at `/instances/{name}`. Use the list call (one HTTP request) and find
    // by _title - also handles instance names with spaces/special chars correctly.
    const r = await this.rws1Get(buildPath(CFG_ELOG_DIPC.getCfgInstance.rws1 as PathSpec, { domain, type }));
    const target = r.states.find(s => s._title === instance);
    if (!target) { return {}; }

    const out: Record<string, string> = {};

    // Attributes can come in two shapes on RWS 1.0:
    //   1. Inline `attrib` array of { _title: name, value }
    //   2. Direct keyed properties on the state object
    const attribs = (target as { attrib?: Array<{ _title?: string; value?: string }> }).attrib;
    if (Array.isArray(attribs)) {
      for (const a of attribs) {
        if (a._title) { out[a._title] = String(a.value ?? ''); }
      }
    }
    // Always include direct properties (rdonly, instanceid, etc.) - useful metadata.
    for (const [k, v] of Object.entries(target)) {
      if (k.startsWith('_') || k === 'attrib') { continue; }
      if (typeof v === 'string') { out[k] = v; }
    }
    return out;
  }

  /**
   * Update attributes on an existing configuration instance.
   * Live-verified 2026-07-09 on IRC5 VC RW6.16 via probe-cfg-rws1.mjs:
   *   ✓ POST /rw/cfg/{domain}/{type}/instances/{instance}?action=set
   *     body: PLAIN form values `Attr=value&…` (percent-encoded) → 204,
   *     partial attribute sets accepted.
   * Acquires cfg-domain mastership around the write. (The VC accepts cfg
   * writes without it, but real controllers arbitrate cfg access through
   * mastership - and taking it when free is harmless.)
   */
  async setCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
    await this.client.requestMastership('cfg');
    try {
      await this.postCfgSet(domain, type, instance, attrs);
    } finally {
      await this.client.releaseMastership('cfg').catch(() => {});
    }
  }

  /**
   * Create a new configuration instance, then apply `attrs`.
   * Live-verified 2026-07-09 on IRC5 VC RW6.16:
   *   ✓ POST /rw/cfg/{domain}/{type}/instances?action=create-default
   *     body name={instance} → 201 (duplicate name → 400), then the
   *     ?action=set shape above for the attribute values.
   * Acquires cfg-domain mastership once around the create+set pair.
   */
  async createCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
    await this.client.requestMastership('cfg');
    try {
      await this.rws1Post(
        buildPath(CFG_ELOG_DIPC.createCfgInstance.rws1 as PathSpec, { domain, type }),
        `name=${encodeURIComponent(instance)}`,
      );
      if (Object.keys(attrs).length > 0) {
        await this.postCfgSet(domain, type, instance, attrs);
      }
    } finally {
      await this.client.releaseMastership('cfg').catch(() => {});
    }
  }

  /**
   * Delete a configuration instance.
   * Live-verified 2026-07-09 on IRC5 VC RW6.16:
   *   ✓ DELETE /rw/cfg/{domain}/{type}/instances/{instance} → 204
   *     (reading the instance back afterwards → 400 "unknown instance",
   *     unlike RWS 2.0 which answers 404).
   */
  async removeCfgInstance(domain: string, type: string, instance: string): Promise<void> {
    await this.client.requestMastership('cfg');
    try {
      const url = `${buildPath(CFG_ELOG_DIPC.removeCfgInstance.rws1 as PathSpec, { domain, type, instance })}?json=1`;
      const res = await this.client.request('DELETE', url);
      if (res.status >= 400) { throw rws1Error('DELETE', url, res.status, res.body); }
    } finally {
      await this.client.releaseMastership('cfg').catch(() => {});
    }
  }

  /** Shared ?action=set POST - plain `Attr=value` form pairs (RWS 1.0 wire shape). */
  private async postCfgSet(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
    const body = Object.entries(attrs).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.setCfgInstance.rws1 as PathSpec, { domain, type, instance }), body);
  }

  // ── Backup ─────────────────────────────────────────────────────────────

  async listBackups(): Promise<Array<{ name: string; created?: string; size?: number }>> {
    try {
      const entries = await this.client.listDirectory('$BACKUP');
      return entries.filter(e => e.type === 'dir').map(e => ({
        name: e.name,
        created: e.created,
      }));
    } catch { return []; }
  }

  async getBackupStatus(): Promise<{ active: boolean; progress?: number; phase?: string }> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getBackupStatus.rws1 as PathSpec));
      const s = (r.state as Record<string, string>) ?? {};
      const phase = s['progress-state'] ?? s.phase ?? '';
      return {
        active: phase !== '' && phase !== 'idle' && phase !== 'finished',
        progress: s.progress ? +s.progress : undefined,
        phase,
      };
    } catch { return { active: false }; }
  }

  // ── RMMP ───────────────────────────────────────────────────────────────

  async getRmmpPrivilege(): Promise<string> {
    try {
      const r = await this.rws1Get(buildPath(USERS_UAS.getRmmpPrivilege.rws1 as PathSpec));
      const s = (r.state as Record<string, string>) ?? {};
      const priv = s.privilege ?? 'none';
      const heldByMe = (s.rmmpheldbyme ?? 'false').toLowerCase() === 'true';
      if (priv === 'none' || priv.startsWith('pending')) { return priv; }
      return heldByMe ? priv : 'none';
    } catch { return 'none'; }
  }

  async requestRmmp(level: 'modify' | 'exclusive' = 'modify'): Promise<void> {
    await this.rws1Post(buildPath(USERS_UAS.requestRmmp.rws1 as PathSpec), `privilege=${level}`);
  }

  // ── Stage 7: Backup / Restore / Progress (5 methods) ───────────────────

  async createBackup(name: string): Promise<void> {
    // Async - controller returns 202 + Location header pointing to /progress/{id}.
    // Caller polls getProgress() to track completion. The backup value must be a
    // fileservice URI: bare '$BACKUP/x' answers 400 "Invalid File Service path";
    // '/fileservice/$BACKUP/x' answers 202 (live-verified 2026-08 on RW6.16 -
    // the same URI scheme the RWS 2.0 file-target writes require).
    await this.rws1Post(buildPath(CTRL.createBackup.rws1 as PathSpec),
      `backup=${encodeURIComponent(`/fileservice/$BACKUP/${name}`)}`);
  }

  async restoreBackup(name: string): Promise<void> {
    await this.rws1Post(buildPath(CTRL.restoreBackup.rws1 as PathSpec),
      `backup=${encodeURIComponent(`/fileservice/$BACKUP/${name}`)}`);
  }

  async listProgress(): Promise<Array<{ id: string; state: string }>> {
    try {
      const r = await this.rws1Get('/progress');
      return r.states.map(p => ({
        id:    (p._title ?? p.id ?? '') as string,
        state: (p.state ?? '') as string,
      }));
    } catch { return []; }
  }

  async getProgress(id: string): Promise<{ state: string; details?: Record<string, string> } | null> {
    try {
      const r = await this.rws1Get(`/progress/${encodeURIComponent(id)}`);
      const s = r.state as Record<string, string> | null;
      if (!s) { return null; }
      return { state: s.state ?? '', details: s };
    } catch { return null; }
  }

  // ── Stage 8: DIPC (6 methods) ──────────────────────────────────────────

  async listDipcQueues(): Promise<Array<{ name: string; size?: number }>> {
    try {
      const r = await this.rws1Get(buildPath(CFG_ELOG_DIPC.listDipcQueues.rws1 as PathSpec));
      return r.states.map(q => ({
        name: (q._title ?? q['queue-name'] ?? '') as string,
        size: q['queue-size'] !== undefined ? +(q['queue-size'] as string) : undefined,
      }));
    } catch { return []; }
  }

  async createDipcQueue(name: string, options: { maxsize?: number; maxmessages?: number } = {}): Promise<void> {
    const parts = [`dipc-queue-name=${encodeURIComponent(name)}`];
    if (options.maxsize)     { parts.push(`dipc-max-size=${options.maxsize}`); }
    if (options.maxmessages) { parts.push(`dipc-max-number-of-messages=${options.maxmessages}`); }
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.createDipcQueue.rws1 as PathSpec), parts.join('&'));
  }

  async sendDipcMessage(queue: string, payload: string, type: 'string' | 'num' | 'dnum' | 'bool' = 'string'): Promise<void> {
    const typeCode = type === 'string' ? '0' : type === 'num' ? '1' : type === 'dnum' ? '2' : '3';
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.sendDipcMessage.rws1 as PathSpec, { queue }),
      `dipc-src-queue-name=${encodeURIComponent(queue)}&dipc-cmd=111&dipc-data=${encodeURIComponent(payload)}&dipc-msgtype=${typeCode}`);
  }

  async readDipcMessage(queue: string): Promise<{ payload: string; type: string } | null> {
    try {
      const r = await this.rws1Get(buildPath(CFG_ELOG_DIPC.readDipcMessage.rws1 as PathSpec, { queue }));
      const s = r.state as Record<string, string> | null;
      if (!s || !s['dipc-data']) { return null; }
      return { payload: s['dipc-data'], type: s['dipc-msgtype'] ?? 'string' };
    } catch { return null; }
  }

  async removeDipcQueue(name: string): Promise<void> {
    await this.client.request('DELETE', `${buildPath(CFG_ELOG_DIPC.removeDipcQueue.rws1 as PathSpec, { queue: name })}?json=1`);
  }

  // ── Stage 9: Safety (5 methods) ────────────────────────────────────────

  async getSafetyStatus(): Promise<{ state: string; details?: Record<string, string> }> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getSafetyStatus.rws1 as PathSpec));
      const s = r.state as Record<string, string> | null;
      return { state: s?.state ?? 'unavailable', details: s ?? undefined };
    } catch { return { state: 'unavailable' }; }
  }

  async listSafetyZones(): Promise<Array<Record<string, string>>> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.listSafetyZones.rws1 as PathSpec));
      return r.states as Array<Record<string, string>>;
    } catch { return []; }
  }

  async runCyclicBrakeCheck(): Promise<void> {
    await this.rws1Post(buildPath(CTRL.runCyclicBrakeCheck.rws1 as PathSpec), '');
  }

  // ── Stage 10: Virtual time (3 methods, VC-only) ────────────────────────

  async getVirtualTime(): Promise<{ time: number; running: boolean; speed?: number }> {
    try {
      // RWS 1.0 has /ctrl/virtualtime as a directory; query each sub-resource.
      const fetch = async (sub: string): Promise<Record<string, string>> => {
        try {
          const r = await this.rws1Get(`/ctrl/virtualtime/${sub}`);
          return (r.state as Record<string, string>) ?? {};
        } catch { return {}; }
      };
      const [time, state, speed] = await Promise.all([fetch('vttime'), fetch('vtstate'), fetch('vtspeed')]);
      return {
        time:    Number(time.vtcounter ?? time.time ?? 0),
        running: (state.vtcurrstate ?? state.state ?? '').toLowerCase() === 'running',
        speed:   speed.vtcurrspeed !== undefined ? +(speed.vtcurrspeed as string) : undefined,
      };
    } catch { return { time: 0, running: false }; }
  }

  async setVirtualTimeRunning(running: boolean): Promise<void> {
    await this.rws1Post(`/ctrl/virtualtime/vtstate?action=${running ? 'run' : 'pause'}`, '');
  }

  async setVirtualTimeScale(scale: number): Promise<void> {
    await this.rws1Post(buildPath(CTRL.setVirtualTimeScale.rws1 as PathSpec), `vtcurrspeed=${scale}`);
  }

  // ── Stage 11: Vision (5 methods) ───────────────────────────────────────

  async listVisionSystems(): Promise<Array<{ name: string; status?: string }>> {
    try {
      const r = await this.rws1Get(buildPath(FILES_VISION.listVisionSystems.rws1 as PathSpec));
      return r.states.map(v => ({
        name:   (v._title ?? v.name ?? '') as string,
        status: v.status as string | undefined,
      }));
    } catch { return []; }
  }

  async getVisionSystemInfo(name: string): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(buildPath(FILES_VISION.getVisionSystemInfo.rws1 as PathSpec, { name }));
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  async triggerVisionJob(system: string): Promise<void> {
    await this.rws1Post(buildPath(FILES_VISION.triggerVisionJob.rws1 as PathSpec, { system }), '');
  }

  // ── Stage 12: RAPID extras (4 methods) ─────────────────────────────────

  /**
   * Save a loaded module's program-memory source to controller disk.
   * Live-verified 2026-07-09 on IRC5 VC RW6.16:
   *   POST /rw/rapid/tasks/{task}?action=savemod is DEAD - 400 ARG_ERROR
   *   (-1073445879, rws_resource_rapid_task.cpp[952]) for every body shape
   *   including the empty body, and the task resource advertises no savemod
   *   action. The working endpoint is the module-save action (same one
   *   readModuleViaSave uses):
   *     POST /rw/rapid/modules/{module}?task={task}&action=save
   *     body name=<file>&path=<dir>  → 204
   *   The controller blindly appends '.mod' to the given name - even when it
   *   already ends in .mod (name=save1.mod wrote $TEMP/save1.mod.mod) - so a
   *   trailing .mod/.sys extension on the destination is stripped here.
   * `filepath` may be a directory ('$TEMP'), a full destination path
   * ('$HOME/backups/Copy.mod'), or a bare file name ('Copy.mod', saved under
   * $HOME); a directory destination saves under the module's own name.
   */
  async saveModule(task: string, moduleName: string, filepath: string): Promise<void> {
    const ext = /\.(mod|sys)$/i;
    const clean = filepath.replace(/\/+$/, '');
    const slash = clean.lastIndexOf('/');
    const last = clean.slice(slash + 1);
    let dir: string;
    let name: string;
    if (ext.test(last)) {
      dir = slash >= 0 ? clean.slice(0, slash) : '$HOME';
      name = last.replace(ext, '');
    } else {
      dir = clean || '$HOME';
      name = moduleName.replace(ext, '');
    }
    // Encode per segment, keeping the $HOME/$TEMP root literal (the controller
    // expects the $-prefix raw; everything after may contain space/#/%/&).
    const encDir = dir.split('/')
      .map((seg, i) => (i === 0 && seg.startsWith('$')) ? seg : encodeURIComponent(seg))
      .join('/');
    await this.rws1Post(
      `/rw/rapid/modules/${encodeURIComponent(moduleName)}?task=${encodeURIComponent(task)}&action=save`,
      `name=${encodeURIComponent(name)}&path=${encDir}`,
    );
  }

  async getModuleSource(task: string, moduleName: string): Promise<string> {
    // Program memory is the source of truth - the save round-trip reads it
    // directly (mastership-free), so it is the PRIMARY path. Reading
    // $HOME/{module}.mod first would let a stale disk file shadow unsaved
    // edits, and modules loaded from .pgf / RobotStudio / the FlexPendant
    // have no $HOME backing file at all (abb-rws-vscode issue #3).
    try {
      return await this.readModuleViaSave(task, moduleName);
    } catch {
      // Save endpoint failed (permissions, disk, transient) - fall back to the
      // conventional $HOME location.
      return this.client.readFile(`$HOME/${moduleName}.mod`);
    }
  }

  /**
   * Read a module's source by round-tripping it through the $TEMP volume.
   * Live-verified 2026-07-08 on IRC5 VC RW6.16:
   *   POST /rw/rapid/modules/{module}?task={task}&action=save  body name=<tmp>&path=$TEMP
   *   → 204, no mastership required. The controller ALWAYS appends '.mod' to
   *   the given name (even for SysMod modules - never '.sys'), so the name is
   *   passed without extension. Note the $-root has no trailing colon/slash,
   *   unlike RWS 2.0's 'TEMP:'.
   */
  private async readModuleViaSave(task: string, moduleName: string): Promise<string> {
    const tmp = `${moduleName}_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
    await this.rws1Post(
      `/rw/rapid/modules/${encodeURIComponent(moduleName)}?task=${encodeURIComponent(task)}&action=save`,
      `name=${tmp}&path=$TEMP`,
    );
    try {
      return await this.client.readFile(`$TEMP/${tmp}.mod`);
    } finally {
      await this.client.deleteFile(`$TEMP/${tmp}.mod`).catch(() => {});
    }
  }

  async listModuleRoutines(task: string, moduleName: string): Promise<Array<{ name: string; type: string }>> {
    try {
      const r = await this.rws1Get(buildPath(RAPID.listModuleRoutines.rws1 as PathSpec, { task, module: moduleName }));
      return r.states.map(rt => ({
        name: (rt.name ?? rt._title ?? '') as string,
        type: (rt.type ?? '') as string,
      }));
    } catch { return []; }
  }

  async listBreakpoints(task: string): Promise<Array<{ module: string; row: number; col?: number }>> {
    try {
      // Per official doc: CCRapidBreakPointResource - exact path varies by RW version.
      const r = await this.rws1Get(buildPath(RAPID.listBreakpoints.rws1 as PathSpec, { task }));
      return r.states.map(b => ({
        module: (b.module ?? b.modulename ?? '') as string,
        row:    +(b['begin-position-row'] ?? b.row ?? 0),
        col:    b['begin-position-col'] !== undefined ? +(b['begin-position-col'] as string) : undefined,
      }));
    } catch { return []; }
  }

  /** CAUTION: wire form unverified on RWS 1.0. The task-level
   *  ?action=holdtorun with body action= answers 400 "Invalid argument" on
   *  RW6.16 (live-probed 2026-08) - the real form is undiscovered and
   *  hold-to-run is a manual-mode function anyway. Kept for source
   *  compatibility; expect the controller's 400 until the form is found. */
  async holdToRun(task: string, action: 'press' | 'release'): Promise<void> {
    await this.rws1Post(buildPath(RAPID.holdToRun.rws1 as PathSpec, { task }), `action=${action}`);
  }

  /**
   * Device groups the controller reports, e.g. HW_DEVICES and SW_RESOURCES.
   * Live-verified 2026-08-06 on RW6.16.
   */
  async listDeviceGroups(): Promise<string[]> {
    // Same nested `devices` shape as a group page, so reuse the walker.
    return (await this.listControllerDevices('')).map(d => d.id);
  }

  /**
   * Devices in one controller device group. RWS 1.0 nests the entries in a
   * `devices` array inside the state object rather than in `_embedded`, which
   * is why the RWS 2.0 parsing does not carry over, and it goes a level deeper:
   * HW_DEVICES holds CONTROLLER and MECH_UNITS, and CONTROLLER in turn holds
   * COMPUTER_SYSTEM. Pass a nested path to walk down, e.g.
   * `listControllerDevices('HW_DEVICES/CONTROLLER')`.
   * Live-verified 2026-08-06 on RW6.16, class dev-id-li.
   */
  async listControllerDevices(group: string): Promise<Array<{ id: string; name: string }>> {
    const suffix = group ? `/${group.replace(/^\/+/, '')}` : '';
    const r = await this.rws1Get(`/rw/devices${suffix}`);
    const out: Array<{ id: string; name: string }> = [];
    for (const st of r.states) {
      const devices = (st as Record<string, unknown>)['devices'];
      if (!Array.isArray(devices)) { continue; }
      for (const d of devices as Array<Record<string, unknown>>) {
        out.push({ id: String(d['_title'] ?? ''), name: String(d['name'] ?? '') });
      }
    }
    return out;
  }

  /**
   * Translate a controller status code using the controller's own dictionary.
   * Same resource and same `err-desc` shape as RWS 2.0, live-verified
   * 2026-08-06 on RW6.16. Null when the code is unknown to this controller.
   */
  async describeReturnCode(code: number): Promise<ReturnCodeInfo | null> {
    try {
      const r = await this.rws1Get(`/rw/retcode?code=${code}`);
      const d = (r.state as Record<string, string>) ?? {};
      if (!d.name) { return null; }
      return {
        code: Number(d.code ?? code),
        name: d.name ?? '',
        severity: d.severity ?? '',
        description: d.description ?? '',
      };
    } catch { return null; }
  }

  /** One event-log message by domain and sequence number. Live-verified
   *  2026-08-04 on RW6.16: GET /rw/elog/{d}/{seq}, class elog-message (same
   *  shape as RWS 2.0). Null when unknown. Note: login-info, grant-exists,
   *  /uas/grants, opmode lock-state and motionsupervision are protocol-absent
   *  on RW6.16 (404) - the elog lookup is the only batch-5 read RWS 1.0 has. */
  async getEventLogMessage(domain: number, seqnum: number, lang = 'en'): Promise<ElogMessage | null> {
    try {
      const r = await this.rws1Get(`${buildPath(CFG_ELOG_DIPC.getEventLogMessage.rws1 as PathSpec, { domain, seqnum })}?lang=${encodeURIComponent(lang)}`);
      const m = (r.states.find(s => (s as Record<string, string>)['_type'] === 'elog-message') ?? {}) as Record<string, string>;
      if (!m['code']) { return null; }
      return {
        seqnum, code: Number(m['code'] ?? 0), msgtype: Number(m['msgtype'] ?? 1) as 1 | 2 | 3,
        timestamp: m['tstamp'] ?? '', srcName: m['src-name'] ?? '',
        title: m['title'] ?? `Event ${m['code']}`, desc: m['desc'] ?? '',
        causes: m['causes'] ?? '', consequences: m['conseqs'] ?? '', actions: m['actions'] ?? '',
        args: decodeElogArgs(m),
      };
    } catch { return null; }
  }

  /** List callable service routines of a task. Live-verified 2026-08-04 on RW6.16
   *  VC: class rap-task-routine, spans routine-name and url-to-routine (RWS 2.0
   *  spells them routine_name / url_to_routine - both read for safety). */
  async listServiceRoutines(task: string): Promise<Array<{ name: string; url: string }>> {
    try {
      const r = await this.rws1Get(buildPath(RAPID.listServiceRoutines.rws1 as PathSpec, { task }));
      return r.states
        .filter(s => (s as Record<string, string>)['_type'] === 'rap-task-routine')
        .map(s => {
          const d = s as Record<string, string>;
          return { name: d['routine-name'] ?? d['routine_name'] ?? '', url: d['url-to-routine'] ?? d['url_to_routine'] ?? '' };
        })
        .filter(x => x.name);
    } catch { return []; }
  }

  /** Module metadata (filename, attributes). Live-verified 2026-08-04 on RW6.16:
   *  GET /rw/rapid/modules/{module}?task= returns class rap-module with
   *  taskname/modname/filename/attribute. Parity with RwsClient2.getModuleInfo. */
  async getModuleInfo(task: string, moduleName: string): Promise<Record<string, string>> {
    const r = await this.rws1Get(`${buildPath(RAPID.getModuleInfo.rws1 as PathSpec, { module: moduleName })}?task=${encodeURIComponent(task)}`);
    const d = (r.states.find(s => (s as Record<string, string>)['_type'] === 'rap-module') ?? r.state ?? {}) as Record<string, string>;
    return d;
  }

  /**
   * Program resource of a task (name, entrypoint if loaded). Parity with
   * RwsClient2.getTaskProgramInfo. Read via XHTML: on RW6.16 the ?json=1
   * representation of this resource is a BROKEN template (the controller
   * returns unrendered jtmpl directives - live-observed 2026-08-04), so the
   * XML form is the only reliable one.
   */
  async getTaskProgramInfo(task: string): Promise<Record<string, string>> {
    const res = await this.client.request('GET', buildPath(RAPID.getTaskProgramInfo.rws1 as PathSpec, { task }));
    if (res.status === 204 || !res.body) { return {}; }
    const out: Record<string, string> = {};
    const li = res.body.match(/<li class="rap-program"[^>]*>([^]*?)<\/li>/);
    for (const m of (li ? li[1] : res.body).matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)) {
      if (m[1] !== 'code') { out[m[1]] = m[2]; }
    }
    return out;
  }

  /**
   * Event-log domains the controller serves. Parity with the RWS 2.0 method:
   * getEventLog() defaults to domain 0, while a live IRC5 exposes fourteen.
   * RobotWare 6 does not report per-domain counts (the RWS 2.0 listing carries
   * numevts and buffsize), so those come back as 0 here.
   *
   * Checked 2026-08 on RW6.16: signal and event-log listings arrive complete
   * with no `next` link, so unlike RWS 2.0 there is nothing to paginate.
   */
  async listEventLogDomains(): Promise<Array<{ domain: number; events: number; bufferSize: number }>> {
    try {
      const r = await this.rws1Get(buildPath(CFG_ELOG_DIPC.listEventLogDomains.rws1 as PathSpec));
      return r.states
        .filter(s => (s as Record<string, string>)['_type'] === 'elog-domain-li')
        .map(s => {
          const d = s as Record<string, string>;
          return {
            domain: Number(d['_title'] ?? 0),
            events: Number(d['numevts'] ?? 0),
            bufferSize: Number(d['buffsize'] ?? 0),
          };
        });
    } catch { return []; }
  }

  /**
   * Structural change count of a task - name parity with the RWS 2.0 method.
   * NOTE: `/rw/rapid/tasks/{task}/structural-changecount` does not exist on
   * RobotWare 6.16 (HTTP 404, live-probed 2026-08), so this reports 0 there.
   * The RWS 2.0 side returns the real counter. Kept so callers can use one name
   * across protocols without branching.
   */
  async getTaskStructuralChangeCount(task: string): Promise<number> {
    try {
      const r = await this.rws1Get(buildPath(RAPID.getTaskStructuralChangeCount.rws1 as PathSpec, { task }));
      const d = (r.state ?? {}) as Record<string, string>;
      return Number(d['struc-change-count'] ?? d['change-count'] ?? 0);
    } catch { return 0; }
  }

  /** Motion sub-resources a task exposes (robtarget, jointtarget, ...) - parity
   *  with the RWS 2.0 method; the resource is a directory of links. */
  async getTaskMotion(task: string): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(buildPath(RAPID.getTaskMotion.rws1 as PathSpec, { task }));
      const out: Record<string, string> = {};
      for (const s of r.states) {
        const d = s as Record<string, string>;
        const name = d['_title'] ?? '';
        if (name) { out[name] = (d['_type'] ?? '').replace(/^rapid-|-li$/g, ''); }
      }
      return out;
    } catch { return {}; }
  }

  /** Per-task activation record (current stack frame). Parity with RWS 2.0;
   *  the controller answers 400 "No such stack frame" when the task is idle. */
  async getTaskActivationRecord(task: string): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(buildPath(RAPID.getTaskActivationRecord.rws1 as PathSpec, { task }));
      return (r.state ?? {}) as Record<string, string>;
    } catch { return {}; }
  }

  /**
   * Grants held by the logged-in user. RWS 1.0 serves these at /users/grants
   * (class user-grant, the grant name in the title) - the /uas/* tree is the
   * one that does not exist on RobotWare 6, so this parity with the RWS 2.0
   * listCurrentUserGrants() is available after all. Found 2026-08 by crawling
   * the RW6.16 resource tree; previously assumed protocol-absent.
   */
  async listCurrentUserGrants(): Promise<string[]> {
    try {
      const r = await this.rws1Get(buildPath(USERS_UAS.listCurrentUserGrants.rws1 as PathSpec));
      return r.states
        .filter(s => (s as Record<string, string>)['_type'] === 'user-grant')
        .map(s => (s as Record<string, string>)['_title'] ?? (s as Record<string, string>)['grantname'])
        .filter(Boolean) as string[];
    } catch { return []; }
  }

  /**
   * Every configured network interface, not just the first. RWS 1.0 returns one
   * `ctrl-netw` entry per interface with addr / mask / name (live-verified
   * 2026-08 on RW6.16). getNetworkConfig() keeps returning the first entry for
   * backwards compatibility.
   */
  async listNetworkInterfaces(): Promise<Array<Record<string, string>>> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getNetworkConfig.rws1 as PathSpec));
      return r.states.filter(s => (s as Record<string, string>)['_type'] === 'ctrl-netw') as Array<Record<string, string>>;
    } catch { return []; }
  }

  /** Save a task's program to disk. Wire form verified 2026-08-04 on RW6.16
   *  (a bogus path root fails with a file error, proving action and field parse):
   *  POST /rw/rapid/tasks/{task}/program?action=save, body path=. */
  async saveProgram(task: string, destination: string): Promise<void> {
    await this.rws1Post(buildPath(RAPID.saveProgram.rws1 as PathSpec, { task }),
      `path=${encodeURIComponent(destination)}`);
  }

  /** Load a full RAPID program (.pgf) into a task. Wire form verified 2026-08-04
   *  on RW6.16: POST /rw/rapid/tasks/{task}/program?action=loadprog, body
   *  progpath= (a bogus file fails with "File not found", proving the parse).
   *  RWS 1.0 has no loadmode field - the argument is accepted for signature
   *  parity with RwsClient2.loadProgram and ignored. */
  async loadProgram(task: string, progpath: string, _loadmode: 'add' | 'replace' = 'replace'): Promise<void> {
    await this.rws1Post(buildPath(RAPID.loadProgram.rws1 as PathSpec, { task }),
      `progpath=${encodeURIComponent(progpath)}`);
  }

  /**
   * Set the program pointer to a routine. Live-verified 2026-08-04 on RW6.16:
   * POST /rw/rapid/tasks/{task}/pcp?action=set-pp-routine with BOTH module= and
   * routine= (routine alone answers "Invalid data") -> 204 under rapid
   * mastership. RWS 1.0 has no row/col cursor form; those params are not
   * supported here (parity signature with RwsClient2.setProgramPointer).
   */
  async setProgramPointer(task: string, params: { module?: string; routine: string; row?: number; col?: number }): Promise<void> {
    if (!params.module) {
      throw new RwsError('RWS 1.0 set-pp-routine requires the module name (module + routine)', 'INVALID_ARGUMENT');
    }
    await this.rws1Post(buildPath(RAPID.setProgramPointer.rws1 as PathSpec, { task }),
      `module=${encodeURIComponent(params.module)}&routine=${encodeURIComponent(params.routine)}`);
  }

  async startProductionMode(): Promise<void> {
    // Live-verified 2026-08-04 on RW6.16: the action is `startprodentry` (204,
    // execution starts). The previously used `start-prod` answers 400 "Invalid
    // argument" - it never existed on this RobotWare.
    await this.rws1Post(buildPath(RAPID.startProductionEntry.rws1 as PathSpec), '');
  }

  /** Canonical cross-protocol name for startProductionMode - same wire call.
   *  Matches RwsClient2.startProductionEntry (RWS 2.0 startprodentry). */
  startProductionEntry(): Promise<void> {
    return this.startProductionMode();
  }

  // ── Stage 13: Network / time / compatibility (5 methods) ──────────────

  /** List controller file volumes (devices). Live-verified 2026-08-04 on RW6.16:
   *  GET /fileservice lists class fs-device entries titled 'C:' etc. Parity with
   *  RwsClient2.listFileVolumes. */
  async listFileVolumes(): Promise<string[]> {
    try {
      const r = await this.rws1Get(buildPath(FILES_VISION.listFileVolumes.rws1 as PathSpec));
      const names = r.states
        .filter(s => (s as Record<string, string>)['_type'] === 'fs-device')
        .map(s => (s as Record<string, string>)['_title'])
        .filter(Boolean) as string[];
      return names.length > 0 ? names : ['$HOME', '$TEMP', '$BACKUP'];
    } catch { return ['$HOME', '$TEMP', '$BACKUP']; }
  }

  /** Load a CFG file into the configuration database. Wire form verified
   *  2026-08-04 on RW6.16 (a bogus file fails with "file or file path is either
   *  invalid or read only", proving action and both fields parse):
   *  POST /rw/cfg?action=load, body filepath + action-type. Requires cfg mastership. */
  async loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset' = 'replace'): Promise<void> {
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.loadCfgFile.rws1 as PathSpec),
      `filepath=${encodeURIComponent(filepath)}&action-type=${action}`);
  }

  /** Save a CFG domain to a file. POST /rw/cfg/{domain}?action=saveas, body
   *  filepath. The value must be a fileservice URI (bare '$TEMP/x' answers
   *  "invalid or read only"; '/fileservice/$TEMP/x' works - live round-tripped
   *  2026-08-04 on RW6.16: 204, file created and read back). Normalized here. */
  async saveCfgFile(domain: string, filepath: string): Promise<void> {
    const clean = filepath.replace(/^\/+/, '');
    const uri = clean.startsWith('fileservice/') ? `/${clean}` : `/fileservice/${clean}`;
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.saveCfgFile.rws1 as PathSpec, { domain }),
      `filepath=${encodeURIComponent(uri)}`);
  }

  /** Set the active tool of a mechunit. Wire form live-verified 2026-08-04 on
   *  RW6.16: POST /rw/motionsystem/mechunits/{m}?action=set, body tool= - without
   *  mastership it answers the mastership 403, with motion mastership it applies.
   *  Acquire -> set -> release-in-finally. */
  async setActiveTool(mechunit: string, toolName: string): Promise<void> {
    await this.client.requestMastership('motion');
    try {
      await this.rws1Post(buildPath(MOTION.setActiveTool.rws1 as PathSpec, { mechunit }),
        `tool=${encodeURIComponent(toolName)}`);
    } finally {
      await this.client.releaseMastership('motion').catch(() => {});
    }
  }

  /** Set the active work object of a mechunit (same wire form as setActiveTool). */
  async setActiveWobj(mechunit: string, wobjName: string): Promise<void> {
    await this.client.requestMastership('motion');
    try {
      await this.rws1Post(buildPath(MOTION.setActiveWobj.rws1 as PathSpec, { mechunit }),
        `wobj=${encodeURIComponent(wobjName)}`);
    } finally {
      await this.client.releaseMastership('motion').catch(() => {});
    }
  }

  async getNetworkConfig(): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getNetworkConfig.rws1 as PathSpec));
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  async getDnsConfig(): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getDnsConfig.rws1 as PathSpec));
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  async getRoutingTable(): Promise<Array<Record<string, string>>> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getRoutingTable.rws1 as PathSpec));
      return r.states as Array<Record<string, string>>;
    } catch { return []; }
  }

  async getTimezone(): Promise<{ tz: string; raw: Record<string, string> }> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getTimezone.rws1 as PathSpec));
      const s = (r.state as Record<string, string>) ?? {};
      return { tz: s.timezone ?? '', raw: s };
    } catch { return { tz: '', raw: {} }; }
  }

  async getCompatibility(): Promise<{ compatible: boolean; details?: Record<string, string> }> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getCompatibility.rws1 as PathSpec));
      const s = (r.state as Record<string, string>) ?? {};
      return { compatible: (s.compatible ?? '').toLowerCase() === 'true', details: s };
    } catch { return { compatible: false }; }
  }

  // ── Stage 14: Set mechunit / robtarget for jogging (2 methods) ────────

  async setMechunitForJogging(mechunit: string): Promise<void> {
    await this.rws1Post(buildPath(MOTION.setMechunitForJogging.rws1 as PathSpec), `mechunit=${encodeURIComponent(mechunit)}`);
  }

  async setRobtargetForJogging(target: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void> {
    const t = target;
    await this.rws1Post(buildPath(MOTION.setRobtargetForJogging.rws1 as PathSpec),
      `x=${t.x}&y=${t.y}&z=${t.z}&q1=${t.q1}&q2=${t.q2}&q3=${t.q3}&q4=${t.q4}`);
  }

  // ── Inverse kinematics ──────────────────────────────────────────────────

  async calcJointsFromCartesian(
    pos: RobTarget,
    seedJoints?: JointTarget,
    mechunit = 'ROB_1',
  ): Promise<JointTarget> {
    if (!this.creds) {
      throw new RwsError('IK requires credentials - reconnect to enable', 'INVALID_ARGUMENT');
    }
    const { host, port, username, password } = this.creds;
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

    const path = `${buildPath(MOTION.calcJointsFromCartesian.rws1 as PathSpec, { mechunit })}&json=1`;
    const result = await this.digestPost(host, port, path, bodyStr, username, password);
    // RWS 1.0 IK response shape: { _embedded: { _state: [{ rax_1, rax_2, ... }] } }
    const state = (result as { _embedded?: { _state?: Array<Record<string, string>> } })._embedded?._state?.[0];
    if (!state) { throw new RwsError('IK: no result in response', 'PARSE_ERROR'); }
    return {
      rax_1: +state.rax_1, rax_2: +state.rax_2, rax_3: +state.rax_3,
      rax_4: +state.rax_4, rax_5: +state.rax_5, rax_6: +state.rax_6,
    };
  }

  private digestPost(host: string, port: number, path: string, body: string, user: string, pass: string): Promise<Record<string, unknown>> {
    // Two-step Digest: first GET challenge, then POST with auth header
    return new Promise((resolve, reject) => {
      // Step 1: send no-auth POST to get the 401 challenge
      const challenge = http.request({ method: 'POST', hostname: host, port, path, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res1 => {
        const wwwAuth = (res1.headers['www-authenticate'] ?? '') as string;
        res1.resume();
        if (res1.statusCode !== 401) { reject(new Error(`IK: expected 401 challenge, got ${res1.statusCode}`)); return; }

        // Parse Digest challenge
        const realm  = wwwAuth.match(/realm="([^"]+)"/)?.[1] ?? '';
        const nonce  = wwwAuth.match(/nonce="([^"]+)"/)?.[1] ?? '';
        const qop    = wwwAuth.match(/qop="([^"]+)"/)?.[1] ?? 'auth';

        // Build auth header (RFC 2617)
        const cnonce = crypto.randomBytes(8).toString('hex');
        const nc     = '00000001';
        const ha1    = crypto.createHash('md5').update(`${user}:${realm}:${pass}`).digest('hex');
        const ha2    = crypto.createHash('md5').update(`POST:${path.split('?')[0]}`).digest('hex');
        const respH  = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');
        const authH  = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path.split('?')[0]}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${respH}"`;

        // Step 2: POST with Digest auth
        const encoded = Buffer.from(body);
        const req2 = http.request({
          method: 'POST', hostname: host, port, path,
          headers: {
            Authorization: authH,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(encoded.length),
            Accept: 'application/json',
          },
        }, res2 => {
          const chunks: Buffer[] = [];
          res2.on('data', (c: Buffer) => chunks.push(c));
          res2.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if ((res2.statusCode ?? 0) >= 400) {
              let msg = `IK HTTP ${res2.statusCode}`;
              try { msg = JSON.parse(raw)._embedded?.status?.msg ?? msg; } catch { /* ok */ }
              reject(new Error(msg));
              return;
            }
            try { resolve(JSON.parse(raw) as Record<string, unknown>); }
            catch { reject(new Error('IK: could not parse response')); }
          });
        });
        req2.on('error', reject);
        req2.write(encoded);
        req2.end();
      });
      challenge.on('error', reject);
      challenge.end();
    });
  }
}
