#!/usr/bin/env node
/**
 * `npm run vc-ready` - which RobotStudio virtual controllers on this PC are
 * ready for a live run, one lane per RobotWare major (rw6 / rw7 / rw8).
 *
 *   npm run vc-ready                      every lane; exit 0 only when all three answer
 *   npm run vc-ready -- --lanes rw7,rw8   exit 0 only when these lanes answer
 *   npm run vc-ready -- --json            one JSON document instead of the table
 *
 * Per controller found on 127.0.0.1 (the client's own `findControllers`, loopback
 * only, one probe at a time): three reads, `GET /rw/system`, `GET /rw/panel/opmode`
 * and `GET /rw/panel/ctrl-state` (RWS 1.0: `/rw/panel/ctrlstate`), then `GET /logout` so the check leaves no
 * session behind (an IRC5 holds at most 70). A lane is ready when a controller
 * of that lane answered all three reads; the operating mode and the controller
 * state are printed for the person, not judged. Exit 0 when every requested
 * lane is ready, 1 when one is down, 2 when the check could not run.
 *
 * Used by `npm run functional` (lanes whose VC is down are skipped instead of
 * failing), the extension's host harness and the smoke runbook. Reads only:
 * nothing here can send a write.
 *
 * Test infrastructure only - never shipped in the package.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertLocalhost, byPreference, envPorts, findLocalControllers } from './local-controllers.mjs';

const HOST = '127.0.0.1';
const LANES = ['rw6', 'rw7', 'rw8'];
/** The three reads per generation: RWS 1.0 spells the controller state `ctrlstate` (the path tables' one hyphen rename in the panel domain). */
const READS = { 1: ['/rw/system', '/rw/panel/opmode', '/rw/panel/ctrlstate'], 2: ['/rw/system', '/rw/panel/opmode', '/rw/panel/ctrl-state'] };

// ─── Pure parts (unit-tested offline) ────────────────────────────────────────

/**
 * One field of an RWS answer: hal+json (`"name":"value"`), the RWS 1.0
 * `?json=1` shape (the same) or the XHTML span (`<span class="name">value</span>`).
 * Null when the body does not carry it.
 */
export function parseField(body, name) {
  if (!body) { return null; }
  const json = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(body);
  if (json) { return json[1]; }
  const span = new RegExp(`<span[^>]*class="${name}"[^>]*>([^<]*)</span>`).exec(body);
  return span ? span[1].trim() : null;
}

/** The lane a controller belongs to: RWS 1.0 is rw6; RWS 2.0 by RobotWare major. */
export function laneOf(gen, rwVersion) {
  if (gen === 1) { return 'rw6'; }
  const m = /^\s*(\d+)\./.exec(rwVersion ?? '');
  const lane = m ? `rw${m[1]}` : null;
  return lane && LANES.includes(lane) ? lane : null;
}

/** `--lanes rw7,rw8`: unknown words are ignored; nothing means every lane. */
export function parseLanes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') { return [...LANES]; }
  return String(raw).split(',').map(s => s.trim().toLowerCase()).filter(s => LANES.includes(s));
}

/**
 * The three reads and the logout on one controller, through `probe`
 * (`(target, path) => Promise<{ status, body, error? }>`). Returns the table
 * row: a field is null when its read did not answer 2xx or did not carry it.
 */
