import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_TABLES, evidenceOf, isBuiltOnly } from '../src/paths/index.js';
import type { Operation } from '../src/paths/index.js';

/**
 * Every path-table row says how much of the RWS surface it stands for (`tier`)
 * and whether it has run against a controller (`evidence`). These tests keep
 * the tags complete and well formed; the counts they print are the numbers the
 * README's generated tables are checked against.
 */

const TIERS = ['core', 'common', 'niche'] as const;
const EVIDENCE = ['live', 'built'] as const;
const GENS = ['rws1', 'rws2'] as const;

function rows(): Array<{ id: string; op: Operation }> {
  const out: Array<{ id: string; op: Operation }> = [];
  for (const [domain, table] of Object.entries(ALL_TABLES)) {
    for (const [name, op] of Object.entries(table)) { out.push({ id: `${domain}.${name}`, op }); }
  }
  return out;
}

/**
 * The members an interface in src/IRWSAdapter.ts declares itself (not the ones
 * it inherits), each with the doc comment right above it. Read from the source
 * because an interface has no runtime shape.
 */
function interfaceMembers(name: string): Map<string, string> {
  const src = readFileSync(join(__dirname, '..', 'src', 'IRWSAdapter.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf(`export interface ${name} `);
  if (start < 0) { throw new Error(`interface ${name} not found`); }
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  const out = new Map<string, string>();
  // A doc block never runs past a member line, so a comment cannot attach to
  // a member further down.
  const re = /((?:\n {2}\/\*\*(?:(?!\n {2}\w)[\s\S])*?\*\/)?)\n {2}(\w+)\??\(/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) { out.set(m[2], m[1]); }
  return out;
}

/** The member names `IRWSAdapterCore` picks from `IRWSAdapter`, read from its `Pick<...>`. */
function coreKeys(): Set<string> {
  const src = readFileSync(join(__dirname, '..', 'src', 'IRWSAdapter.ts'), 'utf8');
  const m = /export interface IRWSAdapterCore extends Pick<IRWSAdapter,([^>]*)>/.exec(src);
  if (m === null) { throw new Error('IRWSAdapterCore not found'); }
  return new Set([...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]));
}

/** The generations a row wraps: present and not a recorded gap. */
function wrapped(op: Operation): Array<'rws1' | 'rws2'> {
  return GENS.filter(g => op[g] !== undefined && op[g]?.gap === undefined);
}

describe('path-table tiers and evidence', () => {
  it('every row carries a tier and an evidence tag', () => {
    const missing = rows().filter(({ op }) =>
      !(TIERS as readonly string[]).includes(op.tier) || op.evidence === undefined).map(r => r.id);
    expect(missing).toEqual([]);
  });

  it('per-generation evidence names exactly the wrapped generations, and only when they differ', () => {
    const bad: string[] = [];
    for (const { id, op } of rows()) {
      const ev = op.evidence;
      if (typeof ev === 'string') {
        if (!(EVIDENCE as readonly string[]).includes(ev)) { bad.push(`${id}: ${ev}`); }
        continue;
      }
      const keys = Object.keys(ev).sort();
      if (keys.join(',') !== wrapped(op).join(',')) { bad.push(`${id}: keys ${keys.join(',')}`); }
      const vals = Object.values(ev);
      if (vals.some(v => !(EVIDENCE as readonly string[]).includes(v))) { bad.push(`${id}: values`); }
      if (new Set(vals).size < 2) { bad.push(`${id}: per-generation evidence that agrees should be one string`); }
    }
    expect(bad).toEqual([]);
  });

  it('evidenceOf reads the tag per generation and has nothing for a gap or an absent side', () => {
    for (const { id, op } of rows()) {
      for (const g of GENS) {
        const ev = evidenceOf(op, g);
        if (wrapped(op).includes(g)) {
          expect(ev, `${id}.${g}`).toMatch(/^(live|built)$/);
        } else {
          expect(ev, `${id}.${g}`).toBeUndefined();
        }
      }
    }
  });

  it('a side is live exactly when the evidence index holds a logged success for it', () => {
    // tests/fixtures/evidence-index.json is written by scripts/evidence-index.mjs
    // from the probe logs and functional-test traces: one entry per row side
    // whose request answered 2xx. Nothing else makes a side live.
    const index = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'evidence-index.json'), 'utf8')) as
      Record<string, { successes: number; example: string }>;
    const unbacked: string[] = [];
    const untagged: string[] = [];
    for (const { id, op } of rows()) {
      for (const g of GENS) {
        const ev = evidenceOf(op, g);
        const hit = index[`${id}.${g}`];
        if (ev === 'live' && (hit === undefined || hit.successes < 1)) { unbacked.push(`${id}.${g}`); }
        if (ev === 'built' && hit !== undefined) { untagged.push(`${id}.${g}: ${hit.example}`); }
      }
    }
    expect(unbacked).toEqual([]);
    expect(untagged).toEqual([]);
    for (const key of Object.keys(index)) {
      const [domain, name, gen] = key.split('.');
      const op = ALL_TABLES[domain]?.[name];
      expect(op && evidenceOf(op, gen as 'rws1' | 'rws2'), `index entry ${key} names a wrapped row side`).toBeTruthy();
    }
  });

  it('a row whose note says built-not-run is not tagged live on that generation', () => {
    const bad: string[] = [];
    for (const { id, op } of rows()) {
      const note = op.note ?? '';
      if (!/built-not-run|never executed|never sent/i.test(note)) { continue; }
      const onOne = /built-not-run on (1\.0|2\.0)/i.exec(note);
      const gens = onOne ? [onOne[1] === '1.0' ? 'rws1' : 'rws2'] as const : wrapped(op);
      for (const g of gens) { if (evidenceOf(op, g) === 'live') { bad.push(`${id}.${g}`); } }
    }
    expect(bad).toEqual([]);
  });

  it('IRWSAdapterCore picks only IRWSAdapter members, and exactly the core and common rows live on every generation', () => {
    const all = interfaceMembers('IRWSAdapter');
    const core = coreKeys();
    for (const name of core) { expect(all.has(name), name).toBe(true); }
    const wrong: string[] = [];
    const missing: string[] = [];
    for (const { id, op } of rows()) {
      const name = id.split('.')[1];
      const belongs = op.tier !== 'niche' && op.evidence === 'live';
      if (core.has(name) && !belongs) { wrong.push(id); }
      if (!core.has(name) && belongs && all.has(name)) { missing.push(id); }
    }
    expect(wrong).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('every IRWSAdapter member whose row never ran is marked @experimental', () => {
    const all = interfaceMembers('IRWSAdapter');
    const unmarked: string[] = [];
    for (const { id, op } of rows()) {
      const doc = all.get(id.split('.')[1]);
      if (doc !== undefined && isBuiltOnly(op) && !doc.includes('@experimental')) { unmarked.push(id); }
    }
    expect(unmarked).toEqual([]);
  });

  it('prints the counts per tier and evidence', () => {
    const counts: Record<string, number> = {};
    for (const { op } of rows()) {
      const ev = typeof op.evidence === 'string' ? op.evidence : 'mixed';
      counts[`${op.tier}/${ev}`] = (counts[`${op.tier}/${ev}`] ?? 0) + 1;
    }
    // eslint-disable-next-line no-console
    console.log('path-table rows by tier/evidence:', JSON.stringify(counts));
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(rows().length);
  });
});
