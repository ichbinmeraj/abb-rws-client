import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsClient } from '../src/RwsClient.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsError, SubscriptionUpdateError } from '../src/index.js';
import { setLogger } from '../src/Logger.js';
import { answer, scriptedServer, type ScriptedServer } from './helpers/scriptedHttp.js';

/**
 * A subscription group edit (PUT /subscription/{group}) naming an unknown
 * resource among valid ones. RobotWare 7.21.4 and 8.2.1 answer 400
 * -1073445866 "Invalid resource URI in Update Subscription request" and bind
 * the valid resources anyway (2026-09-29): the status div's self link names
 * the refused resource, and the state div lists one `-ev` entry per bound
 * resource with its value, in an order of the controller's own. The error the
 * client throws says which were bound and keeps the body.
 */

const SIGNALS = '/rw/iosystem/signals';

/** One bound signal's entry, as RW 7.21.4 and 8.2.1 list it in the 400 body. */
const signalEntry = (name: string, value: string): string =>
  `<li class="ios-signalstate-ev" title="${name}"><a href="${SIGNALS}/${name};state" rel="self"/>`
  + `<span class="lvalue">${value}</span><span class="lstate">not simulated</span>`
  + '<span class="quality">good</span><span class="time">0</span> </li>';

/** The 400 body of a group PUT with one refused resource (RW 7.21.4 / 8.2.1 shape). */
const refusedPut = (refused: string, entries: string[]): string =>
  '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> '
  + '<head><base href="https://127.0.0.1:80/"/> </head> <body> '
  + `<div class="status"> <a href="${refused}" rel="self"> </a> <span class="code">-1073445866</span> `
  + '<span class="msg">Invalid resource URI in Update Subscription request</span></div> '
  + `<div class="state"> ${entries.length ? `<ul> ${entries.join('  ')} </ul>` : ''}</div> </body></html>`;

interface Recorded { method: string; url: string; body: string }

