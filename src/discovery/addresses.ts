/**
 * Addresses and keys for controller discovery.
 *
 * - `canonicalHost`: one spelling per address (brackets and `%zone` removed, lower case,
 *   IPv4-mapped IPv6 turned into IPv4, IPv6 compressed).
 * - `isLocalAddress`: is this an address of this PC (loopback, `'localhost'`, or any interface)?
 * - `discoveryKey`: one key per controller listener. A RobotStudio virtual controller answers on
 *   127.0.0.1 and on every address of this PC, so all of them share `'local:<port>'`.
 * - `resolveIPv4`: resolve a typed hostname once, IPv4 first. The only function here with a
 *   side effect (a DNS lookup).
 *
 * Nothing in this file opens a socket.
 */

import * as dns from 'dns';
import * as net from 'net';
import * as os from 'os';
import type { ResolvedName } from './types.js';

/**
 * Expand an IPv6 literal (already zone-free, lower case) to eight 16-bit groups.
 * Returns undefined when it is not a valid IPv6 literal.
 */
function ipv6Groups(addr: string): number[] | undefined {
  if (net.isIPv6(addr) === false) { return undefined; }
  let text = addr;
  const tail: number[] = [];
  // A trailing dotted IPv4 part (`::ffff:192.0.2.1`) is two groups.
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const parts = v4[2].split('.').map(Number);
    tail.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]);
    text = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1);
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map(g => parseInt(g, 16)));
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const fill = 8 - tail.length - left.length - right.length;
  if (rest === undefined && fill !== 0) { return undefined; }
  if (fill < 0) { return undefined; }
  return [...left, ...new Array<number>(rest === undefined ? 0 : fill).fill(0), ...right, ...tail];
}

/** RFC 5952 text form of eight groups: lower-case hex, longest run of two or more zero groups as `::`. */
function compressIpv6(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) { j++; }
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map(g => g.toString(16));
  if (bestLen < 2) { return hex.join(':'); }
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/**
 * One spelling per address: surrounding whitespace, brackets (`[::1]`) and an IPv6 zone
 * (`fe80::1%eth0`) removed, lower case, IPv4-mapped IPv6 (`::ffff:192.0.2.1`, `::ffff:c000:201`)
 * turned into the IPv4 literal, other IPv6 literals compressed (`0:0:0:0:0:0:0:1` gives `::1`).
 * A hostname comes back lower case without a trailing dot; it is not looked up.
 */
export function canonicalHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) { h = h.slice(1, -1); }
  const zone = h.indexOf('%');
  if (zone >= 0 && h.includes(':')) { h = h.slice(0, zone); }
  const family = net.isIP(h);
  if (family === 4) { return h; }
  if (family === 6) {
    const g = ipv6Groups(h);
    if (!g) { return h; }
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
      return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    }
    return compressIpv6(g);
  }
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/** true for an IPv4 literal in 127.0.0.0/8 (input already canonical). */
function isIpv4Loopback(h: string): boolean {
  return net.isIPv4(h) && h.startsWith('127.');
}

/**
 * Every address of this PC's network interfaces, canonical, both families. Node reports the
 * family as `'IPv4'`/`'IPv6'` or, on some versions, as the number 4/6; both are read.
 */
function interfaceAddresses(): Set<string> {
  const out = new Set<string>();
  let table: ReturnType<typeof os.networkInterfaces>;
  try { table = os.networkInterfaces(); } catch { return out; }
  for (const list of Object.values(table)) {
    for (const info of list ?? []) {
      const family = info.family as unknown;
      if (family === 'IPv4' || family === 4 || family === 'IPv6' || family === 6) {
        out.add(canonicalHost(info.address));
      }
    }
  }
  return out;
}

/**
 * A checker over one snapshot of this PC's interface addresses, for callers that test many
 * hosts in one run (the merge). `isLocalAddress` takes a fresh snapshot on every call.
 */
export function localAddressChecker(): (host: string) => boolean {
  const ifaces = interfaceAddresses();
  return (host: string): boolean => {
    const h = canonicalHost(host);
    return h === 'localhost' || h === '::1' || isIpv4Loopback(h) || ifaces.has(h);
  };
}

/**
 * true when `host` is this PC: `'localhost'`, any address in 127.0.0.0/8, `::1`, or any address
 * of one of this PC's network interfaces (IPv4 or IPv6). Pure apart from reading the interface
 * list; no lookup is made, so any other hostname is false.
 */
export function isLocalAddress(host: string): boolean {
  return localAddressChecker()(host);
}

/**
 * Key for one controller listener: `'local:<port>'` for any address of this PC (a virtual
 * controller answers on all of them), otherwise `'<canonical host>:<port>'`, e.g. `'192.0.2.10:443'`.
 */
export function discoveryKey(host: string, port: number): string {
  return `${isLocalAddress(host) ? 'local' : canonicalHost(host)}:${port}`;
}

/** Same as `discoveryKey`, with a caller-supplied local-address checker (one snapshot per run). */
export function discoveryKeyWith(isLocal: (host: string) => boolean, host: string, port: number): string {
  return `${isLocal(host) ? 'local' : canonicalHost(host)}:${port}`;
}

/** What `resolveIPv4` uses to look a name up; the default is `dns.lookup` with `all: true`. */
export type LookupAll = (name: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = name => new Promise((resolve, reject) => {
  dns.lookup(name, { all: true }, (err, addresses) => {
    if (err) { reject(err); } else { resolve(addresses); }
  });
});

/** Note for a name that has IPv6 addresses only. */
export const IPV6_ONLY_NOTE = 'only an IPv6 address; RobotWare does not support IPv6';

/**
 * Resolve a typed host name once, IPv4 first, for probes and logins.
 *
 * - `'localhost'` gives 127.0.0.1 without a lookup (Node 17 and later keep the resolver's order,
 *   so a lookup may answer `::1` first, and RobotWare refuses IPv6 with 400).
 * - An IPv4 literal is returned as given (canonical), without a lookup.
 * - An IPv6 literal is not resolved; the note says RobotWare does not support IPv6.
 * - Any other name: one lookup returning every address; the first IPv4 address wins. A name
 *   with IPv6 addresses only, no addresses, a failed lookup or a timeout gives a `note` and no
 *   `ipv4`. Never rejects.
 */
export async function resolveIPv4(
  name: string,
  opts: { timeoutMs?: number; lookup?: LookupAll } = {},
): Promise<ResolvedName> {
  const h = canonicalHost(name);
  if (h === 'localhost') { return { name, ipv4: '127.0.0.1' }; }
  if (net.isIPv4(h)) { return { name, ipv4: h }; }
  if (net.isIPv6(h)) { return { name, note: `${name}: ${IPV6_ONLY_NOTE}` }; }
  if (h === '') { return { name, note: 'empty host name' }; }

  const lookup = opts.lookup ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  try {
    const answer = await Promise.race([lookup(h), timeout]);
    if (answer === 'timeout') { return { name, note: `${name}: name lookup timed out after ${timeoutMs} ms` }; }
    const v4 = answer.find(a => a.family === 4 && net.isIPv4(a.address));
    if (v4) { return { name, ipv4: v4.address }; }
    if (answer.some(a => a.family === 6)) { return { name, note: `${name}: ${IPV6_ONLY_NOTE}` }; }
    return { name, note: `${name}: the name has no address` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { name, note: `${name}: name lookup failed${code ? ` (${code})` : ''}` };
  } finally {
    if (timer) { clearTimeout(timer); }
  }
}
