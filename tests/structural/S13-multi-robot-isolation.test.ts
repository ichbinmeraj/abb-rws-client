/**
 * S13 - Multi-robot fault isolation.
 *
 * A fleet host (the VS Code extension is one) holds many RobotManagers inside a
 * single MultiRobotManager and shows one of them at a time. The failure this
 * cell exists to catch is contamination: one robot losing its network and the
 * OTHER robots' rows going grey, stale or empty with it. Nothing in the client
 * is supposed to be shared between managers - no static adapter state, no
 * process-wide quality, no shared subscriber - and this is where that is proven
 * rather than assumed.
 *
 * Three properties, one setup:
 *   - one manager's failure never changes another's state - cut BOTH ways, the
 *     active robot breaking and a background robot breaking, because the broken
 *     manager is the one running the reconnect/teardown path and the two halves
 *     therefore exercise different code;
 *   - quality is PER ROBOT, not global (the facade projects the ACTIVE robot,
 *     and two robots can legitimately report different qualities at the same
 *     instant);
 *   - change notifications say WHICH robot changed - `onRobotChanged(id)` - so a
 *     fleet UI can repaint one row instead of diffing every robot.
 *
 * Each robot gets its OWN chaos proxy, so a fault is aimed at exactly one
 * member of the fleet: cutting the shared controller instead would break
 * everybody and prove nothing.
 *
 * The rws2 cell additionally runs a genuinely MIXED fleet - the live IRC5/RW6
 * and the live OmniCore/RW7 in one MultiRobotManager - and breaks each in turn.
 * That direction matters because the two generations run different code
 * (RWS1Adapter over RwsClient vs RWS2Adapter over RwsClient2) and share exactly
 * two things: this process, and the on-disk session-cookie file.
 *
 * Consumer convention note: hosts call methods on `multi.active`, never on
 * `multi`. These tests deliberately reach the per-robot managers through
 * `multi.entries` because the whole point is to observe the NON-active robot -
 * something a consumer could never do through `multi.active` alone.
 */

import { it, expect, afterEach } from 'vitest';
import { startChaosProxy, type ChaosProxy } from '../helpers/chaosProxy.js';
import {
  discoverControllers, TEST_USER, TEST_PASS, type LiveController,
} from '../helpers/liveControllers.js';
import { MultiRobotManager } from '../../src/MultiRobotManager.js';
import type { RobotManager, RobotState } from '../../src/RobotManager.js';
import type { ConnectionQuality } from '../../src/types.js';
import { cell, until, assertQualityHonest } from '../helpers/structuralHarness.js';

const ROBOT_A = 'robot-a';
const ROBOT_B = 'robot-b';

/**
 * Slower than the other cells' 250-500 ms on purpose. A RobotManager poll cycle
 * is ~9 requests and the managers do NOT share a request queue - only the 55 ms
 * pacing inside each client - so two managers aimed at one VC at 400 ms would
 * push the aggregate past the controller's <20 req/s ceiling and turn this cell
 * into an accidental S10. At 1.5 s each fleet stays around 12 req/s worst case
 * (and 5x slower again while subscriptions are up).
 */
const FLEET_REFRESH_MS = 1500;

/** How long the broken robot is given to leave live/polling. */
const DEGRADE_BUDGET_MS = 60000;

/** How long the untouched robot is watched while its neighbour stays broken. */
const ISOLATION_WINDOW_MS = 5000;

/** How long a freshly connected robot is given to settle. */
const STEADY_BUDGET_MS = 60000;

const steady = (m: RobotManager): boolean =>
  m.state.quality === 'live' || m.state.quality === 'polling';

interface FleetMember {
  id: string;
  proxy: ChaosProxy;
  manager: RobotManager;
}

/**
 * The slice of RobotState that must be BYTE-identical across a neighbour's
 * outage.
 *
 * Deliberately excludes execstate/joints/cartesian/speedRatio/eventLog: the user
 * keeps these VCs running, so a program that is already executing legitimately
 * moves those fields, and asserting on them would make this cell fail on
 * controller activity instead of on cross-talk. What is left is identity that
 * cannot change without something being wrong.
 */
interface StateFingerprint {
  connected: boolean;
  host: string;
  identity: string;
  systemInfo: string;
  mechunits: string;
  taskNames: string;
}

