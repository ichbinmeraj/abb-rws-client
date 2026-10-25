import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { ALL_TABLES, evidenceOf } from '../src/paths/index.js';
import { buildErrorsFrom, readPages } from '../src/commonReads.js';

/**
 * getBuildErrors, ABB's "Get Build Errors" on both generations (RWS 1.0 Rev M,
 * RWS 2.0 Rev L): `GET /rw/rapid/tasks/{task}/program/builderror`, optional
 * start and limit (at most 30), prev and next links, one `rap-builderrs`
 * entry per error with `ModuleName`, `row`, `column` and `error` (Rev L's
 * example adds `error-num`). The bodies below are ABB's examples, split into
 * the pages their links describe, and the empty answer RW 7.21.4 and 8.2.1
 * gave a raw GET (2026-10-06).
 */

// ABB's RWS 1.0 example (Rev M): the first two errors and a next link.
const REV_M_PAGE1 = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rapid</title><base href="http://127.0.0.1/rw/rapid/"/></head><body>
<div class="state"><a href="tasks/T_ROB1/program/builderror?limit=2" rel="self"/><a href="tasks/T_ROB1/program/builderror?start=1&amp;limit=2" rel="prev"/><a href="tasks/T_ROB1/program/builderror?start=3&amp;limit=2" rel="next"/>
<ul><li class="rap-builderrs" title="builderrs"><span class="ModuleName">MainModule</span><span class="row">15</span><span class="column">8</span><span class="error">S: "&#39;;&#39;"</span></li>
<li class="rap-builderrs" title="builderrs"><span class="ModuleName">MainModule</span><span class="row">19</span><span class="column">8</span><span class="error">S: "&#39;;&#39;"</span></li></ul></div></body></html>`;
// The last page: no next link ("Absence of prev and next link indicates first and last page").
const REV_M_PAGE2 = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rapid</title><base href="http://127.0.0.1/rw/rapid/"/></head><body>
<div class="state"><a href="tasks/T_ROB1/program/builderror?start=3&amp;limit=2" rel="self"/><a href="tasks/T_ROB1/program/builderror?start=1&amp;limit=2" rel="prev"/>
<ul><li class="rap-builderrs" title="builderrs"><span class="ModuleName">Other</span><span class="row">3</span><span class="column">1</span><span class="error">Reference error</span></li></ul></div></body></html>`;

