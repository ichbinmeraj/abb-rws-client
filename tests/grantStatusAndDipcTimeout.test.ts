import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsClient } from '../src/RwsClient.js';
import { RWS1Adapter, RWS1_DIPC_MAX_WAIT_MS } from '../src/RWS1Adapter.js';
import * as R2 from '../src/ResourceMapper2.js';
import { RwsError } from '../src/types.js';

/**
 * Two reads against local 127.0.0.1 servers - no live controller:
 *
 *  - RWS 2.0 checkGrantExists reads the grant status in both representations.
 *    hal+json carries it as the `status` field of `user-grant-status`; XHTML,
 *    which the client uses for every later GET once a hal+json request
 *    answered 406 or not as JSON, carries it as `<span class="grant-exist">`.
 *  - The DIPC read passes its wait as ABB's `timeout` query parameter, and the
 *    client's own limits for that one request leave room for the wait: on
 *    RWS 2.0 the idle timeout and the deadline, on RWS 1.0 the request
 *    timeout.
 */

interface RecordedRequest { method: string; url: string; accept: string }

/** Plain HTTP server that records every request and delegates to `handle`. */
async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; requests: RecordedRequest[]; close: () => void }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', accept: String(req.headers.accept ?? '') });
      handle(req, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const close = (): void => { server.closeAllConnections(); server.close(); };
  return { server, port: (server.address() as AddressInfo).port, requests, close };
}

const HAL = { 'Content-Type': 'application/hal+json;v=2.0' };
const XHTML = { 'Content-Type': 'application/xhtml+xml;v=2.0' };

/** The grant-exists answer as RW 7.21.4 serves it over XHTML. */
const xhtmlGrant = (span: string): string =>
  '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> '
  + '<base href="http://127.0.0.1/users/grant-exists/"/> </head> <body> <div class="state"> '
  + `<a href="" rel="self"></a><ul><li class="user-grant-status" title="grant-status"> ${span}</li></ul></div> </body></html>`;

/** The grant-exists answer as RW 7.21.4 serves it over hal+json. */
const halGrant = (fields: string): string =>
  `{"_links":{"base":{"href":"http://127.0.0.1/users/grant-exists/"},"self":{"href":""}},"state":[{"_type":"user-grant-status","_title":"grant-exist"${fields}}]}`;

/** A server that refuses hal+json with 406 and answers XHTML with `body()`. */
function xhtmlOnly(body: () => string): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    if (String(req.headers.accept ?? '').includes('hal+json')) { res.writeHead(406); res.end(); return; }
    res.writeHead(200, XHTML);
    res.end(body());
  };
}

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  try { await p; } catch (e) { return e as RwsError; }
  throw new Error('expected a rejection');
}

describe('checkGrantExists reads the grant status in both representations', () => {
  it('reads the XHTML grant-exist span after a hal+json 406', async () => {
    let value = 'true';
    const { port, requests, close } = await startServer(xhtmlOnly(() => xhtmlGrant(`<span class="grant-exist">${value}</span>`)));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await client.checkGrantExists('UAS_REMOTE_LOGIN')).toBe(true);
      value = 'false';
      expect(await client.checkGrantExists('UAS_REMOTE_LOGIN')).toBe(false);
      // The first GET asked for hal+json and was refused; every later GET goes straight to XHTML.
      expect(requests.map(r => r.accept.includes('hal+json'))).toEqual([true, false, false]);
      expect(requests.every(r => r.url === '/users/grant-exists?grant=UAS_REMOTE_LOGIN')).toBe(true);
    } finally { close(); }
  });

  it('reads the XHTML span when a hal+json GET was answered with XHTML', async () => {
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(200, XHTML);
      res.end(xhtmlGrant('<span class="grant-exist">true</span>'));
    });
    try {
      expect(await new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p').checkGrantExists('UAS_RAPID_EXECUTE')).toBe(true);
    } finally { close(); }
  });

  it('still reads the hal+json status field, held and not held', async () => {
    let value = 'true';
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(200, HAL);
      res.end(halGrant(`,"status":"${value}"`));
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await client.checkGrantExists('UAS_RAPID_EXECUTE')).toBe(true);
      value = 'false';
      expect(await client.checkGrantExists('UAS_UAS_ADMINISTRATION')).toBe(false);
    } finally { close(); }
  });

  it('rejects a hal+json answer without a status with PARSE_ERROR instead of reporting "not held"', async () => {
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(200, HAL);
      res.end(halGrant(''));
    });
    try {
      const e = await rejection(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p').checkGrantExists('UAS_REMOTE_LOGIN'));
      expect(e).toBeInstanceOf(RwsError);
      expect(e.code).toBe('PARSE_ERROR');
    } finally { close(); }
  });

  it('rejects an XHTML answer without a grant-exist span with PARSE_ERROR', async () => {
    const { port, close } = await startServer(xhtmlOnly(() => xhtmlGrant('<span class="other">true</span>')));
    try {
      const e = await rejection(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p').checkGrantExists('UAS_REMOTE_LOGIN'));
      expect(e).toBeInstanceOf(RwsError);
      expect(e.code).toBe('PARSE_ERROR');
    } finally { close(); }
  });

  it('rejects a status that is neither true nor false with PARSE_ERROR', async () => {
    const { port, close } = await startServer((_req, res) => {
      res.writeHead(200, HAL);
      res.end(halGrant(',"status":""'));
    });
    try {
      const e = await rejection(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p').checkGrantExists('UAS_REMOTE_LOGIN'));
      expect(e.code).toBe('PARSE_ERROR');
    } finally { close(); }
  });
});

