import { RwsClient } from './RwsClient.js';
import type {
  ExecutionCycle, JointTarget, RobTarget, RapidSymbolSearchParams,
  RestartMode, MastershipDomain, SubscriptionResource, SubscriptionEvent,
} from './types.js';
import * as http from 'http';
import * as crypto from 'crypto';
import type { IRWSAdapter } from './IRWSAdapter.js';

interface RWS1Credentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * RWS 1.0 adapter — thin wrapper around RwsClient (abb-rws-client).
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
    const r = await this.rws1Get(`/rw/rapid/modules?task=${encodeURIComponent(task)}`);
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
  /** RwsClient has no listMechunits — IRC5 always has ROB_1 as the standard mechunit. */
  async listMechunits(): Promise<string[]> { return ['ROB_1']; }

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
    await this.rws1Post('/rw/mastership?action=request', '');
  }
  /** Release mastership on all domains at once. */
  async releaseMastershipAll(): Promise<void> {
    await this.rws1Post('/rw/mastership?action=release', '');
  }
  /**
   * RWS 1.0 doesn't expose `request-with-id` / `release-with-id` — those are
   * RWS 2.0 / RobotWare 7+ additions. The `?` in the IRWSAdapter signature
   * means we don't have to implement on this side; calls just throw.
   */
  /**
   * RWS 1.0 doesn't expose a watchdog endpoint — heartbeat is RWS 2.0 only.
   * The optional method on IRWSAdapter is left undefined here so callers can
   * feature-detect (`if ('resetMastershipWatchdog' in adapter)`).
   */
  /** Read mastership status for one domain. */
  async getMastershipStatus(d: MastershipDomain): Promise<{ mastership: string; uid?: string; application?: string }> {
    const r = await this.rws1Get(`/rw/mastership/${d}`);
    const s = r.state as { mastership?: string; uid?: string; application?: string } | null;
    return { mastership: s?.mastership ?? 'unknown', uid: s?.uid, application: s?.application };
  }
  /** List mastership domains (RWS 1.0: ['cfg', 'motion', 'rapid']). */
  async listMastershipDomains(): Promise<string[]> {
    const r = await this.rws1Get('/rw/mastership');
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
    const r = await this.rws1Get('/rw/iosystem/devices');
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
    if (!this.creds) { throw new Error('FK requires credentials in adapter constructor'); }
    const { host, port, username, password } = this.creds;
    const body = [
      `curr_joints=[${joints.rax_1},${joints.rax_2},${joints.rax_3},${joints.rax_4},${joints.rax_5},${joints.rax_6}]`,
      `curr_ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]`,
      `tool=${tool}`,
      `wobj=${wobj}`,
    ].join('&');
    const path = `/rw/motionsystem/mechunits/${mechunit}?action=CalcRobTFromJoints&json=1`;
    const result = await this.digestPost(host, port, path, body, username, password) as { _embedded?: { _state?: Array<Record<string, string>> } };
    const state = result._embedded?._state?.[0];
    if (!state) { throw new Error('FK: no result in response'); }
    return {
      x: +state.x, y: +state.y, z: +state.z,
      q1: +state.q1, q2: +state.q2, q3: +state.q3, q4: +state.q4,
    };
  }

  subscribe(resources: SubscriptionResource[], handler: (event: SubscriptionEvent) => void) {
    return this.client.subscribe(resources, handler);
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
      throw new Error('Jog requires credentials — reconnect to enable');
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
    const path = `/rw/motionsystem?action=jog&json=1`;
    const result = await this.digestPost(host, port, path, bodyStr, username, password);
    // Successful jog has no useful body — only check for error status.
    const status = (result._embedded as { status?: { msg?: string } } | undefined)?.status;
    if (status?.msg && status.msg.length > 0 && /error|fail/i.test(status.msg)) {
      throw new Error(status.msg);
    }
  }

  // ── RWS 1.0 helper — typed wrapper around client.request() with JSON parsing ──

  /**
   * Generic GET that returns `_embedded._state[0]` (single resource) or [] (list).
   * Most RWS 1.0 endpoints with `?json=1` return this HAL-like envelope.
   * Returns empty result for HTTP 204 (no content) — common on /ctrl/options etc.
   */
  private async rws1Get(path: string): Promise<{ status: number; state: Record<string, unknown> | null; states: Array<Record<string, unknown>>; raw: unknown }> {
    const url = path + (path.includes('?') ? '&' : '?') + 'json=1';
    const res = await this.client.request('GET', url);
    if (res.status === 204 || !res.body) {
      return { status: res.status, state: null, states: [], raw: null };
    }
    if (res.status >= 400) {
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(res.body)._embedded?.status?.msg ?? msg; } catch { /* ok */ }
      throw new Error(msg);
    }
    let parsed: { _embedded?: { _state?: Array<Record<string, unknown>> } } = {};
    try { parsed = JSON.parse(res.body); } catch { /* non-JSON ok */ }
    const states = parsed._embedded?._state ?? [];
    return { status: res.status, state: states[0] ?? null, states, raw: parsed };
  }

  /** Generic POST that throws on >=400, returns the parsed JSON body. */
  private async rws1Post(path: string, body?: string): Promise<unknown> {
    const url = path + (path.includes('?') ? '&' : '?') + 'json=1';
    const res = await this.client.request('POST', url, body);
    if (res.status >= 400) {
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(res.body)._embedded?.status?.msg ?? msg; } catch { /* ok */ }
      throw new Error(msg);
    }
    try { return JSON.parse(res.body); } catch { return null; }
  }

  // ── System detail ───────────────────────────────────────────────────────

  async getRobotType(): Promise<{ type: string; variant?: string }> {
    const r = await this.rws1Get('/rw/system/robottype');
    const s = r.state as { 'robot-type'?: string; type?: string; variant?: string } | null;
    return { type: s?.['robot-type'] ?? s?.type ?? '', variant: s?.variant };
  }

  async getLicenseInfo(): Promise<{ entries: Array<Record<string, string>> }> {
    // RWS 1.0 path is singular `/license`. Doc 6.8 has it as plural `/licenses`
    // but live IRC5 returns 404 for that — singular works.
    const r = await this.rws1Get('/rw/system/license');
    return { entries: r.states as Array<Record<string, string>> };
  }

  async listProducts(): Promise<Array<Record<string, string>>> {
    const r = await this.rws1Get('/rw/system/products');
    return r.states as Array<Record<string, string>>;
  }

  async getEnergyStats(): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get('/rw/system/energy');
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

  async listControllerOptions(): Promise<Array<{ name: string; description?: string }>> {
    try {
      const r = await this.rws1Get('/ctrl/options');
      return r.states.map(o => ({
        name: (o.option ?? o.name ?? '') as string,
        description: o.description as string | undefined,
      }));
    } catch { return []; }
  }

  // ── Motion detail ──────────────────────────────────────────────────────

  async getMotionChangeCount(): Promise<number> {
    const r = await this.rws1Get('/rw/motionsystem');
    const s = r.state as { 'change-count'?: string } | null;
    return Number(s?.['change-count'] ?? 0);
  }

  async getMotionErrorState(): Promise<{ state: string; details?: Record<string, string> }> {
    const r = await this.rws1Get('/rw/motionsystem/errorstate');
    const s = r.state as Record<string, string> | null;
    return { state: s?.['err-state'] ?? s?.state ?? 'unknown', details: s ?? undefined };
  }

  async getNonMotionExecution(): Promise<boolean> {
    const r = await this.rws1Get('/rw/motionsystem/nonmotionexecution');
    const s = r.state as { mode?: string } | null;
    return (s?.mode ?? '').toUpperCase() === 'ON';
  }

  async setNonMotionExecution(enabled: boolean): Promise<void> {
    await this.rws1Post('/rw/motionsystem/nonmotionexecution?action=set', `mode=${enabled ? 'ON' : 'OFF'}`);
  }

  async getMechunitInfo(mechunit = 'ROB_1'): Promise<Record<string, string>> {
    const r = await this.rws1Get(`/rw/motionsystem/mechunits/${mechunit}`);
    return (r.state as Record<string, string>) ?? {};
  }

  async getMechunitBaseFrame(mechunit = 'ROB_1'): Promise<{ x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }> {
    const r = await this.rws1Get(`/rw/motionsystem/mechunits/${mechunit}/baseframe`);
    const s = (r.state as Record<string, string>) ?? {};
    return { x: +s.x, y: +s.y, z: +s.z, q1: +s.q1, q2: +s.q2, q3: +s.q3, q4: +s.q4 };
  }

  async getMechunitAxes(mechunit = 'ROB_1'): Promise<Array<Record<string, string>>> {
    // RWS 1.0 returns 2 entries: an axis-count summary and a sub-resource link list.
    // Fetch each axis individually to get its real data.
    const r = await this.rws1Get(`/rw/motionsystem/mechunits/${mechunit}/axes`);
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
    const r = await this.rws1Get(`/rw/motionsystem/mechunits/${mechunit}`);
    const s = (r.state as Record<string, string>) ?? {};
    return { name: s['tool-name'] ?? 'tool0' };
  }

  async getActiveWobj(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
    const r = await this.rws1Get(`/rw/motionsystem/mechunits/${mechunit}`);
    const s = (r.state as Record<string, string>) ?? {};
    return { name: s['wobj-name'] ?? 'wobj0' };
  }

  async getActivePayload(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
    const r = await this.rws1Get(`/rw/motionsystem/mechunits/${mechunit}`);
    const s = (r.state as Record<string, string>) ?? {};
    return { name: s['total-payload-name'] ?? s['payload-name'] ?? 'load0' };
  }

  // ── RAPID detail ───────────────────────────────────────────────────────

  async listAliasIO(): Promise<Array<{ alias: string; signal: string }>> {
    try {
      const r = await this.rws1Get('/rw/rapid/aliasio');
      return r.states.map(a => ({
        alias: (a.name ?? a.alias ?? '') as string,
        signal: (a.signal ?? a._title ?? '') as string,
      }));
    } catch { return []; }
  }

  async getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> {
    try {
      const r = await this.rws1Get(`/rw/rapid/tasks/${task}/pcp`);
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
      const r = await this.rws1Get(`/rw/rapid/tasks/${task}/motion`);
      const s = (r.state as Record<string, string>) ?? {};
      return {
        module:  s.modulename ?? s.modulemame ?? s.module,
        routine: s.routinename ?? s.routine,
      };
    } catch { return {}; }
  }

  // ── CFG database ───────────────────────────────────────────────────────

  async listCfgDomains(): Promise<string[]> {
    const r = await this.rws1Get('/rw/cfg');
    return r.states.map(d => (d._title ?? d.name) as string).filter(Boolean);
  }

  async listCfgTypes(domain: string): Promise<string[]> {
    const types: string[] = [];
    let path = `/rw/cfg/${domain}`;
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
      const r = await this.rws1Get(`/rw/cfg/${domain}/${type}/instances`);
      return r.states.map(i => (i._title ?? i.name) as string).filter(Boolean);
    } catch { return []; }
  }

  async getCfgInstance(domain: string, type: string, instance: string): Promise<Record<string, string>> {
    // RWS 1.0 inlines all attribute data in the instance-list response. The single-instance
    // GET also works at `/instances/{name}`. Use the list call (one HTTP request) and find
    // by _title — also handles instance names with spaces/special chars correctly.
    const r = await this.rws1Get(`/rw/cfg/${domain}/${type}/instances`);
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
    // Always include direct properties (rdonly, instanceid, etc.) — useful metadata.
    for (const [k, v] of Object.entries(target)) {
      if (k.startsWith('_') || k === 'attrib') { continue; }
      if (typeof v === 'string') { out[k] = v; }
    }
    return out;
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
      const r = await this.rws1Get('/ctrl/backup');
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
      const r = await this.rws1Get('/users/rmmp');
      const s = (r.state as Record<string, string>) ?? {};
      const priv = s.privilege ?? 'none';
      const heldByMe = (s.rmmpheldbyme ?? 'false').toLowerCase() === 'true';
      if (priv === 'none' || priv.startsWith('pending')) { return priv; }
      return heldByMe ? priv : 'none';
    } catch { return 'none'; }
  }

  async requestRmmp(level: 'modify' | 'exclusive' = 'modify'): Promise<void> {
    await this.rws1Post('/users/rmmp', `privilege=${level}`);
  }

  // ── Stage 7: Backup / Restore / Progress (5 methods) ───────────────────

  async createBackup(name: string): Promise<void> {
    // Async — controller returns 202 + Location header pointing to /progress/{id}.
    // Caller polls getProgress() to track completion.
    await this.rws1Post('/ctrl/backup?action=backup', `backup=$BACKUP/${encodeURIComponent(name)}`);
  }

  async restoreBackup(name: string): Promise<void> {
    await this.rws1Post('/ctrl/backup?action=restore', `backup=$BACKUP/${encodeURIComponent(name)}`);
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
      const r = await this.rws1Get('/rw/dipc');
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
    await this.rws1Post('/rw/dipc?action=create', parts.join('&'));
  }

  async sendDipcMessage(queue: string, payload: string, type: 'string' | 'num' | 'dnum' | 'bool' = 'string'): Promise<void> {
    const typeCode = type === 'string' ? '0' : type === 'num' ? '1' : type === 'dnum' ? '2' : '3';
    await this.rws1Post(`/rw/dipc/${encodeURIComponent(queue)}?action=send`,
      `dipc-src-queue-name=${encodeURIComponent(queue)}&dipc-cmd=111&dipc-data=${encodeURIComponent(payload)}&dipc-msgtype=${typeCode}`);
  }

  async readDipcMessage(queue: string): Promise<{ payload: string; type: string } | null> {
    try {
      const r = await this.rws1Get(`/rw/dipc/${encodeURIComponent(queue)}?action=read`);
      const s = r.state as Record<string, string> | null;
      if (!s || !s['dipc-data']) { return null; }
      return { payload: s['dipc-data'], type: s['dipc-msgtype'] ?? 'string' };
    } catch { return null; }
  }

  async removeDipcQueue(name: string): Promise<void> {
    await this.client.request('DELETE', `/rw/dipc/${encodeURIComponent(name)}?json=1`);
  }

  // ── Stage 9: Safety (5 methods) ────────────────────────────────────────

  async getSafetyStatus(): Promise<{ state: string; details?: Record<string, string> }> {
    try {
      const r = await this.rws1Get('/ctrl/safety');
      const s = r.state as Record<string, string> | null;
      return { state: s?.state ?? 'unavailable', details: s ?? undefined };
    } catch { return { state: 'unavailable' }; }
  }

  async listSafetyZones(): Promise<Array<Record<string, string>>> {
    try {
      const r = await this.rws1Get('/ctrl/safety/zones');
      return r.states as Array<Record<string, string>>;
    } catch { return []; }
  }

  async runCyclicBrakeCheck(): Promise<void> {
    await this.rws1Post('/ctrl/safety/cyclic-brake-check', '');
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
    await this.rws1Post('/ctrl/virtualtime/vtspeed?action=set', `vtcurrspeed=${scale}`);
  }

  // ── Stage 11: Vision (5 methods) ───────────────────────────────────────

  async listVisionSystems(): Promise<Array<{ name: string; status?: string }>> {
    try {
      const r = await this.rws1Get('/rw/vision');
      return r.states.map(v => ({
        name:   (v._title ?? v.name ?? '') as string,
        status: v.status as string | undefined,
      }));
    } catch { return []; }
  }

  async getVisionSystemInfo(name: string): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(`/rw/vision/${encodeURIComponent(name)}`);
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  async triggerVisionJob(system: string): Promise<void> {
    await this.rws1Post(`/rw/vision/${encodeURIComponent(system)}?action=trigger`, '');
  }

  // ── Stage 12: RAPID extras (4 methods) ─────────────────────────────────

  async saveModule(task: string, moduleName: string, filepath: string): Promise<void> {
    await this.rws1Post(`/rw/rapid/tasks/${task}?action=savemod`,
      `name=${encodeURIComponent(moduleName)}&filepath=${encodeURIComponent(filepath)}`);
  }

  async listModuleRoutines(task: string, moduleName: string): Promise<Array<{ name: string; type: string }>> {
    try {
      const r = await this.rws1Get(`/rw/rapid/modules/${task}/${moduleName}/routines`);
      return r.states.map(rt => ({
        name: (rt.name ?? rt._title ?? '') as string,
        type: (rt.type ?? '') as string,
      }));
    } catch { return []; }
  }

  async listBreakpoints(task: string): Promise<Array<{ module: string; row: number; col?: number }>> {
    try {
      // Per official doc: CCRapidBreakPointResource — exact path varies by RW version.
      const r = await this.rws1Get(`/rw/rapid/tasks/${task}/breakpoints`);
      return r.states.map(b => ({
        module: (b.module ?? b.modulename ?? '') as string,
        row:    +(b['begin-position-row'] ?? b.row ?? 0),
        col:    b['begin-position-col'] !== undefined ? +(b['begin-position-col'] as string) : undefined,
      }));
    } catch { return []; }
  }

  async holdToRun(task: string, action: 'press' | 'release'): Promise<void> {
    await this.rws1Post(`/rw/rapid/tasks/${task}?action=holdtorun`, `action=${action}`);
  }

  async startProductionMode(): Promise<void> {
    await this.rws1Post('/rw/rapid/execution?action=start-prod', '');
  }

  // ── Stage 13: Network / time / compatibility (5 methods) ──────────────

  async getNetworkConfig(): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get('/ctrl/network');
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  async getDnsConfig(): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get('/ctrl/network/dns');
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  async getRoutingTable(): Promise<Array<Record<string, string>>> {
    try {
      const r = await this.rws1Get('/ctrl/network/routes');
      return r.states as Array<Record<string, string>>;
    } catch { return []; }
  }

  async getTimezone(): Promise<{ tz: string; raw: Record<string, string> }> {
    try {
      const r = await this.rws1Get('/ctrl/clock/timezone');
      const s = (r.state as Record<string, string>) ?? {};
      return { tz: s.timezone ?? '', raw: s };
    } catch { return { tz: '', raw: {} }; }
  }

  async getCompatibility(): Promise<{ compatible: boolean; details?: Record<string, string> }> {
    try {
      const r = await this.rws1Get('/ctrl/compatible');
      const s = (r.state as Record<string, string>) ?? {};
      return { compatible: (s.compatible ?? '').toLowerCase() === 'true', details: s };
    } catch { return { compatible: false }; }
  }

  // ── Stage 14: Set mechunit / robtarget for jogging (2 methods) ────────

  async setMechunitForJogging(mechunit: string): Promise<void> {
    await this.rws1Post('/rw/motionsystem?action=set-mechunit', `mechunit=${encodeURIComponent(mechunit)}`);
  }

  async setRobtargetForJogging(target: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void> {
    const t = target;
    await this.rws1Post('/rw/motionsystem?action=set-target',
      `x=${t.x}&y=${t.y}&z=${t.z}&q1=${t.q1}&q2=${t.q2}&q3=${t.q3}&q4=${t.q4}`);
  }

  // ── Inverse kinematics ──────────────────────────────────────────────────

  async calcJointsFromCartesian(
    pos: RobTarget,
    seedJoints?: JointTarget,
    mechunit = 'ROB_1',
  ): Promise<JointTarget> {
    if (!this.creds) {
      throw new Error('IK requires credentials — reconnect to enable');
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

    const path = `/rw/motionsystem/mechunits/${mechunit}?action=CalcJointsFromPose&json=1`;
    const result = await this.digestPost(host, port, path, bodyStr, username, password);
    // RWS 1.0 IK response shape: { _embedded: { _state: [{ rax_1, rax_2, ... }] } }
    const state = (result as { _embedded?: { _state?: Array<Record<string, string>> } })._embedded?._state?.[0];
    if (!state) { throw new Error('IK: no result in response'); }
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
