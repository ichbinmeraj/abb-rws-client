/**
 * Discovery of EVERY local controller, classified into lanes by RobotWare
 * major (rw6 / rw7 / rw8).
 *
 * The structural helpers find one controller per protocol generation, which
 * is not enough here: RobotWare 7 and 8 both speak RWS 2.0 and behave
 * differently (mastership vs control-station write access, motors on over
 * RWS), so each needs its own lane.
 *
 * Discovery is the client's own `findControllers`, on this PC's loopback only
 * (`loopbackOnly`, no service address, no mDNS), the virtual-controller
 * process filter on, one probe at a time at least 1 s apart. Ports move on
 * every VC start, so none is hard-coded; RWS_TEST_PORT_RW6 / RWS_TEST_PORT_RW7 /
 * RWS_TEST_PORT_RW8 name a port that is probed as well and wins its lane.
 *
 * The lane comes from identity, without a login where possible: the RWS 1.0
 * challenge marks the rw6 lane, and an OmniCore VC's RobotWare version comes
 * from its system folder on this PC (`identify: 'anonymous'`). Only an RWS 2.0
 * controller whose version could not be read that way is logged into, once,
 * through `findControllers` with credentials. A chosen controller whose system
 * name or version is still unknown (always the case for rw6) gets one login
 * the same way, so the tests can compare against what the controller reports.
 * Lanes are filled in a fixed order: env-named ports first, then RobotWare
 * major, then port.
 *
 * The result is cached per process, and in `fleet.json` of the run directory
 * so the later test files of one `npm run functional` reuse it instead of
 * discovering again (each file runs in its own worker). A cached entry is
 * re-checked with an unauthenticated probe before use.
 *
 * Test infrastructure only - never shipped in the package.
 */

import fs from 'node:fs';
import path from 'node:path';
import { RobotManager, findControllers, type FindControllersOptions, type FoundController } from '../../../src/index.js';
import {
  HOST, LANES, LANE_GENERATION, LANE_MAJOR, RUN_DIR, TEST_PASS, TEST_USER, assertLocalhost,
  type Generation, type Lane, type RwMajor,
} from './config.js';
import { harnessNote, withTraceSession } from './trace.js';

export interface FleetController {
  lane: Lane;
  generation: Generation;
  rwMajor: RwMajor;
  /** RobotWare version as the controller reports it, e.g. `6.16.3007`, `7.21.4+417`, `8.2.1+1023`. */
  rwVersion: string;
  /** System name, e.g. `IRB1600_6_120_5`. */
  systemName: string;
  host: typeof HOST;
  port: number;
  https: boolean;
  /** `https://127.0.0.1:5466` - the base URL RwsClient2 takes. */
  baseUrl: string;
  /** `rw7 IRB1600_6_120_5 RW 7.21.4+417 https://127.0.0.1:5466` */
  label: string;
  /** How the port was found. */
  source: 'env' | 'scan';
}

/** A controller that answered on this PC but could not be used. */
export interface UnusableController {
  port: number;
  https: boolean;
  /**
   * The lanes it could have taken: the lane of its RobotWare major when that
   * is known (always rw6 for an RWS 1.0 controller), every lane of its
   * protocol generation when its version could not be read, none for a
   * RobotWare other than 6, 7 or 8. Absent in a fleet.json written before
   * this field existed.
   */
  lanes?: Lane[];
  reason: string;
}

export interface FleetReport {
  /** One controller per lane at most, in lane order. */
  controllers: FleetController[];
  /** Controllers that answered but could not be used (login or read failed, unknown major). */
  unusable: UnusableController[];
  /** A second controller of a lane that is already taken: listed, not tested. */
  duplicates: FleetController[];
  discoveredAt: string;
}

/** The lane of a RobotWare version string, or null for anything but 6, 7 or 8. */
export function laneForVersion(rwVersion: string): Lane | null {
  const m = /^\s*(\d+)\./.exec(rwVersion ?? '');
  if (!m) { return null; }
  const lane = `rw${m[1]}`;
  return (LANES as readonly string[]).includes(lane) ? lane as Lane : null;
}

