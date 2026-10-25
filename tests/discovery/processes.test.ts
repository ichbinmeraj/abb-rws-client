import { describe, it, expect } from 'vitest';
import {
  classifyRunError, cimCommandLineScript, isVcImage, parseCimProcessJson, parseRsmetaXml,
  parseSystemDir, parseSystemXml, parseTasklistCsv, pidImages, powershellPath, processCommandLines,
  readVcSystemFolder, tasklistPath, vcImageOf, vcProcessDetails,
  type ExecFileFn, type ReadFileFn,
} from '../../src/discovery/processes.js';

/*
 * Shapes follow what Windows 11 and RobotStudio VCs printed on 2026-10-03 (tasklist CSV, the CIM
 * JSON, a Vrchost64.exe command line, system.xml and rsmeta.xml of an RW 8.2.1+1023 VC). Every
 * value here is synthetic: PIDs, folder names, system names and the host name.
 */

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"RobVC.exe","4100","Console","1","45,120 K"',
  '"Vrchost64.exe","4200","Console","1","1,234,560 K"',
  '"robvc.exe","4300","Console","1","40,000 K"',
  '"notepad.exe","4400","Console","1","12,000 K"',
  '"weird ""quoted"".exe","4500","Console","1","1 K"',
  '',
].join('\r\n');

const VR_LINE = '"C:\\PROGRA~2\\COMMON~1\\ABB\\RobVCCommon\\Vrchost64.exe" -sp "C:\\VCs\\IRB1600_A" '
  + '-s27 "C:/RobotWare/RobotOS_21.0.1/S27.01/bin/s27.01.dll" -pr "C:/RobotWare" -pp "4100"';

const SYSTEM_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<SystemProperties>',
  '  <SystemName>IRB1600_A</SystemName>',
  '  <SerialNo>VIRTUAL_CONTROLLER</SerialNo>',
  '  <UsedMedia>',
  '    <Media path="C:/RobotWare/RobotOS_21.0.1" name="RobotOS" version="21.0.1+297" versionName="21.0.1"/>',
  '    <Media path="C:/RobotWare/RobotControl_8.2.1" name="RobotControl" version="8.2.1+1023" versionName="8.2.1"/>',
  '  </UsedMedia>',
  '</SystemProperties>',
].join('\r\n');

const RSMETA_XML = '\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n<RobotStudioData>\r\n'
  + '  <SystemPath>C:\\VCs\\IRB1600_A</SystemPath>\r\n  <HostName>HOST-A</HostName>\r\n</RobotStudioData>';

/** A fake execFile that records calls and answers from a table keyed by the program's base name. */
function fakeExec(answers: Record<string, string | Error>): { run: ExecFileFn; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: ExecFileFn = async (file, args) => {
    calls.push({ file, args });
    const base = file.split(/[\\/]/).pop()!.toLowerCase();
    const a = answers[base];
    if (a === undefined) { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); }
    if (a instanceof Error) { throw a; }
    return { stdout: a, stderr: '' };
  };
  return { run, calls };
}

const files = (table: Record<string, string>): { read: ReadFileFn; reads: string[] } => {
  const reads: string[] = [];
  const read: ReadFileFn = async f => {
    reads.push(f);
    const v = table[f];
    if (v === undefined) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
    return Buffer.from(v, 'utf8');
  };
  return { read, reads };
};

