import { describe, it, expect, beforeEach } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import { classifyControllerError } from '../src/ControllerError.js';
import { setLogger } from '../src/Logger.js';
import { RwsError } from '../src/types.js';
import { ALL_TABLES, buildPath, evidenceOf } from '../src/paths/index.js';
import type { PathSpec } from '../src/paths/index.js';

/**
 * Findings of the RW 6.16.03 write run of 2026-10-13. The bodies are the
 * controller's answers from that run's wire logs; where the log kept only a
 * preview, the end of the message is completed and says so.
 */

beforeEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

interface Call { what: string; body?: string }
function fake(respond?: (method: string, url: string, body?: string) => { status: number; body: string } | undefined): { calls: Call[]; adapter: RWS1Adapter } {
  const calls: Call[] = [];
  const client = {
    requestMastership: async (d: string) => { calls.push({ what: `mastership-request ${d}` }); },
    releaseMastership: async (d: string) => { calls.push({ what: `mastership-release ${d}` }); },
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return respond?.(method, url, body) ?? { status: 204, body: '' };
    },
  };
  return { calls, adapter: new RWS1Adapter(client as unknown as RwsClient) };
}
const rw6 = { generation: 'rw6' as const };

describe('saveProgram with no program name set (500 -1073442812)', () => {
  // RW 6.16.03: POST /rw/rapid/tasks/T_ROB1/program?action=save, no .pgf loaded.
  // The log's preview ends inside the build path; the message after it is the
  // one the run recorded ("org_code: -544 new_code: 0xc0049004;").
  const body = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rw</title></head><body>'
    + '<div class="status"><span class="code">-1073442812</span><span class="msg">ERROR: C:\\BUILDAGENTS\\x\\rapi_ctrl.cpp[1] org_code: -544 new_code: 0xc0049004;</span></div></body></html>';
  it('is wrong-state with a sentence that says to load or name a program first', () => {
    const info = classifyControllerError({ httpStatus: 500, body, method: 'POST', path: '/rw/rapid/tasks/T_ROB1/program?action=save&json=1', context: rw6 });
    expect(info.controllerCode).toBe(-1073442812);
    expect(info.refusal?.kind).toBe('wrong-state');
    expect(info.code).not.toBe('UNKNOWN');
    expect(info.message).toMatch(/program name/i);
    expect(info.refusal?.fix).toMatch(/load .*program|name/i);
  });
});

describe('setNonMotionExecution refused for a missing option (403 code -1)', () => {
  const body = String.raw`{"_links":{"base": { "href": "http://127.0.0.1:42179/" }},"_embedded" :{ "status" : {"code":-1, "msg": "C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rws_motionsystem\\rws_resource_motionsystem.cpp[1512] Collision Detection is not opted during system setup code:-1 icode:-1"}, "_state":[  ] }}`;
  it('is option-missing, and the sentence names the option from the controller text', () => {
    const info = classifyControllerError({ httpStatus: 403, body, method: 'POST', path: '/rw/motionsystem/nonmotionexecution?action=set-mode&json=1', context: rw6 });
    expect(info.refusal?.kind).toBe('option-missing');
    expect(info.code).toBe('UNSUPPORTED_OPERATION');
    expect(info.refusal?.sentence).toContain('Collision Detection');
    expect(info.refusal?.missing).toContain('Collision Detection');
  });
});

describe('decompressPath of an invalid archive (400 -1073414146)', () => {
  const body = String.raw`{"_embedded" :{ "status" : {"code":-1073414146, "msg": "C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rapi_ctrl\\rapi_ctrl_resource.cpp[2478] Cannot decompress an uncompressed or an invalid file. -1073414146"}, "_state":[  ] }}`;
  it('is INVALID_ARGUMENT, not RESOURCE_NOT_FOUND', () => {
    const info = classifyControllerError({ httpStatus: 400, body, method: 'POST', path: '/ctrl/compress?action=dcomp&json=1', context: rw6 });
    expect(info.code).toBe('INVALID_ARGUMENT');
    expect(info.message).toMatch(/cannot decompress/i);
  });
});

