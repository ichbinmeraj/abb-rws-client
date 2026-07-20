import { describe, it, expect } from 'vitest';
import {
  controllerState,
  setControllerState,
  operationMode,
  speedRatio,
  setSpeedRatio,
  rapidTasks,
  rapidExecutionState,
  startRapid,
  stopRapid,
  resetRapid,
  setExecutionCycle,
  collisionDetectionState,
  restartController,
  lockOperationMode,
  unlockOperationMode,
  activeUiInstruction,
  setUiInstructionParam,
  activateRapidTask,
  deactivateRapidTask,
  activateAllRapidTasks,
  deactivateAllRapidTasks,
  searchRapidSymbols,
  validateRapidValue,
  rapidSymbolProperties,
  rapidSymbol,
  setRapidSymbol,
  jointTarget,
  robTarget,
  cartesianFull,
  loadModule,
  getModule,
  listModules,
  uploadFile,
  systemInfo,
  controllerIdentity,
  clockInfo,
  setControllerClock,
  elogMessages,
  clearElogDomain,
  clearAllElogs,
  deleteFile,
  createDirectory,
  copyFile,
  requestMastership,
  releaseMastership,
  allSignals,
  networks,
  devices,
  signal,
  setSignal,
  subscriptions,
  fileServicePath,
} from '../src/ResourceMapper.js';

