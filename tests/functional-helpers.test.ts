/**
 * Offline checks of the functional-test helpers' pure parts: the safety guard,
 * the RAPID generators' limits, lane classification, trace scrubbing and the
 * snapshot diff. The live suite trusts these to keep motion small and
 * credentials out of the traces, so they are tested without a controller.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { allowed, checkJog, MOTION_LIMITS } from './functional/helpers/guard.js';
import { zzDataModule, zzExecModule, zzMotionModule, assertProbeModuleName, remoteModulePath } from './functional/helpers/rapid.js';
import { laneForVersion } from './functional/helpers/fleet.js';
import { scrubString, scrub } from './functional/helpers/trace.js';
import { diffSnapshots, type StateSnapshot } from './functional/helpers/state.js';
import { parseLaneList, TEST_PASS } from './functional/helpers/config.js';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe('functional guard', () => {
  it('allows motion and motors on RW6/RW7, and motion on RW8 only with motors already on', () => {
    expect(allowed('motion', 'rw6').ok).toBe(true);
    expect(allowed('motion', 'rw7').ok).toBe(true);
    expect(allowed('motion', 'rw8')).toEqual({ ok: false, reason: 'needs motors on from the RW8 pendant' });
    expect(allowed('motion', 'rw8', { ctrlstate: 'guardstop' }).ok).toBe(false);
    expect(allowed('motion', 'rw8', { ctrlstate: 'motoron' }).ok).toBe(true);
    expect(allowed('rapid-start', 'rw8', { ctrlstate: 'motoroff' }).ok).toBe(false);
    expect(allowed('motors', 'rw7').ok).toBe(true);
    expect(allowed('motors', 'rw8').ok).toBe(false);
    expect(allowed('motors-refusal', 'rw8').ok).toBe(true);
    expect(allowed('motors-refusal', 'rw6').ok).toBe(false);
    expect(allowed('opmode', 'rw8').ok).toBe(false);
    expect(allowed('opmode', 'rw6').ok).toBe(true);
  });

  it('restarts only lanes listed in RWS_FUNCTIONAL_ALLOW_RESTART, and never rw6 or rw8', () => {
    delete process.env.RWS_FUNCTIONAL_ALLOW_RESTART;
    expect(allowed('restart', 'rw7').ok).toBe(false);
    process.env.RWS_FUNCTIONAL_ALLOW_RESTART = 'rw7';
    expect(allowed('restart', 'rw7').ok).toBe(true);
    process.env.RWS_FUNCTIONAL_ALLOW_RESTART = 'rw6,rw7,rw8';
    expect(allowed('restart', 'rw6').ok).toBe(false);
    expect(allowed('restart', 'rw8').ok).toBe(false);
  });

  it('never allows the excluded operations on any lane', () => {
    for (const kind of ['backup-restore', 'cfg-write', 'cfg-load', 'uas-write', 'rmmp-request', 'safety-write', 'mastership-watchdog', 'diagnostics-save'] as const) {
      for (const lane of ['rw6', 'rw7', 'rw8'] as const) {
        expect(allowed(kind, lane).ok).toBe(false);
      }
    }
  });

  it('accepts only one-axis Joint jogs in the Small increment', () => {
    expect(checkJog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 50], speed: 0 }).ok).toBe(true);
    expect(checkJog({ mode: 'Joint', axes: [0, 0, 0, -100, 0, 0], speed: 0, incMode: 'Small' }).ok).toBe(true);
    expect(checkJog({ mode: 'Cartesian', axes: [10, 0, 0, 0, 0, 0], speed: 0 }).ok).toBe(false);
    expect(checkJog({ mode: 'Joint', axes: [10, 10, 0, 0, 0, 0], speed: 0 }).ok).toBe(false);
    expect(checkJog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 0], speed: 0 }).ok).toBe(false);
    expect(checkJog({ mode: 'Joint', axes: [10, 0, 0, 0, 0, 0], speed: 0, incMode: 'Large' }).ok).toBe(false);
    expect(checkJog({ mode: 'Joint', axes: [MOTION_LIMITS.jogMaxValue + 1, 0, 0, 0, 0, 0], speed: 0 }).ok).toBe(false);
  });
});

describe('functional RAPID generators', () => {
  it('keeps motion inside the limits: MoveAbsJ relative to CJointT, fine, tool0, v100 or slower', () => {
    const m = zzMotionModule({ axis1Deg: 5, wristDeg: -10, speed: 'v50', loops: 2 });
    expect(m.name).toBe('ZZ_PROBE_MOTION');
    expect(m.text).toContain(`${m.symbols.start} := CJointT();`);
    expect(m.text).toContain(`${m.symbols.target}.robax.rax_1 := ${m.symbols.start}.robax.rax_1 + 5;`);
    expect(m.text).toContain(`${m.symbols.target}.robax.rax_4 := ${m.symbols.start}.robax.rax_4 - 10;`);
    expect(m.text).toContain(`MoveAbsJ ${m.symbols.target}, v50, fine, tool0;`);
    expect(m.text).toContain(`MoveAbsJ ${m.symbols.start}, v50, fine, tool0;`);
    expect(m.text).not.toMatch(/MoveL|MoveJ\s|robtarget/i);
    expect(() => zzMotionModule({ axis1Deg: 5.5 })).toThrow();
    expect(() => zzMotionModule({ wristDeg: 11 })).toThrow();
    expect(() => zzMotionModule({ speed: 'v200' as never })).toThrow();
    expect(() => zzMotionModule({ loops: MOTION_LIMITS.maxLoops + 1 })).toThrow();
  });

  it('never declares a global main, and prefixes every symbol with the module name', () => {
    for (const m of [zzDataModule(), zzExecModule(), zzMotionModule()]) {
      expect(m.text).not.toMatch(/PROC\s+main\s*\(/i);
      expect(m.text.startsWith(`MODULE ${m.name}\n`)).toBe(true);
      for (const s of [...Object.values(m.symbols), ...Object.values(m.routines)]) {
        expect(s.startsWith(m.name.toLowerCase())).toBe(true);
        expect(s.length).toBeLessThanOrEqual(32);
      }
    }
    const long = zzDataModule({ name: 'ZZ_PROBE_ABCDEFGHIJKLMNO' });
    expect(long.name).toHaveLength(24);
    for (const s of Object.values(long.symbols)) { expect(s.length).toBeLessThanOrEqual(32); }
  });

  it('refuses module names outside ZZ_PROBE and places files per generation', () => {
    expect(() => assertProbeModuleName('Module1')).toThrow();
    expect(() => assertProbeModuleName('ZZ_PROBE_THIS_NAME_IS_TOO_LONG')).toThrow();
    expect(() => zzExecModule({ name: 'MainModule' })).toThrow();
    expect(remoteModulePath('rws1', 'ZZ_PROBE_X')).toBe('$HOME/ZZ_PROBE_X.mod');
    expect(remoteModulePath('rws2', 'ZZ_PROBE_X')).toBe('HOME/ZZ_PROBE_X.mod');
  });
});

describe('functional fleet and trace helpers', () => {
  it('classifies lanes by RobotWare major', () => {
    expect(laneForVersion('6.16.3007')).toBe('rw6');
    expect(laneForVersion('7.21.4+417')).toBe('rw7');
    expect(laneForVersion('8.2.1+1023')).toBe('rw8');
    expect(laneForVersion('5.15')).toBeNull();
    expect(laneForVersion('')).toBeNull();
    expect(parseLaneList(' rw7, RW8,foo ')).toEqual(['rw7', 'rw8']);
  });

  it('scrubs credentials, cookies and secret fields from trace lines', () => {
    expect(scrubString('Cookie: -http-session-=abc123; ABBCX=42')).not.toMatch(/abc123|=42/);
    expect(scrubString('Authorization: Basic RGVmYXVsdCBVc2VyOnJvYm90aWNz')).not.toContain('RGVmYXVsdCBVc2VyOnJvYm90aWNz');
    expect(scrubString('name=x&pincode=1234&control-station-id={A}')).toBe('name=x&pincode=***&control-station-id=***');
    expect(scrubString(`login with ${TEST_PASS}`)).not.toContain(TEST_PASS);
    expect(scrub({ path: '/rw/panel', cookie: 'x', nested: { password: 'y', ok: 'z' } }))
      .toEqual({ path: '/rw/panel', cookie: '***', nested: { password: '***', ok: 'z' } });
  });

  it('scrubs the test password from object keys too, keeping keys apart', () => {
    // A note keyed by a value: the key holds the password as a word.
    const keyed = { [`abb.${TEST_PASS}.feature`]: true, nested: { [`x ${TEST_PASS}`]: 1 }, path: '/rw/panel' };
    const out = scrub(keyed) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(TEST_PASS);
    expect(out['abb.***.feature']).toBe(true);
    expect(out['nested']).toEqual({ 'x ***': 1 });
    expect(out['path']).toBe('/rw/panel');
    // Two keys that scrub to the same text both survive.
    const twin = scrub({ [`a${TEST_PASS}`]: 1, 'a***': 2 }) as Record<string, unknown>;
    expect(Object.keys(twin)).toHaveLength(2);
    expect(Object.values(twin).sort()).toEqual([1, 2]);
    expect(JSON.stringify(twin)).not.toContain(TEST_PASS);
  });

  it('diffs snapshots on what restore can put back, with joints compared within tolerance', () => {
    const base: StateSnapshot = {
      lane: 'rw7', takenAt: '', opmode: 'AUTO', ctrlstate: 'motoroff', speedRatio: 100, execstate: 'stopped',
      execCycle: 'forever', tasks: [], modulesByTask: { T_ROB1: ['BASE', 'Module1'] }, programPointers: { T_ROB1: {} },
      joints: { rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 30, rax_6: 0 }, probeEntries: [], probeQueues: [], allowMotionControl: null, errors: [],
    };
    expect(diffSnapshots(base, { ...base, takenAt: 'later', errors: ['x'] })).toEqual([]);
    expect(diffSnapshots(base, { ...base, joints: { ...base.joints!, rax_1: 0.3 } })).toEqual([]);
    const moved = diffSnapshots(base, { ...base, joints: { ...base.joints!, rax_1: 2 } });
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^axis 1 /);
    const changed = diffSnapshots(base, {
      ...base, speedRatio: 50, execstate: 'running',
      modulesByTask: { T_ROB1: ['BASE', 'Module1', 'ZZ_PROBE_EXEC'] },
      probeEntries: [{ path: 'HOME/ZZ_PROBE_EXEC.mod', type: 'file' }],
    });
    expect(changed).toEqual([
      'speed ratio 50, expected 100',
      'execution running, expected stopped',
      'ZZ_PROBE_EXEC still loaded in T_ROB1',
      'HOME/ZZ_PROBE_EXEC.mod still on the controller',
    ]);
  });
});
