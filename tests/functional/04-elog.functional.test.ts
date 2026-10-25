/**
 * Functional: the event log, per controller.
 *
 *   - the domain list of each build;
 *   - `RobotManager.getEventLog` in the order each protocol lists it
 *     (RWS 1.0 newest-first, RWS 2.0 oldest-first by default);
 *   - RWS 2.0 paging past the first page of 50 in both orders: oldest-first
 *     follows the controller's next link, newest-first pages by `elogseqnum`
 *     because the `v=2.1` next link never advances (the newest-first fix);
 *   - on RWS 1.0, whether the listing returns more than one page (recorded);
 *   - `getEventLogMessage` by seqnum, for a listed message, a seqnum past the
 *     newest and a seqnum missing inside domain 0 (RobotWare 6 answers both of
 *     those with the nearest older message under 200: the client returns null);
 *   - severity (`msgtype` 1, 2 or 3 on these builds; 0 means unknown);
 *   - entity-free text in the listing and in a single-message read;
 *   - a speed-ratio write logs event 10140, the elog subscription event reaches
 *     RobotManager, and its event log is refreshed with the new message.
 *
 * Writes: same-value speed-ratio writes only (each one logs one 10140, which
 * is how a log with fewer than 51 entries is topped up to two pages). The
 * speed ratio never changes, so there is nothing to restore beyond what the
 * harness does; the event-log entries themselves cannot be removed and are
 * left, as every write leaves them.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import {
  RWS1Adapter, RWS2Adapter,
  type ElogMessage, type IRWSAdapter, type SubscriptionEvent,
} from '../../src/index.js';
import {
  forEachController, traceFile, waitFor, waitUntil, TEST_USER,
  type FunctionalContext, type Lane, type TestHandle, type TraceLine,
} from './helpers/index.js';

const FILE = '04-elog';

/** Messages per page the controllers serve (RWS 2.0 listing; RW 6.16 `?json=1`). */
const PAGE = 50;

/** Domain 0's ring size on RWS 2.0, and so the most one listing can return. */
const RWS2_DOMAIN0_BUFFER = 1000;

/** Pages to allow a full walk of domain 0 (1000 / 50 = 20, plus slack). */
const WALK_PAGES = 25;

/** The most same-value speed writes a test sends to reach a second page. */
const TOP_UP_MAX_WRITES = 60;

/** "Speed adjusted": logged once per accepted speed-ratio write. */
const SPEED_ADJUSTED = 10140;

/** Tests that may send a few dozen writes or walk 20 pages twice. */
const LONG = 120_000;

/**
 * The elog domains each build serves. Live-verified 2026-09-29 on RW 6.16.03
 * (fourteen: no 13) and on RW 7.21.4 and 8.2.1 (fifteen, the same list on
 * both; domain 0 "Common" holds 1000, every other domain 50).
 */
const RW6_DOMAINS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 15, 17];
const RWS2_DOMAINS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 15, 17];
const RWS2_DOMAIN_BUFFER = 50;

const TEXT_FIELDS = ['title', 'desc', 'causes', 'consequences', 'actions'] as const;

/** An XML/HTML entity left in decoded text. */
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i;

/** A character the controllers escape on the wire: decoded text holding one proves decoding ran. */
const ESCAPED_CHAR = /['"&<>]/;

// ─── Small helpers ───────────────────────────────────────────────────────────

const seqs = (log: ElogMessage[]): number[] => log.map(m => m.seqnum);
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function strictlyAscending(xs: number[]): boolean { return xs.every((x, i) => i === 0 || x > xs[i - 1]); }
function strictlyDescending(xs: number[]): boolean { return xs.every((x, i) => i === 0 || x < xs[i - 1]); }

function msgtypeCounts(log: ElogMessage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of log) { out[m.msgtype] = (out[m.msgtype] ?? 0) + 1; }
  return out;
}

/**
 * The adapter's elog reads that neither IRWSAdapter nor RobotManager wraps
 * (`listEventLogDomains`, `getEventLogMessage`): both concrete adapters carry
 * them under the same name.
 */
