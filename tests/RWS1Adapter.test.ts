import { describe, it, expect } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';

// ─── Fake RwsClient - records calls, replies per URL ─────────────────────────

interface FakeCall { what: string; body?: string }

function makeFake(respond?: (method: string, url: string) => { status: number; body: string } | undefined): {
  calls: FakeCall[];
  client: RwsClient;
} {
  const calls: FakeCall[] = [];
  const fake = {
    requestMastership: async (d: string) => { calls.push({ what: `mastership-request ${d}` }); },
    releaseMastership: async (d: string) => { calls.push({ what: `mastership-release ${d}` }); },
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return respond?.(method, url) ?? { status: 204, body: '' };
    },
  };
  return { calls, client: fake as unknown as RwsClient };
}

// ─── Mechunit listing ────────────────────────────────────────────────────────

describe('RWS1Adapter.listMechunits', () => {
  it('lists mechunits from the controller instead of hardcoding ROB_1', async () => {
    const { calls, client } = makeFake((_m, url) => {
      if (url === '/rw/motionsystem/mechunits?json=1') {
        return {
          status: 200,
          body: JSON.stringify({ _embedded: { _state: [
            { _type: 'ms-mechunit-li', _title: 'ROB_1' },
            { _type: 'ms-mechunit-li', _title: 'STN_1' },
          ] } }),
        };
      }
      return undefined;
    });
    const adapter = new RWS1Adapter(client);
    expect(await adapter.listMechunits()).toEqual(['ROB_1', 'STN_1']);
    expect(calls.map(c => c.what)).toContain('GET /rw/motionsystem/mechunits?json=1');
  });
});

// ─── CFG instance writes (live-verified wire shapes, IRC5 VC RW6.16) ─────────

describe('RWS1Adapter cfg instance writes', () => {
  it('setCfgInstance POSTs plain form attributes to ?action=set under cfg mastership', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.setCfgInstance('SYS', 'CAB_TASKS', 'T_ROB1', { StackSize: '25000', Entry: 'my main' });

    const whats = calls.map(c => c.what);
    const postIdx = whats.indexOf('POST /rw/cfg/SYS/CAB_TASKS/instances/T_ROB1?action=set&json=1');
    expect(postIdx).toBeGreaterThan(-1);
    expect(calls[postIdx].body).toBe('StackSize=25000&Entry=my%20main');
    // acquire → write → release ordering
    expect(whats.indexOf('mastership-request cfg')).toBeLessThan(postIdx);
    expect(whats.indexOf('mastership-release cfg')).toBeGreaterThan(postIdx);
  });

  it('setCfgInstance releases mastership even when the write fails', async () => {
    const { calls, client } = makeFake((m, url) =>
      m === 'POST' && url.includes('action=set') ? { status: 403, body: '' } : undefined);
    const adapter = new RWS1Adapter(client);
    await expect(adapter.setCfgInstance('SYS', 'CAB_TASKS', 'T_ROB1', { StackSize: '1' })).rejects.toThrow();
    expect(calls.map(c => c.what)).toContain('mastership-release cfg');
  });

  it('createCfgInstance POSTs name= to instances?action=create-default then applies attributes', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.createCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW', { Entry: 'probeMain' });

    const whats = calls.map(c => c.what);
    const createIdx = whats.indexOf('POST /rw/cfg/SYS/CAB_TASKS/instances?action=create-default&json=1');
    const setIdx = whats.indexOf('POST /rw/cfg/SYS/CAB_TASKS/instances/ZZ_NEW?action=set&json=1');
    expect(createIdx).toBeGreaterThan(-1);
    expect(calls[createIdx].body).toBe('name=ZZ_NEW');
    expect(setIdx).toBeGreaterThan(createIdx);
    expect(calls[setIdx].body).toBe('Entry=probeMain');
  });

  it('createCfgInstance skips the set step when no attributes are given', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.createCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW', {});
    expect(calls.some(c => c.what.includes('action=set'))).toBe(false);
  });

  it('removeCfgInstance DELETEs the instance resource', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.removeCfgInstance('SYS', 'CAB_TASKS', 'ZZ_NEW');
    expect(calls.map(c => c.what)).toContain('DELETE /rw/cfg/SYS/CAB_TASKS/instances/ZZ_NEW?json=1');
  });

  it('removeCfgInstance surfaces HTTP errors', async () => {
    const { client } = makeFake((m) => m === 'DELETE' ? { status: 400, body: '' } : undefined);
    const adapter = new RWS1Adapter(client);
    await expect(adapter.removeCfgInstance('SYS', 'CAB_TASKS', 'MISSING')).rejects.toThrow();
  });
});

// ─── saveModule (live-verified wire shape, IRC5 VC RW6.16) ───────────────────

