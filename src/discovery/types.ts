/**
 * Types for controller discovery (`findControllers`).
 *
 * The first part is public (exported from the package entry point). The second
 * part is internal: shared between the discovery modules, never exported from
 * the package. This file holds types only; it has no runtime code.
 *
 * Nothing under `src/discovery/` imports `RobotManager.ts` (it imports this
 * directory, not the other way round), so the probe shape `RobotManager` calls
 * `DiscoveredController` is restated structurally here as `DiscoveredProbe`.
 */

import type { Protocol } from '../detect.js';

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * How a controller was found.
 * - `'this-pc'`: the listening-port scan of this PC (a RobotStudio virtual controller, or anything
 *   else listening locally that answers like RWS).
 * - `'service-address'`: 192.168.125.1, the controller service port address (only when
 *   `serviceAddress` is turned on).
 * - `'manual'`: a host the caller named in `manual`.
 * - `'range'`: an address from one of the caller's `ranges`.
 * - `'mdns'`: an mDNS (DNS-SD) answer (only when `mdns` is turned on).
 */
export type ControllerSource = 'this-pc' | 'service-address' | 'manual' | 'range' | 'mdns';

/** A host the user named. */
export interface ManualTarget {
  /**
   * IPv4 literal or hostname. A hostname is resolved once, IPv4 only; `'localhost'` maps to
   * 127.0.0.1 without a lookup. IPv6 literals are refused, because RobotWare does not support IPv6.
   */
  host: string;
  /**
   * TCP port, 1-65535. Omitted: on this PC every known RWS port plus `ports`; on another host
   * 443 and 80 plus `ports`.
   */
  port?: number;
  /**
   * Omitted: a port with one known scheme uses it; any other port tries HTTPS, then HTTP only
   * when HTTPS found the port open but not speaking TLS, or the TLS handshake got no answer.
   * Given: that scheme only.
   */
  https?: boolean;
}

/**
 * Options for `findControllers`. Every rule is checked before anything is sent: a bad value
 * rejects with `RwsError` `INVALID_ARGUMENT` naming the value and the rule, before any socket,
 * child process or DNS lookup. Out-of-range numbers are refused, not clamped.
 *
 * A call with no options sends nothing off this PC: it scans this PC's listening ports and
 * probes the ones that may be RWS on the loopback address.
 */
