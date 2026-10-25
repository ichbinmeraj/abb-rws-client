#!/usr/bin/env node
/**
 * `node scripts/evidence-index.mjs <log dir>...` - which path-table rows have
 * run against a controller, from the logs that prove it.
 *
 * Reads every `*.jsonl` under the given directories: probe logs (one request
 * per line, a `wire` list per line, or hand-probe `req` lines) and
 * functional-test traces (`http.res` lines; see scripts/evidence-logs.mjs).
 * It also reads the client's text trace, the `http.res` lines of every
 * `*.txt` and `*.json` file (a trace file, or a run's result file that keeps
 * the trace lines as strings). Each request that answered 2xx is matched to the path-table rows it
 * stands for (method, resource path, `?action=`, a row's fixed `query`), per
 * generation. The result, `tests/fixtures/evidence-index.json`, is the only
 * ground for a `live` tag: tests/pathspec.tiers.test.ts checks that every
 * `live` side has an entry and every entry's side is `live`. The logs
 * themselves stay out of this repository; the index keeps one example request
 * per side, so the test runs offline.
 *
 * Reads the tables from dist/ (run `npm run build` first).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestsFromLog, requestsFromTextTrace } from './evidence-logs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'tests', 'fixtures', 'evidence-index.json');
const { ALL_TABLES } = await import(new URL('../dist/paths/index.js', import.meta.url).href);

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/evidence-index.mjs <log dir>...');
  process.exit(1);
}

/** Path placeholders whose value may hold slashes (file paths, resource paths). */
const MULTI_SEGMENT = new Set(['path', 'resource', 'storePath', 'source', 'parent', 'stackurl']);

const has = (re) => (body) => body !== null && re.test(body);
/**
 * For a row that sends the same request as another row and reads an entry
 * the answer can carry with no value. The logs keep no answer bodies, so a
 * logged 2xx cannot show that the entry had a value: such a row is never
 * credited here. The pcp answer carries the motionpointer entry with no
 * position when no program has started. A row that shares a request and
 * reads a value every answer carries is credited as usual:
 * getTaskChangeCount reads the change-count span, which ABB's RWS 2.0 page
 * gives beside struc-change-count in the structural-changecount answer.
 */
const never = () => false;
/**
 * Rows that share one method, path and action and differ only by the form
 * body: a request is credited to them only when its logged body says which.
 */
const BODY_RULES = {
  rws1: {
    createDirectory: has(/(^|&)fs-action=create(&|$)/),
    copyFile: has(/(^|&)fs-action=copy(&|$)/),
    renameFile: has(/(^|&)fs-action=rename(&|$)/),
    setActiveTool: has(/(^|&)tool=/),
    setActiveWobj: has(/(^|&)wobj=/),
    // The RWS 1.0 step is ABB's start with a step execmode (same path and action).
    stepRapid: has(/(^|&)execmode=step/),
    startRapid: (body) => body === null || !/execmode=step/.test(body),
    // Signal simulation is the signal's ?action=set with lstate; a value write sends lvalue.
    setSignalSimulated: has(/(^|&)lstate=/),
    writeSignal: (body) => body === null || !/(^|&)lstate=/.test(body),
    // Same GET .../pcp as getProgramPointer; the motionpointer entry (no position before a program starts).
    getMotionPointer: never,
  },
  rws2: {
    stepRapid: has(/(^|&)execmode=step/),
    // A start without a logged body is a plain start: the client's start never steps.
    startRapid: (body) => body === null || !/execmode=step/.test(body),
    setActiveTool: has(/(^|&)tool=/),
    setActiveWobj: has(/(^|&)wobj=/),
    getMotionPointer: never,
  },
};

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); } else if (/\.(jsonl|txt|json)$/.test(e.name)) { out.push(p); }
  }
  return out;
}

const requests = [];
for (const dir of dirs) {
  for (const file of walk(dir, [])) {
    const source = /test-results/.test(file) ? 'functional trace' : 'probe log';
    const text = readFileSync(file, 'utf8');
    requests.push(...(file.endsWith('.jsonl') ? requestsFromLog(text, file, source) : requestsFromTextTrace(text, source)));
  }
}

const esc = (s) => s.replace(/[.*+^$()|[\]\\]/g, (c) => '\\' + c);
const specs = [];
for (const [domain, table] of Object.entries(ALL_TABLES)) {
  for (const [name, op] of Object.entries(table)) {
    for (const gen of ['rws1', 'rws2']) {
      const spec = op[gen];
      if (!spec || spec.gap !== undefined) { continue; }
      let holes = 0;
      const re = new RegExp('^' + esc(spec.path).replace(/\{(\w+)\}/g, (_, p) => { holes += 1; return MULTI_SEGMENT.has(p) ? '.+' : '[^/]+'; }) + '/?$', 'i');
      specs.push({ key: `${domain}.${name}.${gen}`, name, gen, spec, re, holes });
    }
  }
}

const index = {};
for (const r of requests) {
  if (!r.gen || !r.method || !r.url || r.method === 'OPTIONS' || !(r.status >= 200 && r.status < 300)) { continue; }
  let u;
  try { u = new URL('http://x' + r.url); } catch { continue; }
  let path;
  try { path = decodeURIComponent(u.pathname); } catch { path = u.pathname; }
  const action = u.searchParams.get('action') ?? undefined;
  let hits = specs.filter((s) => s.gen === r.gen && s.spec.method === r.method
    && (s.re.test(path) || s.re.test(u.pathname))
    && (s.spec.action ?? undefined) === action
    && (!s.spec.query || s.spec.query.split('&').every((kv) => { const [k, v] = kv.split('='); return u.searchParams.get(k) === v; })));
  if (hits.length === 0) { continue; }
  // The most literal template wins: /rw/motionsystem/jog is not /rw/motionsystem/{mechunit}.
  const fewest = Math.min(...hits.map((h) => h.holes));
  hits = hits.filter((h) => h.holes === fewest);
  hits = hits.filter((h) => {
    const rule = BODY_RULES[r.gen]?.[h.name];
    return rule === undefined || rule(r.body);
  });
  for (const h of hits) {
    const e = index[h.key] ?? (index[h.key] = { successes: 0, example: `${r.method} ${r.url.replace(/[?&]json=1/, '')} -> ${r.status}`, sources: [] });
    e.successes += 1;
    if (!e.sources.includes(r.source)) { e.sources.push(r.source); }
  }
}

const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n');
console.log(`${requests.length} logged requests; ${Object.keys(sorted).length} row sides with a logged success -> ${relative(root, outPath)}`);
