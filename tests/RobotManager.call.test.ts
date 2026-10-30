import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RobotManager } from '../src/RobotManager.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsClient } from '../src/RwsClient.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsError } from '../src/types.js';
import type { OperationKey } from '../src/operations/index.js';

/**
 * RobotManager.call(key, args) (1.6.0): one operation by its key, through
 * the manager's method where there is one and the adapter's otherwise, with
 * every refusal made before anything is sent.
 */

/** A fake RwsClient for RWS1Adapter: answers each request from `respond` and records it. */
function fakeRws1(respond: (url: string) => { status: number; body: string } = () => ({ status: 200, body: '{}' })) {
  const sent: string[] = [];
  const client = {
    request: async (method: string, url: string) => { sent.push(`${method} ${url}`); return respond(url); },
  } as unknown as RwsClient;
  return { client, sent };
}

/** A real RwsClient whose HTTP session answers `body` and records each path, for the adapter methods that call the client. */
function stubbedRws1(body = ''): { client: RwsClient; sent: string[] } {
  const sent: string[] = [];
  const client = new RwsClient({ host: '127.0.0.1', port: 1, username: 'u', password: 'p' });
  const answer = { status: 200, body, headers: new Headers() };
  (client as unknown as { session: unknown }).session = {
    get: async (path: string) => { sent.push(`GET ${path}`); return answer; },
    post: async (path: string) => { sent.push(`POST ${path}`); return answer; },
  };
  return { client, sent };
}

function connected(adapter: IRWSAdapter): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: IRWSAdapter; _state: { connected: boolean }; sessionEpoch: number | null; connectEpoch: number };
  m.adapter = adapter;
  m._state.connected = true;
  m.sessionEpoch = m.connectEpoch;
  return mgr;
}

/** A local HTTP server for an RWS2Adapter; `respond` returns [status, body]. */
async function withServer(
  respond: (url: string) => [number, string],
  run: (adapter: RWS2Adapter, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const [status, body] = respond(req.url ?? '');
    res.writeHead(status, { 'Content-Type': 'application/hal+json;v=2.0' });
    res.end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p'), seen);
  } finally { server.close(); }
}

/** Call with a key and arguments the types would refuse, as a caller from outside TypeScript could. */
const callAny = (mgr: RobotManager, key: string, args: unknown) =>
  (mgr.call as (k: string, a: unknown) => Promise<unknown>)(key, args);

