import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import type { RwsClient } from '../src/RwsClient.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsError, type JogParams } from '../src/types.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { setLogger } from '../src/Logger.js';
import { ALL_TABLES, buildPath } from '../src/paths/index.js';
import type { PathSpec } from '../src/paths/index.js';
import { RWS2_MOTIONSYSTEM_CHILDREN, checkJogUnit, jogUnitName, jogUnitToSelect, rws2JogUnitSegment } from '../src/jog.js';

/**
 * Writes on both generations: the backup check, PP to the previous / next
 * instruction and the jog unit selection, each with an RWS 1.0 form, an
 * optional IRWSAdapter member and a RobotManager wrapper.
 *
 * RWS 1.0 shapes: the `pcp?action=show` form RW 6.16.03 served on 2026-09-29
 * (empty `set-pp-prev-inst` / `set-pp-next-inst` forms), the
 * `/rw/motionsystem?action=show` form (`set-mechunit`, field `mechunit-name`)
 * and the `/ctrl/backup?json=1` listing that links `?action=check-restore`
 * with no form. RWS 2.0 shapes: ABB Motion_System Rev L ("Set Mechanical Unit
 * for Jogging": `POST /rw/motionsystem/{mechunit}`, no body, 204) and the
 * `GET /rw/motionsystem` root RW 7.21.4 and 8.2.1 answered on 2026-09-29
 * (`change-count` 0, `mechunit-name` ROB_1). Nothing here was sent to a
 * controller: the backup check and the PP steps are built, not run.
 */

// ─── RWS 1.0 fake client ─────────────────────────────────────────────────────

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

const CREDS = { host: '127.0.0.1', port: 80, username: 'Default User', password: 'robotics' };

/** An RWS 1.0 refusal envelope (the shape RW 6.16.03 answers 4xx with). */
const REFUSAL_RW6 = JSON.stringify({ _embedded: { status: { code: -1073445865, msg: 'Operation not allowed' }, _state: [] } });

describe('path rows (G7)', () => {
  const P = { task: 'T_ROB1', mechunit: 'ROB_1' };
  const url = (domain: string, op: string, gen: 'rws1' | 'rws2'): string =>
    buildPath(ALL_TABLES[domain][op][gen] as PathSpec, P);

  it('both generations have a row for each operation', () => {
    expect(url('ctrl', 'checkRestore', 'rws1')).toBe('/ctrl/backup?action=check-restore');
    expect(url('ctrl', 'checkRestore', 'rws2')).toBe('/ctrl/backup/check-restore');
    expect(ALL_TABLES.ctrl.checkRestore.rws1?.method).toBe('GET');
    expect(url('rapid', 'ppPrevInst', 'rws1')).toBe('/rw/rapid/tasks/T_ROB1/pcp?action=set-pp-prev-inst');
    expect(url('rapid', 'ppNextInst', 'rws1')).toBe('/rw/rapid/tasks/T_ROB1/pcp?action=set-pp-next-inst');
    expect(url('rapid', 'ppPrevInst', 'rws2')).toBe('/rw/rapid/tasks/T_ROB1/pcp/prev-inst');
    expect(url('rapid', 'ppNextInst', 'rws2')).toBe('/rw/rapid/tasks/T_ROB1/pcp/next-inst');
    expect(url('motion', 'setMechunitForJogging', 'rws1')).toBe('/rw/motionsystem?action=set-mechunit');
    expect(url('motion', 'setMechunitForJogging', 'rws2')).toBe('/rw/motionsystem/ROB_1');
    for (const op of ['ppPrevInst', 'ppNextInst', 'setMechunitForJogging']) {
      const domain = op === 'setMechunitForJogging' ? 'motion' : 'rapid';
      expect(ALL_TABLES[domain][op].rws1?.method, op).toBe('POST');
      expect(ALL_TABLES[domain][op].rws2?.method, op).toBe('POST');
    }
  });
});

const ACCEPTED_RW6 = '{"_embedded":{"_state":[{"_type":"ctrl-checkrestore","_title":"checkrestore","status":"Accepted"}]}}';

