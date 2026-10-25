import { describe, it, expect } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';
import { ALL_TABLES, buildPath } from '../src/paths/index.js';
import type { PathSpec } from '../src/paths/index.js';

/**
 * RWS 1.0 forms for members IRWSAdapter already declared: breakpoints, PP to
 * cursor, in-place module text, the subscription group update, pjoints and the
 * jog-unit selection.
 *
 * The URLs and fields are the `?action=show` forms RW 6.16.03 served on
 * 2026-09-29 (`program/breakpoint`, `pcp`, `modules/{module}`,
 * `/rw/motionsystem`), except where the form cannot be read (the breakpoint
 * `set` input has no name attributes) or no form exists (the group update):
 * there the names are the ones ABB's RWS 1.0 manual (Rev M) documents. The
 * listing and 404 bodies are the ones RW 6.16.03 answered that day.
 */

interface Call { what: string; body?: string }

function makeFake(respond?: (method: string, url: string, body?: string) => { status: number; body: string } | undefined): { calls: Call[]; client: RwsClient } {
  const calls: Call[] = [];
  const fake = {
    requestMastership: async (d: string) => { calls.push({ what: `mastership-request ${d}` }); },
    releaseMastership: async (d: string) => { calls.push({ what: `mastership-release ${d}` }); },
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return respond?.(method, url, body) ?? { status: 204, body: '' };
    },
  };
  return { calls, client: fake as unknown as RwsClient };
}

const wire = (calls: Call[]): Call[] => calls.filter(c => !c.what.startsWith('mastership-'));

/** RW 6.16.03, 2026-09-29: `GET /rw/rapid/tasks/T_ROB1/program/breakpoint?json=1`. */
const BREAKPOINTS_EMPTY_RW6 = '{ "_links" : { "base" : { "href" : "http://127.0.0.1:4578/rw/rapid/" },"self" : {"href":"tasks/T_ROB1/program/breakpoint?limit=120&json=1"} }, "_embedded" : {  "_state" : [ ] }}';

/** RW 6.16.03, 2026-09-29: the old `GET /rw/rapid/tasks/T_ROB1/breakpoints?json=1`, 404. */
const NOT_FOUND_RW6 = String.raw`{"_links":{"base": { "href": "http://127.0.0.1:4578/" }},"_embedded" :{ "status" : {"code":-1073414146, "msg": "C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rws_services\\rws_services.cpp[129] Resource not found code:-1073414146 icode:-1"}, "_state":[  ] }}`;

describe('RWS 1.0 path rows (G1)', () => {
  const P = { task: 'T_ROB1', module: 'M1', mechunit: 'ROB_1', group: '2' };
  const url = (domain: string, op: string): string =>
    buildPath(ALL_TABLES[domain][op].rws1 as PathSpec, P);

  it('each operation has the RWS 1.0 URL the controller form (or ABB manual) gives', () => {
    expect(url('rapid', 'listBreakpoints')).toBe('/rw/rapid/tasks/T_ROB1/program/breakpoint');
    expect(url('rapid', 'setBreakpoint')).toBe('/rw/rapid/tasks/T_ROB1/program/breakpoint?action=set');
    expect(url('rapid', 'setPPToCursor')).toBe('/rw/rapid/tasks/T_ROB1/pcp?action=set-pp-cursor');
    expect(url('rapid', 'setModuleText')).toBe('/rw/rapid/modules/M1?action=set-module-text');
    expect(url('rapid', 'setModuleTextRange')).toBe('/rw/rapid/modules/M1?action=set-text-range');
    expect(url('filesVision', 'updateSubscriptionGroup')).toBe('/subscription/2');
    expect(ALL_TABLES.filesVision.updateSubscriptionGroup.rws1?.method).toBe('PUT');
    expect(url('motion', 'getMechunitPjoints')).toBe('/rw/motionsystem/mechunits/ROB_1/pjoints');
    expect(url('motion', 'setMechunitForJogging')).toBe('/rw/motionsystem?action=set-mechunit');
    expect(ALL_TABLES.motion.setMechunitForJogging.rws1?.fields).toEqual(['mechunit-name']);
  });
});

