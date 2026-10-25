import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';
import { XhtmlParser } from '../src/XhtmlParser.js';
import { HalJsonParser } from '../src/HalJsonParser.js';

/**
 * OmniCore-only niche reads: the safety-configuration change count and the
 * safety configuration, the per-id feature check, a mechunit's calibration
 * resources, and the RAPID module sub-resources (mod-possible, symbol,
 * attributes, object) plus mod-possible-all.
 *
 * Bodies are the shapes the controllers answered (the change count, read on
 * RW 7.21.4 and 8.2.1 on 2026-09-29) or ABB's own examples (Controller_Service
 * and Motion_System Rev L). The RAPID sub-resources have no recorded item
 * classes, so their tests pin the URL and the pass-through of every entry.
 */

interface Recorded { method: string; url: string }

type Reply = { status: number; type?: 'hal' | 'xhtml'; body?: string };

async function startServer(reply: (url: string) => Reply): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '' });
      const r = reply(req.url ?? '');
      const headers: Record<string, string> = {};
      if (r.type === 'hal') { headers['Content-Type'] = 'application/hal+json;v=2.0'; }
      if (r.type === 'xhtml') { headers['Content-Type'] = 'application/xhtml+xml;v=2.0'; }
      res.writeHead(r.status, headers);
      res.end(r.body ?? '');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const client = (port: number): RwsClient2 =>
  new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics');

const xhtml = (inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">`
  + `<head><base href="http://x/"/></head><body><div class="state">${inner}</div></body></html>`;

const hal = (state: unknown[], embedded: unknown[] = []): string => JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1/' }, self: { href: '' } },
  state,
  ...(embedded.length ? { _embedded: { resources: embedded } } : {}),
});

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(RwsError); return e as RwsError; }
  throw new Error('expected a rejection');
}

describe('getAllEntries - every typed entry, whatever its class', () => {
  it('XHTML: class kept as _type, with title, self link and spans', () => {
    const p = new XhtmlParser(xhtml(
      '<ul><li class="a-li" title="one"><a href="x/one" rel="self"></a><span class="k">1</span></li>'
      + '<li class="b" title="two"><span class="k">2</span></li></ul>'));
    expect(p.getAllEntries()).toEqual([
      { _type: 'a-li', _title: 'one', _href: 'x/one', k: '1' },
      { _type: 'b', _title: 'two', k: '2' },
    ]);
    // getAllStates is unchanged by the shared collector: no _type key.
    expect(p.getAllStates('b')).toEqual([{ _title: 'two', k: '2' }]);
  });

  it('HAL JSON: state and embedded resources, _type kept', () => {
    const p = new HalJsonParser(hal(
      [{ _type: 's', _title: 'st', v: 3 }],
      [{ _links: { self: { href: 'r/1' } }, _type: 'r-li', _title: 'r1' }],
    ));
    expect(p.getAllEntries()).toEqual([
      { _type: 's', _title: 'st', v: '3' },
      { _type: 'r-li', _title: 'r1', _href: 'r/1' },
    ]);
  });
});

describe('getSafetyConfigChangeCount', () => {
  it('reads count from safety-config-change-count (the RW 7.21.4 / 8.2.1 answer)', async () => {
    // Body as both controllers answered it on 2026-09-29.
    const body = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/ctrl/safety/config/changecount/" }, "self" : { "href" : "" } }  , "state" : [ { "_type" : "safety-config-change-count", "_title" : "changecount", "count" : "1" } ]}';
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'hal', body }));
    try {
      expect(await client(port).getSafetyConfigChangeCount()).toBe(1);
      expect(requests[0]).toEqual({ method: 'GET', url: '/ctrl/safety/config/changecount' });
    } finally { server.close(); }
  });

  it('reads the XHTML form too', async () => {
    const body = xhtml('<ul><li class="safety-config-change-count" title="changecount"><span class="count">7</span></li></ul>');
    const { server, port } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).getSafetyConfigChangeCount()).toBe(7);
    } finally { server.close(); }
  });

  it('PARSE_ERROR when the block or a numeric count is missing', async () => {
    const { server, port } = await startServer(() => ({ status: 200, type: 'hal', body: hal([{ _type: 'something-else', count: '1' }]) }));
    try {
      expect((await rejection(client(port).getSafetyConfigChangeCount())).code).toBe('PARSE_ERROR');
    } finally { server.close(); }
    const bad = await startServer(() => ({ status: 200, type: 'hal', body: hal([{ _type: 'safety-config-change-count', count: 'x' }]) }));
    try {
      expect((await rejection(client(bad.port).getSafetyConfigChangeCount())).code).toBe('PARSE_ERROR');
    } finally { bad.server.close(); }
  });

  it('a controller without the resource (before 7.20) is a typed 404', async () => {
    const { server, port } = await startServer(() => ({
      status: 404, type: 'xhtml',
      body: '<html><body><div class="status"><span class="code">-1073445866</span><span class="msg">Resource not found</span></div></body></html>',
    }));
    try {
      const e = await rejection(client(port).getSafetyConfigChangeCount());
      expect(e.httpStatus).toBe(404);
    } finally { server.close(); }
  });
});

