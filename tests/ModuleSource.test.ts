import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';

// getModuleSource must return what's in PROGRAM MEMORY, which is where modules
// loaded from .pgf / RobotStudio / the FlexPendant (abb-rws-vscode issue #3) —
// and any unsaved edits — live. A file on disk can be stale, so the
// save-to-TEMP round-trip (save program memory to a scratch file, read it,
// delete it) is the PRIMARY path; direct file reads are only a fallback for
// when the save endpoint itself fails.

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: Array<{ method: string; url: string; body: string }> }> {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    void collectBody(req).then(body => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const notFound = (res: http.ServerResponse): void => {
  res.writeHead(404, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
  res.end('<html><body><div class="status"><span class="code">-1073445859</span>'
    + '<span class="msg">Resource not found</span></div></body></html>');
};

describe('getModuleSource (RWS 2.0)', () => {
  it('saves to TEMP:, reads the .modx back, and deletes it — even when a (stale) HOME file exists', async () => {
    const files = new Map<string, string>();
    const deletes: string[] = [];
    let saveBody = '';
    const { server, port } = await startServer((req, res, body) => {
      const url = req.url ?? '';
      // A stale on-disk copy that must NOT shadow program memory.
      if (req.method === 'GET' && url === '/fileservice/HOME/PgfMod.mod') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('MODULE PgfMod\r\n! STALE DISK COPY\r\nENDMODULE\r\n');
        return;
      }
      if (req.method === 'POST' && url === '/rw/rapid/tasks/T_ROB1/modules/PgfMod/save') {
        saveBody = body;
        const name = /(?:^|&)name=([^&]*)/.exec(body)?.[1] ?? '';
        files.set(`/fileservice/TEMP/${name}.modx`, 'MODULE PgfMod\r\nENDMODULE\r\n');
        res.writeHead(204); res.end();
        return;
      }
      if (req.method === 'GET' && files.has(url)) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(files.get(url));
        return;
      }
      if (req.method === 'DELETE' && files.has(url)) {
        deletes.push(url); files.delete(url);
        res.writeHead(204); res.end();
        return;
      }
      notFound(res);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const src = await client.getModuleSource('T_ROB1', 'PgfMod');
      expect(src).toBe('MODULE PgfMod\r\nENDMODULE\r\n'); // program memory, not the stale disk copy
      // Extensionless collision-safe name — the controller always appends '.modx'.
      expect(saveBody).toMatch(/^name=PgfMod_[a-z0-9]+&path=TEMP:$/i);
      expect(deletes.length).toBe(1);
      expect(files.size).toBe(0);
    } finally { server.close(); }
  });

  it('falls back to the metadata-named backing file when the save endpoint fails', async () => {
    const { server, port } = await startServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/rw/rapid/tasks/T_ROB1/modules/DiskMod/save') {
        res.writeHead(403, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end('<html><body><div class="status"><span class="code">-1073445828</span></div></body></html>');
        return;
      }
      if (req.method === 'GET' && url === '/rw/rapid/tasks/T_ROB1/modules/DiskMod') {
        // Live-verified per-module shape (OmniCore RW7.21): li class="rap-module"
        // with modname / filename / attribute spans — no full path is exposed.
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end('<html><body><ul><li class="rap-module" title="T_ROB1/DiskMod">'
          + '<span class="modname">DiskMod</span><span class="filename">DiskMod.sysx</span>'
          + '<span class="attribute">sysmod</span></li></ul></body></html>');
        return;
      }
      if (req.method === 'GET' && url === '/fileservice/HOME/DiskMod.sysx') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('MODULE DiskMod\r\nENDMODULE\r\n');
        return;
      }
      notFound(res);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const src = await client.getModuleSource('T_ROB1', 'DiskMod');
      expect(src).toBe('MODULE DiskMod\r\nENDMODULE\r\n');
    } finally { server.close(); }
  });

  it('falls back to a HOME/{module}.mod guess when save fails and metadata is unavailable', async () => {
    const { server, port } = await startServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/fileservice/HOME/BareMod.mod') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('MODULE BareMod\r\nENDMODULE\r\n');
        return;
      }
      notFound(res); // save POST and module-info GET both fail
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const src = await client.getModuleSource('T_ROB1', 'BareMod');
      expect(src).toBe('MODULE BareMod\r\nENDMODULE\r\n');
    } finally { server.close(); }
  });
});

describe('getModuleSource (RWS 1.0)', () => {
  it('saves to $TEMP, reads the .mod back, and deletes it — even when a (stale) $HOME file exists', async () => {
    const calls: string[] = [];
    const files = new Map<string, string>([
      ['$HOME/user.mod', 'MODULE user\r\n! STALE DISK COPY\r\nENDMODULE\r\n'],
    ]);
    const fake = {
      readFile: async (p: string) => {
        calls.push(`read ${p}`);
        const f = files.get(p);
        if (f === undefined) { throw new RwsError(`HTTP 404 from GET ${p}`, 'MODULE_NOT_FOUND', 404); }
        return f;
      },
      deleteFile: async (p: string) => { calls.push(`delete ${p}`); files.delete(p); },
      request: async (method: string, url: string, body?: string) => {
        calls.push(`${method} ${url}`);
        if (method === 'POST' && url === '/rw/rapid/modules/user?task=T_ROB1&action=save&json=1') {
          const name = /(?:^|&)name=([^&]*)/.exec(body ?? '')?.[1] ?? '';
          // Extensionless collision-safe name — the controller always appends '.mod'.
          expect(name).toMatch(/^user_[a-z0-9]+$/i);
          expect(body).toContain('path=$TEMP');
          files.set(`$TEMP/${name}.mod`, 'MODULE user (SYSMODULE)\r\nENDMODULE\r\n');
          return { status: 204, body: '' };
        }
        return { status: 404, body: '' };
      },
    };
    const adapter = new RWS1Adapter(fake as unknown as RwsClient);
    const src = await adapter.getModuleSource('T_ROB1', 'user');
    expect(src).toBe('MODULE user (SYSMODULE)\r\nENDMODULE\r\n'); // program memory wins
    expect(calls[0]).toMatch(/^POST /);                           // save round-trip attempted FIRST
    expect(calls).not.toContain('read $HOME/user.mod');           // stale file never consulted
    expect(files.has('$HOME/user.mod')).toBe(true);               // and never touched
    expect([...files.keys()].some(k => k.startsWith('$TEMP/'))).toBe(false); // temp file cleaned up
  });

  it('falls back to the direct $HOME read when the save endpoint fails', async () => {
    const calls: string[] = [];
    const fake = {
      readFile: async (p: string) => {
        calls.push(`read ${p}`);
        if (p === '$HOME/user.mod') { return 'MODULE user\r\nENDMODULE\r\n'; }
        throw new RwsError(`HTTP 404 from GET ${p}`, 'MODULE_NOT_FOUND', 404);
      },
      deleteFile: async () => {},
      request: async (method: string, url: string) => {
        calls.push(`${method} ${url}`);
        return { status: 400, body: '' }; // save endpoint rejects
      },
    };
    const adapter = new RWS1Adapter(fake as unknown as RwsClient);
    const src = await adapter.getModuleSource('T_ROB1', 'user');
    expect(src).toBe('MODULE user\r\nENDMODULE\r\n');
    expect(calls[0]).toMatch(/^POST /);            // save attempted first …
    expect(calls).toContain('read $HOME/user.mod'); // … then the disk fallback
  });
});
