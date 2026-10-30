import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as api from '../src/index.js';
import { ALL_TABLES } from '../src/paths/index.js';
import { OPERATIONS, OPERATION_KEYS, isOperationKey, operationArgs, type OperationKey } from '../src/operations/index.js';
// @ts-expect-error a plain .mjs script, no declarations
import { generateOperations } from '../scripts/gen-operations.mjs';
// @ts-expect-error a plain .mjs script, no declarations
import * as spec from '../scripts/operations-spec.mjs';

/**
 * The operation catalogue (1.6.0): one key per operation, the route
 * RobotManager.call takes, the parameters in call order, who takes RobotWare
 * 8 write access, and the read that verifies a write. The routes, parameters
 * and read-backs are generated (scripts/gen-operations.mjs); the decisions a
 * person made are in scripts/operations-spec.mjs and locked here.
 */

const rowKeys = Object.entries(ALL_TABLES).flatMap(([d, t]) => Object.keys(t).map(id => `${d}.${id}`));
const op = (k: string) => OPERATIONS[k as OperationKey];

describe('the generated file', () => {
  it('is what the generator makes from the tables, the signatures and the spec', async () => {
    const ts = (await import('typescript')).default;
    const { text, problems } = generateOperations({ ts, tables: ALL_TABLES, root: path.resolve('.'), spec });
    expect(problems).toEqual([]);
    const onDisk = readFileSync(path.resolve('src/operations/generated.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk, 'run npm run ops:gen').toBe(text);
  }, 120_000);
});

describe('the keys', () => {
  it('are every table row and the 13 composites, each once, in that order', () => {
    expect(OPERATION_KEYS.slice(0, rowKeys.length)).toEqual(rowKeys);
    expect(OPERATION_KEYS.slice(rowKeys.length)).toEqual([
      'rapid.pushModule', 'rapid.getModuleSource', 'ctrl.describeReturnCode', 'ctrl.getReturnCode',
      'ctrl.listDeviceGroups', 'ctrl.listControllerDevices', 'ctrl.listSystemDevices', 'ctrl.getDeviceTree',
      'ctrl.searchDevices', 'ctrl.listBackups', 'ctrl.startJob', 'ctrl.getProgress', 'ctrl.listProgress',
    ]);
    expect(rowKeys).toHaveLength(317);
    expect(new Set(OPERATION_KEYS).size).toBe(330);
    for (const k of OPERATION_KEYS) { expect(op(k).key).toBe(k); expect(k).toBe(`${op(k).domain}.${op(k).id}`); }
  });

  it('isOperationKey takes only the keys', () => {
    expect(isOperationKey('rapid.setRapidVariable')).toBe(true);
    expect(isOperationKey('rapid.pushModule')).toBe(true);
    for (const k of ['ctrl.restartController', 'rapid', 'toString', '__proto__', 42, null]) { expect(isOperationKey(k)).toBe(false); }
  });

  it('a row carries its table row: summary, tier, effect, access and the generations it is sent on', () => {
    const row = ALL_TABLES.panel.lockOperationMode;
    expect(op('panel.lockOperationMode')).toMatchObject({ kind: 'row', summary: row.summary, tier: row.tier, effect: 'write', generations: ['rws1', 'rws2'] });
    expect(op('systemMastership.requestMastership').access).toBe('mastership');
    expect(op('ctrl.searchDevices').generations).toEqual(['rws2']);
    expect(op('motion.setRobtargetForJogging').generations).toEqual(['rws1']);
    expect(op('ctrl.getSyslog').generations).toEqual([]);
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(OPERATIONS)).toBe(true);
    expect(Object.isFrozen(OPERATION_KEYS)).toBe(true);
    const e = op('rapid.setRapidVariable') as unknown as { params: Array<{ name: string }>; route: { method: string } };
    expect(() => { e.params[0].name = 'x'; }).toThrow(TypeError);
    expect(() => { e.route.method = 'x'; }).toThrow(TypeError);
  });

  it('are on the package entry', () => {
    expect(api.OPERATIONS).toBe(OPERATIONS);
    expect(api.OPERATION_KEYS).toBe(OPERATION_KEYS);
    expect(api.isOperationKey).toBe(isOperationKey);
    expect(api.operationArgs).toBe(operationArgs);
  });
});

describe('the routes', () => {
  it('give no route to the 18 access rows, the 4 subscription rows, the 14 rows no generation has and the mode confirmation', () => {
    const none = (reason: string) => OPERATION_KEYS.filter(k => op(k).route.via === 'none' && (op(k).route as { reason: string }).reason === reason);
    expect(none('access')).toHaveLength(18);
    expect(none('access').every(k => op(k).access !== undefined)).toBe(true);
    expect(none('session')).toEqual(['filesVision.createSubscription', 'filesVision.unsubscribeGroup', 'filesVision.updateSubscriptionGroup', 'filesVision.unsubscribeResource']);
    expect(none('gap')).toHaveLength(14);
    expect(none('gap').every(k => op(k).generations.length === 0)).toBe(true);
    // The operating-mode confirmation is the person's at the FlexPendant.
    expect(none('person')).toEqual(['panel.acknowledgeOperationMode']);
    expect(OPERATION_KEYS.filter(k => op(k).route.via !== 'none')).toHaveLength(330 - 37);
  });

  it('go through RobotManager where it has the method, and to the adapter where its method would hide an answer', () => {
    expect(op('rapid.setRapidVariable').route).toEqual({ via: 'manager', method: 'setRapidVariable', adapterMethod: 'setRapidVariable' });
    expect(op('rapid.stopRapid').route).toMatchObject({ via: 'manager', method: 'stopRapid' });
    // RobotManager.getMastershipStatus answers null for any error; getControllerClock answers the text alone.
    expect(op('systemMastership.getMastershipStatus').route).toEqual({ via: 'adapter', method: 'getMastershipStatus' });
    expect(op('ctrl.getControllerClock').route).toEqual({ via: 'adapter', method: 'getControllerClock' });
    // The program load is the row; RobotManager.loadProgram is the module push.
    expect(op('rapid.loadProgram').route).toEqual({ via: 'adapter', method: 'loadProgram' });
    // No adapter pre-check where the manager sends through other adapter methods.
    expect(op('rapid.pushModule').route).toEqual({ via: 'manager', method: 'loadProgram' });
    expect(op('ctrl.startJob').route).toEqual({ via: 'manager', method: 'startJob' });
    expect(op('ctrl.listDeviceGroups').route).toEqual({ via: 'manager', method: 'listDeviceGroups', adapterMethod: 'listDeviceGroups' });
    expect(op('panel.setControllerState').route).toMatchObject({ via: 'manager-by-arg', arg: 0, methods: { motoron: 'setMotorsOn', motoroff: 'setMotorsOff' } });
    expect(op('io.readSignalByName').route).toEqual({ via: 'adapter', method: 'readSignalByName' });
    expect(op('io.writeSignalByName').route).toMatchObject({ via: 'manager', method: 'writeIoSignal' });
    for (const k of ['ctrl.getVirtualTimeClock', 'ctrl.getVirtualTimeState', 'ctrl.getVirtualTimeScale']) {
      expect(op(k).route).toEqual({ via: 'adapter', method: 'getVirtualTime' });
    }
  });

  it('name parameters as the adapter does, with the types the reached method declares', () => {
    expect(op('cfgElogDipc.getCfgInstance').params.map(p => p.name)).toEqual(['domain', 'type', 'instance']);
    expect(op('rapid.setRapidVariable').params).toEqual([
      { name: 'task', optional: false, type: 'string' }, { name: 'module', optional: false, type: 'string' },
      { name: 'symbol', optional: false, type: 'string' }, { name: 'value', optional: false, type: 'string' },
    ]);
    expect(op('panel.setControllerState').params).toEqual([{ name: 'state', optional: false, type: '\'motoron\' | \'motoroff\'' }]);
    expect(op('rapid.pushModule').params.map(p => `${p.name}${p.optional ? '?' : ''}`)).toEqual(['localFilePath', 'taskName', 'options?']);
  });
});

describe('RobotWare 8 write access', () => {
  it('call takes it around exactly these writes, whose methods do not take it themselves', () => {
    expect(OPERATION_KEYS.filter(k => op(k).rw8Access === 'call')).toEqual([
      'panel.lockOperationMode', 'panel.unlockOperationMode', 'panel.setPanelLanguage',
      'rapid.saveModule', 'motion.teleportMechunit', 'motion.setRobtargetForJogging', 'motion.setCollisionPredictionMode',
      'motion.saveCollisionAvoidanceSnapshot', 'motion.loadCollisionAvoidanceConfig', 'io.writeSignal', 'io.writeSignalByName',
      'io.setSignalSimulated', 'io.unblockSignals', 'io.setNetworkLState', 'io.setIoDeviceLState', 'cfgElogDipc.clearEventLog',
      'cfgElogDipc.clearAllEventLogs', 'cfgElogDipc.saveEventLogRaw', 'cfgElogDipc.createDipcQueue', 'cfgElogDipc.sendDipcMessage',
      'cfgElogDipc.removeDipcQueue', 'ctrl.setControllerClock', 'ctrl.saveDiagnostics', 'ctrl.setControllerLanguage',
      'ctrl.saveSystemInfo', 'ctrl.createBackup', 'ctrl.setVirtualTimeScale', 'ctrl.setVirtualTimeTimeslice', 'ctrl.uploadCertificate',
      'ctrl.clearCertificateStore', 'ctrl.compressPath', 'ctrl.decompressPath', 'systemMastership.resetEnergy', 'usersUas.changePassword',
      'filesVision.uploadFile', 'filesVision.deleteFile', 'filesVision.createDirectory', 'filesVision.copyFile', 'filesVision.renameFile',
      'filesVision.refreshVisionCameras', 'rapid.getModuleSource', 'ctrl.startJob',
    ]);
  });

  it('never around a stop, motors on or off, a restart or a restore: their methods have their own way', () => {
    for (const k of ['rapid.stopRapid', 'panel.setControllerState', 'panel.restartController', 'ctrl.restoreBackup', 'rapid.startRapid']) {
      expect(op(k).rw8Access, k).toBe('self');
    }
  });

  it('never around a write in the stop direction: every stop, emergency stop and simulated panel input is sent at once', () => {
    const stops = OPERATION_KEYS.filter(k => op(k).effect === 'write' && op(k).route.via !== 'none'
      && /stop|emergency|^sim|enableswitch/i.test(op(k).id));
    expect(stops).toEqual(expect.arrayContaining([
      'rapid.stopRapid', 'panel.setExternalEmergencyStop', 'panel.simEmergencyStop', 'panel.simGeneralStop',
      'panel.simAutoStop', 'panel.simEnableSwitch',
    ]));
    for (const k of stops) { expect(op(k).rw8Access, k).not.toBe('call'); }
    expect(op('panel.setControllerState').rw8Access).not.toBe('call');
  });

  it('never around the DIPC read, a GET the controller holds open up to 280 s', () => {
    expect(op('cfgElogDipc.readDipcMessage').rw8Access).toBe('none');
  });

  it('a read never takes it', () => {
    expect(OPERATION_KEYS.filter(k => op(k).effect !== 'write' && op(k).rw8Access !== 'none')).toEqual([]);
  });
});

describe('the read-backs', () => {
  it('every routed write names its read or null, and no read has one', () => {
    const writes = OPERATION_KEYS.filter(k => op(k).effect === 'write' && op(k).route.via !== 'none');
    expect(writes).toHaveLength(98);
    expect(Object.keys(spec.READ_BACKS).sort()).toEqual([...writes].sort());
    expect(OPERATION_KEYS.filter(k => op(k).effect !== 'write' && op(k).readBack !== null)).toEqual([]);
  });

  it('a read-back is a routed read, takes only the write\'s parameters, and covers the generations it lists', () => {
    for (const k of OPERATION_KEYS) {
      const rb = op(k).readBack;
      if (!rb) { continue; }
      const target = op(rb.key);
      expect(target.effect, k).toBe('read');
      expect(target.route.via, k).not.toBe('none');
      for (const a of rb.args) { expect(op(k).params.map(p => p.name), k).toContain(a); }
      for (const g of rb.generations) { expect(target.generations, k).toContain(g); expect(op(k).generations, k).toContain(g); }
    }
  });

  it('pairs a write with the read of the same thing', () => {
    expect(op('rapid.setRapidVariable').readBack).toEqual({ key: 'rapid.getRapidVariable', args: ['task', 'module', 'symbol'], generations: ['rws1', 'rws2'] });
    expect(op('io.writeSignal').readBack).toEqual({ key: 'io.readSignal', args: ['network', 'device', 'name'], generations: ['rws1', 'rws2'] });
    expect(op('panel.setControllerState').readBack?.key).toBe('panel.getControllerState');
    expect(op('filesVision.copyFile').readBack).toMatchObject({ key: 'filesVision.getFileMetadata', args: ['destPath'] });
    // The lock state is an RWS 2.0 read: on RobotWare 6 a lock is not read back.
    expect(op('panel.lockOperationMode').readBack).toEqual({ key: 'panel.getOperationModeLockState', args: [], generations: ['rws2'] });
    for (const k of ['rapid.stepRapid', 'filesVision.deleteFile', 'panel.restartController', 'rapid.resetRapid']) { expect(op(k).readBack, k).toBeNull(); }
  });
});

describe('the composites', () => {
  it('send table rows, and each states what it is', () => {
    for (const k of OPERATION_KEYS.filter(x => op(x).kind === 'composite')) {
      const c = op(k);
      expect(rowKeys).not.toContain(k);
      for (const s of c.sends ?? []) { expect(rowKeys, k).toContain(s); }
      expect(c.sends!.length > 0 || typeof c.wire === 'string', k).toBe(true);
      expect(c.summary.length, k).toBeGreaterThan(10);
    }
    expect(op('rapid.pushModule')).toMatchObject({ effect: 'write', note: expect.stringContaining('PC that runs the client') });
    // What RobotManager.loadProgram sends, in order; it deletes nothing.
    expect(op('rapid.pushModule').sends).toEqual([
      'rapid.getRapidExecutionState', 'rapid.stopRapid', 'rapid.listModules', 'rapid.unloadModule',
      'filesVision.uploadFile', 'rapid.loadModule', 'rapid.resetRapid',
    ]);
    // The save round trip through TEMP, and the module info the RWS 2.0 fallback reads.
    expect(op('rapid.getModuleSource')).toMatchObject({
      effect: 'write',
      sends: ['rapid.saveModule', 'filesVision.readFile', 'filesVision.deleteFile', 'rapid.getModuleInfo'],
    });
    expect(op('ctrl.listBackups')).toMatchObject({ effect: 'read', wire: 'GET /fileservice/BACKUP' });
  });
});

describe('operationArgs', () => {
  it('puts arguments given by name in call order', () => {
    expect(operationArgs('rapid.setRapidVariable', { value: '5', task: 'T_ROB1', symbol: 'n', module: 'M' })).toEqual(['T_ROB1', 'M', 'n', '5']);
  });

  it('leaves trailing optional ones out, and an optional one before a given one undefined', () => {
    expect(operationArgs('rapid.pushModule', { localFilePath: 'a.mod', taskName: 'T_ROB1' })).toEqual(['a.mod', 'T_ROB1']);
    expect(operationArgs('cfgElogDipc.getEventLog', { lang: 'en' })).toEqual([undefined, 'en']);
  });

  it('refuses a name the operation does not take, a missing required one and an unknown key', () => {
    expect(() => operationArgs('rapid.setRapidVariable', { task: 'T', module: 'M', symbol: 's', value: '1', extra: 1 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => operationArgs('rapid.setRapidVariable', { task: 'T' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => operationArgs('rapid.nope' as OperationKey, {})).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
