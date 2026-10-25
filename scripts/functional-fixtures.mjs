#!/usr/bin/env node
/**
 * `npm run functional:fixtures` - adds (or removes) the simulated I/O the
 * functional suite writes to on the RobotWare 6 and 7 virtual controllers.
 *
 *   RWS_FIXTURES_APPLY=1 RWS_FIXTURES_LANES=rw7,rw6 npm run functional:fixtures
 *   RWS_FIXTURES_APPLY=1 RWS_FIXTURES_LANES=rw7 npm run functional:fixtures -- --remove
 *   npm run functional:fixtures -- --print     # print the CFG files; nothing is sent
 *
 * Why: every built-in signal of the RW 6.16.03 virtual controller is category
 * `safety` and every one of RW 7.21.4 is `internal`, so the suite has no
 * general-purpose input or output to simulate and write there (RobotWare 8
 * ships IIO_di* / IIO_do* on its integrated I/O device). The fixture is one
 * digital input and one digital output, access level `All` (the predefined
 * level that allows a remote write in Auto), no category:
 *
 *   rw7  VIRTUAL_DEVICE ZZ_PROBE_DEV on the built-in `Virtual` network, and
 *        EIO_SIGNAL ZZ_PROBE_DI1 (DI) and ZZ_PROBE_DO1 (DO) on it, device map 0
 *   rw6  EIO_SIGNAL ZZ_PROBE_DI1 (DI) and ZZ_PROBE_DO1 (DO) with no device
 *
 * Apply (the default), per lane: read what is there; refuse if the fixture is
 * partly present or RAPID is running; upload one EIO .cfg file to TEMP; take
 * the configuration hold (edit mastership on RobotWare 7, CFG mastership on
 * RobotWare 6); validate the file, then load it with action-type `add` passed
 * explicitly (the client's own default is `replace`; `add-with-reset`, which
 * deletes the domain's existing instances first, is never used); wait until
 * the configuration lists the new instances; release; delete the file; warm
 * restart through the client; wait for the controller to answer again (on a
 * new port if the restart moved it, found by its system id); check that both
 * signals are listed (and on rw7 the device on `Virtual`).
 *
 * The validate step on RWS 2.0: ABB documents `POST /rw/cfg/validate`, and the
 * client's paths table records no equivalent there. Live-verified 2026-09-30 on
 * RW 7.21.4 by this script: `filepath=$TEMP/<file>&action-type=add` answered
 * 200 with the documented `cfg-validate` EIO item, and `POST /rw/cfg/load` with
 * the same path answered 204; the loaded instances were listed within about
 * 0.2 s and were active after the warm restart. Other builds are not seen yet.
 * If every file form answers 404, read it as "this
 * build has no validate endpoint", not "the file is wrong": nothing is loaded,
 * the hold is released and the file deleted, and the error says so. A 200 is
 * taken as a pass only when its body is the documented one (a `cfg-validate`
 * item for EIO and nothing else); any other body is a refusal.
 *
 * --remove: delete the fixture's own instances (the signals first, then the
 * device), warm restart, check they are gone.
 *
 * Through the client's public API (createAdapter: cfg validate on RWS 1.0,
 * cfg load, file upload and delete, mastership, restart, instance reads and
 * removal) from the package built into dist/ (the script runs tsc first, so
 * it always uses the client as the working tree has it).
 * The client has no RWS 2.0 call for `POST /rw/cfg/validate`; that one
 * request goes through the RWS 2.0 adapter's own request method, so it shares
 * the session, pacing, tracing and typed errors of everything else.
 *
 * Controllers reached: the lanes are found through the client's own
 * `findControllers` (this PC's loopback only, the virtual-controller process
 * filter, one probe at a time at least 1 s apart). The lane comes from
 * identity without a login: the RWS 1.0 challenge marks rw6, and an OmniCore
 * VC's RobotWare version comes from its system folder on this PC. The
 * RWS_TEST_PORT_* ports are probed as well and come first, then the lowest
 * RobotWare major, then the lowest port. The controller chosen for a lane gets
 * one login (a read-only system read, then logout) for its system id; an
 * RWS 2.0 controller whose version could not be read from its folder gets that
 * login before its lane is known. A controller of an unwanted lane is not
 * logged in to.
 *
 * Hard rules:
 *   - 127.0.0.1 only; any other host is refused.
 *   - Nothing is sent without RWS_FIXTURES_APPLY=1 and a lane list in
 *     RWS_FIXTURES_LANES (rw6, rw7).
 *   - rw8 is refused: it already has IIO_di* / IIO_do*, and a restart leaves
 *     it in guard stop until someone presses Reset at the pendant.
 *   - Only instances named ZZ_PROBE... are ever added or removed.
 *   - A lane that changes something ends in a warm restart. rw6 is on the test
 *     suites' never-restart list (tests/helpers/restartPolicy.ts); this
 *     script's rw6 restart is the one exception that list names
 *     (ATTENDED_RESTARTS): run rw6 only at the machine, with RobotStudio open
 *     to start the VC again if it does not come back.
 *
 * Output: progress on the console, and the client's wire trace per lane in
 * test-results/functional/fixtures-<timestamp>/<lane>.jsonl (credentials and
 * cookies masked). Exit code 0 when every lane ended as asked, 1 when one did
 * not, 2 when the run was refused before anything was sent.
 *
 * Test infrastructure only - never shipped in the package.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { byPreference, envPorts, findLocalControllers, isVcOf } from './local-controllers.mjs';

// ─── The fixture (pure; unit-tested offline) ─────────────────────────────────

/** Names and values of the fixture. tests/functional/helpers/config.ts keeps the same names (IO_FIXTURE). */
export const FIXTURE = Object.freeze({
  network: 'Virtual',
  device: 'ZZ_PROBE_DEV',
  di: 'ZZ_PROBE_DI1',
  do: 'ZZ_PROBE_DO1',
  access: 'All',
  file: 'ZZ_PROBE_FIXTURE_EIO.cfg',
});

