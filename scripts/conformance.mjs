#!/usr/bin/env node
/**
 * `npm run conformance` - the RWS drift check.
 *
 *   node scripts/conformance.mjs           # crawl, diff, regenerate CONFORMANCE.md
 *   node scripts/conformance.mjs --strict  # non-zero exit if anything is unmapped
 *   node scripts/conformance.mjs --no-crawl # diff against the LAST crawl (offline)
 *
 * Two sides:
 *   A. What the client CLAIMS - the path tables in src/paths (read from dist/).
 *   B. What the controllers HAVE - a live crawl of each generation's resource
 *      tree, following HAL `_links` from the documented roots.
 *
 * The diff classifies every advertised resource:
 *   implemented    - controller has it, a table entry claims it
 *   excluded       - controller refuses it (recorded with its status)
 *   deliberate-gap - table marks it a gap with a reason
 *   unmapped       - controller has it, NOTHING claims it       <- the failure
 *   orphan         - a table entry claims a path no controller advertises
 *
 * Hard rules (inherited from the endpoint + structural loops):
 *   - localhost VCs only; refuse any other host outright
 *   - OPTIONS/GET only, never a write
 *   - >=55 ms between requests; reuse the session cookie (IRC5 caps at 70)
 *   - ports drift every restart - discover, never assume
 *   - OPTIONS forms are served ONLY as application/xhtml+xml;v=2.0 on RWS 2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRAWL_CACHE = path.join(root, 'docs', 'conformance', 'crawl.json');
const MAP_OUT = path.join(root, 'docs', 'conformance', 'map.json');
const REPORT = path.join(root, 'CONFORMANCE.md');

const strict = process.argv.includes('--strict');
const noCrawl = process.argv.includes('--no-crawl');

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

/** A live resource path, stripped of query and with parameter segments generalised. */
function normalise(p) {
  const bare = p.split('?')[0].replace(/\/+$/, '');
  return bare || '/';
}

/**
 * Turn a table path template into a matcher: `{param}` -> a single non-slash
 * segment. So `/rw/rapid/tasks/{task}/pcp/reset` matches the live
 * `/rw/rapid/tasks/T_ROB1/pcp/reset`.
 */
function templateToRegex(tmpl) {
  const escaped = normalise(tmpl).replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '{' || ch === '}' ? ch : `\\${ch}`));
  const pattern = escaped.replace(/\\?\{(\w+)\\?\}/g, '[^/]+');
  return new RegExp(`^${pattern}$`);
}

// ─── side B: live crawl ──────────────────────────────────────────────────────

