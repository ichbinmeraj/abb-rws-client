import { describe, it, expect } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsClient } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';

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

  it('refuses an invalid signal name with INVALID_ARGUMENT, as the RWS 2.0 adapter does', async () => {
    // Through the real client: the check runs before anything is sent, so the
    // unreachable port is never contacted.
    const client = new RwsClient({ host: '127.0.0.1', port: 1, username: 'u', password: 'p', timeout: 500 });
    const adapter = new RWS1Adapter(client);
    await expect(
      adapter.subscribe([{ type: 'signal', name: 'di_1&resources=2&2=/rw/panel/ctrlstate' }], () => {}),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
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
  // GET /rw/motionsystem?json=1 as RW 6.16 answers it (live 2026-09-27),
  // with the change count and the unit selected for jogging.
  const motionSystem = (count: string | undefined, unit = 'ROB_1'): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({ _embedded: { _state: [
      { _type: 'ms', _title: 'motionsystem', ...(count === undefined ? {} : { 'change-count': count }), 'mechunit-name': unit, 'poll-rate': '60' },
      { _type: 'ms-change-count-li', _title: 'change-count' },
    ] } }),
  });
  const withCount = (count: string | undefined, unit?: string, post?: () => { status: number; body: string }) =>
    (method: string, url: string) => (method === 'GET' && url === '/rw/motionsystem?json=1'
      ? motionSystem(count, unit)
      : method === 'POST' ? post?.() : undefined);

  it('reads the change count, then POSTs exactly the jog form\'s fields through the shared client', async () => {
    const { calls, client } = makeFake(withCount('7'));
    const adapter = new RWS1Adapter(client, CREDS);
    await adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, -2], speed: 50, mechunit: 'ROB_1' });

    expect(calls.map(c => c.what)).toEqual(['GET /rw/motionsystem?json=1', 'POST /rw/motionsystem?action=jog&json=1']);
    // ABB's jog form: axis1..axis6, ccount, inc-mode. No jogmode, mechunit or cjogspeed.
    expect(calls[1].body).toBe('axis1=1&axis2=0&axis3=0&axis4=0&axis5=0&axis6=-2&ccount=7&inc-mode=Small');
  });

  it('sends the controller\'s change count on every jog, not a private counter', async () => {
    const { calls, client } = makeFake(withCount('0'));
    const adapter = new RWS1Adapter(client, CREDS);
    await adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 });
    await adapter.jog({ mode: 'Joint', axes: [0, 1, 0, 0, 0, 0], speed: 10 });
    const counts = calls.filter(c => c.what.startsWith('POST'))
      .map(c => /ccount=(\d+)/.exec(c.body ?? '')?.[1]);
    expect(counts).toEqual(['0', '0']);
    expect(calls.filter(c => c.what.startsWith('GET /rw/motionsystem'))).toHaveLength(2);
  });

  it('sends the increment asked for as inc-mode', async () => {
    const { calls, client } = makeFake(withCount('3'));
    const adapter = new RWS1Adapter(client, CREDS);
    await adapter.jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, incMode: 'Large' });
    expect(calls.at(-1)!.body).toContain('&inc-mode=Large');
  });

  it('sends nothing when the change count cannot be read (PARSE_ERROR, never a guessed count)', async () => {
    const { calls, client } = makeFake(withCount(undefined));
    const adapter = new RWS1Adapter(client, CREDS);
    await expect(adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10 }))
      .rejects.toMatchObject({ code: 'PARSE_ERROR' });
    expect(calls.some(c => c.what.startsWith('POST'))).toBe(false);
  });

  it('selects a named unit the controller does not have selected, reads again, then jogs with the new count', async () => {
    // The controller selects the unit the set-mechunit form names; the change
    // count after it is illustrative (whether a selection moves it is not observed).
    let unit = 'ROB_1';
    let count = '0';
    const { calls, client } = makeFake((method, url) => {
      if (method === 'GET' && url === '/rw/motionsystem?json=1') { return motionSystem(count, unit); }
      if (method === 'POST' && url === '/rw/motionsystem?action=set-mechunit&json=1') { unit = 'STN_1'; count = '1'; }
      return undefined;
    });
    const adapter = new RWS1Adapter(client, CREDS);
    await adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10, mechunit: 'STN_1' });
    expect(calls.filter(c => !c.what.startsWith('mastership-')).map(c => c.what)).toEqual([
      'GET /rw/motionsystem?json=1',
      'POST /rw/motionsystem?action=set-mechunit&json=1',
      'GET /rw/motionsystem?json=1',
      'POST /rw/motionsystem?action=jog&json=1',
    ]);
    expect(calls.find(c => c.what.includes('set-mechunit'))!.body).toBe('mechunit-name=STN_1');
    expect(calls.at(-1)!.body).toBe('axis1=1&axis2=0&axis3=0&axis4=0&axis5=0&axis6=0&ccount=1&inc-mode=Small');
  });

  it('sends no jog when the controller still names another unit after the selection', async () => {
    const { calls, client } = makeFake(withCount('0', 'ROB_1'));
    const adapter = new RWS1Adapter(client, CREDS);
    const err = await adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10, mechunit: 'ROB_2' })
      .then(() => null, (e: unknown) => e as RwsError);
    expect(err).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(err!.message).toContain("'ROB_1' would move, not 'ROB_2'");
    expect(calls.some(c => c.what.includes('action=jog'))).toBe(false);
  });

  it('a unit already selected is not selected again', async () => {
    const { calls, client } = makeFake(withCount('0', 'ROB_1'));
    await new RWS1Adapter(client, CREDS).jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10, mechunit: 'ROB_1' });
    expect(calls.some(c => c.what.includes('set-mechunit'))).toBe(false);
  });

  it('refuses an empty or spaced unit name before any request', async () => {
    const { calls, client } = makeFake(withCount('0'));
    const adapter = new RWS1Adapter(client, CREDS);
    for (const mechunit of ['', 'ROB 1']) {
      await expect(adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10, mechunit }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses bad axes or an unknown increment before any request', async () => {
    const { calls, client } = makeFake(withCount('0'));
    const adapter = new RWS1Adapter(client, CREDS);
    await expect(adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0] as never, speed: 10 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(adapter.jog({ mode: 'Joint', axes: [Number.NaN, 0, 0, 0, 0, 0], speed: 10 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(adapter.jog({ mode: 'Joint', axes: [1, 0, 0, 0, 0, 0], speed: 10, incMode: 'Huge' as never }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(0);
  });

  it('surfaces an error status carried in a 200 body', async () => {
    const { client } = makeFake(withCount('0', 'ROB_1',
      () => ({ status: 200, body: JSON.stringify({ _embedded: { status: { msg: 'jog failed: guard stop' } } }) })));
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

describe('RWS1Adapter category-1 forms (web-doc discovered, RWS 1.0)', () => {
  it('getModuleText uses ?resource=module-text&task= and decodes the module-text span', async () => {
    const { calls, client } = makeFake((_m, url) => url.includes('resource=module-text')
      ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'rap-module-text', 'change-count': 42, 'module-text': 'MODULE%20m%0aENDMODULE' }] } }) }
      : undefined);
    const a = new RWS1Adapter(client);
    const r = await a.getModuleText('T_ROB1', 'm');
    expect(r).toEqual({ text: 'MODULE m\nENDMODULE', changeCount: 42 });
    expect(calls.some(c => c.what.includes('/rw/rapid/modules/m?resource=module-text&task=T_ROB1'))).toBe(true);
  });

  it('checkMotionChangeCount passes ?changecount= and maps changestate TRUE to true', async () => {
    const { calls, client } = makeFake((_m, url) => url.includes('checkchangecount')
      ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'checkchengecount', changestate: 'TRUE' }] } }) }
      : undefined);
    const a = new RWS1Adapter(client);
    expect(await a.checkMotionChangeCount(7)).toBe(true);
    expect(calls.some(c => c.what.includes('/rw/motionsystem/checkchangecount?changecount=7'))).toBe(true);
  });

  it('setPanelLanguage / setControllerLanguage use the RWS 1.0 query-actions with the right fields', async () => {
    const { calls, client } = makeFake();  // 204
    const a = new RWS1Adapter(client);
    await a.setPanelLanguage('de');
    await a.setControllerLanguage('sv');
    const panel = calls.find(c => c.what.includes('/rw/panel?action=setlang'));
    const ctrl = calls.find(c => c.what.includes('/ctrl?action=set-lang'));
    expect(panel?.body).toBe('lang-code=de');
    expect(ctrl?.body).toBe('lang=sv');
  });

  it('searchIoDevices POSTs ?action=search (name/lstate) and parses ios-device-li', async () => {
    const { calls, client } = makeFake((_m, url) => url.includes('devices?action=search')
      ? { status: 200, body: '<html><body><ul><li class="ios-device-li" title="Local/DRV_1">' +
          '<span class="name">DRV_1</span><span class="lstate">enabled</span><span class="pstate">running</span><span class="address">2</span></li></ul></body></html>' }
      : undefined);
    const a = new RWS1Adapter(client);
    const devs = await a.searchIoDevices({ lstate: 'enabled' });
    expect(devs.map(d => d.name)).toContain('DRV_1');
    expect(devs[0].lstate).toBe('enabled');
    expect(calls.find(c => c.what.startsWith('POST'))?.body).toBe('lstate=enabled');
  });

  it('searchIoDevices rejects an empty query (name or lstate required)', async () => {
    const { client } = makeFake();
    const a = new RWS1Adapter(client);
    await expect(a.searchIoDevices({})).rejects.toThrow(/name or lstate/i);
  });

  it('validateCfgFile / validateInstanceBeforeDelete use the RWS 1.0 collection query-actions', async () => {
    const { calls, client } = makeFake();  // 204
    const a = new RWS1Adapter(client);
    await a.validateCfgFile('$TEMP/x.cfg', 'add-with-reset');
    await a.validateInstanceBeforeDelete('MyInst');
    const val = calls.find(c => c.what.includes('/rw/cfg?action=validate&'));
    const del = calls.find(c => c.what.includes('/rw/cfg?action=validate-inst-at-del'));
    expect(decodeURIComponent(val?.body ?? '')).toContain('filepath=$TEMP/x.cfg');
    expect(val?.body).toContain('action-type=add-with-reset');
    expect(del?.body).toBe('name=MyInst');
  });
});

