/**
 * Offline checks of the guard kinds and helpers the virtual-controller tests
 * rely on (09-motion's manual-mode tests, 14-vc-sim-panel): the simulated
 * panel only ever goes to an RWS 2.0 controller that identifies as virtual,
 * manual mode only to lanes the person running the suite listed, and the
 * helpers release what a test engaged. Nothing here reaches a controller;
 * plain `npm test` runs it (the functional runner only runs the files
 * directly in tests/functional).
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { JointTarget, RobotManager } from '../../../src/index.js';
import { allowed, isVirtualIdentity } from './guard.js';
import type { PanelState } from './state.js';
import { followPanel, nothingEngaged, releaseSimPanel, teleportJoints, withinMotionLimits } from './vc.js';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

const joints = (a: number[]): JointTarget => ({ rax_1: a[0], rax_2: a[1], rax_3: a[2], rax_4: a[3], rax_5: a[4], rax_6: a[5] });

describe('guard: vc-sim', () => {
  it('refuses RWS 1.0 with the reason the lane skips with', () => {
    expect(allowed('vc-sim', 'rw6', { virtual: true, identityType: 'VIRTUAL_CONTROLLER' }))
      .toEqual({ ok: false, reason: 'RWS 1.0 has no simulation endpoints' });
  });

  it('allows an RWS 2.0 lane only when the controller identifies as virtual', () => {
    for (const lane of ['rw7', 'rw8'] as const) {
      expect(allowed('vc-sim', lane).ok).toBe(false);
      expect(allowed('vc-sim', lane, { virtual: null, identityType: null }).ok).toBe(false);
      const real = allowed('vc-sim', lane, { virtual: false, identityType: 'REAL_CONTROLLER' });
      expect(real.ok).toBe(false);
      expect(real.reason).toMatch(/REAL_CONTROLLER/);
      expect(allowed('vc-sim', lane, { virtual: true, identityType: 'VIRTUAL_CONTROLLER' }).ok).toBe(true);
    }
  });

  it('reads an identity type as virtual only when it says virtual and not real', () => {
    expect(isVirtualIdentity('VIRTUAL_CONTROLLER')).toBe(true);
    expect(isVirtualIdentity('Virtual Controller')).toBe(true);
    expect(isVirtualIdentity('REAL_CONTROLLER')).toBe(false);
    expect(isVirtualIdentity('Real Controller')).toBe(false);
    expect(isVirtualIdentity('')).toBe(false);
    expect(isVirtualIdentity(null)).toBe(false);
    expect(isVirtualIdentity(undefined)).toBe(false);
  });
});

describe('guard: manual-mode and rmmp-manual', () => {
  it('allows manual mode only on the lanes RWS_FUNCTIONAL_ALLOW_MANUAL lists', () => {
    delete process.env.RWS_FUNCTIONAL_ALLOW_MANUAL;
    for (const lane of ['rw6', 'rw7', 'rw8'] as const) {
      const d = allowed('manual-mode', lane);
      expect(d.ok).toBe(false);
      expect(d.reason).toContain(`RWS_FUNCTIONAL_ALLOW_MANUAL=${lane}`);
    }
    process.env.RWS_FUNCTIONAL_ALLOW_MANUAL = 'rw7,rw8';
    expect(allowed('manual-mode', 'rw6').ok).toBe(false);
    expect(allowed('manual-mode', 'rw7').ok).toBe(true);
    const rw8 = allowed('manual-mode', 'rw8');
    expect(rw8.ok).toBe(true);
    expect(rw8.reason).toMatch(/Allow remote access in manual mode/);
    expect(rw8.reason).toMatch(/allow-motion-control/);
  });

  it('allows one RMMP request only on RobotWare 7 under the manual opt-in', () => {
    delete process.env.RWS_FUNCTIONAL_ALLOW_MANUAL;
    expect(allowed('rmmp-manual', 'rw7').ok).toBe(false);
    process.env.RWS_FUNCTIONAL_ALLOW_MANUAL = 'rw6,rw7,rw8';
    const rw6 = allowed('rmmp-manual', 'rw6');
    expect(rw6.ok).toBe(false);
    expect(rw6.reason).toMatch(/never requests RMMP/);
    expect(allowed('rmmp-manual', 'rw7').ok).toBe(true);
    expect(allowed('rmmp-manual', 'rw8').ok).toBe(false);
  });

  it('allows RobotWare 8 motion control only for the virtual controller whose system name RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL names', () => {
    const vc = { systemName: 'IRB1600_6_120', virtual: true, identityType: 'VirtualController' };
    delete process.env.RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL;
    const off = allowed('motion-control', 'rw8', vc);
    expect(off.ok).toBe(false);
    expect(off.reason).toContain('RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<its system name');
    // The manual opt-in does not stand in for it.
    process.env.RWS_FUNCTIONAL_ALLOW_MANUAL = 'rw8';
    expect(allowed('motion-control', 'rw8', vc).ok).toBe(false);
    // A left-over value that names no controller allows nothing.
    for (const leftOver of ['1', 'rw8', 'rw6,rw7,rw8']) {
      process.env.RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL = leftOver;
      expect(allowed('motion-control', 'rw8', vc).ok, leftOver).toBe(false);
    }
    process.env.RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL = 'IRB1600_6_120';
    const on = allowed('motion-control', 'rw8', vc);
    expect(on.ok).toBe(true);
    expect(on.reason).toMatch(/withdraws it/);
    // Another controller, a system name not read, a controller that is not virtual.
    expect(allowed('motion-control', 'rw8', { ...vc, systemName: 'CRB_15000' }).reason).toMatch(/names 'IRB1600_6_120'.*reads 'CRB_15000'/);
    expect(allowed('motion-control', 'rw8', { ...vc, systemName: null }).ok).toBe(false);
    expect(allowed('motion-control', 'rw8', {}).ok).toBe(false);
    const real = allowed('motion-control', 'rw8', { ...vc, virtual: false, identityType: 'RealController' });
    expect(real.ok).toBe(false);
    expect(real.reason).toMatch(/virtual controllers only/);
    for (const lane of ['rw6', 'rw7'] as const) {
      const d = allowed('motion-control', lane, vc);
      expect(d.ok).toBe(false);
      expect(d.reason).toMatch(/no control stations/);
    }
  });

  it('keeps the general opmode switch and a bare RMMP request refused, with reasons that name the opt-in paths', () => {
    process.env.RWS_FUNCTIONAL_ALLOW_MANUAL = 'rw6,rw7,rw8';
    const opmode = allowed('opmode', 'rw8');
    expect(opmode.ok).toBe(false);
    expect(opmode.reason).toMatch(/UAS_ALLOW_REMOTE_ACCESS_IN_MAN_MODE/);
    expect(opmode.reason).toMatch(/manual-mode/);
    for (const lane of ['rw6', 'rw7', 'rw8'] as const) {
      const d = allowed('rmmp-request', lane);
      expect(d.ok).toBe(false);
      expect(d.reason).toMatch(/rmmp-manual/);
    }
  });
});

describe('virtual-controller helpers', () => {
  it('writes teleport joints without exponent notation or a negative zero, and refuses a non-finite value', () => {
    const j = teleportJoints(joints([1.98e-16, -1e-9, 12.3456789, -45.0000004, 30, -0]));
    expect(j).toEqual([0, 0, 12.345679, -45, 30, 0]);
    for (const v of j) { expect(String(v)).not.toMatch(/e/i); expect(Object.is(v, -0)).toBe(false); }
    expect(() => teleportJoints(joints([0, 0, 0, 0, Number.NaN, 0]))).toThrow(/axis 5/);
  });

  it('accepts a return move only inside the motion limits', () => {
    expect(withinMotionLimits([5, 0, 0, 10, 0, -10])).toBe(true);
    expect(withinMotionLimits([5.6, 0, 0, 0, 0, 0])).toBe(false);
    expect(withinMotionLimits([0, 0.6, 0, 0, 0, 0])).toBe(false);
    expect(withinMotionLimits([0, 0, 0, 0, 0, 10.6])).toBe(false);
  });

  it('follows the panel: records changes only, and needs the condition to hold for stableMs', async () => {
    const states = ['motoron', 'motoron', 'emergencystop', 'motoroff', 'motoroff', 'motoroff', 'motoroff', 'motoroff'];
    let i = 0;
    const panel = async (): Promise<PanelState> => ({
      opmode: 'AUTO', ctrlstate: states[Math.min(i++, states.length - 1)], speedRatio: 100, execstate: 'stopped',
    });
    const trail = await followPanel(panel, { until: p => p.ctrlstate === 'motoroff', stableMs: 20, timeoutMs: 2_000, pollMs: 10 });
    expect(trail.met).toBe(true);
    expect(trail.seen.map(s => s.ctrlstate)).toEqual(['motoron', 'emergencystop', 'motoroff']);

    const never = await followPanel(panel, { until: () => false, timeoutMs: 50, pollMs: 10 });
    expect(never.met).toBe(false);
    expect(never.last.ctrlstate).toBe('motoroff');
  });

  it('releases only what was engaged, enable switch first, keeping a failed release flagged', async () => {
    const calls: string[] = [];
    const m = {
      simEnableSwitch: async (on: boolean) => { calls.push(`enable ${on}`); },
      simResetEmergencyStop: async () => { calls.push('estop reset'); },
      simGeneralStop: async (engage: boolean) => { calls.push(`general ${engage}`); throw new Error('refused'); },
      simAutoStop: async (engage: boolean) => { calls.push(`auto ${engage}`); },
    } as unknown as RobotManager;
    const engaged = { ...nothingEngaged(), enableSwitch: true, generalStop: true };
    const steps = await releaseSimPanel(m, engaged);
    expect(calls).toEqual(['enable false', 'general false']);
    expect(steps.map(s => [s.step, s.ok])).toEqual([['enable switch released', true], ['general stop released', false]]);
    expect(engaged).toEqual({ enableSwitch: false, emergencyStop: false, generalStop: true, autoStop: false });
    expect(await releaseSimPanel(m, nothingEngaged())).toEqual([]);
  });
});