export interface FindControllersOptions {
  /**
   * Refuse, before anything is sent, unless every target is on this PC's loopback:
   * `serviceAddress` and `mdns` must be false, and every manual host and range address must be in
   * 127.0.0.0/8 or ::1 (`'localhost'` allowed; any other hostname is refused, since its address
   * is unknown before a lookup). For test helpers and scripts. Default false.
   */
  loopbackOnly?: boolean;
  /** Scan this PC's listening ports (netstat, /proc, ss, lsof; read-only) and probe them. Default true. */
  local?: boolean;
  /**
   * Probe 192.168.125.1, the controller service port address. Default false, so a bare call sends
   * nothing off this PC. `'auto'`: probe it only when one of this PC's IPv4 interfaces has an
   * address in 192.168.125.0/24 (a PC cabled to the service port usually gets one).
   */
  serviceAddress?: boolean | 'auto';
  /** Hosts the user named. At most 16 entries. */
  manual?: ManualTarget[];
  /**
   * IPv4 ranges, CIDR (`'10.0.5.0/24'`) or dash (`'10.0.5.20-10.0.5.60'`). Off unless given.
   * At most 16 entries; total distinct hosts across all entries at most `maxRangeHosts`.
   * CIDR drops the network and broadcast addresses for prefixes up to /30. Multicast, 0.0.0.0/8,
   * 240.0.0.0/4 and IPv6 ranges are refused; so is any address outside 10/8, 172.16/12,
   * 192.168/16, 127/8 and 169.254/16 unless `allowPublicRanges`.
   *
   * Scanning a range opens TCP connections to every address in it. On a company network IT can
   * see these attempts, and intrusion detection may flag them. Each address gets at most 3
   * connection attempts (443, 80 over TLS, 80 over HTTP only when 80 is open and not TLS) plus at
   * most 2 per extra port, at most 10 new connections per second and 8 in flight by default.
   */
  ranges?: string[];
  /** Extra ports tried on every host that has no port of its own. At most 8, each 1-65535; duplicates removed. */
  ports?: number[];
  /**
   * Send one mDNS query (224.0.0.251:5353, on each non-internal IPv4 interface) and merge the
   * answers. Default false. This is the only switch for mDNS traffic; `identify` does not turn it on.
   */
  mdns?: boolean;
  /**
   * How far to go to name a controller. Default `'anonymous'`.
   *
   * | identify             | mdns  | mDNS sent      | mDNS TXT fields | Local VC folder read | Logins |
   * |----------------------|-------|----------------|-----------------|----------------------|--------|
   * | `'none'`             | false | no             | n/a             | no                   | none   |
   * | `'none'`             | true  | yes, one query | yes             | no                   | none   |
   * | `'anonymous'`        | false | no             | n/a             | yes                  | none   |
   * | `'anonymous'`        | true  | yes            | yes             | yes                  | none   |
   * | `'with-credentials'` | either| as `mdns`      | yes             | yes                  | one per identified entry with a matching `credentials` entry |
   *
   * `'none'` sends exactly one unauthenticated `GET /rw/system` per probe and starts no process
   * beyond the listening-port scan and the virtual-controller process filter. The local VC folder
   * read (Windows only) reads the system name and RobotWare version of a RobotStudio virtual
   * controller from its system folder on this PC; it sends nothing over the network.
   */
  identify?: 'none' | 'anonymous' | 'with-credentials';
  /**
   * Credentials per controller, keyed by `discoveryKey(host, port)`, `'host:port'` or `'host'`.
   * Allowed only with `identify: 'with-credentials'`. Each value needs a non-empty `username`
   * string and a `password` string. A key matches an entry's own address or typed name only,
   * never another address merged into it (the login goes to the entry's own address). A
   * controller without a matching entry is never logged in to, and no default user is ever tried. Keys that matched no entry are listed in
   * `FindControllersResult.unmatchedCredentials`.
   */
  credentials?: Record<string, { username: string; password: string }>;
  /**
   * Verify TLS certificates. Default false. RobotStudio virtual controllers use a self-signed
   * certificate for 127.0.0.1 (observed 2026-10-03 on RW 7.21.0, 7.21.4, 8.1.1 and 8.2.1); real
   * controllers ship a self-signed certificate by ABB default (real controllers not checked here). Under `strictTls` an address whose
   * certificate fails verification is listed in `tlsFailures`, and no HTTP request is sent to it.
   * A certificate is checked against the authorities the client's requests trust: Node's default
   * ones and the operating system's store (tlsTrust.ts).
   */
  strictTls?: boolean;
  /**
   * SHA-256 leaf-certificate fingerprints per `discoveryKey` (64 hex digits, colons allowed), for
   * trust on first use. Under `'with-credentials'`, an entry with a pinned fingerprint is logged in
   * to only when the fingerprint matches.
   */
  pinnedFingerprints?: Record<string, string>;
  /**
   * Windows: probe only local ports owned by a RobotStudio virtual-controller process
   * (`RobVC.exe`, `Vrchost64.exe`). Default true on Windows. If the process lookup fails, the
   * scan runs unfiltered and `localScan.vcFilter` is `'failed'`.
   *
   * Elsewhere no virtual controller can run, so by default only local listeners on the known RWS
   * ports (`KNOWN_RWS_PORTS`) and on `ports` are probed: a plain HTTP request to every local
   * service (a database, a cache) would find nothing and can leave warnings in their logs. Pass
   * false to probe every local listener except ports of industrial protocols. A tunnel to a
   * controller on another port is found by naming it (`manual` `127.0.0.1:<port>`, or `ports`).
   */
  filterToVcProcesses?: boolean;
  /**
   * Opt-in local fallbacks for when the first listening-port source fails. Default: none.
   * - `powershell`: Windows `Get-NetTCPConnection` after `netstat -ano` fails.
   * - `sweep`: a blind connect sweep of the loopback address, Windows only, after the listening-port
   *   sources that ran (`netstat`, and `Get-NetTCPConnection` when `powershell` is on) failed.
   */
  localFallback?: { powershell?: boolean; sweep?: boolean };
  /** Per-probe timeout, ms. Default 1500. Allowed 100-30000. */
  timeoutMs?: number;
  /** Socket budgets. Out-of-range values are refused, not clamped. */
  pacing?: {
    /** Loopback targets. Default 32 sockets, 0 ms between new connections. Allowed 1-100 sockets, 0-10000 ms. */
    local?: { concurrency?: number; minGapMs?: number };
    /**
     * Other hosts. Default 8 sockets, 100 ms between new connections, at most 2 in flight per host.
     * Allowed 1-16 sockets and 100-10000 ms: the gap between new connections never goes below
     * 100 ms (10 a second), while up to 16 sockets may be in flight.
     */
    remote?: { concurrency?: number; minGapMs?: number };
    /** Logins in flight under `'with-credentials'`. Default 1. Allowed 1-4. */
    identifyConcurrency?: number;
  };
  /** Total distinct hosts across all `ranges`, after removing overlaps. Default 256. Allowed 1-4096. */
  maxRangeHosts?: number;
  /** Accept range addresses outside 10/8, 172.16/12, 192.168/16, 127/8 and 169.254/16. Default false. */
  allowPublicRanges?: boolean;
  /**
   * Cancels the run. The call then resolves (it does not reject) with `aborted: true` and the
   * entries found so far, once every socket is closed and every login already sent has logged out.
   */
  signal?: AbortSignal;
  /** Progress events. A callback that throws is caught and logged; the run continues. */
  onProgress?: (e: DiscoveryProgress) => void;
}

