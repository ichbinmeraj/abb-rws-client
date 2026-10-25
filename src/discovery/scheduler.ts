/**
 * Probe scheduling for discovery: two lanes, socket budgets, pacing, cancel.
 *
 * A unit is one (host, port, scheme) connection, so every budget here counts sockets, not
 * workers.
 * - Local lane (loopback targets): `concurrency` sockets in flight, at least `minGapMs` between
 *   new connections. Defaults 32 and 0 ms; a live test on RobotStudio VCs uses 1 and 1000 ms.
 * - Remote lane (other hosts): at most `concurrency` sockets (default 8), at least `minGapMs`
 *   between new connections (default 100 ms, so at most 10 per second), at most 2 in flight to
 *   one host, hosts taken in numeric address order.
 * Both lanes run at the same time. A unit that finishes may schedule follow-ups (plain HTTP after
 * HTTPS found an open port that does not speak TLS; `::1` after 127.0.0.1 was refused), which
 * join the front of their lane's queue and obey the same budgets.
 *
 * Cancel: after an abort no new unit starts; the units in flight get the signal (the probe
 * destroys its socket), and `runProbes` resolves only after every one of them has settled. A
 * probe settles only after its socket has closed, so no socket is left open on return.
 *
 * Also here: the opt-in blind sweep of the loopback address (`sweepOpenPorts`), used by
 * `RobotManager.wideHostScan` and by `findControllers` with `localFallback.sweep`.
 */

import * as net from 'node:net';
import { RwsError } from '../types.js';
import { canonicalHost } from './addresses.js';
import { DENIED_LOCAL_PORTS } from './listeningPorts.js';
import { parseIPv4 } from './ranges.js';
import type { ProbeHit, ProbeOutcome, ProbeUnit } from './types.js';

/** Socket budget of one lane. */
export interface LanePacing {
  /** Sockets in flight, at least 1. */
  concurrency: number;
  /** Least time between the starts of two connections in this lane, ms. */
  minGapMs: number;
  /** At most this many sockets in flight to one host; undefined = no per-host cap. */
  perHost?: number;
}

/** At most this many connections in flight to one host in the remote lane. */
export const REMOTE_PER_HOST = 2;

/** Counters passed with every finished unit. */
export interface ProbeCounts {
  /** Units finished so far (including this one). */
  probed: number;
  /** Units planned so far, follow-ups included. */
  total: number;
}

/** Options for `runProbes`. */
export interface RunProbesOptions {
  local: LanePacing;
  remote: LanePacing;
  /**
   * Runs one unit. Must not reject, and should settle only after its socket has closed
   * (`probeOne` does both). Receives the run's signal.
   */
  probe: (unit: ProbeUnit, signal: AbortSignal | undefined) => Promise<ProbeOutcome>;
  /** Units to schedule after one finished. Not called once the run is cancelled. */
  followUp?: (hit: ProbeHit) => ProbeUnit[];
  /** Called after every finished unit, after its follow-ups were planned. Must not throw. */
  onDone?: (hit: ProbeHit, counts: ProbeCounts) => void;
  signal?: AbortSignal;
}

/** What `runProbes` resolves with. */
export interface RunProbesResult {
  /** Every finished unit, in finishing order. */
  hits: ProbeHit[];
  /** true when the signal was aborted; `hits` is then partial. */
  aborted: boolean;
}

/** Waits `ms`, or less when the signal aborts. Never rejects. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Numeric order of hosts: IPv4 literals by value, anything else after them by text. Stable callers keep plan order within a host. */
function compareHosts(a: string, b: string): number {
  const x = parseIPv4(a);
  const y = parseIPv4(b);
  if (x !== undefined && y !== undefined) { return x - y; }
  if ((x === undefined) !== (y === undefined)) { return x === undefined ? 1 : -1; }
  return a < b ? -1 : a > b ? 1 : 0;
}

interface LaneState {
  queue: ProbeUnit[];
  pacing: LanePacing;
}

/**
 * Run every unit under the lane budgets. Never rejects. Resolves once every unit that started
 * has settled; after a cancel the rest are not started and `aborted` is true.
 */
