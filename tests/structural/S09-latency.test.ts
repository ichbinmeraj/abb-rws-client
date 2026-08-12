/**
 * S09 - Latency injection (500 ms - 5 s).
 *
 * A slow link is not a broken link, and the client has to tell the difference.
 * Three properties from the matrix:
 *
 *   - the CONFIGURED timeout is what fires, and it fires as a typed RwsError -
 *     not a raw AbortError (RWS 1.0 aborts a fetch) and not a bare socket error
 *     (RWS 2.0 destroys the request), and not "eventually succeeded 8 s later";
 *   - the request queue DRAINS: every request issued settles, including the ones
 *     that time out, and a batch of timeouts does not wedge the requests behind
 *     it. Both generations detach queue errors on purpose (HttpSession.enqueue
 *     swallows the rejection on the shared chain, RwsClient2.takeRequestSlot
 *     catches a failed slot) - this cell is what proves those two lines work;
 *   - the >=55 ms pacing floor still holds while the link is slow.
 *
 * Pacing is measured CLIENT-side, from wall clock around the calls. Timestamping
 * arrivals at the proxy would be sharper in theory and useless in practice: this
 * suite runs under CPU contention, and a blocked event loop stamps two properly
 * paced arrivals into the same millisecond, which reads as a rate-limit
 * violation that never happened.
 */

import { it, expect, afterEach } from 'vitest';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import {
  cell, expectRwsError, until, assertQualityHonest, RwsError, type AnyClient,
} from '../helpers/structuralHarness.js';

/**
 * The pacing floor both generations implement: RwsClient defaults
 * `requestIntervalMs` to 55 and RwsClient2 hard-codes `MIN_MS = 55`, which is
 * the <20 req/s RWS ceiling with a margin. Duplicated here rather than imported
 * so a silent change to either default fails this cell instead of following it.
 */
const MIN_INTERVAL_MS = 55;

/** Minimal shape both clients satisfy; the harness returns a union of the two. */
interface Probe {
  connect(): Promise<void>;
  getControllerState(): Promise<string>;
}
const probe = (c: AnyClient): Probe => c as unknown as Probe;

interface Slot {
  proxy?: ChaosProxy | undefined;
  client?: AnyClient | undefined;
  manager?: RobotManager | undefined;
}

const open: Slot[] = [];

/**
 * Register a teardown slot BEFORE building anything that can throw. Pushing
 * `{ proxy, manager }` only after `ctx.manager()` resolves means a failed
 * connect leaks both the listener and - worse - a live controller session,
 * and the controller caps those.
 */
function track(proxy?: ChaosProxy): Slot {
  const slot: Slot = { proxy };
  open.push(slot);
  return slot;
}

