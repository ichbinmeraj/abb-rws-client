/**
 * Listening-port scan of this PC: which TCP ports are listening, asked of the OS, read-only.
 * Nothing here opens a socket; it starts at most two child processes (or reads two `/proc`
 * files) per scan.
 *
 * Sources, in order (the next one runs only when the previous one is `missing`, `timeout`,
 * `failed` or `unrecognised`, never after an `ok` with an empty list):
 *
 * | OS      | first                                   | second                                       |
 * |---------|-----------------------------------------|----------------------------------------------|
 * | Windows | `%SystemRoot%\System32\netstat.exe -ano` | `Get-NetTCPConnection` (opt-in, PowerShell) |
 * | Linux   | `/proc/net/tcp` + `/proc/net/tcp6`      | `ss -ltn`                                    |
 * | macOS   | `netstat -an -p tcp`                    | `lsof -nP -b -w -iTCP -sTCP:LISTEN -Fptn`    |
 *
 * `netstat -ano` covers TCP and TCPv6 in one call and took 29-43 ms on Windows 11 (observed
 * 2026-10-03); `Get-NetTCPConnection` took about 2.3 s on the same PC, and starting PowerShell
 * is something endpoint protection watches, so it runs only when the caller turns it on.
 * RobotStudio runs on Windows only, so off Windows an empty `ok` answer is the normal one.
 *
 * Every parser is pure and keys on structure, never on a translated word: a Windows netstat
 * row is a listener when its foreign address ends in `:0`, which holds on any display language
 * (the state word is `LISTENING` in English and `ABHÖREN` in German, and the German one arrives
 * as OEM code-page bytes). Lines are split on whitespace, never on column positions.
 *
 * The address to probe for a listening port, and which ports are probed at all, are decided by
 * `selectLocalTargets` (pure).
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../Logger.js';
import type {
  ListeningPort,
  LocalListeners,
  LocalScanReport,
  LocalScanStatus,
  ScanOutcome,
  ScanSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Largest output read from one source; more is a `failed` source, not a truncated list. */
export const MAX_SOURCE_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Per-source timeouts, ms. */
export const SOURCE_TIMEOUT_MS = {
  winNetstat: 5_000,
  powershell: 10_000,
  procNetTcp: 3_000,
  ss: 5_000,
  macNetstat: 5_000,
  lsof: 5_000,
} as const;

/** Total time for every source of one scan (the opt-in sweep is not part of it). */
export const LOCAL_SCAN_BUDGET_MS = 15_000;

/** Source labels, as they appear in `LocalScanReport.source` and `attempts`. */
export const SOURCE_NAMES = {
  winNetstat: 'netstat -ano',
  powershell: 'Get-NetTCPConnection',
  procNetTcp: '/proc/net/tcp',
  ss: 'ss -ltn',
  macNetstat: 'netstat -an -p tcp',
  lsof: 'lsof -iTCP -sTCP:LISTEN',
} as const;

// ---------------------------------------------------------------------------
// Address helpers (pure)
// ---------------------------------------------------------------------------

/** Split `host<sep>port` at the last separator; `undefined` unless the port is 1-65535. */
function splitHostPort(token: string, sep: ':' | '.'): { host: string; port: number } | undefined {
  const i = token.lastIndexOf(sep);
  if (i <= 0 || i === token.length - 1) { return undefined; }
  const portText = token.slice(i + 1);
  if (!/^\d{1,5}$/.test(portText)) { return undefined; }
  const port = Number(portText);
  if (port < 1 || port > 65535) { return undefined; }
  return { host: token.slice(0, i), port };
}

/**
 * `%zone` and brackets removed, lower case: `[fe80::1%18]` (netstat, zone inside the brackets)
 * and `[fe80::1]%eth0` (iproute2 ss, interface after the brackets) give `fe80::1`,
 * `127.0.0.53%lo` gives `127.0.0.53`.
 */
