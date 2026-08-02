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

/** Controller codes → taxonomy. Shared across RWS 1.0 and 2.0. */
const CODE_MAP: ReadonlyArray<{ codes: number[]; rws: RwsErrorCode }> = [
  { codes: [-1073445862, -1073445859], rws: 'MASTERSHIP_REQUIRED' },
  { codes: [-1073445881],              rws: 'GRANT_DENIED' },
  { codes: [-1073442809],              rws: 'WRONG_MODE' },
  { codes: [-1073442813],              rws: 'MODULE_NOT_FOUND' },
  { codes: [-1073414146, -1073445866, -1073438713], rws: 'RESOURCE_NOT_FOUND' },
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
  if (rws === 'RESOURCE_NOT_FOUND' && /\/modules\//.test(cleanPath)) {
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
      message = controllerCode === -1073445859
        ? `Missing mastership: ${status} - acquire it first (requestMastership), then retry${detail}`
        : `Resource held by another client (mastership or an operation in progress): ${status} - release it there (RobotStudio: Release Write Access) or wait, then retry${detail}`;
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
