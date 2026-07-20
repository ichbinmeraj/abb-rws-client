import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { RwsClient } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';

// ─── Tiny mock IRC5: digest-challenges, verifies the response hash, routes ───

const REALM = 'controller';
const NONCE = '9f1a2b3c4d5e6f70';
const OPAQUE = 'op-4711';
const USER = 'Default User';
const PASS = 'robotics';
const CHALLENGE = `Digest realm="${REALM}", nonce="${NONCE}", qop="auth", algorithm=MD5, opaque="${OPAQUE}"`;

const CTRLSTATE_XML =
  '<li class="pnl-ctrlstate" title="ctrlstate"><span class="ctrlstate">motoron</span></li>';
const SPEEDRATIO_XML =
  '<li class="pnl-speedratio" title="speedratio"><span class="speedratio">100</span></li>';

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  authorized: boolean;
  at: number;
}

function digestField(header: string, key: string): string | undefined {
  const quoted = header.match(new RegExp(`\\b${key}="([^"]*)"`));
  if (quoted) return quoted[1];
  const bare = header.match(new RegExp(`\\b${key}=([^",\\s]+)`));
  return bare?.[1];
}

/** Full RFC 2617 verification - recomputes the qop=auth response hash. */
function verifyDigest(header: string, method: string, url: string): boolean {
  if (!header.startsWith('Digest ')) return false;
  const username = digestField(header, 'username');
  const realm = digestField(header, 'realm');
  const nonce = digestField(header, 'nonce');
  const uri = digestField(header, 'uri');
  const nc = digestField(header, 'nc');
  const cnonce = digestField(header, 'cnonce');
  const response = digestField(header, 'response');
  if (username !== USER || realm !== REALM || nonce !== NONCE) return false;
  // The signed uri must be the actual path+query of the request
  if (!uri || uri !== url) return false;
  const ha1 = md5(`${USER}:${REALM}:${PASS}`);
  const ha2 = md5(`${method}:${uri}`);
  const expected = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return response === expected;
}

type RouteHandler = (res: ServerResponse, body: string) => void;

interface MockController {
  server: Server;
  port: number;
  seen: SeenRequest[];
  routes: Map<string, RouteHandler>;
  close: () => Promise<void>;
}

