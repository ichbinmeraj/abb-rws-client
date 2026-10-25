/**
 * Offline checks of scripts/structural.mjs's mapping from test results to
 * matrix cells: a cell whose tests were all skipped stays `untested` and its
 * skip reasons reach state.json and STRUCTURAL.md; a skip never counts as a
 * pass; the pass of a known-gap test (an it.fails test whose title the
 * harness's knownGap() marked) counts as a failure of its cell; and the tests
 * of a cell's mock half (a tests/structural/<cell-id>.mock.test.ts file) fail
 * the cell when they fail but verify it alone only when the matrix marks it
 * automation "mock". The runner is
 * copied into a scratch tree with a small matrix and a report, and run with
 * --no-run, so it neither starts vitest nor touches this repository's docs.
 *
 * It sits in tests/helpers on purpose: vitest matches a file filter as a
 * substring of the path, so a file named tests/structural* would also run
 * under `vitest run tests/structural` and the runner's own pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'structural.mjs');

interface Assertion { title: string; status: 'passed' | 'failed' | 'skipped'; failureMessages?: string[] }

/** One vitest JSON assertion result under a cell's describe. */
function result(cellTitle: string, a: Assertion): Record<string, unknown> {
  return {
    ancestorTitles: ['', cellTitle],
    fullName: ` ${cellTitle} ${a.title}`,
    status: a.status,
    title: a.title,
    failureMessages: a.failureMessages ?? [],
  };
}

const cell = (id: string, generation: 'rws1' | 'rws2'): Record<string, unknown> => ({
  id, scenario: `scenario ${id}`, generation, automation: 'auto', destructive: 0,
  status: 'untested', properties: ['a property'],
});

let tree = '';
let state: {
  buckets: Record<string, string[]>;
  skips: Array<{ cell: string; reasons: Array<{ reason: string; tests: number }> }>;
  failures: Array<{ cell: string; failures: Array<{ name: string; message: string }> }>;
};
let report = '';

beforeAll(() => {
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'structural-runner-'));
  fs.mkdirSync(path.join(tree, 'scripts'));
  fs.mkdirSync(path.join(tree, 'docs', 'structural'), { recursive: true });
  fs.copyFileSync(RUNNER, path.join(tree, 'scripts', 'structural.mjs'));

  fs.writeFileSync(path.join(tree, 'docs', 'structural', 'matrix.json'), JSON.stringify({
    cells: [
      cell('S90-all-skipped', 'rws1'), cell('S90-all-skipped', 'rws2'), cell('S91-partly-skipped', 'rws2'),
      cell('S92-not-run', 'rws1'), cell('S93-known-gap', 'rws1'), cell('S93-known-gap', 'rws2'),
      cell('S94-mock-half', 'rws1'), cell('S94-mock-half', 'rws2'), cell('S95-mock-failing', 'rws1'),
      { ...cell('S96-mock-only', 'rws1'), automation: 'mock' },
    ],
  }));

  const missing = 'no RWS 1.0 controller reachable on localhost - start the RW6 VC, or set RWS_TEST_PORT_RW6';
  fs.writeFileSync(path.join(tree, 'docs', 'structural', '.vitest-results.json'), JSON.stringify({
    testResults: [{
      assertionResults: [
        result('S90-all-skipped/rws1', { title: 'mock test', status: 'skipped' }),
        result('S90-all-skipped/rws1', { title: 'live test', status: 'skipped' }),
        result('S90-all-skipped/rws2', { title: 'mock test', status: 'passed' }),
        result('S90-all-skipped/rws2', { title: 'live test', status: 'failed', failureMessages: ['Error: refused'] }),
        result('S91-partly-skipped/rws2', { title: 'counted', status: 'skipped' }),
        result('S91-partly-skipped/rws2', { title: 'wire', status: 'passed' }),
        // it.fails with the gap open: vitest reports it passed.
        result('S93-known-gap/rws2', { title: 'holds X [known gap: the client does Y]', status: 'passed' }),
        result('S93-known-gap/rws2', { title: 'wire', status: 'passed' }),
        // it.fails after the client was fixed: vitest reports it failed.
        result('S93-known-gap/rws1', {
          title: 'holds X [known gap: the client does Y]', status: 'failed', failureMessages: ['Expect test to fail'],
        }),
        result('S94-mock-half/rws1', { title: 'live half', status: 'passed' }),
        result('S94-mock-half/rws2', { title: 'live half', status: 'skipped' }),
        result('S95-mock-failing/rws1', { title: 'live half', status: 'passed' }),
      ],
    }, {
      // A cell's mock half: the file name marks it (vitest names each file by its path).
      name: path.join(tree, 'tests', 'structural', 'S94-mock-half.mock.test.ts'),
      assertionResults: [
        result('S94-mock-half/rws1', { title: 'mock one', status: 'passed' }),
        result('S94-mock-half/rws1', { title: 'mock two', status: 'passed' }),
        result('S94-mock-half/rws2', { title: 'mock one', status: 'passed' }),
        result('S95-mock-failing/rws1', { title: 'mock one', status: 'failed', failureMessages: ['Error: counted 2, wanted 1'] }),
        result('S96-mock-only/rws1', { title: 'mock one', status: 'passed' }),
      ],
    }],
  }));
  fs.writeFileSync(path.join(tree, 'docs', 'structural', '.skips.jsonl'), [
    { cell: 'S90-all-skipped/rws1', test: 'mock test', reason: missing },
    { cell: 'S90-all-skipped/rws1', test: 'live test', reason: missing },
    { cell: 'S91-partly-skipped/rws2', test: 'counted', reason: 'nothing on RWS 2.0 counts sessions' },
  ].map(s => JSON.stringify(s)).join('\n') + '\n');

  execFileSync(process.execPath, [path.join(tree, 'scripts', 'structural.mjs'), '--no-run'], { stdio: 'pipe' });
  state = JSON.parse(fs.readFileSync(path.join(tree, 'docs', 'structural', 'state.json'), 'utf8')) as typeof state;
  report = fs.readFileSync(path.join(tree, 'STRUCTURAL.md'), 'utf8');
});

