/**
 * Every `INVALID_ARGUMENT` rule of `findControllers`, checked before any socket, child process
 * or DNS lookup. Pure: this module reads nothing but its arguments.
 *
 * A broken rule throws `DiscoveryOptionError` (an `RwsError` with code `INVALID_ARGUMENT`) naming
 * the option, the rule or cap, and the value. Out-of-range numbers are refused, not clamped.
 * Unknown option keys are ignored (TypeScript checks them for typed callers).
 */

import { isIPv6 } from 'node:net';
import type { FindControllersOptions, ManualTarget, NormalizedOptions } from './types.js';
import { DiscoveryOptionError, isLoopbackIPv4, parseIPv4, planRanges, showValue } from './ranges.js';

export { DiscoveryOptionError } from './ranges.js';

/** At most this many `manual` entries. */
export const MAX_MANUAL_TARGETS = 16;
/** At most this many distinct extra `ports`. */
export const MAX_EXTRA_PORTS = 8;

/** Defaults of every numeric option, and the bounds each must stay within. */
export const DISCOVERY_LIMITS = {
  timeoutMs: { default: 1500, min: 100, max: 30000 },
  localConcurrency: { default: 32, min: 1, max: 100 },
  localMinGapMs: { default: 0, min: 0, max: 10000 },
  remoteConcurrency: { default: 8, min: 1, max: 16 },
  remoteMinGapMs: { default: 100, min: 100, max: 10000 },
  identifyConcurrency: { default: 1, min: 1, max: 4 },
  maxRangeHosts: { default: 256, min: 1, max: 4096 },
} as const;

type Bound = { readonly default: number; readonly min: number; readonly max: number };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function optBoolean(v: unknown, field: string, fallback: boolean): boolean {
  if (v === undefined) { return fallback; }
  if (typeof v !== 'boolean') { throw new DiscoveryOptionError(field, 'must be true or false', showValue(v)); }
  return v;
}

function optInteger(v: unknown, field: string, bound: Bound): number {
  if (v === undefined) { return bound.default; }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < bound.min || v > bound.max) {
    throw new DiscoveryOptionError(field, `must be an integer from ${bound.min} to ${bound.max}`,
      showValue(v), `${bound.min}-${bound.max}`);
  }
  return v;
}

function optObject(v: unknown, field: string): Record<string, unknown> {
  if (v === undefined) { return {}; }
  if (!isRecord(v)) { throw new DiscoveryOptionError(field, 'must be an object', showValue(v)); }
  return v;
}

function checkPort(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new DiscoveryOptionError(field, 'must be an integer port from 1 to 65535', showValue(v), '1-65535');
  }
  return v;
}

/** RFC 1123 host name: labels of 1-63 letters, digits and hyphens, no hyphen at either end, at most 253 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Checks a manual host: an IPv4 literal or an RFC 1123 host name. IPv6 literals are refused
 * (RobotWare does not support IPv6). A name whose last label is all digits is read as a broken
 * IPv4 literal (`'10.0.0.256'`, `'10.0.0'`) and refused. Returns the host trimmed.
 *
 * Exported for the legacy wrappers, which drop (rather than reject) a bad extra host.
 */
export function checkManualHost(v: unknown, field = 'manual[].host'): string {
  if (typeof v !== 'string') { throw new DiscoveryOptionError(field, 'must be a string', showValue(v)); }
  const host = v.trim();
  const bare = host.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (host.includes(':') && isIPv6(bare)) {
    throw new DiscoveryOptionError(field, 'IPv6 addresses are refused: RobotWare does not support IPv6', showValue(v));
  }
  if (parseIPv4(host) !== undefined) { return host; }
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  const labels = name.split('.');
  const lastLabel = labels[labels.length - 1] ?? '';
  if (name.length === 0 || name.length > 253 || !labels.every((l) => LABEL.test(l))) {
    throw new DiscoveryOptionError(field, 'must be an IPv4 address or a host name (letters, digits, hyphens and dots; no port)', showValue(v));
  }
  if (/^[0-9]+$/.test(lastLabel)) {
    throw new DiscoveryOptionError(field, 'is not a valid IPv4 address', showValue(v));
  }
  return host;
}

/** true for `'localhost'` (any case, optional trailing dot). */
const isLocalhostName = (h: string): boolean => /^localhost\.?$/i.test(h);

function checkManual(v: unknown, loopbackOnly: boolean): ManualTarget[] {
  if (v === undefined) { return []; }
  if (!Array.isArray(v)) { throw new DiscoveryOptionError('manual', 'must be an array of { host, port?, https? }', showValue(v)); }
  if (v.length > MAX_MANUAL_TARGETS) {
    throw new DiscoveryOptionError('manual', `at most ${MAX_MANUAL_TARGETS} entries`, String(v.length), MAX_MANUAL_TARGETS);
  }
  return v.map((entry: unknown, i): ManualTarget => {
    const field = `manual[${i}]`;
    if (!isRecord(entry)) { throw new DiscoveryOptionError(field, 'must be an object { host, port?, https? }', showValue(entry)); }
    const host = checkManualHost(entry.host, `${field}.host`);
    if (loopbackOnly && !isLoopbackIPv4(host) && !isLocalhostName(host)) {
      throw new DiscoveryOptionError(`${field}.host`,
        'loopbackOnly allows only 127.0.0.0/8 addresses and \'localhost\' (a host name is unknown until it is looked up)',
        showValue(entry.host));
    }
    const out: ManualTarget = { host };
    if (entry.port !== undefined) { out.port = checkPort(entry.port, `${field}.port`); }
    if (entry.https !== undefined) { out.https = optBoolean(entry.https, `${field}.https`, false); }
    return out;
  });
}

