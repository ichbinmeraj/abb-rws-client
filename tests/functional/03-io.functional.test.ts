/**
 * Functional I/O, per controller, through the client's own API: the signal
 * table (every page), single reads by full path and by bare name, networks
 * and devices, device search, and the controller-side signal search - its
 * case-insensitive prefix match on names, whole-value device / network /
 * category, the empty search, the AND of two criteria sets and `invert` on
 * each set. Then the writes: a general-purpose digital input is simulated
 * (RWS 2.0), written, read back and seen on the subscription stream, and put
 * back; a general-purpose digital output is written, read back, seen and put
 * back; and a signal write the controller is known to refuse is sent once, at
 * the value the signal already has, to assert the typed refusal.
 *
 * Expected behaviour per build, as observed on the virtual controllers:
 *   - `name` is a case-insensitive prefix match, not a substring match;
 *     `*` matches nothing; `device`, `network` and `category` match whole
 *     values, ignoring case; the criteria AND; an empty search returns
 *     every signal; a second criteria set narrows the first; `invert` /
 *     `invert2` negate their own set, and `invert` alone matches nothing.
 *     Live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1 (network case
 *     on 7.21.4 and 8.2.1 only; RW 6 is recorded here).
 *   - Signal names are flat; on RWS 2.0 the six CyclicBrakeCheck signals of
 *     each of four safety-controller cabinets (SC1-4CBC*) have no device, and
 *     every other signal sits on one. A bare-name read equals the full-path
 *     read. Live-verified 2026-09-29 on the same three builds, and on
 *     2026-10-03 on RW 7.21.0+229. The device-less set depends on the robot
 *     model too: the collaborative CRB 1910 on RW 8.1.1+614 (2026-10-03) adds
 *     CollaborativeOperationIsActive (141 signals, 25 of them device-less), so
 *     that signal is allowed on CRB models only.
 *   - Category on these virtual controllers: every RW 6.16.03 signal is
 *     `safety`, every RW 7.21.4 signal `internal`, and on RW 8.2.1 the
 *     IntegratedIO signals carry none (live, 2026-09-29). So only the RW 8
 *     controller ships a general-purpose input (IIO_di1-16) and output.
 *   - The I/O fixture: `npm run functional:fixtures` adds ZZ_PROBE_DI1 (DI)
 *     and ZZ_PROBE_DO1 (DO), access level All, no category, to the RW6 and
 *     RW7 controllers - on RW7 on the virtual device ZZ_PROBE_DEV (network
 *     Virtual), on RW6 with no device. The write tests use them there (RW8
 *     keeps IIO_di*) and skip, naming the command, where they are missing;
 *     the read tests allow for them. The suite never adds or removes them.
 *   - Other ZZ_PROBE signals some VCs carry, added by hand in RobotStudio
 *     (ZZ_PROBE_DO2 and ZZ_PROBE_DO3: no device, no category), are not
 *     built in either: the read tests leave them out of the device and
 *     category checks and only note where they sit.
 *   - A signal write refused by the controller's safety access restriction
 *     answers 403 -1073445881, which the client reports as GRANT_DENIED with
 *     an `access-restricted` refusal: seen on RW 6.16 for the drive-unit
 *     output DRV1TESTE2 in Auto (2026-08-02, again 2026-09-27) and on RW 7.21
 *     for SafetyEnable (2026-08-02). On RW 8.1.1 the same IIO_do8 write was
 *     both accepted (unregistered session) and refused (registered station
 *     holding write access) on 2026-09-27, so on RW 8 the answer is recorded,
 *     not predicted.
 *
 * Every write restores what it changed (ctx.defer): the written value, the
 * simulation state and the added subscription resource. A refused-write
 * probe writes the value the signal already has, so an unexpected
 * acceptance changes nothing. RWS 1.0 has no signal-simulate call in this
 * client, so on RW6 the fixture input (a signal with no device) is written
 * directly.
 *
 * Sessions of the write tests (withIoPath): on RWS 2.0 everything goes
 * through the manager, and events through its own subscription group. On
 * RWS 1.0 the manager's session carries no signal subscription and has no
 * group to add one to, so each write test logs the manager out, works in one
 * session of its own (reads, writes, one signal subscription), logs that out
 * and brings the manager back - never a second subscription group on the
 * manager's RW6 session. Not yet run live on RW 6.16.03: a signal
 * subscription over RWS 1.0 (its event value, and how the VC takes it), and
 * a write of a device-less signal there.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import {
  RWS2Adapter, RwsError,
  type IoDevice, type IRWSAdapter, type Signal, type SignalSearchExCriteria, type SubscriptionEvent,
} from '../../src/index.js';
import {
  forEachController, expectRwsError, waitFor, waitUntil, IO_FIXTURE, ioFixtureHint, isIoFixtureSignal, isExtraProbeSignal,
  isProbeName, traceFile, type Lane, type TraceLine,
} from './helpers/index.js';

// ─── Pure helpers ────────────────────────────────────────────────────────────

const namesOf = (list: Signal[]): string[] => list.map(s => s.name).sort();
const sameNames = (a: Signal[], b: Signal[]): void => { expect(namesOf(a)).toEqual(namesOf(b)); };
const lc = (s: string): string => s.toLowerCase();
const startsWithCi = (name: string, prefix: string): boolean => lc(name).startsWith(lc(prefix));

/** The six CyclicBrakeCheck status signals of safety-controller cabinets 1-4, which have no device on RWS 2.0. */
const DEVICELESS_CBC = /^SC[1-4]CBC(ACT|WAR|ERR|OK|REQ|PREWARN)$/;
/**
 * Further device-less built-in signals of a collaborative robot (a CRB model):
 * CollaborativeOperationIsActive, on the CRB 1910 under RW 8.1.1+614
 * (2026-10-03). The IRB 1600 systems on RW 7.21.0, 7.21.4 and 8.2.1 have none.
 */
const DEVICELESS_COLLABORATIVE = ['CollaborativeOperationIsActive'];
/** A collaborative robot model, by the controller's robot type ('CRB 1910-10/1.52'). */
const isCollaborativeModel = (robotType: string): boolean => /^CRB\b/i.test(robotType.trim());

/**
 * A name prefix that separates the table well: it starts at least two names
 * and misses at least two, contains a letter (so its case can be flipped),
 * and - when one exists - also occurs inside some other name, so a substring
 * match would give a different answer than a prefix match.
 */
