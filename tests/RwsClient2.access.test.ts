import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { accessOf, type AccessObservation } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';

/**
 * RWS 2.0 client, end to end over a mock controller: the adapter's own write
 * wraps (speed ratio, PP to main, supervision) and a caller's holds share one
 * count per real lock, and writes that take access run one at a time.
 *
 * The RobotWare 8 refusal body is the one captured live on RW 8.1.1
 * (2026-09-15): a release from a station that holds no write access.
 */

interface Recorded { method: string; url: string }

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean | void;

async function startServer(rw: '7.21.0+229' | '8.1.1+614', extra?: Handler): Promise<{ server: http.Server; port: number; wire: Recorded[] }> {
  const wire: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      wire.push({ method: req.method ?? '', url: req.url ?? '' });
      if (extra?.(req, res)) { return; }
      if (req.url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw}"}]}`);
        return;
      }
      if (req.url?.startsWith('/rw/mastership') && rw.startsWith('8')) { res.writeHead(410); res.end(); return; }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const WRITES = /^(POST|PUT|DELETE) /;
const writes = (wire: Recorded[]): string[] =>
  wire.map(r => `${r.method} ${r.url}`).filter(w => WRITES.test(w));

const NOT_HELD_BODY = '{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073435873,'
  + '"msg":"rws_resource_controlstation.cpp[1] The control station does not have SPoC. code:-1073435873 icode:-20107"}}';

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('RWS 2.0 access: RobotWare 8 (one write access for every domain)', () => {
  it('a speed-ratio write inside the caller\'s write access sends no release; the caller\'s release does', async () => {
    const { server, port, wire } = await startServer('8.1.1+614');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestWriteAccess();
      await c.setSpeedRatio(50);
      await c.setSpeedRatio(60);
      expect(writes(wire)).toEqual([
        'POST /rw/controlstation/register/remote',
        'POST /rw/controlstation/writeaccess/request',
        'POST /rw/panel/speedratio?action=setspeedratio',
        'POST /rw/panel/speedratio?action=setspeedratio',
      ]);
      await c.releaseWriteAccess();
      expect(writes(wire).at(-1)).toBe('POST /rw/controlstation/writeaccess/release');
      expect(writes(wire).filter(w => w.endsWith('/writeaccess/release'))).toHaveLength(1);
    } finally { server.close(); }
  });

  it('a motion-domain wrap (supervision) does not end a caller\'s rapid hold', async () => {
    const { server, port, wire } = await startServer('8.1.1+614');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastership('rapid');
      const before = writes(wire).length;
      await c.setMotionSupervisionMode('OFF');
      expect(writes(wire).slice(before)).toEqual(['POST /rw/motionsystem/mechunits/ROB_1/motionsupervision/mode']);
      await c.releaseMastership('rapid');
      expect(writes(wire).at(-1)).toBe('POST /rw/controlstation/writeaccess/release');
    } finally { server.close(); }
  });

  it('a release answered "does not have SPoC" while the hold was counted is recorded as a loss, not swallowed', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    const { server, port } = await startServer('8.1.1+614', (req, res) => {
      if (req.url !== '/rw/controlstation/writeaccess/release') { return false; }
      res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(NOT_HELD_BODY);
      return true;
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const events: AccessObservation[] = [];
      accessOf(c)!.on(e => events.push(e));
      await c.requestWriteAccess();
      // Still no throw from the release: it usually runs in a finally.
      await expect(c.releaseWriteAccess()).resolves.toBeUndefined();
      expect(events).toContainEqual({ type: 'released', lock: 'writeaccess', alreadyCleared: true });
      expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'writeaccess', reason: 'unknown' }));
      expect(warnings.some(w => /control-station write access was lost/.test(w))).toBe(true);
    } finally { server.close(); }
  });

  it('the same answer to a release this session held nothing for is noted, not reported as a loss', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    const { server, port } = await startServer('8.1.1+614', (req, res) => {
      if (req.url !== '/rw/controlstation/writeaccess/release') { return false; }
      res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(NOT_HELD_BODY);
      return true;
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const events: AccessObservation[] = [];
      accessOf(c)!.on(e => events.push(e));
      await c.releaseWriteAccess();
      expect(events).toEqual([{ type: 'released', lock: 'writeaccess', alreadyCleared: true }]);
      expect(warnings).toEqual([]);
    } finally { server.close(); }
  });
});

