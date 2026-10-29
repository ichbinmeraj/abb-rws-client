import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RobotManager } from '../src/RobotManager.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';
import { classifyControllerError } from '../src/ControllerError.js';

/**
 * No hidden side effects:
 * - startRapid never moves the program pointer (it used to move it back to
 *   the last setPPToRoutine target whenever the program was stopped);
 * - setPPToRoutine, unloadModule and loadProgram never stop a running program
 *   unasked (they used to send a stop and ignore its failure): they read the
 *   execution state, refuse while the program runs, and stop it only with
 *   `stopIfRunning: true`;
 * - every step of loadProgram that fails fails the call, with what was
 *   already done in the message;
 * - RWS 2.0 activateAllRapidTasks / deactivateAllRapidTasks report every task
 *   the controller refused.
 *
 * The RWS 2.0 adapters are real ones whose transport is replaced by a
 * recorder (no network), with the generation set the way connect() sets it.
 * The controller refusals are built from the error bodies captured live in
 * tests/fixtures/errors, classified the way the adapters classify them.
 */

type Gen = 'rw7' | 'rw8';
type Fail = (method: string, at: string, body?: Record<string, string>) => unknown;

function fromFixture(name: string, method: string, at: string): RwsError {
  const file = path.join(__dirname, 'fixtures', 'errors', `${name}.json`);
  const f = JSON.parse(fs.readFileSync(file, 'utf8')) as { response: { status: number; body: string } };
  const info = classifyControllerError({ httpStatus: f.response.status, body: f.response.body, method, path: at, fallback: 'UNKNOWN' });
  return new RwsError(info.message, info.code, f.response.status, info.controllerMsg ?? undefined,
    info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
}

/**
 * A real RWS 2.0 adapter whose requests are recorded as `METHOD path` (plus
 * the task of a task activation). `fail` may return an error for a request,
 * which is then thrown as the controller's answer. The execution state and
 * the module list are set by the test.
 */
function rws2(generation: Gen, opts: { exec?: () => 'running' | 'stopped'; modules?: string[]; fail?: Fail } = {}) {
  const wire: string[] = [];
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  a.req = async (method: string, at: string, body?: Record<string, string>) => {
    wire.push(`${method} ${at}${body?.task ? ` ${body.task}` : ''}`);
    const e = opts.fail?.(method, at, body);
    if (e) { throw e; }
    return '';
  };
  a.getRapidExecutionState = async () => { wire.push('READ execstate'); return opts.exec?.() ?? 'stopped'; };
  a.listModules = async () => { wire.push('READ modules'); return opts.modules ?? []; };
  return { adapter, wire };
}

function manager(adapter: unknown): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
  m.adapter = adapter;
  m._state.opmode = 'AUTO';
  m._state.ctrlstate = 'motoron';
  return mgr;
}

/**
 * RWS 2.0's "Current execution state does not allow this operation" (403
 * -1073442809 SYS_CTRL_E_EXEC_STATE, the text RW 7.21 sends). No RWS 2.0 body
 * of it is in the fixtures, so this one is written in the captured shape.
 */
function execState(method: string, at: string): RwsError {
  const body = '{"_links":{"base":{"href":"https://127.0.0.1:5466/"}},"status":{"code":-1073442809,'
    + '"msg":"rws_resource_rapid_execution.cpp[1] Current execution state does not allow this operation code:-1073442809"}}';
  const info = classifyControllerError({ httpStatus: 403, body, method, path: at, fallback: 'UNKNOWN' });
  return new RwsError(info.message, info.code, 403, info.controllerMsg ?? undefined,
    info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
}

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  const e = await p.then(() => { throw new Error('expected the call to fail'); }, (err: unknown) => err);
  expect(e).toBeInstanceOf(RwsError);
  return e as RwsError;
}

