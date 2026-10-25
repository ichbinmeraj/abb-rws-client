import { describe, it, expect, afterEach } from 'vitest';
import {
  AccessManager, type AccessDriver, type AccessLock, type AccessObservation, type AccessGeneration,
} from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type MastershipDomain } from '../src/types.js';

/**
 * What a session holds, and how a hold is lost, on the access manager alone
 * over a recording driver:
 * - the snapshot reports every lock of the generation, its count and since when,
 * - a write refused as "not held" while the operation's hold was counted is a
 *   loss, and nothing is released for it,
 * - after a loss the operation that held the lock requests nothing more; the
 *   next operation requests afresh,
 * - an operating-mode change ends mastership (RobotWare 6/7) and releases it
 *   once to be sure; on RobotWare 8 one status read decides,
 * - a count is never kept for a hold in doubt.
 */

type Gen = AccessGeneration;

interface Options {
  release?: unknown[];
  confirm?: (lock: AccessLock) => Promise<{ held: boolean; by?: string }> | null;
  /** The request for this lock waits for the promise. */
  slow?: { lock: AccessLock; until: Promise<void> };
}

function setup(gen: Gen, opts: Options = {}) {
  const wire: string[] = [];
  const events: AccessObservation[] = [];
  let m: AccessManager;
  const driver: AccessDriver = {
    label: 'TEST',
    locks: (): readonly AccessLock[] => (gen === 'rw6' ? ['cfg', 'motion', 'rapid'] : gen === 'rw7' ? ['edit', 'motion'] : ['writeaccess']),
    lockOf: (d: MastershipDomain): AccessLock => (gen === 'rw6' ? d : gen === 'rw7' ? (d === 'motion' ? 'motion' : 'edit') : 'writeaccess'),
    domainOf: (l: AccessLock): MastershipDomain => (l === 'cfg' || l === 'motion' ? l : 'rapid'),
    request: async (l: AccessLock) => {
      wire.push(`request ${l}`);
      if (opts.slow?.lock === l) { await opts.slow.until; }
    },
    release: async (l: AccessLock) => {
      wire.push(`release ${l}`);
      const e = opts.release?.shift();
      if (!e) { return; }
      // The RWS 2.0 client swallows RobotWare 8's "not held" and notes it.
      if (e instanceof RwsError && e.controllerCode === -1073435873) { m.noteReleaseNotHeld(l); return; }
      throw e;
    },
    generation: () => gen,
    watchdog: () => null,
    station: () => (gen === 'rw8' ? { registered: true, stationName: 'Line 3 cell PC' } : null),
    ...(opts.confirm ? { confirmHeld: opts.confirm } : {}),
  };
  m = new AccessManager(driver);
  m.on(e => events.push(e));
  return { m, wire, events };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

const masterReject = (): RwsError => new RwsError(
  'The user does not have required mastership for the operation', 'MASTERSHIP_REQUIRED', 403, undefined, -1073445859);
const notHeld8 = (): RwsError => new RwsError(
  'The control station does not have SPoC', 'MASTERSHIP_REQUIRED', 403, undefined, -1073435873);

const warnings: string[] = [];
function captureWarnings(): void {
  warnings.length = 0;
  setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
}

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('AccessManager snapshot: what the session holds and since when', () => {
  it('lists every lock of the generation, idle until the first hold', () => {
    const { m } = setup('rw6');
    expect(m.snapshot()).toEqual({
      generation: 'rw6',
      locks: [
        { lock: 'cfg', state: 'idle', count: 0, since: null },
        { lock: 'motion', state: 'idle', count: 0, since: null },
        { lock: 'rapid', state: 'idle', count: 0, since: null },
      ],
      watchdog: null,
      rw8: null,
    });
    expect(setup('rw8').m.snapshot()).toMatchObject({
      generation: 'rw8',
      locks: [{ lock: 'writeaccess', state: 'idle', count: 0, since: null }],
      rw8: { registered: true, stationName: 'Line 3 cell PC' },
    });
  });

  it('held: the count of nested holds and when the first was granted; idle again once released', async () => {
    const { m } = setup('rw7');
    const before = Date.now();
    const outer = await m.acquire('rapid');
    const inner = await m.acquire('cfg');
    const edit = (): unknown => m.snapshot().locks.find(l => l.lock === 'edit');
    expect(edit()).toMatchObject({ state: 'held', count: 2 });
    const since = (edit() as { since: number }).since;
    expect(since).toBeGreaterThanOrEqual(before);
    await m.release(inner);
    expect(edit()).toMatchObject({ state: 'held', count: 1, since });
    await m.release(outer);
    expect(edit()).toMatchObject({ state: 'idle', count: 0 });
    expect((edit() as { since: number | null }).since).not.toBeNull();
  });

  it('uncertain: a release that did not go through leaves the lock possibly held', async () => {
    captureWarnings();
    const { m } = setup('rw6', { release: [new RwsError('RWS1 timeout', 'NETWORK_ERROR')] });
    const h = await m.acquire('motion');
    await m.releaseQuietly(h);
    expect(m.snapshot().locks.find(l => l.lock === 'motion')).toMatchObject({ state: 'uncertain', count: 0 });
    // The next grant makes it held again.
    await m.acquire('motion');
    expect(m.snapshot().locks.find(l => l.lock === 'motion')).toMatchObject({ state: 'held', count: 1 });
  });

  it('a disconnect clears the record', async () => {
    const { m } = setup('rw6');
    await m.acquire('rapid');
    m.sessionEnded('disconnect');
    expect(m.snapshot().locks.find(l => l.lock === 'rapid')).toEqual({ lock: 'rapid', state: 'idle', count: 0, since: null });
  });
});

describe('AccessManager: a write refused as "not held" is a lost hold', () => {
  it('RobotWare 7: the loss is recorded, nothing is released for it, and the refusal is passed on unchanged', async () => {
    captureWarnings();
    const { m, wire, events } = setup('rw7');
    const refusal = masterReject();
    await expect(m.withAccess(['rapid'], async () => { wire.push('WRITE'); throw refusal; })).rejects.toBe(refusal);
    expect(wire).toEqual(['request edit', 'WRITE']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'edit', reason: 'unknown' }));
    expect(events.some(e => e.type === 'released')).toBe(false);
    expect(m.snapshot().locks.find(l => l.lock === 'edit')).toMatchObject({ state: 'lost', count: 0, lost: { reason: 'unknown' } });
    expect(warnings.some(w => /edit mastership was lost: the controller refused a write of this operation as not holding access \(code -1073445859\)/.test(w))).toBe(true);
  });

  it('RobotWare 8: a caller\'s own hold ends with it, and its release sends nothing', async () => {
    const { m, wire } = setup('rw8');
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    await expect(m.withAccess(['rapid'], async () => { throw notHeld8(); })).rejects.toMatchObject({ controllerCode: -1073435873 });
    expect(m.count('writeaccess')).toBe(0);
    await m.releasePublic('rapid', { lock: 'writeaccess' });
    expect(wire).toEqual(['request writeaccess']);
    // The next operation requests afresh.
    await m.withAccess(['rapid'], async () => { wire.push('WRITE'); });
    expect(wire).toEqual(['request writeaccess', 'request writeaccess', 'WRITE', 'release writeaccess']);
  });

  it('any other refusal is not a loss', async () => {
    const { m, wire, events } = setup('rw7');
    const other = new RwsError('Operation is illegal in current execution state', 'WRONG_MODE', 403, undefined, -1073442809);
    await expect(m.withAccess(['rapid'], async () => { throw other; })).rejects.toBe(other);
    expect(events.some(e => e.type === 'lost')).toBe(false);
    expect(wire).toEqual(['request edit', 'release edit']);
  });
});

