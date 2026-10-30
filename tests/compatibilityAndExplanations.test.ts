import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager, renamedOnLoad } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { ALL_TABLES, evidenceOf } from '../src/paths/index.js';
import { virtualTimeRunningUnsupported } from '../src/paths/ctrl.js';
import { classifyControllerError } from '../src/ControllerError.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type ElogMessage, type JogParams } from '../src/types.js';

/**
 * - getCompatibility sends ABB's GET /ctrl/compatibility/{robotware version}
 *   on both generations (RWS 1.0 Rev M, RWS 2.0 Rev L), reads the
 *   ctrl-compatibility status, and passes a refusal on as the controller's
 *   error, never as compatible: false. Without a version, as 1.4.0 called
 *   it, it sends the controller's own rwversion from /rw/system.
 * - setAllowMotionControl updates RobotState.access.rw8 from the call.
 * - loadProgram reports the name the controller gave a module it loaded
 *   under another name; an unload refused with -1073414145 is explained from
 *   the newest event-log message, only when the unload request itself was
 *   refused with the controller's event-log text.
 * - The deprecated setVirtualTimeRunning refusal carries a refusal object.
 * - A jog refused with -1073435864 is explained as motion-control-off from
 *   the code, whichever adapter sent it.
 */

const warnings: string[] = [];
beforeEach(() => {
  warnings.length = 0;
  setLogger({ info() {}, warn(m: string) { warnings.push(m); }, error() {}, show() {} });
});

const caught = (p: Promise<unknown>): Promise<RwsError> => p.then(
  () => { throw new Error('expected a rejection'); },
  (e: unknown) => e as RwsError,
);

// ── getCompatibility ──────────────────────────────────────────────────────────

/** ABB's example answer (RWS 2.0 Rev L; RWS 1.0 Rev M shows the same entry). */
const compatXhtml = (status: string): string => '<?xml version="1.0" encoding="utf-8"?><html><head>'
  + '<base href="https://localhost/ctrl/compatibility/6.03.0101/" /></head><body><div class="state"><a href="" rel="self"/><ul>'
  + `<li class="ctrl-compatibility" title="compatibility"><span class="status">${status}</span></li></ul></div></body></html>`;

/** The same entry in the RWS 1.0 `?json=1` shape. */
const compatJson = (fields: Record<string, string>): string => JSON.stringify({
  _links: { base: { href: 'http://localhost/ctrl/compatibility/6.03.0101/' } },
  _embedded: { _state: [{ _type: 'ctrl-compatibility', _title: 'compatibility', ...fields }] },
});

function fakeRws1(respond: (method: string, url: string) => { status: number; body: string }): { calls: string[]; client: RwsClient } {
  const calls: string[] = [];
  const fake = {
    request: async (method: string, url: string) => { calls.push(`${method} ${url}`); return respond(method, url); },
  };
  return { calls, client: fake as unknown as RwsClient };
}

interface Recorded { method: string; url: string }

