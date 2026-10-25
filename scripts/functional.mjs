#!/usr/bin/env node
/**
 * `npm run functional` - runs the functional suite (tests/functional) against
 * the local virtual controllers.
 *
 *   npm run functional                     every functional file
 *   npm run functional -- 00-smoke         files whose name contains "00-smoke"
 *   npm run functional -- 10 20 -t "name"  several filters; options go to vitest
 *
 * Environment (passed through to the tests):
 *   RWS_FUNCTIONAL_ONLY=rw7,rw8            run these lanes only
 *   RWS_FUNCTIONAL_ALLOW_RESTART=rw7       lanes a restart test may restart
 *   RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<system name>  the RW8 RAPID-run tests
 *                                          may allow motion control on the virtual
 *                                          controller with that system name (set
 *                                          only by a person at its virtual
 *                                          FlexPendant)
 *   RWS_TEST_PORT_RW6 / _RW7 / _RW8        a port to try first per lane
 *   RWS_FUNCTIONAL_RUN_ID                  reuse a run directory (default: a timestamp)
 *
 * Before vitest starts, `scripts/vc-ready.mjs` reads each virtual controller
 * once (system, operating mode, controller state, then logout). A lane whose
 * VC is down is left out of the run and named, instead of failing every test
 * of that lane; with no lane ready nothing runs. `--no-vc-ready` skips the
 * check (the lane discovery inside the tests then decides on its own).
 *
 * Files run one at a time (--no-file-parallelism): several files at once would
 * put uncoordinated sessions on the same controller and exceed its request
 * rate. Output goes to test-results/functional/<run id>/: one trace per lane
 * (<lane>.jsonl), fleet.json, skips.jsonl and the vitest JSON report
 * (results.json). The exit code is vitest's.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'tests', 'functional');

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const runId = process.env.RWS_FUNCTIONAL_RUN_ID?.trim() || stamp();
const runDir = path.join(root, 'test-results', 'functional', runId);
fs.mkdirSync(runDir, { recursive: true });

// Positional arguments are file filters, matched against the functional
// files' names here so a filter can never pick up a unit or structural test.
// Options (and the value after an option that takes one) go to vitest as-is.
const OPTIONS_WITH_VALUE = new Set(['-t', '--testNamePattern', '--bail', '--retry', '--seed']);
const filters = [];
const passThrough = [];
const argv = process.argv.slice(2);
let vcReady = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-vc-ready') { vcReady = false; continue; }
  if (a.startsWith('-')) {
    passThrough.push(a);
    if (OPTIONS_WITH_VALUE.has(a) && i + 1 < argv.length) { passThrough.push(argv[++i]); }
  } else {
    filters.push(a);
  }
}

const allFiles = fs.existsSync(testDir)
  ? fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts')).sort()
  : [];
const selected = filters.length
  ? allFiles.filter(f => filters.some(q => f.includes(q)))
  : allFiles;
if (selected.length === 0) {
  console.error(`functional: no test file in tests/functional matches ${filters.length ? filters.join(', ') : '(any)'}`);
  process.exit(2);
}

const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
if (!fs.existsSync(vitestBin)) {
  console.error(`functional: cannot find vitest at ${vitestBin} - run npm ci first`);
  process.exit(2);
}

// ─── Which lanes have a VC up (scripts/vc-ready.mjs) ────────────────────────

const LANES = ['rw6', 'rw7', 'rw8'];
const parseLanes = raw => (raw ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => LANES.includes(x));
let onlyLanes = process.env.RWS_FUNCTIONAL_ONLY?.trim() ? parseLanes(process.env.RWS_FUNCTIONAL_ONLY) : LANES;
if (vcReady) {
  const check = spawnSync(process.execPath, [path.join(root, 'scripts', 'vc-ready.mjs'), '--json', '--lanes', onlyLanes.join(',')], {
    cwd: root, encoding: 'utf8', env: process.env,
  });
  let report = null;
  try { report = JSON.parse(check.stdout || 'null'); } catch { /* not JSON: reported below */ }
  if (check.status === 2 || !report || report.error) {
    // The check itself could not run (dist/ not built, discovery failed): the
    // lanes stay as asked, and the tests' own discovery decides.
    const why = report?.error ?? ((check.stderr || '').trim() || `exit ${check.status}`);
    console.error(`functional: vc-ready could not run (${why}) - every requested lane is kept`);
  } else {
    for (const lane of report.down ?? []) {
      const rows = (report.controllers ?? []).filter(c => c.lane === lane);
      const why = rows.length ? rows.map(c => `:${c.port} ${c.problem ?? 'not ready'}`).join('; ') : 'no virtual controller of that lane answered';
      console.log(`functional: ${lane} skipped - ${why}`);
    }
    for (const c of report.controllers ?? []) {
      if (c.ready) { console.log(`functional: ${c.lane} ready - :${c.port} RobotWare ${c.robotware} ${c.system} (${c.opmode}, ${c.ctrlstate})`); }
    }
    onlyLanes = report.ready ?? [];
    if (onlyLanes.length === 0) {
      console.error('functional: no requested lane has a virtual controller ready - nothing to run');
      process.exit(1);
    }
  }
}
process.env.RWS_FUNCTIONAL_ONLY = onlyLanes.join(',');

