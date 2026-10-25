import { RwsError, type JogIncrement, type JogParams } from './types.js';

/**
 * The jog request as ABB's jog form lists it, the same on both generations
 * (RWS 1.0 `POST /rw/motionsystem?action=jog`, RWS 2.0
 * `POST /rw/motionsystem/jog`): `axis1`..`axis6`, `ccount` and `inc-mode`
 * (the forms read live on RW 6.16, 7.21 and 8.1.1 VCs, 2026-09-27). RWS 2.0
 * also documents an optional `token` from RobotWare 7.7 for jogging in Auto,
 * which this client does not send.
 *
 * `ccount` is the controller's current motion-system change count, read with
 * `GET /rw/motionsystem` right before the jog; a jog whose `ccount` differs is
 * refused with 400 -1073436652 SYS_CTRL_E_HPJ_CHANGE_COUNT_MISMATCH (ABB staff
 * on ABB's community forum; ABB's own samples send `ccount=0`, the value all
 * three of our VCs read). The same read names the unit selected for jogging
 * (`mechunit-name`).
 *
 * Not sent, because no jog form lists them: a jog mode, a unit and a speed.
 * The controller jogs the unit selected for jogging, in that unit's jog mode
 * (the `jog-mode` of `GET /rw/motionsystem/mechunits/{unit}`; our VCs read
 * `AxisGroup1`), at its own jog speed. How the controller scales an axis
 * value within one increment has not been observed live.
 *
 * A jog that names a unit the controller does not have selected selects it
 * first, with ABB's "set mechanical unit for jogging" (RWS 1.0
 * `POST /rw/motionsystem?action=set-mechunit`, field `mechunit-name`; RWS 2.0
 * `POST /rw/motionsystem/{mechunit}`), then reads the motion system again and
 * sends the jog only if the controller now names that unit. The selection is
 * not restored afterwards: it stays as the controller's (and the
 * FlexPendant's) jog unit until something selects another.
 */

export const JOG_INCREMENTS: readonly JogIncrement[] = ['Small', 'Medium', 'Large', 'User'];

/**
 * The increment sent when the caller names none: `Small`, the smallest. ABB's
 * form lets `inc-mode` default to "no increment"; this client does not send a
 * jog without an increment until a live run shows how the controller bounds
 * such a jog.
 */
export const DEFAULT_JOG_INCREMENT: JogIncrement = 'Small';

/** Checked jog arguments. Throws INVALID_ARGUMENT before anything is sent. */
export function checkJog(params: JogParams): { axes: number[]; incMode: JogIncrement } {
  if (params?.mechunit !== undefined) { jogUnitName(params.mechunit, 'jog'); }
  const axes = params?.axes;
  if (!Array.isArray(axes) || axes.length !== 6 || axes.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new RwsError(`jog: axes must be six finite numbers, got ${JSON.stringify(axes)}. Nothing was sent.`, 'INVALID_ARGUMENT');
  }
  const incMode = params.incMode ?? DEFAULT_JOG_INCREMENT;
  if (!JOG_INCREMENTS.includes(incMode)) {
    throw new RwsError(
      `jog: incMode must be one of ${JOG_INCREMENTS.join(', ')} (ABB's inc-mode values), got ${JSON.stringify(incMode)}. Nothing was sent.`,
      'INVALID_ARGUMENT');
  }
  return { axes: [...axes], incMode };
}

/**
 * The motion-system change count from `GET /rw/motionsystem`. A missing or
 * non-numeric count is a PARSE_ERROR: a guessed count is never sent.
 */
export function jogChangeCount(raw: string | undefined, where: string): number {
  const text = (raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw new RwsError(
      `jog: ${where} carried no motion-system change count (read ${JSON.stringify(raw ?? null)}). The jog was not sent.`,
      'PARSE_ERROR');
  }
  return Number(text);
}

/**
 * The sibling resources of `/rw/motionsystem` in ABB's Motion_System Rev L
 * and the RW 7.21.4 / 8.2.1 listings (2026-09-29). RWS 2.0 selects a unit for
 * jogging with `POST /rw/motionsystem/{mechunit}`, so a unit with one of these
 * names would address that resource instead; the client refuses it.
 */
export const RWS2_MOTIONSYSTEM_CHILDREN: readonly string[] = [
  'jog', 'position-target', 'position-joint', 'mechunits', 'nonmotionexecution',
  'collisionprediction', 'collisionavoidance', 'errorstate', 'checkchangecount',
  'moveinauto', 'motionsupervision', 'pathsupervision',
];

