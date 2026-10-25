/**
 * Discovery of the local virtual controllers for structural and live tests.
 *
 * Two hard rules from the task brief are enforced here rather than trusted to
 * every test:
 *
 *   1. LOCALHOST ONLY. Anything else throws before a single byte is sent. A
 *      structural suite injects faults - pointing it at a real or workplace
 *      robot must be impossible, not merely discouraged. Discovery runs with
 *      `loopbackOnly: true` (the client itself refuses any other target before
 *      sending anything), and every host it returns passes `assertLocalhost`.
 *   2. NEVER assume a port. VC RWS ports drift across restarts (a warm restart
 *      was observed moving one from 62214 to 40483, and IRC5 comes back as a
 *      NEW process on a new port), so ports are discovered every run through
 *      the client's own `findControllers`: the OS listening-port scan of this
 *      PC, filtered on Windows to the virtual-controller processes.
 *
 * Probes are paced: one at a time, at least 1 s apart. Back-to-back probes
 * run into the controllers' request-rate and session limits, and the 503/401
 * answers that follow look like client defects when they are not.
 *
 * RWS 1.0 (IRC5) is plain HTTP + Digest; RWS 2.0 (OmniCore) is TLS + Basic.
 * The generation is decided by the auth challenge, never guessed from the port.
 *
 * Test infrastructure only - never shipped in the package.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findControllers, type FindControllersOptions, type FoundController } from '../../src/index.js';

export type Generation = 'rws1' | 'rws2';

export interface LiveController {
  generation: Generation;
  host: '127.0.0.1';
  port: number;
  tls: boolean;
  /** Base URL in the shape RwsClient2 wants; RWS 1.0 callers use host/port. */
  baseUrl: string;
  label: string;
  /** RobotWare version, when the local system folder of the VC could be read (OmniCore VCs on Windows). */
  rwVersion?: string;
  /** System name, read the same way. */
  systemName?: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Hard refusal, per the brief: live suites must never leave the machine. */
export function assertLocalhost(host: string): void {
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `structural live tests refuse non-localhost host ${JSON.stringify(host)} - `
      + 'these suites inject faults and must never touch a real robot',
    );
  }
}

export const TEST_USER = process.env.RWS_TEST_USER ?? 'Default User';
export const TEST_PASS = process.env.RWS_TEST_PASS ?? 'robotics';

/** The process that serves RWS for each generation of RobotStudio virtual controller. */
export const VC_IMAGE: Readonly<Record<Generation, string>> = { rws1: 'RobVC.exe', rws2: 'Vrchost64.exe' };

/**
 * The discovery options every test helper uses: this PC's loopback only, no
 * service address, no mDNS, the virtual-controller process filter, and one
 * probe at a time at least 1 s apart.
 */
export const LOCAL_DISCOVERY: Readonly<FindControllersOptions> = Object.freeze({
  loopbackOnly: true,
  serviceAddress: false,
  mdns: false,
  filterToVcProcesses: true,
  pacing: { local: { concurrency: 1, minGapMs: 1000 } },
});

/** A port named in the environment, or undefined when unset or not a port. */
function envPort(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) { return undefined; }
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** The env-named ports, per generation. They are probed in every discovery and preferred. */
function envPorts(): Record<Generation, number | undefined> {
  return { rws1: envPort('RWS_TEST_PORT_RW6'), rws2: envPort('RWS_TEST_PORT_RW7') };
}

/**
 * One paced `findControllers` run against this PC: the listening-port scan
 * plus `ports` as loopback targets. Returns the RWS controllers found (realm
 * verified, generation known) on 127.0.0.1, ordered by port. Every host the
 * call returns is checked with `assertLocalhost`, including folded addresses.
 */
export async function findLocalControllers(
  opts: { identify?: 'none' | 'anonymous'; ports?: readonly number[] } = {},
): Promise<FoundController[]> {
  const manual = [...new Set(opts.ports ?? [])].map(port => ({ host: '127.0.0.1', port }));
  const result = await findControllers({
    ...LOCAL_DISCOVERY,
    identify: opts.identify ?? 'none',
    ...(manual.length > 0 ? { manual } : {}),
  });
  for (const c of result.controllers) {
    assertLocalhost(c.host);
    for (const a of c.addresses ?? []) { assertLocalhost(a.host); }
  }
  return result.controllers
    .filter(c => c.host === '127.0.0.1' && c.identified && c.probe !== null && c.https !== null
      && (c.generation === 'rws1' || c.generation === 'rws2'))
    .sort((a, b) => a.port - b.port);
}

/**
 * The RobotWare major of an entry (RWS 1.0 is always 6), or Infinity when unknown (sorts last).
 * The same rule as `rwMajor` in scripts/local-controllers.mjs and `majorOf` in the functional fleet.
 */
