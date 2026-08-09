import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket as ServerWebSocket } from 'ws';
import { RwsClient2 } from '../src/RwsClient2.js';
import type { SubscriptionEvent } from '../src/types.js';
import { TEST_TLS_KEY, TEST_TLS_CERT } from './TlsFixture.js';

// ─── Local subscription test server ──────────────────────────────────────────

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface RecordedRequest { method: string; url: string; body: string; cookie: string; at: number }

/**
 * HTTP(S) + WebSocket server mimicking the RWS 2.0 subscription flow:
 * POST /subscription → 201 + Location: ws(s)://…/poll/{n} + rel="group" body link,
 * then WS upgrade on the poll URL. Records every request (with its Cookie header)
 * and the subprotocols each WS client offers.
 */
async function startSubscriptionServer(opts: {
  tls?: boolean;
  /** When true, POST /subscription answers 500 (used to exhaust reconnects). */
  failSubscribes?: () => boolean;
  /** When true, the server accepts the upgrade socket but never answers (handshake hang). */
  hangUpgrade?: boolean;
  /** Answer app-level 'PING' text with 'PONG' like a real controller (default true). */
  answerPings?: boolean;
  /** Advertise this port in the Location header instead of the real one (NAT simulation). */
  advertisePort?: number;
  /**
   * Controller-restart simulation: each POST /subscription mints a NEW session
   * cookie (ABBCX=cx-{n}) and WS upgrades presenting any older cookie are
   * rejected 401 - matches live RW7.21 behavior across a warm restart.
   */
  rotateCookies?: boolean;
  /**
   * When it returns true, accept GETs and never answer them - a frozen link.
   *
   * Note a real limitation this makes explicit: on OmniCore the client cannot
   * send anything on the subscription socket, and an idle subscription sends
   * nothing back, so a half-open state affecting ONLY that socket while HTTP
   * still works is undetectable in band. Detection covers a link-level freeze,
   * which is what this models.
   */
  hangRequests?: () => boolean;
} = {}): Promise<{
  close: () => void;
  port: number;
  requests: RecordedRequest[];
  posts: string[];
  sockets: ServerWebSocket[];
  protocolsSeen: string[][];
  /** Frames the CLIENT sent on the subscription socket - must stay 0. */
  readonly framesFromClient: number;
}> {
  const requests: RecordedRequest[] = [];
  const posts: string[] = [];
  const sockets: ServerWebSocket[] = [];
  const protocolsSeen: string[][] = [];
  let framesFromClient = 0;
  /** Responses deliberately left unanswered; destroyed on close so the server can exit. */
  const hung: http.ServerResponse[] = [];
  let port = 0;
  let groupId = 0;
  const wsScheme = opts.tls ? 'wss' : 'ws';
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void collectBody(req).then(body => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', body,
        cookie: (req.headers['cookie'] ?? '') as string,
        at: Date.now(),
      });
      if (req.method === 'POST' && req.url === '/subscription') {
        if (opts.failSubscribes?.()) { res.writeHead(500); res.end(); return; }
        posts.push(body);
        groupId++;
        const advertised = opts.advertisePort ?? port;
        const cookie = opts.rotateCookies ? `ABBCX=cx-${groupId}` : 'ABBCX=test-cx';
        res.writeHead(201, {
          Location: `${wsScheme}://127.0.0.1:${advertised}/poll/${groupId}`,
          'Set-Cookie': `${cookie}; path=/`,
          'Content-Type': 'application/xhtml+xml;v=2.0',
        });
        res.end(`<html><body><div class="state"><a href="subscription/${groupId}" rel="group"></a>`
          + `<a href="${wsScheme}://127.0.0.1:${advertised}/poll/${groupId}" rel="self"></a></div></body></html>`);
        return;
      }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      // Liveness probe. The client no longer sends anything on the subscription
      // socket - OmniCore closes it with 1008 "Client cannot send data." - so it
      // establishes liveness with a cheap GET on the same session instead. A mock
      // that 404s every GET tells the client the controller is unreachable, and
      // it will (correctly) tear the healthy stream down.
      if (req.method === 'GET') {
        // Half-open simulation: accept the probe and never answer it, the way a
        // frozen link does. Only GETs stall - the re-POST is left working so the
        // reconnect path is observable; the full freeze-then-heal sequence is
        // covered live by structural cell S02.
        if (opts.hangRequests?.()) { hung.push(res); return; }
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
          + '<body><div class="state"><ul><li class="pnl-ctrlstate">'
          + '<span class="ctrlstate">motoron</span></li></ul></div></body></html>');
        return;
      }
      res.writeHead(404); res.end();
    });
  };
  const server = opts.tls
    ? https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler)
    : http.createServer(handler);
  let wss: WebSocketServer | null = null;
  if (opts.hangUpgrade) {
    // Swallow the upgrade: the socket stays open but the handshake never completes.
    server.on('upgrade', () => {});
  } else {
    wss = new WebSocketServer({
      server,
      // Echo the first offered subprotocol so the handshake succeeds regardless -
      // the tests assert on what the client OFFERED, not what was selected.
      handleProtocols: protocols => {
        protocolsSeen.push([...protocols]);
        return [...protocols][0] ?? false;
      },
      // Restart simulation: only the LATEST minted cookie may open a WS
      // (older sessions are dead; upgrade → 401 like live RW7.21)
      ...(opts.rotateCookies ? {
        verifyClient: (info: { req: http.IncomingMessage }): boolean =>
          ((info.req.headers.cookie ?? '') as string).includes(`ABBCX=cx-${groupId}`),
      } : {}),
    });
    wss.on('connection', ws => {
      sockets.push(ws);
      // Count EVERY inbound frame, answered or not. A real OmniCore rejects
      // client data on this socket with a 1008 close, so "did the client send
      // anything at all" is the property worth asserting - not "was it a PING".
      ws.on('message', d => {
        framesFromClient++;
        if (opts.answerPings !== false && d.toString() === 'PING') { ws.send('PONG'); }
      });
    });
  }
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  return {
    close: () => {
      for (const r of hung) { r.destroy(); }
      wss?.close(); server.close();
    },
    port, requests, posts, sockets, protocolsSeen,
    get framesFromClient() { return framesFromClient; },
  };
}

