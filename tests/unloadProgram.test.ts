import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsError } from '../src/types.js';
import { ALL_TABLES, evidenceOf } from '../src/paths/index.js';

/**
 * unloadProgram, the counterpart of a program load, as ABB documents it:
 *
 * - RWS 2.0 Rev L "Unload Program from a RAPID Task":
 *   `POST /rw/rapid/tasks/{task}/program/unload`, no body, 204, "Mastership
 *   is required" (RobotWare 7: an optional mastership query; RobotWare 8
 *   drops it);
 * - RWS 1.0 Rev M "Unload program from a rapid task":
 *   `POST /rw/rapid/tasks/{task}/program?action=unloadprog`, no data, 204;
 *   RW 6.16.03 serves the empty `unloadprog` form (2026-10-09).
 *
 * Built from those pages; no controller has answered it from this client yet.
 */

interface Recorded { method: string; url: string; body: string }

async function startServer(rw: string): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8') });
      if (url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw}"}]}`);
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

interface Call { what: string; body?: string }

function makeFake(): { calls: Call[]; client: RwsClient } {
  const calls: Call[] = [];
  const fake = {
    requestMastership: async (d: string) => { calls.push({ what: `mastership-request ${d}` }); },
    releaseMastership: async (d: string) => { calls.push({ what: `mastership-release ${d}` }); },
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return { status: 204, body: '' };
    },
  };
  return { calls, client: fake as unknown as RwsClient };
}

describe('unloadProgram: the path rows', () => {
  it('are ABB\'s requests on both generations, no fields, live (RW 6.16.03, 7.21.4, 8.2.1, 2026-10-21)', () => {
    const op = ALL_TABLES.rapid.unloadProgram;
    expect(op.rws2).toEqual({ method: 'POST', path: '/rw/rapid/tasks/{task}/program/unload' });
    expect(op.rws1).toEqual({ method: 'POST', path: '/rw/rapid/tasks/{task}/program', action: 'unloadprog' });
    expect([evidenceOf(op, 'rws1'), evidenceOf(op, 'rws2')]).toEqual(['live', 'live']);
  });
});

describe('unloadProgram on RWS 2.0', () => {
  it('RobotWare 7: one POST with no body, under edit mastership', async () => {
    const { server, port, requests } = await startServer('7.21.4+417');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.unloadProgram('T_ROB1');
      const writes = requests.filter(r => r.method === 'POST').map(r => `${r.url} [${r.body}]`);
      expect(writes).toEqual([
        '/rw/mastership/edit/request []',
        '/rw/rapid/tasks/T_ROB1/program/unload []',
        '/rw/mastership/edit/release []',
      ]);
    } finally { server.close(); }
  });

  it('the task name is encoded into the path', async () => {
    const { server, port, requests } = await startServer('7.21.4+417');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.unloadProgram('T ROB/2');
      expect(requests.some(r => r.method === 'POST' && r.url === '/rw/rapid/tasks/T%20ROB%2F2/program/unload')).toBe(true);
    } finally { server.close(); }
  });
});

describe('unloadProgram on RWS 1.0', () => {
  it('posts ?action=unloadprog with no data, under RAPID mastership', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).unloadProgram('T_ROB1');
    expect(calls).toEqual([
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/tasks/T_ROB1/program?action=unloadprog&json=1', body: '' },
      { what: 'mastership-release rapid' },
    ]);
  });
});

describe('RobotManager.unloadProgram', () => {
  interface Script { running?: boolean; unloadFails?: RwsError; noUnload?: boolean }

  function adapterFor(s: Script): { adapter: IRWSAdapter; wire: string[] } {
    const wire: string[] = [];
    const adapter: Record<string, unknown> = {
      requestMastership: async (d: string) => { wire.push(`request ${d}`); },
      releaseMastership: async (d: string) => { wire.push(`release ${d}`); },
      getRapidExecutionState: async () => (s.running ? 'running' : 'stopped'),
      stopRapid: async () => { wire.push('stop'); },
      listModules: async (t: string) => { wire.push(`list ${t}`); return ['BASE']; },
    };
    if (!s.noUnload) {
      adapter.unloadProgram = async (t: string) => { wire.push(`unload program ${t}`); if (s.unloadFails) { throw s.unloadFails; } };
    }
    return { adapter: adapter as unknown as IRWSAdapter, wire };
  }

  function managerOf(adapter: IRWSAdapter): RobotManager {
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: IRWSAdapter; _state: Record<string, unknown> };
    m.adapter = adapter;
    Object.assign(m._state, { connected: true, modulesByTask: { T_ROB1: ['BASE', 'MainModule'] } });
    return mgr;
  }

  it('holds RAPID access, sends the unload and reads the task\'s modules again', async () => {
    const { adapter, wire } = adapterFor({});
    const mgr = managerOf(adapter);
    await mgr.unloadProgram('T_ROB1');
    expect(wire).toEqual(['request rapid', 'unload program T_ROB1', 'list T_ROB1', 'release rapid']);
    expect(mgr.state.modulesByTask.T_ROB1).toEqual(['BASE']);
  });

  it('never stops a running program unasked; stopIfRunning stops it first', async () => {
    const plain = adapterFor({ running: true });
    await managerOf(plain.adapter).unloadProgram('T_ROB1');
    expect(plain.wire).not.toContain('stop');
    const asked = adapterFor({ running: true });
    await managerOf(asked.adapter).unloadProgram('T_ROB1', { stopIfRunning: true });
    expect(asked.wire).toEqual(['request rapid', 'stop', 'unload program T_ROB1', 'list T_ROB1', 'release rapid']);
  });

  it('a refusal while the program ran is explained as the running program', async () => {
    const refused = new RwsError('Refused', 'UNKNOWN', 400, undefined, -1073442809, 'Not allowed while running');
    const { adapter } = adapterFor({ running: true, unloadFails: refused });
    const err = await managerOf(adapter).unloadProgram('T_ROB1').catch((e: unknown) => e as RwsError);
    expect(err).toBeInstanceOf(RwsError);
    expect(err.code).toBe('WRONG_MODE');
    expect(err.message).toContain('unloadProgram: the controller refused it while the RAPID program was running');
    expect(err.message).toContain('The program was not unloaded.');
    expect(err.controllerCode).toBe(-1073442809);
  });

  it('an adapter without the unload: UNSUPPORTED_OPERATION, nothing sent', async () => {
    const { adapter, wire } = adapterFor({ noUnload: true });
    await expect(managerOf(adapter).unloadProgram('T_ROB1')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(wire).toEqual([]);
  });

  it('not connected: NOT_CONNECTED', async () => {
    await expect(new RobotManager().unloadProgram('T_ROB1')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
