import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'node:https';
import { RobotManager } from '../src/RobotManager.js';
import { RwsError } from '../src/types.js';
import { MultiRobotManager } from '../src/MultiRobotManager.js';
import * as MdnsDiscovery from '../src/MdnsDiscovery.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsClient } from '../src/RwsClient.js';
import { Logger } from '../src/Logger.js';

// Re-export the real fs through a plain (spyable) module object - the builtin
// namespace is frozen under vitest, so vi.spyOn(fs, ...) needs this indirection.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual };
});

// Same indirection for the mDNS module, so the delegation test can spy on it
// without sending real multicast queries.
vi.mock('../src/MdnsDiscovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/MdnsDiscovery.js')>();
  return { ...actual };
});

// Wrap RWS2Adapter so tests can observe the constructor arguments RobotManager
// passes (notably the TLS options). The wrapper extends the real class, so
// instanceof checks keep working everywhere.
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

const SESSION_FILE = path.join(os.homedir(), '.abb-rws-session');

/** Minimal in-memory adapter covering everything fetchAll + connect touch. */
function makeFakeAdapter() {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getSessionCookie: vi.fn((): string | null => null),
    subscribe: vi.fn(async (): Promise<() => Promise<void>> => { throw new Error('no ws'); }),
    getRapidExecutionInfo: vi.fn(async () => ({ state: 'stopped', cycle: 'forever' })),
    getControllerState: vi.fn(async () => 'motoron'),
    getOperationMode: vi.fn(async () => 'AUTO'),
    getSpeedRatio: vi.fn(async () => 100),
    getRapidTasks: vi.fn(async () => [
      { name: 'T_ROB1', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
    ]),
    listModules: vi.fn(async (..._args: any[]) => ['MainModule']),
    getJointPositions: vi.fn(async () => ({ rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 0, rax_6: 0 })),
    getCartesianFull: vi.fn(async () => ({ x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 })),
    getCollisionDetectionState: vi.fn(async () => 'On'),
    getControllerIdentity: vi.fn(async () => ({ name: 'vc' })),
    getSystemInfo: vi.fn(async () => ({ name: 'vc' })),
    getEventLog: vi.fn(async () => []),
    listMechunits: vi.fn(async () => ['ROB_1']),
    listAllSignals: vi.fn(async (): Promise<any[]> => []),
    releaseMastership: vi.fn(async () => {}),
  };
}

const DIGEST_PROBE = { port: 80, useHttps: false, authType: 'digest' as const };

// Self-signed localhost certificate for TLS-verification tests (CN=localhost,
// SAN 127.0.0.1, valid until 2046). Exactly what a controller's own cert looks
// like to a client: valid TLS, untrusted issuer.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUf1Ikd59HsHwQdokNWXSUz+3uAF8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcwODIxMTM1N1oXDTQ2MDcw
MzIxMTM1N1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApI16tgi0MRvVnVIuZT8F0okins0R+ZeYc8H4DnIJRVVr
4gfGkthYQgn6B55Dslq9uX/p9zry7oTrd+cIFIqbebOweeMwB+DdWwRGx954OS52
Pu7Xk0md0ilJPFxYFfksNekzgd+5lFhID4W0v5lXuV/hMH4f3DNyPyxgdllD1hRM
TL3w45QusOAAEmb+XR16IS9N9YZUNb5KB4Jzu3ftfFLPUkrSz4+IHV+6trKKEIKp
ShkSqdWeZwBYcuvCmuECn+0dnCgBH599GRn8qHcJIekoW7cQP+gJnY6GJVG2TSqs
67Je6FUkUHANwUveqllchOU4QjNJ7wlu2bTxWy4W6wIDAQABo28wbTAdBgNVHQ4E
FgQU4MPmJ9Nb9RzyOH/VDx2yvxl63cAwHwYDVR0jBBgwFoAU4MPmJ9Nb9RzyOH/V
Dx2yvxl63cAwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBACH4sbzJxc4RCbCoSFpB6zGX7Exe8nRz
YgDOTmDcYrDy1roagmTvi+FRY9q8oyWdjBXTD5njlKla6W0e+htb5UCaVcXx114y
ABPT9PGqmJvmvVKe5GuMltjP1pikiTgc1GpEp6TCMfliaadyn9jkmZMXGsH/cUTg
WXmuWDWzKGgEgiGvgYJvTRB2VcJ255vqVhkzNIRQTW+YEtCkloagkAC1d2FpuiZe
UUpkbyxIX7hFiTYXZCjIK0DXxXEDoJ7Cupis1mPG+zGXqz1bdVgwJPfIbdg7o1DL
+5bBCd/dVBda3sc52jyelTkGXr81BtQDku72kGsrBz1VZHqV3gnSunA=
-----END CERTIFICATE-----`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCkjXq2CLQxG9Wd
Ui5lPwXSiSKezRH5l5hzwfgOcglFVWviB8aS2FhCCfoHnkOyWr25f+n3OvLuhOt3
5wgUipt5s7B54zAH4N1bBEbH3ng5LnY+7teTSZ3SKUk8XFgV+Sw16TOB37mUWEgP
hbS/mVe5X+Ewfh/cM3I/LGB2WUPWFExMvfDjlC6w4AASZv5dHXohL031hlQ1vkoH
gnO7d+18Us9SStLPj4gdX7q2sooQgqlKGRKp1Z5nAFhy68Ka4QKf7R2cKAEfn30Z
Gfyodwkh6ShbtxA/6AmdjoYlUbZNKqzrsl7oVSRQcA3BS96qWVyE5ThCM0nvCW7Z
tPFbLhbrAgMBAAECggEAK02aCdZviO7gv6ZVVEqJ/zYceLrRrKOiuG/GlhKXcvoA
SnquXI13aGWUuTWCbiin/e12Bhwquu8awjJ3s2QodxX87o6FYMVhqyaMc+ONMssR
zgzviTCZyikYPzyz55BrfIJyjg5wmWPEDuWqQ7OYXM2pBqhiPQIC4jIM7ogeLHM9
hStEsOYo9pYOkI1o33cg6f8L8/Pf4eDCz0Ltbuhuwa6CML7RiZFreVSwblM7Ivy5
/2TB/Ss5zBsMl0HTz3bLaxoAotDqSWl5QtKwdu1xbqIpPMGOutqNyZouVGkkKG7T
OzEMgkQMsMJX4i39DiKzylTUwOiqxsgljJc2BkulPQKBgQDhO3VT1Ei/K/gORVY0
bJXkUCWespyKoFoctjL2WVeTWwmhPdtV5utBe/iE40FqO7a9yMsLmOdX8dig+tqq
kXzny8BW+MA2pTo+ZyJBumxFQT9KaekTRndJvwSkY1lk2JFlu0E2MxEgVQBm/iVC
R3aJggsLW0DSNYgPbeGrO4uOFQKBgQC7CAJxSJQLiz5zZDIsVQka0hmH6TkwMY0a
/izqicDad0zv9KPw5A5AR/fVvFmsCmJLDS/f5R3hDl97K3e2zKZFmECj+zCOcDdi
ECTC6fntW1v6JgrTKUq9iVoI2NCQ5z5UNtfG9zy2kXmDSw+GjpMGtfufybimLawl
pXs6OfFQ/wKBgELVeOhKKtgHfREHBCCERCo+mhswVwFPuc2hRxgQxMrmDcJ573bb
Ed4ZolIUeVnDpGNGjPHBCozvJ+AE8BQDHfROYqGsKKVOfCz+P40Pe4dFaDl1mgLt
OwJ4GzGIhYNGPEbavOwPVTqp3nexXG8Bc6w0GYDiMCbwWZJyga9k+PFNAoGAJVtK
MZpPh6a+SIoAw34QnXzNgKoCtC+RgYy3J/lvvbMKePsiK6FBf3FgfR5rwsMoMtll
cJDw0NzwEUfzV1208D2i2532atzbEwkqbowRUWloC6TBkL+0n/rpMs8riWXGu0dg
/eqwA782yBSb+0JK95ItuhKugPKqabKN1GlyW70CgYBEzvasYbSMk1zDhiJOIgj0
vun42/0faIerq34FATQvXZ0+9nsnKYsrCWOIiXgxMMx2kHojAK7Cv0APK4/8DWl3
wEn3NeFF5ZAiUB9iyl2Qx9/nKFyT/z1l3Nl1cjnasY2Zq9DSlFYQOsOFPaQTn0/a
4BEtSKH7MRrsLWHewEH0dA==
-----END PRIVATE KEY-----`;

