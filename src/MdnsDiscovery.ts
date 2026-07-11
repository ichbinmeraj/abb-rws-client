/**
 * mDNS/Bonjour discovery of ABB controllers — zero dependencies (node:dgram +
 * hand-rolled DNS wire parsing).
 *
 * Live-verified 2026-07-08/09 against five RobotStudio VCs (1× RW6.16 IRC5,
 * 4× RW7.21 OmniCore) on this network:
 *   - Every controller/VC advertises the `_http._tcp.local` service with
 *     instance name `RobotWebServices_<systemname>`. ABB's manual documents
 *     browsing the `rws` SUBTYPE (`dns-sd -B _http._tcp,rws`), so we query
 *     `rws._sub._http._tcp.local` first and plain `_http._tcp.local` as a
 *     fallback (some stacks don't answer subtype PTR queries).
 *   - RW7 VCs attach TXT records: `RwVer=7.21.0 SysGuid=<guid> RwsPort=5466
 *     RobApiP=2558 WanIp= VC=`. RW6 VCs advertise name + SRV(port) only —
 *     NO TXT metadata. That asymmetry is the protocol heuristic below.
 *   - The SRV target is the machine hostname (e.g. `DESKTOP-X.local`); the
 *     address comes from the A record in the additionals section, falling
 *     back to the UDP responder's source address.
 *
 * Strategy: one-shot LEGACY unicast query (RFC 6762 §6.7) — bind an ephemeral
 * UDP port (never 5353 itself; mDNSResponder owns it), send standard DNS PTR
 * queries to 224.0.0.251:5353, and collect the unicast replies until the
 * timeout. Windows multicast egress is per-interface, so when the host has
 * several IPv4 interfaces the query is re-sent through each one.
 */
import * as dgram from 'dgram';
import * as os from 'os';

/** A controller found via mDNS. RW6 units carry no TXT → only name/host/port. */
export interface MdnsController {
  /** Full mDNS instance label, e.g. `RobotWebServices_MyRobot`. */
  instanceName: string;
  /** Controller system name — the instance label minus the `RobotWebServices_` prefix. */
  systemName: string;
  /** IPv4 address (A record of the SRV target, else the responder's source address). */
  host: string;
  /** RWS port — TXT `RwsPort` when present, else the SRV port. */
  port: number;
  /** RobotWare version from TXT `RwVer` (RW7 only). */
  rwVersion?: string;
  /** System GUID from TXT `SysGuid` (RW7 only). */
  sysGuid?: string;
  /** PC SDK (RobApi) port from TXT `RobApiP` (RW7 only). */
  robApiPort?: number;
  /**
   * Heuristic, not a probe: RW7/OmniCore advertisements carry TXT metadata
   * (`RwsPort`/`RwVer`) → 'rws2'; advertisements with no TXT data → 'rws1'
   * (matches RW6 behavior); TXT present but without the ABB keys → 'unknown'.
   * Confirm with `RobotManager.probeSpecificPort` before trusting it.
   */
  probableProtocol: 'rws1' | 'rws2' | 'unknown';
}

/** Minimal slice of `dgram.Socket` used here — injectable for offline tests. */
export interface MdnsSocket {
  on(event: 'message', cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: string, cb: (...args: never[]) => void): void;
  bind(port: number, address: string, cb: () => void): void;
  send(msg: Uint8Array, port: number, address: string, cb?: (err: Error | null) => void): void;
  setMulticastInterface(addr: string): void;
  close(): void;
}

export interface MdnsDiscoveryOptions {
  /** How long to collect replies before resolving. Default 2000 ms. */
  timeoutMs?: number;
  /** Test seam — defaults to `dgram.createSocket('udp4')`. */
  socketFactory?: () => MdnsSocket;
  /**
   * IPv4 interface addresses to use as multicast egress (in addition to the
   * OS default route). Defaults to every local IPv4 address — on Windows the
   * default-route interface is often NOT the one the VCs/robots live on.
   */
  interfaceAddrs?: string[];
}

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const QUERY_NAMES = ['rws._sub._http._tcp.local', '_http._tcp.local'] as const;
const INSTANCE_PREFIX = 'RobotWebServices_';

// DNS record types we care about
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

// ─── Wire encoding ────────────────────────────────────────────────────────────

