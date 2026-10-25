/**
 * Processes on this PC, for local discovery (Windows only; read-only, no network).
 *
 * - `pidImages`: PID to image name, from `tasklist.exe /fo csv /nh`. Used to keep only the
 *   listening ports a RobotStudio virtual controller owns, and to name the owning process.
 * - `processCommandLines`: PID to command line, from one CIM query through `powershell.exe`,
 *   filtered by PID. Only the virtual-controller processes' command lines are read, never other
 *   programs'.
 * - `readVcSystemFolder`: `system.xml` and `rsmeta.xml` in the system folder a `Vrchost64.exe`
 *   command line names after `-sp`.
 * - `vcProcessDetails`: the three together, soft-failing: a missing, blocked or slow PowerShell,
 *   an empty command line or an unreadable folder gives a note, never an error.
 *
 * Observed 2026-10-03 on RobotStudio VCs (RW 7.21.0+229, 7.21.4+417, 8.1.1+614, 8.2.1+1023): each
 * OmniCore VC runs in its own `Vrchost64.exe`, started as
 * `Vrchost64.exe -sp "<system folder>" ... -pp "<RobVC pid>"`; the folder holds `system.xml`
 * (`SystemName`, and the `RobotControl` media version such as `8.2.1+1023`) and `rsmeta.xml`
 * (`HostName`). An RW 6.16.03 VC runs inside `RobVC.exe`, started with `-Embedding` only, so its
 * folder is not visible: only its port and PID are.
 *
 * `wmic.exe` is not used: it is absent on current Windows 11 builds.
 */

import * as path from 'path';
import { readFile as fsReadFile } from 'fs/promises';
import type { PidImageMap, VcProcessDetails, VcProcessImage } from './types.js';

// ---------------------------------------------------------------------------
// Running a program
// ---------------------------------------------------------------------------

/** How a program is run; tests pass a fake. Mirrors `util.promisify(child_process.execFile)`. */
export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: boolean; maxBuffer: number; signal?: AbortSignal; encoding: 'utf8' },
) => Promise<{ stdout: string; stderr: string }>;

/** How a file is read; tests pass a fake. Defaults to `fs/promises.readFile`. */
export type ReadFileFn = (file: string) => Promise<Buffer | string>;

/** Outcome of running one program, when it did not answer. */
export type RunFailure = { status: 'missing' | 'timeout' | 'failed' | 'aborted' | 'unrecognised'; detail?: string };

/** Largest output read from a program. */
const MAX_BUFFER = 16 * 1024 * 1024;

/** Largest `system.xml` / `rsmeta.xml` read (each is a few kB). */
const MAX_XML_BYTES = 1024 * 1024;

/** Default timeouts, ms. */
export const TASKLIST_TIMEOUT_MS = 5000;
export const CIM_TIMEOUT_MS = 10000;

/** At most this many PIDs per CIM query (keeps the filter short). */
const CIM_PIDS_PER_QUERY = 32;

const defaultExecFile: ExecFileFn = async (file, args, opts) => {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const run = promisify(execFile);
  const { stdout, stderr } = await run(file, args, opts);
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** `%SystemRoot%` (execFile does not expand it). */
export function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows';
}

/** Absolute path of `tasklist.exe`. */
export function tasklistPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(systemRoot(env), 'System32', 'tasklist.exe');
}

/** Absolute path of Windows PowerShell. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Map an `execFile` rejection to a run outcome. */
export function classifyRunError(err: unknown, signal?: AbortSignal): RunFailure {
  const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown }) | undefined;
  if (signal?.aborted || e?.name === 'AbortError' || e?.code === 'ABORT_ERR') { return { status: 'aborted' }; }
  if (e?.code === 'ENOENT') { return { status: 'missing' }; }
  if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { return { status: 'failed', detail: 'output too large' }; }
  if (e?.killed === true && (e.signal === 'SIGTERM' || e.signal == null)) { return { status: 'timeout' }; }
  if (typeof e?.code === 'number') { return { status: 'failed', detail: `exit code ${e.code}` }; }
  if (e?.signal) { return { status: 'failed', detail: `signal ${e.signal}` }; }
  return { status: 'failed', detail: e?.message ? String(e.message).split(/\r?\n/)[0].slice(0, 200) : undefined };
}

// ---------------------------------------------------------------------------
// PID to image (tasklist)
// ---------------------------------------------------------------------------

/** The two RobotStudio virtual-controller images, in their canonical spelling. */
const VC_IMAGES: ReadonlyMap<string, VcProcessImage> = new Map([
  ['robvc.exe', 'RobVC.exe'],
  ['vrchost64.exe', 'Vrchost64.exe'],
]);

