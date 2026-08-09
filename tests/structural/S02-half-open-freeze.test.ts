/**
 * S02 - Half-open freeze (sockets alive, no forwarding).
 *
 * The nastiest network fault for an event stream: nothing errors. The TCP
 * connection stays ESTABLISHED, `readyState` stays OPEN, no FIN, no RST - the
 * bytes simply stop moving. A subscriber that trusts the socket believes it is
 * live forever and the consumer silently reads a frozen world.
 *
 * The only defence is the heartbeat, and the two generations implement it
 * differently:
 *   - RWS 1.0 (WsSubscriber) sends an RFC6455 protocol ping each interval; the
 *     IRC5 answers with a protocol pong.
 *   - RWS 2.0 (RwsClient2's subscription block) sends an app-level 'PING' text
 *     frame; the OmniCore answers 'PONG' (any inbound frame counts as proof of
 *     life).
 * Both treat a heartbeat still unanswered at the NEXT tick as half-open,
 * terminate the socket so a `close` event fires, and let the reconnect path run.
 * Detection is therefore bounded by ~2x the ping interval - that bound is what
 * this cell measures.
 *
 * `proxy.freeze()` reproduces the fault exactly: sockets stay open, bytes are
 * held back in both directions. `refuseNew(true)` is layered on top while the
 * freeze is being detected, so the only connection that can disappear during
 * the measurement window is the frozen one - the proxy's open-connection count
 * then becomes physical proof that the socket really was terminated, not just
 * that the client logged an intention to.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import type { WsSubscribeOptions } from '../../src/WsSubscriber.js';
import type {
  SubscriptionEvent, SubscriptionHandle, SubscriptionResource,
} from '../../src/types.js';
import { setLogger } from '../../src/Logger.js';
import {
  cell, until, assertQualityHonest, type AnyClient,
} from '../helpers/structuralHarness.js';

// ─── Tuning ──────────────────────────────────────────────────────────────────
// Production cadence is 10 s (RWS 1.0) / 25 s (RWS 2.0); at that rate one cell
// would take minutes. The MECHANISM is cadence-independent, so the interval is
// shrunk and every budget below is expressed in terms of it.

const PING_MS = 800;
/**
 * Head-room on top of the 2x-ping bound. The heartbeat is a chain of timers
 * (tick -> notice the missing pong -> terminate -> socket close), and this suite
 * runs under parallel-suite CPU load, so the scheduler can add a tick's worth of
 * delay without anything being wrong. It is head-room, not a weakened claim:
 * the failure this bound discriminates against is "never notices", which is
 * unbounded - a client without a working pong deadline sits on a frozen socket
 * until the OS gives up on the TCP connection, minutes later.
 */
const SCHEDULING_SLACK_MS = 1200;
const DETECT_BUDGET_MS = 2 * PING_MS + SCHEDULING_SLACK_MS;

const RECONNECT_BASE_MS = 400;
const RECONNECT_CAP_MS = 800;
/**
 * Deliberately far beyond anything these tests can consume. A budget the client
 * can exhaust while a wait is still waiting turns "did it recover?" into "did it
 * give up first?" - the give-up path has its own test, with its own small budget.
 */
const HUGE_ATTEMPT_BUDGET = 1000;
/** A frozen handshake must fail fast, otherwise one attempt eats the whole test. */
const OPEN_TIMEOUT_MS = 2000;
const CLIENT_TIMEOUT_MS = 4000;

/** Resources chosen for being quiet on an idle VC: no event traffic masks the freeze. */
const RESOURCES: SubscriptionResource[] = ['controllerstate'];

// ─── Log capture ─────────────────────────────────────────────────────────────
// The terminate decision is only observable in the client's own words: both
// subscribers log "…heartbeat missed - terminating half-open…" immediately
// before calling terminate(). The proxy can only show the CONSEQUENCE (a socket
// that went away), which on its own does not distinguish "the heartbeat killed
// it" from "something else did". Both observables are asserted; this one dates
// the decision.

const logLines: string[] = [];
const silentLogger = {
  info() { /* no-op */ }, warn() { /* no-op */ }, error() { /* no-op */ },
  trace() { /* no-op */ }, show() { /* no-op */ },
};

const sawHeartbeatMiss = (): boolean => logLines.some(l => /heartbeat missed/i.test(l));

beforeEach(() => {
  logLines.length = 0;
  setLogger({
    info: m => { logLines.push(m); },
    warn: m => { logLines.push(m); },
    error: m => { logLines.push(m); },
    // Traces carry every HTTP line; dropping them keeps the buffer small.
    trace() { /* no-op */ },
    show() { /* no-op */ },
  });
});

