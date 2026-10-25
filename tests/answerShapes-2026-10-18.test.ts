import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';

// Three answers whose shape the client did not read, from RobotWare 6.16.03,
// 7.21.4 and 8.2.1 virtual controllers (2026-10-18):
//
// - GET /rw/rapid/tasks/{task}/pcp: RW 7.21.4 spells the motionpointer
//   entry's start `begposition` and its module `modulename`; the progpointer
//   entry spells them `beginposition` and `modulemame`. RW 6.16.03 also sends
//   the motionpointer's start as `begposition`, with its module under
//   `modulemame`. ABB's RAPID service says only v=2.2 sends `beginposition`
//   in place of `begposition`. ABB's RWS 1.0 page keeps the motionpointer's
//   start under `beginposition` and puts a `begposition` span where the end
//   goes, so `beginposition` is read first.
// - GET /uas/roles/{role}/description: RW 7.21.4 and 8.2.1 class the entry
//   `group-description`, where ABB's example shows `role-description`.
// - RWS 1.0 GET /ctrl/%24{NAME}?json=1: RW 6.16.03 puts the ctrl-env value
//   under `_value`.
//
// Each body says where its shape comes from: a logged answer, ABB's page, or
// a spelling swapped to test the wider read. The values are neutral.

/** A fake RwsClient for RWS1Adapter: answers each GET from `respond`; every URL asked is recorded. */
function fakeRws1(respond: (url: string) => { status: number; body: string }): { client: RwsClient; urls: string[] } {
  const urls: string[] = [];
  const client = {
    request: async (_m: string, url: string) => { urls.push(url); return respond(url); },
  } as unknown as RwsClient;
  return { client, urls };
}

/** A local server for RwsClient2 that answers every request with one body. */
async function withServer(
  type: string, body: string,
  run: (client: RwsClient2, urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? '');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p'), urls);
  } finally { server.close(); }
}

const HAL = 'application/hal+json;v=2.0';
const XHTML = 'application/xhtml+xml;v=2.0';

const caught = (p: Promise<unknown>): Promise<RwsError> => p.then(
  () => { throw new Error('expected a refusal'); },
  (e: unknown) => e as RwsError,
);

// ─── The pcp entries ─────────────────────────────────────────────────────────

/** RWS 2.0 hal+json, as RW 7.21.4 answers with a motion instruction run. */
const PCP_HAL = JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1/rw/rapid/' }, self: { href: 'tasks/T_ROB1/pcp' } },
  status: { code: 294912 },
  state: [
    { _type: 'pcp-info', _title: 'progpointer', beginposition: '20,5', endposition: '20,30', modulemame: 'Module1', routinename: 'main', changecount: '4294967295', executiontype: 'normal' },
    { _type: 'pcp-info', _title: 'motionpointer', begposition: '19,9', endposition: '19,40', modulename: 'Module1', routinename: 'main', changecount: '4294967295' },
  ],
});

/** Not a logged answer: the same two entries with the spellings swapped, to test the wider read. */
const PCP_HAL_SWAPPED = JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1/rw/rapid/' }, self: { href: 'tasks/T_ROB1/pcp' } },
  status: { code: 294912 },
  state: [
    { _type: 'pcp-info', _title: 'progpointer', begposition: '20,5', endposition: '20,30', modulename: 'Module1', routinename: 'main', changecount: '4294967295', executiontype: 'normal' },
    { _type: 'pcp-info', _title: 'motionpointer', beginposition: '19,9', endposition: '19,40', modulemame: 'Module1', routinename: 'main', changecount: '4294967295' },
  ],
});

/**
 * RWS 1.0 `?json=1`, as RW 6.16.03 answers with a motion instruction run: the
 * entries under `_embedded._state`, typed `rap-text`. The progpointer entry
 * spells the start `beginposition`; the motionpointer entry spells it
 * `begposition` and carries an error link beside its position. Both put the
 * module under `modulemame`.
 */
const PCP_RWS1_JSON = JSON.stringify({
  _links: { base: { href: 'http://127.0.0.1/rw/rapid/' } },
  _embedded: { _state: [
    { _type: 'rap-text', _title: 'progpointer', _links: { self: { href: 'tasks/T_ROB1/pcp?json=1' } }, beginposition: '20,5', endposition: '20,30', modulemame: 'Module1', routinename: 'main', changecount: '-1', executiontype: 'normal' },
    { _type: 'rap-text', _title: 'motionpointer', _links: { error: { href: 'http://127.0.0.1/rw/retcode?code=?json=1' } }, begposition: '19,9', endposition: '19,40', modulemame: 'Module1', routinename: 'main', changecount: '-1' },
  ] },
});

