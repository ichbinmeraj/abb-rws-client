import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { setLogger } from '../src/Logger.js';

/**
 * RWS 2.0 signal search paging (cross-check 2026-09-29, quirk on the
 * signal-search semantics).
 *
 * The controller pages a signal search at 100 hits with a `next` link, the
 * same way it pages the plain signal list. Observed 2026-09-27 on an RW 8.1.1
 * virtual controller: an empty `signal-search` answered 100 hits with
 * `"next": { "href": "signals/signal-search?start=100&amp;limit=100" }`
 * (relative to the response base `/rw/iosystem/`), and a POST of the same body
 * to that path answered the remaining 41 with a `first` link and no `next`;
 * `signal-search-ex` with `invert=false` paged the same way. Up to 1.3.x the
 * client read one page only. The wire shapes below are those captures, cut
 * down to a few signals; the `<a rel="next">` XHTML form is the one the
 * signal list is verified to serve and `nextPagePath` reads both.
 */

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface Recorded { method: string; url: string; body: string; contentType: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    void collectBody(req).then(body => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', body,
        contentType: (req.headers['content-type'] ?? '') as string,
      });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const client = (port: number): RwsClient2 =>
  new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics');

/** One `ios-signal-li` entry in the hal+json shape RW 8.1.1 served on 2026-09-27. */
const halSignal = (title: string, type = 'DO'): string => {
  const name = title.split('/').pop() ?? title;
  return `{ "_links" : { "self" : { "href" : "signals/${title}" } }, "_type" : "ios-signal-li", `
    + `"_title" : "${title}", "name" : "${name}", "type" : "${type}", "category" : "internal", `
    + `"lvalue" : "0", "lstate" : "not simulated" }`;
};

/** A hal+json search page; `links` is the extra link block after `self`. */
const halPage = (self: string, links: string, entries: string[]): string =>
  `{ "_links" : { "base" : { "href" : "https://127.0.0.1:80/rw/iosystem/" } ,"self" : { "href" : "${self}" }${links} }  , `
  + `"_embedded" : { "resources" : [ ${entries.join(' , ')} ] }}`;

const xhtmlSignal = (title: string, type = 'DI'): string => {
  const name = title.split('/').pop() ?? title;
  return `<li class="ios-signal-li" title="${title}"><span class="name">${name}</span>`
    + `<span class="type">${type}</span><span class="lvalue">1</span></li>`;
};

const xhtmlPage = (entries: string[], nextHref?: string): string =>
  '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
  + '<head><base href="http://127.0.0.1/rw/iosystem/"/></head><body><div class="state"><ul>'
  + entries.join('')
  + '</ul></div>'
  + (nextHref ? `<a href="${nextHref}" rel="next">next</a>` : '')
  + '</body></html>';

