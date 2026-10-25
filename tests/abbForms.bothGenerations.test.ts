import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsError } from '../src/types.js';
import { ALL_TABLES, buildPath, evidenceOf } from '../src/paths/index.js';
import type { PathSpec } from '../src/paths/index.js';
import { motionPointerFrom, parseBody } from '../src/commonReads.js';

/**
 * Reads and writes ABB documents on both generations, where the client had
 * only one side or read the wrong resource:
 *
 * - the motion pointer, read from the `motionpointer` entry of GET
 *   .../pcp (ABB RWS 1.0 "Get RAPID task Motion&Program pointer positions";
 *   RWS 2.0 RAPID service, /rw/rapid/tasks/{task}/pcp);
 * - the task selection on RWS 1.0 ("Get user modify from taskpanel");
 * - a controller environment variable on both ("Get Controller environment
 *   variable"; RWS 2.0 Controller service, /ctrl/${ENVNAME});
 * - the RWS 1.0 forms for signal simulation ("Update IO Signal State"),
 *   unblock ("Unblock Signals"), device state ("Update IO Device"), keyless
 *   motors-on ("Keyless motor ON") and the base frame ("Set Base Frame").
 *
 * Every new side is built from those pages; the tests pin the method, path,
 * query action and form fields the pages give, and the evidence each side
 * has. The task selection, the environment variable, keyless motors-on and
 * the base frame have run on RWS 1.0 since; the motion pointer and the three
 * RWS 1.0 I/O forms are still built.
 */

interface Call { what: string; body?: string }

