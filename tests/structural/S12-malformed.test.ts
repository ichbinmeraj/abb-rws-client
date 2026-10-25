/**
 * S12 - Malformed / truncated responses: the live half.
 *
 * Three properties, per the matrix:
 *   - parsers NEVER throw uncaught (on RWS 2.0: neither the XHTML path nor the
 *     hal+json path, which are two different parsers reached through the same
 *     `RwsClient2.parse()` sniff);
 *   - every failure is a TYPED RwsError in the PARSE_ERROR family - a body the
 *     client cannot read is an error, not a value;
 *   - a body truncated mid-element does not HANG the request: it must settle
 *     within the configured timeout.
 *
 * WHY BOTH A LIVE CONTROLLER AND A MOCK. The chaos proxy is a TCP hop, so
 * everything it corrupts corrupts the HTTP (or TLS) framing too - which proves
 * the transport half but can never reach the parsers with a well-formed
 * envelope. The interesting failure is the opposite one: 200 OK, correct
 * Content-Length, and a payload the parser cannot make sense of. That is what a
 * firmware quirk, a captive portal, or a half-written cache actually looks like,
 * and only a server we control can produce it byte for byte. So the live half
 * carries "a corrupt stream fails typed and the client recovers", and the mock
 * half carries "a broken payload is rejected rather than believed". The mock
 * half is tests/structural/S12-malformed.mock.test.ts: it needs no controller
 * and runs in plain `npm test` too; the runner maps both files onto the same
 * cells.
 *
 * The two mock-half assertions that failed when the cell was written (RWS
 * 2.0 believing an unreadable body, RWS 1.0 with no deadline on the body)
 * were fixed on 2026-08-09; the mock file keeps that history.
 */

import { it, expect, afterEach } from 'vitest';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import { RwsError } from '../../src/types.js';
import {
  cell, expectRwsError, until, assertQualityHonest, type AnyClient,
} from '../helpers/structuralHarness.js';
import {
  settleWithin, watchUncaught, assertNoUncaught, withDeadline, type UncaughtWatch,
} from '../helpers/faultChecks.js';

/** Short on purpose: the anti-hang property is only meaningful against a deadline. */
const TIMEOUT_MS = 4000;
/**
 * How long a truncated request is allowed to take before we call it hung. Three
 * times the configured timeout is slack for CPU contention, not tolerance - the
 * defect this catches overshoots by two orders of magnitude, so the exact
 * multiple never decides the verdict.
 */
const HANG_BUDGET_MS = TIMEOUT_MS * 3;

/** Bytes of a live response allowed through before the proxy cuts it. /rw/system
 *  is multi-kilobyte on both generations, so this always lands mid-document. */
const LIVE_CUT_AFTER_BYTES = 500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface Probe {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getControllerState(): Promise<string>;
  getSystemInfo(): Promise<{ name: string; rwVersion: string }>;
}
const probe = (c: AnyClient): Probe => c as unknown as Probe;

/**
 * Vitest gives a hook 10 s by default, and this cell's afterEach can have a
 * manager, several clients, a mock and a proxy to unwind. 5 s is still a real
 * chance for /logout on a healthy connection (sub-second in practice) while
 * leaving the hook room to finish - a hook that times out fails the test for a
 * reason that has nothing to do with the property under test.
 */
const CLEANUP_DEADLINE_MS = 5000;

// ─── Cell, live half ─────────────────────────────────────────────────────────

interface OpenResource {
  proxy?: ChaosProxy;
  clients?: AnyClient[];
  manager?: RobotManager;
  watch?: UncaughtWatch;
}