describe('RWS 2.0 DIPC read passes its wait as ABB\'s timeout parameter', () => {
  const DIPC_READ = '{"_links":{"base":{"href":"http://127.0.0.1/rw/dipc/"}},"state":[{"_type":"dipc-read","_title":"q1","dipc-data":"hi","dipc-msgtype":"0"}]}';

  it('builds GET /rw/dipc/{queue}?timeout=N in whole, non-negative milliseconds', () => {
    expect(R2.readDipcMessage('Q', 250)).toBe('/rw/dipc/Q?timeout=250');
    expect(R2.readDipcMessage('Q')).toBe('/rw/dipc/Q?timeout=0');
    expect(R2.readDipcMessage('Q', 12.7)).toBe('/rw/dipc/Q?timeout=12');
    expect(R2.readDipcMessage('Q', -5)).toBe('/rw/dipc/Q?timeout=0');
    expect(R2.readDipcMessage('Q', Number.NaN)).toBe('/rw/dipc/Q?timeout=0');
    expect(R2.readDipcMessage('Q', Number.POSITIVE_INFINITY)).toBe('/rw/dipc/Q?timeout=0');
    expect(R2.readDipcMessage('Q', 250)).not.toMatch(/dipc-timeout/);
  });

  it('readDipcMessage sends timeout, not dipc-timeout, and returns the message', async () => {
    const { port, requests, close } = await startServer((_req, res) => {
      res.writeHead(200, HAL);
      res.end(DIPC_READ);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await client.readDipcMessage('q1', 2500)).toEqual({ payload: 'hi', type: '0' });
      const read = requests.find(r => r.url.startsWith('/rw/dipc/q1'));
      expect(read?.method).toBe('GET');
      expect(read?.url).toBe('/rw/dipc/q1?timeout=2500');
      expect(read?.url).not.toMatch(/dipc-timeout/);
    } finally { close(); }
  });

  it('a read the controller holds for its wait is not cut off by the client\'s own timers', async () => {
    // The controller answers a DIPC read when a message arrives or the wait
    // runs out, so it may stay silent for the whole wait. Here the client's
    // idle timeout (200 ms) and deadline (300 ms) are both shorter than the
    // 700 ms the server holds the read; the 1000 ms wait must cover it.
    const HOLD_MS = 700;
    const { port, close } = await startServer((req, res) => {
      setTimeout(() => {
        if (res.destroyed) { return; }
        res.writeHead(200, HAL);
        res.end((req.url ?? '').startsWith('/rw/dipc/q1')
          ? DIPC_READ
          : '{"_links":{"base":{"href":"http://127.0.0.1/rw/"}},"state":[]}');
      }, HOLD_MS);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { timeout: 200, requestDeadlineMs: 300 });
      expect(await client.readDipcMessage('q1', 1000)).toEqual({ payload: 'hi', type: '0' });
      // Every other request keeps the instance's limits.
      const e = await rejection(client.listDipcQueues());
      expect(e).toBeInstanceOf(RwsError);
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/timeout/i);
    } finally { close(); }
  });
});

