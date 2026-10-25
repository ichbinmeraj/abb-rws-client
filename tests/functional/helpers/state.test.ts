/**
 * Offline checks of the harness restore around a pending change of operating
 * mode and the RobotWare 8 motion-control declaration, over a fake observer
 * and a fake manager that record every write. Nothing here reaches a
 * controller; plain `npm test` runs it (the functional runner only runs the
 * files directly in tests/functional).
 *
 * What the restore must do, from the 2026-09-30 runs on RW 7.21.4 and 8.2.1:
 * - a controller that reads AUTO_CH (a switch to Auto waiting for the
 *   confirmation at the FlexPendant) is never sent the switch again: a
 *   resend does not confirm it (RW 7.21.4 answered 500), so restore reports
 *   it instead;
 * - on RobotWare 8 in AUTO_CH no remote station can take write access, so
 *   restore writes nothing at all then;
 * - a declaration left true where the baseline read false is put back to
 *   false under write access, before the operation mode.
 */

import { describe, it, expect, vi } from 'vitest';
import { RWS2Adapter, type IRWSAdapter, type RobotManager } from '../../../src/index.js';
import { diffSnapshots, isPendingModeChange, restoreState, type StateSnapshot, type StateTarget } from './state.js';

vi.mock('./trace.js', () => ({ harnessNote: () => {} }));

interface Controller {
  opmode: string;
  ctrlstate: string;
  speedRatio: number;
  allowMotionControl: boolean;
}

function baseline(lane: 'rw7' | 'rw8', over: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    lane, takenAt: '', opmode: 'AUTO', ctrlstate: 'motoroff', speedRatio: 100, execstate: 'stopped', execCycle: 'forever',
    tasks: [{ name: 'T_ROB1', active: true, motiontask: true }], modulesByTask: { T_ROB1: ['BASE'] }, programPointers: {},
    joints: null, probeEntries: [], probeQueues: [], allowMotionControl: lane === 'rw8' ? false : null, errors: [], ...over,
  };
}

/** A fake lane: the observer reads `c`; the manager records its writes in `writes`. */
function lane(name: 'rw7' | 'rw8', c: Controller) {
  const writes: string[] = [];
  const observer = {
    getOperationMode: async () => c.opmode,
    getControllerState: async () => c.ctrlstate,
    getSpeedRatio: async () => c.speedRatio,
    getRapidExecutionState: async () => 'stopped',
    getRapidExecutionInfo: async () => ({ state: 'stopped', cycle: 'forever' }),
    getRapidTasks: async () => [{ name: 'T_ROB1', active: true, motiontask: true }],
    getJointPositions: async () => { throw new Error('not read here'); },
    listModules: async () => ['BASE'],
    listDirectory: async () => [],
  } as unknown as IRWSAdapter;
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.getAllowMotionControl = async () => c.allowMotionControl;
  a.setAllowMotionControl = async (v: boolean) => { writes.push(`allow-motion-control ${v}`); c.allowMotionControl = v; };
  const manager = {
    adapter,
    state: { connected: true, access: { locks: [] } },
    setOperationMode: async (mode: string) => { writes.push(`opmode ${mode}`); c.opmode = mode; },
    setSpeedRatio: async (r: number) => { writes.push(`speed ratio ${r}`); c.speedRatio = r; },
    // As RW 7.21.4 answered on 2026-10-22: refused (403) inside a guard stop.
    setMotorsOn: async () => {
      if (c.ctrlstate === 'guardstop') { writes.push('motors on refused'); throw new Error('403 SYS_CTRL_E_REJECT'); }
      writes.push('motors on'); c.ctrlstate = 'motoron';
    },
    requestMastership: async (d: string) => { writes.push(`request ${d}`); },
    releaseMastership: async (d: string) => { writes.push(`release ${d}`); },
  } as unknown as RobotManager;
  const target: StateTarget = {
    lane: name, generation: 'rws2',
    connectedManager: () => manager,
    ensureManager: async () => manager,
    observer: async () => observer,
  };
  return { target, writes };
}

