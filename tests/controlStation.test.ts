import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkControlStationIdentity, type ControlStationIdentity } from '../src/controlStation.js';
import * as R2 from '../src/ResourceMapper2.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import { MultiRobotManager } from '../src/MultiRobotManager.js';
import { RwsError } from '../src/types.js';
import { Logger } from '../src/Logger.js';
import { accessOf } from '../src/access/AccessManager.js';

/**
 * The RobotWare 8 control-station identity a caller supplies: checked where it
 * enters (ConnectOptions, RobotManagerOptions, RobotConfig), passed to every
 * RWS 2.0 client, and sent in the registration body. Without one the client
 * keeps the anonymous default and says so once.
 */

// Record the options RobotManager hands each RWS 2.0 adapter it builds.
const rws2CtorArgs = vi.hoisted(() => [] as unknown[][]);
vi.mock('../src/RWS2Adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/RWS2Adapter.js')>();
  class RWS2Adapter extends actual.RWS2Adapter {
    constructor(...args: unknown[]) {
      super(...(args as ConstructorParameters<typeof actual.RWS2Adapter>));
      rws2CtorArgs.push(args);
    }
  }
  return { RWS2Adapter };
});

const ID = '{6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b}';
const STATION: ControlStationIdentity = { name: 'RWS Daemon on cell-7', id: ID, pincode: '4711' };
const REGISTER = '/rw/controlstation/register/remote';

/** The INVALID_ARGUMENT error `fn` throws (fails the test if it throws nothing). */
function invalid(fn: () => unknown): RwsError {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(RwsError);
    expect((e as RwsError).code).toBe('INVALID_ARGUMENT');
    return e as RwsError;
  }
  throw new Error('expected INVALID_ARGUMENT, nothing was thrown');
}

// ─── Local RW8 stand-in ──────────────────────────────────────────────────────

interface Recorded { method: string; url: string; body: string }