function choosePrefix(names: string[]): string {
  const lower = names.map(lc);
  let best: { p: string; score: number } | null = null;
  for (const n of [...names].sort()) {
    for (let len = 1; len <= 4 && len < n.length; len++) {
      const p = n.slice(0, len);
      if (!/[a-z]/i.test(p) || !/^[A-Za-z0-9_]+$/.test(p)) { continue; }
      const pl = lc(p);
      const starts = lower.filter(x => x.startsWith(pl)).length;
      if (starts < 2 || starts > names.length - 2) { continue; }
      const inside = lower.filter(x => !x.startsWith(pl) && x.includes(pl)).length;
      const score = (inside > 0 ? 1000 : 0) + Math.min(starts, names.length - starts);
      if (!best || score > best.score) { best = { p, score }; }
    }
  }
  return best?.p ?? names[0].slice(0, 1);
}

/** Three characters from inside a name that start no name at all (a substring that is not a prefix). */
function chooseInnerFragment(names: string[]): string | null {
  const lower = names.map(lc);
  for (const n of [...names].sort()) {
    for (let i = 1; i + 3 <= n.length; i++) {
      const f = n.slice(i, i + 3);
      if (!/^[A-Za-z0-9_]+$/.test(f)) { continue; }
      if (!lower.some(x => x.startsWith(lc(f)))) { return f; }
    }
  }
  return null;
}

/**
 * The `lstate` of `name` in the body of a subscription-group PUT: one
 * `ios-signalstate-ev` entry per bound signal, with spans lvalue, lstate,
 * quality and time (live-verified 2026-09-29 on RW 7.21.4 and 8.2.1). Null
 * when the body does not carry it (an empty 200 for a signal already in the
 * group).
 */
function lstateIn(body: string, name: string): string | null {
  for (const m of body.matchAll(/<li[^>]*class="[^"]*ios-signalstate-ev[^"]*"[^>]*>([\s\S]*?)<\/li>/g)) {
    if (!m[0].includes(name)) { continue; }
    const s = /<span[^>]*class="lstate"[^>]*>([^<]*)<\/span>/.exec(m[1]);
    if (s) { return s[1].trim(); }
  }
  const j = /"lstate"\s*:\s*"([^"]*)"/.exec(body);
  return j ? j[1] : null;
}

/** Is `ev` an event of signal `name` (`/rw/iosystem/signals/[network/device/]name;state`)? */
function isSignalEvent(ev: SubscriptionEvent, name: string): boolean {
  const last = ev.resource.split(';')[0].split('/').pop() ?? '';
  return lc(last) === lc(name);
}

