import { RwsClient } from './RwsClient.js';
import type {
  ExecutionCycle, JointTarget, JointTargetFull, RobTarget, RapidSymbolSearchParams,
  RestartMode, MastershipDomain, AnySubscriptionResource, SubscriptionEvent,
  ElogMessage, ReturnCodeInfo, Signal, SignalSearchExCriteria, IoDevice,
  JogParams, RmmpLevel, RefusalContext,
  CfgTypeInfo, DipcQueueInfo, FileMetadata, RapidRoutineInfo,
  SubscriptionGroupInfo, SubscriptionGroupMember, MotionSupervisionState, PathSupervisionState,
  MechunitMotorCalib, LeadThroughState, RobotWareCompatibility, RapidBuildError,
} from './types.js';
import { decodeElogArgs, RwsError, type TaskRobTarget } from './types.js';
import { JOINT_NOT_PRESENT } from './mechunit.js';
import { asJogPostError, checkJog, checkJogUnit, jogBody, jogChangeCount, jogUnitName, jogUnitToSelect } from './jog.js';
import { isRmmpPending, normaliseRmmpPrivilege, rmmpLevel } from './access/rmmp.js';
import { parseSignalList, parseDevices, elogMsgtype, decodeEntities } from './ResponseParser.js';
import { buildSubscriptionBody, resourcePaths } from './WsSubscriber.js';
import { dropFromGroup } from './subscriptionKinds.js';
import { asSubscriptionUpdateError, readSubscriptionUpdateAnswer, SubscriptionUpdateError } from './subscriptionUpdateError.js';
import { classifyControllerError } from './ControllerError.js';
import { builtRefusal, holderFromMastership, remedy } from './refusal.js';
import type { IRWSAdapter } from './IRWSAdapter.js';
import { AccessManager, accessOf, bindAccess, mastershipDriver, type AllLocksWire } from './access/AccessManager.js';
import {
  PANEL, RAPID, MOTION, IO, CFG_ELOG_DIPC, CTRL, SYSTEM_MASTERSHIP, USERS_UAS, FILES_VISION,
} from './paths/index.js';
import { buildPath, type PathSpec } from './paths/PathSpec.js';
import { virtualTimeRunningUnsupported } from './paths/ctrl.js';
import { controllerJobName, type ControllerJobName } from './controllerJobs.js';
import {
  aliasIoFrom, cfgAttributesFrom, cfgTypeFrom, dipcQueueInfoFrom, parseBody, pickEntry, progressIdFrom,
  envName, envValueFrom, motionPointerFrom, rapidTaskFrom, routinesFromSymbols, taskSelectionFrom,
  leadThroughFrom, mechunitName, motionSupervisionFrom, motorCalibFrom, pathSupervisionFrom, smbDataFrom,
  subscriptionGroupId, subscriptionGroupsFrom, subscriptionMembersFrom, compatibilityFrom, compatibilityVersion,
  BUILD_ERROR_PAGES, buildErrorsFrom, readPages, robotTypesFrom,
} from './commonReads.js';

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
/**
 * Longest DIPC read wait on RWS 1.0, 280 s: under the 300 s Node's fetch
 * waits for an answer's headers (fetch is the RWS 1.0 transport on every
 * port it accepts; through node:http, on a port fetch refuses, the read's own
 * timeout is the only bound). The cap also limits how long one read can hold
 * the client's serial request queue.
 */
export const RWS1_DIPC_MAX_WAIT_MS = 280_000;

