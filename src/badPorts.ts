/**
 * The ports Node's global fetch refuses, and the test HttpSession uses to
 * pick its transport (see HttpSession.rawFetch).
 *
 * fetch refuses an http or https request to one of the Fetch standard's "bad
 * ports" before it sends anything: it fails with "fetch failed", cause "bad
 * port". The list below is the standard's, as it stands in the WHATWG Fetch
 * Living Standard, section "Port blocking" (https://fetch.spec.whatwg.org/#port-blocking,
 * read 2026-10-23: 83 ports). Its algorithm blocks a request when the URL's
 * scheme is http or https and its port is on the list.
 *
 * Checked against Node 24.19.0 (undici 7.29.0) on 2026-10-23, every port
 * from 0 to 65535 over http and https, with fetch's dispatcher replaced by
 * one that sends nothing: Node refuses 82 of the 83, all but 0. Port 0 stays
 * on the list as the standard has it, but a base URL naming it goes through
 * fetch (fetchRefusesUrl), which tries port 0 and fails to connect, as in
 * 1.4.0. Through node:http it would not fail: Node's ClientRequest takes
 * `port || defaultPort`, so port 0 connects to 80 (443 for https), and a
 * session meant for port 0 would talk to whatever listens on the default
 * port of that host (checked with a stub connection, Node 24.19.0,
 * 2026-10-24).
 *
 * Node takes its list from the undici it bundles, so another Node release
 * can refuse a port this list lacks. Such a session goes through fetch and
 * fails with an error that names the refused port (HttpSession).
 */

/** The Fetch standard's bad ports (see the header). */
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/**
 * The port a request to `baseUrl` goes to: the URL's own port, or 80 for
 * http and 443 for https when it names none. The URL parser reads it as
 * fetch does: `http://host:0007` is port 7, and `http://host:80` names no
 * port of its own (80 is http's default). `undefined` when the URL does not
 * parse or is neither http nor https.
 */
export function effectivePort(baseUrl: string): number | undefined {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') { return undefined; }
  if (url.port !== '') { return Number(url.port); }
  return scheme === 'https:' ? 443 : 80;
}

/**
 * Whether HttpSession sends requests to `baseUrl` through node:http because
 * Node's fetch refuses them: an http or https URL whose effective port is a
 * bad port, port 0 aside (Node's fetch accepts it, and node:http would turn
 * it into the default port; see the header). A URL that does not parse is
 * not refused here; the request fails on it whichever way it is sent.
 */
export function fetchRefusesUrl(baseUrl: string): boolean {
  const port = effectivePort(baseUrl);
  return port !== undefined && port !== 0 && FETCH_BAD_PORTS.has(port);
}
