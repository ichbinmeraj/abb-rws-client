/**
 * IPv4 ranges for `findControllers({ ranges })`: parsing, sizing by arithmetic, overlap
 * merging and the refusals. Pure: no socket, no child process, no DNS lookup. Nothing is
 * expanded until every entry has been sized and checked, so a huge range is refused without
 * building a list of its addresses.
 *
 * Accepted forms:
 * - CIDR, `'10.0.5.0/24'`. Prefixes /0 to /30 drop the network and broadcast addresses
 *   (`/24` = 254 hosts); /31 and /32 keep every address. Host bits after the prefix are ignored
 *   (`'10.0.5.7/24'` is the same range as `'10.0.5.0/24'`).
 * - Dash, `'10.0.5.20-10.0.5.60'`, both ends included, first <= last.
 *
 * Refused: IPv6 ranges (RobotWare does not support IPv6), any range touching 0.0.0.0/8,
 * 224.0.0.0/4 (multicast) or 240.0.0.0/4 (reserved, includes 255.255.255.255), and, unless
 * `allowPublicRanges`, any range not wholly inside 10/8, 172.16/12, 192.168/16, 127/8 or
 * 169.254/16. Overlapping entries are merged, so each address is probed once and counts once
 * against `maxRangeHosts`.
 *
 * Scanning a range opens TCP connections to every address in it. On a company network IT can
 * see these attempts, and intrusion detection may flag them.
 */

import { RwsError } from '../types.js';
import type { ParsedRange, RangePlan } from './types.js';

/**
 * A rejected discovery option: an `RwsError` with code `INVALID_ARGUMENT`, plus the option it
 * concerns, so a server can answer with a structured error instead of parsing the message.
 *
 * The message reads `findControllers: <field>: <rule> (got <value>). Nothing was sent.`.
 * Credentials are never echoed: for a credentials entry only the key is named.
 */
export class DiscoveryOptionError extends RwsError {
  /** The option path, e.g. `'ranges[2]'`, `'pacing.remote.concurrency'`, `'manual[0].host'`. */
  readonly field: string;
  /** The rejected value as shown in the message (truncated; never a credential). */
  readonly value?: string;
  /** The cap or bound that was broken, when the rule has one (e.g. 256, `'100-30000'`). */
  readonly limit?: number | string;

  constructor(field: string, rule: string, value?: string, limit?: number | string) {
    const got = value === undefined ? '' : ` (got ${value})`;
    super(`findControllers: ${field}: ${rule}${got}. Nothing was sent.`, 'INVALID_ARGUMENT');
    this.name = 'DiscoveryOptionError';
    this.field = field;
    if (value !== undefined) { this.value = value; }
    if (limit !== undefined) { this.limit = limit; }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Shows a rejected value in a message: JSON for strings, truncated to 64 characters. */
export function showValue(v: unknown): string {
  let s: string;
  if (typeof v === 'string') { s = JSON.stringify(v); }
  else if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) { s = String(v); }
  else if (Array.isArray(v)) { s = `an array of ${v.length}`; }
  else { s = `a ${typeof v}`; }
  return s.length > 64 ? `${s.slice(0, 61)}...` : s;
}

/** Longest range entry accepted, in characters ('255.255.255.255-255.255.255.255' is 31). */
const MAX_RANGE_TEXT = 64;

/** Address blocks, as inclusive [first, last] unsigned 32-bit integers. */
const block = (a: number, b: number, c: number, d: number, prefix: number): [number, number] => {
  const base = (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  const size = 2 ** (32 - prefix);
  return [base, base + size - 1];
};

/** Never probed, whatever the flags: "this network", multicast, reserved (with limited broadcast). */
const FORBIDDEN_BLOCKS: Array<{ cidr: string; range: [number, number]; why: string }> = [
  { cidr: '0.0.0.0/8', range: block(0, 0, 0, 0, 8), why: '"this network" addresses' },
  { cidr: '224.0.0.0/4', range: block(224, 0, 0, 0, 4), why: 'multicast addresses' },
  { cidr: '240.0.0.0/4', range: block(240, 0, 0, 0, 4), why: 'reserved addresses, including 255.255.255.255' },
];

/** Address blocks a range may use without `allowPublicRanges`: private, loopback, link-local. */
const PRIVATE_BLOCKS: Array<[number, number]> = [
  block(10, 0, 0, 0, 8),
  block(127, 0, 0, 0, 8),
  block(169, 254, 0, 0, 16),
  block(172, 16, 0, 0, 12),
  block(192, 168, 0, 0, 16),
];

/** 127.0.0.0/8, this PC's loopback. */
const LOOPBACK_BLOCK = block(127, 0, 0, 0, 8);

/**
 * A strict dotted-quad IPv4 literal to an unsigned 32-bit integer, or `undefined`. Four decimal
 * parts 0-255, no leading zeros (`'010.0.0.1'` is refused: some resolvers read it as octal), no
 * signs, no whitespace.
 */
export function parseIPv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) { return undefined; }
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) { return undefined; }
    const v = Number(p);
    if (v > 255) { return undefined; }
    n = n * 256 + v;
  }
  return n;
}