function makeFake(
  respond?: (method: string, url: string, body?: string) => { status: number; body: string } | undefined,
): { calls: Call[]; client: RwsClient } {
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

const manager = (adapter: IRWSAdapter): RobotManager => {
  const mgr = new RobotManager();
  (mgr as unknown as { adapter: IRWSAdapter }).adapter = adapter;
  return mgr;
};

const caught = (p: Promise<unknown>): Promise<RwsError> => p.then(
  () => { throw new Error('expected a refusal'); },
  (e: unknown) => e as RwsError,
);

// ABB's RWS 1.0 example answer of "Get RAPID task Motion&Program pointer
// positions" in the controller's ?json=1 form: both entries filled.
const PCP_FILLED_JSON = JSON.stringify({ _embedded: { _state: [
  { _type: 'pcp-info', _title: 'progpointer', beginposition: '9,8', endposition: '9,20', modulemame: 'module_test', routinename: 'main', changecount: '-1', executiontype: 'normal' },
  { _type: 'pcp-info', _title: 'motionpointer', beginposition: '12,5', endposition: '12,30', modulemame: 'module_test', routinename: 'moveit', executiontype: '-1' },
] } });

// RW 6.16.03, 2026-09-27, GET /rw/rapid/tasks/T_ROB1/pcp?json=1 with no
// program started: the motionpointer entry is typed rap-text and carries an
// error link and no position.
const PCP_RW6_NO_MP_JSON = '{"_links":{"base":{"href":"http://127.0.0.1:37073/rw/rapid/"}},"_embedded":{"_state":[{"_type":"pcp-info","_title":"progpointer","_links":{"self":{"href":"tasks/T_ROB1/pcp?json=1"}},"beginposition":"24,9","endposition":"24,27","modulemame":"Module1","routinename":"main","changecount":"-1","executiontype":"normal"},{"_type":"rap-text","_title":"motionpointer","_links":{"error":{"href":"http://127.0.0.1:37073/rw/retcode?code=?json=1"}}}]}}';

// ABB's RWS 2.0 example answer (XHTML), as the RAPID service gives it.
const PCP_REV_L_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://localhost:7777/rw/rapid/"/></head><body>
<div class="state"><a href="tasks/T_ROB1/pcp" rel="self"></a><ul>
<li class="pcp-info" title="progpointer"><span class="beginposition">9,8</span><span class="endposition">9,20</span><span class="modulename">module_test</span><span class="routinename">main</span><span class="changecount">-1</span><span class="executiontype">normal</span></li>
<li class="pcp-info" title="motionpointer"><span class="beginposition">9,8</span><span class="endposition">9,20</span><span class="modulename">module_test</span><span class="routinename">main</span><span class="executiontype">-1</span></li>
</ul></div></body></html>`;

// RW 8.2.1, 2026-09-27, hal+json with no program started: both entries carry
// only an error link.
const PCP_RW8_NO_POINTERS_HAL = '{"_links":{"base":{"href":"https://127.0.0.1:80/rw/rapid/"}},"state":[{ "_type" : "pcp-info", "_title" : "progpointer" , "progpointer" : {"_links" : {"error" : { "href" : "https://127.0.0.1:80/rw/retcode?code=-1073414145" } } } }, { "_type" : "pcp-info", "_title" : "motionpointer" , "motionpointer" : {"_links" : {"error" : { "href" : "https://127.0.0.1:80/rw/retcode?code=-1073414145" } } } } ]}';

// ABB's example answer of "Get user modify from taskpanel" (RWS 1.0), in ?json=1 form.
const TASKSELECTION_JSON = JSON.stringify({ _embedded: { _state: [
  { _type: 'rap-taskselection', _title: 'T_ROB1', name: 'T_ROB1', state: 'ON', motiontask: 'TRUE', usermodify: 'TRUE' },
  { _type: 'rap-taskselection', _title: 'T_ROB2', name: 'T_ROB2', state: 'OFF', motiontask: 'TRUE', usermodify: 'TRUE' },
] } });

// ABB's example answer of "Get Controller environment variable", ?json=1 form (RWS 1.0) and XHTML (RWS 2.0).
const ENV_TEMP_JSON = JSON.stringify({ _embedded: { _state: [{ _type: 'ctrl-env', _title: '$TEMP', value: '/hd0a/TEMP' }] } });
const ENV_TEMP_XHTML = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://localhost/ctrl/%24TEMP/" /></head><body><div class="state"><ul><li class="ctrl-env" title="$TEMP"><span class="value">/TEMP</span></li></ul></div></body></html>';

describe('path rows: the forms ABB documents', () => {
  const T = ALL_TABLES;

  it('the motion pointer reads GET .../pcp on both generations (the program pointer resource), built', () => {
    for (const g of ['rws1', 'rws2'] as const) {
      expect(T.rapid.getMotionPointer[g]).toEqual({ method: 'GET', path: '/rw/rapid/tasks/{task}/pcp' });
      expect(T.rapid.getMotionPointer[g]?.path).toBe(T.rapid.getProgramPointer[g]?.path);
      expect(evidenceOf(T.rapid.getMotionPointer, g)).toBe('built');
    }
  });

  it('the task selection read has an RWS 1.0 side: GET /rw/rapid/taskselection, live on both', () => {
    expect(T.rapid.getTaskSelection.rws1).toEqual({ method: 'GET', path: '/rw/rapid/taskselection' });
    expect(evidenceOf(T.rapid.getTaskSelection, 'rws1')).toBe('live');
    expect(evidenceOf(T.rapid.getTaskSelection, 'rws2')).toBe('live');
  });

  it('an environment variable is GET /ctrl/{$ENVNAME} with the $ sent as %24, on both, live (not /ctrl/env)', () => {
    for (const g of ['rws1', 'rws2'] as const) {
      const spec = T.ctrl.getEnv[g] as PathSpec;
      expect(spec.method).toBe('GET');
      expect(spec.gap).toBeUndefined();
      expect(buildPath(spec, { name: 'TEMP' })).toBe('/ctrl/%24TEMP');
      expect(evidenceOf(T.ctrl.getEnv, g)).toBe('live');
    }
  });

  it('the RWS 1.0 write forms: method, path, ?action= and fields as the Rev M pages give them; the I/O forms built, keyless and base frame live', () => {
    expect(T.io.setSignalSimulated.rws1).toEqual({ method: 'POST', path: '/rw/iosystem/signals/{network}/{device}/{name}', action: 'set', fields: ['lstate'] });
    expect(T.io.unblockSignals.rws1).toEqual({ method: 'POST', path: '/rw/iosystem/signals', action: 'unblock-signal' });
    expect(T.io.setIoDeviceLState.rws1).toEqual({ method: 'POST', path: '/rw/iosystem/devices/{device}', action: 'set', fields: ['lstate'] });
    expect(T.panel.setKeylessMotorOn.rws1).toEqual({ method: 'POST', path: '/rw/cfg', action: 'keyless', fields: ['state'] });
    expect(T.motion.setMechunitBaseFrame.rws1).toEqual({
      method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/baseframe', action: 'set', fields: ['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4'],
    });
    for (const op of [T.io.setSignalSimulated, T.io.unblockSignals, T.io.setIoDeviceLState]) {
      expect(evidenceOf(op, 'rws1'), op.summary).toBe('built');
      expect(evidenceOf(op, 'rws2'), op.summary).toBe('live');
    }
    for (const op of [T.panel.setKeylessMotorOn, T.motion.setMechunitBaseFrame]) {
      expect(evidenceOf(op, 'rws1'), op.summary).toBe('live');
      expect(evidenceOf(op, 'rws2'), op.summary).toBe('live');
    }
  });
});

describe('motion pointer parse (both representations)', () => {
  it('reads the entry titled motionpointer, not the program pointer before it', () => {
    expect(motionPointerFrom(parseBody(PCP_FILLED_JSON).getAllEntries(), 't'))
      .toEqual({ module: 'module_test', routine: 'moveit', row: 12, col: 5 });
    expect(motionPointerFrom(parseBody(PCP_REV_L_XHTML).getAllEntries(), 't'))
      .toEqual({ module: 'module_test', routine: 'main', row: 9, col: 8 });
  });

  it('an entry with no position gives {}; an answer with no motionpointer entry is PARSE_ERROR', () => {
    expect(motionPointerFrom(parseBody(PCP_RW6_NO_MP_JSON).getAllEntries(), 't')).toEqual({});
    expect(motionPointerFrom(parseBody(PCP_RW8_NO_POINTERS_HAL).getAllEntries(), 't')).toEqual({});
    const onlyPp = JSON.stringify({ _embedded: { _state: [{ _type: 'pcp-info', _title: 'progpointer', beginposition: '1,1' }] } });
    expect(() => motionPointerFrom(parseBody(onlyPp).getAllEntries(), 'RWS2 getMotionPointer'))
      .toThrow(/no entry titled motionpointer \(titles seen: progpointer\)/);
  });
});

describe('RWS 1.0 reads', () => {
  it('getMotionPointer sends the program pointer GET and reads the motionpointer entry', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: PCP_FILLED_JSON }));
    const a = new RWS1Adapter(client);
    await expect(a.getMotionPointer('T_ROB1')).resolves.toEqual({ module: 'module_test', routine: 'moveit', row: 12, col: 5 });
    await a.getProgramPointer('T_ROB1');
    expect(calls.map(c => c.what)).toEqual(['GET /rw/rapid/tasks/T_ROB1/pcp?json=1', 'GET /rw/rapid/tasks/T_ROB1/pcp?json=1']);
  });

  it('getMotionPointer gives {} for the RW 6.16.03 answer with no position, and for a refusal (as getProgramPointer does)', async () => {
    await expect(new RWS1Adapter(makeFake(() => ({ status: 200, body: PCP_RW6_NO_MP_JSON })).client).getMotionPointer('T_ROB1')).resolves.toEqual({});
    await expect(new RWS1Adapter(makeFake(() => ({ status: 400, body: '' })).client).getMotionPointer('T_ROB1')).resolves.toEqual({});
  });

  it('getTaskSelection reads rap-taskselection from GET /rw/rapid/taskselection', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: TASKSELECTION_JSON }));
    const sel = await new RWS1Adapter(client).getTaskSelection();
    expect(calls.map(c => c.what)).toEqual(['GET /rw/rapid/taskselection?json=1']);
    expect(sel.available).toEqual(['T_ROB1', 'T_ROB2']);
    expect(sel.selected).toEqual(['T_ROB1']);
    expect(sel.entries[1]).toMatchObject({ name: 'T_ROB2', state: 'OFF', usermodify: 'TRUE' });
  });

  it('getTaskSelection: an answer with no rap-taskselection entry is PARSE_ERROR, and a refusal passes through', async () => {
    const empty = await caught(new RWS1Adapter(makeFake(() => ({ status: 200, body: '{"_embedded":{"_state":[]}}' })).client).getTaskSelection());
    expect(empty).toMatchObject({ code: 'PARSE_ERROR' });
    const refused = await caught(new RWS1Adapter(makeFake(() => ({ status: 404, body: '' })).client).getTaskSelection());
    expect(refused).toBeInstanceOf(RwsError);
    expect(refused.code).not.toBe('PARSE_ERROR');
  });

  it('getEnv sends GET /ctrl/%24{NAME} with or without the $, and returns the ctrl-env value', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: ENV_TEMP_JSON }));
    const a = new RWS1Adapter(client);
    await expect(a.getEnv('TEMP')).resolves.toBe('/hd0a/TEMP');
    await expect(a.getEnv('$TEMP')).resolves.toBe('/hd0a/TEMP');
    expect(calls.map(c => c.what)).toEqual(['GET /ctrl/%24TEMP?json=1', 'GET /ctrl/%24TEMP?json=1']);
  });

  it('getEnv refuses an empty name before sending, and an answer without a value is PARSE_ERROR', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    await expect(caught(a.getEnv(''))).resolves.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(caught(a.getEnv('$'))).resolves.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
    const other = new RWS1Adapter(makeFake(() => ({ status: 200, body: '{"_embedded":{"_state":[{"_type":"ctrl-env","_title":"$X"}]}}' })).client);
    await expect(caught(other.getEnv('X'))).resolves.toMatchObject({ code: 'PARSE_ERROR' });
  });
});

describe('RWS 1.0 writes', () => {
  it('setSignalSimulated posts lstate to the signal with ?action=set, and takes no mastership', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    await a.setSignalSimulated('Local', 'DRV_1', 'DRV1K1', true);
    await a.setSignalSimulated('Local', 'DRV_1', 'DRV1K1', false);
    expect(calls).toEqual([
      { what: 'POST /rw/iosystem/signals/Local/DRV_1/DRV1K1?action=set&json=1', body: 'lstate=simulated' },
      { what: 'POST /rw/iosystem/signals/Local/DRV_1/DRV1K1?action=set&json=1', body: 'lstate=not%20simulated' },
    ]);
    expect(Object.fromEntries(new URLSearchParams(calls[1].body))).toEqual({ lstate: 'not simulated' });
  });

  it('setSignalSimulated refuses an empty segment before sending (the form addresses network/device/signal)', async () => {
    const { calls, client } = makeFake();
    const err = await caught(new RWS1Adapter(client).setSignalSimulated('', '', 'DRV1K1', true));
    expect(err).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
  });

  it('unblockSignals posts ?action=unblock-signal on the signal collection with no body', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).unblockSignals();
    expect(calls).toEqual([{ what: 'POST /rw/iosystem/signals?action=unblock-signal&json=1', body: '' }]);
  });

  it('setIoDeviceLState posts lstate enable / disable to the device named without its network', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    await a.setIoDeviceLState('Local', 'DRV_1', false);
    await a.setIoDeviceLState('Local', 'DRV_1', true);
    expect(calls).toEqual([
      { what: 'POST /rw/iosystem/devices/DRV_1?action=set&json=1', body: 'lstate=disable' },
      { what: 'POST /rw/iosystem/devices/DRV_1?action=set&json=1', body: 'lstate=enable' },
    ]);
    const err = await caught(a.setIoDeviceLState('Local', ' ', true));
    expect(err).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(2);
  });

  it('setKeylessMotorOn posts state=run to /rw/cfg?action=keyless under RAPID mastership, as a motors-on', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).setKeylessMotorOn();
    expect(calls).toEqual([
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/cfg?action=keyless&json=1', body: 'state=run' },
      { what: 'mastership-release rapid' },
    ]);
  });

  it("setMechunitBaseFrame posts ABB's sample frame with ?action=set under motion mastership (202)", async () => {
    const { calls, client } = makeFake((m, url) => (m === 'POST' && url.includes('/baseframe') ? { status: 202, body: '' } : undefined));
    await new RWS1Adapter(client).setMechunitBaseFrame('ROB_1', { x: 1, y: 2, z: 3, q1: 0.1825742, q2: 0.3651484, q3: 0.5477226, q4: 0.7302967 });
    expect(calls).toEqual([
      { what: 'mastership-request motion' },
      { what: 'POST /rw/motionsystem/mechunits/ROB_1/baseframe?action=set&json=1', body: 'x=1&y=2&z=3&q1=0.1825742&q2=0.3651484&q3=0.5477226&q4=0.7302967' },
      { what: 'mastership-release motion' },
    ]);
  });

  it('a refused write is the controller\'s typed error and still releases the hold', async () => {
    const { calls, client } = makeFake((m, url) => (m === 'POST' && url.startsWith('/rw/cfg') ? { status: 400, body: '' } : undefined));
    const err = await caught(new RWS1Adapter(client).setKeylessMotorOn());
    expect(err).toBeInstanceOf(RwsError);
    expect(calls.map(c => c.what)).toEqual(['mastership-request rapid', 'POST /rw/cfg?action=keyless&json=1', 'mastership-release rapid']);
  });
});

describe('RobotManager on RWS 1.0', () => {
  it('passes the reads and the I/O writes through, with no mastership for the I/O writes', async () => {
    const { calls, client } = makeFake((m, url) => {
      if (url.startsWith('/rw/rapid/taskselection')) { return { status: 200, body: TASKSELECTION_JSON }; }
      if (url.startsWith('/ctrl/%24')) { return { status: 200, body: ENV_TEMP_JSON }; }
      if (url.includes('/pcp')) { return { status: 200, body: PCP_FILLED_JSON }; }
      return undefined;
    });
    const mgr = manager(new RWS1Adapter(client));
    await expect(mgr.getTaskSelection()).resolves.toMatchObject({ selected: ['T_ROB1'], available: ['T_ROB1', 'T_ROB2'] });
    await expect(mgr.getEnv('$TEMP')).resolves.toBe('/hd0a/TEMP');
    await expect(mgr.getMotionPointer('T_ROB1')).resolves.toMatchObject({ routine: 'moveit', row: 12 });
    calls.length = 0;
    await mgr.setSignalSimulated('Local', 'DRV_1', 'DRV1K1', true);
    await mgr.unblockSignals();
    await mgr.setIoDeviceLState('Local', 'DRV_1', true);
    expect(calls.map(c => c.what)).toEqual([
      'POST /rw/iosystem/signals/Local/DRV_1/DRV1K1?action=set&json=1',
      'POST /rw/iosystem/signals?action=unblock-signal&json=1',
      'POST /rw/iosystem/devices/DRV_1?action=set&json=1',
    ]);
  });

  it('setMechunitBaseFrame takes only the motion mastership the adapter holds, no RAPID mastership', async () => {
    const { calls, client } = makeFake();
    await manager(new RWS1Adapter(client)).setMechunitBaseFrame('ROB_1', { x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0 });
    expect(calls.map(c => c.what)).toEqual([
      'mastership-request motion',
      'POST /rw/motionsystem/mechunits/ROB_1/baseframe?action=set&json=1',
      'mastership-release motion',
    ]);
  });

  it('setKeylessMotorOn reaches the RWS 1.0 form (it used to be RWS 2.0 only)', async () => {
    const { calls, client } = makeFake();
    await manager(new RWS1Adapter(client)).setKeylessMotorOn();
    expect(calls.map(c => c.what)).toContain('POST /rw/cfg?action=keyless&json=1');
  });

  it('an adapter without the methods: reads answer null / {} / the empty selection, writes throw UNSUPPORTED_OPERATION', async () => {
    const mgr = manager({} as IRWSAdapter);
    await expect(mgr.getEnv('TEMP')).resolves.toBeNull();
    await expect(mgr.getMotionPointer('T_ROB1')).resolves.toEqual({});
    await expect(mgr.getTaskSelection()).resolves.toEqual({ selected: [], available: [] });
    for (const call of [
      () => mgr.setSignalSimulated('n', 'd', 's', true),
      () => mgr.unblockSignals(),
      () => mgr.setIoDeviceLState('n', 'd', true),
      () => mgr.setKeylessMotorOn(),
    ]) {
      await expect(caught(call())).resolves.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    }
  });
});

interface Recorded { method: string; url: string; body: string }

async function startServer(answer: (method: string, url: string) => { status: number; type?: string; body: string } | undefined):
Promise<{ server: http.Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      const a = answer(req.method ?? '', req.url ?? '');
      if (!a) { res.writeHead(204); res.end(); return; }
      res.writeHead(a.status, { 'Content-Type': a.type ?? 'application/hal+json;v=2.0' });
      res.end(a.body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe('RWS 2.0 reads', () => {
  it('getMotionPointer sends GET .../pcp (no longer the sync state) and reads the motionpointer entry', async () => {
    const { server, url, requests } = await startServer(() => ({ status: 200, type: 'application/xhtml+xml;v=2.0', body: PCP_REV_L_XHTML }));
    try {
      const mp = await new RwsClient2(url, 'u', 'p').getMotionPointer('T_ROB1');
      expect(mp).toEqual({ module: 'module_test', routine: 'main', row: 9, col: 8 });
      expect(mp.state).toBeUndefined();
      expect([...new Set(requests.map(r => `${r.method} ${r.url}`))]).toEqual(['GET /rw/rapid/tasks/T_ROB1/pcp']);
    } finally { server.close(); }
  });

  it('getMotionPointer gives {} for the RW 8.2.1 answer with no position', async () => {
    const { server, url } = await startServer(() => ({ status: 200, body: PCP_RW8_NO_POINTERS_HAL }));
    try {
      await expect(new RwsClient2(url, 'u', 'p').getMotionPointer('T_ROB1')).resolves.toEqual({});
    } finally { server.close(); }
  });

  it('getEnv sends GET /ctrl/%24TEMP and returns the ctrl-env value', async () => {
    const { server, url, requests } = await startServer(() => ({ status: 200, type: 'application/xhtml+xml;v=2.0', body: ENV_TEMP_XHTML }));
    try {
      const c = new RwsClient2(url, 'u', 'p');
      await expect(c.getEnv('$TEMP')).resolves.toBe('/TEMP');
      await expect(c.getEnv('TEMP')).resolves.toBe('/TEMP');
      expect([...new Set(requests.map(r => `${r.method} ${r.url}`))]).toEqual(['GET /ctrl/%24TEMP']);
      const sent = requests.length;
      await expect(caught(c.getEnv(' '))).resolves.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(requests).toHaveLength(sent);
    } finally { server.close(); }
  });

  it('RobotManager on RWS 2.0 still holds edit around the base frame (the RWS 1.0 change leaves it alone)', async () => {
    const { server, url, requests } = await startServer(() => undefined);
    try {
      await manager(new RWS2Adapter(url, 'u', 'p')).setMechunitBaseFrame('ROB_1', { x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0 });
      const seen = requests.map(r => `${r.method} ${r.url.split('?')[0]}`);
      const frame = seen.indexOf('POST /rw/motionsystem/mechunits/ROB_1/baseframe');
      expect(frame).toBeGreaterThan(0);
      expect(seen.slice(0, frame).some(s => /mastership|writeaccess/.test(s))).toBe(true);
    } finally { server.close(); }
  });
});
