import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_TABLES, evidenceOf } from '../src/paths/index.js';
import type { Operation } from '../src/paths/index.js';

/**
 * The reverse of the tier checks in pathspec.tiers.test.ts: there, a row that
 * never ran must be marked; here, a doc comment must not say a request never
 * ran on a generation where its path row is `live` (a logged 2xx in
 * tests/fixtures/evidence-index.json), and the README access table must not
 * call a live write absent ("-") on that generation.
 *
 * A path row maps to the methods that implement it as in the tier checks: by
 * name, the row id's operation name being the method name. (A method's body
 * also names the path specs of the reads it does around its write, so mapping
 * by the specs a body names would charge a write's claim to its reads.)
 */

type Gen = 'rws1' | 'rws2';
const GENS: readonly Gen[] = ['rws1', 'rws2'];
const SRC = join(__dirname, '..', 'src');

function rows(): Array<{ id: string; name: string; op: Operation }> {
  const out: Array<{ id: string; name: string; op: Operation }> = [];
  for (const [domain, table] of Object.entries(ALL_TABLES)) {
    for (const [name, op] of Object.entries(table)) { out.push({ id: `${domain}.${name}`, name, op }); }
  }
  return out;
}

/**
 * The files that implement each generation, and the shared ones. A claim in a
 * generation's file is about that generation unless the clause names another;
 * a claim in a shared file is about every generation the row wraps unless the
 * clause names one.
 */
const FILES: Array<{ file: string; gens: readonly Gen[] }> = [
  { file: 'RWS1Adapter.ts', gens: ['rws1'] },
  { file: 'RwsClient.ts', gens: ['rws1'] },
  { file: 'RwsClient2.ts', gens: ['rws2'] },
  { file: 'RWS2Adapter.ts', gens: ['rws2'] },
  ...readdirSync(join(SRC, 'rws2')).filter(f => f.endsWith('.ts')).map(f => ({ file: `rws2/${f}`, gens: ['rws2'] as const })),
  { file: 'IRWSAdapter.ts', gens: GENS },
  { file: 'RobotManager.ts', gens: GENS },
  { file: 'ResourceMapper.ts', gens: ['rws1'] },
];

interface Member {
  file: string;
  gens: readonly Gen[];
  name: string;
  /** The doc comment's lines, each with its 1-based line number in the file. */
  doc: Array<{ line: number; text: string }>;
}

