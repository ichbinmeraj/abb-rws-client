import * as http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, afterEach } from 'vitest';
import { RobotManager } from '../src/RobotManager.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsClient } from '../src/RwsClient.js';
import { accessOf } from '../src/access/AccessManager.js';
import { setLogger } from '../src/Logger.js';
import { RwsError } from '../src/types.js';
import type { WriteAccessStatus } from '../src/index.js';

/**
 * RobotManager.getWriteAccessStatus(): one GET of RobotWare 8's
 * control-station write-access status, read strictly. A field is true only
 * for the text "true" and false only for "false"; anything else, an absent
 * field included, is null. No station id is in the result. An answer with no
 * status entry is PARSE_ERROR; RobotWare 6 and 7 are UNSUPPORTED_OPERATION
 * with nothing sent.
 *
 * The RECORDED_* bodies are the controller's answers as read: hal+json from
 * RobotWare 8.2.1+1023 and 8.1.1+614 (2026-10-05 and 2026-10-06), XHTML from
 * 8.2.1+1023 (2026-09-29).
 */

const STATUS = '/rw/controlstation/writeaccess/status';
const OWN_ID = '{AAAAAAAA-0000-4000-8000-000000000001}';
const PROBE_ID = '{2C8E5B1A-7D34-4F1B-9A0C-5E6F7A8B9C0D}';

const RECORDED_HELD_RW821 = '{ "_links": { "base": { "href": "https://127.0.0.1:9403/rw/controlstation/" }, "self": { "href": "" } },  "state": [ { "_type": "controlstation-write-access-status", "_title": "write-access-status", "held-by-control-station-Id": "{2C8E5B1A-7D34-4F1B-9A0C-5E6F7A8B9C0D}", "held-by-control-station-name": "zz-probe", "control-station-write-access-held": "true", "control-station-external-control-enabled": "true" } ]}';
const RECORDED_RELEASED_RW821 = '{ "_links": { "base": { "href": "https://127.0.0.1:9403/rw/controlstation/" }, "self": { "href": "" } },  "state": [ { "_type": "controlstation-write-access-status", "_title": "write-access-status", "held-by-control-station-Id": "none", "held-by-control-station-name": "none", "control-station-write-access-held": "false", "control-station-external-control-enabled": "true" } ]}';
const RECORDED_RELEASED_RW811 = '{ "_links": { "base": { "href": "https://127.0.0.1:80/rw/controlstation/" }, "self": { "href": "" } },  "state": [ { "_type": "controlstation-write-access-status", "_title": "write-access-status", "held-by-control-station-Id": "none", "held-by-control-station-name": "none", "control-station-write-access-held": "false", "control-station-external-control-enabled": "true" } ]}';
const RECORDED_RELEASED_XHTML_RW821 = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <base href="https://127.0.0.1:80/rw/controlstation/"/> </head> <body>  <div class="state">  <a href="controlstation" rel="self"/> <ul> <li class="controlstation-write-access-status" title="write-access-status"> <span class="held-by-control-station-Id">none</span> <span class="held-by-control-station-name">none</span> <span class="control-station-write-access-held">false</span> <span class="control-station-external-control-enabled">true</span> </li> </ul></div> </body></html>';

/** The fields of the recorded held answer, for variants with one field changed or left out. */
const HELD_FIELDS: Record<string, string> = {
  'held-by-control-station-Id': PROBE_ID,
  'held-by-control-station-name': 'zz-probe',
  'control-station-write-access-held': 'true',
  'control-station-external-control-enabled': 'true',
};

/** A hal+json status answer with exactly these fields (the recorded envelope). */
function hal(fields: Record<string, string>): string {
  return JSON.stringify({
    _links: { base: { href: 'https://127.0.0.1:9403/rw/controlstation/' }, self: { href: '' } },
    state: [{ _type: 'controlstation-write-access-status', _title: 'write-access-status', ...fields }],
  });
}

function without(key: string): Record<string, string> {
  const rest = { ...HELD_FIELDS };
  delete rest[key];
  return rest;
}

/**
 * A real RWS 2.0 adapter whose transport is a recorder (no network), with the
 * generation set the way connect() sets it (null: the controller reported no
 * usable RobotWare version).
 */
function rws2(generation: 'rw7' | 'rw8' | null, answer: () => string, ownId = OWN_ID) {
  const wire: string[] = [];
  const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p', {
    controlStation: { name: 'Line 3 cell PC', id: ownId, pincode: '4711' },
  });
  const a = adapter as unknown as Record<string, unknown>;
  a.writeAccessMode = generation === 'rw8' ? 'controlstation' : generation === 'rw7' ? 'mastership' : null;
  a.req = async (method: string, path: string) => {
    wire.push(`${method} ${path}`);
    return answer();
  };
  return { adapter, wire };
}

