/**
 * Shared scaffolding for the structural coverage cells.
 *
 * Every cell follows the same shape:
 *   describe('<cell-id>/<generation>', ...)   <- the runner maps results by this
 *   a client (or manager) pointed at a chaos proxy in front of a live VC
 *   a fault injected, then assertions about typed errors, quality and leaks
 *
 * The naming convention is load-bearing: scripts/structural.mjs attributes
 * results to matrix cells by the top-level describe title, so a typo there
 * silently leaves a cell `untested` rather than mis-reporting it as verified.
 *
 * Test infrastructure only - never shipped in the package.
 */

import fs from 'node:fs';
import type http from 'node:http';
import { describe, beforeAll, beforeEach, afterEach } from 'vitest';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import { RobotManager } from '../../src/RobotManager.js';
import { RwsError } from '../../src/types.js';
import { startChaosProxy, type ChaosProxy, type ChaosProxyOptions } from './chaosProxy.js';
import { listenOnPort } from './scriptedHttp.js';
import {
  controllerFor, TEST_USER, TEST_PASS,
  type Generation, type LiveController,
} from './liveControllers.js';

/** Structural cells are slow and fault-injecting; only `npm run structural` enables them. */
export const STRUCTURAL_ENABLED = process.env.RWS_STRUCTURAL === '1';

/**
 * RWS_STRUCTURAL_NODE_HTTP=1: every hop an RWS 1.0 client of a cell talks to
 * directly listens on a port Node's fetch refuses (listenModeFor): the chaos
 * proxy (ctx.proxy(), and S13's own), S05's header tap and S10's reverse
 * proxy. So the RWS 1.0 client sends through node:http in every rws1 cell,
 * as it does for a controller on such a port (an RW6 VC came back on port 7,
 * 2026-10-22). Without it these hops listen on a port fetch accepts and the
 * client sends through fetch, which is what it does on every other port; S01
 * and S02 also run one test each through a refused port either way. RWS 2.0
 * always sends through node:http, so its cells are unchanged.
 */
export const RWS1_NODE_HTTP = process.env.RWS_STRUCTURAL_NODE_HTTP === '1';

/**
 * Where a hop a `generation` client talks to directly listens: on a port
 * fetch refuses for rws1 under RWS_STRUCTURAL_NODE_HTTP=1, otherwise on a
 * free port fetch accepts.
 */
export function listenModeFor(generation: Generation): 'fetch-accepted' | 'fetch-refused' {
  return generation === 'rws1' && RWS1_NODE_HTTP ? 'fetch-refused' : 'fetch-accepted';
}

/**
 * Listen `server` on 127.0.0.1 for a hop a `generation` client talks to
 * directly (a cell's own header tap or reverse proxy), as listenModeFor
 * says, and return its port.
 */
export function listenForClient(server: http.Server, generation: Generation): Promise<number> {
  return listenOnPort(server, listenModeFor(generation) === 'fetch-refused' ? 'fetch-refused' : 0);
}

/**
 * Declare a cell. Skips (leaving the cell `untested`, never green) when the
 * suite is not enabled or that generation's controller is not running. In the
 * second case every test of the cell is skipped, the ones that only talk to a
 * mock too, and the reason is recorded (see `recordCellSkip`).
 */
export function cell(
  cellId: string,
  generation: Generation,
  body: (ctx: CellContext) => void,
): void {
  defineCell(cellId, generation, body, { enabled: STRUCTURAL_ENABLED, find: controllerFor });
}

/** What `cell()` decides with: the suite switch and the discovery. */
export interface CellSwitches {
  enabled: boolean;
  /** This generation's controller, or null when none is running. */
  find: (generation: Generation) => Promise<LiveController | null>;
}

