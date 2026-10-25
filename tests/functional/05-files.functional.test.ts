/**
 * Functional file service, per controller, through RobotManager: list HOME,
 * create a ZZ_PROBE directory, upload, download (byte-identical), copy,
 * rename, delete and list again; the typed errors for a missing file and a
 * bad volume; and the volume root of each generation (RWS 1.0 `$HOME`, RWS
 * 2.0 `HOME`) as the client handles it.
 *
 * Everything this file creates lives under HOME and is named ZZ_PROBE, so the
 * harness restore removes whatever a failed test leaves behind. The tests
 * clean up after themselves as well, and the last one checks that HOME lists
 * as it did before.
 *
 * Expectations per build come from the live verification of 2026-09-29 on
 * RW 6.16.03 (6.16.3007), RW 7.21.4 and RW 8.2.1:
 * - RWS 1.0 reads need the `$` of the volume: GET `/fileservice/HOME` answers
 *   404, while a PUT to `HOME/x` answers 201 and writes into `$HOME`, where
 *   only the `$HOME/x` path reads it back.
 * - RWS 2.0 accepts `HOME` and `$HOME` alike (and `%24TEMP`); the client maps
 *   `$HOME` to `HOME` itself.
 * - A missing file is 404 on all three builds (-1073414146 on RW6,
 *   -1073438713 "Path does not exist" on RW7/RW8). A bad volume is 404
 *   -1073414146 on RW6 and 400 -1073438716 "Virtual root does not exist" on
 *   RW7/RW8; the client reads both as RESOURCE_NOT_FOUND.
 * - A copy onto an existing name answers 409 on all three builds.
 * - On RW 8.2.1, create, upload, copy, rename and delete need no
 *   control-station write access.
 *
 * Tests titled "records ..." assert only what must hold and write the
 * observed value to the lane's trace: the evidence does not settle them.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import type { FileEntry, RobotManager } from '../../src/index.js';
import { forEachController, expectRwsError, traceFile, type Lane, type TraceLine } from './helpers/index.js';

/** The work directory under HOME (ZZ_PROBE: restore removes it whatever happens). */
const WORK = 'ZZ_PROBE_FILES';
/** A subdirectory of WORK, for the cross-directory and mkdir tests. */
const SUB = 'ZZ_PROBE_SUB';
const SOURCE = 'ZZ_PROBE_source.txt';

/**
 * The round-trip text: every printable ASCII character, tabs, trailing
 * spaces, an empty line, LF and CRLF line ends and no final newline, about
 * 20 KB in all, so a transport that rewrites line ends, trims or truncates
 * shows up as a difference.
 */
function probeText(): string {
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
  const lines = [
    '! ZZ_PROBE file-service round trip',
    printable,
    'tab\tseparated\tvalues',
    'trailing spaces   ',
    '',
  ];
  for (let i = 0; i < 200; i++) { lines.push(`${String(i).padStart(4, '0')} ${printable}`); }
  return `${lines.join('\n')}\r\nCRLF line one\r\nCRLF line two\r\nno final newline`;
}

const TEXT = probeText();
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** An entry by name (case-insensitive: a listing may change case) and, optionally, type. */
function entryOf(entries: FileEntry[], name: string, type?: 'file' | 'dir'): FileEntry | undefined {
  const want = name.toUpperCase();
  return entries.find(e => e.name.toUpperCase() === want && (!type || e.type === type));
}

/** Every line of a lane's trace so far (unparseable lines skipped). */
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

/** The requests (method and path) the client sent after `mark` lines of the lane's trace. */
function requestsSince(lane: Lane, mark: number): Array<{ method: string; path: string }> {
  return traceLines(lane).slice(mark)
    .filter(l => l.cat === 'http.req')
    .map(l => {
      const d = (l.data ?? {}) as { method?: string; path?: string };
      return { method: d.method ?? '', path: d.path ?? l.msg };
    });
}