/** One address a controller answered on. */
export interface FoundAddress {
  /** IPv4 literal; `'::1'` only for a virtual-controller port bound to ::1 alone. */
  host: string;
  port: number;
  /** `null` = never probed (an mDNS-only address). */
  https: boolean | null;
  sources: ControllerSource[];
}

/**
 * The legacy probe result (`RobotManager.DiscoveredController`), restated structurally so that a
 * `FoundController.probe` can be passed to every method that takes a `DiscoveredController`.
 */
export interface DiscoveredProbe {
  host: string;
  port: number;
  useHttps: boolean;
  authType: 'digest' | 'basic';
}

/** One controller: every source and address that led to it, merged. */
export interface FoundController {
  /** `discoveryKey(host, port)`: `'local:<port>'` for any address of this PC, else `'<ipv4>:<port>'`. */
  key: string;
  host: string;
  port: number;
  /** `null` for an mDNS-only entry: the scheme was never probed, and it is never guessed. */
  https: boolean | null;
  /**
   * `'rws1'` (RWS 1.0, IRC5) or `'rws2'` (RWS 2.0, OmniCore), from the 401 scheme (Digest = RWS 1.0,
   * Basic = RWS 2.0) or a login. The 401 never tells RobotWare 7 from 8. For an mDNS-only entry
   * this is the advertisement-based guess, and `identified` is false. `null` when unknown.
   */
  generation: Protocol | null;
  authType: 'basic' | 'digest' | null;
  /** The probe result in the shape `RobotManager` connect paths take. `null` for mDNS-only entries. */
  probe: DiscoveredProbe | null;
  /**
   * true only when a probe got a 401 with realm `"validusers@robapi.abb"` (observed 2026-10-03 on
   * RobotStudio VCs RW 6.16.03, 7.21.0, 7.21.4, 8.1.1 and 8.2.1), or a login succeeded. false for
   * mDNS-only entries and for a 401 with any other realm (see `realm`). An entry is never logged
   * in to while false.
   */
  identified: boolean;
  /** The realm of the 401 challenge, as sent. */
  realm?: string;
  /** The hostname the user typed, when `host` came from a lookup. */
  name?: string;
  /** From mDNS TXT, the local VC system folder, or a login. Never guessed from port or certificate. */
  rwVersion?: string;
  systemName?: string;
  systemId?: string;
  /** Read after a login (`identify: 'with-credentials'`) only. */
  robotType?: string;
  sources: ControllerSource[];
  /** Further addresses folded into this entry because they share a non-empty `systemId`. */
  addresses?: FoundAddress[];
  /** Entries on this PC: the process that owns the port, where the OS reports one. */
  process?: { pid: number; image?: string };
  /** true when the owning process is a RobotStudio virtual controller (`RobVC.exe` or `Vrchost64.exe`). */
  isVirtual?: boolean;
  /** SHA-256 of the leaf certificate, HTTPS entries only. */
  tlsFingerprint?: string;
}