/**
 * A mechanical unit name for jogging: a RAPID name (a letter, then letters,
 * digits or underscores, such as `ROB_1` or `STN_1`), since unit names are
 * RAPID names. That keeps out spaces, control characters and path-like names:
 * `buildPath` percent-encodes `/`, `?` and `#`, but `.` and `..` would go out
 * as path segments an intermediary may normalize (`POST /rw/motionsystem/..`
 * to `/rw/`). INVALID_ARGUMENT before anything is sent otherwise.
 */
export function jogUnitName(mechunit: string, what: string): string {
  if (typeof mechunit !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(mechunit)) {
    throw new RwsError(
      `${what}: the mechanical unit name must be a RAPID name (a letter, then letters, digits or underscores, such as ROB_1), got ${JSON.stringify(mechunit)}. Nothing was sent.`,
      'INVALID_ARGUMENT');
  }
  return mechunit;
}

/** Two unit names compared as RAPID compares names: without case. */
function sameUnit(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/**
 * The RWS 2.0 path segment for a unit selection: `jogUnitName`, and not a
 * sibling resource of `/rw/motionsystem` (`RWS2_MOTIONSYSTEM_CHILDREN`,
 * compared without case). INVALID_ARGUMENT before anything is sent otherwise.
 */
export function rws2JogUnitSegment(mechunit: string, what: string): string {
  const unit = jogUnitName(mechunit, what);
  if (RWS2_MOTIONSYSTEM_CHILDREN.includes(unit.toLowerCase())) {
    throw new RwsError(
      `${what}: '${unit}' names the motion-system resource /rw/motionsystem/${unit.toLowerCase()}, so POST /rw/motionsystem/${unit} would not select a unit. Nothing was sent.`,
      'INVALID_ARGUMENT');
  }
  return unit;
}

/**
 * The unit a jog must select before it is sent: the requested unit when the
 * controller names another one (or none) as selected for jogging, otherwise
 * undefined (nothing to select). The jog form has no unit field, so the
 * controller jogs its own selection. Names are compared without case, as
 * RAPID compares names: `rob_1` against a selected `ROB_1` is the same unit
 * and writes no selection.
 */
export function jogUnitToSelect(requested: string | undefined, selected: string | undefined): string | undefined {
  if (requested === undefined) { return undefined; }
  return sameUnit((selected ?? '').trim(), requested) ? undefined : requested;
}

/**
 * After a jog selected `requested`, the motion system must name it as the
 * unit selected for jogging, or the jog is not sent (INVALID_ARGUMENT): the
 * controller would jog its own selection. A read that names no unit passes,
 * as before the selection existed. That `mechunit-name` on the motion-system
 * resource is the jog selection is read from ABB's pages (the RWS 1.0
 * set-mechunit form's field has the same name) and the root reads of RW
 * 7.21.4 and 8.2.1 (`ROB_1`, 2026-09-29); it has not been shown live on a
 * system with two units. Compared without case, so a controller that answers
 * with its own spelling of the name passes.
 */
export function checkJogUnit(requested: string | undefined, selected: string | undefined): void {
  const sel = (selected ?? '').trim();
  if (requested === undefined || sel === '' || sameUnit(sel, requested)) { return; }
  throw new RwsError(
    `jog: '${requested}' was selected for jogging, but the controller still names '${sel}' as the selected unit, so '${sel}' would move, not '${requested}'. `
    + 'The jog was not sent.',
    'INVALID_ARGUMENT');
}

/** Errors the jog POST itself answered with; nothing else is tagged. */
const jogPostErrors = new WeakSet<object>();

/**
 * Tags `e` as the answer to the jog POST itself and returns it. The adapters
 * tag only that request: a refused motion-system read or unit selection before
 * it is not tagged. `RobotManager.jog` explains only a tagged refusal with its
 * pre-flight reading (mode, motors, motion control); any other keeps its own
 * explanation.
 */
export function asJogPostError(e: unknown): unknown {
  if (typeof e === 'object' && e !== null) { jogPostErrors.add(e); }
  return e;
}

/** True when `e` is the jog POST's own answer (`asJogPostError`). */
export function isJogPostError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && jogPostErrors.has(e);
}

/** The form body: `axis1=..&...&axis6=..&ccount=N&inc-mode=Small`. */
export function jogBody(axes: readonly number[], ccount: number, incMode: JogIncrement): string {
  return [
    ...axes.map((v, i) => `axis${i + 1}=${v}`),
    `ccount=${ccount}`,
    `inc-mode=${incMode}`,
  ].join('&');
}
