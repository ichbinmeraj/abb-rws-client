/**
 * S10 - 503 storm / backpressure.
 *
 * A controller that answers 503 is saying "I am overloaded, stop". The failure
 * mode this cell exists to prevent is the one that wedged a VC before: a client
 * that reads "temporarily unavailable" as "try again immediately" and turns a
 * transient busy window into a self-sustaining request flood. The controller's
 * documented ceiling is <20 req/s, and going over it is precisely what makes it
 * answer 503 - so a client that hammers on 503 manufactures the condition it is
 * reacting to.
 *
 * Three properties, per the matrix:
 *   - the refusal surfaces as a typed RwsError with code CONTROLLER_BUSY (503 is
 *     the one status both generations map identically: HttpSession throws it
 *     directly after its single 200 ms retry, and RwsClient2 passes it to
 *     classifyControllerError as the `fallback`, which stands unless the body
 *     carries a controller status code);
 *   - the request rate stays under the ceiling FOR THE WHOLE STORM, measured
 *     server-side over a sliding one-second window - not "the client waits a
 *     bit", but "no second of the storm ever contained 20 requests";
 *   - requests succeed again once the server recovers: no starvation, no
 *     permanently poisoned queue, and calls issued mid-storm all settle.
 *
 * WHY A MOCK CARRIES THE STORM. There is no safe way to make a live VC answer
 * 503: the only lever is filling its session pool or exceeding its rate limit,
 * which is the incident this suite exists to prevent, not a test fixture. And
 * even if it were safe, "the rate stayed under 20 req/s" is a claim about the
 * count and arrival times of requests, which is only observable server-side.
 *
 * WHY THERE IS STILL A LIVE HALF. The mock can prove typing and pacing, but it
 * cannot prove recovery on a real controller, and it cannot exercise the
 * RobotManager poll loop (fetchAll needs a dozen-odd endpoints answering in the
 * exact shapes each generation's parser expects - a mock of that is a parser test
 * in disguise, and a wrong body there would fail the poll for a reason that has
 * nothing to do with 503). So the last test puts an HTTP-level reverse proxy in
 * front of the real VC: it relays genuine controller responses, and on demand
 * answers 503 itself WITHOUT forwarding, so the storm costs the controller
 * nothing at all. That is also the S14 cross-cutting half of this cell -
 * quality must degrade honestly during the busy window and heal after it.
 */

import { it, expect, afterEach } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { RobotManager } from '../../src/RobotManager.js';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import { RwsError } from '../../src/types.js';
import {
  cell, expectRwsError, until, assertQualityHonest, type AnyClient,
} from '../helpers/structuralHarness.js';
import {
  TEST_USER, TEST_PASS, type Generation, type LiveController,
} from '../helpers/liveControllers.js';

/**
 * One request as the server saw it.
 *
 * `at` is the ARRIVAL time, never the completion time: the property under test is
 * "the client never sent 20 requests in a second", and timing a relayed request
 * by when its response finished would fold controller latency into the reading -
 * a slow first response followed by fast ones bunches the completions and reads
 * as a burst the client never produced (and, the other way round, spreads a real
 * burst out). It is monotonic (performance.now()) because the rate assertions do
 * interval arithmetic and Date.now() can step.
 */
interface ServerRequest { method: string; url: string; status: number; at: number }

// ─── Mock controller ─────────────────────────────────────────────────────────

interface BusyMock {
  port: number;
  requests: ServerRequest[];
  /** Answer 503 to every authenticated request until turned off again. */
  setBusy(on: boolean): void;
  /** Answer 503 to the next `n` authenticated requests, then serve normally. */
  busyFor(n: number): void;
  close(): Promise<void>;
}

/**
 * The smallest server each generation's client will connect to and read state
 * from, plus a switch that makes it answer 503.
 *
 * The 503 body is deliberately EMPTY. Two reasons, both load-bearing:
 *   - a body carrying a controller status block would be classified by
 *     ControllerError.ts on its own code (a 503 with -1073445862 is correctly
 *     MASTERSHIP_REQUIRED, not CONTROLLER_BUSY), and this cell is about the
 *     status-driven path;
 *   - RWS 1.0 throws on 503 without reading the body, and an unread fetch body
 *     pins its undici socket until GC - a zero-length body completes at once, so
 *     the storm stays on one connection and the request counts stay readable.
 */
