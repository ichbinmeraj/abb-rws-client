import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseWinNetstat, recogniseWinNetstat,
  parseWinNetTcpJson, recogniseWinNetTcpJson,
  parseProcNetTcp, recogniseProcNetTcp,
  parseSs, recogniseSs,
  parseMacNetstat, recogniseMacNetstat,
  parseLsofF, recogniseLsofF,
  chooseLocalAddress, selectLocalTargets, DENIED_LOCAL_PORTS,
  localListeners, skippedLocalScan, runCommand, readTextFile, findPosixCommand,
  windowsSystemRoot, commandSources, SOURCE_TIMEOUT_MS,
  type CommandResult, type ReadResult, type ScanDeps, type RunCommandOptions,
} from '../../src/discovery/listeningPorts.js';
import type { ListeningPort } from '../../src/discovery/types.js';

const FIX = new URL('../fixtures/listening-ports/', import.meta.url);
const fixture = (name: string, enc: BufferEncoding = 'utf8'): string => fs.readFileSync(new URL(name, FIX)).toString(enc);

const VC_PIDS = new Set([2101, 2102, 2103, 2104, 2105]);
const RWS_PORTS = [80, 5466, 9403, 9805, 39127];
const VC_PORTS = [80, 5466, 9403, 9805, 39127, 53159, 55194, 57317, 59539, 59722];

const binds = (rows: ListeningPort[], port: number): string[] => rows.filter((r) => r.port === port).map((r) => r.bind).sort();
const ports = (rows: ListeningPort[]): number[] => [...new Set(rows.map((r) => r.port))].sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('parseWinNetstat (captured, en-US)', () => {
  const text = fixture('win-netstat-ano.txt', 'latin1');
  const rows = parseWinNetstat(text);

  it('recognises the capture and keeps its CRLF and leading blank line', () => {
    expect(text.startsWith('\r\nActive Connections\r\n')).toBe(true);
    expect(recogniseWinNetstat(text)).toBe(true);
  });

  it('lists every controller port on both 0.0.0.0 and ::, with the owning PID', () => {
    for (const p of RWS_PORTS) { expect(binds(rows, p)).toEqual(['0.0.0.0', '::']); }
    expect(rows.find((r) => r.port === 39127)?.pid).toBe(2105);
    expect(rows.every((r) => r.source === 'netstat -ano')).toBe(true);
  });

  it('keeps the LAN-only and ::1-only binds as printed, and skips connections and UDP', () => {
    expect(binds(rows, 139)).toEqual(['192.0.2.10']);
    expect(rows.find((r) => r.port === 42050)).toEqual({ port: 42050, bind: '::1', pid: 3001, source: 'netstat -ano' });
    expect(rows.some((r) => r.port === 80 && r.bind === '127.0.0.1')).toBe(false); // ESTABLISHED 127.0.0.1:80
    expect(rows.some((r) => r.port === 56573)).toBe(false);                        // UDP
    expect(ports(rows)).toEqual([80, 135, 139, 445, 5466, 9403, 9805, 39127, 42050, 53159, 55194, 57317, 59539, 59722]);
  });

  it('-p TCP lists IPv4 only: the ::1-only row exists only in the -ano capture', () => {
    const v4 = parseWinNetstat(fixture('win-netstat-ano-p-tcp.txt', 'latin1'));
    expect(v4.some((r) => r.bind.includes(':'))).toBe(false);
    expect(v4.some((r) => r.port === 42050)).toBe(false);
    expect(rows.some((r) => r.port === 42050)).toBe(true);
  });

  it('does not recognise output without a TCP row', () => {
    expect(recogniseWinNetstat('')).toBe(false);
    expect(recogniseWinNetstat('not netstat output at all')).toBe(false);
    expect(recogniseWinNetstat('\r\nActive Connections\r\n\r\n  Proto  Local Address  Foreign Address  State  PID\r\n')).toBe(false);
  });
});

