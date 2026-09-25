import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';
import { RwsError } from '../src/types.js';
import { parseJointTargetFull } from '../src/ResponseParser.js';
import {
  JOINT_NOT_PRESENT, isJointValuePresent, toJointTargetFull, toMechunitDetails,
} from '../src/mechunit.js';
import * as publicApi from '../src/index.js';

/**
 * Motion reads for an external sampler (2026-09-25): the full jointtarget
 * (robot AND external axes) and the typed mechanical-unit description.
 *
 * The wire shapes come from reference probes P2/P3 (2026-09-23, RW 7.21 VC):
 * `jointtarget` sends twelve fields rax_1..6 + eax_a..f even for a 6-axis robot,
 * and a mechunit resource carries type / axes / axes-total / task-name. The RW 6
 * JSON spellings (`task`, `*-unitname`) are ABB errata E11.
 */

// ─── HTTP harness (same shape as the other RwsClient2 suites) ────────────────

interface Recorded { method: string; url: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '' });
      handle(req, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

/**
 * A manager that holds a live session on `adapter`, without the connect
 * handshake: the same three fields doConnect() sets once a session is up.
 * The motion reads refuse unless all three say "connected" (see
 * RobotManager.sessionAdapter).
 */
function connectedManager(adapter: unknown): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as {
    adapter: unknown; _state: { connected: boolean }; sessionEpoch: number | null; connectEpoch: number;
  };
  m.adapter = adapter;
  m._state.connected = true;
  m.sessionEpoch = m.connectEpoch;
  return mgr;
}

const HAL_CT = 'application/hal+json;v=2.0';
const XHTML_CT = 'application/xhtml+xml;v=2.0';

// Live-captured on the RW 7.21 VC (hal+json) - the same fixture the hal+json
// suite uses for getJointPositions, which proves both methods read one resource.
const HAL_JOINTTARGET = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/motionsystem/mechunits/ROB_1/jointtarget/" }, "self" : { "href" : "" } } ,"status" : {"code":294912} , "state" : [ { "_type" : "ms-jointtarget", "_title" : "ROB_1", "rax_1" : "10", "rax_2" : "15", "rax_3" : "-10", "rax_4" : "20", "rax_5" : "30", "rax_6" : "45", "eax_a" : "0", "eax_b" : "0", "eax_c" : "0", "eax_d" : "0", "eax_e" : "0", "eax_f" : "0" } ]}';

