/**
 * Ports an ABB RWS controller answers on, and the scheme each port implies.
 *
 * Pure tables and helpers, no I/O. Every port-to-scheme decision in the client
 * goes through `schemeForPort` / `candidatesForPort`, so a port added here is
 * picked up by the connect factories (`detect.ts`), `probeHost` and discovery
 * at once, and no scheme literal can drift out of step again.
 *
 * Element shape `{ port, https }`: a port that speaks either scheme is listed
 * twice (port 80, HTTPS first, then HTTP).
 */

import type { PortScheme, RwsPortEntry } from './types.js';

/**
 * Ports of real controllers, worth trying on any host:
 *  - 443 HTTPS: OmniCore (RobotWare 7 and 8), the documented RWS 2.0 default.
 *  - 80 HTTPS: the RobotWare 8.1.1 virtual controller serves HTTPS on port 80
 *    and resets plain HTTP there (live-verified 2026-09-27 on RW 8.1.1+614).
 *    A real OmniCore answering HTTPS on 80 has not been seen.
 *  - 80 HTTP: IRC5 (RobotWare 6), the documented RWS 1.0 default.
 */
export const REMOTE_RWS_PORTS: ReadonlyArray<RwsPortEntry> = [
  { port: 443, https: true  },
  { port: 80,  https: true  },
  { port: 80,  https: false },
];

/**
 * Ports RobotStudio virtual controllers commonly bind on this PC. A virtual
 * controller accepts connections from 127.0.0.0/8 only (its firewall rules,
 * seen 2026-10-03), so discovery tries these on loopback hosts only.
 *  - 5466, 9403, 9805, 11622 HTTPS: OmniCore virtual controllers take the
 *    first free port of 80, 5466, 9403, 9805, 11622, ... in that order.
 *    9805 is the RW 8.2.1+1023 virtual controller (live-verified 2026-10-03);
 *    5466 and 9403 are RW 7.21 (live-verified 2026-10-03).
 *  - 11811, 28447 HTTP: IRC5 virtual controllers seen on a test rig. IRC5
 *    virtual controllers mostly bind a port outside any list; the
 *    listening-port scan finds those.
 */
export const VC_RWS_PORTS: ReadonlyArray<RwsPortEntry> = [
  { port: 5466,  https: true  },
  { port: 9403,  https: true  },
  { port: 9805,  https: true  },
  { port: 11622, https: true  },
  { port: 11811, https: false },
  { port: 28447, https: false },
];

/**
 * The single source of truth for the ports an ABB RWS controller is known to
 * answer on, in the order worth trying: the real-controller ports first (a
 * physical robot answers at its fixed port at once, and a closed port is
 * refused at once, so trying them first costs a virtual controller nothing),
 * then the virtual-controller ports. Deliberately short, not exhaustive: a
 * virtual controller on a port outside this list is found by the
 * listening-port scan, so this list stays fast.
 *
 * `probeHost` (connect layer) and `RobotManager.PROBE_PORTS` (discovery) both
 * read it, so they cannot drift apart.
 */
export const KNOWN_RWS_PORTS: ReadonlyArray<RwsPortEntry> = [
  ...REMOTE_RWS_PORTS,
  ...VC_RWS_PORTS,
];

/**
 * The scheme a port implies, from `KNOWN_RWS_PORTS`:
 *  - `'https'` or `'http'` when the table lists the port with that one scheme;
 *  - `'either'` when it lists the port with both schemes (80), or not at all.
 *    The caller then tries both, HTTPS first.
 */
export function schemeForPort(port: number): PortScheme {
  let https = false;
  let http = false;
  for (const entry of KNOWN_RWS_PORTS) {
    if (entry.port !== port) { continue; }
    if (entry.https) { https = true; } else { http = true; }
  }
  if (https && !http) { return 'https'; }
  if (http && !https) { return 'http'; }
  return 'either';
}

/**
 * The `{ port, https }` attempts for one port. With `https` given, that scheme
 * only. Without it, the scheme `schemeForPort` names, or for an `'either'`
 * port both, HTTPS first.
 */
export function candidatesForPort(port: number, https?: boolean): RwsPortEntry[] {
  if (https !== undefined) { return [{ port, https }]; }
  switch (schemeForPort(port)) {
    case 'https': return [{ port, https: true }];
    case 'http':  return [{ port, https: false }];
    default:      return [{ port, https: true }, { port, https: false }];
  }
}

/**
 * A port list for a message, e.g. `443 (https), 80 (https, http), 5466 (https)`.
 * Ports keep their first position; schemes are listed in table order.
 */
export function describeRwsPorts(entries: ReadonlyArray<RwsPortEntry> = KNOWN_RWS_PORTS): string {
  const schemes = new Map<number, string[]>();
  for (const { port, https } of entries) {
    const list = schemes.get(port) ?? [];
    const name = https ? 'https' : 'http';
    if (!list.includes(name)) { list.push(name); }
    schemes.set(port, list);
  }
  return [...schemes].map(([port, list]) => `${port} (${list.join(', ')})`).join(', ');
}
