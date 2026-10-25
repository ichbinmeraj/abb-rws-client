import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import { RwsClient } from './RwsClient.js';
import { RwsClient2 } from './RwsClient2.js';
import { RWS1Adapter } from './RWS1Adapter.js';
import { RWS2Adapter } from './RWS2Adapter.js';
import { RwsError } from './types.js';
import { MAX_TIMER_MS, checkedTimeout } from './HttpSession.js';
import type { IRWSAdapter } from './IRWSAdapter.js';
import { checkControlStationIdentity, type ControlStationIdentity } from './controlStation.js';
import { buildPath, type PathSpec } from './paths/PathSpec.js';
import { SYSTEM_MASTERSHIP } from './paths/systemMastership.js';
import { KNOWN_RWS_PORTS, candidatesForPort, describeRwsPorts } from './discovery/scheme.js';
import { strictTlsCaOption } from './tlsTrust.js';

// The port table lives with discovery; re-exported here so the import path
// `detect.js` keeps working.
export { KNOWN_RWS_PORTS };

export type AnyClient = RwsClient | RwsClient2;
export type Protocol = 'rws1' | 'rws2';

export interface ConnectOptions {
  /** Hostname or IP, e.g. '192.168.125.1' or '127.0.0.1'. */
  host: string;
  /**
   * TCP port. If omitted, the known RWS ports are probed one at a time, in
   * order, and the first that answers is used: 443 (https), 80 (https and
   * http at once), then the common virtual-controller ports 5466, 9403, 9805, 11622
   * (https) and 11811, 28447 (http).
   */
  port?: number;
  /**
   * Force the transport scheme. If omitted, the port decides: a known port
   * with one scheme uses it (443, 5466, 9403, 9805, 11622 https; 11811, 28447
   * http). Port 80, and any port not in that list, is probed over HTTPS and
   * HTTP at the same time and the scheme that answers with an RWS challenge
   * is used: an IRC5 serves HTTP on 80, while the RobotWare 8.1.1 virtual
   * controller serves HTTPS there (live-verified 2026-09-27 on RW 8.1.1+614).
   */
  https?: boolean;
  /**
   * Default 'Admin'. The client logs in once, as this user. A refused login
   * throws `AUTH_FAILED`; no other account is tried, because another account
   * carries other UAS grants.
   */
  username?: string;
  /** Default 'robotics'. */
  password?: string;
  /**
   * Per-request timeout in ms. Default 5000. A finite number above 0 and at
   * most 2^31-1 (about 24.8 days); anything else throws INVALID_ARGUMENT
   * before any probe is sent, the same rule as `RwsClient` and `RwsClient2`.
   * It also bounds each wait of the protocol probes; left out, a probe waits
   * 1500 ms per known port, or 3000 ms on the port given.
   */
  timeout?: number;
  /**
   * Verify TLS certificates. Default false - ABB controllers (virtual and
   * real) ship self-signed certs, so verification stays off unless the
   * deployment has a CA-signed cert on the controller. Applies to the probe
   * requests and to the RWS 2.0 client this factory constructs, which check a
   * certificate against the same authorities: Node's default ones and the
   * operating system's store (tlsTrust.ts). Off, that client logs a warning
   * once per host and port (not on this PC's loopback).
   * Live-verified 2026-07-09: strict probe rejects the OmniCore VC's
   * self-signed cert (RW7.21); default detects it; plain-HTTP IRC5 unaffected.
   */
  strictTls?: boolean;
  /**
   * The RobotWare 8 control station to register as: a name, a stored braced
   * GUID and a PIN you supply, and optionally `releaseWriteAccessWhenLost`
   * (default false, pending live confirmation). See `ControlStationIdentity`.
   * Checked before anything is sent; a malformed value throws
   * `INVALID_ARGUMENT`. Ignored on RobotWare 6 and 7. Without it the client
   * registers as an anonymous station, as before, and logs that once.
   */
  controlStation?: ControlStationIdentity;
}

