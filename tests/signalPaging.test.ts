import { describe, it, expect, afterEach } from 'vitest';
import { RwsClient } from '../src/RwsClient.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { setLogger } from '../src/Logger.js';
import { RwsError, type Signal } from '../src/types.js';

/**
 * The RWS 1.0 signal list beyond its first page. Up to 1.4.x the client sent
 * one `GET /rw/iosystem/signals?start=0&limit=100` and returned that page, so
 * an IRC5 with more than 100 signals showed only the first 100 (in the
 * client's signal table and in everything built on it). RWS 1.0 links the
 * next page from each page (`<a href="..." rel="next">`, the form of ABB's
 * RWS 1.0 manual Rev M for its paged lists), and the client now follows each
 * link as given, as RWS 2.0's listAllSignals does.
 *
 * The bodies are ABB's "Get IO Signals" example (RWS 1.0 Rev M) with more
 * entries. RW 6.16.03 (62 signals) honours `limit`: the functional suite read
 * it in pages of 20 by `start` (2026-10-22), but whether those pages carry a
 * `next` link was not recorded, so the links here are constructed: in
 * page-number form (`start=2&limit=100`, the form RW 6.16.03's event log used
 * for its second page, 2026-09-29) and in offset form, to show the client
 * sends what the controller links and never computes a `start` itself.
 */

const FIRST = '/rw/iosystem/signals?start=0&limit=100';

const entry = (name: string, type = 'DO'): string =>
  `<li class="ios-signal-li" title="Local/DRV_1/${name}"><a href="signals/Local/DRV_1/${name}" rel="self"/>`
  + `<span class="name">${name}</span><span class="type">${type}</span><span class="category">safety</span>`
  + '<span class="lvalue">0</span><span class="lstate">simulated</span></li>';

/** One RWS 1.0 signal-list page: `names` as entries, and a `next` link when given (href as served, `&amp;`). */
const page = (names: string[], next?: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>io</title>'
  + '<base href="http://127.0.0.1/rw/iosystem/"/></head><body><div class="state">'
  + '<a href="signals" rel="self"/><a href="signals?action=show" rel="action"/>'
  + (next ? `<a href="${next}" rel="next"/>` : '')
  + `<ul>${names.map(n => entry(n)).join('')}</ul></div></body></html>`;

/** `n` signal names from `from`: SIG000, SIG001, ... */
const names = (from: number, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `SIG${String(from + i).padStart(3, '0')}`);

/**
 * An RwsClient whose session answers from `routes`, recording each GET and
 * how many were in flight at once.
 */
function clientWith(routes: Record<string, string | Error>): { client: RwsClient; gets: string[]; maxInFlight: () => number } {
  const gets: string[] = [];
  let inFlight = 0;
  let most = 0;
  const client = new RwsClient({ host: '127.0.0.1', port: 1, username: 'u', password: 'p' });
  (client as unknown as { session: unknown }).session = {
    get: async (path: string) => {
      gets.push(path);
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        await new Promise(r => setTimeout(r, 1));
        const r = routes[path];
        if (r === undefined) { throw new RwsError(`no route ${path}`, 'RESOURCE_NOT_FOUND', 404); }
        if (r instanceof Error) { throw r; }
        return { status: 200, body: r, headers: new Headers() };
      } finally {
        inFlight--;
      }
    },
  };
  return { client, gets, maxInFlight: () => most };
}

const signalNames = (s: Signal[]): string[] => s.map(x => x.name);

