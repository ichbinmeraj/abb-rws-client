import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient } from '../src/RwsClient.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { MAX_TIMER_MS, checkedTimeout } from '../src/HttpSession.js';
import { createAdapter, createClient, probeHost, probeProtocol } from '../src/detect.js';
import { RwsError } from '../src/types.js';

/**
 * The `timeout` option of both generations (`RwsClient`, `RwsClient2`) and
 * of the connect factories and protocol probes (detect.ts), against local
 * 127.0.0.1 servers - no controller. One rule: a finite number above 0 and at
 * most 2^31-1 ms is used as given; anything else is refused with
 * INVALID_ARGUMENT by the constructor, or by the factory or probe before it
 * sends anything.
 *
 * Before, the value reached Node's timers as given. On RWS 1.0 setTimeout
 * fired 0, a negative value, NaN, 3e9 or Infinity after 1 ms (with a Node
 * warning for each but 0), so every request failed as timed out
 * (NETWORK_ERROR). On RWS 2.0 the socket's idle timer threw a raw RangeError
 * for Infinity, a negative value or NaN, and capped 3e9 with a
 * TimeoutOverflowWarning. In `createClient` and `createAdapter` the probe
 * threw that RangeError for -1 or Infinity, and the request it had started
 * was then destroyed with no error listener, an uncaught "socket hang up";
 * 0 or 3e9 ended the probe after 1 ms as PROTOCOL_DETECT_FAILED.
 */

afterEach(() => { vi.restoreAllMocks(); });

const MAX = 2 ** 31 - 1;

/** Values the rule refuses, each with the text the message shows for it. */
const REFUSED: Array<[string, unknown, string]> = [
  ['0', 0, 'got 0'],
  ['-0', -0, 'got 0'],
  ['-1', -1, 'got -1'],
  ['-Infinity', -Infinity, 'got -Infinity'],
  ['NaN', NaN, 'got NaN'],
  ['Infinity', Infinity, 'got Infinity'],
  ['2^31 (one above the cap)', 2 ** 31, 'got 2147483648'],
  ['3e9', 3e9, 'got 3000000000'],
  ['the string "5000"', '5000', 'got "5000"'],
  ['true', true, 'got a value of type boolean'],
];

/** Values the rule takes as given. */
const ACCEPTED: number[] = [1, 0.5, 200, 5000, MAX];

function thrown(fn: () => unknown): RwsError {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(RwsError);
    return e as RwsError;
  }
  throw new Error('expected the constructor to throw');
}

const rws1 = (timeout: unknown): RwsClient =>
  new RwsClient({ host: '127.0.0.1', port: 18080, timeout: timeout as number, requestIntervalMs: 0 });
const rws2 = (timeout: unknown): RwsClient2 =>
  new RwsClient2('http://127.0.0.1:18080', 'u', 'p', timeout === undefined ? {} : { timeout: timeout as number });

/** The timeout a constructed client keeps. */
const kept1 = (c: RwsClient): number => (c as unknown as { session: { timeoutMs: number } }).session.timeoutMs;
const kept2 = (c: RwsClient2): number => (c as unknown as { timeoutMs: number }).timeoutMs;

/** Collects the TimeoutOverflowWarnings Node emits while it runs. */
function overflowWarnings(): { list: Error[]; stop: () => Promise<void> } {
  const list: Error[] = [];
  const on = (w: Error): void => { if (w.name === 'TimeoutOverflowWarning') { list.push(w); } };
  process.on('warning', on);
  return {
    list,
    // Node emits a warning on a later tick than the timer that caused it.
    stop: async () => { await new Promise(r => setImmediate(r)); process.off('warning', on); },
  };
}

async function startServer(
  handle: http.RequestListener,
): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => { req.resume(); handle(req, res); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  const e = await p.then(() => { throw new Error('expected a rejection'); }, (err: unknown) => err);
  expect(e).toBeInstanceOf(RwsError);
  return e as RwsError;
}

// ─── The rule ────────────────────────────────────────────────────────────────

describe('the timeout rule', () => {
  it('the cap is the longest delay a Node timer holds', () => {
    expect(MAX_TIMER_MS).toBe(2147483647);
  });

  it('left out (undefined or null) gives the fallback', () => {
    expect(checkedTimeout(undefined, 5000, 'X')).toBe(5000);
    expect(checkedTimeout(null, 10000, 'X')).toBe(10000);
  });

  it('names who refused it and the allowed range', () => {
    const e = thrown(() => checkedTimeout(Infinity, 5000, 'RWS9'));
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(e.message).toBe(
      'RWS9: timeout must be a number of milliseconds above 0 and at most 2147483647 (about 24.8 days), got Infinity');
  });
});

// ─── RWS 1.0 ─────────────────────────────────────────────────────────────────

