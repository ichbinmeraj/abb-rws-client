/**
 * Merge everything discovery found into one entry per controller.
 *
 * Inputs are the raw facts of one run: probe hits (every source: this PC's listening ports, the
 * service address, manual hosts, ranges), mDNS answers, the Windows process images of local
 * ports, what the local virtual-controller system folders say, and login results. `mergeFound`
 * is pure and can be called again with more facts (for example after logins) to rebuild the list.
 *
 * Rules:
 * 1. Same `discoveryKey`: one entry, sources united. A RobotStudio virtual controller seen on
 *    127.0.0.1 by the port scan and on this PC's LAN address by mDNS is one entry with sources
 *    `['this-pc', 'mdns']`.
 * 2. Same non-empty `systemId` on different keys: one entry; the best address is `host`/`port`,
 *    the others go to `addresses`. Virtual controllers cloned from one template share a system
 *    id, so folding is limited to the case of one controller reachable on several addresses:
 *    both entries on other hosts (never this PC), different hosts, the same port, and no
 *    conflicting system names. Without an id, entries stay separate: folding by guess could hide
 *    a second controller.
 * 3. Order: entries on this PC first, by port; then other hosts by numeric IPv4, then port.
 *
 * Field sources, highest first: a login, the local system folder, mDNS TXT. Nothing is guessed
 * from a port or a certificate.
 */

import type { MdnsController } from '../MdnsDiscovery.js';
import { canonicalHost, discoveryKeyWith, localAddressChecker } from './addresses.js';
import type {
  ControllerSource,
  FoundAddress,
  FoundController,
  IdentifyOutcome,
  PidImageMap,
  ProbeHit,
  VcProcessDetails,
} from './types.js';

/** Everything one run found. Only `hits` is required. */
export interface MergeInput {
  /** Finished probes. Only `rws` and `other-401` outcomes become entries. */
  hits: ProbeHit[];
  /** mDNS answers (only when the caller turned mDNS on). */
  mdns?: MdnsController[];
  /** Windows process image per PID, for entries found by the listening-port scan. */
  pidImages?: PidImageMap;
  /** What the local system folder of each virtual-controller process says. */
  vcDetails?: VcProcessDetails[];
  /** Login results under `identify: 'with-credentials'`, keyed by the entry key before folding. */
  identities?: IdentifyOutcome[];
  /** Local-address test; default: one snapshot of this PC's interfaces for the whole merge. */
  isLocal?: (host: string) => boolean;
}

/** Image names of RobotStudio virtual-controller processes, lower case. */
const VC_IMAGES = new Set(['robvc.exe', 'vrchost64.exe']);

/** Mutable working entry; turned into a clean `FoundController` at the end. */
interface Working {
  key: string;
  host: string;
  port: number;
  https: boolean | null;
  generation: FoundController['generation'];
  authType: FoundController['authType'];
  probe: FoundController['probe'];
  identified: boolean;
  realm?: string;
  name?: string;
  rwVersion?: string;
  systemName?: string;
  systemId?: string;
  robotType?: string;
  sources: ControllerSource[];
  pid?: number;
  image?: string;
  tlsFingerprint?: string;
}

function addSource(list: ControllerSource[], s: ControllerSource): void {
  if (!list.includes(s)) { list.push(s); }
}

/** Rank of a positive hit for choosing the address an entry shows: RWS realm, HTTPS, IPv4, not a fallback. */
function hitRank(h: ProbeHit): number {
  let r = 0;
  if (h.outcome.kind === 'rws') { r += 8; }
  if (h.unit.https) { r += 4; }
  if (!h.unit.host.includes(':')) { r += 2; }
  if (!h.unit.fallback) { r += 1; }
  return r;
}

/** A system id compared without case or surrounding braces. */
function normalizeId(id: string | undefined): string | undefined {
  const t = id?.trim().replace(/^\{(.*)\}$/, '$1').trim().toLowerCase();
  return t ? t : undefined;
}

/** Host part of a key (`'local'` for this PC). */
function keyHost(key: string): string {
  return key.slice(0, key.lastIndexOf(':'));
}

/** Numeric value of an IPv4 literal, or undefined. */
function ipv4Number(host: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) { return undefined; }
  const p = m.slice(1).map(Number);
  if (p.some(x => x > 255)) { return undefined; }
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

/**
 * The one order for discovery results: this PC first (by port), then other hosts by numeric
 * IPv4, then port. Hosts that are not IPv4 literals sort after IPv4, by text.
 */
