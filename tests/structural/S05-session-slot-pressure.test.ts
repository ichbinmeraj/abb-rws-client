/**
 * S05 - Session-slot pressure over reconnect cycles.
 *
 * The failure this cell exists to catch is not a crash: it is a client that
 * reconnects politely for an hour and quietly fills the controller's session
 * pool. Both generations cap concurrent sessions and answer 503 once the pool
 * is full, so a client that leaks sessions locks itself out.
 *
 * So every assertion below is about accounting, not about errors:
 *   - `GET /logout` must actually leave the client on every disconnect. That is
 *     the ONLY thing that frees a slot: `HttpSession.clearSession()` is a
 *     deliberate no-op (it preserves the cookie so a reconnect can reuse the
 *     slot instead of minting a new one).
 *   - The controller's own session count must be flat across N cycles, read
 *     from `GET /users` rather than inferred from the client's behaviour. RWS
 *     1.0 only: RWS 2.0 has nothing that lists or counts sessions
 *     (SESSION_COUNT_UNREADABLE), so there the count is not asserted, with that
 *     reason, and the wire-level properties carry the cell.
 *   - Connections must be amortised across requests, not opened per request.
 *
 * Two observation channels are used because neither alone is enough:
 *   - a plaintext recording tap in front of the chaos proxy, which sees the
 *     actual request line and headers the client emits (RWS 2.0 is TLS, so a
 *     TCP-level proxy cannot);
 *   - on RWS 1.0, `GET /users` issued through a long-lived observer client's
 *     own session, so counting sessions never mints one.
 */

import { it, expect, afterEach } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import { TEST_USER, TEST_PASS, type Generation } from '../helpers/liveControllers.js';
import {
  cell, until, assertQualityHonest, listenForClient, type AnyClient,
} from '../helpers/structuralHarness.js';

/** Reconnect cycles per test. Kept in the 15-25 band: enough that a per-cycle
 *  leak is unmissable (+20 sessions), short enough that the suite runs in
 *  minutes. */
const CYCLES = 20;
/** RobotManager cycles are heavier (port probe + subscription + poll timer). */
const MANAGER_CYCLES = 5;
/** Documented cap on both generations; "must not approach it" is read as half. */
const SESSION_CAP = 70;
/** How long the Basic-credentials check's setup may take: well inside its 180 s test timeout. */
const BASIC_SETUP_BUDGET_MS = 120000;

/**
 * Deliberate spacing between cycles. This is NOT a sleep standing in for a
 * condition (those use until()) - it models a real consumer's reconnect cadence
 * and keeps the churn under the controller's <20 req/s ceiling, so a 503 during
 * the run means pool pressure rather than rate limiting.
 */
const pace = (): Promise<void> => new Promise(r => setTimeout(r, 150));

/** The slice of both clients this cell drives; the two classes agree on it. */
interface CycleClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getControllerState(): Promise<string>;
  getSessionCookie(): string | null;
}

// ─── Wire tap ────────────────────────────────────────────────────────────────

interface TapRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  /** Upstream status, or 599 when the hop itself failed. 0 until it answers. */
  status: number;
}

interface HeaderTap {
  port: number;
  seen: TapRequest[];
  reset(): void;
  close(): Promise<void>;
}

/**
 * A plaintext HTTP hop the client talks to instead of the proxy directly, which
 * then forwards (over TLS when the controller wants it) to the chaos proxy and
 * on to the VC. Traffic still goes through the chaos proxy - this only adds a
 * point where the request line and headers are readable.
 *
 * It exists because the RWS 2.0 controller is HTTPS: `startChaosProxy` is a TCP
 * proxy and can only count bytes, so "did /logout actually go out?" and "was
 * Authorization present?" are unanswerable there. Terminating plaintext on the
 * client side changes nothing the cell cares about - cookie handling, the
 * request queue, agent teardown on disconnect and the session lifecycle are all
 * scheme-independent. For rws1 under RWS_STRUCTURAL_NODE_HTTP=1 the tap listens
 * on a port fetch refuses, so the client sends through node:http
 * (listenForClient).
 */