describe('RWS 2.0 access: RobotWare 7 (edit and motion)', () => {
  it('PP to main inside a caller\'s rapid hold requests and releases nothing of its own', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastership('rapid');
      await c.resetRapid();
      await c.setSpeedRatio(40);
      await c.releaseMastership('rapid');
      expect(writes(wire)).toEqual([
        'POST /rw/mastership/edit/request',
        'POST /rw/rapid/execution/resetpp',
        'POST /rw/panel/speedratio?action=setspeedratio',
        'POST /rw/mastership/edit/release',
      ]);
    } finally { server.close(); }
  });

  it('a cfg hold covers a rapid-domain write (both are edit); motion is its own lock', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastership('cfg');
      await c.setSpeedRatio(40);
      await c.setMotionSupervisionMode('OFF');
      await c.releaseMastership('cfg');
      expect(writes(wire)).toEqual([
        'POST /rw/mastership/edit/request',
        'POST /rw/panel/speedratio?action=setspeedratio',
        'POST /rw/mastership/motion/request',
        'POST /rw/motionsystem/mechunits/ROB_1/motionsupervision/mode',
        'POST /rw/mastership/motion/release',
        'POST /rw/mastership/edit/release',
      ]);
    } finally { server.close(); }
  });

  it('two concurrent writes run one after the other: no request or release lands between another\'s request and write', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await Promise.all([c.setSpeedRatio(10), c.setSpeedRatio(20), c.resetRapid()]);
      expect(writes(wire)).toEqual([
        'POST /rw/mastership/edit/request', 'POST /rw/panel/speedratio?action=setspeedratio', 'POST /rw/mastership/edit/release',
        'POST /rw/mastership/edit/request', 'POST /rw/panel/speedratio?action=setspeedratio', 'POST /rw/mastership/edit/release',
        'POST /rw/mastership/edit/request', 'POST /rw/rapid/execution/resetpp', 'POST /rw/mastership/edit/release',
      ]);
    } finally { server.close(); }
  });

  it('requestMastershipAll counts both locks; a write inside it sends nothing more, and releaseMastershipAll ends it', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastershipAll();
      await c.setSpeedRatio(40);
      await c.setMotionSupervisionMode('OFF');
      await c.releaseMastershipAll();
      expect(writes(wire)).toEqual([
        'POST /rw/mastership/request',
        'POST /rw/panel/speedratio?action=setspeedratio',
        'POST /rw/motionsystem/mechunits/ROB_1/motionsupervision/mode',
        'POST /rw/mastership/release',
      ]);
    } finally { server.close(); }
  });

  it('a refused mastership request fails the write before it is sent and leaves nothing counted', async () => {
    const heldBody = '{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445862,"msg":"Requested resource is held by someone else"}}';
    let refuse = true;
    const { server, port, wire } = await startServer('7.21.0+229', (req, res) => {
      if (req.url !== '/rw/mastership/edit/request' || !refuse) { return false; }
      refuse = false;
      res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(heldBody);
      return true;
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await expect(c.setSpeedRatio(40)).rejects.toMatchObject({ code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445862 });
      expect(writes(wire)).toEqual(['POST /rw/mastership/edit/request']);
      expect(accessOf(c)!.count('edit')).toBe(0);
      await c.setSpeedRatio(40);
      expect(writes(wire).slice(1)).toEqual([
        'POST /rw/mastership/edit/request', 'POST /rw/panel/speedratio?action=setspeedratio', 'POST /rw/mastership/edit/release',
      ]);
    } finally { server.close(); }
  });
});

// ─── Every write takes the access ABB documents for it ─────────────────────

/** A write under test, and the RobotWare 7 locks it holds. */
interface WriteCase { name: string; call: (c: RwsClient2) => Promise<unknown>; locks: 'edit' | 'edit+motion' }

