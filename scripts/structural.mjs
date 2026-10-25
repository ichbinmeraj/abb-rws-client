#!/usr/bin/env node
/**
 * `npm run structural` - the structural coverage loop's runner.
 *
 * Runs the auto cells, maps their results back onto docs/structural/matrix.json,
 * and regenerates the loop's two memory files:
 *   - docs/structural/state.json  (machine state: buckets, next batch)
 *   - STRUCTURAL.md               (human state: matrix, results, manual procedures)
 *
 * Cell mapping is by convention, not configuration: a structural test's top
 * describe MUST be exactly `<cell-id>/<generation>` (e.g. `S01-drop-midrequest/rws1`).
 * A cell with no matching test stays `untested` - it is never silently green.
 *
 * A cell's tests against a mock controller sit in a file of their own,
 * tests/structural/<cell-id>.mock.test.ts, under the same describe title; they
 * need no controller and run in plain `npm test` too. Their failures fail the
 * cell, but their passes verify a cell only when the matrix marks it
 * `"automation": "mock"` (S11, whose flood no controller can be made to
 * produce); every other cell needs a pass against a controller.
 *
 * Exit code is 0 even when cells fail: the loop wants the regenerated report, and
 * failure is the loop's actual work. Pass --strict to exit non-zero on failures
 * (used by CI once every cell is verified).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = path.join(root, 'docs', 'structural', 'matrix.json');
const STATE = path.join(root, 'docs', 'structural', 'state.json');
const REPORT = path.join(root, 'STRUCTURAL.md');
const RESULTS = path.join(root, 'docs', 'structural', '.vitest-results.json');
/**
 * Why tests were skipped, one JSON line per skipped test ({cell, test, reason}),
 * written by the harness (tests/helpers/structuralHarness.ts, recordCellSkip) to
 * the file this runner names in RWS_STRUCTURAL_SKIPS. A cell left untested
 * because its controller was not running says so in the report.
 */
const SKIPS = path.join(root, 'docs', 'structural', '.skips.jsonl');

const strict = process.argv.includes('--strict');
const skipRun = process.argv.includes('--no-run');

/**
 * Seconds to pause between test FILES, to let the controller reap sessions.
 *
 * Fault injection orphans sessions by construction: every connection a cell
 * deliberately breaks may leave a server-side session behind, and those only
 * expire on the controller's own timer (300 s on IRC5, which caps at 70). A full
 * pass outruns the reaper, and once the pool is dry every LATER cell fails with
 * CONTROLLER_BUSY for a reason that has nothing to do with what it tests - which
 * is exactly what happened on 2026-08-09, where six cells failed 503 in one run
 * and every one of them passed individually minutes later.
 *
 * A cooldown does not fix that outright - nothing short of the controller's own
 * expiry does - but it spreads the demand. A pause shorter than the expiry
 * frees little, so use `--cooldown 300` (the controller's 300 s session
 * expiry) for a full pass, on freshly started VCs with nothing else live, or
 * restart the VCs between groups of cells.
 */
const cooldownSec = (() => {
  const i = process.argv.indexOf('--cooldown');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 0;
})();

const matrix = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
const cellKey = (c) => `${c.id}/${c.generation}`;

/**
 * A cell's mock half (see the header): its file name says so. Vitest's JSON
 * report gives each file's path as `name`.
 */
const MOCK_FILE = /\.mock\.test\.[cm]?[jt]s$/;

// ─── 1. Run the structural suites ────────────────────────────────────────────

