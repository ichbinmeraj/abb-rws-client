/**
 * Dev-only TCP chaos proxy for structural/fault-injection testing.
 * Sits between a client and a target (a VC in live tests, an echo or mock
 * server in unit tests) and injects failures on demand:
 *   - dropAll():      hard-destroy every active connection (network blip)
 *   - freeze():       keep sockets open but stop forwarding (half-open)
 *   - refuseNew():    kill incoming connections at accept (blocked port)
 *   - setLatency():   delay each forwarded chunk (slow network)
 *   - setBandwidth(): cap throughput in bytes/sec (congested link)
 *   - setCorruption():truncate or mangle bytes flowing back to the client
 *   - script():       per-connection scripted behaviour (nth connection differs)
 *
 * Where it listens: on 127.0.0.1, on a free port that Node's fetch accepts,
 * or, with `listen: 'fetch-refused'`, on a free port that fetch refuses. An
 * RWS 1.0 client sends through fetch on the first and through node:http on
 * the second (src/badPorts.ts), so the same cell can run either transport.
 * The operating system's free ports can be refused ones (its dynamic range
 * starts at 1024 on some Windows machines), so a port fetch refuses is let
 * go and another taken unless one was asked for.
 *
 * Test infrastructure only - never shipped in the package.
 */

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { FETCH_BAD_PORTS } from '../../src/badPorts.js';
import { listenOnRefusedPort } from './refusedPorts.js';

/** How the proxy mangles bytes on the way back to the client. */
export type CorruptionMode =
  /** Pass through untouched. */
  | { kind: 'none' }
  /** Forward only the first N bytes of each response direction, then stop. */
  | { kind: 'truncate'; afterBytes: number }
  /** Forward the first N bytes then destroy the socket (cut mid-body). */
  | { kind: 'truncate-and-drop'; afterBytes: number }
  /** Replace bytes at a fixed stride with 0xFF (structurally invalid payload). */
  | { kind: 'garble'; everyNthByte: number };

/** Per-connection script: decide what this specific connection does. */
export interface ConnectionScript {
  /** Destroy this connection immediately at accept. */
  refuse?: boolean;
  /** Destroy this connection after it has forwarded this many bytes. */
  dropAfterBytes?: number;
  /** Corruption applied to this connection only (overrides the global mode). */
  corruption?: CorruptionMode;
}

export interface ChaosProxyStats {
  /** Connections accepted since the proxy started. */
  connectionsTotal: number;
  /** Connections currently open. */
  connectionsOpen: number;
  /** Bytes forwarded client -> upstream. */
  bytesUp: number;
  /** Bytes forwarded upstream -> client. */
  bytesDown: number;
}

/** Options of startChaosProxy. */
export interface ChaosProxyOptions {
  /**
   * `'fetch-accepted'` (the default): a free port Node's fetch accepts.
   * `'fetch-refused'`: a free port fetch refuses, so an RWS 1.0 client sends
   * through node:http (tests/helpers/refusedPorts.ts; throws when none is free).
   */
  listen?: 'fetch-accepted' | 'fetch-refused';
}

export interface ChaosProxy {
  /** Local port the proxy listens on. */
  port: number;
  /** Number of currently active client connections. */
  connections(): number;
  /**
   * The connections open now, oldest first: each one's 1-based index (as
   * `script` counts them) and whether its first request asked for a
   * WebSocket upgrade, read from the bytes the client sent (null while they
   * are not readable HTTP, as through TLS, or before a whole request head
   * arrived).
   */
  openConnections(): OpenConnection[];
  /** Counters since start - used by leak and backpressure assertions. */
  stats(): ChaosProxyStats;
  /** Hard-destroy every active connection (simulates a network blip). */
  dropAll(): void;
  /** Stop forwarding in both directions but keep sockets open (half-open freeze). */
  freeze(): void;
  /** Resume forwarding; traffic buffered while frozen is delivered. */
  unfreeze(): void;
  /** When true, destroy new connections at accept (simulates a blocked port). */
  refuseNew(refuse: boolean): void;
  /**
   * Repoint NEW connections at a different backend; existing pairs keep their
   * original target. Lets the proxy present a stable address while the backend
   * moves (a VC re-binds its RWS port on warm restart; real IRC5 keeps :80).
   */
  setTarget(host: string, port: number): void;
  /** Delay each forwarded chunk by ms (each direction). 0 disables. */
  setLatency(ms: number): void;
  /**
   * Cap throughput in bytes per second on the downstream direction. 0 disables.
   * Implemented by spacing chunk delivery, not by chopping chunks, so payload
   * integrity is preserved - use setCorruption for integrity failures.
   */
  setBandwidth(bytesPerSec: number): void;
  /** Mangle bytes flowing back to the client. Applies to new data from now on. */
  setCorruption(mode: CorruptionMode): void;
  /**
   * Script the Nth connection (1-based) accepted from now on. Lets a test say
   * "the first reconnect attempt fails, the second succeeds" deterministically
   * instead of racing global toggles.
   */
  script(nth: number, script: ConnectionScript): void;
  /** Stop the listener and destroy all connections. Safe to call twice. */
  close(): Promise<void>;
}

