/**
 * S03 - Controller warm restart.
 *
 * The destructive ceiling of the whole matrix: this cell really restarts the
 * user's running virtual controller, which is unusable for several minutes
 * afterwards. It is therefore OFF unless explicitly armed with
 * RWS_STRUCTURAL_ALLOW_RESTART=1 - a skipped cell is reported `untested`, never
 * green, which is the right outcome for a fault nobody agreed to inject.
 *
 * What a warm restart breaks, and what the client must do about it:
 *   - the HTTP session dies. RWS 1.0 must re-run the digest handshake silently;
 *     RWS 2.0 must ADOPT the fresh cookie the controller mints and drop the
 *     stale one (keeping it makes every WS upgrade 401 forever - live-observed
 *     on RW7.21, 2026-08-02).
 *   - the controller-side subscription registration is gone. The stored poll
 *     URL is dead, so the subscriber must re-POST /subscription and open the
 *     new stream with the NEW cookie.
 *   - any mastership / write-access hold dies with the session. The client must
 *     not be left believing it still holds one, and the controller must not be
 *     left with a phantom holder that blocks the next acquire.
 *   - a RobotStudio VC re-binds RWS to a fresh dynamic port (real hardware keeps
 *     :80/:443). The chaos proxy is retargeted so the client keeps seeing one
 *     stable address - the client itself has to recover unaided.
 *
 * RIG CAVEAT (recorded 2026-08-03 in tests/live/wsSubscriber.live.test.ts): the
 * RobotStudio IRC5 VC does not reliably survive an RWS-initiated warm restart -
 * observed dying outright (RobVC gone, never re-listens) on 2 of 3 attempts in
 * one night. When that happens the rws1 cell fails on its recovery window and
 * the VC needs a manual start in RobotStudio. That is a rig limitation, not a
 * client defect - but the assertion stays strict, because a client that cannot
 * be distinguished from a dead controller is not evidence of anything.
 */

import { it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import https from 'node:https';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import type { RwsClient } from '../../src/RwsClient.js';
import type { RwsClient2 } from '../../src/RwsClient2.js';
import type { SubscriptionEvent } from '../../src/types.js';
import {
  cell, until, assertQualityHonest, RwsError, type AnyClient,
} from '../helpers/structuralHarness.js';
import {
  forgetControllers, controllerFor, discoverControllers, TEST_USER, TEST_PASS,
  type Generation, type LiveController,
} from '../helpers/liveControllers.js';

const execFileP = promisify(execFile);

/** Arming switch - see the file header for why this cell is opt-in. */
const ALLOW_RESTART = process.env.RWS_STRUCTURAL_ALLOW_RESTART === '1';
const GATE = ALLOW_RESTART
  ? ''
  : ' [SKIPPED - set RWS_STRUCTURAL_ALLOW_RESTART=1 to arm; this really restarts the live VC]';

/** How long the controller is given to go down and come back up. */
const RESTART_WINDOW_MS = 480000;
/** Cadence of the port chase. Each tick costs a tasklist + netstat + probes. */
const CHASE_STEP_MS = 3000;
/**
 * How long quality is allowed to keep claiming `live` after the controller has
 * stopped answering. The manager needs one poll cycle plus three consecutive
 * failures to notice; anything past this is a lie, not latency (S14).
 */
const QUALITY_DETECT_BUDGET_MS = 90000;

const open: Array<{
  proxy?: ChaosProxy;
  client?: AnyClient;
  manager?: RobotManager;
  unsubscribe?: (() => Promise<void>) | null;
  restore?: () => Promise<void>;
}> = [];

afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.unsubscribe?.().catch(() => undefined);
    await o.restore?.().catch(() => undefined);
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> })?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
}, 120000);

// ─── Live-controller rediscovery ─────────────────────────────────────────────

/**
 * Poll a live condition. Deliberately gentler than the harness `until` (25 ms):
 * every probe here is a real request to a controller that is booting, and a
 * 40 Hz retry loop against a VC is exactly the kind of careless traffic that
 * wedges one. Still condition-based - never a fixed sleep.
 */
async function pollLive(
  cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) { return true; }
    if (Date.now() >= deadline) { return false; }
    await new Promise(r => setTimeout(r, stepMs));
  }
}

