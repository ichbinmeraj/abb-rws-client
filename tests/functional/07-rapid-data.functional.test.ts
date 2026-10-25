/**
 * Functional: RAPID data through the client, per controller.
 *
 * A ZZ_PROBE data module is uploaded and loaded through `RobotManager`
 * (VAR, PERS and CONST of num, string and bool, 1-D and 2-D num arrays, and
 * the robtarget record). Every symbol is read, every VAR and PERS written and
 * read back (through the manager and through a direct adapter read), each
 * CONST write is refused with an RwsError, and the typed errors for a missing
 * symbol and a wrong-typed value are checked. Symbol properties, symbol
 * search (RWS 1.0 through the plural `search-symbols` action), the module
 * list, the whole module text and text ranges (RWS 1.0 range text is
 * entity-decoded) are read. An identifier longer than 32 characters is
 * loaded, and large arrays are read and written at the recorded size
 * ceilings of each build. The last tests unload the modules, delete the
 * files and check the controller is as the baseline found it.
 *
 * Everything this file loads or uploads is named ZZ_PROBE, so the harness
 * restore removes whatever a failed test leaves behind.
 *
 * Expectations per build come from the live verification of 2026-09-29 on
 * RW 6.16.03 (6.16.3007), RW 7.21.4 and RW 8.2.1:
 * - A missing data symbol reads 404 -1073442816 "Symbol not found" on RW 7.21.4
 *   and 8.2.1, and 400 -1073414146 "Symbol not found" on RW 6.16.03; a missing
 *   symbol's properties read 404 (RW7/RW8) or 400 (RW6) -1073414146. The
 *   client reads all of them as RESOURCE_NOT_FOUND. A second unload of a
 *   module answers 400 -1073442816 "Unknown module name" on all three
 *   (MODULE_NOT_FOUND).
 * - RWS 1.0 symbol search is the plural `?action=search-symbols` (the
 *   singular is refused 400); the scope comes from `blockurl`.
 * - The RWS 1.0 text-range read carries XML entities inside its JSON value;
 *   the whole-module read is URL-encoded and decodes to the uploaded text.
 * - A 33-character identifier loads on all three builds; it is stored as its
 *   first 32 characters (the symbol search lists 32), both names read it, and
 *   the module text keeps 33. Two names sharing their first 32 characters load
 *   as `<32>#1` and `<32>#2`, and neither declared name nor the plain
 *   32-character prefix resolves (404 on RW7/RW8, 400 -1073414146 on RW6).
 *   The search lists both hits with the plain 32-character name; the suffix
 *   is only in the symburl and the self link (2026-09-30).
 * - A string value carrying '%XX' and written with one form encoding reads
 *   back decoded once more on RW 7.21.4 and 8.2.1 ('%25' as '%', '%41' as
 *   'A'), and unchanged on RW 6.16.03 (2026-09-30). The client now escapes
 *   '%' on RWS 2.0 symbol writes, and the test asserts an exact round trip on
 *   every build. Strings declared in RAPID with '%XX' read back as declared
 *   on all three builds (2026-10-01), so the extra decode is on the write;
 *   08 checks the written text from the RAPID side (StrLen and compare).
 * - Array size ceilings, in declared elements: RW 7.21.4 reads num arrays up
 *   to 10000 (fails from 10200: HTTP 200, no value, an error link to
 *   -1073445865) and string arrays up to 1150 (fails from 1170); RW 8.2.1
 *   reads num arrays up to 2350 and string arrays up to 300 and fails
 *   silently from 2400 and 400 (HTTP 200, empty value, no error link). Writes
 *   of 7800 num elements answer 204 and writes of 7900 answer 500
 *   -1073445865 on both. On RW 8.2.1 a 7800-element array takes the write but
 *   can never be read back. RWS 1.0 is not measured.
 *   The ceilings are keyed by RobotWare build, not by lane (2026-10-03):
 *   RW 8.1.1+614 held the RW 8.2.1 bracket at every size above. RW 7.21.0+229
 *   has the same write bracket (7800 answers 204, 7900 answers 500
 *   -1073445865) but a much lower read ceiling, not measured: even the
 *   7800-element num array it accepted does not read back, the 1150-element
 *   string array does not read either, and a read over
 *   its ceiling answers HTTP 400 -1073445865 directly, where RW 7.21.4 answers
 *   HTTP 200 with an error link. The client types both INVALID_ARGUMENT. On
 *   7.21.0 the read sizes are recorded, not asserted.
 *
 * Tests titled "records ..." assert only what must hold and write the
 * observed value to the lane's trace: the evidence does not settle them.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import { RwsError, type RapidSymbolInfo, type RobotManager } from '../../src/index.js';
import {
  forEachController, expectRwsError, diffSnapshots, traceFile,
  type Lane, type TraceLine,
} from './helpers/index.js';

// ─── The data module ─────────────────────────────────────────────────────────

const MOD = 'ZZ_PROBE_RD';
const P = 'zz_probe_rd_';

type Kind = 'var' | 'per' | 'con';
type Compare = 'num' | 'str' | 'bool';

interface Sym {
  name: string;
  kind: Kind;
  dattyp: string;
  /** Array dimensions, empty for a scalar. */
  dims: number[];
  /** The declared value, in RAPID syntax. */
  init: string;
  /** A value to write (VAR and PERS only), in RAPID syntax. */
  write?: string;
  compare: Compare;
}

