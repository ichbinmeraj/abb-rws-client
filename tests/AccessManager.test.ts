import { describe, it, expect, afterEach } from 'vitest';
import {
  AccessManager, type AccessDriver, type AccessObservation, type AccessLock,
} from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type MastershipDomain } from '../src/types.js';

/**
 * The access manager on its own, over a recording driver. It decides WHEN a
 * lock is requested and released; these tests check that decision:
 * - nested holds on one real lock cost one request and one release,
 * - only the release that ends the last hold goes on the wire, so an inner
 *   release never ends an outer or caller-held hold,
 * - writes run one at a time, first come first served,
 * - every error path leaves the count right,
 * - a release answered "not held" while a hold was counted is recorded as a
 *   loss, not dropped.
 *
 * Lock sets per generation: RobotWare 6 cfg/motion/rapid, RobotWare 7
 * edit/motion (rapid and cfg are edit), RobotWare 8 one write access.
 */

type Gen = 'rw6' | 'rw7' | 'rw8';

interface Script {
  request?: unknown[];
  release?: unknown[];
  /** Simulate the RWS 2.0 client: a release refused as "not held" is swallowed and noted. */
  noteNotHeld?: boolean;
}

function driverFor(gen: Gen, wire: string[], script: Script = {}, manager?: () => AccessManager): AccessDriver {
  const next = (q: unknown[] | undefined): unknown => q?.shift();
  return {
    label: 'TEST',
    locks: (): readonly AccessLock[] => (gen === 'rw6' ? ['cfg', 'motion', 'rapid'] : gen === 'rw7' ? ['edit', 'motion'] : ['writeaccess']),
    lockOf: (d: MastershipDomain): AccessLock => (gen === 'rw6' ? d : gen === 'rw7' ? (d === 'motion' ? 'motion' : 'edit') : 'writeaccess'),
    domainOf: (l: AccessLock): MastershipDomain => (l === 'cfg' || l === 'motion' ? l : 'rapid'),
    request: async (l: AccessLock) => {
      wire.push(`request ${l}`);
      const e = next(script.request);
      if (e) { throw e; }
    },
    release: async (l: AccessLock) => {
      wire.push(`release ${l}`);
      const e = next(script.release);
      if (!e) { return; }
      if (script.noteNotHeld && e instanceof RwsError && e.controllerCode === -1073435873) {
        manager!().noteReleaseNotHeld(l);
        return;
      }
      throw e;
    },
  };
}