/** The warnings the client logs from now on (the logger is reset after each test). */
function logWarnings(): string[] {
  const warnings: string[] = [];
  setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
  return warnings;
}

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('RWS 1.0 listAllSignals follows the controller\'s pages', () => {
  it('250 signals over 3 pages: every signal, in order, one request after the other', async () => {
    const SECOND = '/rw/iosystem/signals?start=2&limit=100';
    const THIRD = '/rw/iosystem/signals?start=3&limit=100';
    const { client, gets, maxInFlight } = clientWith({
      [FIRST]: page(names(0, 100), 'signals?start=2&amp;limit=100'),
      [SECOND]: page(names(100, 100), 'signals?start=3&amp;limit=100'),
      [THIRD]: page(names(200, 50)),
    });
    const all = await client.listAllSignals();
    expect(all).toHaveLength(250);
    expect(signalNames(all)).toEqual(names(0, 250));
    expect(all[249]).toEqual({ name: 'SIG249', value: '0', type: 'DO', lvalue: '0' });
    expect(gets).toEqual([FIRST, SECOND, THIRD]);
    expect(maxInFlight()).toBe(1);
  });

  it('sends the link the controller gives, in offset form too', async () => {
    const SECOND = '/rw/iosystem/signals?start=100&limit=100';
    const { client, gets } = clientWith({
      [FIRST]: page(names(0, 100), 'signals?start=100&amp;limit=100'),
      [SECOND]: page(names(100, 30)),
    });
    expect(await client.listAllSignals()).toHaveLength(130);
    expect(gets).toEqual([FIRST, SECOND]);
  });

  it('a start other than 0 returns every signal from there to the end, not one page (a change from 1.4.x)', async () => {
    const FROM = '/rw/iosystem/signals?start=20&limit=20';
    const routes: Record<string, string> = {};
    for (let from = 20; from < 62; from += 20) {
      const left = Math.min(20, 62 - from);
      const next = from + 20 < 62 ? `signals?start=${from + 20}&amp;limit=20` : undefined;
      routes[`/rw/iosystem/signals?start=${from}&limit=20`] = page(names(from, left), next);
    }
    const { client, gets } = clientWith(routes);
    expect(signalNames(await client.listAllSignals(20, 20))).toEqual(names(20, 42));
    expect(gets).toEqual([FROM, '/rw/iosystem/signals?start=40&limit=20', '/rw/iosystem/signals?start=60&limit=20']);
  });

  it('exactly 100 signals: one request when the page has no next link, and the full page is logged once', async () => {
    const warnings = logWarnings();
    const { client, gets } = clientWith({ [FIRST]: page(names(0, 100)) });
    expect(signalNames(await client.listAllSignals())).toEqual(names(0, 100));
    expect(gets).toEqual([FIRST]);
    expect(warnings).toEqual([
      `listAllSignals: the page ${FIRST} is full (100 signals) and links no next page; returned 100 signals, which may not be all of them (logged once)`,
    ]);
    await client.listAllSignals();
    expect(warnings).toHaveLength(1);
  });

  it('a page that is not full and has no next link ends the walk silently', async () => {
    const warnings = logWarnings();
    const { client } = clientWith({ [FIRST]: page(names(0, 99)) });
    expect(await client.listAllSignals()).toHaveLength(99);
    expect(warnings).toEqual([]);
  });

  it('a next link in a form the walk does not read ends it, and says so with the link', async () => {
    const warnings = logWarnings();
    const relFirst = page(names(0, 100)).replace('<ul>', '<a rel="next" href="signals?start=2&amp;limit=100"/><ul>');
    const { client, gets } = clientWith({ [FIRST]: relFirst });
    expect(await client.listAllSignals()).toHaveLength(100);
    expect(gets).toEqual([FIRST]);
    expect(warnings).toEqual([
      `listAllSignals: the page ${FIRST} links a next page the walk does not follow (<a rel="next" href="signals?start=2&amp;limit=100"/>); `
      + 'returned 100 signals, which may not be all of them (logged once)',
    ]);
  });

  it('exactly 100 signals with a next link to an empty page: 100 signals, and the walk ends there', async () => {
    const SECOND = '/rw/iosystem/signals?start=2&limit=100';
    const { client, gets } = clientWith({
      [FIRST]: page(names(0, 100), 'signals?start=2&amp;limit=100'),
      [SECOND]: page([]),
    });
    expect(signalNames(await client.listAllSignals())).toEqual(names(0, 100));
    expect(gets).toEqual([FIRST, SECOND]);
  });

  it('an empty page ends the walk, also when it carries a next link', async () => {
    const empty = clientWith({ [FIRST]: page([]) });
    expect(await empty.client.listAllSignals()).toEqual([]);
    expect(empty.gets).toEqual([FIRST]);

    const SECOND = '/rw/iosystem/signals?start=2&limit=100';
    const linked = clientWith({
      [FIRST]: page(names(0, 100), 'signals?start=2&amp;limit=100'),
      [SECOND]: page([], 'signals?start=3&amp;limit=100'),
    });
    expect(await linked.client.listAllSignals()).toHaveLength(100);
    expect(linked.gets).toEqual([FIRST, SECOND]);
  });

  it('the 62 signals of the RobotWare 6.16.03 virtual controller: one page, one request, as before', async () => {
    const { client, gets } = clientWith({ [FIRST]: page(names(0, 62)) });
    expect(await client.listAllSignals()).toHaveLength(62);
    expect(gets).toEqual([FIRST]);
  });

  it('a page that fails fails the whole read: part of the table is never returned as all of it', async () => {
    const down = new RwsError('timeout', 'NETWORK_ERROR');
    const { client } = clientWith({
      [FIRST]: page(names(0, 100), 'signals?start=2&amp;limit=100'),
      '/rw/iosystem/signals?start=2&limit=100': down,
    });
    await expect(client.listAllSignals()).rejects.toBe(down);
  });

  it('a next link back to a page already read, or to another resource, ends the walk', async () => {
    const warnings = logWarnings();
    const loop = clientWith({ [FIRST]: page(names(0, 100), 'signals?start=0&amp;limit=100') });
    expect(await loop.client.listAllSignals()).toHaveLength(100);
    expect(loop.gets).toEqual([FIRST]);
    expect(warnings).toEqual([]);

    const away = clientWith({ [FIRST]: page(names(0, 100), 'devices?start=2&amp;limit=100') });
    expect(await away.client.listAllSignals()).toHaveLength(100);
    expect(away.gets).toEqual([FIRST]);
    // A link elsewhere is not followed, and is logged with the link as served.
    expect(warnings).toEqual([expect.stringContaining('links a next page the walk does not follow (<a href="devices?start=2&amp;limit=100" rel="next"/>)')]);
  });

  it('stops after maxPages and says so', async () => {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m) { warnings.push(m); }, error() {}, show() {} });
    const routes: Record<string, string> = {};
    for (let p = 1; p <= 5; p++) {
      const path = p === 1 ? FIRST : `/rw/iosystem/signals?start=${p}&limit=100`;
      routes[path] = page(names((p - 1) * 100, 100), `signals?start=${p + 1}&amp;limit=100`);
    }
    const { client, gets } = clientWith(routes);
    expect(await client.listAllSignals(0, 100, 3)).toHaveLength(300);
    expect(gets).toHaveLength(3);
    expect(warnings).toEqual([expect.stringContaining('listAllSignals: stopped after 3 pages with 300 signals')]);
  });

  it('the default cap is 50 pages, as on RWS 2.0', async () => {
    const routes: Record<string, string> = {};
    for (let p = 1; p <= 60; p++) {
      const path = p === 1 ? FIRST : `/rw/iosystem/signals?start=${p}&limit=100`;
      routes[path] = page([`S${p}`], `signals?start=${p + 1}&amp;limit=100`);
    }
    const { client, gets } = clientWith(routes);
    expect(await client.listAllSignals()).toHaveLength(50);
    expect(gets).toHaveLength(50);
  });
});

describe('RobotManager.refreshIoSignals on RWS 1.0', () => {
  it('lands all 250 signals of a 3-page list in state.ioSignals, through the RWS 1.0 adapter', async () => {
    const { client, gets } = clientWith({
      [FIRST]: page(names(0, 100), 'signals?start=2&amp;limit=100'),
      '/rw/iosystem/signals?start=2&limit=100': page(names(100, 100), 'signals?start=3&amp;limit=100'),
      '/rw/iosystem/signals?start=3&limit=100': page(names(200, 50)),
    });
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: IRWSAdapter; _state: { connected: boolean } };
    m.adapter = new RWS1Adapter(client);
    m._state.connected = true;
    await mgr.refreshIoSignals();
    expect(mgr.state.ioSignals).toHaveLength(250);
    expect(mgr.state.ioSignals[249].name).toBe('SIG249');
    expect(mgr.state.ioSignalsLoaded).toBe(true);
    expect(gets).toHaveLength(3);
  });
});