async function startHeaderTap(upstreamPort: number, upstreamTls: boolean, generation: Generation): Promise<HeaderTap> {
  const seen: TapRequest[] = [];
  const agent = upstreamTls
    ? new https.Agent({ keepAlive: true, rejectUnauthorized: false })
    : new http.Agent({ keepAlive: true });

  const server = http.createServer((req, res) => {
    const record: TapRequest = {
      method: req.method ?? '',
      path: req.url ?? '',
      headers: { ...req.headers },
      status: 0,
    };
    seen.push(record);

    const transport = upstreamTls ? https : http;
    const upstream = (transport as typeof https).request(
      {
        host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
        agent,
        ...(upstreamTls ? { rejectUnauthorized: false } : {}),
      } as https.RequestOptions,
      upRes => {
        record.status = upRes.statusCode ?? 0;
        const out = { ...upRes.headers };
        // Framing is this hop's to redo - forwarding it verbatim would
        // double-encode the body.
        delete out['transfer-encoding'];
        delete out['connection'];
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      record.status = 599;
      if (!res.headersSent) { res.writeHead(502); }
      res.end();
    });
    req.pipe(upstream);
  });

  const port = await listenForClient(server, generation);

  return {
    port,
    seen,
    reset: () => { seen.length = 0; },
    close: () => new Promise<void>(resolve => {
      agent.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** A client of this generation pointed at the tap (always plain HTTP). */
function clientThroughTap(generation: 'rws1' | 'rws2', tapPort: number): AnyClient {
  return generation === 'rws1'
    ? new RwsClient({
      host: '127.0.0.1', port: tapPort,
      username: TEST_USER, password: TEST_PASS, timeout: 8000,
    })
    : new RwsClient2(
      `http://127.0.0.1:${tapPort}`, TEST_USER, TEST_PASS, { timeout: 8000 },
    );
}

// ─── Controller-side session count ───────────────────────────────────────────

/**
 * Why a generation's controller-side session count cannot be read, or null
 * when it can.
 *
 * RWS 2.0 has no resource that lists or counts sessions. Its `GET /users`
 * answers the same two links, `rmmp` and `grant-exists?grant=...`, whoever is
 * logged in (ABB's RWS 2.0 User Service, RobotWare 7 and 8), so the count read
 * from it was the two link items and stayed 2 when a client connected (an
 * RWS 2.0 VC, 2026-10-24). The other services that name clients list none:
 * the Mastership service names a domain's holder, the RobotWare 8 Control
 * Station service names this session's station and the write-access holder,
 * and `/users/login-info` names this session's own user. What RWS 2.0 does show is the
 * wire side - an accepted `GET /logout` per disconnect, no 503 during churn,
 * a session cookie that does not rotate - which the other tests assert.
 */
const SESSION_COUNT_UNREADABLE: Readonly<Record<Generation, string | null>> = {
  rws1: null,
  rws2: 'RWS 2.0 has no resource that lists or counts sessions (GET /users answers the same two links, rmmp and '
    + 'grant-exists, whoever is logged in), so a session leak cannot be observed on the controller; the wire side '
    + '(an accepted GET /logout per disconnect, no 503) is asserted by "every disconnect puts GET /logout on the wire"',
};

/**
 * How many sessions an IRC5 (RWS 1.0) currently believes it has.
 *
 * `GET /users` is RWS 1.0's list of logged-in clients - one entry per live
 * session - and the client does not wrap it, so it is read raw, through the
 * observer's own public `request()` (digest is already negotiated there, and
 * the observer's session is reused, so counting mints no session). RWS 2.0 has
 * no such list: see SESSION_COUNT_UNREADABLE.
 *
 * Throws rather than returning 0 when the list cannot be read or parsed: a
 * silently-zero count would make every "flat" assertion below trivially true,
 * which is worse than a failing cell.
 */
async function countSessions(observer: AnyClient): Promise<number> {
  const { status, body } = await (observer as unknown as {
    request(m: 'GET', p: string): Promise<{ status: number; body: string }>;
  }).request('GET', '/users');
  if (status < 200 || status >= 300) {
    throw new Error(`cannot observe controller sessions: GET /users answered ${status}`);
  }
  // One <li class="user…"> per session in XHTML; a JSON answer names the same
  // thing in `_type`. Both are counted so the representation the controller
  // happens to serve does not decide whether this cell can assert anything.
  const xhtml = body.match(/<li[^>]*class="[^"]*user[^"]*"/gi) ?? [];
  const json = body.match(/"_type"\s*:\s*"[^"]*user[^"]*"/gi) ?? [];
  const n = Math.max(xhtml.length, json.length);
  if (n === 0) {
    throw new Error(
      `GET /users listed no sessions - the count would be meaningless. Body: ${body.slice(0, 240)}`,
    );
  }
  return n;
}

/**
 * Connect one client and return the session count with it logged in, having
 * first proved the count actually MOVED when it did.
 *
 * Without this check every "flat" assertion in this cell could be reading a
 * constant - a lone FlexPendant user, or a `/users` representation that does
 * not enumerate RWS sessions at all - and stay green while the client leaks a
 * slot per cycle. A measurement that cannot see one deliberate session cannot
 * see twenty accidental ones, so it fails here rather than reporting "flat".
 */
async function countAfterConnecting(
  count: () => Promise<number>, connect: () => Promise<void>,
): Promise<number> {
  const before = await count();
  await connect();
  const after = await count();
  expect(
    after,
    `connecting a client left GET /users unchanged (${before} -> ${after}) - the session `
    + 'count is not observing our sessions, so no leak below could ever fail it',
  ).toBeGreaterThan(before);
  return after;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

const open: Array<{
  proxy?: ChaosProxy; client?: AnyClient; manager?: RobotManager; tap?: HeaderTap;
}> = [];
afterEach(async () => {
  // Every step is individually guarded: this cell's whole subject is session
  // slots, and one throw part-way through teardown would leave the REST of the
  // list - live clients included - holding slots on the controller.
  for (const o of open.splice(0)) {
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> })?.disconnect?.().catch(() => undefined);
    await o.tap?.close().catch(() => undefined);
    await o.proxy?.close().catch(() => undefined);
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S05-session-slot-pressure', generation, ctx => {
    it('every disconnect puts GET /logout on the wire, and the cycles never degrade', async () => {
      const proxy = await ctx.proxy();
      const controller = await ctx.controller();
      const tap = await startHeaderTap(proxy.port, controller.tls, generation);
      const client = clientThroughTap(generation, tap.port);
      open.push({ proxy, client, tap });

      const c = client as unknown as CycleClient;
      await c.connect();
      // The first connect's handshake belongs to no cycle; count from here.
      tap.reset();

      const failures: string[] = [];
      for (let i = 1; i <= CYCLES; i++) {
        try {
          await c.getControllerState();
          await c.disconnect();
          await c.connect();
        } catch (e) {
          failures.push(`cycle ${i}: ${e instanceof Error ? e.message : String(e)}`);
        }
        await pace();
      }
      await c.disconnect();

      expect(failures, 'reconnect cycles degraded into failures').toEqual([]);

      const logouts = tap.seen.filter(r => r.method === 'GET' && r.path === '/logout');
      // RWS 1.0 may answer the first request of a re-used session with 401 and
      // HttpSession re-authenticates and repeats it, so /logout can appear twice
      // for one disconnect. What must hold exactly is that every disconnect
      // produced one logout the controller ACCEPTED: a 401/403/404/500 logout
      // frees no slot, so only a 2xx/3xx counts - "it reached the wire" is not
      // the property, "the slot was released" is.
      const settled = logouts.filter(r => r.status >= 200 && r.status < 400);
      expect(logouts.length, 'GET /logout missing for at least one disconnect')
        .toBeGreaterThanOrEqual(CYCLES + 1);
      expect(
        settled.length,
        'one ACCEPTED GET /logout per disconnect (CYCLES + the final one); '
        + `logout statuses seen: [${logouts.map(r => r.status).join(', ')}]`,
      ).toBe(CYCLES + 1);

      // Pool pressure surfaces as 503/CONTROLLER_BUSY (or 429) long before the
      // 70-session cap is reached, so a single one during this churn is the
      // symptom this cell is named after.
      const busy = tap.seen.filter(r => r.status === 503 || r.status === 429);
      expect(
        busy.map(r => `${r.method} ${r.path} -> ${r.status}`),
        'controller answered busy/rate-limited during reconnect churn',
      ).toEqual([]);
    }, 180000);

    it('reconnect cycles leave the controller session count flat', async t => {
      // Before anything is opened: a skipped test's afterEach does not run.
      const unreadable = SESSION_COUNT_UNREADABLE[generation];
      if (unreadable) { ctx.skip(t, unreadable); }

      const proxy = await ctx.proxy();

      // Separate, never-disconnected client: its session is the stable vantage
      // point from which the churning client's slots are counted.
      const observer = await ctx.client(proxy);
      open.push({ client: observer });
      await (observer as unknown as CycleClient).connect();

      const client = await ctx.client(proxy);
      open.push({ proxy, client });
      const c = client as unknown as CycleClient;

      const count = (): Promise<number> => countSessions(observer);

      // The baseline is taken by CONNECTING the churning client and watching the
      // count rise: a count that cannot see one session it was told to expect
      // proves nothing when it later stays flat.
      const baseline = await countAfterConnecting(count, () => c.connect());

      let peak = baseline;
      for (let i = 1; i <= CYCLES; i++) {
        await c.disconnect();
        await c.connect();
        await c.getControllerState();
        // Sample periodically rather than every cycle: the count itself costs a
        // request, and a leak shows up as a trend, not in one sample.
        if (i % 5 === 0) { peak = Math.max(peak, await count()); }
        await pace();
      }
      const after = await count();
      peak = Math.max(peak, after);

      // Flat means flat. A slot leaked per cycle would read baseline + CYCLES
      // here; the single unit of slack is the just-logged-out session the
      // controller may not have reaped from its table yet.
      expect(
        after,
        `session count went ${baseline} -> ${after} over ${CYCLES} connect/disconnect cycles`,
      ).toBeLessThanOrEqual(baseline + 1);
      expect(peak, `session count peaked at ${peak} (baseline ${baseline})`)
        .toBeLessThanOrEqual(baseline + 1);

      // "Churn must not approach the cap": half of the documented 70 is already
      // far past anything healthy churn should produce.
      expect(peak, `churn approached the ${SESSION_CAP}-session cap`)
        .toBeLessThan(SESSION_CAP / 2);
    }, 180000);

    it('reconnect cycles do not open a connection per request', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy);
      open.push({ proxy, client });
      const c = client as unknown as CycleClient;

      // Deliberately many reads per cycle: the point is that connections track
      // cycles (RWS 2.0 destroys its agents on disconnect, so ~1 per cycle is
      // expected and correct) and NOT the request count.
      await c.connect();
      let requests = 1;
      for (let i = 1; i <= CYCLES; i++) {
        for (let r = 0; r < 5; r++) { await c.getControllerState(); requests++; }
        await c.disconnect(); requests++;
        await c.connect(); requests++;
        await pace();
      }

      const stats = proxy.stats();
      // `requests` is a lower bound (RWS 1.0 401-retries and the RWS 2.0
      // hal+json fallback each add a hidden request), which only makes this
      // stricter.
      expect(
        stats.connectionsTotal,
        `${stats.connectionsTotal} connections for >=${requests} requests - keep-alive is not being reused`,
      ).toBeLessThan(requests);
      expect(
        stats.connectionsTotal,
        `${stats.connectionsTotal} connections over ${CYCLES} cycles - connections are not tracking cycles`,
      ).toBeLessThanOrEqual(2 * CYCLES + 4);
    }, 300000);

    if (generation === 'rws2') {
      // The matrix states this property at the header level, and so does the
      // repo rule ("Send Basic credentials only until you hold a session
      // cookie").
      //
      // Since 1.5.1 RwsClient2 sends the Basic credentials only until it holds
      // a session cookie, and again only after a 401 to that cookie (src/rws2/
      // core.ts: authHeaders, withLogin); until then this test was held as a
      // known gap (it.fails). tests/fix151-rws2-credentials.test.ts pins the
      // same rule on a scripted controller, the subscription POST and the
      // WebSocket upgrade included.
      //
      // It reads only the request headers at the tap, and no session count:
      // nothing on RWS 2.0 counts sessions (SESSION_COUNT_UNREADABLE).
      it('does not re-send Basic credentials once a session cookie is held', async () => {
        const setup = async (): Promise<TapRequest[]> => {
          const proxy = await ctx.proxy();
          const controller = await ctx.controller();
          const tap = await startHeaderTap(proxy.port, controller.tls, generation);
          const client = clientThroughTap(generation, tap.port) as RwsClient2;
          open.push({ proxy, client, tap });

          await client.connect();
          if (!client.getSessionCookie()) {
            throw new Error('no session cookie after connect - the header check would mean nothing');
          }
          tap.reset();
          for (let i = 0; i < 8; i++) { await client.getControllerState(); }
          const reads = [...tap.seen];
          if (reads.length < 8) { throw new Error(`the tap saw ${reads.length} of the 8 reads`); }
          return reads;
        };
        // The setup gets its own budget, well inside the 180 s test timeout,
        // so a setup that broke or hung fails the test saying so, not as a
        // bare timeout. What a setup still running past its budget opened by
        // then is freed by afterEach.
        let seen: TapRequest[];
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          seen = await Promise.race([
            setup(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`no answer within ${BASIC_SETUP_BUDGET_MS / 1000} s`)), BASIC_SETUP_BUDGET_MS);
            }),
          ]);
        } catch (e) {
          throw new Error('S05-session-slot-pressure/rws2: the Basic-credentials check never reached its '
            + `assertion, its setup failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(timer);
        }

        const credentialed = seen.filter(r => r.headers['authorization'] !== undefined);
        expect(
          credentialed.map(r => `${r.method} ${r.path}`),
          'requests carried Basic credentials while a session cookie was held',
        ).toEqual([]);
      }, 180000);

      it('repeated subscribe/unsubscribe rides the existing session', async () => {
        // No session count (SESSION_COUNT_UNREADABLE): a session minted per
        // subscribe shows as a rotated cookie, which the client adopts from the
        // subscription answer's Set-Cookie.
        const proxy = await ctx.proxy();
        const client = await ctx.client(proxy) as RwsClient2;
        open.push({ proxy, client });
        await client.connect();

        const cookie = client.getSessionCookie();
        expect(cookie, 'no session cookie after connect').toBeTruthy();

        for (let i = 1; i <= 6; i++) {
          const unsubscribe = await client.subscribe(
            ['controllerstate'], () => { /* events are not what this test reads */ },
            undefined, undefined,
            { reconnectBaseMs: 300, pingIntervalMs: 5000, openTimeoutMs: 8000 },
          );
          expect(unsubscribe.groupPath, `subscribe ${i} returned no group`).not.toBe('');
          await unsubscribe();
          await pace();
        }

        // POST /subscription rides the main session: 201 with no Set-Cookie, so
        // the cookie must come out byte-identical. A rotated cookie is the
        // signature of a session minted per subscribe - the failure mode that
        // burns the 5-sessions-per-IP budget inside one reconnect loop.
        expect(client.getSessionCookie(), 'session cookie rotated across subscribes').toBe(cookie);
      }, 300000);
    }

    it('RobotManager reconnect cycles stay flat and leave quality honest', async () => {
      const proxy = await ctx.proxy();
      const controller = await ctx.controller();

      // The session count is read on RWS 1.0 only. On RWS 2.0 nothing counts
      // sessions (SESSION_COUNT_UNREADABLE): the count assertions are left out
      // there, and the cycles and the quality are still asserted. What still
      // fails here on RWS 2.0 is a manager that leaves its session open at
      // every reconnect: ABB's RWS 2.0 docs allow 5 sessions per IP address,
      // all of these run from 127.0.0.1, and the reconnect over the limit is
      // refused (the consequence S08 asserts by). A leak the controller frees
      // when the connection closes is not seen here.
      const unreadable = SESSION_COUNT_UNREADABLE[generation];
      if (unreadable) { console.warn(`S05-session-slot-pressure/${generation}: session count not asserted - ${unreadable}`); }
      let count: (() => Promise<number>) | null = null;
      if (!unreadable) {
        const observer = await ctx.client(proxy);
        open.push({ client: observer });
        await (observer as unknown as CycleClient).connect();
        count = () => countSessions(observer);
      }
      const beforeManager = count ? await count() : 0;

      // The manager is the path a real consumer churns on (the VS Code
      // extension reconnects exactly this way), and it holds more than an HTTP
      // session - a subscription group and a poll timer ride along.
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 500 });
      open.push({ proxy, manager });
      await until(
        () => manager.state.quality === 'live' || manager.state.quality === 'polling',
        25000, 'manager reaches a steady quality',
      );

      // The baseline is taken WITH the manager connected. Taken before, the
      // manager's own (correct) session would eat the whole +1 tolerance below,
      // leaving no room for a just-logged-out session the controller has not
      // reaped - a false red. The rise also proves the count sees our sessions.
      const baseline = count ? await count() : 0;
      if (count) {
        expect(
          baseline,
          `the manager's own session is invisible to GET /users (${beforeManager} -> ${baseline}) `
          + '- a per-cycle leak would be invisible too',
        ).toBeGreaterThan(beforeManager);
      }

      for (let i = 1; i <= MANAGER_CYCLES; i++) {
        await manager.disconnect();
        await manager.connect('127.0.0.1', TEST_USER, TEST_PASS, proxy.port, controller.tls);
        await pace();
      }

      await until(
        () => manager.state.quality === 'live' || manager.state.quality === 'polling',
        30000, 'quality returns to a steady state after the cycles',
      );
      // S14 cross-cutting: a real round trip (RobotManager exposes no
      // getControllerState - controller state arrives through polling into
      // `state.ctrlstate` - so the clock read is the cheapest genuine request)
      // succeeds here, which makes a 'disconnected' claim a lie, and every
      // state must explain itself.
      await expect(manager.getControllerClock()).resolves.toBeTruthy();
      expect(manager.state.connected, 'manager reports disconnected after reconnect cycles').toBe(true);
      assertQualityHonest(manager, { notDisconnected: true });

      if (count) {
        const after = await count();
        expect(
          after,
          `session count went ${baseline} -> ${after} over ${MANAGER_CYCLES} manager reconnects`,
        ).toBeLessThanOrEqual(baseline + 1);
      }
    }, 300000);
  });
}
