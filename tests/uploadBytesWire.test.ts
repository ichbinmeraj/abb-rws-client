import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsClient } from '../src/RwsClient.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';

/**
 * uploadFile with bytes, on the wire, against a stub server on 127.0.0.1:
 * since 1.5.4 loadProgram sends module text above ASCII as Latin-1 bytes,
 * so the bytes, Content-Length and content type must reach the controller
 * as given, also when a 401 makes the client log in and send them again.
 */

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };

async function server(handler: (s: Seen, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const e = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(e);
      handler(e, res);
    });
  });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return { s, port: (s.address() as AddressInfo).port, seen };
}

describe('RWS 2.0 uploadFile with bytes', () => {
  it('the bytes as given, their length, and the text/plain;v=2.0 type a string gets too', async () => {
    const { s, port, seen } = await server((_e, res) => { res.writeHead(201, { 'Set-Cookie': 'sess=1' }); res.end(); });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.uploadFile('$HOME/A.mod', new Uint8Array([0x4d, 0xe4, 0xf6, 0x0a]));
      await c.uploadFile('$HOME/B.mod', 'ä');
      const [bytesPut, textPut] = seen.filter(x => x.method === 'PUT');
      expect([...bytesPut.body]).toEqual([0x4d, 0xe4, 0xf6, 0x0a]);
      expect(bytesPut.headers['content-length']).toBe('4');
      expect(bytesPut.headers['content-type']).toBe('text/plain;v=2.0');
      expect([...textPut.body]).toEqual([0xc3, 0xa4]);
      expect(textPut.headers['content-type']).toBe('text/plain;v=2.0');
    } finally { s.close(); }
  });

  it('a view with an offset sends only the view', async () => {
    const { s, port, seen } = await server((_e, res) => { res.writeHead(201); res.end(); });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.uploadFile('$HOME/A.mod', new Uint8Array([1, 2, 0xe4, 0x41, 9]).subarray(2, 4));
      const put = seen.find(x => x.method === 'PUT')!;
      expect([...put.body]).toEqual([0xe4, 0x41]);
      expect(put.headers['content-length']).toBe('2');
    } finally { s.close(); }
  });

  it('a 401 on the session cookie: the client logs in again and sends the same bytes', async () => {
    let puts = 0;
    const { s, port, seen } = await server((e, res) => {
      if (e.method === 'PUT') {
        puts++;
        res.writeHead(puts === 1 ? 401 : 201);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0', 'Set-Cookie': `sess=${seen.length}` });
      res.end('<html><body></body></html>');
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      // A GET first, so the PUT goes on the session cookie.
      await (c as unknown as { req: (m: string, p: string) => Promise<string> }).req('GET', '/rw/system');
      await c.uploadFile('$HOME/A.mod', new Uint8Array([0xe4, 0x0a]));
      const putsSeen = seen.filter(x => x.method === 'PUT');
      expect(putsSeen).toHaveLength(2);
      for (const p of putsSeen) {
        expect([...p.body]).toEqual([0xe4, 0x0a]);
        expect(p.headers['content-length']).toBe('2');
      }
    } finally { s.close(); }
  });
});

describe('RWS 1.0 uploadFile with bytes', () => {
  it('the bytes go as given', async () => {
    const { s, port, seen } = await server((_e, res) => { res.writeHead(201, { 'Set-Cookie': '-http-session-=1; ABBCX=2' }); res.end(); });
    try {
      const c = new RwsClient({ host: '127.0.0.1', port, username: 'u', password: 'p', protocol: 'http' } as never);
      await c.uploadFile('$HOME/A.mod', new Uint8Array([0xe4, 0x0a]));
      const put = seen.find(x => x.method === 'PUT')!;
      expect([...put.body]).toEqual([0xe4, 0x0a]);
      expect(put.headers['content-length']).toBe('2');
    } finally { s.close(); }
  });

  it('RWS1Adapter.uploadFile hands the bytes to the client unchanged', async () => {
    const got: unknown[] = [];
    const adapter = new RWS1Adapter({ uploadModule: async (_p: string, c: unknown) => { got.push(c); } } as never);
    const bytes = new Uint8Array([0xe4]);
    await adapter.uploadFile('$HOME/A.mod', bytes);
    expect(got).toEqual([bytes]);
    expect(got[0]).toBe(bytes);
  });
});
