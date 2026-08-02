/**
 * Dev-only TCP chaos proxy for reconnect/heartbeat testing.
 * Sits between a client and a target (a VC in live tests, an echo server in
 * unit tests) and injects failures on demand:
 *   - dropAll():   hard-destroy every active connection (network blip)
 *   - freeze():    keep sockets open but stop forwarding (half-open connection)
 *   - refuseNew(): kill incoming connections at accept (blocked port)
 *   - setLatency():delay each forwarded chunk (slow network)
 *
 * Test infrastructure only - never shipped in the package.
 */

import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface ChaosProxy {
  /** Local port the proxy listens on. */
  port: number;
  /** Number of currently active client connections. */
  connections(): number;
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
  /** Stop the listener and destroy all connections. Safe to call twice. */
  close(): Promise<void>;
}

interface Pair { client: net.Socket; upstream: net.Socket }

export async function startChaosProxy(targetHost: string, targetPort: number): Promise<ChaosProxy> {
  const pairs = new Set<Pair>();
  let currentTargetHost = targetHost;
  let currentTargetPort = targetPort;
  let frozen = false;
  let refusing = false;
  let latencyMs = 0;
  let closed = false;
  /** Chunks held back while frozen, flushed on unfreeze. */
  const heldBack: Array<{ to: net.Socket; data: Buffer }> = [];

  const forward = (to: net.Socket, data: Buffer): void => {
    if (frozen) {
      heldBack.push({ to, data });
      return;
    }
    const deliver = (): void => { if (!to.destroyed) { to.write(data); } };
    if (latencyMs > 0) { setTimeout(deliver, latencyMs); } else { deliver(); }
  };

  const server = net.createServer(client => {
    if (refusing) {
      client.destroy();
      return;
    }
    const upstream = net.connect(currentTargetPort, currentTargetHost);
    const pair: Pair = { client, upstream };
    pairs.add(pair);

    const teardown = (): void => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };

    client.on('data', d => forward(upstream, d));
    upstream.on('data', d => forward(client, d));
    client.on('close', teardown);
    upstream.on('close', teardown);
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    connections: () => pairs.size,
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
    setTarget: (host: string, port: number) => { currentTargetHost = host; currentTargetPort = port; },
    setLatency: (ms: number) => { latencyMs = ms; },
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