const resultsFile = path.join(runDir, 'results.json');
const args = [
  vitestBin, 'run',
  ...selected.map(f => `tests/functional/${f}`),
  '--no-file-parallelism',
  '--testTimeout=120000',
  '--hookTimeout=180000',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${resultsFile}`,
  ...passThrough,
];

console.log(`functional: run ${runId} - ${selected.length} file(s): ${selected.join(', ')}`);
console.log(`functional: output in ${path.relative(root, runDir)}`);

const res = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, RWS_FUNCTIONAL: '1', RWS_FUNCTIONAL_RUN_ID: runId },
});
if (res.error) {
  console.error(`functional: could not run vitest (${res.error.message})`);
  process.exit(2);
}

// ─── Summary per lane, with the recorded skip reasons ────────────────────────

const lanes = new Map();
if (fs.existsSync(resultsFile)) {
  try {
    const report = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    for (const file of report.testResults ?? []) {
      for (const t of file.assertionResults ?? []) {
        const top = (t.ancestorTitles ?? []).find(a => /^[^/]+\/rw[678]$/.test(a ?? ''));
        if (!top) { continue; }
        const rec = lanes.get(top) ?? { passed: 0, failed: 0, skipped: 0 };
        if (t.status === 'passed') { rec.passed++; } else if (t.status === 'failed') { rec.failed++; } else { rec.skipped++; }
        lanes.set(top, rec);
      }
    }
  } catch (e) {
    console.error(`functional: results.json is not readable (${e.message})`);
  }
}

// A lane whose beforeAll failed shows in vitest's JSON as pending tests with
// no message; the harness records hook failures itself, so they are reported
// as what they are.
const hookFailures = new Map();
const hooksFile = path.join(runDir, 'hook-failures.jsonl');
if (fs.existsSync(hooksFile)) {
  for (const line of fs.readFileSync(hooksFile, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const h = JSON.parse(line);
      const key = `${h.file}/${h.lane}`;
      hookFailures.set(key, [...(hookFailures.get(key) ?? []), `${h.hook}: ${String(h.error).split('\n')[0]}`]);
    } catch { /* a torn line */ }
  }
}

console.log('\nfunctional summary');
for (const [title, r] of [...lanes.entries()].sort()) {
  const hooks = hookFailures.get(title);
  const pending = hooks?.some(h => h.startsWith('beforeAll')) ? 'not run' : 'skipped';
  console.log(`  ${title.padEnd(32)} ${r.passed} passed, ${r.failed} failed, ${r.skipped} ${pending}${hooks ? '  HOOK FAILED' : ''}`);
  for (const h of hooks ?? []) { console.log(`      ${h}`); }
}

const skipsFile = path.join(runDir, 'skips.jsonl');
if (fs.existsSync(skipsFile)) {
  const seen = new Set();
  const lines = fs.readFileSync(skipsFile, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length) { console.log('\nskip reasons'); }
  for (const line of lines) {
    try {
      const s = JSON.parse(line);
      const key = `${s.file}/${s.lane} ${s.test}: ${s.reason}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      console.log(`  ${s.file}/${s.lane}  ${s.test === '*' ? '(whole lane)' : s.test}: ${s.reason}`);
    } catch { /* a torn line */ }
  }
}

const traces = fs.readdirSync(runDir).filter(f => f.endsWith('.jsonl') && f !== 'skips.jsonl');
if (traces.length) {
  console.log(`\ntraces: ${traces.map(f => path.relative(root, path.join(runDir, f))).join(', ')}`);
}
process.exit(res.status ?? 1);