async function startRw8(onRequest?: (url: string) => Record<string, string[]> | void): Promise<{
  server: http.Server; port: number; requests: Recorded[];
}> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8') });
      if (url.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
      res.writeHead(204, onRequest?.(url) ?? {});
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const registerBodies = (requests: Recorded[]): string[] => requests.filter(r => r.url === REGISTER).map(r => r.body);

afterEach(() => { vi.restoreAllMocks(); });

// ─── The check ───────────────────────────────────────────────────────────────

describe('checkControlStationIdentity', () => {
  it('accepts a name, a braced GUID in either case and a PIN of up to 11 digits', () => {
    expect(checkControlStationIdentity(STATION, 'x')).toEqual({ ...STATION, releaseWriteAccessWhenLost: false });
    expect(checkControlStationIdentity({ ...STATION, id: ID.toUpperCase(), pincode: '12345678901' }, 'x').pincode)
      .toBe('12345678901');
    expect(checkControlStationIdentity({ ...STATION, releaseWriteAccessWhenLost: true }, 'x').releaseWriteAccessWhenLost)
      .toBe(true);
    // An RW 8.1.1 VC registered an empty PIN, so it is not refused here.
    expect(checkControlStationIdentity({ ...STATION, pincode: '' }, 'x').pincode).toBe('');
  });

  it('refuses every id that is not a braced GUID, naming the field without echoing the value', () => {
    const bare = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    for (const id of [bare, `{${bare}`, `${bare}}`, '{6f1c2a3b4d5e4f608a7b9c0d1e2f3a4b}', '{6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4g}',
      `{${bare}} `, 'Station001', '', 42, undefined]) {
      const e = invalid(() => checkControlStationIdentity({ ...STATION, id }, 'ConnectOptions.controlStation'));
      expect(e.message).toContain('ConnectOptions.controlStation.id must be a braced GUID');
      if (typeof id === 'string' && id !== '') { expect(e.message).not.toContain(id); }
    }
  });

  it('refuses an empty name, a PIN that is not up to 11 digits, and a non-boolean auto-release', () => {
    expect(invalid(() => checkControlStationIdentity({ ...STATION, name: '  ' }, 'o')).message).toContain('o.name');
    expect(invalid(() => checkControlStationIdentity({ ...STATION, name: undefined }, 'o')).message).toContain('o.name');
    for (const pincode of ['abcd', '123456789012', '12 34', '-1', 1234, undefined]) {
      const e = invalid(() => checkControlStationIdentity({ ...STATION, pincode }, 'o'));
      expect(e.message).toContain('o.pincode');
      if (typeof pincode === 'string') { expect(e.message).not.toContain(pincode); }
    }
    expect(invalid(() => checkControlStationIdentity({ ...STATION, releaseWriteAccessWhenLost: 'TRUE' }, 'o')).message)
      .toContain('o.releaseWriteAccessWhenLost');
    for (const identity of [null, 'station', [STATION], 7]) {
      expect(invalid(() => checkControlStationIdentity(identity, 'o')).message).toContain('o must be an object');
    }
  });
});

// ─── The register body ───────────────────────────────────────────────────────

describe('register/remote body', () => {
  it('carries the three fields every registration has sent, and nothing else by default', () => {
    expect(R2.registerControlStationRemote('cs', ID, '4711')).toEqual({
      path: REGISTER,
      body: { 'control-station-name': 'cs', 'control-station-id': ID, pincode: '4711' },
    });
    expect(R2.registerControlStationRemote('cs', ID, '4711', false).body)
      .not.toHaveProperty('release-write-access-when-lost');
  });

  it('adds release-write-access-when-lost=TRUE, the documented {TRUE|FALSE} form, only when asked', () => {
    expect(R2.registerControlStationRemote('cs', ID, '4711', true).body).toEqual({
      'control-station-name': 'cs', 'control-station-id': ID, pincode: '4711',
      'release-write-access-when-lost': 'TRUE',
    });
  });
});

// ─── On the wire (RwsClient2) ────────────────────────────────────────────────

describe('RwsClient2 registers with the configured identity', () => {
  it('sends the caller\'s name, id and PIN, and the auto-release field when set', async () => {
    const { server, port, requests } = await startRw8();
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p',
        { controlStation: { ...STATION, releaseWriteAccessWhenLost: true } });
      await client.requestWriteAccess();
      await client.releaseWriteAccess();
      expect(registerBodies(requests)).toEqual([
        'control-station-name=RWS+Daemon+on+cell-7&control-station-id=%7B6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b%7D'
          + '&pincode=4711&release-write-access-when-lost=TRUE',
      ]);
    } finally { server.close(); }
  });

  it('the public registerControlStationRemote sends the configured auto-release choice too', async () => {
    const { server, port, requests } = await startRw8();
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p',
        { controlStation: { ...STATION, releaseWriteAccessWhenLost: true } });
      await client.registerControlStationRemote();
      expect(registerBodies(requests)[0]).toMatch(/&release-write-access-when-lost=TRUE$/);
    } finally { server.close(); }
  });

  it('without the option: today\'s anonymous station, noted once per client instance', async () => {
    // A re-issued session cookie makes the client register a second time; the
    // note is not repeated, and it never carries the generated id.
    let session = 'A';
    const { server, port, requests } = await startRw8(url => {
      if (url === '/rw/controlstation/writeaccess/release') { session = 'B'; }
      return { 'Set-Cookie': [`-http-session-=${session}; path=/`] };
    });
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await client.requestWriteAccess();
      await client.releaseWriteAccess();
      await client.requestWriteAccess();
      await client.releaseWriteAccess();

      const bodies = registerBodies(requests);
      expect(bodies).toHaveLength(2);
      for (const b of bodies) {
        expect(b).toMatch(/^control-station-name=abb-rws-client&control-station-id=%7B[0-9a-f-]{36}%7D&pincode=1234$/);
      }
      const notes = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('anonymous'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("the default name 'abb-rws-client' and an id generated for this client instance");
      expect(notes[0]).toContain('controlStation { name, id, pincode }');
      const generatedId = decodeURIComponent(bodies[0].match(/control-station-id=([^&]+)/)![1]);
      expect(notes[0]).not.toContain(generatedId);
    } finally { server.close(); }
  });

  it('a named station with its own id is not noted as anonymous; an id alone still is', async () => {
    const { server, port } = await startRw8();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    try {
      await new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION }).requestWriteAccess();
      expect(warn.mock.calls.filter(c => String(c[0]).includes('anonymous'))).toEqual([]);

      await new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: { id: ID } }).requestWriteAccess();
      const notes = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('anonymous'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("the default name 'abb-rws-client'");
      expect(notes[0]).not.toContain('an id generated');
      expect(notes[0]).not.toContain(ID);
    } finally { server.close(); }
  });

  it('an explicit name and id given to registerControlStationRemote are adopted, and nothing is noted', async () => {
    let session = 'A';
    const { server, port, requests } = await startRw8(url => {
      if (url === '/rw/controlstation/writeaccess/release') { session = 'B'; }
      return { 'Set-Cookie': [`-http-session-=${session}; path=/`] };
    });
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await client.registerControlStationRemote('probe', ID, '9999');
      await client.requestWriteAccess();
      await client.releaseWriteAccess();          // re-issues the session
      await client.requestWriteAccess();          // registers again, as the adopted station
      const bodies = registerBodies(requests);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[1]).toContain('control-station-name=probe&control-station-id=%7B6f1c2a3b');
      expect(warn.mock.calls.filter(c => String(c[0]).includes('anonymous'))).toEqual([]);
    } finally { server.close(); }
  });
});

