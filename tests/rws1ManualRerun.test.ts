import { describe, it, expect } from 'vitest';
import { classifyControllerError } from '../src/ControllerError.js';
import { RobotManager } from '../src/RobotManager.js';
import { RwsError } from '../src/types.js';

/**
 * RWS 1.0 findings from the acceptance step 5 rerun (RobotWare 6.16.03, MANR, RMMP
 * modify granted, 2026-10-13):
 * 1. PP to main answered HTTP 400 with the generic outer code -1073414146 and
 *    the real reason in the message, `icode:-1073445860` (and as hex in
 *    `new_code: 0xc004841c`): SYS_CTRL_E_MODE_REJECT. It was classified by the
 *    outer code as RESOURCE_NOT_FOUND, and resetRapid then said the task has
 *    no main routine while ZZ_PROBE with PROC main was loaded.
 * 2. The mode-selector lock and unlock answered 403 -1073445867
 *    SYS_CTRL_E_UAS_REJECT "The required option is missing"; the sentence
 *    named "change the operating mode" instead of the lock.
 */

// The controller's message as recorded on the RobotWare 6.16.03 virtual controller.
const RESETPP_MSG = 'org_code: -4502 new_code: 0xc004841c; code:-1073414146 icode:-1073445860';
const xhtml = (code: number, msg: string): string =>
  `<html><body><div class="status"><span class="code">${code}</span><span class="msg">${msg}</span></div></body></html>`;

describe('item 1: RWS 1.0 PP to main refused in manual mode', () => {
  it('the inner icode is read: WRONG_MODE, explained as the manual-mode program-pointer refusal, not RESOURCE_NOT_FOUND', () => {
    const info = classifyControllerError({
      httpStatus: 400, body: xhtml(-1073414146, RESETPP_MSG), method: 'POST', path: '/rw/rapid/execution?action=resetpp',
      context: { generation: 'rw6', opmode: 'MANR', robot: 'IRB1600_6_120_6' },
    });
    expect(info.code).toBe('WRONG_MODE');
    expect(info.refusal?.kind).toBe('wrong-mode');
    expect(info.refusal?.sentence).toMatch(/set the program pointer to Main in MANR/);
    expect(info.refusal?.sentence).toMatch(/Auto/);
    expect(info.message).not.toMatch(/Resource does not exist/);
  });

  it('the hex new_code alone is read the same way', () => {
    const info = classifyControllerError({
      httpStatus: 400, body: xhtml(-1073414146, 'org_code: -4502 new_code: 0xc004841c'), method: 'POST', path: '/rw/rapid/execution?action=resetpp',
      context: { generation: 'rw6', opmode: 'MANR' },
    });
    expect(info.code).toBe('WRONG_MODE');
  });

  it('a 404 with the generic code is still not found', () => {
    const info = classifyControllerError({
      httpStatus: 404, body: xhtml(-1073414146, 'Resource not found code:-1073414146 icode:-1'), method: 'GET', path: '/rw/rapid/tasks/T_ROB9',
    });
    expect(info.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('resetRapid says "no main routine" only for a 404, never for another refusal', async () => {
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
    const refused = new RwsError('Resource does not exist on the controller: HTTP 400', 'RESOURCE_NOT_FOUND', 400, undefined, -1073414146, RESETPP_MSG);
    m.adapter = {
      requestMastership: async () => {}, releaseMastership: async () => {},
      resetRapid: async () => { throw refused; },
    };
    m._state.tasks = [{ name: 'T_ROB1', active: true }];
    const e = await mgr.resetRapid().then(() => null, (x: unknown) => x as RwsError);
    expect(e?.message).not.toMatch(/has no main routine/);

    const notFound = new RwsError('Resource does not exist', 'RESOURCE_NOT_FOUND', 404);
    (m.adapter as Record<string, unknown>).resetRapid = async () => { throw notFound; };
    const e404 = await mgr.resetRapid().then(() => null, (x: unknown) => x as RwsError);
    expect(e404?.message).toMatch(/has no main routine/);
  });
});

describe('item 2: the RWS 1.0 mode-selector lock and unlock refusals name the lock', () => {
  for (const action of ['lock', 'unlock']) {
    it(`?action=${action}: the sentence names the ${action} of the mode selector, not a mode change`, () => {
      const info = classifyControllerError({
        httpStatus: 403, body: xhtml(-1073445867, 'The required option is missing code:-1073445867 icode:-7701'),
        method: 'POST', path: `/rw/panel/opmode?action=${action}`, context: { generation: 'rw6', robot: 'IRB1600_6_120_6' },
      });
      expect(info.refusal?.kind).toBe('option-missing');
      expect(info.refusal?.sentence).toMatch(/lock or unlock the operating-mode selector/);
      expect(info.refusal?.sentence).not.toMatch(/change the operating mode/);
    });
  }

  it('RWS 2.0 /rw/panel/opmode/lock is named the same way; a plain opmode write still says change the operating mode', () => {
    const lock = classifyControllerError({
      httpStatus: 403, body: xhtml(-1073445867, 'The required option is missing'), method: 'POST', path: '/rw/panel/opmode/lock',
      context: { generation: 'rw7' },
    });
    expect(lock.refusal?.sentence).toMatch(/lock or unlock the operating-mode selector/);
    const change = classifyControllerError({
      httpStatus: 403, body: xhtml(-1073445867, 'The required option is missing'), method: 'POST', path: '/rw/panel/opmode',
      context: { generation: 'rw7' },
    });
    expect(change.refusal?.sentence).toMatch(/change the operating mode/);
  });
});