describe('RWS 1.0 (RwsClient) timeout option', () => {
  for (const [label, value, shown] of REFUSED) {
    it(`refuses ${label} at construction with INVALID_ARGUMENT`, () => {
      const e = thrown(() => rws1(value));
      expect(e.code).toBe('INVALID_ARGUMENT');
      expect(e.message).toMatch(/^RWS1: timeout must be a number of milliseconds above 0 and at most 2147483647/);
      expect(e.message).toContain(shown);
    });
  }

  for (const value of ACCEPTED) {
    it(`takes ${value} as given`, () => {
      expect(kept1(rws1(value))).toBe(value);
    });
  }

  it('defaults to 5000 when left out or null', () => {
    expect(kept1(new RwsClient({ host: '127.0.0.1', port: 18080 }))).toBe(5000);
    expect(kept1(rws1(undefined))).toBe(5000);
    expect(kept1(rws1(null))).toBe(5000);
  });

  it('a request completes with the largest timeout, and no timer overflows', async () => {
    const { port, close } = await startServer((_req, res) => {
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }, 30);
    });
    const warnings = overflowWarnings();
    const delays = vi.spyOn(globalThis, 'setTimeout');
    try {
      const c = new RwsClient({ host: '127.0.0.1', port, timeout: MAX, requestIntervalMs: 0 });
      await expect(c.request('GET', '/rw/system?json=1')).resolves.toMatchObject({ status: 200, body: '{}' });
      expect(delays.mock.calls.map(call => call[1] ?? 0).every(ms => ms <= MAX)).toBe(true);
    } finally {
      await warnings.stop();
      close();
    }
    expect(warnings.list).toEqual([]);
  });

  it('a hold on top of the largest timeout stays under the cap', async () => {
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const warnings = overflowWarnings();
    const delays = vi.spyOn(globalThis, 'setTimeout');
    try {
      const c = new RwsClient({ host: '127.0.0.1', port, timeout: MAX, requestIntervalMs: 0 });
      await expect(c.request('GET', '/rw/dipc/q1?action=dipc-read&timeout=1000&json=1', undefined, { holdMs: 3e9 }))
        .resolves.toMatchObject({ status: 200 });
      expect(delays.mock.calls.map(call => call[1] ?? 0)).toContain(MAX);
      expect(delays.mock.calls.map(call => call[1] ?? 0).every(ms => ms <= MAX)).toBe(true);
    } finally {
      await warnings.stop();
      close();
    }
    expect(warnings.list).toEqual([]);
    // The limit of one request: the timeout plus the hold, capped.
    const session = (rws1(5000) as unknown as { session: { timeoutFor(h: number): number } }).session;
    expect(session.timeoutFor(0)).toBe(5000);
    expect(session.timeoutFor(150)).toBe(5150);
    expect(session.timeoutFor(3e9)).toBe(MAX);
    expect(session.timeoutFor(Infinity)).toBe(5000);
    expect(session.timeoutFor(NaN)).toBe(5000);
  });

  it('a short timeout still ends a request the server never answers', async () => {
    const { port, close } = await startServer(() => { /* never answers */ });
    try {
      const c = new RwsClient({ host: '127.0.0.1', port, timeout: 100, requestIntervalMs: 0 });
      const e = await rejection(c.request('GET', '/rw/system?json=1'));
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/timed out after 100ms/);
    } finally { close(); }
  });
});

// ─── RWS 2.0 ─────────────────────────────────────────────────────────────────

