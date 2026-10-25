import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessManager, type AccessDriver, type AccessLock } from '../src/access/AccessManager.js';
import { rmmpUnsupportedOnRw8, waitForRmmp, type RmmpPort } from '../src/access/rmmp.js';
import { classifyControllerError } from '../src/ControllerError.js';
import { RobotManager } from '../src/RobotManager.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type MastershipDomain, type RefusalContext } from '../src/types.js';

/**
 * Refusals in plain words at the layers that explain them: the access manager
 * names the holder of a refused request and turns a lost hold into a `lost`
 * refusal; the RWS 2.0 client classifies with its generation, user and
 * registration; RobotManager supplies its mode and controller state; the
 * client's own pre-flight refusals carry a refusal too.
 */

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

const hal = (code: number, msg: string): string =>
  `{"_links":{"base":{"href":"https://x/"}},"status":{"code":${code},"msg":"rws_x.cpp[1] ${msg} code:${code} icode:-1"}}`;

/** A classified error, as the transports build it. */
function refusal(status: number, code: number, method: string, path: string, context: RefusalContext = {}): RwsError {
  const info = classifyControllerError({ httpStatus: status, body: hal(code, 'x'), method, path, context });
  return new RwsError(info.message, info.code, status, undefined, info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
}

function driver(gen: 'rw6' | 'rw7' | 'rw8', request: () => Promise<void>): AccessDriver {
  return {
    label: 'TEST',
    locks: (): readonly AccessLock[] => (gen === 'rw6' ? ['cfg', 'motion', 'rapid'] : gen === 'rw7' ? ['edit', 'motion'] : ['writeaccess']),
    lockOf: (d: MastershipDomain): AccessLock => (gen === 'rw6' ? d : gen === 'rw7' ? (d === 'motion' ? 'motion' : 'edit') : 'writeaccess'),
    domainOf: (l: AccessLock): MastershipDomain => (l === 'cfg' || l === 'motion' ? l : 'rapid'),
    request,
    release: async () => {},
    generation: () => gen,
  };
}

describe('AccessManager explains refusals', () => {
  it('a request refused as held by another reads the holder once and names it', async () => {
    const held = refusal(403, -1073445862, 'POST', '/rw/mastership/edit/request', { generation: 'rw7' });
    const m = new AccessManager(driver('rw7', async () => { throw held; }));
    const lookups: AccessLock[] = [];
    m.setHolderLookup(async lock => { lookups.push(lock); return { kind: 'remote', application: 'RobotStudio', id: '17' }; });
    const err = await m.acquire('rapid').then(() => null, (e: unknown) => e as RwsError);
    expect(lookups).toEqual(['edit']);
    expect(err).toMatchObject({ code: 'MASTERSHIP_REQUIRED', httpStatus: 403, controllerCode: -1073445862 });
    expect(err!.refusal).toMatchObject({ kind: 'held-by-other', grantor: 'current-holder', holder: { kind: 'remote', application: 'RobotStudio' } });
    expect(err!.message).toMatch(/Another remote client holds mastership \(application 'RobotStudio', user id 17\)/);
  });

  it('RobotWare 8: the holding station is named, never its id', async () => {
    const held = refusal(403, -1073435870, 'POST', '/rw/controlstation/writeaccess/request');
    const m = new AccessManager(driver('rw8', async () => { throw held; }));
    m.setHolderLookup(async () => ({ kind: 'unknown', name: 'Line PLC' }));
    const err = await m.acquire('rapid').then(() => null, (e: unknown) => e as RwsError);
    expect(err!.refusal?.holder).toEqual({ kind: 'unknown', name: 'Line PLC' });
    expect(err!.message).toMatch(/held by control station 'Line PLC'/);
  });

  it('a failed holder read, or any other refusal, leaves the refusal as the controller gave it', async () => {
    const held = refusal(403, -1073445862, 'POST', '/rw/mastership/edit/request', { generation: 'rw7' });
    const m = new AccessManager(driver('rw7', async () => { throw held; }));
    m.setHolderLookup(async () => { throw new RwsError('busy', 'CONTROLLER_BUSY', 503); });
    expect(await m.acquire('rapid').catch((e: unknown) => e)).toBe(held);

    const off = refusal(400, -1073435872, 'POST', '/rw/controlstation/writeaccess/request');
    let read = 0;
    const m8 = new AccessManager(driver('rw8', async () => { throw off; }));
    m8.setHolderLookup(async () => { read++; return null; });
    const err = await m8.acquire('rapid').catch((e: unknown) => e as RwsError);
    expect(err).toBe(off);
    expect(read).toBe(0);
    expect(off.refusal?.kind).toBe('remote-access-off');
  });

  it('the refusal context is its source plus the session generation, and never throws', () => {
    const m = new AccessManager(driver('rw6', async () => {}));
    expect(m.refusalContext()).toEqual({ generation: 'rw6' });
    m.setRefusalContextSource(() => ({ opmode: 'MANR', robot: 'IRC5_1' }));
    expect(m.refusalContext()).toEqual({ opmode: 'MANR', robot: 'IRC5_1', generation: 'rw6' });
    m.setRefusalContextSource(() => { throw new Error('boom'); });
    expect(m.refusalContext()).toEqual({ generation: 'rw6' });
  });

  it('a write refused as not held while the hold was counted is a lost refusal, with the controller code kept', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const m = new AccessManager(driver('rw8', async () => {}));
    const notHeld = refusal(403, -1073435873, 'POST', '/rw/panel/speedratio', { generation: 'rw8', registered: true });
    expect(notHeld.refusal?.kind).toBe('not-held');
    const err = await m.withAccess(['rapid'], async () => { throw notHeld; }).catch((e: unknown) => e as RwsError);
    expect(err).not.toBe(notHeld);
    expect(err).toMatchObject({ code: 'MASTERSHIP_REQUIRED', controllerCode: -1073435873, httpStatus: 403 });
    expect(err.refusal).toMatchObject({ kind: 'lost', condition: 'write-access', grantor: 'this-tool' });
    expect(err.message).toMatch(/lost write access on the controller during this operation/);
    // A refusal without a counted hold is passed on unchanged.
    const m2 = new AccessManager(driver('rw8', async () => {}));
    expect(m2.noteRefusal(notHeld, ['writeaccess'])).toBe(notHeld);
  });

  it('a step after a loss inside the same operation carries a lost refusal', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const m = new AccessManager(driver('rw7', async () => {}));
    const err = await m.exclusive(async () => {
      await m.acquire('rapid');
      m.noteModeChange('AUTO', 'MANR');
      return m.acquire('rapid');
    }).catch((e: unknown) => e) as RwsError;
    expect(err.code).toBe('MASTERSHIP_REQUIRED');
    expect(err.refusal).toMatchObject({ kind: 'lost', condition: 'mastership', generation: 'rw7', evidence: 'abb' });
  });
});

