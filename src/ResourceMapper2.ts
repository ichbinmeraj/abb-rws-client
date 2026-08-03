/**
 * ResourceMapper2 - pure functions that map RWS 2.0 operations to URL paths and
 * request bodies, organized by ABB's official RWS 2.0 Services (spec 3HAC073675-001).
 *
 * Companion to `ResourceMapper` (RWS 1.0). No HTTP, no state. Each function returns
 * `{ path, body? }` for writes (body is a `Record<string,string>` matching
 * `RwsClient2.req`'s body arg) or a bare `string` for reads.
 *
 * Scope: this centralizes the control/write surface - the endpoints that change
 * between RobotWare releases and where wire-format bugs hide. Stable read-only GETs
 * still live inline in RwsClient2. Deliberate deviations from the published spec are
 * the ones the controller actually accepts (verified via OPTIONS, which returns the
 * real form fields, and live round-trips on an OmniCore VC RW7.21) - the ABB PDF has
 * errors, so the controller wins.
 *
 * Targets RWS 2.0 (RobotWare 7.x / OmniCore). Not compatible with RWS 1.0.
 */

/** A write endpoint: path plus an optional urlencoded form body. */
export interface Rws2Write {
  path: string;
  body?: Record<string, string>;
}

// ─── Panel Service (/rw/panel) ───────────────────────────────────────────────

/** Read the controller state (motoron / motoroff / init / ...). */
export function controllerState(): string {
  return '/rw/panel/ctrl-state';
}

/** Set the controller motor state. Requires mastership. */
export function setControllerState(state: 'motoron' | 'motoroff'): Rws2Write {
  return { path: '/rw/panel/ctrl-state', body: { 'ctrl-state': state } };
}

/** Read the operation mode (AUTO / MANR / MANF). */
export function operationMode(): string {
  return '/rw/panel/opmode';
}

/** Set the operation mode. Virtual controllers only (real controllers use the key switch). */
export function setOperationMode(wireMode: string): Rws2Write {
  return { path: '/rw/panel/opmode', body: { opmode: wireMode } };
}

/** Read the speed ratio (0-100). */
export function speedRatio(): string {
  return '/rw/panel/speedratio';
}

/**
 * Set the speed ratio (0-100). Only valid in AUTO.
 * The real form field is `speed-ratio` (the spec's `speedratio` is wrong - OPTIONS
 * on /rw/panel/speedratio lists `speed-ratio`). The `?action=setspeedratio` form is
 * accepted by the controller and live-verified changing VC speed.
 */
export function setSpeedRatio(ratio: number): Rws2Write {
  const v = Math.round(Math.max(0, Math.min(100, ratio)));
  return { path: '/rw/panel/speedratio?action=setspeedratio', body: { 'speed-ratio': String(v) } };
}

/** Read the collision detection state (INIT / TRIGGERED / CONFIRMED / ...). */
export function collisionDetectionState(): string {
  return '/rw/panel/coldetstate';
}

/** Lock the operation mode selector. */
export function lockOperationMode(pin: string, permanent: boolean): Rws2Write {
  return { path: '/rw/panel/opmode/lock', body: { pin, permanent: permanent ? '1' : '0' } };
}

/** Unlock the operation mode selector. */
export function unlockOperationMode(): Rws2Write {
  return { path: '/rw/panel/opmode/unlock' };
}

/**
 * Acknowledge a pending operation-mode switch. When the mode selector is turned
 * the controller holds the change pending until acknowledged over RWS; the target
 * mode is echoed in the `opmode` field. OPTIONS-verified 2026-08-04 (RW7.21).
 */
export function acknowledgeOperationMode(wireMode: string): Rws2Write {
  return { path: '/rw/panel/opmode/acknowledge', body: { opmode: wireMode } };
}

// ─── RAPID Service - execution (/rw/rapid/execution) ─────────────────────────

/** Read the RAPID execution state / info. */
export function rapidExecution(): string {
  return '/rw/rapid/execution';
}

/**
 * Start RAPID execution. RWS 2.0 uses path-based actions (/start, not ?action=start).
 * cycle=asis keeps the currently configured cycle mode.
 */