/** Lanes the fixture is for. */
export const FIXTURE_LANES = Object.freeze(['rw6', 'rw7']);

/**
 * The EIO file header each build writes: `<domain>:CFG_1.0:<major>:<minor>::`.
 * RobotWare 7 files carry `:7:0::`, RobotWare 6 EIO files `:6:1::` (ABB's
 * release notes; a file of another version loads with an INFO event-log
 * message, not an error).
 */
export const EIO_HEADER = Object.freeze({ rw6: 'EIO:CFG_1.0:6:1::', rw7: 'EIO:CFG_1.0:7:0::' });

const GENERATION = Object.freeze({ rw6: 'rws1', rw7: 'rws2', rw8: 'rws2' });

/** The prefix every instance this script adds or removes starts with. */
export const PROBE_PREFIX = 'ZZ_PROBE';

/** A refusal before anything was sent (exit code 2). */
export class FixtureRefusal extends Error {
  constructor(message) { super(message); this.name = 'FixtureRefusal'; }
}

/** Throw unless `name` is one of the suite's own instance names. */
export function assertProbeInstance(name) {
  if (typeof name !== 'string' || !name.startsWith(PROBE_PREFIX) || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new FixtureRefusal(`instance ${JSON.stringify(name)} is not a ${PROBE_PREFIX} name - this script never touches it`);
  }
}

function assertFixtureLane(lane) {
  if (!FIXTURE_LANES.includes(lane)) {
    throw new FixtureRefusal(`lane ${JSON.stringify(lane)} has no I/O fixture (lanes: ${FIXTURE_LANES.join(', ')})`);
  }
}

/**
 * The configuration instances of the fixture on `lane`, in load order (the
 * device before the signals that reference it). Each is
 * `{ type, name, attrs: [[attribute, value], ...] }`.
 *
 * `deviceNetwork: false` leaves the `Network` attribute off the virtual
 * device, for a build whose VIRTUAL_DEVICE type has no such attribute (the
 * apply reads the type's attribute list first on RWS 2.0).
 */
export function fixtureInstances(lane, { deviceNetwork = true } = {}) {
  assertFixtureLane(lane);
  const onDevice = lane === 'rw7';
  const signal = (name, type) => ({
    type: 'EIO_SIGNAL',
    name,
    attrs: [
      ['Name', name],
      ['SignalType', type],
      ...(onDevice ? [['Device', FIXTURE.device], ['DeviceMap', '0']] : []),
      ['Access', FIXTURE.access],
    ],
  });
  const out = [];
  if (onDevice) {
    out.push({
      type: 'VIRTUAL_DEVICE',
      name: FIXTURE.device,
      attrs: [['Name', FIXTURE.device], ...(deviceNetwork ? [['Network', FIXTURE.network]] : [])],
    });
  }
  out.push(signal(FIXTURE.di, 'DI'), signal(FIXTURE.do, 'DO'));
  for (const inst of out) {
    assertProbeInstance(inst.name);
    for (const [k, v] of inst.attrs) {
      // Nothing in a value needs quoting or escaping in a CFG file.
      if (!/^[A-Za-z0-9_]+$/.test(k) || !/^[A-Za-z0-9_]+$/.test(v)) {
        throw new FixtureRefusal(`attribute ${k}=${JSON.stringify(v)} of ${inst.name} is not a plain word`);
      }
    }
  }
  return out;
}

/** The fixture's instances in removal order: the signals first, then the device they reference. */
export function removalOrder(lane) {
  return fixtureInstances(lane).reverse();
}

/** CFG lines are wrapped like the controller's own files: at most this many characters, continued with `\`. */
const CFG_LINE_MAX = 80;
const CFG_INDENT = '      ';

function formatInstance(attrs) {
  const pairs = attrs.map(([k, v]) => `-${k} "${v}"`);
  const lines = [];
  let line = '';
  for (const p of pairs) {
    const next = line ? `${line} ${p}` : p;
    // +1 for the continuation backslash.
    if (line && CFG_INDENT.length + next.length + 1 > CFG_LINE_MAX) {
      lines.push(line);
      line = p;
    } else {
      line = next;
    }
  }
  if (line) { lines.push(line); }
  return lines.map((l, i) => `${CFG_INDENT}${l}${i < lines.length - 1 ? '\\' : ''}`).join('\n');
}

/**
 * The EIO .cfg file that adds the fixture on `lane`: the build's header, then
 * one section per type (`#`, `TYPE:`, a blank line, the instances separated by
 * blank lines), the way the controller writes its own files.
 */
export function buildEioCfg(lane, opts = {}) {
  const instances = fixtureInstances(lane, opts);
  const byType = new Map();
  for (const inst of instances) {
    if (!byType.has(inst.type)) { byType.set(inst.type, []); }
    byType.get(inst.type).push(inst);
  }
  const out = [EIO_HEADER[lane]];
  for (const [type, list] of byType) {
    out.push('#', `${type}:`, '');
    list.forEach((inst, i) => {
      out.push(formatInstance(inst.attrs));
      if (i < list.length - 1) { out.push(''); }
    });
  }
  return `${out.join('\n')}\n`;
}