describe('parseWinNetstat (German, OEM code page bytes)', () => {
  it('finds the same listeners whatever the state word or its encoding', () => {
    for (const enc of ['latin1', 'utf8'] as const) {
      const text = fixture('win-netstat-ano-de-cp850.txt', enc);
      expect(recogniseWinNetstat(text)).toBe(true);
      const rows = parseWinNetstat(text);
      expect(ports(rows)).toEqual([135, 5466, 14880, 62214]);
      expect(binds(rows, 5466)).toEqual(['0.0.0.0', '::']);
    }
    // The raw 0x99 byte is really there (no UTF-8 Ö).
    expect(fs.readFileSync(new URL('win-netstat-ano-de-cp850.txt', FIX)).includes(Buffer.from([0x48, 0x99, 0x52]))).toBe(true);
  });
});

describe('parseWinNetTcpJson (captured)', () => {
  const text = fixture('win-get-nettcpconnection-listen.json');
  const rows = parseWinNetTcpJson(text);

  it('reads the array, and lists dual-stack controller ports only as ::', () => {
    expect(recogniseWinNetTcpJson(text)).toBe(true);
    for (const p of RWS_PORTS) { expect(binds(rows, p)).toEqual(['::']); }
    expect(binds(rows, 53159)).toEqual(['0.0.0.0']);
    expect(rows.find((r) => r.port === 9805)).toEqual({ port: 9805, bind: '::', pid: 2104, source: 'Get-NetTCPConnection' });
  });

  it('reads a single object and a leading BOM', () => {
    const one = '\uFEFF{"LocalAddress":"0.0.0.0","LocalPort":5466,"OwningProcess":7}';
    expect(recogniseWinNetTcpJson(one)).toBe(true);
    expect(parseWinNetTcpJson(one)).toEqual([{ port: 5466, bind: '0.0.0.0', pid: 7, source: 'Get-NetTCPConnection' }]);
  });

  it('does not recognise empty, non-JSON or foreign JSON', () => {
    for (const t of ['', '[]', 'garbage', '{"a":1}', 'null', '42']) { expect(recogniseWinNetTcpJson(t)).toBe(false); }
  });
});

describe('parseProcNetTcp (derived from the kernel print format)', () => {
  it('decodes little-endian IPv4 rows and keeps state 0A only', () => {
    const text = fixture('proc-net-tcp.txt');
    expect(recogniseProcNetTcp(text)).toBe(true);
    expect(parseProcNetTcp(text, false, 'LE').map((r) => [r.bind, r.port])).toEqual([
      ['127.0.0.1', 5474], ['0.0.0.0', 22], ['127.0.0.53', 53],
    ]);
  });

  it('decodes big-endian IPv4 rows', () => {
    const text = '  sl  local_address rem_address   st\n   0: 7F000001:264D 00000000:0000 0A 00000000:00000000\n';
    expect(parseProcNetTcp(text, false, 'BE')).toEqual([{ port: 9805, bind: '127.0.0.1', source: '/proc/net/tcp' }]);
  });

  it('decodes tcp6 words: ::, ::1 and v4-mapped', () => {
    const text = fixture('proc-net-tcp6.txt');
    expect(recogniseProcNetTcp(text)).toBe(true);
    expect(parseProcNetTcp(text, true, 'LE').map((r) => [r.bind, r.port])).toEqual([
      ['::', 22], ['::1', 631], ['::ffff:127.0.0.1', 9403],
    ]);
  });

  it('a header with no rows is a valid empty answer; anything else is not understood', () => {
    expect(recogniseProcNetTcp('  sl  local_address rem_address   st tx_queue\n')).toBe(true);
    expect(parseProcNetTcp('  sl  local_address rem_address   st tx_queue\n', false)).toEqual([]);
    expect(recogniseProcNetTcp('')).toBe(false);
    expect(recogniseProcNetTcp('hello\n')).toBe(false);
  });
});

