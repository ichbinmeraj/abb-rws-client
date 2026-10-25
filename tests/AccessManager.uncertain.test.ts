import { describe, it, expect, afterEach } from 'vitest';
import { AccessManager, type AccessDriver, type AccessLock, type AccessObservation } from '../src/access/AccessManager.js';
import type { MastershipDomain } from '../src/types.js';
import { RwsError } from '../src/types.js';
import { setLogger } from '../src/Logger.js';

/**
 * An acquire whose request did not answer (NETWORK_ERROR: a timeout, a dropped
 * connection) is not taken as "not held": the controller may have granted it.
 * When the driver can read whether this session holds the lock (`heldByMe`),
 * the manager reads it once: held -> the hold is counted; not held -> the
 * error is passed on and nothing is counted; the read itself fails -> the lock
 * is `uncertain`, an `uncertain` observation is emitted and the error is
 * passed on. A driver without the read keeps the old behaviour.
 */

const network = (): RwsError => new RwsError('RWS2 timeout: /rw/controlstation/writeaccess/request', 'NETWORK_ERROR');

function driver(opts: { heldByMe?: (lock: AccessLock) => Promise<boolean>; requestFails?: boolean }): { d: AccessDriver; wire: string[] } {
  const wire: string[] = [];
  const d: AccessDriver = {
    label: 'T',
    locks: () => ['writeaccess'],
    lockOf: () => 'writeaccess',
    domainOf: (): MastershipDomain => 'rapid',
    request: async (lock) => { wire.push(`request ${lock}`); if (opts.requestFails !== false) { throw network(); } },
    release: async (lock) => { wire.push(`release ${lock}`); },
    generation: () => 'rw8',
    ...(opts.heldByMe ? { heldByMe: (lock: AccessLock) => { wire.push(`heldByMe ${lock}`); return opts.heldByMe!(lock); } } : {}),
  };
  return { d, wire };
}

const logged: string[] = [];
afterEach(() => { logged.length = 0; setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('AccessManager: an acquire that did not answer', () => {
  it('held by this session after all: the hold is counted, acquired is emitted and the fact is logged', async () => {
    setLogger({ info(m) { logged.push(m); }, warn(m) { logged.push(m); }, error() {}, show() {} });
    const { d, wire } = driver({ heldByMe: async () => true });
    const m = new AccessManager(d);
    const seen: AccessObservation[] = [];
    m.on(e => seen.push(e));
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    expect(wire).toEqual(['request writeaccess', 'heldByMe writeaccess']);
    expect(m.count('writeaccess')).toBe(1);
    expect(m.snapshot().locks[0]).toMatchObject({ lock: 'writeaccess', state: 'held', count: 1 });
    expect(seen).toEqual([{ type: 'acquired', lock: 'writeaccess' }]);
    expect(logged.some(l => /did not answer/.test(l) && /holds it/.test(l))).toBe(true);
    await m.releasePublic('rapid', { lock: 'writeaccess' });
    expect(wire.at(-1)).toBe('release writeaccess');
  });

  it('not held: the error is passed on, nothing is counted, the lock stays idle', async () => {
    const { d, wire } = driver({ heldByMe: async () => false });
    const m = new AccessManager(d);
    const seen: AccessObservation[] = [];
    m.on(e => seen.push(e));
    await expect(m.requestPublic('rapid', { lock: 'writeaccess' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(wire).toEqual(['request writeaccess', 'heldByMe writeaccess']);
    expect(m.count('writeaccess')).toBe(0);
    expect(m.snapshot().locks[0]).toMatchObject({ lock: 'writeaccess', state: 'idle', count: 0 });
    expect(seen).toEqual([]);
  });

  it('the read fails too: the lock is uncertain, an uncertain observation is emitted, the error is passed on', async () => {
    const { d } = driver({ heldByMe: async () => { throw new RwsError('RWS2 timeout: status', 'NETWORK_ERROR'); } });
    const m = new AccessManager(d);
    const seen: AccessObservation[] = [];
    m.on(e => seen.push(e));
    await expect(m.requestPublic('rapid', { lock: 'writeaccess' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(m.count('writeaccess')).toBe(0);
    expect(m.snapshot().locks[0]).toMatchObject({ lock: 'writeaccess', state: 'uncertain', count: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'uncertain', lock: 'writeaccess' });
    expect((seen[0] as { detail: string }).detail).toMatch(/did not answer/);
    // The next request is sent afresh, and a grant clears the doubt.
    (d as { request: AccessDriver['request'] }).request = async () => {};
    await m.requestPublic('rapid', { lock: 'writeaccess' });
    expect(m.snapshot().locks[0]).toMatchObject({ state: 'held', count: 1 });
  });

  it('a driver without the read: the error is passed on as before', async () => {
    const { d, wire } = driver({});
    const m = new AccessManager(d);
    await expect(m.requestPublic('rapid', { lock: 'writeaccess' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(wire).toEqual(['request writeaccess']);
    expect(m.snapshot().locks[0].state).toBe('idle');
  });

  it('a refusal that is not a network error is passed on without a read', async () => {
    const { d, wire } = driver({ heldByMe: async () => true });
    (d as { request: AccessDriver['request'] }).request = async () => { throw new RwsError('refused', 'GRANT_DENIED', 403); };
    const m = new AccessManager(d);
    await expect(m.requestPublic('rapid', { lock: 'writeaccess' })).rejects.toMatchObject({ code: 'GRANT_DENIED' });
    expect(wire).toEqual([]);
    expect(m.count('writeaccess')).toBe(0);
  });
});

describe('AccessManager.drain', () => {
  it('resolves at once with nothing in flight, waits for a turn in progress, and gives up at the bound', async () => {
    const { d } = driver({ requestFails: false });
    const m = new AccessManager(d);
    expect(await m.drain(100)).toBe(true);

    let finish!: () => void;
    const op = m.exclusive(() => new Promise<void>(r => { finish = r; }));
    const t0 = Date.now();
    expect(await m.drain(150)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    const drained = m.drain(2000);
    finish();
    await op;
    expect(await drained).toBe(true);
  });
});