describe('RobotManager connect lifecycle', () => {
  let mgr: RobotManager | null = null;

  afterEach(async () => {
    await mgr?.disconnect().catch(() => {});
    mgr = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('disconnect() during an in-flight connect leaves no ghost timer or subscription', async () => {
    mgr = new RobotManager();
    const fake = makeFakeAdapter();
    let releaseConnect!: () => void;
    fake.connect = vi.fn(() => new Promise<void>(r => { releaseConnect = r; }));
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    const pending = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalled());
    await mgr.disconnect();
    releaseConnect();
    await pending;

    expect((mgr as any).timer).toBeNull();
    expect((mgr as any).unsubscribeFn).toBeNull();
    expect(fake.subscribe).not.toHaveBeenCalled();
    expect(mgr.state.connected).toBe(false);
  });

  it('repeat connect() with identical args coalesces onto the in-flight promise', async () => {
    mgr = new RobotManager();
    const fake = makeFakeAdapter();
    let releaseConnect!: () => void;
    fake.connect = vi.fn(() => new Promise<void>(r => { releaseConnect = r; }));
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    const p1 = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalled());
    const p2 = mgr.connect('vc-a', 'u', 'p', 80);
    expect(p2).toBe(p1);
    releaseConnect();
    await p1;
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('connect() after disconnect() starts fresh instead of coalescing onto the cancelled attempt', async () => {
    mgr = new RobotManager();
    const fake = makeFakeAdapter();
    let releaseFirst!: () => void;
    fake.connect = vi.fn((): Promise<void> => {
      if (fake.connect.mock.calls.length === 1) {
        return new Promise<void>(r => { releaseFirst = r; });
      }
      return Promise.resolve();
    });
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    const p1 = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalled());
    await mgr.disconnect();

    // Same args, but the in-flight attempt was cancelled by the disconnect -
    // coalescing onto it would resolve with the manager still disconnected.
    const p2 = mgr.connect('vc-a', 'u', 'p', 80);
    expect(p2).not.toBe(p1);
    releaseFirst();
    await p1;
    await p2;

    expect(mgr.state.connected).toBe(true);
    expect(mgr.state.host).toBe('vc-a');
    expect(fake.connect).toHaveBeenCalledTimes(2);
  });

  it('disconnect() during a superseding connect cancels it for good (no resurrection)', async () => {
    mgr = new RobotManager();
    const fake = makeFakeAdapter();
    let releaseFirst!: () => void;
    fake.connect = vi.fn((): Promise<void> => {
      if (fake.connect.mock.calls.length === 1) {
        return new Promise<void>(r => { releaseFirst = r; });
      }
      return Promise.resolve();
    });
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    const p1 = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalled());
    await mgr.disconnect();

    // Superseding attempt parks on the old promise's unwind…
    const p2 = mgr.connect('vc-a', 'u', 'p', 80);
    // …and the user disconnects again before it gets going. doConnect re-reads
    // the epoch at entry (needed for its own internal teardowns), which used to
    // erase this cancellation and connect anyway.
    await mgr.disconnect();

    releaseFirst();
    await p1;
    await p2;

    expect(mgr.state.connected).toBe(false);
    expect((mgr as any).timer).toBeNull();
    expect((mgr as any).unsubscribeFn).toBeNull();
  });

  it('connect() with different args supersedes the in-flight attempt', async () => {
    mgr = new RobotManager();
    const fake = makeFakeAdapter();
    let releaseConnect!: () => void;
    fake.connect = vi.fn(() => new Promise<void>(r => { releaseConnect = r; }));
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);
    vi.spyOn(RWS1Adapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(RWS1Adapter.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(RWS1Adapter.prototype, 'getSessionCookie').mockReturnValue(null);
    vi.spyOn(RWS1Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
    vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);

    const p1 = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalled());
    const p2 = mgr.connect('vc-b', 'u', 'p', 80);
    expect(p2).not.toBe(p1);
    releaseConnect();
    await p1;
    await p2;

    expect(mgr.state.connected).toBe(true);
    expect(mgr.state.host).toBe('vc-b');
    expect(fake.disconnect).toHaveBeenCalled();
  });

  it('connect() while connected with a different password reconnects instead of no-op', async () => {
    mgr = new RobotManager();
    const fake = makeFakeAdapter();
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);
    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(mgr.state.connected).toBe(true);

    vi.spyOn(RWS1Adapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(RWS1Adapter.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(RWS1Adapter.prototype, 'getSessionCookie').mockReturnValue(null);
    vi.spyOn(RWS1Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
    vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);

    await mgr.connect('vc-a', 'u', 'p2', 80);
    expect((mgr as any).adapterConfig.password).toBe('p2');
    expect(fake.disconnect).toHaveBeenCalled();
  });
});

describe('RobotManager polling vs disconnect', () => {
  let mgr: RobotManager | null = null;

  afterEach(async () => {
    await mgr?.disconnect().catch(() => {});
    mgr = null;
    vi.restoreAllMocks();
  });

  it('a poll resolving after disconnect() does not resurrect stale state', async () => {
    mgr = new RobotManager();
    const fake = makeFakeAdapter();
    let releaseModules!: (m: string[]) => void;
    fake.listModules = vi.fn(() => new Promise<string[]>(r => { releaseModules = r; }));
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    // connect() runs the first poll; hold it open on the module list…
    const pending = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.waitFor(() => expect(fake.listModules).toHaveBeenCalled());
    // …disconnect (clears _state, bumps the generation)…
    await mgr.disconnect();
    // …then let the stale poll finish.
    releaseModules(['MainModule']);
    await pending;

    expect(mgr.state.connected).toBe(false);
    expect(mgr.state.tasks).toEqual([]);
    expect(mgr.state.modules).toEqual([]);
    expect(mgr.state.ctrlstate).toBeNull();
    expect(mgr.state.ioSignals).toEqual([]);
  });
});

describe('RobotManager: a poll never overwrites a newer subscription event', () => {
  // Live 2026-09-24 (RW6.16 VC, via the daemon stream): speed 50 was reported,
  // then 100 again 0.3 s later - a slow poll that had read 100 before the change
  // wrote it back after the speedratio event for 50 had arrived.
  let mgr: RobotManager | null = null;
  afterEach(async () => { await mgr?.disconnect().catch(() => {}); mgr = null; vi.restoreAllMocks(); });

  /** A manager with live subscriptions whose first poll is held open on listModules. */
  async function heldPoll(reads: { speed: number; ctrl: string }) {
    mgr = new RobotManager();
    const fake = makeFakeAdapter();
    let emit!: (e: { resource: string; value: string; timestamp: Date }) => void;
    fake.subscribe = vi.fn(async (_r: unknown, handler: typeof emit) => { emit = handler; return async () => {}; }) as never;
    fake.getSpeedRatio = vi.fn(async () => reads.speed);
    fake.getControllerState = vi.fn(async () => reads.ctrl);
    let releaseModules!: (m: string[]) => void;
    fake.listModules = vi.fn(() => new Promise<string[]>(r => { releaseModules = r; }));
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);
    const connected = mgr.connect('vc-a', 'u', 'p', 80);
    await vi.waitFor(() => expect(fake.listModules).toHaveBeenCalled());   // poll has read its values, still in flight
    return { fake, emit, release: () => releaseModules(['MainModule']), connected };
  }

  it('keeps an event that arrived while the poll was in flight', async () => {
    const { emit, release, connected } = await heldPoll({ speed: 100, ctrl: 'motoroff' });
    emit({ resource: 'speedratio', value: '50', timestamp: new Date() });
    emit({ resource: 'controllerstate', value: 'motoron', timestamp: new Date() });
    release();
    await connected;
    expect(mgr!.state.speedRatio).toBe(50);
    expect(mgr!.state.ctrlstate).toBe('motoron');
  });

  it('keeps its own speed write when a poll that read the old value finishes later', async () => {
    const { fake, release, connected } = await heldPoll({ speed: 100, ctrl: 'motoroff' });
    (fake as any).setSpeedRatio = vi.fn(async () => {});
    await mgr!.setSpeedRatio(30);
    release();
    await connected;
    expect(mgr!.state.speedRatio).toBe(30);
  });

  it('still lets a poll that started after an event replace its value', async () => {
    const { fake, emit, release, connected } = await heldPoll({ speed: 100, ctrl: 'motoroff' });
    release();
    await connected;
    emit({ resource: 'speedratio', value: '50', timestamp: new Date() });
    // The controller moves on again with no event this time; the next poll reads it.
    fake.getSpeedRatio = vi.fn(async () => 60);
    fake.listModules = vi.fn(async () => ['MainModule']);
    await (mgr as any).fetchAll((mgr as any).pollGeneration);
    expect(mgr!.state.speedRatio).toBe(60);
  });
});

describe('RobotManager.resetRapid', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('says the task has no main routine when the controller answers 404', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter() as any;
    fake.requestMastership = vi.fn(async () => {});
    fake.releaseMastership = vi.fn(async () => {});
    fake.resetRapid = vi.fn(async () => {
      throw new RwsError('Resource does not exist on the controller: HTTP 404 from POST /rw/rapid/execution/resetpp', 'RESOURCE_NOT_FOUND', 404);
    });
    (mgr as any).adapter = fake;
    await expect(mgr.resetRapid()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', message: expect.stringMatching(/no main routine/) });
  });
});

describe('RobotManager simulation panel wrappers', () => {
  it('delegates to the RWS 2.0 adapter', async () => {
    const mgr = new RobotManager();
    const calls: Array<[string, unknown[]]> = [];
    const fake = Object.create(RWS2Adapter.prototype);
    for (const m of ['simEmergencyStop', 'simResetEmergencyStop', 'simGeneralStop', 'simAutoStop']) {
      fake[m] = async () => { calls.push([m, []]); };
    }
    fake.simEnableSwitch = async (on: boolean) => { calls.push(['simEnableSwitch', [on]]); };
    fake.teleportMechunit = async (...a: unknown[]) => { calls.push(['teleportMechunit', a]); };
    (mgr as any).adapter = fake;

    await mgr.simEmergencyStop();
    await mgr.simResetEmergencyStop();
    await mgr.simGeneralStop();
    await mgr.simAutoStop();
    await mgr.simEnableSwitch(true);
    await mgr.teleportMechunit('ROB_1', [10, 0, 0, 0, 0, 0]);

    expect(calls.map(c => c[0])).toEqual([
      'simEmergencyStop', 'simResetEmergencyStop', 'simGeneralStop', 'simAutoStop',
      'simEnableSwitch', 'teleportMechunit',
    ]);
    expect(calls[4][1]).toEqual([true]);
    expect(calls[5][1]).toEqual(['ROB_1', [10, 0, 0, 0, 0, 0], undefined]);
  });

  it('rejects with a clear error on an RWS 1.0 connection', async () => {
    const mgr = new RobotManager();
    (mgr as any).adapter = makeFakeAdapter();
    await expect(mgr.simEmergencyStop()).rejects.toThrow(/OmniCore|RWS 2\.0/);
    await expect(mgr.teleportMechunit('ROB_1', [0, 0, 0, 0, 0, 0])).rejects.toThrow(/OmniCore|RWS 2\.0/);
  });
});

describe('RobotManager subscription loss fallback', () => {
  let mgr: RobotManager | null = null;

  afterEach(async () => {
    await mgr?.disconnect().catch(() => {});
    mgr = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resumes the fast polling cadence when the event stream is terminally lost', async () => {
    vi.useFakeTimers();
    mgr = new RobotManager({ refreshIntervalMs: 400 });
    const fake = makeFakeAdapter();
    let onLost: (() => void) | undefined;
    fake.subscribe = vi.fn(async (_resources: unknown, _handler: unknown, lost?: () => void) => {
      onLost = lost;
      return async () => {};
    }) as any;
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(typeof onLost).toBe('function');

    // Subscriptions active → slow cadence (5 × 400 ms), so 400 ms brings no poll.
    const before = fake.getControllerState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.getControllerState.mock.calls.length).toBe(before);

    onLost!();
    expect((mgr as any).subscriptionActive).toBe(false);

    const after = fake.getControllerState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.getControllerState.mock.calls.length).toBe(after + 1);
  });

  it('runs one immediate full poll when the event stream is restored', async () => {
    vi.useFakeTimers();
    mgr = new RobotManager({ refreshIntervalMs: 400 });
    const fake = makeFakeAdapter();
    let onRestored: (() => void) | undefined;
    fake.subscribe = vi.fn(async (
      _resources: unknown, _handler: unknown, _lost?: () => void, restored?: () => void,
    ) => {
      onRestored = restored;
      return async () => {};
    }) as any;
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(typeof onRestored).toBe('function');

    // Events may have been missed while the stream was down - a restore must
    // trigger one immediate full poll without waiting for the slow cadence.
    const before = fake.getControllerState.mock.calls.length;
    onRestored!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.getControllerState.mock.calls.length).toBe(before + 1);

    // The subscription itself stayed up - cadence must remain slow (5 × 400 ms).
    expect((mgr as any).subscriptionActive).toBe(true);
  });
});