// ─── RWS 2.0 client over a fake controller ───────────────────────────────────

async function startServer(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { requests.push(`${req.method} ${req.url}`); handle(req, res); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const send = (res: http.ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'Content-Type': 'application/hal+json;v=2.0' });
  res.end(body);
};

describe('RwsClient2 classifies with its generation, user and registration', () => {
  it('RobotWare 7: a refused mastership request names the holder from the edit status', async () => {
    const { server, port, requests } = await startServer((req, res) => {
      if (req.url === '/rw/mastership/edit/request') { send(res, 403, hal(-1073445862, 'Requested resource is held by someone else')); return; }
      if (req.url?.startsWith('/rw/mastership/edit')) {
        send(res, 200, '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"msh-resource","_title":"edit","mastership":"local"}]}');
        return;
      }
      res.writeHead(204); res.end();
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'Operator', 'p');
      (client as unknown as { writeAccessMode: string }).writeAccessMode = 'mastership';
      const err = await client.requestMastership('rapid').then(() => null, (e: unknown) => e as RwsError);
      expect(requests).toEqual(['POST /rw/mastership/edit/request', 'GET /rw/mastership/edit']);
      expect(err!.refusal).toMatchObject({
        kind: 'held-by-other', generation: 'rw7', grantor: 'pendant-operator', holder: { kind: 'local' },
      });
      expect(err!.message).toMatch(/The FlexPendant holds mastership/);
      expect(err!.message).not.toMatch(/RMMP/);   // mode not known: no manual-mode advice
    } finally { server.close(); }
  });

  it('a missing grant names the logged-in user; an unexplained 403 is UNKNOWN without advice', async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.url?.startsWith('/rw/panel/speedratio') && req.method === 'POST') { send(res, 403, hal(-1073445867, 'The user is not allowed access')); return; }
      if (req.url?.startsWith('/rw/panel/opmode') && req.method === 'POST') { res.writeHead(403); res.end(); return; }
      res.writeHead(204); res.end();
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'Operator', 'p');
      (client as unknown as { writeAccessMode: string }).writeAccessMode = 'mastership';
      const grant = await client.setSpeedRatio(50).then(() => null, (e: unknown) => e as RwsError);
      expect(grant!.code).toBe('GRANT_DENIED');
      expect(grant!.refusal).toMatchObject({ kind: 'grant-missing', user: 'Operator', grants: [{ id: 'UAS_SPEED_DECREASE' }] });
      expect(grant!.message).toMatch(/^User 'Operator' is not allowed to change the speed ratio/);
      expect(grant!.message).not.toMatch(/RMMP/);

      const bare = await client.setOperationMode('MANR').then(() => null, (e: unknown) => e as RwsError);
      expect(bare!.code).toBe('UNKNOWN');
      expect(bare!.refusal).toMatchObject({ kind: 'unknown', grantor: null });
      expect(bare!.message).not.toMatch(/RMMP|UAS/);
    } finally { server.close(); }
  });

  it('RobotWare 8: registering again the identity this session registered succeeds; another identity is refused', async () => {
    const ID = '{AAAAAAAA-0000-4000-8000-000000000001}';
    const { server, port } = await startServer((req, res) => {
      if (req.url === '/rw/controlstation/register/remote') {
        send(res, 403, hal(-1073435874, 'A control station has already been registered.'));
        return;
      }
      res.writeHead(204); res.end();
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: { name: 'Cell PC', id: ID, pincode: '4711' } });
      const c = client as unknown as { controlStationRegistered: boolean; writeAccessMode: string };
      c.writeAccessMode = 'controlstation';
      c.controlStationRegistered = true;
      await expect(client.registerControlStationRemote()).resolves.toBeUndefined();
      await expect(client.registerControlStationRemote('Cell PC', ID.toLowerCase(), '4711')).resolves.toBeUndefined();
      const other = await client.registerControlStationRemote('Other', '{BBBBBBBB-0000-4000-8000-000000000002}', '4711')
        .then(() => null, (e: unknown) => e as RwsError);
      expect(other!.controllerCode).toBe(-1073435874);
      expect(other!.refusal).toMatchObject({ kind: 'by-design', grantor: 'this-tool' });
      // Not registered by this session yet: the answer is passed on.
      c.controlStationRegistered = false;
      await expect(client.registerControlStationRemote()).rejects.toMatchObject({ controllerCode: -1073435874 });
    } finally { server.close(); }
  });

  it('RobotWare 8: a not-held answer from a session that never registered is not-registered', async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.url === '/rw/rapid/execution/start') { send(res, 403, hal(-1073435873, 'Unspecified Error')); return; }
      res.writeHead(204); res.end();
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      (client as unknown as { writeAccessMode: string }).writeAccessMode = 'controlstation';
      const req = (client as unknown as { req(m: string, p: string): Promise<string> }).req.bind(client);
      const err = await req('POST', '/rw/rapid/execution/start').then(() => null, (e: unknown) => e as RwsError);
      expect(err!.refusal).toMatchObject({ kind: 'not-registered', generation: 'rw8', condition: 'control-station' });
    } finally { server.close(); }
  });
});

