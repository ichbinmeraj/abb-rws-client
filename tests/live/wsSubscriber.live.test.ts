/**
 * Live acceptance for RWS 1.0 subscriber resilience, run against the IRC5
 * RW 6.16 virtual controller THROUGH the chaos proxy so network failures can
 * be injected without touching cables.
 *
 * Enabled only when RWS_TEST_HOST is set; skipped in plain `npm test` runs.
 *   RWS_TEST_HOST       - VC host, MUST be localhost (hard-fails otherwise)
 *   RWS_TEST_PORT_RW6   - IRC5 RWS port (default 28447)
 *   RWS_TEST_USER/PASS  - credentials (default 'Default User' / 'robotics')
 *   RWS_TEST_ALLOW_RESTART=1 - additionally run the real warm-restart test
 *                              (restarts the VC - disruptive, ~1 min)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { RwsClient } from '../../src/RwsClient.js';
import type { SubscriptionEvent } from '../../src/types.js';
import { startChaosProxy, type ChaosProxy } from '../helpers/chaosProxy.js';

const execFileP = promisify(execFile);

const HOST = process.env.RWS_TEST_HOST;
const RW6_PORT = Number(process.env.RWS_TEST_PORT_RW6 ?? '28447');
const USER = process.env.RWS_TEST_USER ?? 'Default User';
const PASS = process.env.RWS_TEST_PASS ?? 'robotics';
const ALLOW_RESTART = process.env.RWS_TEST_ALLOW_RESTART === '1';

// Safety guard: live suites must never point at a real or workplace robot.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (HOST && !LOCAL_HOSTS.has(HOST)) {
  throw new Error(
    `RWS_TEST_HOST=${HOST} is not localhost. Live suites only ever target local ` +
    'virtual controllers - refusing to run against a possibly real robot.',
  );
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The -http-session- cookie is the controller session identity (GET /logout
 * deletes it); ABBCX is re-issued on every new TCP connection and MUST NOT be
 * used to detect session growth. Live-verified 2026-08-02 on RW6.16 VC
 * (probe-session-slots/probe-ws): across a severed connection the next request
 * returns 200 with a new ABBCX but the same -http-session-.
 */
function sessionSlot(cookie: string | null): string {
  return cookie?.match(/-http-session-=([^;]+)/)?.[1] ?? '';
}

/** True when the port answers with the RWS digest realm. */
function probeRwsDigest(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/rw/panel/speedratio', timeout: 2000 }, res => {
      const auth = String(res.headers['www-authenticate'] ?? '');
      res.resume();
      resolve(res.statusCode === 401 && auth.includes('robapi'));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Find the port the RW6 VC currently serves RWS on. RobotStudio VCs re-bind
 * RWS to a fresh dynamic port on every warm restart (real IRC5 hardware keeps
 * :80) - the restart test chases the port and feeds it to the chaos proxy so
 * the client keeps seeing one stable address, exactly like real hardware.
 */
async function findLiveRwsPort(): Promise<number | null> {
  if (process.platform !== 'win32') { return null; }
  const { stdout: tl } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq RobVC.exe', '/FO', 'CSV', '/NH'])
    .catch(() => ({ stdout: '' }));
  const pids = [...tl.matchAll(/"RobVC\.exe","(\d+)"/g)].map(m => m[1]);
  if (pids.length === 0) { return null; }
  const ports = new Set<number>();
  for (const proto of ['TCP', 'TCPv6']) {
    const { stdout } = await execFileP('netstat', ['-ano', '-p', proto]).catch(() => ({ stdout: '' }));
    for (const line of stdout.split('\n')) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && pids.includes(m[2])) { ports.add(Number(m[1])); }
    }
  }
  for (const port of ports) {
    if (await probeRwsDigest(port)) { return port; }
  }
  return null;
}

/** Poll until cond() is true or timeoutMs elapses; returns elapsed ms or -1. */
async function until(cond: () => boolean, timeoutMs: number, stepMs = 100): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) { return Date.now() - t0; }
    await wait(stepMs);
  }
  return cond() ? Date.now() - t0 : -1;
}

