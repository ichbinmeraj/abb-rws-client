/**
 * Wire trace of a functional run: every line the client hands its Logger
 * (the `http.req` / `http.res` / `http.err` trace categories, subscription,
 * access and quality traces, info, warnings and errors) plus the harness's own
 * notes, appended as JSON lines to
 *
 *   test-results/functional/<run id>/<lane>.jsonl
 *
 * The client's Logger is process-wide and its trace data does not name the
 * controller, so lines are routed by the lane the harness says is running
 * (`setTraceLane`). Test files run one at a time and lanes one after another
 * inside a file, so that attribution holds; lines logged while no lane runs
 * (fleet discovery) go to `fleet.jsonl`.
 *
 * Nor does the trace data name the session (the client object) that sent a
 * request, and on a lane several are open at once: the manager, the
 * harness's observer, extra adapters, clients and managers a test asked for.
 * So each line carries `session`, the label of the session whose call caused
 * it: the harness hands out every session through `labelSession`, whose
 * method calls run inside an AsyncLocalStorage scope that follows the call's
 * own async work (the request queue, the response, and the timers and
 * WebSocket a `connect` starts). Labels: `manager#<n>` (the lane's manager,
 * n counting its connects), `observer#<n>` (the harness's own read session;
 * on RWS 1.0 the observer is the manager's session and carries its label),
 * `adapter-<k>` / `client-<k>` / `manager-<k>` (extra sessions, k in the
 * order the lane handed them out) and `fleet:<port>` (discovery logins).
 * A line with no `session` came from a call made outside any labelled
 * session (the test's or harness's own notes, a reach into a raw adapter).
 *
 * Credentials and cookie values never reach the file: request bodies are
 * already redacted by the client, and every string is scrubbed again here
 * (form secrets, Cookie / Set-Cookie / Authorization values, session cookies,
 * Basic and Digest credentials, and the test password itself), object keys
 * included: a note keyed by a value (ABB's example feature id
 * 'abb.robotics.robotcontrol...' holds the default password as a word) is
 * masked like the same text in a value.
 *
 * Test infrastructure only - never shipped in the package.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { setLogger, type Logger } from '../../../src/index.js';
import { redactBody } from '../../../src/redact.js';
import { RUN_DIR, TEST_PASS, type Lane } from './config.js';

export type TraceLevel = 'trace' | 'info' | 'warn' | 'error' | 'harness' | 'test';

export interface TraceLine {
  t: string;
  lane: Lane | 'fleet';
  file: string | null;
  /** The session whose call caused the line (see `labelSession`); absent outside one. */
  session?: string;
  level: TraceLevel;
  cat?: string;
  msg: string;
  data?: unknown;
}

// ─── Session labels ──────────────────────────────────────────────────────────

const sessionScope = new AsyncLocalStorage<string>();

/** The label of the session whose call is running now, or null. */
export function traceSession(): string | null {
  return sessionScope.getStore() ?? null;
}

/**
 * Run `fn` under the session label `label`: every trace line it causes, now
 * or later in async work it starts (a login, the timers of a connect), carries
 * it. Use it around the call that creates a session (`createAdapter`).
 */
export function withTraceSession<T>(label: string, fn: () => T): T {
  return sessionScope.run(label, fn);
}

const labelled = new WeakMap<object, object>();

/**
 * A view of `session` (a RobotManager, adapter or protocol client) whose
 * method calls run under `label` (a string, or a getter read at each call so
 * a label can change on a reconnect). Everything else passes through: property
 * reads and writes reach the object itself, methods run with the object itself
 * as `this`, and `instanceof` answers as for the object. The same object gets
 * the same view on every call (the first label wins), so identity checks on
 * handed-out sessions keep working.
 */
export function labelSession<T extends object>(session: T, label: string | (() => string)): T {
  const known = labelled.get(session);
  if (known) { return known as T; }
  const labelOf = typeof label === 'function' ? label : (): string => label;
  const wrappers = new Map<PropertyKey, { fn: unknown; wrapped: unknown }>();
  const view = new Proxy(session, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || prop === 'constructor') { return value; }
      const cached = wrappers.get(prop);
      if (cached && cached.fn === value) { return cached.wrapped; }
      const fn = value as (...args: unknown[]) => unknown;
      const wrapped = (...args: unknown[]): unknown => sessionScope.run(labelOf(), () => Reflect.apply(fn, target, args));
      wrappers.set(prop, { fn: value, wrapped });
      return wrapped;
    },
  });
  labelled.set(session, view);
  return view;
}

let currentLane: Lane | null = null;
let currentFile: string | null = null;
let installed = false;

/** Route the lines that follow to `<lane>.jsonl` (null: back to fleet.jsonl). */
export function setTraceLane(lane: Lane | null, fileTag: string | null = currentFile): void {
  currentLane = lane;
  currentFile = fileTag;
}

/** The lane lines are routed to now, or null. */
export function traceLane(): Lane | null { return currentLane; }