export async function assessController(target, probe) {
  const row = {
    lane: null, port: target.port, robotware: null, system: null, opmode: null, ctrlstate: null,
    ready: false, problem: null,
  };
  const problems = [];
  const answers = {};
  const reads = READS[target.gen] ?? READS[2];
  for (const p of reads) {
    let a;
    try { a = await probe(target, p); } catch (e) { a = { status: 0, error: e instanceof Error ? e.message : String(e), body: '' }; }
    answers[p] = a;
    if (!(a.status >= 200 && a.status < 300)) {
      problems.push(`${p.replace('/rw/panel/', '').replace('/rw/', '')} answered ${a.status || a.error || 'nothing'}`);
      // A controller that does not answer the first read is not asked again.
      if (a.status === 0 && p === reads[0]) { break; }
    }
  }
  const sys = answers['/rw/system'];
  if (sys && sys.status >= 200 && sys.status < 300) {
    row.robotware = parseField(sys.body, 'rwversion');
    row.system = parseField(sys.body, 'name');
  }
  const op = answers['/rw/panel/opmode'];
  if (op && op.status >= 200 && op.status < 300) { row.opmode = parseField(op.body, 'opmode'); }
  const cs = answers[reads[2]];
  if (cs && cs.status >= 200 && cs.status < 300) { row.ctrlstate = parseField(cs.body, 'ctrlstate'); }
  row.lane = row.robotware !== null || target.gen === 1 ? laneOf(target.gen, row.robotware) : null;
  if (sys && sys.status !== 0) {
    // The logout is skipped only when nothing answered: there is no session to end.
    try { await probe(target, '/logout'); } catch { /* best effort */ }
  }
  row.ready = problems.length === 0 && row.opmode !== null && row.ctrlstate !== null;
  if (problems.length === 0 && !row.ready) { problems.push('opmode or ctrlstate could not be read from the answer'); }
  row.problem = problems.length ? problems.join('; ') : null;
  return row;
}

/** Every controller, one after another (to keep the load on the virtual controllers low). */
export async function checkControllers(targets, probe) {
  const rows = [];
  for (const t of targets) { rows.push(await assessController(t, probe)); }
  return rows;
}

/** Lane verdicts over the rows: a lane is ready when one of its controllers is. */
export function summarise(rows, lanes) {
  const verdict = {};
  for (const lane of LANES) {
    verdict[lane] = rows.some(r => r.lane === lane && r.ready) ? 'ready' : 'down';
  }
  const ready = lanes.filter(l => verdict[l] === 'ready');
  const down = lanes.filter(l => verdict[l] !== 'ready');
  return { rows, lanes: verdict, requested: lanes, ready, down, exitCode: down.length === 0 ? 0 : 1 };
}

/** The table for a person: one line per controller, then one verdict per requested lane. */
export function renderTable(summary) {
  const cols = ['lane', 'port', 'RobotWare', 'system', 'opmode', 'ctrlstate', 'ready'];
  const lines = summary.rows.map(r => [
    r.lane ?? '-', String(r.port), r.robotware ?? '-', r.system ?? '-', r.opmode ?? '-', r.ctrlstate ?? '-', r.ready ? 'yes' : 'no',
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...lines.map(l => l[i].length)));
  const fmt = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [fmt(cols), ...lines.map(fmt)];
  for (const r of summary.rows) { if (r.problem) { out.push(`  :${r.port}: ${r.problem}`); } }
  out.push('');
  for (const lane of summary.requested) { out.push(`${lane}: ${summary.lanes[lane]}`); }
  return out.join('\n');
}

// ─── The wire (reads only; Basic until a session cookie, Digest for RWS 1.0) ─

const USER = process.env.RWS_TEST_USER ?? 'Default User';
const PASS = process.env.RWS_TEST_PASS ?? 'robotics';
const TIMEOUT_MS = 10000;

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const nonceCounters = new Map();
function digestHeader(challenge, method, uri) {
  const p = Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
  const nc = (nonceCounters.get(p.nonce) || 0) + 1;
  nonceCounters.set(p.nonce, nc);
  const ncStr = String(nc).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${USER}:${p.realm}:${PASS}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = p.qop?.split(',')[0].trim();
  const response = qop
    ? md5(`${ha1}:${p.nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${p.nonce}:${ha2}`);
  let h = `Digest username="${USER}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${response}"`;
  if (p.opaque) { h += `, opaque="${p.opaque}"`; }
  if (p.algorithm) { h += `, algorithm=${p.algorithm}`; }
  if (qop) { h += `, qop=${qop}, nc=${ncStr}, cnonce="${cnonce}"`; }
  return h;
}