describe('RobotManager supplies what it knows', () => {
  async function managerOver(port: number, opmode: string, quality: 'live' | 'polling' | 'stale' = 'polling') {
    const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
    (adapter as unknown as { writeAccessMode: string }).writeAccessMode = 'mastership';
    const mgr = new RobotManager();
    const priv = mgr as unknown as { watchAccess(m: unknown): void; accessIfAny(a: unknown): unknown };
    const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
    m.adapter = adapter;
    Object.assign(m._state, {
      connected: true, quality, opmode, ctrlstate: 'motoron',
      identity: { name: 'IRB1200_7', id: 'x', type: 'VIRTUAL_CONTROLLER', mac: '' },
    });
    // What connect() does once the adapter is built.
    priv.watchAccess(priv.accessIfAny(adapter));
    return mgr;
  }

  it('in MANR a held lock is explained as needing RMMP at the FlexPendant; in AUTO it is not', async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.url === '/rw/mastership/edit/request') { send(res, 403, hal(-1073445862, 'held')); return; }
      if (req.url?.startsWith('/rw/mastership/edit')) {
        send(res, 200, '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"msh-resource","_title":"edit","mastership":"nomaster"}]}');
        return;
      }
      res.writeHead(204); res.end();
    });
    try {
      const manual = await (await managerOver(port, 'MANR')).requestMastership('rapid').catch((e: unknown) => e) as RwsError;
      expect(manual.refusal).toMatchObject({ kind: 'rmmp-required', grantor: 'pendant-operator', generation: 'rw7' });
      expect(manual.message).toMatch(/^Controller 'IRB1200_7' refused to take edit mastership: in manual mode the FlexPendant has priority/);

      const auto = await (await managerOver(port, 'AUTO')).requestMastership('rapid').catch((e: unknown) => e) as RwsError;
      expect(auto.refusal?.kind).toBe('held-by-other');
      expect(auto.message).not.toMatch(/RMMP/);

      // A snapshot polling no longer keeps current is not used.
      const stale = await (await managerOver(port, 'MANR', 'stale')).requestMastership('rapid').catch((e: unknown) => e) as RwsError;
      expect(stale.refusal?.kind).toBe('held-by-other');
    } finally { server.close(); }
  });

  it('the platform refusal says "real controllers only" on a virtual controller', async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.url === '/ctrl/system/info') { send(res, 403, hal(-1073445881, 'Functionality is not supported on the current platform')); return; }
      res.writeHead(204); res.end();
    });
    try {
      const mgr = await managerOver(port, 'AUTO');
      const err = await mgr.saveSystemInfo('$TEMP/x', 'text').catch((e: unknown) => e) as RwsError;
      expect(err.code).toBe('UNSUPPORTED_OPERATION');
      expect(err.refusal).toMatchObject({ kind: 'rc-only', condition: 'platform' });
    } finally { server.close(); }
  });
});