describe('ResourceMapper', () => {
  describe('controllerState', () => {
    it('returns the correct RWS 1.0 path', () => {
      expect(controllerState()).toBe('/rw/panel/ctrlstate');
    });
  });

  describe('operationMode', () => {
    it('returns the correct RWS 1.0 path', () => {
      expect(operationMode()).toBe('/rw/panel/opmode');
    });
  });

  describe('rapidTasks', () => {
    it('returns the correct RWS 1.0 path', () => {
      expect(rapidTasks()).toBe('/rw/rapid/tasks');
    });
  });

  describe('rapidExecutionState', () => {
    it('returns the correct RWS 1.0 path', () => {
      expect(rapidExecutionState()).toBe('/rw/rapid/execution');
    });
  });

  describe('startRapid', () => {
    it('returns path with action=start query param', () => {
      expect(startRapid().path).toBe('/rw/rapid/execution?action=start');
    });

    it('body contains all required RWS form fields', () => {
      const { body } = startRapid();
      expect(body).toContain('regain=continue');
      expect(body).toContain('execmode=continue');
      expect(body).toContain('cycle=forever');
      expect(body).toContain('condition=none');
      expect(body).toContain('stopatbp=disabled');
      expect(body).toContain('alltaskbytsp=false');
    });
  });

  describe('stopRapid', () => {
    it('returns path with action=stop query param', () => {
      expect(stopRapid().path).toBe('/rw/rapid/execution?action=stop');
    });

    it('body contains stopmode field', () => {
      expect(stopRapid().body).toContain('stopmode=stop');
    });
  });

  describe('resetRapid', () => {
    it('returns path with action=resetpp query param', () => {
      expect(resetRapid().path).toBe('/rw/rapid/execution?action=resetpp');
    });

    it('body is empty string (Content-Type still sent by HttpSession)', () => {
      expect(resetRapid().body).toBe('');
    });
  });

  describe('jointTarget', () => {
    it('uses default mechunit ROB_1', () => {
      expect(jointTarget()).toBe('/rw/motionsystem/mechunits/ROB_1/jointtarget');
    });

    it('accepts a custom mechunit', () => {
      expect(jointTarget('ROB_2')).toBe('/rw/motionsystem/mechunits/ROB_2/jointtarget');
    });

    it('URL-encodes mechunit names with special characters', () => {
      expect(jointTarget('ROB 1')).toBe('/rw/motionsystem/mechunits/ROB%201/jointtarget');
    });
  });

  describe('robTarget', () => {
    it('uses defaults (ROB_1, tool0, wobj0)', () => {
      expect(robTarget()).toBe('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0');
    });

    it('accepts custom mechunit, tool, and wobj', () => {
      expect(robTarget('ROB_2', 'myTool', 'myWobj')).toBe(
        '/rw/motionsystem/mechunits/ROB_2/robtarget?tool=myTool&wobj=myWobj',
      );
    });

    it('URL-encodes tool and wobj names', () => {
      expect(robTarget('ROB_1', 'my tool', 'my wobj')).toBe(
        '/rw/motionsystem/mechunits/ROB_1/robtarget?tool=my%20tool&wobj=my%20wobj',
      );
    });
  });

  describe('loadModule', () => {
    it('returns path with task name and action=loadmod', () => {
      const { path } = loadModule('T_ROB1', '$HOME/MyMod.mod');
      expect(path).toBe('/rw/rapid/tasks/T_ROB1?action=loadmod');
    });

    it('body contains modulepath field with encoded path', () => {
      const { body } = loadModule('T_ROB1', '$HOME/MyMod.mod');
      expect(body).toContain('modulepath=');
      expect(body).toContain(encodeURIComponent('$HOME/MyMod.mod'));
    });

    it('body contains replace=false', () => {
      expect(loadModule('T_ROB1', '$HOME/mod.mod').body).toContain('replace=false');
    });

    it('URL-encodes the task name', () => {
      const { path } = loadModule('T ROB1', '$HOME/mod.mod');
      expect(path).toContain('T%20ROB1');
    });
  });

  describe('getModule', () => {
    it('returns correct path with task and module names', () => {
      expect(getModule('T_ROB1', 'MyModule')).toBe(
        '/rw/rapid/tasks/T_ROB1/modules/MyModule',
      );
    });

    it('URL-encodes both names', () => {
      expect(getModule('T ROB1', 'My Module')).toBe(
        '/rw/rapid/tasks/T%20ROB1/modules/My%20Module',
      );
    });
  });

  describe('listModules', () => {
    it('returns correct path', () => {
      expect(listModules('T_ROB1')).toBe('/rw/rapid/modules?task=T_ROB1');
    });
  });

  describe('uploadFile', () => {
    it('returns /fileservice/ path', () => {
      expect(uploadFile('$HOME/MyMod.mod')).toBe('/fileservice/$HOME/MyMod.mod');
    });

    it('strips a leading slash from the remote path', () => {
      expect(uploadFile('/$HOME/MyMod.mod')).toBe('/fileservice/$HOME/MyMod.mod');
    });

    it('does not double-encode the $ prefix used by IRC5', () => {
      const result = uploadFile('$HOME/file.mod');
      expect(result).toContain('$HOME');
      expect(result).not.toContain('%24');
    });
  });

  describe('signal', () => {
    it('returns path with network/device/name', () => {
      expect(signal('Local', 'DRV_1', 'DI_1')).toBe(
        '/rw/iosystem/signals/Local/DRV_1/DI_1',
      );
    });

    it('URL-encodes each path segment', () => {
      expect(signal('My Net', 'My Dev', 'My Sig')).toBe(
        '/rw/iosystem/signals/My%20Net/My%20Dev/My%20Sig',
      );
    });

    it('uses flat path when network and device are empty', () => {
      expect(signal('', '', 'doBwdOnPath')).toBe(
        '/rw/iosystem/signals/doBwdOnPath',
      );
    });
  });

  describe('setSignal', () => {
    it('returns path with ?action=set and no ;state suffix', () => {
      const { path } = setSignal('Local', 'DRV_1', 'DO_1');
      expect(path).toBe('/rw/iosystem/signals/Local/DRV_1/DO_1?action=set');
      expect(path).not.toContain(';state');
    });
  });

  describe('subscriptions', () => {
    it('returns /subscription', () => {
      expect(subscriptions()).toBe('/subscription');
    });
  });

  describe('fileServicePath', () => {
    it('percent-encodes special characters per segment', () => {
      expect(fileServicePath('$HOME/My Mod #1.mod')).toBe('/fileservice/$HOME/My%20Mod%20%231.mod');
      expect(fileServicePath('$TEMP/50%done.mod')).toBe('/fileservice/$TEMP/50%25done.mod');
      expect(fileServicePath('$HOME/sub dir/f.mod')).toBe('/fileservice/$HOME/sub%20dir/f.mod');
    });

    it('keeps $-prefixed volume roots literal', () => {
      expect(fileServicePath('$HOME/plain.mod')).toBe('/fileservice/$HOME/plain.mod');
      expect(fileServicePath('$HOME/plain.mod')).not.toContain('%24');
    });
  });
});

