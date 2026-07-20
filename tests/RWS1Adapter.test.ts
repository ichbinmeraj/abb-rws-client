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
});
