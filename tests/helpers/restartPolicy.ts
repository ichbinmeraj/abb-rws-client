/**
 * The controllers the test suites never restart, in one place, with the
 * reasons.
 *
 * Every suite that can send a warm restart asks here first, whatever its own
 * opt-in says: the functional guard (tests/functional/helpers/guard.ts, opt-in
 * RWS_FUNCTIONAL_ALLOW_RESTART), the live subscriber suites (tests/live,
 * RWS_TEST_ALLOW_RESTART) and the warm-restart cell
 * (tests/structural/S03-warm-restart.test.ts, RWS_STRUCTURAL_ALLOW_RESTART).
 * The opt-in arms a restart; a lane on this list refuses it anyway.
 *
 * One tool outside the suites does restart a lane on the list, armed by a
 * person by name: see ATTENDED_RESTARTS.
 *
 * Test infrastructure only - never shipped in the package.
 */

import type { Generation } from './liveControllers.js';

/** One lane per RobotWare major: RWS 1.0 is RW6 only; RW7 and RW8 both speak RWS 2.0. */
export type RestartLane = 'rw6' | 'rw7' | 'rw8';

/** Lanes whose virtual controller is never restarted, whatever the environment says. */
export const NEVER_RESTART: Readonly<Partial<Record<RestartLane, string>>> = Object.freeze({
  rw6: 'the test suites never restart the RW6 virtual controller: it did not come back from a warm restart '
    + 'sent by the live subscriber suite on 2026-10-24, and was down until it was started again in RobotStudio',
  rw8: 'a restart resets the RW8 pendant\'s Remote Access, and remote write access is refused until someone '
    + 're-enables it at the pendant',
});

/**
 * The restarts of a listed lane that a tool outside the test suites sends,
 * each armed by a person naming the lane and run at the machine.
 *
 * `npm run functional:fixtures` (scripts/functional-fixtures.mjs) ends an rw6
 * apply or remove with a warm restart: the I/O configuration it loads or
 * deletes takes effect only after one, and the RW6 I/O write tests need it.
 * The script refuses every other lane on the list itself (rw8); an offline
 * test (restartPolicy.test.ts) checks that the script and this list agree.
 */
export const ATTENDED_RESTARTS: Readonly<Partial<Record<RestartLane, string>>> = Object.freeze({
  rw6: 'npm run functional:fixtures with RWS_FIXTURES_APPLY=1 RWS_FIXTURES_LANES=rw6 warm-restarts the RW6 virtual '
    + 'controller after it changes the I/O configuration; run it at the machine, with RobotStudio open to start the '
    + 'VC again if it does not come back',
});

/**
 * The lane of a controller: RWS 1.0 is always rw6; RWS 2.0 is rw7 or rw8 by
 * the major of its RobotWare version ('7.21.4+417', '8.2.1'). Null when an
 * RWS 2.0 version is missing or names another major.
 */
export function laneOf(generation: Generation, rwVersion?: string | null): RestartLane | null {
  if (generation === 'rws1') { return 'rw6'; }
  const major = /^\s*(\d+)\./.exec(rwVersion ?? '')?.[1];
  if (major === '7') { return 'rw7'; }
  if (major === '8') { return 'rw8'; }
  return null;
}

/**
 * Why a restart must not be sent to a lane, or null when the list allows it.
 * An unknown lane is refused: it could be one on the list.
 */
export function restartRefusal(lane: RestartLane | null): string | null {
  if (lane === null) {
    return 'the RobotWare major of this controller could not be read, and a restart is sent only to a lane '
      + `known to be off the never-restart list (${Object.keys(NEVER_RESTART).join(', ')})`;
  }
  return NEVER_RESTART[lane] ?? null;
}

/** The lane a restart would go to (null when unknown), and why it must not be sent, or null when it may. */
export interface RestartVerdict {
  lane: RestartLane | null;
  refusal: string | null;
}

/**
 * Whether a restart may be sent to a controller a suite found.
 *
 * RWS 1.0 is rw6, on the list; nothing is read. On RWS 2.0 the lane comes
 * from the RobotWare version the controller answers now, through
 * `readVersion`: the client the restart goes out on (its
 * `getRobotWareVersion()`), or a short session of its own to the same port.
 * The version discovery read is checked as well, when it has one: it comes
 * from the VC's system folder, or from the run cache of an earlier discovery
 * (test-results/live-controllers.json, reused for 10 minutes), and VC ports
 * move, so it can name another controller than the one on the port now. Both
 * must allow the restart: a lane on the list from either one refuses it, and
 * so do a failed read, an answer with no known major, and two versions of
 * different majors.
 */
export async function restartVerdict(
  controller: { generation: Generation; rwVersion?: string },
  readVersion?: () => Promise<string>,
): Promise<RestartVerdict> {
  if (controller.generation === 'rws1') { return { lane: 'rw6', refusal: restartRefusal('rw6') }; }
  const found = controller.rwVersion !== undefined ? laneOf('rws2', controller.rwVersion) : undefined;
  let answered = '';
  let live: RestartLane | null = null;
  if (readVersion) {
    try {
      answered = await readVersion();
      live = laneOf('rws2', answered);
    } catch {
      live = null;
    }
  }
  for (const lane of [live, found]) {
    const listed = lane ? NEVER_RESTART[lane] : undefined;
    if (lane && listed) { return { lane, refusal: listed }; }
  }
  if (live === null) { return { lane: null, refusal: restartRefusal(null) }; }
  if (found !== undefined && found !== live) {
    return {
      lane: null,
      refusal: `discovery named RobotWare ${controller.rwVersion} for this controller, and the controller answers `
        + `${answered}, so its lane is not certain and no restart is sent`,
    };
  }
  return { lane: live, refusal: null };
}