function manager(adapter: unknown): RobotManager {
  const mgr = new RobotManager();
  (mgr as unknown as { adapter: unknown }).adapter = adapter;
  return mgr;
}

async function read(body: string, ownId = OWN_ID): Promise<{ status: WriteAccessStatus; wire: string[] }> {
  const { adapter, wire } = rws2('rw8', () => body, ownId);
  return { status: await manager(adapter).getWriteAccessStatus(), wire };
}

async function readError(body: string): Promise<unknown> {
  const { adapter } = rws2('rw8', () => body);
  return manager(adapter).getWriteAccessStatus().then(() => null, (e: unknown) => e);
}

const quiet = { info() {}, warn() {}, error() {}, show() {} };
afterEach(() => { setLogger(quiet); });

describe('RobotManager.getWriteAccessStatus: the recorded RobotWare 8 answers', () => {
  it('held by another station (8.2.1): held, not by me, its name, and no id in the result', async () => {
    const { status, wire } = await read(RECORDED_HELD_RW821);
    expect(status).toEqual({ held: true, heldByMe: false, heldByName: 'zz-probe', externalControlEnabled: true });
    expect(Object.keys(status).sort()).toEqual(['externalControlEnabled', 'held', 'heldByMe', 'heldByName']);
    expect(JSON.stringify(status)).not.toContain('2C8E5B1A');
    expect(JSON.stringify(status)).not.toContain('AAAAAAAA');
    expect(wire).toEqual([`GET ${STATUS}`]);
  });

  it('held by this client\'s own station: heldByMe from the id comparison, case ignored, still no id in the result', async () => {
    const { status } = await read(RECORDED_HELD_RW821, PROBE_ID.toLowerCase());
    expect(status).toEqual({ held: true, heldByMe: true, heldByName: 'zz-probe', externalControlEnabled: true });
    expect(JSON.stringify(status).toLowerCase()).not.toContain('2c8e5b1a');
  });

  it('released (8.2.1 and 8.1.1, hal+json; 8.2.1 XHTML): held false, heldByMe false, the name `none` is null', async () => {
    const released = { held: false, heldByMe: false, heldByName: null, externalControlEnabled: true };
    expect((await read(RECORDED_RELEASED_RW821)).status).toEqual(released);
    expect((await read(RECORDED_RELEASED_RW811)).status).toEqual(released);
    expect((await read(RECORDED_RELEASED_XHTML_RW821)).status).toEqual(released);
  });
});

describe('RobotManager.getWriteAccessStatus: a field the answer does not carry is null, never false', () => {
  it('an answer without the held field gives held null (not false), and heldByMe null', async () => {
    const { status } = await read(hal(without('control-station-write-access-held')));
    expect(status.held).toBeNull();
    expect(status.heldByMe).toBeNull();
    expect(status).toEqual({ held: null, heldByMe: null, heldByName: 'zz-probe', externalControlEnabled: true });
  });

  it('the RwsClient2 reading of that same answer is unchanged: held false (its shape stays as it was)', async () => {
    const { adapter } = rws2('rw8', () => hal(without('control-station-write-access-held')));
    expect(await adapter.getWriteAccessStatus()).toEqual({
      held: false, heldByMe: false, heldById: PROBE_ID, heldByName: 'zz-probe', externalControlEnabled: true,
    });
  });

  it('an answer without the external-control field gives externalControlEnabled null', async () => {
    const { status } = await read(hal(without('control-station-external-control-enabled')));
    expect(status).toEqual({ held: true, heldByMe: false, heldByName: 'zz-probe', externalControlEnabled: null });
  });

  it('an answer without the holder name gives heldByName null', async () => {
    expect((await read(hal(without('held-by-control-station-name')))).status.heldByName).toBeNull();
    expect((await read(hal({ ...HELD_FIELDS, 'held-by-control-station-name': '' }))).status.heldByName).toBeNull();
  });

  it('a status entry with no fields at all gives every field null (the entry is there, so no PARSE_ERROR)', async () => {
    expect((await read(hal({}))).status).toEqual({ held: null, heldByMe: null, heldByName: null, externalControlEnabled: null });
  });
});

describe('RobotManager.getWriteAccessStatus: only the texts "true" and "false" are flags', () => {
  it('"true" is true and "false" is false, for held and for externalControlEnabled', async () => {
    const t = (await read(hal({ ...HELD_FIELDS, 'control-station-external-control-enabled': 'true' }))).status;
    expect([t.held, t.externalControlEnabled]).toEqual([true, true]);
    const f = (await read(hal({
      ...HELD_FIELDS, 'control-station-write-access-held': 'false', 'control-station-external-control-enabled': 'false',
    }))).status;
    expect([f.held, f.externalControlEnabled]).toEqual([false, false]);
  });

  it.each(['TRUE', 'True', 'FALSE', ' true', 'false ', '1', '0', 'yes', 'none', ''])(
    'the text %j is null for held (and heldByMe) and for externalControlEnabled',
    async (text) => {
      const { status } = await read(hal({
        ...HELD_FIELDS, 'control-station-write-access-held': text, 'control-station-external-control-enabled': text,
      }));
      expect(status.held).toBeNull();
      expect(status.heldByMe).toBeNull();
      expect(status.externalControlEnabled).toBeNull();
      expect(status.heldByName).toBe('zz-probe');
    },
  );
});