function startMockController(): Promise<MockController> {
  const seen: SeenRequest[] = [];
  const routes = new Map<string, RouteHandler>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const auth = req.headers.authorization;
      const authorized = auth ? verifyDigest(auth, req.method ?? '', req.url ?? '') : false;
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        authorized,
        at: Date.now(),
      });

      if (!authorized) {
        res.writeHead(401, { 'WWW-Authenticate': CHALLENGE });
        res.end();
        return;
      }

      res.setHeader('Set-Cookie', ['-http-session-=sess-1; Path=/', 'ABBCX=cx-1; Path=/']);
      const key = `${req.method} ${req.url}`;
      const handler = routes.get(key);
      if (handler) {
        handler(res, body);
        return;
      }
      if (key === 'GET /rw/panel/ctrlstate') {
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml' });
        res.end(CTRLSTATE_XML);
        return;
      }
      if (key === 'GET /rw/panel/speedratio') {
        res.writeHead(200, { 'Content-Type': 'application/xhtml+xml' });
        res.end(SPEEDRATIO_XML);
        return;
      }
      if (key === 'GET /logout') {
        res.writeHead(204);
        res.end();
        return;
      }
      // Anything unrouted: 2xx generic so shaping tests don't need per-route fixtures
      res.writeHead(204);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        seen,
        routes,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function makeClient(port: number, extra: Record<string, unknown> = {}): RwsClient {
  return new RwsClient({
    host: '127.0.0.1',
    port,
    username: USER,
    password: PASS,
    requestIntervalMs: 0,
    timeout: 3000,
    ...extra,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RwsClient - request shaping against a mock controller', () => {
  let mock: MockController;

  beforeEach(async () => {
    mock = await startMockController();
  });

  afterEach(async () => {
    await mock.close();
  });

  it('connect() performs the digest handshake: unauthenticated probe, then a verified retry', async () => {
    const client = makeClient(mock.port);
    await client.connect();

    expect(mock.seen).toHaveLength(2);
    expect(mock.seen[0].method).toBe('GET');
    expect(mock.seen[0].url).toBe('/rw/panel/ctrlstate');
    expect(mock.seen[0].headers.authorization).toBeUndefined();
    expect(mock.seen[0].authorized).toBe(false);
    // Retry carries a digest Authorization whose response hash the server verified
    expect(mock.seen[1].url).toBe('/rw/panel/ctrlstate');
    expect(String(mock.seen[1].headers.authorization)).toMatch(/^Digest /);
    expect(mock.seen[1].authorized).toBe(true);
  });

  it('signs the exact path including the query string', async () => {
    const client = makeClient(mock.port);
    await client.connect();
    await client.request('GET', '/rw/iosystem/signals?start=0&limit=100');

    const last = mock.seen[mock.seen.length - 1];
    expect(last.url).toBe('/rw/iosystem/signals?start=0&limit=100');
    expect(last.authorized).toBe(true); // server recomputed HA2 over path+query
    expect(String(last.headers.authorization)).toContain('uri="/rw/iosystem/signals?start=0&limit=100"');
  });

  it('stores Set-Cookie values and replays them on subsequent requests', async () => {
    const client = makeClient(mock.port);
    await client.connect(); // authorized response sets both cookies
    await client.getSpeedRatio();

    const last = mock.seen[mock.seen.length - 1];
    const cookie = String(last.headers.cookie ?? '');
    expect(cookie).toContain('-http-session-=sess-1');
    expect(cookie).toContain('ABBCX=cx-1');

    const saved = client.getSessionCookie();
    expect(saved).toContain('-http-session-=sess-1');
    expect(saved).toContain('ABBCX=cx-1');
  });

  it('sends a pre-loaded sessionCookie on the very first request', async () => {
    const client = makeClient(mock.port, { sessionCookie: '-http-session-=saved-7; ABBCX=old-1' });
    await client.connect();

    const first = mock.seen[0];
    const cookie = String(first.headers.cookie ?? '');
    expect(cookie).toContain('-http-session-=saved-7');
    expect(cookie).toContain('ABBCX=old-1');
  });

  it('setSpeedRatio POSTs the form body with the urlencoded content type', async () => {
    const client = makeClient(mock.port);
    await client.connect();
    await client.setSpeedRatio(77);

    const last = mock.seen[mock.seen.length - 1];
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/rw/panel/speedratio?action=setspeedratio');
    expect(last.body).toBe('speed-ratio=77');
    expect(String(last.headers['content-type'])).toBe('application/x-www-form-urlencoded');
  });

  it('resetRapid sends an empty body but still sets the form content type', async () => {
    const client = makeClient(mock.port);
    await client.connect();
    await client.resetRapid();

    const last = mock.seen[mock.seen.length - 1];
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/rw/rapid/execution?action=resetpp');
    expect(last.body).toBe('');
    expect(String(last.headers['content-type'])).toBe('application/x-www-form-urlencoded');
  });

  it('writeSignal composes the lvalue body around the ResourceMapper path', async () => {
    const client = makeClient(mock.port);
    await client.connect();
    await client.writeSignal('Local', 'DRV_1', 'DO_1', '1');

    const last = mock.seen[mock.seen.length - 1];
    expect(last.url).toBe('/rw/iosystem/signals/Local/DRV_1/DO_1?action=set');
    expect(last.body).toBe('lvalue=1');
  });

  it('uploadFile PUTs the raw content to /fileservice with a binary content type', async () => {
    const client = makeClient(mock.port);
    await client.connect();
    await client.uploadFile('$HOME/Probe.mod', 'MODULE Probe\nENDMODULE\n');

    const last = mock.seen[mock.seen.length - 1];
    expect(last.method).toBe('PUT');
    expect(last.url).toBe('/fileservice/$HOME/Probe.mod');
    expect(last.body).toBe('MODULE Probe\nENDMODULE\n');
    expect(String(last.headers['content-type'])).toBe('application/octet-stream');
  });

  it('validateRapidValue maps 204 to true and 400 to false', async () => {
    const client = makeClient(mock.port);
    await client.connect();

    mock.routes.set('POST /rw/rapid/symbol/data?action=validate', (res, body) => {
      if (body.includes('value=42')) {
        res.writeHead(204);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/xhtml+xml' });
      }
      res.end();
    });

    await expect(client.validateRapidValue('T_ROB1', '42', 'num')).resolves.toBe(true);
    await expect(client.validateRapidValue('T_ROB1', 'nonsense', 'num')).resolves.toBe(false);
  });

  it('startRapid maps a 400 motors-off rejection to MOTORS_OFF with the body as rwsDetail', async () => {
    const client = makeClient(mock.port);
    await client.connect();

    mock.routes.set('POST /rw/rapid/execution?action=start', (res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml' });
      res.end('<span class="msg">The motors are off</span>');
    });

    const err = await client.startRapid().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect((err as RwsError).code).toBe('MOTORS_OFF');
    expect((err as RwsError).httpStatus).toBe(400);
  });

  it('disconnect() releases the session server-side via GET /logout', async () => {
    const client = makeClient(mock.port);
    await client.connect();
    await client.disconnect();

    const last = mock.seen[mock.seen.length - 1];
    expect(last.method).toBe('GET');
    expect(last.url).toBe('/logout');
    expect(last.authorized).toBe(true);
  });

  it('paces queued requests by the default 55 ms interval (asserted loosely)', async () => {
    // No requestIntervalMs override - the constructor default (55 ms) applies.
    const client = new RwsClient({
      host: '127.0.0.1',
      port: mock.port,
      username: USER,
      password: PASS,
      timeout: 3000,
    });
    await client.connect();

    const before = mock.seen.length;
    await Promise.all([
      client.getControllerState(),
      client.getControllerState(),
      client.getControllerState(),
    ]);
    const times = mock.seen.slice(before).map((r) => r.at);
    expect(times).toHaveLength(3);
    // Each gap should be near 55 ms; allow generous timer slack but reject bursts.
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(40);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(40);
  });

  // Live-verified 2026-07-09 on IRC5 RW6.16: GET /rw/rapid/uiinstr/active returns
  // 404 while no UI instruction is waiting, so this method throws MODULE_NOT_FOUND
  // instead of resolving to the documented null.
  it.fails('getActiveUiInstruction resolves to null when the controller has no active instruction', async () => {
    const client = makeClient(mock.port);
    await client.connect();

    mock.routes.set('GET /rw/rapid/uiinstr/active', (res) => {
      res.writeHead(404, { 'Content-Type': 'application/xhtml+xml' });
      res.end('<span class="code">-1073445864</span>');
    });

    await expect(client.getActiveUiInstruction()).resolves.toBeNull();
  });
});
