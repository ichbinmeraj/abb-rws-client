/**
 * Refusals in plain words: what a controller refusal means, which condition
 * is missing, who can supply it, and what they do.
 *
 * `refusalFor` turns one controller answer (HTTP status, the controller's
 * code and message, the request) into a `RwsRefusal`; `explainRefusal`
 * refines one with what the caller knows (operating mode, controller state,
 * RMMP, the holder, the controller's name and the user).
 *
 * Sources for the codes: ABB's RWS 1.0 and RWS 2.0 return-code lists and the
 * RobotWare 8 control-station codes of ABB's RWS pages and the controllers'
 * own `/rw/retcode` dictionary. Payloads captured live are in
 * tests/fixtures/errors. Where the cause of a code is only inferred, the
 * refusal says so through `evidence` and its sentence claims no more.
 *
 * Rules every sentence follows:
 * - RMMP (manual-mode remote access) is advised only in manual mode on
 *   RobotWare 6 and 7, never in Auto, on RobotWare 8, for a signal write or
 *   for a missing option.
 * - Relaxing an access level or a grant is never offered as the default fix:
 *   the owner is named and decides.
 * - A service the controller reports as not supported is not called broken.
 * - The controller's code is always kept: decimal, hex, and ABB's name when
 *   known.
 *
 * Every refusal carries a next step, `remedy` (and `otherRemedies`). Rules for
 * remedies:
 * - The client builds remedies. It never runs one: no client method takes a
 *   remedy and acts on it.
 * - `byWhom: 'person-confirms-in-a-tool'` if and only if `call` is set.
 * - `safetyDeclaration: true` if and only if the kind is
 *   `declare-motion-control`.
 * - `declare-motion-control` only on RobotWare 8, only for
 *   `motion-control-off`, only with `setAllowMotionControl` and `allow: true`.
 *   It is the primary remedy only when the controller itself answered
 *   -1073435864; a refusal built from a reading gets it as an other remedy.
 * - A refusal whose remedies include a `call` also has at least one remedy
 *   without one: a consumer that cannot act shows that one as the step.
 * - `request-rmmp` only on RobotWare 6 and 7, only in manual mode, only for an
 *   operation RMMP covers: `modify` for writes that need mastership, `exec`
 *   for a RobotWare 7 program-pointer move to a routine (ABB: RMMP_Exe). Never
 *   for a start, PP to Main, another pointer move, a signal write, a jog, a
 *   motors write or a missing option. The RMMP sentences follow the same rule.
 * - Relaxing a grant or an access level is never the remedy:
 *   `grant-missing` and `signal-access-level` name the owner, who decides.
 * - `label` and `detail` hold the client's own words only; a holder's name
 *   stays in `refusal.holder`.
 * - Every remedy string is one line, under 1000 characters, and no remedy key
 *   is one a consumer drops as transport or secret data (`request`,
 *   `headers`, anything naming a PIN, token, cookie or station id).
 */

import {
  RwsError,
  type RwsErrorCode, type RwsRefusal, type RefusalKind, type RefusalCondition,
  type RefusalGrantor, type RefusalGrant, type RefusalHolder, type RefusalContext,
  type RefusalController, type RefusalRemedy, type RemedyActor, type RemedyCall, type RemedyKind,
  type RemedyConfirmation,
} from './types.js';

type Gen = 'rw6' | 'rw7' | 'rw8';
type Evidence = RwsRefusal['evidence'];

// ─── Controller codes ────────────────────────────────────────────────────────

/**
 * Access-related controller codes this client explains, with ABB's name and
 * the `RwsErrorCode` each one carries.
 *
 * Names come from ABB's return-code lists (RWS 1.0, RWS 2.0) and, for the
 * RobotWare 8 control-station codes, from the controller's own dictionary on
 * RW 8.1.1 and 8.2.1. ABB's RWS pages name three of them differently: they
 * give -1073445859 and -1073435873 the same name
 * (SYS_CTRL_E_REJECT_CONTROL_STATION_DOES_NOT_HAVE_WRITE_ACCESS), call
 * -1073435867 SYS_CTRL_E_REJECT_NOT_A_REMOTE_CONTROL_STATION, and call
 * -1073435856 SYS_CTRL_E_REJECT_NOT_A_LOCAL_CONTROL_STATION, the name the
 * controller gives -1073435869.
 */
export const REFUSAL_CODES: ReadonlyMap<number, { name: string; code: RwsErrorCode; rw8?: true }> = new Map([
  // Mastership (RobotWare 6/7)
  [-1073445862, { name: 'SYS_CTRL_E_RESOURCE_HELD', code: 'MASTERSHIP_REQUIRED' }],
  [-1073445859, { name: 'SYS_CTRL_E_MASTER_REJECT', code: 'MASTERSHIP_REQUIRED' }],
  [-1073445880, { name: 'SYS_CTRL_E_RESOURCE_NOT_HELD', code: 'MASTERSHIP_REQUIRED' }],
  [-1073445872, { name: 'SYS_CTRL_E_RESOURCE_ALREADY_HELD', code: 'UNKNOWN' }],
  [-1073445844, { name: 'SYS_CTRL_E_RESOURCE_MOTION_HELD_REJECT', code: 'MASTERSHIP_REQUIRED' }],
  [-1073445845, { name: 'SYS_CTRL_E_EXTERNAL_CLIENT_REJECT', code: 'MASTERSHIP_REQUIRED' }],
  // Modes and state
  [-1073445860, { name: 'SYS_CTRL_E_MODE_REJECT', code: 'WRONG_MODE' }],
  [-1073435895, { name: 'SYS_CTRL_E_NOT_MANUAL_MODE', code: 'WRONG_MODE' }],
  [-1073442809, { name: 'SYS_CTRL_E_EXEC_STATE', code: 'WRONG_MODE' }],
  [-1073445806, { name: 'SYS_CTRL_E_PERMISSION_CONTROLLER_STATE_REJECT', code: 'WRONG_MODE' }],
  // ABB's RWS 2.0 return-code list names it "Operation is not locked"; the
  // controller's text on an unlock of the operating-mode selector is
  // "OP-mode is not locked".
  [-1073435886, { name: 'SYS_CTRL_E_OPERATION_IS_UNLOCKED', code: 'WRONG_MODE' }],
  // The loaded RAPID program. A RAPID value write refused -1073442802 is
  // INVALID_ARGUMENT instead (see draftFor).
  [-1073442803, { name: 'SYS_CTRL_E_RAPID_SYNTAX_ERROR', code: 'WRONG_MODE' }],
  [-1073442802, { name: 'SYS_CTRL_E_RAPID_SEMANTIC_ERROR', code: 'WRONG_MODE' }],
  [-1073442812, { name: 'SYS_CTRL_E_NO_PROGRAMNAME', code: 'WRONG_MODE' }],
  // Users, grants, safety access restriction
  [-1073445867, { name: 'SYS_CTRL_E_UAS_REJECT', code: 'GRANT_DENIED' }],
  [-1073445881, { name: 'SYS_CTRL_E_REJECT', code: 'GRANT_DENIED' }],
  [-1073445827, { name: 'SYS_CTRL_E_INVALID_GRANT', code: 'INVALID_ARGUMENT' }],
  [-1073445813, { name: 'SYS_CTRL_E_IMPERSONATE', code: 'GRANT_DENIED' }],
  [-1073445873, { name: 'SYS_CTRL_E_NOT_LOGGED_ON', code: 'SESSION_EXPIRED' }],
  // RMMP (RobotWare 6/7)
  [-1073445863, { name: 'SYS_CTRL_E_DENIED', code: 'GRANT_DENIED' }],
  [-1073445870, { name: 'SYS_CTRL_E_NO_SUCH_REQUEST', code: 'GRANT_DENIED' }],
  [-1073445869, { name: 'SYS_CTRL_E_TIMEOUT', code: 'UNKNOWN' }],
  [-1073445800, { name: 'SYS_CTRL_E_RMMP_E_REJECT', code: 'WRONG_MODE' }],
  // Local presence
  [-1073445868, { name: 'SYS_CTRL_E_NO_LOCAL_USER', code: 'UNSUPPORTED_OPERATION' }],
  [-1073445875, { name: 'SYS_CTRL_E_LOCAL_NOT_ALLOWED', code: 'UNSUPPORTED_OPERATION' }],
  [-1073445810, { name: 'SYS_CTRL_E_REJECT_TOO_MANY_LOCAL_CLIENTS', code: 'UNSUPPORTED_OPERATION' }],
  // Names from the controller's own /rw/retcode dictionary (RW 8.2.1).
  [-1073435869, { name: 'SYS_CTRL_E_REJECT_NOT_A_LOCAL_CONTROL_STATION', code: 'UNSUPPORTED_OPERATION', rw8: true }],
  [-1073435856, { name: 'SYS_CTRL_E_REJECT_WRONG_LOCAL_PRESENCE_CERTIFICATE_KEY', code: 'UNSUPPORTED_OPERATION', rw8: true }],
  // Control stations and write access (RobotWare 8)
  [-1073435870, { name: 'SYS_CTRL_E_REJECT_WRITE_ACCESS_ALREADY_TAKEN', code: 'MASTERSHIP_REQUIRED', rw8: true }],
  [-1073435873, { name: 'SYS_CTRL_E_REJECT_CONTROL_STATION_DOES_NOT_HAVE_WRITE_ACCESS', code: 'MASTERSHIP_REQUIRED', rw8: true }],
  [-1073435871, { name: 'SYS_CTRL_E_REJECT_NOT_A_CONTROL_STATION', code: 'MASTERSHIP_REQUIRED', rw8: true }],
  [-1073435872, { name: 'SYS_CTRL_E_REJECT_EXTERNAL_CONTROL_ENABLE_NOT_SET', code: 'MASTERSHIP_REQUIRED', rw8: true }],
  [-1073435874, { name: 'SYS_CTRL_E_REJECT_CONTROL_STATION_ALREADY_REGISTERED', code: 'UNKNOWN', rw8: true }],
  [-1073435867, { name: 'SYS_CTRL_E_INVALID_CONTROL_STATION_ID', code: 'INVALID_ARGUMENT', rw8: true }],
  // Name from the controller's own /rw/retcode dictionary (RW 8.2.1).
  [-1073435864, { name: 'SYS_CTRL_E_NOT_ALLOWED_TO_MOVE_ROBOT', code: 'GRANT_DENIED', rw8: true }],
  // Arguments and services
  [-1073445879, { name: 'SYS_CTRL_E_INVALIDARG', code: 'INVALID_ARGUMENT' }],
  // Name from the controllers' own /rw/retcode dictionary (RW 7.21.4, 8.2.1).
  [-1073436654, { name: 'SYS_CTRL_E_POSE_OUTSIDE_REACH', code: 'INVALID_ARGUMENT' }],
  [-1073445885, { name: 'SYS_CTRL_E_SERVICE_NOT_SUPPORTED', code: 'UNSUPPORTED_OPERATION' }],
]);

/**
 * Configuration codes this client explains. They refuse what was sent (a
 * configuration file, an instance name), not access, so they are kept apart
 * from REFUSAL_CODES. Names and descriptions are ABB's (RWS 1.0 Rev M return
 * codes; the RWS 2.0 Retcode service): -1073437689 "Name already exists in
 * database (for named instances)", -1073437688 "Cfg file contains errors.",
 * -1073437686 "Invalid cfg domain version or invalid layout of version
 * string.".
 *
 * Seen on configuration loads with `add` of a domain the same controller had
 * just saved (virtual controllers, 2026-10-12): RobotWare 7.21.4 and 8.2.1
 * answered 400 -1073437689 for an MMC and an EIO file; RobotWare 6.16.03
 * answered -1073437689 for the MMC file and -1073437688 for the EIO file,
 * with `org_code: 3500 new_code: 0xc0048410` in the message (0xC0048410 is
 * -1073445872, SYS_CTRL_E_RESOURCE_ALREADY_HELD, which is not the cause).
 * They were `UNKNOWN` before. Only the code and message were logged, so
 * which outer code RobotWare 6.16.03 sent is not known: the configuration
 * code itself (no refusal before), or the generic -1073414146, under which
 * 1.4.0 read the hex `new_code` and explained a held resource (innerCodeOf
 * now reads the `code:` annotation first).
 *
 * -1073437686 (SYS_CTRL_E_CFG_VERSION) answered a validation of a file whose
 * first line is not a version header (`ZZ_PROBE this is not a configuration
 * file`) with 400 on the RobotWare 7.21.4 and 8.2.1 virtual controllers
 * (2026-10-01) and on those and the 6.16.03 one (2026-10-24), loading nothing:
 * "Wrong layout of version string code:-1073437686 icode:-26" on RWS 2.0,
 * "org_code: -26 new_code: 0xc004a40a" on RWS 1.0 (0xC004A40A is the code
 * itself). In the same runs a file starting `EIO:CFG_1.0:6:1::` (RobotWare
 * 6.16.03) or `EIO:CFG_1.0:7:0::` (7.21.4, 8.2.1) passed. It was `UNKNOWN`
 * before.
 */
export const CFG_REFUSAL_CODES: ReadonlyMap<number, { name: string; code: RwsErrorCode }> = new Map([
  [-1073437689, { name: 'SYS_CTRL_E_CFG_NAME_EXIST', code: 'INVALID_ARGUMENT' }],
  [-1073437688, { name: 'SYS_CTRL_E_CFG_DATA_INCORRECT', code: 'INVALID_ARGUMENT' }],
  [-1073437686, { name: 'SYS_CTRL_E_CFG_VERSION', code: 'INVALID_ARGUMENT' }],
]);

/** ABB's name and the `RwsErrorCode` of a code this client explains: an access code or a configuration code. */
function explainedCode(code: number): { name: string; code: RwsErrorCode; rw8?: true } | undefined {
  return REFUSAL_CODES.get(code) ?? CFG_REFUSAL_CODES.get(code);
}

/**
 * -1073414146 SYS_CTRL_E_FAIL "Unspecified error": RobotWare 6's generic outer
 * code. The real cause, when there is one, is an inner `code:` in the message.
 */
export const SYS_CTRL_E_FAIL = -1073414146;

/**
 * -1073414145 (0xC004FFFF), "Unknown Error", icode -4502: RobotWare 8's
 * answer to a request for control-station write access while a change of
 * operating mode waited for the confirmation at the FlexPendant.
 * Live-verified 2026-09-30 on RW 8.2.1+1023: after a switch from MANR to Auto
 * over RWS the controller read AUTO_CH, and every write-access request of the
 * station answered 403 with this code until someone confirmed the switch at
 * the FlexPendant. ABB's name for the code is not known and the code is
 * generic, so only a write-access request made while the mode reads a
 * pending change (`..._CH`) is explained; anywhere else it stays unexplained.
 */
const WRITE_ACCESS_REFUSED_IN_MODE_CHANGE = -1073414145;

/** An operating mode that reads a change waiting for its confirmation: AUTO_CH, MANF_CH, ... */
function isPendingModeChange(mode: string | null): mode is string {
  return mode !== null && /_CH$/.test(mode);
}