describe('RWS1Adapter.checkRestore (live-verified on RW 6.16.03, 2026-10-09)', () => {
  it('GETs ?action=check-restore with the backup as a /fileservice/$BACKUP/ URI query and takes no mastership', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: ACCEPTED_RW6 }));
    await new RWS1Adapter(client).checkRestore('mybak');
    expect(calls).toEqual([{ what: 'GET /ctrl/backup?action=check-restore&backup=%2Ffileservice%2F%24BACKUP%2Fmybak&json=1', body: undefined }]);
  });

  it('refuses an empty name before anything is sent, and passes a refusal on as a typed error', async () => {
    const empty = makeFake();
    await expect(new RWS1Adapter(empty.client).checkRestore(' ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(empty.calls).toEqual([]);
    const refused = makeFake(() => ({ status: 400, body: REFUSAL_RW6 }));
    const err = await new RWS1Adapter(refused.client).checkRestore('nobak').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ httpStatus: 400, controllerCode: -1073445865 });
  });
});

describe('RWS1Adapter.ppPrevInst / ppNextInst (built, not run)', () => {
  it('POST the field-less pcp forms with an empty body under RAPID mastership', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    await a.ppPrevInst('T_ROB1');
    await a.ppNextInst('T_ROB1');
    expect(calls).toEqual([
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/tasks/T_ROB1/pcp?action=set-pp-prev-inst&json=1', body: '' },
      { what: 'mastership-release rapid' },
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/tasks/T_ROB1/pcp?action=set-pp-next-inst&json=1', body: '' },
      { what: 'mastership-release rapid' },
    ]);
  });

  it('a refusal is the controller\'s typed error, and mastership is still released', async () => {
    const { calls, client } = makeFake((m) => (m === 'POST' ? { status: 400, body: REFUSAL_RW6 } : undefined));
    const err = await new RWS1Adapter(client).ppNextInst('T_ROB1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ httpStatus: 400 });
    expect(calls.at(-1)).toEqual({ what: 'mastership-release rapid' });
  });
});

// ─── RWS 2.0 local server ────────────────────────────────────────────────────

interface Recorded { method: string; url: string; body: string; contentType: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'),
        contentType: String(req.headers['content-type'] ?? ''),
      });
      handle(req, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const HAL = { 'Content-Type': 'application/hal+json;v=2.0' };

/** `GET /rw/motionsystem` as RW 7.21.4 answered it (2026-09-29), unit and count variable. */
const motionSystemRoot = (count: string, unit: string): string => JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1:5466/rw/' }, self: { href: 'motionsystem' } },
  state: [{ _type: 'ms', _title: 'motionsystem', 'change-count': count, 'mechunit-name': unit, 'poll-rate': '60', 'absacc-active': 'OFF', 'modal-payload-mode': 'ON' }],
});

function rw7Client(port: number): RwsClient2 {
  const c = new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics');
  (c as unknown as { writeAccessMode: string }).writeAccessMode = 'mastership';
  return c;
}

/** The requests that are not mastership traffic. */
const work = (requests: Recorded[]): Recorded[] => requests.filter(r => !r.url.startsWith('/rw/mastership'));

describe('RWS 2.0 setMechunitForJogging', () => {
  it('POSTs /rw/motionsystem/{mechunit} with no body under motion mastership', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await rw7Client(port).setMechunitForJogging('ROB_1');
      const posts = work(requests);
      expect(posts.map(r => `${r.method} ${r.url}`)).toEqual(['POST /rw/motionsystem/ROB_1']);
      expect(posts[0].body).toBe('');
      expect(posts[0].contentType).toContain('application/x-www-form-urlencoded');
      const mastership = requests.filter(r => r.url.startsWith('/rw/mastership')).map(r => r.url);
      expect(mastership.some(u => u.includes('motion'))).toBe(true);
    } finally { server.close(); }
  });

  it('refuses an empty name, a spaced name or one naming a sibling resource before any request', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      const c = rw7Client(port);
      for (const name of ['', 'ROB 1', 'jog', 'Mechunits', 'errorstate']) {
        await expect(c.setMechunitForJogging(name), name).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('a 403 refusal is a typed RwsError', async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.url === '/rw/motionsystem/ROB_1') {
        res.writeHead(403, HAL);
        res.end(JSON.stringify({ _links: { base: { href: 'https://x/' } }, status: { code: -1073445865, msg: 'Operation not allowed' } }));
        return;
      }
      res.writeHead(204); res.end();
    });
    try {
      const err = await rw7Client(port).setMechunitForJogging('ROB_1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect(err).toMatchObject({ httpStatus: 403 });
    } finally { server.close(); }
  });
});

