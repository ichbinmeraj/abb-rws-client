/**
 * Logins that name a found controller (`identify: 'with-credentials'`).
 *
 * Rules:
 * - Only an entry that identified as RWS (`identified: true`) and has a matching `credentials`
 *   entry is logged in to. No default user is ever tried: the username and password always
 *   come from the caller's entry for that controller.
 * - Never over plain HTTP to a host that is not this PC (Basic and Digest credentials would cross
 *   the network readable or replayable), never to an address whose certificate failed
 *   verification, and never when a pinned certificate fingerprint differs.
 * - Every login ends with `/logout` whenever the controller handed out a session, also when
 *   `connect()` throws after the login was accepted (the RWS 1.0 client parses the state body
 *   after Digest succeeds; the RWS 2.0 client parses `/rw/system` after Basic succeeds).
 * - One login at a time by default. A cancel stops new logins; a login already sent finishes and
 *   logs out, because the controller may have accepted it.
 *
 * The protocol clients are built directly here (`RwsClient` wrapped in `RWS1Adapter`, or
 * `RWS2Adapter`), as `createAdapter` builds them but with no protocol probe and no defaults.
 */

import { RwsClient } from '../RwsClient.js';
import { RWS1Adapter } from '../RWS1Adapter.js';
import { RWS2Adapter } from '../RWS2Adapter.js';
import { Logger } from '../Logger.js';
import { RwsError, type SystemInfo } from '../types.js';
import type { Protocol } from '../detect.js';
import { canonicalHost, localAddressChecker } from './addresses.js';
import type { FoundController, IdentifyOutcome } from './types.js';

/** The realm every RWS controller seen so far sends in its 401; one definition, in the probe. */
export { RWS_REALM } from './probe.js';

/** Default per-request timeout of a discovery login, ms. */
export const LOGIN_TIMEOUT_MS = 5000;

/** One login: where, which protocol, and whose credentials. */
export interface LoginTarget {
  /** IPv4 literal, `'::1'` or `'localhost'`. */
  host: string;
  port: number;
  https: boolean;
  generation: Protocol;
  username: string;
  password: string;
  strictTls?: boolean;
  timeoutMs?: number;
}

/** The part of a protocol client a discovery login uses. */
export interface IdentifySession {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSessionCookie(): string | null;
  getSystemInfo(): Promise<SystemInfo>;
  getRobotType?(): Promise<{ type: string; variant?: string }>;
}

/** Builds the client for one login; tests pass a fake. */
export type SessionFactory = (target: LoginTarget) => IdentifySession;

/** What one login read. */
export interface LoginRead {
  systemName?: string;
  systemId?: string;
  rwVersion?: string;
  robotType?: string;
}

/** `[::1]` for an IPv6 literal, the host unchanged otherwise. */
function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Build the protocol client for one login, the same objects `createAdapter` builds, with the
 * username and password passed explicitly. RWS 1.0 is spoken over HTTP only by this client.
 *
 * @throws RwsError `INVALID_ARGUMENT` for RWS 1.0 over HTTPS, or an empty username.
 */
export const buildSession: SessionFactory = (t) => {
  if (typeof t.username !== 'string' || t.username === '') {
    throw new RwsError('A discovery login needs a non-empty username', 'INVALID_ARGUMENT');
  }
  const timeout = t.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const host = urlHost(t.host);
  if (t.generation === 'rws1') {
    if (t.https) {
      throw new RwsError(`RWS 1.0 over HTTPS is not supported by this client (${t.host}:${t.port})`, 'INVALID_ARGUMENT');
    }
    const inner = new RwsClient({ host, port: t.port, username: t.username, password: t.password, timeout });
    return new RWS1Adapter(inner, { host, port: t.port, username: t.username, password: t.password });
  }
  const scheme = t.https ? 'https' : 'http';
  return new RWS2Adapter(`${scheme}://${host}:${t.port}`, t.username, t.password, {
    timeout, rejectUnauthorized: t.strictTls === true,
  });
};

/**
 * Log in once, read the system name, id and RobotWare version (and, when asked, the robot type),
 * and log out. The logout runs in `finally` whenever the controller handed out a session, so a
 * `connect()` that throws after the login was accepted still ends with `/logout`. A failed
 * robot-type read leaves `robotType` absent; any other failure rejects with the client's error.
 */
