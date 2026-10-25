import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';

/**
 * Request shapes corrected after the RWS 2.0 write run of 2026-10-11 on
 * RW 7.21.4 and 8.2.1, with the controllers' recorded answers and ABB's
 * RWS 2.0 Rev L documentation as the source of truth: the breakpoint list
 * class, the task-selection gap, the validate-instances operation, the
 * hold-to-run content type on RobotWare 8, and the active UI instruction in
 * hal+json.
 */

interface Recorded { method: string; url: string; body: string; contentType: string | undefined }

async function startServer(rw: string, routes: Record<string, string> = {}): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8'), contentType: req.headers['content-type'] });
      if (url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw}"}]}`);
        return;
      }
      if (url.startsWith('/rw/mastership') && rw.startsWith('8')) { res.writeHead(410); res.end(); return; }
      const canned = routes[`${req.method} ${url}`];
      if (canned !== undefined) {
        res.writeHead(200, { 'Content-Type': canned.startsWith('{') ? 'application/hal+json;v=2.0' : 'application/xhtml+xml;v=2.0' });
        res.end(canned);
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const writes = (requests: Recorded[]): Recorded[] => requests.filter(r => r.method !== 'GET');

// The hal+json answer RW 7.21.4 gave for a running TPReadNum (2026-10-11).
const RAW_ACTIVE = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/uiinstr/" }, "self" : { "href" : "active" } } ,"status" : {"code":294912} , '
  + '"state" : [ { "_links" : { "params" : { "href" : "active/params/RAPID/T_ROB1/%25%24291656" }, "param" : { "href" : "active/param/RAPID/T_ROB1/%25%24291656/TPCompleted" } }, '
  + '"_type" : "rap-uiactive-li", "_title" : "uiactive", "instr" : "TPReadNum", "event" : "SEND", "stack" : "RAPID/T_ROB1/%$291656", "execlv" : "NORMAL", "msg" : "" } ]}';

// The breakpoint list as ABB documents it (RWS 2.0 Rev L, "Get Break Points").
const BREAKPOINTS_XHTML = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://x/rw/rapid/"/></head><body><div class="state">'
  + '<ul><li class="rap-program-breakpoint" title="breakpoint1"><span class="module-name">MainModule</span><span class="start-row">11</span><span class="start-col">3</span><span class="end-row">11</span><span class="end-col">31</span></li>'
  + '<li class="rap-program-breakpoint" title="breakpoint2"><span class="module-name">MainModule</span><span class="start-row">15</span><span class="start-col">1</span><span class="end-row">15</span><span class="end-col">20</span></li></ul></div></body></html>';
const BREAKPOINTS_HAL = '{"_links":{"base":{"href":"https://x/rw/rapid/"}},"_embedded":{"resources":[{"_type":"rap-program-breakpoint","_title":"breakpoint1","module-name":"M1","start-row":"7","start-col":"5","end-row":"7","end-col":"9"}]}}';

describe('listBreakpoints reads the documented rap-program-breakpoint entries', () => {
  it('XHTML and hal+json, module-name / start-row / start-col', async () => {
    const { server, port } = await startServer('7.21.4+417', {
      'GET /rw/rapid/tasks/T_ROB1/program/breakpoints': BREAKPOINTS_XHTML,
      'GET /rw/rapid/tasks/T_ROB2/program/breakpoints': BREAKPOINTS_HAL,
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await c.listBreakpoints('T_ROB1')).toEqual([
        { module: 'MainModule', row: 11, col: 3 },
        { module: 'MainModule', row: 15, col: 1 },
      ]);
      expect(await c.listBreakpoints('T_ROB2')).toEqual([{ module: 'M1', row: 7, col: 5 }]);
    } finally { server.close(); }
  });
});

describe('setTaskSelection is a recorded gap on RWS 2.0', () => {
  it('refuses with UNSUPPORTED_OPERATION, naming the recorded answer, and sends nothing', async () => {
    const { server, port, requests } = await startServer('7.21.4+417');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const before = requests.length;
      await expect(c.setTaskSelection(['T_ROB1'])).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      await expect(c.setTaskSelection(['T_ROB1'])).rejects.toThrow(/405 -1073414146/);
      expect(requests).toHaveLength(before);
    } finally { server.close(); }
  });
});

describe('validateCfgInstances takes operation 0 (add) or 1 (delete) only', () => {
  it('sends 0 and 1 as the form\'s operation; anything else is INVALID_ARGUMENT before a request', async () => {
    const { server, port, requests } = await startServer('7.21.4+417');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.validateCfgInstances({ operation: 1, domain: 'EIO', type: 'EIO_SIGNAL', instances: ['ZZ_PROBE_SIG'] });
      expect(writes(requests).at(-1)).toMatchObject({ url: '/rw/cfg/validate-instances', body: 'operation=1&cfgdomain=EIO&cfgtype=EIO_SIGNAL&instancescount=1&instances=ZZ_PROBE_SIG' });
      const sent = requests.length;
      for (const op of ['delete', 'add', 2, -1, '1']) {
        await expect(c.validateCfgInstances({ operation: op as unknown as 0 | 1, domain: 'EIO', type: 'EIO_SIGNAL', instances: ['X'] }))
          .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(requests).toHaveLength(sent);
    } finally { server.close(); }
  });
});

describe('holdToRun content type per generation', () => {
  it('RobotWare 8: plain application/x-www-form-urlencoded, as the controller demands; RobotWare 7: the versioned type', async () => {
    for (const [rw, expected] of [['8.2.1+1023', 'application/x-www-form-urlencoded'], ['7.21.4+417', 'application/x-www-form-urlencoded;v=2.0']] as const) {
      const { server, port, requests } = await startServer(rw);
      try {
        const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await c.connect();
        await c.holdToRun('T_ROB1', 'press');
        const sent = requests.find(r => r.url === '/rw/rapid/execution/holdtorun');
        expect(sent).toMatchObject({ method: 'POST', body: 'state=press', contentType: expected });
      } finally { server.close(); }
    }
  });
});

describe('getActiveUiInstruction reads the documented rap-uiactive-li entry', () => {
  it('parses the hal+json answer RW 7.21.4 gave for a running TPReadNum', async () => {
    const { server, port } = await startServer('7.21.4+417', { 'GET /rw/rapid/uiinstr/active': RAW_ACTIVE });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await c.getActiveUiInstruction()).toEqual({ instr: 'TPReadNum', event: 'SEND', stack: 'RAPID/T_ROB1/%$291656', execlv: 'NORMAL', msg: '' });
    } finally { server.close(); }
  });
});