export function compareByAddress(
  a: { key: string; host: string; port: number },
  b: { key: string; host: string; port: number },
): number {
  const al = a.key.startsWith('local:');
  const bl = b.key.startsWith('local:');
  if (al !== bl) { return al ? -1 : 1; }
  if (!al) {
    const an = ipv4Number(canonicalHost(a.host));
    const bn = ipv4Number(canonicalHost(b.host));
    if (an !== undefined && bn !== undefined && an !== bn) { return an - bn; }
    if ((an === undefined) !== (bn === undefined)) { return an === undefined ? 1 : -1; }
    if (an === undefined && bn === undefined) {
      const c = canonicalHost(a.host).localeCompare(canonicalHost(b.host));
      if (c !== 0) { return c; }
    }
  }
  return a.port - b.port;
}

/** Build one working entry per key from the probe hits. */
function entriesFromHits(hits: ProbeHit[], keyOf: (h: string, p: number) => string): Map<string, Working> {
  const groups = new Map<string, ProbeHit[]>();
  for (const h of hits) {
    if (h.outcome.kind !== 'rws' && h.outcome.kind !== 'other-401') { continue; }
    const k = keyOf(h.unit.host, h.unit.port);
    const list = groups.get(k);
    if (list) { list.push(h); } else { groups.set(k, [h]); }
  }

  const out = new Map<string, Working>();
  for (const [key, list] of groups) {
    let best = list[0];
    for (const h of list) { if (hitRank(h) > hitRank(best)) { best = h; } }
    const o = best.outcome;
    if (o.kind !== 'rws' && o.kind !== 'other-401') { continue; }
    const w: Working = {
      key,
      host: canonicalHost(best.unit.host),
      port: best.unit.port,
      https: best.unit.https,
      // A 401 from a foreign realm is not known to be RWS, so no generation is claimed for it.
      generation: o.kind === 'rws' ? (o.authType === 'digest' ? 'rws1' : 'rws2') : null,
      authType: o.authType,
      probe: { host: canonicalHost(best.unit.host), port: best.unit.port, useHttps: best.unit.https, authType: o.authType },
      identified: o.kind === 'rws',
      sources: [],
    };
    if (o.realm !== undefined) { w.realm = o.realm; }
    if (best.unit.https && o.tlsFingerprint) { w.tlsFingerprint = o.tlsFingerprint; }
    for (const h of [best, ...list]) {
      addSource(w.sources, h.unit.source);
      if (w.name === undefined && h.unit.name !== undefined) { w.name = h.unit.name; }
      if (w.pid === undefined && h.unit.pid !== undefined) { w.pid = h.unit.pid; }
    }
    out.set(key, w);
  }
  return out;
}

/** Add mDNS answers: TXT fields onto a probed entry with the same key, or a new mDNS-only entry. */
function applyMdns(rows: Map<string, Working>, mdns: MdnsController[], keyOf: (h: string, p: number) => string): void {
  for (const m of mdns) {
    const key = keyOf(m.host, m.port);
    let w = rows.get(key);
    if (!w) {
      w = {
        key,
        host: canonicalHost(m.host),
        port: m.port,
        https: null,
        generation: m.probableProtocol === 'unknown' ? null : m.probableProtocol,
        authType: null,
        probe: null,
        identified: false,
        sources: [],
      };
      rows.set(key, w);
    }
    addSource(w.sources, 'mdns');
    if (w.systemName === undefined && m.systemName) { w.systemName = m.systemName; }
    if (w.rwVersion === undefined && m.rwVersion) { w.rwVersion = m.rwVersion; }
    if (w.systemId === undefined && m.sysGuid) { w.systemId = m.sysGuid; }
  }
}

/** Process image per entry, then the local system folder (overrides mDNS TXT). */
function applyLocal(rows: Iterable<Working>, pidImages: PidImageMap | undefined, details: VcProcessDetails[]): void {
  const byPid = new Map<number, VcProcessDetails>();
  for (const d of details) { byPid.set(d.pid, d); }
  for (const w of rows) {
    if (w.pid === undefined) { continue; }
    const d = byPid.get(w.pid);
    const image = pidImages?.get(w.pid) ?? d?.image;
    if (image) { w.image = image; }
    if (d?.systemName) { w.systemName = d.systemName; }
    if (d?.rwVersion) { w.rwVersion = d.rwVersion; }
  }
}