function canonicalBind(host: string): string {
  let h = host;
  const zone = h.indexOf('%');
  if (zone >= 0) { h = h.slice(0, zone); }
  if (h.startsWith('[')) { h = h.endsWith(']') ? h.slice(1, -1) : h.slice(1); }
  return h.toLowerCase();
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(text: string): boolean {
  const m = IPV4_RE.exec(text);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** Text form of 16 address bytes: RFC 5952 compression, `::ffff:a.b.c.d` for v4-mapped. */
function formatIPv6(bytes: number[]): string {
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join('.')}`;
  }
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) { groups.push((bytes[i] << 8) | bytes[i + 1]); }
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) { j++; }
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = (g: number[]): string => g.map((x) => x.toString(16)).join(':');
  if (bestLen < 2) { return hex(groups); }
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLen))}`;
}

// ---------------------------------------------------------------------------
// Parsers and recognisers (pure)
// ---------------------------------------------------------------------------

/**
 * Windows `netstat -ano` (any display language). A row is a listener when Proto starts with
 * `TCP` and the foreign address ends in `:0` (`0.0.0.0:0`, `[::]:0`): a listening socket has no
 * peer. The PID is the last column. UDP rows (foreign `*:*`) and connections are skipped.
 * Observed 2026-10-03 on Windows 11 en-US (console code page 65001); the `:0` rule uses no word,
 * so it is expected to hold on other display languages too.
 */
export function parseWinNetstat(text: string, source: string = SOURCE_NAMES.winNetstat): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || !/^TCP/i.test(cols[0]) || !cols[2].endsWith(':0')) { continue; }
    const local = splitHostPort(cols[1], ':');
    if (!local) { continue; }
    const row: ListeningPort = { port: local.port, bind: canonicalBind(local.host), source };
    const last = cols[cols.length - 1];
    if (cols.length >= 4 && /^\d+$/.test(last)) { row.pid = Number(last); }
    out.push(row);
  }
  return out;
}

/**
 * true when the text has at least one `TCP <addr>:<port> <addr>:<port>` row. A Windows host
 * always listens on 135 and 445, so a run of netstat without any TCP row is not understood.
 */
export function recogniseWinNetstat(text: string): boolean {
  return /^\s*TCP\S*\s+\S+:\d+\s+\S+:\d+/im.test(text);
}

interface NetTcpRow { LocalAddress?: unknown; LocalPort?: unknown; OwningProcess?: unknown }

function readNetTcpJson(text: string): NetTcpRow[] | undefined {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (!t) { return undefined; }
  let value: unknown;
  try { value = JSON.parse(t); } catch { return undefined; }
  const items = Array.isArray(value) ? value : [value];
  const rows = items.filter((x): x is NetTcpRow => !!x && typeof x === 'object');
  return rows.some((r) => 'LocalAddress' in r && 'LocalPort' in r) ? rows : undefined;
}

/**
 * PowerShell `Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,
 * OwningProcess | ConvertTo-Json -Compress`: one object, or an array. A dual-stack socket is
 * listed only as `::` (observed 2026-10-03, Windows 11: the RobotStudio VC ports had no `0.0.0.0`
 * row there while netstat showed both), so `::` alone never means IPv6-only.
 */
export function parseWinNetTcpJson(text: string, source: string = SOURCE_NAMES.powershell): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const r of readNetTcpJson(text) ?? []) {
    const port = typeof r.LocalPort === 'number' ? r.LocalPort : Number(r.LocalPort);
    if (typeof r.LocalAddress !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) { continue; }
    const row: ListeningPort = { port, bind: canonicalBind(r.LocalAddress), source };
    const pid = typeof r.OwningProcess === 'number' ? r.OwningProcess : Number(r.OwningProcess);
    if (Number.isInteger(pid) && pid >= 0) { row.pid = pid; }
    out.push(row);
  }
  return out;
}

/** true when the text parses as a JSON object or array carrying `LocalAddress` and `LocalPort`. */
export function recogniseWinNetTcpJson(text: string): boolean {
  return readNetTcpJson(text) !== undefined;
}

const PROC_ROW_RE = /^\s*\d+:\s+([0-9A-Fa-f]+):([0-9A-Fa-f]{4})\s+[0-9A-Fa-f]+:[0-9A-Fa-f]{4}\s+([0-9A-Fa-f]{2})\b/;

/**
 * Linux `/proc/net/tcp` (`ipv6` false) or `/proc/net/tcp6` (`ipv6` true). Keeps rows with state
 * `0A` (TCP_LISTEN). The kernel prints the port after `ntohs`, so it reads naturally, and the
 * address as the raw network-order value, so on a little-endian CPU the bytes of each 32-bit
 * word come out reversed (`0100007F` is 127.0.0.1; on big-endian `7F000001`). tcp6 prints four
 * such words. No PID (the row carries an inode only). Format: the kernel's `tcp_ipv4.c` and
 * `tcp_ipv6.c` print functions.
 */