/**
 * Outcome of a listening-port source.
 * - `'ok'`: ran and parsed (an empty list is a valid answer).
 * - `'missing'`: the command or file does not exist.
 * - `'timeout'`: stopped by the discovery timeout.
 * - `'failed'`: non-zero exit, a signal, output too large, or a read error.
 * - `'unrecognised'`: ran, but the output shape was not understood.
 * - `'skipped'`: not run (`local: false`, or an earlier source answered).
 */
export type LocalScanStatus = 'ok' | 'missing' | 'timeout' | 'failed' | 'unrecognised' | 'skipped';

/** Run-level facts about the listening-port scan of this PC. */
export interface LocalScanReport {
  /** Status of the source that decided the result. */
  status: LocalScanStatus;
  /** That source, e.g. `'netstat -ano'`, `'/proc/net/tcp'`, `'ss -ltn'`. */
  source?: string;
  /** Every source tried, in order. */
  attempts: Array<{ source: string; status: LocalScanStatus; detail?: string }>;
  /** Windows virtual-controller process filter: on, off, or tried and failed (scan ran unfiltered). */
  vcFilter: 'on' | 'off' | 'failed';
  /** true when the opt-in blind loopback sweep ran. */
  sweep: boolean;
}

/** What `findControllers` resolves with. It never rejects except for invalid options. */
export interface FindControllersResult {
  /**
   * One entry per controller. Order: entries on this PC first, by port; then other hosts by
   * numeric IPv4, then port.
   */
  controllers: FoundController[];
  /** true when `signal` cancelled the run; `controllers` is then partial. */
  aborted: boolean;
  localScan: LocalScanReport;
  environment: { /** Running inside WSL, where VCs on Windows may not be visible. */ wsl: boolean };
  /** Addresses whose certificate failed verification under `strictTls`. Never silently dropped. */
  tlsFailures: Array<{ host: string; port: number; fingerprint?: string; error: string }>;
  /** `credentials` keys that matched no entry. */
  unmatchedCredentials: string[];
  /**
   * Plain sentences for a UI: the WSL hint, a listening-port scan of this PC that could not run
   * (so VCs here were not searched), a failed process lookup, a name with only an IPv6 address,
   * a skipped login and why.
   */
  notes: string[];
}

/** A progress event. */
export interface DiscoveryProgress {
  phase: 'local-scan' | 'sweep' | 'probe' | 'mdns' | 'identify' | 'done';
  /** Probes finished. One probe = one (host, port, scheme) connection. */
  probed: number;
  /** Probes planned. Grows by one when an HTTPS-to-HTTP fallback is scheduled. Sweep phase: ports to sweep. */
  total: number;
  /** Entries found so far. */
  found: number;
  /** The probe just finished, `'host:port/https'` or `'host:port/http'`. */
  current?: string;
  /** Set once the listening-port scan has finished. */
  localScan?: LocalScanReport;
}

// ---------------------------------------------------------------------------
// Internal (shared between the discovery modules; not exported from the package)
// ---------------------------------------------------------------------------

/** One listening TCP socket, as one OS source reported it. No address family: dual-stack sockets have none. */
export interface ListeningPort {
  port: number;
  /**
   * Bind address as printed, brackets and `%zone` removed: `'0.0.0.0'`, `'::'`, `'*'`,
   * `'127.0.0.1'`, `'127.0.0.53'`, `'::1'`, `'::ffff:127.0.0.1'`, `'192.0.2.10'`, ...
   */
  bind: string;
  /** Owning process, where the source reports one (Windows netstat and PowerShell, macOS lsof). */
  pid?: number;
  /** The source that reported it, e.g. `'netstat -ano'`. */
  source: string;
}

/**
 * Result of running one listening-port source. The next source runs on `missing`, `timeout`,
 * `failed` and `unrecognised`; never on `ok` with an empty list.
 */
export type ScanOutcome =
  | { status: 'ok'; source: string; ports: ListeningPort[] }
  | { status: 'missing'; source: string }
  | { status: 'timeout'; source: string }
  | { status: 'failed'; source: string; code?: number | string; signal?: string; detail?: string }
  | { status: 'unrecognised'; source: string; detail?: string }
  | { status: 'skipped'; source: string };