describe('RobotManager connection quality', () => {
  let mgr: RobotManager | null = null;

  afterEach(async () => {
    await mgr?.disconnect().catch(() => {});
    mgr = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(subscribeBehavior: 'ok' | 'fail' = 'ok') {
    mgr = new RobotManager({ refreshIntervalMs: 400 });
    const fake = makeFakeAdapter();
    const callbacks: { onLost?: () => void; onRestored?: () => void } = {};
    if (subscribeBehavior === 'ok') {
      fake.subscribe = vi.fn(async (
        _r: unknown, _h: unknown, lost?: () => void, restored?: () => void,
      ) => {
        callbacks.onLost = lost;
        callbacks.onRestored = restored;
        return async () => {};
      }) as any;
    }
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);
    return { fake, callbacks };
  }

  it('starts disconnected before any connect', () => {
    mgr = new RobotManager();
    expect(mgr.state.quality).toBe('disconnected');
    expect(mgr.state.qualityReason.length).toBeGreaterThan(0);
  });

  it('is live when subscriptions are active, with a human-readable reason', async () => {
    setup('ok');
    await mgr!.connect('vc-a', 'u', 'p', 80);
    expect(mgr!.state.quality).toBe('live');
    expect(mgr!.state.qualityReason.length).toBeGreaterThan(0);
  });

  it('passes through reconnecting while a connect attempt is in flight', async () => {
    setup('ok');
    const seen: string[] = [];
    mgr!.onDidChange(() => { seen.push(mgr!.state.quality); });
    await mgr!.connect('vc-a', 'u', 'p', 80);
    expect(seen).toContain('reconnecting');
    expect(seen[seen.length - 1]).toBe('live');
  });

  it('is polling when subscriptions are unavailable', async () => {
    setup('fail');   // default fake adapter subscribe throws
    await mgr!.connect('vc-a', 'u', 'p', 80);
    expect(mgr!.state.quality).toBe('polling');
  });

  it('drops from live to polling when the stream is terminally lost', async () => {
    const { callbacks } = setup('ok');
    await mgr!.connect('vc-a', 'u', 'p', 80);
    expect(mgr!.state.quality).toBe('live');
    callbacks.onLost!();
    expect(mgr!.state.quality).toBe('polling');
  });

  it('stays live across a restore, notifies, and triggers a resync poll', async () => {
    const { fake, callbacks } = setup('ok');
    await mgr!.connect('vc-a', 'u', 'p', 80);
    let notified = 0;
    mgr!.onDidChange(() => { notified++; });
    const pollsBefore = fake.getControllerState.mock.calls.length;

    callbacks.onRestored!();
    await new Promise(r => setTimeout(r, 0));

    expect(mgr!.state.quality).toBe('live');
    expect(notified).toBeGreaterThan(0);                                  // reason change notified
    expect(fake.getControllerState.mock.calls.length).toBe(pollsBefore + 1); // immediate resync ran
  });

  it('survives a throwing onDidChange consumer without counting it as a poll failure', async () => {
    vi.useFakeTimers();
    const { fake } = setup('fail');   // polling cadence 400 ms
    await mgr!.connect('vc-a', 'u', 'p', 80);
    mgr!.onDidChange(() => { throw new Error('consumer bug'); });

    await vi.advanceTimersByTimeAsync(3 * 400 + 100);
    // Three poll cycles with a throwing consumer: still connected, not stale
    expect(mgr!.state.connected).toBe(true);
    expect(mgr!.state.quality).toBe('polling');
    expect(fake.getControllerState.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('degrades to stale on consecutive poll failures and recovers on success', async () => {
    vi.useFakeTimers();
    const { fake } = setup('ok');
    await mgr!.connect('vc-a', 'u', 'p', 80);
    expect(mgr!.state.quality).toBe('live');

    // Live cadence is 5 × 400 ms = 2000 ms: one failing poll → stale
    // (not disconnected until the third consecutive failure)
    fake.getControllerState.mockRejectedValue(new Error('controller busy'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(mgr!.state.quality).toBe('stale');
    expect(mgr!.state.qualityReason).toContain('poll');

    // A successful poll heals back to the subscription-appropriate quality
    fake.getControllerState.mockResolvedValue('motoron');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mgr!.state.quality).toBe('live');
  });

  it('is disconnected with a reason after three failed polls', async () => {
    vi.useFakeTimers();
    const { fake } = setup('fail');   // polling cadence: 400 ms
    await mgr!.connect('vc-a', 'u', 'p', 80);
    expect(mgr!.state.quality).toBe('polling');

    fake.getControllerState.mockRejectedValue(new Error('gone'));
    await vi.advanceTimersByTimeAsync(3 * 400 + 100);
    expect(mgr!.state.quality).toBe('disconnected');
    expect(mgr!.state.qualityReason).toContain('3');
  });

  it('is disconnected after a user disconnect', async () => {
    setup('ok');
    await mgr!.connect('vc-a', 'u', 'p', 80);
    await mgr!.disconnect();
    expect(mgr!.state.quality).toBe('disconnected');
  });
});

describe('MultiRobotManager per-robot notifications', () => {
  it('reports WHICH robot changed without breaking zero-arg handlers', async () => {
    const multi = new MultiRobotManager();
    const ids: string[] = [];
    let zeroArg = 0;
    multi.onDidChange(() => { zeroArg++; });
    multi.onRobotChanged(id => { ids.push(id); });

    multi.addRobot({ id: 'a', name: 'A', host: 'vc-a' } as any);
    multi.addRobot({ id: 'b', name: 'B', host: 'vc-b' } as any);
    expect(ids).toEqual(['a', 'b']);

    // A state change inside robot b's manager surfaces b's id
    const before = ids.length;
    const mgrB = (multi as any).managers.get('b') as RobotManager;
    (mgrB as any).notify();
    expect(ids.slice(before)).toEqual(['b']);
    expect(zeroArg).toBeGreaterThan(0);

    multi.removeRobot('a');
    expect(ids[ids.length - 1]).toBe('a');
  });
});

describe('RobotManager.currentUseHttps', () => {
  it('survives class-name mangling (minified bundles rename classes)', () => {
    const mgr = new RobotManager();
    (mgr as any).adapter = new RWS2Adapter('https://127.0.0.1:1', 'u', 'p');
    (mgr as any).adapterConfig = { host: '127.0.0.1', username: 'u', password: 'p', port: 1 };
    const desc = Object.getOwnPropertyDescriptor(RWS2Adapter, 'name')!;
    Object.defineProperty(RWS2Adapter, 'name', { ...desc, value: 'e' });
    try {
      expect(mgr.currentUseHttps).toBe(true);
    } finally {
      Object.defineProperty(RWS2Adapter, 'name', desc);
    }
  });

  it('reports false for an RWS 1.0 adapter', () => {
    const mgr = new RobotManager();
    const client = new RwsClient({ host: '127.0.0.1', port: 1, username: 'u', password: 'p' });
    (mgr as any).adapter = new RWS1Adapter(client, { host: '127.0.0.1', port: 1, username: 'u', password: 'p' });
    (mgr as any).adapterConfig = { host: '127.0.0.1', username: 'u', password: 'p', port: 1 };
    expect(mgr.currentUseHttps).toBe(false);
  });
});

describe('RobotManager polling task selection', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('refresh() is a no-op after disconnect - does not touch the torn-down adapter', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter();
    (mgr as any).adapter = fake;      // adapter is left non-null by disconnectInternal
    (mgr as any)._state.connected = false;  // ...but state is disconnected
    await mgr.refresh();
    // No fetch should reach the dead adapter, so state can't be resurrected and
    // the auto-disconnect failure counter can't be re-tripped.
    expect(fake.getRapidTasks).not.toHaveBeenCalled();
    expect(fake.getControllerState).not.toHaveBeenCalled();
  });

  it('polls the module list of the active task, not hardcoded T_ROB1', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter();
    fake.getRapidTasks = vi.fn(async () => [
      { name: 'T_MULTI', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
    ]);
    (mgr as any).adapter = fake;
    (mgr as any)._state.connected = true; // refresh() is a no-op unless connected
    await mgr.refresh();
    expect(fake.listModules).toHaveBeenCalledWith('T_MULTI');
  });

  it('falls back to the first task when none is flagged active', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter();
    fake.getRapidTasks = vi.fn(async () => [
      { name: 'T_LEFT', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: false, motiontask: true },
      { name: 'T_RIGHT', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: false, motiontask: true },
    ]);
    (mgr as any).adapter = fake;
    (mgr as any)._state.connected = true; // refresh() is a no-op unless connected
    await mgr.refresh();
    expect(fake.listModules).toHaveBeenCalledWith('T_LEFT');
  });

  it('MultiMove: lists the modules of EVERY active task, keeping modules as the primary list', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter();
    fake.getRapidTasks = vi.fn(async () => [
      { name: 'T_ROB1', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
      { name: 'T_ROB2', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
      { name: 'T_BG',   type: 'static', taskstate: 'linked', excstate: 'stopped', active: false, motiontask: false },
    ]);
    const perTask: Record<string, string[]> = { T_ROB1: ['MainModule', 'CellA'], T_ROB2: ['MainModule', 'CellB', 'Gripper2'] };
    fake.listModules = vi.fn(async (task: string) => perTask[task] ?? []);
    (mgr as any).adapter = fake;
    (mgr as any)._state.connected = true;
    await mgr.refresh();

    expect(fake.listModules).toHaveBeenCalledWith('T_ROB1');
    expect(fake.listModules).toHaveBeenCalledWith('T_ROB2');
    expect(fake.listModules).not.toHaveBeenCalledWith('T_BG'); // inactive tasks are not listed
    expect(mgr.state.modules).toEqual(['MainModule', 'CellA']);
    expect(mgr.state.modulesByTask).toEqual({
      T_ROB1: ['MainModule', 'CellA'],
      T_ROB2: ['MainModule', 'CellB', 'Gripper2'],
    });
  });

  it('MultiMove: a secondary task failing to list degrades to empty without failing the poll', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter();
    fake.getRapidTasks = vi.fn(async () => [
      { name: 'T_ROB1', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
      { name: 'T_ROB2', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
    ]);
    fake.listModules = vi.fn(async (task: string) => {
      if (task === 'T_ROB2') { throw new Error('HTTP 503'); }
      return ['MainModule'];
    });
    (mgr as any).adapter = fake;
    (mgr as any)._state.connected = true;
    await mgr.refresh();

    expect(mgr.state.modules).toEqual(['MainModule']);
    expect(mgr.state.modulesByTask).toEqual({ T_ROB1: ['MainModule'], T_ROB2: [] });
    expect(mgr.state.connected).toBe(true);
  });
});

describe('RobotManager session-cookie persistence', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('replaces the shared file atomically (temp file + rename), keeping other entries', () => {
    const mgr = new RobotManager();
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ 'other:80': 'ABBCX=keep' }));
    const writes: Array<[string, string]> = [];
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => { writes.push([String(p), String(data)]); });
    const renames: Array<[string, string]> = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => { renames.push([String(a), String(b)]); });

    (mgr as any).saveSessionCookie('vc:80', 'ABBCX=new');

    expect(writes).toHaveLength(1);
    expect(writes[0][0]).not.toBe(SESSION_FILE);
    expect(JSON.parse(writes[0][1])).toEqual({ 'other:80': 'ABBCX=keep', 'vc:80': 'ABBCX=new' });
    expect(renames).toEqual([[writes[0][0], SESSION_FILE]]);
  });

  it('tolerates a concurrent writer winning the rename and cleans up its temp file', () => {
    const mgr = new RobotManager();
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EPERM'); });
    const unlinks: string[] = [];
    vi.spyOn(fs, 'unlinkSync').mockImplementation(p => { unlinks.push(String(p)); });

    expect(() => (mgr as any).saveSessionCookie('vc:80', 'ABBCX=x')).not.toThrow();
    expect(unlinks).toHaveLength(1);
    expect(unlinks[0]).not.toBe(SESSION_FILE);
  });
});

