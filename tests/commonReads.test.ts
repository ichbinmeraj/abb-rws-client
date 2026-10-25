import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';
import { searchRapidSymbols as mapSearchRapidSymbols } from '../src/ResourceMapper.js';
import { ALL_TABLES, buildPath } from '../src/paths/index.js';
import type { PathSpec } from '../src/paths/index.js';
import {
  fileMetadataFromHeaders, rapidTaskFrom, routinesFromSymbols, routineType,
} from '../src/commonReads.js';
import { RwsError, type RapidSymbolInfo, type RapidSymbolSearchParams } from '../src/types.js';

/**
 * Reads both generations serve: one RAPID task, one CFG type and its
 * attributes, a DIPC queue's information, one I/O network and device, a
 * module's routines and a file's metadata.
 *
 * Shapes, and where they come from:
 * - the CFG type XHTML is the body RW 6.16.03 answered on 2026-09-29 for
 *   `GET /rw/cfg/SYS/CAB_TASKS?action=show` (it lists exactly the two items
 *   ABB's CFG_Service Rev L example shows);
 * - the RW 6.16.03 symbol-search hits mirror the module-scoped search it
 *   answered on 2026-09-29 (a VAR and a PROC directly in the module);
 * - the task list item is the `rap-task-li` RW 7.21.4 and 8.2.1 answered on
 *   2026-09-29;
 * - every other body (single task, network, device, the RWS 1.0 DIPC queue,
 *   RWS 1.0 attributes, routine listing, file metadata) has not been
 *   captured on any build: those tests pin the URL, the class the client
 *   reads, and the typed failure when the class is absent.
 */

// ── RWS 1.0 fake ────────────────────────────────────────────────────────────

interface Call { what: string; body?: string }

function fake1(respond?: (method: string, url: string) => { status: number; body: string } | undefined) {
  const calls: Call[] = [];
  const searches: RapidSymbolSearchParams[] = [];
  let hits: RapidSymbolInfo[] = [];
  const client = {
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return respond?.(method, url) ?? { status: 204, body: '' };
    },
    searchRapidSymbols: async (p: RapidSymbolSearchParams) => { searches.push(p); return hits; },
  };
  return {
    calls, searches,
    setHits: (h: RapidSymbolInfo[]) => { hits = h; },
    adapter: new RWS1Adapter(client as unknown as RwsClient),
  };
}

const rw6 = (state: unknown[], links: Record<string, unknown> = {}): string => JSON.stringify({
  _links: { base: { href: 'http://127.0.0.1:4578/rw/' }, ...links },
  _embedded: { _state: state },
});

/** RW 6.16.03, 2026-09-29: `GET /rw/cfg/SYS/CAB_TASKS?action=show`. */
const CFG_TYPE_RW6 = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>cfg</title> <base href="http://127.0.0.1:4578/rw/cfg/"/></head><body><div class="state"><a href="SYS/CAB_TASKS" rel="self"></a> <ul><li class="cfg-dt-attributes-li" title="attributes"><a href="SYS/CAB_TASKS/attributes" rel="self"></a><span class="cfg-no-of-attributes">16</span></li> <li class="cfg-dt-instances-li" title="instances"> <a href="SYS/CAB_TASKS/instances" rel="self"></a><span class="cfg-no-of-instances">1</span></li></ul></div></body></html>';

/**
 * RW 6.16.03, 2026-09-29: the shape of `GET /fileservice/$HOME/{dir}?json=1`,
 * a directory listing with one fs-file entry per child, each carrying the
 * fs- fields (the same shape it answered for $HOME itself).
 */
