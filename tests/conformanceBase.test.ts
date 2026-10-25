/**
 * Offline checks of the conformance crawler's link resolution
 * (scripts/conformance-links.mjs) and of what its walk never reads
 * (scripts/conformance-crawl.mjs). Every RWS answer names the URL its relative
 * links resolve against - hal+json as `_links.base.href`, XHTML as the
 * `<base href>` element - and that base is not always the request path:
 * `GET /rw` answers base `/` with children `rw/cfg`, `rw/rapid`, ...
 * The bodies below are the shapes RW 6.16.03, 7.21.4 and 8.2.1 answer
 * (recorded 2026-09-29), trimmed to a few entries. No socket.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs script without type declarations
import * as links from '../scripts/conformance-links.mjs';

// @ts-expect-error - plain .mjs script without type declarations
import * as crawl from '../scripts/conformance-crawl.mjs';

const l = links as {
  normalise(p: string): string;
  linkBase(body: string, gen: 1 | 2, requestPath: string): string;
  childLinks(body: string, gen: 1 | 2, requestPath: string): string[];
};

const c = crawl as {
  ROOTS: string[];
  pruned(p: string): boolean;
  crawlTree(
    get: (p: string) => Promise<{ status: number; body: string }>,
    gen: 1 | 2,
    opts?: { roots?: string[]; maxNodes?: number; deadlineMs?: number; log?: (msg: string) => void },
  ): Promise<string[]>;
};

// RWS 2.0 hal+json GET /rw (RW 7.21.4).
const RW2_RW = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/" }, "self" : { "href" : "rw" } }  , '
  + '"_embedded" : { "resources" : [ '
  + '{ "_links": { "self": { "href": "rw/cfg" } }, "_type":"rwservice-li", "_title":"cfg"  } , '
  + '{ "_links": { "self": { "href": "rw/dipc" } }, "_type":"rwservice-li", "_title":"dipc"  } , '
  + '{ "_links": { "self": { "href": "rw/iosystem" } }, "_type":"rwservice-li", "_title":"iosystem"  } , '
  + '{ "_links": { "self": { "href": "rw/rapid" } }, "_type":"rwservice-li", "_title":"rapid"  } ] } }';

// RWS 2.0 hal+json GET /rw/dipc (RW 8.2.1): the base is /rw/, the self link is `dipc`.
const RW2_DIPC = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:80/rw/" } ,"self" : { "href" : "dipc" } } , '
  + '"state" : [ { "_type" : "dipc-info", "_title" : "info", "max-body-size" : "448", "max-pkg-size" : "5000" } ], '
  + '"_embedded" : { "resources" : [ ] }}';

// RWS 2.0 hal+json GET /ctrl (RW 7.21.4): here the base is the request path.
const RW2_CTRL = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/ctrl/" }, "self" : { "href" : "" } }  , '
  + '"_embedded" : { "resources" : [  '
  + '{ "_links" : { "self" : { "href" : "clock" } }, "_type" : "ctrl-clock-info-li", "_title" : "clock" }, '
  + '{ "_links" : { "self" : { "href" : "identity" } }, "_type" : "ctrl-identity-info-li", "_title" : "identity" } ] } }';

// RWS 1.0 XHTML GET /rw (RW 6.16.03).
const RW1_RW = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rw</title>'
  + '<base href="http://127.0.0.1:4578/"/></head><body><div class="state"><a href="rw" rel="self"></a><ul>'
  + '<li class="rwservice-li" title="cfg"><a href="rw/cfg" rel="self"></a></li>'
  + '<li class="rwservice-li" title="Rim"><a href="rw/rim" rel="self"></a></li>'
  + '<li class="rwservice-li" title="system"><a href="rw/system" rel="self"></a></li></ul></div></body></html>';

// RWS 1.0 XHTML GET /rw/dipc (RW 6.16.03): base /rw/, children `dipc/<queue>`.
const RW1_DIPC = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>RobAPI2 DIPC</title> '
  + '<base href="http://127.0.0.1:4578/rw/"/></head><body><div class="state">  <a href="dipc" rel="self"></a> '
  + '<a href="dipc?action=show" rel="action"></a> <ul> '
  + '<li class="dipc-queue-li" title="RimDispatcher"> <a href="dipc/RimDispatcher" rel="self"></a> </li>  </ul></div></body></html>';

describe('conformance crawler - links resolve against the base the answer declares', () => {
  it('RWS 2.0 /rw: the children are /rw/<service>, not /rw/rw/<service>', () => {
    const got = l.childLinks(RW2_RW, 2, '/rw');
    expect(got).toEqual(expect.arrayContaining(['/rw/cfg', '/rw/dipc', '/rw/iosystem', '/rw/rapid']));
    expect(got.filter(p => p.startsWith('/rw/rw'))).toEqual([]);
  });

  it('RWS 1.0 XHTML /rw: the children are /rw/<service>, not /rw/rw/<service>', () => {
    const got = l.childLinks(RW1_RW, 1, '/rw');
    expect(got).toEqual(expect.arrayContaining(['/rw/cfg', '/rw/rim', '/rw/system']));
    expect(got.filter(p => p.startsWith('/rw/rw'))).toEqual([]);
  });

  it('RWS 1.0 XHTML /rw/dipc: a queue under base /rw/ is /rw/dipc/<queue>', () => {
    const got = l.childLinks(RW1_DIPC, 1, '/rw/dipc');
    expect(got).toContain('/rw/dipc/RimDispatcher');
    expect(got.filter(p => p.startsWith('/rw/dipc/dipc'))).toEqual([]);
  });

  it('RWS 2.0 /rw/dipc: the self link `dipc` under base /rw/ is /rw/dipc itself', () => {
    expect(l.childLinks(RW2_DIPC, 2, '/rw/dipc')).toEqual(['/rw/dipc']);
  });

  it('a base equal to the request path gives that path\'s children (/ctrl)', () => {
    expect(l.childLinks(RW2_CTRL, 2, '/ctrl').sort()).toEqual(['/ctrl/clock', '/ctrl/identity']);
  });

  it('the base link itself is not reported as a child', () => {
    expect(l.childLinks(RW2_RW, 2, '/rw')).not.toContain('/');
    expect(l.childLinks(RW1_RW, 1, '/rw')).not.toContain('/');
  });
});

describe('conformance crawler - linkBase', () => {
  it('takes hal+json _links.base.href', () => {
    expect(l.linkBase(RW2_RW, 2, '/rw')).toBe('https://127.0.0.1:5466/');
    expect(l.linkBase(RW2_DIPC, 2, '/rw/dipc')).toBe('https://127.0.0.1:80/rw/');
  });

  it('takes the XHTML <base href> element', () => {
    expect(l.linkBase(RW1_RW, 1, '/rw')).toBe('http://127.0.0.1:4578/');
    expect(l.linkBase(RW1_DIPC, 1, '/rw/dipc')).toBe('http://127.0.0.1:4578/rw/');
  });

  it('resolves a base given as a path against the request', () => {
    const body = '{"_links":{"base":{"href":"/rw/"}},"_embedded":{"resources":[{"_links":{"self":{"href":"dipc/q1"}}}]}}';
    expect(l.linkBase(body, 2, '/rw/dipc')).toBe('http://x/rw/');
    expect(l.childLinks(body, 2, '/rw/dipc')).toEqual(['/rw/dipc/q1']);
  });

  it('reads the base from a hal+json body cut short', () => {
    const cut = RW2_RW.slice(0, RW2_RW.indexOf('rw/iosystem'));
    expect(l.linkBase(cut, 2, '/rw')).toBe('https://127.0.0.1:5466/');
    expect(l.childLinks(cut, 2, '/rw')).toEqual(expect.arrayContaining(['/rw/cfg', '/rw/dipc']));
  });

  it('falls back to the request path when the answer declares no base', () => {
    const hal = '{"_embedded":{"resources":[{"_links":{"self":{"href":"c"}}}]}}';
    expect(l.linkBase(hal, 2, '/a/b')).toBe('http://x/a/b/');
    expect(l.childLinks(hal, 2, '/a/b')).toEqual(['/a/b/c']);
    const xhtml = '<html><head><title>t</title></head><body><a href="c" rel="self"></a></body></html>';
    expect(l.linkBase(xhtml, 1, '/a/b')).toBe('http://x/a/b/');
    expect(l.childLinks(xhtml, 1, '/a/b')).toEqual(['/a/b/c']);
  });

  it('drops the query of the request path when it falls back to it', () => {
    expect(l.linkBase('{}', 2, '/rw/system?json=1')).toBe('http://x/rw/system/');
  });

  it('still skips fragments and WebSocket links', () => {
    const body = '{"_links":{"base":{"href":"https://h/"}},"x":[{"href":"#top"},{"href":"wss://h/poll/1"},{"href":"rw/panel"}]}';
    expect(l.childLinks(body, 2, '/rw')).toEqual(['/rw/panel']);
  });
});

describe('conformance crawler - normalise', () => {
  it('strips the query and trailing slashes, and keeps the root', () => {
    expect(l.normalise('/rw/rapid/modules?task=T_ROB1')).toBe('/rw/rapid/modules');
    expect(l.normalise('/rw/')).toBe('/rw');
    expect(l.normalise('/')).toBe('/');
  });
});

// RWS 2.0 hal+json GET /rw/dipc with one queue listed. The recorded RW 7.21.4
// and 8.2.1 answers list no queue; the entry is in the shape RW 6.16.03 lists
// its queues (self `dipc/<queue>` under base /rw/).
const RW2_DIPC_WITH_QUEUE = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/" } ,"self" : { "href" : "dipc" } } , '
  + '"state" : [ { "_type" : "dipc-info", "_title" : "info", "max-body-size" : "448", "max-pkg-size" : "5000" } ], '
  + '"_embedded" : { "resources" : [ '
  + '{ "_links" : { "self" : { "href" : "dipc/RMQ_T_ROB1" } }, "_type" : "dipc-queue-li", "_title" : "RMQ_T_ROB1" } ] }}';

/** A canned controller: the given answers with 200, anything else 404; records every GET. */
function cannedTree(answers: Record<string, string>) {
  const got: string[] = [];
  const get = async (p: string) => {
    got.push(p);
    return p in answers ? { status: 200, body: answers[p] } : { status: 404, body: '' };
  };
  return { got, get };
}

