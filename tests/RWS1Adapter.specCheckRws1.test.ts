import { describe, it, expect } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsClient as RwsClient1 } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';
import { ALL_TABLES } from '../src/paths/index.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';

/**
 * Client defects from the RWS 1.0 spec check of 2026-10-09: each `rws1` row
 * compared with the form RW 6.16.03 serves on `?action=show`, ABB's RWS 1.0 manual
 * (3HAC050973-001 Rev M) and a live call on the RW 6.16.03 VC. The response
 * bodies below are the ones that VC answered that day.
 */

interface Call { what: string; body?: string }

function makeFake(
  respond?: (method: string, url: string, body?: string) => { status: number; body: string } | undefined,
  extra: Record<string, unknown> = {},
): { calls: Call[]; client: RwsClient } {
  const calls: Call[] = [];
  const fake = {
    requestMastership: async (d: string) => { calls.push({ what: `mastership-request ${d}` }); },
    releaseMastership: async (d: string) => { calls.push({ what: `mastership-release ${d}` }); },
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return respond?.(method, url, body) ?? { status: 204, body: '' };
    },
    ...extra,
  };
  return { calls, client: fake as unknown as RwsClient };
}

const wire = (calls: Call[]): Call[] => calls.filter(c => !c.what.startsWith('mastership-'));

/** RW 6.16.03, 2026-10-09: `GET /rw/rapid/tasks/T_ROB1?resource=task-struc-change-count&json=1`. */
const STRUC_CHANGE_COUNT_RW6 = '{"_links":{"base": { "href": "http://127.0.0.1:41937/rw/rapid/" }},"_embedded" :{ "_state":[ {"_links":{"self": {"href":"tasks/T_ROB1&resource=task-struc-change-count&json=1"}}, "_type":"rap-task-struc-change-count", "_title":"task-struc-change-count", "change-count":"189", "struc-change-count":"466444" } ] }}';

describe('setNonMotionExecution', () => {
  it('posts ?action=set-mode, the action the form and Rev M name (not ?action=set)', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).setNonMotionExecution(true);
    expect(wire(calls)).toEqual([{ what: 'POST /rw/motionsystem/nonmotionexecution?action=set-mode&json=1', body: 'mode=ON' }]);
    expect(ALL_TABLES.motion.setNonMotionExecution.rws1).toMatchObject({ action: 'set-mode', fields: ['mode'] });
  });
});

describe('setRobtargetForJogging', () => {
  it('holds motion mastership around the position-target post (403 without it on RW 6.16.03)', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).setRobtargetForJogging({ x: 806.29, y: 0, z: 929, q1: 0.5, q2: 0, q3: 0.866, q4: 0, cf1: 0, cf4: 0, cf6: 0, cfx: 0 });
    expect(calls.map(c => c.what)).toEqual([
      'mastership-request motion',
      'POST /rw/motionsystem?action=positiontarget&json=1',
      'mastership-release motion',
    ]);
  });
});

describe('checkRestore', () => {
  it('is a GET with the backup as a query parameter, as Rev M documents (POST answers 400)', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: '{"_embedded":{"_state":[{"_type":"ctrl-checkrestore","_title":"checkrestore","status":"Accepted"}]}}' }));
    await new RWS1Adapter(client).checkRestore('mybak');
    expect(wire(calls)).toEqual([{ what: 'GET /ctrl/backup?action=check-restore&backup=%2Ffileservice%2F%24BACKUP%2Fmybak&json=1', body: undefined }]);
    expect(ALL_TABLES.ctrl.checkRestore.rws1?.method).toBe('GET');
  });

  it('a status other than Accepted is a refusal, not a pass', async () => {
    const { client } = makeFake(() => ({ status: 200, body: '{"_embedded":{"_state":[{"_type":"ctrl-checkrestore","status":"Rejected"}]}}' }));
    await expect(new RWS1Adapter(client).checkRestore('mybak')).rejects.toBeInstanceOf(RwsError);
  });
});

