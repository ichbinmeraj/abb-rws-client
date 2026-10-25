/**
 * RobotManager's simulation-panel wrappers on a connection without the RWS
 * 2.0 simulation endpoints: typed as UNSUPPORTED_OPERATION (like every other
 * RWS 2.0-only write through the manager), before anything reaches the
 * adapter. Before connect: NOT_CONNECTED.
 */

import { describe, it, expect, vi } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsError } from '../src/types.js';

const SIM_CALLS: Array<[string, (m: RobotManager) => Promise<void>]> = [
  ['simEmergencyStop', m => m.simEmergencyStop()],
  ['simResetEmergencyStop', m => m.simResetEmergencyStop()],
  ['simGeneralStop', m => m.simGeneralStop(true)],
  ['simAutoStop', m => m.simAutoStop(false)],
  ['simEnableSwitch', m => m.simEnableSwitch(true)],
  ['teleportMechunit', m => m.teleportMechunit('ROB_1', [0, 0, 0, 0, 30, 0])],
];

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(RwsError);
  return e as RwsError;
}

describe('RobotManager simulation panel gate', () => {
  it('refuses every sim call on an RWS 1.0 connection as UNSUPPORTED_OPERATION, sending nothing', async () => {
    const mgr = new RobotManager();
    // An RWS 1.0 adapter that would record any call reaching it.
    const fake = Object.create(RWS1Adapter.prototype) as Record<string, unknown>;
    const spies = Object.fromEntries(SIM_CALLS.map(([name]) => [name, vi.fn(async () => {})]));
    Object.assign(fake, spies);
    (mgr as unknown as { adapter: unknown }).adapter = fake;

    for (const [name, call] of SIM_CALLS) {
      const err = await rejection(call(mgr));
      expect(err.code, name).toBe('UNSUPPORTED_OPERATION');
      expect(err.message, name).toMatch(/RWS 1\.0 has no simulation endpoints/);
      expect(err.message, name).toMatch(/Nothing was sent/);
    }
    for (const spy of Object.values(spies)) { expect(spy).not.toHaveBeenCalled(); }
  });

  it('refuses every sim call before connect as NOT_CONNECTED', async () => {
    const mgr = new RobotManager();
    for (const [name, call] of SIM_CALLS) {
      const err = await rejection(call(mgr));
      expect(err.code, name).toBe('NOT_CONNECTED');
    }
  });
});