function setup(gen: Gen, script: Script = {}) {
  const wire: string[] = [];
  const events: AccessObservation[] = [];
  let m: AccessManager;
  const driver = driverFor(gen, wire, script, () => m);
  m = new AccessManager(driver);
  m.on(e => events.push(e));
  return { m, wire, events };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

const notHeld8 = (): RwsError => new RwsError(
  'The control station does not have SPoC', 'MASTERSHIP_REQUIRED', 403, undefined, -1073435873,
  'The control station does not have SPoC. code:-1073435873 icode:-20107');

function captureWarnings(): string[] {
  const warnings: string[] = [];
  setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
  return warnings;
}

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('AccessManager: nested holds', () => {
  it('two holds on one lock cost one request, and only the last release goes out', async () => {
    const { m, wire } = setup('rw6');
    const outer = await m.acquire('rapid');
    const inner = await m.acquire('rapid');
    expect(wire).toEqual(['request rapid']);
    await m.release(inner);
    expect(wire).toEqual(['request rapid']);
    expect(m.count('rapid')).toBe(1);
    await m.release(outer);
    expect(wire).toEqual(['request rapid', 'release rapid']);
    expect(m.count('rapid')).toBe(0);
  });

  it('releasing the same hold twice sends one release', async () => {
    const { m, wire } = setup('rw6');
    const h = await m.acquire('motion');
    await m.release(h);
    await m.release(h);
    expect(wire).toEqual(['request motion', 'release motion']);
  });

  it('RobotWare 6 keeps cfg, motion and rapid apart', async () => {
    const { m, wire } = setup('rw6');
    const r = await m.acquire('rapid');
    const c = await m.acquire('cfg');
    await m.release(c);
    expect(wire).toEqual(['request rapid', 'request cfg', 'release cfg']);
    await m.release(r);
    expect(wire.at(-1)).toBe('release rapid');
  });

  it('RobotWare 7: rapid and cfg are one edit lock, motion is another', async () => {
    const { m, wire } = setup('rw7');
    const r = await m.acquire('rapid');
    const c = await m.acquire('cfg');
    const mo = await m.acquire('motion');
    expect(wire).toEqual(['request edit', 'request motion']);
    await m.release(mo);
    expect(wire.at(-1)).toBe('release motion');
    await m.release(r);
    expect(wire.at(-1)).toBe('release motion');   // cfg still holds edit
    await m.release(c);
    expect(wire.at(-1)).toBe('release edit');
  });

  it('RobotWare 8: a write inside a caller\'s write-access hold never ends it', async () => {
    const { m, wire } = setup('rw8');
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    // An adapter write that wraps itself in the motion domain: the same lock on RW8.
    await m.withAccess(['motion'], async () => { wire.push('write'); });
    await m.withAccess(['rapid'], async () => { wire.push('write'); });
    expect(wire).toEqual(['request writeaccess', 'write', 'write']);
    await m.releasePublic('rapid', { lock: 'writeaccess' });
    expect(wire).toEqual(['request writeaccess', 'write', 'write', 'release writeaccess']);
  });

  it('a caller\'s release pairs with its own request; an operation still holding the lock keeps it', async () => {
    const { m, wire } = setup('rw7');
    await m.requestPublic('rapid');
    const gate = deferred();
    const op = m.withAccess(['rapid'], async () => { wire.push('write'); await gate.promise; wire.push('write 2'); });
    await tick();
    await m.releasePublic('rapid');          // the caller lets go mid-operation
    expect(wire).toEqual(['request edit', 'write']);
    gate.resolve();
    await op;
    // The operation's own release is the last hold's: now it goes out, after its writes.
    expect(wire).toEqual(['request edit', 'write', 'write 2', 'release edit']);
  });

  it('a release with no hold of the caller\'s is sent when nothing is counted, and held back while an operation holds the lock', async () => {
    const { m, wire } = setup('rw7');
    await m.releasePublic('rapid');
    expect(wire).toEqual(['release edit']);

    wire.length = 0;
    const gate = deferred();
    const op = m.withAccess(['cfg'], async () => { wire.push('write'); await gate.promise; });
    await tick();
    await m.releasePublic('rapid');          // unbalanced: must not end the operation's hold
    expect(wire).toEqual(['request edit', 'write']);
    gate.resolve();
    await op;
    expect(wire).toEqual(['request edit', 'write', 'release edit']);
  });

  it('a controller that says the lock is already this session\'s counts as a grant', async () => {
    const already = new RwsError('already held by caller', 'UNKNOWN', 403, undefined, -1073445872);
    const { m, wire } = setup('rw6', { request: [already] });
    const h = await m.acquire('rapid');
    expect(m.count('rapid')).toBe(1);
    await m.release(h);
    expect(wire).toEqual(['request rapid', 'release rapid']);
  });
});

describe('AccessManager: all domains', () => {
  it('requestPublicAll with every lock free sends the one all-domains request and counts each lock', async () => {
    const { m, wire } = setup('rw6');
    const all = { request: async () => { wire.push('request all'); }, release: async () => { wire.push('release all'); } };
    await m.requestPublicAll(all);
    expect(wire).toEqual(['request all']);
    expect(['cfg', 'motion', 'rapid'].map(l => m.count(l as AccessLock))).toEqual([1, 1, 1]);
    // A write inside it on any domain sends nothing.
    await m.withAccess(['motion'], async () => { wire.push('write'); });
    expect(wire).toEqual(['request all', 'write']);
    await m.releasePublicAll(all);
    expect(wire).toEqual(['request all', 'write', 'release all']);
  });

  it('with one lock already held, only the missing ones are requested and released', async () => {
    const { m, wire } = setup('rw6');
    const all = { request: async () => { wire.push('request all'); }, release: async () => { wire.push('release all'); } };
    await m.requestPublic('rapid');
    await m.requestPublicAll(all);
    expect(wire).toEqual(['request rapid', 'request cfg', 'request motion']);
    await m.releasePublicAll(all);
    // rapid is still the caller's per-domain hold.
    expect(wire.slice(3)).toEqual(['release cfg', 'release motion']);
    expect(m.count('rapid')).toBe(1);
    await m.releasePublic('rapid');
    expect(wire.at(-1)).toBe('release rapid');
  });

  it('releasePublicAll with no all-domains hold ends the caller\'s holds but not an operation\'s', async () => {
    const { m, wire } = setup('rw7');
    const all = { request: async () => { wire.push('request all'); }, release: async () => { wire.push('release all'); } };
    await m.requestPublic('motion');
    const gate = deferred();
    const op = m.withAccess(['rapid'], async () => { wire.push('write'); await gate.promise; });
    await tick();
    await m.releasePublicAll(all);
    // motion was only the caller's: released. edit belongs to the operation: kept.
    expect(wire).toEqual(['request motion', 'request edit', 'write', 'release motion']);
    gate.resolve();
    await op;
    expect(wire.at(-1)).toBe('release edit');
  });

  it('a refused all-domains request releases the locks it did take and counts nothing', async () => {
    const refused = new RwsError('held by someone else', 'MASTERSHIP_REQUIRED', 403, undefined, -1073445862);
    const { m, wire } = setup('rw6', { request: [undefined, undefined, refused] });
    await m.requestPublic('cfg');              // cfg held: the all-request goes per lock
    await expect(m.requestPublicAll()).rejects.toBe(refused);
    expect(wire).toEqual(['request cfg', 'request motion', 'request rapid', 'release motion']);
    expect(m.count('motion')).toBe(0);
    expect(m.count('rapid')).toBe(0);
    expect(m.count('cfg')).toBe(1);
  });
});

describe('AccessManager: one write at a time', () => {
  it('serialises concurrent operations: request, write, release, then the next', async () => {
    const { m, wire } = setup('rw7');
    const gateA = deferred();
    const a = m.withAccess(['rapid'], async () => { wire.push('write A'); await gateA.promise; });
    const b = m.withAccess(['rapid'], async () => { wire.push('write B'); });
    await tick();
    // B's request is not sent while A is in progress.
    expect(wire).toEqual(['request edit', 'write A']);
    gateA.resolve();
    await Promise.all([a, b]);
    expect(wire).toEqual([
      'request edit', 'write A', 'release edit',
      'request edit', 'write B', 'release edit',
    ]);
  });

  it('runs queued operations first come, first served', async () => {
    const { m, wire } = setup('rw6');
    const gate = deferred();
    const first = m.withAccess(['rapid'], async () => { wire.push('1'); await gate.promise; });
    const ops = [2, 3, 4].map(n => m.withAccess(['cfg'], async () => { wire.push(String(n)); }));
    await tick();
    gate.resolve();
    await Promise.all([first, ...ops]);
    expect(wire.filter(w => /^\d$/.test(w))).toEqual(['1', '2', '3', '4']);
  });

  it('an operation inside an operation does not wait on itself', async () => {
    const { m, wire } = setup('rw7');
    await m.withAccess(['rapid'], async () => {
      await m.withAccess(['rapid'], async () => { wire.push('inner write'); });
      wire.push('outer write');
    });
    expect(wire).toEqual(['request edit', 'inner write', 'outer write', 'release edit']);
  });

  it('refuses a write that waited too long with CONTROLLER_BUSY and sends nothing for it', async () => {
    const { m, wire } = setup('rw7');
    m.queueTimeoutMs = 30;
    const gate = deferred();
    const a = m.withAccess(['rapid'], async () => { wire.push('write A'); await gate.promise; });
    let ranB = false;
    const b = m.withAccess(['motion'], async () => { ranB = true; });
    const err = await b.then(() => null, (e: unknown) => e as RwsError);
    expect(err).toBeInstanceOf(RwsError);
    expect(err!.code).toBe('CONTROLLER_BUSY');
    expect(err!.message).toMatch(/another write to this controller is in progress/);
    expect(ranB).toBe(false);
    expect(wire).toEqual(['request edit', 'write A']);
    gate.resolve();
    await a;
    // The turn passes on normally afterwards.
    await m.withAccess(['motion'], async () => { wire.push('write C'); });
    expect(wire.slice(-3)).toEqual(['request motion', 'write C', 'release motion']);
  });

  it('work started detached from an operation queues behind it instead of slipping into it', async () => {
    const { m, wire } = setup('rw7');
    let started: Promise<void> | undefined;
    await m.withAccess(['rapid'], async () => {
      wire.push('write A');
      // e.g. a change handler the operation notifies, which starts a write
      started = m.detach(() => m.withAccess(['motion'], async () => { wire.push('write B'); }));
      await tick();
      wire.push('write A2');
    });
    await started;
    expect(wire).toEqual([
      'request edit', 'write A', 'write A2', 'release edit',
      'request motion', 'write B', 'release motion',
    ]);
  });

  it('plain holds only count: they never wait for the operation in progress', async () => {
    const { m, wire } = setup('rw6');
    const gate = deferred();
    const op = m.withAccess(['rapid'], async () => { await gate.promise; });
    await tick();
    const h = await m.acquire('motion');
    expect(wire).toEqual(['request rapid', 'request motion']);
    await m.release(h);
    gate.resolve();
    await op;
  });
});

describe('AccessManager: error paths', () => {
  it('a refused request fails the operation before it runs, releases nothing and counts nothing', async () => {
    const refused = new RwsError('held by someone else', 'MASTERSHIP_REQUIRED', 403, undefined, -1073445862);
    const { m, wire } = setup('rw7', { request: [refused] });
    let ran = false;
    await expect(m.withAccess(['rapid'], async () => { ran = true; })).rejects.toBe(refused);
    expect(ran).toBe(false);
    expect(wire).toEqual(['request edit']);
    expect(m.count('edit')).toBe(0);
    // The next operation requests afresh.
    await m.withAccess(['rapid'], async () => { wire.push('write'); });
    expect(wire).toEqual(['request edit', 'request edit', 'write', 'release edit']);
  });

  it('when the second of two locks is refused, the first is released', async () => {
    const refused = new RwsError('held by someone else', 'MASTERSHIP_REQUIRED', 403, undefined, -1073445862);
    const { m, wire } = setup('rw6', { request: [undefined, refused] });
    await expect(m.withAccess(['rapid', 'cfg'], async () => { wire.push('write'); })).rejects.toBe(refused);
    expect(wire).toEqual(['request rapid', 'request cfg', 'release rapid']);
  });

  it('a failing write still releases, and its error is what the caller sees', async () => {
    const { m, wire } = setup('rw7');
    const boom = new RwsError('write refused', 'WRONG_MODE', 403);
    await expect(m.withAccess(['rapid'], async () => { wire.push('write'); throw boom; })).rejects.toBe(boom);
    expect(wire).toEqual(['request edit', 'write', 'release edit']);
    expect(m.count('edit')).toBe(0);
  });

  it('a failed release inside an operation is logged, not thrown over its result', async () => {
    const warnings = captureWarnings();
    const busy = new RwsError('Controller busy (503)', 'CONTROLLER_BUSY', 503);
    const { m, wire, events } = setup('rw6', { release: [busy] });
    await expect(m.withAccess(['rapid'], async () => 'done')).resolves.toBe('done');
    expect(wire).toEqual(['request rapid', 'release rapid']);
    expect(m.count('rapid')).toBe(0);
    expect(warnings.some(w => /may stay held until this session ends/.test(w))).toBe(true);
    expect(events.some(e => e.type === 'releaseFailed' && e.lock === 'rapid')).toBe(true);
  });

  it('a failed release through the public release is thrown to its caller', async () => {
    const busy = new RwsError('Controller busy (503)', 'CONTROLLER_BUSY', 503);
    const { m } = setup('rw6', { release: [busy] });
    await m.requestPublic('rapid');
    await expect(m.releasePublic('rapid')).rejects.toBe(busy);
    expect(m.count('rapid')).toBe(0);
  });

  it('a restart that the controller accepts is not released; a refused one is', async () => {
    const { m, wire } = setup('rw7');
    await m.withAccess(['rapid'], async () => { wire.push('restart'); }, { releaseOnSuccess: false });
    expect(wire).toEqual(['request edit', 'restart']);
    expect(m.count('edit')).toBe(0);

    wire.length = 0;
    const refused = new RwsError('restart refused', 'WRONG_MODE', 403);
    await expect(m.withAccess(['rapid'], async () => { throw refused; }, { releaseOnSuccess: false })).rejects.toBe(refused);
    expect(wire).toEqual(['request edit', 'release edit']);
  });
});

describe('AccessManager: losses are recorded, never dropped', () => {
  it('RobotWare 8: a counted release answered "not held" is a loss (event and warning)', async () => {
    const warnings = captureWarnings();
    const { m, wire, events } = setup('rw8', { release: [notHeld8()], noteNotHeld: true });
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    await expect(m.releasePublic('rapid', { lock: 'writeaccess' })).resolves.toBeUndefined();
    expect(wire).toEqual(['request writeaccess', 'release writeaccess']);
    expect(events).toContainEqual({ type: 'released', lock: 'writeaccess', alreadyCleared: true });
    const lost = events.find(e => e.type === 'lost');
    expect(lost).toMatchObject({ type: 'lost', lock: 'writeaccess', reason: 'unknown' });
    expect(warnings.some(w => /write access was lost/.test(w))).toBe(true);
    // Not reported as an ordinary release as well.
    expect(events.filter(e => e.type === 'released')).toHaveLength(1);
  });

  it('RobotWare 8: the same answer to a release this session counted nothing on is only noted', async () => {
    const warnings = captureWarnings();
    const { m, events } = setup('rw8', { release: [notHeld8()], noteNotHeld: true });
    await m.releasePublic('rapid', { lock: 'writeaccess' });
    expect(events).toEqual([{ type: 'released', lock: 'writeaccess', alreadyCleared: true }]);
    expect(warnings).toEqual([]);
  });

  it('RobotWare 6/7: a release refused as "resource not held" is a loss too, and not thrown', async () => {
    const warnings = captureWarnings();
    const notHeld = new RwsError('The resource is not held by caller', 'UNKNOWN', 403, undefined, -1073445880);
    const { m, events } = setup('rw7', { release: [notHeld] });
    await m.requestPublic('rapid');
    await expect(m.releasePublic('rapid')).resolves.toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'edit', reason: 'unknown' }));
    expect(warnings.some(w => /edit mastership was lost/.test(w))).toBe(true);
  });

  it('a lost hold is not revived: its release sends nothing, and the next operation requests afresh', async () => {
    const { m, wire, events } = setup('rw8');
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    const gate = deferred();
    const op = m.withAccess(['motion'], async () => { await gate.promise; });
    await tick();
    m.recordLoss(['writeaccess'], 'unknown', 'test');
    expect(m.count('writeaccess')).toBe(0);
    gate.resolve();
    await op;                                   // its release: nothing to send
    await m.releasePublic('rapid', { lock: 'writeaccess' });   // pairs with the lost hold
    expect(wire).toEqual(['request writeaccess']);
    expect(events.filter(e => e.type === 'lost')).toHaveLength(1);

    await m.withAccess(['rapid'], async () => { wire.push('write'); });
    expect(wire).toEqual(['request writeaccess', 'request writeaccess', 'write', 'release writeaccess']);
  });

  it('a re-issued session loses every counted hold; a disconnect ends them without a loss', async () => {
    const warnings = captureWarnings();
    const { m, wire, events } = setup('rw7');
    await m.requestPublic('rapid');
    const h = await m.acquire('motion');
    m.sessionEnded('session-reissued');
    expect(events.filter(e => e.type === 'lost').map(e => e.lock).sort()).toEqual(['edit', 'motion']);
    expect(warnings.some(w => /re-issued the session/.test(w))).toBe(true);
    await m.release(h);
    await m.releasePublic('rapid');             // no hold left: a plain release, as asked
    expect(wire).toEqual(['request edit', 'request motion', 'release edit']);

    events.length = 0;
    await m.requestPublic('motion');
    m.sessionEnded('disconnect');
    expect(events.filter(e => e.type === 'lost')).toEqual([]);
    expect(events).toContainEqual({ type: 'released', lock: 'motion' });
  });
});
