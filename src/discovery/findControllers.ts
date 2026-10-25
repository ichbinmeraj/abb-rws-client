/**
 * `findControllers`: one call that finds ABB RWS controllers from every source the caller allows
 * and returns one merged entry per controller.
 *
 * Order of work:
 * 1. Validate every option (`validate.ts`). A bad value rejects with `INVALID_ARGUMENT` before
 *    any socket, child process or DNS lookup.
 * 2. In parallel: the listening-port scan of this PC (plus, on Windows, the process list that
 *    tells virtual-controller ports apart), one mDNS query when `mdns` is on, and one IPv4 lookup
 *    per manual host name.
 * 3. Plan the probes: one unit per (host, port, scheme). Loopback targets go to the local lane;
 *    other hosts to the paced remote lane (443 and 80 plus `ports`, HTTPS first, plain HTTP only
 *    where HTTPS found an open port that does not speak TLS or does not answer its handshake). The same connection asked for by
 *    two sources is made once.
 * 4. Run the probes (`scheduler.ts`). Meanwhile, under `identify` other than `'none'`, read the
 *    system folders of the local virtual controllers (Windows, no network).
 * 5. Merge (`merge.ts`). Under `'with-credentials'`, log in to each identified entry that has a
 *    matching credentials entry (`identify.ts`), then merge again with what the logins read.
 *
 * What goes on the wire, per kind of target:
 * - This PC: one unauthenticated `GET /rw/system` per listening port that may be RWS, on
 *   127.0.0.1 (or ::1 once, after a refusal, for a port bound to IPv6 "any" only).
 * - Service address (only with `serviceAddress`), manual hosts and range addresses: at most 3
 *   connections per host for 443 and 80, plus at most 2 per extra port, at most 2 at a time per
 *   host, at least 100 ms apart (default).
 * - mDNS (only with `mdns`): one query to 224.0.0.251:5353 per IPv4 interface, re-sent twice.
 * - Logins (only with `identify: 'with-credentials'` and a matching credentials entry): one per
 *   entry, one at a time by default, each followed by `/logout`.
 *
 * `runDiscovery` is the internal form: it also takes the compatibility flags the legacy
 * `RobotManager` wrappers need, and replaceable I/O for unit tests.
 */

import * as dgram from 'dgram';
import * as os from 'os';
import { Logger } from '../Logger.js';
import { discoverControllersMdns, type MdnsController, type MdnsSocket } from '../MdnsDiscovery.js';
import { canonicalHost, discoveryKeyWith, localAddressChecker, resolveIPv4 } from './addresses.js';
import { detectEnvironment, environmentNotes } from './environment.js';
import { identifyOverNetwork, type IdentifyOverNetworkOptions, type IdentifyOverNetworkResult, type IdentifyRow } from './identify.js';
import {
  localListeners, selectLocalTargets, skippedLocalScan,
  type LocalListenersOptions, type LocalProbeTarget,
} from './listeningPorts.js';
import { mergeFound } from './merge.js';
import { probeOne } from './probe.js';
import {
  pidImages, vcImageOf, vcProcessDetails,
  type ProcessReadOptions, type RunFailure, type VcDetailsOptions,
} from './processes.js';
import { parseIPv4, rangeHosts } from './ranges.js';
import { KNOWN_RWS_PORTS, REMOTE_RWS_PORTS, candidatesForPort, schemeForPort } from './scheme.js';
import { isLoopbackHost, runProbes, sweepOpenPorts, type SweepOptions } from './scheduler.js';
import { validateFindOptions } from './validate.js';
import type {
  ControllerSource,
  DiscoveryEnvironment,
  DiscoveryProgress,
  FindControllersOptions,
  FindControllersResult,
  FoundController,
  IdentifyOutcome,
  LocalListeners,
  LocalScanReport,
  LocalScanStatus,
  PidImageMap,
  ProbeHit,
  ProbeOptions,
  ProbeOutcome,
  ProbeUnit,
  ResolvedName,
  RunDiscoveryOptions,
  VcProcessDetails,
} from './types.js';