describe('RobotManager refreshIntervalMs option', () => {
  let mgr: RobotManager | null = null;

  afterEach(async () => {
    await mgr?.disconnect().catch(() => {});
    mgr = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('defaults to 1000 and clamps below 200', () => {
    expect((new RobotManager() as any).refreshIntervalMs).toBe(1000);
    expect((new RobotManager({ refreshIntervalMs: 500 }) as any).refreshIntervalMs).toBe(500);
    expect((new RobotManager({ refreshIntervalMs: 50 }) as any).refreshIntervalMs).toBe(200);
  });

  it('MultiRobotManager.fromConfigs passes refreshIntervalMs through to each manager', () => {
    const multi = MultiRobotManager.fromConfigs(
      [{ id: '1', name: 'r1', host: 'h', username: 'u', password: 'p' }],
      { refreshIntervalMs: 250 },
    );
    expect((multi.active as any).refreshIntervalMs).toBe(250);
    multi.addRobot({ id: '2', name: 'r2', host: 'h2', username: 'u', password: 'p' });
    expect((multi.entries[1].manager as any).refreshIntervalMs).toBe(250);
  });

  it('drives the fast-poll cadence when subscriptions are unavailable', async () => {
    vi.useFakeTimers();
    mgr = new RobotManager({ refreshIntervalMs: 400 });
    const fake = makeFakeAdapter();
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    await mgr.connect('vc-a', 'u', 'p', 80);
    const before = fake.getControllerState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.getControllerState.mock.calls.length).toBe(before + 1);
  });

  it('slow poll (subscriptions active) runs at 5× the interval', async () => {
    vi.useFakeTimers();
    mgr = new RobotManager({ refreshIntervalMs: 400 });
    const fake = makeFakeAdapter();
    fake.subscribe = vi.fn(async () => async () => {});
    (mgr as any).adapter = fake;
    (mgr as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);

    await mgr.connect('vc-a', 'u', 'p', 80);
    const before = fake.getControllerState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake.getControllerState.mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.getControllerState.mock.calls.length).toBe(before + 1);
  });
});

describe('RobotManager strictTls option', () => {
  let mgr: RobotManager | null = null;
  let tlsSrv: { server: https.Server; port: number };

  beforeAll(() => {
    const server = https.createServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, (_req, res) => {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm="ROBAPI"');
      res.end('Unauthorized');
    });
    server.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === 'string') { throw new Error('server has no port'); }
    tlsSrv = { server, port: addr.port };
  });

  afterAll(() => {
    tlsSrv.server.closeAllConnections();
    tlsSrv.server.close();
  });

  afterEach(async () => {
    await mgr?.disconnect().catch(() => {});
    mgr = null;
    vi.restoreAllMocks();
  });

  it('defaults to false (self-signed controller certs are the norm)', () => {
    expect((new RobotManager() as any).strictTls).toBe(false);
    expect((new RobotManager({ strictTls: true }) as any).strictTls).toBe(true);
  });

  it('MultiRobotManager forwards strictTls to every manager it creates', () => {
    const multi = MultiRobotManager.fromConfigs(
      [{ id: '1', name: 'r1', host: 'h', username: 'u', password: 'p' }],
      { strictTls: true },
    );
    expect((multi.active as any).strictTls).toBe(true);
    multi.addRobot({ id: '2', name: 'r2', host: 'h2', username: 'u', password: 'p' });
    expect((multi.entries[1].manager as any).strictTls).toBe(true);
  });

  it('probeSpecificPort accepts a self-signed certificate by default', async () => {
    const r = await RobotManager.probeSpecificPort('127.0.0.1', tlsSrv.port);
    expect(r).toEqual({ port: tlsSrv.port, useHttps: true, authType: 'basic' });
  });

  it('probeSpecificPort rejects a self-signed certificate under strictTls', async () => {
    const r = await RobotManager.probeSpecificPort('127.0.0.1', tlsSrv.port, true);
    expect(r).toBeNull();
  });

  it('constructs the RWS 2.0 adapter with certificate verification when strictTls is set', async () => {
    mgr = new RobotManager({ strictTls: true });
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue({ port: 443, useHttps: true, authType: 'basic' });
    vi.spyOn(RWS2Adapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'getSessionCookie').mockReturnValue(null);
    vi.spyOn(RWS2Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
    vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);

    rws2CtorArgs.length = 0;
    await mgr.connect('vc-omni', 'u', 'p', 443);
    expect(rws2CtorArgs).toHaveLength(1);
    expect(rws2CtorArgs[0][0]).toBe('https://vc-omni:443');
    expect(rws2CtorArgs[0][3]).toMatchObject({ rejectUnauthorized: true });
  });

  it('constructs the RWS 2.0 adapter with verification off by default', async () => {
    mgr = new RobotManager();
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue({ port: 443, useHttps: true, authType: 'basic' });
    vi.spyOn(RWS2Adapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'getSessionCookie').mockReturnValue(null);
    vi.spyOn(RWS2Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
    vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);

    rws2CtorArgs.length = 0;
    await mgr.connect('vc-omni', 'u', 'p', 443);
    expect(rws2CtorArgs).toHaveLength(1);
    expect(rws2CtorArgs[0][3]).toMatchObject({ rejectUnauthorized: false });
  });
});