describe('RWS1Adapter.listBreakpoints', () => {
  it('GETs program/breakpoint (not the task-root breakpoints that answers 404) and reads the recorded empty page', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: BREAKPOINTS_EMPTY_RW6 }));
    await expect(new RWS1Adapter(client).listBreakpoints('T_ROB1')).resolves.toEqual([]);
    expect(calls).toEqual([{ what: 'GET /rw/rapid/tasks/T_ROB1/program/breakpoint?json=1', body: undefined }]);
  });

  it('a refusal is a typed error, no longer an empty list', async () => {
    const { client } = makeFake(() => ({ status: 404, body: NOT_FOUND_RW6 }));
    const err = await new RWS1Adapter(client).listBreakpoints('T_ROB1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ httpStatus: 404, controllerCode: -1073414146 });
  });

  it('reads entries defensively and follows a next link on the same resource', async () => {
    // Only an empty list was captured; this entry shape is illustrative.
    const page1 = JSON.stringify({
      _links: { base: { href: 'http://127.0.0.1:4578/rw/rapid/' }, next: { href: 'tasks/T_ROB1/program/breakpoint?start=120&limit=120&json=1' } },
      _embedded: { _state: [{ _type: 'rap-breakpoint-li', module: 'M1', row: '12', column: '5' }] },
    });
    const page2 = JSON.stringify({
      _links: { base: { href: 'http://127.0.0.1:4578/rw/rapid/' } },
      _embedded: { _state: [{ _type: 'rap-breakpoint-li', modulename: 'M2', 'begin-position-row': '7' }] },
    });
    const { calls, client } = makeFake((_m, u) => ({ status: 200, body: u.includes('start=120') ? page2 : page1 }));
    await expect(new RWS1Adapter(client).listBreakpoints('T_ROB1')).resolves.toEqual([
      { module: 'M1', row: 12, col: 5 },
      { module: 'M2', row: 7 },
    ]);
    expect(calls.map(c => c.what)).toEqual([
      'GET /rw/rapid/tasks/T_ROB1/program/breakpoint?json=1',
      'GET /rw/rapid/tasks/T_ROB1/program/breakpoint?start=120&limit=120&json=1',
    ]);
  });

  it('does not follow a next link that leaves the breakpoint resource', async () => {
    const page = JSON.stringify({
      _links: { base: { href: 'http://127.0.0.1:4578/rw/rapid/' }, next: { href: '../panel/ctrlstate?json=1' } },
      _embedded: { _state: [] },
    });
    const { calls, client } = makeFake(() => ({ status: 200, body: page }));
    await new RWS1Adapter(client).listBreakpoints('T_ROB1');
    expect(calls).toHaveLength(1);
  });
});

describe('RWS1Adapter.setBreakpoint', () => {
  it('POSTs program/breakpoint?action=set with module, row, column (column defaults to 1) under RAPID mastership', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).setBreakpoint('T_ROB1', 'Main Module', 12);
    expect(calls).toEqual([
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/tasks/T_ROB1/program/breakpoint?action=set&json=1', body: 'module=Main%20Module&row=12&column=1' },
      { what: 'mastership-release rapid' },
    ]);
  });

  it('refuses a position that is not one before sending', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    for (const call of [() => a.setBreakpoint('T_ROB1', 'M1', 0), () => a.setBreakpoint('T_ROB1', 'M1', 1.5), () => a.setBreakpoint('T_ROB1', '', 3)]) {
      await expect(call()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toEqual([]);
  });
});

describe('RWS1Adapter.setPPToCursor', () => {
  it('POSTs pcp?action=set-pp-cursor (the ABB manual spelling; the form spelling set-pp-curser is refused) with module, line, column and routine under RAPID mastership', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).setPPToCursor('T_ROB1', 'MainModule', 12, 0, 'main');
    expect(calls).toEqual([
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/tasks/T_ROB1/pcp?action=set-pp-cursor&json=1', body: 'module=MainModule&line=12&column=0&routine=main' },
      { what: 'mastership-release rapid' },
    ]);
  });
});

describe('RWS1Adapter in-place module text', () => {
  it('setModuleText POSTs modules/{module}?action=set-module-text&task= with task and text, path only when given', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    await a.setModuleText('T_ROB1', 'M1', 'MODULE M1\n  VAR num n:=1;\nENDMODULE');
    await a.setModuleText('T_ROB1', 'M1', 'x', '$HOME/M1.mod');
    expect(wire(calls)).toEqual([
      { what: 'POST /rw/rapid/modules/M1?action=set-module-text&task=T_ROB1&json=1', body: 'task=T_ROB1&text=MODULE%20M1%0A%20%20VAR%20num%20n%3A%3D1%3B%0AENDMODULE' },
      { what: 'POST /rw/rapid/modules/M1?action=set-module-text&task=T_ROB1&json=1', body: 'task=T_ROB1&text=x&path=%24HOME%2FM1.mod' },
    ]);
  });

  it('setModuleTextRange POSTs ?action=set-text-range with the form\'s eight fields and its defaults', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    await a.setModuleTextRange('T_ROB1', 'M1', { startRow: 3, startCol: 1, endRow: 3, endCol: 10 }, 'n := 2;');
    await a.setModuleTextRange('T_ROB1', 'M1', { startRow: 3, startCol: 1, endRow: 3, endCol: 10 }, 'y', { replaceMode: 'Replace', queryMode: 'Try' });
    expect(wire(calls)).toEqual([
      { what: 'POST /rw/rapid/modules/M1?action=set-text-range&task=T_ROB1&json=1', body: 'task=T_ROB1&replace-mode=After&query-mode=Force&startrow=3&startcol=1&endrow=3&endcol=10&text=n%20%3A%3D%202%3B' },
      { what: 'POST /rw/rapid/modules/M1?action=set-text-range&task=T_ROB1&json=1', body: 'task=T_ROB1&replace-mode=Replace&query-mode=Try&startrow=3&startcol=1&endrow=3&endcol=10&text=y' },
    ]);
  });

  it('a refused write throws the controller\'s typed error', async () => {
    const { client } = makeFake(() => ({ status: 404, body: NOT_FOUND_RW6 }));
    const err = await new RWS1Adapter(client).setModuleText('T_ROB1', 'M1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ httpStatus: 404, controllerCode: -1073414146 });
  });
});