/** `0xC004841A` for -1073445862: the form ABB's documents and forums use. */
export function hexCode(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** The inner code (`icode:-2`) of a controller message, when present. */
function icodeOf(msg: string | null): number | undefined {
  const m = msg?.match(/icode:\s*(-?\d+)/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * The first known code (an access code, or a configuration code of
 * CFG_REFUSAL_CODES) in a message's own `code:` annotations (not `icode:`),
 * other than the generic outer code: what a SYS_CTRL_E_FAIL answer really
 * refused on. A `code:` annotation is read before the hex `new_code`, which
 * RobotWare 6 can set to 0xC0048410 (resource already held) for an unrelated
 * cause: `org_code: 3500 new_code: 0xc0048410; code:-1073437689`.
 */
export function innerCodeOf(msg: string | null): number | null {
  if (!msg) { return null; }
  for (const m of msg.matchAll(/(?:^|[^a-z_])code:\s*(-?\d+)/gi)) {
    const c = Number(m[1]);
    if (c !== SYS_CTRL_E_FAIL && explainedCode(c)) { return c; }
  }
  // RobotWare 6 can put the real reason only in the inner code: PP to main in
  // MANR answered HTTP 400 "org_code: -4502 new_code: 0xc004841c;
  // code:-1073414146 icode:-1073445860" (RW 6.16.03, 2026-10-13), which is
  // SYS_CTRL_E_MODE_REJECT. The icode, or the hex new_code, is read when it is
  // a known refusal code.
  const ic = icodeOf(msg);
  if (ic !== undefined && ic !== SYS_CTRL_E_FAIL && explainedCode(ic)) { return ic; }
  const hex = /new_code:\s*0x([0-9a-f]{8})/i.exec(msg);
  if (hex) {
    const c = parseInt(hex[1], 16) | 0;
    if (c !== SYS_CTRL_E_FAIL && explainedCode(c)) { return c; }
  }
  return null;
}

// ─── What was asked: the operation behind a request ─────────────────────────

interface Grants {
  grants: RefusalGrant[];
  /** Every grant is needed (true), or the documents name alternatives (false). */
  needsAll: boolean;
  /** A sentence that goes with the grants (a documented conflict, say). */
  note?: string;
}

type OpKind =
  | 'start' | 'stop' | 'io-write' | 'motors-on' | 'motors-off' | 'motors' | 'rmmp-request' | 'rmmp'
  | 'mastership' | 'mastership-request' | 'writeaccess-request' | 'writeaccess' | 'register' | 'uas'
  | 'jog' | 'other';

interface Op {
  kind: OpKind;
  /** Verb phrase: "change the speed ratio". */
  label: string;
  grants?(gen: Gen | null, mode: string | null): Grants | null;
  /** For io-write: the signal name. */
  signal?: string;
  /** For mastership requests: the domain named in the path. */
  domain?: string;
}

const G = {
  execute:      { id: 'UAS_RAPID_EXECUTE', label: 'Execute program', labelEvidence: 'abb' },
  startStop:    { id: 'UAS_REMOTE_START_STOP_IN_AUTO', label: 'Remote Start and Stop in Auto', labelEvidence: 'abb' },
  speed:        { id: 'UAS_SPEED_DECREASE', label: 'Decrease production speed', labelEvidence: 'abb' },
  loadProgram:  { id: 'UAS_RAPID_LOADPROGRAM', label: 'Load program', labelEvidence: 'abb' },
  edit:         { id: 'UAS_RAPID_EDIT', label: 'Edit RAPID code', labelEvidence: 'name-match' },
  currValue:    { id: 'UAS_RAPID_CURRVALUE', label: 'Modify current value', labelEvidence: 'name-match' },
  ioWrite:      { id: 'UAS_IO_WRITE', label: 'I/O write access', labelEvidence: 'name-match' },
  warmstart:    { id: 'UAS_REMOTE_WARMSTART', label: 'Remote restart', labelEvidence: 'name-match' },
  backup:       { id: 'UAS_BACKUP', label: 'Backup and save', labelEvidence: 'abb' },
  restore:      { id: 'UAS_RESTORE', label: 'Restore a backup', labelEvidence: 'abb' },
  elogClear:    { id: 'UAS_EVENTLOG_CLEAR', label: 'Delete log', labelEvidence: 'name-match' },
  properties:   { id: 'UAS_CONTROLLER_PROPERTIES_WRITE', label: 'Modify controller properties', labelEvidence: 'abb' },
  debug:        { id: 'UAS_RAPID_DEBUG', label: 'Program debug', labelEvidence: 'abb' },
} as const satisfies Record<string, RefusalGrant>;

const one = (g: RefusalGrant): Grants => ({ grants: [g], needsAll: true });
const omnicore = (gen: Gen | null): boolean => gen === 'rw7' || gen === 'rw8';
const isManual = (mode: string | null): boolean => mode === 'MANR' || mode === 'MANF';

/**
 * The RobotStudio name of a grant whose name differs between IRC5 and
 * OmniCore; both names while the generation is not known.
 */
function byGen(gen: Gen | null, id: string, irc5: string, omni: string): RefusalGrant {
  const label = gen === null ? `${irc5} (IRC5) / ${omni} (OmniCore)` : omnicore(gen) ? omni : irc5;
  return { id, label, labelEvidence: 'name-match' };
}

/** A grant whose identifier differs between RobotWare 6 and 7/8: both while the generation is not known. */
function byGenId(gen: Gen | null, rw6: RefusalGrant, omni: RefusalGrant): Grants {
  if (gen === null) { return { grants: [rw6, omni], needsAll: false }; }
  return one(omnicore(gen) ? omni : rw6);
}

/**
 * Start (and start from the production entry). ABB: 'Execute program'
 * (UAS_RAPID_EXECUTE) is checked before a start, and on OmniCore a remote
 * user in Auto also needs 'Remote Start and Stop in Auto' (RobotStudio
 * release notes 2025.2, operating manual). RobotWare 6's RWS grant list has
 * no identifier for the IRC5 'Remote Start Stop in Auto', so it is named in
 * the note only.
 */
function startGrants(gen: Gen | null, mode: string | null): Grants {
  if (isManual(mode)) { return one(G.execute); }
  if (omnicore(gen)) {
    return {
      grants: [G.execute, G.startStop], needsAll: true,
      ...(mode === null ? { note: '\'Remote Start and Stop in Auto\' applies in Auto.' } : {}),
    };
  }
  return {
    ...one(G.execute),
    note: gen === 'rw6'
      ? 'In Auto, ABB\'s RobotStudio operating manual also names \'Remote Start Stop in Auto\' for a start from a remote client on IRC5; '
        + 'RobotWare 6 lists no RWS identifier for it.'
      : 'In Auto, ABB\'s RobotStudio operating manual also names a remote start and stop grant (\'Remote Start and Stop in Auto\' on OmniCore, '
        + '\'Remote Start Stop in Auto\' on IRC5).',
  };
}

/**
 * Stop. ABB's documents disagree: the RobotStudio operating manual requires
 * 'Remote Start and Stop in Auto' to start or stop from a remote client in
 * Auto, while its 'Execute program' grant says "stop is always allowed". The
 * sentence names both and claims neither. In manual mode no grant is named.
 */
function stopGrants(gen: Gen | null, mode: string | null): Grants | null {
  if (isManual(mode)) { return null; }
  const autoGrant = omnicore(gen) ? '\'Remote Start and Stop in Auto\''
    : gen === 'rw6' ? '\'Remote Start Stop in Auto\''
      : 'a remote start and stop grant (\'Remote Start and Stop in Auto\' on OmniCore, \'Remote Start Stop in Auto\' on IRC5)';
  const note = `ABB's documents disagree on whether a remote stop needs a grant: the RobotStudio operating manual requires ${autoGrant} `
    + 'to start or stop from a remote client in Auto, while \'Execute program\' says stop is always allowed.';
  return omnicore(gen)
    ? { grants: [G.startStop, G.execute], needsAll: false, note }
    : { grants: [G.execute], needsAll: false, note };
}

/** The signal name in a signal-write path (RWS 1.0 or 2.0). */
function signalOf(path: string): string {
  const rest = path.split('?')[0].replace(/^.*\/rw\/iosystem\/signals\//i, '').replace(/\/set-value$/i, '');
  const parts = rest.split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? rest);
}

/** The labels of the program-pointer operations, which the RMMP rule tells apart. */
const PP_TO_MAIN = 'set the program pointer to Main';
const PP_MOVE = 'move the program pointer';

/**
 * Recognise the operation of a request from its method and path (and, for a
 * motors write, whether it asks for motors on). Unrecognised requests are
 * explained without an operation name.
 */
export function operationOf(method: string, path: string, motors: 'on' | 'off' | null = null): Op | null {
  const m = method.toUpperCase();
  const p = path.toLowerCase();
  const write = m !== 'GET';
  const has = (re: RegExp): boolean => re.test(p);

  if (has(/^\/users\/rmmp/)) {
    if (m === 'POST' && !has(/cancel|grant|poll/)) {
      return { kind: 'rmmp-request', label: 'grant remote access in manual mode (RMMP)', grants: gen => (gen === 'rw7' ? one(G.debug) : null) };
    }
    return { kind: 'rmmp', label: has(/cancel/) ? 'cancel RMMP' : 'read RMMP' };
  }
  if (has(/^\/uas\//)) { return { kind: 'uas', label: `use ${path.split('?')[0]}` }; }
  if (has(/^\/rw\/controlstation\/register/)) { return { kind: 'register', label: 'register as a control station' }; }
  if (has(/^\/rw\/controlstation\/writeaccess\/request/)) { return { kind: 'writeaccess-request', label: 'take control-station write access' }; }
  if (has(/^\/rw\/controlstation\/writeaccess/)) { return { kind: 'writeaccess', label: 'use control-station write access' }; }
  if (has(/^\/rw\/controlstation\/allowmotioncontrol/)) { return { kind: 'other', label: 'declare motion control for this station' }; }
  if (has(/^\/rw\/controlstation\/disableexternalcontrol/)) { return { kind: 'other', label: 'turn off external control' }; }
  if (has(/^\/rw\/mastership/)) {
    const domain = p.match(/^\/rw\/mastership\/(cfg|motion|rapid|edit)(?:[/?]|$)/)?.[1];
    if (write && has(/(\/request(-with-id)?(\?|$)|action=request)/)) {
      return { kind: 'mastership-request', label: domain ? `take ${domain} mastership` : 'take mastership', ...(domain ? { domain } : {}) };
    }
    return { kind: 'mastership', label: has(/watchdog/) ? 'reset the mastership watchdog' : write ? 'release mastership' : 'read mastership' };
  }
  if (has(/^\/rw\/rapid\/execution/) && write) {
    if (has(/startprodentry/)) { return { kind: 'start', label: 'start the RAPID program from the production entry', grants: startGrants }; }
    if (has(/(\/start(\?|$)|action=start(&|$))/)) { return { kind: 'start', label: 'start the RAPID program', grants: startGrants }; }
    if (has(/(\/stop(\?|$)|action=stop(&|$))/)) { return { kind: 'stop', label: 'stop the RAPID program', grants: stopGrants }; }
    if (has(/resetpp/)) { return { kind: 'other', label: PP_TO_MAIN }; }
    if (has(/cycle/)) { return { kind: 'other', label: 'change the execution cycle' }; }
    if (has(/holdtorun|hold-to-run/)) { return { kind: 'other', label: 'use hold-to-run' }; }
    return { kind: 'other', label: 'change RAPID execution' };
  }
  if (has(/^\/rw\/rapid\/tasks\/[^/?]+\/pcp/) && write) { return { kind: 'other', label: PP_MOVE }; }
  if (has(/^\/rw\/rapid\/tasks/) && write) {
    if (has(/loadprog|program\/load/)) { return { kind: 'other', label: 'load a RAPID program', grants: () => one(G.loadProgram) }; }
    if (has(/unloadmod|program\/unload|unloadprog/)) { return { kind: 'other', label: 'unload RAPID code', grants: () => one(G.loadProgram) }; }
    if (has(/loadmod/)) { return { kind: 'other', label: 'load a RAPID module', grants: () => one(G.loadProgram) }; }
    if (has(/modify-position/)) {
      return { kind: 'other', label: 'modify a position (ModPos)', grants: gen => one(byGen(gen, 'UAS_RAPID_MODPOS', 'Perform ModPos and HotEdit', 'Modify position')) };
    }
    if (has(/\/modules\/[^/?]+\/text/)) { return { kind: 'other', label: 'edit module text', grants: () => one(G.edit) }; }
    if (has(/activate|deactivate/)) { return { kind: 'other', label: 'activate or deactivate a RAPID task' }; }
    return { kind: 'other', label: 'change a RAPID task' };
  }
  if (has(/^\/rw\/rapid\/symbol/) && write) { return { kind: 'other', label: 'change a RAPID variable', grants: () => one(G.currValue) }; }
  if (has(/^\/rw\/panel\/speedratio/) && write) { return { kind: 'other', label: 'change the speed ratio', grants: () => one(G.speed) }; }
  if (has(/^\/rw\/panel\/ctrl-?state/) && write) {
    if (has(/keyless-motoron/) || motors === 'on') { return { kind: 'motors-on', label: 'switch the motors on' }; }
    if (motors === 'off') { return { kind: 'motors-off', label: 'switch the motors off' }; }
    return { kind: 'motors', label: 'change the motors state' };
  }
  // The mode-selector lock and unlock: RWS 2.0 sub-paths, RWS 1.0 ?action=.
  if (has(/^\/rw\/panel\/opmode(\/(lock|unlock)\b|\?action=(lock|unlock)\b)/) && write) {
    return { kind: 'other', label: 'lock or unlock the operating-mode selector' };
  }
  if (has(/^\/rw\/panel\/opmode/) && write) { return { kind: 'other', label: 'change the operating mode' }; }
  if ((has(/^\/ctrl\/restart/) || has(/^\/rw\/panel(\/restart)?(\?.*)?action=restart/)) && write) {
    return { kind: 'other', label: 'restart the controller', grants: () => one(G.warmstart) };
  }
  if (has(/^\/rw\/iosystem\/signals\//) && write) {
    const signal = signalOf(path);
    return { kind: 'io-write', label: `write signal '${signal}'`, signal, grants: () => one(G.ioWrite) };
  }
  // RWS 1.0 keyless motors-on sits under /rw/cfg but switches the motors on.
  if (has(/^\/rw\/cfg\?(?:.*&)?action=keyless(?:&|$)/) && write) { return { kind: 'motors-on', label: 'switch the motors on' }; }
  if (has(/^\/rw\/cfg/) && write) {
    return { kind: 'other', label: 'change system parameters', grants: gen => one(byGen(gen, 'UAS_CFG_WRITE', 'Modify configuration', 'Modify system parameters')) };
  }
  if (has(/^\/ctrl\/backup/) && write) {
    return has(/restore/)
      ? { kind: 'other', label: 'restore a backup', grants: () => one(G.restore) }
      : { kind: 'other', label: 'create a backup', grants: () => one(G.backup) };
  }
  if (has(/^\/fileservice/)) {
    return write
      ? { kind: 'other', label: 'write to the controller\'s disk', grants: gen => byGenId(gen,
        { id: 'UAS_FTP_WRITE', label: 'Write access to controller disks', labelEvidence: 'name-match' },
        { id: 'UAS_FILE_ACCESS_READ_WRITE', label: 'Write access to controller disks', labelEvidence: 'name-match' }) }
      : { kind: 'other', label: 'read the controller\'s disk', grants: gen => byGenId(gen,
        { id: 'UAS_FTP_READ', label: 'Read access to controller disks', labelEvidence: 'name-match' },
        { id: 'UAS_FILE_ACCESS_READ', label: 'Read access to controller disks', labelEvidence: 'name-match' }) };
  }
  if (has(/^\/rw\/elog/) && write && has(/clear/)) { return { kind: 'other', label: 'clear the event log', grants: () => one(G.elogClear) }; }
  if ((has(/^\/ctrl\/clock/) || has(/^\/ctrl\/network/)) && write) {
    return { kind: 'other', label: 'change controller properties', grants: () => one(G.properties) };
  }
  if (has(/^\/rw\/motionsystem/) && write && has(/jog/)) { return { kind: 'jog', label: 'jog' }; }
  return null;
}

// ─── Sentences ───────────────────────────────────────────────────────────────

/** "the controller" or "controller 'IRB_1200'". */
function robotOf(ctx: RefusalContext): string {
  return ctx.robot ? `controller '${ctx.robot}'` : 'the controller';
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** "to change the speed ratio", or "this request". */
function whatOf(op: Op | null): string { return op ? `to ${op.label}` : 'this request'; }

/** A grant as a sentence names it: with "probably" when paired by name only. */
function grantText(g: RefusalGrant): string {
  return g.labelEvidence === 'abb' ? `'${g.label}' (${g.id})` : `${g.id} (probably '${g.label}' in RobotStudio)`;
}

function grantTick(g: RefusalGrant): string {
  return g.labelEvidence === 'abb' ? `'${g.label}'` : `the grant for ${g.id} (probably '${g.label}')`;
}

/**
 * Where an administrator adds a grant, as ABB's RobotStudio operating manual
 * describes it: the UAS Administration Tool's Groups tab on IRC5, the Roles
 * tab on OmniCore; on RobotWare 8 an operator first allows Remote Access at
 * the FlexPendant.
 */
export function administratorFix(
  gen: Gen | null, robot: string | null, user: string | null, grants: RefusalGrant[] | null, needsAll = true,
): string {
  const target = robot ? `'${robot}'` : 'this controller';
  const who = user ? `user '${user}'` : 'the user';
  if (!grants || grants.length === 0) {
    return 'An administrator can check the user\'s grants in RobotStudio (Authenticate > View UAS Grants).';
  }
  const ticks = grants.length === 1
    ? grantTick(grants[0])
    : needsAll
      ? `whichever of ${grants.map(grantTick).join(' and ')} is missing`
      : grants.map(grantTick).join(' or ');
  if (gen === 'rw6') {
    return `An administrator with 'Manage UAS settings' opens RobotStudio > Controller tab > Add Controller (${target}) > Request Write Access > Authenticate > `
      + `Edit User Accounts > Groups tab, selects the group of ${who}, ticks ${ticks} under Controller grants, and clicks OK.`;
  }
  if (gen === null) {
    return `An administrator with 'Manage UAS settings' adds it in RobotStudio (Controller tab > Add Controller (${target}) > Request Write Access > `
      + `Authenticate > Edit User Accounts): on IRC5 in the Groups tab, for the group of ${who}; on OmniCore in the Roles tab, for the role of ${who}. `
      + `The grant to tick: ${ticks}.`;
  }
  const prefix = gen === 'rw8' ? 'An operator must first allow Remote Access on the FlexPendant. ' : '';
  return `${prefix}An administrator opens RobotStudio > Controller tab > Add Controller (${target}) > Request Write Access > Authenticate > `
    + 'Login as a Different User (an administrator) > Authenticate > Edit User Accounts > Roles tab, '
    + `selects the role of ${who}, clicks Edit, ticks ${ticks}, and clicks Apply. `
    + 'Where user accounts come from LDAP (RobotWare 7.21 and later), grants come from directory-group roles: ask the directory or controller administrator.';
}

const FIX = {
  keySwitch: 'Change the operating mode with the key switch or mode selector at the controller. A switch to Auto is confirmed at the controller '
    + '(on the FlexPendant, or by another local client).',
  toMANR: 'Switch to manual reduced speed (MANR) with the mode selector at the controller.',
  cellSafety: 'Someone at the cell must clear the cause of the safety stop and reset it.',
  cellSafetyRw8: 'Someone at the cell must clear the cause of the safety stop and reset it (RobotWare 8: the Reset / thumb button on the FlexPendant in Auto, '
    + 'the enabling device in manual, or the configured safe input).',
  integrator: 'The integrator owns the signal\'s access level and the system-input configuration (EIO). Changing an access level can affect '
    + 'personnel safety and needs a safety review.',
  option: 'It needs a RobotWare option that is not installed; that is a purchase or licence decision, not a setting.',
  nobody: 'By ABB\'s design this cannot be done from a remote tool.',
  rmmpGrant: 'The operator at the FlexPendant must press Grant in the remote-access dialog while this tool waits.',
  remoteAccess: 'An operator at the FlexPendant allows Remote Access by pressing and holding the Messages button for more than one second. '
    + 'No remote tool can do this.',
} as const;

/**
 * RobotWare 8's motion-control declaration, in the words every refusal for it
 * uses (a RAPID start or a jog). ABB: a control station needs an emergency
 * stop and a normal stop to start RAPID or to jog, and allowing motion
 * control is the station's confirmation that both are available. The
 * sentence names no method: people read it. The method is in `fix` and in
 * `remedy.call`.
 */
export const MOTION_CONTROL_RULE = 'ABB requires a station that jogs or starts RAPID to have an emergency stop and a normal stop, '
  + "and treats allowing motion control as the station's confirmation that both are available.";
/** Who makes the motion-control declaration, and how (`fix` of a `motion-control-off` refusal). */
export const MOTION_CONTROL_DECLARE = 'A person who has checked both stops allows motion control (setAllowMotionControl(true)). '
  + 'This client never does it on its own.';
/**
 * -1073435864 SYS_CTRL_E_NOT_ALLOWED_TO_MOVE_ROBOT (RobotWare 8): the control
 * station has not declared motion control. A refusal with this code is
 * explained as `motion-control-off` from the code alone, whichever adapter
 * sent the request.
 */
export const MOTION_CONTROL_OFF_CODE = -1073435864;
/** The missing condition of a `motion-control-off` refusal. */
export const MOTION_CONTROL_MISSING = "this control station's declaration that an emergency stop and a normal stop are within reach";

/** The release that ends a caller's motion hold, paired with the call that took it. */
const MOTION_HOLD_RELEASES = 'the release that matches the request '
  + '(releaseMastership(\'motion\') after requestMastership(\'motion\'), releaseMastershipAll() after requestMastershipAll())';

/** The cell-safety fix; the RobotWare 8 Reset sources only where they may apply. */
function cellSafety(gen: Gen | null): string {
  return gen === 'rw8' || gen === null ? FIX.cellSafetyRw8 : FIX.cellSafety;
}

/**
 * True for the station name RobotWare 8 gives its FlexPendant as a holder of
 * write access (`FlexPendant`, compared without case or surrounding blanks).
 */
export function isFlexPendantStation(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === 'flexpendant';
}

/**
 * True for the application name RobotWare 7 gives the FlexPendant's own
 * session as a mastership holder (`TPU`, compared without case or
 * surrounding blanks; RW 7.21.4, 2026-10-18).
 */
export function isPendantApplication(application: string | null | undefined): boolean {
  return typeof application === 'string' && application.trim().toUpperCase() === 'TPU';
}

/**
 * True when `holder` is the FlexPendant in one of the two forms the
 * controllers were seen to name it: RobotWare 7's `local` mastership holder
 * with application `TPU` (RW 7.21.4), RobotWare 8's write-access station
 * `FlexPendant` (RW 8.2.1; both 2026-10-18). No other form counts: a `remote`
 * holder with application `TPU`, or a station named `TPU`, has not been
 * seen. RAPID Live, the daemon and the panel use the same rule.
 */
export function isPendantHolder(holder: RefusalHolder | null | undefined): boolean {
  if (!holder) { return false; }
  return (holder.kind === 'local' && isPendantApplication(holder.application)) || isFlexPendantStation(holder.name);
}

/**
 * `holder` with `isPendant: true` when it is the FlexPendant (isPendantHolder);
 * any other holder, and none, as it is.
 */
export function markPendant<T extends RefusalHolder | null | undefined>(holder: T): T {
  if (!holder || holder.isPendant === true) { return holder; }
  return isPendantHolder(holder) ? { ...holder, isPendant: true } as T : holder;
}

// ─── Remedies: the next step of a refusal ────────────────────────────────────

type Scope = RefusalRemedy['appliesTo']['scope'];

/** What a remedy constructor may be given beyond its defaults. */
interface RemedyOpts {
  /** Replaces the default detail (the client's own words only). */
  detail?: string;
  evidence?: Evidence;
  /** Replaces the default basis. */
  basis?: string;
  /** Replaces the default: whether the person runs the refused operation again afterwards. */
  afterwards?: RefusalRemedy['afterwards'];
}

function remedyOf(
  kind: RemedyKind, byWhom: RemedyActor, label: string, detail: string, scope: Scope, gen: Gen | null,
  afterwards: RefusalRemedy['afterwards'], evidence: Evidence, basis: string, o: RemedyOpts = {}, call?: RemedyCall,
): RefusalRemedy {
  return {
    kind, byWhom, label, detail: o.detail ?? detail,
    appliesTo: { generation: gen, scope },
    ...(call ? { call } : {}),
    ...(kind === 'declare-motion-control' ? { safetyDeclaration: true as const } : {}),
    afterwards: o.afterwards ?? afterwards, evidence: o.evidence ?? evidence, basis: o.basis ?? basis,
  };
}

/**
 * The remedy constructors, one per `RemedyKind`. Each takes the generation and
 * optional overrides. Internal: the package exports the types and
 * `confirmationFor`, never these.
 */
export const remedy = {
  /** RobotWare 8: a person allows motion control for this control station. */
  declareMotionControl: (gen: Gen | null = 'rw8', o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'declare-motion-control', 'person-confirms-in-a-tool', 'Allow motion control',
    'A person who has an emergency stop and a normal stop within reach allows motion control for this control station. '
      + 'A station that registers on its own, such as another tool, did not share it on RobotWare 8.2.1. Or start or jog at the FlexPendant.',
    'station', gen, 'run-again', 'abb',
    'ABB RWS 2.0 Control Station Service Rev C, allowmotioncontrol; RobotWare 8 product specification 3HAC098573-001 Rev D section 2; retcode -1073435864',
    o, { method: 'setAllowMotionControl', allow: true }),

  /** RobotWare 6/7 in manual mode: this tool asks for RMMP, after a person chooses to. */
  requestRmmp: (gen: Gen | null, level: 'modify' | 'exec', o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'request-rmmp', 'person-confirms-in-a-tool', `Request RMMP ${level}`,
    level === 'exec'
      ? 'This tool asks for remote access in manual mode at the exec level (RMMP exec), which RobotWare 7 documents for a program-pointer move to a routine; '
        + 'the operator at the FlexPendant presses Grant while it waits. A RobotWare 7.21.4 virtual controller has not granted exec in any run so far.'
      : 'This tool asks for remote access in manual mode (RMMP modify), which covers the writes that need mastership there; '
        + 'the operator at the FlexPendant presses Grant while it waits.',
    'session', gen, 'run-again', 'abb',
    level === 'exec'
      ? 'ABB RWS 2.0 RAPID Service, program pointer to routine (RMMP_Exe); RWS 2.0 User Service (RMMP)'
      : 'ABB RWS 1.0 Rev M mastership pages; RWS 2.0 User Service (RMMP)',
    o, { method: 'requestRmmp', level }),

  /** RobotWare 6/7: the operator at the FlexPendant grants a request that waits. */
  grantRmmpAtPendant: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'grant-rmmp-at-pendant', 'person-at-pendant', 'Grant RMMP at the FlexPendant',
    'The operator at the FlexPendant presses Grant in the remote-access dialog while this tool waits.',
    'session', gen, 'run-again', 'abb', 'ABB RWS 2.0 User Service (RMMP): the request waits for the FlexPendant', o),

  /** RobotWare 8: an operator allows Remote Access at the FlexPendant. */
  remoteAccessOn: (gen: Gen | null = 'rw8', o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'remote-access-on', 'person-at-pendant', 'Allow Remote Access at the FlexPendant', FIX.remoteAccess,
    'controller', gen, 'run-again', 'abb', 'ABB RobotWare 8 product specification Rev D section 2 (Message button held more than 1 s)', o),

  /** RobotWare 8: the FlexPendant holds write access and releases it. */
  releasePendantWriteAccess: (gen: Gen | null = 'rw8', o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'release-pendant-write-access', 'person-at-pendant', 'Release write access at the FlexPendant',
    'The FlexPendant holds write access. The person there releases it; until then no remote station gets it.',
    'controller', gen, 'run-again', 'abb', 'ABB RobotWare 8 product specification Rev D section 2 (the FlexPendant takes and releases write access)', o),

  /** RobotWare 6/7: the FlexPendant holds mastership. */
  releasePendantMastership: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'release-pendant-mastership', 'person-at-pendant', 'Release mastership at the FlexPendant',
    'The FlexPendant holds mastership. The person there finishes what they do so it is released; in manual mode the FlexPendant has priority.',
    'controller', gen, 'run-again', 'abb', 'ABB RWS 1.0 mastership pages; PC SDK, Losing mastership', o),

  /** The current holder (another tool, a PLC, another session) releases the access. */
  holderReleases: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'holder-releases', 'other-station', 'The holder releases it',
    gen === 'rw8'
      ? 'The station that holds write access releases it there: another tool, a PLC through the Write Access system input, or another session. '
        + 'The FlexPendant can always take write access back.'
      : 'The client that holds it releases it there, or its session ends (a logout, or 5 minutes without requests).',
    'controller', gen, 'run-again', gen === 'rw8' ? 'vc' : 'abb',
    gen === 'rw8'
      ? 'ABB RobotWare 8 product specification Rev D section 2 (single point of control); retcode -1073435870'
      : 'ABB RWS mastership pages; retcode -1073445862',
    o),

  /** A hold this session took itself must end first. */
  releaseOwnHold: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'release-own-hold', 'person-at-this-tool', "End this session's own hold",
    `End the motion hold this session took, with ${MOTION_HOLD_RELEASES}, then run the operation again.`,
    'session', gen, 'run-again', 'vc', 'ABB RWS 2.0 RAPID Service, start; retcode -1073445844', o),

  /** The running program stops first; a person stops it. */
  stopProgramFirst: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'stop-program-first', 'person-confirms-in-a-tool', 'Stop RAPID first',
    'A person stops the RAPID program from this tool (stopRapid, a program stop), then runs the operation again.',
    'operation', gen, 'run-again', 'unverified', "retcode -1073442809; the client's execution-state read before the write", o,
    { method: 'stopRapid' }),

  /** RobotWare 6/7 in Auto: a person switches the motors on from this tool. */
  motorsOnCall: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'motors-on', 'person-confirms-in-a-tool', 'Switch the motors on',
    'A person switches the motors on from this tool (setMotorsOn); RobotWare 6 and 7 take a remote motors on in Auto.',
    'controller', gen, 'run-again', 'abb', 'ABB RWS panel service, ctrl-state (motors on in Auto)', o,
    { method: 'setMotorsOn' }),

  /** The motors come on at the controller: a Reset (RobotWare 8), or the enabling device in manual mode. */
  motorsOnAtPendant: (gen: Gen | null, how: 'reset' | 'enabling-device' | 'either', o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'motors-on', 'person-at-pendant', 'Switch the motors on',
    how === 'reset'
      ? 'Someone at the controller presses Reset: on RobotWare 8 the thumb button on the FlexPendant in Auto, or the configured safe input.'
      : how === 'enabling-device'
        ? 'In manual mode a person switches the motors on by holding the enabling device at the FlexPendant.'
        : 'Someone at the controller switches the motors on: in manual mode by holding the enabling device at the FlexPendant.',
    'controller', gen, 'run-again', how === 'reset' ? 'vc' : 'abb',
    how === 'reset'
      ? 'RobotWare 8 virtual controllers: Reset at the FlexPendant (an 8.1.1 virtual controller refused a remote motors on, 403 -1073445806)'
      : 'ABB: in manual mode the enabling device switches the motors on',
    o),

  /** A guard stop or an emergency stop is cleared and reset at the cell. */
  resetSafetyStop: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'reset-safety-stop', 'person-at-pendant', 'Reset the safety stop', cellSafety(gen),
    'controller', gen, 'run-again', 'vc',
    'retcode -1073445806; a guard stop or emergency stop read; RobotWare 8: the Reset (thumb) button, virtual controller runs', o),

  /** The operating mode changes at the controller. */
  mode: (gen: Gen | null, target: 'MANR' | 'AUTO' | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'mode', 'person-at-pendant',
    target === 'MANR' ? 'Switch to manual reduced speed (MANR)' : target === 'AUTO' ? 'Switch to Auto' : 'Change the operating mode',
    target === 'MANR'
      ? 'Someone at the controller switches to manual reduced speed (MANR) with the mode selector.'
      : target === 'AUTO'
        ? 'Someone at the controller switches to Auto with the key switch or mode selector; a switch to Auto is confirmed at the controller.'
        : FIX.keySwitch,
    'controller', gen, 'run-again', 'abb', 'retcodes -1073445860, -1073435895, -1073445800', o),

  /** A change of operating mode waits for its confirmation at the FlexPendant. */
  confirmModeChange: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'confirm-mode-change', 'person-at-pendant', 'Confirm the mode change at the FlexPendant',
    'The person at the FlexPendant confirms the change of operating mode. This client does not send that confirmation.',
    'controller', gen, 'run-again', 'vc', 'RobotWare 8.2.1 virtual controller run (AUTO_CH)', o),

  /** Only someone at the controller can do it now. */
  doAtPendant: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'do-at-pendant', 'person-at-pendant', 'Do it at the FlexPendant',
    'Someone at the controller does it at the FlexPendant; this tool cannot do it now.',
    'operation', gen, 'nothing', 'abb', 'ABB: local-only operations and the jog pages (local client)', o),

  /** A UAS administrator decides about the grant. */
  grantMissing: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'grant-missing', 'administrator', 'An administrator decides about the grant',
    "A UAS administrator decides whether the user gets the grant, and adds it in RobotStudio's UAS settings. This tool does not change grants.",
    'user', gen, 'run-again', 'abb', 'ABB RobotStudio operating manual (UAS); retcode -1073445867', o),

  /** The integrator decides a signal's access level. */
  signalAccessLevel: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'signal-access-level', 'integrator', 'The integrator decides the access level',
    "The integrator who owns the I/O configuration decides the signal's access level, after a safety review. This tool does not change it.",
    'configuration', gen, 'run-again', 'field', 'retcode -1073445881 on a signal write (safety access restriction)', o),

  /** The person runs the operation again; it requests access afresh. */
  runAgain: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'run-again', 'person-at-this-tool', 'Run the operation again',
    'Run the operation again: it requests access afresh, and the controller decides.',
    'operation', gen, 'run-again', 'abb', 'PC SDK, Losing mastership; retcodes -1073435871, -1073435873', o),

  /** The controller session ended: connect again. */
  reconnect: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'reconnect', 'person-at-this-tool', 'Connect again',
    'Connect again: the controller session ended.',
    'session', gen, 'run-again', 'unverified', 'retcodes -1073445873, -1073435874', o),

  /** The person corrects what was sent. */
  fixInput: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'fix-input', 'person-at-this-tool', 'Correct the input',
    'Correct the value sent, then run the operation again.',
    'operation', gen, 'run-again', 'vc',
    'retcodes -1073445879, -1073445827, -1073436654, -1073442802, -1073442803, -1073442812, -1073435867', o),

  /** The controller state is checked before trying again. */
  checkState: (gen: Gen | null, o: RemedyOpts & { byWhom?: 'person-at-this-tool' | 'person-at-pendant' } = {}): RefusalRemedy => remedyOf(
    'check-state', o.byWhom ?? 'person-at-this-tool', 'Check the controller state',
    'Check the motors, the safety state and the program pointer, then run the operation again.',
    'controller', gen, 'run-again', 'vc', 'retcodes -1073442809, -1073445806, -1073445800', o),

  /** An operation in progress holds it; it ends by itself. */
  wait: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'wait', 'none', 'Wait for the operation in progress',
    'The controller itself holds it for an operation in progress, which ends by itself; run the operation again after it.',
    'operation', gen, 'run-again', 'abb', 'mastership holder internal: an operation in progress', o),

  /** Nothing is missing. */
  nothingNeeded: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'nothing-needed', 'none', 'Nothing to do',
    'Nothing is missing: the controller says it is already so.',
    'operation', gen, 'nothing', 'abb', 'retcodes -1073445872, -1073435886', o),

  /** A RobotWare option is not installed. */
  optionMissing: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'option-missing', 'none', 'A RobotWare option is needed', FIX.option,
    'controller', gen, 'nothing', 'vc', 'icode -7301 ("Option is missing"); "is not opted"', o),

  /** Not offered here: another RobotWare version, the other kind of controller, or not open to a remote tool. */
  notAvailable: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'not-available', 'none', 'Not available here',
    'This controller does not offer it to a remote tool.',
    'controller', gen, 'nothing', 'vc', '410 Gone; retcode -1073445885; "not supported on the current platform"; by design', o),

  /** A refusal that points to a client error. */
  report: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'report', 'none', 'Report it',
    'This client takes the access each write needs, so this points to a client error or a hold that ended unseen: report it with the message.',
    'operation', gen, 'nothing', 'vc', 'not-held: the client takes access around each write', o),

  /** No next step is known. */
  noneKnown: (gen: Gen | null, o: RemedyOpts = {}): RefusalRemedy => remedyOf(
    'none-known', 'none', 'No known next step',
    "The controller gave no reason this client can explain; read the controller's code and message.",
    'operation', gen, 'nothing', 'unverified', 'a refusal this client cannot explain', o),
} as const;