let vitest = null;
if (!skipRun) {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  // This run's reasons only; --no-run re-reads the last run's.
  fs.rmSync(SKIPS, { force: true });
  // Invoke vitest's JS entry with the SAME node that runs this script, rather
  // than the `npx` shim. On Windows, execFile-ing a .cmd now fails EINVAL (Node
  // hardened it), and going through a shell would put the outputFile path at the
  // mercy of shell quoting. This avoids both.
  const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(vitestBin)) {
    console.error(`structural: cannot find vitest at ${vitestBin} - run npm ci first`);
    process.exit(2);
  }
  // Cells run SERIALLY. Vitest parallelises test files by default, which would
  // put several live clients on the same controller at once - each respects the
  // <20 req/s ceiling alone, none of them coordinate, and the controller answers
  // 503. That is a property of the rig, not of the client, and it surfaces as
  // phantom cell failures.
  //
  // With --cooldown, files are invoked ONE AT A TIME with a pause between, and
  // the per-file JSON reports are merged. Vitest has no between-files hook, so a
  // single run cannot pause; this is the only way to give the controller room to
  // reap orphaned sessions mid-pass. The mock halves need no controller, so
  // they run first, in one invocation, and no pause follows them.
  const files = fs.readdirSync(path.join(root, 'tests', 'structural'))
    .filter(f => f.endsWith('.test.ts')).sort()
    .map(f => `tests/structural/${f}`);
  const mockFiles = files.filter(f => MOCK_FILE.test(f));
  const targets = cooldownSec > 0
    ? [...(mockFiles.length > 0 ? [mockFiles] : []), ...files.filter(f => !MOCK_FILE.test(f)).map(f => [f])]
    : [['tests/structural']];

  const runVitest = (target, outFile) => {
    try {
      execFileSync(
        process.execPath,
        [
          vitestBin, 'run', ...target,
          '--no-file-parallelism',
          '--reporter=json', `--outputFile=${outFile}`,
        ],
        {
          cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60 * 60 * 1000,
          // Structural cells inject faults against live VCs and are slow, so they
          // stay out of `npm test`. Only this runner turns them on (their mock
          // halves run in `npm test` as well).
          env: { ...process.env, RWS_STRUCTURAL: '1', RWS_STRUCTURAL_SKIPS: SKIPS },
        },
      );
    } catch (e) {
      // A non-zero EXIT is expected - it just means cells failed, and the JSON
      // report is what we read. A spawn failure is not, and silently swallowing
      // it reports every cell as `untested`, which looks like "no tests written
      // yet" rather than "the runner never ran". Distinguish them.
      if (e && typeof e === 'object' && e.status === null) {
        console.error(`structural: could not run vitest (${e.code ?? e.message})`);
        if (e.stderr?.length) { console.error(String(e.stderr).slice(0, 1000)); }
        process.exit(2);
      }
    }
  };

  if (targets.length === 1) {
    runVitest(targets[0], RESULTS);
  } else {
    const merged = { testResults: [] };
    for (const [i, target] of targets.entries()) {
      const part = `${RESULTS}.part`;
      console.log(`structural: ${target.join(' ')}  (${i + 1}/${targets.length})`);
      runVitest(target, part);
      if (fs.existsSync(part)) {
        try {
          const j = JSON.parse(fs.readFileSync(part, 'utf8'));
          merged.testResults.push(...(j.testResults ?? []));
        } catch { /* a file that produced no parsable report leaves its cells untested */ }
        fs.rmSync(part, { force: true });
      }
      if (i < targets.length - 1 && !target.every(t => MOCK_FILE.test(t))) {
        console.log(`structural: cooling down ${cooldownSec}s so the controller can reap sessions`);
        // Synchronous sleep - this script is a sequential driver, not a server.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cooldownSec * 1000);
      }
    }
    fs.writeFileSync(RESULTS, JSON.stringify(merged));
  }
}

// Read the report whether or not this invocation produced it: --no-run exists
// precisely to re-map the LAST run's results (after fixing the mapping, or after
// editing the matrix) without spending another hour of live cells.
{
  if (!fs.existsSync(RESULTS)) {
    console.error(
      skipRun
        ? `structural: --no-run needs a previous report at ${RESULTS}, and there is none`
        : `structural: vitest produced no report at ${RESULTS} - refusing to report every cell as untested`,
    );
    process.exit(2);
  }
  try { vitest = JSON.parse(fs.readFileSync(RESULTS, 'utf8')); }
  catch (e) {
    console.error(`structural: report at ${RESULTS} is not valid JSON (${e.message})`);
    process.exit(2);
  }
}