function checkPorts(v: unknown): number[] {
  if (v === undefined) { return []; }
  if (!Array.isArray(v)) { throw new DiscoveryOptionError('ports', 'must be an array of ports', showValue(v)); }
  const ports = [...new Set(v.map((p: unknown, i) => checkPort(p, `ports[${i}]`)))];
  if (ports.length > MAX_EXTRA_PORTS) {
    throw new DiscoveryOptionError('ports', `at most ${MAX_EXTRA_PORTS} distinct ports`, String(ports.length), MAX_EXTRA_PORTS);
  }
  return ports;
}

function checkCredentials(v: unknown, identify: NormalizedOptions['identify']): NormalizedOptions['credentials'] {
  if (v === undefined) { return {}; }
  if (!isRecord(v)) { throw new DiscoveryOptionError('credentials', 'must be an object keyed by controller', showValue(v)); }
  const keys = Object.keys(v);
  if (keys.length > 0 && identify !== 'with-credentials') {
    throw new DiscoveryOptionError('credentials', 'are allowed only with identify: \'with-credentials\'',
      showValue(identify));
  }
  const out: NormalizedOptions['credentials'] = {};
  for (const key of keys) {
    // Never echo a credential: the error names the key only.
    const field = `credentials[${JSON.stringify(key)}]`;
    if (key.trim().length === 0) { throw new DiscoveryOptionError('credentials', 'keys must be non-empty'); }
    const c = v[key];
    if (!isRecord(c)) { throw new DiscoveryOptionError(field, 'must be { username, password }'); }
    if (typeof c.username !== 'string' || c.username.length === 0) {
      throw new DiscoveryOptionError(`${field}.username`, 'must be a non-empty string');
    }
    if (typeof c.password !== 'string') {
      throw new DiscoveryOptionError(`${field}.password`, 'must be a string');
    }
    out[key] = { username: c.username, password: c.password };
  }
  return out;
}

function checkFingerprints(v: unknown): Record<string, string> {
  if (v === undefined) { return {}; }
  if (!isRecord(v)) { throw new DiscoveryOptionError('pinnedFingerprints', 'must be an object keyed by controller', showValue(v)); }
  const out: Record<string, string> = {};
  for (const [key, fp] of Object.entries(v)) {
    const field = `pinnedFingerprints[${JSON.stringify(key)}]`;
    if (key.trim().length === 0) { throw new DiscoveryOptionError('pinnedFingerprints', 'keys must be non-empty'); }
    const hex = typeof fp === 'string' ? fp.trim().replace(/:/g, '') : '';
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new DiscoveryOptionError(field, 'must be a SHA-256 fingerprint: 64 hex digits, colons allowed', showValue(fp));
    }
    out[key] = hex.toLowerCase();
  }
  return out;
}

const isAbortSignalLike = (v: unknown): v is AbortSignal =>
  typeof v === 'object' && v !== null &&
  typeof (v as { aborted?: unknown }).aborted === 'boolean' &&
  typeof (v as { addEventListener?: unknown }).addEventListener === 'function';

/**
 * Checks `findControllers` options and fills every default. Throws `DiscoveryOptionError`
 * (`INVALID_ARGUMENT`) on the first broken rule. Pure; sends nothing.
 *
 * - `loopbackOnly`: `serviceAddress` must be false (`true` and `'auto'` refused), `mdns` false,
 *   every manual host in 127.0.0.0/8 or `'localhost'`, every range address in 127.0.0.0/8.
 * - `manual`: at most 16; host an IPv4 literal or host name (IPv6 refused); port 1-65535; https boolean.
 * - `ports`: integers 1-65535, duplicates removed, at most 8 distinct.
 * - `ranges`: at most 16 entries, sized by arithmetic, at most `maxRangeHosts` distinct hosts in
 *   all; forbidden and public blocks as in `planRanges`.
 * - Numbers: finite integers within the bounds of `DISCOVERY_LIMITS`.
 * - `credentials`: only with `identify: 'with-credentials'` (an empty map is let through); each
 *   value `{ username: non-empty string, password: string }`, so a map loaded from JSON with a
 *   missing field never falls through to a default user.
 * - `pinnedFingerprints`: 64 hex digits, colons allowed; normalised to lower case without colons.
 *
 * @param platform resolves `filterToVcProcesses` (default true on Windows, false elsewhere) and
 *   `knownPortsOnly` (off Windows, unless `filterToVcProcesses` is false).
 */