export function parseProcNetTcp(
  text: string,
  ipv6: boolean,
  endianness: 'LE' | 'BE' = os.endianness(),
  source: string = SOURCE_NAMES.procNetTcp,
): ListeningPort[] {
  const out: ListeningPort[] = [];
  const hexLen = ipv6 ? 32 : 8;
  for (const line of text.split(/\r?\n/)) {
    const m = PROC_ROW_RE.exec(line);
    if (!m || m[3].toUpperCase() !== '0A' || m[1].length !== hexLen) { continue; }
    const bytes: number[] = [];
    for (let w = 0; w < hexLen; w += 8) {
      const word = [0, 2, 4, 6].map((i) => parseInt(m[1].slice(w + i, w + i + 2), 16));
      bytes.push(...(endianness === 'LE' ? word.reverse() : word));
    }
    const port = parseInt(m[2], 16);
    if (port < 1) { continue; }
    out.push({ port, bind: ipv6 ? formatIPv6(bytes) : bytes.join('.'), source });
  }
  return out;
}

/** true when the first non-empty line is the header (holds `local_address` and `st`). Zero rows is a valid answer. */
export function recogniseProcNetTcp(text: string): boolean {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '');
  return !!first && first.includes('local_address') && /\bst\b/.test(first);
}

const SS_HEADER_FIRST = new Set(['State', 'Netid', 'Recv-Q']);

/** An ss address token: `0.0.0.0:22`, `*:22`, `[::]:22`, `:::22`, `::1:631`, `[::ffff:127.0.0.1]:9403`, `127.0.0.53%lo:53`. */
function parseSsAddress(token: string): { bind: string; port: number } | undefined {
  const hp = splitHostPort(token, ':');
  if (!hp) { return undefined; }
  const bind = canonicalBind(hp.host);
  if (bind !== '*' && !isIPv4(bind) && !(bind.includes(':') && /^[0-9a-f:.]+$/.test(bind))) { return undefined; }
  return { bind, port: hp.port };
}

interface SsRow { state?: string; netid?: string; local?: { bind: string; port: number } }

/** One ss data row: optional Netid, optional State, Recv-Q, Send-Q, local, peer, anything after. */
function parseSsRow(tokens: string[]): SsRow | undefined {
  const i = tokens.findIndex((t, k) => /^\d+$/.test(t) && /^\d+$/.test(tokens[k + 1] ?? ''));
  if (i < 0 || i > 2 || tokens.length < i + 3) { return undefined; }
  const local = parseSsAddress(tokens[i + 2]);
  if (!local) { return undefined; }
  return { state: i >= 1 ? tokens[i - 1] : undefined, netid: i >= 2 ? tokens[i - 2] : undefined, local };
}

/**
 * Linux `ss -ltn`, every iproute2 address form: up to v4.12 IPv4 any is `*` and IPv6 is not
 * bracketed (`:::22`, `::1:631`, `::ffff:127.0.0.1:9403`); v4.13 brackets IPv6 and prints `*`
 * for both "any" addresses; from v4.14 IPv4 any is `0.0.0.0`, dual-stack IPv6 any `*` and
 * IPv6-only any `[::]`. Any version may add `%ifname`. iproute2 2.6.39 prints no State column.
 * With a State column only `LISTEN` rows are kept (some older builds print established rows in
 * a listening listing); with a Netid column only `tcp` rows. The header is skipped by content,
 * not with `-H` (which crashes on an empty filtered result in iproute2 4.15).
 */
export function parseSs(text: string, source: string = SOURCE_NAMES.ss): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (!tokens[0] || SS_HEADER_FIRST.has(tokens[0])) { continue; }
    const row = parseSsRow(tokens);
    if (!row?.local) { continue; }
    if (row.state !== undefined && row.state.toUpperCase() !== 'LISTEN') { continue; }
    if (row.netid !== undefined && !/^tcp/i.test(row.netid)) { continue; }
    out.push({ port: row.local.port, bind: row.local.bind, source });
  }
  return out;
}

/** true when a header line starts with `State`, `Netid` or `Recv-Q`, or every non-empty line is a listener row. */
export function recogniseSs(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) { return false; }
  if (lines.some((l) => SS_HEADER_FIRST.has(l.split(/\s+/)[0]))) { return true; }
  return lines.every((l) => parseSsRow(l.split(/\s+/)) !== undefined);
}

/**
 * macOS `netstat -an -p tcp`: Proto `tcp4`, `tcp6` or `tcp46`; local address `host.port` (the
 * port after the last dot, `*.80` for any); state `LISTEN` last (the C locale is set). Split on
 * whitespace: column widths change with flags and releases. No PID. A `*` bind becomes
 * `0.0.0.0` on `tcp4`, `::` on `tcp6` and stays `*` on `tcp46`. Format: Apple's netstat
 * `inet.c` (`protopr`, `inetprint`).
 */
