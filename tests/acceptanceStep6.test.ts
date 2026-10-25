import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import { refusalFor, type ControllerAnswer } from '../src/refusal.js';
import { RwsError, type JogParams } from '../src/types.js';
import { asJogPostError } from '../src/jog.js';

/**
 * acceptance step 6 findings (RW 7.21.4 and 8.2.1, 2026-10-13):
 * 1. RobotWare 8 setAllowMotionControl was sent from an unregistered session
 *    and refused 403 -1073435871 "Session is not part of a Control Station";
 *    once registered it answered 2xx (write access not held) and the jog went
 *    through.
 * 2. A RobotWare 7 jog refused with -1073445860 in MANR (motion mastership
 *    taken, RMMP modify, motors on) was explained as "change the operating
 *    mode with the key switch"; ABB's jog pages require a local client.
 * 3. The jog was refused before sending when the motors read off, and on
 *    RobotWare 8 when motion control read off. The controller decides now; its
 *    refusal keeps those explanations.
 */

interface Recorded { method: string; url: string; body: string }

async function startRw8(opts: { refuse?: (url: string, registered: boolean) => { status: number; code: number; msg: string } | null } = {}): Promise<{
  server: http.Server; port: number; wire: Recorded[];
}> {
  const wire: Recorded[] = [];
  let registered = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      wire.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8') });
      if (url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.2.1+1023"}]}');
        return;
      }
      if (url.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
      if (url === '/rw/controlstation/register/remote') { registered = true; }
      // As recorded: an unregistered session's allow-motion-control is refused.
      const r = url === '/rw/controlstation/allowmotioncontrol' && !registered
        ? { status: 403, code: -1073435871, msg: 'Session is not part of a Control Station.' }
        : opts.refuse?.(url, registered) ?? null;
      if (r) {
        res.writeHead(r.status, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"https://x/"}},"status":{"code":${r.code},"msg":"${r.msg} code:${r.code} icode:-1"}}`);
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const writes = (wire: Recorded[]): string[] => wire.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.url}`);

