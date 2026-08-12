/**
 * S11 - Subscription event flood.
 *
 * A busy cell (a running program, a chatty I/O board, an elog burst) can push
 * events at a subscriber far faster than the consumer can absorb them. Three
 * things must hold, and each fails differently:
 *
 *   - events are delivered IN ORDER - a subscriber that batched, deferred or
 *     parallelised dispatch would hand the consumer a re-ordered world, which
 *     for a state stream means the last value written is not the current one;
 *   - nothing is dropped SILENTLY - either every event arrives, or the consumer
 *     is told there is a gap (that is what onRestored is for: "you were away,
 *     resync"). A stream that quietly skips events is worse than a stream that
 *     dies, because the consumer keeps trusting it;
 *   - nothing buffers WITHOUT BOUND while the consumer is slow.
 *
 * Why a mock server rather than the live VC. The flood has to be generated, and
 * the only source of events on a controller is real controller activity -
 * toggling I/O in a tight loop is disruptive, rate-limited (<20 req/s), and
 * would produce a few hundred events at best. So this cell drives both
 * subscribers with a local WebSocket server that speaks the exact frame shape
 * each parser expects and can be told to blast. Nothing here touches a VC or
 * consumes a controller session; that is deliberate, not an omission.
 *
 * The two generations are driven through their real code paths:
 *   - RWS 1.0: WsSubscriber, with a stand-in HttpSession for the two
 *     registration legs it needs (POST /subscription, DELETE /subscription/{id})
 *     - the same fake shape tests/WsSubscriber.test.ts uses. The flood itself is
 *     a real WebSocket carrying real frames through the real parser.
 *   - RWS 2.0: RwsClient2.subscribe against a real HTTP+WS server implementing
 *     the 201 + Location + rel="group" contract.
 *
 * Known limit of an in-process mock: the server and the client share one event
 * loop, so a genuinely slow consumer cannot exert cross-process TCP
 * backpressure on the producer. What that costs is precision on the "how big
 * does the OS/ws receive queue get" question; what it does NOT cost is the
 * claim actually being asserted here, which is about the CLIENT's own
 * accounting - that it retains nothing per event, allocates no handle per
 * event, and never re-orders or swallows one while the consumer is behind. The
 * flood driver yields to the loop after every frame precisely so the reader
 * gets to run; without that the only queue that grows is the test's own.
 */

import { it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket as ServerWebSocket } from 'ws';
import { RwsClient2 } from '../../src/RwsClient2.js';
import { WsSubscriber } from '../../src/WsSubscriber.js';
import type { HttpSession } from '../../src/HttpSession.js';
import type { SubscriptionEvent, SubscriptionResource } from '../../src/types.js';
import { cell, until } from '../helpers/structuralHarness.js';
import { snapshot, compare, type ResourceSnapshot } from '../helpers/leakProbe.js';

// ─── Tuning ──────────────────────────────────────────────────────────────────

/**
 * Events per phase in the order/no-loss flood. Two phases run: one frame per
 * event (maximum frame pressure) and one with many events coalesced into a
 * single frame - a real controller does both, and a parser that handles one
 * shape can still lose events in the other.
 */
const ORDER_BURST = 3000;
const COALESCED_PER_FRAME = 20;

/** Events in the slow-consumer flood, and how much padding each carries. */
const SLOW_BURST = 8000;
const SLOW_PER_FRAME = 8;
/** ~1 KB of filler per event => ~9 MB across the wire for one flood. */
const SLOW_PAD_BYTES = 1024;
/**
 * How long the consumer sits on a batch before releasing it.
 *
 * It has to be long enough that the backlog spans SEVERAL frames even on a
 * loaded machine. A whole frame is dispatched synchronously by the handler, so
 * ANY delay leaves SLOW_PER_FRAME events outstanding - a control asserting only
 * "more than one outstanding" would therefore hold against a consumer that never
 * actually fell behind, and the test would silently become the fast-consumer
 * test again. The producer is not gated on this delay (the drain is one shared
 * timer), so a longer value costs the run one drain cycle at the end, not
 * throughput.
 */
