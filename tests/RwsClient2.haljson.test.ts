import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';

/**
 * RWS 2.0 HAL JSON primary path + XHTML fallback.
 *
 * All JSON fixtures below are captured from a live OmniCore VC RW7.21
 * (2026-07-09, GET with Accept: application/hal+json;v=2.0) - the shapes are
 * real controller output, not hand-written approximations.
 */

const HAL_CT = 'application/hal+json;v=2.0';
const XHTML_CT = 'application/xhtml+xml;v=2.0';

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface RecordedRequest { method: string; url: string; body: string; accept: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    void collectBody(req).then(body => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', body,
        accept: (req.headers['accept'] ?? '') as string,
      });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const json200 = (res: http.ServerResponse, body: string): void => {
  res.writeHead(200, { 'Content-Type': HAL_CT });
  res.end(body);
};

// ─── Live-captured HAL fixtures (OmniCore VC RW7.21, 2026-07-09) ─────────────

const FIX = {
  ctrlState: '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/panel/ctrl-state/" }, "self" : { "href" : "" } } ,"status" : {"code":294912} , "state" : [ { "_type" : "pnl-ctrlstate", "_title" : "ctrl-state", "ctrlstate" : "motoroff" } ]}',
  tasks: '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "tasks" } }  , "_embedded" : { "resources" : [ { "_links" : { "self" : { "href" : "tasks/spy" } }, "_type" : "rap-tasks-spy-li", "_title" : "spy" }, { "_links" : { "self" : { "href" : "tasks/T_ROB1" } }, "_type" : "rap-task-li", "_title" : "T_ROB1" , "name":"T_ROB1" , "type":"normal" , "taskstate":"linked" , "excstate": "ready" , "active":"On" , "motiontask":"TRUE"} ] }}',
  modules: '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "tasks/T_ROB1/modules" } } ,"status" : {"code":294912} , "state" : [ { "_type" : "rap-module-info-li", "_title" : "T_ROB1/BASE", "name" : "BASE", "type" : "SysMod" }, { "_type" : "rap-module-info-li", "_title" : "T_ROB1/MainModule", "name" : "MainModule", "type" : "ProgMod" } ]}',
  jointtarget: '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/motionsystem/mechunits/ROB_1/jointtarget/" }, "self" : { "href" : "" } } ,"status" : {"code":294912} , "state" : [ { "_type" : "ms-jointtarget", "_title" : "ROB_1", "rax_1" : "10", "rax_2" : "15", "rax_3" : "-10", "rax_4" : "20", "rax_5" : "30", "rax_6" : "45", "eax_a" : "0", "eax_b" : "0", "eax_c" : "0", "eax_d" : "0", "eax_e" : "0", "eax_f" : "0" } ]}',
  signals: '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/iosystem/" },"self" : { "href" : "signals?start=0&amp;limit=3" }  , "next" : { "href" : "signals?start=3&amp;limit=3" }   }  , "_embedded" : { "resources" : [  { "_links" : { "self" : { "href" : "signals/Net/Dev/doGripper" } }, "_type" : "ios-signal-li", "_title" : "Net/Dev/doGripper", "name" : "doGripper", "type" : "DO", "category" : "user", "lvalue" : "1", "lstate" : "not simulated" } , { "_links" : { "self" : { "href" : "signals/Net/Dev/diSensor" } }, "_type" : "ios-signal-li", "_title" : "Net/Dev/diSensor", "name" : "diSensor", "type" : "DI", "category" : "user", "lvalue" : "0", "lstate" : "not simulated" } ] }}',
  elog: '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/elog/" },"self" : { "href" : "0?lang=en" } }  , "_embedded" : { "resources" : [ { "_links" : { "self": { "href": "0/1?lang=en"} }, "_type":"elog-message-li", "_title":"/rw/elog/0/1"  ,"msgtype":"1", "code":"10046", "tstamp":"2026-07-08 T 18:04:04", "title":"System reset", "desc":"Loading the original system installation settings.", "conseqs":"", "causes":"", "actions":"", "argc":"0" } ] }}',
  system: '{ "_links" : { "base": { "href": "https://127.0.0.1:5466/rw/system/" }, "self" : { "href" : "" } }  , "state" : [ { "_type":"sys-system", "_title":"system", "major":"7", "minor":"21", "name":"IRB1600_6_120_3", "rwversion":"7.21.0+229", "sysid":"{57540804-EA1F-4397-8EA2-5B2B1E729D97}", "starttm":"2026-07-08 T 18:04:15" } ], "_embedded" : { "resources" : [ { "_links" : { "self" : { "href" : "options" } }, "_type" : "sys-options-li", "_title" : "options", "options" : [ { "_type" : "sys-options", "_title" : "0", "option" : "RobotControl Base" } , { "_type" : "sys-options", "_title" : "1", "option" : "English" } ] } ] }}',
  taskNotFound: '{ "_links":{ "base": { "href": "https://127.0.0.1:5466/" } } ,"status" : {"code":-1073445879, "msg":"rws_resource_rapid_task.cpp[620] ERROR: Task NO_SUCH_TASK does not exist;  code:-1073445879 icode:-1"}}',
};