// ABB's RWS 2.0 example (Rev L), with its error-num.
const REV_L_XHTML = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://localhost:443/rw/rapid/"/></head><body>
<div class="state"><a href="tasks/T_ROB1/program/builderror?limit=2" rel="self"/>
<ul><li class="rap-builderrs" title="builderrs1"><span class="ModuleName">MainModule</span><span class="row">15</span><span class="column">8</span><span class="error">S:"';'"</span></li>
<li class="rap-builderrs" title="builderrs2"><span class="ModuleName">MainModule</span><span class="row">19</span><span class="column">8</span><span class="error-num">135</span><span class="error">S:"';'"</span></li></ul></div></body></html>`;

// The same entries in the hal+json form a GET negotiates first, over two pages.
const REV_L_HAL_PAGE1 = JSON.stringify({
  _links: { base: { href: 'https://localhost:443/rw/rapid/' }, self: { href: 'tasks/T_ROB1/program/builderror?limit=1' }, next: { href: 'tasks/T_ROB1/program/builderror?start=2&amp;limit=1' } },
  state: [{ _type: 'rap-builderrs', _title: 'builderrs1', ModuleName: 'MainModule', row: '15', column: '8', error: "S:\"';'\"" }],
});
const REV_L_HAL_PAGE2 = JSON.stringify({
  _links: { base: { href: 'https://localhost:443/rw/rapid/' }, self: { href: 'tasks/T_ROB1/program/builderror?start=2&amp;limit=1' } },
  state: [{ _type: 'rap-builderrs', _title: 'builderrs2', ModuleName: 'MainModule', row: '19', column: '8', 'error-num': '135', error: "S:\"';'\"" }],
});

// What RW 7.21.4 and 8.2.1 answered a raw GET with no build error (2026-10-06).
const EMPTY_RECORDED = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:9403/rw/rapid/"/></head><body><div class="state"> <a href="tasks/T_ROB1/program/builderror?limit=30" rel="self"/> <ul> </ul></div></body></html>';

// What RW 7.21.4 answered with a module that does not build loaded (2026-10-21; RW 8.2.1 the same
// but its base): the hal+json form writes the error text unescaped, a quote and a tab inside the
// string, which is not JSON; the XHTML form of the same request is well-formed.
const BROKEN_HAL_RECORDED = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "tasks/T_ROB1/program/builderror?limit=30" } }  , "state" : [ { "_type" : "rap-builderrs", "_title" : "builderr1", "ModuleName" : "ZZ_BUILDERR", "row" : "5", "column" : "5", "error-num" : "128", "error" : "S:"zz_undeclared"\t", "type_of_error" : "SEMANTIC" } ]}';
const XHTML_RECORDED = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:5466/rw/rapid/"/></head><body><div class="state"> <a href="tasks/T_ROB1/program/builderror?limit=30" rel="self"/> <ul> <li class="rap-builderrs" title="builderr1"> <span class="ModuleName">ZZ_BUILDERR</span> <span class="row">5</span> <span class="column">5</span> <span class="error-num">128</span> <span class="error">S:"zz_undeclared"\t</span> <span class="type_of_error">SEMANTIC</span> </li> </ul></div></body></html>';

const REV_L_ERRORS = [
  { module: 'MainModule', row: 15, column: 8, error: "S:\"';'\"" },
  { module: 'MainModule', row: 19, column: 8, error: "S:\"';'\"", errorNumber: 135 },
];

interface Recorded { method: string; url: string; accept: string }

/** A route answers one body, or one per form: `hal` when the request asks for hal+json, `xhtml` otherwise. */
type Route = string | { hal: string; xhtml: string };

async function startServer(routes: Record<string, Route>): Promise<{ server: http.Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const accept = String(req.headers.accept ?? '');
      requests.push({ method: req.method ?? '', url: req.url ?? '', accept });
      const route = routes[req.url ?? ''];
      const body = typeof route === 'object' ? (accept.includes('hal+json') ? route.hal : route.xhtml) : route;
      if (body === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': body.startsWith('{') ? 'application/hal+json;v=2.0' : 'application/xhtml+xml;v=2.0' });
      res.end(body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function rws1Fake(routes: Record<string, string>): { urls: string[]; client: RwsClient } {
  const urls: string[] = [];
  const fake = {
    requestMastership: async () => {},
    releaseMastership: async () => {},
    request: async (method: string, url: string) => {
      urls.push(`${method} ${url}`);
      const body = routes[url];
      return body === undefined ? { status: 404, body: '' } : { status: 200, body };
    },
  };
  return { urls, client: fake as unknown as RwsClient };
}

const FIRST = '/rw/rapid/tasks/T_ROB1/program/builderror';

describe('getBuildErrors: the path rows', () => {
  it('are ABB\'s GET on both generations, live (RW 6.16.03, 7.21.4, 8.2.1, 2026-10-21)', () => {
    const op = ALL_TABLES.rapid.getBuildErrors;
    expect(op.rws1).toEqual({ method: 'GET', path: '/rw/rapid/tasks/{task}/program/builderror' });
    expect(op.rws2).toEqual({ method: 'GET', path: '/rw/rapid/tasks/{task}/program/builderror' });
    expect([evidenceOf(op, 'rws1'), evidenceOf(op, 'rws2')]).toEqual(['live', 'live']);
  });
});

describe('getBuildErrors on RWS 1.0', () => {
  it('reads ABB\'s example in XHTML, every page, entities decoded', async () => {
    const { urls, client } = rws1Fake({ [FIRST]: REV_M_PAGE1, [`${FIRST}?start=3&limit=2`]: REV_M_PAGE2 });
    await expect(new RWS1Adapter(client).getBuildErrors('T_ROB1')).resolves.toEqual([
      { module: 'MainModule', row: 15, column: 8, error: 'S: "\';\'"' },
      { module: 'MainModule', row: 19, column: 8, error: 'S: "\';\'"' },
      { module: 'Other', row: 3, column: 1, error: 'Reference error' },
    ]);
    // XHTML, as ABB documents it: no ?json=1.
    expect(urls).toEqual([`GET ${FIRST}`, `GET ${FIRST}?start=3&limit=2`]);
  });

  it('a refusal is the controller\'s typed error', async () => {
    const { client } = rws1Fake({});
    await expect(new RWS1Adapter(client).getBuildErrors('T_ROB1')).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('getBuildErrors on RWS 2.0', () => {
  it('reads ABB\'s Rev L example in XHTML, with the error number', async () => {
    const { server, url, requests } = await startServer({ [FIRST]: REV_L_XHTML });
    try {
      await expect(new RwsClient2(url, 'u', 'p').getBuildErrors('T_ROB1')).resolves.toEqual(REV_L_ERRORS);
      expect([...new Set(requests.map(r => `${r.method} ${r.url}`))]).toEqual([`GET ${FIRST}`]);
    } finally { server.close(); }
  });

  it('asks for XHTML: the hal+json RW 7.21.4 and 8.2.1 send with an error loaded is not JSON', async () => {
    expect(() => JSON.parse(BROKEN_HAL_RECORDED)).toThrow();
    const { server, url, requests } = await startServer({ [FIRST]: { hal: BROKEN_HAL_RECORDED, xhtml: XHTML_RECORDED } });
    try {
      await expect(new RwsClient2(url, 'u', 'p').getBuildErrors('T_ROB1')).resolves.toEqual([
        { module: 'ZZ_BUILDERR', row: 5, column: 5, error: 'S:"zz_undeclared"', errorNumber: 128, typeOfError: 'SEMANTIC' },
      ]);
      const reads = requests.filter(r => r.url === FIRST);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(r => r.accept === 'application/xhtml+xml;v=2.0')).toBe(true);
    } finally { server.close(); }
  });

  it('follows the next link of the XHTML form', async () => {
    const page1 = REV_L_XHTML.replace('?limit=2" rel="self"/>', '?limit=2" rel="self"/><a href="tasks/T_ROB1/program/builderror?start=3&amp;limit=2" rel="next"/>');
    const { server, url, requests } = await startServer({ [FIRST]: page1, [`${FIRST}?start=3&limit=2`]: REV_M_PAGE2 });
    try {
      await expect(new RwsClient2(url, 'u', 'p').getBuildErrors('T_ROB1')).resolves.toEqual([
        ...REV_L_ERRORS, { module: 'Other', row: 3, column: 1, error: 'Reference error' },
      ]);
      expect(requests.map(r => r.url)).toEqual([FIRST, `${FIRST}?start=3&limit=2`]);
    } finally { server.close(); }
  });

  it('a hal+json answer (a controller that does not honour the Accept) is read too, every page', async () => {
    const { server, url, requests } = await startServer({ [FIRST]: REV_L_HAL_PAGE1, [`${FIRST}?start=2&limit=1`]: REV_L_HAL_PAGE2 });
    try {
      await expect(new RwsClient2(url, 'u', 'p').getBuildErrors('T_ROB1')).resolves.toEqual(REV_L_ERRORS);
      expect(requests.map(r => r.url)).toEqual([FIRST, `${FIRST}?start=2&limit=1`]);
    } finally { server.close(); }
  });

  it('the answer RW 7.21.4 and 8.2.1 gave with no build error reads as []', async () => {
    const { server, url } = await startServer({ [FIRST]: EMPTY_RECORDED });
    try {
      await expect(new RwsClient2(url, 'u', 'p').getBuildErrors('T_ROB1')).resolves.toEqual([]);
    } finally { server.close(); }
  });

  it('through RobotManager.read', async () => {
    const { server, url } = await startServer({ [FIRST]: REV_L_XHTML });
    try {
      const mgr = new RobotManager();
      const m = mgr as unknown as { adapter: IRWSAdapter; _state: { connected: boolean }; sessionEpoch: number | null; connectEpoch: number };
      m.adapter = new RWS2Adapter(url, 'u', 'p');
      m._state.connected = true;
      m.sessionEpoch = m.connectEpoch;
      await expect(mgr.read('getBuildErrors', 'T_ROB1')).resolves.toEqual(REV_L_ERRORS);
    } finally { server.close(); }
  });
});

describe('buildErrorsFrom and readPages', () => {
  it('typed entries with no rap-builderrs, or a row that is not a number, are PARSE_ERROR', () => {
    const other = JSON.stringify({ state: [{ _type: 'rap-program', name: 'p' }] });
    expect(() => buildErrorsFrom([other], 'x')).toThrow(/no rap-builderrs entry \(classes seen: rap-program\)/);
    const noRow = JSON.stringify({ state: [{ _type: 'rap-builderrs', ModuleName: 'M', column: '1', error: 'e' }] });
    expect(() => buildErrorsFrom([noRow], 'x')).toThrow(expect.objectContaining({ code: 'PARSE_ERROR' }));
  });

  it('a next link to another resource, or back to a page already read, ends the walk', async () => {
    const elsewhere = '<html><head><base href="http://h/rw/rapid/"/></head><body><a href="tasks/T_ROB1/modules" rel="next"/></body></html>';
    const fetched: string[] = [];
    await readPages(FIRST, async p => { fetched.push(p); return elsewhere; }, 50);
    expect(fetched).toEqual([FIRST]);
    const loop = '<html><head><base href="http://h/rw/rapid/"/></head><body><a href="tasks/T_ROB1/program/builderror" rel="next"/></body></html>';
    fetched.length = 0;
    await readPages(FIRST, async p => { fetched.push(p); return loop; }, 50);
    expect(fetched).toEqual([FIRST]);
  });

  it('stops at maxPages', async () => {
    let n = 0;
    const pages = await readPages(FIRST, async () => {
      n += 1;
      return `<html><head><base href="http://h/rw/rapid/"/></head><body><a href="tasks/T_ROB1/program/builderror?start=${n + 1}" rel="next"/></body></html>`;
    }, 3);
    expect(pages).toHaveLength(3);
  });
});