export async function loginAndRead(
  target: LoginTarget,
  opts: { readRobotType?: boolean; createSession?: SessionFactory } = {},
): Promise<LoginRead> {
  const session = (opts.createSession ?? buildSession)(target);
  try {
    await session.connect();
    const info = await session.getSystemInfo();
    const out: LoginRead = {};
    if (info.name) { out.systemName = info.name; }
    if (info.sysid) { out.systemId = info.sysid; }
    if (info.rwVersion) { out.rwVersion = info.rwVersion; }
    if (opts.readRobotType && session.getRobotType) {
      try {
        const rt = await session.getRobotType();
        if (rt.type) { out.robotType = rt.type; }
      } catch { /* optional read */ }
    }
    return out;
  } finally {
    if (session.getSessionCookie() !== null) {
      await session.disconnect().catch(() => { /* best effort; the session expires on its own */ });
    }
  }
}

/** The fields of a found entry that the login rules read. */
export type IdentifyRow = Pick<FoundController,
  'key' | 'host' | 'port' | 'https' | 'generation' | 'identified' | 'realm' | 'name' | 'tlsFingerprint' | 'addresses'>;

/** `'host:port'` with the typed name first when there is one. */
function rowLabel(row: Pick<IdentifyRow, 'host' | 'port' | 'name'>): string {
  const where = `${row.host.includes(':') ? `[${row.host}]` : row.host}:${row.port}`;
  return row.name ? `${row.name} (${where})` : where;
}

/** Fingerprint spelling for comparison: hex digits only, lower case. */
export function normaliseFingerprint(fp: string): string {
  return fp.replace(/[\s:]/g, '').toLowerCase();
}

/**
 * Why `row` may not be logged in to, as a plain clause, or null when it may. Covers the rules that
 * need no caller data: not identified as RWS, unknown protocol or scheme, plain HTTP to another
 * host, RWS 1.0 over HTTPS.
 */
export function loginRefusalReason(
  row: Pick<IdentifyRow, 'host' | 'https' | 'generation' | 'identified' | 'realm'>,
  isLocal: (host: string) => boolean,
): string | null {
  if (!row.identified) {
    return row.realm !== undefined
      ? `it did not identify as an ABB controller (realm "${row.realm}")`
      : 'it did not identify as an ABB controller';
  }
  if (row.generation === null) { return 'its protocol is not known'; }
  if (row.https === null) { return 'it was never probed'; }
  if (row.https === false && !isLocal(row.host)) {
    return 'credentials are never sent over plain HTTP to another computer';
  }
  if (row.generation === 'rws1' && row.https) { return 'RWS 1.0 over HTTPS is not supported by this client'; }
  return null;
}

/** A parsed `credentials` or `pinnedFingerprints` key: host id (`'local'` or canonical) and optional port. */
export interface ParsedKey { host: string; port?: number }

/**
 * Parse a caller key: `discoveryKey` (`'local:5466'`), `'host:port'`, `'[v6]:port'` or `'host'`.
 * Any address of this PC (and `'localhost'`) becomes `'local'`. Undefined when it is not one
 * of those shapes.
 */
export function parseCallerKey(key: string, isLocal: (host: string) => boolean): ParsedKey | undefined {
  const k = key.trim();
  if (k === '') { return undefined; }
  let host: string;
  let portText: string | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(k);
  if (bracket) {
    host = bracket[1]; portText = bracket[2];
  } else {
    const colons = k.split(':').length - 1;
    if (colons === 1) {
      const i = k.indexOf(':');
      host = k.slice(0, i); portText = k.slice(i + 1);
      if (!/^\d+$/.test(portText)) { return undefined; }
    } else {
      host = k; // no port, or a bare IPv6 literal
    }
  }
  if (host === '') { return undefined; }
  let port: number | undefined;
  if (portText !== undefined) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { return undefined; }
  }
  const id = host.toLowerCase() === 'local' || isLocal(host) ? 'local' : canonicalHost(host);
  return port === undefined ? { host: id } : { host: id, port };
}

