import { describe, it, expect, expectTypeOf } from 'vitest';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsClient } from '../src/RwsClient.js';

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
    const rws2Only = [
      'setPanelLanguage', 'setControllerLanguage', 'setExternalEmergencyStop',
      'searchSignalsEx', 'validateCfgInstances',
      'getCollisionPredictionModelName', 'saveCollisionAvoidanceSnapshot',
      'loadCollisionAvoidanceConfig',
      'modifyPosition', 'resetTaskProgramPointer',
      'getDiagnostics', 'saveDiagnostics', 'saveSystemInfo',
      'registerUser', 'impersonateUser', 'isPasswordChangeAllowed', 'changePassword',
      'updateSubscriptionGroup', 'unsubscribeResource',
    ];
    const c2 = new RwsClient2('https://127.0.0.1:5466', 'u', 'p');
    const inner = new RwsClient({ host: '127.0.0.1', port: 80 });
    const a1 = new RWS1Adapter(inner, { host: '127.0.0.1', port: 80, username: 'u', password: 'p' });
    for (const m of rws2Only) {
      expect(typeof (c2 as unknown as Record<string, unknown>)[m], `RwsClient2.${m} should exist`).toBe('function');
      expect((a1 as unknown as Record<string, unknown>)[m], `RWS1Adapter.${m} should be absent`).toBeUndefined();
    }
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