describe('RWS1Adapter.updateSubscriptionGroup', () => {
  it('PUTs /subscription/{id} with the create body shape, semicolons literal', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: '<html/>' }));
    const out = await new RWS1Adapter(client).updateSubscriptionGroup('/subscription/2', ['speedratio', { type: 'signal', name: 'sigA' }]);
    expect(out).toBe('<html/>');
    expect(calls).toEqual([{
      what: 'PUT /subscription/2',
      body: 'resources=1&1=/rw/panel/speedratio;speedratio&1-p=1&resources=2&2=/rw/iosystem/signals/sigA;state&2-p=1',
    }]);
  });

  it('refuses a group path that is not /subscription/{id}, an empty list and a bad signal name before sending', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    for (const call of [
      () => a.updateSubscriptionGroup('ws://127.0.0.1/poll/2', ['speedratio']),
      () => a.updateSubscriptionGroup('/subscription/2/../../rw/panel', ['speedratio']),
      () => a.updateSubscriptionGroup('/subscription/2', []),
      () => a.updateSubscriptionGroup('/subscription/2', [{ type: 'signal', name: 'a&b=c' }]),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toEqual([]);
  });

  it('a refused PUT throws the controller\'s typed error', async () => {
    const { client } = makeFake(() => ({ status: 404, body: NOT_FOUND_RW6 }));
    const err = await new RWS1Adapter(client).updateSubscriptionGroup('/subscription/9', ['speedratio']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ httpStatus: 404, controllerCode: -1073414146 });
  });
});

describe('RWS1Adapter motion forms', () => {
  it('setMechunitForJogging sends the form\'s mechunit-name field under motion mastership', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).setMechunitForJogging('ROB_1');
    expect(calls).toEqual([
      { what: 'mastership-request motion' },
      { what: 'POST /rw/motionsystem?action=set-mechunit&json=1', body: 'mechunit-name=ROB_1' },
      { what: 'mastership-release motion' },
    ]);
  });

  it('setMechunitForJogging refuses an empty or spaced name before anything is sent', async () => {
    const { calls, client } = makeFake();
    for (const name of ['', ' ', 'ROB 1']) {
      await expect(new RWS1Adapter(client).setMechunitForJogging(name)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toEqual([]);
  });

  it('getMechunitPjoints reads the ms-mechunit-pjoints entry as numbers', async () => {
    // Shape from ABB's Motion System page (item class ms-mechunit-pjoints,
    // j1..j6) in the RWS 1.0 ?json=1 envelope; no RWS 1.0 body is captured.
    const body = JSON.stringify({ _embedded: { _state: [{ _type: 'ms-mechunit-pjoints', _title: 'pjoints', j1: '0', j2: '-0.5', j3: '0.25', j4: '0', j5: '1.5', j6: '0' }] } });
    const { calls, client } = makeFake(() => ({ status: 200, body }));
    await expect(new RWS1Adapter(client).getMechunitPjoints()).resolves.toEqual({ j1: 0, j2: -0.5, j3: 0.25, j4: 0, j5: 1.5, j6: 0 });
    expect(calls[0].what).toBe('GET /rw/motionsystem/mechunits/ROB_1/pjoints?json=1');
  });

  it('getMechunitPjoints throws PARSE_ERROR on an answer with no entry, and the typed error on a refusal', async () => {
    const empty = makeFake(() => ({ status: 200, body: '{"_embedded":{"_state":[]}}' }));
    await expect(new RWS1Adapter(empty.client).getMechunitPjoints('ROB_1')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    const refused = makeFake(() => ({ status: 404, body: NOT_FOUND_RW6 }));
    await expect(new RWS1Adapter(refused.client).getMechunitPjoints('ROB_9')).rejects.toBeInstanceOf(RwsError);
  });
});