afterAll(() => { if (tree) { fs.rmSync(tree, { recursive: true, force: true }); } });

describe('structural runner mapping', () => {
  it('keeps a cell whose tests were all skipped untested, never verified', () => {
    expect(state.buckets.untested).toContain('S90-all-skipped/rws1');
    expect(state.buckets.verified).not.toContain('S90-all-skipped/rws1');
    expect(state.buckets.untested).toContain('S92-not-run/rws1');
  });

  it('still fails a cell with a failing test and verifies one with a pass and no failure', () => {
    expect(state.buckets.failing).toContain('S90-all-skipped/rws2');
    expect(state.buckets.verified).toEqual(['S91-partly-skipped/rws2', 'S94-mock-half/rws1', 'S96-mock-only/rws1']);
  });

  it('reads the pass of a known-gap test as a failure of its cell, naming the gap, and its failure as a failure', () => {
    expect(state.buckets.failing).toEqual(['S90-all-skipped/rws2', 'S93-known-gap/rws1', 'S93-known-gap/rws2', 'S95-mock-failing/rws1']);
    expect(state.failures.find(f => f.cell === 'S93-known-gap/rws2')?.failures).toEqual([{
      name: 'S93-known-gap/rws2 > holds X [known gap: the client does Y]',
      message: 'known gap, still open (an it.fails test that failed as expected): the client does Y',
    }]);
    expect(report).toContain('known gap, still open (an it.fails test that failed as expected): the client does Y');
  });

  it('counts a mock half beside the live one: its failure fails the cell, its pass alone verifies only an automation "mock" cell', () => {
    // Live and mock passes: verified, and the report counts both.
    expect(state.buckets.verified).toContain('S94-mock-half/rws1');
    expect(report).toContain('**rws1** - verified (1 passed, 0 failed; mock controller: 2 passed)');
    // A mock pass with the live half skipped stays untested.
    expect(state.buckets.untested).toContain('S94-mock-half/rws2');
    expect(report).toContain('**rws2** - untested (0 passed, 0 failed, 1 skipped; mock controller: 1 passed)');
    // A failing mock half fails the cell, and the failure says it was the mock's.
    expect(state.failures.find(f => f.cell === 'S95-mock-failing/rws1')?.failures).toEqual([{
      name: 'S95-mock-failing/rws1 > mock one (mock controller)',
      message: 'Error: counted 2, wanted 1',
    }]);
    // A cell the matrix marks automation "mock" is verified by its mock half.
    expect(state.buckets.verified).toContain('S96-mock-only/rws1');
  });

  it('reports the skip reasons per cell, with the number of tests each skipped', () => {
    expect(state.skips).toEqual([
      {
        cell: 'S90-all-skipped/rws1',
        reasons: [{ reason: 'no RWS 1.0 controller reachable on localhost - start the RW6 VC, or set RWS_TEST_PORT_RW6', tests: 2 }],
      },
      { cell: 'S91-partly-skipped/rws2', reasons: [{ reason: 'nothing on RWS 2.0 counts sessions', tests: 1 }] },
    ]);
    expect(report).toContain('**rws1** - untested (0 passed, 0 failed, 2 skipped)');
    expect(report).toContain('- 2 tests: no RWS 1.0 controller reachable on localhost');
    expect(report).toContain('- 1 test: nothing on RWS 2.0 counts sessions');
  });
});
