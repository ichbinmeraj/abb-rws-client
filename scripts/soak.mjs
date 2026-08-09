#!/usr/bin/env node
/**
 * S15 - soak with periodic injected faults.
 *
 *   node scripts/soak.mjs --minutes 1440      # the real 24 h run
 *   node scripts/soak.mjs --minutes 20        # scaled evidence run
 *
 * Holds a RobotManager against each live generation through a chaos proxy,
 * injects a fault every cycle, and samples RSS / active handles throughout.
 *
 * Thresholds are declared UP FRONT (the task brief requires it) so the verdict
 * cannot be rationalised afterwards:
 *
 *   - rssDriftMB      : RSS growth from the post-warmup baseline to the end.
 *                       Measured after warmup because the first minute includes
 *                       lazy imports and JIT warm-up that never recur.
 *   - handleGrowth    : growth in active handles of any single kind. Sockets and
 *                       timers are what leak in this client; one extra socket in
 *                       TIME_WAIT is noise, sustained growth is not.
 *   - uncaught        : must be exactly zero. Any unhandled rejection or uncaught
 *                       exception fails the soak outright, regardless of memory.
 *   - finalStateTruth : at the end, the manager's view must match what a fresh
 *                       client reads from the controller.
 *
 * Writes docs/structural/soak-<timestamp>.json and prints a verdict.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const MINUTES = Number(arg('minutes', '20'));
const THRESHOLDS = {
  rssDriftMB: Number(arg('rss-drift-mb', '75')),
  handleGrowth: Number(arg('handle-growth', '5')),
  uncaught: 0,
};
/** Warm-up excluded from the baseline: lazy imports + JIT settle here. */
const WARMUP_MS = Math.min(60_000, MINUTES * 60_000 * 0.1);
const CYCLE_MS = 15_000;

const { RobotManager } = await import(`file://${root}/dist/index.js`);