// ─── Remaining builders - table-driven URL/body checks ───────────────────────

describe('ResourceMapper - path-only builders', () => {
  const cases: Array<[string, string, string]> = [
    ['speedRatio()',                    speedRatio(),                                   '/rw/panel/speedratio'],
    ['collisionDetectionState()',       collisionDetectionState(),                      '/rw/panel/coldetstate'],
    ['activeUiInstruction()',           activeUiInstruction(),                          '/rw/rapid/uiinstr/active'],
    ['rapidSymbol(...)',                rapidSymbol('T_ROB1', 'user', 'reg1'),          '/rw/rapid/symbol/data/RAPID/T_ROB1/user/reg1'],
    ['rapidSymbolProperties(...)',      rapidSymbolProperties('T_ROB1', 'user', 'reg1'), '/rw/rapid/symbol/properties/RAPID/T_ROB1/user/reg1'],
    ['cartesianFull() default unit',    cartesianFull(),                                '/rw/motionsystem/mechunits/ROB_1/cartesian'],
    ['cartesianFull(ROB_2)',            cartesianFull('ROB_2'),                         '/rw/motionsystem/mechunits/ROB_2/cartesian'],
    ['systemInfo()',                    systemInfo(),                                   '/rw/system'],
    ['controllerIdentity()',            controllerIdentity(),                           '/ctrl/identity'],
    ['clockInfo()',                     clockInfo(),                                    '/ctrl/clock'],
    ['elogMessages() defaults',         elogMessages(),                                 '/rw/elog/0?lang=en'],
    ['elogMessages(2, de)',             elogMessages(2, 'de'),                          '/rw/elog/2?lang=de'],
    ['allSignals() defaults',           allSignals(),                                   '/rw/iosystem/signals?start=0&limit=100'],
    ['allSignals(200, 50)',             allSignals(200, 50),                            '/rw/iosystem/signals?start=200&limit=50'],
    ['networks()',                      networks(),                                     '/rw/iosystem/networks'],
    ['devices(Local)',                  devices('Local'),                               '/rw/iosystem/devices?network=Local'],
    ['deleteFile($HOME/Old.mod)',       deleteFile('$HOME/Old.mod'),                    '/fileservice/$HOME/Old.mod'],
  ];

  it.each(cases)('%s → %s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('URL-encodes symbol path segments but keeps the RAPID prefix literal', () => {
    expect(rapidSymbol('T ROB1', 'my mod', 'my var')).toBe(
      '/rw/rapid/symbol/data/RAPID/T%20ROB1/my%20mod/my%20var',
    );
  });

  it('URL-encodes the network name in devices()', () => {
    expect(devices('My Net')).toBe('/rw/iosystem/devices?network=My%20Net');
  });
});

