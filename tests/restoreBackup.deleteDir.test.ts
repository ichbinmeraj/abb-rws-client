import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import * as R2 from '../src/ResourceMapper2.js';
import { ALL_TABLES } from '../src/paths/index.js';

/**
 * A restore keeps the backup it restored unless the caller asks for it to be
 * deleted, on both generations. ABB's restore form defaults `delete-dir` to
 * true (RWS 1.0 Rev M and RWS 2.0 Rev L, Controller service, restore), so the
 * client always sends it: false unless `deleteBackup` is true. The RWS 1.0
 * side is in RWS1Adapter.specCheckRws1.test.ts.
 */

interface Recorded { method: string; url: string; body: string }

async function startServer(): Promise<{ server: http.Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const restoreForm = (requests: Recorded[]): Record<string, string> => {
  const post = requests.filter(r => r.method === 'POST' && r.url === '/ctrl/backup/restore');
  expect(post).toHaveLength(1);
  return Object.fromEntries(new URLSearchParams(post[0].body));
};

describe('RWS 2.0 restoreBackup sends delete-dir', () => {
  it('the form: delete-dir false by default, true only when asked; the path row lists the field', () => {
    expect(R2.restoreBackup('bak').body).toMatchObject({ 'delete-dir': 'false' });
    expect(R2.restoreBackup('bak', true).body).toMatchObject({ 'delete-dir': 'true' });
    expect(R2.restoreBackup('bak').body?.backup).toMatch(/BACKUP\/bak$/);
    expect(ALL_TABLES.ctrl.restoreBackup.rws2?.fields).toEqual(['backup', 'delete-dir']);
  });

  it('on the wire: keeps the backup unless deleteBackup is true', async () => {
    const { server, url, requests } = await startServer();
    try {
      const c = new RwsClient2(url, 'u', 'p');
      await c.restoreBackup('bak');
      expect(restoreForm(requests)['delete-dir']).toBe('false');
      requests.length = 0;
      await c.restoreBackup('bak', { deleteBackup: false });
      expect(restoreForm(requests)['delete-dir']).toBe('false');
      requests.length = 0;
      await c.restoreBackup('bak', { deleteBackup: true });
      expect(restoreForm(requests)['delete-dir']).toBe('true');
    } finally { server.close(); }
  });

  it('RobotManager passes deleteBackup through to the RWS 2.0 adapter', async () => {
    const { server, url, requests } = await startServer();
    try {
      const mgr = new RobotManager();
      (mgr as unknown as { adapter: unknown }).adapter = new RWS2Adapter(url, 'u', 'p');
      await mgr.restoreBackup('bak');
      expect(restoreForm(requests)['delete-dir']).toBe('false');
      requests.length = 0;
      await mgr.restoreBackup('bak', { deleteBackup: true });
      expect(restoreForm(requests)['delete-dir']).toBe('true');
    } finally { server.close(); }
  });
});