async function startServer(
  answer: (method: string, url: string) => { status: number; type?: string; body?: string },
): Promise<{ server: http.Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '' });
      const a = answer(req.method ?? '', req.url ?? '');
      res.writeHead(a.status, { 'Content-Type': a.type ?? 'application/xhtml+xml;v=2.0' });
      res.end(a.body ?? '');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe('getCompatibility: ABB\'s /ctrl/compatibility/{robotware version} on both generations', () => {
  it('the path table names ABB\'s path on both generations, built (real controllers only)', () => {
    const op = ALL_TABLES.ctrl.getCompatibility;
    expect(op.rws1).toMatchObject({ method: 'GET', path: '/ctrl/compatibility/{version}' });
    expect(op.rws2).toMatchObject({ method: 'GET', path: '/ctrl/compatibility/{version}' });
    expect(op.rws1?.gap).toBeUndefined();
    expect(op.rws2?.gap).toBeUndefined();
    expect(evidenceOf(op, 'rws1')).toBe('built');
    expect(evidenceOf(op, 'rws2')).toBe('built');
  });

  it('RWS 1.0 sends the version in the path and reads the status (JSON and XHTML answers)', async () => {
    const json = fakeRws1(() => ({ status: 200, body: compatJson({ status: 'true' }) }));
    await expect(new RWS1Adapter(json.client).getCompatibility('6.03.0101'))
      .resolves.toEqual({ compatible: true, status: 'true', details: { _title: 'compatibility', status: 'true' } });
    expect(json.calls).toEqual(['GET /ctrl/compatibility/6.03.0101?json=1']);

    const xhtml = fakeRws1(() => ({ status: 200, body: compatXhtml(' false ') }));
    await expect(new RWS1Adapter(xhtml.client).getCompatibility(' 6.16.03 ')).resolves.toMatchObject({ compatible: false, status: 'false' });
    expect(xhtml.calls).toEqual(['GET /ctrl/compatibility/6.16.03?json=1']);
  });

  it('RWS 1.0: a refusal is the controller\'s typed error, not compatible: false', async () => {
    const { client } = fakeRws1(() => ({ status: 404, body: '' }));
    const err = await caught(new RWS1Adapter(client).getCompatibility('6.03.0101'));
    expect(err).toBeInstanceOf(RwsError);
    expect(err.httpStatus).toBe(404);
  });

  it('RWS 2.0 sends GET /ctrl/compatibility/{version} and reads ABB\'s example answer', async () => {
    const { server, url, requests } = await startServer(() => ({ status: 200, body: compatXhtml('true') }));
    try {
      const r = await new RwsClient2(url, 'u', 'p').getCompatibility('7.16');
      expect(r).toMatchObject({ compatible: true, status: 'true', details: { status: 'true' } });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(q => q.method === 'GET' && q.url === '/ctrl/compatibility/7.16')).toBe(true);
    } finally { server.close(); }
  });

  it('RWS 2.0: the 404 a virtual controller answers is thrown, not compatible: false', async () => {
    const { server, url } = await startServer(() => ({ status: 404, type: 'application/hal+json;v=2.0', body: '' }));
    try {
      const err = await caught(new RwsClient2(url, 'u', 'p').getCompatibility('7.16'));
      expect(err).toBeInstanceOf(RwsError);
      expect(err.httpStatus).toBe(404);
    } finally { server.close(); }
  });

  it('a status other than true or false, or none, is PARSE_ERROR; an empty version is refused before sending', async () => {
    for (const body of [compatJson({ status: 'maybe' }), compatJson({}), JSON.stringify({ _embedded: { _state: [] } })]) {
      const { client } = fakeRws1(() => ({ status: 200, body }));
      await expect(caught(new RWS1Adapter(client).getCompatibility('6.03.0101'))).resolves.toMatchObject({ code: 'PARSE_ERROR' });
    }
    const { client, calls } = fakeRws1(() => ({ status: 200, body: compatJson({ status: 'true' }) }));
    await expect(caught(new RWS1Adapter(client).getCompatibility('  '))).resolves.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(caught(new RwsClient2('http://127.0.0.1:1', 'u', 'p').getCompatibility(''))).resolves.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
  });

  it('RWS 1.0 without a version (the 1.4.0 call): reads /rw/system and sends its rwversion as written', async () => {
    const rws1 = fakeRws1(() => ({ status: 200, body: compatJson({ status: 'true' }) }));
    let systemReads = 0;
    (rws1.client as unknown as { getSystemInfo: () => Promise<unknown> }).getSystemInfo = async () => {
      systemReads++;
      return { name: 'IRB1600_6_145', rwVersion: '6.16.3007', sysid: '', startTime: '', options: [] };
    };
    const r = await new RWS1Adapter(rws1.client).getCompatibility();
    // The two fields 1.4.0 returned are still there.
    const old: { compatible: boolean; details?: Record<string, string> } = r;
    expect(old).toMatchObject({ compatible: true, details: { status: 'true' } });
    expect(r.status).toBe('true');
    expect(systemReads).toBe(1);
    expect(rws1.calls).toEqual(['GET /ctrl/compatibility/6.16.3007?json=1']);
  });

  it('RWS 1.0 without a version: a /rw/system answer with no version is PARSE_ERROR, no compatibility request', async () => {
    for (const rwVersion of ['', '..', '  ']) {
      const rws1 = fakeRws1(() => ({ status: 200, body: compatJson({ status: 'true' }) }));
      (rws1.client as unknown as { getSystemInfo: () => Promise<unknown> }).getSystemInfo = async () =>
        ({ name: '', rwVersion, sysid: '', startTime: '', options: [] });
      const err = await caught(new RWS1Adapter(rws1.client).getCompatibility());
      expect(err).toMatchObject({ code: 'PARSE_ERROR' });
      expect(err.message).toMatch(/no version was given/);
      expect(rws1.calls).toEqual([]);
    }
  });

  it('RWS 2.0 without a version: one /rw/system read when connect() has not cached one, then the version as written', async () => {
    const { server, url, requests } = await startServer((_m, u) => u === '/rw/system'
      ? { status: 200, type: 'application/hal+json;v=2.0', body: '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.2.1+1023"}]}' }
      : { status: 200, body: compatXhtml('false') });
    try {
      const r = await new RwsClient2(url, 'u', 'p').getCompatibility();
      expect(r).toMatchObject({ compatible: false, status: 'false' });
      const paths = requests.map(q => `${q.method} ${q.url}`);
      expect(paths.filter(p => p === 'GET /rw/system')).toHaveLength(1);
      expect(paths[paths.length - 1]).toBe('GET /ctrl/compatibility/8.2.1%2B1023');
      expect(paths.every(p => p === 'GET /rw/system' || p === 'GET /ctrl/compatibility/8.2.1%2B1023')).toBe(true);
    } finally { server.close(); }
  });

  it('RWS 2.0 without a version: the version connect() read is used, no second /rw/system read', async () => {
    const { server, url, requests } = await startServer(() => ({ status: 200, body: compatXhtml('true') }));
    try {
      const c = new RwsClient2(url, 'u', 'p');
      (c as unknown as { rwVersionRaw: string }).rwVersionRaw = '7.21.4+417';
      await expect(c.getCompatibility()).resolves.toMatchObject({ compatible: true });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(q => q.method === 'GET' && q.url === '/ctrl/compatibility/7.21.4%2B417')).toBe(true);
    } finally { server.close(); }
  });

  it('RobotManager passes it through; NOT_CONNECTED without a session, UNSUPPORTED_OPERATION for an adapter without it', async () => {
    const { client } = fakeRws1(() => ({ status: 200, body: compatJson({ status: 'true' }) }));
    const withRead = new RobotManager();
    (withRead as unknown as { adapter: IRWSAdapter }).adapter = new RWS1Adapter(client);
    await expect(withRead.getCompatibility('6.03.0101')).resolves.toMatchObject({ compatible: true });
    const passed: unknown[][] = [];
    const recorder = new RobotManager();
    (recorder as unknown as { adapter: unknown }).adapter = {
      getCompatibility: async (...args: unknown[]) => { passed.push(args); return { compatible: true, status: 'true', details: {} }; },
    };
    await recorder.getCompatibility();
    await recorder.getCompatibility('7.16');
    expect(passed).toEqual([[undefined], ['7.16']]);

    await expect(caught(new RobotManager().getCompatibility())).resolves.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(caught(new RobotManager().getCompatibility('7.16'))).resolves.toMatchObject({ code: 'NOT_CONNECTED' });
    const without = new RobotManager();
    (without as unknown as { adapter: unknown }).adapter = {};
    await expect(caught(without.getCompatibility('7.16'))).resolves.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('RobotManager fills status and details for an adapter of another make answering the 1.4.0 result', async () => {
    const answers: Array<{ compatible: boolean; details?: Record<string, string> }> = [
      { compatible: false },
      { compatible: true, details: { status: 'TRUE', reason: 'x' } },
      { compatible: true, details: {} },
    ];
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = { getCompatibility: async () => answers.shift() };
    await expect(mgr.getCompatibility()).resolves.toEqual({ compatible: false, status: 'false', details: {} });
    await expect(mgr.getCompatibility('7.16')).resolves.toEqual({ compatible: true, status: 'TRUE', details: { status: 'TRUE', reason: 'x' } });
    await expect(mgr.getCompatibility('7.16')).resolves.toEqual({ compatible: true, status: 'true', details: {} });
    // This package's result passes through as it is.
    const full = { compatible: true, status: 'true', details: { status: 'true' } };
    (mgr as unknown as { adapter: unknown }).adapter = { getCompatibility: async () => full };
    await expect(mgr.getCompatibility()).resolves.toBe(full);
  });
});

