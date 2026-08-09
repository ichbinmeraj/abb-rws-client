/**
 * S12 - Malformed / truncated responses.
 *
 * Three properties, per the matrix:
 *   - parsers NEVER throw uncaught (on RWS 2.0: neither the XHTML path nor the
 *     hal+json path, which are two different parsers reached through the same
 *     `RwsClient2.parse()` sniff);
 *   - every failure is a TYPED RwsError in the PARSE_ERROR family - a body the
 *     client cannot read is an error, not a value;
 *   - a body truncated mid-element does not HANG the request: it must settle
 *     within the configured timeout.
 *
 * WHY BOTH A LIVE CONTROLLER AND A MOCK. The chaos proxy is a TCP hop, so
 * everything it corrupts corrupts the HTTP (or TLS) framing too - which proves
 * the transport half but can never reach the parsers with a well-formed
 * envelope. The interesting failure is the opposite one: 200 OK, correct
 * Content-Length, and a payload the parser cannot make sense of. That is what a
 * firmware quirk, a captive portal, or a half-written cache actually looks like,
 * and only a server we control can produce it byte for byte. So the live half
 * carries "a corrupt stream fails typed and the client recovers", and the mock
 * half carries "a broken payload is rejected rather than believed".
 *
 * TWO ASSERTIONS HERE ARE EXPECTED TO FAIL, and are written strict on purpose:
 *
 *   1. RWS 2.0 does not raise PARSE_ERROR for an unreadable body. `HalJsonParser`
 *      swallows a JSON.parse failure into `root = null` (HalJsonParser.ts:32),
 *      `XhtmlParser` simply matches nothing, and every RwsClient2 getter then
 *      coerces the empty field map to a default - `getControllerState()` returns
 *      'init' (RwsClient2.ts:359). 'init' is a REAL controller state, so a
 *      consumer cannot tell a controller that is initialising from a response it
 *      never understood. RWS 1.0's ResponseParser throws PARSE_ERROR for the
 *      same input, so this is a difference between the generations, not a
 *      deliberate design.
 *
 *   2. RWS 1.0 has no deadline on the response BODY. `HttpSession.rawFetch`
 *      clears the AbortController timer in its `finally` (HttpSession.ts:294),
 *      and `fetch` resolves as soon as the HEADERS arrive - so the
 *      `response.text()` in `execute()` (HttpSession.ts:244) runs with no timer
 *      at all. A server that sends headers, starts the body and stalls leaves the
 *      request pending until undici's 300 s default body-inactivity timeout, two
 *      orders of magnitude past the configured one. RWS 2.0 is not affected:
 *      `req.setTimeout` (RwsClient2.ts:297) is a socket-inactivity deadline that
 *      covers the body as well as the headers.
 */

