import { describe, it, expect } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';

/**
 * RobotState.execCycle follows setExecutionCycle. virtual-controller run 2026-10-12 found it
 * stale on RobotWare 6.16.03, 7.21.4 and 8.2.1: the controller logged the
 * change (elog 10153 "Run mode has been changed to single cycle") while the
 * state kept the old cycle until the next full refresh. After a set the
 * controller is asked once (one execution read) and the state takes what it
 * answers; a read that fails leaves the state alone and never fails the set.
 */

function managerOver(adapter: Record<string, unknown>): { mgr: RobotManager; calls: string[]; changes: number[] } {
  const calls: string[] = [];
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
  m.adapter = {
    requestMastership: async () => { calls.push('request'); },
    releaseMastership: async () => { calls.push('release'); },
    ...adapter,
  };
  m._state.connected = true;
  m._state.execCycle = 'forever';
  const changes: number[] = [];
  mgr.onDidChange(() => { changes.push(Date.now()); });
  return { mgr, calls, changes };
}

describe('RobotState.execCycle follows setExecutionCycle', () => {
  it('reads the cycle back once after the set and updates the state at once, with a change notification', async () => {
    let cycle = 'forever';
    const calls: string[] = [];
    const { mgr, changes } = managerOver({
      setExecutionCycle: async (c: string) => { calls.push(`set ${c}`); cycle = c; },
      getRapidExecutionInfo: async () => { calls.push('read'); return { state: 'stopped', cycle }; },
    });
    await mgr.setExecutionCycle('once');
    expect(mgr.state.execCycle).toBe('once');
    expect(calls).toEqual(['set once', 'read']);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    await mgr.setExecutionCycle('forever');
    expect(mgr.state.execCycle).toBe('forever');
  });

  it('takes what the controller answers, not what was asked', async () => {
    const { mgr } = managerOver({
      setExecutionCycle: async () => {},
      getRapidExecutionInfo: async () => ({ state: 'stopped', cycle: 'oncedone' }),
    });
    await mgr.setExecutionCycle('once');
    expect(mgr.state.execCycle).toBe('oncedone');
  });

  it('a failed read-back leaves the state alone and the set still succeeds', async () => {
    const { mgr } = managerOver({
      setExecutionCycle: async () => {},
      getRapidExecutionInfo: async () => { throw new Error('timeout'); },
    });
    await expect(mgr.setExecutionCycle('once')).resolves.toBeUndefined();
    expect(mgr.state.execCycle).toBe('forever');
  });

  it('a refused set reads nothing back and leaves the state alone', async () => {
    const reads: string[] = [];
    const { mgr } = managerOver({
      setExecutionCycle: async () => { throw new Error('refused'); },
      getRapidExecutionInfo: async () => { reads.push('read'); return { state: 'stopped', cycle: 'once' }; },
    });
    await expect(mgr.setExecutionCycle('once')).rejects.toThrow('refused');
    expect(reads).toEqual([]);
    expect(mgr.state.execCycle).toBe('forever');
  });
});
