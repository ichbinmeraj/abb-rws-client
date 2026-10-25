import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsError } from '../src/types.js';
import { ALL_TABLES, evidenceOf } from '../src/paths/index.js';

/**
 * getExecutionErrorState, RobotWare 8.2 and later: ABB's
 * `GET /rw/rapid/execution/execerrorstate` (RWS site, RAPID Service, RobotWare
 * 8 view, "Get RAPID Execution Error State", badged "Since RW8.2.0"; not in
 * RWS 2.0 Rev L): a TRUE/FALSE flag, whether the most recent RAPID execution
 * stop was caused by an error. ABB's page shows no example answer; the shape
 * below is RW 8.2.1's answer to a raw GET, and RW 7.21.4's 404 (2026-10-06).
 */

// RW 8.2.1's answer to a raw GET (2026-10-06).
const RW821_FALSE = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:9403/rw/rapid/"/></head><body>'
  + '<div class="status"><span class="code">294912</span></div><div class="state"><a href="execution/execerrorstate" rel="self"></a><ul>'
  + '<li class="rap-execerrorstate" title="execerrorstate"><span class="execerrorstate">FALSE</span></li></ul></div></body></html>';
const RW821_TRUE = RW821_FALSE.replace('>FALSE<', '>TRUE<');
// The same entry in the hal+json form a GET negotiates first.
const HAL_TRUE = JSON.stringify({ _links: { base: { href: 'https://127.0.0.1:9403/rw/rapid/' } }, state: [{ _type: 'rap-execerrorstate', _title: 'execerrorstate', execerrorstate: 'TRUE' }] });
// RW 7.21.4's answer to the same GET (2026-10-06).
const RW7214_404 = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:9805/"/></head><body>'
  + '<div class="status"><span class="code">-1073445866</span><span class="msg">rws_services.cpp[127] Resource not found code:-1073445866 icode:-1</span></div></body></html>';

const PATH = '/rw/rapid/execution/execerrorstate';

async function serve(status: number, body: string): Promise<{ server: http.Server; url: string; urls: string[] }> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      urls.push(`${req.method} ${req.url}`);
      res.writeHead(status, { 'Content-Type': body.startsWith('{') ? 'application/hal+json;v=2.0' : 'application/xhtml+xml;v=2.0' });
      res.end(body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, urls };
}

describe('getExecutionErrorState: the path row', () => {
  it('is RWS 2.0 only, ABB\'s GET, live (RW 8.2.1, 2026-10-21)', () => {
    const op = ALL_TABLES.rapid.getExecutionErrorState;
    expect(op.rws2).toEqual({ method: 'GET', path: PATH });
    expect(op.rws1).toBeUndefined();
    expect(evidenceOf(op, 'rws2')).toBe('live');
  });
});

describe('getExecutionErrorState on RWS 2.0', () => {
  for (const [label, body, expected] of [['FALSE (RW 8.2.1)', RW821_FALSE, false], ['TRUE', RW821_TRUE, true], ['TRUE, hal+json', HAL_TRUE, true]] as const) {
    it(`reads ${label}`, async () => {
      const { server, url, urls } = await serve(200, body);
      try {
        await expect(new RwsClient2(url, 'u', 'p').getExecutionErrorState()).resolves.toBe(expected);
        expect([...new Set(urls)]).toEqual([`GET ${PATH}`]);
      } finally { server.close(); }
    });
  }

  it('RobotWare 7 answers 404: passed on as the controller\'s typed error', async () => {
    const { server, url } = await serve(404, RW7214_404);
    try {
      const err = await new RwsClient2(url, 'u', 'p').getExecutionErrorState().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect(err).toMatchObject({ httpStatus: 404, controllerCode: -1073445866 });
    } finally { server.close(); }
  });

  it('no rap-execerrorstate entry, or a value other than TRUE or FALSE: PARSE_ERROR', async () => {
    for (const body of [
      JSON.stringify({ state: [{ _type: 'rap-execution', ctrlexecstate: 'stopped' }] }),
      RW821_FALSE.replace('>FALSE<', '>maybe<'),
    ]) {
      const { server, url } = await serve(200, body);
      try {
        await expect(new RwsClient2(url, 'u', 'p').getExecutionErrorState()).rejects.toMatchObject({ code: 'PARSE_ERROR' });
      } finally { server.close(); }
    }
  });
});

describe('getExecutionErrorState through RobotManager.read', () => {
  function connected(adapter: IRWSAdapter): RobotManager {
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: IRWSAdapter; _state: { connected: boolean }; sessionEpoch: number | null; connectEpoch: number };
    m.adapter = adapter;
    m._state.connected = true;
    m.sessionEpoch = m.connectEpoch;
    return mgr;
  }

  it('RobotWare 8: the controller\'s flag', async () => {
    const { server, url } = await serve(200, RW821_TRUE);
    try {
      await expect(connected(new RWS2Adapter(url, 'u', 'p')).read('getExecutionErrorState')).resolves.toBe(true);
    } finally { server.close(); }
  });

  it('RWS 1.0 has no such resource: UNSUPPORTED_OPERATION, nothing sent', async () => {
    const urls: string[] = [];
    const client = { requestMastership: async () => {}, releaseMastership: async () => {}, request: async (_m: string, u: string) => { urls.push(u); return { status: 200, body: '' }; } };
    const mgr = connected(new RWS1Adapter(client as unknown as RwsClient));
    await expect(mgr.read('getExecutionErrorState')).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(urls).toEqual([]);
  });
});
