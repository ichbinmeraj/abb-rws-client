/**
 * Offline checks of the I/O fixture script (the EIO file it loads, its
 * refusals, the instances it may touch, and the order of its requests in an
 * apply and a remove, against a fake controller), of the motion module's
 * signed offsets, and of the session label the trace puts on each line.
 * Nothing here reaches a controller; plain `npm test` runs it (the functional
 * runner only runs the files directly in tests/functional).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FIXTURE, EIO_HEADER, FixtureRefusal, TIMING, applyLane, assertLocalhost, assertProbeInstance, buildEioCfg,
  cfgFilePaths, fixtureInstances, isNotFound, laneForVersion, output, parseOptions, removalOrder, removeLane, sameController,
  validateBodyVerdict, validateFailure,
// @ts-expect-error - plain .mjs script without type declarations
} from '../../../scripts/functional-fixtures.mjs';
import { IO_FIXTURE, ioFixtureHint, isExtraProbeSignal, isIoFixtureSignal } from './config.js';
import { signedTerm, zzMotionModule } from './rapid.js';
import { labelSession, traceSession, withTraceSession } from './trace.js';

const APPLY = { RWS_FIXTURES_APPLY: '1', RWS_FIXTURES_LANES: 'rw7,rw6' };

/** The EIO file an apply loads on RW 7.21.4. */
const RW7_FILE = [
  'EIO:CFG_1.0:7:0::',
  '#',
  'VIRTUAL_DEVICE:',
  '',
  '      -Name "ZZ_PROBE_DEV" -Network "Virtual"',
  '#',
  'EIO_SIGNAL:',
  '',
  '      -Name "ZZ_PROBE_DI1" -SignalType "DI" -Device "ZZ_PROBE_DEV"\\',
  '      -DeviceMap "0" -Access "All"',
  '',
  '      -Name "ZZ_PROBE_DO1" -SignalType "DO" -Device "ZZ_PROBE_DEV"\\',
  '      -DeviceMap "0" -Access "All"',
  '',
].join('\n');

/** The EIO file an apply loads on RW 6.16.03: the same signals, no device. */
const RW6_FILE = [
  'EIO:CFG_1.0:6:1::',
  '#',
  'EIO_SIGNAL:',
  '',
  '      -Name "ZZ_PROBE_DI1" -SignalType "DI" -Access "All"',
  '',
  '      -Name "ZZ_PROBE_DO1" -SignalType "DO" -Access "All"',
  '',
].join('\n');

