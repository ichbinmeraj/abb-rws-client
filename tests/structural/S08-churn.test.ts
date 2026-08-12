/**
 * S08 - Rapid connect/disconnect churn (50+ cycles).
 *
 * The only cell that injects no fault at all. That is deliberate: a leak has to
 * be provable on the HAPPY path, because that is where it hides. Every other
 * cell breaks something and then asserts the client recovers; this one asserts
 * that fifty clean round trips cost the process nothing it does not give back -
 * no socket, no timer, no controller session, no subscription group, no heap
 * that only ever climbs.
 *
 * Three churns, because the client owns three different kinds of resource and a
 * leak in one is invisible from the others:
 *   1. connect/disconnect - HTTP sessions and pooled sockets;
 *   2. subscribe/unsubscribe - a WebSocket AND a heartbeat interval AND a
 *      controller-side subscription group, all three per subscription;
 *   3. RobotManager connect/disconnect - the polling interval and the
 *      subscription the manager owns on the consumer's behalf.
 *
 * Measurement is leakProbe's measureCycles(), which runs one warm-up cycle
 * before snapshotting so first-call lazy work - notably the `ws` import, which
 * only happens on the first subscribe - is charged to the warm-up rather than
 * counted as growth.
 *
 * What the numbers can and cannot prove: `npm run structural` does not pass
 * --expose-gc, so leakProbe's forceGc() is a no-op and heapUsed still holds
 * collectible garbage. The probe documents this itself; accordingly the handle
 * counts carry the strict assertions here and the heap ceiling is a generous
 * sanity bound, with the matrix's actual heap property ("does not grow
 * monotonically") asserted from per-cycle samples instead.
 */

import { it, expect, afterEach } from 'vitest';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import type { SubscriptionResource } from '../../src/types.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import {
  cell, until, assertQualityHonest, type AnyClient,
} from '../helpers/structuralHarness.js';
import { measureCycles, type ResourceSnapshot } from '../helpers/leakProbe.js';

/** The matrix says "50+ cycles"; measureCycles adds a warm-up on top, so 51 run. */
const CYCLES = 50;

/**
 * The manager churn runs fewer cycles on purpose, and it is not a weakened bar.
 * Every RobotManager.connect() performs a full state poll (tasks, modules,
 * mechunits, positions, identity, event log, I/O), so 50 cycles would push ~1000
 * requests at a controller that two other agents share, for no extra signal: a
 * resource leaked once per cycle shows up as +8 against a tolerance of 2, which
 * fails just as loudly as +50 would. The 50-cycle bar is met by the two client
 * churns above it, which are cheap enough to run at full length.
 */
const MANAGER_CYCLES = 8;

/**
 * A leak is growth that SCALES with the cycle count, so the bar is a small
 * constant rather than exactly zero - one socket still in TIME_WAIT, or a timer
 * belonging to the runner, is not a leak. Anything that leaks once per cycle
 * lands at +50 (or +8 for the manager churn) and cannot hide under this.
 */
const TOLERANCE = 2;

/**
 * Deliberately generous: without --expose-gc this delta includes garbage V8
 * simply has not collected yet. It is a ceiling against gross retention (fifty
 * live clients, an unbounded event buffer), not a precision instrument.
 */
const HEAP_LIMIT_BYTES = 48 * 1024 * 1024;

/**
 * Connections the proxy may still hold once the churn has settled. Both clients
 * keep HTTP connections alive by design (RWS 1.0 rides the global undici pool,
 * RWS 2.0 its own keep-alive agents), so the honest bar is a small
 * CYCLE-INDEPENDENT constant: a socket leaked per cycle would sit near 50 here.
 */
const MAX_OPEN_CONNECTIONS = 4;

/** 55 ms between cycles - the same spacing both clients enforce internally, so
 *  the churn cannot outrun the controller's <20 req/s ceiling. */
const pace = (): Promise<void> => new Promise(r => setTimeout(r, 55));

/** The structural surface both generations share, without a union cast per call. */
interface ChurnClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getControllerState(): Promise<string>;
}
const asChurn = (c: AnyClient): ChurnClient => c as unknown as ChurnClient;

type Unsubscribe = () => Promise<void>;

/** 'controllerstate' maps on both generations and is read-only - churning it
 *  cannot touch program execution or any held privilege. */
const SUB_RESOURCES: SubscriptionResource[] = ['controllerstate'];

