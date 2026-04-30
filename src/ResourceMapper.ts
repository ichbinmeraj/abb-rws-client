/**
 * ResourceMapper — pure functions that map RWS operations to URL paths and
 * application/x-www-form-urlencoded request bodies.
 *
 * No HTTP, no state. All functions are individually exported for tree-shaking.
 * Targets RWS 1.0 (RobotWare 6.x). Not compatible with RWS 2.0 / RobotWare 7.x.
 */

// ─── Controller ──────────────────────────────────────────────────────────────

/** Path to read the current controller state (motoron, motoroff, etc.) */
export function controllerState(): string {
  return '/rw/panel/ctrlstate';
}

/** Path + body to set the controller motor state (motoron / motoroff). Requires mastership. */
export function setControllerState(state: 'motoron' | 'motoroff'): { path: string; body: string } {
  return {
    path: '/rw/panel/ctrlstate?action=setctrlstate',
    body: `ctrl-state=${state}`,
  };
}

/** Path to read the current operation mode (AUTO, MANR, MANF) */
export function operationMode(): string {
  return '/rw/panel/opmode';
}

/** Path to read the current speed ratio (0–100) */
export function speedRatio(): string {
  return '/rw/panel/speedratio';
}

/** Path + body to set the speed ratio. Only valid in AUTO mode. @param ratio 0–100 */
export function setSpeedRatio(ratio: number): { path: string; body: string } {
  return {
    path: '/rw/panel/speedratio?action=setspeedratio',
    body: `speed-ratio=${Math.round(Math.max(0, Math.min(100, ratio)))}`,
  };
}

// ─── RAPID ───────────────────────────────────────────────────────────────────

/** Path to list all RAPID tasks */
export function rapidTasks(): string {
  return '/rw/rapid/tasks';
}

/** Path to read the RAPID execution state (running / stopped) */
export function rapidExecutionState(): string {
  return '/rw/rapid/execution';
}

/** Path + body to start RAPID program execution */
export function startRapid(): { path: string; body: string } {
  return {
    path: '/rw/rapid/execution?action=start',
    body: 'regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false',
  };
}

/** Path + body to stop RAPID program execution */
export function stopRapid(): { path: string; body: string } {
  return {
    path: '/rw/rapid/execution?action=stop',
    body: 'stopmode=stop',
  };
}

/**
 * Path + body to reset the RAPID program pointer to main.
 * The body is empty but Content-Type must still be application/x-www-form-urlencoded.
 */
export function resetRapid(): { path: string; body: string } {
  return {
    path: '/rw/rapid/execution?action=resetpp',
    body: '',
  };
}

/**
 * Path + body to set the RAPID execution cycle mode.
 * @param cycle - 'once' (run once then stop) | 'forever' (loop indefinitely) | 'asis' (keep current)
 */
export function setExecutionCycle(cycle: 'once' | 'forever' | 'asis'): { path: string; body: string } {
  return {
    path: '/rw/rapid/execution?action=setcycle',
    body: `cycle=${cycle}`,
  };
}

// ─── Controller panel ────────────────────────────────────────────────────────

/** Path to read the collision detection state (INIT/TRIGGERED/CONFIRMED/TRIGGERED_ACK). */
export function collisionDetectionState(): string {
  return '/rw/panel/coldetstate';
}

/**
 * Path + body to restart (or shutdown) the controller.
 * @param mode - 'restart' | 'istart' | 'pstart' | 'bstart'
 */
export function restartController(mode: 'restart' | 'istart' | 'pstart' | 'bstart'): { path: string; body: string } {
  return {
    path: '/rw/panel?action=restart',
    body: `restart-mode=${mode}`,
  };
}

/**
 * Path + body to lock the operation mode selector.
 * @param pin - 4-digit PIN
 * @param permanent - true = permanent lock; false = temporary
 */
export function lockOperationMode(pin: string, permanent: boolean): { path: string; body: string } {
  return {
    path: '/rw/panel/opmode?action=lock',
    body: `pin=${encodeURIComponent(pin)}&permanent=${permanent ? 1 : 0}`,
  };
}

/** Path + body to unlock the operation mode selector. */
export function unlockOperationMode(): { path: string; body: string } {
  return { path: '/rw/panel/opmode?action=unlock', body: '' };
}

// ─── RAPID UI instructions ───────────────────────────────────────────────────

/** Path to GET the currently active RAPID UI instruction (if any). */
export function activeUiInstruction(): string {
  return '/rw/rapid/uiinstr/active';
}

