/**
 * S04 - Session idle past expiry, then burst.
 *
 * A session that has gone stale must heal itself on the next request: the
 * consumer calls a method, the client re-authenticates underneath, and the call
 * returns a value. No error, no reconnect dance, no quality wobble. The burst
 * that typically follows (a UI waking up and refreshing everything at once) must
 * still be paced - re-authenticating is not a licence to exceed the RWS request
 * ceiling.
 *
 * Real expiry is ~5 minutes, far too slow for the default suite, so each
 * property is asserted twice:
 *   - a FAST deterministic path that forces the exact same code branch, and
 *   - the honest SLOW path behind RWS_STRUCTURAL_SLOW=1, which actually idles.
 *
 * How the fast path forces expiry, per generation:
 *   rws1 - HttpSession decides expiry from a private `lastActivityTime` and, on
 *          expiry, drops the digest challenge so the next request 401s and
 *          re-handshakes. Rewinding that timestamp takes the identical branch.
 *          The test also logs out first, so the controller has genuinely
 *          forgotten the session the client still holds a cookie for.
 *   rws2 - RwsClient2 keeps no expiry clock at all; what dies over an idle is
 *          the controller-side session its cookie names. Logging out and then
 *          replacing the cookie with one no session answers to reproduces
 *          exactly that, and the recovery path under test is the Set-Cookie
 *          adoption in req().
 *
 * Both injections are one-shot writes to state the client itself keeps
 * rewriting, so anywhere a poll loop is running they are applied under a
 * re-arming until() that returns only once the client's own state proves the
 * expiry branch ran. See forceExpiryUnderPolling.
 */

import { it, expect, afterEach } from 'vitest';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import {
  cell, until, assertQualityHonest, type AnyClient,
} from '../helpers/structuralHarness.js';

const open: Array<{ proxy?: ChaosProxy; client?: AnyClient; manager?: RobotManager }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> })?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
});

/**
 * Minimum ms between the STARTS of two requests. Both clients enforce it -
 * `RwsClient` via HttpSessionOptions.requestIntervalMs (default 55) and
 * `RwsClient2` via the private MIN_MS - and both do so to stay under the
 * documented RWS ceiling of 20 requests/second.
 */
const MIN_INTERVAL_MS = 55;

/** HttpSession.SESSION_TIMEOUT_MS, mirrored: it is private and must stay so. */
const RWS1_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

/** Slack for Date.now()/timer granularity under CPU contention on Windows. */
const TIMER_SLACK_MS = 5;

/** A cookie value no controller session can possibly answer to. */
const DEAD_COOKIE = '-http-session-=S04-expired-0000000000000000';

/** Only the gated slow path actually waits out a real expiry. */
const SLOW_ENABLED = process.env.RWS_STRUCTURAL_SLOW === '1';

/** The RWS 1.0 session state this cell has to reach. */
interface Rws1Session {
  lastActivityTime: number;
  nonceCount: number;
  digestChallenge: object | null;
}

/** The RWS 2.0 client's cookie slot. */
interface Rws2CookieHolder {
  sessionCookie: string | null;
}

/**
 * Reach the HttpSession behind a client or a manager.
 *
 * Private on purpose - `RwsClient` owns its session, `RWS1Adapter` owns its
 * client - but expiry has no public surface at all, and the public one cannot
 * distinguish the property under test ("it re-authenticated") from the trivial
 * case ("it never needed to"). Reaching in is what makes the assertion honest.
 */
function rws1SessionOf(target: AnyClient | RobotManager): Rws1Session {
  const t = target as unknown as {
    session?: Rws1Session;
    adapter?: { client?: { session?: Rws1Session } };
  };
  const s = t.session ?? t.adapter?.client?.session;
  if (!s || typeof s.lastActivityTime !== 'number') {
    throw new Error('could not reach the HttpSession - S04 needs it to force expiry');
  }
  return s;
}

/** Same idea for RWS 2.0: RWS2Adapter *is* an RwsClient2, so both shapes work. */
function rws2CookieHolderOf(target: AnyClient | RobotManager): Rws2CookieHolder {
  const t = target as unknown as { sessionCookie?: string | null; adapter?: Rws2CookieHolder };
  const h = t.adapter ?? (t as Rws2CookieHolder);
  if (!h || !('sessionCookie' in h)) {
    throw new Error('could not reach the RWS 2.0 session cookie - S04 needs it to force expiry');
  }
  return h;
}

