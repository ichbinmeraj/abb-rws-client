/**
 * Listening on a port Node's fetch refuses, so a test reaches the RWS 1.0
 * transport's node:http path (HttpSession sends a session on such a port
 * through node:http; see src/badPorts.ts).
 *
 * The ports are the Fetch standard's bad ports from 1024 up: below 1024 a
 * process needs privileges to listen on Linux and macOS. 10080 and 6665-6669
 * come first, as the HttpSession tests always used them. Another process, a
 * test running in parallel, or the operating system's dynamic port range (it
 * starts at 1024 on some Windows machines) can hold some of them, so each is
 * tried in turn; nineteen ports all held at once means something is wrong
 * with the machine, and that fails loudly instead of skipping.
 *
 * Test infrastructure only - never shipped in the package.
 */

import type { Server } from 'node:net';
import { FETCH_BAD_PORTS, fetchRefusesUrl } from '../../src/badPorts.js';

const FIRST: readonly number[] = [10080, 6665, 6666, 6667, 6668, 6669];

/** The bad ports a test may listen on, in the order they are tried. */
export const REFUSED_LISTEN_PORTS: readonly number[] = [
  ...FIRST,
  ...[...FETCH_BAD_PORTS].filter(p => p >= 1024 && !FIRST.includes(p)).sort((a, b) => a - b),
];

/** One listen attempt; rejects with the listen error and leaves the server unbound. */
function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => { server.off('listening', onListening); reject(e); };
    const onListening = (): void => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Listen on the first port of `ports` (REFUSED_LISTEN_PORTS) that is free on
 * `host` and return it. Throws, naming every port and why it failed, when
 * none is.
 */
export async function listenOnRefusedPort(
  server: Server, host = '127.0.0.1', ports: readonly number[] = REFUSED_LISTEN_PORTS,
): Promise<number> {
  const failed: string[] = [];
  for (const port of ports) {
    try {
      await listenOnce(server, port, host);
    } catch (e) {
      failed.push(`${port} ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
      continue;
    }
    // A port of this list that fetch does not refuse would test the wrong
    // path without a word; the list and fetchRefusesUrl come from one table.
    if (!fetchRefusesUrl(`http://127.0.0.1:${port}`)) {
      await new Promise<void>(r => server.close(() => r()));
      throw new Error(`port ${port} was given as one fetch refuses, but the client sends to it through fetch`);
    }
    return port;
  }
  throw new Error(
    `none of the ports Node's fetch refuses could be listened on at ${host} (${failed.join(', ')}); `
    + 'a test of the node:http path cannot run, and it fails rather than skipping',
  );
}
