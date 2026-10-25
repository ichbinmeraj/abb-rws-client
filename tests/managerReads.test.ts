import { describe, it, expect, expectTypeOf } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import type { RwsClient } from '../src/RwsClient.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { ADAPTER_READ_NAMES, type AdapterReads } from '../src/adapterReads.js';
import { ALL_TABLES } from '../src/paths/index.js';

/**
 * RobotManager.read(name, ...args): one generic read path to the reads that
 * were live on the adapters but had no manager method (the event-log
 * message reads and domain list, the RobotWare 8 control-station reads, the
 * logged-in user's grants, a return code with its severity), and
 * appealWriteAccessRelease, a write with a method of its own. The answers
 * below are ABB's documented examples: RobotWare 8 Control Station Service
 * (RWS site, Rev C), RWS 1.0 Rev M "Get User grants" and "Get a list of
 * RobotWare return codes".
 */

const XHTML = 'application/xhtml+xml;v=2.0';

// ABB's examples, RobotWare 8 Control Station Service (RWS site, Rev C).
const CS_TYPE_XHTML = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://localhost:443/rw/controlstation/"/></head><body>'
  + '<div class="state"><a href="controlstation" rel="self"/><ul><li class="controlstation-type" title="type"><span class="control-station-type">none</span></li></ul></div></body></html>';
const CS_LOCAL_XHTML = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://localhost:443/rw/controlstation/"/></head><body>'
  + '<div class="state"><a href="controlstation" rel="self"/><ul><li class="controlstation-local-connected" title="local-connected"><span class="control-station-local-isconnected">false</span></li></ul></div></body></html>';

interface Recorded { method: string; url: string; body: string }

async function startServer(routes: Record<string, string>): Promise<{ server: http.Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      const canned = routes[`${req.method} ${req.url}`];
      if (canned === undefined) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': XHTML });
      res.end(canned);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A manager whose session is up on `adapter`. */
function connected(adapter: IRWSAdapter): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: IRWSAdapter; _state: { connected: boolean }; sessionEpoch: number | null; connectEpoch: number };
  m.adapter = adapter;
  m._state.connected = true;
  m.sessionEpoch = m.connectEpoch;
  return mgr;
}

interface Call { what: string; body?: string }

function rws1Fake(respond: (url: string) => { status: number; body: string } | undefined): { calls: Call[]; client: RwsClient } {
  const calls: Call[] = [];
  const fake = {
    requestMastership: async () => {},
    releaseMastership: async () => {},
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return respond(url) ?? { status: 204, body: '' };
    },
  };
  return { calls, client: fake as unknown as RwsClient };
}

describe('the reads RobotManager.read takes', () => {
  it('are the adapters\' own methods, with the signatures AdapterReads gives them', () => {
    // A signature that drifts from AdapterReads fails the compile here.
    expectTypeOf<Pick<RwsClient2, keyof AdapterReads>>().toMatchTypeOf<AdapterReads>();
    type Both = 'getEventLogMessage' | 'listEventLogDomains' | 'listCurrentUserGrants' | 'describeReturnCode' | 'getBuildErrors';
    expectTypeOf<Pick<RWS1Adapter, Both>>().toMatchTypeOf<Pick<AdapterReads, Both>>();
    const c2 = new RwsClient2('https://127.0.0.1:5466', 'u', 'p') as unknown as Record<string, unknown>;
    for (const name of ADAPTER_READ_NAMES) { expect(typeof c2[name], name).toBe('function'); }
  });

  it('RWS 1.0 has the four both generations serve, and none of the RWS 2.0 only ones', () => {
    const { client } = rws1Fake(() => undefined);
    const a1 = new RWS1Adapter(client) as unknown as Record<string, unknown>;
    expect(ADAPTER_READ_NAMES.filter(n => typeof a1[n] === 'function')).toEqual([
      'getEventLogMessage', 'listEventLogDomains', 'listCurrentUserGrants', 'describeReturnCode', 'getBuildErrors',
    ]);
  });

  it('every one is a GET in the path tables (reads only), except the return-code dictionary, which has no row', () => {
    const rows: Record<string, { rws1?: { method: string }; rws2?: { method: string } } | undefined> = {
      getEventLogMessage: ALL_TABLES.cfgElogDipc.getEventLogMessage,
      getEventLogMessageBySeqnum: ALL_TABLES.cfgElogDipc.getEventLogMessageBySeqnum,
      listEventLogDomains: ALL_TABLES.cfgElogDipc.listEventLogDomains,
      getControlStationType: ALL_TABLES.systemMastership.getControlStationType,
      getControlStationId: ALL_TABLES.systemMastership.getControlStationId,
      isLocalControlStationConnected: ALL_TABLES.systemMastership.isLocalControlStationConnected,
      getTpuSafetyProtocolStatus: ALL_TABLES.systemMastership.getTpuSafetyProtocolStatus,
      getWriteAccessAppealChangeCount: ALL_TABLES.systemMastership.getWriteAccessAppealChangeCount,
      listCurrentUserGrants: ALL_TABLES.usersUas.listCurrentUserGrants,
      checkGrantExists: ALL_TABLES.usersUas.checkGrantExists,
      getBuildErrors: ALL_TABLES.rapid.getBuildErrors,
      getExecutionErrorState: ALL_TABLES.rapid.getExecutionErrorState,
    };
    for (const name of ADAPTER_READ_NAMES) {
      if (name === 'describeReturnCode') { continue; }
      const op = rows[name];
      expect(op, name).toBeDefined();
      for (const side of [op?.rws1, op?.rws2]) { if (side) { expect(side.method, name).toBe('GET'); } }
    }
  });
});