/**
 * Poll until a condition holds. The budget is deliberately generous: these
 * tests assert that something eventually happens (a socket opens, a re-POST
 * lands), never how fast. A tight budget only makes the suite fail when the
 * machine is busy - which is exactly when the whole suite runs in parallel.
 */
function until(cond: () => boolean, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) { clearInterval(timer); resolve(); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer); reject(new Error('condition not met in time'));
      }
    }, 20);
  });
}

const WS_OPEN = 1; // ws.readyState OPEN

/**
 * Push an event to the client over whichever socket is CURRENTLY live, retrying
 * until the client's handler actually receives it.
 *
 * Sending to a socket by index is not safe here. The server registers a socket
 * the moment it accepts the upgrade, but the client can still abandon that
 * connection afterwards - if its own WS open timeout expires before it processes
 * the open event, it discards the socket and reconnects, leaving the server
 * holding a dead entry. Under parallel-suite load that is exactly what happens,
 * and a test that sent to `sockets[1]` then waited was waiting on a corpse: no
 * amount of patience recovers, which is why widening the timeouts never fixed
 * this. Addressing "the newest open socket" and re-sending removes the
 * assumption instead of betting against the race.
 *
 * Duplicate deliveries are harmless - the assertions check the FIRST event.
 */
async function deliverUntilSeen(
  sockets: ServerWebSocket[], payload: string, seen: () => boolean, timeoutMs = 20000,
): Promise<void> {
  const t0 = Date.now();
  while (!seen()) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`event never reached the handler (${sockets.length} server sockets seen)`);
    }
    for (let i = sockets.length - 1; i >= 0; i--) {
      if (sockets[i].readyState === WS_OPEN) { sockets[i].send(payload); break; }
    }
    await new Promise(r => setTimeout(r, 25));
  }
}