describe('RobotManager.discoverControllersMdns', () => {
  it('delegates to the mDNS discovery module, passing timeoutMs through', async () => {
    const sample = [{
      instanceName: 'RobotWebServices_Omni1', systemName: 'Omni1',
      host: '127.0.0.1', port: 5466, probableProtocol: 'rws2' as const,
    }];
    const spy = vi.spyOn(MdnsDiscovery, 'discoverControllersMdns').mockResolvedValue(sample);
    try {
      const found = await RobotManager.discoverControllersMdns({ timeoutMs: 123 });
      expect(found).toEqual(sample);
      expect(spy).toHaveBeenCalledWith({ timeoutMs: 123 });

      await RobotManager.discoverControllersMdns();
      expect(spy).toHaveBeenLastCalledWith(undefined);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('RobotManager I/O refresh', () => {
  it('asks the adapter once and does not re-page over a complete list', async () => {
    // listAllSignals walks the controller's own pagination, so it returns every
    // signal in one call. RobotManager used to loop over it with a page size of
    // 100; once the adapter returned all 130, that loop fetched again from
    // offset 100 and appended 30 duplicates.
    const signals = Array.from({ length: 130 }, (_, i) => ({
      name: `sig${i}`, value: '0', type: 'DI' as const, lvalue: '0',
    }));
    const fake = makeFakeAdapter();
    fake.listAllSignals = vi.fn(async () => signals);

    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = fake;
    (mgr as unknown as { adapterConfig: unknown }).adapterConfig =
      { host: 'vc-a', username: 'u', password: 'p', port: 80 };

    await mgr.refreshIoSignals();

    expect(fake.listAllSignals).toHaveBeenCalledTimes(1);
    expect(mgr.state.ioSignals).toHaveLength(130);
    expect(new Set(mgr.state.ioSignals.map(s => s.name)).size).toBe(130);
    expect(mgr.state.ioSignalsLoaded).toBe(true);
  });
});

describe('RobotManager signal table across reconnects (ioSignalsLoaded)', () => {
  // Up to 1.4.x the table was reloaded when fetchCount === 1 or % 5 === 0, and
  // fetchCount survived a disconnect: after a reconnect the table read [] until
  // the next multiple of 5 polls - "no signals" for up to ~20 s on a live link.
  // Now it is walked at the first poll of every connection, then by the clock.
  let mgr: RobotManager | null = null;
  afterEach(async () => { await mgr?.disconnect().catch(() => {}); mgr = null; vi.restoreAllMocks(); vi.useRealTimers(); });

  const SIGNALS = [{ name: 'di_1', value: '0', type: 'DI' as const, lvalue: '0' }];

  function managerWith(fake: ReturnType<typeof makeFakeAdapter>): RobotManager {
    // A long cadence: only the polls the test runs itself happen.
    const m = new RobotManager({ refreshIntervalMs: 60000 });
    (m as any).adapter = fake;
    (m as any).adapterConfig = { host: 'vc-a', username: 'u', password: 'p', port: 80 };
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(DIGEST_PROBE);
    return m;
  }

  it('loads the table on the first poll of every connection', async () => {
    const fake = makeFakeAdapter();
    fake.listAllSignals = vi.fn(async () => SIGNALS) as never;
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(mgr.state.ioSignals).toEqual(SIGNALS);
    expect(mgr.state.ioSignalsLoaded).toBe(true);
    // Two more polls on this connection, inside the minute: no walk.
    await (mgr as any).fetchAll((mgr as any).pollGeneration);
    await (mgr as any).fetchAll((mgr as any).pollGeneration);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(1);

    await mgr.disconnect();
    expect(mgr.state.ioSignals).toEqual([]);
    expect(mgr.state.ioSignalsLoaded).toBe(false);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(2);
    expect(mgr.state.ioSignals).toEqual(SIGNALS);
    expect(mgr.state.ioSignalsLoaded).toBe(true);
  });

  it('a failed load leaves ioSignalsLoaded false and is logged, not swallowed', async () => {
    const fake = makeFakeAdapter();
    fake.listAllSignals = vi.fn(async () => { throw new RwsError('controller busy', 'CONTROLLER_BUSY'); }) as never;
    const warn = vi.spyOn(Logger, 'warn');
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(mgr.state.connected).toBe(true);
    expect(mgr.state.ioSignals).toEqual([]);
    expect(mgr.state.ioSignalsLoaded).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listAllSignals failed: controller busy'));
  });

  // The walk is timed by the clock (Date.now), so only Date is faked: the
  // clock stands still until the test moves it, and every poll is one the
  // test runs itself.
  const T0 = Date.parse('2026-10-25T08:00:00Z');
  function clockAt(seconds: number): void { vi.setSystemTime(T0 + seconds * 1000); }
  const poll = (m: RobotManager): Promise<void> => (m as any).fetchAll((m as any).pollGeneration);

  it('a failed walk is tried again after 5, 10, 20 and 40 s, then each minute, never on every poll', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clockAt(0);
    const fake = makeFakeAdapter();
    let failing = true;
    fake.listAllSignals = vi.fn(async () => {
      if (failing) { throw new RwsError('controller busy', 'CONTROLLER_BUSY'); }
      return SIGNALS;
    }) as never;
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(1);
    expect(mgr.state.ioSignalsLoaded).toBe(false);

    // [poll time in s, walks so far]: a poll inside the wait sends nothing.
    const steps: Array<[number, number]> = [
      [1, 1], [4.999, 1], [5, 2],            // 5 s after the first failure
      [10, 2], [14.999, 2], [15, 3],         // then 10 s
      [34.999, 3], [35, 4],                  // 20 s
      [74.999, 4], [75, 5],                  // 40 s
      [134.999, 5], [135, 6],                // 60 s, the cap
      [194.999, 6], [195, 7],                // and 60 s from then on
    ];
    for (const [at, walks] of steps) {
      clockAt(at);
      await poll(mgr);
      expect(fake.listAllSignals, `walks by ${at} s`).toHaveBeenCalledTimes(walks);
    }
    const waits = warn.mock.calls.map(c => /read again in (\d+) s$/.exec(String(c[0]))?.[1]);
    expect(waits).toEqual(['5', '10', '20', '40', '60', '60', '60']);
    expect(String(warn.mock.calls[0][0])).toMatch(/^listAllSignals failed: controller busy; /);
    expect(mgr.state.ioSignalsLoaded).toBe(false);

    // A walk that lands ends the backoff: the next is a minute after it.
    failing = false;
    clockAt(255);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(8);
    expect(mgr.state.ioSignals).toEqual(SIGNALS);
    expect(mgr.state.ioSignalsLoaded).toBe(true);
    clockAt(314.999);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(8);
    clockAt(315);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(9);
  });

  it('loaded: the next walk is 60 s after the last one ended, whatever the number of polls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clockAt(0);
    const fake = makeFakeAdapter();
    let walks = 0;
    fake.listAllSignals = vi.fn(async () => {
      walks++;
      // The second walk takes 3 s: the minute counts from its end.
      if (walks === 2) { vi.setSystemTime(Date.now() + 3000); }
      return SIGNALS;
    }) as never;
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(walks).toBe(1);
    // Thirty polls inside the minute: no walk, however many polls run.
    for (let i = 1; i <= 30; i++) {
      clockAt(i * 1.99);
      await poll(mgr);
    }
    expect(walks).toBe(1);
    clockAt(60);
    await poll(mgr);
    expect(walks).toBe(2);              // ended at 63 s
    clockAt(122.999);
    await poll(mgr);
    expect(walks).toBe(2);
    clockAt(123);
    await poll(mgr);
    expect(walks).toBe(3);
  });

  it('refreshIoSignals walks at once and starts the minute again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clockAt(0);
    const fake = makeFakeAdapter();
    fake.listAllSignals = vi.fn(async () => SIGNALS) as never;
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    clockAt(30);
    await mgr.refreshIoSignals();
    expect(fake.listAllSignals).toHaveBeenCalledTimes(2);
    clockAt(60);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(2);
    clockAt(90);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(3);
  });

  it('a reconnect inside the backoff walks at its first poll', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clockAt(0);
    const fake = makeFakeAdapter();
    fake.listAllSignals = vi.fn()
      .mockRejectedValueOnce(new RwsError('controller busy', 'CONTROLLER_BUSY'))
      .mockResolvedValue(SIGNALS) as never;
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(mgr.state.ioSignalsLoaded).toBe(false);
    clockAt(1);
    await mgr.disconnect();
    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(2);
    expect(mgr.state.ioSignalsLoaded).toBe(true);
  });

  it('a clock set back does not hold the next walk off, after a walk or inside the backoff', async () => {
    // A due time further out than the longest wait (60 s) can only come from
    // a clock set back since it was set: the walk is due at once.
    vi.useFakeTimers({ toFake: ['Date'] });
    clockAt(0);
    const fake = makeFakeAdapter();
    let failing = false;
    fake.listAllSignals = vi.fn(async () => {
      if (failing) { throw new RwsError('controller busy', 'CONTROLLER_BUSY'); }
      return SIGNALS;
    }) as never;
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    mgr = managerWith(fake);

    await mgr.connect('vc-a', 'u', 'p', 80);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(1);   // due at 60 s
    clockAt(-3600);                                         // an hour back
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(2);   // due 60 s from here
    clockAt(-3541);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(2);
    clockAt(-3540);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(3);

    failing = true;
    clockAt(-3480);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(4);   // failed: due in 5 s
    clockAt(-7200);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(5);   // failed again: due in 10 s
    clockAt(-7191);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(5);
    clockAt(-7190);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(6);
  });

  // The poll's walk and a refreshIoSignals() at the same time: each walk is a
  // promise the test settles itself.
  function pendingWalks(fake: ReturnType<typeof makeFakeAdapter>) {
    const walks: Array<{ resolve: (s: typeof SIGNALS) => void; reject: (e: unknown) => void }> = [];
    fake.listAllSignals = vi.fn(() => new Promise((resolve, reject) => { walks.push({ resolve, reject }); })) as never;
    return walks;
  }
  const NEWER = [{ name: 'di_1', value: '1', type: 'DI' as const, lvalue: '1' }];

  it('a poll walk that fails after a refreshIoSignals landed leaves the refresh\'s minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clockAt(0);
    const fake = makeFakeAdapter();
    fake.listAllSignals = vi.fn(async () => SIGNALS) as never;
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    mgr = managerWith(fake);
    await mgr.connect('vc-a', 'u', 'p', 80);

    const walks = pendingWalks(fake);
    clockAt(60);
    const polled = poll(mgr);                       // the poll's walk starts
    await vi.waitFor(() => expect(walks).toHaveLength(1));
    const refreshed = mgr.refreshIoSignals();       // and the refresh's
    await vi.waitFor(() => expect(walks).toHaveLength(2));
    clockAt(62);
    walks[1].resolve(NEWER);
    await refreshed;                                // due at 122 s
    walks[0].reject(new RwsError('controller busy', 'CONTROLLER_BUSY'));
    await polled;

    expect(mgr.state.ioSignals).toEqual(NEWER);
    expect(mgr.state.ioSignalsLoaded).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^listAllSignals failed: controller busy; another read of the signal table landed meanwhile/));
    // No retry 5 s after the failure: the next walk is the refresh's minute.
    fake.listAllSignals = vi.fn(async () => NEWER) as never;
    clockAt(68);
    await poll(mgr);
    clockAt(121.999);
    await poll(mgr);
    expect(fake.listAllSignals).not.toHaveBeenCalled();
    clockAt(122);
    await poll(mgr);
    expect(fake.listAllSignals).toHaveBeenCalledTimes(1);
  });

  it('a walk that lands after a later-started one has landed keeps the newer table', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clockAt(0);
    const fake = makeFakeAdapter();
    fake.listAllSignals = vi.fn(async () => SIGNALS) as never;
    mgr = managerWith(fake);
    await mgr.connect('vc-a', 'u', 'p', 80);

    // The poll's walk first, the refresh's second; the refresh lands first.
    let walks = pendingWalks(fake);
    clockAt(60);
    const polled = poll(mgr);
    await vi.waitFor(() => expect(walks).toHaveLength(1));
    const refreshed = mgr.refreshIoSignals();
    await vi.waitFor(() => expect(walks).toHaveLength(2));
    walks[1].resolve(NEWER);
    await refreshed;
    walks[0].resolve(SIGNALS);
    await polled;
    expect(mgr.state.ioSignals).toEqual(NEWER);

    // The refresh's walk first, the poll's second; the poll lands first.
    walks = pendingWalks(fake);
    clockAt(200);
    const refreshed2 = mgr.refreshIoSignals();
    await vi.waitFor(() => expect(walks).toHaveLength(1));
    const polled2 = poll(mgr);
    await vi.waitFor(() => expect(walks).toHaveLength(2));
    walks[1].resolve(SIGNALS);
    await polled2;
    walks[0].resolve(NEWER);
    await refreshed2;
    expect(mgr.state.ioSignals).toEqual(SIGNALS);
  });

  it('refreshIoSignals does not mark the next connection loaded with an old read', async () => {
    const fake = makeFakeAdapter();
    mgr = managerWith(fake);
    await mgr.connect('vc-a', 'u', 'p', 80);

    let release!: (s: typeof SIGNALS) => void;
    fake.listAllSignals = vi.fn(() => new Promise(r => { release = r; })) as never;
    const refresh = mgr.refreshIoSignals();
    await mgr.disconnect();
    release(SIGNALS);
    await refresh;

    expect(mgr.state.ioSignals).toEqual([]);
    expect(mgr.state.ioSignalsLoaded).toBe(false);
  });

  it('every default state literal carries ioSignalsLoaded: false', () => {
    expect(new RobotManager().state.ioSignalsLoaded).toBe(false);
    expect(new MultiRobotManager().state.ioSignalsLoaded).toBe(false);
  });
});

describe('RobotManager.parseListeningPorts (locale-independent listening scan)', () => {
  // Real `netstat -ano -p TCP` shape: Proto | Local | Foreign | State | PID.
  // A listening socket's Foreign address is the wildcard :0 regardless of locale.
  const ENGLISH = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:5466           0.0.0.0:0              LISTENING       20156',
    '  TCP    0.0.0.0:14880          0.0.0.0:0              LISTENING       17280',
    '  TCP    127.0.0.1:9403         0.0.0.0:0              LISTENING       13176',
    '  TCP    127.0.0.1:52345        127.0.0.1:5466         ESTABLISHED     4444',  // active conn - NOT a listener
    '  TCP    [::]:445               [::]:0                 LISTENING       4',
  ].join('\r\n');

  // Same machine, German Windows: the State column is translated ("ABHÖREN"),
  // which is exactly what the old /LISTENING/ filter would have missed entirely.
  // Hand-written (synthetic) from a documented German netstat sample; the same
  // rows as console code-page bytes are in tests/fixtures/listening-ports/
  // win-netstat-ano-de-cp850.txt.
  const GERMAN = [
    'Aktive Verbindungen',
    '',
    '  Proto  Lokale Adresse         Remoteadresse          Status          PID',
    '  TCP    0.0.0.0:5466           0.0.0.0:0              ABHÖREN         20156',
    '  TCP    0.0.0.0:14880          0.0.0.0:0              ABHÖREN         17280',
    '  TCP    127.0.0.1:62214        0.0.0.0:0              ABHÖREN         99',      // high dynamic-range VC port
    '  TCP    127.0.0.1:52345        127.0.0.1:5466         HERGESTELLT     4444',   // ESTABLISHED, translated
  ].join('\r\n');

  const SS = [
    'State      Recv-Q Send-Q Local Address:Port  Peer Address:Port',
    'LISTEN     0      128    0.0.0.0:5466        0.0.0.0:*',
    'LISTEN     0      128    127.0.0.1:14880     0.0.0.0:*',
    'LISTEN     0      128    [::]:9403           [::]:*',
  ].join('\n');

  it('reads listening ports from English Windows netstat and skips active connections', () => {
    const ports = RobotManager.parseListeningPorts(ENGLISH, 'win32');
    expect(ports).toEqual(expect.arrayContaining([5466, 14880, 9403, 445]));
    expect(ports).not.toContain(52345);  // the ESTABLISHED local port must not leak in
  });

  it('reads the SAME ports from GERMAN Windows netstat (locale-independent)', () => {
    // This is the whole point of the fix: keying on Foreign :0, not the State word.
    const ports = RobotManager.parseListeningPorts(GERMAN, 'win32');
    expect(ports).toEqual(expect.arrayContaining([5466, 14880, 62214]));
    expect(ports).not.toContain(52345);
  });

  it('reads listening ports from POSIX `ss -ltn`', () => {
    const ports = RobotManager.parseListeningPorts(SS, 'linux');
    expect(ports.sort((a, b) => a - b)).toEqual([5466, 9403, 14880]);
  });

  it('returns nothing for empty or junk output', () => {
    expect(RobotManager.parseListeningPorts('', 'win32')).toEqual([]);
    expect(RobotManager.parseListeningPorts('not netstat output at all', 'win32')).toEqual([]);
  });

  // The implementation before the discovery modules, verbatim, as the reference: every input it
  // read ports from must give exactly the same list now.
  function previousParse(output: string, platform: NodeJS.Platform): number[] {
    const ports = new Set<number>();
    const addLocalPort = (localAddr: string): void => {
      const m = localAddr.match(/:(\d{1,5})$/);
      if (!m) { return; }
      const p = Number(m[1]);
      if (p > 0 && p < 65536) { ports.add(p); }
    };
    for (const line of output.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (platform === 'win32') {
        if (cols[0] !== 'TCP' || cols.length < 3 || !cols[2].endsWith(':0')) { continue; }
        addLocalPort(cols[1]);
      } else {
        for (const c of cols) {
          if (/^(?:0\.0\.0\.0|127\.0\.0\.1|\[::1?\]|\*):\d{1,5}$/.test(c)) { addLocalPort(c); }
        }
      }
    }
    return [...ports];
  }

  const FIX = new URL('./fixtures/listening-ports/', import.meta.url);
  const fixture = (name: string): string => fs.readFileSync(new URL(name, FIX)).toString('latin1');
  const NET_TOOLS = [
    'Active Internet connections (only servers)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
    'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN',
    'tcp        0      0 127.0.0.1:631           0.0.0.0:*               LISTEN',
  ].join('\n');

  const INPUTS: Array<[string, string, NodeJS.Platform]> = [
    ['English netstat', ENGLISH, 'win32'],
    ['German netstat', GERMAN, 'win32'],
    ['ss', SS, 'linux'],
    ['ss on darwin', SS, 'darwin'],
    ['Linux net-tools netstat', NET_TOOLS, 'linux'],
    ['fixture win-netstat-ano', fixture('win-netstat-ano.txt'), 'win32'],
    ['fixture win-netstat-ano-p-tcp', fixture('win-netstat-ano-p-tcp.txt'), 'win32'],
    ['fixture win-netstat-ano-de-cp850', fixture('win-netstat-ano-de-cp850.txt'), 'win32'],
    ['fixture ss-modern', fixture('ss-modern.txt'), 'linux'],
    ['fixture ss-old', fixture('ss-old.txt'), 'linux'],
    ['fixture ss-no-state', fixture('ss-no-state.txt'), 'linux'],
    ['fixture ss-netid-estab', fixture('ss-netid-estab.txt'), 'linux'],
  ];

  for (const [label, text, platform] of INPUTS) {
    it(`gives the same ports as before for ${label}`, () => {
      const before = previousParse(text, platform);
      expect(before.length, 'the reference reads ports from this input').toBeGreaterThan(0);
      expect(RobotManager.parseListeningPorts(text, platform)).toEqual(before);
    });
  }

  it('keeps the LAN-only Windows listener, as before (the port list is only a list of ports)', () => {
    expect(RobotManager.parseListeningPorts(fixture('win-netstat-ano.txt'), 'win32')).toContain(139);
  });

  it('reads /proc/net/tcp and macOS netstat text by content, which gave nothing before', () => {
    const proc = fixture('proc-net-tcp.txt');
    const proc6 = fixture('proc-net-tcp6.txt');
    const mac = fixture('macos-netstat.txt');
    expect(previousParse(proc, 'linux')).toEqual([]);
    expect(previousParse(mac, 'darwin')).toEqual([]);
    expect(RobotManager.parseListeningPorts(proc, 'linux').sort((a, b) => a - b)).toEqual([22, 53, 5474]);
    expect(RobotManager.parseListeningPorts(proc6, 'linux').length).toBeGreaterThan(0);
    expect(RobotManager.parseListeningPorts(mac, 'darwin')).toEqual(expect.arrayContaining([80, 88, 9403, 631]));
    // On Windows the content sniffing does not apply.
    expect(RobotManager.parseListeningPorts(proc, 'win32')).toEqual([]);
  });
});

