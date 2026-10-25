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

import { assertSpeedRatio } from './ResourceMapper.js';
import { PANEL } from './paths/panel.js';
import { RAPID } from './paths/rapid.js';
import { MOTION } from './paths/motion.js';
import { IO } from './paths/io.js';
import { CFG_ELOG_DIPC } from './paths/cfgElogDipc.js';
import { CTRL } from './paths/ctrl.js';
import { SYSTEM_MASTERSHIP } from './paths/systemMastership.js';
import { buildPath, type PathSpec } from './paths/PathSpec.js';

/** A write endpoint: path plus an optional urlencoded form body. */
export interface Rws2Write {
  path: string;
  body?: Record<string, string>;
}

/**
 * RWS 2.0 path for a panel operation, from the path table (src/paths/panel.ts).
 *
 * The path tables are the single source of RWS URLs; this domain reads them
 * rather than repeating the literal. tests/paths.test.ts proves the table paths
 * equal what these functions used to return, so the migration is behaviour-
 * preserving. Body-building stays here - the table owns the URL, not the values.
 */
const p2 = (op: keyof typeof PANEL, params?: Record<string, string | number>): string =>
  buildPath(PANEL[op].rws2 as PathSpec, params);

// ─── Panel Service (/rw/panel) ───────────────────────────────────────────────

/** Read the controller state (motoron / motoroff / init / ...). */
export function controllerState(): string {
  return p2('getControllerState');
}

/** Set the controller motor state. Requires mastership. */
export function setControllerState(state: 'motoron' | 'motoroff'): Rws2Write {
  return { path: p2('setControllerState'), body: { 'ctrl-state': state } };
}

/** Read the operation mode (AUTO / MANR / MANF). */
export function operationMode(): string {
  return p2('getOperationMode');
}

/** Set the operation mode. Virtual controllers only (real controllers use the key switch). */
export function setOperationMode(wireMode: string): Rws2Write {
  return { path: p2('setOperationMode'), body: { opmode: wireMode } };
}

/** Read the speed ratio (0-100). */
export function speedRatio(): string {
  return p2('getSpeedRatio');
}

/**
 * Set the speed ratio (0-100). Only valid in AUTO.
 * The form field is `speed-ratio`, as ABB's Panel_Service.yaml and the
 * controller's OPTIONS form both say (the earlier remark here that the spec's
 * field was wrong was itself wrong; `speedratio` is the name of the READ value
 * and of the subscription state, and answers 400 on a write). The documented
 * plain POST answers 204; the `?action=setspeedratio` the table carries is
 * ignored by the controller (`?action=nosuchaction` also answers 204), so
 * buildPath renders a query the request does not need but that does no harm.
 * Verified 2026-09-27 on RW 7.21 and 8.1.1.
 */
export function setSpeedRatio(ratio: number): Rws2Write {
  // Rejects out-of-range values rather than clamping - see assertSpeedRatio.
  const v = assertSpeedRatio(ratio);
  return { path: p2('setSpeedRatio'), body: { 'speed-ratio': String(v) } };
}

/** Read the collision detection state (INIT / TRIGGERED / CONFIRMED / ...). */
export function collisionDetectionState(): string {
  return p2('getCollisionDetectionState');
}

/** Lock the operation mode selector. */
export function lockOperationMode(pin: string, permanent: boolean): Rws2Write {
  return { path: p2('lockOperationMode'), body: { pin, permanent: permanent ? '1' : '0' } };
}

/** Unlock the operation mode selector with the PIN the lock set (the form's
 *  one field on RW 7.21.4 and 8.2.1; Rev L marks it required). */
export function unlockOperationMode(pin: string): Rws2Write {
  return { path: p2('unlockOperationMode'), body: { pin } };
}

/**
 * Acknowledge a pending operation-mode switch. When the mode selector is turned
 * the controller holds the change pending (AUTO_CH) until it is confirmed at the
 * FlexPendant; the target mode is echoed in the `opmode` field.
 * OPTIONS-verified 2026-08-04 (RW7.21).
 */
export function acknowledgeOperationMode(wireMode: string): Rws2Write {
  return { path: p2('acknowledgeOperationMode'), body: { opmode: wireMode } };
}

// ─── RAPID Service - execution (/rw/rapid/execution) ─────────────────────────

/** Read the RAPID execution state / info. */
export function rapidExecution(): string {
  return buildPath(RAPID.getRapidExecutionState.rws2 as PathSpec);
}