describe('RWS1Adapter RMMP poll/cancel (RWS 1.0)', () => {
  it('pollRmmp GETs /users/rmmp/poll and returns the status', async () => {
    const { calls, client } = makeFake((_m, url) => url.startsWith('/users/rmmp/poll')
      ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'user-rmmp-poll', code: '0', status: 'GRANTED' }] } }) }
      : undefined);
    const adapter = new RWS1Adapter(client);
    expect(await adapter.pollRmmp()).toBe('GRANTED');
    expect(calls.some(c => c.what.startsWith('GET /users/rmmp/poll'))).toBe(true);
  });

  it('cancelRmmp POSTs the query-action /users/rmmp?action=cancel', async () => {
    const { calls, client } = makeFake();  // 204
    const adapter = new RWS1Adapter(client);
    await adapter.cancelRmmp();
    expect(calls.some(c => c.what.startsWith('POST /users/rmmp?action=cancel'))).toBe(true);
  });

  const rmmpState = (privilege: string, heldByMe: string) => (_m: string, url: string) => (url.startsWith('/users/rmmp?json=1')
    ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'user-rmmp', privilege, rmmpheldbyme: heldByMe }] } }) }
    : undefined);

  it('getRmmpPrivilege reads ABB\'s four states, lower-case, and none for a privilege held by another user', async () => {
    const read = (privilege: string, heldByMe: string) => new RWS1Adapter(makeFake(rmmpState(privilege, heldByMe)).client).getRmmpPrivilege();
    expect(await read('None', 'FALSE')).toBe('none');
    expect(await read('pending modify', 'TRUE')).toBe('pending modify');
    expect(await read('modify', 'TRUE')).toBe('modify');
    expect(await read('exec', 'TRUE')).toBe('exec');
    expect(await read('modify', 'FALSE')).toBe('none');
  });

  it('getRmmpPrivilege throws a failed read instead of reporting none', async () => {
    const { client } = makeFake((_m, url) => url.startsWith('/users/rmmp')
      ? { status: 503, body: '' }
      : undefined);
    await expect(new RWS1Adapter(client).getRmmpPrivilege()).rejects.toBeInstanceOf(RwsError);
  });

  it('requestRmmp sends ABB\'s values: modify, exec, and exec for the deprecated exclusive', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.requestRmmp();
    await adapter.requestRmmp('exec');
    await adapter.requestRmmp('exclusive');
    expect(calls.map(c => c.body)).toEqual(['privilege=modify', 'privilege=exec', 'privilege=exec']);
  });

  it('requestRmmp refuses an undocumented level before sending', async () => {
    const { calls, client } = makeFake();
    await expect(new RWS1Adapter(client).requestRmmp('all' as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(0);
  });
});

