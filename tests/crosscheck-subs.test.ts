import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { setLogger } from '../src/Logger.js';
import type { SubscriptionResource } from '../src/types.js';

/**
 * Release-note cross-check (2026-09-29): subscription names for ABB's newer
 * execution resources, the diagnostics warning on RobotWare 7.15.0, and the
 * visibility of a hal+json body that is not JSON. Mock servers only.
 */

// ─── Local test server ───────────────────────────────────────────────────────

interface RecordedRequest { method: string; url: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '' });
      handle(req, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const HAL = { 'Content-Type': 'application/hal+json;v=2.0' };

/** A /rw/system answer carrying the given rwversion; everything else 204. */
const systemWithVersion = (rwversion: string) =>
  (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.url === '/rw/system') {
      res.writeHead(200, HAL);
      res.end(`{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"${rwversion}"}]}`);
      return;
    }
    res.writeHead(204); res.end();
  };

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
});
afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

// ─── 1. execstate / execstatechange get their own names ─────────────────────

describe('resourcePathToName: the execution resources on /rw/rapid/execution', () => {
  const name = (href: string): string => RwsClient2.resourcePathToName(href);

  it('keeps the execution state, in every form the client subscribes, on "execution"', () => {
    expect(name('/rw/rapid/execution')).toBe('execution');
    expect(name('/rw/rapid/execution;ctrlexecstate')).toBe('execution');
    expect(name('https://127.0.0.1:9403/rw/rapid/execution;ctrlexecstate')).toBe('execution');
    expect(name('rw/rapid/execution;ctrlexecstate')).toBe('execution');
  });

  it('names the extended state "execstate" (RW 7.19.1 / 7.20), never "execution"', () => {
    // Its value is a change count with a user, task and elog seqnum - not an
    // execution state - so it must not overwrite RobotState.execstate.
    expect(name('/rw/rapid/execution;execstate')).toBe('execstate');
    expect(name('https://127.0.0.1:9403/rw/rapid/execution;execstate')).toBe('execstate');
    expect(name('/rw/rapid/execution;execstate?x=1')).toBe('execstate');
  });

  it('names the RAPID-domain change count "execstatechange", not "execstate"', () => {
    // `;execstate` is a prefix of `;execstatechange`: the longer one wins.
    expect(name('/rw/rapid/execution;execstatechange')).toBe('execstatechange');
    expect(name('https://127.0.0.1:9403/rw/rapid/execution;execstatechange')).toBe('execstatechange');
  });

  it('still leaves the execution cycle alone', () => {
    expect(name('/rw/rapid/execution;rapidexeccycle')).toBe('/rw/rapid/execution;rapidexeccycle');
    expect(name('/rw/rapid/execution;execcycle')).toBe('/rw/rapid/execution;execcycle');
  });

  it('returns the new friendly names unchanged, like the old ones', () => {
    for (const n of ['execution', 'execstate', 'execstatechange']) {
      expect(name(n)).toBe(n);
    }
  });

  it('the client still subscribes "execution" as ;ctrlexecstate', () => {
    const build = (r: SubscriptionResource): string | null =>
      (RwsClient2 as unknown as { rws2ResourcePath(r: SubscriptionResource): string | null }).rws2ResourcePath(r);
    expect(build('execution')).toBe('/rw/rapid/execution;ctrlexecstate');
  });
});

// ─── 2. saveDiagnostics warns on RobotWare 7.15.0 ───────────────────────────

