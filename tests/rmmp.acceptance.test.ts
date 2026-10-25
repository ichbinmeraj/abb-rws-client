import { describe, it, expect, afterEach } from 'vitest';
import { waitForRmmp, type RmmpPort } from '../src/access/rmmp.js';
import { refusalFor, type ControllerAnswer } from '../src/refusal.js';
import { RobotManager } from '../src/RobotManager.js';
import { RwsError } from '../src/types.js';
import { setLogger } from '../src/Logger.js';

/**
 * RMMP findings from acceptance step 5 (RobotWare 7.21.4 in MANR, 2026-10-12):
 * 1. A request the controller never showed as pending must not be reported
 *    as "no one granted it"; the answers the controller gave are named, and
 *    every poll and read is logged so a live run records them.
 * 2. A program-pointer move refused with SYS_CTRL_E_MODE_REJECT in manual mode
 *    on RobotWare 7 is explained as ABB's manual-mode rule, not "turn the key".
 * 3. SYS_CTRL_E_RMMP_E_REJECT in MANR names the enabling device as the missing
 *    part.
 * 4. requestRmmp sends 'exec' (the family adds no prohibitions of its own);
 *    'exclusive' stays the deprecated alias of 'exec'.
 */

const traces: string[] = [];
afterEach(() => { traces.length = 0; setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

function port(poll: () => string, read: () => string): { port: RmmpPort; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    port: {
      request: async l => { sent.push(`request ${l}`); },
      poll: async () => { sent.push('poll'); return poll(); },
      read: async () => { sent.push('read'); return read(); },
      cancel: async () => { sent.push('cancel'); },
    },
  };
}

describe('item 1: an RMMP request the controller never showed as pending', () => {
  it('is not reported as "no one granted": it says the request never stood and names the last answers', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {}, trace(_c: string, m: string) { traces.push(m); } });
    const { port: p, sent } = port(() => '', () => 'none');
    const r = await waitForRmmp(p, 'modify', { waitMs: 1200, pollMs: 250 }, 'rw7');
    expect(r.outcome).toBe('expired');
    expect(r.detail).not.toMatch(/No one granted/);
    expect(r.detail).toMatch(/never showed this RMMP request as waiting/);
    expect(r.detail).toMatch(/last poll answer ''/);
    expect(r.detail).toMatch(/last privilege read 'none'/);
    expect(r.refusal?.sentence).toBe(r.detail);
    expect(r.refusal?.fix).not.toMatch(/stand by/);
    expect(sent.at(-1)).toBe('cancel');
    // Every poll and read answer is logged, for the live re-test.
    expect(traces.some(t => /RMMP poll answered ''/.test(t))).toBe(true);
    expect(traces.some(t => /RMMP privilege read 'none'/.test(t))).toBe(true);
  });

  it('a request the controller kept pending the whole time is still reported as not granted in time', async () => {
    const { port: p } = port(() => 'PENDING', () => 'pending modify');
    const r = await waitForRmmp(p, 'modify', { waitMs: 800, pollMs: 250 }, 'rw7');
    expect(r.outcome).toBe('expired');
    expect(r.detail).toMatch(/The controller held the RMMP request pending/);
    expect(r.refusal?.kind).toBe('rmmp-expired');
  });
});

const answer = (code: number, over: Partial<ControllerAnswer> = {}): ControllerAnswer => ({
  http: 403, code, msg: `Refused code:${code} icode:-1`, method: 'POST', path: '/rw/panel/speedratio', ...over,
});

