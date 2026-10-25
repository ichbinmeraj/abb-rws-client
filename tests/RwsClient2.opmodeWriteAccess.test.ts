import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import { setLogger } from '../src/Logger.js';

/**
 * RobotWare 8 changes the operating mode only for a control station that holds
 * write access: RW 8.2.1 answered a bare POST /rw/panel/opmode with 403
 * -1073435873 "User does not have write access", with and without the station
 * registered (2026-10-12, a probe calling the adapter directly). RobotManager
 * already held write access around the switch; the client method itself did
 * not, so any caller of RwsClient2 / RWS2Adapter was refused. The client now
 * holds it on RobotWare 8; RobotWare 7 sends the switch as before, and through
 * RobotManager the hold is counted once (one request, one release).
 */

interface Recorded { method: string; url: string; body: string }

const OPMODE = 'POST /rw/panel/opmode';
const REGISTER = 'POST /rw/controlstation/register/remote';
const WA_REQUEST = 'POST /rw/controlstation/writeaccess/request';
const WA_RELEASE = 'POST /rw/controlstation/writeaccess/release';

async function startServer(rw: string): Promise<{ server: http.Server; port: number; wire: Recorded[] }> {
  const wire: Recorded[] = [];
  let held = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      wire.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8') });
      if (url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw}"}]}`);
        return;
      }
      if (url.startsWith('/rw/mastership') && rw.startsWith('8')) { res.writeHead(410); res.end(); return; }
      if (url === '/rw/controlstation/writeaccess/request') { held = true; }
      if (url === '/rw/controlstation/writeaccess/release') { held = false; }
      // RobotWare 8 refuses the switch from a station without write access, as recorded.
      if (url === '/rw/panel/opmode' && req.method === 'POST' && rw.startsWith('8') && !held) {
        res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073435873,"msg":"rws_resource_panel.cpp[644] User does not have write access code:-1073435873 icode:-4501"}}');
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const writes = (wire: Recorded[]): string[] => wire.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.url}`);

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('setOperationMode holds write access on RobotWare 8', () => {
  it('RwsClient2 on RobotWare 8: register, request, switch, release', async () => {
    const { server, port, wire } = await startServer('8.2.1+1023');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.setOperationMode('MANR');
      expect(writes(wire)).toEqual([REGISTER, WA_REQUEST, OPMODE, WA_RELEASE]);
      expect(wire.find(r => r.url === '/rw/panel/opmode' && r.method === 'POST')?.body).toBe('opmode=man');
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RwsClient2 on RobotWare 8 inside a caller\'s write access: the switch reuses it, no request or release of its own', async () => {
    const { server, port, wire } = await startServer('8.2.1+1023');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestWriteAccess();
      await c.setOperationMode('AUTO');
      expect(writes(wire)).toEqual([REGISTER, WA_REQUEST, OPMODE]);
      await c.releaseWriteAccess();
      expect(writes(wire).at(-1)).toBe(WA_RELEASE);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RwsClient2 on RobotWare 7: the switch is sent as before, with no mastership of its own', async () => {
    const { server, port, wire } = await startServer('7.21.4+417');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.setOperationMode('MANR');
      expect(writes(wire)).toEqual([OPMODE]);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RobotManager on RobotWare 8: one request and one release around the switch (the client\'s hold nests in the manager\'s)', async () => {
    const { server, port, wire } = await startServer('8.2.1+1023');
    try {
      const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
      await adapter.connect();
      const mgr = new RobotManager();
      const m = mgr as unknown as { adapter: unknown; _state: Record<string, unknown> };
      m.adapter = adapter;
      m._state.opmode = 'AUTO';
      await mgr.setOperationMode('MANR');
      expect(writes(wire)).toEqual([REGISTER, WA_REQUEST, OPMODE, WA_RELEASE]);
      await mgr.disconnect();
    } finally { server.close(); }
  });
});