/** A count the controller reported, or null when it reported none. */
function countOrNull(v: string | undefined): number | null {
  if (v === undefined || v === '') { return null; }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rws1Error(method: string, path: string, status: number, body: string, context?: RefusalContext, requestBody?: string): RwsError {
  const info = classifyControllerError({ httpStatus: status, body: body ?? '', method, path, context, requestBody });
  return new RwsError(
    info.message, info.code, status, body,
    info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal,
  );
}

/**
 * The next page of an RWS 1.0 `?json=1` listing as a request path, or '' when
 * there is none. The `next` href is relative to the body's `base` href (or
 * to `fallbackBase`); the controller's `&amp;` is unescaped and `json=1`
 * dropped (the caller adds it back).
 */
function rws1NextPath(body: string, fallbackBase: string): string {
  let parsed: { _links?: { base?: { href?: string }; next?: { href?: string } } } = {};
  try { parsed = JSON.parse(body); } catch { return ''; }
  const next = parsed._links?.next?.href;
  if (!next) { return ''; }
  const base = parsed._links?.base?.href ?? `http://controller${fallbackBase}`;
  let url: URL;
  try { url = new URL(next.replace(/&amp;/g, '&'), base); } catch { return ''; }
  url.searchParams.delete('json');
  return url.pathname + url.search;
}

/**
 * RWS 1.0 adapter - thin wrapper around RwsClient (abb-rws-client).
 * Every method delegates directly; zero logic change from pre-adapter behavior.
 * Targets ABB IRC5 controllers running RobotWare 6.x.
 */
export class RWS1Adapter implements IRWSAdapter {
  /** The client's session access manager (one per session): every mastership
   *  request and release of this adapter goes through it. */
  private readonly access: AccessManager;

  /** The all-domains request and release (one wire call each). */
  private readonly allDomainsWire: AllLocksWire = {
    request: async () => { await this.rws1Post(buildPath(SYSTEM_MASTERSHIP.requestMastershipAll.rws1 as PathSpec), ''); },
    release: async () => { await this.rws1Post(buildPath(SYSTEM_MASTERSHIP.releaseMastershipAll.rws1 as PathSpec), ''); },
  };

  constructor(
    private readonly client: RwsClient,
    private readonly creds?: RWS1Credentials,
  ) {
    // A client built by this package brings its session's manager; anything
    // else that only offers the request and release calls gets one of its own.
    this.access = accessOf(client) ?? new AccessManager(mastershipDriver(client, 'rws1'));
    bindAccess(this, this.access);
    // A mastership request refused as held by someone else names the holder,
    // from one read of the domain's mastership status.
    this.access.setHolderLookup(async lock => holderFromMastership(
      await this.getMastershipStatus(lock === 'cfg' || lock === 'motion' ? lock : 'rapid')));
  }

  /** What this session knows when a request is refused (see AccessManager.refusalContext). */
  private refusalContext(): RefusalContext {
    return {
      generation: 'rw6',
      ...this.access.refusalContext(),
      ...(this.creds?.username ? { user: this.creds.username } : {}),
    };
  }

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
  /** @experimental Built from the controller form; RW 6.16.03 refused it (403, an option missing), no logged 2xx on RWS 1.0. */
  lockOperationMode(pin: string, p?: boolean)    { return this.client.lockOperationMode(pin, p); }
  /** @experimental Built from the controller form; RW 6.16.03 refused it as it refused the lock, no logged 2xx on RWS 1.0. */
  unlockOperationMode(pin?: string)              { return this.client.unlockOperationMode(pin); }
  setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF') { return this.client.setOperationMode(mode); }

  // ── RAPID execution ─────────────────────────────────────────────────────
  //
  // Access. The RAPID writes below hold RAPID mastership around themselves
  // (a hold the session already has is reused and not ended). ABB's RWS 1.0
  // pages ask for it by name on module load and unload ("Rapid Mastership
  // Required") and on the RAPID variable write ("Client needs RAPID mastership
  // in AUTO mode"); for task activation and the variable write they add that
  // the controller takes it internally when the client holds none. Start, PP
  // to main, PP to routine, cycle, program load and the answer to a UI
  // instruction name no domain on their RWS 1.0 pages; they are held under
  // RAPID mastership, the domain the PC SDK names for starting, resetting the
  // program pointer and answering a UI instruction, and the one start, PP to
  // routine and cycle were accepted under on an RW 6.16 VC (2026-09-24). Stop
  // takes nothing: a stop never waits for access.
  getRapidExecutionState()            { return this.client.getRapidExecutionState(); }
  getRapidExecutionInfo()             { return this.client.getRapidExecutionInfo(); }
  startRapid(): Promise<void>         { return this.access.withAccess(['rapid'], () => this.client.startRapid()); }
  stopRapid()                         { return this.client.stopRapid(); }
  resetRapid(): Promise<void>         { return this.access.withAccess(['rapid'], () => this.client.resetRapid()); }
  setExecutionCycle(c: ExecutionCycle): Promise<void> {
    return this.access.withAccess(['rapid'], () => this.client.setExecutionCycle(c));
  }
  getRapidTasks()                     { return this.client.getRapidTasks(); }
  activateRapidTask(t: string): Promise<void>   { return this.access.withAccess(['rapid'], () => this.client.activateRapidTask(t)); }
  deactivateRapidTask(t: string): Promise<void> { return this.access.withAccess(['rapid'], () => this.client.deactivateRapidTask(t)); }
  activateAllRapidTasks(): Promise<void>        { return this.access.withAccess(['rapid'], () => this.client.activateAllRapidTasks()); }
  deactivateAllRapidTasks(): Promise<void>      { return this.access.withAccess(['rapid'], () => this.client.deactivateAllRapidTasks()); }

  // ── RAPID modules & variables ───────────────────────────────────────────
  listModules(task: string)                                    { return this.client.listModules(task); }

  /** RWS 1.0 module-list also exposes name + type (SysMod / ProgMod) per entry. */
  async listModulesDetailed(task: string): Promise<Array<{ name: string; type: string }>> {
    const r = await this.rws1Get(`${buildPath(RAPID.listModulesDetailed.rws1 as PathSpec)}?task=${encodeURIComponent(task)}`);
    return r.states
      .map(s => ({ name: (s as Record<string,string>)['name'] ?? '', type: (s as Record<string,string>)['type'] ?? '' }))
      .filter(m => m.name);
  }
  loadModule(task: string, path: string, r?: boolean): Promise<void> {
    return this.access.withAccess(['rapid'], () => this.client.loadModule(task, path, r));
  }
  unloadModule(task: string, name: string): Promise<void> {
    return this.access.withAccess(['rapid'], () => this.client.unloadModule(task, name));
  }
  getRapidVariable(t: string, m: string, s: string)            { return this.client.getRapidVariable(t, m, s); }
  /** Write a RAPID variable under RAPID mastership. In manual mode ABB's RWS
   *  1.0 page also asks for RMMP, which this call does not request. */
  setRapidVariable(t: string, m: string, s: string, v: string): Promise<void> {
    return this.access.withAccess(['rapid'], () => this.client.setRapidVariable(t, m, s, v));
  }
  validateRapidValue(t: string, v: string, d: string)          { return this.client.validateRapidValue(t, v, d); }
  getRapidSymbolProperties(t: string, m: string, s: string)    { return this.client.getRapidSymbolProperties(t, m, s); }
  searchRapidSymbols(p: RapidSymbolSearchParams)                { return this.client.searchRapidSymbols(p); }
  getActiveUiInstruction()                                     { return this.client.getActiveUiInstruction(); }
  /** Answer the active UI instruction under RAPID mastership. The RWS 1.0 page
   *  names no mastership; the PC SDK's answer to a UI instruction needs RAPID
   *  mastership, so that is held until a live run shows the controller's rule.
   */
  setUiInstructionParam(su: string, up: string, v: string): Promise<void> {
    return this.access.withAccess(['rapid'], () => this.client.setUiInstructionParam(su, up, v));
  }

  // ── Motion ──────────────────────────────────────────────────────────────
  getJointPositions(u?: string) { return this.client.getJointPositions(u); }
  getCartesianFull(u?: string)  { return this.client.getCartesianFull(u); }
  /** Every axis slot (rax_1..6 + eax_a..f) of a mechunit - XHTML, same resource as getJointPositions. */
  getJointTargetFull(u?: string): Promise<JointTargetFull> { return this.client.getJointTargetFull(u); }
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

  /**
   * The physical joint values of a mechanical unit: GET
   * `/rw/motionsystem/mechunits/{mechunit}/pjoints`. RW 6.16.03 links the
   * resource from the mechunit (`ROB_1/pjoints`, read 2026-09-29); ABB's RWS 2.0
   * Motion System page (Rev L) gives the item class `ms-mechunit-pjoints` with
   * `j1`..`j6`. RW 6.16.03 answers that class (2026-10-01); the item is taken
   * by it, else the first entry, and every non-link field is read as a number,
   * as the RWS 2.0 method does. On the RW 6.16.03, 7.21.4 and 8.2.1 virtual
   * controllers the values are j1..j6 = 0, 1, 2, 3, 4, 5 whatever the pose
   * (the robot stood at [0, 0, 0, 0, 30, 0]; 2026-10-01): not joint angles.
   *
   * @throws RwsError `PARSE_ERROR` when the answer carries no entry; otherwise
   *   the controller's classified error.
   */
  async getMechunitPjoints(mechunit = 'ROB_1'): Promise<Record<string, number>> {
    const r = await this.rws1Get(buildPath(MOTION.getMechunitPjoints.rws1 as PathSpec, { mechunit }));
    const item = r.states.find(s => s._type === 'ms-mechunit-pjoints') ?? r.state;
    if (!item) { throw new RwsError(`getMechunitPjoints: no pjoints entry for ${mechunit}`, 'PARSE_ERROR', r.status); }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(item)) {
      if (k.startsWith('_') || (typeof v !== 'string' && typeof v !== 'number')) { continue; }
      out[k] = Number(v);
    }
    return out;
  }

  // ── System info ─────────────────────────────────────────────────────────
  getSystemInfo()       { return this.client.getSystemInfo(); }
  getControllerIdentity(){ return this.client.getControllerIdentity(); }
  getControllerClock()  { return this.client.getControllerClock(); }
  /** @experimental Built from the controller form; never run against an RWS 1.0 controller. */
  setControllerClock(Y: number, Mo: number, D: number, H: number, Mi: number, S: number) {
    return this.client.setControllerClock(Y, Mo, D, H, Mi, S);
  }
  restartController(m: RestartMode) { return this.client.restartController(m); }

  // ── Event log ───────────────────────────────────────────────────────────
  /** Newest first, every page up to `maxPages` (default 20, about 1000 messages); see RwsClient.getEventLog. */
  getEventLog(d?: number, l?: string, maxPages?: number): Promise<ElogMessage[]> { return this.client.getEventLog(d, l, maxPages); }
  clearEventLog(d?: number)           { return this.client.clearEventLog(d); }
  clearAllEventLogs()                 { return this.client.clearAllEventLogs(); }

  // ── I/O ────────────────────────────────────────────────────────────────
  listAllSignals(s?: number, l?: number)             { return this.client.listAllSignals(s, l); }
  readSignal(n: string, d: string, name: string)     { return this.client.readSignal(n, d, name); }
  writeSignal(n: string, d: string, name: string, v: string) { return this.client.writeSignal(n, d, name, v); }
  searchSignals(criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }) { return this.client.searchSignals(criteria); }
  listNetworks()                                     { return this.client.listNetworks(); }
  listDevices(network: string)                       { return this.client.listDevices(network); }

  // ── File system ─────────────────────────────────────────────────────────
  listDirectory(path: string)                  { return this.client.listDirectory(path); }
  readFile(path: string)                       { return this.client.readFile(path); }
  uploadFile(path: string, content: string)    { return this.client.uploadModule(path, content); }
  deleteFile(path: string)                     { return this.client.deleteFile(path); }
  createDirectory(parent: string, dir: string) { return this.client.createDirectory(parent, dir); }
  copyFile(src: string, dst: string)           { return this.client.copyFile(src, dst); }
  renameFile(path: string, newName: string)    { return this.client.renameFile(path, newName); }

  // ── Mastership ──────────────────────────────────────────────────────────
  // Counted per domain by the session's access manager: a request for a domain
  // this session already holds sends nothing, and only the release that ends
  // the last hold on it goes on the wire.
  requestMastership(d: MastershipDomain): Promise<void> { return this.access.requestPublic(d); }
  releaseMastership(d: MastershipDomain): Promise<void> { return this.access.releasePublic(d); }

  /** Request mastership on all domains (cfg + motion + rapid) at once; counts a hold on each. */
  requestMastershipAll(): Promise<void> {
    return this.access.requestPublicAll(this.allDomainsWire);
  }
  /** Release mastership on all domains at once: ends the caller's most recent
   *  all-domains hold; a domain an operation in progress still holds stays held
   *  until it ends. */
  releaseMastershipAll(): Promise<void> {
    return this.access.releasePublicAll(this.allDomainsWire);
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

  // ── Common reads (both generations) ─────────────────────────────────────
  // Reads RWS 2.0 also serves, under the same resource classes. The parsing
  // is shared with RwsClient2 (src/commonReads.ts). None of these RWS 1.0
  // bodies has been captured on RW 6.16.03 yet (the probes that read their
  // links and show forms ran 2026-09-29); each doc comment says what is known.

  /**
   * GET a resource and return its body as a parser; `json` appends `?json=1`.
   * A status of 400 or more is the controller's typed refusal; 204 is empty.
   */
  private async rws1Doc(path: string, json = true): Promise<ReturnType<typeof parseBody>> {
    return parseBody(await this.rws1Text(json ? path + (path.includes('?') ? '&' : '?') + 'json=1' : path));
  }

  /** One GET's answer body as sent (204: ''); a status of 400 or more is the controller's typed refusal. */
  private async rws1Text(url: string): Promise<string> {
    const res = await this.client.request('GET', url);
    if (res.status >= 400) { throw rws1Error('GET', url, res.status, res.body, this.refusalContext()); }
    return res.status === 204 ? '' : (res.body ?? '');
  }

  /**
   * The build errors of a task's program: `GET
   * /rw/rapid/tasks/{task}/program/builderror` (ABB's RWS 1.0 manual, Rev M,
   * "Get Build Errors"), every page (at most 30 errors a page; the `next` link
   * is followed). One entry per `rap-builderrs`: module, row, column and the
   * error text. Read as XHTML, the form ABB documents: RW 6.16.03 answers
   * the task's program resource with an unrendered template under `?json=1`.
   * RW 6.16.03's program resource links this one (2026-09-29). `[]` when the
   * program builds. A read; it changes nothing. RW 6.16.03 listed the error
   * of a module that did not build, row, column and text (2026-10-21).
   */
  async getBuildErrors(task: string): Promise<RapidBuildError[]> {
    const first = buildPath(RAPID.getBuildErrors.rws1 as PathSpec, { task });
    const pages = await readPages(first, path => this.rws1Text(path), BUILD_ERROR_PAGES);
    return buildErrorsFrom(pages, `RWS1 getBuildErrors(${task})`);
  }

  /**
   * One RAPID task's state and properties: `GET /rw/rapid/tasks/{task}`, ABB's
   * RWS 1.0 "Get Task" (Rev M). RW 6.16.03 serves the task resource (its
   * `?action=show` form answered 200, 2026-09-29); the plain `?json=1` body
   * has not been captured, so the `rap-task` entry (else the task's
   * `rap-task-li`, the class the task list uses) is returned as the
   * controller gave it, and an answer with neither is PARSE_ERROR. Parity with
   * RwsClient2.getRapidTask.
   */
  async getRapidTask(task: string): Promise<Record<string, string>> {
    if (typeof task !== 'string' || task.trim() === '') {
      throw new RwsError('RWS1 getRapidTask: the task name must not be empty', 'INVALID_ARGUMENT');
    }
    const p = await this.rws1Doc(buildPath(RAPID.getRapidTask.rws1 as PathSpec, { task }));
    return rapidTaskFrom(p.getAllEntries(), task, 'RWS1 getRapidTask');
  }

  /**
   * One configuration type's attribute and instance counts: `GET
   * /rw/cfg/{domain}/{type}`, ABB's RWS 1.0 "Get CFG Type" (Rev M). Read as
   * XHTML. The plain GET has not been captured: what RW 6.16.03 answered on
   * 2026-09-29 is the type's `?action=show` page, which carries
   * `cfg-dt-attributes-li` with `cfg-no-of-attributes` and
   * `cfg-dt-instances-li` with `cfg-no-of-instances` (the two items of ABB's
   * CFG_Service example); the plain GET is read for the same two items.
   * PARSE_ERROR when neither is present. Parity with RwsClient2.getCfgType.
   */
  async getCfgType(domain: string, type: string): Promise<CfgTypeInfo> {
    if (!domain || !type) {
      throw new RwsError('RWS1 getCfgType: domain and type must not be empty', 'INVALID_ARGUMENT');
    }
    const p = await this.rws1Doc(buildPath(CFG_ELOG_DIPC.getCfgType.rws1 as PathSpec, { domain, type }), false);
    return cfgTypeFrom(p.getAllEntries(), domain, type, 'RWS1 getCfgType');
  }

  /**
   * The attribute definitions of a configuration type: `GET
   * /rw/cfg/{domain}/{type}/attributes`. RW 6.16.03 links it from the type
   * (`cfg-dt-attributes-li`, 2026-09-29) and its `?json=1` body carries
   * `cfg-dt-attribute` entries, the RWS 2.0 class (SYS/MASTER_BOOL and
   * MOC/ARM read live, 2026-10-03); `cfg-dt-attribute` and
   * `cfg-dt-attribute-li` entries are read, `next` links are followed (at
   * most 50 pages), and a first page with typed entries but no attribute
   * entry is PARSE_ERROR. Parity with RwsClient2.listCfgTypeAttributes.
   */
  async listCfgTypeAttributes(domain: string, type: string): Promise<Array<Record<string, string>>> {
    if (!domain || !type) {
      throw new RwsError('RWS1 listCfgTypeAttributes: domain and type must not be empty', 'INVALID_ARGUMENT');
    }
    const out: Array<Record<string, string>> = [];
    let path = buildPath(CFG_ELOG_DIPC.listCfgTypeAttributes.rws1 as PathSpec, { domain, type });
    for (let page = 0; path && page < 50; page++) {
      const url = `${path}${path.includes('?') ? '&' : '?'}json=1`;
      const res = await this.client.request('GET', url);
      if (res.status >= 400) { throw rws1Error('GET', url, res.status, res.body, this.refusalContext()); }
      const body = res.status === 204 ? '' : (res.body ?? '');
      const p = parseBody(body);
      const entries = p.getAllEntries();
      const attrs = cfgAttributesFrom(entries);
      if (page === 0 && attrs.length === 0 && entries.length > 0) {
        throw new RwsError(
          `RWS1 listCfgTypeAttributes: the answer carried no cfg-dt-attribute entry (classes seen: ${[...new Set(entries.map(e => e['_type']))].join(', ')})`,
          'PARSE_ERROR',
        );
      }
      out.push(...attrs);
      path = rws1NextPath(body, '/rw/cfg/');
    }
    return out;
  }

  /**
   * A DIPC queue's information: `GET /rw/dipc/{queue}` with no action, ABB's
   * RWS 1.0 "Get DIPC Queue" (Rev M); `?action=dipc-read` stays the read
   * (readDipcMessage). RW 6.16.03 links each queue from /rw/dipc and serves
   * its show form (2026-09-29); the plain body has not been captured, so a
   * `dipc-queue*` entry, else any entry with a queue-name / queue-size /
   * max-msg-size / slot-id field (`queue-` or `dipc-` spelling), is read.
   * Null when the controller says the queue does not exist (as RwsClient2
   * answers); every other refusal is the controller's typed error.
   *
   * Non-consuming on RW 6.16.03 (2026-10-01): a ZZ_PROBE queue created with
   * size 10 and message size 400 read back as `size` 10, `maxMsgSize` 400 and
   * a slot id, and the one message sent before this read was still there to
   * read afterwards. (On RWS 2.0 the plain GET of a queue is the read that
   * takes a message off it, ABB DIPC_Service Rev L, which is why RwsClient2
   * reads `/information` instead.)
   */
  async getDipcQueueInfo(queue: string): Promise<DipcQueueInfo | null> {
    if (typeof queue !== 'string' || queue.trim() === '') {
      throw new RwsError('RWS1 getDipcQueueInfo: the queue name must not be empty', 'INVALID_ARGUMENT');
    }
    let p;
    try {
      p = await this.rws1Doc(buildPath(CFG_ELOG_DIPC.getDipcQueueInfo.rws1 as PathSpec, { queue }));
    } catch (e) {
      if (e instanceof RwsError && (e.code === 'RESOURCE_NOT_FOUND'
        || /does not exist|not found/i.test(`${e.controllerMsg ?? ''} ${e.message}`))) {
        return null;
      }
      throw e;
    }
    return dipcQueueInfoFrom(p.getAllEntries(), queue, 'RWS1 getDipcQueueInfo');
  }

  /**
   * One I/O network: `GET /rw/iosystem/networks/{network}`, ABB's RWS 1.0
   * "Get IO Network" (Rev M). RW 6.16.03 links the network list from
   * /rw/iosystem (2026-09-29); no per-network body has been captured, so the
   * `ios-network` (else `ios-network-li`, the RWS 2.0 class) entry is
   * returned, PARSE_ERROR when neither is present. Parity with
   * RwsClient2.getIoNetwork.
   */
  async getIoNetwork(network: string): Promise<Record<string, string>> {
    if (typeof network !== 'string' || network.trim() === '') {
      throw new RwsError('RWS1 getIoNetwork: the network name must not be empty', 'INVALID_ARGUMENT');
    }
    const p = await this.rws1Doc(buildPath(IO.getIoNetwork.rws1 as PathSpec, { network }));
    return pickEntry(p.getAllEntries(), ['ios-network', 'ios-network-li'], 'RWS1 getIoNetwork');
  }

  /**
   * One I/O device: `GET /rw/iosystem/devices/{device}`, ABB's RWS 1.0 "Get IO
   * Device" (Rev M). RWS 1.0 names the device without its network, as the
   * RW 6.16.03 signal bodies link it (`devices/DRV_1`, `devices/PANEL`,
   * 2026-09-29), so `network` is not sent (it is kept for parity with
   * RwsClient2.getIoDeviceInfo, which needs it). The device body has not been
   * captured: the `ios-device` (else `ios-device-li`) entry is returned,
   * PARSE_ERROR when neither is present.
   */
  async getIoDeviceInfo(_network: string, device: string): Promise<Record<string, string>> {
    if (typeof device !== 'string' || device.trim() === '') {
      throw new RwsError('RWS1 getIoDeviceInfo: the device name must not be empty', 'INVALID_ARGUMENT');
    }
    const p = await this.rws1Doc(buildPath(IO.getIoDeviceInfo.rws1 as PathSpec, { device }));
    return pickEntry(p.getAllEntries(), ['ios-device', 'ios-device-li'], 'RWS1 getIoDeviceInfo');
  }

  // ── I/O configuration reads ─────────────────────────────────────────────
  // ABB's RWS 1.0 manual lists "Get IO Signal / Network / Device
  // Configuration Properties" without a path. RW 6.16.03 serves them as a
  // `?resource=config` query on the resource itself, and answers the RWS 2.0
  // `/config` sub-path 404 (live-verified 2026-10-03 via
  // scripts/probe-config-task-motion.mjs). Each answer carries a general and a
  // runtime class; the `?json=1` form packs both into one object with
  // duplicate `_type` keys, so the XHTML form is read, where the two stay
  // apart. The general entry is returned, as RwsClient2 returns it.

  /**
   * A signal's configuration (its EIO_SIGNAL instance): `GET
   * /rw/iosystem/signals/{network}/{device}/{name}?resource=config`. RW
   * 6.16.03 answered `ios-signal-config-general` with cfgname, name,
   * signaltype, device, label, devicemap, category, access, default and the
   * scaling and transfer fields (2026-10-03). Parity with
   * RwsClient2.getSignalConfig.
   *
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, when a name
   *   is empty; `PARSE_ERROR` when the answer has no general entry; otherwise
   *   the controller's classified error (RW 6.16.03 refuses an unknown
   *   signal 400 -1073445879, `INVALID_ARGUMENT`, 2026-10-03).
   */
  async getSignalConfig(network: string, device: string, name: string): Promise<Record<string, string>> {
    for (const [what, v] of [['network', network], ['device', device], ['signal', name]] as const) {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new RwsError(`RWS1 getSignalConfig: the ${what} name must not be empty`, 'INVALID_ARGUMENT');
      }
    }
    const base = buildPath(IO.getSignalConfig.rws1 as PathSpec, { network, device, name });
    const p = await this.rws1Doc(`${base}?resource=config`, false);
    return pickEntry(p.getAllEntries(), ['ios-signal-config-general'], 'RWS1 getSignalConfig');
  }

  /**
   * An I/O network's configuration (its INDUSTRIAL_NETWORK instance): `GET
   * /rw/iosystem/networks/{network}?resource=config`. RW 6.16.03 answered
   * `ios-network-config-general` for Local with cfgname, name, label,
   * address, baudrate, stationname, simulated (2026-10-03). Parity with
   * RwsClient2.getIoNetworkConfig.
   *
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
   *   empty name; `PARSE_ERROR` when the answer has no general entry;
   *   otherwise the controller's classified error (an unknown network: 400
   *   -1073445879, `INVALID_ARGUMENT`, on RW 6.16.03).
   */
  async getIoNetworkConfig(network: string): Promise<Record<string, string>> {
    if (typeof network !== 'string' || network.trim() === '') {
      throw new RwsError('RWS1 getIoNetworkConfig: the network name must not be empty', 'INVALID_ARGUMENT');
    }
    const base = buildPath(IO.getIoNetworkConfig.rws1 as PathSpec, { network });
    const p = await this.rws1Doc(`${base}?resource=config`, false);
    return pickEntry(p.getAllEntries(), ['ios-network-config-general'], 'RWS1 getIoNetworkConfig');
  }

  /**
   * An I/O device's configuration: `GET
   * /rw/iosystem/devices/{device}?resource=config`, the device named without
   * its network as getIoDeviceInfo names it (`network` is not sent; it is
   * kept for parity with RwsClient2.getIoDeviceConfig). RW 6.16.03 answered
   * `ios-device-config-general` for DRV_1 with cfgname, name, network,
   * statewhenstartup, trustlevel, simulated, vendorname, productname,
   * recoverytime, label and the I/O sizes (2026-10-03).
   *
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
   *   empty device name; `PARSE_ERROR` when the answer has no general entry;
   *   otherwise the controller's classified error (an unknown device: 400
   *   -1073445879, `INVALID_ARGUMENT`, on RW 6.16.03).
   */
  async getIoDeviceConfig(_network: string, device: string): Promise<Record<string, string>> {
    if (typeof device !== 'string' || device.trim() === '') {
      throw new RwsError('RWS1 getIoDeviceConfig: the device name must not be empty', 'INVALID_ARGUMENT');
    }
    const base = buildPath(IO.getIoDeviceConfig.rws1 as PathSpec, { device });
    const p = await this.rws1Doc(`${base}?resource=config`, false);
    return pickEntry(p.getAllEntries(), ['ios-device-config-general'], 'RWS1 getIoDeviceConfig');
  }

  /**
   * A file's metadata without downloading it: the file's entry in its parent
   * directory's listing, which carries `fs-size`, `fs-cdate`, `fs-mdate` and
   * `fs-readonly` (`fields` holds them under those names). A file the listing
   * does not name is RESOURCE_NOT_FOUND, and a directory is
   * UNSUPPORTED_OPERATION. The listing's first page is read, as
   * `listDirectory` reads it. Parity with RwsClient2.getFileMetadata (HEAD).
   *
   * ABB's RWS 1.0 manual (Rev M, "Get file Meta data") gives HEAD, which
   * RW 6.16.03 answers 204 with only Content-Length (2026-10-09), so the
   * listing is the richer read. This method used to send
   * `GET ?action=metadata` first, an action no Rev M page has and RW 6.16.03
   * always refused (400 -1073414146), before falling back to the listing.
   */
  async getFileMetadata(path: string): Promise<FileMetadata> {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new RwsError('RWS1 getFileMetadata: the file path must not be empty', 'INVALID_ARGUMENT');
    }
    return this.fileMetadataFromListing(path);
  }

  /** getFileMetadata's read: the file's entry in its parent directory's listing. */
  private async fileMetadataFromListing(path: string): Promise<FileMetadata> {
    const trimmed = path.replace(/[/\\]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    if (cut <= 0) {
      throw new RwsError(`RWS1 getFileMetadata: ${path} names no file in a directory`, 'INVALID_ARGUMENT');
    }
    const dir = trimmed.slice(0, cut);
    const name = trimmed.slice(cut + 1);
    const entry = (await this.client.listDirectory(dir)).find(e => e.name.toLowerCase() === name.toLowerCase());
    if (!entry) {
      throw new RwsError(`RWS1 getFileMetadata: ${dir} lists no ${name}`, 'RESOURCE_NOT_FOUND');
    }
    if (entry.type !== 'file') {
      throw new RwsError(`RWS1 getFileMetadata: ${path} is a directory, not a file`, 'UNSUPPORTED_OPERATION');
    }
    const fields: Record<string, string> = {};
    if (entry.size !== undefined) { fields['fs-size'] = String(entry.size); }
    if (entry.created !== undefined) { fields['fs-cdate'] = entry.created; }
    if (entry.modified !== undefined) { fields['fs-mdate'] = entry.modified; }
    if (entry.readonly !== undefined) { fields['fs-readonly'] = String(entry.readonly); }
    return {
      path,
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.created !== undefined ? { created: entry.created } : {}),
      ...(entry.modified !== undefined ? { modified: entry.modified } : {}),
      ...(entry.readonly !== undefined ? { readonly: entry.readonly } : {}),
      fields,
    };
  }

  // ── Forward kinematics ──────────────────────────────────────────────────
  /**
   * Forward kinematics on RWS 1.0: the pose of tool0 (the flange) for the
   * given joint angles, from ABB's `?action=CalcPoseFromJoints`.
   *
   * The action works in SI units: it takes `rob_joints` in radians and the
   * tool frame in metres, and answers `position-x/y/z` in metres with the
   * orientation in `robtarget-orientation-u0..u3`. This method converts, so it
   * takes degrees and returns millimetres, the units of the jointtarget and
   * cartesian reads. External axes are sent as absent (9E9).
   *
   * The action has no work-object field and takes the tool as a frame, not by
   * name, so only `tool` 'tool0' (the identity frame) and `wobj` 'wobj0' are
   * supported; any other tool or work object is refused with
   * `INVALID_ARGUMENT` before sending, since the answer would not be in it.
   *
   * Live-verified 2026-09-30 on RW 6.16.03 (virtual controller): joints
   * 0, 0, 0, 0, 30, 0 degrees give 806.2917, 0, 929 mm and q 0.5, 0,
   * 0.8660254, 0, the pose the cartesian read reports for those joints with
   * tool0 and wobj0; the same joints sent in degrees give a different, wrong
   * pose. This method used to POST `?action=CalcRobTFromJoints` with the
   * fields `curr_joints`, `tool` and `wobj`. The controller does not know that
   * action: it answers 400 -1073445879 "Invalid action parameter value", the
   * same as for a made-up action name. So every call failed, and not because
   * of a virtual-controller limit.
   */
  async calcCartesianFromJoints(
    joints: JointTarget,
    mechunit = 'ROB_1',
    tool = 'tool0',
    wobj = 'wobj0',
  ): Promise<RobTarget> {
    if (!this.creds) { throw new RwsError('FK requires credentials in the adapter constructor', 'INVALID_ARGUMENT'); }
    if ((tool || 'tool0').toLowerCase() !== 'tool0' || (wobj || 'wobj0').toLowerCase() !== 'wobj0') {
      throw new RwsError(
        `Forward kinematics on RWS 1.0 computes the tool0 (flange) pose only: the controller's action takes no work object `
          + `and no tool name, so tool '${tool}' and work object '${wobj}' cannot be applied. Pass tool0 and wobj0.`,
        'INVALID_ARGUMENT',
      );
    }
    const body = [
      'tool_frame_position=[0,0,0]',
      'tool_frame_orientation=[1,0,0,0]',
      `rob_joints=[${jointsInRadians(joints)}]`,
      'ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]',
      'robot_fixed_object=FALSE',
      'elog_at_error=FALSE',
    ].join('&');
    const path = buildPath(MOTION.calcCartesianFromJoints.rws1 as PathSpec, { mechunit });
    const state = firstJsonState(await this.rws1Post(path, body));
    if (!state) { throw new RwsError('FK: no result in response', 'PARSE_ERROR'); }
    // ABB's RWS 2.0 page spells the orientation `robtargetorientation-uN`;
    // both spellings are read.
    const q = (i: number): number => numField(state, `robtarget-orientation-u${i}`, `robtargetorientation-u${i}`);
    // Metres to millimetres, rounded to 1e-6 mm so the product carries no
    // binary noise (0.6889405 m would read 688.9404999999999 mm).
    const pose: RobTarget = {
      x: roundMicro(numField(state, 'position-x') * 1000),
      y: roundMicro(numField(state, 'position-y') * 1000),
      z: roundMicro(numField(state, 'position-z') * 1000),
      q1: q(0), q2: q(1), q3: q(2), q4: q(3),
    };
    if (Object.values(pose).some(v => !Number.isFinite(v))) {
      throw new RwsError('FK: the answer has no position-x/y/z and orientation values', 'PARSE_ERROR');
    }
    return pose;
  }

  /**
   * The returned function carries `unbound`, the resources the controller
   * left out of the group (read live; see WsSubscriber.subscribe). RwsClient
   * hands back WsSubscriber's own function, so the property is there,
   * though RwsClient's declared type does not name it.
   */
  subscribe(
    resources: AnySubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    onLost?: () => void,
    onRestored?: () => void,
  ): Promise<(() => Promise<void>) & { readonly unbound?: readonly string[] }> {
    return this.client.subscribe(resources, handler, { onLost, onRestored });
  }

  /**
   * Add resources to a live subscription group, or change their priorities:
   * PUT `/subscription/{group}` with the body the create uses
   * (`resources=i&i=<uri>&i-p=<prio>`, resource paths not percent-encoded).
   * ABB's RWS 1.0 manual (3HAC050973-001 Rev M, Subscription Service) lists it
   * as "Update Subscription Group"; RW 6.16.03 serves
   * `GET /subscription/{group}` (2026-09-29). On RWS 2.0 the same PUT is
   * additive (live-verified 2026-08-09 on RW 8.1.1).
   *
   * Additive on RW 6.16.03 too (2026-10-01): a group created with operation
   * mode, updated with controller state, listed both afterwards
   * (`getSubscriptionGroup`), and the PUT answered the added resource's
   * current-value event. That body is returned as-is; its shape is not
   * relied on.
   *
   * The RWS 1.0 subscriber re-registers its group with the resources it was
   * created with when the controller forgets it (a restart), so resources added
   * here are not carried into a re-created group.
   *
   * A 400 is read the way RWS 2.0's is. RW 6.16.03 answers a group create
   * with refused resources in the same shape (2026-09-29): one status div per
   * refused resource, with its self link and -1073445866, then a state div
   * listing the bound ones. A create naming only a refused resource answers
   * 400, but a create mixing refused and valid resources answers 201, naming
   * the refused ones only in those status divs. A 1.0 PUT that mixes valid and
   * unknown resources has not been observed; it may well answer 2xx the same
   * way. So a 2xx answer whose status divs name refused resources is thrown
   * too, as the same `SubscriptionUpdateError` (its `httpStatus` the 2xx), so
   * that a caller handles a partial bind the same way on both generations
   * instead of taking a refused resource for bound. `bound` holds only what
   * the answer lists.
   *
   * @param groupPath the group resource, `/subscription/{id}`.
   * @returns the controller's answer body.
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for a
   *   `groupPath` that is not `/subscription/{id}`, an empty resource list or a
   *   signal name that is not letters, digits and underscores.
   * @throws SubscriptionUpdateError (an `RwsError`) for any 400 answer (same
   *   code and message as the classified error), and for a 2xx answer whose
   *   status divs name refused resources (classified from the status code):
   *   `bound` and `refused` as the body lists them (empty when it cannot be
   *   read), `body` the raw answer. Any other failure throws the classified
   *   `RwsError`.
   */
  async updateSubscriptionGroup(groupPath: string, resources: AnySubscriptionResource[]): Promise<string> {
    const group = /^\/subscription\/(\d+)$/.exec(groupPath)?.[1];
    if (!group) {
      throw new RwsError(
        `updateSubscriptionGroup: ${JSON.stringify(groupPath)} is not a subscription group path (/subscription/{id})`,
        'INVALID_ARGUMENT',
      );
    }
    if (resources.length === 0) {
      throw new RwsError('updateSubscriptionGroup needs at least one resource', 'INVALID_ARGUMENT');
    }
    const body = buildSubscriptionBody(resources);
    const path = buildPath(FILES_VISION.updateSubscriptionGroup.rws1 as PathSpec, { group });
    let res: { status: number; body: string };
    try {
      res = await this.client.request('PUT', path, body);
    } catch (e) {
      // The session throws on an HTTP error, with the answer body as rwsDetail.
      throw asSubscriptionUpdateError(e, e instanceof RwsError ? (e.responseBody ?? e.rwsDetail) : undefined);
    }
    const answer = res.body ?? '';
    if (res.status >= 400) {
      throw asSubscriptionUpdateError(rws1Error('PUT', path, res.status, answer, this.refusalContext(), body), answer);
    }
    // A 2xx that names refused resources bound only part of the PUT.
    const read = readSubscriptionUpdateAnswer(answer);
    if (read.refused.length > 0) {
      throw new SubscriptionUpdateError(
        rws1Error('PUT', path, res.status, answer, this.refusalContext(), body),
        { ...read, body: answer },
      );
    }
    return answer;
  }

  /**
   * Drop ONE resource from a live subscription group, leaving the group and
   * its WebSocket up: `DELETE /subscription/{group}/{resource}`, ABB's RWS 1.0
   * "Unsubscribe or remove the resource from subscription group" (Rev M; its
   * URL line spells `/subscripion`, its sample call `/subscription`), answered
   * 200. The resource is the path the subscribe sent, `;suffix` included (Rev
   * M's sample: `/subscription/1/rw/iosystem/signals/Virtual1/Board1/di1;state`).
   * The RWS 1.0 subscribe handle carries no group path; find the group with
   * `listSubscriptionGroups()`. A group the controller re-created after a
   * restart has a new id and only the resources it was created with.
   * Mastership of every domain is one resource per domain, so one DELETE each
   * (`dropFromGroup`). RW 6.16.03 answered 200 and the dropped resource sent
   * no more events (2026-10-21).
   *
   * @param groupPath the group resource, `/subscription/{id}`.
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for a
   *   `groupPath` that is not `/subscription/{id}`, a signal name that is not
   *   letters, digits and underscores, or a resource path that would not stay
   *   under the group; otherwise the controller's classified error.
   */
  async unsubscribeResource(groupPath: string, resource: AnySubscriptionResource): Promise<void> {
    if (!/^\/subscription\/\d+$/.test(groupPath)) {
      throw new RwsError(
        `unsubscribeResource: ${JSON.stringify(groupPath)} is not a subscription group path (/subscription/{id})`,
        'INVALID_ARGUMENT',
      );
    }
    await dropFromGroup(groupPath, resourcePaths(resource), 'unsubscribeResource', async path => {
      const res = await this.client.request('DELETE', path);
      if (res.status >= 400) { throw rws1Error('DELETE', path, res.status, res.body, this.refusalContext()); }
    });
  }

  // ── Niche reads (both generations, 2026-10-01) ──────────────────────────
  // Parsing shared with RwsClient2 (src/commonReads.ts).

  /**
   * The subscription groups of this session: `GET /subscription?json=1`.
   * ABB's RWS 1.0 manual lists the subscription resource's GET ("Get
   * Subscription Actions"). RW 6.16.03 answered it on 2026-09-29 in XHTML
   * despite `?json=1`: one `subsgrp-li` per group, title = id, with a
   * `rel="events"` link written without a host (`ws:///poll/{id}`), returned
   * as given. The subscriber shares this adapter's session, so its groups are
   * listed. Parity with RwsClient2.listSubscriptionGroups.
   *
   * @returns one entry per group, `[]` when the session has none.
   * @throws RwsError `PARSE_ERROR` when the answer carries typed entries but
   *   no `subsgrp-li`; otherwise the controller's classified error.
   */
  async listSubscriptionGroups(): Promise<SubscriptionGroupInfo[]> {
    const path = buildPath(FILES_VISION.listSubscriptionGroups.rws1 as PathSpec);
    const url = `${path}?json=1`;
    const res = await this.client.request('GET', url);
    if (res.status >= 400) { throw rws1Error('GET', url, res.status, res.body, this.refusalContext()); }
    return subscriptionGroupsFrom(res.status === 204 ? '' : (res.body ?? ''), 'RWS1 listSubscriptionGroups');
  }

  /**
   * The resources bound to one subscription group: `GET /subscription/{group}`.
   * RW 6.16.03 answered it on 2026-09-29 (XHTML, with or without `?json=1`):
   * one `sub-resource` per member, title = index, self link = the resource as
   * the group stores it (`/rw/panel/speedratio;speedratio`), matching what the
   * 201 bound. A group of another client, or a deleted one, answers 400
   * -1073435900 "Group N does not belong to Client M.". Parity with
   * RwsClient2.getSubscriptionGroup.
   *
   * @param group the group id (`'7'`) or its resource (`'/subscription/7'`).
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for a group
   *   that is neither; `PARSE_ERROR` when the answer carries typed entries but
   *   no member; otherwise the controller's classified error.
   */
  async getSubscriptionGroup(group: string): Promise<SubscriptionGroupMember[]> {
    const id = subscriptionGroupId(group, 'RWS1 getSubscriptionGroup');
    const p = await this.rws1Doc(buildPath(FILES_VISION.getSubscriptionGroup.rws1 as PathSpec, { group: id }), false);
    return subscriptionMembersFrom(p.getAllEntries(), 'RWS1 getSubscriptionGroup');
  }

  /**
   * Motion (jog) supervision of a mechanical unit:
   * `GET /rw/motionsystem/motionsupervision?mechunit={mechunit}&json=1`. RWS 1.0
   * keeps it at the motion-system root (ABB's RWS 1.0 manual, "Operations on
   * Motion Supervision"), with the unit as a query: RW 6.16.03 answered
   * `ms-motionsupervision` (`mode-enabled` TRUE, `level` 100) with it, 400
   * -1073445879 "No/Invalid Mechanical unit" without it, and 404 on the
   * mechunit-scoped RWS 2.0 path (2026-09-27 and 2026-09-29). Parity with
   * RwsClient2.getMotionSupervision.
   *
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an empty
   *   mechunit name; `PARSE_ERROR` when the answer carries no
   *   ms-motionsupervision entry, or one without `mode-enabled` or a numeric
   *   `level`; otherwise the controller's classified error.
   */
  async getMotionSupervision(mechunit = 'ROB_1'): Promise<MotionSupervisionState> {
    const unit = mechunitName(mechunit, 'RWS1 getMotionSupervision');
    const path = `${buildPath(MOTION.getMotionSupervision.rws1 as PathSpec)}?mechunit=${encodeURIComponent(unit)}`;
    const p = await this.rws1Doc(path);
    return motionSupervisionFrom(p.getAllEntries(), 'RWS1 getMotionSupervision');
  }

  /**
   * Path supervision of a mechanical unit:
   * `GET /rw/motionsystem/pathsupervision?mechunit={mechunit}&json=1`. ABB's
   * RWS 1.0 manual lists it at the motion-system root ("Operations On Path
   * Supervision"), and RW 6.16.03 links it there (`ms-pathsupervision-li`,
   * 2026-09-29) next to motion supervision, which needs the `mechunit` query;
   * the same query is sent here, and RW 6.16.03 answered it with the RWS 2.0
   * class `ms-pathsupervision`, `mode` ON and `level` 100 (2026-10-01).
   * Parity with RwsClient2.getPathSupervision.
   *
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an empty
   *   mechunit name; `PARSE_ERROR` when the answer carries no
   *   ms-pathsupervision entry, or one without `mode` or a numeric `level`;
   *   otherwise the controller's classified error.
   */
  async getPathSupervision(mechunit = 'ROB_1'): Promise<PathSupervisionState> {
    const unit = mechunitName(mechunit, 'RWS1 getPathSupervision');
    const path = `${buildPath(MOTION.getPathSupervision.rws1 as PathSpec)}?mechunit=${encodeURIComponent(unit)}`;
    const p = await this.rws1Doc(path);
    return pathSupervisionFrom(p.getAllEntries(), 'RWS1 getPathSupervision');
  }

  /**
   * The serial measurement board (SMB) data of a mechanical unit:
   * `GET /rw/motionsystem/mechunits/{mechunit}/smbdata?json=1` (ABB's RWS 1.0
   * manual, "Operations on SMB Data"). RW 6.16.03 links it from the mechunit
   * (`ms-mechunit-smbdata-li`, 2026-09-29); the body has not been captured, so
   * the RWS 2.0 class `ms-mechunit-smbdata` (ABB Motion_System Rev L) is read
   * and its fields returned as given. Parity with
   * RwsClient2.getMechunitSmbData.
   *
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an empty
   *   mechunit name; `PARSE_ERROR` when the answer carries no
   *   ms-mechunit-smbdata entry; otherwise the controller's classified error.
   */
  async getMechunitSmbData(mechunit = 'ROB_1'): Promise<Record<string, string>> {
    const unit = mechunitName(mechunit, 'RWS1 getMechunitSmbData');
    const p = await this.rws1Doc(buildPath(MOTION.getMechunitSmbData.rws1 as PathSpec, { mechunit: unit }));
    return smbDataFrom(p.getAllEntries(), 'RWS1 getMechunitSmbData');
  }

  /**
   * The motor calibration names of a mechanical unit:
   * `GET /rw/motionsystem/mechunits/{mechunit}/motorcalib?json=1` (ABB's RWS
   * 1.0 manual, "Operations on Motor Calib"). RW 6.16.03 links it from the
   * mechunit (`ms-mechunit-motorcalib-li`, 2026-09-29); the body has not been
   * captured, so the RWS 2.0 class `ms-mechunit-joint` (title `jointN`,
   * `joint-name`, `calib-name`; ABB Motion_System Rev L) is read. Parity with
   * RwsClient2.getMechunitMotorCalib.
   *
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an empty
   *   mechunit name; `PARSE_ERROR` when the answer carries typed entries but
   *   no ms-mechunit-joint; otherwise the controller's classified error.
   */
  async getMechunitMotorCalib(mechunit = 'ROB_1'): Promise<MechunitMotorCalib[]> {
    const unit = mechunitName(mechunit, 'RWS1 getMechunitMotorCalib');
    const p = await this.rws1Doc(buildPath(MOTION.getMechunitMotorCalib.rws1 as PathSpec, { mechunit: unit }));
    return motorCalibFrom(p.getAllEntries(), 'RWS1 getMechunitMotorCalib');
  }

  /**
   * The compliance lead-through state of a mechanical unit:
   * `GET /rw/motionsystem/mechunits/{mechunit}?resource=lead-through&json=1`,
   * the link RW 6.16.03 serves from the mechunit (2026-09-29; ABB's RWS 1.0
   * manual, "Get Compliance Lead Through"). The body has not been captured:
   * the RWS 2.0 class `ms-mechunit-complianceleadthrough` with `status` (ABB
   * Motion_System Rev L) is read. The mechunit body itself carries an entry
   * of that class as its LINK, with no `status`, so a controller that ignored
   * the query is PARSE_ERROR rather than a reading. Parity with
   * RwsClient2.getLeadThrough.
   *
   * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an empty
   *   mechunit name; `PARSE_ERROR` when no such entry carries a `status`;
   *   otherwise the controller's classified error.
   */
  async getLeadThrough(mechunit = 'ROB_1'): Promise<LeadThroughState> {
    const unit = mechunitName(mechunit, 'RWS1 getLeadThrough');
    const path = `${buildPath(MOTION.getLeadThrough.rws1 as PathSpec, { mechunit: unit })}?resource=lead-through`;
    const p = await this.rws1Doc(path);
    return leadThroughFrom(p.getAllEntries(), 'RWS1 getLeadThrough');
  }

  // ── Jogging ─────────────────────────────────────────────────────────────

  /**
   * One jog request as ABB's RWS 1.0 jog form lists it: `axis1`..`axis6`, the
   * controller's current change count as `ccount` (read with
   * `GET /rw/motionsystem` right before), and `inc-mode` (default `Small`).
   * `mode`, `speed` and `mechunit` are not sent (no jog form field). A named
   * `mechunit` that the controller does not have selected for jogging is
   * selected first (`setMechunitForJogging`), and the motion system is read
   * again: the jog goes out with that read's change count, and only if it
   * names the unit (INVALID_ARGUMENT otherwise, nothing jogged). Takes no
   * mastership for the jog itself: ABB's page asks for a local client plus
   * mastership, and `RobotManager.jog` holds motion mastership around it,
   * which also covers the selection.
   *
   * @experimental Built from the controller form; never run against an RWS 1.0 controller.
   */
  async jog(params: JogParams): Promise<void> {
    if (!this.creds) {
      throw new RwsError('Jog requires credentials - reconnect to enable', 'INVALID_ARGUMENT');
    }
    const { axes, incMode } = checkJog(params);
    const motionSystem = buildPath(MOTION.getMotionChangeCount.rws1 as PathSpec);
    const readMotionSystem = async (): Promise<Record<string, string>> =>
      ((await this.rws1Get(motionSystem)).state as Record<string, string> | null) ?? {};
    let ms = await readMotionSystem();
    let ccount = jogChangeCount(ms['change-count'], 'GET /rw/motionsystem');
    const select = jogUnitToSelect(params.mechunit, ms['mechunit-name']);
    if (select !== undefined) {
      await this.setMechunitForJogging(select);
      ms = await readMotionSystem();
      checkJogUnit(select, ms['mechunit-name']);
      ccount = jogChangeCount(ms['change-count'], 'GET /rw/motionsystem after selecting the unit');
    }
    const bodyStr = jogBody(axes, ccount, incMode);

    // Route through the shared HttpSession (via rws1Post), NOT a fresh
    // per-call connection: reusing the session cookie avoids minting a new
    // controller session on every jog (which fills the ~70-slot pool under an
    // interactive jog UI and yields persistent 503s), and it puts jog on the
    // same session that holds motion mastership. rws1Post appends json=1, signs
    // path+query, and throws a typed error on >=400.
    // Only this request's answer is tagged as the jog's (asJogPostError): a
    // refused read or unit selection above keeps its own explanation.
    const path = buildPath(MOTION.jog.rws1 as PathSpec);
    let result: { _embedded?: { status?: { msg?: string } } } | null;
    try {
      result = await this.rws1Post(path, bodyStr) as { _embedded?: { status?: { msg?: string } } } | null;
    } catch (e) {
      throw asJogPostError(e);
    }
    // Successful jog has no useful body - only check for error status.
    const status = result?._embedded?.status;
    if (status?.msg && status.msg.length > 0 && /error|fail/i.test(status.msg)) {
      throw asJogPostError(new RwsError(status.msg, 'UNKNOWN'));
    }
  }

  // ── RWS 1.0 helper - typed wrapper around client.request() with JSON parsing ──

  /**
   * Generic GET that returns `_embedded._state[0]` (single resource) or [] (list).
   * Most RWS 1.0 endpoints with `?json=1` return this HAL-like envelope.
   * Returns empty result for HTTP 204 (no content) - common on /ctrl/options etc.
   */
  private async rws1Get(path: string, holdMs = 0): Promise<{ status: number; state: Record<string, unknown> | null; states: Array<Record<string, unknown>>; raw: unknown }> {
    const url = path + (path.includes('?') ? '&' : '?') + 'json=1';
    // `holdMs`: how long the controller may hold this GET open on purpose
    // (see RwsClient.request); only the DIPC read passes one.
    const res = holdMs > 0
      ? await this.client.request('GET', url, undefined, { holdMs })
      : await this.client.request('GET', url);
    if (res.status === 204 || !res.body) {
      return { status: res.status, state: null, states: [], raw: null };
    }
    if (res.status >= 400) { throw rws1Error('GET', url, res.status, res.body, this.refusalContext()); }
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
    if (res.status >= 400) { throw rws1Error('POST', url, res.status, res.body, this.refusalContext(), body); }
    try { return JSON.parse(res.body); } catch { return null; }
  }

  // ── System detail ───────────────────────────────────────────────────────

  /** The robot types (ABB Rev M "Get robot type": one entry per robot, so a
   *  MultiMove system lists each): `type` the first robot's, `types` every
   *  robot's, in the controller's order. 1.4.x kept the first only. */
  async getRobotType(): Promise<{ type: string; variant?: string; types: string[] }> {
    const p = await this.rws1Doc(buildPath(SYSTEM_MASTERSHIP.getRobotType.rws1 as PathSpec));
    return robotTypesFrom(p.getAllEntries());
  }

  async getLicenseInfo(): Promise<{ entries: Array<Record<string, string>> }> {
    // RWS 1.0 path is singular `/license`. Doc 6.8 has it as plural `/licenses`
    // but the RobotWare 6.16 virtual controller returns 404 for that - singular works.
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

  /**
   * The name and description of a controller return code, GET
   * /rw/retcode?code=N. The `lang` query this used to append is undocumented
   * and ignored (English only; spec check 2026-10-07/09), and is no longer
   * sent. The answer is the `err-desc` state with `name` and `description`;
   * `title`/`desc`, which this used to read, are never emitted, so RW6
   * answered empty strings. `title` carries the symbolic
   * name for source compatibility, as the RWS 2.0 method does.
   * @param lang kept for source compatibility; ignored.
   */
  async getReturnCode(code: number, lang = 'en'): Promise<{ code: number; title: string; desc: string } | null> {
    void lang;
    try {
      const r = await this.rws1Get(`/rw/retcode?code=${code}`);
      const s = r.state as { name?: string; description?: string; title?: string; desc?: string } | null;
      if (!s) { return null; }
      const title = s.name ?? s.title ?? '';
      const desc = s.description ?? s.desc ?? '';
      if (!title && !desc) { return null; }
      return { code, title, desc };
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

  /**
   * Switch non-motion execution on or off. ABB's RWS 1.0 page says "Mastership
   * needs to be acquired" without naming the domain, so every domain (cfg,
   * motion, rapid) is held around the write until a live run shows which one
   * the controller checks.
   *
   * @experimental Built from the controller form; never run against an RWS 1.0 controller.
   */
  async setNonMotionExecution(enabled: boolean): Promise<void> {
    await this.access.withAccess(['cfg', 'motion', 'rapid'], () =>
      this.rws1Post(buildPath(MOTION.setNonMotionExecution.rws1 as PathSpec), `mode=${enabled ? 'ON' : 'OFF'}`));
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

  /**
   * Set a mechanical unit's base frame: `POST
   * /rw/motionsystem/mechunits/{mechunit}/baseframe?action=set` with x, y, z
   * and q1..q4, ABB's RWS 1.0 "Set Base Frame" (Rev M; 202 on success). It
   * changes the unit's calibration: read the frame first with
   * `getMechunitBaseFrame` to be able to write it back. ABB's page names no
   * mastership; motion mastership is held around the post, as for the tool
   * and work-object set on the same unit, and a motion hold this session
   * already has is reused and not ended. A RobotWare 6.16.03 virtual
   * controller answered 202 to ROB_1's own frame written back, between the
   * motion mastership request and release, and the frame read back unchanged
   * (2026-10-18).
   */
  async setMechunitBaseFrame(mechunit: string, frame: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void> {
    const unit = mechunitName(mechunit, 'RWS1 setMechunitBaseFrame');
    const body = (['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4'] as const)
      .map(k => `${k}=${encodeURIComponent(String(frame[k]))}`).join('&');
    await this.access.withAccess(['motion'], async () => {
      await this.rws1Post(buildPath(MOTION.setMechunitBaseFrame.rws1 as PathSpec, { mechunit: unit }), body);
    });
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

  /**
   * The aliases the running RAPID program defines for I/O signals, GET
   * /rw/rapid/aliasio: one entry per `rap-alias-io`, with the alias
   * (`alias-name`), the signal (`signal-name`) and the signal type (`type`),
   * as ABB's RWS 1.0 manual (Rev M) documents them. The body is read as JSON
   * or XHTML, whichever the controller sends. The RWS 1.0 runs so far
   * answered an empty list. `[]` when the controller refuses the read.
   */
  async listAliasIO(): Promise<Array<{ alias: string; signal: string; type?: string }>> {
    try {
      const url = `${buildPath(RAPID.listAliasIO.rws1 as PathSpec)}?json=1`;
      const res = await this.client.request('GET', url);
      if (res.status >= 400) { throw rws1Error('GET', url, res.status, res.body, this.refusalContext()); }
      const entries = res.status === 204 || !res.body ? [] : parseBody(res.body).getAllEntries();
      return aliasIoFrom(entries, 'RWS1 listAliasIO');
    } catch { return []; }
  }

  async getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> {
    try {
      const r = await this.rws1Get(buildPath(RAPID.getProgramPointer.rws1 as PathSpec, { task }));
      const s = (r.state as Record<string, string>) ?? {};
      // The start is "row,col" under either spelling (see motionPointerFrom).
      const begin = (s.beginposition ?? s.begposition ?? '').split(',');
      return {
        module:  s.modulename ?? s.modulemame ?? s.module,
        routine: s.routinename ?? s.routine,
        row:     begin[0] ? +begin[0] : undefined,
        col:     begin[1] ? +begin[1] : undefined,
      };
    } catch { return {}; }
  }

  /**
   * The task's motion pointer: `GET /rw/rapid/tasks/{task}/pcp`, the request
   * `getProgramPointer` sends, read for the entry ABB titles `motionpointer`
   * (Rev M "Get RAPID task Motion&Program pointer positions"). With no program
   * started RW 6.16.03 answered that entry without a position (2026-09-27),
   * which gives `{}`. As with `getProgramPointer` here, a refused or
   * unreadable answer gives `{}` too. The start is read under
   * `beginposition`, where ABB's Rev M example puts it, else under
   * `begposition`, where RW 6.16.03 puts it (2026-10-18). ABB's example also
   * has a `begposition` span in this entry, where the end goes, so
   * `beginposition` is read first. The method used to read the task's
   * /motion link directory, which holds no pointer.
   *
   * @experimental The evidence index does not credit this read: it sends the same request as `getProgramPointer`, whose answer carries this entry with no position when no program has started, and the logs keep no answer body, so a logged 2xx does not show that a position was read. On a RobotWare 6.16.03 virtual controller it read row 9 col 16 while a MoveAbsJ ran (2026-10-18).
   */
  async getMotionPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }> {
    try {
      const p = await this.rws1Doc(buildPath(RAPID.getMotionPointer.rws1 as PathSpec, { task }));
      return motionPointerFrom(p.getAllEntries(), 'RWS1 getMotionPointer');
    } catch { return {}; }
  }

  /**
   * The task selection: `GET /rw/rapid/taskselection`, ABB's RWS 1.0 "Get user
   * modify from taskpanel" (Rev M). One `rap-taskselection` entry per task with
   * name, state (ON / OFF), motiontask and usermodify, the class RWS 2.0
   * serves too; `selected` holds the tasks that read ON. A refusal is the
   * controller's typed error, and an answer with no such entry is
   * `PARSE_ERROR`. Parity with RwsClient2.getTaskSelection. A RobotWare
   * 6.16.03 virtual controller answered T_ROB1 ON (2026-10-18).
   */
  async getTaskSelection(): Promise<{ selected: string[]; available: string[]; entries: Array<Record<string, string>> }> {
    const p = await this.rws1Doc(buildPath(RAPID.getTaskSelection.rws1 as PathSpec));
    return taskSelectionFrom(p.getAllEntries(), 'RWS1 getTaskSelection');
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
   * Live-verified 2026-07-09 on the RobotWare 6.16 virtual controller with a probe script:
   *   ✓ POST /rw/cfg/{domain}/{type}/instances/{instance}?action=set
   *     body: PLAIN form values `Attr=value&…` (percent-encoded) → 204,
   *     partial attribute sets accepted.
   * Holds cfg-domain mastership around the write. (The VC accepts cfg
   * writes without it, but real controllers arbitrate cfg access through
   * mastership - and taking it when free is harmless.) A cfg hold this
   * session already has is reused and not ended.
   */
  async setCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
    await this.access.withAccess(['cfg'], () => this.postCfgSet(domain, type, instance, attrs));
  }

  /**
   * Create a new configuration instance, then apply `attrs`.
   * Live-verified 2026-07-09 on the RobotWare 6.16 virtual controller:
   *   ✓ POST /rw/cfg/{domain}/{type}/instances?action=create-default
   *     body name={instance} → 201 (duplicate name → 400), then the
   *     ?action=set shape above for the attribute values.
   * Holds cfg-domain mastership once around the create+set pair.
   */
  async createCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
    await this.access.withAccess(['cfg'], async () => {
      await this.rws1Post(
        buildPath(CFG_ELOG_DIPC.createCfgInstance.rws1 as PathSpec, { domain, type }),
        `name=${encodeURIComponent(instance)}`,
      );
      if (Object.keys(attrs).length > 0) {
        await this.postCfgSet(domain, type, instance, attrs);
      }
    });
  }

  /**
   * Delete a configuration instance.
   * Live-verified 2026-07-09 on the RobotWare 6.16 virtual controller:
   *   ✓ DELETE /rw/cfg/{domain}/{type}/instances/{instance} → 204
   *     (reading the instance back afterwards → 400 "unknown instance",
   *     unlike RWS 2.0 which answers 404).
   */
  async removeCfgInstance(domain: string, type: string, instance: string): Promise<void> {
    await this.access.withAccess(['cfg'], async () => {
      const url = `${buildPath(CFG_ELOG_DIPC.removeCfgInstance.rws1 as PathSpec, { domain, type, instance })}?json=1`;
      const res = await this.client.request('DELETE', url);
      if (res.status >= 400) { throw rws1Error('DELETE', url, res.status, res.body, this.refusalContext()); }
    });
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

  /**
   * This session's RMMP privilege: `none`, `pending modify`, `modify` or
   * `exec` (ABB's values, read lower-case). A privilege another user holds
   * reads as `none`. A failed read is thrown, never reported as `none`.
   */
  async getRmmpPrivilege(): Promise<string> {
    const r = await this.rws1Get(buildPath(USERS_UAS.getRmmpPrivilege.rws1 as PathSpec));
    const s = (r.state as Record<string, string> | null) ?? {};
    if (typeof s.privilege !== 'string') {
      throw new RwsError(`getRmmpPrivilege: GET /users/rmmp answered HTTP ${r.status} without a privilege`,
        r.status >= 400 ? 'UNKNOWN' : 'PARSE_ERROR', r.status);
    }
    const priv = normaliseRmmpPrivilege(s.privilege);
    const heldByMe = (s.rmmpheldbyme ?? 'false').trim().toLowerCase() === 'true';
    if (priv === 'none' || isRmmpPending(priv)) { return priv; }
    return heldByMe ? priv : 'none';
  }

  /**
   * Send an RMMP request (`privilege=modify` or `exec`; `'exclusive'` is a
   * deprecated alias of `'exec'`). Returns once the controller accepted it:
   * the request then waits for the operator at the FlexPendant, and ABB
   * deletes it after 10 s unless it is polled. `RobotManager.requestRmmp`
   * polls and waits. ABB documents no mode or grant rule for an RWS 1.0
   * request beyond manual mode; the controller decides. Run against a
   * RobotWare 6.16.03 virtual controller in manual mode: `modify` was granted
   * at the FlexPendant. Only `modify` was asked for there; `exec` is still to
   * be tried on RobotWare 6.
   */
  async requestRmmp(level: RmmpLevel | 'exclusive' = 'modify'): Promise<void> {
    const privilege = rmmpLevel(level);
    await this.rws1Post(buildPath(USERS_UAS.requestRmmp.rws1 as PathSpec), `privilege=${privilege}`);
  }

  /** Poll a pending RMMP request (keeps the grant window alive, reports status).
   *  Live-verified 200 on the RobotWare 6.16 virtual controller (2026-08-11), class user-rmmp-poll. */
  async pollRmmp(): Promise<string> {
    const r = await this.rws1Get(buildPath(USERS_UAS.pollRmmp.rws1 as PathSpec));
    const s = (r.state as { status?: string; privilege?: string } | null) ?? {};
    const status = s.status ?? s.privilege;
    if (typeof status !== 'string') {
      throw new RwsError(`pollRmmp: GET /users/rmmp/poll answered HTTP ${r.status} without a status`,
        r.status >= 400 ? 'UNKNOWN' : 'PARSE_ERROR', r.status);
    }
    return status;
  }

  /** Cancel this session's pending/held RMMP request. RWS 1.0 uses the
   *  query-action form /users/rmmp?action=cancel. Live-verified 204 on RW6.16. */
  async cancelRmmp(): Promise<void> {
    await this.rws1Post(buildPath(USERS_UAS.cancelRmmp.rws1 as PathSpec), '');
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

  /**
   * Restore a backup. Holds RAPID and CFG mastership around the request: the
   * RWS 1.0 restore page names only the grant, while the PC SDK's restore
   * needs Rapid and Configuration mastership, and the stricter reading is
   * taken. Released when the request returns. Run live on RW 6.16.03 (2026-10-09).
   */
  async restoreBackup(name: string, opts?: { deleteBackup?: boolean }): Promise<void> {
    // RWS 1.0's restore form has `delete-dir`, and ABB's manual (Rev M) says it
    // "Defaults to true": without it, a restore deletes the backup it restored
    // (it did on RW 6.16.03, 2026-10-09). The backup is kept unless the caller
    // asks for ABB's delete-after behaviour with `opts.deleteBackup`.
    const body = `backup=${encodeURIComponent(`/fileservice/$BACKUP/${name}`)}&delete-dir=${opts?.deleteBackup === true}`;
    await this.access.withAccess(['rapid', 'cfg'], () =>
      this.rws1Post(buildPath(CTRL.restoreBackup.rws1 as PathSpec), body));
  }

  /**
   * Check that a backup can be restored, without restoring it: GET
   * `/ctrl/backup?action=check-restore&backup=<fileservice URI>`, as ABB's
   * RWS 1.0 manual (Rev M, "Check restore") documents. RW 6.16.03 answered it
   * 200 with `ctrl-checkrestore` status `Accepted` for an existing backup;
   * the POST this method used to send answered 400 "Invalid Request"
   * (2026-10-09). Resolves only for `Accepted`. Takes no mastership.
   *
   * @throws RwsError `INVALID_ARGUMENT` before sending for an empty name, or
   *   when the controller answers another status; otherwise the controller's
   *   classified error.
   */
  async checkRestore(name: string): Promise<void> {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new RwsError('checkRestore: the backup name is empty. Nothing was sent.', 'INVALID_ARGUMENT');
    }
    const r = await this.rws1Get(`${buildPath(CTRL.checkRestore.rws1 as PathSpec)}&backup=${encodeURIComponent(`/fileservice/$BACKUP/${name}`)}`);
    const status = String((r.state as { status?: unknown } | null)?.status ?? '');
    if (status.toLowerCase() !== 'accepted') {
      throw new RwsError(`checkRestore: the controller did not accept backup ${name} for a restore (status "${status || 'none'}")`, 'INVALID_ARGUMENT');
    }
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

  /**
   * One job the controller runs after answering 202, GET /progress/{id}: a
   * backup, a compress or a decompress. `startJob` returns the id of a
   * compress or a decompress. ABB's job states are `pending` while it runs and `ready`
   * when it is done, with the controller's return code in `details.code`
   * (negative when the job failed). `null` when the read is refused.
   */
  async getProgress(id: string): Promise<{ state: string; details?: Record<string, string> } | null> {
    try {
      const r = await this.rws1Get(`/progress/${encodeURIComponent(id)}`);
      const s = r.state as Record<string, string> | null;
      if (!s) { return null; }
      return { state: s.state ?? '', details: s };
    } catch { return null; }
  }

  // ── Stage 8: DIPC (6 methods) ──────────────────────────────────────────

  /**
   * The DIPC queues. RobotWare 6 lists the service's limits as a first
   * entry of its own (`dipc-info-li`, title `info`, max-body-size 444 and
   * max-pkg-size 5000 on RW 6.16.03, read 2026-09-29) before the
   * `dipc-queue-li` entries; that entry is not a queue and is left out.
   */
  async listDipcQueues(): Promise<Array<{ name: string; size?: number }>> {
    try {
      const r = await this.rws1Get(buildPath(CFG_ELOG_DIPC.listDipcQueues.rws1 as PathSpec));
      return r.states
        .filter(q => q._type !== 'dipc-info-li')
        .map(q => ({
          name: (q._title ?? q['queue-name'] ?? '') as string,
          size: q['queue-size'] !== undefined ? +(q['queue-size'] as string) : undefined,
        }));
    } catch { return []; }
  }

  /**
   * Create a DIPC queue: `POST /rw/dipc?action=dipc-create` with
   * `dipc-queue-name`, `dipc-queue-size` (from `maxmessages`, the number of
   * messages the queue holds) and `dipc-max-msg-size` (from `maxsize`, the
   * largest message in bytes, at most 444 on RobotWare 6), the form the
   * controller itself serves for `/rw/dipc`. The sizes are sent only when
   * given, as on RWS 2.0; ABB's RWS 1.0 page marks all three required, so
   * a create without them is the controller's to refuse.
   *
   * Live-verified 2026-09-30 on RW 6.16.03: this form answers 201. The
   * `?action=create` with `dipc-max-size` / `dipc-max-number-of-messages`
   * this method used to send answers 400 -1073445879 "Invalid action", so
   * every create failed on RobotWare 6.
   */
  async createDipcQueue(name: string, options: { maxsize?: number; maxmessages?: number } = {}): Promise<void> {
    const parts = [`dipc-queue-name=${encodeURIComponent(name)}`];
    if (options.maxmessages) { parts.push(`dipc-queue-size=${options.maxmessages}`); }
    if (options.maxsize)     { parts.push(`dipc-max-msg-size=${options.maxsize}`); }
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.createDipcQueue.rws1 as PathSpec), parts.join('&'));
  }

  /**
   * Send one message to a DIPC queue: `POST /rw/dipc/{queue}?action=dipc-send`
   * with `dipc-src-queue-name`, `dipc-cmd` 111, `dipc-userdef` 0,
   * `dipc-msgtype` and `dipc-data`, the send form RW 6.16.03 serves for a
   * queue (`?action=show`, read 2026-09-29) and ABB's RWS 1.0 page. The
   * `?action=send` without `dipc-userdef` this method used to send is in
   * neither. This form has run on RobotWare 6.16.03.
   */
  async sendDipcMessage(queue: string, payload: string, type: 'string' | 'num' | 'dnum' | 'bool' = 'string'): Promise<void> {
    const typeCode = type === 'string' ? '0' : type === 'num' ? '1' : type === 'dnum' ? '2' : '3';
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.sendDipcMessage.rws1 as PathSpec, { queue }),
      `dipc-src-queue-name=${encodeURIComponent(queue)}&dipc-cmd=111&dipc-userdef=0&dipc-msgtype=${typeCode}&dipc-data=${encodeURIComponent(payload)}`);
  }

  /**
   * Read (and so remove) the oldest message of a DIPC queue: ABB's RWS 1.0
   * `GET /rw/dipc/{queue}?action=dipc-read`, with `timeout` in whole
   * milliseconds when `timeoutMs` is a finite, non-negative number (ABB:
   * optional, default 0). Null when the queue holds no message, and on any
   * read error. Run on RobotWare 6.16.03.
   *
   * The controller may hold the read open for the whole wait, so the client's
   * request timeout for this one read is extended by the wait. Without that,
   * a wait that reached the client's `timeout` (5000 ms by default) was cut
   * off and answered null, and a message that reached the queue after the cut
   * was consumed by a read nobody received.
   *
   * RWS 1.0 sends every request of a client through one serial queue, so the
   * wait occupies that queue: every later request on the same client (reads,
   * writes, subscription requests, and the logout of a disconnect) waits until
   * the read answers.
   *
   * The wait is capped at `RWS1_DIPC_MAX_WAIT_MS` (280 s), which bounds how
   * long one read holds that queue. (It is set under the 300 s Node's fetch
   * waits for an answer's headers: fetch is the RWS 1.0 transport on every
   * port it accepts, and a read fetch gave up on could still take a message
   * off the queue. On a port fetch refuses the transport is node:http, and
   * the read's own timeout is the only bound.) A read that fails is never
   * sent again (HttpSession.viaNodeHttp; fetch never sends one twice): the
   * first one may already have taken a message.
   */
  async readDipcMessage(queue: string, timeoutMs?: number): Promise<{ payload: string; type: string } | null> {
    try {
      const base = buildPath(CFG_ELOG_DIPC.readDipcMessage.rws1 as PathSpec, { queue });
      const waitMs = timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.min(Math.floor(timeoutMs), RWS1_DIPC_MAX_WAIT_MS)
        : undefined;
      const url = waitMs !== undefined ? `${base}&timeout=${waitMs}` : base;
      const r = await this.rws1Get(url, waitMs ?? 0);
      const s = r.state as Record<string, string> | null;
      if (!s || !s['dipc-data']) { return null; }
      return { payload: s['dipc-data'], type: s['dipc-msgtype'] ?? 'string' };
    } catch { return null; }
  }

  /**
   * Delete a DIPC queue: `DELETE /rw/dipc/{queue}` (204, live-verified
   * 2026-09-30 on RW 6.16.03). A refusal (another user's queue, a queue that
   * does not exist) throws the controller's typed error, as on RWS 2.0; it
   * used to be ignored.
   */
  async removeDipcQueue(name: string): Promise<void> {
    const url = `${buildPath(CFG_ELOG_DIPC.removeDipcQueue.rws1 as PathSpec, { queue: name })}?json=1`;
    const res = await this.client.request('DELETE', url);
    if (res.status >= 400) { throw rws1Error('DELETE', url, res.status, res.body, this.refusalContext()); }
  }

  // ── Stage 9: Safety (5 methods) ────────────────────────────────────────

  async getSafetyStatus(): Promise<{ state: string; details?: Record<string, string> }> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getSafetyStatus.rws1 as PathSpec));
      const s = r.state as Record<string, string> | null;
      return { state: s?.state ?? 'unavailable', details: s ?? undefined };
    } catch { return { state: 'unavailable' }; }
  }

  /**
   * Safety zones: no RWS document has such a resource. ABB's RWS 1.0 manual
   * (Rev M) lists config-status, safety-mode, cbc-status, loadoperation-status,
   * safety-config and violation-info under /ctrl/safety, and RW 6.16.03
   * answers /ctrl/safety/zones with 404. Answers [] without a request. Kept
   * for source compatibility; to be retired at the next major version.
   * @deprecated There is no RWS resource behind this method.
   */
  async listSafetyZones(): Promise<Array<Record<string, string>>> {
    return [];
  }

  /**
   * RWS 1.0 has no operation that starts a cyclic brake check: ABB's manual
   * (Rev M) documents only the status read (`/ctrl/safety?resource=cbc-status`),
   * and RW 6.16.03 answers the path this used to POST with 404. A brake check
   * is started from RAPID or the FlexPendant. Throws `RwsError`
   * `UNSUPPORTED_OPERATION` before anything is sent.
   */
  async runCyclicBrakeCheck(): Promise<void> {
    throw new RwsError(
      'RWS 1.0 has no operation that starts a cyclic brake check (it is started from RAPID or the FlexPendant; ABB documents only its status read); nothing was sent',
      'UNSUPPORTED_OPERATION',
    );
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
      // The state is the controller's own vocabulary (VTSTOP, VTFREERUN,
      // VTRUNSLICE, VTNEXTEVENT): anything but VTSTOP is running. The speed is
      // a percent of real time (100 = real time, -1 = full speed); the client
      // reports a factor. Both read as on RWS 2.0 (spec check 2026-10-07; the
      // RobotWare 6.16 virtual controller was not re-read, so the vocabulary rests on the shared history).
      const st = String(state.vtcurrstate ?? state.state ?? '').toUpperCase();
      const pct = speed.vtcurrspeed !== undefined ? Number(speed.vtcurrspeed) : undefined;
      return {
        time:    Number(time.vtcounter ?? time.time ?? 0),
        running: st !== '' && st !== 'VTSTOP',
        speed:   pct === undefined || Number.isNaN(pct) ? undefined : pct < 0 ? Infinity : pct / 100,
        ...(st ? { state: st } : {}),
      };
    } catch { return { time: 0, running: false }; }
  }

  /**
   * Not sent: the client sends no virtual-time write to RobotWare 6 in this
   * release, although ABB's RWS 1.0 documents the speed write for virtual
   * controllers, so this refuses before sending (`UNSUPPORTED_OPERATION`,
   * refusal kind `unsupported`). This is one of the client's deliberate
   * exceptions to "the controller decides", with `setPPToServiceRoutine` on
   * RobotWare 8 in Auto and an RMMP level above the one held. Change the
   * simulation speed in RobotStudio. The reads (`getVirtualTime` and the
   * atomic virtual-time reads) are unchanged.
   */
  async setVirtualTimeScale(_scale: number): Promise<void> {
    const sentence = 'The client sends no virtual-time write to RobotWare 6 in this release, although ABB documents the speed write for virtual controllers; change the simulation speed in RobotStudio.';
    throw new RwsError(`RWS1 setVirtualTimeScale: ${sentence}`, 'UNSUPPORTED_OPERATION', undefined, undefined, undefined, undefined, builtRefusal({
      kind: 'unsupported', condition: 'none', generation: 'rw6', grantor: 'nobody',
      missing: 'a virtual-time write on RobotWare 6 (not sent by this client in this release)',
      fix: 'Change the simulation speed in RobotStudio.', sentence, evidence: 'unverified',
      remedy: remedy.notAvailable('rw6', {
        detail: 'This client sends no virtual-time write to RobotWare 6 in this release; change the simulation speed in RobotStudio.',
        evidence: 'unverified',
        basis: "the client's own hold on RobotWare 6 virtual-time writes",
      }),
    }));
  }

  /**
   * Sends nothing and throws `UNSUPPORTED_OPERATION`: pause and resume the
   * virtual clock from RobotStudio's Simulation tab.
   * @deprecated Kept so code written for 1.3.x still compiles; removed at the next major version (2.0).
   */
  async setVirtualTimeRunning(_running: boolean): Promise<void> {
    throw virtualTimeRunningUnsupported();
  }

  /** Virtual-time timeslice (ms). RWS 1.0 counterpart of the RWS 2.0 method -
   *  live-verified on the RobotWare 6.16 virtual controller (2026-08-11): GET /ctrl/virtualtime/vttimeslice
   *  answers a `ctrl-vttimeslice` state carrying `VTTimeslice`. */
  async getVirtualTimeTimeslice(): Promise<number> {
    const r = await this.rws1Get(buildPath(CTRL.getVirtualTimeTimeslice.rws1 as PathSpec));
    const s = (r.state as { VTTimeslice?: string; vttimeslice?: string } | null) ?? {};
    return Number(s.VTTimeslice ?? s.vttimeslice ?? 0);
  }

  /** Ensure a controller path is in the `/fileservice/`-prefixed form the RWS 1.0
   *  compress endpoint requires (it rejects a bare `$HOME/...` as "Invalid File
   *  Service path"). Leaves an already-prefixed path untouched. */
  private static fsPath(p: string): string {
    const norm = p.replace(/^\//, '');
    return norm.startsWith('fileservice/') ? `/${norm}` : `/fileservice/${norm}`;
  }

  /**
   * Compress a controller path into a `.rzo` archive. RWS 1.0 counterpart of the
   * RWS 2.0 method. Unlike RWS 2.0's path-action form, RWS 1.0 uses the
   * query-action `POST /ctrl/compress?action=comp` and requires
   * `/fileservice/`-prefixed paths, as the ABB RWS 1.0 reference documents.
   * ($HOME / $system were reported protected, answering "Compression Forbidden".)
   *
   * Live 2026-10-13 on RW 6.16.03: `$TEMP/ZZ_RW6W_C.txt` to `$TEMP/ZZ_RW6W_C.cmp`
   * answered 202. The controller accepts the job and runs it after the call
   * returns: this method resolves at that 202, not when the archive is done.
   * 100 ms later the directory held the source, the `.cmp` at the given
   * destination and a `ZZ_RW6W_C.txt.tar` beside the source. The destination
   * is sent as given; the `.tar` is the controller's own file, named after the
   * source, not after the destination. A decompress of the `.cmp` 400 ms after
   * the 202 was refused as "an uncompressed or an invalid file", most likely
   * because the job had not finished; whether the `.tar` goes away when it
   * finishes was not observed.
   *
   * Returns nothing, as in 1.4.0. To wait for the archive, start it with
   * `startJob('compressPath', source, destination)`, which returns the job's
   * progress id.
   */
  async compressPath(source: string, destination: string): Promise<void> {
    await this.startJob('compressPath', source, destination);
  }

  /** Decompress an `.rzo` archive. RWS 1.0 has no separate `/ctrl/decompress`; it
   *  reuses `/ctrl/compress?action=dcomp` with the same `/fileservice/` paths.
   *
   * A file that is not a finished archive is refused 400 -1073414146 "Cannot
   * decompress an uncompressed or an invalid file" (RW 6.16.03, 2026-10-13),
   * thrown as `INVALID_ARGUMENT`. Wait for the compress job to finish first:
   * start it with `startJob` and poll `getProgress` with the id it returns.
   * Returns nothing, as in 1.4.0; `startJob('decompressPath', ...)` returns
   * this job's progress id.
   *
   * @experimental Built from the controller form; no logged 2xx on an RWS 1.0 controller.
   */
  async decompressPath(source: string, destination: string): Promise<void> {
    await this.startJob('decompressPath', source, destination);
  }

  /**
   * Start a controller job, `compressPath` or `decompressPath` (the same
   * request and `/fileservice/` paths as that method), and return its
   * progress id, read from the `Location: /progress/{id}` header of the 202
   * (ABB Rev M), or `undefined` when the answer has none. The controller runs
   * the job after the 202: poll `getProgress(id)` until its `state` is no
   * longer `pending` (ABB's finished state is `ready`); `details.code` is
   * then the controller's return code, negative when the job failed.
   *
   * @throws RwsError `INVALID_ARGUMENT` for a name that is not one of these
   *   jobs, before sending; otherwise the controller's typed error.
   */
  async startJob(name: ControllerJobName, source: string, destination: string): Promise<string | undefined> {
    const row = CTRL[controllerJobName(name, 'RWS1 startJob')];
    const path = buildPath(row.rws1 as PathSpec);
    const url = path + (path.includes('?') ? '&' : '?') + 'json=1';
    const body = `srcpath=${encodeURIComponent(RWS1Adapter.fsPath(source))}&dstpath=${encodeURIComponent(RWS1Adapter.fsPath(destination))}`;
    const res = await this.client.request('POST', url, body);
    if (res.status >= 400) { throw rws1Error('POST', url, res.status, res.body, this.refusalContext(), body); }
    return progressIdFrom(res.headers?.get('location'));
  }

  // ── RWS 1.0 forms discovered from the ABB reference + live-verified 2026-08-11 ──

  /** Read a module's text directly from program memory. RWS 1.0 is a flat module
   *  collection scoped by ?task=; whole text via ?resource=module-text. The
   *  `module-text` span is URL-encoded on the wire. Class rap-module-text. */
  async getModuleText(task: string, module: string): Promise<{ text: string; changeCount: number }> {
    const base = buildPath(RAPID.getModuleText.rws1 as PathSpec, { module });
    const r = await this.rws1Get(`${base}?resource=module-text&task=${encodeURIComponent(task)}`);
    const s = (r.state as { 'module-text'?: string; 'change-count'?: string } | null) ?? {};
    return { text: decodeURIComponent(s['module-text'] ?? ''), changeCount: Number(s['change-count'] ?? 0) };
  }

  /** Read a text range from a module. RWS 1.0 selects the range purely by the
   *  startrow/startcol/endrow/endcol query params (no resource verb); endCol=-1
   *  means end-of-line.
   *
   *  Unlike the whole-module read, the range's JSON `text` value is NOT
   *  URL-encoded: it carries raw spaces and XML entities (`&quot;` `&lt;` `&gt;`
   *  `&amp;` `&apos;`) and ends in a newline (live-verified 2026-09-29 on
   *  RW 6.16.03, which never URL-encodes range text). The encoding is decided
   *  by the key the controller answered with, never by how the text looks:
   *  `text` is entity-decoded (`&amp;` last), and a `module-text` value is
   *  URL-decoded like the whole-module read. A literal `%XX` or entity in the
   *  RAPID text therefore comes back as written. */
  async getModuleTextRange(task: string, module: string, startRow: number, startCol: number, endRow: number, endCol: number): Promise<string> {
    const base = buildPath(RAPID.getModuleTextRange.rws1 as PathSpec, { module });
    const q = `task=${encodeURIComponent(task)}&startrow=${startRow}&startcol=${startCol}&endrow=${endRow}&endcol=${endCol}`;
    const r = await this.rws1Get(`${base}?${q}`);
    const s = (r.state as { 'module-text'?: string; text?: string } | null) ?? {};
    return RWS1Adapter.decodeRangeText(s);
  }

  /** Decode a text-range answer by its key: `module-text` is URL-encoded
   *  (the whole-module read's key and encoding), `text` carries XML entities.
   *  One decoder per value, never both. */
  private static decodeRangeText(s: { 'module-text'?: string; text?: string }): string {
    if (s['module-text'] !== undefined) { return decodeURIComponent(s['module-text']); }
    return decodeEntities(s.text ?? '');
  }

  /**
   * Replace a module's source in program memory: POST
   * `/rw/rapid/modules/{module}?action=set-module-text&task={task}` with `task`
   * and `text`, the write side of `getModuleText`. The flat module resource
   * scoped by `?task=` is the one the module save and text reads use on RWS 1.0.
   *
   * The fields are the `set-module-text` form RW 6.16.03 serves on
   * `modules/{module}?action=show` (read 2026-09-29): `task` and `text`. That
   * form has no `path` field (the RWS 2.0 form has one); `path` is sent only
   * when the caller passes it.
   *
   * Holds RAPID mastership around the write, like module load and unload.
   *
   * Live 2026-10-13 on RW 6.16.03: answered 200 and the text read back changed,
   * three times out of three. Each time the controller had dropped RAPID
   * mastership by then: the release that followed was refused 403 -1073445880
   * (SYS_CTRL_E_RESOURCE_NOT_HELD), and the client logged that mastership was
   * lost, which is what happened. That is the controller's behaviour and is
   * left as it is. A caller that holds RAPID mastership across this call
   * should expect to hold it no longer.
   *
   * @throws RwsError with the controller's classified code on any HTTP error.
   */
  async setModuleText(task: string, module: string, text: string, path?: string): Promise<void> {
    let body = `task=${encodeURIComponent(task)}&text=${encodeURIComponent(text)}`;
    if (path !== undefined) { body += `&path=${encodeURIComponent(path)}`; }
    const url = `${buildPath(RAPID.setModuleText.rws1 as PathSpec, { module })}&task=${encodeURIComponent(task)}`;
    await this.access.withAccess(['rapid'], () => this.rws1Post(url, body));
  }

  /**
   * Replace a row/column range of a module's source in program memory: POST
   * `/rw/rapid/modules/{module}?action=set-text-range&task={task}` with `task`,
   * `replace-mode`, `query-mode`, `startrow`, `startcol`, `endrow`, `endcol`
   * and `text` - the `set-text-range` form RW 6.16.03 serves on
   * `modules/{module}?action=show` (read 2026-09-29), the same eight fields as
   * the RWS 2.0 form. The form's defaults are replace-mode `After` and
   * query-mode `Force`, used here when none is given, as on RWS 2.0.
   *
   * Holds RAPID mastership around the write.
   *
   * Live 2026-10-13 on RW 6.16.03: answered 204 and the range was inserted
   * after the given row under the default replace-mode `After`. Unlike
   * `setModuleText`, the one call recorded kept RAPID mastership: its release
   * answered 204.
   *
   * @throws RwsError with the controller's classified code on any HTTP error.
   */
  async setModuleTextRange(
    task: string, module: string,
    range: { startRow: number; startCol: number; endRow: number; endCol: number },
    text: string,
    opts?: { replaceMode?: string; queryMode?: string },
  ): Promise<void> {
    const fields: Array<[string, string]> = [
      ['task', task],
      ['replace-mode', opts?.replaceMode ?? 'After'],
      ['query-mode', opts?.queryMode ?? 'Force'],
      ['startrow', String(range.startRow)], ['startcol', String(range.startCol)],
      ['endrow', String(range.endRow)], ['endcol', String(range.endCol)],
      ['text', text],
    ];
    const body = fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const url = `${buildPath(RAPID.setModuleTextRange.rws1 as PathSpec, { module })}&task=${encodeURIComponent(task)}`;
    await this.access.withAccess(['rapid'], () => this.rws1Post(url, body));
  }

  /** Check whether a known motion change-count is still current. RWS 1.0 passes
   *  the count as a ?changecount= query (RWS 2.0 uses a path segment). Returns
   *  true when still current (changestate TRUE). */
  async checkMotionChangeCount(changecount: number): Promise<boolean> {
    const r = await this.rws1Get(`${buildPath(MOTION.checkMotionChangeCount.rws1 as PathSpec)}?changecount=${changecount}`);
    const s = (r.state as { changestate?: string } | null) ?? {};
    return (s.changestate ?? '').toUpperCase() === 'TRUE';
  }

  /** Extended signal search (1-2 AND-narrowing criteria sets). RWS 1.0 query-action
   *  form; same ios-signal-li result as the base search. */
  async searchSignalsEx(criteria: SignalSearchExCriteria[]): Promise<Signal[]> {
    if (criteria.length === 0 || criteria.length > 2) {
      throw new RwsError(`signal-searchex takes 1 or 2 criteria sets, got ${criteria.length}`, 'INVALID_ARGUMENT');
    }
    const parts: string[] = [];
    criteria.forEach((c, i) => {
      const sfx = i === 0 ? '' : '2';
      const put = (k: string, v: string | undefined): void => { if (v !== undefined && v !== '') { parts.push(`${k}${sfx}=${encodeURIComponent(v)}`); } };
      put('name', c.name); put('device', c.device); put('network', c.network);
      put('category', c.category); put('category-pon', c.categoryPon); put('type', c.type);
      if (c.invert !== undefined) { parts.push(`invert${sfx}=${c.invert}`); }
      if (c.blocked !== undefined) { parts.push(`blocked${sfx}=${c.blocked}`); }
    });
    // Raw request (no json=1) so the response is the XHTML ios-signal-li list
    // that parseSignalList consumes, same as the base signal search. Wrap the
    // request+parse so a parser throw surfaces as a typed RwsError, matching the
    // base searchSignals (which routes through ResourceMapper's error-wrap).
    try {
      const res = await this.client.request('POST', buildPath(IO.searchSignalsEx.rws1 as PathSpec), parts.join('&'));
      return parseSignalList(res.body);
    } catch (e) {
      if (e instanceof RwsError) { throw e; }
      throw new RwsError(`searchSignalsEx failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /** Save the raw event log to a controller file (async, 202). `destination` is
   *  normalised to the `/fileservice/` URI the endpoint requires. */
  async saveEventLogRaw(destination: string): Promise<void> {
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.saveEventLogRaw.rws1 as PathSpec),
      `path=${encodeURIComponent(RWS1Adapter.fsPath(destination))}`);
  }

  /** Set the FlexPendant/panel language (field lang-code). RWS 1.0 query-action. */
  async setPanelLanguage(langCode: string): Promise<void> {
    await this.rws1Post(buildPath(PANEL.setPanelLanguage.rws1 as PathSpec), `lang-code=${encodeURIComponent(langCode)}`);
  }

  /** Set the controller language (field lang, NOT the panel's lang-code). */
  async setControllerLanguage(lang: string): Promise<void> {
    await this.rws1Post(buildPath(CTRL.setControllerLanguage.rws1 as PathSpec), `lang=${encodeURIComponent(lang)}`);
  }

  /**
   * Search I/O devices by criteria (distinct from searchDevices, which searches
   * the /rw/devices hardware tree). RWS 1.0 query-action; at least one of `name`
   * or `lstate` must be given (else the controller answers 400). Live-verified on
   * the RobotWare 6.16 virtual controller (2026-08-11): returns ios-device-li rows.
   */
  async searchIoDevices(criteria: { name?: string; lstate?: 'enabled' | 'disabled' | 'unknown'; network?: string }): Promise<IoDevice[]> {
    if (!criteria.name && !criteria.lstate) {
      throw new RwsError('searchIoDevices: at least one of name or lstate is required', 'INVALID_ARGUMENT');
    }
    const parts: string[] = [];
    if (criteria.name)    { parts.push(`name=${encodeURIComponent(criteria.name)}`); }
    if (criteria.lstate)  { parts.push(`lstate=${encodeURIComponent(criteria.lstate)}`); }
    if (criteria.network) { parts.push(`network=${encodeURIComponent(criteria.network)}`); }
    // Raw request (no json=1) so the response is the XHTML ios-device-li list.
    // Wrap request+parse for a typed RwsError on a parser throw (parity with the
    // mapper-routed base searches; see searchSignalsEx above).
    try {
      const res = await this.client.request('POST', buildPath(IO.searchIoDevices.rws1 as PathSpec), parts.join('&'));
      return parseDevices(res.body);
    } catch (e) {
      if (e instanceof RwsError) { throw e; }
      throw new RwsError(`searchIoDevices failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ── I/O state writes (ABB RWS 1.0 Rev M forms) ─────────────────────────
  // Like a signal value write, these take no mastership: the controller
  // decides from the signal's or device's own access settings.

  /**
   * Simulate a signal, or end its simulation: `POST
   * /rw/iosystem/signals/{network}/{device}/{signal}?action=set` with `lstate`
   * `simulated` or `not simulated`, ABB's RWS 1.0 "Update IO Signal State"
   * (Rev M; 204). The same path and action as a value write, which sends
   * `lvalue` instead. INVALID_ARGUMENT before sending when a segment is empty:
   * ABB documents this form for a signal addressed by network, device and name.
   *
   * @experimental Built from ABB's RWS 1.0 page; not yet run against an RWS 1.0 controller.
   */
  async setSignalSimulated(network: string, device: string, name: string, simulated: boolean): Promise<void> {
    if ([network, device, name].some(v => typeof v !== 'string' || v.trim() === '')) {
      throw new RwsError('RWS1 setSignalSimulated: network, device and signal name must not be empty (ABB addresses the signal as {network}/{device}/{signal})', 'INVALID_ARGUMENT');
    }
    await this.rws1Post(buildPath(IO.setSignalSimulated.rws1 as PathSpec, { network, device, name }),
      `lstate=${encodeURIComponent(simulated ? 'simulated' : 'not simulated')}`);
  }

  /**
   * End the simulation of every simulated signal: `POST
   * /rw/iosystem/signals?action=unblock-signal`, no body, ABB's RWS 1.0
   * "Unblock Signals" (Rev M; 204).
   *
   * @experimental Built from ABB's RWS 1.0 page; not yet run against an RWS 1.0 controller.
   */
  async unblockSignals(): Promise<void> {
    await this.rws1Post(buildPath(IO.unblockSignals.rws1 as PathSpec), '');
  }

  /**
   * Enable or disable an I/O device: `POST /rw/iosystem/devices/{device}?action=set`
   * with `lstate` `enable` or `disable`, ABB's RWS 1.0 "Update IO Device" (Rev
   * M; 204). The device is named without its network, as `getIoDeviceInfo`
   * names it here; `network` is kept for parity with RwsClient2 and not sent.
   * A disabled device's signals are unavailable until it is enabled again.
   *
   * @experimental Built from ABB's RWS 1.0 page; not yet run against an RWS 1.0 controller.
   */
  async setIoDeviceLState(_network: string, device: string, enable: boolean): Promise<void> {
    if (typeof device !== 'string' || device.trim() === '') {
      throw new RwsError('RWS1 setIoDeviceLState: the device name must not be empty', 'INVALID_ARGUMENT');
    }
    await this.rws1Post(buildPath(IO.setIoDeviceLState.rws1 as PathSpec, { device }), `lstate=${enable ? 'enable' : 'disable'}`);
  }

  /**
   * Motors on without the key switch (Keyless Mode Switch option): `POST
   * /rw/cfg?action=keyless` with `state=run`, ABB's RWS 1.0 "Keyless motor ON"
   * (Rev M; 204). It energises the drives; `setControllerState('motoroff')`
   * switches them off. ABB's page names no mastership; RAPID mastership is
   * held around the post, as `RobotManager.setMotorsOn` holds it for the
   * ordinary motors-on, and a hold this session already has is reused. A
   * RobotWare 6.16.03 virtual controller with the motors off answered 204
   * between the RAPID mastership request and release, and read motors on
   * 1.1 s later (2026-10-18).
   */
  async setKeylessMotorOn(): Promise<void> {
    await this.access.withAccess(['rapid'], async () => {
      await this.rws1Post(buildPath(PANEL.setKeylessMotorOn.rws1 as PathSpec), 'state=run');
    });
  }

  /**
   * One controller environment variable, such as `HOME`, `TEMP` or `SYSTEM`
   * (a leading `$` is accepted and dropped): `GET /ctrl/${ENVNAME}` with the
   * `$` sent as `%24`, ABB's RWS 1.0 "Get Controller environment variable"
   * (Rev M). Returns the `ctrl-env` entry's value: its `value` span, else its
   * `_value`, where RW 6.16.03 puts it in the `?json=1` answer (2026-10-18).
   * An unknown name is the controller's 404.
   *
   * @throws RwsError `INVALID_ARGUMENT` for an empty name, before sending;
   *   `PARSE_ERROR` when the answer has no `ctrl-env` value.
   *
   * A RobotWare 6.16.03 virtual controller answered `TEMP`, `HOME` and
   * `BACKUP`, and 404 for an unknown name (2026-10-18).
   */
  async getEnv(name: string): Promise<string> {
    const bare = envName(name, 'RWS1 getEnv');
    const p = await this.rws1Doc(buildPath(CTRL.getEnv.rws1 as PathSpec, { name: bare }));
    return envValueFrom(p.getAllEntries(), `RWS1 getEnv(${bare})`);
  }

  /**
   * Validate a configuration file WITHOUT applying it (a load dry-run). RWS 1.0
   * collection-level query-action. Throws if the file is invalid. Live-verified on
   * the RobotWare 6.16 virtual controller (2026-08-11).
   * @param filepath   a BARE controller path to the .cfg file, e.g. `$TEMP/x.cfg`
   *                   (with the `$VOLUME` prefix) - NOT a `/fileservice/` URI,
   *                   which the endpoint rejects. Same convention as loadCfgFile.
   * @param actionType 'add' | 'replace' | 'add-with-reset' (how it WOULD be loaded)
   */
  async validateCfgFile(filepath: string, actionType: 'add' | 'replace' | 'add-with-reset' = 'add'): Promise<void> {
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.validateCfgFile.rws1 as PathSpec),
      `filepath=${encodeURIComponent(filepath)}&action-type=${actionType}`);
  }

  /** Check whether a configuration instance can be safely deleted (a delete
   *  dry-run). Throws if it cannot. RWS 1.0 only; unsupported in bootserver mode.
   *  Live-verified on the RobotWare 6.16 virtual controller (2026-08-11). */
  async validateInstanceBeforeDelete(name: string): Promise<void> {
    await this.rws1Post(buildPath(CFG_ELOG_DIPC.validateInstanceBeforeDelete.rws1 as PathSpec),
      `name=${encodeURIComponent(name)}`);
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

  /** @experimental Built from the controller form; never run against an RWS 1.0 controller. */
  async getVisionSystemInfo(name: string): Promise<Record<string, string>> {
    try {
      // The camera is a query parameter on RWS 1.0 (Rev M); see the path row.
      const r = await this.rws1Get(`${buildPath(FILES_VISION.getVisionSystemInfo.rws1 as PathSpec)}&name=${encodeURIComponent(name)}`);
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  /**
   * RWS 1.0 documents no way to trigger a vision job: the Integrated Vision
   * pages of ABB's manual (Rev M) have camera reads and settings, a refresh, a
   * restart and an LED flash, and no trigger. Throws `RwsError`
   * `UNSUPPORTED_OPERATION` before anything is sent; the method stays so the
   * public surface does not change.
   */
  async triggerVisionJob(system: string, job: string): Promise<void> {
    throw new RwsError(
      `RWS 1.0 has no operation to trigger a vision job (asked for '${job}' on '${system}'): ABB's Integrated Vision service documents no trigger; nothing was sent`,
      'UNSUPPORTED_OPERATION',
    );
  }

  // ── Stage 12: RAPID extras (4 methods) ─────────────────────────────────

  /**
   * Save a loaded module's program-memory source to controller disk.
   * Live-verified 2026-07-09 on the RobotWare 6.16 virtual controller:
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
   * Live-verified 2026-07-08 on the RobotWare 6.16 virtual controller:
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

  /**
   * The routines (PROC, FUNC, TRAP) of one module, from the module-scoped
   * RAPID symbol search (`POST /rw/rapid/symbols?action=search-symbols`,
   * `blockurl=RAPID/{task}/{module}`): RWS 1.0 has no routine resource the
   * controller links (the RW 6.16.03 module body carries none, 2026-09-29),
   * and the module-scoped search there answers the module's PROC entries
   * (`rap-sympropproc-li`, symtyp `prc`; live-read 2026-09-29). Only hits
   * directly in the module are kept, so a routine's parameters and local data
   * are not listed. `type` is `prc`, `fun` or `trp`, as on RwsClient2.
   *
   * This replaces a GET of /rw/rapid/modules/{task}/{module}/routines that was
   * never verified and answered an empty list on every error; a refusal is
   * now the controller's typed error.
   */
  async listModuleRoutines(task: string, moduleName: string): Promise<RapidRoutineInfo[]> {
    if (typeof task !== 'string' || task.trim() === '' || typeof moduleName !== 'string' || moduleName.trim() === '') {
      throw new RwsError('RWS1 listModuleRoutines: task and module names must not be empty', 'INVALID_ARGUMENT');
    }
    const hits = await this.client.searchRapidSymbols({ task, blockurl: `RAPID/${task}/${moduleName}`, symtyp: 'any' });
    return routinesFromSymbols(hits, task, moduleName);
  }

  /**
   * The breakpoints of a task: GET `/rw/rapid/tasks/{task}/program/breakpoint`,
   * the singular resource ABB's RWS 1.0 manual (3HAC050973-001 Rev M) names.
   *
   * Live-verified 2026-09-29 on RW 6.16.03: that path answers 200 with an empty
   * list, paged (the self link carries `limit=120`), and the program resource
   * links it. The path this method used before, `/rw/rapid/tasks/{task}/breakpoints`,
   * answers 404 -1073414146 there, and so does the RWS 2.0 spelling
   * `program/breakpoints`; the 404 used to be swallowed into `[]`, so an IRC5
   * always reported no breakpoints. A refusal now throws the controller's typed
   * error.
   *
   * Entry fields: ABB documents the entries as `rap-program-breakpoint` with
   * `module-name`, `start-row`, `start-col`, `end-row` and `end-col`
   * (RWS 2.0 Rev L "Get Break Points"; the RWS 1.0 manual pages read have none).
   * On RW 6.16.03 (2026-10-13) a breakpoint set at row 8 column 5 was listed
   * with its module but read back as row 0 by the earlier guesses (`row`,
   * `begin-position-row`); the entry body was not logged. The documented
   * names are read first and the guesses after them, and a `next` link is
   * followed page by page.
   *
   * @throws RwsError with the controller's classified code on any HTTP error;
   *   `PARSE_ERROR`, naming the fields seen, for an entry with a module and no
   *   row this client can read (it used to be reported as row 0).
   */
  async listBreakpoints(task: string): Promise<Array<{ module: string; row: number; col?: number }>> {
    const first = buildPath(RAPID.listBreakpoints.rws1 as PathSpec, { task });
    const out: Array<{ module: string; row: number; col?: number }> = [];
    let path = first;
    for (let page = 0; path && page < 50; page++) {
      const r = await this.rws1Get(path);
      for (const b of r.states) {
        const module = String(b.module ?? b.modulename ?? b['module-name'] ?? '');
        if (!module) { continue; }
        const rowRaw = b['start-row'] ?? b.row ?? b['begin-position-row'];
        const row = Number(rowRaw);
        if (rowRaw === undefined || rowRaw === '' || !Number.isFinite(row)) {
          throw new RwsError(`listBreakpoints: a breakpoint in ${module} has no row this client can read (fields: ${Object.keys(b).join(', ')})`, 'PARSE_ERROR');
        }
        const colRaw = b['start-col'] ?? b.column ?? b['begin-position-col'];
        out.push({ module, row, ...(colRaw !== undefined && colRaw !== '' ? { col: Number(colRaw) } : {}) });
      }
      path = nextPagePath(r.raw, first);
    }
    return out;
  }

  /**
   * Set a breakpoint: POST `/rw/rapid/tasks/{task}/program/breakpoint?action=set`
   * with `module`, `row` and `column`, as ABB's RWS 1.0 manual (Rev M) names them.
   * RW 6.16.03 advertises the `set` form (read 2026-09-29), but its only input
   * is `<input module="modulename" row="rowno" column="columno" />`, with no
   * name attributes, so the field names come from the manual, not the form.
   * `column` defaults to 1, as on RWS 2.0.
   *
   * Holds RAPID mastership around the write (the manual: "Mastership is
   * required"; the domain is not named).
   *
   * Run on RobotWare 6.16.03.
   *
   * @throws RwsError `INVALID_ARGUMENT` before sending for an empty module or a
   *   row/column that is not a positive integer; otherwise the controller's
   *   classified error.
   */
  async setBreakpoint(task: string, module: string, row: number, col = 1): Promise<void> {
    checkSourcePosition('setBreakpoint', module, row, col);
    const body = `module=${encodeURIComponent(module)}&row=${row}&column=${col}`;
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.setBreakpoint.rws1 as PathSpec, { task }), body));
  }

  /**
   * Move the program pointer to a source position: POST
   * `/rw/rapid/tasks/{task}/pcp?action=set-pp-cursor` with `module`, `line`,
   * `column` and `routine`, as ABB's RWS 1.0 manual (Rev M) writes it. The
   * form RW 6.16.03 serves on `pcp?action=show` spells the action
   * `set-pp-curser`, which the controller refuses; the documented spelling is
   * sent. `row` goes out as `line`, `col` as `column`. The controller needs
   * the routine that holds the position: without `routine`, the routine around
   * `row` is read from the module text first.
   *
   * Holds RAPID mastership around the write, like the PP-to-routine move.
   *
   * Run on RobotWare 6.16.03.
   *
   * @throws RwsError `INVALID_ARGUMENT` before sending the move for an empty
   *   module, a row/column that is not a positive integer, or (without
   *   `routine`) a row that is not inside a routine; otherwise the
   *   controller's classified error.
   */
  async setPPToCursor(task: string, module: string, row: number, col: number, routine?: string): Promise<void> {
    checkSourcePosition('setPPToCursor', module, row, col);
    // RWS 1.0 needs the routine that holds the position ("Routine name is
    // missing." without it, RW 6.16.03); a caller that gives none gets the
    // routine the module text puts around the row.
    const name = routine || enclosingRoutine((await this.getModuleText(task, module)).text, row);
    if (!name) {
      throw new RwsError(`setPPToCursor: row ${row} of module ${module} is not inside a routine; nothing was moved`, 'INVALID_ARGUMENT');
    }
    const body = `module=${encodeURIComponent(module)}&line=${row}&column=${col}&routine=${encodeURIComponent(name)}`;
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.setPPToCursor.rws1 as PathSpec, { task }), body));
  }

  /**
   * Move the program pointer back one instruction: POST
   * `/rw/rapid/tasks/{task}/pcp?action=set-pp-prev-inst` with an empty body,
   * the field-less form RW 6.16.03 serves on `pcp?action=show` (read
   * 2026-09-29). The RWS 2.0 counterpart is `POST .../pcp/prev-inst`. Holds
   * RAPID mastership around the write, like the other PP moves.
   *
   * Run on RobotWare 6.16.03.
   *
   * @throws RwsError with the controller's classified code on any HTTP error.
   */
  async ppPrevInst(task: string): Promise<void> {
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.ppPrevInst.rws1 as PathSpec, { task }), ''));
  }

  /**
   * Move the program pointer forward one instruction: POST
   * `/rw/rapid/tasks/{task}/pcp?action=set-pp-next-inst` with an empty body,
   * the field-less form RW 6.16.03 serves on `pcp?action=show` (read
   * 2026-09-29). The RWS 2.0 counterpart is `POST .../pcp/next-inst`. Holds
   * RAPID mastership around the write, like the other PP moves.
   *
   * Run on RobotWare 6.16.03.
   *
   * @throws RwsError with the controller's classified code on any HTTP error.
   */
  async ppNextInst(task: string): Promise<void> {
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.ppNextInst.rws1 as PathSpec, { task }), ''));
  }

  /**
   * Hold to run: POST `/rw/rapid/execution?action=holdtorun-state` with the
   * one field `state` = press | held | release. The form is the one RW 6.16.03
   * advertises on `GET /rw/rapid/execution?action=show` (read 2026-09-29), and
   * ABB's RWS 1.0 manual (Rev M, "Set Hold to Run Cmd") documents the values;
   * ABB documents sending `held` about every 2 s to keep the motion going.
   * Execution is controller-wide, so `task` is not sent.
   *
   * Holds RAPID mastership around each post, like the other execution writes
   * (start, PP to main, cycle), until a live run shows what the controller
   * checks. Inside a RAPID hold the caller took with
   * `requestMastership('rapid')`, as for a run of `held` calls, nothing is
   * requested or released per call.
   *
   * CAUTION: ABB documents this for a virtual controller only, for a local
   * client, in manual mode. This client connects as a remote client, so a
   * controller may refuse it. Built from the advertised form and ABB's
   * manual; the controller accepted it on RW 6.16.03 (2026-10-09).
   *
   * @throws RwsError with the controller's classified code on any HTTP error;
   *   a refused mastership request fails the call before anything is posted.
   */
  async holdToRun(_task: string, action: 'press' | 'held' | 'release'): Promise<void> {
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.holdToRun.rws1 as PathSpec), `state=${action}`));
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
   *  /uas/grants and opmode lock-state are protocol-absent on RW6.16 (404).
   *  (Motion supervision is not: RWS 1.0 serves it at the motion-system root
   *  with ?mechunit=, see getMotionSupervision.)
   *  A missing msgtype reads as 0 = unknown, not info: RW6 could omit a
   *  parameter in this very response (ABB RobotWare release notes 6.15.04 §4
   *  Corrections, "RWS Elog Message Get missing response parameter"; a title
   *  only - which parameter, and that RW6 before 6.15.04 is the affected
   *  range, are inferred from the fix version; release notes, 2026-09-29).
   *
   *  A missing or too-large seqnum is NOT a 404 on RWS 1.0: it answers 200
   *  with the nearest LOWER existing message (seqnum 0 answers 204). Asking
   *  for 26 when only 25 and 27 exist returns the message titled
   *  `/rw/elog/0/25`; asking for 9999 returns the newest (live-verified
   *  2026-09-29 on RW 6.16.03, JSON and XHTML alike). So the entry's `_title`
   *  is compared with the requested seqnum, and a different message is null,
   *  never returned under the requested number. RW 7.21.4 and 8.2.1 answer a
   *  missing seqnum the same way (200, nearest older message; functional
   *  suite 04-elog, 2026-09-30), and RwsClient2 applies the same check.
   *
   *  The text fields (title, desc, causes, conseqs, actions) are
   *  entity-decoded (`&amp;` last). RW 6.16.03's `?json=1` single read carries
   *  XML entities in those JSON strings, e.g. `task&apos;s` in the desc of a
   *  task-started message, while the XHTML listing that getEventLog reads is
   *  decoded by its parser, so the same message read both ways differed
   *  (functional suite 04-elog, 2026-09-30). The RWS 1.0 module text-range
   *  JSON and the RWS 2.0 hal+json event-log strings carry entities the same
   *  way and are decoded too. */
  async getEventLogMessage(domain: number, seqnum: number, lang = 'en'): Promise<ElogMessage | null> {
    try {
      const r = await this.rws1Get(`${buildPath(CFG_ELOG_DIPC.getEventLogMessage.rws1 as PathSpec, { domain, seqnum })}?lang=${encodeURIComponent(lang)}`);
      const m = (r.states.find(s => (s as Record<string, string>)['_type'] === 'elog-message') ?? {}) as Record<string, string>;
      if (!m['code']) { return null; }
      const titled = /\/(\d+)\s*$/.exec(m['_title'] ?? '');
      if (titled && Number(titled[1]) !== seqnum) { return null; }
      const text = (v: unknown): string => decodeEntities(String(v ?? ''));
      return {
        seqnum, code: Number(m['code'] ?? 0), msgtype: elogMsgtype(m['msgtype']),
        timestamp: m['tstamp'] ?? '', srcName: m['src-name'] ?? '',
        title: m['title'] !== undefined ? text(m['title']) : `Event ${m['code']}`,
        desc: text(m['desc']), causes: text(m['causes']),
        consequences: text(m['conseqs']), actions: text(m['actions']),
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
   * getEventLog() defaults to domain 0, while the RobotWare 6.16 virtual controller exposes fourteen.
   * RobotWare 6 does not report per-domain counts (the RWS 2.0 listing carries
   * numevts and buffsize): RW 6.16.03's listing holds only the domain number
   * (`_title`) per entry (read 2026-10-13), so `events` and `bufferSize` are
   * null, "not reported", never 0. Read a domain to count its events.
   *
   * The domain listing arrives complete, with no `next` link (RW6.16,
   * 2026-08). A domain's message listing is paged; getEventLog follows it.
   */
  async listEventLogDomains(): Promise<Array<{ domain: number; events: number | null; bufferSize: number | null }>> {
    try {
      const r = await this.rws1Get(buildPath(CFG_ELOG_DIPC.listEventLogDomains.rws1 as PathSpec));
      return r.states
        .filter(s => (s as Record<string, string>)['_type'] === 'elog-domain-li')
        .map(s => {
          const d = s as Record<string, string>;
          return {
            domain: Number(d['_title'] ?? 0),
            events: countOrNull(d['numevts']),
            bufferSize: countOrNull(d['buffsize']),
          };
        });
    } catch { return []; }
  }

  /**
   * Structural change count of a task - name parity with the RWS 2.0 method.
   * RWS 1.0 reads it as `GET /rw/rapid/tasks/{task}?resource=task-struc-change-count`
   * (ABB's RWS 1.0 manual, Rev M), field `struc-change-count`; RW 6.16.03
   * answered it on 2026-10-09. The `/structural-changecount` sub-path RWS 2.0
   * uses answers 404 there. Returns 0 when the read fails.
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
   *  RWS 1.0 reads it as `?resource=activation-record&stackframe=1` on the
   *  task (Rev M; the old `/activation-record` sub-path answered 404 on
   *  RW 6.16.03, 2026-10-09). The controller answers 400 "No such stack
   *  frame" when the task is idle, read as no record.
   *
   * @experimental Built from the controller form; never run against an RWS 1.0 controller.
   */
  async getTaskActivationRecord(task: string): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(`${buildPath(RAPID.getTaskActivationRecord.rws1 as PathSpec, { task })}&stackframe=1`);
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

  /** Load a full RAPID program (.pgf) into a task: POST
   *  /rw/rapid/tasks/{task}/program?action=loadprog with progpath and loadmode
   *  {add | replace}, the fields of the RW 6.16.03 form and ABB's manual
   *  (Rev M). loadmode=add answered 204 on RW 6.16.03 (2026-10-09); it used to
   *  be accepted here and dropped, so 'add' replaced. */
  async loadProgram(task: string, progpath: string, loadmode: 'add' | 'replace' = 'replace'): Promise<void> {
    // Held under RAPID mastership, as a module load is ("Rapid Mastership
    // Required"); the program-load page itself names no mastership.
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.loadProgram.rws1 as PathSpec, { task }),
        `progpath=${encodeURIComponent(progpath)}&loadmode=${loadmode}`));
  }

  /**
   * Unload the program from a task, the counterpart of loadProgram: POST
   * `/rw/rapid/tasks/{task}/program?action=unloadprog` with no data, answered
   * 204 (ABB's RWS 1.0 manual, Rev M, "Unload program from a rapid task").
   * RW 6.16.03 serves the empty `unloadprog` form on `program?action=show`
   * (2026-10-09). Held under RAPID mastership, as loadProgram. RW 6.16.03
   * answered the client's unload 204 and kept its system modules (2026-10-21).
   */
  async unloadProgram(task: string): Promise<void> {
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.unloadProgram.rws1 as PathSpec, { task }), ''));
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
    const module = params.module;
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.setProgramPointer.rws1 as PathSpec, { task }),
        `module=${encodeURIComponent(module)}&routine=${encodeURIComponent(params.routine)}`));
  }

  /**
   * Single-step RAPID: ABB's RWS 1.0 start, `POST /rw/rapid/execution?action=start`,
   * with a step `execmode`. ABB's "Start RAPID Execution" page (RWS 1.0 Rev M)
   * lists six Required data params, among them
   * "execmode={continue | stepin | stepover | stepout | stepback | steplast | stepmotion}";
   * `into`, `over` and `out` send `stepin`, `stepover` and `stepout`, and
   * the other five go as `startRapid` sends them (`cycle=asis`). The `task`
   * argument is not sent: the start is global, as on RWS 2.0.
   *
   * Holds RAPID mastership around the request, like `startRapid`. ABB's
   * manual-mode rules for a step apply (manual mode, and RMMP `exec` for a
   * remote client); the controller decides.
   *
   * @experimental Built from ABB's RWS 1.0 page; no logged 2xx on an RWS 1.0 controller.
   * @throws RwsError `INVALID_ARGUMENT` before sending for a mode other than
   *   into, over or out; otherwise the controller's classified error.
   */
  async stepRapid(_task: string, mode: 'into' | 'over' | 'out'): Promise<void> {
    const execmode = mode === 'into' ? 'stepin' : mode === 'over' ? 'stepover' : mode === 'out' ? 'stepout' : null;
    if (!execmode) {
      throw new RwsError(`stepRapid: mode must be into, over or out, not ${String(mode)}`, 'INVALID_ARGUMENT');
    }
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.stepRapid.rws1 as PathSpec),
        `regain=continue&execmode=${execmode}&cycle=asis&condition=none&stopatbp=disabled&alltaskbytsp=false`));
  }

  async startProductionMode(): Promise<void> {
    // Live-verified 2026-08-04 on RW6.16: the action is `startprodentry` (204,
    // execution starts). The previously used `start-prod` answers 400 "Invalid
    // argument" - it never existed on this RobotWare. Held under RAPID
    // mastership, like startRapid.
    await this.access.withAccess(['rapid'], () =>
      this.rws1Post(buildPath(RAPID.startProductionEntry.rws1 as PathSpec), ''));
  }

  /** Canonical cross-protocol name for startProductionMode - same wire call.
   *  Matches RwsClient2.startProductionEntry (RWS 2.0 startprodentry).
   *
   * Run on RW 6.16.03 (2026-10-13): 2xx, execution running with the PP in main.
   */
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
   *  POST /rw/cfg?action=load, body filepath + action-type. Holds CFG
   *  mastership around the load (the load page names none; CFG is the domain
   *  RWS 1.0 arbitrates configuration writes through). */
  async loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset' = 'replace'): Promise<void> {
    await this.access.withAccess(['cfg'], () =>
      this.rws1Post(buildPath(CFG_ELOG_DIPC.loadCfgFile.rws1 as PathSpec),
        `filepath=${encodeURIComponent(filepath)}&action-type=${action}`));
  }

  /** Save a CFG domain to a file. POST /rw/cfg/{domain}?action=saveas, body
   *  filepath. The value must be a fileservice URI (bare '$TEMP/x' answers
   *  "invalid or read only"; '/fileservice/$TEMP/x' works - live round-tripped
   *  2026-08-04 on RW6.16: 204, file created and read back). Normalized here.
   *  Holds CFG mastership around the save: ABB's page says "CFG Mastership is
   *  handled internally if not explicit held by the client". */
  async saveCfgFile(domain: string, filepath: string): Promise<void> {
    const clean = filepath.replace(/^\/+/, '');
    const uri = clean.startsWith('fileservice/') ? `/${clean}` : `/fileservice/${clean}`;
    await this.access.withAccess(['cfg'], () =>
      this.rws1Post(buildPath(CFG_ELOG_DIPC.saveCfgFile.rws1 as PathSpec, { domain }),
        `filepath=${encodeURIComponent(uri)}`));
  }

  /** Set the active tool of a mechunit. Wire form live-verified 2026-08-04 on
   *  RW6.16: POST /rw/motionsystem/mechunits/{m}?action=set, body tool= - without
   *  mastership it answers the mastership 403, with motion mastership it applies.
   *  Holds motion mastership around the set; a motion hold this session
   *  already has is reused and not ended. */
  async setActiveTool(mechunit: string, toolName: string): Promise<void> {
    await this.access.withAccess(['motion'], async () => {
      await this.rws1Post(buildPath(MOTION.setActiveTool.rws1 as PathSpec, { mechunit }),
        `tool=${encodeURIComponent(toolName)}`);
    });
  }

  /** Set the active work object of a mechunit (same wire form as setActiveTool). */
  async setActiveWobj(mechunit: string, wobjName: string): Promise<void> {
    await this.access.withAccess(['motion'], async () => {
      await this.rws1Post(buildPath(MOTION.setActiveWobj.rws1 as PathSpec, { mechunit }),
        `wobj=${encodeURIComponent(wobjName)}`);
    });
  }

  async getNetworkConfig(): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getNetworkConfig.rws1 as PathSpec));
      return (r.state as Record<string, string>) ?? {};
    } catch { return {}; }
  }

  /**
   * The controller's DNS settings, GET /ctrl/network/dns. ABB's RWS 1.0
   * manual (Rev M) answers one `ctrl-netw-dns` entry per setting, named by
   * its title: `name` (the DNS name), `primaryns`, `secondaryns`,
   * `tertiaryns` and `quaternaryns` (name server addresses) and `port`.
   * The result keeps the first entry's fields, as before, and adds one key
   * per entry title with that entry's value, so every setting is in it:
   * `{ name: 'abc', primaryns: '5.5.5.5', ..., port: '53' }`. `{}` when the
   * controller refuses the read. ABB lists it for real controllers only.
   *
   * @experimental Built from the controller form; no logged 2xx on an RWS 1.0 controller.
   */
  async getDnsConfig(): Promise<Record<string, string>> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getDnsConfig.rws1 as PathSpec));
      return RWS1Adapter.dnsConfigFrom(r.states);
    } catch { return {}; }
  }

  /** Every `ctrl-netw-dns` entry folded into one map (see getDnsConfig). */
  private static dnsConfigFrom(states: Array<Record<string, unknown>>): Record<string, string> {
    const entries = states.filter(s => typeof s._type !== 'string' || s._type.startsWith('ctrl-netw'));
    const out: Record<string, string> = { ...((entries[0] ?? {}) as Record<string, string>) };
    for (const e of entries) {
      const title = e._title;
      if (typeof title !== 'string' || title === '') { continue; }
      const value = Object.entries(e).find(([k, v]) => !k.startsWith('_') && typeof v === 'string')?.[1];
      if (typeof value === 'string') { out[title] = value; }
    }
    return out;
  }

  /**
   * The routing table from `GET /ctrl/network/routes`, a path in no ABB
   * page: ABB's RWS 1.0 documents only adding and removing a route (not on a
   * virtual controller). `[]` when the controller refuses it.
   *
   * @experimental Not from ABB's documentation; never run against an RWS 1.0 controller.
   */
  async getRoutingTable(): Promise<Array<Record<string, string>>> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getRoutingTable.rws1 as PathSpec));
      return r.states as Array<Record<string, string>>;
    } catch { return []; }
  }

  /** @experimental Built from the controller form; never run against an RWS 1.0 controller. */
  async getTimezone(): Promise<{ tz: string; raw: Record<string, string> }> {
    try {
      const r = await this.rws1Get(buildPath(CTRL.getTimezone.rws1 as PathSpec));
      const s = (r.state as Record<string, string>) ?? {};
      return { tz: s.timezone ?? '', raw: s };
    } catch { return { tz: '', raw: {} }; }
  }

  /**
   * Whether the controller hardware can run a RobotWare version: ABB's RWS
   * 1.0 "Check Robotware version compatibility with controller hardware"
   * (Rev M), `GET /ctrl/compatibility/{robotware version}`, answered with one
   * `ctrl-compatibility` entry whose `status` is `true` or `false`. ABB lists
   * it for real controllers only; the virtual controllers answer 404.
   *
   * @param robotWareVersion the version to check, as ABB's example writes it
   *   (`6.03.0101`). Without it, the version the controller runs: one read
   *   of `GET /rw/system` first, whose `rwversion` (for example `6.16.3007`)
   *   is sent as the controller wrote it.
   * @throws RwsError `INVALID_ARGUMENT` for an empty version, before
   *   sending; the controller's typed error when it refuses the read (never
   *   `compatible: false`); `PARSE_ERROR` when the answer has no
   *   `ctrl-compatibility` status of true or false, or, without a version,
   *   when `/rw/system` names no RobotWare version.
   * @experimental Built from ABB's RWS 1.0 page; never run against an RWS 1.0 controller.
   */
  async getCompatibility(robotWareVersion?: string): Promise<RobotWareCompatibility> {
    const version = await compatibilityVersion(robotWareVersion,
      async () => (await this.getSystemInfo()).rwVersion, 'RWS1 getCompatibility');
    const p = await this.rws1Doc(buildPath(CTRL.getCompatibility.rws1 as PathSpec, { version }));
    return compatibilityFrom(p.getAllEntries(), `RWS1 getCompatibility(${version})`);
  }

  // ── Stage 14: Set mechunit / robtarget for jogging (2 methods) ────────

  /**
   * Select the mechanical unit that jogging acts on: POST
   * `/rw/motionsystem?action=set-mechunit` with `mechunit-name`, the field the
   * form RW 6.16.03 serves on `/rw/motionsystem?action=show` names (read
   * 2026-09-29). This method used to send `mechunit`, which is not a field of
   * that form.
   *
   * Holds motion mastership around the write (ABB's RWS 2.0 page for the same
   * operation asks for mastership; the stricter reading is taken here). Inside
   * `RobotManager.jog` the jog's own motion hold covers it and nothing more is
   * requested. Run live only as a selection of the unit already selected:
   * RW 6.16.03 accepted `ROB_1` in Auto, and `mechunit-name` read `ROB_1`
   * before and after (2026-10-01).
   *
   * @throws RwsError `INVALID_ARGUMENT` before sending for a name that is not
   *   a RAPID name (`jogUnitName`); otherwise the controller's classified error.
   */
  async setMechunitForJogging(mechunit: string): Promise<void> {
    const unit = jogUnitName(mechunit, 'setMechunitForJogging');
    await this.access.withAccess(['motion'], () =>
      this.rws1Post(buildPath(MOTION.setMechunitForJogging.rws1 as PathSpec), `mechunit-name=${encodeURIComponent(unit)}`));
  }

  /**
   * Set the position target jogging moves to: POST
   * `/rw/motionsystem?action=positiontarget` with the 17 fields of the form RW
   * 6.16.03 serves (`?action=show`, read 2026-09-29): position, quaternion,
   * robot configuration and six external joints, the same set as the RWS 2.0
   * position-target form. This used to send `?action=set-target` with
   * `x..q4`, an action and field names no ABB document or form has (spec
   * check 2026-10-07). Run live on RW 6.16.03 (2026-10-09).
   *
   * @param target position in mm, orientation as a quaternion, the RAPID
   *   `robconf` (cf1, cf4, cf6, cfx) and, optionally, the six external axes
   *   `eax`; an omitted or missing axis is sent as 9E9, RAPID's "no axis"
   *   value (`JOINT_NOT_PRESENT`). The configuration is required: there is no
   *   "unused" configuration, so none is invented.
   * @throws RwsError `INVALID_ARGUMENT` before sending when a position,
   *   orientation or configuration field is not a finite number.
   */
  async setRobtargetForJogging(target: Omit<TaskRobTarget, 'eax'> & { eax?: TaskRobTarget['eax'] }): Promise<void> {
    const t = target as Partial<TaskRobTarget>;
    const num = (name: string, v: number | undefined): string => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new RwsError(`RWS1 setRobtargetForJogging: ${name} must be a finite number (got ${String(v)}); the position, quaternion and robconf (cf1, cf4, cf6, cfx) are all needed`, 'INVALID_ARGUMENT');
      }
      return String(v);
    };
    const ext = (i: number): string => {
      const v = t.eax?.[i];
      return typeof v === 'number' && Number.isFinite(v) ? String(v) : String(JOINT_NOT_PRESENT);
    };
    const body = [
      `pos-x=${num('x', t.x)}`, `pos-y=${num('y', t.y)}`, `pos-z=${num('z', t.z)}`,
      `orient-q1=${num('q1', t.q1)}`, `orient-q2=${num('q2', t.q2)}`, `orient-q3=${num('q3', t.q3)}`, `orient-q4=${num('q4', t.q4)}`,
      `config-j1=${num('cf1', t.cf1)}`, `config-j4=${num('cf4', t.cf4)}`, `config-j6=${num('cf6', t.cf6)}`, `config-jx=${num('cfx', t.cfx)}`,
      ...[0, 1, 2, 3, 4, 5].map(i => `extjoint-${i + 1}=${ext(i)}`),
    ].join('&');
    // Motion mastership: ABB's page asks for mastership, and RW 6.16.03 refused
    // the post 403 -1073445859 without it and answered 204 with it (2026-10-09).
    await this.access.withAccess(['motion'], () =>
      this.rws1Post(buildPath(MOTION.setRobtargetForJogging.rws1 as PathSpec), body));
  }

  // ── Inverse kinematics ──────────────────────────────────────────────────

  /**
   * Inverse kinematics on RWS 1.0 (`?action=CalcJointsFromPose`): the joint
   * angles that put tool0 (the flange) at `pos`, the solution nearest the
   * seed joints (all zero when none are given).
   *
   * The action works in SI units: it takes `curr_position` in metres and
   * `old_rob_joints` in radians, and answers `robotjoint1..6` in radians. This
   * method converts, so it takes millimetres and degrees and returns degrees,
   * the units of the cartesian and jointtarget reads. The tool frame is sent
   * as the identity, so `pos` is the tool0 pose; external axes are sent as
   * absent (9E9). Unlike forward kinematics, nothing here names a tool or
   * work object to refuse: a pose read with another tool or work object
   * solves as the flange at that point, with no error (see the
   * `IRWSAdapter` doc for a tool0/wobj0 read).
   *
   * Live-verified 2026-09-30 on RW 6.16.03 (virtual controller): the current
   * pose (806.2917, 0, 929 mm; q 0.5, 0, 0.8660254, 0) with the current
   * joints as the seed solves to those joints (0, 0, 0, 0, 30, 0 degrees).
   * The same request in millimetres and degrees answers 400 -1073436654
   * "Position outside of reach", which is what every call of this method got
   * while it sent those units; that was not a virtual-controller limit. A pose
   * really out of reach is `INVALID_ARGUMENT` with an `invalid-argument`
   * refusal. The `wobj_frame_*` fields this method used to send are not in
   * ABB's field list and made no difference to the answer, so they are no
   * longer sent.
   */
  async calcJointsFromCartesian(
    pos: RobTarget,
    seedJoints?: JointTarget,
    mechunit = 'ROB_1',
  ): Promise<JointTarget> {
    if (!this.creds) {
      throw new RwsError('IK requires credentials - reconnect to enable', 'INVALID_ARGUMENT');
    }
    const seed = seedJoints ? jointsInRadians(seedJoints) : '0,0,0,0,0,0';

    const bodyStr = [
      `curr_position=[${plainNumber(pos.x / 1000)},${plainNumber(pos.y / 1000)},${plainNumber(pos.z / 1000)}]`,
      `curr_orientation=[${[pos.q1, pos.q2, pos.q3, pos.q4].map(plainNumber).join(',')}]`,
      `curr_ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]`,
      `old_rob_joints=[${seed}]`,
      `old_ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]`,
      `robot_fixed_object=FALSE`,
      `tool_frame_position=[0,0,0]`,
      `tool_frame_orientation=[1,0,0,0]`,
      `robot_configuration=[0,0,0,0]`,
      `elog_at_error=FALSE`,
    ].join('&');

    const path = buildPath(MOTION.calcJointsFromCartesian.rws1 as PathSpec, { mechunit });
    const state = firstJsonState(await this.rws1Post(path, bodyStr));
    if (!state) { throw new RwsError('IK: no result in response', 'PARSE_ERROR'); }
    // Radians to degrees, rounded to 1e-6 degree (finer than the answer's
    // own precision) so the product carries no binary noise.
    const deg = (i: number): number => roundMicro(numField(state, `robotjoint${i}`) * DEG_PER_RAD);
    const joints: JointTarget = {
      rax_1: deg(1), rax_2: deg(2), rax_3: deg(3), rax_4: deg(4), rax_5: deg(5), rax_6: deg(6),
    };
    if (Object.values(joints).some(v => !Number.isFinite(v))) {
      throw new RwsError('IK: the answer has no robotjoint1..6 values', 'PARSE_ERROR');
    }
    return joints;
  }
}