const SLOW_HANDLER_MS = 25;

/**
 * The matrix's "no unbounded buffering", asserted where it is actually
 * observable in-process: events the server has put on the wire that have not yet
 * reached the handler. A client that queued frames and drained them later - the
 * exact failure this property names - walks this straight up towards SLOW_BURST,
 * while a synchronous dispatch sits in the tens (the flood driver yields to the
 * reader after every frame). The bound is ~100x the observed lag so it fails on
 * architecture, not on scheduling. It cannot separate client-side buffering from
 * the kernel/ws receive queue BELOW the bound; above it, no receive queue
 * explains the gap.
 *
 * This is the sharp form of the property. The heap ceiling below is NOT: the
 * parser keeps only the leading span, so retaining every event outright would
 * cost a couple of MB and sail under any heap bound this flood can carry.
 */
const MAX_UNDELIVERED_EVENTS = SLOW_BURST / 4;

/** Phases of the gap test: delivered, missed while down, delivered again. */
const GAP_PREFIX = 800;
const GAP_MISSED = 200;
const GAP_SUFFIX = 800;

/** Events delivered before the stream is made permanently unrecoverable. */
const TERMINAL_BURST = 300;

/**
 * Ceiling on peak heap growth across a flood. Deliberately generous and
 * deliberately NOT the load-bearing assertion: `npm run structural` does not
 * pass --expose-gc, so heapUsed still holds collectible garbage and a tight
 * bound would fail on GC scheduling rather than on retention (leakProbe says as
 * much, and S08 documents the same limit). It is a bound against gross
 * retention; the sharp claims are MAX_UNDELIVERED_EVENTS above and the handle
 * counts below, neither of which depends on when V8 decides to collect.
 */
const FLOOD_HEAP_CEILING_BYTES = 64 * 1024 * 1024;

/**
 * Handles allowed to appear across a flood. Zero would be the honest number for
 * a per-event leak - anything allocated per event lands in the thousands here -
 * but a socket in TIME_WAIT or a runner timer is not a leak, so the bar is a
 * small constant that flood size cannot hide under.
 */
const HANDLE_TOLERANCE = 2;

/**
 * Heartbeats are S02's cell. Here they only need to stay out of the way, so the
 * interval is set beyond any flood's duration ON A LOADED MACHINE - a ping
 * firing mid-flood would add liveness bookkeeping this cell would then have to
 * explain. Two minutes clears the longest flood here by an order of magnitude.
 */
const QUIET_PING_MS = 120000;

/** 'speedratio' maps on both generations and is read-only. */
const RESOURCES: SubscriptionResource[] = ['speedratio'];
/** The href the mock puts in every event; both parsers key off it. */
const EVENT_HREF = '/rw/panel/speedratio';

/** ws readyState OPEN. */
const WS_OPEN = 1;

/**
 * Bytes the mock may leave queued on its own socket before it waits. Without
 * this the producer runs away and the thing filling up is the TEST's outbound
 * buffer, which proves nothing about the client.
 */
const SERVER_HIGH_WATER_BYTES = 1 << 20;

// ─── Mock subscription server ────────────────────────────────────────────────

interface FloodServer {
  port: number;
  /**
   * The newest socket still OPEN, or null while the stream is down.
   *
   * Never index into the socket list. The server registers a socket the moment
   * it accepts the upgrade, but the client can still abandon that connection
   * afterwards (its own open timeout expiring is enough), leaving the server
   * holding a corpse - blasting at `sockets[0]` then waiting for the handler is
   * waiting on something nothing is reading. The lesson is
   * tests/RwsClient2.subscriptions.test.ts's, learned the expensive way.
   */
  live(): ServerWebSocket | null;
  /** Sequence number the next emitted event will carry. */
  nextSeq(): number;
  /** Blast `count` events at the live socket, yielding to the reader as it goes. */
  blast(count: number, opts?: { perFrame?: number; padBytes?: number; onFrame?: () => void }): Promise<void>;
  /** Advance the sequence WITHOUT sending - the events missed while down. */
  skip(count: number): void;
  /** Total POST /subscription registrations served. */
  posts(): number;
  /** Stop listening and destroy everything. Safe to call twice. */
  close(): Promise<void>;
}