// ─── Cross-generation subscription ───────────────────────────────────────────
// The two clients take the same tuning through different signatures:
// RwsClient.subscribe(resources, handler, opts-with-callbacks) vs
// RwsClient2.subscribe(resources, handler, onLost, onRestored, opts).

type Tuning = Required<Pick<WsSubscribeOptions,
  'pingIntervalMs' | 'reconnectBaseMs' | 'reconnectCapMs' | 'maxReconnectAttempts' | 'openTimeoutMs'>>;

interface Stream {
  stop: () => Promise<void>;
  /**
   * RWS 2.0 only: the `/subscription/{id}` the stream currently holds, read
   * live. RWS 1.0 returns null - its subscriber retries the stored poll URL
   * first (IRC5 poll URLs are reusable after a drop) and only re-POSTs when
   * that is dead, so there is no group id to watch. That is why the matrix asks
   * rws1 for "reconnect path runs" and rws2 for "re-POST /subscription runs".
   */
  groupPath: () => string | null;
}

async function openStream(
  client: AnyClient,
  generation: 'rws1' | 'rws2',
  hooks: { onLost: () => void; onRestored: () => void },
  tuning: Tuning,
  onEvent: (e: SubscriptionEvent) => void = () => undefined,
): Promise<Stream> {
  if (generation === 'rws1') {
    const c = client as unknown as {
      subscribe(
        resources: SubscriptionResource[],
        handler: (e: SubscriptionEvent) => void,
        opts: WsSubscribeOptions,
      ): Promise<() => Promise<void>>;
    };
    const stop = await c.subscribe(RESOURCES, onEvent, { ...tuning, ...hooks });
    return { stop, groupPath: () => null };
  }
  const c = client as unknown as {
    subscribe(
      resources: SubscriptionResource[],
      handler: (e: SubscriptionEvent) => void,
      onLost: () => void,
      onRestored: () => void,
      opts: Tuning,
    ): Promise<SubscriptionHandle>;
  };
  const handle = await c.subscribe(RESOURCES, onEvent, hooks.onLost, hooks.onRestored, tuning);
  return { stop: handle, groupPath: () => handle.groupPath };
}

/**
 * A fixed wait, used ONLY for negative assertions ("nothing further happens").
 * There is nothing to poll for when the expected observation is an absence, so
 * the window has to be wall-clock; every use below states what it is a window
 * for and why its length is enough.
 */
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ─── Cleanup ─────────────────────────────────────────────────────────────────

interface Open {
  proxy?: ChaosProxy;
  client?: AnyClient;
  manager?: RobotManager;
  stream?: Stream;
}