const ENV_PORT: Readonly<Record<Lane, string>> = {
  rw6: 'RWS_TEST_PORT_RW6', rw7: 'RWS_TEST_PORT_RW7', rw8: 'RWS_TEST_PORT_RW8',
};

/** This PC's loopback only, the VC process filter, one probe at a time at least 1 s apart. */
const DISCOVERY: Readonly<FindControllersOptions> = Object.freeze({
  loopbackOnly: true,
  serviceAddress: false,
  mdns: false,
  filterToVcProcesses: true,
  pacing: { local: { concurrency: 1, minGapMs: 1000 } },
});

interface Candidate {
  port: number;
  https: boolean;
  generation: Generation;
  source: 'env' | 'scan';
  envLane?: Lane;
  rwVersion?: string;
  systemName?: string;
}

/** The env-named port of each lane that is a valid port. */
function envPorts(): Map<number, Lane> {
  const out = new Map<number, Lane>();
  for (const lane of LANES) {
    const raw = process.env[ENV_PORT[lane]];
    if (!raw) { continue; }
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      harnessNote(`${ENV_PORT[lane]}=${raw} is not a port - ignored`);
      continue;
    }
    if (!out.has(port)) { out.set(port, lane); }
  }
  return out;
}

/** The RWS controllers on 127.0.0.1 from one result, every host checked. */
function rwsRows(controllers: readonly FoundController[]): FoundController[] {
  for (const c of controllers) {
    assertLocalhost(c.host);
    for (const a of c.addresses ?? []) { assertLocalhost(a.host); }
  }
  return controllers.filter(c => c.host === HOST && c.identified && c.probe !== null && c.https !== null
    && (c.generation === 'rws1' || c.generation === 'rws2'));
}

