import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { startChaosProxy, type ChaosProxy } from './helpers/chaosProxy.js';

/** Echo server used as the proxy target. */
async function startEcho(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer(socket => {
    socket.on('error', () => undefined); // proxy teardown RSTs are expected
    socket.pipe(socket);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

/** Send a payload and wait up to timeoutMs for an echo chunk. */
function sendAndReceive(socket: net.Socket, payload: string, timeoutMs = 500): Promise<string | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { socket.removeListener('data', onData); resolve(null); }, timeoutMs);
    const onData = (d: Buffer): void => { clearTimeout(timer); resolve(d.toString()); };
    socket.once('data', onData);
    socket.write(payload);
  });
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('chaosProxy', () => {
  let echo: { port: number; close: () => Promise<void> };
  let proxy: ChaosProxy;

  beforeEach(async () => {
    echo = await startEcho();
    proxy = await startChaosProxy('127.0.0.1', echo.port);
  });

  afterEach(async () => {
    await proxy.close();
    await echo.close();
  });

  it('passes traffic through both ways by default', async () => {
    const client = await connect(proxy.port);
    expect(await sendAndReceive(client, 'hello')).toBe('hello');
    client.destroy();
  });

  it('dropAll hard-destroys every active connection', async () => {
    const client = await connect(proxy.port);
    expect(await sendAndReceive(client, 'ping')).toBe('ping');

    const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
    proxy.dropAll();
    await closed;
    expect(proxy.connections()).toBe(0);
  });

  it('freeze keeps sockets open but stops forwarding until unfreeze', async () => {
    const client = await connect(proxy.port);
    expect(await sendAndReceive(client, 'a')).toBe('a');

    proxy.freeze();
    // Socket stays open (no close event), but data goes nowhere
    expect(await sendAndReceive(client, 'b', 300)).toBeNull();
    expect(client.destroyed).toBe(false);

    proxy.unfreeze();
    // Buffered/late traffic flows again on the SAME connection
    expect(await sendAndReceive(client, 'c', 1000)).not.toBeNull();
    client.destroy();
  });

  it('refuseNew makes new connections fail while existing ones keep working', async () => {
    const client = await connect(proxy.port);
    // Round-trip first: proves the pair is established server-side before we
    // start refusing (the client-side 'connect' event alone races the proxy's
    // accept handler).
    expect(await sendAndReceive(client, 'pre')).toBe('pre');
    proxy.refuseNew(true);

    const second = await connect(proxy.port).then(
      s => { s.destroy(); return 'connected-and-killed'; },
      () => 'refused',
    );
    // Either the connect is refused outright or the socket is destroyed at once
    if (second === 'connected-and-killed') {
      // accept(2) already happened before destroy - verify it is unusable
      const s = await connect(proxy.port);
      expect(await sendAndReceive(s, 'x', 300)).toBeNull();
      s.destroy();
    }

    expect(await sendAndReceive(client, 'still-alive')).toBe('still-alive');

    proxy.refuseNew(false);
    const third = await connect(proxy.port);
    expect(await sendAndReceive(third, 'back')).toBe('back');
    client.destroy();
    third.destroy();
  });

  it('setLatency delays forwarded traffic by roughly the configured amount', async () => {
    proxy.setLatency(150);
    const client = await connect(proxy.port);
    const t0 = Date.now();
    const reply = await sendAndReceive(client, 'slow', 2000);
    const elapsed = Date.now() - t0;
    expect(reply).toBe('slow');
    // one-way latency applies in each direction
    expect(elapsed).toBeGreaterThanOrEqual(250);
    client.destroy();
  });

  it('setTarget points new connections at a different backend', async () => {
    // Simulates a VC rebinding its RWS port after a warm restart while the
    // proxy keeps presenting a stable address to the client (like a real
    // IRC5 keeping :80 across restarts). Backend B tags replies so routing
    // is provable.
    const serverB = net.createServer(socket => {
      socket.on('error', () => undefined);
      socket.on('data', d => socket.write('B:' + d.toString()));
    });
    await new Promise<void>(resolve => serverB.listen(0, '127.0.0.1', resolve));
    const portB = (serverB.address() as AddressInfo).port;
    try {
      const first = await connect(proxy.port);
      expect(await sendAndReceive(first, 'a')).toBe('a');

      proxy.setTarget('127.0.0.1', portB);
      const second = await connect(proxy.port);
      expect(await sendAndReceive(second, 'b')).toBe('B:b');
      // Existing connection to the old target keeps working
      expect(await sendAndReceive(first, 'c')).toBe('c');
      first.destroy();
      second.destroy();
    } finally {
      await new Promise<void>(resolve => serverB.close(() => resolve()));
    }
  });

  it('close shuts the listener down', async () => {
    await proxy.close();
    await expect(connect(proxy.port)).rejects.toThrow();
    // afterEach double-close must not throw
  });
});

void wait;