/**
 * Path + body to set a parameter value on the active RAPID UI instruction.
 * Used to respond programmatically to TPReadNum, TPReadFK, etc.
 *
 * @param stackurl - Full stack URL from the UiInstruction.stack field (e.g. 'RAPID/T_ROB1/%$104')
 * @param uiparam  - Parameter name: 'Result', 'TPFK1' … 'TPFK5', 'TPCompleted', etc.
 * @param value    - New value (e.g. '42', 'TRUE', '0')
 */
export function setUiInstructionParam(
  stackurl: string, uiparam: string, value: string,
): { path: string; body: string } {
  return {
    path: `/rw/rapid/uiinstr/active/param/${encodeURIComponent(stackurl)}/${encodeURIComponent(uiparam)}?action=set`,
    body: `value=${encodeURIComponent(value)}`,
  };
}

// ─── RAPID task activation ───────────────────────────────────────────────────

/** Path + body to activate a single RAPID task (multitasking). */
export function activateRapidTask(task: string): { path: string; body: string } {
  return { path: `/rw/rapid/tasks/${encodeURIComponent(task)}?action=activate`, body: '' };
}

/** Path + body to deactivate a single RAPID task (multitasking). */
export function deactivateRapidTask(task: string): { path: string; body: string } {
  return { path: `/rw/rapid/tasks/${encodeURIComponent(task)}?action=deactivate`, body: '' };
}

/** Path + body to activate ALL RAPID tasks. */
export function activateAllRapidTasks(): { path: string; body: string } {
  return { path: '/rw/rapid/tasks?action=activate', body: '' };
}

/** Path + body to deactivate ALL RAPID tasks. */
export function deactivateAllRapidTasks(): { path: string; body: string } {
  return { path: '/rw/rapid/tasks?action=deactivate', body: '' };
}

// ─── RAPID symbol search / validate ─────────────────────────────────────────

/**
 * Path + body to search RAPID symbols across a task.
 * POST /rw/rapid/symbols?action=search-symbol
 */
export function searchRapidSymbols(params: {
  task: string;
  view?: string;
  vartyp?: string;
  symtyp?: string;
  dattyp?: string;
  regexp?: string;
  recursive?: boolean;
  blockurl?: string;
}): { path: string; body: string } {
  const parts: string[] = [];
  parts.push(`task=${encodeURIComponent(params.task)}`);
  if (params.view)      parts.push(`view=${encodeURIComponent(params.view)}`);
  if (params.vartyp)    parts.push(`vartyp=${encodeURIComponent(params.vartyp)}`);
  if (params.symtyp)    parts.push(`symtyp=${encodeURIComponent(params.symtyp)}`);
  if (params.dattyp)    parts.push(`dattyp=${encodeURIComponent(params.dattyp)}`);
  if (params.regexp)    parts.push(`regexp=${encodeURIComponent(params.regexp)}`);
  if (params.blockurl)  parts.push(`blockurl=${encodeURIComponent(params.blockurl)}`);
  if (params.recursive !== undefined) parts.push(`recursive=${params.recursive}`);
  return {
    path: '/rw/rapid/symbols?action=search-symbol',
    body: parts.join('&'),
  };
}

/**
 * Path + body to validate a value against a RAPID data type.
 * POST /rw/rapid/symbol/data?action=validate
 * Returns 204 if valid, 400 if invalid.
 */
export function validateRapidValue(task: string, value: string, datatype: string): { path: string; body: string } {
  return {
    path: '/rw/rapid/symbol/data?action=validate',
    body: `task=${encodeURIComponent(task)}&value=${encodeURIComponent(value)}&datatype=${encodeURIComponent(datatype)}`,
  };
}

// ─── RAPID symbols ───────────────────────────────────────────────────────────

/**
 * Path to read RAPID symbol properties (type, dimensions, storage, etc.).
 * @param taskName   - RAPID task name, e.g. 'T_ROB1'
 * @param moduleName - Module name, e.g. 'user'
 * @param symbolName - Symbol name, e.g. 'reg1'
 */
export function rapidSymbolProperties(taskName: string, moduleName: string, symbolName: string): string {
  return `/rw/rapid/symbol/properties/RAPID/${encodeURIComponent(taskName)}/${encodeURIComponent(moduleName)}/${encodeURIComponent(symbolName)}`;
}

/**
 * Path to read a RAPID symbol value.
 * @param taskName   - RAPID task name, e.g. 'T_ROB1'
 * @param moduleName - Module name, e.g. 'user'
 * @param symbolName - Symbol name, e.g. 'reg1'
 */
export function rapidSymbol(taskName: string, moduleName: string, symbolName: string): string {
  return `/rw/rapid/symbol/data/RAPID/${encodeURIComponent(taskName)}/${encodeURIComponent(moduleName)}/${encodeURIComponent(symbolName)}`;
}

