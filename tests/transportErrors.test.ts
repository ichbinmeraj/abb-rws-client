import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { RwsClient2 } from '../src/RwsClient2.js';
import { HttpSession } from '../src/HttpSession.js';
import { RobotManager } from '../src/RobotManager.js';
import { probeProtocol, createClient } from '../src/detect.js';
import { RwsError } from '../src/types.js';

/**
 * A connection the controller (or anything on the path) cuts while a response
 * is in flight must end as a rejected promise on the call that made it - never
 * as an 'error' event nobody listens to, which Node turns into an uncaught
 * exception that ends the host process. A long-running host (the daemon) died
 * exactly that way on a `read ECONNRESET`.
 */

// ─── Escape detection ────────────────────────────────────────────────────────

let escaped: unknown[] = [];
const record = (e: unknown): void => { escaped.push(e); };
let baseline = { uncaught: 0, rejection: 0 };

beforeEach(() => {
  escaped = [];
  baseline = {
    uncaught: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
});

afterEach(async () => {
  // Events from a torn-down socket land a few ticks after the promise settled.
  await new Promise(r => setTimeout(r, 50));
  process.off('uncaughtException', record);
  process.off('unhandledRejection', record);
  expect(escaped).toEqual([]);
  // Survival must come from handling the client's own emitters, not from a
  // process-wide catch-all installed behind the host's back.
  expect(process.listenerCount('uncaughtException')).toBe(baseline.uncaught);
  expect(process.listenerCount('unhandledRejection')).toBe(baseline.rejection);
});

// ─── A peer that cuts responses ──────────────────────────────────────────────

const HAL_200_HEAD =
  'HTTP/1.1 200 OK\r\nContent-Type: application/hal+json;v=2.0\r\nContent-Length: 100000\r\n\r\n';

/**
 * Raw TCP peer. Every request gets `head` (which promises a long body) plus a
 * few body bytes, then:
 *  - 'reset': an RST - the client reads ECONNRESET;
 *  - 'close': a clean FIN short of Content-Length - no error on the request;
 *  - 'trickle': one more byte every 20 ms, forever.
 */
async function startCutPeer(
  cut: 'reset' | 'close' | 'trickle', head = HAL_200_HEAD,
): Promise<{ port: number; requests: () => number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  let requests = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => { /* the client may reset back */ });
    socket.on('close', () => sockets.delete(socket));
    let seen = '';
    let answered = false;
    socket.on('data', d => {
      if (answered) { return; }
      seen += d.toString('latin1');
      if (!seen.includes('\r\n\r\n')) { return; }
      answered = true;
      requests++;
      socket.write(`${head}<partial`);
      if (cut === 'trickle') {
        const t = setInterval(() => socket.write('x'), 20);
        socket.on('close', () => clearInterval(t));
        return;
      }
      setTimeout(() => { if (cut === 'reset') { socket.resetAndDestroy(); } else { socket.end(); } }, 20);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => requests,
    close: () => new Promise<void>(r => {
      for (const s of sockets) { s.destroy(); }
      server.close(() => r());
    }),
  };
}

async function startHttp(
  handle: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  const e = await p.then(() => { throw new Error('expected a rejection'); }, (err: unknown) => err);
  expect(e).toBeInstanceOf(RwsError);
  return e as RwsError;
}

// ─── RWS 2.0 requests ────────────────────────────────────────────────────────

describe('RWS 2.0 request: a connection cut mid-response', () => {
  it('rejects with NETWORK_ERROR when the connection is reset mid-body', async () => {
    const peer = await startCutPeer('reset');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${peer.port}`, 'u', 'p', { timeout: 5000 });
      const e = await rejection(c.connect());
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/ECONNRESET|mid-/);
    } finally { await peer.close(); }
  });

  it('rejects promptly when the peer closes cleanly short of Content-Length (was: pending for good)', async () => {
    const peer = await startCutPeer('close');
    try {
      // A long idle timeout: the rejection must come from the cut itself.
      const c = new RwsClient2(`http://127.0.0.1:${peer.port}`, 'u', 'p', { timeout: 10000 });
      const t0 = Date.now();
      const e = await rejection(c.connect());
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/mid-body|mid-response/);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally { await peer.close(); }
  });

  it('rejects a trickled body at the absolute deadline, although the idle timeout never fires', async () => {
    const peer = await startCutPeer('trickle');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${peer.port}`, 'u', 'p', { timeout: 2000, requestDeadlineMs: 300 });
      const t0 = Date.now();
      const e = await rejection(c.readFile('HOME/big.txt'));
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/300 ms deadline/);
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally { await peer.close(); }
  });
});

describe('RWS 2.0 response byte cap', () => {
  const serveBytes = (n: number): http.RequestListener => (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x'.repeat(n));
  };

  it('reads a body of exactly maxResponseBytes', async () => {
    const { server, port } = await startHttp(serveBytes(1024));
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { maxResponseBytes: 1024 });
      await expect(c.readFile('HOME/a.txt')).resolves.toHaveLength(1024);
    } finally { server.close(); }
  });

  it('refuses a body one byte over the cap with NETWORK_ERROR', async () => {
    const { server, port } = await startHttp(serveBytes(1025));
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { maxResponseBytes: 1024 });
      const e = await rejection(c.readFile('HOME/a.txt'));
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.httpStatus).toBe(200);
      expect(e.message).toMatch(/exceeds the 1024-byte limit/);
    } finally { server.close(); }
  });

  it('defaults: 64 MiB cap; 120 s deadline, or the idle timeout when that is longer', () => {
    const limits = (c: RwsClient2): { cap: number; deadline: number } => {
      const x = c as unknown as { maxResponseBytes: number; requestDeadlineMs: number };
      return { cap: x.maxResponseBytes, deadline: x.requestDeadlineMs };
    };
    expect(limits(new RwsClient2('http://127.0.0.1:1', 'u', 'p')))
      .toEqual({ cap: 64 * 1024 * 1024, deadline: 120000 });
    expect(limits(new RwsClient2('http://127.0.0.1:1', 'u', 'p', { timeout: 300000 })).deadline).toBe(300000);
  });
});

describe('RWS 2.0 request deadline: values a timer cannot hold', () => {
  // setTimeout fires a delay above 2^31-1 ms, or Infinity, after 1 ms, and 0 on
  // the next tick. The deadline took its value as given: a long `timeout` that
  // used to work failed every request at once, and 0 or Infinity, the obvious
  // ways to turn the deadline off, did the same.
  const slowOk: http.RequestListener = (req, res) => {
    req.resume();
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); }, 30);
  };
  const deadlineOf = (c: RwsClient2): number =>
    (c as unknown as { requestDeadlineMs: number }).requestDeadlineMs;

  const CASES: Array<[string, { timeout?: number; requestDeadlineMs?: number }]> = [
    ['timeout 2^31-1', { timeout: 2 ** 31 - 1 }],
    ['requestDeadlineMs 0', { requestDeadlineMs: 0 }],
    ['requestDeadlineMs Infinity', { requestDeadlineMs: Infinity }],
    ['requestDeadlineMs 3e9', { requestDeadlineMs: 3e9 }],
  ];
  for (const [label, opts] of CASES) {
    it(`a request completes with ${label}`, async () => {
      const { server, port } = await startHttp(slowOk);
      try {
        const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', opts);
        await expect(c.readFile('HOME/a.txt')).resolves.toBe('ok');
      } finally { server.close(); }
    });
  }

  it('0 or Infinity turns the deadline off; a longer one is capped at 2^31-1 ms', () => {
    const at = (opts: { timeout?: number; requestDeadlineMs?: number }): number =>
      deadlineOf(new RwsClient2('http://127.0.0.1:1', 'u', 'p', opts));
    expect(at({ requestDeadlineMs: 0 })).toBe(0);
    expect(at({ requestDeadlineMs: Infinity })).toBe(0);
    expect(at({ requestDeadlineMs: 3e9 })).toBe(2 ** 31 - 1);
    expect(at({ timeout: 2 ** 31 - 1 })).toBe(2 ** 31 - 1);
    expect(at({ requestDeadlineMs: 2 ** 31 - 1 })).toBe(2 ** 31 - 1);
    expect(at({ requestDeadlineMs: 300 })).toBe(300);
  });
});

// ─── RWS 2.0 subscriptions ───────────────────────────────────────────────────

describe('RWS 2.0 subscribe: the subscription POST and the event socket', () => {
  it('rejects with NETWORK_ERROR when POST /subscription is reset mid-body', async () => {
    const peer = await startCutPeer('reset',
      'HTTP/1.1 201 Created\r\nLocation: ws://127.0.0.1:1/poll/1\r\nContent-Length: 100000\r\n\r\n');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${peer.port}`, 'u', 'p', { timeout: 5000 });
      const e = await rejection(c.subscribe(['speedratio'], () => {}));
      expect(e.code).toBe('NETWORK_ERROR');
    } finally { await peer.close(); }
  });

  it('refuses a POST /subscription body over the cap', async () => {
    const { server, port } = await startHttp((_req, res) => {
      res.writeHead(201, { Location: 'ws://127.0.0.1:1/poll/1' });
      res.end('x'.repeat(2048));
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { maxResponseBytes: 1024 });
      const e = await rejection(c.subscribe(['speedratio'], () => {}));
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/1024-byte limit/);
    } finally { server.close(); }
  });

  it('the subscription POST completes with the deadline turned off (requestDeadlineMs 0)', async () => {
    let port = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => setTimeout(() => {
        if (req.method === 'POST') {
          res.writeHead(201, { Location: `ws://127.0.0.1:${port}/poll/1` });
          res.end('<a href="subscription/1" rel="group"></a>');
        } else { res.writeHead(200); res.end(); }
      }, 30));
    });
    const wss = new WebSocketServer({ server, handleProtocols: () => 'rws_subscription' });
    wss.on('connection', ws => ws.on('error', () => { /* the client drops the socket */ }));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { requestDeadlineMs: 0 });
      const stop = await c.subscribe(['speedratio'], () => {});
      await stop();
    } finally {
      for (const ws of wss.clients) { ws.terminate(); }
      wss.close();
      server.close();
    }
  });

  it('closes the event socket (1009) on a frame over the cap, and delivers nothing from it', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST') {
          const port = (server.address() as AddressInfo).port;
          res.writeHead(201, { Location: `ws://127.0.0.1:${port}/poll/1` });
          res.end('<a href="subscription/1" rel="group"></a>');
        } else { res.writeHead(200); res.end(); }
      });
    });
    const wss = new WebSocketServer({ server, handleProtocols: () => 'rws_subscription' });
    const closeCodes: number[] = [];
    wss.on('connection', ws => {
      ws.on('close', code => closeCodes.push(code));
      ws.on('error', () => { /* the client drops the socket */ });
      ws.send(`<li><a href="/rw/panel/speedratio"></a><span>${'9'.repeat(2048)}</span></li>`);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { maxResponseBytes: 1024 });
      const events: unknown[] = [];
      const stop = await c.subscribe(['speedratio'], e => events.push(e));
      const t0 = Date.now();
      while (closeCodes.length === 0 && Date.now() - t0 < 3000) { await new Promise(r => setTimeout(r, 20)); }
      await stop();
      expect(closeCodes[0]).toBe(1009);
      expect(events).toEqual([]);
    } finally {
      for (const ws of wss.clients) { ws.terminate(); }
      wss.close();
      server.close();
    }
  });
});