// ── setAllowMotionControl and RobotState.access.rw8 ───────────────────────────

describe('setAllowMotionControl updates RobotState.access.rw8 from the call', () => {
  function rw8Manager(refuse = false): { mgr: RobotManager; wire: string[] } {
    const wire: string[] = [];
    const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    const a = adapter as unknown as Record<string, unknown>;
    a.writeAccessMode = 'controlstation';
    a.req = async (method: string, p: string, fields?: Record<string, string>) => {
      wire.push(fields ? `${method} ${p} ${new URLSearchParams(fields).toString()}` : `${method} ${p}`);
      if (refuse && p === '/rw/controlstation/allowmotioncontrol') {
        throw new RwsError('Refused', 'UNKNOWN', 403);
      }
      return '';
    };
    // The declaration as a poll last read it: off.
    a.allowMotionControlKnown = false;
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown>; accessSnapshot(): unknown };
    m.adapter = adapter;
    m._state.connected = true;
    m._state.access = m.accessSnapshot();
    return { mgr, wire };
  }

  it('true right after a successful true, false after a successful false, and listeners are told', async () => {
    const { mgr, wire } = rw8Manager();
    expect(mgr.state.access.rw8?.allowMotionControl).toBe(false);
    let changes = 0;
    mgr.onDidChange(() => { changes++; });
    await mgr.setAllowMotionControl(true);
    expect(wire).toContain('POST /rw/controlstation/allowmotioncontrol allow-motion-control=true');
    expect(mgr.state.access.rw8?.allowMotionControl).toBe(true);
    expect(changes).toBeGreaterThan(0);
    await mgr.setAllowMotionControl(false);
    expect(mgr.state.access.rw8?.allowMotionControl).toBe(false);
  });

  it('a refused write leaves the state as it was', async () => {
    const { mgr } = rw8Manager(true);
    await expect(caught(mgr.setAllowMotionControl(true))).resolves.toBeInstanceOf(RwsError);
    expect(mgr.state.access.rw8?.allowMotionControl).toBe(false);
  });
});