/** The ABB controller service port address. */
export const SERVICE_ADDRESS = '192.168.125.1';

/** How long the mDNS query collects answers, ms. */
export const MDNS_COLLECT_MS = 2000;

/** Local lane budget of the legacy `discoverLocalControllers` (both schemes on 100 ports at once, as before). */
const COMPAT_LOCAL_LANE = { concurrency: 200, minGapMs: 0 } as const;

/** Listening-port outcomes that mean "the OS could not be asked". */
const SCAN_FAILED: ReadonlySet<LocalScanStatus> = new Set(['missing', 'timeout', 'failed', 'unrecognised']);

// ---------------------------------------------------------------------------
// Replaceable I/O
// ---------------------------------------------------------------------------

/** Everything the orchestrator does to the outside world. Unit tests replace any part. */
export interface DiscoveryDeps {
  platform: NodeJS.Platform;
  probe: (host: string, port: number, https: boolean, opts: ProbeOptions) => Promise<ProbeOutcome>;
  localListeners: (opts: LocalListenersOptions) => Promise<LocalListeners>;
  pidImages: (opts: ProcessReadOptions) => Promise<{ status: 'ok'; images: PidImageMap } | RunFailure>;
  vcProcessDetails: (
    processes: ReadonlyArray<{ pid: number; image?: string }>, opts: VcDetailsOptions,
  ) => Promise<{ details: Map<number, VcProcessDetails>; notes: string[] }>;
  identifyOverNetwork: (rows: readonly IdentifyRow[], opts: IdentifyOverNetworkOptions) => Promise<IdentifyOverNetworkResult>;
  mdns: (opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<MdnsController[]>;
  resolveIPv4: (name: string) => Promise<ResolvedName>;
  detectEnvironment: () => DiscoveryEnvironment;
  localAddressChecker: () => (host: string) => boolean;
  /** This PC's IPv4 interface addresses (for `serviceAddress: 'auto'`). */
  ipv4InterfaceAddresses: () => string[];
  sweep: (host: string, opts: SweepOptions) => Promise<{ open: number[]; complete: boolean }>;
}

/** This PC's IPv4 interface addresses. Node reports the family as `'IPv4'` or, on some versions, `4`. */
function ipv4InterfaceAddresses(): string[] {
  const out: string[] = [];
  let table: ReturnType<typeof os.networkInterfaces>;
  try { table = os.networkInterfaces(); } catch { return out; }
  for (const list of Object.values(table)) {
    for (const info of list ?? []) {
      const family = info.family as unknown;
      if (family === 'IPv4' || family === 4) { out.push(info.address); }
    }
  }
  return out;
}

/**
 * One mDNS browse that a signal can stop: on abort the socket reports an error, so the browse
 * closes it and resolves with what it heard. Resolves once the socket has closed.
 */
async function mdnsWithSignal(opts: { timeoutMs: number; signal?: AbortSignal }): Promise<MdnsController[]> {
  const { signal } = opts;
  if (signal?.aborted) { return []; }
  const closed: Array<Promise<void>> = [];
  const found = await discoverControllersMdns({
    timeoutMs: opts.timeoutMs,
    socketFactory: (): MdnsSocket => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      closed.push(new Promise<void>(resolve => socket.once('close', () => resolve())));
      if (signal) {
        const onAbort = (): void => { socket.emit('error', new Error('discovery cancelled')); };
        signal.addEventListener('abort', onAbort, { once: true });
        socket.once('close', () => signal.removeEventListener('abort', onAbort));
      }
      return socket;
    },
  });
  // The browse has called close(); the handle closes on a later tick. Wait for it, briefly.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(closed),
    new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
  ]);
  clearTimeout(timer);
  return found;
}

function defaultDeps(): DiscoveryDeps {
  return {
    platform: process.platform,
    probe: probeOne,
    localListeners,
    pidImages: opts => pidImages(opts),
    vcProcessDetails,
    identifyOverNetwork,
    mdns: mdnsWithSignal,
    resolveIPv4: name => resolveIPv4(name),
    detectEnvironment: () => detectEnvironment(),
    localAddressChecker,
    ipv4InterfaceAddresses,
    sweep: sweepOpenPorts,
  };
}