describe('AccessManager: after a loss, the operation requests nothing more', () => {
  it('a later step of the same operation fails with MASTERSHIP_REQUIRED and sends nothing; the next operation requests afresh', async () => {
    captureWarnings();
    const { m, wire } = setup('rw7');
    let inner: unknown;
    await m.withAccess(['rapid'], async () => {
      wire.push('STEP 1');
      m.recordLoss(['edit'], 'opmode', 'the operating mode changed from AUTO to MANR');
      // A nested write of the same operation, as an adapter's own wrap does.
      inner = await m.withAccess(['rapid'], async () => { wire.push('STEP 2'); }).catch((e: unknown) => e);
    });
    expect(inner).toBeInstanceOf(RwsError);
    expect(inner).toMatchObject({ code: 'MASTERSHIP_REQUIRED' });
    expect((inner as Error).message).toMatch(/edit mastership was lost during this operation \(the operating mode changed from AUTO to MANR\)/);
    expect(wire).toEqual(['request edit', 'STEP 1']);

    await m.withAccess(['rapid'], async () => { wire.push('NEXT'); });
    expect(wire).toEqual(['request edit', 'STEP 1', 'request edit', 'NEXT', 'release edit']);
  });

  it('a lost lock the operation did not hold does not stop it', async () => {
    const { m, wire } = setup('rw7');
    await m.withAccess(['rapid'], async () => {
      m.recordLoss(['motion'], 'opmode', 'x');
      await m.withAccess(['rapid'], async () => { wire.push('STEP'); });
    });
    expect(wire).toEqual(['request edit', 'STEP', 'release edit']);
  });

  it('a session re-issued during an operation stops it the same way', async () => {
    captureWarnings();
    const { m, wire, events } = setup('rw6');
    let inner: unknown;
    await m.withAccess(['rapid'], async () => {
      m.sessionEnded('session-reissued');
      inner = await m.acquire('rapid').catch((e: unknown) => e);
    });
    expect(inner).toMatchObject({ code: 'MASTERSHIP_REQUIRED' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'rapid', reason: 'session-reissued' }));
    expect(wire).toEqual(['request rapid']);
  });
});