export function startRapid(): Rws2Write {
  return {
    path: '/rw/rapid/execution/start',
    body: {
      regain: 'continue', execmode: 'continue', cycle: 'asis',
      condition: 'none', stopatbp: 'disabled', alltaskbytsp: 'false',
    },
  };
}

/** Stop RAPID execution. */
export function stopRapid(): Rws2Write {
  return { path: '/rw/rapid/execution/stop', body: { stopmode: 'stop' } };
}

/** Reset the program pointer to main. */
export function resetRapid(): Rws2Write {
  return { path: '/rw/rapid/execution/resetpp' };
}

/** Set the execution cycle mode (once / forever / asis). */
export function setExecutionCycle(cycle: string): Rws2Write {
  return { path: '/rw/rapid/execution/cycle', body: { cycle } };
}

/** Start RAPID execution from the production entry point (the task list's main).
 *  OPTIONS-verified 2026-08-04 (RW7.21): POST, no body. */
export function startProductionEntry(): Rws2Write {
  return { path: '/rw/rapid/execution/startprodentry' };
}

// ─── RAPID Service - program load/save (/rw/rapid/tasks/{task}/program) ───────

/**
 * Load a full RAPID program into a task from controller disk (a .pgf and its
 * modules), distinct from loadmod (single module). Fields `progpath` + `loadmode`
 * (add | replace). OPTIONS-verified 2026-08-04 (RW7.21).
 */
export function loadProgram(task: string, progpath: string, loadmode: 'add' | 'replace'): Rws2Write {
  return { path: `/rw/rapid/tasks/${encodeURIComponent(task)}/program/load`, body: { progpath, loadmode } };
}

/** Save a task's currently loaded RAPID program to disk. Field `path`
 *  (OPTIONS-verified 2026-08-04). */
export function saveProgram(task: string, destination: string): Rws2Write {
  return { path: `/rw/rapid/tasks/${encodeURIComponent(task)}/program/save`, body: { path: destination } };
}

// ─── Mastership Service (/rw/mastership) ─────────────────────────────────────
// `domain` is the RWS 2.0 wire domain ('edit' | 'motion'); callers map
// 'cfg'|'rapid' -> 'edit' before calling (RwsClient2.rws2Domain).

/** Request mastership on one domain. */
export function requestMastership(domain: string): Rws2Write {
  return { path: `/rw/mastership/${domain}/request` };
}

/** Release mastership on one domain. */
export function releaseMastership(domain: string): Rws2Write {
  return { path: `/rw/mastership/${domain}/release` };
}

/** Request mastership on ALL domains at once. */
export function requestMastershipAll(): Rws2Write {
  return { path: '/rw/mastership/request' };
}

/** Release mastership on ALL domains at once. */
export function releaseMastershipAll(): Rws2Write {
  return { path: '/rw/mastership/release' };
}

/** Reset the edit-mastership watchdog (keeps a held mastership alive). */
export function mastershipWatchdog(): Rws2Write {
  return { path: '/rw/mastership/watchdog' };
}

// ─── IO Service (/rw/iosystem) ───────────────────────────────────────────────

/**
 * Write an IO signal value. RWS 2.0 uses a path-based action `/set-value` with a
 * `lvalue` body (RWS 1.0 used ?action=set on the signal URL).
 */
export function setSignalValue(network: string, device: string, name: string, value: string): Rws2Write {
  return { path: `/rw/iosystem/signals/${network}/${device}/${name}/set-value`, body: { lvalue: value } };
}

// ─── Elog Service (/rw/elog) ─────────────────────────────────────────────────

/** Read event-log messages for a domain (0 = common controller log). */
export function elogMessages(domain = 0, lang = 'en'): string {
  return `/rw/elog/${domain}?lang=${encodeURIComponent(lang)}`;
}

/** Clear the event log for one domain. */
export function clearElogDomain(domain = 0): Rws2Write {
  return { path: `/rw/elog/${domain}/clear` };
}