async function startServer(
  status: number, body: string, contentType = 'application/xhtml+xml',
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(status, { 'Content-Type': contentType });
      res.end(body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const client2 = (port: number): RwsClient2 =>
  new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics');

const signals = (...names: string[]) => names.map(name => ({ type: 'signal' as const, name }));

describe('RWS 2.0 updateSubscriptionGroup: a 400 that bound part of the PUT', () => {
  it('reports the bound resources by path, whatever their order, and the refused one', async () => {
    // di_b is listed before di_a, as the controller may do.
    const body = refusedPut(`${SIGNALS}/no_such_sig;state`, [signalEntry('di_b', '1'), signalEntry('di_a', '0')]);
    const { server, port, requests } = await startServer(400, body);
    try {
      const err = await client2(port)
        .updateSubscriptionGroup('/subscription/2', signals('di_a', 'no_such_sig', 'di_b'))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubscriptionUpdateError);
      expect(err).toBeInstanceOf(RwsError);
      const e = err as SubscriptionUpdateError;
      expect(e).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        httpStatus: 400,
        controllerCode: -1073445866,
        controllerMsg: 'Invalid resource URI in Update Subscription request',
      });
      expect(e.message).toContain('Invalid resource URI in Update Subscription request');
      expect([...e.bound].sort()).toEqual([`${SIGNALS}/di_a`, `${SIGNALS}/di_b`]);
      expect(e.refused).toEqual([`${SIGNALS}/no_such_sig`]);
      expect(e.body).toBe(body);
      expect(e.body).toContain('lvalue');
      expect(e.responseBody).toBe(body);
      // One PUT, not re-sent.
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['PUT /subscription/2']);
    } finally { server.close(); }
  });

  it('a PUT naming only the unknown resource: nothing bound, the refused one named', async () => {
    const body = refusedPut(`${SIGNALS}/no_such_sig;state`, []);
    const { server, port } = await startServer(400, body);
    try {
      const err = await client2(port)
        .updateSubscriptionGroup('/subscription/2', signals('no_such_sig'))
        .catch((e: unknown) => e) as SubscriptionUpdateError;
      expect(err).toBeInstanceOf(SubscriptionUpdateError);
      expect(err.bound).toEqual([]);
      expect(err.refused).toEqual([`${SIGNALS}/no_such_sig`]);
      expect(err.body).toBe(body);
    } finally { server.close(); }
  });

  it('reads panel entries (self link without a suffix) and links written with scheme and host', async () => {
    const panel = '<li class="pnl-speedratio-ev" title="speedratio"><a href="/rw/panel/speedratio" rel="self"></a>'
      + '<span class="speedratio">100</span></li>';
    const absolute = signalEntry('di_a', '0').replace(`href="${SIGNALS}`, `href="https://127.0.0.1:80${SIGNALS}`);
    const body = refusedPut(`${SIGNALS}/no_such_sig;state`, [panel, absolute, signalEntry('di_a', '0')]);
    const { server, port } = await startServer(400, body);
    try {
      const err = await client2(port)
        .updateSubscriptionGroup('/subscription/2', ['speedratio', ...signals('di_a', 'no_such_sig')])
        .catch((e: unknown) => e) as SubscriptionUpdateError;
      expect(err).toBeInstanceOf(SubscriptionUpdateError);
      // Each path once.
      expect([...err.bound].sort()).toEqual([`${SIGNALS}/di_a`, '/rw/panel/speedratio']);
    } finally { server.close(); }
  });

  it('names every refused resource when the answer carries one status div each', async () => {
    const second = `<div class="status"> <a href="${SIGNALS}/no_such_2;state" rel="self"> </a> `
      + '<span class="code">-1073445866</span> <span class="msg">Invalid resource URI in Update Subscription request</span></div> ';
    const body = refusedPut(`${SIGNALS}/no_such_1;state`, [signalEntry('di_a', '0')])
      .replace('<div class="state">', `${second}<div class="state">`);
    const { server, port } = await startServer(400, body);
    try {
      const err = await client2(port)
        .updateSubscriptionGroup('/subscription/2', signals('no_such_1', 'di_a', 'no_such_2'))
        .catch((e: unknown) => e) as SubscriptionUpdateError;
      expect(err).toBeInstanceOf(SubscriptionUpdateError);
      expect(err.refused).toEqual([`${SIGNALS}/no_such_1`, `${SIGNALS}/no_such_2`]);
      expect(err.bound).toEqual([`${SIGNALS}/di_a`]);
    } finally { server.close(); }
  });

  it('gives an event-log entry as its domain, the path the request named', async () => {
    // The entry as RW 6.16.03 lists it (2026-09-29): its self link is the
    // newest message, not the subscribed domain.
    const elog = '<li class="elog-message-ev" title="message"><a href="/rw/elog/0/52" rel="self"/><span class="seqnum">52</span></li>';
    const body = refusedPut(`${SIGNALS}/no_such_sig;state`, [elog, signalEntry('di_a', '0')]);
    const { server, port } = await startServer(400, body);
    try {
      const err = await client2(port)
        .updateSubscriptionGroup('/subscription/2', [{ type: 'elog', domain: 0 }, ...signals('di_a', 'no_such_sig')])
        .catch((e: unknown) => e) as SubscriptionUpdateError;
      expect(err).toBeInstanceOf(SubscriptionUpdateError);
      expect([...err.bound].sort()).toEqual(['/rw/elog/0', `${SIGNALS}/di_a`]);
    } finally { server.close(); }
  });

  it('a 400 whose body cannot be read: empty lists, the body kept', async () => {
    const { server, port } = await startServer(400, 'Bad Request', 'text/plain');
    try {
      const err = await client2(port)
        .updateSubscriptionGroup('/subscription/2', signals('di_a'))
        .catch((e: unknown) => e) as SubscriptionUpdateError;
      expect(err).toBeInstanceOf(SubscriptionUpdateError);
      expect(err.httpStatus).toBe(400);
      expect(err.bound).toEqual([]);
      expect(err.refused).toEqual([]);
      expect(err.body).toBe('Bad Request');
    } finally { server.close(); }
  });

  it('a 400 cut off mid-body is not read as an answer: a plain NETWORK_ERROR, no lists', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/xhtml+xml', 'Content-Length': '4000' });
        res.write('<html><body><div class="status">');
        setTimeout(() => res.socket?.destroy(), 20);
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const err = await client2((server.address() as AddressInfo).port)
        .updateSubscriptionGroup('/subscription/2', signals('di_a'))
        .catch((e: unknown) => e) as RwsError;
      expect(err).toBeInstanceOf(RwsError);
      expect(err).not.toBeInstanceOf(SubscriptionUpdateError);
      expect(err.code).toBe('NETWORK_ERROR');
      expect(err.responseBody).toBeUndefined();
    } finally { server.close(); }
  });

  it('a 200 still returns the body, and a status other than 400 stays a plain RwsError with its body', async () => {
    const ok = await startServer(200, '<html><body><div class="state"></div></body></html>');
    try {
      await expect(client2(ok.port).updateSubscriptionGroup('/subscription/2', signals('di_a')))
        .resolves.toBe('<html><body><div class="state"></div></body></html>');
    } finally { ok.server.close(); }

    const notFound = '<html><body><div class="status"><span class="code">-1073445866</span>'
      + '<span class="msg">wrong uri</span></div></body></html>';
    const gone = await startServer(404, notFound);
    try {
      const err = await client2(gone.port)
        .updateSubscriptionGroup('/subscription/2', signals('di_a'))
        .catch((e: unknown) => e) as RwsError;
      expect(err).toBeInstanceOf(RwsError);
      expect(err).not.toBeInstanceOf(SubscriptionUpdateError);
      expect(err.httpStatus).toBe(404);
      expect(err.responseBody).toBe(notFound);
    } finally { gone.server.close(); }
  });

  it('an RWS 2.0 request answered with an HTTP error keeps the controller\'s body on RwsError.responseBody', async () => {
    const body = '<html><body><div class="status"><span class="code">-1073435900</span>'
      + '<span class="msg">Group 2 does not belong to Client 30.</span></div></body></html>';
    const { server, port } = await startServer(400, body);
    try {
      const err = await client2(port).getSubscriptionGroup('/subscription/2').catch((e: unknown) => e) as RwsError;
      expect(err).toBeInstanceOf(RwsError);
      expect(err.controllerCode).toBe(-1073435900);
      expect(err.responseBody).toBe(body);
    } finally { server.close(); }
  });
});

