import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { accessOf, type AccessObservation } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';

/**
 * RWS 2.0 client, end to end over a mock controller: a write refused as "not
 * held" inside a hold this session counted is a lost hold, and a stale
 * RobotWare 8 registration flag is not trusted.
 *
 * The refusal bodies are the ones captured live on RW 8.1.1 (2026-09-15):
 * -1073435873 "The control station does not have SPoC" and -1073435871
 * "Session is not part of a Control Station".
 */

interface Recorded { method: string; url: string }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean | void;

async function startServer(extra?: Handler): Promise<{ server: http.Server; port: number; wire: Recorded[] }> {
  const wire: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      wire.push({ method: req.method ?? '', url: req.url ?? '' });
      if (extra?.(req, res)) { return; }
      if (req.url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.1.1+614"}]}');
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, wire };
}

const writes = (wire: Recorded[]): string[] =>
  wire.map(r => `${r.method} ${r.url}`).filter(w => /^(POST|PUT|DELETE) /.test(w));

function refusal(code: number, msg: string): string {
  return `{"_links":{"base":{"href":"https://x/"}},"status":{"code":${code},"msg":"rws_resource_controlstation.cpp[1] ${msg} code:${code}"}}`;
}

const SPEED = '/rw/panel/speedratio?action=setspeedratio';
const REGISTER = 'POST /rw/controlstation/register/remote';
const REQUEST = 'POST /rw/controlstation/writeaccess/request';
const RELEASE = 'POST /rw/controlstation/writeaccess/release';

/** Answer the first speed-ratio write with `body` (HTTP 403), later ones with 204. */
function refuseFirstWrite(body: string): Handler {
  let refused = false;
  return (req, res) => {
    if (req.url !== SPEED || refused) { return false; }
    refused = true;
    res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
    res.end(body);
    return true;
  };
}

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('RWS 2.0: a write refused as not held (RobotWare 8)', () => {
  it('inside the caller\'s write access: the hold is lost, the refusal is passed on, and the next write requests afresh', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    const { server, port, wire } = await startServer(refuseFirstWrite(refusal(-1073435873, 'The control station does not have SPoC.')));
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const events: AccessObservation[] = [];
      accessOf(c)!.on(e => events.push(e));
      await c.requestWriteAccess();
      await expect(c.setSpeedRatio(50)).rejects.toMatchObject({ controllerCode: -1073435873 });
      expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'writeaccess', reason: 'unknown' }));
      expect(warnings.some(w => /control-station write access was lost: the controller refused a write of this operation as not holding access/.test(w))).toBe(true);
      expect(accessOf(c)!.snapshot().locks[0]).toMatchObject({ state: 'lost', count: 0 });

      // The caller's own release pairs with the lost hold: nothing is sent.
      await c.releaseWriteAccess();
      expect(writes(wire)).toEqual([REGISTER, REQUEST, `POST ${SPEED}`]);
      await c.setSpeedRatio(60);
      expect(writes(wire).slice(3)).toEqual([REQUEST, `POST ${SPEED}`, RELEASE]);
    } finally { server.close(); }
  });

  it('"not part of a control station": the registration flag is not trusted - the next write registers again', async () => {
    setLogger({ info() {}, warn() {}, error() {}, show() {} });
    const { server, port, wire } = await startServer(refuseFirstWrite(refusal(-1073435871, 'Session is not part of a Control Station.')));
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const events: AccessObservation[] = [];
      accessOf(c)!.on(e => events.push(e));
      await expect(c.setSpeedRatio(50)).rejects.toMatchObject({ controllerCode: -1073435871 });
      expect(events).toContainEqual(expect.objectContaining({ type: 'lost', lock: 'writeaccess', reason: 'unknown' }));
      expect(accessOf(c)!.snapshot().rw8).toMatchObject({ registered: false });
      await c.setSpeedRatio(60);
      expect(writes(wire)).toEqual([
        REGISTER, REQUEST, `POST ${SPEED}`,
        REGISTER, REQUEST, `POST ${SPEED}`, RELEASE,
      ]);
    } finally { server.close(); }
  });
});