describe('parseSs', () => {
  it('modern rows (documented + derived): %ifname, 0.0.0.0, [::], *, v4-mapped, [::1]', () => {
    const text = fixture('ss-modern.txt');
    expect(recogniseSs(text)).toBe(true);
    expect(parseSs(text).map((r) => [r.bind, r.port])).toEqual([
      ['127.0.0.53', 53], ['0.0.0.0', 22], ['::', 22], ['*', 9805], ['::ffff:127.0.0.1', 9403], ['::1', 631],
    ]);
  });

  it('an interface after a bracketed IPv6 address ([addr]%ifname:port) is stripped, not dropped', () => {
    const text = [
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
      'LISTEN 0      4096       [::]%eth0:5466          [::]:*',
      'LISTEN 0      128    [fe80::1]%eth0:22           [::]:*',
      'LISTEN 0      128    [fe80::2%eth1]:23           [::]:*',
      'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
      '',
    ].join('\n');
    expect(parseSs(text).map((r) => [r.bind, r.port])).toEqual([
      ['::', 5466], ['fe80::1', 22], ['fe80::2', 23], ['127.0.0.53', 53],
    ]);
  });

  it('old rows (iproute2 up to v4.12): *, :::p, ::ffff:a.b.c.d:p, ::1:p', () => {
    const text = fixture('ss-old.txt');
    expect(recogniseSs(text)).toBe(true);
    expect(parseSs(text).map((r) => [r.bind, r.port])).toEqual([
      ['*', 22], ['::', 22], ['::ffff:127.0.0.1', 9403], ['::1', 631],
    ]);
  });

  it('keeps LISTEN rows only when a State column exists, and tcp rows only under Netid', () => {
    const text = fixture('ss-netid-estab.txt');
    expect(recogniseSs(text)).toBe(true);
    expect(parseSs(text)).toEqual([{ port: 22, bind: '*', source: 'ss -ltn' }]);
    expect(parseSs('Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port\nudp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:*\n')).toEqual([]);
  });

  it('reads iproute2 2.6.39 output with no State column', () => {
    const text = fixture('ss-no-state.txt');
    expect(recogniseSs(text)).toBe(true);
    expect(parseSs(text)).toEqual([{ port: 28090, bind: '*', source: 'ss -ltn' }]);
  });

  it('recognises headerless rows, and nothing else', () => {
    expect(recogniseSs('LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n')).toBe(true);
    expect(recogniseSs('')).toBe(false);
    expect(recogniseSs('Segmentation fault\n')).toBe(false);
  });
});

describe('parseMacNetstat (derived from Apple netstat source)', () => {
  it('splits host.port at the last dot and keeps LISTEN rows', () => {
    const text = fixture('macos-netstat.txt');
    expect(recogniseMacNetstat(text)).toBe(true);
    expect(parseMacNetstat(text).map((r) => [r.bind, r.port])).toEqual([
      ['*', 80], ['::', 88], ['0.0.0.0', 9403], ['127.0.0.1', 631], ['::1', 631], ['fe80::1', 5000],
    ]);
  });

  it('does not recognise output without the header', () => {
    expect(recogniseMacNetstat('')).toBe(false);
    expect(recogniseMacNetstat('tcp4 0 0 *.80 *.* LISTEN')).toBe(false);
  });
});

describe('parseLsofF (derived from the lsof manual)', () => {
  it('reads p/f/t/n fields; *:p takes its family from t', () => {
    const text = fixture('macos-lsof-F.txt');
    expect(recogniseLsofF(text)).toBe(true);
    expect(parseLsofF(text).map((r) => [r.pid, r.bind, r.port])).toEqual([
      [4821, '127.0.0.1', 3000], [1, '::', 22], [1, '0.0.0.0', 22], [733, '::1', 7000],
    ]);
  });

  it('does not recognise the column format', () => {
    expect(recogniseLsofF('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n')).toBe(false);
    expect(recogniseLsofF('')).toBe(true); // nothing listening is a valid answer
  });
});

// ---------------------------------------------------------------------------
// Which address, which ports
// ---------------------------------------------------------------------------

const row = (bind: string, port = 5466, pid?: number): ListeningPort => ({ port, bind, pid, source: 't' });