describe('SubscriptionUpdateError', () => {
  it('carries the code, status, controller fields and message of the error it replaces', () => {
    const source = new RwsError('refused', 'RESOURCE_NOT_FOUND', 400, 'detail', -1073445866, 'Invalid resource URI', undefined, '<html/>');
    const e = new SubscriptionUpdateError(source, { bound: [`${SIGNALS}/di_a`] });
    expect(e).toBeInstanceOf(RwsError);
    expect(e).toBeInstanceOf(SubscriptionUpdateError);
    expect(e).toMatchObject({
      message: 'refused', code: 'RESOURCE_NOT_FOUND', httpStatus: 400, rwsDetail: 'detail',
      controllerCode: -1073445866, controllerMsg: 'Invalid resource URI', responseBody: '<html/>',
      bound: [`${SIGNALS}/di_a`], refused: [], body: '<html/>',
    });
    expect(e.name).toBe('SubscriptionUpdateError');
  });
});

// ─── RWS 1.0 ────────────────────────────────────────────────────────────────
// RW 6.16.03 answers a refused resource in a group CREATE with this same shape
// (status div with the resource's self link, -1073445866, then a state div;
// 2026-09-29). A 1.0 group PUT that mixes valid and unknown resources has not
// been observed; the bodies below carry the 2.0 bound entries in that shape.

const WWW_AUTH = 'Digest realm="robot", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth", algorithm=MD5, opaque="5ccc069c403ebaf9f0171e9517f40e41"';

const rws1RefusedPut = (refused: string, entries: string[]): string =>
  '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Error</title> '
  + '<base href="http://127.0.0.1:4578/" /> </head> <body> '
  + `<div class="status"> <a href="${refused}" rel="self"> </a> <span class="code">-1073445866</span> `
  + '<span class="msg">Invalid resource URI in Update Subscription request</span></div> '
  + `<div class="state"> ${entries.length ? `<ul> ${entries.join('  ')} </ul>` : ''}</div> </body></html>`;