describe('getSafetyConfig', () => {
  // ABB Controller_Service.yaml Rev L, "Get Safety Configurations" example.
  const abbExample = xhtml(
    '<a href="" rel="self"></a><ul>'
    + '<li class="safety-ctrl-configuration-status" title="status"><span class="config-status">SCORCH_CONFIG_LOADED</span></li>'
    + '<li class="safety-ctrl-configuration" title="configuration">'
    + '<span class="sw-major-ver">1</span><span class="sw-minor-ver">4</span><span class="sw-rev">0</span>'
    + '<span class="file-major-ver">1</span><span class="file-minor-ver">4</span><span class="file-rev">0</span>'
    + '<span class="creation-date">2015-10-26T14:42:00.000000+01:00</span><span class="created-by">ABB</span>'
    + '<span class="config-name"></span><span class="checksum">QZaTkDB3rOxDPPCM+FsWQY+bf1fW2BZybkToTvufUuI=</span>'
    + '</li></ul>');

  it('splits the status entry from the configuration entry (ABB example)', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body: abbExample }));
    try {
      const c = await client(port).getSafetyConfig();
      expect(requests.every(r => r.url === '/ctrl/safety/config' && r.method === 'GET')).toBe(true);
      expect(c.status).toBe('SCORCH_CONFIG_LOADED');
      expect(c.configuration['created-by']).toBe('ABB');
      expect(c.configuration['sw-major-ver']).toBe('1');
      expect(c.configuration['checksum']).toBe('QZaTkDB3rOxDPPCM+FsWQY+bf1fW2BZybkToTvufUuI=');
      expect(c.configuration['config-name']).toBe('');
    } finally { server.close(); }
  });

  it('reads the HAL JSON form', async () => {
    const body = hal([
      { _type: 'safety-ctrl-configuration-status', _title: 'status', 'config-status': 'SCORCH_CONFIG_LOADED' },
      { _type: 'safety-ctrl-configuration', _title: 'configuration', 'created-by': 'ABB', 'file-rev': '0' },
    ]);
    const { server, port } = await startServer(() => ({ status: 200, type: 'hal', body }));
    try {
      const c = await client(port).getSafetyConfig();
      expect(c.status).toBe('SCORCH_CONFIG_LOADED');
      expect(c.configuration).toMatchObject({ 'created-by': 'ABB', 'file-rev': '0' });
    } finally { server.close(); }
  });

  it('PARSE_ERROR when neither entry is present', async () => {
    const { server, port } = await startServer(() => ({ status: 200, type: 'hal', body: hal([]) }));
    try {
      expect((await rejection(client(port).getSafetyConfig())).code).toBe('PARSE_ERROR');
    } finally { server.close(); }
  });
});

describe('verifyControllerFeature', () => {
  const id = 'abb.robotics.robotcontrol.controllerhw.m28.01';

  it('204 means present; robno goes on the query', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 204 }));
    try {
      expect(await client(port).verifyControllerFeature(id, 1)).toBe(true);
      expect(requests[0]).toEqual({ method: 'GET', url: `/ctrl/features/${id}?robno=1` });
      expect(await client(port).verifyControllerFeature(id)).toBe(true);
      expect(requests[1].url).toBe(`/ctrl/features/${id}`);
    } finally { server.close(); }
  });

  it('404 means absent', async () => {
    const { server, port } = await startServer(() => ({ status: 404 }));
    try {
      expect(await client(port).verifyControllerFeature('no.such.feature')).toBe(false);
    } finally { server.close(); }
  });

  it('other failures are thrown, not read as absent', async () => {
    const { server, port } = await startServer(() => ({ status: 500 }));
    try {
      expect((await rejection(client(port).verifyControllerFeature(id))).httpStatus).toBe(500);
    } finally { server.close(); }
  });

  it('refuses an empty id or a bad robno before sending', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 204 }));
    try {
      expect((await rejection(client(port).verifyControllerFeature(' '))).code).toBe('INVALID_ARGUMENT');
      expect((await rejection(client(port).verifyControllerFeature(id, 0))).code).toBe('INVALID_ARGUMENT');
      expect((await rejection(client(port).verifyControllerFeature(id, 1.5))).code).toBe('INVALID_ARGUMENT');
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('encodes the id as one path segment', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 204 }));
    try {
      await client(port).verifyControllerFeature('a/b c');
      expect(requests[0].url).toBe('/ctrl/features/a%2Fb%20c');
    } finally { server.close(); }
  });
});