// ─── 2. Map assertion results onto cells ─────────────────────────────────────

/** A top-level cell describe: "<cell-id>/<generation>". */
const CELL_TITLE = /^S\d{2}-[a-z0-9-]+\/(rws1|rws2)$/;

/**
 * The title marker of a known-gap test (the harness's knownGap(), on an
 * it.fails test): `<title> [known gap: <why>]`. Such a test PASSES while the
 * property it states is still not met, so its pass is mapped as a failure of
 * the cell, naming the gap: the cell reads verified only once the client is
 * fixed and the test is flipped to a plain it(). In between, the fixed client
 * makes the it.fails test fail ("Expect test to fail"), which reads failing too.
 */
const KNOWN_GAP = /\[known gap: ([^\]]+)\]$/;

/**
 * cellKey -> { passed, mockPassed, failed, skipped, failures: [{name, message}] }:
 * `passed` counts passes against a controller, `mockPassed` passes of the
 * cell's mock half; `failed` and `failures` count both.
 */
const observed = new Map();

if (vitest?.testResults) {
  for (const file of vitest.testResults) {
    const mockHalf = MOCK_FILE.test(String(file.name ?? ''));
    for (const t of file.assertionResults ?? []) {
      // SEARCH the ancestor chain rather than indexing it. Vitest prefixes the
      // chain with an empty string for the file-level implicit suite, so the
      // cell title sits at [1], not [0] - indexing [0] matched nothing and made
      // every cell look untested even though the tests had run.
      const top = (t.ancestorTitles ?? []).find(a => CELL_TITLE.test(a ?? ''));
      if (!top) { continue; }
      const rec = observed.get(top) ?? { passed: 0, mockPassed: 0, failed: 0, skipped: 0, failures: [] };
      const gap = t.status === 'passed' ? KNOWN_GAP.exec(t.title ?? '') : null;
      const name = [...(t.ancestorTitles ?? []).slice(1), t.title].join(' > ')
        + (mockHalf ? ' (mock controller)' : '');
      if (gap) {
        rec.failed++;
        rec.failures.push({
          name,
          message: `known gap, still open (an it.fails test that failed as expected): ${gap[1]}`,
        });
      } else if (t.status === 'passed') {
        if (mockHalf) { rec.mockPassed++; } else { rec.passed++; }
      } else if (t.status === 'failed') {
        rec.failed++;
        rec.failures.push({
          name,
          message: (t.failureMessages ?? []).join('\n').split('\n').slice(0, 4).join(' '),
        });
      } else { rec.skipped++; }
      observed.set(top, rec);
    }
  }
}

/**
 * cellKey -> [{ reason, tests }]: why its tests were skipped, one entry per
 * reason with the number of tests it skipped. Informational only: a skip never
 * counts as a pass, so a cell whose tests were all skipped stays `untested`.
 */
const skipReasons = new Map();
if (fs.existsSync(SKIPS)) {
  for (const line of fs.readFileSync(SKIPS, 'utf8').split('\n')) {
    if (!line.trim()) { continue; }
    let s;
    try { s = JSON.parse(line); } catch { continue; }
    if (!CELL_TITLE.test(s?.cell ?? '') || typeof s.reason !== 'string') { continue; }
    const list = skipReasons.get(s.cell) ?? [];
    const hit = list.find(x => x.reason === s.reason);
    if (hit) { hit.tests++; } else { list.push({ reason: s.reason, tests: 1 }); }
    skipReasons.set(s.cell, list);
  }
}

// ─── 3. Resolve each cell's status ───────────────────────────────────────────