describe('refused before anything is sent', () => {
  it('a key that is not an operation key: INVALID_ARGUMENT', async () => {
    const { client, sent } = fakeRws1();
    const mgr = connected(new RWS1Adapter(client));
    for (const key of ['rapid.nope', 'ctrl.restartController', '__proto__', '']) {
      await expect(callAny(mgr, key, [])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(sent).toEqual([]);
  });

  it('no session: NOT_CONNECTED', async () => {
    await expect(new RobotManager().call('panel.getSpeedRatio', [])).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('an operation the controller\'s generation does not have: UNSUPPORTED_OPERATION', async () => {
    const { client, sent } = fakeRws1();
    await expect(connected(new RWS1Adapter(client)).call('ctrl.searchDevices', ['x'])).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(sent).toEqual([]);
    await withServer(() => [200, '{}'], async (adapter, seen) => {
      await expect(connected(adapter).call('motion.setRobtargetForJogging', [{} as never])).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      expect(seen).toEqual([]);
    });
  });

  it('access, mastership and subscription rows are not callable; a row no generation has is unsupported', async () => {
    const { client, sent } = fakeRws1();
    const mgr = connected(new RWS1Adapter(client));
    await expect(callAny(mgr, 'systemMastership.requestMastership', ['rapid'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('access') });
    await expect(callAny(mgr, 'systemMastership.releaseMastershipAll', [])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(callAny(mgr, 'filesVision.createSubscription', [[]])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('subscri') });
    await expect(callAny(mgr, 'ctrl.getSyslog', [])).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(sent).toEqual([]);
  });

  it('arguments that are not an array, too few or too many: INVALID_ARGUMENT', async () => {
    const { client, sent } = fakeRws1();
    const mgr = connected(new RWS1Adapter(client));
    await expect(callAny(mgr, 'rapid.getRapidVariable', { task: 'T_ROB1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(callAny(mgr, 'rapid.getRapidVariable', ['T_ROB1'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('task, module, symbol') });
    await expect(callAny(mgr, 'panel.getSpeedRatio', [1])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(sent).toEqual([]);
  });

  it('an adapter without the method: UNSUPPORTED_OPERATION, where the RobotManager method answers an empty value', async () => {
    const adapter = { getRapidExecutionState: vi.fn() } as unknown as IRWSAdapter;
    const mgr = connected(adapter);
    expect(await mgr.getTaskMotion('T_ROB1')).toEqual({});
    await expect(mgr.call('rapid.getTaskMotion', ['T_ROB1'])).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(await mgr.listBackups()).toEqual([]);
    await expect(mgr.call('ctrl.listBackups', [])).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});

describe('the route', () => {
  it('a manager route runs the RobotManager method with the arguments in order and answers its answer', async () => {
    const mgr = connected(new RWS1Adapter(fakeRws1().client));
    const get = vi.spyOn(mgr, 'getRapidVariable').mockResolvedValue('5');
    expect(await mgr.call('rapid.getRapidVariable', ['T_ROB1', 'MainModule', 'nCount'])).toBe('5');
    expect(get).toHaveBeenCalledWith('T_ROB1', 'MainModule', 'nCount');
    const set = vi.spyOn(mgr, 'setRapidVariable').mockResolvedValue(undefined);
    await mgr.call('rapid.setRapidVariable', ['T_ROB1', 'MainModule', 'nCount', '6']);
    expect(set).toHaveBeenCalledWith('T_ROB1', 'MainModule', 'nCount', '6');
  });

  it('an adapter route passes the adapter\'s error on, where RobotManager.getMastershipStatus answers null', async () => {
    const refused = new RwsError('refused', 'CONTROLLER_BUSY', 503);
    const adapter = { getMastershipStatus: vi.fn().mockRejectedValue(refused) } as unknown as IRWSAdapter;
    const mgr = connected(adapter);
    expect(await mgr.getMastershipStatus('rapid')).toBeNull();
    await expect(mgr.call('systemMastership.getMastershipStatus', ['rapid'])).rejects.toBe(refused);
  });

  it('motors on and off go through setMotorsOn and setMotorsOff; any other state is refused', async () => {
    const mgr = connected(new RWS1Adapter(fakeRws1().client));
    const on = vi.spyOn(mgr, 'setMotorsOn').mockResolvedValue(undefined);
    const off = vi.spyOn(mgr, 'setMotorsOff').mockResolvedValue(undefined);
    await mgr.call('panel.setControllerState', ['motoron']);
    await mgr.call('panel.setControllerState', ['motoroff']);
    expect(on).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    await expect(callAny(mgr, 'panel.setControllerState', ['motorup'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(on).toHaveBeenCalledTimes(1);
  });

  it('the module push is RobotManager.loadProgram; the program load row is the adapter\'s loadProgram', async () => {
    const loadProgram = vi.fn().mockResolvedValue(undefined);
    const mgr = connected({ loadProgram } as unknown as IRWSAdapter);
    const push = vi.spyOn(mgr, 'loadProgram').mockResolvedValue(undefined);
    await mgr.call('rapid.pushModule', ['C:/cell/Main.mod', 'T_ROB1']);
    expect(push).toHaveBeenCalledWith('C:/cell/Main.mod', 'T_ROB1');
    await mgr.call('rapid.loadProgram', ['T_ROB1', '$HOME/cell.pgf', 'replace']);
    expect(loadProgram).toHaveBeenCalledWith('T_ROB1', '$HOME/cell.pgf', 'replace');
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('a signal by its bare name, the URL its row names', () => {
  const body = '{"_links":{"base":{"href":"http://127.0.0.1/rw/iosystem/"}},"_embedded":{"resources":[{"_type":"ios-signal-li","_title":"Local/DRV_1/diStart","name":"diStart","type":"DI","lvalue":"1"}]}}';

  it('RWS 2.0: GET /rw/iosystem/signals/{name}', async () => {
    await withServer(() => [200, body], async (adapter, seen) => {
      expect(await connected(adapter).call('io.readSignalByName', ['diStart'])).toEqual({ name: 'diStart', value: '1', type: 'DI', lvalue: '1' });
      expect(seen).toEqual(['GET /rw/iosystem/signals/diStart']);
    });
  });

  it('RWS 2.0: an answer with no signal of that name is PARSE_ERROR', async () => {
    await withServer(() => [200, '{"_embedded":{"resources":[]}}'], async adapter => {
      await expect(connected(adapter).call('io.readSignalByName', ['diStart'])).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    });
  });

  it('RWS 1.0: GET /rw/iosystem/signals/{name}', async () => {
    const rws1Body = '<li class="ios-signal" title="diStart"><span class="name">diStart</span><span class="type">DI</span><span class="lvalue">0</span></li>';
    const { client, sent } = stubbedRws1(rws1Body);
    expect(await connected(new RWS1Adapter(client)).call('io.readSignalByName', ['diStart'])).toMatchObject({ name: 'diStart', lvalue: '0' });
    expect(sent).toEqual(['GET /rw/iosystem/signals/diStart']);
  });
});

describe('RobotWare 8 write access around a write whose method does not take it', () => {
  /** An RWS2Adapter that sends nothing, under a manager whose access manager reads `generation`. */
  function rws2Session(generation: 'rw7' | 'rw8') {
    const adapter = Object.create(RWS2Adapter.prototype) as RWS2Adapter & Record<string, unknown>;
    const calls: string[] = [];
    for (const m of ['writeSignal', 'readDipcMessage', 'stopRapid', 'getSpeedRatio']) {
      adapter[m] = vi.fn(async () => { calls.push(m); return m === 'getSpeedRatio' ? 100 : undefined; });
    }
    const mgr = connected(adapter);
    const withAccess = vi.fn(async (_d: readonly string[], fn: () => Promise<unknown>) => { calls.push('access'); return fn(); });
    (mgr as unknown as { access: () => unknown }).access = () => ({ generation: () => generation, withAccess });
    return { mgr, withAccess, calls };
  }

  it('takes it before the write and runs the write inside', async () => {
    const { mgr, withAccess, calls } = rws2Session('rw8');
    await mgr.call('io.writeSignal', ['Local', 'DRV_1', 'doLamp', '1']);
    expect(withAccess).toHaveBeenCalledTimes(1);
    expect(withAccess.mock.calls[0][0]).toEqual(['rapid']);
    expect(calls).toEqual(['access', 'writeSignal']);
  });

  it('sends nothing when the access is refused', async () => {
    const { mgr, withAccess, calls } = rws2Session('rw8');
    const refused = new RwsError('write access is held by another station', 'MASTERSHIP_REQUIRED', 403);
    withAccess.mockRejectedValueOnce(refused);
    await expect(mgr.call('io.writeSignal', ['Local', 'DRV_1', 'doLamp', '1'])).rejects.toBe(refused);
    expect(calls).toEqual([]);
  });

  it('not around a stop, the DIPC read, a read, or on RobotWare 7', async () => {
    const rw8 = rws2Session('rw8');
    await rw8.mgr.call('rapid.stopRapid', []);
    await rw8.mgr.call('cfgElogDipc.readDipcMessage', ['q1']);
    await rw8.mgr.call('panel.getSpeedRatio', []);
    expect(rw8.withAccess).not.toHaveBeenCalled();
    const rw7 = rws2Session('rw7');
    await rw7.mgr.call('io.writeSignal', ['Local', 'DRV_1', 'doLamp', '1']);
    expect(rw7.withAccess).not.toHaveBeenCalled();
    expect(rw7.calls).toEqual(['writeSignal']);
  });

  it('not on RWS 1.0', async () => {
    const { client, sent } = stubbedRws1();
    const mgr = connected(new RWS1Adapter(client));
    const access = vi.fn();
    (mgr as unknown as { access: () => unknown }).access = access;
    await mgr.call('io.writeSignal', ['Local', 'DRV_1', 'doLamp', '1']);
    expect(access).not.toHaveBeenCalled();
    expect(sent).toEqual(['POST /rw/iosystem/signals/Local/DRV_1/doLamp?action=set']);
  });
});

describe('every routed key', () => {
  it('reaches a function on RobotManager or the adapter of each generation it lists, or refuses as unsupported', async () => {
    const { OPERATIONS, OPERATION_KEYS } = await import('../src/operations/index.js');
    const mgr = new RobotManager() as unknown as Record<string, unknown>;
    for (const key of OPERATION_KEYS as readonly OperationKey[]) {
      const r = OPERATIONS[key].route;
      if (r.via === 'manager') { expect(typeof mgr[r.method], key).toBe('function'); }
      if (r.via === 'manager-by-arg') { for (const m of Object.values(r.methods)) { expect(typeof mgr[m], key).toBe('function'); } }
      if (r.via === 'adapter') {
        const on = OPERATIONS[key].generations.map(g => (g === 'rws2' ? RWS2Adapter.prototype : RWS1Adapter.prototype) as unknown as Record<string, unknown>);
        expect(on.some(p => typeof p[r.method] === 'function'), key).toBe(true);
      }
    }
  });
});

describe('the review of 1.6.0', () => {
  /** A manager on an RWS2Adapter that sends nothing, whose access manager reports RobotWare 8. */
  function rw8(methods: string[]) {
    const adapter = Object.create(RWS2Adapter.prototype) as RWS2Adapter & Record<string, unknown>;
    const calls: string[] = [];
    for (const m of methods) { adapter[m] = vi.fn(async () => { calls.push(m); }); }
    const mgr = connected(adapter);
    const withAccess = vi.fn(async (_d: readonly string[], fn: () => Promise<unknown>) => { calls.push('access'); return fn(); });
    (mgr as unknown as { access: () => unknown }).access = () => ({ generation: () => 'rw8', withAccess });
    return { mgr, withAccess, calls };
  }

  it('the simulated stops and the enabling device are sent at once on RobotWare 8, as their methods send them', async () => {
    const { mgr, withAccess, calls } = rw8(['simEmergencyStop', 'simGeneralStop', 'simAutoStop', 'simEnableSwitch', 'setExternalEmergencyStop']);
    await mgr.call('panel.simEmergencyStop', []);
    await mgr.call('panel.simGeneralStop', [true]);
    await mgr.call('panel.simAutoStop', [true]);
    await mgr.call('panel.simEnableSwitch', [false]);
    await mgr.call('panel.setExternalEmergencyStop', ['off']);
    expect(withAccess).not.toHaveBeenCalled();
    expect(calls).toEqual(['simEmergencyStop', 'simGeneralStop', 'simAutoStop', 'simEnableSwitch', 'setExternalEmergencyStop']);
  });

  it('the operating-mode confirmation is not callable: it is the person\'s, at the FlexPendant', async () => {
    await withServer(() => [204, ''], async (adapter, seen) => {
      await expect(callAny(connected(adapter), 'panel.acknowledgeOperationMode', ['auto'])).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT', message: expect.stringContaining('FlexPendant'),
      });
      expect(seen).toEqual([]);
    });
  });

  it('a motors state that names an inherited property is INVALID_ARGUMENT, not a TypeError', async () => {
    const mgr = connected(new RWS1Adapter(fakeRws1().client));
    for (const state of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      await expect(callAny(mgr, 'panel.setControllerState', [state])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });

  it('the module push and the controller job reach RobotManager on an adapter with neither loadProgram nor startJob', async () => {
    const adapter = { compressPath: vi.fn(async () => undefined) } as unknown as IRWSAdapter;
    const mgr = connected(adapter);
    const push = vi.spyOn(mgr, 'loadProgram').mockResolvedValue(undefined);
    await mgr.call('rapid.pushModule', ['C:/cell/Main.mod', 'T_ROB1']);
    expect(push).toHaveBeenCalledTimes(1);
    await mgr.call('ctrl.startJob', ['compressPath', '$HOME/a', '$HOME/a.zip']);
    expect((adapter as unknown as { compressPath: ReturnType<typeof vi.fn> }).compressPath).toHaveBeenCalledWith('$HOME/a', '$HOME/a.zip');
  });
});
