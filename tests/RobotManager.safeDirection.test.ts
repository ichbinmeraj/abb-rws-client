import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsError } from '../src/types.js';
import { classifyControllerError } from '../src/ControllerError.js';
import { setLogger } from '../src/Logger.js';

/**
 * Safe-direction writes: RobotManager.stopRapid and setMotorsOff send first,
 * never wait for mastership or write access, acquire and retry once only when
 * the controller refuses them as not held, and name the holder on any other
 * refusal when the controller says who.
 *
 * The refusals are built from the error bodies captured live in
 * tests/fixtures/errors, classified the way the adapters classify them, so
 * the codes and texts are the controllers' own. RobotWare 6 has no captured
 * "mastership not held" body; that one case is synthetic, in RWS 1.0's JSON
 * shape, with the code from ABB's RWS 1.0 return-code list.
 */

type Gen = 'rw6' | 'rw7' | 'rw8';
type Call = [string, unknown[]];

function fromFixture(name: string, method: string, at: string): RwsError {
  const file = path.join(__dirname, 'fixtures', 'errors', `${name}.json`);
  const f = JSON.parse(fs.readFileSync(file, 'utf8')) as { response: { status: number; body: string } };
  return classified(f.response.status, f.response.body, method, at);
}

function classified(status: number, body: string, method: string, at: string): RwsError {
  const info = classifyControllerError({
    httpStatus: status, body, method, path: at, fallback: status === 403 ? 'GRANT_DENIED' : 'UNKNOWN',
  });
  return new RwsError(info.message, info.code, status, info.controllerMsg ?? undefined,
    info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
}

function rws1Body(code: number, msg: string): string {
  return JSON.stringify({ _links: {}, _embedded: { status: { code, msg: `${msg} code:${code} icode:-1` }, _state: [] } });
}

const STOP_PATH = { rw6: '/rw/rapid/execution?action=stop', rw7: '/rw/rapid/execution/stop', rw8: '/rw/rapid/execution/stop' };
const CTRL_PATH = { rw6: '/rw/panel/ctrlstate?action=setctrlstate', rw7: '/rw/panel/ctrl-state', rw8: '/rw/panel/ctrl-state' };

/** The controller's "this session holds no access" answer, per generation. */
function notHeld(gen: Gen, at: string): RwsError {
  if (gen === 'rw6') {
    return classified(403, rws1Body(-1073445859, 'The user does not have required mastership for the operation'), 'POST', at);
  }
  return gen === 'rw7'
    ? fromFixture('rws2/403-speedratio-no-mastership-haljson', 'POST', at)
    : fromFixture('rws2/403-writeaccess-not-held-haljson', 'POST', at);
}

/** The controller's "someone else holds it" answer to an access request, per generation. */
function heldByOther(gen: Gen): RwsError {
  if (gen === 'rw6') { return fromFixture('rws1/403-mastership-held-json', 'POST', '/rw/mastership/rapid?action=request'); }
  if (gen === 'rw7') { return fromFixture('rws2/403-mastership-held-haljson', 'POST', '/rw/mastership/edit/request'); }
  return fromFixture('rws2/403-writeaccess-held-by-other-station-haljson', 'POST', '/rw/controlstation/writeaccess/request');
}

interface Script {
  /** Outcomes of successive sends: an error to throw, or undefined to succeed. */
  send: unknown[];
  /** Outcomes of successive access requests. */
  acquire: unknown[];
  releaseError?: unknown;
  mastership?: { mastership: string; uid?: string; application?: string } | Error;
  writeAccess?: { held: boolean; heldByMe: boolean; heldById: string; heldByName: string; externalControlEnabled: boolean } | Error;
}

/**
 * A recording adapter. RobotWare 7 and 8 fakes are RWS2Adapter instances (the
 * manager branches on that); none of them touches the network.
 */
function fakeAdapter(gen: Gen, script: Script) {
  const calls: Call[] = [];
  const a = (gen === 'rw6' ? {} : Object.create(RWS2Adapter.prototype)) as Record<string, unknown>;
  const next = (queue: unknown[]): void => {
    const outcome = queue.shift();
    if (outcome !== undefined) { throw outcome; }
  };
  a.stopRapid = async () => { calls.push(['stopRapid', []]); next(script.send); };
  a.setControllerState = async (s: string) => { calls.push(['setControllerState', [s]]); next(script.send); };
  a.requestMastership = async (d: string) => { calls.push(['requestMastership', [d]]); next(script.acquire); };
  a.releaseMastership = async (d: string) => {
    calls.push(['releaseMastership', [d]]);
    if (script.releaseError) { throw script.releaseError; }
  };
  a.getMastershipStatus = async (d: string) => {
    calls.push(['getMastershipStatus', [d]]);
    if (gen === 'rw8') { throw new RwsError('HTTP 410 from GET /rw/mastership/edit', 'GRANT_DENIED', 410); }
    if (script.mastership instanceof Error) { throw script.mastership; }
    return script.mastership ?? { mastership: 'unknown' };
  };
  a.getWriteAccessStatus = async () => {
    calls.push(['getWriteAccessStatus', []]);
    if (gen !== 'rw8') { throw new RwsError('HTTP 404 from GET /rw/controlstation/writeaccess/status', 'RESOURCE_NOT_FOUND', 404); }
    if (script.writeAccess instanceof Error) { throw script.writeAccess; }
    return script.writeAccess ?? { held: false, heldByMe: false, heldById: 'none', heldByName: 'none', externalControlEnabled: true };
  };
  return { adapter: a, calls };
}

function manager(adapter: unknown, opmode: 'AUTO' | 'MANR' | 'MANF' = 'AUTO'): RobotManager {
  const mgr = new RobotManager();
  (mgr as unknown as { adapter: unknown }).adapter = adapter;
  (mgr as unknown as { _state: { opmode: string } })._state.opmode = opmode;
  return mgr;
}

const OPS = [
  {
    name: 'stopRapid',
    run: (m: RobotManager) => m.stopRapid(),
    wire: ['stopRapid', []] as Call,
    at: STOP_PATH,
    safety: /A stop over RWS is a program stop, not a safety stop\. Use the emergency stop for safety\./,
  },
  {
    name: 'setMotorsOff',
    run: (m: RobotManager) => m.setMotorsOff(),
    wire: ['setControllerState', ['motoroff']] as Call,
    at: CTRL_PATH,
    safety: /Motors off over RWS is not a safety function\. Use the emergency stop for safety\./,
  },
] as const;

const GENS: Gen[] = ['rw6', 'rw7', 'rw8'];

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  try { await p; } catch (e) { return e as RwsError; }
  throw new Error('expected a rejection');
}