describe('I/O fixture file', () => {
  it('builds the RW7 file: the build header, a virtual device on Virtual, a DI and a DO on it at device map 0, access All, no category', () => {
    expect(buildEioCfg('rw7')).toBe(RW7_FILE);
  });

  it('builds the RW6 file: the build header and the two signals with no device, access All, no category', () => {
    expect(buildEioCfg('rw6')).toBe(RW6_FILE);
  });

  it('leaves the device network attribute off only when asked (a build whose VIRTUAL_DEVICE has none)', () => {
    const text = buildEioCfg('rw7', { deviceNetwork: false });
    expect(text).toContain('      -Name "ZZ_PROBE_DEV"\n#\nEIO_SIGNAL:');
    expect(text).not.toContain('-Network');
    expect(buildEioCfg('rw6', { deviceNetwork: false })).toBe(RW6_FILE);
  });

  it('wraps no line past 80 characters, continues wrapped lines with a backslash, and never writes a category or a reset', () => {
    for (const lane of ['rw6', 'rw7'] as const) {
      const text = buildEioCfg(lane);
      expect(text.startsWith(`${EIO_HEADER[lane]}\n`)).toBe(true);
      for (const line of text.split('\n')) { expect(line.length).toBeLessThanOrEqual(80); }
      expect(text).not.toMatch(/Category|reset/i);
      expect(text.endsWith('\n')).toBe(true);
    }
  });

  it('adds and removes only ZZ_PROBE instances, the device before its signals on load and after them on removal', () => {
    const rw7 = fixtureInstances('rw7');
    expect(rw7.map((i: { type: string; name: string }) => `${i.type}/${i.name}`)).toEqual(['VIRTUAL_DEVICE/ZZ_PROBE_DEV', 'EIO_SIGNAL/ZZ_PROBE_DI1', 'EIO_SIGNAL/ZZ_PROBE_DO1']);
    expect(removalOrder('rw7').map((i: { name: string }) => i.name)).toEqual(['ZZ_PROBE_DO1', 'ZZ_PROBE_DI1', 'ZZ_PROBE_DEV']);
    expect(fixtureInstances('rw6').map((i: { name: string }) => i.name)).toEqual(['ZZ_PROBE_DI1', 'ZZ_PROBE_DO1']);
    for (const lane of ['rw6', 'rw7'] as const) {
      for (const i of [...fixtureInstances(lane), ...removalOrder(lane)]) { expect(i.name.startsWith('ZZ_PROBE')).toBe(true); }
    }
    expect(() => assertProbeInstance('DRV1TESTE2')).toThrow(FixtureRefusal);
    expect(() => assertProbeInstance('ZZ_PROBE_DI1')).not.toThrow();
    expect(() => fixtureInstances('rw8' as never)).toThrow(FixtureRefusal);
  });

  it('names the file in TEMP: $TEMP on RWS 1.0; on RWS 2.0 the file service TEMP, loaded as $TEMP, then TEMP, then the file-service URI', () => {
    expect(cfgFilePaths('rw6')).toEqual({ upload: '$TEMP/ZZ_PROBE_FIXTURE_EIO.cfg', load: ['$TEMP/ZZ_PROBE_FIXTURE_EIO.cfg'] });
    expect(cfgFilePaths('rw7')).toEqual({
      upload: 'TEMP/ZZ_PROBE_FIXTURE_EIO.cfg',
      load: ['$TEMP/ZZ_PROBE_FIXTURE_EIO.cfg', 'TEMP/ZZ_PROBE_FIXTURE_EIO.cfg', '/fileservice/TEMP/ZZ_PROBE_FIXTURE_EIO.cfg'],
    });
  });

  it('takes a validate answer as a pass only in the documented shape: a cfg-validate item for EIO and nothing else', () => {
    // ABB's CFG Service page for RWS 2.0 (POST /rw/cfg/validate, 200).
    const documented = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>'
      + '<div class="state"><a href="" rel="self"></a><ul><li class="cfg-validate" title="EIO"><span class="domain">EIO</span></li></ul></div></body></html>';
    expect(validateBodyVerdict(documented)).toEqual({ ok: true, reason: 'cfg-validate EIO' });
    expect(validateBodyVerdict('')).toMatchObject({ ok: false, reason: 'the answer has no cfg-validate item' });
    expect(validateBodyVerdict('<div class="status"><span class="code">-1073437691</span></div>').ok).toBe(false);
    // An error under any other class is a refusal too, not only status / code.
    const withMsg = documented.replace('</ul>', '<li class="cfg-err"><span class="msg">Duplicate instance ZZ_PROBE_DI1</span></li></ul>');
    expect(validateBodyVerdict(withMsg)).toMatchObject({ ok: false });
    expect(validateBodyVerdict(withMsg).reason).toMatch(/class "cfg-err", class "msg"/);
    expect(validateBodyVerdict(documented.replace(/EIO/g, 'MOC')).ok).toBe(false);
  });

  it('reads 404 on every file form as a missing validate endpoint, not a bad file', () => {
    const r404 = (p: string) => ({ path: p, text: 'RESOURCE_NOT_FOUND 404: not found', notFound: true });
    expect(validateFailure([r404('$TEMP/x'), r404('TEMP/x'), r404('/fileservice/TEMP/x')]))
      .toMatch(/^the controller did not validate the file - nothing was loaded\. Every form answered 404; .*no \/rw\/cfg\/validate endpoint, not that the file is wrong/);
    const mixed = validateFailure([r404('$TEMP/x'), { path: 'TEMP/x', text: 'INVALID_ARGUMENT 400: bad', notFound: false }]);
    expect(mixed).not.toMatch(/Every form answered 404/);
    expect(mixed).toContain('TEMP/x: INVALID_ARGUMENT 400: bad');
    expect(isNotFound({ code: 'RESOURCE_NOT_FOUND', httpStatus: 404 })).toBe(true);
    expect(isNotFound({ code: 'INVALID_ARGUMENT', httpStatus: 400 })).toBe(false);
  });

  it('agrees with the names the suite looks for', () => {
    expect({ network: FIXTURE.network, device: FIXTURE.device, di: FIXTURE.di, do: FIXTURE.do }).toEqual(IO_FIXTURE);
    expect(isIoFixtureSignal('ZZ_PROBE_DI1') && isIoFixtureSignal('ZZ_PROBE_DO1')).toBe(true);
    expect(isIoFixtureSignal('IIO_di1')).toBe(false);
    // Probe signals added by hand are the suite's, not the fixture's and not built in.
    expect(isExtraProbeSignal('ZZ_PROBE_DO2') && isExtraProbeSignal('ZZ_PROBE_DO3')).toBe(true);
    expect(isExtraProbeSignal('ZZ_PROBE_DI1') || isExtraProbeSignal('ZZ_PROBE_DO1')).toBe(false);
    expect(isExtraProbeSignal('IIO_do8')).toBe(false);
    expect(ioFixtureHint('rw6')).toContain('npm run functional:fixtures');
    expect(ioFixtureHint('rw6')).toContain('RWS_FIXTURES_LANES=rw6');
    // rw6 is on the never-restart list: the hint says the restart is one to watch.
    expect(ioFixtureHint('rw6')).toMatch(/the test suites never do on this lane: run it at the machine, with RobotStudio open/);
    expect(ioFixtureHint('rw7')).toMatch(/RWS_FIXTURES_LANES=rw7; it warm-restarts the controller\)$/);
  });
});

