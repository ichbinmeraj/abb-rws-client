/**
 * Live acceptance for RWS 2.0 subscriber resilience, run against the OmniCore
 * RW 7.21 virtual controller THROUGH the chaos proxy (TLS passes through the
 * proxy untouched; the WS re-anchor makes the client route everything via the
 * configured base URL, which is what makes these tests possible at all).
 *
 * Enabled only when RWS_TEST_HOST is set; skipped in plain `npm test` runs.
 *   RWS_TEST_HOST       - VC host, MUST be this PC (hard-fails otherwise): a
 *                         bare host (127.0.0.1) or an http(s) URL naming one,
 *                         as RAPID Live's host harness sets it
 *                         (https://127.0.0.1:80); only its host is used
 *                         (tests/helpers/liveHost.ts)
 *   RWS_TEST_PORT_RW7   - OmniCore RWS port (default: found by the client's own
 *                         discovery of this PC, the lowest RobotWare major first)
 *   RWS_TEST_USER/PASS  - credentials (default 'Default User' / 'robotics')
 *   RWS_TEST_ALLOW_RESTART=1 - additionally run the real warm-restart test
 *                              (restarts the VC - disruptive, ~1 min), on a
 *                              lane off the never-restart list only
 *                              (tests/helpers/restartPolicy.ts): the lane is
 *                              the RobotWare major of the controller found, so
 *                              RW7 restarts and RW8 never does
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { RwsClient2 } from '../../src/RwsClient2.js';
import type { SubscriptionEvent } from '../../src/types.js';
import { startChaosProxy, type ChaosProxy } from '../helpers/chaosProxy.js';
import { controllerFor, findVcAgain, listLocalControllers, type LiveController } from '../helpers/liveControllers.js';
import { restartVerdict } from '../helpers/restartPolicy.js';
import { liveHost } from '../helpers/liveHost.js';

// Throws at import for a host that is not this PC: live suites must never
// point at a real or workplace robot.
const HOST = liveHost();
const USER = process.env.RWS_TEST_USER ?? 'Default User';
const PASS = process.env.RWS_TEST_PASS ?? 'robotics';
const ALLOW_RESTART = process.env.RWS_TEST_ALLOW_RESTART === '1';

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function until(cond: () => boolean, timeoutMs: number, stepMs = 100): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) { return Date.now() - t0; }
    await wait(stepMs);
  }
  return cond() ? Date.now() - t0 : -1;
}

/**
 * Find the port the OmniCore VC currently serves RWS on. Like the IRC5 VC,
 * a warm restart may re-bind RWS to a fresh dynamic port (real OmniCore
 * hardware keeps :443/:80). OmniCore VCs run as Vrchost64.exe, and this rig
 * runs several: one paced discovery of this PC keeps the Vrchost64.exe
 * listeners that answer the RWS 2.0 challenge, drops the ports the other VCs
 * held before the restart, keeps only the same system when its name is known,
 * and prefers the port before the restart.
 */
async function findLiveRws2Port(origin: LiveController, others: ReadonlySet<number>): Promise<number | null> {
  const again = await findVcAgain('rws2', {
    originPort: origin.port, excludePorts: others,
    ...(origin.systemName ? { systemName: origin.systemName } : {}),
  });
  return again?.port ?? null;
}

