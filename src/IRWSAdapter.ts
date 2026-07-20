import type {
  ControllerState, OperationMode, ExecutionState, ExecutionCycle,
  ExecutionInfo, CollisionDetectionState, RapidTask, JointTarget,
  CartesianFull, RobTarget, SystemInfo, ControllerIdentity, ControllerClock,
  ElogMessage, Signal, IoNetwork, IoDevice, FileEntry,
  RapidSymbolProperties, RapidSymbolInfo, RapidSymbolSearchParams,
  UiInstruction, RestartMode, MastershipDomain,
  SubscriptionResource, SubscriptionEvent,
} from './types.js';

/** Common interface for both RWS1Adapter (IRC5 / RW6) and RWS2Adapter (OmniCore / RW7). */
export interface IRWSAdapter {
  // ── Connection ───────────────────────────────────────────────────────────
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSessionCookie(): string | null;

  // ── Panel ────────────────────────────────────────────────────────────────
  getControllerState(): Promise<ControllerState>;
  setControllerState(state: 'motoron' | 'motoroff'): Promise<void>;
  getOperationMode(): Promise<OperationMode>;
  getSpeedRatio(): Promise<number>;
  setSpeedRatio(ratio: number): Promise<void>;
  getCollisionDetectionState(): Promise<CollisionDetectionState>;
  lockOperationMode(pin: string, permanent?: boolean): Promise<void>;
  unlockOperationMode(): Promise<void>;
  /**
   * Switch the controller's operation mode (AUTO/MANR/MANF).
   * **Virtual controllers only** - real hardware respects the FlexPendant key
   * switch and will reject this with 403 (or silently keep the current mode).
   */
  setOperationMode?(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void>;

  // ── RAPID execution ──────────────────────────────────────────────────────
  getRapidExecutionState(): Promise<ExecutionState>;
  getRapidExecutionInfo(): Promise<ExecutionInfo>;
  startRapid(): Promise<void>;
  stopRapid(): Promise<void>;
  resetRapid(): Promise<void>;
  setExecutionCycle(cycle: ExecutionCycle): Promise<void>;
  getRapidTasks(): Promise<RapidTask[]>;
  activateRapidTask(task: string): Promise<void>;
  deactivateRapidTask(task: string): Promise<void>;
  activateAllRapidTasks(): Promise<void>;
  deactivateAllRapidTasks(): Promise<void>;

  // ── RAPID modules & variables ────────────────────────────────────────────
  listModules(task: string): Promise<string[]>;
  /**
   * Detailed module list - returns each module's name AND type
   * (`SysMod` for system modules / `ProgMod` for program modules / etc.).
   * Optional - adapter may return an empty array if the underlying API is
   * unavailable. Callers should fall back to `listModules` for the names.
   */
  listModulesDetailed?(task: string): Promise<Array<{ name: string; type: string }>>;
  loadModule(task: string, path: string, replace?: boolean): Promise<void>;
  unloadModule(task: string, name: string): Promise<void>;
  getRapidVariable(task: string, module: string, symbol: string): Promise<string>;
  setRapidVariable(task: string, module: string, symbol: string, value: string): Promise<void>;
  validateRapidValue(task: string, value: string, datatype: string): Promise<boolean>;
  getRapidSymbolProperties(task: string, module: string, symbol: string): Promise<RapidSymbolProperties>;
  searchRapidSymbols(params: RapidSymbolSearchParams): Promise<RapidSymbolInfo[]>;
  getActiveUiInstruction(): Promise<UiInstruction | null>;
  setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void>;

  // ── Motion ───────────────────────────────────────────────────────────────
  getJointPositions(mechunit?: string): Promise<JointTarget>;
  getCartesianFull(mechunit?: string): Promise<CartesianFull>;
  listMechunits(): Promise<string[]>;

  /**
   * Inverse kinematics: compute joint angles from a Cartesian position.
   * Uses the current joint positions as a seed for the solution.
   * Tool and work-object default to tool0/wobj0 (base frame, no offset).
   *
   * Confirmed parameter format (both RWS versions, tested by sequential field probing):
   *   curr_position, curr_orientation, curr_ext_joints, old_rob_joints, old_ext_joints,
   *   robot_fixed_object, tool_frame_position/orientation, wobj_frame_position/orientation,
   *   robot_configuration, elog_at_error
   *
   * Note: virtual controllers (RobotStudio) reject every input with HTTP 400
   * "Position outside of reach" (SYS_CTRL_E_POSE_OUTSIDE_REACH, -1073436654) -
   * even the controller's own current pose. This is a VC-only limitation: the
   * standard VC ships without the PC Interface (616-1) option that enables the
   * full kinematic solver, and wobj0 can desync from the displayed mechanism.
   * Real IRC5 / OmniCore hardware with PC Interface licensed returns valid
   * joint angles for any reachable pose.
   */
  calcJointsFromCartesian(
    pos: RobTarget,
    seedJoints?: JointTarget,
    mechunit?: string,
  ): Promise<JointTarget>;

  /**
   * Jog the robot by specified increments. Requires:
   * - Controller in MANR or MANF mode (not AUTO)
   * - Motors ON
   * - Motion-domain mastership held (callers should wrap with requestMastership('motion'))
   *
   * @param mode    'Joint' for axis-by-axis (degrees), 'Cartesian' for X/Y/Z + orientation (mm)
   * @param axes    6 increment values, one per axis. Zero means don't move that axis.
   * @param speed   Jog speed percentage (0-100). 0 sends the request without moving.
   * @param mechunit  Mechanical unit name (defaults to ROB_1).
   */
  jog(params: {
    mode: 'Joint' | 'Cartesian';
    axes: [number, number, number, number, number, number];
    speed: number;
    mechunit?: string;
  }): Promise<void>;

  /**
   * Get the current Remote Mastership Privilege state for the connected user.
   * 'none' = no privilege, 'pending modify' = request waiting for FlexPendant approval,
   * 'modify' = approved (can send modifying ops like jog), 'exclusive' = full control.
   */
  getRmmpPrivilege?(): Promise<string>;

  /** Request 'modify' RMMP. Triggers a FlexPendant approval popup. Returns immediately. */
  requestRmmp?(level?: 'modify' | 'exclusive'): Promise<void>;

  // ── System info ──────────────────────────────────────────────────────────
  getSystemInfo(): Promise<SystemInfo>;
  getControllerIdentity(): Promise<ControllerIdentity>;
  getControllerClock(): Promise<ControllerClock>;
  setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void>;
  restartController(mode: RestartMode): Promise<void>;

  // ── System detail endpoints ──────────────────────────────────────────────
  /** Active license info from `/rw/system/license`. */
  getLicenseInfo?(): Promise<{ entries: Array<Record<string, string>> }>;
  /** Installed RobotWare products from `/rw/system/products`. */
  listProducts?(): Promise<Array<Record<string, string>>>;
  /** Robot type identifier from `/rw/system/robottype`. */
  getRobotType?(): Promise<{ type: string; variant?: string }>;
  /** Power-consumption stats from `/rw/system/energy` (RW7+). */
  getEnergyStats?(): Promise<Record<string, string>>;

  // ── Return-code lookup ───────────────────────────────────────────────────
  /** Translate a numeric controller return code to its title/description via `/rw/retcode?code=N&lang=en`. */
  getReturnCode?(code: number, lang?: string): Promise<{ code: number; title: string; desc: string } | null>;

  // ── Controller detail endpoints ──────────────────────────────────────────
  /** Detailed installed-options list from `/ctrl/options` (richer than getSystemInfo's options array). */
  listControllerOptions?(): Promise<Array<{ name: string; description?: string }>>;
  /** Optional hardware/firmware features from `/ctrl/features`. */
  listFeatures?(): Promise<Array<Record<string, string>>>;

  // ── Motion detail endpoints ─────────────────────────────────────────────
  /** Read the motion-system change counter (required by jog `ccount`). */
  getMotionChangeCount?(): Promise<number>;
  /** Current motion-error state from `/rw/motionsystem/errorstate`. */
  getMotionErrorState?(): Promise<{ state: string; details?: Record<string, string> }>;
  /** Get/set non-motion-execution mode (dry-run). */
  getNonMotionExecution?(): Promise<boolean>;
  setNonMotionExecution?(enabled: boolean): Promise<void>;
  /** OmniCore-only: collision-prediction mode. */
  getCollisionPredictionMode?(): Promise<string>;
  setCollisionPredictionMode?(mode: string): Promise<void>;

  // ── Panel detail endpoints ──────────────────────────────────────────────
  /** Read the enable-request state (relates to deadman / safety chain). */
  getEnableRequest?(): Promise<{ state: string; raw: Record<string, string> }>;

  // ── RAPID detail endpoints ──────────────────────────────────────────────
  /** I/O alias mapping from `/rw/rapid/aliasio`. */
  listAliasIO?(): Promise<Array<{ alias: string; signal: string }>>;
  /** Active task selector from `/rw/rapid/taskselection`. */
  getTaskSelection?(): Promise<{ selected: string[]; available: string[] }>;
  setTaskSelection?(tasks: string[]): Promise<void>;
  /** Program-pointer position for a task. */
  getProgramPointer?(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }>;
  /** Motion-pointer (ahead of PP - what the motion planner is executing). */
  getMotionPointer?(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }>;

  // ── Event log ────────────────────────────────────────────────────────────
  getEventLog(domain?: number, lang?: string): Promise<ElogMessage[]>;
  clearEventLog(domain?: number): Promise<void>;
  clearAllEventLogs(): Promise<void>;

  // ── I/O ──────────────────────────────────────────────────────────────────
  listAllSignals(start?: number, limit?: number): Promise<Signal[]>;
  readSignal(network: string, device: string, name: string): Promise<Signal>;
  writeSignal(network: string, device: string, name: string, value: string): Promise<void>;
  listNetworks(): Promise<IoNetwork[]>;
  listDevices(network: string): Promise<IoDevice[]>;

  // ── File system ──────────────────────────────────────────────────────────
  listDirectory(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  uploadFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  createDirectory(parentPath: string, dirName: string): Promise<void>;
  copyFile(sourcePath: string, destPath: string): Promise<void>;

  // ── Configuration database `/rw/cfg` ─────────────────────────────────────
  // 6 domains: EIO, MMC, MOC, PROC, SIO, SYS - each with many types (e.g. MOC has
  // ARM, ARM_TYPE, JOINT, MOTOR, ROBOT_TYPE, SINGLE, etc.).

  /** List the 6 configuration domains. */
  listCfgDomains?(): Promise<string[]>;
  /** List the types defined in a domain (e.g. ['ARM', 'JOINT', 'MOTOR'] for MOC). */
  listCfgTypes?(domain: string): Promise<string[]>;
  /** List instance names of a given type (e.g. ROB_1, ROB_L1 under MOC/ARM). */
  listCfgInstances?(domain: string, type: string): Promise<string[]>;
  /** Read a single configuration instance - returns the named attributes for that instance. */
  getCfgInstance?(domain: string, type: string, instance: string): Promise<Record<string, string>>;
  /** Update an existing configuration instance. Requires 'edit' mastership. */
  setCfgInstance?(domain: string, type: string, instance: string, attributes: Record<string, string>): Promise<void>;
  /** Create a new instance of a type. Requires 'edit' mastership. */
  createCfgInstance?(domain: string, type: string, instance: string, attributes: Record<string, string>): Promise<void>;
  /** Delete an instance. Requires 'edit' mastership. */
  removeCfgInstance?(domain: string, type: string, instance: string): Promise<void>;
  /** Load configuration from a `.cfg` file already on the controller's filesystem. Requires 'edit' mastership. */
  loadCfgFile?(filepath: string, action?: 'add' | 'replace' | 'add-with-reset'): Promise<void>;
  /** Save a domain's current state to a `.cfg` file. Requires 'edit' mastership. */
  saveCfgFile?(domain: string, filepath: string): Promise<void>;

  // ── Backup / Restore `/ctrl/backup` ──────────────────────────────────────

  /** List existing backups in the BACKUP volume. */
  listBackups?(): Promise<Array<{ name: string; created?: string; size?: number }>>;
  /** Trigger a backup. Returns a promise that resolves when the backup is initiated;
   *  use `getBackupStatus()` to poll for completion. */
  createBackup?(name: string): Promise<void>;
  /** Restore from a previous backup. Long-running - controller may restart afterwards. */
  restoreBackup?(name: string): Promise<void>;
  /** Get current backup-or-restore operation status. */
  getBackupStatus?(): Promise<{ active: boolean; progress?: number; phase?: string }>;

  // ── Tool / WObj management ───────────────────────────────────────────────

  /** Currently active tool/wobj/payload for a mechunit. */
  getActiveTool?(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  getActiveWobj?(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  getActivePayload?(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  /** Switch the active tool/wobj - both delegate to the corresponding RAPID symbol. */
  setActiveTool?(mechunit: string, toolName: string): Promise<void>;
  setActiveWobj?(mechunit: string, wobjName: string): Promise<void>;

  // ── Service routine / PROC call ──────────────────────────────────────────

  /** Execute a PROC remotely (typically a service routine). Async - returns once execution starts. */
  callServiceRoutine?(task: string, routineName: string, args?: Record<string, string>): Promise<void>;

  // ── DIPC (Distributed Inter-Process Communication) `/rw/dipc` ────────────

  /** List active DIPC queues. */
  listDipcQueues?(): Promise<Array<{ name: string; size?: number }>>;
  /** Create a DIPC queue (caller's identity becomes the owner). */
  createDipcQueue?(name: string, options?: { maxsize?: number; maxmessages?: number }): Promise<void>;
  /** Send a DIPC message that a RAPID program can read via `RecvDipc`. */
  sendDipcMessage?(queue: string, payload: string, type?: 'string' | 'num' | 'dnum' | 'bool'): Promise<void>;
  /** Read a DIPC message that a RAPID program sent via `SendDipc`. */
  readDipcMessage?(queue: string, timeoutMs?: number): Promise<{ payload: string; type: string } | null>;
  removeDipcQueue?(name: string): Promise<void>;

  // ── Mastership ───────────────────────────────────────────────────────────
  requestMastership(domain: MastershipDomain): Promise<void>;
  releaseMastership(domain: MastershipDomain): Promise<void>;
  /** Request mastership on ALL domains at once. */
  requestMastershipAll?(): Promise<void>;
  /** Release mastership on ALL domains at once. */
  releaseMastershipAll?(): Promise<void>;
  /** Request mastership and receive a numeric ID token (token-based mastership outlives the session that acquired it). */
  requestMastershipWithId?(domain: MastershipDomain): Promise<number>;
  /** Release token-acquired mastership using the ID returned by `requestMastershipWithId()`. */
  releaseMastershipWithId?(domain: MastershipDomain, id: number): Promise<void>;
  /** Reset the edit-mastership watchdog (RobotWare 7.8+) - call ~every 1s while holding mastership during a long RAPID run. */
  resetMastershipWatchdog?(): Promise<void>;
  /** Read mastership status for one domain. */
  getMastershipStatus?(domain: MastershipDomain): Promise<{ mastership: string; uid?: string; application?: string }>;
  /** List the mastership domains the controller exposes. */
  listMastershipDomains?(): Promise<string[]>;

  // ── Devices `/rw/devices` and `/rw/iosystem/devices` ─────────────────────

  /** Top-level device groupings (e.g. HW_DEVICES, SW_RESOURCES). */
  listSystemDevices?(): Promise<Array<{ id: string; name: string }>>;
  /** Drill into a system-device group - returns the raw XHTML sub-tree. */
  getDeviceTree?(group: string): Promise<string>;
  /** All configured I/O devices across every network in one call. */
  listAllIoDevices?(): Promise<Array<{ name: string; network: string; lstate: string; pstate: string; address: string }>>;

  // ── Forward kinematics ────────────────────────────────────────────────────

  /**
   * Forward kinematics: joint angles → Cartesian pose. Mirror of
   * `calcJointsFromCartesian()`. Same VC-license caveat applies.
   */
  calcCartesianFromJoints?(
    joints: JointTarget,
    mechunit?: string,
    tool?: string,
    wobj?: string,
  ): Promise<RobTarget>;

  // ── Vision system `/rw/vision` ───────────────────────────────────────────

  /** List configured vision systems (Integrated Vision option). */
  listVisionSystems?(): Promise<Array<{ name: string; status?: string }>>;
  /** Per-system info. */
  getVisionSystemInfo?(name: string): Promise<Record<string, string>>;
  /** List vision jobs (recipes) for a system. */
  listVisionJobs?(system: string): Promise<Array<{ name: string; active?: boolean }>>;
  /** Trigger a vision job. */
  triggerVisionJob?(system: string, job: string): Promise<void>;

  // ── Safety controller `/ctrl/safety` ────────────────────────────────────

  /** Status of the integrated safety controller (PSC option). */
  getSafetyStatus?(): Promise<{ state: string; details?: Record<string, string> }>;
  /** List safety zones (configured cells/limits). */
  listSafetyZones?(): Promise<Array<Record<string, string>>>;
  /** Trigger a cyclic brake check. */
  runCyclicBrakeCheck?(): Promise<void>;

  // ── Virtual time `/ctrl/virtualtime` (VC-only) ───────────────────────────

  /** Get current virtual time (only meaningful on virtual controllers). */
  getVirtualTime?(): Promise<{ time: number; running: boolean }>;
  /** Pause/resume virtual time - fast-forward simulation. */
  setVirtualTimeRunning?(running: boolean): Promise<void>;
  /** Set scaling factor (1.0 = real-time, 10.0 = 10x faster, 0 = paused). */
  setVirtualTimeScale?(scale: number): Promise<void>;

  // ── Certificate store `/ctrl/certstore` ──────────────────────────────────

  /** List installed TLS certificates. */
  listCertificates?(): Promise<Array<{ name: string; subject?: string; expires?: string }>>;
  /** Upload a PEM-encoded certificate. */
  uploadCertificate?(name: string, pem: string): Promise<void>;
  /** Remove a certificate. */
  removeCertificate?(name: string): Promise<void>;

  // ── Registry `/ctrl/registry` (ABB-internal) ─────────────────────────────

  /** Read controller registry (mostly ABB internal - limited use). */
  getRegistry?(): Promise<Record<string, string>>;

  // ── Compress `/ctrl/compress` ────────────────────────────────────────────

  /** Compress a file/directory on the controller. Returns the new archive path. */
  compressPath?(source: string, destination: string): Promise<void>;

  // ── File service - additional volumes ───────────────────────────────────

  /** List all available file volumes (HOME, BACKUP, DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP). */
  listFileVolumes?(): Promise<string[]>;

  // ── PP control & RAPID debugger backbone ─────────────────────────────────

  /** Move PP to a specific routine (or a specific row/col within it). */
  setProgramPointer?(task: string, params: { module?: string; routine: string; row?: number; col?: number }): Promise<void>;
  /** Move PP to cursor position in a module. */
  setPPToCursor?(task: string, module: string, row: number, col: number): Promise<void>;
  /** Step Into / Over / Out - RAPID single-step. */
  stepRapid?(task: string, mode: 'into' | 'over' | 'out'): Promise<void>;
  /** Hold-to-run mode. */
  holdToRun?(task: string, action: 'press' | 'release'): Promise<void>;

  /** List all breakpoints in a task. */
  listBreakpoints?(task: string): Promise<Array<{ module: string; row: number; col?: number }>>;
  /** Set a breakpoint at module/row[/col]. */
  setBreakpoint?(task: string, module: string, row: number, col?: number): Promise<void>;
  /** Remove a breakpoint. */
  removeBreakpoint?(task: string, module: string, row: number, col?: number): Promise<void>;

  // ── Mechunit detailed endpoints ──────────────────────────────────────────

  /** Get the base frame transform for a mechunit. */
  getMechunitBaseFrame?(mechunit?: string): Promise<{ x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }>;
  /** Set the base frame transform. Requires 'edit' mastership. */
  setMechunitBaseFrame?(mechunit: string, frame: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void>;
  /** Per-axis info (count, types, limits). */
  getMechunitAxes?(mechunit?: string): Promise<Array<Record<string, string>>>;
  /** Permanent joint positions (typically external-axes scenarios). */
  getMechunitPjoints?(mechunit?: string): Promise<Record<string, number>>;
  /** Detailed mechunit info (status, mode, sync state, type, axes count). */
  getMechunitInfo?(mechunit?: string): Promise<Record<string, string>>;

  // ── Module detailed endpoints ────────────────────────────────────────────

  /** Get a module's source code via fileservice (returns the full RAPID text). */
  getModuleSource?(task: string, moduleName: string): Promise<string>;
  /** Get a module's metadata (path, attributes, type, lines). */
  getModuleInfo?(task: string, moduleName: string): Promise<Record<string, string>>;
  /** List all symbols (procs/funcs/vars/persistents/consts) defined in a module. */
  listModuleSymbols?(task: string, moduleName: string): Promise<Array<{ name: string; type: string; dattyp?: string }>>;

  // ── Per-task additional endpoints (live-discovered) ─────────────────────

  /** Per-task structural-change counter - increments when symbols/modules change. */
  getTaskStructuralChangeCount?(task: string): Promise<number>;
  /** Per-task motion data (current state of motion in this task). */
  getTaskMotion?(task: string): Promise<Record<string, string>>;
  /** Per-task activation record (call stack / current routine). */
  getTaskActivationRecord?(task: string): Promise<Record<string, string>>;
  /** Per-task program info (loaded program metadata). */
  getTaskProgramInfo?(task: string): Promise<Record<string, string>>;

  // ── Real-time subscriptions ───────────────────────────────────────────────
  /**
   * Subscribe to real-time RWS resource events via WebSocket.
   * Returns an async unsubscribe function - call it on disconnect.
   * Falls back gracefully: if the controller does not support subscriptions,
   * implementations should throw so callers can fall back to polling.
   *
   * `onLost` (optional) is invoked at most once, when the event stream is
   * terminally lost - i.e. the connection dropped and the adapter's reconnect
   * attempts have all failed. Callers should treat it as "events stopped
   * flowing; switch to polling or reconnect". Adapters without reconnect
   * logic may ignore it.
   */
  subscribe(
    resources: SubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    onLost?: () => void,
  ): Promise<() => Promise<void>>;
}

