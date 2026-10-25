/**
 * RwsClient - the single public class for the abb-rws-client package.
 *
 * Assembles HttpSession, ResourceMapper, ResponseParser, and WsSubscriber into
 * a convenient typed API for ABB IRC5 robot controllers using RWS 1.0.
 *
 * Compatible with RobotWare 6.x only. NOT compatible with RWS 2.0 / RobotWare 7.x / OmniCore.
 *
 * @example
 * ```ts
 * const client = new RwsClient({ host: '127.0.0.1' });
 * await client.connect();
 * const state = await client.getControllerState();
 * await client.disconnect();
 * ```
 */

import { HttpSession } from './HttpSession.js';
import type { HttpSessionOptions } from './HttpSession.js';
import { WsSubscriber } from './WsSubscriber.js';
import type { WsSubscribeOptions } from './WsSubscriber.js';
import { AccessManager, bindAccess, type AccessGeneration, type AccessLock } from './access/AccessManager.js';
import { RwsError } from './types.js';
import type {
  RwsClientOptions,
  ControllerState,
  OperationMode,
  ExecutionState,
  ExecutionInfo,
  ExecutionCycle,
  JointTarget,
  JointTargetFull,
  RobTarget,
  CartesianFull,
  Signal,
  RapidTask,
  IoNetwork,
  IoDevice,
  SystemInfo,
  ControllerIdentity,
  ElogMessage,
  FileEntry,
  MastershipDomain,
  CollisionDetectionState,
  RapidSymbolProperties,
  ControllerClock,
  UiInstruction,
  RapidSymbolInfo,
  RapidSymbolSearchParams,
  RestartMode,
  AnySubscriptionResource,
  SubscriptionEvent,
} from './types.js';
import {
  controllerState as pathControllerState,
  setControllerState as mapSetControllerState,
  operationMode as pathOperationMode,
  speedRatio as pathSpeedRatio,
  setSpeedRatio as mapSetSpeedRatio,
  collisionDetectionState as pathCollisionDetectionState,
  restartController as mapRestartController,
  lockOperationMode as mapLockOperationMode,
  unlockOperationMode as mapUnlockOperationMode,
  rapidTasks as pathRapidTasks,
  rapidExecutionState as pathRapidExecutionState,
  startRapid as mapStartRapid,
  stopRapid as mapStopRapid,
  resetRapid as mapResetRapid,
  setExecutionCycle as mapSetExecutionCycle,
  rapidSymbol as pathRapidSymbol,
  rapidSymbolProperties as pathRapidSymbolProperties,
  setRapidSymbol as mapSetRapidSymbol,
  activeUiInstruction as pathActiveUiInstruction,
  setUiInstructionParam as mapSetUiInstructionParam,
  activateRapidTask as mapActivateRapidTask,
  deactivateRapidTask as mapDeactivateRapidTask,
  activateAllRapidTasks as mapActivateAllRapidTasks,
  deactivateAllRapidTasks as mapDeactivateAllRapidTasks,
  searchRapidSymbols as mapSearchRapidSymbols,
  validateRapidValue as mapValidateRapidValue,
  jointTarget as pathJointTarget,
  robTarget as pathRobTarget,
  cartesianFull as pathCartesianFull,
  loadModule as mapLoadModule,
  listModules as pathListModules,
  uploadFile as pathUploadFile,
  allSignals as pathAllSignals,
  networks as pathNetworks,
  devices as pathDevices,
  signal as pathSignal,
  setSignal as mapSetSignal,
  systemInfo as pathSystemInfo,
  controllerIdentity as pathControllerIdentity,
  clockInfo as pathClockInfo,
  setControllerClock as mapSetControllerClock,
  elogMessages as pathElogMessages,
  clearElogDomain as mapClearElogDomain,
  clearAllElogs as mapClearAllElogs,
  fileServicePath,
  deleteFile as pathDeleteFile,
  copyFile as mapCopyFile,
  renameFile as mapRenameFile,
  searchSignals as mapSearchSignals,
  requestMastership as mapRequestMastership,
  releaseMastership as mapReleaseMastership,
} from './ResourceMapper.js';
import {
  parseControllerState,
  parseOperationMode,
  parseSpeedRatio,
  parseExecutionState,
  parseExecutionInfo,
  parseJointTarget,
  parseJointTargetFull,
  parseRobTarget,
  parseCartesianFull,
  parseRapidSymbolValue,
  parseRapidSymbolProperties,
  parseSignal,
  parseSignalList,
  parseNetworks,
  parseDevices,
  parseRapidTasks,
  parseSystemInfo,
  parseControllerIdentity,
  parseControllerClock,
  parseActiveUiInstruction,
  parseRapidSymbolSearch,
  parseElogMessages,
  parseDirectory,
  parseCollisionDetectionState,
} from './ResponseParser.js';
import { RAPID, MOTION } from './paths/index.js';
import { buildPath, type PathSpec } from './paths/PathSpec.js';
import { nextPagePath, readPages } from './commonReads.js';
import { Logger } from './Logger.js';

/** Most event-log pages `getEventLog` reads by default: 20 pages of 50, as on RWS 2.0. */
const ELOG_MAX_PAGES = 20;

export class RwsClient {
  private readonly session: HttpSession;
  private readonly subscriber: WsSubscriber;
  /** listAllSignals has logged a page that ended its walk although more may follow (logged once per client). */
  private signalWalkNoted = false;

  /**
   * The one place this session's mastership is requested and released:
   * reference counts per domain (RobotWare 6 arbitrates cfg, motion and rapid
   * separately), and one write at a time. See AccessManager.
   */
  private readonly access = new AccessManager({
    label: 'RWS1',
    locks: (): readonly AccessLock[] => ['cfg', 'motion', 'rapid'],
    lockOf: (d): AccessLock => d,
    domainOf: (l): MastershipDomain => (l === 'cfg' || l === 'motion' ? l : 'rapid'),
    request: (_l, d): Promise<void> => this.wireRequestMastership(d),
    release: (_l, d): Promise<void> => this.wireReleaseMastership(d),
    generation: (): AccessGeneration => 'rw6',
  });