describe('item 2: a program-pointer move refused in manual mode on RobotWare 7', () => {
  for (const path of ['/rw/rapid/execution/resetpp', '/rw/rapid/tasks/T_ROB1/pcp/routine']) {
    it(`${path}: names ABB's manual-mode rule, says RMMP does not cover it, and does not advise the key switch`, () => {
      const r = refusalFor(answer(-1073445860, { path }), { generation: 'rw7', opmode: 'MANR', robot: 'cell-7', rmmp: 'granted' })!.refusal;
      expect(r.kind).toBe('wrong-mode');
      expect(r.sentence).toMatch(path.endsWith("resetpp") ? /cannot be performed in manual mode/ : /only with RMMP exec; RMMP modify does not cover it/);
      expect(r.sentence).toMatch(/in MANR. /);
      expect(r.sentence).toMatch(/FlexPendant|Auto/);
      expect(r.sentence).not.toMatch(/key switch or mode selector/);
      expect(r.grantor).toBe('pendant-operator');
    });
  }

  it('in Auto, or for another operation, the general sentence stays', () => {
    const auto = refusalFor(answer(-1073445860, { path: '/rw/rapid/execution/resetpp' }), { generation: 'rw7', opmode: 'AUTO' })!.refusal;
    expect(auto.sentence).toMatch(/key switch or mode selector/);
    const other = refusalFor(answer(-1073445860), { generation: 'rw7', opmode: 'MANR' })!.refusal;
    expect(other.sentence).toMatch(/key switch or mode selector/);
  });
});

describe('item 3: an RMMP request refused in MANR', () => {
  it('names the enabling device as the missing part', () => {
    const r = refusalFor(answer(-1073445800, { path: '/users/rmmp' }), { generation: 'rw7', opmode: 'MANR', robot: 'cell-7' })!.refusal;
    expect(r.kind).toBe('rmmp-wrong-mode');
    expect(r.sentence).toMatch(/in MANR/);
    expect(r.sentence).toMatch(/enabling device/);
    expect(r.sentence).not.toMatch(/it needs manual reduced speed \(MANR\) with the enabling device held, and the controller is in MANR/);
    expect(r.missing).toMatch(/enabling device/);
    expect(r.missing).not.toMatch(/manual reduced speed/);
  });

  it('in another mode it still names MANR', () => {
    const r = refusalFor(answer(-1073445800, { path: '/users/rmmp' }), { generation: 'rw7', opmode: 'MANF' })!.refusal;
    expect(r.sentence).toMatch(/manual reduced speed \(MANR\)/);
    expect(r.sentence).toMatch(/MANF/);
  });
});

describe('item 4: RobotManager.requestRmmp sends exec', () => {
  function managerOver(answers: { request?: (l: string) => Promise<void> } = {}): { mgr: RobotManager; sent: string[] } {
    const sent: string[] = [];
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown>; access: (a: unknown) => { generation: () => string } };
    m.adapter = {
      getOperationMode: async () => 'MANR',
      getRmmpPrivilege: async () => (sent.some(s => s.startsWith('request')) ? 'exec' : 'none'),
      requestRmmp: answers.request ?? (async (l: string) => { sent.push(`request ${l}`); }),
      pollRmmp: async () => { sent.push('poll'); return 'NO SUCH REQUEST'; },
      cancelRmmp: async () => { sent.push('cancel'); },
      requestMastership: async () => {}, releaseMastership: async () => {},
    };
    const realAccess = m.access.bind(mgr);
    m.access = (a: unknown) => { const x = realAccess(a); (x as { generation: () => string }).generation = () => 'rw7'; return x; };
    return { mgr, sent };
  }

  it('\'exec\' is sent as asked and granted', async () => {
    const { mgr, sent } = managerOver();
    const r = await mgr.requestRmmp('exec', { waitMs: 2000, pollMs: 250 });
    expect(sent[0]).toBe('request exec');
    expect(r).toMatchObject({ outcome: 'granted', privilege: 'exec' });
  });

  it('\'exclusive\' is the deprecated alias of exec', async () => {
    const { mgr, sent } = managerOver();
    await mgr.requestRmmp('exclusive', { waitMs: 2000, pollMs: 250 });
    expect(sent[0]).toBe('request exec');
  });

  it('a controller refusal of exec is passed through with its explained sentence', async () => {
    const refused = new RwsError('refused', 'WRONG_MODE', 403, undefined, -1073445800,
      'Operation not allowed due to not in manual reduced speed or enabling device released.');
    const { mgr } = managerOver({ request: async () => { throw refused; } });
    await expect(mgr.requestRmmp('exec', { waitMs: 2000, pollMs: 250 })).rejects.toBe(refused);
  });
});