describe('RobotManager.read on RWS 2.0', () => {
  it('runs the adapter\'s read and passes its answer through (ABB\'s examples)', async () => {
    const { server, url, requests } = await startServer({
      'GET /rw/controlstation/type': CS_TYPE_XHTML,
      'GET /rw/controlstation/local/isconnected': CS_LOCAL_XHTML,
    });
    try {
      const mgr = connected(new RWS2Adapter(url, 'Default User', 'robotics'));
      await expect(mgr.read('getControlStationType')).resolves.toBe('none');
      await expect(mgr.read('isLocalControlStationConnected')).resolves.toBe(false);
      // The first GET asks for hal+json and is sent once more for XHTML, the
      // client's own negotiation; the paths are what matter here.
      expect([...new Set(requests.map(r => `${r.method} ${r.url}`))]).toEqual([
        'GET /rw/controlstation/type',
        'GET /rw/controlstation/local/isconnected',
      ]);
    } finally { server.close(); }
  });

  it('passes the arguments as given', async () => {
    const { server, url, requests } = await startServer({});
    try {
      const mgr = connected(new RWS2Adapter(url, 'Default User', 'robotics'));
      await mgr.read('getEventLogMessage', 0, 5, 'de');
      await mgr.read('getEventLogMessageBySeqnum', 1234);
      await mgr.read('checkGrantExists', 'UAS_RAPID_EXECUTE').catch(() => undefined);
      expect(requests.map(r => r.url)).toEqual([
        '/rw/elog/0/5?lang=de',
        '/rw/elog/seqnum/1234?lang=en',
        '/users/grant-exists?grant=UAS_RAPID_EXECUTE',
      ]);
    } finally { server.close(); }
  });

  it('appealWriteAccessRelease posts ABB\'s appeal with no body', async () => {
    const { server, url, requests } = await startServer({});
    try {
      await connected(new RWS2Adapter(url, 'Default User', 'robotics')).appealWriteAccessRelease();
      expect(requests).toEqual([{ method: 'POST', url: '/rw/controlstation/writeaccess/release/appeal', body: '' }]);
      expect(ALL_TABLES.systemMastership.appealWriteAccessRelease.rws2?.path).toBe('/rw/controlstation/writeaccess/release/appeal');
    } finally { server.close(); }
  });
});

describe('RobotManager.read on RWS 1.0', () => {
  // ABB's examples (Rev M), in the controller's ?json=1 form.
  const GRANTS_JSON = JSON.stringify({ _embedded: { _state: [
    { _type: 'user-grant', _title: 'UAS_BACKUP' }, { _type: 'user-grant', _title: 'UAS_RAPID_EXECUTE' },
  ] } });
  const RETCODE_JSON = JSON.stringify({ _embedded: { _state: [
    { _type: 'err-desc-li', _title: '-1073445883', name: 'SYS_CTRL_E_ACTIVE_SYSTEM', code: '-1073445883', severity: 'Error', description: 'Operation not allowed on active system.' },
  ] } });

  it('the user\'s grants and a return code with its severity', async () => {
    const { calls, client } = rws1Fake(url => {
      if (url.startsWith('/users/grants')) { return { status: 200, body: GRANTS_JSON }; }
      if (url.startsWith('/rw/retcode')) { return { status: 200, body: RETCODE_JSON }; }
      return undefined;
    });
    const mgr = connected(new RWS1Adapter(client));
    await expect(mgr.read('listCurrentUserGrants')).resolves.toEqual(['UAS_BACKUP', 'UAS_RAPID_EXECUTE']);
    await expect(mgr.read('describeReturnCode', -1073445883)).resolves.toEqual({
      code: -1073445883, name: 'SYS_CTRL_E_ACTIVE_SYSTEM', severity: 'Error', description: 'Operation not allowed on active system.',
    });
    expect(calls.map(c => c.what)).toEqual(['GET /users/grants?json=1', 'GET /rw/retcode?code=-1073445883&json=1']);
  });

  it('a read RWS 1.0 does not have is UNSUPPORTED_OPERATION, nothing sent', async () => {
    const { calls, client } = rws1Fake(() => undefined);
    const mgr = connected(new RWS1Adapter(client));
    for (const name of ['getControlStationType', 'getEventLogMessageBySeqnum', 'checkGrantExists'] as const) {
      await expect((mgr.read as (n: string, ...a: unknown[]) => Promise<unknown>)(name, 1)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    }
    await expect(mgr.appealWriteAccessRelease()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(calls).toEqual([]);
  });
});

describe('RobotManager.read refusals before sending', () => {
  it('a name that is not one of the reads: INVALID_ARGUMENT, even for a write the adapter has', async () => {
    const { calls, client } = rws1Fake(() => undefined);
    const mgr = connected(new RWS1Adapter(client));
    const loose = mgr.read as (n: string) => Promise<unknown>;
    for (const name of ['startRapid', 'setRapidVariable', 'constructor', '']) {
      await expect(loose.call(mgr, name)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toEqual([]);
  });

  it('not connected, or a teardown begun: NOT_CONNECTED', async () => {
    await expect(new RobotManager().read('listCurrentUserGrants')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    const { client } = rws1Fake(() => undefined);
    const mgr = connected(new RWS1Adapter(client));
    (mgr as unknown as { connectEpoch: number }).connectEpoch += 1;
    await expect(mgr.read('listCurrentUserGrants')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(new RobotManager().appealWriteAccessRelease()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