export function parseMacNetstat(text: string, source: string = SOURCE_NAMES.macNetstat): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const proto = cols[0]?.toLowerCase() ?? '';
    if (!/^tcp(4|6|46)?$/.test(proto) || cols.length < 6 || cols[cols.length - 1] !== 'LISTEN') { continue; }
    if (!/^\d+$/.test(cols[1]) || !/^\d+$/.test(cols[2])) { continue; }
    const local = splitHostPort(cols[3], '.');
    if (!local) { continue; }
    let bind = canonicalBind(local.host);
    if (bind === '*') { bind = proto === 'tcp4' ? '0.0.0.0' : proto === 'tcp6' ? '::' : '*'; }
    out.push({ port: local.port, bind, source });
  }
  return out;
}

/** true when the text has an `Active Internet connections` or `Proto` header line. */
export function recogniseMacNetstat(text: string): boolean {
  return /^\s*(Active Internet connections|Proto\s)/m.test(text);
}

/**
 * `lsof -nP -b -w -iTCP -sTCP:LISTEN -Fptn` field output: `p<pid>` starts a process, `f<fd>` a
 * file, `t<IPv4|IPv6>` its type, `n<addr:port>` its name. `*:p` takes its family from `t`
 * (`0.0.0.0` or `::`). On macOS lsof run without root lists only the caller's own processes, so
 * it is the second source there, never the first. Format: the lsof manual, "OUTPUT FOR OTHER
 * PROGRAMS".
 */
export function parseLsofF(text: string, source: string = SOURCE_NAMES.lsof): ListeningPort[] {
  const out: ListeningPort[] = [];
  let pid: number | undefined;
  let family: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) { continue; }
    const value = line.slice(1);
    switch (line[0]) {
      case 'p': pid = /^\d+$/.test(value) ? Number(value) : undefined; family = undefined; break;
      case 'f': family = undefined; break;
      case 't': family = value; break;
      case 'n': {
        const hp = splitHostPort(value.split('->')[0], ':');
        if (!hp) { break; }
        let bind = canonicalBind(hp.host);
        if (bind === '*') { bind = family === 'IPv6' ? '::' : family === 'IPv4' ? '0.0.0.0' : '*'; }
        const row: ListeningPort = { port: hp.port, bind, source };
        if (pid !== undefined) { row.pid = pid; }
        out.push(row);
        break;
      }
      default: break;
    }
  }
  return out;
}

/** true when every non-empty line starts with one of the requested field letters (`p`, `f`, `t`, `n`). */
export function recogniseLsofF(text: string): boolean {
  return text.split(/\r?\n/).every((l) => l.trim() === '' || /^[pftn]/.test(l));
}

// ---------------------------------------------------------------------------
// Which local ports are probed, and on which address (pure)
// ---------------------------------------------------------------------------

/**
 * Ports never probed by the unfiltered local scan (and not by the opt-in sweep): services where
 * an unexpected HTTP request is not harmless. Owners from the IANA service name registry unless
 * noted.
 */
export const DENIED_LOCAL_PORTS: ReadonlyMap<number, string> = new Map([
  [102, 'iso-tsap (RFC 1006, ISO transport over TCP; used by Siemens S7 communication)'],
  [502, 'mbap (Modbus/TCP, Modbus Organization)'],
  [1217, 'CODESYS gateway (CODESYS documentation, ports used by CODESYS)'],
  [2222, 'EtherNet-IP-1 (EtherNet/IP I/O, ODVA)'],
  [2404, 'iec-104 (IEC 60870-5-104 telecontrol)'],
  [4840, 'opcua-tcp (OPC UA, OPC Foundation)'],
  [9100, 'pdl-datastream (raw printing)'],
  [11740, 'CODESYS V3 runtime (CODESYS documentation, ports used by CODESYS)'],
  [20000, 'dnp (DNP3)'],
  [44818, 'EtherNet-IP-2 (EtherNet/IP messaging, ODVA)'],
]);

/** One loopback port to probe. */
export interface LocalProbeTarget {
  /** `'127.0.0.1'`, another 127.x.y.z address bound exactly, or `'::1'` for a VC port bound to ::1 alone. */
  host: string;
  port: number;
  /** Owning process, when the source reports one (a VC PID preferred). */
  pid?: number;
  /** The bind was IPv6 "any" with no IPv4 row: if 127.0.0.1 is refused, probe `::1` once. */
  retryOnIpv6Loopback: boolean;
}

/** IPv4 text of a bind, unwrapping a v4-mapped IPv6 bind; `undefined` for any other IPv6 text. */
function ipv4Of(bind: string): string | undefined {
  if (isIPv4(bind)) { return bind; }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bind);
  return mapped && isIPv4(mapped[1]) ? mapped[1] : undefined;
}

