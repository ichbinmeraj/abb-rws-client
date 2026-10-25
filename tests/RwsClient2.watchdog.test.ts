import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { accessOf, type AccessObservation } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';

/**
 * RWS 2.0 client, end to end over a mock controller: the edit-mastership
 * watchdog is reset while this session holds edit on RobotWare 7.8 or later,
 * at the interval the HeartBeat configuration gives, and never otherwise.
 * The configuration is only read. Real timers: a HeartBeat Timeout of 400 ms
 * makes the interval 200 ms, which keeps these tests short.
 *
 * The RobotWare 8 answer to a mastership path is the one captured live on an
 * RW 8.1.1 VC (2026-09-27): 410 with code -1073445881.
 */

interface Recorded { method: string; url: string }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean | void;

const HEARTBEAT_PATH = '/rw/cfg/SYS/MASTER_BOOL/instances/HeartBeat';
const WATCHDOG = 'POST /rw/mastership/watchdog';

function heartBeatBody(select: string, timeout: string): string {
  return '{ "_links" : { "base": { "href": "x" } }, "_embedded" : { "resources" : [ { "_type":"cfg-dt-instance-li", "_title":"HeartBeat", '
    + `"attrib": [ { "_type":"cfg-ia-t", "_title":"Select", "value":"${select}" }, { "_type":"cfg-ia-t", "_title":"Timeout", "value":"${timeout}" } ] } ] }}`;
}

const GONE_BODY = '{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445881,'
  + '"msg":"Mastership service is not supported from Robotware version 8.0 onwards, Use Control Station service for similar functionality"}}';

