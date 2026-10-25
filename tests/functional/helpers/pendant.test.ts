/**
 * Offline checks of the pendant-session helpers: `waitForPerson` prints its
 * prompt once and polls until the check passes or the time is up, and the
 * baseline rule turns a lane that does not read Auto into an environment
 * blocker. Nothing here reaches a controller.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PERSON_WAIT_MS, pendantSession, waitForPerson } from './pendant.js';
import { baselineBlocker } from './state.js';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

function capture(): { lines: string[]; write: (text: string) => void } {
  const lines: string[] = [];
  return { lines, write: (text: string) => { lines.push(text); } };
}

describe('waitForPerson', () => {
  it('prints the prompt once and resolves when the check passes', async () => {
    const out = capture();
    let calls = 0;
    const w = await waitForPerson('Confirm Auto on the RW7 pendant', () => ++calls >= 4, 5_000, { pollMs: 5, write: out.write });
    expect(w.met).toBe(true);
    expect(w.checks).toBe(4);
    expect(out.lines.filter(l => l.includes('Confirm Auto on the RW7 pendant'))).toHaveLength(1);
    expect(out.lines[out.lines.length - 1]).toMatch(/done, seen after/);
  });

  it('checks at once: a check that already passes needs no wait', async () => {
    const out = capture();
    const w = await waitForPerson('Press Grant on the RW7 pendant', () => true, 5_000, { pollMs: 1_000, write: out.write });
    expect(w).toMatchObject({ met: true, checks: 1 });
    expect(w.ms).toBeLessThan(500);
  });

  it('gives up after the timeout without throwing, and says so', async () => {
    const out = capture();
    const w = await waitForPerson('Turn the RW6 key switch to manual', () => false, 60, { pollMs: 10, write: out.write });
    expect(w.met).toBe(false);
    expect(w.ms).toBeGreaterThanOrEqual(60);
    expect(w.checks).toBeGreaterThan(1);
    expect(out.lines.filter(l => l.includes('Turn the RW6 key switch to manual'))).toHaveLength(1);
    expect(out.lines[out.lines.length - 1]).toMatch(/not seen within/);
  });

  it('counts a check that throws as not done yet and keeps polling', async () => {
    const out = capture();
    let calls = 0;
    const w = await waitForPerson('Confirm Auto on the RW8 pendant', async () => {
      calls++;
      if (calls < 3) { throw new Error('read failed'); }
      return true;
    }, 5_000, { pollMs: 5, write: out.write });
    expect(w).toMatchObject({ met: true, checks: 3, lastError: 'read failed' });
  });

  it('waits 180 s by default', () => {
    expect(PERSON_WAIT_MS).toBe(180_000);
  });

  it('writes to stderr unless told otherwise', async () => {
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await waitForPerson('Press Grant on the RW7 pendant', () => true, 1_000);
    } finally {
      process.stderr.write = orig;
    }
    expect(written.join('')).toMatch(/PENDANT: Press Grant on the RW7 pendant/);
  });
});

describe('pendantSession', () => {
  it('is on only for RWS_FUNCTIONAL_PENDANT=1', () => {
    delete process.env.RWS_FUNCTIONAL_PENDANT;
    expect(pendantSession()).toBe(false);
    process.env.RWS_FUNCTIONAL_PENDANT = '0';
    expect(pendantSession()).toBe(false);
    process.env.RWS_FUNCTIONAL_PENDANT = '1';
    expect(pendantSession()).toBe(true);
  });
});

describe('baseline blocker', () => {
  it('takes Auto as a baseline', () => {
    for (const lane of ['rw6', 'rw7', 'rw8'] as const) { expect(baselineBlocker(lane, 'AUTO')).toBeNull(); }
  });

  it('reports a pending change as an environment blocker, never a baseline', () => {
    const r = baselineBlocker('rw7', 'AUTO_CH');
    expect(r).toMatch(/^environment blocker: /);
    expect(r).toMatch(/AUTO_CH/);
    expect(r).toMatch(/confirm Auto at the RW7 pendant$/);
    expect(baselineBlocker('rw8', 'MANF_CH')).toMatch(/confirm Auto at the RW8 pendant$/);
  });

  it('reports a manual mode as an environment blocker', () => {
    for (const mode of ['MANR', 'MANF']) {
      const r = baselineBlocker('rw6', mode);
      expect(r).toMatch(/^environment blocker: the controller is in /);
      expect(r).toMatch(/confirm Auto at the RW6 pendant$/);
    }
  });

  it('leaves an unread mode to the snapshot errors', () => {
    expect(baselineBlocker('rw7', null)).toBeNull();
    expect(baselineBlocker('rw7', undefined)).toBeNull();
  });
});

describe('functional:pendant script (offline parts)', () => {
  it('runs rw8, rw7, rw6 by default and keeps a given order', async () => {
    // @ts-expect-error - plain .mjs script without type declarations
    const { parseArgs } = await import('../../../scripts/functional-pendant.mjs');
    expect(parseArgs([]).lanes).toEqual(['rw8', 'rw7', 'rw6']);
    expect(parseArgs(['rw6', 'RW7', 'rw6', '--yes', '--manual-only'])).toMatchObject({ lanes: ['rw6', 'rw7'], yes: true, manualOnly: true, unknown: [] });
    expect(parseArgs(['rw9']).unknown).toEqual(['rw9']);
  });

  it('tells the owner, before each lane, every prompt the lane will show', async () => {
    // @ts-expect-error - plain .mjs script without type declarations
    const { briefingLines } = await import('../../../scripts/functional-pendant.mjs');
    const text = (lane: string): string => briefingLines(lane, 1, 3).join('\n');
    expect(text('rw7')).toMatch(/Press Grant on the RW7 pendant/);
    expect(text('rw7')).toMatch(/Confirm Auto on the RW7 pendant/);
    expect(text('rw8')).toMatch(/Confirm Auto on the RW8 pendant/);
    expect(text('rw6')).toMatch(/Turn the RW6 key switch to manual/);
    expect(text('rw6')).toMatch(/Turn the RW6 key switch back to Auto/);
    for (const lane of ['rw6', 'rw7', 'rw8']) { expect(text(lane)).toMatch(new RegExp(`confirm Auto at the ${lane.toUpperCase()} pendant`)); }
  });

  it('reads a lane result from its run directory: counts, the lane blocker and the verdict', async () => {
    // @ts-expect-error - plain .mjs script without type declarations
    const { laneResult, verdict, summaryLines } = await import('../../../scripts/functional-pendant.mjs');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-'));
    try {
      const results = { testResults: [{ assertionResults: [
        { ancestorTitles: ['09-motion/rw7'], status: 'passed' },
        { ancestorTitles: ['09-motion/rw7'], status: 'skipped' },
        { ancestorTitles: ['09-motion/rw8'], status: 'failed' },
      ] }] };
      fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results));
      const r7 = laneResult(dir, 'rw7');
      expect(r7).toMatchObject({ passed: 1, failed: 0, skipped: 1, blocker: null, report: true });
      expect(verdict(r7)).toBe('PASSED');

      fs.writeFileSync(path.join(dir, 'skips.jsonl'), `${JSON.stringify({ file: '09-motion', lane: 'rw7', test: '*', reason: baselineBlocker('rw7', 'AUTO_CH') })}\n`);
      const blocked = laneResult(dir, 'rw7');
      expect(verdict({ ...blocked, passed: 0, skipped: 2 })).toBe('BLOCKED');
      expect(summaryLines([{ ...blocked, passed: 0, runId: 'x' }]).join('\n')).toMatch(/confirm Auto at the RW7 pendant/);

      expect(verdict(laneResult(dir, 'rw8'))).toBe('FAILED');
      expect(verdict(laneResult(path.join(dir, 'missing'), 'rw6'))).toBe('NO REPORT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
