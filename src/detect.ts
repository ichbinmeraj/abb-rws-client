import * as https from 'https';
import * as http from 'http';
import { RwsClient } from './RwsClient.js';
import { RwsClient2 } from './RwsClient2.js';
import { RWS1Adapter } from './RWS1Adapter.js';
import { RWS2Adapter } from './RWS2Adapter.js';
import { RwsError } from './types.js';
import type { IRWSAdapter } from './IRWSAdapter.js';

export type AnyClient = RwsClient | RwsClient2;
export type Protocol = 'rws1' | 'rws2';

export interface ConnectOptions {
  /** Hostname or IP, e.g. '192.168.125.1' or '127.0.0.1'. */
  host: string;
  /** TCP port. If omitted, common ports are probed (5466, 9403, 443 https; 80, 11811 http). */
  port?: number;
  /** Force the transport scheme. If omitted, inferred from port (443, 5466, 9403 → https). */
  https?: boolean;
  /** Default 'Admin'. */
  username?: string;
  /** Default 'robotics'. */
  password?: string;
  /** Per-request timeout in ms. Default 5000. */
  timeout?: number;
  /**
   * Verify TLS certificates. Default false - ABB controllers (virtual and
   * real) ship self-signed certs, so verification stays off unless the
   * deployment has a CA-signed cert on the controller. Applies to the probe
   * requests and to the RWS 2.0 client this factory constructs.
   * Live-verified 2026-07-09: strict probe rejects the OmniCore VC's
   * self-signed cert (RW7.21); default detects it; plain-HTTP IRC5 unaffected.
   */
  strictTls?: boolean;
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
 */
export async function probeProtocol(
  host: string,
  port: number,
  useHttps: boolean,
  timeoutMs = 3000,
  strictTls = false,
): Promise<Protocol | null> {
  return new Promise(resolve => {
    const insecure = useHttps && !strictTls;
    const agent = insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    const options: http.RequestOptions & { agent?: https.Agent; rejectUnauthorized?: boolean } = {
      method: 'GET',
      hostname: host,
      port,
      path: '/rw/system',
      headers: { Accept: 'application/xhtml+xml;v=2.0' },
      agent,
      // Per-request as well as on the agent: agent-swapping hosts (VS Code extension
      // host on non-localhost targets) otherwise re-enable TLS verification (issue #2).
      // Under strictTls neither is set, so certs verify normally.
      ...(insecure ? { rejectUnauthorized: false } : {}),
    };
    const transport = useHttps ? https : http;
    const req = (transport as typeof https).request(options as https.RequestOptions, res => {
      const auth = (res.headers['www-authenticate'] || '').toString().toLowerCase();
      // Drain the body so the socket can return to the pool.
      res.on('data', () => {});
      res.on('end', () => {
        if (auth.startsWith('digest ')) { resolve('rws1'); return; }
        if (auth.startsWith('basic '))  { resolve('rws2'); return; }
        // No Digest/Basic challenge → not an RWS controller. Anything else that
        // answers /rw/system (Bearer-protected services, random web servers,
        // captive portals) used to be misreported as rws2, sending connect
        // attempts at hosts that will never speak the protocol. Controllers
        // always challenge an unauthenticated probe, so there is no legitimate
        // challenge-less case to allow.
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Probe common RWS ports on a host and return the first one that answers.
 * Order favors known defaults: 5466 (OmniCore VC HTTPS), 9403 (alt OmniCore),
 * 443 (real OmniCore), 80 (real IRC5 HTTP), 11811 (legacy IRC5 VC).
 */
export async function probeHost(host: string, timeoutMs = 1500, strictTls = false): Promise<ProbeResult | null> {
  const candidates: Array<[number, boolean]> = [
    [5466,  true ],
    [9403,  true ],
    [443,   true ],
    [80,    false],
    [11811, false],
  ];
  for (const [port, https] of candidates) {
    const proto = await probeProtocol(host, port, https, timeoutMs, strictTls);
    if (proto) { return { protocol: proto, port, https }; }
  }
  return null;
}

/**
 * True when the failure is a credential rejection, in either protocol's flavor:
 * RwsClient throws RwsError code='AUTH_FAILED' (message has no "401"), RwsClient2
 * throws a plain Error with the HTTP status in the message.
 */
function isAuthRejection(err: unknown): boolean {
  if (err instanceof RwsError) { return err.code === 'AUTH_FAILED'; }
  return /401|unauthor/i.test(String(err));
}

/**
 * Probe a controller's auth scheme and return the matching protocol-level client,
 * already connected. The returned client is either an `RwsClient` (RWS 1.0) or
 * `RwsClient2` (RWS 2.0); use `client instanceof RwsClient2` (or check `protocol`)
 * to narrow if you need protocol-specific behavior.
 *
 * @throws RwsError code='PROTOCOL_DETECT_FAILED' when neither auth scheme is detected.
 */
export async function createClient(opts: ConnectOptions): Promise<AnyClient> {
  const { host, username = 'Admin', password = 'robotics', timeout = 5000 } = opts;
  const strictTls = opts.strictTls === true;

  let port = opts.port;
  let useHttps = opts.https;
  let protocol: Protocol;

  if (port === undefined) {
    const probe = await probeHost(host, opts.timeout, strictTls);
    if (!probe) {
      throw new RwsError(`No RWS endpoint found on ${host} - tried ports 5466, 9403, 443, 80, 11811`, 'PROTOCOL_DETECT_FAILED');
    }
    port = probe.port;
    useHttps = probe.https;
    protocol = probe.protocol;
  } else {
    if (useHttps === undefined) { useHttps = port === 443 || port === 5466 || port === 9403; }
    const detected = await probeProtocol(host, port, useHttps, opts.timeout, strictTls);
    if (!detected) {
      throw new RwsError(`No RWS auth challenge from ${host}:${port} - controller may be off, wrong port, or non-RWS service`, 'PROTOCOL_DETECT_FAILED');
    }
    protocol = detected;
  }

  // RWS 1.0 (IRC5) ships with `Default User`; `Admin` may not exist or have
  // different password. RWS 2.0 (OmniCore) typically has both. So when the
  // caller didn't pin a username and connect fails on `Admin`, transparently
  // retry with `Default User` so cross-controller code "just works."
  const fallbackUser = opts.username === undefined && username === 'Admin'
    ? 'Default User'
    : null;

  if (protocol === 'rws1') {
    try {
      const c = new RwsClient({ host, port, username, password, timeout });
      await c.connect();
      return c;
    } catch (err) {
      if (fallbackUser && isAuthRejection(err)) {
        const c = new RwsClient({ host, port, username: fallbackUser, password, timeout });
        await c.connect();
        return c;
      }
      throw err;
    }
  } else {
    const scheme = useHttps ? 'https' : 'http';
    const clientOpts = { timeout, rejectUnauthorized: strictTls };
    try {
      const c = new RwsClient2(`${scheme}://${host}:${port}`, username, password, clientOpts);
      await c.connect();
      return c;
    } catch (err) {
      if (fallbackUser && isAuthRejection(err)) {
        const c = new RwsClient2(`${scheme}://${host}:${port}`, fallbackUser, password, clientOpts);
        await c.connect();
        return c;
      }
      throw err;
    }
  }
}

/**
 * Like `createClient` but returns the unified-interface adapter (`IRWSAdapter`).
 * Use this when you want to hold a single typed reference across both protocols
 * - e.g. if you write code that calls `.getControllerState()` etc. without
 * caring whether the underlying transport is 1.0 or 2.0.
 */
export async function createAdapter(opts: ConnectOptions): Promise<IRWSAdapter> {
  const { host, username = 'Admin', password = 'robotics', timeout = 5000 } = opts;
  const strictTls = opts.strictTls === true;

  let port = opts.port;
  let useHttps = opts.https;
  let protocol: Protocol;

  if (port === undefined) {
    const probe = await probeHost(host, opts.timeout, strictTls);
    if (!probe) {
      throw new RwsError(`No RWS endpoint found on ${host}`, 'PROTOCOL_DETECT_FAILED');
    }
    port = probe.port;
    useHttps = probe.https;
    protocol = probe.protocol;
  } else {
    if (useHttps === undefined) { useHttps = port === 443 || port === 5466 || port === 9403; }
    const detected = await probeProtocol(host, port, useHttps, opts.timeout, strictTls);
    if (!detected) {
      throw new RwsError(`No RWS auth challenge from ${host}:${port}`, 'PROTOCOL_DETECT_FAILED');
    }
    protocol = detected;
  }

  // Same `Default User` retry as createClient - see the comment there.
  const fallbackUser = opts.username === undefined && username === 'Admin'
    ? 'Default User'
    : null;

  if (protocol === 'rws1') {
    try {
      const inner = new RwsClient({ host, port, username, password, timeout });
      await inner.connect();
      return new RWS1Adapter(inner, { host, port, username, password });
    } catch (err) {
      if (fallbackUser && isAuthRejection(err)) {
        const inner = new RwsClient({ host, port, username: fallbackUser, password, timeout });
        await inner.connect();
        return new RWS1Adapter(inner, { host, port, username: fallbackUser, password });
      }
      throw err;
    }
  } else {
    const scheme = useHttps ? 'https' : 'http';
    const clientOpts = { timeout, rejectUnauthorized: strictTls };
    try {
      const a = new RWS2Adapter(`${scheme}://${host}:${port}`, username, password, clientOpts);
      await a.connect();
      return a;
    } catch (err) {
      if (fallbackUser && isAuthRejection(err)) {
        const a = new RWS2Adapter(`${scheme}://${host}:${port}`, fallbackUser, password, clientOpts);
        await a.connect();
        return a;
      }
      throw err;
    }
  }
}