function fingerprint(s: RobotState): StateFingerprint {
  return {
    connected: s.connected,
    host: s.host,
    identity: JSON.stringify(s.identity),
    systemInfo: JSON.stringify(s.systemInfo),
    mechunits: JSON.stringify(s.mechunits),
    taskNames: JSON.stringify(s.tasks.map(t => t.name)),
  };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

const open: Array<{ proxy?: ChaosProxy; manager?: RobotManager }> = [];
afterEach(async () => {
  const entries = open.splice(0);
  // Heal every proxy BEFORE disconnecting. A disconnect through a refusing proxy
  // cannot put GET /logout on the wire, and a session nobody logs out sits in
  // the controller's pool until it times out - on this rig that pool is the
  // scarce resource (~200 careless requests once wedged a VC permanently).
  for (const o of entries) {
    o.proxy?.refuseNew(false);
    o.proxy?.setCorruption({ kind: 'none' });
  }
  for (const o of entries) {
    await o.manager?.disconnect().catch(() => undefined);
  }
  for (const o of entries) {
    await o.proxy?.close();
  }
}, 120000);

// ─── Fleet construction ──────────────────────────────────────────────────────

/**
 * Add one robot to `multi`, routed through a chaos proxy of its own, and connect
 * it. The proxy is what makes per-robot fault injection possible at all: the
 * fleet members here often share a controller, so a fault has to be injected on
 * the path, not on the target.
 */
async function joinFleet(
  multi: MultiRobotManager, id: string, controller: LiveController,
): Promise<FleetMember> {
  const proxy = await startChaosProxy(controller.host, controller.port);
  // Registered before ANYTHING that can throw, so afterEach still closes the
  // listener (and later logs the session out) when setup fails half-way.
  const slot: { proxy?: ChaosProxy; manager?: RobotManager } = { proxy };
  open.push(slot);

  multi.addRobot({
    id, name: id, host: '127.0.0.1', port: proxy.port,
    useHttps: controller.tls, username: TEST_USER, password: TEST_PASS,
  });
  const entry = multi.entries.find(e => e.id === id);
  if (!entry) { throw new Error(`addRobot did not register ${id}`); }
  const manager = entry.manager;
  slot.manager = manager;

  await multi.connectRobot(id);

  // Everything below assumes traffic really goes THROUGH this proxy. If the
  // pinned port had not answered, RobotManager falls back to a wide localhost
  // scan (1024-30000) and can connect straight to the VC - the fault injection
  // would then be aimed at a path nobody is using, and the cell would pass by
  // testing nothing.
  expect(manager.currentPort, `${id} did not connect through its own chaos proxy`)
    .toBe(proxy.port);
  return { id, proxy, manager };
}

/**
 * Break `broken` and prove `intact` did not notice.
 *
 * refuseNew + dropAll together, never dropAll alone: dropping the live sockets
 * of a proxy that still forwards just makes the client open a fresh connection,
 * so the fault would heal itself before the neighbour could possibly be
 * affected by it. Blocking the port first is what makes the outage last.
 *
 * Leaves `broken`'s proxy STILL REFUSING. Healing here would let the broken
 * robot's next poll succeed and race the caller's own assertions about it; the
 * caller heals once it is done reading that robot's degraded state.
 */
async function assertIsolated(broken: FleetMember, intact: FleetMember): Promise<void> {
  const before = fingerprint(intact.manager.state);
  const qualityBefore = intact.manager.state.quality;

  broken.proxy.refuseNew(true);
  broken.proxy.dropAll();

  await until(() => !steady(broken.manager), DEGRADE_BUDGET_MS,
    `${broken.id} degrades once its transport is cut`);

  // One transition is not isolation. Watch the neighbour for as long as the
  // outage lasts - contamination through a shared timer or a shared agent shows
  // up as a late blip, not on the first sample.
  const seen = new Set<ConnectionQuality>();
  const deadline = Date.now() + ISOLATION_WINDOW_MS;
  while (Date.now() < deadline) {
    seen.add(intact.manager.state.quality);
    expect(
      intact.manager.state.connected,
      `${intact.id} reported disconnected while only ${broken.id} was broken`,
    ).toBe(true);
    await new Promise(r => setTimeout(r, 100));
  }
  expect(
    [...seen].filter(q => q !== 'live' && q !== 'polling'),
    `${intact.id} left live/polling while only ${broken.id}'s transport was cut`,
  ).toEqual([]);

  // The claim is not just "quality still says live" - a real round trip has to
  // still work. RobotManager exposes no getControllerState (state arrives via
  // polling), so the clock read is the cheapest genuine request.
  await expect(intact.manager.getControllerClock()).resolves.toBeTruthy();

  expect(
    fingerprint(intact.manager.state),
    `${intact.id}'s state changed while ${broken.id} was broken`,
  ).toEqual(before);

  // Exact equality, not "still one of live/polling": a live->polling flip here
  // would mean the neighbour's WebSocket died when a DIFFERENT robot's socket
  // was dropped, which is precisely the shared-subscriber bug this cell hunts.
  expect(
    intact.manager.state.quality,
    `${intact.id}'s quality moved ${qualityBefore} -> ${intact.manager.state.quality} `
    + `while only ${broken.id} was broken`,
  ).toBe(qualityBefore);

  // Two robots, two different qualities, same instant - quality cannot be global.
  expect(
    broken.manager.state.quality,
    'both robots report the same quality - it is not being tracked per robot',
  ).not.toBe(intact.manager.state.quality);

  // S14 cross-cutting: neither robot may lie about what it can see.
  assertQualityHonest(broken.manager, { notLive: true });
  assertQualityHonest(intact.manager, { notDisconnected: true });
}

/**
 * Heal `m`'s proxy and bring the robot back through it.
 *
 * Reconnecting matters for more than the next assertion. A manager that
 * auto-disconnected after 3 failed polls has already torn down its adapter, so
 * afterEach can no longer put GET /logout on the wire - the controller session
 * would sit in the pool until it timed out. Reconnecting re-adopts the saved
 * session for this host:port, so the final disconnect frees the slot.
 */
async function revive(multi: MultiRobotManager, m: FleetMember): Promise<void> {
  m.proxy.refuseNew(false);
  m.proxy.setCorruption({ kind: 'none' });
  await multi.connectRobot(m.id);
  await until(() => steady(m.manager), STEADY_BUDGET_MS,
    `${m.id} returns to a steady quality through its healed proxy`);
  // Same trap as in joinFleet: a failed reconnect on the pinned port sends
  // RobotManager off scanning localhost, where it can find the VC directly and
  // leave every later fault aimed at a path nobody uses.
  expect(m.manager.currentPort, `${m.id} reconnected around its chaos proxy`)
    .toBe(m.proxy.port);
}

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S13-multi-robot-isolation', generation, ctx => {
    it('breaking one robot leaves its neighbour connected, live and byte-identical', async () => {
      const controller = await ctx.controller();
      const multi = new MultiRobotManager({ refreshIntervalMs: FLEET_REFRESH_MS });

      const changed: string[] = [];
      multi.onRobotChanged(id => { changed.push(id); });

      const a = await joinFleet(multi, ROBOT_A, controller);
      const b = await joinFleet(multi, ROBOT_B, controller);

      await until(() => steady(a.manager) && steady(b.manager), STEADY_BUDGET_MS,
        'both robots reach a steady quality');

      // A was added first, so it is and stays the active robot. Direction 1
      // therefore observes a NON-active neighbour (B) surviving the active
      // robot's outage; direction 2 further down inverts that, which is the
      // case a fleet UI actually gets wrong.
      expect(multi.activeId).toBe(ROBOT_A);

      // ── direction 1: the ACTIVE robot breaks, its neighbour must not care ──
      const mark = changed.length;
      await assertIsolated(a, b);

      // ── quality is per-robot, not global ──────────────────────────────────
      // Two managers, two different answers, same instant. This is the
      // discriminating evidence: a process-wide quality could not produce it.
      expect(
        a.manager.state.quality,
        'both robots report the same quality - it is not tracked per robot',
      ).not.toBe(b.manager.state.quality);

      // `multi.state` must hand back the ACTIVE manager's own state OBJECT.
      // Reference identity is the sharpest form of that claim, and unlike
      // comparing a captured quality string it cannot flake while A is still
      // walking stale -> disconnected underneath us. If setActive were a no-op
      // (or the facade cached a state), these would be B's object both times.
      multi.setActive(ROBOT_B);
      expect(multi.activeId).toBe(ROBOT_B);
      expect(multi.state, 'the facade did not project the newly active robot')
        .toBe(b.manager.state);
      expect(multi.state.qualityReason).toBe(b.manager.state.qualityReason);
      expect(steady(b.manager), 'the untouched robot is not steady').toBe(true);

      multi.setActive(ROBOT_A);
      expect(multi.activeId).toBe(ROBOT_A);
      expect(multi.state, 'the facade did not project the newly active robot')
        .toBe(a.manager.state);
      expect(steady(a.manager), 'the broken robot still reports a steady quality').toBe(false);

      // ── the notification names the robot that broke ───────────────────────
      // A fleet UI has to be able to grey out the ONE row that failed; a bare
      // "something changed" would force it to re-read every robot.
      const duringFaultA = changed.slice(mark);
      expect(duringFaultA, 'no change notification named the robot that broke')
        .toContain(ROBOT_A);
      expect(
        [...new Set(duringFaultA)].filter(id => id !== ROBOT_A && id !== ROBOT_B),
        'a change notification carried an id belonging to no robot in the fleet',
      ).toEqual([]);

      // ── direction 2: a NON-ACTIVE robot breaks, the active one must not ────
      // Direction 1 alone proves the easy half. The case a fleet host actually
      // ships into is a background robot dying while the user is looking at a
      // different one, and the shared surfaces are not symmetric (the broken
      // manager is the one running the reconnect/teardown path), so the reverse
      // has to be exercised rather than inferred.
      await revive(multi, a);
      multi.setActive(ROBOT_A);
      expect(multi.activeId, 'A is no longer the active robot').toBe(ROBOT_A);

      const markB = changed.length;
      await assertIsolated(b, a);
      const duringFaultB = changed.slice(markB);
      expect(duringFaultB, 'no change notification named the non-active robot that broke')
        .toContain(ROBOT_B);
      expect(
        [...new Set(duringFaultB)].filter(id => id !== ROBOT_A && id !== ROBOT_B),
        'a change notification carried an id belonging to no robot in the fleet',
      ).toEqual([]);

      // The active robot is still the one being displayed, and still healthy.
      expect(multi.activeId).toBe(ROBOT_A);
      expect(multi.state, 'the facade stopped projecting the active robot').toBe(a.manager.state);
      expect(steady(a.manager), 'the active robot degraded when a background robot died')
        .toBe(true);

      // Heal last, once nothing else reads B's degraded state, and bring it
      // back so afterEach can log its session out instead of leaking the slot.
      await revive(multi, b);
    }, 420000);

    it('change notifications name the robot that changed, not the active one', async () => {
      const controller = await ctx.controller();
      const multi = new MultiRobotManager({ refreshIntervalMs: FLEET_REFRESH_MS });

      const changed: string[] = [];
      let zeroArgCalls = 0;
      multi.onRobotChanged(id => { changed.push(id); });
      multi.onDidChange(() => { zeroArgCalls++; });

      const a = await joinFleet(multi, ROBOT_A, controller);
      // addRobot notifies synchronously, so the very first id ever emitted is
      // the one it was handed - no polling involved, nothing to race.
      expect(changed[0], 'addRobot did not notify with the new robot\'s id').toBe(ROBOT_A);

      const b = await joinFleet(multi, ROBOT_B, controller);
      await until(() => steady(a.manager) && steady(b.manager), STEADY_BUDGET_MS,
        'both robots reach a steady quality');
      expect(multi.activeId).toBe(ROBOT_A);

      // Force a state change on the NON-active robot only. An implementation
      // that reported `activeId` (or a single hard-wired id) instead of the
      // robot that actually changed could never emit ROBOT_B here.
      let mark = changed.length;
      let zeroArgMark = zeroArgCalls;
      await b.manager.refresh();
      await until(() => changed.slice(mark).includes(ROBOT_B), 20000,
        'a notification named the non-active robot that changed');
      // The per-robot channel is ADDITIVE, so the zero-arg onDidChange every
      // existing consumer relies on must have fired for this same change.
      // Counting from a mark, not from zero: `> 0` overall would already be
      // satisfied by the addRobot call above and would stay green even if
      // onDidChange had stopped firing on state changes entirely.
      expect(
        zeroArgCalls - zeroArgMark,
        'the zero-arg onDidChange did not fire for a state change the per-robot channel reported',
      ).toBeGreaterThan(0);

      // …and the active robot still reports as itself, so the id is not simply
      // "whichever robot is not active" either.
      mark = changed.length;
      zeroArgMark = zeroArgCalls;
      await a.manager.refresh();
      await until(() => changed.slice(mark).includes(ROBOT_A), 20000,
        'a notification named the active robot that changed');
      expect(
        zeroArgCalls - zeroArgMark,
        'the zero-arg onDidChange did not fire for a state change the per-robot channel reported',
      ).toBeGreaterThan(0);

      expect(
        [...new Set(changed)].filter(id => id !== ROBOT_A && id !== ROBOT_B),
        'a change notification carried an id belonging to no robot in the fleet',
      ).toEqual([]);

      // Removal is a fleet change too, and it has to name the robot that left -
      // otherwise a UI cannot tell which row to drop.
      mark = changed.length;
      multi.removeRobot(ROBOT_B);
      expect(changed.slice(mark), 'removeRobot did not notify with the removed robot\'s id')
        .toContain(ROBOT_B);
    }, 120000);

    if (generation === 'rws2') {
      it('a mixed RW6 + RW7 fleet isolates in both directions', async t => {
        const all = await discoverControllers();
        const rw6 = all.find(c => c.generation === 'rws1');
        const rw7 = all.find(c => c.generation === 'rws2');
        // Both VCs must be up for this property to mean anything. Skipping
        // leaves it visibly unasserted; running it with two RW7s instead would
        // record a mixed-generation guarantee nobody proved.
        if (!rw6 || !rw7) { t.skip(); return; }

        const multi = new MultiRobotManager({ refreshIntervalMs: FLEET_REFRESH_MS });
        const six = await joinFleet(multi, 'rw6', rw6);
        const seven = await joinFleet(multi, 'rw7', rw7);

        await until(() => steady(six.manager) && steady(seven.manager), STEADY_BUDGET_MS,
          'both generations reach a steady quality');

        // Precondition for everything below: the fleet really is mixed.
        // `currentUseHttps` reports `adapter instanceof RWS2Adapter` - which
        // protocol generation the manager negotiated, not a URL-scheme guess.
        expect(six.manager.currentUseHttps, 'the RW6 member did not negotiate the RWS 1.0 adapter')
          .toBe(false);
        expect(seven.manager.currentUseHttps, 'the RW7 member did not negotiate the RWS 2.0 adapter')
          .toBe(true);
        // …confirmed against what the controllers say about themselves, so a
        // mis-detected adapter cannot masquerade as a mixed fleet.
        const rwMajor = (m: RobotManager): number =>
          Number(String(m.state.systemInfo?.rwVersion ?? '').split('.')[0]);
        expect(six.manager.state.systemInfo, 'RW6 member reported no system info').toBeTruthy();
        expect(seven.manager.state.systemInfo, 'RW7 member reported no system info').toBeTruthy();
        expect(rwMajor(six.manager), 'the RW6 member is not running RobotWare 6').toBe(6);
        expect(rwMajor(seven.manager), 'the RW7 member is not running RobotWare 7+')
          .toBeGreaterThanOrEqual(7);

        // Direction 1: the OmniCore goes down, the IRC5 must not notice.
        await assertIsolated(seven, six);

        // Bring the broken member back through its healed proxy before cutting
        // the other one - otherwise the second direction would only be asserting
        // that an already-dead robot stays dead.
        await revive(multi, seven);

        // Direction 2: the IRC5 goes down, the OmniCore must not notice. Both
        // directions are run because the shared surfaces are asymmetric - the
        // RWS 1.0 path writes the on-disk session-cookie file that the RWS 2.0
        // path also uses, so contamination is plausible either way.
        await assertIsolated(six, seven);

        // Heal and bring rw6 back so afterEach can log its session out. An
        // auto-disconnected manager has already dropped its adapter, and a
        // session nobody logs out holds a slot on the IRC5 until it times out.
        await revive(multi, six);
      }, 420000);
    }
  });
}
