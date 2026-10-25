/**
 * Functional: live events, per controller.
 *
 * - `RobotManager` comes up with live (event) quality after connect, and its
 *   one subscription group binds every resource it asked for: controller
 *   state, operation mode, speed ratio, execution, collision-detection state
 *   and the domain-0 event log. On RWS 1.0 this is also the check that the
 *   partial-bind detection (a panel resource dropped because another group
 *   holds it in the other spelling) leaves a normal subscribe whole.
 * - Speed-ratio, controller-state and execution-state changes arrive as
 *   events well inside the manager's slow poll, and the manager's state
 *   follows them.
 * - An adapter's unsubscribe and `RobotManager.disconnect` leave no group
 *   behind: the session's own `GET /subscription` lists nothing afterwards,
 *   and the manager deletes its group before it logs out.
 * - After its connections drop, a subscription comes back by itself and
 *   delivers events again. The drop is made on the client side, at a local
 *   TCP relay the adapter connects through (the client re-anchors the event
 *   socket on the host and port it was configured with, so the socket runs
 *   through the relay too); the public API has no call that closes only the
 *   event socket.
 *
 * The client has no call that lists subscription groups, and the listing is
 * per session (a session sees only its own groups: live-verified 2026-09-29 on
 * RW 6.16.03). So the listing is read with a plain `GET /subscription` that
 * rides the adapter's own session: its cookie, from the public
 * `getSessionCookie()`, and no credentials, so no session is ever opened by it.
 *
 * Writes: speed ratio (one step away from the current value and back), motors
 * off/on on RW6 and RW7 in Auto, a RAPID start and stop of a ZZ_PROBE module
 * with no motion; everything is put back in the test and again by the
 * harness's restore.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { it, expect } from 'vitest';
import type { IRWSAdapter, RobotManager, SubscriptionEvent } from '../../src/index.js';
import {
  forEachController, assertLocalhost, traceFile, waitFor, waitUntil, zzExecModule, HOST,
  type FunctionalContext, type TestHandle, type TraceLine,
} from './helpers/index.js';

const FILE = '10-subscriptions';

// ─── Budgets ─────────────────────────────────────────────────────────────────

/** How long the manager may take to report live quality. */
const LIVE_WAIT_MS = 15_000;

/**
 * The most an event may lag the write that caused it. "A few hundred ms" is
 * the expectation (a speed-ratio frame came 142-156 ms after the write,
 * live-verified 2026-09-27 on RW 7.21.0); the budget leaves room for a loaded
 * virtual controller and is still far below the manager's slow poll (5 x its
 * 1 s refresh while events stream), so an update inside it is event-driven.
 */
const EVENT_BUDGET_MS = 1000;

/**
 * Motors on and off are controller transitions, not a value write: the event
 * follows the transition, which the controller answers before it completes.
 * Still well below the slow poll.
 */
const CTRL_EVENT_BUDGET_MS = 3000;

/** How long to wait for an event at all, so a late event is reported with its lag instead of as missing. */
const EVENT_WAIT_MS = 10_000;

/** The window in which a same-value write is watched for an event. */
const QUIET_WINDOW_MS = 1500;

/** How long a dropped stream may take to come back (first retry after 0.5 s on RWS 2.0, 1 s on RWS 1.0). */
const RESTORE_WAIT_MS = 30_000;

/** Tests that switch motors, run RAPID or drop and restore a stream. */
const LONG = 120_000;

// ─── Resource names ──────────────────────────────────────────────────────────

/** The six resources `RobotManager` subscribes on connect. */
const MANAGER_RESOURCES = ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', 'elog'] as const;

/**
 * The resource name of a subscription event or group member. The RWS 2.0
 * client already maps its events to friendly names; RWS 1.0 events and every
 * group listing carry the href. Anchored like the client's own mapping, so a
 * signal whose name merely contains a panel word never matches.
 */
