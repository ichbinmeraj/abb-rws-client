import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type JogParams } from '../src/types.js';
import { asJogPostError } from '../src/jog.js';

/** A refusal of the jog POST itself, as the adapters tag it. */
const jogPostRefusal = (e: RwsError): unknown => asJogPostError(e);

/**
 * RobotManager's RMMP wait and jog pre-flight, per RobotWare generation.
 *
 * - RobotWare 6: a plain adapter object (the manager treats an adapter it did
 *   not build as RWS 1.0), every call recorded.
 * - RobotWare 7/8: a real RWS2Adapter whose transport is a recorder, so the
 *   RMMP, mastership and write-access calls show on the wire as the client
 *   sends them; the pre-flight reads and the jog request itself are recorded
 *   stand-ins.
 *
 * `ctl` scripts the controller: poll and privilege answers are used in order,
 * the last one repeating.
 */

interface Ctl {
  opmode: string;
  ctrlstate: string;
  motionControl: boolean;
  polls: string[];
  reads: string[];
  readError?: RwsError;
}

const ctl = (over: Partial<Ctl> = {}): Ctl => ({
  opmode: 'MANR', ctrlstate: 'motoron', motionControl: true, polls: ['PENDING'], reads: ['none'], ...over,
});

const next = (list: string[]): string => (list.length > 1 ? list.shift()! : list[0]);

const hal = (type: string, fields: Record<string, string>): string =>
  JSON.stringify({ _links: { base: { href: 'https://x/' } }, state: [{ _type: type, _title: 'rmmp', ...fields }] });

function rw6(c: Ctl) {
  const wire: string[] = [];
  const adapter = {
    requestMastership: async (d: string) => { wire.push(`request ${d}`); },
    releaseMastership: async (d: string) => { wire.push(`release ${d}`); },
    getOperationMode: async () => { wire.push('read opmode'); return c.opmode; },
    getControllerState: async () => { wire.push('read ctrlstate'); return c.ctrlstate; },
    getRmmpPrivilege: async () => {
      wire.push('GET /users/rmmp');
      if (c.readError) { throw c.readError; }
      return next(c.reads);
    },
    requestRmmp: async (level: string) => { wire.push(`POST /users/rmmp privilege=${level}`); },
    pollRmmp: async () => { wire.push('GET /users/rmmp/poll'); return next(c.polls); },
    cancelRmmp: async () => { wire.push('cancel'); },
    jog: async () => { wire.push('JOG'); },
    disconnect: async () => { wire.push('logout'); },
  };
  return { adapter, wire };
}

function rws2(generation: 'rw7' | 'rw8', c: Ctl) {
  const wire: string[] = [];
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  a.req = async (method: string, path: string, fields?: Record<string, string>) => {
    // The RMMP request's body is shown; the station registration's (with its random id) is not.
    wire.push(fields && path === '/users/rmmp' ? `${method} ${path} ${new URLSearchParams(fields).toString()}` : `${method} ${path}`);
    // The controller takes an allowance write: a station found allowed at the registration is withdrawn there.
    if (method === 'POST' && path === '/rw/controlstation/allowmotioncontrol') { c.motionControl = fields?.['allow-motion-control'] === 'true'; }
    if (method === 'GET' && path === '/users/rmmp/poll') { return hal('user-rmmp-poll', { status: next(c.polls) }); }
    if (method === 'GET' && path === '/users/rmmp') {
      if (c.readError) { throw c.readError; }
      return hal('user-rmmp', { privilege: next(c.reads), rmmpheldbyme: 'true' });
    }
    return '';
  };
  a.getOperationMode = async () => { wire.push('read opmode'); return c.opmode; };
  a.getControllerState = async () => { wire.push('read ctrlstate'); return c.ctrlstate; };
  a.getAllowMotionControl = async () => { wire.push('read motion control'); return c.motionControl; };
  a.jog = async () => { wire.push('JOG'); };
  return { adapter, wire };
}

function manager(adapter: unknown): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
  m.adapter = adapter;
  // The snapshot says AUTO: the pre-flight must go by the controller's fresh answer.
  Object.assign(m._state, { connected: true, opmode: 'AUTO', ctrlstate: 'motoroff' });
  return mgr;
}

const JOG: JogParams = { mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 };
const REGISTER = 'POST /rw/controlstation/register/remote';
const WA_REQUEST = 'POST /rw/controlstation/writeaccess/request';
const WA_RELEASE = 'POST /rw/controlstation/writeaccess/release';

beforeEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });
afterEach(() => { vi.useRealTimers(); });

