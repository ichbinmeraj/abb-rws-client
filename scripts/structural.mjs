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

const strict = process.argv.includes('--strict');
const skipRun = process.argv.includes('--no-run');

const matrix = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
const cellKey = (c) => `${c.id}/${c.generation}`;

// ─── 1. Run the structural suites ────────────────────────────────────────────

let vitest = null;
if (!skipRun) {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  // Invoke vitest's JS entry with the SAME node that runs this script, rather
  // than the `npx` shim. On Windows, execFile-ing a .cmd now fails EINVAL (Node
  // hardened it), and going through a shell would put the outputFile path at the
  // mercy of shell quoting. This avoids both.
  const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(vitestBin)) {
    console.error(`structural: cannot find vitest at ${vitestBin} - run npm ci first`);
    process.exit(2);
  }
  try {
    execFileSync(
      process.execPath,
      [
        vitestBin,
        'run', 'tests/structural',
        // Cells run SERIALLY. Vitest parallelises test files by default, which
        // would put several live clients on the same controller at once - each
        // with its own paced request queue. Independently they respect the
        // <20 req/s ceiling; together they do not, and the controller answers
        // 503. That is a property of the rig, not of the client, and it would
        // show up as phantom cell failures.
        '--no-file-parallelism',
        '--reporter=json', `--outputFile=${RESULTS}`,
      ],
      {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60 * 60 * 1000,
        // Structural cells inject faults against live VCs and are slow, so they
        // stay out of `npm test`. Only this runner turns them on.
        env: { ...process.env, RWS_STRUCTURAL: '1' },
      },
    );
  } catch (e) {
    // A non-zero EXIT is expected - it just means cells failed, and the JSON
    // report is what we read. A spawn failure is not, and silently swallowing it
    // reports every cell as `untested`, which looks like "no tests written yet"
    // rather than "the runner never ran". Distinguish them.
    if (e && typeof e === 'object' && e.status === null) {
      console.error(`structural: could not run vitest (${e.code ?? e.message})`);
      if (e.stderr?.length) { console.error(String(e.stderr).slice(0, 1000)); }
      process.exit(2);
    }
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

/** cellKey -> { passed, failed, skipped, failures: [{name, message}] } */
const observed = new Map();

if (vitest?.testResults) {
  for (const file of vitest.testResults) {
    for (const t of file.assertionResults ?? []) {
      // SEARCH the ancestor chain rather than indexing it. Vitest prefixes the
      // chain with an empty string for the file-level implicit suite, so the
      // cell title sits at [1], not [0] - indexing [0] matched nothing and made
      // every cell look untested even though the tests had run.
      const top = (t.ancestorTitles ?? []).find(a => CELL_TITLE.test(a ?? ''));
      if (!top) { continue; }
      const rec = observed.get(top) ?? { passed: 0, failed: 0, skipped: 0, failures: [] };
      if (t.status === 'passed') { rec.passed++; }
      else if (t.status === 'failed') {
        rec.failed++;
        rec.failures.push({
          name: [...(t.ancestorTitles ?? []).slice(1), t.title].join(' > '),
          message: (t.failureMessages ?? []).join('\n').split('\n').slice(0, 4).join(' '),
        });
      } else { rec.skipped++; }
      observed.set(top, rec);
    }
  }
}

// ─── 3. Resolve each cell's status ───────────────────────────────────────────

const resolved = matrix.cells.map(cell => {
  const key = cellKey(cell);
  const declared = cell.status ?? 'untested';

  // A cell the matrix pins as manual-only or excluded is not decided by tests.
  if (declared === 'manual-only' || declared === 'excluded') {
    return { ...cell, key, resolved: declared, observed: observed.get(key) ?? null };
  }
  const o = observed.get(key);
  // A cell the matrix declares un-automatable is manual-only once it carries a
  // written procedure - not "untested", which would imply someone forgot it.
  if (cell.automation === 'manual' && !o) {
    return { ...cell, key, resolved: 'manual-only', observed: null };
  }
  if (!o || (o.passed === 0 && o.failed === 0)) {
    return { ...cell, key, resolved: 'untested', observed: o ?? null };
  }
  if (o.failed > 0) { return { ...cell, key, resolved: 'failing', observed: o }; }
  return { ...cell, key, resolved: 'verified', observed: o };
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
  $comment: 'Loop memory for docs/tasks/structural-coverage-loop.md. Regenerated by npm run structural.',
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

Regenerated by \`npm run structural\`. Loop definition:
\`docs/tasks/structural-coverage-loop.md\`. Machine state:
\`docs/structural/state.json\`.

**${state.counts.verified} verified · ${state.counts.failing} failing · ${state.counts.untested} untested · ${state.counts.manualOnly} manual-only · ${state.counts.excluded} excluded** (of ${state.counts.total} cells)

Every cell is one scenario on one protocol generation. A cell is \`verified\`
only when a test asserting it ran green against a live controller; a cell with
no test is \`untested\`, never assumed.

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
    if (c.observed) { md += ` (${c.observed.passed} passed, ${c.observed.failed} failed)`; }
    md += `\n\n`;
    md += c.properties.map(p => `- ${p}`).join('\n') + '\n';
    if (c.note) { md += `\n> ${c.note}\n`; }
    if (c.manualProcedure) { md += `\n**Manual procedure**\n\n${c.manualProcedure}\n`; }
    if (c.observed?.failures?.length) {
      md += `\nFailures:\n\n`;
      for (const f of c.observed.failures) { md += `- \`${f.name}\` - ${f.message}\n`; }
    }
    md += '\n';
  }
}

md += `## Running the loop

\`\`\`bash
npm run structural          # run the auto cells, regenerate this file + state.json
npm run structural -- --no-run   # re-map the LAST run's results (after editing the matrix)
npm run structural -- --strict   # non-zero exit while any cell is failing or untested
node scripts/soak.mjs --minutes 1440   # S15 acceptance run (see below)
\`\`\`

Cells run **serially** (\`--no-file-parallelism\`). Vitest parallelises files by
default, which would put several live clients on one controller at once; each
paces itself correctly but nothing coordinates across clients, and the pair
exceeds the controller's <20 req/s ceiling.

**Start from a freshly restarted controller.** Sessions linger for 300 s, so a
controller that has just run a long suite sits near its cap and answers 503 to
anything extra - which fails cells for a property they are not testing.

## Known limits

- Direct session counting is **not observable on RWS 2.0**: \`GET /users\`
  enumerates users, not sessions, so it does not move when a client connects.
  S05's premise guard detects this and refuses to assert a leak it cannot see.
- A half-open state affecting **only** the RWS 2.0 subscription WebSocket, while
  HTTP still works, cannot be detected in band: the controller rejects client
  frames on that socket and an idle subscription sends nothing back. Detection
  covers link-level failure.
- TLS is opaque to the TCP chaos proxy, so wire-level assertions (headers,
  request lines) are only possible on RWS 1.0 or against a mock HTTPS server.
- Live cells run against **localhost virtual controllers only**; the helper in
  \`tests/helpers/liveControllers.ts\` refuses any other host outright.
- VC RWS ports drift across restarts, so they are discovered every run rather
  than configured. Override with \`RWS_TEST_PORT_RW6\` / \`RWS_TEST_PORT_RW7\`.
- Warm restart is the destructive ceiling. No cell resets a system, restores a
  backup, runs an installer, or mutates UAS.
- IK/FK failures on a VC are a missing option (PC Interface 616-1), not a defect.
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
