/**
 * Settings shared by the functional-test helpers: the environment switches,
 * the output directory of a run, the lanes and the test account.
 *
 * The functional suite drives the client against the local RobotStudio
 * virtual controllers the way a consumer does (RobotManager, createAdapter,
 * createClient) and checks what actually changed on the controller. It is
 * enabled only by `npm run functional` (RWS_FUNCTIONAL=1); in a plain
 * `npm test` every functional describe is skipped and nothing is sent.
 *
 * Test infrastructure only - never shipped in the package.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ControlStationIdentity } from '../../../src/index.js';
import { NEVER_RESTART } from '../../helpers/restartPolicy.js';

/** One lane per RobotWare major: RWS 1.0 is RW6 only; RW7 and RW8 both speak RWS 2.0. */
export type Lane = 'rw6' | 'rw7' | 'rw8';
export const LANES: readonly Lane[] = ['rw6', 'rw7', 'rw8'];

export type Generation = 'rws1' | 'rws2';
export type RwMajor = 6 | 7 | 8;

export const LANE_GENERATION: Readonly<Record<Lane, Generation>> = { rw6: 'rws1', rw7: 'rws2', rw8: 'rws2' };
export const LANE_MAJOR: Readonly<Record<Lane, RwMajor>> = { rw6: 6, rw7: 7, rw8: 8 };

/** Only `npm run functional` turns the suite on. */
export const FUNCTIONAL_ENABLED = process.env.RWS_FUNCTIONAL === '1';

/** Parse a comma list of lanes ("rw7,rw8"); unknown words are ignored. */
export function parseLaneList(raw: string | undefined): Lane[] {
  return (raw ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter((s): s is Lane => (LANES as readonly string[]).includes(s));
}

/** RWS_FUNCTIONAL_ONLY=rw7,rw8 runs those lanes only; unset or empty means every lane. */
export function onlyLanes(): Lane[] | null {
  const raw = process.env.RWS_FUNCTIONAL_ONLY;
  if (raw === undefined || raw.trim() === '') { return null; }
  return parseLaneList(raw);
}

/** Lanes a controller restart may be sent to (RWS_FUNCTIONAL_ALLOW_RESTART=rw7). */
export function restartLanes(): Lane[] {
  return parseLaneList(process.env.RWS_FUNCTIONAL_ALLOW_RESTART);
}

/**
 * Lanes the manual-mode tests may switch to manual reduced speed
 * (RWS_FUNCTIONAL_ALLOW_MANUAL=rw7,rw8). Set it only with someone at the
 * virtual FlexPendant: the switch back to Auto waits there for a
 * confirmation (AUTO_CH on RW 7.21.4 and 8.2.1, 2026-09-30), which the tests
 * ask for and wait for; on RobotWare 7 the jog needs the RMMP request granted
 * there; and on RobotWare 8 the motors come back only with a Reset there.
 */
export function manualLanes(): Lane[] {
  return parseLaneList(process.env.RWS_FUNCTIONAL_ALLOW_MANUAL);
}

/**
 * The system name of the one controller whose RAPID-start tests may allow
 * motion control for the suite's station
 * (RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<system name, as /rw/system reads it>),
 * or null when unset. RobotWare 8 refuses a RAPID start from a remote control
 * station until motion control is allowed (403 -1073435864 on RW 8.2.1, also
 * for a program that moves nothing). ABB treats allowing it as the station's
 * confirmation that an emergency stop and a normal stop are within reach, so
 * a person sets this, for that controller, only after checking that at its
 * virtual FlexPendant. A value that names no controller (a left-over `1` or
 * `rw8`) allows nothing; the guard also needs the controller to identify as
 * virtual and the lane to be RobotWare 8.
 */
export function motionControlSystem(): string | null {
  const v = (process.env.RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL ?? '').trim();
  return v === '' ? null : v;
}

/** The account the suites log in as: ABB's shipped default on these virtual controllers. */
export const TEST_USER = process.env.RWS_TEST_USER ?? 'Default User';
export const TEST_PASS = process.env.RWS_TEST_PASS ?? 'robotics';

/** The only host a functional run may reach. */
export const HOST = '127.0.0.1' as const;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Hard refusal: functional tests start programs, move axes and switch motors,
 * so pointing them at anything but a local virtual controller must be
 * impossible, not merely discouraged.
 */
export function assertLocalhost(host: string): void {
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `functional tests refuse non-localhost host ${JSON.stringify(host)} - `
      + 'they start RAPID and move axes and must only ever reach a local virtual controller',
    );
  }
}