const xhtmlDoc = (inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">`
  + `<head><base href="http://x/"/></head><body><div class="state"><ul>${inner}</ul></div></body></html>`;

const JT_SPANS_WITH_TRACK =
  '<span class="rax_1">1.5</span><span class="rax_2">-2</span><span class="rax_3">3</span>'
  + '<span class="rax_4">4</span><span class="rax_5">5</span><span class="rax_6">6</span>'
  + '<span class="eax_a">1250.5</span><span class="eax_b">9E+09</span><span class="eax_c">9E+09</span>'
  + '<span class="eax_d">9E+09</span><span class="eax_e">9E+09</span><span class="eax_f">8999999488</span>';

// ─── The 9E9 marker ──────────────────────────────────────────────────────────

describe('isJointValuePresent / JOINT_NOT_PRESENT', () => {
  it('reads the 9E9 marker in each spelling it can arrive in as "not present"', () => {
    expect(JOINT_NOT_PRESENT).toBe(9e9);
    expect(isJointValuePresent(9e9)).toBe(false);
    expect(isJointValuePresent(Number('9E+09'))).toBe(false);
    expect(isJointValuePresent(8999999488)).toBe(false); // 9E9 through a float32
    expect(isJointValuePresent(-9e9)).toBe(false);
  });

  it('treats real axis values (degrees or mm, including 0) as present', () => {
    for (const v of [0, -170, 179.99, 1.12146960873361e-06, 3500.25, -12000]) {
      expect(isJointValuePresent(v), String(v)).toBe(true);
    }
  });

  it('treats NaN and infinities as not present', () => {
    expect(isJointValuePresent(NaN)).toBe(false);
    expect(isJointValuePresent(Infinity)).toBe(false);
    expect(isJointValuePresent(-Infinity)).toBe(false);
  });

  it('is exported from the public entry point', () => {
    expect(publicApi.JOINT_NOT_PRESENT).toBe(9e9);
    expect(publicApi.isJointValuePresent(0)).toBe(true);
  });
});

// ─── Field map -> JointTargetFull ────────────────────────────────────────────

describe('toJointTargetFull', () => {
  const full = {
    rax_1: '10', rax_2: '15', rax_3: '-10', rax_4: '20', rax_5: '30', rax_6: '1.12146960873361e-06',
    eax_a: '0', eax_b: '9E+09', eax_c: '9E9', eax_d: '9000000000', eax_e: '-45.5', eax_f: '0',
  };

  it('keeps all twelve slots in order, values exactly as sent', () => {
    expect(toJointTargetFull(full, 't')).toEqual({
      rax: [10, 15, -10, 20, 30, 1.12146960873361e-06],
      eax: [0, 9e9, 9e9, 9e9, -45.5, 0],
    });
  });

  it('reads an omitted or blank external field as not present (9E9)', () => {
    const { eax_c: _c, eax_d: _d, ...rest } = full;
    const r = toJointTargetFull({ ...rest, eax_f: '  ' }, 't');
    expect(r.eax).toEqual([0, 9e9, 9e9, 9e9, -45.5, 9e9]);
  });

  it('throws PARSE_ERROR when a robot axis is missing - no invented zero', () => {
    const { rax_4: _r, ...rest } = full;
    expect(() => toJointTargetFull(rest, 'jointtarget of ROB_1')).toThrow(RwsError);
    try { toJointTargetFull(rest, 'jointtarget of ROB_1'); } catch (e) {
      expect((e as RwsError).code).toBe('PARSE_ERROR');
      expect((e as RwsError).message).toMatch(/rax_4/);
    }
  });

  it('throws PARSE_ERROR on a non-numeric value in either half', () => {
    expect(() => toJointTargetFull({ ...full, rax_2: 'abc' }, 't')).toThrow(/rax_2/);
    expect(() => toJointTargetFull({ ...full, eax_a: '12abc' }, 't')).toThrow(/eax_a/);
  });

  it('throws PARSE_ERROR for an empty state (block absent from the response)', () => {
    expect(() => toJointTargetFull({}, 't')).toThrow(expect.objectContaining({ code: 'PARSE_ERROR' }));
  });
});

// ─── RWS 1.0 XHTML parser ────────────────────────────────────────────────────

describe('parseJointTargetFull (RWS 1.0 XHTML)', () => {
  it('parses robot and external spans, including the 9E9 marker spellings', () => {
    const r = parseJointTargetFull(xhtmlDoc(`<li class="ms-jointtarget" title="ROB_1">${JT_SPANS_WITH_TRACK}</li>`));
    expect(r.rax).toEqual([1.5, -2, 3, 4, 5, 6]);
    expect(r.eax).toEqual([1250.5, 9e9, 9e9, 9e9, 9e9, 8999999488]);
    expect(r.eax.map(isJointValuePresent)).toEqual([true, false, false, false, false, false]);
  });

  it('a response with only rax spans yields all external slots not present', () => {
    const r = parseJointTargetFull(xhtmlDoc(
      '<li class="ms-jointtarget" title="ROB_1"><span class="rax_1">10.00</span><span class="rax_2">-20.50</span>'
      + '<span class="rax_3">30.25</span><span class="rax_4">0.00</span><span class="rax_5">45.75</span>'
      + '<span class="rax_6">-90.00</span></li>'));
    expect(r).toEqual({ rax: [10, -20.5, 30.25, 0, 45.75, -90], eax: [9e9, 9e9, 9e9, 9e9, 9e9, 9e9] });
  });

  it('throws PARSE_ERROR without the ms-jointtarget block or with a robot span missing', () => {
    expect(() => parseJointTargetFull(xhtmlDoc('<li class="ms-robtargets"></li>')))
      .toThrow(expect.objectContaining({ code: 'PARSE_ERROR' }));
    expect(() => parseJointTargetFull(xhtmlDoc(
      '<li class="ms-jointtarget"><span class="rax_1">1</span></li>')))
      .toThrow(/rax_2/);
  });
});

// ─── RWS 2.0 client ──────────────────────────────────────────────────────────

describe('RwsClient2.getJointTargetFull', () => {
  it('reads the live-captured hal+json jointtarget: robot AND external axes, one GET', async () => {
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': HAL_CT }); res.end(HAL_JOINTTARGET);
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await c.getJointTargetFull()).toEqual({
        rax: [10, 15, -10, 20, 30, 45],
        eax: [0, 0, 0, 0, 0, 0],
      });
      expect(requests).toEqual([{ method: 'GET', url: '/rw/motionsystem/mechunits/ROB_1/jointtarget' }]);
    } finally { server.close(); }
  });

  it('addresses the unit asked for and parses the XHTML representation too', async () => {
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': XHTML_CT });
      res.end(xhtmlDoc(`<li class="ms-jointtarget" title="STN_1">${JT_SPANS_WITH_TRACK}</li>`));
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const r = await c.getJointTargetFull('STN_1');
      expect(r.eax).toEqual([1250.5, 9e9, 9e9, 9e9, 9e9, 8999999488]);
      expect(requests[0].url).toBe('/rw/motionsystem/mechunits/STN_1/jointtarget');
    } finally { server.close(); }
  });

  it('throws PARSE_ERROR when the response has no robot axis fields', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': HAL_CT });
      res.end('{ "_links" : { "base" : { "href" : "https://x/" } }, "state" : [ { "_type" : "ms-jointtarget", "_title" : "ROB_1", "eax_a" : "0" } ]}');
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await expect(c.getJointTargetFull()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    } finally { server.close(); }
  });
});

