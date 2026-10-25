import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { accessOf, type AccessObservation } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';

/**
 * RobotWare 8 teardown against writes that race it. A write started after
 * disconnect() must never request write access after the teardown's release:
 * write access would then be held at /logout, and RobotWare 8 keeps it past
 * the session. Also: one release per teardown, a second disconnect() joins
 * the first, a session re-issue keeps what disconnect() must release, a
 * refused teardown release stays uncertain, and the HeartBeat configuration is
 * read again after a re-issue.
 */

interface Recorded { method: string; url: string; body: string; cookie: string | undefined }

const ID = '{6F1C2A3B-4D5E-4F60-8A7B-9C0D1E2F3A4B}';
const STATION = { name: 'teardown-test', id: ID, pincode: '1234' };
const REQUEST = '/rw/controlstation/writeaccess/request';
const RELEASE = '/rw/controlstation/writeaccess/release';
const SPEED = '/rw/panel/speedratio?action=setspeedratio';
const HEARTBEAT = '/rw/cfg/SYS/MASTER_BOOL/instances/HeartBeat';

const heartBeat = (select: string): string => '{ "_links" : { "base": { "href": "x" } }, "_embedded" : { "resources" : [ { "_type":"cfg-dt-instance-li", "_title":"HeartBeat", '
  + `"attrib": [ { "_type":"cfg-ia-t", "_title":"Select", "value":"${select}" }, { "_type":"cfg-ia-t", "_title":"Timeout", "value":"400" } ] } ] }}`;

interface Opts { rw?: string; delay?: (url: string) => number | undefined; releaseStatus?: number; reissueAfter?: string; heartBeatSelect?: string }

async function startServer(opts: Opts = {}): Promise<{ server: http.Server; port: number; wire: Recorded[]; state: { holder: boolean; session: number } }> {
  const rw = opts.rw ?? '8.2.1+1023';
  const wire: Recorded[] = [];
  const state = { holder: false, session: 1 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      wire.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8'), cookie: req.headers.cookie });
      const cookie = { 'Set-Cookie': [`-http-session-=S${state.session}; path=/`] };
      const answer = (): void => {
        if (url === '/rw/system') {
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0', ...cookie });
          res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw}"}]}`);
          return;
        }
        if (url === HEARTBEAT) {
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0', ...cookie });
          res.end(heartBeat(opts.heartBeatSelect ?? 'FALSE'));
          return;
        }
        if (url.startsWith('/rw/mastership') && rw.startsWith('8')) { res.writeHead(410); res.end(); return; }
        if (url === REQUEST) { state.holder = true; }
        if (url === RELEASE) {
          if (opts.releaseStatus) {
            res.writeHead(opts.releaseStatus, { 'Content-Type': 'application/hal+json;v=2.0', ...cookie });
            res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445800,"msg":"internal error"}}');
            return;
          }
          state.holder = false;
        }
        // One re-issue, after the first such request.
        if (url === opts.reissueAfter && state.session === 1) { state.session += 1; }
        res.writeHead(204, cookie); res.end();
      };
      const ms = opts.delay?.(url);
      if (ms) { setTimeout(answer, ms); } else { answer(); }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire, state };
}

const lines = (wire: Recorded[]): string[] => wire.map(r => `${r.method} ${r.url}`);
const writes = (wire: Recorded[]): string[] => lines(wire).filter(l => !l.startsWith('GET ') || l === 'GET /logout');
const settle = <T>(p: Promise<T>): Promise<string> => p.then(() => 'sent', (e: { code?: string }) => e.code ?? 'error');
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('item 1: a write that races disconnect() never requests write access after the teardown release', () => {
  it('a write started in the same tick as disconnect() is refused; the wire ends release, logout; nothing held at logout', async () => {
    const { server, port, wire, state } = await startServer();
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      await c.requestWriteAccess();
      const teardown = c.disconnect();
      const late = settle(c.setSpeedRatio(50));
      await teardown;
      expect(await late).toBe('NOT_CONNECTED');
      expect(writes(wire)).toEqual([
        'POST /rw/controlstation/register/remote', `POST ${REQUEST}`, `POST ${RELEASE}`, 'GET /logout',
      ]);
      expect(state.holder).toBe(false);
    } finally { server.close(); }
  });

  it('a write started 50 ms into the teardown, while a write is in progress, is refused; the write in progress finishes first', async () => {
    const { server, port, wire, state } = await startServer({ delay: url => (url === SPEED ? 300 : undefined) });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      const first = settle(c.setSpeedRatio(40));
      await sleep(30);
      const teardown = c.disconnect();
      await sleep(50);
      const late = settle(c.setSpeedRatio(60));
      await teardown;
      expect(await first).toBe('sent');
      expect(await late).toBe('NOT_CONNECTED');
      // One request, the write in progress, then releases and the logout; no
      // request after the first release (the count of releases is item 4's).
      const l = writes(wire);
      expect(l.slice(0, 3)).toEqual(['POST /rw/controlstation/register/remote', `POST ${REQUEST}`, `POST ${SPEED}`]);
      expect(l.slice(3, -1).every(x => x === `POST ${RELEASE}`)).toBe(true);
      expect(l.at(-1)).toBe('GET /logout');
      expect(wire.filter(r => r.url === SPEED)).toHaveLength(1);
      expect(state.holder).toBe(false);
    } finally { server.close(); }
  });

  it('an operation still in its turn past the drain bound requests no access afterwards; logout comes with nothing held', async () => {
    const { server, port, wire, state } = await startServer();
    try {
      setLogger({ info() {}, warn() {}, error() {}, show() {} });
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      const access = accessOf(c)!;
      let resume!: () => void;
      const gate = new Promise<void>(r => { resume = r; });
      // An operation that holds the turn with nothing held, then (after the
      // drain bound has passed and the teardown has released) asks for access.
      const op = settle(access.exclusive(async () => {
        await gate;
        await access.withAccess(['rapid'], async () => {});
      }));
      await sleep(20);
      const teardown = c.disconnect();
      await sleep(5300);
      resume();
      await teardown;
      expect(await op).toBe('NOT_CONNECTED');
      expect(lines(wire)).not.toContain(`POST ${REQUEST}`);
      expect(lines(wire).at(-1)).toBe('GET /logout');
      expect(state.holder).toBe(false);
    } finally { server.close(); }
  }, 15000);
});