/** The canonical virtual-controller image name for `image` (case-insensitive), or undefined. */
export function vcImageOf(image: string | undefined): VcProcessImage | undefined {
  return image === undefined ? undefined : VC_IMAGES.get(image.trim().toLowerCase());
}

/** true when `image` is `RobVC.exe` or `Vrchost64.exe` (case-insensitive). */
export function isVcImage(image: string | undefined): boolean {
  return vcImageOf(image) !== undefined;
}

/** Split one CSV line of quoted fields (`"a","b,c","d""e"`). Returns undefined for any other shape. */
function splitQuotedCsv(line: string): string[] | undefined {
  const fields: string[] = [];
  const re = /"((?:[^"]|"")*)"(,|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < line.length && (m = re.exec(line)) !== null) {
    fields.push(m[1].replace(/""/g, '"'));
    if (m[2] === '') { break; }
  }
  return re.lastIndex === line.length && fields.length > 0 ? fields : undefined;
}

/**
 * Parse `tasklist /fo csv /nh`: one quoted row per process, image name first and PID second
 * (`"Vrchost64.exe","14944","Console","1","123,456 K"`). Neither column is translated on a
 * localized Windows. A row of any other shape is skipped. Returns undefined when the output has
 * text but no row parsed (not tasklist CSV).
 */
export function parseTasklistCsv(output: string): PidImageMap | undefined {
  const map: PidImageMap = new Map();
  let sawText = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (line === '') { continue; }
    sawText = true;
    const f = splitQuotedCsv(line);
    if (!f || f.length < 2 || !/^\d+$/.test(f[1])) { continue; }
    const pid = Number(f[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) { continue; }
    map.set(pid, vcImageOf(f[0]) ?? f[0]);
  }
  return map.size === 0 && sawText ? undefined : map;
}

/** Options shared by the process readers. */
export interface ProcessReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  execFile?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
}

/**
 * PID to image name for every process on this PC (Windows), from one
 * `tasklist.exe /fo csv /nh` run (5 s timeout by default). Never rejects.
 */
export async function pidImages(opts: ProcessReadOptions = {}): Promise<{ status: 'ok'; images: PidImageMap } | RunFailure> {
  if (opts.signal?.aborted) { return { status: 'aborted' }; }
  const run = opts.execFile ?? defaultExecFile;
  let stdout: string;
  try {
    ({ stdout } = await run(tasklistPath(opts.env), ['/fo', 'csv', '/nh'], {
      timeout: opts.timeoutMs ?? TASKLIST_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER,
      signal: opts.signal, encoding: 'utf8',
    }));
  } catch (err) {
    return classifyRunError(err, opts.signal);
  }
  const images = parseTasklistCsv(stdout);
  return images ? { status: 'ok', images } : { status: 'unrecognised', detail: 'tasklist output not understood' };
}

// ---------------------------------------------------------------------------
// PID to command line (CIM through PowerShell)
// ---------------------------------------------------------------------------

/** Keep valid, distinct, positive integer PIDs. */
function cleanPids(pids: readonly number[]): number[] {
  return [...new Set(pids.filter(p => Number.isSafeInteger(p) && p > 0))];
}

/**
 * The PowerShell script for one CIM query filtered by PID. Only integers enter the script, so
 * nothing the caller passes can change what runs.
 */
