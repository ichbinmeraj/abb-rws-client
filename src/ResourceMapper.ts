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

/** Path to read the current operation mode (AUTO, MANR, MANF) */
export function operationMode(): string {
  return '/rw/panel/opmode';
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

// ─── Motion ──────────────────────────────────────────────────────────────────

/**
 * Path to read joint-space positions for a mechanical unit.
 * @param mechunit - Default 'ROB_1' (the primary robot mechanical unit)
 */
export function jointTarget(mechunit = 'ROB_1'): string {
  return `/rw/mechunit/${encodeURIComponent(mechunit)}/joint-target`;
}

/**
 * Path to read Cartesian robot target.
 * @param mechunit - Default 'ROB_1'
 * @param tool     - Active tool frame; default 'tool0'
 * @param wobj     - Active work object frame; default 'wobj0'
 */
export function robTarget(mechunit = 'ROB_1', tool = 'tool0', wobj = 'wobj0'): string {
  return `/rw/mechunit/${encodeURIComponent(mechunit)}/robtarget?tool=${encodeURIComponent(tool)}&wobj=${encodeURIComponent(wobj)}`;
}

// ─── Modules ─────────────────────────────────────────────────────────────────

/**
 * Path + body to load a RAPID module into a task.
 * @param taskName   - RAPID task name, e.g. 'T_ROB1'
 * @param modulePath - Controller filesystem path, e.g. '$HOME/MyMod.mod'
 *                     Do not double-encode the '$' prefix — the controller expects it literal.
 */
export function loadModule(taskName: string, modulePath: string): { path: string; body: string } {
  return {
    path: `/rw/rapid/tasks/${encodeURIComponent(taskName)}?action=loadmod`,
    body: `modulepath=${encodeURIComponent(modulePath)}&replace=false`,
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
  return `/rw/rapid/tasks/${encodeURIComponent(taskName)}/modules`;
}

// ─── File system ─────────────────────────────────────────────────────────────

/**
 * PUT path for uploading a file to the controller filesystem.
 * Use '$HOME/' prefix to target the controller home directory.
 * @param remotePath - Controller path, e.g. '$HOME/MyMod.mod' or 'HOME/MyMod.mod'
 *                     A leading '/' is stripped to avoid double-slash in the URL.
 */
export function uploadFile(remotePath: string): string {
  // Strip a leading '/' so the result is /fileservice/path, not /fileservice//path
  const normalised = remotePath.replace(/^\//, '');
  return `/fileservice/${normalised}`;
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

/**
 * Path to read a digital/analog I/O signal value.
 *
 * NOTE: The prompt specified signal(name) but the RWS 1.0 path is
 * /rw/iosystem/signals/{network}/{device}/{name};state, which requires
 * three separate components. Signature extended accordingly.
 *
 * @param network - I/O network name, e.g. 'Local'
 * @param device  - I/O device name, e.g. 'DRV_1'
 * @param name    - Signal name, e.g. 'DI_1'
 */
export function signal(network: string, device: string, name: string): string {
  return `/rw/iosystem/signals/${encodeURIComponent(network)}/${encodeURIComponent(device)}/${encodeURIComponent(name)};state`;
}

/**
 * Path to write a digital/analog I/O signal value.
 * The body with lvalue={value} is supplied by the caller (RwsClient.writeSignal).
 *
 * NOTE: Read uses `;state` suffix; write uses `?action=set` — this asymmetry is
 * intentional in RWS 1.0.
 *
 * @param network - I/O network name
 * @param device  - I/O device name
 * @param name    - Signal name
 */
export function setSignal(network: string, device: string, name: string): { path: string } {
  return {
    path: `/rw/iosystem/signals/${encodeURIComponent(network)}/${encodeURIComponent(device)}/${encodeURIComponent(name)}?action=set`,
  };
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

/** Path to create a new WebSocket subscription (POST /subscription) */
export function subscriptions(): string {
  return '/subscription';
}
