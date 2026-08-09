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

import { describe } from 'vitest';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import { RobotManager } from '../../src/RobotManager.js';
import { RwsError } from '../../src/types.js';
import { startChaosProxy, type ChaosProxy } from './chaosProxy.js';
import {
  controllerFor, TEST_USER, TEST_PASS,
  type Generation, type LiveController,
} from './liveControllers.js';

/** Structural cells are slow and fault-injecting; only `npm run structural` enables them. */
export const STRUCTURAL_ENABLED = process.env.RWS_STRUCTURAL === '1';

/**
 * Declare a cell. Skips (leaving the cell `untested`, never green) when the
 * suite is not enabled or that generation's controller is not running.
 */
export function cell(
  cellId: string,
  generation: Generation,
  body: (ctx: CellContext) => void,
): void {
  const title = `${cellId}/${generation}`;
  if (!STRUCTURAL_ENABLED) { describe.skip(title, () => { body(makeContext(generation)); }); return; }
  describe(title, () => { body(makeContext(generation)); });
}

export interface CellContext {
  generation: Generation;
  /** Resolved once the controller is discovered; call inside the test body. */
  controller: () => Promise<LiveController>;
  /** Start a chaos proxy in front of this generation's controller. */
  proxy: () => Promise<ChaosProxy>;
  /** A client speaking this generation, routed through `p`. */
  client: (p: ChaosProxy, opts?: { timeout?: number }) => Promise<AnyClient>;
  /** A RobotManager connected through `p` - use when asserting quality states. */
  manager: (p: ChaosProxy, opts?: { refreshIntervalMs?: number }) => Promise<RobotManager>;
}

export type AnyClient = RwsClient | RwsClient2;

function makeContext(generation: Generation): CellContext {
  let resolved: LiveController | null = null;

  const controller = async (): Promise<LiveController> => {
    if (resolved) { return resolved; }
    const c = await controllerFor(generation);
    if (!c) { throw new Error(`no ${generation} controller reachable`); }
    resolved = c;
    return c;
  };

  const proxy = async (): Promise<ChaosProxy> => {
    const c = await controller();
    return startChaosProxy(c.host, c.port);
  };

  const client = async (p: ChaosProxy, opts: { timeout?: number } = {}): Promise<AnyClient> => {
    const c = await controller();
    if (generation === 'rws1') {
      return new RwsClient({
        host: '127.0.0.1', port: p.port,
        username: TEST_USER, password: TEST_PASS,
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      });
    }
    // TLS passes through the TCP proxy untouched; the client must be told the
    // scheme of the REAL controller, not of the proxy hop.
    const scheme = c.tls ? 'https' : 'http';
    return new RwsClient2(
      `${scheme}://127.0.0.1:${p.port}`, TEST_USER, TEST_PASS,
      { ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}) },
    );
  };

  const manager = async (
    p: ChaosProxy, opts: { refreshIntervalMs?: number } = {},
  ): Promise<RobotManager> => {
    const c = await controller();
    const m = new RobotManager({ refreshIntervalMs: opts.refreshIntervalMs ?? 400 });
    await m.connect('127.0.0.1', TEST_USER, TEST_PASS, p.port, c.tls);
    return m;
  };

  return { generation, controller, proxy, client, manager };
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