describe('RWS 2.0 jog selects the named unit', () => {
  function stateful(selectsTo: string | null) {
    let unit = 'ROB_1';
    let count = '0';
    return startServer((req, res) => {
      if (req.method === 'GET' && req.url === '/rw/motionsystem') {
        res.writeHead(200, HAL); res.end(motionSystemRoot(count, unit)); return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/rw/motionsystem/') && req.url !== '/rw/motionsystem/jog' && selectsTo !== null) {
        unit = selectsTo; count = '1';
      }
      res.writeHead(204); res.end();
    });
  }

  it('selects, reads again and jogs with the count of the second read', async () => {
    const { server, port, requests } = await stateful('STN_1');
    try {
      await rw7Client(port).jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, mechunit: 'STN_1' });
      expect(work(requests).map(r => `${r.method} ${r.url}`)).toEqual([
        'GET /rw/motionsystem', 'POST /rw/motionsystem/STN_1', 'GET /rw/motionsystem', 'POST /rw/motionsystem/jog',
      ]);
      expect(work(requests).at(-1)!.body).toBe('axis1=0&axis2=0&axis3=0&axis4=0&axis5=0&axis6=1&ccount=1&inc-mode=Small');
    } finally { server.close(); }
  });

  it('sends no jog when the controller still names the old unit', async () => {
    const { server, port, requests } = await stateful(null);
    try {
      const err = await rw7Client(port).jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, mechunit: 'STN_1' })
        .then(() => null, (e: unknown) => e as RwsError);
      expect(err).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(err!.message).toContain("'ROB_1' would move, not 'STN_1'");
      expect(requests.some(r => r.url === '/rw/motionsystem/jog')).toBe(false);
    } finally { server.close(); }
  });

  it('a unit already selected is not selected again', async () => {
    const { server, port, requests } = await stateful('ROB_1');
    try {
      await rw7Client(port).jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, mechunit: 'ROB_1' });
      expect(work(requests).map(r => `${r.method} ${r.url}`)).toEqual(['GET /rw/motionsystem', 'POST /rw/motionsystem/jog']);
    } finally { server.close(); }
  });
});

describe('jog unit helpers', () => {
  it('jogUnitToSelect selects only a named unit the controller does not name', () => {
    expect(jogUnitToSelect(undefined, 'ROB_1')).toBeUndefined();
    expect(jogUnitToSelect('ROB_1', 'ROB_1')).toBeUndefined();
    expect(jogUnitToSelect('ROB_1', ' ROB_1 ')).toBeUndefined();
    expect(jogUnitToSelect('STN_1', 'ROB_1')).toBe('STN_1');
    expect(jogUnitToSelect('STN_1', undefined)).toBe('STN_1');
  });

  it('the RWS 2.0 segment check covers every sibling resource, without case', () => {
    for (const child of RWS2_MOTIONSYSTEM_CHILDREN) {
      expect(() => rws2JogUnitSegment(child.toUpperCase(), 't')).toThrow(RwsError);
    }
    expect(rws2JogUnitSegment('ROB_1', 't')).toBe('ROB_1');
  });
});

// ─── RobotManager wrappers ───────────────────────────────────────────────────