/** Not a logged answer: the RWS 1.0 body with each entry's spellings swapped, to test the wider read. */
const PCP_RWS1_JSON_SWAPPED = JSON.stringify({
  _links: { base: { href: 'http://127.0.0.1/rw/rapid/' } },
  _embedded: { _state: [
    { _type: 'rap-text', _title: 'progpointer', _links: { self: { href: 'tasks/T_ROB1/pcp?json=1' } }, begposition: '20,5', endposition: '20,30', modulename: 'Module1', routinename: 'main', changecount: '-1', executiontype: 'normal' },
    { _type: 'rap-text', _title: 'motionpointer', beginposition: '19,9', endposition: '19,40', modulename: 'Module1', routinename: 'main', changecount: '-1' },
  ] },
});

/**
 * Not a logged answer: XHTML laid out as ABB's RWS 1.0 page lays it out, with
 * ABB's progpointer entry. The motionpointer entry carries its start under
 * `begposition` and its end under `endposition`, as RW 7.21.4 sends them in
 * hal+json.
 */
const PCP_XHTML_BEGPOSITION = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rapid</title><base href="http://127.0.0.1/rw/rapid/"/></head><body><div class="state"><a href="tasks/T_ROB1/pcp" rel="self"></a><a href="tasks/T_ROB1/pcp?action=show" rel="action"></a><ul>'
  + '<li class="pcp-info" title="progpointer"><span class="beginposition">20,5</span><span class="endposition">20,30</span><span class="modulemame">Module1</span><span class="routinename">main</span><span class="changecount">-1</span><span class="executiontype">normal</span></li>'
  + '<li class="pcp-info" title="motionpointer"><span class="begposition">19,9</span><span class="endposition">19,40</span><span class="modulename">Module1</span><span class="routinename">main</span><span class="changecount">-1</span></li>'
  + '</ul></div></body></html>';

/**
 * ABB's RWS 1.0 example answer (Rev M "Get RAPID task Motion&Program pointer
 * positions"). The motionpointer entry has `beginposition` 9,8 and a
 * `begposition` span 9,20, the progpointer's end; the start is 9,8.
 */
const PCP_REV_M_XHTML = '<?xml version="1.0" encoding="UTF-8"?> <html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>rapid</title> <base href="http://localhost:7777/rw/rapid/"/> </head> <body> <div class="state"> <a href="tasks/T_ROB1/pcp" rel="self"> </a> <a href="tasks/T_ROB1/pcp?action=show" rel="action"> </a> <ul>'
  + ' <li class="pcp-info" title="progpointer"> <span class="beginposition">9,8</span> <span class="endposition">9,20</span> <span class="modulemame">module_test</span> <span class="routinename">main</span> <span class="changecount">-1</span> <span class="executiontype">normal</span> </li>'
  + ' <li class="pcp-info" title="motionpointer"> <span class="beginposition">9,8</span> <span class="begposition">9,20</span> <span class="modulemame">module_test</span> <span class="routinename">main</span> <span class="executiontype">-1</span> </li>'
  + ' </ul> </div> </body> </html>';

const MP = { module: 'Module1', routine: 'main', row: 19, col: 9 };
const PP = { module: 'Module1', routine: 'main', row: 20, col: 5 };
const REV_M = { module: 'module_test', routine: 'main', row: 9, col: 8 };