// ---------------------------------------------------------------------------
// Probe plan
// ---------------------------------------------------------------------------

interface Planned {
  unit: ProbeUnit;
  /** Every source that asked for this connection, first first. */
  sources: ControllerSource[];
  /** Remote HTTPS attempt on a port with no fixed scheme: plain HTTP follows a failed or unanswered TLS handshake on an open port. */
  httpFallback: boolean;
}

const unitKey = (u: { host: string; port: number; https: boolean }): string => `${u.host}|${u.port}|${u.https ? 's' : 'p'}`;

/** The units of one run, one per (host, port, scheme), with every source that asked for each. */
class ProbePlan {
  private readonly planned = new Map<string, Planned>();

  /** Adds a unit, or merges its source, name and process into the same connection planned earlier. Returns true when new. */
  add(unit: ProbeUnit, httpFallback = false): boolean {
    const k = unitKey(unit);
    const p = this.planned.get(k);
    if (!p) {
      this.planned.set(k, { unit, sources: [unit.source], httpFallback });
      return true;
    }
    if (!p.sources.includes(unit.source)) { p.sources.push(unit.source); }
    if (p.unit.name === undefined && unit.name !== undefined) { p.unit.name = unit.name; }
    if (p.unit.pid === undefined && unit.pid !== undefined) { p.unit.pid = unit.pid; }
    if (unit.retryOnIpv6Loopback && !p.unit.retryOnIpv6Loopback) { p.unit.retryOnIpv6Loopback = true; }
    p.httpFallback = p.httpFallback || httpFallback;
    return false;
  }

  get(unit: ProbeUnit): Planned | undefined { return this.planned.get(unitKey(unit)); }

  has(unit: { host: string; port: number; https: boolean }): boolean { return this.planned.has(unitKey(unit)); }

  units(): ProbeUnit[] { return [...this.planned.values()].map(p => p.unit); }

  /** One hit per source that asked for the connection. */
  expand(hits: readonly ProbeHit[]): ProbeHit[] {
    const out: ProbeHit[] = [];
    for (const h of hits) {
      for (const source of this.get(h.unit)?.sources ?? [h.unit.source]) {
        out.push(source === h.unit.source ? h : { unit: { ...h.unit, source }, outcome: h.outcome });
      }
    }
    return out;
  }
}

