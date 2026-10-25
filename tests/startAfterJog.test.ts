import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { classifyControllerError } from '../src/ControllerError.js';
import { refusalFor } from '../src/refusal.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type JogParams } from '../src/types.js';

/**
 * A RAPID start or step sent right after a jog.
 *
 * RobotManager.jog keeps its own motion hold (RobotWare 8: write access) until
 * 2 s after the last jog. ABB's RWS start page says a start needs edit
 * mastership and does not succeed while the client holds motion mastership,
 * and RobotWare 7 refused a start sent under a motion hold this session had
 * requested with 500 -1073445844. So on RobotWare 6 and 7, where motion is a
 * lock of its own, a start (and on RobotWare 7 a step; RobotWare 6 has none)
 * ends the jog's own idle hold first, inside the same write turn as the start,
 * and no release fires 2 s later. A motion hold the caller took with
 * requestMastership('motion') or requestMastershipAll() stays the caller's. On
 * RobotWare 8 motion and RAPID are one write-access lock: the start reuses it
 * and nothing is released before it.
 *
 * Same harness as the jog tests: RobotWare 6 is a plain adapter object (the
 * manager keeps an access manager over its request and release calls);
 * RobotWare 7 and 8 are real RWS2Adapters whose transport is a recorder, so
 * mastership, write access and the start show on the wire as sent. The jog
 * pre-flight reads and the jog request itself are recorded stand-ins.
 */

const JOG: JogParams = { mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 };
const START = 'POST /rw/rapid/execution/start';
const MOTION_REQUEST = 'POST /rw/mastership/motion/request';
const MOTION_RELEASE = 'POST /rw/mastership/motion/release';
const EDIT_REQUEST = 'POST /rw/mastership/edit/request';
const EDIT_RELEASE = 'POST /rw/mastership/edit/release';
const REGISTER = 'POST /rw/controlstation/register/remote';
const WA_REQUEST = 'POST /rw/controlstation/writeaccess/request';
const WA_RELEASE = 'POST /rw/controlstation/writeaccess/release';
const PREFLIGHT_RW7 = ['read opmode', 'read ctrlstate'];

const hal = (type: string, fields: Record<string, string>): string =>
  JSON.stringify({ _links: { base: { href: 'https://x/' } }, state: [{ _type: type, _title: 'rmmp', ...fields }] });