/** Build a standard one-question DNS PTR query (legacy unicast — plain QCLASS IN). */
function buildPtrQuery(name: string, id: number): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4); // QDCOUNT
  parts.push(header);
  for (const label of name.split('.')) {
    if (label.length === 0) { continue; }
    const lb = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([lb.length]), lb);
  }
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(TYPE_PTR, 1); // byte 0 is the root-label terminator
  tail.writeUInt16BE(1, 3);        // QCLASS IN
  parts.push(tail);
  return Buffer.concat(parts);
}

// ─── Wire parsing ─────────────────────────────────────────────────────────────

/**
 * Decode a (possibly compressed) domain name. Returns the labels and the
 * offset just past the name in the original (non-pointer) stream. Throws on
 * truncation and pointer loops — callers treat any throw as "malformed
 * packet, ignore".
 */
function readName(buf: Buffer, offset: number): { labels: string[]; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1; // set on the first compression jump
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) { throw new Error('name runs past end of packet'); }
    const len = buf[pos];
    if (len === 0) { pos += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) { throw new Error('truncated compression pointer'); }
      if (++jumps > 64) { throw new Error('compression pointer loop'); }
      if (next < 0) { next = pos + 2; }
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
    } else if ((len & 0xc0) !== 0) {
      throw new Error('reserved label type');
    } else {
      if (pos + 1 + len > buf.length) { throw new Error('label runs past end of packet'); }
      labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
      pos += 1 + len;
    }
  }
  return { labels, next: next < 0 ? pos : next };
}

/** Parse a TXT rdata (length-prefixed `key=value` strings) into a lowercase-keyed map. */
function parseTxt(buf: Buffer, start: number, len: number): Record<string, string> {
  const out: Record<string, string> = {};
  const end = start + len;
  let pos = start;
  while (pos < end) {
    const l = buf[pos];
    pos += 1;
    if (l === 0) { continue; }
    const s = buf.toString('utf8', pos, Math.min(pos + l, end));
    pos += l;
    const eq = s.indexOf('=');
    const key = (eq >= 0 ? s.slice(0, eq) : s).toLowerCase();
    if (key) { out[key] = eq >= 0 ? s.slice(eq + 1) : ''; }
  }
  return out;
}

/** Accumulated records across all reply packets of one discovery run. */
interface RecordStore {
  /** key = lowercased full service name → instance label + reply source address. */
  instances: Map<string, { instanceLabel: string; srcAddr: string }>;
  srv: Map<string, { target: string; port: number }>;
  txt: Map<string, Record<string, string>>;
  /** key = lowercased hostname → IPv4 address. */
  a: Map<string, string>;
}

/**
 * Parse one reply packet into the store. Answers, authority, and additionals
 * are treated uniformly — responders put the A record for the SRV target in
 * additionals. Throws on malformed data (caller ignores the packet).
 */