export function cimCommandLineScript(pids: readonly number[]): string {
  const clean = cleanPids(pids);
  if (clean.length === 0) { throw new RangeError('no valid PID'); }
  const filter = clean.map(p => `ProcessId=${p}`).join(' OR ');
  return '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
    + `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
}

/**
 * Parse the CIM query's JSON: one object, an array of objects, or nothing (no process matched).
 * Each object carries `ProcessId` and `CommandLine` (a string, or null when Windows does not
 * show it, which is likely when the process runs elevated and the reader does not). Returns
 * undefined when the text is not that shape.
 */
export function parseCimProcessJson(output: string): Map<number, string | null> | undefined {
  const text = output.replace(/^\uFEFF/, '').trim();
  const map = new Map<number, string | null>();
  if (text === '') { return map; }
  let data: unknown;
  try { data = JSON.parse(text); } catch { return undefined; }
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') { return undefined; }
    const r = row as { ProcessId?: unknown; CommandLine?: unknown };
    const pid = typeof r.ProcessId === 'number' ? r.ProcessId : Number(r.ProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0) { return undefined; }
    map.set(pid, typeof r.CommandLine === 'string' ? r.CommandLine : null);
  }
  return map;
}

/**
 * PID to command line for the given PIDs only, from CIM through `powershell.exe -NoProfile
 * -NonInteractive` (10 s timeout per query by default; a PowerShell start took about 0.3 s and a
 * two-PID query 0.65-0.82 s on 2026-10-03). A PID that has exited is absent from the map.
 * Never rejects.
 */
export async function processCommandLines(
  pids: readonly number[],
  opts: ProcessReadOptions = {},
): Promise<{ status: 'ok'; commandLines: Map<number, string | null> } | RunFailure> {
  const clean = cleanPids(pids);
  const all = new Map<number, string | null>();
  if (clean.length === 0) { return { status: 'ok', commandLines: all }; }
  const run = opts.execFile ?? defaultExecFile;
  for (let i = 0; i < clean.length; i += CIM_PIDS_PER_QUERY) {
    if (opts.signal?.aborted) { return { status: 'aborted' }; }
    const chunk = clean.slice(i, i + CIM_PIDS_PER_QUERY);
    let stdout: string;
    try {
      ({ stdout } = await run(
        powershellPath(opts.env),
        ['-NoProfile', '-NonInteractive', '-Command', cimCommandLineScript(chunk)],
        { timeout: opts.timeoutMs ?? CIM_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER, signal: opts.signal, encoding: 'utf8' },
      ));
    } catch (err) {
      return classifyRunError(err, opts.signal);
    }
    const part = parseCimProcessJson(stdout);
    if (!part) { return { status: 'unrecognised', detail: 'process query output not understood' }; }
    for (const [pid, line] of part) { if (chunk.includes(pid)) { all.set(pid, line); } }
  }
  return { status: 'ok', commandLines: all };
}

// ---------------------------------------------------------------------------
// System folder
// ---------------------------------------------------------------------------

/**
 * The system folder after `-sp` in a `Vrchost64.exe` command line, quoted (`-sp "C:\a b\X"`) or
 * not (`-sp C:\X`). Undefined when the command line has no `-sp`.
 */
export function parseSystemDir(commandLine: string | null | undefined): string | undefined {
  if (!commandLine) { return undefined; }
  const m = /(?:^|\s)-sp\s+(?:"([^"]+)"|(\S+))/i.exec(commandLine);
  const dir = (m?.[1] ?? m?.[2])?.trim();
  return dir ? dir : undefined;
}

/** Undo the five predefined XML entities and numeric character references. */
function xmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** Text of the first `<tag>...</tag>` element, entities decoded; undefined when absent or empty. */
function elementText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
  const v = m ? xmlText(m[1]) : '';
  return v === '' ? undefined : v;
}

/** Attributes of one start tag's attribute text (`name="RobotControl" version="8.2.1+1023"`). */
function attributes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) { out.set(m[1], xmlText(m[2] ?? m[3] ?? '')); }
  return out;
}

/**
 * Parse a virtual controller's `system.xml`: `<SystemName>` and the version of the
 * `<Media name="RobotControl" version="...">` entry (e.g. `8.2.1+1023`).
 */
export function parseSystemXml(xml: string): { systemName?: string; rwVersion?: string } {
  const out: { systemName?: string; rwVersion?: string } = {};
  const name = elementText(xml, 'SystemName');
  if (name) { out.systemName = name; }
  const re = /<Media\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = attributes(m[1]);
    if (a.get('name') === 'RobotControl') {
      const v = a.get('version');
      if (v) { out.rwVersion = v; }
      break;
    }
  }
  return out;
}

/** Parse RobotStudio's `rsmeta.xml` next to `system.xml`: `<HostName>`. */
export function parseRsmetaXml(xml: string): { hostName?: string } {
  const hostName = elementText(xml, 'HostName');
  return hostName ? { hostName } : {};
}

/** File bytes to text: UTF-8 (BOM removed) or UTF-16 LE when it starts with that BOM. */
function decodeXml(data: Buffer | string): string {
  if (typeof data === 'string') { return data.replace(/^\uFEFF/, ''); }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) { return data.subarray(2).toString('utf16le'); }
  return data.toString('utf8').replace(/^\uFEFF/, '');
}

/** Read one small XML file; undefined when it is missing, unreadable or too large. */
async function readSmallXml(file: string, read: ReadFileFn): Promise<string | undefined> {
  try {
    const data = await read(file);
    if (data.length > MAX_XML_BYTES) { return undefined; }
    return decodeXml(data);
  } catch {
    return undefined;
  }
}

/**
 * Read `system.xml` and `rsmeta.xml` from a virtual controller's system folder. Missing fields
 * stay absent; `readable` is false when neither file could be read. Never rejects.
 */
export async function readVcSystemFolder(
  systemDir: string,
  opts: { readFile?: ReadFileFn } = {},
): Promise<{ systemName?: string; rwVersion?: string; hostName?: string; readable: boolean }> {
  const read: ReadFileFn = opts.readFile ?? ((f: string): Promise<Buffer> => fsReadFile(f));
  const [sys, meta] = await Promise.all([
    readSmallXml(path.win32.join(systemDir, 'system.xml'), read),
    readSmallXml(path.win32.join(systemDir, 'rsmeta.xml'), read),
  ]);
  return {
    ...(sys !== undefined ? parseSystemXml(sys) : {}),
    ...(meta !== undefined ? parseRsmetaXml(meta) : {}),
    readable: sys !== undefined || meta !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Everything together
// ---------------------------------------------------------------------------

/** Options for `vcProcessDetails`. */
export interface VcDetailsOptions extends ProcessReadOptions {
  /** Defaults to `process.platform`; anything but `'win32'` returns nothing. */
  platform?: NodeJS.Platform;
  readFile?: ReadFileFn;
}

function failureWords(f: RunFailure): string {
  switch (f.status) {
    case 'missing': return 'PowerShell is not available';
    case 'timeout': return 'the process query timed out';
    case 'aborted': return 'discovery was cancelled';
    case 'unrecognised': return 'the process query output was not understood';
    default: return `the process query failed${f.detail ? ` (${f.detail})` : ''}`;
  }
}

/**
 * Name and RobotWare version of the RobotStudio virtual controllers that own local ports, read
 * on this PC with no network traffic (Windows only).
 *
 * `processes` lists the owning PIDs with their image names (from `pidImages`). Only
 * `Vrchost64.exe` PIDs are looked up: one CIM query for all of them, then each `-sp` folder's
 * `system.xml` and `rsmeta.xml`. A `RobVC.exe` PID (RobotWare 6) gets its PID and image only.
 * Any other PID is left out, and no PowerShell starts when no `Vrchost64.exe` PID is given.
 *
 * Soft fail: when PowerShell is missing, blocked or slow, a command line is empty, or a folder
 * cannot be read, the entry keeps its PID, `note` says why, and the same sentence is in `notes`.
 * Never rejects.
 */
export async function vcProcessDetails(
  processes: ReadonlyArray<{ pid: number; image?: string }>,
  opts: VcDetailsOptions = {},
): Promise<{ details: Map<number, VcProcessDetails>; notes: string[] }> {
  const details = new Map<number, VcProcessDetails>();
  const notes: string[] = [];
  if ((opts.platform ?? process.platform) !== 'win32') { return { details, notes }; }

  const hosts: number[] = [];
  for (const p of processes) {
    if (!Number.isSafeInteger(p.pid) || p.pid <= 0 || details.has(p.pid)) { continue; }
    const image = vcImageOf(p.image);
    if (image === 'RobVC.exe') { details.set(p.pid, { pid: p.pid, image }); }
    if (image === 'Vrchost64.exe') { details.set(p.pid, { pid: p.pid, image }); hosts.push(p.pid); }
  }
  if (hosts.length === 0 || opts.signal?.aborted) { return { details, notes }; }

  const lines = await processCommandLines(hosts, opts);
  if (lines.status !== 'ok') {
    if (lines.status === 'aborted') { return { details, notes }; }
    const note = `Could not read the virtual controller process details on this PC: ${failureWords(lines)}. `
      + 'Local virtual controllers are listed without their system name and RobotWare version.';
    for (const pid of hosts) { details.set(pid, { ...details.get(pid)!, note }); }
    notes.push(note);
    return { details, notes };
  }

  await Promise.all(hosts.map(async pid => {
    const entry = details.get(pid)!;
    const commandLine = lines.commandLines.get(pid);
    if (commandLine === undefined) {
      entry.note = `Process ${pid} ended before its details could be read.`;
    } else if (commandLine === null || commandLine.trim() === '') {
      entry.note = `The command line of process ${pid} is not visible (RobotStudio may run as administrator); `
        + 'its system name and RobotWare version are not shown.';
    } else {
      entry.commandLine = commandLine;
      const dir = parseSystemDir(commandLine);
      if (!dir) {
        entry.note = `The command line of process ${pid} names no system folder; its system name and RobotWare version are not shown.`;
      } else {
        entry.systemDir = dir;
        const folder = await readVcSystemFolder(dir, { readFile: opts.readFile });
        if (folder.systemName) { entry.systemName = folder.systemName; }
        if (folder.rwVersion) { entry.rwVersion = folder.rwVersion; }
        if (folder.hostName) { entry.hostName = folder.hostName; }
        if (!folder.readable) {
          entry.note = `The system folder of process ${pid} could not be read; its system name and RobotWare version are not shown.`;
        }
      }
    }
  }));
  for (const pid of hosts) {
    const note = details.get(pid)?.note;
    if (note) { notes.push(note); }
  }
  return { details, notes };
}