export async function runProbes(units: readonly ProbeUnit[], opts: RunProbesOptions): Promise<RunProbesResult> {
  const { signal } = opts;
  const hits: ProbeHit[] = [];
  const counts: ProbeCounts = { probed: 0, total: units.length };
  const lanes: Record<'local' | 'remote', LaneState> = {
    local: { queue: units.filter(u => u.lane === 'local'), pacing: opts.local },
    remote: {
      // Stable sort: hosts in address order, each host's units in plan order.
      queue: units.filter(u => u.lane === 'remote')
        .map((u, i) => ({ u, i }))
        .sort((a, b) => compareHosts(a.u.host, b.u.host) || a.i - b.i)
        .map(x => x.u),
      pacing: { ...opts.remote, perHost: opts.remote.perHost ?? REMOTE_PER_HOST },
    },
  };

  const runOne = async (unit: ProbeUnit): Promise<void> => {
    let outcome: ProbeOutcome;
    try {
      outcome = await opts.probe(unit, signal);
    } catch {
      // A probe must not reject; if one does, it found nothing.
      outcome = { kind: 'refused' };
    }
    const hit: ProbeHit = { unit, outcome };
    hits.push(hit);
    counts.probed++;
    if (!signal?.aborted && opts.followUp) {
      // A follow-up joins its parent's lane: that lane's loop is alive while the parent runs.
      for (const next of opts.followUp(hit)) {
        lanes[unit.lane].queue.unshift({ ...next, lane: unit.lane });
        counts.total++;
      }
    }
    opts.onDone?.(hit, { ...counts });
  };

  const runLane = async (lane: LaneState): Promise<void> => {
    const inFlight = new Set<Promise<void>>();
    const perHost = new Map<string, number>();
    let lastStart = Number.NEGATIVE_INFINITY;
    for (;;) {
      if (signal?.aborted) { break; }
      if (lane.queue.length === 0 && inFlight.size === 0) { break; }
      let index = -1;
      if (inFlight.size < Math.max(1, lane.pacing.concurrency)) {
        const cap = lane.pacing.perHost;
        index = cap === undefined ? (lane.queue.length > 0 ? 0 : -1)
          : lane.queue.findIndex(u => (perHost.get(u.host) ?? 0) < cap);
      }
      if (index < 0) {
        // Full, or every queued unit waits for its host: wait for a slot.
        if (inFlight.size === 0) { break; }
        await Promise.race(inFlight);
        continue;
      }
      const wait = lastStart + lane.pacing.minGapMs - Date.now();
      if (wait > 0) {
        await sleep(wait, signal);
        continue;   // re-check the cancel and the queue (a follow-up may have joined)
      }
      const [unit] = lane.queue.splice(index, 1);
      lastStart = Date.now();
      perHost.set(unit.host, (perHost.get(unit.host) ?? 0) + 1);
      const p: Promise<void> = runOne(unit).finally(() => {
        inFlight.delete(p);
        const n = (perHost.get(unit.host) ?? 1) - 1;
        if (n > 0) { perHost.set(unit.host, n); } else { perHost.delete(unit.host); }
      });
      inFlight.add(p);
    }
    await Promise.all(inFlight);
  };

  await Promise.all([runLane(lanes.local), runLane(lanes.remote)]);
  return { hits, aborted: signal?.aborted === true };
}

// ---------------------------------------------------------------------------
// Blind loopback sweep (opt-in)
// ---------------------------------------------------------------------------

/** Defaults of the blind loopback sweep. */
export const SWEEP_DEFAULTS = {
  /** Connects in flight. Kept well below the per-process socket counts Windows handles comfortably. */
  concurrency: 400,
  /** Per-connect timeout, ms. On loopback a closed port refuses at once; this bites filtered ports only. */
  connectTimeoutMs: 250,
  /** The whole sweep stops starting new connects after this, ms. */
  budgetMs: 120_000,
} as const;