/** Cache pad strings - a fresh `'x'.repeat(1024)` per frame is the test allocating, not the client. */
const padCache = new Map<number, string>();
function padding(bytes: number): string {
  if (bytes <= 0) { return ''; }
  let p = padCache.get(bytes);
  if (p === undefined) { p = `<!--${'x'.repeat(bytes)}-->`; padCache.set(bytes, p); }
  return p;
}

/**
 * One frame carrying `n` consecutive events starting at `from`.
 *
 * The shape satisfies both parsers: each `<li>` holds an `<a href>` (RWS 1.0
 * reports it raw as the resource, RWS 2.0 maps it to 'speedratio') and a first
 * `<span>` holding the value. Both take the FIRST span in the block, so the
 * sequence number must lead; the padding rides in an HTML comment after it,
 * which neither parser's regexes can see.
 */
function eventFrame(from: number, n: number, padBytes: number): string {
  const pad = padding(padBytes);
  let lis = '';
  for (let i = 0; i < n; i++) {
    lis += '<li class="pnl-speedratio-ev">'
      + `<a href="${EVENT_HREF}" rel="self"></a>`
      + `<span class="lvalue">${from + i}</span>${pad}</li>`;
  }
  return `<html><body><div class="bind-data"><ul>${lis}</ul></div></body></html>`;
}

