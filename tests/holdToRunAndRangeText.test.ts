import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RobotManager } from '../src/RobotManager.js';
import type { RwsClient } from '../src/RwsClient.js';
import { ALL_TABLES, buildPath } from '../src/paths/index.js';
import type { PathSpec } from '../src/paths/index.js';

/**
 * Hold to run on both generations, and the text-range read's decoding.
 *
 * RWS 1.0 hold to run is the `holdtorun-state` form RW 6.16.03 advertises on
 * `GET /rw/rapid/execution?action=show` (one field, `state`), which ABB's
 * RWS 1.0 manual (Rev M, "Set Hold to Run Cmd") documents with the values
 * press, held and release. RWS 2.0 posts the same field to
 * `/rw/rapid/execution/holdtorun`.
 *
 * The RWS 1.0 range read answers key `text` with XML entities and raw spaces
 * (RW 6.16.03); the whole-module read answers key `module-text` URL-encoded.
 * The RWS 2.0 XHTML representation carries XML entities in the span.
 */

interface Call { what: string; body?: string }

function makeFake(respond?: (method: string, url: string, body?: string) => { status: number; body: string } | undefined): { calls: Call[]; client: RwsClient } {
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

const wire = (calls: Call[]): Call[] => calls.filter(c => !c.what.startsWith('mastership-'));

interface Recorded { method: string; url: string; accept: string; body: string }

/** A local HTTP server for RwsClient2; `handle` answers each request. */
async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '', url: req.url ?? '',
        accept: String(req.headers['accept'] ?? ''), body: Buffer.concat(chunks).toString('utf8'),
      });
      handle(req, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

// ─── Hold to run ─────────────────────────────────────────────────────────────

describe('holdToRun, RWS 1.0', () => {
  it('the path table row is the advertised execution?action=holdtorun-state form with field state', () => {
    const row = ALL_TABLES.rapid.holdToRun.rws1 as PathSpec;
    expect(row.method).toBe('POST');
    expect(buildPath(row, { task: 'T_ROB1' })).toBe('/rw/rapid/execution?action=holdtorun-state');
    expect(row.fields).toEqual(['state']);
  });

  it('posts state=press, state=held and state=release to /rw/rapid/execution?action=holdtorun-state', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    for (const s of ['press', 'held', 'release'] as const) { await a.holdToRun('T_ROB1', s); }
    expect(wire(calls)).toEqual([
      { what: 'POST /rw/rapid/execution?action=holdtorun-state&json=1', body: 'state=press' },
      { what: 'POST /rw/rapid/execution?action=holdtorun-state&json=1', body: 'state=held' },
      { what: 'POST /rw/rapid/execution?action=holdtorun-state&json=1', body: 'state=release' },
    ]);
  });

  it('the task argument does not reach the wire (execution is controller-wide)', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).holdToRun('T_ROB2', 'press');
    expect(wire(calls).map(c => c.what)).toEqual(['POST /rw/rapid/execution?action=holdtorun-state&json=1']);
  });

  it('RobotManager.holdToRun passes held through to the RWS 1.0 form', async () => {
    const { calls, client } = makeFake();
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: RWS1Adapter }).adapter = new RWS1Adapter(client);
    await mgr.holdToRun('T_ROB1', 'held');
    expect(wire(calls)).toEqual([
      { what: 'POST /rw/rapid/execution?action=holdtorun-state&json=1', body: 'state=held' },
    ]);
  });

  it('holds rapid mastership around each post, like start, resetpp and setcycle', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    await a.holdToRun('T_ROB1', 'press');
    expect(calls).toEqual([
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/execution?action=holdtorun-state&json=1', body: 'state=press' },
      { what: 'mastership-release rapid' },
    ]);
  });

  it('through RobotManager the adapter takes the one rapid hold around the post', async () => {
    const { calls, client } = makeFake();
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: RWS1Adapter }).adapter = new RWS1Adapter(client);
    await mgr.holdToRun('T_ROB1', 'release');
    expect(calls).toEqual([
      { what: 'mastership-request rapid' },
      { what: 'POST /rw/rapid/execution?action=holdtorun-state&json=1', body: 'state=release' },
      { what: 'mastership-release rapid' },
    ]);
  });

  it('inside a caller\'s rapid hold, press, held and release request and release nothing of their own', async () => {
    const { calls, client } = makeFake();
    const a = new RWS1Adapter(client);
    await a.requestMastership('rapid');
    for (const s of ['press', 'held', 'release'] as const) { await a.holdToRun('T_ROB1', s); }
    await a.releaseMastership('rapid');
    expect(calls.map(c => c.what)).toEqual([
      'mastership-request rapid',
      'POST /rw/rapid/execution?action=holdtorun-state&json=1',
      'POST /rw/rapid/execution?action=holdtorun-state&json=1',
      'POST /rw/rapid/execution?action=holdtorun-state&json=1',
      'mastership-release rapid',
    ]);
  });

  it('a refused rapid mastership request fails the call before anything is posted', async () => {
    const calls: Call[] = [];
    const refused = Object.assign(new Error('Requested resource is held by someone else'), { code: 'MASTERSHIP_REQUIRED' });
    const client = {
      requestMastership: async (d: string) => { calls.push({ what: `mastership-request ${d}` }); throw refused; },
      releaseMastership: async (d: string) => { calls.push({ what: `mastership-release ${d}` }); },
      request: async (method: string, url: string, body?: string) => { calls.push({ what: `${method} ${url}`, body }); return { status: 204, body: '' }; },
    };
    await expect(new RWS1Adapter(client as unknown as RwsClient).holdToRun('T_ROB1', 'press')).rejects.toBe(refused);
    expect(calls).toEqual([{ what: 'mastership-request rapid' }]);
  });
});

