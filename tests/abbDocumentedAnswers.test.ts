import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { ALL_TABLES, evidenceOf } from '../src/paths/index.js';
import { aliasIoFrom, progressIdFrom } from '../src/commonReads.js';

/**
 * Reads built from ABB's documented answers, where the client read the wrong
 * class or dropped part of the answer:
 *
 * - the activation record is one `rap-stackframe` entry on both generations
 *   (RWS 1.0 Rev M and RWS 2.0 Rev L, "Get Activation Record");
 * - the alias I/O list is one `rap-alias-io` entry per alias, with
 *   `alias-name`, `signal-name` and `type` (both generations, "Get AliasIO
 *   List"); `rap-aliasio-li` is only the link in the /rw/rapid listing;
 * - the RWS 1.0 DNS read answers one `ctrl-netw-dns` entry per setting
 *   (Rev M, "Get DNS Resource");
 * - the RWS 2.0 system-info copy's `file-type` field is optional, and its
 *   answer lists the copied files (Rev L, "Get Installed System Info");
 * - a compress or decompress answers 202 with `Location: /progress/{id}`
 *   (Rev M "Compress/Decompress Resource", Rev L Controller service);
 *   RWS 2.0 `getProgress` reads the job's `progress` entry, or ABB's
 *   `progress-ev` entry when the answer has no `progress` entry.
 *
 * The bodies below are ABB's examples, in the controller's `?json=1` form
 * where the RWS 1.0 adapter asks for JSON.
 */

interface Call { what: string; body?: string }

type FakeAnswer = { status: number; body: string; headers?: Headers };

function makeFake(respond?: (method: string, url: string, body?: string) => FakeAnswer | undefined): { calls: Call[]; client: RwsClient } {
  const calls: Call[] = [];
  const fake = {
    requestMastership: async (d: string) => { calls.push({ what: `mastership-request ${d}` }); },
    releaseMastership: async (d: string) => { calls.push({ what: `mastership-release ${d}` }); },
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return respond?.(method, url, body) ?? { status: 204, body: '' };
    },
  };
  return { calls, client: fake as unknown as RwsClient };
}

interface Recorded { method: string; url: string; body: string }