/** Options for `identifyOverNetwork`. */
export interface IdentifyOverNetworkOptions {
  /** As `FindControllersOptions.credentials` (already validated). */
  credentials: Record<string, { username: string; password: string }>;
  /** As `FindControllersOptions.pinnedFingerprints`. */
  pinnedFingerprints?: Record<string, string>;
  /** Addresses whose certificate failed verification; never logged in to. */
  tlsFailures?: ReadonlyArray<{ host: string; port: number }>;
  strictTls?: boolean;
  /** Per-request timeout of a login, ms. Default 5000. */
  timeoutMs?: number;
  /** Logins in flight. Default 1. */
  concurrency?: number;
  /** Stops new logins; a login already sent finishes and logs out. */
  signal?: AbortSignal;
  /** Whether a host is this PC. Default: one snapshot of this PC's addresses per call. */
  isLocal?: (host: string) => boolean;
  /** Builds the client per login. Default `buildSession`. */
  createSession?: SessionFactory;
  /** Called when a login starts, with the entry's key (for progress). */
  onLogin?: (key: string) => void;
}

/** What `identifyOverNetwork` resolves with. */
export interface IdentifyOverNetworkResult {
  /** One per entry that had a matching `credentials` entry, in entry order. */
  outcomes: IdentifyOutcome[];
  /** `credentials` keys that matched no entry. */
  unmatchedCredentials: string[];
  /** Plain sentences: each skipped or failed login and why. Never contains a password. */
  notes: string[];
}

/**
 * The ids and ports a row answers to. `own`: its own address and its typed name, the only ones a
 * credentials entry may match, because the login goes to `row.host`. `folded`: the other
 * addresses merged into it. A merge can rest on an unauthenticated system id (an mDNS TXT
 * record), so a key naming a folded address must never send its password to `row.host`.
 */
function rowIdentities(row: IdentifyRow, isLocal: (host: string) => boolean): {
  own: Array<{ host: string; port: number }>;
  folded: Array<{ host: string; port: number }>;
} {
  const id = (h: string): string => (isLocal(h) ? 'local' : canonicalHost(h));
  const own = [{ host: id(row.host), port: row.port }];
  if (row.name) { own.push({ host: id(row.name), port: row.port }); }
  const folded = (row.addresses ?? [])
    .map(a => ({ host: id(a.host), port: a.port }))
    .filter(a => !own.some(o => o.host === a.host && o.port === a.port));
  return { own, folded };
}

/** 2 when the key names this row's host and port, 1 for its host alone, 0 for no match. */
function matchScore(key: ParsedKey, ids: Array<{ host: string; port: number }>): number {
  let best = 0;
  for (const i of ids) {
    if (i.host !== key.host) { continue; }
    if (key.port === undefined) { best = Math.max(best, 1); } else if (key.port === i.port) { return 2; }
  }
  return best;
}

