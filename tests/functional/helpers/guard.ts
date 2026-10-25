/**
 * The safety model of the functional suite, in one place.
 *
 * These are virtual controllers, so motion, motors and RAPID are exercised,
 * but inside fixed limits: small joint moves relative to where the robot is,
 * slow, speed ratio at 50 or less, one-axis jogs in the smallest increment,
 * and a short list of operations that are never sent. A test asks
 * `allowed(kind, lane)` (or the context's `requireAllowed`, which skips with
 * the reason) before it does anything in these classes.
 *
 * Test infrastructure only - never shipped in the package.
 */

import type { JogParams } from '../../../src/index.js';
import { NEVER_RESTART } from '../../helpers/restartPolicy.js';
import { manualLanes, motionControlSystem, restartLanes, type Lane } from './config.js';

export type GuardKind =
  // Allowed where the lane supports it
  | 'motion'            // RAPID motion through the ZZ_PROBE motion module
  | 'motors'            // motors on (and off) over RWS
  | 'motors-refusal'    // one motors-on attempt that asserts the RobotWare 8 refusal
  | 'rapid-start'       // start RAPID
  | 'opmode'            // switch to a manual mode (restore puts Auto back)
  | 'manual-mode'       // manual reduced speed for a jog or a program move, opt-in per lane (RWS_FUNCTIONAL_ALLOW_MANUAL)
  | 'rmmp-manual'       // one RMMP request in MANR under the manual opt-in (RobotWare 7 only), cancelled afterwards
  | 'motion-control'    // RobotWare 8: the suite's station allows motion control for a RAPID start, opt-in per controller (RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<system name>)
  | 'vc-sim'            // the virtual controller's simulated panel (enable switch, stops) and the mechanical-unit teleport
  | 'restart'           // warm restart
  | 'backup'            // create a ZZ_PROBE backup (never restore one)
  | 'dipc'              // ZZ_PROBE DIPC queues
  | 'signal-simulate'   // simulate an I/O signal
  // Never sent; listed so a test can ask and report the reason
  | 'backup-restore'
  | 'cfg-write'
  | 'cfg-load'
  | 'uas-write'
  | 'rmmp-request'
  | 'safety-write'
  | 'mastership-watchdog'
  | 'diagnostics-save';

/** Live facts some decisions need (read them first; `requireAllowed` does). */
export interface GuardFacts {
  /** The controller state, e.g. `motoron`, `motoroff`, `guardstop`. */
  ctrlstate?: string | null;
  /**
   * The controller identifies itself as a virtual controller (`vc-sim`):
   * true only when its identity type reads virtual; null when unread.
   */
  virtual?: boolean | null;
  /** The identity type as read (`VIRTUAL_CONTROLLER`, ...), for the reason text. */
  identityType?: string | null;
  /** The controller's system name, read from /rw/system (`motion-control`); null when unread. */
  systemName?: string | null;
}

/** Is an identity type (`ControllerIdentity.type`) a virtual controller's? Real or unknown is not. */
export function isVirtualIdentity(type: string | null | undefined): boolean {
  const t = (type ?? '').trim();
  return /virtual/i.test(t) && !/real/i.test(t);
}

export interface GuardDecision {
  ok: boolean;
  /** Why it is allowed (and on what condition), or why not. Used as the skip reason. */
  reason: string;
}

/** Motion limits, relative to the joints the robot is at when the move starts. */
export const MOTION_LIMITS = {
  /** Largest move of axis 1, degrees. */
  axis1MaxDeg: 5,
  /** Largest move of axes 4 and 6, degrees. */
  wristMaxDeg: 10,
  /** Speed data allowed in generated moves, slowest first; v100 is the ceiling. */
  speeds: ['v5', 'v10', 'v20', 'v30', 'v40', 'v50', 'v60', 'v80', 'v100'] as const,
  /** Highest speed ratio (percent) while anything moves. */
  maxSpeedRatio: 50,
  /** Largest jog value on the one axis a jog moves. */
  jogMaxValue: 100,
  /** Most loops a generated motion module may run. */
  maxLoops: 20,
} as const;

// The lanes never restarted, whatever RWS_FUNCTIONAL_ALLOW_RESTART lists, are
// the shared list in tests/helpers/restartPolicy.ts (NEVER_RESTART), which the
// live suites and the warm-restart structural cell honour too.

const NEVER: Readonly<Partial<Record<GuardKind, string>>> = {
  'backup-restore': 'backup restore is never sent by the functional suite',
  'cfg-write': 'configuration writes are never sent by the functional suite',
  'cfg-load': 'configuration load is never sent by the functional suite',
  'uas-write': 'UAS writes are never sent by the functional suite (the client has no UAS administration write)',
  'rmmp-request': 'RMMP is read only outside the manual-mode jog test, which makes its one request under kind rmmp-manual '
    + '(RobotWare 7, RWS_FUNCTIONAL_ALLOW_MANUAL); a grant may need a person at the pendant',
  'safety-write': 'safety configuration is never written by the functional suite',
  'mastership-watchdog': 'the mastership watchdog is never exercised by the functional suite',
  'diagnostics-save': 'diagnostics save is never sent by the functional suite',
};