describe('RWS1Adapter.saveModule', () => {
  it('POSTs the module-save action when given a directory (savemod on the task resource is dead)', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.saveModule('T_ROB1', 'MainModule', '$TEMP');

    const whats = calls.map(c => c.what);
    const idx = whats.indexOf('POST /rw/rapid/modules/MainModule?task=T_ROB1&action=save&json=1');
    expect(idx).toBeGreaterThan(-1);
    expect(calls[idx].body).toBe('name=MainModule&path=$TEMP');
  });

  it('splits a full destination path and strips the extension the controller re-appends', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.saveModule('T_ROB1', 'MainModule', '$HOME/backups/copy.mod');

    const post = calls.find(c => c.what.startsWith('POST'));
    expect(post?.what).toBe('POST /rw/rapid/modules/MainModule?task=T_ROB1&action=save&json=1');
    expect(post?.body).toBe('name=copy&path=$HOME/backups');
  });

  it('defaults the directory to $HOME for a bare file name and strips .sys too', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.saveModule('T_ROB1', 'SysMod1', 'SysMod1.sys');

    const post = calls.find(c => c.what.startsWith('POST'));
    expect(post?.body).toBe('name=SysMod1&path=$HOME');
  });

  it('surfaces HTTP errors from the save action', async () => {
    const { client } = makeFake((m) => m === 'POST' ? { status: 400, body: '' } : undefined);
    const adapter = new RWS1Adapter(client);
    await expect(adapter.saveModule('T_ROB1', 'MainModule', '$TEMP')).rejects.toThrow();
  });
});

// ─── subscribe() accepts the optional onLost parameter ───────────────────────

describe('RWS1Adapter.subscribe', () => {
  it('accepts (and may ignore) an onLost callback', async () => {
    const fake = {
      subscribe: async () => async () => {},
    };
    const adapter = new RWS1Adapter(fake as unknown as RwsClient);
    const unsub = await adapter.subscribe(['speedratio'], () => {}, () => {});
    expect(typeof unsub).toBe('function');
    await unsub();
  });

  it('forwards onLost and onRestored to the client subscription options', async () => {
    const captured: Array<{ onLost?: () => void; onRestored?: () => void }> = [];
    const fake = {
      subscribe: async (
        _r: unknown, _h: unknown, opts?: { onLost?: () => void; onRestored?: () => void },
      ) => { captured.push(opts ?? {}); return async () => {}; },
    };
    const adapter = new RWS1Adapter(fake as unknown as RwsClient);
    const onLost = (): void => {};
    const onRestored = (): void => {};

    await adapter.subscribe(['speedratio'], () => {}, onLost, onRestored);

    expect(captured[0]?.onLost).toBe(onLost);
    expect(captured[0]?.onRestored).toBe(onRestored);
  });
});

// ─── Live-audit fixes (RobotWare 6.16) ───────────────────────────────────────

describe('RWS1Adapter live-audit fixes', () => {
  it('listControllerOptions reads /rw/system/options, not the empty /ctrl/options', async () => {
    const { calls, client } = makeFake((_m, url) => {
      // RobotWare 6 answers 204 No Content on /ctrl/options, exactly like RW7/8.
      if (url.startsWith('/ctrl/options')) { return { status: 204, body: '' }; }
      if (url.startsWith('/rw/system/options')) {
        return { status: 200, body: JSON.stringify({ _embedded: { _state: [
          { _type: 'sys-option-li', _title: '0', option: 'RobotWare Base' },
          { _type: 'sys-option-li', _title: '1', option: 'English' },
        ] } }) };
      }
      return undefined;
    });
    const a = new RWS1Adapter(client);
    const opts = await a.listControllerOptions();
    expect(opts.map(o => o.name)).toEqual(['RobotWare Base', 'English']);
    expect(calls.some(c => c.what.includes('/rw/system/options'))).toBe(true);
  });

  it('reads resources that answer with a top-level state array', async () => {
    // /rw/system/products replies in the RWS 2.0 shape on RobotWare 6; reading
    // only _embedded._state made it look empty.
    const { client } = makeFake((_m, url) => url.startsWith('/rw/system/products')
      ? { status: 200, body: JSON.stringify({ state: [
        { _type: 'sys-product-li', _title: 'RobotWare', 'version-name': '6.16.03.00' },
      ] }) }
      : undefined);
    const a = new RWS1Adapter(client);
    const products = await a.listProducts();
    expect(products).toHaveLength(1);
    expect(products[0]['version-name']).toBe('6.16.03.00');
  });

  it('listCurrentUserGrants reads /users/grants (present on RobotWare 6)', async () => {
    const { client } = makeFake((_m, url) => url.startsWith('/users/grants')
      ? { status: 200, body: JSON.stringify({ _embedded: { _state: [
        { _type: 'user-grant', _title: 'UAS_FULL_ACCESS' },
        { _type: 'user-grant', _title: 'UAS_BACKUP' },
      ] } }) }
      : undefined);
    const a = new RWS1Adapter(client);
    expect(await a.listCurrentUserGrants()).toEqual(['UAS_FULL_ACCESS', 'UAS_BACKUP']);
  });
});