/** The controller's refusal of a start while this session holds motion, as captured on RobotWare 7. */
function motionHeldRefusal(): RwsError {
  const file = path.join(__dirname, 'fixtures', 'errors', 'rws2', '500-exec-start-motion-mastership-held-haljson.json');
  const f = JSON.parse(fs.readFileSync(file, 'utf8')) as { response: { status: number; body: string } };
  const info = classifyControllerError({ httpStatus: f.response.status, body: f.response.body, method: 'POST', path: '/rw/rapid/execution/start', fallback: 'UNKNOWN' });
  return new RwsError(info.message, info.code, f.response.status, info.controllerMsg ?? undefined,
    info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
}

/** RobotWare 6: a plain adapter, every call recorded. */
function rw6() {
  const wire: string[] = [];
  const adapter = {
    requestMastership: async (d: string) => { wire.push(`request ${d}`); },
    releaseMastership: async (d: string) => { wire.push(`release ${d}`); },
    getOperationMode: async () => { wire.push('read opmode'); return 'MANR'; },
    getControllerState: async () => { wire.push('read ctrlstate'); return 'motoron'; },
    getRmmpPrivilege: async () => { wire.push('read rmmp'); return 'modify'; },
    jog: async () => { wire.push('JOG'); },
    startRapid: async () => { wire.push('START'); },
    disconnect: async () => { wire.push('logout'); },
  };
  return { adapter, wire };
}

/**
 * RobotWare 7/8: a real RWS2Adapter over a recorder. A start or step shows as
 * `POST /rw/rapid/execution/start` plus its execmode when it is a step. The
 * controller holds motion for this session while `motionHeld()` says so, and
 * then refuses a start the way RobotWare 7 did.
 */
function rws2(generation: 'rw7' | 'rw8') {
  const wire: string[] = [];
  let motion = false;
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  a.req = async (method: string, at: string, fields?: Record<string, string>) => {
    const step = at === '/rw/rapid/execution/start' && fields?.execmode && fields.execmode !== 'continue' ? ` ${fields.execmode}` : '';
    wire.push(`${method} ${at}${step}`);
    if (at === '/rw/mastership/motion/request' || at === '/rw/mastership/request') { motion = true; }
    if (at === '/rw/mastership/motion/release' || at === '/rw/mastership/release') { motion = false; }
    if (method === 'POST' && at === '/rw/rapid/execution/start' && motion) { throw motionHeldRefusal(); }
    if (method === 'GET' && at === '/users/rmmp') { return hal('user-rmmp', { privilege: 'modify', rmmpheldbyme: 'true' }); }
    return '';
  };
  a.getOperationMode = async () => { wire.push('read opmode'); return 'MANR'; };
  a.getControllerState = async () => { wire.push('read ctrlstate'); return 'motoron'; };
  // Motion control as a new session finds it at the registration, not allowed (one standing
  // there is withdrawn: the lifecycle suite's test 19), then declared, as a person allows it in
  // this session.
  let declared = false;
  a.getAllowMotionControl = async () => { wire.push('read motion control'); const v = declared; declared = true; return v; };
  a.jog = async () => { wire.push('JOG'); };
  return { adapter, wire };
}

function manager(adapter: unknown): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
  m.adapter = adapter;
  Object.assign(m._state, { connected: true, opmode: 'MANR', ctrlstate: 'motoron' });
  return mgr;
}

const jogTimer = (mgr: RobotManager): unknown => (mgr as unknown as { jogReleaseTimer: unknown }).jogReleaseTimer;
const count = (wire: string[], entry: string): number => wire.filter(w => w === entry).length;

beforeEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });
afterEach(() => { vi.useRealTimers(); });

describe('RobotWare 6 and 7: a start right after a jog ends the jog\'s own motion hold first', () => {
  it('RobotWare 7: startRapid releases motion before it takes edit and starts; no release fires 2 s later', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    await mgr.startRapid();
    expect(wire).toEqual([
      ...PREFLIGHT_RW7, MOTION_REQUEST, 'JOG',
      MOTION_RELEASE, EDIT_REQUEST, START, EDIT_RELEASE,
    ]);
    expect(jogTimer(mgr)).toBeNull();
    await vi.advanceTimersByTimeAsync(2500);
    expect(count(wire, MOTION_RELEASE)).toBe(1);
    expect(wire.at(-1)).toBe(EDIT_RELEASE);
    expect(mgr.state.access.locks.every(l => l.count === 0)).toBe(true);
  });

  it('RobotWare 7: stepRapid does the same, since a step is a start with a step execmode', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    await mgr.stepRapid('T_ROB1', 'into');
    expect(wire).toEqual([
      ...PREFLIGHT_RW7, MOTION_REQUEST, 'JOG',
      MOTION_RELEASE, EDIT_REQUEST, `${START} stepin`, EDIT_RELEASE,
    ]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(count(wire, MOTION_RELEASE)).toBe(1);
    expect(jogTimer(mgr)).toBeNull();
  });

  it('RobotWare 6: the jog\'s motion is released before RAPID mastership is requested for the start', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rw6();
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    await mgr.startRapid();
    expect(wire).toEqual([
      'read opmode', 'read ctrlstate', 'request motion', 'JOG',
      'release motion', 'request rapid', 'START', 'release rapid',
    ]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(count(wire, 'release motion')).toBe(1);
    expect(jogTimer(mgr)).toBeNull();
  });

  it('RobotWare 6 (the RWS 1.0 adapter has no step): stepRapid after a jog is refused before it sends or releases anything', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rw6();
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    wire.length = 0;
    await expect(mgr.stepRapid('T_ROB1', 'into')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(wire).toEqual([]);
    // The jog's own hold is untouched and still ends 2 s after the jog.
    expect(jogTimer(mgr)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2100);
    expect(wire).toEqual(['release motion']);
  });

  it('a jog asked for while the start runs waits for it: motion is not taken again between the release and the start', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    wire.length = 0;
    const start = mgr.startRapid();
    const jog = mgr.jog(JOG);
    await Promise.all([start, jog]);
    expect(wire).toEqual([
      MOTION_RELEASE, EDIT_REQUEST, START, EDIT_RELEASE,
      ...PREFLIGHT_RW7, MOTION_REQUEST, 'JOG',
    ]);
    // The second jog's hold is the jog's own again, ended 2 s after it.
    await vi.advanceTimersByTimeAsync(2100);
    expect(wire.at(-1)).toBe(MOTION_RELEASE);
  });

  it('with no jog before it, a start sends no motion release', async () => {
    const { adapter, wire } = rws2('rw7');
    await manager(adapter).startRapid();
    expect(wire).toEqual([EDIT_REQUEST, START, EDIT_RELEASE]);
  });

  it('a jog hold that already ended (the 2 s passed) is not released again by the start', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    await vi.advanceTimersByTimeAsync(2100);
    await mgr.startRapid();
    expect(count(wire, MOTION_RELEASE)).toBe(1);
    expect(wire.slice(-3)).toEqual([EDIT_REQUEST, START, EDIT_RELEASE]);
  });
});

