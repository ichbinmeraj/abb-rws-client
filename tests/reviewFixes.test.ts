import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { classifyControllerError } from '../src/ControllerError.js';
import { innerCodeOf } from '../src/refusal.js';
import { RwsError, type JogParams, type RefusalContext } from '../src/types.js';
import { asJogPostError } from '../src/jog.js';

/**
 * Review of f77cf0d..60208ad: the explanations added when the client stopped
 * refusing before sending must not hide a more specific refusal, and the
 * remaining pre-send refusals of the client's own go.
 */

/** A controller refusal as the client's request path builds it. */
function refusal(code: number | null, method: string, at: string, http = 403, ctx: RefusalContext = {}, msg = 'Refused'): RwsError {
  const body = code === null
    ? '{"_links":{"base":{"href":"https://x/"}}}'
    : `{"_links":{"base":{"href":"https://x/"}},"status":{"code":${code},"msg":"${msg} code:${code} icode:-1"}}`;
  const info = classifyControllerError({ httpStatus: http, body, method, path: at, fallback: 'UNKNOWN', context: ctx });
  return new RwsError(info.message, info.code, http, info.controllerMsg ?? undefined, info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
}

type Fail = (method: string, at: string) => RwsError | undefined;

function rws2(generation: 'rw7' | 'rw8', s: { mode?: string; ctrl?: string; exec?: string; fail?: Fail; jogFail?: RwsError; motionControl?: boolean } = {}) {
  const wire: string[] = [];
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  a.req = async (method: string, at: string) => {
    wire.push(`${method} ${at}`);
    const e = s.fail?.(method, at);
    if (e) { throw e; }
    return '';
  };
  a.getOperationMode = async () => { wire.push('READ opmode'); return s.mode ?? 'MANR'; };
  a.getControllerState = async () => { wire.push('READ ctrlstate'); return s.ctrl ?? 'motoron'; };
  a.getRapidExecutionState = async () => { wire.push('READ execstate'); return s.exec ?? 'stopped'; };
  a.getAllowMotionControl = async () => s.motionControl ?? true;
  a.listModules = async () => { wire.push('READ modules'); return ['ZZ_SIDE']; };
  a.getRmmpPrivilege = async () => { wire.push('READ rmmp'); return 'none'; };
  // The stand-in is the jog POST: its refusal is tagged as the adapters tag that request's.
  a.jog = async () => { wire.push('JOG'); if (s.jogFail) { throw asJogPostError(s.jogFail); } };
  const mgr = new RobotManager();
  Object.assign((mgr as unknown as { adapter: unknown; _state: Record<string, unknown> }), { adapter });
  (mgr as unknown as { _state: Record<string, unknown> })._state.opmode = s.mode ?? 'MANR';
  return { mgr, wire, adapter };
}

const rejection = (p: Promise<unknown>): Promise<RwsError> => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as RwsError);
const JOG: JogParams = { mode: 'Joint', axes: [0, 0, 0, 0, 1, 0], speed: 10 };
const MANR7: RefusalContext = { generation: 'rw7', opmode: 'MANR' };

describe('1: the jog keeps the controller\'s specific refusal; motors off is only a hint for an unexplained jog refusal', () => {
  it('a motion-mastership refusal in MANR with the motors off keeps its own kind, not MOTORS_OFF', async () => {
    const held = refusal(-1073445862, 'POST', '/rw/mastership/motion/request', 403, MANR7);
    const { mgr } = rws2('rw7', { ctrl: 'motoroff', fail: (_m, at) => (at === '/rw/mastership/motion/request' ? held : undefined) });
    const e = await rejection(mgr.jog(JOG));
    expect(e.code).not.toBe('MOTORS_OFF');
    expect(e.refusal?.kind).toBe(held.refusal?.kind);
  });

  it('a jog refused with -1073445860 in MANR with the motors off stays local-only', async () => {
    const { mgr } = rws2('rw7', { ctrl: 'motoroff', jogFail: refusal(-1073445860, 'POST', '/rw/motionsystem/jog', 403, MANR7) });
    const e = await rejection(mgr.jog(JOG));
    expect(e.refusal?.kind).toBe('local-only');
    expect(e.code).not.toBe('MOTORS_OFF');
  });

  it('a jog in Auto with the motors off is sent; the motors-off refusal says jogging is done in manual mode at the FlexPendant', async () => {
    const AUTO7: RefusalContext = { generation: 'rw7', opmode: 'AUTO', ctrlstate: 'motoroff' };
    const { mgr, wire } = rws2('rw7', { mode: 'AUTO', ctrl: 'motoroff', jogFail: refusal(-1073445806, 'POST', '/rw/motionsystem/jog', 403, AUTO7) });
    const e = await rejection(mgr.jog(JOG));
    expect(wire).toContain('JOG');
    expect(e.code).toBe('WRONG_MODE');
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', condition: 'motors' });
    expect(e.message).toMatch(/Jogging is done in manual mode at the FlexPendant/);
    expect(e.message).not.toMatch(/Switch them on first/);
  });

  it('an unexplained refusal of the jog POST with the motors off gets the motors-off hint', async () => {
    const { mgr } = rws2('rw7', { ctrl: 'motoroff', jogFail: refusal(null, 'POST', '/rw/motionsystem/jog', 403, MANR7) });
    const e = await rejection(mgr.jog(JOG));
    expect(e.code).toBe('MOTORS_OFF');
    expect(e.refusal?.kind).toBe('wrong-state');
  });
});

