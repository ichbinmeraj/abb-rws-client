import { describe, it, expect } from 'vitest';
import { RwsClient } from '../src/RwsClient.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsError, type ElogMessage } from '../src/types.js';

/**
 * The RWS 1.0 event log beyond its newest page. ABB's "Get elog messages in
 * domain" (RWS 1.0 Rev M) lists the messages of one domain; RW 6.16.03 lists
 * them newest first, 50 a page, with a `next` link
 * (`0?order=lifo&lang=en&start=2&limit=50`) that served the older messages,
 * and no `next` link on the last page (2026-09-29). The pages below are
 * ABB's Rev M example, split in two along that link.
 */

const page = (items: Array<[number, number]>, next?: string): string =>
  '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Elog</title><base href="http://127.0.0.1/rw/elog/"/></head><body>'
  + `<div class="state"><a href="0" rel="self"></a>${next ? `<a href="${next}" rel="next"></a>` : ''}<ul>`
  + items.map(([seq, code]) => `<li class="elog-message-li" title="/rw/elog/0/${seq}"><a href="0/${seq}" rel="self"></a>`
    + `<span class="msgtype">1</span><span class="code">${code}</span><span class="src-name">MC0</span><span class="tstamp">2013-09-08 T 11:22:09</span><span class="argc">0</span></li>`).join('')
  + '</ul></div></body></html>';

// ABB's Rev M example (messages 5, 4, 3), then the older ones on page 2.
const PAGE1 = page([[5, 10015], [4, 10013], [3, 10002]], '0?order=lifo&amp;lang=en&amp;start=2&amp;limit=50');
const PAGE2 = page([[2, 10010], [1, 10011]]);
const FIRST = '/rw/elog/0?lang=en';
const SECOND = '/rw/elog/0?order=lifo&lang=en&start=2&limit=50';

/** An RwsClient whose session answers from `routes`, recording each GET. */
function clientWith(routes: Record<string, string | Error>): { client: RwsClient; gets: string[] } {
  const gets: string[] = [];
  const client = new RwsClient({ host: '127.0.0.1', port: 1, username: 'u', password: 'p' });
  (client as unknown as { session: unknown }).session = {
    get: async (path: string) => {
      gets.push(path);
      const r = routes[path];
      if (r === undefined) { throw new RwsError(`no route ${path}`, 'RESOURCE_NOT_FOUND', 404); }
      if (r instanceof Error) { throw r; }
      return { status: 200, body: r, headers: new Headers() };
    },
  };
  return { client, gets };
}

const seqs = (log: ElogMessage[]): number[] => log.map(m => m.seqnum);

describe('RwsClient.getEventLog reads every page', () => {
  it('follows the next link to the older messages, newest first', async () => {
    const { client, gets } = clientWith({ [FIRST]: PAGE1, [SECOND]: PAGE2 });
    expect(seqs(await client.getEventLog(0, 'en'))).toEqual([5, 4, 3, 2, 1]);
    expect(gets).toEqual([FIRST, SECOND]);
  });

  it('maxPages 1 reads the newest page only, as up to 1.4.x', async () => {
    const { client, gets } = clientWith({ [FIRST]: PAGE1, [SECOND]: PAGE2 });
    expect(seqs(await client.getEventLog(0, 'en', 1))).toEqual([5, 4, 3]);
    expect(gets).toEqual([FIRST]);
  });

  it('a message listed on two pages (logged during the walk) is kept once', async () => {
    const shifted = page([[3, 10002], [2, 10010], [1, 10011]]);
    const { client } = clientWith({ [FIRST]: PAGE1, [SECOND]: shifted });
    expect(seqs(await client.getEventLog())).toEqual([5, 4, 3, 2, 1]);
  });

  it('a later page that fails ends the walk with the messages read; the first page\'s failure is thrown', async () => {
    const down = new RwsError('timeout', 'NETWORK_ERROR');
    const later = clientWith({ [FIRST]: PAGE1, [SECOND]: down });
    expect(seqs(await later.client.getEventLog())).toEqual([5, 4, 3]);
    const first = clientWith({ [FIRST]: down });
    await expect(first.client.getEventLog()).rejects.toBe(down);
  });

  it('a next link back to a page already read, or to another resource, ends the walk', async () => {
    const loop = page([[5, 10015]], '0?lang=en');
    const away = page([[5, 10015]], '1?lang=en');
    for (const body of [loop, away]) {
      const { client, gets } = clientWith({ [FIRST]: body });
      expect(seqs(await client.getEventLog())).toEqual([5]);
      expect(gets).toEqual([FIRST]);
    }
  });
});

describe('RobotManager on RWS 1.0', () => {
  function rig(): { mgr: RobotManager; calls: Array<unknown[]> } {
    const calls: Array<unknown[]> = [];
    const fake = {
      requestMastership: async () => {},
      releaseMastership: async () => {},
      getEventLog: async (...args: unknown[]) => { calls.push(args); return []; },
    };
    const mgr = new RobotManager();
    const m = mgr as unknown as { adapter: IRWSAdapter; _state: { connected: boolean } };
    m.adapter = new RWS1Adapter(fake as unknown as RwsClient);
    m._state.connected = true;
    return { mgr, calls };
  }

  it('getEventLog() reads every page (the adapter\'s default)', async () => {
    const { mgr, calls } = rig();
    await mgr.getEventLog(0, 'en');
    expect(calls).toEqual([[0, 'en', undefined]]);
  });

  it('state.eventLog still holds the newest page: the manager\'s own reads ask for one', async () => {
    const { mgr, calls } = rig();
    await (mgr as unknown as { refreshEventLog(): Promise<void> }).refreshEventLog();
    expect(calls).toEqual([[0, 'en', 1]]);
  });
});