describe('RobotManager.getWriteAccessStatus: heldByMe is an id comparison', () => {
  it('held with no holder id, an empty one or `none`: heldByMe null (not known)', async () => {
    expect((await read(hal(without('held-by-control-station-Id')))).status.heldByMe).toBeNull();
    expect((await read(hal({ ...HELD_FIELDS, 'held-by-control-station-Id': '' }))).status.heldByMe).toBeNull();
    expect((await read(hal({ ...HELD_FIELDS, 'held-by-control-station-Id': 'none' }))).status.heldByMe).toBeNull();
  });

  it('held null with this client\'s own id named: heldByMe null, not true', async () => {
    const { status } = await read(hal({ ...without('control-station-write-access-held'), 'held-by-control-station-Id': OWN_ID }));
    expect(status.heldByMe).toBeNull();
  });

  it('not held, even with this client\'s own id named: heldByMe false', async () => {
    const { status } = await read(hal({
      ...HELD_FIELDS, 'control-station-write-access-held': 'false', 'held-by-control-station-Id': OWN_ID,
    }));
    expect(status.heldByMe).toBe(false);
  });

  it('compares with the identity the session registered last, and returns no id', async () => {
    const { adapter } = rws2('rw8', () => hal({ ...HELD_FIELDS, 'held-by-control-station-Id': PROBE_ID }));
    const mgr = manager(adapter);
    expect((await mgr.getWriteAccessStatus()).heldByMe).toBe(false);
    await adapter.registerControlStationRemote('zz-probe', PROBE_ID, '1234');
    const status = await mgr.getWriteAccessStatus();
    expect(status.heldByMe).toBe(true);
    expect(JSON.stringify(status)).not.toContain('2C8E5B1A');
  });
});