function elogReads(a: IRWSAdapter): RWS1Adapter | RWS2Adapter {
  if (a instanceof RWS1Adapter || a instanceof RWS2Adapter) { return a; }
  throw new Error(`the observer is neither an RWS1Adapter nor an RWS2Adapter (${a.constructor.name})`);
}

/** The RWS 2.0 adapter, for `getEventLog`'s `maxPages` and `order` and `getEventLogMessageBySeqnum`. */
function rws2(a: IRWSAdapter): RWS2Adapter {
  if (!(a instanceof RWS2Adapter)) { throw new Error(`expected an RWS2Adapter, got ${a.constructor.name}`); }
  return a;
}

/** True for an elog subscription event, in either spelling (RWS 2.0 friendly name, RWS 1.0 href). */
function isElogResource(resource: string): boolean {
  return resource === 'elog' || /(?:^|\/)rw\/elog(?:[/;?]|$)/.test(resource);
}

/**
 * The last response this file's trace recorded for a GET whose path matches
 * `pathRe` (status and all), or null. The client traces every response as
 * `http.res` (or `http.err` for an error status) with its path and status.
 */
function lastResponse(lane: Lane, pathRe: RegExp): { path: string; status: number | null; cat: string } | null {
  let raw: string;
  try { raw = fs.readFileSync(traceFile(lane), 'utf8'); } catch { return null; }
  const lines = raw.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let l: TraceLine;
    try { l = JSON.parse(lines[i]) as TraceLine; } catch { continue; }
    if (l.file !== FILE || (l.cat !== 'http.res' && l.cat !== 'http.err')) { continue; }
    const d = (l.data ?? {}) as { method?: string; path?: string; status?: number };
    if (d.method === 'GET' && typeof d.path === 'string' && pathRe.test(d.path)) {
      return { path: d.path, status: typeof d.status === 'number' ? d.status : null, cat: l.cat };
    }
  }
  return null;
}

const singleMessagePath = (seqnum: number): RegExp => new RegExp(`^/rw/elog/0/${seqnum}(?:\\?|$)`);
const bySeqnumPath = (seqnum: number): RegExp => new RegExp(`^/rw/elog/seqnum/${seqnum}(?:\\?|$)`);

/** The speed ratio now, for a write that changes nothing; skips when it cannot be read. */
async function currentSpeed(ctx: FunctionalContext, t: TestHandle): Promise<number> {
  const s = (await ctx.panel()).speedRatio;
  if (s === null) { return ctx.skip(t, 'the speed ratio could not be read, so no same-value write can be made'); }
  return s;
}

/** Same-value speed-ratio writes through the manager; each one logs one 10140. */
async function sameSpeedWrites(ctx: FunctionalContext, speed: number, count: number): Promise<void> {
  for (let i = 0; i < count; i++) { await ctx.manager.setSpeedRatio(speed); }
}

/** The newest seqnum in domain 0 (0 for an empty log). */
async function newestSeqnum(ctx: FunctionalContext): Promise<number> {
  if (ctx.generation === 'rws2') {
    const page = await rws2(await ctx.observer()).getEventLog(0, 'en', 1, 'newest');
    return page[0]?.seqnum ?? 0;
  }
  // RWS 1.0 lists newest-first; the max is taken anyway so no order is assumed here.
  const log = await ctx.manager.getEventLog(0, 'en');
  return log.reduce((mx, m) => Math.max(mx, m.seqnum), 0);
}

/** The domain-0 message count RWS 2.0 reports (`numevts`). */
async function domain0Count(ctx: FunctionalContext): Promise<number> {
  const domains = await elogReads(await ctx.observer()).listEventLogDomains();
  return domains.find(d => d.domain === 0)?.events ?? 0;
}

/**
 * RWS 2.0: make sure domain 0 holds more than one page, topping it up with
 * same-value speed writes when it does not (a freshly started VC can hold 35).
 */
