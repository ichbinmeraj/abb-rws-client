import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyControllerError } from '../src/ControllerError.js';
import {
  explainRefusal, hexCode, holderFromMastership, holderFromWriteAccess, operationOf,
  refusalFor, REFUSAL_CODES, type ControllerAnswer,
} from '../src/refusal.js';
import { RwsError, type RefusalContext, type RwsErrorCode, type RefusalKind, type RefusalGrantor } from '../src/types.js';

/**
 * Refusals in plain words (RwsError.refusal): every access-related controller
 * code maps to a kind, a missing condition, a grantor and a sentence, and the
 * controller's code is kept in decimal, hex and ABB's name.
 */

const answer = (code: number | null, over: Partial<ControllerAnswer> = {}): ControllerAnswer => ({
  http: 403, code, msg: code === null ? null : `Refused code:${code} icode:-1`,
  method: 'POST', path: '/rw/panel/speedratio', ...over,
});

function refused(a: ControllerAnswer, ctx: RefusalContext = {}) {
  const r = refusalFor(a, ctx);
  expect(r, `no refusal for ${a.code}`).not.toBeNull();
  return r!;
}

/** Nothing in a sentence advises RMMP. */
const noRmmp = (s: string): void => { expect(s).not.toMatch(/RMMP|requestRmmp/); };

interface Row {
  code: number;
  name: string;
  rws: RwsErrorCode;
  kind: RefusalKind;
  grantor: RefusalGrantor | null;
  answer?: Partial<ControllerAnswer>;
  ctx?: RefusalContext;
  says: RegExp;
}