async function startFloodServer(): Promise<FloodServer> {
  const sockets: ServerWebSocket[] = [];
  const rawSockets = new Set<Socket>();
  let port = 0;
  let groupId = 0;
  let postCount = 0;
  let seq = 0;
  let closed = false;

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/subscription') {
        postCount++;
        groupId++;
        res.writeHead(201, {
          // Absolute ws:// Location carrying the server's own authority - the
          // live shape both clients re-anchor onto their configured host:port.
          Location: `ws://127.0.0.1:${port}/poll/${groupId}`,
          'Set-Cookie': 'ABBCX=flood-cx; path=/',
          'Content-Type': 'application/xhtml+xml;v=2.0',
        });
        res.end(
          `<html><body><div class="state"><a href="subscription/${groupId}" rel="group"></a>`
          + `<a href="ws://127.0.0.1:${port}/poll/${groupId}" rel="self"></a></div></body></html>`,
        );
        return;
      }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      res.writeHead(404); res.end();
    });
  });

  // Keep-alive agents (RwsClient2 uses them) would keep server.close() pending
  // forever, so every connection is tracked and destroyed explicitly.
  server.on('connection', s => {
    rawSockets.add(s);
    s.on('close', () => rawSockets.delete(s));
  });

  const wss = new WebSocketServer({
    server,
    // Echo whichever subprotocol was offered: RWS 1.0 offers
    // robapi2_subscription, RWS 2.0 rws_subscription. Which one is asserted
    // elsewhere; here the handshake just has to succeed for both.
    handleProtocols: protocols => [...protocols][0] ?? false,
  });
  wss.on('connection', ws => {
    sockets.push(ws);
    // RWS 2.0's heartbeat is an app-level text frame; RWS 1.0's is an RFC6455
    // protocol ping, which ws answers on its own.
    ws.on('message', d => { if (d.toString() === 'PING') { ws.send('PONG'); } });
    ws.on('error', () => undefined);
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;

  const live = (): ServerWebSocket | null => {
    for (let i = sockets.length - 1; i >= 0; i--) {
      if (sockets[i].readyState === WS_OPEN) { return sockets[i]; }
    }
    return null;
  };

  return {
    port,
    live,
    nextSeq: () => seq,
    skip: (count: number) => { seq += count; },
    posts: () => postCount,

    blast: async (count, opts = {}) => {
      const perFrame = opts.perFrame ?? 1;
      const padBytes = opts.padBytes ?? 0;
      let remaining = count;
      while (remaining > 0) {
        const sock = live();
        if (!sock) {
          throw new Error(
            `flood aborted at seq ${seq}: no open socket (${sockets.length} seen, ${count - remaining} of ${count} sent)`,
          );
        }
        const n = Math.min(perFrame, remaining);
        sock.send(eventFrame(seq, n, padBytes));
        seq += n;
        remaining -= n;
        opts.onFrame?.();
        // Yield so the client's socket-read callback gets the loop back. The
        // server and the client share this event loop, so a send loop that
        // never yields starves the reader outright and the flood measures the
        // test's own outbound buffer instead of the client's behaviour.
        await new Promise<void>(r => setImmediate(r));
        while (sock.bufferedAmount > SERVER_HIGH_WATER_BYTES && sock.readyState === WS_OPEN) {
          await new Promise<void>(r => setTimeout(r, 5));
        }
      }
    },

    close: async () => {
      if (closed) { return; }
      closed = true;
      for (const ws of sockets) { ws.terminate(); }
      for (const s of rawSockets) { s.destroy(); }
      rawSockets.clear();
      await new Promise<void>(r => wss.close(() => r()));
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

// ─── Cross-generation subscription ───────────────────────────────────────────

interface Tuning {
  pingIntervalMs: number;
  reconnectBaseMs: number;
  reconnectCapMs: number;
  maxReconnectAttempts: number;
  openTimeoutMs: number;
}

interface Stream {
  stop: () => Promise<void>;
  /** RWS 2.0 only - kept so cleanup can drop its keep-alive agents. */
  client?: RwsClient2;
  /**
   * POST /subscription registrations this stream has made, counted on whichever
   * side actually serves them: the mock HTTP server for RWS 2.0, the stand-in
   * session for RWS 1.0. Counting only the server's would read a permanent 0 on
   * RWS 1.0 - an assertion that cannot fail is worse than no assertion.
   */
  registrations: () => number;
}

/**
 * WsSubscriber reaches the controller through HttpSession for the registration
 * legs only (POST /subscription for the Location, DELETE /subscription/{id} for
 * cleanup); everything this cell measures rides the WebSocket. Standing a fake
 * in for those two legs - the shape tests/WsSubscriber.test.ts already uses -
 * keeps the flood free of digest auth without faking anything on the path under
 * test.
 */
function fakeSession(port: number, onRegister: () => void): HttpSession {
  let group = 0;
  return {
    post: async () => {
      group++;
      onRegister();
      return {
        status: 201,
        body: '',
        headers: new Headers({ location: `ws://127.0.0.1:${port}/poll/${group}` }),
      };
    },
    delete: async () => ({ status: 200, body: '', headers: new Headers() }),
    getCookieHeader: () => 'ABBCX=flood-cx; -http-session-=flood',
  } as unknown as HttpSession;
}

/**
 * The two clients spell the same subscription differently: RWS 1.0 takes one
 * options object carrying the callbacks, RWS 2.0 takes onLost/onRestored
 * positionally and returns a SubscriptionHandle.
 */
async function openFloodStream(
  generation: 'rws1' | 'rws2',
  server: FloodServer,
  handler: (e: SubscriptionEvent) => void,
  hooks: { onLost: () => void; onRestored: () => void },
  tuning: Tuning,
): Promise<Stream> {
  if (generation === 'rws1') {
    let registrations = 0;
    const subscriber = new WsSubscriber(
      fakeSession(server.port, () => { registrations++; }), '127.0.0.1', server.port,
    );
    const stop = await subscriber.subscribe(RESOURCES, handler, { ...tuning, ...hooks });
    return { stop, registrations: () => registrations };
  }
  const client = new RwsClient2(`http://127.0.0.1:${server.port}`, 'u', 'p', { timeout: 4000 });
  const handle = await client.subscribe(
    RESOURCES, handler, hooks.onLost, hooks.onRestored, tuning,
  );
  return { stop: handle, client, registrations: () => server.posts() };
}

// ─── Consumer that cannot keep up ────────────────────────────────────────────

/**
 * A slow consumer whose backlog costs ONE timer no matter how far behind it
 * falls. The obvious spelling - `await sleep(delayMs)` per event - creates a
 * Timeout handle per event, so an 8000-event flood would report 8000 handles that
 * belong to the test, not to the client, and the leak assertion would be
 * measuring itself. Here every outstanding event is released by the same drain
 * tick.
 */
function makeSlowConsumer(delayMs: number): {
  consume: () => void;
  stats: { inFlight: number; maxInFlight: number; completed: number };
  stop: () => void;
} {
  let waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stats = { inFlight: 0, maxInFlight: 0, completed: 0 };

  const drain = (): void => {
    timer = null;
    const batch = waiters;
    waiters = [];
    for (const w of batch) { w(); }
  };

  const work = (): Promise<void> => new Promise<void>(resolve => {
    waiters.push(resolve);
    if (timer === null) { timer = setTimeout(drain, delayMs); }
  });

  return {
    consume: () => {
      stats.inFlight++;
      if (stats.inFlight > stats.maxInFlight) { stats.maxInFlight = stats.inFlight; }
      void work().then(() => { stats.inFlight--; stats.completed++; });
    },
    stats,
    stop: () => { if (timer !== null) { clearTimeout(timer); timer = null; } },
  };
}

// ─── Assertion helpers ───────────────────────────────────────────────────────

/**
 * The strict form of "in order, exactly once, nothing dropped": the delivered
 * values must be exactly `from, from+1, … from+count-1`. Reports the first
 * divergence rather than just a length mismatch, because "3 short" and
 * "re-ordered at 1742" are different bugs.
 */
function assertExactRun(seen: number[], from: number, count: number, label: string): void {
  const firstBad = seen.findIndex((v, i) => v !== from + i);
  expect(
    firstBad,
    `${label}: event #${firstBad} arrived as ${seen[firstBad]}, expected ${from + firstBad} `
    + `(${seen.length} delivered of ${count}; a gap means a silent drop, a repeat means a double dispatch)`,
  ).toBe(-1);
  expect(seen.length, `${label}: delivered ${seen.length} events, flooded ${count}`).toBe(count);
}

/**
 * The matrix's "no unbounded buffering", asserted the way S08 asserts its heap
 * property: heapUsed sampled through the flood must fall at least once. V8
 * scavenges young-generation garbage every few MB and this flood allocates far
 * more than that, so a run in which the heap never once dropped means nothing
 * was ever reclaimed - i.e. the events were still reachable from something.
 */
function assertHeapReclaimed(samples: number[], label: string): void {
  const drops = samples.filter((v, i) => i > 0 && v < samples[i - 1]).length;
  const growth = samples.length ? samples[samples.length - 1] - samples[0] : 0;
  expect(
    drops,
    `${label}: heapUsed rose at every one of ${samples.length} samples during the flood `
    + `(+${(growth / 1048576).toFixed(1)} MB end to end) - nothing was reclaimed, so the events are still held`,
  ).toBeGreaterThan(0);
}

function kinds(before: ResourceSnapshot, after: ResourceSnapshot): string {
  return `before=${JSON.stringify(before.byKind)} after=${JSON.stringify(after.byKind)}`;
}

/**
 * A fixed wait, used ONLY where the expected observation is an ABSENCE (no
 * further events, no second onLost). There is nothing to poll for in that case;
 * every use below states what window it is and why the length suffices.
 */
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ─── Cleanup ─────────────────────────────────────────────────────────────────

interface Open { server?: FloodServer; stream?: Stream; consumer?: { stop: () => void } }

const open: Open[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.consumer?.stop();
    // Stream first: its DELETE still has a server to reach.
    await o.stream?.stop().catch(() => undefined);
    await o.stream?.client?.disconnect().catch(() => undefined);
    await o.server?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S11-event-flood', generation, () => {
    it('every event in a flood reaches the handler exactly once and in order', async () => {
      const server = await startFloodServer();
      const o: Open = { server };
      open.push(o);

      const seen: number[] = [];
      const resources = new Set<string>();
      let lost = 0;
      let restored = 0;
      // Held in a local as well: the registration count is read at the end, and
      // reading it off the cleanup record would depend on narrowing surviving
      // every await in between.
      const stream = await openFloodStream(
        generation, server,
        e => { resources.add(e.resource); seen.push(Number(e.value)); },
        { onLost: () => { lost++; }, onRestored: () => { restored++; } },
        {
          pingIntervalMs: QUIET_PING_MS, reconnectBaseMs: 200, reconnectCapMs: 400,
          maxReconnectAttempts: 1000, openTimeoutMs: 5000,
        },
      );
      o.stream = stream;

      await until(() => server.live() !== null, 20000, 'the mock stream is open');

      // Phase 1: one event per frame - maximum frame pressure.
      await server.blast(ORDER_BURST, { perFrame: 1 });
      // Phase 2: many events coalesced into one frame, which is how a busy
      // controller actually delivers a burst. A parser that handles one shape
      // can still lose events in the other, so both run against one stream and
      // the sequence has to stay continuous ACROSS the change of shape.
      await server.blast(ORDER_BURST, { perFrame: COALESCED_PER_FRAME });

      const total = ORDER_BURST * 2;
      await until(() => seen.length >= total, 90000, 'every flooded event reaches the handler');
      // Window: anything the client had queued would land inside this. Asserting
      // the exact length immediately after the until() would let a duplicate
      // dispatch arrive one tick too late to be caught.
      await settle(500);

      assertExactRun(seen, 0, total, 'flood');
      expect([...resources], 'every event must carry the subscribed resource').toEqual([
        generation === 'rws1' ? EVENT_HREF : 'speedratio',
      ]);
      // Nothing broke, so nothing may have been signalled: a stream that
      // silently reconnected mid-flood would have skipped events, and this is
      // what makes the exact-run assertion above meaningful.
      expect(restored, 'the stream reconnected during an undisturbed flood').toBe(0);
      expect(lost, 'the stream was reported lost during an undisturbed flood').toBe(0);
      expect(
        stream.registrations(),
        'the client registered more than once during an undisturbed flood - it rebuilt the '
        + 'stream behind the consumer\'s back, and the events in the gap are unaccounted for',
      ).toBeLessThanOrEqual(1);
    }, 180000);

    it('a slow consumer loses and re-orders nothing, and the flood costs the client no lasting memory or handles', async () => {
      const server = await startFloodServer();
      const consumer = makeSlowConsumer(SLOW_HANDLER_MS);
      const o: Open = { server, consumer };
      open.push(o);

      const seen: number[] = [];
      let lost = 0;
      let restored = 0;
      o.stream = await openFloodStream(
        generation, server,
        // Order is recorded at handler ENTRY - that is the client's delivery
        // order, which is the property. What the consumer then does with the
        // event (slowly) is the consumer's business, and it deliberately keeps
        // NOTHING: the only thing retained here is a number per event, so any
        // heap growth measured below belongs to the client.
        e => { seen.push(Number(e.value)); consumer.consume(); },
        { onLost: () => { lost++; }, onRestored: () => { restored++; } },
        {
          pingIntervalMs: QUIET_PING_MS, reconnectBaseMs: 200, reconnectCapMs: 400,
          maxReconnectAttempts: 1000, openTimeoutMs: 5000,
        },
      );

      await until(() => server.live() !== null, 20000, 'the mock stream is open');

      const before = snapshot();
      const baseHeap = process.memoryUsage().heapUsed;
      const heapSamples: number[] = [baseHeap];
      let peakHeap = baseHeap;
      let frames = 0;
      let maxUndelivered = 0;

      await server.blast(SLOW_BURST, {
        perFrame: SLOW_PER_FRAME,
        padBytes: SLOW_PAD_BYTES,
        onFrame: () => {
          // Sampled on EVERY frame, unlike the heap: the peak backlog is the
          // whole claim, and a 20-frame stride could step over it.
          const undelivered = server.nextSeq() - seen.length;
          if (undelivered > maxUndelivered) { maxUndelivered = undelivered; }
          frames++;
          if (frames % 20 !== 0) { return; }
          const h = process.memoryUsage().heapUsed;
          heapSamples.push(h);
          if (h > peakHeap) { peakHeap = h; }
        },
      });

      await until(() => seen.length >= SLOW_BURST, 120000,
        'every event survives the slow consumer');
      await until(() => consumer.stats.completed >= SLOW_BURST, 120000,
        'the slow consumer drains its backlog');

      // Control: the consumer must actually have fallen behind BY MORE THAN THE
      // FRAME the handler dispatches synchronously. Anything at or below
      // SLOW_PER_FRAME is what a consumer that kept up perfectly would also
      // report, so a looser bar here would let this become the fast-consumer
      // test wearing a different hat.
      expect(
        consumer.stats.maxInFlight,
        `the "slow" consumer never had more than ${SLOW_PER_FRAME} events outstanding - one `
        + 'frame is dispatched synchronously, so that is the backlog of a consumer that never '
        + 'fell behind at all: the flood did not outrun it',
      ).toBeGreaterThan(SLOW_PER_FRAME);

      assertExactRun(seen, 0, SLOW_BURST, 'slow-consumer flood');
      // No unbounded buffering, in its falsifiable form (see MAX_UNDELIVERED_EVENTS).
      expect(
        maxUndelivered,
        `up to ${maxUndelivered} of ${SLOW_BURST} flooded events were on the wire but not yet `
        + 'delivered while the consumer was behind - dispatch is being queued rather than run '
        + 'as frames arrive, so the backlog is bounded by the flood, not by the client',
      ).toBeLessThanOrEqual(MAX_UNDELIVERED_EVENTS);
      expect(restored, 'the stream reconnected under a slow consumer').toBe(0);
      expect(lost, 'the stream was reported lost under a slow consumer').toBe(0);

      // Let sockets settle and any deferred work finish before the second
      // snapshot; leakProbe's own probe settles for the same reason.
      await settle(1000);
      const after = snapshot();
      const verdict = compare(before, after, {
        tolerancePerKind: HANDLE_TOLERANCE,
        heapGrowthLimitBytes: FLOOD_HEAP_CEILING_BYTES,
      });

      // The sharp claim, and the one that does not depend on GC timing: a client
      // that buffered per event - a queue entry, a pending timer, a socket -
      // lands in the thousands here, not within a tolerance of 2.
      expect(
        verdict.grew,
        `flooding ${SLOW_BURST} events grew active resources - ${kinds(before, after)}`,
      ).toEqual([]);

      assertHeapReclaimed(heapSamples, 'slow-consumer flood');
      expect(
        peakHeap - baseHeap,
        `peak heap grew ${((peakHeap - baseHeap) / 1048576).toFixed(1)} MB while flooding `
        + `${SLOW_BURST} events (~${((SLOW_BURST * SLOW_PAD_BYTES) / 1048576).toFixed(1)} MB on the wire)`,
      ).toBeLessThanOrEqual(FLOOD_HEAP_CEILING_BYTES);
    }, 300000);

    it('events missed while the stream is down are signalled, never silently skipped', async () => {
      const server = await startFloodServer();
      const o: Open = { server };
      open.push(o);

      const seen: number[] = [];
      /** seen.length at the moment each signal fired - where the consumer was told. */
      const signalledAt: number[] = [];
      let lost = 0;
      let restored = 0;

      o.stream = await openFloodStream(
        generation, server,
        e => { seen.push(Number(e.value)); },
        {
          onLost: () => { lost++; signalledAt.push(seen.length); },
          onRestored: () => { restored++; signalledAt.push(seen.length); },
        },
        {
          // Small backoff so the recovery lands inside the test; the budget is
          // far beyond reach so "did it recover?" can never become "did it give
          // up first?" - the give-up path has its own test below.
          pingIntervalMs: QUIET_PING_MS, reconnectBaseMs: 100, reconnectCapMs: 200,
          maxReconnectAttempts: 1000, openTimeoutMs: 5000,
        },
      );

      await until(() => server.live() !== null, 20000, 'the mock stream is open');
      await server.blast(GAP_PREFIX, { perFrame: 1 });
      await until(() => seen.length >= GAP_PREFIX, 60000, 'the pre-drop burst is delivered');
      expect(seen.length, 'extra events arrived before the drop').toBe(GAP_PREFIX);

      // Kill the stream and let the world move on without us. The skipped span
      // is never put on any wire, so it is genuinely missed - which is the only
      // way to ask whether the client admits to a gap or hides one.
      server.live()!.terminate();
      await until(() => server.live() === null, 20000, 'the stream is really down');
      server.skip(GAP_MISSED);

      // Gate on the SIGNAL, not on the socket: both clients attach their message
      // listener before firing onRestored, so blasting the moment a socket
      // appears would race the listener and manufacture a loss the client is
      // not responsible for.
      await until(() => restored >= 1, 60000, 'the client signals the gap (onRestored)');
      await until(() => server.live() !== null, 20000, 'the stream is back');

      await server.blast(GAP_SUFFIX, { perFrame: 1 });
      await until(() => seen.length >= GAP_PREFIX + GAP_SUFFIX, 60000,
        'the post-recovery burst is delivered');
      await settle(500);

      expect(seen.length, 'events were delivered twice across the recovery')
        .toBe(GAP_PREFIX + GAP_SUFFIX);

      // Order survives the break: strictly increasing, start to finish.
      const backwards = seen.findIndex((v, i) => i > 0 && v <= seen[i - 1]);
      expect(
        backwards,
        `event #${backwards} (${seen[backwards]}) did not advance on #${backwards - 1} (${seen[backwards - 1]})`,
      ).toBe(-1);

      // The whole point: there is exactly ONE discontinuity, it is where the
      // events were really missed, and the consumer was told at exactly that
      // point. A gap the consumer was never told about is a silent drop, which
      // is the failure mode this cell exists to rule out.
      const gaps = seen.map((v, i) => (i > 0 && v !== seen[i - 1] + 1 ? i : -1)).filter(i => i >= 0);
      expect(gaps, `discontinuities at ${gaps.join(', ')} (expected exactly one, at ${GAP_PREFIX})`)
        .toEqual([GAP_PREFIX]);
      expect(seen[GAP_PREFIX] - seen[GAP_PREFIX - 1] - 1, 'the size of the missed window')
        .toBe(GAP_MISSED);
      for (const g of gaps) {
        expect(
          signalledAt,
          `${GAP_MISSED} events vanished after #${g} with no signal to the consumer - a silent drop`,
        ).toContain(g);
      }
      expect(lost, 'the stream was given up on although it recovered').toBe(0);
    }, 300000);

    it('a stream that cannot be recovered is signalled terminally, exactly once', async () => {
      const server = await startFloodServer();
      const o: Open = { server };
      open.push(o);

      const seen: number[] = [];
      let lost = 0;
      let restored = 0;
      o.stream = await openFloodStream(
        generation, server,
        e => { seen.push(Number(e.value)); },
        { onLost: () => { lost++; }, onRestored: () => { restored++; } },
        {
          pingIntervalMs: QUIET_PING_MS, reconnectBaseMs: 60, reconnectCapMs: 120,
          maxReconnectAttempts: 3, openTimeoutMs: 1500,
        },
      );

      await until(() => server.live() !== null, 20000, 'the mock stream is open');
      await server.blast(TERMINAL_BURST, { perFrame: 1 });
      await until(() => seen.length >= TERMINAL_BURST, 60000, 'the burst is delivered');
      assertExactRun(seen, 0, TERMINAL_BURST, 'pre-loss burst');

      // Take the whole endpoint away: every reconnect attempt now fails at
      // connect, so the budget burns down deterministically instead of racing a
      // timeout. A consumer left believing it still has a live feed after this
      // is the silent-drop failure in its worst form - every subsequent event is
      // lost and nothing ever says so.
      await server.close();

      await until(() => lost >= 1, 90000,
        'the consumer is told the stream is terminally lost');
      expect(restored, 'a stream with no endpoint reported itself restored').toBe(0);

      // Window: 10x the capped backoff. A retry loop that survived the give-up
      // would have fired again inside it, and a second onLost would land here.
      await settle(1500);
      expect(lost, 'onLost fired more than once').toBe(1);
      expect(seen.length, 'events arrived after the endpoint was gone').toBe(TERMINAL_BURST);
    }, 300000);
  });
}
