/**
 * S06 - 401 storm / credentials changed mid-session.
 *
 * The failure this cell exists to prevent is a client that answers a credential
 * rejection by asking again, forever. It is the one fault class where "retry
 * until it works" is always wrong: a 401 is a statement about the caller, not
 * about the network, so nothing about repeating the request can change the
 * answer. A retry loop here burns the controller's session pool, floods the
 * event log, and hides the one thing the operator needs to be told.
 *
 * Three properties, per the matrix:
 *   - the rejection surfaces as a typed RwsError with code AUTH_FAILED (never a
 *     bare Error, never a 403-shaped GRANT_DENIED);
 *   - the number of requests is BOUNDED and stops when the call settles;
 *   - the connection tears down cleanly and RobotManager ends `disconnected`
 *     with a reason that names the credential failure, not a blank string.
 * For RWS 2.0 the matrix adds the WebSocket upgrade: a stale session cookie made
 * the upgrade answer 401 and the client re-attempt without limit (live-observed
 * on RW7.21, 2026-08-02), so the attempt count is asserted bounded there too.
 *
 * WHY A MOCK CARRIES THE STORM. Revoking or changing a VC's credentials is a UAS
 * mutation, which the task's destructive ceiling forbids outright. And even if
 * it were allowed, a live controller cannot answer the question being asked
 * here: "no infinite retry loop" is a claim about the NUMBER of requests, and
 * that number is only observable server-side. So the storm runs against a mock
 * that speaks just enough of each generation to get a client connected and can
 * then refuse everything, while a live check per generation pins the typing to
 * the real controllers - a wrong password on a real VC must produce the same
 * AUTH_FAILED the mock produces. The live half is deliberately one attempt per
 * generation: a rejected credential mints no session, but repeatedly hammering
 * a VC's auth path is exactly the shape of the incident that wedged one.
 */

import { it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket as ServerWebSocket } from 'ws';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import { RobotManager } from '../../src/RobotManager.js';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import type { SubscriptionEvent } from '../../src/types.js';
import {
  cell, expectRwsError, until, assertQualityHonest, type AnyClient,
} from '../helpers/structuralHarness.js';
import { TEST_USER, type Generation } from '../helpers/liveControllers.js';

/** Never a real credential on either VC - the live half must be refused. */
const WRONG_PASS = 'not-the-password-9f31c7';

// ─── Mock controller ─────────────────────────────────────────────────────────

interface MockController {
  port: number;
  /** One entry per HTTP request answered, in order. */
  requests: Array<{ method: string; url: string; status: number; at: number }>;
  /** One entry per WebSocket upgrade attempt, accepted or refused. */
  upgrades: Array<{ at: number; cookie: string }>;
  /** From now on every authenticated request is answered 401. */
  refuseCredentials(on: boolean): void;
  /** From now on every WS upgrade is answered 401; HTTP is unaffected. */
  refuseUpgrades(on: boolean): void;
  /** Kill every established event socket abruptly (close 1006, not a clean close). */
  dropEventSockets(): void;
  /**
   * The `-http-session-` cookie minted by the most recent POST /subscription.
   * The RW7.21 failure was a client presenting an OLDER one on the upgrade, so
   * the WS cell needs to know which cookie counts as current.
   */
  lastSubscriptionCookie(): string;
  close(): Promise<void>;
}

/**
 * The smallest server both clients will connect to.
 *
 * It serves the one GET each generation's `connect()` reads, plus /logout and
 * the subscription registration; every other path answers 404. That 404 is
 * deliberate rather than lazy: it keeps the RobotManager's polls failing for a
 * NON-credential reason before the test revokes anything, so the auth failure
 * injected later is distinguishable in the quality reason instead of being
 * indistinguishable from the mock's own gaps.
 */