// ─── RWS 1.0 and the probes ──────────────────────────────────────────────────

describe('RWS 1.0 HttpSession: a connection cut mid-response', () => {
  it('rejects with NETWORK_ERROR on a reset mid-body', async () => {
    const peer = await startCutPeer('reset',
      'HTTP/1.1 200 OK\r\nContent-Type: application/xhtml+xml\r\nContent-Length: 100000\r\n\r\n');
    try {
      const s = new HttpSession({
        baseUrl: `http://127.0.0.1:${peer.port}`, username: 'u', password: 'p',
        requestIntervalMs: 0, timeoutMs: 5000,
      });
      const e = await rejection(s.get('/rw/system'));
      expect(e.code).toBe('NETWORK_ERROR');
    } finally { await peer.close(); }
  });
});

describe('probe helpers: a cut or trickled answer settles the probe', () => {
  const DIGEST_401_HEAD =
    'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm="r", nonce="n"\r\nContent-Length: 100000\r\n\r\n';

  for (const cut of ['reset', 'close', 'trickle'] as const) {
    it(`probeProtocol answers null on a '${cut}' body (was: pending for good on close and trickle)`, async () => {
      const peer = await startCutPeer(cut, DIGEST_401_HEAD);
      try {
        const t0 = Date.now();
        // A trickle never trips the idle limit; it ends at the probe's cap,
        // four times the timeout (800 ms here).
        await expect(probeProtocol('127.0.0.1', peer.port, false, 200)).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
      } finally { await peer.close(); }
    });
  }

  // request() throws synchronously on input it cannot send at all. The probe's
  // timer used to be armed before the request existed, so it fired later on a
  // request still in its TDZ and threw from the timer: an uncaught exception
  // after the caller had already seen the probe fail.
  const UNSENDABLE: Array<[string, number]> = [['127.0.0.1', 70000], ['127.0.0.1', -1], ['127.0.0.1\r\nX: y', 80]];

  for (const [host, port] of UNSENDABLE) {
    it(`probeProtocol answers null for ${JSON.stringify(host)}:${port}, and nothing fires after it`, async () => {
      await expect(probeProtocol(host, port, false, 100)).resolves.toBeNull();
      // Past the timeout: a timer left behind would throw here.
      await new Promise(r => setTimeout(r, 200));
    });

    it(`probeSpecificPort answers null for ${JSON.stringify(host)}:${port}, and nothing fires after it`, async () => {
      await expect(RobotManager.probeSpecificPort(host, port, false, 100)).resolves.toBeNull();
      await new Promise(r => setTimeout(r, 200));
    });
  }

  it('createClient with a port outside 0-65535 rejects with PROTOCOL_DETECT_FAILED, and nothing fires after it', async () => {
    const e = await rejection(createClient({ host: '127.0.0.1', port: 70000, timeout: 100 }));
    expect(e.code).toBe('PROTOCOL_DETECT_FAILED');
    await new Promise(r => setTimeout(r, 200));
  });

  it('probeSpecificPort answers from the headers and survives the body being reset afterwards', async () => {
    const peer = await startCutPeer('reset', DIGEST_401_HEAD);
    try {
      await expect(RobotManager.probeSpecificPort('127.0.0.1', peer.port, false, 1000))
        .resolves.toEqual({ port: peer.port, useHttps: false, authType: 'digest' });
      // Let the reset land after the answer.
      await new Promise(r => setTimeout(r, 60));
      expect(peer.requests()).toBeGreaterThanOrEqual(1);
    } finally { await peer.close(); }
  });
});