// ── Kinematics helpers (RWS 1.0) ─────────────────────────────────────────────

const DEG_PER_RAD = 180 / Math.PI;

/**
 * A number as a plain decimal with at most 9 decimals, never in exponent
 * form: kinematics bodies carry metres, radians and quaternions, where 9
 * decimals is a nanometre and a nanoradian.
 */
function plainNumber(v: number): string {
  const s = v.toFixed(9).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** `v` rounded to 6 decimals; NaN and infinities pass through, -0 becomes 0. */
function roundMicro(v: number): number {
  if (!Number.isFinite(v)) { return v; }
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

/** Six joint angles in degrees as the radians list a kinematics body carries. */
function jointsInRadians(j: JointTarget): string {
  return [j.rax_1, j.rax_2, j.rax_3, j.rax_4, j.rax_5, j.rax_6].map(d => plainNumber(d / DEG_PER_RAD)).join(',');
}

/**
 * The next page of a paged RWS 1.0 `?json=1` listing, as a path for `rws1Get`
 * (no `json=1`), or '' when there is none. The `next` link is relative to the
 * answer's `_links.base.href`; a link that resolves off the listing's own
 * resource is not followed.
 */
function nextPagePath(raw: unknown, listing: string): string {
  const links = (raw as { _links?: { base?: { href?: string }; next?: { href?: string } } } | null)?._links;
  const next = links?.next?.href;
  if (!next) { return ''; }
  let u: URL;
  try { u = new URL(next.replace(/&amp;/g, '&'), links?.base?.href ?? 'http://controller/'); } catch { return ''; }
  if (u.pathname !== listing.split('?')[0]) { return ''; }
  u.searchParams.delete('json');
  const q = u.searchParams.toString();
  return q ? `${u.pathname}?${q}` : u.pathname;
}

/** Refuse a source position before sending: a module name, a row from 1 and a column from 0, whole numbers. */
/**
 * The routine whose body holds a 1-based row of RAPID module text: the last
 * PROC / FUNC / TRAP header at or above the row whose END line comes after
 * it. Null when the row is outside every routine (declarations, the module
 * header).
 */
export function enclosingRoutine(text: string, row: number): string | null {
  let current: string | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < Math.min(row, lines.length); i++) {
    const line = lines[i].replace(/!.*$/, '');
    const head = /^\s*(?:LOCAL\s+)?(?:PROC|TRAP|FUNC\s+\w+)\s+(\w+)/i.exec(line);
    if (head) { current = head[1]; continue; }
    if (/^\s*END(?:PROC|FUNC|TRAP)\b/i.test(line)) { current = i + 1 === row ? current : null; }
  }
  return current;
}

function checkSourcePosition(op: string, module: string, row: number, col: number): void {
  if (!module) {
    throw new RwsError(`${op}: a module name is required`, 'INVALID_ARGUMENT');
  }
  if (!Number.isInteger(row) || row < 1 || !Number.isInteger(col) || col < 0) {
    throw new RwsError(`${op}: row ${row} / column ${col} is not a source position (whole numbers, row from 1)`, 'INVALID_ARGUMENT');
  }
}

/** The first entry of an RWS 1.0 `?json=1` answer: `_embedded._state[0]`, or a top-level `state[0]`. */
function firstJsonState(result: unknown): Record<string, unknown> | null {
  const r = result as { _embedded?: { _state?: Array<Record<string, unknown>> }; state?: Array<Record<string, unknown>> } | null;
  return r?._embedded?._state?.[0] ?? r?.state?.[0] ?? null;
}

/** The first of `keys` present in `s` as a number (RWS 1.0 sends numbers as strings); NaN when none is. */
function numField(s: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = s[k];
    if (typeof v === 'number') { return v; }
    if (typeof v === 'string' && v.trim() !== '') { return Number(v); }
  }
  return NaN;
}