/** `cell()` with its switches given; the harness's own unit test passes a fake discovery. */
export function defineCell(
  cellId: string,
  generation: Generation,
  body: (ctx: CellContext) => void,
  switches: CellSwitches,
): void {
  const title = `${cellId}/${generation}`;
  const run = (): void => {
    const ctx = makeContext(title, generation, switches.find);
    let missing: string | null = null;
    // Discovery is paced (one probe at a time, at least 1 s apart) and can take
    // half a minute, so it runs here under its own budget rather than inside the
    // first test's timeout. The result is cached for the rest of the file.
    beforeAll(async () => {
      if (!(await switches.find(generation))) { missing = noControllerReason(generation); }
    }, 180000);
    // Without its controller the whole cell is untested, not failing. Every
    // test is skipped, the mock-only ones too: scripts/structural.mjs counts a
    // pass in this file as a pass against the controller, so a cell whose
    // mock-only test passed and whose live half was skipped would read
    // `verified`, with the controller half never run. Tests that need no
    // controller belong in the cell's tests/structural/<cell-id>.mock.test.ts
    // instead, which runs without this gate (and in plain `npm test`) and
    // which the runner counts apart.
    beforeEach(t => { if (missing) { ctx.skip(t, missing); } });
    // Cleanup belongs to the HARNESS, not to each cell.
    //
    // Every client that reaches a live controller holds a session slot, and an
    // IRC5 caps at 70 with a 300 s expiry. A test that throws before it can
    // register its own cleanup - `const p = await ctx.proxy(); const c = await
    // ctx.client(p); open.push({p, c})` strands `p` if ctx.client() throws -
    // leaves a slot held for five minutes. Across 83 call sites in 14 cells that
    // is not a thing to get right by discipline: one stranded slot per cell is
    // enough to starve everything that runs afterwards, and the symptom appears
    // in a LATER cell as CONTROLLER_BUSY, nowhere near the cause.
    //
    // So the context records everything it hands out and tears it down here.
    // Cells may keep their own bookkeeping; disconnecting twice is harmless.
    // Generous hook timeout, on purpose. A churn cell creates dozens of clients
    // inside ONE test, and vitest's default 10 s hook budget is not enough to
    // log them all out - the hook then times out, which reports as a cell
    // failure and, worse, abandons the very slots this cleanup exists to free.
    afterEach(async () => { await ctx.releaseAll(); }, 120000);
    body(ctx);
  };
  if (!switches.enabled) { describe.skip(title, run); return; }
  describe(title, run);
}

/** The skip reason of a cell whose generation has no controller running. */
function noControllerReason(generation: Generation): string {
  return generation === 'rws1'
    ? 'no RWS 1.0 controller reachable on localhost - start the RW6 VC, or set RWS_TEST_PORT_RW6'
    : 'no RWS 2.0 controller reachable on localhost - start the RW7 or RW8 VC, or set RWS_TEST_PORT_RW7';
}

// ─── Skip reasons ────────────────────────────────────────────────────────────

/** One skipped test of a cell, and why. */
export interface CellSkip {
  /** The cell title, `<cell-id>/<generation>`. */
  cell: string;
  test: string;
  reason: string;
}

const skips: CellSkip[] = [];

/** The skips recorded in this test file so far, in order. */
export function recordedSkips(): readonly CellSkip[] { return skips; }

/**
 * Record why a test of a cell was skipped. Vitest 1.x has no skip note, so the
 * reason goes to the console (once per cell and reason) and, when
 * scripts/structural.mjs names a file in RWS_STRUCTURAL_SKIPS, into that file
 * as one JSON line; the runner shows the reasons beside the cells it reports.
 */