describe.skipIf(!HOST)('RWS 1.0 subscriber resilience (RW6 VC via chaos proxy)', () => {
  let proxy: ChaosProxy;
  let client: RwsClient;
  let unsubscribe: (() => Promise<void>) | null = null;
  let events: SubscriptionEvent[];
  let restored: number;
  let lost: number;

  beforeEach(async () => {
    proxy = await startChaosProxy(HOST!, RW6_PORT);
    client = new RwsClient({
      host: '127.0.0.1',
      port: proxy.port,
      username: USER,
      password: PASS,
      timeout: 10000,
    });
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

  /** Subscribe to speedratio with test-scaled reconnect/heartbeat tuning. */
  async function subscribeSpeed(opts: Record<string, unknown> = {}): Promise<void> {
    unsubscribe = await client.subscribe(
      ['speedratio'],
      e => { events.push(e); },
      {
        reconnectBaseMs: 300,
        pingIntervalMs: 1500,
        openTimeoutMs: 5000,
        onRestored: () => { restored++; },
        onLost: () => { lost++; },
        ...opts,
      },
    );
  }

  /**
   * Set a speed ratio and wait for the matching event to arrive. The write is
   * retried inside the window: a VC that just finished a warm restart briefly
   * rejects panel writes (403) while its subsystems settle.
   */
  async function expectSpeedEvent(ratio: number, timeoutMs = 8000): Promise<void> {
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

  it('resumes events automatically after a hard connection drop, on the same session', async () => {
    await subscribeSpeed();
    await expectSpeedEvent(61);
    const cookieBefore = client.getSessionCookie();

    proxy.dropAll();
    const t = await until(() => restored >= 1, 15000);
    expect(t, 'stream was not restored within 15 s').toBeGreaterThanOrEqual(0);

    await expectSpeedEvent(62);
    // Same controller session - reconnects must not mint new sessions
    expect(sessionSlot(client.getSessionCookie())).toBe(sessionSlot(cookieBefore));
    expect(lost).toBe(0);
  });

  it('re-registers and resumes when the controller-side registration is gone (restart effect)', async () => {
    await subscribeSpeed();
    await expectSpeedEvent(63);

    // Simulate the registration loss a warm restart causes: delete the
    // registration server-side, then kill the socket. The reconnect to the
    // stored poll URL is rejected, forcing the re-POST path.
    const subscriber = (client as unknown as {
      subscriber: { subscriptions: Map<string, { deleteUrl: string }>; session: { delete(u: string): Promise<unknown> } };
    }).subscriber;
    const sub = [...subscriber.subscriptions.values()][0];
    expect(sub).toBeDefined();
    const oldDeleteUrl = sub.deleteUrl;
    const deleted = await subscriber.session.delete(oldDeleteUrl);
    expect(deleted.status, `DELETE ${oldDeleteUrl} should succeed`).toBe(200);
    proxy.dropAll();

    const t = await until(() => restored >= 1, 20000);
    expect(t, 'stream was not restored within 20 s').toBeGreaterThanOrEqual(0);

    // A fresh registration must be in place (new id → new delete URL)
    const subAfter = [...subscriber.subscriptions.values()][0];
    expect(subAfter.deleteUrl).not.toBe(oldDeleteUrl);

    await expectSpeedEvent(64);
    expect(lost).toBe(0);
  });

  it('fires onLost exactly once when the port stays blocked past the reconnect budget', async () => {
    await subscribeSpeed({ maxReconnectAttempts: 3 });
    await expectSpeedEvent(65);

    proxy.refuseNew(true);
    proxy.dropAll();

    const t = await until(() => lost >= 1, 20000);
    expect(t, 'onLost did not fire within 20 s').toBeGreaterThanOrEqual(0);
    expect(lost).toBe(1);
    expect(restored).toBe(0);

    // Terminal: still exactly one onLost after further waiting
    await wait(2000);
    expect(lost).toBe(1);
  });

  it('heartbeat detects a half-open freeze within ~2× the ping interval and recovers', async () => {
    await subscribeSpeed({ pingIntervalMs: 1500 });
    await expectSpeedEvent(66);

    const pairsBefore = proxy.connections();
    proxy.freeze();
    const t0 = Date.now();

    // Heartbeat must terminate the frozen socket - visible as the proxy pair
    // tearing down - within 2 ping intervals plus slack.
    const detected = await until(() => proxy.connections() < pairsBefore, 6000);
    expect(detected, 'half-open socket was not terminated').toBeGreaterThanOrEqual(0);
    expect(Date.now() - t0).toBeLessThanOrEqual(2 * 1500 + 2000);

    proxy.unfreeze();
    const t = await until(() => restored >= 1, 20000);
    expect(t, 'stream was not restored after unfreeze').toBeGreaterThanOrEqual(0);
    await expectSpeedEvent(67);
  });

  it.skipIf(!ALLOW_RESTART)('survives a real warm restart of the VC', async () => {
    // RIG CAVEAT (2026-08-03): the RobotStudio IRC5 VC does not reliably
    // survive an RWS-initiated warm restart - observed dying (RobVC process
    // gone, never re-listens) on 2 of 3 attempts in one night. When that
    // happens this test fails on the 8-min window and the VC needs a manual
    // start in RobotStudio. The recovery logic itself passed this test live
    // (2026-08-02) and is also covered by the dead-registration test above.
    await subscribeSpeed({
      // VC restart timing varies with host load (observed 1-6 min end to end
      // across the rig) - budget generously; real IRC5 hardware reboots are
      // in the same range.
      maxReconnectAttempts: 90,
      reconnectBaseMs: 1000,
      reconnectCapMs: 10000,
    });
    await expectSpeedEvent(68);

    await client.restartController('restart');

    // The VC re-binds RWS to a new dynamic port on restart (real IRC5 keeps
    // :80). Chase the port and retarget the proxy so the client sees one
    // stable address throughout - the client itself must recover unaided.
    const deadline = Date.now() + 480000;
    while (restored < 1 && Date.now() < deadline) {
      const port = await findLiveRwsPort();
      if (port) { proxy.setTarget('127.0.0.1', port); }
      await wait(3000);
    }
    expect(restored, 'stream was not restored within 8 min of the warm restart').toBeGreaterThanOrEqual(1);

    await expectSpeedEvent(69, 30000);
    expect(lost).toBe(0);
  }, 560000);
}, 120000);