let lastRequestAt = 0;
async function pace() {
  const wait = 55 - (Date.now() - lastRequestAt);
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
  const mod = ctl.tls ? https : http;
  const accept = ctl.gen === 1 ? 'application/xhtml+xml;v=1.0' : 'application/hal+json;v=2.0';
  const headers = { Accept: accept };
  const jar = cookies.get(ctl.port);
  if (jar) { headers.Cookie = jar; }
  if (authHeader) { headers.Authorization = authHeader; }
  const haveSession = jar && /-http-session-|ABBCX/.test(jar);
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

/** Collect hrefs from a HAL or XHTML body, resolved against the current path. */
function childLinks(body, gen, base) {
  const hrefs = new Set();
  if (gen === 2) {
    for (const m of body.matchAll(/"href"\s*:\s*"([^"]+)"/g)) { hrefs.add(m[1]); }
  } else {
    for (const m of body.matchAll(/href="([^"]+)"/g)) { hrefs.add(m[1]); }
  }
  const out = new Set();
  for (const h of hrefs) {
    if (!h || h.startsWith('#') || /^wss?:\/\//i.test(h)) { continue; }
    let abs;
    try { abs = new URL(h, `http://x${base.endsWith('/') ? base : base + '/'}`).pathname; }
    catch { continue; }
    out.add(normalise(abs));
  }
  return [...out];
}

const ROOTS = ['/rw', '/ctrl', '/users', '/uas', '/fileservice', '/subscription'];

async function crawl(ctl, maxNodes = 400) {
  const seen = new Set();
  const advertised = new Set();
  const queue = [...ROOTS];
  while (queue.length && seen.size < maxNodes) {
    const node = normalise(queue.shift());
    if (seen.has(node)) { continue; }
    seen.add(node);
    const res = await req(ctl, node);
    if (res.status >= 200 && res.status < 300) {
      advertised.add(node);
      for (const child of childLinks(res.body, ctl.gen, node)) {
        if (!seen.has(child) && child.startsWith('/') && child.length > node.length) {
          queue.push(child);
        }
      }
    }
  }
  return [...advertised].sort();
}

// ─── controller discovery (ports drift) ──────────────────────────────────────

function probeGen(port, tls) {
  return new Promise(resolve => {
    const mod = tls ? https : http;
    const r = mod.request({ host: HOST, port, path: '/rw/system', timeout: 2500, ...(tls ? { rejectUnauthorized: false } : {}) }, res => {
      const c = String(res.headers['www-authenticate'] ?? '');
      res.resume();
      resolve(/digest/i.test(c) ? 1 : /basic/i.test(c) ? 2 : null);
    });
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.on('error', () => resolve(null));
    r.end();
  });
}

async function discover() {
  const found = [];
  const seen = new Set();
  const hints = [
    { port: Number(process.env.RWS_TEST_PORT_RW6 ?? 29228), tls: false },
    { port: Number(process.env.RWS_TEST_PORT_RW7 ?? 9403), tls: true },
    { port: 5466, tls: true }, { port: 9805, tls: true }, { port: 35112, tls: false },
  ];
  for (const h of hints) {
    if (seen.has(h.port)) { continue; }
    const gen = await probeGen(h.port, h.tls);
    if (gen && !found.some(c => c.gen === gen)) {
      seen.add(h.port);
      found.push({ port: h.port, tls: h.tls, gen, auth: h.tls ? 'basic' : 'digest' });
    }
  }
  return found;
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
    console.error('conformance: no live controller found on localhost - start a VC, or set RWS_TEST_PORT_RW6/RW7');
    process.exit(2);
  }
  crawlData = { crawledAt: new Date().toISOString().slice(0, 10), byGeneration: {} };
  for (const ctl of controllers) {
    const gen = ctl.gen === 1 ? 'rws1' : 'rws2';
    console.log(`conformance: crawling ${gen} on :${ctl.port} ...`);
    crawlData.byGeneration[gen] = await crawl(ctl);
    console.log(`  ${crawlData.byGeneration[gen].length} resources advertised`);
  }
  fs.mkdirSync(path.dirname(CRAWL_CACHE), { recursive: true });
  fs.writeFileSync(CRAWL_CACHE, JSON.stringify(crawlData, null, 1));
}

// ─── diff ────────────────────────────────────────────────────────────────────

const rows = [];
for (const gen of ['rws1', 'rws2']) {
  const advertised = crawlData.byGeneration[gen];
  if (!advertised) { continue; }
  const genSpecs = specs.filter(s => s.generation === gen);
  const matchers = genSpecs.map(s => ({ ...s, re: templateToRegex(s.spec.path) }));

  // Which advertised resources does a table entry claim?
  const claimed = new Set();
  for (const res of advertised) {
    const hit = matchers.find(m => m.re.test(res));
    if (hit) {
      claimed.add(res);
      rows.push({ gen, resource: res, verdict: hit.spec.gap ? 'deliberate-gap' : 'implemented', by: `${hit.domain}.${hit.operation}` });
    } else {
      rows.push({ gen, resource: res, verdict: 'unmapped', by: '' });
    }
  }
  // Table entries that matched nothing advertised - orphans (typo or removed).
  for (const m of matchers) {
    if (m.spec.gap) { continue; } // deliberate gaps need not be advertised
    const matchedSomething = advertised.some(r => m.re.test(r));
    if (!matchedSomething) {
      rows.push({ gen, resource: m.spec.path, verdict: 'orphan', by: `${m.domain}.${m.operation}` });
    }
  }
}

// ─── write map.json + CONFORMANCE.md ─────────────────────────────────────────

const count = v => rows.filter(r => r.verdict === v).length;
const summary = {
  implemented: count('implemented'),
  'deliberate-gap': count('deliberate-gap'),
  unmapped: count('unmapped'),
  orphan: count('orphan'),
};

fs.mkdirSync(path.dirname(MAP_OUT), { recursive: true });
fs.writeFileSync(MAP_OUT, JSON.stringify({ crawledAt: crawlData.crawledAt, summary, rows }, null, 1) + '\n');

const badge = { implemented: 'ok', 'deliberate-gap': 'gap', unmapped: '**UNMAPPED**', orphan: '**ORPHAN**' };
let md = `# RWS conformance

Does the client cover what the controllers actually advertise? This diffs the
path tables in \`src/paths\` against a live crawl of each generation's resource
tree. Regenerate with \`npm run conformance\`.

**${summary.implemented} implemented · ${summary['deliberate-gap']} deliberate-gap · ${summary.unmapped} unmapped · ${summary.orphan} orphan** (crawled ${crawlData.crawledAt})

- **unmapped** — the controller advertises it and nothing in the tables claims
  it. This is the drift the check exists to catch: a new endpoint after a
  RobotWare upgrade, or one the client never wrapped.
- **orphan** — a table entry whose path no controller advertises. A typo, or an
  endpoint ABB removed.

`;
for (const gen of ['rws1', 'rws2']) {
  const g = rows.filter(r => r.gen === gen);
  if (!g.length) { continue; }
  md += `## ${gen === 'rws1' ? 'RWS 1.0 (IRC5)' : 'RWS 2.0 (OmniCore)'}\n\n`;
  const problems = g.filter(r => r.verdict === 'unmapped' || r.verdict === 'orphan');
  if (problems.length) {
    md += `| Resource | Verdict | Table entry |\n|---|---|---|\n`;
    for (const r of problems) { md += `| \`${r.resource}\` | ${badge[r.verdict]} | ${r.by || '-'} |\n`; }
    md += `\n`;
  } else {
    md += `Every advertised resource is claimed by a table entry.\n\n`;
  }
}
fs.writeFileSync(REPORT, md);

// ─── report ──────────────────────────────────────────────────────────────────

console.log('\nconformance');
for (const [k, v] of Object.entries(summary)) { console.log(`  ${k.padEnd(16)} ${v}`); }
console.log(`\n  wrote ${path.relative(root, MAP_OUT)} and ${path.relative(root, REPORT)}\n`);

if (strict && (summary.unmapped > 0 || summary.orphan > 0)) { process.exit(1); }
