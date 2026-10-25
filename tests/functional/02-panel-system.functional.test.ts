/**
 * Functional tests, per controller: the panel and system reads every tool on
 * this client shows, and the one panel write they all make, the speed ratio.
 *
 * Reads: controller state, operation mode, speed ratio and collision
 * detection (a direct read and the RobotManager state agree), the
 * operation-mode lock state (RWS 2.0), system info (name, RobotWare version,
 * system id, options, start time), products, controller identity, the
 * controller clock, I/O networks and devices, and the /ctrl listings each
 * generation exposes.
 *
 * Writes: the speed ratio set through RobotManager and restored, a change made
 * by another session reaching the RobotManager state, a write of the value it
 * already has, a write inside a hold the caller took, values refused before
 * anything is sent, and the typed, explained refusal while another session
 * holds the access the write needs.
 *
 * Expectations per build come from live reads of RW 6.16.03 (6.16.3007),
 * RW 7.21.4+417 and RW 8.2.1+1023 virtual controllers on 2026-09-29 and from
 * the client's own doc comments; where those do not settle what a build does,
 * the test asserts only what must hold and records the observed value in the
 * lane's trace (tests titled "records ...").
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers. Every change is put back in the test and again by the
 * harness restore.
 */

import fs from 'node:fs';
import os from 'node:os';
import { it, expect } from 'vitest';
import {
  RWS1Adapter, RWS2Adapter, RobotManager, RwsError,
  type ControlStationIdentity, type IRWSAdapter,
} from '../../src/index.js';
import type { CollisionDetectionState, ControllerState, SubscriptionEvent } from '../../src/types.js';
import {
  forEachController, expectRwsError, laneForVersion, traceFile, waitFor, waitUntil,
  type Lane, type TestHandle, type TraceLine,
} from './helpers/index.js';

// ─── Vocabulary and wire patterns ────────────────────────────────────────────

const CONTROLLER_STATES: readonly ControllerState[] = [
  'init', 'motoroff', 'motoron', 'guardstop', 'emergencystop', 'emergencystopreset', 'sysfail',
];
const COLDET_STATES: readonly CollisionDetectionState[] = ['INIT', 'TRIGGERED', 'CONFIRMED', 'TRIGGERED_ACK'];

/** Controller time as RWS writes it, on RW 6.16, 7.21 and 8.2 alike: `2026-09-29 T 15:09:37`. */
const CTRL_TIME = /^(\d{4})-(\d{2})-(\d{2}) T (\d{2}):(\d{2}):(\d{2})$/;
const BRACED_GUID = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Wire lines of the lane trace (`http.req` messages are `RWS1|RWS2 <METHOD> <path>`). */
const SPEED_POST = /\bPOST \/rw\/panel\/speedratio\b/;
const SPEED_GET = /\bGET \/rw\/panel\/speedratio\b/;
/** A mastership request (RW6: `?action=request`, RW7: `/edit/request`) or an RW8 write-access request. */
const ACCESS_REQUEST = /\bPOST \/rw\/(mastership\S*request|controlstation\/writeaccess\/request)/;
const ACCESS_RELEASE = /\bPOST \/rw\/(mastership\S*release|controlstation\/writeaccess\/release)/;
/** A speed-ratio subscription event: `speedratio` on RWS 2.0, the raw href on RWS 1.0. */
const SPEED_RESOURCE = /speedratio/i;

/**
 * A second RobotWare 8 control station, for the tests that need another
 * session to hold write access (ignored on RobotWare 6 and 7). A fixed id for
 * the same reason as the harness's own station.
 */