/** The RobotWare major a candidate is known to run, Infinity when unknown. */
function majorOf(c: Candidate): number {
  if (c.generation === 'rws1') { return 6; }
  const m = /^\s*(\d+)\./.exec(c.rwVersion ?? '');
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** Every RWS controller on this PC, in lane-choice order: env-named, then RobotWare major, then port. */
async function candidates(): Promise<Candidate[]> {
  const env = envPorts();
  const result = await findControllers({
    ...DISCOVERY,
    identify: 'anonymous',
    ...(env.size > 0 ? { manual: [...env.keys()].map(port => ({ host: HOST, port })) } : {}),
  });
  for (const note of result.notes) { harnessNote(`discovery: ${note}`); }
  if (result.localScan.status !== 'ok') {
    harnessNote(`the listening-port scan of this PC did not answer (${result.localScan.status}); only RWS_TEST_PORT_* ports are tried`, result.localScan);
  }
  const rows = rwsRows(result.controllers);
  for (const [port, lane] of env) {
    if (!rows.some(r => r.port === port)) {
      harnessNote(`${ENV_PORT[lane]}=${port}: no RWS controller answers there - falling back to the scan`);
    }
  }
  const out: Candidate[] = rows.map((r): Candidate => ({
    port: r.port,
    https: r.https === true,
    generation: r.generation as Generation,
    source: env.has(r.port) ? 'env' : 'scan',
    ...(env.has(r.port) ? { envLane: env.get(r.port) } : {}),
    ...(r.rwVersion ? { rwVersion: r.rwVersion } : {}),
    ...(r.systemName ? { systemName: r.systemName } : {}),
  }));
  const rank = (c: Candidate): number => (c.source === 'env' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || majorOf(a) - majorOf(b) || a.port - b.port);
}

/**
 * One login through `findControllers` (credentials for this port only), read
 * what the controller is, log out. Traced as session `fleet:<port>`.
 */
async function identify(c: Candidate): Promise<{ rwVersion: string; systemName: string }> {
  return withTraceSession(`fleet:${c.port}`, async () => {
    const result = await findControllers({
      ...DISCOVERY,
      local: false,
      identify: 'with-credentials',
      manual: [{ host: HOST, port: c.port, https: c.https }],
      credentials: { [`local:${c.port}`]: { username: TEST_USER, password: TEST_PASS } },
    });
    const row = rwsRows(result.controllers).find(r => r.port === c.port);
    if (!row?.rwVersion || !row.systemName) {
      throw new Error(result.notes.join('; ') || `no system read from port ${c.port}`);
    }
    return { rwVersion: row.rwVersion, systemName: row.systemName };
  });
}

function describeController(lane: Lane, v: string, name: string, c: Candidate): FleetController {
  return {
    lane,
    generation: LANE_GENERATION[lane],
    rwMajor: LANE_MAJOR[lane],
    rwVersion: v,
    systemName: name,
    host: HOST,
    port: c.port,
    https: c.https,
    baseUrl: `${c.https ? 'https' : 'http'}://${HOST}:${c.port}`,
    label: `${lane} ${name || '?'} RW ${v || '?'} ${c.https ? 'https' : 'http'}://${HOST}:${c.port}`,
    source: c.source,
  };
}

/** The lane of a candidate from what is known without a login; undefined when only a login can tell. */
function laneWithoutLogin(c: Candidate): Lane | null | undefined {
  if (c.generation === 'rws1') { return 'rw6'; }
  return c.rwVersion ? laneForVersion(c.rwVersion) : undefined;
}

async function scan(): Promise<FleetReport> {
  assertLocalhost(HOST);
  const report: FleetReport = { controllers: [], unusable: [], duplicates: [], discoveredAt: new Date().toISOString() };
  const byLane = new Map<Lane, FleetController>();
  for (const c of await candidates()) {
    let lane = laneWithoutLogin(c);
    let who: { rwVersion: string; systemName: string } | null =
      c.rwVersion && c.systemName ? { rwVersion: c.rwVersion, systemName: c.systemName } : null;
    // A login only when the lane is unknown, or when this candidate takes a
    // free lane and its name or version is still unread.
    if (lane === undefined || (lane !== null && !byLane.has(lane) && !who)) {
      try {
        who = await identify(c);
      } catch (e) {
        const lanes = lane ? [lane] : LANES.filter(l => LANE_GENERATION[l] === c.generation);
        report.unusable.push({ port: c.port, https: c.https, lanes, reason: `login or system read failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      lane = laneForVersion(who.rwVersion);
    }
    const version = who?.rwVersion ?? c.rwVersion ?? '';
    if (!lane) {
      report.unusable.push({ port: c.port, https: c.https, lanes: [], reason: `RobotWare ${version} is not 6, 7 or 8` });
      continue;
    }
    if (LANE_GENERATION[lane] !== c.generation) {
      report.unusable.push({ port: c.port, https: c.https, lanes: [lane], reason: `RobotWare ${version} answered with the ${c.generation} challenge` });
      continue;
    }
    if (c.envLane && c.envLane !== lane) {
      harnessNote(`${ENV_PORT[c.envLane]}=${c.port} names a RobotWare ${version} controller - used as ${lane}, not ${c.envLane}`);
    }
    const fc = describeController(lane, version, who?.systemName ?? c.systemName ?? '', c);
    if (byLane.has(lane)) { report.duplicates.push(fc); continue; }
    byLane.set(lane, fc);
  }
  report.controllers = LANES.map(l => byLane.get(l)).filter((c): c is FleetController => !!c);
  return report;
}

const FLEET_FILE = path.join(RUN_DIR, 'fleet.json');

/**
 * A cached report is used only when every controller in it still answers
 * with its generation's challenge, and when it names no controller that
 * could have taken a lane but could not be used: that one may be usable by
 * now (a controller still starting, a hung duplicate since ended), and a
 * cached entry would fail its lane in every file of the run.
 */
async function loadCached(): Promise<FleetReport | null> {
  if (!process.env.RWS_FUNCTIONAL_RUN_ID) { return null; }
  let cached: FleetReport;
  try { cached = JSON.parse(fs.readFileSync(FLEET_FILE, 'utf8')) as FleetReport; } catch { return null; }
  if (!Array.isArray(cached?.controllers)) { return null; }
  const unusable = (Array.isArray(cached.unusable) ? cached.unusable : []).filter(u => (u.lanes ?? []).length > 0);
  if (unusable.length > 0) {
    harnessNote(`cached fleet (${cached.discoveredAt}) names ${unusable.length} controller(s) it could not use - discovering again`, { unusable });
    return null;
  }
  for (const c of cached.controllers) {
    assertLocalhost(c.host);
    const probe = await RobotManager.probeSpecificPort(HOST, c.port, false, 2500);
    const gen = probe ? (probe.authType === 'digest' ? 'rws1' : 'rws2') : null;
    if (gen !== c.generation || probe?.useHttps !== c.https) {
      harnessNote(`cached fleet entry ${c.label} no longer answers as before - discovering again`);
      return null;
    }
  }
  return cached;
}

let memo: Promise<FleetReport> | null = null;

/**
 * Every local controller, one per lane at most. Cached per process (and per
 * run on disk). Never throws for an absent controller: an empty lane is simply
 * missing from `controllers`.
 */
export function discoverFleet(): Promise<FleetReport> {
  if (!memo) {
    memo = (async () => {
      const cached = await loadCached();
      if (cached) {
        harnessNote(`fleet reused from ${FLEET_FILE}`, { controllers: cached.controllers.map(c => c.label) });
        return cached;
      }
      const report = await scan();
      harnessNote('fleet discovered', {
        controllers: report.controllers.map(c => c.label),
        duplicates: report.duplicates.map(c => c.label),
        unusable: report.unusable,
      });
      try {
        fs.mkdirSync(RUN_DIR, { recursive: true });
        fs.writeFileSync(FLEET_FILE, JSON.stringify(report, null, 2) + '\n');
      } catch { /* the cache is an optimisation */ }
      return report;
    })();
    // A failed discovery must not stick: the next caller tries again.
    memo.catch(() => { memo = null; });
  }
  return memo;
}

/** The controller of one lane, or null when none is running. */
export async function fleetController(lane: Lane): Promise<FleetController | null> {
  const report = await discoverFleet();
  return report.controllers.find(c => c.lane === lane) ?? null;
}

/**
 * Why `lane` has no controller although discovery found one that could have
 * taken it: each such controller with its address and what went wrong (a
 * failed login, most often). Null when none was found, i.e. when the lane is
 * simply not running. The harness fails such a lane instead of skipping it,
 * so a controller that answers but cannot be logged in to is never mistaken
 * for one that is not there.
 */
export function laneUnusable(report: FleetReport, lane: Lane): string | null {
  const found = report.unusable.filter(u => (u.lanes ?? []).includes(lane));
  if (found.length === 0) { return null; }
  return found.map(u => {
    const what = u.lanes?.length === 1
      ? `a RobotWare ${LANE_MAJOR[lane]} controller`
      : `an ${LANE_GENERATION[lane] === 'rws1' ? 'RWS 1.0' : 'RWS 2.0'} controller whose RobotWare version could not be read (it may be RobotWare ${LANE_MAJOR[lane]})`;
    return `${what} was found at ${u.https ? 'https' : 'http'}://${HOST}:${u.port} but cannot be used: ${u.reason}`;
  }).join('; ');
}

/**
 * Forget the cached fleet (memory and run file), e.g. after a restart moved a
 * port. The next `discoverFleet` scans again.
 */
export function forgetFleet(): void {
  memo = null;
  try { fs.rmSync(FLEET_FILE, { force: true }); } catch { /* nothing cached */ }
}