describe('RobotState.access.rw8 shows the registered identity and the motion-control declaration', () => {
  const snapshot = (client: RwsClient2) => accessOf(client)!.snapshot().rw8!;
  // The stand-in answers 204 to /rw/system, so the RobotWare 8 mode is set the
  // way connect() sets it from the version.
  const rw8 = (client: RwsClient2): RwsClient2 => {
    (client as unknown as { writeAccessMode: string }).writeAccessMode = 'controlstation';
    return client;
  };

  it('an explicit registerControlStationRemote(name, id, pincode) wins over the option and is recorded as explicit, name only', async () => {
    const { server, port } = await startRw8();
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    try {
      const client = rw8(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION }));
      expect(snapshot(client)).toEqual({
        registered: false, stationName: STATION.name, identity: null, allowMotionControl: null, allowMotionControlSince: null,
      });
      await client.registerControlStationRemote('probe', ID, '9999');
      expect(snapshot(client)).toMatchObject({ registered: true, stationName: 'probe', identity: 'explicit' });
      const text = JSON.stringify(accessOf(client)!.snapshot());
      expect(text).not.toContain('9999');
      expect(text.toLowerCase()).not.toContain('6f1c2a3b');
      await client.disconnect();
      expect(snapshot(client)).toMatchObject({ registered: false, identity: null });
    } finally { server.close(); }
  });

  it('the option\'s identity is recorded as option, the anonymous default as default', async () => {
    const { server, port } = await startRw8();
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    try {
      const named = rw8(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION }));
      await named.requestWriteAccess();
      expect(snapshot(named)).toMatchObject({ registered: true, stationName: STATION.name, identity: 'option' });
      await named.releaseWriteAccess();
      await named.disconnect();

      const anonymous = rw8(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p'));
      await anonymous.requestWriteAccess();
      expect(snapshot(anonymous)).toMatchObject({ registered: true, stationName: 'abb-rws-client', identity: 'default' });
      await anonymous.releaseWriteAccess();
      await anonymous.disconnect();
    } finally { server.close(); }
  });

  it('setAllowMotionControl is reflected in allowMotionControl and logged at info level, naming the station', async () => {
    const { server, port, requests } = await startRw8();
    const info = vi.spyOn(Logger, 'info').mockImplementation(() => {});
    try {
      const client = rw8(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { controlStation: STATION }));
      expect(snapshot(client).allowMotionControl).toBeNull();
      await client.setAllowMotionControl(true);
      expect(snapshot(client).allowMotionControl).toBe(true);
      expect(requests.at(-1)).toMatchObject({ method: 'POST', url: '/rw/controlstation/allowmotioncontrol', body: 'allow-motion-control=true' });
      await client.setAllowMotionControl(false);
      expect(snapshot(client).allowMotionControl).toBe(false);
      const lines = info.mock.calls.map(c => String(c[0])).filter(l => l.includes('allow-motion-control'));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(`set to true for control station '${STATION.name}'`);
      expect(lines[1]).toContain('set to false');
      await client.disconnect();
    } finally { server.close(); }
  });
});

