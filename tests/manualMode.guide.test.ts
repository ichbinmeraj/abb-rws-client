import { describe, it, expect, afterEach } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { refusalFor, type ControllerAnswer } from '../src/refusal.js';
import { waitForRmmp, type RmmpPort } from '../src/access/rmmp.js';
import { RwsError, type JogParams } from '../src/types.js';
import { setLogger } from '../src/Logger.js';

/**
 * Client behaviour corrected against ABB's documents for a remote client in
 * manual mode. Write policy: no prohibitions of the client's own; send,
 * honour the controller's answer, explain it.
 */

const traces: string[] = [];
afterEach(() => { traces.length = 0; setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

// ─── An RWS 2.0 adapter with a recording transport ───────────────────────────

interface Script { opmode?: string; refuse?: Record<string, RwsError> }

function rws2(generation: 'rw7' | 'rw8', s: Script = {}) {
  const wire: string[] = [];
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  a.rwVersionRaw = generation === 'rw8' ? '8.2.1+1023' : '7.21.4+417';
  a.req = async (method: string, path: string) => {
    wire.push(`${method} ${path}`);
    const refusal = s.refuse?.[`${method} ${path}`];
    if (refusal) { throw refusal; }
    return '';
  };
  a.getOperationMode = async () => { wire.push('READ opmode'); return s.opmode ?? 'AUTO'; };
  a.getControllerState = async () => { wire.push('READ ctrlstate'); return 'motoron'; };
  a.getRapidExecutionState = async () => { wire.push('READ execstate'); return 'stopped'; };
  a.getAllowMotionControl = async () => true;
  a.getRmmpPrivilege = async () => { wire.push('READ rmmp'); return 'none'; };
  a.listServiceRoutines = async () => { wire.push('READ serviceroutines'); return [{ name: 'SkipTaskExec', url: 'RAPID/T_ROB1/BASEFUN/SkipTaskExec' }]; };
  return { adapter, wire };
}

function manager(adapter: unknown, state: Record<string, unknown> = {}): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
  m.adapter = adapter;
  Object.assign(m._state, { connected: true, opmode: 'AUTO', ctrlstate: 'motoron' }, state);
  return mgr;
}

const rejection = (p: Promise<unknown>): Promise<RwsError> => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as RwsError);
const PP_ROUTINE = 'POST /rw/rapid/tasks/T_ROB1/pcp/routine';

describe('item 1: setPPToServiceRoutine does not refuse by mode; it sends and the controller decides', () => {
  it('RobotWare 7 in Auto (the mode ABB documents for a remote client): the pointer move goes out', async () => {
    const { adapter, wire } = rws2('rw7', { opmode: 'AUTO' });
    await manager(adapter).setPPToServiceRoutine('T_ROB1', 'SkipTaskExec');
    expect(wire).toContain(PP_ROUTINE);
  });

  it('RobotWare 7 in MANR: the move goes out, and a mode refusal is explained as ABB\'s manual-mode rule', async () => {
    const refused = new RwsError('Refused', 'WRONG_MODE', 403, undefined, -1073445860, 'Operation not allowed in current operation mode');
    const { adapter, wire } = rws2('rw7', { opmode: 'MANR', refuse: { [PP_ROUTINE]: refused } });
    const e = await rejection(manager(adapter, { opmode: 'MANR' }).setPPToServiceRoutine('T_ROB1', 'SkipTaskExec'));
    expect(wire).toContain(PP_ROUTINE);
    expect(e.code).toBe('WRONG_MODE');
  });

  it('RobotWare 8 in MANR: the move goes out under write access', async () => {
    const { adapter, wire } = rws2('rw8', { opmode: 'MANR' });
    await manager(adapter, { opmode: 'MANR' }).setPPToServiceRoutine('T_ROB1', 'SkipTaskExec');
    expect(wire).toContain(PP_ROUTINE);
  });

  it('RobotWare 8 in Auto stays held back before sending', async () => {
    const { adapter, wire } = rws2('rw8', { opmode: 'AUTO' });
    const e = await rejection(manager(adapter).setPPToServiceRoutine('T_ROB1', 'SkipTaskExec'));
    expect(e.code).toBe('WRONG_MODE');
    expect(e.message).toMatch(/no run has shown/);
    expect(e.message).toMatch(/The program pointer was not moved\.$/);
    expect(wire).toEqual(['READ opmode']);
  });
});