describe('conformance crawler - what the crawl never reads', () => {
  it('RWS 2.0: reads /rw/dipc but never GETs a queue it lists (that GET takes a message off the queue)', async () => {
    const { got, get } = cannedTree({ '/rw': RW2_RW, '/rw/dipc': RW2_DIPC_WITH_QUEUE });
    const found = await c.crawlTree(get, 2);
    expect(got).toEqual(expect.arrayContaining(['/rw', '/rw/cfg', '/rw/dipc', '/rw/rapid']));
    expect(got.filter(p => p.startsWith('/rw/dipc/'))).toEqual([]);
    expect(found).toEqual(['/rw', '/rw/dipc']);
  });

  it('RWS 1.0: reads /rw/dipc but never GETs a queue it lists', async () => {
    const rw1 = RW1_RW.replace('<li class="rwservice-li" title="Rim">',
      '<li class="rwservice-li" title="dipc"><a href="rw/dipc" rel="self"></a></li><li class="rwservice-li" title="Rim">');
    const { got, get } = cannedTree({ '/rw': rw1, '/rw/dipc': RW1_DIPC });
    await c.crawlTree(get, 1);
    expect(got).toEqual(expect.arrayContaining(['/rw', '/rw/dipc', '/rw/system']));
    expect(got.filter(p => p.startsWith('/rw/dipc/'))).toEqual([]);
  });

  it('pruned: a DIPC queue is, the queue listing is not', () => {
    expect(c.pruned('/rw/dipc/RMQ_T_ROB1')).toBe(true);
    expect(c.pruned('/rw/dipc/RimDispatcher')).toBe(true);
    expect(c.pruned('/rw/dipc')).toBe(false);
  });

  it('starts from the documented roots and reads each node once', async () => {
    const { got, get } = cannedTree({ '/rw': RW2_RW, '/ctrl': RW2_CTRL });
    await c.crawlTree(get, 2);
    for (const root of c.ROOTS) { expect(got).toContain(root); }
    expect(new Set(got).size).toBe(got.length);
  });
});