/** Clear the event log across all domains. */
export function clearAllElogs(): Rws2Write {
  return { path: '/rw/elog/clearall' };
}

/** Dump the full event log to a file in system-dump format (for diagnostics/
 *  support). Field `path` (OPTIONS-verified 2026-08-04, RW7.21). */
export function saveEventLogRaw(destination: string): Rws2Write {
  return { path: '/rw/elog/saveraw', body: { path: destination } };
}

// ─── CFG Service (/rw/cfg) ───────────────────────────────────────────────────

/**
 * Load a CFG file into a domain. Official endpoint is /rw/cfg/load (posting to
 * /rw/cfg 405s). Body is `filepath` + `action-type` (add | replace | add-with-reset).
 */
export function loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset'): Rws2Write {
  return { path: '/rw/cfg/load', body: { 'action-type': action, filepath } };
}

/**
 * Save a CFG domain to a file. The endpoint is /rw/cfg/{domain}/saveas (/save 405s)
 * and the body field is `filepath` - the spec's `destination` is wrong (OPTIONS on
 * /rw/cfg/{domain}/saveas lists `filepath`). Live-verified 2026-08-03.
 */
export function saveCfgFile(domain: string, filepath: string): Rws2Write {
  return { path: `/rw/cfg/${domain}/saveas`, body: { filepath } };
}

// ─── DIPC Service (/rw/dipc) ─────────────────────────────────────────────────

/**
 * Create a DIPC queue. The controller form (OPTIONS /rw/dipc) accepts exactly
 * `dipc-queue-name`, `dipc-queue-size` (max message count) and `dipc-max-msg-size`
 * (max bytes per message). The spec's `max-msg-count` and the old code's
 * `dipc-max-size` / `dipc-max-number-of-messages` are rejected with HTTP 400.
 * Corrected fields live-verified 2026-08-03 (create -> 201).
 */
export function createDipcQueue(name: string, options: { maxsize?: number; maxmessages?: number } = {}): Rws2Write {
  const body: Record<string, string> = { 'dipc-queue-name': name };
  if (options.maxmessages) { body['dipc-queue-size'] = String(options.maxmessages); }
  if (options.maxsize)     { body['dipc-max-msg-size'] = String(options.maxsize); }
  return { path: '/rw/dipc', body };
}

/**
 * Send a message to a DIPC queue. `dipc-userdef` is REQUIRED by the controller
 * (omitting it returns HTTP 400 "Error in name field dipc-userdef") - the old code
 * left it out, so every send failed. Live-verified 2026-08-03 (send -> 204).
 * @param msgtype controller code: 0=string, 1=num, 2=dnum, 3=bool.
 */
export function sendDipcMessage(queue: string, payload: string, msgtype: string): Rws2Write {
  return {
    path: `/rw/dipc/${encodeURIComponent(queue)}`,
    body: {
      'dipc-src-queue-name': queue,
      'dipc-cmd': '111',    // SEND
      'dipc-userdef': '0',  // required by controller
      'dipc-data': payload,
      'dipc-msgtype': msgtype,
    },
  };
}

/** Read a message from a DIPC queue. RWS 2.0 read is a GET with a dipc-timeout query
 *  (the old POST /{queue}/read 404s). Live-verified 2026-08-03. */
export function readDipcMessage(queue: string, timeoutMs = 0): string {
  return `/rw/dipc/${encodeURIComponent(queue)}?dipc-timeout=${timeoutMs}`;
}

/** Delete a DIPC queue. */
export function removeDipcQueue(name: string): Rws2Write {
  return { path: `/rw/dipc/${encodeURIComponent(name)}` };
}

// ─── Controller Service - backup (/ctrl/backup) ──────────────────────────────

/** Create a controller backup under the BACKUP volume. */
export function createBackup(name: string): Rws2Write {
  return { path: '/ctrl/backup/create', body: { backup: `BACKUP/${name}` } };
}

/** Restore a controller backup from the BACKUP volume. */
export function restoreBackup(name: string): Rws2Write {
  return { path: '/ctrl/backup/restore', body: { backup: `BACKUP/${name}` } };
}