/** The run-again detail of a `not-registered` refusal. */
const NEXT_WRITE_REGISTERS = 'Run the operation again: this client registers the session as a control station again before a request for write access, '
  + 'allowing motion control, or a write-access release appeal.';

/** The do-at-pendant detail of a RobotWare 6/7 jog refused in manual mode: never Auto, never RMMP. */
const JOG_AT_PENDANT = 'Jog at the FlexPendant: ABB\'s jog pages require a local client, which RMMP does not make this tool.';

/** A primary remedy and the other ways, as a draft carries them. */
interface Remedies { remedy: RefusalRemedy; otherRemedies?: RefusalRemedy[] }

const remedies = (primary: RefusalRemedy, ...others: RefusalRemedy[]): Remedies =>
  (others.length ? { remedy: primary, otherRemedies: others } : { remedy: primary });

/** Every remedy of a refusal names the refusal's generation and, when there was one, the refused request. */
function stampRemedies(r: Remedies, gen: Gen | null, operation: string | undefined): Remedies {
  const stamp = (x: RefusalRemedy): RefusalRemedy => ({
    ...x, appliesTo: { generation: gen, scope: x.appliesTo.scope, ...(operation ? { operation } : {}) },
  });
  return r.otherRemedies ? { remedy: stamp(r.remedy), otherRemedies: r.otherRemedies.map(stamp) } : { remedy: stamp(r.remedy) };
}

/**
 * The RMMP level that covers a refused request on RobotWare 6 or 7, or null
 * when RMMP does not cover it: `exec` for a RobotWare 7 program-pointer move
 * to a routine (ABB: RMMP_Exe), null for a start, PP to Main, any other
 * pointer move, a signal write, a jog, a motors write or an RMMP call, and
 * `modify` for every other write that needs mastership. RobotWare 8 has no
 * RMMP.
 */