describe('holdToRun, RWS 2.0', () => {
  it('posts state=held to /rw/rapid/execution/holdtorun inside an edit hold (RobotWare 7)', async () => {
    const { server, port, seen } = await startServer((req, res) => {
      if (req.url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"7.21.0+229"}]}');
        return;
      }
      res.writeHead(204); res.end();
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await c.connect();
      const before = seen.length;
      await c.holdToRun('T_ROB1', 'held');
      const writes = seen.slice(before).filter(r => r.method === 'POST').map(r => `${r.method} ${r.url} ${r.body}`);
      expect(writes).toEqual([
        'POST /rw/mastership/edit/request ',
        'POST /rw/rapid/execution/holdtorun state=held',
        'POST /rw/mastership/edit/release ',
      ]);
    } finally { server.close(); }
  });
});

// ─── Text range ──────────────────────────────────────────────────────────────

describe('getModuleTextRange, RWS 1.0: decoded by the key the controller used', () => {
  const rangeBody = (text: string): string =>
    JSON.stringify({ _embedded: { _state: [{ _type: 'rap-mod-text', _title: 'pgm_txt', text }] } });
  const read = async (body: string): Promise<string> => {
    const { client } = makeFake((m, url) => m === 'GET' && url.includes('startrow=') ? { status: 200, body } : undefined);
    return new RWS1Adapter(client).getModuleTextRange('T_ROB1', 'M', 3, 15, 3, 23);
  };

  it('a mid-line `text` value with no whitespace and a %XX escape is entity-decoded, never URL-decoded', async () => {
    expect(await read(rangeBody('&quot;100%25&quot;'))).toBe('"100%25"');
    expect(await read(rangeBody('&quot;a&lt;b%41&quot;'))).toBe('"a<b%41"');
    expect(await read(rangeBody('&quot;Load%3dOK&amp;go&quot;'))).toBe('"Load%3dOK&go"');
    expect(await read(rangeBody('50%25'))).toBe('50%25');
  });

  it('a `text` value is entity-decoded once, &amp; last', async () => {
    expect(await read(rangeBody('&amp;quot;x&amp;lt;'))).toBe('&quot;x&lt;');
  });

  it('a `module-text` value is URL-decoded only, so a literal entity in the RAPID text survives', async () => {
    const body = JSON.stringify({ _embedded: { _state: [{ _type: 'rap-module-text', 'module-text': '%26quot%3Bx%26quot%3B%20y' }] } });
    expect(await read(body)).toBe('&quot;x&quot; y');
  });
});

