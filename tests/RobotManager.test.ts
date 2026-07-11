import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'node:https';
import { RobotManager } from '../src/RobotManager.js';
import { MultiRobotManager } from '../src/MultiRobotManager.js';
import * as MdnsDiscovery from '../src/MdnsDiscovery.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RwsClient } from '../src/RwsClient.js';

// Re-export the real fs through a plain (spyable) module object — the builtin
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
    listModules: vi.fn(async () => ['MainModule']),
    getJointPositions: vi.fn(async () => ({ rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 0, rax_6: 0 })),
    getCartesianFull: vi.fn(async () => ({ x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 })),
    getCollisionDetectionState: vi.fn(async () => 'On'),
    getControllerIdentity: vi.fn(async () => ({ name: 'vc' })),
    getSystemInfo: vi.fn(async () => ({ name: 'vc' })),
    getEventLog: vi.fn(async () => []),
    listMechunits: vi.fn(async () => ['ROB_1']),
    listAllSignals: vi.fn(async () => []),
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

    // Same args, but the in-flight attempt was cancelled by the disconnect —
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

  it('polls the module list of the active task, not hardcoded T_ROB1', async () => {
    const mgr = new RobotManager();
    const fake = makeFakeAdapter();
    fake.getRapidTasks = vi.fn(async () => [
      { name: 'T_MULTI', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: true, motiontask: true },
    ]);
    (mgr as any).adapter = fake;
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
    await mgr.refresh();
    expect(fake.listModules).toHaveBeenCalledWith('T_LEFT');
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