describe('I/O fixture refusals', () => {
  it('sends nothing without RWS_FIXTURES_APPLY=1 and a lane list', () => {
    expect(() => parseOptions([], {})).toThrow(/RWS_FIXTURES_APPLY=1/);
    expect(() => parseOptions([], { RWS_FIXTURES_LANES: 'rw7' })).toThrow(/RWS_FIXTURES_APPLY=1/);
    expect(() => parseOptions([], { RWS_FIXTURES_APPLY: 'yes', RWS_FIXTURES_LANES: 'rw7' })).toThrow(/RWS_FIXTURES_APPLY=1/);
    expect(() => parseOptions(['--remove'], { RWS_FIXTURES_LANES: 'rw7' })).toThrow(/RWS_FIXTURES_APPLY=1/);
    expect(() => parseOptions([], { RWS_FIXTURES_APPLY: '1' })).toThrow(/RWS_FIXTURES_LANES/);
    expect(() => parseOptions([], { RWS_FIXTURES_APPLY: '1', RWS_FIXTURES_LANES: ' , ' })).toThrow(/RWS_FIXTURES_LANES/);
  });

  it('refuses rw8 (and any unknown lane) in every mode, even for --print', () => {
    for (const argv of [[], ['--remove'], ['--print']]) {
      expect(() => parseOptions(argv, { ...APPLY, RWS_FIXTURES_LANES: 'rw7,rw8' })).toThrow(/rw8 is refused/);
    }
    expect(() => parseOptions([], { ...APPLY, RWS_FIXTURES_LANES: 'rw5' })).toThrow(FixtureRefusal);
    expect(() => parseOptions(['--force'], APPLY)).toThrow(/unknown argument/);
  });

  it('refuses any host but this PC', () => {
    expect(() => assertLocalhost('192.168.125.1')).toThrow(FixtureRefusal);
    expect(() => assertLocalhost('127.0.0.1')).not.toThrow();
    expect(() => parseOptions([], { ...APPLY, RWS_TEST_HOST: '192.168.125.1' })).toThrow(/refusing host/);
  });

  it('reads the mode and the lanes, in the order given, without repeats', () => {
    expect(parseOptions([], APPLY)).toEqual({ help: false, print: false, mode: 'apply', lanes: ['rw7', 'rw6'] });
    expect(parseOptions(['--remove'], { ...APPLY, RWS_FIXTURES_LANES: ' RW6 ,rw6' }))
      .toEqual({ help: false, print: false, mode: 'remove', lanes: ['rw6'] });
    expect(parseOptions(['--print'], {})).toEqual({ help: false, print: true, mode: 'apply', lanes: ['rw6', 'rw7'] });
    expect(() => parseOptions(['--print', '--remove'], {})).toThrow(FixtureRefusal);
  });

  it('recognises a controller after the restart by its system id, else by name and version', () => {
    const ctrl = { sysid: '{0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}', systemName: 'VC_SYSTEM_A', rwVersion: '7.21.4+417' };
    expect(sameController({ ...ctrl, sysid: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }, ctrl)).toBe(true);
    expect(sameController({ ...ctrl, sysid: '{00000000-0000-0000-0000-000000000000}' }, ctrl)).toBe(false);
    expect(sameController({ sysid: '', systemName: 'VC_SYSTEM_A', rwVersion: '7.21.4+417' }, { ...ctrl, sysid: '' })).toBe(true);
    expect(sameController({ sysid: '', systemName: 'other', rwVersion: '7.21.4+417' }, { ...ctrl, sysid: '' })).toBe(false);
    expect(laneForVersion('6.16.3007')).toBe('rw6');
    expect(laneForVersion('8.2.1+1023')).toBe('rw8');
    expect(laneForVersion('5.15')).toBeNull();
  });
});