describe('RWS 1.0 updateSubscriptionGroup: a 400 that bound part of the PUT', () => {
  let srv: ScriptedServer | undefined;

  afterEach(async () => {
    await srv?.close();
    srv = undefined;
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
  });

  it('through the session (which throws on the 400): bound and refused read from the body', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const body = rws1RefusedPut(`${SIGNALS}/no_such_sig;state`, [signalEntry('di_b', '1'), signalEntry('di_a', '0')]);
    // A scripted local "controller", real HTTP whichever transport the RWS 1.0 session picks.
    srv = await scriptedServer();
    srv.once(
      answer(401, '', { 'www-authenticate': WWW_AUTH }),
      answer(400, body, { 'content-type': 'application/xhtml+xml' }),
    );
    const adapter = new RWS1Adapter(new RwsClient({ host: '127.0.0.1', port: srv.port, requestIntervalMs: 0 }));
    const err = await adapter
      .updateSubscriptionGroup('/subscription/2', signals('di_a', 'no_such_sig', 'di_b'))
      .catch((e: unknown) => e) as SubscriptionUpdateError;
    expect(err).toBeInstanceOf(SubscriptionUpdateError);
    expect(err).toMatchObject({ code: 'RESOURCE_NOT_FOUND', httpStatus: 400, controllerCode: -1073445866 });
    expect([...err.bound].sort()).toEqual([`${SIGNALS}/di_a`, `${SIGNALS}/di_b`]);
    expect(err.refused).toEqual([`${SIGNALS}/no_such_sig`]);
    expect(err.body).toBe(body);
    expect(err.responseBody).toBe(body);
  });

  it('through a client that returns the 400 instead of throwing', async () => {
    const body = rws1RefusedPut(`${SIGNALS}/no_such_sig;state`, [signalEntry('di_a', '0')]);
    const fake = {
      requestMastership: async () => {},
      releaseMastership: async () => {},
      request: async () => ({ status: 400, body }),
    };
    const err = await new RWS1Adapter(fake as unknown as RwsClient)
      .updateSubscriptionGroup('/subscription/2', signals('di_a', 'no_such_sig'))
      .catch((e: unknown) => e) as SubscriptionUpdateError;
    expect(err).toBeInstanceOf(SubscriptionUpdateError);
    expect(err).toMatchObject({ httpStatus: 400, controllerCode: -1073445866 });
    expect(err.bound).toEqual([`${SIGNALS}/di_a`]);
    expect(err.refused).toEqual([`${SIGNALS}/no_such_sig`]);
    expect(err.body).toBe(body);
  });

  // RW 6.16.03 answers a create that mixes refused and valid resources 201,
  // naming the refused ones only in status divs (recorded 2026-09-29). A PUT
  // answered the same way is a partial bind too, thrown like the 400.
  const CREATE_201_PARTIAL = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Event</title><base href="http://127.0.0.1:4578/"/> </head> <body> <div class="status"> <a href="/rw/panel/opmode;opmode" rel="self"> </a> <span class="code">-1073445866</span> <span class="msg">Invalid resource URI in Create Subscription request</span></div> <div class="state"><a href="subscription/75" rel="group"></a><a href="ws://127.0.0.1:4578/poll/75" rel="self"></a><a href="subscription/75?action=show" rel="action"></a> <ul> <li class="elog-message-ev" title="message"><a href="/rw/elog/0/52" rel="self"/><span class="seqnum">52</span></li>  <li class="pnl-coldetstate-ev" title="coldetstate"><a href="/rw/panel/coldetstate" rel="self"></a><span class="coldetstate">INIT</span></li>  <li class="pnl-ctrlstate-ev" title="ctrlstate"><a href="/rw/panel/ctrlstate" rel="self"></a><span class="ctrlstate">motoron</span></li>  <li class="pnl-speedratio-ev" title="speedratio"><a href="/rw/panel/speedratio" rel="self"></a><span class="speedratio">100</span></li>  <li class="rap-ctrlexecstate-ev" title="ctrlexecstate"><a href="/rw/rapid/execution;ctrlexecstate" rel="self"/><span class="ctrlexecstate">stopped</span></li>  </ul> </div> </body></html>';

  const answering = (status: number, body: string) => ({
    requestMastership: async () => {},
    releaseMastership: async () => {},
    request: async () => ({ status, body }),
  }) as unknown as RwsClient;

  it('a 2xx whose status divs name refused resources is thrown as a partial bind, with its own status', async () => {
    const err = await new RWS1Adapter(answering(200, CREATE_201_PARTIAL))
      .updateSubscriptionGroup('/subscription/75', [
        'controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 },
      ])
      .catch((e: unknown) => e) as SubscriptionUpdateError;
    expect(err).toBeInstanceOf(SubscriptionUpdateError);
    expect(err).toMatchObject({ code: 'RESOURCE_NOT_FOUND', httpStatus: 200, controllerCode: -1073445866 });
    expect(err.refused).toEqual(['/rw/panel/opmode']);
    expect([...err.bound].sort()).toEqual([
      '/rw/elog/0', '/rw/panel/coldetstate', '/rw/panel/ctrlstate', '/rw/panel/speedratio', '/rw/rapid/execution',
    ]);
    expect(err.body).toBe(CREATE_201_PARTIAL);
  });

  it('a 2xx without a refused resource is returned as the answer', async () => {
    const ok = CREATE_201_PARTIAL.replace(/<div class="status">[\s\S]*?<\/div>/, '');
    await expect(new RWS1Adapter(answering(200, ok)).updateSubscriptionGroup('/subscription/75', ['speedratio']))
      .resolves.toBe(ok);
  });

  it('a 400 with one status div per refused resource names each of them', async () => {
    const second = `<div class="status"> <a href="${SIGNALS}/no_such_2;state" rel="self"> </a> `
      + '<span class="code">-1073445866</span> <span class="msg">Invalid resource URI in Update Subscription request</span></div> ';
    const body = rws1RefusedPut(`${SIGNALS}/no_such_1;state`, [])
      .replace('<div class="state">', `${second}<div class="state">`);
    const err = await new RWS1Adapter(answering(400, body))
      .updateSubscriptionGroup('/subscription/2', signals('no_such_1', 'no_such_2'))
      .catch((e: unknown) => e) as SubscriptionUpdateError;
    expect(err).toBeInstanceOf(SubscriptionUpdateError);
    expect(err.refused).toEqual([`${SIGNALS}/no_such_1`, `${SIGNALS}/no_such_2`]);
    expect(err.bound).toEqual([]);
  });
});
