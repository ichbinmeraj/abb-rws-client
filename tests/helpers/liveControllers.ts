/**
 * Discovery of the local virtual controllers for structural live tests.
 *
 * Two hard rules from the task brief are enforced here rather than trusted to
 * every test:
 *
 *   1. LOCALHOST ONLY. Anything else throws before a single byte is sent. A
 *      structural suite injects faults - pointing it at a real or workplace
 *      robot must be impossible, not merely discouraged.
 *   2. NEVER assume a port. VC RWS ports drift across restarts (a warm restart
 *      was observed moving one from 62214 to 40483, and IRC5 comes back as a
 *      NEW process on a new port), so ports are discovered every run.
 *
 * RWS 1.0 (IRC5) is plain HTTP + Digest; RWS 2.0 (OmniCore) is TLS + Basic.
 * Probing an IRC5 over TLS looks like a dead port, which is why generation is
 * decided by the auth challenge rather than guessed from the port.
 *
 * Test infrastructure only - never shipped in the package.
 */

import http from 'node:http';
import https from 'node:https';

export type Generation = 'rws1' | 'rws2';

export interface LiveController {
  generation: Generation;
  host: '127.0.0.1';
  port: number;
  tls: boolean;
  /** Base URL in the shape RwsClient2 wants; RWS 1.0 callers use host/port. */
  baseUrl: string;
  label: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Hard refusal, per the brief: live suites must never leave the machine. */
export function assertLocalhost(host: string): void {
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `structural live tests refuse non-localhost host ${JSON.stringify(host)} - `
      + 'these suites inject faults and must never touch a real robot',
    );
  }
}

export const TEST_USER = process.env.RWS_TEST_USER ?? 'Default User';
export const TEST_PASS = process.env.RWS_TEST_PASS ?? 'robotics';