describe('RobotManager.getWriteAccessStatus: failures', () => {
  it('an empty body throws PARSE_ERROR', async () => {
    const e = await readError('');
    expect(e).toBeInstanceOf(RwsError);
    expect((e as RwsError).code).toBe('PARSE_ERROR');
  });

  it('an answer with no write-access status entry throws PARSE_ERROR, naming what it saw', async () => {
    for (const body of [
      '{}',
      '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.2.1+1023"}]}',
      '<html><body><ul><li class="controlstation-type" title="type"><span class="control-station-type">remote</span></li></ul></body></html>',
    ]) {
      const e = await readError(body);
      expect(e).toBeInstanceOf(RwsError);
      expect((e as RwsError).code).toBe('PARSE_ERROR');
      expect((e as RwsError).message).toContain('controlstation-write-access-status');
    }
  });

  it('a failed request throws the adapter\'s own error, unchanged', async () => {
    const refused = new RwsError('RWS2 GET /rw/controlstation/writeaccess/status: HTTP 503', 'CONTROLLER_BUSY', 503);
    const { adapter, wire } = rws2('rw8', () => { throw refused; });
    await expect(manager(adapter).getWriteAccessStatus()).rejects.toBe(refused);
    expect(wire).toEqual([`GET ${STATUS}`]);
  });

  it('before a connect: NOT_CONNECTED', async () => {
    await expect(new RobotManager().getWriteAccessStatus()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});

describe('RobotManager.getWriteAccessStatus: RobotWare 7, RWS 1.0 and an unknown generation', () => {
  it('RobotWare 7: UNSUPPORTED_OPERATION and nothing sent', async () => {
    const { adapter, wire } = rws2('rw7', () => RECORDED_HELD_RW821);
    const e = await manager(adapter).getWriteAccessStatus().then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(RwsError);
    expect((e as RwsError).code).toBe('UNSUPPORTED_OPERATION');
    expect((e as RwsError).message).toContain('Nothing was sent');
    expect(wire).toEqual([]);
  });

  it('an RWS 2.0 connection whose generation is not known: the GET is sent and the answer decides', async () => {
    const { adapter, wire } = rws2(null, () => RECORDED_RELEASED_RW821);
    expect(await manager(adapter).getWriteAccessStatus()).toEqual({
      held: false, heldByMe: false, heldByName: null, externalControlEnabled: true,
    });
    expect(wire).toEqual([`GET ${STATUS}`]);

    const notFound = new RwsError('RWS2 GET /rw/controlstation/writeaccess/status: HTTP 404', 'RESOURCE_NOT_FOUND', 404);
    const seven = rws2(null, () => { throw notFound; });
    await expect(manager(seven.adapter).getWriteAccessStatus()).rejects.toBe(notFound);
  });

  it('an adapter without the read (a plain IRWSAdapter): UNSUPPORTED_OPERATION and no call on it', async () => {
    const calls: string[] = [];
    const adapter = new Proxy({}, {
      get: (_t, prop) => (typeof prop === 'string' && prop !== 'then'
        ? (...args: unknown[]) => { calls.push(`${prop}(${args.length})`); return Promise.resolve(null); }
        : undefined),
    });
    await expect(manager(adapter).getWriteAccessStatus()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(calls).toEqual([]);
  });
});

// ─── On the wire, through a local HTTP server ────────────────────────────────

type Recorded = { method: string; url: string; accept: string };

async function startServer(answer: (url: string) => { status: number; body: string; type?: string }) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', accept: String(req.headers['accept'] ?? '') });
      const a = answer(req.url ?? '');
      res.writeHead(a.status, a.body ? { 'Content-Type': a.type ?? 'application/hal+json;v=2.0' } : {});
      res.end(a.body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const system = (rw: string): string =>
  `{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rw}"}]}`;

describe('RobotManager.getWriteAccessStatus on the wire', () => {
  it('RobotWare 8.2.1: exactly one GET of the status after connect, nothing registered or requested', async () => {
    const { server, port, requests } = await startServer(url => (url === '/rw/system'
      ? { status: 200, body: system('8.2.1+1023') }
      : url === STATUS ? { status: 200, body: RECORDED_HELD_RW821 } : { status: 204, body: '' }));
    const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p', {
      controlStation: { name: 'Line 3 cell PC', id: OWN_ID, pincode: '4711' },
    });
    try {
      await adapter.connect();
      const before = requests.length;
      const mgr = manager(adapter);
      const status = await mgr.getWriteAccessStatus();
      expect(status).toEqual({ held: true, heldByMe: false, heldByName: 'zz-probe', externalControlEnabled: true });
      expect(requests.slice(before).map(r => `${r.method} ${r.url}`)).toEqual([`GET ${STATUS}`]);
      // The status GET negotiates HAL JSON, the representation the parser reads.
      expect(requests[before]!.accept).toBe('application/hal+json;v=2.0');
      expect(requests.every(r => r.method === 'GET')).toBe(true);
      expect(requests.some(r => r.url.includes('/register') || r.url.includes('/request'))).toBe(false);
      // The session's own bookkeeping agrees: not registered, nothing held.
      const own = accessOf(adapter)!.snapshot();
      expect(own.generation).toBe('rw8');
      expect(own.rw8).toMatchObject({ registered: false });
      expect(own.locks.every(l => l.state === 'idle' && l.count === 0)).toBe(true);
    } finally {
      await adapter.disconnect();
      server.close();
    }
  });

  it('RobotWare 8: an empty 204 answer throws PARSE_ERROR after its one GET', async () => {
    const { server, port, requests } = await startServer(url => (url === '/rw/system'
      ? { status: 200, body: system('8.2.1+1023') }
      : { status: 204, body: '' }));
    const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
    try {
      await adapter.connect();
      const before = requests.length;
      await expect(manager(adapter).getWriteAccessStatus()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
      expect(requests.slice(before).map(r => `${r.method} ${r.url}`)).toEqual([`GET ${STATUS}`]);
    } finally {
      await adapter.disconnect();
      server.close();
    }
  });

  it('RobotWare 7.21.4: UNSUPPORTED_OPERATION, and nothing after the connect\'s own read', async () => {
    const { server, port, requests } = await startServer(url => (url === '/rw/system'
      ? { status: 200, body: system('7.21.4+417') }
      : { status: 404, body: '' }));
    const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
    try {
      await adapter.connect();
      const before = requests.length;
      await expect(manager(adapter).getWriteAccessStatus()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
      expect(requests.slice(before)).toEqual([]);
    } finally {
      await adapter.disconnect();
      server.close();
    }
  });

  it('RWS 1.0 (RobotWare 6): UNSUPPORTED_OPERATION, and no request at all', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 404, body: '' }));
    const adapter = new RWS1Adapter(new RwsClient({ host: '127.0.0.1', port, username: 'u', password: 'p' }));
    try {
      const e = await manager(adapter).getWriteAccessStatus().then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(RwsError);
      expect((e as RwsError).code).toBe('UNSUPPORTED_OPERATION');
      expect((e as RwsError).message).toContain('Nothing was sent');
      expect(requests).toEqual([]);
    } finally {
      server.close();
    }
  });
});