const EDIT_REQ = 'POST /rw/mastership/edit/request';
const EDIT_REL = 'POST /rw/mastership/edit/release';
const REGISTER = 'POST /rw/controlstation/register/remote';
/** RobotWare 8: the motion-control allowance is read once right after each registration. */
const READ_MC = 'GET /rw/controlstation/allowmotioncontrol';
const WA_REQ = 'POST /rw/controlstation/writeaccess/request';
const WA_REL = 'POST /rw/controlstation/writeaccess/release';
const STOP = 'POST /rw/rapid/execution/stop';
const START = 'POST /rw/rapid/execution/start';
const PP_ROUTINE = 'POST /rw/rapid/tasks/T_ROB1/pcp/routine';
const UNLOAD = 'POST /rw/rapid/tasks/T_ROB1/unloadmod';
const LOADMOD = 'POST /rw/rapid/tasks/T_ROB1/loadmod';
const UPLOAD = 'PUT /fileservice/HOME/ZZ_SIDE.mod';
const RESETPP = 'POST /rw/rapid/execution/resetpp';

describe('startRapid never moves the program pointer', () => {
  it('after setPPToRoutine, a later start from stopped sends only the start', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.setPPToRoutine('T_ROB1', 'M1', 'r1');
    (mgr as unknown as { _state: Record<string, unknown> })._state.execstate = 'stopped';
    wire.length = 0;
    await mgr.startRapid();
    await mgr.startRapid();
    // Up to 1.3.x each start from stopped first re-sent the last PP-to-routine.
    expect(wire).toEqual([EDIT_REQ, START, EDIT_REL, EDIT_REQ, START, EDIT_REL]);
  });
});

describe('setPPToRoutine does not stop a running program unasked', () => {
  it('running, no option: the pointer move is sent, nothing is stopped; the controller decides', async () => {
    const { adapter, wire } = rws2('rw7', { exec: () => 'running' });
    await manager(adapter).setPPToRoutine('T_ROB1', 'M1', 'r1');
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', PP_ROUTINE, EDIT_REL]);
    expect(wire).not.toContain(STOP);
  });

  it('running, no option, refused by the controller: explained as the running program, with the controller code', async () => {
    const { adapter, wire } = rws2('rw7', { exec: () => 'running', fail: (m, at) => (at.endsWith('/pcp/routine') ? execState(m, at) : undefined) });
    const e = await rejection(manager(adapter).setPPToRoutine('T_ROB1', 'M1', 'r1'));
    expect(e.code).toBe('WRONG_MODE');
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', condition: 'controller-state', generation: 'rw7', missing: 'a stopped RAPID program' });
    expect(e.message).toMatch(/^setPPToRoutine: the controller refused it while the RAPID program was running, and setPPToRoutine does not stop it unless asked to. /);
    expect(e.message).toContain('{ stopIfRunning: true }');
    expect(e.controllerCode).toBe(-1073442809);
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', PP_ROUTINE, EDIT_REL]);
  });

  it('running, stopIfRunning: stops first, then moves the pointer, under one hold', async () => {
    const { adapter, wire } = rws2('rw7', { exec: () => 'running' });
    await manager(adapter).setPPToRoutine('T_ROB1', 'M1', 'r1', { stopIfRunning: true });
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', STOP, PP_ROUTINE, EDIT_REL]);
  });

  it('stopped: no stop is sent, with or without the option', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.setPPToRoutine('T_ROB1', 'M1', 'r1');
    await mgr.setPPToRoutine('T_ROB1', 'M1', 'r1', { stopIfRunning: true });
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', PP_ROUTINE, EDIT_REL, EDIT_REQ, 'READ execstate', PP_ROUTINE, EDIT_REL]);
  });

  it('a failed stop fails the call, and the pointer is not moved', async () => {
    const refusedStop = fromFixture('rws2/403-uas-not-allowed-haljson', 'POST', '/rw/rapid/execution/stop');
    const { adapter, wire } = rws2('rw7', { exec: () => 'running', fail: (_m, at) => (at === '/rw/rapid/execution/stop' ? refusedStop : undefined) });
    const e = await rejection(manager(adapter).setPPToRoutine('T_ROB1', 'M1', 'r1', { stopIfRunning: true }));
    expect(e.controllerCode).toBe(refusedStop.controllerCode);
    expect(e.code).toBe('GRANT_DENIED');
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', STOP, EDIT_REL]);
  });

  it('RobotWare 8: the move is sent under write access; a controller refusal is the same explanation, and the write access is released', async () => {
    const { adapter, wire } = rws2('rw8', { exec: () => 'running', fail: (m, at) => (at.endsWith('/pcp/routine') ? execState(m, at) : undefined) });
    const e = await rejection(manager(adapter).setPPToRoutine('T_ROB1', 'M1', 'r1'));
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', generation: 'rw8' });
    expect(wire).toEqual([REGISTER, READ_MC, WA_REQ, 'READ execstate', PP_ROUTINE, WA_REL]);
  });
});

