/**
 * Controller-level error taxonomy: parse RWS error-response bodies and turn
 * HTTP-status-shaped failures into actionable, controller-aware error codes.
 *
 * Every controller code below was captured live 2026-08-02 from the RW6.16
 * IRC5 VC and RW7.21 OmniCore VC (raw payloads in tests/fixtures/errors/).
 * Both generations share the same code space:
 *   -1073445862  "Requested resource is held by someone else"  (mastership held;
 *                 RWS 2.0 also emits it when a resource is blocked by an
 *                 operation in progress, e.g. execution start refused)
 *   -1073445859  "The user does not have required mastership"  (mastership missing)
 *   -1073445881  "Rejected"                                    (RMMP/UAS permission)
 *   -1073414146  "Resource/Symbol not found" (appears on 404 AND 400)
 *   -1073445866  "Invalid IO signal name"
 *   -1073438713  "Path does not exist" (fileservice)
 *   -1073442813  "module name/parameter is invalid or missing"
 *   -1073442809  RAPID execution start refused (org_code -508, wrong state)
 */

import type { RwsErrorCode } from './types.js';

export interface ControllerErrorInfo {
  /** Classified error code - never plain AUTH_FAILED for a body-carrying 403. */
  code: RwsErrorCode;
  controllerCode: number | null;
  controllerMsg: string | null;
  /** Actionable human-readable message naming the failed request. */
  message: string;
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

/**
 * Controller codes → taxonomy. Shared across RWS 1.0 and 2.0.
 *
 * Harvested by triggering safe, guaranteed-rejected operations against RW6.16,
 * RW7.21 and RW8.1.1 and recording every native code each one returns. A code
 * that is not listed here falls back to HTTP semantics, which for a 400 means
 * `UNKNOWN` - so an unmapped code silently costs callers their error branch.
 */
const CODE_MAP: ReadonlyArray<{ codes: number[]; rws: RwsErrorCode }> = [
  // The RW8 Control Station Service has its own write-access code family
  // (live-captured 2026-09-15 on RW8.1.1+614; icode in parentheses):
  //   -1073435870 (-20109) "Remote Control Station cannot take SPoC when it is
  //                taken" - another control station holds write access.
  //   -1073435873 (-20107) "The control station does not have SPoC" /
  //                "does not have required WriteAccess" - this session holds
  //                no write access (also what a release-after-write answers).
  //   -1073435871 (-20101) "Session is not part of a Control Station" - the
  //                session was never registered, or is a NEW session (a
  //                re-issued cookie) whose registration died with the old one.
  // All three mean "acquire write access first" - the RW8 spelling of the RW7
  // mastership codes above - not a UAS/RMMP permission problem, which is what
  // GRANT_DENIED told callers until 1.3.1.
  // -1073445844 SYS_CTRL_E_RESOURCE_MOTION_HELD_REJECT "Action not possible
  // since mastership over motion is held": a RAPID start (HTTP 500!) while
  // any session - including the caller's own - holds MOTION mastership.
  // Live-captured 2026-09-15 on RW7.21 (probe held motion for motors-on).
  { codes: [-1073445862, -1073445859, -1073435870, -1073435873, -1073435871, -1073445844], rws: 'MASTERSHIP_REQUIRED' },
  // -1073445867 "The user is not allowed access": returned for UAS-gated
  // resources such as /uas/ldap/*. Without it a 403 fell through to UNKNOWN,
  // because the HTTP fallback below only promotes 404.
  { codes: [-1073445881, -1073445867], rws: 'GRANT_DENIED' },
  // -1073435867 (-20103) "Control station id not allowed": the RW8 register
  // call requires a BRACED GUID ({8-4-4-4-12}); nothing else is accepted.
  // Hex form 0xC004AB25 is what the community searches for.
  { codes: [-1073435867],              rws: 'INVALID_ARGUMENT' },
  // -1073445885 SYS_CTRL_E_SERVICE_NOT_SUPPORTED "The service is not supported
  // in this version of controller" - what the RW8.1.x RMMP service answers
  // (HTTP 500) on every verb. The controller's own retcode dictionary names
  // it on RW7.21 and RW8.1.1 alike (GET /rw/retcode?code=-1073445885).
  { codes: [-1073445885],              rws: 'UNSUPPORTED_OPERATION' },
  { codes: [-1073442809],              rws: 'WRONG_MODE' },
  { codes: [-1073442813],              rws: 'MODULE_NOT_FOUND' },
  // Everything below means "the thing you named is not there". Notes on the
  // ones that are not obvious:
  //   -1073438716  "Virtual root does not exist" - RWS 2.0 answer for a bad
  //                volume in a file path, on 400. RWS 1.0 answers the same
  //                condition 404 with -1073414146, so listDirectory on a bad
  //                volume reported RESOURCE_NOT_FOUND on RW6 but UNKNOWN on
  //                RW7/RW8 until this was mapped.
  //   -1073438708  RW6 loadModule with a path that does not exist. The
  //                controller sends no human-readable text, only the code.
  //   -1073442816  Overloaded by the controller across at least three distinct
  //                conditions, each with its own wording and HTTP status:
  //                "Unknown module name" (RW6 unloadmod, 400), "Symbol not
  //                found" (RW7/RW8 symbol GET, 404), and an untranslated
  //                "org_code: -517" (RW6 symbol write, 404). The number alone
  //                cannot tell them apart, so it lands on the general meaning
  //                and the message promotes it where it is specific.
  { codes: [-1073414146, -1073445866, -1073438713, -1073438716, -1073438708,
            -1073445883, -1073442816],
    rws: 'RESOURCE_NOT_FOUND' },
];

export function classifyControllerError(args: {
  httpStatus: number;
  body: string;
  method: string;
  path: string;
  fallback?: RwsErrorCode;
}): ControllerErrorInfo {
  const { httpStatus, body, method, path, fallback } = args;
  const { code: controllerCode, msg: controllerMsg } = parseControllerStatus(body);
  const cleanPath = path.split('?')[0];
  const at = `${method} ${cleanPath}`;

  let rws: RwsErrorCode | null = null;
  if (controllerCode !== null) {
    rws = CODE_MAP.find(m => m.codes.includes(controllerCode))?.rws ?? null;
  }
  // Promote a generic not-found to MODULE_NOT_FOUND. The path alone is not
  // enough: RWS 1.0 unloads a module by POSTing to the *task*, so the module
  // only appears in the request body. The controller's own wording is the
  // reliable signal, because -1073442816 is overloaded (see CODE_MAP).
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
    case 'MASTERSHIP_REQUIRED':
      if (controllerCode === -1073445859) {
        message = `Missing mastership: ${status} - acquire it first (requestMastership), then retry${detail}`;
      } else if (controllerCode === -1073435870) {
        message = `Write access is held by another control station: ${status} - release it there (RobotStudio: Release Write Access, or the pendant) or appeal for it (appealWriteAccessRelease), then retry${detail}`;
      } else if (controllerCode === -1073435873) {
        message = `Write access not held: ${status} - request control-station write access first (requestWriteAccess / requestMastership) and re-request it after any write that clears it, then retry${detail}`;
      } else if (controllerCode === -1073445844) {
        message = `Mastership over motion is held: ${status} - a RAPID start is refused while any session (this one included) holds motion mastership; release it first, then retry${detail}`;
      } else if (controllerCode === -1073435871) {
        message = `Session is not registered as a control station: ${status} - registration is per session, so a re-issued session cookie needs registerControlStationRemote again before write access${detail}`;
      } else {
        message = `Resource held by another client (mastership or an operation in progress): ${status} - release it there (RobotStudio: Release Write Access) or wait, then retry${detail}`;
      }
      break;
    case 'UNSUPPORTED_OPERATION':
      message = `Service not supported by this controller version: ${status}${detail}`;
      break;
    case 'INVALID_ARGUMENT':
      message = controllerCode === -1073435867
        ? `Control station id not allowed: ${status} - the id must be a braced GUID of the form {8-4-4-4-12}${detail}`
        : `Invalid argument: ${status}${detail}`;
      break;
    case 'GRANT_DENIED':
      message = `Permission denied: ${status} - request remote-modify privilege (RMMP) via POST /users/rmmp and approve the popup on the FlexPendant, or add the required UAS grant (e.g. "Remote Start and Stop in Auto") in RobotStudio > UAS${detail}`;
      break;
    case 'WRONG_MODE':
      message = `Operation not allowed in the current controller state or operation mode: ${status} - check ctrlstate/opmode and program pointer${detail}`;
      break;
    case 'MODULE_NOT_FOUND':
      message = `Module not found: ${status} - it is not loaded on the controller${detail}`;
      break;
    case 'RESOURCE_NOT_FOUND':
      message = `Resource does not exist on the controller: ${status}${detail}`;
      break;
    default:
      message = `${status}${detail}`;
  }

  return { code: rws, controllerCode, controllerMsg, message };
}