const refusal = (p: Promise<unknown>): Promise<RwsError | null> => p.then(() => null, (e: unknown) => e as RwsError);

describe('RobotManager.jog: the mode is read, not required; the controller decides', () => {
  for (const generation of ['rw6', 'rw7', 'rw8'] as const) {
    it(`${generation} in AUTO: the jog is sent`, async () => {
      const c = ctl({ opmode: 'AUTO', reads: ['modify'] });
      const { adapter, wire } = generation === 'rw6' ? rw6(c) : rws2(generation, c);
      await manager(adapter).jog(JOG);
      expect(wire).toContain('JOG');
    });
  }

  it('in AUTO, an unexplained refusal of the jog names the mode (WRONG_MODE)', async () => {
    const { adapter } = rws2('rw7', ctl({ opmode: 'AUTO' }));
    (adapter as unknown as Record<string, unknown>).jog = async () => { throw jogPostRefusal(new RwsError('Refused', 'UNKNOWN', 403)); };
    const err = await refusal(manager(adapter).jog(JOG));
    expect(err).toMatchObject({ code: 'WRONG_MODE' });
    expect(err!.message).toContain('AUTO');
  });

  it('RobotWare 6 in MANF: sent; an unexplained refusal cites ABB\'s IRC5 manual on manual full speed', async () => {
    const c = ctl({ opmode: 'MANF', reads: ['modify'] });
    const { adapter, wire } = rw6(c);
    (adapter as unknown as Record<string, unknown>).jog = async () => { wire.push('JOG'); throw jogPostRefusal(new RwsError('Refused', 'UNKNOWN', 403)); };
    const err = await refusal(manager(adapter).jog(JOG));
    expect(wire).toContain('JOG');
    expect(err).toMatchObject({ code: 'WRONG_MODE' });
    expect(err!.message).toContain('MANF');
  });

  it('motors read off: the jog is still sent; the controller decides (tests/acceptanceStep6.test.ts covers the refusal)', async () => {
    const { adapter, wire } = rws2('rw7', ctl({ ctrlstate: 'motoroff' }));
    await manager(adapter).jog(JOG);
    expect(wire).toEqual(['read opmode', 'read ctrlstate', 'POST /rw/mastership/motion/request', 'JOG']);
  });

  it('bad jog arguments are refused before anything is read', async () => {
    const { adapter, wire } = rws2('rw7', ctl());
    await expect(manager(adapter).jog({ ...JOG, incMode: 'Tiny' as never })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(wire).toEqual([]);
  });
});

describe('RobotManager.jog on RobotWare 6 and 7 in manual mode: sent, the controller decides', () => {
  // The pre-flight no longer reads or requires RMMP: ABB's jog pages require a
  // local client plus mastership, and RMMP does not make a client local, so
  // the client adds no RMMP prohibition of its own. A refusal is the
  // controller's, with ABB's local-client rule added (tests/manualMode.guide.test.ts).
  for (const generation of ['rw6', 'rw7'] as const) {
    for (const reads of [['modify'], ['none']]) {
      it(`${generation}, RMMP reads ${reads[0]}: the jog runs under motion mastership, and RMMP is not read`, async () => {
        vi.useFakeTimers();
        const { adapter, wire } = generation === 'rw6' ? rw6(ctl({ reads })) : rws2(generation, ctl({ reads }));
        const mgr = manager(adapter);
        await mgr.jog(JOG);
        const request = generation === 'rw6' ? 'request motion' : 'POST /rw/mastership/motion/request';
        expect(wire).toEqual(['read opmode', 'read ctrlstate', request, 'JOG']);
        await vi.advanceTimersByTimeAsync(2100);
        expect(wire.at(-1)).toBe(generation === 'rw6' ? 'release motion' : 'POST /rw/mastership/motion/release');
      });
    }
  }
});

describe('RobotManager.jog pre-flight: RobotWare 8', () => {
  it('no RMMP call; write access is taken, the motion-control declaration read, then the jog sent; one found standing at the registration is withdrawn first', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw8', ctl());
    await manager(adapter).jog(JOG);
    // The registration reads the allowance once: this client made none in this run, so it is
    // withdrawn and read back; the jog reads it again before it is sent, and the controller decides.
    expect(wire).toEqual(['read opmode', 'read ctrlstate', REGISTER, 'read motion control', 'POST /rw/controlstation/allowmotioncontrol', 'read motion control', WA_REQUEST, 'read motion control', 'JOG']);
    expect(wire.some(w => w.includes('/users/rmmp'))).toBe(false);
    await vi.advanceTimersByTimeAsync(2100);
    expect(wire.at(-1)).toBe(WA_RELEASE);
  });

  it('motion control read off: the jog is still sent under write access, which is released 2 s later', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw8', ctl({ motionControl: false }));
    const mgr = manager(adapter);
    await mgr.jog(JOG);
    expect(wire).toEqual(['read opmode', 'read ctrlstate', REGISTER, 'read motion control', WA_REQUEST, 'read motion control', 'JOG']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(wire.filter(w => w === WA_RELEASE)).toHaveLength(1);
    expect(mgr.state.access.locks.every(l => l.count === 0)).toBe(true);
  });

  it('inside a caller\'s write-access hold the refusal releases nothing', async () => {
    const { adapter, wire } = rws2('rw8', ctl({ motionControl: false }));
    (adapter as unknown as Record<string, unknown>).jog = async () => { wire.push('JOG'); throw jogPostRefusal(new RwsError('Refused', 'UNKNOWN', 403, undefined, -1073435872, 'Rejected')); };
    const mgr = manager(adapter);
    await mgr.requestMastership('rapid');
    const err = await refusal(mgr.jog(JOG));
    expect(err!.refusal?.kind).toBe('motion-control-off');
    expect(wire.filter(w => w === WA_RELEASE)).toHaveLength(0);
    await mgr.releaseMastership('rapid');
    expect(wire.at(-1)).toBe(WA_RELEASE);
  });
});