describe('item 2: the HeartBeat configuration is read again after a session re-issue', () => {
  it('RobotWare 8: connect, re-issue, then the configuration is read on the new session and the watchdog state follows it', async () => {
    const { server, port, wire } = await startServer({ heartBeatSelect: 'TRUE', reissueAfter: '/rw/panel/ctrl-state' });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      expect(accessOf(c)!.snapshot().watchdog).toMatchObject({ enforced: true, resettable: false });
      await c.getControllerState().catch(() => undefined);   // answered with a new session cookie
      await c.getControllerState().catch(() => undefined);   // adopts it
      await sleep(300);                                       // the re-read waits its turn in the 100 ms request spacing
      expect(wire.filter(r => r.url === HEARTBEAT)).toHaveLength(2);
      expect(accessOf(c)!.snapshot().watchdog).toMatchObject({ enforced: true, timeoutMs: 400, resettable: false });
      await c.disconnect();
    } finally { server.close(); }
  });
});

describe('item 3: a session re-issue keeps what disconnect() must release', () => {
  it('RobotWare 8 write access requested before a re-issue is still released at disconnect', async () => {
    const { server, port, wire } = await startServer({ reissueAfter: REQUEST });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      await c.requestWriteAccess();
      await c.getControllerState().catch(() => undefined);   // adopts the re-issued session
      await c.disconnect();
      const l = writes(wire);
      expect(l.filter(x => x === `POST ${RELEASE}`)).toHaveLength(1);
      expect(l.indexOf(`POST ${RELEASE}`)).toBeLessThan(l.indexOf('GET /logout'));
    } finally { server.close(); }
  });

  it('a with-id token taken before a re-issue is still released at disconnect (RobotWare 7)', async () => {
    const { server, port, wire } = await startServer({ rw: '7.21.4+417', reissueAfter: '/rw/mastership/edit/request-with-id' });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      // The stand-in answers 204 with no body: give the id the way the controller does.
      const req = (c as unknown as { req: (m: string, p: string) => Promise<string> });
      const original = req.req.bind(c);
      req.req = async (m: string, p: string, ...rest: unknown[]) => {
        const out = await (original as (...a: unknown[]) => Promise<string>)(m, p, ...rest);
        return p.endsWith('/request-with-id') ? '{"state":[{"_type":"msh-request-with-id","mastership-id":"42"}]}' : out;
      };
      await c.requestMastershipWithId('rapid');
      await c.getControllerState().catch(() => undefined);
      await c.disconnect();
      expect(wire.filter(r => r.url.endsWith('/release-with-id')).map(r => r.body)).toEqual(['mastershipid=42']);
    } finally { server.close(); }
  });
});

describe('item 4: one release per teardown', () => {
  it('after a successful release, disconnect() sends no second release; two concurrent disconnect() calls send one logout', async () => {
    const { server, port, wire } = await startServer();
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      await c.setSpeedRatio(50);                               // request, write, release
      await Promise.all([c.disconnect(), c.disconnect()]);
      expect(writes(wire)).toEqual([
        'POST /rw/controlstation/register/remote', `POST ${REQUEST}`, `POST ${SPEED}`, `POST ${RELEASE}`, 'GET /logout',
      ]);
    } finally { server.close(); }
  });

  it('two concurrent disconnect() calls while write access is held send one release and one logout', async () => {
    const { server, port, wire } = await startServer();
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      await c.requestWriteAccess();
      await Promise.all([c.disconnect(), c.disconnect()]);
      expect(lines(wire).filter(l => l === `POST ${RELEASE}`)).toHaveLength(1);
      expect(lines(wire).filter(l => l === 'GET /logout')).toHaveLength(1);
    } finally { server.close(); }
  });
});

describe('item 5: a refused teardown release stays uncertain', () => {
  it('releaseFailed is emitted, no released follows for that lock, and the final state keeps it uncertain', async () => {
    const { server, port } = await startServer({ releaseStatus: 500 });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      const seen: AccessObservation[] = [];
      accessOf(c)!.on(e => seen.push(e));
      await c.requestWriteAccess();
      await c.disconnect();
      const types = seen.map(e => e.type);
      expect(types).toContain('releaseFailed');
      expect(types.slice(types.indexOf('releaseFailed'))).not.toContain('released');
      const lock = accessOf(c)!.snapshot().locks.find(l => l.lock === 'writeaccess');
      expect(lock).toMatchObject({ state: 'uncertain', count: 0 });
    } finally { server.close(); }
  });
});