describe('getMechunitCalib', () => {
  it('lists the calibration resources by title and link (ABB example)', async () => {
    // ABB Motion_System.yaml Rev L, "Get resource urls to Calibrate Mechunits".
    const body = xhtml('<a href="calib" rel="self"><ul><li class="ms-mechunit-calib-li" title="singleuserlin">'
      + '<a href="calib/singleuserlin" rel="self"></a></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).getMechunitCalib('ROB_1')).toEqual([{ name: 'singleuserlin', href: 'calib/singleuserlin' }]);
      expect(requests[0].url).toBe('/rw/motionsystem/mechunits/ROB_1/calib');
    } finally { server.close(); }
  });

  it('reads the HAL JSON form, defaulting to ROB_1', async () => {
    const body = hal([], [{ _links: { self: { href: 'calib/singleuserlin' } }, _type: 'ms-mechunit-calib-li', _title: 'singleuserlin' }]);
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'hal', body }));
    try {
      expect(await client(port).getMechunitCalib()).toEqual([{ name: 'singleuserlin', href: 'calib/singleuserlin' }]);
      expect(requests[0].url).toBe('/rw/motionsystem/mechunits/ROB_1/calib');
    } finally { server.close(); }
  });

  it('refuses an empty mechunit before sending', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 200 }));
    try {
      expect((await rejection(client(port).getMechunitCalib(''))).code).toBe('INVALID_ARGUMENT');
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });
});

describe('RAPID module sub-resources (RWS 2.0)', () => {
  const entries = hal([{ _type: 'rap-x', _title: 't', v: '1' }]);

  it('getModPossibleAll reads /rw/rapid/modules and passes every entry through', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'hal', body: entries }));
    try {
      expect(await client(port).getModPossibleAll()).toEqual([{ _type: 'rap-x', _title: 't', v: '1' }]);
      expect(requests[0]).toEqual({ method: 'GET', url: '/rw/rapid/modules' });
    } finally { server.close(); }
  });

  it('getModPossibleAll answers [] for an empty answer', async () => {
    const { server, port } = await startServer(() => ({ status: 200, type: 'hal', body: hal([]) }));
    try {
      expect(await client(port).getModPossibleAll()).toEqual([]);
    } finally { server.close(); }
  });

  it('each module read hits its own sub-resource, query passed through encoded', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'hal', body: entries }));
    try {
      const c = client(port);
      await c.getModuleModPossible('T_ROB1', 'Module1', { startrow: 1, startcol: 1, endrow: 26, endcol: 1 });
      await c.getModuleSymbolInfo('T_ROB1', 'Module1');
      await c.getModuleAttributes('T_ROB1', 'Module1', { attribute: 'nostepin' });
      expect(await c.getModuleObject('T_ROB1', 'My Mod', { 'a&b': 'x y' })).toEqual([{ _type: 'rap-x', _title: 't', v: '1' }]);
      expect(requests.map(r => r.url)).toEqual([
        '/rw/rapid/tasks/T_ROB1/modules/Module1/mod-possible?startrow=1&startcol=1&endrow=26&endcol=1',
        '/rw/rapid/tasks/T_ROB1/modules/Module1/symbol',
        '/rw/rapid/tasks/T_ROB1/modules/Module1/attributes?attribute=nostepin',
        '/rw/rapid/tasks/T_ROB1/modules/My%20Mod/object?a%26b=x%20y',
      ]);
      expect(requests.every(r => r.method === 'GET')).toBe(true);
    } finally { server.close(); }
  });

  it('the controller asking for a parameter is thrown as answered', async () => {
    const { server, port } = await startServer(() => ({
      status: 400, type: 'xhtml',
      body: '<html><body><div class="status"><span class="code">-1073445879</span><span class="msg">endrow parameter missing</span></div></body></html>',
    }));
    try {
      const e = await rejection(client(port).getModuleModPossible('T_ROB1', 'Module1'));
      expect(e.httpStatus).toBe(400);
    } finally { server.close(); }
  });

  it('refuses empty names and bad query values before sending', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'hal', body: entries }));
    try {
      const c = client(port);
      expect((await rejection(c.getModuleModPossible('', 'Module1'))).code).toBe('INVALID_ARGUMENT');
      expect((await rejection(c.getModuleSymbolInfo('T_ROB1', ' '))).code).toBe('INVALID_ARGUMENT');
      expect((await rejection(c.getModuleAttributes('T_ROB1', 'Module1', { attrib: Number.NaN }))).code).toBe('INVALID_ARGUMENT');
      expect((await rejection(c.getModuleObject('T_ROB1', 'Module1', { '': 1 }))).code).toBe('INVALID_ARGUMENT');
      // A JS caller passing a non-object query gets a typed refusal, not a TypeError.
      const bad = 'startrow=1' as unknown as Record<string, string>;
      expect((await rejection(c.getModuleAttributes('T_ROB1', 'Module1', bad))).code).toBe('INVALID_ARGUMENT');
      const arr = [1] as unknown as Record<string, string>;
      expect((await rejection(c.getModuleObject('T_ROB1', 'Module1', arr))).code).toBe('INVALID_ARGUMENT');
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('a null query is read as no query', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'hal', body: entries }));
    try {
      const nul = null as unknown as Record<string, string>;
      await client(port).getModuleModPossible('T_ROB1', 'Module1', nul);
      expect(requests.map(r => r.url)).toEqual(['/rw/rapid/tasks/T_ROB1/modules/Module1/mod-possible']);
    } finally { server.close(); }
  });
});