const WRITE_CASES: WriteCase[] = [
  { name: 'setRapidVariable', call: c => c.setRapidVariable('T_ROB1', 'M1', 'n', '1'), locks: 'edit' },
  { name: 'setModuleText', call: c => c.setModuleText('T_ROB1', 'M1', 'MODULE M1\nENDMODULE'), locks: 'edit' },
  { name: 'setModuleTextRange', call: c => c.setModuleTextRange('T_ROB1', 'M1', { startRow: 1, startCol: 1, endRow: 1, endCol: 2 }, 'x'), locks: 'edit' },
  { name: 'modifyPosition', call: c => c.modifyPosition('T_ROB1', 'M1', { startRow: 3, startCol: 5 }), locks: 'edit' },
  { name: 'resetTaskProgramPointer', call: c => c.resetTaskProgramPointer('T_ROB1'), locks: 'edit' },
  { name: 'setUiInstructionParam', call: c => c.setUiInstructionParam('RAPID/T_ROB1/%$1', 'Result', '1'), locks: 'edit' },
  { name: 'holdToRun', call: c => c.holdToRun('T_ROB1', 'press'), locks: 'edit' },
  { name: 'setBreakpoint', call: c => c.setBreakpoint('T_ROB1', 'M1', 4), locks: 'edit' },
  { name: 'removeBreakpoint', call: c => c.removeBreakpoint('T_ROB1', 'M1', 4), locks: 'edit' },
  { name: 'ppPrevInst', call: c => c.ppPrevInst('T_ROB1'), locks: 'edit' },
  { name: 'ppNextInst', call: c => c.ppNextInst('T_ROB1'), locks: 'edit' },
  { name: 'setPPToRoutineFromUrl', call: c => c.setPPToRoutineFromUrl('T_ROB1', 'RAPID/T_ROB1/M1/r'), locks: 'edit' },
  { name: 'setProgramPointer', call: c => c.setProgramPointer('T_ROB1', { module: 'M1', routine: 'r' }), locks: 'edit' },
  { name: 'setPPToCursor', call: c => c.setPPToCursor('T_ROB1', 'M1', 4, 1), locks: 'edit' },
  { name: 'startRapid', call: c => c.startRapid(), locks: 'edit' },
  { name: 'stepRapid', call: c => c.stepRapid('T_ROB1', 'over'), locks: 'edit' },
  { name: 'setExecutionCycle', call: c => c.setExecutionCycle('once'), locks: 'edit' },
  // setTaskSelection is a recorded gap on RWS 2.0 (no resource takes the write; the client refuses before sending), so it holds nothing.
  { name: 'loadModule', call: c => c.loadModule('T_ROB1', 'HOME/M1.mod', true), locks: 'edit' },
  { name: 'unloadModule', call: c => c.unloadModule('T_ROB1', 'M1'), locks: 'edit' },
  { name: 'loadProgram', call: c => c.loadProgram('T_ROB1', 'HOME/p.pgf'), locks: 'edit' },
  { name: 'saveProgram', call: c => c.saveProgram('T_ROB1', 'HOME/p'), locks: 'edit' },
  { name: 'setNonMotionExecution', call: c => c.setNonMotionExecution(true), locks: 'edit' },
  { name: 'setKeylessMotorOn', call: c => c.setKeylessMotorOn(), locks: 'edit' },
  { name: 'setCfgInstance', call: c => c.setCfgInstance('SYS', 'CAB_TASKS', 'T_ROB1', { Entry: 'main' }), locks: 'edit' },
  { name: 'removeCfgInstance', call: c => c.removeCfgInstance('SYS', 'CAB_TASKS', 'T_ROB1'), locks: 'edit' },
  { name: 'loadCfgFile', call: c => c.loadCfgFile('HOME/x.cfg', 'add'), locks: 'edit' },
  { name: 'saveCfgFile', call: c => c.saveCfgFile('SYS', 'TEMP/sys.cfg'), locks: 'edit' },
  { name: 'restoreBackup', call: c => c.restoreBackup('bak'), locks: 'edit' },
  { name: 'setActiveTool', call: c => c.setActiveTool('ROB_1', 'tool1'), locks: 'edit+motion' },
  { name: 'setActiveWobj', call: c => c.setActiveWobj('ROB_1', 'wobj1'), locks: 'edit+motion' },
  { name: 'setMotionSupervisionMode', call: c => c.setMotionSupervisionMode('OFF'), locks: 'edit+motion' },
  { name: 'setMotionSupervisionSensitivity', call: c => c.setMotionSupervisionSensitivity(80), locks: 'edit+motion' },
  { name: 'setPathSupervisionMode', call: c => c.setPathSupervisionMode('ON'), locks: 'edit+motion' },
];

const ACCESS = /^POST \/rw\/(mastership|controlstation)\//;