function motorsOnNeededOnRw8(facts: GuardFacts): GuardDecision {
  if (facts.ctrlstate === 'motoron') {
    return { ok: true, reason: 'motors are already on (RW8 motors on is a pendant action, not an RWS one)' };
  }
  return { ok: false, reason: 'needs motors on from the RW8 pendant' };
}

/**
 * May `kind` run on `lane`? Pure: facts a decision depends on (the RW8 motors
 * state for motion and RAPID start) come in `facts`; without them the answer
 * is the cautious one.
 */
export function allowed(kind: GuardKind, lane: Lane, facts: GuardFacts = {}): GuardDecision {
  const never = NEVER[kind];
  if (never) { return { ok: false, reason: never }; }

  switch (kind) {
    case 'motion':
    case 'rapid-start':
      if (lane === 'rw8') { return motorsOnNeededOnRw8(facts); }
      return { ok: true, reason: 'RW6/RW7 virtual controller; motors may be switched on first (kind motors)' };

    case 'motors':
      if (lane === 'rw8') {
        return { ok: false, reason: 'RobotWare 8 refuses motors on over RWS (the pendant switches them on); assert that refusal under motors-refusal instead' };
      }
      return { ok: true, reason: 'motors on and off over RWS in Auto on a virtual controller; restore puts the baseline back' };

    case 'motors-refusal':
      if (lane === 'rw8') { return { ok: true, reason: 'one motors-on request whose refusal is asserted' }; }
      return { ok: false, reason: 'RobotWare 6 and 7 accept motors on over RWS in Auto, so there is no refusal to assert' };

    case 'opmode':
      if (lane === 'rw8') {
        return {
          ok: false,
          reason: 'RobotWare 8 changes the operating mode only for a station holding write access, which a remote station keeps in a manual mode only '
            + 'with the RobotWare 8.2 grant "Allow remote access in manual mode" (UAS_ALLOW_REMOTE_ACCESS_IN_MAN_MODE); and the switch back to Auto '
            + 'then waits in AUTO_CH for a confirmation at the FlexPendant, during which no remote station can take write access (RW 8.2.1, '
            + '2026-09-30). RW8 goes to a manual mode only in the manual-mode tests (kind manual-mode), which read that grant first, skip without it, '
            + 'and wait for the confirmation from the person at the pendant',
        };
      }
      return {
        ok: true,
        reason: 'manual mode for the test only; restore switches back to Auto (a switch to Auto may wait for the pendant confirmation, AUTO_CH on '
          + 'RW 7.21.4; restore reports it and never sends the switch again)',
      };

    case 'restart': {
      const hard = NEVER_RESTART[lane];
      if (hard) { return { ok: false, reason: hard }; }
      if (!restartLanes().includes(lane)) {
        return { ok: false, reason: `restart is not enabled for ${lane} (set RWS_FUNCTIONAL_ALLOW_RESTART=${lane})` };
      }
      return { ok: true, reason: `RWS_FUNCTIONAL_ALLOW_RESTART lists ${lane}; ports may move, rediscover after it` };
    }

    case 'backup':
      return { ok: true, reason: 'create only, named ZZ_PROBE...; the test deletes it and a backup is never restored' };

    case 'dipc':
      return { ok: true, reason: 'queues named ZZ_PROBE...; restore removes leftovers' };

    case 'signal-simulate':
      return { ok: true, reason: 'the test registers the undo (ctx.defer) for the value and the simulation state' };

    case 'manual-mode':
      if (!manualLanes().includes(lane)) {
        return {
          ok: false,
          reason: `manual mode is opt-in: the switch back to Auto waits for a FlexPendant confirmation (AUTO_CH on RW 7.21.4 and 8.2.1); `
            + `set RWS_FUNCTIONAL_ALLOW_MANUAL=${lane} with someone at the pendant`,
        };
      }
      if (lane === 'rw8') {
        return {
          ok: true,
          reason: 'RWS_FUNCTIONAL_ALLOW_MANUAL lists rw8, so someone is at the virtual FlexPendant: RobotWare 8.2 lets a remote control station take '
            + 'write access in manual mode (grant "Allow remote access in manual mode", read first; the test skips without it), the virtual enable '
            + 'switch is the enabling device, the person there has its emergency stop and stop within reach, which the suite\'s station declares '
            + 'for the test (allow-motion-control, put back before the switch back to Auto), and confirms the switch back to Auto there (it waits '
            + 'in AUTO_CH, RW 8.2.1, 2026-09-30; the test waits for it); back in Auto the controller waits in guard stop for a Reset',
        };
      }
      return {
        ok: true,
        reason: `RWS_FUNCTIONAL_ALLOW_MANUAL lists ${lane}, so someone is at the virtual FlexPendant: manual reduced speed for the test, the `
          + 'virtual enable switch as the enabling device on RWS 2.0; the test switches back to Auto and waits for the confirmation at the pendant '
          + '(AUTO_CH on RW 7.21.4, 2026-09-30)',
      };

    case 'rmmp-manual':
      if (lane === 'rw8') { return { ok: false, reason: 'RobotWare 8 has no RMMP; a remote station takes write access instead' }; }
      if (lane === 'rw6') {
        return { ok: false, reason: 'the RWS 1.0 lane never requests RMMP: its manual-mode test records the jog refusals (no enable-switch endpoint there)' };
      }
      if (!manualLanes().includes(lane)) {
        return { ok: false, reason: `an RMMP request belongs to the manual-mode test; set RWS_FUNCTIONAL_ALLOW_MANUAL=${lane} with someone at the pendant` };
      }
      return {
        ok: true,
        reason: 'one RMMP request in manual reduced speed, cancelled after the test; the operator at the FlexPendant grants it within 30 s, 90 s in a pendant session (the '
          + 'RW 7.21.4 virtual controller does not grant it by itself: the request waits, and expires; 2026-09-30)',
      };

    case 'motion-control': {
      if (lane !== 'rw8') {
        return { ok: false, reason: 'RobotWare 6 and 7 have no control stations, so there is no motion control to allow' };
      }
      const named = motionControlSystem();
      const ask = 'RobotWare 8 refuses a RAPID start from a remote station until motion control is allowed, the station\'s confirmation '
        + 'that an emergency stop and a normal stop are within reach; the suite allows it only on a person\'s word for one controller: set '
        + 'RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<its system name, as /rw/system reads it> when someone at its virtual FlexPendant has checked that';
      if (named === null) { return { ok: false, reason: ask }; }
      if (!facts.systemName || facts.systemName !== named) {
        return {
          ok: false,
          reason: `RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL names '${named}', and this controller's system name reads `
            + `${facts.systemName ? `'${facts.systemName}'` : 'as not read'}; the opt-in counts for the controller it names only. ${ask}`,
        };
      }
      if (facts.virtual !== true) {
        return {
          ok: false,
          reason: `the controller does not identify as a virtual controller (identity type ${facts.identityType ?? 'not read'}); `
            + 'the suite allows motion control on virtual controllers only',
        };
      }
      return {
        ok: true,
        reason: `RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL names '${named}', a virtual RobotWare 8 controller, so a person at its virtual FlexPendant `
          + 'has its emergency stop and normal stop within reach: the suite\'s station allows motion control in the manager\'s own session before '
          + 'the start; the lane\'s deferred step withdraws it, and so does the client as the first request of every disconnect',
      };
    }

    case 'vc-sim':
      if (lane === 'rw6') { return { ok: false, reason: 'RWS 1.0 has no simulation endpoints' }; }
      if (facts.virtual !== true) {
        return {
          ok: false,
          reason: `the controller does not identify as a virtual controller (identity type ${facts.identityType ?? 'not read'}); `
            + 'the simulation endpoints are sent to virtual controllers only',
        };
      }
      return {
        ok: true,
        reason: `RWS 2.0 virtual controller (identity type ${facts.identityType}): the simulated panel and the teleport stand in for a person's hands; `
          + 'the test releases what it engages',
      };

    default:
      return { ok: false, reason: `unknown guard kind ${String(kind)}` };
  }
}