describe('AccessManager: an operating-mode change', () => {
  it('RobotWare 6: mastership held is lost and released once, to be sure', async () => {
    captureWarnings();
    const { m, wire, events } = setup('rw6');
    await m.requestPublic('rapid');
    m.noteModeChange('AUTO', 'MANR');
    await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'rapid', reason: 'opmode' }));
    const lost = events.find(e => e.type === 'lost') as { detail: string };
    expect(lost.detail).toMatch(/the operating mode changed from AUTO to MANR; ABB documents that a change between Auto and manual ends mastership on IRC5/);
    expect(wire).toEqual(['request rapid', 'release rapid']);
    // The lock stays reported as lost; the caller's own release sends nothing more.
    expect(m.snapshot().locks.find(l => l.lock === 'rapid')).toMatchObject({ state: 'lost', lost: { reason: 'opmode' } });
    await m.releasePublic('rapid');
    expect(wire).toEqual(['request rapid', 'release rapid']);
  });

  it('RobotWare 7: the undocumented direction is treated the same way, and says so', async () => {
    captureWarnings();
    const { m, events } = setup('rw7');
    await m.requestPublic('rapid');
    m.noteModeChange('MANR', 'AUTO');
    const lost = events.find(e => e.type === 'lost') as { detail: string };
    expect(lost.detail).toMatch(/from Auto to manual ends mastership on OmniCore; the other direction is not documented and is treated the same way/);
  });

  it('with nothing counted, a mode change sends nothing and reports nothing', async () => {
    const { m, wire, events } = setup('rw7');
    m.noteModeChange('AUTO', 'MANR');
    await tick();
    expect(wire).toEqual([]);
    expect(events).toEqual([]);
  });

  it('the release after the loss answered "not held" confirms the loss; it is not a second one', async () => {
    captureWarnings();
    const { m, wire, events } = setup('rw8', { release: [notHeld8()], confirm: async () => ({ held: false }) });
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    m.noteModeChange('AUTO', 'MANR');
    await tick();
    await tick();
    expect(wire).toEqual(['request writeaccess', 'release writeaccess']);
    expect(events.filter(e => e.type === 'lost')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'released', lock: 'writeaccess', alreadyCleared: true });
    expect(m.snapshot().locks[0]).toMatchObject({ state: 'lost', lost: { reason: 'opmode' } });
  });

  it('no release after the loss when a hold was granted again in the meantime', async () => {
    captureWarnings();
    let go!: () => void;
    const until = new Promise<void>(r => { go = r; });
    const { m, wire } = setup('rw6', { slow: { lock: 'motion', until } });
    await m.requestPublic('rapid');
    const motion = m.acquire('motion');           // on the wire, waiting
    const again = m.acquire('rapid');             // queued behind it
    m.noteModeChange('AUTO', 'MANR');             // rapid lost; its release queues behind both
    go();
    await motion;
    const h = await again;
    await tick();
    // The queued acquire found nothing counted after the loss and requested
    // afresh; the release after the loss then saw the new hold and sent nothing.
    expect(wire).toEqual(['request rapid', 'request motion', 'request rapid']);
    expect(h.live).toBe(true);
    expect(m.count('rapid')).toBe(1);
  });

  it('RobotWare 8: the controller still names this station - nothing changes', async () => {
    const { m, wire, events } = setup('rw8', { confirm: async () => ({ held: true }) });
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    m.noteModeChange('AUTO', 'MANR');
    await tick();
    expect(events.some(e => e.type === 'lost')).toBe(false);
    expect(m.count('writeaccess')).toBe(1);
    expect(wire).toEqual(['request writeaccess']);
  });

  it('RobotWare 8: another station holds it now - lost, naming that station, and released once', async () => {
    captureWarnings();
    const { m, wire, events } = setup('rw8', { confirm: async () => ({ held: false, by: 'FlexPendant' }) });
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    m.noteModeChange('AUTO', 'MANR');
    await tick();
    await tick();
    expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'writeaccess', reason: 'holder-changed', by: 'FlexPendant' }));
    expect(m.snapshot().locks[0]).toMatchObject({ state: 'lost', lost: { reason: 'holder-changed', by: 'FlexPendant' } });
    expect(wire).toEqual(['request writeaccess', 'release writeaccess']);
  });

  it('RobotWare 8: a status read that fails is taken as lost', async () => {
    captureWarnings();
    const { m, events } = setup('rw8', { confirm: async () => { throw new RwsError('RWS2 timeout', 'NETWORK_ERROR'); } });
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    m.noteModeChange('AUTO', 'MANR');
    await tick();
    const lost = events.find(e => e.type === 'lost') as { reason: string; detail: string };
    expect(lost.reason).toBe('opmode');
    expect(lost.detail).toMatch(/could not be read \(RWS2 timeout\)/);
  });

  it('RobotWare 8: a hold that ended normally before the status came back is left alone', async () => {
    let answer!: (v: { held: boolean }) => void;
    const { m, wire, events } = setup('rw8', { confirm: () => new Promise(r => { answer = r; }) });
    await m.withAccess(['rapid'], async () => {
      m.noteModeChange('AUTO', 'MANR');
    });
    answer({ held: false });
    await tick();
    expect(events.some(e => e.type === 'lost')).toBe(false);
    expect(wire).toEqual(['request writeaccess', 'release writeaccess']);
  });
});