const DIR_LISTING_RW6 = (entries: Array<Record<string, string>>): string => JSON.stringify({
  _links: { base: { href: 'http://127.0.0.1:4578/fileservice/%24HOME/ZZ_PROBE_R5/' }, parent: { href: '../?json=1' } },
  _embedded: { status: { code: 294912 }, _state: entries },
});
const FS_A = { _type: 'fs-file', _title: 'a.txt', 'fs-cdate': '2026-09-29 T 12:13:22', 'fs-mdate': '2026-09-29 T 12:13:22', 'fs-size': '11', 'fs-readonly': 'false' };
const FS_B = { _type: 'fs-file', _title: 'b.txt', 'fs-cdate': '2026-09-29 T 12:13:29', 'fs-mdate': '2026-09-29 T 12:13:29', 'fs-size': '24', 'fs-readonly': 'false' };

const NOT_FOUND_RW6 = String.raw`{"_links":{"base": { "href": "http://127.0.0.1:4578/" }},"_embedded" :{ "status" : {"code":-1073414146, "msg": "Resource not found code:-1073414146 icode:-1"}, "_state":[  ] }}`;

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(RwsError);
  return e as RwsError;
}

// ── RWS 2.0 server ──────────────────────────────────────────────────────────

interface Recorded { method: string; url: string; body: string }
type Reply = { status: number; headers?: Record<string, string>; body?: string };

async function server2(reply: (method: string, url: string) => Reply) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      const r = reply(req.method ?? '', req.url ?? '');
      res.writeHead(r.status, r.headers ?? {});
      res.end(r.body ?? '');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, requests, client: new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics') };
}

const HAL = { 'Content-Type': 'application/hal+json;v=2.0' };
const hal = (state: unknown[], resources: unknown[] = []): string => JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1/rw/' } },
  ...(state.length ? { state } : {}),
  ...(resources.length ? { _embedded: { resources } } : {}),
});

/** RW 7.21.4 / 8.2.1, 2026-09-29: the T_ROB1 item of `GET /rw/rapid/tasks`. */
const TASK_LI_RW7 = { _links: { self: { href: 'tasks/T_ROB1' } }, _type: 'rap-task-li', _title: 'T_ROB1', name: 'T_ROB1', type: 'normal', taskstate: 'initiated', excstate: 'ready', active: 'On', motiontask: 'TRUE' };

// ── Path rows ───────────────────────────────────────────────────────────────

describe('common reads - path rows on both generations', () => {
  const P = { task: 'T_ROB1', module: 'M1', domain: 'SYS', type: 'CAB_TASKS', queue: 'RimDispatcher', network: 'Local', device: 'DRV_1', path: 'HOME/a.txt' };
  const url = (domain: string, op: string, gen: 'rws1' | 'rws2'): string =>
    buildPath(ALL_TABLES[domain][op][gen] as PathSpec, P);

  it('each operation has a row for each generation', () => {
    expect(url('rapid', 'getRapidTask', 'rws2')).toBe('/rw/rapid/tasks/T_ROB1');
    expect(url('rapid', 'getRapidTask', 'rws1')).toBe('/rw/rapid/tasks/T_ROB1');
    expect(url('cfgElogDipc', 'getCfgType', 'rws2')).toBe('/rw/cfg/SYS/CAB_TASKS');
    expect(url('cfgElogDipc', 'getCfgType', 'rws1')).toBe('/rw/cfg/SYS/CAB_TASKS');
    expect(url('cfgElogDipc', 'listCfgTypeAttributes', 'rws1')).toBe('/rw/cfg/SYS/CAB_TASKS/attributes');
    expect(url('cfgElogDipc', 'getDipcQueueInfo', 'rws2')).toBe('/rw/dipc/RimDispatcher/information');
    expect(url('cfgElogDipc', 'getDipcQueueInfo', 'rws1')).toBe('/rw/dipc/RimDispatcher');
    expect(url('io', 'getIoNetwork', 'rws1')).toBe('/rw/iosystem/networks/Local');
    expect(url('io', 'getIoDeviceInfo', 'rws2')).toBe('/rw/iosystem/devices/Local/DRV_1');
    expect(url('io', 'getIoDeviceInfo', 'rws1')).toBe('/rw/iosystem/devices/DRV_1');
    expect(url('rapid', 'listModuleRoutines', 'rws2')).toBe('/rw/rapid/symbols/search');
    expect(url('rapid', 'listModuleRoutines', 'rws1')).toBe('/rw/rapid/symbols?action=search-symbols');
    expect(ALL_TABLES.filesVision.getFileMetadata.rws2?.method).toBe('HEAD');
    expect(ALL_TABLES.filesVision.getFileMetadata.rws1).toMatchObject({ method: 'GET', path: '/fileservice/{parent}' });
  });
});

