import { describe, it, expect, expectTypeOf } from 'vitest';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';

/**
 * These tests assert at COMPILE time that the adapter classes satisfy IRWSAdapter.
 * If a method signature drifts on either side, `tsc` (run via vitest) flags it here
 * before the live tests catch it. The runtime assertions are mostly cosmetic.
 */

describe('IRWSAdapter shape', () => {
  it('RWS2Adapter is constructable and IRWSAdapter-compatible', () => {
    // Construction is offline-safe - connect() is async and not invoked here.
    const a = new RWS2Adapter('https://127.0.0.1:5466', 'u', 'p');
    // Type-level assertion: drift will surface as a compile error.
    expectTypeOf<RWS2Adapter>().toMatchTypeOf<IRWSAdapter>();
    expect(a).toBeInstanceOf(RWS2Adapter);
    expect(a).toBeInstanceOf(RwsClient2); // shim extends the protocol class
  });

  it('RWS1Adapter is IRWSAdapter-compatible', () => {
    expectTypeOf<RWS1Adapter>().toMatchTypeOf<IRWSAdapter>();
    const inner = new RwsClient({ host: '127.0.0.1', port: 80 });
    const a = new RWS1Adapter(inner, { host: '127.0.0.1', port: 80, username: 'u', password: 'p' });
    expect(a).toBeInstanceOf(RWS1Adapter);
  });

  it('parity methods exist on BOTH protocol surfaces under the same canonical name', () => {
    // Methods added by the coverage loop must not fork names between protocols:
    // one API, any controller. Guard the canonical names on both sides.
    const parity = [
      'startProductionEntry', 'getRobTarget', 'saveModule', 'listProgress', 'getProgress',
      'listServiceRoutines', 'getModuleInfo', 'getTaskProgramInfo', 'listFileVolumes',
      'saveProgram', 'loadCfgFile', 'saveCfgFile', 'setActiveTool', 'setActiveWobj',
      'loadProgram', 'setProgramPointer', 'getEventLogMessage', 'listCurrentUserGrants',
      'getTaskStructuralChangeCount', 'getTaskMotion', 'getTaskActivationRecord',
      'listEventLogDomains',
      // 2026-08-11 sweep: live-verified on BOTH generations, so both surfaces must
      // carry them (they were stranded on the concrete adapters but missing from
      // IRWSAdapter/RobotManager until the interface was completed).
      'searchSignals', 'searchIoDevices', 'renameFile', 'getModuleText',
      'getModuleTextRange', 'checkMotionChangeCount', 'saveEventLogRaw',
      'decompressPath', 'getVirtualTimeTimeslice',
      // 2026-09-25 motion sampling: the full jointtarget (robot + external axes)
      // is one resource on both generations.
      'getJointTargetFull',
      // RWS 1.0 forms RW 6.16.03 advertises (2026-09-29) for members IRWSAdapter
      // already declared: breakpoints, PP to cursor, in-place module text, the
      // subscription group update, pjoints.
      'listBreakpoints', 'setBreakpoint', 'setPPToCursor', 'setModuleText',
      'setModuleTextRange', 'updateSubscriptionGroup', 'getMechunitPjoints',
      // Common reads on both generations (2026-10-01): RWS 1.0 forms for the
      // task, CFG type and attributes, DIPC queue, network, device, module
      // routines (symbol search) and file metadata.
      'getRapidTask', 'getCfgType', 'listCfgTypeAttributes', 'getDipcQueueInfo',
      'getIoNetwork', 'getIoDeviceInfo', 'listModuleRoutines', 'getFileMetadata',
      // Niche reads on both generations (2026-10-01).
      'listSubscriptionGroups', 'getSubscriptionGroup', 'getMotionSupervision', 'getPathSupervision',
      'getMechunitSmbData', 'getMechunitMotorCalib', 'getLeadThrough',
      // Writes on both generations (2026-10-01): the backup check, PP to the
      // previous / next instruction and the jog unit selection.
      'checkRestore', 'ppPrevInst', 'ppNextInst', 'setMechunitForJogging',
      // I/O configuration reads (2026-10-03): RWS 1.0 serves them as
      // ?resource=config on the signal, network and device.
      'getSignalConfig', 'getIoNetworkConfig', 'getIoDeviceConfig',
      // ABB's RWS 1.0 (Rev M) forms for operations RwsClient2 already had, and
      // the reads ABB documents on both generations (2026-10-18): the motion
      // pointer from .../pcp, the task selection, an environment variable,
      // signal simulation and unblock, device state, keyless motors-on and
      // the base frame.
      'getMotionPointer', 'getTaskSelection', 'getEnv', 'setSignalSimulated', 'unblockSignals',
      'setIoDeviceLState', 'setKeylessMotorOn', 'setMechunitBaseFrame',
      // ABB's /ctrl/compatibility/{robotware version}, documented on both
      // generations (real controllers only).
      'getCompatibility',
      // The program unload, documented on both generations (RWS 1.0 Rev M,
      // RWS 2.0 Rev L).
      'unloadProgram',
      // Dropping one resource from a subscription group: RWS 1.0 Rev M
      // documents the same DELETE as RWS 2.0 (moved off the RWS 2.0 only list).
      'unsubscribeResource',
      // A compress or decompress job with its progress id (ABB's Location
      // /progress/{id}, RWS 1.0 Rev M and RWS 2.0 Rev L).
      'startJob',
    ];
    const c2 = new RwsClient2('https://127.0.0.1:5466', 'u', 'p');
    const inner = new RwsClient({ host: '127.0.0.1', port: 80 });
    const a1 = new RWS1Adapter(inner, { host: '127.0.0.1', port: 80, username: 'u', password: 'p' });
    for (const m of parity) {
      expect(typeof (c2 as unknown as Record<string, unknown>)[m], `RwsClient2.${m}`).toBe('function');
      expect(typeof (a1 as unknown as Record<string, unknown>)[m], `RWS1Adapter.${m}`).toBe('function');
    }
  });

  it('the endpoint-completion surface is present on RWS 2.0 and absent on RWS 1.0', () => {
    // These are declared optional on IRWSAdapter precisely because every one of
    // them answers 404 on the IRC5 controllers. Asserting the asymmetry keeps
    // "RWS 2.0 only" an explicit decision rather than an accident: if someone
    // implements one on RWS 1.0, this test tells them to update the docs too.
    // NOTE: setPanelLanguage, setControllerLanguage and searchSignalsEx were
    // MOVED off this list (2026-08-11) - the ABB RWS 1.0 reference documents their
    // query-action forms and they are now implemented + live-verified on IRC5
    // RW6.16, so they are no longer RWS-2.0-only. setModuleText,
    // setModuleTextRange and updateSubscriptionGroup moved off too (2026-10-01):
    // RW 6.16.03 advertises their RWS 1.0 forms (2026-09-29), and ABB's RWS 1.0
    // manual documents the group update. setKeylessMotorOn moved off too
    // (2026-10-18): ABB's RWS 1.0 manual documents it under /rw/cfg
    // (?action=keyless), not under /rw/panel. The rest genuinely 404 on RW6.
    const rws2Only = [
      'setExternalEmergencyStop',
      'validateCfgInstances',
      'getCollisionPredictionModelName', 'saveCollisionAvoidanceSnapshot',
      'loadCollisionAvoidanceConfig',
      'modifyPosition', 'resetTaskProgramPointer',
      'getDiagnostics', 'saveDiagnostics', 'saveSystemInfo',
      'registerUser', 'impersonateUser', 'isPasswordChangeAllowed', 'changePassword',
      // UAS user and role reads (2026-10-01): /uas answers 404 on RW 6.16.03.
      'listUasUsers', 'getUasUser', 'listUasUserGrants', 'listUasUserRoles',
      'isUasUserEnabled', 'getUasUserDescription', 'isUasUserPasswordChangeAllowed',
      'listUasRoles', 'getUasRole', 'listUasRoleGrants', 'getUasRoleDescription',
      // Certificate store (2026-10-09): ABB documents the store clear on RWS
      // 2.0 only; the IRC5 has no /ctrl/certstore.
      'clearCertificateStore',
    ];
    const c2 = new RwsClient2('https://127.0.0.1:5466', 'u', 'p');
    const inner = new RwsClient({ host: '127.0.0.1', port: 80 });
    const a1 = new RWS1Adapter(inner, { host: '127.0.0.1', port: 80, username: 'u', password: 'p' });
    for (const m of rws2Only) {
      expect(typeof (c2 as unknown as Record<string, unknown>)[m], `RwsClient2.${m} should exist`).toBe('function');
      expect((a1 as unknown as Record<string, unknown>)[m], `RWS1Adapter.${m} should be absent`).toBeUndefined();
    }
  });

  it('the RWS-1.0-only cfg delete dry-run is present on RWS 1.0 and absent on RWS 2.0', () => {
    // Mirror of the rws2Only asymmetry, the other way: the IRC5 delete dry-run
    // has no RWS 2.0 form, so it must NOT masquerade as present on the RWS 2.0
    // surface. (validateCfgFile is on both: RWS 2.0 has /rw/cfg/validate.)
    const rws1Only = ['validateInstanceBeforeDelete'];
    const c2 = new RwsClient2('https://127.0.0.1:5466', 'u', 'p');
    const inner = new RwsClient({ host: '127.0.0.1', port: 80 });
    const a1 = new RWS1Adapter(inner, { host: '127.0.0.1', port: 80, username: 'u', password: 'p' });
    for (const m of rws1Only) {
      expect(typeof (a1 as unknown as Record<string, unknown>)[m], `RWS1Adapter.${m} should exist`).toBe('function');
      expect((c2 as unknown as Record<string, unknown>)[m], `RwsClient2.${m} should be absent`).toBeUndefined();
    }
    for (const m of ['validateCfgFile']) {
      expect(typeof (a1 as unknown as Record<string, unknown>)[m], `RWS1Adapter.${m} should exist`).toBe('function');
      expect(typeof (c2 as unknown as Record<string, unknown>)[m], `RwsClient2.${m} should exist`).toBe('function');
    }
  });

  it('no surface has a UAS administration write (a user or role created, edited or deleted)', () => {
    // The client sends no UAS administration write, so none can be sent by
    // mistake and none needs a refusal test. The functional suite's
    // placeholder for one only skipped on every lane (12-system-ops, until
    // 1.5.1). Adding such a method fails this test: assert its refusal for a
    // user without UAS_UAS_ADMINISTRATION in the functional suite first. The
    // UAS writes the client has are registerUser, impersonateUser and
    // changePassword (the session's own user), and none of them matches.
    const adminWrite = /^(create|add|edit|update|modify|set|rename|delete|remove|enable|disable|assign|unassign|grant|revoke)[A-Za-z0-9]*(User|Role)/;
    const methods = (o: object): string[] => {
      const names = new Set<string>();
      for (let p: object | null = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
        for (const k of Object.getOwnPropertyNames(p)) {
          // The descriptor, not the property: reading it would run a getter.
          if (typeof Object.getOwnPropertyDescriptor(p, k)?.value === 'function') { names.add(k); }
        }
      }
      return [...names];
    };
    const inner = new RwsClient({ host: '127.0.0.1', port: 80 });
    const surfaces: Record<string, object> = {
      RWS2Adapter: new RWS2Adapter('https://127.0.0.1:5466', 'u', 'p'),
      RWS1Adapter: new RWS1Adapter(inner, { host: '127.0.0.1', port: 80, username: 'u', password: 'p' }),
      RwsClient: inner,
      RobotManager: new RobotManager(),
    };
    for (const [name, o] of Object.entries(surfaces)) {
      const all = methods(o);
      // The walk saw the surface (a control against a walk that finds nothing).
      expect(all.length, name).toBeGreaterThan(20);
      expect(all.filter(m => adminWrite.test(m)), name).toEqual([]);
    }
    expect(methods(surfaces.RWS2Adapter)).toEqual(expect.arrayContaining(['registerUser', 'impersonateUser', 'changePassword', 'listUasUsers']));
    expect(methods(surfaces.RobotManager)).toEqual(expect.arrayContaining(['registerUser', 'impersonateUser', 'changePassword']));
  });

  it('RwsClient2 has the public surface IRWSAdapter requires (basic methods present)', () => {
    const c = new RwsClient2('https://127.0.0.1:5466', 'u', 'p');
    // Spot-check a representative slice of required methods.
    const required = [
      'connect', 'disconnect', 'getControllerState', 'setControllerState',
      'getOperationMode', 'getSpeedRatio', 'setSpeedRatio',
      'getRapidExecutionState', 'startRapid', 'stopRapid', 'resetRapid',
      'listModules', 'loadModule', 'unloadModule',
      'getRapidVariable', 'setRapidVariable',
      'getJointPositions', 'getCartesianFull',
      'requestMastership', 'releaseMastership',
      'subscribe',
    ];
    for (const m of required) {
      expect(typeof (c as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });
});