function resourceName(resource: string): string {
  if ((MANAGER_RESOURCES as readonly string[]).includes(resource)) { return resource; }
  const p = resource.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\/?/, '/');
  if (/^\/rw\/panel\/(?:ctrlstate|ctrl-state)(?:[;/?]|$)/.test(p)) { return 'controllerstate'; }
  if (/^\/rw\/panel\/opmode(?:[;/?]|$)/.test(p)) { return 'operationmode'; }
  if (/^\/rw\/panel\/speedratio(?:[;/?]|$)/.test(p)) { return 'speedratio'; }
  if (/^\/rw\/panel\/coldetstate(?:[;/?]|$)/.test(p)) { return 'coldetstate'; }
  if (/^\/rw\/rapid\/execution;ctrlexecstate(?:[;/?]|$)/.test(p)) { return 'execution'; }
  if (/^\/rw\/elog\/\d+(?:[;/?]|$)/.test(p)) { return 'elog'; }
  return resource;
}

// ─── Event recording ─────────────────────────────────────────────────────────

interface Seen { name: string; value: string; at: number }

/** Record every event a manager's subscription delivers (arrival time included). */
function tapManager(m: RobotManager): { seen: Seen[]; off: () => void } {
  const seen: Seen[] = [];
  const off = m.onSubscriptionEvent(e => { seen.push({ name: resourceName(e.resource), value: e.value, at: Date.now() }); });
  return { seen, off };
}

/** The first recorded event of `name` from index `from` on whose value satisfies `pred`; throws after `timeoutMs`. */
async function awaitEvent(
  seen: Seen[], name: string, pred: (value: string) => boolean, from: number, label: string, timeoutMs = EVENT_WAIT_MS,
): Promise<Seen> {
  let hit: Seen | undefined;
  await waitUntil(() => {
    hit = seen.slice(from).find(s => s.name === name && pred(s.value));
    return hit !== undefined;
  }, timeoutMs, 25, label);
  return hit!;
}

// ─── The session's own subscription listing ─────────────────────────────────

/**
 * `GET <path>` on the adapter's own session: its cookie, no credentials (a
 * refused cookie is answered 401 and opens nothing), straight to the
 * controller's port. Subscription listings are XHTML whatever is asked for
 * (live-verified 2026-09-29 on RW 6.16.03), so XHTML is asked for.
 */
async function sessionGet(ctx: FunctionalContext, adapter: IRWSAdapter, path: string): Promise<{ status: number; body: string }> {
  assertLocalhost(ctx.host);
  const cookie = adapter.getSessionCookie();
  if (!cookie) { throw new Error(`${ctx.lane}: the adapter holds no session cookie to read ${path} with`); }
  const accept = ctx.generation === 'rws2' ? 'application/xhtml+xml;v=2.0' : 'application/xhtml+xml';
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      host: ctx.host, port: ctx.port, path, method: 'GET', agent: false, timeout: 8000,
      headers: { Accept: accept, Cookie: cookie },
      ...(ctx.https ? { rejectUnauthorized: false } : {}),
    };
    const req = (ctx.https ? https : http).request(opts, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

/** Group ids of a `GET /subscription` body (`<li class="subsgrp-li" title="{id}">`). */
function groupIdsOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/<li\b([^>]*)>/g)) {
    if (!/class="[^"]*\bsubsgrp-li\b/.test(m[1])) { continue; }
    const id = /title="([^"]*)"/.exec(m[1])?.[1];
    if (id) { out.push(id); }
  }
  return out;
}

/** Member hrefs of a `GET /subscription/{g}` body (`<li class="sub-resource"><a href="{uri}">`). */
function membersOf(body: string): string[] {
  return [...body.matchAll(/<li\b[^>]*class="[^"]*\bsub-resource\b[^"]*"[^>]*>\s*<a\b[^>]*href="([^"]*)"/g)]
    .map(m => m[1].replace(/&amp;/g, '&'));
}

/** The subscription groups this adapter's session owns. */
async function listGroups(ctx: FunctionalContext, adapter: IRWSAdapter): Promise<string[]> {
  const r = await sessionGet(ctx, adapter, '/subscription');
  if (r.status !== 200) { throw new Error(`${ctx.lane}: GET /subscription on the session answered ${r.status}: ${r.body.slice(0, 200)}`); }
  return groupIdsOf(r.body);
}