/** The message of an error, one line, at most 200 characters, with the password removed. */
function errorWords(err: unknown, password: string): string {
  const code = err instanceof RwsError ? err.code : undefined;
  let msg = err instanceof Error ? err.message : String(err);
  msg = msg.split(/\r?\n/)[0].slice(0, 200);
  if (password.length >= 4) { msg = msg.split(password).join('***'); }
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

/**
 * Log in to each identified entry that has a matching `credentials` entry and read its system
 * name, system id, RobotWare version and robot type. Key lookup per entry: its `discoveryKey`,
 * then every caller key canonicalised (`'host:port'` before `'host'`; the typed name, the IPv4
 * address, `'localhost'` and any address of this PC all count, the last three as `'local'`).
 * Another address merged into the entry never matches: the login goes to the entry's own
 * address, so such a key skips the entry with a note instead. Never rejects: a refused or failed login becomes a `failed` outcome and a note.
 */
export async function identifyOverNetwork(
  rows: readonly IdentifyRow[],
  opts: IdentifyOverNetworkOptions,
): Promise<IdentifyOverNetworkResult> {
  const isLocal = opts.isLocal ?? localAddressChecker();

  const keys: Array<{ text: string; parsed?: ParsedKey; cred?: { username: string; password: string } }> = [];
  for (const [text, cred] of Object.entries(opts.credentials ?? {})) {
    const ok = cred !== null && typeof cred === 'object' && typeof cred.username === 'string'
      && cred.username !== '' && typeof cred.password === 'string';
    keys.push({ text, parsed: parseCallerKey(text, isLocal), cred: ok ? cred : undefined });
  }
  const pins: Array<{ parsed: ParsedKey; fp: string }> = [];
  for (const [text, fp] of Object.entries(opts.pinnedFingerprints ?? {})) {
    const parsed = parseCallerKey(text, isLocal);
    if (parsed?.port !== undefined && typeof fp === 'string') { pins.push({ parsed, fp: normaliseFingerprint(fp) }); }
  }
  const tlsFailed = new Set((opts.tlsFailures ?? []).map(f => `${isLocal(f.host) ? 'local' : canonicalHost(f.host)}:${f.port}`));

  const matched = new Set<string>();
  type Job = { index: number; row: IdentifyRow; cred: { username: string; password: string } };
  const jobs: Job[] = [];
  const outcomes: Array<IdentifyOutcome | undefined> = [];

  rows.forEach((row, index) => {
    const { own: ids, folded } = rowIdentities(row, isLocal);
    let best: { score: number; key: (typeof keys)[number] } | undefined;
    let viaFolded: (typeof keys)[number] | undefined;
    for (const k of keys) {
      if (!k.parsed) { continue; }
      const score = matchScore(k.parsed, ids);
      if (score > 0) { matched.add(k.text); }
      if (score > 0 && k.cred && (!best || score > best.score)) { best = { score, key: k }; }
      if (score === 0 && k.cred && matchScore(k.parsed, folded) > 0) {
        matched.add(k.text);
        viaFolded ??= k;
      }
    }

    const label = rowLabel(row);
    const skip = (reason: string): void => {
      const note = `Not logged in to ${label}: ${reason}.`;
      outcomes[index] = { key: row.key, status: 'skipped', note };
    };
    if (!best?.key.cred) {
      // The key names another address merged into this entry; the login would go to row.host.
      if (viaFolded) {
        skip(`the credentials entry '${viaFolded.text}' names another address of this entry, and a login goes only to `
          + 'the address a credentials entry names');
      }
      return;
    }
    const refusal = loginRefusalReason(row, isLocal);
    if (refusal) { skip(refusal); return; }
    if (tlsFailed.has(`${ids[0].host}:${row.port}`)) { skip('its certificate failed verification'); return; }
    // A pin on any address of the entry is honoured: a mismatch only ever stops a login.
    const pin = pins.find(p => matchScore(p.parsed, ids) === 2 || matchScore(p.parsed, folded) === 2);
    if (pin && (row.tlsFingerprint === undefined || normaliseFingerprint(row.tlsFingerprint) !== pin.fp)) {
      skip('its certificate does not match the pinned fingerprint');
      return;
    }
    jobs.push({ index, row, cred: best.key.cred });
  });

  const concurrency = Math.max(1, Math.min(4, Math.floor(opts.concurrency ?? 1)));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const { index, row, cred } = jobs[next++];
      const label = rowLabel(row);
      if (opts.signal?.aborted) {
        outcomes[index] = { key: row.key, status: 'skipped', note: `Not logged in to ${label}: discovery was cancelled.` };
        continue;
      }
      opts.onLogin?.(row.key);
      Logger.info(`discovery: logging in to ${label} to read its identity`);
      try {
        const read = await loginAndRead({
          host: row.host, port: row.port, https: row.https === true, generation: row.generation as Protocol,
          username: cred.username, password: cred.password, strictTls: opts.strictTls, timeoutMs: opts.timeoutMs,
        }, { readRobotType: true, createSession: opts.createSession });
        outcomes[index] = { key: row.key, status: 'identified', generation: row.generation as Protocol, ...read };
      } catch (err) {
        const note = `Login to ${label} failed: ${errorWords(err, cred.password)}`;
        Logger.warn(`discovery: ${note}`);
        outcomes[index] = { key: row.key, status: 'failed', note };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  const done = outcomes.filter((o): o is IdentifyOutcome => o !== undefined);
  return {
    outcomes: done,
    unmatchedCredentials: keys.filter(k => !matched.has(k.text)).map(k => k.text),
    notes: done.filter(o => o.status !== 'identified' && o.note).map(o => o.note as string),
  };
}