/**
 * The address to probe for one port, from all its rows:
 * 1. Any IPv4 wildcard (`0.0.0.0`, `*`, `::ffff:0.0.0.0`) or a 127.0.0.1 bind (also v4-mapped):
 *    127.0.0.1.
 * 2. Else IPv6 any (`::`): 127.0.0.1, and `::1` once if that is refused (a dual-stack socket
 *    accepts IPv4; `Get-NetTCPConnection` shows dual-stack sockets only as `::`).
 * 3. Else another 127.x.y.z bind (`127.0.0.53`): that exact address.
 * 4. Else `::1` only: skipped, unless the owning PID is a virtual-controller process.
 * 5. Anything else (a LAN or link-local address of this PC): skipped. This PC's own network
 *    address is never probed.
 */
export function chooseLocalAddress(
  rows: ReadonlyArray<ListeningPort>,
  vcPids?: ReadonlySet<number>,
): { host: string; retryOnIpv6Loopback: boolean } | undefined {
  const v4 = rows.map((r) => ipv4Of(r.bind)).filter((a): a is string => a !== undefined);
  if (rows.some((r) => r.bind === '*') || v4.some((a) => a === '0.0.0.0' || a === '127.0.0.1')) {
    return { host: '127.0.0.1', retryOnIpv6Loopback: false };
  }
  if (rows.some((r) => r.bind === '::')) { return { host: '127.0.0.1', retryOnIpv6Loopback: true }; }
  const loop = v4.filter((a) => a.startsWith('127.')).sort()[0];
  if (loop) { return { host: loop, retryOnIpv6Loopback: false }; }
  if (vcPids && rows.some((r) => r.bind === '::1' && r.pid !== undefined && vcPids.has(r.pid))) {
    return { host: '::1', retryOnIpv6Loopback: false };
  }
  return undefined;
}

/** Options for `selectLocalTargets`. */
export interface SelectLocalTargetsOptions {
  /** PIDs of virtual-controller processes (`RobVC.exe`, `Vrchost64.exe`), when known. */
  vcPids?: ReadonlySet<number>;
  /**
   * Keep only ports owned by a PID in `vcPids`. Ignored when `vcPids` is undefined (the lookup
   * failed or did not run): the scan is then unfiltered and `DENIED_LOCAL_PORTS` applies.
   */
  filterToVc?: boolean;
}

/**
 * Turn listening rows into loopback probe targets, one per port, in port order. Filtered
 * (`filterToVc` with known `vcPids`): only ports with a row owned by a VC process. Unfiltered:
 * every port except `DENIED_LOCAL_PORTS`. The address rule is `chooseLocalAddress`. Ports the
 * user names are not passed through here; they are never filtered.
 */
export function selectLocalTargets(
  rows: ReadonlyArray<ListeningPort>,
  options: SelectLocalTargetsOptions = {},
): LocalProbeTarget[] {
  const { vcPids } = options;
  const filtered = !!options.filterToVc && vcPids !== undefined;
  const byPort = new Map<number, ListeningPort[]>();
  for (const r of rows) {
    const list = byPort.get(r.port);
    if (list) { list.push(r); } else { byPort.set(r.port, [r]); }
  }
  const out: LocalProbeTarget[] = [];
  for (const port of [...byPort.keys()].sort((a, b) => a - b)) {
    let portRows = byPort.get(port) ?? [];
    if (filtered) {
      portRows = portRows.filter((r) => r.pid !== undefined && vcPids.has(r.pid));
      if (portRows.length === 0) { continue; }
    } else if (DENIED_LOCAL_PORTS.has(port)) {
      continue;
    }
    const addr = chooseLocalAddress(portRows, vcPids);
    if (!addr) { continue; }
    const target: LocalProbeTarget = { host: addr.host, port, retryOnIpv6Loopback: addr.retryOnIpv6Loopback };
    const pid = portRows.find((r) => r.pid !== undefined && vcPids?.has(r.pid))?.pid
      ?? portRows.find((r) => r.pid !== undefined)?.pid;
    if (pid !== undefined) { target.pid = pid; }
    out.push(target);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running the sources
// ---------------------------------------------------------------------------

/** What one child process did. */
export type CommandResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'exit'; code: number; stdout: string }
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'failed'; code?: number | string; signal?: string; detail: string };

/** What one file read did. */
export type ReadResult =
  | { kind: 'ok'; text: string }
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'failed'; code?: string; detail: string };

export interface RunCommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  encoding: BufferEncoding;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