/**
 * Is this jog inside the limits? Joint mode, exactly one axis non-zero, the
 * smallest increment (`Small`, the client's default) and a value within
 * `MOTION_LIMITS.jogMaxValue`.
 */
export function checkJog(params: JogParams): GuardDecision {
  if (params.mode !== 'Joint') { return { ok: false, reason: 'only Joint jogs are allowed (never Cartesian)' }; }
  const moving = params.axes.map((v, i) => [i + 1, v] as const).filter(([, v]) => v !== 0);
  if (moving.length !== 1) { return { ok: false, reason: `exactly one axis may jog, got ${moving.length}` }; }
  const inc = params.incMode ?? 'Small';
  if (inc !== 'Small') { return { ok: false, reason: `only the Small increment is allowed, got ${inc}` }; }
  const [axis, value] = moving[0];
  if (!Number.isFinite(value) || Math.abs(value) > MOTION_LIMITS.jogMaxValue) {
    return { ok: false, reason: `jog value ${value} on axis ${axis} is above ${MOTION_LIMITS.jogMaxValue}` };
  }
  return { ok: true, reason: `axis ${axis}, value ${value}, Small increment` };
}

/** Throw unless `checkJog(params)` allows it. */
export function assertSafeJog(params: JogParams): void {
  const d = checkJog(params);
  if (!d.ok) { throw new Error(`unsafe jog refused by the functional guard: ${d.reason}`); }
}
