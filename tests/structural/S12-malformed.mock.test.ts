/**
 * S12 - Malformed / truncated responses: the half against a mock controller.
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
 * TWO ASSERTIONS HERE FAILED when the cell was written, and are written strict
 * on purpose. Both were fixed on 2026-08-09; the file and line references
 * below are to the code as it was then:
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
 *      Fixed 2026-08-09: RWS 2.0 raises PARSE_ERROR for a body it cannot read.
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
 *
 *      Fixed 2026-08-09: one timer covers the body as well. On both RWS 1.0
 *      transports, fetch and node:http (on a port fetch refuses), the same
 *      timer runs until the last body byte (HttpSession.rawFetch).
 *
 * These two tests need no controller, so they run in plain `npm test` as
 * well as in `npm run structural`, where the runner maps them onto the
 * S12-malformed cells by their describe title (`<cell-id>/<generation>`) and
 * by this file's name: a failure here fails the cell, and a pass here alone
 * never makes it verified (scripts/structural.mjs). The live half, a corrupt
 * stream from a real controller, is tests/structural/S12-malformed.test.ts.
 * Until 1.5.1 both halves sat behind RWS_STRUCTURAL=1 and a live discovery,
 * so these never ran in `npm test`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import { RwsError } from '../../src/types.js';
import type { AnyClient } from '../helpers/structuralHarness.js';
import { TEST_USER, TEST_PASS, type Generation } from '../helpers/liveControllers.js';
import {
  settleWithin, watchUncaught, assertNoUncaught, withDeadline, type UncaughtWatch,
} from '../helpers/faultChecks.js';
import { listenOnPort } from '../helpers/scriptedHttp.js';

/** Short on purpose: the anti-hang property is only meaningful against a deadline. */
const TIMEOUT_MS = 4000;
/**
 * How long a truncated request is allowed to take before we call it hung. Three
 * times the configured timeout is slack for CPU contention, not tolerance - the
 * defect this catches overshoots by two orders of magnitude, so the exact
 * multiple never decides the verdict.
 */
const HANG_BUDGET_MS = TIMEOUT_MS * 3;

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

  // A free port fetch accepts: on a refused one the RWS 1.0 client would send
  // through node:http without a word (listenOnPort).
  const port = await listenOnPort(server);

  return {
    port,
    requests,
    serve: (c: BrokenCase, stall = false) => { current = c; stalling = stall; },
    close: () => new Promise<void>(resolve => {
      // Destroying the sockets is what releases any request still waiting on a
      // stalled body; without it the pending request outlives the test.
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Cell, mock half ─────────────────────────────────────────────────────────

interface OpenResource {
  /** An array, not a single client: one test builds a fresh client per payload
   *  case, and every one of them has to be disconnected BEFORE its mock closes. */
  clients?: AnyClient[];
  mock?: BrokenServer;
  watch?: UncaughtWatch;
}

const open: OpenResource[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.watch?.stop();
    for (const client of o.clients ?? []) {
      await withDeadline(
        (client as { disconnect?: () => Promise<void> }).disconnect?.(),
        CLEANUP_DEADLINE_MS,
      );
    }
    await o.mock?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  describe(`S12-malformed/${generation}`, () => {
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

      // Written strict, and failed on rws2 until 2026-08-09: RwsClient2 coerced
      // an unreadable body to a default, so getControllerState() answered
      // 'init' - a real controller state - for every case above, where RWS
      // 1.0's ResponseParser threw PARSE_ERROR for the same inputs.
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

      // Failed on rws1 until 2026-08-09: HttpSession cleared its timer as soon
      // as the HEADERS arrived, so the body read had no deadline at all and
      // this request stayed pending until undici's 300 s default gave up. Its
      // one timer now runs until the last body byte (see the header).
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
  });
}