describe('pcp: begposition / beginposition and modulename / modulemame on both pointers', () => {
  it('RWS 2.0: the motion pointer reads begposition and modulename', async () => {
    await withServer(HAL, PCP_HAL, async (c, urls) => {
      await expect(c.getMotionPointer('T_ROB1')).resolves.toEqual(MP);
      await expect(c.getProgramPointer('T_ROB1')).resolves.toEqual({ ...PP, executionType: 'normal' });
      expect([...new Set(urls)]).toEqual(['/rw/rapid/tasks/T_ROB1/pcp']);
    });
  });

  it('RWS 2.0: each pointer reads either spelling', async () => {
    await withServer(HAL, PCP_HAL_SWAPPED, async c => {
      await expect(c.getMotionPointer('T_ROB1')).resolves.toEqual(MP);
      await expect(c.getProgramPointer('T_ROB1')).resolves.toEqual({ ...PP, executionType: 'normal' });
    });
  });

  it('RWS 1.0 ?json=1: both pointers read as RW 6.16.03 spells them (motion pointer: begposition, modulemame)', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: PCP_RWS1_JSON }));
    const a = new RWS1Adapter(client);
    await expect(a.getMotionPointer('T_ROB1')).resolves.toEqual(MP);
    await expect(a.getProgramPointer('T_ROB1')).resolves.toEqual(PP);
    expect(urls).toEqual(['/rw/rapid/tasks/T_ROB1/pcp?json=1', '/rw/rapid/tasks/T_ROB1/pcp?json=1']);
  });

  it('RWS 1.0 ?json=1: each pointer reads either spelling', async () => {
    const a = new RWS1Adapter(fakeRws1(() => ({ status: 200, body: PCP_RWS1_JSON_SWAPPED })).client);
    await expect(a.getMotionPointer('T_ROB1')).resolves.toEqual(MP);
    await expect(a.getProgramPointer('T_ROB1')).resolves.toEqual(PP);
  });

  it('RWS 1.0 XHTML: the motion pointer reads the begposition span', async () => {
    const { client } = fakeRws1(() => ({ status: 200, body: PCP_XHTML_BEGPOSITION }));
    await expect(new RWS1Adapter(client).getMotionPointer('T_ROB1')).resolves.toEqual(MP);
  });

  it('RWS 2.0 XHTML: the motion pointer reads the begposition span', async () => {
    await withServer(XHTML, PCP_XHTML_BEGPOSITION, async c => {
      await expect(c.getMotionPointer('T_ROB1')).resolves.toEqual(MP);
    });
  });

  it('ABB\'s RWS 1.0 example: beginposition is read before the begposition span', async () => {
    const { client } = fakeRws1(() => ({ status: 200, body: PCP_REV_M_XHTML }));
    await expect(new RWS1Adapter(client).getMotionPointer('T_ROB1')).resolves.toEqual(REV_M);
    await withServer(XHTML, PCP_REV_M_XHTML, async c => {
      await expect(c.getMotionPointer('T_ROB1')).resolves.toEqual(REV_M);
      await expect(c.getProgramPointer('T_ROB1')).resolves.toEqual({ ...REV_M, executionType: 'normal' });
    });
  });
});

// ─── The role description ────────────────────────────────────────────────────

/** hal+json, as RW 7.21.4 and 8.2.1 answer an administrator. */
const ROLE_DESCRIPTION_HAL = JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1/uas/roles/Operator/description/' }, self: { href: '' } },
  state: [{ _type: 'group-description', _title: 'description', description: 'Operator role' }],
});

describe('getUasRoleDescription: group-description as well as role-description', () => {
  it('reads the description from the group-description entry', async () => {
    await withServer(HAL, ROLE_DESCRIPTION_HAL, async (c, urls) => {
      await expect(c.getUasRoleDescription('Operator')).resolves.toBe('Operator role');
      expect(urls).toEqual(['/uas/roles/Operator/description']);
    });
  });

  it('an answer with neither class is still PARSE_ERROR', async () => {
    const other = JSON.stringify({
      _links: { base: { href: 'https://127.0.0.1/uas/roles/Operator/description/' } },
      state: [{ _type: 'user-description', _title: 'description', description: 'Operator role' }],
    });
    await withServer(HAL, other, async c => {
      await expect(caught(c.getUasRoleDescription('Operator'))).resolves.toMatchObject({ code: 'PARSE_ERROR' });
    });
  });
});

// ─── The environment variable on RWS 1.0 ─────────────────────────────────────

/** RWS 1.0 `?json=1`, as RW 6.16.03 answers GET /ctrl/%24TEMP?json=1. */
const ENV_RWS1_JSON = JSON.stringify({
  _links: { base: { href: 'http://127.0.0.1/ctrl/%24TEMP/' } },
  _embedded: { status: { code: 294912 }, _state: [{ _type: 'ctrl-env', _title: '$TEMP', _value: 'C:/VC/TEMP' }] },
});

describe('RWS 1.0 getEnv: the ctrl-env value under _value', () => {
  it('returns the _value of the ctrl-env entry', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: ENV_RWS1_JSON }));
    await expect(new RWS1Adapter(client).getEnv('$TEMP')).resolves.toBe('C:/VC/TEMP');
    expect(urls).toEqual(['/ctrl/%24TEMP?json=1']);
  });

  it('a value span is still read first, and an entry with neither is still PARSE_ERROR', async () => {
    const both = JSON.stringify({ _embedded: { _state: [{ _type: 'ctrl-env', _title: '$TEMP', value: '/hd0a/TEMP', _value: 'C:/VC/TEMP' }] } });
    await expect(new RWS1Adapter(fakeRws1(() => ({ status: 200, body: both })).client).getEnv('TEMP')).resolves.toBe('/hd0a/TEMP');
    const none = JSON.stringify({ _embedded: { _state: [{ _type: 'ctrl-env', _title: '$TEMP' }] } });
    await expect(caught(new RWS1Adapter(fakeRws1(() => ({ status: 200, body: none })).client).getEnv('TEMP')))
      .resolves.toMatchObject({ code: 'PARSE_ERROR' });
  });
});