/** What the session looked like immediately before the fault was injected. */
interface Baseline {
  /** RWS 1.0 only: nonce uses accumulated on the pre-fault challenge. */
  nonceBefore: number;
  /** RWS 2.0 only: the cookie of the session the controller is about to forget. */
  cookieBefore: string | null;
}

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S04-idle-expiry', generation, ctx => {
    /**
     * Leave the session in the state a >5 min idle leaves it in, without the
     * wait. Only safe on a QUIESCENT client: see forceExpiryUnderPolling for
     * the version that survives a manager polling in the background.
     *
     * `logout` frees the controller-side slot first, so the client is left
     * holding a cookie that names nothing - exactly what an idle timeout does,
     * and (unlike simply abandoning the cookie) it orphans no session on a
     * controller that only has a few dozen of them.
     */
    const forceExpiry = async (
      target: AnyClient, opts: { logout?: boolean } = {},
    ): Promise<Baseline> => {
      if (generation === 'rws1') {
        const session = rws1SessionOf(target);
        if (opts.logout) {
          await (target as unknown as {
            request(m: 'GET', p: string): Promise<{ status: number; body: string }>;
          }).request('GET', '/logout').catch(() => undefined);
        }
        const nonceBefore = session.nonceCount;
        // The rewind must come last: a successful /logout stamps lastActivityTime.
        session.lastActivityTime = Date.now() - (RWS1_SESSION_TIMEOUT_MS + 1000);
        return { nonceBefore, cookieBefore: null };
      }
      const holder = rws2CookieHolderOf(target);
      // Captured before the logout: this is the session the controller is about
      // to forget, and the value the recovery must NOT come back holding.
      const cookieBefore = holder.sessionCookie;
      expect(cookieBefore).toBeTruthy();
      if (opts.logout) {
        // Same slot hygiene as the RWS 1.0 branch. `req` is private and there is
        // no public "log out but stay usable" - disconnect() would also tear
        // down the agent and subscriptions this test still needs.
        await (target as unknown as {
          req(m: string, p: string): Promise<string>;
        }).req('GET', '/logout').catch(() => undefined);
      }
      holder.sessionCookie = DEAD_COOKIE;
      return { nonceBefore: 0, cookieBefore };
    };

    /**
     * Inject the same expiry into a client a RobotManager is actively polling,
     * and do not return until it has demonstrably fired.
     *
     * Injecting once and moving on is the trap this cell would otherwise fall
     * into: HttpSession stamps lastActivityTime on every SUCCESSFUL response, so
     * a poll request already in flight re-stamps the rewound clock and the
     * expiry branch never runs; likewise any response carrying a Set-Cookie
     * heals the forged cookie before a request can carry it. On those runs every
     * assertion below still passes - a green cell that tested nothing. So re-arm
     * until the client's own state proves the branch ran.
     */
    const forceExpiryUnderPolling = async (manager: RobotManager): Promise<void> => {
      if (generation === 'rws1') {
        const session = rws1SessionOf(manager);
        const nonceBefore = session.nonceCount;
        // The manager has already polled, so the nonce has been used repeatedly;
        // without that a decrease below would prove nothing.
        expect(nonceBefore).toBeGreaterThanOrEqual(2);
        await until(() => {
          // Polls only ever increment nonceCount; only the 401 handshake resets
          // it. A decrease is therefore unambiguous proof of a re-auth.
          if (session.nonceCount < nonceBefore) { return true; }
          session.lastActivityTime = Date.now() - (RWS1_SESSION_TIMEOUT_MS + 1000);
          return false;
        }, 25000, 'the expired-session branch fires under polling');
        return;
      }
      const holder = rws2CookieHolderOf(manager);
      const cookieBefore = holder.sessionCookie;
      expect(cookieBefore).toBeTruthy();
      holder.sessionCookie = DEAD_COOKIE;
      await until(() => {
        const now = holder.sessionCookie;
        // Neither the forged cookie nor the pre-fault one: the controller minted
        // a fresh session, which it only does for a request whose cookie it did
        // not recognise. That request is the one that carried DEAD_COOKIE.
        if (now && now !== DEAD_COOKIE && now !== cookieBefore) { return true; }
        // Healed back to the old cookie by a Set-Cookie that raced the forge -
        // no request ever carried the dead one, so arm it again.
        if (now !== DEAD_COOKIE) { holder.sessionCookie = DEAD_COOKIE; }
        return false;
      }, 25000, 'a request carries the dead cookie and adopts a freshly minted one');
    };

    /** Assert the recovery actually re-authenticated rather than got lucky. */
    const assertReauthenticated = (target: AnyClient, base: Baseline): void => {
      if (generation === 'rws1') {
        const session = rws1SessionOf(target);
        // Expiry nulls the challenge; only a fresh 401 handshake can restore it.
        expect(session.digestChallenge).not.toBeNull();
        // The handshake resets nonceCount to 0, so the retry that completes the
        // recovering request leaves it at 1 (2 if a 503 forced one more try).
        // A client that answered with the STALE nonce instead would show
        // nonceBefore + 1 here - the failure mode this cell exists to catch.
        expect(session.nonceCount).toBeGreaterThanOrEqual(1);
        expect(session.nonceCount).toBeLessThanOrEqual(2);
        // Stated the second way round: the counter went DOWN across a request.
        // Guarded by the setup check so a drifting setup fails loudly instead of
        // quietly comparing against 1.
        expect(base.nonceBefore).toBeGreaterThanOrEqual(2);
        expect(session.nonceCount).toBeLessThan(base.nonceBefore);
        return;
      }
      // RWS 2.0 sends Basic on every request, so "re-auth" means: the dead
      // cookie was replaced by the one the controller minted on this exchange.
      // Keeping the dead cookie is not cosmetic - it is what made every later
      // WS upgrade 401 forever on RW7.21 (see the note in RwsClient2.req).
      const cookie = rws2CookieHolderOf(target).sessionCookie;
      expect(cookie).toBeTruthy();
      expect(cookie).not.toBe(DEAD_COOKIE);
      // …and it is a genuinely NEW session, not the pre-fault one resurrected.
      expect(cookie).not.toBe(base.cookieBefore);
    };

    /**
     * Fire `burst` reads back to back and prove the client still paced them.
     *
     * Measured from the API surface, not the wire: the chaos proxy forwards
     * bytes without parsing them, and RWS 2.0 traffic is TLS anyway, so counting
     * HTTP requests on the wire is not available to this cell.
     */
    const assertBurstRespectsCeiling = async (client: AnyClient, burst = 22): Promise<void> => {
      const c = client as { getControllerState: () => Promise<string> };
      const t0 = Date.now();
      /** Completion instants - the only per-request timing the API surface offers. */
      const done: number[] = [];
      const results = await Promise.all(Array.from({ length: burst }, async () => {
        const v = await c.getControllerState();
        done.push(Date.now());
        return v;
      }));
      const elapsed = Date.now() - t0;

      // Every one of them must have succeeded - a burst that "respects the
      // ceiling" by failing half its requests respects nothing.
      for (const r of results) { expect(typeof r).toBe('string'); expect(r).not.toBe(''); }

      // Pacing is enforced between request STARTS, so N calls cannot complete in
      // less than (N-1) intervals. This is the aggregate claim.
      expect(elapsed).toBeGreaterThanOrEqual((burst - 1) * MIN_INTERVAL_MS - TIMER_SLACK_MS);

      // The aggregate claim alone would be satisfied by a client that fired the
      // whole burst at once and then idled, which is exactly what a re-auth path
      // that bypasses its own queue looks like. So bound the worst SECOND, not
      // the mean: the burst is longer than one second of paced traffic, so this
      // window really is observed rather than extrapolated. The 55 ms floor
      // permits at most floor(1000/55)+1 = 19 starts per second; 20 is the
      // documented RWS ceiling, and the extra slack absorbs the fact that
      // completions can bunch slightly tighter than starts when an early slow
      // request (the digest 401+retry) is followed by fast ones.
      const sorted = [...done].sort((a, b) => a - b);
      let maxInAnySecond = 0;
      for (let i = 0; i < sorted.length; i++) {
        let n = 0;
        while (i + n < sorted.length && sorted[i + n] - sorted[i] < 1000) { n++; }
        maxInAnySecond = Math.max(maxInAnySecond, n);
      }
      expect(maxInAnySecond).toBeLessThanOrEqual(20);
      // …and the window assertion must not be vacuous: it can only bite if the
      // burst is bigger than the ceiling it is checking.
      expect(burst).toBeGreaterThan(20);
    };

    it('the first request after expiry re-authenticates silently', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: 8000 });
      open.push({ proxy, client });

      const c = client as unknown as {
        connect(): Promise<void>;
        getControllerState(): Promise<string>;
      };
      await c.connect();
      // Sanity: the path works before the fault, so a failure below is the fault.
      await expect(c.getControllerState()).resolves.toBeTruthy();

      const base = await forceExpiry(client, { logout: true });

      // The whole property in one line: the consumer just calls the method.
      // Nothing is caught here deliberately - if the client surfaces the expiry
      // as an RwsError (AUTH_FAILED from a dead cookie it never dropped, say),
      // this test must fail loudly rather than tolerate it.
      await expect(c.getControllerState()).resolves.toBeTruthy();

      // Asserted after exactly ONE post-expiry request, which is what pins the
      // expected nonce count in assertReauthenticated.
      assertReauthenticated(client, base);

      // …and the recovered session keeps working, i.e. re-auth produced a usable
      // session rather than a one-shot success.
      await expect(c.getControllerState()).resolves.toBeTruthy();
    }, 60000);

    it('a burst issued straight after expiry stays under the rate ceiling', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: 8000 });
      open.push({ proxy, client });

      const c = client as unknown as {
        connect(): Promise<void>;
        getControllerState(): Promise<string>;
      };
      await c.connect();
      await expect(c.getControllerState()).resolves.toBeTruthy();

      // Expire, then burst with no pause: the first request of the burst is the
      // one that has to re-authenticate, which is the moment a client is most
      // likely to bypass its own queue.
      await forceExpiry(client, { logout: true });
      await assertBurstRespectsCeiling(client);
    }, 60000);

    it('an expiry mid-poll never reaches the consumer (S14 cross-cutting)', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 400 });
      open.push({ proxy, manager });

      const errors: string[] = [];
      manager.onError(async (msg: string) => { errors.push(msg); return undefined; });

      const transitions: Array<{ quality: string; reason: string }> = [];
      let notifies = 0;
      manager.onDidChange(() => {
        notifies++;
        const last = transitions[transitions.length - 1];
        if (!last || last.quality !== manager.state.quality || last.reason !== manager.state.qualityReason) {
          transitions.push({ quality: manager.state.quality, reason: manager.state.qualityReason ?? '' });
        }
      });

      await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
        20000, 'manager reaches a steady quality');

      const injectedAt = transitions.length;
      const notifiesAtInjection = notifies;
      // Returns only once the client has provably re-authenticated mid-poll, so
      // the assertions below cannot pass on a run where nothing ever expired.
      // No /logout here, unlike the client tests: on RWS 2.0 the pre-fault
      // session owns the live WebSocket, and tearing that down server-side is
      // S03's scenario, not this one. The cost is one session left to time out
      // on the controller per run; the replacement is released by afterEach.
      await forceExpiryUnderPolling(manager);

      // Let several more poll cycles run on the recovered session. notify() is
      // called on every SUCCESSFUL fetchAll, so this also waits for real work
      // rather than for a wall-clock duration.
      await until(() => notifies >= notifiesAtInjection + 3, 25000, 'three more poll cycles complete');

      // The consumer-visible contract: no error listener call, and no poll ever
      // failed. A single failed poll shows up as quality 'stale' (three in a row
      // auto-disconnect), so the absence of both is the assertion.
      expect(errors).toEqual([]);
      const degraded = transitions.slice(injectedAt)
        .filter(t => t.quality === 'stale' || t.quality === 'disconnected');
      expect(degraded).toEqual([]);

      // Dropping live -> polling IS allowed here: on RWS 1.0 a re-auth can mint a
      // new session cookie and strand the WebSocket, which is honest degradation
      // rather than an error. What is never allowed is claiming disconnected
      // while the polls are in fact succeeding.
      assertQualityHonest(manager, { notDisconnected: true });
      for (const t of transitions) {
        expect(t.reason.trim()).not.toBe('');
      }
      // Three untils of 20-25 s each, so the per-test budget has to clear their sum.
    }, 120000);

    // The honest version of the same scenario: no rewound clock, no forged
    // cookie - just an idle client. Gated because it costs >6 minutes per
    // generation, which is why the three tests above exist.
    it.skipIf(!SLOW_ENABLED)('a real >5 min idle then a burst behaves identically (RWS_STRUCTURAL_SLOW=1)', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: 15000 });
      open.push({ proxy, client });

      const c = client as unknown as {
        connect(): Promise<void>;
        getControllerState(): Promise<string>;
      };
      await c.connect();
      await expect(c.getControllerState()).resolves.toBeTruthy();

      const session = generation === 'rws1' ? rws1SessionOf(client) : null;
      const nonceBefore = session?.nonceCount ?? 0;

      // A fixed sleep, deliberately: the idle IS the scenario, there is no
      // condition to poll for, and polling would keep the session alive and
      // hollow out the test. One extra minute past HttpSession's own 5-minute
      // timer so the controller's idle timer has certainly fired too.
      await new Promise(r => setTimeout(r, RWS1_SESSION_TIMEOUT_MS + 60000));

      await expect(c.getControllerState()).resolves.toBeTruthy();

      if (generation === 'rws1') {
        // After a genuine idle the controller has dropped the session too, so
        // the request must have re-handshaked. If this fails with a nonce count
        // that kept climbing, IRC5 accepted the stale nonce and the "silent
        // re-auth" property is only being met by luck.
        assertReauthenticated(client, { nonceBefore, cookieBefore: null });
      } else {
        // RWS 2.0 may legitimately keep the session alive across the idle, so
        // the only claim here is that a cookie is held and requests work; the
        // dead-cookie adoption path is asserted deterministically above.
        expect(rws2CookieHolderOf(client).sessionCookie).toBeTruthy();
      }

      await assertBurstRespectsCeiling(client);
    }, 8 * 60 * 1000);
  });
}
