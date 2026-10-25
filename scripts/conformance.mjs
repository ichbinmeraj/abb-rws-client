#!/usr/bin/env node
/**
 * `npm run conformance` - the RWS drift check.
 *
 *   node scripts/conformance.mjs           # crawl, diff, regenerate CONFORMANCE.md
 *   node scripts/conformance.mjs --strict  # non-zero exit if anything is unmapped
 *   node scripts/conformance.mjs --no-crawl # diff against the LAST crawl (offline)
 *   node scripts/conformance.mjs --ports 2302,9403 --gap 60
 *                                          # only these ports, in order, 60 s apart
 *   node scripts/conformance.mjs ... --carry-from old-crawl.json --carry 8.2.1
 *                                          --not-crawled "7.21.0: not running"
 *                                          # keep an earlier crawl of a build not live today
 *
 * Two sides:
 *   A. What the client CLAIMS - the path tables in src/paths (read from dist/).
 *   B. What the controllers HAVE - a live crawl of each generation's resource
 *      tree, following HAL `_links` from the documented roots. Each link is
 *      resolved against the base link its answer declares, not the request
 *      path (scripts/conformance-links.mjs); the walk, its roots and what it
 *      never reads are in scripts/conformance-crawl.mjs.
 *
 * The diff classifies every advertised resource FAMILY (instance names such as
 * devices, tasks and mechanical units become parameters, so a family counts
 * once; scripts/conformance-classify.mjs):
 *   implemented    - controller has it, a table entry or a claim names it
 *   deliberate-gap - a table entry or a claim marks it a gap with a reason
 *   unmapped       - controller has it, NOTHING claims it       <- the failure
 *   orphan         - a table entry claims a path no controller advertises
 *
 * Hard rules (inherited from the endpoint + structural loops):
 *   - localhost VCs only; refuse any other host outright
 *   - OPTIONS/GET only, never a write, and no GET that changes anything
 *     (a DIPC queue on RWS 2.0, whose GET takes a message off it)
 *   - >=100 ms between requests (the client's own spacing); reuse the session cookie (IRC5 caps at 70)
 *     and GET /logout on each controller once its crawl ends
 *   - ports drift every restart - discover, never assume
 *   - OPTIONS forms are served ONLY as application/xhtml+xml;v=2.0 on RWS 2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { byPreference, envPorts, findLocalControllers } from './local-controllers.mjs';
import { crawlTree, pruned, DEADLINE_MS as CRAWL_DEADLINE_MS } from './conformance-crawl.mjs';
import { classify, orphans, summarise } from './conformance-classify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRAWL_CACHE = path.join(root, 'docs', 'conformance', 'crawl.json');
const MAP_OUT = path.join(root, 'docs', 'conformance', 'map.json');
const REPORT = path.join(root, 'CONFORMANCE.md');

const strict = process.argv.includes('--strict');
const noCrawl = process.argv.includes('--no-crawl');
const argValue = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
// --ports 2302,9403: crawl only these ports, in this order, and touch no other.
const onlyPorts = (argValue('--ports') ?? '').split(',').map(Number).filter(p => Number.isInteger(p) && p > 0 && p < 65536);
// --gap 60: seconds to wait between one controller's crawl and the next.
const gapS = Number(argValue('--gap') ?? 0) || 0;
// --carry-from <crawl.json> --carry 8.2.1,7.21.0: builds (by RobotWare version
// text) whose earlier crawl is kept when this run does not crawl them.
const carryFrom = argValue('--carry-from');
const carryBuilds = (argValue('--carry') ?? '').split(',').map(s => s.trim()).filter(Boolean);
// --not-crawled "8.1.1+614: why; 7.21.0: why": builds left out of this run, named in the report.
const notCrawled = (argValue('--not-crawled') ?? '').split(';').map(s => s.trim()).filter(Boolean);

const USER = process.env.RWS_TEST_USER ?? 'Default User';
const PASS = process.env.RWS_TEST_PASS ?? 'robotics';
const HOST = '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  throw new Error('conformance crawl refuses non-localhost host');
}

// ─── side A: the path tables (from built dist) ───────────────────────────────

async function loadTables() {
  const entry = path.join(root, 'dist', 'paths', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error('conformance: dist/paths not built - run `npm run build` first');
    process.exit(2);
  }
  const mod = await import(`file://${entry}`);
  // ALL_TABLES: { domain: DomainTable }; flatten() from PathSpec.
  const { ALL_TABLES, flatten } = mod;
  if (!ALL_TABLES || !flatten) {
    console.error('conformance: dist/paths/index.js must export ALL_TABLES and flatten');
    process.exit(2);
  }
  return flatten(ALL_TABLES);
}

// ─── side B: live crawl ──────────────────────────────────────────────────────

let lastRequestAt = 0;
async function pace() {
  const wait = 100 - (Date.now() - lastRequestAt);
  if (wait > 0) { await new Promise(r => setTimeout(r, wait)); }
  lastRequestAt = Date.now();
}

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
/** True when a cookie jar holds an RWS session cookie (RWS 1.0 and 2.0 both send -http-session-). */
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