const open: OpenResource[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.watch?.stop();
    // Heal the proxy BEFORE anything tries to talk through it. A test that fails
    // mid-fault never reaches its own setCorruption({kind:'none'}), and /logout
    // is what frees the controller's session slot - disconnecting through a
    // still-corrupt hop would leak a live session on every failed run.
    o.proxy?.setCorruption({ kind: 'none' });
    o.proxy?.refuseNew(false);
    await withDeadline(o.manager?.disconnect(), CLEANUP_DEADLINE_MS);
    for (const client of o.clients ?? []) {
      await withDeadline(
        (client as { disconnect?: () => Promise<void> }).disconnect?.(),
        CLEANUP_DEADLINE_MS,
      );
    }
    await o.proxy?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S12-malformed', generation, ctx => {
    it('a live response cut mid-body is a typed error and the client recovers', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: TIMEOUT_MS });
      const watch = watchUncaught();
      open.push({ proxy, clients: [client], watch });

      const c = probe(client);
      await c.connect();
      // Sanity: the endpoint works before the fault, so the failure below is the
      // fault and not a missing option or a wrong path.
      await expect(c.getSystemInfo()).resolves.toBeTruthy();

      // Truncation is metered PER CONNECTION by the proxy (each pair carries its
      // own byte counter), so an extra idle pair cannot move the cut: whichever
      // pair carries the response is cut after the same number of bytes.
      //
      // This originally demanded exactly one open pair, which was stricter than
      // the mechanism requires and failed on RWS 1.0, where fetch's pool
      // (undici, the RWS 1.0 transport on every port fetch accepts) kept more than one
      // pooled connection after the digest handshake. What
      // must hold is that traffic is flowing at all - a zero here would mean the
      // fault is being injected into nothing, and every assertion below would
      // pass vacuously.
      expect(proxy.stats().connectionsOpen, 'no live proxied connection to cut').toBeGreaterThanOrEqual(1);

      // Cut relative to what has ALREADY flowed, so the knife lands inside the
      // next response rather than before it. Truncating a live keep-alive stream
      // at byte 0 would only re-test S01's dropped connection.
      // On RWS 2.0 the proxy sees TLS records, not the document, so the cut
      // lands mid-record rather than mid-element - the byte-exact mid-element
      // case is the mock's job, and this one is about the transport half.
      // `afterBytes` is measured from the moment corruption is armed, per
      // connection, so this cuts the NEXT response after N bytes regardless of
      // which pooled socket carries it. (It used to be derived from the proxy's
      // GLOBAL byte counter, which only coincided with the per-connection
      // counter while exactly one pair existed.)
      proxy.setCorruption({ kind: 'truncate-and-drop', afterBytes: LIVE_CUT_AFTER_BYTES });

      const err = await expectRwsError(() => c.getSystemInfo());
      // Either reading is honest - the body could not be parsed, or the
      // transport died under it. Nothing else is: a truncated document is not a
      // busy controller, a missing resource, or a permissions problem.
      expect(
        ['PARSE_ERROR', 'NETWORK_ERROR'],
        `a truncated body surfaced as ${err.code}: ${err.message}`,
      ).toContain(err.code);

      proxy.setCorruption({ kind: 'none' });
      await until(async () => {
        try { await c.getSystemInfo(); return true; } catch { return false; }
      }, 25000, 'client recovers once the stream is clean again');

      await assertNoUncaught(watch);
    }, 60000);

    it('garbled bytes from the live controller fail typed, never uncaught', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: TIMEOUT_MS });
      const watch = watchUncaught();
      open.push({ proxy, clients: [client], watch });

      const c = probe(client);
      await c.connect();
      await expect(c.getControllerState()).resolves.toBeTruthy();

      // Every 7th byte replaced. On RWS 1.0 that mangles the status line and
      // headers as well as the body; on RWS 2.0 it corrupts TLS records. Both
      // are the same question for this cell: does the damage arrive as a typed
      // error, or does it escape as a raw socket/parser throw?
      proxy.setCorruption({ kind: 'garble', everyNthByte: 7 });

      const outcome = await settleWithin(() => c.getControllerState(), HANG_BUDGET_MS);
      expect(outcome.settled, `a garbled response did not settle within ${HANG_BUDGET_MS} ms`).toBe(true);
      // A garbled document must never be READ. On RWS 1.0 a corrupted
      // <span class="ctrlstate"> value is rejected by parseControllerState; on
      // RWS 2.0 it would have to survive TLS first, so a resolved value here
      // means something accepted bytes it could not verify.
      expect(
        outcome.error,
        `a garbled response resolved with ${JSON.stringify(outcome.value)}`,
      ).toBeInstanceOf(RwsError);
      expect(
        ['PARSE_ERROR', 'NETWORK_ERROR'],
        `garbled bytes surfaced as ${(outcome.error as RwsError | undefined)?.code}`,
      ).toContain((outcome.error as RwsError).code);

      proxy.setCorruption({ kind: 'none' });
      await until(async () => {
        try { await c.getControllerState(); return true; } catch { return false; }
      }, 25000, 'client recovers once the stream is clean again');

      await assertNoUncaught(watch);
    }, 60000);

    it('quality stops claiming "live" while the stream is corrupt (S14 cross-cutting)', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 400 });
      const watch = watchUncaught();
      open.push({ proxy, manager, watch });

      await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
        25000, 'manager reaches a steady quality');
      // Requests are succeeding at this point, so claiming disconnected would be
      // the other half of the S14 lie.
      assertQualityHonest(manager, { notDisconnected: true });
      const steady = manager.state.quality;

      proxy.setCorruption({ kind: 'garble', everyNthByte: 7 });

      // Polls now return damage. Asserting "no longer live" alone would be
      // vacuous when the WebSocket never came up and the steady state was
      // already 'polling' - the claim has to be that quality DEGRADES.
      await until(
        () => manager.state.quality === 'stale' || manager.state.quality === 'disconnected',
        30000, `quality degrades from "${steady}" once every poll is corrupt`,
      );
      assertQualityHonest(manager, { notLive: true });

      proxy.setCorruption({ kind: 'none' });
      await assertNoUncaught(watch);
    }, 60000);
  });
}