/**
 * The RobotWare 8 control station the lane's main manager registers as: a
 * fixed id rather than an anonymous one, so every run registers as the same
 * station. Ignored on RobotWare 6 and 7.
 */
export const FUNCTIONAL_STATION: ControlStationIdentity = {
  name: 'abb-rws-client functional tests',
  id: process.env.RWS_FUNCTIONAL_STATION_ID ?? '{F2CFEFF7-EEDF-419C-9EF7-0B48B11CCBB0}',
  pincode: '1234',
};

/** Repository root (this file is tests/functional/helpers/config.ts). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function timestampId(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * The id of this run. `npm run functional` sets RWS_FUNCTIONAL_RUN_ID so every
 * test file of one run writes into the same directory; a file run directly
 * gets a timestamp of its own.
 */
export const RUN_ID = process.env.RWS_FUNCTIONAL_RUN_ID?.trim() || timestampId();

/** test-results/functional/<run id>/ - traces, the fleet file, skip reasons, the JSON report. */
export const RUN_DIR = path.join(REPO_ROOT, 'test-results', 'functional', RUN_ID);

/** Every module, file, directory, queue and backup a functional test creates starts with this. */
export const PROBE_PREFIX = 'ZZ_PROBE';

/** True for a name the suite owns (case-insensitive: some listings change case). */
export function isProbeName(name: string): boolean {
  return name.toUpperCase().startsWith(PROBE_PREFIX);
}

/**
 * The simulated I/O that `npm run functional:fixtures`
 * (scripts/functional-fixtures.mjs) adds to the RW6 and RW7 virtual
 * controllers, whose built-in signals are all safety (RW 6.16.03) or internal
 * (RW 7.21.4) and so are never written by the suite: one general-purpose
 * digital input and one digital output, access level All. RW7: on the
 * virtual device `device`, network `network`, device map 0 each. RW6: no
 * device. Never applied on RobotWare 8, which ships IIO_di and IIO_do. The
 * script keeps its own copy of these names; an offline test checks the two
 * agree. The suite never adds or removes them itself.
 */
export const IO_FIXTURE = {
  network: 'Virtual',
  device: 'ZZ_PROBE_DEV',
  di: 'ZZ_PROBE_DI1',
  do: 'ZZ_PROBE_DO1',
} as const;

/**
 * The skip reason of a test that needs the I/O fixture on a lane that lacks it.
 * On a lane the test suites never restart (rw6), it says so: the fixture
 * script's restart there is one a person arms and watches
 * (tests/helpers/restartPolicy.ts, ATTENDED_RESTARTS).
 */
export function ioFixtureHint(lane: Lane): string {
  const restart = NEVER_RESTART[lane]
    ? 'it warm-restarts the controller, which the test suites never do on this lane: run it at the machine, '
      + 'with RobotStudio open to start the VC again if it does not come back'
    : 'it warm-restarts the controller';
  return `no ${IO_FIXTURE.di} / ${IO_FIXTURE.do} on this VC: run npm run functional:fixtures `
    + `(RWS_FIXTURES_APPLY=1 RWS_FIXTURES_LANES=${lane}; ${restart})`;
}

/** Is `name` one of the I/O fixture's signals? */
export function isIoFixtureSignal(name: string): boolean {
  return name === IO_FIXTURE.di || name === IO_FIXTURE.do;
}

/**
 * Is `name` a signal with the suite's ZZ_PROBE prefix that the I/O fixture
 * does not add? Some virtual controllers carry more of them, added by hand
 * in RobotStudio (ZZ_PROBE_DO2 and ZZ_PROBE_DO3, with no device and no
 * category). They are not built-in signals: the read tests leave them out of
 * the built-in checks, as they do the fixture's, and assert nothing about
 * where they sit.
 */
export function isExtraProbeSignal(name: string): boolean {
  return isProbeName(name) && !isIoFixtureSignal(name);
}