function once(ctl, pth, method, authHeader) {
  // Reads only: nothing in this script may send a write, whatever a link says.
  if (method !== 'GET' && method !== 'OPTIONS') { throw new Error(`conformance crawl refuses ${method}`); }
  const mod = ctl.tls ? https : http;
  const accept = ctl.gen === 1 ? 'application/xhtml+xml;v=1.0' : 'application/hal+json;v=2.0';
  const headers = { Accept: accept };
  const jar = cookies.get(ctl.port);
  if (jar) { headers.Cookie = jar; }
  if (authHeader) { headers.Authorization = authHeader; }
  const haveSession = hasSession(jar);
  const conf = {
    host: HOST, port: ctl.port, path: pth, method, timeout: 10000, headers,
    ...(ctl.tls ? { rejectUnauthorized: false } : {}),
    ...(ctl.auth === 'basic' && !authHeader && !haveSession ? { auth: `${USER}:${PASS}` } : {}),
  };
  return new Promise(resolve => {
    const r = mod.request(conf, res => {
      storeCookies(ctl.port, res);
      let body = '';
      res.on('data', c => { body += c; if (body.length > 262144) { r.destroy(); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout', body: '' }); });
    r.on('error', e => resolve({ status: 0, error: e.code || e.message, body: '' }));
    r.end();
  });
}

async function req(ctl, pth, method = 'GET') {
  await pace();
  let res = await once(ctl, pth, method, null);
  if (res.status === 401 && ctl.auth === 'digest' && res.headers['www-authenticate']) {
    await pace();
    res = await once(ctl, pth, method, digestHeader(res.headers['www-authenticate'], method, pth));
  }
  return res;
}

/**
 * End the crawl's session on one controller: one `GET /logout` on its session
 * cookie, so a run does not leave a session per controller until it expires (the
 * IRC5 holds at most 70). Sent only while a session cookie is held, and with no
 * credentials and no digest retry, so it never signs in only to sign out.
 */
async function logout(ctl) {
  if (!hasSession(cookies.get(ctl.port))) { cookies.delete(ctl.port); return; }
  await pace();
  // once() adds Basic credentials only when no session cookie is held.
  const res = await once(ctl, '/logout', 'GET', null);
  cookies.delete(ctl.port);
  if (res.status === 0 || res.status >= 400) {
    console.log(`  /logout on :${ctl.port} answered ${res.status || res.error}`);
  }
}

/**
 * Crawl one controller's tree (scripts/conformance-crawl.mjs) through req().
 * Each controller gets its own budget; CONFORMANCE_DEADLINE_S overrides the
 * deadline. `stats` comes back filled with how the walk ended.
 */
const DEADLINE_MS = Number(process.env.CONFORMANCE_DEADLINE_S) > 0
  ? Number(process.env.CONFORMANCE_DEADLINE_S) * 1000 : CRAWL_DEADLINE_MS;
const crawl = (ctl, stats) => crawlTree(node => req(ctl, node), ctl.gen, {
  deadlineMs: DEADLINE_MS, stats, log: msg => console.log(msg),
});

// ─── controller discovery (ports drift) ──────────────────────────────────────

/**
 * Every RWS controller on this PC, through the client's own `findControllers`
 * (loopback only, the VC process filter, one probe at a time). Every
 * controller that answers is crawled - RobotWare 7 and 8 are both RWS 2.0,
 * and both must be covered - so this keeps one entry per port, not one per
 * generation. The RWS_TEST_PORT_RW6 / _RW7 / _RW8 ports are probed as well and
 * crawled first. `auth` comes from the 401 challenge, not from the scheme.
 * With `--ports a,b,c` nothing else is touched: no scan of this PC, one
 * unauthenticated GET / on each named port (see probePort), crawled in that order.
 */
async function discover() {
  if (onlyPorts.length) {
    const out = [];
    for (const p of onlyPorts) {
      const ctl = await probePort(p);
      if (ctl) { out.push(ctl); } else { console.log(`conformance: :${p} did not answer as an RWS controller - skipped`); }
    }
    return out;
  }
  const client = await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
  const named = envPorts(msg => console.log(`conformance: ${msg}`));
  const { rows, result } = await findLocalControllers(client, {
    identify: 'anonymous', ports: [...named.keys()],
  });
  if (result.localScan.status !== 'ok') {
    console.log(`conformance: the listening-port scan of this PC did not answer (${result.localScan.status}); only RWS_TEST_PORT_* ports are crawled`);
  }
  return rows.sort(byPreference(named)).map(r => ({ port: r.port, tls: r.https, gen: r.generation === 'rws1' ? 1 : 2, auth: r.authType }));
}

/**
 * One named port, without a scan: GET / with no credentials, over HTTPS and
 * then HTTP. The 401 challenge gives the scheme: Digest is RWS 1.0 (IRC5),
 * Basic is RWS 2.0 (OmniCore). Null when the port does not answer that way.
 */
async function probePort(port) {
  for (const tls of [true, false]) {
    await pace();
    const res = await once({ port, tls, gen: tls ? 2 : 1 }, '/', 'GET', null);
    const ch = String(res.headers?.['www-authenticate'] ?? '');
    cookies.delete(port);
    if (res.status !== 401 || !ch) { continue; }
    if (/^Digest/i.test(ch)) { return { port, tls, gen: 1, auth: 'digest' }; }
    if (/^Basic/i.test(ch)) { return { port, tls, gen: 2, auth: 'basic' }; }
  }
  return null;
}

// ─── run ─────────────────────────────────────────────────────────────────────

const specs = await loadTables();

let crawlData;
if (noCrawl) {
  if (!fs.existsSync(CRAWL_CACHE)) {
    console.error('conformance: --no-crawl needs a previous crawl at docs/conformance/crawl.json');
    process.exit(2);
  }
  crawlData = JSON.parse(fs.readFileSync(CRAWL_CACHE, 'utf8'));
} else {
  const controllers = await discover();
  if (!controllers.length) {
    console.error('conformance: no live controller found on localhost - start a VC, or set RWS_TEST_PORT_RW6/RW7/RW8');
    process.exit(2);
  }
  // byGeneration is the union of every controller of that generation (what the
  // diff below uses: a resource any tested build advertises must be claimed);
  // byController keeps each crawl on its own, labelled with its RobotWare
  // version, and crawlStats how each walk ended.
  crawlData = { crawledAt: new Date().toISOString().slice(0, 10), byGeneration: {}, byController: {}, crawlStats: {} };
  for (const [i, ctl] of controllers.entries()) {
    if (i > 0 && gapS > 0) {
      console.log(`conformance: waiting ${gapS} s before the next controller`);
      await new Promise(r => setTimeout(r, gapS * 1000));
    }
    const gen = ctl.gen === 1 ? 'rws1' : 'rws2';
    try {
      const sysPath = ctl.gen === 1 ? '/rw/system?json=1' : '/rw/system';
      const sys = await req(ctl, sysPath);
      if (!(sys.status >= 200 && sys.status < 300)) {
        console.log(`conformance: :${ctl.port} GET /rw/system answered ${sys.status || sys.error} - skipped`);
        continue;
      }
      const rw = /"rwversion"\s*:\s*"([^"]+)"/.exec(sys.body ?? '')?.[1] ?? 'unknown';
      const label = `${gen} RW ${rw} :${ctl.port}`;
      console.log(`conformance: crawling ${label} from ${new Date().toISOString()} ...`);
      const stats = {};
      const found = await crawl(ctl, stats);
      crawlData.byController[label] = found;
      // The controller still answers after the walk: the same read again.
      const after = await req(ctl, sysPath);
      crawlData.crawlStats[label] = { ...stats, deadlineMs: DEADLINE_MS, systemAfter: after.status || after.error };
      if (!(after.status >= 200 && after.status < 300)) { console.log(`  GET /rw/system after the crawl answered ${after.status || after.error}`); }
      crawlData.byGeneration[gen] = [...new Set([...(crawlData.byGeneration[gen] ?? []), ...found])].sort();
      console.log(`  ${found.length} resources advertised, ${stats.probed} probed in ${Math.round(stats.elapsedMs / 1000)} s${stats.complete ? '' : ' - INCOMPLETE'}`);
    } finally {
      await logout(ctl);
    }
  }
  fs.mkdirSync(path.dirname(CRAWL_CACHE), { recursive: true });
  fs.writeFileSync(CRAWL_CACHE, JSON.stringify(crawlData, null, 1));
}

if (notCrawled.length) {
  crawlData.notCrawled = notCrawled;
  fs.writeFileSync(CRAWL_CACHE, JSON.stringify(crawlData, null, 1));
}

// An earlier crawl of a build that is not running today (--carry-from/--carry).
if (carryFrom) {
  crawlData.crawlStats ??= {};
  const old = JSON.parse(fs.readFileSync(carryFrom, 'utf8'));
  const buildOf = label => / RW ([^ ]+)/.exec(label)?.[1] ?? '';
  const crawledNow = Object.keys(crawlData.byController).map(buildOf);
  for (const [label, found] of Object.entries(old.byController ?? {})) {
    const rw = buildOf(label);
    if (!carryBuilds.some(b => rw.startsWith(b)) || crawledNow.some(v => v.startsWith(rw))) { continue; }
    const gen = label.startsWith('rws1') ? 'rws1' : 'rws2';
    crawlData.byController[label] = found;
    crawlData.crawlStats[label] = { ...(old.crawlStats?.[label] ?? {}), carriedFrom: old.crawledAt };
    crawlData.byGeneration[gen] = [...new Set([...(crawlData.byGeneration[gen] ?? []), ...found])].sort();
    console.log(`conformance: kept ${label} from the ${old.crawledAt} crawl (${found.length} resources)`);
  }
  fs.writeFileSync(CRAWL_CACHE, JSON.stringify(crawlData, null, 1));
}

// ─── diff ────────────────────────────────────────────────────────────────────
//
// The two sides live at different granularities: the crawl finds the
// RESOURCE tree, nodes and instances alike, while the tables encode
// OPERATIONS. scripts/conformance-classify.mjs first rewrites every node to its
// family (a device, task, mechanical unit, axis or I/O network name becomes a
// parameter), so one hardware device with forty properties is one family, not
// forty-one rows, and two builds with different devices give the same
// families. Each family then gets one verdict: a claim the tables do not carry
// (CLAIMS, each with its methods or its reason), else the most specific table
// entry (exact, beneath, then ancestor), else unmapped.

const rows = [];
for (const gen of ['rws1', 'rws2']) {
  const advertised = crawlData.byGeneration[gen];
  if (!advertised || !advertised.length) { continue; }
  rows.push(...classify(advertised, gen, specs), ...orphans(advertised, gen, specs, pruned));
}

// One build on its own: the same classification over its own crawl.
const builds = Object.entries(crawlData.byController ?? {}).map(([label, found]) => {
  const gen = label.startsWith('rws1') ? 'rws1' : 'rws2';
  const own = classify(found, gen, specs);
  return {
    label, gen, nodes: found.length, families: own.length,
    summary: summarise(own), stats: crawlData.crawlStats?.[label] ?? null,
  };
});

// ─── write map.json + CONFORMANCE.md ─────────────────────────────────────────

const summary = summarise(rows);

fs.mkdirSync(path.dirname(MAP_OUT), { recursive: true });
fs.writeFileSync(MAP_OUT, JSON.stringify({
  crawledAt: crawlData.crawledAt,
  counting: 'families',
  summary,
  builds: builds.map(b => ({ build: b.label, nodes: b.nodes, families: b.families, summary: b.summary, crawl: b.stats })),
  rows,
}, null, 1) + '\n');

const badge = { implemented: 'ok', 'deliberate-gap': 'gap', unmapped: '**UNMAPPED**', orphan: '**ORPHAN**' };

// Crawls that all read /rw but nothing below it were made while the crawler
// resolved links against the request path: the children of /rw read as
// /rw/rw/... and were never found. Their counts leave out the whole /rw tree,
// so the report says so instead of reading as full coverage.
const crawls = Object.values(crawlData.byController ?? {}).length
  ? Object.values(crawlData.byController) : Object.values(crawlData.byGeneration ?? {});
const stoppedAtRw = crawls.length > 0
  && crawls.every(found => found.includes('/rw') && !found.some(p => p.startsWith('/rw/')));
const rwNote = !stoppedAtRw ? '' : `**Not covered: anything below \`/rw\`.** None of these crawls got below \`/rw\`,
so the services under it (RAPID, I/O, configuration, event log, motion system,
panel and the rest) are not in these counts. The crawler resolved each link
against the request path instead of the base link the answer declares, and read
the children of \`/rw\` as \`/rw/rw/...\`. It now follows the declared base, so a
new crawl reaches that tree.

`;

const crawlCell = s => {
  if (!s) { return 'not recorded'; }
  if (s.carriedFrom && s.probed === undefined) { return `not live today: kept from the ${s.carriedFrom} crawl, completeness not recorded`; }
  const t = `${s.probed} probed, ${Math.round(s.elapsedMs / 1000)} s${s.systemAfter !== undefined ? `, /rw/system after: ${s.systemAfter}` : ''}`;
  if (s.complete) { return `complete (${t})`; }
  if (s.stoppedAnswering) { return `**incomplete**: the crawl got no answers (3 reads in a row with no answer within 10 s, last ${s.stoppedAnswering}),${s.queued} left unread (${t})`; }
  return `**incomplete**: ${s.deadlineHit ? `deadline (${Math.round(s.deadlineMs / 1000)} s) hit` : 'node cap hit'}, ${s.queued} left unread (${t})`;
};

const nodeTotal = Object.values(crawlData.byGeneration ?? {}).reduce((n, g) => n + g.length, 0);
let md = `# RWS conformance

Does the client cover what the controllers actually advertise? This diffs the
path tables in \`src/paths\` against a live crawl of each controller's resource
tree. Regenerate with \`npm run conformance\`.

**${summary.implemented} implemented · ${summary['deliberate-gap']} deliberate-gap · ${summary.unmapped} unmapped · ${summary.orphan} orphan** (resource families, from the last crawl, ${crawlData.crawledAt})

The counts are of resource **families**, not nodes: a node whose path holds an
instance name (a hardware device or device property under \`/rw/devices\`, a
RAPID task, mechanical unit, axis, I/O network or device, a configuration or
mastership domain) counts once with the family, with the name as a parameter.
The ${nodeTotal} advertised nodes of both generations fall into ${rows.filter(r => r.verdict !== 'orphan').length} families.
A family any crawled build advertises must be claimed.

${rwNote}${(crawlData.notCrawled ?? []).length ? `Not crawled in this run: ${crawlData.notCrawled.join('; ')}.\n\n` : ''}| Build | Nodes | Families | Implemented | Gap | Unmapped | Crawl |
|---|---|---|---|---|---|---|
${builds.map(b => `| ${b.label} | ${b.nodes} | ${b.families} | ${b.summary.implemented} | ${b.summary['deliberate-gap']} | ${b.summary.unmapped} | ${crawlCell(b.stats)} |`).join('\n') || '| not recorded (crawl made before per-controller labels) | | | | | | |'}

- **implemented** — a table entry claims the family: one at that path
  (exact), one under it (beneath: the client does something in it), or one
  above it (ancestor: the entry's resource lists or acts on it). Families
  the tables do not name but the client reads (\`/rw/retcode\`, the
  \`/rw/devices\` tree) are claimed in \`scripts/conformance-classify.mjs\`
  with the methods that read them.
- **deliberate-gap** — claimed as a gap, with the reason below.
- **unmapped** — the controller advertises it and nothing claims it. This is
  the drift the check exists to catch: a new endpoint after a RobotWare
  upgrade, or one the client never wrapped.
- **orphan** — a table entry whose path no controller advertises. A typo, or an
  endpoint ABB removed.

`;
for (const gen of ['rws1', 'rws2']) {
  const g = rows.filter(r => r.gen === gen);
  if (!g.length) { continue; }
  md += `## ${gen === 'rws1' ? 'RWS 1.0 (IRC5)' : 'RWS 2.0 (OmniCore)'}\n\n`;
  const s = summarise(g);
  const ancestorOnly = g.filter(r => r.verdict === 'implemented' && r.match === 'ancestor').length;
  md += `${s.implemented} implemented (${ancestorOnly} of them through an ancestor entry only) · ${s['deliberate-gap']} deliberate-gap · ${s.unmapped} unmapped · ${s.orphan} orphan, over ${crawlData.byGeneration[gen].length} nodes.\n\n`;
  const notOk = g.filter(r => r.verdict !== 'implemented');
  if (notOk.length) {
    md += `| Family | Nodes | Verdict | Claimed by / reason |\n|---|---|---|---|\n`;
    for (const r of notOk) {
      const why = [r.by, r.reason].filter(Boolean).join(' — ') || '-';
      md += `| \`${r.resource}\` | ${r.instances} | ${badge[r.verdict]} | ${why} |\n`;
    }
    md += `\n`;
  } else {
    md += `Every advertised family the crawl reached is claimed.\n\n`;
  }
}
fs.writeFileSync(REPORT, md);

// ─── report ──────────────────────────────────────────────────────────────────

console.log('\nconformance (resource families)');
for (const [k, v] of Object.entries(summary)) { console.log(`  ${k.padEnd(16)} ${v}`); }
for (const b of builds) {
  console.log(`  ${b.label}: ${b.summary.implemented} / ${b.summary['deliberate-gap']} / ${b.summary.unmapped} over ${b.families} families (${b.nodes} nodes)${b.stats && b.stats.probed !== undefined && !b.stats.complete ? ' INCOMPLETE' : ''}`);
}
console.log(`\n  wrote ${path.relative(root, MAP_OUT)} and ${path.relative(root, REPORT)}\n`);

if (strict && (summary.unmapped > 0 || summary.orphan > 0)) { process.exit(1); }