async function startBusyMock(generation: Generation): Promise<BusyMock> {
  const requests: ServerRequest[] = [];
  let busyForever = false;
  let busyBudget = 0;

  // RWS 1.0 is Digest, RWS 2.0 is Basic. HttpSession refuses a challenge that is
  // missing realm or nonce, so the string has to be well formed even though the
  // mock never verifies the response hash.
  const challenge = generation === 'rws1'
    ? 'Digest realm="ABB Robotics", nonce="7c2e5b1a9d3f4068", qop="auth", algorithm=MD5'
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
    }
    : {
      // hal+json, and the Content-Type must say so: RwsClient2 re-issues a GET as
      // XHTML when a hal+json request comes back non-JSON, which would silently
      // double every request count this cell asserts on.
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
    req.resume();   // drain so keep-alive sockets stay usable

    const record = (status: number): void => {
      requests.push({ method, url, status, at: performance.now() });
    };

    // The challenge is served even while busy, and BEFORE the busy check: RWS 1.0
    // cannot authenticate at all until it has the nonce, so a mock that answered
    // 503 to the unauthenticated probe would test the digest handshake instead of
    // backpressure. Every test below connects first anyway, so by the time the
    // storm starts the challenge is cached and this branch is not taken again.
    if (!req.headers['authorization']) {
      record(401);
      res.writeHead(401, {
        'WWW-Authenticate': challenge, 'Content-Type': 'text/plain', 'Content-Length': '0',
      });
      res.end();
      return;
    }

    if (busyForever || busyBudget > 0) {
      if (!busyForever) { busyBudget--; }
      record(503);
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Content-Length': '0' });
      res.end();
      return;
    }

    if (method === 'GET' && path === '/logout') {
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
    res.end('Resource not served by the S10 mock');
  });

  // No 'upgrade' listener: this cell never subscribes, and leaving the default
  // in place means a stray upgrade is refused rather than hanging.
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    requests,
    setBusy: (on: boolean) => { busyForever = on; },
    busyFor: (n: number) => { busyBudget = n; },
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// ─── 503-injecting reverse proxy in front of a live VC ───────────────────────

interface BusyReverseProxy {
  port: number;
  requests: ServerRequest[];
  /** Answer 503 locally, without forwarding anything to the controller. */
  setBusy(on: boolean): void;
  close(): Promise<void>;
}

/**
 * Hop-by-hop headers, plus content-length. The body is buffered and re-sent, so
 * Node recomputes the length; relaying the upstream value (or a chunked
 * transfer-encoding the relay does not reproduce) would desynchronise the
 * framing. content-encoding is NOT stripped - accept-encoding is removed on the
 * way up instead, so nothing comes back compressed in the first place.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'content-length',
]);

/**
 * A plain-HTTP reverse proxy that relays to the real controller and can inject
 * 503s. Unlike the TCP chaos proxy this one speaks HTTP, which is what makes it
 * able to (a) synthesise a status the controller would never be asked for
 * safely, and (b) count and time REQUESTS rather than bytes - the unit both
 * matrix rate properties are written in.
 *
 * It presents plain HTTP to the client even when the controller is TLS
 * (OmniCore), so the client is built with an http:// base URL pointed at
 * 127.0.0.1. That is safe here and only here: the hop is loopback-only, and the
 * TLS leg to the controller is unchanged.
 */