// ─── ConnectOptions ──────────────────────────────────────────────────────────

describe('createAdapter / createClient check the identity before anything is sent', () => {
  it('a malformed identity rejects with INVALID_ARGUMENT and no request reaches the host', async () => {
    const { createAdapter, createClient } = await import('../src/detect.js');
    const { server, port, requests } = await startRw8();
    try {
      for (const create of [createAdapter, createClient]) {
        const err = await create({
          host: '127.0.0.1', port, https: false,
          controlStation: { ...STATION, id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b' },
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RwsError);
        expect((err as RwsError).code).toBe('INVALID_ARGUMENT');
        expect((err as RwsError).message).toContain('ConnectOptions.controlStation.id');
      }
      expect(requests).toEqual([]);
    } finally { server.close(); }
  });
});

// ─── RobotManager ────────────────────────────────────────────────────────────

/** Connect `mgr` to `port` with the transport stubbed out, as the strictTls tests do. */
async function connectStubbed(mgr: RobotManager, port: number): Promise<void> {
  vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue({ port, useHttps: true, authType: 'basic' });
  vi.spyOn(RWS2Adapter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(RWS2Adapter.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(RWS2Adapter.prototype, 'getSessionCookie').mockReturnValue(null);
  vi.spyOn(RWS2Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);
  await mgr.connect('vc-omni', 'u', 'p', port);
}

describe('RobotManager control-station identity', () => {
  let mgr: RobotManager | null = null;
  afterEach(async () => { await mgr?.disconnect().catch(() => {}); mgr = null; });

  it('the constructor refuses a malformed identity with INVALID_ARGUMENT', () => {
    const e = invalid(() => new RobotManager({ controlStation: { ...STATION, id: 'Station001' } }));
    expect(e.message).toContain('RobotManagerOptions.controlStation.id');
  });

  it('without the option, the adapter gets no identity (the anonymous default)', async () => {
    mgr = new RobotManager();
    rws2CtorArgs.length = 0;
    await connectStubbed(mgr, 443);
    expect(rws2CtorArgs).toHaveLength(1);
    expect(rws2CtorArgs[0][3]).not.toHaveProperty('controlStation');
  });

  it('every adapter it builds registers as the same station, also after the port moves', async () => {
    mgr = new RobotManager({ controlStation: { ...STATION, releaseWriteAccessWhenLost: true } });
    rws2CtorArgs.length = 0;
    await connectStubbed(mgr, 5466);
    await mgr.disconnect();
    await connectStubbed(mgr, 9403);                 // a VC's port moves on every boot
    expect(rws2CtorArgs).toHaveLength(2);
    for (const args of rws2CtorArgs) {
      expect(args[3]).toMatchObject({ controlStation: { ...STATION, releaseWriteAccessWhenLost: true } });
    }
  });

  it('the identity reaches the registration body of the manager\'s own writes', async () => {
    mgr = new RobotManager({ controlStation: STATION });
    await connectStubbed(mgr, 443);
    const adapter = (mgr as unknown as { adapter: Record<string, unknown> }).adapter;
    const bodies: Array<Record<string, string> | undefined> = [];
    adapter.writeAccessMode = 'controlstation';
    adapter.req = async (_method: string, path: string, body?: Record<string, string>) => {
      if (path === REGISTER) { bodies.push(body); }
      return '';
    };
    await mgr.setSpeedRatio(50);
    expect(bodies).toEqual([{ 'control-station-name': STATION.name, 'control-station-id': ID, pincode: '4711' }]);
  });

  it('setControlStation takes effect at the next connect, and a malformed value changes nothing', async () => {
    mgr = new RobotManager({ controlStation: STATION });
    rws2CtorArgs.length = 0;
    await connectStubbed(mgr, 443);
    const other = { name: 'RAPID Live on dev-pc', id: '{00000000-1111-4222-8333-444444444444}', pincode: '1' };

    invalid(() => mgr!.setControlStation({ ...other, id: '00000000-1111-4222-8333-444444444444' }));
    await mgr.disconnect();
    await connectStubbed(mgr, 443);                  // same target: the adapter is reused
    expect(rws2CtorArgs).toHaveLength(1);

    mgr.setControlStation(other);
    await mgr.disconnect();
    await connectStubbed(mgr, 443);                  // same target, new identity: a new adapter
    expect(rws2CtorArgs).toHaveLength(2);
    expect(rws2CtorArgs[1][3]).toMatchObject({ controlStation: { ...other, releaseWriteAccessWhenLost: false } });

    mgr.setControlStation(null);                     // back to anonymous
    await mgr.disconnect();
    await connectStubbed(mgr, 443);
    expect(rws2CtorArgs).toHaveLength(3);
    expect(rws2CtorArgs[2][3]).not.toHaveProperty('controlStation');
  });
});

// ─── MultiRobotManager ───────────────────────────────────────────────────────

describe('MultiRobotManager control-station identity', () => {
  const stationOf = (m: RobotManager | null | undefined): unknown =>
    (m as unknown as { controlStation: unknown } | null)?.controlStation;
  const OWN = { name: 'Cell B station', id: '{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}', pincode: '77' };

  it('a robot\'s own identity overrides the shared one from the options', () => {
    const multi = MultiRobotManager.fromConfigs([
      { id: 'a', name: 'A', host: 'h', username: 'u', password: 'p' },
      { id: 'b', name: 'B', host: 'h', username: 'u', password: 'p', controlStation: OWN },
    ], { controlStation: STATION });
    expect(stationOf(multi.entries[0].manager)).toEqual({ ...STATION, releaseWriteAccessWhenLost: false });
    expect(stationOf(multi.entries[1].manager)).toEqual({ ...OWN, releaseWriteAccessWhenLost: false });
  });

  it('refuses a malformed identity in the options, in addRobot and in updateConfig, changing nothing', () => {
    invalid(() => new MultiRobotManager({ controlStation: { ...STATION, pincode: 'abcd' } }));

    const multi = new MultiRobotManager();
    const e = invalid(() => multi.addRobot({ id: 'x', name: 'X', host: 'h', username: 'u', password: 'p',
      controlStation: { ...OWN, id: 'not-a-guid' } }));
    expect(e.message).toContain('RobotConfig.controlStation.id');
    expect(multi.entries).toEqual([]);
    expect(multi.activeId).toBeNull();

    multi.addRobot({ id: 'x', name: 'X', host: 'h', username: 'u', password: 'p', controlStation: OWN });
    invalid(() => multi.updateConfig('x', { controlStation: { ...OWN, name: '' } }));
    expect(multi.configs[0].controlStation).toEqual(OWN);
    expect(stationOf(multi.active)).toEqual({ ...OWN, releaseWriteAccessWhenLost: false });
  });

  it('updateConfig hands a new identity to the robot\'s manager; removing it falls back to the shared one', () => {
    const multi = MultiRobotManager.fromConfigs(
      [{ id: 'x', name: 'X', host: 'h', username: 'u', password: 'p' }], { controlStation: STATION });
    multi.updateConfig('x', { controlStation: OWN });
    expect(stationOf(multi.active)).toEqual({ ...OWN, releaseWriteAccessWhenLost: false });
    expect(multi.configs[0].controlStation).toEqual(OWN);
    multi.updateConfig('x', { controlStation: undefined });
    expect(stationOf(multi.active)).toEqual({ ...STATION, releaseWriteAccessWhenLost: false });
  });
});