describe('setPPToServiceRoutine: a listed routine, checked before anything is sent; RobotWare 8 in Auto held back', () => {
  const LISTING = [
    { name: 'SkipTaskExec', url: 'RAPID/T_ROB1/BASEFUN/SkipTaskExec' },
    { name: 'BatteryShutdown', url: 'RAPID/BatteryShutdown' },
  ];
  function withMode(generation: Gen, mode: string) {
    const r = rws2(generation);
    const a = r.adapter as unknown as Record<string, unknown>;
    a.getOperationMode = async () => { r.wire.push('READ opmode'); return mode; };
    a.listServiceRoutines = async () => { r.wire.push('READ serviceroutines'); return LISTING; };
    return r;
  }

  it('RobotWare 8 in AUTO: held back before sending (no run has shown it works there), and nothing is sent after the mode read', async () => {
    const { adapter, wire } = withMode('rw8', 'AUTO');
    const e = await rejection(manager(adapter).setPPToServiceRoutine('T_ROB1', 'SkipTaskExec', 'BASEFUN'));
    expect(e.code).toBe('WRONG_MODE');
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', condition: 'operating-mode', generation: 'rw8', grantor: 'key-switch' });
    expect(e.message).toMatch(/^setPPToServiceRoutine: not sent on RobotWare 8 in Auto. /);
    expect(e.message).toMatch(/The program pointer was not moved\.$/);
    expect(e.refusal!.sentence).toBe(e.message);
    // No listing, no write access, no pointer move.
    expect(wire).toEqual(['READ opmode']);
  });

  it('MANR, listed routine: the existing setPPToRoutine sequence, module taken from the listing', async () => {
    const { adapter, wire } = withMode('rw8', 'MANR');
    await manager(adapter).setPPToServiceRoutine('T_ROB1', 'SkipTaskExec');
    expect(wire).toEqual(['READ opmode', 'READ serviceroutines', REGISTER, READ_MC, WA_REQ, 'READ execstate', PP_ROUTINE, WA_REL]);
  });

  it('MANF on RobotWare 7, listed routine and module given: the pointer POST under the edit hold', async () => {
    const { adapter, wire } = withMode('rw7', 'MANF');
    await manager(adapter).setPPToServiceRoutine('T_ROB1', 'SkipTaskExec', 'BASEFUN');
    expect(wire).toEqual(['READ opmode', 'READ serviceroutines', EDIT_REQ, 'READ execstate', PP_ROUTINE, EDIT_REL]);
  });

  it('MANR, routine not listed: INVALID_ARGUMENT and no pointer POST', async () => {
    const { adapter, wire } = withMode('rw8', 'MANR');
    const e = await rejection(manager(adapter).setPPToServiceRoutine('T_ROB1', 'main'));
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(e.message).toContain('main is not in the service-routine listing of task T_ROB1');
    expect(wire).toEqual(['READ opmode', 'READ serviceroutines']);
  });

  it('MANR, listed routine but another module given: INVALID_ARGUMENT and no pointer POST', async () => {
    const { adapter, wire } = withMode('rw7', 'MANR');
    const e = await rejection(manager(adapter).setPPToServiceRoutine('T_ROB1', 'SkipTaskExec', 'OTHERMOD'));
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(wire).toEqual(['READ opmode', 'READ serviceroutines']);
  });
});

