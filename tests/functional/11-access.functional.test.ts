/**
 * Functional: access, per controller - mastership on RobotWare 6 and 7,
 * control-station write access on RobotWare 8 - through the client's own API.
 *
 * - `RobotManager` counts holds: a nested request sends nothing, a write made
 *   inside the hold neither requests nor ends anything, and the lock stays held
 *   until the last release, which is the one release that goes on the wire.
 * - Domain names map onto the generation's locks: RobotWare 6 `cfg`, `motion`
 *   and `rapid`; RobotWare 7 `edit` (named by `rapid` and `cfg`) and `motion`;
 *   RobotWare 8 one control-station write access for every domain.
 * - RobotWare 8: the mastership service answers 410 Gone and the client routes
 *   every mastership call to write access; a session registers as the named
 *   control station once, before its first write-access request; the
 *   write-access status names the holder; a new session starts unregistered.
 * - A RAPID stop is sent first, with no access request in front of it.
 * - A second session sees the holder; its conflicting request is refused
 *   `MASTERSHIP_REQUIRED` with the holder named, and it gets in once the hold
 *   is released. Requests for another domain from the second session are
 *   granted on RobotWare 6 (independent domains), refused on RobotWare 8 (one
 *   lock), and recorded on RobotWare 7.
 * - Idle expiry (slow): a raw adapter left idle past the controller's session
 *   expiry logs in again on its next request, and on RobotWare 8 registers the
 *   control station again before its next write.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers. Writes: mastership and write-access requests and
 * releases, same-value speed-ratio writes, and on RobotWare 6 and 7 one RAPID
 * start of a ZZ_PROBE routine without motion (motors on first, as the guard
 * allows); the harness restores all of it. Nothing here requests RMMP, touches
 * the mastership watchdog, or takes access any way but the controller's own
 * request.
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import {
  RWS2Adapter, RwsError,
  type AccessEvent, type AccessLock, type AccessLockState, type ControlStationIdentity, type IRWSAdapter,
  type MastershipDomain, type RobotManager,
} from '../../src/index.js';
import {
  forEachController, expectRwsError, traceFile, waitUntil, zzExecModule, FUNCTIONAL_STATION,
  type FunctionalContext, type Lane, type TraceLine,
} from './helpers/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The RobotWare 8 control station of this file's second sessions: a fixed id,
 * never used by another test file, so every run registers as the same
 * station.
 */
const STATION_B: ControlStationIdentity = {
  name: 'abb-rws-client functional access B',
  id: '{7B3E91C4-2D58-4A6F-9E10-C8A4F25D6B37}',
  pincode: '1234',
};

/** The lock `requestMastership('rapid')` holds, per lane. */
const RAPID_LOCK: Readonly<Record<Lane, AccessLock>> = { rw6: 'rapid', rw7: 'edit', rw8: 'writeaccess' };

/** Every lock of the lane's generation, sorted. */
const LOCKS: Readonly<Record<Lane, AccessLock[]>> = {
  rw6: ['cfg', 'motion', 'rapid'],
  rw7: ['edit', 'motion'],
  rw8: ['writeaccess'],
};

/**
 * Idle time for the expiry test. The controllers remove a session after
 * about 5 minutes without a request: the shortest idle seen to expire was
 * 321 s on RW 6.16.03, and RW 7.21.4 and 8.2.1 expired sessions idle 307 s to
 * 334 s, one within 5 min 5 s (live-verified 2026-09-29).
 */
const IDLE_MS = 330_000;

/** Status values ABB documents for a mastership domain. */
const MASTERSHIP_VALUES = ['nomaster', 'remote', 'local', 'internal'];

// ─── Wire paths, as the trace records them ──────────────────────────────────

const STOP_RE = /\/rw\/rapid\/execution(?:\/stop(?:\?|$)|\?(?:.*&)?action=stop\b)/;
const REGISTER_RE = /\/rw\/controlstation\/register\/remote(?:\?|$)/;
const SPEED_RE = /\/rw\/panel\/speedratio(?:\?|$)/;
const ANY_ACCESS_RE = new RegExp([
  String.raw`\/rw\/mastership(?:\/(?:cfg|motion|rapid|edit))?(?:\/(?:request|release)(?:\?|$)|\?(?:.*&)?action=(?:request|release)\b)`,
  String.raw`\/rw\/controlstation\/(?:register\/remote|writeaccess\/(?:request|release))(?:\?|$)`,
].join('|'));
/** Any request to the mastership service except the RobotWare 7 watchdog reset the client sends by itself. */
const MASTERSHIP_SERVICE_RE = /\/rw\/mastership(?!\/watchdog)(?:[/?]|$)/;