const NO_EAX = '[9E9,9E9,9E9,9E9,9E9,9E9]';
const SYMS: Record<string, Sym> = {
  vnum:  { name: `${P}vnum`,  kind: 'var', dattyp: 'num',    dims: [],     init: '1',     write: '3.5',    compare: 'num' },
  pnum:  { name: `${P}pnum`,  kind: 'per', dattyp: 'num',    dims: [],     init: '2',     write: '-17.25', compare: 'num' },
  cnum:  { name: `${P}cnum`,  kind: 'con', dattyp: 'num',    dims: [],     init: '42',                     compare: 'num' },
  vstr:  { name: `${P}vstr`,  kind: 'var', dattyp: 'string', dims: [],     init: '"var"',   write: '"written var"', compare: 'str' },
  pstr:  { name: `${P}pstr`,  kind: 'per', dattyp: 'string', dims: [],     init: '"pers"',  write: '"x<y>&z w"',    compare: 'str' },
  cstr:  { name: `${P}cstr`,  kind: 'con', dattyp: 'string', dims: [],     init: '"const"',                        compare: 'str' },
  vbool: { name: `${P}vbool`, kind: 'var', dattyp: 'bool',   dims: [],     init: 'FALSE', write: 'TRUE',   compare: 'bool' },
  pbool: { name: `${P}pbool`, kind: 'per', dattyp: 'bool',   dims: [],     init: 'TRUE',  write: 'FALSE',  compare: 'bool' },
  cbool: { name: `${P}cbool`, kind: 'con', dattyp: 'bool',   dims: [],     init: 'TRUE',                   compare: 'bool' },
  varr:  { name: `${P}varr`,  kind: 'var', dattyp: 'num',    dims: [5],    init: '[1,2,3,4,5]',  write: '[9,8,7,6,5]',     compare: 'num' },
  parr:  { name: `${P}parr`,  kind: 'per', dattyp: 'num',    dims: [3],    init: '[10,20,30]',   write: '[-1,0.5,1000]',   compare: 'num' },
  carr:  { name: `${P}carr`,  kind: 'con', dattyp: 'num',    dims: [3],    init: '[7,8,9]',                                compare: 'num' },
  mat:   { name: `${P}mat`,   kind: 'var', dattyp: 'num',    dims: [2, 3], init: '[[1,2,3],[4,5,6]]', write: '[[6,5,4],[3,2,1]]', compare: 'num' },
  vrt:   { name: `${P}vrt`,   kind: 'var', dattyp: 'robtarget', dims: [],
    init: `[[500,0,600],[0,0,1,0],[0,0,0,0],${NO_EAX}]`, write: `[[510.5,-20,610],[0,0,1,0],[0,0,0,0],${NO_EAX}]`, compare: 'num' },
  prt:   { name: `${P}prt`,   kind: 'per', dattyp: 'robtarget', dims: [],
    init: `[[400,0,700],[0,0,1,0],[0,0,0,0],${NO_EAX}]`, write: `[[400,10.25,700],[0,0,1,0],[-1,0,1,0],${NO_EAX}]`, compare: 'num' },
};
/** A CONST string with the five characters XML escapes, and a doubled quote. */
const SPEC = { name: `${P}spec`, decl: `CONST string ${P}spec := "a<b>c&d""e'f";`, core: 'a<b>c&d' };

const KEYWORD: Record<Kind, string> = { var: 'VAR', per: 'PERS', con: 'CONST' };

function declLine(s: Sym): string {
  const dims = s.dims.length ? `{${s.dims.join(',')}}` : '';
  return `${KEYWORD[s.kind]} ${s.dattyp} ${s.name}${dims} := ${s.init};`;
}

function dataModuleText(): string {
  return [
    `MODULE ${MOD}(NOSTEPIN)`,
    ...Object.values(SYMS).map(s => `  ${declLine(s)}`),
    `  ${SPEC.decl}`,
    'ENDMODULE',
    '',
  ].join('\n');
}

const DATA = { name: MOD, text: dataModuleText() };
const WRITABLE = Object.values(SYMS).filter(s => s.kind !== 'con');
const CONSTS = Object.values(SYMS).filter(s => s.kind === 'con');

// ─── Strings RAPID declared with percent escapes ─────────────────────────────

const PCT_MOD = 'ZZ_PROBE_RDPCT';
/** RAPID text with a lone '%', '%25', '%41' and a trailing '%' (no '\' or '"'). */
const PCT_TEXT = '100% a%25b%41c&d=e+f<g>h%';
const PCT_SYMS = { con: 'zz_probe_rdpct_c', var: 'zz_probe_rdpct_v', per: 'zz_probe_rdpct_p' };

function pctModuleText(): string {
  return [
    `MODULE ${PCT_MOD}(NOSTEPIN)`,
    `  CONST string ${PCT_SYMS.con} := "${PCT_TEXT}";`,
    `  VAR string ${PCT_SYMS.var} := "${PCT_TEXT}";`,
    `  PERS string ${PCT_SYMS.per} := "${PCT_TEXT}";`,
    'ENDMODULE',
    '',
  ].join('\n');
}

// ─── Identifiers longer than 32 characters ───────────────────────────────────

const LONG_MOD = 'ZZ_PROBE_RDLONG';
const DUP_MOD = 'ZZ_PROBE_RDDUP';
/** 33 characters; its first 32 are the name the controller stores. */
const NAME33 = 'zz_probe_rdlong_abcdefghijklmnopq';
const NAME32 = NAME33.slice(0, 32);
/** 34 characters sharing the first 32 (and 33) with NAME33. */
const NAME34 = `${NAME33}r`;

// ─── Size ceilings ───────────────────────────────────────────────────────────

const BIG_MOD = 'ZZ_PROBE_RDBIG';
const BP = 'zz_probe_rdbig_';
const BIG = {
  numOk: `${BP}num_ok`, numOver: `${BP}num_over`,
  strOk: `${BP}str_ok`, strOver: `${BP}str_over`,
  writeOk: `${BP}w_ok`, writeOver: `${BP}w_over`,
};

interface ReadCeiling {
  /** Largest num array read in full, and the smallest size that fails. */
  numReadOk: number; numReadOver: number;
  /** The same for arrays of empty strings. */
  strReadOk: number; strReadOver: number;
}

interface WriteCeiling {
  /** Largest num array written (204), and the smallest refused (500). */
  writeOk: number; writeOver: number;
}

type Ceiling = ReadCeiling & WriteCeiling;

/** What one RobotWare build is known to do at the array size ceilings. */
interface BuildCeiling {
  /** The read bracket; null where it is not measured (the probe sizes are then read and recorded). */
  read: ReadCeiling | null;
  /**
   * How a read over the read ceiling answers: an RwsError INVALID_ARGUMENT
   * carrying -1073445865 at this HTTP status (200: an error link in the body;
   * 400: the status itself), or 'empty' (HTTP 200, no value, no error link).
   */
  overRead: 200 | 400 | 'empty';
  write: WriteCeiling;
  /** Whether the array written at `write.writeOk` reads back (it is under the read ceiling). */
  writeReadsBack: boolean;
}

const RW7214_READ: ReadCeiling = { numReadOk: 10000, numReadOver: 10200, strReadOk: 1150, strReadOver: 1170 };
const RW8_READ: ReadCeiling = { numReadOk: 2350, numReadOver: 2400, strReadOk: 300, strReadOver: 400 };
const RWS2_WRITE: WriteCeiling = { writeOk: 7800, writeOver: 7900 };

/**
 * Measured per RobotWare build (the version without its `+build` suffix). A
 * build not listed here, and RWS 1.0, is recorded at the probe sizes.
 */
