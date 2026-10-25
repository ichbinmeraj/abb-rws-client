import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { accessOf, type AccessObservation } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';

/**
 * RWS 2.0 disconnect on RobotWare 8, end to end over a stand-in: the order is
 * watchdog stop, drain the write in progress (bounded), release write access
 * when this session ever requested it, release with-id tokens, then /logout.
 * A request that did not answer is read back once (held -> counted). A
 * release the controller refuses is observed and logged, and the logout still
 * goes out.
 */

interface Recorded { method: string; url: string; body: string }

const ID = '{6F1C2A3B-4D5E-4F60-8A7B-9C0D1E2F3A4B}';
const STATION = { name: 'disconnect-test', id: ID, pincode: '1234' };
const REQUEST = '/rw/controlstation/writeaccess/request';
const RELEASE = '/rw/controlstation/writeaccess/release';
const STATUS = '/rw/controlstation/writeaccess/status';
const SPEED = '/rw/panel/speedratio?action=setspeedratio';

const held = (by: string): string => '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"controlstation-write-access-status","_title":"write-access-status",'
  + `"held-by-control-station-Id":"${by}","held-by-control-station-name":"disconnect-test","control-station-write-access-held":"true","control-station-external-control-enabled":"true"}]}`;
const NOBODY = '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"controlstation-write-access-status","_title":"write-access-status",'
  + '"held-by-control-station-Id":"none","held-by-control-station-name":"none","control-station-write-access-held":"false","control-station-external-control-enabled":"true"}]}';

type Delay = (url: string) => number | undefined;

async function startRw8(opts: { delay?: Delay; releaseStatus?: number; statusBody?: string; statusFails?: boolean } = {}): Promise<{
  server: http.Server; port: number; wire: Recorded[];
}> {
  const wire: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      wire.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8') });
      const answer = (): void => {
        if (url === '/rw/system') {
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
          res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.2.1+1023"}]}');
          return;
        }
        if (url.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
        if (url === '/rw/panel/ctrl-state') {
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
          res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"pnl-ctrlstate","ctrlstate":"motoron"}]}');
          return;
        }
        if (url === STATUS) {
          if (opts.statusFails) { req.socket.destroy(); return; }
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
          res.end(opts.statusBody ?? held(ID));
          return;
        }
        if (url === RELEASE && opts.releaseStatus) {
          res.writeHead(opts.releaseStatus, { 'Content-Type': 'application/hal+json;v=2.0' });
          res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445800,"msg":"internal error"}}');
          return;
        }
        res.writeHead(204); res.end();
      };
      const ms = opts.delay?.(url);
      if (ms) { setTimeout(answer, ms); } else { answer(); }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const lines = (wire: Recorded[]): string[] => wire.map(r => `${r.method} ${r.url}`);
const after = (l: string[], a: string, b: string): boolean => l.indexOf(a) >= 0 && l.indexOf(b) > l.indexOf(a);