/** An unsigned 32-bit integer to a dotted-quad IPv4 literal. */
export function formatIPv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** true when the IPv4 literal is in 127.0.0.0/8. */
export function isLoopbackIPv4(text: string): boolean {
  const n = parseIPv4(text);
  return n !== undefined && n >= LOOPBACK_BLOCK[0] && n <= LOOPBACK_BLOCK[1];
}

const overlaps = (a: [number, number], b: [number, number]): boolean => a[0] <= b[1] && b[0] <= a[1];
const within = (inner: [number, number], outer: [number, number]): boolean =>
  inner[0] >= outer[0] && inner[1] <= outer[1];

/**
 * Parses one range entry and sizes it by arithmetic. Throws `DiscoveryOptionError`
 * (`INVALID_ARGUMENT`) for anything that is not a CIDR or dash IPv4 range; does not check the
 * address blocks or caps (that is `planRanges`).
 *
 * @param field option path used in the error, e.g. `'ranges[0]'`.
 */
export function parseRange(text: unknown, field = 'ranges'): ParsedRange {
  if (typeof text !== 'string') {
    throw new DiscoveryOptionError(field, 'must be a string, CIDR \'10.0.5.0/24\' or dash \'10.0.5.20-10.0.5.60\'', showValue(text));
  }
  const t = text.trim();
  if (t.length === 0 || t.length > MAX_RANGE_TEXT) {
    throw new DiscoveryOptionError(field, 'must be a CIDR \'10.0.5.0/24\' or dash \'10.0.5.20-10.0.5.60\' IPv4 range', showValue(text));
  }
  if (t.includes(':')) {
    throw new DiscoveryOptionError(field, 'IPv6 ranges are refused: RobotWare does not support IPv6', showValue(text));
  }

  const slash = t.indexOf('/');
  if (slash >= 0) {
    const base = parseIPv4(t.slice(0, slash).trim());
    const prefixText = t.slice(slash + 1).trim();
    if (base === undefined || !/^[0-9]{1,2}$/.test(prefixText) || Number(prefixText) > 32) {
      throw new DiscoveryOptionError(field, 'is not a CIDR IPv4 range like \'10.0.5.0/24\' (prefix 0-32)', showValue(text));
    }
    const prefix = Number(prefixText);
    const size = 2 ** (32 - prefix);
    const network = base - (base % size);
    const broadcast = network + size - 1;
    // /31 and /32 have no network or broadcast address to drop.
    const first = prefix <= 30 ? network + 1 : network;
    const last = prefix <= 30 ? broadcast - 1 : broadcast;
    return { text, first, last, size: last - first + 1 };
  }

  const dash = t.indexOf('-');
  if (dash >= 0) {
    const first = parseIPv4(t.slice(0, dash).trim());
    const last = parseIPv4(t.slice(dash + 1).trim());
    if (first === undefined || last === undefined) {
      throw new DiscoveryOptionError(field, 'is not a dash IPv4 range like \'10.0.5.20-10.0.5.60\' (both ends written in full)', showValue(text));
    }
    if (first > last) {
      throw new DiscoveryOptionError(field, 'the first address must not be above the last', showValue(text));
    }
    return { text, first, last, size: last - first + 1 };
  }

  throw new DiscoveryOptionError(field,
    'must be a CIDR \'10.0.5.0/24\' or dash \'10.0.5.20-10.0.5.60\' IPv4 range; a single address goes in manual',
    showValue(text));
}