describe('chooseLocalAddress', () => {
  it('a wildcard bind gives 127.0.0.1', () => {
    expect(chooseLocalAddress([row('0.0.0.0'), row('::')])).toEqual({ host: '127.0.0.1', retryOnIpv6Loopback: false });
    expect(chooseLocalAddress([row('*')])).toEqual({ host: '127.0.0.1', retryOnIpv6Loopback: false });
  });

  it(':: alone (as Get-NetTCPConnection shows dual-stack sockets) gives 127.0.0.1 first, ::1 only after a refusal', () => {
    expect(chooseLocalAddress([row('::')])).toEqual({ host: '127.0.0.1', retryOnIpv6Loopback: true });
  });

  it('a v4-mapped bind gives 127.0.0.1', () => {
    expect(chooseLocalAddress([row('::ffff:127.0.0.1')])).toEqual({ host: '127.0.0.1', retryOnIpv6Loopback: false });
    expect(chooseLocalAddress([row('::ffff:0.0.0.0')])).toEqual({ host: '127.0.0.1', retryOnIpv6Loopback: false });
  });

  it('another loopback address is probed exactly', () => {
    expect(chooseLocalAddress([row('127.0.0.53')])).toEqual({ host: '127.0.0.53', retryOnIpv6Loopback: false });
  });

  it('::1 alone is skipped unless a virtual-controller process owns it', () => {
    expect(chooseLocalAddress([row('::1', 5466, 7)])).toBeUndefined();
    expect(chooseLocalAddress([row('::1', 5466, 7)], new Set([8]))).toBeUndefined();
    expect(chooseLocalAddress([row('::1', 5466, 7)], new Set([7]))).toEqual({ host: '::1', retryOnIpv6Loopback: false });
  });

  it('a LAN or link-local bind of this PC is never probed', () => {
    expect(chooseLocalAddress([row('192.0.2.10')])).toBeUndefined();
    expect(chooseLocalAddress([row('fe80::1')])).toBeUndefined();
  });
});

describe('selectLocalTargets', () => {
  const netstat = parseWinNetstat(fixture('win-netstat-ano.txt', 'latin1'));

  it('filtered to virtual-controller PIDs: the five RWS ports and the five second ports, on 127.0.0.1', () => {
    const t = selectLocalTargets(netstat, { vcPids: VC_PIDS, filterToVc: true });
    expect(t.map((x) => x.port)).toEqual(VC_PORTS);
    expect(t.every((x) => x.host === '127.0.0.1' && !x.retryOnIpv6Loopback)).toBe(true);
    expect(t.find((x) => x.port === 39127)?.pid).toBe(2105);
  });

  it('unfiltered: every loopback-reachable listener, never the LAN-only or ::1-only one', () => {
    const t = selectLocalTargets(netstat);
    expect(t.map((x) => x.port)).toEqual([80, 135, 445, 5466, 9403, 9805, 39127, 53159, 55194, 57317, 59539, 59722]);
  });

  it('filterToVc without known PIDs (lookup failed) runs unfiltered', () => {
    expect(selectLocalTargets(netstat, { filterToVc: true })).toEqual(selectLocalTargets(netstat));
  });

  it('Get-NetTCPConnection rows: RWS ports retry on ::1 after a refusal, second ports do not', () => {
    const t = selectLocalTargets(parseWinNetTcpJson(fixture('win-get-nettcpconnection-listen.json')), { vcPids: VC_PIDS, filterToVc: true });
    expect(t.map((x) => x.port)).toEqual(VC_PORTS);
    for (const x of t) { expect(x.retryOnIpv6Loopback).toBe(RWS_PORTS.includes(x.port)); }
  });

  it('a ::1-only port of a VC process is probed on ::1', () => {
    const t = selectLocalTargets(netstat, { vcPids: new Set([...VC_PIDS, 3001]), filterToVc: true });
    expect(t.find((x) => x.port === 42050)).toEqual({ host: '::1', port: 42050, pid: 3001, retryOnIpv6Loopback: false });
  });

  it('the deny-list applies unfiltered, not to VC-owned ports', () => {
    const rows = [...DENIED_LOCAL_PORTS.keys()].map((p) => row('0.0.0.0', p, 2101));
    expect(selectLocalTargets(rows)).toEqual([]);
    expect(selectLocalTargets(rows, { vcPids: VC_PIDS, filterToVc: true })).toHaveLength(DENIED_LOCAL_PORTS.size);
  });

  it('every deny-listed port names its owner', () => {
    expect([...DENIED_LOCAL_PORTS.keys()].sort((a, b) => a - b)).toEqual([102, 502, 1217, 2222, 2404, 4840, 9100, 11740, 20000, 44818]);
    for (const owner of DENIED_LOCAL_PORTS.values()) { expect(owner.length).toBeGreaterThan(5); }
  });
});

