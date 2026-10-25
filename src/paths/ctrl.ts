import { refusalError, remedy } from '../refusal.js';
import { RwsError } from '../types.js';

/**
 * The wire value of a virtual-time speed, shared by both generations: a percent
 * of real time (100 = real time) and -1 for "as fast as possible", as Rev L and
 * the controller forms on RW 7.21.4 and 8.2.1 give it (both read
 * vtcurrspeed=100 at rest; writes post the field vtspeed). The client's
 * contract is a factor (1 = real time), so 10 sends 1000 and `Infinity` sends -1. 0, a negative value or NaN is
 * refused before anything is sent: pause with RobotStudio's Simulation tab.
 * @throws RwsError `INVALID_ARGUMENT`
 */
export function virtualTimePercent(scale: number, who: string): number {
  if (scale === Infinity) { return -1; }
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    throw new RwsError(`${who} setVirtualTimeScale: the scale must be a positive factor of real time (1 = real time) or Infinity for full speed, got ${scale}; pause with RobotStudio's Simulation tab`, 'INVALID_ARGUMENT');
  }
  return Math.round(scale * 100);
}

/**
 * What the deprecated `setVirtualTimeRunning` throws on every surface
 * (`RobotManager`, `RWS1Adapter`, `RwsClient2`): `UNSUPPORTED_OPERATION`, with
 * nothing sent and a `refusal` of kind `unsupported`, like the client's other
 * refusals before sending. Pause and resume the virtual clock from
 * RobotStudio's Simulation tab. Kept so code written for 1.3.x still
 * compiles; removed at the next major version (2.0).
 */
export function virtualTimeRunningUnsupported(): RwsError {
  const fix = "Pause and resume the virtual clock from RobotStudio's Simulation tab.";
  return refusalError('UNSUPPORTED_OPERATION', {
    kind: 'unsupported', condition: 'none', generation: null, grantor: 'nobody',
    missing: 'a virtual-clock pause or resume over RWS (this client sends none)',
    fix,
    sentence: `setVirtualTimeRunning: nothing was sent. ${fix} This method is deprecated and is removed in 2.0.`,
    evidence: 'unverified',
    remedy: remedy.notAvailable(null, { detail: fix, evidence: 'unverified', basis: 'a deprecated method that sends nothing' }),
  });
}

/**
 * Controller domain path table (`/ctrl`).
 *
 * Hand-built from the ctrl inventory. Operations whose "path" actually lives
 * under another root are OMITTED and belong to that domain's table:
 *   - getEnergyStats / resetEnergy      -> /rw/system/energy  (systemMastership)
 *   - listControllerOptions             -> /rw/system/options (systemMastership)
 *   - getTpuSafetyProtocolStatus        -> /rw/controlstation/tpu/... (systemMastership)
 *   - listBackups                       -> /fileservice/BACKUP (filesVision)
 * Composite operations that issue no single URL (getSafetyStatus, getVirtualTime)
 * are omitted - the table holds atomic request paths, not orchestration.
 *
 * Each row's `evidence` says which sides have a logged 2xx; a side that is
 * only built follows ABB's documentation or the controller's own form, and
 * its note says what is known.
 */

import type { DomainTable } from './PathSpec.js';