/**
 * Start RAPID execution. RWS 2.0 uses path-based actions (/start, not ?action=start).
 * cycle=asis keeps the currently configured cycle mode.
 */
export function startRapid(): Rws2Write {
  return {
    path: buildPath(RAPID.startRapid.rws2 as PathSpec),
    body: {
      regain: 'continue', execmode: 'continue', cycle: 'asis',
      condition: 'none', stopatbp: 'disabled', alltaskbytsp: 'false',
    },
  };
}

/** Stop RAPID execution. */
export function stopRapid(): Rws2Write {
  return { path: buildPath(RAPID.stopRapid.rws2 as PathSpec), body: { stopmode: 'stop' } };
}

/** Reset the program pointer to main. */
export function resetRapid(): Rws2Write {
  return { path: buildPath(RAPID.resetRapid.rws2 as PathSpec) };
}

/** Set the execution cycle mode (once / forever / asis). */
export function setExecutionCycle(cycle: string): Rws2Write {
  return { path: buildPath(RAPID.setExecutionCycle.rws2 as PathSpec), body: { cycle } };
}

/** Start RAPID execution from the production entry point (the task list's main).
 *  OPTIONS-verified 2026-08-04 (RW7.21): POST, no body. */
export function startProductionEntry(): Rws2Write {
  return { path: buildPath(RAPID.startProductionEntry.rws2 as PathSpec) };
}

// ─── RAPID Service - program load/save (/rw/rapid/tasks/{task}/program) ───────

/**
 * Load a full RAPID program into a task from controller disk (a .pgf and its
 * modules), distinct from loadmod (single module). Fields `progpath` + `loadmode`
 * (add | replace). OPTIONS-verified 2026-08-04 (RW7.21).
 */
export function loadProgram(task: string, progpath: string, loadmode: 'add' | 'replace'): Rws2Write {
  return { path: buildPath(RAPID.loadProgram.rws2 as PathSpec, { task }), body: { progpath, loadmode } };
}

/** Save a task's currently loaded RAPID program to disk. Field `path`
 *  (OPTIONS-verified 2026-08-04). */
export function saveProgram(task: string, destination: string): Rws2Write {
  return { path: buildPath(RAPID.saveProgram.rws2 as PathSpec, { task }), body: { path: destination } };
}

/**
 * Save one module's source to a file on a controller volume. Body `name` (no
 * extension; the controller ALWAYS appends '.modx', even for SysMods) + `path`
 * (a volume root in colon form, e.g. 'TEMP:' or 'HOME:'). Live-verified
 * 2026-08-04 (RW7.21): both literal 'TEMP:' and percent-encoded 'TEMP%3A' are
 * accepted; subdirectories ('TEMP:/sub') are rejected with 400, volume roots only.
 */
export function saveModuleAs(task: string, module: string, name: string, volume: string): Rws2Write {
  return {
    path: buildPath(RAPID.saveModule.rws2 as PathSpec, { task, module }),
    body: { name, path: volume },
  };
}

// ─── RAPID Service - program-pointer navigation (/rw/rapid/tasks/{task}/pcp) ──
// Manual-mode debugger moves (like stepping, they need manual mode + the
// enabling device); the paths and forms are OPTIONS-verified (RW7.21, 2026-08).

/** Move the program pointer back one instruction. POST, no body. */
export function ppPrevInst(task: string): Rws2Write {
  return { path: buildPath(RAPID.ppPrevInst.rws2 as PathSpec, { task }) };
}

/** Move the program pointer forward one instruction. POST, no body. */
export function ppNextInst(task: string): Rws2Write {
  return { path: buildPath(RAPID.ppNextInst.rws2 as PathSpec, { task }) };
}

/**
 * `POST .../pcp/routine-from-url` as ABB documents it (RWS 2.0 Rev L, "Set the
 * Program Pointer(PP) Position to Routine by URL"): the sample sends
 * `routineurl=/RAPID/T_ROB1/module_test/main&userlevel=false`. The caller's
 * `routineurl` is passed through as given (this builds no URL; the documented
 * form is `/RAPID/{task}/{module}/{routine}`), and `userlevel` is always sent,
 * `false` unless asked. Auto mode and mastership are required; a LOCAL
 * routine or one with parameters is not allowed.
 *
 * Recorded 2026-10-11 on RW 7.21.4 and 8.2.1: every form without `userlevel`,
 * and every form with the symbol-service prefix, answered 400 -1073445879
 * "Invalid parameter"; `RAPID/T_ROB1/ZZ_PROBE/main&userlevel=FALSE` answered
 * the same; only `T_ROB1/ZZ_PROBE/main&userlevel=TRUE` got past the parameter
 * check, to -1073442816 "Symbol not found". The documented shape (leading
 * slash, lower-case `false`) was not sent in that run; no 2xx is logged.
 */