const answer = (code: number, over: Partial<ControllerAnswer> = {}): ControllerAnswer => ({
  http: 403, code, msg: `Refused code:${code} icode:-1`, method: 'POST', path: '/rw/panel/speedratio', ...over,
});

describe('item 2: the program-pointer sentence in manual mode follows ABB\'s pages', () => {
  it('RobotWare 7, PP to routine in MANR: ABB allows it with RMMP exec; modify does not cover it', () => {
    const r = refusalFor(answer(-1073445860, { path: '/rw/rapid/tasks/T_ROB1/pcp/routine' }), { generation: 'rw7', opmode: 'MANR', robot: 'cell-7' })!.refusal;
    expect(r.sentence).toMatch(/RMMP exec/);
    expect(r.sentence).toMatch(/modify does not cover it/);
    expect(r.sentence).not.toMatch(/does not cover them/);
    expect(r.sentence).not.toMatch(/key switch or mode selector/);
  });

  it('RobotWare 7, PP to Main in MANR: ABB says it cannot be performed in manual mode', () => {
    const r = refusalFor(answer(-1073445860, { path: '/rw/rapid/execution/resetpp' }), { generation: 'rw7', opmode: 'MANR' })!.refusal;
    expect(r.sentence).toMatch(/cannot be performed in manual mode/);
    expect(r.sentence).not.toMatch(/key switch or mode selector/);
  });

  it('RobotWare 6, PP to routine in MANR: the same Auto rule, ABB\'s RWS 1.0 page', () => {
    const r = refusalFor(answer(-1073445860, { path: '/rw/rapid/tasks/T_ROB1/pcp/routine' }), { generation: 'rw6', opmode: 'MANR' })!.refusal;
    expect(r.sentence).toMatch(/RobotWare 6 moves the program pointer for a remote tool in Auto/);
    expect(r.sentence).not.toMatch(/key switch or mode selector at the controller\. A switch/);
  });
});

describe('item 3: the enabling-device sentence says what the controller answered and what was seen, without promising a fix', () => {
  it('MANR: quotes the answer, says ABB does not say whose enabling device, names the VC runs', () => {
    const r = refusalFor(answer(-1073445800, { path: '/users/rmmp' }), { generation: 'rw7', opmode: 'MANR', robot: 'cell-7' })!.refusal;
    expect(r.sentence).toMatch(/not in manual reduced speed or enabling device released/);
    expect(r.sentence).toMatch(/ABB does not say whose enabling device/);
    expect(r.sentence).toMatch(/neither the virtual controller's enable switch nor the virtual FlexPendant's Enable/);
    expect(r.sentence).not.toMatch(/while this tool sends the request/);
    expect(r.fix).not.toMatch(/holds the enabling device at the FlexPendant while/);
  });
});

const JOG: JogParams = { mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 };

