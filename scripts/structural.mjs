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
  try {
    execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', 'tests/structural', '--reporter=json', `--outputFile=${RESULTS}`],
      {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60 * 60 * 1000,
        // Structural cells inject faults against live VCs and are slow, so they
        // stay out of `npm test`. Only this runner turns them on.
        env: { ...process.env, RWS_STRUCTURAL: '1' },
      },
    );
  } catch {
    // Non-zero exit just means cells failed; the JSON report is what we read.
  }
  if (fs.existsSync(RESULTS)) {
    try { vitest = JSON.parse(fs.readFileSync(RESULTS, 'utf8')); }
    catch { vitest = null; }
  }
}

// ─── 2. Map assertion results onto cells ─────────────────────────────────────

/** cellKey -> { passed, failed, skipped, failures: [{name, message}] } */
const observed = new Map();

if (vitest?.testResults) {
  for (const file of vitest.testResults) {
    for (const t of file.assertionResults ?? []) {
      // ancestorTitles[0] is the top-level describe: "<cell-id>/<generation>"
      const top = (t.ancestorTitles ?? [])[0] ?? '';
      if (!/^S\d{2}-[a-z0-9-]+\/(rws1|rws2)$/.test(top)) { continue; }
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

md += `## Known limits

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