describe('motion module offsets', () => {
  it('writes the sign on the operator, the only form RAPID accepts after an operand', () => {
    expect(signedTerm(3)).toBe('+ 3');
    expect(signedTerm(-3)).toBe('- 3');
    expect(signedTerm(-0.25)).toBe('- 0.25');
    expect(signedTerm(0)).toBe('+ 0');
    // Float noise of a joint at rest rounds to zero, never to "- 0" or "+ -0".
    expect(signedTerm(-1.98e-16)).toBe('+ 0');
    expect(signedTerm(1.98e-16)).toBe('+ 0');
    expect(() => signedTerm(Number.NaN)).toThrow();
  });

  it('generates no signed addition for negative offsets', () => {
    const m = zzMotionModule({ name: 'ZZ_PROBE_MOVE', axis1Deg: -3, wristDeg: -6, speed: 'v20', loops: 2 });
    expect(m.text).toContain(`${m.symbols.target}.robax.rax_1 := ${m.symbols.start}.robax.rax_1 - 3;`);
    expect(m.text).toContain(`${m.symbols.target}.robax.rax_4 := ${m.symbols.start}.robax.rax_4 - 6;`);
    expect(m.text).toContain(`${m.symbols.target}.robax.rax_6 := ${m.symbols.start}.robax.rax_6 - 6;`);
    expect(m.text).not.toMatch(/[+-]\s*[+-]\s*[\d.]/);
    const p = zzMotionModule({ axis1Deg: 2, wristDeg: 5 });
    expect(p.text).toContain(`${p.symbols.start}.robax.rax_1 + 2;`);
    expect(p.text).not.toMatch(/[+-]\s*[+-]\s*[\d.]/);
  });
});

describe('trace session labels', () => {
  class FakeSession {
    calls = 0;
    get label(): string | null { return traceSession(); }
    read(): string | null { this.calls++; return traceSession(); }
    async readLater(): Promise<string | null> {
      await new Promise(r => setTimeout(r, 5));
      return traceSession();
    }
    startTimer(): Promise<string | null> {
      return new Promise(resolve => setTimeout(() => resolve(traceSession()), 5));
    }
  }

  it('labels a session\'s calls, including the async work and the timers they start, and nothing outside them', async () => {
    const raw = new FakeSession();
    const s = labelSession(raw, 'manager#1');
    expect(traceSession()).toBeNull();
    expect(s.read()).toBe('manager#1');
    expect(await s.readLater()).toBe('manager#1');
    expect(await s.startTimer()).toBe('manager#1');
    expect(raw.read()).toBeNull();
    expect(raw.calls).toBe(2);
    expect(s.calls).toBe(2);
    // A property read is not a call: it answers as the object does.
    expect(s.label).toBeNull();
  });

  it('keeps identity and instanceof, reads a label getter at each call, and keeps the first label of an object', () => {
    let n = 1;
    const raw = new FakeSession();
    const s = labelSession(raw, () => `manager#${n}`);
    expect(s).toBeInstanceOf(FakeSession);
    expect(labelSession(raw, 'other')).toBe(s);
    expect(s.read).toBe(s.read);
    expect(s.read()).toBe('manager#1');
    n = 2;
    expect(s.read()).toBe('manager#2');
  });

  it('labels what runs inside withTraceSession, and nests', async () => {
    expect(await withTraceSession('fleet:5466', async () => {
      await new Promise(r => setTimeout(r, 1));
      return traceSession();
    })).toBe('fleet:5466');
    const inner = labelSession(new FakeSession(), 'adapter-1');
    expect(withTraceSession('observer#1', () => [traceSession(), inner.read(), traceSession()]))
      .toEqual(['observer#1', 'adapter-1', 'observer#1']);
  });
});

// ─── The apply and remove flows, against a fake controller ──────────────────

/** Calls that change something, or decide what gets loaded: the order under test. */
const WRITES = /^(uploadFile|requestMastership|releaseMastership|validate|loadCfgFile|deleteFile|restartController|removeCfgInstance) /;