/** One open connection of the proxy (ChaosProxy.openConnections). */
export interface OpenConnection {
  /** 1-based index of this connection since the proxy started. */
  index: number;
  /** True when its first request asked for a WebSocket upgrade; null when that is not readable. */
  upgrade: boolean | null;
}

/** The longest request head the proxy reads to tell an upgrade (asksUpgrade). */
const HEAD_LIMIT = 8192;

/**
 * Whether the first request in `head` (the bytes a client sent, as latin1)
 * asks for a WebSocket upgrade: null unless it starts with an HTTP/1.x
 * request line and its header section ends within HEAD_LIMIT bytes.
 */
export function asksUpgrade(head: string): boolean | null {
  if (!/^[A-Z]+ \S+ HTTP\/1\.[01]\r\n/.test(head)) { return null; }
  const end = head.indexOf('\r\n\r\n');
  if (end < 0) { return null; }
  return /\r\nupgrade:[ \t]*websocket[ \t]*\r\n/i.test(head.slice(0, end + 2));
}

interface Pair {
  client: net.Socket;
  upstream: net.Socket;
  /** 1-based index of this connection since the proxy started. */
  index: number;
  /** The first bytes the client sent, as latin1, up to HEAD_LIMIT (asksUpgrade). */
  head: string;
  bytesDown: number;
  /**
   * `bytesDown` at the moment corruption was armed for this pair.
   *
   * `afterBytes` counts from HERE, not from the connection's birth, so "cut the
   * next response after N bytes" behaves the same whether it lands on the
   * connection that was already carrying traffic or on a fresh one. Metering
   * from birth made the cut depend on which pooled socket happened to serve the
   * request - it worked with exactly one connection and silently stopped cutting
   * with two.
   */
  corruptionBase: number;
  script?: ConnectionScript;
}

/** Listen on a free port of 127.0.0.1 that fetch accepts, and return it. */
async function listenOnAcceptedPort(server: net.Server): Promise<number> {
  for (let tries = 0; ; tries += 1) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    if (!FETCH_BAD_PORTS.has(port) || tries >= 50) { return port; }
    await new Promise<void>(r => server.close(() => r()));
  }
}

function applyCorruption(mode: CorruptionMode, data: Buffer, alreadySent: number): {
  out: Buffer | null; destroyAfter: boolean;
} {
  switch (mode.kind) {
    case 'none':
      return { out: data, destroyAfter: false };

    case 'truncate':
    case 'truncate-and-drop': {
      const remaining = mode.afterBytes - alreadySent;
      if (remaining <= 0) {
        return { out: null, destroyAfter: mode.kind === 'truncate-and-drop' };
      }
      if (data.length <= remaining) { return { out: data, destroyAfter: false }; }
      return {
        out: data.subarray(0, remaining),
        destroyAfter: mode.kind === 'truncate-and-drop',
      };
    }

    case 'garble': {
      const copy = Buffer.from(data);
      for (let i = 0; i < copy.length; i += Math.max(1, mode.everyNthByte)) {
        copy[i] = 0xff;
      }
      return { out: copy, destroyAfter: false };
    }
  }
}