export function rmmpLevelFor(op: Op | null, path: string, gen: Gen | null): 'modify' | 'exec' | null {
  if (gen === 'rw8') { return null; }
  if (!op) { return 'modify'; }
  switch (op.kind) {
    case 'start': case 'io-write': case 'jog': case 'motors-on': case 'motors-off': case 'motors': case 'rmmp': case 'rmmp-request':
      return null;
    default:
      break;
  }
  if (op.label === PP_TO_MAIN) { return null; }
  if (op.label === PP_MOVE) { return gen === 'rw7' && isRoutinePointerMove(path) ? 'exec' : null; }
  return 'modify';
}

/** RMMP is offered on RobotWare 6 and 7 only, and never in Auto (a mode not known does not rule it out). */
function rmmpOffered(gen: Gen | null, mode: string | null): boolean {
  return gen !== 'rw8' && (mode === null || isManual(mode));
}

/** A program-pointer move to a routine (RWS 2.0 `pcp/routine` and `pcp/routine-from-url`). */
function isRoutinePointerMove(path: string): boolean {
  return /\/pcp\/routine(-from-url)?(\?|$)/i.test(path);
}

/**
 * The remedies of a refusal built without a controller answer, from its kind,
 * generation, grantor and condition (and the operating mode, when known: RMMP
 * is offered in manual mode only). Every built refusal gets one; the build
 * sites that know more pass their own.
 */
export function defaultRemedies(
  kind: RefusalKind, gen: Gen | null, grantor: RefusalGrantor | null, condition: RefusalCondition, mode: string | null = null,
): Remedies {
  const rmmpFits = rmmpOffered(gen, mode);
  switch (kind) {
    case 'held-by-other': return remedies(remedy.holderReleases(gen));
    case 'not-held': return remedies(remedy.report(gen));
    case 'not-registered': return remedies(remedy.runAgain(gen, { detail: NEXT_WRITE_REGISTERS, evidence: 'vc' }));
    case 'lost': case 'watchdog-expired': return remedies(remedy.runAgain(gen));
    case 'remote-access-off': return remedies(remedy.remoteAccessOn(gen));
    case 'motion-control-off':
      // Without the controller's own answer it is a reading, never the primary declaration.
      return remedies(motionControlReadCheck(gen), remedy.declareMotionControl(gen), remedy.doAtPendant(gen));
    case 'motion-held': return remedies(remedy.releaseOwnHold(gen));
    case 'external-client-motion': return remedies(remedy.holderReleases(gen, EXTERNAL_CLIENT));
    case 'rmmp-required': return remedies(remedy.doAtPendant(gen), remedy.mode(gen, 'AUTO'));
    case 'rmmp-pending': return remedies(remedy.grantRmmpAtPendant(gen));
    case 'rmmp-denied':
      return rmmpFits ? remedies(rmmpDenied(gen), remedy.requestRmmp(gen, 'modify')) : remedies(rmmpDenied(gen));
    case 'rmmp-expired':
      return rmmpFits ? remedies(remedy.requestRmmp(gen, 'modify'), remedy.doAtPendant(gen)) : remedies(remedy.doAtPendant(gen));
    case 'rmmp-wrong-mode': return remedies(remedy.mode(gen, 'MANR'));
    case 'grant-missing': return remedies(remedy.grantMissing(gen));
    case 'wrong-mode': return remedies(grantor === 'pendant-operator' ? remedy.doAtPendant(gen) : remedy.mode(gen, null));
    case 'wrong-state':
      if (grantor === 'cell-safety' && condition !== 'motors') { return remedies(remedy.resetSafetyStop(gen)); }
      if (condition === 'motors') { return remedies(remedy.motorsOnAtPendant(gen, gen === 'rw8' ? 'reset' : 'either')); }
      return remedies(remedy.checkState(gen));
    case 'safety-state': return remedies(remedy.resetSafetyStop(gen));
    case 'access-restricted': return remedies(remedy.signalAccessLevel(gen));
    case 'local-only': return remedies(remedy.doAtPendant(gen));
    case 'vc-only': case 'rc-only': case 'unsupported': case 'by-design': return remedies(remedy.notAvailable(gen));
    case 'option-missing': return remedies(remedy.optionMissing(gen));
    case 'invalid-argument': return remedies(remedy.fixInput(gen));
    case 'unknown': return remedies(remedy.noneKnown(gen));
    default: return remedies(remedy.noneKnown(gen));
  }
}

/** The holder-releases detail for an external client that controls motion. */
const EXTERNAL_CLIENT: RemedyOpts = {
  detail: 'The external client that controls motion releases it there.',
  basis: 'ABB return-code lists; retcode -1073445845',
  evidence: 'abb',
};

/** RMMP on RobotWare 8, where it does not exist: Remote Access and write access take its place. */
export function rmmpNotOnRw8(gen: Gen | null = 'rw8'): RefusalRemedy {
  return remedy.notAvailable(gen, {
    detail: 'RobotWare 8 has no RMMP. An operator allows Remote Access at the FlexPendant, and this tool then requests write access instead.',
    evidence: 'abb',
    basis: 'ABB RWS 2.0 User Service: RMMP not supported from RobotWare 8.1; RobotWare 8 product specification Rev D section 2',
  });
}

/** `rmmp-denied`: the operator said no; speaking to them comes first. */
function rmmpDenied(gen: Gen | null): RefusalRemedy {
  return remedy.grantRmmpAtPendant(gen, {
    detail: 'The operator at the FlexPendant said no. Speak to them first; this tool never asks again on its own.',
    evidence: 'unverified',
  });
}

/**
 * A jog refused while motion control read as not allowed, with no answer from
 * the controller that says so: check first; allowing it is another way.
 */
function motionControlReadCheck(gen: Gen | null): RefusalRemedy {
  return remedy.checkState(gen, {
    detail: 'The controller did not say why it refused. Motion control read as not allowed for this control station before the jog; '
      + 'check that, and the motors and the operating mode, at the controller.',
    evidence: 'unverified',
    basis: 'the reading of allow-motion-control before the jog; the controller gave another answer than -1073435864',
  });
}

/**
 * The remedies of a `motion-control-off` refusal: the controller's own
 * -1073435864 answer (`code`), or a jog refused while the reading was off
 * (`reading`). Exported for the build sites outside this module.
 */
export function motionControlRemedies(by: 'code' | 'reading'): Remedies {
  return by === 'code'
    ? remedies(remedy.declareMotionControl('rw8'), remedy.doAtPendant('rw8', { detail: 'Start or jog at the FlexPendant instead.' }))
    : remedies(motionControlReadCheck('rw8'), remedy.declareMotionControl('rw8'),
      remedy.doAtPendant('rw8', { detail: 'Start or jog at the FlexPendant instead.' }));
}

/**
 * The text a tool shows a person before it makes a remedy's `call`, for the
 * robot `target` (`name`: the controller's name; `label`: the name and address
 * a tool shows). Null for a remedy without a call. A pure function: the
 * client never calls it, and never makes the call.
 *
 * `virtual` adds the virtual-controller line; `flexPendantConnected` false
 * (from `RobotManager.getLocalStationStatus`) adds the line that its stops are
 * not available. Unknown (null or absent) adds nothing.
 */
export function confirmationFor(
  r: RefusalRemedy,
  target: { name: string; label: string; virtual?: boolean | null; flexPendantConnected?: boolean | null },
): RemedyConfirmation | null {
  const call = r.call;
  if (!call) { return null; }
  const { name, label } = target;
  switch (call.method) {
    case 'setAllowMotionControl': {
      const lines = [
        `You confirm that an emergency stop and a normal stop are within your reach, for every robot and axis ${name} moves. `
          + `${name} takes this as this control station's confirmation that both stops are available (ABB, Control Station Service: Allow Motion Control).`,
        "A normal stop is the FlexPendant's Stop button held for more than 1 second, or a safe input set up for it. "
          + 'It is a category 1 stop and ends in guard stop (ABB, RobotWare 8 product specification).',
      ];
      if (target.virtual === true) {
        lines.push(VIRTUAL_FLEXPENDANT_STOPS_SHOWN
          ? "This is a virtual controller. Its emergency stop and its Stop button are on RobotStudio's virtual FlexPendant."
          : "This is a virtual controller. RobotStudio's virtual FlexPendant stands in for its FlexPendant.");
      }
      if (target.flexPendantConnected === false) {
        lines.push('The FlexPendant reads as not connected. Its stops are not available.');
      }
      lines.push('Allowing it moves nothing by itself.');
      return {
        title: `Allow Motion Control on ${label}`,
        lines,
        confirmLabel: 'Both stops are within my reach',
        typeName: true,
        typePrompt: `Type the robot's name to confirm that both stops are within your reach: ${name}`,
      };
    }
    case 'setMotorsOn':
      return {
        title: `Switch the motors on at ${label}`,
        lines: [`Switches the motors on at ${name}. In Auto a running program can move the robot.`],
        confirmLabel: 'Switch the motors on',
        typeName: true,
        typePrompt: `Type the robot's name to switch its motors on: ${name}`,
      };
    case 'requestRmmp':
      return {
        title: `Request RMMP ${call.level} on ${label}`,
        lines: [`Asks the operator at the FlexPendant of ${name} to grant remote access in manual mode (RMMP ${call.level}). `
          + 'Nothing changes until the operator presses Grant.'],
        confirmLabel: `Ask the operator at the FlexPendant of ${name} for ${call.level}`,
        typeName: false,
        typePrompt: null,
      };
    case 'stopRapid':
      return {
        title: `Stop RAPID on ${label}`,
        lines: ['This is a program stop, not a normal stop.'],
        confirmLabel: `Stop RAPID on ${name}`,
        typeName: false,
        typePrompt: null,
      };
    default:
      return null;
  }
}

/**
 * Whether a run has shown the normal stop on RobotStudio's virtual
 * FlexPendant. Until one has, the virtual-controller line of the
 * motion-control confirmation names neither stop.
 */
const VIRTUAL_FLEXPENDANT_STOPS_SHOWN = false;

/**
 * A request refused because the motors are off. `cause` replaces "the motors
 * are off. " in the sentence when the motors state is inferred from the
 * controller's answer rather than known.
 *
 * A jog refused in Auto with the motors off: switching the motors on would
 * not make it go, because ABB documents jogging in manual mode, at the
 * FlexPendant. The sentence says that instead; the kind stays `wrong-state`
 * and the code stays the one the controller's answer classifies as.
 */
function motorsOffDraft(R: string, W: string, gen: Gen | null, mode: string | null, cause: string, op: Op | null = null): Draft {
  if (op?.kind === 'jog' && mode === 'AUTO') {
    const manual = 'switch to manual reduced speed (MANR) with the mode selector, and a person there switches the motors on by holding the enabling device.';
    return {
      kind: 'wrong-state', condition: 'motors', grantor: 'pendant-operator',
      missing: 'manual mode and the motors on (the controller is in AUTO with the motors off)',
      fix: `Jog in manual mode at the FlexPendant: ${manual}`,
      sentence: `${R} refused ${W} in AUTO with the motors off. Jogging is done in manual mode at the FlexPendant, not in Auto: ${manual}`,
      evidence: 'abb',
      ...remedies(remedy.doAtPendant(gen, {
        detail: 'Jog at the FlexPendant: someone switches to manual reduced speed (MANR) with the mode selector and holds the enabling device.',
      })),
    };
  }
  const rw8 = gen === 'rw8';
  // RobotWare 6/7 in Auto: the motors come on over RWS, after a person
  // confirms; on RobotWare 8, in manual mode, for a jog or with the mode not
  // known, they come on at the controller.
  const viaTool = (gen === 'rw6' || gen === 'rw7') && mode === 'AUTO' && op?.kind !== 'jog';
  const atPendant = remedy.motorsOnAtPendant(gen, rw8 ? 'reset' : isManual(mode) || op?.kind === 'jog' ? 'enabling-device' : 'either');
  return {
    kind: 'wrong-state', condition: 'motors', grantor: rw8 ? 'cell-safety' : isManual(mode) ? 'pendant-operator' : 'this-tool',
    missing: 'motors on',
    fix: rw8
      ? 'Switch the motors on first: on RobotWare 8 someone presses Reset at the controller (the thumb button on the FlexPendant in Auto).'
      : isManual(mode)
        ? 'Switch the motors on first: in manual mode a person holds the enabling device at the FlexPendant.'
        : 'Switch the motors on first.',
    sentence: `${R} refused ${W}: ${cause || 'the motors are off. '}${rw8
      ? 'Switch them on first: on RobotWare 8 someone presses Reset at the controller (the thumb button on the FlexPendant in Auto).'
      : isManual(mode) ? 'In manual mode a person switches them on by holding the enabling device at the FlexPendant.' : 'Switch them on first.'}`,
    evidence: 'vc',
    ...(viaTool ? remedies(remedy.motorsOnCall(gen), atPendant) : remedies(atPendant)),
  };
}

/**
 * A request refused in a controller state the caller knows: the motors off,
 * a guard stop or an emergency stop, from its last read of the controller
 * state. Null when the caller knows none of these. A motors write is never
 * explained as "the motors are off": that is what it was asked to change.
 */
function knownStateDraft(R: string, W: string, op: Op | null, gen: Gen | null, mode: string | null, ctx: RefusalContext): Draft | null {
  const s = (ctx.ctrlstate ?? '').toLowerCase();
  const motorsWrite = op?.kind === 'motors-on' || op?.kind === 'motors-off' || op?.kind === 'motors';
  if (s === 'motoroff' && !motorsWrite) { return motorsOffDraft(R, W, gen, mode, '', op); }
  if (s === 'guardstop' || s === 'emergencystop' || s === 'emergencystopreset') {
    const what = s === 'guardstop' ? 'guard stop' : 'emergency stop';
    return {
      kind: 'wrong-state', condition: 'safety-state', grantor: 'cell-safety',
      missing: `a reset of the ${what}`, fix: cellSafety(gen),
      sentence: `${R} refused ${W}: the controller is in ${what}. ${cellSafety(gen)}`,
      evidence: 'vc',
      ...remedies(remedy.resetSafetyStop(gen)),
    };
  }
  return null;
}

/**
 * The sentence naming who holds the access, from what the controller
 * reported. RobotWare 8 names the holding station by name, never by id.
 */
export function holderSentence(holder: RefusalHolder | null, gen: Gen | null): string {
  if (!holder) { return 'The controller did not say who holds it.'; }
  if (gen === 'rw8' || holder.name) {
    return holder.name
      ? `Write access is held by control station '${holder.name}'. That station's user must release it there; the FlexPendant can take write access back at any time.`
      : 'The controller did not say who holds it.';
  }
  const who = [
    holder.application ? `application '${holder.application}'` : '',
    holder.id ? `user id ${holder.id}` : '',
  ].filter(Boolean).join(', ');
  switch (holder.kind) {
    case 'local':
      return 'The FlexPendant holds mastership. In manual mode the pendant has priority.';
    case 'remote':
      return `Another remote client holds mastership${who ? ` (${who})` : ''}. It must release it there, or its session must end.`;
    case 'internal':
      return 'The controller itself holds mastership (for example for an operation in progress). Wait until it finishes, then try again.';
    case 'self':
      return 'The controller names this session as the holder.';
    default:
      return 'The controller did not say who holds it.';
  }
}

/**
 * A mastership status read (`getMastershipStatus`) as a holder. `nomaster`,
 * `unknown` and an empty value name nobody.
 */
export function holderFromMastership(s: { mastership: string; uid?: string; application?: string } | null | undefined): RefusalHolder | null {
  if (!s) { return null; }
  const extra = {
    ...(s.uid ? { id: s.uid } : {}),
    ...(s.application ? { application: s.application } : {}),
  };
  switch ((s.mastership ?? '').toLowerCase()) {
    case 'local': return markPendant({ kind: 'local', ...extra });
    case 'remote': return markPendant({ kind: 'remote', ...extra });
    case 'internal': return markPendant({ kind: 'internal', ...extra });
    case 'nomaster': case 'unknown': case '': return null;
    default: return markPendant({ kind: 'unknown', ...extra });
  }
}

/** A RobotWare 8 write-access status read as a holder: the other station's name, never its id. */
export function holderFromWriteAccess(s: { held: boolean; heldByMe: boolean; heldByName: string } | null | undefined): RefusalHolder | null {
  if (!s || !s.held) { return null; }
  if (s.heldByMe) { return { kind: 'self' }; }
  return s.heldByName && s.heldByName !== 'none' ? markPendant({ kind: 'unknown', name: s.heldByName }) : null;
}

// ─── Explaining one answer ───────────────────────────────────────────────────

/** One controller answer, as `refusalFor` reads it. Holds no request body. */
export interface ControllerAnswer {
  http: number;
  /** The controller's outer code, or null when its body had none. */
  code: number | null;
  /** The controller's message, cleaned. */
  msg: string | null;
  method: string;
  /** The request path, with its query string. */
  path: string;
  /** For a motors write: whether it asked for motors on or off. */
  motors?: 'on' | 'off' | null;
}

/** For a motors write: whether the request body asked for motors on or off. Nothing else of the body is kept. */
export function motorsOfBody(body: string | Uint8Array | undefined | null): 'on' | 'off' | null {
  if (typeof body !== 'string') { return null; }
  if (/ctrl-state=motoron/i.test(body)) { return 'on'; }
  if (/ctrl-state=motoroff/i.test(body)) { return 'off'; }
  return null;
}

interface Draft {
  kind: RefusalKind;
  condition: RefusalCondition;
  grantor: RefusalGrantor | null;
  missing: string;
  fix: string;
  sentence: string;
  evidence: Evidence;
  code?: RwsErrorCode;
  grants?: RefusalGrant[];
  holder?: RefusalHolder;
  user?: string;
  /** The next step, built next to `fix` so the sentence and the remedy agree. Absent: the default for the kind. */
  remedy?: RefusalRemedy;
  otherRemedies?: RefusalRemedy[];
}