describe('unloadModule does not stop a running program unasked', () => {
  it('running, no option: the unload is sent, nothing is stopped; a controller refusal is explained as the running program', async () => {
    const ok = rws2('rw7', { exec: () => 'running' });
    await manager(ok.adapter).unloadModule('T_ROB1', 'M1');
    expect(ok.wire).toContain(UNLOAD);
    expect(ok.wire).not.toContain(STOP);
    const { adapter } = rws2('rw7', { exec: () => 'running', fail: (m, at) => (at.endsWith('/unloadmod') ? execState(m, at) : undefined) });
    const e = await rejection(manager(adapter).unloadModule('T_ROB1', 'M1'));
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', condition: 'controller-state' });
    expect(e.message).toMatch(/^unloadModule: the controller refused it while the RAPID program was running/);
    expect(e.message).toMatch(/No module was unloaded./);
  });

  it('running, stopIfRunning: stop, unload, list again', async () => {
    const { adapter, wire } = rws2('rw7', { exec: () => 'running' });
    await manager(adapter).unloadModule('T_ROB1', 'M1', { stopIfRunning: true });
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', STOP, UNLOAD, 'READ modules', EDIT_REL]);
  });

  it('stopped: no stop is sent', async () => {
    const { adapter, wire } = rws2('rw7');
    await manager(adapter).unloadModule('T_ROB1', 'M1');
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', UNLOAD, 'READ modules', EDIT_REL]);
  });

  it('RobotWare 6: sent while running under RAPID mastership, nothing stopped; a controller refusal is explained as the running program', async () => {
    const calls: string[] = [];
    const fake = {
      requestMastership: async (d: string) => { calls.push(`request ${d}`); },
      releaseMastership: async (d: string) => { calls.push(`release ${d}`); },
      getRapidExecutionState: async () => { calls.push('READ execstate'); return 'running'; },
      stopRapid: async () => { calls.push('stop'); },
      unloadModule: async () => { calls.push('unload'); throw new RwsError('Refused', 'UNKNOWN', 403, undefined, -1073442809, 'Current execution state does not allow this operation'); },
    };
    const e = await rejection(manager(new RWS1Adapter(fake as unknown as RwsClient)).unloadModule('T_ROB1', 'M1'));
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', generation: 'rw6' });
    expect(calls).toEqual(['request rapid', 'READ execstate', 'unload', 'release rapid']);
  });
});

