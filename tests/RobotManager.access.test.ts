import { describe, it, expect, afterEach, vi } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsClient } from '../src/RwsClient.js';
import { accessOf } from '../src/access/AccessManager.js';

/**
 * RobotManager's wraps, the adapters' own wraps and a caller's holds share
 * the session's one access manager, so no release of one ends another's
 * hold, and writes that take access run one at a time.
 *
 * The RWS 2.0 adapters here are real ones whose transport is replaced by a
 * recorder (no network), with the generation set the way connect() sets it
 * from the RobotWare version.
 */

type Hook = () => Promise<void>;

function rws2(generation: 'rw7' | 'rw8', hooks: Record<string, Hook> = {}) {
  const wire: string[] = [];
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  a.req = async (method: string, path: string) => {
    wire.push(`${method} ${path}`);
    await hooks[path]?.();
    return '';
  };
  // The jog request itself, and the pre-flight reads in front of it, are not
  // what these tests are about (the jog pre-flight has its own tests): the
  // reads say MANR, motors on, RMMP granted (RobotWare 7) and motion control
  // declared (RobotWare 8), and the jog is recorded.
  a.jog = async () => { wire.push('JOG'); };
  a.getOperationMode = async () => 'MANR';
  a.getControllerState = async () => 'motoron';
  a.getRmmpPrivilege = async () => 'modify';
  // Motion control as a new session finds it at the registration, not allowed (one standing
  // there is withdrawn: the lifecycle suite's test 19), then declared, as a person allows it in
  // this session.
  let declared = false;
  a.getAllowMotionControl = async () => { const v = declared; declared = true; return v; };
  // The execution-state read in front of unloadModule, loadProgram and
  // setPPToRoutine (which no longer stop a running program on their own) says
  // stopped; those checks have their own tests.
  a.getRapidExecutionState = async () => 'stopped';
  return { adapter, wire };
}

function manager(adapter: unknown): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
  m.adapter = adapter;
  m._state.opmode = 'MANR';
  m._state.ctrlstate = 'motoron';
  return mgr;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const JOG = { mode: 'Joint' as const, axes: [1, 0, 0, 0, 0, 0] as [number, number, number, number, number, number], speed: 10 };
const REGISTER = 'POST /rw/controlstation/register/remote';
const WA_REQUEST = 'POST /rw/controlstation/writeaccess/request';
const WA_RELEASE = 'POST /rw/controlstation/writeaccess/release';
const SPEED = 'POST /rw/panel/speedratio?action=setspeedratio';

afterEach(() => { vi.useRealTimers(); });

describe('RobotManager access: the jog idle release (RobotWare 8, one lock)', () => {
  it('the 2 s jog release sends nothing while an operation in progress holds the same write access', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const { adapter, wire } = rws2('rw8', { '/rw/panel/speedratio?action=setspeedratio': () => gate.promise });
    const mgr = manager(adapter);

    await mgr.jog(JOG);
    expect(wire).toEqual([REGISTER, WA_REQUEST, 'JOG']);

    const op = mgr.setSpeedRatio(50);               // takes the same (single) lock
    await vi.advanceTimersByTimeAsync(2100);          // the jog's idle release fires meanwhile
    expect(wire).toEqual([REGISTER, WA_REQUEST, 'JOG', SPEED]);

    gate.resolve();
    await op;
    // The one release is the operation's, after its write.
    expect(wire).toEqual([REGISTER, WA_REQUEST, 'JOG', SPEED, WA_RELEASE]);
  });

  it('a caller\'s hold taken after jogging takes the jog\'s hold over; the timer ends nothing', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw8');
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    await mgr.requestMastership('rapid');             // the same write access on RW8
    await vi.advanceTimersByTimeAsync(3000);
    expect(wire).toEqual([REGISTER, WA_REQUEST, 'JOG']);
    await mgr.releaseMastership('rapid');
    expect(wire).toEqual([REGISTER, WA_REQUEST, 'JOG', WA_RELEASE]);
  });

  it('jogs and writes inside a caller\'s hold request and release nothing of their own', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw8');
    const mgr = manager(adapter);
    await adapter.requestWriteAccess();               // straight on the adapter: the same count
    await mgr.jog(JOG);
    await mgr.jog(JOG);
    await mgr.setSpeedRatio(40);
    await mgr.resetRapid();
    await vi.advanceTimersByTimeAsync(3000);
    expect(wire).toEqual([REGISTER, WA_REQUEST, 'JOG', 'JOG', SPEED, 'POST /rw/rapid/execution/resetpp']);
    await adapter.releaseWriteAccess();
    expect(wire.at(-1)).toBe(WA_RELEASE);
    expect(wire.filter(w => w === WA_RELEASE)).toHaveLength(1);
  });
});