describe('a motion hold the caller took stays the caller\'s', () => {
  it('RobotWare 7: inside requestMastership(\'motion\') the start releases nothing of it, and the controller\'s refusal says why', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.requestMastership('motion');
    await mgr.jog(JOG);
    const err = await mgr.startRapid().then(() => null, (e: unknown) => e as RwsError);
    expect(wire).toEqual([MOTION_REQUEST, ...PREFLIGHT_RW7, 'JOG', EDIT_REQUEST, START, EDIT_RELEASE]);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445844 });
    expect(err!.refusal).toMatchObject({ kind: 'motion-held', grantor: 'this-tool' });
    expect(err!.refusal!.sentence).toContain('requestMastership(\'motion\')');
    expect(err!.refusal!.fix).toContain('releaseMastership(\'motion\')');
    expect(err!.refusal!.fix).toContain('releaseMastership(\'motion\') after requestMastership(\'motion\')');
    expect(err!.refusal!.sentence).not.toMatch(/2 s of a jog/);
    // The caller's hold is still counted, and only its release ends it.
    await vi.advanceTimersByTimeAsync(2500);
    expect(count(wire, MOTION_RELEASE)).toBe(0);
    await mgr.releaseMastership('motion');
    expect(wire.at(-1)).toBe(MOTION_RELEASE);
    await mgr.startRapid();
    expect(wire.slice(-3)).toEqual([EDIT_REQUEST, START, EDIT_RELEASE]);
  });

  it('RobotWare 7: inside requestMastershipAll() the start releases no motion either', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.requestMastershipAll();
    await mgr.jog(JOG);
    await expect(mgr.startRapid()).rejects.toMatchObject({ code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445844 });
    expect(count(wire, MOTION_RELEASE)).toBe(0);
    await mgr.releaseMastershipAll();
  });

  it('RobotWare 7: a requestMastershipAll() hold ends with releaseMastershipAll(), not releaseMastership(\'motion\'), and the refusal pairs them so', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.requestMastershipAll();
    const err = await mgr.startRapid().then(() => null, (e: unknown) => e as RwsError);
    expect(err!.refusal!.kind).toBe('motion-held');
    expect(err!.refusal!.fix).toContain('releaseMastershipAll() after requestMastershipAll()');
    expect(err!.refusal!.sentence).toContain('releaseMastershipAll() after requestMastershipAll()');
    // releaseMastership('motion') finds no hold of its own on motion: the
    // all-domains hold stays, nothing is released, and the start is refused again.
    wire.length = 0;
    await mgr.releaseMastership('motion');
    expect(wire).toEqual([]);
    await expect(mgr.startRapid()).rejects.toMatchObject({ controllerCode: -1073445844 });
    // The paired release ends it, and the start then goes through.
    await mgr.releaseMastershipAll();
    wire.length = 0;
    await mgr.startRapid();
    expect(wire).toEqual([EDIT_REQUEST, START, EDIT_RELEASE]);
  });

  it('RobotWare 6: inside requestMastership(\'motion\') the start sends no motion release', async () => {
    const { adapter, wire } = rw6();
    const mgr = manager(adapter);
    await mgr.requestMastership('motion');
    await mgr.jog(JOG);
    await mgr.startRapid();
    expect(wire).toEqual([
      'request motion', 'read opmode', 'read ctrlstate', 'JOG',
      'request rapid', 'START', 'release rapid',
    ]);
    await mgr.releaseMastership('motion');
    expect(wire.at(-1)).toBe('release motion');
  });
});