async function startServer(rw: string, extra?: Handler): Promise<{ server: http.Server; port: number; wire: Recorded[] }> {
  const wire: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      wire.push({ method: req.method ?? '', url: req.url ?? '' });
      if (extra?.(req, res)) { return; }
      if (req.url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw}"}]}`);
        return;
      }
      if (req.url === HEARTBEAT_PATH) {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(heartBeatBody('TRUE', '400'));
        return;
      }
      if (req.url?.startsWith('/rw/mastership') && rw.startsWith('8')) {
        res.writeHead(410, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(GONE_BODY);
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const line = (r: Recorded): string => `${r.method} ${r.url}`;
const kicks = (wire: Recorded[]): number => wire.filter(r => line(r) === WATCHDOG).length;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Poll until a condition holds: under a loaded test run a fixed sleep can end before a timer chain does. */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) { throw new Error('condition not met in time'); }
    await sleep(10);
  }
}

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('RWS 2.0: edit-mastership watchdog', () => {
  it('RobotWare 7.21: resets at Timeout / 2 while edit is held, reads the HeartBeat configuration once (at connect), and stops on release', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastership('rapid');
      await sleep(700);
      expect(kicks(wire)).toBeGreaterThanOrEqual(2);
      await c.releaseMastership('rapid');
      const atRelease = kicks(wire);
      await sleep(600);
      expect(kicks(wire)).toBe(atRelease);

      const lines = wire.map(line);
      expect(lines.filter(l => l === `GET ${HEARTBEAT_PATH}`)).toHaveLength(1);
      // Read at connect, before any hold; never written.
      expect(lines.indexOf(`GET ${HEARTBEAT_PATH}`)).toBeLessThan(lines.indexOf('POST /rw/mastership/edit/request'));
      expect(wire.filter(r => r.method !== 'GET' && r.url.startsWith('/rw/cfg'))).toEqual([]);
      expect(lines.at(-1)).toBe('POST /rw/mastership/edit/release');

      // A second hold on the same connection does not read the configuration again.
      await c.requestMastership('cfg');
      await sleep(300);
      await c.releaseMastership('cfg');
      expect(wire.map(line).filter(l => l === `GET ${HEARTBEAT_PATH}`)).toHaveLength(1);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('RobotWare 7.21: a motion hold alone is not reset', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastership('motion');
      await sleep(1200);
      await c.releaseMastership('motion');
      expect(kicks(wire)).toBe(0);
      // The one configuration read is connect's; a motion hold reads nothing more.
      expect(wire.filter(r => r.url.startsWith('/rw/cfg')).map(line)).toEqual([`GET ${HEARTBEAT_PATH}`]);
    } finally { server.close(); }
  });

  it('RobotWare 7.7 (before the heartbeat): nothing is reset or read', async () => {
    const { server, port, wire } = await startServer('7.7.1+100');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastership('rapid');
      await sleep(1200);
      await c.releaseMastership('rapid');
      expect(kicks(wire)).toBe(0);
      expect(wire.some(r => r.url.startsWith('/rw/cfg'))).toBe(false);
    } finally { server.close(); }
  });

  it('disconnect stops the resets while a hold is still counted', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestMastership('rapid');
      await sleep(300);
      await c.disconnect();
      const logout = wire.map(line).lastIndexOf('GET /logout');
      await sleep(600);
      expect(wire.slice(logout + 1)).toEqual([]);
    } finally { server.close(); }
  });

  it('a refused reset loses edit mastership: the resets stop, edit is released once, and the next write requests it afresh', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    // Only the first reset is refused. A later hold that outlasts one interval
    // (the write below, on a loaded test run) has its resets accepted, so it
    // cannot lose its own hold mid-write.
    let refused = 0;
    const { server, port, wire } = await startServer('7.21.0+229', (req, res) => {
      if (req.url !== '/rw/mastership/watchdog' || refused > 0) { return false; }
      refused++;
      res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445862,"msg":"Requested resource is held by someone else"}}');
      return true;
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const events: AccessObservation[] = [];
      accessOf(c)!.on(e => events.push(e));
      await c.requestMastership('rapid');
      await until(() => wire.map(line).includes('POST /rw/mastership/edit/release'));
      await sleep(300);
      expect(kicks(wire)).toBe(1);
      expect(events.filter(e => e.type === 'lost')).toEqual([
        expect.objectContaining({ type: 'lost', lock: 'edit', reason: 'watchdog' }),
      ]);
      expect(warnings.filter(w => /edit mastership was lost: the controller refused the watchdog reset/.test(w))).toHaveLength(1);
      expect(accessOf(c)!.count('edit')).toBe(0);
      const lines = wire.map(line);
      expect(lines.slice(lines.indexOf(WATCHDOG))).toEqual([WATCHDOG, 'POST /rw/mastership/edit/release']);

      // The caller's release has nothing left to end; the next write requests afresh.
      await c.releaseMastership('rapid');
      expect(wire.map(line).filter(l => l === 'POST /rw/mastership/edit/release')).toHaveLength(1);
      await c.setSpeedRatio(50);
      expect(wire.map(line).filter(l => l !== WATCHDOG).slice(-3)).toEqual([
        'POST /rw/mastership/edit/request', 'POST /rw/panel/speedratio?action=setspeedratio', 'POST /rw/mastership/edit/release',
      ]);
    } finally { server.close(); }
  });

  it('RobotWare 8: no resets during a write-access hold, and resetMastershipWatchdog is UNSUPPORTED_OPERATION without sending', async () => {
    const { server, port, wire } = await startServer('8.1.1+614');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.requestWriteAccess();
      await sleep(1200);
      await c.releaseWriteAccess();
      await expect(c.resetMastershipWatchdog()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      expect(wire.some(r => r.url.startsWith('/rw/mastership'))).toBe(false);
      // RobotWare 8 reads the configuration once at connect too, and resets nothing.
      expect(wire.filter(r => r.url.startsWith('/rw/cfg')).map(line)).toEqual([`GET ${HEARTBEAT_PATH}`]);
    } finally { server.close(); }
  });

  it('RobotWare 8 before connect(): the 410 answer is UNSUPPORTED_OPERATION with the controller\'s code', async () => {
    const { server, port } = await startServer('8.1.1+614');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await expect(c.resetMastershipWatchdog()).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION', httpStatus: 410, controllerCode: -1073445881,
      });
    } finally { server.close(); }
  });

  it('RobotWare 7.21: a hand-made reset still goes out as before', async () => {
    const { server, port, wire } = await startServer('7.21.0+229');
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      await c.resetMastershipWatchdog();
      expect(kicks(wire)).toBe(1);
    } finally { server.close(); }
  });
});