// ─── Primary path: HAL JSON ──────────────────────────────────────────────────

describe('RwsClient2 HAL JSON primary path', () => {
  it('GETs send Accept: application/hal+json;v=2.0 and parse the state[] shape', async () => {
    const { server, port, requests } = await startServer((_req, res) => json200(res, FIX.ctrlState));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const state = await client.getControllerState();
      expect(state).toBe('motoroff');
      expect(requests.length).toBe(1);
      expect(requests[0].accept).toBe(HAL_CT);
    } finally { server.close(); }
  });

  it('getRapidTasks parses _embedded.resources[] and ignores non-task entries', async () => {
    const { server, port } = await startServer((_req, res) => json200(res, FIX.tasks));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const tasks = await client.getRapidTasks();
      expect(tasks).toEqual([{
        name: 'T_ROB1', type: 'normal', taskstate: 'linked',
        excstate: 'stopped', active: true, motiontask: true,
      }]);
    } finally { server.close(); }
  });

  it('listModules parses the state[] resource list', async () => {
    const { server, port } = await startServer((_req, res) => json200(res, FIX.modules));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await client.listModules('T_ROB1')).toEqual(['BASE', 'MainModule']);
      expect(await client.listModulesDetailed('T_ROB1')).toEqual([
        { name: 'BASE', type: 'SysMod' },
        { name: 'MainModule', type: 'ProgMod' },
      ]);
    } finally { server.close(); }
  });

  it('getJointPositions parses numeric joint values', async () => {
    const { server, port } = await startServer((_req, res) => json200(res, FIX.jointtarget));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await client.getJointPositions()).toEqual({
        rax_1: 10, rax_2: 15, rax_3: -10, rax_4: 20, rax_5: 30, rax_6: 45,
      });
    } finally { server.close(); }
  });

  it('listAllSignals parses signals and caches network/device for writeSignal', async () => {
    const { server, port, requests } = await startServer((req, res) => {
      if (req.method === 'GET') { json200(res, FIX.signals); return; }
      res.writeHead(204); res.end();
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const signals = await client.listAllSignals();
      expect(signals).toEqual([
        { name: 'doGripper', value: '1', type: 'DO', lvalue: '1' },
        { name: 'diSensor', value: '0', type: 'DI', lvalue: '0' },
      ]);
      await client.writeSignal('', '', 'doGripper', '0');
      expect(requests.some(r =>
        r.method === 'POST' && r.url === '/rw/iosystem/signals/Net/Dev/doGripper/set-value',
      )).toBe(true);
    } finally { server.close(); }
  });

  it('getEventLog derives seqnum from _title and keeps message fields', async () => {
    const { server, port } = await startServer((_req, res) => json200(res, FIX.elog));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const log = await client.getEventLog(0);
      expect(log.length).toBe(1);
      expect(log[0].seqnum).toBe(1);
      expect(log[0].code).toBe(10046);
      expect(log[0].title).toBe('System reset');
      expect(log[0].desc).toContain('original system installation');
    } finally { server.close(); }
  });

  it('getSystemInfo reads nested option resources (sys-options under _embedded)', async () => {
    const { server, port } = await startServer((_req, res) => json200(res, FIX.system));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const info = await client.getSystemInfo();
      expect(info.name).toBe('IRB1600_6_120_3');
      expect(info.rwVersion).toBe('7.21.0+229');
      expect(info.options).toEqual(['RobotControl Base', 'English']);
    } finally { server.close(); }
  });

  it('extracts JSON error bodies (status.code/status.msg) into RwsError', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': HAL_CT });
      res.end(FIX.taskNotFound);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const err = await client.listModules('NO_SUCH_TASK').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).httpStatus).toBe(404);
      expect((err as RwsError).rwsDetail).toContain('Task NO_SUCH_TASK does not exist');
      expect((err as RwsError).message).toContain('does not exist');
    } finally { server.close(); }
  });

  it('follows HAL _links.next pagination (with &amp; unescaping) in listCfgInstances', async () => {
    const page1 = '{ "_links" : { "base": { "href": "x" }, "self": { "href": "EIO/EIO_SIGNAL/instances" }, "next": { "href": "instances?start=1&amp;limit=1" } }, "_embedded" : { "resources" : [ { "_type":"cfg-dt-instance-li", "_title":"SigA" } ] }}';
    const page2 = '{ "_links" : { "base": { "href": "x" }, "self": { "href": "EIO/EIO_SIGNAL/instances?start=1" } }, "_embedded" : { "resources" : [ { "_type":"cfg-dt-instance-li", "_title":"SigB" } ] }}';
    const { server, port, requests } = await startServer((req, res) => {
      json200(res, (req.url ?? '').includes('start=1') ? page2 : page1);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const instances = await client.listCfgInstances('EIO', 'EIO_SIGNAL');
      expect(instances).toEqual(['SigA', 'SigB']);
      expect(requests.map(r => r.url)).toEqual([
        '/rw/cfg/EIO/EIO_SIGNAL/instances',
        '/rw/cfg/EIO/EIO_SIGNAL/instances?start=1&limit=1',
      ]);
    } finally { server.close(); }
  });

  it('getCfgInstance reads nested attrib[] entries (cfg-ia-t)', async () => {
    const body = '{ "_links" : { "base": { "href": "x" } }, "_embedded" : { "resources" : [ { "_type":"cfg-dt-instance-li", "_title":"MotOnPB", "rdonly":"true", "attrib": [ { "_type":"cfg-ia-t", "_title":"Name", "value":"MotOnPB" }, { "_type":"cfg-ia-t", "_title":"DeviceMap", "value":"0" } ] } ] }}';
    const { server, port } = await startServer((_req, res) => json200(res, body));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await client.getCfgInstance('EIO', 'EIO_SIGNAL', 'MotOnPB')).toEqual({
        Name: 'MotOnPB', DeviceMap: '0',
      });
    } finally { server.close(); }
  });
});