export interface ProbeResult {
  protocol: Protocol;
  port: number;
  https: boolean;
}

/**
 * Probe a single host:port and return which RWS protocol it speaks, or null if
 * neither. Reads the WWW-Authenticate header on a 401:
 *   - "Digest …"  → RWS 1.0
 *   - "Basic …"   → RWS 2.0
 *
 * `timeoutMs` bounds each wait, not the whole exchange: the TCP connect
 * (name lookup not counted), then every silence after it. The probe as a
 * whole is capped at four times `timeoutMs` (at most 2^31-1 ms). Like the
 * clients' `timeout`, it must be a finite number above 0 and at most 2^31-1;
 * anything else is refused with INVALID_ARGUMENT and nothing is sent.
 */
export async function probeProtocol(
  host: string,
  port: number,
  useHttps: boolean,
  timeoutMs = 3000,
  strictTls = false,
): Promise<Protocol | null> {
  return probeOnce(host, port, useHttps, checkedTimeout(timeoutMs, 3000, 'probeProtocol'), strictTls);
}

/**
 * The unauthenticated version probe, `GET /rw/system`: the same row for both
 * generations in the path table.
 */
const PROBE_PATH = buildPath(SYSTEM_MASTERSHIP.getSystemInfo.rws2 as PathSpec);

/**
 * `probeProtocol`'s body, plus an optional `signal` that ends the probe at
 * once (answer null). Used to drop the losing scheme when both are probed.
 */