export function recordCellSkip(entry: CellSkip): void {
  const first = !skips.some(s => s.cell === entry.cell && s.reason === entry.reason);
  skips.push(entry);
  if (first) { console.warn(`${entry.cell}: skipped - ${entry.reason}`); }
  const file = process.env.RWS_STRUCTURAL_SKIPS;
  if (file) {
    try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`); } catch { /* the console has it */ }
  }
}

/**
 * The title of a test that states a property the client does not meet yet,
 * for vitest's it.fails: `it.fails(knownGap('does X', 'why not yet'), ...)`.
 * Such a test passes while the gap is open, and scripts/structural.mjs maps
 * that pass as a failure of the cell, naming the gap, so a cell never reads
 * verified on a property that does not hold. Once the client is fixed the test
 * fails ("Expect test to fail"): flip it to it() and drop the marker. The
 * reason must not contain `]`.
 */
export function knownGap(title: string, reason: string): string {
  return `${title} [known gap: ${reason}]`;
}

/** The part of vitest's test context a skip needs. */
export interface SkippableTest {
  skip: () => void;
  task: { name: string };
}

export interface CellContext {
  generation: Generation;
  /**
   * Skip the running test, recording the reason. Call it before the test
   * opens anything: a skipped test's afterEach hooks do not run.
   */
  skip: (t: SkippableTest, reason: string) => never;
  /** Resolved once the controller is discovered; call inside the test body. */
  controller: () => Promise<LiveController>;
  /**
   * Start a chaos proxy in front of this generation's controller. It listens
   * on a port fetch accepts, or refuses with `{ listen: 'fetch-refused' }`
   * (the default for rws1 under RWS_STRUCTURAL_NODE_HTTP=1).
   */
  proxy: (options?: ChaosProxyOptions) => Promise<ChaosProxy>;
  /** A client speaking this generation, routed through `p`. */
  client: (p: ChaosProxy, opts?: { timeout?: number }) => Promise<AnyClient>;
  /** A RobotManager connected through `p` - use when asserting quality states. */
  manager: (p: ChaosProxy, opts?: { refreshIntervalMs?: number }) => Promise<RobotManager>;
  /**
   * Tear down everything this context handed out. Called automatically after
   * every test; exposed so a cell that churns clients inside ONE test can free
   * slots as it goes instead of holding all of them to the end.
   */
  releaseAll: () => Promise<void>;
}

export type AnyClient = RwsClient | RwsClient2;

function makeContext(
  title: string,
  generation: Generation,
  find: CellSwitches['find'],
): CellContext {
  let resolved: LiveController | null = null;
  const proxies: ChaosProxy[] = [];
  const clients: AnyClient[] = [];
  const managers: RobotManager[] = [];

  const skip = (t: SkippableTest, reason: string): never => {
    recordCellSkip({ cell: title, test: t.task.name, reason });
    t.skip();
    // t.skip() throws vitest's pending error; this line is for the type checker.
    throw new Error(`skipped: ${reason}`);
  };

  const controller = async (): Promise<LiveController> => {
    if (resolved) { return resolved; }
    // A cell without its controller is skipped before its tests run (see
    // defineCell), so this throws only if the controller went away mid-file.
    const c = await find(generation);
    if (!c) { throw new Error(noControllerReason(generation)); }
    resolved = c;
    return c;
  };

  const proxy = async (options: ChaosProxyOptions = {}): Promise<ChaosProxy> => {
    const c = await controller();
    const listen = options.listen ?? listenModeFor(generation);
    const p = await startChaosProxy(c.host, c.port, { listen });
    proxies.push(p);
    return p;
  };

  const remember = <T extends AnyClient>(c: T): T => { clients.push(c); return c; };

  const client = async (p: ChaosProxy, opts: { timeout?: number } = {}): Promise<AnyClient> => {
    const c = await controller();
    if (generation === 'rws1') {
      return remember(new RwsClient({
        host: '127.0.0.1', port: p.port,
        username: TEST_USER, password: TEST_PASS,
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      }));
    }
    // TLS passes through the TCP proxy untouched; the client must be told the
    // scheme of the REAL controller, not of the proxy hop.
    const scheme = c.tls ? 'https' : 'http';
    return remember(new RwsClient2(
      `${scheme}://127.0.0.1:${p.port}`, TEST_USER, TEST_PASS,
      { ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}) },
    ));
  };

  const manager = async (
    p: ChaosProxy, opts: { refreshIntervalMs?: number } = {},
  ): Promise<RobotManager> => {
    const c = await controller();
    const m = new RobotManager({ refreshIntervalMs: opts.refreshIntervalMs ?? 400 });
    // Registered BEFORE connect: a connect that fails partway can still have
    // taken a session slot on the controller, and an unregistered manager is
    // one nothing will ever disconnect.
    managers.push(m);
    await m.connect('127.0.0.1', TEST_USER, TEST_PASS, p.port, c.tls);
    return m;
  };

  /**
   * Free everything, controller-side resources FIRST.
   *
   * Order matters: disconnecting a client sends GET /logout, which is the only
   * thing that frees its session slot, and it has to travel through the proxy.
   * Closing proxies first would strand every slot for the controller's full
   * expiry - the exact failure this cleanup exists to prevent.
   */
  /**
   * Release in small parallel batches rather than one at a time.
   *
   * A churn cell can hand back fifty clients from a single test, and logging
   * them out sequentially takes longer than any sane hook budget. Fully
   * parallel is worse though: fifty simultaneous /logout calls are exactly the
   * burst the controller's <20 req/s ceiling rejects, and a rejected logout does
   * not free its slot. A small batch is the middle ground.
   */
  const inBatches = async <T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> => {
    const BATCH = 4;
    for (let i = 0; i < items.length; i += BATCH) {
      await Promise.all(items.slice(i, i + BATCH).map(x => fn(x).catch(() => undefined)));
    }
  };

  const releaseAll = async (): Promise<void> => {
    await inBatches(managers.splice(0), m => m.disconnect());
    await inBatches(clients.splice(0), c =>
      (c as { disconnect?: () => Promise<void> }).disconnect?.() ?? Promise.resolve());
    await inBatches(proxies.splice(0), p => p.close());
  };

  return { generation, skip, controller, proxy, client, manager, releaseAll };
}