describe('RWS1Adapter 2026-08-11 sweep wire-forms (RWS 1.0 side)', () => {
  const signalsXhtml = '<html><body><ul>'
    + '<li class="ios-signal-li" title="n/d/sigA"><span class="name">sigA</span>'
    + '<span class="type">DI</span><span class="lvalue">1</span></li></ul></body></html>';

  it('searchSignalsEx builds the suffixed criteria body and POSTs ?action=signal-searchex (raw, no json=1)', async () => {
    const { calls, client } = makeFake((m, url) =>
      m === 'POST' && url.includes('signal-searchex') ? { status: 200, body: signalsXhtml } : undefined);
    const a = new RWS1Adapter(client);
    const out = await a.searchSignalsEx([{ type: 'DI', device: 'd1' }, { type: 'DO', categoryPon: 'x', blocked: false }]);
    const post = calls.find(c => c.what.startsWith('POST') && c.what.includes('signal-searchex'));
    expect(post).toBeTruthy();
    // First set unsuffixed, second set carries the '2' suffix; categoryPon -> category-pon.
    expect(post!.body).toBe('device=d1&type=DI&category-pon2=x&type2=DO&blocked2=false');
    // Raw request: it needs the XHTML ios-signal-li list, so it must NOT use the json=1 path.
    expect(post!.what).not.toContain('json=1');
    expect(out.map(s => s.name)).toContain('sigA');
  });

  it('searchSignalsEx rejects 0 or >2 criteria sets with INVALID_ARGUMENT', async () => {
    const { client } = makeFake();
    const a = new RWS1Adapter(client);
    await expect(a.searchSignalsEx([])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(a.searchSignalsEx([{ type: 'DI' }, { type: 'DO' }, { type: 'AI' }]))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('getModuleTextRange passes startrow/startcol/endrow/endcol query params and URL-decodes the span', async () => {
    const { calls, client } = makeFake((_m, url) => url.includes('/rw/rapid/modules/BASE') && url.includes('startrow=1')
      ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'rap-module-text', 'module-text': 'MODULE%20BASE' }] } }) }
      : undefined);
    const a = new RWS1Adapter(client);
    expect(await a.getModuleTextRange('T_ROB1', 'BASE', 1, 1, 2, 1)).toBe('MODULE BASE');
    const get = calls.find(c => c.what.includes('/rw/rapid/modules/BASE'));
    expect(get!.what).toContain('task=T_ROB1');
    expect(get!.what).toContain('startrow=1');
    expect(get!.what).toContain('endcol=1');
  });

  it('saveEventLogRaw POSTs ?action=saveraw with the destination normalised to a /fileservice/ URI', async () => {
    const { calls, client } = makeFake();  // 204
    const a = new RWS1Adapter(client);
    await a.saveEventLogRaw('HOME/elog.txt');
    const post = calls.find(c => c.what.includes('saveraw'));
    expect(post).toBeTruthy();
    // Bare volume paths are rejected by the endpoint; fsPath prepends /fileservice/.
    expect(decodeURIComponent(post!.body ?? '')).toBe('path=/fileservice/HOME/elog.txt');
  });
});