/** What `refusalFor` produced, and what `explainRefusal` needs to redo it. */
interface Origin { answer: ControllerAnswer; context: RefusalContext; lost?: string }
const origins = new WeakMap<RwsRefusal, Origin>();

function genOf(code: number | null, ctx: RefusalContext): Gen | null {
  if (ctx.generation) { return ctx.generation; }
  if (code !== null && REFUSAL_CODES.get(code)?.rw8) { return 'rw8'; }
  return null;
}

function modeOf(ctx: RefusalContext): string | null {
  const m = ctx.opmode ? String(ctx.opmode).trim().toUpperCase() : '';
  return m === '' ? null : m;
}

function lockWord(gen: Gen | null, domain?: string): string {
  if (gen === 'rw8') { return 'control-station write access'; }
  return domain ? `${domain} mastership` : 'mastership';
}

function accessCondition(gen: Gen | null): RefusalCondition {
  return gen === 'rw8' ? 'write-access' : 'mastership';
}

/** The RMMP sentence on RobotWare 8, where RMMP does not exist. */
function rmmpUnsupportedSentence(ctx: RefusalContext): string {
  const rw = ctx.rwVersion ? `RobotWare ${ctx.rwVersion}` : 'RobotWare 8';
  return `${rw} does not support remote manual-mode privileges (RMMP); ABB lists them as not supported from RobotWare 8.1 onwards. `
    + 'On RobotWare 8 an operator allows Remote Access on the FlexPendant and this tool requests write access instead '
    + '(RobotWare 8.2 and later, in manual mode: also the grant \'Allow remote access in manual mode\').';
}

function heldByOther(op: Op | null, gen: Gen | null, ctx: RefusalContext, R: string, path: string): Draft {
  const W = whatOf(op);
  const mode = modeOf(ctx);
  const holder = ctx.holder ?? null;
  if (gen === 'rw8') {
    const named = holder?.name
      ? holderSentence(holder, 'rw8')
      : 'Write access is held by another control station (a remote tool, a PLC through the \'Write Access\' system input, or the FlexPendant); '
        + 'the controller did not say which. Its user must release it there; the FlexPendant can take write access back at any time.';
    // The holder's name stays in `holder`: the remedy's words are the client's own.
    return {
      kind: 'held-by-other', condition: 'write-access', grantor: 'current-holder',
      missing: 'control-station write access, which another station holds',
      fix: holder?.name
        ? `The user of control station '${holder.name}' must release write access there; the FlexPendant can take write access back at any time.`
        : 'The holding station\'s user must release write access there; the FlexPendant can take write access back at any time.',
      sentence: `${R} refused ${W}. ${named}`, evidence: 'vc', ...(holder ? { holder } : {}),
      ...remedies(isFlexPendantStation(holder?.name) ? remedy.releasePendantWriteAccess('rw8') : remedy.holderReleases('rw8')),
    };
  }
  // RobotWare 6/7. In manual mode the FlexPendant has priority and a remote
  // tool gets mastership only after RMMP (RWS 1.0 mastership request page; an
  // ABB forum staff answer). Never advised in Auto, on RobotWare 8, or when
  // the controller names another remote client or itself as the holder, and
  // RMMP is offered only for an operation it covers (rmmpLevelFor): ABB gives
  // a start, PP to Main and the other pointer moves to a remote tool in Auto,
  // or to the FlexPendant. A jog is neither: ABB's jog pages require a local
  // client with mastership, in manual mode (RWS 1.0 manual Rev M, Perform
  // Jogging; RWS 2.0 Rev L, Motion System), so a jog goes to the FlexPendant
  // only, never to Auto.
  const manualRmmp = (gen === 'rw6' || gen === 'rw7') && isManual(mode);
  if (manualRmmp && ctx.rmmp !== 'granted' && holder?.kind !== 'remote' && holder?.kind !== 'internal') {
    const level = rmmpLevelFor(op, path, gen);
    const jog = op?.kind === 'jog';
    const notCovered = jog
      ? 'Jog at the FlexPendant: ABB\'s jog pages require a local client with mastership, and RMMP does not make this tool local.'
      : 'Do it at the FlexPendant, or from this tool in Auto; RMMP does not cover this operation.';
    const notCoveredRemedies = (): Remedies => (jog
      ? remedies(remedy.doAtPendant(gen, { detail: JOG_AT_PENDANT }))
      : remedies(remedy.doAtPendant(gen), remedy.mode(gen, 'AUTO')));
    if (gen === 'rw7' && mode === 'MANF') {
      return {
        kind: 'rmmp-wrong-mode', condition: 'rmmp', grantor: 'key-switch',
        missing: level || !jog
          ? 'manual reduced speed (MANR), where RobotWare 7 accepts an RMMP request'
          : 'a local client with mastership, which a jog in manual mode needs and RMMP does not make this tool',
        fix: level
          ? `${FIX.toMANR} Then this tool can ask for remote access (RMMP), and the operator at the FlexPendant grants it.`
          : notCovered,
        sentence: `${R} refused ${W}: in manual mode a remote tool gets mastership only after remote access (RMMP) is granted at the FlexPendant, `
          + 'and on RobotWare 7 ABB accepts an RMMP request only in manual reduced speed (MANR). The controller is in MANF.'
          + (level ? '' : ` ${notCovered}`),
        evidence: 'abb', ...(holder ? { holder } : {}),
        ...(level
          ? remedies(remedy.mode(gen, 'MANR'), remedy.requestRmmp(gen, level))
          : notCoveredRemedies()),
      };
    }
    const pending = ctx.rmmp === 'pending' ? ' A request of this session is still waiting for the operator.' : '';
    const kind: RefusalKind = ctx.rmmp === 'pending' ? 'rmmp-pending' : 'rmmp-required';
    if (!level) {
      return {
        kind, condition: 'rmmp', grantor: 'pendant-operator',
        missing: jog
          ? 'a local client with mastership, which a jog in manual mode needs and RMMP does not make this tool'
          : 'remote access in manual mode (RMMP), granted at the FlexPendant, which does not cover this operation',
        fix: notCovered,
        sentence: `${R} refused ${W}: in manual mode the FlexPendant has priority, and remote access in manual mode (RMMP) does not cover this operation`
          + `${jog ? '.' : ': ABB gives it to a remote tool in Auto, or to the FlexPendant.'}${pending} ${notCovered}`,
        evidence: 'abb', ...(holder ? { holder } : {}),
        // Granting the waiting request would not cover a jog either.
        ...(kind === 'rmmp-pending' && !jog
          ? remedies(remedy.grantRmmpAtPendant(gen), remedy.doAtPendant(gen), remedy.mode(gen, 'AUTO'))
          : notCoveredRemedies()),
      };
    }
    return {
      kind, condition: 'rmmp', grantor: 'pendant-operator',
      missing: 'remote access in manual mode (RMMP), granted at the FlexPendant',
      fix: `This tool asks for it (requestRmmp); ${FIX.rmmpGrant.charAt(0).toLowerCase()}${FIX.rmmpGrant.slice(1)}`,
      sentence: `${R} refused ${W}: in manual mode the FlexPendant has priority, and a remote tool gets mastership only after remote access (RMMP) `
        + `is granted at the FlexPendant.${pending} This tool can ask for it (requestRmmp); the operator at the FlexPendant must press Grant while it waits.`,
      evidence: 'field', ...(holder ? { holder } : {}),
      ...(kind === 'rmmp-pending'
        ? remedies(remedy.grantRmmpAtPendant(gen))
        : remedies(remedy.requestRmmp(gen, level), remedy.doAtPendant(gen))),
    };
  }
  const lw = lockWord(gen, op?.domain);
  const pendant = holder?.kind === 'local';
  let tail: string;
  if (holder) {
    tail = holderSentence(holder, gen);
  } else if (op?.kind === 'mastership-request') {
    tail = `Another client or the FlexPendant holds ${lw}; the controller did not say which. It must release it there, or its session must end.`;
  } else {
    // RWS 2.0 also answers this code when an operation in progress blocks
    // the resource (a RAPID start refused, icode -13).
    tail = `It is held by someone else: another client or the FlexPendant holding ${lw}, or an operation in progress. `
      + 'The holder must release it, or its session must end; an operation in progress ends by itself.';
  }
  // RobotWare 7 names the FlexPendant's own session by its application, TPU,
  // as a local holder (isPendantHolder).
  const tpu = isPendantHolder(holder);
  const next = holder?.kind === 'internal' ? remedy.wait(gen)
    : holder?.kind === 'self' ? remedy.releaseOwnHold(gen, {
      detail: 'The controller names this session as the holder: end the hold this session took (a hold taken with requestMastershipWithId is not '
        + 'counted by the client), then run the operation again.',
    })
      : pendant || tpu ? remedy.releasePendantMastership(gen)
        : remedy.holderReleases(gen);
  return {
    kind: 'held-by-other', condition: 'mastership', grantor: pendant ? 'pendant-operator' : 'current-holder',
    missing: `${lw}, which someone else holds`,
    fix: holder ? holderSentence(holder, gen) : 'The holder must release it there, or its session must end (logout, or 5 minutes without requests).',
    sentence: `${R} refused ${W}. ${tail}`,
    evidence: 'vc', ...(holder ? { holder } : {}),
    ...remedies(next),
  };
}

function grantMissing(op: Op | null, gen: Gen | null, ctx: RefusalContext, answer: ControllerAnswer): Draft {
  const user = ctx.user ?? null;
  const U = user ? `User '${user}'` : 'The logged-in user';
  const robot = robotOf(ctx);
  if (op?.kind === 'uas') {
    return {
      kind: 'grant-missing', condition: 'uas-grant', grantor: 'uas-administrator',
      missing: 'a UAS grant or licence the controller did not name',
      fix: administratorFix(gen, ctx.robot ?? null, user, null),
      sentence: `${U} is not allowed to ${op.label} on ${robot}. The controller does not say which grant or licence is missing. `
        + administratorFix(gen, ctx.robot ?? null, user, null),
      evidence: 'vc', ...(user ? { user } : {}),
      ...remedies(remedy.grantMissing(gen)),
    };
  }
  const info = op?.grants?.(gen, modeOf(ctx)) ?? null;
  const grants = info?.grants ?? [];
  const fix = administratorFix(gen, ctx.robot ?? null, user, grants.length ? grants : null, info?.needsAll ?? true);
  let needs = '';
  if (grants.length === 1 && info?.needsAll) {
    needs = ` It needs the grant ${grantText(grants[0])}.`;
  } else if (grants.length > 1 && info?.needsAll) {
    needs = ` It needs the grants ${grants.map(grantText).join(' and ')}; at least one is missing.`;
  } else if (grants.length > 0) {
    needs = ` Candidate grants: ${grants.map(grantText).join(', ')}.`;
  }
  const note = info?.note ? ` ${info.note}` : '';
  const doing = op ? op.label : `do this (${answer.method.toUpperCase()} ${answer.path.split('?')[0]})`;
  const icode = icodeOf(answer.msg);
  const evidence: Evidence = grants.length === 0 ? 'vc' : grants.every(g => g.labelEvidence === 'abb') ? 'abb' : 'unverified';
  return {
    kind: 'grant-missing', condition: 'uas-grant', grantor: 'uas-administrator',
    missing: grants.length === 0 ? 'a UAS grant the controller did not name'
      : grants.length === 1 ? `the UAS grant ${grants[0].id}`
        : info?.needsAll ? `the UAS grants ${grants.map(g => g.id).join(' and ')} (at least one is missing)`
          : `one of the UAS grants ${grants.map(g => g.id).join(', ')}`,
    fix,
    sentence: `${U} is not allowed to ${doing} on ${robot}${icode === -757 ? ' ("The user is not allowed access")' : ''}.${needs}${note} ${fix}`,
    evidence, ...(grants.length ? { grants } : {}), ...(user ? { user } : {}),
    ...remedies(remedy.grantMissing(gen)),
  };
}

/**
 * A write-access request refused while a change of operating mode waits for
 * its confirmation at the FlexPendant (see WRITE_ACCESS_REFUSED_IN_MODE_CHANGE).
 * The confirmation is the person's at the FlexPendant;
 * RobotManager.setOperationMode, this client's mode switch, does not send it.
 * Only AUTO_CH was observed; another pending change is explained the same
 * way, marked unverified.
 */
function modeChangePendingDraft(R: string, W: string, mode: string): Draft {
  const fix = 'The person at the FlexPendant confirms the change of operating mode; this client\'s mode switch (setOperationMode) does not send '
    + 'that confirmation, and sending the switch again does not confirm it. Once the controller reads the new mode, write access can be taken again.';
  return {
    kind: 'wrong-mode', condition: 'operating-mode', grantor: 'pendant-operator',
    missing: `a confirmed operating mode (the controller reads ${mode}: a change of operating mode waits for the confirmation at the FlexPendant)`,
    fix,
    sentence: `${R} refused ${W} while a change of operating mode waits for the confirmation at the FlexPendant (it reads ${mode}); `
      + `until it is confirmed, a remote control station cannot take write access. ${fix}`,
    evidence: mode === 'AUTO_CH' ? 'vc' : 'unverified',
    ...remedies(remedy.confirmModeChange('rw8', { evidence: mode === 'AUTO_CH' ? 'vc' : 'unverified' })),
  };
}

function unknownDraft(sentence: string, code?: RwsErrorCode, gen: Gen | null = null): Draft {
  return {
    kind: 'unknown', condition: 'unknown', grantor: null,
    missing: 'not known: the controller gave no reason this client can explain',
    fix: 'Read the controller\'s code and message below; this client cannot say more.',
    sentence, evidence: 'unverified', ...(code ? { code } : {}),
    ...remedies(remedy.noneKnown(gen)),
  };
}

/**
 * The refusal for one controller code (after SYS_CTRL_E_FAIL was unwrapped),
 * or null when the code is not an access refusal this client explains.
 */