function rwMajor(c: FoundController): number {
  if (c.generation === 'rws1') { return 6; }
  const m = /^\s*(\d+)\./.exec(c.rwVersion ?? '');
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** A found entry in the shape the structural cells take. */
export function toLiveController(c: FoundController, note = ''): LiveController {
  assertLocalhost(c.host);
  const generation = c.generation as Generation;
  const tls = c.https === true;
  const who = [c.systemName, c.rwVersion ? `RW ${c.rwVersion}` : ''].filter(Boolean).join(' ');
  return {
    generation, host: '127.0.0.1', port: c.port, tls,
    baseUrl: `${tls ? 'https' : 'http'}://127.0.0.1:${c.port}`,
    label: `${generation === 'rws1' ? 'IRC5/RW6' : 'OmniCore/RW7+'} :${c.port}${who ? ` ${who}` : ''}${note ? ` ${note}` : ''}`,
    ...(c.rwVersion ? { rwVersion: c.rwVersion } : {}),
    ...(c.systemName ? { systemName: c.systemName } : {}),
  };
}

/**
 * The last full discovery, shared by the test files of one run (each file runs
 * in its own worker, and a paced discovery takes up to half a minute). Used
 * only while younger than `CACHE_MAX_AGE_MS`, with the same env ports, and
 * after one probe of every cached port still answers with its generation and
 * scheme. test-results/ is not committed.
 */
const CACHE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-results', 'live-controllers.json');
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

interface CacheFile { at: number; env: string; controllers: LiveController[] }

function envKey(): string { return JSON.stringify(envPorts()); }

async function loadCached(): Promise<LiveController[] | null> {
  let saved: CacheFile;
  try { saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as CacheFile; } catch { return null; }
  if (!Array.isArray(saved?.controllers) || saved.controllers.length === 0
      || !(Date.now() - saved.at < CACHE_MAX_AGE_MS) || saved.env !== envKey()) {
    return null;
  }
  for (const c of saved.controllers) { assertLocalhost(c.host); }
  const result = await findControllers({
    ...LOCAL_DISCOVERY,
    local: false,
    identify: 'none',
    manual: saved.controllers.map(c => ({ host: '127.0.0.1', port: c.port, https: c.tls })),
  });
  for (const r of result.controllers) { assertLocalhost(r.host); }
  const still = saved.controllers.every(c => result.controllers.some(r =>
    r.port === c.port && r.https === c.tls && r.generation === c.generation && r.identified));
  return still ? saved.controllers : null;
}

function saveCache(controllers: LiveController[]): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const file: CacheFile = { at: Date.now(), env: envKey(), controllers };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(file, null, 2) + '\n');
  } catch { /* the cache is an optimisation */ }
}

/**
 * Every RWS controller on this PC, in a fixed order: the env-named port of
 * each generation first, then the lowest RobotWare major (RWS 1.0 is 6; for
 * RWS 2.0, which serves both 7 and 8, when the VC's system folder named it),
 * then the port. Not capped.
 * `fresh: true` skips the run cache (after a restart may have moved a port).
 */
export async function listLocalControllers(opts: { fresh?: boolean } = {}): Promise<LiveController[]> {
  if (!opts.fresh) {
    const cached = await loadCached();
    if (cached) { return cached; }
  }
  const env = envPorts();
  const named = new Set([env.rws1, env.rws2].filter((p): p is number => p !== undefined));
  const rows = await findLocalControllers({ identify: 'anonymous', ports: [...named] });
  const rank = (c: FoundController): number => (named.has(c.port) ? 0 : 1);
  const list = rows
    .sort((a, b) => rank(a) - rank(b) || rwMajor(a) - rwMajor(b) || a.port - b.port)
    .map(c => toLiveController(c, named.has(c.port) ? '(env)' : ''));
  if (list.length > 0) { saveCache(list); }
  return list;
}

let cache: LiveController[] | null = null;

/**
 * At most one controller per generation, in the order of `listLocalControllers`.
 * The cap keeps cells that loop over a generation on the one controller the
 * suite is set up for. Set RWS_TEST_PORT_RW6 / RWS_TEST_PORT_RW7 to pick another.
 */
export async function discoverControllers(): Promise<LiveController[]> {
  if (cache) { return cache; }
  const found: LiveController[] = [];
  for (const c of await listLocalControllers()) {
    if (!found.some(f => f.generation === c.generation)) { found.push(c); }
  }
  cache = found;
  return found;
}

/** First reachable controller of a generation, or null when none is running. */
export async function controllerFor(generation: Generation): Promise<LiveController | null> {
  const all = await discoverControllers();
  return all.find(c => c.generation === generation) ?? null;
}

/**
 * Skip helper for describe blocks. A structural cell without its controller is
 * reported as untested by the runner - never as passing.
 */
export async function requireController(generation: Generation): Promise<LiveController> {
  const c = await controllerFor(generation);
  if (!c) {
    throw new Error(
      `no ${generation} controller reachable on localhost - start the VC, or set `
      + `${generation === 'rws1' ? 'RWS_TEST_PORT_RW6' : 'RWS_TEST_PORT_RW7'}`,
    );
  }
  return c;
}

/** Reset discovery, in this worker and the run cache (after a warm restart moved a port mid-suite). */
export function forgetControllers(): void {
  cache = null;
  try { fs.rmSync(CACHE_FILE, { force: true }); } catch { /* nothing cached */ }
}

/**
 * Find a virtual controller again after a restart may have moved its port:
 * one paced discovery, this generation's VC process only (`RobVC.exe` for
 * RWS 1.0, `Vrchost64.exe` for RWS 2.0, when the OS named the owner), ports in
 * `excludePorts` dropped, and with `systemName` given an entry whose system
 * folder names another system dropped too. The original port wins when it is
 * among the answers; otherwise the lowest port. Null when nothing answers.
 */
export async function findVcAgain(
  generation: Generation,
  opts: { originPort?: number; excludePorts?: ReadonlySet<number>; systemName?: string } = {},
): Promise<LiveController | null> {
  const rows = await findLocalControllers({ identify: opts.systemName ? 'anonymous' : 'none' });
  const want = VC_IMAGE[generation].toLowerCase();
  const matches = rows.filter(c =>
    c.generation === generation
    && (c.process?.image === undefined || c.process.image.toLowerCase() === want)
    && !opts.excludePorts?.has(c.port)
    && (!opts.systemName || c.systemName === undefined || c.systemName === opts.systemName));
  const hit = matches.find(c => c.port === opts.originPort) ?? matches[0];
  return hit ? toLiveController(hit, hit.port === opts.originPort ? '' : '(found again)') : null;
}