const resolved = matrix.cells.map(cell => {
  const key = cellKey(cell);
  const declared = cell.status ?? 'untested';
  const skips = skipReasons.get(key) ?? [];

  // A cell the matrix pins as manual-only or excluded is not decided by tests.
  if (declared === 'manual-only' || declared === 'excluded') {
    return { ...cell, key, resolved: declared, observed: observed.get(key) ?? null, skips };
  }
  const o = observed.get(key);
  // A cell the matrix declares un-automatable is manual-only once it carries a
  // written procedure - not "untested", which would imply someone forgot it.
  if (cell.automation === 'manual' && !o) {
    return { ...cell, key, resolved: 'manual-only', observed: null, skips };
  }
  if (!o || (o.passed === 0 && o.mockPassed === 0 && o.failed === 0)) {
    return { ...cell, key, resolved: 'untested', observed: o ?? null, skips };
  }
  if (o.failed > 0) { return { ...cell, key, resolved: 'failing', observed: o, skips }; }
  // A pass against a mock controller verifies only a cell the matrix marks
  // automation "mock"; any other cell whose live half did not run stays
  // untested, however green its mock half (see the header).
  if (o.passed === 0 && cell.automation !== 'mock') {
    return { ...cell, key, resolved: 'untested', observed: o, skips };
  }
  return { ...cell, key, resolved: 'verified', observed: o, skips };
});

const bucket = (name) => resolved.filter(c => c.resolved === name);
const buckets = {
  verified: bucket('verified').map(c => c.key),
  failing: bucket('failing').map(c => c.key),
  untested: bucket('untested').map(c => c.key),
  'manual-only': bucket('manual-only').map(c => c.key),
  excluded: bucket('excluded').map(c => c.key),
};

// Next batch = ONE scenario across both generations (the loop's unit of work).
const openScenarios = [...new Set(
  resolved.filter(c => c.resolved === 'untested' || c.resolved === 'failing').map(c => c.id),
)];
const nextBatch = openScenarios.length ? openScenarios[0] : null;

// ─── 4. state.json ───────────────────────────────────────────────────────────

const prevState = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
const prevUntested = prevState?.counts?.untested ?? null;
const untestedNow = buckets.untested.length + buckets.failing.length;

const state = {
  $comment: 'Loop memory for npm run structural. Regenerated by npm run structural.',
  updatedAt: new Date().toISOString().slice(0, 10),
  counts: {
    total: resolved.length,
    verified: buckets.verified.length,
    failing: buckets.failing.length,
    untested: buckets.untested.length,
    manualOnly: buckets['manual-only'].length,
    excluded: buckets.excluded.length,
  },
  /** The loop rule: this must fall every batch. */
  openCells: untestedNow,
  previousOpenCells: prevUntested,
  progressed: prevUntested === null ? null : untestedNow < prevUntested,
  buckets,
  nextBatch,
  failures: resolved.filter(c => c.resolved === 'failing').map(c => ({
    cell: c.key, failures: c.observed?.failures ?? [],
  })),
  /** Why tests were skipped, per cell (a cell untested for want of its controller says so here). */
  skips: resolved.filter(c => c.skips.length > 0).map(c => ({ cell: c.key, reasons: c.skips })),
};
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

// ─── 5. STRUCTURAL.md ────────────────────────────────────────────────────────

const badge = {
  verified: 'verified', failing: '**FAILING**', untested: 'untested',
  'manual-only': 'manual-only', excluded: 'excluded',
};

const byScenario = new Map();
for (const c of resolved) {
  if (!byScenario.has(c.id)) { byScenario.set(c.id, { scenario: c.scenario, cells: [] }); }
  byScenario.get(c.id).cells.push(c);
}