/** `/subscription/43` -> `43`. */
const groupIdOfPath = (p: string | undefined): string | null => /\/subscription\/([^/?#]+)$/.exec(p ?? '')?.[1] ?? null;

// ─── Trace reading ───────────────────────────────────────────────────────────

/** Byte length of the lane's trace now: lines after it are what follows. */
function traceMark(ctx: FunctionalContext): number {
  try { return fs.statSync(traceFile(ctx.lane)).size; } catch { return 0; }
}

/** This file's trace lines of the lane written after `mark`. */
function traceSince(ctx: FunctionalContext, mark: number): TraceLine[] {
  let raw = '';
  try { raw = fs.readFileSync(traceFile(ctx.lane)).subarray(mark).toString('utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as TraceLine; } catch { return null; } })
    .filter((l): l is TraceLine => l !== null && l.file === FILE);
}

const httpData = (l: TraceLine): { method?: string; path?: string; status?: number } =>
  (l.data ?? {}) as { method?: string; path?: string; status?: number };

// ─── A local TCP relay for the drop test ─────────────────────────────────────

interface Relay {
  readonly port: number;
  /** Connections accepted so far. */
  opened(): number;
  /** Destroy every relayed connection now (both halves); returns how many there were. */
  dropAll(): number;
  close(): Promise<void>;
}

/**
 * A plain TCP relay on 127.0.0.1 to the controller's port. It carries TLS
 * untouched, so it serves both generations; `dropAll` is a network drop as
 * the client sees it: every socket it has to the controller ends at once,
 * with no WebSocket close frame.
 */
async function startRelay(targetPort: number): Promise<Relay> {
  assertLocalhost(HOST);
  const pairs = new Set<{ client: net.Socket; upstream: net.Socket }>();
  let opened = 0;
  const server = net.createServer(client => {
    opened++;
    const upstream = net.connect({ host: HOST, port: targetPort });
    const pair = { client, upstream };
    pairs.add(pair);
    const end = (): void => { pairs.delete(pair); client.destroy(); upstream.destroy(); };
    client.on('error', end);
    upstream.on('error', end);
    client.on('close', end);
    upstream.on('close', end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const dropAll = (): number => {
    const n = pairs.size;
    for (const p of [...pairs]) { p.client.destroy(); p.upstream.destroy(); }
    pairs.clear();
    return n;
  };
  return {
    port,
    opened: () => opened,
    dropAll,
    close: () => new Promise<void>(resolve => { dropAll(); server.close(() => resolve()); }),
  };
}

// ─── Per controller ──────────────────────────────────────────────────────────

await forEachController(FILE, ctx => {
  const isRws1 = ctx.generation === 'rws1';

  /**
   * The manager's own adapter. A write sent through it reaches the manager's
   * state only by an event or a poll, where the manager's own wrapper would
   * set the new value itself - so this is how a test sees the event path.
   */
  const managerAdapter = (m: RobotManager): IRWSAdapter => {
    const a = (m as unknown as { adapter: IRWSAdapter | null }).adapter;
    if (!a) { throw new Error(`${ctx.lane}: the manager has no adapter (not connected)`); }
    return a;
  };

  /** The manager, connected and streaming events; skips with the reason when it does not stream. */
  const liveManager = async (t: TestHandle): Promise<RobotManager> => {
    const m = await ctx.ensureManager();
    if (!await waitFor(() => m.state.quality === 'live', LIVE_WAIT_MS)) {
      return ctx.skip(t, `the manager's subscription is not live (quality ${m.state.quality}: ${m.state.qualityReason}), so no event path can be observed`);
    }
    return m;
  };

  /**
   * The RW6 virtual controller refuses a further session while the lane's
   * RobotManager is connected (see the harness): log it out before a test
   * opens a session of its own there, and bring it back afterwards.
   */
  const freeRw6Slot = async (): Promise<void> => {
    if (isRws1) { await ctx.connectedManager()?.disconnect(); }
  };

  // ─── Live quality and the manager's group ──────────────────────────────────

  it('reports live (event) quality after connect', async () => {
    const m = await ctx.ensureManager();
    const live = await waitFor(() => m.state.quality === 'live', LIVE_WAIT_MS);
    ctx.note('records the connection quality after connect', {
      quality: m.state.quality, reason: m.state.qualityReason, groupPath: m.subscriptionGroupPath ?? null,
    });
    expect(live, `quality ${m.state.quality}: ${m.state.qualityReason}`).toBe(true);
    if (isRws1) {
      // The RWS 1.0 subscriber has no editable group, so none is published.
      expect(m.subscriptionGroupPath).toBeUndefined();
    } else {
      expect(m.subscriptionGroupPath).toMatch(/^\/subscription\/[^/]+$/);
    }
  });

  it('lists one subscription group on the manager\'s session, binding every resource it asked for', async t => {
    const m = await liveManager(t);
    const own = managerAdapter(m);
    const groups = await listGroups(ctx, own);
    ctx.note('the manager session\'s subscription groups', groups);
    // One group per manager session. A second one would be a leak, or another
    // program sharing this session.
    expect(groups).toHaveLength(1);
    if (!isRws1) { expect(groups[0]).toBe(groupIdOfPath(m.subscriptionGroupPath)); }

    const r = await sessionGet(ctx, own, `/subscription/${groups[0]}`);
    expect(r.status).toBe(200);
    const members = membersOf(r.body);
    ctx.note('the manager group\'s members', members);
    // The group lists each resource as it was sent (live-verified 2026-09-29 on
    // RW 7.21.4, 8.2.1 and 6.16.03); either spelling of a panel resource is
    // accepted on RWS 1.0, so names are compared, not spellings.
    expect(members.map(resourceName).sort()).toEqual([...MANAGER_RESOURCES].sort());

    // The partial-bind check, both generations. On RW 6.16.03 a create that
    // names a panel resource another group holds in the other spelling still
    // answers 201 and drops that resource, naming it only in a status block
    // (live-verified 2026-09-29). RW 8.2.1 answered 201 and left speedratio
    // out of this group on 2026-10-01 and 2026-10-18 (all six on 2026-10-17),
    // cause not known. The client then re-creates the group once with that
    // resource in the other spelling (RWS 2.0: built, not yet run), and
    // throws, so the manager polls, when it is still left out. A whole group
    // (above) and live quality mean the check did not give up.
    {
      const lines = traceSince(ctx, 0);
      const recreated = lines.filter(l => /- re-creating with/.test(l.msg));
      const unbound = lines.filter(l => /did not bind/.test(l.msg));
      ctx.note('records whether the partial-bind check acted on this file\'s subscribes', {
        recreated: recreated.map(l => l.msg), unbound: unbound.map(l => l.msg),
      });
      expect(unbound.filter(l => /in either spelling/.test(l.msg))).toEqual([]);
      expect(m.state.quality).toBe('live');
    }
  });

  // ─── Changes arrive as events ──────────────────────────────────────────────

  it('delivers a speed-ratio change as an event within the budget, and the manager state follows it', async t => {
    const m = await liveManager(t);
    const from = (await ctx.panel()).speedRatio;
    if (from === null) { return ctx.skip(t, 'the speed ratio could not be read'); }
    const to = from > 1 ? from - 1 : from + 1;
    const own = managerAdapter(m);
    const { seen, off } = tapManager(m);
    try {
      const start = Date.now();
      await own.setSpeedRatio(to);
      const written = Date.now();
      const ev = await awaitEvent(seen, 'speedratio', v => Number(v) === to, 0, `speed-ratio event ${to}`);
      // The handler updates the state in the same tick as the tap.
      expect(m.state.speedRatio).toBe(to);

      const backStart = Date.now();
      await own.setSpeedRatio(from);
      const backWritten = Date.now();
      const back = await awaitEvent(seen, 'speedratio', v => Number(v) === from, seen.indexOf(ev) + 1, `speed-ratio event ${from}`);
      expect(m.state.speedRatio).toBe(from);

      const speedEvents = seen.filter(s => s.name === 'speedratio');
      ctx.note('records the speed-ratio events and their lag', {
        from, to,
        lagAfterWriteMs: ev.at - written, lagFromCallMs: ev.at - start, writeMs: written - start,
        backLagAfterWriteMs: back.at - backWritten, backLagFromCallMs: back.at - backStart,
        events: speedEvents.map(s => s.value),
      });
      expect(ev.at - written, 'speed-ratio event lag after the write').toBeLessThan(EVENT_BUDGET_MS);
      expect(back.at - backWritten, 'speed-ratio event lag after the write back').toBeLessThan(EVENT_BUDGET_MS);
      // Only the two values written ever arrive.
      for (const s of speedEvents) { expect([String(from), String(to)]).toContain(String(Number(s.value))); }
    } finally {
      off();
    }
    expect((await ctx.panel()).speedRatio).toBe(from);
  }, LONG);

  it('records whether a same-value speed-ratio write produces an event', async t => {
    const m = await liveManager(t);
    const now = (await ctx.panel()).speedRatio;
    if (now === null) { return ctx.skip(t, 'the speed ratio could not be read'); }
    const { seen, off } = tapManager(m);
    try {
      await managerAdapter(m).setSpeedRatio(now);
      // Absence is the expected answer on RW 7.21.0 (a write of the value in
      // effect produced no frame, live-verified 2026-09-27); the other builds
      // are not settled, so this only records.
      await waitFor(() => seen.some(s => s.name === 'speedratio'), QUIET_WINDOW_MS, 50);
    } finally {
      off();
    }
    const events = seen.filter(s => s.name === 'speedratio');
    ctx.note('records the speed-ratio events after a same-value write', { value: now, events: events.map(s => s.value), windowMs: QUIET_WINDOW_MS });
    // What must hold: nothing but the value in effect arrives.
    for (const s of events) { expect(Number(s.value)).toBe(now); }
    expect(m.state.speedRatio).toBe(now);
  });

  it('delivers motors off and on as controller-state events', async t => {
    await ctx.requireAllowed(t, 'motors');
    const m = await liveManager(t);
    const p = await ctx.panel();
    if (p.opmode !== 'AUTO') { return ctx.skip(t, `motors are switched in Auto only here; the controller reads ${p.opmode}`); }
    if (p.execstate === 'running') { return ctx.skip(t, 'RAPID is running; motors off would stop it'); }
    if (p.ctrlstate !== 'motoron' && p.ctrlstate !== 'motoroff') {
      return ctx.skip(t, `the controller reads ${p.ctrlstate}, not motors on or off`);
    }
    const first = p.ctrlstate === 'motoron' ? 'motoroff' : 'motoron';
    const second = p.ctrlstate;
    const flip = (to: 'motoron' | 'motoroff'): Promise<void> => (to === 'motoron' ? m.setMotorsOn() : m.setMotorsOff());
    const { seen, off } = tapManager(m);
    try {
      const w1 = Date.now();
      await flip(first);
      const d1 = Date.now();
      const e1 = await awaitEvent(seen, 'controllerstate', v => v === first, 0, `controller-state event ${first}`);
      expect(m.state.ctrlstate).toBe(first);

      const w2 = Date.now();
      await flip(second);
      const d2 = Date.now();
      const e2 = await awaitEvent(seen, 'controllerstate', v => v === second, seen.indexOf(e1) + 1, `controller-state event ${second}`);
      expect(m.state.ctrlstate).toBe(second);

      ctx.note('records the controller-state events and their lag', {
        sequence: [first, second],
        lagAfterWriteMs: [e1.at - d1, e2.at - d2], lagFromCallMs: [e1.at - w1, e2.at - w2],
        events: seen.filter(s => s.name === 'controllerstate').map(s => s.value),
      });
      expect(e1.at - d1, `${first} event lag after the request`).toBeLessThan(CTRL_EVENT_BUDGET_MS);
      expect(e2.at - d2, `${second} event lag after the request`).toBeLessThan(CTRL_EVENT_BUDGET_MS);
    } finally {
      off();
    }
    expect((await ctx.panel()).ctrlstate).toBe(second);
  }, LONG);

  it('delivers a RAPID start and stop as execution-state events', async t => {
    // RW8: prepareMotion makes the motion-control declaration the start needs,
    // only under RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<its system name> (skipped without it).
    await ctx.prepareMotion(t, { kind: 'rapid-start' });
    const m = await liveManager(t);
    const mod = zzExecModule();
    await ctx.loadModule(mod);
    await m.setPPToRoutine(ctx.task, mod.name, mod.routines.entry);
    const { seen, off } = tapManager(m);
    try {
      const w1 = Date.now();
      await m.startRapid();
      const d1 = Date.now();
      const running = await awaitEvent(seen, 'execution', v => v === 'running', 0, 'execution event running');
      expect(m.state.execstate).toBe('running');

      const w2 = Date.now();
      await m.stopRapid();
      const d2 = Date.now();
      const stopped = await awaitEvent(seen, 'execution', v => v === 'stopped', seen.indexOf(running) + 1, 'execution event stopped');
      expect(m.state.execstate).toBe('stopped');

      ctx.note('records the execution-state events and their lag', {
        lagAfterWriteMs: [running.at - d1, stopped.at - d2], lagFromCallMs: [running.at - w1, stopped.at - w2],
        events: seen.filter(s => s.name === 'execution').map(s => s.value),
      });
      expect(running.at - d1, 'running event lag after the start').toBeLessThan(EVENT_BUDGET_MS);
      expect(stopped.at - d2, 'stopped event lag after the stop').toBeLessThan(EVENT_BUDGET_MS);
    } finally {
      off();
    }
    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
    expect(report.ok).toBe(true);
  }, LONG);

  // ─── Nothing left behind ───────────────────────────────────────────────────

  it('an adapter\'s unsubscribe deletes its group: the session lists no group afterwards', async () => {
    await freeRw6Slot();
    const a = await ctx.newAdapter();
    try {
      expect(await listGroups(ctx, a)).toEqual([]);
      const events: SubscriptionEvent[] = [];
      const stop = await a.subscribe(['speedratio', 'controllerstate'], e => events.push(e));
      const during = await listGroups(ctx, a);
      expect(during).toHaveLength(1);
      const g = during[0];
      if (!isRws1) { expect(groupIdOfPath((stop as unknown as { groupPath?: string }).groupPath)).toBe(g); }

      await stop();
      expect(await listGroups(ctx, a)).toEqual([]);
      // The deleted group is gone for its own session too: 400 -1073435900
      // "Group N does not belong to Client M" (live-verified 2026-09-29 on
      // RW 7.21.4, 8.2.1 and 6.16.03).
      const gone = await sessionGet(ctx, a, `/subscription/${g}`);
      ctx.note('the deleted group read on its own session', { group: g, status: gone.status, body: gone.body.slice(0, 300), eventsWhileSubscribed: events.length });
      expect(gone.status).toBe(400);
      expect(gone.body).toContain('-1073435900');
    } finally {
      await ctx.release(a);
      await ctx.ensureManager();
    }
  }, LONG);

  it('RobotManager.disconnect deletes its group before logging out, and a reconnect subscribes exactly one new group', async t => {
    const m = await liveManager(t);
    const before = await listGroups(ctx, managerAdapter(m));
    expect(before).toHaveLength(1);
    const old = before[0];

    const mark = traceMark(ctx);
    await m.disconnect();
    expect(m.state.quality).toBe('disconnected');
    expect(m.subscriptionGroupPath).toBeUndefined();

    const lines = traceSince(ctx, mark);
    const deleteAt = lines.findIndex(l => (l.cat === 'http.res' || l.cat === 'http.err')
      && httpData(l).method === 'DELETE' && httpData(l).path === `/subscription/${old}`);
    const logoutAt = lines.findIndex(l => l.cat === 'http.req' && httpData(l).path === '/logout');
    ctx.note('the manager disconnect on the wire', lines
      .filter(l => l.cat?.startsWith('http.'))
      .map(l => ({ cat: l.cat, ...httpData(l) })));
    expect(deleteAt, `DELETE /subscription/${old} in the trace`).toBeGreaterThanOrEqual(0);
    expect(httpData(lines[deleteAt]).status).toBe(200);
    expect(logoutAt, 'GET /logout in the trace').toBeGreaterThan(deleteAt);

    const again = await ctx.reconnect();
    expect(await waitFor(() => again.state.quality === 'live', LIVE_WAIT_MS), `quality ${again.state.quality}: ${again.state.qualityReason}`).toBe(true);
    const after = await listGroups(ctx, managerAdapter(again));
    ctx.note('the manager session\'s groups after the reconnect', { before: old, after });
    expect(after).toHaveLength(1);
    if (isRws1) {
      // Group ids come from one counter shared by all sessions (live-verified
      // 2026-09-29 on RW 6.16.03), so the new group cannot carry the old id.
      expect(after[0]).not.toBe(old);
    } else {
      // How RWS 2.0 numbers groups is not recorded; the new session's one
      // group is the one the manager publishes.
      expect(after[0]).toBe(groupIdOfPath(again.subscriptionGroupPath));
    }
  }, LONG);

  // ─── Coming back after a drop ──────────────────────────────────────────────

  it('resubscribes after its connections drop, and events flow on the restored stream', async t => {
    const from = (await ctx.panel()).speedRatio;
    if (from === null) { return ctx.skip(t, 'the speed ratio could not be read'); }
    const to = from > 1 ? from - 1 : from + 1;

    // RW6: one session at a time with a subscription (see the harness), so the
    // adapter under test is the only session and makes the writes itself.
    // RWS 2.0: the lane's manager writes (on RW8 as the harness's registered
    // control station), and the adapter under test only listens.
    await freeRw6Slot();
    const relay = await startRelay(ctx.port);
    let a: IRWSAdapter | null = null;
    let stop: (() => Promise<void>) | null = null;
    try {
      try {
        a = await ctx.newAdapter({ port: relay.port });
      } catch (e) {
        return ctx.skip(t, `the controller did not accept a session through a local TCP relay: ${e instanceof Error ? e.message : String(e)}`);
      }
      const adapter = a;
      const write = async (v: number): Promise<void> => {
        if (isRws1) { await adapter.setSpeedRatio(v); } else { await (await ctx.ensureManager()).setSpeedRatio(v); }
      };

      const seen: Seen[] = [];
      let restored = 0;
      let lost = 0;
      stop = await adapter.subscribe(
        ['speedratio', 'controllerstate'],
        e => { seen.push({ name: resourceName(e.resource), value: e.value, at: Date.now() }); },
        () => { lost++; },
        () => { restored++; },
      );
      const handle = stop as unknown as { groupPath?: string };
      const before = await listGroups(ctx, adapter);
      expect(before).toHaveLength(1);
      const oldGroup = before[0];

      const dropped = relay.dropAll();
      expect(dropped, 'connections the relay held for the adapter').toBeGreaterThan(0);
      const droppedAt = Date.now();
      await waitUntil(() => restored > 0 || lost > 0, RESTORE_WAIT_MS, 50, 'the stream restored (or given up)');
      expect(lost, 'the stream was given up instead of restored').toBe(0);
      const restoredAfterMs = Date.now() - droppedAt;

      const after = await listGroups(ctx, adapter);
      expect(after).toHaveLength(1);
      // RWS 1.0 reopens the stored poll URL first (it upgrades again while the
      // group lives, live-verified 2026-09-29 on RW 6.16.03) and re-registers
      // only when that fails, so its group may or may not change (recorded
      // below). RWS 2.0 drops the old group and creates a new one on every
      // reconnect, on the same session: one group, the one the handle names.
      if (!isRws1) { expect(groupIdOfPath(handle.groupPath)).toBe(after[0]); }

      const mark = seen.length;
      await write(to);
      const ev = await awaitEvent(seen, 'speedratio', v => Number(v) === to, mark, `speed-ratio event ${to} on the restored stream`);
      await write(from);
      await awaitEvent(seen, 'speedratio', v => Number(v) === from, seen.indexOf(ev) + 1, `speed-ratio event ${from} on the restored stream`);

      ctx.note('records the drop and the restore', {
        relayConnections: relay.opened(), dropped, restoredAfterMs, restoredCount: restored,
        groupBefore: oldGroup, groupAfter: after[0], sameGroup: after[0] === oldGroup,
      });

      await stop();
      stop = null;
      expect(await listGroups(ctx, adapter)).toEqual([]);
    } finally {
      if (stop) { await stop().catch(() => undefined); }
      // Logged out through the relay while it still runs, then the relay goes.
      if (a) { await ctx.release(a); }
      await relay.close();
      await ctx.ensureManager();
    }
    expect((await ctx.panel()).speedRatio).toBe(from);
  }, LONG);
});