/** One listening-port source as the runner sees it. */
export interface ScanSource {
  /** Label used in `ScanOutcome.source` and `LocalScanReport.attempts`, e.g. `'netstat -ano'`. */
  name: string;
  /** Absolute path of the executable, or of the file read (`/proc/net/tcp`). */
  file: string;
  args: string[];
  /** Kill after this many ms (reported as `timeout`). */
  timeoutMs: number;
}

/** Everything the listening-port step hands to the orchestrator. */
export interface LocalListeners {
  /** Rows of the source that decided the result (empty unless its status is `ok`). */
  ports: ListeningPort[];
  report: LocalScanReport;
}

/** Scheme a port implies: one known scheme, or either (try HTTPS, then HTTP). */
export type PortScheme = 'https' | 'http' | 'either';

/** One row of a port table; port 80 appears twice (HTTPS and HTTP). */
export interface RwsPortEntry {
  port: number;
  https: boolean;
}

/** Options for one probe. */
export interface ProbeOptions {
  timeoutMs: number;
  strictTls: boolean;
  signal?: AbortSignal;
  /** Sent as `User-Agent`. Undefined: `abb-rws-client/<version> discovery`; an empty string sends none. */
  userAgent?: string;
}

/**
 * What one unauthenticated `GET /rw/system` on one (host, port, scheme) found.
 * - `rws`: a Digest or Basic 401 with realm `validusers@robapi.abb` (scheme matched case-insensitively).
 * - `other-401`: a Digest or Basic 401 with another realm, or none. Listed as not identified; never logged in to.
 * - `not-rws`: answered, but not with a Digest/Basic 401.
 * - `tls-failed`: TCP connected, the TLS handshake failed: the port is open and does not speak TLS.
 * - `tls-timeout`: TCP connected, but the TLS handshake got no answer before the timeout. A
 *   plain-HTTP server waiting for its request line does this (the RW 6.16.03 VC, 2026-10-03).
 * - `tls-unverified`: `strictTls` and the certificate failed verification; no HTTP request was sent.
 * - `refused`, `timeout`, `aborted`: nothing answered, or the run was cancelled.
 * `challenge` is the `WWW-Authenticate` value as received (repeated headers joined with ', ').
 */
export type ProbeOutcome =
  | { kind: 'rws'; authType: 'basic' | 'digest'; realm: string; tlsFingerprint?: string; challenge?: string }
  | { kind: 'other-401'; authType: 'basic' | 'digest'; realm?: string; tlsFingerprint?: string; challenge?: string }
  | { kind: 'not-rws' }
  | { kind: 'tls-failed' }
  | { kind: 'tls-timeout' }
  | { kind: 'tls-unverified'; fingerprint?: string; error: string }
  | { kind: 'refused' }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/** Scheduler lane: loopback targets, other hosts, logins. */
export type Lane = 'local' | 'remote' | 'identify';

/** One planned probe: one (host, port, scheme) connection. */
export interface ProbeUnit {
  /** IPv4 literal (or `'::1'` for the one ::1 retry) the socket connects to. */
  host: string;
  port: number;
  https: boolean;
  lane: Exclude<Lane, 'identify'>;
  source: ControllerSource;
  /** What the user typed, when `host` came from a hostname lookup (or `'localhost'`). */
  name?: string;
  /** Owning process, for ports found by the listening-port scan. */
  pid?: number;
  /** true for the HTTP attempt scheduled after HTTPS returned `tls-failed` or `tls-timeout`. */
  fallback?: boolean;
  /** For a wildcard `::`-type bind: retry once on `::1` if 127.0.0.1 is refused. */
  retryOnIpv6Loopback?: boolean;
}

/** A finished probe: the unit and its outcome. Input to the merge. */
export interface ProbeHit {
  unit: ProbeUnit;
  outcome: ProbeOutcome;
}

/** A host to probe, before it is expanded into units. */
export interface PlannedTarget {
  /** IPv4 literal (after lookup), or `'::1'`. */
  host: string;
  /** Given port; omitted = the port list for this kind of host plus `ports`. */
  port?: number;
  /** Given scheme; omitted = the scheme rule for the port. */
  https?: boolean;
  source: ControllerSource;
  name?: string;
  pid?: number;
}

/** A parsed range entry, sized by arithmetic before anything is expanded. */
export interface ParsedRange {
  /** The entry as given. */
  text: string;
  /** First and last address probed, as unsigned 32-bit integers (network/broadcast already dropped). */
  first: number;
  last: number;
  /** Number of addresses probed: last - first + 1. */
  size: number;
}

