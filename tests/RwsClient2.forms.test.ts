import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';
import { Logger } from '../src/Logger.js';

/**
 * RWS 2.0 wire forms for three operations already on IRWSAdapter:
 * removeBreakpoint (the controller's `clear-breakpoint` form, read on
 * RW 7.21.4 and 8.2.1 on 2026-09-29), validateRapidValue (the path ABB's
 * RAPID service documents, Rev L) and validateCfgFile (ABB's CFG service
 * "Validate CFG File", Rev L; answered on RW 7.21.4 on 2026-09-30).
 */

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface Recorded { method: string; url: string; body: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    void collectBody(req).then(body => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

/** The requests other than the edit-mastership request and release (no
 *  connect() here, so the RobotWare 7 mastership path is taken). */
const withoutAccess = (requests: Recorded[]): Recorded[] =>
  requests.filter(r => !r.url.startsWith('/rw/mastership/'));

const client = (port: number): RwsClient2 =>
  new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics');

const xhtml = (inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml">`
  + `<head><base href="http://x/"/></head><body><div class="state">${inner}</div></body></html>`;

const statusBody = (code: number, msg: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>`
  + `<div class="status"><span class="code">${code}</span><span class="msg">${msg}</span></div></body></html>`;

const decoded = (body: string): Record<string, string> => Object.fromEntries(new URLSearchParams(body));

describe('RWS 2.0 removeBreakpoint: the clear-breakpoint form', () => {
  it('POSTs program/breakpoints/remove with module, row and column (ABB\'s documented fields; the form\'s columno is refused)', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).removeBreakpoint('T_ROB1', 'M1', 12, 5);
      const sent = withoutAccess(requests);
      expect(sent).toHaveLength(1);
      expect(sent[0].method).toBe('POST');
      expect(sent[0].url).toBe('/rw/rapid/tasks/T_ROB1/program/breakpoints/remove');
      expect(sent[0].body).toBe('module=M1&row=12&column=5');
      expect(requests.some(r => r.method === 'DELETE')).toBe(false);
    } finally { server.close(); }
  });

  it('defaults column to 1 and holds edit mastership around the write', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).removeBreakpoint('T_ROB1', 'M1', 4);
      expect(decoded(withoutAccess(requests)[0].body)).toEqual({ module: 'M1', row: '4', column: '1' });
      const urls = requests.map(r => `${r.method} ${r.url}`);
      expect(urls[0]).toMatch(/^POST \/rw\/mastership\/edit\/request/);
      expect(urls.at(-1)).toMatch(/^POST \/rw\/mastership\/edit\/release/);
    } finally { server.close(); }
  });

  it('a refusal surfaces as a typed RwsError', async () => {
    const { server, port } = await startServer((q, res) => {
      if (q.url?.startsWith('/rw/mastership/')) { res.writeHead(204); res.end(); return; }
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(statusBody(-1073445879, 'The given source position is illegal'));
    });
    try {
      await expect(client(port).removeBreakpoint('T_ROB1', 'M1', 1)).rejects.toBeInstanceOf(RwsError);
    } finally { server.close(); }
  });
});

describe('RWS 2.0 validateRapidValue: POST /rw/rapid/symbols/validate', () => {
  // The fields are inferred from the RWS 1.0 form (ABB's 2.0 page names none, and
  // no 2.0 OPTIONS form has been read): this pins the client's choice, not conformance.
  it('sends the inferred task, value and datatype to the global validate resource and maps 204 to true', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await expect(client(port).validateRapidValue('T_ROB1', '[1,2,3]', 'pos')).resolves.toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/rw/rapid/symbols/validate');
      expect(decoded(requests[0].body)).toEqual({ task: 'T_ROB1', value: '[1,2,3]', datatype: 'pos' });
    } finally { server.close(); }
  });

  it('maps the controller\'s validation refusal (a 400 that is not an access refusal) to false', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(statusBody(-1073445879, 'Invalid argument'));
    });
    try {
      await expect(client(port).validateRapidValue('T_ROB1', 'nonsense', 'num')).resolves.toBe(false);
    } finally { server.close(); }
  });

  it('maps a 400 the classifier reads as a program-state refusal (a syntax error) to false, as RWS 1.0 does', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(statusBody(-1073442803, 'Syntax error'));
    });
    try {
      await expect(client(port).validateRapidValue('T_ROB1', '[1,2', 'pos')).resolves.toBe(false);
    } finally { server.close(); }
  });

  it('throws on a 400 that names an operating-mode or grant refusal', async () => {
    let code = -1073445860; // SYS_CTRL_E_MODE_REJECT
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(statusBody(code, 'Rejected'));
    });
    try {
      const mode = await client(port).validateRapidValue('T_ROB1', '42', 'num').catch((x: unknown) => x);
      expect(mode).toBeInstanceOf(RwsError);
      expect((mode as RwsError).refusal?.condition).toBe('operating-mode');
      code = -1073445867; // SYS_CTRL_E_UAS_REJECT
      const grant = await client(port).validateRapidValue('T_ROB1', '42', 'num').catch((x: unknown) => x);
      expect(grant).toBeInstanceOf(RwsError);
      expect((grant as RwsError).refusal?.condition).toBe('uas-grant');
    } finally { server.close(); }
  });

  it('maps a 2xx answer that carries an error status to false', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(statusBody(-1073445879, 'Invalid value'));
    });
    try {
      await expect(client(port).validateRapidValue('T_ROB1', 'x', 'num')).resolves.toBe(false);
    } finally { server.close(); }
  });

  it('throws a typed RwsError for a missing path instead of answering false', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(404, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(statusBody(-1073414146, 'Unspecified error'));
    });
    try {
      const e = await client(port).validateRapidValue('T_ROB1', '42', 'num').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RwsError);
      expect((e as RwsError).code).toBe('RESOURCE_NOT_FOUND');
      expect((e as RwsError).httpStatus).toBe(404);
    } finally { server.close(); }
  });

  it('throws on an access refusal and on a server error', async () => {
    let status = 400;
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(status, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(status === 400 ? statusBody(-1073445862, 'Resource held by other client') : '');
    });
    try {
      const held = await client(port).validateRapidValue('T_ROB1', '42', 'num').catch((x: unknown) => x);
      expect(held).toBeInstanceOf(RwsError);
      expect((held as RwsError).refusal).toBeDefined();
      status = 500;
      await expect(client(port).validateRapidValue('T_ROB1', '42', 'num')).rejects.toBeInstanceOf(RwsError);
    } finally { server.close(); }
  });

  it('throws a typed RwsError when the controller cannot be reached', async () => {
    const { server, port } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    await new Promise<void>(r => server.close(() => r()));
    await expect(client(port).validateRapidValue('T_ROB1', '42', 'num')).rejects.toBeInstanceOf(RwsError);
  });
});

describe('RWS 2.0 validateCfgFile: POST /rw/cfg/validate', () => {
  // The 200 body ABB's CFG service documents for "Validate CFG File" (Rev L),
  // the shape RW 7.21.4 answered on 2026-09-30.
  const documented = xhtml('<a href="" rel="self"></a><ul><li class="cfg-validate" title="EIO"><span class="domain">EIO</span></li></ul>');

  it('sends filepath then action-type, takes no hold, and resolves on the documented 200', async () => {
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(documented);
    });
    try {
      await expect(client(port).validateCfgFile('$TEMP/ZZ_PROBE.cfg', 'add-with-reset')).resolves.toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/rw/cfg/validate');
      expect(requests[0].body.startsWith('filepath=')).toBe(true);
      expect(decoded(requests[0].body)).toEqual({ filepath: '$TEMP/ZZ_PROBE.cfg', 'action-type': 'add-with-reset' });
    } finally { server.close(); }
  });

  it('defaults action-type to add and accepts a 204', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).validateCfgFile('$TEMP/x.cfg');
      expect(decoded(requests[0].body)['action-type']).toBe('add');
    } finally { server.close(); }
  });

  it('throws INVALID_ARGUMENT when a 200 answer carries an error status', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(statusBody(-1073437691, 'Duplicate instance ZZ_PROBE_DI1'));
    });
    try {
      const e = await client(port).validateCfgFile('$TEMP/x.cfg').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RwsError);
      expect((e as RwsError).code).toBe('INVALID_ARGUMENT');
      expect((e as RwsError).controllerCode).toBe(-1073437691);
      expect((e as RwsError).message).toMatch(/Duplicate instance/);
      expect((e as RwsError).httpStatus).toBeUndefined();
    } finally { server.close(); }
  });

  it('does not count a 2xx answer without a cfg-validate item as a pass', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<a href="" rel="self"></a><ul><li class="cfg-something-else" title="EIO"></li></ul>'));
    });
    try {
      const e = await client(port).validateCfgFile('$TEMP/x.cfg').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RwsError);
      expect((e as RwsError).code).toBe('UNKNOWN');
      expect((e as RwsError).message).toMatch(/not counted as a pass/);
    } finally { server.close(); }
  });

  it('passes with a cfg-validate item and logs an undocumented item class beside it', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<ul><li class="cfg-validate" title="EIO"><span class="domain">EIO</span></li><li class="cfg-note" title="x"></li></ul>'));
    });
    try {
      await expect(client(port).validateCfgFile('$TEMP/x.cfg')).resolves.toBeUndefined();
      expect(warn.mock.calls.some(c => /cfg-note/.test(String(c[0])))).toBe(true);
    } finally { warn.mockRestore(); server.close(); }
  });

  it('a refused file surfaces as a typed RwsError', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(statusBody(-1073445879, 'Invalid argument'));
    });
    try {
      const e = await client(port).validateCfgFile('$TEMP/missing.cfg').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RwsError);
      expect((e as RwsError).httpStatus).toBe(400);
    } finally { server.close(); }
  });
});

describe('RWS 2.0 setRapidVariable: a percent sign is escaped once more', () => {
  // RW 7.21.4 and 8.2.1 decode %XX in a written string a second time
  // (functional runs, 2026-09-30), so the client sends every '%' as '%25'
  // before the form encoding.
  it('sends each % as %25 before the form encoding, so the form carries %2525', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).setRapidVariable('T_ROB1', 'M1', 's', '"100% a%25b%41 c&d=e+f<g>"');
      const sent = withoutAccess(requests);
      expect(sent).toHaveLength(1);
      expect(sent[0].method).toBe('POST');
      expect(sent[0].url).toBe('/rw/rapid/symbol/RAPID/T_ROB1/M1/s/data');
      expect(decoded(sent[0].body)).toEqual({ value: '"100%25 a%2525b%2541 c&d=e+f<g>"' });
      expect(sent[0].body).toContain('%2525');
      // One decode of the form value, then the controller's own %XX decode,
      // gives the text back exactly.
      expect(decodeURIComponent(decoded(sent[0].body).value)).toBe('"100% a%25b%41 c&d=e+f<g>"');
    } finally { server.close(); }
  });

  it('leaves a value without a percent sign as it was', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).setRapidVariable('T_ROB1', 'M1', 'p', '[1,2,3]');
      expect(decoded(withoutAccess(requests)[0].body)).toEqual({ value: '[1,2,3]' });
    } finally { server.close(); }
  });
});