const MEASURED: Readonly<Record<string, BuildCeiling>> = {
  // Live-measured 2026-09-29 (RW 7.21.4+417).
  '7.21.4': { read: RW7214_READ, overRead: 200, write: RWS2_WRITE, writeReadsBack: true },
  // Live 2026-10-03 (RW 7.21.0+229): the write bracket of 7.21.4; reads of
  // 10000 and of 7800 num elements and of 1150 string elements answer 400
  // -1073445865, so both read ceilings are lower and not measured.
  '7.21.0': { read: null, overRead: 400, write: RWS2_WRITE, writeReadsBack: false },
  // Live-measured 2026-09-29 (RW 8.2.1+1023).
  '8.2.1': { read: RW8_READ, overRead: 'empty', write: RWS2_WRITE, writeReadsBack: false },
  // The RW 8.2.1 bracket held at every size on RW 8.1.1+614 (2026-10-03).
  '8.1.1': { read: RW8_READ, overRead: 'empty', write: RWS2_WRITE, writeReadsBack: false },
};
/** Sizes probed where a build has no measurement (the larger RW 7.21.4 set). */
const PROBE_SIZES: Ceiling = { ...RW7214_READ, ...RWS2_WRITE };
/** The controller's code for an oversize symbol read or write (SYS_CTRL_E_BUFFER_OVERFLOW). */
const BUFFER_OVERFLOW = -1073445865;

/** The RobotWare build of a version string, without its `+build` suffix ('7.21.4+417' -> '7.21.4'). */
function buildOf(rwVersion: string): string {
  return rwVersion.split('+')[0].trim();
}

function bigModuleText(c: Ceiling): string {
  return [
    `MODULE ${BIG_MOD}(NOSTEPIN)`,
    `  VAR num ${BIG.numOk}{${c.numReadOk}};`,
    `  VAR num ${BIG.numOver}{${c.numReadOver}};`,
    `  VAR string ${BIG.strOk}{${c.strReadOk}};`,
    `  VAR string ${BIG.strOver}{${c.strReadOver}};`,
    `  VAR num ${BIG.writeOk}{${c.writeOk}};`,
    `  VAR num ${BIG.writeOver}{${c.writeOver}};`,
    'ENDMODULE',
    '',
  ].join('\n');
}

/** `[1,2,...]` with `n` elements that are not all equal (a truncation shows). */
function numArrayValue(n: number): string {
  return `[${Array.from({ length: n }, (_, i) => (i % 97) + 1).join(',')}]`;
}

// ─── Value helpers ───────────────────────────────────────────────────────────

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Every number in a RAPID value, in order. */
function numbersOf(v: string): number[] {
  return (v.match(NUMBER) ?? []).map(Number);
}

/** The bracket structure of a RAPID aggregate, e.g. `[[,,],[,,]]`. */
function shapeOf(v: string): string {
  return v.replace(/"(?:[^"]|"")*"/g, '').replace(/[^[\],]/g, '');
}

/** A string value without its surrounding quotes, when it has them. */
function unquote(v: string): string {
  return /^"[\s\S]*"$/.test(v) ? v.slice(1, -1) : v;
}

/** Elements of a flat array value (0 for an empty value). */
function elementCount(v: string): number {
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner.trim() === '' ? 0 : inner.split(',').length;
}

/** Throws unless `actual` is `expected` as the compare kind reads it. */
function expectValue(actual: string, expected: string, compare: Compare, label: string): void {
  if (compare === 'str') {
    expect(unquote(actual), `${label}: ${actual}`).toBe(unquote(expected));
  } else if (compare === 'bool') {
    expect(actual.trim().toUpperCase(), label).toBe(expected.toUpperCase());
  } else {
    expect(shapeOf(actual), `${label}: shape of ${actual}`).toBe(shapeOf(expected));
    const a = numbersOf(actual);
    const e = numbersOf(expected);
    expect(a.length, `${label}: element count of ${actual}`).toBe(e.length);
    a.forEach((x, i) => {
      expect(Math.abs(x - e[i]) <= 1e-3 * Math.max(1, Math.abs(e[i])), `${label}[${i}]: ${x}, expected ${e[i]} (${actual})`).toBe(true);
    });
  }
}

/** Whitespace-collapsed text, for comparing module lines. */
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function errInfo(e: unknown): Record<string, unknown> {
  if (e instanceof RwsError) {
    return { code: e.code, httpStatus: e.httpStatus, controllerCode: e.controllerCode, controllerMsg: e.controllerMsg, message: e.message };
  }
  return { nonRwsError: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e) };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; }
}

// ─── Trace helpers (the wire requests the client sent) ───────────────────────

function traceLines(lane: Lane): TraceLine[] {
  let raw = '';
  try { raw = fs.readFileSync(traceFile(lane), 'utf8'); } catch { return []; }
  const out: TraceLine[] = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) { continue; }
    try { out.push(JSON.parse(l) as TraceLine); } catch { /* a line being written */ }
  }
  return out;
}

function requestsSince(lane: Lane, mark: number): Array<{ method: string; path: string }> {
  return traceLines(lane).slice(mark)
    .filter(l => l.cat === 'http.req')
    .map(l => {
      const d = (l.data ?? {}) as { method?: string; path?: string };
      return { method: d.method ?? '', path: d.path ?? l.msg };
    });
}

const isAccessRequest = (r: { method: string; path: string }): boolean =>
  r.method === 'POST' && /(mastership|writeaccess)/i.test(r.path) && /request/i.test(r.path);
const isAccessRelease = (r: { method: string; path: string }): boolean =>
  r.method === 'POST' && /(mastership|writeaccess)/i.test(r.path) && /release/i.test(r.path);

// ─── Tests ───────────────────────────────────────────────────────────────────