describe('ResourceMapper - action builders (path + form body)', () => {
  const cases: Array<[string, { path: string; body: string }, string, string]> = [
    ['setControllerState(motoron)',   setControllerState('motoron'),  '/rw/panel/ctrlstate?action=setctrlstate', 'ctrl-state=motoron'],
    ['setControllerState(motoroff)',  setControllerState('motoroff'), '/rw/panel/ctrlstate?action=setctrlstate', 'ctrl-state=motoroff'],
    ['setExecutionCycle(once)',       setExecutionCycle('once'),      '/rw/rapid/execution?action=setcycle',     'cycle=once'],
    ['setExecutionCycle(forever)',    setExecutionCycle('forever'),   '/rw/rapid/execution?action=setcycle',     'cycle=forever'],
    ['setExecutionCycle(asis)',       setExecutionCycle('asis'),      '/rw/rapid/execution?action=setcycle',     'cycle=asis'],
    ['restartController(restart)',    restartController('restart'),   '/rw/panel?action=restart',                'restart-mode=restart'],
    ['restartController(istart)',     restartController('istart'),    '/rw/panel?action=restart',                'restart-mode=istart'],
    ['restartController(pstart)',     restartController('pstart'),    '/rw/panel?action=restart',                'restart-mode=pstart'],
    ['restartController(bstart)',     restartController('bstart'),    '/rw/panel?action=restart',                'restart-mode=bstart'],
    ['unlockOperationMode()',         unlockOperationMode(),          '/rw/panel/opmode?action=unlock',          ''],
    ['activateRapidTask(T_ROB2)',     activateRapidTask('T_ROB2'),    '/rw/rapid/tasks/T_ROB2?action=activate',  ''],
    ['deactivateRapidTask(T_ROB2)',   deactivateRapidTask('T_ROB2'),  '/rw/rapid/tasks/T_ROB2?action=deactivate', ''],
    ['activateAllRapidTasks()',       activateAllRapidTasks(),        '/rw/rapid/tasks?action=activate',         ''],
    ['deactivateAllRapidTasks()',     deactivateAllRapidTasks(),      '/rw/rapid/tasks?action=deactivate',       ''],
    ['requestMastership(cfg)',        requestMastership('cfg'),       '/rw/mastership/cfg?action=request',       ''],
    ['requestMastership(motion)',     requestMastership('motion'),    '/rw/mastership/motion?action=request',    ''],
    ['releaseMastership(rapid)',      releaseMastership('rapid'),     '/rw/mastership/rapid?action=release',     ''],
    ['clearElogDomain() default',     clearElogDomain(),              '/rw/elog/0?action=clear',                 ''],
    ['clearElogDomain(3)',            clearElogDomain(3),             '/rw/elog/3?action=clear',                 ''],
    ['clearAllElogs()',               clearAllElogs(),                '/rw/elog?action=clearall',                ''],
  ];

  it.each(cases)('%s', (_name, actual, expectedPath, expectedBody) => {
    expect(actual.path).toBe(expectedPath);
    expect(actual.body).toBe(expectedBody);
  });

  it('URL-encodes the task name in per-task activation paths', () => {
    expect(activateRapidTask('T ROB2').path).toBe('/rw/rapid/tasks/T%20ROB2?action=activate');
  });
});

describe('setSpeedRatio', () => {
  it('builds the setspeedratio action with the ratio in the body', () => {
    expect(setSpeedRatio(42)).toEqual({
      path: '/rw/panel/speedratio?action=setspeedratio',
      body: 'speed-ratio=42',
    });
  });

  it('clamps to 0-100', () => {
    expect(setSpeedRatio(150).body).toBe('speed-ratio=100');
    expect(setSpeedRatio(-10).body).toBe('speed-ratio=0');
  });

  it('rounds fractional ratios to integers', () => {
    expect(setSpeedRatio(49.6).body).toBe('speed-ratio=50');
    expect(setSpeedRatio(0.4).body).toBe('speed-ratio=0');
  });
});

describe('lockOperationMode', () => {
  it('sends pin and permanent=1 for a permanent lock', () => {
    expect(lockOperationMode('1234', true)).toEqual({
      path: '/rw/panel/opmode?action=lock',
      body: 'pin=1234&permanent=1',
    });
  });

  it('sends permanent=0 for a temporary lock', () => {
    expect(lockOperationMode('1234', false).body).toBe('pin=1234&permanent=0');
  });

  it('URL-encodes the pin', () => {
    expect(lockOperationMode('12&4', false).body).toBe('pin=12%264&permanent=0');
  });
});

describe('setUiInstructionParam', () => {
  it('percent-encodes the stack URL (including / % $) and the param name', () => {
    const { path, body } = setUiInstructionParam('RAPID/T_ROB1/%$104', 'Result', '42');
    expect(path).toBe(
      '/rw/rapid/uiinstr/active/param/RAPID%2FT_ROB1%2F%25%24104/Result?action=set',
    );
    expect(body).toBe('value=42');
  });

  it('percent-encodes the value', () => {
    expect(setUiInstructionParam('s', 'Result', 'a b&c').body).toBe('value=a%20b%26c');
  });
});

