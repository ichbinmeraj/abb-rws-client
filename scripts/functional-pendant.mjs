#!/usr/bin/env node
/**
 * `npm run functional:pendant` - the pendant session: the owner sits at the
 * virtual FlexPendants for about 15 minutes and this one command runs every
 * functional test that needs him, lane by lane (rw8, rw7, rw6), with the
 * console telling him what to do and when.
 *
 *   npm run functional:pendant                    rw8, then rw7, then rw6
 *   npm run functional:pendant -- rw7 rw6         only these lanes, in this order
 *   npm run functional:pendant -- --yes           no Enter between lanes
 *   npm run functional:pendant -- --manual-only   only the manual-mode tests of 09-motion
 *   npm run functional:pendant -- --plan          print what will be asked, run nothing
 *
 * Each lane runs tests/functional/09-motion through `npm run functional`
 * (scripts/functional.mjs) with
 *   RWS_FUNCTIONAL_ONLY=<lane>            that lane only
 *   RWS_FUNCTIONAL_ALLOW_MANUAL=<lane>    the manual-mode tests may switch it to manual
 *   RWS_FUNCTIONAL_PENDANT=1              the owner answers console prompts (waitForPerson)
 *   RWS_FUNCTIONAL_RUN_ID=<stamp>-pendant-<lane>
 * so each lane has its own output directory under test-results/functional/.
 * Before each lane it prints what the owner will be asked to do; at the end,
 * one result line per lane. The exit code is 0 only when no lane failed.
 *
 * Local virtual controllers only (the functional harness refuses any other
 * host). Never run it without the owner at the pendants.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['rw8', 'rw7', 'rw6'];

/** What the owner sets up before a lane and what he is asked during it. */
export const BRIEFING = {
  rw8: {
    before: [
      'The RW8 virtual controller in Auto, motors off (the manual tests skip when the motors are on: a mode change would undo the Reset).',
      'The test user holds "Allow remote access in manual mode" (the manual tests skip without it).',
    ],
    asked: [
      '"Confirm Auto on the RW8 pendant" - after each manual test (two of them) switches back from manual reduced speed; up to 180 s each.',
    ],
    after: 'Back in Auto the RW8 controller waits in guard stop; give a Reset at the pendant when you next need the motors.',
  },
  rw7: {
    before: ['The RW7 virtual controller in Auto.'],
    asked: [
      '"Press Grant on the RW7 pendant" - the remote access (RMMP) dialog, right after the test switches to manual reduced speed; up to 90 s.',
      '"Confirm Auto on the RW7 pendant" - after the jogs, when the test switches back; up to 180 s.',
    ],
    after: null,
  },
  rw6: {
    before: ['The RW6 virtual controller in Auto (key switch).'],
    asked: [
      '"Turn the RW6 key switch to manual (manual reduced speed)" - RWS 1.0 takes no mode change; the test waits for MANR, up to 180 s.',
      '"Turn the RW6 key switch back to Auto (and confirm it on the pendant if it asks)" - up to 180 s.',
    ],
    after: null,
  },
};

const MANUAL_ONLY_FILTER = 'manual reduced speed';

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Parse the command line: lanes in the given order (default rw8, rw7, rw6) and the flags. */
export function parseArgs(argv) {
  const opts = { lanes: [], yes: false, manualOnly: false, plan: false, unknown: [] };
  for (const a of argv) {
    const lane = a.toLowerCase();
    if (ORDER.includes(lane)) { if (!opts.lanes.includes(lane)) { opts.lanes.push(lane); } }
    else if (a === '--yes' || a === '-y') { opts.yes = true; }
    else if (a === '--manual-only') { opts.manualOnly = true; }
    else if (a === '--plan' || a === '--dry-run') { opts.plan = true; }
    else { opts.unknown.push(a); }
  }
  if (opts.lanes.length === 0) { opts.lanes = [...ORDER]; }
  return opts;
}

/** The lines printed before a lane. */
export function briefingLines(lane, n, total) {
  const b = BRIEFING[lane];
  const lines = [
    '',
    '='.repeat(78),
    `PENDANT SESSION - lane ${n} of ${total}: ${lane.toUpperCase()}`,
    '='.repeat(78),
    'Before you go on:',
    ...b.before.map(s => `  - ${s}`),
    `  - If ${lane.toUpperCase()} does not read Auto at the start, the lane is skipped: "confirm Auto at the ${lane.toUpperCase()} pendant".`,
    'You will be asked, on this console, as it happens:',
    ...b.asked.map((s, i) => `  ${i + 1}. ${s}`),
    'Each request shows as a ">>> PENDANT:" line; the test reads the controller and goes on by itself once it sees it done.',
  ];
  if (b.after) { lines.push(`Afterwards: ${b.after}`); }
  return lines;
}

/** A lane result with nothing recorded yet. */
function emptyResult(lane) {
  return { lane, passed: 0, failed: 0, skipped: 0, blocker: null, hookFailures: [], skips: [], report: false, skippedByOwner: false };
}