// ─── RWS 1.0 adapter ─────────────────────────────────────────────────────────

describe('RWS1Adapter motion reads', () => {
  it('getJointTargetFull delegates to RwsClient with the unit', async () => {
    const seen: Array<string | undefined> = [];
    const value = { rax: [1, 2, 3, 4, 5, 6], eax: [9e9, 9e9, 9e9, 9e9, 9e9, 9e9] };
    const fake = { getJointTargetFull: async (u?: string) => { seen.push(u); return value; } };
    const a = new RWS1Adapter(fake as unknown as RwsClient);
    expect(await a.getJointTargetFull('ROB_2')).toBe(value);
    await a.getJointTargetFull();
    expect(seen).toEqual(['ROB_2', undefined]);
  });

  it('getMechunitDetails over a real RWS1Adapter normalises the RW 6 JSON spellings (errata E11)', async () => {
    const urls: string[] = [];
    const fake = {
      request: async (_m: string, url: string) => {
        urls.push(url);
        return {
          status: 200,
          body: JSON.stringify({ _links: { base: { href: 'http://x/rw/motionsystem/' } }, _embedded: { _state: [{
            _type: 'ms-mechunit', _title: 'ROB_1',
            type: 'TCPRobot', axes: '6', 'axes-total': '6', mode: 'Activated', status: 'Synchronized',
            task: 'T_ROB1', 'coord-system': 'World', 'tool-name': 'tool0', 'wobj-name': 'wobj0',
            'is-integrated-unitname': 'NoIntegratedUnit', 'has-integrated-unitname': 'NoIntegratedUnit',
          }] } }),
        };
      },
    };
    const mgr = connectedManager(new RWS1Adapter(fake as unknown as RwsClient));
    const d = await mgr.getMechunitDetails('ROB_1');
    expect(urls).toEqual(['/rw/motionsystem/mechunits/ROB_1?json=1']);
    expect(d).toMatchObject({
      name: 'ROB_1', type: 'TCPRobot', axes: 6, axesTotal: 6, task: 'T_ROB1',
      mode: 'Activated', status: 'Synchronized', coordSystem: 'World', tool: 'tool0', wobj: 'wobj0',
      isIntegratedUnit: 'NoIntegratedUnit', hasIntegratedUnit: 'NoIntegratedUnit',
    });
    expect(d.raw['task']).toBe('T_ROB1');
  });
});

// ─── Mechunit description ────────────────────────────────────────────────────

describe('toMechunitDetails', () => {
  // Probe P3 (RW 7.21, 2026-09-23) - the resource as the RWS 2.0 VC sent it.
  const P3 = {
    _type: 'ms-mechunit', _title: 'ROB_1',
    type: 'TCPRobot', axes: '6', 'axes-total': '6', mode: 'Activated', status: 'Synchronized',
    'task-name': 'T_ROB1', 'coord-system': 'World', 'jog-mode': 'AxisGroup1',
    'tool-name': 'tool0', 'wobj-name': 'wobj0', 'payload-name': 'load0',
    'is-integrated-unit': 'NoIntegratedUnit', 'has-integrated-unit': 'NoIntegratedUnit',
  };

  it('normalises the RWS 2.0 resource observed in probe P3', () => {
    expect(toMechunitDetails('ROB_1', P3)).toEqual({
      name: 'ROB_1', type: 'TCPRobot', axes: 6, axesTotal: 6, task: 'T_ROB1',
      mode: 'Activated', status: 'Synchronized', coordSystem: 'World',
      tool: 'tool0', wobj: 'wobj0',
      isIntegratedUnit: 'NoIntegratedUnit', hasIntegratedUnit: 'NoIntegratedUnit',
      raw: P3,
    });
  });

  it('prefers task-name but falls back to the RW 6 JSON "task" spelling', () => {
    expect(toMechunitDetails('X', { task: 'T_ROB2' }).task).toBe('T_ROB2');
    expect(toMechunitDetails('X', { 'task-name': 'T_A', task: 'T_B' }).task).toBe('T_A');
  });

  it('answers null - never a guess - for absent, blank or non-integer fields', () => {
    const d = toMechunitDetails('STN_1', { type: '  ', axes: 'two', 'axes-total': '-1', 'task-name': '' });
    expect(d).toMatchObject({ name: 'STN_1', type: null, axes: null, axesTotal: null, task: null, mode: null });
    expect(toMechunitDetails('STN_1', {}).axes).toBeNull();
    expect(toMechunitDetails('STN_1', null).raw).toEqual({});
  });

  it('keeps only string members in raw (RW 6 JSON can carry objects)', () => {
    const d = toMechunitDetails('ROB_1', { type: 'TCPRobot', _links: { self: 1 } } as unknown as Record<string, string>);
    expect(d.raw).toEqual({ type: 'TCPRobot' });
  });
});