// ── getRapidTask ────────────────────────────────────────────────────────────

describe('getRapidTask', () => {
  it('RWS 1.0 GETs the task with ?json=1 and returns the rap-task entry', async () => {
    const f = fake1(() => ({ status: 200, body: rw6([{ _type: 'rap-task', _title: 'T_ROB1', name: 'T_ROB1', type: 'normal', taskstate: 'started', excstate: 'stopped', active: 'On', motiontask: 'TRUE' }]) }));
    const t = await f.adapter.getRapidTask('T_ROB1');
    expect(f.calls).toEqual([{ what: 'GET /rw/rapid/tasks/T_ROB1?json=1', body: undefined }]);
    expect(t).toMatchObject({ name: 'T_ROB1', taskstate: 'started', excstate: 'stopped', motiontask: 'TRUE' });
    expect(t['_type']).toBeUndefined();
  });

  it('RWS 1.0: an answer without a task entry is PARSE_ERROR, a 404 the typed refusal', async () => {
    const f = fake1(() => ({ status: 200, body: rw6([{ _type: 'rap-pcp', _title: 'pcp' }]) }));
    const e = await rejection(f.adapter.getRapidTask('T_ROB1'));
    expect(e.code).toBe('PARSE_ERROR');
    expect(e.message).toMatch(/classes seen: rap-pcp/);
    const g = fake1(() => ({ status: 404, body: NOT_FOUND_RW6 }));
    expect(await rejection(g.adapter.getRapidTask('NOPE'))).toMatchObject({ httpStatus: 404, controllerCode: -1073414146 });
    await expect(f.adapter.getRapidTask('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('RWS 2.0 GETs /rw/rapid/tasks/{task}; rap-task wins, else the task\'s rap-task-li', async () => {
    const { server, requests, client } = await server2(() => ({ status: 200, headers: HAL, body: hal([{ _type: 'rap-task', _title: 'T_ROB1', name: 'T_ROB1', taskstate: 'started' }], [TASK_LI_RW7]) }));
    try {
      expect(await client.getRapidTask('T_ROB1')).toMatchObject({ name: 'T_ROB1', taskstate: 'started' });
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /rw/rapid/tasks/T_ROB1']);
    } finally { server.close(); }
    const two = await server2(() => ({ status: 200, headers: HAL, body: hal([], [TASK_LI_RW7]) }));
    try {
      expect(await two.client.getRapidTask('T_ROB1')).toMatchObject({ name: 'T_ROB1', taskstate: 'initiated', active: 'On' });
    } finally { two.server.close(); }
  });

  it('a list that does not name the task is PARSE_ERROR, never the state of another task', async () => {
    const e = (() => { try { rapidTaskFrom([TASK_LI_RW7 as unknown as Record<string, string>], 'T_ROB2', 'x'); return null; } catch (x) { return x as RwsError; } })();
    expect(e).toBeInstanceOf(RwsError);
    expect(e?.code).toBe('PARSE_ERROR');
    expect(e?.message).toMatch(/no task named T_ROB2 \(tasks listed: T_ROB1\)/);
    const two = await server2(() => ({ status: 200, headers: HAL, body: hal([], [TASK_LI_RW7]) }));
    try {
      expect((await rejection(two.client.getRapidTask('T_ROB2'))).code).toBe('PARSE_ERROR');
    } finally { two.server.close(); }
    const f = fake1(() => ({ status: 200, body: rw6([{ ...TASK_LI_RW7, _links: undefined }]) }));
    expect((await rejection(f.adapter.getRapidTask('T_ROB2'))).code).toBe('PARSE_ERROR');
  });
});

// ── getCfgType / listCfgTypeAttributes ──────────────────────────────────────

describe('getCfgType', () => {
  it('RWS 1.0 reads the XHTML type (items as on the RW 6.16.03 ?action=show page) without ?json=1', async () => {
    const f = fake1(() => ({ status: 200, body: CFG_TYPE_RW6 }));
    expect(await f.adapter.getCfgType('SYS', 'CAB_TASKS'))
      .toEqual({ domain: 'SYS', type: 'CAB_TASKS', attributeCount: 16, instanceCount: 1 });
    expect(f.calls.map(c => c.what)).toEqual(['GET /rw/cfg/SYS/CAB_TASKS']);
  });

  it('RWS 2.0 reads ABB\'s items from hal+json and fails typed without them', async () => {
    const body = hal([], [
      { _links: { self: { href: 'eio/INDUSTRIAL_NETWORK/attributes' } }, _type: 'cfg-dt-attributes-li', _title: 'attributes', 'cfg-no-of-attributes': '11' },
      { _links: { self: { href: 'eio/INDUSTRIAL_NETWORK/instances' } }, _type: 'cfg-dt-instances-li', _title: 'instances', 'cfg-no-of-instances': '3' },
    ]);
    const { server, requests, client } = await server2(() => ({ status: 200, headers: HAL, body }));
    try {
      expect(await client.getCfgType('EIO', 'INDUSTRIAL_NETWORK'))
        .toEqual({ domain: 'EIO', type: 'INDUSTRIAL_NETWORK', attributeCount: 11, instanceCount: 3 });
      expect(requests[0].url).toBe('/rw/cfg/EIO/INDUSTRIAL_NETWORK');
    } finally { server.close(); }
    const bad = await server2(() => ({ status: 200, headers: HAL, body: hal([{ _type: 'cfg-dt-li', _title: 'X' }]) }));
    try {
      expect((await rejection(bad.client.getCfgType('EIO', 'X'))).code).toBe('PARSE_ERROR');
    } finally { bad.server.close(); }
  });
});

describe('RWS1Adapter.listCfgTypeAttributes', () => {
  it('reads cfg-dt-attribute entries and follows the next link relative to base', async () => {
    const page1 = rw6([{ _type: 'cfg-dt-attribute-li', _title: 'Name', name: 'Name', type: 'string', mandatory: 'true' }],
      { base: { href: 'http://127.0.0.1:4578/rw/cfg/' }, next: { href: 'SYS/CAB_TASKS/attributes?start=2&amp;limit=1&json=1' } });
    const page2 = rw6([{ _type: 'cfg-dt-attribute-li', _title: 'Type', name: 'Type', type: 'string' }]);
    const f = fake1((_m, url) => ({ status: 200, body: url.includes('start=2') ? page2 : page1 }));
    const attrs = await f.adapter.listCfgTypeAttributes('SYS', 'CAB_TASKS');
    expect(attrs.map(a => a['name'])).toEqual(['Name', 'Type']);
    expect(attrs[0]['_type']).toBeUndefined();
    expect(f.calls.map(c => c.what)).toEqual([
      'GET /rw/cfg/SYS/CAB_TASKS/attributes?json=1',
      'GET /rw/cfg/SYS/CAB_TASKS/attributes?start=2&limit=1&json=1',
    ]);
  });

  it('typed entries but no attribute class is PARSE_ERROR; a refusal is typed', async () => {
    const f = fake1(() => ({ status: 200, body: rw6([{ _type: 'cfg-dt-li', _title: 'X' }]) }));
    expect((await rejection(f.adapter.listCfgTypeAttributes('SYS', 'X'))).code).toBe('PARSE_ERROR');
    const g = fake1(() => ({ status: 404, body: NOT_FOUND_RW6 }));
    expect(await rejection(g.adapter.listCfgTypeAttributes('SYS', 'X'))).toMatchObject({ httpStatus: 404 });
  });
});

// ── getDipcQueueInfo ────────────────────────────────────────────────────────

describe('RWS1Adapter.getDipcQueueInfo', () => {
  it('GETs the queue with no action and reads the queue fields', async () => {
    const f = fake1(() => ({ status: 200, body: rw6([{ _type: 'dipc-queue', _title: 'RimDispatcher', 'queue-name': 'RimDispatcher', 'queue-size': '10', 'queue-max-msg-size': '444' }]) }));
    expect(await f.adapter.getDipcQueueInfo('RimDispatcher')).toEqual({ name: 'RimDispatcher', size: 10, maxMsgSize: 444, slotId: undefined });
    expect(f.calls.map(c => c.what)).toEqual(['GET /rw/dipc/RimDispatcher?json=1']);
    expect(f.calls[0].what).not.toMatch(/dipc-read/);
  });

  it('reads the dipc- spelling too, answers null for an unknown queue, and types other refusals', async () => {
    const f = fake1(() => ({ status: 200, body: rw6([{ _type: 'dipc-queue-li', _title: 'q', 'dipc-queue-size': '5', 'dipc-max-msg-size': '100' }]) }));
    expect(await f.adapter.getDipcQueueInfo('q')).toEqual({ name: 'q', size: 5, maxMsgSize: 100, slotId: undefined });
    const missing = fake1(() => ({ status: 400, body: rw6([]).replace('"_state"', '"status":{"code":-1073445879,"msg":"Error Queue does not exist"},"_state"') }));
    expect(await missing.adapter.getDipcQueueInfo('nope')).toBeNull();
    const busy = fake1(() => ({ status: 503, body: '' }));
    expect(await rejection(busy.adapter.getDipcQueueInfo('q'))).toMatchObject({ httpStatus: 503 });
    const odd = fake1(() => ({ status: 200, body: rw6([{ _type: 'dipc-info-li', _title: 'info', 'max-body-size': '444' }]) }));
    expect((await rejection(odd.adapter.getDipcQueueInfo('q'))).code).toBe('PARSE_ERROR');
  });
});

// ── getIoNetwork / getIoDeviceInfo ──────────────────────────────────────────

describe('RWS1Adapter I/O network and device reads', () => {
  it('getIoNetwork GETs the network and returns the ios-network entry', async () => {
    const f = fake1(() => ({ status: 200, body: rw6([{ _type: 'ios-network', _title: 'Local', name: 'Local', pstate: 'running', lstate: 'started' }]) }));
    expect(await f.adapter.getIoNetwork('Local')).toEqual({ _title: 'Local', name: 'Local', pstate: 'running', lstate: 'started' });
    expect(f.calls.map(c => c.what)).toEqual(['GET /rw/iosystem/networks/Local?json=1']);
  });

  it('getIoDeviceInfo names the device without its network, as RW 6.16.03 links it', async () => {
    const f = fake1(() => ({ status: 200, body: rw6([{ _type: 'ios-device-li', _title: 'Local/DRV_1', name: 'DRV_1', lstate: 'enabled', pstate: 'running' }]) }));
    expect(await f.adapter.getIoDeviceInfo('Local', 'DRV_1')).toMatchObject({ name: 'DRV_1', lstate: 'enabled' });
    expect(f.calls.map(c => c.what)).toEqual(['GET /rw/iosystem/devices/DRV_1?json=1']);
  });

  it('an answer without the class is PARSE_ERROR naming what it saw', async () => {
    const f = fake1(() => ({ status: 200, body: rw6([{ _type: 'ios-signal', _title: 'x' }]) }));
    const e = await rejection(f.adapter.getIoDeviceInfo('', 'PANEL'));
    expect(e.code).toBe('PARSE_ERROR');
    expect(e.message).toMatch(/ios-device \/ ios-device-li.*classes seen: ios-signal/);
    await expect(f.adapter.getIoNetwork(' ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

// ── listModuleRoutines ──────────────────────────────────────────────────────

describe('listModuleRoutines', () => {
  const sym = (symburl: string, symtyp: string): RapidSymbolInfo => ({
    symburl, name: symburl.split('/').pop() ?? '', symtyp, dattyp: '', ndim: 0, local: false, ro: false, taskvar: false,
  });

  it('RWS 1.0 uses the module-scoped symbol search and keeps routines directly in the module', async () => {
    const f = fake1();
    f.setHits([
      sym('RAPID/T_ROB1/ZZ_PROBE/zz_probe_v', 'var'),
      sym('RAPID/T_ROB1/ZZ_PROBE/zz_probe_noop2', 'prc'),
      sym('RAPID/T_ROB1/ZZ_PROBE/zz_func', 'fun'),
      sym('RAPID/T_ROB1/ZZ_PROBE/zz_func/arg1', 'par'),
      sym('RAPID/T_ROB1/OTHER/elsewhere', 'prc'),
    ]);
    expect(await f.adapter.listModuleRoutines('T_ROB1', 'ZZ_PROBE')).toEqual([
      { name: 'zz_probe_noop2', type: 'prc' },
      { name: 'zz_func', type: 'fun' },
    ]);
    expect(f.searches).toEqual([{ task: 'T_ROB1', blockurl: 'RAPID/T_ROB1/ZZ_PROBE', symtyp: 'any' }]);
    expect(f.calls).toEqual([]); // no GET of the old routines path
    // The wire body the RWS 1.0 client builds for that search.
    expect(mapSearchRapidSymbols(f.searches[0])).toEqual({
      path: '/rw/rapid/symbols?action=search-symbols',
      body: 'task=T_ROB1&view=block&symtyp=any&blockurl=RAPID%2FT_ROB1%2FZZ_PROBE&recursive=TRUE',
    });
  });

  it('RWS 1.0 passes a search refusal through instead of answering []', async () => {
    const client = {
      request: async () => ({ status: 204, body: '' }),
      searchRapidSymbols: async () => { throw new RwsError('refused', 'INVALID_ARGUMENT', 400); },
    };
    const a = new RWS1Adapter(client as unknown as RwsClient);
    await expect(a.listModuleRoutines('T_ROB1', 'M')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(a.listModuleRoutines('T_ROB1', '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('RWS 2.0 lists them with the module-scoped symbol search, every entry read by symtyp', async () => {
    // The hit shape RW 7.21.4 answered for a non-recursive module search
    // (rap-sympropvar-li / rap-sympropproc-li, 2026-09-29); the trap's list
    // class is not recorded, so a hit of an unknown class must still be read.
    // The live answer carries a positive status block and the hits under _embedded.resources.
    const hit = (cls: string, url: string, symtyp: string): Record<string, unknown> => ({
      _links: { self: { href: `symbol/${url}/properties` } }, _type: cls, _title: url, symburl: url, name: url.split('/').pop(), symtyp,
    });
    const body = JSON.stringify({
      _links: { base: { href: 'https://127.0.0.1/rw/rapid/' }, self: { href: 'symbols/search' } },
      status: { code: 294912 },
      _embedded: {
        resources: [
          hit('rap-sympropvar-li', 'RAPID/T_ROB1/M1/v', 'var'),
          hit('rap-sympropproc-li', 'RAPID/T_ROB1/M1/main', 'prc'),
          hit('rap-sympropfunction-li', 'RAPID/T_ROB1/M1/calc', 'fun'),
          hit('rap-sympropother-li', 'RAPID/T_ROB1/M1/onErr', 'trp'),
          hit('rap-sympropparam-li', 'RAPID/T_ROB1/M1/calc/x', 'par'),
          hit('rap-sympropproc-li', 'RAPID/T_ROB1/OTHER/elsewhere', 'prc'),
        ],
      },
    });
    const { server, requests, client } = await server2(() => ({ status: 200, headers: HAL, body }));
    try {
      expect(await client.listModuleRoutines('T_ROB1', 'M1')).toEqual([
        { name: 'main', type: 'prc' }, { name: 'calc', type: 'fun' }, { name: 'onErr', type: 'trp' },
      ]);
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['POST /rw/rapid/symbols/search']);
      expect(Object.fromEntries(new URLSearchParams(requests[0].body))).toEqual({
        view: 'block', blockurl: 'RAPID/T_ROB1/M1', symtyp: 'any', recursive: 'FALSE',
      });
      // Never the position-scoped routine resource (400 "Row or Column
      // invalid/missing" for a plain GET on RW 7.21.4, 2026-10-01).
      expect(requests.some(r => r.url.includes('/routine'))).toBe(false);
    } finally { server.close(); }
  });

  it('RWS 2.0: a module with no routine is [], a refusal is typed, an empty name is refused unsent', async () => {
    const noRoutines = hal([
      { _type: 'rap-sympropvar-li', _title: 'RAPID/T_ROB1/M2/v', symburl: 'RAPID/T_ROB1/M2/v', name: 'v', symtyp: 'var' },
    ]);
    const refused = JSON.stringify({ _links: {}, status: { code: -1073445879, msg: 'bad blockurl' } });
    let n = 0;
    const { server, requests, client } = await server2(() => (++n === 1
      ? { status: 200, headers: HAL, body: noRoutines }
      : { status: 400, headers: HAL, body: refused }));
    try {
      expect(await client.listModuleRoutines('T_ROB1', 'M2')).toEqual([]);
      const e = await rejection(client.listModuleRoutines('T_ROB1', 'M3'));
      expect(e.httpStatus).toBe(400);
      expect((await rejection(client.listModuleRoutines('T_ROB1', ' '))).code).toBe('INVALID_ARGUMENT');
      expect(requests).toHaveLength(2);
    } finally { server.close(); }
  });

  it('routine kinds normalise to the symbol-search spelling', () => {
    expect(['PROC', 'procedure', 'prc', 'FUNC', 'function', 'TRAP', 'Other'].map(routineType))
      .toEqual(['prc', 'prc', 'prc', 'fun', 'fun', 'trp', 'other']);
    expect(routinesFromSymbols([{ symburl: 'rapid/t_rob1/m/Main', name: 'Main', symtyp: 'prc' }], 'T_ROB1', 'M'))
      .toEqual([{ name: 'Main', type: 'prc' }]);
  });
});

// ── getFileMetadata ─────────────────────────────────────────────────────────

describe('getFileMetadata', () => {
  it('RWS 2.0 sends HEAD on the HOME-mapped path and reads the headers (cookies left out)', async () => {
    const { server, requests, client } = await server2(() => ({
      status: 200,
      headers: { 'Content-Length': '1234', 'Last-Modified': 'Tue, 29 Sep 2026 11:59:11 GMT', 'Content-Type': 'text/plain', 'Set-Cookie': '-http-session-=abc; Path=/' },
    }));
    try {
      const m = await client.getFileMetadata('$HOME/ZZ_PROBE/a.txt');
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['HEAD /fileservice/HOME/ZZ_PROBE/a.txt']);
      expect(m).toMatchObject({ path: '$HOME/ZZ_PROBE/a.txt', size: 1234, modified: 'Tue, 29 Sep 2026 11:59:11 GMT', contentType: 'text/plain' });
      expect(m.fields['set-cookie']).toBeUndefined();
    } finally { server.close(); }
  });

  it('RWS 2.0: a 204 (ABB\'s documented answer) states no size; a missing file is a typed refusal', async () => {
    const { server, client } = await server2((_m, url) => url.includes('missing')
      ? { status: 404 }
      : { status: 204, headers: { 'Last-Modified': 'Wed, 30 Sep 2026 08:00:00 GMT' } });
    try {
      const m = await client.getFileMetadata('HOME/a.txt');
      expect(m.size).toBeUndefined();
      expect(m.modified).toBe('Wed, 30 Sep 2026 08:00:00 GMT');
      const e = await rejection(client.getFileMetadata('HOME/missing.txt'));
      expect(e.httpStatus).toBe(404);
      await expect(client.getFileMetadata('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally { server.close(); }
  });

  it('RWS 1.0 reads the file\'s entry in its directory listing and sends nothing else (?action=metadata is in no Rev M page; RW 6.16.03 refuses it)', async () => {
    const listings: string[] = [];
    const requests: string[] = [];
    const client = {
      request: async (method: string, url: string) => { requests.push(`${method} ${url}`); return { status: 204, body: '' }; },
      listDirectory: async (dir: string) => {
        listings.push(dir);
        return [
          { name: 'other.txt', type: 'file', size: 1 },
          { name: 'ZZ_PROBE_META.txt', type: 'file', size: 36, created: '2026-10-01 T 06:18:36', modified: '2026-10-01 T 06:18:36', readonly: false },
          { name: 'ZZ_DIR', type: 'dir' },
        ];
      },
    };
    const a = new RWS1Adapter(client as unknown as RwsClient);
    expect(await a.getFileMetadata('$TEMP/zz_probe_meta.txt')).toEqual({
      path: '$TEMP/zz_probe_meta.txt', size: 36, created: '2026-10-01 T 06:18:36', modified: '2026-10-01 T 06:18:36', readonly: false,
      fields: { 'fs-size': '36', 'fs-cdate': '2026-10-01 T 06:18:36', 'fs-mdate': '2026-10-01 T 06:18:36', 'fs-readonly': 'false' },
    });
    expect(listings).toEqual(['$TEMP']);
    expect(requests).toEqual([]);
    expect((await rejection(a.getFileMetadata('$TEMP/missing.txt'))).code).toBe('RESOURCE_NOT_FOUND');
    expect((await rejection(a.getFileMetadata('$TEMP/ZZ_DIR'))).code).toBe('UNSUPPORTED_OPERATION');
    expect((await rejection(a.getFileMetadata('$TEMP'))).code).toBe('INVALID_ARGUMENT');
  });

  it('fileMetadataFromHeaders keeps every header but credentials', () => {
    const m = fileMetadataFromHeaders('p', 200, { 'content-length': '7', 'set-cookie': ['a=b'], 'x-extra': ['1', '2'] });
    expect(m.fields).toEqual({ 'content-length': '7', 'x-extra': '1, 2' });
    expect(m.size).toBe(7);
  });
});

// ── RobotManager ────────────────────────────────────────────────────────────

describe('RobotManager common reads', () => {
  it('answer an empty value when the adapter lacks the read', async () => {
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = {};
    expect(await mgr.getRapidTask('T_ROB1')).toEqual({});
    expect(await mgr.getCfgType('SYS', 'X')).toBeNull();
    expect(await mgr.listCfgTypeAttributes('SYS', 'X')).toEqual([]);
    expect(await mgr.getDipcQueueInfo('q')).toBeNull();
    expect(await mgr.getIoNetwork('Local')).toEqual({});
    expect(await mgr.getIoDeviceInfo('Local', 'DRV_1')).toEqual({});
    expect(await mgr.listModuleRoutines('T_ROB1', 'M')).toEqual([]);
    expect(await mgr.getFileMetadata('$HOME/a')).toBeNull();
  });

  it('forward to the adapter, refusals included', async () => {
    const mgr = new RobotManager();
    const adapter = {
      getRapidTask: vi.fn(async () => ({ name: 'T_ROB1' })),
      getIoDeviceInfo: vi.fn(async () => ({ name: 'DRV_1' })),
      listModuleRoutines: vi.fn(async () => { throw new RwsError('no', 'RESOURCE_NOT_FOUND', 404); }),
    };
    (mgr as unknown as { adapter: unknown }).adapter = adapter;
    expect(await mgr.getRapidTask('T_ROB1')).toEqual({ name: 'T_ROB1' });
    expect(await mgr.getIoDeviceInfo('Local', 'DRV_1')).toEqual({ name: 'DRV_1' });
    expect(adapter.getIoDeviceInfo).toHaveBeenCalledWith('Local', 'DRV_1');
    await expect(mgr.listModuleRoutines('T_ROB1', 'M')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
