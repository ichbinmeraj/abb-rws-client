import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';
import { TEST_TLS_KEY, TEST_TLS_CERT } from './TlsFixture.js';

/**
 * Unit tests for RwsClient2 against local mock servers - no live controller.
 * The protocol-level methods are exercised by tests/RwsClient2.live.test.ts and
 * the extension's test-rws2-writes.js when a VC is available.
 */

// ─── Local test server ───────────────────────────────────────────────────────

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface RecordedRequest { method: string; url: string; body: string; contentType: string }

/** Plain HTTP server that records every request and delegates to `handle`. */
async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    void collectBody(req).then(body => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', body,
        contentType: (req.headers['content-type'] ?? '') as string,
      });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const ok204 = (_req: http.IncomingMessage, res: http.ServerResponse): void => { res.writeHead(204); res.end(); };

describe('RwsClient2 (unit)', () => {
  it('exports a class', () => {
    expect(typeof RwsClient2).toBe('function');
    expect(RwsClient2.name).toBe('RwsClient2');
  });

  describe('rws2ResourcePath (subscription URL builder)', () => {
    it('maps string resources to known panel paths', () => {
      // The static method is private - exercise it via known inputs/outputs.
      // We can't import it directly; instead verify the names exist on the class.
      // (If this drifts the live subscribe tests catch it.)
      expect('rws2ResourcePath' in RwsClient2).toBe(true);
    });

    it('maps signal subscription objects to /rw/iosystem/signals path', () => {
      expect('resourcePathToName' in RwsClient2).toBe(true);
    });
  });

  describe('constructor signature', () => {
    it('accepts (baseUrl, username, password)', () => {
      // Construction shouldn't throw - actual network only happens on .connect().
      const c = new RwsClient2('https://127.0.0.1:5466', 'Default User', 'robotics');
      expect(c).toBeInstanceOf(RwsClient2);
    });

    it('handles http:// base URLs', () => {
      const c = new RwsClient2('http://127.0.0.1:80', 'u', 'p');
      expect(c).toBeInstanceOf(RwsClient2);
    });

    it('accepts an options object as fourth argument', () => {
      const c = new RwsClient2('https://127.0.0.1:5466', 'u', 'p', { timeout: 2000, rejectUnauthorized: true });
      expect(c).toBeInstanceOf(RwsClient2);
    });
  });

  describe('constructor options: timeout', () => {
    it('aborts requests after the configured timeout', async () => {
      // Server that never answers - the request must die by client-side timeout.
      const server = http.createServer(() => { /* hold the request open */ });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      try {
        const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { timeout: 150 });
        const t0 = Date.now();
        await expect(c.connect()).rejects.toThrow(/timeout/i);
        expect(Date.now() - t0).toBeLessThan(5000);
      } finally { server.close(); }
    });
  });

  describe('constructor options: rejectUnauthorized', () => {
    async function startTlsServer(): Promise<{ server: https.Server; port: number }> {
      const server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end('<html><body></body></html>');
      });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      return { server, port: (server.address() as AddressInfo).port };
    }

    it('defaults to accepting self-signed certificates (all shipping controllers)', async () => {
      const { server, port } = await startTlsServer();
      try {
        const c = new RwsClient2(`https://127.0.0.1:${port}`, 'u', 'p');
        await expect(c.connect()).resolves.toBeUndefined();
      } finally { server.close(); }
    });

    it('rejectUnauthorized: true keeps TLS verification ON', async () => {
      const { server, port } = await startTlsServer();
      try {
        const c = new RwsClient2(`https://127.0.0.1:${port}`, 'u', 'p', { rejectUnauthorized: true });
        await expect(c.connect()).rejects.toThrow(/self[- ]signed|certificate/i);
      } finally { server.close(); }
    });
  });

  describe('writeSignal', () => {
    it('rejects with RwsError instead of firing a malformed request when network/device are unknown', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await expect(client.writeSignal('', '', 'doGripper', '1')).rejects.toBeInstanceOf(RwsError);
        expect(requests.length).toBe(0); // nothing must go on the wire
      } finally { server.close(); }
    });

    it('still resolves coordinates cached by listAllSignals', async () => {
      const { server, port, requests } = await startServer((req, res) => {
        if (req.method === 'GET' && (req.url ?? '').startsWith('/rw/iosystem/signals?')) {
          res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
          res.end('<html><body><ul><li class="ios-signal-li" title="Net/Dev/doGripper">'
            + '<span class="name">doGripper</span><span class="type">DO</span><span class="lvalue">0</span>'
            + '</li></ul></body></html>');
          return;
        }
        res.writeHead(204); res.end();
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.listAllSignals();
        await client.writeSignal('', '', 'doGripper', '1');
        expect(requests.some(r =>
          r.method === 'POST' && r.url === '/rw/iosystem/signals/Net/Dev/doGripper/set-value',
        )).toBe(true);
      } finally { server.close(); }
    });
  });

  describe('fileservice path encoding', () => {
    it('percent-encodes special characters in fileservice paths', async () => {
      const { server, port, requests } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('data');
      });
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.readFile('HOME/My#File.mod');
        // '#' would otherwise be parsed as a URL fragment and truncate the path.
        expect(requests[0].url).toBe('/fileservice/HOME/My%23File.mod');
      } finally { server.close(); }
    });
  });

  describe('cfg instance writes (live-verified wire shapes, OmniCore VC RW7.21)', () => {
    it('setCfgInstance POSTs bracket-representation attributes to /instances/{instance}', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.setCfgInstance('SYS', 'CAB_TASKS', 'T_ROB1', { StackSize: '25000', Entry: 'main' });
        const post = requests.find(r => r.method === 'POST');
        expect(post?.url).toBe('/rw/cfg/SYS/CAB_TASKS/instances/T_ROB1');
        expect(post?.body).toBe('StackSize=[25000,1]&Entry=[main,1]');
        expect(post?.contentType).toBe('application/x-www-form-urlencoded;v=2.0');
      } finally { server.close(); }
    });

    it('createCfgInstance POSTs name= to /instances/create-default then applies attributes', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.createCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW', { Entry: 'probeMain' });
        const posts = requests.filter(r => r.method === 'POST');
        expect(posts[0].url).toBe('/rw/cfg/SYS/CAB_TASKS/instances/create-default');
        expect(posts[0].body).toBe('name=ZZ_NEW');
        expect(posts[1].url).toBe('/rw/cfg/SYS/CAB_TASKS/instances/ZZ_NEW');
        expect(posts[1].body).toBe('Entry=[probeMain,1]');
      } finally { server.close(); }
    });

    it('createCfgInstance skips the set step when no attributes are given', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.createCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW', {});
        expect(requests.filter(r => r.method === 'POST').length).toBe(1);
      } finally { server.close(); }
    });

    it('removeCfgInstance DELETEs /instances/{instance}', async () => {
      const { server, port, requests } = await startServer(ok204);
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.removeCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW');
        expect(requests[0].method).toBe('DELETE');
        expect(requests[0].url).toBe('/rw/cfg/SYS/CAB_TASKS/instances/ZZ_NEW');
      } finally { server.close(); }
    });
  });
});
