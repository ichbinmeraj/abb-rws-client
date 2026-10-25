/**
 * Functional: connecting, per controller.
 *
 * - Protocol detection without a login: `probeProtocol`, `probeHost`,
 *   `RobotManager.probeSpecificPort`, `findControllers` and the legacy
 *   `RobotManager.discoverLocalControllers` classify each controller by its
 *   auth challenge, port and scheme.
 * - The factories: `createClient` and `createAdapter` return the protocol
 *   client and the adapter of the controller's generation, logged in; given a
 *   port and no scheme they take the scheme from the port tables (the one
 *   scheme of a listed port; both at once on 80 and on an unlisted port).
 * - `RobotManager.connect` fills `RobotState`: identity, system info,
 *   operating mode, controller state, speed ratio, execution, tasks, modules,
 *   mechanical units and the session's access state.
 * - `MultiRobotManager` with every discovered controller at once: switching
 *   the active robot, and one robot's state kept apart from the others'.
 * - A refused login is the typed `AUTH_FAILED`, and no other account is tried.
 * - Disconnect sends `GET /logout` and clears the state; a reconnect works.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers. Nothing here writes to a controller except one speed
 * ratio change in the MultiRobotManager test (at most 50 %, put back at once,
 * and restored by the harness as well).
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import {
  MultiRobotManager, RobotManager, RwsClient, RwsClient2, RWS1Adapter, RWS2Adapter, RwsError,
  createAdapter, createClient, findControllers, probeHost, probeProtocol,
} from '../../src/index.js';
import { KNOWN_RWS_PORTS } from '../../src/detect.js';
import { schemeForPort } from '../../src/discovery/scheme.js';
import {
  forEachController, expectRwsError, discoverFleet, installTrace, laneForVersion, onlyLanes, traceFile, waitFor, waitUntil, assertLocalhost,
  FUNCTIONAL_ENABLED, FUNCTIONAL_STATION, HOST, TEST_PASS, TEST_USER,
  type FleetController, type FunctionalContext, type Lane, type TraceLine,
} from './helpers/index.js';

// ─── Which lane hosts the MultiRobotManager test ────────────────────────────
//
// The fleet test needs every controller at once, so it runs once, in the
// first lane that runs: no other lane's harness sessions exist yet then, and
// on the RW6 lane its manager can be logged out first (the RW6 virtual
// controller refuses a further session while a RobotManager is connected).

let fleetMembers: FleetController[] = [];
if (FUNCTIONAL_ENABLED) {
  installTrace();
  const fleet = await discoverFleet().catch(() => null);
  const only = onlyLanes();
  fleetMembers = (fleet?.controllers ?? []).filter(c => !only || only.includes(c.lane));
}
const MULTI_HOST: Lane = fleetMembers[0]?.lane ?? 'rw6';

// ─── Small helpers ──────────────────────────────────────────────────────────

const CONTROLLER_STATES = ['init', 'motoroff', 'motoron', 'guardstop', 'emergencystop', 'emergencystopreset', 'sysfail'];
const OPERATION_MODES = ['AUTO', 'MANR', 'MANF', 'AUTO_CH', 'MANF_CH', 'MANR_CH'];
const EXEC_CYCLES = ['once', 'forever', 'asis', 'oncedone'];

let markerSeq = 0;

/** Write a marker line into the lane's trace and return it. */
function mark(ctx: FunctionalContext, label: string): string {
  const m = `01-connect marker ${++markerSeq} ${label} ${Date.now()}`;
  ctx.note(m);
  return m;
}

/** The lane's trace lines written after `marker` (and before `until`, when given). */
function traceAfter(ctx: FunctionalContext, marker: string, until?: string): TraceLine[] {
  const lines = fs.readFileSync(traceFile(ctx.lane), 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l) as TraceLine; } catch { return null; } })
    .filter((l): l is TraceLine => l !== null);
  const from = lines.findIndex(l => l.level === 'test' && l.msg === marker);
  expect(from, `marker "${marker}" in the ${ctx.lane} trace`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(from + 1);
  if (!until) { return rest; }
  const to = rest.findIndex(l => l.level === 'test' && l.msg === until);
  return to >= 0 ? rest.slice(0, to) : rest;
}

const httpOf = (lines: TraceLine[], cat: 'http.req' | 'http.res' | 'http.err'): Array<{ method?: string; path?: string; status?: number; msg: string }> =>
  lines.filter(l => l.cat === cat).map(l => ({ ...(l.data as { method?: string; path?: string; status?: number } | undefined), msg: l.msg }));

