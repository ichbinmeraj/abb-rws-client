import { describe, it, expect, beforeEach } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { classifyControllerError } from '../src/ControllerError.js';
import { builtRefusal } from '../src/refusal.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type RefusalContext, type RefusalKind } from '../src/types.js';

/**
 * The running-program explanation (setPPToRoutine, unloadModule, loadProgram
 * while RAPID runs) must not replace a refusal the classifier already
 * explained more specifically: a user told "stop the program" stops it for
 * nothing, and the retry is refused for the real reason.
 */

beforeEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

const PP = '/rw/rapid/tasks/T_ROB1/pcp/routine';
const RUNNING = /while the RAPID program was running/;

/** A controller refusal as the client's request path builds it. */
function classified(code: number, at: string, ctx: RefusalContext, http = 403): RwsError {
  const body = `{"_links":{"base":{"href":"https://x/"}},"status":{"code":${code},"msg":"Refused code:${code} icode:-1"}}`;
  const info = classifyControllerError({ httpStatus: http, body, method: 'POST', path: at, fallback: 'UNKNOWN', context: ctx });
  return new RwsError(info.message, info.code, http, info.controllerMsg ?? undefined, info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
}

/** A MODE_REJECT answer that carries a given refusal kind. */
function modeRejectAs(kind: RefusalKind): RwsError {
  const sentence = `Refused for the ${kind} reason.`;
  return new RwsError(sentence, 'WRONG_MODE', 403, undefined, -1073445860, 'Refused', builtRefusal({
    kind, condition: 'rmmp', generation: 'rw7', grantor: 'pendant-operator', missing: 'x', fix: 'y', sentence, evidence: 'abb',
  }));
}

function rw7Running(mode: string, fail: (at: string) => RwsError | undefined) {
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = 'mastership';
  a.req = async (_method: string, at: string) => { const e = fail(at); if (e) { throw e; } return ''; };
  a.getOperationMode = async () => mode;
  a.getRapidExecutionState = async () => 'running';
  a.listModules = async () => ['ZZ_SIDE'];
  const mgr = new RobotManager();
  Object.assign((mgr as unknown as { adapter: unknown }), { adapter });
  (mgr as unknown as { _state: Record<string, unknown> })._state.opmode = mode;
  return mgr;
}

const rejection = (p: Promise<unknown>): Promise<RwsError> => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as RwsError);

describe('the running-program explanation keeps a specific refusal', () => {
  it('PP to a routine in MANR on RobotWare 7 with RMMP modify, while running: the mode refusal (RMMP exec advice) stays', async () => {
    const reject = classified(-1073445860, PP, { generation: 'rw7', opmode: 'MANR', rmmp: 'granted' });
    expect(reject.refusal?.kind).toBe('wrong-mode');
    const e = await rejection(rw7Running('MANR', at => (at.endsWith('/pcp/routine') ? reject : undefined)).setPPToRoutine('T_ROB1', 'M1', 'r1'));
    expect(e.message).not.toMatch(RUNNING);
    expect(e.refusal?.kind).toBe('wrong-mode');
    expect(e.refusal?.sentence).toMatch(/RMMP exec/);
  });

  it('MODE_REJECT classified rmmp-required, while running: stays rmmp-required', async () => {
    const reject = modeRejectAs('rmmp-required');
    const e = await rejection(rw7Running('MANR', at => (at.endsWith('/pcp/routine') ? reject : undefined)).setPPToRoutine('T_ROB1', 'M1', 'r1'));
    expect(e.message).not.toMatch(RUNNING);
    expect(e.refusal?.kind).toBe('rmmp-required');
  });

  it('MODE_REJECT classified local-only, while running: stays local-only (unloadModule)', async () => {
    const reject = modeRejectAs('local-only');
    const e = await rejection(rw7Running('MANR', at => (at.endsWith('/unloadmod') ? reject : undefined)).unloadModule('T_ROB1', 'ZZ_SIDE'));
    expect(e.message).not.toMatch(RUNNING);
    expect(e.refusal?.kind).toBe('local-only');
  });

  it('-1073442809 explained only as the execution state, while running: becomes the running-program refusal (RW 7.21.4, 2026-10-13)', async () => {
    const reject = classified(-1073442809, PP, { generation: 'rw7', opmode: 'AUTO' });
    expect(reject.refusal?.kind).toBe('wrong-state');
    const e = await rejection(rw7Running('AUTO', at => (at.endsWith('/pcp/routine') ? reject : undefined)).setPPToRoutine('T_ROB1', 'M1', 'r1'));
    expect(e.message).toMatch(RUNNING);
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', missing: 'a stopped RAPID program' });
  });
});