let md = `# Structural coverage

What the client is *proven* to do when the network, the controller or the clock
misbehaves - as opposed to what it does on a good day, which is
[COVERAGE.md](docs/COVERAGE.md) and the README tables.

Regenerated by \`npm run structural\`. Machine state:
\`docs/structural/state.json\`.

**${state.counts.verified} verified · ${state.counts.failing} failing · ${state.counts.untested} untested · ${state.counts.manualOnly} manual-only · ${state.counts.excluded} excluded** (of ${state.counts.total} cells)

Every cell is one scenario on one protocol generation. A cell is \`verified\`
only when a test asserting it ran green against a live controller; a cell with
no test is \`untested\`, never assumed. Some cells also have tests against a
mock controller (\`tests/structural/<cell-id>.mock.test.ts\`: S06, S10, S11 and
S12), which need no controller and run in plain \`npm test\` too. A failure
there fails the cell, and a pass there never verifies it alone, except in S11,
whose flood no controller can be made to produce (matrix \`automation: "mock"\`).

## Matrix

| Scenario | RWS 1.0 (IRC5) | RWS 2.0 (OmniCore) |
|---|---|---|
`;

for (const [, { scenario, cells }] of byScenario) {
  const g = (gen) => {
    const c = cells.find(x => x.generation === gen);
    return c ? badge[c.resolved] : '-';
  };
  md += `| ${scenario} | ${g('rws1')} | ${g('rws2')} |\n`;
}

md += `
## Cells

`;
for (const [id, { scenario, cells }] of byScenario) {
  md += `### ${id} - ${scenario}\n\n`;
  for (const c of cells) {
    md += `**${c.generation}** - ${badge[c.resolved]}`;
    if (c.observed) {
      md += ` (${c.observed.passed} passed, ${c.observed.failed} failed`
        + `${c.observed.skipped > 0 ? `, ${c.observed.skipped} skipped` : ''}`
        + `${c.observed.mockPassed > 0 ? `; mock controller: ${c.observed.mockPassed} passed` : ''})`;
    }
    md += `\n\n`;
    md += c.properties.map(p => `- ${p}`).join('\n') + '\n';
    if (c.note) { md += `\n> ${c.note}\n`; }
    if (c.manualProcedure) { md += `\n**Manual procedure**\n\n${c.manualProcedure}\n`; }
    if (c.observed?.failures?.length) {
      md += `\nFailures:\n\n`;
      for (const f of c.observed.failures) { md += `- \`${f.name}\` - ${f.message}\n`; }
    }
    if (c.skips.length) {
      md += `\nSkipped:\n\n`;
      for (const s of c.skips) { md += `- ${s.tests} test${s.tests === 1 ? '' : 's'}: ${s.reason}\n`; }
    }
    md += '\n';
  }
}

