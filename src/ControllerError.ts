/**
 * Controller-level error taxonomy: parse RWS error-response bodies and turn
 * HTTP-status-shaped failures into actionable, controller-aware error codes.
 *
 * Both generations share one code space. Access refusals (mastership, write
 * access, RMMP, UAS grants, modes, controller state, local presence) are
 * explained in plain words by `refusalFor` (refusal.ts) and carry an
 * `RwsError.refusal`. The rest are the "the thing you named is not there"
 * family, mapped below. Payloads captured live from RW 6.16, 7.21 and 8.1.1
 * virtual controllers are in tests/fixtures/errors/.
 *
 * Codes worth knowing by heart (ABB's return-code list names in brackets):
 *   -1073445862  held by someone else           [SYS_CTRL_E_RESOURCE_HELD]
 *   -1073445859  mastership not held            [SYS_CTRL_E_MASTER_REJECT]
 *   -1073445867  not allowed for this user      [SYS_CTRL_E_UAS_REJECT]
 *   -1073445881  rejected by the controller's safety access restriction
 *                mechanism                      [SYS_CTRL_E_REJECT]
 *   -1073414146  "Unspecified error": RobotWare 6's generic outer code; the
 *                cause, when there is one, is an inner `code:` in the message
 *                                               [SYS_CTRL_E_FAIL]
 *   -1073445866  invalid I/O signal name / wrong URI
 *   -1073438713  path does not exist (fileservice)
 *   -1073442813  module name/parameter is invalid or missing
 *   -1073442809  illegal in the current execution state [SYS_CTRL_E_EXEC_STATE]
 *   -1073445865  too much data for one request  [SYS_CTRL_E_BUFFER_OVERFLOW]
 *   -1073438712  the directory already exists   [SYS_CTRL_E_DIR_EXIST]
 *   -1073437689  a named instance already exists; a configuration load
 *                with add of a saved domain answers it [SYS_CTRL_E_CFG_NAME_EXIST]
 *   -1073437688  the configuration file contains errors
 *                                               [SYS_CTRL_E_CFG_DATA_INCORRECT]
 *   -1073437686  the configuration file's version header is malformed
 *                                               [SYS_CTRL_E_CFG_VERSION]
 *                All three are refusals of what was sent (INVALID_ARGUMENT,
 *                with a refusal from refusalFor; CFG_REFUSAL_CODES in
 *                refusal.ts).
 */

import type { RwsErrorCode, RwsRefusal, RefusalContext } from './types.js';
import { motorsOfBody, refusalFor, SYS_CTRL_E_FAIL } from './refusal.js';

export interface ControllerErrorInfo {
  /** Classified error code - never plain AUTH_FAILED for a body-carrying 403. */
  code: RwsErrorCode;
  controllerCode: number | null;
  controllerMsg: string | null;
  /** Actionable human-readable message naming the failed request. */
  message: string;
  /** For an access refusal: the refusal in plain words. */
  refusal?: RwsRefusal;
}

/**
 * Extract the controller status block from an error body. Handles all three
 * wire shapes: RWS 1.0 `?json=1` (`_embedded.status`), RWS 2.0 hal+json
 * (top-level `status`), and the XHTML `<div class="status">` form both
 * generations emit.
 */
export function parseControllerStatus(body: string): { code: number | null; msg: string | null } {
  if (!body) { return { code: null, msg: null }; }

  // JSON shapes first
  try {
    const obj = JSON.parse(body) as {
      status?: { code?: number; msg?: string };
      _embedded?: { status?: { code?: number; msg?: string } };
    };
    const status = obj.status ?? obj._embedded?.status;
    if (status && typeof status.code === 'number') {
      return { code: status.code, msg: cleanMsg(status.msg ?? null) };
    }
  } catch { /* not JSON - try XHTML */ }

  // XHTML status div
  const codeMatch = body.match(/<span[^>]*class="code"[^>]*>\s*(-?\d+)\s*<\/span>/i);
  const msgMatch = body.match(/<span[^>]*class="msg"[^>]*>([\s\S]*?)<\/span>/i);
  if (codeMatch) {
    return { code: Number(codeMatch[1]), msg: cleanMsg(msgMatch?.[1] ?? null) };
  }
  return { code: null, msg: null };
}