export function setPPToRoutineFromUrl(task: string, routineurl: string, userlevel: boolean | string = false): Rws2Write {
  const level = typeof userlevel === 'boolean' ? String(userlevel) : (userlevel || 'false');
  return { path: buildPath(RAPID.setPPToRoutineFromUrl.rws2 as PathSpec, { task }), body: { routineurl, userlevel: level } };
}

// ─── Mastership Service (/rw/mastership) ─────────────────────────────────────
// `domain` is the RWS 2.0 wire domain ('edit' | 'motion'); callers map
// 'cfg'|'rapid' -> 'edit' before calling (RwsClient2.rws2Domain).

/** Request mastership on one domain. */
export function requestMastership(domain: string): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.requestMastership.rws2 as PathSpec, { domain }) };
}

/** Release mastership on one domain. */
export function releaseMastership(domain: string): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.releaseMastership.rws2 as PathSpec, { domain }) };
}

/** Request mastership on ALL domains at once. */
export function requestMastershipAll(): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.requestMastershipAll.rws2 as PathSpec) };
}

/** Release mastership on ALL domains at once. */
export function releaseMastershipAll(): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.releaseMastershipAll.rws2 as PathSpec) };
}

/** Reset the edit-mastership watchdog (keeps a held mastership alive). */
export function mastershipWatchdog(): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.resetMastershipWatchdog.rws2 as PathSpec) };
}

// ─── MotionSystem Service - supervision (/rw/motionsystem) ────────────────────
// Field names below are from each endpoint's OPTIONS form (RW7.21, 2026-08).
// These change motion supervision configuration; they require motion mastership.

/** Set motion (jog) supervision mode. OPTIONS form field is `mode`. */
export function setMotionSupervisionMode(mechunit: string, mode: string): Rws2Write {
  return { path: buildPath(MOTION.setMotionSupervisionMode.rws2 as PathSpec, { mechunit }), body: { mode } };
}

/** Set motion supervision sensitivity. The OPTIONS form field is `sensitivity`
 *  (NOT `level` as the endpoint name would suggest). */
export function setMotionSupervisionSensitivity(mechunit: string, sensitivity: number): Rws2Write {
  return { path: buildPath(MOTION.setMotionSupervisionSensitivity.rws2 as PathSpec, { mechunit }), body: { sensitivity: String(sensitivity) } };
}

/** Set path supervision mode. OPTIONS form field is `mode`. */
export function setPathSupervisionMode(mechunit: string, mode: string): Rws2Write {
  return { path: buildPath(MOTION.setPathSupervisionMode.rws2 as PathSpec, { mechunit }), body: { mode } };
}

// ─── Devices Service (/rw/devices) ───────────────────────────────────────────

/** Search the hardware device tree for a node. The controller field is
 *  `property` (SINGULAR) - the OPTIONS form advertises `properties`, but that is
 *  rejected with "property parameter is required" (live-verified 2026-08, RW7.21;
 *  another OPTIONS-vs-actual mismatch). The value is a device-tree node path. */
export function searchDevices(property: string): Rws2Write {
  return { path: '/rw/devices/search', body: { property } };
}

// ─── IO Service (/rw/iosystem) ───────────────────────────────────────────────

/**
 * Write an IO signal value. RWS 2.0 uses a path-based action `/set-value` with a
 * `lvalue` body (RWS 1.0 used ?action=set on the signal URL).
 */
export function setSignalValue(network: string, device: string, name: string, value: string): Rws2Write {
  return { path: buildPath(IO.writeSignal.rws2 as PathSpec, { network, device, name }), body: { lvalue: value } };
}

/**
 * Write the value of a signal the controller reports with no device: its
 * resource path is `signals/{name}`, and ABB's `set-value` action is appended.
 * Only for such signals - a device-bound signal is written at its full path.
 */
export function setSignalValueByName(name: string, value: string): Rws2Write {
  return { path: buildPath(IO.writeSignalByName.rws2 as PathSpec, { name }), body: { lvalue: value } };
}