describe('RobotManager access: writes that used to take nothing', () => {
  it('RobotWare 8: a RAPID variable write, a module text edit and a breakpoint each hold write access', async () => {
    const { adapter, wire } = rws2('rw8');
    const mgr = manager(adapter);
    await mgr.setRapidVariable('T_ROB1', 'M1', 'n', '1');
    await mgr.setModuleText('T_ROB1', 'M1', 'MODULE M1\nENDMODULE');
    await mgr.setBreakpoint('T_ROB1', 'M1', 4);
    expect(wire).toEqual([
      REGISTER,
      WA_REQUEST, 'POST /rw/rapid/symbol/RAPID/T_ROB1/M1/n/data', WA_RELEASE,
      WA_REQUEST, 'POST /rw/rapid/tasks/T_ROB1/modules/M1/text', WA_RELEASE,
      WA_REQUEST, 'POST /rw/rapid/tasks/T_ROB1/program/breakpoints', WA_RELEASE,
    ]);
  });

  it('RobotWare 7: the active tool holds edit and motion; a UI-instruction answer holds edit', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await mgr.setActiveTool('ROB_1', 'tool1');
    await mgr.setUiInstructionParam('RAPID/T_ROB1/%$1', 'Result', '1');
    expect(wire).toEqual([
      'POST /rw/mastership/edit/request', 'POST /rw/mastership/motion/request',
      'POST /rw/motionsystem/mechunits/ROB_1',
      'POST /rw/mastership/motion/release', 'POST /rw/mastership/edit/release',
      'POST /rw/mastership/edit/request',
      'POST /rw/rapid/uiinstr/active/param/RAPID%2FT_ROB1%2F%25%241/Result',
      'POST /rw/mastership/edit/release',
    ]);
  });
});

describe('RobotManager access: nested wraps (RobotWare 7)', () => {
  it('PP to main through the manager sends one request and one release, although the adapter wraps it too', async () => {
    const { adapter, wire } = rws2('rw7');
    await manager(adapter).resetRapid();
    expect(wire).toEqual([
      'POST /rw/mastership/edit/request', 'POST /rw/rapid/execution/resetpp', 'POST /rw/mastership/edit/release',
    ]);
  });

  it('concurrent manager writes run one after another', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    await Promise.all([mgr.setMotorsOn(), mgr.startRapid(), mgr.setSpeedRatio(30)]);
    expect(wire).toEqual([
      'POST /rw/mastership/edit/request', 'POST /rw/panel/ctrl-state', 'POST /rw/mastership/edit/release',
      'POST /rw/mastership/edit/request', 'POST /rw/rapid/execution/start', 'POST /rw/mastership/edit/release',
      'POST /rw/mastership/edit/request', SPEED, 'POST /rw/mastership/edit/release',
    ]);
  });

  it('a write that a change handler starts during an operation waits for that operation to finish', async () => {
    const { adapter, wire } = rws2('rw7');
    const mgr = manager(adapter);
    // A consumer that reacts to a state change with a write of its own.
    let reacted: Promise<void> | undefined;
    mgr.onDidChange(() => { if (!reacted) { reacted = mgr.setMotorsOn(); } });
    await mgr.unloadModule('T_ROB1', 'M1');
    await reacted;
    // The handler's write starts only once the unload has released: its
    // request is not sent in the middle of the unload.
    const access = wire.filter(w => w.startsWith('POST /rw/mastership/'));
    expect(access).toEqual([
      'POST /rw/mastership/edit/request', 'POST /rw/mastership/edit/release',
      'POST /rw/mastership/edit/request', 'POST /rw/mastership/edit/release',
    ]);
    expect(wire.indexOf('POST /rw/panel/ctrl-state')).toBeGreaterThan(wire.indexOf('POST /rw/mastership/edit/release'));
  });
});

describe('RobotManager access: RWS 1.0 domains are separate locks', () => {
  it('a caller\'s cfg hold covers the manager\'s cfg wrap and the adapter\'s own; no RAPID mastership is taken', async () => {
    const calls: string[] = [];
    const fake = {
      requestMastership: async (d: string) => { calls.push(`request ${d}`); },
      releaseMastership: async (d: string) => { calls.push(`release ${d}`); },
      request: async (method: string, url: string) => { calls.push(`${method} ${url}`); return { status: 204, body: '' }; },
    };
    const mgr = manager(new RWS1Adapter(fake as unknown as RwsClient));
    await mgr.requestMastership('cfg');
    await mgr.setCfgInstance('SYS', 'CAB_TASKS', 'T_ROB1', { StackSize: '1' });
    // The manager's CFG wraps used to take RAPID mastership on RobotWare 6;
    // they now hold the CFG domain, which the caller already holds.
    expect(calls).toEqual([
      'request cfg',
      'POST /rw/cfg/SYS/CAB_TASKS/instances/T_ROB1?action=set&json=1',
    ]);
    await mgr.releaseMastership('cfg');
    expect(calls.at(-1)).toBe('release cfg');
  });

  it('RobotWare 6 CFG file load and save hold CFG mastership, not RAPID', async () => {
    const calls: string[] = [];
    const fake = {
      requestMastership: async (d: string) => { calls.push(`request ${d}`); },
      releaseMastership: async (d: string) => { calls.push(`release ${d}`); },
      request: async (method: string, url: string) => { calls.push(`${method} ${url}`); return { status: 204, body: '' }; },
    };
    const mgr = manager(new RWS1Adapter(fake as unknown as RwsClient));
    await mgr.loadCfgFile('$HOME/x.cfg', 'add');
    await mgr.saveCfgFile('SYS', '$TEMP/sys.cfg');
    expect(calls).toEqual([
      'request cfg', 'POST /rw/cfg?action=load&json=1', 'release cfg',
      'request cfg', 'POST /rw/cfg/SYS?action=saveas&json=1', 'release cfg',
    ]);
  });

  it('an RWS 1.0 adapter shares its client\'s session manager', () => {
    const client = new RwsClient({ host: '127.0.0.1', port: 1 });
    const adapter = new RWS1Adapter(client);
    expect(accessOf(adapter)).toBeDefined();
    expect(accessOf(adapter)).toBe(accessOf(client));
  });
});
