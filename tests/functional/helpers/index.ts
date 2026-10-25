/**
 * Functional-test helpers, one import:
 *
 *   import { forEachController, zzExecModule, waitUntil } from './helpers/index.js';
 *
 * Test infrastructure only - never shipped in the package.
 */

export {
  forEachController, expectRwsError, LANE_HOOK_TIMEOUT_MS, LANE_REQUEST_TIMEOUT_MS,
  type FunctionalContext, type TestHandle,
} from './harness.js';
export {
  FUNCTIONAL_ENABLED, LANES, LANE_GENERATION, LANE_MAJOR, HOST, TEST_USER, TEST_PASS,
  FUNCTIONAL_STATION, RUN_ID, RUN_DIR, PROBE_PREFIX, isProbeName, assertLocalhost,
  onlyLanes, restartLanes, manualLanes, motionControlSystem, IO_FIXTURE, ioFixtureHint, isIoFixtureSignal, isExtraProbeSignal,
  type Lane, type Generation, type RwMajor,
} from './config.js';
export {
  discoverFleet, fleetController, forgetFleet, laneForVersion, laneUnusable,
  type FleetController, type FleetReport, type UnusableController,
} from './fleet.js';
export {
  allowed, checkJog, assertSafeJog, isVirtualIdentity, MOTION_LIMITS,
  type GuardKind, type GuardDecision, type GuardFacts,
} from './guard.js';
export {
  zzDataModule, zzExecModule, zzMotionModule, uploadAndLoad, unload, remoteModulePath, assertProbeModuleName, signedTerm,
  type GeneratedModule, type MotionModuleOptions, type MotionSpeed, type LoadedModule, type RapidTarget,
} from './rapid.js';
export {
  waitFor, waitUntil, readPanel, snapshotState, restoreState, diffSnapshots, releaseHolds, probeModules,
  volumeRoots, JOINT_TOLERANCE_DEG, isPendingModeChange, baselineBlocker,
  type PanelState, type StateSnapshot, type RestoreReport, type RestoreStep, type ProbeEntry,
  type ProgramPointer, type StateTarget,
} from './state.js';
export {
  describeError, jointDeltas, maxAbs, round3, teleportJoints, withinMotionLimits, managerRws2, followPanel,
  nothingEngaged, releaseSimPanel, readJointsNow, teleportBack, askAtPendant, opmodeOnly,
  type PanelStep, type PanelTrail, type SimEngaged,
} from './vc.js';
export { pendantSession, waitForPerson, PERSON_WAIT_MS, type PersonWait, type PersonWaitOptions } from './pendant.js';
export {
  installTrace, setTraceLane, traceLane, traceFile, writeTrace, harnessNote, recordSkip, scrub, scrubString,
  labelSession, withTraceSession, traceSession,
  type TraceLine, type TraceLevel,
} from './trace.js';