describe('loadProgram: no silent stop, and every failed step is reported', () => {
  let dir: string;
  let withMain: string;
  let noMain: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rws-sideeffects-'));
    withMain = path.join(dir, 'ZZ_SIDE.mod');
    fs.writeFileSync(withMain, 'MODULE ZZ_SIDE\n  PROC main()\n    WaitTime 1;\n  ENDPROC\nENDMODULE\n');
    noMain = path.join(dir, 'sub', 'ZZ_SIDE.mod');
    fs.mkdirSync(path.dirname(noMain));
    fs.writeFileSync(noMain, 'MODULE ZZ_SIDE\n  PROC helper()\n  ENDPROC\nENDMODULE\n');
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('stopped, same-name module loaded: unload, upload, load, list, PP to main - and no stop', async () => {
    const { adapter, wire } = rws2('rw7', { modules: ['ZZ_SIDE'] });
    await manager(adapter).loadProgram(withMain, 'T_ROB1');
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', 'READ modules', UNLOAD, UPLOAD, LOADMOD, 'READ modules', RESETPP, EDIT_REL]);
  });

  it('running, no option: the load goes ahead without a stop; a controller refusal is explained as the running program', async () => {
    const ok = rws2('rw7', { exec: () => 'running', modules: ['ZZ_SIDE'] });
    await manager(ok.adapter).loadProgram(withMain, 'T_ROB1');
    expect(ok.wire).not.toContain(STOP);
    expect(ok.wire).toContain(LOADMOD);
    const { adapter } = rws2('rw7', { exec: () => 'running', modules: ['ZZ_SIDE'], fail: (m, at) => (at.endsWith('/unloadmod') ? execState(m, at) : undefined) });
    const e = await rejection(manager(adapter).loadProgram(withMain, 'T_ROB1'));
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', condition: 'controller-state' });
    expect(e.message).toMatch(/^loadProgram: the controller refused it while the RAPID program was running, and loadProgram does not stop it unless asked to. /);
  });

  it('running, stopIfRunning: the stop is the first write', async () => {
    const { adapter, wire } = rws2('rw7', { exec: () => 'running' });
    await manager(adapter).loadProgram(withMain, 'T_ROB1', { stopIfRunning: true });
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', STOP, 'READ modules', UPLOAD, LOADMOD, 'READ modules', RESETPP, EDIT_REL]);
  });

  it('resetPP: false leaves the program pointer alone; a module without main never resets it', async () => {
    const one = rws2('rw7');
    await manager(one.adapter).loadProgram(withMain, 'T_ROB1', { resetPP: false });
    expect(one.wire).not.toContain(RESETPP);
    const two = rws2('rw7');
    await manager(two.adapter).loadProgram(noMain, 'T_ROB1');
    expect(two.wire).not.toContain(RESETPP);
  });

  it('a refused unload fails the call: nothing uploaded or loaded, and the message says nothing was changed', async () => {
    const refused = fromFixture('rws2/403-uas-not-allowed-haljson', 'POST', '/rw/rapid/tasks/T_ROB1/unloadmod');
    const { adapter, wire } = rws2('rw7', {
      modules: ['ZZ_SIDE'], fail: (_m, at) => (at === '/rw/rapid/tasks/T_ROB1/unloadmod' ? refused : undefined),
    });
    const e = await rejection(manager(adapter).loadProgram(withMain, 'T_ROB1'));
    // The failed step's own code, status, controller answer and refusal are kept.
    expect(e.code).toBe(refused.code);
    expect(e.httpStatus).toBe(403);
    expect(e.controllerCode).toBe(refused.controllerCode);
    expect(e.refusal?.kind).toBe(refused.refusal?.kind);
    expect(e.message).toBe('loadProgram(ZZ_SIDE.mod into T_ROB1) could not unload the loaded module ZZ_SIDE from T_ROB1. '
      + `Nothing was changed on the controller before it. ${refused.message}`);
    expect(e.refusal!.sentence.startsWith('loadProgram(ZZ_SIDE.mod into T_ROB1) could not unload')).toBe(true);
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', 'READ modules', UNLOAD, EDIT_REL]);
  });

  it('a refused load after the unload says the old module is gone and the file was uploaded', async () => {
    const refused = fromFixture('rws2/400-module-missing-haljson', 'POST', '/rw/rapid/tasks/T_ROB1/loadmod');
    const { adapter, wire } = rws2('rw7', {
      exec: () => 'running', modules: ['ZZ_SIDE'],
      fail: (_m, at) => (at === '/rw/rapid/tasks/T_ROB1/loadmod' ? refused : undefined),
    });
    const e = await rejection(manager(adapter).loadProgram(withMain, 'T_ROB1', { stopIfRunning: true }));
    expect(e.code).toBe(refused.code);
    expect(e.message).toBe('loadProgram(ZZ_SIDE.mod into T_ROB1) could not load module ZZ_SIDE into T_ROB1. Done before it: '
      + `stopped the RAPID program; unloaded the old module ZZ_SIDE from T_ROB1; uploaded ZZ_SIDE.mod to $HOME/ZZ_SIDE.mod. ${refused.message}`);
    // After a refused load, one module-list read (a read, after the release)
    // looks for the module under a name the controller gave it.
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', STOP, 'READ modules', UNLOAD, UPLOAD, LOADMOD, EDIT_REL, 'READ modules']);
  });

  it('a failed PP to main fails the call and says the module was loaded (it used to be ignored)', async () => {
    const refused = execState('POST', '/rw/rapid/execution/resetpp');
    const { adapter } = rws2('rw7', { fail: (_m, at) => (at === '/rw/rapid/execution/resetpp' ? refused : undefined) });
    const e = await rejection(manager(adapter).loadProgram(withMain, 'T_ROB1'));
    expect(e.code).toBe('WRONG_MODE');
    expect(e.message.startsWith('loadProgram(ZZ_SIDE.mod into T_ROB1) could not set the program pointer to main. Done before it: '
      + 'uploaded ZZ_SIDE.mod to $HOME/ZZ_SIDE.mod; loaded module ZZ_SIDE into T_ROB1. ')).toBe(true);
  });

  it('a module list that cannot be read fails the call before any change (it used to count as "none loaded")', async () => {
    const { adapter, wire } = rws2('rw7');
    (adapter as unknown as Record<string, unknown>).listModules = async () => {
      wire.push('READ modules');
      throw new RwsError('RWS2 GET /rw/rapid/tasks/T_ROB1/modules: timeout', 'NETWORK_ERROR');
    };
    const e = await rejection(manager(adapter).loadProgram(withMain, 'T_ROB1'));
    expect(e.code).toBe('NETWORK_ERROR');
    expect(e.message).toMatch(/^loadProgram\(ZZ_SIDE\.mod into T_ROB1\) could not list the modules loaded in T_ROB1\. Nothing was changed on the controller before it\. /);
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', 'READ modules', EDIT_REL]);
  });

  it('a refused access request is reported as the step that failed, with nothing changed', async () => {
    const held = fromFixture('rws2/403-mastership-held-haljson', 'POST', '/rw/mastership/edit/request');
    const { adapter, wire } = rws2('rw7', { fail: (_m, at) => (at === '/rw/mastership/edit/request' ? held : undefined) });
    const mgr = manager(adapter);
    (adapter as unknown as Record<string, unknown>).getMastershipStatus = async () => ({ mastership: 'remote', application: 'RobotStudio' });
    const e = await rejection(mgr.loadProgram(withMain, 'T_ROB1'));
    expect(e.code).toBe('MASTERSHIP_REQUIRED');
    expect(e.message).toMatch(/^loadProgram\(ZZ_SIDE\.mod into T_ROB1\) could not get its turn and take mastership or write access\. Nothing was changed on the controller before it\. /);
    expect(wire).toEqual([EDIT_REQ]);
  });

  it('a local file that cannot be read: INVALID_ARGUMENT, nothing sent', async () => {
    const { adapter, wire } = rws2('rw7');
    const e = await rejection(manager(adapter).loadProgram(path.join(dir, 'missing.mod'), 'T_ROB1'));
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(e.message).toMatch(/^loadProgram: the file .*missing\.mod cannot be read \(.*\)\. Nothing was sent to the controller\.$/);
    expect(wire).toEqual([]);
  });

  /** The text each upload carried: the body of the RWS 2.0 file PUT. */
  function uploads(adapter: unknown): string[] {
    const a = adapter as Record<string, unknown>;
    const req = a.req as (...args: unknown[]) => Promise<unknown>;
    const sent: string[] = [];
    a.req = async (...args: unknown[]) => {
      if (args[0] === 'PUT' && String(args[1]).startsWith('/fileservice/')) { sent.push(args[3] as string); }
      return req(...args);
    };
    return sent;
  }

  function file(name: string, content: Uint8Array | string): string {
    const p = path.join(dir, 'enc', name, 'ZZ_SIDE.mod');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  }

  it('a UTF-8 file with non-ASCII text is uploaded as its exact text', async () => {
    const text = 'MODULE ZZ_SIDE\n  ! Größe 20 °C, ½ Hub\n  PROC main()\n  ENDPROC\nENDMODULE\n';
    const { adapter, wire } = rws2('rw7');
    const sent = uploads(adapter);
    await manager(adapter).loadProgram(file('utf8', text), 'T_ROB1');
    expect(sent).toEqual([text]);
    expect(wire).toEqual([EDIT_REQ, 'READ execstate', 'READ modules', UPLOAD, LOADMOD, 'READ modules', RESETPP, EDIT_REL]);
  });

  it('a Latin-1 file: INVALID_ARGUMENT naming the file and the line, nothing sent (1.5.1 uploaded U+FFFD in its place)', async () => {
    const latin1 = Buffer.from('MODULE ZZ_SIDE\n  ! Größe\n  PROC main()\n  ENDPROC\nENDMODULE\n', 'latin1');
    const p = file('latin1', latin1);
    const { adapter, wire } = rws2('rw7', { modules: ['ZZ_SIDE'] });
    const sent = uploads(adapter);
    const e = await rejection(manager(adapter).loadProgram(p, 'T_ROB1'));
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(e.message).toBe(`loadProgram: the file ${p} is not valid UTF-8. Line 2 has a byte sequence that is not UTF-8, `
      + 'starting with byte 0xF6 (files saved as Windows-1252, Latin-1 or UTF-16 have such bytes). '
      + 'Save the file as UTF-8 and load it again. Nothing was sent to the controller.');
    // Not even the access request: the loaded module of the same name stays.
    expect(wire).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a byte order mark is sent as it is, as 1.5.1 sent it, and PROC main is still found', async () => {
    const text = 'MODULE ZZ_SIDE\n  PROC main()\n  ENDPROC\nENDMODULE\n';
    const p = file('bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]));
    const { adapter, wire } = rws2('rw7');
    const sent = uploads(adapter);
    await manager(adapter).loadProgram(p, 'T_ROB1');
    expect(sent).toEqual([`﻿${text}`]);
    expect(sent).toEqual([fs.readFileSync(p, 'utf8')]);
    expect(wire).toContain(RESETPP);
  });

  it('a file with no text (empty, a byte order mark only, or white space only): INVALID_ARGUMENT, nothing sent', async () => {
    const empties: Array<[string, Uint8Array | string]> = [
      ['empty', ''], ['bom-only', Buffer.from([0xef, 0xbb, 0xbf])], ['blank', ' \r\n\t\r\n'],
    ];
    for (const [name, content] of empties) {
      const p = file(name, content);
      const { adapter, wire } = rws2('rw7', { modules: ['ZZ_SIDE'] });
      const e = await rejection(manager(adapter).loadProgram(p, 'T_ROB1'));
      expect(e.code).toBe('INVALID_ARGUMENT');
      expect(e.message).toBe(`loadProgram: the file ${p} has no text, so it holds no module. Nothing was sent to the controller.`);
      expect(wire).toEqual([]);
    }
  });
});

describe('RWS 2.0 activate / deactivate all tasks report each refused task', () => {
  const TASKS = ['T_ROB1', 'T_ROB2', 'T_BG'];
  // Per-task resources with no body (spec check 2026-10-07); the wire line is
  // the path alone, so the task name sits in the path.
  const ACTIVATE = (t: string) => `POST /rw/rapid/tasks/${t}/activate`;
  const DEACTIVATE = (t: string) => `POST /rw/rapid/tasks/${t}/deactivate`;
  const taskOf = (at: string) => /\/rw\/rapid\/tasks\/([^/]+)\//.exec(at)?.[1];

  function withTasks(gen: Gen, fail?: Fail) {
    const r = rws2(gen, { fail });
    (r.adapter as unknown as Record<string, unknown>).getRapidTasks = async () =>
      TASKS.map(name => ({ name, type: 'normal', taskstate: 'linked', excstate: 'stopped', active: false, motiontask: false }));
    return r;
  }

  it('all accepted: every task sent under one hold, and the call resolves', async () => {
    const { adapter, wire } = withTasks('rw7');
    await adapter.activateAllRapidTasks();
    await adapter.deactivateAllRapidTasks();
    expect(wire).toEqual([
      EDIT_REQ, ...TASKS.map(ACTIVATE), EDIT_REL,
      EDIT_REQ, ...TASKS.map(DEACTIVATE), EDIT_REL,
    ]);
  });

  it('one task refused: the others are still sent, and the call throws naming it (it used to resolve)', async () => {
    const refused = fromFixture('rws2/403-uas-not-allowed-haljson', 'POST', '/rw/rapid/tasks/T_ROB2/activate');
    const { adapter, wire } = withTasks('rw7', (_m, at) => (taskOf(at) === 'T_ROB2' ? refused : undefined));
    const e = await rejection(adapter.activateAllRapidTasks());
    expect(wire).toEqual([EDIT_REQ, ...TASKS.map(ACTIVATE), EDIT_REL]);
    expect(e.code).toBe('GRANT_DENIED');
    expect(e.httpStatus).toBe(403);
    expect(e.controllerCode).toBe(refused.controllerCode);
    expect(e.message).toBe(`activateAllRapidTasks: 1 of 3 task(s) not activated. Activated: T_ROB1, T_BG. T_ROB2 was not activated: ${refused.message}`);
    expect(e.refusal).toMatchObject({ kind: refused.refusal!.kind, grantor: refused.refusal!.grantor });
    expect(e.refusal!.sentence).toBe(`activateAllRapidTasks: 1 of 3 task(s) not activated. Activated: T_ROB1, T_BG. T_ROB2 was not activated: ${refused.refusal!.sentence}`);
  });

  it('two tasks refused for different reasons: both named; the code is the first one\'s', async () => {
    const uas = fromFixture('rws2/403-uas-not-allowed-haljson', 'POST', '/rw/rapid/tasks/T_BG/deactivate');
    const state = execState('POST', '/rw/rapid/tasks/T_ROB1/deactivate');
    const { adapter } = withTasks('rw7', (_m, at) => (taskOf(at) === 'T_ROB1' ? state : taskOf(at) === 'T_BG' ? uas : undefined));
    const e = await rejection(adapter.deactivateAllRapidTasks());
    expect(e.code).toBe('WRONG_MODE');
    expect(e.controllerCode).toBe(state.controllerCode);
    expect(e.message).toBe('deactivateAllRapidTasks: 2 of 3 task(s) not deactivated. Deactivated: T_ROB2. '
      + `T_ROB1 was not deactivated: ${state.message} T_BG was not deactivated: ${uas.message}`);
  });

  it('RobotWare 8: a task refused as not holding write access ends the loop as a lost hold; later tasks are not sent', async () => {
    const notHeld = fromFixture('rws2/403-writeaccess-not-held-haljson', 'POST', '/rw/rapid/tasks/T_ROB2/activate');
    const { adapter, wire } = withTasks('rw8', (_m, at) => (taskOf(at) === 'T_ROB2' ? notHeld : undefined));
    const e = await rejection(adapter.activateAllRapidTasks());
    // T_BG is never sent; no release follows the controller's "not held".
    expect(wire).toEqual([REGISTER, READ_MC, WA_REQ, ACTIVATE('T_ROB1'), ACTIVATE('T_ROB2')]);
    expect(e.controllerCode).toBe(-1073435873);
    expect(e.refusal?.kind).toBe('lost');
    expect(e.message.startsWith('activateAllRapidTasks stopped at T_ROB2 (task 2 of 3); the tasks after it were not sent. Activated: T_ROB1. ')).toBe(true);
  });

  it('through RobotManager the aggregate refusal reaches the caller unchanged', async () => {
    const refused = fromFixture('rws2/403-uas-not-allowed-haljson', 'POST', '/rw/rapid/tasks/T_BG/activate');
    const { adapter } = withTasks('rw7', (_m, at) => (taskOf(at) === 'T_BG' ? refused : undefined));
    const e = await rejection(manager(adapter).activateAllRapidTasks());
    expect(e.message).toMatch(/^activateAllRapidTasks: 1 of 3 task\(s\) not activated\. Activated: T_ROB1, T_ROB2\. T_BG was not activated: /);
  });
});
