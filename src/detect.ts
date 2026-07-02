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
  /** Force the transport scheme. If omitted, inferred from port (>=443 → https). */
  https?: boolean;
  /** Default 'Admin'. */
  username?: string;
  /** Default 'robotics'. */
  password?: string;
  /** Per-request timeout in ms. Default 5000. */
  timeout?: number;
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
): Promise<Protocol | null> {
  return new Promise(resolve => {
    const agent = useHttps ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    const options: http.RequestOptions & { agent?: https.Agent; rejectUnauthorized?: boolean } = {
      method: 'GET',
      hostname: host,
      port,
      path: '/rw/system',
      headers: { Accept: 'application/xhtml+xml;v=2.0' },
      agent,
      // Per-request as well as on the agent: agent-swapping hosts (VS Code extension
      // host on non-localhost targets) otherwise re-enable TLS verification (issue #2).
      ...(useHttps ? { rejectUnauthorized: false } : {}),
    };
    const transport = useHttps ? https : http;
    const req = (transport as typeof https).request(options as https.RequestOptions, res => {
      const auth = (res.headers['www-authenticate'] || '').toString().toLowerCase();
      // Drain the body so the socket can return to the pool.
      res.on('data', () => {});
      res.on('end', () => {
        if (auth.startsWith('digest ')) { resolve('rws1'); return; }
        if (auth.startsWith('basic '))  { resolve('rws2'); return; }
        // No challenge but the endpoint exists — assume RWS 2.0 (OmniCore sometimes accepts
        // unauth GET on /rw/system if cookies are sticky).
        if (res.statusCode && res.statusCode < 500) { resolve('rws2'); return; }
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
export async function probeHost(host: string, timeoutMs = 1500): Promise<ProbeResult | null> {
  const candidates: Array<[number, boolean]> = [
    [5466,  true ],
    [9403,  true ],
    [443,   true ],
    [80,    false],
    [11811, false],
  ];
  for (const [port, https] of candidates) {
    const proto = await probeProtocol(host, port, https, timeoutMs);
    if (proto) { return { protocol: proto, port, https }; }
  }
  return null;
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

  let port = opts.port;
  let useHttps = opts.https;
  let protocol: Protocol;

  if (port === undefined) {
    const probe = await probeHost(host);
    if (!probe) {
      throw new RwsError(`No RWS endpoint found on ${host} — tried ports 5466, 9403, 443, 80, 11811`, 'PROTOCOL_DETECT_FAILED');
    }
    port = probe.port;
    useHttps = probe.https;
    protocol = probe.protocol;
  } else {
    if (useHttps === undefined) { useHttps = port === 443 || port === 5466 || port === 9403; }
    const detected = await probeProtocol(host, port, useHttps);
    if (!detected) {
      throw new RwsError(`No RWS auth challenge from ${host}:${port} — controller may be off, wrong port, or non-RWS service`, 'PROTOCOL_DETECT_FAILED');
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
      if (fallbackUser && /401|unauthor/i.test(String(err))) {
        const c = new RwsClient({ host, port, username: fallbackUser, password, timeout });
        await c.connect();
        return c;
      }
      throw err;
    }
  } else {
    const scheme = useHttps ? 'https' : 'http';
    try {
      const c = new RwsClient2(`${scheme}://${host}:${port}`, username, password);
      await c.connect();
      return c;
    } catch (err) {
      if (fallbackUser && /401|unauthor/i.test(String(err))) {
        const c = new RwsClient2(`${scheme}://${host}:${port}`, fallbackUser, password);
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
 * — e.g. if you write code that calls `.getControllerState()` etc. without
 * caring whether the underlying transport is 1.0 or 2.0.
 */
export async function createAdapter(opts: ConnectOptions): Promise<IRWSAdapter> {
  const { host, username = 'Admin', password = 'robotics' } = opts;

  let port = opts.port;
  let useHttps = opts.https;
  let protocol: Protocol;

  if (port === undefined) {
    const probe = await probeHost(host);
    if (!probe) {
      throw new RwsError(`No RWS endpoint found on ${host}`, 'PROTOCOL_DETECT_FAILED');
    }
    port = probe.port;
    useHttps = probe.https;
    protocol = probe.protocol;
  } else {
    if (useHttps === undefined) { useHttps = port === 443 || port === 5466 || port === 9403; }
    const detected = await probeProtocol(host, port, useHttps);
    if (!detected) {
      throw new RwsError(`No RWS auth challenge from ${host}:${port}`, 'PROTOCOL_DETECT_FAILED');
    }
    protocol = detected;
  }

  if (protocol === 'rws1') {
    const inner = new RwsClient({ host, port, username, password, timeout: opts.timeout ?? 5000 });
    await inner.connect();
    return new RWS1Adapter(inner, { host, port, username, password });
  } else {
    const scheme = useHttps ? 'https' : 'http';
    const a = new RWS2Adapter(`${scheme}://${host}:${port}`, username, password);
    await a.connect();
    return a;
  }
}
