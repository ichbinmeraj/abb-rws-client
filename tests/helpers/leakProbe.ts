/**
 * Leak probes for the structural coverage loop.
 *
 * Answers one question per scenario: after N cycles of connect/disconnect,
 * subscribe/unsubscribe or fault/recover, did the process keep anything it
 * should have released - sockets, timers, listeners, heap?
 *
 * Deliberately built on `process.getActiveResourcesInfo()` rather than a
 * third-party handle inspector: no new dependency (a hard ground rule), and it
 * is the same list Node itself uses to decide whether the event loop can exit.
 *
 * Test infrastructure only - never shipped in the package.
 */

export interface ResourceSnapshot {
  /** Active handle/request kinds, counted. e.g. { TCPSocketWrap: 3, Timeout: 2 }. */
  byKind: Record<string, number>;
  /** Total active resources Node is tracking. */
  total: number;
  /** Heap used, bytes. Only meaningful after forceGc(). */
  heapUsed: number;
  /** Resident set size, bytes - what the soak threshold is written against. */
  rss: number;
}

/** Kinds that are ambient to the test runner, not owned by the client. */
const AMBIENT_KINDS = new Set([
  'Immediate',           // vitest scheduling
  'TTYWrap', 'FileHandle', 'FSReqCallback',
  'ProcessWrap', 'SignalWrap', 'PipeWrap',
  'MessagePort',         // vitest worker threads
]);

/**
 * Encourage a GC so heap comparisons mean something. Node only exposes gc()
 * under --expose-gc; without it the heap numbers are advisory and the socket
 * and timer counts carry the assertion instead.
 */
export async function forceGc(): Promise<boolean> {
  const g = (globalThis as { gc?: () => void }).gc;
  if (!g) { return false; }
  g();
  // Let finalizers run before measuring.
  await new Promise(r => setTimeout(r, 50));
  g();
  return true;
}

export function snapshot(): ResourceSnapshot {
  const info = (process as unknown as { getActiveResourcesInfo?: () => string[] })
    .getActiveResourcesInfo?.() ?? [];
  const byKind: Record<string, number> = {};
  for (const kind of info) {
    if (AMBIENT_KINDS.has(kind)) { continue; }
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  const mem = process.memoryUsage();
  return {
    byKind,
    total: Object.values(byKind).reduce((a, b) => a + b, 0),
    heapUsed: mem.heapUsed,
    rss: mem.rss,
  };
}

export interface LeakVerdict {
  leaked: boolean;
  /** Kinds that grew, with before -> after counts. */
  grew: Array<{ kind: string; before: number; after: number }>;
  heapDeltaBytes: number;
  rssDeltaBytes: number;
  summary: string;
}

/**
 * Compare two snapshots.
 *
 * `tolerance` exists because a single lingering socket in TIME_WAIT, or one
 * timer belonging to the runner, is not a leak - a leak is growth that scales
 * with the number of cycles. Pass the cycle count and require growth to be
 * sub-linear rather than exactly zero.
 */
export function compare(
  before: ResourceSnapshot, after: ResourceSnapshot,
  opts: { tolerancePerKind?: number; heapGrowthLimitBytes?: number } = {},
): LeakVerdict {
  const tolerance = opts.tolerancePerKind ?? 0;
  const grew: LeakVerdict['grew'] = [];
  const kinds = new Set([...Object.keys(before.byKind), ...Object.keys(after.byKind)]);
  for (const kind of kinds) {
    const b = before.byKind[kind] ?? 0;
    const a = after.byKind[kind] ?? 0;
    if (a - b > tolerance) { grew.push({ kind, before: b, after: a }); }
  }
  const heapDeltaBytes = after.heapUsed - before.heapUsed;
  const rssDeltaBytes = after.rss - before.rss;
  const heapLimit = opts.heapGrowthLimitBytes ?? Infinity;
  const heapLeaked = heapDeltaBytes > heapLimit;

  const parts: string[] = [];
  if (grew.length) {
    parts.push(grew.map(g => `${g.kind} ${g.before}->${g.after}`).join(', '));
  }
  if (heapLeaked) {
    parts.push(`heap +${(heapDeltaBytes / 1024 / 1024).toFixed(1)} MB (limit ${(heapLimit / 1024 / 1024).toFixed(1)} MB)`);
  }
  return {
    leaked: grew.length > 0 || heapLeaked,
    grew,
    heapDeltaBytes,
    rssDeltaBytes,
    summary: parts.length ? parts.join(' | ') : 'no growth beyond tolerance',
  };
}

/**
 * Run `cycle` n times and report what the process kept.
 *
 * Settling matters: sockets move to TIME_WAIT and timers unref asynchronously,
 * so measuring immediately after the last cycle reports phantom growth. The
 * settle delay is part of the probe, not padding.
 */
export async function measureCycles(
  n: number,
  cycle: (i: number) => Promise<void>,
  opts: { settleMs?: number; tolerancePerKind?: number; heapGrowthLimitBytes?: number } = {},
): Promise<LeakVerdict & { snapshots: { before: ResourceSnapshot; after: ResourceSnapshot } }> {
  const settleMs = opts.settleMs ?? 500;

  // Warm up once so first-call lazy imports (the dynamic `ws` import) are not
  // counted as a leak.
  await cycle(0);
  await new Promise(r => setTimeout(r, settleMs));
  await forceGc();
  const before = snapshot();

  for (let i = 1; i <= n; i++) { await cycle(i); }

  await new Promise(r => setTimeout(r, settleMs));
  await forceGc();
  const after = snapshot();

  return { ...compare(before, after, opts), snapshots: { before, after } };
}