/**
 * Where the file goes: `upload` is the file-service path, `load` the paths the
 * validate and load requests may name, in the order tried. ABB's RWS 2.0 CFG
 * pages name the file as `$TEMP/<file>`; `TEMP/<file>` (the file-service
 * form RWS 2.0 module loads take) comes next, and `/fileservice/TEMP/<file>`
 * last: RW 7.21 refuses bare volume paths for cfg saveas, elog saveraw and
 * backup and takes that form there (the client's toFileserviceUri note). RW
 * 7.21.4 validated and loaded the first form, `$TEMP/<file>` (live, 2026-09-30);
 * the other two were not sent. A
 * validation is a dry run, so trying another form changes nothing; the load
 * uses the first form that validated.
 */
export function cfgFilePaths(lane) {
  assertFixtureLane(lane);
  return GENERATION[lane] === 'rws1'
    ? { upload: `$TEMP/${FIXTURE.file}`, load: [`$TEMP/${FIXTURE.file}`] }
    : { upload: `TEMP/${FIXTURE.file}`, load: [`$TEMP/${FIXTURE.file}`, `TEMP/${FIXTURE.file}`, `/fileservice/TEMP/${FIXTURE.file}`] };
}

/** Classes a documented `POST /rw/cfg/validate` 200 body carries (ABB's CFG Service page for RWS 2.0). */
const VALIDATE_OK_CLASSES = new Set(['state', 'cfg-validate', 'domain']);

/**
 * Is an RWS 2.0 `/rw/cfg/validate` 200 body a pass? Only the documented
 * shape counts: a `cfg-validate` item for the EIO domain and no class outside
 * that shape. Anything else - an error or status item, a message, an empty
 * body - is a refusal, so an unfamiliar answer never leads to a load.
 */
export function validateBodyVerdict(body) {
  const text = String(body ?? '');
  const classes = [...text.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)).filter(Boolean);
  const unknown = [...new Set(classes.filter(c => !VALIDATE_OK_CLASSES.has(c)))];
  if (unknown.length) {
    return { ok: false, reason: `the answer carries ${unknown.map(c => `class "${c}"`).join(', ')}, which a passing validation does not` };
  }
  const item = /<li[^>]*class="cfg-validate"[^>]*>([\s\S]*?)<\/li>/.exec(text);
  if (!item) { return { ok: false, reason: 'the answer has no cfg-validate item' }; }
  const title = /title="([^"]*)"/.exec(item[0])?.[1];
  const domain = /<span[^>]*class="domain"[^>]*>([^<]*)<\/span>/.exec(item[1])?.[1]?.trim();
  const named = [title, domain].filter(v => v !== undefined);
  if (named.length === 0 || named.some(v => v !== 'EIO')) {
    return { ok: false, reason: `the cfg-validate item names ${JSON.stringify(named)}, not the EIO domain` };
  }
  return { ok: true, reason: 'cfg-validate EIO' };
}

/** Did the request answer 404 (its path not found)? */
export function isNotFound(e) {
  return e?.httpStatus === 404;
}

/**
 * The error when no file form validated. When every form answered 404, that
 * comes first, read as a missing validate endpoint (the file was uploaded just
 * before); the controller's refusals are listed either way.
 */
