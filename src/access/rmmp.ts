import { Logger } from '../Logger.js';
import { RwsError, type RmmpLevel, type RmmpRequestOptions, type RmmpResult, type RwsRefusal } from '../types.js';
import { builtRefusal, refusalError, remedy, rmmpNotOnRw8 } from '../refusal.js';

/**
 * RMMP (Request Manual Mode Privileges): the manual-mode counterpart of a
 * mastership request in Auto (ABB RWS 1.0 manual, "RMMP"). A remote client asks
 * with `POST /users/rmmp privilege={modify|exec}` (202), an operator at the
 * FlexPendant grants or denies it, and ABB deletes the request "after 10
 * seconds" unless the client polls `GET /users/rmmp/poll`, which extends the
 * window by an amount ABB does not state. `GET /users/rmmp` reports the
 * privilege (`none`, `pending modify`, `modify`, `exec`) and whether this
 * session holds it (`rmmpheldbyme`). RobotWare 7 accepts a request only in
 * MANR and needs the UAS grant 'Program debug' (UAS_RAPID_DEBUG) for request,
 * poll and cancel (ABB RWS 2.0 User service). RobotWare 8 does not support
 * RMMP ("not supported from RobotWare version 8.1 onwards"), and has no
 * mastership for it to lead to.
 */

/** Default wait for the operator (ms). An example setting in ABB's PC SDK manual waits 65 s. */
export const RMMP_DEFAULT_WAIT_MS = 30_000;
/** Default poll interval while a request is pending (ms). */
export const RMMP_DEFAULT_POLL_MS = 1_000;
/** Longest poll interval: half of ABB's 10 s window, so a slow poll still lands inside it. */
export const RMMP_MAX_POLL_MS = 5_000;
/** Shortest poll interval: keeps the wait well under the controller's request-rate ceiling. */
export const RMMP_MIN_POLL_MS = 250;

/**
 * -1073445863 SYS_CTRL_E_DENIED, "The request was denied" (ABB return-code
 * list). Taken as a denial when a poll answers with it. How a denial shows on
 * the wire has not been captured; this code is the candidate by its name.
 */
export const RMMP_DENIED_CODE = -1073445863;
/** -1073445870 SYS_CTRL_E_NO_SUCH_REQUEST: the poll's documented answer when nothing is pending. */
export const RMMP_NO_SUCH_REQUEST_CODE = -1073445870;

/**
 * A requested level as ABB spells it. `'exclusive'` is a deprecated alias of
 * `'exec'` (the value ABB documents; `exclusive` is on no ABB page). Anything
 * else is refused before sending.
 */
export function rmmpLevel(level: unknown): RmmpLevel {
  if (level === 'modify' || level === 'exec') { return level; }
  if (level === 'exclusive') { return 'exec'; }
  throw new RwsError(
    `RMMP level must be 'modify' or 'exec' (ABB's documented values), got ${JSON.stringify(level)}. Nothing was sent.`,
    'INVALID_ARGUMENT');
}

