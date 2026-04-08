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
  JointTarget,
  RobTarget,
  Signal,
  RapidTask,
  SubscriptionResource,
  SubscriptionEvent,
} from './types.js';
import {
  controllerState as pathControllerState,
  operationMode as pathOperationMode,
  rapidTasks as pathRapidTasks,
  rapidExecutionState as pathRapidExecutionState,
  startRapid as mapStartRapid,
  stopRapid as mapStopRapid,
  resetRapid as mapResetRapid,
  jointTarget as pathJointTarget,
  robTarget as pathRobTarget,
  loadModule as mapLoadModule,
  listModules as pathListModules,
  uploadFile as pathUploadFile,
  signal as pathSignal,
  setSignal as mapSetSignal,
} from './ResourceMapper.js';
import {
  parseControllerState,
  parseOperationMode,
  parseExecutionState,
  parseJointTarget,
  parseRobTarget,
  parseSignal,
  parseRapidTasks,
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
    };
    this.session = new HttpSession(sessionOptions);
    this.subscriber = new WsSubscriber(this.session, options.host, options.port ?? 80);
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

  // ─── Modules ────────────────────────────────────────────────────────────────

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
   * Load a RAPID module from the controller filesystem into a task.
   * The module must have been uploaded first (see uploadModule).
   *
   * @param taskName   - RAPID task name, e.g. 'T_ROB1'
   * @param modulePath - Controller path to the module file, e.g. '$HOME/MyMod.mod'
   * @throws {RwsError} code='MODULE_NOT_FOUND' if the module file does not exist
   */
  async loadModule(taskName: string, modulePath: string): Promise<void> {
    try {
      const { path, body } = mapLoadModule(taskName, modulePath);
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