describe('restore with a switch to Auto waiting at the FlexPendant', () => {
  it('reads a pending change only for the _CH modes', () => {
    expect(isPendingModeChange('AUTO_CH')).toBe(true);
    expect(isPendingModeChange('MANF_CH')).toBe(true);
    expect(isPendingModeChange('AUTO')).toBe(false);
    expect(isPendingModeChange('MANR')).toBe(false);
    expect(isPendingModeChange(null)).toBe(false);
  });

  it('RobotWare 7 in AUTO_CH: the other differences are put back, the switch is not sent again, and the wait is reported', async () => {
    const c: Controller = { opmode: 'AUTO_CH', ctrlstate: 'motoroff', speedRatio: 50, allowMotionControl: false };
    const { target, writes } = lane('rw7', c);
    const report = await restoreState(target, baseline('rw7'));
    expect(writes).toEqual(['speed ratio 100']);
    expect(report.ok).toBe(false);
    expect(report.residual).toEqual([
      expect.stringMatching(/^operation mode reads AUTO_CH: the switch waits for the confirmation at the FlexPendant - confirm it there/),
      'opmode AUTO_CH, expected AUTO',
    ]);
  });

  it('RobotWare 8 in AUTO_CH: nothing is written at all, and why is reported', async () => {
    const c: Controller = { opmode: 'AUTO_CH', ctrlstate: 'guardstop', speedRatio: 50, allowMotionControl: true };
    const { target, writes } = lane('rw8', c);
    const report = await restoreState(target, baseline('rw8', { ctrlstate: 'guardstop' }));
    expect(writes).toEqual([]);
    expect(report.actions).toEqual([]);
    expect(report.residual[0]).toMatch(/^the controller reads AUTO_CH: .* RobotWare 8 gives no remote station write access, so nothing was written/);
    expect(report.residual).toContain('opmode AUTO_CH, expected AUTO');
    expect(report.residual).toContain('speed ratio 50, expected 100');
  });
});

describe('restore after a teleport left RobotWare 7 in guard stop', () => {
  it('reads the panel until the guard stop has cleared and held, then sends motors on once', async () => {
    const c: Controller = { opmode: 'AUTO', ctrlstate: 'guardstop', speedRatio: 100, allowMotionControl: false };
    // A teleport's guard stop: motors off by itself shortly after (about 5 s on RW 7.21.4; shortened here).
    setTimeout(() => { c.ctrlstate = 'motoroff'; }, 300);
    const { target, writes } = lane('rw7', c);
    const t0 = Date.now();
    const report = await restoreState(target, baseline('rw7', { ctrlstate: 'motoron' }));
    expect(writes).toEqual(['motors on']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);   // motors off held 2 s first
    expect(report.actions.map(a => [a.step, a.ok])).toEqual([['motors on', true]]);
    expect(report.residual).toEqual([]);
  }, 15_000);
});

describe('the RobotWare 8 motion-control declaration', () => {
  it('a declaration left true is put back to false under write access, before the operation mode', async () => {
    const c: Controller = { opmode: 'MANR', ctrlstate: 'guardstop', speedRatio: 100, allowMotionControl: true };
    const { target, writes } = lane('rw8', c);
    const report = await restoreState(target, baseline('rw8', { ctrlstate: 'guardstop' }));
    expect(writes).toEqual(['request rapid', 'allow-motion-control false', 'release rapid', 'opmode AUTO']);
    expect(report.actions.map(a => [a.step, a.ok])).toEqual([
      ['allow-motion-control true -> false', true],
      ['operation mode MANR -> AUTO', true],
    ]);
    expect(report.residual).toEqual([]);
    expect(c.allowMotionControl).toBe(false);
  });

  it('is compared in the unsafe direction only, and never when unread', () => {
    const base = baseline('rw8');
    expect(diffSnapshots(base, { ...base, allowMotionControl: true }))
      .toEqual(['allow-motion-control true, expected false (a motion-control declaration left behind for the suite\'s station)']);
    expect(diffSnapshots({ ...base, allowMotionControl: true }, { ...base, allowMotionControl: false })).toEqual([]);
    expect(diffSnapshots({ ...base, allowMotionControl: null }, { ...base, allowMotionControl: true })).toEqual([]);
    expect(diffSnapshots(base, { ...base, allowMotionControl: null })).toEqual([]);
  });
});
