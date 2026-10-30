import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RobotManager } from '../src/RobotManager.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import type { RwsClient } from '../src/RwsClient.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { CFG_INVALID_TYPE_ID, readSystemSignals, signalCategoryOf } from '../src/systemSignals.js';
import { cfgInstanceList } from '../src/rws2/core.js';
import { RwsError, type CfgInstanceDetail, type SystemSignalBinding } from '../src/types.js';

/**
 * System-signal bindings (1.6.0): the CFG lists SYSSIG_IN and SYSSIG_OUT read
 * with their attributes, the category of one signal, and the manager's one
 * read per session. Bodies marked "recorded" are answers of RobotWare 6.16.03
 * and 8.2.1 virtual controllers (2026-09-29). None of those controllers had a
 * system input configured, so the SYSSIG_IN instances below are constructed
 * from the attribute lists the same controllers gave for the type (RW 6:
 * Signal, Action, Arg1..; RW 7 and 8: Name, Action, ..).
 */

/** Recorded, RW 6.16.03 `GET /rw/cfg/EIO/SYSSIG_OUT/instances?json=1` (Arg2..Arg8 dropped). */
const RW6_SYSSIG_OUT = '{"_links":{"base": { "href": "http://127.0.0.1:4578/rw/cfg/" }},"_embedded" :{  "_state":[  { "_links": { "self": { "href": "EIO/SYSSIG_OUT/instances/?json=1" } }, "_type":"cfg-dt-instance-li", "_title":"", "rdonly":"true","instanceid":"1143496816", "attrib":[  { "_type":"cfg-ia-t-li", "_title":"Status", "value":"MotorOn" } , { "_type":"cfg-ia-t-li", "_title":"Signal", "value":"MOTLMP" } , { "_type":"cfg-ia-t-li", "_title":"Arg1", "value":"" } ] } ] }}';
/** Recorded, RW 6.16.03 `GET /rw/cfg/EIO/SYSSIG_IN/instances?json=1`. */
const RW6_EMPTY = '{"_links":{"base": { "href": "http://127.0.0.1:4578/rw/cfg/" }},"_embedded" :{  "_state":[  ] }}';
/** Recorded, RW 6.16.03 `GET /rw/cfg/SYS/SYSSIG_IN/instances?json=1` (the build path in the message shortened). */
const RW6_INVALID_TYPE = '{"_links":{"base": { "href": "http://127.0.0.1:4578/" }},"_embedded" :{ "status" : {"code":-1073437695, "msg": "rws_resource_cfg.cpp[1425] Invalid type id code:-1073437695 icode:-28"}, "_state":[ ] }}';
/** Constructed in the RW 6.16.03 shape: one system input. */
const RW6_SYSSIG_IN = '{"_links":{"base": { "href": "http://127.0.0.1:4578/rw/cfg/" }},"_embedded" :{  "_state":[  { "_type":"cfg-dt-instance-li", "_title":"", "attrib":[  { "_type":"cfg-ia-t-li", "_title":"Signal", "value":"diStart" } , { "_type":"cfg-ia-t-li", "_title":"Action", "value":"Start" } ] } ] }}';

/** Recorded, RW 8.2.1 `GET /rw/cfg/SYS/SYSSIG_OUT/instances`, cut where the probe stored no more and closed here. */
const RW8_SYSSIG_OUT = '{ "_links" : { "base": { "href": "https://127.0.0.1:80/rw/cfg/" },"self": { "href": "SYS/SYSSIG_OUT/instances"} } , "_embedded" : { "resources" : [ { "_links": { "self": { "href": "SYS/SYSSIG_OUT/instances/MotLmpPB" } }, "_type":"cfg-dt-instance-li", "_title":"MotLmpPB", "rdonly":"true", "instanceid":"7613736", "attrib": [ { "_type":"cfg-ia-t", "_title":"Name", "value":"MotLmpPB" } , { "_type":"cfg-ia-t", "_title":"Status", "value":"MotorOn" } ] } ] }}';
/** Recorded, RW 8.2.1 `GET /rw/cfg/EIO/SYSSIG_IN/instances`: served, and empty. */
const RW8_EMPTY = '{ "_links" : { "base": { "href": "https://127.0.0.1:80/rw/cfg/" },"self": { "href": "EIO/SYSSIG_IN/instances"} } , "_embedded" : { "resources" : [ ] }}';