describe('RobotManager G7 wrappers', () => {
  it('delegate to the RWS 1.0 adapter; the PP steps share one RAPID hold with the adapter', async () => {
    const { calls, client } = makeFake((m, u) => (u.includes('check-restore') ? { status: 200, body: ACCEPTED_RW6 } : undefined));
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: IRWSAdapter }).adapter = new RWS1Adapter(client, CREDS);
    await mgr.checkRestore('mybak');
    await mgr.ppPrevInst('T_ROB1');
    await mgr.ppNextInst('T_ROB1');
    await mgr.setMechunitForJogging('ROB_1');
    expect(calls).toEqual([
      { what: 'GET /ctrl/backup?action=check-restore&backup=%2Ffileservice%2F%24BACKUP%2Fmybak&json=1', body: undefined },
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/tasks/T_ROB1/pcp?action=set-pp-prev-inst&json=1', body: '' },
      { what: 'mastership-release rapid' },
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/tasks/T_ROB1/pcp?action=set-pp-next-inst&json=1', body: '' },
      { what: 'mastership-release rapid' },
      { what: 'mastership-request motion' },
      { what: 'POST /rw/motionsystem?action=set-mechunit&json=1', body: 'mechunit-name=ROB_1' },
      { what: 'mastership-release motion' },
    ]);
  });

  it('throw UNSUPPORTED_OPERATION on an adapter without the member, NOT_CONNECTED with none', async () => {
    const bare = new RobotManager();
    (bare as unknown as { adapter: Partial<IRWSAdapter> }).adapter = {
      requestMastership: async () => {}, releaseMastership: async () => {},
    };
    for (const call of [
      () => bare.checkRestore('b'), () => bare.ppPrevInst('T_ROB1'),
      () => bare.ppNextInst('T_ROB1'), () => bare.setMechunitForJogging('ROB_1'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    }
    const none = new RobotManager();
    await expect(none.ppPrevInst('T_ROB1')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(none.setMechunitForJogging('ROB_1')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});

// ─── Unit names and the jog's own hold (review follow-up) ───────────────────

describe('jog unit names are RAPID names, compared without case', () => {
  it('path-like and non-RAPID names are refused; RAPID names pass', () => {
    for (const bad of ['.', '..', '/', '?', '#', 'a/b', '1ROB', '_ROB', 'ROB-1', 'ROB 1', '']) {
      expect(() => jogUnitName(bad, 't'), JSON.stringify(bad)).toThrow(RwsError);
    }
    for (const good of ['ROB_1', 'STN_1', 'rob_1', 'M7DM1']) { expect(jogUnitName(good, 't')).toBe(good); }
  });

  it('a name that differs from the selection only in case selects nothing and passes the re-read', () => {
    expect(jogUnitToSelect('rob_1', 'ROB_1')).toBeUndefined();
    expect(jogUnitToSelect('STN_1', 'rob_1')).toBe('STN_1');
    expect(() => checkJogUnit('stn_1', 'STN_1')).not.toThrow();
    expect(() => checkJogUnit('STN_1', 'ROB_1')).toThrow(RwsError);
  });

  it('RWS 1.0: a different spelling of the selected unit sends no set-mechunit', async () => {
    const { calls, client } = makeFake((m, url) => (m === 'GET' && url.startsWith('/rw/motionsystem')
      ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'ms', 'change-count': '0', 'mechunit-name': 'ROB_1' }] } }) }
      : undefined));
    await new RWS1Adapter(client, CREDS).jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, mechunit: 'rob_1' });
    expect(calls.map(c => c.what)).toEqual(['GET /rw/motionsystem?json=1', 'POST /rw/motionsystem?action=jog&json=1']);
  });
});

describe('RWS 2.0 jog refuses a sibling-resource unit name before any request', () => {
  it('RwsClient2.jog: nothing is sent, not even the motion-system read', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      for (const name of ['jog', 'Mechunits', 'errorstate']) {
        await expect(rw7Client(port).jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, mechunit: name }), name)
          .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('RobotManager.jog on an RWS 2.0 adapter: refused before the pre-flight reads and before any access', async () => {
    const wire: string[] = [];
    const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    const a = adapter as unknown as Record<string, unknown>;
    a.writeAccessMode = 'mastership';
    a.req = async (method: string, path: string) => { wire.push(`${method} ${path}`); return ''; };
    a.getOperationMode = async () => { wire.push('read opmode'); return 'MANR'; };
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: IRWSAdapter }).adapter = adapter;
    await expect(mgr.jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, mechunit: 'mechunits' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(wire).toEqual([]);
  });
});