/**
 * The two clients spell the same call differently: RWS 1.0 takes an options
 * object, RWS 2.0 takes onLost/onRestored positionally and returns a
 * SubscriptionHandle. Both are callable, and both DELETE the controller-side
 * group on call, which is the whole contract this cell exercises.
 */
async function subscribeOnce(client: AnyClient, onLost: () => void): Promise<Unsubscribe> {
  if (client instanceof RwsClient2) {
    return await client.subscribe(SUB_RESOURCES, () => undefined, onLost);
  }
  return await client.subscribe(SUB_RESOURCES, () => undefined, { onLost });
}

/**
 * Kinds Node reports for a live socket handle. 'TCPSocketWrap' is a plain
 * socket, 'TLSWrap' the RWS 2.0 TLS layer, 'TCPServerWrap' the chaos proxy's own
 * listener (constant, so it cancels out between the two snapshots).
 */
const SOCKET_KIND = /tcp|tls|socket/i;
/** setTimeout and setInterval both surface as 'Timeout' - a leaked heartbeat,
 *  reconnect or poll timer lands here. */
const TIMER_KIND = /^timeout$|timer|interval/i;

function count(s: ResourceSnapshot, re: RegExp): number {
  return Object.entries(s.byKind).reduce((n, [k, v]) => (re.test(k) ? n + v : n), 0);
}

function kinds(before: ResourceSnapshot, after: ResourceSnapshot): string {
  return `before=${JSON.stringify(before.byKind)} after=${JSON.stringify(after.byKind)}`;
}

/**
 * Two things, from the one array of per-cycle heap samples.
 *
 * First that `expected` cycles actually completed - every other assertion in
 * this cell compares two snapshots and would pass trivially over a run that did
 * nothing, so the sample count is the cell's proof of work.
 *
 * Then the matrix property, asserted literally: heapUsed sampled once per cycle
 * must fall at least once. V8 scavenges young-generation garbage every few MB,
 * and a cycle of RWS traffic allocates far more than that, so a run in which the
 * heap never once dropped means nothing was ever reclaimed - monotonic growth.
 */
function assertHeapNotMonotonic(samples: number[], expected: number, label: string): void {
  // First, the proof that the churn actually RAN. One sample is pushed at the
  // end of every cycle, so a short array means cycles were skipped - and every
  // "nothing grew" verdict above would then have measured nothing at all, which
  // is the one way this cell could go green while proving zero.
  expect(
    samples.length,
    `${label}: only ${samples.length} of ${expected} cycles completed - the leak `
    + 'verdicts above measured an empty run',
  ).toBe(expected);

  const drops = samples.filter((v, i) => i > 0 && v < samples[i - 1]).length;
  const growth = samples.length ? samples[samples.length - 1] - samples[0] : 0;
  expect(
    drops,
    `${label}: heapUsed rose at every one of ${samples.length} cycles `
    + `(+${(growth / 1048576).toFixed(1)} MB end to end) - nothing was ever reclaimed`,
  ).toBeGreaterThan(0);
}

/** Shared shape for the three churns' resource assertions. */
function assertNoGrowth(
  verdict: Awaited<ReturnType<typeof measureCycles>>, cycles: number, label: string,
): void {
  const { before, after } = verdict.snapshots;
  const report = kinds(before, after);

  // Per-kind: nothing at all may grow past the tolerance.
  expect(verdict.grew, `${label}: resources grew over ${cycles} cycles - ${report}`).toEqual([]);

  // …and in aggregate, so a leak that spreads across two kinds (a TLSWrap plus
  // its TCPSocketWrap, say) cannot slip through under a per-kind bar.
  expect(
    count(after, SOCKET_KIND) - count(before, SOCKET_KIND),
    `${label}: leaked sockets - ${report}`,
  ).toBeLessThanOrEqual(TOLERANCE);
  expect(
    count(after, TIMER_KIND) - count(before, TIMER_KIND),
    `${label}: leaked timers - ${report}`,
  ).toBeLessThanOrEqual(TOLERANCE);

  expect(
    verdict.heapDeltaBytes,
    `${label}: heap grew ${(verdict.heapDeltaBytes / 1048576).toFixed(1)} MB over ${cycles} cycles`,
  ).toBeLessThanOrEqual(HEAP_LIMIT_BYTES);
}

