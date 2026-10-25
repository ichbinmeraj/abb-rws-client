import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import { setLogger } from '../src/Logger.js';

/**
 * Mastership taken with `requestMastershipWithId` (RobotWare 7) is remembered
 * by the session that took it, and `disconnect()` releases every token still
 * held before it logs out, so a token-held hold no longer outlives the
 * session that took it. A token released with `releaseMastershipWithId` is
 * forgotten; a release that fails at disconnect is logged and the logout still
 * goes out.
 */

interface Recorded { method: string; url: string; body: string }

async function startRw7(opts: { releaseStatus?: number } = {}): Promise<{ server: http.Server; port: number; wire: Recorded[] }> {
  const wire: Recorded[] = [];
  let nextId = 41;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      wire.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8') });
      if (url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"7.21.4+417"}]}');
        return;
      }
      if (url.endsWith('/request-with-id')) {
        nextId += 1;
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"msh-request-with-id","mastership-id":"${nextId}"}]}`);
        return;
      }
      if (url.endsWith('/release-with-id') && opts.releaseStatus) {
        res.writeHead(opts.releaseStatus, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445880,"msg":"The resource is not held by caller"}}');
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const lines = (wire: Recorded[]): string[] => wire.map(r => `${r.method} ${r.url}`);
const releases = (wire: Recorded[]): Recorded[] => wire.filter(r => r.url.endsWith('/release-with-id'));

const warnings: string[] = [];
afterEach(() => { warnings.length = 0; setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('with-id mastership tokens are tracked and released on disconnect', () => {
  it('a token still held at disconnect is released with its id, before /logout', async () => {
    const { server, port, wire } = await startRw7();
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const edit = await c.requestMastershipWithId('rapid');
      const motion = await c.requestMastershipWithId('motion');
      expect(edit).toBe(42);
      expect(motion).toBe(43);
      await c.disconnect();
      const l = lines(wire);
      expect(releases(wire).map(r => `${r.url} ${r.body}`)).toEqual([
        '/rw/mastership/edit/release-with-id mastershipid=42',
        '/rw/mastership/motion/release-with-id mastershipid=43',
      ]);
      expect(l.indexOf('POST /rw/mastership/motion/release-with-id')).toBeLessThan(l.indexOf('GET /logout'));
      expect(l.at(-1)).toBe('GET /logout');
    } finally { server.close(); }
  });

  it('a token released by the caller is forgotten: disconnect releases nothing for it', async () => {
    const { server, port, wire } = await startRw7();
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const id = await c.requestMastershipWithId('cfg');
      await c.releaseMastershipWithId('cfg', id);
      await c.disconnect();
      expect(releases(wire)).toHaveLength(1);
      expect(releases(wire)[0].body).toBe(`mastershipid=${id}`);
    } finally { server.close(); }
  });

  it('a release the controller refuses at disconnect is logged as a warning and the logout still goes out', async () => {
    const { server, port, wire } = await startRw7({ releaseStatus: 403 });
    try {
      setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastershipWithId('rapid');
      await c.disconnect();
      expect(releases(wire)).toHaveLength(1);
      expect(lines(wire).at(-1)).toBe('GET /logout');
      expect(warnings.some(w => /release-with-id|mastership id 42/i.test(w) && /403|not held/i.test(w))).toBe(true);
      // The token is not kept across the session that just ended.
      await c.connect();
      await c.disconnect();
      expect(releases(wire)).toHaveLength(1);
    } finally { server.close(); }
  });

  it('a caller release the controller refuses keeps the token, and disconnect() releases it again, before /logout', async () => {
    const { server, port, wire } = await startRw7({ releaseStatus: 403 });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const id = await c.requestMastershipWithId('rapid');
      await expect(c.releaseMastershipWithId('rapid', id)).rejects.toMatchObject({ httpStatus: 403 });
      await c.disconnect();
      expect(releases(wire).map(r => r.body)).toEqual([`mastershipid=${id}`, `mastershipid=${id}`]);
      expect(lines(wire).at(-1)).toBe('GET /logout');
    } finally { server.close(); }
  });

  it('through RobotManager: the adapter it disconnects releases the tokens it took', async () => {
    const { server, port, wire } = await startRw7();
    try {
      const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
      await adapter.connect();
      const mgr = new RobotManager();
      (mgr as unknown as { adapter: unknown }).adapter = adapter;
      const id = await mgr.requestMastershipWithId('rapid');
      expect(id).toBe(42);
      await mgr.disconnect();
      expect(releases(wire).map(r => r.body)).toEqual(['mastershipid=42']);
      expect(lines(wire).at(-1)).toBe('GET /logout');
    } finally { server.close(); }
  });
});