md += `## Running the loop

\`\`\`bash
npm run structural          # run the auto cells, regenerate this file + state.json
npm run structural -- --cooldown 300   # the same, one test file at a time, 300 s apart (a full pass)
npm run structural -- --no-run   # re-map the LAST run's results (after editing the matrix)
npm run structural -- --strict   # non-zero exit while any cell is failing or untested
node scripts/soak.mjs --minutes 1440   # S15 acceptance run (see below)
\`\`\`

Cells run **serially** (\`--no-file-parallelism\`). Vitest parallelises files by
default, which would put several live clients on one controller at once; each
paces itself correctly but nothing coordinates across clients, and together
they can exceed ABB's recommended 20 requests a second and hold more sessions
at once than the cells account for.

**Start from a freshly restarted controller, and expect one pass not to fit.**

The IRC5 caps at 70 sessions and reclaims them on a 300 s timer. Thirteen
fault-injection cells back-to-back (every rws1 cell but S03, which is excluded,
S11, which runs on a mock, and the manual S15) consume that budget faster than
it is reclaimed, and once the pool is dry every LATER cell fails CONTROLLER_BUSY for a
reason unrelated to what it asserts. This is a property of the controller: it is
not a client defect, and no client change fixes it.

Measured 2026-08-09, with the controls that rule out a leak:

| Loop, on a drained IRC5 | Result |
|---|---|
| 40 connect/disconnect cycles | 40/40 pass |
| 40 subscribe/unsubscribe cycles | 40/40 pass |
| connect/disconnect WITHOUT disconnect | fails at cycle **2** |

So both paths release what they take, and the method would catch it if they did
not. Every cell also passes on its own. What does not fit is the SUM.

Practically: give a full pass \`--cooldown 300\` (the 300 s expiry between test
files), on freshly started VCs with nothing else live, or run the rws1 cells in
two or three groups and restart the IRC5 between them. A single uninterrupted
pass over every cell will show phantom 503s in whichever cells happen to run
last.

\`RWS_STRUCTURAL_NODE_HTTP=1 npm run structural\` runs every rws1 cell through
the RWS 1.0 client's node:http transport: every hop the cells' clients talk to
(the chaos proxies, S05's header tap, S10's reverse proxy) listens on a port
Node's fetch refuses, as the client meets a controller on such a port (an
RW6 VC came back on port 7, 2026-10-22). Without it the rws1 cells run through
fetch, the transport on every other port, and S01 and S02 run one test each
through node:http.

The mock halves of S06, S10, S11 and S12 need no controller: \`npm test\` runs
them too, and \`npx vitest run tests/structural/S11-event-flood.mock.test.ts\`
runs one alone.

## Known limits

- Direct session counting is **not observable on RWS 2.0**: no resource lists
  or counts sessions, and \`GET /users\` answers the same two links whoever is
  logged in, so it does not move when a client connects. S05 skips its
  session-count test there with that reason and leaves the count out of the
  others; there the wire-level properties (an accepted logout per disconnect,
  no 503 during churn, read at its header tap) and the session cookie kept
  across subscribes carry the cell.
- A half-open state affecting **only** the RWS 2.0 subscription WebSocket, while
  HTTP still works, cannot be detected in band: the controller rejects client
  frames on that socket and an idle subscription sends nothing back. Detection
  covers link-level failure.
- TLS is opaque to the TCP chaos proxy, so on RWS 2.0 wire-level assertions
  (headers, request lines) need a plaintext hop on the client's side of the
  proxy (S05's header tap) or a mock server.
- Live cells run against **localhost virtual controllers only**; the helper in
  \`tests/helpers/liveControllers.ts\` refuses any other host outright, and its
  discovery runs the client's \`findControllers\` with \`loopbackOnly\` (no
  service address, no mDNS, one probe at a time at least 1 s apart).
- VC RWS ports drift across restarts, so they are discovered every run (the OS
  listening ports of the virtual-controller processes) rather than configured.
  One controller per generation: the lowest RobotWare major, then the lowest
  port. Override with \`RWS_TEST_PORT_RW6\` / \`RWS_TEST_PORT_RW7\`.
- Warm restart is the destructive ceiling. No cell resets a system, restores a
  backup, runs an installer, or mutates UAS. S03 restarts only a controller off
  the test suites' never-restart list (\`tests/helpers/restartPolicy.ts\`), so
  with RW6 and RW8 on it, S03 runs on RobotWare 7 only (the matrix excludes its
  rws1 cell meanwhile).
- IK/FK solve on a VC (live-verified 2026-09-30 on RW 6.16.03, 7.21.4, 8.2.1); a refusal of the current pose there is a finding, not a missing option.
`;

fs.writeFileSync(REPORT, md);

// ─── 6. Report ───────────────────────────────────────────────────────────────

const line = (k, v) => console.log(`  ${String(k).padEnd(14)} ${v}`);
console.log('\nstructural coverage');
line('total', state.counts.total);
line('verified', state.counts.verified);
line('failing', state.counts.failing);
line('untested', state.counts.untested);
line('manual-only', state.counts.manualOnly);
line('excluded', state.counts.excluded);
console.log(`\n  open cells     ${untestedNow}${prevUntested === null ? '' : ` (was ${prevUntested})`}`);
if (state.progressed === false) {
  console.log('  WARNING: open-cell count did not decrease this batch.');
}
if (nextBatch) { console.log(`  next batch     ${nextBatch}`); }
console.log(`\n  wrote ${path.relative(root, STATE)} and ${path.relative(root, REPORT)}\n`);

if (strict && (state.counts.failing > 0 || state.counts.untested > 0)) {
  process.exit(1);
}