export function validateFailure(refusals) {
  const list = refusals.map(r => `${r.path}: ${r.text}`).join(' | ');
  if (refusals.length && refusals.every(r => r.notFound)) {
    return 'the controller did not validate the file - nothing was loaded. Every form answered 404; the file was uploaded just before, '
      + `so this most likely means this RobotWare has no /rw/cfg/validate endpoint, not that the file is wrong (${list})`;
  }
  return `the controller did not validate the file - nothing was loaded (${list})`;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The only host this script reaches. */
export const HOST = '127.0.0.1';

/** Hard refusal of any host but this machine. */
export function assertLocalhost(host) {
  if (!LOCAL_HOSTS.has(host)) {
    throw new FixtureRefusal(`refusing host ${JSON.stringify(host)}: the fixture script only ever reaches a virtual controller on this PC`);
  }
}

function parseLanes(raw) {
  if (raw === undefined || raw.trim() === '') { return []; }
  const out = [];
  for (const word of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    if (word === 'rw8') {
      throw new FixtureRefusal('rw8 is refused: RobotWare 8 already has IIO_di*/IIO_do*, and a restart leaves it in guard stop until someone presses Reset at the pendant');
    }
    if (!FIXTURE_LANES.includes(word)) {
      throw new FixtureRefusal(`unknown lane ${JSON.stringify(word)} in RWS_FIXTURES_LANES (lanes: ${FIXTURE_LANES.join(', ')})`);
    }
    if (!out.includes(word)) { out.push(word); }
  }
  return out;
}

/**
 * The run's options from the command line and the environment, or a
 * FixtureRefusal. `--print` needs no switch (it sends nothing); every other
 * run needs RWS_FIXTURES_APPLY=1 and RWS_FIXTURES_LANES.
 */
export function parseOptions(argv, env) {
  const known = new Set(['--remove', '--print', '--help', '-h']);
  for (const a of argv) {
    if (!known.has(a)) { throw new FixtureRefusal(`unknown argument ${JSON.stringify(a)} (--remove, --print, --help)`); }
  }
  const help = argv.includes('--help') || argv.includes('-h');
  const mode = argv.includes('--remove') ? 'remove' : 'apply';
  const print = argv.includes('--print');
  const lanes = parseLanes(env.RWS_FIXTURES_LANES);
  if (help) { return { help: true, print: false, mode, lanes }; }
  if (print) {
    if (mode === 'remove') { throw new FixtureRefusal('--print shows the files an apply loads; it does not combine with --remove'); }
    return { help: false, print: true, mode, lanes: lanes.length ? lanes : [...FIXTURE_LANES] };
  }
  if (env.RWS_FIXTURES_APPLY !== '1') {
    throw new FixtureRefusal(`set RWS_FIXTURES_APPLY=1: this ${mode === 'remove' ? 'removes' : 'adds'} I/O configuration and warm-restarts the controller`);
  }
  if (lanes.length === 0) {
    throw new FixtureRefusal('name the lanes to change in RWS_FIXTURES_LANES, e.g. RWS_FIXTURES_LANES=rw7,rw6');
  }
  if (env.RWS_TEST_HOST !== undefined && env.RWS_TEST_HOST.trim() !== '') { assertLocalhost(env.RWS_TEST_HOST.trim()); }
  return { help: false, print: false, mode, lanes };
}

/** The lane of a RobotWare version string (`7.21.4+417` -> rw7), or null. */
export function laneForVersion(rwVersion) {
  const m = /^\s*(\d+)\./.exec(rwVersion ?? '');
  return m && ['6', '7', '8'].includes(m[1]) ? `rw${m[1]}` : null;
}

/**
 * Is `who` (a system read) the controller `ctrl` read before? By system id
 * (a GUID, compared without braces or case) when both have one, else by
 * system name and RobotWare version.
 */
export function sameController(who, ctrl) {
  const n = s => String(s ?? '').trim().replace(/^\{|\}$/g, '').toLowerCase();
  if (n(who?.sysid) !== '' && n(ctrl?.sysid) !== '') { return n(who.sysid) === n(ctrl.sysid); }
  return !!who?.systemName && who.systemName === ctrl?.systemName && who.rwVersion === ctrl?.rwVersion;
}

// ─── Live run (needs the built client and a running virtual controller) ─────

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER = process.env.RWS_TEST_USER ?? 'Default User';
const PASS = process.env.RWS_TEST_PASS ?? 'robotics';
/**
 * Waits, in ms. restartWindowMs: how long a controller is given to come back
 * from the warm restart and show the change (RW 7.21 once took about 6.5
 * minutes). stepMs: the cadence of that watch. loadSettleMs: how long the
 * configuration is given to list the loaded instances (the RWS 2.0 load
 * reports its progress asynchronously). The offline tests shorten them.
 */
export const TIMING = { restartWindowMs: 480000, stepMs: 5000, loadSettleMs: 60000 };

/** Where progress goes. main() turns the trace file on; the offline tests replace log. */
export const output = { log: line => console.log(line), trace: false };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const errText = e => (e && typeof e === 'object' && 'code' in e && e.code
  ? `${e.code}${e.httpStatus ? ` ${e.httpStatus}` : ''}${e.controllerCode ? ` ${e.controllerCode}` : ''}: ${e.message}`
  : e instanceof Error ? e.message : String(e));

// Trace: the client's Logger lines, one JSON line each, per lane.
const stampNow = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const traceDir = path.join(root, 'test-results', 'functional', `fixtures-${stampNow()}`);
let traceLane = 'fleet';
let traceReady = false;

function scrubText(s) {
  let out = String(s)
    .replace(/((?:set-)?cookie|authorization)("?\s*[:=]\s*"?)([^"\r\n]*)/gi, (_m, k, sep) => `${k}${sep}***`)
    .replace(/(-http-session-|http-session|ABBCX|session)=([^;\s"&]+)/gi, (_m, k) => `${k}=***`)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{6,}/g, 'Basic ***')
    .replace(/\bDigest\s+.*$/gm, 'Digest ***');
  if (PASS.length >= 4) { out = out.split(PASS).join('***'); }
  return out;
}
function scrubValue(v, depth = 0) {
  if (depth > 6) { return '[depth]'; }
  if (typeof v === 'string') { return scrubText(v); }
  if (v === null || typeof v !== 'object') { return v; }
  if (v instanceof Error) { return { name: v.name, message: scrubText(v.message) }; }
  if (Array.isArray(v)) { return v.map(x => scrubValue(x, depth + 1)); }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = /^(authorization|cookie|set-cookie|password|passwd|pass|pin|pincode|token|secret|credential)$/i.test(k) ? '***' : scrubValue(x, depth + 1);
  }
  return out;
}
function writeTrace(level, msg, data, cat) {
  if (!output.trace) { return; }
  try {
    if (!traceReady) { fs.mkdirSync(traceDir, { recursive: true }); traceReady = true; }
    const line = { t: new Date().toISOString(), lane: traceLane, level, ...(cat ? { cat } : {}), msg: scrubText(msg), ...(data !== undefined ? { data: scrubValue(data) } : {}) };
    fs.appendFileSync(path.join(traceDir, `${traceLane}.jsonl`), `${JSON.stringify(line)}\n`);
  } catch { /* the trace is evidence, never a failure cause */ }
}
function say(lane, msg, data) {
  output.log(`functional:fixtures ${lane.padEnd(5)} ${msg}`);
  writeTrace('fixture', msg, data);
}

/** Build dist/ from the current src (tsc, as `npm run build` does), so the run uses the client as it is now. */
function buildClient() {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) { throw new FixtureRefusal(`cannot find the TypeScript compiler at ${tsc} - run npm ci first`); }
  const res = spawnSync(process.execPath, [tsc], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) { throw new FixtureRefusal('the client build (tsc) failed - nothing was sent'); }
}

async function loadClient() {
  buildClient();
  const entry = path.join(root, 'dist', 'index.js');
  if (!fs.existsSync(entry)) { throw new FixtureRefusal('dist/index.js is missing after the build - nothing was sent'); }
  const client = await import(pathToFileURL(entry).href);
  client.setLogger({
    info(msg) { writeTrace('info', msg); },
    warn(msg) { writeTrace('warn', msg); },
    error(msg, err) { writeTrace('error', msg, err instanceof Error ? err : err === undefined ? undefined : { value: String(err) }); },
    trace(category, msg, data) { writeTrace('trace', msg, data, category); },
    show() { /* no surface */ },
  });
  return client;
}

function connectOptions(port, https) {
  assertLocalhost(HOST);
  return { host: HOST, port, https, username: USER, password: PASS, timeout: 8000 };
}

async function identify(client, port, https) {
  const a = await client.createAdapter(connectOptions(port, https));
  try {
    const info = await a.getSystemInfo();
    return { rwVersion: info.rwVersion, systemName: info.name, sysid: info.sysid };
  } finally {
    await a.disconnect().catch(() => undefined);
  }
}

/**
 * The controller of each requested lane, plus the ports of every controller
 * seen, so a port the restart moves to is never mistaken for another
 * controller's. One paced discovery; the lane from identity where it is known
 * without a login; one login to the controller chosen for a lane (its system
 * id, for the restart watch).
 */
async function discover(client, lanes) {
  const wanted = new Set(lanes.map(l => GENERATION[l]));
  const named = envPorts(msg => say('fleet', msg));
  let rows = [];
  try {
    ({ rows } = await findLocalControllers(client, { identify: 'anonymous', ports: [...named.keys()] }));
  } catch (e) {
    say('fleet', `discovery failed (${errText(e)})`);
  }
  for (const [port, lane] of named) {
    if (!rows.some(r => r.port === port)) { say('fleet', `RWS_TEST_PORT_${lane.toUpperCase()}=${port}: no RWS controller answers there`); }
  }
  rows.sort(byPreference(named));
  const found = new Map();
  for (const r of rows) {
    if (lanes.every(l => found.has(l))) { break; }
    if (!wanted.has(r.generation)) { continue; }
    const known = r.generation === 'rws1' ? 'rw6' : r.rwVersion ? laneForVersion(r.rwVersion) : undefined;
    if (known !== undefined && (!known || !lanes.includes(known) || found.has(known))) { continue; }
    let who;
    say('fleet', `port ${r.port}: one login to read its system id (read-only, logged out after)`);
    try { who = await identify(client, r.port, r.https); } catch (e) {
      say('fleet', `port ${r.port}: login or system read failed (${errText(e)})`);
      continue;
    }
    const lane = laneForVersion(who.rwVersion);
    say('fleet', `port ${r.port}: ${who.systemName} RobotWare ${who.rwVersion} (${lane ?? 'no lane'})`);
    if (lane && lanes.includes(lane) && GENERATION[lane] === r.generation && !found.has(lane)) {
      found.set(lane, { lane, generation: r.generation, port: r.port, https: r.https, ...who });
    }
  }
  return { found, ports: rows.map(r => r.port) };
}

/** Did the request get no usable answer (connection, session, busy), rather than an answer about what it asked? */
function isTransport(e) {
  return ['NETWORK_ERROR', 'NOT_CONNECTED', 'SESSION_EXPIRED', 'CONTROLLER_BUSY', 'AUTH_FAILED', 'RATE_LIMITED'].includes(e?.code);
}

/** Names of the configuration instances of `type` in EIO (the client answers [] when the list cannot be read). */
async function cfgNames(a, type) {
  return a.listCfgInstances ? a.listCfgInstances('EIO', type) : [];
}

/** Every signal name the I/O system lists (RWS 1.0 in pages of 100). */
async function signalNames(a, generation) {
  if (generation === 'rws2') { return (await a.listAllSignals()).map(s => s.name); }
  const names = [];
  for (let page = 0; page < 40; page++) {
    const list = await a.listAllSignals(page * 100, 100);
    names.push(...list.map(s => s.name));
    if (list.length < 100) { break; }
  }
  return names;
}

/** What of the fixture the controller has now: configuration instances, listed signals, the device on `Virtual`. */
async function fixtureState(a, ctrl) {
  const instances = fixtureInstances(ctrl.lane);
  const byType = new Map();
  for (const inst of instances) {
    if (!byType.has(inst.type)) { byType.set(inst.type, await cfgNames(a, inst.type)); }
  }
  const cfg = Object.fromEntries(instances.map(i => [i.name, byType.get(i.type).includes(i.name)]));
  const cfgRows = byType.get('EIO_SIGNAL').length;
  // Every controller has built-in EIO_SIGNAL instances; an empty list is a
  // failed read (the client answers [] then), not an empty configuration.
  const cfgReadable = cfgRows > 0;
  const listed = new Set(await signalNames(a, ctrl.generation));
  const signals = { [FIXTURE.di]: listed.has(FIXTURE.di), [FIXTURE.do]: listed.has(FIXTURE.do) };
  let device = null;
  if (ctrl.lane === 'rw7') {
    device = (await a.listDevices(FIXTURE.network).catch(() => [])).some(d => d.name === FIXTURE.device);
  }
  // What the I/O system runs was configured, so a fixture signal (or device)
  // it lists must be in the configuration list. One that is not means the list
  // read is incomplete: RWS 1.0 reads it in one request, and a controller that
  // pages the list (RWS 2.0 pages at 70 rows) would cut it at a page boundary.
  const cfgIncomplete = [
    ...[FIXTURE.di, FIXTURE.do].filter(n => signals[n] && !cfg[n]),
    ...(device && !cfg[FIXTURE.device] ? [FIXTURE.device] : []),
  ];
  return { cfg, cfgRows, cfgReadable, cfgIncomplete, signals, device };
}

/** Throw unless the configuration list was read, and read in full (see fixtureState). */
function requireCfgRead(state) {
  if (!state.cfgReadable) {
    throw new Error('the EIO_SIGNAL configuration list came back empty, which means the read failed - nothing was sent');
  }
  if (state.cfgIncomplete.length) {
    throw new Error(`the controller lists ${state.cfgIncomplete.join(', ')}, but the configuration list read (${state.cfgRows} EIO_SIGNAL rows) does not: `
      + 'the list read is incomplete, probably cut at a page boundary - nothing was sent');
  }
}

const all = rec => Object.values(rec).every(Boolean);
const none = rec => Object.values(rec).every(v => !v);

/** Both signals listed with their type, and on rw7 the device on `Virtual`. */
async function checkApplied(a, ctrl) {
  const s = await fixtureState(a, ctrl);
  if (!all(s.signals)) { return { ok: false, detail: `signals listed: ${JSON.stringify(s.signals)}` }; }
  const di = await a.readSignal('', '', FIXTURE.di);
  const dout = await a.readSignal('', '', FIXTURE.do);
  if (di.type !== 'DI' || dout.type !== 'DO') {
    return { ok: false, detail: `signal types ${FIXTURE.di}=${di.type} ${FIXTURE.do}=${dout.type}, expected DI and DO` };
  }
  if (ctrl.lane === 'rw7' && !s.device) { return { ok: false, detail: `${FIXTURE.device} is not listed on network ${FIXTURE.network}` }; }
  return { ok: true, detail: `listed: ${FIXTURE.di} (DI, ${di.lvalue}), ${FIXTURE.do} (DO, ${dout.lvalue})${ctrl.lane === 'rw7' ? `, ${FIXTURE.network}/${FIXTURE.device}` : ''}` };
}

/** Neither signal listed, and on rw7 no device. */
async function checkRemoved(a, ctrl) {
  const s = await fixtureState(a, ctrl);
  if (!none(s.signals)) { return { ok: false, detail: `signals still listed: ${JSON.stringify(s.signals)}` }; }
  if (ctrl.lane === 'rw7' && s.device) { return { ok: false, detail: `${FIXTURE.device} still listed on network ${FIXTURE.network}` }; }
  return { ok: true, detail: 'no fixture signal or device listed' };
}

/**
 * Wait for the controller to come back from the warm restart and pass
 * `check`: the known port first, and when it is silent a paced scan of this PC
 * (findControllers, this generation's VC process only) for
 * a controller of the same generation on a port no other controller held,
 * accepted only with the system id read before. One session is kept while it
 * works (one session per controller keeps the load low).
 * `check` runs only once the restart shows: the restart count above
 * `countBefore` (RWS 2.0), and an operation mode other than INIT (a freshly
 * restarted RW 7.21.4 read INIT for a moment).
 */
async function afterRestart(client, ctrl, otherPorts, countBefore, check) {
  const { RobotManager } = client;
  const deadline = Date.now() + TIMING.restartWindowMs;
  let port = ctrl.port;
  let https = ctrl.https;
  let silentRounds = 0;
  let adapter = null;
  let last = 'not answered yet';
  const drop = async () => { if (adapter) { const a = adapter; adapter = null; await a.disconnect().catch(() => undefined); } };
  await sleep(TIMING.stepMs);
  try {
    while (Date.now() < deadline) {
      if (!adapter) {
        const probe = await RobotManager.probeSpecificPort(HOST, port, false, 2000);
        const answers = probe && (probe.authType === 'digest' ? 'rws1' : 'rws2') === ctrl.generation;
        if (!answers) {
          silentRounds++;
          last = `port ${port} silent`;
          if (silentRounds >= 2 && silentRounds % 2 === 0) {
            const scanned = await findLocalControllers(client, { identify: ctrl.generation === 'rws2' ? 'anonymous' : 'none' })
              .then(r => r.rows, () => []);
            const moved = scanned.filter(d => d.generation === ctrl.generation && isVcOf(d, ctrl.generation)
              && !otherPorts.includes(d.port) && d.port !== port
              && (d.systemName === undefined || d.systemName === ctrl.systemName));
            for (const d of moved) {
              try {
                const who = await identify(client, d.port, d.https);
                if (sameController(who, ctrl)) {
                  say(ctrl.lane, `the controller moved from port ${port} to ${d.port}`);
                  port = d.port;
                  https = d.https;
                  break;
                }
              } catch { /* not ready, or not ours */ }
            }
          }
        } else {
          silentRounds = 0;
          try {
            const a = await client.createAdapter(connectOptions(port, probe.useHttps));
            const info = await a.getSystemInfo();
            if (!sameController({ sysid: info.sysid, systemName: info.name, rwVersion: info.rwVersion }, ctrl)) {
              await a.disconnect().catch(() => undefined);
              last = `port ${port} answers as another controller (${info.name})`;
            } else {
              adapter = a;
              https = probe.useHttps;
            }
          } catch (e) { last = `login: ${errText(e)}`; }
        }
      }
      if (adapter) {
        try {
          const count = countBefore === null ? null : await adapter.getRestartCount();
          const opmode = await adapter.getOperationMode();
          if (count !== null && count <= countBefore) {
            last = `restart count still ${count}`;
          } else if (opmode === 'INIT') {
            last = 'operation mode INIT';
          } else {
            const r = await check(adapter, ctrl);
            if (r.ok) { return { port, https, detail: `${r.detail}${count === null ? '' : `; restart count ${countBefore} -> ${count}`}` }; }
            last = r.detail;
          }
        } catch (e) {
          last = errText(e);
          if (isTransport(e)) { await drop(); }
        }
      }
      await sleep(TIMING.stepMs);
    }
  } finally {
    await drop();
  }
  throw new Error(`not confirmed within ${TIMING.restartWindowMs / 1000} s of the restart (last: ${last}); if it is still down, start it from RobotStudio`);
}

async function validateCfg(a, ctrl, filepath) {
  if (ctrl.generation === 'rws1') {
    await a.validateCfgFile(filepath, 'add');
    return 'accepted';
  }
  // RWS 2.0: no client call for it; the adapter's own request method (see the header).
  if (typeof a.req !== 'function') { throw new Error('this client build has no RWS 2.0 request method to send /rw/cfg/validate with'); }
  const body = await a.req('POST', '/rw/cfg/validate', { filepath, 'action-type': 'add' });
  const verdict = validateBodyVerdict(body);
  if (!verdict.ok) { throw new Error(`/rw/cfg/validate answered, but not as a pass: ${verdict.reason} (${scrubText(body).slice(0, 400)})`); }
  return `accepted (${verdict.reason})`;
}

/** Refuse before any change when the controller is not in a state for a load and a restart. */
async function preflight(a, ctrl) {
  const exec = await a.getRapidExecutionState();
  if (exec === 'running') { throw new Error('RAPID is running: stop it before a configuration load and a warm restart'); }
  if (ctrl.generation === 'rws2' && typeof a.listCfgTypeAttributes === 'function') {
    const names = async type => new Set((await a.listCfgTypeAttributes('EIO', type).catch(() => [])).map(r => r.name ?? r._title).filter(Boolean));
    const signalAttrs = await names('EIO_SIGNAL');
    const needed = ['Name', 'SignalType', 'Device', 'DeviceMap', 'Access'];
    if (signalAttrs.size > 0) {
      const missing = needed.filter(n => !signalAttrs.has(n));
      if (missing.length) { throw new Error(`EIO_SIGNAL on this build has no attribute ${missing.join(', ')} (it has ${[...signalAttrs].join(', ')})`); }
    }
    const deviceAttrs = await names('VIRTUAL_DEVICE');
    if (deviceAttrs.size > 0 && !deviceAttrs.has('Name')) { throw new Error(`VIRTUAL_DEVICE on this build has no Name attribute (it has ${[...deviceAttrs].join(', ')})`); }
    const networks = (await a.listNetworks()).map(n => n.name);
    if (!networks.includes(FIXTURE.network)) { throw new Error(`no network ${FIXTURE.network} on this controller (${networks.join(', ')})`); }
    return { deviceNetwork: deviceAttrs.size === 0 || deviceAttrs.has('Network'), deviceAttrs: [...deviceAttrs] };
  }
  return { deviceNetwork: true, deviceAttrs: [] };
}

/** RWS 2.0 restart count, or null (RWS 1.0 has none in the client; a failed read is null too). */
async function restartCount(a) {
  if (typeof a.getRestartCount !== 'function') { return null; }
  try { return await a.getRestartCount(); } catch { return null; }
}

/** Send the warm restart; returns the restart count read just before it (null where there is none). */
async function restart(a, ctrl) {
  if (ctrl.lane === 'rw6') {
    say(ctrl.lane, 'warm restart: if the RW6 virtual controller is still down afterwards, start it from RobotStudio');
  }
  const countBefore = await restartCount(a);
  await a.restartController('restart');
  say(ctrl.lane, `warm restart accepted${countBefore === null ? '' : ` (restart count ${countBefore} before it)`}`);
  return countBefore;
}

/**
 * Apply the fixture on one lane (see the header). `client` is the imported
 * package (createAdapter, RobotManager); `ctrl` the discovered controller;
 * `otherPorts` the ports of every other controller on this PC.
 */
export async function applyLane(client, ctrl, otherPorts) {
  const lane = ctrl.lane;
  let a = await client.createAdapter(connectOptions(ctrl.port, ctrl.https));
  let restarted = false;
  let countBefore = null;
  try {
    const before = await fixtureState(a, ctrl);
    say(lane, `before: ${JSON.stringify(before)}`, before);
    requireCfgRead(before);
    const signalsListed = all(before.signals);
    if (all(before.cfg) && signalsListed) {
      const r = await checkApplied(a, ctrl);
      if (!r.ok) { throw new Error(`the fixture is configured and listed, but ${r.detail}`); }
      say(lane, `already applied - nothing sent (${r.detail})`);
      return;
    }
    const pending = all(before.cfg) && none(before.signals);
    if (!pending && !(none(before.cfg) && none(before.signals))) {
      throw new Error(`the fixture is partly present (configuration ${JSON.stringify(before.cfg)}, signals ${JSON.stringify(before.signals)}): run with --remove first`);
    }
    const pre = await preflight(a, ctrl);
    if (pending) {
      say(lane, 'the fixture is configured but not active yet: only the warm restart is needed');
    } else {
      if (!pre.deviceNetwork) { say(lane, `VIRTUAL_DEVICE has no Network attribute here (${pre.deviceAttrs.join(', ')}): the device is written without one`); }
      const content = buildEioCfg(lane, { deviceNetwork: pre.deviceNetwork });
      const paths = cfgFilePaths(lane);
      writeTrace('fixture', 'cfg file', { upload: paths.upload, content });
      await a.uploadFile(paths.upload, content);
      say(lane, `uploaded ${paths.upload}`);
      try {
        await a.requestMastership('cfg');
        try {
          let loadPath = null;
          const refusals = [];
          for (const p of paths.load) {
            try {
              say(lane, `validate ${p} (action-type add): ${await validateCfg(a, ctrl, p)}`);
              loadPath = p;
              break;
            } catch (e) {
              refusals.push({ path: p, text: errText(e), notFound: isNotFound(e) });
              say(lane, `validate ${p} refused: ${errText(e)}`);
            }
          }
          if (!loadPath) { throw new Error(validateFailure(refusals)); }
          await a.loadCfgFile(loadPath, 'add');
          say(lane, `load ${loadPath} (action-type add) accepted`);
          const deadline = Date.now() + TIMING.loadSettleMs;
          let now = null;
          while (Date.now() < deadline) {
            now = await fixtureState(a, ctrl);
            if (all(now.cfg)) { break; }
            await sleep(Math.min(1000, TIMING.stepMs));
          }
          if (!now || !all(now.cfg)) {
            throw new Error(`the load was accepted, but the configuration does not list every fixture instance after ${TIMING.loadSettleMs / 1000} s `
              + `(${JSON.stringify(now?.cfg)}, ${now?.cfgRows ?? 0} EIO_SIGNAL rows read); see the controller's event log, and if the row count sits at a page size, the list read was cut`);
          }
          say(lane, 'the configuration lists every fixture instance');
        } finally {
          await a.releaseMastership('cfg').catch(e => say(lane, `mastership release failed: ${errText(e)}`));
        }
      } finally {
        await a.deleteFile(paths.upload).then(() => say(lane, `deleted ${paths.upload}`))
          .catch(e => say(lane, `could not delete ${paths.upload} (the suite's restore removes ZZ_PROBE files): ${errText(e)}`));
      }
    }
    countBefore = await restart(a, ctrl);
    restarted = true;
  } finally {
    await a.disconnect().catch(() => undefined);
    a = null;
  }
  if (restarted) {
    const back = await afterRestart(client, ctrl, otherPorts, countBefore, checkApplied);
    say(lane, `applied and active on port ${back.port}: ${back.detail}`);
  }
}

/** Remove the fixture on one lane (see the header); arguments as applyLane. */
export async function removeLane(client, ctrl, otherPorts) {
  const lane = ctrl.lane;
  const a = await client.createAdapter(connectOptions(ctrl.port, ctrl.https));
  let restarted = false;
  let countBefore = null;
  try {
    const before = await fixtureState(a, ctrl);
    say(lane, `before: ${JSON.stringify(before)}`, before);
    requireCfgRead(before);
    if (none(before.cfg) && none(before.signals) && !before.device) {
      say(lane, 'nothing to remove - nothing sent');
      return;
    }
    const exec = await a.getRapidExecutionState();
    if (exec === 'running') { throw new Error('RAPID is running: stop it before a configuration change and a warm restart'); }
    const present = removalOrder(lane).filter(i => before.cfg[i.name]);
    if (present.length) {
      await a.requestMastership('cfg');
      try {
        for (const inst of present) {
          assertProbeInstance(inst.name);
          await a.removeCfgInstance('EIO', inst.type, inst.name);
          say(lane, `removed EIO/${inst.type}/${inst.name}`);
        }
      } finally {
        await a.releaseMastership('cfg').catch(e => say(lane, `mastership release failed: ${errText(e)}`));
      }
    } else {
      say(lane, 'no fixture instance is configured any more: only the warm restart is needed');
    }
    countBefore = await restart(a, ctrl);
    restarted = true;
  } finally {
    await a.disconnect().catch(() => undefined);
  }
  if (restarted) {
    const back = await afterRestart(client, ctrl, otherPorts, countBefore, checkRemoved);
    say(lane, `removed, on port ${back.port}: ${back.detail}`);
  }
}

const USAGE = `npm run functional:fixtures [-- --remove | --print]

  RWS_FIXTURES_APPLY=1 RWS_FIXTURES_LANES=rw7,rw6 npm run functional:fixtures
      add ZZ_PROBE_DI1 / ZZ_PROBE_DO1 (rw7: on the virtual device ZZ_PROBE_DEV) and warm-restart
  RWS_FIXTURES_APPLY=1 RWS_FIXTURES_LANES=rw7 npm run functional:fixtures -- --remove
      delete them again and warm-restart
  npm run functional:fixtures -- --print
      print the CFG file of each lane; nothing is sent

rw8 is refused. Local virtual controllers only. Finding the lanes takes one
read-only login per controller tried; set RWS_TEST_PORT_RW7 / RWS_TEST_PORT_RW6
to try those ports first, so no other controller is logged in to.`;

async function main() {
  let opts;
  try {
    opts = parseOptions(process.argv.slice(2), process.env);
    assertLocalhost(HOST);
  } catch (e) {
    if (e instanceof FixtureRefusal) {
      console.error(`functional:fixtures: refused - ${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw e;
  }
  if (opts.help) { console.log(USAGE); return; }
  if (opts.print) {
    for (const lane of opts.lanes) {
      console.log(`--- ${lane}: ${cfgFilePaths(lane).upload}\n${buildEioCfg(lane)}`);
    }
    return;
  }

  output.trace = true;
  let client;
  try { client = await loadClient(); } catch (e) {
    console.error(`functional:fixtures: ${e.message}`);
    process.exit(2);
  }
  say('fleet', `${opts.mode} on ${opts.lanes.join(', ')}; trace in ${path.relative(root, traceDir)}`);
  const { found, ports } = await discover(client, opts.lanes);
  let failed = 0;
  for (const lane of opts.lanes) {
    traceLane = lane;
    const ctrl = found.get(lane);
    if (!ctrl) {
      say(lane, `no RobotWare ${lane.slice(2)} controller found on ${HOST} - skipped`);
      failed++;
      continue;
    }
    say(lane, `${ctrl.systemName} RobotWare ${ctrl.rwVersion} on port ${ctrl.port}`);
    try {
      const others = ports.filter(p => p !== ctrl.port);
      if (opts.mode === 'apply') { await applyLane(client, ctrl, others); } else { await removeLane(client, ctrl, others); }
    } catch (e) {
      failed++;
      say(lane, `FAILED: ${errText(e)}`, { error: errText(e) });
    }
  }
  traceLane = 'fleet';
  say('fleet', failed ? `${failed} lane(s) did not end as asked` : 'done');
  process.exit(failed ? 1 : 0);
}

/** Run as a script (not imported by the offline tests)? Compared by real path; case-blind on Windows. */
function invokedDirectly() {
  if (!process.argv[1]) { return false; }
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch(e => {
    console.error(`functional:fixtures: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  });
}