describe('getModuleTextRange, RWS 2.0 over the XHTML fallback', () => {
  const XHTML = (span: string): string =>
    '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rapid</title>'
    + '<base href="http://127.0.0.1/rw/rapid/"/></head><body><div class="state">'
    + '<a href="tasks/T_ROB1/modules/M/text/range?startrow=2&amp;startcol=1&amp;endrow=3&amp;endcol=0" rel="self"/>'
    + `<ul><li class="rap-mod-text" title="pgm_txt"><span class="text">${span}</span></li></ul></div></body></html>`;

  /** 406 to a hal+json Accept, so the client falls back to XHTML; then `span` in the range's text span. */
  const read = async (span: string): Promise<{ text: string; accepts: string[] }> => {
    const { server, port, seen } = await startServer((req, res) => {
      if (String(req.headers['accept'] ?? '').includes('hal+json')) { res.writeHead(406); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(XHTML(span));
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const text = await c.getModuleTextRange('T_ROB1', 'M', 2, 1, 2, -1);
      return { text, accepts: seen.map(r => r.accept) };
    } finally { server.close(); }
  };

  it('decodes the XML entities of the span text', async () => {
    const { text, accepts } = await read('  CONST string s := &quot;a&lt;b&gt;c&amp;d&quot;&quot;e&apos;f&quot;;\n');
    expect(text).toBe('  CONST string s := "a<b>c&d""e\'f";\n');
    // The fallback really happened: hal+json first, then XHTML.
    expect(accepts[0]).toMatch(/hal\+json/);
    expect(accepts.at(-1)).toMatch(/xhtml/);
  });

  it('decodes once, &amp; last: an escaped entity reads as the literal entity', async () => {
    expect((await read('&amp;lt;x&amp;quot;')).text).toBe('&lt;x&quot;');
  });
});

describe('getModuleText, RWS 2.0: entities decoded over the XHTML fallback only', () => {
  const XHTML = (moduleText: string): string =>
    '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rapid</title>'
    + '<base href="http://127.0.0.1/rw/rapid/"/></head><body><div class="state">'
    + '<a href="tasks/T_ROB1/modules/M/text" rel="self"/>'
    + '<ul><li class="rap-module-text" title="moduletext"><span class="change-count"> 12 </span>'
    + `<span class="module-text">${moduleText}</span></li></ul></div></body></html>`;

  /** Serves the module text: XHTML after a 406 to hal+json when `halJson` is
   *  undefined, else the hal+json answer `halJson`. */
  const read = async (opts: { xhtml?: string; halJson?: string }): Promise<{ result: { text: string; changeCount: number }; accepts: string[] }> => {
    const { server, port, seen } = await startServer((req, res) => {
      const wantsHal = String(req.headers['accept'] ?? '').includes('hal+json');
      if (opts.halJson !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(opts.halJson);
        return;
      }
      if (wantsHal) { res.writeHead(406); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(XHTML(opts.xhtml ?? ''));
    });
    try {
      const c = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const result = await c.getModuleText('T_ROB1', 'M');
      return { result, accepts: seen.map(r => r.accept) };
    } finally { server.close(); }
  };

  it('decodes the XML entities of the module-text span after the fallback', async () => {
    const { result, accepts } = await read({
      xhtml: 'MODULE M\n  CONST string s := &quot;a&lt;b&amp;c&gt;d&apos;e&quot;;\nENDMODULE\n',
    });
    expect(result).toEqual({ text: 'MODULE M\n  CONST string s := "a<b&c>d\'e";\nENDMODULE\n', changeCount: 12 });
    expect(accepts[0]).toMatch(/hal\+json/);
    expect(accepts.at(-1)).toMatch(/xhtml/);
  });

  it('decodes once, &amp; last: an escaped entity reads as the literal entity', async () => {
    expect((await read({ xhtml: '! &amp;quot;x&amp;lt;' })).result.text).toBe('! &quot;x&lt;');
  });

  it('returns the hal+json string as read, so a literal entity in the RAPID text survives', async () => {
    const halJson = JSON.stringify({
      _links: { base: { href: 'http://127.0.0.1/rw/rapid/' } },
      state: [{ _type: 'rap-module-text', _title: 'moduletext', 'change-count': ' 7 ', 'module-text': '! &quot;x&lt; "a<b&c"\n' }],
    });
    expect((await read({ halJson })).result).toEqual({ text: '! &quot;x&lt; "a<b&c"\n', changeCount: 7 });
  });
});