describe('item 1: setAllowMotionControl registers the station first on RobotWare 8', () => {
  it('RwsClient2: an unregistered session registers, then declares; no write access is requested', async () => {
    const { server, port, wire } = await startRw8();
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.setAllowMotionControl(true);
      expect(writes(wire)).toEqual(['POST /rw/controlstation/register/remote', 'POST /rw/controlstation/allowmotioncontrol']);
      // A second declaration in the same session does not register again.
      await c.setAllowMotionControl(false);
      expect(writes(wire).filter(w => w.endsWith('/register/remote'))).toHaveLength(1);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RobotManager.setAllowMotionControl passes it through on RobotWare 8 and refuses before sending elsewhere', async () => {
    const { server, port, wire } = await startRw8();
    try {
      const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
      await adapter.connect();
      const mgr = new RobotManager();
      (mgr as unknown as { adapter: unknown }).adapter = adapter;
      await mgr.setAllowMotionControl(true);
      expect(writes(wire).at(-1)).toBe('POST /rw/controlstation/allowmotioncontrol');
      await mgr.disconnect();
    } finally { server.close(); }

    const rw7 = new RobotManager();
    const a7 = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    (a7 as unknown as Record<string, unknown>).writeAccessMode = 'mastership';
    (rw7 as unknown as { adapter: unknown }).adapter = a7;
    await expect(rw7.setAllowMotionControl(true)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});

const answer = (code: number, over: Partial<ControllerAnswer> = {}): ControllerAnswer => ({
  http: 403, code, msg: `Operation not allowed for user in current operation mode code:${code} icode:${code}`, method: 'POST', path: '/rw/motionsystem/jog', ...over,
});

describe('item 2: a jog refused with -1073445860 in manual mode names ABB\'s local-client rule', () => {
  for (const generation of ['rw6', 'rw7'] as const) {
    it(`${generation}: the explanation itself names the rule, not the key switch`, () => {
      const path = generation === 'rw6' ? '/rw/motionsystem?action=jog' : '/rw/motionsystem/jog';
      const r = refusalFor(answer(-1073445860, { path }), { generation, opmode: 'MANR', robot: 'IRB1600_6_120_5' })!.refusal;
      expect(r.sentence).toMatch(/ABB's jog pages require a local client/);
      expect(r.sentence).not.toMatch(/key switch or mode selector at the controller\. A switch/);
    });
  }

  it('through RobotManager the rule is stated once', async () => {
    const mgr = new RobotManager();
    const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    const a = adapter as unknown as Record<string, unknown>;
    a.writeAccessMode = 'mastership';
    a.req = async () => '';
    a.getOperationMode = async () => 'MANR';
    a.getControllerState = async () => 'motoron';
    const explained = refusalFor(answer(-1073445860), { generation: 'rw7', opmode: 'MANR' })!;
    a.jog = async () => { throw new RwsError(explained.message, explained.code, 403, undefined, -1073445860, 'Operation not allowed', explained.refusal); };
    Object.assign((mgr as unknown as { adapter: unknown; _state: Record<string, unknown> }), { adapter });
    const e = await mgr.jog(JOG).then(() => null, (x: unknown) => x as RwsError);
    expect((e!.message.match(/jog pages require a local client/g) ?? []).length).toBe(1);
  });
});

const JOG: JogParams = { mode: 'Joint', axes: [0, 0, 0, 0, 1, 0], speed: 10 };

function rws2(generation: 'rw7' | 'rw8', s: { ctrl?: string; motionControl?: boolean; jogRefusal?: RwsError } = {}) {
  const wire: string[] = [];
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  a.req = async (method: string, path: string) => { wire.push(`${method} ${path}`); return ''; };
  a.getOperationMode = async () => 'MANR';
  a.getControllerState = async () => { wire.push('read ctrlstate'); return s.ctrl ?? 'motoron'; };
  a.getAllowMotionControl = async () => { wire.push('read motion control'); return s.motionControl ?? true; };
  // The stand-in is the jog POST: its refusal is tagged as the adapters tag that request's.
  a.jog = async () => { wire.push('JOG'); if (s.jogRefusal) { throw asJogPostError(s.jogRefusal); } };
  const mgr = new RobotManager();
  (mgr as unknown as { adapter: unknown }).adapter = adapter;
  return { mgr, wire };
}

describe('item 3: motors off and motion control off no longer stop the jog before it is sent', () => {
  it('motors read off: the jog is sent; a controller refusal keeps the motors-off explanation', async () => {
    const refused = new RwsError('Refused', 'UNKNOWN', 403, undefined, -1073445806, 'Rejected');
    const { mgr, wire } = rws2('rw7', { ctrl: 'motoroff', jogRefusal: refused });
    const e = await mgr.jog(JOG).then(() => null, (x: unknown) => x as RwsError);
    expect(wire).toContain('JOG');
    expect(e!.code).toBe('MOTORS_OFF');
    expect(e!.refusal).toMatchObject({ kind: 'wrong-state', condition: 'motors' });
    expect(e!.message).toMatch(/the motors were off/);
    expect(e!.controllerCode).toBe(-1073445806);
  });

  it('motors read off and the controller accepts: the jog goes through', async () => {
    const { mgr, wire } = rws2('rw7', { ctrl: 'motoroff' });
    await mgr.jog(JOG);
    expect(wire).toContain('JOG');
  });

  it('RobotWare 8, motion control reads off: the jog is sent; a refusal keeps the motion-control explanation', async () => {
    const refused = new RwsError('Refused', 'UNKNOWN', 403, undefined, -1073435872, 'Rejected');
    const { mgr, wire } = rws2('rw8', { motionControl: false, jogRefusal: refused });
    const e = await mgr.jog(JOG).then(() => null, (x: unknown) => x as RwsError);
    expect(wire).toContain('JOG');
    expect(e!.refusal).toMatchObject({ kind: 'motion-control-off', condition: 'motion-control', evidence: 'unverified' });
    expect(e!.message).toMatch(/Motion control may be the reason: it read as not allowed for this control station before the jog was sent/);
    // A reading, not the controller's answer: check first; allowing it is another way.
    expect(e!.refusal?.remedy?.kind).toBe('check-state');
    expect(e!.refusal?.otherRemedies?.map(r => r.kind)).toEqual(['declare-motion-control', 'do-at-pendant']);
  });
});