/** A fake RwsClient for RWS1Adapter: answers each GET from `respond`. */
function fakeRws1(respond: (url: string) => { status: number; body: string }): { client: RwsClient; urls: string[] } {
  const urls: string[] = [];
  const client = {
    request: async (_m: string, url: string) => { urls.push(url); return respond(url); },
  } as unknown as RwsClient;
  return { client, urls };
}

/** A local HTTP server for RwsClient2; `respond` returns [status, body]. */
async function withServer(
  respond: (url: string) => [number, string],
  run: (client: RwsClient2, urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? '');
    const [status, body] = respond(req.url ?? '');
    res.writeHead(status, { 'Content-Type': body.trimStart().startsWith('{') ? 'application/hal+json;v=2.0' : 'application/xhtml+xml;v=2.0' });
    res.end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p'), urls);
  } finally { server.close(); }
}

/** A fake adapter whose CFG lists answer from `lists` ("SYS/SYSSIG_IN" → instances, or an error to throw). */
function cfgAdapter(lists: Record<string, CfgInstanceDetail[] | Error>): { adapter: IRWSAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter = {
    listCfgInstancesDetailed: async (domain: string, type: string) => {
      calls.push(`${domain}/${type}`);
      const answer = lists[`${domain}/${type}`] ?? [];
      if (answer instanceof Error) { throw answer; }
      return answer;
    },
  } as unknown as IRWSAdapter;
  return { adapter, calls };
}

const invalidType = (): RwsError => new RwsError('Invalid type id', 'RESOURCE_NOT_FOUND', 400, undefined, CFG_INVALID_TYPE_ID, 'Invalid type id');

function connected(adapter: IRWSAdapter): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: IRWSAdapter; _state: { connected: boolean }; sessionEpoch: number | null; connectEpoch: number };
  m.adapter = adapter;
  m._state.connected = true;
  m.sessionEpoch = m.connectEpoch;
  return mgr;
}

/** A new session on the same manager: what a reconnect does to the two epochs. */
function reconnect(mgr: RobotManager): void {
  const m = mgr as unknown as { sessionEpoch: number | null; connectEpoch: number };
  m.connectEpoch++;
  m.sessionEpoch = m.connectEpoch;
}