// ─── Jog / IK / FK route through the SHARED session (no per-call session leak) ──
// Before the fix these went through a private digestPost that opened a fresh raw
// connection and minted a new controller session every call. They now go through
// this.client.request (the shared HttpSession that reuses the cookie), which is
// exactly what these fakes record.

const CREDS = { host: '127.0.0.1', port: 80, username: 'Default User', password: 'robotics' };

describe('RWS1Adapter jog', () => {
  it('POSTs the jog form through the shared client, not a fresh connection', async () => {
    const { calls, client } = makeFake();  // default 204
    const adapter = new RWS1Adapter(client, CREDS);
    await adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 50, mechunit: 'ROB_1' });

    // Exactly one POST, through client.request, carrying json=1 and the jog fields.
    const post = calls.find(c => c.what.startsWith('POST'));
    expect(post).toBeTruthy();
    expect(post!.what).toContain('json=1');
    expect(post!.body).toContain('jogmode=Joint');
    expect(post!.body).toContain('mechunit=ROB_1');
    expect(post!.body).toContain('cjogspeed=50');
    expect(post!.body).toMatch(/ccount=\d+/);
  });

  it('increments ccount across calls (controller rejects duplicates)', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client, CREDS);
    await adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 });
    await adapter.jog({ mode: 'Joint', axes: [0, 1, 0, 0, 0, 0], speed: 10 });
    const counts = calls.filter(c => c.what.startsWith('POST'))
      .map(c => Number(/ccount=(\d+)/.exec(c.body ?? '')?.[1]));
    expect(counts).toHaveLength(2);
    expect(counts[1]).toBe(counts[0] + 1);
  });

  it('surfaces an error status carried in a 200 body', async () => {
    const { client } = makeFake(() => ({ status: 200, body: JSON.stringify({ _embedded: { status: { msg: 'jog failed: guard stop' } } }) }));
    const adapter = new RWS1Adapter(client, CREDS);
    await expect(adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 }))
      .rejects.toThrow(/jog failed/i);
  });

  it('throws INVALID_ARGUMENT without credentials', async () => {
    const { client } = makeFake();
    const adapter = new RWS1Adapter(client);   // no creds
    await expect(adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 }))
      .rejects.toThrow(/credentials/i);
  });
});

describe('RWS1Adapter ctrl gap-closer (vttimeslice on RWS 1.0)', () => {
  it('getVirtualTimeTimeslice reads VTTimeslice from /ctrl/virtualtime/vttimeslice', async () => {
    const { calls, client } = makeFake((_m, url) => url.startsWith('/ctrl/virtualtime/vttimeslice')
      ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'ctrl-vttimeslice', VTTimeslice: '42' }] } }) }
      : undefined);
    const adapter = new RWS1Adapter(client);
    expect(await adapter.getVirtualTimeTimeslice()).toBe(42);
    expect(calls.some(c => c.what.startsWith('GET /ctrl/virtualtime/vttimeslice'))).toBe(true);
  });

  it('compressPath POSTs ?action=comp with /fileservice/-prefixed paths', async () => {
    const { calls, client } = makeFake();  // 204
    const adapter = new RWS1Adapter(client);
    await adapter.compressPath('$TEMP/a.txt', '$TEMP/a.rzo');
    const post = calls.find(c => c.what.startsWith('POST /ctrl/compress'));
    expect(post).toBeTruthy();
    expect(post!.what).toContain('action=comp');
    // bare $TEMP paths are normalized to the /fileservice/ form the endpoint requires
    expect(decodeURIComponent(post!.body ?? '')).toContain('srcpath=/fileservice/$TEMP/a.txt');
    expect(decodeURIComponent(post!.body ?? '')).toContain('dstpath=/fileservice/$TEMP/a.rzo');
  });

  it('decompressPath reuses /ctrl/compress with ?action=dcomp (no separate endpoint)', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.decompressPath('/fileservice/$TEMP/a.rzo', '$TEMP/');
    const post = calls.find(c => c.what.startsWith('POST /ctrl/compress'));
    expect(post).toBeTruthy();
    expect(post!.what).toContain('action=dcomp');
    expect(decodeURIComponent(post!.body ?? '')).toContain('srcpath=/fileservice/$TEMP/a.rzo');
  });
});

describe('RWS1Adapter FK/IK route through the shared client', () => {
  it('calcCartesianFromJoints parses the _state envelope from client.request', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: JSON.stringify({ _embedded: { _state: [
      { x: '100', y: '200', z: '300', q1: '1', q2: '0', q3: '0', q4: '0' },
    ] } }) }));
    const adapter = new RWS1Adapter(client, CREDS);
    const rt = await adapter.calcCartesianFromJoints({ rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 0, rax_6: 0 });
    expect(rt).toEqual({ x: 100, y: 200, z: 300, q1: 1, q2: 0, q3: 0, q4: 0 });
    expect(calls.some(c => c.what.startsWith('POST') && c.what.includes('json=1'))).toBe(true);
  });
});
