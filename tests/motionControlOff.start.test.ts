import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import { classifyControllerError } from '../src/ControllerError.js';
import { setLogger } from '../src/Logger.js';
import { RwsError } from '../src/types.js';

/**
 * RobotWare 8: a RAPID start from a control station that has not made the
 * motion-control declaration is refused with -1073435864
 * (SYS_CTRL_E_NOT_ALLOWED_TO_MOVE_ROBOT, "Operation rejected because the
 * Control Station has not Motion Control enabled"). The body below is the one
 * RW 8.2.1 answered to POST /rw/rapid/execution/start on 2026-10-18. Every
 * call that starts RAPID explains it as `motion-control-off`, as the jog does.
 * The sentence names no method: `fix` and `remedy.call` name the declaration,
 * and nothing declares it on its own.
 */

const REFUSED = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:80/"/></head>'
  + '<body><div class="status"><span class="code">-1073435864</span><span class="msg">rws_resource_rapid_execution.cpp[1458] Unspecified Error '
  + 'code:-1073435864 icode:-1073435864</span></div></body></html>';

const NAMES_DECLARATION = /setAllowMotionControl\(true\)/;

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('the controller answer is explained wherever it comes back', () => {
  const at = (path: string) => classifyControllerError({ httpStatus: 403, body: REFUSED, method: 'POST', path });

  it.each([
    ['/rw/rapid/execution/start', 'start the RAPID program'],
    ['/rw/rapid/execution/startprodentry', 'start the RAPID program from the production entry'],
    ['/rw/rapid/execution/holdtorun', 'use hold-to-run'],
    ['/rw/motionsystem/jog', 'jog'],
  ])('%s: GRANT_DENIED, motion-control-off, naming the declaration', (path, label) => {
    const info = at(path);
    expect(info.code).toBe('GRANT_DENIED');
    expect(info.controllerCode).toBe(-1073435864);
    expect(info.refusal).toMatchObject({ kind: 'motion-control-off', condition: 'motion-control', generation: 'rw8', grantor: 'this-tool' });
    expect(info.refusal!.sentence).toContain(`refused to ${label}: motion control is not allowed for this control station.`);
    expect(info.refusal!.sentence).toMatch(/emergency stop and a normal stop/);
    expect(info.refusal!.sentence).not.toMatch(NAMES_DECLARATION);
    expect(info.refusal!.sentence).not.toMatch(/session/);
    expect(info.refusal!.fix).toMatch(NAMES_DECLARATION);
    expect(info.refusal!.remedy).toMatchObject({
      kind: 'declare-motion-control', call: { method: 'setAllowMotionControl', allow: true }, safetyDeclaration: true,
    });
    expect(info.refusal!.controller).toMatchObject({ code: -1073435864, hex: '0xC004AB28', name: 'SYS_CTRL_E_NOT_ALLOWED_TO_MOVE_ROBOT' });
    expect(info.message).not.toMatch(/gave no reason this client can explain|RMMP/);
  });

  it('only a start says it is needed for a program that does not move the robot', () => {
    expect(at('/rw/rapid/execution/start').refusal!.sentence).toMatch(/even for a program that does not move the robot/);
    expect(at('/rw/motionsystem/jog').refusal!.sentence).not.toMatch(/does not move the robot/);
  });
});

interface Recorded { method: string; url: string }

/** A RobotWare 8 controller that refuses every RAPID start and step for the missing declaration. */
async function rw8(): Promise<{ server: http.Server; url: string; wire: Recorded[] }> {
  const wire: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      wire.push({ method: req.method ?? '', url: req.url ?? '' });
      if (req.url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.2.1+1023"}]}');
        return;
      }
      if (req.url?.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
      if (req.method === 'POST' && /^\/rw\/rapid\/execution\/(start|startprodentry)(\?|$)/.test(req.url ?? '')) {
        res.writeHead(403, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end(REFUSED);
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, wire };
}

const rejection = (p: Promise<unknown>): Promise<RwsError> =>
  p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as RwsError);

const ACCESS_AND_START = /^POST \/rw\/(controlstation|rapid\/execution)\//;

describe('RWS 2.0 client on RobotWare 8: each call that starts RAPID', () => {
  it.each([
    ['startRapid', (c: RwsClient2) => c.startRapid()],
    ['stepRapid', (c: RwsClient2) => c.stepRapid('T_ROB1', 'over')],
    ['startProductionEntry', (c: RwsClient2) => c.startProductionEntry()],
  ])('%s: the refusal is motion-control-off; write access is released, nothing declares motion control', async (_name, call) => {
    const { server, url, wire } = await rw8();
    try {
      const c = new RwsClient2(url, 'u', 'p');
      await c.connect();
      const e = await rejection(call(c));
      expect(e).toBeInstanceOf(RwsError);
      expect(e.code).toBe('GRANT_DENIED');
      expect(e.httpStatus).toBe(403);
      expect(e.controllerCode).toBe(-1073435864);
      expect(e.refusal).toMatchObject({ kind: 'motion-control-off', condition: 'motion-control', generation: 'rw8' });
      expect(e.refusal?.fix).toMatch(NAMES_DECLARATION);
      expect(e.refusal?.remedy?.kind).toBe('declare-motion-control');
      const sent = wire.map(r => `${r.method} ${r.url}`).filter(w => ACCESS_AND_START.test(w));
      expect(sent.at(-1)).toBe('POST /rw/controlstation/writeaccess/release');
      // Read after the registration, never set.
      expect(wire.some(r => r.method === 'POST' && r.url.startsWith('/rw/controlstation/allowmotioncontrol'))).toBe(false);
    } finally { server.close(); }
  });
});

describe('RobotManager on RobotWare 8', () => {
  async function manager(url: string): Promise<RobotManager> {
    const adapter = new RWS2Adapter(url, 'u', 'p');
    await adapter.connect();
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = adapter;
    return mgr;
  }

  it.each([
    ['startRapid', (m: RobotManager) => m.startRapid()],
    ['stepRapid', (m: RobotManager) => m.stepRapid('T_ROB1', 'into')],
  ])('%s: refused as motion-control-off; the fix and the remedy name the declaration, not "no reason"', async (_name, call) => {
    const { server, url, wire } = await rw8();
    try {
      const e = await rejection(call(await manager(url)));
      expect(e.code).toBe('GRANT_DENIED');
      expect(e.refusal?.kind).toBe('motion-control-off');
      expect(e.refusal?.sentence).toMatch(/motion control is not allowed for this control station/);
      expect(e.refusal?.fix).toMatch(NAMES_DECLARATION);
      expect(e.refusal?.remedy).toMatchObject({ kind: 'declare-motion-control', byWhom: 'person-confirms-in-a-tool' });
      expect(e.message).not.toMatch(/gave no reason this client can explain/);
      expect(wire.some(r => r.method === 'POST' && r.url.startsWith('/rw/controlstation/allowmotioncontrol'))).toBe(false);
    } finally { server.close(); }
  });
});