interface FakeState {
  generation: 'rws1' | 'rws2';
  /** EIO type -> configured instance names. */
  cfg: Record<string, string[]>;
  /** Signal types from the configuration, name -> DI/DO. */
  types: Record<string, string>;
  /** What the I/O system lists (the configuration as of the last restart). */
  signals: Array<{ name: string; type: string }>;
  devices: string[];
  restartCount: number | null;
  exec: string;
  files: Map<string, string>;
  log: string[];
  /** File paths whose validation the fake refuses. */
  refuseValidate: string[];
  /** The HTTP status of those refusals (400 unless set). */
  refuseStatus?: number;
  /** The RWS 2.0 validate 200 body (the documented one unless set). */
  validateBody?: string;
}

const BUILT_IN = [{ name: 'DRV1BRAKE', type: 'DO' }, { name: 'RUN_CH1', type: 'DI' }];

function fakeState(generation: 'rws1' | 'rws2', over: Partial<FakeState> = {}): FakeState {
  return {
    generation,
    cfg: { EIO_SIGNAL: BUILT_IN.map(s => s.name), VIRTUAL_DEVICE: [] },
    types: Object.fromEntries(BUILT_IN.map(s => [s.name, s.type])),
    signals: [...BUILT_IN],
    devices: [],
    restartCount: generation === 'rws2' ? 1 : null,
    exec: 'stopped',
    files: new Map(),
    log: [],
    refuseValidate: [],
    ...over,
  };
}

/** A warm restart: the I/O system takes the configuration as it is now. */
function activate(st: FakeState): void {
  st.signals = st.cfg.EIO_SIGNAL.map(name => ({ name, type: st.types[name] ?? 'DI' }));
  st.devices = [...st.cfg.VIRTUAL_DEVICE];
}

/** The fake's CFG load: the instances of the uploaded file, by section. */
function load(st: FakeState, filepath: string): void {
  const base = filepath.split('/').pop()!;
  const text = [...st.files.entries()].find(([p]) => p.endsWith(`/${base}`))?.[1];
  if (!text) { throw Object.assign(new Error(`no file ${filepath}`), { code: 'RESOURCE_NOT_FOUND' }); }
  for (const section of text.split('\n#\n')) {
    const type = /^([A-Z_]+):/m.exec(section)?.[1];
    if (!type) { continue; }
    for (const inst of section.split('\n\n').slice(1)) {
      const name = /-Name "([^"]+)"/.exec(inst)?.[1];
      if (!name) { continue; }
      (st.cfg[type] ??= []).push(name);
      const t = /-SignalType "([^"]+)"/.exec(inst)?.[1];
      if (t) { st.types[name] = t; }
    }
  }
}

