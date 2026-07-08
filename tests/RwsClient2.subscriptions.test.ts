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

interface RecordedRequest { method: string; url: string; body: string; cookie: string }

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
} = {}): Promise<{
  close: () => void;
  port: number;
  requests: RecordedRequest[];
  posts: string[];
  sockets: ServerWebSocket[];
  protocolsSeen: string[][];
}> {
  const requests: RecordedRequest[] = [];
  const posts: string[] = [];
  const sockets: ServerWebSocket[] = [];
  const protocolsSeen: string[][] = [];
  let port = 0;
  let groupId = 0;
  const wsScheme = opts.tls ? 'wss' : 'ws';
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void collectBody(req).then(body => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', body,
        cookie: (req.headers['cookie'] ?? '') as string,
      });
      if (req.method === 'POST' && req.url === '/subscription') {
        if (opts.failSubscribes?.()) { res.writeHead(500); res.end(); return; }
        posts.push(body);
        groupId++;
        res.writeHead(201, {
          Location: `${wsScheme}://127.0.0.1:${port}/poll/${groupId}`,
          'Set-Cookie': 'ABBCX=test-cx; path=/',
          'Content-Type': 'application/xhtml+xml;v=2.0',
        });
        res.end(`<html><body><div class="state"><a href="subscription/${groupId}" rel="group"></a>`
          + `<a href="${wsScheme}://127.0.0.1:${port}/poll/${groupId}" rel="self"></a></div></body></html>`);
        return;
      }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
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
      // Echo the first offered subprotocol so the handshake succeeds regardless —
      // the tests assert on what the client OFFERED, not what was selected.
      handleProtocols: protocols => {
        protocolsSeen.push([...protocols]);
        return [...protocols][0] ?? false;
      },
    });
    wss.on('connection', ws => sockets.push(ws));
  }
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  return {
    close: () => { wss?.close(); server.close(); },
    port, requests, posts, sockets, protocolsSeen,
  };
}

function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
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
      );
      expect(s.posts.length).toBe(1);
      await until(() => s.sockets.length >= 1);

      // Simulate the controller killing the connection.
      s.sockets[0].terminate();

      // The client must create a NEW subscription (old WS URL is dead) …
      await until(() => s.posts.length >= 2, 8000);
      await until(() => s.sockets.length >= 2, 8000);

      // … and events on the new socket must still reach the handler.
      s.sockets[1].send(
        '<li class="ios-signal-li"><a href="/rw/panel/speedratio" rel="self"></a><span class="lvalue">42</span></li>',
      );
      await until(() => events.length >= 1);
      expect(events[0]).toEqual({ resource: 'speedratio', value: '42' });

      await unsubscribe();
    } finally { s.close(); }
  }, 15000);

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
  }, 10000);

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
  }, 15000);

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
  }, 10000);

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
  }, 10000);

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
  }, 10000);
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