/**
 * Path + body to set a RAPID symbol value.
 * @param taskName   - RAPID task name
 * @param moduleName - Module name
 * @param symbolName - Symbol name
 * @param value      - New value as RAPID-formatted string, e.g. '42', '"hello"', '[1,2,3]'
 */
export function setRapidSymbol(
  taskName: string,
  moduleName: string,
  symbolName: string,
  value: string,
): { path: string; body: string } {
  return {
    path: `${rapidSymbol(taskName, moduleName, symbolName)}?action=set`,
    body: `value=${encodeURIComponent(value)}`,
  };
}

// ─── Motion ──────────────────────────────────────────────────────────────────

/**
 * Path to read joint-space positions for a mechanical unit.
 * @param mechunit - Default 'ROB_1' (the primary robot mechanical unit)
 */
export function jointTarget(mechunit = 'ROB_1'): string {
  return `/rw/motionsystem/mechunits/${encodeURIComponent(mechunit)}/jointtarget`;
}

/**
 * Path to read Cartesian robot target.
 * @param mechunit - Default 'ROB_1'
 * @param tool     - Active tool frame; default 'tool0'
 * @param wobj     - Active work object frame; default 'wobj0'
 */
export function robTarget(mechunit = 'ROB_1', tool = 'tool0', wobj = 'wobj0'): string {
  return `/rw/motionsystem/mechunits/${encodeURIComponent(mechunit)}/robtarget?tool=${encodeURIComponent(tool)}&wobj=${encodeURIComponent(wobj)}`;
}

/**
 * Path to read Cartesian position including robot configuration flags (j1, j4, j6, jx).
 * Uses the /cartesian sub-resource instead of /robtarget — no tool/wobj parameters.
 * @param mechunit - Default 'ROB_1'
 */
export function cartesianFull(mechunit = 'ROB_1'): string {
  return `/rw/motionsystem/mechunits/${encodeURIComponent(mechunit)}/cartesian`;
}

// ─── Modules ─────────────────────────────────────────────────────────────────

/**
 * Path + body to load a RAPID module into a task.
 * @param taskName   - RAPID task name, e.g. 'T_ROB1'
 * @param modulePath - Controller filesystem path, e.g. '$HOME/MyMod.mod'
 *                     Do not double-encode the '$' prefix — the controller expects it literal.
 */
export function loadModule(taskName: string, modulePath: string, replace = false): { path: string; body: string } {
  return {
    path: `/rw/rapid/tasks/${encodeURIComponent(taskName)}?action=loadmod`,
    body: `modulepath=${encodeURIComponent(modulePath)}&replace=${replace}`,
  };
}

/**
 * Path to retrieve details about a specific loaded module.
 * @param taskName   - RAPID task name
 * @param moduleName - Module name (without path or extension)
 */
export function getModule(taskName: string, moduleName: string): string {
  return `/rw/rapid/tasks/${encodeURIComponent(taskName)}/modules/${encodeURIComponent(moduleName)}`;
}

/**
 * Path to list all modules loaded in a RAPID task.
 * @param taskName - RAPID task name
 */
export function listModules(taskName: string): string {
  return `/rw/rapid/modules?task=${encodeURIComponent(taskName)}`;
}

// ─── File system ─────────────────────────────────────────────────────────────

/**
 * PUT path for uploading a file to the controller filesystem.
 * Use '$HOME/' prefix to target the controller home directory.
 * @param remotePath - Controller path, e.g. '$HOME/MyMod.mod'
 */
export function uploadFile(remotePath: string): string {
  return fileServicePath(remotePath);
}

// ─── Controller info ─────────────────────────────────────────────────────────

/** Path to get RobotWare system information (version, options, sysid) */
export function systemInfo(): string {
  return '/rw/system';
}

/** Path to get controller hardware identity (name, id, type, mac) */
export function controllerIdentity(): string {
  return '/ctrl/identity';
}

/** Path to GET the controller clock datetime. */
export function clockInfo(): string {
  return '/ctrl/clock';
}

/**
 * Path + body to SET the controller clock (PUT /ctrl/clock).
 * All values are interpreted as UTC by the controller.
 */
export function setControllerClock(
  year: number, month: number, day: number,
  hour: number, min: number, sec: number,
): { path: string; body: string; method: 'PUT' } {
  return {
    path: '/ctrl/clock',
    body: `sys-clock-year=${year}&sys-clock-month=${month}&sys-clock-day=${day}&sys-clock-hour=${hour}&sys-clock-min=${min}&sys-clock-sec=${sec}`,
    method: 'PUT',
  };
}

// ─── Event log ───────────────────────────────────────────────────────────────

/**
 * Path to read event log messages.
 * Domain 0 = common controller log (up to 1000 entries, most useful).
 * @param domain  - Log domain number; default 0
 * @param lang    - Language for message text; default 'en'
 */