function fakeClient(st: FakeState): unknown {
  const notFound = (name: string): Error => Object.assign(new Error(`${name} not found`), { code: 'RESOURCE_NOT_FOUND' });
  const adapter = (): Record<string, unknown> => {
    const log = (entry: string): void => { st.log.push(entry); };
    const a: Record<string, unknown> = {
      getSystemInfo: async () => ({ name: 'VC', rwVersion: st.generation === 'rws1' ? '6.16.3007' : '7.21.4+417', sysid: '{A1}' }),
      listCfgInstances: async (_d: string, type: string) => [...(st.cfg[type] ?? [])],
      listAllSignals: async (start = 0) => (start === 0 ? st.signals.map(s => ({ ...s, lvalue: '0', value: '0' })) : []),
      listDevices: async (network: string) => (network === 'Virtual' ? st.devices.map(name => ({ name, network })) : []),
      listNetworks: async () => [{ name: 'IntBus' }, { name: 'Virtual' }],
      readSignal: async (_n: string, _d: string, name: string) => {
        const s = st.signals.find(x => x.name === name);
        if (!s) { throw notFound(name); }
        return { ...s, lvalue: '0', value: '0' };
      },
      getRapidExecutionState: async () => st.exec,
      getOperationMode: async () => 'AUTO',
      uploadFile: async (p: string, content: string) => { log(`uploadFile ${p}`); st.files.set(p, content); },
      deleteFile: async (p: string) => { log(`deleteFile ${p}`); st.files.delete(p); },
      requestMastership: async (d: string) => { log(`requestMastership ${d}`); },
      releaseMastership: async (d: string) => { log(`releaseMastership ${d}`); },
      loadCfgFile: async (p: string, action: string) => { log(`loadCfgFile ${p} ${action}`); load(st, p); },
      removeCfgInstance: async (_d: string, type: string, name: string) => {
        log(`removeCfgInstance ${type} ${name}`);
        st.cfg[type] = (st.cfg[type] ?? []).filter(n => n !== name);
      },
      restartController: async (mode: string) => {
        log(`restartController ${mode}`);
        if (st.restartCount !== null) { st.restartCount++; }
        activate(st);
      },
      disconnect: async () => undefined,
    };
    const validate = (p: string, action: string): void => {
      log(`validate ${p} ${action}`);
      if (st.refuseValidate.includes(p)) {
        const status = st.refuseStatus ?? 400;
        throw Object.assign(new Error(`invalid file ${p}`), { code: status === 404 ? 'RESOURCE_NOT_FOUND' : 'INVALID_ARGUMENT', httpStatus: status });
      }
    };
    if (st.generation === 'rws2') {
      a.getRestartCount = async () => st.restartCount;
      a.listCfgTypeAttributes = async (_d: string, type: string) => (type === 'EIO_SIGNAL'
        ? ['Name', 'SignalType', 'Device', 'DeviceMap', 'Category', 'Access', 'Invert'].map(name => ({ name }))
        : [{ name: 'Name' }, { name: 'Network' }]);
      a.req = async (method: string, p: string, body: Record<string, string>) => {
        if (method !== 'POST' || p !== '/rw/cfg/validate') { throw new Error(`unexpected request ${method} ${p}`); }
        validate(body.filepath, body['action-type']);
        return st.validateBody ?? '<div class="state"><ul><li class="cfg-validate" title="EIO"><span class="domain">EIO</span></li></ul></div>';
      };
    } else {
      a.validateCfgFile = async (p: string, action: string) => { validate(p, action); };
    }
    return a;
  };
  return {
    createAdapter: async () => adapter(),
    // The restart watch scans this PC only when the known port stays silent; nothing else answers here.
    findControllers: async () => ({
      controllers: [], aborted: false, tlsFailures: [], unmatchedCredentials: [], notes: [], environment: { wsl: false },
      localScan: { status: 'ok', attempts: [], vcFilter: 'on', sweep: false },
    }),
    RobotManager: {
      probeSpecificPort: async () => ({ useHttps: st.generation === 'rws2', authType: st.generation === 'rws1' ? 'digest' : 'basic' }),
    },
  };
}

const CTRL = {
  rw7: { lane: 'rw7', generation: 'rws2', port: 5466, https: true, rwVersion: '7.21.4+417', systemName: 'VC', sysid: '{A1}' },
  rw6: { lane: 'rw6', generation: 'rws1', port: 56791, https: false, rwVersion: '6.16.3007', systemName: 'VC', sysid: '{A1}' },
} as const;

const writes = (st: FakeState): string[] => st.log.filter(l => WRITES.test(l));