async function ensureTwoPages(ctx: FunctionalContext, t: TestHandle): Promise<{ before: number; writes: number }> {
  const before = await domain0Count(ctx);
  if (before > PAGE) { return { before, writes: 0 }; }
  const writes = PAGE + 2 - before;
  if (writes > TOP_UP_MAX_WRITES) { return ctx.skip(t, `domain 0 holds ${before} messages; reaching a second page needs more than ${TOP_UP_MAX_WRITES} writes`); }
  const speed = await currentSpeed(ctx, t);
  ctx.note('topping domain 0 up to a second page with same-value speed writes', { before, writes, speed });
  await sameSpeedWrites(ctx, speed, writes);
  await waitUntil(async () => (await domain0Count(ctx)) > PAGE, 30000, 500, 'domain 0 holding more than one page');
  return { before, writes };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

await forEachController(FILE, ctx => {
  const isRws2 = ctx.generation === 'rws2';

  it('lists the event-log domains of this build', async () => {
    const domains = await elogReads(await ctx.observer()).listEventLogDomains();
    ctx.note('elog domains', domains);
    const ids = domains.map(d => d.domain);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(isRws2 ? RWS2_DOMAINS : RW6_DOMAINS);
    if (!isRws2) {
      // RobotWare 6 reports no per-domain counts; the client gives null for
      // both ("not reported"), not 0.
      for (const d of domains) { expect(d, `domain ${d.domain}`).toMatchObject({ events: null, bufferSize: null }); }
      return;
    }
    for (const d of domains) {
      expect(d.bufferSize, `domain ${d.domain} buffer`).toBe(d.domain === 0 ? RWS2_DOMAIN0_BUFFER : RWS2_DOMAIN_BUFFER);
      expect(d.events, `domain ${d.domain} events`).not.toBeNull();
      expect(d.events, `domain ${d.domain} events`).toBeGreaterThanOrEqual(0);
      expect(d.events, `domain ${d.domain} events`).toBeLessThanOrEqual(d.bufferSize ?? Number.NaN);
    }
  });

  it(isRws2
    ? 'RobotManager.getEventLog lists domain 0 oldest-first (the RWS 2.0 default), every seqnum once'
    : 'RobotManager.getEventLog lists domain 0 newest-first (RWS 1.0), every seqnum once', async () => {
    const log = await ctx.manager.getEventLog(0, 'en');
    expect(log.length).toBeGreaterThan(0);
    const s = seqs(log);
    expect(new Set(s).size).toBe(s.length);
    expect(isRws2 ? strictlyAscending(s) : strictlyDescending(s)).toBe(true);
    for (const m of log) {
      expect(Number.isInteger(m.seqnum) && m.seqnum > 0, `seqnum ${m.seqnum}`).toBe(true);
      expect(Number.isInteger(m.code) && m.code > 0, `code of ${m.seqnum}`).toBe(true);
      expect(m.timestamp, `timestamp of ${m.seqnum}`).not.toBe('');
    }
    ctx.note('domain 0 listing through RobotManager', { length: log.length, first: s[0], last: s[s.length - 1] });
  });

  if (isRws2) {
    it('getEventLog pages oldest-first past the first page of 50 by following the next link', async t => {
      const { before, writes } = await ensureTwoPages(ctx, t);
      const o = rws2(await ctx.observer());
      const countBefore = await domain0Count(ctx);
      const log = await o.getEventLog(0, 'en', WALK_PAGES, 'oldest');
      const countAfter = await domain0Count(ctx);
      const s = seqs(log);
      expect(log.length).toBeGreaterThan(PAGE);
      expect(log.length).toBeLessThanOrEqual(RWS2_DOMAIN0_BUFFER);
      expect(new Set(s).size).toBe(s.length);
      expect(strictlyAscending(s)).toBe(true);
      // Whether numevts counts exactly what the listing returns is not
      // recorded anywhere; this run records it.
      ctx.note('records domain 0 numevts against the oldest-first walk', {
        toppedUpFrom: before, writes, countBefore, countAfter, listed: log.length,
      });
    }, LONG);

    it('getEventLog pages newest-first past the first page by elogseqnum, matching the oldest-first walk', async t => {
      await ensureTwoPages(ctx, t);
      const o = rws2(await ctx.observer());
      const newest = await o.getEventLog(0, 'en', WALK_PAGES, 'newest');
      // How the walk ended: the page below the oldest stored entry has no
      // earlier capture (the client ends the walk on a failure there).
      const lastElogseqnumPage = lastResponse(ctx.lane, /^\/rw\/elog\/0\?.*elogseqnum=/);
      const oldest = await o.getEventLog(0, 'en', WALK_PAGES, 'oldest');
      const n = seqs(newest);
      const a = seqs(oldest);

      // The fix: page 2 is read (the v=2.1 next link would serve page 1 again).
      expect(newest.length).toBeGreaterThan(PAGE);
      expect(new Set(n).size).toBe(n.length);
      expect(strictlyDescending(n)).toBe(true);
      expect(n[PAGE]).toBeLessThan(n[PAGE - 1]);

      // Both walks list the same seqnums over the range they share. Messages
      // logged between the walks only extend the top, and a full ring only
      // drops from the bottom, so the shared range is exact.
      const lo = Math.max(Math.min(...a), Math.min(...n));
      const hi = Math.min(Math.max(...a), Math.max(...n));
      const shared = a.filter(x => x >= lo && x <= hi);
      expect(n.filter(x => x >= lo && x <= hi).reverse()).toEqual(shared);
      expect(shared.length).toBeGreaterThan(PAGE);
      const bySeq = new Map(oldest.map(m => [m.seqnum, m]));
      for (const m of newest) {
        const twin = bySeq.get(m.seqnum);
        if (twin) { expect({ code: m.code, msgtype: m.msgtype, title: m.title }, `seqnum ${m.seqnum}`).toEqual({ code: twin.code, msgtype: twin.msgtype, title: twin.title }); }
      }

      ctx.note('records the newest-first walk and its last elogseqnum page', {
        listed: newest.length, newest: n[0], oldest: n[n.length - 1], lastElogseqnumPage,
      });
    }, LONG);
  } else {
    it('records whether the RWS 1.0 listing returns more than one page of 50', async t => {
      let log = await ctx.manager.getEventLog(0, 'en');
      const firstLength = log.length;
      let writes = 0;
      if (log.length <= PAGE) {
        writes = PAGE + 2 - log.length;
        const speed = await currentSpeed(ctx, t);
        const top = log.reduce((mx, m) => Math.max(mx, m.seqnum), 0);
        ctx.note('topping domain 0 up past one page with same-value speed writes', { firstLength, writes, speed });
        await sameSpeedWrites(ctx, speed, writes);
        await waitUntil(async () => {
          const l = await ctx.manager.getEventLog(0, 'en');
          return l.filter(m => m.code === SPEED_ADJUSTED && m.seqnum > top).length >= Math.min(writes, PAGE);
        }, 30000, 500, `${writes} new ${SPEED_ADJUSTED} messages listed`);
        log = await ctx.manager.getEventLog(0, 'en');
      }
      const s = seqs(log);
      expect(new Set(s).size).toBe(s.length);
      expect(strictlyDescending(s)).toBe(true);
      // Domain 0 now holds more than 50; the listing is either all of it or one page.
      expect(log.length).toBeGreaterThanOrEqual(PAGE);

      // Are there older messages the listing left out? RobotWare 6 answers a
      // missing seqnum with an older message, which the client returns as
      // null, so a non-null read below the oldest listed seqnum is an older
      // message that exists under exactly that seqnum.
      const reads = elogReads(await ctx.observer());
      const oldestListed = s[s.length - 1];
      let olderFound: number | null = null;
      for (let q = oldestListed - 1; q >= Math.max(1, oldestListed - 10) && olderFound === null; q--) {
        if (await reads.getEventLogMessage(0, q)) { olderFound = q; }
      }
      ctx.note('records the RWS 1.0 domain 0 listing size', {
        firstLength, writes, listed: log.length, moreThanOnePage: log.length > PAGE,
        oldestListed, olderMessageBelowListing: olderFound,
      });
    }, LONG);
  }

  it('getEventLogMessage reads a listed message with the fields the listing shows', async () => {
    const log = await ctx.manager.getEventLog(0, 'en');
    expect(log.length).toBeGreaterThan(0);
    const byAge = [...log].sort((x, y) => y.seqnum - x.seqnum);
    // The newest and one from the middle (the oldest may leave a full ring meanwhile).
    const picks = [byAge[0], byAge[Math.floor(byAge.length / 2)]].filter((m, i, arr) => arr.indexOf(m) === i);
    const reads = elogReads(await ctx.observer());
    for (const listed of picks) {
      const single = await reads.getEventLogMessage(0, listed.seqnum, 'en');
      expect(single, `seqnum ${listed.seqnum}`).not.toBeNull();
      expect({
        seqnum: single!.seqnum, code: single!.code, msgtype: single!.msgtype,
        title: norm(single!.title), desc: norm(single!.desc),
      }, `seqnum ${listed.seqnum}`).toEqual({
        seqnum: listed.seqnum, code: listed.code, msgtype: listed.msgtype,
        title: norm(listed.title), desc: norm(listed.desc),
      });
      if (JSON.stringify(single!.args.map(x => x.value)) !== JSON.stringify(listed.args.map(x => x.value))
        || single!.timestamp !== listed.timestamp) {
        ctx.note('records a difference between the listing and the single read in args or timestamp', { listed, single });
      }
    }
  });

  it('getEventLogMessage returns null for a seqnum past the newest (answered 200 with the newest message) and for seqnum 0', async () => {
    const newest = await newestSeqnum(ctx);
    expect(newest).toBeGreaterThan(0);
    // Far past the newest, so no message logged meanwhile can take it.
    const missing = newest + 10000;
    const reads = elogReads(await ctx.observer());

    expect(await reads.getEventLogMessage(0, missing, 'en')).toBeNull();
    const pastNewest = lastResponse(ctx.lane, singleMessagePath(missing));
    ctx.note('records the answer to a seqnum past the newest', { newest, missing, response: pastNewest });
    // Both generations answer a domain-0 seqnum past the newest with 200 and
    // the nearest older (here the newest) message; the null comes from the
    // client comparing the seqnum the entry's title / self link names with the
    // one it asked for. Live-verified 2026-09-29 on RW 6.16.03, and 2026-09-30
    // on RW 7.21.4+417 and 8.2.1+1023 (neither answers 204 here).
    // A 204 would also be safe for the caller, but it would mean the build
    // changed, so it fails here to get the expectation revisited.
    expect(pastNewest?.status).toBe(200);

    if (isRws2) {
      // The global by-seqnum lookup: null is what matters; its status for a
      // seqnum past the newest has not been recorded yet, so this run records it.
      expect(await rws2(reads).getEventLogMessageBySeqnum(missing, 'en')).toBeNull();
      ctx.note('records the by-seqnum answer past the newest', { response: lastResponse(ctx.lane, bySeqnumPath(missing)) });
    }

    expect(await reads.getEventLogMessage(0, 0, 'en')).toBeNull();
    const zero = lastResponse(ctx.lane, singleMessagePath(0));
    ctx.note('records the answer to seqnum 0', { generation: isRws2 ? 'RWS 2.0' : 'RWS 1.0', response: zero });
    // Live-verified 2026-09-29 on RW 6.16.03: seqnum 0 answers 204 with no body.
    // On RWS 2.0 (7.21.4, 8.2.1) the seqnum 0 answer is not recorded yet; only
    // the client's null is asserted there and the status is noted above.
    if (!isRws2) { expect(zero?.status).toBe(204); }
  });

  it(isRws2
    ? 'getEventLogMessage never relabels another message for a seqnum missing inside domain 0 (records what it reads as)'
    : 'getEventLogMessage returns null for a seqnum missing inside domain 0, which RobotWare 6 answers with the nearest older message', async t => {
    const log = await ctx.manager.getEventLog(0, 'en');
    const asc = seqs(log).sort((x, y) => x - y);
    // The newest gap, so it lies well inside the listed range.
    let gap: number | null = null;
    for (let i = asc.length - 1; i > 0 && gap === null; i--) {
      if (asc[i] - asc[i - 1] > 1) { gap = asc[i] - 1; }
    }
    if (gap === null) { return ctx.skip(t, 'domain 0 lists no seqnum gap, so there is no missing seqnum inside it to read'); }
    const nearestOlder = asc.filter(x => x < gap!).pop();
    const reads = elogReads(await ctx.observer());
    const got = await reads.getEventLogMessage(0, gap, 'en');
    const res = lastResponse(ctx.lane, singleMessagePath(gap));

    if (!isRws2) {
      // Live-verified 2026-09-29 on RW 6.16.03: seqnum 26 (absent; 25 and 27
      // listed) answered 200 with the message titled /rw/elog/0/25.
      ctx.note('a seqnum missing inside domain 0', { gap, nearestOlder, response: res });
      expect(got).toBeNull();
      expect(res?.status).toBe(200);
      return;
    }
    // RWS 2.0: most domain-0 gaps are Internal (domain 10) entries, which the
    // global lookup returns (code 100000); some seqnums are stored in no
    // domain, which it answers 204. What the domain-0 resource answers for a
    // gap is not recorded; this run records it.
    const global = await rws2(reads).getEventLogMessageBySeqnum(gap, 'en');
    ctx.note('records a seqnum missing inside domain 0', {
      gap, nearestOlder,
      domain0: { response: res, message: got && { seqnum: got.seqnum, code: got.code, msgtype: got.msgtype, title: got.title } },
      bySeqnum: {
        response: lastResponse(ctx.lane, bySeqnumPath(gap)),
        message: global && { seqnum: global.seqnum, code: global.code, msgtype: global.msgtype, title: global.title },
      },
    });
    if (got) {
      expect(got.seqnum).toBe(gap);
      // Never the nearest older listed message relabelled (the RWS 1.0 behaviour).
      const older = log.find(m => m.seqnum === nearestOlder);
      if (older) { expect({ code: got.code, title: got.title }).not.toEqual({ code: older.code, title: older.title }); }
    }
    if (global) { expect(global.seqnum).toBe(gap); }
  });

  it('reports severity as msgtype 1, 2 or 3 on every message of this build (0 would mean unknown)', async () => {
    const log = await ctx.manager.getEventLog(0, 'en');
    expect(log.length).toBeGreaterThan(0);
    ctx.note('records the msgtype distribution of domain 0', msgtypeCounts(log));
    for (const m of log) { expect([1, 2, 3], `msgtype of seqnum ${m.seqnum}`).toContain(m.msgtype); }
    // The single-message read is the path ABB's RW 6.15.04 correction names
    // ("RWS Elog Message Get missing response parameter"): read a few there too.
    const reads = elogReads(await ctx.observer());
    const newestFirst = [...log].sort((x, y) => y.seqnum - x.seqnum).slice(0, 5);
    for (const listed of newestFirst) {
      const single = await reads.getEventLogMessage(0, listed.seqnum, 'en');
      expect(single, `seqnum ${listed.seqnum}`).not.toBeNull();
      expect(single!.msgtype, `single-read msgtype of seqnum ${listed.seqnum}`).toBe(listed.msgtype);
    }
  });

  it('serves entity-free text in the listing and in a single-message read', async () => {
    const log = await ctx.manager.getEventLog(0, 'en');
    for (const m of log) {
      for (const f of TEXT_FIELDS) { expect(m[f], `${f} of seqnum ${m.seqnum}`).not.toMatch(ENTITY); }
    }
    // Messages whose decoded text holds a character the wire escapes: reading
    // one singly exercises the single-message decoding (e.g. an apostrophe,
    // served as &apos; in the RW 7.21.4 and 8.2.1 hal+json).
    const special = log.filter(m => TEXT_FIELDS.some(f => ESCAPED_CHAR.test(m[f])));
    ctx.note('records messages whose text holds an escaped character', {
      count: special.length, codes: [...new Set(special.map(m => m.code))].slice(0, 20),
    });
    const newestFirst = [...log].sort((x, y) => y.seqnum - x.seqnum);
    const samples = special.length ? [...special].sort((x, y) => y.seqnum - x.seqnum).slice(0, 3) : newestFirst.slice(0, 1);
    const reads = elogReads(await ctx.observer());
    for (const listed of samples) {
      const single = await reads.getEventLogMessage(0, listed.seqnum, 'en');
      expect(single, `seqnum ${listed.seqnum}`).not.toBeNull();
      for (const f of TEXT_FIELDS) {
        expect(single![f], `${f} of seqnum ${listed.seqnum} (single read)`).not.toMatch(ENTITY);
        expect(norm(single![f]), `${f} of seqnum ${listed.seqnum}: single read against listing`).toBe(norm(listed[f]));
      }
    }
  });

  it('a speed-ratio write logs event 10140, and RobotManager delivers the elog event and refreshes its event log', async t => {
    const m = ctx.manager;
    const speed = await currentSpeed(ctx, t);
    const live = await waitFor(() => m.state.quality === 'live', 10000);
    if (!live) {
      return ctx.skip(t, `the manager's subscription is not live (quality ${m.state.quality}), so the elog event path cannot be observed`);
    }
    const before = await newestSeqnum(ctx);
    const events: SubscriptionEvent[] = [];
    const off = m.onSubscriptionEvent(e => { if (isElogResource(e.resource)) { events.push(e); } });
    const isNew = (x: ElogMessage): boolean => x.code === SPEED_ADJUSTED && x.seqnum > before;
    try {
      await m.setSpeedRatio(speed);
      await waitUntil(() => events.length > 0, 15000, 100, 'an elog subscription event after the speed write');
      await waitUntil(() => m.state.eventLog.some(isNew), 20000, 250, `RobotManager.state.eventLog holding the new ${SPEED_ADJUSTED}`);
    } finally {
      off();
    }
    ctx.note('elog events after the speed write', events.map(e => ({ resource: e.resource, value: e.value })));

    const logged = m.state.eventLog.filter(isNew);
    // One 10140 per accepted write, a same-value write included (live-verified
    // 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1).
    expect(logged).toHaveLength(1);
    const msg = logged[0];
    ctx.note(`the ${SPEED_ADJUSTED} message`, msg);
    expect([1, 2, 3]).toContain(msg.msgtype);
    for (const f of TEXT_FIELDS) { expect(msg[f], f).not.toMatch(ENTITY); }
    // "Speed adjusted ... by Default User": the value and the user arrive as arguments.
    const argValues = msg.args.map(a => a.value);
    expect(argValues).toContain(String(speed));
    expect(argValues).toContain(TEST_USER);
    // The refreshed log keeps the protocol's order, so the new message sits at the newest end.
    const newestEnd = isRws2 ? m.state.eventLog[m.state.eventLog.length - 1] : m.state.eventLog[0];
    expect(newestEnd.seqnum).toBeGreaterThanOrEqual(msg.seqnum);

    // The same message by seqnum.
    const reads = elogReads(await ctx.observer());
    const single = await reads.getEventLogMessage(0, msg.seqnum, 'en');
    expect(single).not.toBeNull();
    expect({ seqnum: single!.seqnum, code: single!.code, msgtype: single!.msgtype, title: norm(single!.title) })
      .toEqual({ seqnum: msg.seqnum, code: SPEED_ADJUSTED, msgtype: msg.msgtype, title: norm(msg.title) });
    if (isRws2) {
      const global = await rws2(reads).getEventLogMessageBySeqnum(msg.seqnum, 'en');
      expect(global?.code).toBe(SPEED_ADJUSTED);
    }
    // The write changed nothing.
    expect((await ctx.panel()).speedRatio).toBe(speed);
  }, LONG);
});