export function elogMessages(domain = 0, lang = 'en'): string {
  return `/rw/elog/${domain}?lang=${encodeURIComponent(lang)}`;
}

/** Path + body to clear all messages in a specific elog domain. */
export function clearElogDomain(domain = 0): { path: string; body: string } {
  return { path: `/rw/elog/${domain}?action=clear`, body: '' };
}

/** Path + body to clear ALL elog messages across all domains. */
export function clearAllElogs(): { path: string; body: string } {
  return { path: '/rw/elog?action=clearall', body: '' };
}

// ─── File system ─────────────────────────────────────────────────────────────

/**
 * Path for GET (download file or list directory) and PUT (upload file).
 * Use '$HOME/' prefix to target the controller home directory.
 */
export function fileServicePath(remotePath: string): string {
  const normalised = remotePath.replace(/^\//, '');
  return `/fileservice/${normalised}`;
}

/** DELETE path to remove a file from the controller filesystem. */
export function deleteFile(remotePath: string): string {
  return fileServicePath(remotePath);
}

/**
 * Path to create a new directory on the controller filesystem.
 * POST to this path with body 'fs-action=create&fs-newname={dirName}'.
 * @param parentPath - Parent directory path, e.g. '$HOME'
 */
export function createDirectory(parentPath: string): { path: string } {
  return { path: fileServicePath(parentPath) };
}

/**
 * Path to copy a file on the controller filesystem.
 * POST to this path with body 'fs-action=copy&fs-newname={destPath}'.
 * @param sourcePath - Source file path, e.g. '$HOME/Source.mod'
 * @param destPath   - Destination path, e.g. '$HOME/Backup/Source.mod'
 */
export function copyFile(sourcePath: string, destPath: string): { path: string; body: string } {
  return {
    path: fileServicePath(sourcePath),
    body: `fs-action=copy&fs-newname=${encodeURIComponent(destPath)}`,
  };
}

// ─── Mastership ───────────────────────────────────────────────────────────────

/**
 * Path + body to request mastership on a domain.
 * Must be released after use. Domains: 'cfg' | 'motion' | 'rapid'.
 */
export function requestMastership(domain: 'cfg' | 'motion' | 'rapid'): { path: string; body: string } {
  return { path: `/rw/mastership/${domain}?action=request`, body: '' };
}

/** Path + body to release mastership on a domain. */
export function releaseMastership(domain: 'cfg' | 'motion' | 'rapid'): { path: string; body: string } {
  return { path: `/rw/mastership/${domain}?action=release`, body: '' };
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

/**
 * Build the signal path segment from optional network/device/name.
 * If network and device are empty, the signal is a virtual flat signal (no prefix).
 */
function signalPath(network: string, device: string, name: string): string {
  if (network && device) {
    return `/rw/iosystem/signals/${encodeURIComponent(network)}/${encodeURIComponent(device)}/${encodeURIComponent(name)}`;
  }
  return `/rw/iosystem/signals/${encodeURIComponent(name)}`;
}

/**
 * Path to list all I/O signals (paginated).
 * @param start  - Starting index (default 0)
 * @param limit  - Max results per page (default 100)
 */
export function allSignals(start = 0, limit = 100): string {
  return `/rw/iosystem/signals?start=${start}&limit=${limit}`;
}

/** Path to list all configured I/O networks */
export function networks(): string {
  return '/rw/iosystem/networks';
}

/**
 * Path to list all devices on a network.
 * @param network - Network name, e.g. 'Local'
 */
export function devices(network: string): string {
  return `/rw/iosystem/devices?network=${encodeURIComponent(network)}`;
}

/**
 * Path to read a digital/analog I/O signal value.
 *
 * @param network - I/O network name, e.g. 'Local'. Pass '' for virtual/flat signals.
 * @param device  - I/O device name, e.g. 'DRV_1'. Pass '' for virtual/flat signals.
 * @param name    - Signal name, e.g. 'DI_1'
 */
export function signal(network: string, device: string, name: string): string {
  return signalPath(network, device, name);
}

/**
 * Path to write a digital/analog I/O signal value.
 * The body with lvalue={value} is supplied by the caller (RwsClient.writeSignal).
 *
 * @param network - I/O network name. Pass '' for virtual/flat signals.
 * @param device  - I/O device name. Pass '' for virtual/flat signals.
 * @param name    - Signal name
 */
export function setSignal(network: string, device: string, name: string): { path: string } {
  return {
    path: `${signalPath(network, device, name)}?action=set`,
  };
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

/** Path to create a new WebSocket subscription (POST /subscription) */
export function subscriptions(): string {
  return '/subscription';
}