/** One lane's outcome from its run directory: vitest's JSON report, the recorded skips and hook failures. */
export function laneResult(runDir, lane) {
  const r = emptyResult(lane);
  const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const resultsFile = path.join(runDir, 'results.json');
  if (fs.existsSync(resultsFile)) {
    try {
      const report = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
      r.report = true;
      for (const file of report.testResults ?? []) {
        for (const t of file.assertionResults ?? []) {
          if (!(t.ancestorTitles ?? []).some(a => a === `09-motion/${lane}`)) { continue; }
          if (t.status === 'passed') { r.passed++; } else if (t.status === 'failed') { r.failed++; } else { r.skipped++; }
        }
      }
    } catch { /* unreadable: reported below as no report */ }
  }
  for (const s of readLines(path.join(runDir, 'skips.jsonl'))) {
    if (s.lane !== lane) { continue; }
    if (s.test === '*') { r.blocker ??= s.reason; continue; }
    if (!r.skips.some(x => x.test === s.test)) { r.skips.push({ test: s.test, reason: s.reason }); }
  }
  for (const h of readLines(path.join(runDir, 'hook-failures.jsonl'))) {
    if (h.lane === lane) { r.hookFailures.push(`${h.hook}: ${String(h.error).split('\n')[0]}`); }
  }
  return r;
}

/** The verdict word of a lane result. */
export function verdict(r) {
  if (r.skippedByOwner) { return 'SKIPPED'; }
  if (r.failed > 0 || r.hookFailures.length) { return 'FAILED'; }
  if (r.blocker) { return 'BLOCKED'; }
  if (!r.report) { return 'NO REPORT'; }
  if (r.passed === 0) { return 'SKIPPED'; }
  return 'PASSED';
}

/** The final per-lane lines. */
export function summaryLines(results) {
  const lines = ['', '='.repeat(78), 'PENDANT SESSION - results', '='.repeat(78)];
  for (const r of results) {
    lines.push(`  ${r.lane.toUpperCase()}  ${verdict(r).padEnd(9)} ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped   (${r.runId ?? ''})`);
    if (r.skippedByOwner) { lines.push('        skipped at the console'); }
    if (r.blocker) { lines.push(`        ${r.blocker}`); }
    for (const h of r.hookFailures) { lines.push(`        hook ${h}`); }
    for (const s of r.skips.filter(x => x.test.includes(MANUAL_ONLY_FILTER))) {
      lines.push(`        skipped "${s.test.slice(0, 70)}...": ${s.reason}`);
    }
  }
  return lines;
}

function waitForEnter(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.unknown.length) {
    console.error(`functional:pendant: unknown argument(s) ${opts.unknown.join(' ')} - lanes are rw6, rw7, rw8; flags --yes, --manual-only, --plan`);
    process.exit(2);
  }
  const base = `${stamp()}-pendant`;
  const pause = !opts.yes && process.stdin.isTTY;

  console.log(`PENDANT SESSION: ${opts.lanes.map(l => l.toUpperCase()).join(', then ')} - 09-motion${opts.manualOnly ? ' (manual-mode tests only)' : ''}.`);
  console.log('Keep the virtual FlexPendants of these controllers open where you can reach them, and this console in view.');
  if (opts.plan) {
    opts.lanes.forEach((lane, i) => { for (const l of briefingLines(lane, i + 1, opts.lanes.length)) { console.log(l); } });
    console.log('\n(--plan: nothing was run)');
    return 0;
  }

  const results = [];
  for (const [i, lane] of opts.lanes.entries()) {
    for (const l of briefingLines(lane, i + 1, opts.lanes.length)) { console.log(l); }
    if (pause) {
      const a = await waitForEnter(`\nPress Enter to start ${lane.toUpperCase()} (s + Enter skips this lane, q + Enter stops): `);
      if (a === 'q') { console.log('Stopped at your request.'); break; }
      if (a === 's') { results.push({ ...emptyResult(lane), runId: 'not run', skippedByOwner: true }); continue; }
    }
    const runId = `${base}-${lane}`;
    const args = [path.join(root, 'scripts', 'functional.mjs'), '09-motion'];
    if (opts.manualOnly) { args.push('-t', MANUAL_ONLY_FILTER); }
    const res = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        RWS_FUNCTIONAL_ONLY: lane,
        RWS_FUNCTIONAL_ALLOW_MANUAL: lane,
        RWS_FUNCTIONAL_PENDANT: '1',
        RWS_FUNCTIONAL_RUN_ID: runId,
      },
    });
    if (res.error) { console.error(`functional:pendant: could not run the ${lane} lane (${res.error.message})`); }
    const r = laneResult(path.join(root, 'test-results', 'functional', runId), lane);
    results.push({ ...r, runId });
    console.log(`\n${lane.toUpperCase()} done: ${verdict(r)}.`);
  }

  for (const l of summaryLines(results)) { console.log(l); }
  return results.some(r => verdict(r) === 'FAILED' || verdict(r) === 'NO REPORT') ? 1 : 0;
}

// Run only as a script (the offline test imports the pure parts).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), e => { console.error(`functional:pendant: ${e?.stack ?? e}`); process.exit(2); });
}
