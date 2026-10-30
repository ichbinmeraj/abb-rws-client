import type {
  ControllerState, OperationMode, ExecutionState, ExecutionCycle,
  ExecutionInfo, CollisionDetectionState, RapidTask, JointTarget, JointTargetFull,
  CartesianFull, RobTarget, SystemInfo, ControllerIdentity, ControllerClock,
  ElogMessage, Signal, IoNetwork, IoDevice, FileEntry,
  RapidSymbolProperties, RapidSymbolInfo, RapidSymbolSearchParams,
  UiInstruction, RestartMode, MastershipDomain,
  SubscriptionResource, SubscriptionEvent, ReturnCodeInfo,
  SignalSearchExCriteria, CfgValidateRequest, ModifyPositionOptions,
  DiagnosticsInfo, UserRegistration, JogParams, RmmpLevel,
  CfgTypeInfo, DipcQueueInfo, FileMetadata, RapidRoutineInfo,
  SubscriptionGroupInfo, SubscriptionGroupMember, MotionSupervisionState, PathSupervisionState,
  MechunitMotorCalib, LeadThroughState, RobotWareCompatibility, CfgInstanceDetail,
} from './types.js';
import type { ControllerJobName } from './controllerJobs.js';

/**
 * Common interface for both RWS1Adapter (IRC5 / RW6) and RWS2Adapter (OmniCore / RW7).
 *
 * Members built from a controller form but never run are marked
 * `@experimental`; members run on one generation only say which.
 * `IRWSAdapterCore` (below) picks the members every generation has run.
 */
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
  /** Lock the operating-mode selection with a PIN (ABB names two UAS grants
   *  for it). Run on RWS 2.0 (RobotWare 7.21.4, 8.1.1, 8.2.1 virtual
   *  controllers); on RWS 1.0 an RW 6.16.03 virtual controller refused it (403
   *  "The required option is missing"), so the RWS 1.0 form is built, not yet run. */
  lockOperationMode(pin: string, permanent?: boolean): Promise<void>;
  /** Unlock the operating-mode selection with the PIN the lock set; both
   *  generations' forms require it, so a call without one is refused
   *  (`INVALID_ARGUMENT`) before sending.
   *  Run on RWS 2.0 (RobotWare 7.21.4, 8.1.1, 8.2.1 virtual controllers); the
   *  RWS 1.0 form is built, not yet run.
   */
  unlockOperationMode(pin?: string): Promise<void>;
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
  /** Run against a controller on both generations. */
  activateRapidTask(task: string): Promise<void>;
  /** Run against a controller on both generations. */
  deactivateRapidTask(task: string): Promise<void>;
  /**
   * Activate / deactivate every task. RWS 1.0 sends ABB's one all-tasks action;
   * RWS 2.0 sends one request per task and throws when any task was refused,
   * naming each refused task with the controller's reason (never resolving
   * over a refusal).
   */
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
  /** The active UI instruction, or null when there is none. Run on both generations. */
  getActiveUiInstruction(): Promise<UiInstruction | null>;
  /**
   * Answer the active UI instruction with one of its own parameters.
   *
   * @experimental Run on RWS 1.0 (RW 6.16.03, 2026-10-13); no logged 2xx on RWS 2.0.
   */
  setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void>;

  // ── Motion ───────────────────────────────────────────────────────────────
  getJointPositions(mechunit?: string): Promise<JointTarget>;
  /**
   * Every axis slot of a mechanical unit - `rax_1..rax_6` and `eax_a..eax_f` -
   * from the same `jointtarget` resource as `getJointPositions`. Implemented on
   * BOTH generations; optional here only so an existing third-party
   * implementation of this interface keeps compiling. 9E9 marks an absent axis
   * (`isJointValuePresent`), but unused slots may also read 0 - see
   * `JointTargetFull`.
   */
  getJointTargetFull?(mechunit?: string): Promise<JointTargetFull>;
  getCartesianFull(mechunit?: string): Promise<CartesianFull>;
  listMechunits(): Promise<string[]>;

  /**
   * Inverse kinematics: compute joint angles from a Cartesian position.
   * Uses the current joint positions as a seed for the solution.
   * Tool and work-object default to tool0/wobj0 (base frame, no offset).
   *
   * Fields: curr_position, curr_orientation, curr_ext_joints, old_rob_joints,
   *   old_ext_joints, robot_fixed_object, tool_frame_position/orientation,
   *   robot_configuration, elog_at_error. RWS 2.0 also sends
   *   wobj_frame_position/orientation, which are not in ABB's field list;
   *   RWS 1.0 no longer does (they made no difference on RW 6.16.03).
   *
   * Units: `pos` in millimetres, joints in degrees, as the cartesian and
   * jointtarget reads give them; `pos` is the tool0 (flange) pose.
   *
   * Tool and work object: `pos` must be the tool0 pose in the base frame
   * (wobj0). The method takes no tool or work object, so it cannot check
   * this: a pose read with another tool or work object is solved as a
   * flange pose at that point, which gives plausible but wrong joints and no
   * error. `getCartesianFull()` (`/cartesian`) takes no tool or work object
   * and is not verified to report tool0 in wobj0 when another tool or work
   * object is active; `getRobTarget(mechunit, 'tool0', 'wobj0')` on either
   * adapter names them in the request.
   *
   * The controller works in SI units (metres, radians). RWS 1.0 converts, and
   * solves on a virtual controller: live-verified 2026-09-30 on RW 6.16.03,
   * where the current pose solves to the current joints. Every call used to be
   * refused there with HTTP 400 "Position outside of reach"
   * (SYS_CTRL_E_POSE_OUTSIDE_REACH, -1073436654) because millimetres and
   * degrees were sent unconverted; that was read as a virtual-controller
   * limitation, and it was not one. RWS 2.0 sent millimetres and degrees
   * unconverted too, and RW 7.21.4 and 8.2.1 refused the current pose the
   * same way (2026-09-30); it now converts to SI units as well, following
   * ABB's RWS 2.0 page, and solves the current pose to the current joints on
   * RW 7.21.4 and 8.2.1 virtual controllers too (live-verified 2026-09-30). A
   * pose out of reach is `INVALID_ARGUMENT` with an `invalid-argument` refusal.
   */
  calcJointsFromCartesian(
    pos: RobTarget,
    seedJoints?: JointTarget,
    mechunit?: string,
  ): Promise<JointTarget>;

  /**
   * Send one jog request, exactly as ABB's jog form lists it: `axis1`..`axis6`
   * from `axes`, `ccount` = the controller's motion-system change count read
   * right before (`GET /rw/motionsystem`), and `inc-mode` from `incMode`
   * (default `Small`). `mode`, `speed` and `mechunit` are not sent: the form
   * has no such fields, and the controller jogs the unit selected for
   * jogging, in that unit's jog mode, at its own jog speed. A named
   * `mechunit` that the controller does not have selected is selected first
   * (`setMechunitForJogging`); the jog is sent only when the motion system,
   * read again, names it (INVALID_ARGUMENT otherwise), and that selection is
   * not restored afterwards. Bad `axes`, `incMode` or unit name (not a RAPID
   * name; on RWS 2.0 also one naming a sibling resource of /rw/motionsystem,
   * such as `jog` or `mechunits`) are refused before anything is sent
   * (INVALID_ARGUMENT).
   *
   * No pre-flight and no access for the jog here. The controller needs motors on, a
   * manual mode, and motion mastership (RobotWare 6/7: in manual mode only
   * after RMMP is granted) or control-station write access plus the
   * motion-control declaration (RobotWare 8). Use `RobotManager.jog`, which
   * holds the access and reads the mode, the motors and (RobotWare 8) the
   * motion-control declaration to explain a refusal; the jog is sent in any
   * mode and the controller decides.
   *
   * Run against a controller on RWS 2.0; on RWS 1.0 built from the controller form and never run.
   */
  jog(params: JogParams): Promise<void>;
  /**
   * Select the mechanical unit that jogging acts on. RWS 2.0
   * `POST /rw/motionsystem/{mechunit}` with no body (ABB Motion_System Rev L);
   * RWS 1.0 `POST /rw/motionsystem?action=set-mechunit` with `mechunit-name`
   * (RW 6.16.03 form, 2026-09-29). Holds motion mastership (RobotWare 8:
   * write access) around the write. `jog()` calls it when the named unit is
   * not the selected one.
   */
  setMechunitForJogging?(mechunit: string): Promise<void>;

  /**
   * This session's RMMP (Request Manual Mode Privileges) privilege: `none`,
   * `pending modify`, `modify` or `exec` (ABB's values), `none` when another
   * user holds it, and `unsupported` on RobotWare 8. A failed read is thrown,
   * never reported as `none`.
   */
  getRmmpPrivilege?(): Promise<string>;

  /**
   * Send an RMMP request (`modify` or `exec`; `'exclusive'` is a deprecated
   * alias of `'exec'`). Returns as soon as the controller accepted it; the
   * operator grants it at the FlexPendant, and ABB deletes the request after
   * 10 s unless it is polled. `RobotManager.requestRmmp` polls and waits.
   * RobotWare 8: UNSUPPORTED_OPERATION, nothing sent.
   *
   * Run against a controller on both generations. RWS 1.0: `modify` was
   * requested and granted at the FlexPendant on a RobotWare 6.16.03 virtual
   * controller in manual mode; only `modify` was asked for there, and
   * `exec` is still to be tried on RobotWare 6.
   */
  requestRmmp?(level?: RmmpLevel | 'exclusive'): Promise<void>;

  /** Poll a pending RMMP request - keeps it alive past ABB's 10 s window and reports its status. */
  pollRmmp?(): Promise<string>;

  /** Cancel this session's pending or held RMMP request. */
  cancelRmmp?(): Promise<void>;

  // ── System info ──────────────────────────────────────────────────────────
  getSystemInfo(): Promise<SystemInfo>;
  getControllerIdentity(): Promise<ControllerIdentity>;
  getControllerClock(): Promise<ControllerClock>;
  /** @experimental Built from the controller form; never run against a controller. */
  setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void>;
  restartController(mode: RestartMode): Promise<void>;

  // ── System detail endpoints ──────────────────────────────────────────────
  /** Active license info from `/rw/system/license`. */
  getLicenseInfo?(): Promise<{ entries: Array<Record<string, string>> }>;
  /** Installed RobotWare products from `/rw/system/products`. */
  listProducts?(): Promise<Array<Record<string, string>>>;
  /**
   * Robot types from `/rw/system/robottype`: `type` the first robot's,
   * `types` every robot's in the controller's order (a MultiMove system lists
   * one per robot; ABB lists standard robots only). `types` is optional so an
   * implementation written against 1.4.0 still compiles; this package's
   * adapters always fill it.
   */
  getRobotType?(): Promise<{ type: string; variant?: string; types?: string[] }>;
  /** Power-consumption stats from `/rw/system/energy` (RW7+). */
  getEnergyStats?(): Promise<Record<string, string>>;

  // ── Return-code lookup ───────────────────────────────────────────────────
  /** Translate a numeric controller return code to its name/description via
   *  `/rw/retcode?code=N` (English only; `lang` is accepted and ignored). */
  getReturnCode?(code: number, lang?: string): Promise<{ code: number; title: string; desc: string } | null>;

  // ── Controller detail endpoints ──────────────────────────────────────────
  /** Detailed installed-options list from `/rw/system/options` (richer than getSystemInfo's options array); the bare `/ctrl/options` carries no list. */
  listControllerOptions?(): Promise<Array<{ name: string; description?: string }>>;
  /** Optional hardware/firmware features from `/ctrl/features`. */
  listFeatures?(): Promise<Array<Record<string, string>>>;

  // ── Motion detail endpoints ─────────────────────────────────────────────
  /** Read the motion-system change counter (required by jog `ccount`). */
  getMotionChangeCount?(): Promise<number>;
  /** Current motion-error state from `/rw/motionsystem/errorstate`. */
  getMotionErrorState?(): Promise<{ state: string; details?: Record<string, string> }>;
  /**
   * Get/set non-motion-execution mode (dry-run).
   *
   * Run against a controller on both generations.
   */
  getNonMotionExecution?(): Promise<boolean>;
  /** @experimental Run against a controller on RWS 2.0; on RWS 1.0 built from the controller form and never run. */
  setNonMotionExecution?(enabled: boolean): Promise<void>;
  /** OmniCore-only: collision-prediction mode. */
  getCollisionPredictionMode?(): Promise<string>;
  /** OmniCore-only. Run against a controller on RWS 2.0. */
  setCollisionPredictionMode?(mode: string): Promise<void>;

  // ── Panel detail endpoints ──────────────────────────────────────────────
  /** Read the enable-request state (relates to deadman / safety chain). */
  getEnableRequest?(): Promise<{ state: string; raw: Record<string, string> }>;

  // ── RAPID detail endpoints ──────────────────────────────────────────────
  /**
   * I/O alias mapping from `/rw/rapid/aliasio`: the aliases the running RAPID
   * program defines, each with its signal and the signal type (DI, DO, AI,
   * AO, GI or GO). ABB's entry class is `rap-alias-io` with `alias-name`,
   * `signal-name` and `type` on both generations.
   *
   * Run against a controller on RWS 1.0, which answered an empty list; on RWS 2.0 built from the controller form and never run.
   */
  listAliasIO?(): Promise<Array<{ alias: string; signal: string; type?: string }>>;
  /**
   * Active task selector from `/rw/rapid/taskselection`: every task, and the
   * ones whose state reads ON. Both generations (ABB's RWS 1.0 "Get user modify
   * from taskpanel" is the same resource and class).
   *
   * Run against a controller on both generations; on RWS 1.0 a RobotWare
   * 6.16.03 virtual controller answered it (2026-10-18).
   */
  getTaskSelection?(): Promise<{ selected: string[]; available: string[] }>;
  /** @experimental No generation has the write: it is refused before sending (UNSUPPORTED_OPERATION). */
  setTaskSelection?(tasks: string[]): Promise<void>;
  /** Program-pointer position for a task. */
  /** Controller device groups (HW_DEVICES, SW_RESOURCES). Both protocols. */
  listDeviceGroups?(): Promise<string[]>;
  /** Devices in one controller device group. Not the same as listDevices, which is I/O. */
  listControllerDevices?(group: string): Promise<Array<{ id: string; name: string }>>;
  /** Translate a controller status code via GET /rw/retcode. Both protocols. */
  describeReturnCode?(code: number): Promise<ReturnCodeInfo | null>;
  getProgramPointer?(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }>;
  /**
   * Motion pointer: the instruction the robot is executing now; the program
   * pointer normally runs ahead of it to prepare the motion. Both generations
   * read the entry ABB titles `motionpointer` in
   * `GET /rw/rapid/tasks/{task}/pcp`, the resource `getProgramPointer` reads;
   * `{}` while the controller reports no position (no program started).
   *
   * @experimental The evidence index does not credit this read: it sends the same request as `getProgramPointer`, whose answer carries this entry with no position when no program has started, and the logs keep no answer body, so a logged 2xx does not show that a position was read. The parsed motion pointer (row 9 col 16, a MoveAbsJ) was logged on RobotWare 6.16.03 and 7.21.4 virtual controllers (2026-10-18).
   */
  getMotionPointer?(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number }>;
  /**
   * One controller environment variable (`HOME`, `TEMP`, `SYSTEM`, ...; a
   * leading `$` is accepted): ABB's `GET /ctrl/${ENVNAME}` on both generations,
   * the `$` sent as `%24`. An unknown name is the controller's 404.
   *
   * Run against virtual controllers on both generations: RobotWare 6.16.03,
   * 7.21.4 and 8.2.1 answered `TEMP`, `HOME` and `BACKUP` (2026-10-18).
   */
  getEnv?(name: string): Promise<string>;
  /**
   * Whether the controller hardware can run a RobotWare version: ABB's
   * `GET /ctrl/compatibility/{robotware version}` on both generations,
   * answered with a `ctrl-compatibility` status of `true` or `false`. A
   * refusal is the controller's typed error, never `compatible: false`.
   * Without a version it asks about the version the controller runs, the
   * `rwversion` of `GET /rw/system`, sent as the controller wrote it.
   * This package's adapters answer `RobotWareCompatibility`. The 1.4.0
   * result, `{ compatible, details? }` (the one 1.4.0's RWS 1.0 adapter
   * had), is taken too, so an adapter of another make written against 1.4.0
   * still compiles; `RobotManager.getCompatibility` fills `status` and
   * `details` for it.
   *
   * @experimental ABB lists it for real controllers only and the virtual controllers answer 404, so it has not run on either generation.
   */
  getCompatibility?(robotWareVersion?: string): Promise<RobotWareCompatibility | { compatible: boolean; details?: Record<string, string> }>;

  // ── Event log ────────────────────────────────────────────────────────────
  getEventLog(domain?: number, lang?: string): Promise<ElogMessage[]>;
  /** Run against a controller on both generations. */
  clearEventLog(domain?: number): Promise<void>;
  /** Run against a controller on both generations. */
  clearAllEventLogs(): Promise<void>;

  // ── I/O ──────────────────────────────────────────────────────────────────
  listAllSignals(start?: number, limit?: number): Promise<Signal[]>;
  readSignal(network: string, device: string, name: string): Promise<Signal>;
  /** One signal by its bare name, `GET /rw/iosystem/signals/{name}`, with no network or device. Both generations (1.6.0). */
  readSignalByName?(name: string): Promise<Signal>;
  /**
   * Set a signal's value. Pass `''` for `network` and `device` to write by the
   * signal's name alone: RWS 1.0 uses the flat signal path; RWS 2.0 finds the
   * signal's network and device, or that it has none, from the controller
   * first (see `RwsClient2.writeSignal`). No mastership or write access is
   * taken; the signal's access level decides.
   *
   * Run against a controller on both generations.
   */
  writeSignal(network: string, device: string, name: string, value: string): Promise<void>;
  /**
   * Simulate a signal (`simulated` true) or end its simulation. RWS 2.0 posts
   * `lstate` to `.../{network}/{device}/{name}/set-lstate`; RWS 1.0 posts it to
   * the signal with `?action=set` (ABB Rev M "Update IO Signal State"), which
   * needs all three segments. No mastership or write access is taken.
   *
   * Run against a controller on RWS 2.0; on RWS 1.0 built from ABB's page and never run.
   */
  setSignalSimulated?(network: string, device: string, name: string, simulated: boolean): Promise<void>;
  /**
   * End the simulation of every simulated signal (ABB's unblock-signal: a
   * sub-path on RWS 2.0, `?action=unblock-signal` on RWS 1.0).
   *
   * Run against a controller on RWS 2.0; on RWS 1.0 built from ABB's page and never run.
   */
  unblockSignals?(): Promise<void>;
  /**
   * Enable or disable an I/O device (`lstate` enable | disable). RWS 1.0 names
   * the device without its network (`network` is not sent there). A disabled
   * device's signals are unavailable until it is enabled again. No mastership
   * or write access is taken.
   *
   * Run against a controller on RWS 2.0; on RWS 1.0 built from ABB's page and never run.
   */
  setIoDeviceLState?(network: string, device: string, enable: boolean): Promise<void>;
  listNetworks(): Promise<IoNetwork[]>;
  listDevices(network: string): Promise<IoDevice[]>;

  // ── File system ──────────────────────────────────────────────────────────
  listDirectory(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  /** A string is sent as UTF-8; a Uint8Array is sent as it is (since 1.5.4). */
  uploadFile(path: string, content: string | Uint8Array): Promise<void>;
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
  /** Every instance of a type with its attributes, every page, from the same
   *  request as `listCfgInstances`. A refusal throws the controller's typed
   *  error instead of answering an empty list. Both generations (1.6.0). */
  listCfgInstancesDetailed?(domain: string, type: string): Promise<CfgInstanceDetail[]>;
  /** Read a single configuration instance - returns the named attributes for that instance. */
  getCfgInstance?(domain: string, type: string, instance: string): Promise<Record<string, string>>;
  /** Update an existing configuration instance. The adapters in this package
   *  hold the configuration lock around it (RobotWare 6: CFG mastership;
   *  RobotWare 7: edit; RobotWare 8: write access), as for every CFG write below.
   *
   * Run against a controller on both generations.
   */
  setCfgInstance?(domain: string, type: string, instance: string, attributes: Record<string, string>): Promise<void>;
  /**
   * Create a new instance of a type (one hold around the create and the attribute set).
   *
   * Run against a controller on both generations.
   */
  createCfgInstance?(domain: string, type: string, instance: string, attributes: Record<string, string>): Promise<void>;
  /**
   * Delete an instance.
   *
   * Run against a controller on both generations.
   */
  removeCfgInstance?(domain: string, type: string, instance: string): Promise<void>;
  /** Load configuration from a `.cfg` file already on the controller's filesystem. */
  loadCfgFile?(filepath: string, action?: 'add' | 'replace' | 'add-with-reset'): Promise<void>;
  /**
   * Save a domain's current state to a `.cfg` file.
   *
   * Run against a controller on both generations.
   */
  saveCfgFile?(domain: string, filepath: string): Promise<void>;

  // ── Backup / Restore `/ctrl/backup` ──────────────────────────────────────

  /** List existing backups in the BACKUP volume. */
  listBackups?(): Promise<Array<{ name: string; created?: string; size?: number }>>;
  /** Trigger a backup. Returns a promise that resolves when the backup is initiated;
   *  use `getBackupStatus()` to poll for completion. */
  createBackup?(name: string): Promise<void>;
  /** Restore from a previous backup. Long-running - controller may restart afterwards.
   *  The backup is kept unless `opts.deleteBackup` is true (ABB's `delete-dir`
   *  on both generations, which the controller otherwise defaults to true).
   *
   * Run against a controller on RWS 1.0; on RWS 2.0 built from the controller form and never run.
   */
  restoreBackup?(name: string, opts?: { deleteBackup?: boolean }): Promise<void>;
  /**
   * Check that a backup can be restored, without restoring it. RWS 2.0
   * `POST /ctrl/backup/check-restore`; RWS 1.0
   * `GET /ctrl/backup?action=check-restore&backup=...` (ABB's RWS 1.0 manual,
   * Rev M; live on RW 6.16.03, 2026-10-10). `backup` is a `/fileservice/` URI
   * on both. Resolves when the controller accepts it (RWS 1.0: status
   * `Accepted`).
   *
   * Run against a controller on both generations.
   */
  checkRestore?(name: string): Promise<void>;
  /** Get current backup-or-restore operation status. */
  getBackupStatus?(): Promise<{ active: boolean; progress?: number; phase?: string; failed?: boolean }>;

  // ── Tool / WObj management ───────────────────────────────────────────────

  /** Currently active tool/wobj/payload for a mechunit. */
  getActiveTool?(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  getActiveWobj?(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  getActivePayload?(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  /**
   * Switch the active tool/wobj - both delegate to the corresponding RAPID symbol.
   *
   * Run against a controller on both generations.
   */
  setActiveTool?(mechunit: string, toolName: string): Promise<void>;
  /** Run against a controller on both generations. */
  setActiveWobj?(mechunit: string, wobjName: string): Promise<void>;

  // ── Service routine / PROC call ──────────────────────────────────────────

  /** Execute a PROC remotely (typically a service routine). Async - returns once execution starts. */
  /** The task's service routines: name and routine URL (`RAPID/{task}/{module}/{routine}`). */
  listServiceRoutines?(task: string): Promise<Array<{ name: string; url: string }>>;
  /** RWS 2.0 has no such operation: the RWS 2.0 adapter throws
   *  `UNSUPPORTED_OPERATION` before sending. Set the program pointer to the
   *  routine and start instead.
   *
   * @experimental No controller runs this: RWS has no such operation, or the controller refuses it.
   */
  callServiceRoutine?(task: string, routineName: string, args?: Record<string, string>): Promise<void>;

  // ── DIPC (Distributed Inter-Process Communication) `/rw/dipc` ────────────

  /** List active DIPC queues. */
  listDipcQueues?(): Promise<Array<{ name: string; size?: number }>>;
  /** Create a DIPC queue (caller's identity becomes the owner). */
  createDipcQueue?(name: string, options?: { maxsize?: number; maxmessages?: number }): Promise<void>;
  /** Send a DIPC message that a RAPID program can read via `RecvDipc`. */
  sendDipcMessage?(queue: string, payload: string, type?: 'string' | 'num' | 'dnum' | 'bool'): Promise<void>;
  /**
   * Read a DIPC message that a RAPID program sent via `SendDipc`. `timeoutMs`
   * is how long the controller waits for a message before it answers (ABB's
   * `timeout`, default 0); the client's own timeout for that one read is
   * extended by it. On RWS 1.0 the wait occupies the client's serial request
   * queue, so every later request on that client waits until the read
   * answers. On RWS 2.0 the requests behind it are not held up.
   *
   * A write despite its name: the controller removes the message from the
   * queue when it is read (ABB DIPC Service Rev L), so no other reader gets
   * it. RWS has no read that leaves it there; `getDipcQueueInfo` reads the
   * queue's counts without taking anything.
   */
  readDipcMessage?(queue: string, timeoutMs?: number): Promise<{ payload: string; type: string } | null>;
  removeDipcQueue?(name: string): Promise<void>;

  // ── Mastership ───────────────────────────────────────────────────────────
  //
  // The adapters in this package take the access each write needs themselves,
  // per operation: RWS1Adapter the RobotWare 6 domain (RAPID writes: rapid;
  // CFG writes: cfg; tool and work object: motion), RWS2Adapter edit and/or
  // motion mastership on RobotWare 7 and the control station's write access on
  // RobotWare 8. A caller that holds the lock already (through the calls below)
  // keeps it: the write requests and releases nothing of its own. Stop and
  // `setControllerState` take nothing here (a stop or motors off never waits
  // for access; `RobotManager.setMotorsOn` holds the RAPID lock for motors on).
  /**
   * Hold `domain` (RobotWare 8: control-station write access, one lock for
   * every domain). The adapters in this package count holds per real lock,
   * shared with their own write wraps: a request for a lock the session
   * already holds sends nothing, and a write made inside the hold never ends
   * it. Pair every request with one `releaseMastership`.
   */
  requestMastership(domain: MastershipDomain): Promise<void>;
  /** End the caller's most recent hold on `domain`'s lock; the release goes on
   *  the wire when no other hold of the session is on it. */
  releaseMastership(domain: MastershipDomain): Promise<void>;
  /**
   * Request mastership on ALL domains at once (counts a hold on each lock).
   *
   * Run against a controller on both generations.
   */
  requestMastershipAll?(): Promise<void>;
  /**
   * Release mastership on ALL domains at once (ends the caller's most recent all-domains hold).
   *
   * Run against a controller on both generations.
   */
  releaseMastershipAll?(): Promise<void>;
  /** Request mastership and receive a numeric ID token (token-based mastership outlives the session that acquired it). */
  requestMastershipWithId?(domain: MastershipDomain): Promise<number>;
  /** Release token-acquired mastership using the ID returned by `requestMastershipWithId()`. */
  releaseMastershipWithId?(domain: MastershipDomain, id: number): Promise<void>;
  /**
   * Reset the edit-mastership watchdog (RWS 2.0). The RWS 2.0 adapter resets
   * it itself while its session holds `edit` mastership on RobotWare 7.8 or
   * later; a hand-made reset is only needed for a hold it does not count
   * (`requestMastershipWithId`). RobotWare 8: `UNSUPPORTED_OPERATION`.
   */
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
   * `calcJointsFromCartesian()`: joints in degrees, pose in millimetres.
   *
   * Both generations send SI units (radians in, metres out) and convert, and
   * both compute the tool0 pose in the base frame only: a `tool` other than
   * 'tool0' or a `wobj` other than 'wobj0' is refused with `INVALID_ARGUMENT`
   * before sending. RWS 1.0 uses the controller's `CalcPoseFromJoints` and
   * solves on a virtual controller (live-verified 2026-09-30 on RW 6.16.03).
   * RWS 2.0 uses ABB's `pose-from-joints` resource (live-verified 2026-09-30
   * on RW 7.21.4 and 8.2.1); an error the controller puts in a 200 answer there
   * is thrown typed by its controller code, with the code kept.
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
  /**
   * Per-system info.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  getVisionSystemInfo?(name: string): Promise<Record<string, string>>;
  /** The job of a vision system. RWS 2.0 has one job name per camera
   *  (`/rw/vision/{camera}/job-name`), so the list has one entry or none;
   *  `active` is not part of the RWS 2.0 resource.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  listVisionJobs?(system: string): Promise<Array<{ name: string; active?: boolean }>>;
  /** Trigger a vision job. Neither RWS 1.0 nor RWS 2.0 documents such an
   *  operation: both clients throw `UNSUPPORTED_OPERATION` before sending.
   *
   * @experimental No ABB operation behind it on either generation; nothing is sent.
   */
  triggerVisionJob?(system: string, job: string): Promise<void>;

  // ── Safety controller `/ctrl/safety` ────────────────────────────────────

  /** Status of the integrated safety controller (PSC option). */
  getSafetyStatus?(): Promise<{ state: string; details?: Record<string, string> }>;
  /** Safety zones. No RWS document has such a resource; both clients answer
   *  [] without a request.
   *  @deprecated To be removed at the next major version.
   *
   * @experimental No ABB resource behind it on either generation; nothing is sent.
   */
  listSafetyZones?(): Promise<Array<Record<string, string>>>;
  /** Start a cyclic brake check. ABB documents only the status read on both
   *  generations (on RWS 2.0 `getCyclicBrakeCheckStatus`); both clients throw
   *  `UNSUPPORTED_OPERATION` before sending. A brake check is started from
   *  RAPID or the FlexPendant.
   *
   * @experimental No ABB operation behind it on either generation; nothing is sent.
   */
  runCyclicBrakeCheck?(): Promise<void>;

  // ── Virtual time `/ctrl/virtualtime` (VC-only) ───────────────────────────

  /** Current virtual time of a virtual controller. `time` is milliseconds
   *  since the VC started; `running` is false only in the controller's VTSTOP
   *  state; `speed` is a factor of real time (1 = real time, `Infinity` = as
   *  fast as possible); `state` is the controller's own word (VTSTOP,
   *  VTFREERUN, VTRUNSLICE, VTNEXTEVENT). */
  getVirtualTime?(): Promise<{ time: number; running: boolean; speed?: number; state?: string }>;
  /** Set the speed as a factor of real time (1 = real time, 10 = ten times,
   *  `Infinity` = as fast as possible). Sent to the controller as a percent.
   *  0, a negative value or NaN is refused (`INVALID_ARGUMENT`). There is no
   *  pause or resume over RWS; use RobotStudio's Simulation tab. RobotWare 6:
   *  refused before sending (`UNSUPPORTED_OPERATION`); the client sends no
   *  virtual-time write there in this release, although ABB documents one. */
  setVirtualTimeScale?(scale: number): Promise<void>;
  /** Sends nothing: the client's adapters throw `UNSUPPORTED_OPERATION`.
   *  Pause and resume the virtual clock from RobotStudio's Simulation tab.
   *  @deprecated Kept so code written for 1.3.x still compiles; removed at the next major version (2.0). */
  setVirtualTimeRunning?(running: boolean): Promise<void>;

  // ── Certificate store `/ctrl/certstore` ──────────────────────────────────

  /** List installed TLS certificates. */
  listCertificates?(): Promise<Array<{ name: string; subject?: string; expires?: string }>>;
  /** Add a PEM-encoded certificate to one store (`name` is the store path,
   *  e.g. 'controller/trust_ca_store'). The RWS 2.0 client uploads the PEM to
   *  $TEMP, posts the form field `filepath` ABB documents, and deletes the
   *  temporary file.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  uploadCertificate?(name: string, pem: string): Promise<void>;
  /** Remove every certificate from one store (`POST .../{scope}/{store}/clear`),
   *  the one removal RWS 2.0 documents. RWS 2.0 only.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  clearCertificateStore?(scope: string, store: string): Promise<void>;
  /** Remove one certificate. RWS has no such operation: the RWS 2.0 client
   *  throws `UNSUPPORTED_OPERATION` before sending.
   *  @deprecated Use `clearCertificateStore`.
   *
   * @experimental No controller runs this: RWS has no such operation, or the controller refuses it.
   */
  removeCertificate?(name: string): Promise<void>;

  // ── Registry `/ctrl/registry` (ABB-internal) ─────────────────────────────

  /** Read controller registry (mostly ABB internal - limited use). */
  getRegistry?(): Promise<Record<string, string>>;

  // ── Compress `/ctrl/compress` ────────────────────────────────────────────

  /**
   * Compress a file/directory on the controller. The controller answers 202
   * and builds the archive after that; this resolves at the 202. To wait for
   * the archive, start it with `startJob`, which returns the job's progress
   * id.
   *
   * Run against a controller on both generations.
   */
  compressPath?(source: string, destination: string): Promise<void>;
  /**
   * Start a controller job, `compressPath` or `decompressPath`, with the same
   * request as that method, and return its progress id, from the
   * `Location: /progress/{id}` header ABB documents on both generations, or
   * `undefined` when the answer has none. To wait for the job, poll
   * `getProgress(id)` until its `state` is no longer `pending` (ABB's
   * finished state is `ready`); `details.code` is then the controller's
   * return code, negative when the job failed. A name that is not one of
   * these jobs is `INVALID_ARGUMENT`, nothing sent. Optional: an adapter of
   * another make written against 1.4.0 has none, and `RobotManager.startJob`
   * then starts the job with the job's own method and answers `undefined`.
   */
  startJob?(name: ControllerJobName, source: string, destination: string): Promise<string | undefined>;
  /**
   * One job the controller runs after answering 202 (a compress, a
   * decompress, a backup), GET /progress/{id}: `state` is `pending` while it
   * runs and `ready` when it is done, `details` the entry's fields (`code`
   * among them). `null` when the read is refused or names no job.
   */
  getProgress?(id: string): Promise<{ state: string; details?: Record<string, string> } | null>;

  // ── File service - additional volumes ───────────────────────────────────

  /** List all available file volumes (HOME, BACKUP, DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP). */
  listFileVolumes?(): Promise<string[]>;

  // ── PP control & RAPID debugger backbone ─────────────────────────────────

  /** Move PP to a specific routine (or a specific row/col within it). */
  setProgramPointer?(task: string, params: { module?: string; routine: string; row?: number; col?: number }): Promise<void>;
  /** Move PP to cursor position in a module. RWS 1.0 also needs the routine
   *  that holds the position; without `routine` it is read from the module text. */
  setPPToCursor?(task: string, module: string, row: number, col: number, routine?: string): Promise<void>;
  /**
   * Move PP back one instruction (manual mode). RWS 2.0 `POST .../pcp/prev-inst`;
   * RWS 1.0 `POST .../pcp?action=set-pp-prev-inst` (RW 6.16.03 form, 2026-09-29).
   *
   * Run against a controller on both generations.
   */
  ppPrevInst?(task: string): Promise<void>;
  /**
   * Move PP forward one instruction (manual mode). RWS 2.0 `POST .../pcp/next-inst`;
   * RWS 1.0 `POST .../pcp?action=set-pp-next-inst` (RW 6.16.03 form, 2026-09-29).
   *
   * Run against a controller on both generations.
   */
  ppNextInst?(task: string): Promise<void>;
  /**
   * Step Into / Over / Out - RAPID single-step: the start with a step execmode
   * on both generations.
   *
   * @experimental RWS 2.0 has a logged 2xx; the RWS 1.0 form is built from ABB's page.
   */
  stepRapid?(task: string, mode: 'into' | 'over' | 'out'): Promise<void>;
  /**
   * Hold to run (manual mode, virtual controller): `press`, then `held` about
   * every 2 s while the motion should go on, then `release`. RWS 2.0
   * `POST /rw/rapid/execution/holdtorun`; RWS 1.0
   * `POST /rw/rapid/execution?action=holdtorun-state`; both send `state`.
   *
   * Run against a controller on RWS 1.0; on RWS 2.0 built from the controller form and never run.
   */
  holdToRun?(task: string, action: 'press' | 'held' | 'release'): Promise<void>;

  /** List all breakpoints in a task. */
  listBreakpoints?(task: string): Promise<Array<{ module: string; row: number; col?: number }>>;
  /**
   * Set a breakpoint at module/row[/col].
   *
   * Run against a controller on both generations.
   */
  setBreakpoint?(task: string, module: string, row: number, col?: number): Promise<void>;
  /**
   * Remove a breakpoint. RWS 2.0 only (RW 6.16.03 advertises no remove form).
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  removeBreakpoint?(task: string, module: string, row: number, col?: number): Promise<void>;

  // ── Mechunit detailed endpoints ──────────────────────────────────────────

  /** Get the base frame transform for a mechunit. */
  getMechunitBaseFrame?(mechunit?: string): Promise<{ x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }>;
  /**
   * Set the base frame transform (x, y, z, q1..q4): it changes the unit's
   * calibration, so read the frame first to be able to write it back. RWS 2.0
   * posts to `.../baseframe` (`RobotManager` holds `edit`, RobotWare 8: write
   * access); RWS 1.0 posts `?action=set` (ABB Rev M "Set Base Frame") under
   * motion mastership, which `RWS1Adapter` takes itself.
   *
   * Run against a controller on both generations; on RWS 1.0 a RobotWare
   * 6.16.03 virtual controller accepted its own frame written back (202),
   * and the frame read back unchanged (2026-10-18).
   */
  setMechunitBaseFrame?(mechunit: string, frame: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void>;
  /** Per-axis info: one entry per axis (`axes/1..N`). On RWS 2.0 each carries
   *  `axis-status` and `logical-axis`; it does NOT carry joint limits. */
  getMechunitAxes?(mechunit?: string): Promise<Array<Record<string, string>>>;
  /** Physical joint values (`pjoints`, j1..j6). Both generations. The RW 6.16.03,
   *  7.21.4 and 8.2.1 virtual controllers state 0..5 whatever the pose (2026-10-01). */
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

  /**
   * Per-task structural-change counter - increments when symbols/modules change.
   *
   * Run against a controller on both generations (RWS 2.0: RobotWare 7.21.4
   * and 8.2.1 virtual controllers, 2026-10-18).
   */
  getTaskStructuralChangeCount?(task: string): Promise<number>;
  /** Per-task motion data (current state of motion in this task). */
  getTaskMotion?(task: string): Promise<Record<string, string>>;
  /**
   * Per-task activation record (call stack / current routine): ABB's
   * `rap-stackframe` entry on both generations, with `execlevel`, `beg-row`,
   * `beg-col`, `end-row`, `end-col`, `stack-url` and `routine-url`.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  getTaskActivationRecord?(task: string): Promise<Record<string, string>>;
  /**
   * Per-task program info (loaded program metadata).
   */
  getTaskProgramInfo?(task: string): Promise<Record<string, string>>;
  /**
   * Unload the program from a task, the counterpart of a program load: RWS 2.0
   * `POST .../program/unload`, RWS 1.0 `POST .../program?action=unloadprog`,
   * no body on either (ABB RWS 2.0 Rev L, RWS 1.0 Rev M). The adapters in this
   * package hold RAPID mastership around it (RobotWare 7: edit; RobotWare 8:
   * write access). `unloadModule` takes out one module only. It takes out
   * every program module of the task and leaves the system modules (RW
   * 6.16.03, 7.21.4 and 8.2.1 answered 204, 2026-10-21).
   */
  unloadProgram?(task: string): Promise<void>;

  // ── Real-time subscriptions ───────────────────────────────────────────────
  /**
   * Subscribe to real-time RWS resource events via WebSocket.
   * Returns an async unsubscribe function - call it on disconnect.
   * Falls back gracefully: if the controller does not support subscriptions,
   * implementations should throw so callers can fall back to polling. Throw
   * an `RwsError` with code `UNSUPPORTED_OPERATION` when the subscribe can
   * never succeed on this connection (the controller or the adapter cannot
   * subscribe at all): since 1.5.1 RobotManager then does not try again on
   * that connection. Any other error is taken as passing, and RobotManager
   * subscribes again while connected, after 5, 10, 20, 40 s, then each
   * minute (10 minutes apart after three group creates in a row that the
   * adapters of this package report as timed out).
   *
   * `onLost` (optional) is invoked at most once, when the event stream is
   * terminally lost - i.e. the connection dropped and the adapter's reconnect
   * attempts have all failed. Callers should treat it as "events stopped
   * flowing; switch to polling or reconnect". Adapters without reconnect
   * logic may ignore it.
   *
   * `onRestored` (optional) is invoked after every successful reconnect of a
   * previously-dropped stream. Events may have been missed during the gap, so
   * callers should resync (e.g. run one immediate full poll).
   *
   * Since 1.5.0 the returned function of both adapters in this package also
   * carries `unbound`, a `readonly string[]` read live: the resources the
   * controller left out of the group it holds now while still creating it
   * (paths as the create answer names them, e.g. `/rw/elog/0`). No event
   * comes for them. RobotManager polls those it reads and says so in
   * `qualityReason`. The declared type stays `() => Promise<void>`, so an
   * adapter of another make need not add it; RobotManager reads a function
   * without it as "everything bound".
   */
  subscribe(
    resources: SubscriptionResource[],
    handler: (event: SubscriptionEvent) => void,
    onLost?: () => void,
    onRestored?: () => void,
  ): Promise<() => Promise<void>>;

  // ── Endpoint-completion surface (2026-08-09) ──────────────────────────────
  // All optional. Most are RWS 2.0 only: those paths answer 404 on the IRC5
  // controllers, so `RWS1Adapter` deliberately does not implement them and they
  // are absent (not throwing) on a RobotWare 6 connection. The EXCEPTIONS are
  // the methods whose own doc says "both generations" - the 2026-08-11 sweep
  // later added live-verified RWS 1.0 support for those. Probe with
  // `adapter.method?.(…)`, or go through `RobotManager`, which reports the
  // unsupported case as a typed `UNSUPPORTED_OPERATION` error for writes.

  /**
   * Panel language (form field `lang-code`). Both generations (live-verified on the RobotWare 6.16 virtual controller, 2026-08-11).
   *
   * Run against a controller on both generations.
   */
  setPanelLanguage?(langCode: string): Promise<void>;
  /**
   * Controller language (form field `lang` - note the different name). Both generations (live-verified on the RobotWare 6.16 virtual controller, 2026-08-11).
   *
   * Run against a controller on both generations.
   */
  setControllerLanguage?(lang: string): Promise<void>;
  /**
   * Simulated EXTERNAL emergency-stop circuit. RWS 2.0 only; `on` closes the
   * circuit, `off` opens it (the stop is active); `active` / `reset` map to
   * off / on. Run live on RW 7.21.4 and 8.2.1 (2026-10-11).
   */
  setExternalEmergencyStop?(state: 'on' | 'off' | 'active' | 'reset'): Promise<void>;
  /**
   * Motors on without the key switch (Keyless Mode Switch option). RWS 2.0
   * posts to `/rw/panel/ctrl-state/keyless-motoron` under `edit` (RobotWare 8:
   * write access); RWS 1.0 posts `state=run` to `/rw/cfg?action=keyless` (ABB
   * Rev M "Keyless motor ON") under RAPID mastership. Each adapter takes the
   * hold itself, as for the ordinary motors-on.
   *
   * Run against a controller on both generations: RWS 2.0 on RobotWare
   * 7.21.4; RWS 1.0 on a RobotWare 6.16.03 virtual controller, which answered
   * 204 and read motors on 1.1 s later (2026-10-18).
   */
  setKeylessMotorOn?(): Promise<void>;

  /** Replace a module's source in place (write side of `getModuleText`). Both
   *  generations (RWS 1.0: `?action=set-module-text`).
   *
   * Run against a controller on both generations.
   */
  setModuleText?(task: string, module: string, text: string, path?: string): Promise<void>;
  /** Replace a row/column range of a module's source in place. Both generations
   *  (RWS 1.0: `?action=set-text-range`).
   *
   * Run against a controller on both generations.
   */
  setModuleTextRange?(
    task: string, module: string,
    range: { startRow: number; startCol: number; endRow: number; endCol: number },
    text: string,
    opts?: { replaceMode?: string; queryMode?: string },
  ): Promise<void>;

  /**
   * Two-criteria signal search. The second criteria set NARROWS the first
   * (logical AND), and there is no glob support. `name` / `name2` are
   * case-insensitive PREFIX matches, not substring matches; `device`, `network`
   * and `category` match whole values (2026-09-27, RW 6.16, 7.21, 8.1.1). Both
   * generations: RWS 2.0 via the `signal-search-ex` path-action (hits paged at
   * 100, every page read), RWS 1.0 via `?action=signal-searchex`
   * (live-verified on the RobotWare 6.16 virtual controller, 2026-08-11). The single-criteria
   * `searchSignals` is likewise available on both generations.
   */
  searchSignalsEx?(criteria: SignalSearchExCriteria[]): Promise<Signal[]>;
  /**
   * Validate CFG instances that already exist. RWS 2.0 only.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  validateCfgInstances?(request: CfgValidateRequest): Promise<boolean>;

  /** Collision-prediction model name; robot numbering is zero-based. RWS 2.0 only. */
  getCollisionPredictionModelName?(robotNumber?: number): Promise<string>;
  /**
   * Write a collision-avoidance snapshot to a controller file. RWS 2.0 only.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  saveCollisionAvoidanceSnapshot?(filePath: string, motionGroup: string): Promise<void>;
  /**
   * Reload the collision-avoidance configuration. RWS 2.0 only, and it needs the controller option.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  loadCollisionAvoidanceConfig?(): Promise<void>;

  /** ModPos - rewrite a robtarget in place. RWS2Adapter holds edit mastership
   *  (RobotWare 8: write access) around it; ABB also requires a local client in
   *  manual mode. RWS 2.0 only.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  modifyPosition?(task: string, module: string, opts: ModifyPositionOptions): Promise<void>;
  /** Reset ONE task's program pointer (not the global resetpp). Held under edit
   *  mastership (RobotWare 8: write access). RWS 2.0 only.
   *
   * Run against a controller on RWS 2.0.
   */
  resetTaskProgramPointer?(task: string): Promise<void>;

  /**
   * Saved controller diagnostics; `empty` when the controller has none. RWS 2.0 only.
   * The RobotWare 7 and 8 virtual controllers, with nothing saved, answer 400
   * "No Diagnostics Saved", which is read as `empty`.
   *
   * @experimental Built from the controller form; no logged 2xx on any controller (only the empty-state 400).
   */
  getDiagnostics?(): Promise<DiagnosticsInfo>;
  /**
   * Ask the controller to save a diagnostics bundle. RWS 2.0 only.
   *
   * Run against a controller on RWS 2.0.
   */
  saveDiagnostics?(destination?: string): Promise<void>;
  /**
   * Copy the system's installation files (RMF, RSF, RLF) into a controller
   * directory, which the caller cleans up. `fileType` is optional, as in ABB's
   * form (for example `FileType_RMF` or `[FileType_RMF,FileType_RSF]`);
   * without it the controller copies every type. Returns nothing, as in
   * 1.4.0; list the directory to see the copied files. RWS 2.0 only; ABB
   * lists it for real controllers only, and the virtual controllers refuse
   * it (403).
   *
   * @experimental Built from the controller form; no logged 2xx on any controller.
   */
  saveSystemInfo?(path: string, fileType?: string): Promise<void>;

  /**
   * Register this session's user alias, application and location (free text)
   * as a local or remote client; no UAS data changes. RWS 2.0 only in this
   * client: ABB's RWS 1.0 documents `POST /users`, which is not wrapped.
   * A given `reg.locale` is sent as `ulocale`, and the controller decides;
   * ABB's values are `local` and `remote`. Without one no `ulocale` is sent,
   * which RW 7.21.4 and 8.2.1 refuse (400); `remote` answered 201 on both
   * (2026-10-21).
   */
  registerUser?(reg: UserRegistration): Promise<void>;
  /**
   * Act as another session's UAS user, given its uid (ABB: same credentials,
   * same machine). RWS 2.0 only in this client: ABB's RWS 1.0 documents
   * `POST /users?action=impersonate`, which is not wrapped.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  impersonateUser?(uid: string): Promise<void>;
  /** Whether the current user may change their own password. RWS 2.0 only. */
  isPasswordChangeAllowed?(): Promise<boolean>;
  /**
   * Change the current user's password. RWS 2.0 only: RWS 1.0 has no password
   * operation.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  changePassword?(oldPassword: string, newPassword: string): Promise<void>;

  // UAS user and role reads. RWS 2.0 only (the /uas prefix answers 404 on
  // RW 6.16.03). ABB gates them on a UAS grant (UAS_UAS_ADMINISTRATION on its
  // RWS pages). The OmniCore Default User, which lacks it, was refused 403
  // (GRANT_DENIED) for the users and roles listings, a user's enable flag and
  // description, and a role's grants and description, and was answered for a
  // user's sub-resources, grants, roles and password-change flag and a role's
  // sub-resources (RW 7.21.4 and 8.2.1, 2026-10-01). Admin, which holds the
  // grant, was answered for those six refused reads on RW 7.21.4 and 8.2.1
  // virtual controllers (2026-10-18).
  /** UAS users defined on the controller (all pages). RWS 2.0 only. */
  listUasUsers?(): Promise<Array<{ name: string; description?: string }>>;
  /** Sub-resource titles of one UAS user (description, enable, roles, ...). RWS 2.0 only. */
  getUasUser?(user: string): Promise<string[]>;
  /** Grants one UAS user holds. RWS 2.0 only. */
  listUasUserGrants?(user: string): Promise<string[]>;
  /** Roles one UAS user belongs to. RWS 2.0 only. */
  listUasUserRoles?(user: string): Promise<string[]>;
  /** Whether one UAS user is enabled. RWS 2.0 only. */
  isUasUserEnabled?(user: string): Promise<boolean>;
  /** One UAS user's description. RWS 2.0 only. */
  getUasUserDescription?(user: string): Promise<string>;
  /** Whether a named UAS user may change their password. RWS 2.0 only. */
  isUasUserPasswordChangeAllowed?(user: string): Promise<boolean>;
  /** UAS roles defined on the controller (all pages). RWS 2.0 only. */
  listUasRoles?(): Promise<Array<{ name: string; description?: string }>>;
  /** Sub-resource titles of one UAS role (description, grants). RWS 2.0 only. */
  getUasRole?(role: string): Promise<string[]>;
  /** Grants one UAS role carries. RWS 2.0 only. */
  listUasRoleGrants?(role: string): Promise<string[]>;
  /** One UAS role's description. RWS 2.0 only. */
  getUasRoleDescription?(role: string): Promise<string>;

  /**
   * Add resources to a live subscription group, or change their priorities,
   * without tearing the group down. Returns the initial-event payload for the
   * added resources. Both generations: additive on RW 8.1.1 (2026-08-09) and
   * on RW 6.16.03, 7.21.4 and 8.2.1 (2026-10-01).
   */
  updateSubscriptionGroup?(groupPath: string, resources: SubscriptionResource[]): Promise<string>;
  /**
   * Drop ONE resource from a live subscription group:
   * `DELETE /subscription/{group}/{resource}` on both generations, the
   * resource as it was subscribed (`;suffix` included).
   *
   * Run against a controller on both: RW 6.16.03 answered 200 and the
   * dropped resource sent no more events (2026-10-21).
   */
  unsubscribeResource?(groupPath: string, resource: SubscriptionResource): Promise<void>;

  // ── Endpoint-completion surface (2026-08-11) - both generations ────────────
  // Unlike the 2026-08-09 block, every method here exists on BOTH IRC5/RW6
  // (RWS 1.0 `?action=` query-actions) and OmniCore/RW7-8 (RWS 2.0
  // path-actions), so both concrete adapters implement them. Each member's doc
  // says where no logged call has succeeded yet. Optional so the
  // interface stays additive; in practice both adapters always provide them, so
  // `RobotManager` forwards them unconditionally (throwing only NOT_CONNECTED).

  /** Server-side signal search (case-insensitive PREFIX match on name, whole-value
   *  device/network/category, AND-composed criteria; no criteria = every signal;
   *  RWS 2.0 pages at 100 and every page is read). Both generations. */
  searchSignals?(criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Promise<Signal[]>;
  /** Search I/O devices by name / lstate / network (`?action=search` on both). Both generations. */
  searchIoDevices?(criteria: { name?: string; lstate?: 'enabled' | 'disabled' | 'unknown'; network?: string }): Promise<IoDevice[]>;
  /** Rename a file/directory in place (parent dir unchanged). Both generations. */
  renameFile?(path: string, newName: string): Promise<void>;
  /** Read a module's full source text plus its change-count (read side of `setModuleText`). Both generations. */
  getModuleText?(task: string, module: string): Promise<{ text: string; changeCount: number }>;
  /** Read a row/column span of a module's source (read side of `setModuleTextRange`). Both generations. */
  getModuleTextRange?(task: string, module: string, startRow: number, startCol: number, endRow: number, endCol: number): Promise<string>;
  /** Whether a previously-read motion change-count still matches the controller's. Both generations. */
  checkMotionChangeCount?(changecount: number): Promise<boolean>;
  /**
   * Dump the raw event log to a controller file. Both generations.
   *
   * Run against a controller on both generations.
   */
  saveEventLogRaw?(destination: string): Promise<void>;
  /**
   * Decompress a controller archive (mirror of `compressPath`). Both generations.
   * Resolves at the controller's 202; `startJob('decompressPath', ...)`
   * returns the job's progress id. Wait for the compress job before
   * decompressing its archive.
   *
   * @experimental Built from the controller form; never run against a controller.
   */
  decompressPath?(source: string, destination: string): Promise<void>;
  /** Virtual-time timeslice in ms (VC diagnostic). Both generations. */
  getVirtualTimeTimeslice?(): Promise<number>;

  /** Validate a `.cfg` file already on the controller without loading it. Both
   *  generations: RWS 1.0 `/rw/cfg?action=validate`, RWS 2.0 `/rw/cfg/validate`. */
  validateCfgFile?(filepath: string, actionType?: 'add' | 'replace' | 'add-with-reset'): Promise<void>;
  /** Dry-run a CFG instance delete to check for references before removing it. RWS 1.0 only. */
  validateInstanceBeforeDelete?(name: string): Promise<void>;

  // ── Common reads, both generations (2026-10-01) ─────────────────────────
  // Optional because an adapter built outside this package may lack them;
  // RWS1Adapter and RWS2Adapter both implement every one. RobotManager
  // answers an empty value when the adapter has none.

  /** One RAPID task's state and properties (`GET /rw/rapid/tasks/{task}`). Both generations. */
  getRapidTask?(task: string): Promise<Record<string, string>>;
  /** One configuration type's attribute and instance counts (`GET /rw/cfg/{domain}/{type}`). Both generations. */
  getCfgType?(domain: string, type: string): Promise<CfgTypeInfo>;
  /** The attribute definitions of a configuration type (`.../{type}/attributes`). Both generations. */
  listCfgTypeAttributes?(domain: string, type: string): Promise<Array<Record<string, string>>>;
  /** A DIPC queue's information; null when the queue does not exist. Both generations
   *  (RWS 2.0 `/rw/dipc/{queue}/information`, RWS 1.0 `GET /rw/dipc/{queue}`). */
  getDipcQueueInfo?(queue: string): Promise<DipcQueueInfo | null>;
  /** One I/O network. Both generations. */
  getIoNetwork?(network: string): Promise<Record<string, string>>;
  /** One I/O device. Both generations; RWS 1.0 names the device without its network
   *  (`/rw/iosystem/devices/{device}`), so `network` is not sent there. */
  getIoDeviceInfo?(network: string, device: string): Promise<Record<string, string>>;
  /** One signal's configuration (its EIO_SIGNAL instance, the `ios-signal-config-general`
   *  entry). Both generations: RWS 2.0 `.../signals/{n}/{d}/{s}/config`, RWS 1.0 the
   *  signal with `?resource=config` (RW 6.16.03, 2026-10-03). */
  getSignalConfig?(network: string, device: string, name: string): Promise<Record<string, string>>;
  /** One I/O network's configuration (`ios-network-config-general`). Both generations
   *  (RWS 1.0 `?resource=config` on the network). */
  getIoNetworkConfig?(network: string): Promise<Record<string, string>>;
  /** One I/O device's configuration (`ios-device-config-general`). Both generations;
   *  RWS 1.0 names the device without its network, so `network` is not sent there. */
  getIoDeviceConfig?(network: string, device: string): Promise<Record<string, string>>;
  /** The routines (PROC/FUNC/TRAP) of one module, `type` = prc/fun/trp. Both generations,
   *  through the module-scoped symbol search (RW 6.16.03, 7.21.4 and 8.2.1 listed a PROC,
   *  a FUNC and a TRAP, 2026-10-01; RWS 2.0 `.../modules/{module}/routine` reads the
   *  routine at a text position and is not used). */
  listModuleRoutines?(task: string, moduleName: string): Promise<RapidRoutineInfo[]>;
  /** A file's metadata without downloading it. Both generations (RWS 2.0 HEAD,
   *  RWS 1.0 the file's entry in its parent directory's listing). */
  getFileMetadata?(path: string): Promise<FileMetadata>;

  // ── Niche reads, both generations (2026-10-01) ──────────────────────────
  // Optional for the same reason as the common reads above; RWS1Adapter and
  // RWS2Adapter both implement every one. RobotManager answers an empty value
  // when the adapter has none.

  /** The session's subscription groups (`GET /subscription`). Both generations. */
  listSubscriptionGroups?(): Promise<SubscriptionGroupInfo[]>;
  /** The resources bound to one group (`GET /subscription/{group}`); `group` is the id or
   *  `/subscription/{id}`. Both generations. */
  getSubscriptionGroup?(group: string): Promise<SubscriptionGroupMember[]>;
  /** Motion (jog) supervision of a mechunit. Both generations (RWS 2.0 per mechunit,
   *  RWS 1.0 `/rw/motionsystem/motionsupervision?mechunit=`). */
  getMotionSupervision?(mechunit?: string): Promise<MotionSupervisionState>;
  /** Path supervision of a mechunit. Both generations (RWS 2.0 per mechunit,
   *  RWS 1.0 `/rw/motionsystem/pathsupervision?mechunit=`). */
  getPathSupervision?(mechunit?: string): Promise<PathSupervisionState>;
  /** A mechunit's serial measurement board data (`.../smbdata`). Both generations. */
  getMechunitSmbData?(mechunit?: string): Promise<Record<string, string>>;
  /** A mechunit's motor calibration names, one per joint (`.../motorcalib`). Both generations. */
  getMechunitMotorCalib?(mechunit?: string): Promise<MechunitMotorCalib[]>;
  /** A mechunit's compliance lead-through state. Both generations (RWS 2.0 `.../lead-through`,
   *  RWS 1.0 `.../{mechunit}?resource=lead-through`). */
  getLeadThrough?(mechunit?: string): Promise<LeadThroughState>;
}

/**
 * The surface every generation has run against a controller: the core and
 * common members of `IRWSAdapter` whose requests have a logged success (a 2xx
 * in a probe log or a functional-test trace) on each generation that has
 * them, plus the connection and subscription members. Same signatures and the same optional
 * members as `IRWSAdapter`, so every `IRWSAdapter` is an `IRWSAdapterCore`.
 * Type a reference with it to stay on operations that have run; the
 * README's Known limits section lists the operations that have not.
 */
export interface IRWSAdapterCore extends Pick<IRWSAdapter,
  | 'connect'
  | 'disconnect'
  | 'getSessionCookie'
  | 'subscribe'
  | 'getControllerState'
  | 'setControllerState'
  | 'getOperationMode'
  | 'getSpeedRatio'
  | 'setSpeedRatio'
  | 'getCollisionDetectionState'
  | 'setOperationMode'
  | 'getRapidExecutionState'
  | 'getRapidExecutionInfo'
  | 'startRapid'
  | 'stopRapid'
  | 'resetRapid'
  | 'setExecutionCycle'
  | 'getRapidTasks'
  | 'activateAllRapidTasks'
  | 'deactivateAllRapidTasks'
  | 'listModules'
  | 'listModulesDetailed'
  | 'loadModule'
  | 'unloadModule'
  | 'unloadProgram'
  | 'getRapidVariable'
  | 'setRapidVariable'
  | 'getActiveUiInstruction'
  | 'validateRapidValue'
  | 'getRapidSymbolProperties'
  | 'searchRapidSymbols'
  | 'getActiveUiInstruction'
  | 'getJointPositions'
  | 'getJointTargetFull'
  | 'getCartesianFull'
  | 'listMechunits'
  | 'calcJointsFromCartesian'
  | 'setMechunitForJogging'
  | 'getRmmpPrivilege'
  | 'requestRmmp'
  | 'pollRmmp'
  | 'cancelRmmp'
  | 'getSystemInfo'
  | 'getControllerIdentity'
  | 'getControllerClock'
  | 'restartController'
  | 'getRobotType'
  | 'listControllerOptions'
  | 'getMotionChangeCount'
  | 'getMotionErrorState'
  | 'getProgramPointer'
  | 'getEventLog'
  | 'listAllSignals'
  | 'readSignal'
  | 'readSignalByName'
  | 'listNetworks'
  | 'listDevices'
  | 'listDirectory'
  | 'readFile'
  | 'uploadFile'
  | 'deleteFile'
  | 'createDirectory'
  | 'copyFile'
  | 'listCfgDomains'
  | 'listCfgTypes'
  | 'listCfgInstances'
  | 'getCfgInstance'
  | 'loadCfgFile'
  | 'createBackup'
  | 'getBackupStatus'
  | 'getActiveTool'
  | 'getActiveWobj'
  | 'getActivePayload'
  | 'listServiceRoutines'
  | 'listDipcQueues'
  | 'createDipcQueue'
  | 'sendDipcMessage'
  | 'readDipcMessage'
  | 'removeDipcQueue'
  | 'requestMastership'
  | 'releaseMastership'
  | 'getMastershipStatus'
  | 'listMastershipDomains'
  | 'listAllIoDevices'
  | 'calcCartesianFromJoints'
  | 'listFileVolumes'
  | 'setProgramPointer'
  | 'listBreakpoints'
  | 'getMechunitBaseFrame'
  | 'getMechunitAxes'
  | 'getMechunitInfo'
  | 'getModuleInfo'
  | 'getTaskMotion'
  | 'getTaskProgramInfo'
  | 'searchSignalsEx'
  | 'getUasUser'
  | 'listUasUserGrants'
  | 'listUasUserRoles'
  | 'updateSubscriptionGroup'
  | 'searchSignals'
  | 'searchIoDevices'
  | 'renameFile'
  | 'getModuleText'
  | 'getModuleTextRange'
  | 'checkMotionChangeCount'
  | 'validateCfgFile'
  | 'getRapidTask'
  | 'getCfgType'
  | 'listCfgTypeAttributes'
  | 'getDipcQueueInfo'
  | 'getIoNetwork'
  | 'getIoDeviceInfo'
  | 'getSignalConfig'
  | 'getIoNetworkConfig'
  | 'getIoDeviceConfig'
  | 'listModuleRoutines'
  | 'getFileMetadata'
  // Live on RWS 2.0 since the 2026-10-11 write run on RW 7.21.4 (already live on RWS 1.0).
  | 'activateRapidTask'
  | 'deactivateRapidTask'
  | 'setModuleText'
  | 'setModuleTextRange'
  | 'setPPToCursor'
  | 'ppPrevInst'
  | 'ppNextInst'
  | 'resetTaskProgramPointer'
  | 'setBreakpoint'
  | 'setActiveTool'
  | 'setActiveWobj'
  | 'clearEventLog'
  | 'saveEventLogRaw'
  | 'setCfgInstance'
  | 'createCfgInstance'
  | 'removeCfgInstance'
  | 'saveCfgFile'
  | 'checkRestore'
  | 'requestMastershipAll'
  | 'releaseMastershipAll'
  // Live on RWS 1.0 since the 2026-10-12 signal write on RW 6.16.03 (network/device form).
  | 'writeSignal'
  // Live on every generation they have since the 2026-10-18 traced reads on RW 6.16.03,
  // 7.21.4 and 8.2.1 virtual controllers.
  | 'getTaskSelection'
  | 'getTaskStructuralChangeCount'
  | 'listUasUsers'
  | 'listUasRoles'
  | 'listUasRoleGrants'
> {}