describe('RWS 2.0 (RwsClient2) timeout option', () => {
  for (const [label, value, shown] of REFUSED) {
    it(`refuses ${label} at construction with INVALID_ARGUMENT`, () => {
      const e = thrown(() => rws2(value));
      expect(e.code).toBe('INVALID_ARGUMENT');
      expect(e.message).toMatch(/^RWS2: timeout must be a number of milliseconds above 0 and at most 2147483647/);
      expect(e.message).toContain(shown);
    });
  }

  for (const value of ACCEPTED) {
    it(`takes ${value} as given`, () => {
      expect(kept2(rws2(value))).toBe(value);
    });
  }

  it('defaults to 10000 when left out or null', () => {
    expect(kept2(new RwsClient2('http://127.0.0.1:18080', 'u', 'p'))).toBe(10000);
    expect(kept2(rws2(undefined))).toBe(10000);
    expect(kept2(rws2(null))).toBe(10000);
  });

  it('the default deadline follows the largest timeout and stays at the cap', () => {
    const deadline = (c: RwsClient2): number => (c as unknown as { requestDeadlineMs: number }).requestDeadlineMs;
    expect(deadline(rws2(MAX))).toBe(MAX);
    expect(deadline(rws2(5000))).toBe(120000);
  });

  it('a request completes with the largest timeout, and no timer overflows', async () => {
    const { port, close } = await startServer((_req, res) => {
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); }, 30);
    });
    const warnings = overflowWarnings();
    const idle = vi.spyOn(http.ClientRequest.prototype, 'setTimeout');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { timeout: MAX });
      await expect(c.readFile('HOME/a.txt')).resolves.toBe('ok');
      expect(idle.mock.calls.map(call => call[0])).toEqual([MAX]);
    } finally {
      await warnings.stop();
      close();
    }
    expect(warnings.list).toEqual([]);
  });

  it('a DIPC wait on top of the largest timeout stays under the cap (idle limit and deadline)', async () => {
    const DIPC_READ = '{"_links":{"base":{"href":"http://127.0.0.1/rw/dipc/"}},"state":[{"_type":"dipc-read","_title":"q1","dipc-data":"hi","dipc-msgtype":"0"}]}';
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(DIPC_READ);
    });
    const warnings = overflowWarnings();
    const idle = vi.spyOn(http.ClientRequest.prototype, 'setTimeout');
    const delays = vi.spyOn(globalThis, 'setTimeout');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { timeout: MAX });
      expect(await c.readDipcMessage('q1', 3e9)).toEqual({ payload: 'hi', type: '0' });
      expect(idle.mock.calls.map(call => call[0])).toEqual([MAX]);
      expect(delays.mock.calls.map(call => call[1] ?? 0)).toContain(MAX);
      expect(delays.mock.calls.map(call => call[1] ?? 0).every(ms => ms <= MAX)).toBe(true);
    } finally {
      await warnings.stop();
      close();
    }
    expect(warnings.list).toEqual([]);
  });

  it('a short timeout still ends a request the server never answers', async () => {
    const { port, close } = await startServer(() => { /* never answers */ });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { timeout: 100 });
      const e = await rejection(c.readFile('HOME/a.txt'));
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/RWS2 timeout/);
    } finally { close(); }
  });
});

// ─── Connect factories and probes (detect.ts) ───────────────────────────────

describe('createClient, createAdapter and the protocol probes', () => {
  /** A server that answers every request with an RWS 1.0 Digest challenge, counting them. */
  async function digestServer(): Promise<{ port: number; requests: () => number; close: () => void }> {
    let n = 0;
    const s = await startServer((_req, res) => {
      n++;
      res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="validusers@robapi.abb", nonce="n", qop="auth"' });
      res.end();
    });
    return { ...s, requests: () => n };
  }

  for (const [label, value, shown] of REFUSED) {
    it(`refuses ${label} with INVALID_ARGUMENT before anything is sent`, async () => {
      const srv = await digestServer();
      try {
        const opts = { host: '127.0.0.1', port: srv.port, https: false, timeout: value as number };
        for (const [who, call] of [
          ['createClient', () => createClient(opts)],
          ['createAdapter', () => createAdapter(opts)],
          ['probeProtocol', () => probeProtocol('127.0.0.1', srv.port, false, value as number)],
          // probeHost walks the known ports. Its host holds a line feed, which
          // Node refuses before connecting, so even an unchecked value could
          // reach no server on this PC.
          ['probeHost', () => probeHost('no\nhost', value as number)],
        ] as const) {
          const e = await rejection(call());
          expect(e.code).toBe('INVALID_ARGUMENT');
          expect(e.message).toMatch(new RegExp(`^${who}: timeout must be a number of milliseconds above 0 and at most 2147483647`));
          expect(e.message).toContain(shown);
        }
        // A request left behind would end later as an uncaught error; none was started.
        await new Promise(r => setTimeout(r, 20));
        expect(srv.requests()).toBe(0);
      } finally { srv.close(); }
    });
  }

  it('a probe with the largest timeout answers, and no timer overflows (its cap of four waits included)', async () => {
    const srv = await digestServer();
    const warnings = overflowWarnings();
    const delays = vi.spyOn(globalThis, 'setTimeout');
    try {
      expect(await probeProtocol('127.0.0.1', srv.port, false, MAX)).toBe('rws1');
      const ms = delays.mock.calls.map(call => call[1] ?? 0);
      expect(ms).toContain(MAX);
      expect(ms.every(d => d <= MAX)).toBe(true);
    } finally {
      await warnings.stop();
      srv.close();
    }
    expect(warnings.list).toEqual([]);
    expect(srv.requests()).toBe(1);
  });

  it('left out or null, a probe keeps its own default wait', async () => {
    const srv = await digestServer();
    const delays = vi.spyOn(globalThis, 'setTimeout');
    try {
      expect(await probeProtocol('127.0.0.1', srv.port, false, null as unknown as number)).toBe('rws1');
      expect(delays.mock.calls.map(call => call[1] ?? 0)).toContain(3000 * 4);
    } finally { srv.close(); }
  });
});
