/**
 * S10 - 503 storm / backpressure.
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
 * The mock half is tests/structural/S10-503-storm.mock.test.ts: it needs no
 * controller and runs in plain `npm test` too; the runner maps both files
 * onto the same cells.
 *
 * WHY THERE IS STILL A LIVE HALF. The mock can prove typing and pacing, but it
 * cannot prove recovery on a real controller, and it cannot exercise the
 * RobotManager poll loop (fetchAll needs a dozen-odd endpoints answering in the
 * exact shapes each generation's parser expects - a mock of that is a parser test
 * in disguise, and a wrong body there would fail the poll for a reason that has
 * nothing to do with 503). So this file's test puts an HTTP-level reverse proxy in
 * front of the real VC: it relays genuine controller responses, and on demand
 * answers 503 itself WITHOUT forwarding, so the storm costs the controller
 * nothing at all. That is also the S14 cross-cutting half of this cell -
 * quality must degrade honestly during the busy window and heal after it.
 */

import { it, expect, afterEach } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { RobotManager } from '../../src/RobotManager.js';
import { cell, until, assertQualityHonest, listenForClient } from '../helpers/structuralHarness.js';
import { TEST_USER, TEST_PASS, type LiveController } from '../helpers/liveControllers.js';
import { peakRequestsPerSecond, type ServerRequest } from '../helpers/faultChecks.js';

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
 * TLS leg to the controller is unchanged. For rws1 under
 * RWS_STRUCTURAL_NODE_HTTP=1 it listens on a port fetch refuses, so the client
 * sends through node:http (listenForClient).
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

  const port = await listenForClient(server, target.generation);

  return {
    port,
    requests,
    setBusy: (on: boolean) => { busy = on; },
    close: () => new Promise<void>(resolve => {
      agent.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The documented controller ceiling. Both clients pace at 100 ms to stay below it. */
const RATE_CEILING_PER_SEC = 20;

// ─── Cell, live half ─────────────────────────────────────────────────────────

interface OpenResource {
  manager?: RobotManager;
  reverse?: BusyReverseProxy;
}

const open: OpenResource[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.manager?.disconnect().catch(() => undefined);
    await o.reverse?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S10-503-storm', generation, ctx => {
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
      // 100 ms pacing survives contact with a real poll loop - and the burst is
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