/** A privilege value as read from `GET /users/rmmp`, trimmed and lower-case (`None` reads as `none`). */
export function normaliseRmmpPrivilege(value: string | null | undefined): string {
  const v = (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return v === '' ? 'none' : v;
}

/** True for a privilege this session holds: `modify` or `exec`. */
export function isRmmpGranted(privilege: string | null | undefined): boolean {
  const p = normaliseRmmpPrivilege(privilege);
  return p === 'modify' || p === 'exec';
}

/**
 * True when a held privilege covers the level wanted: `exec` covers `exec` and
 * `modify`; `modify` covers `modify` only. `none` and `pending ...` cover nothing.
 */
export function rmmpCovers(held: string | null | undefined, wanted: RmmpLevel): boolean {
  const p = normaliseRmmpPrivilege(held);
  return p === 'exec' || (p === 'modify' && wanted === 'modify');
}

/** True for a request that waits for the operator (`pending modify`, `pending exec`). */
export function isRmmpPending(privilege: string | null | undefined): boolean {
  return normaliseRmmpPrivilege(privilege).startsWith('pending');
}

/**
 * The refusal for any RMMP call on RobotWare 8. Nothing is sent: ABB marks
 * every RMMP operation "not supported from RobotWare version 8.1 onwards", RW
 * 8.1.1 answers them with 500 -1073445885 ("The service is not supported in
 * this version of controller"), RW 8.2.1 answers GET /users/rmmp and its poll
 * with the same 500 -1073445885, not a 410 (live-verified 2026-09-29), and
 * RobotWare 8 has no mastership for RMMP to
 * lead to. ABB does not state RobotWare 8.0; it is treated the same, for the
 * last reason.
 */
export function rmmpUnsupportedOnRw8(op: string, rwVersion: string | null): RwsError {
  const rw = rwVersion ? `RobotWare ${rwVersion}` : 'RobotWare 8';
  const instead = 'an operator allows Remote Access at the FlexPendant, and this station then requests write access';
  return refusalError('UNSUPPORTED_OPERATION', {
    kind: 'unsupported', condition: 'none', generation: 'rw8', grantor: 'nobody',
    missing: 'a RobotWare version with RMMP',
    fix: `On RobotWare 8 ${instead}.`,
    sentence: `${op}: ${rw} has no RMMP. ABB lists the RMMP service as not supported from RobotWare 8.1 on, `
      + `and RobotWare 8 replaces mastership with control-station write access: ${instead}. Nothing was sent.`,
    evidence: 'abb',
    remedy: rmmpNotOnRw8('rw8'),
  });
}

/** The refusal behind a `denied` or `expired` RMMP outcome. */
/** The RMMP poll's status codes, as RW 7.21.4 answered them (2026-10-11). */
const RMMP_POLL_PENDING_CODE = 294914;

function rmmpOutcomeRefusal(
  outcome: 'denied' | 'expired', detail: string, generation: 'rw6' | 'rw7' | null, neverStood = false, level: RmmpLevel = 'modify',
): RwsRefusal {
  if (neverStood) {
    // The controller never reported the request as waiting, so no grant
    // dialog can be shown to have stood: "no one granted" would blame the
    // operator for a request that may never have reached the FlexPendant.
    return builtRefusal({
      kind: 'unknown', condition: 'rmmp', generation, grantor: null,
      missing: 'an RMMP request the controller reports as waiting at the FlexPendant',
      fix: 'The controller did not say why. Try again with the user that has been granted RMMP before, and keep this tool\'s log at trace level: '
        + 'it records every poll and privilege answer.',
      sentence: detail,
      evidence: 'vc',
      remedy: remedy.noneKnown(generation, {
        detail: 'The controller never showed the request as waiting at the FlexPendant and did not say why. '
          + "Try again with a user that has been granted RMMP before, with this tool's log at trace level.",
        evidence: 'vc',
      }),
    });
  }
  return builtRefusal(outcome === 'denied'
    ? {
      kind: 'rmmp-denied', condition: 'rmmp', generation, grantor: 'pendant-operator',
      missing: 'the operator\'s grant at the FlexPendant',
      fix: 'Ask the operator at the FlexPendant, then request again; this tool never requests again on its own.',
      sentence: detail,
      // How a denial shows on the wire is not captured yet.
      evidence: 'unverified',
      remedy: remedy.grantRmmpAtPendant(generation, {
        detail: 'The operator at the FlexPendant said no. Speak to them first; this tool never asks again on its own.',
        evidence: 'unverified',
      }),
      otherRemedies: [remedy.requestRmmp(generation, level)],
    }
    : {
      kind: 'rmmp-expired', condition: 'rmmp', generation, grantor: 'pendant-operator',
      missing: 'an answer from a local client (the operator at the FlexPendant) while the controller held the request',
      fix: 'Request again with someone watching the FlexPendant. If it shows no request, the grant cannot be given there: do the operation at the '
        + 'FlexPendant, or in Auto from this tool.',
      sentence: detail,
      evidence: 'abb',
      remedy: remedy.requestRmmp(generation, level, {
        detail: `This tool asks again for RMMP ${level} once a person chooses to, with someone watching the FlexPendant to press Grant.`,
      }),
      otherRemedies: [remedy.doAtPendant(generation, { detail: 'If the FlexPendant shows no request, do the operation at the FlexPendant, or in Auto from this tool.' })],
    });
}

/**
 * True when a failed RMMP call means the controller does not offer RMMP at all:
 * 500 -1073445885 (what RW 8.1.1 answers) or 410 Gone (what ABB's RobotWare 8
 * pages list from 8.2.0).
 */
export function isRmmpServiceUnsupported(e: unknown): e is RwsError {
  return e instanceof RwsError
    && (e.httpStatus === 410 || (e.httpStatus === 500 && e.controllerCode === -1073445885));
}

/** The wire calls the wait flow makes; one session's adapter provides them. */
export interface RmmpPort {
  request(level: RmmpLevel): Promise<void>;
  /** `GET /users/rmmp/poll`: the poll's `status` text (e.g. `NO SUCH REQUEST`). */
  poll(): Promise<string>;
  /** `GET /users/rmmp`: the privilege, this session's or `none`, or `pending ...`. */
  read(): Promise<string>;
  cancel(): Promise<void>;
}

/** Checked wait options. Throws INVALID_ARGUMENT before anything is sent. */
export function rmmpWaitOptions(opts: RmmpRequestOptions): { waitMs: number; pollMs: number } {
  const waitMs = opts.waitMs ?? RMMP_DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? RMMP_DEFAULT_POLL_MS;
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) {
    throw new RwsError(`requestRmmp: waitMs must be a finite number of ms >= 0, got ${String(waitMs)}. Nothing was sent.`, 'INVALID_ARGUMENT');
  }
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < RMMP_MIN_POLL_MS || pollMs > RMMP_MAX_POLL_MS) {
    throw new RwsError(
      `requestRmmp: pollMs must be ${RMMP_MIN_POLL_MS} to ${RMMP_MAX_POLL_MS} ms (ABB deletes a request that is not polled within 10 s), got ${String(pollMs)}. Nothing was sent.`,
      'INVALID_ARGUMENT');
  }
  return { waitMs, pollMs };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Wait `ms`; resolves true when `signal` aborted first. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) { return Promise.resolve(true); }
  return new Promise(resolve => {
    const onAbort = (): void => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(false); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Request RMMP `level` and wait for the operator, as ABB's flow has it:
 *
 * 1. `POST /users/rmmp privilege=<level>`. A refusal is thrown as the
 *    controller answered it; nothing else is sent.
 * 2. Every `pollMs`, `GET /users/rmmp/poll`, which keeps the request alive
 *    past ABB's 10 s window. While the poll says pending, keep waiting.
 * 3. Any other poll answer is decided from `GET /users/rmmp`, never from the
 *    poll text alone (ABB documents only `NO SUCH REQUEST` as a poll value):
 *    - `modify` or `exec` held by this session: `granted`.
 *    - still pending: keep waiting.
 *    - a poll answered with -1073445863 SYS_CTRL_E_DENIED, or whose text says
 *      denied: `denied`. How a denial shows is not yet captured.
 *    - `none` while the poll says `NO SUCH REQUEST`: the request is gone
 *      without a grant (the operator denied it, or it expired); it is
 *      cancelled and the outcome is `expired`. This is not taken as expiry
 *      while the privilege reads as granted, because after a grant the request
 *      may no longer be pending.
 *    - anything else: keep waiting until `waitMs`.
 * 4. When `waitMs` runs out, or `signal` aborts: `POST` cancel, then
 *    `expired` or `cancelled`.
 *
 * A read that fails is an error, never `none`: when the state read fails the
 * pending request is cancelled and the read's error is thrown. A failed poll
 * is decided from the state read; if that shows no grant and no pending
 * request, the request is cancelled and the poll's error is thrown.
 *
 * A `denied` or `expired` result carries the refusal in plain words
 * (`rmmp-denied`, `rmmp-expired`; `generation` is the controller's).
 */
export async function waitForRmmp(
  port: RmmpPort, level: RmmpLevel, opts: RmmpRequestOptions = {}, generation: 'rw6' | 'rw7' | null = null,
): Promise<RmmpResult> {
  const result = await waitLoop(port, level, opts);
  const { neverStood, ...plain } = result;
  return plain.outcome === 'denied' || plain.outcome === 'expired'
    ? { ...plain, refusal: rmmpOutcomeRefusal(plain.outcome, plain.detail, generation, neverStood === true, level) }
    : plain;
}

async function waitLoop(port: RmmpPort, level: RmmpLevel, opts: RmmpRequestOptions): Promise<RmmpResult & { neverStood?: boolean }> {
  const { waitMs, pollMs } = rmmpWaitOptions(opts);
  const signal = opts.signal;
  if (signal?.aborted) {
    return { outcome: 'cancelled', privilege: null, detail: 'The wait was aborted before the RMMP request was sent. Nothing was sent.' };
  }

  await port.request(level);
  try { opts.onPending?.(); } catch (e) { Logger.warn(`requestRmmp: onPending threw: ${message(e)}`); }

  const cancel = async (why: string): Promise<string> => {
    try {
      await port.cancel();
      return 'The request was cancelled.';
    } catch (e) {
      Logger.warn(`RMMP: the cancel after ${why} failed (${message(e)}); a request that is no longer polled is removed by the controller about 10 s after the last poll`);
      return `The cancel did not go through (${message(e)}); the controller removes a request that is no longer polled about 10 s after the last poll.`;
    }
  };

  const deadline = Date.now() + waitMs;
  let privilege: string | null = null;
  // Whether the controller ever reported the request as waiting (poll text or
  // privilege read), and its last answers, for an honest result when the wait
  // runs out. virtual-controller run 2026-10-12 on RW 7.21.4: as Admin the request never showed
  // on the FlexPendant and the wait ran out after 90 s; as Default User the
  // same call showed at once and was granted. The answers were not recorded,
  // so every one is logged at trace level from here on.
  let seenPending = false;
  let lastStatus: string | null = null;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const done = await cancel('the wait ran out');
      const secs = Math.round(waitMs / 1000);
      if (!seenPending) {
        return {
          outcome: 'expired', privilege, neverStood: true,
          detail: `The controller never showed this RMMP request as waiting at the FlexPendant during ${secs} s `
            + `(last poll answer '${lastStatus ?? 'none received'}', last privilege read '${privilege ?? 'not read'}'), `
            + `so it cannot be said that a grant dialog stood there. ${done}`,
        };
      }
      return {
        outcome: 'expired', privilege,
        detail: `The controller held the RMMP request pending for ${secs} s (last poll answer '${lastStatus ?? 'none received'}', `
          + `last privilege read '${privilege ?? 'not read'}') and no local client answered it. If the FlexPendant showed no request, `
          + `the dialog did not appear there; ABB does not document when it does. ${done}`,
      };
    }
    if (await pause(Math.min(pollMs, remaining), signal)) {
      const done = await cancel('an abort');
      return { outcome: 'cancelled', privilege, detail: `The wait for the operator was aborted. ${done}` };
    }

    let status: string | null = null;
    let pollError: unknown = null;
    try { status = (await port.poll()).trim(); } catch (e) { pollError = e; }
    if (status !== null) { lastStatus = status; Logger.trace?.('rmmp', `RMMP poll answered '${status}'`); }
    else { Logger.trace?.('rmmp', `RMMP poll failed: ${message(pollError)}`); }
    if (signal?.aborted) {
      const done = await cancel('an abort');
      return { outcome: 'cancelled', privilege, detail: `The wait for the operator was aborted. ${done}` };
    }
    if (pollError instanceof RwsError && pollError.controllerCode === RMMP_DENIED_CODE) {
      return {
        outcome: 'denied', privilege,
        detail: `The controller answered the RMMP poll with ${RMMP_DENIED_CODE} ("The request was denied"): the request was denied at the FlexPendant.`,
      };
    }
    // The poll answers its state as text and code: PENDING 294914
    // (SYS_CTRL_S_PENDING, "The operation is pending") and GRANTED 294915
    // (SYS_CTRL_S_GRANTED), both recorded on RW 7.21.4 (2026-10-11); either
    // form is understood. The privilege is read on every poll, pending or not,
    // so a run records `pending modify` while the controller holds the request:
    // the two together show it waits for a local client.
    const pollPending = status !== null && (/pending/i.test(status) || status === String(RMMP_POLL_PENDING_CODE));
    if (pollPending) { seenPending = true; }

    try {
      privilege = normaliseRmmpPrivilege(await port.read());
    } catch (e) {
      await cancel('a failed read');
      throw e;
    }
    Logger.trace?.('rmmp', `RMMP privilege read '${privilege}'`);
    if (isRmmpPending(privilege)) { seenPending = true; }
    if (isRmmpGranted(privilege)) {
      return { outcome: 'granted', privilege, detail: `RMMP '${privilege}' was granted to this session at the FlexPendant.` };
    }
    if (pollPending || isRmmpPending(privilege)) { continue; }
    if (pollError) {
      await cancel('a failed poll');
      throw pollError;
    }
    if (status !== null && /den(y|ied)|reject/i.test(status)) {
      return { outcome: 'denied', privilege, detail: `The controller answered the RMMP poll with '${status}': the request was denied at the FlexPendant.` };
    }
    if (privilege === 'none' && status !== null && /no such request/i.test(status)) {
      const done = await cancel('the request ended');
      return {
        outcome: 'expired', privilege,
        detail: `The RMMP request is no longer pending and no privilege was granted to this session (poll: '${status}'): `
          + `the operator denied it or it expired. ${done}`,
      };
    }
  }
}