/** Rules `planRanges` applies across entries. */
export interface RangeRules {
  /** Total distinct hosts allowed across all entries (already validated, 1-4096). */
  maxRangeHosts: number;
  /** Accept addresses outside the private, loopback and link-local blocks. */
  allowPublicRanges: boolean;
  /** Every address must be in 127.0.0.0/8. */
  loopbackOnly: boolean;
}

/** At most this many range entries. */
export const MAX_RANGE_ENTRIES = 16;

/**
 * Parses, checks and merges every range entry. Throws `DiscoveryOptionError`
 * (`INVALID_ARGUMENT`) on the first broken rule, in this order per entry: syntax, size against
 * `maxRangeHosts`, forbidden blocks, public addresses, `loopbackOnly`; then the total of distinct
 * hosts after merging overlaps. Never expands a range.
 */
export function planRanges(entries: unknown, rules: RangeRules): RangePlan {
  if (entries === undefined) { return { ranges: [], intervals: [], totalHosts: 0 }; }
  if (!Array.isArray(entries)) {
    throw new DiscoveryOptionError('ranges', 'must be an array of range strings', showValue(entries));
  }
  if (entries.length > MAX_RANGE_ENTRIES) {
    throw new DiscoveryOptionError('ranges', `at most ${MAX_RANGE_ENTRIES} entries`, String(entries.length), MAX_RANGE_ENTRIES);
  }

  const ranges: ParsedRange[] = [];
  entries.forEach((entry, i) => {
    const field = `ranges[${i}]`;
    const r = parseRange(entry, field);
    const span: [number, number] = [r.first, r.last];
    if (r.size > rules.maxRangeHosts) {
      throw new DiscoveryOptionError(field,
        `has ${r.size} addresses, above maxRangeHosts ${rules.maxRangeHosts}`, showValue(entry), rules.maxRangeHosts);
    }
    for (const f of FORBIDDEN_BLOCKS) {
      if (overlaps(span, f.range)) {
        throw new DiscoveryOptionError(field, `touches ${f.cidr} (${f.why}), which is never scanned`, showValue(entry));
      }
    }
    if (!rules.allowPublicRanges && !PRIVATE_BLOCKS.some((b) => within(span, b))) {
      throw new DiscoveryOptionError(field,
        'reaches outside 10/8, 172.16/12, 192.168/16, 127/8 and 169.254/16; set allowPublicRanges to scan other addresses',
        showValue(entry));
    }
    if (rules.loopbackOnly && !within(span, LOOPBACK_BLOCK)) {
      throw new DiscoveryOptionError(field, 'loopbackOnly allows only addresses in 127.0.0.0/8', showValue(entry));
    }
    ranges.push(r);
  });

  const intervals = mergeIntervals(ranges.map((r) => [r.first, r.last]));
  const totalHosts = intervals.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
  if (totalHosts > rules.maxRangeHosts) {
    throw new DiscoveryOptionError('ranges',
      `${totalHosts} distinct addresses in all, above maxRangeHosts ${rules.maxRangeHosts}`, undefined, rules.maxRangeHosts);
  }
  return { ranges, intervals, totalHosts };
}

/** Sorts intervals and merges overlapping or touching ones. */
function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...list].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1] + 1) { prev[1] = Math.max(prev[1], b); }
    else { out.push([a, b]); }
  }
  return out;
}

/** Every address of a plan, once each, in ascending numeric order. Lazy: nothing is built up front. */
export function* rangeHosts(plan: RangePlan): Generator<string> {
  for (const [a, b] of plan.intervals) {
    for (let n = a; n <= b; n++) { yield formatIPv4(n); }
  }
}