describe('RobotManager.jog with a unit selection: the jog\'s own hold covers it', () => {
  beforeEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });
  afterEach(() => { vi.useRealTimers(); });

  const JOG_STN: JogParams = { mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, mechunit: 'STN_1' };

  it('RWS 1.0: one motion request, GET, set-mechunit, GET, the jog with ccount=1, one release 2 s later', async () => {
    vi.useFakeTimers();
    let unit = 'ROB_1';
    let count = '0';
    const { calls, client } = makeFake((m, url) => {
      if (m === 'GET' && url.startsWith('/rw/motionsystem')) {
        return { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'ms', 'change-count': count, 'mechunit-name': unit }] } }) };
      }
      if (m === 'POST' && url.includes('action=set-mechunit')) { unit = 'STN_1'; count = '1'; }
      return undefined;
    });
    const adapter = new RWS1Adapter(client, CREDS);
    const a = adapter as unknown as Record<string, unknown>;
    a.getOperationMode = async () => 'MANR';
    a.getControllerState = async () => 'motoron';
    a.getRmmpPrivilege = async () => 'modify';
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: IRWSAdapter }).adapter = adapter;
    await mgr.jog(JOG_STN);
    expect(calls).toEqual([
      { what: 'mastership-request motion' },
      { what: 'GET /rw/motionsystem?json=1', body: undefined },
      { what: 'POST /rw/motionsystem?action=set-mechunit&json=1', body: 'mechunit-name=STN_1' },
      { what: 'GET /rw/motionsystem?json=1', body: undefined },
      { what: 'POST /rw/motionsystem?action=jog&json=1', body: 'axis1=0&axis2=0&axis3=0&axis4=0&axis5=0&axis6=1&ccount=1&inc-mode=Small' },
    ]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls.slice(5)).toEqual([{ what: 'mastership-release motion' }]);
  });

  it('RobotWare 8: one write-access request covers the selection and the jog; one release 2 s later', async () => {
    vi.useFakeTimers();
    const wire: string[] = [];
    let unit = 'ROB_1';
    let count = '0';
    const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    const a = adapter as unknown as Record<string, unknown>;
    a.writeAccessMode = 'controlstation';
    a.req = async (method: string, path: string, _fields?: unknown, body?: string) => {
      wire.push(body ? `${method} ${path} ${body}` : `${method} ${path}`);
      if (method === 'GET' && path === '/rw/motionsystem') { return motionSystemRoot(count, unit); }
      if (method === 'POST' && path === '/rw/motionsystem/STN_1') { unit = 'STN_1'; count = '1'; }
      return '';
    };
    a.getOperationMode = async () => 'MANR';
    a.getControllerState = async () => 'motoron';
    // Motion control as a new session finds it at the registration, not allowed (one standing
    // there is withdrawn: the lifecycle suite's test 19), then declared, as a person allows it in
    // this session.
    let declared = false;
    a.getAllowMotionControl = async () => { const v = declared; declared = true; return v; };
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: IRWSAdapter }).adapter = adapter;
    await mgr.jog(JOG_STN);
    expect(wire).toEqual([
      'POST /rw/controlstation/register/remote',
      'POST /rw/controlstation/writeaccess/request',
      'GET /rw/motionsystem',
      'POST /rw/motionsystem/STN_1',
      'GET /rw/motionsystem',
      'POST /rw/motionsystem/jog axis1=0&axis2=0&axis3=0&axis4=0&axis5=0&axis6=1&ccount=1&inc-mode=Small',
    ]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(wire.slice(6)).toEqual(['POST /rw/controlstation/writeaccess/release']);
  });
});