/** Ports in order, each once. */
function uniquePorts(ports: Iterable<number>): number[] {
  return [...new Set(ports)];
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** `findControllers`' result plus the raw probe hits the legacy wrappers convert. Internal. */
export interface DiscoveryRun extends FindControllersResult {
  /** Every finished probe, one per source that asked for it. */
  hits: ProbeHit[];
}

/** `'host:port/scheme'`, IPv6 in brackets. */
function unitLabel(u: { host: string; port: number; https: boolean }): string {
  const host = u.host.includes(':') ? `[${u.host}]` : u.host;
  return `${host}:${u.port}/${u.https ? 'https' : 'http'}`;
}

/** Resolves with `fallback` as soon as the signal aborts. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
  if (!signal) { return work; }
  if (signal.aborted) { return Promise.resolve(fallback); }
  return new Promise<T>(resolve => {
    const onAbort = (): void => resolve(fallback);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      () => { signal.removeEventListener('abort', onAbort); resolve(fallback); });
  });
}

function failureWords(f: RunFailure): string {
  switch (f.status) {
    case 'missing': return 'tasklist is not available';
    case 'timeout': return 'the process list timed out';
    case 'unrecognised': return 'the process list was not understood';
    case 'aborted': return 'discovery was cancelled';
    default: return `the process list failed${f.detail ? ` (${f.detail})` : ''}`;
  }
}

/** `'netstat -ano: not available'`, one clause per listening-port source that ran, in order. */
function scanFailureWords(report: LocalScanReport): string {
  const words: Record<LocalScanStatus, string> = {
    ok: 'answered', missing: 'not available', timeout: 'timed out', failed: 'failed',
    unrecognised: 'output not understood', skipped: 'not run',
  };
  const tried = report.attempts.filter(a => a.status !== 'skipped');
  if (tried.length === 0) { return report.source ? `${report.source}: ${words[report.status]}` : words[report.status]; }
  return tried.map(a => `${a.source}: ${words[a.status]}`).join('; ');
}

/**
 * The internal discovery run. Takes `FindControllersOptions` plus the legacy flags of
 * `RunDiscoveryOptions`, and replaceable I/O. Rejects only for invalid options.
 */
export async function runDiscovery(options?: RunDiscoveryOptions, overrides: Partial<DiscoveryDeps> = {}): Promise<DiscoveryRun> {
  const deps: DiscoveryDeps = { ...defaultDeps(), ...overrides };
  const o = validateFindOptions(options, deps.platform);
  const compat = options?.compat === true;
  const { signal } = o;

  // --- progress -----------------------------------------------------------
  let progressWarned = false;
  let probed = 0;
  let total = 0;
  const foundKeys = new Set<string>();
  let localScan: LocalScanReport | undefined;
  const emit = (e: Omit<DiscoveryProgress, 'probed' | 'total' | 'found'> & Partial<DiscoveryProgress>): void => {
    if (!o.onProgress) { return; }
    const event: DiscoveryProgress = {
      probed, total, found: foundKeys.size,
      ...(localScan ? { localScan: { ...localScan, attempts: [...localScan.attempts] } } : {}),
      ...e,
    };
    try {
      o.onProgress(event);
    } catch (err) {
      if (!progressWarned) {
        progressWarned = true;
        Logger.warn(`findControllers: onProgress threw (${err instanceof Error ? err.message : String(err)}); discovery continues`);
      }
    }
  };

  const notes: string[] = [];
  const environment = deps.detectEnvironment();
  notes.push(...environmentNotes(environment));
  const isLocal = deps.localAddressChecker();
  const keyOf = (host: string, port: number): string => discoveryKeyWith(isLocal, host, port);

  // --- mDNS, started first: it only listens while the rest runs ------------
  let mdnsDone: Promise<MdnsController[]> = Promise.resolve([]);
  if (o.mdns && !signal?.aborted) {
    emit({ phase: 'mdns' });
    mdnsDone = deps.mdns({ timeoutMs: MDNS_COLLECT_MS, signal }).catch(() => []);
  }

  // --- manual host names: one IPv4 lookup each, alongside the scan ---------
  const lookups = new Map<string, Promise<ResolvedName>>();
  for (const m of o.manual) {
    const h = canonicalHost(m.host);
    if (h === 'localhost' || parseIPv4(h) !== undefined || lookups.has(m.host)) { continue; }
    lookups.set(m.host, unlessAborted(deps.resolveIPv4(m.host), signal,
      { name: m.host, note: `${m.host}: not looked up, discovery was cancelled` }));
  }

  // --- listening-port scan of this PC ---------------------------------------
  let listeners: LocalListeners = skippedLocalScan();
  let images: PidImageMap | undefined;
  let vcFilter: LocalScanReport['vcFilter'] = 'off';
  let sweepRan = false;
  let localTargets: LocalProbeTarget[] = [];
  if (o.local) {
    emit({ phase: 'local-scan' });
    const wantImages = !compat && deps.platform === 'win32' && (o.filterToVcProcesses || o.identify !== 'none');
    const [scan, imageList] = await Promise.all([
      deps.localListeners({ platform: deps.platform, signal, powershell: o.localFallback.powershell }),
      wantImages ? deps.pidImages({ signal }) : Promise.resolve(undefined),
    ]);
    listeners = scan;
    if (imageList?.status === 'ok') { images = imageList.images; }
    if (o.filterToVcProcesses) {
      if (images) {
        vcFilter = 'on';
      } else {
        vcFilter = 'failed';
        if (imageList && imageList.status !== 'ok' && imageList.status !== 'aborted' && !signal?.aborted) {
          notes.push(`Could not tell which listening ports belong to RobotStudio virtual controllers (${failureWords(imageList)}); `
            + 'every listening port on this PC was probed, except ports of industrial protocols.');
        }
      }
    }
    const vcPids = images
      ? new Set([...images].filter(([, image]) => vcImageOf(image) !== undefined).map(([pid]) => pid))
      : undefined;
    localTargets = selectLocalTargets(listeners.ports, { vcPids, filterToVc: vcFilter === 'on' });
    if (!compat && o.knownPortsOnly) {
      // Off Windows no VC process can own a port: probe only where an RWS server is expected.
      const wanted = new Set([...KNOWN_RWS_PORTS.map(e => e.port), ...o.ports]);
      localTargets = localTargets.filter(t => wanted.has(t.port));
    }

    if (!compat && o.localFallback.sweep && deps.platform === 'win32' && !signal?.aborted
        && SCAN_FAILED.has(listeners.report.status)) {
      sweepRan = true;
      localScan = { ...listeners.report, vcFilter: 'off', sweep: true };
      emit({ phase: 'sweep', probed: 0, total: 0 });
      const swept = await deps.sweep('127.0.0.1', {
        signal,
        onProgress: (done, all) => emit({ phase: 'sweep', probed: done, total: all }),
      });
      localTargets = swept.open.map(port => ({ host: '127.0.0.1', port, retryOnIpv6Loopback: false }));
      vcFilter = 'off';
      Logger.info(`local scan: blind sweep found ${swept.open.length} open port(s)${swept.complete ? '' : ' (stopped early)'}`);
    }
  }
  if (o.local && !sweepRan && !signal?.aborted && SCAN_FAILED.has(listeners.report.status)) {
    // Without this, a consumer that shows notes only would report "no controllers on this PC"
    // when the OS was never asked.
    notes.push(`Could not list this PC's listening ports (${scanFailureWords(listeners.report)}); `
      + 'virtual controllers on this PC were not searched. Enter 127.0.0.1:<port> to add one.');
  }
  localScan = { ...listeners.report, vcFilter, sweep: sweepRan };
  if (o.local) { emit({ phase: 'local-scan' }); }

  // --- local system folders of the virtual controllers (no network) ---------
  let vcDetailsDone: Promise<{ details: Map<number, VcProcessDetails>; notes: string[] }> =
    Promise.resolve({ details: new Map(), notes: [] });
  if (!compat && o.identify !== 'none' && deps.platform === 'win32' && images && !signal?.aborted) {
    const imgs = images;
    const processes = localTargets
      .filter((t): t is LocalProbeTarget & { pid: number } => t.pid !== undefined)
      .map(t => ({ pid: t.pid, image: imgs.get(t.pid) }));
    if (processes.length > 0) {
      vcDetailsDone = deps.vcProcessDetails(processes, { signal, platform: deps.platform })
        .catch(() => ({ details: new Map<number, VcProcessDetails>(), notes: [] }));
    }
  }

  // --- the plan ---------------------------------------------------------------
  const plan = new ProbePlan();
  const probeHost = compat && options?.localProbeHost !== undefined
    ? (canonicalHost(options.localProbeHost) === 'localhost' ? '127.0.0.1' : options.localProbeHost)
    : undefined;
  const probeHostLane: ProbeUnit['lane'] = probeHost === undefined || isLoopbackHost(probeHost) || isLocal(probeHost) ? 'local' : 'remote';

  for (const t of localTargets) {
    if (probeHost !== undefined) {
      // Legacy: the given host, on every listening port, both schemes at once.
      for (const https of [true, false]) {
        plan.add({ host: probeHost, port: t.port, https, lane: probeHostLane, source: 'this-pc', ...(t.pid !== undefined ? { pid: t.pid } : {}) });
      }
      continue;
    }
    for (const c of candidatesForPort(t.port)) {
      plan.add({
        host: t.host, port: t.port, https: c.https, lane: 'local', source: 'this-pc',
        ...(t.pid !== undefined ? { pid: t.pid } : {}),
        ...(t.retryOnIpv6Loopback ? { retryOnIpv6Loopback: true } : {}),
      });
    }
  }

  /** Plan one host the caller named (service address, manual, range). */
  const addHost = (host: string, port: number | undefined, https: boolean | undefined, source: ControllerSource, name?: string): void => {
    const base = { host, source, ...(name !== undefined ? { name } : {}) };
    if (isLoopbackHost(host)) {
      // This PC: every scheme of a port at once; the virtual-controller ports too.
      const ports = port !== undefined ? [port] : uniquePorts([...KNOWN_RWS_PORTS.map(e => e.port), ...o.ports]);
      for (const p of ports) {
        for (const c of candidatesForPort(p, https)) { plan.add({ ...base, port: p, https: c.https, lane: 'local' }); }
      }
      return;
    }
    // Another host: 443 and 80 (+ ports); one scheme at a time, plain HTTP only after the TLS
    // handshake failed or went unanswered on an open port.
    const ports = port !== undefined ? [port] : uniquePorts([...REMOTE_RWS_PORTS.map(e => e.port), ...o.ports]);
    for (const p of ports) {
      const scheme = https !== undefined ? (https ? 'https' : 'http') : schemeForPort(p);
      if (scheme === 'http') {
        plan.add({ ...base, port: p, https: false, lane: 'remote' });
      } else {
        plan.add({ ...base, port: p, https: true, lane: 'remote' }, scheme === 'either');
      }
    }
  };

  if (o.serviceAddress === true
      || (o.serviceAddress === 'auto' && deps.ipv4InterfaceAddresses().some(a => a.startsWith('192.168.125.')))) {
    addHost(SERVICE_ADDRESS, undefined, undefined, 'service-address');
  }

  const resolved = new Map<string, ResolvedName>();
  await Promise.all([...lookups].map(async ([name, p]) => { resolved.set(name, await p); }));
  for (const r of resolved.values()) { if (r.note) { notes.push(r.note); } }
  for (const m of o.manual) {
    const h = canonicalHost(m.host);
    if (h === 'localhost') { addHost('127.0.0.1', m.port, m.https, 'manual', m.host); continue; }
    if (parseIPv4(h) !== undefined) { addHost(h, m.port, m.https, 'manual'); continue; }
    const ipv4 = resolved.get(m.host)?.ipv4;
    if (ipv4 === undefined) { continue; }
    if (o.loopbackOnly && !isLoopbackHost(ipv4)) {
      notes.push(`${m.host}: resolved to ${ipv4}, which is not on this PC's loopback; skipped (loopbackOnly)`);
      continue;
    }
    addHost(ipv4, m.port, m.https, 'manual', m.host);
  }
  for (const address of rangeHosts(o.ranges)) { addHost(address, undefined, undefined, 'range'); }

  // --- probes -----------------------------------------------------------------
  const units = plan.units();
  total = units.length;
  const tlsFailures: FindControllersResult['tlsFailures'] = [];
  const probeOpts = { timeoutMs: o.timeoutMs, strictTls: o.strictTls };
  const run = await runProbes(units, {
    local: compat ? COMPAT_LOCAL_LANE : o.pacing.local,
    remote: o.pacing.remote,
    signal,
    probe: (unit, sig) => deps.probe(unit.host, unit.port, unit.https, { ...probeOpts, ...(sig ? { signal: sig } : {}) }),
    followUp: (hit): ProbeUnit[] => {
      const { unit, outcome } = hit;
      const planned = plan.get(unit);
      const next: ProbeUnit[] = [];
      const follow = (u: ProbeUnit): void => {
        if (plan.has(u)) { return; }
        plan.add(u);
        const p = plan.get(u);
        if (p && planned) { for (const s of planned.sources) { if (!p.sources.includes(s)) { p.sources.push(s); } } }
        next.push(u);
      };
      if (unit.lane === 'remote' && unit.https && planned?.httpFallback
          && (outcome.kind === 'tls-failed' || outcome.kind === 'tls-timeout')) {
        follow({ ...unit, https: false, fallback: true });
      }
      if (unit.retryOnIpv6Loopback && outcome.kind === 'refused') {
        const retry: ProbeUnit = { ...unit, host: '::1' };
        delete retry.retryOnIpv6Loopback;
        follow(retry);
      }
      return next;
    },
    onDone: (hit, counts) => {
      probed = counts.probed;
      total = counts.total;
      const { unit, outcome } = hit;
      if (outcome.kind === 'tls-unverified') {
        tlsFailures.push({
          host: unit.host, port: unit.port,
          ...(outcome.fingerprint !== undefined ? { fingerprint: outcome.fingerprint } : {}),
          error: outcome.error,
        });
      }
      if (outcome.kind === 'rws' || outcome.kind === 'other-401') { foundKeys.add(keyOf(unit.host, unit.port)); }
      emit({ phase: 'probe', current: unitLabel(unit) });
    },
  });
  const hits = plan.expand(run.hits);

  // --- merge, then logins ------------------------------------------------------
  const [mdns, vc] = await Promise.all([mdnsDone, vcDetailsDone]);
  notes.push(...vc.notes);
  const mergeInput = {
    hits,
    mdns,
    ...(images ? { pidImages: images } : {}),
    vcDetails: [...vc.details.values()],
    isLocal,
  };
  let controllers: FoundController[] = mergeFound(mergeInput);
  let unmatchedCredentials: string[] = [];
  if (o.identify === 'with-credentials') {
    const id = await deps.identifyOverNetwork(controllers, {
      credentials: o.credentials,
      pinnedFingerprints: o.pinnedFingerprints,
      tlsFailures,
      strictTls: o.strictTls,
      concurrency: o.pacing.identifyConcurrency,
      isLocal,
      ...(signal ? { signal } : {}),
      onLogin: key => emit({ phase: 'identify', current: key }),
    });
    unmatchedCredentials = id.unmatchedCredentials;
    notes.push(...id.notes);
    const identities: IdentifyOutcome[] = id.outcomes;
    if (identities.some(x => x.status === 'identified')) {
      controllers = mergeFound({ ...mergeInput, identities });
    }
  }

  const aborted = signal?.aborted === true;
  emit({ phase: 'done', found: controllers.length });
  Logger.info(`discovery: ${controllers.length} controller(s) from ${probed} probe(s)${aborted ? ' (cancelled)' : ''}`);
  return {
    controllers,
    aborted,
    localScan,
    environment,
    tlsFailures,
    unmatchedCredentials,
    notes,
    hits,
  };
}

/**
 * Find ABB RWS controllers from every source the options allow, one merged entry per controller.
 *
 * With no options it scans this PC's listening ports and probes the ones that may be RWS on the
 * loopback address: nothing leaves this PC. The service address (192.168.125.1), manual hosts,
 * ranges and mDNS are each off unless asked for. See `FindControllersOptions` for every switch,
 * what each sends, and the limits.
 *
 * Rejects only for invalid options (`RwsError` `INVALID_ARGUMENT`, before anything is sent). A
 * cancel through `signal` resolves with `aborted: true` and the entries found so far, once every
 * socket has closed and every login already sent has logged out.
 */
export async function findControllers(options?: FindControllersOptions): Promise<FindControllersResult> {
  let publicOptions: FindControllersOptions | undefined = options;
  if (options !== null && typeof options === 'object' && !Array.isArray(options)) {
    // The legacy flags are internal; a caller cannot switch them on through the public entry point.
    const copy: Record<string, unknown> = { ...options };
    delete copy.localProbeHost;
    delete copy.compat;
    publicOptions = copy as FindControllersOptions;
  }
  const run = await runDiscovery(publicOptions);
  return {
    controllers: run.controllers,
    aborted: run.aborted,
    localScan: run.localScan,
    environment: run.environment,
    tlsFailures: run.tlsFailures,
    unmatchedCredentials: run.unmatchedCredentials,
    notes: run.notes,
  };
}