/** Read one signal by its bare name (`GET /rw/iosystem/signals/{name}`). */
export function signalByName(name: string): string {
  return buildPath(IO.readSignalByName.rws2 as PathSpec, { name });
}

/**
 * Search IO signals by criteria. The `name` criterion is a case-insensitive
 * PREFIX match, not a substring match (`do8` does not find `IIO_do8`; `IIO_do`
 * does; `automaticmode` finds AutomaticMode), and not a wildcard or regex
 * ('*' and '.*' match nothing); `device`, `network` and `category` match whole
 * values; criteria compose as AND.
 * Live-verified 2026-08-04 (RW7.21) for the no-wildcard and AND facts; the
 * "substring" claim recorded that day was wrong - the prefix match was verified
 * 2026-09-27 on RW 6.16, 7.21 and 8.1.1. Results are standard ios-signal-li
 * entries.
 */
export function searchSignals(criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Rws2Write {
  const body: Record<string, string> = {};
  if (criteria.name)     { body['name'] = criteria.name; }
  if (criteria.device)   { body['device'] = criteria.device; }
  if (criteria.network)  { body['network'] = criteria.network; }
  if (criteria.category) { body['category'] = criteria.category; }
  if (criteria.type)     { body['type'] = criteria.type; }
  return { path: buildPath(IO.searchSignals.rws2 as PathSpec), body };
}

/** Simulate (force) or un-simulate a signal's logical state. OPTIONS form:
 *  `lstate` = 'simulated' | 'not simulated'. Reversible; live round-tripped
 *  2026-08 on RW7.21. */
export function setSignalSimulated(network: string, device: string, name: string, simulated: boolean): Rws2Write {
  return {
    path: buildPath(IO.setSignalSimulated.rws2 as PathSpec, { network, device, name }),
    body: { lstate: simulated ? 'simulated' : 'not simulated' },
  };
}

/** Start or stop an IO network. OPTIONS form: `lstate` = 'start' | 'stop'. */
export function setNetworkLState(network: string, start: boolean): Rws2Write {
  return { path: buildPath(IO.setNetworkLState.rws2 as PathSpec, { network }), body: { lstate: start ? 'start' : 'stop' } };
}

/** Enable or disable an IO device. OPTIONS form: `lstate` = 'enable' | 'disable'. */
export function setIoDeviceLState(network: string, device: string, enable: boolean): Rws2Write {
  return {
    path: buildPath(IO.setIoDeviceLState.rws2 as PathSpec, { network, device }),
    body: { lstate: enable ? 'enable' : 'disable' },
  };
}

// ─── File Service (/fileservice) ─────────────────────────────────────────────

/**
 * Rename a file in place. The body field is `fs-newname` - the published spec's
 * `new-filename` is rejected with "Invalid/No Query Parameter". Live-verified
 * 2026-08-04 (RW7.21): create, rename, read back round trip.
 */
export function renameFile(dirAndFile: string, newName: string): Rws2Write {
  return { path: `/fileservice/${dirAndFile}/rename`, body: { 'fs-newname': newName } };
}

// ─── Elog Service (/rw/elog) ─────────────────────────────────────────────────

/** Read event-log messages for a domain (0 = common controller log). */
export function elogMessages(domain = 0, lang = 'en'): string {
  return `${buildPath(CFG_ELOG_DIPC.getEventLog.rws2 as PathSpec, { domain })}?lang=${encodeURIComponent(lang)}`;
}

/** Clear the event log for one domain. */
export function clearElogDomain(domain = 0): Rws2Write {
  return { path: buildPath(CFG_ELOG_DIPC.clearEventLog.rws2 as PathSpec, { domain }) };
}

/** Clear the event log across all domains. */
export function clearAllElogs(): Rws2Write {
  return { path: buildPath(CFG_ELOG_DIPC.clearAllEventLogs.rws2 as PathSpec) };
}

/** Dump the full event log to a file in system-dump format (for diagnostics/
 *  support). Field `path`; the value must be a fileservice URI (202 Accepted,
 *  file created - live-verified 2026-08-04, RW7.21). */
export function saveEventLogRaw(destination: string): Rws2Write {
  return { path: buildPath(CFG_ELOG_DIPC.saveEventLogRaw.rws2 as PathSpec), body: { path: toFileserviceUri(destination) } };
}

// ─── CFG Service (/rw/cfg) ───────────────────────────────────────────────────

/**
 * Load a CFG file into a domain. Official endpoint is /rw/cfg/load (posting to
 * /rw/cfg 405s). Body is `filepath` + `action-type` (add | replace | add-with-reset).
 */
export function loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset'): Rws2Write {
  return { path: buildPath(CFG_ELOG_DIPC.loadCfgFile.rws2 as PathSpec), body: { 'action-type': action, filepath } };
}