export const CTRL: DomainTable = {
  // ── Identity / clock ──────────────────────────────────────────────────────
  getControllerIdentity: {
    tier: 'common', evidence: 'live',
    summary: 'Read controller name, id, type, MAC.',
    rws2: { method: 'GET', path: '/ctrl/identity' },
    rws1: { method: 'GET', path: '/ctrl/identity' },
  },
  getControllerClock: {
    tier: 'common', evidence: 'live',
    summary: 'Read the controller date/time (UTC).',
    rws2: { method: 'GET', path: '/ctrl/clock' },
    rws1: { method: 'GET', path: '/ctrl/clock' },
  },
  setControllerClock: {
    tier: 'common', evidence: 'built',
    summary: 'Set the controller date/time (UTC).',
    rws2: { method: 'PUT', path: '/ctrl/clock', fields: ['sys-clock-year', 'sys-clock-month', 'sys-clock-day', 'sys-clock-hour', 'sys-clock-min', 'sys-clock-sec'] },
    rws1: { method: 'PUT', path: '/ctrl/clock', fields: ['sys-clock-year', 'sys-clock-month', 'sys-clock-day', 'sys-clock-hour', 'sys-clock-min', 'sys-clock-sec'] },
    note: 'one of very few PUTs in either generation. ABB documents PUT /ctrl/clock for real controllers only (RWS 2.0 Rev L "Supported only in RC"; RWS 1.0 Rev M "Available only for RC"): a virtual controller answers 405 -1073414146 (RW 7.21.4 and 8.2.1, 2026-10-11, OPTIONS 204 with no form; RW 6.16.03, 2026-10-13). The method is the documented one; the refusal is the VC\'s.',
  },
  getTimezone: {
    tier: 'niche', evidence: 'built',
    summary: 'Read the controller timezone.',
    rws1: { method: 'GET', path: '/ctrl/clock/timezone' },
    note: 'RWS 1.0 only.',
  },

  // ── Restart / restart count ───────────────────────────────────────────────
  restartController: {
    tier: 'common', evidence: 'live',
    summary: 'Restart the controller (canonical /ctrl form on 2.0).',
    // The biggest cross-generation split in this domain: 2.0 /ctrl/restart
    // (needs edit mastership), 1.0 /rw/panel?action=restart. Same body field.
    // Mirrors panel.restartController - kept in both tables intentionally, as
    // the operation legitimately belongs to both trees by generation.
    rws2: { method: 'POST', path: '/ctrl/restart', fields: ['restart-mode'] },
    rws1: { method: 'POST', path: '/rw/panel', action: 'restart', fields: ['restart-mode'] },
    note: '2.0 /ctrl/restart (6 modes, edit mastership) vs 1.0 /rw/panel?action=restart (4 modes).',
  },
  getRestartCount: {
    tier: 'niche', evidence: 'live',
    summary: 'Read how many times the controller has restarted.',
    rws2: { method: 'GET', path: '/ctrl/restart/restartcount' },
    note: 'RWS 2.0 only.',
  },

  // ── Network (RWS 1.0 only) ────────────────────────────────────────────────
  getNetworkConfig: {
    tier: 'niche', evidence: 'live',
    summary: 'Read network configuration.',
    rws1: { method: 'GET', path: '/ctrl/network' },
    note: 'RWS 1.0 only; same URL backs listNetworkInterfaces.',
  },
  getDnsConfig: {
    tier: 'niche', evidence: 'built',
    summary: 'Read DNS configuration.',
    rws1: { method: 'GET', path: '/ctrl/network/dns' },
    note: 'RWS 1.0 only. One ctrl-netw-dns entry per setting, named by its title (name, primaryns, secondaryns, tertiaryns, quaternaryns, port); the method returns every entry. ABB: not supported by a virtual controller.',
  },
  getRoutingTable: {
    tier: 'niche', evidence: 'built',
    summary: 'Read the routing table (a path ABB does not document).',
    // ABB's RWS 1.0 (Rev M) documents only adding and removing a route
    // (/ctrl/network/route/add and /remove, "Not supported by VC"), and RWS
    // 2.0 no route read. GET /ctrl/network/routes is in no ABB page.
    rws1: { method: 'GET', path: '/ctrl/network/routes' },
    note: 'RWS 1.0 only, a path in no ABB document; answers [] when the controller refuses it. Not yet run.',
  },

  // ── Diagnostics / language / system info ──────────────────────────────────
  getDiagnostics: {
    tier: 'niche', evidence: 'built',
    summary: 'Read saved controller diagnostics.',
    rws2: { method: 'GET', path: '/ctrl/diagnostics' },
    note: 'RWS 2.0 only. Empty controller answers 400 "No Diagnostics Saved" - an empty state, not an error.',
  },
  saveDiagnostics: {
    tier: 'niche', evidence: 'live',
    summary: 'Ask the controller to save a diagnostics bundle.',
    // ABB Controller_Service.yaml Rev L: the one body field is `dstpath`, a
    // required fileservice path ("Fully qualified file name to save the
    // diagnostic log"; samples send dstpath=/fileservice/$TEMP/sysdump/...).
    // The client used to send `data`, which the controller does not read: its
    // refusal "No destination path in the data parameter" means the form body
    // as a whole, not a field called data (spec check 2026-10-07).
    rws2: { method: 'POST', path: '/ctrl/diagnostics/save', fields: ['dstpath'] },
    note: 'RWS 2.0 only; run live on RW 7.21.4 (2026-10-11: 204, the file was not listed 3 s later). Field dstpath (Rev L, required), value a /fileservice/ URI. ABB marks the operation not supported on a VC; the OPTIONS form on RW 7.21.4 and 8.2.1 lists no inputs.',
  },
  setControllerLanguage: {
    tier: 'niche', evidence: 'live',
    summary: 'Set the controller language.',
    // Field is `lang`, NOT the panel's `lang-code` - easy to confuse.
    rws2: { method: 'POST', path: '/ctrl/lang', fields: ['lang'] },
    // RWS 1.0 query-action form, same lang field. Live-verified RW6.16
    // (2026-08-11): 204.
    rws1: { method: 'POST', path: '/ctrl', action: 'set-lang', fields: ['lang'] },
    note: 'Write-only (GET 405). Field lang, not the panel lang-code. RWS 2.0 path /ctrl/lang; RWS 1.0 query-action /ctrl?action=set-lang.',
  },
  saveSystemInfo: {
    tier: 'niche', evidence: 'built',
    summary: 'Copy the system\'s installation files (RMF, RSF, RLF) into a controller directory (real controllers only).',
    rws2: { method: 'POST', path: '/ctrl/system/info', fields: ['path', 'file-type'] },
    note: 'RWS 2.0 only. NOT a getter (GET 405). ABB (Rev L): the controller copies its installation files to `path`, the caller removes them; "Supported only in RC". The RobotWare 7 and 8 VCs answered 403 "not supported on platform". Rev L makes file-type optional (default FileType_ALL); the client sends it only when given. The 200 answer lists the copied files (ctrl-system-info-li, file name in the title, /fileservice/ link); the method returns nothing, as in 1.4.0, and the caller lists the directory.',
  },

  // ── Compatibility ─────────────────────────────────────────────────────────
  getCompatibility: {
    tier: 'niche', evidence: 'built',
    summary: 'Check whether the controller hardware can run a RobotWare version (real controllers only).',
    // ABB documents GET /ctrl/compatibility/{robotware version} on both
    // generations (RWS 1.0 Rev M, RWS 2.0 Rev L), "Supported only in RC", with
    // the answer in ctrl-compatibility/status. Up to 1.4.0 the RWS 1.0 method
    // sent GET /ctrl/compatible, which is in no ABB page, took no version and
    // answered compatible: false on any error; RWS 2.0 had no method. The
    // version stays optional, as the 1.4.0 call took none: without it the
    // client sends the controller's own rwversion from GET /rw/system.
    rws2: { method: 'GET', path: '/ctrl/compatibility/{version}' },
    rws1: { method: 'GET', path: '/ctrl/compatibility/{version}' },
    note: 'ABB lists it for real controllers only; the virtual controllers answer 404, so no run has a 2xx. Without a version the client asks about the one the controller runs (rwversion from /rw/system, sent as written, e.g. 6.16.3007 or 8.2.1+1023); whether a real controller takes the RobotWare 7/8 form with its +build suffix is not known. The status is read as true or false; anything else is PARSE_ERROR, and a refusal is the controller\'s typed error, never compatible: false.',
  },

  // ── Excluded /ctrl endpoints (recorded, not implemented) ──────────────────
  getSyslog: {
    tier: 'niche', evidence: 'built',
    summary: 'Read the controller system log.',
    // ABB (Rev L): the security syslog, RFC 3164, at most 2500 messages, RW 7.1
    // and later, answered as text/plain;v=2.0.
    rws2: { method: 'GET', path: '/ctrl/syslog', gap: 'not wrapped: ABB documents GET /ctrl/syslog (the security syslog, RFC 3164, RW 7.1 and later, answered as text/plain;v=2.0); the VCs answered 406 to the six Accept values tried, and text/plain;v=2.0 was not one of them. RWS 1.0 has no such resource (404)' },
    note: 'excluded - recorded refusal; the Accept value ABB names was not tried.',
  },
  getEnv: {
    tier: 'niche', evidence: 'live',
    summary: 'Read one controller environment variable ($HOME, $TEMP, $SYSTEM, ...).',
    // ABB's "Get Controller environment variable" (RWS 1.0 Rev M ctrl_env page;
    // RWS 2.0 Rev L Controller service, /ctrl/${ENVNAME}): the variable is the
    // path segment itself, its `$` sent as %24 (ABB's own example base href is
    // /ctrl/%24TEMP/), and the answer is one ctrl-env entry with a `value`
    // span. RW 6.16.03 answers the RWS 1.0 ?json=1 form with the value under
    // `_value` instead (2026-10-18). The row used to record /ctrl/env, a path
    // in no ABB document; its 404 said nothing about the documented resource.
    rws2: { method: 'GET', path: '/ctrl/%24{name}' },
    rws1: { method: 'GET', path: '/ctrl/%24{name}' },
    note: 'the name is sent without its leading `$` after the literal %24 (getEnv accepts either spelling). The value is read from `value`, else `_value` (RW 6.16.03, ?json=1). An unknown name is the controller\'s 404. TEMP, HOME and BACKUP answered 200 on RW 6.16.03, 7.21.4 and 8.2.1 virtual controllers (2026-10-18).',
  },
  getSystems: {
    tier: 'niche', evidence: 'built',
    summary: 'Read the installed system (RC only).',
    // Rev L names the RWS 2.0 resource /ctrl/system ("Supported only in RC");
    // /ctrl/systems is the RWS 1.0 manual's name. The row used to carry the
    // 1.0 name under rws2 (spec check 2026-10-07). No method uses it.
    rws2: { method: 'GET', path: '/ctrl/system', gap: 'RC only (Rev L: Supported only in RC); VC 404 -1073445866, the same answer as a made-up /ctrl path' },
    note: 'excluded. RWS 1.0 manual names it /ctrl/systems.',
  },
  tpuScreendump: {
    tier: 'niche', evidence: 'built',
    summary: 'Capture a FlexPendant screenshot.',
    rws2: { method: 'POST', path: '/ctrl/tpu/screendump', gap: 'real controllers only (ABB Rev L: RC only, RW 7.3 and later); the VCs answer 404 -1073445866; no client method. RWS 1.0 has no such resource' },
    note: 'excluded.',
  },
  tpuDetach: {
    tier: 'niche', evidence: 'built',
    summary: 'Detach the FlexPendant for hot-swap.',
    rws2: { method: 'POST', path: '/ctrl/tpu/detach', gap: 'real controllers with the Hot Swappable FlexPendant option only (ABB Rev L documents the detach, its status read and a cancel, RC only); the RobotWare 7 and 8 VCs answer 404; no client method. RWS 1.0 has no such resource' },
    note: 'excluded.',
  },
  systemUpdate: {
    tier: 'niche', evidence: 'built',
    summary: 'Software update (barred by the destructive ceiling).',
    rws2: { method: 'POST', path: '/ctrl/system/update', fields: ['path'], gap: 'beyond the destructive ceiling - never executed; form recorded only' },
    note: 'barred - form recorded for the record.',
  },

  // ── Safety ────────────────────────────────────────────────────────────────
  getSafetyMode: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the safety mode.',
    rws2: { method: 'GET', path: '/ctrl/safety/mode' },
    note: 'RWS 2.0 only.',
  },
  getSafetyViolationInfo: {
    tier: 'niche', evidence: 'live',
    summary: 'Read safety violation info.',
    rws2: { method: 'GET', path: '/ctrl/safety/violation' },
    note: 'RWS 2.0 only.',
  },
  getSafetyLoadStatus: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the safety load status.',
    rws2: { method: 'GET', path: '/ctrl/safety/load' },
    note: 'RWS 2.0 only. RW 7.21.4 and 8.2.1 virtual controllers answered "OK" to Admin; RW 7.21.4 answered "SCORCH_ERR_USER_GRANT_IS_MISSING" to the Default User, as a 200 (2026-10-18).',
  },
  getSafetyStartupStatus: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the safety startup status.',
    rws2: { method: 'GET', path: '/ctrl/safety/config/startupstatus' },
    // New in RobotWare 7.20 together with /ctrl/safety/config/changecount (the
    // safety-configuration change count, for polling whether the safety
    // configuration changed): ABB RobotWare release notes 7.20.0 §1.2 p.3-4,
    // "RWS APIs for Safety controller functions" ("The following new APIs are
    // implemented for safety controller functions") (release notes,
    // 2026-09-29). changecount is the getSafetyConfigChangeCount row below.
    note: 'RWS 2.0 only, RW 7.20+ (new in 7.20 with /ctrl/safety/config/changecount, see getSafetyConfigChangeCount); controller misspells the response class (…-load-satus), code reads both.',
  },
  getSafetyConfigChangeCount: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the safety-configuration change count.',
    // New in RobotWare 7.20 (release notes 7.20.0 §1.2, see above). Answered 200
    // on RW 7.21.4+417 and 8.2.1+1023 (2026-09-29): class
    // safety-config-change-count, field count.
    rws2: { method: 'GET', path: '/ctrl/safety/config/changecount' },
    note: 'RWS 2.0 only, RW 7.20+. Poll it to notice a safety-configuration change.',
  },
  getSafetyConfig: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the safety configuration (status, versions, creator, checksum).',
    // ABB Controller_Service.yaml Rev L "Get Safety Configurations": classes
    // safety-ctrl-configuration-status (config-status) and
    // safety-ctrl-configuration. Advertised under /ctrl/safety on RW 7.21.4+417
    // and 8.2.1+1023 (crawl 2026-09-30). The POST on the same path loads a
    // safety configuration file and is not wrapped.
    rws2: { method: 'GET', path: '/ctrl/safety/config' },
    note: 'RWS 2.0 only. GET reads; POST (load a safety configuration) is not wrapped.',
  },
  getSafetyStatus: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the aggregate controller safety status.',
    rws1: { method: 'GET', path: '/ctrl/safety' },
    note: '1.0 reads /ctrl/safety directly; 2.0 has no single URL - it composes getSafetyMode + getSafetyViolationInfo + getSafetyLoadStatus, so no rws2 entry here.',
  },
  listSafetyZones: {
    tier: 'niche', evidence: 'built',
    summary: 'List safety zones (no such RWS resource).',
    // In no ABB document (Rev L lists mode, violation, load, config, cbc under
    // /ctrl/safety). RW 7.21.4 and 8.2.1 answer 404 "Resource is not supported
    // on virtual controller", the same text as any made-up /ctrl path, so the
    // 404 is not a VC limitation. Rev M lists six /ctrl/safety resources and
    // no zones; RW 6.16.03 answers 404 (spec check 2026-10-09). Neither client
    // sends anything: both answer []. Row kept so the public method stays documented.
    rws2: { method: 'GET', path: '/ctrl/safety/zones', gap: 'in no ABB document (Rev L has no zones resource under /ctrl/safety); nothing is sent, the method answers []' },
    rws1: { method: 'GET', path: '/ctrl/safety/zones', gap: 'in no ABB document (Rev M lists six /ctrl/safety resources, none of them zones); nothing is sent, the method answers []' },
    note: 'no ABB resource; deprecated, kept until the next major version. Both generations answer [] without a request (no Rev M or Rev L page; RW 6.16.03, 7.21.4 and 8.2.1 answer 404).',
  },
  runCyclicBrakeCheck: {
    tier: 'niche', evidence: 'built',
    summary: 'Run a cyclic brake check (no such RWS operation).',
    // In no ABB document: Rev L documents only the status read, GET
    // /ctrl/safety/cbc?drivenum=. OPTIONS on this path gives the VC's generic
    // 404 for an unknown /ctrl resource, not a "not on a VC" refusal. A brake
    // check is started from RAPID or the FlexPendant. Rev M also documents only
    // the status read (/ctrl/safety?resource=cbc-status). Both clients throw
    // UNSUPPORTED_OPERATION without sending (spec checks 2026-10-07 and 2026-10-09).
    rws2: { method: 'POST', path: '/ctrl/safety/cyclic-brake-check', gap: 'no ABB operation starts a cyclic brake check (ABB documents only the status read); nothing is sent (UNSUPPORTED_OPERATION)' },
    rws1: { method: 'POST', path: '/ctrl/safety/cyclic-brake-check', gap: 'no ABB operation starts a cyclic brake check (ABB documents only the status read); nothing is sent (UNSUPPORTED_OPERATION)' },
    note: 'no ABB resource; kept until the next major version. On RWS 2.0 read the status with getCyclicBrakeCheckStatus; the client has no RWS 1.0 status read (Rev M documents /ctrl/safety?resource=cbc-status). RW 6.16.03 answers 404 and /ctrl/safety links no such resource (no Rev M page; spec check 2026-10-09).',
  },
  getCyclicBrakeCheckStatus: {
    tier: 'niche', evidence: 'live',
    summary: 'Read cyclic-brake-check status.',
    // drivenum query param is REQUIRED; documented in note (queries not in path).
    rws2: { method: 'GET', path: '/ctrl/safety/cbc' },
    note: 'RWS 2.0 only. GET-only (405 on POST). REQUIRES ?drivenum={n} query param.',
  },

  // ── Backup ────────────────────────────────────────────────────────────────
  createBackup: {
    tier: 'common', evidence: 'live',
    summary: 'Create a backup (async, 202).',
    // Both require a /fileservice/... URI value; bare names 400 on both.
    rws2: { method: 'POST', path: '/ctrl/backup/create', fields: ['backup'] },
    rws1: { method: 'POST', path: '/ctrl/backup', action: 'backup', fields: ['backup'] },
    note: '2.0 subresource vs 1.0 ?action=backup; value must be a /fileservice/ URI.',
  },
  restoreBackup: {
    tier: 'niche', evidence: { rws1: 'live', rws2: 'built' },
    summary: 'Restore a backup.',
    // `delete-dir` defaults to true on both generations (RWS 1.0 Rev M, RWS 2.0
    // Rev L): without it a restore deletes the backup it restored, as it did
    // on RW 6.16.03 (2026-10-09). The client sends it on both, false unless
    // the caller asks.
    rws2: { method: 'POST', path: '/ctrl/backup/restore', fields: ['backup', 'delete-dir'] },
    rws1: { method: 'POST', path: '/ctrl/backup', action: 'restore', fields: ['backup', 'delete-dir'] },
    note: 'same subresource-vs-query-action split as create.',
  },
  checkRestore: {
    tier: 'common', evidence: 'live',
    summary: 'Validate a backup before restoring.',
    rws2: { method: 'POST', path: '/ctrl/backup/check-restore', fields: ['backup'] },
    // RWS 1.0: a GET with the backup as a query parameter, as ABB's manual
    // (Rev M, "Check restore") documents; RW 6.16.03 answered it 200 with
    // ctrl-checkrestore status Accepted, and the POST this row used to give
    // 400 "Invalid Request" (2026-10-09). The backup is the query parameter
    // `backup`, appended by the adapter (a GET row carries no body fields).
    rws1: { method: 'GET', path: '/ctrl/backup', action: 'check-restore' },
    note: '2.0 POST subresource vs 1.0 GET ?action=check-restore&backup=; the value is a /fileservice/ URI on both.',
  },
  getBackupStatus: {
    tier: 'common', evidence: 'live',
    summary: 'Read whether a backup is running (from the backup state).',
    // /ctrl/backup is a listing of links (backup-info, state, create, restore,
    // check-restore) with no progress fields, so reading it answered
    // active=false always (spec check 2026-10-07; RW 7.21.4 and 8.2.1). The
    // state text lives at /ctrl/backup/state (class ctrl-backup-state, field
    // backup-state: 'Init State', 'Backup in Progress', 'Backup Ready',
    // 'Error during backup', 'Invalid', 'None'), the resource getBackupState
    // reads.
    rws2: { method: 'GET', path: '/ctrl/backup/state' },
    rws1: { method: 'GET', path: '/ctrl/backup' },
    note: '2.0 reads the state text at /ctrl/backup/state and maps it to active / failed; 1.0 reads /ctrl/backup.',
  },
  getBackupState: {
    tier: 'common', evidence: 'live',
    summary: 'Read the backup state.',
    rws2: { method: 'GET', path: '/ctrl/backup/state' },
    note: 'RWS 2.0 only; overlaps semantically with getBackupStatus.',
  },

  // ── Virtual time ──────────────────────────────────────────────────────────
  setVirtualTimeScale: {
    tier: 'niche', evidence: 'live',
    summary: 'Set the virtual-time speed.',
    // The wire value is a percent of real time: 100 = real time, -1 = as fast
    // as possible (Rev L and the forms; both generations read vtcurrspeed=100
    // at rest). The client's contract is a factor (1 = real time), converted
    // in the adapters; it used to send the factor unchanged, so 1 meant 1 %.
    // RWS 2.0: the form advertises vtcurrspeed, but the controller refuses it
    // (400 -1073445879 "Invalid data value"); Rev L's field vtspeed, with no
    // action, answered 204 to 100, 1000 and -1 and read back as sent on
    // RW 7.21.0, 7.21.4 and 8.2.1 (2026-10-10). Reads keep vtcurrspeed.
    rws2: { method: 'POST', path: '/ctrl/virtualtime/vtspeed', fields: ['vtspeed'] },
    // RWS 1.0: Rev M's "Set Speed of Virtualtime" posts the field vtspeed with
    // no action (virtual controllers only). Not sent: the client sends no
    // virtual-time write on RobotWare 6 in this release, one of its deliberate
    // exceptions to "the controller decides" (with setPPToServiceRoutine on
    // RobotWare 8 in Auto and an RMMP level above the one held).
    rws1: {
      method: 'POST', path: '/ctrl/virtualtime/vtspeed', fields: ['vtspeed'],
      gap: 'not sent in this release, a deliberate hold of this client: ABB documents POST /ctrl/virtualtime/vtspeed on RWS 1.0 (virtual controllers only), but the client sends no virtual-time write on RobotWare 6; change the simulation speed in RobotStudio',
    },
    note: 'value a percent, -1 = full speed. 2.0 body vtspeed (Rev L; the 2.0 form says vtcurrspeed, which RW 7.21 and 8.2 refuse). RWS 1.0: not sent in this release (a client hold; ABB documents the write).',
  },
  getVirtualTimeClock: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the current virtual time.',
    // Atomic sub-resource of the getVirtualTime composite (vttime + vtstate +
    // vtspeed). Added 2026-08-10 after the conformance check flagged
    // /ctrl/virtualtime/vttime as unmapped - the composite was skipped, but its
    // atomic reads deserve table entries.
    rws2: { method: 'GET', path: '/ctrl/virtualtime/vttime' },
    rws1: { method: 'GET', path: '/ctrl/virtualtime/vttime' },
    note: 'atomic read; getVirtualTime composes this with vtstate + vtspeed.',
  },
  getVirtualTimeState: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the virtual-time running state.',
    rws2: { method: 'GET', path: '/ctrl/virtualtime/vtstate' },
    rws1: { method: 'GET', path: '/ctrl/virtualtime/vtstate' },
    note: 'read only: the client has no vtstate write; pause and resume from RobotStudio\'s Simulation tab.',
  },
  getVirtualTimeScale: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the virtual-time speed.',
    rws2: { method: 'GET', path: '/ctrl/virtualtime/vtspeed' },
    rws1: { method: 'GET', path: '/ctrl/virtualtime/vtspeed' },
  },
  getVirtualTimeTimeslice: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the virtual-time timeslice.',
    rws2: { method: 'GET', path: '/ctrl/virtualtime/vttimeslice' },
    // The IRC5 also advertises this (conformance check, 2026-08-10), but the
    // client only wraps it on RWS 2.0 - recorded as a gap so the divergence is
    // documented rather than showing as unmapped drift.
    rws1: { method: 'GET', path: '/ctrl/virtualtime/vttimeslice' },
    note: 'wrapped on RWS 2.0; RW6 advertises it too but the client does not use it there.',
  },
  setVirtualTimeTimeslice: {
    tier: 'niche', evidence: 'live',
    summary: 'Set the virtual-time timeslice.',
    rws2: { method: 'POST', path: '/ctrl/virtualtime/vttimeslice', fields: ['vttimeslice'] },
    note: 'RWS 2.0 only.',
  },

  // ── Certificates (RWS 2.0 only) ───────────────────────────────────────────
  listCertificateStores: {
    tier: 'niche', evidence: 'live',
    summary: 'List certificate stores.',
    rws2: { method: 'GET', path: '/ctrl/certstore' },
    note: 'RWS 2.0 only; same URL as listCertificates, different parse.',
  },
  getCertificates: {
    tier: 'niche', evidence: 'live',
    summary: 'Read certificates in a store.',
    // {storePath} is multi-segment (e.g. system/rws_store) and slashes are kept.
    rws2: { method: 'GET', path: '/ctrl/certstore/{storePath}' },
    note: 'RWS 2.0 only; {storePath} keeps its slashes (not encoded).',
  },
  uploadCertificate: {
    tier: 'niche', evidence: 'built',
    summary: 'Add a certificate to a store from a PEM file on the controller.',
    // Rev L "Add Certificate" and the controller form (ctrl-certstore-add on RW
    // 7.21.4 and 8.2.1, 2026-10-07): POST /ctrl/certstore/{scope}/{store} with
    // the one form field `filepath`, a /fileservice/ path of a PEM file already
    // on the controller. The client used to POST the PEM itself as
    // application/x-pem-file to /ctrl/certstore/{name}, which no document or
    // form describes. {storePath} keeps its slashes, like getCertificates.
    rws2: { method: 'POST', path: '/ctrl/certstore/{storePath}', fields: ['filepath'] },
    note: 'RWS 2.0 only; built-not-run. Form field filepath (a /fileservice/ URI); the client uploads the PEM to $TEMP first and deletes it after. Rev L answers 204.',
  },
  clearCertificateStore: {
    tier: 'niche', evidence: 'built',
    summary: 'Remove every certificate from one store.',
    // The only removal ABB documents and the controller serves (Rev L "Remove
    // Certificate", the form on both builds): POST .../{scope}/{store}/clear
    // with an empty form. There is no resource for one certificate.
    rws2: { method: 'POST', path: '/ctrl/certstore/{scope}/{store}/clear' },
    note: 'RWS 2.0 only; built-not-run; empties the whole store.',
  },
  removeCertificate: {
    tier: 'niche', evidence: 'built',
    summary: 'Delete one certificate (no such RWS operation).',
    // No Allow header under /ctrl/certstore lists DELETE on RW 7.21.4 or 8.2.1,
    // and Rev L has no per-certificate resource (spec check 2026-10-07). The
    // client throws UNSUPPORTED_OPERATION without sending; clearCertificateStore
    // is the documented operation.
    rws2: { method: 'DELETE', path: '/ctrl/certstore/{name}', gap: 'in no ABB document and not served; nothing is sent (UNSUPPORTED_OPERATION)' },
    note: 'RWS 2.0 only; not an RWS operation. Use clearCertificateStore.',
  },

  // ── Registry / compress ───────────────────────────────────────────────────
  getRegistry: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the controller registry index.',
    rws2: { method: 'GET', path: '/ctrl/registry' },
    note: 'RWS 2.0 only.',
  },
  getRegistryFile: {
    tier: 'niche', evidence: 'live',
    summary: 'Read a registry file.',
    rws2: { method: 'GET', path: '/ctrl/registry/{name}' },
    note: 'RWS 2.0 only.',
  },
  compressPath: {
    tier: 'niche', evidence: 'live',
    summary: 'Compress a controller path.',
    // Spec field names (source/destination) are WRONG - controller wants srcpath/dstpath.
    rws2: { method: 'POST', path: '/ctrl/compress', fields: ['srcpath', 'dstpath'] },
    // RWS 1.0 uses a QUERY-action (?action=comp), unlike the RWS 2.0 path form,
    // and requires `/fileservice/`-prefixed paths (ABB RWS 1.0 reference). A
    // logged RWS 1.0 run on RW 6.16.03 answered 202 ACCEPTED. ($HOME/$system
    // were reported protected -> "Compression Forbidden".)
    rws1: { method: 'POST', path: '/ctrl/compress', action: 'comp', fields: ['srcpath', 'dstpath'] },
    note: 'RWS 2.0 path-action POST /ctrl/compress; RWS 1.0 query-action POST /ctrl/compress?action=comp with /fileservice/ paths; 202 on RW 6.16.03. The 202 carries Location /progress/{id}: startJob(\'compressPath\', ...) returns the id for getProgress, and compressPath itself returns nothing, as in 1.4.0.',
  },
  decompressPath: {
    tier: 'niche', evidence: 'built',
    summary: 'Decompress a controller path.',
    rws2: { method: 'POST', path: '/ctrl/decompress', fields: ['srcpath', 'dstpath'] },
    // RWS 1.0 has NO separate /ctrl/decompress - it is the same /ctrl/compress
    // endpoint with ?action=dcomp (ABB RWS 1.0 reference; /fileservice/ paths).
    rws1: { method: 'POST', path: '/ctrl/compress', action: 'dcomp', fields: ['srcpath', 'dstpath'] },
    note: 'RWS 2.0 has a distinct /ctrl/decompress; RWS 1.0 reuses /ctrl/compress?action=dcomp. No logged success on either generation (RWS 1.0 answered 404). startJob(\'decompressPath\', ...) returns the progress id from the Location header, as for compressPath.',
  },

  // ── Options (the controller advertises /ctrl/options, but…) ───────────────
  ctrlOptionsVerify: {
    tier: 'niche', evidence: 'built',
    summary: 'The bare /ctrl/options resource, which carries no option list (see listControllerOptions).',
    // The controller advertises /ctrl/options, but the bare resource carries no
    // option list (200 with an empty state on RW7/8, 204 on RW6). The real
    // option list the client reads is /rw/system/options
    // (systemMastership.listControllerOptions). ABB documents a per-option
    // check, GET /ctrl/options/{option} (204 or 200 when present, 404 when
    // absent, case-sensitive), on both generations; the client does not wrap it.
    // Recorded here so the conformance check sees /ctrl/options as a deliberate
    // gap rather than unmapped drift. Flagged by the check 2026-08-10.
    rws2: { method: 'GET', path: '/ctrl/options', gap: 'the bare GET carries no option list; the list is /rw/system/options (listControllerOptions). ABB documents a per-option check, GET /ctrl/options/{option}; it is not wrapped' },
    rws1: { method: 'GET', path: '/ctrl/options', gap: 'the bare GET carries no option list (204); the list is /rw/system/options (listControllerOptions). ABB documents a per-option check, GET /ctrl/options/{option}; it is not wrapped' },
    note: 'not used on either generation: the client reads the option list from /rw/system/options. The per-option check is not wrapped; no controller has answered it with a present option in the logs of this client.',
  },

  // ── Features ──────────────────────────────────────────────────────────────
  listFeatures: {
    tier: 'niche', evidence: 'live',
    summary: 'List controller features.',
    rws2: { method: 'GET', path: '/ctrl/features' },
    note: 'RWS 2.0 only; verify-style, bare listing is always empty.',
  },
  verifyControllerFeature: {
    tier: 'niche', evidence: 'live',
    summary: 'Check whether one controller feature is present.',
    // ABB Controller_Service.yaml Rev L "Verify Option Resource": 204 when the
    // feature is present for the robot number (query robno, default 1), 404
    // when it is not. The feature id is case sensitive.
    rws2: { method: 'GET', path: '/ctrl/features/{feature}' },
    note: 'RWS 2.0 only. 204 present / 404 absent; optional ?robno= query.',
  },
};