export function validateFindOptions(options?: FindControllersOptions, platform: NodeJS.Platform = process.platform): NormalizedOptions {
  if (options !== undefined && !isRecord(options)) {
    throw new DiscoveryOptionError('options', 'must be an object', showValue(options));
  }
  const o: Record<string, unknown> = options ?? {};

  const loopbackOnly = optBoolean(o.loopbackOnly, 'loopbackOnly', false);
  const local = optBoolean(o.local, 'local', true);

  let serviceAddress: boolean | 'auto';
  if (o.serviceAddress === undefined) { serviceAddress = false; }
  else if (typeof o.serviceAddress === 'boolean' || o.serviceAddress === 'auto') { serviceAddress = o.serviceAddress; }
  else { throw new DiscoveryOptionError('serviceAddress', 'must be true, false or \'auto\'', showValue(o.serviceAddress)); }
  if (loopbackOnly && serviceAddress !== false) {
    throw new DiscoveryOptionError('serviceAddress', 'must be false with loopbackOnly (192.168.125.1 is not on this PC)',
      showValue(serviceAddress));
  }

  const mdns = optBoolean(o.mdns, 'mdns', false);
  if (loopbackOnly && mdns) {
    throw new DiscoveryOptionError('mdns', 'must be false with loopbackOnly (the query is multicast on the network)', 'true');
  }

  let identify: NormalizedOptions['identify'] = 'anonymous';
  if (o.identify !== undefined) {
    if (o.identify !== 'none' && o.identify !== 'anonymous' && o.identify !== 'with-credentials') {
      throw new DiscoveryOptionError('identify', 'must be \'none\', \'anonymous\' or \'with-credentials\'', showValue(o.identify));
    }
    identify = o.identify;
  }

  const timeoutMs = optInteger(o.timeoutMs, 'timeoutMs', DISCOVERY_LIMITS.timeoutMs);
  const pacingIn = optObject(o.pacing, 'pacing');
  const localIn = optObject(pacingIn.local, 'pacing.local');
  const remoteIn = optObject(pacingIn.remote, 'pacing.remote');
  const pacing: NormalizedOptions['pacing'] = {
    local: {
      concurrency: optInteger(localIn.concurrency, 'pacing.local.concurrency', DISCOVERY_LIMITS.localConcurrency),
      minGapMs: optInteger(localIn.minGapMs, 'pacing.local.minGapMs', DISCOVERY_LIMITS.localMinGapMs),
    },
    remote: {
      concurrency: optInteger(remoteIn.concurrency, 'pacing.remote.concurrency', DISCOVERY_LIMITS.remoteConcurrency),
      minGapMs: optInteger(remoteIn.minGapMs, 'pacing.remote.minGapMs', DISCOVERY_LIMITS.remoteMinGapMs),
    },
    identifyConcurrency: optInteger(pacingIn.identifyConcurrency, 'pacing.identifyConcurrency', DISCOVERY_LIMITS.identifyConcurrency),
  };
  const maxRangeHosts = optInteger(o.maxRangeHosts, 'maxRangeHosts', DISCOVERY_LIMITS.maxRangeHosts);
  const allowPublicRanges = optBoolean(o.allowPublicRanges, 'allowPublicRanges', false);

  const manual = checkManual(o.manual, loopbackOnly);
  const ports = checkPorts(o.ports);
  const ranges = planRanges(o.ranges, { maxRangeHosts, allowPublicRanges, loopbackOnly });

  const credentials = checkCredentials(o.credentials, identify);
  const strictTls = optBoolean(o.strictTls, 'strictTls', false);
  const pinnedFingerprints = checkFingerprints(o.pinnedFingerprints);

  const filterRequested = optBoolean(o.filterToVcProcesses, 'filterToVcProcesses', true);
  const fallbackIn = optObject(o.localFallback, 'localFallback');
  const localFallback = {
    powershell: optBoolean(fallbackIn.powershell, 'localFallback.powershell', false),
    sweep: optBoolean(fallbackIn.sweep, 'localFallback.sweep', false),
  };

  if (o.signal !== undefined && !isAbortSignalLike(o.signal)) {
    throw new DiscoveryOptionError('signal', 'must be an AbortSignal', showValue(o.signal));
  }
  if (o.onProgress !== undefined && typeof o.onProgress !== 'function') {
    throw new DiscoveryOptionError('onProgress', 'must be a function', showValue(o.onProgress));
  }

  const out: NormalizedOptions = {
    loopbackOnly,
    local,
    serviceAddress,
    manual,
    ranges,
    ports,
    mdns,
    identify,
    credentials,
    strictTls,
    pinnedFingerprints,
    filterToVcProcesses: platform === 'win32' && filterRequested,
    knownPortsOnly: platform !== 'win32' && filterRequested,
    localFallback,
    timeoutMs,
    pacing,
    maxRangeHosts,
    allowPublicRanges,
  };
  if (o.signal !== undefined) { out.signal = o.signal as AbortSignal; }
  if (o.onProgress !== undefined) { out.onProgress = o.onProgress as NormalizedOptions['onProgress']; }
  return out;
}