const errText = (e: unknown): string =>
  (e instanceof RwsError ? `${e.code} ${e.httpStatus ?? ''} ${e.controllerCode ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e));

interface Location { network: string; device: string }

/** The subscription events of one signal, and how to stop collecting them. */
interface SignalWatch {
  events: SubscriptionEvent[];
  /** The body of the manager-group PUT that added the signal (null on the other path). */
  putBody: string | null;
  path: 'manager group' | 'own subscription';
  /** The manager's group the signal was added to, if that path was taken. */
  group: string | undefined;
  /** Stop collecting (idempotent). */
  stop: () => Promise<void>;
}

/** The session a signal-write test reads, writes and watches through (see withIoPath). */
interface IoPath {
  via: 'manager' | 'own session';
  read(loc: Location, name: string): Promise<Signal>;
  /** Write by bare name; on RW8 a missing-write-access answer is retried holding it. */
  write(name: string, value: string): Promise<'session' | 'write-access'>;
  watch(name: string): Promise<SignalWatch>;
  /** An undo step run when the test body ends, before its session closes. */
  onClose(label: string, fn: () => Promise<void>): void;
}

// ─── Trace reading ───────────────────────────────────────────────────────────

const FILE = '03-io';

/** Byte length of the lane's trace now: lines after it are what follows. */
function traceMark(lane: Lane): number {
  try { return fs.statSync(traceFile(lane)).size; } catch { return 0; }
}

/** The paths of this file's signal-list GETs (`/rw/iosystem/signals?...`) traced on the lane after `mark`. */
function signalListGetsSince(lane: Lane, mark: number): string[] {
  let raw = '';
  try { raw = fs.readFileSync(traceFile(lane)).subarray(mark).toString('utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as TraceLine; } catch { return null; } })
    .filter((l): l is TraceLine => l !== null && l.file === FILE && l.cat === 'http.req')
    .map(l => (l.data ?? {}) as { method?: string; path?: string })
    .filter(d => d.method === 'GET' && /^\/rw\/iosystem\/signals\?/.test(d.path ?? ''))
    .map(d => d.path as string);
}

// ─── Per controller ──────────────────────────────────────────────────────────

await forEachController(FILE, ctx => {
  // Per-lane caches, filled by the first test that needs them.
  let tableCache: Signal[] | null = null;
  let devicesCache: IoDevice[] | null = null;
  let locCache: { at: Map<string, Location>; unlocated: string[]; twice: string[] } | null = null;

  /** Every signal, through the manager's signal-table load. */
  const table = async (): Promise<Signal[]> => {
    if (tableCache) { return tableCache; }
    await ctx.manager.refreshIoSignals();
    tableCache = [...ctx.manager.state.ioSignals];
    return tableCache;
  };

  const devices = async (): Promise<IoDevice[]> => {
    if (devicesCache) { return devicesCache; }
    devicesCache = await ctx.manager.listAllIoDevices();
    return devicesCache;
  };

  /**
   * Where each signal lives, from a device-scoped search per listed device
   * (`Signal` carries no network or device). Signals no device search finds
   * are `unlocated`; a signal found under two devices is listed in `twice`.
   */
  const locations = async (): Promise<{ at: Map<string, Location>; unlocated: string[]; twice: string[] }> => {
    if (locCache) { return locCache; }
    const at = new Map<string, Location>();
    const twice: string[] = [];
    for (const d of await devices()) {
      for (const s of await ctx.manager.searchSignals({ network: d.network, device: d.name })) {
        if (at.has(s.name)) { twice.push(s.name); continue; }
        at.set(s.name, { network: d.network, device: d.name });
      }
    }
    const unlocated = namesOf(await table()).filter(n => !at.has(n));
    locCache = { at, unlocated, twice };
    return locCache;
  };

  /**
   * Names bound to a system input in the controller configuration
   * (SYSSIG_IN: domain SYS from RobotWare 7.7, EIO before; both are read),
   * which the suite never writes. Null when an instance could not be read,
   * so the caller does not write at all.
   */
  const systemInputNames = async (): Promise<Set<string> | null> => {
    const out = new Set<string>();
    for (const domain of ['SYS', 'EIO']) {
      const instances = await ctx.manager.listCfgInstances(domain, 'SYSSIG_IN').catch(() => [] as string[]);
      for (const i of instances) {
        try {
          const attrs: Record<string, unknown> = await ctx.manager.getCfgInstance(domain, 'SYSSIG_IN', i);
          for (const v of Object.values(attrs)) { if (typeof v === 'string' && v) { out.add(lc(v)); } }
        } catch (e) {
          ctx.note(`SYSSIG_IN instance ${domain}/${i} could not be read`, { error: errText(e) });
          return null;
        }
      }
    }
    return out;
  };

  /** The manager's own RWS 2.0 session (the registered RW8 control station). */
  const managerRws2 = (): RWS2Adapter | null => {
    const a = (ctx.manager as unknown as { adapter: unknown }).adapter;
    return a instanceof RWS2Adapter ? a : null;
  };

  /** An RW8 refusal that names missing control-station write access. */
  const needsWriteAccess = (e: unknown): boolean =>
    ctx.lane === 'rw8' && e instanceof RwsError && e.code === 'MASTERSHIP_REQUIRED';

  /** Run `fn` holding control-station write access, taken and released the normal way. */
  const underWriteAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
    await ctx.manager.requestMastership('rapid');
    try { return await fn(); } finally {
      await ctx.manager.releaseMastership('rapid').catch(e => ctx.note('write access release failed', { error: errText(e) }));
    }
  };

  /**
   * Simulate or unsimulate a signal. ABB lists no prerequisite for the
   * signal `set-lstate` on RobotWare 7 or 8, so it is sent from the
   * harness's own session first; on RW8, an answer that names missing
   * control-station write access is recorded and the request is sent again
   * from the manager's registered station, holding write access.
   */
  const setSimulated = async (loc: Location, name: string, on: boolean): Promise<'session' | 'write-access'> => {
    const obs = await ctx.observer();
    if (!(obs instanceof RWS2Adapter)) { throw new Error('signal simulation is an RWS 2.0 call in this client'); }
    try {
      await obs.setSignalSimulated(loc.network, loc.device, name, on);
      return 'session';
    } catch (e) {
      if (!needsWriteAccess(e)) { throw e; }
      ctx.note(`${on ? 'simulate' : 'unsimulate'} ${name}: refused without control-station write access`, { error: errText(e) });
      const own = managerRws2();
      if (!own) { throw e; }
      await underWriteAccess(() => own.setSignalSimulated(loc.network, loc.device, name, on));
      return 'write-access';
    }
  };

  /**
   * Collect the subscription events of signal `name` through the manager's
   * own subscription group (RWS 2.0, the path the daemon uses). Null when the
   * manager has no group (not streaming).
   */
  const watchInManagerGroup = async (name: string): Promise<SignalWatch | null> => {
    const m = ctx.manager;
    const group = m.subscriptionGroupPath;
    if (!group) { return null; }
    const events: SubscriptionEvent[] = [];
    let stopped = false;
    const off = m.onSubscriptionEvent(ev => { if (isSignalEvent(ev, name)) { events.push(ev); } });
    const putBody = await m.updateSubscriptionGroup(group, [{ type: 'signal', name }]);
    return {
      events, putBody, path: 'manager group', group,
      stop: async () => {
        if (stopped) { return; }
        stopped = true;
        off();
        await m.unsubscribeResource(group, { type: 'signal', name })
          .catch(e => ctx.note(`removing ${name} from the manager's group failed`, { error: errText(e) }));
      },
    };
  };

  /** Collect the subscription events of signal `name` on a subscription of session `a` (one group, deleted by stop). */
  const watchOnSession = async (a: IRWSAdapter, name: string): Promise<SignalWatch> => {
    const events: SubscriptionEvent[] = [];
    let stopped = false;
    const off = await a.subscribe([{ type: 'signal', name }], ev => { if (isSignalEvent(ev, name)) { events.push(ev); } });
    return {
      events, putBody: null, path: 'own subscription', group: undefined,
      stop: async () => { if (stopped) { return; } stopped = true; await off(); },
    };
  };

  /**
   * Where an I/O fixture signal lives: RW7 on the fixture's virtual device
   * (asserted), RW6 on no device (asserted; read and written by bare name).
   */
  const fixtureLocation = async (name: string): Promise<Location> => {
    const { at } = await locations();
    if (ctx.lane === 'rw7') {
      expect(at.get(name), `${name} on ${IO_FIXTURE.network}/${IO_FIXTURE.device}`)
        .toEqual({ network: IO_FIXTURE.network, device: IO_FIXTURE.device });
      return at.get(name)!;
    }
    expect(at.has(name), `${name} has no device on RW6`).toBe(false);
    return { network: '', device: '' };
  };

  /** Write a signal through the manager; on RW8 a missing-write-access answer is recorded and retried holding it. */
  const writeValue = async (name: string, value: string): Promise<'session' | 'write-access'> => {
    try {
      await ctx.manager.writeIoSignal(name, value);
      return 'session';
    } catch (e) {
      if (!needsWriteAccess(e)) { throw e; }
      ctx.note(`write ${name}=${value}: refused without control-station write access`, { error: errText(e) });
      await underWriteAccess(() => ctx.manager.writeIoSignal(name, value));
      return 'write-access';
    }
  };

  /**
   * Run the body of a signal-write test through the session it writes on.
   *
   * RWS 2.0: the manager - reads and writes through it, events through its
   * own subscription group (a second subscription is opened on the harness's
   * observer session only when the manager does not stream).
   *
   * RWS 1.0: the manager has no editable group and does not subscribe to
   * signals, and on this lane the observer IS the manager's session, so a
   * signal subscription there would be a second group and WebSocket on the
   * manager's RW6 session - which 10-subscriptions asserts never exists, on a
   * virtual controller known to be fragile about extra subscriptions. So the
   * manager is logged out, a session of the test's own does the reads, the
   * writes and the one subscription, is logged out, and the manager comes
   * back: the two-session pattern 10-subscriptions uses on RW 6.16.03.
   *
   * `io.onClose` steps run last-first when the body ends, pass or fail, while
   * the session is still open; failures are noted (the test's ctx.defer
   * backstops retry them through the manager in afterAll).
   */
  const withIoPath = async (body: (io: IoPath) => Promise<void>): Promise<void> => {
    const closing: Array<{ label: string; fn: () => Promise<void> }> = [];
    const runClose = async (): Promise<void> => {
      for (const s of closing.reverse()) {
        try { await s.fn(); } catch (e) { ctx.note(`${s.label} failed`, { error: errText(e) }); }
      }
    };
    if (ctx.generation === 'rws2') {
      const m = ctx.manager;
      const io: IoPath = {
        via: 'manager',
        read: (loc, name) => m.readIoSignal(loc.network, loc.device, name),
        write: writeValue,
        watch: async name => (await watchInManagerGroup(name)) ?? watchOnSession(await ctx.observer(), name),
        onClose: (label, fn) => { closing.push({ label, fn }); },
      };
      try { await body(io); } finally { await runClose(); }
      return;
    }
    await ctx.connectedManager()?.disconnect();
    let own: IRWSAdapter | null = null;
    try {
      own = await ctx.newAdapter();
      const a = own;
      const io: IoPath = {
        via: 'own session',
        read: (loc, name) => a.readSignal(loc.network, loc.device, name),
        write: async (name, value) => { await a.writeSignal('', '', name, value); return 'session'; },
        watch: name => watchOnSession(a, name),
        onClose: (label, fn) => { closing.push({ label, fn }); },
      };
      try { await body(io); } finally { await runClose(); }
    } finally {
      if (own) { await ctx.release(own); }
      await ctx.ensureManager();
    }
  };

  // ─── Reads ─────────────────────────────────────────────────────────────────

  it('lists every signal: the manager table, the adapter list and an empty search agree, with flat unique names', async () => {
    const all = await table();
    expect(ctx.manager.state.ioSignalsLoaded).toBe(true);
    expect(all.length).toBeGreaterThan(0);
    const names = all.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of all) {
      expect(s.name).not.toContain('/');
      expect(['DI', 'DO', 'AI', 'AO', 'GI', 'GO']).toContain(s.type);
      expect(typeof s.lvalue).toBe('string');
    }
    sameNames(await (await ctx.observer()).listAllSignals(), all);
    // An empty search is not refused: it returns the whole table, every page of it.
    sameNames(await ctx.manager.searchSignals({}), all);
    ctx.note('signal table', { count: all.length, byType: Object.fromEntries(['DI', 'DO', 'AI', 'AO', 'GI', 'GO'].map(t => [t, all.filter(s => s.type === t).length])) });
  });

  it('records how the list pages with a page size of 20, and still covers every signal', async () => {
    const all = await table();
    const obs = await ctx.observer();
    if (ctx.generation === 'rws2') {
      // RWS 2.0: the client walks the controller's `next` links, so one call
      // returns the whole table whatever page size the controller uses.
      const listed = await obs.listAllSignals(0, 20);
      expect(listed.map(s => s.name).length).toBe(new Set(listed.map(s => s.name)).size);
      sameNames(listed, all);
      ctx.note('RWS 2.0 list with limit 20', { count: listed.length });
      return;
    }
    // RWS 1.0 since 1.5.0: one call follows the controller's `next` links as
    // well. RW 6.16.03 honours limit (pages of 20 by start, 2026-10-22), so a
    // table of more than 20 signals takes several pages here: the requests
    // after the first are the links the controller served, as given. A link
    // the client does not follow is logged by it ("listAllSignals: the page
    // ...") in this trace.
    const mark = traceMark(ctx.lane);
    const listed = await obs.listAllSignals(0, 20);
    const pages = signalListGetsSince(ctx.lane, mark);
    ctx.note('RWS 1.0 list with limit 20', { count: listed.length, total: all.length, pages });
    expect(listed.map(s => s.name).length).toBe(new Set(listed.map(s => s.name)).size);
    sameNames(listed, all);
    expect(pages[0]).toBe('/rw/iosystem/signals?start=0&limit=20');
    if (all.length > 20) { expect(pages.length, 'more than one page was read').toBeGreaterThan(1); }
  });

  it('reads one signal by network/device/name and by bare name alike', async () => {
    const all = await table();
    const { at } = await locations();
    const pick = all.filter(s => s.type === 'DI' && at.has(s.name)).map(s => s.name).sort()[0]
      ?? all.filter(s => at.has(s.name)).map(s => s.name).sort()[0];
    expect(pick, 'a signal bound to a device').toBeTruthy();
    const loc = at.get(pick)!;
    const full = await ctx.manager.readIoSignal(loc.network, loc.device, pick);
    const bare = await ctx.manager.readIoSignal('', '', pick);
    expect(full.name).toBe(pick);
    expect(bare.name).toBe(pick);
    expect(full.type).toBe(all.find(s => s.name === pick)!.type);
    expect(bare.type).toBe(full.type);
    expect(bare.lvalue).toBe(full.lvalue);
    expect(full.value).toBe(full.lvalue);
  });

  it('answers a read of a signal that does not exist with a typed not-found', async () => {
    const err = await expectRwsError(() => ctx.manager.readIoSignal('', '', 'ZZ_PROBE_NO_SUCH_SIGNAL'));
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.httpStatus).toBe(404);
    ctx.note('unknown signal read', { controllerCode: err.controllerCode, message: err.message });
  });

  it('lists networks and devices; every device of a network is in the full device list', async () => {
    const nets = await ctx.manager.listNetworks();
    expect(nets.length).toBeGreaterThan(0);
    for (const n of nets) { expect(n.name).toBeTruthy(); }
    const all = await devices();
    expect(all.length).toBeGreaterThan(0);
    const key = (d: { network: string; name: string }): string => `${d.network}/${d.name}`;
    const allKeys = new Set(all.map(key));
    const viaNetworks: string[] = [];
    for (const n of nets) {
      for (const d of await ctx.manager.listDevices(n.name)) {
        expect(d.network).toBe(n.name);
        expect(allKeys.has(key(d)), `${key(d)} in listAllIoDevices`).toBe(true);
        viaNetworks.push(key(d));
      }
    }
    // The built-in devices each build lists (live, 2026-09-29).
    const expected: Record<string, string[]> = {
      rw6: ['Local/DRV_1', 'Local/PANEL'],
      rw7: ['IntBus/EPanel', 'IntBus/DrvSys', 'IntBus/ScLocIO', 'IntBus/IoPanel', 'SC_Feedback_Net/SC_Feedback_Dev'],
      rw8: ['IntBus/EPanel', 'IntBus/DrvSys', 'IntBus/ScLocIO', 'IntBus/IoPanel', 'SC_Feedback_Net/SC_Feedback_Dev',
        'IntegratedIONetwork/IntegratedIOInternalDevice'],
    };
    for (const k of expected[ctx.lane]) { expect([...allKeys]).toContain(k); }
    // The I/O fixture's virtual device, where the fixture is applied (RW7 only).
    if (ctx.lane === 'rw7' && (await table()).some(s => isIoFixtureSignal(s.name))) {
      expect([...allKeys]).toContain(`${IO_FIXTURE.network}/${IO_FIXTURE.device}`);
    }
    ctx.note('networks and devices', {
      networks: nets.map(n => `${n.name} ${n.lstate}/${n.pstate}`),
      devices: all.map(d => `${key(d)} ${d.lstate}/${d.pstate}`),
      devicesNotReachedThroughListNetworks: [...allKeys].filter(k => !viaNetworks.includes(k)),
    });
  });

  it('places every signal on exactly one device, except the device-less CyclicBrakeCheck signals on RWS 2.0 (and the collaborative signal on a CRB model), the device-less I/O fixture on RW6 and other ZZ_PROBE signals', async () => {
    const { at, unlocated, twice } = await locations();
    expect(twice).toEqual([]);
    const names = namesOf(await table());
    const fixture = names.filter(isIoFixtureSignal);
    const extraProbe = names.filter(isExtraProbeSignal);
    // The suite's own ZZ_PROBE signals, the fixture's and any added by hand, are not built in.
    const builtIn = unlocated.filter(n => !isProbeName(n));
    if (ctx.generation === 'rws1') {
      expect(builtIn).toEqual([]);
      // The fixture's signals have no device on RW6, by design.
      for (const n of fixture) { expect(unlocated).toContain(n); }
    } else {
      const cbc = builtIn.filter(n => DEVICELESS_CBC.test(n));
      const other = builtIn.filter(n => !DEVICELESS_CBC.test(n));
      expect(cbc.length).toBe(24);
      if (other.length) {
        // Only then is the robot model read: the extra device-less signals belong to a collaborative robot.
        const robotType = (await ctx.manager.getRobotType()).type;
        ctx.note('device-less built-in signals beyond the CyclicBrakeCheck set', { robotType, rwVersion: ctx.rwVersion, other });
        const allowed = isCollaborativeModel(robotType) ? DEVICELESS_COLLABORATIVE : [];
        expect(other.filter(n => !allowed.includes(n)), `device-less signals on robot type ${JSON.stringify(robotType)}`).toEqual([]);
      }
      for (const n of fixture) { expect(at.get(n)).toEqual({ network: IO_FIXTURE.network, device: IO_FIXTURE.device }); }
    }
    if (fixture.length) { ctx.note('I/O fixture signals', { fixture, located: fixture.map(n => at.get(n) ?? null) }); }
    if (extraProbe.length) {
      ctx.note('other ZZ_PROBE signals (not checked)', { extraProbe, located: extraProbe.map(n => at.get(n) ?? null) });
    }
  });

  it('searches devices by exact name and by logical state; a search with neither is refused before sending', async () => {
    const all = await devices();
    for (const d of all.slice(0, 3)) {
      const hits = await ctx.manager.searchIoDevices({ name: d.name });
      expect(hits.map(h => `${h.network}/${h.name}`)).toContain(`${d.network}/${d.name}`);
    }
    const enabled = await ctx.manager.searchIoDevices({ lstate: 'enabled' });
    const allKeys = new Set(all.map(d => `${d.network}/${d.name}`));
    for (const h of enabled) {
      expect(h.lstate).toBe('enabled');
      expect(allKeys.has(`${h.network}/${h.name}`)).toBe(true);
    }
    const net = all[0].network;
    for (const h of await ctx.manager.searchIoDevices({ lstate: 'enabled', network: net })) { expect(h.network).toBe(net); }
    const err = await expectRwsError(() => ctx.manager.searchIoDevices({ network: net }));
    expect(err.code).toBe('INVALID_ARGUMENT');
    ctx.note('device search', {
      enabled: enabled.length,
      listedEnabled: all.filter(d => d.lstate === 'enabled').length,
      total: all.length,
    });
  });

  it('records whether device search by name matches a prefix or ignores case', async () => {
    const all = await devices();
    const d = [...all].sort((a, b) => b.name.length - a.name.length)[0];
    const prefix = d.name.slice(0, Math.max(2, d.name.length - 3));
    const byPrefix = await ctx.manager.searchIoDevices({ name: prefix });
    const byCase = await ctx.manager.searchIoDevices({ name: d.name.toUpperCase() === d.name ? d.name.toLowerCase() : d.name.toUpperCase() });
    const allKeys = new Set(all.map(x => `${x.network}/${x.name}`));
    for (const h of [...byPrefix, ...byCase]) { expect(allKeys.has(`${h.network}/${h.name}`)).toBe(true); }
    ctx.note('device name search', {
      device: `${d.network}/${d.name}`, prefix,
      prefixFinds: byPrefix.some(h => h.name === d.name),
      otherCaseFinds: byCase.some(h => h.name === d.name),
    });
  });

  // ─── Signal search semantics ───────────────────────────────────────────────

  it('matches name as a case-insensitive prefix, never a substring, with no wildcard', async () => {
    const all = await table();
    const names = all.map(s => s.name);
    const p = choosePrefix(names);
    const expected = all.filter(s => startsWithCi(s.name, p));
    expect(expected.length).toBeGreaterThan(0);
    sameNames(await ctx.manager.searchSignals({ name: p }), expected);
    sameNames(await ctx.manager.searchSignals({ name: p.toLowerCase() }), expected);
    sameNames(await ctx.manager.searchSignals({ name: p.toUpperCase() }), expected);
    // Names that contain the prefix further in are not hits (the equality above excludes them).
    const inside = names.filter(n => !startsWithCi(n, p) && lc(n).includes(lc(p)));
    const fragment = chooseInnerFragment(names);
    if (fragment) { expect(await ctx.manager.searchSignals({ name: fragment })).toEqual([]); }
    expect(await ctx.manager.searchSignals({ name: '*' })).toEqual([]);
    expect(await ctx.manager.searchSignals({ name: `${p}*` })).toEqual([]);
    ctx.note('name prefix search', { prefix: p, hits: expected.length, containInside: inside.length, fragment });
  });

  it('matches device and network as whole values, ignoring case', async () => {
    const { at } = await locations();
    const all = await devices();
    const counts = new Map<string, number>();
    for (const l of at.values()) { counts.set(`${l.network}/${l.device}`, (counts.get(`${l.network}/${l.device}`) ?? 0) + 1); }
    const [busiest] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const [net, dev] = busiest.split('/');
    const onDevice = await ctx.manager.searchSignals({ device: dev });
    expect(onDevice.length).toBeGreaterThan(0);
    sameNames(await ctx.manager.searchSignals({ device: dev.toLowerCase() }), onDevice);
    sameNames(await ctx.manager.searchSignals({ device: dev.toUpperCase() }), onDevice);
    const cut = dev.slice(0, -1);
    if (!all.some(d => lc(d.name) === lc(cut))) { expect(await ctx.manager.searchSignals({ device: cut })).toEqual([]); }

    const onNetwork = await ctx.manager.searchSignals({ network: net });
    expect(onNetwork.length).toBeGreaterThanOrEqual(onDevice.length);
    const netCut = net.slice(0, -1);
    if (!all.some(d => lc(d.network) === lc(netCut))) { expect(await ctx.manager.searchSignals({ network: netCut })).toEqual([]); }
    const lower = await ctx.manager.searchSignals({ network: net.toLowerCase() });
    const upper = await ctx.manager.searchSignals({ network: net.toUpperCase() });
    if (ctx.generation === 'rws2') {
      // Live-verified 2026-09-29 on RW 7.21.4 and 8.2.1: intbus = INTBUS = IntBus.
      sameNames(lower, onNetwork);
      sameNames(upper, onNetwork);
    } else {
      // Not probed on RW 6: recorded.
      ctx.note('RWS 1.0 network criterion case', {
        network: net, exact: onNetwork.length, lower: lower.length, upper: upper.length,
        ignoresCase: lower.length === onNetwork.length && upper.length === onNetwork.length,
      });
    }
  });

  it('matches category as a whole value, ignoring case, with the category each build ships', async () => {
    const all = await table();
    const category = ctx.lane === 'rw6' ? 'safety' : 'internal';
    const hits = await ctx.manager.searchSignals({ category });
    sameNames(await ctx.manager.searchSignals({ category: category.toUpperCase() }), hits);
    expect(await ctx.manager.searchSignals({ category: category.slice(0, 3) })).toEqual([]);
    if (ctx.lane === 'rw8') {
      // The IntegratedIO signals carry no category on RW 8.2.1 (live, 2026-09-29).
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThan(all.length);
      expect(hits.filter(s => s.name.startsWith('IIO_'))).toEqual([]);
    } else {
      // Every built-in signal. The suite's ZZ_PROBE signals (the I/O
      // fixture's, and any added by hand) carry no category and are left out
      // on both sides.
      sameNames(hits.filter(s => !isProbeName(s.name)), all.filter(s => !isProbeName(s.name)));
    }
    ctx.note('category search', { category, hits: hits.length, total: all.length });
  });

  it('ANDs criteria: within one set, and a second set narrows the first; a third set is refused before sending', async () => {
    const all = await table();
    const p = choosePrefix(all.map(s => s.name));
    sameNames(await ctx.manager.searchSignals({ type: 'DO', name: p }), all.filter(s => s.type === 'DO' && startsWithCi(s.name, p)));
    sameNames(await ctx.manager.searchSignalsEx([{ type: 'DI' }, { name: p }]), all.filter(s => s.type === 'DI' && startsWithCi(s.name, p)));
    sameNames(await ctx.manager.searchSignalsEx([{ type: 'DO' }]), all.filter(s => s.type === 'DO'));
    expect(await ctx.manager.searchSignalsEx([{ type: 'DI' }, { type: 'DO' }])).toEqual([]);
    const three: SignalSearchExCriteria[] = [{ type: 'DI' }, { type: 'DO' }, { name: p }];
    const err = await expectRwsError(() => ctx.manager.searchSignalsEx(three));
    expect(err.code).toBe('INVALID_ARGUMENT');
  });

  it('negates its own criteria set with invert (set 1) and invert2 (set 2); invert alone matches nothing', async () => {
    const all = await table();
    const p = choosePrefix(all.map(s => s.name));
    sameNames(await ctx.manager.searchSignalsEx([{ type: 'DO', invert: true }]), all.filter(s => s.type !== 'DO'));
    sameNames(await ctx.manager.searchSignalsEx([{ type: 'DO' }, { name: p, invert: true }]),
      all.filter(s => s.type === 'DO' && !startsWithCi(s.name, p)));
    sameNames(await ctx.manager.searchSignalsEx([{ type: 'DI' }, { name: p, invert: false }]),
      all.filter(s => s.type === 'DI' && startsWithCi(s.name, p)));
    expect(await ctx.manager.searchSignalsEx([{ invert: true }])).toEqual([]);
    sameNames(await ctx.manager.searchSignalsEx([{ invert: false }]), all);
    // An empty extended criteria set is an empty body: every signal.
    sameNames(await ctx.manager.searchSignalsEx([{}]), all);
  });

  // ─── Writes ────────────────────────────────────────────────────────────────

  it('writes a general-purpose DI (simulated first on RWS 2.0), reads it back, sees the event, and puts it back', async t => {
    // Only RWS 2.0 simulates; on RW6 the device-less fixture input is written directly.
    const simulate = ctx.generation === 'rws2';
    if (simulate) { await ctx.requireAllowed(t, 'signal-simulate'); }
    const m = ctx.manager;
    const all = await table();
    const { at } = await locations();
    const sysIn = await systemInputNames();
    if (!sysIn) { return ctx.skip(t, 'the system-input configuration (SYSSIG_IN) could not be read, so no signal is written'); }

    // RW8: a general-purpose IIO_di input - category neither `internal` nor
    // `safety`, bound to a device, not bound to a system input. RW6 and RW7
    // ship none: the I/O fixture's ZZ_PROBE_DI1.
    let target: string;
    let loc: Location;
    if (ctx.lane === 'rw8') {
      const notInternal = await m.searchSignalsEx([{ type: 'DI' }, { category: 'internal', invert: true }]);
      const safety = new Set((await m.searchSignals({ type: 'DI', category: 'safety' })).map(s => s.name));
      const candidates = notInternal.filter(s => /^IIO_di\d+$/i.test(s.name)
        && !safety.has(s.name) && !sysIn.has(lc(s.name)) && at.has(s.name));
      if (candidates.length === 0) {
        return ctx.skip(t, 'no IIO_di input found that is general purpose, bound to a device and free of a system input');
      }
      const num = (n: string): number => Number(/(\d+)$/.exec(n)?.[1] ?? -1);
      target = candidates.map(s => s.name).sort((a, b) => num(b) - num(a) || a.localeCompare(b))[0];
      loc = at.get(target)!;
    } else {
      const fixture = all.find(s => s.name === IO_FIXTURE.di);
      if (!fixture) { return ctx.skip(t, ioFixtureHint(ctx.lane)); }
      expect(fixture.type).toBe('DI');
      if (sysIn.has(lc(IO_FIXTURE.di))) {
        return ctx.skip(t, `${IO_FIXTURE.di} is bound to a system input on this VC, so the suite does not write it`);
      }
      target = IO_FIXTURE.di;
      loc = await fixtureLocation(target);
    }

    // Backstops, run in afterAll through the manager if an undo step below
    // did not complete (last registered first: the value, the subscription,
    // the simulation).
    let simulated = false;
    let dirty = false;
    let v0 = '';
    let watch: SignalWatch | null = null;
    ctx.defer(`unsimulate ${target}`, async () => { if (simulated) { await setSimulated(loc, target, false); simulated = false; } });
    ctx.defer(`stop events of ${target}`, async () => { if (watch) { await watch.stop(); } });
    ctx.defer(`${target} back to its starting value`, async () => {
      if (dirty) { await ctx.ensureManager(); await writeValue(target, v0); dirty = false; }
    });

    let skipReason: string | null = null;
    await withIoPath(async io => {
      v0 = (await io.read(loc, target)).lvalue;
      const v1 = v0 === '0' ? '1' : '0';
      ctx.note('DI write target', { target, loc, v0, v1, simulate, via: io.via });

      io.onClose(`unsimulate ${target}`, async () => { if (simulated) { await setSimulated(loc, target, false); simulated = false; } });
      io.onClose(`stop events of ${target}`, async () => { if (watch) { await watch.stop(); } });
      io.onClose(`${target} back to ${v0}`, async () => { if (dirty) { await io.write(target, v0); dirty = false; } });

      let simPath: string = 'not simulated';
      if (simulate) {
        simPath = await setSimulated(loc, target, true);
        simulated = true;
      }

      const w = await io.watch(target);
      watch = w;
      const lstateOnAdd = w.putBody === null ? null : lstateIn(w.putBody, target);
      if (w.putBody !== null) { expect(lstateOnAdd, 'lstate in the group-add answer').toBe('simulated'); }

      // Write, read back, see the event.
      let writePath: 'session' | 'write-access';
      try {
        writePath = await io.write(target, v1);
      } catch (e) {
        if (e instanceof RwsError && ctx.lane === 'rw8' && e.code === 'GRANT_DENIED') {
          const still = await io.read(loc, target);
          expect(still.lvalue).toBe(v0);
          ctx.note(`writing simulated ${target} was refused`, { error: errText(e), refusal: e.refusal });
          skipReason = `RW8 refused writing simulated ${target}: ${e.controllerCode ?? ''} ${e.controllerMsg ?? e.message}`;
          return;
        }
        throw e;
      }
      dirty = true;
      const events = w.events;
      await waitUntil(async () => (await io.read(loc, target)).lvalue === v1, 5000, 250, `${target} reads ${v1}`);
      expect((await io.read({ network: '', device: '' }, target)).lvalue).toBe(v1);
      await waitUntil(() => events.some(ev => ev.value === v1), 10000, 100, `a ${target} event with ${v1}`);

      // Back to the starting value.
      await io.write(target, v0);
      await waitUntil(async () => (await io.read(loc, target)).lvalue === v0, 5000, 250, `${target} reads ${v0} again`);
      dirty = false;
      const backEvent = await waitFor(() => events.some((ev, i) => ev.value === v0 && i > events.findIndex(x => x.value === v1)), 10000, 100);
      expect(backEvent, `a ${target} event with ${v0} after the one with ${v1}`).toBe(true);

      // Unsimulate; the input then reads its own value again (the one read before simulating).
      let unsimPath: string | null = null;
      let lstateAfter: string | null = null;
      if (simulate) {
        unsimPath = await setSimulated(loc, target, false);
        simulated = false;
        await waitUntil(async () => (await io.read(loc, target)).lvalue === v0, 5000, 250, `${target} reads ${v0} unsimulated`);

        // The simulation state as the controller reports it: drop the signal
        // from the group and add it again (an add of a member answers an empty
        // 200, so the drop comes first).
        const group = w.group;
        if (group) {
          await w.stop();
          const again = await m.updateSubscriptionGroup(group, [{ type: 'signal', name: target }]).catch(e => {
            ctx.note('re-adding the signal to read its lstate failed', { error: errText(e) }); return '';
          });
          lstateAfter = lstateIn(again, target);
          await m.unsubscribeResource(group, { type: 'signal', name: target }).catch(() => undefined);
          if (lstateAfter !== null) { expect(lstateAfter).toBe('not simulated'); }
        }
      }
      await w.stop();
      ctx.note('DI write round trip', {
        target, via: io.via, simPath, writePath, unsimPath, lstateOnAdd, lstateAfter, eventPath: w.path,
        events: events.map(ev => ({ resource: ev.resource, value: ev.value })),
      });
    });
    if (skipReason) { return ctx.skip(t, skipReason); }
  });

  it('writes a general-purpose DO (the I/O fixture\'s ZZ_PROBE_DO1), reads it back, sees the event, and puts it back', async t => {
    if (ctx.lane === 'rw8') {
      return ctx.skip(t, 'RW8: the I/O fixture is never applied on RobotWare 8; what a write of IIO_do8 answers there is recorded by the RW8 test below');
    }
    const all = await table();
    const signal = all.find(s => s.name === IO_FIXTURE.do);
    if (!signal) { return ctx.skip(t, ioFixtureHint(ctx.lane)); }
    expect(signal.type).toBe('DO');
    const target = IO_FIXTURE.do;
    const loc = await fixtureLocation(target);

    // Backstops, run in afterAll through the manager (see the DI test).
    let dirty = false;
    let v0 = '';
    let watch: SignalWatch | null = null;
    ctx.defer(`stop events of ${target}`, async () => { if (watch) { await watch.stop(); } });
    ctx.defer(`${target} back to its starting value`, async () => {
      if (dirty) { const m = await ctx.ensureManager(); await m.writeIoSignal(target, v0); dirty = false; }
    });

    await withIoPath(async io => {
      v0 = (await io.read(loc, target)).lvalue;
      const v1 = v0 === '0' ? '1' : '0';
      ctx.note('DO write target', { target, loc, v0, v1, via: io.via });
      io.onClose(`stop events of ${target}`, async () => { if (watch) { await watch.stop(); } });
      io.onClose(`${target} back to ${v0}`, async () => { if (dirty) { await io.write(target, v0); dirty = false; } });

      const w = await io.watch(target);
      watch = w;
      const events = w.events;
      // Access level All: the controller takes the write in Auto from a remote client.
      await io.write(target, v1);
      dirty = true;
      await waitUntil(async () => (await io.read(loc, target)).lvalue === v1, 5000, 250, `${target} reads ${v1}`);
      expect((await io.read({ network: '', device: '' }, target)).lvalue).toBe(v1);
      if (io.via === 'manager') {
        // The manager's own table follows its write.
        expect(ctx.manager.state.ioSignals.find(s => s.name === target)?.lvalue ?? v1).toBe(v1);
      }
      await waitUntil(() => events.some(ev => ev.value === v1), 10000, 100, `a ${target} event with ${v1}`);

      await io.write(target, v0);
      await waitUntil(async () => (await io.read(loc, target)).lvalue === v0, 5000, 250, `${target} reads ${v0} again`);
      dirty = false;
      const backEvent = await waitFor(() => events.some((ev, i) => ev.value === v0 && i > events.findIndex(x => x.value === v1)), 10000, 100);
      expect(backEvent, `a ${target} event with ${v0} after the one with ${v1}`).toBe(true);
      await w.stop();
      ctx.note('DO write round trip', {
        target, via: io.via, eventPath: w.path, events: events.map(ev => ({ resource: ev.resource, value: ev.value })),
      });
    });
  });

  it('asserts the typed refusal of a signal write the controller is known to refuse (same value, so nothing changes)', async t => {
    // The refused writes on record: RW 6.16 drive-unit output DRV1TESTE2 in
    // Auto (2026-08-02 and 2026-09-27); RW 7.21 SafetyEnable (2026-08-02).
    const refused: Partial<Record<string, string>> = { rw6: 'DRV1TESTE2', rw7: 'SafetyEnable' };
    const name = refused[ctx.lane];
    if (!name) {
      return ctx.skip(t, 'RW8 has no signal whose write is refused every time (IIO_do8 was both accepted and refused on 2026-09-27); see the next test');
    }
    const all = await table();
    if (!all.some(s => s.name === name)) {
      return ctx.skip(t, `${name}, the signal the refusal was recorded on, is not on this VC (${ctx.rwVersion}); no other signal here has a recorded refusal`);
    }
    const panel = await ctx.panel();
    if (panel.opmode !== 'AUTO') { return ctx.skip(t, `the refusal is on record in Auto; the controller reads ${panel.opmode}`); }
    const current = (await ctx.manager.readIoSignal('', '', name)).lvalue;
    const err = await expectRwsError(() => ctx.manager.writeIoSignal(name, current));
    expect(err.code).toBe('GRANT_DENIED');
    expect(err.httpStatus).toBe(403);
    expect(err.controllerCode).toBe(-1073445881);
    expect(err.refusal).toMatchObject({ kind: 'access-restricted', grantor: 'integrator' });
    expect(err.refusal?.sentence ?? '').toContain(name);
    expect(err.message).toMatch(/access level/);
    expect(err.message).not.toMatch(/RMMP/);
    expect((await ctx.manager.readIoSignal('', '', name)).lvalue).toBe(current);
    ctx.note('refused signal write', { name, value: current, opmode: panel.opmode, ctrlstate: panel.ctrlstate, message: err.message });
  });

  it('records what a same-value write of IIO_do8 answers from the registered RW8 station without write access held', async t => {
    if (ctx.lane !== 'rw8') { return ctx.skip(t, 'RW8 only: this write was both accepted and refused on RW 8.1.1 (2026-09-27)'); }
    const name = 'IIO_do8';
    const all = await table();
    if (!all.some(s => s.name === name)) { return ctx.skip(t, `${name} is not on this VC`); }
    const panel = await ctx.panel();
    const current = (await ctx.manager.readIoSignal('', '', name)).lvalue;
    const heldLocks = (ctx.manager.state.access?.locks ?? []).filter(l => l.state === 'held').map(l => l.lock);
    let outcome: string;
    try {
      await ctx.manager.writeIoSignal(name, current);
      outcome = 'accepted';
    } catch (e) {
      if (!(e instanceof RwsError)) { throw e; }
      expect(['GRANT_DENIED', 'MASTERSHIP_REQUIRED']).toContain(e.code);
      outcome = `refused: ${e.code} ${e.httpStatus ?? ''} ${e.controllerCode ?? ''} ${e.controllerMsg ?? ''}`.trim();
    }
    expect((await ctx.manager.readIoSignal('', '', name)).lvalue).toBe(current);
    ctx.note('IIO_do8 same-value write', { outcome, value: current, opmode: panel.opmode, ctrlstate: panel.ctrlstate, heldLocks });
  });
});