describe('restoreBackup', () => {
  it('keeps the backup by default: Rev M defaults delete-dir to true, which deleted it on RW 6.16.03', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).restoreBackup('mybak');
    const post = wire(calls).find(c => c.what.startsWith('POST /ctrl/backup?action=restore'));
    expect(post?.body).toBe('backup=%2Ffileservice%2F%24BACKUP%2Fmybak&delete-dir=false');
  });

  it('deletes it only when the caller asks', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).restoreBackup('mybak', { deleteBackup: true });
    const post = wire(calls).find(c => c.what.startsWith('POST /ctrl/backup?action=restore'));
    expect(post?.body).toBe('backup=%2Ffileservice%2F%24BACKUP%2Fmybak&delete-dir=true');
  });
});

describe('getTaskStructuralChangeCount', () => {
  it('reads ?resource=task-struc-change-count on the task (the sub-path answers 404) and returns its count', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: STRUC_CHANGE_COUNT_RW6 }));
    await expect(new RWS1Adapter(client).getTaskStructuralChangeCount('T_ROB1')).resolves.toBe(466444);
    expect(wire(calls)).toEqual([{ what: 'GET /rw/rapid/tasks/T_ROB1?resource=task-struc-change-count&json=1', body: undefined }]);
  });
});

describe('getTaskActivationRecord', () => {
  it('reads ?resource=activation-record&stackframe=1 on the task (the sub-path answers 404)', async () => {
    // ABB's entry class is rap-stackframe (Rev M "Get Activation Record").
    const { calls, client } = makeFake(() => ({ status: 200, body: '{"_embedded":{"_state":[{"_type":"rap-stackframe","_title":"stackframe","routine-url":"RAPID/T_ROB1/MainModule/main"}]}}' }));
    await expect(new RWS1Adapter(client).getTaskActivationRecord('T_ROB1')).resolves.toMatchObject({ 'routine-url': 'RAPID/T_ROB1/MainModule/main' });
    expect(wire(calls)).toEqual([{ what: 'GET /rw/rapid/tasks/T_ROB1?resource=activation-record&stackframe=1&json=1', body: undefined }]);
  });
});

describe('virtual-time state', () => {
  it('the deprecated setVirtualTimeRunning sends nothing and throws UNSUPPORTED_OPERATION (RWS1Adapter and RobotManager)', async () => {
    const { calls, client } = makeFake(() => ({ status: 204, body: '' }));
    const adapter = new RWS1Adapter(client);
    for (const running of [true, false]) {
      await expect(adapter.setVirtualTimeRunning(running)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    }
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = adapter;
    const err = await mgr.setVirtualTimeRunning(false).catch((e: unknown) => e as RwsError);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(String((err as Error).message)).toMatch(/RobotStudio's Simulation tab/);
    await expect(new RobotManager().setVirtualTimeRunning(true)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(calls).toEqual([]);
  });

  it('has no write row: there is no pause or resume over RWS; use RobotStudio\'s Simulation tab', () => {
    expect((ALL_TABLES.ctrl as Record<string, unknown>).setVirtualTimeRunning).toBeUndefined();
    const vtstateWrites = Object.values(ALL_TABLES.ctrl).flatMap(op => [op.rws1, op.rws2])
      .filter(s => s !== undefined && s.method !== 'GET' && s.path === '/ctrl/virtualtime/vtstate');
    expect(vtstateWrites).toEqual([]);
    expect(ALL_TABLES.ctrl.getVirtualTimeState.rws1).toMatchObject({ method: 'GET', path: '/ctrl/virtualtime/vtstate' });
  });
});

describe('setVirtualTimeScale', () => {
  it('is not sent in this release (the client sends no virtual-time write to RobotWare 6); the row keeps the Rev M form as a recorded gap', async () => {
    const { calls, client } = makeFake();
    await expect(new RWS1Adapter(client).setVirtualTimeScale(2)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(wire(calls)).toEqual([]);
    expect(ALL_TABLES.ctrl.setVirtualTimeScale.rws1).toMatchObject({ method: 'POST', path: '/ctrl/virtualtime/vtspeed', fields: ['vtspeed'] });
    expect(ALL_TABLES.ctrl.setVirtualTimeScale.rws1?.gap).toBeDefined();
  });
});

describe('setOperationMode on RWS 1.0', () => {
  it('is refused before anything is sent: RWS 1.0 has no operating-mode change', async () => {
    const posts: string[] = [];
    const client = new RwsClient1('http://127.0.0.1:1', 'Default User', 'robotics');
    (client as unknown as { session: { post: (p: string) => Promise<unknown> } }).session = { post: async (p: string) => { posts.push(p); return { status: 204, body: '' }; } };
    const err = await client.setOperationMode('MANR').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(String((err as Error).message)).toMatch(/key switch|mode selector/i);
    expect(posts).toEqual([]);
  });
});

describe('loadProgram', () => {
  it('sends loadmode, which the form and Rev M take (it was accepted and dropped)', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).loadProgram('T_ROB1', '$HOME/p/prog.pgf', 'add');
    expect(wire(calls)).toEqual([{ what: 'POST /rw/rapid/tasks/T_ROB1/program?action=loadprog&json=1', body: 'progpath=%24HOME%2Fp%2Fprog.pgf&loadmode=add' }]);
    expect(ALL_TABLES.rapid.loadProgram.rws1?.fields).toEqual(['progpath', 'loadmode']);
  });

  it('defaults to replace, as before', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).loadProgram('T_ROB1', '$HOME/prog.pgf');
    expect(wire(calls)[0].body).toBe('progpath=%24HOME%2Fprog.pgf&loadmode=replace');
  });
});