function probeOnce(
  host: string,
  port: number,
  useHttps: boolean,
  timeoutMs: number,
  strictTls: boolean,
  signal?: AbortSignal,
): Promise<Protocol | null> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(null); return; }
    const insecure = useHttps && !strictTls;
    const agent = insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    const options: http.RequestOptions & { agent?: https.Agent; rejectUnauthorized?: boolean } = {
      method: 'GET',
      hostname: host,
      port,
      path: PROBE_PATH,
      headers: { Accept: 'application/xhtml+xml;v=2.0' },
      agent,
      // Per-request as well as on the agent: agent-swapping hosts (VS Code extension
      // host on non-localhost targets) otherwise re-enable TLS verification (issue #2).
      // Under strictTls neither is set, so certs verify, against the same
      // authorities as the client's requests (tlsTrust.ts).
      ...(insecure ? { rejectUnauthorized: false } : {}),
      ...(useHttps && strictTls ? strictTlsCaOption() : {}),
    };
    const transport = useHttps ? https : http;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const answer = (proto: Protocol | null): void => {
      clearTimeout(connectTimer);
      clearTimeout(capTimer);
      if (onAbort) { signal?.removeEventListener('abort', onAbort); }
      resolve(proto);
    };
    let req: http.ClientRequest;
    try {
      req = (transport as typeof https).request(options as https.RequestOptions, res => {
        const auth = (res.headers['www-authenticate'] || '').toString().toLowerCase();
        // Drain the body so the socket can return to the pool.
        res.on('data', () => {});
        // A body cut off mid-way never reaches 'end'; without these the probe
        // stayed pending for good. After 'end' they are no-ops.
        res.on('error', () => answer(null));
        res.on('close', () => answer(null));
        res.on('end', () => {
          if (auth.startsWith('digest ')) { answer('rws1'); return; }
          if (auth.startsWith('basic '))  { answer('rws2'); return; }
          // No Digest/Basic challenge → not an RWS controller. Anything else that
          // answers /rw/system (Bearer-protected services, random web servers,
          // captive portals) used to be misreported as rws2, sending connect
          // attempts at hosts that will never speak the protocol. Controllers
          // always challenge an unauthenticated probe, so there is no legitimate
          // challenge-less case to allow.
          answer(null);
        });
      });
    } catch {
      // request() throws at once on input it cannot send at all (a port
      // outside 0-65535, a CR or LF in the host): no endpoint answers there.
      // The timers are armed only below, once there is a request for them to end.
      resolve(null);
      return;
    }
    const giveUp = (): void => { req.destroy(); answer(null); };
    // Listened for before any timer is armed: a destroyed request emits
    // 'error', and one with no listener is thrown out of the process.
    req.on('error', () => answer(null));
    // Three limits, because no single one tells a slow link from a stuck peer:
    //  - The TCP connect gets timeoutMs, counted once the name has resolved, so
    //    a dead host costs timeoutMs rather than the OS connect timeout, while
    //    a name that resolves slowly (an LLMNR fallback) keeps its budget.
    //  - After that, timeoutMs of silence. Each round trip of the TLS handshake
    //    and the 401 gets the whole budget, so a high-latency link still
    //    answers although the exchange as a whole takes longer than timeoutMs.
    //  - The whole probe is capped at four times timeoutMs: a peer that
    //    trickles bytes never trips the idle limit, and a lookup can stall.
    //    No more than a timer holds: a longer delay fires after 1 ms.
    capTimer = setTimeout(giveUp, Math.min(timeoutMs * 4, MAX_TIMER_MS));
    req.on('socket', socket => {
      if (!socket.connecting) { return; } // a pooled socket, already connected
      const arm = (): void => { connectTimer = setTimeout(giveUp, timeoutMs); };
      // An IP literal is connected at once; a name emits 'lookup' when resolved.
      if (net.isIP(host)) { arm(); } else { socket.once('lookup', arm); }
      socket.once('connect', () => clearTimeout(connectTimer));
    });
    req.setTimeout(timeoutMs, giveUp);
    if (signal) {
      onAbort = giveUp;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

/**
 * Detect the protocol on one host:port, choosing the scheme as
 * `ConnectOptions.https` describes: the given scheme; else the one scheme the
 * port table names; else (port 80, or a port outside the table) HTTPS and
 * HTTP at the same time. Two probes at once rather than one after the other,
 * so a port that leaves the wrong scheme hanging (a plain-HTTP server waiting
 * for a request line that a TLS handshake never sends) costs no extra wait. A
 * port speaks one scheme, so the first to answer with an RWS challenge wins,
 * and the other probe is ended at once.
 */
async function detectOnPort(
  host: string, port: number, https: boolean | undefined, timeoutMs: number | undefined, strictTls: boolean,
): Promise<{ protocol: Protocol; https: boolean } | null> {
  const candidates = candidatesForPort(port, https);
  if (candidates.length === 1) {
    const protocol = await probeProtocol(host, port, candidates[0].https, timeoutMs, strictTls);
    return protocol ? { protocol, https: candidates[0].https } : null;
  }
  const stop = new AbortController();
  let pending = candidates.length;
  return new Promise(resolve => {
    for (const c of candidates) {
      void probeOnce(host, port, c.https, timeoutMs ?? 3000, strictTls, stop.signal).then(protocol => {
        pending--;
        if (stop.signal.aborted) { return; }       // another scheme already won
        if (protocol) {
          stop.abort();
          resolve({ protocol, https: c.https });
        } else if (pending === 0) {
          resolve(null);
        }
      });
    }
  });
}

/** The PROTOCOL_DETECT_FAILED error for a host where no known port answered. */
function noEndpointError(host: string): RwsError {
  return new RwsError(
    `No RWS endpoint found on ${host} - tried ports ${describeRwsPorts(KNOWN_RWS_PORTS)}`,
    'PROTOCOL_DETECT_FAILED',
  );
}

/**
 * Probe the known RWS ports on a host, one port at a time, and return the
 * first that answers. Ports, schemes and order come from `KNOWN_RWS_PORTS`:
 * 443 (https), 80 (https and http), then the common virtual-controller ports.
 * A port listed with both schemes (80) is probed over both at once, as
 * `detectOnPort` does, so an IRC5's plain-HTTP server on 80, which leaves a
 * TLS handshake unanswered (the RW 6.16.03 VC does, observed 2026-10-03),
 * costs no timeout. Closed ports fail fast (connection refused is immediate),
 * so trying the real-controller ports first costs nothing when the target is
 * a virtual controller. `timeoutMs` follows `probeProtocol`'s rule.
 */
export async function probeHost(host: string, timeoutMs = 1500, strictTls = false): Promise<ProbeResult | null> {
  const waitMs = checkedTimeout(timeoutMs, 1500, 'probeHost');
  for (const port of new Set(KNOWN_RWS_PORTS.map(e => e.port))) {
    const hit = await detectOnPort(host, port, undefined, waitMs, strictTls);
    if (hit) { return { protocol: hit.protocol, port, https: hit.https }; }
  }
  return null;
}

/**
 * True when the failure is a credential rejection, in either protocol's flavor:
 * RwsClient throws RwsError code='AUTH_FAILED' (message has no "401"), RwsClient2
 * throws RwsError code='AUTH_FAILED' with the HTTP status in the message. A
 * plain error naming a 401 counts too.
 */
function isAuthRejection(err: unknown): boolean {
  if (err instanceof RwsError) { return err.code === 'AUTH_FAILED'; }
  return /401|unauthor/i.test(String(err));
}

/**
 * The error for a login the controller refused at connect: `AUTH_FAILED`,
 * naming the host, the port and the user tried, with the client's own
 * message kept. Any other failure is returned as it is.
 *
 * The factories log in once, as the user given - or as the default 'Admin'
 * when none is given - and never try another account on their own. Which
 * account is logged in decides which UAS grants apply, so a silent switch to
 * another account (earlier versions retried as 'Default User') would change
 * what this client may do without the caller knowing. The password is never
 * part of the message.
 */
function loginRefused(err: unknown, host: string, port: number, username: string, defaulted: boolean): unknown {
  if (!isAuthRejection(err)) { return err; }
  const detail = err instanceof Error ? err.message : String(err);
  const hint = defaulted
    ? 'No username was given, so the default \'Admin\' was used; the client does not try another account on its own. '
      + 'Pass the username of an account on this controller (an IRC5, for example, ships with \'Default User\').'
    : 'Check the username and password. The client does not try another account on its own.';
  const status = err instanceof RwsError ? err.httpStatus ?? 401 : 401;
  const rwsDetail = err instanceof RwsError ? err.rwsDetail : undefined;
  return new RwsError(`Login to ${host}:${port} as '${username}' was refused (${detail}). ${hint}`, 'AUTH_FAILED', status, rwsDetail);
}

/**
 * The RWS 2.0 client options a factory passes on: the idle timeout, TLS
 * verification and, when the caller gave one, the checked control-station
 * identity. Checked first, so a malformed identity fails before any probe.
 */
function rws2ClientOptions(opts: ConnectOptions, timeout: number, strictTls: boolean): {
  timeout: number; rejectUnauthorized: boolean; controlStation?: ControlStationIdentity;
} {
  const controlStation = opts.controlStation === undefined
    ? undefined
    : checkControlStationIdentity(opts.controlStation, 'ConnectOptions.controlStation');
  return { timeout, rejectUnauthorized: strictTls, ...(controlStation ? { controlStation } : {}) };
}

/**
 * Where and how to log in: the port, scheme and protocol the factories use.
 * Without a port, `probeHost` walks the known ports; with one, `detectOnPort`
 * picks the scheme as `ConnectOptions.https` describes.
 *
 * @throws RwsError code='PROTOCOL_DETECT_FAILED' when nothing answers with an
 *   RWS challenge; the message names what was tried.
 */
async function locateEndpoint(
  opts: ConnectOptions, strictTls: boolean,
): Promise<{ port: number; https: boolean; protocol: Protocol }> {
  const { host } = opts;
  // Checked by the factory; null, like undefined, leaves each probe its own default.
  const waitMs = opts.timeout ?? undefined;
  if (opts.port === undefined) {
    const probe = await probeHost(host, waitMs, strictTls);
    if (!probe) { throw noEndpointError(host); }
    return { port: probe.port, https: probe.https, protocol: probe.protocol };
  }
  const port = opts.port;
  const found = await detectOnPort(host, port, opts.https, waitMs, strictTls);
  if (!found) {
    const tried = candidatesForPort(port, opts.https).map(c => (c.https ? 'https' : 'http')).join(' and ');
    throw new RwsError(
      `No RWS auth challenge from ${host}:${port} (tried ${tried}) - controller may be off, wrong port, or non-RWS service`,
      'PROTOCOL_DETECT_FAILED',
    );
  }
  return { port, https: found.https, protocol: found.protocol };
}

/**
 * Probe a controller's auth scheme and return the matching protocol-level client,
 * already connected. The returned client is either an `RwsClient` (RWS 1.0) or
 * `RwsClient2` (RWS 2.0); use `client instanceof RwsClient2` (or check `protocol`)
 * to narrow if you need protocol-specific behavior.
 *
 * It logs in once, as `opts.username` (default 'Admin'), and never falls back
 * to another account.
 *
 * @throws RwsError code='INVALID_ARGUMENT' for a `timeout` outside its range
 *   or a malformed `controlStation`, before anything is sent.
 * @throws RwsError code='PROTOCOL_DETECT_FAILED' when neither auth scheme is detected.
 * @throws RwsError code='AUTH_FAILED' when the controller refuses the login,
 *   naming the host, port and user tried.
 */
export async function createClient(opts: ConnectOptions): Promise<AnyClient> {
  const { host, username = 'Admin', password = 'robotics' } = opts;
  // Checked before any probe, so a value Node's timers cannot hold never
  // reaches one (see ConnectOptions.timeout).
  const timeout = checkedTimeout(opts.timeout, 5000, 'createClient');
  const strictTls = opts.strictTls === true;
  const clientOpts = rws2ClientOptions(opts, timeout, strictTls);

  const { port, https: useHttps, protocol } = await locateEndpoint(opts, strictTls);

  // One login, as the user given (or the default); a refused login is
  // AUTH_FAILED and no other account is tried - see loginRefused.
  const defaulted = opts.username === undefined;
  try {
    if (protocol === 'rws1') {
      const c = new RwsClient({ host, port, username, password, timeout });
      await c.connect();
      return c;
    }
    const scheme = useHttps ? 'https' : 'http';
    const c = new RwsClient2(`${scheme}://${host}:${port}`, username, password, clientOpts);
    await c.connect();
    return c;
  } catch (err) {
    throw loginRefused(err, host, port, username, defaulted);
  }
}

/**
 * Like `createClient` but returns the unified-interface adapter (`IRWSAdapter`).
 * Use this when you want to hold a single typed reference across both protocols
 * - e.g. if you write code that calls `.getControllerState()` etc. without
 * caring whether the underlying transport is 1.0 or 2.0.
 *
 * Logs in once, as `createClient` does: a refused login throws `AUTH_FAILED`
 * and no other account is tried. `timeout` is checked first, as there.
 */
export async function createAdapter(opts: ConnectOptions): Promise<IRWSAdapter> {
  const { host, username = 'Admin', password = 'robotics' } = opts;
  const timeout = checkedTimeout(opts.timeout, 5000, 'createAdapter');
  const strictTls = opts.strictTls === true;
  const clientOpts = rws2ClientOptions(opts, timeout, strictTls);

  const { port, https: useHttps, protocol } = await locateEndpoint(opts, strictTls);

  // One login, as createClient: no other account is tried.
  const defaulted = opts.username === undefined;
  try {
    if (protocol === 'rws1') {
      const inner = new RwsClient({ host, port, username, password, timeout });
      await inner.connect();
      return new RWS1Adapter(inner, { host, port, username, password });
    }
    const scheme = useHttps ? 'https' : 'http';
    const a = new RWS2Adapter(`${scheme}://${host}:${port}`, username, password, clientOpts);
    await a.connect();
    return a;
  } catch (err) {
    throw loginRefused(err, host, port, username, defaulted);
  }
}
