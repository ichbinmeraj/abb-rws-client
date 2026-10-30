/**
 * The hand-written part of the operation catalogue (1.6.0), read by
 * scripts/gen-operations.mjs. Everything else in src/operations/generated.ts
 * comes from the path tables and the method signatures.
 *
 * The default route of a table row `<domain>.<id>` is RobotManager's public
 * method `id` when there is one (its access handling and refusals apply),
 * else the adapter's method `id`. ROUTE_EXCEPTIONS lists the rows that go
 * elsewhere, each with its reason. Access, mastership, RMMP and subscription
 * rows get no route, and neither does a row with no side on either
 * generation: the generator gives them `via: 'none'`.
 */

/** Rows whose route is not the default one. */
export const ROUTE_EXCEPTIONS = {
  // RobotManager.getMastershipStatus answers null for every error.
  'systemMastership.getMastershipStatus': { via: 'adapter', method: 'getMastershipStatus' },
  // RobotManager.getControllerClock answers the date and time text alone.
  'ctrl.getControllerClock': { via: 'adapter', method: 'getControllerClock' },
  // RobotManager.loadProgram is the module push (rapid.pushModule). This row
  // loads a program file already on the controller.
  'rapid.loadProgram': { via: 'adapter', method: 'loadProgram' },
  // The motors go on and off through the manager: on under RAPID access, off
  // sent first without waiting for it.
  'panel.setControllerState': {
    via: 'manager-by-arg', arg: 0, methods: { motoron: 'setMotorsOn', motoroff: 'setMotorsOff' },
    params: { via: 'adapter', method: 'setControllerState' },
  },
  // A write by the signal's name alone: the manager's, which keeps its signal
  // table current (RWS 2.0 learns the network and device first, see the row's note).
  'io.writeSignalByName': { via: 'manager', method: 'writeIoSignal' },
  // One read answers the clock, the state and the scale together.
  'ctrl.getVirtualTimeClock': { via: 'adapter', method: 'getVirtualTime' },
  'ctrl.getVirtualTimeState': { via: 'adapter', method: 'getVirtualTime' },
  'ctrl.getVirtualTimeScale': { via: 'adapter', method: 'getVirtualTime' },
  // The operating-mode confirmation is the person's, at the FlexPendant: the
  // RWS 1.0 side is a deliberate gap and setOperationMode never sends it.
  'panel.acknowledgeOperationMode': { via: 'none', reason: 'person' },
};

/**
 * Writes whose RobotWare 8 write access is not the generator's default. A
 * stop is never held up behind another write or refused for a holder: the
 * simulated panel inputs (stops, the enabling device) are sent as their
 * RobotManager methods send them, without write access.
 */
export const RW8_ACCESS_EXCEPTIONS = {
  'panel.setExternalEmergencyStop': 'none',
  'panel.simEmergencyStop': 'none',
  'panel.simGeneralStop': 'none',
  'panel.simAutoStop': 'none',
  'panel.simEnableSwitch': 'none',
};

/**
 * What the client sends with no table row of its own: the module push, the
 * return codes, the device tree, the backup list, the controller jobs and a
 * module's source. Keys never collide with a row's (the generator checks).
 */