describe('RobotManager.jog: only a refusal of the jog POST is explained with the pre-flight reading', () => {
  /** A real RWS 2.0 jog (motion-system read, unit selection, jog POST) on a recorder; RobotWare 7 in AUTO. */
  function rw7Jog(refuse: Record<string, RwsError>) {
    const wire: string[] = [];
    const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    const a = adapter as unknown as Record<string, unknown>;
    a.writeAccessMode = 'mastership';
    a.req = async (method: string, path: string) => {
      const at = `${method} ${path}`;
      wire.push(at);
      if (refuse[at]) { throw refuse[at]; }
      if (at === 'GET /rw/motionsystem') {
        return JSON.stringify({ _links: { base: { href: 'https://x/' } }, state: [{ _type: 'ms', _title: 'motionsystem', 'change-count': '0', 'mechunit-name': 'ROB_1' }] });
      }
      return '';
    };
    a.getOperationMode = async () => { wire.push('read opmode'); return 'AUTO'; };
    a.getControllerState = async () => { wire.push('read ctrlstate'); return 'motoron'; };
    return { adapter, wire };
  }

  it('a refusal of the mechunit selection keeps its own explanation; the jog is not sent', async () => {
    const refused = new RwsError('Refused', 'UNKNOWN', 403);
    const { adapter, wire } = rw7Jog({ 'POST /rw/motionsystem/STN_1': refused });
    const err = await refusal(manager(adapter).jog({ ...JOG, mechunit: 'STN_1' }));
    expect(err).toBe(refused);
    expect(err!.code).toBe('UNKNOWN');
    expect(err!.message).not.toMatch(/refused the jog/);
    expect(wire).toContain('POST /rw/motionsystem/STN_1');
    expect(wire).not.toContain('POST /rw/motionsystem/jog');
  });

  it('a refused motion-system read keeps its own explanation', async () => {
    const refused = new RwsError('Refused', 'UNKNOWN', 403);
    const { adapter, wire } = rw7Jog({ 'GET /rw/motionsystem': refused });
    const err = await refusal(manager(adapter).jog(JOG));
    expect(err).toBe(refused);
    expect(wire).not.toContain('POST /rw/motionsystem/jog');
  });

  it('the same refusal of the jog POST itself is explained with the mode (WRONG_MODE)', async () => {
    const { adapter, wire } = rw7Jog({ 'POST /rw/motionsystem/jog': new RwsError('Refused', 'UNKNOWN', 403) });
    const err = await refusal(manager(adapter).jog(JOG));
    expect(wire).toContain('POST /rw/motionsystem/jog');
    expect(err).toMatchObject({ code: 'WRONG_MODE' });
    expect(err!.message).toContain('AUTO');
  });
});