import { it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import type { RobotManager } from '../../src/RobotManager.js';
import { RwsError } from '../../src/types.js';
import {
  cell, expectRwsError, until, assertQualityHonest, type AnyClient,
} from '../helpers/structuralHarness.js';
import { TEST_USER, TEST_PASS, type Generation } from '../helpers/liveControllers.js';

/** Short on purpose: the anti-hang property is only meaningful against a deadline. */
const TIMEOUT_MS = 4000;
/**
 * How long a truncated request is allowed to take before we call it hung. Three
 * times the configured timeout is slack for CPU contention, not tolerance - the
 * defect this catches overshoots by two orders of magnitude, so the exact
 * multiple never decides the verdict.
 */
const HANG_BUDGET_MS = TIMEOUT_MS * 3;

/** Bytes of a live response allowed through before the proxy cuts it. /rw/system
 *  is multi-kilobyte on both generations, so this always lands mid-document. */
const LIVE_CUT_AFTER_BYTES = 500;

// ─── Broken payloads ─────────────────────────────────────────────────────────

/**
 * Corrupt every Nth character, mirroring the chaos proxy's 'garble' mode.
 * Character-level rather than byte-level: the point is a structurally invalid
 * payload inside INTACT framing, which is exactly what the proxy cannot produce.
 */
function garble(s: string, everyNth = 7): string {
  return [...s].map((c, i) => (i % everyNth === 0 ? 'ÿ' : c)).join('');
}

const XHTML1 = 'application/xhtml+xml;v=1.0';
const XHTML2 = 'application/xhtml+xml;v=2.0';
const HALJSON = 'application/hal+json;v=2.0';

const RWS1_CTRLSTATE =
  '<?xml version="1.0" encoding="utf-8"?>'
  + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ctrlstate</title></head>'
  + '<body><div class="state"><ul>'
  + '<li class="pnl-ctrlstate" title="ctrlstate"><span class="ctrlstate">motoroff</span></li>'
  + '</ul></div></body></html>';

const RWS1_OPMODE =
  '<?xml version="1.0" encoding="utf-8"?>'
  + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>opmode</title></head>'
  + '<body><div class="state"><ul>'
  + '<li class="pnl-opmode" title="opmode"><span class="opmode">AUTO</span></li>'
  + '</ul></div></body></html>';

const RWS2_CTRLSTATE_XHTML =
  '<?xml version="1.0" encoding="utf-8"?>'
  + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ctrl-state</title></head>'
  + '<body><div class="state"><ul>'
  + '<li class="pnl-ctrlstate" title="ctrl-state"><span class="ctrlstate">motoroff</span></li>'
  + '</ul></div></body></html>';

const RWS2_OPMODE_XHTML =
  '<?xml version="1.0" encoding="utf-8"?>'
  + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>opmode</title></head>'
  + '<body><div class="state"><ul>'
  + '<li class="pnl-opmode" title="opmode"><span class="opmode">AUTO</span></li>'
  + '</ul></div></body></html>';

const RWS2_CTRLSTATE_JSON = JSON.stringify({
  _links: { self: { href: '/rw/panel/ctrl-state' } },
  status: { code: 294912 },
  state: [{ _type: 'pnl-ctrlstate', _title: 'ctrl-state', ctrlstate: 'motoroff' }],
});

const RWS2_OPMODE_JSON = JSON.stringify({
  _links: { self: { href: '/rw/panel/opmode' } },
  status: { code: 294912 },
  state: [{ _type: 'pnl-opmode', _title: 'opmode', opmode: 'AUTO' }],
});

interface BrokenCase {
  label: string;
  /** Advertised Content-Type - on RWS 2.0 this decides WHICH parser runs. */
  type: string;
  body: string;
}

/** Cut a document open inside the value of its one interesting element. */
function cutMidElement(doc: string, marker = 'motoroff'): string {
  return doc.slice(0, doc.indexOf(marker) + 4);
}

/**
 * Every case is served with a correct status line and Content-Length: the
 * transport is blameless, only the payload is broken. All of them are asked the
 * same question - "what is the controller state?" - and none of them can answer
 * it, so the only honest reply is a typed PARSE_ERROR.
 */
const BROKEN_CASES: Record<Generation, BrokenCase[]> = {
  rws1: [
    { label: 'XHTML truncated inside <span class="ctrlstate">', type: XHTML1, body: cutMidElement(RWS1_CTRLSTATE) },
    { label: 'XHTML with every 7th character corrupted', type: XHTML1, body: garble(RWS1_CTRLSTATE) },
    { label: 'empty body', type: XHTML1, body: '' },
    { label: 'well-formed XHTML carrying an impossible state value', type: XHTML1, body: RWS1_CTRLSTATE.replace('motoroff', 'wibble') },
    { label: 'a different resource (opmode served where ctrlstate was asked)', type: XHTML1, body: RWS1_OPMODE },
    { label: 'an HTML error page returned with a 200 status', type: 'text/html', body: '<html><body><h1>500 Internal Server Error</h1></body></html>' },
  ],
  rws2: [
    // hal+json path - HalJsonParser. Content-Type says JSON, so RwsClient2 does
    // not fall back to XHTML and exactly one request is spent per call.
    { label: 'hal+json truncated mid-object', type: HALJSON, body: cutMidElement(RWS2_CTRLSTATE_JSON) },
    { label: 'hal+json with every 7th character corrupted', type: HALJSON, body: garble(RWS2_CTRLSTATE_JSON) },
    { label: 'hal+json empty body', type: HALJSON, body: '' },
    { label: 'hal+json valid but carrying no resources', type: HALJSON, body: '{"_links":{},"status":{"code":294912},"state":[]}' },
    { label: 'hal+json valid but wrongly typed throughout', type: HALJSON, body: '{"state":"not-an-array","status":42}' },
    { label: 'hal+json for a different resource (opmode for ctrl-state)', type: HALJSON, body: RWS2_OPMODE_JSON },
    // XHTML path - XhtmlParser. A non-JSON Content-Type makes RwsClient2 abandon
    // hal+json for the rest of the client's life and re-issue this one request,
    // so each of these costs two requests, not one.
    { label: 'XHTML truncated inside <span class="ctrlstate">', type: XHTML2, body: cutMidElement(RWS2_CTRLSTATE_XHTML) },
    { label: 'XHTML with every 7th character corrupted', type: XHTML2, body: garble(RWS2_CTRLSTATE_XHTML) },
    { label: 'XHTML empty body', type: XHTML2, body: '' },
    { label: 'XHTML for a different resource (opmode for ctrl-state)', type: XHTML2, body: RWS2_OPMODE_XHTML },
  ],
};

/** The stalled payload: headers complete, body starts, body never finishes. */
const STALLED_CASE: Record<Generation, BrokenCase> = {
  rws1: { label: 'XHTML cut inside <span class="ctrlstate">, socket held open', type: XHTML1, body: cutMidElement(RWS1_CTRLSTATE) },
  rws2: { label: 'hal+json cut mid-object, socket held open', type: HALJSON, body: cutMidElement(RWS2_CTRLSTATE_JSON) },
};

// ─── Mock controller serving deliberately broken payloads ────────────────────

interface BrokenServer {
  port: number;
  /** One entry per request answered, in order. */
  requests: Array<{ method: string; url: string }>;
  /** Replace the payload every subsequent GET is answered with. */
  serve(c: BrokenCase, stall?: boolean): void;
  close(): Promise<void>;
}

/**
 * Answers every path with the currently configured payload.
 *
 * It never issues an auth challenge. That is not laziness: the fault under test
 * is the payload, and skipping the handshake keeps the cost of a call at exactly
 * one request (two when RWS 2.0 renegotiates its representation), which the
 * "no endless renegotiation" assertion depends on being able to count.
 */
async function startBrokenServer(initial: BrokenCase): Promise<BrokenServer> {
  const requests: BrokenServer['requests'] = [];
  let current = initial;
  let stalling = false;

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '' });
    req.resume();   // drain, so keep-alive sockets stay usable

    if (stalling) {
      // Promise more than we send, flush what we have, then never end. The
      // socket stays open and healthy - nothing but the client's own deadline
      // can conclude this request.
      res.writeHead(200, {
        'Content-Type': current.type,
        'Content-Length': String(Buffer.byteLength(current.body) + 4096),
      });
      res.write(current.body);
      return;
    }

    res.writeHead(200, {
      'Content-Type': current.type,
      'Content-Length': String(Buffer.byteLength(current.body)),
    });
    res.end(current.body);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    requests,
    serve: (c: BrokenCase, stall = false) => { current = c; stalling = stall; },
    close: () => new Promise<void>(resolve => {
      // Destroying the sockets is what releases any request still waiting on a
      // stalled body; without it the pending fetch outlives the test.
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface Settled { settled: boolean; error?: unknown; value?: unknown; elapsedMs: number }

/**
 * Run `fn` against a wall clock and report whether it finished at all.
 *
 * "Does not hang" cannot be asserted by awaiting the call - a hung call simply
 * consumes the whole test timeout and reports nothing useful. Racing it against
 * a watchdog turns the hang into a named failure with a number attached, and
 * leaves the abandoned promise handled so a late rejection is not mistaken for
 * an uncaught one.
 */
async function settleWithin(fn: () => Promise<unknown>, budgetMs: number): Promise<Settled> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = fn().then(
    value => ({ settled: true, value, elapsedMs: Date.now() - t0 }),
    error => ({ settled: true, error, elapsedMs: Date.now() - t0 }),
  );
  const watchdog = new Promise<Settled>(resolve => {
    timer = setTimeout(() => resolve({ settled: false, elapsedMs: Date.now() - t0 }), budgetMs);
  });
  try { return await Promise.race([call, watchdog]); }
  finally { if (timer) { clearTimeout(timer); } }
}

interface UncaughtWatch { seen: unknown[]; stop(): void }

/**
 * Record anything that escapes to the process.
 *
 * "Parsers never throw uncaught" is a claim about what does NOT happen anywhere,
 * so it cannot be checked by catching around the call - a regex that throws
 * inside a detached promise, or a parser reached from a timer, would never pass
 * through the caller's try block at all.
 */
function watchUncaught(): UncaughtWatch {
  const seen: unknown[] = [];
  const record = (e: unknown): void => { seen.push(e); };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  return {
    seen,
    stop: () => {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
    },
  };
}

async function assertNoUncaught(watch: UncaughtWatch): Promise<void> {
  // unhandledRejection is reported a turn or two later than the rejection, so a
  // reading taken in the same tick would always look clean. This is the one wait
  // in the cell that cannot be a poll: it waits for the ABSENCE of an event, and
  // there is nothing to poll for. Generous rather than tight, because a window
  // that closes early under load turns a real escape into a green.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setTimeout(r, 250));
  const described = watch.seen.map(e =>
    e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));
  expect(described, 'something escaped as an uncaught exception / unhandled rejection').toEqual([]);
}