/** Delete a directory tree through the manager: files and subdirectories first, then the directory. */
async function deleteTree(m: RobotManager, path: string, depth = 0): Promise<void> {
  if (depth > 5) { throw new Error(`deleteTree: ${path} is deeper than this file ever creates`); }
  for (const e of await m.listDirectory(path)) {
    const child = `${path}/${e.name}`;
    if (e.type === 'dir') { await deleteTree(m, child, depth + 1); } else { await m.deleteControllerFile(child); }
  }
  await m.deleteControllerFile(path);
}

await forEachController('05-files', ctx => {
  const workPath = (): string => `${ctx.home}/${WORK}`;
  /** The names in HOME when the first test ran (the last test compares against them). */
  let homeAtStart: string[] | null = null;

  /** The work directory, created when missing. */
  const workDir = async (): Promise<string> => {
    const m = await ctx.ensureManager();
    if (!entryOf(await m.listDirectory(ctx.home), WORK, 'dir')) { await m.createDirectory(ctx.home, WORK); }
    return workPath();
  };

  /** The source file in the work directory, uploaded when missing. */
  const sourceFile = async (): Promise<string> => {
    const m = await ctx.ensureManager();
    const dir = await workDir();
    if (!entryOf(await m.listDirectory(dir), SOURCE, 'file')) { await m.uploadFile(`${dir}/${SOURCE}`, TEXT); }
    return `${dir}/${SOURCE}`;
  };

  /** Delete a file when it is there (a missing file is not an error here). */
  const removeIfPresent = async (dir: string, name: string): Promise<void> => {
    const m = await ctx.ensureManager();
    const e = entryOf(await m.listDirectory(dir), name);
    if (e) { await m.deleteControllerFile(`${dir}/${e.name}`); }
  };

  // ─── Listing ──────────────────────────────────────────────────────────────

  it('lists HOME through the manager, in agreement with a direct read', async () => {
    const m = await ctx.ensureManager();
    const viaManager = await m.listDirectory(ctx.home);
    const direct = await (await ctx.observer()).listDirectory(ctx.home);
    // HOME may be empty: the RW 7.21.4 VC restarted on 2026-09-30 answered
    // GET /fileservice/HOME with an empty directory before anything was
    // written to it. An empty listing is recorded, not failed; the agreement
    // over a non-empty HOME is asserted once the work directory exists (next
    // test but one).
    if (viaManager.length === 0) { ctx.note('records: HOME lists empty at the start', { direct: direct.length }); }
    for (const e of viaManager) {
      expect(typeof e.name).toBe('string');
      expect(e.name.length).toBeGreaterThan(0);
      expect(['file', 'dir']).toContain(e.type);
    }
    const key = (es: FileEntry[]): string[] => es.map(e => `${e.type}:${e.name}`).sort();
    expect(key(viaManager)).toEqual(key(direct));
    // The harness cleaned ZZ_PROBE leftovers before the baseline.
    expect(viaManager.filter(e => e.name.toUpperCase().startsWith('ZZ_PROBE'))).toEqual([]);
    homeAtStart = viaManager.map(e => e.name).sort();
  });

  it('records the file volumes the controller lists', async () => {
    const m = await ctx.ensureManager();
    const volumes = await m.listFileVolumes();
    ctx.note('records: file volumes', { volumes });
    expect(Array.isArray(volumes)).toBe(true);
    expect(volumes.length).toBeGreaterThan(0);
    if (ctx.generation === 'rws2') {
      // RWS 2.0 lists the volumes as fs-dir entries of /fileservice.
      const upper = volumes.map(v => v.toUpperCase());
      expect(upper).toContain('HOME');
      expect(upper).toContain('TEMP');
    }
  });

  // ─── Create, upload, download ─────────────────────────────────────────────

  it('creates a ZZ_PROBE directory under HOME, listed as an empty directory', async () => {
    const m = await ctx.ensureManager();
    expect(entryOf(await m.listDirectory(ctx.home), WORK)).toBeUndefined();
    await m.createDirectory(ctx.home, WORK);
    const viaManager = await m.listDirectory(ctx.home);
    const e = entryOf(viaManager, WORK);
    expect(e).toBeDefined();
    expect(e!.type).toBe('dir');
    expect(await m.listDirectory(workPath())).toEqual([]);
    // HOME now holds at least the work directory, so the manager and a direct
    // read agree over a non-empty listing even when HOME started empty.
    const direct = await (await ctx.observer()).listDirectory(ctx.home);
    expect(entryOf(direct, WORK, 'dir')).toBeDefined();
    const key = (es: FileEntry[]): string[] => es.map(x => `${x.type}:${x.name}`).sort();
    expect(key(viaManager)).toEqual(key(direct));
  });

  it('uploads a file and downloads it byte-identical, listed with its size', async () => {
    const m = await ctx.ensureManager();
    const dir = await workDir();
    const path = `${dir}/${SOURCE}`;
    await m.uploadFile(path, TEXT);
    const back = await m.readFile(path);
    expect(bytes(back)).toBe(bytes(TEXT));
    expect(Buffer.from(back, 'utf8').equals(Buffer.from(TEXT, 'utf8'))).toBe(true);
    const e = entryOf(await m.listDirectory(dir), SOURCE, 'file');
    expect(e).toBeDefined();
    if (e!.size === undefined) { ctx.note('records: the listing gives no size for a file', { entry: e }); }
    expect(e!.size ?? bytes(TEXT)).toBe(bytes(TEXT));
  });

  it('records whether non-ASCII UTF-8 text round-trips', async () => {
    const m = await ctx.ensureManager();
    const dir = await workDir();
    const name = 'ZZ_PROBE_utf8.txt';
    const text = 'ZZ_PROBE ÄÖÜ ß é – 日本 ✓\n';
    try {
      await m.uploadFile(`${dir}/${name}`, text);
      const back = await m.readFile(`${dir}/${name}`);
      const e = entryOf(await m.listDirectory(dir), name, 'file');
      ctx.note('records: UTF-8 round trip', {
        identical: back === text, sentBytes: bytes(text), readBytes: bytes(back), listedSize: e?.size ?? null,
      });
      // What must hold: the upload is accepted, the file is there and not empty.
      expect(e).toBeDefined();
      expect(back.length).toBeGreaterThan(0);
    } finally {
      await removeIfPresent(dir, name);
    }
  });

  // ─── Copy and rename ──────────────────────────────────────────────────────

  it('copies a file within its directory; source and copy read identical', async () => {
    const m = await ctx.ensureManager();
    const src = await sourceFile();
    const dir = workPath();
    const copyName = 'ZZ_PROBE_copy.txt';
    await removeIfPresent(dir, copyName);
    await m.copyControllerFile(src, `${dir}/${copyName}`);
    const listing = await m.listDirectory(dir);
    expect(entryOf(listing, SOURCE, 'file')).toBeDefined();
    expect(entryOf(listing, copyName, 'file')).toBeDefined();
    expect(await m.readFile(`${dir}/${copyName}`)).toBe(TEXT);
    expect(await m.readFile(src)).toBe(TEXT);
    await m.deleteControllerFile(`${dir}/${copyName}`);
    expect(entryOf(await m.listDirectory(dir), copyName)).toBeUndefined();
  });

  it('refuses a copy into another directory with INVALID_ARGUMENT, before sending it', async () => {
    const m = await ctx.ensureManager();
    const src = await sourceFile();
    const dir = workPath();
    if (!entryOf(await m.listDirectory(dir), SUB, 'dir')) { await m.createDirectory(dir, SUB); }
    const mark = traceLines(ctx.lane).length;
    // The client keeps copy to the source's own directory on both generations
    // and says so rather than silently copying next to the source.
    const err = await expectRwsError(() => m.copyControllerFile(src, `${dir}/${SUB}/ZZ_PROBE_cross.txt`));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toMatch(/same-directory|source directory/i);
    expect(requestsSince(ctx.lane, mark).filter(r => r.method === 'POST' && r.path.includes('/fileservice/'))).toEqual([]);
    expect(await m.listDirectory(`${dir}/${SUB}`)).toEqual([]);
  });

  it('records the typed error for a copy onto an existing name (HTTP 409), and the target is unchanged', async () => {
    const m = await ctx.ensureManager();
    const src = await sourceFile();
    const dir = workPath();
    const target = 'ZZ_PROBE_existing.txt';
    const other = 'ZZ_PROBE other content\n';
    try {
      await m.uploadFile(`${dir}/${target}`, other);
      const err = await expectRwsError(() => m.copyControllerFile(src, `${dir}/${target}`));
      ctx.note('records: copy onto an existing name', {
        code: err.code, httpStatus: err.httpStatus, controllerCode: err.controllerCode, controllerMsg: err.controllerMsg,
      });
      // Live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1: 409, "copy
      // resource name as a dir or file is present in the destination parent dir".
      expect(err.httpStatus).toBe(409);
      expect(err.message).toContain('HTTP 409');
      expect(err.message).toMatch(/present in the destination/i);
      expect(await m.readFile(`${dir}/${target}`)).toBe(other);
    } finally {
      await removeIfPresent(dir, target);
    }
  });

  it('renames a file in place: the old name is gone and the new one reads the same bytes', async () => {
    const m = await ctx.ensureManager();
    const dir = await workDir();
    const from = 'ZZ_PROBE_ren_a.txt';
    const to = 'ZZ_PROBE_ren_b.txt';
    try {
      await m.uploadFile(`${dir}/${from}`, TEXT);
      await m.renameFile(`${dir}/${from}`, to);
      const listing = await m.listDirectory(dir);
      expect(entryOf(listing, from)).toBeUndefined();
      expect(entryOf(listing, to, 'file')).toBeDefined();
      expect(await m.readFile(`${dir}/${to}`)).toBe(TEXT);
    } finally {
      await removeIfPresent(dir, from);
      await removeIfPresent(dir, to);
    }
  });

  // ─── Directories ──────────────────────────────────────────────────────────

  it('creates missing parent directories (RobotManager.createDirectory is mkdir -p)', async () => {
    const m = await ctx.ensureManager();
    const dir = await workDir();
    const parent = `${dir}/ZZ_PROBE_p1/ZZ_PROBE_p2`;
    await m.createDirectory(parent, 'ZZ_PROBE_p3');
    expect(entryOf(await m.listDirectory(dir), 'ZZ_PROBE_p1', 'dir')).toBeDefined();
    expect(entryOf(await m.listDirectory(`${dir}/ZZ_PROBE_p1`), 'ZZ_PROBE_p2', 'dir')).toBeDefined();
    expect(entryOf(await m.listDirectory(parent), 'ZZ_PROBE_p3', 'dir')).toBeDefined();
    await deleteTree(m, `${dir}/ZZ_PROBE_p1`);
    expect(entryOf(await m.listDirectory(dir), 'ZZ_PROBE_p1')).toBeUndefined();
  });

  it('records creating a directory that already exists; its contents stay', async () => {
    const m = await ctx.ensureManager();
    await sourceFile();
    let outcome: Record<string, unknown> = { resolved: true };
    try {
      await m.createDirectory(ctx.home, WORK);
    } catch (e) {
      const err = await expectRwsError(() => Promise.reject(e));
      outcome = { resolved: false, code: err.code, httpStatus: err.httpStatus, controllerCode: err.controllerCode, controllerMsg: err.controllerMsg };
    }
    ctx.note('records: create an existing directory', outcome);
    expect(entryOf(await m.listDirectory(ctx.home), WORK, 'dir')).toBeDefined();
    expect(entryOf(await m.listDirectory(workPath()), SOURCE, 'file')).toBeDefined();
    expect(await m.readFile(`${workPath()}/${SOURCE}`)).toBe(TEXT);
  });

  // ─── Typed errors ─────────────────────────────────────────────────────────

  it('reads a missing file as RESOURCE_NOT_FOUND (HTTP 404)', async () => {
    const m = await ctx.ensureManager();
    const path = `${ctx.home}/ZZ_PROBE_no_such_file.txt`;
    const err = await expectRwsError(() => m.readFile(path));
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.httpStatus).toBe(404);
    expect(err.message).toContain('ZZ_PROBE_no_such_file.txt');
    // Live-verified 2026-09-29: -1073414146 on RW 6.16.03, -1073438713
    // "Path does not exist" on RW 7.21.4 and 8.2.1.
    expect(err.controllerCode).toBe(ctx.generation === 'rws1' ? -1073414146 : -1073438713);
  });

  it('lists a bad volume as RESOURCE_NOT_FOUND (404 on RWS 1.0, 400 on RWS 2.0)', async () => {
    const m = await ctx.ensureManager();
    // RWS 1.0 volumes carry a '$'; a name without one is refused for another reason.
    const volume = ctx.generation === 'rws1' ? '$ZZ_PROBE_NOVOLUME' : 'ZZ_PROBE_NOVOLUME';
    const err = await expectRwsError(() => m.listDirectory(volume));
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.message).toContain('ZZ_PROBE_NOVOLUME');
    if (ctx.generation === 'rws1') {
      expect(err.httpStatus).toBe(404);
      expect(err.controllerCode).toBe(-1073414146);
    } else {
      expect(err.httpStatus).toBe(400);
      expect(err.controllerCode).toBe(-1073438716);
      expect(err.controllerMsg ?? '').toMatch(/virtual root does not exist/i);
    }
  });

  it('records the typed error for deleting a file that does not exist', async () => {
    const m = await ctx.ensureManager();
    const err = await expectRwsError(() => m.deleteControllerFile(`${ctx.home}/ZZ_PROBE_no_such_file.txt`));
    ctx.note('records: delete a missing file', {
      code: err.code, httpStatus: err.httpStatus, controllerCode: err.controllerCode, controllerMsg: err.controllerMsg,
    });
    expect(err.message.length).toBeGreaterThan(0);
  });

  // ─── Volume roots per generation ──────────────────────────────────────────

  if (ctx.generation === 'rws2') {
    it('accepts $HOME as HOME on RWS 2.0: the client sends HOME, the listings agree', async () => {
      const m = await ctx.ensureManager();
      await sourceFile();
      const mark = traceLines(ctx.lane).length;
      const viaDollar = await m.listDirectory('$HOME');
      const sent = requestsSince(ctx.lane, mark).filter(r => r.method === 'GET' && r.path.startsWith('/fileservice/'));
      expect(sent.map(r => r.path)).toContain('/fileservice/HOME');
      expect(sent.some(r => /\$HOME|%24HOME/i.test(r.path))).toBe(false);
      const plain = await m.listDirectory('HOME');
      const key = (es: FileEntry[]): string[] => es.map(e => `${e.type}:${e.name}`).sort();
      expect(key(viaDollar)).toEqual(key(plain));
      // A file written through one form reads back through the other.
      expect(await m.readFile(`$HOME/${WORK}/${SOURCE}`)).toBe(TEXT);
    });

    it('lists $TEMP like TEMP on RWS 2.0 (the client sends %24TEMP, which the controller accepts)', async () => {
      const m = await ctx.ensureManager();
      const key = (es: FileEntry[]): string[] => es.map(e => `${e.type}:${e.name}`).sort();
      const plain = await m.listDirectory('TEMP');
      const viaDollar = await m.listDirectory('$TEMP');
      expect(key(viaDollar)).toEqual(key(plain));
    });
  }

  if (ctx.generation === 'rws1') {
    it('refuses the bare HOME volume on a read: RWS 1.0 needs $HOME (RESOURCE_NOT_FOUND, 404)', async () => {
      const m = await ctx.ensureManager();
      expect((await m.listDirectory('$HOME')).length).toBeGreaterThan(0);
      const err = await expectRwsError(() => m.listDirectory('HOME'));
      expect(err.code).toBe('RESOURCE_NOT_FOUND');
      expect(err.httpStatus).toBe(404);
      expect(err.controllerCode).toBe(-1073414146);
    });

    it('writes an upload to the bare HOME into $HOME, readable only through $HOME (RW 6.16 as it is)', async () => {
      const m = await ctx.ensureManager();
      const name = 'ZZ_PROBE_bare.txt';
      try {
        // Live-verified 2026-09-29 on RW 6.16.03: PUT HOME/x answers 201 and
        // writes into $HOME, while GET HOME/x answers 404.
        await m.uploadFile(`HOME/${name}`, TEXT);
        expect(entryOf(await m.listDirectory('$HOME'), name, 'file')).toBeDefined();
        expect(await m.readFile(`$HOME/${name}`)).toBe(TEXT);
        const err = await expectRwsError(() => m.readFile(`HOME/${name}`));
        expect(err.code).toBe('RESOURCE_NOT_FOUND');
        expect(err.httpStatus).toBe(404);
      } finally {
        await removeIfPresent('$HOME', name);
      }
      expect(entryOf(await m.listDirectory('$HOME'), name)).toBeUndefined();
    });
  }

  // ─── Access ───────────────────────────────────────────────────────────────

  it('uploads, copies, renames and deletes without taking mastership or write access', async () => {
    const m = await ctx.ensureManager();
    const dir = await workDir();
    const a = 'ZZ_PROBE_acc_a.txt';
    const b = 'ZZ_PROBE_acc_b.txt';
    const c = 'ZZ_PROBE_acc_c.txt';
    const mark = traceLines(ctx.lane).length;
    try {
      await m.uploadFile(`${dir}/${a}`, TEXT);
      await m.copyControllerFile(`${dir}/${a}`, `${dir}/${b}`);
      await m.renameFile(`${dir}/${b}`, c);
      await m.deleteControllerFile(`${dir}/${a}`);
      await m.deleteControllerFile(`${dir}/${c}`);
    } finally {
      await removeIfPresent(dir, a);
      await removeIfPresent(dir, b);
      await removeIfPresent(dir, c);
    }
    const sent = requestsSince(ctx.lane, mark);
    // The operations themselves went out ...
    expect(sent.some(r => r.method === 'PUT' && r.path.includes('/fileservice/'))).toBe(true);
    expect(sent.some(r => r.method === 'DELETE' && r.path.includes('/fileservice/'))).toBe(true);
    // ... and nothing asked for access around them. On RW 8.2.1 none of these
    // needs control-station write access (live-verified 2026-09-29).
    const access = sent.filter(r => r.method === 'POST' && /mastership|writeaccess|controlstation/i.test(r.path));
    expect(access).toEqual([]);
    expect(entryOf(await m.listDirectory(dir), a)).toBeUndefined();
    expect(entryOf(await m.listDirectory(dir), c)).toBeUndefined();
  });

  // ─── Delete ───────────────────────────────────────────────────────────────

  it('records deleting a directory that is not empty', async () => {
    const m = await ctx.ensureManager();
    const dir = await workDir();
    const full = 'ZZ_PROBE_full';
    if (!entryOf(await m.listDirectory(dir), full, 'dir')) { await m.createDirectory(dir, full); }
    await m.uploadFile(`${dir}/${full}/ZZ_PROBE_inner.txt`, TEXT);
    let outcome: Record<string, unknown> = { resolved: true };
    try {
      await m.deleteControllerFile(`${dir}/${full}`);
    } catch (e) {
      const err = await expectRwsError(() => Promise.reject(e));
      outcome = { resolved: false, code: err.code, httpStatus: err.httpStatus, controllerCode: err.controllerCode, controllerMsg: err.controllerMsg };
    }
    const after = entryOf(await m.listDirectory(dir), full, 'dir');
    ctx.note('records: delete a non-empty directory', { ...outcome, stillListed: !!after });
    if (outcome.resolved) {
      // A delete that answered success removed the directory with its content.
      expect(after).toBeUndefined();
    } else {
      // A refused delete left the directory and its file intact.
      expect(after).toBeDefined();
      expect(await m.readFile(`${dir}/${full}/ZZ_PROBE_inner.txt`)).toBe(TEXT);
      await deleteTree(m, `${dir}/${full}`);
    }
    expect(entryOf(await m.listDirectory(dir), full)).toBeUndefined();
  });

  it('deletes the files and the directory; HOME lists as it did before', async () => {
    const m = await ctx.ensureManager();
    await sourceFile();
    await deleteTree(m, workPath());
    const home = await m.listDirectory(ctx.home);
    expect(entryOf(home, WORK)).toBeUndefined();
    const err = await expectRwsError(() => m.listDirectory(workPath()));
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    const snap = await ctx.snapshot();
    expect(snap.probeEntries).toEqual([]);
    if (homeAtStart) { expect(home.map(e => e.name).sort()).toEqual(homeAtStart); }
  });
});