describe('RobotManager.requestRmmp', () => {
  it('an unknown level is refused before anything is sent; exec and the deprecated exclusive are sent (tests/rmmp.acceptance.test.ts)', async () => {
    const { adapter, wire } = rws2('rw7', ctl());
    const mgr = manager(adapter);
    await expect(mgr.requestRmmp('full' as unknown as 'exec')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(wire).toEqual([]);
  });

  it('RobotWare 8: UNSUPPORTED_OPERATION, nothing sent', async () => {
    const { adapter, wire } = rws2('rw8', ctl());
    const err = await refusal(manager(adapter).requestRmmp());
    expect(err).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(wire).toEqual([]);
  });

  it('RobotWare 7 outside MANR: the mode is not read and the request is sent (tests/reviewFixes.test.ts covers the refusal)', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7', ctl({ opmode: 'AUTO', reads: ['none', 'modify'], polls: ['GRANTED'] }));
    const done = manager(adapter).requestRmmp();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await done).outcome).toBe('granted');
    expect(wire).not.toContain('read opmode');
    expect(wire).toContain('POST /users/rmmp privilege=modify');
  });

  it('RobotWare 6: ABB documents no mode rule, so the request is sent and the controller decides', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rw6(ctl({ opmode: 'AUTO', reads: ['none', 'modify'], polls: ['GRANTED'] }));
    const done = manager(adapter).requestRmmp();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await done).outcome).toBe('granted');
    expect(wire).toEqual(['GET /users/rmmp', 'POST /users/rmmp privilege=modify', 'GET /users/rmmp/poll', 'GET /users/rmmp']);
  });

  it('RobotWare 7 in MANR: pending, granted, and disconnect gives the privilege back before logging out', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7', ctl({ reads: ['none', 'pending modify', 'pending modify', 'modify'], polls: ['PENDING', 'PENDING', 'GRANTED'] }));
    const mgr = manager(adapter);
    const onPending = vi.fn();
    const done = mgr.requestRmmp('modify', { onPending });
    await vi.advanceTimersByTimeAsync(3000);
    const r = await done;
    expect(r).toMatchObject({ outcome: 'granted', privilege: 'modify' });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(wire).toEqual([
      'GET /users/rmmp', 'POST /users/rmmp privilege=modify',
      'GET /users/rmmp/poll', 'GET /users/rmmp', 'GET /users/rmmp/poll', 'GET /users/rmmp', 'GET /users/rmmp/poll', 'GET /users/rmmp',
    ]);
    await mgr.disconnect();
    expect(wire.slice(-2)).toEqual(['POST /users/rmmp/cancel', 'GET /logout']);
  });

  it('a privilege already granted to this session: granted, nothing sent', async () => {
    const { adapter, wire } = rws2('rw7', ctl({ reads: ['modify'] }));
    const r = await manager(adapter).requestRmmp();
    expect(r.outcome).toBe('granted');
    expect(wire).toEqual(['GET /users/rmmp']);
  });

  for (const generation of ['rw6', 'rw7'] as const) {
    it(`${generation}: exec held covers modify and exec: granted, nothing sent`, async () => {
      for (const level of ['modify', 'exec'] as const) {
        const { adapter, wire } = generation === 'rw6' ? rw6(ctl({ reads: ['exec'] })) : rws2(generation, ctl({ reads: ['exec'] }));
        const r = await manager(adapter).requestRmmp(level);
        expect(r).toMatchObject({ outcome: 'granted', privilege: 'exec' });
        expect(wire).toEqual(['GET /users/rmmp']);
      }
    });

    it(`${generation}: exec asked for while modify is held: held-lower, nothing sent, the detail says to cancel first`, async () => {
      const { adapter, wire } = generation === 'rw6' ? rw6(ctl({ reads: ['modify'] })) : rws2(generation, ctl({ reads: ['modify'] }));
      const r = await manager(adapter).requestRmmp('exec');
      expect(r).toMatchObject({ outcome: 'held-lower', privilege: 'modify' });
      expect(r.detail).toContain('cancelRmmp()');
      expect(r.detail).toContain('Nothing was sent');
      expect(wire).toEqual(['GET /users/rmmp']);
    });
  }

  it('the deprecated exclusive alias is exec: held-lower while modify is held', async () => {
    const { adapter, wire } = rws2('rw7', ctl({ reads: ['modify'] }));
    const r = await manager(adapter).requestRmmp('exclusive');
    expect(r.outcome).toBe('held-lower');
    expect(wire).toEqual(['GET /users/rmmp']);
  });

  it('held-lower still counts the held modify as this session\'s: disconnect gives it back', async () => {
    const { adapter, wire } = rws2('rw7', ctl({ reads: ['modify'] }));
    const mgr = manager(adapter);
    expect((await mgr.requestRmmp('exec')).outcome).toBe('held-lower');
    await mgr.disconnect();
    expect(wire.slice(-2)).toEqual(['POST /users/rmmp/cancel', 'GET /logout']);
  });

  it('after cancelRmmp, exec is requested and waited for', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7', ctl({ reads: ['modify', 'none', 'exec'], polls: ['GRANTED'] }));
    const mgr = manager(adapter);
    expect((await mgr.requestRmmp('exec')).outcome).toBe('held-lower');
    await mgr.cancelRmmp();
    const done = mgr.requestRmmp('exec');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toMatchObject({ outcome: 'granted', privilege: 'exec' });
    expect(wire).toEqual([
      'GET /users/rmmp', 'POST /users/rmmp/cancel',
      'GET /users/rmmp', 'POST /users/rmmp privilege=exec', 'GET /users/rmmp/poll', 'GET /users/rmmp',
    ]);
  });

  it('a second request while one waits is refused (CONTROLLER_BUSY); nothing more is sent', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7', ctl());
    const mgr = manager(adapter);
    const first = mgr.requestRmmp('modify', { waitMs: 3000 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(mgr.requestRmmp()).rejects.toMatchObject({ code: 'CONTROLLER_BUSY' });
    expect(wire.filter(w => w.startsWith('POST /users/rmmp privilege'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await first).outcome).toBe('expired');
    expect(wire.at(-1)).toBe('POST /users/rmmp/cancel');
  });

  it('cancelRmmp during the wait stops it; the request is cancelled once', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7', ctl());
    const mgr = manager(adapter);
    const done = mgr.requestRmmp();
    await vi.advanceTimersByTimeAsync(1500);
    await mgr.cancelRmmp();
    expect((await done).outcome).toBe('cancelled');
    expect(wire.filter(w => w === 'POST /users/rmmp/cancel')).toHaveLength(1);
  });

  it('the caller\'s signal aborts the wait, which cancels the request', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7', ctl());
    const abort = new AbortController();
    const done = manager(adapter).requestRmmp('modify', { signal: abort.signal });
    await vi.advanceTimersByTimeAsync(1500);
    abort.abort();
    expect((await done).outcome).toBe('cancelled');
    expect(wire.at(-1)).toBe('POST /users/rmmp/cancel');
  });

  it('disconnect during the wait cancels the request on the session before the logout', async () => {
    vi.useFakeTimers();
    const { adapter, wire } = rws2('rw7', ctl());
    const mgr = manager(adapter);
    const done = mgr.requestRmmp();
    await vi.advanceTimersByTimeAsync(1500);
    await mgr.disconnect();
    expect((await done).outcome).toBe('cancelled');
    const cancel = wire.indexOf('POST /users/rmmp/cancel');
    expect(cancel).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(wire.indexOf('GET /logout'));
  });

  it('a refused request is passed on as the controller answered it', async () => {
    const { adapter } = rws2('rw7', ctl());
    const refused = new RwsError('Rejected', 'GRANT_DENIED', 403, undefined, -1073445800);
    (adapter as unknown as Record<string, unknown>).requestRmmp = async () => { throw refused; };
    await expect(manager(adapter).requestRmmp()).rejects.toBe(refused);
  });
});