const hal = (res: http.ServerResponse, body: string): void => {
  res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' }); res.end(body);
};
const xhtml = (res: http.ServerResponse, body: string): void => {
  res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' }); res.end(body);
};

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('RWS 2.0 signal search follows the controller\'s next links', () => {
  it('searchSignals reads both pages in order, re-sending the same criteria to the next page path', async () => {
    const page1 = halPage(
      'signals/signal-search?limit=100',
      ' , "next" : { "href" : "signals/signal-search?start=100&amp;limit=100" }',
      [halSignal('IntBus/EPanel/AutoModeStatus'), halSignal('IntBus/EPanel/EStopStatus')],
    );
    const page2 = halPage(
      'signals/signal-search?start=100&amp;limit=100',
      ' , "first" : { "href" : "signals/signal-search?start=0&amp;limit=100" }',
      [halSignal('SC1CBCOK'), halSignal('CollaborativeOperationIsActive')],
    );
    const { server, port, requests } = await startServer((req, res) => {
      hal(res, req.url?.includes('start=100') ? page2 : page1);
    });
    try {
      const hits = await client(port).searchSignals({ type: 'DO' });
      expect(hits.map(s => s.name)).toEqual([
        'AutoModeStatus', 'EStopStatus', 'SC1CBCOK', 'CollaborativeOperationIsActive',
      ]);
      expect(requests).toHaveLength(2);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/rw/iosystem/signals/signal-search');
      expect(requests[0].body).toBe('type=DO');
      expect(requests[1].method).toBe('POST');
      // Resolved against the response base /rw/iosystem/, with &amp; unescaped.
      expect(requests[1].url).toBe('/rw/iosystem/signals/signal-search?start=100&limit=100');
      expect(requests[1].body).toBe('type=DO');
    } finally { server.close(); }
  });

  it('searchSignalsEx reads both pages with the bespoke content type on every page', async () => {
    const page1 = halPage(
      'signals/signal-search-ex?limit=100',
      ' , "next" : { "href" : "signals/signal-search-ex?start=100&amp;limit=100" }',
      [halSignal('IntegratedIONetwork/IntegratedIOInternalDevice/IIO_do8')],
    );
    const page2 = halPage(
      'signals/signal-search-ex?start=100&amp;limit=100',
      ' , "first" : { "href" : "signals/signal-search-ex?start=0&amp;limit=100" }',
      [halSignal('IntegratedIONetwork/IntegratedIOInternalDevice/IIO_do7')],
    );
    const { server, port, requests } = await startServer((req, res) => {
      hal(res, req.url?.includes('start=100') ? page2 : page1);
    });
    try {
      const hits = await client(port).searchSignalsEx([{ invert: false }]);
      expect(hits.map(s => s.name)).toEqual(['IIO_do8', 'IIO_do7']);
      expect(requests.map(r => r.url)).toEqual([
        '/rw/iosystem/signals/signal-search-ex',
        '/rw/iosystem/signals/signal-search-ex?start=100&limit=100',
      ]);
      for (const r of requests) {
        expect(r.method).toBe('POST');
        expect(r.body).toBe('invert=false');
        expect(r.contentType).toBe('application/x-www-form-urlencoded;v=2.0');
      }
    } finally { server.close(); }
  });

  it('follows the XHTML rel="next" form too', async () => {
    const { server, port, requests } = await startServer((req, res) => {
      xhtml(res, req.url?.includes('start=100')
        ? xhtmlPage([xhtmlSignal('n/d/sigB')])
        : xhtmlPage([xhtmlSignal('n/d/sigA')], 'signals/signal-search?start=100&amp;limit=100'));
    });
    try {
      const hits = await client(port).searchSignals({ name: 'sig' });
      expect(hits.map(s => s.name)).toEqual(['sigA', 'sigB']);
      expect(requests.map(r => r.url)).toEqual([
        '/rw/iosystem/signals/signal-search',
        '/rw/iosystem/signals/signal-search?start=100&limit=100',
      ]);
    } finally { server.close(); }
  });

  it('a single page needs one request', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      hal(res, halPage('signals/signal-search', '', [halSignal('IntBus/DrvSys/BrakeEn')]));
    });
    try {
      const hits = await client(port).searchSignals({ name: 'Brake' });
      expect(hits).toHaveLength(1);
      expect(requests).toHaveLength(1);
    } finally { server.close(); }
  });

  it('every page feeds the network/device cache writeSignal uses', async () => {
    const { server, port, requests } = await startServer((req, res) => {
      if (req.url?.endsWith('/set-value')) { res.writeHead(204); res.end(); return; }
      hal(res, req.url?.includes('start=100')
        ? halPage('signals/signal-search?start=100&amp;limit=100', '', [halSignal('Net/Dev/do2')])
        : halPage('signals/signal-search?limit=100',
          ' , "next" : { "href" : "signals/signal-search?start=100&amp;limit=100" }',
          [halSignal('Net/Dev/do1')]));
    });
    try {
      const c = client(port);
      await c.searchSignals({ type: 'DO' });
      await c.writeSignal('', '', 'do2', '1');
      // No lookup by name was needed: the second page's entry was remembered.
      expect(requests[2].url).toBe('/rw/iosystem/signals/Net/Dev/do2/set-value');
      expect(requests).toHaveLength(3);
    } finally { server.close(); }
  });

  it('stops on a next link that points back at a page already read, and warns', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    const { server, port, requests } = await startServer((_req, res) => {
      hal(res, halPage('signals/signal-search',
        ' , "next" : { "href" : "signals/signal-search" }', [halSignal('n/d/x')]));
    });
    try {
      const hits = await client(port).searchSignals({});
      expect(hits).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/searchSignals: the controller's next link points back at \/rw\/iosystem\/signals\/signal-search, a page already read - stopping after 1 page\(s\) \(1 signals\)/);
    } finally { server.close(); }
  });

  it('treats a next link at ?start=0&limit=100 as the first page already read, not a new page', async () => {
    // The first page is requested at the bare search path, but the controller
    // names it `signals/signal-search?start=0&limit=100` in its `first` link;
    // a `next` at that path must not re-read page one and duplicate its hits.
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    const { server, port, requests } = await startServer((_req, res) => {
      hal(res, halPage('signals/signal-search?limit=100',
        ' , "next" : { "href" : "signals/signal-search?start=0&amp;limit=100" }', [halSignal('n/d/x')]));
    });
    try {
      const hits = await client(port).searchSignals({});
      expect(hits.map(s => s.name)).toEqual(['x']);
      expect(requests).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/points back at \/rw\/iosystem\/signals\/signal-search\?start=0&limit=100, a page already read/);
    } finally { server.close(); }
  });

  it('a page after the first that fails makes the whole search throw, not a partial result', async () => {
    const { server, port, requests } = await startServer((req, res) => {
      if (req.url?.includes('start=100')) {
        res.writeHead(500, { 'Content-Type': 'application/xhtml+xml;v=2.0' }); res.end(''); return;
      }
      hal(res, halPage('signals/signal-search?limit=100',
        ' , "next" : { "href" : "signals/signal-search?start=100&amp;limit=100" }',
        [halSignal('n/d/first')]));
    });
    try {
      await expect(client(port).searchSignals({ type: 'DO' })).rejects.toMatchObject({ name: 'RwsError' });
      expect(requests).toHaveLength(2);
    } finally { server.close(); }
  });

  it('caps a never-ending next chain at 100 pages and warns', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    // The page comes from the URL, not a request counter: a GET that the client
    // retries on a fresh connection (a pooled one dropped under load) gets the
    // same page again.
    const { server, port, requests } = await startServer((req, res) => {
      const n = Number(/start=(\d+)/.exec(req.url ?? '')?.[1] ?? 100) / 100;
      hal(res, halPage(`signals/signal-search?start=${n * 100}&amp;limit=100`,
        ` , "next" : { "href" : "signals/signal-search?start=${(n + 1) * 100}&amp;limit=100" }`,
        [halSignal(`n/d/sig${n}`)]));
    });
    try {
      const hits = await client(port).searchSignals({});
      // Count the search pages only: under a loaded test run a stray request
      // from outside this test (a GET /rw/system, seen once in a few full runs)
      // can reach this server, and it is no search page.
      const pages = requests.filter(r => r.url.startsWith('/rw/iosystem/signals/signal-search'));
      expect(pages).toHaveLength(100);
      expect(hits).toHaveLength(100);
      expect(hits[0].name).toBe('sig1');
      expect(hits[99].name).toBe('sig100');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/searchSignals: stopped after 100 pages \(100 signals\)/);
    } finally { server.close(); }
  }, 30000);
});