describe('item 4: a jog in manual mode on RobotWare 6/7 is sent; its refusal names ABB\'s local-client rule', () => {
  it('no RMMP: the jog is not refused by the client; the mastership request goes out and its refusal says a jog also needs a local client', async () => {
    const refused = new RwsError('Refused', 'MASTERSHIP_REQUIRED', 403, undefined, -1073445862, 'held');
    const { adapter, wire } = rws2('rw7', { opmode: 'MANR', refuse: { 'POST /rw/mastership/motion/request': refused } });
    const e = await rejection(manager(adapter, { opmode: 'MANR' }).jog(JOG));
    expect(wire).toContain('POST /rw/mastership/motion/request');
    expect(wire).not.toContain('READ rmmp');
    expect(e.refusal?.sentence ?? e.message).toMatch(/ABB's jog pages require a local client/);
    expect(e.refusal?.sentence ?? e.message).toMatch(/RMMP does not make this tool local/);
  });

  it('a jog the controller refuses after mastership was granted carries the same note', async () => {
    const { adapter } = rws2('rw7', { opmode: 'MANR' });
    (adapter as unknown as Record<string, unknown>).jog = async () => { throw new RwsError('Refused', 'UNKNOWN', 403, undefined, -1073445866, 'Rejected'); };
    const e = await rejection(manager(adapter, { opmode: 'MANR' }).jog(JOG));
    expect(e.refusal?.sentence ?? e.message).toMatch(/ABB's jog pages require a local client/);
  });
});

describe('item 5: setOperationMode says a real controller may refuse it', () => {
  it('a switch the controller refuses names ABB\'s Local Client rule and that it was verified on virtual controllers only', async () => {
    const refused = new RwsError('Refused', 'UNKNOWN', 403, undefined, -1073445881, 'Rejected');
    const { adapter } = rws2('rw7', { refuse: { 'POST /rw/panel/opmode': refused } });
    const e = await rejection(manager(adapter, { opmode: 'MANR' }).setOperationMode('MANR'));
    expect(e.refusal?.sentence ?? e.message).toMatch(/Local Client privileges/);
    expect(e.refusal?.sentence ?? e.message).toMatch(/virtual controllers/);
  });
});

function port(polls: string[], reads: string[]): { port: RmmpPort; sent: string[] } {
  const sent: string[] = [];
  const next = (l: string[]): string => (l.length > 1 ? l.shift()! : l[0]);
  return {
    sent,
    port: {
      request: async l => { sent.push(`request ${l}`); },
      poll: async () => { sent.push('poll'); return next(polls); },
      read: async () => { sent.push('read'); return next(reads); },
      cancel: async () => { sent.push('cancel'); },
    },
  };
}

describe('item 6: the RMMP wait reads the privilege on every poll and reports a held request honestly', () => {
  it('reads GET /users/rmmp on every poll while pending, and logs both answers', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {}, trace(_c: string, m: string) { traces.push(m); } });
    const { port: p, sent } = port(['PENDING', 'PENDING', 'GRANTED'], ['pending modify', 'pending modify', 'modify']);
    const r = await waitForRmmp(p, 'modify', { waitMs: 5000, pollMs: 250 }, 'rw7');
    expect(r.outcome).toBe('granted');
    expect(sent.slice(1, 5)).toEqual(['poll', 'read', 'poll', 'read']);
    expect(traces.filter(t => /RMMP poll answered 'PENDING'/.test(t)).length).toBeGreaterThanOrEqual(2);
    expect(traces.filter(t => /RMMP privilege read 'pending modify'/.test(t)).length).toBeGreaterThanOrEqual(2);
  });

  it('the poll\'s code is understood when the text is the code: 294914 pending, 294915 granted', async () => {
    const { port: p } = port(['294914', '294915'], ['pending modify', 'modify']);
    const r = await waitForRmmp(p, 'modify', { waitMs: 3000, pollMs: 250 }, 'rw7');
    expect(r.outcome).toBe('granted');
  });

  it('held pending to the end: says the controller held the request and no local client answered it, and points at the pendant not showing it', async () => {
    const { port: p } = port(['PENDING'], ['pending modify']);
    const r = await waitForRmmp(p, 'modify', { waitMs: 800, pollMs: 250 }, 'rw7');
    expect(r.outcome).toBe('expired');
    expect(r.detail).toMatch(/The controller held the RMMP request pending/);
    expect(r.detail).toMatch(/no local client answered it/);
    expect(r.detail).toMatch(/If the FlexPendant showed no request/);
    expect(r.refusal?.fix).not.toMatch(/stand by/);
  });
});

describe('item 7: messages name the system, not the PC name a virtual IRC5 reports as controller name', () => {
  it('the refusal context, which every explanation reads its robot name from, names the /rw/system name first', () => {
    const { adapter } = rws2('rw7');
    const ctxOf = (m: RobotManager): { robot: string | null } => (m as unknown as { refusalContextNow(): { robot: string | null } }).refusalContextNow();
    const mgr = manager(adapter, {
      quality: 'live',
      identity: { name: 'DESKTOP-OWNER-PC', id: 'x', type: 'Virtual Controller' },
      systemInfo: { name: 'IRB1600_6_120_5', rwVersion: '6.16.3007', sysid: 'y' },
    });
    expect(ctxOf(mgr).robot).toBe('IRB1600_6_120_5');
    const noSystem = manager(adapter, { identity: { name: 'DESKTOP-OWNER-PC', id: 'x', type: 'Virtual Controller' }, systemInfo: null });
    expect(ctxOf(noSystem).robot).toBe('DESKTOP-OWNER-PC');
  });
});