// ---------------------------------------------------------------------------
// Running the sources (fake I/O)
// ---------------------------------------------------------------------------

interface Call { file: string; args: string[]; opts: RunCommandOptions }

function fakeDeps(
  run: (file: string, args: string[]) => CommandResult | Promise<CommandResult>,
  read: Record<string, ReadResult> = {},
  executables: string[] = ['/usr/sbin/ss', '/usr/sbin/netstat', '/usr/sbin/lsof'],
): { deps: Partial<ScanDeps>; calls: Call[]; reads: string[] } {
  const calls: Call[] = [];
  const reads: string[] = [];
  return {
    calls,
    reads,
    deps: {
      run: async (file, args, opts) => { calls.push({ file, args, opts }); return run(file, args); },
      read: async (file) => { reads.push(file); return read[file] ?? { kind: 'missing' }; },
      isExecutable: async (file) => executables.includes(file),
    },
  };
}

const WIN_ENV = { SystemRoot: 'D:\\Win' };

describe('localListeners on Windows', () => {
  it('runs %SystemRoot%\\System32\\netstat.exe -ano with a timeout, hidden, decoding bytes as latin1', async () => {
    const f = fakeDeps(() => ({ kind: 'ok', stdout: fixture('win-netstat-ano.txt', 'latin1') }));
    const r = await localListeners({ platform: 'win32', env: WIN_ENV, deps: f.deps });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].file).toBe('D:\\Win\\System32\\netstat.exe');
    expect(f.calls[0].args).toEqual(['-ano']);
    expect(f.calls[0].opts).toMatchObject({ timeoutMs: SOURCE_TIMEOUT_MS.winNetstat, encoding: 'latin1' });
    expect(r.report).toEqual({ status: 'ok', source: 'netstat -ano', attempts: [{ source: 'netstat -ano', status: 'ok' }], vcFilter: 'off', sweep: false });
    expect(r.ports.length).toBeGreaterThan(20);
  });

  it('netstat missing and PowerShell not enabled: no second source', async () => {
    const f = fakeDeps(() => ({ kind: 'missing' }));
    const r = await localListeners({ platform: 'win32', env: WIN_ENV, deps: f.deps });
    expect(f.calls).toHaveLength(1);
    expect(r.ports).toEqual([]);
    expect(r.report.status).toBe('missing');
    expect(r.report.attempts).toEqual([{ source: 'netstat -ano', status: 'missing' }]);
  });

  it('netstat unrecognised and PowerShell enabled: Get-NetTCPConnection answers', async () => {
    const json = fixture('win-get-nettcpconnection-listen.json');
    const f = fakeDeps((file) => (file.endsWith('netstat.exe') ? { kind: 'ok', stdout: 'Zugriff verweigert' } : { kind: 'ok', stdout: json }));
    const r = await localListeners({ platform: 'win32', env: WIN_ENV, powershell: true, deps: f.deps });
    expect(f.calls.map((c) => c.file)).toEqual(['D:\\Win\\System32\\netstat.exe', 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
    expect(f.calls[1].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(f.calls[1].opts.timeoutMs).toBe(SOURCE_TIMEOUT_MS.powershell);
    expect(r.report.status).toBe('ok');
    expect(r.report.source).toBe('Get-NetTCPConnection');
    expect(r.report.attempts.map((a) => a.status)).toEqual(['unrecognised', 'ok']);
    expect(binds(r.ports, 9805)).toEqual(['::']);
  });

  it('exit code, our timeout and a foreign signal are failed / timeout / failed', async () => {
    for (const [res, status] of [
      [{ kind: 'exit', code: 1, stdout: '' }, 'failed'],
      [{ kind: 'timeout' }, 'timeout'],
      [{ kind: 'failed', signal: 'SIGSEGV', detail: 'ended by signal SIGSEGV' }, 'failed'],
      [{ kind: 'failed', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', detail: 'output larger than the 16 MiB limit' }, 'failed'],
    ] as Array<[CommandResult, string]>) {
      const f = fakeDeps(() => res);
      const r = await localListeners({ platform: 'win32', env: WIN_ENV, deps: f.deps });
      expect(r.report.status).toBe(status);
    }
  });

  it('SystemRoot falls back to windir, then C:\\Windows', () => {
    expect(windowsSystemRoot({ windir: 'E:\\W' })).toBe('E:\\W');
    expect(windowsSystemRoot({})).toBe('C:\\Windows');
    expect(commandSources('win32', {}).winNetstat.file).toBe('C:\\Windows\\System32\\netstat.exe');
  });
});

describe('localListeners on Linux', () => {
  const tcp = fixture('proc-net-tcp.txt');
  const tcp6 = fixture('proc-net-tcp6.txt');

  it('reads /proc/net/tcp and tcp6 without starting a process', async () => {
    const f = fakeDeps(() => { throw new Error('no process expected'); }, {
      '/proc/net/tcp': { kind: 'ok', text: tcp }, '/proc/net/tcp6': { kind: 'ok', text: tcp6 },
    });
    const r = await localListeners({ platform: 'linux', endianness: 'LE', deps: f.deps });
    expect(f.calls).toHaveLength(0);
    expect(f.reads).toEqual(['/proc/net/tcp', '/proc/net/tcp6']);
    expect(r.report).toMatchObject({ status: 'ok', source: '/proc/net/tcp' });
    expect(r.ports.map((p) => [p.bind, p.port])).toEqual([
      ['127.0.0.1', 5474], ['0.0.0.0', 22], ['127.0.0.53', 53], ['::', 22], ['::1', 631], ['::ffff:127.0.0.1', 9403],
    ]);
  });

  it('tcp6 missing (IPv6 off) keeps the IPv4 rows', async () => {
    const f = fakeDeps(() => { throw new Error('no process expected'); }, { '/proc/net/tcp': { kind: 'ok', text: tcp } });
    const r = await localListeners({ platform: 'linux', endianness: 'LE', deps: f.deps });
    expect(r.report.status).toBe('ok');
    expect(r.ports).toHaveLength(3);
  });

  it('a valid empty answer is ok and starts no fallback', async () => {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    const f = fakeDeps(() => { throw new Error('no fallback expected'); }, {
      '/proc/net/tcp': { kind: 'ok', text: header }, '/proc/net/tcp6': { kind: 'ok', text: header },
    });
    const r = await localListeners({ platform: 'linux', deps: f.deps });
    expect(r).toEqual({ ports: [], report: { status: 'ok', source: '/proc/net/tcp', attempts: [{ source: '/proc/net/tcp', status: 'ok' }], vcFilter: 'off', sweep: false } });
    expect(f.calls).toHaveLength(0);
  });

  it('/proc missing: ss -ltn from /usr/sbin, in the C locale', async () => {
    const f = fakeDeps(() => ({ kind: 'ok', stdout: fixture('ss-modern.txt') }));
    const r = await localListeners({ platform: 'linux', env: { PATH: '/usr/bin' }, deps: f.deps });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].file).toBe('/usr/sbin/ss');
    expect(f.calls[0].args).toEqual(['-ltn']);
    expect(f.calls[0].opts.env?.LC_ALL).toBe('C');
    expect(r.report.attempts).toEqual([{ source: '/proc/net/tcp', status: 'missing' }, { source: 'ss -ltn', status: 'ok' }]);
    expect(r.report.source).toBe('ss -ltn');
  });

  it('tcp6 read error fails the /proc source, and ss runs', async () => {
    const f = fakeDeps(() => ({ kind: 'ok', stdout: fixture('ss-old.txt') }), {
      '/proc/net/tcp': { kind: 'ok', text: tcp }, '/proc/net/tcp6': { kind: 'failed', code: 'EIO', detail: 'EIO' },
    });
    const r = await localListeners({ platform: 'linux', deps: f.deps });
    expect(r.report.attempts.map((a) => a.status)).toEqual(['failed', 'ok']);
    expect(r.report.attempts[0].detail).toContain('/proc/net/tcp6');
  });

  it('ss nowhere to be found is missing, without starting anything', async () => {
    const f = fakeDeps(() => { throw new Error('no process expected'); }, {}, []);
    const r = await localListeners({ platform: 'linux', env: { PATH: '/opt/bin' }, deps: f.deps });
    expect(r.report.status).toBe('missing');
    expect(r.report.source).toBe('ss -ltn');
    expect(f.calls).toHaveLength(0);
  });

  it('ss crashing on a signal is failed, not an empty list', async () => {
    const f = fakeDeps(() => ({ kind: 'failed', signal: 'SIGSEGV', detail: 'ended by signal SIGSEGV' }));
    const r = await localListeners({ platform: 'linux', deps: f.deps });
    expect(r.report.status).toBe('failed');
    expect(r.report.attempts[1]).toEqual({ source: 'ss -ltn', status: 'failed', detail: 'ended by signal SIGSEGV' });
  });
});

describe('localListeners on macOS', () => {
  it('netstat -an -p tcp first', async () => {
    const f = fakeDeps(() => ({ kind: 'ok', stdout: fixture('macos-netstat.txt') }));
    const r = await localListeners({ platform: 'darwin', env: {}, deps: f.deps });
    expect(f.calls[0].file).toBe('/usr/sbin/netstat');
    expect(f.calls[0].args).toEqual(['-an', '-p', 'tcp']);
    expect(r.report.source).toBe('netstat -an -p tcp');
    expect(r.ports).toHaveLength(6);
  });

  it('netstat fails, lsof exit 1 with empty output is ok (nothing matched)', async () => {
    const f = fakeDeps((file) => (file.endsWith('netstat') ? { kind: 'exit', code: 1, stdout: '' } : { kind: 'exit', code: 1, stdout: '' }));
    const r = await localListeners({ platform: 'darwin', env: {}, deps: f.deps });
    expect(f.calls[1].file).toBe('/usr/sbin/lsof');
    expect(f.calls[1].args).toEqual(['-nP', '-b', '-w', '-iTCP', '-sTCP:LISTEN', '-Fptn']);
    expect(r.report.attempts).toEqual([
      { source: 'netstat -an -p tcp', status: 'failed', detail: 'exit code 1' },
      { source: 'lsof -iTCP -sTCP:LISTEN', status: 'ok' },
    ]);
    expect(r.ports).toEqual([]);
  });

  it('lsof exit 1 with output, or another exit code, is failed', async () => {
    for (const res of [{ kind: 'exit', code: 1, stdout: 'lsof: WARNING' }, { kind: 'exit', code: 2, stdout: '' }] as CommandResult[]) {
      const f = fakeDeps((file) => (file.endsWith('netstat') ? { kind: 'missing' } : res));
      const r = await localListeners({ platform: 'darwin', env: {}, deps: f.deps });
      expect(r.report.status).toBe('failed');
    }
  });
});

describe('localListeners: cancel and time budget', () => {
  it('an aborted signal starts nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const f = fakeDeps(() => ({ kind: 'ok', stdout: '' }));
    const r = await localListeners({ platform: 'win32', env: WIN_ENV, signal: ac.signal, powershell: true, deps: f.deps });
    expect(f.calls).toHaveLength(0);
    expect(r.report).toMatchObject({ status: 'skipped', attempts: [{ source: 'netstat -ano', status: 'skipped', detail: 'cancelled' }] });
  });

  it('a cancel during a source stops the scan: no fallback starts', async () => {
    const ac = new AbortController();
    const f = fakeDeps(() => { ac.abort(); return { kind: 'aborted' }; });
    const r = await localListeners({ platform: 'win32', env: WIN_ENV, signal: ac.signal, powershell: true, deps: f.deps });
    expect(f.calls).toHaveLength(1);
    expect(r.ports).toEqual([]);
    expect(r.report.attempts).toEqual([{ source: 'netstat -ano', status: 'skipped', detail: 'cancelled' }]);
  });

  it('the signal is passed to the command', async () => {
    const ac = new AbortController();
    const f = fakeDeps(() => ({ kind: 'ok', stdout: fixture('win-netstat-ano.txt', 'latin1') }));
    await localListeners({ platform: 'win32', env: WIN_ENV, signal: ac.signal, deps: f.deps });
    expect(f.calls[0].opts.signal).toBe(ac.signal);
  });

  it('later sources get only what is left of the budget, and none once it is used up', async () => {
    let now = 0;
    const f = fakeDeps(() => { now += 9_000; return { kind: 'timeout' }; });
    const r = await localListeners({ platform: 'win32', env: WIN_ENV, powershell: true, budgetMs: 12_000, deps: { ...f.deps, now: () => now } });
    expect(f.calls.map((c) => c.opts.timeoutMs)).toEqual([5_000, 3_000]);
    expect(r.report.status).toBe('timeout');

    now = 0;
    const g = fakeDeps(() => { now += 13_000; return { kind: 'timeout' }; });
    const r2 = await localListeners({ platform: 'win32', env: WIN_ENV, powershell: true, budgetMs: 12_000, deps: { ...g.deps, now: () => now } });
    expect(g.calls).toHaveLength(1);
    expect(r2.report.attempts[1]).toEqual({ source: 'Get-NetTCPConnection', status: 'timeout', detail: 'local scan time budget used up' });
  });

  it('skippedLocalScan reports local: false', () => {
    expect(skippedLocalScan()).toEqual({ ports: [], report: { status: 'skipped', attempts: [], vcFilter: 'off', sweep: false } });
  });
});