/** The access calls a write sends, and the one write they surround. */
async function traceWrite(
  c: RwsClient2, wire: Recorded[], call: WriteCase['call'],
): Promise<{ access: string[]; write: string[]; order: string[] }> {
  const before = writes(wire).length;
  await call(c);
  const order = writes(wire).slice(before).filter(w => w !== 'POST /rw/controlstation/register/remote');
  return { access: order.filter(w => ACCESS.test(w)), write: order.filter(w => !ACCESS.test(w)), order };
}

describe('RWS 2.0 access: every write holds what ABB documents for it', () => {
  it.each(WRITE_CASES)('RobotWare 7: $name holds its mastership around the write', async ({ call, locks }) => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const { access, write, order } = await traceWrite(c, wire, call);
      expect(write).toHaveLength(1);
      expect(access).toEqual(locks === 'edit'
        ? ['POST /rw/mastership/edit/request', 'POST /rw/mastership/edit/release']
        : [
          'POST /rw/mastership/edit/request', 'POST /rw/mastership/motion/request',
          'POST /rw/mastership/motion/release', 'POST /rw/mastership/edit/release',
        ]);
      // Every request before the write, every release after it.
      const at = order.indexOf(write[0]);
      expect(order.slice(0, at).every(w => w.endsWith('/request'))).toBe(true);
      expect(order.slice(at + 1).every(w => w.endsWith('/release'))).toBe(true);
    } finally { server.close(); }
  });

  it.each(WRITE_CASES)('RobotWare 8: $name holds control-station write access around the write', async ({ call }) => {
    const { server, port, wire } = await startServer('8.1.1+614');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const { order } = await traceWrite(c, wire, call);
      expect(order).toHaveLength(3);
      expect(order[0]).toBe('POST /rw/controlstation/writeaccess/request');
      expect(ACCESS.test(order[1])).toBe(false);
      expect(order[2]).toBe('POST /rw/controlstation/writeaccess/release');
      expect(writes(wire).filter(w => w.endsWith('/register/remote'))).toHaveLength(1);
    } finally { server.close(); }
  });

  it('createCfgInstance holds one edit hold around the create and its attribute set', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const { order } = await traceWrite(c, wire, cl => cl.createCfgInstance('SYS', 'CAB_TASKS', 'ZZ', { Entry: 'main' }));
      expect(order).toEqual([
        'POST /rw/mastership/edit/request',
        'POST /rw/cfg/SYS/CAB_TASKS/instances/create-default',
        'POST /rw/cfg/SYS/CAB_TASKS/instances/ZZ',
        'POST /rw/mastership/edit/release',
      ]);
    } finally { server.close(); }
  });

  it('inside a caller\'s hold these writes request and release nothing of their own (RobotWare 8)', async () => {
    const { server, port, wire } = await startServer('8.1.1+614');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestWriteAccess();
      const before = writes(wire).length;
      for (const w of WRITE_CASES) { await w.call(c); }
      expect(writes(wire).slice(before).filter(w => ACCESS.test(w))).toEqual([]);
      await c.releaseWriteAccess();
      expect(writes(wire).filter(w => w.endsWith('/writeaccess/release'))).toHaveLength(1);
    } finally { server.close(); }
  });

  it('a refused write-access request fails the write before it is sent (RobotWare 8)', async () => {
    const heldBody = '{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073435870,'
      + '"msg":"Remote Control Station cannot take SPoC when it is taken"}}';
    const { server, port, wire } = await startServer('8.1.1+614', (req, res) => {
      if (req.url !== '/rw/controlstation/writeaccess/request') { return false; }
      res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(heldBody);
      return true;
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await expect(c.setRapidVariable('T_ROB1', 'M1', 'n', '1')).rejects.toMatchObject({ controllerCode: -1073435870 });
      expect(writes(wire)).toEqual([
        'POST /rw/controlstation/register/remote',
        'POST /rw/controlstation/writeaccess/request',
      ]);
      expect(accessOf(c)!.count('writeaccess')).toBe(0);
    } finally { server.close(); }
  });

  it('stop and the single-module save take no access (RobotWare 7)', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const before = writes(wire).length;
      await c.stopRapid();
      await c.saveModule('T_ROB1', 'M1', 'TEMP');
      expect(writes(wire).slice(before).filter(w => ACCESS.test(w))).toEqual([]);
      expect(writes(wire).slice(before)).toHaveLength(2);
    } finally { server.close(); }
  });
});