export const COMPOSITES = [
  {
    domain: 'rapid', id: 'pushModule', tier: 'core', effect: 'write', generations: ['rws1', 'rws2'],
    summary: 'Push a module file from the PC that runs the client into a task, replacing a module of the same name.',
    // No adapter pre-check: loadProgram sends the module through the adapter's upload and load.
    route: { via: 'manager', method: 'loadProgram', adapterMethod: null },
    sends: ['rapid.getRapidExecutionState', 'rapid.stopRapid', 'rapid.listModules', 'rapid.unloadModule', 'filesVision.uploadFile', 'rapid.loadModule', 'rapid.resetRapid'],
    note: 'The path is a file on the PC that runs the client, not on the controller. A running program is stopped only with stopIfRunning; without it the load is sent and the controller decides. The program pointer moves to main when the module has a main routine, unless resetPP is false. The uploaded file stays on the controller.',
  },
  {
    domain: 'rapid', id: 'getModuleSource', tier: 'common', effect: 'write', generations: ['rws1', 'rws2'],
    summary: 'The source text of a loaded module.',
    route: { via: 'adapter', method: 'getModuleSource' },
    sends: ['rapid.saveModule', 'filesVision.readFile', 'filesVision.deleteFile', 'rapid.getModuleInfo'],
    note: 'A write: the module is saved to a temporary file on the controller, read and deleted. When the save is refused, the module file in HOME is read instead (on RWS 2.0 the file the module info names).',
  },
  {
    domain: 'ctrl', id: 'describeReturnCode', tier: 'common', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'A controller return code in words, with its severity.',
    route: { via: 'adapter', method: 'describeReturnCode' },
    sends: [], wire: 'GET /rw/retcode?code={code}',
  },
  {
    domain: 'ctrl', id: 'getReturnCode', tier: 'niche', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'A controller return code with its title and description.',
    route: { via: 'adapter', method: 'getReturnCode' },
    sends: [], wire: 'GET /rw/retcode?code={code}',
  },
  {
    domain: 'ctrl', id: 'listDeviceGroups', tier: 'niche', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'The device groups of the controller.',
    route: { via: 'manager', method: 'listDeviceGroups' },
    sends: [], wire: 'GET /rw/devices',
  },
  {
    domain: 'ctrl', id: 'listControllerDevices', tier: 'niche', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'The devices of one device group.',
    route: { via: 'manager', method: 'listControllerDevices' },
    sends: [], wire: 'GET /rw/devices/{group}',
  },
  {
    domain: 'ctrl', id: 'listSystemDevices', tier: 'niche', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'The system devices of the controller.',
    route: { via: 'manager', method: 'listSystemDevices' },
    sends: [], wire: 'GET /rw/devices/system',
  },
  {
    domain: 'ctrl', id: 'getDeviceTree', tier: 'niche', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'The device tree of one group, as the controller sends it.',
    route: { via: 'adapter', method: 'getDeviceTree' },
    sends: [], wire: 'GET /rw/devices/{group}',
  },
  {
    domain: 'ctrl', id: 'searchDevices', tier: 'niche', effect: 'read', generations: ['rws2'],
    summary: 'The devices with a property, a search that changes nothing.',
    route: { via: 'adapter', method: 'searchDevices' },
    sends: [], wire: 'POST /rw/devices/search',
  },
  {
    domain: 'ctrl', id: 'listBackups', tier: 'common', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'The backups in the controller BACKUP folder.',
    route: { via: 'adapter', method: 'listBackups' },
    sends: [], wire: 'GET /fileservice/BACKUP',
  },
  {
    domain: 'ctrl', id: 'startJob', tier: 'niche', effect: 'write', generations: ['rws1', 'rws2'],
    summary: 'Start a controller job (compress or decompress) and answer its progress id.',
    // No adapter pre-check: startJob falls back to compressPath or decompressPath, and refuses typed without them.
    route: { via: 'manager', method: 'startJob', adapterMethod: null },
    sends: ['ctrl.compressPath', 'ctrl.decompressPath'],
  },
  {
    domain: 'ctrl', id: 'getProgress', tier: 'niche', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'One controller job by the progress id startJob answered.',
    route: { via: 'manager', method: 'getProgress' },
    sends: [], wire: 'GET /progress/{id}',
  },
  {
    domain: 'ctrl', id: 'listProgress', tier: 'niche', effect: 'read', generations: ['rws1', 'rws2'],
    summary: 'The controller jobs in progress.',
    route: { via: 'adapter', method: 'listProgress' },
    sends: [], wire: 'GET /progress',
  },
];

/**
 * The read that verifies each write, by key, or null where no read shows the
 * write landed. `args` names the write's parameters the read takes, in the
 * read's order; omitted, the read's parameters are matched to the write's by
 * name. `partial: true` accepts a read that has fewer generations than the
 * write: the generated read-back lists the generations it covers. Every write
 * must be listed (the generator checks).
 *
 * Null is the honest answer where a read would claim more than it shows: a
 * step ends stopped whatever it did, a deleted file reads as an error, a
 * restart takes the session down, a file saved for later is not read back.
 */