describe.skipIf(!HOST)('RWS 2.0 subscriber resilience (RW7 VC via chaos proxy)', () => {
  let VC: LiveController;
  let RW7_PORT = 0;
  let proxy: ChaosProxy;
  let client: RwsClient2;
  let unsubscribe: (() => Promise<void>) | null = null;
  let events: SubscriptionEvent[];
  let restored: number;
  let lost: number;

  beforeAll(async () => {
    const vc = await controllerFor('rws2');
    if (!vc) { throw new Error('no RWS 2.0 virtual controller found on this PC - start the RW7 VC, or set RWS_TEST_PORT_RW7'); }
    VC = vc;
    RW7_PORT = vc.port;
  }, 120000);

  beforeEach(async () => {
    proxy = await startChaosProxy(HOST!, RW7_PORT);
    client = new RwsClient2(`https://127.0.0.1:${proxy.port}`, USER, PASS);
    events = [];
    restored = 0;
    lost = 0;
  });

  afterEach(async () => {
    if (unsubscribe) { await unsubscribe().catch(() => undefined); unsubscribe = null; }
    await client.setSpeedRatio(100).catch(() => undefined);
    await client.disconnect().catch(() => undefined);
    await proxy.close();
  });

  async function subscribeSpeed(opts: Record<string, unknown> = {}): Promise<void> {
    unsubscribe = await client.subscribe(
      ['speedratio'],
      e => { events.push(e); },
      () => { lost++; },
      () => { restored++; },
      {
        reconnectBaseMs: 300,
        pingIntervalMs: 1500,
        openTimeoutMs: 5000,
        ...opts,
      },
    );
  }

  /** Set a speed ratio (retrying transient rejections) and await its event. */
  async function expectSpeedEvent(ratio: number, timeoutMs = 10000): Promise<void> {
    const countBefore = events.length;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    let written = false;
    while (!written && Date.now() < deadline) {
      try {
        await client.setSpeedRatio(ratio);
        written = true;
      } catch (e) {
        lastErr = e;
        await wait(1000);
      }
    }
    expect(written, `setSpeedRatio(${ratio}) kept failing: ${String(lastErr)}`).toBe(true);
    const elapsed = await until(
      () => events.slice(countBefore).some(e => e.value === String(ratio)),
      Math.max(1000, deadline - Date.now()),
    );
    expect(elapsed, `no speedratio=${ratio} event within ${timeoutMs} ms`).toBeGreaterThanOrEqual(0);
  }

  it('resumes events automatically after a hard connection drop', async () => {
    await subscribeSpeed();
    await expectSpeedEvent(61);
    const cookieBefore = client.getSessionCookie();

    proxy.dropAll();
    const t = await until(() => restored >= 1, 20000);
    expect(t, 'stream was not restored within 20 s').toBeGreaterThanOrEqual(0);

    await expectSpeedEvent(62);
    // The re-subscribe must ride the same session (no new session minted -
    // the 5-sessions-per-IP budget would otherwise burn out fast)
    expect(client.getSessionCookie()).toBe(cookieBefore);
    expect(lost).toBe(0);
  });

  it('fires onLost exactly once when the port stays blocked past the reconnect budget', async () => {
    await subscribeSpeed({ maxReconnectAttempts: 3 });
    await expectSpeedEvent(63);

    proxy.refuseNew(true);
    proxy.dropAll();

    const t = await until(() => lost >= 1, 20000);
    expect(t, 'onLost did not fire within 20 s').toBeGreaterThanOrEqual(0);
    expect(lost).toBe(1);
    expect(restored).toBe(0);

    await wait(2000);
    expect(lost).toBe(1);
  });

  it('heartbeat detects a half-open freeze within ~2× the ping interval and recovers', async () => {
    await subscribeSpeed({ pingIntervalMs: 1500 });
    await expectSpeedEvent(64);

    const pairsBefore = proxy.connections();
    proxy.freeze();
    const t0 = Date.now();

    const detected = await until(() => proxy.connections() < pairsBefore, 8000);
    expect(detected, 'half-open socket was not terminated').toBeGreaterThanOrEqual(0);
    expect(Date.now() - t0).toBeLessThanOrEqual(2 * 1500 + 2500);

    proxy.unfreeze();
    const t = await until(() => restored >= 1, 20000);
    expect(t, 'stream was not restored after unfreeze').toBeGreaterThanOrEqual(0);
    await expectSpeedEvent(65);
  });

  it.skipIf(!ALLOW_RESTART)('survives a real warm restart of the VC', async t => {
    // The never-restart list decides first, whatever RWS_TEST_ALLOW_RESTART
    // says. The lane is the RobotWare major the controller answers through
    // this test's client (the one the restart goes out on), and the version
    // discovery named, which can be stale, must agree (restartVerdict).
    const { lane, refusal } = await restartVerdict(VC, () => client.getRobotWareVersion());
    if (refusal) {
      console.warn(`warm-restart test skipped on ${VC.label} (lane ${lane ?? 'unknown'}): ${refusal}`);
      // A skipped test's afterEach does not run, so free what beforeEach opened.
      await client.disconnect().catch(() => undefined);
      await proxy.close();
      t.skip();
    }

    // Live-measured cycle on RW7.21 VC (2026-08-02): the controller keeps
    // serving ~110 s after accepting the restart, is down for ~260 s, then
    // returns - roughly 6.5 min end to end. Budget generously.
    await subscribeSpeed({
      maxReconnectAttempts: 90,
      reconnectBaseMs: 1000,
      reconnectCapMs: 10000,
    });
    await expectSpeedEvent(66);

    // Every other controller on this PC, before the restart: the chase must
    // never retarget the proxy at one of them.
    const others = new Set((await listLocalControllers()).map(c => c.port).filter(p => p !== RW7_PORT));

    await client.restartController('restart');

    // A RW7 restart has a long drain phase (~2 min live-measured) where HTTP
    // still answers: the session dies immediately (recovery in this phase
    // proves the fresh-cookie path) but the controller has not rebooted yet.
    // To claim restart survival honestly, watch for the DOWN phase and require
    // a restore observed at-or-after it. If no down phase shows within 4 min,
    // the restart completed invisibly fast - a plain restore then suffices.
    let consecutiveMisses = 0;
    let sawDown = false;
    let restoredAfterDown = 0;
    const deadline = Date.now() + 480000;
    const downDeadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const port = await findLiveRws2Port(VC, others);
      if (port) {
        consecutiveMisses = 0;
        proxy.setTarget('127.0.0.1', port);
        if (sawDown && restored > restoredAfterDown) { break; }
        if (!sawDown && restored >= 1 && Date.now() > downDeadline) { break; }
      } else {
        // One missed probe can be host-load noise; two in a row is a real
        // down phase.
        consecutiveMisses++;
        if (consecutiveMisses >= 2 && !sawDown) {
          sawDown = true;
          restoredAfterDown = restored;
        }
      }
      await wait(3000);
    }
    if (sawDown) {
      expect(restored, 'stream was not restored after the controller came back up')
        .toBeGreaterThan(restoredAfterDown);
    } else {
      expect(restored, 'stream was not restored within 8 min of the warm restart').toBeGreaterThanOrEqual(1);
    }

    // Generous window: a freshly-booted VC rejects panel writes while its
    // subsystems (and the restart's own mastership hold) settle.
    await expectSpeedEvent(67, 90000);
    expect(lost).toBe(0);
  }, 560000);
}, 120000);