async function startServer(
  answer: (method: string, url: string, body: string) => { status: number; type?: string; body?: string; headers?: Record<string, string> } | undefined,
): Promise<{ server: http.Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      const a = answer(req.method ?? '', req.url ?? '', body);
      if (!a) { res.writeHead(204); res.end(); return; }
      res.writeHead(a.status, { 'Content-Type': a.type ?? 'application/hal+json;v=2.0', ...(a.headers ?? {}) });
      res.end(a.body ?? '');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const XHTML = 'application/xhtml+xml;v=2.0';
const client2 = (url: string): RwsClient2 => new RwsClient2(url, 'Default User', 'robotics');

const manager = (adapter: IRWSAdapter): RobotManager => {
  const mgr = new RobotManager();
  (mgr as unknown as { adapter: IRWSAdapter }).adapter = adapter;
  return mgr;
};

/** A manager whose session is up on `adapter`. */
const connectedManager = (adapter: IRWSAdapter): RobotManager => {
  const mgr = manager(adapter);
  const m = mgr as unknown as { _state: { connected: boolean }; sessionEpoch: number | null; connectEpoch: number };
  m._state.connected = true;
  m.sessionEpoch = m.connectEpoch;
  return mgr;
};

// ── Activation record ─────────────────────────────────────────────────────────

// ABB's RWS 2.0 example answer (Rev L).
const STACKFRAME_REV_L_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:9898/rw/rapid/"/></head><body>
<div class="state"><a href="tasks/T_ROB1/activation-record" rel="self"/><ul>
<li class="rap-stackframe" title="stackframe">
<span class="execlevel">Normal</span><span class="beg-row">4</span><span class="beg-col">8</span>
<span class="end-row">4</span><span class="end-col">18</span><span class="stack-url">RAPID/T_ROB1/%1</span>
<span class="routine-url">RAPID/T_ROB1/MainModule/main</span>
</li></ul></div></body></html>`;

// The same entry in the hal+json form a GET negotiates first.
const STACKFRAME_HAL = JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1:9898/rw/rapid/' } },
  state: [{
    _type: 'rap-stackframe', _title: 'stackframe', execlevel: 'Normal', 'beg-row': '4', 'beg-col': '8',
    'end-row': '4', 'end-col': '18', 'stack-url': 'RAPID/T_ROB1/%1', 'routine-url': 'RAPID/T_ROB1/MainModule/main',
  }],
});

// ABB's RWS 1.0 example answer (Rev M) in the controller's ?json=1 form.
const STACKFRAME_REV_M_JSON = JSON.stringify({ _embedded: { _state: [{
  _type: 'rap-stackframe', _title: 'stackframe', execlevel: 'Normal', 'beg-row': '6', 'beg-col': '3',
  'end-row': '6', 'end-col': '13', 'stack-url': 'RAPID/T_ROB1/%1', 'routine-url': 'RAPID/T_ROB1/MainModule/main',
}] } });

describe('getTaskActivationRecord reads ABB\'s rap-stackframe entry', () => {
  for (const [form, type, body] of [['XHTML', XHTML, STACKFRAME_REV_L_XHTML], ['hal+json', undefined, STACKFRAME_HAL]] as const) {
    it(`RWS 2.0, ${form}: a 200 is the stack frame, not {}`, async () => {
      const { server, url, requests } = await startServer(() => ({ status: 200, type, body }));
      try {
        await expect(client2(url).getTaskActivationRecord('T_ROB1')).resolves.toMatchObject({
          execlevel: 'Normal', 'beg-row': '4', 'beg-col': '8', 'end-row': '4', 'end-col': '18',
          'stack-url': 'RAPID/T_ROB1/%1', 'routine-url': 'RAPID/T_ROB1/MainModule/main',
        });
        expect(requests.every(r => r.method === 'GET' && r.url === '/rw/rapid/tasks/T_ROB1/activation-record')).toBe(true);
      } finally { server.close(); }
    });
  }

  it('RWS 2.0: an answer with no rap-stackframe entry reads as {}', async () => {
    const { server, url } = await startServer(() => ({ status: 200, body: JSON.stringify({ state: [] }) }));
    try {
      await expect(client2(url).getTaskActivationRecord('T_ROB1')).resolves.toEqual({});
    } finally { server.close(); }
  });

  it('RWS 1.0: ABB\'s example reads as the stack frame', async () => {
    const { client } = makeFake(() => ({ status: 200, body: STACKFRAME_REV_M_JSON }));
    await expect(new RWS1Adapter(client).getTaskActivationRecord('T_ROB1')).resolves.toMatchObject({
      execlevel: 'Normal', 'beg-row': '6', 'routine-url': 'RAPID/T_ROB1/MainModule/main',
    });
  });

  it('the row stays built on both generations', () => {
    const op = ALL_TABLES.rapid.getTaskActivationRecord;
    expect([evidenceOf(op, 'rws1'), evidenceOf(op, 'rws2')]).toEqual(['built', 'built']);
  });
});

// ── Alias I/O ─────────────────────────────────────────────────────────────────

const ALIASES = [
  { alias: 'signaldi1', signal: 'TestD1', type: 'DI' },
  { alias: 'signaldi2', signal: 'TestD2', type: 'DI' },
];

// ABB's example answer, the same on both generations (Rev M, Rev L).
const ALIASIO_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>rapid</title><base href="http://127.0.0.1:4444/rw/rapid/"/></head><body>
<div class="state"><a href="aliasio?start=0" rel="self"/><ul>
<li class="rap-alias-io" title="aliasio0"><span class="alias-name">signaldi1</span><span class="signal-name">TestD1</span><span class="type">DI</span></li>
<li class="rap-alias-io" title="aliasio1"><span class="alias-name">signaldi2</span><span class="signal-name">TestD2</span><span class="type">DI</span></li>
</ul></div></body></html>`;

const ALIASIO_HAL = JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1:4444/rw/rapid/' } },
  state: [
    { _type: 'rap-alias-io', _title: 'aliasio0', 'alias-name': 'signaldi1', 'signal-name': 'TestD1', type: 'DI' },
    { _type: 'rap-alias-io', _title: 'aliasio1', 'alias-name': 'signaldi2', 'signal-name': 'TestD2', type: 'DI' },
  ],
});