describe('listEventLogDomains: counts the controller does not report are null', () => {
  // RW 6.16.03, 2026-10-13: GET /rw/elog?json=1 (two of its thirteen entries).
  const rw6Body = '{"_links":{"base": { "href": "http://127.0.0.1:42179/rw/elog/" }},"_embedded" :{  "_state":[  { "_links": { "self": { "href": "0?json=1"} }, "_type":"elog-domain-li", "_title":"0" } , { "_links": { "self": { "href": "15?json=1"} }, "_type":"elog-domain-li", "_title":"15" } ] }}';
  it('RWS 1.0: events and bufferSize are null, not 0', async () => {
    const { adapter } = fake(() => ({ status: 200, body: rw6Body }));
    await expect(adapter.listEventLogDomains()).resolves.toEqual([
      { domain: 0, events: null, bufferSize: null },
      { domain: 15, events: null, bufferSize: null },
    ]);
  });
  it('RWS 2.0: reported counts are numbers; an absent one is null', async () => {
    const a = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    (a as unknown as Record<string, unknown>).req = async () =>
      JSON.stringify({ _links: { base: { href: 'https://x/rw/elog/' } }, state: [
        { _type: 'elog-domain-li', _title: '0', numevts: '12', buffsize: '1000' },
        { _type: 'elog-domain-li', _title: '1' },
      ] });
    await expect(a.listEventLogDomains()).resolves.toEqual([
      { domain: 0, events: 12, bufferSize: 1000 },
      { domain: 1, events: null, bufferSize: null },
    ]);
  });
});

describe('RWS1Adapter.listBreakpoints reads the row and column ABB documents', () => {
  it('a breakpoint at row 8 column 5 is read back as row 8 column 5', async () => {
    const body = JSON.stringify({ _links: { base: { href: 'http://127.0.0.1:42179/rw/rapid/' } }, _embedded: { _state: [
      { _type: 'rap-program-breakpoint', _title: 'ZZ_RW6W', 'module-name': 'ZZ_RW6W', 'start-row': '8', 'start-col': '5', 'end-row': '8', 'end-col': '24' },
    ] } });
    const { adapter } = fake(() => ({ status: 200, body }));
    await expect(adapter.listBreakpoints('T_ROB1')).resolves.toEqual([{ module: 'ZZ_RW6W', row: 8, col: 5 }]);
  });
  it('an entry with a module and no row it can read is a PARSE_ERROR naming the fields, not row 0', async () => {
    const body = JSON.stringify({ _embedded: { _state: [{ _type: 'rap-x', 'module-name': 'ZZ_RW6W', where: '8' }] } });
    const { adapter } = fake(() => ({ status: 200, body }));
    const err = await adapter.listBreakpoints('T_ROB1').catch((e: unknown) => e as RwsError);
    expect(err).toMatchObject({ code: 'PARSE_ERROR' });
    expect((err as RwsError).message).toContain('where');
  });
});

describe("stepRapid on RWS 1.0: ABB's start form with a step execmode", () => {
  it('the path row has an RWS 1.0 side, built: POST /rw/rapid/execution?action=start', () => {
    const op = ALL_TABLES.rapid.stepRapid;
    expect(buildPath(op.rws1 as PathSpec)).toBe('/rw/rapid/execution?action=start');
    expect(op.rws1?.fields).toEqual(['regain', 'execmode', 'cycle', 'condition', 'stopatbp', 'alltaskbytsp']);
    expect(evidenceOf(op, 'rws1')).toBe('built');
    expect(evidenceOf(op, 'rws2')).toBe('live');
  });
  for (const [mode, execmode] of [['into', 'stepin'], ['over', 'stepover'], ['out', 'stepout']] as const) {
    it(`${mode}: execmode=${execmode} with the other five fields, under RAPID mastership`, async () => {
      const { calls, adapter } = fake();
      await adapter.stepRapid('T_ROB1', mode);
      expect(calls).toEqual([
        { what: 'mastership-request rapid' },
        { what: 'POST /rw/rapid/execution?action=start&json=1', body: `regain=continue&execmode=${execmode}&cycle=asis&condition=none&stopatbp=disabled&alltaskbytsp=false` },
        { what: 'mastership-release rapid' },
      ]);
    });
  }
  it('a bad mode is refused before anything is sent', async () => {
    const { calls, adapter } = fake();
    await expect(adapter.stepRapid('T_ROB1', 'back' as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
  });
});

describe('mastership with id and the mastership watchdog do not exist on RWS 1.0', () => {
  it('the path rows have no RWS 1.0 side and their notes say so', () => {
    for (const op of ['requestMastershipWithId', 'releaseMastershipWithId', 'resetMastershipWatchdog']) {
      const row = ALL_TABLES.systemMastership[op];
      expect(row.rws1).toBeUndefined();
      expect(row.note).toMatch(/RWS 1\.0: n\/a/);
    }
  });
  it('RobotManager on RobotWare 6: UNSUPPORTED_OPERATION with an unsupported refusal, nothing sent', async () => {
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = {};
    for (const call of [() => mgr.requestMastershipWithId('rapid'), () => mgr.releaseMastershipWithId('rapid', 1), () => mgr.resetMastershipWatchdog()]) {
      const err = await call().catch((e: unknown) => e as RwsError);
      expect(err).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      expect((err as RwsError).refusal).toMatchObject({ kind: 'unsupported', grantor: 'nobody' });
    }
  });
});