/** Absolute path of the trace file of a lane (or of the fleet file). */
export function traceFile(lane: Lane | 'fleet'): string {
  return path.join(RUN_DIR, `${lane}.jsonl`);
}

const SECRET_FIELD = /^(authorization|cookie|set-cookie|password|passwd|pass|pin|pincode|token|secret|credential|control-station-id)$/i;

/** Mask credential-shaped values in a free-text string. */
export function scrubString(s: string): string {
  let out = redactBody(s) ?? s;
  out = out
    // Header-shaped: "Cookie: a=b; c=d", "authorization=...", JSON "cookie":"..."
    .replace(/((?:set-)?cookie|authorization)("?\s*[:=]\s*"?)([^"\r\n]*)/gi, (_m, k: string, sep: string) => `${k}${sep}***`)
    // Session cookies by name, wherever they appear.
    .replace(/(-http-session-|http-session|ABBCX|session)=([^;\s"&]+)/gi, (_m, k: string) => `${k}=***`)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{6,}/g, 'Basic ***')
    .replace(/\bDigest\s+.*$/gm, 'Digest ***');
  if (TEST_PASS.length >= 4) { out = out.split(TEST_PASS).join('***'); }
  return out;
}

/** Deep copy of `value` with secret-named fields masked and every string, keys included, scrubbed. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) { return '[depth]'; }
  if (typeof value === 'string') { return scrubString(value); }
  if (value === null || typeof value !== 'object') { return value; }
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }
  if (Array.isArray(value)) { return value.map(v => scrub(v, depth + 1)); }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // A key is data too (a note may be keyed by a value): scrubbed like a
    // string, and kept apart from a key it now equals.
    let key = scrubString(k);
    while (Object.prototype.hasOwnProperty.call(out, key)) { key = `${key}*`; }
    out[key] = SECRET_FIELD.test(k) ? '***' : scrub(v, depth + 1);
  }
  return out;
}

let dirReady = false;

/** Append one line to the current lane's file. Never throws: a trace must not fail a test. */
export function writeTrace(level: TraceLevel, msg: string, data?: unknown, cat?: string): void {
  try {
    if (!dirReady) { fs.mkdirSync(RUN_DIR, { recursive: true }); dirReady = true; }
    const session = sessionScope.getStore();
    const line: TraceLine = {
      t: new Date().toISOString(),
      lane: currentLane ?? 'fleet',
      file: currentFile,
      ...(session ? { session } : {}),
      level,
      ...(cat ? { cat } : {}),
      msg: scrubString(msg),
      ...(data !== undefined ? { data: scrub(data) } : {}),
    };
    fs.appendFileSync(traceFile(line.lane), JSON.stringify(line) + '\n');
  } catch { /* tracing is evidence, never a failure cause */ }
}

/** A harness note (restore steps, skips, discovery results). */
export function harnessNote(msg: string, data?: unknown): void {
  writeTrace('harness', msg, data);
}

/**
 * Install the trace logger (once per process; later calls are no-ops). The
 * client keeps one Logger per process, so this replaces any other logger.
 */
export function installTrace(): void {
  if (installed) { return; }
  installed = true;
  const logger: Logger = {
    info(msg) { writeTrace('info', msg); },
    warn(msg) { writeTrace('warn', msg); },
    error(msg, err) { writeTrace('error', msg, err instanceof Error ? err : err === undefined ? undefined : { value: String(err) }); },
    trace(category, msg, data) { writeTrace('trace', msg, data, category); },
    show() { /* no surface to show */ },
  };
  setLogger(logger);
}

/**
 * A failed beforeAll / afterAll of a lane, one JSON line each in
 * hook-failures.jsonl. Vitest's JSON report shows a lane whose beforeAll
 * failed as pending tests with no message; the runner reads this file to
 * report it as failed, with the error.
 */
export function recordHookFailure(entry: { file: string; lane: Lane; hook: 'beforeAll' | 'afterAll'; error: string }): void {
  try {
    if (!dirReady) { fs.mkdirSync(RUN_DIR, { recursive: true }); dirReady = true; }
    fs.appendFileSync(path.join(RUN_DIR, 'hook-failures.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...entry, error: scrubString(entry.error) }) + '\n');
  } catch { /* evidence only */ }
  writeTrace('harness', `${entry.hook} failed: ${entry.error}`);
}

/**
 * Skip reasons of this run, one JSON line each, so the runner can list why a
 * test did not run (vitest 1.x has no skip note).
 */
export function recordSkip(entry: { file: string; lane: Lane; test: string; reason: string }): void {
  try {
    if (!dirReady) { fs.mkdirSync(RUN_DIR, { recursive: true }); dirReady = true; }
    fs.appendFileSync(path.join(RUN_DIR, 'skips.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* evidence only */ }
  writeTrace('harness', `skipped "${entry.test}": ${entry.reason}`);
}