describe('setRapidSymbol', () => {
  it('appends ?action=set to the symbol data path', () => {
    const { path } = setRapidSymbol('T_ROB1', 'user', 'reg1', '42');
    expect(path).toBe('/rw/rapid/symbol/data/RAPID/T_ROB1/user/reg1?action=set');
  });

  it('percent-encodes RAPID-syntax values (quotes, brackets, spaces)', () => {
    expect(setRapidSymbol('T_ROB1', 'user', 's1', '"hello world"').body).toBe(
      'value=%22hello%20world%22',
    );
    expect(setRapidSymbol('T_ROB1', 'user', 'p1', '[1,0,0,0]').body).toBe(
      'value=%5B1%2C0%2C0%2C0%5D',
    );
  });
});

describe('searchRapidSymbols', () => {
  it('builds a minimal body from the required task param', () => {
    expect(searchRapidSymbols({ task: 'T_ROB1' })).toEqual({
      path: '/rw/rapid/symbols?action=search-symbol',
      body: 'task=T_ROB1',
    });
  });

  it('appends optional filters in a stable order with recursive last', () => {
    const { body } = searchRapidSymbols({
      task: 'T_ROB1',
      view: 'block',
      vartyp: 'num',
      symtyp: 'per',
      dattyp: 'num',
      regexp: '^my',
      blockurl: 'RAPID/T_ROB1',
      recursive: true,
    });
    expect(body).toBe(
      'task=T_ROB1&view=block&vartyp=num&symtyp=per&dattyp=num&regexp=%5Emy&blockurl=RAPID%2FT_ROB1&recursive=true',
    );
  });

  it('includes recursive=false explicitly but omits it when undefined', () => {
    expect(searchRapidSymbols({ task: 'T1', recursive: false }).body).toBe('task=T1&recursive=false');
    expect(searchRapidSymbols({ task: 'T1' }).body).not.toContain('recursive');
  });
});

describe('validateRapidValue', () => {
  it('builds the validate action with task, value, and datatype encoded', () => {
    expect(validateRapidValue('T_ROB1', '[1,2,3]', 'robtarget')).toEqual({
      path: '/rw/rapid/symbol/data?action=validate',
      body: 'task=T_ROB1&value=%5B1%2C2%2C3%5D&datatype=robtarget',
    });
  });
});

describe('setControllerClock', () => {
  it('builds a PUT to /ctrl/clock with all six sys-clock fields', () => {
    expect(setControllerClock(2026, 7, 9, 12, 30, 5)).toEqual({
      path: '/ctrl/clock',
      body: 'sys-clock-year=2026&sys-clock-month=7&sys-clock-day=9&sys-clock-hour=12&sys-clock-min=30&sys-clock-sec=5',
      method: 'PUT',
    });
  });
});

describe('copyFile', () => {
  it('POSTs to the SOURCE path with fs-action=copy and a bare-filename fs-newname', () => {
    expect(copyFile('$HOME/Source.mod', '$HOME/Copy.mod')).toEqual({
      path: '/fileservice/$HOME/Source.mod',
      body: 'fs-action=copy&fs-newname=Copy.mod',
    });
  });

  it('strips directory components from the destination (same-directory-only copy)', () => {
    expect(copyFile('$HOME/A.mod', '$HOME/Backup/A.mod').body).toBe('fs-action=copy&fs-newname=A.mod');
    expect(copyFile('$HOME/A.mod', 'C:\\temp\\B.mod').body).toBe('fs-action=copy&fs-newname=B.mod');
  });

  it('percent-encodes the new filename', () => {
    expect(copyFile('$HOME/A.mod', '$HOME/My Copy.mod').body).toBe(
      'fs-action=copy&fs-newname=My%20Copy.mod',
    );
  });
});

describe('createDirectory', () => {
  it('targets the parent directory fileservice path (body supplied by the caller)', () => {
    expect(createDirectory('$HOME')).toEqual({ path: '/fileservice/$HOME' });
    expect(createDirectory('$HOME/sub dir')).toEqual({ path: '/fileservice/$HOME/sub%20dir' });
  });
});