describe('I/O fixture apply and remove (fake controller)', () => {
  const saved = { ...TIMING };
  const savedLog = output.log;
  const lines: string[] = [];
  beforeAll(() => {
    Object.assign(TIMING, { restartWindowMs: 3000, stepMs: 1, loadSettleMs: 200 });
    output.log = (line: string) => { lines.push(line); };
  });
  afterAll(() => {
    Object.assign(TIMING, saved);
    output.log = savedLog;
  });

  it('RW7: uploads the file, holds the configuration lock around validate and load (action add, $TEMP path), releases, deletes the file, restarts and sees the fixture', async () => {
    const st = fakeState('rws2');
    await applyLane(fakeClient(st), CTRL.rw7, []);
    const file = 'ZZ_PROBE_FIXTURE_EIO.cfg';
    expect(writes(st)).toEqual([
      `uploadFile TEMP/${file}`,
      'requestMastership cfg',
      `validate $TEMP/${file} add`,
      `loadCfgFile $TEMP/${file} add`,
      'releaseMastership cfg',
      `deleteFile TEMP/${file}`,
      'restartController restart',
    ]);
    expect(st.signals.map(s => s.name)).toEqual(expect.arrayContaining(['ZZ_PROBE_DI1', 'ZZ_PROBE_DO1', 'DRV1BRAKE', 'RUN_CH1']));
    expect(st.devices).toEqual(['ZZ_PROBE_DEV']);
    expect(st.files.size).toBe(0);
    expect(lines.some(l => /applied and active/.test(l) && /restart count 1 -> 2/.test(l))).toBe(true);
  });

  it('RW7: falls back to the TEMP path when the controller does not validate the $TEMP one', async () => {
    const st = fakeState('rws2', { refuseValidate: ['$TEMP/ZZ_PROBE_FIXTURE_EIO.cfg'] });
    await applyLane(fakeClient(st), CTRL.rw7, []);
    expect(writes(st).filter(l => /^(validate|loadCfgFile) /.test(l))).toEqual([
      'validate $TEMP/ZZ_PROBE_FIXTURE_EIO.cfg add',
      'validate TEMP/ZZ_PROBE_FIXTURE_EIO.cfg add',
      'loadCfgFile TEMP/ZZ_PROBE_FIXTURE_EIO.cfg add',
    ]);
  });

  it('RW6: the same order through the RWS 1.0 validate call, in $TEMP, with no restart count to wait on', async () => {
    const st = fakeState('rws1');
    await applyLane(fakeClient(st), CTRL.rw6, []);
    const file = 'ZZ_PROBE_FIXTURE_EIO.cfg';
    expect(writes(st)).toEqual([
      `uploadFile $TEMP/${file}`,
      'requestMastership cfg',
      `validate $TEMP/${file} add`,
      `loadCfgFile $TEMP/${file} add`,
      'releaseMastership cfg',
      `deleteFile $TEMP/${file}`,
      'restartController restart',
    ]);
    expect(st.cfg.VIRTUAL_DEVICE).toEqual([]);
    expect(st.signals.find(s => s.name === 'ZZ_PROBE_DI1')?.type).toBe('DI');
    expect(st.signals.find(s => s.name === 'ZZ_PROBE_DO1')?.type).toBe('DO');
  });

  it('RW7: tries the file-service URI last, and loads it when only that form validates', async () => {
    const st = fakeState('rws2', { refuseValidate: ['$TEMP/ZZ_PROBE_FIXTURE_EIO.cfg', 'TEMP/ZZ_PROBE_FIXTURE_EIO.cfg'] });
    await applyLane(fakeClient(st), CTRL.rw7, []);
    expect(writes(st).filter(l => /^(validate|loadCfgFile) /.test(l))).toEqual([
      'validate $TEMP/ZZ_PROBE_FIXTURE_EIO.cfg add',
      'validate TEMP/ZZ_PROBE_FIXTURE_EIO.cfg add',
      'validate /fileservice/TEMP/ZZ_PROBE_FIXTURE_EIO.cfg add',
      'loadCfgFile /fileservice/TEMP/ZZ_PROBE_FIXTURE_EIO.cfg add',
    ]);
  });

  it('loads nothing and restarts nothing when the file does not validate; the lock is released and the file deleted', async () => {
    const forms = cfgFilePaths('rw7').load;
    const st = fakeState('rws2', { refuseValidate: forms });
    await expect(applyLane(fakeClient(st), CTRL.rw7, [])).rejects.toThrow(/did not validate the file - nothing was loaded \(/);
    expect(writes(st)).toEqual([
      'uploadFile TEMP/ZZ_PROBE_FIXTURE_EIO.cfg',
      'requestMastership cfg',
      ...forms.map((f: string) => `validate ${f} add`),
      'releaseMastership cfg',
      'deleteFile TEMP/ZZ_PROBE_FIXTURE_EIO.cfg',
    ]);
    expect(st.cfg.EIO_SIGNAL).toEqual(['DRV1BRAKE', 'RUN_CH1']);
  });

  it('says a missing validate endpoint when every form answers 404, and loads nothing', async () => {
    const st = fakeState('rws2', { refuseValidate: cfgFilePaths('rw7').load, refuseStatus: 404 });
    await expect(applyLane(fakeClient(st), CTRL.rw7, [])).rejects.toThrow(/Every form answered 404; .*no \/rw\/cfg\/validate endpoint/);
    expect(writes(st).some(l => l.startsWith('loadCfgFile') || l.startsWith('restartController'))).toBe(false);
    expect(writes(st).slice(-2)).toEqual(['releaseMastership cfg', 'deleteFile TEMP/ZZ_PROBE_FIXTURE_EIO.cfg']);
  });

  it('loads nothing when a validate 200 is not the documented pass (an error under another class)', async () => {
    const st = fakeState('rws2', {
      validateBody: '<div class="state"><ul><li class="cfg-validate" title="EIO"><span class="domain">EIO</span></li>'
        + '<li class="cfg-err"><span class="msg">Duplicate instance ZZ_PROBE_DI1</span></li></ul></div>',
    });
    await expect(applyLane(fakeClient(st), CTRL.rw7, [])).rejects.toThrow(/nothing was loaded.*not as a pass/);
    expect(writes(st).some(l => l.startsWith('loadCfgFile') || l.startsWith('restartController'))).toBe(false);
    expect(st.files.size).toBe(0);
  });

  it('sends nothing when the controller lists a fixture signal the configuration list read does not show (a cut list)', async () => {
    const st = fakeState('rws1');
    st.signals.push({ name: 'ZZ_PROBE_DI1', type: 'DI' }, { name: 'ZZ_PROBE_DO1', type: 'DO' });
    await expect(applyLane(fakeClient(st), CTRL.rw6, [])).rejects.toThrow(/lists ZZ_PROBE_DI1, ZZ_PROBE_DO1, but the configuration list read \(2 EIO_SIGNAL rows\) does not/);
    await expect(removeLane(fakeClient(st), CTRL.rw6, [])).rejects.toThrow(/list read is incomplete/);
    expect(writes(st)).toEqual([]);
  });

  it('sends nothing when the fixture is already active, partly present, the configuration read failed, or RAPID runs', async () => {
    const applied = fakeState('rws2');
    await applyLane(fakeClient(applied), CTRL.rw7, []);
    applied.log.length = 0;
    await applyLane(fakeClient(applied), CTRL.rw7, []);
    expect(writes(applied)).toEqual([]);

    const partly = fakeState('rws2');
    partly.cfg.EIO_SIGNAL.push('ZZ_PROBE_DI1');
    await expect(applyLane(fakeClient(partly), CTRL.rw7, [])).rejects.toThrow(/partly present.*--remove first/);
    expect(writes(partly)).toEqual([]);

    const unread = fakeState('rws1', { cfg: { EIO_SIGNAL: [], VIRTUAL_DEVICE: [] } });
    await expect(applyLane(fakeClient(unread), CTRL.rw6, [])).rejects.toThrow(/read failed/);
    await expect(removeLane(fakeClient(unread), CTRL.rw6, [])).rejects.toThrow(/read failed/);
    expect(writes(unread)).toEqual([]);

    const running = fakeState('rws1', { exec: 'running' });
    await expect(applyLane(fakeClient(running), CTRL.rw6, [])).rejects.toThrow(/RAPID is running/);
    expect(writes(running)).toEqual([]);
  });

  it('only restarts when the configuration is loaded but not active yet', async () => {
    const st = fakeState('rws2');
    st.cfg.EIO_SIGNAL.push('ZZ_PROBE_DI1', 'ZZ_PROBE_DO1');
    st.cfg.VIRTUAL_DEVICE.push('ZZ_PROBE_DEV');
    Object.assign(st.types, { ZZ_PROBE_DI1: 'DI', ZZ_PROBE_DO1: 'DO' });
    await applyLane(fakeClient(st), CTRL.rw7, []);
    expect(writes(st)).toEqual(['restartController restart']);
    expect(st.devices).toEqual(['ZZ_PROBE_DEV']);
  });

  it('removes only the fixture, the signals before the device, under the lock, then restarts and sees them gone', async () => {
    const st = fakeState('rws2');
    await applyLane(fakeClient(st), CTRL.rw7, []);
    st.log.length = 0;
    await removeLane(fakeClient(st), CTRL.rw7, []);
    expect(writes(st)).toEqual([
      'requestMastership cfg',
      'removeCfgInstance EIO_SIGNAL ZZ_PROBE_DO1',
      'removeCfgInstance EIO_SIGNAL ZZ_PROBE_DI1',
      'removeCfgInstance VIRTUAL_DEVICE ZZ_PROBE_DEV',
      'releaseMastership cfg',
      'restartController restart',
    ]);
    expect(st.cfg.EIO_SIGNAL).toEqual(['DRV1BRAKE', 'RUN_CH1']);
    expect(st.signals.map(s => s.name)).toEqual(['DRV1BRAKE', 'RUN_CH1']);
    expect(st.devices).toEqual([]);
    st.log.length = 0;
    await removeLane(fakeClient(st), CTRL.rw7, []);
    expect(writes(st)).toEqual([]);
  });
});
