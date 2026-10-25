// Probe two groups of reads before the client carries them:
//
//   rws1 targets: the RWS 1.0 I/O configuration reads - a signal's, a
//     network's and a device's configuration - whose path ABB's RWS 1.0
//     pages list without a form. Candidates: the RWS 2.0 `/config` sub-path
//     (with ABB's `configtype` values), the RWS 1.0 `?resource=config`
//     modifier, and every config link the controller's own resource bodies
//     and `?action=show` pages name.
//   rws2 targets: the task motion sub-reads ABB documents under
//     `/rw/rapid/tasks/{task}/motion` (robtarget, jointtarget, mechunits,
//     extjointstate), plus every link the `/motion` resource itself names.
//
// Read-only by construction: the script sends GET and OPTIONS only, through
// the client's own adapter (createAdapter), one request at a time, at least
// one second apart. After each request it checks that the controller is still
// reachable (an unauthenticated GET /rw/system on a fresh connection) and stops
// when one is not, so a virtual controller closed mid-run ends the probe at
// once. Every session is logged out.
//
// Localhost only (a non-local host is refused). Usage:
//   npm run build
//   node scripts/probe-config-task-motion.mjs rws1:39127 rws2:9403 rws2:9805 > probe.jsonl
// Each answer is one JSON line on stdout; progress goes to stderr.

import http from 'node:http';
import https from 'node:https';
import { createAdapter } from '../dist/index.js';

const HOST = '127.0.0.1';
const USER = process.env.RWS_TEST_USER ?? 'Default User';
const PASS = process.env.RWS_TEST_PASS ?? 'robotics';
const GAP_MS = 1000;
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1']);

if (!LOCAL.has(HOST)) { throw new Error(`refusing non-localhost host ${HOST}`); }

const targets = process.argv.slice(2).map((a) => {
  const m = /^(rws1|rws2):(\d+)$/.exec(a);
  if (!m) { throw new Error(`target "${a}" is not rws1:<port> or rws2:<port>`); }
  return { gen: m[1], port: Number(m[2]) };
});
if (!targets.length) {
  console.error('usage: node scripts/probe-config-task-motion.mjs rws1:<port> rws2:<port> ...');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (rec) => process.stdout.write(`${JSON.stringify(rec)}\n`);
const log = (s) => process.stderr.write(`${s}\n`);

/** Unauthenticated GET /rw/system on a fresh connection: the HTTP status, or null when nothing answers. */
function health(port, useHttps) {
  return new Promise((resolve) => {
    const t = useHttps ? https : http;
    const req = t.request({
      host: HOST, port, path: '/rw/system', method: 'GET', agent: false, timeout: 10_000,
      headers: { Accept: useHttps ? 'application/xhtml+xml;v=2.0' : 'application/xhtml+xml' },
      ...(useHttps ? { rejectUnauthorized: false } : {}),
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); res.on('error', () => resolve(null)); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

class Stopped extends Error {}

/** One target: connect, run its plan, log out. */
async function probeTarget({ gen, port }) {
  const useHttps = gen === 'rws2';
  const adapter = await createAdapter({ host: HOST, port, https: useHttps, username: USER, password: PASS, timeout: 10_000 });
  let last = 'connect';
  let count = 0;
  let build = '';

  /** One request through the adapter's session, then the health check. */
  const send = async (method, path, accept) => {
    await sleep(GAP_MS);
    count += 1;
    last = `${method} ${path}`;
    const rec = { port, gen, build, n: count, method, path, accept: accept ?? null, status: null, headers: null, body: null, error: null };
    try {
      if (gen === 'rws1') {
        if (method !== 'GET') { throw new Error('RWS 1.0 probes send GET only'); }
        const res = await adapter['client'].request('GET', path);
        rec.status = res.status;
        rec.body = res.body ?? '';
      } else {
        let status = null;
        let headers = null;
        const body = await adapter['req'](method, path, undefined, undefined, undefined, [], accept,
          (s, h) => { status = s; headers = h; });
        rec.status = status ?? 200;
        rec.headers = headers ? { 'content-type': headers['content-type'] ?? null, allow: headers['allow'] ?? null } : null;
        rec.body = body;
      }
    } catch (e) {
      rec.status = e?.httpStatus ?? null;
      rec.error = { code: e?.code ?? null, message: e?.message ?? String(e), controllerCode: e?.controllerCode ?? null, controllerMsg: e?.controllerMsg ?? null };
    }
    await sleep(GAP_MS);
    rec.health = await health(port, useHttps);
    rec.t = new Date().toISOString();
    out(rec);
    log(`${port} #${count} ${method} ${path} -> ${rec.status ?? rec.error?.code} (health ${rec.health})`);
    if (rec.health === null) { throw new Stopped(`${port} unreachable after ${last}`); }
    return rec;
  };

  try {
    if (gen === 'rws1') {
      const sys = await send('GET', '/rw/system?json=1');
      build = /"rwversion"\s*:\s*"([^"]+)"/.exec(String(sys.body ?? ''))?.[1] ?? '';
      await planRws1(send);
    } else {
      build = await adapter.getRobotWareVersion(); // cached by connect: no request
      await planRws2(send);
    }
  } catch (e) {
    if (e instanceof Stopped) { out({ port, gen, stopped: true, lastRequest: last }); log(e.message); throw e; }
    out({ port, gen, failed: true, lastRequest: last, message: e?.message ?? String(e) });
    log(`${port}: ${e?.message ?? e}`);
  } finally {
    await adapter.disconnect().catch(() => undefined);
    out({ port, gen, build, loggedOut: true, requests: count });
  }
}

/**
 * Every link a body names (JSON `_links` hrefs or XHTML `<a href>`), as
 * resource paths resolved against the body's own base (`_links.base` or
 * `<base href>`), else against `requestPath`; `json=1` is dropped.
 */
function linksOf(body, requestPath) {
  const text = String(body ?? '');
  const baseHref = /"base"\s*:\s*\{\s*"href"\s*:\s*"([^"]*)"/.exec(text)?.[1]
    ?? /<base\s+href="([^"]*)"/.exec(text)?.[1]
    ?? `http://x${requestPath.replace(/\?.*$/, '')}`;
  const base = new URL(baseHref, 'http://x/');
  const hrefs = new Set();
  for (const m of text.matchAll(/"href"\s*:\s*"([^"]*)"/g)) { hrefs.add(m[1]); }
  for (const m of text.matchAll(/<a\s+href="([^"]*)"/g)) { hrefs.add(m[1]); }
  const paths = [];
  for (const h of hrefs) {
    if (h === '' || h === baseHref) { continue; }
    const u = new URL(h, base);
    u.searchParams.delete('json');
    paths.push(u.pathname + u.search);
  }
  return [...new Set(paths)];
}