// ─── Kinematics (RW 6.16.03, live-verified 2026-09-30) ──────────────────────
//
// The controller works in SI units: metres and radians in and out. The
// answers below are rebuilt in the RWS 1.0 `?json=1` envelope from the fields
// and values recorded live on a RW 6.16.03 virtual controller, for joints
// 0, 0, 0, 0, 30, 0 degrees and the matching pose (806.2917, 0, 929 mm;
// q 0.5, 0, 0.8660254, 0). The 400 out-of-reach body is recorded up to its
// status block; its empty `_state` tail is rebuilt as in the other RWS 1.0
// error answers.

const EXT_ABSENT = Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [`extjoint${i}`, '8.999999e+09']));
const json1 = (state: Record<string, string>): string => JSON.stringify({
  _links: { base: { href: 'http://127.0.0.1:4578/rw/motionsystem/' } },
  _embedded: { _state: [state] },
});
const FK_ANSWER = json1({
  _type: 'position-from-joint',
  'position-x': '0.8062917', 'position-y': '0', 'position-z': '0.929',
  'robtarget-orientation-u0': '0.5', 'robtarget-orientation-u1': '0',
  'robtarget-orientation-u2': '0.8660254', 'robtarget-orientation-u3': '0',
  ...EXT_ABSENT,
});
const IK_ANSWER = json1({
  _type: 'all-joint-solutions',
  robotjoint1: '0', robotjoint2: '4.19e-08', robotjoint3: '-9.02e-08',
  robotjoint4: '0', robotjoint5: '0.5235988', robotjoint6: '0',
  ...EXT_ABSENT,
});
const IK_OUT_OF_REACH = String.raw`{"_links":{"base": { "href": "http://127.0.0.1:4578/" }},"_embedded" :{ "status" : {"code":-1073436654, "msg": "C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rws_motionsystem\\rws_resource_motionsystem.cpp[5679] Position outside of reach code:-1073436654 icode:-1"}, "_state":[  ] }}`;