  constructor(options: RwsClientOptions) {
    const sessionOptions: HttpSessionOptions = {
      baseUrl: `http://${options.host}:${options.port ?? 80}`,
      username: options.username ?? 'Admin',
      password: options.password ?? 'robotics',
      requestIntervalMs: options.requestIntervalMs ?? 100,
      timeoutMs: options.timeout ?? 5000,
      sessionCookie: options.sessionCookie,
      // A new controller session holds nothing: mastership counted on the old
      // one is recorded as lost, and the next write requests it afresh.
      onSessionReplaced: () => { this.access.sessionEnded('session-reissued'); },
      // What the session's owner knows (mode, controller state, RMMP), to
      // explain a refusal in plain words.
      refusalContext: () => this.access.refusalContext(),
    };
    this.session = new HttpSession(sessionOptions);
    this.subscriber = new WsSubscriber(this.session, options.host, options.port ?? 80);
    bindAccess(this, this.access);
  }

  /** Returns the current -http-session- cookie so callers can persist and reuse it */
  getSessionCookie(): string | null {
    return this.session.getSessionCookie();
  }

  /**
   * Generic HTTP request helper exposing the underlying authenticated session.
   *
   * Lets adapters call any RWS endpoint without requiring this library to wrap
   * each one in a typed method. Useful for endpoints that aren't (yet) exposed
   * as named methods - the caller handles parsing the response body.
   *
   * Reuses the session's digest auth, cookie, queue, retry, and timeout logic.
   *
   * @param method   'GET' | 'POST' | 'PUT' | 'DELETE'
   * @param path     URL path, e.g. `/rw/cfg/MOC/ROBOT/instances?json=1`
   * @param body     Optional request body (form-encoded string for POST/PUT)
   * @param options  `holdMs`: how long the controller may hold this request
   *                 open on purpose before it answers (a DIPC read's wait).
   *                 This one request's timeout is extended by it. Requests
   *                 run one at a time, so later requests on this client wait
   *                 behind a held one.
   * @returns        `{ status: number, body: string, headers }` - raw response;
   *                 `headers` carries, for example, the `Location` of a 202 job
   */
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: string,
    options: { holdMs?: number } = {},
  ): Promise<{ status: number; body: string; headers?: Headers }> {
    const hold = options.holdMs ?? 0;
    let res;
    if (method === 'GET')         { res = await this.session.get(path, hold); }
    else if (method === 'POST')   { res = await this.session.post(path, body ?? '', hold); }
    else if (method === 'PUT')    { res = await this.session.put(path, body ?? '', hold); }
    else                          { res = await this.session.delete(path, hold); }
    return { status: res.status, body: res.body, headers: res.headers };
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Establish a session with the controller.
   * Triggers digest authentication and verifies connectivity by reading controller state.
   * Must be called before any other method.
   *
   * @throws {RwsError} code='NETWORK_ERROR' if the controller is unreachable
   * @throws {RwsError} code='AUTH_FAILED' if credentials are incorrect
   */
  async connect(): Promise<void> {
    this.session.reopen();
    try {
      const { body } = await this.session.get(pathControllerState());
      parseControllerState(body); // validate response is parseable
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`Failed to connect: ${String(e)}`, 'NETWORK_ERROR');
    }
  }

  /**
   * Disconnect from the controller.
   * Closes all WebSocket subscriptions and clears the session.
   */
  async disconnect(): Promise<void> {
    try {
      await this.subscriber.closeAll();
    } catch { /* ignore */ }
    // Server-side cleanup: GET /logout releases mastership, subscriptions, and frees
    // the session slot in the controller's pool. Without this, orphan mastership can
    // block subsequent clients for several minutes (until the controller times out
    // the session by inactivity). Best-effort - ignore errors.
    //
    // /logout is queued and the session closed in the same tick: requests queued
    // earlier go out first, on this session; later ones are refused with
    // NOT_CONNECTED instead of signing in a session nobody would log out. A
    // second disconnect() sends nothing.
    if (!this.session.isClosed) {
      const loggedOut = this.session.get('/logout');
      this.session.close();
      try { await loggedOut; } catch { /* ignore */ }
    }
    this.session.clearSession();
    // Every hold belonged to the session that just ended.
    this.access.sessionEnded('disconnect');
  }

  // ─── Controller state ───────────────────────────────────────────────────────

  /**
   * Read the current controller state.
   *
   * @returns 'motoron' | 'motoroff' | 'init' | 'guardstop' | 'emergencystop' |
   *          'emergencystopreset' | 'sysfail'
   * @throws {RwsError} code='PARSE_ERROR' on unexpected response format
   */
  async getControllerState(): Promise<ControllerState> {
    try {
      const { body } = await this.session.get(pathControllerState());
      return parseControllerState(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getControllerState failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Set the controller motor state. Sent as is: this method takes no mastership.
   * Remote motors on is an AUTO-mode operation; in manual mode the motors are
   * switched on with the enabling device on the FlexPendant. ABB's RWS 1.0
   * reference states no mastership prerequisite for this resource, and whether
   * the controller enforces one has not been established. A refusal for missing
   * mastership classifies as MASTERSHIP_REQUIRED. `RobotManager.setMotorsOff`
   * sends 'motoroff' first and takes mastership only when the controller refuses
   * it as not held.
   *
   * @param state - 'motoron' | 'motoroff'
   * @throws {RwsError} with the controller's classified code when refused
   */
  async setControllerState(state: 'motoron' | 'motoroff'): Promise<void> {
    try {
      const { path, body } = mapSetControllerState(state);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`setControllerState failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read the current operation mode.
   *
   * @returns 'AUTO' | 'MANR' | 'MANF'
   * @throws {RwsError} code='PARSE_ERROR' on unexpected response format
   */
  async getOperationMode(): Promise<OperationMode> {
    try {
      const { body } = await this.session.get(pathOperationMode());
      return parseOperationMode(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getOperationMode failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read the collision detection state.
   * Returns INIT (no collision), TRIGGERED, CONFIRMED, or TRIGGERED_ACK.
   * Requires the Collision Detection option on the controller.
   */
  async getCollisionDetectionState(): Promise<CollisionDetectionState> {
    try {
      const { body } = await this.session.get(pathCollisionDetectionState());
      return parseCollisionDetectionState(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getCollisionDetectionState failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Restart (or warm-start) the controller.
   *
   * **Modes:**
   * - `restart`  - Normal restart; saves state and activates changed system parameters
   * - `istart`   - Restart with original installation settings; discards all programs
   * - `pstart`   - Restart preserving system parameters; removes programs
   * - `bstart`   - Boot with last auto-saved state (crash recovery)
   *
   * @param mode - Restart mode; default 'restart'
   */
  async restartController(mode: RestartMode = 'restart'): Promise<void> {
    // 'shutdown' and 'xstart' exist only on the RWS 2.0 restart form; the RWS 1.0
    // panel form advertises restart/istart/pstart/bstart (live-verified 2026-08).
    if (mode === 'shutdown' || mode === 'xstart') {
      throw new RwsError(
        `restartController: '${mode}' is a RobotWare 7/8 (RWS 2.0) restart mode and is not available on this IRC5 controller`,
        'UNSUPPORTED_OPERATION',
      );
    }
    try {
      const { path, body } = mapRestartController(mode);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`restartController failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Lock the operating-mode selection with a PIN.
   * @param pin       - 4-digit PIN code
   * @param permanent - true = permanent lock; false = temporary
   *
   * @experimental Sent to RW 6.16.03 (2026-10-13) and refused 403 -1073445867 "The required option is missing": the controller lacks an option the lock needs. ABB's RWS 1.0 page names two UAS grants for the lock and no option. No 2xx logged on RWS 1.0.
   */
  async lockOperationMode(pin: string, permanent = false): Promise<void> {
    try {
      const { path, body } = mapLockOperationMode(pin, permanent);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`lockOperationMode failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /** Unlock the operating-mode selection with the PIN the lock set (the RW
   *  6.16.03 form's one field; it used to post an empty body). Without a PIN
   *  `RwsError` `INVALID_ARGUMENT` is thrown before anything is sent.
   *
   * @experimental Sent to RW 6.16.03 (2026-10-13) and refused as the lock was (403 -1073445867, option missing). No 2xx logged on RWS 1.0.
   */
  async unlockOperationMode(pin?: string): Promise<void> {
    if (typeof pin !== 'string' || pin.trim() === '') {
      throw new RwsError('RWS1 unlockOperationMode: the PIN the lock set is needed (the controller form requires pin)', 'INVALID_ARGUMENT');
    }
    try {
      const { path, body } = mapUnlockOperationMode(pin);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`unlockOperationMode failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Switch the controller's operation mode: not possible over RWS 1.0, so this
   * is refused before anything is sent. ABB's RWS 1.0 manual (Rev M) has no
   * operating-mode change (only get, acknowledge, lock and unlock), the
   * RW 6.16.03 opmode form offers only lock, unlock and acknowledge, and
   * `POST /rw/panel/opmode` with `opmode=` answered 400 "NO/Invalid action
   * parameter" on the RW 6.16.03 VC, as did `?action=setopmode` and
   * `?action=set` (2026-10-09). On an IRC5 the mode is changed with the key
   * switch at the controller or in RobotStudio's control panel.
   * @throws RwsError `UNSUPPORTED_OPERATION`, always: there is no such write on RWS 1.0.
   */
  async setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void> {
    throw new RwsError(
      `setOperationMode('${mode}') was not sent: RWS 1.0 (IRC5) has no remote operating-mode change. Change the mode with the key switch at the controller (or the mode selector in RobotStudio's control panel for a virtual controller).`,
      'UNSUPPORTED_OPERATION',
    );
  }

  // ─── Speed ratio ────────────────────────────────────────────────────────────

  /**
   * Read the current speed ratio (0-100).
   * Represents override percentage applied to all robot speeds.
   */
  async getSpeedRatio(): Promise<number> {
    try {
      const { body } = await this.session.get(pathSpeedRatio());
      return parseSpeedRatio(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getSpeedRatio failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Set the speed ratio override (0-100). Only valid in AUTO mode.
   * @param ratio - Integer 0-100 (clamped automatically)
   */
  async setSpeedRatio(ratio: number): Promise<void> {
    try {
      const { path, body } = mapSetSpeedRatio(ratio);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`setSpeedRatio failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── RAPID execution ────────────────────────────────────────────────────────

  /**
   * Read the current RAPID execution state.
   *
   * @returns 'running' | 'stopped'
   */
  async getRapidExecutionState(): Promise<ExecutionState> {
    try {
      const { body } = await this.session.get(pathRapidExecutionState());
      return parseExecutionState(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getRapidExecutionState failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read the full RAPID execution info including state and current cycle mode.
   *
   * @returns ExecutionInfo with state ('running'|'stopped') and cycle ('once'|'forever'|'asis'|'oncedone')
   */
  async getRapidExecutionInfo(): Promise<ExecutionInfo> {
    try {
      const { body } = await this.session.get(pathRapidExecutionState());
      return parseExecutionInfo(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getRapidExecutionInfo failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Retrieve all RAPID tasks and their current states.
   *
   * @returns Array of RapidTask objects
   */
  async getRapidTasks(): Promise<RapidTask[]> {
    try {
      const { body } = await this.session.get(pathRapidTasks());
      return parseRapidTasks(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getRapidTasks failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Start RAPID program execution.
   * The controller must be in AUTO mode with motors on.
   *
   * @throws {RwsError} code='MOTORS_OFF' if motors are not on
   * @throws {RwsError} code='CONTROLLER_BUSY' if the controller is already busy
   */
  async startRapid(): Promise<void> {
    try {
      const { path, body } = mapStartRapid();
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) {
        // Map 400 "motors off" to a more descriptive code
        if (e.httpStatus === 400 && e.rwsDetail?.includes('motor')) {
          throw new RwsError('Motors are off - enable motors before starting RAPID', 'MOTORS_OFF', e.httpStatus, e.rwsDetail);
        }
        throw e;
      }
      throw new RwsError(`startRapid failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Stop RAPID program execution. Sent at once, with no mastership taken first:
   * a stop must never wait for access. ABB's RWS 1.0 stop page states no
   * mastership prerequisite. A stop over RWS is a program stop, not a safety
   * stop; use the emergency stop for safety.
   */
  async stopRapid(): Promise<void> {
    try {
      const { path, body } = mapStopRapid();
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`stopRapid failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Reset the RAPID program pointer to main.
   * RAPID must be stopped before calling this.
   */
  async resetRapid(): Promise<void> {
    try {
      const { path, body } = mapResetRapid();
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`resetRapid failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Set the RAPID execution cycle mode.
   * @param cycle - 'once' (run once then stop) | 'forever' (loop) | 'asis' (keep current)
   */
  async setExecutionCycle(cycle: ExecutionCycle): Promise<void> {
    try {
      const { path, body } = mapSetExecutionCycle(cycle);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`setExecutionCycle failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── RAPID variables ────────────────────────────────────────────────────────

  /**
   * Read the value of a RAPID symbol (variable, persistent, or constant).
   * Returns the raw string as the controller formats it (e.g. '42', '"hello"', '[1,2,3]').
   *
   * @param taskName   - RAPID task name, e.g. 'T_ROB1'
   * @param moduleName - Module name, e.g. 'user'
   * @param symbolName - Symbol name, e.g. 'reg1'
   */
  async getRapidVariable(taskName: string, moduleName: string, symbolName: string): Promise<string> {
    try {
      const { body } = await this.session.get(pathRapidSymbol(taskName, moduleName, symbolName));
      return parseRapidSymbolValue(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getRapidVariable failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Write a value to a RAPID variable or persistent.
   * Value must be a RAPID-formatted string: e.g. '42', '3.14', '"hello"', '[1,0,0,0]'.
   *
   * @param taskName   - RAPID task name
   * @param moduleName - Module name
   * @param symbolName - Symbol name
   * @param value      - New value in RAPID syntax
   */
  async setRapidVariable(taskName: string, moduleName: string, symbolName: string, value: string): Promise<void> {
    try {
      const { path, body } = mapSetRapidSymbol(taskName, moduleName, symbolName, value);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`setRapidVariable failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Activate a RAPID task (for multitasking systems).
   * Mastership is taken internally by the controller.
   * @param task - Task name, e.g. 'T_ROB2'
   */
  async activateRapidTask(task: string): Promise<void> {
    try {
      const { path, body } = mapActivateRapidTask(task);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`activateRapidTask failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Deactivate a RAPID task (for multitasking systems).
   * @param task - Task name
   */
  async deactivateRapidTask(task: string): Promise<void> {
    try {
      const { path, body } = mapDeactivateRapidTask(task);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`deactivateRapidTask failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /** Activate ALL RAPID tasks. */
  async activateAllRapidTasks(): Promise<void> {
    try {
      const { path, body } = mapActivateAllRapidTasks();
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`activateAllRapidTasks failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /** Deactivate ALL RAPID tasks. */
  async deactivateAllRapidTasks(): Promise<void> {
    try {
      const { path, body } = mapDeactivateAllRapidTasks();
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`deactivateAllRapidTasks failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Get the currently active RAPID UI instruction.
   * Returns null if no UI instruction is waiting for input.
   * Used to detect when RAPID is waiting for operator input (TPReadNum, TPReadFK, etc.).
   *
   * Run on RW 6.16.03 (2026-10-13): it answered while a TPReadNum waited.
   */
  async getActiveUiInstruction(): Promise<UiInstruction | null> {
    try {
      const { body } = await this.session.get(pathActiveUiInstruction());
      return parseActiveUiInstruction(body);
    } catch (e) {
      // The common idle case - no UI instruction waiting - answers HTTP 404 on
      // IRC5, which the session surfaces as RESOURCE_NOT_FOUND. That is the
      // documented "returns null" state, not an error: a caller polling for
      // TPReadNum/TPReadFK prompts must not have to try/catch every idle poll.
      if (e instanceof RwsError && (e.httpStatus === 404 || e.code === 'RESOURCE_NOT_FOUND')) {
        return null;
      }
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getActiveUiInstruction failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Respond to an active RAPID UI instruction (e.g. send the answer to a TPReadNum).
   * Get the stackurl from getActiveUiInstruction().stack.
   *
   * The parameters are the instruction's own. The controller lists them live at
   * `GET /rw/rapid/uiinstr/active/params/{stackurl}` (class `rap-uiparams-li`,
   * one entry per parameter); read that list first when the instruction is not
   * one of those below. A name the instruction does not have is refused 400
   * -1073445879 "Invalid parameter".
   *
   * TPReadNum on RW 6.16.03 (2026-10-13): the list read `TPAnswer` and
   * `TPText`; `TPAnswer` = '7' then `TPCompleted` = 'TRUE' answered 2xx and
   * the RAPID variable read 7. `Result` was refused 400 -1073445879.
   *
   * @param stackurl - Stack URL from UiInstruction.stack (e.g. 'RAPID/T_ROB1/%$104'),
   *   sent percent-encoded (the encoded stack answered 2xx on RW 6.16.03)
   * @param uiparam  - Parameter name, e.g. 'TPAnswer' or 'TPCompleted'
   * @param value    - Value to set, e.g. '7' or 'TRUE'
   */
  async setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void> {
    try {
      const { path, body } = mapSetUiInstructionParam(stackurl, uiparam, value);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`setUiInstructionParam failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Search for RAPID symbols matching filter criteria.
   *
   * @param params - Search parameters (task is required; all others are optional filters)
   * @returns Array of matching symbols with abbreviated properties
   *
   * @example
   * ```ts
   * // Find all persistent variables in T_ROB1
   * const persistents = await client.searchRapidSymbols({ task: 'T_ROB1', symtyp: 'per' });
   * ```
   *
   * Wire form (live-verified 2026-09-29 on RW 6.16.03, 6.16.3007): the action
   * is the plural `POST /rw/rapid/symbols?action=search-symbols`, as named in
   * the controller's own `?action=show` form; the singular `search-symbol` is
   * refused 400 -1073445879 for every body. `task` is accepted but ignored, so
   * the scope comes from `blockurl` (default `RAPID/{task}`; a `RAPID`-scope
   * search does not reach task symbols). `view=block`, `symtyp=any` and
   * `recursive=TRUE` are the defaults. Module, VAR, PERS, CONST, PROC, FUNC
   * and TRAP hits are returned. On RW 6.16.03 the module, VAR, PERS and PROC
   * kinds were seen; CONST, FUNC and TRAP are read by the class names of the
   * RWS 2.0 search and were not seen on RW 6. Other hit kinds the controller
   * also lists (task, parameter, atomic and record entries) are not returned.
   * A large search is paged by the controller (86 or 95 entries per page);
   * only the first page is read, which is enough for a module-scoped search.
   * These findings come from `?json=1` captures; the exact request this method
   * sends (XHTML, `blockurl` percent-encoded) has not itself been sent to
   * RW 6.16.
   */
  async searchRapidSymbols(params: RapidSymbolSearchParams): Promise<RapidSymbolInfo[]> {
    try {
      const { path, body } = mapSearchRapidSymbols(params);
      const { body: responseBody } = await this.session.post(path, body);
      return parseRapidSymbolSearch(responseBody);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`searchRapidSymbols failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Validate a value against a RAPID data type without writing it.
   * Useful for validating user input before calling setRapidVariable.
   *
   * Not a check of the value on RW 6.16.03: `POST /rw/rapid/symbol/data?action=validate`
   * with task, value and datatype answered 204 to every value sent on
   * 2026-10-01, the malformed `[1,2` as pos and `"zz"` as num included, so
   * `true` means only that the controller did not refuse the request.
   *
   * @param task     - RAPID task name, e.g. 'T_ROB1'
   * @param value    - Value in RAPID syntax, e.g. '[1,0,0,0]'
   * @param datatype - RAPID data type name, e.g. 'tooldata', 'robtarget', 'num'
   * @returns true if valid, false if invalid (no exception thrown for invalid values)
   */
  async validateRapidValue(task: string, value: string, datatype: string): Promise<boolean> {
    try {
      const { path, body } = mapValidateRapidValue(task, value, datatype);
      const { status } = await this.session.post(path, body);
      return status === 204;
    } catch (e) {
      if (e instanceof RwsError && e.httpStatus === 400) return false;
      if (e instanceof RwsError) throw e;
      throw new RwsError(`validateRapidValue failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read RAPID symbol properties (type, dimensions, storage class, etc.).
   * Useful for introspecting variables, persistents, constants, and records.
   *
   * @param taskName   - RAPID task name, e.g. 'T_ROB1'
   * @param moduleName - Module name, e.g. 'user'
   * @param symbolName - Symbol name, e.g. 'reg1'
   */
  async getRapidSymbolProperties(taskName: string, moduleName: string, symbolName: string): Promise<RapidSymbolProperties> {
    try {
      const { body } = await this.session.get(pathRapidSymbolProperties(taskName, moduleName, symbolName));
      return parseRapidSymbolProperties(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getRapidSymbolProperties failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── Motion ─────────────────────────────────────────────────────────────────

  /**
   * Read the current joint-space positions for a mechanical unit.
   *
   * @param mechunit - Mechanical unit name; default 'ROB_1'
   * @returns JointTarget with rax_1 … rax_6 in degrees
   */
  async getJointPositions(mechunit?: string): Promise<JointTarget> {
    try {
      const { body } = await this.session.get(pathJointTarget(mechunit));
      return parseJointTarget(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getJointPositions failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read every axis slot of a mechanical unit: `rax_1..rax_6` AND
   * `eax_a..eax_f` (`getJointPositions` keeps only the robot half). Same
   * resource as `getJointPositions`, one GET. `9E9` in a slot means "no axis
   * here" (`isJointValuePresent`); unused slots may also read 0 - see
   * `JointTargetFull`.
   *
   * @param mechunit - Mechanical unit name; default 'ROB_1'
   */
  async getJointTargetFull(mechunit = 'ROB_1'): Promise<JointTargetFull> {
    try {
      const { body } = await this.session.get(buildPath(MOTION.getJointTargetFull.rws1 as PathSpec, { mechunit }));
      return parseJointTargetFull(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getJointTargetFull failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read the current Cartesian robot target (TCP position and orientation).
   *
   * @param mechunit - Mechanical unit; default 'ROB_1'
   * @param tool     - Active tool frame; default 'tool0'
   * @param wobj     - Active work object; default 'wobj0'
   * @returns RobTarget with x, y, z (mm) and q1-q4 quaternion components
   */
  async getCartesianPosition(mechunit?: string, tool?: string, wobj?: string): Promise<RobTarget> {
    try {
      const { body } = await this.session.get(pathRobTarget(mechunit, tool, wobj));
      return parseRobTarget(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getCartesianPosition failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read the current Cartesian position including robot configuration flags.
   * Uses /cartesian endpoint (no tool/wobj override - uses active tool/wobj).
   * Returns j1/j4/j6/jx configuration integers in addition to pose.
   *
   * @param mechunit - Default 'ROB_1'
   */
  async getCartesianFull(mechunit?: string): Promise<CartesianFull> {
    try {
      const { body } = await this.session.get(pathCartesianFull(mechunit));
      return parseCartesianFull(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getCartesianFull failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── Modules ────────────────────────────────────────────────────────────────

  /**
   * Download a file from the controller filesystem as a UTF-8 string.
   * Use '$HOME/' prefix for the controller home directory.
   *
   * @param remotePath - Controller path, e.g. '$HOME/MyMod.mod'
   * @returns File content as a string
   */
  async readFile(remotePath: string): Promise<string> {
    try {
      const path = pathUploadFile(remotePath);
      const { body } = await this.session.get(path);
      return body;
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`readFile failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Upload a file to the controller filesystem.
   * The content is uploaded as UTF-8 bytes via PUT /fileservice/{remotePath}.
   * Works for any file type - RAPID modules, .cfg files, plain text, etc.
   *
   * @param remotePath - Controller path, e.g. '$HOME/MyMod.mod'
   * @param content    - File content as a string
   */
  async uploadFile(remotePath: string, content: string): Promise<void> {
    try {
      const path = pathUploadFile(remotePath);
      const bytes = new TextEncoder().encode(content);
      await this.session.put(path, bytes);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`uploadFile failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /** @deprecated use uploadFile() - same behavior, neutral name. Kept for backward compat. */
  uploadModule(remotePath: string, content: string): Promise<void> {
    return this.uploadFile(remotePath, content);
  }

  /**
   * Unload a RAPID module from a task (remove it from memory).
   * RAPID must be stopped before calling this.
   *
   * @param taskName   - RAPID task name, e.g. 'T_ROB1'
   * @param moduleName - Module name (without extension), e.g. 'MyProgram'
   */
  async unloadModule(taskName: string, moduleName: string): Promise<void> {
    try {
      await this.session.post(
        buildPath(RAPID.unloadModule.rws1 as PathSpec, { task: taskName }),
        `module=${encodeURIComponent(moduleName)}`,
      );
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`unloadModule failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Load a RAPID module from the controller filesystem into a task.
   * The module must have been uploaded first (see uploadModule).
   *
   * @param taskName   - RAPID task name, e.g. 'T_ROB1'
   * @param modulePath - Controller path to the module file, e.g. '$HOME/MyMod.mod'
   * @throws {RwsError} code='RESOURCE_NOT_FOUND' if the module FILE does not
   *   exist (it is a filesystem miss, not a loaded-module miss - the loadmod
   *   path has no /modules/ segment, so the module-specific code doesn't apply)
   */
  async loadModule(taskName: string, modulePath: string, replace = false): Promise<void> {
    try {
      const { path, body } = mapLoadModule(taskName, modulePath, replace);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`loadModule failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * List the names of all modules currently loaded in a RAPID task.
   *
   * @param taskName - RAPID task name, e.g. 'T_ROB1'
   * @returns Array of module names
   */
  async listModules(taskName: string): Promise<string[]> {
    try {
      const { body } = await this.session.get(pathListModules(taskName));
      // Extract module names from <span class="name"> inside <li class="rap-module-info-li">
      const matches = [
        ...body.matchAll(
          /<li[^>]*class="[^"]*\brap-module-info-li\b[^"]*"[^>]*>.*?<span[^>]*class="[^"]*\bname\b[^"]*"[^>]*>(.*?)<\/span>/gis,
        ),
      ];
      return matches.map(([, name]) => name.trim()).filter(Boolean);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`listModules failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Download a directory listing from the controller filesystem.
   * Returns entries sorted: directories first, then files.
   *
   * @param remotePath - Controller path, e.g. '$HOME' or '$HOME/Dispense'
   */
  async listDirectory(remotePath: string): Promise<FileEntry[]> {
    try {
      const { body } = await this.session.get(fileServicePath(remotePath));
      return parseDirectory(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`listDirectory failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Delete a file from the controller filesystem.
   * @param remotePath - Controller path, e.g. '$HOME/OldMod.mod'
   */
  async deleteFile(remotePath: string): Promise<void> {
    try {
      await this.session.delete(pathDeleteFile(remotePath));
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`deleteFile failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Create a directory on the controller filesystem.
   * @param parentPath - Parent directory path, e.g. '$HOME'
   * @param dirName    - New directory name, e.g. 'Backup'
   */
  async createDirectory(parentPath: string, dirName: string): Promise<void> {
    try {
      const path = fileServicePath(parentPath);
      // RWS 1.0 fileservice expects params in the body, not the query string.
      // Putting fs-action in the URL returns 400 "Invalid/No Query Parameter".
      await this.session.post(
        path,
        `fs-action=create&fs-newname=${encodeURIComponent(dirName)}`,
      );
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`createDirectory failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Copy a file on the controller filesystem.
   *
   * RWS 1.0 fileservice copy is **same-directory only** - the destination must
   * name a file in the source's own directory. A destination in a different
   * directory throws `INVALID_ARGUMENT` (it cannot be honoured by the endpoint);
   * to move across directories, copy within the source dir then move.
   * @param sourcePath - Source file path, e.g. '$HOME/MyMod.mod'
   * @param destPath   - Destination file in the SAME directory, e.g.
   *                     '$HOME/MyMod.bak' or a bare 'MyMod.bak'.
   */
  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    try {
      const { path, body } = mapCopyFile(sourcePath, destPath);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`copyFile failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Rename a file in place on the controller filesystem (same directory).
   * Live-verified on the RobotWare 6.16 virtual controller (2026-08-11): POST to the file's fileservice
   * path with `fs-action=rename` answers 204.
   * @param sourcePath - Existing file path, e.g. '$HOME/A.mod'.
   * @param newName    - New bare filename in the same directory.
   */
  async renameFile(sourcePath: string, newName: string): Promise<void> {
    try {
      const { path, body } = mapRenameFile(sourcePath, newName);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`renameFile failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── I/O signals ────────────────────────────────────────────────────────────

  /**
   * Read an I/O signal value.
   *
   * @param network - I/O network name, e.g. 'Local'
   * @param device  - I/O device name, e.g. 'DRV_1'
   * @param name    - Signal name, e.g. 'DI_1'
   * @returns Signal object with name, value, type, and lvalue
   */
  async readSignal(network: string, device: string, name: string): Promise<Signal> {
    try {
      const { body } = await this.session.get(pathSignal(network, device, name));
      return parseSignal(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`readSignal failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Write a value to a digital or analog output signal.
   *
   * @param network - I/O network name
   * @param device  - I/O device name
   * @param name    - Signal name
   * @param value   - New signal value, e.g. '1' (DO high), '0' (DO low), '3.14' (AO)
   */
  async writeSignal(network: string, device: string, name: string, value: string): Promise<void> {
    try {
      const { path } = mapSetSignal(network, device, name);
      await this.session.post(path, `lvalue=${encodeURIComponent(value)}`);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`writeSignal failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Every configured I/O signal, following the controller's pagination, as
   * RWS 2.0's listAllSignals does.
   *
   * RWS 1.0 serves a long list a page at a time and links the next page from
   * each page (`<a href="..." rel="next">`, the form ABB's RWS 1.0 manual
   * shows for its paged lists); the last page has no such link. Each link is
   * followed as the controller gives it, and the client never computes a
   * `start` itself: on RWS 1.0 a link's `start` need not count entries
   * (RW 6.16.03 links the second event-log page of 50 as
   * `start=2&limit=50`). Up to 1.4.x only the first page was read, so on a
   * controller with more than `limit` signals the rest was missing from the
   * signal table. RW 6.16.03 (62 signals) honours `limit`: the functional
   * suite read it in pages of 20 by `start` (2026-10-22). Whether those pages
   * carry a `next` link was not recorded, so this client has not yet
   * followed a controller's own link for signals.
   *
   * One call returns every signal from `start` to the end of the list, so a
   * caller that paged with `start` and `limit` itself (as 1.4.x needed)
   * calls once instead; each of its calls would now return the rest of the
   * list.
   *
   * The walk ends at a page with no `next` link, at an empty page, at a link
   * to a page already read or to another resource, or after `maxPages` pages
   * (logged: signals may be missing then). A page that ends the walk while
   * it links a next page the walk does not follow, or a full page with no
   * link, is logged too (once per client), since only what was read is
   * returned then. Pages are read one after the other through the session's
   * request queue, at its pace, one request per page. A page that fails
   * fails the whole read, so part of the table is never returned as all of
   * it.
   *
   * @param start    - `start` of the first request (default 0), sent as given
   * @param limit    - Signals per page asked for (default 100)
   * @param maxPages - Most pages to read (default 50, as on RWS 2.0)
   */
  async listAllSignals(start = 0, limit = 100, maxPages = 50): Promise<Signal[]> {
    try {
      const first = pathAllSignals(start, limit);
      const resource = first.split('?')[0];
      const out: Signal[] = [];
      const read = new Set<string>();
      let path = first;
      while (path && read.size < maxPages && !read.has(path)) {
        read.add(path);
        const { body } = await this.session.get(path);
        const page = parseSignalList(body);
        out.push(...page);
        const next = page.length > 0 ? nextPagePath(body, resource) : '';
        const followed = next.split('?')[0] === resource ? next : '';
        if (!followed && page.length > 0) { this.noteSignalWalkEnd(path, body, page.length, limit, out.length); }
        path = followed;
      }
      if (path && !read.has(path)) {
        Logger.warn(`listAllSignals: stopped after ${maxPages} pages with ${out.length} signals; the controller links more`);
      }
      return out;
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`listAllSignals failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Log, once per client, a signal page that ended listAllSignals' walk
   * although more may follow: it links a next page the walk does not follow
   * (another path, an absolute or otherwise unread form of the link), or it
   * is full and links none. No RWS 1.0 controller has been seen linking a
   * signal page yet, so the form of that link is ABB's manual, and this is
   * how a different one shows. A list of exactly `limit` signals logs the
   * full page too.
   */
  private noteSignalWalkEnd(path: string, body: string, pageLength: number, limit: number, total: number): void {
    if (this.signalWalkNoted) { return; }
    const link = /<a\b[^>]*\brel\s*=\s*["']next["'][^>]*>/i.exec(body)?.[0]
      ?? /"next"\s*:\s*\{[^}]*\}/.exec(body)?.[0];
    const why = link
      ? `links a next page the walk does not follow (${link.slice(0, 200)})`
      : pageLength >= limit ? `is full (${pageLength} signals) and links no next page` : null;
    if (!why) { return; }
    this.signalWalkNoted = true;
    Logger.warn(`listAllSignals: the page ${path} ${why}; returned ${total} signals, which may not be all of them (logged once)`);
  }

  /**
   * Search signals by criteria instead of paging the whole list. `name` is a
   * case-insensitive PREFIX match (not a substring match - corrected
   * 2026-09-29 after the 2026-09-27 probes on RW 6.16: `S` found the 14 names
   * starting with S, `RAKE` none, `drv1brake` the same 3 as `DRV1BRAKE`);
   * `device`, `network` and `category` match whole values (on RW 6.16 only
   * `device` was exercised: `PAN` 0 hits, `panel` and `PANEL` 42; the
   * whole-value `network` and `category` evidence is from RW 7.21 and 8.1.1
   * over RWS 2.0, 2026-09-27); criteria AND-compose; `*` matches nothing; no
   * criteria at all returns every signal. RWS 1.0 query-action form
   * (`POST /rw/iosystem/signals?action=signal-search`), live-verified on the RobotWare 6.16 virtual controller
   * (2026-08-11): returns the same `ios-signal-li` shape as listAllSignals.
   */
  async searchSignals(criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Promise<Signal[]> {
    try {
      const { path, body } = mapSearchSignals(criteria);
      const res = await this.session.post(path, body);
      return parseSignalList(res.body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`searchSignals failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * List all configured I/O networks.
   */
  async listNetworks(): Promise<IoNetwork[]> {
    try {
      const { body } = await this.session.get(pathNetworks());
      return parseNetworks(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`listNetworks failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * List all I/O devices on a network.
   * @param network - Network name, e.g. 'Local'
   */
  async listDevices(network: string): Promise<IoDevice[]> {
    try {
      const { body } = await this.session.get(pathDevices(network));
      return parseDevices(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`listDevices failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── Controller info ────────────────────────────────────────────────────────

  /**
   * Read RobotWare system information (version, options, system ID).
   */
  async getSystemInfo(): Promise<SystemInfo> {
    try {
      const { body } = await this.session.get(pathSystemInfo());
      return parseSystemInfo(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getSystemInfo failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read controller hardware identity (name, ID, type, MAC address).
   */
  async getControllerIdentity(): Promise<ControllerIdentity> {
    try {
      const { body } = await this.session.get(pathControllerIdentity());
      return parseControllerIdentity(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getControllerIdentity failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Read the controller date and time.
   * Returns a ControllerClock with the datetime string in 'YYYY-MM-DD T HH:MM:SS' format (UTC).
   */
  async getControllerClock(): Promise<ControllerClock> {
    try {
      const { body } = await this.session.get(pathClockInfo());
      return parseControllerClock(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getControllerClock failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Set the controller date and time (UTC).
   * @param year  - Full year, e.g. 2024
   * @param month - Month 1-12
   * @param day   - Day 1-31
   * @param hour  - Hour 0-23
   * @param min   - Minute 0-59
   * @param sec   - Second 0-59
   *
   * @experimental Built from the controller form; never run against an RWS 1.0 controller.
   */
  async setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void> {
    try {
      const { path, body } = mapSetControllerClock(year, month, day, hour, min, sec);
      // Pass the form body as a STRING so HttpSession stamps
      // Content-Type: application/x-www-form-urlencoded. TextEncoder-wrapping it
      // made the body a Uint8Array, which the session labels octet-stream - the
      // controller's form parser then never reads the sys-clock-* fields and the
      // clock is not set. (RWS 2.0 sends this same PUT as x-www-form-urlencoded.)
      await this.session.put(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`setControllerClock failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── Event log ──────────────────────────────────────────────────────────────

  /**
   * Retrieve event log messages from the controller, newest first (LIFO
   * order), every page up to `maxPages`.
   *
   * The controller lists 50 messages a page and links the next page (RW
   * 6.16.03: `0?order=lifo&lang=en&start=2&limit=50`, which served the older
   * messages; a `limit` above 50 still served 50; 2026-09-29). Each page's
   * `next` link is followed, as ABB's listing advertises it, until there is
   * none or `maxPages` pages are read (default 20, about 1000 messages: the
   * domain-0 buffer RW 6.16.03 reports). A message listed on two pages (one
   * logged during the walk) is kept once. A later page that fails ends the
   * walk with the messages already read (logged); the first page's failure
   * is thrown. Up to 1.4.x only the first page was read, at most 50 messages;
   * pass `maxPages: 1` for that.
   *
   * @param domain   - Log domain number; default 0 (main system log)
   * @param lang     - Language for message text; default 'en'
   * @param maxPages - Most pages to read; default 20
   */
  async getEventLog(domain = 0, lang = 'en', maxPages = ELOG_MAX_PAGES): Promise<ElogMessage[]> {
    try {
      let page = 0;
      const pages = await readPages(pathElogMessages(domain, lang), async path => {
        if (page++ === 0) { return (await this.session.get(path)).body; }
        try {
          return (await this.session.get(path)).body;
        } catch (e) {
          Logger.warn(`getEventLog(${domain}): page ${page} failed (${e instanceof Error ? e.message : String(e)}); returning the messages already read`);
          return '';
        }
      }, maxPages);
      const seen = new Set<number>();
      return pages.flatMap(body => parseElogMessages(body)).filter(m => !seen.has(m.seqnum) && seen.add(m.seqnum));
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getEventLog failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Clear event log messages in a specific domain.
   * @param domain - Log domain number; default 0 (main system log)
   */
  async clearEventLog(domain = 0): Promise<void> {
    try {
      const { path, body } = mapClearElogDomain(domain);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`clearEventLog failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Clear ALL event log messages across all domains.
   */
  async clearAllEventLogs(): Promise<void> {
    try {
      const { path, body } = mapClearAllElogs();
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`clearAllEventLogs failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── Mastership ──────────────────────────────────────────────────────────────

  /**
   * Request mastership on a domain.
   * Must call releaseMastership when done. Operations that modify controller state
   * (motor on/off, speed ratio, etc.) require mastership on the appropriate domain.
   *
   * Holds are counted per domain: a request for a domain this session already
   * holds sends nothing, and the release goes out when the last hold on it
   * ends. Pair every request with one releaseMastership.
   *
   * @param domain - 'cfg' | 'motion' | 'rapid'
   */
  requestMastership(domain: MastershipDomain): Promise<void> {
    return this.access.requestPublic(domain);
  }

  /**
   * Release mastership on a domain.
   * Always call this after requestMastership, even if the operation failed.
   * Ends this caller's most recent hold on the domain; the release is sent
   * when no other hold of this session is on it.
   *
   * @param domain - 'cfg' | 'motion' | 'rapid'
   */
  releaseMastership(domain: MastershipDomain): Promise<void> {
    return this.access.releasePublic(domain);
  }

  private async wireRequestMastership(domain: MastershipDomain): Promise<void> {
    try {
      const { path, body } = mapRequestMastership(domain);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`requestMastership failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  private async wireReleaseMastership(domain: MastershipDomain): Promise<void> {
    try {
      const { path, body } = mapReleaseMastership(domain);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`releaseMastership failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── Subscriptions ──────────────────────────────────────────────────────────

  /**
   * Subscribe to one or more RWS resource events via WebSocket.
   *
   * The stream self-heals: heartbeat pings detect half-open connections, drops
   * reconnect with capped exponential backoff, and a controller restart triggers
   * a fresh registration. `opts.onRestored` fires after every successful
   * recovery (resync your state - events may have been missed); `opts.onLost`
   * fires exactly once if the reconnect budget is exhausted.
   *
   * @param resources - Resources to subscribe to (execution, controllerstate, signal, etc.)
   * @param handler   - Called with each SubscriptionEvent as it arrives
   * @param opts      - Lifecycle callbacks and reconnect/heartbeat tuning
   * @returns         - Async unsubscribe function; call to cancel and clean up
   *
   * @example
   * ```ts
   * const unsubscribe = await client.subscribe(['execution'], (event) => {
   *   console.log(event.resource, event.value);
   * }, { onLost: () => console.log('stream gone - fall back to polling') });
   * // later...
   * await unsubscribe();
   * ```
   */
  async subscribe(
    resources: AnySubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    opts?: WsSubscribeOptions,
  ): Promise<() => Promise<void>> {
    try {
      return await this.subscriber.subscribe(resources, handler, opts);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`subscribe failed: ${String(e)}`, 'UNKNOWN');
    }
  }
}