describe('findPosixCommand', () => {
  it('fixed directories first, then absolute PATH entries', async () => {
    const seen: string[] = [];
    const exe = async (f: string): Promise<boolean> => { seen.push(f); return f === '/opt/x/ss'; };
    await expect(findPosixCommand('ss', { PATH: 'relative:/opt/x:/usr/bin' }, exe)).resolves.toBe('/opt/x/ss');
    expect(seen).toEqual(['/usr/sbin/ss', '/usr/bin/ss', '/sbin/ss', '/bin/ss', '/opt/x/ss']);
  });
});

// ---------------------------------------------------------------------------
// Real child processes and files (this PC only; nothing touches the network)
// ---------------------------------------------------------------------------

describe('runCommand (real child processes)', () => {
  const node = process.execPath;
  const base = { timeoutMs: 10_000, encoding: 'utf8' as const };

  it('ok with stdout', async () => {
    await expect(runCommand(node, ['-e', 'process.stdout.write("hi")'], base)).resolves.toEqual({ kind: 'ok', stdout: 'hi' });
  });

  it('a non-zero exit keeps its output', async () => {
    await expect(runCommand(node, ['-e', 'process.stdout.write("x"); process.exit(3)'], base)).resolves.toEqual({ kind: 'exit', code: 3, stdout: 'x' });
  });

  it('ENOENT is missing', async () => {
    await expect(runCommand(path.join(os.tmpdir(), 'no-such-dir-xyz', 'no-such.exe'), [], base)).resolves.toEqual({ kind: 'missing' });
  });

  it('our timeout is timeout', async () => {
    await expect(runCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], { ...base, timeoutMs: 300 })).resolves.toEqual({ kind: 'timeout' });
  });

  it('too much output is failed', async () => {
    const r = await runCommand(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { ...base, maxBuffer: 100 });
    expect(r).toMatchObject({ kind: 'failed', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  });

  it('a cancel is aborted', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await expect(runCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], { ...base, signal: ac.signal })).resolves.toEqual({ kind: 'aborted' });
  });

  it.skipIf(process.platform === 'win32')('a signal we did not send is failed', async () => {
    const r = await runCommand(node, ['-e', 'process.kill(process.pid, "SIGKILL")'], base);
    expect(r).toMatchObject({ kind: 'failed', signal: 'SIGKILL' });
  });
});

describe('readTextFile', () => {
  it('reads, reports missing, and refuses oversize files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
    const file = path.join(dir, 'tcp');
    fs.writeFileSync(file, 'hello');
    try {
      await expect(readTextFile(file, { timeoutMs: 3000 })).resolves.toEqual({ kind: 'ok', text: 'hello' });
      await expect(readTextFile(path.join(dir, 'none'), { timeoutMs: 3000 })).resolves.toEqual({ kind: 'missing' });
      await expect(readTextFile(file, { timeoutMs: 3000, maxBytes: 2 })).resolves.toMatchObject({ kind: 'failed' });
      const ac = new AbortController();
      ac.abort();
      await expect(readTextFile(file, { timeoutMs: 3000, signal: ac.signal })).resolves.toEqual({ kind: 'aborted' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