describe('RobotManager wrapper-surface completion (1.3.1)', () => {
  it('pollRmmp and cancelRmmp delegate to the adapter', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter() as any;
    const calls: string[] = [];
    fake.pollRmmp = async () => { calls.push('pollRmmp'); return 'pending modify'; };
    fake.cancelRmmp = async () => { calls.push('cancelRmmp'); };
    (mgr as any).adapter = fake;

    await expect(mgr.pollRmmp()).resolves.toBe('pending modify');
    await mgr.cancelRmmp();
    expect(calls).toEqual(['pollRmmp', 'cancelRmmp']);
  });

  it('pollRmmp degrades and cancelRmmp throws when the adapter lacks RMMP', async () => {
    const mgr = new RobotManager();
    (mgr as any).adapter = makeFakeAdapter(); // no rmmp members
    await expect(mgr.pollRmmp()).resolves.toBe('unsupported');
    await expect(mgr.cancelRmmp()).rejects.toThrow(/RMMP/);
  });

  it('getEventLog fetches a chosen domain without touching state', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter();
    const msg = { seqnum: 1, msgtype: 'info', code: 10015, title: 'Program started' };
    (fake.getEventLog as any).mockResolvedValue([msg]);
    (mgr as any).adapter = fake;

    await expect(mgr.getEventLog(3, 'de')).resolves.toEqual([msg]);
    expect(fake.getEventLog).toHaveBeenCalledWith(3, 'de');
    await mgr.getEventLog();
    expect(fake.getEventLog).toHaveBeenCalledWith(0, 'en');
    // A non-empty fetch result must NOT leak into state - refreshEventLog owns that.
    expect((mgr as any)._state.eventLog).toEqual([]);
  });

  it('uploadFile and per-domain mastership delegate with arguments', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter() as any;
    const calls: Array<[string, unknown[]]> = [];
    fake.uploadFile = async (...a: unknown[]) => { calls.push(['uploadFile', a]); };
    fake.requestMastership = async (...a: unknown[]) => { calls.push(['requestMastership', a]); };
    fake.releaseMastership = async (...a: unknown[]) => { calls.push(['releaseMastership', a]); };
    (mgr as any).adapter = fake;

    await mgr.uploadFile('$HOME/probe.txt', 'hello');
    await mgr.requestMastership('motion');
    await mgr.releaseMastership('motion');
    expect(calls).toEqual([
      ['uploadFile', ['$HOME/probe.txt', 'hello']],
      ['requestMastership', ['motion']],
      ['releaseMastership', ['motion']],
    ]);
  });

  it('debugger backbone delegates with arguments; stepping/PP wrap in mastership like their siblings', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter() as any;
    const calls: Array<[string, unknown[]]> = [];
    for (const m of ['setPPToCursor', 'stepRapid', 'holdToRun', 'setBreakpoint', 'removeBreakpoint', 'requestMastership']) {
      fake[m] = async (...a: unknown[]) => { calls.push([m, a]); };
    }
    fake.releaseMastership = async (...a: unknown[]) => { calls.push(['releaseMastership', a]); };
    fake.listBreakpoints = async (...a: unknown[]) => { calls.push(['listBreakpoints', a]); return [{ module: 'MainModule', row: 12 }]; };
    (mgr as any).adapter = fake;

    await mgr.setPPToCursor('T_ROB1', 'MainModule', 12, 0);
    await mgr.stepRapid('T_ROB1', 'over');
    await mgr.holdToRun('T_ROB1', 'press');
    await expect(mgr.listBreakpoints('T_ROB1')).resolves.toEqual([{ module: 'MainModule', row: 12 }]);
    await mgr.setBreakpoint('T_ROB1', 'MainModule', 12);
    await mgr.removeBreakpoint('T_ROB1', 'MainModule', 12);

    expect(calls).toEqual([
      // setPPToCursor and stepRapid post to the mastership-gated execution/pcp
      // family, so they acquire and release around the op like startRapid does.
      ['requestMastership', ['rapid']],
      ['setPPToCursor', ['T_ROB1', 'MainModule', 12, 0, undefined]],
      ['releaseMastership', ['rapid']],
      ['requestMastership', ['rapid']],
      ['stepRapid', ['T_ROB1', 'over']],
      ['releaseMastership', ['rapid']],
      ['holdToRun', ['T_ROB1', 'press']],
      ['listBreakpoints', ['T_ROB1']],
      ['setBreakpoint', ['T_ROB1', 'MainModule', 12, undefined]],
      ['removeBreakpoint', ['T_ROB1', 'MainModule', 12, undefined]],
    ]);
  });

  it('a caller-held rapid hold is respected by mastership-wrapped ops, not churned', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter() as any;
    const calls: Array<[string, unknown[]]> = [];
    fake.requestMastership = async (...a: unknown[]) => { calls.push(['requestMastership', a]); };
    fake.releaseMastership = async (...a: unknown[]) => { calls.push(['releaseMastership', a]); };
    fake.stepRapid = async (...a: unknown[]) => { calls.push(['stepRapid', a]); };
    (mgr as any).adapter = fake;

    await mgr.requestMastership('rapid');   // caller takes the hold
    await mgr.stepRapid('T_ROB1', 'into');  // must NOT acquire/release its own
    await mgr.releaseMastership('rapid');

    expect(calls).toEqual([
      ['requestMastership', ['rapid']],
      ['stepRapid', ['T_ROB1', 'into']],
      ['releaseMastership', ['rapid']],
    ]);
  });

  it('caller-held motion mastership takes over and disarms the jog auto-release machinery', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter() as any;
    fake.requestMastership = vi.fn(async () => {});
    fake.jog = vi.fn(async () => {});
    // The jog pre-flight reads the mode fresh from the controller.
    fake.getOperationMode = vi.fn(async () => 'MANR');
    (mgr as any).adapter = fake;
    (mgr as any)._state.opmode = 'MANR';
    (mgr as any)._state.ctrlstate = 'motoron';

    await mgr.requestMastership('motion');
    expect((mgr as any).motionMastershipHeld).toBe(true);

    // Jogging inside a caller hold must not arm the 2s auto-release timer -
    // that timer would release the caller's mastership mid-edit.
    await mgr.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 });
    expect(fake.jog).toHaveBeenCalled();
    expect((mgr as any).jogReleaseTimer).toBeNull();
    expect(fake.requestMastership).toHaveBeenCalledTimes(1); // jog reused the hold

    await mgr.releaseMastership('motion');
    expect((mgr as any).motionMastershipHeld).toBe(false);
    expect(fake.releaseMastership).toHaveBeenCalledWith('motion');
  });

  it('releaseMastership(motion) after a jog resyncs the jog tracking', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter() as any;
    fake.requestMastership = vi.fn(async () => {});
    fake.jog = vi.fn(async () => {});
    // The jog pre-flight reads the mode fresh from the controller.
    fake.getOperationMode = vi.fn(async () => 'MANR');
    (mgr as any).adapter = fake;
    (mgr as any)._state.opmode = 'MANR';
    (mgr as any)._state.ctrlstate = 'motoron';

    await mgr.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 });
    expect((mgr as any).motionMastershipHeld).toBe(true);
    expect((mgr as any).jogReleaseTimer).not.toBeNull();

    await mgr.releaseMastership('motion');
    // Flag and timer must both reset, or the next jog would skip the
    // re-request and 403 against a mastership the session no longer holds.
    expect((mgr as any).motionMastershipHeld).toBe(false);
    expect((mgr as any).jogReleaseTimer).toBeNull();
  });

  it('triggerVisionJob refuses to run a different job than named on a one-arg adapter', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter() as any;
    const calls: unknown[][] = [];
    fake.triggerVisionJob = async (system: string, job: string) => { calls.push([system, job]); };
    (mgr as any).adapter = fake;
    await mgr.triggerVisionJob('cam1', 'JobB');
    expect(calls).toEqual([['cam1', 'JobB']]);

    const oneArg = makeFakeAdapter() as any;
    oneArg.triggerVisionJob = async (system: string) => { calls.push([system]); };
    (mgr as any).adapter = oneArg;
    await expect(mgr.triggerVisionJob('cam1', 'JobB')).rejects.toThrow(/takes no job name/);
    expect(calls).toHaveLength(1); // the wrong-job call never went to the wire
  });

  it('reads degrade to neutral values on adapters without the ops', async () => {
    const mgr = new RobotManager();
    (mgr as any).adapter = makeFakeAdapter(); // none of the optional ops present

    await expect(mgr.listBreakpoints('T_ROB1')).resolves.toEqual([]);
    await expect(mgr.listServiceRoutines('T_ROB1')).resolves.toEqual([]);
    await expect(mgr.getVisionSystemInfo('cam1')).resolves.toEqual({});
    await expect(mgr.listVisionJobs('cam1')).resolves.toEqual([]);
    await expect(mgr.listSafetyZones()).resolves.toEqual([]);
    await expect(mgr.getMechunitPjoints()).resolves.toEqual({});
    await expect(mgr.listCertificates()).resolves.toEqual([]);
    await expect(mgr.listDeviceGroups()).resolves.toEqual([]);
    await expect(mgr.listControllerDevices('HW_DEVICES')).resolves.toEqual([]);
    await expect(mgr.listMastershipDomains()).resolves.toEqual([]);
  });

  it('writes throw a typed error rather than silently no-op', async () => {
    const mgr = new RobotManager();
    (mgr as any).adapter = makeFakeAdapter();

    for (const call of [
      () => mgr.setPPToCursor('T_ROB1', 'MainModule', 1, 0),
      () => mgr.stepRapid('T_ROB1', 'into'),
      () => mgr.holdToRun('T_ROB1', 'press'),
      () => mgr.setBreakpoint('T_ROB1', 'MainModule', 1),
      () => mgr.removeBreakpoint('T_ROB1', 'MainModule', 1),
      () => mgr.triggerVisionJob('cam1', 'job1'),
      () => mgr.runCyclicBrakeCheck(),
      () => mgr.setMechunitBaseFrame('ROB_1', { x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0 }),
      () => mgr.uploadCertificate('c', 'PEM'),
      () => mgr.removeCertificate('c'),
    ]) {
      await expect(call()).rejects.toThrow(/not available on this controller/);
    }
  });

  it('throws NOT_CONNECTED before any adapter exists', async () => {
    const mgr = new RobotManager();
    await expect(mgr.getEventLog()).rejects.toThrow(/Not connected/);
    await expect(mgr.uploadFile('$HOME/x', 'y')).rejects.toThrow(/Not connected/);
    await expect(mgr.requestMastership('rapid')).rejects.toThrow(/Not connected/);
    await expect(mgr.releaseMastership('rapid')).rejects.toThrow(/Not connected/);
    await expect(mgr.stepRapid('T_ROB1', 'into')).rejects.toThrow(/not connected/);
    await expect(mgr.pollRmmp()).resolves.toBe('unsupported'); // read degrades even unconnected
  });
});