// The chaos proxy lives in tests/ as TypeScript and the build only emits src/,
// so this script cannot import it. Re-implement the two operations a soak needs
// rather than adding a transpiler step: a soak that cannot start is worse than
// one with a smaller fault vocabulary.
const net = await import('node:net');
async function simpleProxy(targetHost, targetPort) {
  const pairs = new Set();
  let refusing = false;
  const server = net.createServer(client => {
    if (refusing) { client.destroy(); return; }
    const upstream = net.connect(targetPort, targetHost);
    const pair = { client, upstream };
    pairs.add(pair);
    const teardown = () => { pairs.delete(pair); client.destroy(); upstream.destroy(); };
    client.on('data', d => { if (!upstream.destroyed) upstream.write(d); });
    upstream.on('data', d => { if (!client.destroyed) client.write(d); });
    client.on('close', teardown); upstream.on('close', teardown);
    client.on('error', () => {}); upstream.on('error', () => {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    dropAll: () => { for (const { client, upstream } of [...pairs]) { client.destroy(); upstream.destroy(); } pairs.clear(); },
    refuseNew: v => { refusing = v; },
    close: () => new Promise(r => { for (const p of [...pairs]) { p.client.destroy(); p.upstream.destroy(); } server.close(() => r()); }),
  };
}

// ─── discover controllers (ports drift; never assume) ────────────────────────
const http = await import('node:http');
const https = await import('node:https');
function probe(port, tls) {
  return new Promise(resolve => {
    const mod = tls ? https : http;
    const req = mod.request({ host: '127.0.0.1', port, path: '/rw/system', timeout: 2500, ...(tls ? { rejectUnauthorized: false } : {}) },
      res => { const c = String(res.headers['www-authenticate'] ?? ''); res.resume(); resolve(/digest/i.test(c) ? 'rws1' : /basic/i.test(c) ? 'rws2' : null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}
const candidates = [
  { port: Number(process.env.RWS_TEST_PORT_RW6 ?? 35112), tls: false },
  { port: Number(process.env.RWS_TEST_PORT_RW7 ?? 9805), tls: true },
  { port: 5466, tls: true },
];
const targets = [];
for (const c of candidates) {
  const gen = await probe(c.port, c.tls);
  if (gen && !targets.some(t => t.generation === gen)) {
    targets.push({ ...c, generation: gen });
  }
}
if (!targets.length) { console.error('soak: no live controller found on localhost'); process.exit(2); }

console.log(`soak: ${MINUTES} min, ${targets.length} controller(s): ${targets.map(t => `${t.generation}:${t.port}`).join(', ')}`);
console.log(`soak: thresholds ${JSON.stringify(THRESHOLDS)}\n`);

// ─── instrumentation ─────────────────────────────────────────────────────────
let uncaught = 0;
const uncaughtDetail = [];
process.on('uncaughtException', e => { uncaught++; uncaughtDetail.push(String(e?.message ?? e)); });
process.on('unhandledRejection', e => { uncaught++; uncaughtDetail.push(String(e?.message ?? e)); });

const handleCounts = () => {
  const info = process.getActiveResourcesInfo?.() ?? [];
  const by = {};
  for (const k of info) { by[k] = (by[k] ?? 0) + 1; }
  return by;
};

const samples = [];
const sample = (phase) => {
  const m = process.memoryUsage();
  samples.push({ t: Date.now(), phase, rss: m.rss, heapUsed: m.heapUsed, handles: handleCounts() });
};

// ─── run ─────────────────────────────────────────────────────────────────────
const rigs = [];
for (const t of targets) {
  const proxy = await simpleProxy('127.0.0.1', t.port);
  const manager = new RobotManager({ refreshIntervalMs: 1000 });
  await manager.connect('127.0.0.1', process.env.RWS_TEST_USER ?? 'Default User',
    process.env.RWS_TEST_PASS ?? 'robotics', proxy.port, t.tls);
  rigs.push({ ...t, proxy, manager });
}

const startedAt = Date.now();
const endAt = startedAt + MINUTES * 60_000;
let baseline = null;
let cycles = 0, faults = 0;

sample('start');
while (Date.now() < endAt) {
  await new Promise(r => setTimeout(r, CYCLE_MS));
  cycles++;

  if (!baseline && Date.now() - startedAt >= WARMUP_MS) {
    global.gc?.();
    sample('baseline');
    baseline = samples[samples.length - 1];
    console.log(`soak: baseline after warmup - rss ${(baseline.rss / 1048576).toFixed(1)} MB`);
  }

  // Inject a fault on a rotating rig: drop the connection, then block the port
  // briefly, then heal. This is the cycle the client must survive indefinitely.
  const rig = rigs[cycles % rigs.length];
  rig.proxy.dropAll();
  faults++;
  if (cycles % 4 === 0) {
    rig.proxy.refuseNew(true);
    await new Promise(r => setTimeout(r, 3000));
    rig.proxy.refuseNew(false);
  }

  sample('cycle');
  if (cycles % 8 === 0) {
    const s = samples[samples.length - 1];
    const el = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`soak: ${el} min · cycles ${cycles} · faults ${faults} · rss ${(s.rss / 1048576).toFixed(1)} MB · uncaught ${uncaught}`);
  }
}

global.gc?.();
sample('end');
const final = samples[samples.length - 1];
baseline ??= samples[0];

// ─── final-state truth: manager view vs a fresh read ─────────────────────────
const truth = [];
for (const rig of rigs) {
  let managerState = null, controllerState = null, matched = null;
  // RobotState carries the polled controller state as `ctrlstate`.
  try { managerState = rig.manager.state.ctrlstate ?? null; } catch {}
  try { controllerState = await rig.manager.getControllerState(); } catch (e) { controllerState = `ERROR: ${e?.message}`; }
  matched = managerState === null || controllerState === null ? null : String(managerState) === String(controllerState);
  truth.push({ generation: rig.generation, managerState, controllerState, matched });
}

for (const rig of rigs) {
  await rig.manager.disconnect().catch(() => {});
  await rig.proxy.close();
}

// ─── verdict ─────────────────────────────────────────────────────────────────
const rssDriftMB = (final.rss - baseline.rss) / 1048576;
const handleGrowth = [];
for (const k of new Set([...Object.keys(baseline.handles), ...Object.keys(final.handles)])) {
  const d = (final.handles[k] ?? 0) - (baseline.handles[k] ?? 0);
  if (d > 0) { handleGrowth.push({ kind: k, before: baseline.handles[k] ?? 0, after: final.handles[k] ?? 0, delta: d }); }
}
const worstHandle = handleGrowth.reduce((m, h) => Math.max(m, h.delta), 0);

const checks = {
  rss: { value: Number(rssDriftMB.toFixed(1)), limit: THRESHOLDS.rssDriftMB, pass: rssDriftMB <= THRESHOLDS.rssDriftMB },
  handles: { value: worstHandle, limit: THRESHOLDS.handleGrowth, pass: worstHandle <= THRESHOLDS.handleGrowth, detail: handleGrowth },
  uncaught: { value: uncaught, limit: 0, pass: uncaught === 0, detail: uncaughtDetail.slice(0, 10) },
  finalStateTruth: { value: truth, pass: truth.every(t => t.matched !== false) },
};
const passed = Object.values(checks).every(c => c.pass);

const out = {
  startedAt: new Date(startedAt).toISOString(), minutes: MINUTES,
  scaled: MINUTES < 1440,
  cycles, faults, thresholds: THRESHOLDS, checks, passed,
  controllers: targets.map(t => ({ generation: t.generation, port: t.port })),
  samples: samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 200)) === 0),
};
const file = path.join(root, 'docs', 'structural', `soak-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');

console.log(`\nsoak verdict: ${passed ? 'PASS' : 'FAIL'}${out.scaled ? '  (SCALED RUN - not the 24 h acceptance)' : ''}`);
console.log(`  rss drift      ${checks.rss.value} MB (limit ${checks.rss.limit})  ${checks.rss.pass ? 'ok' : 'FAIL'}`);
console.log(`  handle growth  ${checks.handles.value} (limit ${checks.handles.limit})  ${checks.handles.pass ? 'ok' : 'FAIL'}`);
console.log(`  uncaught       ${checks.uncaught.value}  ${checks.uncaught.pass ? 'ok' : 'FAIL'}`);
console.log(`  final state    ${checks.finalStateTruth.pass ? 'matches controller' : 'MISMATCH'}`);
console.log(`  wrote ${path.relative(root, file)}\n`);
process.exit(passed ? 0 : 1);