async function startBusyReverseProxy(target: LiveController): Promise<BusyReverseProxy> {
  const requests: ServerRequest[] = [];
  let busy = false;

  const agent = target.tls
    ? new https.Agent({ keepAlive: true, rejectUnauthorized: false })
    : new http.Agent({ keepAlive: true });

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    // Stamped once, here, for every branch below. The relayed branch used to
    // stamp on 'end' of the upstream response, which timed the CONTROLLER rather
    // than the client and made the two branches incomparable - the 503s were
    // arrival-timed and the relayed ones completion-timed, and the sliding
    // window was doing arithmetic across both.
    const at = performance.now();

    if (busy) {
      // Nothing is forwarded: the storm must cost the live controller zero
      // requests, or this test becomes the flood it is asserting against.
      req.resume();
      requests.push({ method, url, status: 503, at });
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Content-Length': '0' });
      res.end();
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers['accept-encoding'];
    delete headers['connection'];
    headers['host'] = `${target.host}:${target.port}`;

    const upOptions: https.RequestOptions = {
      host: target.host, port: target.port, method, path: url, headers, agent,
      // Per-request as well as on the agent: controllers ship self-signed certs.
      ...(target.tls ? { rejectUnauthorized: false } : {}),
    };

    let finished = false;
    // The union of the two module shapes is not callable in TS; RobotManager's
    // probePort casts the same way.
    const upstream = ((target.tls ? https : http) as unknown as typeof https).request(
      upOptions,
      up => {
        const chunks: Buffer[] = [];
        up.on('data', (c: Buffer) => chunks.push(c));
        up.on('end', () => {
          finished = true;
          const out: http.OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(up.headers)) {
            if (HOP_BY_HOP.has(k) || v === undefined) { continue; }
            out[k] = v;
          }
          requests.push({ method, url, status: up.statusCode ?? 0, at });
          if (!res.headersSent) { res.writeHead(up.statusCode ?? 502, out); }
          res.end(Buffer.concat(chunks));
        });
      },
    );

    upstream.on('error', () => {
      finished = true;
      requests.push({ method, url, status: 502, at });
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); }
      res.end();
    });
    // A client that gives up (timeout, disconnect) must not leave a request
    // running against the controller.
    res.on('close', () => { if (!finished) { upstream.destroy(); } });

    req.pipe(upstream);
  });

  // Upgrades are refused rather than relayed. Deliberate: the subscribe() then
  // fails before opening, which WsSubscriber reports by rejecting with no
  // reconnect loop (an initial open failure is terminal - only a previously
  // OPEN stream is retried), so the manager settles on fast polling. That is
  // exactly the path a 503 storm has to be survived on, and it keeps the poll
  // cadence at refreshIntervalMs instead of the 5x subscription cadence.
  server.on('upgrade', (_req, socket) => { socket.destroy(); });
  // The connect path probes HTTPS before HTTP; answering the TLS ClientHello
  // with an HTTP 400 just delays it, so drop those sockets instead.
  server.on('clientError', (_e, socket) => { socket.destroy(); });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    requests,
    setBusy: (on: boolean) => { busy = on; },
    close: () => new Promise<void>(resolve => {
      agent.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Requests one rejected call costs, per generation.
 *
 * RWS 1.0 spends two: HttpSession answers a 503 by sleeping 200 ms and
 * re-issuing the request once (HttpSession.ts, "503 -> wait 200ms and retry
 * once"), and only a second 503 throws. That single retry is the whole of its
 * backoff policy, and it is inside the queue slot, so it also paces everything
 * behind it. RWS 2.0 does not retry at all: `req()` maps 503 straight to the
 * CONTROLLER_BUSY fallback and rejects on the first response.
 */
const REQUESTS_PER_BUSY_CALL: Record<Generation, number> = { rws1: 2, rws2: 1 };

/** The documented controller ceiling. Both clients pace at 55 ms to stay below it. */
const RATE_CEILING_PER_SEC = 20;

/**
 * Highest number of requests contained in any one-second window.
 *
 * Written as a sliding window rather than fixed buckets on purpose: bucketing by
 * wall-clock second lets a burst straddle a boundary and read as two half-rate
 * seconds, which is exactly the shape a client that fires everything at once
 * would produce.
 */
function peakRequestsPerSecond(times: number[]): number {
  const t = [...times].sort((a, b) => a - b);
  let peak = 0;
  let lo = 0;
  for (let hi = 0; hi < t.length; hi++) {
    while (t[hi] - t[lo] >= 1000) { lo++; }
    peak = Math.max(peak, hi - lo + 1);
  }
  return peak;
}

/**
 * Watch a counter until it stops moving, then return its final value.
 *
 * "It backs off rather than hammering" is a claim about what happens AFTER the
 * call has rejected, so a reading taken at the rejection would pass even for a
 * client retrying forever in the background. The only honest form is "the
 * counter goes quiet and stays quiet"; this throws rather than returning if it
 * never does. (Same helper as S06 - the shape of the question is identical.)
 */
async function settledCount(
  count: () => number, quietMs = 1200, timeoutMs = 25000, label = 'request count',
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
function mockClient(generation: Generation, mock: BusyMock): AnyClient {
  if (generation === 'rws1') {
    return new RwsClient({
      host: '127.0.0.1', port: mock.port,
      username: TEST_USER, password: TEST_PASS, timeout: 5000,
    });
  }
  return new RwsClient2(
    `http://127.0.0.1:${mock.port}`, TEST_USER, TEST_PASS, { timeout: 5000 },
  );
}

interface Connectable { connect(): Promise<void>; disconnect(): Promise<void> }
interface StateReadable { getControllerState(): Promise<string> }

// ─── Cell ────────────────────────────────────────────────────────────────────

interface OpenResource {
  client?: AnyClient;
  manager?: RobotManager;
  mock?: BusyMock;
  reverse?: BusyReverseProxy;
}

const open: OpenResource[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> } | undefined)
      ?.disconnect?.().catch(() => undefined);
    await o.mock?.close();
    await o.reverse?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S10-503-storm', generation, ctx => {
    it('a 503 surfaces as a typed CONTROLLER_BUSY at a bounded cost', async () => {
      const mock = await startBusyMock(generation);
      const client = mockClient(generation, mock);
      open.push({ mock, client });

      // Connect while healthy so the digest challenge and session cookie are
      // already cached: the storm below then costs exactly what the busy path
      // costs, with no handshake mixed in.
      await (client as unknown as Connectable).connect();
      await expect((client as unknown as StateReadable).getControllerState())
        .resolves.toBe('motoroff');

      mock.setBusy(true);
      const mark = mock.requests.length;

      const err = await expectRwsError(
        () => (client as unknown as StateReadable).getControllerState(),
      );
      // CONTROLLER_BUSY specifically, not the RATE_LIMITED a 429 earns nor a
      // bare UNKNOWN: a consumer branches on this to back off and retry later
      // rather than to re-prompt, re-authenticate or give up.
      expect(err.code).toBe('CONTROLLER_BUSY');
      expect(err.httpStatus).toBe(503);

      const spent = mock.requests.slice(mark);
      expect(spent.length, 'requests spent on a single 503-rejected call')
        .toBe(REQUESTS_PER_BUSY_CALL[generation]);
      expect(spent.every(r => r.status === 503)).toBe(true);

      if (generation === 'rws1') {
        // The retry is the entire backoff policy, so it has to actually wait.
        // A retry that fired immediately would double the request rate under a
        // storm without improving the odds of the second attempt succeeding.
        expect(spent[1].at - spent[0].at,
          'the RWS 1.0 503 retry did not wait its documented 200 ms')
          .toBeGreaterThanOrEqual(190);
      }

      // Nothing may keep asking once the call has rejected. Backing off means
      // waiting for the CALLER, not scheduling private retries. settledCount
      // throws if the counter never goes quiet; comparing its final value to the
      // documented cost is the second half - a background retry that fired once
      // and stopped would settle, but not at the right number.
      const settled = await settledCount(() => mock.requests.length);
      expect(settled - mark, 'requests kept arriving after the 503 rejection')
        .toBe(REQUESTS_PER_BUSY_CALL[generation]);

      await expect((client as unknown as Connectable).disconnect()).resolves.toBeUndefined();
    }, 60000);

    it('a sustained 503 storm never puts 20 requests in any one second', async () => {
      const mock = await startBusyMock(generation);
      const client = mockClient(generation, mock);
      open.push({ mock, client });

      await (client as unknown as Connectable).connect();
      mock.setBusy(true);
      const mark = mock.requests.length;

      // Concurrent, not sequential: a client whose pacing is a per-call sleep
      // rather than a real queue passes the sequential form trivially and fails
      // this one. (RwsClient2's pacing was exactly that bug once - five reads
      // went out in 81 ms; see takeRequestSlot's comment.)
      const CALLS = 24;
      const results = await Promise.allSettled(
        Array.from({ length: CALLS },
          () => (client as unknown as StateReadable).getControllerState()),
      );

      expect(results.every(r => r.status === 'rejected'),
        'a call succeeded while the server answered 503 to everything').toBe(true);
      for (const [i, r] of results.entries()) {
        const reason = (r as PromiseRejectedResult).reason;
        expect(reason, `call ${i + 1} did not throw an RwsError`).toBeInstanceOf(RwsError);
        expect((reason as RwsError).code, `call ${i + 1} lost its typing`).toBe('CONTROLLER_BUSY');
      }

      const storm = mock.requests.slice(mark);
      // No hidden amplification: the storm costs exactly the documented retry
      // per call and not one request more.
      expect(storm.length, 'the storm cost more requests than the retry policy allows')
        .toBe(CALLS * REQUESTS_PER_BUSY_CALL[generation]);
      expect(storm.every(r => r.status === 503)).toBe(true);

      const peak = peakRequestsPerSecond(storm.map(r => r.at));
      expect(peak, `peaked at ${peak} requests in one second against a ${RATE_CEILING_PER_SEC}/s ceiling`)
        .toBeLessThan(RATE_CEILING_PER_SEC);

      // As in the first test: the counter must go quiet (settledCount throws
      // otherwise) AND stop at exactly the storm's documented cost, so a
      // background retry that fires a handful of times then gives up is caught
      // rather than mistaken for a clean settle.
      const settled = await settledCount(() => mock.requests.length);
      expect(settled - mark, 'requests kept arriving after the storm rejected')
        .toBe(CALLS * REQUESTS_PER_BUSY_CALL[generation]);
    }, 90000);

    it('the first call after recovery succeeds - the queue is not poisoned', async () => {
      const mock = await startBusyMock(generation);
      const client = mockClient(generation, mock);
      open.push({ mock, client });

      await (client as unknown as Connectable).connect();

      mock.setBusy(true);
      for (let i = 0; i < 4; i++) {
        const err = await expectRwsError(
          () => (client as unknown as StateReadable).getControllerState(),
        );
        expect(err.code, `storm call ${i + 1} lost its typing`).toBe('CONTROLLER_BUSY');
      }

      mock.setBusy(false);

      // The FIRST call after recovery, not "a call eventually". A client that
      // needed a settling period, or that had marked the connection bad, would
      // fail here - and that is the starvation this property forbids.
      await expect((client as unknown as StateReadable).getControllerState())
        .resolves.toBe('motoroff');

      // …and it stays healthy: a storm must leave no residue in the queue.
      for (let i = 0; i < 4; i++) {
        await expect((client as unknown as StateReadable).getControllerState())
          .resolves.toBe('motoroff');
      }

      await expect((client as unknown as Connectable).disconnect()).resolves.toBeUndefined();
    }, 60000);

    it('calls issued during the storm all settle, and the queue drains in order', async () => {
      const mock = await startBusyMock(generation);
      const client = mockClient(generation, mock);
      open.push({ mock, client });

      await (client as unknown as Connectable).connect();

      // Budgeted rather than timed: "the first three requests are refused" is
      // deterministic under CPU contention, where "busy for 400 ms" is a race
      // against the client's own pacing.
      const REFUSED = 3;
      mock.busyFor(REFUSED);

      const CALLS = 8;
      const results = await Promise.allSettled(
        Array.from({ length: CALLS },
          () => (client as unknown as StateReadable).getControllerState()),
      );

      expect(results.length).toBe(CALLS);
      for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') {
          expect(r.reason, `call ${i + 1} rejected with a non-RwsError`).toBeInstanceOf(RwsError);
          expect((r.reason as RwsError).code, `call ${i + 1} lost its typing`)
            .toBe('CONTROLLER_BUSY');
        } else {
          expect(r.value).toBe('motoroff');
        }
      }

      // Both clients serialise in call order (HttpSession chains its queue,
      // RwsClient2 chains the pacing slot), so which calls the budget hits is
      // determined, not raced: RWS 1.0 spends two requests on its first call and
      // one on the second before the budget runs out mid-call, so only the first
      // rejects; RWS 2.0 spends one per call, so the first three reject.
      const rejected = results.filter(r => r.status === 'rejected').length;
      expect(rejected, 'the busy budget did not land where request accounting says it must')
        .toBe(generation === 'rws1' ? 1 : REFUSED);

      // The anti-starvation property in its sharpest form: the LAST caller - the
      // one furthest back in the queue - is served.
      expect(results[CALLS - 1].status,
        'the last queued call never got served after recovery').toBe('fulfilled');

      await expect((client as unknown as Connectable).disconnect()).resolves.toBeUndefined();
    }, 60000);

    it('a live 503 window degrades quality honestly and heals (S14 cross-cutting)', async () => {
      const controller = await ctx.controller();
      const reverse = await startBusyReverseProxy(controller);
      // Deliberately SLOWER than the 1000 ms default: the busy window has to cost
      // one failed poll, not three. Three consecutive failures auto-disconnect,
      // and the give-up path is S06's cell, not this one - this cell is about
      // SURVIVING a busy window, so the window must close (below) well inside the
      // next poll tick.
      const manager = new RobotManager({ refreshIntervalMs: 1200 });
      open.push({ manager, reverse });

      const transitions: Array<{ quality: string; reason: string }> = [];
      let lastQuality = '';
      manager.onDidChange(() => {
        if (manager.state.quality === lastQuality) { return; }
        lastQuality = manager.state.quality;
        transitions.push({ quality: manager.state.quality, reason: manager.state.qualityReason });
      });

      // useHttps=false: the client's hop is the plain-HTTP reverse proxy even
      // when the controller behind it is TLS.
      await manager.connect('127.0.0.1', TEST_USER, TEST_PASS, reverse.port, false);

      // A steady quality alone is not proof of a healthy poll - it is set right
      // after connect regardless. ctrlstate leaving null is: only a completed
      // fetchAll can put it there.
      await until(
        () => (manager.state.quality === 'live' || manager.state.quality === 'polling')
          && manager.state.ctrlstate !== null,
        40000, 'the manager reaches a steady quality with a poll behind it',
      );
      assertQualityHonest(manager, { notDisconnected: true });
      const mark = reverse.requests.length;

      reverse.setBusy(true);
      await until(() => manager.state.quality === 'stale', 30000,
        'quality degrades once polls start getting 503s');
      // Read before healing: once the proxy recovers the next poll overwrites it.
      const staleReason = manager.state.qualityReason;
      assertQualityHonest(manager, { notLive: true });
      // The fault has to be the one this cell injects. Without this the test
      // would pass just as green if the poll had degraded for an unrelated
      // reason - a timeout, a parse failure, the VC hiccuping - and "503 storm
      // survived" would be a claim about something that never happened.
      const refused = reverse.requests.slice(mark).filter(r => r.status === 503);
      expect(refused.length, 'the busy window served no 503 at all - the fault never landed')
        .toBeGreaterThan(0);
      reverse.setBusy(false);

      expect(staleReason.trim(), 'degraded with no reason at all').not.toBe('');
      expect(staleReason).toMatch(/poll failure/i);

      // Recovery on the real controller: the client re-uses its existing session
      // (no re-auth, no new session slot) and the poll simply works again.
      await until(
        () => manager.state.quality === 'polling' || manager.state.quality === 'live',
        40000, 'quality heals once the controller answers again',
      );
      expect(manager.state.connected).toBe(true);
      assertQualityHonest(manager, { notDisconnected: true });
      expect(manager.state.qualityReason).toMatch(/recovered/i);

      // Every transition explains itself - the S14 property, checked across the
      // whole run rather than only at the end. The length check keeps the loop
      // from being vacuously true: quality moved at least connect -> steady ->
      // stale -> healed above, so an empty log means the transitions were never
      // observed and this loop proved nothing.
      expect(transitions.length, 'no quality transitions were observed at all')
        .toBeGreaterThan(0);
      for (const t of transitions) {
        expect(t.reason.trim(), `quality "${t.quality}" carried no reason`).not.toBe('');
      }

      // The ceiling holds on the live path too. Polling is a burst of parallel
      // reads (fetchAll issues seven at once), so this is the assertion that the
      // 55 ms pacing survives contact with a real poll loop - and the burst is
      // measured through an HTTP-level relay, which the TCP chaos proxy could
      // only have counted in bytes.
      const live = reverse.requests.slice(mark);
      expect(live.length, 'no live requests were observed at all').toBeGreaterThan(0);
      const peak = peakRequestsPerSecond(live.map(r => r.at));
      expect(peak, `live path peaked at ${peak} requests in one second against a ${RATE_CEILING_PER_SEC}/s ceiling`)
        .toBeLessThan(RATE_CEILING_PER_SEC);

      // Clean teardown returns the session slot (GET /logout) - a structural
      // cell that leaks one is the S05 incident in miniature.
      await expect(manager.disconnect()).resolves.toBeUndefined();
    }, 120000);
  });
}