/** Runtime access to RwsClient2's private reconnect tuning statics. */
const tuning = RwsClient2 as unknown as {
  WS_RECONNECT_BASE_MS: number;
  WS_RECONNECT_MAX_ATTEMPTS: number;
  WS_OPEN_TIMEOUT_MS: number;
};
const defaults = {
  base: tuning.WS_RECONNECT_BASE_MS,
  attempts: tuning.WS_RECONNECT_MAX_ATTEMPTS,
  open: tuning.WS_OPEN_TIMEOUT_MS,
};
afterEach(() => {
  tuning.WS_RECONNECT_BASE_MS = defaults.base;
  tuning.WS_RECONNECT_MAX_ATTEMPTS = defaults.attempts;
  tuning.WS_OPEN_TIMEOUT_MS = defaults.open;
});

// ─── Subprotocol ─────────────────────────────────────────────────────────────

describe('RWS 2.0 subscription subprotocol', () => {
  it('offers rws_subscription (not the RWS 1.0 robapi2_subscription)', async () => {
    const s = await startSubscriptionServer();
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['speedratio'], () => {});
      await until(() => s.protocolsSeen.length >= 1);
      expect(s.protocolsSeen[0]).toEqual(['rws_subscription']);
      await unsubscribe();
    } finally { s.close(); }
  });
});

// ─── Reconnect ───────────────────────────────────────────────────────────────