export async function startChaosProxy(
  targetHost: string, targetPort: number, options: ChaosProxyOptions = {},
): Promise<ChaosProxy> {
  const pairs = new Set<Pair>();
  let currentTargetHost = targetHost;
  let currentTargetPort = targetPort;
  let frozen = false;
  let refusing = false;
  let latencyMs = 0;
  let bandwidthBps = 0;
  let corruption: CorruptionMode = { kind: 'none' };
  let closed = false;
  let connectionsTotal = 0;
  let bytesUp = 0;
  let bytesDown = 0;
  const scripts = new Map<number, ConnectionScript>();

  /** Chunks held back while frozen, flushed on unfreeze. */
  const heldBack: Array<{ to: net.Socket; data: Buffer }> = [];
  /** Next allowed send time per direction, used to shape bandwidth. */
  let nextSendAt = 0;

  const rawForward = (to: net.Socket, data: Buffer): void => {
    if (!to.destroyed) { to.write(data); }
  };

  const forward = (to: net.Socket, data: Buffer): void => {
    if (frozen) { heldBack.push({ to, data }); return; }

    let delay = latencyMs;
    if (bandwidthBps > 0) {
      // Space deliveries so throughput averages the cap. now < nextSendAt means
      // the link is saturated and this chunk waits its turn.
      const now = Date.now();
      const startAt = Math.max(now, nextSendAt);
      delay = Math.max(delay, startAt - now);
      nextSendAt = startAt + (data.length / bandwidthBps) * 1000;
    }
    if (delay > 0) { setTimeout(() => rawForward(to, data), delay); }
    else { rawForward(to, data); }
  };

  const server = net.createServer(client => {
    connectionsTotal++;
    const index = connectionsTotal;
    const script = scripts.get(index);

    if (refusing || script?.refuse) { client.destroy(); return; }

    const upstream = net.connect(currentTargetPort, currentTargetHost);
    const pair: Pair = { client, upstream, index, head: '', bytesDown: 0, corruptionBase: 0, script };
    pairs.add(pair);

    const teardown = (): void => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };

    client.on('data', d => {
      bytesUp += d.length;
      if (pair.head.length < HEAD_LIMIT) { pair.head += d.subarray(0, HEAD_LIMIT - pair.head.length).toString('latin1'); }
      forward(upstream, d);
    });

    upstream.on('data', d => {
      const mode = pair.script?.corruption ?? corruption;
      const { out, destroyAfter } = applyCorruption(mode, d, pair.bytesDown - pair.corruptionBase);
      if (out && out.length > 0) {
        pair.bytesDown += out.length;
        bytesDown += out.length;
        forward(client, out);
      }
      if (destroyAfter) { setTimeout(teardown, 0); return; }

      const limit = pair.script?.dropAfterBytes;
      if (limit !== undefined && pair.bytesDown >= limit) { setTimeout(teardown, 0); }
    });

    client.on('close', teardown);
    upstream.on('close', teardown);
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
  });

  const port = options.listen === 'fetch-refused'
    ? await listenOnRefusedPort(server)
    : await listenOnAcceptedPort(server);

  return {
    port,
    connections: () => pairs.size,
    openConnections: () => [...pairs]
      .sort((a, b) => a.index - b.index)
      .map(p => ({ index: p.index, upgrade: asksUpgrade(p.head) })),
    stats: () => ({ connectionsTotal, connectionsOpen: pairs.size, bytesUp, bytesDown }),
    dropAll: () => {
      for (const { client, upstream } of [...pairs]) {
        client.destroy();
        upstream.destroy();
      }
      pairs.clear();
    },
    freeze: () => { frozen = true; },
    unfreeze: () => {
      frozen = false;
      for (const { to, data } of heldBack.splice(0)) {
        if (!to.destroyed) { to.write(data); }
      }
    },
    refuseNew: (refuse: boolean) => { refusing = refuse; },
    setTarget: (host: string, p: number) => { currentTargetHost = host; currentTargetPort = p; },
    setLatency: (ms: number) => { latencyMs = ms; },
    setBandwidth: (bps: number) => { bandwidthBps = bps; nextSendAt = 0; },
    setCorruption: (mode: CorruptionMode) => {
      corruption = mode;
      // Re-base every live pair so `afterBytes` measures from now.
      for (const p of pairs) { p.corruptionBase = p.bytesDown; }
    },
    script: (nth: number, s: ConnectionScript) => { scripts.set(nth, s); },
    close: () => new Promise<void>(resolve => {
      for (const { client, upstream } of [...pairs]) {
        client.destroy();
        upstream.destroy();
      }
      pairs.clear();
      if (closed) { resolve(); return; }
      closed = true;
      server.close(() => resolve());
    }),
  };
}