describe('2: the running-program explanation covers only mode or state refusals of the step that changes the program', () => {
  it('setPPToRoutine while running, routine missing (404): stays RESOURCE_NOT_FOUND', async () => {
    const missing = refusal(-1073442816, 'POST', '/rw/rapid/tasks/T_ROB1/pcp/routine', 404);
    const { mgr } = rws2('rw7', { exec: 'running', fail: (_m, at) => (at.endsWith('/pcp/routine') ? missing : undefined) });
    const e = await rejection(mgr.setPPToRoutine('T_ROB1', 'M1', 'r1'));
    expect(e.code).not.toBe('WRONG_MODE');
    expect(e.message).not.toMatch(/while the RAPID program was running/);
  });

  it('unloadModule while running, refused as held by another: stays held-by-other', async () => {
    const held = refusal(-1073445862, 'POST', '/rw/rapid/tasks/T_ROB1/unloadmod', 403, { generation: 'rw7', opmode: 'AUTO' });
    const { mgr } = rws2('rw7', { mode: 'AUTO', exec: 'running', fail: (_m, at) => (at.endsWith('/unloadmod') ? held : undefined) });
    const e = await rejection(mgr.unloadModule('T_ROB1', 'M1'));
    expect(e.refusal?.kind).toBe(held.refusal?.kind);
    expect(e.message).not.toMatch(/while the RAPID program was running/);
  });

  describe('loadProgram', () => {
    let dir: string; let file: string;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-review-')); file = path.join(dir, 'ZZ_SIDE.mod'); fs.writeFileSync(file, 'MODULE ZZ_SIDE\nENDMODULE\n'); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('while running, an upload refused as a bad request (400) is reported as that step, not as the running program', async () => {
      const bad = refusal(null, 'PUT', '/fileservice/HOME/ZZ_SIDE.mod', 400);
      const { mgr } = rws2('rw7', { mode: 'AUTO', exec: 'running', fail: (m, at) => (m === 'PUT' ? bad : undefined) });
      const e = await rejection(mgr.loadProgram(file, 'T_ROB1'));
      expect(e.message).not.toMatch(/while the RAPID program was running/);
      expect(e.message).toMatch(/could not upload/);
    });

    it('while running, the unload refused for the execution state is explained as the running program', async () => {
      const exec = refusal(-1073442809, 'POST', '/rw/rapid/tasks/T_ROB1/unloadmod', 403, { generation: 'rw7', opmode: 'AUTO' });
      const { mgr } = rws2('rw7', { mode: 'AUTO', exec: 'running', fail: (_m, at) => (at.endsWith('/unloadmod') ? exec : undefined) });
      const e = await rejection(mgr.loadProgram(file, 'T_ROB1'));
      expect(e.message).toMatch(/while the RAPID program was running/);
    });
  });
});