// ── loadProgram: the name the controller gave the module ──────────────────────

describe('renamedOnLoad: a module the controller listed under another name', () => {
  it('finds a new <NAME>#<n>; none while the module is listed under its own name (ignoring case)', () => {
    expect(renamedOnLoad('Probe', ['BASE'], ['BASE', 'Probe#2'])).toBe('Probe#2');
    expect(renamedOnLoad('Probe', ['BASE'], ['BASE', 'PROBE#2'])).toBe('PROBE#2');
    expect(renamedOnLoad('Probe', ['BASE', 'Probe#2'], ['BASE', 'Probe#2', 'Probe#3'])).toBe('Probe#3');
    expect(renamedOnLoad('Probe', [], ['BASE', 'Probe'])).toBeNull();
    expect(renamedOnLoad('Probe', [], ['BASE', 'probe', 'Probe#2'])).toBeNull();
    expect(renamedOnLoad('Probe', [], ['BASE', 'Probe2', 'Probe#x', 'Probe#'])).toBeNull();
    expect(renamedOnLoad('Probe', ['Probe#2'], ['Probe#2'])).toBeNull();
  });
});

describe('loadProgram and unloadModule: what the controller did, read back', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rws-load-'));
    file = path.join(dir, 'Probe.mod');
    fs.writeFileSync(file, 'MODULE Probe\n  VAR num probe := 0;\n  PROC main()\n  ENDPROC\nENDMODULE\n');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  interface Script {
    lists: string[][];
    loadFails?: RwsError;
    resetFails?: RwsError;
    unloadFails?: RwsError;
    requestFails?: RwsError;
    running?: boolean;
    stopFails?: RwsError;
    log?: ElogMessage[];
    logFails?: boolean;
  }

  /** An adapter of another make (no package tag), every call recorded. */
  function adapterFor(s: Script): { adapter: IRWSAdapter; wire: string[] } {
    const wire: string[] = [];
    const adapter = {
      requestMastership: async (d: string) => { wire.push(`request ${d}`); if (s.requestFails) { throw s.requestFails; } },
      releaseMastership: async (d: string) => { wire.push(`release ${d}`); },
      getRapidExecutionState: async () => (s.running ? 'running' : 'stopped'),
      stopRapid: async () => { wire.push('stop'); if (s.stopFails) { throw s.stopFails; } },
      listModules: async (t: string) => { wire.push(`list ${t}`); return s.lists.length > 1 ? s.lists.shift()! : s.lists[0]; },
      unloadModule: async (t: string, m: string) => { wire.push(`unload ${t} ${m}`); if (s.unloadFails) { throw s.unloadFails; } },
      uploadFile: async (p: string) => { wire.push(`upload ${p}`); },
      loadModule: async (t: string, p: string) => { wire.push(`load ${t} ${p}`); if (s.loadFails) { throw s.loadFails; } },
      resetRapid: async () => { wire.push('pp to main'); if (s.resetFails) { throw s.resetFails; } },
      getEventLog: async () => {
        wire.push('read event log');
        if (s.logFails) { throw new RwsError('no log', 'UNKNOWN', 500); }
        return s.log ?? [];
      },
    };
    return { adapter: adapter as unknown as IRWSAdapter, wire };
  }

  function managerOf(adapter: IRWSAdapter, modulesByTask: Record<string, string[]> = {}): RobotManager {
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: IRWSAdapter; _state: Record<string, unknown> };
    m.adapter = adapter;
    Object.assign(m._state, { connected: true, modulesByTask, systemInfo: { name: 'IRB_1300', rwVersion: '7.21.4' } });
    return mgr;
  }

  const semanticError = (): RwsError => new RwsError('Semantic error', 'WRONG_MODE', 400, undefined, -1073442802, 'Semantic error');

  it('a failed PP to main names the module the controller loaded under another name', async () => {
    const { adapter, wire } = adapterFor({ lists: [['BASE'], ['BASE', 'Probe#2']], resetFails: semanticError() });
    const err = await caught(managerOf(adapter).loadProgram(file, 'T_ROB1'));
    expect(err.message).toMatch(/^loadProgram\(Probe\.mod into T_ROB1\) could not set the program pointer to main\. Done before it: /);
    expect(err.message).toContain('loaded module Probe into T_ROB1 as Probe#2, the name the controller gave it (unload it by that name).');
    expect(err.message).not.toContain('loaded module Probe into T_ROB1;');
    // The list after the load is the one already read: no extra read.
    expect(wire.filter(w => w === 'list T_ROB1')).toHaveLength(2);
  });

  it('a module listed under its own name is reported as before', async () => {
    const { adapter } = adapterFor({ lists: [['BASE'], ['BASE', 'Probe']], resetFails: semanticError() });
    const err = await caught(managerOf(adapter).loadProgram(file, 'T_ROB1'));
    expect(err.message).toContain('loaded module Probe into T_ROB1.');
    expect(err.message).not.toContain('the name the controller gave it');
  });

  it('a refused load is followed by one module-list read, which names a module loaded under another name', async () => {
    const refused = new RwsError('Refused', 'UNKNOWN', 400);
    const { adapter, wire } = adapterFor({ lists: [['BASE'], ['BASE', 'Probe#2']], loadFails: refused });
    const err = await caught(managerOf(adapter).loadProgram(file, 'T_ROB1'));
    expect(err.message).toMatch(/could not load module Probe into T_ROB1\. Done before it: uploaded Probe\.mod to \$HOME\/Probe\.mod; loaded module Probe into T_ROB1 as Probe#2, the name the controller gave it \(unload it by that name\)\./);
    expect(wire.filter(w => w === 'list T_ROB1')).toHaveLength(2);
    expect(wire.at(-1)).toBe('list T_ROB1');
  });

  it('a refused load with nothing renamed adds nothing', async () => {
    const { adapter } = adapterFor({ lists: [['BASE'], ['BASE']], loadFails: new RwsError('Refused', 'UNKNOWN', 400) });
    const err = await caught(managerOf(adapter).loadProgram(file, 'T_ROB1'));
    expect(err.message).toMatch(/could not load module Probe into T_ROB1\. Done before it: uploaded Probe\.mod to \$HOME\/Probe\.mod\. /);
  });

  it('a load that succeeds under another name is logged as a warning', async () => {
    const { adapter } = adapterFor({ lists: [['BASE'], ['BASE', 'Probe#2']] });
    const mgr = managerOf(adapter);
    await mgr.loadProgram(file, 'T_ROB1', { resetPP: false });
    expect(warnings.some(w => w.includes('loaded module Probe into T_ROB1 as Probe#2'))).toBe(true);
    expect(mgr.state.modulesByTask.T_ROB1).toEqual(['BASE', 'Probe#2']);
  });

  /** A controller's 403 -1073414145 answer, classified as the adapters classify it. */
  const refusedWith = (msg: string, path: string): RwsError => {
    const body = JSON.stringify({ status: { code: -1073414145, msg } });
    const info = classifyControllerError({ httpStatus: 403, body, method: 'POST', path });
    return new RwsError(info.message, info.code, 403, body, info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
  };

  /** The controller's 403 -1073414145 answer to an unload (RobotWare 7.21.4). */
  const reasonInLog = (): RwsError => refusedWith('Reason written in elog code:-1073414145 icode:-1', '/rw/rapid/tasks/T_ROB1/unloadmod');

  const elog = (seqnum: number, code: number, title: string, desc: string, actions = ''): ElogMessage => ({
    seqnum, code, msgtype: 3, timestamp: '', srcName: '', title, desc, causes: '', consequences: '', actions, args: [],
  });

  it('an unload refused with -1073414145 carries the newest event-log message and the listed name', async () => {
    const log = [elog(7, 10002, 'Older', 'not this one'), elog(9, 40045, 'Name not unique', 'The name is used twice.', 'Rename one.')];
    const { adapter, wire } = adapterFor({ lists: [['BASE', 'Probe#2']], unloadFails: reasonInLog(), log });
    const err = await caught(managerOf(adapter, { T_ROB1: ['BASE', 'Probe#2'] }).unloadModule('T_ROB1', 'Probe'));
    expect(err.controllerCode).toBe(-1073414145);
    expect(err.httpStatus).toBe(403);
    expect(err.refusal?.sentence).toBe("Controller 'IRB_1300' refused to unload module Probe from T_ROB1 and wrote its reason in the event log. "
      + 'The newest event-log message, which may not be about this unload, is 40045 "Name not unique": The name is used twice. '
      + 'The task lists the module as Probe#2, the name the controller gave it on load; unload it by that name.');
    expect(err.refusal?.fix).toBe('Unload the module by the name the task lists, Probe#2.');
    expect(err.message.startsWith(err.refusal!.sentence)).toBe(true);
    expect(err.message).toContain('code -1073414145');
    expect(err.message).not.toContain('gave no reason this client can explain');
    // Read only: the unload once, then one event-log read.
    expect(wire.filter(w => w.startsWith('unload'))).toEqual(['unload T_ROB1 Probe']);
    expect(wire.filter(w => w === 'read event log')).toHaveLength(1);
  });

  it('replays the recorded name clash: a module loaded as <NAME>#2, then the unload by its own name', async () => {
    // RobotWare 7.21.4 virtual controller 'IRB1600_6_120_5', 2026-10-12: a
    // test module declared a variable named like the module, ignoring case
    // (here ZZ_CLASH and zz_clash stand in for the names of that run). The
    // controller listed it as <NAME>#2, and unloading that name cleaned up.
    // The 400 and 403 answers are the recorded ones. The event log was not
    // read in that run, so it is empty here.
    const clash = path.join(dir, 'ZZ_CLASH.mod');
    fs.writeFileSync(clash, 'MODULE ZZ_CLASH\n  VAR num zz_clash := 0;\n  PROC main()\n    WHILE TRUE DO\n      zz_clash := zz_clash + 1;\n      WaitTime 0.2;\n    ENDWHILE\n  ENDPROC\nENDMODULE\n');
    const semantic = (() => {
      const body = JSON.stringify({ status: { code: -1073442802, msg: 'Semantic error' } });
      const info = classifyControllerError({ httpStatus: 400, body, method: 'POST', path: '/rw/rapid/execution/resetpp' });
      return new RwsError(info.message, info.code, 400, body, info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
    })();
    const s: Script = { lists: [['BASE'], ['BASE', 'ZZ_CLASH#2']], resetFails: semantic };
    const { adapter, wire } = adapterFor(s);
    const mgr = managerOf(adapter);
    (mgr as unknown as { _state: { systemInfo: { name: string } } })._state.systemInfo.name = 'IRB1600_6_120_5';

    const load = await caught(mgr.loadProgram(clash, 'T_ROB1'));
    expect(load.code).toBe('WRONG_MODE');
    expect(load.message).toContain('loaded module ZZ_CLASH into T_ROB1 as ZZ_CLASH#2, the name the controller gave it (unload it by that name).');
    expect(load.message).toContain('refused to set the program pointer to Main: the loaded RAPID program has semantic errors');
    expect(load.message).not.toContain('loaded module ZZ_CLASH into T_ROB1;');

    s.unloadFails = reasonInLog();
    const unload = await caught(mgr.unloadModule('T_ROB1', 'ZZ_CLASH'));
    expect(unload.httpStatus).toBe(403);
    expect(unload.controllerCode).toBe(-1073414145);
    expect(unload.refusal?.sentence).toBe("Controller 'IRB1600_6_120_5' refused to unload module ZZ_CLASH from T_ROB1 and wrote its reason in the event log. "
      + 'The event log has no message. The task lists the module as ZZ_CLASH#2, the name the controller gave it on load; unload it by that name.');
    expect(unload.refusal?.fix).toBe('Unload the module by the name the task lists, ZZ_CLASH#2.');
    expect(unload.message).not.toContain('gave no reason this client can explain');
    expect(wire.filter(w => w.startsWith('unload'))).toEqual(['unload T_ROB1 ZZ_CLASH']);
  });

  it('when the event log cannot be read, the sentence says so and the controller\'s answer is kept', async () => {
    const { adapter } = adapterFor({ lists: [['BASE']], unloadFails: reasonInLog(), logFails: true });
    const err = await caught(managerOf(adapter, { T_ROB1: ['BASE', 'Other'] }).unloadModule('T_ROB1', 'Other'));
    expect(err.refusal?.sentence).toMatch(/wrote its reason in the event log\. The event log could not be read\.$/);
    expect(err.refusal?.fix).toBe("Read the reason in the controller's event log.");
    expect(err.controllerCode).toBe(-1073414145);
  });

  it('other unload refusals keep their own explanation, with no event-log read', async () => {
    const other = new RwsError('Refused', 'UNKNOWN', 403, undefined, -1073445881, 'Rejected');
    const { adapter, wire } = adapterFor({ lists: [['BASE']], unloadFails: other });
    const err = await caught(managerOf(adapter).unloadModule('T_ROB1', 'Probe'));
    expect(err).toBe(other);
    expect(wire).not.toContain('read event log');
  });

  it('the newest event-log message is context: its own actions do not become the fix', async () => {
    const log = [elog(9, 10140, 'Speed reduced', 'The speed was reduced.', 'Check the speed setting.')];
    const { adapter } = adapterFor({ lists: [['BASE', 'Probe']], unloadFails: reasonInLog(), log });
    const err = await caught(managerOf(adapter, { T_ROB1: ['BASE', 'Probe'] }).unloadModule('T_ROB1', 'Probe'));
    expect(err.refusal?.sentence).toContain('The newest event-log message, which may not be about this unload, is 10140 "Speed reduced"');
    expect(err.refusal?.fix).toBe("Read the reason in the controller's event log.");
  });

  it('the same code with another text is not explained from the event log', async () => {
    const unknown = refusedWith('Unknown Error code:-1073414145 icode:-1', '/rw/rapid/tasks/T_ROB1/unloadmod');
    const { adapter, wire } = adapterFor({ lists: [['BASE']], unloadFails: unknown });
    const err = await caught(managerOf(adapter).unloadModule('T_ROB1', 'Probe'));
    expect(err).toBe(unknown);
    expect(err.message).not.toContain('wrote its reason in the event log');
    expect(wire).toEqual(['request rapid', 'unload T_ROB1 Probe', 'release rapid']);
  });

  it('a refused access request keeps its own explanation: no unload was sent and the event log is not read', async () => {
    // RobotWare 8's answer to a write-access request, here with the mode not known.
    const refused = refusedWith('Unknown Error code:-1073414145 icode:-4502', '/rw/controlstation/writeaccess/request');
    expect(refused.refusal?.kind).toBe('unknown');
    const { adapter, wire } = adapterFor({ lists: [['BASE']], requestFails: refused });
    const err = await caught(managerOf(adapter).unloadModule('T_ROB1', 'Probe'));
    expect(err).toBe(refused);
    expect(err.message).not.toContain('refused to unload module');
    expect(wire).toEqual(['request rapid']);
  });

  it('a refused stop keeps its own explanation, even with the event-log text: no unload was sent and the event log is not read', async () => {
    const refused = refusedWith('Reason written in elog code:-1073414145 icode:-1', '/rw/rapid/execution/stop');
    const { adapter, wire } = adapterFor({ lists: [['BASE']], running: true, stopFails: refused });
    const err = await caught(managerOf(adapter).unloadModule('T_ROB1', 'Probe', { stopIfRunning: true }));
    expect(err).toBe(refused);
    expect(err.message).not.toContain('refused to unload module');
    expect(wire).toEqual(['request rapid', 'stop', 'release rapid']);
  });

  it('loadProgram: a refused access request is not explained as a refused unload', async () => {
    const refused = refusedWith('Reason written in elog code:-1073414145 icode:-1', '/rw/mastership/rapid/request');
    const { adapter, wire } = adapterFor({ lists: [['BASE', 'Probe']], requestFails: refused });
    const err = await caught(managerOf(adapter).loadProgram(file, 'T_ROB1'));
    expect(err.message).not.toContain('refused to unload module');
    expect(wire).not.toContain('read event log');
  });
});

// ── setVirtualTimeRunning ─────────────────────────────────────────────────────

describe('the deprecated setVirtualTimeRunning refusal carries a refusal object', () => {
  it('kind unsupported, with the fix and nothing sent, on every surface', async () => {
    const e = virtualTimeRunningUnsupported();
    expect(e.code).toBe('UNSUPPORTED_OPERATION');
    expect(e.refusal).toMatchObject({ kind: 'unsupported', condition: 'none', grantor: 'nobody', generation: null });
    expect(e.refusal?.fix).toBe("Pause and resume the virtual clock from RobotStudio's Simulation tab.");
    expect(e.message).toBe(e.refusal?.sentence);
    expect(e.message).toMatch(/^setVirtualTimeRunning: nothing was sent\./);
    const err = await caught(new RobotManager().setVirtualTimeRunning(true));
    expect(err.refusal?.kind).toBe('unsupported');
    const c2 = await caught(new RwsClient2('http://127.0.0.1:1', 'u', 'p').setVirtualTimeRunning(false));
    expect(c2.refusal?.kind).toBe('unsupported');
  });
});

// ── jog: -1073435864 from any adapter ─────────────────────────────────────────

describe('a jog refused with -1073435864 is explained from the code, whichever adapter sent it', () => {
  const JOG: JogParams = { mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 };

  function otherMake(jogError: RwsError): IRWSAdapter {
    return {
      requestMastership: async () => {},
      releaseMastership: async () => {},
      getOperationMode: async () => 'MANR',
      getControllerState: async () => 'motoron',
      // Not tagged as the package's adapters tag their jog POST.
      jog: async () => { throw jogError; },
    } as unknown as IRWSAdapter;
  }

  function managerWith(adapter: IRWSAdapter): RobotManager {
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: IRWSAdapter; _state: Record<string, unknown> };
    m.adapter = adapter;
    Object.assign(m._state, { connected: true });
    return mgr;
  }

  it('an untagged refusal with the code and no refusal object: GRANT_DENIED, motion-control-off', async () => {
    const raw = new RwsError('Operation rejected', 'UNKNOWN', 403, undefined, -1073435864, 'Operation rejected');
    const err = await caught(managerWith(otherMake(raw)).jog(JOG));
    expect(err.code).toBe('GRANT_DENIED');
    expect(err.controllerCode).toBe(-1073435864);
    expect(err.refusal).toMatchObject({ kind: 'motion-control-off', condition: 'motion-control', generation: 'rw8', grantor: 'this-tool' });
    expect(err.refusal?.sentence).toMatch(/^The controller refused the jog: motion control is not allowed for this control station\./);
    expect(err.refusal?.sentence).not.toContain('setAllowMotionControl');
    expect(err.refusal?.fix).toContain('setAllowMotionControl(true)');
    expect(err.refusal?.remedy).toMatchObject({ kind: 'declare-motion-control', call: { method: 'setAllowMotionControl', allow: true } });
    expect(err.refusal?.otherRemedies?.map(r => r.kind)).toEqual(['do-at-pendant']);
    expect(err.message).toContain('Controller: Operation rejected');
  });

  it('a refusal already explained as motion-control-off is passed on unchanged', async () => {
    const body = JSON.stringify({ status: { code: -1073435864, msg: 'Unspecified Error code:-1073435864' } });
    const info = classifyControllerError({ httpStatus: 403, body, method: 'POST', path: '/rw/motionsystem/ROB_1/jog' });
    const explained = new RwsError(info.message, info.code, 403, body, info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
    expect(explained.refusal?.kind).toBe('motion-control-off');
    const err = await caught(managerWith(otherMake(explained)).jog(JOG));
    expect(err).toBe(explained);
  });

  it('another code from an adapter of another make is not called motion-control-off', async () => {
    const raw = new RwsError('Rejected', 'UNKNOWN', 403, undefined, -1073445881, 'Rejected');
    const err = await caught(managerWith(otherMake(raw)).jog(JOG));
    expect(err.refusal?.kind).not.toBe('motion-control-off');
  });
});