describe('RWS 1.0 DIPC read: the wait is not cut off by the client\'s request timeout', () => {
  const DIPC_READ_RW6 = JSON.stringify({ _embedded: { _state: [{ _type: 'dipc-read-li', 'dipc-data': '"hello"', 'dipc-msgtype': '0' }] } });
  const LISTING_RW6 = JSON.stringify({ _embedded: { _state: [{ _type: 'dipc-queue-li', _title: 'q1' }] } });
  const HOLD_MS = 600;

  /** An RWS 1.0 server that answers every request after HOLD_MS (a DIPC read with its message). */
  async function slowRw6(): ReturnType<typeof startServer> {
    return startServer((req, res) => {
      setTimeout(() => {
        if (res.destroyed) { return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end((req.url ?? '').includes('action=dipc-read') ? DIPC_READ_RW6 : LISTING_RW6);
      }, HOLD_MS);
    });
  }

  it('a read the controller holds for its wait returns the message although the wait outlasts the client timeout', async () => {
    // The client's request timeout (200 ms) is shorter than the 600 ms the
    // server holds the read; the 1500 ms wait must cover it.
    const { port, requests, close } = await slowRw6();
    try {
      const client = new RwsClient({ host: '127.0.0.1', port, timeout: 200, requestIntervalMs: 0 });
      const adapter = new RWS1Adapter(client);
      expect(await adapter.readDipcMessage('q1', 1500)).toEqual({ payload: '"hello"', type: '0' });
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /rw/dipc/q1?action=dipc-read&timeout=1500&json=1']);
    } finally { close(); }
  });

  it('every other request, and a read without a wait, keeps the client timeout', async () => {
    const { port, close } = await slowRw6();
    try {
      const client = new RwsClient({ host: '127.0.0.1', port, timeout: 200, requestIntervalMs: 0 });
      const e = await rejection(client.request('GET', '/rw/dipc?json=1'));
      expect(e).toBeInstanceOf(RwsError);
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/timed out after 200ms/);
      // No wait (or one that is not a whole, non-negative number of ms): no extension.
      const adapter = new RWS1Adapter(client);
      expect(await adapter.readDipcMessage('q1')).toBeNull();
      expect(await adapter.readDipcMessage('q1', -5)).toBeNull();
    } finally { close(); }
  });

  it('a request that holds names its own limit when it is cut off', async () => {
    const { port, close } = await slowRw6();
    try {
      const client = new RwsClient({ host: '127.0.0.1', port, timeout: 100, requestIntervalMs: 0 });
      // 100 ms timeout + 150 ms hold = 250 ms, still short of the 600 ms the server takes.
      const e = await rejection(client.request('GET', '/rw/dipc/q1?action=dipc-read&timeout=150&json=1', undefined, { holdMs: 150 }));
      expect(e.code).toBe('NETWORK_ERROR');
      expect(e.message).toMatch(/timed out after 250ms/);
    } finally { close(); }
  });

  it('a wait longer than the transport allows is capped at 280 s', async () => {
    const { port, requests, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(DIPC_READ_RW6);
    });
    try {
      const client = new RwsClient({ host: '127.0.0.1', port, timeout: 2000, requestIntervalMs: 0 });
      const adapter = new RWS1Adapter(client);
      expect(await adapter.readDipcMessage('q1', 400_000)).toEqual({ payload: '"hello"', type: '0' });
      expect(requests.map(r => r.url)).toEqual([`/rw/dipc/q1?action=dipc-read&timeout=${RWS1_DIPC_MAX_WAIT_MS}&json=1`]);
      expect(RWS1_DIPC_MAX_WAIT_MS).toBe(280_000);
    } finally { close(); }
  });

  it('the wait holds the client\'s serial request queue: a request queued behind it goes out after it answers', async () => {
    const { port, requests, close } = await slowRw6();
    try {
      const client = new RwsClient({ host: '127.0.0.1', port, timeout: 2000, requestIntervalMs: 0 });
      const adapter = new RWS1Adapter(client);
      const read = adapter.readDipcMessage('q1', 1500);
      const list = adapter.listDipcQueues();
      await new Promise(r => setTimeout(r, HOLD_MS / 2));
      // Halfway through the held read, only the read has been sent.
      expect(requests.map(r => r.url)).toEqual(['/rw/dipc/q1?action=dipc-read&timeout=1500&json=1']);
      expect(await read).toEqual({ payload: '"hello"', type: '0' });
      expect((await list).map(q => q.name)).toEqual(['q1']);
      expect(requests.map(r => r.url)).toEqual(['/rw/dipc/q1?action=dipc-read&timeout=1500&json=1', '/rw/dipc?json=1']);
    } finally { close(); }
  });
});
