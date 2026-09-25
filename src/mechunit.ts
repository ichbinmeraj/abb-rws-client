// abb-rws-client - mechanical-unit helpers shared by both protocol generations.
// The wire fields are the same on RWS 1.0 and 2.0 (only the envelope differs),
// so both adapters hand their parsed field map to these functions.

import { RwsError, type JointTargetFull, type MechunitDetails } from './types.js';

/**
 * The value RAPID and RWS use for "no axis in this slot" of a jointtarget: 9E9.
 * Test values with `isJointValuePresent()`, not by equality.
 */
export const JOINT_NOT_PRESENT = 9e9;

/**
 * Whether a jointtarget value is a real axis position rather than the 9E9
 * "not present" marker.
 *
 * The marker can arrive spelled `9E+09`, `9000000000`, or - where the value
 * went through a 32-bit float - `8999999488`, so this is a threshold rather
 * than an equality test. No real axis value comes near it: 8.9E9 degrees or
 * millimetres is not a position any unit can hold. NaN and infinities are
 * not present either.
 *
 * NOTE: an unused slot does not always carry the marker - see
 * `JointTargetFull` (unused `eax_*` read 0 on the RW 7.21 VC).
 */
export function isJointValuePresent(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) < 8.9e9;
}

const RAX_FIELDS = ['rax_1', 'rax_2', 'rax_3', 'rax_4', 'rax_5', 'rax_6'] as const;
const EAX_FIELDS = ['eax_a', 'eax_b', 'eax_c', 'eax_d', 'eax_e', 'eax_f'] as const;

type Six = [number, number, number, number, number, number];

/** Parse one numeric wire field; undefined when the field is absent or blank. */
function wireNumber(fields: Record<string, string | undefined>, key: string, context: string): number | undefined {
  const raw = fields[key];
  if (raw === undefined || raw.trim() === '') { return undefined; }
  const n = Number(raw.trim());
  if (Number.isNaN(n)) {
    throw new RwsError(`PARSE_ERROR: ${context}: "${key}" is not a number ("${raw}")`, 'PARSE_ERROR');
  }
  return n;
}

/**
 * Build a `JointTargetFull` from the fields of an `ms-jointtarget` state
 * (`rax_1..rax_6`, `eax_a..eax_f`). The six robot fields are required - a
 * jointtarget without them is a malformed response, so this throws
 * `PARSE_ERROR`. An absent external field reads as `JOINT_NOT_PRESENT`.
 */
export function toJointTargetFull(
  fields: Record<string, string | undefined>,
  context: string,
): JointTargetFull {
  const rax = RAX_FIELDS.map(k => {
    const n = wireNumber(fields, k, context);
    if (n === undefined) {
      throw new RwsError(`PARSE_ERROR: ${context}: missing "${k}" in the jointtarget`, 'PARSE_ERROR');
    }
    return n;
  }) as Six;
  const eax = EAX_FIELDS.map(k => wireNumber(fields, k, context) ?? JOINT_NOT_PRESENT) as Six;
  return { rax, eax };
}

/**
 * Normalise a raw mechanical-unit resource (as returned by `getMechunitInfo`)
 * into `MechunitDetails`. Reads both the XHTML / RWS 2.0 spellings and the
 * RW 6 JSON ones (errata E11). Blank values become null; a count that is not a
 * non-negative integer becomes null rather than a guess.
 */
export function toMechunitDetails(name: string, raw: Record<string, string> | null | undefined): MechunitDetails {
  // RW 6 JSON can carry non-string members (e.g. `_links`); keep strings only
  // so `raw` is what its type says.
  const src: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === 'string') { src[k] = v; }
  }
  const str = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === 'string' && v.trim() !== '') { return v.trim(); }
    }
    return null;
  };
  const count = (key: string): number | null => {
    const v = str(key);
    if (v === null) { return null; }
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  return {
    name,
    type: str('type'),
    axes: count('axes'),
    axesTotal: count('axes-total'),
    task: str('task-name', 'task'),
    mode: str('mode'),
    status: str('status'),
    coordSystem: str('coord-system'),
    tool: str('tool-name'),
    wobj: str('wobj-name'),
    isIntegratedUnit: str('is-integrated-unit', 'is-integrated-unitname'),
    hasIntegratedUnit: str('has-integrated-unit', 'has-integrated-unitname'),
    raw: src,
  };
}