function ingestPacket(buf: Buffer, srcAddr: string, store: RecordStore): void {
  if (buf.length < 12) { throw new Error('packet shorter than DNS header'); }
  if ((buf.readUInt16BE(2) & 0x8000) === 0) { return; } // a query, not a response
  const qdCount = buf.readUInt16BE(4);
  const rrCount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);

  let pos = 12;
  for (let i = 0; i < qdCount; i++) {
    pos = readName(buf, pos).next + 4; // skip QTYPE + QCLASS
  }

  const register = (labels: string[]): string => {
    const key = labels.join('.').toLowerCase();
    store.instances.set(key, { instanceLabel: labels[0], srcAddr });
    return key;
  };

  for (let i = 0; i < rrCount; i++) {
    const { labels, next } = readName(buf, pos);
    pos = next;
    if (pos + 10 > buf.length) { throw new Error('record header runs past end of packet'); }
    const type = buf.readUInt16BE(pos);
    const rdLen = buf.readUInt16BE(pos + 8);
    pos += 10;
    if (pos + rdLen > buf.length) { throw new Error('rdata runs past end of packet'); }

    if (type === TYPE_PTR) {
      const target = readName(buf, pos).labels;
      if (target[0]?.startsWith(INSTANCE_PREFIX)) { register(target); }
    } else if (type === TYPE_SRV && labels[0]?.startsWith(INSTANCE_PREFIX)) {
      if (rdLen < 8) { throw new Error('SRV rdata too short'); }
      const port = buf.readUInt16BE(pos + 4);
      const target = readName(buf, pos + 6).labels.join('.');
      store.srv.set(register(labels), { target, port });
    } else if (type === TYPE_TXT && labels[0]?.startsWith(INSTANCE_PREFIX)) {
      store.txt.set(register(labels), parseTxt(buf, pos, rdLen));
    } else if (type === TYPE_A && rdLen >= 4) {
      store.a.set(labels.join('.').toLowerCase(), `${buf[pos]}.${buf[pos + 1]}.${buf[pos + 2]}.${buf[pos + 3]}`);
    }
    pos += rdLen;
  }
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function positiveInt(value: string | undefined): number | undefined {
  if (!value) { return undefined; }
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildControllers(store: RecordStore): MdnsController[] {
  const byInstance = new Map<string, MdnsController>();
  for (const [key, inst] of store.instances) {
    const srv = store.srv.get(key);
    const txt = store.txt.get(key);
    const hasTxtData = txt !== undefined && Object.keys(txt).length > 0;
    const port = positiveInt(txt?.['rwsport']) ?? srv?.port;
    if (!port) { continue; } // no SRV and no RwsPort — nothing to connect to
    const host = (srv && store.a.get(srv.target.toLowerCase())) ?? inst.srcAddr;

    const controller: MdnsController = {
      instanceName: inst.instanceLabel,
      systemName: inst.instanceLabel.slice(INSTANCE_PREFIX.length),
      host,
      port,
      probableProtocol: hasTxtData
        ? (txt['rwsport'] || txt['rwver'] ? 'rws2' : 'unknown')
        : 'rws1',
    };
    const rwVersion = txt?.['rwver'];
    if (rwVersion) { controller.rwVersion = rwVersion; }
    const sysGuid = txt?.['sysguid'];
    if (sysGuid) { controller.sysGuid = sysGuid; }
    const robApiPort = positiveInt(txt?.['robapip']);
    if (robApiPort !== undefined) { controller.robApiPort = robApiPort; }

    if (!byInstance.has(controller.instanceName)) {
      byInstance.set(controller.instanceName, controller);
    }
  }
  return [...byInstance.values()];
}

/** Non-internal-first list of local IPv4 addresses, for multicast egress retries. */
function ipv4InterfaceAddrs(): string[] {
  const addrs: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      // Node <18.0 reports family as the string 'IPv4', ≥18.0 sometimes as the number 4
      if ((info.family === 'IPv4' || (info.family as unknown) === 4) && !info.internal) {
        addrs.push(info.address);
      }
    }
  }
  return addrs;
}

/**
 * One-shot mDNS browse for ABB controllers. Resolves after `timeoutMs`
 * (default 2000) with every `RobotWebServices_*` instance heard, deduped by
 * instance name. Never rejects — socket errors resolve with what was
 * collected so far.
 */
export function discoverControllersMdns(opts: MdnsDiscoveryOptions = {}): Promise<MdnsController[]> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const factory = opts.socketFactory ?? ((): MdnsSocket => dgram.createSocket({ type: 'udp4', reuseAddr: true }));

  return new Promise<MdnsController[]>(resolve => {
    const store: RecordStore = { instances: new Map(), srv: new Map(), txt: new Map(), a: new Map() };
    let socket: MdnsSocket;
    try {
      socket = factory();
    } catch {
      resolve([]);
      return;
    }

    let settled = false;
    const finish = (): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(buildControllers(store));
    };
    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', () => finish());
    socket.on('message', (msg: Buffer, rinfo: { address: string; port: number }) => {
      try {
        ingestPacket(msg, rinfo.address, store);
      } catch {
        // malformed or non-DNS packet — 5353 traffic is noisy, just skip it
      }
    });

    try {
      socket.bind(0, '0.0.0.0', () => {
        const queries = QUERY_NAMES.map((name, i) => buildPtrQuery(name, i + 1));
        const sendAll = (): void => {
          for (const q of queries) {
            try { socket.send(q, MDNS_PORT, MDNS_ADDR, () => { /* send errors are non-fatal */ }); } catch { /* ditto */ }
          }
        };
        sendAll(); // OS default multicast egress
        // Windows picks ONE egress interface per send — retry through each
        // IPv4 interface so controllers on non-default-route networks answer.
        for (const addr of opts.interfaceAddrs ?? ipv4InterfaceAddrs()) {
          try {
            socket.setMulticastInterface(addr);
            sendAll();
          } catch {
            // interface can't multicast (VPN/virtual adapters) — skip
          }
        }
      });
    } catch {
      finish();
    }
  });
}