describe('getFileMetadata', () => {
  it('reads the parent listing directly: ?action=metadata is in no Rev M page and is always refused', async () => {
    const { calls, client } = makeFake(undefined, {
      listDirectory: async (dir: string) => { calls.push({ what: `list ${dir}` }); return [{ name: 'user.sys', type: 'file', size: 458, modified: '2026-10-09 T 19:40:00' }]; },
    });
    const meta = await new RWS1Adapter(client).getFileMetadata('$HOME/user.sys');
    expect(meta).toMatchObject({ size: 458 });
    expect(calls.map(c => c.what)).toEqual(['list $HOME']);
  });
});

describe('acknowledgeOperationMode gap row', () => {
  it('records the opmode field the form and Rev M take', () => {
    expect(ALL_TABLES.panel.acknowledgeOperationMode.rws1?.fields).toEqual(['opmode']);
  });
});

describe('listSafetyZones / runCyclicBrakeCheck rows', () => {
  it('say there is no ABB resource behind them and that they stay until the next major version', () => {
    for (const op of ['listSafetyZones', 'runCyclicBrakeCheck']) {
      expect(ALL_TABLES.ctrl[op].note, op).toMatch(/no ABB resource; (deprecated, )?kept until the next major version/);
    }
  });
});

describe('RWS 1.0 sends nothing to paths ABB does not document', () => {
  it('the rows record the RWS 1.0 side as a gap, like the RWS 2.0 side', () => {
    for (const op of [ALL_TABLES.ctrl.listSafetyZones, ALL_TABLES.ctrl.runCyclicBrakeCheck, ALL_TABLES.filesVision.triggerVisionJob]) {
      expect(op.rws1?.gap, op.summary).toMatch(/no ABB (?:document|operation)/);
      expect(op.rws1?.gap, op.summary).toMatch(/nothing is sent/);
      expect(op.rws2?.gap, op.summary).toMatch(/no ABB (?:document|operation)/);
      expect(op.evidence).toBe('built');
    }
  });

  it('listSafetyZones answers [] without a request', async () => {
    const { calls, client } = makeFake();
    await expect(new RWS1Adapter(client).listSafetyZones()).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('runCyclicBrakeCheck throws UNSUPPORTED_OPERATION without a request', async () => {
    const { calls, client } = makeFake();
    const err = await new RWS1Adapter(client).runCyclicBrakeCheck().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect((err as RwsError).message).toMatch(/started from RAPID or the FlexPendant/);
    expect(calls).toEqual([]);
  });

  it('triggerVisionJob throws UNSUPPORTED_OPERATION without a request, naming the job asked for', async () => {
    const { calls, client } = makeFake();
    const err = await new RWS1Adapter(client).triggerVisionJob('cam1', 'Inspect.job').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect((err as RwsError).message).toMatch(/no operation to trigger a vision job \(asked for 'Inspect\.job' on 'cam1'\)/);
    expect(calls).toEqual([]);
  });

  it('through RobotManager the same: nothing is sent, and the vision refusal no longer speaks of an active job', async () => {
    const { calls, client } = makeFake();
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: IRWSAdapter }).adapter = new RWS1Adapter(client);
    await expect(mgr.listSafetyZones()).resolves.toEqual([]);
    await expect(mgr.runCyclicBrakeCheck()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    const vision = await mgr.triggerVisionJob('cam1', 'Inspect.job').catch((e: unknown) => e as RwsError);
    expect(vision).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect((vision as RwsError).message).not.toMatch(/active job/);
    expect(calls).toEqual([]);
  });
});

describe('getVisionSystemInfo on RWS 1.0', () => {
  it('reads /rw/vision?resource=camera-info&name=<camera>, as Rev M documents (the /rw/vision/{name} path is not routed)', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: '{"_embedded":{"_state":[{"_type":"vision-camera-info","name":"cam 1"}]}}' }));
    await expect(new RWS1Adapter(client).getVisionSystemInfo('cam 1')).resolves.toMatchObject({ name: 'cam 1' });
    expect(wire(calls)).toEqual([{ what: 'GET /rw/vision?resource=camera-info&name=cam%201&json=1', body: undefined }]);
  });
});

