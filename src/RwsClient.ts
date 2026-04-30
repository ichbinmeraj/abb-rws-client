/**
 * RwsClient — the single public class for the abb-rws-client package.
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
import { RwsError } from './types.js';
import type {
  RwsClientOptions,
  ControllerState,
  OperationMode,
  ExecutionState,
  ExecutionInfo,
  ExecutionCycle,
  JointTarget,
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
  SubscriptionResource,
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

export class RwsClient {
  private readonly session: HttpSession;
  private readonly subscriber: WsSubscriber;

  constructor(options: RwsClientOptions) {
    const sessionOptions: HttpSessionOptions = {
      baseUrl: `http://${options.host}:${options.port ?? 80}`,
      username: options.username ?? 'Default User',
      password: options.password ?? 'robotics',
      requestIntervalMs: options.requestIntervalMs ?? 55,
      timeoutMs: options.timeout ?? 5000,
      sessionCookie: options.sessionCookie,
    };
    this.session = new HttpSession(sessionOptions);
    this.subscriber = new WsSubscriber(this.session, options.host, options.port ?? 80);
  }

  /** Returns the current -http-session- cookie so callers can persist and reuse it */
  getSessionCookie(): string | null {
    return this.session.getSessionCookie();
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
    } finally {
      this.session.clearSession();
    }
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
   * Set the controller motor state.
   * Requires AUTO mode and mastership (request with requestMastership('motion') first).
   *
   * @param state - 'motoron' | 'motoroff'
   * @throws {RwsError} code='AUTH_FAILED' if mastership is not held
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
   * - `restart`  — Normal restart; saves state and activates changed system parameters
   * - `istart`   — Restart with original installation settings; discards all programs
   * - `pstart`   — Restart preserving system parameters; removes programs
   * - `bstart`   — Boot with last auto-saved state (crash recovery)
   *
   * @param mode - Restart mode; default 'restart'
   */
  async restartController(mode: RestartMode = 'restart'): Promise<void> {
    try {
      const { path, body } = mapRestartController(mode);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`restartController failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Lock the operation mode selector on the FlexPendant.
   * @param pin       - 4-digit PIN code
   * @param permanent - true = permanent lock; false = temporary
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

  /** Unlock the operation mode selector. */
  async unlockOperationMode(): Promise<void> {
    try {
      const { path, body } = mapUnlockOperationMode();
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`unlockOperationMode failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── Speed ratio ────────────────────────────────────────────────────────────

  /**
   * Read the current speed ratio (0–100).
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
   * Set the speed ratio override (0–100). Only valid in AUTO mode.
   * @param ratio - Integer 0–100 (clamped automatically)
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
          throw new RwsError('Motors are off — enable motors before starting RAPID', 'MOTORS_OFF', e.httpStatus, e.rwsDetail);
        }
        throw e;
      }
      throw new RwsError(`startRapid failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Stop RAPID program execution.
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
   */
  async getActiveUiInstruction(): Promise<UiInstruction | null> {
    try {
      const { body } = await this.session.get(pathActiveUiInstruction());
      return parseActiveUiInstruction(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`getActiveUiInstruction failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Respond to an active RAPID UI instruction (e.g. send the answer to a TPReadNum).
   * Get the stackurl from getActiveUiInstruction().stack.
   *
   * Common parameter names:
   * - 'Result' — the answer value for TPReadNum, TPReadFK
   * - 'TPFK1' … 'TPFK5' — individual function key states (0/1)
   * - 'TPCompleted' — set to 'TRUE' when done
   *
   * @param stackurl - Stack URL from UiInstruction.stack (e.g. 'RAPID/T_ROB1/%$104')
   * @param uiparam  - Parameter name, e.g. 'Result'
   * @param value    - Value to set, e.g. '42' or 'TRUE'
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
   * Read the current Cartesian robot target (TCP position and orientation).
   *
   * @param mechunit - Mechanical unit; default 'ROB_1'
   * @param tool     - Active tool frame; default 'tool0'
   * @param wobj     - Active work object; default 'wobj0'
   * @returns RobTarget with x, y, z (mm) and q1–q4 quaternion components
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
   * Uses /cartesian endpoint (no tool/wobj override — uses active tool/wobj).
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
   * Upload a RAPID module file to the controller filesystem.
   * The file content is uploaded as UTF-8 bytes via PUT /fileservice/{remotePath}.
   *
   * @param remotePath - Controller path, e.g. '$HOME/MyMod.mod'
   * @param content    - RAPID module source as a string
   */
  async uploadModule(remotePath: string, content: string): Promise<void> {
    try {
      const path = pathUploadFile(remotePath);
      const bytes = new TextEncoder().encode(content);
      await this.session.put(path, bytes);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`uploadModule failed: ${String(e)}`, 'UNKNOWN');
    }
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
        `/rw/rapid/tasks/${encodeURIComponent(taskName)}?action=unloadmod`,
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
   * @throws {RwsError} code='MODULE_NOT_FOUND' if the module file does not exist
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
      const { path } = { path: fileServicePath(parentPath) };
      await this.session.post(
        `${path}?fs-action=create&fs-newname=${encodeURIComponent(dirName)}`,
        '',
      );
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`createDirectory failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Copy a file on the controller filesystem.
   * @param sourcePath - Source file path, e.g. '$HOME/MyMod.mod'
   * @param destPath   - Destination path (full path including filename), e.g. '$HOME/Backup/MyMod.mod'
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
   * List all configured I/O signals (paginated).
   * The controller returns up to `limit` signals per call; use `start` to page through.
   *
   * @param start - Starting index (default 0)
   * @param limit - Results per page (default 100)
   */
  async listAllSignals(start = 0, limit = 100): Promise<Signal[]> {
    try {
      const { body } = await this.session.get(pathAllSignals(start, limit));
      return parseSignalList(body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`listAllSignals failed: ${String(e)}`, 'UNKNOWN');
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
   * @param month - Month 1–12
   * @param day   - Day 1–31
   * @param hour  - Hour 0–23
   * @param min   - Minute 0–59
   * @param sec   - Second 0–59
   */
  async setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void> {
    try {
      const { path, body } = mapSetControllerClock(year, month, day, hour, min, sec);
      await this.session.put(path, new TextEncoder().encode(body));
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`setControllerClock failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  // ─── Event log ──────────────────────────────────────────────────────────────

  /**
   * Retrieve event log messages from the controller.
   * Domain 0 is the main system log (up to 1000 entries).
   * Messages are returned newest-first (LIFO order).
   *
   * @param domain - Log domain number; default 0 (main system log)
   * @param lang   - Language for message text; default 'en'
   */
  async getEventLog(domain = 0, lang = 'en'): Promise<ElogMessage[]> {
    try {
      const { body } = await this.session.get(pathElogMessages(domain, lang));
      return parseElogMessages(body);
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
   * @param domain - 'cfg' | 'motion' | 'rapid'
   */
  async requestMastership(domain: MastershipDomain): Promise<void> {
    try {
      const { path, body } = mapRequestMastership(domain);
      await this.session.post(path, body);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`requestMastership failed: ${String(e)}`, 'UNKNOWN');
    }
  }

  /**
   * Release mastership on a domain.
   * Always call this after requestMastership, even if the operation failed.
   *
   * @param domain - 'cfg' | 'motion' | 'rapid'
   */
  async releaseMastership(domain: MastershipDomain): Promise<void> {
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
   * @param resources - Resources to subscribe to (execution, controllerstate, signal, etc.)
   * @param handler   - Called with each SubscriptionEvent as it arrives
   * @returns         - Async unsubscribe function; call to cancel and clean up
   *
   * @example
   * ```ts
   * const unsubscribe = await client.subscribe(['execution'], (event) => {
   *   console.log(event.resource, event.value);
   * });
   * // later...
   * await unsubscribe();
   * ```
   */
  async subscribe(
    resources: SubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
  ): Promise<() => Promise<void>> {
    try {
      return await this.subscriber.subscribe(resources, handler);
    } catch (e) {
      if (e instanceof RwsError) throw e;
      throw new RwsError(`subscribe failed: ${String(e)}`, 'UNKNOWN');
    }
  }
}