// ─── Assertion helpers ───────────────────────────────────────────────────────

/**
 * Run `fn` and return the RwsError it threw.
 *
 * The distinction this enforces is the whole point of several cells: a fault
 * must surface as a TYPED RwsError, never as a raw TypeError, a bare Error from
 * the socket layer, or an unhandled rejection. Anything else fails loudly here
 * with the actual value, so a diagnosis does not need a second run.
 */
export async function expectRwsError(fn: () => Promise<unknown>): Promise<RwsError> {
  try {
    const value = await fn();
    throw new Object({
      __structural: `expected an RwsError, but the call resolved with ${JSON.stringify(value)?.slice(0, 200)}`,
    });
  } catch (e) {
    if (e instanceof RwsError) { return e; }
    if (e && typeof e === 'object' && '__structural' in e) {
      throw new Error(String((e as { __structural: string }).__structural));
    }
    throw new Error(
      `expected an RwsError, got ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`,
    );
  }
}

/** Poll until a condition holds; never a bare sleep, so load only costs time. */
export async function until(
  cond: () => boolean | Promise<boolean>, timeoutMs = 20000, label = 'condition',
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) { return; }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`${label} not met within ${timeoutMs} ms`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
}

/**
 * Cross-cutting assertion for scenario S14: whatever else a cell proves, the
 * reported quality must not lie, and every transition must explain itself.
 */
export function assertQualityHonest(
  m: RobotManager, expectation: { notLive?: boolean; notDisconnected?: boolean },
): void {
  const q = m.state.quality;
  const reason = m.state.qualityReason ?? '';
  if (expectation.notLive && q === 'live') {
    throw new Error(`quality claims "live" while the stream is down (reason: ${reason || 'none'})`);
  }
  if (expectation.notDisconnected && q === 'disconnected') {
    throw new Error(`quality claims "disconnected" while requests still succeed (reason: ${reason || 'none'})`);
  }
  if (!reason.trim()) {
    throw new Error(`quality "${q}" carries no human-readable reason`);
  }
}

export { RwsError };