describe('RobotManager.setOperationMode on RWS 1.0', () => {
  it('is refused before any request, mastership included: RWS 1.0 has no operating-mode change', async () => {
    const refuse = (m: 'AUTO' | 'MANR' | 'MANF'): Promise<void> => RwsClient1.prototype.setOperationMode.call({}, m);
    for (const [from, to] of [['MANR', 'AUTO'], ['AUTO', 'MANR'], ['AUTO', 'MANF']] as const) {
      const { calls, client } = makeFake(undefined, { setOperationMode: refuse });
      const mgr = new RobotManager();
      (mgr as unknown as { adapter: IRWSAdapter }).adapter = new RWS1Adapter(client);
      (mgr as unknown as { _state: { opmode: string } })._state.opmode = from;
      const err = await mgr.setOperationMode(to).catch((e: unknown) => e);
      expect(err, `${from} -> ${to}`).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      expect(calls, `${from} -> ${to}`).toEqual([]);
    }
  });
});

describe('setPPToCursor on RWS 1.0', () => {
  const TEXT = ['MODULE ZZ_PROBE_MOD', '  VAR num zzN := 0;', '  PROC zzMain()', '    zzN := zzN + 1;', '    zzN := zzN + 1;', '  ENDPROC', '  LOCAL FUNC num zzF()', '    RETURN 1;', '  ENDFUNC', 'ENDMODULE', ''].join('\r\n');
  const moduleText = (_m: string, url: string): { status: number; body: string } | undefined => (url.includes('resource=module-text')
    ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'rap-module-text', 'module-text': encodeURIComponent(TEXT), 'change-count': '1' }] } }) }
    : undefined);

  it('posts the Rev M action set-pp-cursor with module, line, column and the routine given (204 on RW 6.16.03; the form spelling set-pp-curser is always refused)', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).setPPToCursor('T_ROB1', 'ZZ_PROBE_MOD', 5, 5, 'zzMain');
    expect(calls).toEqual([
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/tasks/T_ROB1/pcp?action=set-pp-cursor&json=1', body: 'module=ZZ_PROBE_MOD&line=5&column=5&routine=zzMain' },
      { what: 'mastership-release rapid' },
    ]);
    expect(ALL_TABLES.rapid.setPPToCursor.rws1).toMatchObject({ action: 'set-pp-cursor', fields: ['module', 'line', 'column', 'routine'] });
  });

  it('without a routine, reads the module text and sends the routine that encloses the row (the controller answers "Routine name is missing." without one)', async () => {
    const { calls, client } = makeFake(moduleText);
    const a = new RWS1Adapter(client);
    await a.setPPToCursor('T_ROB1', 'ZZ_PROBE_MOD', 5, 5);
    await a.setPPToCursor('T_ROB1', 'ZZ_PROBE_MOD', 8, 5);
    expect(wire(calls).filter(c => c.what.startsWith('POST')).map(c => c.body)).toEqual([
      'module=ZZ_PROBE_MOD&line=5&column=5&routine=zzMain',
      'module=ZZ_PROBE_MOD&line=8&column=5&routine=zzF',
    ]);
  });

  it('refuses a row outside every routine before moving anything', async () => {
    const { calls, client } = makeFake(moduleText);
    await expect(new RWS1Adapter(client).setPPToCursor('T_ROB1', 'ZZ_PROBE_MOD', 2, 3)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls.filter(c => c.what.startsWith('POST'))).toEqual([]);
  });
});