const SECOND_STATION: ControlStationIdentity = {
  name: 'abb-rws-client functional second station',
  id: '{0C5E7D2B-4A91-4F36-B8E0-5D2F9A7C1E43}',
  pincode: '1234',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Controller local time (`YYYY-MM-DD T HH:MM:SS`) as ms since the epoch in this PC's time zone; NaN if malformed. */
function ctrlTimeMs(s: string): number {
  const m = CTRL_TIME.exec(s.trim());
  if (!m) { return Number.NaN; }
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** Number of `http.req` lines in the lane trace whose message matches `re`. */
function countWire(lane: Lane, re: RegExp): number {
  let raw = '';
  try { raw = fs.readFileSync(traceFile(lane), 'utf8'); } catch { return 0; }
  let n = 0;
  for (const line of raw.split('\n')) {
    if (!line) { continue; }
    try {
      const l = JSON.parse(line) as TraceLine;
      if (l.cat === 'http.req' && re.test(l.msg)) { n++; }
    } catch { /* a partial line */ }
  }
  return n;
}

/** Locks this manager's session counts as held right now. */
function heldLocks(m: RobotManager): string[] {
  return m.state.access.locks.filter(l => l.state === 'held' && l.count > 0).map(l => l.lock);
}

/** Another speed ratio to write: 25 lower, or 25 higher when that stays at or below 50. */
function otherRatio(v: number): number {
  return v >= 30 ? v - 25 : v + 25;
}

/** The lock a `rapid` hold lands on, per lane. */
const RAPID_LOCK: Readonly<Record<Lane, string>> = { rw6: 'rapid', rw7: 'edit', rw8: 'writeaccess' };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ─── Tests ───────────────────────────────────────────────────────────────────

await forEachController('02-panel-system', ctx => {
  /** Speed-ratio writes are Auto-only (ABB, RWS 1.0 and 2.0 panel pages): skip otherwise. */
  const autoSpeedRatio = async (t: TestHandle): Promise<number> => {
    const p = await ctx.panel();
    if (p.opmode !== 'AUTO') { ctx.skip(t, `speed-ratio writes are Auto-only; the controller reads ${String(p.opmode)}`); }
    if (p.speedRatio === null) { throw new Error('the speed ratio could not be read'); }
    return p.speedRatio;
  };

  /**
   * RW8 only: set while the second station may hold write access. The
   * deferred step makes sure the second station holds nothing afterwards.
   */
  let secondStationMayHold = false;
  let secondStationUndoRegistered = false;
  const guardSecondStation = (): void => {
    if (ctx.lane !== 'rw8' || secondStationUndoRegistered) { return; }
    secondStationUndoRegistered = true;
    ctx.defer('second control station holds no write access', async () => {
      if (!secondStationMayHold) { return; }
      const a = await ctx.newAdapter({ controlStation: SECOND_STATION });
      try {
        await a.requestMastership('rapid');
        await a.releaseMastership('rapid');
        if (a instanceof RWS2Adapter && (await a.getWriteAccessStatus()).held) {
          throw new Error('write access is still held after the second station released it');
        }
        secondStationMayHold = false;
      } finally {
        await ctx.release(a);
      }
    });
  };

  // ── Reads ──────────────────────────────────────────────────────────────────

  it('reads controller state, operation mode, speed ratio and collision detection, and the manager state agrees', async () => {
    const a = await ctx.observer();
    const ctrlstate = await a.getControllerState();
    const opmode = await a.getOperationMode();
    const speedRatio = await a.getSpeedRatio();
    const coldet = await a.getCollisionDetectionState();
    ctx.note('panel read', { ctrlstate, opmode, speedRatio, coldet });

    expect(CONTROLLER_STATES).toContain(ctrlstate);
    expect(['AUTO', 'MANR', 'MANF']).toContain(opmode);
    expect(opmode).toBe(ctx.baseline.opmode);
    expect(Number.isInteger(speedRatio)).toBe(true);
    expect(speedRatio).toBeGreaterThanOrEqual(0);
    expect(speedRatio).toBeLessThanOrEqual(100);
    expect(COLDET_STATES).toContain(coldet);
    // No collision on an idle virtual controller: INIT on all three builds
    // (live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1).
    expect(coldet).toBe('INIT');

    const m = ctx.manager;
    await waitUntil(() => m.state.ctrlstate === ctrlstate
      && m.state.opmode === opmode
      && m.state.speedRatio === speedRatio
      && m.state.coldetstate === coldet, 15000, 250, 'manager panel state equal to the direct read');
  });

  it(ctx.generation === 'rws2'
    ? 'reads the operation-mode lock state as unlocked'
    : 'has no operation-mode lock-state read on RWS 1.0', async () => {
    const a = await ctx.observer();
    if (a instanceof RWS2Adapter) {
      // `GET /rw/panel/opmode/lock-state` read `unlocked` on both OmniCore VCs
      // (live-verified 2026-09-27 on RW 7.21 and 8.1.1, 2026-09-29 on RW 7.21.4
      // and 8.2.1); the client reads the v=2.0 representation, which is well
      // formed (its v=2.1 body is an unrendered template).
      const lock = await a.getOperationModeLockState();
      ctx.note('opmode lock state', { lock });
      expect(lock).toBe('unlocked');
    } else {
      // The resource is RWS 2.0 only; RW 6.16 answers 404 and the RWS 1.0
      // adapter has no such read.
      expect(a).toBeInstanceOf(RWS1Adapter);
      expect('getOperationModeLockState' in a).toBe(false);
    }
  });

  it('reads system info: name, RobotWare version, system id, options and start time', async () => {
    const a = await ctx.observer();
    const si = await a.getSystemInfo();
    ctx.note('system info', { ...si, options: si.options.length });

    expect(si.name).toBe(ctx.systemName);
    expect(si.rwVersion).toBe(ctx.rwVersion);
    expect(laneForVersion(si.rwVersion)).toBe(ctx.lane);
    // RW6 reports the version as major.minor.build (6.16.3007); RW7 and RW8 as
    // major.minor.patch+build (7.21.4+417, 8.2.1+1023). Live-verified 2026-09-29.
    expect(si.rwVersion).toMatch(ctx.generation === 'rws1' ? /^6\.\d+\.\d+$/ : /^\d+\.\d+\.\d+\+\d+$/);
    expect(si.sysid).toMatch(BRACED_GUID);
    expect(si.startTime).toMatch(CTRL_TIME);
    expect(si.options.length).toBeGreaterThan(0);
    // Every system lists its language option; 'English' on all three VCs
    // (live-verified 2026-09-29).
    expect(si.options).toContain('English');

    const state = ctx.manager.state.systemInfo;
    expect(state).not.toBeNull();
    expect({ name: state!.name, rwVersion: state!.rwVersion, sysid: state!.sysid })
      .toEqual({ name: si.name, rwVersion: si.rwVersion, sysid: si.sysid });
    expect([...state!.options].sort()).toEqual([...si.options].sort());
  });

  it('records how the option list agrees with the options in system info', async () => {
    const si = await (await ctx.observer()).getSystemInfo();
    const listed = (await ctx.manager.listControllerOptions()).map(o => o.name);
    const onlyInList = listed.filter(n => !si.options.includes(n));
    const onlyInSystemInfo = si.options.filter(n => !listed.includes(n));
    ctx.note('options: list vs system info', {
      listed: listed.length, systemInfo: si.options.length, onlyInList, onlyInSystemInfo,
    });
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toContain('English');
  });

  it(ctx.generation === 'rws2'
    ? 'lists products: RobotControl carries the RobotWare version, RobotOS its own'
    : 'lists products: one RobotWare product named with the RobotWare version', async () => {
    const products = await ctx.manager.listProducts();
    ctx.note('products', products);
    expect(products.length).toBeGreaterThan(0);
    if (ctx.generation === 'rws2') {
      // Live-verified 2026-09-29: RobotControl 7.21.4+417 (version name 7.21.4)
      // with RobotOS 18.1.4+115 on RW 7.21.4; RobotControl 8.2.1+1023 with
      // RobotOS 21.0.1+297 on RW 8.2.1.
      const rc = products.find(p => p.name === 'RobotControl');
      expect(rc, 'a RobotControl product').toBeDefined();
      expect(rc!.version).toBe(ctx.rwVersion);
      expect(rc!.versionName).toBe(ctx.rwVersion.split('+')[0]);
      const ros = products.find(p => p.name === 'RobotOS');
      expect(ros, 'a RobotOS product').toBeDefined();
      expect(ros!.version).toMatch(/^\d+\.\d+\.\d+\+\d+$/);
    } else {
      // RW 6.16.03 lists a single product, `RobotWare`, with only a version
      // name (6.16.03.00), in the JSON shape the RWS 2.0 builds use
      // (live-verified 2026-09-29). The adapter returns the raw entries.
      const rw = products.find(p => p._title === 'RobotWare');
      expect(rw, 'a RobotWare product').toBeDefined();
      const [major, minor] = ctx.rwVersion.split('.');
      expect(rw!['version-name']).toMatch(new RegExp(`^${major}\\.${minor}\\.`));
    }
  });

  it('reads the controller identity: a virtual controller with no id or MAC', async () => {
    const identity = await (await ctx.observer()).getControllerIdentity();
    const host = os.hostname();
    ctx.note('identity', {
      ...identity, isSystemName: identity.name === ctx.systemName,
      isHostName: identity.name.toLowerCase() === host.toLowerCase(),
    });
    // `Virtual Controller` in XHTML and RWS 1.0 JSON, `VIRTUAL_CONTROLLER` in
    // RWS 2.0 hal+json (live-verified 2026-09-29).
    expect(identity.type.replace(/_/g, ' ')).toMatch(/^virtual controller$/i);
    // ctrl-id and ctrl-mac are real-controller keys, absent on all three VCs
    // (re-read 2026-09-29), and the RWS 2.0 client never reads them.
    expect(identity.id).toBe('');
    expect(identity.mac).toBe('');
    expect(identity.name).not.toBe('');
    if (ctx.generation === 'rws2') {
      // RW 7.21.4 and 8.2.1 name the controller after the system; RW 6.16.03
      // named it after the host PC (live-verified 2026-09-29), recorded above.
      expect(identity.name).toBe(ctx.systemName);
    }
    const m = ctx.manager;
    await waitUntil(() => m.state.identity !== null, 15000, 250, 'manager identity');
    expect(m.state.identity).toEqual(identity);
  });

  it('reads the controller clock as this PC\'s local time, and a start time not after it', async () => {
    const m = ctx.manager;
    const clock = await m.getControllerClock();
    const skewMs = ctrlTimeMs(clock) - Date.now();
    expect(clock).toMatch(CTRL_TIME);
    // A virtual controller runs on the PC clock in the PC's time zone: the
    // clock, event-log times and the start time are local time (live-verified
    // 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1).
    expect(Math.abs(skewMs)).toBeLessThan(120_000);

    const si = await (await ctx.observer()).getSystemInfo();
    const after = await m.getControllerClock();
    const start = ctrlTimeMs(si.startTime);
    expect(Number.isNaN(start)).toBe(false);
    expect(start).toBeLessThanOrEqual(ctrlTimeMs(after) + 2000);
    // On RW 6.16.03 the start time was seen to follow the request time with
    // no restart (observed 2026-09-29); recorded, not asserted.
    ctx.note('clock', {
      clock, skewMs, startTime: si.startTime,
      startTracksRequestTime: Math.abs(ctrlTimeMs(after) - start) <= 5000,
    });
  });

  it('lists I/O networks and devices with names', async () => {
    const m = ctx.manager;
    const networks = await m.listNetworks();
    expect(Array.isArray(networks)).toBe(true);
    for (const n of networks) { expect(n.name).not.toBe(''); }
    const devicesByNetwork: Record<string, number> = {};
    for (const n of networks.slice(0, 4)) {
      const devices = await m.listDevices(n.name);
      expect(Array.isArray(devices)).toBe(true);
      for (const d of devices) { expect(d.name).not.toBe(''); }
      devicesByNetwork[n.name] = devices.length;
    }
    const all = await m.listAllIoDevices();
    expect(Array.isArray(all)).toBe(true);
    ctx.note('I/O networks and devices', {
      networks: networks.map(n => ({ name: n.name, lstate: n.lstate, pstate: n.pstate })),
      devicesByNetwork, allDevices: all.length,
    });
  });

  it(ctx.generation === 'rws2'
    ? 'reads the /ctrl listings RWS 2.0 exposes: restart count, registry, safety mode, virtual time, no features, no saved diagnostics'
    : 'reads the /ctrl listings RWS 1.0 exposes: network interfaces, DNS, routes, virtual time, empty time zone', async () => {
    const m = ctx.manager;
    const a: IRWSAdapter = await ctx.observer();

    const vt = await m.getVirtualTime();
    expect(typeof vt.time).toBe('number');
    expect(typeof vt.running).toBe('boolean');
    // /ctrl/features is a verify-style endpoint: its bare listing is empty on
    // RW7/RW8, and RWS 1.0 has no such read.
    expect(await m.listFeatures()).toEqual([]);
    // Nothing is ever saved on these VCs: RW7/RW8 answer 400 "No Diagnostics
    // Saved on controller yet" (live-verified 2026-09-29 on RW 7.21.4 and
    // 8.2.1), read as empty; RWS 1.0 has no such read.
    expect((await m.getDiagnostics()).empty).toBe(true);

    if (a instanceof RWS1Adapter) {
      // `GET /ctrl/network` answers 200 on RW 6.16.03 with one `ctrl-netw`
      // entry per interface (live-verified 2026-09-29).
      const nics = await a.listNetworkInterfaces();
      expect(nics.length).toBeGreaterThan(0);
      for (const nic of nics) { expect(nic.addr).toMatch(IPV4); }
      const first = await a.getNetworkConfig();
      expect(first.addr).toBe(nics[0].addr);
      const dns = await a.getDnsConfig();
      const routes = await a.getRoutingTable();
      // Time zone is a real-controller resource in ABB's docs; on a VC the
      // read degrades to empty.
      const tz = await a.getTimezone();
      expect(tz.tz).toBe('');
      ctx.note('/ctrl listings (RWS 1.0)', { nics, dns, routes: routes.length, tz, virtualTime: vt });
    } else if (a instanceof RWS2Adapter) {
      /** A read whose presence on this build is not established: recorded; a failure must be typed. */
      const typedOrValue = async <T>(what: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
        try { return await fn(); } catch (e) {
          expect(e, `${what} failed with a non-RwsError: ${errText(e)}`).toBeInstanceOf(RwsError);
          return { error: `${(e as RwsError).code} ${errText(e)}` };
        }
      };
      // The restart count was live-verified on RW 7.21 (2026-08-04); on RW8
      // /ctrl does not list `restart`, so there it is recorded only.
      const restarts = ctx.lane === 'rw7'
        ? await a.getRestartCount()
        : await typedOrValue('restart count', () => a.getRestartCount());
      if (typeof restarts === 'number') {
        expect(Number.isInteger(restarts)).toBe(true);
        expect(restarts).toBeGreaterThanOrEqual(0);
      }
      // The registry root lists one entry per registry file.
      const registry = await a.getRegistry();
      expect(Object.keys(registry).length).toBeGreaterThan(0);
      const safety = await typedOrValue('safety mode', () => a.getSafetyMode());
      // /ctrl/network is not served on the RW7/RW8 VCs (404 "not supported on
      // virtual controller") and the client reads it on RWS 1.0 only.
      expect('listNetworkInterfaces' in a).toBe(false);
      ctx.note('/ctrl listings (RWS 2.0)', { restarts, registry: Object.keys(registry), safety, virtualTime: vt });
    } else {
      throw new Error(`unexpected adapter class ${(a as object).constructor.name}`);
    }
  });

  it('records the robot type, licence entries, energy statistics and enable request', async () => {
    const m = ctx.manager;
    const outcome: Record<string, unknown> = {};
    const read = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        outcome[what] = await fn();
      } catch (e) {
        // A read may be absent on a build; what must hold is that the failure
        // is typed.
        expect(e, `${what} failed with a non-RwsError: ${errText(e)}`).toBeInstanceOf(RwsError);
        outcome[what] = { error: (e as RwsError).code, http: (e as RwsError).httpStatus, message: errText(e) };
      }
    };
    await read('robotType', () => m.getRobotType());
    await read('licence', () => m.getLicenseInfo());
    await read('energy', () => m.getEnergyStats());
    await read('enableRequest', () => m.getEnableRequest());
    ctx.note('robot type, licence, energy, enable request', outcome);
    const rt = outcome.robotType as { type?: unknown } | undefined;
    if (rt && !('error' in rt)) { expect(typeof rt.type).toBe('string'); }
  });

  // ── Writes ─────────────────────────────────────────────────────────────────

  it('sets the speed ratio through RobotManager, reads it back from the controller and restores it', async t => {
    const before = await autoSpeedRatio(t);
    const target = otherRatio(before);
    const m = ctx.manager;
    const posts0 = countWire(ctx.lane, SPEED_POST);
    const access0 = countWire(ctx.lane, ACCESS_REQUEST);
    let watching = true;
    let changes = 0;
    const seen: number[] = [];
    m.onDidChange(() => {
      if (!watching) { return; }
      changes++;
      if (m.state.speedRatio !== null) { seen.push(m.state.speedRatio); }
    });

    try {
      await m.setSpeedRatio(target);
      // The manager reports its own write at once, and tells its listeners.
      expect(m.state.speedRatio).toBe(target);
      expect(changes).toBeGreaterThan(0);
      seen.length = 0;

      await waitUntil(async () => (await ctx.panel()).speedRatio === target, 10000, 250, `controller speed ratio ${target}`);
      expect(countWire(ctx.lane, SPEED_POST) - posts0).toBeGreaterThanOrEqual(1);
      const accessRequests = countWire(ctx.lane, ACCESS_REQUEST) - access0;
      if (ctx.generation === 'rws1') {
        // RW6 takes the write with no mastership (live-verified 2026-09-29 on
        // RW 6.16.03, 204 in Auto) and the client requests none.
        expect(accessRequests).toBe(0);
      } else {
        // RW7 edit mastership / RW8 write access, taken by the client around
        // the write and released after it.
        expect(accessRequests).toBeGreaterThanOrEqual(1);
      }
      await waitUntil(() => heldLocks(m).length === 0, 5000, 100, 'no hold left after the write');

      // A poll that read the old value before the write must not put it back
      // afterwards: every value the manager reports over the next two polls is
      // the new one.
      const gets0 = countWire(ctx.lane, SPEED_GET);
      await waitUntil(() => countWire(ctx.lane, SPEED_GET) - gets0 >= 2, 25000, 500, 'two manager polls after the write');
      expect(seen.filter(v => v !== target)).toEqual([]);
      expect(m.state.speedRatio).toBe(target);
    } finally {
      watching = false;
      await m.setSpeedRatio(before);
    }
    await waitUntil(async () => (await ctx.panel()).speedRatio === before, 10000, 250, `controller speed ratio back to ${before}`);
    expect(m.state.speedRatio).toBe(before);
  });

  it('a speed-ratio change made by another session reaches the RobotManager state', async t => {
    const before = await autoSpeedRatio(t);
    const target = otherRatio(before);
    const m = ctx.manager;
    const live = m.state.quality === 'live';
    const events: SubscriptionEvent[] = [];
    const off = m.onSubscriptionEvent(e => { if (SPEED_RESOURCE.test(e.resource)) { events.push(e); } });
    // RWS 1.0: the manager's own adapter, which writes without touching the
    // manager's state (the RW6 VC refuses a further session while the manager
    // is connected). RWS 2.0: a session of its own.
    const writer = ctx.generation === 'rws1'
      ? await ctx.observer()
      : await ctx.newAdapter({ controlStation: SECOND_STATION });
    guardSecondStation();

    try {
      secondStationMayHold = ctx.lane === 'rw8';
      await writer.setSpeedRatio(target);
      if (writer instanceof RWS2Adapter && ctx.lane === 'rw8') {
        // The adapter releases the write access it took for the write.
        expect((await writer.getWriteAccessStatus()).held).toBe(false);
        secondStationMayHold = false;
      }
      await waitUntil(() => m.state.speedRatio === target, 15000, 100, `manager speed ratio ${target}`);
      const byEvent = await waitFor(() => events.some(e => Number(e.value) === target), live ? 10000 : 0, 100);
      ctx.note('speed ratio written by another session', {
        live, byEvent, events: events.map(e => ({ resource: e.resource, value: e.value })),
      });
      if (live && ctx.generation === 'rws2') {
        // RWS 2.0 panel subscriptions push every change (the value, not an
        // initial one); with the subscription live the change arrives as an
        // event. On RWS 1.0 whether the resource was bound is recorded only.
        expect(byEvent).toBe(true);
      }
    } finally {
      off();
      await m.setSpeedRatio(before);
      if (ctx.generation === 'rws2') { await ctx.release(writer); }
    }
    await waitUntil(async () => (await ctx.panel()).speedRatio === before, 10000, 250, `controller speed ratio back to ${before}`);
  });

  it('accepts a speed-ratio write of the value it already has and changes nothing; records whether it raises an event', async t => {
    const current = await autoSpeedRatio(t);
    const m = ctx.manager;
    const events: SubscriptionEvent[] = [];
    const off = m.onSubscriptionEvent(e => { if (SPEED_RESOURCE.test(e.resource)) { events.push(e); } });
    try {
      await m.setSpeedRatio(current);
      expect(m.state.speedRatio).toBe(current);
      expect((await ctx.panel()).speedRatio).toBe(current);
      await waitUntil(() => heldLocks(m).length === 0, 5000, 100, 'no hold left after the write');
      const evented = await waitFor(() => events.length > 0, 3000, 100);
      ctx.note('same-value speed-ratio write', {
        value: current, quality: m.state.quality, evented, events: events.map(e => e.value),
      });
    } finally {
      off();
    }
    expect(m.state.speedRatio).toBe(current);
  });

  it('within a hold the caller took, a speed-ratio write reuses it and does not end it', async t => {
    const current = await autoSpeedRatio(t);
    const m = ctx.manager;
    await m.requestMastership('rapid');
    let statusWhileHeld: unknown = null;
    try {
      await waitUntil(() => heldLocks(m).includes(RAPID_LOCK[ctx.lane]), 5000, 100, `${RAPID_LOCK[ctx.lane]} held`);
      const requests0 = countWire(ctx.lane, ACCESS_REQUEST);
      const releases0 = countWire(ctx.lane, ACCESS_RELEASE);
      await m.setSpeedRatio(current);
      // Nothing more requested and nothing released: the write ran inside the
      // caller's hold, which is still counted afterwards.
      expect(countWire(ctx.lane, ACCESS_REQUEST)).toBe(requests0);
      expect(countWire(ctx.lane, ACCESS_RELEASE)).toBe(releases0);
      expect(heldLocks(m)).toContain(RAPID_LOCK[ctx.lane]);
      if (ctx.lane === 'rw7') {
        const o = await ctx.observer();
        statusWhileHeld = await o.getMastershipStatus?.('rapid');
      }
    } finally {
      await m.releaseMastership('rapid');
    }
    await waitUntil(() => heldLocks(m).length === 0, 5000, 100, 'the caller\'s hold released');
    if (ctx.lane === 'rw7') {
      // Released edit mastership reads `nomaster` (live-verified 2026-09-29 on
      // RW 7.21.4).
      const o = await ctx.observer();
      const after = await o.getMastershipStatus!('rapid');
      ctx.note('edit mastership while held and after release', { statusWhileHeld, after });
      expect(after.mastership).toBe('nomaster');
    }
  });

  it('rejects an out-of-range speed ratio before anything is sent (INVALID_ARGUMENT), and a write before connect (NOT_CONNECTED)', async () => {
    const m = ctx.manager;
    const before = (await ctx.panel()).speedRatio;
    const posts0 = countWire(ctx.lane, SPEED_POST);
    const access0 = countWire(ctx.lane, ACCESS_REQUEST);
    for (const bad of [101, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = await expectRwsError(() => m.setSpeedRatio(bad));
      expect(e.code, `speed ratio ${bad}`).toBe('INVALID_ARGUMENT');
      expect(e.message).toMatch(/between 0 and 100/);
    }
    // Refused by the client: no speed-ratio POST, and on RWS 2.0 no access
    // request either (the value is checked before access is taken).
    expect(countWire(ctx.lane, SPEED_POST)).toBe(posts0);
    expect(countWire(ctx.lane, ACCESS_REQUEST)).toBe(access0);
    expect((await ctx.panel()).speedRatio).toBe(before);
    expect(m.state.speedRatio).toBe(before);

    const idle = new RobotManager();
    const e = await expectRwsError(() => idle.setSpeedRatio(50));
    expect(e.code).toBe('NOT_CONNECTED');
    expect((await expectRwsError(() => idle.getControllerClock())).code).toBe('NOT_CONNECTED');
  });

  if (ctx.generation === 'rws2') {
    it('refuses a speed-ratio write while another session holds the access it needs: MASTERSHIP_REQUIRED, held by another, explained', async t => {
      const current = await autoSpeedRatio(t);
      const m = ctx.manager;
      const holder = await ctx.newAdapter({ controlStation: SECOND_STATION });
      guardSecondStation();
      secondStationMayHold = ctx.lane === 'rw8';
      await holder.requestMastership('rapid');
      let err: RwsError;
      try {
        if (holder instanceof RWS2Adapter && ctx.lane === 'rw8') {
          expect((await holder.getWriteAccessStatus()).heldByMe).toBe(true);
        }
        err = await expectRwsError(() => m.setSpeedRatio(current));
      } finally {
        await holder.releaseMastership('rapid');
      }
      if (holder instanceof RWS2Adapter && ctx.lane === 'rw8') {
        expect((await holder.getWriteAccessStatus()).held).toBe(false);
        secondStationMayHold = false;
      }
      const r = err.refusal;
      ctx.note('speed-ratio write refused while another session holds access', {
        code: err.code, http: err.httpStatus, controllerCode: err.controllerCode, message: err.message,
        refusal: r ? { kind: r.kind, condition: r.condition, grantor: r.grantor, holder: r.holder, sentence: r.sentence, evidence: r.evidence } : null,
      });

      // RW7: the edit-mastership request answers 403 -1073445862 "held by
      // someone else"; RW8: the write-access request answers 403 -1073435870
      // "already taken" (live-verified 2026-09-29 on RW 8.2.1 with two
      // registered stations). Both are MASTERSHIP_REQUIRED, held by another.
      expect(err.code).toBe('MASTERSHIP_REQUIRED');
      expect(err.httpStatus).toBe(403);
      expect(err.controllerCode).toBe(ctx.lane === 'rw8' ? -1073435870 : -1073445862);
      expect(r, 'the error explains the refusal').toBeDefined();
      expect(r!.kind).toBe('held-by-other');
      expect(r!.condition).toBe(ctx.lane === 'rw8' ? 'write-access' : 'mastership');
      expect(r!.grantor).toBe('current-holder');
      expect(r!.generation).toBe(ctx.lane);
      expect(r!.controller.code).toBe(err.controllerCode);
      expect(r!.sentence.length).toBeGreaterThan(40);
      expect(err.message).toContain(r!.sentence);
      if (ctx.lane === 'rw8' && r!.holder?.name) { expect(r!.holder.name).toBe(SECOND_STATION.name); }

      // Nothing changed and nothing is left held by the refused writer.
      expect((await ctx.panel()).speedRatio).toBe(current);
      await waitUntil(() => heldLocks(m).length === 0, 5000, 100, 'no hold left after the refusal');
      // With the holder gone the same write goes through.
      await m.setSpeedRatio(current);
      if (ctx.lane === 'rw7') {
        expect((await (await ctx.observer()).getMastershipStatus!('rapid')).mastership).toBe('nomaster');
      }
      await ctx.release(holder);
    });
  } else {
    it('records whether RW6 refuses a speed-ratio write while another session holds rapid mastership', async t => {
      const current = await autoSpeedRatio(t);
      // Two extra sessions: the RW6 VC refuses any while the manager is
      // connected, so it goes first (restore and ensureManager reconnect it).
      await ctx.manager.disconnect();
      let outcome: Record<string, unknown> = {};
      let failure: unknown = null;
      try {
        const holder = await ctx.newAdapter();
        const writer = await ctx.newAdapter();
        await holder.requestMastership('rapid');
        try {
          await writer.setSpeedRatio(current);
          outcome = { refused: false };
        } catch (e) {
          failure = e;
          outcome = e instanceof RwsError
            ? { refused: true, code: e.code, http: e.httpStatus, controllerCode: e.controllerCode, kind: e.refusal?.kind, sentence: e.refusal?.sentence, message: e.message }
            : { refused: true, error: errText(e) };
        } finally {
          await holder.releaseMastership('rapid').catch(e => ctx.note('holder release failed', { error: errText(e) }));
          await ctx.release(writer);
          await ctx.release(holder);
        }
      } finally {
        await ctx.ensureManager();
      }
      ctx.note('RW6 speed-ratio write while another session holds rapid', outcome);
      // RW6 needs no mastership for the write; with another holder the answer
      // is not established. If it is refused, the refusal must be typed and
      // explained.
      if (failure !== null) {
        expect(failure).toBeInstanceOf(RwsError);
        const e = failure as RwsError;
        expect(e.code).not.toBe('UNKNOWN');
        expect(e.refusal, 'the error explains the refusal').toBeDefined();
        expect(e.message.length).toBeGreaterThan(20);
      }
      await waitUntil(() => !!ctx.manager.state.systemInfo, 20000, 250, 'manager reconnected');
      expect((await ctx.panel()).speedRatio).toBe(current);
    });
  }
});