/** Login results override everything else and mark the entry identified. */
function applyIdentities(rows: Map<string, Working>, identities: IdentifyOutcome[]): void {
  for (const id of identities) {
    if (id.status !== 'identified') { continue; }
    const w = rows.get(id.key);
    if (!w) { continue; }
    w.identified = true;
    if (id.generation) { w.generation = id.generation; }
    if (id.systemName) { w.systemName = id.systemName; }
    if (id.systemId) { w.systemId = id.systemId; }
    if (id.rwVersion) { w.rwVersion = id.rwVersion; }
    if (id.robotType) { w.robotType = id.robotType; }
  }
}

/** Order for choosing which entry of a folded group shows its address: probed, identified, then address order. */
function comparePrimary(a: Working, b: Working): number {
  if ((a.probe === null) !== (b.probe === null)) { return a.probe === null ? 1 : -1; }
  if (a.identified !== b.identified) { return a.identified ? -1 : 1; }
  return compareByAddress(a, b);
}

/** May `w` join a folded group? See rule 2 in the file comment. */
function canFold(group: Working[], w: Working): boolean {
  if (w.key.startsWith('local:')) { return false; }
  return group.every(g =>
    !g.key.startsWith('local:') &&
    keyHost(g.key) !== keyHost(w.key) &&
    g.port === w.port &&
    !(g.systemName && w.systemName && g.systemName !== w.systemName));
}

function toFound(primary: Working, others: Working[]): FoundController {
  const sources: ControllerSource[] = [...primary.sources];
  for (const o of others) { for (const s of o.sources) { addSource(sources, s); } }
  const pick = <K extends 'rwVersion' | 'systemName' | 'systemId' | 'robotType'>(k: K): Working[K] =>
    primary[k] ?? others.find(o => o[k] !== undefined)?.[k];

  const f: FoundController = {
    key: primary.key,
    host: primary.host,
    port: primary.port,
    https: primary.https,
    generation: primary.generation ?? others.find(o => o.generation !== null)?.generation ?? null,
    authType: primary.authType,
    probe: primary.probe,
    identified: primary.identified,
    sources,
  };
  if (primary.realm !== undefined) { f.realm = primary.realm; }
  if (primary.name !== undefined) { f.name = primary.name; }
  const rwVersion = pick('rwVersion');
  if (rwVersion !== undefined) { f.rwVersion = rwVersion; }
  const systemName = pick('systemName');
  if (systemName !== undefined) { f.systemName = systemName; }
  const systemId = pick('systemId');
  if (systemId !== undefined) { f.systemId = systemId; }
  const robotType = pick('robotType');
  if (robotType !== undefined) { f.robotType = robotType; }
  if (others.length > 0) {
    f.addresses = [...others].sort(compareByAddress).map((o): FoundAddress => ({
      host: o.host, port: o.port, https: o.https, sources: [...o.sources],
    }));
  }
  if (primary.pid !== undefined) {
    f.process = primary.image !== undefined ? { pid: primary.pid, image: primary.image } : { pid: primary.pid };
    if (primary.image !== undefined) { f.isVirtual = VC_IMAGES.has(primary.image.toLowerCase()); }
  }
  if (primary.tlsFingerprint !== undefined) { f.tlsFingerprint = primary.tlsFingerprint; }
  return f;
}

/**
 * One entry per controller, in the discovery order (this PC first by port, then other hosts by
 * numeric IPv4, then port). See the file comment for the rules.
 */
export function mergeFound(input: MergeInput): FoundController[] {
  const isLocal = input.isLocal ?? localAddressChecker();
  const keyOf = (h: string, p: number): string => discoveryKeyWith(isLocal, h, p);

  const rows = entriesFromHits(input.hits, keyOf);
  applyMdns(rows, input.mdns ?? [], keyOf);
  applyLocal(rows.values(), input.pidImages, input.vcDetails ?? []);
  applyIdentities(rows, input.identities ?? []);

  // Fold by system id. Best candidates first, so each group's first member shows its address.
  const ordered = [...rows.values()].sort(comparePrimary);
  const groups: Working[][] = [];
  const byId = new Map<string, Working[][]>();
  for (const w of ordered) {
    const id = normalizeId(w.systemId);
    const candidates = id ? byId.get(id) ?? [] : [];
    const group = candidates.find(g => canFold(g, w));
    if (group) { group.push(w); continue; }
    const fresh = [w];
    groups.push(fresh);
    if (id) { byId.set(id, [...candidates, fresh]); }
  }

  return groups
    .map(([primary, ...others]) => toFound(primary, others))
    .sort(compareByAddress);
}