// ─── Fallback: older RW7 without hal+json ────────────────────────────────────

const CTRLSTATE_XHTML = '<html><body><ul><li class="pnl-ctrlstate" title="ctrl-state">'
  + '<span class="ctrlstate">motoroff</span></li></ul></body></html>';

describe('RwsClient2 XHTML fallback', () => {
  it('retries once with XHTML on HTTP 406 and remembers the preference', async () => {
    const { server, port, requests } = await startServer((req, res) => {
      if ((req.headers['accept'] ?? '').includes('json')) {
        res.writeHead(406, { 'Content-Type': XHTML_CT });
        res.end('<html><body><div class="status"><span class="code">-1073445866</span>'
          + '<span class="msg">Not acceptable</span></div></body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': XHTML_CT });
      res.end(CTRLSTATE_XHTML);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await client.getControllerState()).toBe('motoroff');
      // First GET: hal+json attempt + XHTML retry.
      expect(requests.map(r => r.accept)).toEqual([HAL_CT, XHTML_CT]);

      // Preference is remembered: the next GET goes straight to XHTML.
      expect(await client.getControllerState()).toBe('motoroff');
      expect(requests.length).toBe(3);
      expect(requests[2].accept).toBe(XHTML_CT);
    } finally { server.close(); }
  });

  it('retries once with XHTML when a 200 arrives with a non-JSON content type', async () => {
    // Controller that ignores the Accept header and always answers XHTML.
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': XHTML_CT });
      res.end(CTRLSTATE_XHTML);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      expect(await client.getControllerState()).toBe('motoroff');
      expect(requests.map(r => r.accept)).toEqual([HAL_CT, XHTML_CT]);
      expect(await client.getControllerState()).toBe('motoroff');
      expect(requests.length).toBe(3);
    } finally { server.close(); }
  });

  it('does NOT fall back on ordinary HTTP errors (404 stays a single request)', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': HAL_CT });
      res.end(FIX.taskNotFound);
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await expect(client.listModules('NO_SUCH_TASK')).rejects.toBeInstanceOf(RwsError);
      expect(requests.length).toBe(1);
    } finally { server.close(); }
  });
});

// ─── Endpoints that must NOT use hal+json ────────────────────────────────────

describe('RwsClient2 XHTML-only endpoints', () => {
  it('fileservice reads keep the XHTML Accept and never double-request', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('MODULE M\r\nENDMODULE\r\n');
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const content = await client.readFile('HOME/M.mod');
      expect(content).toBe('MODULE M\r\nENDMODULE\r\n');
      // Raw file bytes with a non-JSON content type must NOT trigger a fallback retry.
      expect(requests.length).toBe(1);
      expect(requests[0].accept).toBe(XHTML_CT);
    } finally { server.close(); }
  });

  it('fileservice DELETE keeps the versioned XHTML Accept', async () => {
    const { server, port, requests } = await startServer((_req, res) => { res.writeHead(204); res.end(); });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await client.deleteFile('TEMP/scratch.modx');
      expect(requests[0].method).toBe('DELETE');
      expect(requests[0].accept).toBe(XHTML_CT);
    } finally { server.close(); }
  });

  it('POST responses keep the XHTML Accept (form posts are XHTML-only)', async () => {
    const { server, port, requests } = await startServer((_req, res) => { res.writeHead(204); res.end(); });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await client.stopRapid();
      expect(requests[0].method).toBe('POST');
      expect(requests[0].accept).toBe(XHTML_CT);
    } finally { server.close(); }
  });

  it('disconnect (/logout) does not negotiate hal+json', async () => {
    const { server, port, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await client.disconnect();
      const logout = requests.find(r => r.url === '/logout');
      expect(logout?.accept).toBe(XHTML_CT);
      expect(requests.length).toBe(1);
    } finally { server.close(); }
  });
});