// ─── RobotManager wrappers ───────────────────────────────────────────────────

describe('RobotManager motion reads', () => {
  const managerWith = (adapter: Record<string, unknown> | null): RobotManager =>
    adapter === null ? new RobotManager() : connectedManager(adapter);

  it('getJointTargetFull delegates with the unit, defaulting to ROB_1', async () => {
    const seen: string[] = [];
    const value = { rax: [0, 0, 0, 0, 30, 0], eax: [0, 0, 0, 0, 0, 0] };
    const mgr = managerWith({ getJointTargetFull: async (u: string) => { seen.push(u); return value; } });
    expect(await mgr.getJointTargetFull()).toBe(value);
    await mgr.getJointTargetFull('STN_1');
    expect(seen).toEqual(['ROB_1', 'STN_1']);
  });

  it('getJointTargetFull throws NOT_CONNECTED / UNSUPPORTED_OPERATION instead of inventing a value', async () => {
    await expect(managerWith(null).getJointTargetFull()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(managerWith({}).getJointTargetFull()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('getJointTargetFull passes the read error through untouched', async () => {
    const boom = new RwsError('Resource does not exist', 'RESOURCE_NOT_FOUND', 404);
    const mgr = managerWith({ getJointTargetFull: async () => { throw boom; } });
    await expect(mgr.getJointTargetFull('NOPE')).rejects.toBe(boom);
  });

  it('getMechunitDetails normalises the adapter resource for the unit asked', async () => {
    const seen: string[] = [];
    const mgr = managerWith({
      getMechunitInfo: async (u: string) => { seen.push(u); return { type: 'TCPRobot', axes: '6', 'task-name': 'T_ROB1' }; },
    });
    const d = await mgr.getMechunitDetails();
    expect(seen).toEqual(['ROB_1']);
    expect(d).toMatchObject({ name: 'ROB_1', type: 'TCPRobot', axes: 6, task: 'T_ROB1', axesTotal: null });
  });

  it('getMechunitDetails throws NOT_CONNECTED / UNSUPPORTED_OPERATION', async () => {
    await expect(managerWith(null).getMechunitDetails()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(managerWith({}).getMechunitDetails()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('getCartesianFull delegates with the unit and throws NOT_CONNECTED', async () => {
    const pose = { x: 806.2917, y: 0, z: 1000, q1: 1, q2: 0, q3: 0, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 };
    const seen: string[] = [];
    const mgr = managerWith({ getCartesianFull: async (u: string) => { seen.push(u); return pose; } });
    expect(await mgr.getCartesianFull()).toBe(pose);
    await mgr.getCartesianFull('ROB_2');
    expect(seen).toEqual(['ROB_1', 'ROB_2']);
    await expect(managerWith(null).getCartesianFull()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});

// ─── A description that is not there (both generations) ─────────────────────

describe('RobotManager.getMechunitDetails without the ms-mechunit block', () => {
  // Both adapters answer {} when the block is absent (RWS 2.0 getState(), RWS
  // 1.0 a null state). An all-null description is not a description: a caller
  // that caches it would treat the unit as typeless and axis-less for the whole
  // connection, with no error to show (review finding, 2026-09-25). Structural
  // cell S12's rule applies: a response without its block is PARSE_ERROR.
  const managerWith = (adapter: Record<string, unknown>): RobotManager => connectedManager(adapter);

  it('throws PARSE_ERROR for an empty resource, never an all-null description', async () => {
    await expect(managerWith({ getMechunitInfo: async () => ({}) }).getMechunitDetails())
      .rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('throws PARSE_ERROR when only non-string members arrived (RW 6 JSON `_links` alone)', async () => {
    const adapter = { getMechunitInfo: async () => ({ _links: { self: { href: 'x' } } }) };
    await expect(managerWith(adapter).getMechunitDetails()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('a single present field is a description - the missing ones stay null (field-level rule unchanged)', async () => {
    const d = await managerWith({ getMechunitInfo: async () => ({ type: 'TCPRobot' }) }).getMechunitDetails('ROB_2');
    expect(d).toMatchObject({ name: 'ROB_2', type: 'TCPRobot', axes: null, axesTotal: null, task: null });
  });

  it('RWS 2.0: an XHTML response without the block ends as PARSE_ERROR at the manager', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': XHTML_CT });
      res.end(xhtmlDoc('<li class="something-else" title="ROB_1"><span class="type">TCPRobot</span></li>'));
    });
    try {
      const mgr = connectedManager(new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p'));
      await expect(mgr.getMechunitDetails()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    } finally { server.close(); }
  });

  it('RWS 1.0: a 204 / empty body ends as PARSE_ERROR at the manager', async () => {
    const fake = { request: async () => ({ status: 204, body: '' }) };
    const mgr = connectedManager(new RWS1Adapter(fake as unknown as RwsClient));
    await expect(mgr.getMechunitDetails()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });
});

// ─── Reads during and after a teardown ───────────────────────────────────────

describe('RobotManager motion reads once disconnect() has started', () => {
  // The leak this guards against (review finding, 2026-09-25): a sampler read
  // issued while the manager was being torn down reached the logged-out
  // adapter, which signed in a session that nobody logged out. The adapter
  // object survives disconnectInternal() (only its session ends) and
  // `_state.connected` is reset only as its LAST step, so the refusal has to
  // hold from the teardown's first tick onward - that is what the epoch does.
  function fakeAdapter() {
    let finishDisconnect!: () => void;
    const disconnected = new Promise<void>(r => { finishDisconnect = r; });
    const adapter = {
      disconnect: vi.fn(() => disconnected),
      getJointTargetFull: vi.fn(async () => ({ rax: [0, 0, 0, 0, 0, 0], eax: [0, 0, 0, 0, 0, 0] })),
      getCartesianFull: vi.fn(async () => ({ x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 })),
      getMechunitInfo: vi.fn(async () => ({ type: 'TCPRobot', axes: '6' })),
    };
    return { adapter, finishDisconnect };
  }

  const expectRefused = async (mgr: RobotManager): Promise<void> => {
    await expect(mgr.getJointTargetFull()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(mgr.getCartesianFull()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(mgr.getMechunitDetails()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  };

  it('refuses with NOT_CONNECTED from the first tick of the teardown, while state.connected still reads true', async () => {
    const { adapter, finishDisconnect } = fakeAdapter();
    const mgr = connectedManager(adapter);
    await mgr.getJointTargetFull(); // the session is up: reads go through
    expect(adapter.getJointTargetFull).toHaveBeenCalledTimes(1);

    const teardown = mgr.disconnect();
    // Not even the adapter's /logout has been queued yet, and the state still
    // says connected - the reads must already refuse.
    expect(mgr.state.connected).toBe(true);
    await expectRefused(mgr);

    // While /logout is in flight (the adapter's disconnect has not resolved).
    await vi.waitFor(() => expect(adapter.disconnect).toHaveBeenCalledTimes(1));
    expect(mgr.state.connected).toBe(true);
    await expectRefused(mgr);

    finishDisconnect();
    await teardown;
    expect(mgr.state.connected).toBe(false);
    await expectRefused(mgr);

    // Nothing reached the adapter after the teardown began.
    expect(adapter.getJointTargetFull).toHaveBeenCalledTimes(1);
    expect(adapter.getCartesianFull).not.toHaveBeenCalled();
    expect(adapter.getMechunitInfo).not.toHaveBeenCalled();
  });

  it('a session that comes up under a later connect is served again', async () => {
    const { adapter, finishDisconnect } = fakeAdapter();
    const mgr = connectedManager(adapter);
    const teardown = mgr.disconnect();
    finishDisconnect();
    await teardown;
    await expectRefused(mgr);

    // What doConnect() does once its session is up (see connectedManager).
    const m = mgr as unknown as { _state: { connected: boolean }; sessionEpoch: number | null; connectEpoch: number };
    m._state.connected = true;
    m.sessionEpoch = m.connectEpoch;
    await mgr.getJointTargetFull();
    expect(adapter.getJointTargetFull).toHaveBeenCalledTimes(1);
  });
});
