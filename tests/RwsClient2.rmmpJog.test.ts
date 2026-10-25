import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';

/**
 * RWS 2.0 RMMP and jog on the wire: RobotWare 8 sends no RMMP call, the
 * request carries ABB's privilege values, a read that fails is never 'none',
 * and a jog sends exactly the jog form's fields with the controller's change
 * count. A local HTTP server stands in for the controller.
 */

interface Recorded { method: string; url: string; body: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const HAL = { 'Content-Type': 'application/hal+json;v=2.0' };
const hal = (state: Record<string, string>[]): string =>
  JSON.stringify({ _links: { base: { href: 'https://x/' } }, state });

function client(port: number, generation?: 'rw7' | 'rw8'): RwsClient2 {
  const c = new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics');
  if (generation) {
    (c as unknown as { writeAccessMode: string }).writeAccessMode = generation === 'rw8' ? 'controlstation' : 'mastership';
  }
  return c;
}

describe('RWS 2.0 RMMP on RobotWare 8: nothing is sent', () => {
  it('reads report unsupported, request and cancel throw UNSUPPORTED_OPERATION, and no request goes out', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      const c = client(port, 'rw8');
      expect(await c.getRmmpPrivilege()).toBe('unsupported');
      expect(await c.pollRmmp()).toBe('unsupported');
      const req = await c.requestRmmp().then(() => null, (e: unknown) => e as RwsError);
      expect(req).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      expect(req!.message).toContain('Remote Access at the FlexPendant');
      expect(req!.message).not.toMatch(/broken/i);
      await expect(c.cancelRmmp()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('a 410 Gone (what ABB lists for RobotWare 8.2) also reads as unsupported', async () => {
    const { server, port } = await startServer((_q, res) => { res.writeHead(410, HAL); res.end(hal([])); });
    try {
      expect(await client(port).getRmmpPrivilege()).toBe('unsupported');
      await expect(client(port).requestRmmp()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', httpStatus: 410 });
    } finally { server.close(); }
  });
});

describe('RWS 2.0 RMMP on RobotWare 7', () => {
  it('requestRmmp sends ABB\'s values: modify by default, exec for exec and for the deprecated exclusive', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(202); res.end(); });
    try {
      const c = client(port, 'rw7');
      await c.requestRmmp();
      await c.requestRmmp('exec');
      await c.requestRmmp('exclusive');
      expect(requests.map(r => `${r.method} ${r.url} ${r.body}`)).toEqual([
        'POST /users/rmmp privilege=modify',
        'POST /users/rmmp privilege=exec',
        'POST /users/rmmp privilege=exec',
      ]);
      await expect(c.requestRmmp('full' as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(requests).toHaveLength(3);
    } finally { server.close(); }
  });

  it('getRmmpPrivilege reads ABB\'s four states lower-case; another user\'s privilege reads as none', async () => {
    let answer = { privilege: 'None', rmmpheldbyme: 'false' };
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, HAL); res.end(hal([{ _type: 'user-rmmp', _title: 'rmmp', ...answer }]));
    });
    try {
      const c = client(port, 'rw7');
      expect(await c.getRmmpPrivilege()).toBe('none');
      answer = { privilege: 'pending modify', rmmpheldbyme: 'true' };
      expect(await c.getRmmpPrivilege()).toBe('pending modify');
      answer = { privilege: 'modify', rmmpheldbyme: 'true' };
      expect(await c.getRmmpPrivilege()).toBe('modify');
      answer = { privilege: 'exec', rmmpheldbyme: 'TRUE' };
      expect(await c.getRmmpPrivilege()).toBe('exec');
      answer = { privilege: 'modify', rmmpheldbyme: 'false' };
      expect(await c.getRmmpPrivilege()).toBe('none');
    } finally { server.close(); }
  });

  it('a read that fails or carries no privilege is thrown, never reported as none', async () => {
    let fail = true;
    const { server, port } = await startServer((_q, res) => {
      if (fail) {
        res.writeHead(500, HAL);
        res.end(JSON.stringify({ _links: { base: { href: 'https://x/' } }, status: { code: -1073414146, msg: 'Unspecified Error' } }));
        return;
      }
      res.writeHead(200, HAL); res.end(hal([{ _type: 'user-rmmp', _title: 'rmmp' }]));
    });
    try {
      const c = client(port, 'rw7');
      await expect(c.getRmmpPrivilege()).rejects.toBeInstanceOf(RwsError);
      fail = false;
      await expect(c.getRmmpPrivilege()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
      await expect(c.pollRmmp()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    } finally { server.close(); }
  });
});

describe('RWS 2.0 jog: exactly the jog form, with the controller\'s change count', () => {
  function motionServer(count: string | undefined, unit = 'ROB_1') {
    return startServer((req, res) => {
      if (req.method === 'GET' && req.url === '/rw/motionsystem') {
        res.writeHead(200, HAL);
        res.end(hal([{ _type: 'ms', _title: 'motionsystem', ...(count === undefined ? {} : { 'change-count': count }), 'mechunit-name': unit, 'poll-rate': '60' }]));
        return;
      }
      res.writeHead(204); res.end();
    });
  }

  it('reads GET /rw/motionsystem, then POSTs axis1..axis6, ccount and inc-mode only', async () => {
    const { server, port, requests } = await motionServer('4');
    try {
      await client(port, 'rw7').jog({ mode: 'Cartesian', axes: [0, 0, 0, 0, 0, 3], speed: 80, mechunit: 'ROB_1', incMode: 'Medium' });
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /rw/motionsystem', 'POST /rw/motionsystem/jog']);
      expect(requests[1].body).toBe('axis1=0&axis2=0&axis3=0&axis4=0&axis5=0&axis6=3&ccount=4&inc-mode=Medium');
    } finally { server.close(); }
  });

  it('defaults to the smallest increment and re-reads the count on every jog', async () => {
    const { server, port, requests } = await motionServer('0');
    try {
      const c = client(port, 'rw7');
      await c.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 });
      await c.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 });
      const posts = requests.filter(r => r.method === 'POST');
      expect(posts.map(p => p.body)).toEqual([
        'axis1=1&axis2=0&axis3=0&axis4=0&axis5=0&axis6=0&ccount=0&inc-mode=Small',
        'axis1=1&axis2=0&axis3=0&axis4=0&axis5=0&axis6=0&ccount=0&inc-mode=Small',
      ]);
      expect(requests.filter(r => r.method === 'GET')).toHaveLength(2);
    } finally { server.close(); }
  });

  it('sends no jog without a change count, or for a unit the controller still does not name after selecting it', async () => {
    const noCount = await motionServer(undefined);
    try {
      await expect(client(noCount.port, 'rw7').jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 }))
        .rejects.toMatchObject({ code: 'PARSE_ERROR' });
      expect(noCount.requests.some(r => r.method === 'POST')).toBe(false);
    } finally { noCount.server.close(); }
    const other = await motionServer('0', 'ROB_1');
    try {
      await expect(client(other.port, 'rw7').jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10, mechunit: 'ROB_2' }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      // The selection went out; this server keeps naming ROB_1, so no jog does.
      expect(other.requests.some(r => r.method === 'POST' && r.url === '/rw/motionsystem/ROB_2')).toBe(true);
      expect(other.requests.some(r => r.url === '/rw/motionsystem/jog')).toBe(false);
    } finally { other.server.close(); }
  });
});

describe('RWS 2.0 getAllowMotionControl', () => {
  it('reads the XHTML class the controller serves (plain controlstation), not only the hal+json one', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://x/"/></head>'
        + '<body><div class="state"><ul><li class="controlstation" title="allow-motion-control"><span class="is-enabled">true</span></li></ul></div></body></html>');
    });
    try {
      expect(await client(port, 'rw8').getAllowMotionControl()).toBe(true);
    } finally { server.close(); }
  });

  it('an answer with no is-enabled is a PARSE_ERROR, never false', async () => {
    const { server, port } = await startServer((_q, res) => { res.writeHead(200, HAL); res.end(hal([{ _type: 'something-else' }])); });
    try {
      await expect(client(port, 'rw8').getAllowMotionControl()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    } finally { server.close(); }
  });
});
