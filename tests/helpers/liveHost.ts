/**
 * RWS_TEST_HOST as the live suites (tests/live) read it.
 *
 * The variable is shared with RAPID Live's host harness, which sets it to a
 * base URL (`https://127.0.0.1:80`), while these suites took a bare host and
 * threw at import on anything else. So a shell left with the harness value
 * failed both live files in a plain `npm test` and in `npm pack`. Both forms
 * are taken now, through this one parser:
 *   - a bare host: `127.0.0.1`, `localhost`, `::1` or `[::1]`;
 *   - an http or https URL naming one: `https://127.0.0.1:80`, `http://localhost/`.
 * Only the host is taken from a URL. Its scheme and port name the controller
 * RAPID Live's harness wants, not the one a suite here wants: the RWS 1.0
 * suite takes RWS_TEST_PORT_RW6 and the RWS 2.0 suite RWS_TEST_PORT_RW7, or
 * the client's own discovery of this PC finds the port.
 *
 * Anything that is not this PC is refused, as before: the live suites inject
 * faults and must never reach a real robot.
 *
 * Test infrastructure only - never shipped in the package.
 */

/** The hosts a live suite may reach, as this parser writes them. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The host named by `raw` (RWS_TEST_HOST), or null when it is unset or blank,
 * which leaves the live suites skipped. Throws when it names anything but this
 * PC, or is neither a host nor an http(s) URL.
 */
export function parseLiveHost(raw: string | undefined, name = 'RWS_TEST_HOST'): string | null {
  const value = raw?.trim() ?? '';
  if (value === '') { return null; }
  let host = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch {
      throw new Error(`${name}=${raw} is not a URL this suite can read; give a host (127.0.0.1) or an http(s) URL (https://127.0.0.1:80).`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`${name}=${raw} is not an http or https URL; give a host (127.0.0.1) or an http(s) URL (https://127.0.0.1:80).`);
    }
    host = url.hostname;
  }
  host = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === value.toLowerCase() && /^[^:]+:\d+$/.test(host)) {
    throw new Error(`${name}=${raw} names a port without a scheme; give a host (127.0.0.1) or an http(s) URL (https://127.0.0.1:80).`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `${name}=${raw} is not localhost. Live suites only ever target local `
      + 'virtual controllers - refusing to run against a possibly real robot.',
    );
  }
  return host;
}

/** RWS_TEST_HOST read from the environment (see parseLiveHost). */
export function liveHost(): string | null {
  return parseLiveHost(process.env.RWS_TEST_HOST);
}