describe('RobotManager port recovery picks the SAME controller', () => {
  // Spies on static methods outlive a test unless restored - one test's fake
  // chooser silently decided the next test's recovery.
  afterEach(() => { vi.restoreAllMocks(); });

  // Reproduces 2026-09-23: three VCs on one PC; the RW7 entry's saved port went
  // stale, recovery took the first RWS 2.0 controller found - the RW8 VC.
  const RW8 = { port: 5466, useHttps: true, authType: 'basic' as const };
  const RW7 = { port: 9403, useHttps: true, authType: 'basic' as const };
  const RW6 = { port: 33806, useHttps: false, authType: 'digest' as const };
  const ids: Record<number, string> = { 5466: '{DDDEA751-93CE-4DAC-8D85-55725137AF66}', 9403: '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}' };
  const identify = async (c: { port: number }) => ids[c.port] ?? null;

  it('adopts the candidate whose system id matches, even when another answers first', async () => {
    const r = await RobotManager.chooseRecoveryCandidate([RW8, RW7, RW6], 'basic', ids[9403], identify);
    expect(r.match).toEqual(RW7);
  });

  it('compares system ids without braces or case', async () => {
    const r = await RobotManager.chooseRecoveryCandidate([RW8, RW7], 'basic', 'a3be1993-3fa0-4d46-93ff-7fa2d8086c81', identify);
    expect(r.match).toEqual(RW7);
  });

  it('adopts nothing when no candidate has the expected id', async () => {
    const r = await RobotManager.chooseRecoveryCandidate([RW8], 'basic', ids[9403], identify);
    expect(r.match).toBeNull();
  });

  it('treats a candidate it cannot identify as not a match', async () => {
    const r = await RobotManager.chooseRecoveryCandidate([RW7], 'basic', ids[9403], async () => { throw new Error('401'); });
    expect(r.match).toBeNull();
  });

  it('never crosses protocol generation, even as a fallback', async () => {
    const r = await RobotManager.chooseRecoveryCandidate([RW6], 'basic', null, identify);
    expect(r.match).toBeNull();
  });

  it('without an id, adopts a single candidate of the generation but refuses to guess between two', async () => {
    expect((await RobotManager.chooseRecoveryCandidate([RW7, RW6], 'basic', null, identify)).match).toEqual(RW7);
    expect((await RobotManager.chooseRecoveryCandidate([RW8, RW7], 'basic', null, identify)).match).toBeNull();
  });

  function stubRws2() {
    vi.spyOn(RWS2Adapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'getSessionCookie').mockReturnValue(null);
    vi.spyOn(RWS2Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
    vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(null);      // saved port is dead
    vi.spyOn(RobotManager, 'detectAllControllers').mockResolvedValue([RW8, RW7]);
    // Never the real listening-port scan here: it would probe whatever listens on this PC.
    vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([]);
    vi.spyOn(RobotManager.prototype as any, 'identifyCandidate')
      .mockImplementation(async (_h: unknown, c: unknown) => ids[(c as { port: number }).port] ?? null);
  }

  it('connect() recovers to the expected controller, not the first one found', async () => {
    const mgr = new RobotManager();
    stubRws2();
    mgr.setExpectedSystemId(ids[9403]);
    rws2CtorArgs.length = 0;
    await mgr.connect('127.0.0.1', 'u', 'p', 9999, true);
    expect(rws2CtorArgs[0][0]).toBe('https://127.0.0.1:9403');
    await mgr.disconnect();
  });

  it('connect() keeps the saved port rather than guess between two controllers', async () => {
    const mgr = new RobotManager();
    stubRws2();
    rws2CtorArgs.length = 0;
    await mgr.connect('127.0.0.1', 'u', 'p', 9999, true);
    expect(rws2CtorArgs[0][0]).toBe('https://127.0.0.1:9999');
    await mgr.disconnect();
  });

  it('on localhost, a VC on a standard port does not hide a moved VC on another port', async () => {
    // Live 2026-09-23: the RW6 VC moved 33806 -> 50959 while the RW8 VC sat on
    // standard port 5466; the moved RW6 was never offered to the identity check.
    const RW6_MOVED = { port: 50959, useHttps: false, authType: 'digest' as const };
    const mgr = new RobotManager();
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(null);
    vi.spyOn(RobotManager, 'detectAllControllers').mockResolvedValue([RW8]);
    vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([
      { host: '127.0.0.1', ...RW8 }, { host: '127.0.0.1', ...RW6_MOVED },
    ]);
    const seen: number[][] = [];
    vi.spyOn(RobotManager, 'chooseRecoveryCandidate').mockImplementation(async cands => {
      seen.push(cands.map(c => c.port));
      return { match: null, reason: 'stop here' };
    });
    await mgr.connect('127.0.0.1', 'u', 'p', 33806, false).catch(() => {});
    expect(seen[0]).toEqual([5466, 50959]);   // the standard-port hit plus the moved VC, once each
    await mgr.disconnect();
  });

  it('treats a different controller on the saved port like a dead port, and recovers', async () => {
    // Live 2026-09-23: the RW7 entry's saved 9403 was taken by another VC after
    // a restart; the RW7 had moved to 9404.
    const STRANGER_ID = '{D9E18C83-0000-0000-0000-000000000000}';
    const RW7_MOVED = { port: 9404, useHttps: true, authType: 'basic' as const };
    const mgr = new RobotManager();
    stubRws2();
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(RW7);          // 9403 answers...
    vi.spyOn(RobotManager, 'detectAllControllers').mockResolvedValue([RW8, RW7]);
    vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([{ host: '127.0.0.1', ...RW7_MOVED }]);
    vi.spyOn(RobotManager.prototype as any, 'identifyCandidate').mockImplementation(async (_h: unknown, c: unknown) => {
      const port = (c as { port: number }).port;
      return port === 9403 ? STRANGER_ID : port === 9404 ? ids[9403] : ids[port] ?? null;   // ...as a stranger
    });
    mgr.setExpectedSystemId(ids[9403]);
    rws2CtorArgs.length = 0;
    await mgr.connect('127.0.0.1', 'u', 'p', 9403, true);
    expect(rws2CtorArgs[0][0]).toBe('https://127.0.0.1:9404');
    await mgr.disconnect();
  });

  it('refuses to connect when the saved port holds a stranger and the controller is nowhere', async () => {
    // Live 2026-09-23: the RW7 VC was off and another VC held its 9403. Falling
    // back to the saved port would have connected straight to the stranger.
    const mgr = new RobotManager();
    stubRws2();
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(RW7);
    vi.spyOn(RobotManager, 'detectAllControllers').mockResolvedValue([RW8, RW7]);
    vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([]);
    vi.spyOn(RobotManager.prototype as any, 'identifyCandidate').mockImplementation(async (_h: unknown, c: unknown) =>
      (c as { port: number }).port === 9403 ? '{D9E18C83-0000-0000-0000-000000000000}' : ids[(c as { port: number }).port] ?? null);
    mgr.setExpectedSystemId(ids[9403]);
    rws2CtorArgs.length = 0;
    await expect(mgr.connect('127.0.0.1', 'u', 'p', 9403, true)).rejects.toMatchObject({ code: 'PROTOCOL_DETECT_FAILED' });
    expect(rws2CtorArgs).toHaveLength(0);   // no adapter was ever pointed at the stranger
    expect(mgr.state.connected).toBe(false);
  });

  it('says why when the saved port is dead and no candidate is the expected controller', async () => {
    // Live 2026-09-24: the RW6 entry's VC was off, another RW6 system ran on a
    // new port; the caller saw only the dead saved port's "fetch failed".
    const mgr = new RobotManager();
    stubRws2();                                                  // saved port dead; candidates RW8, RW7
    vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([]);
    const OFF_ID = '{F2E08F07-3F27-4DE5-82CC-74A72537F492}';    // neither candidate
    mgr.setExpectedSystemId(OFF_ID);
    rws2CtorArgs.length = 0;
    const err = await mgr.connect('127.0.0.1', 'u', 'p', 9999, true).catch(e => e);
    expect(err).toMatchObject({ code: 'PROTOCOL_DETECT_FAILED' });
    expect(err.message).toContain(`controller ${OFF_ID} not found on 127.0.0.1`);
    expect(err.message).toContain('saved port 9999 is not responding');
    expect(err.message).toContain('none of 2 candidate(s)');
    expect(rws2CtorArgs).toHaveLength(0);                       // nothing was pointed at any port
    expect(mgr.state.connected).toBe(false);
  });

  it('uses the saved port without scanning when it answers as the expected controller', async () => {
    const mgr = new RobotManager();
    stubRws2();
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(RW7);
    const scan = vi.spyOn(RobotManager, 'detectAllControllers');
    mgr.setExpectedSystemId(ids[9403]);
    rws2CtorArgs.length = 0;
    await mgr.connect('127.0.0.1', 'u', 'p', 9403, true);
    expect(rws2CtorArgs[0][0]).toBe('https://127.0.0.1:9403');
    expect(scan).not.toHaveBeenCalled();
    await mgr.disconnect();
  });

  it('MultiRobotManager passes a config entry\'s expected id to its manager', () => {
    const multi = new MultiRobotManager();
    multi.addRobot({ id: 'rw7', name: 'RW7', host: '127.0.0.1', port: 9403, useHttps: true, username: 'u', password: 'p', expectedSystemId: ids[9403] });
    expect((multi.entries[0].manager as any).expectedSystemId).toBe(ids[9403]);
  });
});

describe('RobotManager port recovery: the scheme of the saved port', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const RW6 = { port: 39127, useHttps: false, authType: 'digest' as const };
  const RW7 = { port: 9403, useHttps: true, authType: 'basic' as const };
  const RW8 = { port: 9805, useHttps: true, authType: 'basic' as const };
  const ids: Record<number, string> = { 39127: '{6}', 9403: '{7}', 9805: '{8}' };

  function stub(candidates: Array<{ port: number; useHttps: boolean; authType: 'digest' | 'basic' }>) {
    vi.spyOn(RWS2Adapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'getSessionCookie').mockReturnValue(null);
    vi.spyOn(RWS2Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
    vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(null);
    vi.spyOn(RobotManager, 'detectAllControllers').mockResolvedValue(candidates);
    vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([]);
    return vi.spyOn(RobotManager.prototype as any, 'identifyCandidate')
      .mockImplementation(async (_h: unknown, c: unknown) => ids[(c as { port: number }).port] ?? null);
  }

  for (const saved of [5466, 9805]) {
    it(`a saved ${saved} without its scheme is an RWS 2.0 port: the RWS 2.0 candidate is adopted, never the RWS 1.0 one`, async () => {
      const mgr = new RobotManager();
      stub(saved === 9805 ? [RW6, RW7] : [RW6, RW8]);
      rws2CtorArgs.length = 0;
      await mgr.connect('127.0.0.1', 'u', 'p', saved);
      expect(rws2CtorArgs[0][0]).toBe(`https://127.0.0.1:${saved === 9805 ? 9403 : 9805}`);
      await mgr.disconnect();
    });
  }

  it('a saved 80 without its scheme: protocol unknown, so the system id decides across both protocols', async () => {
    const mgr = new RobotManager();
    stub([RW6, RW8]);
    mgr.setExpectedSystemId(ids[9805]);
    rws2CtorArgs.length = 0;
    await mgr.connect('127.0.0.1', 'u', 'p', 80);
    expect(rws2CtorArgs[0][0]).toBe('https://127.0.0.1:9805');
    await mgr.disconnect();
  });

  it('a saved 80 kept with no candidate: probed once more, and only then HTTPS is guessed (logged)', async () => {
    const warn = vi.spyOn(Logger, 'warn');
    const mgr = new RobotManager();
    stub([]);
    const probe = vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(null);
    rws2CtorArgs.length = 0;
    await mgr.connect('127.0.0.1', 'u', 'p', 80);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(rws2CtorArgs[0][0]).toBe('https://127.0.0.1:80');
    expect(warn.mock.calls.some(c => String(c[0]).includes('guessing HTTPS'))).toBe(true);
    await mgr.disconnect();
  });

  it('a saved 80 kept: when the second probe answers, its scheme is used, not a guess', async () => {
    const mgr = new RobotManager();
    stub([]);
    vi.spyOn(RobotManager, 'probeSpecificPort')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ port: 80, useHttps: true, authType: 'basic' });
    rws2CtorArgs.length = 0;
    await mgr.connect('127.0.0.1', 'u', 'p', 80);
    expect(rws2CtorArgs[0][0]).toBe('https://127.0.0.1:80');
    await mgr.disconnect();
  });

  it('chooseRecoveryCandidate with an unknown protocol (null): same rules over every candidate', async () => {
    const identify = async (c: { port: number }) => ids[c.port] ?? null;
    expect((await RobotManager.chooseRecoveryCandidate([RW6], null, null, identify)).match).toEqual(RW6);
    const two = await RobotManager.chooseRecoveryCandidate([RW6, RW8], null, null, identify);
    expect(two.match).toBeNull();
    expect(two.reason).toMatch(/neither the protocol nor a system id/);
    expect((await RobotManager.chooseRecoveryCandidate([RW6, RW8], null, ids[39127], identify)).match).toEqual(RW6);
    expect((await RobotManager.chooseRecoveryCandidate([], null, null, identify)).reason).toBe('no RWS candidate among 0');
  });

  it('auto-detect names the ports it tried, from the port table', async () => {
    const mgr = new RobotManager();
    vi.spyOn(RobotManager, 'detectController').mockResolvedValue(null);
    const err = await mgr.connect('192.0.2.10', 'u', 'p').catch(e => e);
    expect(err).toMatchObject({ code: 'PROTOCOL_DETECT_FAILED' });
    expect(err.message).toContain('443 (https), 80 (https, http), 5466 (https)');
    expect(err.message).not.toContain('28447, 9403.');
  });
});