afterEach(async () => {
  for (const o of open.splice(0)) {
    // Clear the fault BEFORE tearing anything down. A failed assertion leaves
    // multi-second latency armed, and disconnect() issues GET /logout - under 4 s
    // of injected delay that turns cleanup into a hang that is reported as a
    // timeout in whatever test runs next.
    o.proxy?.setLatency(0);
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> })?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S09-latency', generation, ctx => {
    it('the configured timeout fires under latency and surfaces as a typed RwsError', async () => {
      const proxy = await ctx.proxy();
      const slot = track(proxy);

      // TWO clients with two DIFFERENT configured deadlines over the SAME link.
      // Timing one client only proves "it gave up somewhere between 0.7 s and
      // the response", which a hard-coded 1 s deadline would satisfy just as
      // well. The gap between the two is what shows the CONFIGURED value is the
      // one being honoured.
      const fast = probe(slot.client = await ctx.client(proxy, { timeout: 800 }));
      const slow = probe(track().client = await ctx.client(proxy, { timeout: 2500 }));

      // Connect FIRST, with the link healthy: this completes the digest handshake
      // (RWS 1.0) or the TLS handshake (RWS 2.0) and leaves a pooled keep-alive
      // socket. Injecting latency before that would time out the handshake
      // instead of a request, which is a different fault.
      await fast.connect();
      await slow.connect();
      await expect(fast.getControllerState()).resolves.toBeTruthy();

      // 4 s of delay per direction against deadlines of 0.8 s and 2.5 s: neither
      // response can possibly arrive before its deadline, so both outcomes are
      // deterministic rather than a race between the timer and the network.
      proxy.setLatency(4000);

      const time = async (c: Probe): Promise<{ err: RwsError; elapsed: number }> => {
        const t0 = Date.now();
        const err = await expectRwsError(() => c.getControllerState());
        return { err, elapsed: Date.now() - t0 };
      };
      const short = await time(fast);
      const long = await time(slow);

      // Both generations classify a deadline as NETWORK_ERROR: HttpSession turns
      // the AbortError into `Request timed out after Nms`, RwsClient2 rejects with
      // `RWS2 timeout: <path>` from req.setTimeout.
      for (const r of [short, long]) {
        expect(r.err.code).toBe('NETWORK_ERROR');
        expect(r.err.message).toMatch(/tim(e|ed) ?out/i);
      }

      // Lower bounds: each waited at least its own deadline (a timer cannot fire
      // early, so these are hard floors minus a millisecond of rounding).
      // Upper bounds: both gave up long before the delayed response could have
      // landed at ~8 s, which is what "the timeout fires" means.
      expect(short.elapsed).toBeGreaterThanOrEqual(750);
      expect(short.elapsed).toBeLessThan(2200);
      expect(long.elapsed).toBeGreaterThanOrEqual(2400);
      expect(long.elapsed).toBeLessThan(3900);

      // The assertion a hard-coded deadline cannot survive: 1700 ms of nominal
      // separation, asserted with a wide margin for scheduler jitter.
      expect(
        long.elapsed - short.elapsed,
        `a 2500 ms deadline (${long.elapsed} ms) did not outlast an 800 ms one (${short.elapsed} ms)`,
      ).toBeGreaterThan(800);

      // Heal the link and prove the client survived its own timeout.
      proxy.setLatency(0);
      await until(async () => {
        try { await fast.getControllerState(); return true; }
        catch { return false; }
      }, 25000, 'client recovers once the latency is removed');
    }, 120000);

    it('every request issued under latency settles - the queue drains, nothing piles up', async () => {
      const proxy = await ctx.proxy();
      const slot = track(proxy);
      // Generous timeout: this test is about the queue draining, not about
      // deadlines, so every request must be able to complete under the delay.
      const c = probe(slot.client = await ctx.client(proxy, { timeout: 15000 }));
      await c.connect();

      proxy.setLatency(500);

      const BATCH = 6;
      let settled = 0;
      const results = Array.from({ length: BATCH }, () =>
        c.getControllerState().then(
          v => { settled++; return { ok: true as const, v }; },
          e => { settled++; return { ok: false as const, e }; },
        ));

      // until() rather than awaiting Promise.all: a wedged queue leaves a request
      // pending forever, and the rethrow below names the count instead of leaving
      // an opaque vitest timeout. The catch does not swallow - it replaces the
      // generic message with the one that identifies the failure.
      try {
        await until(() => settled === BATCH, 45000, `all ${BATCH} queued requests settle`);
      } catch {
        throw new Error(`queue wedged under latency: only ${settled} of ${BATCH} requests settled in 45 s`);
      }

      const outcomes = await Promise.all(results);
      // No starvation either: 6 requests spaced by the client's own limiter are
      // far under the controller's ceiling, so a rejection here would mean the
      // limiter is not actually protecting the queue it fronts.
      for (const o of outcomes) {
        expect(o.ok, `queued request failed under latency: ${o.ok ? '' : String(o.e)}`).toBe(true);
      }

      proxy.setLatency(0);
    }, 90000);

    it('a batch of timeouts does not wedge the requests queued behind them', async () => {
      const proxy = await ctx.proxy();
      const slot = track(proxy);
      const c = probe(slot.client = await ctx.client(proxy, { timeout: 700 }));
      await c.connect();

      // Every request in this batch is guaranteed to blow its deadline, so the
      // question under test is only what the queue does with five consecutive
      // rejections - not whether they reject.
      proxy.setLatency(3000);

      const BATCH = 5;
      let settled = 0;
      const failures = Array.from({ length: BATCH }, () =>
        c.getControllerState().then(
          () => { settled++; return null; },
          (e: unknown) => { settled++; return e; },
        ));
      try {
        await until(() => settled === BATCH, 45000, `all ${BATCH} timing-out requests settle`);
      } catch {
        throw new Error(`queue wedged on timeouts: only ${settled} of ${BATCH} requests settled in 45 s`);
      }

      const errors = await Promise.all(failures);
      for (const e of errors) {
        // A resolved entry (null) would mean the deadline did not fire; anything
        // that is not an RwsError would mean a raw AbortError (RWS 1.0) or a bare
        // socket error (RWS 2.0) escaped the client's own error classification.
        expect(e, 'a request under 3 s of latency resolved despite a 700 ms timeout').not.toBeNull();
        expect(e, `expected an RwsError, got ${String(e)}`).toBeInstanceOf(RwsError);
        expect((e as RwsError).code).toBe('NETWORK_ERROR');
      }

      // The real property: the chain is not poisoned. HttpSession keeps the
      // shared queue promise resolved on failure, RwsClient2 catches a failed
      // slot - if either regressed, everything below would hang rather than fail.
      proxy.setLatency(0);
      for (let i = 0; i < 3; i++) {
        await until(async () => {
          try { await c.getControllerState(); return true; }
          catch { return false; }
        }, 25000, `request ${i + 1} after the timeout batch completes`);
      }
    }, 90000);

    it('the >=55 ms pacing floor still holds under injected latency', async () => {
      const proxy = await ctx.proxy();
      const slot = track(proxy);
      const c = probe(slot.client = await ctx.client(proxy, { timeout: 15000 }));
      await c.connect();

      // LOAD reduced 2026-08-09; every assertion below is unchanged.
      //
      // This ran 12 concurrent requests under 500 ms of injected delay. The chaos
      // proxy delays EVERY chunk in BOTH directions, so at 500 ms a single
      // request/response costs a second or more and a TLS handshake several - the
      // burst then stretched past a minute, and the long idle gaps between paced
      // requests guaranteed the controller closed pooled keep-alive connections
      // underneath it. What failed was the rig, not the pacing floor: the same
      // test failed on RWS 1.0 too, whose own client handles that race.
      //
      // The property here is the >=55 ms floor, and it is measured just as
      // strictly at a load that does not manufacture connection churn. Starvation
      // under stress is covered by the timeout-batch test above and by S10.
      proxy.setLatency(250);

      const BURST = 6;
      const completedAt: number[] = [];
      const startedAt = Date.now();
      const results = await Promise.allSettled(
        Array.from({ length: BURST }, () =>
          c.getControllerState().then(
            v => { completedAt.push(Date.now()); return v; },
            e => { completedAt.push(Date.now()); throw e; },
          )),
      );
      const elapsed = Date.now() - startedAt;

      expect(completedAt.length).toBe(BURST);
      for (const r of results) {
        expect(r.status, `burst request failed: ${r.status === 'rejected' ? String(r.reason) : ''}`)
          .toBe('fulfilled');
      }

      // Contractual floor: no two requests may START less than 55 ms apart, so a
      // burst of N cannot finish in less than (N-1)*55 ms however fast the link.
      // Weak on its own under 500 ms of delay (one round trip already clears it)
      // - it is here as the direct statement of the contract; the span check
      // below is the one with teeth.
      expect(elapsed).toBeGreaterThanOrEqual((BURST - 1) * MIN_INTERVAL_MS);

      // The assertion with actual teeth. Under a CONSTANT injected delay every
      // request pays the same round trip, so the spread of COMPLETIONS mirrors
      // the spread of STARTS and the round trip cancels out of the comparison -
      // which the total-elapsed check above cannot claim. A limiter that fired
      // the whole burst at once would land every completion within a few ms of
      // the others and fail here.
      //
      // The 0.8 factor is measurement noise, not slack in the property: request
      // k+1 finishing marginally faster than request k compresses the observed
      // spread even when the starts were correctly paced.
      const span = Math.max(...completedAt) - Math.min(...completedAt);
      expect(span, `completions spanned only ${span} ms for ${BURST} paced requests`)
        .toBeGreaterThanOrEqual((BURST - 1) * MIN_INTERVAL_MS * 0.8);

      // ...and the documented ceiling the floor exists to respect: RWS refuses
      // past ~20 req/s with 503s.
      expect(BURST / (elapsed / 1000)).toBeLessThanOrEqual(20);

      proxy.setLatency(0);
    }, 120000);

    it('quality does not claim "disconnected" while slow requests still succeed (S14 cross-cutting)', async () => {
      const proxy = await ctx.proxy();
      const slot = track(proxy);
      const manager = slot.manager = await ctx.manager(proxy, { refreshIntervalMs: 800 });

      await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
        25000, 'manager reaches a steady quality');

      // Slow, never broken: at 500 ms per direction every poll still lands well
      // inside the per-request timeout, so nothing here justifies "disconnected".
      proxy.setLatency(500);

      // A FIXED SAMPLE COUNT, not a wall-clock window: under CPU contention a
      // 6 s window can shrink to one or two samples, which quietly turns this
      // into a much weaker test than it reads as. Each sample costs one full
      // round trip (~1 s under the injected delay), so six samples still span
      // several refresh intervals - no sleep needed to space them out.
      const SAMPLES = 6;
      for (let i = 0; i < SAMPLES; i++) {
        // Prove requests are still succeeding rather than inferring it from the
        // manager's own quality, which would make the assertion circular. The
        // clock is one GET on both generations - cheap enough to poll, unlike
        // refresh(), which re-runs the whole slow fetch under the delay.
        await expect(manager.getControllerClock(), `clock read ${i + 1}/${SAMPLES} under 500 ms latency`)
          .resolves.toBeTruthy();
        assertQualityHonest(manager, { notDisconnected: true });
      }

      proxy.setLatency(0);
    }, 120000);
  });
}