describe('listCfgInstancesDetailed, RWS 1.0', () => {
  it('reads each instance with its attributes from the recorded RW 6.16.03 list (an instance without a title)', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: RW6_SYSSIG_OUT }));
    const list = await new RWS1Adapter(client).listCfgInstancesDetailed('EIO', 'SYSSIG_OUT');
    expect(urls).toEqual(['/rw/cfg/EIO/SYSSIG_OUT/instances?json=1']);
    expect(list).toEqual([{ name: '', attributes: { Status: 'MotorOn', Signal: 'MOTLMP', Arg1: '' } }]);
  });

  it('follows the next link against the body base', async () => {
    const page1 = '{"_links":{"base":{"href":"http://127.0.0.1:4578/rw/cfg/"},"next":{"href":"EIO/SYSSIG_IN/instances?start=1&amp;limit=1&amp;json=1"}},"_embedded":{"_state":[{"_title":"","attrib":[{"_title":"Signal","value":"a"}]}]}}';
    const page2 = '{"_links":{"base":{"href":"http://127.0.0.1:4578/rw/cfg/"}},"_embedded":{"_state":[{"_title":"","attrib":[{"_title":"Signal","value":"b"}]}]}}';
    const { client, urls } = fakeRws1(url => ({ status: 200, body: url.includes('start=1') ? page2 : page1 }));
    const list = await new RWS1Adapter(client).listCfgInstancesDetailed('EIO', 'SYSSIG_IN');
    expect(list.map(i => i.attributes['Signal'])).toEqual(['a', 'b']);
    expect(urls[1]).toBe('/rw/cfg/EIO/SYSSIG_IN/instances?start=1&limit=1&json=1');
  });

  it('throws the refusal (the recorded RW 6.16.03 SYS answer) instead of answering an empty list', async () => {
    const { client } = fakeRws1(() => ({ status: 400, body: RW6_INVALID_TYPE }));
    const err = await new RWS1Adapter(client).listCfgInstancesDetailed('SYS', 'SYSSIG_IN').catch(e => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err.controllerCode).toBe(CFG_INVALID_TYPE_ID);
    // listCfgInstances, the name list, still swallows it
    expect(await new RWS1Adapter(client).listCfgInstances('SYS', 'SYSSIG_IN')).toEqual([]);
  });

  it('is PARSE_ERROR for an answer that is not JSON', async () => {
    const { client } = fakeRws1(() => ({ status: 200, body: '<html>busy</html>' }));
    await expect(new RWS1Adapter(client).listCfgInstancesDetailed('EIO', 'SYSSIG_IN')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('answers [] for the recorded empty list', async () => {
    const { client } = fakeRws1(() => ({ status: 200, body: RW6_EMPTY }));
    expect(await new RWS1Adapter(client).listCfgInstancesDetailed('EIO', 'SYSSIG_IN')).toEqual([]);
  });
});

describe('listCfgInstancesDetailed, RWS 2.0', () => {
  it('reads the recorded RW 8.2.1 SYS/SYSSIG_OUT list: the signal is the Name attribute', async () => {
    await withServer(() => [200, RW8_SYSSIG_OUT], async (client, urls) => {
      expect(await client.listCfgInstancesDetailed('SYS', 'SYSSIG_OUT'))
        .toEqual([{ name: 'MotLmpPB', attributes: { Name: 'MotLmpPB', Status: 'MotorOn' } }]);
      expect(urls[0]).toBe('/rw/cfg/SYS/SYSSIG_OUT/instances');
    });
  });

  it('reads an XHTML list, each instance holding its attribute items', async () => {
    // Constructed in the recorded XHTML shape (RW 6.16.03 serves the same classes).
    const xhtml = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://127.0.0.1/rw/cfg/"/></head><body><div class="state"><a href="SYS/SYSSIG_IN/instances" rel="self"></a><ul>'
      + '<li class="cfg-dt-instance-li" title="diStart"><a href="SYS/SYSSIG_IN/instances/diStart" rel="self"></a><ul> <li class="cfg-ia-t" title="Name"><span class="value">diStart</span></li> <li class="cfg-ia-t" title="Action"><span class="value">Start</span></li> </ul></li>'
      + '<li class="cfg-dt-instance-li" title="diStop"><ul> <li class="cfg-ia-t" title="Name"><span class="value">diStop</span></li> <li class="cfg-ia-t" title="Action"><span class="value">Stop</span></li> </ul></li>'
      + '</ul></div></body></html>';
    await withServer(() => [200, xhtml], async client => {
      expect(await client.listCfgInstancesDetailed('SYS', 'SYSSIG_IN')).toEqual([
        { name: 'diStart', attributes: { Name: 'diStart', Action: 'Start' } },
        { name: 'diStop', attributes: { Name: 'diStop', Action: 'Stop' } },
      ]);
    });
  });

  it('answers [] for the recorded empty EIO list, and is PARSE_ERROR for a body it cannot read', async () => {
    await withServer(() => [200, RW8_EMPTY], async client => {
      expect(await client.listCfgInstancesDetailed('EIO', 'SYSSIG_IN')).toEqual([]);
    });
    await withServer(() => [200, '{ "_embedded" : { "resources" : [ '], async client => {
      await expect(client.listCfgInstancesDetailed('EIO', 'SYSSIG_IN')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    });
  });

  it('the page parser answers null for a body it cannot read, [] for an empty listing', () => {
    expect(cfgInstanceList('{ "_embedded" : { "resources" : [ ')).toBeNull();
    expect(cfgInstanceList('<html><body>busy</body></html>')).toBeNull();
    expect(cfgInstanceList('')).toBeNull();
    expect(cfgInstanceList(RW8_EMPTY)).toEqual([]);
    expect(cfgInstanceList('<html><body><div class="state"><ul></ul></div></body></html>')).toEqual([]);
  });

  it('throws the refusal with its controller code', async () => {
    const notFound = '{ "_links":{ "base": { "href": "https://127.0.0.1:80/" } } ,"status" : {"code":-1073437695, "msg":"Invalid type id"}}';
    await withServer(() => [400, notFound], async client => {
      const err = await client.listCfgInstancesDetailed('SYS', 'NOPE').catch(e => e);
      expect(err).toBeInstanceOf(RwsError);
      expect(err.controllerCode).toBe(CFG_INVALID_TYPE_ID);
    });
  });
});

describe('readSystemSignals', () => {
  it('RW 6.16.03: skips the SYS types it does not have and reads the EIO bindings (recorded bodies)', async () => {
    const { client, urls } = fakeRws1(url => {
      if (url.startsWith('/rw/cfg/SYS/')) { return { status: 400, body: RW6_INVALID_TYPE }; }
      if (url.startsWith('/rw/cfg/EIO/SYSSIG_OUT/')) { return { status: 200, body: RW6_SYSSIG_OUT }; }
      if (url.startsWith('/rw/cfg/EIO/SYSSIG_IN/')) { return { status: 200, body: RW6_SYSSIG_IN }; }
      return { status: 404, body: '' };
    });
    const bindings = await readSystemSignals(new RWS1Adapter(client));
    expect(bindings).toEqual([
      { signal: 'diStart', category: 'system-input', action: 'Start', domain: 'EIO' },
      { signal: 'MOTLMP', category: 'system-output', action: 'MotorOn', domain: 'EIO' },
    ]);
    expect(urls.map(u => u.split('/instances')[0])).toEqual([
      '/rw/cfg/SYS/SYSSIG_IN', '/rw/cfg/SYS/SYSSIG_OUT', '/rw/cfg/EIO/SYSSIG_IN', '/rw/cfg/EIO/SYSSIG_OUT',
    ]);
  });

  it('RW 8.2.1: reads the SYS bindings by their Name attribute (recorded output, constructed input)', async () => {
    const sysIn = '{ "_links" : { "base": { "href": "https://127.0.0.1:80/rw/cfg/" } } , "_embedded" : { "resources" : [ { "_type":"cfg-dt-instance-li", "_title":"diMotOn", "attrib": [ { "_type":"cfg-ia-t", "_title":"Name", "value":"diMotOn" } , { "_type":"cfg-ia-t", "_title":"Action", "value":"MotorOn" } ] } ] }}';
    await withServer(url => {
      if (url.startsWith('/rw/cfg/SYS/SYSSIG_IN/')) { return [200, sysIn]; }
      if (url.startsWith('/rw/cfg/SYS/SYSSIG_OUT/')) { return [200, RW8_SYSSIG_OUT]; }
      return [200, RW8_EMPTY];
    }, async client => {
      expect(await readSystemSignals(client as unknown as IRWSAdapter)).toEqual([
        { signal: 'diMotOn', category: 'system-input', action: 'MotorOn', domain: 'SYS' },
        { signal: 'MotLmpPB', category: 'system-output', action: 'MotorOn', domain: 'SYS' },
      ]);
    });
  });

  it('skips a type only on the "Invalid type id" code, not on any 400 or not-found', async () => {
    const skipped = cfgAdapter({
      'SYS/SYSSIG_IN': invalidType(), 'SYS/SYSSIG_OUT': invalidType(),
      'EIO/SYSSIG_IN': [{ name: '', attributes: { Signal: 'diStop', Action: 'Stop' } }],
    });
    expect(await readSystemSignals(skipped.adapter)).toEqual([{ signal: 'diStop', category: 'system-input', action: 'Stop', domain: 'EIO' }]);
    const other = new RwsError('Resource not found', 'RESOURCE_NOT_FOUND', 400, undefined, -1073445866);
    await expect(readSystemSignals(cfgAdapter({ 'SYS/SYSSIG_IN': other }).adapter)).rejects.toBe(other);
  });

  it('fails closed: any other refusal, or an instance that names no signal, throws', async () => {
    const busy = new RwsError('busy', 'CONTROLLER_BUSY', 503);
    await expect(readSystemSignals(cfgAdapter({ 'EIO/SYSSIG_IN': busy }).adapter)).rejects.toBe(busy);
    await expect(readSystemSignals(cfgAdapter({ 'SYS/SYSSIG_IN': new Error('socket hang up') }).adapter)).rejects.toThrow('socket hang up');
    const unnamed = cfgAdapter({ 'SYS/SYSSIG_IN': [{ name: 'x', attributes: { Action: 'Stop' } }] });
    await expect(readSystemSignals(unnamed.adapter)).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('is UNSUPPORTED_OPERATION for an adapter without listCfgInstancesDetailed', async () => {
    await expect(readSystemSignals({} as IRWSAdapter)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('answers a frozen list of frozen bindings', async () => {
    const bindings = await readSystemSignals(cfgAdapter({ 'SYS/SYSSIG_IN': [{ name: 'a', attributes: { Name: 'a', Action: 'Start' } }] }).adapter);
    expect(Object.isFrozen(bindings)).toBe(true);
    expect(Object.isFrozen(bindings[0])).toBe(true);
  });
});

describe('signalCategoryOf', () => {
  const bindings: SystemSignalBinding[] = [
    { signal: 'diStart', category: 'system-input', action: 'Start', domain: 'SYS' },
    { signal: 'diStart', category: 'system-input', action: 'StartMain', domain: 'SYS' },
    { signal: 'diStart', category: 'system-input', action: 'Start', domain: 'EIO' },
    { signal: 'MotLmpPB', category: 'system-output', action: 'MotorOn', domain: 'SYS' },
    { signal: 'doBoth', category: 'system-output', action: 'CycleOn', domain: 'SYS' },
    { signal: 'doBoth', category: 'system-input', action: 'Stop', domain: 'SYS' },
  ];

  it('matches without regard to case and lists each action once', () => {
    expect(signalCategoryOf(bindings, 'DISTART')).toEqual({ category: 'system-input', actions: ['Start', 'StartMain'] });
    expect(signalCategoryOf(bindings, 'motlmppb')).toEqual({ category: 'system-output', actions: ['MotorOn'] });
  });

  it('a signal bound as an input anywhere is a system input', () => {
    expect(signalCategoryOf(bindings, 'doBoth')).toEqual({ category: 'system-input', actions: ['CycleOn', 'Stop'] });
  });

  it('an unbound signal is plain', () => {
    expect(signalCategoryOf(bindings, 'do_lamp')).toEqual({ category: 'plain', actions: [] });
  });
});

describe('RobotManager.listSystemSignals and getSignalCategory', () => {
  const lists = { 'SYS/SYSSIG_IN': [{ name: 'diStart', attributes: { Name: 'diStart', Action: 'Start' } }] };

  it('reads once per session, also for calls made while the read is in flight', async () => {
    const { adapter, calls } = cfgAdapter(lists);
    const mgr = connected(adapter);
    const [a, b] = await Promise.all([mgr.listSystemSignals(), mgr.getSignalCategory('distart')]);
    expect(a).toHaveLength(1);
    expect(b).toEqual({ category: 'system-input', actions: ['Start'] });
    expect(await mgr.getSignalCategory('do1')).toEqual({ category: 'plain', actions: [] });
    expect(calls).toHaveLength(4);
  });

  it('reads again in a new session, and when asked to refresh', async () => {
    const { adapter, calls } = cfgAdapter(lists);
    const mgr = connected(adapter);
    await mgr.listSystemSignals();
    reconnect(mgr);
    await mgr.listSystemSignals();
    expect(calls).toHaveLength(8);
    await mgr.listSystemSignals({ refresh: true });
    expect(calls).toHaveLength(12);
  });

  it('keeps no failed read: the next call reads again', async () => {
    let fail = true;
    const adapter = {
      listCfgInstancesDetailed: async () => {
        if (fail) { throw new RwsError('busy', 'CONTROLLER_BUSY', 503); }
        return [];
      },
    } as unknown as IRWSAdapter;
    const mgr = connected(adapter);
    await expect(mgr.getSignalCategory('diStart')).rejects.toMatchObject({ code: 'CONTROLLER_BUSY' });
    fail = false;
    expect(await mgr.getSignalCategory('diStart')).toEqual({ category: 'plain', actions: [] });
  });

  it('is NOT_CONNECTED with no session and INVALID_ARGUMENT for an empty name', async () => {
    await expect(new RobotManager().listSystemSignals()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(connected(cfgAdapter({}).adapter).getSignalCategory('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('answers through a real RWS1Adapter (RW 6.16.03 recorded bodies)', async () => {
    const { client } = fakeRws1(url => url.startsWith('/rw/cfg/SYS/')
      ? { status: 400, body: RW6_INVALID_TYPE }
      : { status: 200, body: url.includes('SYSSIG_OUT') ? RW6_SYSSIG_OUT : RW6_EMPTY });
    const mgr = connected(new RWS1Adapter(client));
    expect(await mgr.getSignalCategory('MotLmp')).toEqual({ category: 'system-output', actions: ['MotorOn'] });
  });
});

describe('fails closed where a read would look like "no system inputs"', () => {
  it('UNSUPPORTED_OPERATION when neither domain serves the inputs, instead of calling every signal plain', async () => {
    const inputs = cfgAdapter({ 'SYS/SYSSIG_IN': invalidType(), 'EIO/SYSSIG_IN': invalidType() });
    await expect(readSystemSignals(inputs.adapter)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', message: expect.stringContaining('SYSSIG_IN') });
    const all = cfgAdapter({ 'SYS/SYSSIG_IN': invalidType(), 'SYS/SYSSIG_OUT': invalidType(), 'EIO/SYSSIG_IN': invalidType(), 'EIO/SYSSIG_OUT': invalidType() });
    await expect(connected(all.adapter).getSignalCategory('diStart')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('RWS 1.0: JSON with no listing in it is PARSE_ERROR, not an empty list', async () => {
    const { client } = fakeRws1(() => ({ status: 200, body: '{"_links":{"base":{"href":"http://127.0.0.1:4578/rw/cfg/"}}}' }));
    await expect(new RWS1Adapter(client).listCfgInstancesDetailed('EIO', 'SYSSIG_IN')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('RWS 2.0: JSON with no listing in it is not a page', () => {
    expect(cfgInstanceList('{"_links":{"self":{"href":"SYS/SYSSIG_IN/instances"}}}')).toBeNull();
    expect(cfgInstanceList('{"_embedded":{}}')).toBeNull();
  });

  it('a listing of more than 50 pages is PARSE_ERROR, not its first 50 pages', async () => {
    const page = '{"_links":{"base":{"href":"http://127.0.0.1:4578/rw/cfg/"},"next":{"href":"EIO/SYSSIG_IN/instances?start=1&amp;json=1"}},"_embedded":{"_state":[]}}';
    const { client, urls } = fakeRws1(() => ({ status: 200, body: page }));
    await expect(new RWS1Adapter(client).listCfgInstancesDetailed('EIO', 'SYSSIG_IN')).rejects.toMatchObject({ code: 'PARSE_ERROR', message: expect.stringContaining('50 pages') });
    expect(urls).toHaveLength(50);
    const page2 = '{"_links":{"base":{"href":"http://127.0.0.1/rw/cfg/"},"next":{"href":"SYS/SYSSIG_IN/instances?start=1"}},"_embedded":{"resources":[]}}';
    await withServer(() => [200, page2], async (client2, urls2) => {
      await expect(client2.listCfgInstancesDetailed('SYS', 'SYSSIG_IN')).rejects.toMatchObject({ code: 'PARSE_ERROR', message: expect.stringContaining('50 pages') });
      expect(urls2).toHaveLength(50);
    });
  }, 30_000);

  it('a configuration write, a restart or a restore through the manager drops the kept read', async () => {
    const { adapter, calls } = cfgAdapter({});
    Object.assign(adapter, { setCfgInstance: async () => {}, restartController: async () => {}, restoreBackup: async () => {} });
    const mgr = connected(adapter);
    (mgr as unknown as { access: () => unknown }).access = () => ({ withAccess: (_d: unknown, fn: () => Promise<unknown>) => fn(), generation: () => 'rw7' });
    await mgr.listSystemSignals();
    await mgr.listSystemSignals();
    expect(calls).toHaveLength(4);
    await mgr.setCfgInstance('SYS', 'SYSSIG_IN', 'diStart', { Action: 'Start' });
    await mgr.listSystemSignals();
    expect(calls).toHaveLength(8);
    await mgr.restartController('restart');
    await mgr.listSystemSignals();
    expect(calls).toHaveLength(12);
    await mgr.restoreBackup('Before');
    await mgr.listSystemSignals();
    expect(calls).toHaveLength(16);
  });
});