const JOINTS_30 = { rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 30, rax_6: 0 };
const POSE_30 = { x: 806.2917, y: 0, z: 929, q1: 0.5, q2: 0, q3: 0.8660254, q4: 0 };
const EXT = '[9E9,9E9,9E9,9E9,9E9,9E9]';

describe('RWS1Adapter.calcCartesianFromJoints (forward kinematics)', () => {
  it('POSTs ABB\'s CalcPoseFromJoints on the shared client with the joints in radians and tool0\'s identity frame', async () => {
    const { calls, client } = makeFake((m, url) => m === 'POST' && url.includes('CalcPoseFromJoints') ? { status: 200, body: FK_ANSWER } : undefined);
    const adapter = new RWS1Adapter(client, CREDS);
    await adapter.calcCartesianFromJoints(JOINTS_30);
    const post = calls.find(c => c.what.startsWith('POST'));
    expect(post!.what).toBe('POST /rw/motionsystem/mechunits/ROB_1?action=CalcPoseFromJoints&json=1');
    expect(post!.body).toBe('tool_frame_position=[0,0,0]&tool_frame_orientation=[1,0,0,0]'
      + `&rob_joints=[0,0,0,0,0.523598776,0]&ext_joints=${EXT}&robot_fixed_object=FALSE&elog_at_error=FALSE`);
    // The action the client used to send is unknown to the controller.
    expect(calls.some(c => c.what.includes('CalcRobTFromJoints'))).toBe(false);
  });

  it('reads position-x/y/z in metres as millimetres, and the robtarget orientation', async () => {
    const { client } = makeFake(() => ({ status: 200, body: FK_ANSWER }));
    const pose = await new RWS1Adapter(client, CREDS).calcCartesianFromJoints(JOINTS_30, 'ROB_1', 'tool0', 'wobj0');
    expect(pose.x).toBeCloseTo(806.2917, 6);
    expect(pose.y).toBe(0);
    expect(pose.z).toBeCloseTo(929, 6);
    expect([pose.q1, pose.q2, pose.q3, pose.q4]).toEqual([0.5, 0, 0.8660254, 0]);
  });

  it('rounds the millimetres to 1e-6 so the metre conversion leaves no binary noise', async () => {
    // Position of the answer for joints 10,-10,20,5,40,15 (live-verified
    // 2026-09-30 on RW 6.16.03); unrounded, x and y read 688.9404999999999
    // and 125.17639999999999 mm.
    const body = FK_ANSWER
      .replace('"position-x":"0.8062917"', '"position-x":"0.6889405"')
      .replace('"position-y":"0"', '"position-y":"0.1251764"');
    expect(body).toContain('0.6889405');
    const { client } = makeFake(() => ({ status: 200, body }));
    const pose = await new RWS1Adapter(client, CREDS).calcCartesianFromJoints(JOINTS_30);
    expect(pose.x).toBe(688.9405);
    expect(pose.y).toBe(125.1764);
    expect(pose.z).toBe(929);
  });

  it('also reads ABB\'s RWS 2.0 spelling robtargetorientation-uN', async () => {
    const body = FK_ANSWER.replace(/robtarget-orientation-u/g, 'robtargetorientation-u');
    const { client } = makeFake(() => ({ status: 200, body }));
    const pose = await new RWS1Adapter(client, CREDS).calcCartesianFromJoints(JOINTS_30);
    expect([pose.q1, pose.q2, pose.q3, pose.q4]).toEqual([0.5, 0, 0.8660254, 0]);
  });

  it('refuses a tool or work object other than tool0/wobj0 with INVALID_ARGUMENT before sending', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: FK_ANSWER }));
    const adapter = new RWS1Adapter(client, CREDS);
    await expect(adapter.calcCartesianFromJoints(JOINTS_30, 'ROB_1', 'tGripper', 'wobj0')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(adapter.calcCartesianFromJoints(JOINTS_30, 'ROB_1', 'tool0', 'wobjTable')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
    // RAPID names are case-insensitive.
    await expect(adapter.calcCartesianFromJoints(JOINTS_30, 'ROB_1', 'TOOL0', 'WObj0')).resolves.toBeTruthy();
  });

  it('an answer without the position fields is PARSE_ERROR, not a pose of NaN', async () => {
    // The shape the client used to expect (x/y/z/q1..q4); no controller sends it.
    const { client } = makeFake(() => ({ status: 200, body: json1({ x: '100', y: '200', z: '300', q1: '1', q2: '0', q3: '0', q4: '0' }) }));
    await expect(new RWS1Adapter(client, CREDS).calcCartesianFromJoints(JOINTS_30)).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });
});

