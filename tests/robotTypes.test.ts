import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';

/**
 * getRobotType on a MultiMove system. ABB's "Get robot type" (RWS 1.0 Rev M,
 * RWS 2.0 Rev L) answers one `sys-robottype` entry per robot, titled with its
 * number, the type in `robot-type`; both pages' example lists two robots. Up
 * to 1.4.x the client kept the first. `type` stays the first robot's; `types`
 * lists every robot's.
 */

// ABB's example, the same on Rev M and Rev L.
const ABB_XHTML = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>system</title><base href="http://localhost/rw/system/robottype/"/></head><body>'
  + '<div class="state"><a href="" rel="self"/><ul>'
  + '<li class="sys-robottype" title="1"><span class="robot-type">IRB 120-3/0.6</span></li>'
  + '<li class="sys-robottype" title="2"><span class="robot-type">IRB 140T-5/0.8 Type C</span></li>'
  + '</ul></div></body></html>';
// The same entries in the hal+json form a GET negotiates first (RWS 2.0) and in the ?json=1 form (RWS 1.0).
const ABB_HAL = JSON.stringify({ _links: { base: { href: 'https://localhost/rw/system/robottype/' } }, state: [
  { _type: 'sys-robottype', _title: '1', 'robot-type': 'IRB 120-3/0.6' },
  { _type: 'sys-robottype', _title: '2', 'robot-type': 'IRB 140T-5/0.8 Type C' },
] });
const ABB_RWS1_JSON = JSON.stringify({ _links: { base: { href: 'http://localhost/rw/system/robottype/' } }, _embedded: { _state: [
  { _type: 'sys-robottype', _title: '1', 'robot-type': 'IRB 120-3/0.6' },
  { _type: 'sys-robottype', _title: '2', 'robot-type': 'IRB 140T-5/0.8 Type C' },
] } });

const BOTH = { type: 'IRB 120-3/0.6', types: ['IRB 120-3/0.6', 'IRB 140T-5/0.8 Type C'] };

async function serve(status: number, body: string): Promise<{ server: http.Server; url: string; urls: string[] }> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      urls.push(`${req.method} ${req.url}`);
      res.writeHead(status, { 'Content-Type': body.startsWith('{') ? 'application/hal+json;v=2.0' : 'application/xhtml+xml;v=2.0' });
      res.end(body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, urls };
}

function rws1(status: number, body: string): { adapter: RWS1Adapter; urls: string[] } {
  const urls: string[] = [];
  const client = {
    requestMastership: async () => {},
    releaseMastership: async () => {},
    request: async (method: string, url: string) => { urls.push(`${method} ${url}`); return { status, body }; },
  };
  return { adapter: new RWS1Adapter(client as unknown as RwsClient), urls };
}

describe('getRobotType lists every robot', () => {
  for (const [form, body] of [['XHTML', ABB_XHTML], ['hal+json', ABB_HAL]] as const) {
    it(`RWS 2.0, ${form}: ABB's two robots`, async () => {
      const { server, url, urls } = await serve(200, body);
      try {
        await expect(new RwsClient2(url, 'u', 'p').getRobotType()).resolves.toEqual(BOTH);
        expect([...new Set(urls)]).toEqual(['GET /rw/system/robottype']);
      } finally { server.close(); }
    });
  }

  it('RWS 1.0: ABB\'s two robots in the ?json=1 form', async () => {
    const { adapter, urls } = rws1(200, ABB_RWS1_JSON);
    await expect(adapter.getRobotType()).resolves.toEqual(BOTH);
    expect(urls).toEqual(['GET /rw/system/robottype?json=1']);
  });

  it('one robot: one type, as before', async () => {
    const one = ABB_RWS1_JSON.replace(/,\s*\{[^{}]*IRB 140T[^{}]*\}/, '');
    const { adapter } = rws1(200, one);
    await expect(adapter.getRobotType()).resolves.toEqual({ type: 'IRB 120-3/0.6', types: ['IRB 120-3/0.6'] });
  });

  it('no standard robot (ABB: 204): an empty type and no types', async () => {
    const { adapter } = rws1(204, '');
    await expect(adapter.getRobotType()).resolves.toEqual({ type: '', types: [] });
  });

  it('RobotManager passes the list through', async () => {
    const { adapter } = rws1(200, ABB_RWS1_JSON);
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: IRWSAdapter }).adapter = adapter;
    await expect(mgr.getRobotType()).resolves.toEqual(BOTH);
  });
});