/** The wire request (`action` request or release) for `lock` on `lane`. */
function lockWire(lane: Lane, lock: AccessLock, action: 'request' | 'release'): RegExp {
  if (lane === 'rw8') { return new RegExp(String.raw`\/rw\/controlstation\/writeaccess\/${action}(?:\?|$)`); }
  if (lane === 'rw7') { return new RegExp(String.raw`\/rw\/mastership\/${lock}\/${action}(?:\?|$)`); }
  return new RegExp(String.raw`\/rw\/mastership\/${lock}\?(?:.*&)?action=${action}\b`);
}

// ─── Trace helpers ───────────────────────────────────────────────────────────

let markerSeq = 0;

/** Write a marker line into the lane's trace and return it. */
function mark(ctx: FunctionalContext, label: string): string {
  const m = `11-access marker ${++markerSeq} ${label} ${Date.now()}`;
  ctx.note(m);
  return m;
}

/** The lane's trace lines after `from` (and before `until`, when given). */
function traceBetween(ctx: FunctionalContext, from: string, until?: string): TraceLine[] {
  const lines = fs.readFileSync(traceFile(ctx.lane), 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l) as TraceLine; } catch { return null; } })
    .filter((l): l is TraceLine => l !== null);
  const start = lines.findIndex(l => l.level === 'test' && l.msg === from);
  expect(start, `marker "${from}" in the ${ctx.lane} trace`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  if (!until) { return rest; }
  const end = rest.findIndex(l => l.level === 'test' && l.msg === until);
  return end >= 0 ? rest.slice(0, end) : rest;
}

/** Subscription traffic the manager may send by itself at any time; never an access request. */
const SUBSCRIPTION_RE = /^\/(?:subscription|poll)\b/;

/** Paths of the POST requests sent between two markers, in order (subscription traffic left out). */
function postsBetween(ctx: FunctionalContext, from: string, until?: string): string[] {
  return traceBetween(ctx, from, until)
    .filter(l => l.cat === 'http.req')
    .map(l => l.data as { method?: string; path?: string } | undefined)
    .filter(d => (d?.method ?? '').toUpperCase() === 'POST')
    .map(d => d?.path ?? '')
    .filter(p => !SUBSCRIPTION_RE.test(p));
}

const countOf = (paths: string[], re: RegExp): number => paths.filter(p => re.test(p)).length;

// ─── Access helpers ──────────────────────────────────────────────────────────

const lockOf = (m: RobotManager, lock: AccessLock): AccessLockState | undefined =>
  m.state.access.locks.find(l => l.lock === lock);

/**
 * Wait until `RobotState.access` counts `n` holds on `lock`. A first hold and
 * a last release update the state at once (an access event); a nested hold
 * shows at the manager's next poll.
 */
async function waitForCount(m: RobotManager, lock: AccessLock, n: number): Promise<void> {
  await waitUntil(() => (lockOf(m, lock)?.count ?? 0) === n, 20000, 250, `${lock} counted ${n} time(s) in RobotState.access`);
}

function asRws2(a: IRWSAdapter): RWS2Adapter {
  if (!(a instanceof RWS2Adapter)) { throw new Error('expected an RWS 2.0 adapter on this lane'); }
  return a;
}