/** A client of the right generation pointed at the mock (always plain HTTP). */
function mockClient(generation: Generation, port: number): AnyClient {
  if (generation === 'rws1') {
    return new RwsClient({
      host: '127.0.0.1', port,
      username: TEST_USER, password: TEST_PASS, timeout: TIMEOUT_MS,
    });
  }
  return new RwsClient2(
    `http://127.0.0.1:${port}`, TEST_USER, TEST_PASS, { timeout: TIMEOUT_MS },
  );
}

interface Probe {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getControllerState(): Promise<string>;
  getSystemInfo(): Promise<{ name: string; rwVersion: string }>;
}
const probe = (c: AnyClient): Probe => c as unknown as Probe;

/**
 * Vitest gives a hook 10 s by default, and this cell's afterEach can have a
 * manager, several clients, a mock and a proxy to unwind. 5 s is still a real
 * chance for /logout on a healthy connection (sub-second in practice) while
 * leaving the hook room to finish - a hook that times out fails the test for a
 * reason that has nothing to do with the property under test.
 */
const CLEANUP_DEADLINE_MS = 5000;

/**
 * Await `p`, but never longer than `ms`.
 *
 * This cell can leave a request wedged behind a stalled body, and RWS 1.0
 * serialises everything through one queue - so an unbounded `disconnect()` in
 * cleanup would queue behind the wedged request and hang the whole suite.
 * disconnect still gets a real chance first, because /logout is what frees the
 * controller's session slot.
 */