/**
 * Run one read-only command: `execFile` (no shell) with a timeout, the caller's signal, a hidden
 * window and a 16 MiB output cap. ENOENT is `missing`; our own timeout is `timeout`; a non-zero
 * exit is `exit` (with the output, for lsof's "nothing matched"); a signal we did not send, too
 * much output or any other error is `failed`.
 */
export function runCommand(file: string, args: string[], opts: RunCommandOptions): Promise<CommandResult> {
  if (opts.signal?.aborted) { return Promise.resolve({ kind: 'aborted' }); }
  return new Promise((resolve) => {
    try {
      childProcess.execFile(file, args, {
        timeout: opts.timeoutMs,
        signal: opts.signal,
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? MAX_SOURCE_OUTPUT_BYTES,
        encoding: opts.encoding,
        env: opts.env,
      }, (err, stdout) => {
        const text = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        if (!err) { resolve({ kind: 'ok', stdout: text }); return; }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: unknown };
        if (e.name === 'AbortError' || opts.signal?.aborted) { resolve({ kind: 'aborted' }); return; }
        if (e.code === 'ENOENT') { resolve({ kind: 'missing' }); return; }
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ kind: 'failed', code: e.code, detail: 'output larger than the 16 MiB limit' });
          return;
        }
        if (e.killed) { resolve({ kind: 'timeout' }); return; }
        if (e.signal) { resolve({ kind: 'failed', signal: e.signal, detail: `ended by signal ${e.signal}` }); return; }
        if (typeof e.code === 'number') { resolve({ kind: 'exit', code: e.code, stdout: text }); return; }
        const code = typeof e.code === 'string' ? e.code : undefined;
        resolve({ kind: 'failed', code, detail: code ?? e.message });
      });
    } catch (err) {
      resolve({ kind: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

export interface ReadFileOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

/** Read a small text file (a `/proc` table) as a stream, with a timeout, abort and a size cap. */
export function readTextFile(file: string, opts: ReadFileOptions): Promise<ReadResult> {
  if (opts.signal?.aborted) { return Promise.resolve({ kind: 'aborted' }); }
  const maxBytes = opts.maxBytes ?? MAX_SOURCE_OUTPUT_BYTES;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stream = fs.createReadStream(file);
    const finish = (r: ReadResult): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      stream.destroy();
      resolve(r);
    };
    const onAbort = (): void => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) { finish({ kind: 'failed', detail: 'larger than the 16 MiB limit' }); return; }
      chunks.push(buf);
    });
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') { finish({ kind: 'missing' }); return; }
      finish({ kind: 'failed', code: err.code, detail: err.code ?? err.message });
    });
    stream.on('end', () => finish({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') }));
  });
}

/** I/O the scan uses; replaced in unit tests. */
export interface ScanDeps {
  run(file: string, args: string[], opts: RunCommandOptions): Promise<CommandResult>;
  read(file: string, opts: ReadFileOptions): Promise<ReadResult>;
  /** true when the file exists and is executable. */
  isExecutable(file: string): Promise<boolean>;
  now(): number;
}

const defaultDeps: ScanDeps = {
  run: runCommand,
  read: readTextFile,
  isExecutable: async (file) => {
    try { await fs.promises.access(file, fs.constants.X_OK); return true; } catch { return false; }
  },
  now: () => Date.now(),
};

/**
 * Find a POSIX command in `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`, then `PATH`. A user's PATH
 * on Debian has no `/usr/sbin`, and a service may get a minimal PATH, so the fixed directories
 * come first.
 */
export async function findPosixCommand(
  name: string,
  env: NodeJS.ProcessEnv,
  isExecutable: ScanDeps['isExecutable'],
): Promise<string | undefined> {
  const dirs = ['/usr/sbin', '/usr/bin', '/sbin', '/bin', ...(env.PATH ?? '').split(':').filter((d) => d.startsWith('/'))];
  for (const dir of [...new Set(dirs)]) {
    const file = path.posix.join(dir, name);
    if (await isExecutable(file)) { return file; }
  }
  return undefined;
}

/** `%SystemRoot%` as `execFile` needs it (it does not expand variables). */
export function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? 'C:\\Windows';
}