/** Every documented member of a file: a doc block followed directly by a method, function or interface member. */
function members(file: string, gens: readonly Gen[]): Member[] {
  const src = readFileSync(join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
  const re = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/[ \t]*\n[ \t]*(?:(?:export|function|public|private|protected|static|override|async|readonly|get|set)\s+)*(\w+)\??\s*[<(:]/g;
  const out: Member[] = [];
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const first = src.slice(0, m.index).split('\n').length;
    const doc = m[1].split('\n').map((text, k) => ({ line: first + k, text: text.replace(/^\s*\*\s?/, '') }));
    out.push({ file, gens, name: m[2], doc });
  }
  return out;
}

/** A claim that a request has not run or been sent. "not run out" is a timeout, not a claim. */
const CLAIM = /\bnever (?:been )?run\b|\bnot (?:yet )?run\b(?! out)|\bbuilt, not run\b|\bbuilt-not-run\b|\b(?:has|have|had) (?:not|never) (?:yet )?been (?:run|sent)\b|\bnot (?:yet )?been sent\b|\b(?:never|not) (?:yet )?executed\b|\bno logged (?:2xx|success)\b|\bnot (?:yet )?verified live\b/i;
/** Inside an `@experimental` tag, a clause that says a side is only built counts as well. */
const NOT_RUN = new RegExp(`${CLAIM.source}|\\bbuilt\\b`, 'i');
const MARK_RWS1 = /RWS 1\.0|RobotWare 6|\bRW ?6(?:\.\d+)*\b|IRC5/;
const MARK_RWS2 = /RWS 2\.0|OmniCore/;
const MARK_RW7 = /RobotWare 7|\bRW ?7(?:\.\d+)*\b/;
const MARK_RW8 = /RobotWare 8|\bRW ?8(?:\.\d+)*\b/;

/**
 * The generations a clause names, or `null` when it names none. A clause that
 * names only one of RobotWare 7 and 8 speaks about that version, which the
 * evidence index does not separate, so it names no generation it can be held to.
 */
function named(clause: string): Gen[] | null {
  const out: Gen[] = [];
  if (MARK_RWS1.test(clause)) { out.push('rws1'); }
  const rw7 = MARK_RW7.test(clause);
  const rw8 = MARK_RW8.test(clause);
  if (MARK_RWS2.test(clause) || (rw7 && rw8)) { out.push('rws2'); }
  return out.length > 0 || rw7 || rw8 ? out : null;
}

/** A doc text cut into clauses: at `;`, at a full stop before a space or the end, or at a blank line. */
function clauses(text: string): Array<{ at: number; text: string }> {
  const cuts = [0, ...[...text.matchAll(/;|\.(?=\s|$)|\n\s*\n/g)].map(b => (b.index ?? 0) + b[0].length), text.length];
  const out: Array<{ at: number; text: string }> = [];
  for (let i = 0; i + 1 < cuts.length; i++) { out.push({ at: cuts[i], text: text.slice(cuts[i], cuts[i + 1]) }); }
  return out;
}

/**
 * Each never-ran claim in a doc comment, with the generations it is about: the
 * ones its clause names, else the file's generation (a shared file: every
 * generation the row wraps). An `@experimental` tag is a claim about the
 * generations its not-run clauses name, or the file's when they name none.
 */
function claims(m: Member, rowGens: readonly Gen[]): Array<{ line: number; gens: readonly Gen[]; text: string }> {
  const joined = m.doc.map(d => d.text).join('\n');
  const lineOf = (offset: number): number => m.doc[joined.slice(0, offset).split('\n').length - 1].line;
  const fallback = m.gens.length === 1 ? m.gens : rowGens;
  const out: Array<{ line: number; gens: readonly Gen[]; text: string }> = [];
  for (const c of clauses(joined)) {
    const hit = CLAIM.exec(c.text);
    if (hit === null) { continue; }
    out.push({ line: lineOf(c.at + hit.index), gens: named(c.text) ?? fallback, text: c.text.replace(/\s+/g, ' ').trim() });
  }
  for (const e of joined.matchAll(/@experimental\b[^@]*?(?=\n\s*\n|@|$)/g)) {
    const line = lineOf(e.index ?? 0);
    if (out.some(c => c.line === line)) { continue; }
    const said = clauses(e[0]).filter(c => NOT_RUN.test(c.text)).map(c => named(c.text)).filter(g => g !== null);
    const gens = said.length > 0 ? [...new Set(said.flat())] : fallback;
    out.push({ line, gens, text: e[0].replace(/\s+/g, ' ').trim() });
  }
  return out;
}

describe('doc comments follow the evidence', () => {
  const all = FILES.flatMap(f => members(f.file, f.gens));

  it('no method of a live row side says it never ran on that generation', () => {
    const offenders = new Set<string>();
    for (const { id, name, op } of rows()) {
      const live = GENS.filter(g => evidenceOf(op, g) === 'live');
      if (live.length === 0) { continue; }
      const wrapped = GENS.filter(g => evidenceOf(op, g) !== undefined);
      for (const m of all.filter(x => x.name === name)) {
        // A generation's file implements that generation; a shared file every wrapped one.
        const implemented = m.gens.filter(g => wrapped.includes(g));
        for (const c of claims(m, wrapped)) {
          const wrong = c.gens.filter(g => implemented.includes(g) && live.includes(g));
          if (wrong.length > 0) {
            offenders.add(`src/${m.file}:${c.line} ${m.name} (${id} live on ${wrong.join(', ')}): ${c.text}`);
          }
        }
      }
    }
    const list = [...offenders].sort();
    // eslint-disable-next-line no-console
    if (list.length > 0) { console.log(`never-ran claims on live row sides (${list.length}):\n${list.join('\n')}`); }
    expect(list).toEqual([]);
  });

  it('no method of a built row side says it ran live on that generation', () => {
    // The reverse of the check above: a doc comment must not claim a live run
    // (live-verified, round-tripped) on a generation whose row side is `built`.
    // An unlogged record does not count: log the run, or drop the claim.
    const LIVE = /\blive[- ]?(?:verified|round-tripped|tested)\b|\bverified live\b|\bround-tripped\b/i;
    const offenders = new Set<string>();
    for (const { id, name, op } of rows()) {
      const built = GENS.filter(g => evidenceOf(op, g) === 'built');
      if (built.length === 0) { continue; }
      const wrapped = GENS.filter(g => evidenceOf(op, g) !== undefined);
      for (const m of all.filter(x => x.name === name)) {
        const implemented = m.gens.filter(g => wrapped.includes(g));
        const fallback = m.gens.length === 1 ? m.gens : wrapped;
        const joined = m.doc.map(d => d.text).join('\n');
        for (const c of clauses(joined)) {
          const hit = LIVE.exec(c.text);
          if (hit === null) { continue; }
          const gens = named(c.text) ?? fallback;
          const wrong = gens.filter(g => implemented.includes(g) && built.includes(g));
          if (wrong.length > 0) {
            const line = m.doc[joined.slice(0, c.at + hit.index).split('\n').length - 1].line;
            offenders.add(`src/${m.file}:${line} ${m.name} (${id} built on ${wrong.join(', ')}): ${c.text.replace(/\s+/g, ' ').trim()}`);
          }
        }
      }
    }
    const list = [...offenders].sort();
    // eslint-disable-next-line no-console
    if (list.length > 0) { console.log(`live claims on built row sides (${list.length}):\n${list.join('\n')}`); }
    expect(list).toEqual([]);
  });

  it('an IRWSAdapter member is @experimental only while a generation it has is built', () => {
    const iface = all.filter(m => m.file === 'IRWSAdapter.ts');
    const bad: string[] = [];
    for (const { id, name, op } of rows()) {
      const wrapped = GENS.filter(g => evidenceOf(op, g) !== undefined);
      if (wrapped.length === 0 || wrapped.some(g => evidenceOf(op, g) === 'built')) { continue; }
      for (const m of iface.filter(x => x.name === name)) {
        const tag = m.doc.find(d => d.text.includes('@experimental'));
        if (tag !== undefined) { bad.push(`src/IRWSAdapter.ts:${tag.line} ${name} (${id} live on ${wrapped.join(', ')})`); }
      }
    }
    // eslint-disable-next-line no-console
    if (bad.length > 0) { console.log(`@experimental on fully live IRWSAdapter members (${bad.length}):\n${bad.join('\n')}`); }
    expect(bad).toEqual([]);
  });

  it('the README access table does not call a live write absent on its generation', () => {
    const lines = readFileSync(join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const head = lines.findIndex(l => /^#### Access each write takes/.test(l));
    expect(head, 'README section "Access each write takes"').toBeGreaterThan(0);
    const byName = new Map<string, Array<{ id: string; op: Operation }>>();
    for (const r of rows()) { byName.set(r.name, [...(byName.get(r.name) ?? []), r]); }
    const bad: string[] = [];
    let i = head;
    while (i < lines.length && !lines[i].startsWith('| Write |')) { i++; }
    for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) {
      const [write, rw6, rw7, rw8] = lines[i].split('|').slice(1, -1).map(c => c.trim());
      // RobotWare 6 is RWS 1.0; RobotWare 7 and 8 together are RWS 2.0.
      const absent: Gen[] = [];
      if (rw6 === '-') { absent.push('rws1'); }
      if (rw7 === '-' && rw8 === '-') { absent.push('rws2'); }
      for (const n of [...write.matchAll(/`(?:\w+\.)?(\w+)/g)].map(x => x[1])) {
        for (const { id, op } of byName.get(n) ?? []) {
          for (const g of absent) {
            if (evidenceOf(op, g) === 'live') { bad.push(`README.md:${i + 1} ${n} (${id} live on ${g}) shown as "-"`); }
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    if (bad.length > 0) { console.log(`README access table "-" on live writes (${bad.length}):\n${bad.join('\n')}`); }
    expect(bad).toEqual([]);
  });
});