/** RobotWare 8 write-access status, read through the harness's own session (never the holder's). */
async function writeAccessStatus(ctx: FunctionalContext): Promise<Awaited<ReturnType<RWS2Adapter['getWriteAccessStatus']>>> {
  return asRws2(await ctx.observer()).getWriteAccessStatus();
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The `-http-session-` value of a cookie string (compared, never logged). */
const sessionIdOf = (cookie: string | null): string => cookie?.match(/-http-session-=([^;]+)/)?.[1] ?? cookie ?? '';

/** Run `fn`; a controller refusal is returned rather than thrown. */
async function attempt(fn: () => Promise<unknown>): Promise<{ granted: true } | { granted: false; error: RwsError }> {
  try {
    await fn();
    return { granted: true };
  } catch (e) {
    if (e instanceof RwsError) { return { granted: false, error: e }; }
    throw e;
  }
}

const outcomeOf = (r: Awaited<ReturnType<typeof attempt>>): Record<string, unknown> => (r.granted
  ? { granted: true }
  : { granted: false, code: r.error.code, http: r.error.httpStatus, controllerCode: r.error.controllerCode, kind: r.error.refusal?.kind });

/** The RW6 virtual controller refuses a further session while a RobotManager is connected (see the harness). */
async function freeRw6Slots(ctx: FunctionalContext): Promise<void> {
  if (ctx.generation === 'rws1') { await ctx.connectedManager()?.disconnect(); }
}

/** RobotWare 8: makes sure station B holds no write access. */
async function clearStationB(ctx: FunctionalContext): Promise<void> {
  if (ctx.lane !== 'rw8') { return; }
  const s = await writeAccessStatus(ctx);
  if (!s.held || !sameId(s.heldById, STATION_B.id)) { return; }
  ctx.note('station B holds write access: releasing it');
  const b = asRws2(await ctx.newAdapter({ controlStation: STATION_B }));
  try {
    await b.registerControlStationRemote();
    await b.releaseWriteAccess();
  } finally {
    await ctx.release(b);
  }
}

/** Something that takes and releases a hold: a RobotManager or a raw adapter. */
type Holder = Pick<IRWSAdapter, 'requestMastership' | 'releaseMastership'>;

interface Pair {
  /** The session that holds. RWS 2.0: the lane's RobotManager. RW6: a raw adapter. */
  holder: Holder;
  /** The holder's own read of a domain's mastership status (RW6/RW7). */
  holderStatus(d: MastershipDomain): Promise<{ mastership: string; uid?: string; application?: string } | null>;
  /** The second session (RW8: registered as station B once it requests). */
  other: IRWSAdapter;
  close(): Promise<void>;
}

/**
 * Two sessions on the lane's controller. RWS 2.0: the RobotManager holds and a
 * raw adapter is the second session. RW6: the manager is logged out first
 * (its controller refuses a further session while it is connected) and two
 * raw adapters are used; the harness reconnects the manager later.
 */
async function openPair(ctx: FunctionalContext): Promise<Pair> {
  if (ctx.generation === 'rws1') {
    await freeRw6Slots(ctx);
    const a = await ctx.newAdapter();
    const b = await ctx.newAdapter();
    return {
      holder: a,
      holderStatus: d => a.getMastershipStatus!(d),
      other: b,
      close: async () => { await ctx.release(b); await ctx.release(a); },
    };
  }
  await clearStationB(ctx);
  const m = await ctx.ensureManager();
  const b = await ctx.newAdapter(ctx.lane === 'rw8' ? { controlStation: STATION_B } : {});
  return {
    holder: m,
    holderStatus: d => m.getMastershipStatus(d),
    other: b,
    close: async () => { await ctx.release(b); },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

await forEachController('11-access', ctx => {
  /** Once per lane: station B is checked again in afterAll. */
  let stationBUndo = false;
  const guardStationB = (): void => {
    if (ctx.lane !== 'rw8' || stationBUndo) { return; }
    stationBUndo = true;
    ctx.defer('station B holds no write access', () => clearStationB(ctx));
  };

  // ── Counted holds (RobotManager) ────────────────────────────────────────────

  it('RobotManager counts nested holds: one request and one release on the wire, held until the last release', async () => {
    const m = await ctx.ensureManager();
    const lock = RAPID_LOCK[ctx.lane];
    await waitForCount(m, lock, 0);
    const events: AccessEvent[] = [];
    const off = m.onAccessEvent(e => { events.push(e); });
    const start = mark(ctx, 'nested holds');
    try {
      await m.requestMastership('rapid');
      expect(lockOf(m, lock)).toMatchObject({ state: 'held', count: 1 });
      await m.requestMastership('rapid');
      await waitForCount(m, lock, 2);

      // A write that takes the same access itself runs inside the hold: it
      // requests nothing and ends nothing (same-value speed ratio).
      const speed = (await ctx.panel()).speedRatio;
      expect(speed).not.toBeNull();
      await m.setSpeedRatio(speed!);
      await waitForCount(m, lock, 2);

      await m.releaseMastership('rapid');
      await waitForCount(m, lock, 1);
      expect(lockOf(m, lock)!.state).toBe('held');

      // Still held on the controller after the first release.
      if (ctx.lane === 'rw8') {
        // A write does not clear RW8 write access (live-verified 2026-09-29 on
        // RW 8.2.1): the status still names this station after the write.
        const s = await writeAccessStatus(ctx);
        expect(s.held).toBe(true);
        expect(sameId(s.heldById, FUNCTIONAL_STATION.id)).toBe(true);
        expect(s.heldByName).toBe(FUNCTIONAL_STATION.name);
      } else {
        const s = await m.getMastershipStatus('rapid');
        expect(s).not.toBeNull();
        // The holder's own read: 'remote' on RW 6.16.03 (live-verified 2026-09-29).
        if (ctx.lane === 'rw6') { expect(s!.mastership).toBe('remote'); } else { expect(s!.mastership).not.toBe('nomaster'); }
        ctx.note('holder\'s own status read while held', s);
      }
      const firstRelease = mark(ctx, 'nested holds: first release done');
      expect(countOf(postsBetween(ctx, start, firstRelease), lockWire(ctx.lane, lock, 'release'))).toBe(0);

      await m.releaseMastership('rapid');
      expect(lockOf(m, lock)).toMatchObject({ state: 'idle', count: 0 });
    } finally {
      off();
    }
    const end = mark(ctx, 'nested holds done');

    const posts = postsBetween(ctx, start, end);
    ctx.note('nested holds: POSTs', posts);
    expect(countOf(posts, lockWire(ctx.lane, lock, 'request'))).toBe(1);
    expect(countOf(posts, lockWire(ctx.lane, lock, 'release'))).toBe(1);
    // The release is the last access request, after the speed-ratio write.
    const lastAccess = posts.map((p, i) => (ANY_ACCESS_RE.test(p) ? i : -1)).filter(i => i >= 0).pop()!;
    expect(posts[lastAccess]).toMatch(lockWire(ctx.lane, lock, 'release'));
    const speedAt = posts.findIndex(p => SPEED_RE.test(p));
    expect(speedAt).toBeGreaterThanOrEqual(0);
    expect(speedAt).toBeLessThan(lastAccess);

    // One acquired and one released event for the lock; nothing lost.
    const mine = events.filter(e => 'lock' in e && e.lock === lock);
    expect(mine.filter(e => e.type === 'acquired')).toHaveLength(1);
    expect(mine.filter(e => e.type === 'released')).toHaveLength(1);
    expect(events.filter(e => e.type === 'lost' || e.type === 'releaseFailed')).toEqual([]);

    if (ctx.lane === 'rw8') {
      expect((await writeAccessStatus(ctx)).held).toBe(false);
    } else {
      expect((await m.getMastershipStatus('rapid'))?.mastership).toBe('nomaster');
    }
  });

  it('mastership domain names map onto the locks of the generation', async () => {
    const m = await ctx.ensureManager();
    expect(m.state.access.generation).toBe(ctx.lane);
    expect(m.state.access.locks.map(l => l.lock).sort()).toEqual(LOCKS[ctx.lane]);
    if (ctx.lane !== 'rw8') {
      // RW 7.21.4 lists [edit, motion], RW 6.16.03 [cfg, motion, rapid]
      // (live-verified 2026-09-29).
      expect((await m.listMastershipDomains()).map(d => d.toLowerCase()).sort()).toEqual(LOCKS[ctx.lane]);
    }

    const start = mark(ctx, 'domains');
    const taken: MastershipDomain[] = [];
    try {
      for (const d of ['rapid', 'cfg', 'motion'] as const) { await m.requestMastership(d); taken.push(d); }
      const held = mark(ctx, 'domains: all requested');
      const requests = postsBetween(ctx, start, held);
      ctx.note('domains: request POSTs', requests);
      if (ctx.lane === 'rw6') {
        // Three independent domains: one request each.
        for (const l of ['rapid', 'cfg', 'motion'] as const) {
          await waitForCount(m, l, 1);
          expect(countOf(requests, lockWire('rw6', l, 'request'))).toBe(1);
        }
      } else if (ctx.lane === 'rw7') {
        // rapid and cfg both name edit: one edit request, counted twice; motion is its own lock.
        await waitForCount(m, 'edit', 2);
        await waitForCount(m, 'motion', 1);
        expect(countOf(requests, lockWire('rw7', 'edit', 'request'))).toBe(1);
        expect(countOf(requests, lockWire('rw7', 'motion', 'request'))).toBe(1);
        for (const d of ['rapid', 'motion'] as const) {
          const s = await m.getMastershipStatus(d);
          ctx.note(`holder's own status of ${d === 'rapid' ? 'edit' : d} while held`, s);
          expect(s?.mastership).not.toBe('nomaster');
        }
      } else {
        // One write access for every domain: one request, counted three times.
        await waitForCount(m, 'writeaccess', 3);
        expect(countOf(requests, lockWire('rw8', 'writeaccess', 'request'))).toBe(1);
      }
      expect(requests.filter(p => ANY_ACCESS_RE.test(p) && !REGISTER_RE.test(p))).toHaveLength(LOCKS[ctx.lane].length);
    } finally {
      for (const d of taken.reverse()) { await m.releaseMastership(d); }
    }
    const end = mark(ctx, 'domains done');
    const posts = postsBetween(ctx, start, end);
    for (const l of LOCKS[ctx.lane]) {
      expect(countOf(posts, lockWire(ctx.lane, l, 'release'))).toBe(1);
      expect(lockOf(m, l)).toMatchObject({ state: 'idle', count: 0 });
    }
    if (ctx.lane !== 'rw8') {
      for (const d of ['rapid', 'motion'] as const) { expect((await m.getMastershipStatus(d))?.mastership).toBe('nomaster'); }
    }
  });

  // ── RobotWare 8: no mastership service; control-station write access ──────

  if (ctx.lane === 'rw8') {
    it('RW8: the mastership service answers 410 Gone, and mastership calls go to control-station write access', async () => {
      const m = await ctx.ensureManager();
      // GET /rw/mastership answers 410 -1073445881 on RW 8.2.1 (live-verified 2026-09-29).
      const err = await expectRwsError(() => m.listMastershipDomains());
      expect(err.code).toBe('UNSUPPORTED_OPERATION');
      expect(err.httpStatus).toBe(410);
      ctx.note('410 on the mastership service', { controllerCode: err.controllerCode, controllerMsg: err.controllerMsg });
      if (err.controllerCode !== undefined) { expect(err.controllerCode).toBe(-1073445881); }
      expect(err.refusal?.kind).toBe('unsupported');
      expect(err.message).toMatch(/mastership/i);
      // The manager's status read turns the refusal into "no status".
      expect(await m.getMastershipStatus('rapid')).toBeNull();

      const start = mark(ctx, '410 routing');
      await m.requestMastership('motion');
      try {
        expect(lockOf(m, 'writeaccess')).toMatchObject({ state: 'held', count: 1 });
        expect(m.state.access.locks.map(l => l.lock)).toEqual(['writeaccess']);
        expect((await writeAccessStatus(ctx)).heldByName).toBe(FUNCTIONAL_STATION.name);
      } finally {
        await m.releaseMastership('motion');
      }
      const end = mark(ctx, '410 routing done');
      const posts = postsBetween(ctx, start, end);
      ctx.note('410 routing: POSTs', posts);
      // The version read at connect routes the request: nothing is sent to the mastership service.
      expect(posts.filter(p => MASTERSHIP_SERVICE_RE.test(p))).toEqual([]);
      expect(countOf(posts, lockWire('rw8', 'writeaccess', 'request'))).toBe(1);
      expect(countOf(posts, lockWire('rw8', 'writeaccess', 'release'))).toBe(1);
      expect((await writeAccessStatus(ctx)).held).toBe(false);
    });

    it('RW8: the first write-access request of a session registers it as the named station; the status names it; it registers once per session', async () => {
      // A fresh session, so the registration is seen from its start.
      const m = await ctx.reconnect();
      expect(m.state.access.rw8).toMatchObject({ registered: false, stationName: FUNCTIONAL_STATION.name, identity: null });
      const obs = asRws2(await ctx.observer());
      expect((await obs.getWriteAccessStatus()).held).toBe(false);
      // A session that never registered reads type none (live-verified 2026-09-29 on RW 8.2.1).
      expect(await obs.getControlStationType()).toBe('none');

      const start = mark(ctx, 'registration');
      await m.requestMastership('rapid');
      try {
        // Registered with the manager's controlStation option.
        expect(m.state.access.rw8).toMatchObject({ registered: true, stationName: FUNCTIONAL_STATION.name, identity: 'option' });
        expect(lockOf(m, 'writeaccess')).toMatchObject({ state: 'held', count: 1 });
        // Read from another session: exactly this station holds, and that
        // session is not the holder (live-verified 2026-09-29 on RW 8.2.1).
        const s = await obs.getWriteAccessStatus();
        expect(s.held).toBe(true);
        expect(s.heldByMe).toBe(false);
        expect(sameId(s.heldById, FUNCTIONAL_STATION.id)).toBe(true);
        expect(s.heldByName).toBe(FUNCTIONAL_STATION.name);
        // Remote Access is allowed at the pendant, or no station could take write access.
        expect(s.externalControlEnabled).toBe(true);
        // The registration belongs to the manager's session, not the observer's.
        expect(await obs.getControlStationType()).toBe('none');
      } finally {
        await m.releaseMastership('rapid');
      }
      const firstDone = mark(ctx, 'registration: first hold released');
      const first = postsBetween(ctx, start, firstDone);
      ctx.note('registration: POSTs of the first hold', first);
      expect(countOf(first, REGISTER_RE)).toBe(1);
      const reg = first.findIndex(p => REGISTER_RE.test(p));
      const req = first.findIndex(p => lockWire('rw8', 'writeaccess', 'request').test(p));
      expect(reg).toBeGreaterThanOrEqual(0);
      expect(req).toBeGreaterThan(reg);
      expect((await obs.getWriteAccessStatus()).held).toBe(false);
      // The registration outlives the hold: it ends only with the session.
      expect(m.state.access.rw8!.registered).toBe(true);

      // A second hold in the same session requests again without registering again.
      await m.requestMastership('rapid');
      await m.releaseMastership('rapid');
      const end = mark(ctx, 'registration done');
      const second = postsBetween(ctx, firstDone, end);
      expect(countOf(second, REGISTER_RE)).toBe(0);
      expect(countOf(second, lockWire('rw8', 'writeaccess', 'request'))).toBe(1);
      expect(countOf(second, lockWire('rw8', 'writeaccess', 'release'))).toBe(1);
    });

    it('RW8: a new session is unregistered until its next write-access request registers it again', async () => {
      const m = await ctx.ensureManager();
      await m.requestMastership('rapid');
      await m.releaseMastership('rapid');
      expect(m.state.access.rw8!.registered).toBe(true);

      // Registration binds the HTTP session: a new login is unregistered
      // (live-verified 2026-09-29 on RW 8.2.1).
      const again = await ctx.reconnect();
      expect(again.state.access.rw8).toMatchObject({ registered: false, stationName: FUNCTIONAL_STATION.name, identity: null });
      const start = mark(ctx, 're-registration');
      await again.requestMastership('rapid');
      try {
        expect(again.state.access.rw8!.registered).toBe(true);
        expect((await writeAccessStatus(ctx)).heldByName).toBe(FUNCTIONAL_STATION.name);
      } finally {
        await again.releaseMastership('rapid');
      }
      const end = mark(ctx, 're-registration done');
      const posts = postsBetween(ctx, start, end);
      expect(countOf(posts, REGISTER_RE)).toBe(1);
      expect(posts.findIndex(p => lockWire('rw8', 'writeaccess', 'request').test(p)))
        .toBeGreaterThan(posts.findIndex(p => REGISTER_RE.test(p)));
    });
  }

  // ── The stop path ──────────────────────────────────────────────────────────

  it('a RAPID stop is sent first, with no access request in front of it', async t => {
    // RW8: prepareMotion makes the motion-control declaration the start needs,
    // only under RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<its system name> (skipped without it).
    await ctx.prepareMotion(t, { kind: 'rapid-start' });
    const m = await ctx.ensureManager();
    const mod = zzExecModule({ name: 'ZZ_PROBE_ACCESS', loops: 600, waitSec: 0.1 });
    await ctx.loadModule(mod);
    await m.setPPToRoutine(ctx.task, mod.name, mod.routines.entry);
    await m.startRapid();
    await waitUntil(async () => (await ctx.panel()).execstate === 'running', 15000, 250, 'RAPID running');
    // Nothing is held by this session when the stop is sent.
    await waitUntil(() => m.state.access.locks.every(l => l.count === 0), 20000, 250, 'no hold counted');

    const start = mark(ctx, 'stop without a hold');
    await m.stopRapid();
    const end = mark(ctx, 'stop without a hold done');
    await waitUntil(async () => (await ctx.panel()).execstate === 'stopped', 15000, 250, 'RAPID stopped');

    const posts = postsBetween(ctx, start, end);
    // Whether the controller took the stop without any hold, or refused it as
    // not held and the manager retried once under access, is recorded here.
    const retried = posts.some(p => ANY_ACCESS_RE.test(p));
    ctx.note('stop without a hold', { posts, retried });
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0]).toMatch(STOP_RE);
    expect(m.state.access.locks.every(l => l.count === 0)).toBe(true);

    // Stopped, unloaded, program pointer, motors and speed ratio back now,
    // so the tests after this one start from the baseline.
    const report = await ctx.restore();
    ctx.note('restore after the stop test', { actions: report.actions, residual: report.residual });
  });

  // ── Two sessions ───────────────────────────────────────────────────────────

  it('a second session sees the holder; its conflicting request is refused MASTERSHIP_REQUIRED naming the holder; after the release it gets in', async () => {
    guardStationB();
    const pair = await openPair(ctx);
    const { holder, other } = pair;
    try {
      await holder.requestMastership('rapid');
      try {
        // ── The second session sees the holder ──
        if (ctx.lane === 'rw8') {
          const s = await asRws2(other).getWriteAccessStatus();
          expect(s.held).toBe(true);
          expect(s.heldByMe).toBe(false);
          expect(s.heldByName).toBe(FUNCTIONAL_STATION.name);
          expect(sameId(s.heldById, FUNCTIONAL_STATION.id)).toBe(true);
        } else {
          expect(other.getMastershipStatus).toBeDefined();
          const seen = await other.getMastershipStatus!('rapid');
          const own = await pair.holderStatus('rapid');
          ctx.note('status of the RAPID domain: holder\'s own read and the second session\'s', { own, seen });
          expect(MASTERSHIP_VALUES).toContain(seen.mastership);
          expect(seen.mastership).not.toBe('nomaster');
          if (ctx.lane === 'rw6') {
            // RW 6.16.03: a remote holder reads 'remote' with its uid from
            // another session (live-verified 2026-09-29).
            expect(seen.mastership).toBe('remote');
            expect(seen.uid ?? '').not.toBe('');
            if (own?.uid) { expect(seen.uid).toBe(own.uid); }
          }
        }

        // ── Its conflicting request is refused, typed, with the holder named ──
        const before = mark(ctx, 'conflicting request');
        const err = await expectRwsError(() => other.requestMastership('rapid'));
        ctx.note('conflicting request refused', {
          code: err.code, http: err.httpStatus, controllerCode: err.controllerCode, refusal: err.refusal,
        });
        expect(err.code).toBe('MASTERSHIP_REQUIRED');
        expect(err.httpStatus).toBe(403);
        // RW 6.16.03 and RW 7.21: -1073445862 "held by someone else"; RW 8.2.1:
        // -1073435870 "cannot take SPoC when it is taken" (live-verified 2026-09-29).
        expect(err.controllerCode).toBe(ctx.lane === 'rw8' ? -1073435870 : -1073445862);
        const r = err.refusal;
        expect(r).toBeDefined();
        expect(r!.kind).toBe('held-by-other');
        expect(r!.condition).toBe(ctx.lane === 'rw8' ? 'write-access' : 'mastership');
        expect(r!.grantor).toBe('current-holder');
        if (ctx.lane === 'rw8') {
          expect(r!.holder?.name).toBe(FUNCTIONAL_STATION.name);
          expect(err.message).toContain(`'${FUNCTIONAL_STATION.name}'`);
          // A station is named, never identified by its id.
          expect(err.message.toLowerCase()).not.toContain(FUNCTIONAL_STATION.id.toLowerCase());
          expect(JSON.stringify(r).toLowerCase()).not.toContain(FUNCTIONAL_STATION.id.toLowerCase());
        } else if (ctx.lane === 'rw6') {
          expect(r!.holder?.kind).toBe('remote');
          expect(err.message).toMatch(/another remote client holds mastership/i);
        } else {
          ctx.note('RW7 holder named in the refusal', r!.holder ?? null);
        }
        const after = mark(ctx, 'conflicting request done');
        // One request from the second session, nothing released by it.
        const posts = postsBetween(ctx, before, after);
        expect(posts.filter(p => ANY_ACCESS_RE.test(p) && !REGISTER_RE.test(p))).toHaveLength(1);

        // The holder still holds.
        if (ctx.lane === 'rw8') {
          expect(sameId((await writeAccessStatus(ctx)).heldById, FUNCTIONAL_STATION.id)).toBe(true);
          expect(lockOf(ctx.manager, 'writeaccess')).toMatchObject({ state: 'held', count: 1 });
        } else {
          expect((await other.getMastershipStatus!('rapid')).mastership).not.toBe('nomaster');
        }
      } finally {
        await holder.releaseMastership('rapid');
      }

      // ── After the release the second session gets in ──
      if (ctx.lane === 'rw8') { expect((await writeAccessStatus(ctx)).held).toBe(false); }
      await other.requestMastership('rapid');
      try {
        if (ctx.lane === 'rw8') {
          const s = await asRws2(other).getWriteAccessStatus();
          expect(s.held).toBe(true);
          expect(s.heldByMe).toBe(true);
          expect(s.heldByName).toBe(STATION_B.name);
        } else {
          expect((await pair.holderStatus('rapid'))?.mastership).not.toBe('nomaster');
        }
      } finally {
        await other.releaseMastership('rapid');
      }
      if (ctx.lane === 'rw8') {
        expect((await writeAccessStatus(ctx)).held).toBe(false);
      } else {
        expect((await other.getMastershipStatus!('rapid')).mastership).toBe('nomaster');
      }
    } finally {
      await pair.close();
    }
  });

  it('records whether a second session can take another domain while one is held (RW6: granted, independent domains; RW8: refused, one write access)', async () => {
    guardStationB();
    const pair = await openPair(ctx);
    const { holder, other } = pair;
    const outcomes: Record<string, unknown> = {};
    /** Hold `held` in the first session and try `wanted` from the second. */
    const cross = async (held: MastershipDomain, wanted: MastershipDomain): Promise<Awaited<ReturnType<typeof attempt>>> => {
      await holder.requestMastership(held);
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        result = await attempt(() => other.requestMastership(wanted));
        if (result.granted) { await other.releaseMastership(wanted); }
      } finally {
        await holder.releaseMastership(held);
      }
      outcomes[`${held} held, ${wanted} requested`] = outcomeOf(result);
      // A refusal of another domain is a held-by-other refusal, never anything else.
      if (!result.granted) {
        expect(result.error.code).toBe('MASTERSHIP_REQUIRED');
        expect(result.error.refusal?.kind).toBe('held-by-other');
      }
      return result;
    };
    try {
      if (ctx.lane === 'rw6') {
        // RW 6.16.03: while one session held rapid, another session's cfg
        // request answered 204 (live-verified 2026-09-29).
        expect((await cross('rapid', 'cfg')).granted).toBe(true);
        // Not established: a cfg hold against a rapid request, and a rapid hold against motion.
        await cross('cfg', 'rapid');
        await cross('rapid', 'motion');
      } else if (ctx.lane === 'rw7') {
        // Not established on RW7: whether one client's edit hold blocks
        // another client's motion request, and the other way round.
        await cross('rapid', 'motion');
        await cross('motion', 'rapid');
      } else {
        // Every domain is the one write access.
        const r = await cross('rapid', 'motion');
        expect(r.granted).toBe(false);
        if (!r.granted) { expect(r.error.controllerCode).toBe(-1073435870); }
      }
      ctx.note('cross-domain requests from a second session', outcomes);
    } finally {
      await pair.close();
    }
    // Nothing is left held by either session.
    if (ctx.lane === 'rw8') { expect((await writeAccessStatus(ctx)).held).toBe(false); }
  });

  // ── Idle expiry (slow) ─────────────────────────────────────────────────────

  it('(slow, idles 330 s) a raw adapter left idle past the session expiry logs in again on its next request; RW8 registers the station again before its next write', async t => {
    if (process.env.RWS_FUNCTIONAL_SKIP_SLOW === '1') {
      ctx.skip(t, 'RWS_FUNCTIONAL_SKIP_SLOW=1 skips the idle-expiry test (330 s per controller)');
    }
    guardStationB();
    await clearStationB(ctx);
    await freeRw6Slots(ctx);
    const a = await ctx.newAdapter(ctx.lane === 'rw8' ? { controlStation: STATION_B } : {});
    try {
      if (ctx.lane === 'rw8') {
        // A registration to lose: this session registers as station B, holds
        // write access once and releases it.
        await a.requestMastership('rapid');
        await a.releaseMastership('rapid');
        expect(await asRws2(a).getControlStationType()).toBe('remote');
      }
      const speed = await a.getSpeedRatio();
      const before = sessionIdOf(a.getSessionCookie());
      expect(before).not.toBe('');

      mark(ctx, 'idle start');
      // The premise of the test, not a wait for a state: no request on this
      // session for longer than the controller keeps an idle session.
      await new Promise(r => setTimeout(r, IDLE_MS));
      const woke = mark(ctx, 'idle over');

      // The next request succeeds, on a new session.
      const info = await a.getSystemInfo();
      expect(info.rwVersion).toBe(ctx.rwVersion);
      const readDone = mark(ctx, 'first read after the idle done');
      const reissued = sessionIdOf(a.getSessionCookie()) !== before;
      const readLines = traceBetween(ctx, woke, readDone);
      const saw401 = readLines.some(l => /\b401\b/.test(l.msg));
      ctx.note('idle expiry: first read', {
        idleMs: IDLE_MS, reissued, saw401,
        wire: readLines.filter(l => l.cat?.startsWith('http.')).map(l => l.msg),
      });
      expect(reissued, `the session was not re-issued after ${IDLE_MS / 1000} s idle`).toBe(true);

      // A write on the new session (same-value speed ratio): it takes the
      // access it needs through the client's normal path.
      const writeStart = mark(ctx, 'write after the idle');
      await a.setSpeedRatio(speed);
      const writeEnd = mark(ctx, 'write after the idle done');
      const posts = postsBetween(ctx, writeStart, writeEnd);
      ctx.note('idle expiry: POSTs of the write', posts);
      const speedAt = posts.findIndex(p => SPEED_RE.test(p));
      expect(speedAt).toBeGreaterThanOrEqual(0);
      if (ctx.lane === 'rw8') {
        // RW 8.2.1: after an idle expiry the new session is unregistered
        // (writeaccess/request answers 403 -1073435871) until it registers
        // again (live-verified 2026-09-29). The client must register before
        // requesting write access, and write only after both.
        const reg = posts.findIndex(p => REGISTER_RE.test(p));
        const req = posts.findIndex(p => lockWire('rw8', 'writeaccess', 'request').test(p));
        expect(reg, 'register/remote sent after the idle expiry').toBeGreaterThanOrEqual(0);
        expect(req).toBeGreaterThan(reg);
        expect(speedAt).toBeGreaterThan(req);
        const refusedRequest = traceBetween(ctx, writeStart, writeEnd)
          .some(l => l.cat === 'http.err' && lockWire('rw8', 'writeaccess', 'request').test((l.data as { path?: string } | undefined)?.path ?? ''));
        expect(refusedRequest).toBe(false);
        expect(await asRws2(a).getControlStationType()).toBe('remote');
        expect((await writeAccessStatus(ctx)).held).toBe(false);
      }
    } finally {
      await ctx.release(a);
    }
  }, IDLE_MS + 150_000);
});