/** Command sources per OS. File reads (`/proc`) are not listed: they are not commands. */
export function commandSources(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<string, ScanSource> {
  if (platform === 'win32') {
    const sys32 = path.win32.join(windowsSystemRoot(env), 'System32');
    return {
      winNetstat: { name: SOURCE_NAMES.winNetstat, file: path.win32.join(sys32, 'netstat.exe'), args: ['-ano'], timeoutMs: SOURCE_TIMEOUT_MS.winNetstat },
      powershell: {
        name: SOURCE_NAMES.powershell,
        file: path.win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: [
          '-NoProfile', '-NonInteractive', '-Command',
          '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetTCPConnection -State Listen | '
            + 'Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress',
        ],
        timeoutMs: SOURCE_TIMEOUT_MS.powershell,
      },
    };
  }
  return {
    ss: { name: SOURCE_NAMES.ss, file: 'ss', args: ['-ltn'], timeoutMs: SOURCE_TIMEOUT_MS.ss },
    macNetstat: { name: SOURCE_NAMES.macNetstat, file: 'netstat', args: ['-an', '-p', 'tcp'], timeoutMs: SOURCE_TIMEOUT_MS.macNetstat },
    lsof: {
      name: SOURCE_NAMES.lsof,
      file: 'lsof',
      args: ['-nP', '-b', '-w', '-iTCP', '-sTCP:LISTEN', '-Fptn'],
      timeoutMs: SOURCE_TIMEOUT_MS.lsof,
    },
  };
}

/** Options for `localListeners`. */
export interface LocalListenersOptions {
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Stops the running source; no later source starts. */
  signal?: AbortSignal;
  /** Windows: run `Get-NetTCPConnection` when `netstat -ano` fails. Default false. */
  powershell?: boolean;
  /** Total time for all sources, ms. Default `LOCAL_SCAN_BUDGET_MS`. */
  budgetMs?: number;
  /** Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** For `/proc` decoding. Default `os.endianness()`. */
  endianness?: 'LE' | 'BE';
  /** I/O replacements for unit tests. */
  deps?: Partial<ScanDeps>;
}

type Step = (timeoutMs: number) => Promise<ScanOutcome>;

/** Map a finished command to an outcome, given how to read its output. */
function commandOutcome(
  source: string,
  r: CommandResult,
  recognise: (text: string) => boolean,
  parse: (text: string) => ListeningPort[],
  emptyExit1IsOk = false,
): ScanOutcome {
  switch (r.kind) {
    case 'ok':
      return recognise(r.stdout)
        ? { status: 'ok', source, ports: parse(r.stdout) }
        : { status: 'unrecognised', source, detail: 'output not understood' };
    case 'exit':
      if (emptyExit1IsOk && r.code === 1 && r.stdout.trim() === '') { return { status: 'ok', source, ports: [] }; }
      return { status: 'failed', source, code: r.code, detail: `exit code ${r.code}` };
    case 'missing': return { status: 'missing', source };
    case 'timeout': return { status: 'timeout', source };
    case 'aborted': return { status: 'skipped', source };
    case 'failed': return { status: 'failed', source, code: r.code, signal: r.signal, detail: r.detail };
  }
}

/**
 * Ask the OS which TCP ports are listening on this PC. Runs the sources of the platform in
 * order until one answers `ok`, each under its own timeout and all under `budgetMs`. Never
 * rejects: every failure is reported in `report.attempts`. `report.vcFilter` is `'off'` and
 * `report.sweep` false here; the caller sets them when it filters by process or sweeps.
 * A cancelled run stops at once; the source it stopped is reported `skipped` with detail
 * `'cancelled'`.
 */
export async function localListeners(options: LocalListenersOptions = {}): Promise<LocalListeners> {
  const deps: ScanDeps = { ...defaultDeps, ...options.deps };
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const signal = options.signal;
  const budget = options.budgetMs ?? LOCAL_SCAN_BUDGET_MS;
  const endianness = options.endianness ?? os.endianness();
  const sources = commandSources(platform, env);
  const posixEnv: NodeJS.ProcessEnv = { ...env, LC_ALL: 'C' };

  const command = (key: string, recognise: (t: string) => boolean, parse: (t: string) => ListeningPort[], opts: { posix: boolean; encoding: BufferEncoding; emptyExit1IsOk?: boolean }): { name: string; step: Step } => {
    const src = sources[key];
    return {
      name: src.name,
      step: async (timeoutMs): Promise<ScanOutcome> => {
        let file = src.file;
        if (opts.posix) {
          const found = await findPosixCommand(src.file, env, deps.isExecutable);
          if (!found) { return { status: 'missing', source: src.name }; }
          file = found;
        }
        const r = await deps.run(file, src.args, {
          timeoutMs: Math.min(src.timeoutMs, timeoutMs),
          signal,
          encoding: opts.encoding,
          env: opts.posix ? posixEnv : undefined,
        });
        return commandOutcome(src.name, r, recognise, (t) => parse(t), opts.emptyExit1IsOk);
      },
    };
  };

  const procStep: { name: string; step: Step } = {
    name: SOURCE_NAMES.procNetTcp,
    step: async (timeoutMs): Promise<ScanOutcome> => {
      const source = SOURCE_NAMES.procNetTcp;
      const start = deps.now();
      const t = Math.min(SOURCE_TIMEOUT_MS.procNetTcp, timeoutMs);
      const v4 = await deps.read('/proc/net/tcp', { timeoutMs: t, signal });
      if (v4.kind !== 'ok') { return readOutcome(source, v4); }
      if (!recogniseProcNetTcp(v4.text)) { return { status: 'unrecognised', source, detail: '/proc/net/tcp not understood' }; }
      const ports = parseProcNetTcp(v4.text, false, endianness, source);
      const v6 = await deps.read('/proc/net/tcp6', { timeoutMs: Math.max(1, t - (deps.now() - start)), signal });
      if (v6.kind === 'missing') { return { status: 'ok', source, ports }; }  // IPv6 turned off: no IPv6 rows
      if (v6.kind !== 'ok') { return readOutcome(source, v6, '/proc/net/tcp6'); }
      if (!recogniseProcNetTcp(v6.text)) { return { status: 'unrecognised', source, detail: '/proc/net/tcp6 not understood' }; }
      return { status: 'ok', source, ports: [...ports, ...parseProcNetTcp(v6.text, true, endianness, source)] };
    },
  };

  const steps: Array<{ name: string; step: Step }> = [];
  if (platform === 'win32') {
    steps.push(command('winNetstat', recogniseWinNetstat, (t) => parseWinNetstat(t), { posix: false, encoding: 'latin1' }));
    if (options.powershell) {
      steps.push(command('powershell', recogniseWinNetTcpJson, (t) => parseWinNetTcpJson(t), { posix: false, encoding: 'utf8' }));
    }
  } else if (platform === 'darwin') {
    steps.push(command('macNetstat', recogniseMacNetstat, (t) => parseMacNetstat(t), { posix: true, encoding: 'utf8' }));
    steps.push(command('lsof', recogniseLsofF, (t) => parseLsofF(t), { posix: true, encoding: 'utf8', emptyExit1IsOk: true }));
  } else {
    steps.push(procStep);
    steps.push(command('ss', recogniseSs, (t) => parseSs(t), { posix: true, encoding: 'utf8' }));
  }

  const attempts: LocalScanReport['attempts'] = [];
  const started = deps.now();
  const report = (status: LocalScanStatus, source?: string): LocalScanReport =>
    ({ status, ...(source !== undefined ? { source } : {}), attempts, vcFilter: 'off', sweep: false });

  for (const { name, step } of steps) {
    if (signal?.aborted) {
      attempts.push({ source: name, status: 'skipped', detail: 'cancelled' });
      return { ports: [], report: report('skipped', name) };
    }
    const left = budget - (deps.now() - started);
    if (left <= 0) {
      attempts.push({ source: name, status: 'timeout', detail: 'local scan time budget used up' });
      continue;
    }
    const outcome = await step(left);
    if (outcome.status === 'skipped' || signal?.aborted) {
      attempts.push({ source: name, status: 'skipped', detail: 'cancelled' });
      return { ports: [], report: report('skipped', name) };
    }
    const detail = 'detail' in outcome ? outcome.detail : undefined;
    attempts.push(detail !== undefined ? { source: name, status: outcome.status, detail } : { source: name, status: outcome.status });
    if (outcome.status === 'ok') {
      Logger.info(`local scan: ${name} listed ${outcome.ports.length} listening socket(s)`);
      return { ports: outcome.ports, report: report('ok', name) };
    }
    Logger.info(`local scan: ${name} ${outcome.status}${detail ? ` (${detail})` : ''}`);
  }
  const last = attempts[attempts.length - 1];
  return { ports: [], report: last ? report(last.status, last.source) : report('skipped') };
}

function readOutcome(source: string, r: Exclude<ReadResult, { kind: 'ok' }>, file?: string): ScanOutcome {
  const where = file ? `${file}: ` : '';
  switch (r.kind) {
    case 'missing': return file ? { status: 'failed', source, detail: `${where}missing` } : { status: 'missing', source };
    case 'timeout': return { status: 'timeout', source };
    case 'aborted': return { status: 'skipped', source };
    case 'failed': return { status: 'failed', source, code: r.code, detail: `${where}${r.detail}` };
  }
}

/** The report for a run with `local: false`. */
export function skippedLocalScan(): LocalListeners {
  return { ports: [], report: { status: 'skipped', attempts: [], vcFilter: 'off', sweep: false } };
}