/** All ranges, merged and deduplicated. */
export interface RangePlan {
  ranges: ParsedRange[];
  /** Non-overlapping [first, last] intervals in ascending order, unsigned 32-bit integers. */
  intervals: Array<[number, number]>;
  /** Distinct addresses across all entries. */
  totalHosts: number;
}

/** `FindControllersOptions` after validation, with every default filled in. */
export interface NormalizedOptions {
  loopbackOnly: boolean;
  local: boolean;
  serviceAddress: boolean | 'auto';
  manual: ManualTarget[];
  ranges: RangePlan;
  /** Deduplicated. */
  ports: number[];
  mdns: boolean;
  identify: 'none' | 'anonymous' | 'with-credentials';
  credentials: Record<string, { username: string; password: string }>;
  strictTls: boolean;
  /** Keyed as given; values lower-case hex without colons. */
  pinnedFingerprints: Record<string, string>;
  /** Already resolved against the platform (false off Windows). */
  filterToVcProcesses: boolean;
  /**
   * Off Windows, with `filterToVcProcesses` not set to false: probe only local listeners on
   * `KNOWN_RWS_PORTS` and `ports`. Always false on Windows.
   */
  knownPortsOnly: boolean;
  localFallback: { powershell: boolean; sweep: boolean };
  timeoutMs: number;
  pacing: {
    local: { concurrency: number; minGapMs: number };
    remote: { concurrency: number; minGapMs: number };
    identifyConcurrency: number;
  };
  maxRangeHosts: number;
  allowPublicRanges: boolean;
  signal?: AbortSignal;
  onProgress?: (e: DiscoveryProgress) => void;
}

/**
 * Options of the internal `runDiscovery`: the public options plus compatibility flags the legacy
 * `RobotManager` wrappers need. Never part of the public API.
 */
export interface RunDiscoveryOptions extends FindControllersOptions {
  /**
   * With `compat`: probe every listening port on this host (`'localhost'` probes 127.0.0.1)
   * instead of the address each bind implies. The caller reports the host unchanged.
   */
  localProbeHost?: string;
  /**
   * Legacy behaviour for `discoverLocalControllers`: both schemes at once on every listening port
   * (200 sockets in the local lane), no process list, no system-folder read, no sweep. The caller
   * applies the legacy acceptance rule (any Digest/Basic 401) to the raw hits, and decides on the
   * wide loopback scan when every OS source failed.
   */
  compat?: boolean;
}

/** Image names of RobotStudio virtual-controller processes. */
export type VcProcessImage = 'RobVC.exe' | 'Vrchost64.exe';

/** PID to image name, from the Windows process list. */
export type PidImageMap = Map<number, VcProcessImage | string>;

/** What the local system folder of a virtual controller says. Soft fail: any field may be missing. */
export interface VcProcessDetails {
  pid: number;
  image?: string;
  /** The process command line (Vrchost64.exe carries `-sp "<system folder>"`). */
  commandLine?: string;
  /** The `-sp` system folder. */
  systemDir?: string;
  /** From `system.xml`. */
  systemName?: string;
  /** `RobotControl` version from `system.xml`, e.g. `'8.2.1+1023'`. */
  rwVersion?: string;
  /** From `rsmeta.xml`. */
  hostName?: string;
  /** Why a field is missing (command line empty, folder unreadable, PowerShell blocked). */
  note?: string;
}

/** What a login under `'with-credentials'` read, or why it was not done. */
export interface IdentifyOutcome {
  key: string;
  status: 'identified' | 'skipped' | 'failed';
  generation?: Protocol;
  systemName?: string;
  systemId?: string;
  rwVersion?: string;
  robotType?: string;
  /** For `skipped` and `failed`: a plain sentence for `notes`. */
  note?: string;
}

/** Result of resolving a manual hostname to IPv4. */
export interface ResolvedName {
  /** What the user typed. */
  name: string;
  /** The first IPv4 address; absent when the name has none. */
  ipv4?: string;
  /** Why it was not resolved (no IPv4 address, lookup failed). */
  note?: string;
}

/** Facts about where discovery runs. */
export interface DiscoveryEnvironment {
  wsl: boolean;
}