/** One row per access-related code: the plain answer, without context. */
const ROWS: Row[] = [
  { code: -1073445862, name: 'SYS_CTRL_E_RESOURCE_HELD', rws: 'MASTERSHIP_REQUIRED', kind: 'held-by-other', grantor: 'current-holder',
    answer: { path: '/rw/mastership/edit/request' }, ctx: { generation: 'rw7' }, says: /holds edit mastership/ },
  { code: -1073445859, name: 'SYS_CTRL_E_MASTER_REJECT', rws: 'MASTERSHIP_REQUIRED', kind: 'not-held', grantor: 'this-tool',
    ctx: { generation: 'rw7' }, says: /needs mastership, and this session did not hold it/ },
  { code: -1073445880, name: 'SYS_CTRL_E_RESOURCE_NOT_HELD', rws: 'MASTERSHIP_REQUIRED', kind: 'not-held', grantor: 'this-tool',
    ctx: { generation: 'rw6' }, says: /did not hold it/ },
  { code: -1073445872, name: 'SYS_CTRL_E_RESOURCE_ALREADY_HELD', rws: 'UNKNOWN', kind: 'unknown', grantor: null,
    answer: { path: '/rw/mastership/rapid?action=request' }, ctx: { generation: 'rw6' }, says: /already holds/ },
  { code: -1073445844, name: 'SYS_CTRL_E_RESOURCE_MOTION_HELD_REJECT', rws: 'MASTERSHIP_REQUIRED', kind: 'motion-held', grantor: 'this-tool',
    answer: { http: 500, path: '/rw/rapid/execution/start' }, ctx: { generation: 'rw7' }, says: /holds motion mastership/ },
  { code: -1073445845, name: 'SYS_CTRL_E_EXTERNAL_CLIENT_REJECT', rws: 'MASTERSHIP_REQUIRED', kind: 'external-client-motion', grantor: 'current-holder',
    ctx: { generation: 'rw7' }, says: /external client controls motion/ },
  { code: -1073445860, name: 'SYS_CTRL_E_MODE_REJECT', rws: 'WRONG_MODE', kind: 'wrong-mode', grantor: 'key-switch',
    ctx: { generation: 'rw7', opmode: 'MANR' }, says: /in MANR for a remote tool.*key switch/ },
  { code: -1073435895, name: 'SYS_CTRL_E_NOT_MANUAL_MODE', rws: 'WRONG_MODE', kind: 'wrong-mode', grantor: 'key-switch',
    ctx: { generation: 'rw7', opmode: 'AUTO' }, says: /only valid in manual mode, and the controller is in AUTO/ },
  { code: -1073442809, name: 'SYS_CTRL_E_EXEC_STATE', rws: 'WRONG_MODE', kind: 'wrong-state', grantor: null,
    answer: { path: '/rw/rapid/execution/start' }, ctx: { generation: 'rw7' }, says: /current execution state/ },
  { code: -1073445806, name: 'SYS_CTRL_E_PERMISSION_CONTROLLER_STATE_REJECT', rws: 'WRONG_MODE', kind: 'wrong-state', grantor: null,
    ctx: { generation: 'rw7' }, says: /not allowed in the controller's current state/ },
  { code: -1073435886, name: 'SYS_CTRL_E_OPERATION_IS_UNLOCKED', rws: 'WRONG_MODE', kind: 'wrong-state', grantor: 'this-tool',
    answer: { path: '/rw/panel/opmode/unlock' }, ctx: { generation: 'rw8' },
    says: /^The operating-mode selector on the controller is not locked, so there is nothing to unlock\.$/ },
  { code: -1073442803, name: 'SYS_CTRL_E_RAPID_SYNTAX_ERROR', rws: 'WRONG_MODE', kind: 'wrong-state', grantor: 'this-tool',
    answer: { http: 400, path: '/rw/rapid/tasks/T_ROB1/pcp/routine' }, ctx: { generation: 'rw7' },
    says: /refused to move the program pointer: the loaded RAPID program has syntax errors/ },
  { code: -1073442802, name: 'SYS_CTRL_E_RAPID_SEMANTIC_ERROR', rws: 'INVALID_ARGUMENT', kind: 'invalid-argument', grantor: 'this-tool',
    answer: { http: 400, path: '/rw/rapid/symbol/RAPID/T_ROB1/ZZ_PROBE_RD/zz_probe_rd_varr/data' }, ctx: { generation: 'rw7' },
    says: /refused to change a RAPID variable: the value does not fit the symbol's data type/ },
  { code: -1073442812, name: 'SYS_CTRL_E_NO_PROGRAMNAME', rws: 'WRONG_MODE', kind: 'wrong-state', grantor: 'this-tool',
    answer: { http: 500, path: '/rw/rapid/tasks/T_ROB1/program?action=save' }, ctx: { generation: 'rw6' },
    says: /the task's program has no program name/ },
  { code: -1073445867, name: 'SYS_CTRL_E_UAS_REJECT', rws: 'GRANT_DENIED', kind: 'grant-missing', grantor: 'uas-administrator',
    ctx: { generation: 'rw7', user: 'Operator' }, says: /User 'Operator' is not allowed to change the speed ratio/ },
  { code: -1073445881, name: 'SYS_CTRL_E_REJECT', rws: 'GRANT_DENIED', kind: 'by-design', grantor: 'nobody',
    answer: { path: '/rw/rapid/tasks/activate' }, ctx: { generation: 'rw7' }, says: /safety access restriction mechanism/ },
  { code: -1073445827, name: 'SYS_CTRL_E_INVALID_GRANT', rws: 'INVALID_ARGUMENT', kind: 'invalid-argument', grantor: 'this-tool',
    answer: { http: 400, method: 'GET', path: '/users/grant-exists?grant=UAS_NOPE' }, ctx: { generation: 'rw7' }, says: /'UAS_NOPE' is not defined/ },
  { code: -1073445813, name: 'SYS_CTRL_E_IMPERSONATE', rws: 'GRANT_DENIED', kind: 'by-design', grantor: 'nobody',
    ctx: { generation: 'rw7' }, says: /refused to act as another user/ },
  { code: -1073445873, name: 'SYS_CTRL_E_NOT_LOGGED_ON', rws: 'SESSION_EXPIRED', kind: 'unknown', grantor: 'this-tool',
    ctx: { generation: 'rw7' }, says: /not logged on/ },
  { code: -1073445863, name: 'SYS_CTRL_E_DENIED', rws: 'GRANT_DENIED', kind: 'rmmp-denied', grantor: 'pendant-operator',
    answer: { method: 'GET', path: '/users/rmmp/poll' }, ctx: { generation: 'rw7' }, says: /denied remote access \(RMMP\)/ },
  { code: -1073445870, name: 'SYS_CTRL_E_NO_SUCH_REQUEST', rws: 'GRANT_DENIED', kind: 'rmmp-expired', grantor: 'pendant-operator',
    answer: { method: 'GET', path: '/users/rmmp/poll' }, ctx: { generation: 'rw6' }, says: /nobody confirmed it on the FlexPendant/ },
  { code: -1073445869, name: 'SYS_CTRL_E_TIMEOUT', rws: 'UNKNOWN', kind: 'unknown', grantor: null,
    ctx: { generation: 'rw7' }, says: /timed out/ },
  { code: -1073445800, name: 'SYS_CTRL_E_RMMP_E_REJECT', rws: 'WRONG_MODE', kind: 'rmmp-wrong-mode', grantor: 'key-switch',
    answer: { path: '/users/rmmp' }, ctx: { generation: 'rw7', opmode: 'MANF' }, says: /needs manual reduced speed \(MANR\).*controller is in MANF/ },
  { code: -1073445868, name: 'SYS_CTRL_E_NO_LOCAL_USER', rws: 'UNSUPPORTED_OPERATION', kind: 'local-only', grantor: 'pendant-operator',
    ctx: { generation: 'rw6' }, says: /Only someone at the controller/ },
  { code: -1073445875, name: 'SYS_CTRL_E_LOCAL_NOT_ALLOWED', rws: 'UNSUPPORTED_OPERATION', kind: 'local-only', grantor: 'pendant-operator',
    ctx: { generation: 'rw7' }, says: /cannot be done from this tool/ },
  { code: -1073445810, name: 'SYS_CTRL_E_REJECT_TOO_MANY_LOCAL_CLIENTS', rws: 'UNSUPPORTED_OPERATION', kind: 'local-only', grantor: 'pendant-operator',
    ctx: { generation: 'rw7' }, says: /Only someone at the controller/ },
  { code: -1073435869, name: 'SYS_CTRL_E_REJECT_NOT_A_LOCAL_CONTROL_STATION', rws: 'UNSUPPORTED_OPERATION', kind: 'local-only', grantor: 'pendant-operator',
    answer: { path: '/rw/controlstation/disableexternalcontrol' }, ctx: { generation: 'rw8', robot: 'IRB_1300' },
    says: /^Controller 'IRB_1300' refused to turn off external control: only a local control station, the FlexPendant, can do this, and this tool is a remote one\. Someone at the controller does it at the FlexPendant\.$/ },
  { code: -1073435856, name: 'SYS_CTRL_E_REJECT_WRONG_LOCAL_PRESENCE_CERTIFICATE_KEY', rws: 'UNSUPPORTED_OPERATION', kind: 'local-only', grantor: 'pendant-operator',
    answer: { path: '/rw/controlstation/register/local' }, ctx: { generation: 'rw8' },
    says: /did not prove local presence at the controller \(the local-presence key is not correct\)\. Someone at the controller does it at the FlexPendant\.$/ },
  { code: -1073435870, name: 'SYS_CTRL_E_REJECT_WRITE_ACCESS_ALREADY_TAKEN', rws: 'MASTERSHIP_REQUIRED', kind: 'held-by-other', grantor: 'current-holder',
    answer: { path: '/rw/controlstation/writeaccess/request' }, says: /held by another control station.*FlexPendant can take write access back/ },
  { code: -1073435873, name: 'SYS_CTRL_E_REJECT_CONTROL_STATION_DOES_NOT_HAVE_WRITE_ACCESS', rws: 'MASTERSHIP_REQUIRED', kind: 'not-held', grantor: 'this-tool',
    says: /needs control-station write access, and this session did not hold it/ },
  { code: -1073435871, name: 'SYS_CTRL_E_REJECT_NOT_A_CONTROL_STATION', rws: 'MASTERSHIP_REQUIRED', kind: 'not-registered', grantor: 'this-tool',
    answer: { path: '/rw/controlstation/writeaccess/request' }, says: /not registered as a control station/ },
  { code: -1073435872, name: 'SYS_CTRL_E_REJECT_EXTERNAL_CONTROL_ENABLE_NOT_SET', rws: 'MASTERSHIP_REQUIRED', kind: 'remote-access-off', grantor: 'pendant-operator',
    answer: { http: 400, path: '/rw/controlstation/writeaccess/request' }, says: /pressing and holding the Messages button for more than one second/ },
  { code: -1073435874, name: 'SYS_CTRL_E_REJECT_CONTROL_STATION_ALREADY_REGISTERED', rws: 'UNKNOWN', kind: 'by-design', grantor: 'this-tool',
    answer: { path: '/rw/controlstation/register/remote' }, says: /already registered as a control station/ },
  { code: -1073435867, name: 'SYS_CTRL_E_INVALID_CONTROL_STATION_ID', rws: 'INVALID_ARGUMENT', kind: 'invalid-argument', grantor: 'this-tool',
    answer: { http: 400, path: '/rw/controlstation/register/remote' }, says: /braced GUID/ },
  { code: -1073435864, name: 'SYS_CTRL_E_NOT_ALLOWED_TO_MOVE_ROBOT', rws: 'GRANT_DENIED', kind: 'motion-control-off', grantor: 'this-tool',
    answer: { path: '/rw/rapid/execution/start' },
    says: /refused to start the RAPID program: motion control is not allowed for this control station\..*does not move the robot\.$/ },
  { code: -1073445879, name: 'SYS_CTRL_E_INVALIDARG', rws: 'INVALID_ARGUMENT', kind: 'invalid-argument', grantor: 'this-tool',
    answer: { http: 400, path: '/rw/controlstation/register/remote' }, says: /PIN is missing, not numeric or too long/ },
  { code: -1073436654, name: 'SYS_CTRL_E_POSE_OUTSIDE_REACH', rws: 'INVALID_ARGUMENT', kind: 'invalid-argument', grantor: 'this-tool',
    answer: { http: 400, path: '/rw/motionsystem/mechunits/ROB_1?action=CalcJointsFromPose' }, ctx: { generation: 'rw6' },
    says: /refused this request: the position is outside the robot's reach/ },
  { code: -1073445885, name: 'SYS_CTRL_E_SERVICE_NOT_SUPPORTED', rws: 'UNSUPPORTED_OPERATION', kind: 'unsupported', grantor: 'nobody',
    answer: { http: 500, method: 'GET', path: '/users/rmmp' }, ctx: { generation: 'rw8', rwVersion: '8.1.1' },
    says: /RobotWare 8\.1\.1 does not support remote manual-mode privileges \(RMMP\)/ },
];

describe('refusalFor: one row per access-related controller code', () => {
  it('covers every code the refusal table knows', () => {
    expect(new Set(ROWS.map(r => r.code))).toEqual(new Set(REFUSAL_CODES.keys()));
  });

  for (const row of ROWS) {
    it(`${row.code} ${row.name} → ${row.rws} / ${row.kind}`, () => {
      const r = refused(answer(row.code, row.answer), row.ctx);
      expect(r.code).toBe(row.rws);
      expect(r.refusal.kind).toBe(row.kind);
      expect(r.refusal.grantor).toBe(row.grantor);
      expect(r.refusal.sentence).toMatch(row.says);
      expect(r.refusal.missing.length).toBeGreaterThan(0);
      expect(r.refusal.fix.length).toBeGreaterThan(0);
      // The controller's answer is kept: decimal, hex, ABB's name, icode.
      expect(r.refusal.controller).toMatchObject({
        http: row.answer?.http ?? 403, code: row.code, hex: hexCode(row.code), name: row.name, icode: -1,
      });
      expect(r.message.startsWith(r.refusal.sentence)).toBe(true);
      expect(r.message).toContain(`code ${row.code} (${hexCode(row.code)}, ${row.name})`);
      // The phrase earlier messages carried, which callers match on.
      expect(r.message).toContain(`HTTP ${row.answer?.http ?? 403} from ${row.answer?.method ?? 'POST'} ${(row.answer?.path ?? '/rw/panel/speedratio').split('?')[0]}`);
    });
  }

  it('writes codes in hex as ABB does', () => {
    expect(hexCode(-1073445862)).toBe('0xC004841A');
    expect(hexCode(-1073435873)).toBe('0xC004AB1F');
    expect(hexCode(-1073435886)).toBe('0xC004AB12');
    expect(hexCode(-1073414146)).toBe('0xC004FFFE');
  });

  it('the RobotWare 8 local-station codes are explained from the controller\'s own text, so their evidence is vc', () => {
    // ABB's return-code page words -1073435856 differently ("Request not from
    // a Local Control Station"); the sentence follows the controller's text.
    for (const [code, path] of [[-1073435869, '/rw/controlstation/disableexternalcontrol'], [-1073435856, '/rw/controlstation/register/local']] as const) {
      expect(refused(answer(code, { path }), { generation: 'rw8' }).refusal.evidence).toBe('vc');
    }
  });

  it('a RobotWare 8 control-station code implies RobotWare 8 when the generation is not known yet', () => {
    expect(refused(answer(-1073435870)).refusal.generation).toBe('rw8');
    expect(refused(answer(-1073445862)).refusal.generation).toBeNull();
  });
});

describe('refusalFor: condition, grantor and fix per case', () => {
  it('held by another (RobotWare 6/7) names the holder the caller read, and its grantor', () => {
    const at = answer(-1073445862, { path: '/rw/mastership/rapid?action=request' });
    const pendant = refused(at, { generation: 'rw6', opmode: 'AUTO', holder: { kind: 'local' } });
    expect(pendant.refusal).toMatchObject({ kind: 'held-by-other', condition: 'mastership', grantor: 'pendant-operator', holder: { kind: 'local' } });
    expect(pendant.refusal.sentence).toMatch(/The FlexPendant holds mastership/);
    const remote = refused(at, { generation: 'rw6', holder: { kind: 'remote', application: 'RobotStudio', id: '17' } });
    expect(remote.refusal.sentence).toMatch(/Another remote client holds mastership \(application 'RobotStudio', user id 17\)/);
    const internal = refused(at, { generation: 'rw6', holder: { kind: 'internal' } });
    expect(internal.refusal.sentence).toMatch(/controller itself holds mastership/);
  });

  it('held by another (RobotWare 8) names the station, never its id', () => {
    const r = refused(answer(-1073435870, { path: '/rw/controlstation/writeaccess/request' }),
      { generation: 'rw8', robot: 'CRB1910', holder: { kind: 'unknown', name: 'Line PLC' } });
    expect(r.refusal).toMatchObject({ condition: 'write-access', grantor: 'current-holder', holder: { name: 'Line PLC' } });
    expect(r.refusal.sentence).toMatch(/^Controller 'CRB1910' refused to take control-station write access\. Write access is held by control station 'Line PLC'/);
    expect(r.refusal.fix).toMatch(/user of control station 'Line PLC' must release write access/);
    noRmmp(r.message);
  });

  it('in manual mode on RobotWare 6/7, a held lock asks for RMMP at the FlexPendant', () => {
    const at = answer(-1073445862, { path: '/rw/mastership/rapid?action=request' });
    for (const [generation, opmode] of [['rw6', 'MANR'], ['rw6', 'MANF'], ['rw7', 'MANR']] as const) {
      const r = refused(at, { generation, opmode });
      expect(r.refusal).toMatchObject({ kind: 'rmmp-required', condition: 'rmmp', grantor: 'pendant-operator' });
      expect(r.refusal.sentence).toMatch(/press Grant/);
    }
    // A request of this session already waiting at the pendant.
    expect(refused(at, { generation: 'rw7', opmode: 'MANR', rmmp: 'pending' }).refusal.kind).toBe('rmmp-pending');
    // RobotWare 7 in MANF: RMMP is accepted in MANR only.
    const manf = refused(at, { generation: 'rw7', opmode: 'MANF' });
    expect(manf.refusal).toMatchObject({ kind: 'rmmp-wrong-mode', grantor: 'key-switch' });
    expect(manf.refusal.sentence).toMatch(/only in manual reduced speed \(MANR\)\. The controller is in MANF/);
  });

  it('never advises RMMP in Auto, on RobotWare 8, when RMMP is granted, or when another remote client holds the lock', () => {
    const at = answer(-1073445862, { path: '/rw/mastership/edit/request' });
    noRmmp(refused(at, { generation: 'rw7', opmode: 'AUTO' }).message);
    noRmmp(refused(at, { generation: 'rw7' }).message);                              // mode not known
    noRmmp(refused(at, { generation: 'rw7', opmode: 'MANR', rmmp: 'granted' }).message);
    noRmmp(refused(at, { generation: 'rw7', opmode: 'MANR', holder: { kind: 'remote' } }).message);
    noRmmp(refused(answer(-1073435870), { generation: 'rw8', opmode: 'MANR' }).message);
    noRmmp(refused(answer(-1073435873), { generation: 'rw8', opmode: 'MANR' }).message);
  });

  it('a signal write refused by the safety access restriction names the access level and the integrator, never RMMP', () => {
    for (const [path, generation] of [
      ['/rw/iosystem/signals/DRV1TESTE2?action=set', 'rw6'],
      ['/rw/iosystem/signals/SC_Feedback_Net/SC_Feedback_Dev/SafetyEnable/set-value', 'rw7'],
      ['/rw/iosystem/signals/Local/DRV_1/IIO_do8/set-value', 'rw8'],
    ] as const) {
      const r = refused(answer(-1073445881, { path }), { generation, opmode: 'MANR' });
      expect(r.code).toBe('GRANT_DENIED');
      expect(r.refusal).toMatchObject({ kind: 'access-restricted', condition: 'signal-access-level', grantor: 'integrator', evidence: 'field' });
      expect(r.refusal.sentence).toMatch(/access level/);
      expect(r.refusal.fix).toMatch(/safety review/);
      noRmmp(r.message);
    }
    expect(refused(answer(-1073445881, { path: '/rw/iosystem/signals/Local/DRV_1/DRV1TESTE2?action=set' })).refusal.sentence)
      .toMatch(/writing signal 'DRV1TESTE2'/);
  });

  it('motors on refused by the safety access restriction (RobotWare 6) is a safety state for the cell', () => {
    const r = refused(answer(-1073445881, { path: '/rw/panel/ctrlstate?action=setctrlstate', motors: 'on' }), { generation: 'rw6' });
    expect(r.refusal).toMatchObject({ kind: 'safety-state', grantor: 'cell-safety' });
    noRmmp(r.message);
  });

  // Live-verified 2026-09-30 on RW 6.16.03: a RAPID start in Auto with the
  // motors off answers 400 -1073445881 with "org_code: -4506" (the message as
  // the client kept it). It was explained as "by design", hiding the cause.
  const RW6_START_MOTORS_OFF: Partial<ControllerAnswer> = {
    http: 400, path: '/rw/rapid/execution?action=start', msg: 'org_code: -4506 new_code: 0xc0048407;',
  };

  it('a RobotWare 6 start refused -1073445881 with the motors off is WRONG_MODE, motors (state known)', () => {
    const r = refused(answer(-1073445881, RW6_START_MOTORS_OFF), { generation: 'rw6', opmode: 'AUTO', ctrlstate: 'motoroff' });
    expect(r.code).toBe('WRONG_MODE');
    expect(r.refusal).toMatchObject({ kind: 'wrong-state', condition: 'motors', grantor: 'this-tool', missing: 'motors on' });
    expect(r.refusal.sentence).toMatch(/refused to start the RAPID program: the motors are off\. Switch them on first\./);
    expect(r.message).toContain('code -1073445881 (0xC0048407, SYS_CTRL_E_REJECT)');
    expect(r.message).not.toMatch(/by ABB's design/);
  });

  it('with no motors state known, org_code -4506 on a start names the motors too', () => {
    const r = refused(answer(-1073445881, RW6_START_MOTORS_OFF), { generation: 'rw6' });
    expect(r.code).toBe('WRONG_MODE');
    expect(r.refusal).toMatchObject({ kind: 'wrong-state', condition: 'motors' });
    expect(r.refusal.sentence).toMatch(/refused to start the RAPID program: RobotWare 6 answers a start with the motors off this way \(org_code -4506\)\. Switch them on first\./);
  });

  it('a start refused -1073445881 with the motors on, or without org_code -4506, stays by design', () => {
    expect(refused(answer(-1073445881, RW6_START_MOTORS_OFF), { generation: 'rw6', ctrlstate: 'motoron' }).refusal.kind).toBe('by-design');
    const plain = refused(answer(-1073445881, { http: 400, path: '/rw/rapid/execution?action=start' }), { generation: 'rw6' });
    expect(plain.code).toBe('GRANT_DENIED');
    expect(plain.refusal.kind).toBe('by-design');
  });

  it('the known motors state decides only on RobotWare 6 or with org_code -4506: a RobotWare 8 start is not read as motors off', () => {
    // RobotWare 8 answers -1073445881 for its access restriction too, with
    // the motors often off in Auto until a Reset; that start is unrecorded.
    const bare = { http: 400, path: '/rw/rapid/execution/start' };
    for (const generation of ['rw8', 'rw7'] as const) {
      const r = refused(answer(-1073445881, bare), { generation, opmode: 'AUTO', ctrlstate: 'motoroff' });
      expect(r.refusal.condition).not.toBe('motors');
      expect(r.code).not.toBe('WRONG_MODE');
    }
    // With no generation known, the motors state alone does not decide either.
    expect(refused(answer(-1073445881, bare), { ctrlstate: 'motoroff' }).refusal.condition).not.toBe('motors');
    // org_code -4506 corroborates on any generation.
    const corroborated = refused(answer(-1073445881, { ...bare, msg: 'org_code: -4506 new_code: 0xc0048407;' }),
      { generation: 'rw8', opmode: 'AUTO', ctrlstate: 'motoroff' });
    expect(corroborated.refusal.condition).toBe('motors');
  });

  it('the same answer through classifyControllerError (RWS 1.0 XHTML status body)', () => {
    const info = classifyControllerError({
      httpStatus: 400, method: 'POST', path: '/rw/rapid/execution?action=start',
      body: '<html><body><div class="status"><span class="code">-1073445881</span><span class="msg">org_code: -4506 new_code: 0xc0048407; </span></div></body></html>',
      context: { generation: 'rw6', opmode: 'AUTO', ctrlstate: 'motoroff' },
    });
    expect(info.code).toBe('WRONG_MODE');
    expect(info.refusal?.condition).toBe('motors');
    expect(info.message).toMatch(/motors are off/);
    expect(info.message).toContain('HTTP 400 from POST /rw/rapid/execution');
  });

  it('the RobotWare 8 motors-on refusal (-1073445806) asks for a Reset at the controller, not a grant', () => {
    const r = refused(answer(-1073445806, { path: '/rw/panel/ctrl-state', motors: 'on' }), { generation: 'rw8' });
    expect(r.code).toBe('WRONG_MODE');
    expect(r.refusal).toMatchObject({ kind: 'safety-state', condition: 'safety-state', grantor: 'cell-safety', evidence: 'unverified' });
    expect(r.refusal.sentence).toMatch(/press Reset: the thumb button on the FlexPendant in Auto, or the configured safe input/);
    expect(r.message).not.toMatch(/grant|RMMP/i);
    // The keyless path is motors on too.
    expect(refused(answer(-1073445806, { path: '/rw/panel/ctrl-state/keyless-motoron' }), { generation: 'rw8' }).refusal.kind).toBe('safety-state');
    // On RobotWare 7, or for another operation, no Reset is claimed.
    expect(refused(answer(-1073445806, { path: '/rw/panel/ctrl-state', motors: 'on' }), { generation: 'rw7' }).refusal.kind).toBe('wrong-state');
  });

  it('a missing grant names the identifier, the RobotStudio name, and the exact path per generation', () => {
    const at = answer(-1073445867, { path: '/rw/panel/speedratio' });
    const omni = refused(at, { generation: 'rw7', user: 'Operator', robot: 'IRB1200' });
    expect(omni.refusal.grants).toEqual([{ id: 'UAS_SPEED_DECREASE', label: 'Decrease production speed', labelEvidence: 'abb' }]);
    expect(omni.refusal.user).toBe('Operator');
    expect(omni.refusal.sentence).toMatch(/It needs the grant 'Decrease production speed' \(UAS_SPEED_DECREASE\)/);
    expect(omni.refusal.fix).toMatch(/Add Controller \('IRB1200'\) > Request Write Access > Authenticate > Login as a Different User \(an administrator\) > Authenticate > Edit User Accounts > Roles tab, selects the role of user 'Operator', clicks Edit, ticks 'Decrease production speed', and clicks Apply/);
    expect(omni.refusal.fix).not.toMatch(/Remote Access/);

    const rw8 = refused(at, { generation: 'rw8', user: 'Operator' });
    expect(rw8.refusal.fix).toMatch(/^An operator must first allow Remote Access on the FlexPendant\. An administrator opens RobotStudio/);

    const irc5 = refused(at, { generation: 'rw6', user: 'Operator' });
    expect(irc5.refusal.fix).toMatch(/'Manage UAS settings' opens RobotStudio > Controller tab > Add Controller \(this controller\) > Request Write Access > Authenticate > Edit User Accounts > Groups tab, selects the group of user 'Operator', ticks 'Decrease production speed' under Controller grants, and clicks OK/);
    noRmmp(omni.message); noRmmp(rw8.message); noRmmp(irc5.message);
  });

  it('a grant paired only by name is named "probably"', () => {
    const r = refused(answer(-1073445867, { path: '/rw/iosystem/signals/Local/DRV_1/DO1/set-value' }), { generation: 'rw7' });
    expect(r.refusal.grants?.[0]).toMatchObject({ id: 'UAS_IO_WRITE', labelEvidence: 'name-match' });
    expect(r.refusal.sentence).toMatch(/UAS_IO_WRITE \(probably 'I\/O write access' in RobotStudio\)/);
    expect(r.refusal.evidence).toBe('unverified');
  });

  it('a start in Auto on OmniCore needs both grants; in manual only Execute program', () => {
    const at = answer(-1073445867, { path: '/rw/rapid/execution/start' });
    const auto = refused(at, { generation: 'rw7', opmode: 'AUTO' });
    expect(auto.refusal.grants?.map(g => g.id)).toEqual(['UAS_RAPID_EXECUTE', 'UAS_REMOTE_START_STOP_IN_AUTO']);
    expect(auto.refusal.fix).toMatch(/whichever of 'Execute program' and 'Remote Start and Stop in Auto' is missing/);
    expect(refused(at, { generation: 'rw7', opmode: 'MANR' }).refusal.grants?.map(g => g.id)).toEqual(['UAS_RAPID_EXECUTE']);
    // RobotWare 6 lists no identifier for the IRC5 Auto grant.
    const irc5 = refused(answer(-1073445867, { path: '/rw/rapid/execution?action=start' }), { generation: 'rw6', opmode: 'AUTO' });
    expect(irc5.refusal.grants?.map(g => g.id)).toEqual(['UAS_RAPID_EXECUTE']);
    expect(irc5.refusal.sentence).toMatch(/'Remote Start Stop in Auto'/);
    expect(irc5.message).not.toMatch(/UAS_REMOTE_START_STOP_IN_AUTO/);
  });

  it('a stop names both candidate grants and the documented disagreement; in manual no grant', () => {
    const at = answer(-1073445867, { path: '/rw/rapid/execution/stop' });
    const auto = refused(at, { generation: 'rw7', opmode: 'AUTO' });
    expect(auto.refusal.sentence).toMatch(/documents disagree/);
    expect(auto.refusal.grants?.map(g => g.id)).toEqual(['UAS_REMOTE_START_STOP_IN_AUTO', 'UAS_RAPID_EXECUTE']);
    const manual = refused(at, { generation: 'rw7', opmode: 'MANR' });
    expect(manual.refusal.grants).toBeUndefined();
    expect(manual.refusal.fix).toMatch(/Authenticate > View UAS Grants/);
  });

  it('an LDAP resource refused for the user names the resource and claims no cause', () => {
    const r = refused(answer(-1073445867, { method: 'GET', path: '/uas/ldap/enabled', msg: 'The user is not allowed access code:-1073445867 icode:-757' }),
      { generation: 'rw7', user: 'Default User' });
    expect(r.refusal.kind).toBe('grant-missing');
    expect(r.refusal.grants).toBeUndefined();
    expect(r.refusal.sentence).toMatch(/does not say which grant or licence is missing/);
    expect(r.refusal.controller.icode).toBe(-757);
  });

  it('with the generation unknown, no OmniCore-only identifier is assumed', () => {
    const r = refused(answer(-1073445867, { path: '/rw/rapid/execution?action=stop' }), { opmode: 'AUTO' });
    expect(r.message).not.toMatch(/UAS_REMOTE_START_STOP_IN_AUTO/);
    const files = refused(answer(-1073445867, { method: 'PUT', path: '/fileservice/$HOME/a.mod' }));
    expect(files.refusal.grants?.map(g => g.id)).toEqual(['UAS_FTP_WRITE', 'UAS_FILE_ACCESS_READ_WRITE']);
    expect(files.refusal.fix).toMatch(/on IRC5 in the Groups tab.*on OmniCore in the Roles tab/);
  });

  it('a start refused in its execution state names the cause the caller saw', () => {
    const at = answer(-1073442809, { path: '/rw/rapid/execution/start' });
    expect(refused(at, { generation: 'rw7', ctrlstate: 'motoroff', opmode: 'AUTO' }).refusal).toMatchObject({ condition: 'motors', grantor: 'this-tool' });
    expect(refused(at, { generation: 'rw8', ctrlstate: 'motoroff' }).refusal).toMatchObject({ condition: 'motors', grantor: 'cell-safety' });
    expect(refused(at, { generation: 'rw8', ctrlstate: 'motoroff' }).refusal.sentence).toMatch(/Reset/);
    expect(refused(at, { generation: 'rw7', ctrlstate: 'guardstop' }).refusal).toMatchObject({ condition: 'safety-state', grantor: 'cell-safety' });
  });

  describe('a jog refused with the motors off', () => {
    const jog = (code: number, generation: 'rw6' | 'rw7' | 'rw8'): ControllerAnswer =>
      answer(code, { path: generation === 'rw6' ? '/rw/motionsystem?action=jog' : '/rw/motionsystem/jog' });

    it('in Auto says jogging is done in manual mode at the FlexPendant, not "switch them on first"; code and kind stay', () => {
      for (const generation of ['rw6', 'rw7', 'rw8'] as const) {
        for (const code of [-1073445806, -1073442809]) {
          const r = refused(jog(code, generation), { generation, opmode: 'AUTO', ctrlstate: 'motoroff', robot: 'IRB1600' });
          expect(r.code, `${generation} ${code}`).toBe('WRONG_MODE');
          expect(r.refusal).toMatchObject({ kind: 'wrong-state', condition: 'motors', grantor: 'pendant-operator', evidence: 'abb' });
          expect(r.refusal.sentence).toMatch(/^Controller 'IRB1600' refused to jog in AUTO with the motors off\. Jogging is done in manual mode at the FlexPendant, not in Auto/);
          expect(r.refusal.sentence).toMatch(/manual reduced speed \(MANR\).*enabling device/);
          expect(r.refusal.fix).toMatch(/^Jog in manual mode at the FlexPendant/);
          expect(r.message).not.toMatch(/Switch them on first|presses Reset|RMMP/);
          expect(r.message).toContain(`code ${code} (${hexCode(code)}, ${REFUSAL_CODES.get(code)!.name})`);
        }
      }
    });

    it('in manual mode keeps the enabling-device sentence; a start in Auto keeps "switch them on first"', () => {
      const manr = refused(jog(-1073445806, 'rw7'), { generation: 'rw7', opmode: 'MANR', ctrlstate: 'motoroff' });
      expect(manr.refusal).toMatchObject({ kind: 'wrong-state', condition: 'motors', grantor: 'pendant-operator' });
      expect(manr.refusal.sentence).toMatch(/refused to jog: the motors are off\. In manual mode a person switches them on by holding the enabling device/);
      expect(manr.refusal.sentence).not.toMatch(/Jogging is done in manual mode/);
      const start = refused(answer(-1073445806, { path: '/rw/rapid/execution/start' }), { generation: 'rw7', opmode: 'AUTO', ctrlstate: 'motoroff' });
      expect(start.refusal.sentence).toMatch(/refused to start the RAPID program: the motors are off\. Switch them on first\./);
    });

    it('with no mode known it says the motors are off, as before', () => {
      const r = refused(jog(-1073445806, 'rw7'), { generation: 'rw7', ctrlstate: 'motoroff' });
      expect(r.refusal.sentence).toMatch(/refused to jog: the motors are off\. Switch them on first\./);
    });
  });

  describe('an unlock of the operating-mode selector refused -1073435886 ("OP-mode is not locked")', () => {
    const unlock = (path: string): ControllerAnswer => answer(-1073435886, { path, msg: 'OP-mode is not locked code:-1073435886 icode:-1' });

    it('is wrong-state: the selector is not locked, so there is nothing to unlock (RWS 2.0 and RWS 1.0 paths)', () => {
      for (const [path, generation] of [['/rw/panel/opmode/unlock', 'rw8'], ['/rw/panel/opmode/unlock', 'rw7'], ['/rw/panel/opmode?action=unlock', 'rw6']] as const) {
        const r = refused(unlock(path), { generation, robot: 'IRB1600_6_120' });
        expect(r.code, path).toBe('WRONG_MODE');
        expect(r.refusal).toMatchObject({ kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool', evidence: 'abb' });
        expect(r.refusal.sentence).toBe("The operating-mode selector on controller 'IRB1600_6_120' is not locked, so there is nothing to unlock.");
        expect(r.message).toContain('code -1073435886 (0xC004AB12, SYS_CTRL_E_OPERATION_IS_UNLOCKED): OP-mode is not locked');
        expect(r.message).not.toMatch(/gave no reason|RMMP|grant/i);
      }
    });

    it('through classifyControllerError it is no longer UNKNOWN', () => {
      const info = classifyControllerError({
        httpStatus: 403, method: 'POST', path: '/rw/panel/opmode/unlock',
        body: '{"status":{"code":-1073435886,"msg":"OP-mode is not locked code:-1073435886"}}',
        context: { generation: 'rw8' },
      });
      expect(info.code).toBe('WRONG_MODE');
      expect(info.controllerCode).toBe(-1073435886);
      expect(info.refusal?.kind).toBe('wrong-state');
      expect(info.message).toMatch(/^The operating-mode selector on the controller is not locked, so there is nothing to unlock\./);
    });

    it('on another request it claims only what ABB names the code', () => {
      const r = refused(unlock('/rw/panel/opmode/lock'), { generation: 'rw8' });
      expect(r.code).toBe('WRONG_MODE');
      expect(r.refusal).toMatchObject({ kind: 'wrong-state', grantor: null });
      expect(r.refusal.sentence).toMatch(/refused to lock or unlock the operating-mode selector: the controller says the operation is not locked \(ABB: "Operation is not locked"\)/);
      expect(r.refusal.sentence).not.toMatch(/nothing to unlock/);
    });
  });

  it('a motors write refused in its execution state is never explained as "the motors are off"', () => {
    const r = refused(answer(-1073442809, { path: '/rw/panel/ctrl-state', motors: 'on' }), { generation: 'rw7', ctrlstate: 'motoroff' });
    expect(r.refusal.condition).not.toBe('motors');
    expect(r.refusal.sentence).not.toMatch(/the motors are off/);
  });

  // Live-verified 2026-09-30: a RAPID start with the program pointer set
  // answers 403 -1073445806 on RW 7.21.4 with the motors off and on RW 8.2.1
  // in guard stop. The state the caller knows names the cause.
  describe('a start refused -1073445806 (not allowed in the current controller state)', () => {
    const start = answer(-1073445806, { path: '/rw/rapid/execution/start' });

    it('with the motors off (RW 7.21.4) names the motors, not a grant or RMMP', () => {
      const r = refused(start, { generation: 'rw7', opmode: 'AUTO', ctrlstate: 'motoroff' });
      expect(r.code).toBe('WRONG_MODE');
      expect(r.refusal).toMatchObject({ kind: 'wrong-state', condition: 'motors', grantor: 'this-tool', missing: 'motors on' });
      expect(r.refusal.sentence).toMatch(/refused to start the RAPID program: the motors are off\. Switch them on first\./);
      expect(r.message).not.toMatch(/grant|RMMP/i);
      expect(r.message).toContain('code -1073445806 (0xC0048452, SYS_CTRL_E_PERMISSION_CONTROLLER_STATE_REJECT)');
    });

    it('in guard stop on RobotWare 8 (RW 8.2.1) names the guard stop and the Reset at the controller', () => {
      const r = refused(start, { generation: 'rw8', opmode: 'AUTO', ctrlstate: 'guardstop' });
      expect(r.code).toBe('WRONG_MODE');
      expect(r.refusal).toMatchObject({ kind: 'wrong-state', condition: 'safety-state', grantor: 'cell-safety' });
      expect(r.refusal.sentence).toMatch(/refused to start the RAPID program: the controller is in guard stop\./);
      expect(r.refusal.fix).toMatch(/Reset/);
      expect(r.message).not.toMatch(/grant|RMMP/i);
    });

    it('with the motors off on RobotWare 8 asks for the Reset at the controller', () => {
      const r = refused(start, { generation: 'rw8', ctrlstate: 'motoroff' });
      expect(r.refusal).toMatchObject({ condition: 'motors', grantor: 'cell-safety' });
      expect(r.refusal.sentence).toMatch(/presses Reset at the controller/);
    });

    it('with no state known names both causes, the RobotWare 8 Reset where it may apply, and still "current state"', () => {
      const rw8 = refused(start, { generation: 'rw8' });
      expect(rw8.refusal).toMatchObject({ kind: 'wrong-state', condition: 'controller-state', grantor: null });
      expect(rw8.refusal.sentence).toMatch(/current state/);
      expect(rw8.refusal.sentence).toMatch(/Causes seen so far: the motors off, or a guard stop \(on RobotWare 8 .*presses Reset at the controller/);
      expect(rw8.message).not.toMatch(/grant|RMMP/i);
      const rw7 = refused(start, { generation: 'rw7' });
      expect(rw7.refusal.sentence).toMatch(/Causes seen so far: the motors off, or a guard stop\./);
      expect(rw7.refusal.sentence).not.toMatch(/RobotWare 8/);
      expect(rw7.refusal.fix).toMatch(/Switch the motors on/);
    });

    it('a motors-on write with the motors off is not told the motors are off', () => {
      const r = refused(answer(-1073445806, { path: '/rw/panel/ctrl-state', motors: 'on' }), { generation: 'rw7', ctrlstate: 'motoroff' });
      expect(r.refusal.condition).not.toBe('motors');
      // In guard stop it names the guard stop.
      const g = refused(answer(-1073445806, { path: '/rw/panel/ctrl-state', motors: 'on' }), { generation: 'rw7', ctrlstate: 'guardstop' });
      expect(g.refusal).toMatchObject({ condition: 'safety-state', grantor: 'cell-safety' });
    });
  });

  it('a RAPID semantic error outside a value write is the program, not the argument', () => {
    const r = refused(answer(-1073442802, { http: 400, path: '/rw/rapid/tasks/T_ROB1/pcp/routine' }), { generation: 'rw7' });
    expect(r.code).toBe('WRONG_MODE');
    expect(r.refusal).toMatchObject({ kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool', evidence: 'abb' });
    expect(r.refusal.sentence).toMatch(/the loaded RAPID program has semantic errors/);
    // RWS 1.0 value writes are recognised by the same path prefix.
    const rw6 = refused(answer(-1073442802, { http: 400, path: '/rw/rapid/symbol/data/RAPID/T_ROB1/ZZ_PROBE_RD/zz_probe_rd_varr?action=set' }), { generation: 'rw6' });
    expect(rw6.code).toBe('INVALID_ARGUMENT');
    expect(rw6.refusal.kind).toBe('invalid-argument');
  });

  it('a not-held answer on RobotWare 8 from an unregistered session is not-registered', () => {
    const r = refused(answer(-1073435873, { path: '/rw/rapid/tasks/T_ROB1/loadmod' }), { generation: 'rw8', registered: false });
    expect(r.refusal).toMatchObject({ kind: 'not-registered', condition: 'control-station' });
  });

  it('a control-station id refusal outside a registration claims no cause (ABB names the code two ways)', () => {
    const r = refused(answer(-1073435867, { path: '/rw/controlstation/writeaccess/request' }));
    expect(r.code).toBe('UNKNOWN');
    expect(r.refusal.kind).toBe('unknown');
  });

  it('RMMP answers outside an RMMP request are explained without RMMP', () => {
    const denied = refused(answer(-1073445863, { path: '/rw/panel/speedratio' }), { generation: 'rw7' });
    expect(denied.refusal.kind).toBe('unknown');
    noRmmp(denied.message);
    const timeout = refused(answer(-1073445869, { path: '/users/rmmp/poll', method: 'GET' }), { generation: 'rw7' });
    expect(timeout.refusal.kind).toBe('rmmp-expired');
  });
});

describe('refusalFor: HTTP statuses and message forms', () => {
  it('410 Gone on a mastership path (RobotWare 8) is unsupported, never RMMP or grant advice', () => {
    for (const p of ['/rw/mastership/edit/request-with-id', '/rw/mastership/watchdog', '/rw/mastership/edit']) {
      const r = refused(answer(-1073445881, { http: 410, path: p }), { generation: 'rw8' });
      expect(r.code).toBe('UNSUPPORTED_OPERATION');
      expect(r.refusal).toMatchObject({ kind: 'unsupported', grantor: 'nobody' });
      expect(r.refusal.sentence).toMatch(/no mastership service \(HTTP 410 Gone\)/);
      noRmmp(r.message);
      expect(r.message).not.toMatch(/grant/i);
    }
    const rmmp = refused(answer(null, { http: 410, method: 'GET', path: '/users/rmmp' }), { generation: 'rw8' });
    expect(rmmp.refusal.sentence).toMatch(/does not support remote manual-mode privileges/);
  });

  it('a 403 with no code, or a code this client does not know, is unknown: raw text, no advice', () => {
    const bare = refused(answer(null));
    expect(bare.code).toBe('UNKNOWN');
    expect(bare.refusal).toMatchObject({ kind: 'unknown', condition: 'unknown', grantor: null, evidence: 'unverified' });
    expect(bare.message).not.toMatch(/RMMP|grant|FlexPendant/i);
    const odd = refused(answer(-1073400000, { msg: 'Something new' }));
    expect(odd.code).toBe('UNKNOWN');
    expect(odd.message).toContain('code -1073400000 (0xC0053740): Something new');
  });

  it('a missing option is option-missing (UNSUPPORTED_OPERATION), not a permission', () => {
    const r = refused(answer(-1073445881, { path: '/rw/motionsystem/collisionavoidance/loadconfig', msg: 'Option is missing code:-1073445881 icode:-7301' }),
      { generation: 'rw7', opmode: 'MANR' });
    expect(r.code).toBe('UNSUPPORTED_OPERATION');
    expect(r.refusal).toMatchObject({ kind: 'option-missing', condition: 'option', grantor: 'abb-option' });
    noRmmp(r.message);
    expect(r.message).not.toMatch(/grant/i);
  });

  it('"not supported on the current platform" says real or virtual when the caller knows which', () => {
    const at = answer(-1073445881, { path: '/ctrl/system/info', msg: 'Functionality is not supported on the current platform' });
    expect(refused(at, { virtual: true }).refusal.kind).toBe('rc-only');
    expect(refused(at, { virtual: false }).refusal.kind).toBe('vc-only');
    expect(refused(at).refusal.kind).toBe('unsupported');
    expect(refused(at).code).toBe('UNSUPPORTED_OPERATION');
  });

  it('SYS_CTRL_E_FAIL is explained by its inner code, and never as "not found" for a 403', () => {
    const inner = refused(answer(-1073414146, {
      path: '/rw/panel/ctrlstate?action=setctrlstate', motors: 'on', msg: 'Rejected code:-1073445881 icode:-2',
    }), { generation: 'rw6' });
    expect(inner.refusal).toMatchObject({ kind: 'safety-state', controller: { code: -1073414146, name: 'SYS_CTRL_E_FAIL' } });
    expect(inner.message).toContain('inner code -1073445881 (0xC0048407, SYS_CTRL_E_REJECT)');
    const bare403 = classifyControllerError({ httpStatus: 403, body: JSON.stringify({ _embedded: { status: { code: -1073414146, msg: 'Unspecified' } } }), method: 'POST', path: '/rw/x' });
    expect(bare403.code).toBe('UNKNOWN');
    expect(bare403.message).not.toMatch(/does not exist/);
    // 404 and 400 keep today's not-found meaning.
    const nf = classifyControllerError({ httpStatus: 404, body: JSON.stringify({ _embedded: { status: { code: -1073414146, msg: 'x' } } }), method: 'GET', path: '/rw/iosystem/signals/x' });
    expect(nf.code).toBe('RESOURCE_NOT_FOUND');
    expect(nf.refusal).toBeUndefined();
  });

  it('a 401 is never explained as a refusal, even with a grant code in the body', () => {
    const info = classifyControllerError({
      httpStatus: 401, body: JSON.stringify({ status: { code: -1073445867, msg: 'x' } }), method: 'GET', path: '/rw/panel', fallback: 'AUTH_FAILED',
    });
    expect(info.refusal).toBeUndefined();
    expect(info.code).toBe('AUTH_FAILED');
  });

  it('a missing resource is not a refusal', () => {
    const info = classifyControllerError({ httpStatus: 400, body: JSON.stringify({ status: { code: -1073442813, msg: 'x' } }), method: 'POST', path: '/rw/rapid/tasks/T/loadmod' });
    expect(info.code).toBe('MODULE_NOT_FOUND');
    expect(info.refusal).toBeUndefined();
  });

  it('the request body is read only for motors on or off, and never kept', () => {
    const info = classifyControllerError({
      httpStatus: 403, body: JSON.stringify({ status: { code: -1073445806, msg: 'x' } }), method: 'POST', path: '/rw/panel/ctrl-state',
      context: { generation: 'rw8' }, requestBody: 'ctrl-state=motoron&pincode=1234',
    });
    expect(info.refusal?.kind).toBe('safety-state');
    expect(JSON.stringify(info.refusal)).not.toContain('1234');
    expect(info.message).not.toContain('1234');
  });
});

describe('every captured error fixture that is a refusal carries one', () => {
  const root = path.join(__dirname, 'fixtures', 'errors');
  for (const proto of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, proto))) {
      const f = JSON.parse(fs.readFileSync(path.join(root, proto, file), 'utf8')) as {
        request: { method: string; path: string };
        response: { status: number; body: string };
      };
      it(`${proto}/${file}`, () => {
        const generation = proto === 'rws1' ? 'rw6' : undefined;
        const info = classifyControllerError({
          httpStatus: f.response.status, body: f.response.body, method: f.request.method, path: f.request.path,
          context: generation ? { generation } : {},
        });
        const accessCode = info.controllerCode !== null && REFUSAL_CODES.has(info.controllerCode);
        if (accessCode || f.response.status === 403) {
          expect(info.refusal, 'refusal').toBeDefined();
          expect(info.refusal!.kind).toBeTruthy();
          expect(info.refusal!.fix.length).toBeGreaterThan(0);
          expect(info.refusal!.controller.code).toBe(info.controllerCode);
          // No fixture was captured in manual mode: none may advise RMMP.
          if (info.refusal!.kind !== 'unsupported' || !/rmmp/.test(f.request.path)) { noRmmp(info.message); }
        } else {
          expect(info.refusal).toBeUndefined();
        }
      });
    }
  }
});

describe('explainRefusal', () => {
  const classified = (a: ControllerAnswer, ctx: RefusalContext = {}): RwsError => {
    const r = refused(a, ctx);
    return new RwsError(r.message, r.code, a.http, undefined, a.code ?? undefined, a.msg ?? undefined, r.refusal);
  };

  it('adds the holder and keeps the code, HTTP status and controller answer', () => {
    const err = classified(answer(-1073445862, { path: '/rw/mastership/edit/request' }), { generation: 'rw7', user: 'u' });
    const out = explainRefusal(err, { holder: { kind: 'remote', application: 'RobotStudio' } });
    expect(out).not.toBe(err);
    expect(out).toBeInstanceOf(RwsError);
    expect(out).toMatchObject({ code: err.code, httpStatus: 403, controllerCode: -1073445862 });
    expect(out.refusal?.holder).toEqual({ kind: 'remote', application: 'RobotStudio' });
    expect(out.message).toMatch(/Another remote client holds mastership \(application 'RobotStudio'\)/);
    expect(out.message).toContain('Controller: HTTP 403 from POST /rw/mastership/edit/request');
  });

  it('a mode learned later turns a held lock in manual into an RMMP request (RobotWare 6/7 only)', () => {
    const err = classified(answer(-1073445862, { path: '/rw/mastership/rapid?action=request' }), { generation: 'rw6' });
    expect(err.refusal?.kind).toBe('held-by-other');
    expect(explainRefusal(err, { opmode: 'MANR' }).refusal?.kind).toBe('rmmp-required');
    expect(explainRefusal(err, { opmode: 'AUTO' }).refusal?.kind).toBe('held-by-other');
  });

  it('an error without a refusal is returned as it is; a built refusal only gains a holder', () => {
    const plain = new RwsError('x', 'NETWORK_ERROR');
    expect(explainRefusal(plain, { opmode: 'MANR' })).toBe(plain);
    const built = new RwsError('Jogging is refused.', 'WRONG_MODE', undefined, undefined, undefined, undefined, {
      kind: 'wrong-mode', condition: 'operating-mode', generation: 'rw7', missing: 'm', grantor: 'key-switch', fix: 'f',
      sentence: 'Jogging is refused.', controller: {}, evidence: 'abb',
    });
    expect(explainRefusal(built, { opmode: 'MANR' })).toBe(built);
    expect(explainRefusal(built, { holder: { kind: 'local' } }).refusal?.holder).toEqual({ kind: 'local' });
  });
});

describe('holders from status reads', () => {
  it('a mastership status names local, remote and internal holders; nomaster names nobody', () => {
    expect(holderFromMastership({ mastership: 'local' })).toEqual({ kind: 'local' });
    expect(holderFromMastership({ mastership: 'remote', uid: '17', application: 'RobotStudio' }))
      .toEqual({ kind: 'remote', id: '17', application: 'RobotStudio' });
    expect(holderFromMastership({ mastership: 'internal' })).toEqual({ kind: 'internal' });
    expect(holderFromMastership({ mastership: 'nomaster' })).toBeNull();
    expect(holderFromMastership({ mastership: 'unknown' })).toBeNull();
  });

  it('a write-access status names the other station by name only', () => {
    expect(holderFromWriteAccess({ held: true, heldByMe: false, heldByName: 'Line PLC' })).toEqual({ kind: 'unknown', name: 'Line PLC' });
    expect(holderFromWriteAccess({ held: true, heldByMe: true, heldByName: 'me' })).toEqual({ kind: 'self' });
    expect(holderFromWriteAccess({ held: false, heldByMe: false, heldByName: 'none' })).toBeNull();
    expect(holderFromWriteAccess({ held: true, heldByMe: false, heldByName: 'none' })).toBeNull();
  });
});

describe('operationOf', () => {
  it('recognises the operations refusals are explained for, on both generations', () => {
    expect(operationOf('POST', '/rw/rapid/execution?action=start')?.kind).toBe('start');
    expect(operationOf('POST', '/rw/rapid/execution/start')?.kind).toBe('start');
    expect(operationOf('POST', '/rw/rapid/execution/startprodentry')?.kind).toBe('start');
    expect(operationOf('POST', '/rw/rapid/execution?action=stop')?.kind).toBe('stop');
    expect(operationOf('POST', '/rw/iosystem/signals/Local/DRV_1/DO1/set-value')).toMatchObject({ kind: 'io-write', signal: 'DO1' });
    expect(operationOf('POST', '/rw/panel/ctrl-state', 'on')?.kind).toBe('motors-on');
    expect(operationOf('POST', '/rw/panel/ctrl-state', 'off')?.kind).toBe('motors-off');
    expect(operationOf('POST', '/rw/mastership/motion/request')).toMatchObject({ kind: 'mastership-request', domain: 'motion' });
    expect(operationOf('POST', '/users/rmmp')?.kind).toBe('rmmp-request');
    expect(operationOf('POST', '/users/rmmp/cancel')?.kind).toBe('rmmp');
    expect(operationOf('GET', '/rw/panel/speedratio')).toBeNull();
  });

  it('the RWS 1.0 keyless motors-on under /rw/cfg is a motors-on, not a system-parameter change', () => {
    expect(operationOf('POST', '/rw/cfg?action=keyless&json=1')).toMatchObject({ kind: 'motors-on', label: 'switch the motors on' });
    expect(operationOf('POST', '/rw/cfg?json=1&action=keyless')?.kind).toBe('motors-on');
    expect(operationOf('POST', '/rw/cfg/moc/arm/instances/rob_1?action=set')?.label).toBe('change system parameters');
    expect(operationOf('POST', '/rw/cfg?action=keylessx')?.label).toBe('change system parameters');
  });
});

describe('a refused RWS 1.0 keyless motors-on is explained as the motors-on it is', () => {
  const classify = (code: number, path: string, requestBody: string) => classifyControllerError({
    httpStatus: 403, method: 'POST', path, requestBody,
    body: `<html><body><div class="status"><span class="code">${code}</span><span class="msg">x</span></div></body></html>`,
    context: { generation: 'rw6', opmode: 'AUTO', ctrlstate: 'motoroff' },
  });

  for (const code of [-1073445806, -1073445881, -1073445867]) {
    it(`code ${code}, motors read off: the same explanation as the ordinary RWS 1.0 motors-on`, () => {
      const keyless = classify(code, '/rw/cfg?action=keyless&json=1', 'state=run');
      const ordinary = classify(code, '/rw/panel/ctrlstate?action=setctrlstate&json=1', 'ctrl-state=motoron');
      expect(keyless.refusal).toBeDefined();
      expect(keyless.code).toBe(ordinary.code);
      expect(keyless.refusal).toMatchObject({
        kind: ordinary.refusal!.kind, condition: ordinary.refusal!.condition,
        grantor: ordinary.refusal!.grantor, sentence: ordinary.refusal!.sentence,
      });
      expect(keyless.refusal!.sentence).toMatch(/switch the motors on/);
      expect(keyless.message).not.toMatch(/system parameters|UAS_CFG_WRITE|Switch them on first/);
    });
  }
});