describe('3: the remaining client-side refusals go; the controller decides', () => {
  it('a jog in AUTO is sent; an unexplained refusal names the mode', async () => {
    const { mgr, wire } = rws2('rw7', { mode: 'AUTO', jogFail: refusal(null, 'POST', '/rw/motionsystem/jog', 403, { generation: 'rw7', opmode: 'AUTO' }) });
    const e = await rejection(mgr.jog(JOG));
    expect(wire).toContain('JOG');
    expect(e.refusal?.kind).toBe('wrong-mode');
    expect(e.message).toMatch(/AUTO/);
  });

  it('a jog in AUTO the controller accepts goes through', async () => {
    const { mgr, wire } = rws2('rw7', { mode: 'AUTO' });
    await mgr.jog(JOG);
    expect(wire).toContain('JOG');
  });

  it('requestRmmp on RobotWare 7 outside MANR is sent; the controller\'s refusal is passed on with its kind', async () => {
    const reject = refusal(-1073445800, 'POST', '/users/rmmp', 403, { generation: 'rw7', opmode: 'AUTO' });
    const { mgr, wire } = rws2('rw7', { mode: 'AUTO', fail: (m, at) => (m === 'POST' && at === '/users/rmmp' ? reject : undefined) });
    const e = await rejection(mgr.requestRmmp('modify', { waitMs: 1000, pollMs: 250 }));
    expect(wire).toContain('POST /users/rmmp');
    expect(e.refusal?.kind).toBe('rmmp-wrong-mode');
  });
});

describe('4: setAllowMotionControl before the version is known', () => {
  async function server(rw: '7' | '8'): Promise<{ s: http.Server; port: number; wire: string[]; reissue: () => void }> {
    const wire: string[] = [];
    let registered = false; let session = 1;
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const url = req.url ?? '';
        wire.push(`${req.method} ${url}`);
        const cookie = { 'Set-Cookie': [`-http-session-=S${session}; path=/`] };
        if (url === '/rw/system') {
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0', ...cookie });
          res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw === '8' ? '8.2.1+1023' : '7.21.4+417'}"}]}`);
          return;
        }
        if (rw === '7' && url.startsWith('/rw/controlstation')) { res.writeHead(404, cookie); res.end(); return; }
        if (url === '/rw/controlstation/register/remote') { registered = true; }
        if (url === '/rw/controlstation/allowmotioncontrol' && !registered) {
          res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0', ...cookie });
          res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073435871,"msg":"Session is not part of a Control Station. code:-1073435871 icode:-1"}}');
          return;
        }
        res.writeHead(204, cookie); res.end();
      });
    });
    await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
    return { s, port: (s.address() as AddressInfo).port, wire, reissue: () => { session += 1; registered = false; } };
  }
  const writes = (w: string[]): string[] => w.filter(l => !l.startsWith('GET '));

  it('RobotWare 8, no connect() yet: refused as not a control station, registers once, retries once', async () => {
    const { s, port, wire } = await server('8');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.setAllowMotionControl(true);
      expect(writes(wire)).toEqual(['POST /rw/controlstation/allowmotioncontrol', 'POST /rw/controlstation/register/remote', 'POST /rw/controlstation/allowmotioncontrol']);
      await c.setAllowMotionControl(false);
      expect(writes(wire).filter(w => w.endsWith('/register/remote'))).toHaveLength(1);
    } finally { s.close(); }
  });

  it('RobotWare 8: a new session registers again', async () => {
    const { s, port, wire, reissue } = await server('8');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.setAllowMotionControl(true);
      await c.disconnect();
      reissue();
      await c.connect();
      await c.setAllowMotionControl(true);
      expect(writes(wire).filter(w => w.endsWith('/register/remote'))).toHaveLength(2);
    } finally { s.close(); }
  });

  it('RobotWare 7 never registers', async () => {
    const { s, port, wire } = await server('7');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await expect(c.setAllowMotionControl(true)).rejects.toBeInstanceOf(RwsError);
      await c.connect();
      await expect(c.setAllowMotionControl(true)).rejects.toBeInstanceOf(RwsError);
      expect(writes(wire).filter(w => w.endsWith('/register/remote'))).toHaveLength(0);
    } finally { s.close(); }
  });
});

describe('5: innerCodeOf reads only a message\'s own code annotations', () => {
  it('org_code and new_code are not read as code:', () => {
    expect(innerCodeOf('org_code: -1073445862 code:-1073414146 icode:-1')).toBeNull();
    expect(innerCodeOf('Refused code:-1073445862 icode:-1')).toBe(-1073445862);
  });
});