const logged: string[] = [];
afterEach(() => { logged.length = 0; setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('RWS 2.0 disconnect order on RobotWare 8', () => {
  it('write access held by the caller is released before /logout, which is last', async () => {
    const { server, port, wire } = await startRw8();
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      await c.requestWriteAccess();
      await c.disconnect();
      const l = lines(wire);
      expect(after(l, `POST ${RELEASE}`, 'GET /logout')).toBe(true);
      expect(l.at(-1)).toBe('GET /logout');
      expect(l.filter(x => x === `POST ${RELEASE}`)).toHaveLength(1);
    } finally { server.close(); }
  });

  it('a write in progress finishes first: its request and its own release go out, then the disconnect release and the logout', async () => {
    const { server, port, wire } = await startRw8({ delay: url => (url === SPEED ? 300 : undefined) });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      const write = c.setSpeedRatio(50);
      await new Promise(r => setTimeout(r, 50));            // the write's request is on the wire
      const teardown = c.disconnect();
      await Promise.all([write, teardown]);
      const l = lines(wire);
      const speed = l.indexOf(`POST ${SPEED}`);
      expect(speed).toBeGreaterThan(0);
      expect(l.indexOf(`POST ${RELEASE}`)).toBeGreaterThan(speed);
      // The write's own release ended the hold and cleared the request flag,
      // so the teardown sends no second release.
      expect(l.filter(x => x === `POST ${RELEASE}`)).toHaveLength(1);
      expect(l.at(-1)).toBe('GET /logout');
    } finally { server.close(); }
  });

  it('the drain is bounded: an operation that holds the turn past the bound does not hold the logout', async () => {
    const { server, port, wire } = await startRw8();
    try {
      setLogger({ info() {}, warn(m) { logged.push(m); }, error() {}, show() {} });
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      await c.requestWriteAccess();
      // An operation of this session that keeps the turn without a request on
      // the wire (a caller's own work inside the turn, say) for longer than the bound.
      let finish!: () => void;
      const op = accessOf(c)!.exclusive(() => new Promise<void>(r => { finish = r; }));
      await new Promise(r => setTimeout(r, 20));
      const t0 = Date.now();
      await c.disconnect();
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(4900);
      expect(took).toBeLessThan(6000);
      const l = lines(wire);
      expect(l.at(-1)).toBe('GET /logout');
      expect(after(l, `POST ${RELEASE}`, 'GET /logout')).toBe(true);
      expect(logged.some(m => /still in progress/.test(m))).toBe(true);
      finish();
      await op;
      // The operation's later request is refused on the closed client.
      await expect(c.getControllerState()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    } finally { server.close(); }
  }, 15000);

  it('a release the controller refuses is observed as releaseFailed and logged; the logout still goes out', async () => {
    const { server, port, wire } = await startRw8({ releaseStatus: 500 });
    try {
      setLogger({ info() {}, warn(m) { logged.push(m); }, error() {}, show() {} });
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      const seen: AccessObservation[] = [];
      accessOf(c)!.on(e => seen.push(e));
      await c.requestWriteAccess();
      await c.disconnect();
      expect(lines(wire).at(-1)).toBe('GET /logout');
      expect(seen.some(e => e.type === 'releaseFailed' && e.lock === 'writeaccess')).toBe(true);
      expect(logged.some(m => /release/i.test(m) && /500|internal error/.test(m))).toBe(true);
    } finally { server.close(); }
  });

  it('write access requested but never answered: the status is read once; held by this station -> counted, and released at disconnect', async () => {
    const { server, port, wire } = await startRw8({ delay: url => (url === REQUEST ? 600 : undefined) });
    try {
      setLogger({ info(m) { logged.push(m); }, warn(m) { logged.push(m); }, error() {}, show() {} });
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION, timeout: 200 });
      await c.connect();
      const seen: AccessObservation[] = [];
      accessOf(c)!.on(e => seen.push(e));
      await c.requestWriteAccess();
      expect(lines(wire).filter(x => x === `GET ${STATUS}`)).toHaveLength(1);
      expect(seen).toEqual([{ type: 'acquired', lock: 'writeaccess' }]);
      expect(accessOf(c)!.snapshot().locks[0]).toMatchObject({ lock: 'writeaccess', state: 'held', count: 1 });
      expect(logged.some(m => /did not answer/.test(m))).toBe(true);
      await c.disconnect();
      const l = lines(wire);
      expect(l.filter(x => x === `POST ${RELEASE}`)).toHaveLength(1);
      expect(after(l, `POST ${RELEASE}`, 'GET /logout')).toBe(true);
    } finally { server.close(); }
  });

  it('requested but never answered, and the controller names nobody: the error is passed on; disconnect still sends one release (ever requested)', async () => {
    const { server, port, wire } = await startRw8({ delay: url => (url === REQUEST ? 600 : undefined), statusBody: NOBODY });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION, timeout: 200 });
      await c.connect();
      await expect(c.requestWriteAccess()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      expect(accessOf(c)!.snapshot().locks[0]).toMatchObject({ state: 'idle', count: 0 });
      await c.disconnect();
      const l = lines(wire);
      expect(l.filter(x => x === `POST ${RELEASE}`)).toHaveLength(1);
      expect(l.at(-1)).toBe('GET /logout');
    } finally { server.close(); }
  });

  it('requested but never answered, and the status read fails: the lock is uncertain and an uncertain event is emitted', async () => {
    const { server, port } = await startRw8({ delay: url => (url === REQUEST ? 600 : undefined), statusFails: true });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION, timeout: 200 });
      await c.connect();
      const seen: AccessObservation[] = [];
      accessOf(c)!.on(e => seen.push(e));
      await expect(c.requestWriteAccess()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      expect(accessOf(c)!.snapshot().locks[0]).toMatchObject({ lock: 'writeaccess', state: 'uncertain', count: 0 });
      expect(seen.map(e => e.type)).toEqual(['uncertain']);
      await c.disconnect();
    } finally { server.close(); }
  });

  it('a request made after disconnect() is refused at once, while one made before it still goes out ahead of /logout', async () => {
    const { server, port, wire } = await startRw8();
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION });
      await c.connect();
      const before = c.getControllerState();
      const teardown = c.disconnect();
      const later = c.getControllerState().then(() => 'sent', (e: { code: string }) => e.code);
      await before;
      await teardown;
      expect(await later).toBe('NOT_CONNECTED');
      expect(lines(wire).at(-1)).toBe('GET /logout');
    } finally { server.close(); }
  });
});