function draftFor(code: number, op: Op | null, gen: Gen | null, ctx: RefusalContext, answer: ControllerAnswer, lost?: string): Draft | null {
  const R = cap(robotOf(ctx));
  const W = whatOf(op);
  const mode = modeOf(ctx);
  const lw = lockWord(gen, op?.domain);
  switch (code) {
    case -1073445862: // RESOURCE_HELD
    case -1073435870: // WRITE_ACCESS_ALREADY_TAKEN
      return heldByOther(op, code === -1073435870 ? 'rw8' : gen, ctx, R, answer.path);

    case -1073445859: // MASTER_REJECT
    case -1073445880: // RESOURCE_NOT_HELD
    case -1073435873: { // CONTROL_STATION_DOES_NOT_HAVE_WRITE_ACCESS
      const rw8 = code === -1073435873;
      const g = rw8 ? 'rw8' : gen;
      if (lost !== undefined) {
        return {
          kind: 'lost', condition: accessCondition(g), grantor: 'this-tool',
          missing: `${lockWord(g)}, which this session held when the operation began`,
          fix: 'Run the operation again: it requests access afresh, and the controller decides.',
          sentence: rw8
            ? `This tool lost write access on ${robotOf(ctx)} during this operation${lost ? ` (${lost})` : ''}. The refused step and every later step `
              + 'were not applied; request write access again. The FlexPendant can take write access back at any time.'
            : `This session's ${lockWord(g)} on ${robotOf(ctx)} was lost during this operation${lost ? ` (${lost})` : ''}: a mode change, a restart, `
              + 'a lost connection, or the FlexPendant taking it back ends it. The refused step was not applied; run the operation again to request it afresh.',
          evidence: rw8 ? 'vc' : 'abb',
          ...remedies(remedy.runAgain(g)),
        };
      }
      if (rw8 && ctx.registered === false) {
        return {
          kind: 'not-registered', condition: 'control-station', grantor: 'this-tool',
          missing: 'a control-station registration for this session',
          fix: 'The next request for write access registers this session again.',
          sentence: `${R} refused ${W}: this session is not registered as a control station, so it holds no write access. `
            + 'The next request for write access registers it again.',
          evidence: 'vc',
          ...remedies(remedy.runAgain(g, { detail: NEXT_WRITE_REGISTERS, evidence: 'vc' })),
        };
      }
      return {
        kind: 'not-held', condition: accessCondition(g), grantor: 'this-tool',
        missing: `${lockWord(g, op?.domain)}, which this session did not hold`,
        fix: 'This client takes that access around each write that needs it, so this points to a client error or a hold that ended unseen: '
          + 'report it with this message.',
        sentence: `${R} refused ${W}: it needs ${lockWord(g, op?.domain)}, and this session did not hold it. `
          + 'This client takes that access around each write that needs it, so this points to a client error or a hold that ended unseen: '
          + 'report it with this message.',
        evidence: code === -1073445880 ? 'abb' : 'vc',
        ...remedies(remedy.report(g)),
      };
    }

    case -1073435871: // NOT_A_CONTROL_STATION
      return {
        kind: 'not-registered', condition: 'control-station', grantor: 'this-tool',
        missing: 'a control-station registration for this session',
        fix: 'The next request for write access registers this session again; if this persists, report it.',
        sentence: `${R} refused ${W}: this session is not registered as a control station (a registration ends with its controller session). `
          + 'The next request for write access registers it again; if this persists, report it.',
        evidence: 'vc',
        ...remedies(remedy.runAgain('rw8', { detail: NEXT_WRITE_REGISTERS, evidence: 'vc' })),
      };

    case -1073435872: // EXTERNAL_CONTROL_ENABLE_NOT_SET
      return {
        kind: 'remote-access-off', condition: 'remote-access', grantor: 'pendant-operator',
        missing: 'Remote Access allowed at the FlexPendant',
        fix: FIX.remoteAccess,
        sentence: `Remote access is not allowed on ${robotOf(ctx)}, so it refused ${W}. ${FIX.remoteAccess}`,
        evidence: 'abb',
        ...remedies(remedy.remoteAccessOn('rw8')),
      };

    case -1073435864: { // NOT_ALLOWED_TO_MOVE_ROBOT
      // RobotWare 8: this station has not declared motion control. The
      // controller's own text: "Operation rejected because the Control Station
      // has not Motion Control enabled". An RW 8.2.1 virtual controller
      // answered a RAPID start with it (403, 2026-10-18) while the declaration
      // read false, for a program that does not move the robot; the same start
      // ran once the declaration was made. A second station, which registers
      // with its own id, read it false. The sentence names no method (people
      // read it): `fix` and `remedy.call` do.
      const start = op?.kind === 'start'
        ? ' A RAPID start needs it even for a program that does not move the robot.'
        : '';
      return {
        kind: 'motion-control-off', condition: 'motion-control', grantor: 'this-tool',
        missing: MOTION_CONTROL_MISSING,
        fix: MOTION_CONTROL_DECLARE,
        sentence: `${R} refused ${W}: motion control is not allowed for this control station. ${MOTION_CONTROL_RULE}${start}`,
        evidence: 'vc',
        // Allowing motion control is offered on RobotWare 8 only: a caller
        // that says the controller is RobotWare 6 or 7 gets the FlexPendant.
        ...(gen === 'rw6' || gen === 'rw7'
          ? remedies(remedy.doAtPendant(gen, { detail: 'Start or jog at the FlexPendant instead.' }))
          : motionControlRemedies('code')),
      };
    }

    case -1073445844: // RESOURCE_MOTION_HELD_REJECT
      // RobotManager ends a jog's own motion hold before a start (RobotWare 6
      // and 7) or a step (RobotWare 7), so the hold left to explain is one the
      // caller took. Each hold ends only with the release that matches the call
      // that took it: releaseMastership('motion') does not end a hold taken
      // with requestMastershipAll().
      return {
        kind: 'motion-held', condition: 'mastership', grantor: 'this-tool',
        missing: 'no motion mastership held by this session',
        fix: `End the motion hold with ${MOTION_HOLD_RELEASES}, then start again.`,
        sentence: `${R} refused ${W}: RAPID cannot start while this session holds motion mastership, such as a hold taken with `
          + 'requestMastership(\'motion\') or requestMastershipAll(), which stays until it is released. '
          + `End it with ${MOTION_HOLD_RELEASES}, then start again.`,
        evidence: 'vc',
        ...remedies(remedy.releaseOwnHold(gen)),
      };

    case -1073445845: // EXTERNAL_CLIENT_REJECT
      return {
        kind: 'external-client-motion', condition: 'mastership', grantor: 'current-holder',
        missing: 'motion, which an external client controls',
        fix: 'The external client must release motion.',
        sentence: `${R} refused ${W}: an external client controls motion, so this is not possible now. That client must release motion.`,
        evidence: 'abb',
        ...remedies(remedy.holderReleases(gen, EXTERNAL_CLIENT)),
      };

    case -1073445872: // RESOURCE_ALREADY_HELD
      return {
        kind: 'unknown', condition: accessCondition(gen), grantor: null,
        missing: 'nothing: the controller says this session already holds it',
        fix: 'Nothing to supply; this client counts the lock as held.',
        sentence: `${R} says this session already holds ${lw}.`,
        evidence: 'abb',
        ...remedies(remedy.nothingNeeded(gen, { detail: 'Nothing is missing: the controller says this session already holds it.' })),
      };

    case -1073445860: // MODE_REJECT
      // A program-pointer move from a remote tool in manual mode, refused for
      // the mode. ABB documents these as Auto operations for a remote client:
      // - RobotWare 6, PP to routine: "Controller needs to be in auto mode"
      //   (RWS 1.0 manual, Rev M, rapid_task_pcp_set_to_routine).
      // - RobotWare 7, PP to routine (and by URL): "Allowed operator mode AUTO",
      //   and in manual "allowed for remote clients with RMMP_Exe" (RWS 2.0
      //   site, RAPID service); RMMP modify does not cover it.
      // - RobotWare 7, PP to Main (resetpp): cannot be performed in manual mode.
      // Recorded on RW 7.21.4 in MANR with RMMP modify granted (virtual-controller run 2026-10-12):
      // resetpp and pcp/routine answered 403 -1073445860. Turning the key is not
      // the only advice there.
      // A jog refused for the mode in manual mode on RobotWare 6 or 7: ABB's
      // jog pages require "Login as Local client and get mastership" (RWS 1.0
      // manual Rev M, Perform Jogging; RWS 2.0 Rev L, Motion System). RW 7.21.4
      // answered -1073445860 to a remote jog in MANR with motion mastership,
      // RMMP modify and the motors on (virtual-controller run 2026-10-13); RMMP does not make a
      // remote tool local, and turning the key is not the way.
      if (/^MAN/i.test(mode ?? '') && op?.kind === 'jog' && (gen === 'rw6' || gen === 'rw7')) {
        const fix = 'Jog at the FlexPendant. A remote tool cannot become a local client over RWS on RobotWare 7 (only over the management port), '
          + 'and on RobotWare 6 only by the local login with the enabling device.';
        return {
          kind: 'local-only', condition: 'local-only', grantor: 'pendant-operator',
          missing: `a local client with mastership (the controller is in ${mode})`, fix,
          sentence: `${R} refused to jog in ${mode}: ABB's jog pages require a local client with mastership, and RMMP does not make this tool local. ${fix}`,
          evidence: 'abb',
          ...remedies(remedy.doAtPendant(gen, { detail: JOG_AT_PENDANT })),
        };
      }
      if (/^MAN/i.test(mode ?? '') && /program pointer/.test(op?.label ?? '') && (gen === 'rw6' || gen === 'rw7')) {
        const toMain = op!.label === PP_TO_MAIN;
        // RMMP exec covers only a RobotWare 7 move to a routine (ABB: RMMP_Exe).
        const exec = rmmpLevelFor(op, answer.path, gen) === 'exec';
        let rule: string; let fix: string; let missing: string;
        if (gen === 'rw7' && toMain) {
          rule = "ABB's RobotWare 7 pages say setting the program pointer to Main cannot be performed in manual mode from a remote tool.";
          fix = 'Set it at the FlexPendant, or from this tool in Auto.';
          missing = `Auto mode, or the FlexPendant (the controller is in ${mode})`;
        } else if (gen === 'rw7' && exec) {
          rule = "ABB's RobotWare 7 page allows a remote tool to move the program pointer to a routine in manual mode only with RMMP exec; "
            + 'RMMP modify does not cover it.';
          fix = "Request RMMP exec (requestRmmp('exec'); a session that holds modify gives it back with cancelRmmp() first) and have it granted at the FlexPendant, "
            + 'move the pointer at the FlexPendant, or do it from this tool in Auto.';
          missing = `RMMP exec, the FlexPendant, or Auto mode (the controller is in ${mode})`;
        } else if (gen === 'rw7') {
          rule = "ABB's RobotWare 7 pages document a remote program-pointer move in manual mode only for a move to a routine, with RMMP exec; "
            + 'RMMP does not cover this move.';
          fix = 'Move it at the FlexPendant, or from this tool in Auto.';
          missing = `Auto mode, or the FlexPendant (the controller is in ${mode})`;
        } else {
          rule = toMain
            // ABB's RWS 1.0 PP-to-Main page has no mode note; RW 6.16.03 refused
            // it in MANR with SYS_CTRL_E_MODE_REJECT (2026-10-13).
            ? 'RobotWare 6 refused it for a remote tool in manual mode; ABB\'s RWS 1.0 manual documents program-pointer moves for a remote tool in Auto '
              + '("Controller needs to be in auto mode").'
            : 'RobotWare 6 moves the program pointer for a remote tool in Auto only (ABB RWS 1.0 manual: "Controller needs to be in auto mode").';
          fix = 'Move it at the FlexPendant, or from this tool in Auto.';
          missing = `Auto mode, or the FlexPendant (the controller is in ${mode})`;
        }
        return {
          kind: 'wrong-mode', condition: 'operating-mode', grantor: 'pendant-operator',
          missing, fix,
          sentence: `${R} refused to ${op!.label} in ${mode}. ${rule} ${fix}`,
          evidence: 'abb',
          ...(gen === 'rw7' && exec
            ? remedies(remedy.requestRmmp(gen, 'exec'), remedy.doAtPendant(gen), remedy.mode(gen, 'AUTO'))
            : remedies(remedy.doAtPendant(gen), remedy.mode(gen, 'AUTO'))),
        };
      }
      return {
        kind: 'wrong-mode', condition: 'operating-mode', grantor: 'key-switch',
        missing: `an operating mode that allows it${mode ? ` (the controller is in ${mode})` : ''}`,
        fix: FIX.keySwitch,
        sentence: `${R} refused ${W} in ${mode ?? 'the current operating mode'} for a remote tool. ${FIX.keySwitch}`,
        evidence: 'abb',
        ...remedies(remedy.mode(gen, null)),
      };

    case -1073435895: // NOT_MANUAL_MODE
      return {
        kind: 'wrong-mode', condition: 'operating-mode', grantor: 'key-switch',
        missing: `manual mode${mode ? ` (the controller is in ${mode})` : ''}`,
        fix: FIX.keySwitch,
        sentence: `${R} refused ${W}: it is only valid in manual mode${mode ? `, and the controller is in ${mode}` : ''}. ${FIX.keySwitch}`,
        evidence: 'abb',
        ...remedies(remedy.mode(gen, null)),
      };

    case -1073442809: { // EXEC_STATE
      const known = knownStateDraft(R, W, op, gen, mode, ctx);
      if (known) { return known; }
      return {
        kind: 'wrong-state', condition: 'controller-state', grantor: null,
        missing: 'a controller or execution state that allows it',
        fix: 'Check the motors, the safety state and the program pointer (set PP to Main first), then try again.',
        sentence: `${R} refused ${W} in its current execution state. Causes seen so far: the motors off, a guard stop, `
          + 'or no program pointer (set PP to Main first).',
        evidence: 'vc',
        ...remedies(remedy.checkState(gen, { detail: 'Check the motors, the safety state and the program pointer (set PP to Main first), then run the operation again.' })),
      };
    }

    case -1073445806: { // PERMISSION_CONTROLLER_STATE_REJECT
      if (gen === 'rw8' && op?.kind === 'motors-on') {
        const reset = 'After a safety stop, a mode change or a restart someone must press Reset: the thumb button on the FlexPendant in Auto, '
          + 'or the configured safe input.';
        return {
          kind: 'safety-state', condition: 'safety-state', grantor: 'cell-safety',
          missing: 'a Reset at the controller',
          fix: reset,
          sentence: `${R} refused to switch the motors on. On RobotWare 8 the motors are switched on at the controller. ${reset}`,
          // The code names the controller state; that it always means a
          // pending Reset is inferred from the name and a virtual
          // controller in guard stop.
          evidence: 'unverified',
          ...remedies(remedy.resetSafetyStop('rw8', {
            detail: `Someone at the controller presses Reset. ${reset}`,
            evidence: 'vc',
            basis: 'RobotWare 8 virtual controllers: an 8.1.1 virtual controller refused a remote motors on (403 -1073445806); the Reset at the FlexPendant switched them on',
          })),
        };
      }
      // Live-verified 2026-09-30: a RAPID start with the program pointer set
      // answers 403 with this code on RW 7.21.4 with the motors off, and on
      // RW 8.2.1 in guard stop (which there lasts until someone presses Reset
      // at the controller). Both are states, not grants or remote access, so
      // the state the caller knows names the cause, as for -1073442809.
      const known = knownStateDraft(R, W, op, gen, mode, ctx);
      if (known) { return known; }
      const rw8Reset = gen === 'rw8' || gen === null
        ? ' (on RobotWare 8 the controller stays in guard stop until someone presses Reset at the controller: the thumb button on the FlexPendant in Auto)'
        : '';
      return {
        kind: 'wrong-state', condition: 'controller-state', grantor: null,
        missing: 'a controller state that allows it',
        fix: `Switch the motors on, or have someone at the cell clear the cause of a safety stop and reset it${rw8Reset}, then try again.`,
        sentence: `${R} refused ${W}: it is not allowed in the controller's current state (ABB: "Rejected because not allowed in current controller state"). `
          + `Causes seen so far: the motors off, or a guard stop${rw8Reset}.`,
        evidence: 'abb',
        ...remedies(remedy.checkState(gen, {
          detail: `Check at the controller whether the motors are off or a safety stop needs a reset${rw8Reset}, then run the operation again.`,
        })),
      };
    }

    case -1073435886: // OPERATION_IS_UNLOCKED
      // An unlock of the operating-mode selector while it is not locked
      // answers 403 with this code and "OP-mode is not locked" (RobotWare
      // 8.2.1 virtual controller, 2026-10-17); it was UNKNOWN, "no reason this
      // client can explain", before. Nothing is missing: there is no lock.
      if (/^\/rw\/panel\/opmode(\/unlock\b|\?action=unlock\b)/i.test(answer.path)) {
        return {
          kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool',
          missing: 'a lock on the operating-mode selector (it is not locked)',
          fix: 'Nothing to unlock: the operating-mode selector is already unlocked.',
          sentence: `The operating-mode selector on ${robotOf(ctx)} is not locked, so there is nothing to unlock.`,
          evidence: 'abb',
          ...remedies(remedy.nothingNeeded(gen, { detail: 'Nothing to unlock: the operating-mode selector is already unlocked.' })),
        };
      }
      return {
        kind: 'wrong-state', condition: 'controller-state', grantor: null,
        missing: 'a lock the request expects (the controller says the operation is not locked)',
        fix: 'Read the controller\'s code and message below.',
        sentence: `${R} refused ${W}: the controller says the operation is not locked (ABB: "Operation is not locked").`,
        evidence: 'abb',
        ...remedies(remedy.checkState(gen, { detail: "The controller says the operation is not locked; read its code and message, and check the lock at the controller." })),
      };

    case -1073442803: // RAPID_SYNTAX_ERROR
      // Live-verified 2026-09-30 on RW 7.21.4: a module whose code holds a
      // syntax error loads (loadmod 200), and the program pointer move to one
      // of its routines then answers 400 with this code, "Syntax error",
      // icode -520. It was UNKNOWN with no explanation before.
      return {
        kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool',
        missing: 'a loaded RAPID program without syntax errors',
        fix: 'Correct the RAPID code, load the module again, then try again.',
        sentence: `${R} refused ${W}: the loaded RAPID program has syntax errors (ABB: "Operation not allowed due to syntax error(s)"). `
          + 'A module can load with such an error and be refused only later, at a program pointer move or a start. '
          + 'Correct the RAPID code and load the module again.',
        evidence: 'vc',
        ...remedies(remedy.fixInput(gen, { detail: 'Correct the RAPID code, load the module again, then run the operation again.' })),
      };

    case -1073442802: // RAPID_SEMANTIC_ERROR
      // Live-verified 2026-09-30 on RW 6.16.03, 7.21.4 and 8.2.1: writing a
      // value of the wrong data type to a RAPID symbol (a string to a num
      // array) answers 400 with this code and "org_code: -519" in the
      // message; the symbol keeps its value. On a value write it is the value
      // that is refused, so it is INVALID_ARGUMENT. For anything else ABB's
      // meaning applies: the program has semantic errors.
      if (/^\/rw\/rapid\/symbol/i.test(answer.path) && answer.method.toUpperCase() !== 'GET') {
        return {
          kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
          missing: 'a value of the symbol\'s data type',
          fix: 'Send the value in the RAPID syntax of the symbol\'s data type (a num array as [1,2,3], a string in double quotes).',
          sentence: `${R} refused ${W}: the value does not fit the symbol's data type (ABB: "Operation not allowed due to semantic error(s)"). `
            + 'The symbol keeps its value.',
          evidence: 'vc', code: 'INVALID_ARGUMENT',
          ...remedies(remedy.fixInput(gen, {
            detail: "Send the value in the RAPID syntax of the symbol's data type (a num array as [1,2,3], a string in double quotes).",
          })),
        };
      }
      return {
        kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool',
        missing: 'a loaded RAPID program without semantic errors',
        fix: 'Correct the RAPID code, load the module again, then try again.',
        sentence: `${R} refused ${W}: the loaded RAPID program has semantic errors (ABB: "Operation not allowed due to semantic error(s)"). `
          + 'Correct the RAPID code and load the module again.',
        evidence: 'abb',
        ...remedies(remedy.fixInput(gen, { detail: 'Correct the RAPID code, load the module again, then run the operation again.', evidence: 'abb' })),
      };

    case -1073442812: // NO_PROGRAMNAME
      // Live-verified 2026-10-13 on RW 6.16.03: saving the task's program with
      // no program loaded from a .pgf (only modules) answered 500 with this
      // code, "org_code: -544". RW 7.21 answers the same code with the text
      // "Program name not set". The name is the controller's /rw/retcode one.
      return {
        kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool',
        missing: 'a program name for the task',
        fix: 'Load a program (.pgf) into the task, or give the program a name, then try again.',
        sentence: `${R} refused ${W}: the task's program has no program name (ABB: SYS_CTRL_E_NO_PROGRAMNAME). `
          + 'That is the case when only modules were loaded, not a program. Load a program or name it first.',
        evidence: 'vc',
        ...remedies(remedy.fixInput(gen, { detail: 'Load a program (.pgf) into the task, or give the program a name, then run the operation again.' })),
      };

    case -1073445867: // UAS_REJECT
      return grantMissing(op, gen, ctx, answer);

    case -1073445881: { // REJECT (safety access restriction)
      // A RAPID start refused with the motors off. Live-verified 2026-09-30 on
      // RW 6.16.03: in Auto with the motors off and a valid program pointer,
      // the start answers 400 -1073445881 with "org_code: -4506" in the
      // message (the same start runs once the motors are on; /rw/retcode knows
      // no -4506). RobotWare 7 answers this case -1073442809 (EXEC_STATE).
      // Read as "by design" it hid the real, fixable cause. The motors state
      // the owner knows decides; with none known, org_code -4506 does.
      //
      // The known motors state decides only on RobotWare 6, the one build
      // where this answer is recorded for a start, or with org_code -4506 in
      // the message. RobotWare 8 answers -1073445881 for its access
      // restriction too, and its motors are often off in Auto until someone
      // presses Reset, so there a start refused for access would be read as
      // motors off and the access condition hidden. A RobotWare 8 start
      // refused this way is not recorded yet.
      if (op?.kind === 'start') {
        const s = (ctx.ctrlstate ?? '').toLowerCase();
        const org4506 = /org_code:\s*-4506\b/.test(answer.msg ?? '');
        if (s === 'motoroff' && (gen === 'rw6' || org4506)) {
          return { ...motorsOffDraft(R, W, gen, mode, ''), code: 'WRONG_MODE' };
        }
        if (s === '' && org4506) {
          return {
            ...motorsOffDraft(R, W, gen, mode, 'RobotWare 6 answers a start with the motors off this way (org_code -4506). '),
            code: 'WRONG_MODE',
          };
        }
      }
      if (op?.kind === 'io-write') {
        return {
          kind: 'access-restricted', condition: 'signal-access-level', grantor: 'integrator',
          missing: 'a signal access level that allows this write from a remote tool',
          fix: FIX.integrator,
          sentence: `${R} refused writing signal '${op.signal}' from a remote tool${mode ? ` in ${mode}` : ''} (ABB: "safety access restriction"). `
            + 'A common cause is the signal\'s access level, which the integrator sets in the I/O configuration after a safety review.',
          evidence: 'field',
          ...remedies(remedy.signalAccessLevel(gen)),
        };
      }
      if (op?.kind === 'motors-on' || op?.kind === 'motors') {
        return {
          kind: 'safety-state', condition: 'safety-state', grantor: 'cell-safety',
          missing: 'a reset of the safety stop',
          fix: cellSafety(gen),
          sentence: `${R} refused ${W}: a safety state (guard stop or emergency stop) blocks motors on. ${cellSafety(gen)}`,
          evidence: 'field',
          ...remedies(remedy.resetSafetyStop(gen, { evidence: 'field' })),
        };
      }
      return {
        kind: 'by-design', condition: 'none', grantor: 'nobody',
        missing: 'nothing a remote tool can supply',
        fix: FIX.nobody,
        sentence: `${R} refused ${W} from a remote tool (ABB: "Operation rejected by the controller safety access restriction mechanism"). `
          + 'The refusal names no grant and no mode; by ABB\'s design some operations are not open to remote tools.',
        evidence: 'field',
        ...remedies(remedy.notAvailable(gen, { detail: FIX.nobody, evidence: 'field' })),
      };
    }

    case -1073445863: // DENIED
      if (op?.kind === 'rmmp-request' || op?.kind === 'rmmp') {
        return {
          kind: 'rmmp-denied', condition: 'rmmp', grantor: 'pendant-operator',
          missing: 'the operator\'s grant at the FlexPendant',
          fix: 'Ask the operator at the FlexPendant, then request again; this tool never requests again on its own.',
          sentence: 'The operator at the FlexPendant denied remote access (RMMP) to this tool.',
          evidence: 'unverified',
          ...defaultRemedies('rmmp-denied', gen, 'pendant-operator', 'rmmp', mode),
        };
      }
      return unknownDraft(`${R} denied ${W} ("The request was denied").`, undefined, gen);

    case -1073445870: // NO_SUCH_REQUEST
    case -1073445869: // TIMEOUT
      if (code === -1073445870 || op?.kind === 'rmmp-request' || op?.kind === 'rmmp') {
        return {
          kind: 'rmmp-expired', condition: 'rmmp', grantor: 'pendant-operator',
          missing: 'an answer from the operator at the FlexPendant in time',
          fix: 'Ask the operator to stand by at the FlexPendant, then request again.',
          sentence: 'No remote-access (RMMP) request of this session is active any more: nobody confirmed it on the FlexPendant while this tool was waiting, '
            + 'or it was withdrawn. Ask the operator to stand by, then request again.',
          evidence: 'abb',
          // Asked again only where RMMP covers the refused request (an RMMP
          // call itself, or an operation that needs mastership), at the level
          // that covers it.
          ...((): Remedies => {
            const level = op?.kind === 'rmmp' || op?.kind === 'rmmp-request' ? 'modify' : rmmpLevelFor(op, answer.path, gen);
            return level && rmmpOffered(gen, mode)
              ? remedies(remedy.requestRmmp(gen, level), remedy.doAtPendant(gen))
              : remedies(remedy.doAtPendant(gen));
          })(),
        };
      }
      return unknownDraft(`${R} timed out on ${W} ("Operation/request timed out on controller"). This client does not retry it.`, undefined, gen);

    case -1073445800: // RMMP_E_REJECT
      return {
        kind: 'rmmp-wrong-mode', condition: 'rmmp', grantor: 'key-switch',
        ...(/^MANR$/i.test(mode ?? '')
          // In MANR the mode is right, so the controller's answer points at
          // the enabling device. ABB's return-code text names an enabling
          // device but not whose (the pendant's, a local client's own, or the
          // run chain), so the sentence says what was answered and what was
          // seen, and promises no fix: on RW 7.21.4 (virtual-controller run 2026-10-12) 'exec' was
          // refused both with simEnableSwitch(true) and with the owner holding
          // Enable on the virtual FlexPendant.
          ? {
            missing: 'an enabling device the controller sees as held (the controller is in MANR; ABB does not say whose)',
            fix: 'This client cannot supply it, and no tested way got it granted on a virtual controller. Check at the cell what the controller expects before '
              + 'requesting again; RMMP modify was granted in MANR without it in our runs, if the operation does not need exec.',
            sentence: `${R} refused remote access (RMMP) with "not in manual reduced speed or enabling device released", while it is in MANR. `
              + 'ABB does not say whose enabling device it means. On our virtual controllers neither the virtual controller\'s enable switch nor the '
              + 'virtual FlexPendant\'s Enable got exec granted (2026-10-12).',
          }
          : {
            missing: `manual reduced speed (MANR) with the enabling device held${mode ? ` (the controller is in ${mode})` : ''}`,
            fix: `${FIX.toMANR} In MANR a person holds the enabling device at the FlexPendant.`,
            sentence: `${R} refused remote access (RMMP): it needs manual reduced speed (MANR) with the enabling device held`
              + `${mode ? `, and the controller is in ${mode}` : ''}.`,
          }),
        evidence: 'abb',
        ...(/^MANR$/i.test(mode ?? '')
          ? remedies(
            remedy.checkState(gen, {
              byWhom: 'person-at-pendant',
              detail: 'Check at the cell which enabling device the controller expects held; ABB does not say whose, and no tested way got exec granted on a virtual controller.',
              evidence: 'unverified',
            }),
            remedy.doAtPendant(gen))
          : remedies(remedy.mode(gen, 'MANR', { detail: `${FIX.toMANR} In MANR a person holds the enabling device at the FlexPendant.` }))),
      };

    case -1073435869: // NOT_A_LOCAL_CONTROL_STATION
      // RobotWare 8. The controller's text: "Operation rejected because the
      // request is not from a Local Control Station". RW 8.2.1 answered a
      // registered remote station's disableExternalControl with it
      // (403, "Only supported for Local Control Stations", 2026-10-11).
      return {
        kind: 'local-only', condition: 'local-only', grantor: 'pendant-operator',
        missing: 'a local control station (the FlexPendant)',
        fix: 'Someone at the controller does it at the FlexPendant; a remote control station cannot.',
        sentence: `${R} refused ${W}: only a local control station, the FlexPendant, can do this, and this tool is a remote one. `
          + 'Someone at the controller does it at the FlexPendant.',
        evidence: 'vc',
        ...remedies(remedy.doAtPendant('rw8', { evidence: 'vc' })),
      };

    case -1073435856: // WRONG_LOCAL_PRESENCE_CERTIFICATE_KEY
      // RobotWare 8. The controller's text: "Operation rejected because the
      // provided local presence certificate key is not correct". ABB's
      // RobotWare 8 return-code page gives it "Request not from a Local
      // Control Station"; either way only the controller's own side can do it.
      // The sentence follows the controller's text, so the evidence is `vc`.
      return {
        kind: 'local-only', condition: 'local-only', grantor: 'pendant-operator',
        missing: 'proof of local presence at the controller',
        fix: 'Someone at the controller does it at the FlexPendant; a remote tool cannot.',
        sentence: `${R} refused ${W}: the request did not prove local presence at the controller (the local-presence key is not correct). `
          + 'Someone at the controller does it at the FlexPendant.',
        evidence: 'vc',
        ...remedies(remedy.doAtPendant('rw8', { evidence: 'vc' })),
      };

    case -1073445868: // NO_LOCAL_USER
    case -1073445875: // LOCAL_NOT_ALLOWED
    case -1073445810: // TOO_MANY_LOCAL_CLIENTS
      return {
        kind: 'local-only', condition: 'local-only', grantor: 'pendant-operator',
        missing: 'a person at the controller',
        fix: 'Someone at the controller does it at the FlexPendant; a remote tool cannot.',
        sentence: `Only someone at the controller (the FlexPendant, or a device with local presence) can ${op ? op.label : 'do this'}. `
          + 'It cannot be done from this tool.',
        evidence: 'abb',
        ...remedies(remedy.doAtPendant(gen)),
      };

    case -1073445873: // NOT_LOGGED_ON
      return {
        kind: 'unknown', condition: 'session', grantor: 'this-tool',
        missing: 'a logged-on controller session',
        fix: 'Connect again.',
        sentence: `${R} says this client is not logged on: the controller session ended. Connect again.`,
        evidence: 'unverified',
        ...remedies(remedy.reconnect(gen)),
      };

    case -1073445827: { // INVALID_GRANT
      const grant = answer.path.match(/[?&]grant=([^&]+)/i)?.[1];
      return {
        kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
        missing: 'a grant name this controller defines',
        fix: 'Use a grant identifier this RobotWare generation defines (they differ between RobotWare 6 and 7).',
        sentence: `The grant name${grant ? ` '${decodeURIComponent(grant)}'` : ''} is not defined on ${robotOf(ctx)} `
          + '(grant names differ between RobotWare 6 and 7).',
        evidence: 'vc',
        ...remedies(remedy.fixInput(gen, { detail: 'Use a grant identifier this RobotWare generation defines; they differ between RobotWare 6 and 7.' })),
      };
    }

    case -1073445813: // IMPERSONATE
      return {
        kind: 'by-design', condition: 'none', grantor: 'nobody',
        missing: 'nothing a remote tool can supply',
        fix: FIX.nobody,
        sentence: `${R} refused to act as another user.`,
        evidence: 'abb',
        ...remedies(remedy.notAvailable(gen, { detail: FIX.nobody, evidence: 'abb' })),
      };

    case -1073435874: // CONTROL_STATION_ALREADY_REGISTERED
      return {
        kind: 'by-design', condition: 'control-station', grantor: 'this-tool',
        missing: 'nothing: this session is already registered',
        fix: 'Register once per session; to register another identity, log in again (a new session).',
        sentence: `${R} refused ${W}: this session is already registered as a control station. The controller takes one registration per session `
          + 'and keeps the first; to register another identity, log in again.',
        evidence: 'vc',
        ...remedies(remedy.reconnect('rw8', {
          detail: 'To register another identity, connect again (a new session); the controller keeps the first registration of a session.',
          evidence: 'vc',
        })),
      };

    case -1073435867: // INVALID_CONTROL_STATION_ID
      if (op?.kind === 'register') {
        return {
          kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
          missing: 'a control-station id the controller accepts',
          // RW 8.2.1 checks only the length: any 38-character id registers and
          // other lengths answer this code (live-verified 2026-09-29).
          fix: 'Configure a braced GUID of the form {8-4-4-4-12} (38 characters) as the control-station id.',
          sentence: `${R} did not accept the control-station id: the controller takes an id of exactly 38 characters, such as a braced GUID of the form {8-4-4-4-12}. Fix the configured control-station id.`,
          evidence: 'vc',
          ...remedies(remedy.fixInput('rw8', { detail: 'Configure a braced GUID of the form {8-4-4-4-12} (38 characters) as the control-station identity.' })),
        };
      }
      // ABB's RWS pages and the RW 8.1.1 dictionary name this number
      // differently, so outside a registration no cause is claimed.
      return unknownDraft(`${R} refused ${W} with a control-station code ABB's documents name two ways (an invalid station id, or a request not from a remote control station).`, 'UNKNOWN', gen);

    case -1073445879: // INVALIDARG
      if (op?.kind === 'register') {
        return {
          kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
          missing: 'a control-station PIN the controller accepts',
          fix: 'Configure a PIN of digits only, at most 11 of them.',
          sentence: `${R} did not accept the registration: the control-station PIN is missing, not numeric or too long.`,
          evidence: 'vc',
          ...remedies(remedy.fixInput(gen, { detail: 'Configure a control-station PIN of digits only, at most 11 of them.' })),
        };
      }
      return {
        kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
        missing: 'a value the controller accepts',
        fix: 'Check the values sent with the request.',
        sentence: `${R} rejected an argument of ${op ? `the request ${W}` : 'this request'}.`,
        evidence: 'abb',
        ...remedies(remedy.fixInput(gen, { evidence: 'abb' })),
      };

    case -1073436654: // POSE_OUTSIDE_REACH
      // Inverse kinematics on a pose the robot cannot reach. Live-verified
      // 2026-09-30 on RW 6.16.03: HTTP 400, "Position outside of reach"; it
      // was UNKNOWN with no refusal before.
      return {
        kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
        missing: 'a position inside the robot\'s reach',
        fix: 'Use a position the robot can reach.',
        sentence: `${R} refused ${W}: the position is outside the robot's reach.`,
        evidence: 'vc',
        ...remedies(remedy.fixInput(gen, { detail: 'Use a position the robot can reach, then run the operation again.' })),
      };

    case -1073445885: { // SERVICE_NOT_SUPPORTED
      const rmmp = op?.kind === 'rmmp' || op?.kind === 'rmmp-request';
      return {
        kind: 'unsupported', condition: 'none', grantor: 'nobody',
        missing: 'a RobotWare version that offers this service',
        fix: rmmp
          ? 'On RobotWare 8 an operator allows Remote Access on the FlexPendant, and this tool requests write access instead.'
          : 'None: this RobotWare version does not offer it.',
        sentence: rmmp
          ? rmmpUnsupportedSentence(ctx)
          : `${R} says this service is not supported in its RobotWare version${ctx.rwVersion ? ` (${ctx.rwVersion})` : ''}.`,
        evidence: 'vc',
        ...remedies(rmmp ? rmmpNotOnRw8(gen) : remedy.notAvailable(gen, { detail: 'This RobotWare version does not offer the service.' })),
      };
    }

    default:
      return null;
  }
}