/** Strip controller build-path noise (C:\BUILDAGENTS\...cpp[123]) from messages. */
function cleanMsg(msg: string | null): string | null {
  if (!msg) { return null; }
  // Drop every "<path>.cpp[123]" prefix segment (they can be chained) and
  // collapse whitespace; keep the human tail with the code annotations.
  const cleaned = msg
    .replace(/[A-Za-z]:\\[^\s]*\.cpp\[\d+\][:\s]*/g, '')
    .replace(/[a-z_0-9]+\.cpp\[\d+\][:\s]*/gi, '')
    .replace(/ERROR:\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** -1073445865: the request or its answer is too large for one RWS request. */
export const SYS_CTRL_E_BUFFER_OVERFLOW = -1073445865;

/** -1073438712: a directory of that name already exists (ABB: "The directory already exist."). */
export const SYS_CTRL_E_DIR_EXIST = -1073438712;

/**
 * Controller codes that are not access refusals → taxonomy. Shared across
 * RWS 1.0 and 2.0. A code that is neither here nor a refusal falls back on
 * HTTP semantics, which for a 400 means `UNKNOWN`.
 */
const CODE_MAP: ReadonlyArray<{ codes: number[]; rws: RwsErrorCode }> = [
  { codes: [-1073442813],              rws: 'MODULE_NOT_FOUND' },
  // Everything below means "the thing you named is not there". Notes on the
  // ones that are not obvious:
  //   -1073414146  SYS_CTRL_E_FAIL, "Unspecified error": only on a 404 or a
  //                400 without an inner access code (RobotWare 6 reports a
  //                missing file, module or symbol this way). Never for a 403.
  //   -1073438716  "Virtual root does not exist" - RWS 2.0 answer for a bad
  //                volume in a file path, on 400. RWS 1.0 answers the same
  //                condition 404 with -1073414146, so listDirectory on a bad
  //                volume reported RESOURCE_NOT_FOUND on RW6 but UNKNOWN on
  //                RW7/RW8 until this was mapped.
  //   -1073438708  RW6 loadModule with a path that does not exist. The
  //                controller sends no human-readable text, only the code.
  //   -1073442816  SYS_CTRL_E_NO_SUCH_SYMBOL, "RAPID symbol was not found":
  //                one meaning in ABB's return-code dictionary (/rw/retcode
  //                on RW6, RW7 and RW8). A module name and a routine are RAPID
  //                symbols too, so requests that name a module, routine or
  //                data symbol that is not there can answer this code, each
  //                with its own wording and HTTP status. Live-verified
  //                2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1: unloading a
  //                module that is not loaded, 400 "Unknown module name" (all
  //                three); an RWS 2.0 read of a missing data symbol, 404
  //                "Symbol not found"; an RW6 write to a missing symbol, 404
  //                with only an untranslated "org_code: -517". Not every such
  //                request does: RW6 answers a read of a missing data symbol
  //                400, and RW7/RW8 a properties read of one 404, both with
  //                -1073414146 (see above). The code does not say which kind
  //                of symbol was missing, so it lands on the general meaning
  //                and the path or message promotes it where they name a
  //                module.
  { codes: [SYS_CTRL_E_FAIL, -1073445866, -1073438713, -1073438716, -1073438708,
            -1073445883, -1073442816],
    rws: 'RESOURCE_NOT_FOUND' },
  // -1073445865 SYS_CTRL_E_BUFFER_OVERFLOW, "The amount of data is to large to
  // fulfill the request". Live-verified 2026-09-29 on RW 7.21.4 and RW 8.2.1:
  // a RAPID value write of 7900 num elements answers 500 with this code
  // (7800 answers 204); on RW 7.21.4 an array read over its ceiling answers
  // 200 with no value and an error link to it (see getRapidVariable). The
  // value is too large for one RWS request, which the caller can change by
  // sending less. It was unmapped (UNKNOWN) before.
  //
  // -1073438712 SYS_CTRL_E_DIR_EXIST, "The directory already exist": a
  // directory create whose name is taken. Live-verified 2026-09-30: RW 7.21.4
  // and 8.2.1 answer 409 ("Given directory name directory is already exist"),
  // RW 6.16.03 answers the same code with 400. The name the caller gave is
  // refused, and nothing was changed on the controller; it was unmapped
  // (UNKNOWN) before. The message says "already exists", which a caller that
  // treats an existing directory as success can match on either generation.
  { codes: [SYS_CTRL_E_BUFFER_OVERFLOW, SYS_CTRL_E_DIR_EXIST], rws: 'INVALID_ARGUMENT' },
];

/**
 * Whether an error answer says the value was too large for one RWS request.
 * RWS 2.0 has its own code for it (SYS_CTRL_E_BUFFER_OVERFLOW). RW 6.16.03
 * answers an oversize RAPID array read with HTTP 400 and its generic
 * -1073414146, "Buffer not enough to hold data" (2026-10-03), the same status
 * and code it gives a symbol that does not exist ("Symbol not found"), so
 * there only the controller's message tells the two apart.
 */
function isTooMuchData(controllerCode: number | null, controllerMsg: string | null): boolean {
  if (controllerCode === SYS_CTRL_E_BUFFER_OVERFLOW) { return true; }
  // Matched only under the generic code, on the controller's own phrase.
  return controllerCode === SYS_CTRL_E_FAIL && /\bbuffer not enough\b/i.test(controllerMsg ?? '');
}

/**
 * The taxonomy code this table gives a controller code, or null when the
 * table does not map it. For answers that carry the code outside a status
 * block (an error link in a 200), where `classifyControllerError` does not
 * apply.
 */
export function codeForControllerCode(controllerCode: number): RwsErrorCode | null {
  return CODE_MAP.find(m => m.codes.includes(controllerCode))?.rws ?? null;
}

export function classifyControllerError(args: {
  httpStatus: number;
  body: string;
  method: string;
  path: string;
  fallback?: RwsErrorCode;
  /** What the caller knows about the controller: generation, mode, user... */
  context?: RefusalContext;
  /** The request body; read only to tell a motors-on write from motors off. */
  requestBody?: string | Uint8Array;
}): ControllerErrorInfo {
  const { httpStatus, body, method, path, fallback } = args;
  const { code: controllerCode, msg: controllerMsg } = parseControllerStatus(body);
  const cleanPath = path.split('?')[0];
  const at = `${method} ${cleanPath}`;

  // An access refusal: explained in plain words, with the controller detail.
  // A 401 is never explained as a refusal: a missing grant answers 403. A
  // code this table maps (a missing thing, a value too large, a directory
  // that already exists) keeps its meaning whatever the status.
  const namesMissing = controllerCode !== null && controllerCode !== SYS_CTRL_E_FAIL
    && CODE_MAP.some(m => m.codes.includes(controllerCode));
  if (httpStatus !== 401 && !namesMissing) {
    const refused = refusalFor({
      http: httpStatus, code: controllerCode, msg: controllerMsg, method, path,
      motors: motorsOfBody(args.requestBody),
    }, args.context ?? {});
    if (refused) {
      return { code: refused.code, controllerCode, controllerMsg, message: refused.message, refusal: refused.refusal };
    }
  }

  let rws: RwsErrorCode | null = null;
  if (controllerCode !== null) {
    rws = CODE_MAP.find(m => m.codes.includes(controllerCode))?.rws ?? null;
    // "Unspecified error" means "not found" only where RobotWare 6 uses it so.
    if (controllerCode === SYS_CTRL_E_FAIL && httpStatus !== 404 && httpStatus !== 400) { rws = null; }
  }
  const tooMuchData = isTooMuchData(controllerCode, controllerMsg);
  if (tooMuchData) { rws = 'INVALID_ARGUMENT'; }
  // The input is refused, not missing: RW 6.16.03 answered a decompress of a
  // file that is not a finished archive with 400 -1073414146 "Cannot
  // decompress an uncompressed or an invalid file" (2026-10-13), which the
  // generic code would otherwise read as RESOURCE_NOT_FOUND.
  // Likewise RW 7.21.4 and 8.2.1 answered a user registration without a
  // ulocale with 400 -1073414146 "UserRegistration failed:locale name is
  // empty or exceeded size of ulocale" (2026-10-21).
  const badArchive = /cannot decompress/i.test(controllerMsg ?? '');
  const badRegistration = /userregistration failed/i.test(controllerMsg ?? '');
  if (badArchive || badRegistration) { rws = 'INVALID_ARGUMENT'; }
  // Promote a generic not-found to MODULE_NOT_FOUND. The path alone is not
  // enough: RWS 1.0 unloads a module by POSTing to the *task*, so the module
  // only appears in the request body. The controller's own wording is the
  // reliable signal: -1073442816 says only that a RAPID symbol was not found,
  // and a module name is one (see CODE_MAP).
  if (rws === 'RESOURCE_NOT_FOUND'
      && (/\/modules\//.test(cleanPath) || /unknown module/i.test(controllerMsg ?? ''))) {
    rws = 'MODULE_NOT_FOUND';
  }
  if (rws === null) {
    // No (mappable) controller code - fall back on HTTP semantics
    if (httpStatus === 404) {
      rws = /\/modules\//.test(cleanPath) ? 'MODULE_NOT_FOUND' : 'RESOURCE_NOT_FOUND';
    } else {
      rws = fallback ?? 'UNKNOWN';
    }
  }

  // Every message embeds "HTTP <status> from <method> <path>": RobotManager's
  // mkdir recovery and the VS Code extension's hint branches match on that
  // exact phrase, and it survived from the pre-taxonomy message format.
  const status = `HTTP ${httpStatus} from ${at}`;
  const detail = controllerMsg ? ` (${controllerMsg})` : '';
  let message: string;
  switch (rws) {
    case 'MODULE_NOT_FOUND':
      message = `Module not found: ${status} - it is not loaded on the controller${detail}`;
      break;
    case 'RESOURCE_NOT_FOUND':
      message = `Resource does not exist on the controller: ${status}${detail}`;
      break;
    case 'INVALID_ARGUMENT':
      message = tooMuchData
        ? `Too much data for one RWS request${controllerCode === SYS_CTRL_E_BUFFER_OVERFLOW ? ' (SYS_CTRL_E_BUFFER_OVERFLOW)' : ''}: ${status}${detail}`
        : controllerCode === SYS_CTRL_E_DIR_EXIST
          ? `Directory already exists on the controller (SYS_CTRL_E_DIR_EXIST): ${status}${detail}`
          : badArchive
            ? `The controller cannot decompress that file: it is not an archive, or not a finished one: ${status}${detail}`
            : `${status}${detail}`;
      break;
    default:
      message = `${status}${detail}`;
  }

  return { code: rws, controllerCode, controllerMsg, message };
}