const cookies = new Map();
const hasSession = jar => Boolean(jar) && /-http-session-|ABBCX/.test(jar);
function storeCookies(port, res) {
  const set = res.headers['set-cookie'];
  if (!set) { return; }
  const jar = new Map();
  const prev = cookies.get(port);
  if (prev) { for (const kv of prev.split('; ')) { const i = kv.indexOf('='); if (i > 0) { jar.set(kv.slice(0, i), kv.slice(i + 1)); } } }
  for (const line of set) { const first = line.split(';')[0]; const i = first.indexOf('='); if (i > 0) { jar.set(first.slice(0, i), first.slice(i + 1)); } }
  cookies.set(port, [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
}

let lastRequestAt = 0;
async function pace() {
  const wait = 100 - (Date.now() - lastRequestAt);
  if (wait > 0) { await new Promise(r => setTimeout(r, wait)); }
  lastRequestAt = Date.now();
}

function once(target, pth, authHeader) {
  assertLocalhost(HOST, 'vc-ready');
  const mod = target.tls ? https : http;
  const accept = target.gen === 1 ? 'application/xhtml+xml;v=1.0' : 'application/hal+json;v=2.0';
  const headers = { Accept: accept };
  const jar = cookies.get(target.port);
  if (jar) { headers.Cookie = jar; }
  if (authHeader) { headers.Authorization = authHeader; }
  const haveSession = hasSession(jar);
  const conf = {
    host: HOST, port: target.port, path: pth, method: 'GET', timeout: TIMEOUT_MS, headers,
    ...(target.tls ? { rejectUnauthorized: false } : {}),
    // Credentials only until a session cookie is held: re-sending them mints a new session each time.
    ...(target.auth === 'basic' && !authHeader && !haveSession ? { auth: `${USER}:${PASS}` } : {}),
  };
  return new Promise(resolve => {
    const r = mod.request(conf, res => {
      storeCookies(target.port, res);
      let body = '';
      res.on('data', c => { body += c; if (body.length > 262144) { r.destroy(); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout', body: '' }); });
    r.on('error', e => resolve({ status: 0, error: e.code || e.message, body: '' }));
    r.end();
  });
}

/** The real probe: one GET, with the Digest retry RWS 1.0 needs; the logout drops the jar. */
export async function wireProbe(target, pth) {
  if (pth === '/logout' && !hasSession(cookies.get(target.port))) { cookies.delete(target.port); return { status: 204, body: '' }; }
  await pace();
  let res = await once(target, pth, null);
  if (res.status === 401 && target.auth === 'digest' && res.headers?.['www-authenticate'] && pth !== '/logout') {
    await pace();
    res = await once(target, pth, digestHeader(res.headers['www-authenticate'], 'GET', pth));
  }
  if (pth === '/logout') { cookies.delete(target.port); }
  return res;
}

// ─── Discovery and main ──────────────────────────────────────────────────────

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The controllers on this PC as probe targets, through the built client. */
export async function discoverTargets(say = () => {}) {
  const entry = path.join(root, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error('dist/ is not built - run `npm run build` first');
  }
  const client = await import(pathToFileURL(entry).href);
  const named = envPorts(say);
  const { rows } = await findLocalControllers(client, { identify: 'none', ports: [...named.keys()] });
  rows.sort(byPreference(named));
  return rows.map(r => ({
    port: r.port, tls: r.https === true, gen: r.generation === 'rws1' ? 1 : 2,
    auth: r.generation === 'rws1' ? 'digest' : 'basic',
  }));
}

/** The whole check: discover, read, summarise. */
export async function checkLanes(lanes, { probe = wireProbe, say = () => {} } = {}) {
  const targets = await discoverTargets(say);
  const rows = await checkControllers(targets, probe);
  return summarise(rows, lanes);
}

function argValue(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const lanes = parseLanes(argValue('--lanes'));
  const json = process.argv.includes('--json');
  let summary;
  try {
    summary = await checkLanes(lanes, { say: m => console.error(`vc-ready: ${m}`) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) { console.log(JSON.stringify({ error: msg, requested: lanes })); } else { console.error(`vc-ready: ${msg}`); }
    process.exit(2);
  }
  if (json) {
    console.log(JSON.stringify({ requested: summary.requested, lanes: summary.lanes, ready: summary.ready, down: summary.down, controllers: summary.rows }, null, 2));
  } else {
    console.log(renderTable(summary));
  }
  process.exit(summary.exitCode);
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

if (invokedDirectly()) { await main(); }