describe('RobotManager port recovery on another machine', () => {
  // A host that is not this PC (RFC 5737 address). The scan is mocked at the realm-aware level.
  afterEach(() => { vi.restoreAllMocks(); });
  const HOST = '192.0.2.10';
  const OMNI = { port: 443, useHttps: true, authType: 'basic' as const };
  const FOREIGN = { port: 80, useHttps: true, authType: 'basic' as const };
  const PLAIN_BASIC = { port: 80, useHttps: false, authType: 'basic' as const };

  function stub(detailed: Array<{ result: { port: number; useHttps: boolean; authType: 'basic' | 'digest' }; realm?: string }>) {
    vi.spyOn(RWS2Adapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(RWS2Adapter.prototype, 'getSessionCookie').mockReturnValue(null);
    vi.spyOn(RWS2Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
    vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue(null);
    vi.spyOn(RobotManager as any, 'detectAllDetailed').mockResolvedValue(detailed);
    const local = vi.spyOn(RobotManager, 'discoverLocalControllers').mockResolvedValue([]);
    const identify = vi.spyOn(RobotManager.prototype as any, 'identifyCandidate').mockResolvedValue('{OMNI}');
    return { identify, local };
  }

  it('logs in only to candidates whose 401 realm is the ABB realm, never Basic over plain HTTP', async () => {
    const mgr = new RobotManager();
    // The ineligible ones first: identify would reach them before the ABB one.
    const { identify, local } = stub([
      { result: FOREIGN, realm: 'router' },
      { result: PLAIN_BASIC, realm: 'validusers@robapi.abb' },
      { result: OMNI, realm: 'validusers@robapi.abb' },
    ]);
    mgr.setExpectedSystemId('{OMNI}');
    rws2CtorArgs.length = 0;
    await mgr.connect(HOST, 'u', 'p', 9999, true);
    expect(identify.mock.calls.map(c => (c[1] as { port: number; useHttps: boolean }))).toEqual([OMNI]);
    expect(rws2CtorArgs[0][0]).toBe(`https://${HOST}:443`);
    expect(local).not.toHaveBeenCalled();     // no listening-port scan for another machine
    await mgr.disconnect();
  });

  it('without a system id, a candidate from another realm is never adopted', async () => {
    const mgr = new RobotManager();
    stub([{ result: FOREIGN, realm: 'router' }]);
    rws2CtorArgs.length = 0;
    await mgr.connect(HOST, 'u', 'p', 9999, true);
    // Nothing eligible: the saved port is kept, the foreign 401 is not taken for the robot.
    expect(rws2CtorArgs[0][0]).toBe(`https://${HOST}:9999`);
    await mgr.disconnect();
  });
});

describe('onSubscriptionEvent tap (slice 5)', () => {
  const fire = (mgr: RobotManager, resource: string, value = '1') =>
    (mgr as any).handleSubscriptionEvent({ resource, value, timestamp: new Date(0) });

  it('forwards events for resources the manager does not consume (a signal)', () => {
    const mgr = new RobotManager();
    (mgr as any)._state.connected = true;
    const seen: string[] = [];
    mgr.onSubscriptionEvent(e => seen.push(`${e.resource}=${e.value}`));
    fire(mgr, '/rw/iosystem/signals/Local/DRV_1/do_test;state', '1');
    expect(seen).toEqual(['/rw/iosystem/signals/Local/DRV_1/do_test;state=1']);
  });

  it('also passes through events the manager consumes itself, before state is updated', () => {
    const mgr = new RobotManager();
    (mgr as any)._state.connected = true;
    const seen: string[] = [];
    mgr.onSubscriptionEvent(e => seen.push(e.resource));
    fire(mgr, 'speedratio', '50');
    expect(seen).toEqual(['speedratio']);
    expect(mgr.state.speedRatio).toBe(50);   // the manager still applied it
  });

  it('a throwing tap does not break the manager or other taps', () => {
    const mgr = new RobotManager();
    (mgr as any)._state.connected = true;
    const seen: string[] = [];
    mgr.onSubscriptionEvent(() => { throw new Error('boom'); });
    mgr.onSubscriptionEvent(e => seen.push(e.resource));
    fire(mgr, 'controllerstate', 'motoron');
    expect(seen).toEqual(['controllerstate']);
    expect(mgr.state.ctrlstate).toBe('motoron');
  });

  it('a signal whose name starts with opmode, execution or speedratio never touches manager state', () => {
    const mgr = new RobotManager();
    (mgr as any)._state.connected = true;
    Object.assign((mgr as any)._state, { opmode: 'AUTO', execstate: 'stopped', speedRatio: 100 });
    const seen: string[] = [];
    mgr.onSubscriptionEvent(e => seen.push(e.resource));
    fire(mgr, '/rw/iosystem/signals/opmode_sel;state', '0');
    fire(mgr, '/rw/iosystem/signals/Local/DRV_1/execution_done;state', '1');
    fire(mgr, '/rw/iosystem/signals/speedratio_ao;state', '1');
    fire(mgr, '/rw/rapid/execution;rapidexeccycle', 'forever');
    expect(mgr.state.opmode).toBe('AUTO');
    expect(mgr.state.execstate).toBe('stopped');
    expect(mgr.state.speedRatio).toBe(100);
    // The tap still sees every one of them, unrenamed.
    expect(seen).toEqual([
      '/rw/iosystem/signals/opmode_sel;state',
      '/rw/iosystem/signals/Local/DRV_1/execution_done;state',
      '/rw/iosystem/signals/speedratio_ao;state',
      '/rw/rapid/execution;rapidexeccycle',
    ]);
  });

  it('still applies the panel resources by href (RWS 1.0) and by friendly name (RWS 2.0)', () => {
    const mgr = new RobotManager();
    (mgr as any)._state.connected = true;
    fire(mgr, '/rw/panel/opmode', 'MANR');
    fire(mgr, '/rw/rapid/execution;ctrlexecstate', 'running');
    fire(mgr, '/rw/panel/ctrlstate', 'motoron');
    fire(mgr, 'speedratio', '25');
    fire(mgr, 'coldetstate', 'TRIGGERED');
    expect(mgr.state.opmode).toBe('MANR');
    expect(mgr.state.execstate).toBe('running');
    expect(mgr.state.ctrlstate).toBe('motoron');
    expect(mgr.state.speedRatio).toBe(25);
    expect(mgr.state.coldetstate).toBe('TRIGGERED');
  });

  it('delivers nothing while disconnected, and stops after the returned untap', () => {
    const mgr = new RobotManager();
    const seen: string[] = [];
    const untap = mgr.onSubscriptionEvent(e => seen.push(e.resource));
    fire(mgr, 'speedratio', '10');            // not connected: dropped
    expect(seen).toEqual([]);
    (mgr as any)._state.connected = true;
    fire(mgr, 'speedratio', '20');
    untap();
    fire(mgr, 'speedratio', '30');
    expect(seen).toEqual(['speedratio']);
  });
});