/** true for an address on this PC's loopback: `'localhost'`, 127.0.0.0/8 or `::1`. */
export function isLoopbackHost(host: string): boolean {
  const h = canonicalHost(host);
  return h === 'localhost' || h === '::1' || (net.isIPv4(h) && h.startsWith('127.'));
}

/**
 * The ports the blind sweep tries, in order: 80 and 443 (an OmniCore VC can take 80, and the
 * dynamic-port floor below would miss both), then 1024-65535 (RobotStudio assigns VC ports from
 * the dynamic range; values up to 62214 were seen). Ports in `DENIED_LOCAL_PORTS` are left out.
 */
export function loopbackSweepPorts(): number[] {
  const out: number[] = [];
  for (const p of [80, 443]) { if (!DENIED_LOCAL_PORTS.has(p)) { out.push(p); } }
  for (let p = 1024; p <= 65535; p++) { if (!DENIED_LOCAL_PORTS.has(p)) { out.push(p); } }
  return out;
}

/** A TCP connect check: true when the port accepted. Settles after the socket has closed. */
export type TcpOpenCheck = (host: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;

/** TCP connect to one port, IPv4 unless `host` is an IPv6 literal; resolves after the socket closed. */
export const tcpOpen: TcpOpenCheck = (host, port, timeoutMs, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(false); return; }
  let open = false;
  let socket: net.Socket;
  try {
    socket = net.connect({ host, port, family: net.isIPv6(host) ? 6 : 4 });
  } catch {
    resolve(false);
    return;
  }
  const stop = (): void => { socket.destroy(); };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  socket.once('connect', () => { open = true; socket.destroy(); });
  socket.on('error', () => { /* refused or reset: closed below */ });
  socket.once('close', () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    resolve(open);
  });
});

/** Options for `sweepOpenPorts`. */
export interface SweepOptions {
  concurrency?: number;
  connectTimeoutMs?: number;
  budgetMs?: number;
  signal?: AbortSignal;
  /** Ports to try; default `loopbackSweepPorts()`. */
  ports?: readonly number[];
  /** Progress: ports tried so far and in all. Called at most every 256 ports, and once at the end. */
  onProgress?: (done: number, total: number) => void;
  /** Connect check; default `tcpOpen`. */
  check?: TcpOpenCheck;
}

/**
 * Blind TCP connect sweep of a loopback address: which ports accept a connection. Loopback only:
 * a sweep of another machine is refused. Opt-in everywhere (`findControllers` runs it only with
 * `localFallback.sweep`), because tens of thousands of connects are what endpoint protection
 * watches. `complete` is false when the signal or the time budget stopped it early.
 *
 * @throws RwsError `INVALID_ARGUMENT` when `host` is not on this PC's loopback.
 */
export async function sweepOpenPorts(host: string, opts: SweepOptions = {}): Promise<{ open: number[]; complete: boolean }> {
  if (!isLoopbackHost(host)) {
    throw new RwsError(`A blind port sweep runs on this PC's loopback address only, not on ${JSON.stringify(host)}`, 'INVALID_ARGUMENT');
  }
  const canonical = canonicalHost(host);
  const target = canonical === 'localhost' ? '127.0.0.1' : canonical;
  const ports = opts.ports ?? loopbackSweepPorts();
  const concurrency = Math.max(1, opts.concurrency ?? SWEEP_DEFAULTS.concurrency);
  const timeoutMs = opts.connectTimeoutMs ?? SWEEP_DEFAULTS.connectTimeoutMs;
  const deadline = Date.now() + (opts.budgetMs ?? SWEEP_DEFAULTS.budgetMs);
  const check = opts.check ?? tcpOpen;
  const open: number[] = [];
  let next = 0;
  let done = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (next < ports.length) {
      if (opts.signal?.aborted || Date.now() > deadline) { stopped = true; return; }
      const port = ports[next++];
      if (await check(target, port, timeoutMs, opts.signal)) { open.push(port); }
      done++;
      if (opts.onProgress && done % 256 === 0) { opts.onProgress(done, ports.length); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  opts.onProgress?.(done, ports.length);
  open.sort((a, b) => a - b);
  return { open, complete: !stopped && done === ports.length };
}