/**
 * Normalize a controller path to the fileservice-URI form the file-target write
 * endpoints require. Discovered 2026-08-04 on RW7.21 AND RW6.16: cfg saveas,
 * elog saveraw and backup create/restore all reject bare volume paths
 * ('TEMP/x', 'TEMP:', '$TEMP/x' - "Virtual root does not exist" / "backup data
 * parameter is invalid") but accept '/fileservice/TEMP/x' (204/202, file
 * created). Idempotent for already-prefixed values.
 */
export function toFileserviceUri(path: string): string {
  const clean = path.replace(/^\/+/, '');
  return clean.startsWith('fileservice/') ? `/${clean}` : `/fileservice/${clean}`;
}

/**
 * Save a CFG domain to a file. The endpoint is /rw/cfg/{domain}/saveas (/save 405s)
 * and the body field is `filepath` - the spec's `destination` is wrong (OPTIONS on
 * /rw/cfg/{domain}/saveas lists `filepath`). The value must be a fileservice URI;
 * bare volume paths are rejected. Live-verified 2026-08-04 (204, file created).
 */
export function saveCfgFile(domain: string, filepath: string): Rws2Write {
  return { path: buildPath(CFG_ELOG_DIPC.saveCfgFile.rws2 as PathSpec, { domain }), body: { filepath: toFileserviceUri(filepath) } };
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
  return { path: buildPath(CFG_ELOG_DIPC.createDipcQueue.rws2 as PathSpec), body };
}

/**
 * Send a message to a DIPC queue. `dipc-userdef` is REQUIRED by the controller
 * (omitting it returns HTTP 400 "Error in name field dipc-userdef") - the old code
 * left it out, so every send failed. Live-verified 2026-08-03 (send -> 204).
 * @param msgtype controller code: 0=string, 1=num, 2=dnum, 3=bool.
 */
export function sendDipcMessage(queue: string, payload: string, msgtype: string): Rws2Write {
  return {
    path: buildPath(CFG_ELOG_DIPC.sendDipcMessage.rws2 as PathSpec, { queue }),
    body: {
      'dipc-src-queue-name': queue,
      'dipc-cmd': '111',    // SEND
      'dipc-userdef': '0',  // required by controller
      'dipc-data': payload,
      'dipc-msgtype': msgtype,
    },
  };
}

/**
 * The wait of a DIPC read as ABB's `timeout` value: whole milliseconds, never
 * negative. A value that is not a finite number is 0, the controller's default
 * (no wait), as the RWS 1.0 adapter does when it leaves the parameter out.
 */
export function dipcReadTimeoutMs(timeoutMs = 0): number {
  return Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
}

/**
 * Read a message from a DIPC queue. RWS 2.0 read is a GET on the queue (the
 * old POST /{queue}/read 404s; live-verified 2026-08-03) with ABB's `timeout`
 * query parameter in milliseconds. The client used to send `dipc-timeout`,
 * which is not ABB's name; the controller ignores an optional parameter it
 * does not know, so such a read never waited.
 */
export function readDipcMessage(queue: string, timeoutMs = 0): string {
  return `${buildPath(CFG_ELOG_DIPC.readDipcMessage.rws2 as PathSpec, { queue })}?timeout=${dipcReadTimeoutMs(timeoutMs)}`;
}

/** Delete a DIPC queue. */
export function removeDipcQueue(name: string): Rws2Write {
  return { path: buildPath(CFG_ELOG_DIPC.removeDipcQueue.rws2 as PathSpec, { queue: name }) };
}

// ─── Control Station Service (/rw/controlstation) - RobotWare 8 ──────────────
// RW8 removes Mastership entirely (/rw/mastership returns HTTP 410 GONE) and
// replaces it with this service. All wire forms below live-verified 2026-08-04
// on an OmniCore VC RW8.1.1 unless noted. Registration is SESSION-scoped: the
// register call binds THIS session to the station; a new session must
// re-register. RW8's OPTIONS returns 204 with no form body, so field names came
// from controller error messages (which name the missing field) and trials.