const open: Open[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    // Thaw FIRST: a test that failed mid-freeze would otherwise make every
    // teardown request sit out its full timeout before the suite can move on.
    o.proxy?.refuseNew(false);
    o.proxy?.unfreeze();
    await o.stream?.stop().catch(() => undefined);
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> })?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
  setLogger(silentLogger);
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S02-half-open-freeze', generation, ctx => {
    /**
     * Control for the two tests that follow: the heartbeat must only fire on a
     * REAL freeze. Without this, a client that terminates its socket every two
     * ticks regardless - because the controller never answers the heartbeat at
     * all - would make the detection test pass for entirely the wrong reason.
     *
     * This is also the first live check of the RWS 2.0 pong deadline. The unit
     * suite proves it against a mock that answers 'PING' with 'PONG'; that the
     * OmniCore itself answers is documented (docs/COVERAGE.md) but has never
     * been asserted against a controller. If a VC accepts 'PING' without
     * replying, this test fails on rws2 - and that failure is the finding: the
     * shipped 25 s deadline would then be killing healthy streams every 50 s.
     */
    it('a healthy stream survives several ping intervals - the heartbeat only fires on a real fault', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: CLIENT_TIMEOUT_MS });
      const o: Open = { proxy, client };
      open.push(o);

      await (client as { connect: () => Promise<void> }).connect();

      let lost = 0;
      let restored = 0;
      o.stream = await openStream(client, generation,
        { onLost: () => { lost++; }, onRestored: () => { restored++; } },
        {
          pingIntervalMs: PING_MS, reconnectBaseMs: RECONNECT_BASE_MS,
          reconnectCapMs: RECONNECT_CAP_MS, maxReconnectAttempts: HUGE_ATTEMPT_BUDGET,
          openTimeoutMs: OPEN_TIMEOUT_MS,
        });

      const totalAtStart = proxy.stats().connectionsTotal;

      // Window: 4 ping intervals. Detection is bounded by 2, so a heartbeat that
      // trips on a healthy link has had two chances to do so by the time this
      // returns.
      await settle(4 * PING_MS);

      expect(sawHeartbeatMiss()).toBe(false);
      expect(restored).toBe(0);
      expect(lost).toBe(0);

      // ASSERTION CHANGED 2026-08-09, and the reason is the point of this cell.
      //
      // This originally read `toBe(totalAtStart)` - no reconnect, so not one new
      // connection. That was written against a heartbeat that decided liveness
      // from PONG alone, and this very test proved that design wrong: RW7.21
      // answers neither app-level PING nor protocol ping, so a quiet stream was
      // torn down every two intervals.
      //
      // The fix probes liveness out of band, which costs ONE pooled HTTP socket
      // for the lifetime of the subscription. So the honest assertion is not
      // "nothing connects" but "nothing CHURNS": the probe's socket is keep-alive
      // and reused, whereas the bug it replaced opened a fresh WebSocket plus a
      // fresh /subscription every two intervals. Over this 4-interval window the
      // old behaviour would show at least two reconnects.
      //
      // Strictly bounded on purpose - one connection, not "some".
      const opened = proxy.stats().connectionsTotal - totalAtStart;
      expect(opened, 'liveness probing must not churn connections').toBeLessThanOrEqual(1);
    }, 60000);

    it('a frozen stream is detected within 2x the ping interval, terminated, and recovered', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: CLIENT_TIMEOUT_MS });
      const o: Open = { proxy, client };
      open.push(o);

      await (client as { connect: () => Promise<void> }).connect();

      let lost = 0;
      let restored = 0;
      const stream = await openStream(client, generation,
        { onLost: () => { lost++; }, onRestored: () => { restored++; } },
        {
          pingIntervalMs: PING_MS, reconnectBaseMs: RECONNECT_BASE_MS,
          reconnectCapMs: RECONNECT_CAP_MS, maxReconnectAttempts: HUGE_ATTEMPT_BUDGET,
          openTimeoutMs: OPEN_TIMEOUT_MS,
        });
      o.stream = stream;
      const groupBeforeFreeze = stream.groupPath();

      const connsAtFreeze = proxy.connections();
      const totalAtFreeze = proxy.stats().connectionsTotal;
      const frozenAt = Date.now();
      // refuseNew BEFORE freeze: during the measurement window no new pair can
      // be established, so any drop in the open-connection count below is the
      // frozen socket dying and nothing else.
      proxy.refuseNew(true);
      proxy.freeze();

      // The budget here is deliberately far larger than the bound being
      // asserted: a timeout would only say "never", while the expect() below
      // reports the actual detection time, which is the diagnosis either way.
      await until(sawHeartbeatMiss, 30000, 'the heartbeat notices the frozen stream');
      const detectedMs = Date.now() - frozenAt;
      expect(detectedMs).toBeLessThanOrEqual(DETECT_BUDGET_MS);

      // Physical proof that terminate() actually reached the wire: the proxy saw
      // the client end of the frozen pair close. The window is short ON PURPOSE.
      // The only other socket this client holds through the proxy is the HTTP
      // keep-alive one, and the earliest that can disappear is the first
      // reconnect attempt's request giving up on the frozen link - no sooner
      // than reconnectBase + CLIENT_TIMEOUT_MS (~4.4 s) from here. A generous
      // window would let that count as "the frozen socket died", so a drop seen
      // inside 3 s is attributable to terminate() and to nothing else.
      await until(() => proxy.connections() < connsAtFreeze, 3000,
        'the frozen socket is gone at the TCP level, not merely logged');

      // …and the reconnect path runs: every attempt (WS re-open on RWS 1.0,
      // DELETE+re-POST on RWS 2.0) needs a fresh connection, which the proxy
      // counts even while it is refusing them.
      await until(() => proxy.stats().connectionsTotal > totalAtFreeze, 25000,
        'the reconnect path attempts a fresh connection');

      // Thaw: the next attempt must succeed and the consumer must be told.
      proxy.refuseNew(false);
      proxy.unfreeze();

      await until(() => restored >= 1, 45000, 'onRestored fires after recovery');
      // Recovery, not surrender: the budget was set far out of reach.
      expect(lost).toBe(0);

      if (generation === 'rws2') {
        // RWS 2.0 re-POSTs /subscription on every reconnect (the old poll URL is
        // spent), so the stream must now hold a DIFFERENT group than before the
        // freeze. The controller hands out a fresh group id per POST; if a
        // controller is ever seen reusing one, this needs a byte-level proof
        // instead - but "same group as before" would otherwise be indis-
        // tinguishable from "no re-POST happened at all".
        // Both ends are checked: `groupPath` is '' whenever no group is held, so
        // an unasserted pre-freeze value would make "the group changed" true for
        // the wrong reason ('' -> '/subscription/3' is a change, but it would
        // mean the FIRST subscribe never captured a group).
        expect(groupBeforeFreeze).toMatch(/^\/subscription\/.+/);
        const groupAfter = stream.groupPath();
        expect(groupAfter).toMatch(/^\/subscription\/.+/);
        expect(groupAfter).not.toBe(groupBeforeFreeze);
      }
    }, 120000);

    it('a freeze outlasting the reconnect budget fires onLost exactly once, then stops', async () => {
      const proxy = await ctx.proxy();
      // Short client timeout: while frozen, each attempt's HTTP leg can only
      // fail by timing out, and two of those per attempt is the whole cost of
      // exhausting the budget.
      const client = await ctx.client(proxy, { timeout: 2500 });
      const o: Open = { proxy, client };
      open.push(o);

      await (client as { connect: () => Promise<void> }).connect();

      let lost = 0;
      let restored = 0;
      o.stream = await openStream(client, generation,
        { onLost: () => { lost++; }, onRestored: () => { restored++; } },
        {
          pingIntervalMs: PING_MS, reconnectBaseMs: 150, reconnectCapMs: 300,
          maxReconnectAttempts: 2, openTimeoutMs: 1500,
        });

      // Frozen AND refusing: the established socket goes half-open, and every
      // reconnect attempt is refused at accept, so the budget burns down
      // deterministically instead of racing a timeout.
      proxy.refuseNew(true);
      proxy.freeze();

      await until(() => lost >= 1, 60000, 'onLost fires when the reconnect budget is exhausted');
      // …and it got there through half-open detection. Under a freeze nothing
      // else can end the socket - no RST, no FIN, no upgrade rejection - so a
      // give-up without this line would mean the stream died of something the
      // cell is not testing, and the budget-exhaustion claim would be attached
      // to the wrong cause.
      expect(sawHeartbeatMiss()).toBe(true);
      expect(restored).toBe(0);

      // Window: the give-up path fires a best-effort DELETE of the dead group
      // from the same block that calls onLost, so its connection attempt can
      // still be in flight the instant onLost is observed. Snapshotting before
      // it lands would make the "no further attempts" check race the give-up's
      // own last request.
      await settle(1000);
      const totalAfterGiveUp = proxy.stats().connectionsTotal;

      // Window: 10x the capped backoff (300 ms). A retry loop that survived the
      // give-up would have opened several connections inside it.
      await settle(3000);
      expect(proxy.stats().connectionsTotal).toBe(totalAfterGiveUp);
      // Exactly once - not once per exhausted attempt, and not again later.
      expect(lost).toBe(1);
    }, 120000);

    it('quality stops claiming "live" while the link is frozen (S14 cross-cutting)', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 300 });
      open.push({ proxy, manager });

      // 'live' specifically, NOT "live or polling": a manager that had already
      // fallen back to polling before the freeze would satisfy "not live" the
      // instant the freeze is applied, and the assertion below would pass
      // without the fault having been detected at all. This cell is about a
      // LIVE stream going half-open, and the three tests above have already
      // established that the WebSocket comes up through this proxy on both
      // generations - so anything but 'live' here is a real failure.
      await until(() => manager.state.quality === 'live', 25000,
        'manager reaches "live" (a live stream is the precondition for this test)');

      // A freeze is the hardest case for a quality signal: no socket errors, no
      // refused connections - only the absence of answers reveals the fault. A
      // quality derived from "the connection is up" keeps claiming live here; it
      // has to be derived from answers actually arriving.
      proxy.freeze();

      // Past 'polling', not merely off 'live'. A total freeze stops the POLLS
      // too, so "the event stream is gone but polling has us covered" is itself
      // a false claim here - the honest states are 'stale' (a poll failed) or
      // 'disconnected' (three did). Accepting 'polling' would let the manager
      // downgrade one notch and still lie about the data being fresh.
      await until(
        () => manager.state.quality !== 'live' && manager.state.quality !== 'polling',
        40000, 'quality degrades past "polling" - a frozen link fails polls too');
      assertQualityHonest(manager, { notLive: true });

      proxy.unfreeze();
    }, 90000);
  });
}
