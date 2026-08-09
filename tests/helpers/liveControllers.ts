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
  // Observed on this rig 2026-08-09.
  out.push(
    { port: 35112, tls: false },  // IRC5 RW6.16
    { port: 9805, tls: true },    // OmniCore RW7.21
    { port: 5466, tls: true },    // OmniCore RW8.1.1
    { port: 9403, tls: true },    // OmniCore RW8.1.1 (second instance)
    { port: 80, tls: false },
  );
  return out;
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