const ALIASIO_RWS1_JSON = JSON.stringify({ _embedded: { _state: [
  { _type: 'rap-alias-io', _title: 'aliasio0', 'alias-name': 'signaldi1', 'signal-name': 'TestD1', type: 'DI' },
  { _type: 'rap-alias-io', _title: 'aliasio1', 'alias-name': 'signaldi2', 'signal-name': 'TestD2', type: 'DI' },
] } });

// An empty list, as an RWS 1.0 virtual controller answered it with no alias defined.
const ALIASIO_EMPTY_XHTML = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rapid</title>'
  + '<base href="http://127.0.0.1/rw/rapid/"/></head><body><div class="state"><a href="aliasio" rel="self"/><ul></ul></div></body></html>';

// The /rw/rapid listing: rap-aliasio-li is the link to the alias list, not an alias.
const RAPID_LISTING_HAL = JSON.stringify({ state: [
  { _type: 'rap-modules-li', _title: 'modules', _links: { self: { href: 'modules' } } },
  { _type: 'rap-aliasio-li', _title: 'aliasio', _links: { self: { href: 'aliasio' } } },
] });

describe('listAliasIO reads ABB\'s rap-alias-io entries', () => {
  for (const [form, type, body] of [['XHTML', XHTML, ALIASIO_XHTML], ['hal+json', undefined, ALIASIO_HAL]] as const) {
    it(`RWS 2.0, ${form}: every alias with its signal and type`, async () => {
      const { server, url, requests } = await startServer(() => ({ status: 200, type, body }));
      try {
        await expect(client2(url).listAliasIO()).resolves.toEqual(ALIASES);
        expect(requests.every(r => r.method === 'GET' && r.url === '/rw/rapid/aliasio')).toBe(true);
      } finally { server.close(); }
    });
  }

  it('RWS 2.0: the link entry of the /rw/rapid listing is PARSE_ERROR, not an alias', async () => {
    const { server, url } = await startServer(() => ({ status: 200, body: RAPID_LISTING_HAL }));
    try {
      await expect(client2(url).listAliasIO()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    } finally { server.close(); }
  });

  it('RWS 1.0: ABB\'s example in the ?json=1 form and in XHTML', async () => {
    for (const body of [ALIASIO_RWS1_JSON, ALIASIO_XHTML]) {
      const { calls, client } = makeFake(() => ({ status: 200, body }));
      await expect(new RWS1Adapter(client).listAliasIO()).resolves.toEqual(ALIASES);
      expect(calls.map(c => c.what)).toEqual(['GET /rw/rapid/aliasio?json=1']);
    }
  });

  it('RWS 1.0: an empty list and a refusal are both []', async () => {
    const empty = makeFake(() => ({ status: 200, body: ALIASIO_EMPTY_XHTML }));
    await expect(new RWS1Adapter(empty.client).listAliasIO()).resolves.toEqual([]);
    const refused = makeFake(() => ({ status: 400, body: '' }));
    await expect(new RWS1Adapter(refused.client).listAliasIO()).resolves.toEqual([]);
  });

  it('the shared reader leaves type out when the entry has none', () => {
    expect(aliasIoFrom([{ _type: 'rap-alias-io', 'alias-name': 'a', 'signal-name': 's' }], 'test')).toEqual([{ alias: 'a', signal: 's' }]);
    expect(aliasIoFrom([], 'test')).toEqual([]);
  });

  it('the request is unchanged, so the row keeps its evidence', () => {
    const op = ALL_TABLES.rapid.listAliasIO;
    expect([evidenceOf(op, 'rws1'), evidenceOf(op, 'rws2')]).toEqual(['live', 'built']);
  });
});

// ── DNS (RWS 1.0) ─────────────────────────────────────────────────────────────

// ABB's RWS 1.0 example answer (Rev M, "Get DNS Resource") in the ?json=1 form.
const DNS_REV_M_JSON = JSON.stringify({ _embedded: { _state: [
  { _type: 'ctrl-netw-dns', _title: 'name', name: 'abc' },
  { _type: 'ctrl-netw-dns', _title: 'primaryns', addr: '5.5.5.5' },
  { _type: 'ctrl-netw-dns', _title: 'secondaryns', addr: '10.10.10.10' },
  { _type: 'ctrl-netw-dns', _title: 'tertiaryns', addr: '9.9.9.9' },
  { _type: 'ctrl-netw-dns', _title: 'quaternaryns', addr: '12.12.12.12' },
  { _type: 'ctrl-netw-dns', _title: 'port', port: '53' },
] } });

describe('getDnsConfig returns every DNS entry (RWS 1.0)', () => {
  it('one key per entry title, the first entry\'s fields kept', async () => {
    const { calls, client } = makeFake(() => ({ status: 200, body: DNS_REV_M_JSON }));
    const dns = await new RWS1Adapter(client).getDnsConfig();
    expect(dns).toMatchObject({
      name: 'abc', primaryns: '5.5.5.5', secondaryns: '10.10.10.10',
      tertiaryns: '9.9.9.9', quaternaryns: '12.12.12.12', port: '53',
    });
    // What the method answered before (the first entry) is still in it.
    expect(dns).toMatchObject({ _type: 'ctrl-netw-dns', _title: 'name', name: 'abc' });
    expect(calls.map(c => c.what)).toEqual(['GET /ctrl/network/dns?json=1']);
  });

  it('a refusal is {}', async () => {
    const { client } = makeFake(() => ({ status: 404, body: '' }));
    await expect(new RWS1Adapter(client).getDnsConfig()).resolves.toEqual({});
  });
});

// ── System info copy (RWS 2.0) ────────────────────────────────────────────────

// ABB's RWS 2.0 example answer (Rev L, "Get Installed System Info").
const SYSTEM_INFO_REV_L_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html><head><base href="https://192.168.125.1/ctrl/system/info/"/></head><body>
<div class="state"><a href="" rel="self"/><ul>
<li class="ctrl-system-info-li" title="abb.robotics.robotcontrol_7.0.298.rmf"><a href="/fileservice/RAMDISK/ALPHA_29/abb.robotics.robotcontrol_7.0.298.rmf" rel="self"/></li>
<li class="ctrl-system-info-li" title="abb.robotics.robotos.rmf"><a href="/fileservice/$RAMDISK/ALPHA_29/abb.robotics.robotos.rmf" rel="self"/></li>
<li class="ctrl-system-info-li" title="controller.rsf"><a href="/fileservice/$RAMDISK/ALPHA_29/controller.rsf" rel="self"/></li>
<li class="ctrl-system-info-li" title="virtual.abb.robotics.robotcontrol.rlf"><a href="/fileservice/$RAMDISK/ALPHA_29/virtual.abb.robotics.robotcontrol.rlf" rel="self"/></li>
</ul></div></body></html>`;

describe('saveSystemInfo leaves file-type optional and returns nothing, as in 1.4.0 (RWS 2.0)', () => {
  it('without a file type, sends path alone; ABB\'s 200 answer listing the files is taken', async () => {
    const { server, url, requests } = await startServer(() => ({ status: 200, type: XHTML, body: SYSTEM_INFO_REV_L_XHTML }));
    try {
      await expect(client2(url).saveSystemInfo('$RAMDISK/ALPHA_29')).resolves.toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'POST', url: '/ctrl/system/info' });
      const form = new URLSearchParams(requests[0].body);
      expect([...form.keys()]).toEqual(['path']);
      expect(form.get('path')).toBe('$RAMDISK/ALPHA_29');
    } finally { server.close(); }
  });

  it('with a file type, sends ABB\'s file-type field; an empty one is left out', async () => {
    const { server, url, requests } = await startServer(() => ({ status: 200, type: XHTML, body: SYSTEM_INFO_REV_L_XHTML }));
    try {
      await client2(url).saveSystemInfo('$RAMDISK/ALPHA_29', '[FileType_RMF]');
      await client2(url).saveSystemInfo('$RAMDISK/ALPHA_29', '');
      expect(new URLSearchParams(requests[0].body).get('file-type')).toBe('[FileType_RMF]');
      expect(new URLSearchParams(requests[1].body).has('file-type')).toBe(false);
    } finally { server.close(); }
  });

  it('an answer with no body is taken too', async () => {
    const { server, url } = await startServer(() => undefined);
    try {
      await expect(client2(url).saveSystemInfo('$RAMDISK/x')).resolves.toBeUndefined();
    } finally { server.close(); }
  });

  it('RobotManager passes it through, file type optional', async () => {
    const calls: unknown[][] = [];
    const mgr = manager({
      saveSystemInfo: async (...args: unknown[]) => { calls.push(args); },
    } as unknown as IRWSAdapter);
    await expect(mgr.saveSystemInfo('$RAMDISK/x')).resolves.toBeUndefined();
    expect(calls).toEqual([['$RAMDISK/x', undefined]]);
  });

  it('the row stays built', () => {
    expect(evidenceOf(ALL_TABLES.ctrl.saveSystemInfo, 'rws2')).toBe('built');
  });
});

// ── Compress / decompress jobs ────────────────────────────────────────────────

// A finished compress job in the hal+json form: ABB's progress entry, state
// ready, the controller's success code. A RobotWare 7.21.4 virtual controller
// answered this read 201.
const PROGRESS_READY_HAL = JSON.stringify({
  _links: { base: { href: 'https://127.0.0.1/progress/3/' } },
  state: [{ _type: 'progress', _title: 'compress', state: 'ready', code: '294912' }],
});
const PROGRESS_PENDING_HAL = JSON.stringify({
  state: [{ _type: 'progress', _title: 'compress', state: 'pending', code: '294912' }],
});

describe('startJob returns the progress id of a compress or decompress job; compressPath and decompressPath return nothing, as in 1.4.0', () => {
  it('reads the id from /progress/{id}, relative or absolute', () => {
    expect(progressIdFrom('/progress/3')).toBe('3');
    expect(progressIdFrom('https://127.0.0.1:443/progress/12')).toBe('12');
    expect(progressIdFrom(undefined)).toBeUndefined();
    expect(progressIdFrom(null)).toBeUndefined();
    expect(progressIdFrom('/subscription/3')).toBeUndefined();
  });

  it('RWS 2.0: the 202 Location gives the id, and getProgress follows the job to ready', async () => {
    let polls = 0;
    const { server, url, requests } = await startServer((method, path) => {
      if (method === 'POST' && (path === '/ctrl/compress' || path === '/ctrl/decompress')) {
        return { status: 202, type: XHTML, headers: { Location: path === '/ctrl/compress' ? '/progress/3' : '/progress/4' } };
      }
      if (method === 'GET' && path === '/progress/3') {
        polls += 1;
        return polls === 1 ? { status: 200, body: PROGRESS_PENDING_HAL } : { status: 201, body: PROGRESS_READY_HAL };
      }
      return undefined;
    });
    try {
      const c = client2(url);
      const id = await c.startJob('compressPath', '$TEMP/src', '$TEMP/dst/');
      expect(id).toBe('3');
      expect(requests[0]).toMatchObject({ method: 'POST', url: '/ctrl/compress' });
      expect(await c.getProgress(id!)).toMatchObject({ state: 'pending' });
      expect(await c.getProgress(id!)).toMatchObject({ state: 'ready', details: { code: '294912' } });
      await expect(c.startJob('decompressPath', '$TEMP/dst/src.rzo', '$TEMP/out/')).resolves.toBe('4');
      // The 1.4.0 methods send the same requests and return nothing.
      const from = requests.length;
      await expect(c.compressPath('$TEMP/src', '$TEMP/dst/')).resolves.toBeUndefined();
      await expect(c.decompressPath('$TEMP/dst/src.rzo', '$TEMP/out/')).resolves.toBeUndefined();
      const sent = (r: Recorded): string => `${r.method} ${r.url} ${r.body}`;
      expect(requests.slice(from).map(sent)).toEqual([requests[0], requests[3]].map(sent));
    } finally { server.close(); }
  });

  // ABB's progress-ev entry for a finished compress job (Rev L, Controller
  // service, "Compress Resource"), here with the controller's failure code.
  const PROGRESS_EV_REV_L_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:443/"/></head><body>
<div class="state"><a href="subscription/1" rel="group"></a><ul><a href="/progress/1" rel="self"/>
<li class="progress-ev" title="compress">
<a href="/fileservice/$temp/TEMP.rzo" rel="resource"/>
<span class="state">ready</span>
<span class="code">-1073414146</span>
</li></ul></div></body></html>`;
  const PROGRESS_EV_HAL = JSON.stringify({
    state: [{ _type: 'progress-ev', _title: 'compress', state: 'ready', code: '-1073414146' }],
  });

  for (const [form, type, body] of [['XHTML', XHTML, PROGRESS_EV_REV_L_XHTML], ['hal+json', undefined, PROGRESS_EV_HAL]] as const) {
    it(`RWS 2.0, ${form}: getProgress reads a progress-ev entry when the answer has no progress entry`, async () => {
      const { server, url, requests } = await startServer(() => ({ status: 200, type, body }));
      try {
        await expect(client2(url).getProgress('1')).resolves.toMatchObject({ state: 'ready', details: { code: '-1073414146' } });
        expect(requests.every(r => r.method === 'GET' && r.url === '/progress/1')).toBe(true);
      } finally { server.close(); }
    });
  }

  it('RWS 2.0: getProgress prefers the progress entry, and an answer with neither entry is null', async () => {
    const both = JSON.stringify({ state: [
      { _type: 'progress', _title: 'compress', state: 'pending', code: '294912' },
      { _type: 'progress-ev', _title: 'compress', state: 'ready', code: '-1073414146' },
    ] });
    const neither = JSON.stringify({ state: [{ _type: 'ctrl-env', _title: 'TEMP', value: '/tmp' }] });
    const { server, url } = await startServer((_m, path) => ({ status: 200, body: path === '/progress/2' ? both : neither }));
    try {
      await expect(client2(url).getProgress('2')).resolves.toMatchObject({ state: 'pending', details: { code: '294912' } });
      await expect(client2(url).getProgress('3')).resolves.toBeNull();
    } finally { server.close(); }
  });

  it('RWS 2.0: no Location header is undefined, as before', async () => {
    const { server, url } = await startServer(() => ({ status: 202, type: XHTML }));
    try {
      await expect(client2(url).startJob('compressPath', '$TEMP/a', '$TEMP/b/')).resolves.toBeUndefined();
    } finally { server.close(); }
  });

  it('RWS 1.0: the 202 Location gives the id, for compress and decompress', async () => {
    const { calls, client } = makeFake((method, url) => (method === 'POST'
      ? { status: 202, body: '', headers: new Headers({ Location: url.includes('action=comp&') ? '/progress/5' : '/progress/6' }) }
      : undefined));
    const adapter = new RWS1Adapter(client);
    await expect(adapter.startJob('compressPath', '$TEMP/a.txt', '$TEMP/a.rzo')).resolves.toBe('5');
    await expect(adapter.startJob('decompressPath', '$TEMP/a.rzo', '$TEMP/')).resolves.toBe('6');
    await expect(adapter.compressPath('$TEMP/a.txt', '$TEMP/a.rzo')).resolves.toBeUndefined();
    await expect(adapter.decompressPath('$TEMP/a.rzo', '$TEMP/')).resolves.toBeUndefined();
    expect(calls.map(c => c.what)).toEqual([
      'POST /ctrl/compress?action=comp&json=1',
      'POST /ctrl/compress?action=dcomp&json=1',
      'POST /ctrl/compress?action=comp&json=1',
      'POST /ctrl/compress?action=dcomp&json=1',
    ]);
    expect(calls[0].body).toBe('srcpath=%2Ffileservice%2F%24TEMP%2Fa.txt&dstpath=%2Ffileservice%2F%24TEMP%2Fa.rzo');
    expect(calls[2].body).toBe(calls[0].body);
  });

  it('RWS 1.0: an answer without headers is undefined, and a refusal still throws', async () => {
    const plain = makeFake(() => ({ status: 202, body: '' }));
    await expect(new RWS1Adapter(plain.client).startJob('compressPath', '$TEMP/a', '$TEMP/b')).resolves.toBeUndefined();
    const refused = makeFake(() => ({ status: 400, body: '' }));
    await expect(new RWS1Adapter(refused.client).startJob('compressPath', '$TEMP/a', '$TEMP/b')).rejects.toBeInstanceOf(Error);
    await expect(new RWS1Adapter(refused.client).compressPath('$TEMP/a', '$TEMP/b')).rejects.toBeInstanceOf(Error);
  });

  it('a name that is not one of the jobs: INVALID_ARGUMENT, nothing sent, on both generations and RobotManager', async () => {
    const { server, url, requests } = await startServer(() => ({ status: 202, type: XHTML, headers: { Location: '/progress/1' } }));
    const { calls, client } = makeFake(() => ({ status: 202, body: '' }));
    try {
      const mgr = connectedManager(new RWS1Adapter(client));
      for (const name of ['createBackup', 'getProgress', 'compress', '', 'constructor']) {
        const loose = name as unknown as 'compressPath';
        await expect(client2(url).startJob(loose, '$TEMP/a', '$TEMP/b')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        await expect(new RWS1Adapter(client).startJob(loose, '$TEMP/a', '$TEMP/b')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        await expect(mgr.startJob(loose, '$TEMP/a', '$TEMP/b')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(requests).toEqual([]);
      expect(calls).toEqual([]);
    } finally { server.close(); }
  });

  it('RobotManager.startJob returns the adapter\'s id, and getProgress reads the job; compressPath and decompressPath return nothing', async () => {
    const started: unknown[][] = [];
    const plain: string[] = [];
    const mgr = connectedManager({
      startJob: async (...args: unknown[]) => { started.push(args); return args[0] === 'compressPath' ? '7' : '8'; },
      compressPath: async () => { plain.push('compressPath'); },
      decompressPath: async () => { plain.push('decompressPath'); },
      getProgress: async (id: string) => ({ state: 'ready', details: { code: '294912', id } }),
    } as unknown as IRWSAdapter);
    await expect(mgr.startJob('compressPath', '$TEMP/a', '$TEMP/b')).resolves.toBe('7');
    await expect(mgr.startJob('decompressPath', '$TEMP/b/a.rzo', '$TEMP/c')).resolves.toBe('8');
    expect(started).toEqual([['compressPath', '$TEMP/a', '$TEMP/b'], ['decompressPath', '$TEMP/b/a.rzo', '$TEMP/c']]);
    await expect(mgr.getProgress('7')).resolves.toEqual({ state: 'ready', details: { code: '294912', id: '7' } });
    await expect(mgr.compressPath('$TEMP/a', '$TEMP/b')).resolves.toBeUndefined();
    await expect(mgr.decompressPath('$TEMP/b/a.rzo', '$TEMP/c')).resolves.toBeUndefined();
    expect(plain).toEqual(['compressPath', 'decompressPath']);
  });

  it('RobotManager.startJob with an adapter written against 1.4.0 (no startJob): the method of that job starts it, undefined', async () => {
    const calls: unknown[][] = [];
    const mgr = connectedManager({
      compressPath: async (...args: unknown[]) => { calls.push(['compressPath', ...args]); },
      decompressPath: async (...args: unknown[]) => { calls.push(['decompressPath', ...args]); },
      saveSystemInfo: async () => { /* 1.4.0 */ },
    } as unknown as IRWSAdapter);
    await expect(mgr.startJob('compressPath', '$TEMP/a', '$TEMP/b')).resolves.toBeUndefined();
    await expect(mgr.startJob('decompressPath', '$TEMP/b/a.rzo', '$TEMP/c')).resolves.toBeUndefined();
    expect(calls).toEqual([['compressPath', '$TEMP/a', '$TEMP/b'], ['decompressPath', '$TEMP/b/a.rzo', '$TEMP/c']]);
    await expect(mgr.compressPath('$TEMP/a', '$TEMP/b')).resolves.toBeUndefined();
    await expect(mgr.saveSystemInfo('$TEMP/info', 'FileType_RMF')).resolves.toBeUndefined();
  });

  it('RobotManager.startJob: NOT_CONNECTED without a session, UNSUPPORTED_OPERATION when the adapter can start neither', async () => {
    await expect(new RobotManager().startJob('compressPath', '$TEMP/a', '$TEMP/b')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(manager({ startJob: async () => '1' } as unknown as IRWSAdapter).startJob('compressPath', '$TEMP/a', '$TEMP/b'))
      .rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(connectedManager({} as unknown as IRWSAdapter).startJob('decompressPath', '$TEMP/a', '$TEMP/b'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('RobotManager.getProgress: NOT_CONNECTED without a session, UNSUPPORTED_OPERATION without a progress read', async () => {
    await expect(new RobotManager().getProgress('1')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(manager({} as unknown as IRWSAdapter).getProgress('1')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('compressPath keeps its evidence on both generations', () => {
    const op = ALL_TABLES.ctrl.compressPath;
    expect([evidenceOf(op, 'rws1'), evidenceOf(op, 'rws2')]).toEqual(['live', 'live']);
  });
});