const open: Array<{ proxy?: ChaosProxy; client?: AnyClient; manager?: RobotManager }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> })?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S08-churn', generation, ctx => {
    it('50 connect/disconnect cycles leak no sockets, timers or controller sessions', async () => {
      // ONE proxy for the whole run, deliberately. A proxy per cycle would add a
      // listener and a fresh ORIGIN each time, and RWS 1.0 runs on the global
      // undici pool, which is keyed by origin and never freed - churning ports
      // would report growth that belongs to the test, not to the client.
      const proxy = await ctx.proxy();
      // `live` holds whichever client is mid-cycle. Registered BEFORE the proxy
      // so afterEach drains it first and its GET /logout still has a route: a
      // cycle that throws between connect() and disconnect() would otherwise
      // strand a real controller session, and the controller caps those.
      const live: { client?: AnyClient } = {};
      open.push(live, { proxy });

      const heap: number[] = [];
      const cycle = async (): Promise<void> => {
        const raw = await ctx.client(proxy, { timeout: 8000 });
        live.client = raw;
        const client = asChurn(raw);
        try {
          await client.connect();
          // A connect that merely opened a socket proves nothing. Reading state
          // forces a full authenticated round trip, so the cycle really owns a
          // controller session that disconnect() then has to give back - and the
          // ANSWER is checked, not just awaited. A client that resolved with
          // undefined, or served a cached value without touching the network,
          // would otherwise sail through a leak test that never leaked because
          // it never connected.
          const state = await client.getControllerState();
          expect(state, 'getControllerState() resolved with nothing').toBeTruthy();
        } finally {
          await client.disconnect();
          live.client = undefined;
        }
        heap.push(process.memoryUsage().heapUsed);
        await pace();
      };

      const verdict = await measureCycles(CYCLES, cycle, {
        settleMs: 2000, tolerancePerKind: TOLERANCE, heapGrowthLimitBytes: HEAP_LIMIT_BYTES,
      });

      assertNoGrowth(verdict, CYCLES, 'connect/disconnect churn');
      assertHeapNotMonotonic(heap, CYCLES + 1, 'connect/disconnect churn');

      // Transport-level cross-check on the same claim, independent of Node's
      // handle accounting: the proxy counts live client<->controller pairs.
      const openNow = proxy.stats().connectionsOpen;
      expect(
        openNow,
        `proxy still holds ${openNow} connections after ${CYCLES} disconnects `
        + `(${proxy.stats().connectionsTotal} accepted in total)`,
      ).toBeLessThanOrEqual(MAX_OPEN_CONNECTIONS);

      // Sessions. Neither client exposes a controller-side session count, so the
      // property is asserted by the consequence a leak actually has - and the
      // binding limit is NOT the 70-session pool, which 51 sessions could never
      // fill. It is the PER-IP cap: 5 sessions (or 15 connections) from one
      // address, official for both generations
      // (reference/VC_VS_REAL_CONTROLLERS.md §2), over which the controller
      // answers 503 and both clients raise CONTROLLER_BUSY. Every cycle above
      // ran from 127.0.0.1, so a disconnect() that did not free its session
      // breaks the churn around the sixth cycle - the completed-cycle count
      // asserted by assertHeapNotMonotonic is where a session leak lands.
      //
      // This probe is the other half of the claim: after 51 logouts a FRESH
      // session must still be grantable. It catches the leak that only appears
      // at the end - sessions the controller reclaims lazily on socket close
      // rather than promptly on GET /logout - which the churn itself, spaced by
      // pace(), might survive.
      const rawProbe = await ctx.client(proxy, { timeout: 8000 });
      live.client = rawProbe;
      const probe = asChurn(rawProbe);
      try {
        await probe.connect();
        await expect(probe.getControllerState()).resolves.toBeTruthy();
      } finally {
        await probe.disconnect();
        live.client = undefined;
      }
    }, 300000);

    it('50 subscribe/unsubscribe cycles leak no WebSockets, heartbeat timers or subscription groups', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: 8000 });
      // Client before proxy: afterEach drains in order, so the client's /logout
      // still has a route when it runs.
      open.push({ client }, { proxy });

      await asChurn(client).connect();

      // onLost fires from exactly one place - WsSubscriber.scheduleReconnect,
      // once a stream's reconnect budget is spent. Nothing in this test ever
      // breaks a link, so the only way it can fire is a WebSocket this test
      // believes it closed dying on its own afterwards: an unsubscribe that
      // returned before its socket was really gone. Zero is the only honest
      // answer, and it is the reason the loop below awaits every stop().
      let lost = 0;
      const heap: number[] = [];

      // The warm-up cycle inside measureCycles absorbs the lazy `ws` load (a
      // dynamic import on RWS 2.0, createRequire on RWS 1.0) so the module graph
      // is not billed as growth.
      const cycle = async (): Promise<void> => {
        const stop = await subscribeOnce(client, () => { lost++; });
        await stop();
        heap.push(process.memoryUsage().heapUsed);
        await pace();
      };

      const verdict = await measureCycles(CYCLES, cycle, {
        settleMs: 2500, tolerancePerKind: TOLERANCE, heapGrowthLimitBytes: HEAP_LIMIT_BYTES,
      });

      assertNoGrowth(verdict, CYCLES, 'subscribe/unsubscribe churn');
      assertHeapNotMonotonic(heap, CYCLES + 1, 'subscribe/unsubscribe churn');
      expect(lost, `${lost} subscription(s) kept reconnecting after unsubscribe`).toBe(0);

      // Controller-side groups. There is no "list subscriptions" resource in
      // either protocol, so the count is not directly readable - but the ceiling
      // is low and official: a client may hold at most TEN subscription groups
      // (reference/VC_VS_REAL_CONTROLLERS.md §3). One group leaked per cycle
      // therefore makes the ELEVENTH subscribe fail, which rejects that cycle,
      // rejects measureCycles, and stops the sample array short - which is
      // precisely what assertHeapNotMonotonic's completed-cycle check just
      // refused to accept. Fifty-one successful subscribes on one session is
      // only reachable if every unsubscribe really did DELETE its group.
      const openNow = proxy.stats().connectionsOpen;
      expect(
        openNow,
        `proxy still holds ${openNow} connections after ${CYCLES} unsubscribes`,
      ).toBeLessThanOrEqual(MAX_OPEN_CONNECTIONS);
    }, 420000);

    it('manager churn releases the poll timer and its subscription, and quality tells the truth (S14 cross-cutting)', async () => {
      const proxy = await ctx.proxy();
      // Manager slot first, proxy second - afterEach drains in push order, so a
      // manager left live by a failed cycle still gets torn down over a working
      // route. A stranded RobotManager is the worst leak in this file: it keeps
      // a poll interval AND a subscription AND a session running for the rest of
      // the suite.
      const live: { manager?: RobotManager } = {};
      open.push(live, { proxy });

      const heap: number[] = [];
      const cycle = async (): Promise<void> => {
        // A slow refresh interval on purpose: the poll TIMER exists either way,
        // which is what the leak assertion reads, and a fast one would spend the
        // controller's request budget on data nothing here looks at.
        const manager = await ctx.manager(proxy, { refreshIntervalMs: 5000 });
        live.manager = manager;
        try {
          await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
            25000, 'manager reaches a steady quality');
          assertQualityHonest(manager, { notDisconnected: true });
        } finally {
          await manager.disconnect();
          live.manager = undefined;
        }
        // A deliberate disconnect must be reported as one, with a reason - and
        // reported as exactly that. "not live" alone would also be satisfied by
        // 'reconnecting' or 'stale', which are the states of a manager still
        // running and merely unhappy - precisely what a manager we just tore
        // down must never look like, because a consumer seeing 'reconnecting'
        // waits for it to come back.
        expect(manager.state.connected, 'manager still claims connected after disconnect()').toBe(false);
        expect(
          manager.state.quality,
          `quality is "${manager.state.quality}" after a deliberate disconnect()`,
        ).toBe('disconnected');
        assertQualityHonest(manager, { notLive: true });
        heap.push(process.memoryUsage().heapUsed);
        await pace();
      };

      const verdict = await measureCycles(MANAGER_CYCLES, cycle, {
        settleMs: 2500, tolerancePerKind: TOLERANCE, heapGrowthLimitBytes: HEAP_LIMIT_BYTES,
      });

      assertNoGrowth(verdict, MANAGER_CYCLES, 'manager churn');
      assertHeapNotMonotonic(heap, MANAGER_CYCLES + 1, 'manager churn');

      const openNow = proxy.stats().connectionsOpen;
      expect(
        openNow,
        `proxy still holds ${openNow} connections after ${MANAGER_CYCLES} manager disconnects`,
      ).toBeLessThanOrEqual(MAX_OPEN_CONNECTIONS);
    }, 420000);
  });
}