async function withDeadline(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!p) { return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<void>(resolve => { timer = setTimeout(() => resolve(), ms); });
  try { await Promise.race([p.then(() => undefined, () => undefined), guard]); }
  finally { if (timer) { clearTimeout(timer); } }
}

// ─── Cell ────────────────────────────────────────────────────────────────────

interface OpenResource {
  proxy?: ChaosProxy;
  /** An array, not a single client: one test builds a fresh client per payload
   *  case, and every one of them has to be disconnected BEFORE its mock closes. */
  clients?: AnyClient[];
  manager?: RobotManager;
  mock?: BrokenServer;
  watch?: UncaughtWatch;
}

const open: OpenResource[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.watch?.stop();
    // Heal the proxy BEFORE anything tries to talk through it. A test that fails
    // mid-fault never reaches its own setCorruption({kind:'none'}), and /logout
    // is what frees the controller's session slot - disconnecting through a
    // still-corrupt hop would leak a live session on every failed run.
    o.proxy?.setCorruption({ kind: 'none' });
    o.proxy?.refuseNew(false);
    await withDeadline(o.manager?.disconnect(), CLEANUP_DEADLINE_MS);
    for (const client of o.clients ?? []) {
      await withDeadline(
        (client as { disconnect?: () => Promise<void> }).disconnect?.(),
        CLEANUP_DEADLINE_MS,
      );
    }
    await o.mock?.close();
    await o.proxy?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S12-malformed', generation, ctx => {
    it('a broken payload inside valid framing raises a typed PARSE_ERROR instead of a value', async () => {
      const cases = BROKEN_CASES[generation];
      const mock = await startBrokenServer(cases[0]);
      const watch = watchUncaught();
      const clients: AnyClient[] = [];
      open.push({ mock, watch, clients });

      /** Cases that answered with anything other than a typed PARSE_ERROR. */
      const notRejected: string[] = [];

      for (const c of cases) {
        mock.serve(c);
        // A fresh client per case: RWS 2.0 remembers a failed hal+json
        // negotiation for the life of the instance, so a reused client would
        // stop exercising the JSON parser after the first XHTML case.
        const client = mockClient(generation, mock.port);
        clients.push(client);
        const before = mock.requests.length;

        try {
          const value = await probe(client).getControllerState();
          notRejected.push(`${c.label}: resolved ${JSON.stringify(value)}`);
        } catch (e) {
          // A raw throw is the one outcome with no defensible reading, so it
          // fails here and now rather than being collected.
          if (!(e instanceof RwsError)) {
            throw new Error(
              `${c.label}: threw a non-RwsError - `
              + `${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`,
            );
          }
          if (e.code !== 'PARSE_ERROR') {
            notRejected.push(`${c.label}: RwsError ${e.code} ("${e.message}")`);
          }
        }

        // An unreadable body must not send the client round again looking for a
        // representation it likes. One request, or two when RWS 2.0 gives up on
        // hal+json and re-asks as XHTML - never more.
        const spent = mock.requests.length - before;
        // Lower bound first: a call answered from somewhere other than this
        // server (a cache, a memoised field map) would satisfy the ceiling below
        // while never putting the broken payload in front of a parser at all -
        // the assertion above would then be measuring nothing.
        expect(spent, `${c.label}: the broken payload was never actually fetched`)
          .toBeGreaterThanOrEqual(1);
        expect(spent, `${c.label}: renegotiated more than once`).toBeLessThanOrEqual(2);
      }

      // Written strict, and expected to FAIL on rws2: RwsClient2 coerces an
      // unreadable body to a default, so getControllerState() answers 'init' -
      // a real controller state - for every case above. RWS 1.0's ResponseParser
      // throws PARSE_ERROR for the same inputs, which is what makes this a gap
      // rather than a house style.
      expect(notRejected, 'malformed bodies that were believed instead of rejected').toEqual([]);
      await assertNoUncaught(watch);
    }, 60000);

    it('a body truncated mid-element with the socket held open settles within the timeout', async () => {
      const stalled = STALLED_CASE[generation];
      const mock = await startBrokenServer(stalled);
      const client = mockClient(generation, mock.port);
      const watch = watchUncaught();
      open.push({ mock, clients: [client], watch });

      mock.serve(stalled, true);
      const outcome = await settleWithin(() => probe(client).getControllerState(), HANG_BUDGET_MS);

      // Expected to FAIL on rws1: HttpSession clears its AbortController timer as
      // soon as the HEADERS arrive, so the body read has no deadline at all and
      // this request stays pending until undici's 300 s default gives up.
      expect(
        outcome.settled,
        `${stalled.label}: request did not settle within ${HANG_BUDGET_MS} ms `
        + `(configured timeout ${TIMEOUT_MS} ms)`,
      ).toBe(true);
      expect(
        outcome.error,
        `${stalled.label}: a half-delivered body was accepted as a complete response`,
      ).toBeInstanceOf(RwsError);
      // …and it must be an error ABOUT the failure. A stalled body is a dead
      // deadline or an unreadable document; surfacing it as AUTH_FAILED,
      // CONTROLLER_BUSY or UNKNOWN would send a consumer chasing the wrong fault.
      expect(
        ['NETWORK_ERROR', 'PARSE_ERROR'],
        `${stalled.label}: settled after ${outcome.elapsedMs} ms as `
        + `${(outcome.error as RwsError | undefined)?.code}`,
      ).toContain((outcome.error as RwsError).code);
      await assertNoUncaught(watch);
    }, 60000);

    it('a live response cut mid-body is a typed error and the client recovers', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: TIMEOUT_MS });
      const watch = watchUncaught();
      open.push({ proxy, clients: [client], watch });

      const c = probe(client);
      await c.connect();
      // Sanity: the endpoint works before the fault, so the failure below is the
      // fault and not a missing option or a wrong path.
      await expect(c.getSystemInfo()).resolves.toBeTruthy();

      // Truncation is metered PER CONNECTION by the proxy (each pair carries its
      // own byte counter), so an extra idle pair cannot move the cut: whichever
      // pair carries the response is cut after the same number of bytes.
      //
      // This originally demanded exactly one open pair, which was stricter than
      // the mechanism requires and failed on RWS 1.0, where undici legitimately
      // keeps more than one pooled connection after the digest handshake. What
      // must hold is that traffic is flowing at all - a zero here would mean the
      // fault is being injected into nothing, and every assertion below would
      // pass vacuously.
      expect(proxy.stats().connectionsOpen, 'no live proxied connection to cut').toBeGreaterThanOrEqual(1);

      // Cut relative to what has ALREADY flowed, so the knife lands inside the
      // next response rather than before it. Truncating a live keep-alive stream
      // at byte 0 would only re-test S01's dropped connection.
      // On RWS 2.0 the proxy sees TLS records, not the document, so the cut
      // lands mid-record rather than mid-element - the byte-exact mid-element
      // case is the mock's job, and this one is about the transport half.
      // `afterBytes` is measured from the moment corruption is armed, per
      // connection, so this cuts the NEXT response after N bytes regardless of
      // which pooled socket carries it. (It used to be derived from the proxy's
      // GLOBAL byte counter, which only coincided with the per-connection
      // counter while exactly one pair existed.)
      proxy.setCorruption({ kind: 'truncate-and-drop', afterBytes: LIVE_CUT_AFTER_BYTES });

      const err = await expectRwsError(() => c.getSystemInfo());
      // Either reading is honest - the body could not be parsed, or the
      // transport died under it. Nothing else is: a truncated document is not a
      // busy controller, a missing resource, or a permissions problem.
      expect(
        ['PARSE_ERROR', 'NETWORK_ERROR'],
        `a truncated body surfaced as ${err.code}: ${err.message}`,
      ).toContain(err.code);

      proxy.setCorruption({ kind: 'none' });
      await until(async () => {
        try { await c.getSystemInfo(); return true; } catch { return false; }
      }, 25000, 'client recovers once the stream is clean again');

      await assertNoUncaught(watch);
    }, 60000);

    it('garbled bytes from the live controller fail typed, never uncaught', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: TIMEOUT_MS });
      const watch = watchUncaught();
      open.push({ proxy, clients: [client], watch });

      const c = probe(client);
      await c.connect();
      await expect(c.getControllerState()).resolves.toBeTruthy();

      // Every 7th byte replaced. On RWS 1.0 that mangles the status line and
      // headers as well as the body; on RWS 2.0 it corrupts TLS records. Both
      // are the same question for this cell: does the damage arrive as a typed
      // error, or does it escape as a raw socket/parser throw?
      proxy.setCorruption({ kind: 'garble', everyNthByte: 7 });

      const outcome = await settleWithin(() => c.getControllerState(), HANG_BUDGET_MS);
      expect(outcome.settled, `a garbled response did not settle within ${HANG_BUDGET_MS} ms`).toBe(true);
      // A garbled document must never be READ. On RWS 1.0 a corrupted
      // <span class="ctrlstate"> value is rejected by parseControllerState; on
      // RWS 2.0 it would have to survive TLS first, so a resolved value here
      // means something accepted bytes it could not verify.
      expect(
        outcome.error,
        `a garbled response resolved with ${JSON.stringify(outcome.value)}`,
      ).toBeInstanceOf(RwsError);
      expect(
        ['PARSE_ERROR', 'NETWORK_ERROR'],
        `garbled bytes surfaced as ${(outcome.error as RwsError | undefined)?.code}`,
      ).toContain((outcome.error as RwsError).code);

      proxy.setCorruption({ kind: 'none' });
      await until(async () => {
        try { await c.getControllerState(); return true; } catch { return false; }
      }, 25000, 'client recovers once the stream is clean again');

      await assertNoUncaught(watch);
    }, 60000);

    it('quality stops claiming "live" while the stream is corrupt (S14 cross-cutting)', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 400 });
      const watch = watchUncaught();
      open.push({ proxy, manager, watch });

      await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
        25000, 'manager reaches a steady quality');
      // Requests are succeeding at this point, so claiming disconnected would be
      // the other half of the S14 lie.
      assertQualityHonest(manager, { notDisconnected: true });
      const steady = manager.state.quality;

      proxy.setCorruption({ kind: 'garble', everyNthByte: 7 });

      // Polls now return damage. Asserting "no longer live" alone would be
      // vacuous when the WebSocket never came up and the steady state was
      // already 'polling' - the claim has to be that quality DEGRADES.
      await until(
        () => manager.state.quality === 'stale' || manager.state.quality === 'disconnected',
        30000, `quality degrades from "${steady}" once every poll is corrupt`,
      );
      assertQualityHonest(manager, { notLive: true });

      proxy.setCorruption({ kind: 'none' });
      await assertNoUncaught(watch);
    }, 60000);
  });
}