/** One unauthenticated request; the WWW-Authenticate challenge names the generation. */
function probeGeneration(port: number, tls: boolean, timeoutMs = 1500): Promise<Generation | null> {
  return new Promise(resolve => {
    const mod = tls ? https : http;
    const req = mod.request(
      {
        host: '127.0.0.1', port, path: '/rw/system', method: 'GET', timeout: timeoutMs,
        ...(tls ? { rejectUnauthorized: false } : {}),
      },
      res => {
        const challenge = String(res.headers['www-authenticate'] ?? '');
        res.resume();
        if (/digest/i.test(challenge)) { resolve('rws1'); return; }
        if (/basic/i.test(challenge)) { resolve('rws2'); return; }
        resolve(null);
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Ports the RobotStudio VC processes are currently LISTENING on, per Windows. */
async function vcListeningPorts(): Promise<number[]> {
  if (process.platform !== 'win32') { return []; }
  const pids: string[] = [];
  for (const image of ['RobVC.exe', 'Vrchost64.exe']) {
    const { stdout } = await execFileP(
      'tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'],
    ).catch(() => ({ stdout: '' }));
    pids.push(...[...stdout.matchAll(/"(?:RobVC|Vrchost64)\.exe","(\d+)"/g)].map(m => m[1]));
  }
  if (pids.length === 0) { return []; }
  const ports = new Set<number>();
  for (const proto of ['TCP', 'TCPv6']) {
    const { stdout } = await execFileP('netstat', ['-ano', '-p', proto]).catch(() => ({ stdout: '' }));
    for (const line of stdout.split('\n')) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && pids.includes(m[2])) { ports.add(Number(m[1])); }
    }
  }
  return [...ports];
}

/**
 * Find this generation's controller again after a restart moved it.
 *
 * The harness caches the port it discovered at setup, and liveControllers only
 * knows a fixed candidate list - neither survives an IRC5 coming back as a NEW
 * RobVC process on a fresh dynamic port. So: try the original endpoint first
 * (cheapest, and the only answer during the RW7 drain phase), then forget the
 * cache and retry the known ports, and only then ask Windows which ports the VC
 * processes hold.
 *
 * `excludePorts` is load-bearing, not defensive: this rig runs several OmniCore
 * VCs (9805 / 5466 / 9403 are all in the candidate list) and discovery returns
 * the FIRST match of a generation. Without the exclusion, a restarted RW7 that
 * is still down would be "rediscovered" as the RW8 next door, the proxy would be
 * retargeted at a controller that never restarted, and every recovery assertion
 * below would pass against the wrong machine - a falsely green cell.
 */
async function rediscover(
  generation: Generation, origin: LiveController, excludePorts: ReadonlySet<number>,
): Promise<LiveController | null> {
  if (await probeGeneration(origin.port, origin.tls) === generation) { return origin; }
  forgetControllers();
  const known = await controllerFor(generation).catch(() => null);
  if (known && !excludePorts.has(known.port)) { return known; }
  for (const port of await vcListeningPorts()) {
    if (excludePorts.has(port)) { continue; }
    for (const tls of [false, true]) {
      if (await probeGeneration(port, tls) === generation) {
        return {
          generation, host: '127.0.0.1', port, tls,
          baseUrl: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
          label: `${generation} :${port} (rediscovered after restart)`,
        };
      }
    }
  }
  return null;
}

// ─── Session / subscription identity ─────────────────────────────────────────

/**
 * The RWS 1.0 session identity is the `-http-session-` cookie alone. ABBCX is
 * re-issued on every new TCP connection (live-verified 2026-08-02 on RW6.16),
 * so comparing whole cookie strings would report a "new session" after any
 * reconnect and prove nothing.
 */
function sessionSlot(cookie: string | null): string {
  return cookie?.match(/-http-session-=([^;]+)/)?.[1] ?? '';
}

/**
 * RWS 1.0 exposes no public handle for the controller-side registration, so the
 * subscriber's own map is read directly (the same access tests/live uses). The
 * registration id is the only observable difference between "re-POSTed a fresh
 * subscription" and "reopened the old poll URL" - and only the former can work
 * across a restart.
 */
function rws1RegistrationId(client: AnyClient): string {
  const subs = (client as unknown as {
    subscriber?: { subscriptions: Map<string, { id: string }> };
  }).subscriber?.subscriptions;
  return subs ? ([...subs.values()][0]?.id ?? '') : '';
}

/** Callable unsubscribe; RWS 2.0 additionally carries the live group path. */
type SubHandle = (() => Promise<void>) & { groupPath?: string };

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S03-warm-restart', generation, ctx => {
    /**
     * ONE restart per generation, with every matrix property asserted around
     * it. Four separate restart tests would cost four multi-minute outages of
     * the user's VC and yield no extra signal - the properties are all
     * observations of the SAME event. Independent properties are asserted with
     * expect.soft so one failure still reports the others: a restart cannot be
     * cheaply re-run to find out what else was broken.
     */
    it.skipIf(!ALLOW_RESTART)(
      `survives a real warm restart: silent re-auth, subscription re-registration, no phantom hold${GATE}`,
      async () => {
        const before = await ctx.controller();
        // Every OTHER controller on this rig, captured before anything is
        // forgotten. Rediscovery must never hand the proxy one of these.
        const otherPorts = new Set(
          (await discoverControllers()).filter(x => x.port !== before.port).map(x => x.port),
        );

        // Registered in `open` as each resource appears rather than after all
        // three exist: a throw from ctx.client()/ctx.manager() would otherwise
        // leak the proxy and a live controller session, and the controller caps
        // sessions (70 on IRC5).
        const entry: (typeof open)[number] = { unsubscribe: null };
        open.push(entry);
        const proxy = await ctx.proxy();
        entry.proxy = proxy;
        // Generous per-request timeout: a VC that has just booted answers slowly.
        const client = await ctx.client(proxy, { timeout: 15000 });
        entry.client = client;
        const manager = await ctx.manager(proxy, { refreshIntervalMs: 1000 });
        entry.manager = manager;
        const c = client as unknown as {
          connect(): Promise<void>;
          getControllerState(): Promise<string>;
          getSessionCookie(): string | null;
          getSpeedRatio(): Promise<number>;
          setSpeedRatio(ratio: number): Promise<void>;
          requestMastership(domain: 'motion'): Promise<void>;
          releaseMastership(domain: 'motion'): Promise<void>;
          restartController(mode: 'restart'): Promise<void>;
        };

        const events: SubscriptionEvent[] = [];
        let restored = 0;
        let lost = 0;

        await c.connect();
        const originalRatio = await c.getSpeedRatio();
        // Leave the controller as it was found, even if an assertion aborts the
        // test mid-flight: restore the ratio, then drop any hold still open
        // (disconnect() would too, but only if it is reached). The ratio write
        // needs write access and the test releases its hold before finishing,
        // so one is taken here - otherwise the user's VC is silently left at the
        // test's speed.
        entry.restore = async () => {
          await c.requestMastership('motion').catch(() => undefined);
          await c.setSpeedRatio(originalRatio).catch(() => undefined);
          await c.releaseMastership('motion').catch(() => undefined);
        };

        // RW8 removed mastership for the Control Station Service; the two paths
        // behave differently across a restart and are branched on below.
        const rwMajor = generation === 'rws2'
          ? Number(((await (client as RwsClient2).getRobotWareVersion()) || '0').split('.')[0])
          : 6;
        const controlStationPath = rwMajor >= 8;

        // ── Steady state before the fault ─────────────────────────────────────
        const subOpts = {
          // The outage is minutes long; the default 6-attempt budget (~61 s)
          // would give up before the controller is back and turn this cell into
          // a test of onLost instead of a test of recovery.
          maxReconnectAttempts: 120,
          reconnectBaseMs: 1000,
          reconnectCapMs: 10000,
          pingIntervalMs: 5000,
          openTimeoutMs: 8000,
        };
        const onEvent = (e: SubscriptionEvent): void => { events.push(e); };
        const handle: SubHandle = generation === 'rws1'
          ? await (client as RwsClient).subscribe(
            ['speedratio'], onEvent,
            { ...subOpts, onLost: () => { lost++; }, onRestored: () => { restored++; } },
          )
          : await (client as RwsClient2).subscribe(
            ['speedratio'], onEvent,
            () => { lost++; }, () => { restored++; }, subOpts,
          );
        entry.unsubscribe = handle;

        const registrationId = (): string => (generation === 'rws1'
          ? rws1RegistrationId(client)
          : (handle.groupPath ?? ''));
        const sessionId = (): string => (generation === 'rws1'
          ? sessionSlot(c.getSessionCookie())
          : (c.getSessionCookie() ?? ''));

        /**
         * Write a speed ratio and wait for its event. The write is retried
         * inside the window because a VC that just finished a warm restart
         * rejects panel writes for a while as its subsystems settle - that is
         * the controller booting, not the client failing.
         */
        const expectSpeedEvent = async (
          ratio: number, timeoutMs: number, soft = false,
        ): Promise<void> => {
          // `soft` after the restart only: a write that never lands must not
          // abort the properties still queued behind it.
          const check = (v: unknown, m: string): { toBe(x: unknown): void } =>
            (soft ? expect.soft(v, m) : expect(v, m));
          const seen = events.length;
          const deadline = Date.now() + timeoutMs;
          let lastErr: unknown = null;
          const written = await pollLive(async () => {
            try { await c.setSpeedRatio(ratio); return true; }
            catch (e) { lastErr = e; return false; }
          }, timeoutMs, 1000);
          check(
            written,
            `setSpeedRatio(${ratio}) never succeeded: ${String(lastErr)}`
            + ' (if this fails BEFORE the restart, check the VC is in AUTO mode)',
          ).toBe(true);
          const arrived = await pollLive(
            () => events.slice(seen).some(e => e.value === String(ratio)),
            Math.max(5000, deadline - Date.now()), 250,
          );
          check(arrived, `no speedratio=${ratio} event within ${timeoutMs} ms`).toBe(true);
        };

        // ── Hold write access across the restart ──────────────────────────────
        // Acquired BEFORE the pre-restart write: on RW8 a panel write needs
        // control-station write access, and the same hold is what the
        // "mid-mastership-hold" property is about.
        //
        // RW7 mastership and IRC5 mastership are per-domain, so 'motion' can be
        // held while restartController() takes 'edit'/'rapid' for itself.
        //
        // On RW8 both route to the ONE global control-station write access, and
        // restartController() acquires it internally and deliberately never
        // releases it ("the controller is going down and takes the session with
        // it"). Keeping ours would make the restart re-request an access it
        // already owns, so on RW8 it is released just before the restart and the
        // mid-hold condition is supplied by the restart's own retained hold -
        // the more interesting case anyway: RwsClient2 keeps
        // `controlStationRegistered` and `writeAccessHeld` true across the
        // restart even though the session that owned them is dead.
        await c.requestMastership('motion');

        await expectSpeedEvent(41, 20000);
        await until(
          () => manager.state.quality === 'live' || manager.state.quality === 'polling',
          30000, 'manager reaches a steady quality before the restart',
        );

        const sessionBefore = sessionId();
        const registrationBefore = registrationId();
        const restoredBefore = restored;
        expect(sessionBefore, 'no session held before the restart').not.toBe('');
        expect(registrationBefore, 'no subscription registration held before the restart').not.toBe('');

        if (controlStationPath) { await c.releaseMastership('motion').catch(() => undefined); }

        // ── The fault ─────────────────────────────────────────────────────────
        await c.restartController('restart');

        // ── Chase the controller through the outage ───────────────────────────
        // A RW7 restart has a long drain phase where HTTP still answers but the
        // session is already dead; a restore observed there proves the
        // fresh-cookie path but NOT restart survival. So the down phase is
        // watched for explicitly and, when seen, a restore is only counted if it
        // happened at or after it (same rule as tests/live/rws2Subscriber).
        let after: LiveController | null = null;
        let sawDown = false;
        let downAt = 0;
        let restoredAtDown = 0;
        let consecutiveMisses = 0;
        let qualityLie = '';
        const deadline = Date.now() + RESTART_WINDOW_MS;
        // If no down phase has shown by here, the restart completed faster than
        // the chase could see it; a plain restore then ends the wait rather than
        // burning the whole window.
        const downDeadline = Date.now() + RESTART_WINDOW_MS / 2;
        while (Date.now() < deadline) {
          const found = await rediscover(generation, before, otherPorts);
          const answering = found !== null;
          if (found) {
            consecutiveMisses = 0;
            after = found;
            // Keep the client's address stable while the backend moves.
            proxy.setTarget(found.host, found.port);
            if (sawDown && restored > restoredAtDown) { break; }
            if (!sawDown && restored > restoredBefore && Date.now() > downDeadline) { break; }
          } else {
            // One missed probe can be host-load noise; two in a row is a real
            // down phase.
            consecutiveMisses++;
            if (consecutiveMisses >= 2 && !sawDown) {
              sawDown = true;
              downAt = Date.now();
              restoredAtDown = restored;
            }
          }
          // S14 cross-cutting: while the controller is provably not answering
          // THIS tick, quality must not keep advertising a working connection.
          // "polling" counts as a lie here too - it means "WebSocket unavailable,
          // fast polling", i.e. requests are still landing, and the manager
          // gives up after 3 failed polls (~3 s at refreshIntervalMs=1000), far
          // inside this budget. Checking only "live" would make this vacuous on
          // any run where the WS never came up.
          const q = manager.state.quality;
          if (sawDown && !answering && Date.now() - downAt > QUALITY_DETECT_BUDGET_MS
              && (q === 'live' || q === 'polling')) {
            qualityLie = `quality stayed "${q}" ${Math.round((Date.now() - downAt) / 1000)} s `
              + `after the controller stopped answering (reason: ${manager.state.qualityReason})`;
          }
          await new Promise(r => setTimeout(r, CHASE_STEP_MS));
        }

        expect(
          after,
          `controller never came back within ${RESTART_WINDOW_MS / 1000} s of the warm restart`,
        ).not.toBeNull();
        const back = after as LiveController;
        expect.soft(qualityLie, 'connection quality lied during the outage').toBe('');

        // Property (rws1): "RWS port may DRIFT on IRC5 - client or test must
        // rediscover". Drift is not guaranteed on every restart, so the claim is
        // that rediscovery WORKS - and it is proven by an INDEPENDENT probe of
        // the endpoint rediscover() returned, not by re-reading the `port` and
        // `generation` fields rediscover() itself filled in (those can never
        // disagree with themselves, so asserting them proves nothing). This
        // probe genuinely fails when the VC dies on the restart instead of
        // coming back - the rig failure mode called out in the file header.
        const endpointLive = await pollLive(
          async () => (await probeGeneration(back.port, back.tls)) === generation,
          30000, 1000,
        );
        expect.soft(
          endpointLive,
          `the rediscovered endpoint :${back.port} (the VC served :${before.port} before the `
          + `restart) does not answer as ${generation}`,
        ).toBe(true);
        // Pin the proxy to the just-verified endpoint: the chase can exit on a
        // tick whose probe missed, leaving the target one generation stale.
        proxy.setTarget(back.host, back.port);

        // ── Property: mid-session silent re-auth ──────────────────────────────
        const codesSeen = new Set<string>();
        const readsAgain = await pollLive(async () => {
          try { await c.getControllerState(); return true; }
          catch (e) { if (e instanceof RwsError) { codesSeen.add(e.code); } return false; }
        }, 180000, 1000);
        expect.soft(
          readsAgain,
          'the client never recovered its own session after the restart - it had to be '
          + `re-created by hand. Error codes seen: ${[...codesSeen].join(', ') || 'none'}`,
        ).toBe(true);

        if (readsAgain) {
          // "Consumer sees no error" is a steady-state claim, not a one-shot:
          // a client that re-auths per request, or that alternates 401/200,
          // would pass a single read.
          const results: string[] = [];
          for (let i = 0; i < 5; i++) {
            try { await c.getControllerState(); results.push('ok'); }
            catch (e) { results.push(e instanceof RwsError ? e.code : `non-RwsError:${String(e)}`); }
            await new Promise(r => setTimeout(r, 200));
          }
          expect.soft(
            results.filter(r => r !== 'ok'),
            'reads kept failing after the restart - re-auth was not silent',
          ).toEqual([]);
        }

        // The old session died with the controller. RWS 2.0 must have adopted
        // the fresh cookie the controller minted (the matrix property); RWS 1.0
        // must have run a new digest handshake, which yields a new
        // -http-session- slot. Either way the identity MUST have changed - an
        // unchanged one means the client is still presenting a dead session.
        expect.soft(
          sessionId(),
          'session identity is unchanged after the restart - the client is still '
          + 'presenting the session the restart killed',
        ).not.toBe(sessionBefore);
        expect.soft(sessionId(), 'no session held after the restart').not.toBe('');

        // ── Property: mid-subscription re-registration ────────────────────────
        // On RWS 2.0 this is also the strict test of "re-POST + WS upgrade with
        // the NEW cookie": the WS carries the cookie captured at re-POST time,
        // so a client that kept the stale one is rejected 401 on every upgrade
        // and loops forever - restored would never increment and no event would
        // ever arrive again. TLS makes the cookie unobservable at the proxy, so
        // resumed events on a NEW registration is the available proof.
        //
        // The baseline is the restore count AT the down phase, not before the
        // restart: RW7 kills the session minutes before it stops answering, so a
        // restore observed in that drain phase says nothing about surviving the
        // reboot. Counting it would make this cell falsely green.
        const restoredBaseline = sawDown ? restoredAtDown : restoredBefore;
        const streamBack = await pollLive(() => restored > restoredBaseline, 120000, 500);
        expect.soft(
          streamBack,
          'the event stream never re-registered after the controller came back '
          + `(restored=${restored}, baseline=${restoredBaseline}, lost=${lost})`,
        ).toBe(true);
        expect.soft(
          registrationId(),
          'the subscription kept its pre-restart registration - the controller-side '
          + 'registration is gone after a restart, so this stream is streaming to nobody',
        ).not.toBe(registrationBefore);
        expect.soft(registrationId(), 'no subscription registration held after the restart').not.toBe('');

        // ── Property: mid-mastership-hold leaves no phantom ───────────────────
        // Releasing over the dead session may fail - that is allowed. What is
        // NOT allowed is being unable to acquire again, which means the
        // controller still believes the dead session holds it.
        await c.releaseMastership('motion').catch(() => undefined);
        let acquireErr: unknown = null;
        const reacquired = await pollLive(async () => {
          try { await c.requestMastership('motion'); return true; }
          catch (e) { acquireErr = e; return false; }
        }, 120000, 2000);
        expect.soft(
          reacquired,
          'write access could not be re-acquired after the restart - a phantom hold '
          + `from the dead session is still believed: ${String(acquireErr)}`,
        ).toBe(true);

        if (controlStationPath) {
          // RW8: the registration is session-scoped, so the dead session's
          // registration is gone. The client must have registered again rather
          // than trusting its own `controlStationRegistered` flag.
          const type = await (client as RwsClient2).getControlStationType().catch(() => 'unreadable');
          expect.soft(
            type,
            'control-station registration was not re-established after the restart',
          ).toBe('remote');
        }

        // A hold that cannot be used is not a hold: prove the recovered write
        // access actually writes, and that events still flow to the consumer.
        await expectSpeedEvent(42, 90000, true);
        await c.releaseMastership('motion').catch(() => undefined);
        expect.soft(lost, 'the subscription was declared terminally lost').toBe(0);

        // ── Property: quality returns to live/polling, not stuck reconnecting ──
        // The manager auto-disconnects after 3 failed polls and waits for its
        // host to act (no errorListener is installed here - its 'Reconnect'
        // action would run a wide port scan while the VC is down, which is
        // exactly the traffic that wedges a controller). So the consumer-driven
        // recovery is performed explicitly, now that the backend is verified up
        // and the proxy points at it.
        // Retried, not one-shot: a VC seconds out of a restart refuses the first
        // connect often enough that a single attempt would report a client
        // defect that is really boot timing. Only attempted while the manager is
        // disconnected, so a succeeded connect is never re-issued.
        let connectErr: unknown = null;
        const settled = await pollLive(async () => {
          const steady = (): boolean =>
            manager.state.quality === 'live' || manager.state.quality === 'polling';
          if (steady()) { return true; }
          if (manager.state.quality === 'disconnected') {
            await manager.connect('127.0.0.1', TEST_USER, TEST_PASS, proxy.port, back.tls)
              .catch(e => { connectErr = e; });
          }
          return steady();
        }, 120000, 5000);
        expect.soft(
          settled,
          `quality never returned to live/polling after the restart - stuck at `
          + `"${manager.state.quality}" (${manager.state.qualityReason})`
          + `${connectErr ? `; last connect error: ${String(connectErr)}` : ''}`,
        ).toBe(true);
        // Run unconditionally: "every transition carries a non-empty
        // human-readable reason" is the half of S14 that must hold whatever
        // quality ended up being, and gating the whole call on `settled` skipped
        // it exactly when the manager was in the most suspicious state. The
        // not-disconnected half stays conditional - it is only a lie once
        // requests are demonstrably succeeding again.
        assertQualityHonest(manager, { notDisconnected: settled });
      },
      900000,
    );
  });
}