/** A link the probe may follow with a GET: no action other than `show`. */
const readOnlyLink = (p) => !/[?&]action=(?!show(?:&|$))/.test(p);

const withJson = (p) => `${p}${p.includes('?') ? '&' : '?'}json=1`;

// ─── RWS 1.0: I/O configuration reads ────────────────────────────────────────

async function planRws1(send) {
  // A device-bound signal from the controller's own list.
  const list = await send('GET', '/rw/iosystem/signals?json=1');
  const m = /"_title"\s*:\s*"([^"/]+)\/([^"/]+)\/([^"/]+)"/.exec(String(list.body ?? ''));
  if (!m) { throw new Error('no network/device/name signal in the signal list'); }
  const signal = { network: m[1], device: m[2], name: m[3] };
  const sigPath = `/rw/iosystem/signals/${signal.network}/${signal.device}/${signal.name}`;
  const netPath = `/rw/iosystem/networks/${signal.network}`;
  const devPath = `/rw/iosystem/devices/${signal.device}`;
  const devPath2 = `/rw/iosystem/devices/${signal.network}/${signal.device}`;

  const tried = new Set();
  const get = async (p) => { if (tried.has(p)) { return null; } tried.add(p); return send('GET', p); };

  for (const [base, extra] of [[sigPath, []], [netPath, []], [devPath, [devPath2]]]) {
    // The resource itself and its show page: the links the controller names.
    const found = [];
    for (const p of [withJson(base), `${base}?action=show`]) {
      const r = await get(p);
      if (r && r.status === 200) {
        for (const l of linksOf(r.body, p)) { if (/config/i.test(l) && readOnlyLink(l)) { found.push(l); } }
      }
    }
    // ABB's RWS 2.0 form (its configtype values only when the bare sub-path
    // is not simply absent), the RWS 1.0 resource modifier, the
    // network-qualified device form, and the links found.
    // A candidate that answers is read once more as XHTML (no `json=1`).
    const candidate = async (c) => {
      const r = await get(withJson(c));
      if (r && r.status === 200) { await get(c); }
      return r;
    };
    const bare = await candidate(`${base}/config`);
    if (bare && bare.status !== 404) {
      for (const t of [1, 2, 3]) { await candidate(`${base}/config?configtype=${t}`); }
    }
    for (const c of [`${base}?resource=config`, ...extra.map((e) => `${e}/config`), ...found]) { await candidate(c); }
  }
}

// ─── RWS 2.0: task motion sub-reads ──────────────────────────────────────────

async function planRws2(send) {
  const XHTML = 'application/xhtml+xml;v=2.0';
  const tasks = await send('GET', '/rw/rapid/tasks');
  // The motion task: the first task entry whose motiontask is TRUE, else T_ROB1.
  const entries = [];
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === 'object') {
      if (n._type === 'rap-task-li') { entries.push(n); }
      Object.values(n).forEach(walk);
    }
  };
  try { walk(JSON.parse(String(tasks.body ?? ''))); } catch { /* not JSON: use the default */ }
  const task = entries.find((e) => String(e.motiontask).toUpperCase() === 'TRUE')?.name ?? 'T_ROB1';
  const base = `/rw/rapid/tasks/${task}/motion`;

  const dir = await send('GET', base);
  await send('OPTIONS', base, XHTML);
  const linked = dir.status === 200
    ? linksOf(dir.body, `${base}/`).filter((p) => p.startsWith(`${base}/`) && readOnlyLink(p))
    : [];
  const subs = [...new Set([...['robtarget', 'jointtarget', 'mechunits', 'extjointstate'].map((s) => `${base}/${s}`), ...linked])];
  for (const p of subs) {
    const r = await send('GET', p);
    if (r.status === 200) {
      await send('GET', p, XHTML);
      await send('OPTIONS', p, XHTML);
    }
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

for (const t of targets) {
  try {
    await probeTarget(t);
  } catch (e) {
    if (e instanceof Stopped) { process.exitCode = 1; break; }
    out({ port: t.port, gen: t.gen, failed: true, message: e?.message ?? String(e) });
    log(`${t.port}: ${e?.message ?? e}`);
  }
  await sleep(GAP_MS);
}