export const READ_BACKS = {
  'panel.setControllerState': 'panel.getControllerState',
  'panel.setOperationMode': 'panel.getOperationMode',
  // The lock state is an RWS 2.0 read: on RobotWare 6 the lock is not read back.
  'panel.lockOperationMode': { key: 'panel.getOperationModeLockState', partial: true },
  'panel.unlockOperationMode': { key: 'panel.getOperationModeLockState', partial: true },
  'panel.setSpeedRatio': 'panel.getSpeedRatio',
  'panel.setPanelLanguage': null,
  'panel.setKeylessMotorOn': 'panel.getControllerState',
  'panel.setExternalEmergencyStop': null,
  'panel.simEmergencyStop': null,
  'panel.simGeneralStop': null,
  'panel.simAutoStop': null,
  'panel.simEnableSwitch': null,
  'panel.restartController': null,

  'rapid.startRapid': 'rapid.getRapidExecutionState',
  'rapid.stopRapid': 'rapid.getRapidExecutionState',
  'rapid.resetRapid': null,
  'rapid.setExecutionCycle': 'rapid.getRapidExecutionInfo',
  'rapid.startProductionEntry': 'rapid.getRapidExecutionState',
  'rapid.stepRapid': null,
  'rapid.holdToRun': null,
  'rapid.activateRapidTask': 'rapid.getRapidTask',
  'rapid.deactivateRapidTask': 'rapid.getRapidTask',
  'rapid.activateAllRapidTasks': 'rapid.getRapidTasks',
  'rapid.deactivateAllRapidTasks': 'rapid.getRapidTasks',
  'rapid.loadProgram': 'rapid.getTaskProgramInfo',
  'rapid.unloadProgram': { key: 'rapid.getTaskProgramInfo', args: ['taskName'] },
  'rapid.saveProgram': null,
  'rapid.loadModule': 'rapid.listModules',
  'rapid.unloadModule': { key: 'rapid.listModules', args: ['taskName'] },
  'rapid.saveModule': null,
  'rapid.setModuleText': 'rapid.getModuleText',
  'rapid.setModuleTextRange': 'rapid.getModuleText',
  'rapid.modifyPosition': null,
  'rapid.setRapidVariable': 'rapid.getRapidVariable',
  'rapid.setUiInstructionParam': null,
  'rapid.setProgramPointer': 'rapid.getProgramPointer',
  'rapid.setPPToCursor': 'rapid.getProgramPointer',
  'rapid.ppPrevInst': 'rapid.getProgramPointer',
  'rapid.ppNextInst': 'rapid.getProgramPointer',
  'rapid.setPPToRoutineFromUrl': 'rapid.getProgramPointer',
  'rapid.resetTaskProgramPointer': 'rapid.getProgramPointer',
  'rapid.setBreakpoint': 'rapid.listBreakpoints',
  'rapid.removeBreakpoint': 'rapid.listBreakpoints',
  'rapid.pushModule': { key: 'rapid.listModules', args: ['taskName'] },
  'rapid.getModuleSource': null,

  'motion.setActiveTool': 'motion.getActiveTool',
  'motion.setActiveWobj': 'motion.getActiveWobj',
  'motion.setMechunitBaseFrame': 'motion.getMechunitBaseFrame',
  'motion.teleportMechunit': 'motion.getJointPositions',
  'motion.jog': null,
  'motion.setMechunitForJogging': null,
  'motion.setRobtargetForJogging': null,
  'motion.setNonMotionExecution': 'motion.getNonMotionExecution',
  'motion.setCollisionPredictionMode': 'motion.getCollisionPredictionMode',
  'motion.saveCollisionAvoidanceSnapshot': null,
  'motion.loadCollisionAvoidanceConfig': null,
  'motion.setMotionSupervisionMode': 'motion.getMotionSupervision',
  'motion.setMotionSupervisionSensitivity': 'motion.getMotionSupervision',
  'motion.setPathSupervisionMode': 'motion.getPathSupervision',

  'io.writeSignal': 'io.readSignal',
  'io.writeSignalByName': 'io.readSignalByName',
  'io.setSignalSimulated': null,
  'io.unblockSignals': null,
  'io.setNetworkLState': 'io.listNetworks',
  'io.setIoDeviceLState': 'io.listDevices',

  'cfgElogDipc.clearEventLog': 'cfgElogDipc.getEventLog',
  'cfgElogDipc.clearAllEventLogs': 'cfgElogDipc.getEventLog',
  'cfgElogDipc.saveEventLogRaw': null,
  'cfgElogDipc.setCfgInstance': 'cfgElogDipc.getCfgInstance',
  'cfgElogDipc.createCfgInstance': 'cfgElogDipc.getCfgInstance',
  'cfgElogDipc.removeCfgInstance': 'cfgElogDipc.listCfgInstances',
  'cfgElogDipc.loadCfgFile': null,
  'cfgElogDipc.saveCfgFile': null,
  'cfgElogDipc.createDipcQueue': 'cfgElogDipc.listDipcQueues',
  'cfgElogDipc.sendDipcMessage': 'cfgElogDipc.getDipcQueueInfo',
  'cfgElogDipc.readDipcMessage': null,
  'cfgElogDipc.removeDipcQueue': 'cfgElogDipc.listDipcQueues',

  'ctrl.setControllerClock': 'ctrl.getControllerClock',
  'ctrl.saveDiagnostics': null,
  'ctrl.setControllerLanguage': null,
  'ctrl.saveSystemInfo': null,
  'ctrl.createBackup': 'ctrl.getBackupStatus',
  'ctrl.restoreBackup': null,
  'ctrl.setVirtualTimeScale': 'ctrl.getVirtualTimeScale',
  'ctrl.setVirtualTimeTimeslice': 'ctrl.getVirtualTimeTimeslice',
  'ctrl.uploadCertificate': null,
  'ctrl.clearCertificateStore': null,
  'ctrl.compressPath': null,
  'ctrl.decompressPath': null,
  'ctrl.startJob': null,

  'systemMastership.resetEnergy': 'systemMastership.getEnergyStats',
  'usersUas.changePassword': null,

  'filesVision.uploadFile': 'filesVision.getFileMetadata',
  'filesVision.deleteFile': null,
  'filesVision.createDirectory': { key: 'filesVision.listDirectory', args: ['parentPath'] },
  'filesVision.copyFile': { key: 'filesVision.getFileMetadata', args: ['destPath'] },
  'filesVision.renameFile': null,
  'filesVision.refreshVisionCameras': null,
};