await forEachController('07-rapid-data', ctx => {
  const listed = async (m: RobotManager, name: string): Promise<boolean> =>
    (await m.listModulesDetailed(ctx.task)).some(x => x.name.toUpperCase() === name.toUpperCase());

  /** The data module, loaded when it is not. */
  const ensureData = async (): Promise<RobotManager> => {
    const m = await ctx.ensureManager();
    if (!(await listed(m, MOD))) { await ctx.loadModule(DATA); }
    return m;
  };

  /** The data module's text lines as the controller holds them. */
  const moduleLines = async (m: RobotManager): Promise<string[]> =>
    (await m.getModuleText(ctx.task, MOD)).text.split(/\r?\n/);

  /** 1-based row of the first line containing `needle` (whitespace-collapsed). */
  const rowOf = (lines: string[], needle: string): number => {
    const i = lines.findIndex(l => squash(l).includes(squash(needle)));
    if (i < 0) { throw new Error(`no line of ${MOD} contains ${JSON.stringify(needle)}`); }
    return i + 1;
  };

  const build = buildOf(ctx.rwVersion);
  /** What this build is known to do at the ceilings; undefined where nothing is measured (RWS 1.0, other builds). */
  const known: BuildCeiling | undefined = ctx.generation === 'rws2' ? MEASURED[build] : undefined;
  const ceiling: Ceiling = { ...(known?.read ?? PROBE_SIZES), ...(known?.write ?? PROBE_SIZES) };
  const ensureBig = async (): Promise<RobotManager> => {
    const m = await ctx.ensureManager();
    if (!(await listed(m, BIG_MOD))) { await ctx.loadModule({ name: BIG_MOD, text: bigModuleText(ceiling) }); }
    return m;
  };

  // ─── Load and list ────────────────────────────────────────────────────────

  it('loads a ZZ_PROBE data module through the client; the task lists it as a program module', async () => {
    const m = await ctx.ensureManager();
    expect(await listed(m, MOD)).toBe(false);
    const loaded = await ctx.loadModule(DATA);
    const detailed = await m.listModulesDetailed(ctx.task);
    const entry = detailed.find(x => x.name.toUpperCase() === MOD);
    expect(entry).toBeDefined();
    // Live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1: a loaded
    // probe module lists as ProgMod.
    expect(entry!.type).toBe('ProgMod');
    // loadProgram refreshes the manager's module list.
    expect(m.state.modulesByTask[ctx.task]).toContain(MOD);
    const direct = await (await ctx.observer()).listModules(ctx.task);
    expect(direct.map(n => n.toUpperCase())).toContain(MOD);
    const snap = await ctx.snapshot();
    expect(snap.probeEntries.map(e => e.path)).toContain(loaded.remotePath);
  });

  it('reports the NOSTEPIN attribute in the module info', async () => {
    const m = await ensureData();
    const info = await m.getModuleInfo(ctx.task, MOD);
    ctx.note('records: module info', info);
    // Live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1: the module
    // GET carries the attribute `nostepin`.
    expect(Object.values(info).join(' ').toLowerCase()).toContain('nostepin');
  });

  // ─── Reads ────────────────────────────────────────────────────────────────

  it('reads the declared value of every VAR, PERS and CONST symbol', async () => {
    const m = await ctx.ensureManager();
    await ctx.loadModule(DATA); // fresh: earlier writes do not show
    const seen: Record<string, string> = {};
    for (const s of Object.values(SYMS)) {
      const v = await m.getRapidVariable(ctx.task, MOD, s.name);
      seen[s.name] = v;
      expectValue(v, s.init, s.compare, s.name);
    }
    ctx.note('records: declared values as read', seen);
    // How a string value is delivered (with or without its quotes).
    ctx.note('records: string value form', { vstr: seen[SYMS.vstr.name], quoted: /^".*"$/.test(seen[SYMS.vstr.name]) });
  });

  it('reads a string with markup characters without XML entities', async () => {
    const m = await ensureData();
    const v = await m.getRapidVariable(ctx.task, MOD, SPEC.name);
    ctx.note('records: string with markup characters as read', { value: v });
    expect(v).toContain(SPEC.core);
    expect(v).not.toMatch(/&(?:quot|lt|gt|amp|apos);/);
    expect(v).toContain("e'f");
  });

  it('reads the same values through a direct adapter read', async () => {
    const m = await ensureData();
    const o = await ctx.observer();
    for (const s of [SYMS.cnum, SYMS.cstr, SYMS.carr, SYMS.vrt]) {
      expect(await o.getRapidVariable(ctx.task, MOD, s.name)).toBe(await m.getRapidVariable(ctx.task, MOD, s.name));
    }
  });

  // ─── Writes ───────────────────────────────────────────────────────────────

  it('writes num, string and bool VAR and PERS values and reads them back', async () => {
    const m = await ensureData();
    const o = await ctx.observer();
    for (const s of WRITABLE.filter(x => x.dims.length === 0 && x.dattyp !== 'robtarget')) {
      await m.setRapidVariable(ctx.task, MOD, s.name, s.write!);
      expectValue(await m.getRapidVariable(ctx.task, MOD, s.name), s.write!, s.compare, `${s.name} after write`);
      // Another read path sees the write (on RWS 2.0 another session).
      expectValue(await o.getRapidVariable(ctx.task, MOD, s.name), s.write!, s.compare, `${s.name} direct read`);
    }
  });

  it('writes whole arrays (1-D VAR, 1-D PERS, 2-D VAR) and reads them back', async () => {
    const m = await ensureData();
    for (const s of [SYMS.varr, SYMS.parr, SYMS.mat]) {
      await m.setRapidVariable(ctx.task, MOD, s.name, s.write!);
      expectValue(await m.getRapidVariable(ctx.task, MOD, s.name), s.write!, 'num', `${s.name} after write`);
    }
  });

  it('writes a robtarget record, VAR and PERS, and reads it back', async () => {
    const m = await ensureData();
    for (const s of [SYMS.vrt, SYMS.prt]) {
      await m.setRapidVariable(ctx.task, MOD, s.name, s.write!);
      const back = await m.getRapidVariable(ctx.task, MOD, s.name);
      ctx.note(`records: ${s.name} as read after a write`, { value: back });
      expectValue(back, s.write!, 'num', `${s.name} after write`);
    }
  });

  it('writes a string with markup characters (form-encoded) and reads it back unchanged', async () => {
    const m = await ensureData();
    const value = '"a&b=c<d> e+f;g"';
    await m.setRapidVariable(ctx.task, MOD, SYMS.vstr.name, value);
    expect(unquote(await m.getRapidVariable(ctx.task, MOD, SYMS.vstr.name))).toBe(unquote(value));
  });

  it('writes a string holding percent signs and escapes, VAR and PERS, and reads it back exactly', async () => {
    const m = await ensureData();
    const o = await ctx.observer();
    // A lone '%', '%25', '%41', a trailing '%', and the form's own characters.
    const value = '"100% a%25b%41c&d=e+f<g>h%"';
    // RW 7.21.4 and RW 8.2.1 decode '%XX' in a written string a second time
    // (2026-09-30: '"%41"' read back '"A"', '%25' read back '%'); the client
    // escapes '%' on RWS 2.0 symbol writes so the text round-trips. RW 6.16.03
    // keeps the value as written with a single form encoding.
    for (const s of [SYMS.vstr, SYMS.pstr]) {
      await m.setRapidVariable(ctx.task, MOD, s.name, value);
      expect(unquote(await m.getRapidVariable(ctx.task, MOD, s.name)), `${s.name} after write`).toBe(unquote(value));
      expect(unquote(await o.getRapidVariable(ctx.task, MOD, s.name)), `${s.name} direct read`).toBe(unquote(value));
    }
    // The module text keeps the PERS declared value after a write on all
    // three builds (2026-10-01), so it does not show the stored text; the
    // next test and the RAPID-side check in 08 settle where the decode is.
    await m.setRapidVariable(ctx.task, MOD, SYMS.pstr.name, SYMS.pstr.write!);
  });

  it('reads a string that RAPID declared with percent escapes exactly as declared (no decode on the read)', async () => {
    const m = await ctx.ensureManager();
    try {
      await ctx.loadModule({ name: PCT_MOD, text: pctModuleText() });
      for (const name of Object.values(PCT_SYMS)) {
        expect(unquote(await m.getRapidVariable(ctx.task, PCT_MOD, name)), `${name} as read`).toBe(PCT_TEXT);
      }
    } finally {
      await ctx.unloadModule(PCT_MOD);
    }
  });

  it('takes RAPID access around a symbol write and releases it after; reads take none', async () => {
    const m = await ensureData();
    let mark = traceLines(ctx.lane).length;
    await m.getRapidVariable(ctx.task, MOD, SYMS.vnum.name);
    await m.getRapidSymbolProperties(ctx.task, MOD, SYMS.vnum.name);
    await m.searchRapidSymbols({ task: ctx.task, blockurl: `RAPID/${ctx.task}/${MOD}` });
    const reads = requestsSince(ctx.lane, mark);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter(r => isAccessRequest(r) || isAccessRelease(r))).toEqual([]);

    mark = traceLines(ctx.lane).length;
    await m.setRapidVariable(ctx.task, MOD, SYMS.vnum.name, '7');
    const sent = requestsSince(ctx.lane, mark);
    ctx.note('records: requests around a symbol write', sent);
    const write = sent.findIndex(r => r.method === 'POST' && /\/rw\/rapid\/symbol\b/i.test(r.path) && r.path.includes(SYMS.vnum.name));
    const request = sent.findIndex(isAccessRequest);
    const release = sent.findIndex((r, i) => i > write && isAccessRelease(r));
    // RAPID mastership on RW6, edit mastership on RW7, control-station write
    // access on RW8, taken the normal way and released after the write.
    expect(write).toBeGreaterThanOrEqual(0);
    expect(request).toBeGreaterThanOrEqual(0);
    expect(request).toBeLessThan(write);
    expect(release).toBeGreaterThan(write);
    if (ctx.rwMajor === 8) { expect(sent[request].path).toMatch(/writeaccess/i); }
    else { expect(sent[request].path).toMatch(/mastership/i); }
    expect(Number(await m.getRapidVariable(ctx.task, MOD, SYMS.vnum.name))).toBe(7);
  });

  it('refuses a write to each CONST with an RwsError; the value stays', async () => {
    const m = await ensureData();
    for (const s of CONSTS) {
      const got = await attempt(() => m.setRapidVariable(ctx.task, MOD, s.name, s.dims.length ? '[1,1,1]' : s.compare === 'str' ? '"changed"' : s.compare === 'bool' ? 'FALSE' : '0'));
      const after = await m.getRapidVariable(ctx.task, MOD, s.name);
      ctx.note(`records: CONST write ${s.name}`, { refused: !got.ok, ...(got.ok ? {} : errInfo(got.error)), valueAfter: after });
      expect(got.ok, `a write to CONST ${s.name} was accepted`).toBe(false);
      const err = await expectRwsError(() => Promise.reject((got as { error: unknown }).error));
      expect(['NOT_CONNECTED', 'NETWORK_ERROR', 'CONTROLLER_BUSY', 'SESSION_EXPIRED']).not.toContain(err.code);
      expect(err.httpStatus ?? 0).toBeGreaterThanOrEqual(400);
      // A useful message: the request (which names the symbol), or a refusal in words.
      expect(err.message.includes(s.name) || err.refusal !== undefined, err.message).toBe(true);
      expectValue(after, s.init, s.compare, `${s.name} after the refused write`);
    }
  });

  it('records the typed error for a value of the wrong type; the value stays', async () => {
    const m = await ensureData();
    const before = await m.getRapidVariable(ctx.task, MOD, SYMS.varr.name);
    const got = await attempt(() => m.setRapidVariable(ctx.task, MOD, SYMS.varr.name, '"not a num array"'));
    const after = await m.getRapidVariable(ctx.task, MOD, SYMS.varr.name);
    ctx.note('records: wrong-typed write', { refused: !got.ok, ...(got.ok ? {} : errInfo(got.error)), before, after });
    expect(got.ok).toBe(false);
    expect((got as { error: unknown }).error).toBeInstanceOf(RwsError);
    expect(after).toBe(before);
  });

  it('reads a missing symbol as RESOURCE_NOT_FOUND', async () => {
    const m = await ensureData();
    const missing = `${P}nosuch`;
    const data = await expectRwsError(() => m.getRapidVariable(ctx.task, MOD, missing));
    expect(data.code).toBe('RESOURCE_NOT_FOUND');
    expect(data.message).toContain(missing);
    expect(data.controllerMsg ?? '').toMatch(/symbol not found/i);
    const props = await expectRwsError(() => m.getRapidSymbolProperties(ctx.task, MOD, missing));
    expect(props.code).toBe('RESOURCE_NOT_FOUND');
    // Live-verified 2026-09-29: RW 7.21.4 and 8.2.1 answer the data read 404
    // -1073442816 and the properties read 404 -1073414146; RW 6.16.03 answers
    // both 400 -1073414146.
    if (ctx.generation === 'rws2') {
      expect(data.httpStatus).toBe(404);
      expect(data.controllerCode).toBe(-1073442816);
      expect(props.httpStatus).toBe(404);
      expect(props.controllerCode).toBe(-1073414146);
    } else {
      expect(data.httpStatus).toBe(400);
      expect(data.controllerCode).toBe(-1073414146);
      expect(props.httpStatus).toBe(400);
      expect(props.controllerCode).toBe(-1073414146);
    }
  });

  // ─── Properties ───────────────────────────────────────────────────────────

  it('reads symbol properties: kind, data type and dimensions', async () => {
    const m = await ensureData();
    const all: Record<string, unknown> = {};
    for (const s of Object.values(SYMS)) {
      const p = await m.getRapidSymbolProperties(ctx.task, MOD, s.name);
      all[s.name] = p;
      expect(p.symtyp, `${s.name} symtyp`).toBe(s.kind);
      expect(p.dattyp, `${s.name} dattyp`).toBe(s.dattyp);
      expect(p.ndim, `${s.name} ndim`).toBe(s.dims.length);
      // The `dim` text of an array was never recorded (scalars read ""): when
      // it is given, it names the declared sizes.
      if (p.dim) { for (const d of s.dims) { expect(p.dim, `${s.name} dim`).toContain(String(d)); } }
      expect(p.local, `${s.name} local`).toBe(false);
      expect(p.symburl.toUpperCase()).toContain(`${MOD}/${s.name}`.toUpperCase());
    }
    ctx.note('records: symbol properties', all);
  });

  it('records the read-only flag and storage the client reports per kind', async () => {
    const m = await ensureData();
    const out: Record<string, unknown> = {};
    for (const s of [SYMS.vnum, SYMS.pnum, SYMS.cnum, SYMS.cstr]) {
      const p = await m.getRapidSymbolProperties(ctx.task, MOD, s.name);
      out[s.name] = { kind: s.kind, ro: p.ro, storage: p.storage, taskvar: p.taskvar, heap: p.heap, linked: p.linked, dim: p.dim };
      expect(typeof p.ro).toBe('boolean');
    }
    ctx.note('records: read-only flag and storage', out);
    // A VAR is never read-only.
    expect((out[SYMS.vnum.name] as { ro: boolean }).ro).toBe(false);
  });

  // ─── Symbol search ────────────────────────────────────────────────────────

  it('finds the module symbols by symbol search, with kind and data type (RWS 1.0: plural search-symbols)', async () => {
    const m = await ensureData();
    const mark = traceLines(ctx.lane).length;
    const hits = await m.searchRapidSymbols({ task: ctx.task, blockurl: `RAPID/${ctx.task}/${MOD}` });
    const sent = requestsSince(ctx.lane, mark);
    if (ctx.generation === 'rws1') {
      // The fix: the plural action, as the controller's own form names it.
      expect(sent.some(r => r.method === 'POST' && /action=search-symbols\b/.test(r.path))).toBe(true);
      expect(sent.some(r => /action=search-symbol(?:&|$)/.test(r.path))).toBe(false);
    }
    const byName = new Map<string, RapidSymbolInfo>();
    for (const h of hits) { byName.set(h.name.toLowerCase(), h); }
    ctx.note('records: module-scoped symbol search', { count: hits.length, hits });
    const expected = [...Object.values(SYMS), { name: SPEC.name, kind: 'con' as Kind, dattyp: 'string', dims: [] }];
    const missing: string[] = [];
    for (const s of expected) {
      const h = byName.get(s.name);
      if (!h) { missing.push(s.name); continue; }
      expect(h.symtyp, `${s.name} symtyp`).toBe(s.kind);
      expect(h.dattyp, `${s.name} dattyp`).toBe(s.dattyp);
      expect(h.ndim, `${s.name} ndim`).toBe(s.dims.length);
    }
    ctx.note('records: symbols the search did not return', { missing });
    // Every kind, CONST included, on every generation: RW 6.16.03 lists CONST
    // hits as rap-sympropconstant-li (live-verified 2026-09-30, all 16 symbols
    // of this module returned).
    expect(missing).toEqual([]);
  });

  it('filters a symbol search by kind: persistents only', async () => {
    const m = await ensureData();
    const hits = await m.searchRapidSymbols({ task: ctx.task, blockurl: `RAPID/${ctx.task}/${MOD}`, symtyp: 'per' });
    const ours = hits.filter(h => h.name.toLowerCase().startsWith(P));
    expect(ours.every(h => h.symtyp === 'per')).toBe(true);
    const names = ours.map(h => h.name.toLowerCase()).sort();
    expect(names).toEqual(Object.values(SYMS).filter(s => s.kind === 'per').map(s => s.name).sort());
  });

  // ─── Module text ──────────────────────────────────────────────────────────

  it('reads the whole module text: every VAR and CONST declaration as uploaded', async () => {
    const m = await ensureData();
    const { text, changeCount } = await m.getModuleText(ctx.task, MOD);
    const lines = text.split(/\r?\n/).map(squash);
    ctx.note('records: whole module text', {
      changeCount, identical: text.replace(/\r\n/g, '\n').trimEnd() === DATA.text.trimEnd(), length: text.length,
    });
    expect(Number.isFinite(changeCount)).toBe(true);
    expect(lines[0].toUpperCase()).toContain(`MODULE ${MOD}`);
    for (const s of Object.values(SYMS).filter(x => x.kind !== 'per')) {
      expect(lines, `${s.name} declaration`).toContain(squash(declLine(s)));
    }
    // The markup line comes back as the source text, not entity-escaped.
    expect(lines).toContain(squash(SPEC.decl));
    expect(lines.some(l => /^ENDMODULE\b/i.test(l))).toBe(true);
  });

  it('reads a one-line text range as the source line, entity-decoded', async () => {
    const m = await ensureData();
    const row = rowOf(await moduleLines(m), SPEC.decl);
    const range = await m.getModuleTextRange(ctx.task, MOD, row, 1, row, -1);
    ctx.note('records: one-line range', { row, range });
    // RWS 1.0 sends this range with XML entities inside its JSON value
    // (live-verified 2026-09-29 on RW 6.16.03); the client decodes them.
    expect(range).not.toMatch(/&(?:quot|lt|gt|amp|apos);/);
    expect(squash(range)).toBe(squash(SPEC.decl));
  });

  it('records a two-line text range', async () => {
    const m = await ensureData();
    const lines = await moduleLines(m);
    const row = rowOf(lines, declLine(SYMS.cnum));
    const range = await m.getModuleTextRange(ctx.task, MOD, row, 1, row + 1, -1);
    ctx.note('records: two-line range', { row, range, lineCount: range.split(/\r?\n/).filter(l => l.trim()).length });
    expect(squash(range)).toContain(squash(declLine(SYMS.cnum)));
    expect(squash(range)).toContain(squash(lines[row]));
  });

  it('records whether a PERS write shows in the module text', async () => {
    const m = await ensureData();
    await m.setRapidVariable(ctx.task, MOD, SYMS.pnum.name, '123.5');
    const lines = await moduleLines(m);
    const line = lines.find(l => l.includes(SYMS.pnum.name)) ?? '';
    ctx.note('records: PERS declaration after a write', { line, updated: /123\.5/.test(line) });
    expect(line).toMatch(/PERS\s+num/i);
    expect(Number(await m.getRapidVariable(ctx.task, MOD, SYMS.pnum.name))).toBe(123.5);
  });

  // ─── Identifiers longer than 32 characters ────────────────────────────────

  it('loads a 33-character identifier, stored as its first 32; both names read it and the text keeps 33', async () => {
    expect(NAME33.length).toBe(33);
    const m = await ctx.ensureManager();
    try {
      // Live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1: the load
      // succeeds (the controller logs a load error event beside it).
      await ctx.loadModule({ name: LONG_MOD, text: `MODULE ${LONG_MOD}(NOSTEPIN)\n  VAR num ${NAME33} := 33;\nENDMODULE\n` });
      expect(await listed(m, LONG_MOD)).toBe(true);
      expect(Number(await m.getRapidVariable(ctx.task, LONG_MOD, NAME33))).toBe(33);
      expect(Number(await m.getRapidVariable(ctx.task, LONG_MOD, NAME32))).toBe(33);
      const hits = await m.searchRapidSymbols({ task: ctx.task, blockurl: `RAPID/${ctx.task}/${LONG_MOD}` });
      const names = hits.map(h => h.name.toLowerCase());
      ctx.note('records: long identifier as searched', { names, props: await attempt(() => m.getRapidSymbolProperties(ctx.task, LONG_MOD, NAME33)) });
      expect(names).toContain(NAME32);
      expect(names).not.toContain(NAME33);
      expect((await m.getModuleText(ctx.task, LONG_MOD)).text).toContain(NAME33);
    } finally {
      await ctx.unloadModule(LONG_MOD);
    }
    expect(await listed(m, LONG_MOD)).toBe(false);
  });

  it('records what the client reports for two identifiers sharing their first 32 characters', async () => {
    const m = await ctx.ensureManager();
    try {
      await ctx.loadModule({
        name: DUP_MOD,
        text: `MODULE ${DUP_MOD}(NOSTEPIN)\n  VAR num ${NAME33} := 33;\n  VAR num ${NAME34} := 34;\nENDMODULE\n`,
      });
      const hits = await m.searchRapidSymbols({ task: ctx.task, blockurl: `RAPID/${ctx.task}/${DUP_MOD}` });
      const names = hits.map(h => h.name.toLowerCase());
      /** The addressable identifier: the last segment of the hit's symburl. */
      const ids = hits.map(h => (h.symburl.split('/').pop() ?? '').toLowerCase());
      const reads: Record<string, unknown> = {};
      for (const n of [NAME33, NAME34, NAME32, `${NAME32}#1`, `${NAME32}#2`]) {
        const r = await attempt(() => m.getRapidVariable(ctx.task, DUP_MOD, n));
        reads[n] = r.ok ? { value: r.value } : errInfo(r.error);
      }
      ctx.note('records: two names sharing 32 characters', { names, symburls: hits.map(h => h.symburl), reads });
      // Live-verified 2026-09-29 on all three builds: kept as <32>#1 and <32>#2,
      // and readable there.
      expect(reads[`${NAME32}#1`]).toEqual({ value: expect.stringMatching(/^\s*33\s*$/) });
      expect(reads[`${NAME32}#2`]).toEqual({ value: expect.stringMatching(/^\s*34\s*$/) });
      // Live-verified 2026-09-30 on RW 6.16.03, 7.21.4 and 8.2.1: the search
      // hit's name is the plain 32-character prefix for both symbols; the
      // '#1'/'#2' suffix is only in the symburl and the self link.
      expect(names.filter(n => n === NAME32)).toHaveLength(2);
      if (ctx.lane !== 'rw7') {
        // Live-verified 2026-09-30 on RW 6.16.03 and 2026-09-29 on RW 8.2.1: the
        // symburl carries the suffix. On RW 7.21.4 only the self link was
        // captured, so its symburl is recorded above, not asserted.
        expect(ids).toEqual(expect.arrayContaining([`${NAME32}#1`, `${NAME32}#2`]));
      }
      // Neither declared name nor the plain prefix resolves: 404 on RW 7.21.4
      // and 8.2.1, 400 -1073414146 on RW 6.16.03.
      for (const n of [NAME33, NAME34, NAME32]) {
        const e = reads[n] as { code?: string; httpStatus?: number };
        expect(e.code, n).toBe('RESOURCE_NOT_FOUND');
        expect(e.httpStatus, n).toBe(ctx.generation === 'rws2' ? 404 : 400);
      }
    } finally {
      await ctx.unloadModule(DUP_MOD);
    }
    expect(await listed(m, DUP_MOD)).toBe(false);
  });

  // ─── Size ceilings ────────────────────────────────────────────────────────

  /** Why a size is recorded rather than asserted on this lane. */
  const unmeasured = ctx.generation === 'rws1' ? 'RWS 1.0 not measured' : `not measured on RW ${build}`;
  const readMeasured = known?.read != null;

  /** Asserts `e` is the controller's oversize refusal of a read, at the build's HTTP status. */
  const expectOverRead = (e: unknown, status: 200 | 400, label: string): void => {
    expect(e, label).toBeInstanceOf(RwsError);
    const err = e as RwsError;
    expect(err.code, label).toBe('INVALID_ARGUMENT');
    expect(err.httpStatus, label).toBe(status);
    expect(err.controllerCode, label).toBe(BUFFER_OVERFLOW);
  };

  it(readMeasured
    ? `reads a ${ceiling.numReadOk}-element num array and a ${ceiling.strReadOk}-element string array in full`
    : `records reading a ${ceiling.numReadOk}-element num array and a ${ceiling.strReadOk}-element string array (read ceiling ${unmeasured})`,
  async () => {
    const m = await ensureBig();
    const results: Record<string, unknown> = {};
    try {
      for (const [name, size] of [[BIG.numOk, ceiling.numReadOk], [BIG.strOk, ceiling.strReadOk]] as const) {
        const r = await attempt(() => m.getRapidVariable(ctx.task, BIG_MOD, name));
        results[name] = r.ok ? { elements: elementCount(r.value), bytes: r.value.length } : errInfo(r.error);
        if (readMeasured) {
          expect(r.ok, `${name}: ${JSON.stringify(results[name])}`).toBe(true);
          expect(elementCount((r as { value: string }).value)).toBe(size);
        } else if (r.ok && r.value !== '') {
          // Whatever the controller does, a value is never a truncated array.
          expect(elementCount(r.value)).toBe(size);
        } else if (!r.ok) {
          expect(r.error).toBeInstanceOf(RwsError);
        }
      }
    } finally {
      ctx.note('records: arrays at the read ceiling', { build, results });
    }
  });

  if (known && known.overRead !== 'empty') {
    const status = known.overRead;
    it(`surfaces an over-ceiling array read as an RwsError, not an empty value (RW ${build}: HTTP ${status}${status === 200 ? ' with an error link to' : ''} -1073445865)`, async () => {
      const m = await ensureBig();
      for (const name of [BIG.numOver, BIG.strOver]) {
        const r = await attempt(() => m.getRapidVariable(ctx.task, BIG_MOD, name));
        ctx.note(`records: over-ceiling read of ${name}`, r.ok ? { value: r.value.slice(0, 80), length: r.value.length } : errInfo(r.error));
        expect(r.ok, `${name} read resolved with ${r.ok ? JSON.stringify(r.value.slice(0, 40)) : ''} instead of failing`).toBe(false);
        expectOverRead((r as { error: unknown }).error, status, name);
      }
    });
  } else if (known) {
    it(`reads an over-ceiling array as no value, never a partial array (RW ${build} as it is: HTTP 200, empty, no error link)`, async () => {
      const m = await ensureBig();
      for (const name of [BIG.numOver, BIG.strOver]) {
        const r = await attempt(() => m.getRapidVariable(ctx.task, BIG_MOD, name));
        ctx.note(`records: over-ceiling read of ${name}`, r.ok ? { value: r.value.slice(0, 80), length: r.value.length } : errInfo(r.error));
        if (r.ok) { expect(r.value).toBe(''); } else { expect(r.error).toBeInstanceOf(RwsError); }
      }
    });
  } else {
    it(`records reading arrays of ${ceiling.numReadOver} num and ${ceiling.strReadOver} string elements (${unmeasured})`, async () => {
      const m = await ensureBig();
      for (const [name, size] of [[BIG.numOver, ceiling.numReadOver], [BIG.strOver, ceiling.strReadOver]] as const) {
        const r = await attempt(() => m.getRapidVariable(ctx.task, BIG_MOD, name));
        ctx.note(`records: read of ${name}`, r.ok ? { elements: elementCount(r.value), length: r.value.length } : errInfo(r.error));
        if (r.ok && r.value !== '') { expect(elementCount(r.value)).toBe(size); }
        if (!r.ok) { expect(r.error).toBeInstanceOf(RwsError); }
      }
    });
  }

  it(!known
    ? `records writing a ${ceiling.writeOk}-element num array (${unmeasured})`
    : known.writeReadsBack
      ? `writes a ${ceiling.writeOk}-element num array and reads it back`
      : `accepts a ${ceiling.writeOk}-element num array write that it cannot read back (RW ${build} as it is)`,
  async () => {
    const m = await ensureBig();
    const value = numArrayValue(ceiling.writeOk);
    const w = await attempt(() => m.setRapidVariable(ctx.task, BIG_MOD, BIG.writeOk, value));
    const back = w.ok ? await attempt(() => m.getRapidVariable(ctx.task, BIG_MOD, BIG.writeOk)) : null;
    ctx.note('records: write at the write ceiling', {
      build,
      write: w.ok ? 'accepted' : errInfo(w.error),
      readBack: back === null ? null : back.ok ? { elements: elementCount(back.value), length: back.value.length } : errInfo(back.error),
    });
    if (!known) {
      if (!w.ok) { expect(w.error).toBeInstanceOf(RwsError); }
      if (back?.ok && back.value !== '') { expectValue(back.value, value, 'num', BIG.writeOk); }
      return;
    }
    expect(w.ok, JSON.stringify(w.ok ? '' : errInfo(w.error))).toBe(true);
    if (known.writeReadsBack) {
      expect(back?.ok).toBe(true);
      expectValue((back as { value: string }).value, value, 'num', BIG.writeOk);
    } else if (known.overRead === 'empty') {
      // RW 8.2.1 and 8.1.1 as they are: the write answers 204, but an array
      // this size is over the read ceiling and never reads back.
      if (back!.ok) { expect(back!.value).toBe(''); } else { expect(back!.error).toBeInstanceOf(RwsError); }
    } else {
      // RW 7.21.0 (2026-10-03): the read-back answers 400 -1073445865.
      expect(back!.ok, 'the read-back of an array over the read ceiling resolved').toBe(false);
      expectOverRead((back as { error: unknown }).error, known.overRead, `${BIG.writeOk} read-back`);
    }
  });

  it(known
    ? `refuses a ${ceiling.writeOver}-element num array write with an RwsError (HTTP 500, -1073445865)`
    : `records writing a ${ceiling.writeOver}-element num array (${unmeasured})`,
  async () => {
    const m = await ensureBig();
    const w = await attempt(() => m.setRapidVariable(ctx.task, BIG_MOD, BIG.writeOver, numArrayValue(ceiling.writeOver)));
    ctx.note('records: write over the write ceiling', w.ok ? { write: 'accepted' } : errInfo(w.error));
    if (!known) {
      if (!w.ok) { expect(w.error).toBeInstanceOf(RwsError); }
      return;
    }
    expect(w.ok, 'the over-ceiling write was accepted').toBe(false);
    const err = await expectRwsError(() => Promise.reject((w as { error: unknown }).error));
    expect(err.httpStatus).toBe(500);
    expect(err.controllerCode).toBe(BUFFER_OVERFLOW);
    expect(err.message).toContain('HTTP 500');
    if (known.read && ceiling.writeOver <= known.read.numReadOk) {
      // Readable on RW 7.21.4 (under its read ceiling): the refused write left it untouched.
      const back = await m.getRapidVariable(ctx.task, BIG_MOD, BIG.writeOver);
      expect(elementCount(back)).toBe(ceiling.writeOver);
      expect(numbersOf(back).every(x => x === 0)).toBe(true);
    }
  });

  // ─── Unload and delete ────────────────────────────────────────────────────

  it('unloads the modules and deletes their files; a symbol read then answers not found', async () => {
    const m = await ensureData();
    await ctx.unloadModule(BIG_MOD);
    await ctx.unloadModule(MOD);
    expect(await listed(m, MOD)).toBe(false);
    expect(await listed(m, BIG_MOD)).toBe(false);
    expect(m.state.modulesByTask[ctx.task] ?? []).not.toContain(MOD);
    const home = (await m.listDirectory(ctx.home)).map(e => e.name.toUpperCase());
    expect(home).not.toContain(`${MOD}.MOD`);
    expect(home).not.toContain(`${BIG_MOD}.MOD`);
    const err = await expectRwsError(() => m.getRapidVariable(ctx.task, MOD, SYMS.cnum.name));
    ctx.note('records: symbol read after unload', errInfo(err));
    // Live-verified 2026-09-29: 404 -1073442816 "Symbol not found" on RW 7.21.4 and 8.2.1.
    if (ctx.generation === 'rws2') {
      expect(err.code).toBe('RESOURCE_NOT_FOUND');
      expect(err.httpStatus).toBe(404);
      expect(err.controllerCode).toBe(-1073442816);
    } else {
      expect(['RESOURCE_NOT_FOUND', 'MODULE_NOT_FOUND']).toContain(err.code);
    }
  });

  it('refuses unloading a module that is not loaded with MODULE_NOT_FOUND (400 -1073442816)', async () => {
    const m = await ctx.ensureManager();
    expect(await listed(m, MOD)).toBe(false);
    const err = await expectRwsError(() => m.unloadModule(ctx.task, MOD));
    expect(err.code).toBe('MODULE_NOT_FOUND');
    expect(err.httpStatus).toBe(400);
    expect(err.controllerCode).toBe(-1073442816);
    expect(err.controllerMsg ?? '').toMatch(/unknown module/i);
  });

  it('leaves the controller as the baseline found it', async () => {
    const snap = await ctx.snapshot();
    expect(snap.modulesByTask[ctx.task] ?? []).not.toContain(MOD);
    expect(snap.probeEntries).toEqual([]);
    expect(diffSnapshots(ctx.baseline, snap)).toEqual([]);
  });
});