describe('saveDiagnostics on RobotWare 7.15.0', () => {
  it('warns once before sending when connect() cached 7.15.0, and still sends', async () => {
    const { server, port, requests } = await startServer(systemWithVersion('7.15.0+123'));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await client.connect();
      await client.saveDiagnostics('$TEMP/diag.log');
      // RobotWare 7.15 is past 7.8: connect() also reads the HeartBeat configuration once.
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /rw/system', 'GET /rw/cfg/SYS/MASTER_BOOL/instances/HeartBeat', 'POST /ctrl/diagnostics/save']);
      const relevant = warnings.filter(w => w.includes('saveDiagnostics'));
      expect(relevant).toHaveLength(1);
      expect(relevant[0]).toContain('7.15.0');
      expect(relevant[0]).toContain('7.15.1');
      expect(relevant[0]).toContain('System failure when requesting a system diagnostics');
    } finally { server.close(); }
  });

  it('does not warn on 7.15.1 or 7.21 (the fix release and later)', async () => {
    for (const v of ['7.15.1+10', '7.21.0+229', '7.1.0+1']) {
      const { server, port } = await startServer(systemWithVersion(v));
      try {
        const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
        await client.connect();
        await client.saveDiagnostics('/fileservice/TEMP/diag');
        expect(warnings.filter(w => w.includes('saveDiagnostics'))).toEqual([]);
      } finally { server.close(); }
    }
  });

  it('fetches no version for the warning: before connect() it just sends', async () => {
    const { server, port, requests } = await startServer(systemWithVersion('7.15.0+123'));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      await client.saveDiagnostics('$TEMP/diag.log');
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['POST /ctrl/diagnostics/save']);
      expect(warnings.filter(w => w.includes('saveDiagnostics'))).toEqual([]);
    } finally { server.close(); }
  });
});

// ─── 3. A hal+json body that is not JSON is reported, not swallowed ─────────

describe('hal+json body that fails JSON.parse', () => {
  // The shape ABB's 7.10.0 notes §3.9 describe for some /rw/cfg resources
  // before 7.10: an invalid value of four consecutive double quotes.
  const broken = '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ctrl-diagnostics-li","_title":"d","value":""""}]}';

  it('warns once per request with the path and the first 80 characters, and still answers empty', async () => {
    const { server, port, requests } = await startServer((req, res) => {
      if (req.url === '/ctrl/diagnostics') { res.writeHead(200, HAL); res.end(broken); return; }
      res.writeHead(204); res.end();
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const info = await client.getDiagnostics();
      // The caller's view is unchanged: empty results, nothing thrown.
      expect(info).toEqual({ empty: true, entries: [] });
      expect(requests.map(r => r.url)).toEqual(['/ctrl/diagnostics']);
      const relevant = warnings.filter(w => w.includes('not valid JSON'));
      expect(relevant).toHaveLength(1);
      expect(relevant[0]).toContain('GET /ctrl/diagnostics');
      expect(relevant[0]).toContain(JSON.stringify(broken.slice(0, 80)));
      expect(relevant[0]).not.toContain(broken.slice(80, 100));
    } finally { server.close(); }
  });

  it('warns even when the whole body is the bad value, which parse() hands to XhtmlParser', async () => {
    // `""""` does not start with `{`, so looksLikeJson is false and the XHTML
    // parser takes it; it finds no elements and answers empty just the same.
    const { server, port } = await startServer((req, res) => {
      if (req.url === '/ctrl/diagnostics') { res.writeHead(200, HAL); res.end('""""'); return; }
      res.writeHead(204); res.end();
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const info = await client.getDiagnostics();
      expect(info).toEqual({ empty: true, entries: [] });
      const relevant = warnings.filter(w => w.includes('not valid JSON'));
      expect(relevant).toHaveLength(1);
      expect(relevant[0]).toContain('GET /ctrl/diagnostics');
      expect(relevant[0]).toContain(JSON.stringify('""""'));
    } finally { server.close(); }
  });

  it('stays quiet for valid hal+json and for an XHTML answer (the negotiation fallback)', async () => {
    const valid = '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"ctrl-diagnostics-li","_title":"d","value":"x"}]}';
    const xhtml = '<html><body><ul><li class="ctrl-diagnostics-li" title="d"><span class="value">x</span></li></ul></body></html>';
    const { server, port } = await startServer((req, res) => {
      if (req.url === '/ctrl/diagnostics') { res.writeHead(200, HAL); res.end(valid); return; }
      if (req.url === '/ctrl/safety/mode') { res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' }); res.end(xhtml); return; }
      res.writeHead(204); res.end();
    });
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p');
      const info = await client.getDiagnostics();
      expect(info.empty).toBe(false);
      await client.getSafetyMode();
      expect(warnings.filter(w => w.includes('not valid JSON'))).toEqual([]);
    } finally { server.close(); }
  });
});