describe('processes: tasklist', () => {
  it('parses PID to image, canonicalising the virtual-controller images', () => {
    const map = parseTasklistCsv(TASKLIST)!;
    expect(map.get(4100)).toBe('RobVC.exe');
    expect(map.get(4200)).toBe('Vrchost64.exe');
    expect(map.get(4300)).toBe('RobVC.exe');
    expect(map.get(4400)).toBe('notepad.exe');
    expect(map.get(4500)).toBe('weird "quoted".exe');
    expect(map.has(0)).toBe(false);
  });

  it('is undefined for text that is not tasklist CSV, and empty for no output', () => {
    expect(parseTasklistCsv('INFO: something else\r\n')).toBeUndefined();
    expect(parseTasklistCsv('')?.size).toBe(0);
  });

  it('vcImageOf / isVcImage are case-insensitive', () => {
    expect(vcImageOf('VRCHOST64.EXE')).toBe('Vrchost64.exe');
    expect(isVcImage('robvc.exe')).toBe(true);
    expect(isVcImage('RobotStudio.exe')).toBe(false);
    expect(isVcImage(undefined)).toBe(false);
  });

  it('runs tasklist by absolute path with a timeout and no window', async () => {
    const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
    const run: ExecFileFn = async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: TASKLIST, stderr: '' }; };
    const r = await pidImages({ execFile: run, env: { SystemRoot: 'D:\\Win' } });
    expect(r.status).toBe('ok');
    expect(calls[0].file).toBe('D:\\Win\\System32\\tasklist.exe');
    expect(calls[0].args).toEqual(['/fo', 'csv', '/nh']);
    expect(calls[0].opts).toMatchObject({ timeout: 5000, windowsHide: true });
  });

  it('reports missing, timeout, failed, unrecognised and aborted without throwing', async () => {
    expect((await pidImages({ execFile: fakeExec({}).run })).status).toBe('missing');
    const timeout = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    expect((await pidImages({ execFile: fakeExec({ 'tasklist.exe': timeout }).run })).status).toBe('timeout');
    const exit = Object.assign(new Error('Command failed'), { code: 1 });
    expect(await pidImages({ execFile: fakeExec({ 'tasklist.exe': exit }).run })).toEqual({ status: 'failed', detail: 'exit code 1' });
    expect((await pidImages({ execFile: fakeExec({ 'tasklist.exe': 'garbage' }).run })).status).toBe('unrecognised');
    const ac = new AbortController(); ac.abort();
    const f = fakeExec({ 'tasklist.exe': TASKLIST });
    expect((await pidImages({ execFile: f.run, signal: ac.signal })).status).toBe('aborted');
    expect(f.calls).toHaveLength(0);
  });

  it('classifyRunError: output too large is failed, a foreign signal is failed', () => {
    const big = Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' });
    expect(classifyRunError(big)).toEqual({ status: 'failed', detail: 'output too large' });
    expect(classifyRunError(Object.assign(new Error('x'), { killed: false, signal: 'SIGKILL', code: null }))).toEqual({ status: 'failed', detail: 'signal SIGKILL' });
    expect(classifyRunError(Object.assign(new Error('x'), { name: 'AbortError', code: 'ABORT_ERR' })).status).toBe('aborted');
  });

  it('paths fall back to windir, then C:\\Windows', () => {
    expect(tasklistPath({ windir: 'E:\\W' })).toBe('E:\\W\\System32\\tasklist.exe');
    expect(powershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('processes: command lines (CIM)', () => {
  it('builds a PID-filtered script from integers only', () => {
    const s = cimCommandLineScript([4200, 4200, -1, 1.5, 4201]);
    expect(s).toContain("Get-CimInstance Win32_Process -Filter 'ProcessId=4200 OR ProcessId=4201'");
    expect(s).toContain('Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress');
    expect(s.startsWith('[Console]::OutputEncoding=[Text.Encoding]::UTF8;')).toBe(true);
    expect(() => cimCommandLineScript([0, Number.NaN])).toThrow(RangeError);
  });

  it('parses one object, an array, null command lines and empty output', () => {
    expect(parseCimProcessJson(JSON.stringify({ ProcessId: 4200, CommandLine: VR_LINE }))).toEqual(new Map([[4200, VR_LINE]]));
    const two = parseCimProcessJson(JSON.stringify([{ ProcessId: 4200, CommandLine: VR_LINE }, { ProcessId: 4201, CommandLine: null }]))!;
    expect(two.get(4201)).toBeNull();
    expect(parseCimProcessJson('  \r\n')?.size).toBe(0);
    expect(parseCimProcessJson('not json')).toBeUndefined();
    expect(parseCimProcessJson('[1,2]')).toBeUndefined();
  });

  it('runs powershell.exe by absolute path, -NoProfile -NonInteractive, 10 s timeout', async () => {
    const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
    const run: ExecFileFn = async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { stdout: JSON.stringify({ ProcessId: 4200, CommandLine: VR_LINE }), stderr: '' };
    };
    const r = await processCommandLines([4200], { execFile: run, env: { SystemRoot: 'C:\\Windows' } });
    expect(r).toEqual({ status: 'ok', commandLines: new Map([[4200, VR_LINE]]) });
    expect(calls[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(calls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[0].opts).toMatchObject({ timeout: 10000, windowsHide: true });
  });

  it('starts nothing for no PIDs', async () => {
    const f = fakeExec({});
    expect(await processCommandLines([], { execFile: f.run })).toEqual({ status: 'ok', commandLines: new Map() });
    expect(f.calls).toHaveLength(0);
  });
});

describe('processes: system folder', () => {
  it('finds the -sp folder, quoted or not', () => {
    expect(parseSystemDir(VR_LINE)).toBe('C:\\VCs\\IRB1600_A');
    expect(parseSystemDir('Vrchost64.exe -sp C:\\VCs\\X -pp 1')).toBe('C:\\VCs\\X');
    expect(parseSystemDir('"RobVC.exe" -Embedding')).toBeUndefined();
    expect(parseSystemDir(null)).toBeUndefined();
  });

  it('reads SystemName and the RobotControl version from system.xml', () => {
    expect(parseSystemXml(SYSTEM_XML)).toEqual({ systemName: 'IRB1600_A', rwVersion: '8.2.1+1023' });
    expect(parseSystemXml('<SystemProperties><SystemName>A &amp; B</SystemName></SystemProperties>')).toEqual({ systemName: 'A & B' });
    expect(parseSystemXml("<Media version='7.21.0+229' name='RobotControl'/>")).toEqual({ rwVersion: '7.21.0+229' });
    expect(parseSystemXml('<x/>')).toEqual({});
  });

  it('reads HostName from rsmeta.xml (with a BOM)', () => {
    expect(parseRsmetaXml(RSMETA_XML.replace(/^\uFEFF/, ''))).toEqual({ hostName: 'HOST-A' });
    expect(parseRsmetaXml('<RobotStudioData/>')).toEqual({});
  });

  it('readVcSystemFolder reads both files, strips a BOM, decodes UTF-16 LE', async () => {
    const { read, reads } = files({ 'C:\\VCs\\IRB1600_A\\system.xml': SYSTEM_XML, 'C:\\VCs\\IRB1600_A\\rsmeta.xml': RSMETA_XML });
    expect(await readVcSystemFolder('C:\\VCs\\IRB1600_A', { readFile: read }))
      .toEqual({ systemName: 'IRB1600_A', rwVersion: '8.2.1+1023', hostName: 'HOST-A', readable: true });
    expect(reads.sort()).toEqual(['C:\\VCs\\IRB1600_A\\rsmeta.xml', 'C:\\VCs\\IRB1600_A\\system.xml']);

    const utf16: ReadFileFn = async f => (f.endsWith('system.xml')
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SYSTEM_XML, 'utf16le')])
      : Promise.reject(new Error('ENOENT')));
    expect(await readVcSystemFolder('C:\\VCs\\IRB1600_A', { readFile: utf16 }))
      .toEqual({ systemName: 'IRB1600_A', rwVersion: '8.2.1+1023', readable: true });
  });

  it('an unreadable or oversized folder is readable:false, never a throw', async () => {
    const { read } = files({});
    expect(await readVcSystemFolder('C:\\nowhere', { readFile: read })).toEqual({ readable: false });
    const huge: ReadFileFn = async () => Buffer.alloc(2 * 1024 * 1024);
    expect(await readVcSystemFolder('C:\\big', { readFile: huge })).toEqual({ readable: false });
  });
});

describe('processes: vcProcessDetails (soft fail)', () => {
  const okFiles = files({ 'C:\\VCs\\IRB1600_A\\system.xml': SYSTEM_XML, 'C:\\VCs\\IRB1600_A\\rsmeta.xml': RSMETA_XML });

  it('names a Vrchost64 VC from its folder; RobVC gets PID and image only; others are left out', async () => {
    const f = fakeExec({ 'powershell.exe': JSON.stringify({ ProcessId: 4200, CommandLine: VR_LINE }) });
    const r = await vcProcessDetails(
      [{ pid: 4100, image: 'RobVC.exe' }, { pid: 4200, image: 'Vrchost64.exe' }, { pid: 4400, image: 'notepad.exe' }],
      { platform: 'win32', execFile: f.run, readFile: okFiles.read },
    );
    expect(r.notes).toEqual([]);
    expect(r.details.get(4100)).toEqual({ pid: 4100, image: 'RobVC.exe' });
    expect(r.details.get(4200)).toEqual({
      pid: 4200, image: 'Vrchost64.exe', commandLine: VR_LINE, systemDir: 'C:\\VCs\\IRB1600_A',
      systemName: 'IRB1600_A', rwVersion: '8.2.1+1023', hostName: 'HOST-A',
    });
    expect(r.details.has(4400)).toBe(false);
    // One CIM query, for the Vrchost64 PID only: no other program's command line is read.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].args[3]).toContain("-Filter 'ProcessId=4200'");
  });

  it('starts no PowerShell without a Vrchost64 PID, off Windows, or after a cancel', async () => {
    const f = fakeExec({ 'powershell.exe': '' });
    await vcProcessDetails([{ pid: 4100, image: 'RobVC.exe' }, { pid: 9, image: 'svchost.exe' }], { platform: 'win32', execFile: f.run });
    expect(await vcProcessDetails([{ pid: 4200, image: 'Vrchost64.exe' }], { platform: 'linux', execFile: f.run }))
      .toEqual({ details: new Map(), notes: [] });
    const ac = new AbortController(); ac.abort();
    await vcProcessDetails([{ pid: 4200, image: 'Vrchost64.exe' }], { platform: 'win32', execFile: f.run, signal: ac.signal });
    expect(f.calls).toHaveLength(0);
  });

  it('PowerShell missing or slow: every Vrchost64 entry keeps its PID and gets one shared note', async () => {
    const r = await vcProcessDetails([{ pid: 4200, image: 'Vrchost64.exe' }, { pid: 4201, image: 'Vrchost64.exe' }],
      { platform: 'win32', execFile: fakeExec({}).run });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/PowerShell is not available/);
    expect(r.details.get(4201)).toMatchObject({ pid: 4201, image: 'Vrchost64.exe', note: r.notes[0] });

    const slow = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    const t = await vcProcessDetails([{ pid: 4200, image: 'Vrchost64.exe' }], { platform: 'win32', execFile: fakeExec({ 'powershell.exe': slow }).run });
    expect(t.notes[0]).toMatch(/timed out/);
  });

  it('an empty command line, a missing -sp, an exited process and an unreadable folder each give a note', async () => {
    const answer = JSON.stringify([
      { ProcessId: 4200, CommandLine: null },
      { ProcessId: 4201, CommandLine: '"Vrchost64.exe" -pp "1"' },
      { ProcessId: 4203, CommandLine: VR_LINE.replace('IRB1600_A', 'GONE') },
    ]);
    const r = await vcProcessDetails(
      [4200, 4201, 4202, 4203].map(pid => ({ pid, image: 'Vrchost64.exe' })),
      { platform: 'win32', execFile: fakeExec({ 'powershell.exe': answer }).run, readFile: okFiles.read },
    );
    expect(r.details.get(4200)?.note).toMatch(/not visible \(RobotStudio may run as administrator\)/);
    expect(r.details.get(4201)?.note).toMatch(/names no system folder/);
    expect(r.details.get(4202)?.note).toMatch(/ended before/);
    expect(r.details.get(4203)?.note).toMatch(/could not be read/);
    expect(r.details.get(4203)?.systemDir).toBe('C:\\VCs\\GONE');
    expect(r.notes).toHaveLength(4);
    expect(r.notes[0]).toContain('4200');
    expect(r.notes[3]).toContain('4203');
  });
});