describe('RWS1Adapter.calcJointsFromCartesian (inverse kinematics)', () => {
  it('sends the position in metres and the seed in radians, without the wobj_frame_* fields', async () => {
    const { calls, client } = makeFake((m, url) => m === 'POST' && url.includes('CalcJointsFromPose') ? { status: 200, body: IK_ANSWER } : undefined);
    await new RWS1Adapter(client, CREDS).calcJointsFromCartesian(POSE_30, JOINTS_30);
    const post = calls.find(c => c.what.startsWith('POST'));
    expect(post!.what).toBe('POST /rw/motionsystem/mechunits/ROB_1?action=CalcJointsFromPose&json=1');
    expect(post!.body).toBe(`curr_position=[0.8062917,0,0.929]&curr_orientation=[0.5,0,0.8660254,0]&curr_ext_joints=${EXT}`
      + `&old_rob_joints=[0,0,0,0,0.523598776,0]&old_ext_joints=${EXT}&robot_fixed_object=FALSE`
      + '&tool_frame_position=[0,0,0]&tool_frame_orientation=[1,0,0,0]&robot_configuration=[0,0,0,0]&elog_at_error=FALSE');
  });

  it('never writes a number in exponent form (values as read in the functional run)', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: IK_ANSWER }));
    await new RWS1Adapter(client, CREDS).calcJointsFromCartesian(
      { x: 806.2917, y: 0, z: 928.9999, q1: 0.5, q2: 4.601669e-8, q3: 0.8660254, q4: 2.656775e-8 },
      { rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 30.0000019073486, rax_6: 0.00000608888012720854 });
    const body = calls.find(c => c.what.startsWith('POST'))!.body!;
    expect(body).toContain('curr_position=[0.8062917,0,0.9289999]');
    expect(body).toContain('curr_orientation=[0.5,0.000000046,0.8660254,0.000000027]');
    expect(body).toContain('old_rob_joints=[0,0,0,0,0.523598809,0.000000106]');
    expect(body.replace(/9E9/g, '')).not.toMatch(/\de[-+]?\d/i);
  });

  it('with no seed sends zero seed joints', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: IK_ANSWER }));
    await new RWS1Adapter(client, CREDS).calcJointsFromCartesian(POSE_30);
    expect(calls.find(c => c.what.startsWith('POST'))!.body).toContain('old_rob_joints=[0,0,0,0,0,0]');
  });

  it('reads robotjoint1..6 in radians as degrees', async () => {
    const { client } = makeFake(() => ({ status: 200, body: IK_ANSWER }));
    const j = await new RWS1Adapter(client, CREDS).calcJointsFromCartesian(POSE_30, JOINTS_30);
    const got = [j.rax_1, j.rax_2, j.rax_3, j.rax_4, j.rax_5, j.rax_6];
    [0, 0, 0, 0, 30, 0].forEach((deg, i) => expect(got[i]).toBeCloseTo(deg, 4));
  });

  it('rounds the degrees to 1e-6 so the radian conversion leaves no binary noise', async () => {
    const { client } = makeFake(() => ({ status: 200, body: IK_ANSWER }));
    const j = await new RWS1Adapter(client, CREDS).calcJointsFromCartesian(POSE_30, JOINTS_30);
    // 0.5235988 rad is 30.0000014 degrees; 4.19e-08 rad is 2.4e-06 degrees.
    expect(j.rax_5).toBe(30.000001);
    expect(j.rax_2).toBe(0.000002);
    expect(j.rax_3).toBe(-0.000005);
    expect(Object.is(j.rax_1, -0)).toBe(false);
  });

  it('an answer without robotjoint1..6 is PARSE_ERROR, not joints of NaN', async () => {
    // The shape the client used to expect (rax_1..rax_6); no controller sends it.
    const { client } = makeFake(() => ({ status: 200, body: json1({ rax_1: '0', rax_2: '0', rax_3: '0', rax_4: '0', rax_5: '30', rax_6: '0' }) }));
    await expect(new RWS1Adapter(client, CREDS).calcJointsFromCartesian(POSE_30, JOINTS_30)).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('a pose out of reach (the recorded 400 -1073436654) is INVALID_ARGUMENT with an invalid-argument refusal', async () => {
    const { client } = makeFake(() => ({ status: 400, body: IK_OUT_OF_REACH }));
    const err = await new RWS1Adapter(client, CREDS)
      .calcJointsFromCartesian({ ...POSE_30, x: POSE_30.x + 5000 }, JOINTS_30).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({
      code: 'INVALID_ARGUMENT', httpStatus: 400, controllerCode: -1073436654,
      controllerMsg: 'Position outside of reach code:-1073436654 icode:-1',
      refusal: { kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool' },
    });
    const e = err as RwsError;
    expect(e.refusal!.controller).toMatchObject({ name: 'SYS_CTRL_E_POSE_OUTSIDE_REACH', http: 400 });
    expect(e.message).toMatch(/outside the robot's reach/);
    expect(e.message).toContain('HTTP 400 from POST /rw/motionsystem/mechunits/ROB_1');
  });
});

// ─── Jog position target and return codes (spec check 2026-10-07) ──────────

describe('RWS1Adapter setRobtargetForJogging', () => {
  it('posts ?action=positiontarget with the 17 fields of the RW 6.16.03 form', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.setRobtargetForJogging({
      x: 600, y: 0, z: 800, q1: 0.5, q2: 0, q3: 0.866, q4: 0,
      cf1: 0, cf4: -1, cf6: 0, cfx: 1,
      eax: [100, 9e9, 9e9, 9e9, 9e9, 9e9],
    });
    const post = calls.find(c => c.what.startsWith('POST /rw/motionsystem'));
    expect(post?.what).toBe('POST /rw/motionsystem?action=positiontarget&json=1');
    expect(post?.body).toBe(
      'pos-x=600&pos-y=0&pos-z=800&orient-q1=0.5&orient-q2=0&orient-q3=0.866&orient-q4=0'
      + '&config-j1=0&config-j4=-1&config-j6=0&config-jx=1'
      + '&extjoint-1=100&extjoint-2=9000000000&extjoint-3=9000000000&extjoint-4=9000000000&extjoint-5=9000000000&extjoint-6=9000000000');
  });

  it('fills the external joints with 9E9 (no axis) when they are left out, and refuses a target without a configuration', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    await adapter.setRobtargetForJogging({ x: 1, y: 2, z: 3, q1: 1, q2: 0, q3: 0, q4: 0, cf1: 0, cf4: 0, cf6: 0, cfx: 0 });
    expect(calls.find(c => c.what.startsWith('POST /rw/motionsystem'))?.body).toContain('&extjoint-1=9000000000&');
    await expect(adapter.setRobtargetForJogging({ x: 1, y: 2, z: 3, q1: 1, q2: 0, q3: 0, q4: 0 } as never))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls.filter(c => c.what.startsWith('POST /rw/motionsystem'))).toHaveLength(1);
  });
});