async function startMockController(
  generation: Generation,
  init: { refuseCredentials?: boolean; refuseUpgrades?: boolean } = {},
): Promise<MockController> {
  const requests: MockController['requests'] = [];
  const upgrades: MockController['upgrades'] = [];
  const sockets: ServerWebSocket[] = [];
  let refusing = init.refuseCredentials ?? false;
  let refusingUpgrades = init.refuseUpgrades ?? false;
  let groupId = 0;
  let port = 0;
  let lastSubCookie = '';

  // RWS 1.0 is Digest, RWS 2.0 is Basic - and the protocol detector decides a
  // port's generation purely from this string, so it has to be well formed.
  // HttpSession additionally refuses a challenge without both realm and nonce.
  const challenge = generation === 'rws1'
    ? 'Digest realm="ABB Robotics", nonce="4f1c9a2e7b3d5608", qop="auth", algorithm=MD5'
    : 'Basic realm="ABB Robotics"';

  const okBodies: Record<string, { body: string; type: string }> = generation === 'rws1'
    ? {
      '/rw/panel/ctrlstate': {
        type: 'application/xhtml+xml',
        body: '<?xml version="1.0" encoding="utf-8"?>'
          + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ctrlstate</title></head>'
          + '<body><div class="state"><ul>'
          + '<li class="pnl-ctrlstate" title="ctrlstate"><span class="ctrlstate">motoroff</span></li>'
          + '</ul></div></body></html>',
      },
      '/rw/system': {
        type: 'application/xhtml+xml',
        body: '<?xml version="1.0" encoding="utf-8"?>'
          + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>system</title></head>'
          + '<body><div class="state"><ul>'
          + '<li class="sys-system" title="system"><span class="rwversion">6.16.3007</span></li>'
          + '</ul></div></body></html>',
      },
    }
    : {
      // hal+json, and the Content-Type says so: a GET that negotiates hal+json
      // and gets a non-JSON body makes RwsClient2 re-issue the same request as
      // XHTML, which would silently double every count this cell asserts on.
      '/rw/system': {
        type: 'application/hal+json;v=2.0',
        body: JSON.stringify({
          _links: { self: { href: '/rw/system' } },
          status: { code: 294912 },
          state: [{ _type: 'sys-system', _title: 'system', rwversion: '7.21.0+229', name: 'MOCK' }],
        }),
      },
      '/rw/panel/ctrl-state': {
        type: 'application/hal+json;v=2.0',
        body: JSON.stringify({
          _links: { self: { href: '/rw/panel/ctrl-state' } },
          status: { code: 294912 },
          state: [{ _type: 'pnl-ctrlstate', _title: 'ctrl-state', ctrlstate: 'motoroff' }],
        }),
      },
    };

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '';
    const path = url.split('?')[0];
    req.resume();   // drain, so keep-alive sockets stay usable

    const record = (status: number): void => {
      requests.push({ method, url, status, at: Date.now() });
    };

    const unauthorized = (): void => {
      record(401);
      res.writeHead(401, {
        'WWW-Authenticate': challenge,
        'Content-Type': 'text/plain',
        'Content-Length': '0',
      });
      res.end();
    };

    // An unauthenticated request always draws the challenge, refusing or not:
    // that is how the protocol detector names the generation, and how RWS 1.0
    // obtains the nonce it needs before it can authenticate at all.
    if (!req.headers['authorization']) { unauthorized(); return; }
    if (refusing) { unauthorized(); return; }

    if (method === 'GET' && path === '/logout') {
      record(204); res.writeHead(204); res.end(); return;
    }

    if (method === 'POST' && path === '/subscription') {
      groupId++;
      const wsUrl = `ws://127.0.0.1:${port}/poll/${groupId}`;
      // A NEW session cookie per registration - that is what makes a client
      // that keeps presenting the old one detectable on the upgrade.
      lastSubCookie = `-http-session-=mock-sub-${groupId}`;
      record(201);
      res.writeHead(201, {
        // Both subscribers read the Location header first and re-anchor the
        // path on the host:port they were configured with.
        Location: wsUrl,
        'Set-Cookie': `${lastSubCookie}; path=/`,
        'Content-Type': 'application/xhtml+xml;v=2.0',
      });
      res.end('<?xml version="1.0" encoding="utf-8"?>'
        + '<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="state">'
        + `<a href="subscription/${groupId}" rel="group"></a>`
        + `<a href="${wsUrl}" rel="self"></a>`
        + '</div></body></html>');
      return;
    }

    if (method === 'DELETE' && /^\/subscription\/\d+/.test(path)) {
      record(204); res.writeHead(204); res.end(); return;
    }

    const hit = method === 'GET' ? okBodies[path] : undefined;
    if (hit) {
      record(200);
      res.writeHead(200, {
        'Content-Type': hit.type,
        'Set-Cookie': '-http-session-=mock-session; path=/',
      });
      res.end(hit.body);
      return;
    }

    record(404);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Resource not served by the S06 mock');
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    upgrades.push({ at: Date.now(), cookie: String(req.headers['cookie'] ?? '') });
    if (refusingUpgrades) {
      // The live shape: the handshake is REJECTED with 401 rather than being
      // completed and then closed. `ws` surfaces that as unexpected-response
      // (RWS 2.0 listens for it) or as an error before open (RWS 1.0).
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.push(ws);
      // RWS 2.0 keeps the stream alive with an app-level PING text frame.
      ws.on('message', d => { if (d.toString() === 'PING') { ws.send('PONG'); } });
      ws.on('error', () => undefined);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  return {
    port,
    requests,
    upgrades,
    refuseCredentials: (on: boolean) => { refusing = on; },
    refuseUpgrades: (on: boolean) => { refusingUpgrades = on; },
    lastSubscriptionCookie: () => lastSubCookie,
    dropEventSockets: () => {
      for (const s of sockets.splice(0)) {
        try { s.terminate(); } catch { /* already gone */ }
      }
    },
    close: () => new Promise<void>(resolve => {
      for (const s of sockets.splice(0)) {
        try { s.terminate(); } catch { /* already gone */ }
      }
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Watch a counter until it stops moving, then return its final value.
 *
 * "No infinite retry loop" is a claim about what happens AFTER the call has
 * already rejected, so a single reading taken at the rejection would pass even
 * for a client that keeps retrying in the background forever. The only honest
 * form of the assertion is "the counter goes quiet and stays quiet", and this
 * throws rather than returning if it never does.
 *
 * `quietMs` MUST exceed the cadence of whatever loop the test is trying to
 * disprove, or the check is worthless: a manager polling every 1500 ms looks
 * perfectly quiet to a 1200 ms window and this returns "settled" for a client
 * that never stopped. Callers driving a RobotManager pass a multiple of the
 * poll interval; the default only covers the tight in-request retry paths
 * (HttpSession's 200 ms 503 backoff, the WS reconnect cap).
 */
async function settledCount(
  count: () => number, quietMs = 1500, timeoutMs = 25000, label = 'request count',
): Promise<number> {
  const t0 = Date.now();
  let last = count();
  let lastChange = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 40));
    const now = count();
    if (now !== last) { last = now; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) { return last; }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`${label} never settled - still growing after ${timeoutMs} ms (at ${last})`);
    }
  }
}

/** A client of the right generation pointed at the mock (always plain HTTP). */
function mockClient(generation: Generation, mock: MockController): AnyClient {
  if (generation === 'rws1') {
    return new RwsClient({
      host: '127.0.0.1', port: mock.port,
      username: TEST_USER, password: 'robotics', timeout: 5000,
    });
  }
  return new RwsClient2(
    `http://127.0.0.1:${mock.port}`, TEST_USER, 'robotics', { timeout: 5000 },
  );
}

interface Connectable { connect(): Promise<void>; disconnect(): Promise<void> }
interface StateReadable { getControllerState(): Promise<string> }

/**
 * Requests a single rejected call costs, per generation.
 *
 * RWS 1.0 spends two: HttpSession sends the request, is told 401, parses the
 * WWW-Authenticate challenge, and re-sends ONCE with a digest response - a
 * mandatory part of the scheme, not a retry. The second 401 throws.
 * RWS 2.0 always carries its Basic header, so a 401 is final on the first
 * request and there is nothing to re-send.
 */
const REQUESTS_PER_REJECTED_CALL: Record<Generation, number> = { rws1: 2, rws2: 1 };

/**
 * RobotManager poll period for the quality test. Named because the assertion
 * that the manager STOPPED polling is only meaningful against a window several
 * times this long - see settledCount.
 */
const POLL_MS = 1500;

/** Reconnect budget the WS cells pin, small enough to exhaust inside a test. */
const WS_MAX_ATTEMPTS = 3;
const WS_TUNING = {
  maxReconnectAttempts: WS_MAX_ATTEMPTS,
  reconnectBaseMs: 40,
  reconnectCapMs: 120,
  openTimeoutMs: 2000,
  pingIntervalMs: 30000,
};

/**
 * Upgrade attempts a fully exhausted reconnect budget may cost.
 *
 * RWS 2.0 makes one upgrade per attempt: re-POST /subscription, then upgrade.
 * RWS 1.0 makes up to two - it first retries the STORED poll URL (IRC5 poll
 * URLs are reusable after a plain drop), and only if that fails re-registers
 * and upgrades again. Both counts include the one successful initial upgrade.
 */
function maxUpgradeAttempts(generation: Generation): number {
  return generation === 'rws1' ? 1 + 2 * WS_MAX_ATTEMPTS : 1 + WS_MAX_ATTEMPTS;
}

/** Both generations subscribe to the same resource through different signatures. */
function subscribeBounded(
  client: AnyClient, generation: Generation,
  handler: (e: SubscriptionEvent) => void, onLost: () => void,
): Promise<() => Promise<void>> {
  if (generation === 'rws1') {
    return (client as RwsClient).subscribe(['controllerstate'], handler, { ...WS_TUNING, onLost });
  }
  return (client as RwsClient2).subscribe(['controllerstate'], handler, onLost, undefined, WS_TUNING);
}

// ─── Cell ────────────────────────────────────────────────────────────────────

interface OpenResource {
  proxy?: ChaosProxy;
  client?: AnyClient;
  manager?: RobotManager;
  mock?: MockController;
  stop?: () => Promise<void>;
}

const open: OpenResource[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.stop?.().catch(() => undefined);
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> } | undefined)
      ?.disconnect?.().catch(() => undefined);
    await o.mock?.close();
    await o.proxy?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S06-401-storm', generation, ctx => {
    it('every request answered 401 yields a typed AUTH_FAILED and stops there', async () => {
      const mock = await startMockController(generation, { refuseCredentials: true });
      const client = mockClient(generation, mock);
      open.push({ mock, client });

      const before = mock.requests.length;
      const err = await expectRwsError(() => (client as unknown as Connectable).connect());
      // AUTH_FAILED specifically, not the GRANT_DENIED a 403 earns: a consumer
      // branches on this to re-prompt for credentials rather than to explain a
      // missing grant, and the two are not interchangeable.
      expect(err.code).toBe('AUTH_FAILED');
      expect(err.httpStatus).toBe(401);

      const spent = mock.requests.length - before;
      expect(spent, 'requests spent on a single rejected connect()')
        .toBe(REQUESTS_PER_REJECTED_CALL[generation]);
      expect(mock.requests.every(r => r.status === 401)).toBe(true);

      // Nothing may keep asking once the call has rejected. settledCount throws
      // if the counter never goes quiet; this pins the quiet value to the exact
      // handshake cost, so a background retry that fired even once fails here.
      const settled = await settledCount(() => mock.requests.length);
      expect(settled, 'requests kept arriving after the rejection')
        .toBe(before + spent);

      // A refused client must still tear down without throwing or hanging.
      await expect((client as unknown as Connectable).disconnect()).resolves.toBeUndefined();
    }, 60000);

    it('credentials revoked mid-session fail typed at a bounded cost per call', async () => {
      const mock = await startMockController(generation);
      const client = mockClient(generation, mock);
      open.push({ mock, client });

      await (client as unknown as Connectable).connect();
      await expect((client as unknown as StateReadable).getControllerState())
        .resolves.toBe('motoroff');

      // The credentials behind the live session stop being valid. Everything
      // from here answers 401, including the session's own cookie-authenticated
      // requests - the controller does not care that we were authorised a
      // moment ago.
      mock.refuseCredentials(true);

      const CALLS = 5;
      const before = mock.requests.length;
      for (let i = 0; i < CALLS; i++) {
        const err = await expectRwsError(
          () => (client as unknown as StateReadable).getControllerState(),
        );
        expect(err.code, `call ${i + 1} lost its typing`).toBe('AUTH_FAILED');
        expect(err.httpStatus).toBe(401);
      }

      // Cost must be LINEAR in the calls the consumer made - a client that
      // retried internally would multiply this, and one that looped would never
      // let settledCount return at all.
      const spent = mock.requests.length - before;
      expect(spent, `${CALLS} rejected calls cost more than the handshake requires`)
        .toBe(CALLS * REQUESTS_PER_REJECTED_CALL[generation]);

      const settled = await settledCount(() => mock.requests.length);
      expect(settled).toBe(before + spent);

      // Clean disconnect: /logout is answered 401 like everything else, and the
      // teardown must swallow that rather than throwing out of disconnect().
      await expect((client as unknown as Connectable).disconnect()).resolves.toBeUndefined();
      // A disconnected client is idle by definition, so the count taken the
      // instant disconnect() resolved is the count that must still hold - not
      // "whatever it happens to be once things go quiet".
      const atDisconnect = mock.requests.length;
      const afterDisconnect = await settledCount(() => mock.requests.length);
      expect(afterDisconnect, 'requests were issued after disconnect() resolved')
        .toBe(atDisconnect);
    }, 60000);

    it('RobotManager ends disconnected, with a reason that names the auth failure', async () => {
      // Upgrades are refused from the start so the manager settles on polling -
      // this cell is about what the POLLING path does with a 401, and a live
      // event stream would mask it behind cached state.
      const mock = await startMockController(generation, { refuseUpgrades: true });
      const manager = new RobotManager({ refreshIntervalMs: POLL_MS });
      open.push({ mock, manager });

      await manager.connect('127.0.0.1', TEST_USER, 'robotics', mock.port, false);
      expect(manager.state.connected).toBe(true);
      // Requests still succeed at this point, so claiming disconnected would be
      // the other half of the S14 lie.
      assertQualityHonest(manager, { notDisconnected: true });

      // Revoke immediately: the poll doConnect already ran counts as failure 1
      // (the mock serves no poll surface), so failures 2 and 3 - the one whose
      // message becomes the quality reason - are guaranteed to be 401s.
      mock.refuseCredentials(true);

      await until(() => manager.state.quality === 'disconnected', 40000,
        'quality reaches disconnected after the 401 storm');

      expect(manager.state.connected).toBe(false);
      assertQualityHonest(manager, { notLive: true });
      const reason = manager.state.qualityReason ?? '';
      expect(reason.trim(), 'disconnected with no reason at all').not.toBe('');
      expect(reason).toMatch(/failed polls/i);
      // The reason has to carry WHY. "3 failed polls" alone sends a field
      // engineer looking at the network for a password problem.
      expect(reason, `reason does not mention the credential failure: "${reason}"`)
        .toMatch(/auth|401|unauthor/i);

      // Giving up must actually stop the timers - a manager that kept polling a
      // controller that refuses it is the session-pool incident in slow motion.
      // The quiet window has to span SEVERAL poll periods: at one period the
      // gap between two ticks reads as "settled" and a manager that never
      // stopped would pass. The tail of the last poll's already-queued requests
      // may still land, which is why this asserts the counter goes quiet rather
      // than pinning it to the value at give-up.
      const settled = await settledCount(
        () => mock.requests.length, 3 * POLL_MS, 40000, 'poll requests after give-up',
      );
      expect(settled, 'polling continued after the manager reported disconnected')
        .toBe(mock.requests.length);
    }, 120000);

    it('a WebSocket upgrade answered 401 does not retry forever', async () => {
      const mock = await startMockController(generation);
      const client = mockClient(generation, mock);
      // One entry, so cleanup runs stop → client → mock in that order; closing
      // the mock first would leave the unsubscribe DELETE talking to a dead port.
      const entry: OpenResource = { mock, client };
      open.push(entry);

      await (client as unknown as Connectable).connect();

      let lostCalls = 0;
      const events: SubscriptionEvent[] = [];
      const stop = await subscribeBounded(
        client, generation, e => events.push(e), () => { lostCalls++; },
      );
      entry.stop = stop;
      expect(mock.upgrades.length, 'the initial upgrade should have been accepted').toBe(1);

      // Now the exact live shape: the stream drops, and every re-upgrade is
      // refused 401 (on RW7.21 this was a session cookie the controller no
      // longer recognised). The registration POST keeps working, so nothing
      // except the upgrade tells the client to stop.
      mock.refuseUpgrades(true);
      mock.dropEventSockets();

      await until(() => lostCalls > 0, 30000, 'the subscriber gives up and reports the loss');

      const bound = maxUpgradeAttempts(generation);
      // 1200 ms of quiet is ten times the configured 120 ms reconnect cap, so a
      // subscriber still working through its budget cannot look settled here.
      const attempts = await settledCount(
        () => mock.upgrades.length, 10 * WS_TUNING.reconnectCapMs, 25000, 'WS upgrade attempts',
      );
      expect(attempts, `upgrade attempts exceeded the ${WS_MAX_ATTEMPTS}-attempt budget`)
        .toBeLessThanOrEqual(bound);
      // More than the initial one, or the reconnect path never ran and this
      // proves nothing.
      expect(attempts).toBeGreaterThan(1);
      // onLost is a terminal notification, not a per-attempt one.
      expect(lostCalls, 'onLost fired more than once').toBe(1);

      // The RW7.21 shape wasn't just "it retried" - it retried with a session
      // the controller had already replaced, so every upgrade was 401 and no
      // number of attempts could ever have worked. Each registration here mints
      // a NEW cookie, so an attempt that re-registered and then presented the
      // previous one is visible: the last upgrade must carry the newest
      // session. (A client that never re-registered passes this trivially -
      // the attempt-count assertions above are what bound that case.)
      const freshCookie = mock.lastSubscriptionCookie();
      expect(freshCookie, 'the mock never minted a subscription cookie').not.toBe('');
      const lastUpgrade = mock.upgrades[mock.upgrades.length - 1];
      expect(lastUpgrade.cookie, 'the final upgrade presented a stale session cookie')
        .toContain(freshCookie);

      await expect(stop()).resolves.toBeUndefined();
      await expect((client as unknown as Connectable).disconnect()).resolves.toBeUndefined();
    }, 90000);

    it('the live controller refuses a wrong password with a typed AUTH_FAILED', async () => {
      const controller = await ctx.controller();
      const proxy = await ctx.proxy();
      // Not ctx.client(): the harness always builds the working credentials.
      // TLS (RWS 2.0) passes through the TCP proxy untouched, so the scheme
      // follows the REAL controller, not the proxy hop.
      const client: AnyClient = generation === 'rws1'
        ? new RwsClient({
          host: '127.0.0.1', port: proxy.port,
          username: TEST_USER, password: WRONG_PASS, timeout: 8000,
        })
        : new RwsClient2(
          `${controller.tls ? 'https' : 'http'}://127.0.0.1:${proxy.port}`,
          TEST_USER, WRONG_PASS, { timeout: 8000 },
        );
      open.push({ proxy, client });

      // ONE attempt. A rejected credential mints no session, but hammering a
      // VC's auth path is precisely the shape that wedged a controller before.
      const err = await expectRwsError(() => (client as unknown as Connectable).connect());
      expect(err.code).toBe('AUTH_FAILED');
      expect(err.httpStatus).toBe(401);

      // Server-side proof that nothing keeps trying. Bytes, not requests: the
      // chaos proxy is a TCP hop and cannot count HTTP messages - but a client
      // retrying in the background still has to put bytes on the wire.
      const settled = await settledCount(
        () => proxy.stats().bytesUp, 1500, 25000, 'bytes sent to the controller',
      );
      expect(settled).toBe(proxy.stats().bytesUp);
      // Weak but real: keep-alive means a retry loop could reuse one socket, so
      // the flatness check above carries the argument. A client that opened a
      // fresh connection per retry would blow through this.
      expect(proxy.stats().connectionsTotal,
        'a wrong password opened an implausible number of connections')
        .toBeLessThanOrEqual(4);

      await expect((client as unknown as Connectable).disconnect()).resolves.toBeUndefined();
    }, 60000);
  });
}