/**
 * The verb of a configuration-file request: RWS 2.0 `POST /rw/cfg/load` and
 * `/rw/cfg/validate`, RWS 1.0 `POST /rw/cfg?action=load` and
 * `?action=validate`; null for any other request.
 */
function cfgFileVerb(path: string): 'load' | 'validate' | null {
  const m = /^\/rw\/cfg\/(load|validate)(?:\?|$)/i.exec(path) ?? /^\/rw\/cfg\?(?:.*&)?action=(load|validate)(?:&|$)/i.exec(path);
  return m ? (m[1].toLowerCase() as 'load' | 'validate') : null;
}

/**
 * The sentence added when the message carries RobotWare 6's wrapper
 * `new_code: 0xc0048410`, which names a held resource (-1073445872) although
 * the controller's code says what was refused.
 */
function heldWrapperNote(msg: string | null): string {
  return /new_code:\s*0xc0048410\b/i.test(msg ?? '')
    ? ' The new_code 0xC0048410 in the message names a held resource; RobotWare 6 puts it in this answer, and it is not the cause.'
    : '';
}

/** The basis of the remedies below: where the codes were seen. */
const CFG_LOAD_SEEN = 'retcodes -1073437689 and -1073437688 on loads with add of a domain the same controller had saved '
  + '(RobotWare 6.16.03, 7.21.4 and 8.2.1 virtual controllers); the remedy itself has not been tried';

/** Where the version-header answer was seen, and that a file with a header passed. */
const CFG_VERSION_SEEN = 'retcode -1073437686 on validations of a file with no version header, where a file starting '
  + 'EIO:CFG_1.0:6:1:: (RobotWare 6.16.03) or EIO:CFG_1.0:7:0:: (7.21.4, 8.2.1) passed (virtual controllers, 2026-10-24)';

/**
 * A header the controllers of that generation took in the same runs, as an
 * example in the remedy; none when the generation is not known.
 */
function cfgHeaderExample(gen: Gen | null): string {
  if (gen === 'rw6') { return ' (a RobotWare 6 EIO file starts EIO:CFG_1.0:6:1::)'; }
  if (gen === 'rw7' || gen === 'rw8') { return ' (an EIO file starts EIO:CFG_1.0:7:0::, which RobotWare 7.21.4 and 8.2.1 took)'; }
  return '';
}

/**
 * A configuration code of CFG_REFUSAL_CODES as a refusal of what was sent.
 * No code names the instance or the line, so the sentence does not either.
 */