describe('RobotWare 8: motion and RAPID are one write-access lock', () => {
  it('a start after a jog reuses the jog\'s write access: no release, no second request before the start', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw8');
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    await mgr.startRapid();
    // The registration reads the motion-control allowance once; the jog reads it again.
    expect(wire).toEqual(['read opmode', 'read ctrlstate', REGISTER, 'read motion control', WA_REQUEST, 'read motion control', 'JOG', START]);
    // The jog's own hold ends 2 s after the last jog, as it does without a start.
    await vi.advanceTimersByTimeAsync(2100);
    expect(wire.at(-1)).toBe(WA_RELEASE);
    expect(count(wire, WA_RELEASE)).toBe(1);
  });

  it('a step after a jog does the same', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw8');
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    await mgr.stepRapid('T_ROB1', 'over');
    expect(wire.slice(-2)).toEqual(['JOG', `${START} stepover`]);
    expect(count(wire, WA_RELEASE)).toBe(0);
    await vi.advanceTimersByTimeAsync(2100);
    expect(count(wire, WA_RELEASE)).toBe(1);
  });
});

describe('the motion-held refusal describes the case that remains', () => {
  it('names a hold the caller took and how to end it, not the jog', () => {
    const r = refusalFor(
      { http: 500, code: -1073445844, msg: 'ERROR: org_code: -2302 new_code: 0xc004842c;', method: 'POST', path: '/rw/rapid/execution/start' },
      { generation: 'rw7' },
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe('MASTERSHIP_REQUIRED');
    expect(r!.refusal.kind).toBe('motion-held');
    expect(r!.refusal.sentence).toMatch(/holds motion mastership/);
    expect(r!.refusal.sentence).toContain('requestMastership(\'motion\')');
    expect(r!.refusal.sentence).not.toMatch(/2 s of a jog/);
    expect(r!.refusal.fix).toContain('releaseMastership(\'motion\')');
  });

  it('pairs each release with the call that took the hold', () => {
    const r = refusalFor(
      { http: 500, code: -1073445844, msg: 'ERROR: org_code: -2302 new_code: 0xc004842c;', method: 'POST', path: '/rw/rapid/execution/start' },
      { generation: 'rw7' },
    );
    for (const text of [r!.refusal.fix, r!.refusal.sentence]) {
      expect(text).toContain('releaseMastership(\'motion\') after requestMastership(\'motion\')');
      expect(text).toContain('releaseMastershipAll() after requestMastershipAll()');
      expect(text).not.toMatch(/releaseMastership\('motion'\) or releaseMastershipAll\(\)/);
    }
  });
});
