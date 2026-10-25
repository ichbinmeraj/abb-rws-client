/**
 * Which robot is active when several connect at once and finish in any order.
 * Live 2026-10-04 on loopback VCs: an RW 8.1.1 VC connects in about 1.5 s and
 * an RW 6.16.03 VC in about 3 s, so the robot added (and made active) first is
 * often not the first to connect. Each manager's connect is stubbed and
 * finished by hand; nothing is sent.
 */

import { describe, it, expect, vi } from 'vitest';
import { MultiRobotManager } from '../src/MultiRobotManager.js';
import type { RobotManager } from '../src/RobotManager.js';

interface Gate { resolve: () => void; reject: (e: Error) => void }

/** Replace a manager's connect with one the test finishes: resolve() connects it, reject() fails it. */
function gate(mgr: RobotManager): Gate {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  vi.spyOn(mgr, 'connect').mockImplementation(async () => {
    await done;
    (mgr.state as { connected: boolean }).connected = true;
  });
  return { resolve, reject };
}

function fleet(...ids: string[]): { multi: MultiRobotManager; gates: Map<string, Gate> } {
  const multi = new MultiRobotManager();
  for (const id of ids) {
    multi.addRobot({ id, name: id, host: '127.0.0.1', port: 1, useHttps: false, username: 'u', password: 'p' });
  }
  const gates = new Map(multi.entries.map(e => [e.id, gate(e.manager)]));
  return { multi, gates };
}

/** Let the connect continuations run. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe('MultiRobotManager.connectRobot: the active robot', () => {
  it('stays on the first robot while it is still connecting and a later one connects first', async () => {
    const { multi, gates } = fleet('rw6', 'rw8');
    const both = Promise.all([multi.connectRobot('rw6'), multi.connectRobot('rw8')]);
    gates.get('rw8')!.resolve();
    await settle();
    expect(multi.activeId).toBe('rw6');
    gates.get('rw6')!.resolve();
    await both;
    expect(multi.activeId).toBe('rw6');
  });

  it('moves to a robot that connected when the active one is not connecting at all', async () => {
    const { multi, gates } = fleet('rw6', 'rw8');
    const p = multi.connectRobot('rw8');
    gates.get('rw8')!.resolve();
    await p;
    expect(multi.activeId).toBe('rw8');
  });

  it('moves to a connected robot when the active one fails to connect', async () => {
    const { multi, gates } = fleet('rw6', 'rw8');
    const rw6 = multi.connectRobot('rw6');
    const rw8 = multi.connectRobot('rw8');
    gates.get('rw8')!.resolve();
    await rw8;
    expect(multi.activeId).toBe('rw6');
    gates.get('rw6')!.reject(new Error('login refused'));
    await expect(rw6).rejects.toThrow('login refused');
    expect(multi.activeId).toBe('rw8');
  });

  it('keeps a connected active robot when another connects', async () => {
    const { multi, gates } = fleet('rw6', 'rw8');
    const rw6 = multi.connectRobot('rw6');
    gates.get('rw6')!.resolve();
    await rw6;
    const rw8 = multi.connectRobot('rw8');
    gates.get('rw8')!.resolve();
    await rw8;
    expect(multi.activeId).toBe('rw6');
  });

  it('stays on the active robot when another robot fails to connect', async () => {
    const { multi, gates } = fleet('rw6', 'rw8');
    const rw6 = multi.connectRobot('rw6');
    const rw8 = multi.connectRobot('rw8');
    gates.get('rw8')!.reject(new Error('refused'));
    await expect(rw8).rejects.toThrow('refused');
    expect(multi.activeId).toBe('rw6');
    gates.get('rw6')!.resolve();
    await rw6;
    expect(multi.activeId).toBe('rw6');
  });
});