/**
 * The RW6 virtual controller refuses a further session while the lane's
 * RobotManager is connected (harness.ts): log the manager out before a test
 * opens a session of its own there. The harness reconnects it for restore.
 */
async function freeRw6Slot(ctx: FunctionalContext): Promise<void> {
  if (ctx.generation === 'rws1') { await ctx.connectedManager()?.disconnect(); }
}

/** Connect, retrying a CONTROLLER_BUSY refusal a few times (RW6 session pressure). */
async function connectPatiently(connect: () => Promise<void>): Promise<void> {
  const pauses = [2000, 5000, 10000];
  for (let i = 0; ; i++) {
    try { await connect(); return; } catch (e) {
      if (!(e instanceof RwsError && e.code === 'CONTROLLER_BUSY') || i >= pauses.length) { throw e; }
      await new Promise(r => setTimeout(r, pauses[i]));
    }
  }
}

await forEachController('01-connect', ctx => {
  // ─── RobotManager.connect fills RobotState ────────────────────────────────

  it('connect fills the identity and system info of this controller', async () => {
    const m = await ctx.ensureManager();
    expect(m.state.connected).toBe(true);
    expect(m.state.host).toBe(HOST);
    expect(m.currentPort).toBe(ctx.port);
    expect(m.currentUseHttps).toBe(ctx.generation === 'rws2');
    expect(['live', 'polling']).toContain(m.state.quality);
    ctx.note('connection quality after connect', { quality: m.state.quality, reason: m.state.qualityReason });

    await waitUntil(() => !!m.state.systemInfo && !!m.state.identity, 20000, 250, 'system info and identity');
    const info = m.state.systemInfo!;
    expect(info.rwVersion).toBe(ctx.rwVersion);
    expect(laneForVersion(info.rwVersion)).toBe(ctx.lane);
    expect(info.name).toBe(ctx.systemName);
    expect(info.sysid.length).toBeGreaterThan(0);
    expect(Array.isArray(info.options)).toBe(true);

    const id = m.state.identity!;
    expect(id.name.length).toBeGreaterThan(0);
    // Live-verified 2026-09-29: ctrl-type reads "Virtual Controller" on RW
    // 6.16.03 and "VIRTUAL_CONTROLLER" on RW 7.21.4 and 8.2.1.
    expect(id.type).toMatch(/virtual/i);
    // ctrl-id and ctrl-mac are served by real controllers only; all three
    // virtual controllers omit them (live-verified 2026-09-29 on RW 6.16.03,
    // 7.21.4 and 8.2.1), and RWS 2.0 identity never carries them.
    expect(id.id).toBe('');
    expect(id.mac).toBe('');
    ctx.note('identity', id);
  });

  it('connect fills the panel and execution state, in agreement with a direct read', async () => {
    const m = await ctx.ensureManager();
    const panel = await ctx.panel();
    await waitUntil(() => m.state.opmode === panel.opmode
      && m.state.ctrlstate === panel.ctrlstate
      && m.state.speedRatio === panel.speedRatio
      && m.state.execstate === panel.execstate, 15000, 250, 'manager state equal to a direct read');

    expect(OPERATION_MODES).toContain(m.state.opmode);
    expect(CONTROLLER_STATES).toContain(m.state.ctrlstate);
    expect(Number.isInteger(m.state.speedRatio)).toBe(true);
    expect(m.state.speedRatio!).toBeGreaterThanOrEqual(0);
    expect(m.state.speedRatio!).toBeLessThanOrEqual(100);
    expect(['running', 'stopped']).toContain(m.state.execstate);
    await waitUntil(() => m.state.execCycle !== null, 15000, 250, 'execution cycle');
    expect(EXEC_CYCLES).toContain(m.state.execCycle);
    ctx.note('panel after connect', { ...panel, execCycle: m.state.execCycle });
  });

  it('connect fills the tasks, modules and mechanical units', async () => {
    const m = await ctx.ensureManager();
    await waitUntil(() => m.state.tasks.length > 0 && m.state.mechunits.length > 0, 15000, 250, 'tasks and mechanical units');
    const motion = m.state.tasks.find(x => x.name === ctx.task);
    expect(motion).toBeDefined();
    expect(motion!.motiontask).toBe(true);
    expect(m.state.mechunits).toContain(ctx.mechunit);

    // The module list of the motion task matches what the controller lists.
    const listed = ctx.baseline.modulesByTask[ctx.task] ?? [];
    expect(listed.length).toBeGreaterThan(0);
    await waitUntil(() => {
      const mine = m.state.modulesByTask[ctx.task] ?? [];
      return mine.length === listed.length && listed.every(x => mine.includes(x));
    }, 15000, 250, 'modules of the motion task');
    expect(m.state.modules.length).toBeGreaterThan(0);

    await waitUntil(() => m.state.joints !== null, 15000, 250, 'joints');
    for (const v of Object.values(m.state.joints!)) { expect(Number.isFinite(v)).toBe(true); }
  });

  it('connect reports the access model of the generation, with nothing held', async () => {
    const m = await ctx.ensureManager();
    const a = m.state.access;
    expect(a.generation).toBe(ctx.lane);
    expect(a.locks.length).toBeGreaterThan(0);
    for (const l of a.locks) { expect(l.count).toBe(0); }
    if (ctx.lane === 'rw8') {
      expect(a.rw8).not.toBeNull();
      expect(a.rw8!.stationName).toBe(FUNCTIONAL_STATION.name);
    } else {
      expect(a.rw8).toBeNull();
    }
    ctx.note('access after connect', a);
  });

  // ─── Protocol detection without a login ───────────────────────────────────

  it('probeProtocol answers the generation on the controller\'s port and scheme', async () => {
    expect(await probeProtocol(HOST, ctx.port, ctx.https, 3000)).toBe(ctx.generation);
  });

  it('probeProtocol finds no challenge over the other scheme on the controller\'s port', async () => {
    // Each virtual controller port serves one scheme only: plain HTTP to the
    // RW7 and RW8 ports is reset, and the RW6 port gives no TLS answer
    // (live-verified 2026-09-27 on RW 6.16, 7.21 and 8.1.1).
    expect(await probeProtocol(HOST, ctx.port, !ctx.https, 2000)).toBeNull();
  });

  it('probeSpecificPort and findControllers classify this controller by scheme and challenge', async t => {
    const auth = ctx.generation === 'rws1' ? 'digest' : 'basic';
    const probe = await RobotManager.probeSpecificPort(HOST, ctx.port, false, 3000);
    expect(probe).toEqual({ port: ctx.port, useHttps: ctx.https, authType: auth });

    // This PC's loopback only, one probe at a time at least 1 s apart.
    const result = await findControllers({
      loopbackOnly: true, serviceAddress: false, mdns: false, identify: 'none',
      filterToVcProcesses: true, pacing: { local: { concurrency: 1, minGapMs: 1000 } },
    });
    for (const c of result.controllers) { assertLocalhost(c.host); }
    ctx.note('findControllers local scan', result.localScan);
    if (result.localScan.status !== 'ok') {
      ctx.skip(t, `the listening-port scan of this PC did not answer (${result.localScan.status})`);
    }
    const me = result.controllers.find(c => c.port === ctx.port);
    expect(me).toBeDefined();
    expect(me!.key).toBe(`local:${ctx.port}`);
    expect(me!.https).toBe(ctx.https);
    expect(me!.authType).toBe(auth);
    expect(me!.generation).toBe(ctx.generation);
    expect(me!.identified).toBe(true);
    expect(me!.sources).toContain('this-pc');
    expect(me!.probe).toEqual({ host: HOST, port: ctx.port, useHttps: ctx.https, authType: auth });
  }, 120000);

  it('the legacy RobotManager.discoverLocalControllers finds this controller with the same scheme and challenge', async () => {
    // The wrapper keeps its own path (both schemes at once on every listening
    // port, no login); RobotManager's connect-time recovery still uses it.
    const auth = ctx.generation === 'rws1' ? 'digest' : 'basic';
    const found = await RobotManager.discoverLocalControllers(HOST);
    for (const c of found) { assertLocalhost(c.host); }
    ctx.note('discoverLocalControllers result', found);
    expect(found.find(c => c.port === ctx.port)).toEqual({ host: HOST, port: ctx.port, useHttps: ctx.https, authType: auth });
  }, 120000);

  it('probeHost finds this controller with no port given only when it is on a known port and scheme', async t => {
    // Port 80 is listed with both schemes, so the RW 8.1.1 virtual controller
    // serving HTTPS on 80 counts as known too.
    const onKnown = KNOWN_RWS_PORTS.some(k => k.port === ctx.port && k.https === ctx.https);
    const found = await probeHost(HOST, 1500);
    ctx.note('probeHost result', { found, port: ctx.port, https: ctx.https, onKnown });

    if (!onKnown) { ctx.skip(t, `port ${ctx.port} is not a known RWS port; the listening-port scan finds it`); }
    if (found?.port !== ctx.port) {
      ctx.skip(t, `probeHost stops at the first known port that answers (${found?.port}), before :${ctx.port}`);
    }
    expect(found).toEqual({ protocol: ctx.generation, port: ctx.port, https: ctx.https });

    await freeRw6Slot(ctx);
    const auto = await createAdapter({ host: HOST, username: TEST_USER, password: TEST_PASS, timeout: 8000 });
    try {
      expect(auto).toBeInstanceOf(ctx.generation === 'rws1' ? RWS1Adapter : RWS2Adapter);
      expect((await auto.getSystemInfo()).rwVersion).toBe(ctx.rwVersion);
    } finally {
      await auto.disconnect().catch(() => undefined);
    }
  });

  // ─── MultiRobotManager, every controller at once (one lane only) ──────────

  if (ctx.lane === MULTI_HOST) {
    it('MultiRobotManager connects every controller at once, switches the active robot and keeps their states apart', async t => {
      if (fleetMembers.length < 2) { ctx.skip(t, 'needs controllers of at least two lanes running'); }
      await freeRw6Slot(ctx);

      const multi = new MultiRobotManager();
      const managers = new Map<string, RobotManager>();
      const changedIds: string[] = [];
      let changes = 0;
      multi.onRobotChanged(id => changedIds.push(id));
      multi.onDidChange(() => { changes++; });
      for (const c of fleetMembers) {
        multi.addRobot({ id: c.lane, name: c.label, host: HOST, port: c.port, useHttps: c.https, username: TEST_USER, password: TEST_PASS });
      }
      for (const e of multi.entries) { managers.set(e.id, e.manager); }
      const ids = fleetMembers.map(c => c.lane as string);
      const member = (id: string): FleetController => fleetMembers.find(c => c.lane === id)!;

      try {
        expect(multi.activeId).toBe(ids[0]);
        expect(multi.entries.map(e => e.id)).toEqual(ids);

        await Promise.all(ids.map(id => connectPatiently(() => multi.connectRobot(id))));
        for (const id of ids) {
          const m = managers.get(id)!;
          expect(m.state.connected).toBe(true);
          expect(m.currentPort).toBe(member(id).port);
        }
        await waitUntil(() => ids.every(id => !!managers.get(id)!.state.systemInfo && managers.get(id)!.state.speedRatio !== null),
          30000, 250, 'system info and speed ratio of every robot');
        for (const id of ids) {
          const info = managers.get(id)!.state.systemInfo!;
          expect(info.rwVersion).toBe(member(id).rwVersion);
          expect(info.name).toBe(member(id).systemName);
        }
        const sysids = ids.map(id => managers.get(id)!.state.systemInfo!.sysid);
        expect(new Set(sysids).size).toBe(ids.length);

        // connectRobot keeps the first robot active while it is connected.
        expect(multi.activeId).toBe(ids[0]);
        expect(multi.state).toBe(managers.get(ids[0])!.state);

        // Switching the active robot switches the state consumers see.
        for (const id of [...ids].reverse()) {
          const before = changes;
          multi.setActive(id);
          expect(multi.activeId).toBe(id);
          expect(multi.active).toBe(managers.get(id));
          expect(multi.state.systemInfo!.rwVersion).toBe(member(id).rwVersion);
          expect(changes).toBeGreaterThan(before);
        }
        const activeNow = multi.activeId;
        multi.setActive('zz-probe-no-such-robot');
        expect(multi.activeId).toBe(activeNow);

        // A change on one controller shows in that robot's state only. The
        // write goes to this lane's controller (restored by the harness too);
        // never RW8 here, where the fleet's anonymous station would need write access.
        if (ctx.lane !== 'rw8') {
          const host = managers.get(ctx.lane)!;
          const others = ids.filter(id => id !== ctx.lane);
          const otherBefore = new Map(others.map(id => [id, managers.get(id)!.state.speedRatio]));
          const before = host.state.speedRatio!;
          const target = before === 40 ? 45 : 40;
          ctx.defer('speed ratio back after the fleet test', async () => {
            const m = await ctx.ensureManager();
            if (m.state.speedRatio !== before) { await m.setSpeedRatio(before); }
          });
          changedIds.length = 0;
          await host.setSpeedRatio(target);
          try {
            await waitUntil(() => host.state.speedRatio === target, 15000, 250, `speed ratio ${target} on ${ctx.lane}`);
            expect(changedIds).toContain(ctx.lane);
            for (const id of others) { expect(managers.get(id)!.state.speedRatio).toBe(otherBefore.get(id)); }
          } finally {
            await host.setSpeedRatio(before);
          }
          await waitUntil(() => host.state.speedRatio === before, 15000, 250, `speed ratio back to ${before}`);
        }

        // Disconnecting one robot leaves the others connected and untouched.
        const last = ids[ids.length - 1];
        const keep = ids.filter(id => id !== last);
        const kept = new Map(keep.map(id => [id, managers.get(id)!.state.systemInfo!.sysid]));
        await multi.disconnectRobot(last);
        expect(managers.get(last)!.state.connected).toBe(false);
        expect(managers.get(last)!.state.systemInfo).toBeNull();
        for (const id of keep) {
          expect(managers.get(id)!.state.connected).toBe(true);
          expect(managers.get(id)!.state.systemInfo!.sysid).toBe(kept.get(id));
        }

        // Removing the active robot makes the first remaining one active.
        multi.setActive(ids[0]);
        multi.removeRobot(ids[0]);
        expect(multi.entries.map(e => e.id)).toEqual(ids.slice(1));
        expect(multi.activeId).toBe(ids[1]);
        await waitUntil(() => !managers.get(ids[0])!.state.connected, 15000, 250, 'removed robot disconnected');
      } finally {
        for (const m of managers.values()) { await m.disconnect().catch(() => undefined); }
      }
    });
  }

  // ─── The factories ────────────────────────────────────────────────────────

  it('createClient returns the protocol client of the generation, and refuses requests once disconnected', async () => {
    await freeRw6Slot(ctx);
    const client = await ctx.newClient();
    expect(client).toBeInstanceOf(ctx.generation === 'rws1' ? RwsClient : RwsClient2);
    const info = await client.getSystemInfo();
    expect(info.rwVersion).toBe(ctx.rwVersion);
    expect(info.name).toBe(ctx.systemName);

    const before = mark(ctx, 'client disconnect');
    await ctx.release(client);
    const after = mark(ctx, 'client request after disconnect');
    const err = await expectRwsError(() => client.getSystemInfo());
    expect(err.code).toBe('NOT_CONNECTED');
    const end = mark(ctx, 'client end');

    // The disconnect logged the session out; the later request sent nothing,
    // so no new session was signed in behind the caller's back.
    const logouts = httpOf(traceAfter(ctx, before, after), 'http.res').filter(r => r.path === '/logout');
    expect(logouts.map(r => r.status)).toEqual([204]);
    expect(httpOf(traceAfter(ctx, after, end), 'http.req')).toEqual([]);
  });

  it('createAdapter returns the adapter of the generation, logged in', async () => {
    await freeRw6Slot(ctx);
    const adapter = await ctx.newAdapter();
    expect(adapter).toBeInstanceOf(ctx.generation === 'rws1' ? RWS1Adapter : RWS2Adapter);
    const info = await adapter.getSystemInfo();
    expect(info.rwVersion).toBe(ctx.rwVersion);
    expect(info.name).toBe(ctx.systemName);
    expect(CONTROLLER_STATES).toContain(await adapter.getControllerState());
    expect(OPERATION_MODES).toContain(await adapter.getOperationMode());
    await ctx.release(adapter);
  });

  it('createAdapter given a port and no scheme finds the scheme', async () => {
    // A port the known-port table lists with one scheme uses it; port 80 and
    // a port the table does not list (a VC's reassigned port) are tried over
    // HTTPS and HTTP, so every controller here connects without `https`.
    await freeRw6Slot(ctx);
    const scheme = schemeForPort(ctx.port);
    ctx.note('scheme the port table names', { port: ctx.port, scheme });
    if (scheme !== 'either') { expect(scheme === 'https').toBe(ctx.https); }
    const adapter = await ctx.newAdapter({ https: undefined });
    expect(adapter).toBeInstanceOf(ctx.generation === 'rws1' ? RWS1Adapter : RWS2Adapter);
    expect((await adapter.getSystemInfo()).rwVersion).toBe(ctx.rwVersion);
    await ctx.release(adapter);
  });

  // ─── Refused logins ───────────────────────────────────────────────────────
  //
  // At most two wrong passwords for the test account per lane and run: the
  // OmniCore pendant locks an account after more than five, and whether RWS
  // logins count towards that is not known.

  it('createAdapter with a wrong password is refused AUTH_FAILED, naming host, port and user but never the password', async () => {
    await ctx.connectedManager()?.disconnect();
    const wrong = 'ZZ_PROBE-not-the-password';
    const err = await expectRwsError(() => createAdapter({
      host: HOST, port: ctx.port, https: ctx.https, username: TEST_USER, password: wrong, timeout: 8000,
    }));
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.httpStatus).toBe(401);
    expect(err.message).toContain(`${HOST}:${ctx.port}`);
    expect(err.message).toContain(`'${TEST_USER}'`);
    expect(err.message).toContain('does not try another account');
    expect(err.message).not.toContain(wrong);
    expect(err.message).not.toContain(TEST_PASS);
  });

  it('createClient as an account that does not exist is refused AUTH_FAILED with one login attempt, no other account tried', async () => {
    await ctx.connectedManager()?.disconnect();
    const user = 'ZZ_PROBE_no_such_user';
    const start = mark(ctx, 'unknown account login');
    const err = await expectRwsError(() => createClient({
      host: HOST, port: ctx.port, https: ctx.https, username: user, password: TEST_PASS, timeout: 8000,
    }));
    const end = mark(ctx, 'unknown account login done');
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.message).toContain(`'${user}'`);

    // With the test account's own password, a switch to that account would
    // have succeeded; one request, answered 401, and no success shows none
    // was tried.
    const lines = traceAfter(ctx, start, end);
    expect(httpOf(lines, 'http.req')).toHaveLength(1);
    expect(httpOf(lines, 'http.res').filter(r => (r.status ?? 0) >= 200 && (r.status ?? 0) < 300)).toEqual([]);
    expect([...httpOf(lines, 'http.err'), ...httpOf(lines, 'http.res')].some(r => r.status === 401 || /401/.test(r.msg))).toBe(true);
  });

  it('RobotManager.connect with a wrong password rejects AUTH_FAILED and stays disconnected', async () => {
    await ctx.connectedManager()?.disconnect();
    const m = new RobotManager();
    try {
      const err = await expectRwsError(() => m.connect(HOST, TEST_USER, 'ZZ_PROBE-not-the-password', ctx.port, ctx.https));
      expect(err.code).toBe('AUTH_FAILED');
      expect(m.state.connected).toBe(false);
      expect(m.state.quality).toBe('disconnected');
      expect(m.state.qualityReason).toMatch(/^connect failed/);
      expect(m.state.systemInfo).toBeNull();
    } finally {
      await m.disconnect().catch(() => undefined);
    }
  });

  // ─── Disconnect and reconnect ─────────────────────────────────────────────

  it('disconnect sends GET /logout and clears the state; a second disconnect sends nothing; a reconnect works', async () => {
    const m = await ctx.ensureManager();
    await waitUntil(() => !!m.state.systemInfo, 20000, 250, 'system info before disconnect');

    const start = mark(ctx, 'manager disconnect');
    await m.disconnect();
    const second = mark(ctx, 'manager second disconnect');
    await m.disconnect();
    const end = mark(ctx, 'manager disconnect done');

    // Live-verified 2026-09-30 on RW 6.16.03, 7.21.4 and 8.2.1: /logout answers 204.
    const first = traceAfter(ctx, start, second);
    expect(httpOf(first, 'http.req').filter(r => r.path === '/logout')).toHaveLength(1);
    expect(httpOf(first, 'http.res').filter(r => r.path === '/logout').map(r => r.status)).toEqual([204]);
    expect(httpOf(traceAfter(ctx, second, end), 'http.req').filter(r => r.path === '/logout')).toEqual([]);

    const s = m.state;
    expect(s.connected).toBe(false);
    expect(s.quality).toBe('disconnected');
    expect(s.systemInfo).toBeNull();
    expect(s.identity).toBeNull();
    expect(s.opmode).toBeNull();
    expect(s.tasks).toEqual([]);
    expect(s.access.locks).toEqual([]);

    const again = await ctx.reconnect();
    expect(again).toBe(m);
    expect(m.state.connected).toBe(true);
    await waitUntil(() => m.state.systemInfo?.rwVersion === ctx.rwVersion, 20000, 250, 'system info after reconnect');
    const panel = await ctx.panel();
    const settled = await waitFor(() => m.state.opmode === panel.opmode && m.state.ctrlstate === panel.ctrlstate, 15000);
    expect(settled).toBe(true);
  });
});