/**
 * Register this session as a remote control station. Required before any write
 * access on RW8 (unregistered request answers 403 "Session is not part of a
 * Control Station"). The id's length is what the controller was seen to
 * check: every 38-character id tried registered, and the other lengths tried
 * were refused with 400 -1073435867 "Control station id not allowed"
 * (live-verified 2026-09-29 on RW 8.2.1+1023; the accepted character set was
 * not tested). This client sends a braced GUID, '{8-4-4-4-12}' (38
 * characters), as its own convention.
 *
 * `releaseWriteAccessWhenLost` adds ABB's optional
 * `release-write-access-when-lost` field, in the `{TRUE|FALSE}` form the
 * RobotWare 8 Control Station Service documents, and only when true: without
 * it the body is exactly the three fields every registration has sent so far,
 * and the controller's documented default (false) applies. The field has not
 * been sent to a live controller yet.
 */
export function registerControlStationRemote(
  name: string, id: string, pincode: string, releaseWriteAccessWhenLost = false,
): Rws2Write {
  return {
    path: buildPath(SYSTEM_MASTERSHIP.registerControlStationRemote.rws2 as PathSpec),
    body: {
      'control-station-name': name, 'control-station-id': id, pincode,
      ...(releaseWriteAccessWhenLost ? { 'release-write-access-when-lost': 'TRUE' } : {}),
    },
  };
}

/** Register this session as the local control station (pendant side). Field
 *  name from the RW8 migration guide; not live-verified (needs local presence). */
export function registerControlStationLocal(localPresenceKey: number): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.registerControlStationLocal.rws2 as PathSpec), body: { 'local-presence-key': String(localPresenceKey) } };
}

/** Request write access (the RW8 successor of mastership request). 204 on grant. */
export function requestWriteAccess(): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.requestWriteAccess.rws2 as PathSpec) };
}

/** Release write access. 204 on success. */
export function releaseWriteAccess(): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.releaseWriteAccess.rws2 as PathSpec) };
}

/** Appeal to the current holder to release write access; poll the changecount
 *  resource and re-request when it changes. */
export function appealWriteAccessRelease(): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.appealWriteAccessRelease.rws2 as PathSpec) };
}

/** Enable or disable motion control for the control station. Field name from
 *  the RW8 migration guide; the GET side (is-enabled) is live-verified. */
export function setAllowMotionControl(allow: boolean): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.setAllowMotionControl.rws2 as PathSpec), body: { 'allow-motion-control': allow ? 'true' : 'false' } };
}

/** Explicitly disable external control. */
export function disableExternalControl(): Rws2Write {
  return { path: buildPath(SYSTEM_MASTERSHIP.disableExternalControl.rws2 as PathSpec) };
}

// ─── Controller Service - backup (/ctrl/backup) ──────────────────────────────

/** Backup value: a bare name targets the BACKUP volume; any path is normalized
 *  to the fileservice URI the controller requires (bare forms answer 400
 *  "backup data parameter is invalid" - live-verified 2026-08-04, RW7.21). */
function backupUri(name: string): string {
  return toFileserviceUri(name.includes('/') ? name : `BACKUP/${name}`);
}

/** Create a controller backup. 202 Accepted (async; poll /ctrl/backup or the
 *  progress resource). Live-verified 2026-08-04. */
export function createBackup(name: string): Rws2Write {
  return { path: buildPath(CTRL.createBackup.rws2 as PathSpec), body: { backup: backupUri(name) } };
}

/** Restore a controller backup (the controller restarts as part of restore).
 *  `delete-dir` is always sent: ABB's restore form defaults it to true, which
 *  deletes the backup after the restore, so it is false unless `deleteBackup`. */
export function restoreBackup(name: string, deleteBackup = false): Rws2Write {
  return {
    path: buildPath(CTRL.restoreBackup.rws2 as PathSpec),
    body: { backup: backupUri(name), 'delete-dir': deleteBackup ? 'true' : 'false' },
  };
}

/** Validate a backup without restoring it. 200 when the backup is valid and
 *  restorable. Live-verified 2026-08-04 against a freshly created backup. */
export function checkRestore(name: string): Rws2Write {
  return { path: buildPath(CTRL.checkRestore.rws2 as PathSpec), body: { backup: backupUri(name) } };
}