function cfgDraftFor(code: number, R: string, W: string, gen: Gen | null, answer: ControllerAnswer): Draft {
  const verb = cfgFileVerb(answer.path);
  const wrapper = heldWrapperNote(answer.msg);
  if (code === -1073437686) { // CFG_VERSION
    if (verb) {
      const fix = `Check the file's first line, its version header: it names the domain and the format version${cfgHeaderExample(gen)}.`;
      return {
        kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
        missing: 'a configuration file with a well-formed version header',
        fix,
        sentence: `${R} refused to ${verb} the configuration file: the file's version header is malformed `
          + `(ABB: "Invalid cfg domain version or invalid layout of version string.").${wrapper}`,
        evidence: 'vc', code: 'INVALID_ARGUMENT',
        ...remedies(remedy.fixInput(gen, { detail: `${fix} Then ${verb} it again.`, evidence: 'vc', basis: CFG_VERSION_SEEN })),
      };
    }
    return {
      kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
      missing: 'configuration data the controller accepts',
      fix: 'Check the configuration data sent.',
      sentence: `${R} refused ${W}: it says a configuration version or the layout of a version string is wrong `
        + `(ABB: "Invalid cfg domain version or invalid layout of version string.").${wrapper}`,
      evidence: 'abb', code: 'INVALID_ARGUMENT',
      ...remedies(remedy.fixInput(gen, {
        detail: 'Check the configuration data sent, then run the operation again.', evidence: 'abb',
        basis: 'ABB return codes: retcode -1073437686 SYS_CTRL_E_CFG_VERSION',
      })),
    };
  }
  if (code === -1073437689) { // CFG_NAME_EXIST
    if (verb) {
      const fix = 'Load a file that holds only instances the controller does not have yet, or remove the existing instance first, then load again.';
      return {
        kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
        missing: 'a file whose named instances are not on the controller yet',
        fix,
        sentence: `${R} refused to ${verb} the configuration file: a named instance in the file already exists on the controller `
          + '(ABB: "Name already exists in database (for named instances)"). The controller does not say which one. '
          + `A domain saved from this controller holds every instance of that domain, so loading it back with add is refused.${wrapper}`,
        evidence: 'vc', code: 'INVALID_ARGUMENT',
        ...remedies(remedy.fixInput(gen, { detail: fix, evidence: 'unverified', basis: CFG_LOAD_SEEN })),
      };
    }
    const fix = 'Use a name no instance of that type has, or change the existing instance instead.';
    return {
      kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
      missing: 'an instance name not in use',
      fix,
      sentence: `${R} refused ${W}: an instance of that name already exists (ABB: "Name already exists in database (for named instances)"). ${fix}${wrapper}`,
      evidence: 'abb', code: 'INVALID_ARGUMENT',
      ...remedies(remedy.fixInput(gen, {
        detail: `${fix} Then run the operation again.`, evidence: 'abb', basis: 'ABB return codes: retcode -1073437689 SYS_CTRL_E_CFG_NAME_EXIST',
      })),
    };
  }
  // -1073437688 CFG_DATA_INCORRECT
  if (verb) {
    // Seen only on RobotWare 6.16.03, for a saved EIO domain loaded back with
    // add, where RobotWare 7.21.4 and 8.2.1 answered -1073437689 for the same
    // kind of file. That is said where the generation can be RobotWare 6.
    const rw6 = gen === 'rw6' || gen === null
      ? ' On RobotWare 6.16.03 a domain saved from the same controller and loaded back with add got this answer, '
        + 'where RobotWare 7.21.4 and 8.2.1 answered that a named instance already exists.'
      : '';
    const fix = 'Check the file. If it is a domain saved from this controller, load a file that holds only instances the controller does not have yet.';
    return {
      kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
      missing: 'a configuration file the controller accepts',
      fix,
      sentence: `${R} refused to ${verb} the configuration file: it says the file contains errors (ABB: "Cfg file contains errors."), `
        + `and does not say which line.${rw6}${wrapper}`,
      evidence: 'vc', code: 'INVALID_ARGUMENT',
      ...remedies(remedy.fixInput(gen, {
        detail: `${fix} Then load it again.`, evidence: 'unverified', basis: CFG_LOAD_SEEN,
      })),
    };
  }
  return {
    kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool',
    missing: 'configuration data the controller accepts',
    fix: 'Check the configuration data sent.',
    sentence: `${R} refused ${W}: it says the configuration data contains errors (ABB: "Cfg file contains errors.").${wrapper}`,
    evidence: 'abb', code: 'INVALID_ARGUMENT',
    ...remedies(remedy.fixInput(gen, {
      detail: 'Check the configuration data sent, then run the operation again.', evidence: 'abb',
      basis: 'ABB return codes: retcode -1073437688 SYS_CTRL_E_CFG_DATA_INCORRECT',
    })),
  };
}

/**
 * Explain one controller answer. Returns null when the answer is not a
 * refusal this client explains (a missing resource, a module that is not
 * loaded); the caller then keeps its own message.
 *
 * Order: a 410 Gone; SYS_CTRL_E_FAIL unwrapped to its inner code; a missing
 * option (`icode -7301`, "Option is missing"); a platform restriction ("not
 * supported on the current platform"); RobotWare 8's refusal of write access
 * while a change of operating mode waits for the FlexPendant (only with the
 * mode known to the caller); a known code; any other 403 (`unknown`, with the
 * controller's text and never RMMP or grant advice).
 */
export function refusalFor(
  answer: ControllerAnswer, context: RefusalContext = {}, opts: { lost?: string } = {},
): { code: RwsErrorCode; refusal: RwsRefusal; message: string } | null {
  const op = operationOf(answer.method, answer.path, answer.motors ?? null);
  const outer = answer.code;
  const inner = outer === SYS_CTRL_E_FAIL ? innerCodeOf(answer.msg) : null;
  const code = inner ?? outer;
  const gen = genOf(code, context);
  const ctx: RefusalContext = { ...context, generation: gen };
  const R = cap(robotOf(ctx));
  const W = whatOf(op);

  let draft: Draft | null = null;
  let rws: RwsErrorCode | null = null;

  if (answer.http === 410) {
    rws = 'UNSUPPORTED_OPERATION';
    const rmmp = op?.kind === 'rmmp' || op?.kind === 'rmmp-request';
    draft = {
      kind: 'unsupported', condition: 'none', grantor: 'nobody',
      missing: 'a RobotWare version that offers it',
      fix: rmmp || op?.kind === 'mastership' || op?.kind === 'mastership-request'
        ? 'On RobotWare 8 an operator allows Remote Access on the FlexPendant, and this tool requests control-station write access instead.'
        : 'None: this RobotWare version does not offer it.',
      sentence: rmmp
        ? rmmpUnsupportedSentence(ctx)
        : op?.kind === 'mastership' || op?.kind === 'mastership-request'
          ? `${R} has no mastership service (HTTP 410 Gone): RobotWare 8 replaced mastership with control-station write access.`
          : `${R} no longer offers this resource (HTTP 410 Gone).`,
      evidence: 'vc',
      ...remedies(rmmp ? rmmpNotOnRw8(gen)
        : op?.kind === 'mastership' || op?.kind === 'mastership-request'
          ? remedy.notAvailable(gen, { detail: 'RobotWare 8 has no mastership service; this tool takes control-station write access instead, after an operator allows Remote Access at the FlexPendant.' })
          : remedy.notAvailable(gen, { detail: 'This RobotWare version no longer offers the resource.' })),
    };
  } else if (/icode:\s*-7301\b|option is missing/i.test(answer.msg ?? '')) {
    rws = 'UNSUPPORTED_OPERATION';
    draft = {
      kind: 'option-missing', condition: 'option', grantor: 'abb-option',
      missing: 'a RobotWare option this controller does not have',
      fix: FIX.option,
      sentence: `${R} refused ${W}: it needs a RobotWare option this controller does not have. That is a purchase or licence decision, not a setting.`,
      evidence: 'vc',
      ...remedies(remedy.optionMissing(gen)),
    };
  } else if (/\bis not opted\b/i.test(answer.msg ?? '')) {
    // Live-verified 2026-10-13 on RW 6.16.03: non-motion execution, set on or
    // off, answered 403 with code -1 and "Collision Detection is not opted
    // during system setup". The controller names the option; it is kept.
    rws = 'UNSUPPORTED_OPERATION';
    const option = /([A-Za-z][\w -]*?)\s+is not opted\b/i.exec(answer.msg ?? '')?.[1]?.trim();
    const named = option ? `the RobotWare option ${option}` : 'a RobotWare option this controller does not have';
    draft = {
      kind: 'option-missing', condition: 'option', grantor: 'abb-option',
      missing: named,
      fix: FIX.option,
      sentence: `${R} refused ${W}: it needs ${named}, which was not selected when the system was set up (controller: "${(answer.msg ?? '').replace(/\s*code:.*$/i, '').trim()}"). `
        + 'That is a purchase or licence decision, not a setting.',
      evidence: 'vc',
      ...remedies(remedy.optionMissing(gen)),
    };
  } else if (/not supported on the current platform/i.test(answer.msg ?? '')) {
    rws = 'UNSUPPORTED_OPERATION';
    const v = ctx.virtual;
    draft = {
      kind: v === true ? 'rc-only' : v === false ? 'vc-only' : 'unsupported', condition: 'platform', grantor: 'nobody',
      missing: v === true ? 'a real controller' : v === false ? 'a virtual controller' : 'a controller platform that offers it',
      fix: 'None on this controller: the function exists only on the other kind of controller (real or virtual).',
      sentence: v === true
        ? `${R} refused ${W}: it is available only on real controllers, and this is a virtual controller.`
        : v === false
          ? `${R} refused ${W}: it is available only on virtual controllers, and this is a real controller.`
          : `${R} refused ${W}: the controller says it is not supported on its platform (some functions exist only on real controllers, others only on virtual controllers).`,
      evidence: 'vc',
      ...remedies(remedy.notAvailable(gen, {
        detail: v === true ? 'It exists only on real controllers; this is a virtual controller.'
          : v === false ? 'It exists only on virtual controllers; this is a real controller.'
            : 'It exists only on the other kind of controller, real or virtual.',
      })),
    };
  } else if (code === WRITE_ACCESS_REFUSED_IN_MODE_CHANGE && op?.kind === 'writeaccess-request' && isPendingModeChange(modeOf(ctx))) {
    rws = 'WRONG_MODE';
    draft = modeChangePendingDraft(R, W, modeOf(ctx)!);
  } else if (code !== null && REFUSAL_CODES.has(code)) {
    draft = draftFor(code, op, gen, ctx, answer, opts.lost);
    rws = draft?.code ?? REFUSAL_CODES.get(code)!.code;
  } else if (code !== null && CFG_REFUSAL_CODES.has(code)) {
    draft = cfgDraftFor(code, R, W, gen, answer);
    rws = draft.code ?? CFG_REFUSAL_CODES.get(code)!.code;
  }
  if (!draft && answer.http === 403) {
    rws = 'UNKNOWN';
    draft = unknownDraft(`${R} refused ${W} and gave no reason this client can explain.`, undefined, gen);
  }
  if (!draft || !rws) { return null; }

  const known = code !== null ? explainedCode(code) : undefined;
  const outerKnown = outer !== null ? explainedCode(outer) : undefined;
  const controller: RefusalController = {
    request: `${answer.method.toUpperCase()} ${answer.path.split('?')[0]}`,
    http: answer.http,
    ...(outer !== null ? { code: outer, hex: hexCode(outer) } : {}),
    ...(outer === SYS_CTRL_E_FAIL ? { name: 'SYS_CTRL_E_FAIL' } : outerKnown ? { name: outerKnown.name } : {}),
    ...(icodeOf(answer.msg) !== undefined ? { icode: icodeOf(answer.msg) } : {}),
    ...(answer.msg ? { message: answer.msg } : {}),
  };
  const refusal: RwsRefusal = {
    kind: draft.kind,
    condition: draft.condition,
    generation: gen,
    missing: draft.missing,
    grantor: draft.grantor,
    fix: draft.fix,
    sentence: draft.sentence,
    ...(draft.grants ? { grants: draft.grants } : {}),
    ...(draft.holder ? { holder: markPendant(draft.holder) } : {}),
    ...(draft.user ? { user: draft.user } : {}),
    controller,
    evidence: draft.evidence,
    ...stampRemedies(
      draft.remedy ? { remedy: draft.remedy, ...(draft.otherRemedies ? { otherRemedies: draft.otherRemedies } : {}) }
        : defaultRemedies(draft.kind, gen, draft.grantor, draft.condition, modeOf(ctx)),
      gen, controller.request),
  };
  origins.set(refusal, { answer, context, ...(opts.lost !== undefined ? { lost: opts.lost } : {}) });
  const innerNote = inner !== null && known ? `, inner code ${inner} (${hexCode(inner)}, ${known.name})` : '';
  return { code: rws, refusal, message: `${draft.sentence} ${controllerLine(controller, innerNote)}` };
}

/**
 * The controller detail every refusal message ends with. It keeps the
 * "HTTP <status> from <METHOD> <path>" phrase earlier messages carried, which
 * callers match on.
 */
function controllerLine(c: RefusalController, innerNote = ''): string {
  let s = `Controller: HTTP ${c.http} from ${c.request}`;
  if (c.code !== undefined) { s += `, code ${c.code} (${c.hex}${c.name ? `, ${c.name}` : ''})${innerNote}`; }
  if (c.message) { s += `: ${c.message}`; }
  return /[.!?)]$/.test(s) ? s : `${s}.`;
}

/**
 * Refine a refusal with what the caller knows: the operating mode, the
 * controller state, this session's RMMP, the holder it read, the controller's
 * name and the user. Returns a new `RwsError` whose `refusal` and message
 * reflect it, with the same code, HTTP status and controller answer; an
 * error without a refusal is returned as it is. For a refusal this client
 * built without a controller answer (a pre-flight check), only a holder is
 * added.
 *
 * Context only sharpens the explanation; it never changes what was refused,
 * and the controller's code is kept.
 */
export function explainRefusal(err: RwsError, context: RefusalContext): RwsError {
  const r = err.refusal;
  if (!r) { return err; }
  const origin = origins.get(r);
  if (!origin) {
    if (!context.holder || r.holder) { return err; }
    const refusal: RwsRefusal = { ...r, holder: markPendant(context.holder) };
    return new RwsError(err.message, err.code, err.httpStatus, err.rwsDetail, err.controllerCode, err.controllerMsg, refusal);
  }
  const merged: RefusalContext = { ...origin.context };
  for (const [k, v] of Object.entries(context) as Array<[keyof RefusalContext, unknown]>) {
    if (v !== undefined && v !== null) { (merged as Record<string, unknown>)[k] = v; }
  }
  const out = refusalFor(origin.answer, merged, origin.lost !== undefined ? { lost: origin.lost } : {});
  if (!out) { return err; }
  return new RwsError(out.message, err.code, err.httpStatus, err.rwsDetail, err.controllerCode, err.controllerMsg, out.refusal);
}

/**
 * The refusal of a write refused as "not held" while this session counted a
 * hold on the lock: the hold was lost during the operation. `detail` says how
 * the loss showed, when known. An error without a controller answer is
 * returned as it is.
 */
export function asLostRefusal(err: unknown, detail = ''): unknown {
  if (!(err instanceof RwsError) || !err.refusal) { return err; }
  const origin = origins.get(err.refusal);
  if (!origin) { return err; }
  const out = refusalFor(origin.answer, origin.context, { lost: detail });
  if (!out) { return err; }
  return new RwsError(out.message, err.code, err.httpStatus, err.rwsDetail, err.controllerCode, err.controllerMsg, out.refusal);
}

/**
 * `e` with `report` in front of its message, and in front of its refusal's
 * sentence when it has one: for a step that failed in the middle of an
 * operation of several steps, where `report` says what the operation had
 * already done. The code, the HTTP status and the controller's answer are
 * kept. Anything that is not an `RwsError` becomes `UNKNOWN` with its message.
 */
export function withReport(e: unknown, report: string): RwsError {
  if (!(e instanceof RwsError)) {
    return new RwsError(`${report} ${e instanceof Error ? e.message : String(e)}`, 'UNKNOWN');
  }
  const refusal = e.refusal ? { ...e.refusal, sentence: `${report} ${e.refusal.sentence}` } : undefined;
  return new RwsError(`${report} ${e.message}`, e.code, e.httpStatus, e.rwsDetail, e.controllerCode, e.controllerMsg, refusal);
}

/**
 * A controller's 400 to a request that carried an input outside the values
 * ABB documents for it: `note`, which names those values, goes in front of
 * the message and of the refusal's sentence (`withReport`), and a refusal's
 * next step becomes correcting the input, with `note` as its detail; its
 * other steps stay among the others. The controller decided; this only
 * explains, and the code, the HTTP status and the controller's answer are
 * kept. Anything that is not such a 400 is returned as it is.
 */
export function withInputNote(e: unknown, note: string): unknown {
  if (!(e instanceof RwsError) || e.httpStatus !== 400) { return e; }
  const out = withReport(e, note);
  const r = out.refusal;
  if (!r) { return out; }
  const before = [...(r.remedy ? [r.remedy] : []), ...(r.otherRemedies ?? [])].filter(x => x.kind !== 'fix-input');
  const stamped = stampRemedies(remedies(remedy.fixInput(r.generation, { detail: note }), ...before), r.generation, r.controller.request);
  const refusal: RwsRefusal = { ...r, remedy: stamped.remedy, ...(stamped.otherRemedies ? { otherRemedies: stamped.otherRemedies } : {}) };
  return new RwsError(out.message, out.code, out.httpStatus, out.rwsDetail, out.controllerCode, out.controllerMsg, refusal);
}

/**
 * A refusal this client decides itself, before sending (a pre-flight check),
 * or about a hold it tracks. `sentence` defaults to the error message.
 * `remedy` and `otherRemedies`, when absent, are filled from the kind,
 * generation, grantor and condition (`defaultRemedies`), so every built
 * refusal carries a next step.
 */
export function builtRefusal(init: {
  kind: RefusalKind;
  condition: RefusalCondition;
  generation: Gen | null;
  missing: string;
  grantor: RefusalGrantor | null;
  fix: string;
  sentence: string;
  evidence: Evidence;
  grants?: RefusalGrant[];
  holder?: RefusalHolder;
  remedy?: RefusalRemedy;
  otherRemedies?: RefusalRemedy[];
}): RwsRefusal {
  const { remedy: given, otherRemedies, ...rest } = init;
  const r = given
    ? { remedy: given, ...(otherRemedies ? { otherRemedies } : {}) }
    : defaultRemedies(init.kind, init.generation, init.grantor, init.condition);
  return { ...rest, controller: {}, ...stampRemedies(r, init.generation, undefined) };
}

/** An `RwsError` carrying a refusal this client decided itself; its message is the refusal's sentence. */
export function refusalError(code: RwsErrorCode, init: Parameters<typeof builtRefusal>[0]): RwsError {
  return new RwsError(init.sentence, code, undefined, undefined, undefined, undefined, builtRefusal(init));
}
