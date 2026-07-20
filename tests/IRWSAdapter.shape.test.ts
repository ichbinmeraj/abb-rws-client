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
