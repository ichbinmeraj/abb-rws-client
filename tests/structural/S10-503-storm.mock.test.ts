/**
 * S10 - 503 storm / backpressure: the half against a mock controller.
 *
 * A controller that answers 503 is saying "I am overloaded, stop". The failure
 * mode this cell exists to prevent is a client that reads "temporarily
 * unavailable" as "try again immediately" and turns a transient busy window
 * into a self-sustaining request flood. The controller's
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
 * These tests need no controller, so they run in plain `npm test` as well
 * as in `npm run structural`, where the runner maps them onto the
 * S10-503-storm cells by their describe title (`<cell-id>/<generation>`)
 * and by this file's name: a failure here fails the cell, and a pass here
 * alone never makes it verified (scripts/structural.mjs). The live half,
 * quality through a busy window on a real controller, is
 * tests/structural/S10-503-storm.test.ts. Until 1.5.1 both halves sat behind
 * RWS_STRUCTURAL=1 and a live discovery, so these never ran in `npm test`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import { RwsError } from '../../src/types.js';
import { expectRwsError, type AnyClient } from '../helpers/structuralHarness.js';
import { TEST_USER, TEST_PASS, type Generation } from '../helpers/liveControllers.js';
import { peakRequestsPerSecond, settledCount, type ServerRequest } from '../helpers/faultChecks.js';
import { listenOnPort } from '../helpers/scriptedHttp.js';

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
 *   - a zero-length body completes at once, so the storm stays on one
 *     connection and the request counts stay readable. (An unread fetch body
 *     pins its undici socket until GC, and RWS 1.0 once threw on 503 without
 *     reading the body; HttpSession now reads every body whole, through fetch
 *     and node:http alike.)
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
    // On RWS 2.0 the session cookie this mock issued authenticates a request
    // on its own, as on an OmniCore: a client may send it without the
    // credentials.
    const session = generation === 'rws2'
      && String(req.headers['cookie'] ?? '').includes('-http-session-=mock-session');
    if (!req.headers['authorization'] && !session) {
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
  // A free port fetch accepts: on a refused one the RWS 1.0 client would send
  // through node:http without a word (listenOnPort).
  const port = await listenOnPort(server);

  return {
    port,
    requests,
    setBusy: (on: boolean) => { busyForever = on; },
    busyFor: (n: number) => { busyBudget = n; },
    close: () => new Promise<void>(resolve => {
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

/** The documented controller ceiling. Both clients pace at 100 ms to stay below it. */
const RATE_CEILING_PER_SEC = 20;

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

// ─── Cell, mock half ─────────────────────────────────────────────────────────

interface OpenResource {
  client?: AnyClient;
  mock?: BusyMock;
}

const open: OpenResource[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await (o.client as { disconnect?: () => Promise<void> } | undefined)
      ?.disconnect?.().catch(() => undefined);
    await o.mock?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  describe(`S10-503-storm/${generation}`, () => {
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
  });
}