describe('RWS1Adapter getReturnCode', () => {
  it('asks for the code only and reads the err-desc name and description', async () => {
    const { calls, client } = makeFake((_m, url) => url.startsWith('/rw/retcode')
      ? { status: 200, body: JSON.stringify({ _embedded: { _state: [{ _type: 'err-desc', _title: 'err', name: 'SYS_CTRL_E_UAS_REJECT', code: '-1073445867', description: 'Not allowed' }] } }) }
      : undefined);
    const adapter = new RWS1Adapter(client);
    expect(await adapter.getReturnCode(-1073445867, 'sv')).toEqual({ code: -1073445867, title: 'SYS_CTRL_E_UAS_REJECT', desc: 'Not allowed' });
    expect(calls.map(c => c.what)).toContain('GET /rw/retcode?code=-1073445867&json=1');
  });
});

// ─── Virtual time (spec check 2026-10-07: controller vocabulary and percent) ─

describe('RWS1Adapter virtual time', () => {
  const vt = (state: string, speed: string) => makeFake((_m, url) => {
    const body = (type: string, fields: Record<string, string>) =>
      JSON.stringify({ _embedded: { _state: [{ _type: type, _title: type, ...fields }] } });
    if (url.startsWith('/ctrl/virtualtime/vttime')) { return { status: 200, body: body('ctrl-vttime', { vtcounter: '123456' }) }; }
    if (url.startsWith('/ctrl/virtualtime/vtstate')) { return { status: 200, body: body('ctrl-vtstate', { vtcurrstate: state }) }; }
    if (url.startsWith('/ctrl/virtualtime/vtspeed')) { return { status: 200, body: body('ctrl-vtspeed', { vtcurrspeed: speed }) }; }
    return undefined;
  });

  it('getVirtualTime reads VTFREERUN as running and the percent as a factor', async () => {
    const adapter = new RWS1Adapter(vt('VTFREERUN', '100').client);
    expect(await adapter.getVirtualTime()).toEqual({ time: 123456, running: true, speed: 1, state: 'VTFREERUN' });
  });

  it('getVirtualTime reads VTSTOP as stopped and -1 as full speed', async () => {
    const adapter = new RWS1Adapter(vt('VTSTOP', '-1').client);
    expect(await adapter.getVirtualTime()).toMatchObject({ running: false, speed: Infinity, state: 'VTSTOP' });
  });

  it('setVirtualTimeScale is refused before sending for any value (the client sends no virtual-time write to RobotWare 6 in this release)', async () => {
    const { calls, client } = makeFake();
    const adapter = new RWS1Adapter(client);
    for (const s of [10, Infinity, 0]) {
      await expect(adapter.setVirtualTimeScale(s)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    }
    expect(calls.filter(c => c.what.startsWith('POST'))).toHaveLength(0);
  });
});