describe('the client\'s own refusals carry a refusal', () => {
  it('RMMP on RobotWare 8 is unsupported, with the RobotWare 8 way named', () => {
    const e = rmmpUnsupportedOnRw8('requestRmmp', '8.1.1');
    expect(e.code).toBe('UNSUPPORTED_OPERATION');
    expect(e.refusal).toMatchObject({ kind: 'unsupported', generation: 'rw8', grantor: 'nobody', sentence: e.message });
    expect(e.refusal?.fix).toMatch(/allows Remote Access at the FlexPendant/);
  });

  it('a denied or expired RMMP wait carries its refusal; a grant does not', async () => {
    const port = (poll: string, privilege: string): RmmpPort => ({
      request: async () => {}, poll: async () => poll, read: async () => privilege, cancel: async () => {},
    });
    const denied = await waitForRmmp(port('DENIED', 'none'), 'modify', { pollMs: 250, waitMs: 5_000 }, 'rw7');
    expect(denied.outcome).toBe('denied');
    expect(denied.refusal).toMatchObject({ kind: 'rmmp-denied', grantor: 'pendant-operator', generation: 'rw7', sentence: denied.detail });
    const expired = await waitForRmmp(port('NO SUCH REQUEST', 'none'), 'modify', { pollMs: 250, waitMs: 5_000 }, 'rw6');
    expect(expired.refusal).toMatchObject({ kind: 'rmmp-expired', generation: 'rw6' });
    const granted = await waitForRmmp(port('GRANTED', 'modify'), 'modify', { pollMs: 250, waitMs: 5_000 }, 'rw7');
    expect(granted.outcome).toBe('granted');
    expect(granted.refusal).toBeUndefined();
  });
});
