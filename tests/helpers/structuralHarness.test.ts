/**
 * Offline checks of the structural harness's cell gate: a cell whose
 * generation has no controller running is skipped whole, with the reason
 * recorded, rather than failing its first test that asks for the controller.
 * Discovery is a fake here, so nothing is sent anywhere.
 *
 * The cells below are declared with `defineCell` and the gate switched on;
 * vitest reports their skipped tests as skipped. The last describe reads what
 * they did.
 *
 * It sits in tests/helpers on purpose: vitest matches a file filter as a
 * substring of the path, so a file named tests/structural* would also run
 * under `vitest run tests/structural` and `npm run structural`, and its S98
 * cells would land in the runner's results.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { defineCell, recordedSkips } from './structuralHarness.js';
import type { LiveController } from './liveControllers.js';

const ran: string[] = [];

const FAKE_RWS2: LiveController = {
  generation: 'rws2', host: '127.0.0.1', port: 1, tls: true,
  baseUrl: 'https://127.0.0.1:1', label: 'fake RWS 2.0 controller',
};

// The runner's skips file, as scripts/structural.mjs sets it. Read when a skip
// is recorded, so setting it while the file is collected is early enough.
const SKIPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'structural-skips-'));
const SKIPS_FILE = path.join(SKIPS_DIR, '.skips.jsonl');
const SKIPS_ENV = process.env.RWS_STRUCTURAL_SKIPS;
process.env.RWS_STRUCTURAL_SKIPS = SKIPS_FILE;
afterAll(() => {
  if (SKIPS_ENV === undefined) { delete process.env.RWS_STRUCTURAL_SKIPS; } else { process.env.RWS_STRUCTURAL_SKIPS = SKIPS_ENV; }
  fs.rmSync(SKIPS_DIR, { recursive: true, force: true });
});

defineCell('S98-harness-gate', 'rws1', ctx => {
  it('a test that asks for the controller', async () => {
    ran.push('rws1 live');
    await ctx.controller();
  });
  it('a test that only talks to a mock', () => { ran.push('rws1 mock'); });
}, { enabled: true, find: async () => null });

defineCell('S98-harness-gate', 'rws2', ctx => {
  it('runs when its controller is found', async () => {
    ran.push('rws2 found');
    expect(await ctx.controller()).toBe(FAKE_RWS2);
  });
  it('can skip itself with a reason', t => {
    ctx.skip(t, 'not on this lane');
    ran.push('rws2 after skip');
  });
}, { enabled: true, find: async g => (g === 'rws2' ? FAKE_RWS2 : null) });

defineCell('S98-harness-off', 'rws1', () => {
  it('is not run while the suite is off', () => { ran.push('off'); });
}, { enabled: false, find: async () => FAKE_RWS2 });

describe('structural harness cell gate', () => {
  it('skips every test of a cell whose controller is missing, the mock-only ones too, and runs the found one', () => {
    expect(ran).toEqual(['rws2 found']);
  });

  it('records each skip with its cell, test and reason', () => {
    const missing = /^no RWS 1\.0 controller reachable on localhost - start the RW6 VC, or set RWS_TEST_PORT_RW6$/;
    expect(recordedSkips()).toEqual([
      { cell: 'S98-harness-gate/rws1', test: 'a test that asks for the controller', reason: expect.stringMatching(missing) },
      { cell: 'S98-harness-gate/rws1', test: 'a test that only talks to a mock', reason: expect.stringMatching(missing) },
      { cell: 'S98-harness-gate/rws2', test: 'can skip itself with a reason', reason: 'not on this lane' },
    ]);
  });

  it('writes the skips to the file the runner names, one JSON line each', () => {
    const lines = fs.readFileSync(SKIPS_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l) as unknown);
    expect(lines).toEqual(recordedSkips());
  });
});