describe('RobotManager safe-direction writes (stopRapid, setMotorsOff)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  for (const op of OPS) {
    for (const gen of GENS) {
      describe(`${op.name} on ${gen}`, () => {
        it('success: sends at once, with no access request before or after it', async () => {
          const { adapter, calls } = fakeAdapter(gen, { send: [], acquire: [] });
          await op.run(manager(adapter));
          expect(calls).toEqual([op.wire]);
        });

        it('not held: acquires, sends exactly once more, and releases', async () => {
          const { adapter, calls } = fakeAdapter(gen, { send: [notHeld(gen, op.at[gen])], acquire: [] });
          await op.run(manager(adapter));
          expect(calls).toEqual([
            op.wire,
            ['requestMastership', ['rapid']],
            op.wire,
            ['releaseMastership', ['rapid']],
          ]);
        });

        it('not held twice: one retry only, the access is still released, the refusal is kept', async () => {
          const { adapter, calls } = fakeAdapter(gen, {
            send: [notHeld(gen, op.at[gen]), notHeld(gen, op.at[gen])], acquire: [],
          });
          const err = await rejection(op.run(manager(adapter)));
          expect(calls).toEqual([
            op.wire,
            ['requestMastership', ['rapid']],
            op.wire,
            ['releaseMastership', ['rapid']],
          ]);
          expect(err).toBeInstanceOf(RwsError);
          expect(err.code).toBe('MASTERSHIP_REQUIRED');
          expect(err.message).toMatch(/refused again after access was taken/);
          expect(err.message).toMatch(op.safety);
        });

        it('held by another: the access request is refused, the holder is named, nothing more is sent', async () => {
          const script: Script = {
            send: [notHeld(gen, op.at[gen])],
            acquire: [heldByOther(gen)],
            mastership: gen === 'rw6'
              ? { mastership: 'local' }
              : { mastership: 'remote', application: 'RobotStudio', uid: '17' },
            writeAccess: {
              held: true, heldByMe: false, heldById: '{0d3c2f4e-1111-2222-3333-444455556666}',
              heldByName: 'Line PLC', externalControlEnabled: true,
            },
          };
          const { adapter, calls } = fakeAdapter(gen, script);
          const err = await rejection(op.run(manager(adapter)));

          const lookup: Call = gen === 'rw8' ? ['getWriteAccessStatus', []] : ['getMastershipStatus', ['rapid']];
          // No second send, and no release of an access that was never granted.
          expect(calls).toEqual([op.wire, ['requestMastership', ['rapid']], lookup]);
          expect(err).toBeInstanceOf(RwsError);
          expect(err.code).toBe('MASTERSHIP_REQUIRED');
          expect(err.httpStatus).toBe(403);
          expect(err.controllerCode).toBe(gen === 'rw8' ? -1073435870 : -1073445862);
          expect(err.message).toMatch(/request for access was refused too/);
          if (gen === 'rw6') { expect(err.message).toMatch(/The FlexPendant holds mastership/); }
          if (gen === 'rw7') { expect(err.message).toMatch(/remote client holds mastership \(application 'RobotStudio', user id 17\)/); }
          if (gen === 'rw8') {
            expect(err.message).toMatch(/held by control station 'Line PLC'/);
            // Station ids are compared, never shown.
            expect(err.message).not.toMatch(/0d3c2f4e/);
          }
          expect(err.message).toMatch(op.name === 'stopRapid'
            ? /Use the FlexPendant stop or the emergency stop\./
            : /Use the FlexPendant or the emergency stop\./);
          expect(err.message).toMatch(op.safety);
        });
      });
    }
  }

  it('held by another on the first send (RW6/RW7): not retried, no access request, holder named', async () => {
    for (const gen of ['rw6', 'rw7'] as const) {
      const held = gen === 'rw6'
        ? classified(403, rws1Body(-1073445862, 'Requested resource is held by someone else'), 'POST', STOP_PATH.rw6)
        : fromFixture('rws2/403-exec-start-blocked-haljson', 'POST', STOP_PATH.rw7);
      const { adapter, calls } = fakeAdapter(gen, {
        send: [held], acquire: [], mastership: { mastership: 'internal' },
      });
      const err = await rejection(manager(adapter).stopRapid());
      expect(calls).toEqual([['stopRapid', []], ['getMastershipStatus', ['rapid']]]);
      expect(err.code).toBe('MASTERSHIP_REQUIRED');
      expect(err.controllerCode).toBe(-1073445862);
      expect(err.message).toMatch(/The controller itself holds mastership/);
    }
  });

  it('a session that is not a registered control station (RW8) counts as not held: one acquire, one retry', async () => {
    const unregistered = fromFixture('rws2/403-session-not-registered-haljson', 'POST', STOP_PATH.rw8);
    const { adapter, calls } = fakeAdapter('rw8', { send: [unregistered], acquire: [] });
    await manager(adapter).stopRapid();
    expect(calls).toEqual([
      ['stopRapid', []], ['requestMastership', ['rapid']], ['stopRapid', []], ['releaseMastership', ['rapid']],
    ]);
  });

  it('the holder degrades to "did not say" when the status read fails or names nobody', async () => {
    const cases: Array<[Gen, Partial<Script>]> = [
      ['rw7', { mastership: new RwsError('HTTP 503 from GET /rw/mastership/edit', 'CONTROLLER_BUSY', 503) }],
      ['rw7', { mastership: { mastership: 'unknown' } }],
      ['rw6', { mastership: { mastership: 'remote' } }],
      ['rw8', { writeAccess: new RwsError('HTTP 503 from GET /rw/controlstation/writeaccess/status', 'CONTROLLER_BUSY', 503) }],
      ['rw8', { writeAccess: { held: false, heldByMe: false, heldById: 'none', heldByName: 'none', externalControlEnabled: true } }],
    ];
    for (const [gen, extra] of cases) {
      const { adapter } = fakeAdapter(gen, { send: [notHeld(gen, STOP_PATH[gen])], acquire: [heldByOther(gen)], ...extra });
      const err = await rejection(manager(adapter).stopRapid());
      // The controller's own classification survives the failed lookup.
      expect(err.code).toBe('MASTERSHIP_REQUIRED');
      if (gen === 'rw6') {
        expect(err.message).toMatch(/Another remote client holds mastership\. It must release it there/);
      } else {
        expect(err.message).toMatch(/The controller did not say who holds it\./);
      }
    }
  });

  it('a stop refused for the user (UAS) is not retried and names both candidate grants in Auto', async () => {
    const uas = (at: string): RwsError => fromFixture('rws2/403-uas-not-allowed-haljson', 'POST', at);

    const omni = fakeAdapter('rw7', { send: [uas(STOP_PATH.rw7)], acquire: [] });
    const err7 = await rejection(manager(omni.adapter, 'AUTO').stopRapid());
    expect(omni.calls).toEqual([['stopRapid', []]]);
    expect(err7.code).toBe('GRANT_DENIED');
    expect(err7.controllerCode).toBe(-1073445867);
    expect(err7.message).toMatch(/'Remote Start and Stop in Auto' \(UAS_REMOTE_START_STOP_IN_AUTO\)/);
    expect(err7.message).toMatch(/'Execute program' grant \(UAS_RAPID_EXECUTE\) say stop is always allowed/);
    expect(err7.message).toMatch(/Authenticate > View UAS Grants/);

    // RobotWare 6: the Auto grant is named, but not given an identifier ABB does not list there.
    const irc5 = fakeAdapter('rw6', {
      send: [classified(403, rws1Body(-1073445867, 'The user is not allowed access'), 'POST', STOP_PATH.rw6)], acquire: [],
    });
    const err6 = await rejection(manager(irc5.adapter, 'AUTO').stopRapid());
    expect(irc5.calls).toEqual([['stopRapid', []]]);
    expect(err6.message).toMatch(/'Remote Start Stop in Auto'/);
    expect(err6.message).not.toMatch(/UAS_REMOTE_START_STOP_IN_AUTO/);

    // In manual mode the Auto grant is not the question; the added sentence
    // names no grant. (The classifier's own GRANT_DENIED text, kept in front
    // of it unchanged, is not this path's to reword.)
    const refusal = uas(STOP_PATH.rw7);
    const manual = fakeAdapter('rw7', { send: [refusal], acquire: [] });
    const errM = await rejection(manager(manual.adapter, 'MANR').stopRapid());
    const added = errM.message.slice(errM.message.indexOf(refusal.message) + refusal.message.length);
    expect(added).not.toMatch(/Remote Start/);
    expect(added).toMatch(/refused the stop for this user/);
    expect(errM.message).toMatch(OPS[0].safety);
  });

  it('other refusals pass through unretried with the controller code and the safety note', async () => {
    const wrongState = fromFixture('rws1/400-exec-start-wrong-state-json', 'POST', STOP_PATH.rw6);
    const { adapter, calls } = fakeAdapter('rw6', { send: [wrongState], acquire: [] });
    const err = await rejection(manager(adapter).stopRapid());
    expect(calls).toEqual([['stopRapid', []]]);
    expect(err.code).toBe('WRONG_MODE');
    expect(err.httpStatus).toBe(400);
    expect(err.controllerCode).toBe(-1073442809);
    // The original message (with its "HTTP <status> from <method> <path>") is kept.
    expect(err.message).toContain(wrongState.message);
    expect(err.message).toMatch(OPS[0].safety);
  });

  it('a failure that is not an RwsError still reaches the caller as a typed RwsError', async () => {
    const { adapter } = fakeAdapter('rw7', { send: [new TypeError('socket hang up')], acquire: [] });
    const err = await rejection(manager(adapter).setMotorsOff());
    expect(err).toBeInstanceOf(RwsError);
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toMatch(/Motors off failed: socket hang up/);
  });

  it('a failed release after a successful retry is logged, not thrown', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    try {
      const { adapter, calls } = fakeAdapter('rw8', {
        send: [notHeld('rw8', STOP_PATH.rw8)], acquire: [],
        releaseError: new RwsError('HTTP 503 from POST /rw/controlstation/writeaccess/release', 'CONTROLLER_BUSY', 503),
      });
      await manager(adapter).stopRapid();
      expect(calls.map(c => c[0])).toEqual(['stopRapid', 'requestMastership', 'stopRapid', 'releaseMastership']);
      expect(warnings.some(w => /may stay held until this session ends/.test(w))).toBe(true);
    } finally {
      setLogger({ info() {}, warn() {}, error() {}, show() {} });
    }
  });

  it('a caller-held hold changes nothing on success; when the controller says it is gone, the retry does not keep access', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    try {
      const { adapter, calls } = fakeAdapter('rw7', { send: [undefined, notHeld('rw7', STOP_PATH.rw7)], acquire: [] });
      const mgr = manager(adapter);
      await mgr.requestMastership('rapid');
      await mgr.stopRapid();
      expect(calls).toEqual([['requestMastership', ['rapid']], ['stopRapid', []]]);

      calls.length = 0;
      await mgr.stopRapid();
      // The access taken for the retry is released at once - the lost hold is not restored silently.
      expect(calls).toEqual([
        ['stopRapid', []], ['requestMastership', ['rapid']], ['stopRapid', []], ['releaseMastership', ['rapid']],
      ]);
      expect(warnings.some(w => /that hold has ended/.test(w))).toBe(true);

      // RobotWare 8 has one lock: a caller's motion hold was the same write access.
      // (The hold is taken through the public request: the manager keeps no
      // separate set of caller-held domain names any more, only its counts.)
      warnings.length = 0;
      const rw8 = fakeAdapter('rw8', { send: [notHeld('rw8', STOP_PATH.rw8)], acquire: [] });
      const mgr8 = manager(rw8.adapter);
      await mgr8.requestMastership('motion');
      await mgr8.setMotorsOff();
      expect(warnings.some(w => /that hold has ended/.test(w))).toBe(true);
    } finally {
      setLogger({ info() {}, warn() {}, error() {}, show() {} });
    }
  });

  it('throws NOT_CONNECTED before connect()', async () => {
    const mgr = new RobotManager();
    await expect(mgr.stopRapid()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(mgr.setMotorsOff()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('never waits: the send is the first adapter call even while another access request is outstanding', async () => {
    const { adapter, calls } = fakeAdapter('rw7', { send: [], acquire: [] });
    // An access request that never answers, e.g. a hung write elsewhere.
    let unblock: () => void = () => {};
    const hung = new Promise<void>(r => { unblock = r; });
    (adapter as { requestMastership: (d: string) => Promise<void> }).requestMastership = async (d: string) => {
      calls.push(['requestMastership', [d]]);
      await hung;
    };
    const mgr = manager(adapter);
    const pending = mgr.requestMastership('rapid');
    await mgr.stopRapid();
    expect(calls).toEqual([['requestMastership', ['rapid']], ['stopRapid', []]]);
    unblock();
    await pending;
  });
});

describe('safe-direction refusals keep the refusal in plain words', () => {
  it('a refused access request keeps its refusal and gains the holder that was read; the station id is never in it', async () => {
    for (const gen of GENS) {
      const script: Script = {
        send: [notHeld(gen, STOP_PATH[gen])],
        acquire: [heldByOther(gen)],
        mastership: gen === 'rw6' ? { mastership: 'local' } : { mastership: 'remote', application: 'RobotStudio', uid: '17' },
        writeAccess: {
          held: true, heldByMe: false, heldById: '{0d3c2f4e-1111-2222-3333-444455556666}',
          heldByName: 'Line PLC', externalControlEnabled: true,
        },
      };
      const { adapter } = fakeAdapter(gen, script);
      const err = await rejection(manager(adapter).stopRapid());
      expect(err.refusal?.kind).toBe('held-by-other');
      expect(err.refusal?.holder).toEqual(gen === 'rw6' ? { kind: 'local' }
        : gen === 'rw7' ? { kind: 'remote', application: 'RobotStudio', id: '17' }
          : { kind: 'unknown', name: 'Line PLC' });
      expect(JSON.stringify(err.refusal)).not.toMatch(/0d3c2f4e/);
    }
  });

  it('a stop refused for the user keeps its grant-missing refusal', async () => {
    const uas = fromFixture('rws2/403-uas-not-allowed-haljson', 'POST', STOP_PATH.rw7);
    const { adapter } = fakeAdapter('rw7', { send: [uas], acquire: [] });
    const err = await rejection(manager(adapter, 'AUTO').stopRapid());
    expect(err.refusal).toMatchObject({ kind: 'grant-missing', grantor: 'uas-administrator' });
  });
});