describe('RWS 2.0 subscription reconnect', () => {
  it('re-POSTs the subscription after the socket drops and keeps delivering events', async () => {
    const s = await startSubscriptionServer();
    try {
      const events: Array<{ resource: string; value: string }> = [];
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(
        ['speedratio'],
        (e: SubscriptionEvent) => events.push({ resource: e.resource, value: e.value }),
        undefined, undefined,
        // This test proves the re-POST happens and events still flow - not the
        // default schedule, and NOT the give-up budget (a separate test covers
        // that). So: fast backoff for a quick result on an idle machine, and an
        // attempt budget large enough that the client can never exhaust it and
        // stop trying while the waits below are still waiting.
        //
        // The open timeout is deliberately left at its default. An earlier
        // attempt to shrink it made things worse in two ways: it burned the
        // 6-attempt budget faster, and - the real problem - a short timeout is
        // what makes the client abandon a socket the server has already
        // accepted, stranding the event the test sends to it. Fewer abandoned
        // sockets is the goal, so leave it long and let deliverUntilSeen handle
        // the rest.
        { reconnectBaseMs: 50, reconnectCapMs: 100, maxReconnectAttempts: 1000 },
      );
      expect(s.posts.length).toBe(1);
      await until(() => s.sockets.length >= 1);

      // Simulate the controller killing the connection. Terminate every socket
      // the server currently holds, not sockets[0]: if the client had already
      // abandoned and replaced its first connection, killing only that one kills
      // something already dead and no reconnect is ever triggered.
      const postsBefore = s.posts.length;
      const socketsBefore = s.sockets.length;
      for (const ws of s.sockets) { ws.terminate(); }

      // The client must create a NEW subscription (the old WS URL is dead) …
      await until(() => s.posts.length > postsBefore);
      await until(() => s.sockets.length > socketsBefore);

      // … and events must still reach the handler over whatever socket is live.
      await deliverUntilSeen(
        s.sockets,
        '<li class="ios-signal-li"><a href="/rw/panel/speedratio" rel="self"></a><span class="lvalue">42</span></li>',
        () => events.length >= 1,
      );
      expect(events[0]).toEqual({ resource: 'speedratio', value: '42' });

      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('adopts a re-issued session cookie so recovery works after a controller restart', async () => {
    // Live-observed on RW7.21 (2026-08-02): a warm restart kills the session;
    // the re-POST /subscription succeeds via Basic auth and mints a NEW cookie,
    // and the WS upgrade rejects the old one with 401. A client that keeps the
    // stale cookie loops 401 forever and never recovers.
    const s = await startSubscriptionServer({ rotateCookies: true });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      let restored = 0;
      const unsubscribe = await client.subscribe(
        ['speedratio'], () => {}, undefined, () => { restored++; },
      );
      await until(() => s.sockets.length >= 1);

      // "Restart": drop the socket; the next subscription mints cx-2 and the
      // WS layer only accepts cx-2.
      s.sockets[0].terminate();
      await until(() => restored >= 1, 8000);
      expect(s.posts.length).toBeGreaterThanOrEqual(2);
      expect(s.sockets.length).toBeGreaterThanOrEqual(2);
      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('fires onRestored after each successful re-subscribe, never on the initial one', async () => {
    const s = await startSubscriptionServer();
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      let restored = 0;
      const unsubscribe = await client.subscribe(
        ['speedratio'],
        () => {},
        undefined,
        () => { restored++; },
      );
      await until(() => s.sockets.length >= 1);
      expect(restored).toBe(0);

      s.sockets[0].terminate();
      await until(() => s.sockets.length >= 2, 8000);
      await until(() => restored >= 1, 8000);
      expect(restored).toBe(1);

      // A second drop proves the attempt counter was reset by the first recovery.
      s.sockets[1].terminate();
      await until(() => s.sockets.length >= 3, 8000);
      await until(() => restored >= 2, 8000);
      expect(restored).toBe(2);

      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('detects a half-open connection and re-subscribes', async () => {
    // A half-open link (frozen NAT, yanked cable) is one where the socket looks
    // open but nothing gets through IN EITHER DIRECTION. This used to be
    // simulated by withholding PONGs, which no longer means anything: the client
    // sends nothing on the subscription socket, because OmniCore closes it with
    // 1008 "Client cannot send data." Liveness now comes from an out-of-band GET,
    // so a faithful half-open simulation must stall that GET too - which is
    // exactly what a frozen link does.
    const s = await startSubscriptionServer({ hangRequests: () => true });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p', { timeout: 300 });
      let restored = 0;
      const unsubscribe = await client.subscribe(
        ['speedratio'], () => {}, undefined, () => { restored++; },
        { pingIntervalMs: 150, reconnectBaseMs: 30 },
      );
      await until(() => s.sockets.length >= 1);

      // Neither frames nor probe answers → detection ≤ 2 ticks → reconnect re-POSTs.
      await until(() => s.posts.length >= 2, 8000);
      await until(() => restored >= 1, 8000);
      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('keeps a healthy, SILENT connection open across several heartbeat intervals', async () => {
    const s = await startSubscriptionServer({ answerPings: true });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(
        ['speedratio'], () => {}, undefined, undefined,
        { pingIntervalMs: 400 },
      );
      await until(() => s.sockets.length >= 1);
      await new Promise(r => setTimeout(r, 1500));

      // Several heartbeat cycles passed; a healthy stream must not reconnect.
      expect(s.posts.length).toBe(1);
      expect(s.sockets.length).toBe(1);

      // And the client must have stayed SILENT on the socket. OmniCore answers
      // any client frame on a subscription connection with a 1008 close
      // ("Client cannot send data."), so a keep-alive here is not merely
      // useless - it is what was destroying the stream every 25 s in production.
      // Liveness comes from the out-of-band GET the mock now answers.
      expect(s.framesFromClient, 'client must send nothing on the subscription socket').toBe(0);

      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('connects the WebSocket via the configured base URL, not the advertised authority', async () => {
    // NAT/port-forward simulation: the controller advertises its own (wrong
    // from the client's viewpoint) port in the Location header. The client
    // must keep the advertised path but connect through the address it was
    // configured with - parity with the RWS 1.0 subscriber.
    const s = await startSubscriptionServer({ advertisePort: 9 });
    try {
      const events: string[] = [];
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(
        ['speedratio'], (e: SubscriptionEvent) => events.push(e.value),
      );
      await until(() => s.sockets.length >= 1, 5000);
      // Deliver over whichever socket is live rather than sockets[0] - the
      // server registers a socket on upgrade, but the client may still abandon
      // and replace it. Same latent race as the reconnect test above.
      await deliverUntilSeen(
        s.sockets,
        '<li class="ios-signal-li"><a href="/rw/panel/speedratio" rel="self"></a><span class="lvalue">55</span></li>',
        () => events.length >= 1,
      );
      expect(events[0]).toBe('55');
      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('honors reconnect tuning options and fires onLost after the configured budget', async () => {
    let failing = false;
    const s = await startSubscriptionServer({ failSubscribes: () => failing });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      let lostCount = 0;
      const unsubscribe = await client.subscribe(
        ['speedratio'], () => {}, () => { lostCount++; }, undefined,
        { reconnectBaseMs: 50, reconnectCapMs: 60, maxReconnectAttempts: 4 },
      );
      await until(() => s.sockets.length >= 1);
      failing = true;
      const postsBefore = s.requests.filter(r => r.method === 'POST' && r.url === '/subscription').length;
      s.sockets[0].terminate();

      await until(() => lostCount >= 1, 5000);
      // Exactly maxReconnectAttempts re-POSTs were attempted
      const rePosts = s.requests.filter(r => r.method === 'POST' && r.url === '/subscription').slice(postsBefore);
      expect(rePosts.length).toBe(4);
      // The cap is proven by the SCHEDULE, not the wall clock: gaps between
      // failing re-POSTs follow the capped 60 ms delay. Without the cap the
      // 3rd gap alone is >= 400 ms (50/100/200/400 exponential) and with the
      // default tuning >= 1 s. A whole-sequence wall-clock bound flaked under
      // parallel-suite CPU load; per-gap bounds keep the discrimination with
      // 4x the noise margin.
      const gaps = rePosts.slice(1).map((r, i) => r.at - rePosts[i].at);
      for (const gap of gaps) { expect(gap).toBeLessThan(300); }
      expect(lostCount).toBe(1);
      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('does not reconnect after unsubscribe', async () => {
    const s = await startSubscriptionServer();
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['speedratio'], () => {});
      await until(() => s.sockets.length >= 1);
      await unsubscribe();
      // Give any (buggy) reconnect timer a chance to fire.
      await new Promise(r => setTimeout(r, 1200));
      expect(s.posts.length).toBe(1);
    } finally { s.close(); }
  }, 30000);

  it('rides the session cookie and DELETEs the old group before re-subscribing', async () => {
    const s = await startSubscriptionServer();
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['speedratio'], () => {});
      await until(() => s.sockets.length >= 1);
      s.sockets[0].terminate();
      await until(() => s.posts.length >= 2, 8000);

      // No session leak: the re-POST must reuse the session cookie from the first response.
      const subPosts = s.requests.filter(r => r.method === 'POST' && r.url === '/subscription');
      expect(subPosts[1].cookie).toContain('ABBCX=test-cx');

      // No group leak: the dead group must be DELETEd before the new POST.
      const delIdx = s.requests.findIndex(r => r.method === 'DELETE' && r.url === '/subscription/1');
      const repostIdx = s.requests.findIndex((r, i) => i > 0 && r.method === 'POST' && r.url === '/subscription');
      expect(delIdx).toBeGreaterThan(-1);
      expect(delIdx).toBeLessThan(repostIdx);

      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('unsubscribe DELETEs the subscription group resource (/subscription/{id}, not the poll URL)', async () => {
    const s = await startSubscriptionServer();
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['speedratio'], () => {});
      await until(() => s.sockets.length >= 1);
      await unsubscribe();
      const dels = s.requests.filter(r => r.method === 'DELETE');
      expect(dels.map(d => d.url)).toContain('/subscription/1');
      expect(dels.every(d => !d.url.startsWith('/poll/'))).toBe(true);
    } finally { s.close(); }
  });

  it('cleans up the subscription group when the WS handshake times out', async () => {
    tuning.WS_OPEN_TIMEOUT_MS = 300;
    const s = await startSubscriptionServer({ hangUpgrade: true });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      await expect(client.subscribe(['speedratio'], () => {})).rejects.toThrow(/timed out/i);
      await until(() => s.requests.some(r => r.method === 'DELETE' && r.url === '/subscription/1'), 3000);
    } finally { s.close(); }
  }, 30000);

  it('invokes onLost exactly once when reconnect attempts are exhausted', async () => {
    tuning.WS_RECONNECT_BASE_MS = 5;
    tuning.WS_RECONNECT_MAX_ATTEMPTS = 2;
    let failing = false;
    const s = await startSubscriptionServer({ failSubscribes: () => failing });
    try {
      let lost = 0;
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['speedratio'], () => {}, () => { lost++; });
      await until(() => s.sockets.length >= 1);

      failing = true;               // every re-subscribe now fails …
      s.sockets[0].terminate();     // … and the stream drops

      await until(() => lost >= 1, 5000);
      await new Promise(r => setTimeout(r, 300)); // any further (buggy) invocation would land here
      expect(lost).toBe(1);
      await unsubscribe();
    } finally { s.close(); }
  }, 30000);

  it('unsubscribe during an in-flight reconnect stops the retry loop without onLost', async () => {
    tuning.WS_RECONNECT_BASE_MS = 30;
    tuning.WS_RECONNECT_MAX_ATTEMPTS = 6;
    let failing = false;
    const s = await startSubscriptionServer({ failSubscribes: () => failing });
    try {
      let lost = 0;
      const client = new RwsClient2(`http://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['speedratio'], () => {}, () => { lost++; });
      await until(() => s.sockets.length >= 1);

      const subPosts = (): number =>
        s.requests.filter(r => r.method === 'POST' && r.url === '/subscription').length;

      failing = true;               // re-subscribes fail → the retry loop is live …
      s.sockets[0].terminate();
      await until(() => subPosts() >= 2, 5000);

      // … and the consumer leaves mid-retry. The loop must stop here: clearing
      // the pending timer isn't enough, an open() already in flight re-enters
      // scheduleReconnect through its .catch.
      await unsubscribe();
      await new Promise(r => setTimeout(r, 100));
      const postsAfterUnsub = subPosts();
      await new Promise(r => setTimeout(r, 500));
      expect(subPosts()).toBe(postsAfterUnsub);
      expect(lost).toBe(0);
    } finally { s.close(); }
  }, 30000);
});

// ─── TLS behavior (self-signed, like every shipping controller) ──────────────

describe('RWS 2.0 subscriptions over TLS', () => {
  it('default (insecure) mode completes POST /subscription + wss connect against a self-signed cert', async () => {
    const s = await startSubscriptionServer({ tls: true });
    try {
      const client = new RwsClient2(`https://127.0.0.1:${s.port}`, 'u', 'p');
      const unsubscribe = await client.subscribe(['speedratio'], () => {});
      await until(() => s.sockets.length >= 1);
      expect(s.posts.length).toBe(1);
      await unsubscribe();
    } finally { s.close(); }
  });

  it('strict mode (rejectUnauthorized: true) refuses the self-signed cert', async () => {
    const s = await startSubscriptionServer({ tls: true });
    try {
      const client = new RwsClient2(`https://127.0.0.1:${s.port}`, 'u', 'p', { rejectUnauthorized: true });
      await expect(client.subscribe(['speedratio'], () => {}))
        .rejects.toThrow(/self[- ]signed|certificate/i);
      expect(s.sockets.length).toBe(0);
    } finally { s.close(); }
  });
});