/** One unauthenticated request; the WWW-Authenticate challenge names the generation. */
function probe(port: number, tls: boolean, timeoutMs: number): Promise<Generation | null> {
  return new Promise(resolve => {
    const mod = tls ? https : http;
    const req = mod.request(
      {
        host: '127.0.0.1', port, path: '/rw/system', method: 'GET', timeout: timeoutMs,
        ...(tls ? { rejectUnauthorized: false } : {}),
      },
      res => {
        const challenge = String(res.headers['www-authenticate'] ?? '');
        res.resume();
        if (/digest/i.test(challenge)) { resolve('rws1'); return; }
        if (/basic/i.test(challenge)) { resolve('rws2'); return; }
        resolve(null);
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Ports to try, cheapest first: an explicit env override, then the ports seen
 * on this rig, then a scan is deliberately NOT done - a blind sweep of 65k
 * ports against localhost is slow and rude. Set RWS_TEST_PORT_RW6 /
 * RWS_TEST_PORT_RW7 when the VCs move.
 */
function candidatePorts(): Array<{ port: number; tls: boolean }> {
  const out: Array<{ port: number; tls: boolean }> = [];
  const rw6 = process.env.RWS_TEST_PORT_RW6;
  const rw7 = process.env.RWS_TEST_PORT_RW7;
  if (rw6) { out.push({ port: Number(rw6), tls: false }, { port: Number(rw6), tls: true }); }
  if (rw7) { out.push({ port: Number(rw7), tls: true }, { port: Number(rw7), tls: false }); }
  // Ports observed on this rig - HINTS ONLY, not configuration. They drift on
  // every restart (one IRC5 restart moved 35112 -> 29228 within a single
  // session), so when none of these answer, set RWS_TEST_PORT_RW6 /
  // RWS_TEST_PORT_RW7 rather than editing this list. Both the old and new
  // sightings are kept because a VC that comes back on its previous port is
  // common enough to be worth trying first.
  out.push(
    { port: 29228, tls: false },  // IRC5 RW6.16   (2026-08-09, after restart)
    { port: 35112, tls: false },  // IRC5 RW6.16   (2026-08-09, before restart)
    { port: 9805, tls: true },    // OmniCore RW7.21
    { port: 5466, tls: true },    // OmniCore RW8.1.1
    { port: 9403, tls: true },    // OmniCore RW8.1.1 (second instance)
    { port: 80, tls: false },
  );
  return out;
}

/**
 * Localhost ports that something is LISTENING on, asked of the OS.
 *
 * The hint list above goes stale on every restart, and the failure mode is
 * confusing: "no rws1 controller reachable" when the VC is running perfectly on
 * a port nobody told us about. Rather than make a human re-read netstat and set
 * an env var, ask the OS and probe what it reports.
 *
 * Best-effort by design: if the command is missing or its output is not what we
 * expect, this returns nothing and the hint list plus the env overrides remain
 * the path. Never widened beyond loopback.
 */
async function listeningPorts(): Promise<number[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const cmd = process.platform === 'win32'
    ? { file: 'netstat', args: ['-ano', '-p', 'TCP'] }
    : { file: 'ss', args: ['-ltn'] };
  let out = '';
  try {
    out = (await run(cmd.file, cmd.args, { timeout: 8000 })).stdout;
  } catch {
    return [];
  }
  const ports = new Set<number>();
  for (const line of out.split('\n')) {
    if (process.platform === 'win32' && !/LISTENING/.test(line)) { continue; }
    // Match 127.0.0.1:PORT and 0.0.0.0:PORT / [::]:PORT (bound on all interfaces
    // still means reachable on loopback).
    for (const m of line.matchAll(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})\b/g)) {
      const p = Number(m[1]);
      if (p > 0 && p < 65536) { ports.add(p); }
    }
  }
  return [...ports];
}

let cache: LiveController[] | null = null;

/** Discover every reachable local controller, one per generation at minimum. */
export async function discoverControllers(timeoutMs = 2500): Promise<LiveController[]> {
  if (cache) { return cache; }
  const found: LiveController[] = [];
  const seen = new Set<number>();
  for (const { port, tls } of candidatePorts()) {
    if (seen.has(port)) { continue; }
    const gen = await probe(port, tls, timeoutMs);
    if (!gen) { continue; }
    seen.add(port);
    assertLocalhost('127.0.0.1');
    found.push({
      generation: gen, host: '127.0.0.1', port, tls,
      baseUrl: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
      label: `${gen === 'rws1' ? 'IRC5/RW6' : 'OmniCore/RW7+'} :${port}`,
    });
  }
  // Nothing in the hint list answered for some generation - ask the OS which
  // ports are actually listening and probe those. This is what makes a drifted
  // port self-healing instead of a manual step.
  if (!found.some(c => c.generation === 'rws1') || !found.some(c => c.generation === 'rws2')) {
    for (const port of await listeningPorts()) {
      if (seen.has(port)) { continue; }
      seen.add(port);
      // Try TLS first, then plain: OmniCore is TLS, IRC5 is not, and probing a
      // plain-HTTP port with TLS looks exactly like a dead port.
      for (const tls of [true, false]) {
        const gen = await probe(port, tls, 800);
        if (!gen) { continue; }
        if (found.some(c => c.generation === gen)) { break; }
        found.push({
          generation: gen, host: '127.0.0.1', port, tls,
          baseUrl: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
          label: `${gen === 'rws1' ? 'IRC5/RW6' : 'OmniCore/RW7+'} :${port} (found by scan)`,
        });
        break;
      }
      if (found.some(c => c.generation === 'rws1') && found.some(c => c.generation === 'rws2')) { break; }
    }
  }

  cache = found;
  return found;
}

/** First reachable controller of a generation, or null when none is running. */
export async function controllerFor(generation: Generation): Promise<LiveController | null> {
  const all = await discoverControllers();
  return all.find(c => c.generation === generation) ?? null;
}

/**
 * Skip helper for describe blocks. A structural cell without its controller is
 * reported as untested by the runner - never as passing.
 */
export async function requireController(generation: Generation): Promise<LiveController> {
  const c = await controllerFor(generation);
  if (!c) {
    throw new Error(
      `no ${generation} controller reachable on localhost - start the VC, or set `
      + `${generation === 'rws1' ? 'RWS_TEST_PORT_RW6' : 'RWS_TEST_PORT_RW7'}`,
    );
  }
  return c;
}

/** Reset discovery (after a warm restart moved a port mid-suite). */
export function forgetControllers(): void { cache = null; }
