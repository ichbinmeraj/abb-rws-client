import { describe, it, expect } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';

/**
 * Writes that are optional on `IRWSAdapter` must never do nothing quietly
 * through `RobotManager`: on an adapter without the method they are refused
 * with UNSUPPORTED_OPERATION (and NOT_CONNECTED with no adapter), and on one
 * with it they are passed through with their arguments.
 */

type Call = { name: string; args: unknown[] };

function managerWith(adapter: Record<string, unknown> | null): RobotManager {
  const mgr = new RobotManager();
  (mgr as unknown as { adapter: unknown }).adapter = adapter;
  return mgr;
}

const WRITES: Array<{ name: string; call: (m: RobotManager) => Promise<unknown>; args: unknown[] }> = [
  { name: 'setNonMotionExecution', call: m => m.setNonMotionExecution(true), args: [true] },
  { name: 'setCollisionPredictionMode', call: m => m.setCollisionPredictionMode('PREDICT'), args: ['PREDICT'] },
  { name: 'setTaskSelection', call: m => m.setTaskSelection(['T_ROB1']), args: [['T_ROB1']] },
  { name: 'setVirtualTimeScale', call: m => m.setVirtualTimeScale(2), args: [2] },
];

describe('RobotManager writes that an adapter may lack', () => {
  for (const w of WRITES) {
    it(`${w.name}: UNSUPPORTED_OPERATION on an adapter without it, NOT_CONNECTED without an adapter, passed through otherwise`, async () => {
      await expect(w.call(managerWith({}))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      await expect(w.call(managerWith({}))).rejects.toThrow(new RegExp(`${w.name} is not available on this controller`));
      await expect(w.call(managerWith(null))).rejects.toMatchObject({ code: 'NOT_CONNECTED' });

      const calls: Call[] = [];
      const adapter = { [w.name]: async (...args: unknown[]) => { calls.push({ name: w.name, args }); } };
      await w.call(managerWith(adapter));
      expect(calls).toEqual([{ name: w.name, args: w.args }]);
    });
  }
});
