/**
 * The certificate authorities a controller's certificate is checked against
 * when verification is on (`strictTls`, RWS 2.0's `rejectUnauthorized: true`),
 * one set for every TLS connection the client opens for that: the discovery
 * probe (discovery/probe.ts), the protocol probe (detect.ts), RWS 2.0
 * requests, the subscription POST and its WebSocket (rws2/core.ts).
 *
 * The set is Node's default one (its bundled CAs, plus NODE_EXTRA_CA_CERTS,
 * plus the system store when Node runs with --use-system-ca) and the
 * operating system's certificate store, so a controller whose certificate a
 * company CA installed on this PC signed verifies.
 *
 * Why one explicit set: without it each connection got whatever its host
 * added. The VS Code extension host adds the system store to `https`
 * requests, but not, by default, to a plain `tls.connect`, which is how the
 * discovery probe opens its socket; so inside VS Code a controller with a
 * company-CA certificate was listed as unverified by discovery while the
 * client's requests to it verified. A connection that names its own `ca` gets
 * nothing added by that host (@vscode/proxy-agent, read 2026-10-25), so with
 * this set the probe and the requests trust the same authorities in every
 * host. Outside VS Code the client's requests now trust the system store as
 * well, as the probe does.
 *
 * Node reads both sets with `tls.getCACertificates` (Node 22.15 and later,
 * 23.10 and later). Without it, or when the default set cannot be read,
 * `strictTlsCa()` answers undefined and every connection keeps Node's own
 * default, as before 1.5.1. A system store that cannot be read leaves the
 * default set alone. Read once per process, on the first connection that
 * verifies.
 *
 * Also here: the line logged once per controller when the client talks
 * https to it without checking its certificate (warnUnverifiedTls).
 */
import tls from 'node:tls';
import { Logger } from './Logger.js';
import { isLoopbackHost } from './discovery/scheduler.js';

type CaReader = (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];

/** undefined: not read yet; null: this Node cannot read it. */
let cached: string[] | null | undefined;

function read(): string[] | null {
  const get = (tls as unknown as { getCACertificates?: CaReader }).getCACertificates;
  if (typeof get !== 'function') { return null; }
  const all = new Set<string>();
  try {
    for (const cert of get.call(tls, 'default')) { all.add(cert); }
  } catch {
    return null;
  }
  try {
    for (const cert of get.call(tls, 'system')) { all.add(cert); }
  } catch { /* no readable system store: the default set alone */ }
  return all.size > 0 ? [...all] : null;
}

/** The authorities to verify a controller's certificate against (see the header), or undefined to leave Node's default. */
export function strictTlsCa(): string[] | undefined {
  if (cached === undefined) { cached = read(); }
  return cached ?? undefined;
}

/** `{ ca }` for a connection that verifies, or nothing when Node's default stays (see strictTlsCa). */
export function strictTlsCaOption(): { ca?: string[] } {
  const ca = strictTlsCa();
  return ca ? { ca } : {};
}

/** Forget the set read, so the next connection reads it again. Tests only. */
export function resetStrictTlsCa(): void { cached = undefined; }

/** The `host:port` of every controller warnUnverifiedTls has logged in this process. */
const unverifiedWarned = new Set<string>();

/**
 * Log, once per process per host and port, at warn level, that the client
 * talks https to a controller without checking its certificate (`strictTls`
 * off; RWS 2.0's `rejectUnauthorized: false`). The default stays off, since
 * the virtual controllers and, by ABB default, OmniCore controllers present
 * a self-signed certificate; the line names the option that turns the check
 * on and how to make one controller's certificate trusted. The client has no
 * option that pins one certificate per controller, and the line says so.
 *
 * Called by the RWS 2.0 client before each request and the subscription
 * POST and WebSocket it sends unchecked over https: the connections that
 * carry the credentials and the session cookie. The unauthenticated probes
 * (discovery, the protocol probe of a connect) send neither and log nothing,
 * so a scan does not log a line for every address it tried. RWS 1.0 checks
 * the certificate of every https connection (HttpSession), so it never calls
 * this.
 *
 * Nothing is logged for this PC's loopback (127.0.0.0/8, `::1`,
 * `'localhost'`), where the client reaches the virtual controllers:
 * findControllers probes this PC's listening ports there by default, so
 * that nothing leaves this PC, and `loopbackOnly` and the loopback-only
 * `wideHostScan` keep a search on it. A connection there does not leave
 * this PC, and a line on every connection to a virtual controller would
 * teach people to skip it. A virtual controller reached by one of this PC's
 * network addresses is logged; a tunnel or proxy on loopback that forwards
 * to a controller elsewhere is not.
 */
export function warnUnverifiedTls(host: string, port: number): void {
  if (isLoopbackHost(host)) { return; }
  const where = `${host.toLowerCase()}:${port}`;
  if (unverifiedWarned.has(where)) { return; }
  unverifiedWarned.add(where);
  Logger.warn(`TLS: the certificate of https://${where} is not checked (strictTls is off), so nothing proves the connection, `
    + 'which carries the credentials and the session, reaches that controller. To check it, pass strictTls: true '
    + '(RobotManager, MultiRobotManager, createClient, createAdapter, findControllers) or rejectUnauthorized: true (RwsClient2), '
    + 'and make the controller\'s certificate trusted: add it, or the CA that signed it, to the PEM file NODE_EXTRA_CA_CERTS names '
    + '(read when Node starts) or, on Node 22.15 and later, to this PC\'s certificate store; the certificate must name the host or address connected to. '
    + 'The client has no option that pins one certificate per controller. Logged once per host and port.');
}

/** Forget the hosts warnUnverifiedTls has logged, so each logs again. Tests only. */
export function resetUnverifiedTlsWarnings(): void { unverifiedWarned.clear(); }
