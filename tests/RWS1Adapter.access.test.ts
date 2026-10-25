import { describe, it, expect } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';

/**
 * RWS 1.0 adapter: every write holds the RobotWare 6 mastership domain ABB
 * documents for it (or, where the page names no domain, the one the adapter
 * documents choosing), around the write and through the session's access
 * manager. The client is a recorder: every call it receives is logged, and
 * its request() answers 204.
 */

function recorder(): { calls: string[]; client: RwsClient } {
  const calls: string[] = [];
  const client = new Proxy({}, {
    get: (_t, prop: string) => async (...args: unknown[]) => {
      if (prop === 'request') {
        calls.push(`${String(args[0])} ${String(args[1])}`);
        return { status: 204, body: '' };
      }
      if (prop === 'requestMastership' || prop === 'releaseMastership') {
        calls.push(`${prop} ${String(args[0])}`);
        return undefined;
      }
      calls.push(`client.${prop}`);
      return undefined;
    },
  });
  return { calls, client: client as unknown as RwsClient };
}

type Domain = 'cfg' | 'motion' | 'rapid';

interface Case { name: string; call: (a: RWS1Adapter) => Promise<unknown>; domains: Domain[] }

const CASES: Case[] = [
  { name: 'startRapid', call: a => a.startRapid(), domains: ['rapid'] },
  { name: 'resetRapid', call: a => a.resetRapid(), domains: ['rapid'] },
  { name: 'setExecutionCycle', call: a => a.setExecutionCycle('once'), domains: ['rapid'] },
  { name: 'activateRapidTask', call: a => a.activateRapidTask('T_ROB1'), domains: ['rapid'] },
  { name: 'deactivateRapidTask', call: a => a.deactivateRapidTask('T_ROB1'), domains: ['rapid'] },
  { name: 'activateAllRapidTasks', call: a => a.activateAllRapidTasks(), domains: ['rapid'] },
  { name: 'deactivateAllRapidTasks', call: a => a.deactivateAllRapidTasks(), domains: ['rapid'] },
  { name: 'loadModule', call: a => a.loadModule('T_ROB1', '$HOME/M1.mod', true), domains: ['rapid'] },
  { name: 'unloadModule', call: a => a.unloadModule('T_ROB1', 'M1'), domains: ['rapid'] },
  { name: 'setRapidVariable', call: a => a.setRapidVariable('T_ROB1', 'M1', 'n', '1'), domains: ['rapid'] },
  { name: 'setUiInstructionParam', call: a => a.setUiInstructionParam('RAPID/T_ROB1/%$1', 'Result', '1'), domains: ['rapid'] },
  { name: 'setProgramPointer', call: a => a.setProgramPointer('T_ROB1', { module: 'M1', routine: 'r' }), domains: ['rapid'] },
  { name: 'loadProgram', call: a => a.loadProgram('T_ROB1', '$HOME/p.pgf'), domains: ['rapid'] },
  { name: 'setBreakpoint', call: a => a.setBreakpoint('T_ROB1', 'M1', 4), domains: ['rapid'] },
  { name: 'setPPToCursor', call: a => a.setPPToCursor('T_ROB1', 'M1', 4, 1, 'main'), domains: ['rapid'] },
  { name: 'setModuleText', call: a => a.setModuleText('T_ROB1', 'M1', 'MODULE M1\nENDMODULE'), domains: ['rapid'] },
  { name: 'setModuleTextRange', call: a => a.setModuleTextRange('T_ROB1', 'M1', { startRow: 1, startCol: 1, endRow: 1, endCol: 2 }, 'x'), domains: ['rapid'] },
  { name: 'startProductionMode', call: a => a.startProductionMode(), domains: ['rapid'] },
  { name: 'loadCfgFile', call: a => a.loadCfgFile('$HOME/x.cfg', 'add'), domains: ['cfg'] },
  { name: 'saveCfgFile', call: a => a.saveCfgFile('SYS', '$TEMP/sys.cfg'), domains: ['cfg'] },
  { name: 'setCfgInstance', call: a => a.setCfgInstance('SYS', 'CAB_TASKS', 'T_ROB1', { Entry: 'main' }), domains: ['cfg'] },
  { name: 'setActiveTool', call: a => a.setActiveTool('ROB_1', 'tool1'), domains: ['motion'] },
  { name: 'restoreBackup', call: a => a.restoreBackup('bak'), domains: ['rapid', 'cfg'] },
  { name: 'setNonMotionExecution', call: a => a.setNonMotionExecution(true), domains: ['cfg', 'motion', 'rapid'] },
];

const isAccess = (c: string): boolean => /^(request|release)Mastership /.test(c);

describe('RWS 1.0 access: every write holds its mastership domain around the write', () => {
  it.each(CASES)('$name', async ({ call, domains }) => {
    const { calls, client } = recorder();
    await call(new RWS1Adapter(client));
    const writes = calls.filter(c => !isAccess(c));
    expect(writes).toHaveLength(1);
    expect(calls).toEqual([
      ...domains.map(d => `requestMastership ${d}`),
      writes[0],
      ...[...domains].reverse().map(d => `releaseMastership ${d}`),
    ]);
  });

  it('inside a caller\'s hold on the same domain, a write requests and releases nothing of its own', async () => {
    const { calls, client } = recorder();
    const a = new RWS1Adapter(client);
    await a.requestMastership('rapid');
    await a.setRapidVariable('T_ROB1', 'M1', 'n', '1');
    await a.loadModule('T_ROB1', '$HOME/M1.mod');
    await a.releaseMastership('rapid');
    expect(calls).toEqual([
      'requestMastership rapid',
      'client.setRapidVariable',
      'client.loadModule',
      'releaseMastership rapid',
    ]);
  });

  it('a refused mastership request fails the write before it is sent', async () => {
    const calls: string[] = [];
    const refused = Object.assign(new Error('Requested resource is held by someone else'), { code: 'MASTERSHIP_REQUIRED' });
    const client = {
      requestMastership: async (d: string) => { calls.push(`requestMastership ${d}`); throw refused; },
      releaseMastership: async (d: string) => { calls.push(`releaseMastership ${d}`); },
      setRapidVariable: async () => { calls.push('client.setRapidVariable'); },
    };
    const a = new RWS1Adapter(client as unknown as RwsClient);
    await expect(a.setRapidVariable('T_ROB1', 'M1', 'n', '1')).rejects.toBe(refused);
    expect(calls).toEqual(['requestMastership rapid']);
  });

  it('stop, the saves and the speed ratio take no mastership', async () => {
    const { calls, client } = recorder();
    const a = new RWS1Adapter(client);
    await a.stopRapid();
    await a.saveModule('T_ROB1', 'M1', '$TEMP');
    await a.saveProgram('T_ROB1', '$HOME/p');
    await a.setSpeedRatio(50);
    expect(calls.filter(isAccess)).toEqual([]);
    expect(calls).toHaveLength(4);
  });
});