describe('refusals carry the refusal in plain words (RwsError.refusal)', () => {
  it('jog: the mode refusals name the condition and who supplies it (motors and motion control: tests/acceptanceStep6.test.ts)', async () => {
    const unexplained = (adapter: unknown) => { (adapter as Record<string, unknown>).jog = async () => { throw jogPostRefusal(new RwsError('Refused', 'UNKNOWN', 403)); }; return adapter; };
    const auto = await refusal(manager(unexplained(rws2('rw7', ctl({ opmode: 'AUTO' })).adapter)).jog(JOG));
    expect(auto!.refusal).toMatchObject({ kind: 'wrong-mode', condition: 'operating-mode', grantor: 'key-switch', generation: 'rw7', sentence: auto!.message.split(' Controller: ')[0] });

    const manf6 = await refusal(manager(unexplained(rw6(ctl({ opmode: 'MANF' })).adapter)).jog(JOG));
    expect(manf6!.refusal).toMatchObject({ kind: 'wrong-mode', missing: 'manual reduced speed (MANR)' });
  });

  it('requestRmmp: RobotWare 8 is unsupported (RobotWare 7 outside MANR: tests/reviewFixes.test.ts)', async () => {
    const rw8 = await refusal(manager(rws2('rw8', ctl()).adapter).requestRmmp());
    expect(rw8!.refusal).toMatchObject({ kind: 'unsupported', grantor: 'nobody', generation: 'rw8' });
  });
});
