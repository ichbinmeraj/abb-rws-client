import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { asksUpgrade, startChaosProxy, type ChaosProxy } from './helpers/chaosProxy.js';
import { REFUSED_LISTEN_PORTS, listenOnRefusedPort } from './helpers/refusedPorts.js';
import { answer, scriptedServer, type ScriptedServer } from './helpers/scriptedHttp.js';
import { FETCH_BAD_PORTS, fetchRefusesUrl } from '../src/badPorts.js';
import { HttpSession } from '../src/HttpSession.js';
import { RwsError } from '../src/types.js';

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
    const before = proxy.stats().connectionsTotal;
    await proxy.close();
    // The closed proxy accepts nothing. The freed port itself may already belong to a
    // listener another test file just opened (ports are reused under load), so a
    // connect there can succeed: what counts is that this proxy never saw it.
    const late = await connect(proxy.port).catch(() => null);
    late?.destroy();
    expect(proxy.stats().connectionsTotal).toBe(before);
    // afterEach double-close must not throw
  });

  it('openConnections lists the open connections by index and tells the one whose first request asked for a WebSocket upgrade', async () => {
    const plain = await connect(proxy.port);
    await sendAndReceive(plain, 'GET /rw/system HTTP/1.1\r\nHost: x\r\n\r\n');
    const ws = await connect(proxy.port);
    await sendAndReceive(ws, 'GET /poll/1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    const tls = await connect(proxy.port);
    await sendAndReceive(tls, '\x16\x03\x01\x02\x00\x01');

    expect(proxy.openConnections()).toEqual([
      { index: 1, upgrade: false },
      { index: 2, upgrade: true },
      { index: 3, upgrade: null },
    ]);
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
    ws.destroy();
    await closed;
    await until(() => proxy.openConnections().length === 2);
    expect(proxy.openConnections().map(c => c.index)).toEqual([1, 3]);
    plain.destroy();
    tls.destroy();
  });
});

describe('asksUpgrade', () => {
  it('reads the first request head only, and says null when it is not readable HTTP or not complete', () => {
    expect(asksUpgrade('GET /poll/1 HTTP/1.1\r\nupgrade: WebSocket\r\n\r\n')).toBe(true);
    expect(asksUpgrade('GET /rw/system HTTP/1.1\r\nHost: x\r\n\r\nGET /x HTTP/1.1\r\nUpgrade: websocket\r\n\r\n')).toBe(false);
    expect(asksUpgrade('GET /poll/1 HTTP/1.1\r\nUpgrade: websocket\r\n')).toBeNull();
    expect(asksUpgrade('\x16\x03\x01')).toBeNull();
    expect(asksUpgrade('')).toBeNull();
  });
});

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) { throw new Error('condition not met in time'); }
    await wait(10);
  }
}

describe('chaosProxy - the port it listens on, and the RWS 1.0 transport behind it', () => {
  const opened: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const o of opened.splice(0).reverse()) { await o.close(); }
  });

  it('the ports a test may listen on for node:http are the bad ports from 1024 up, every one refused by fetch', () => {
    expect(REFUSED_LISTEN_PORTS.slice(0, 6)).toEqual([10080, 6665, 6666, 6667, 6668, 6669]);
    expect([...REFUSED_LISTEN_PORTS].sort((a, b) => a - b))
      .toEqual([...FETCH_BAD_PORTS].filter(p => p >= 1024).sort((a, b) => a - b));
    expect(new Set(REFUSED_LISTEN_PORTS).size).toBe(REFUSED_LISTEN_PORTS.length);
    for (const p of REFUSED_LISTEN_PORTS) { expect(fetchRefusesUrl(`http://127.0.0.1:${p}`), String(p)).toBe(true); }
  });

  it('a held refused port is passed over for the next free one, and none free fails naming each port', async () => {
    const first = net.createServer();
    const p1 = await listenOnRefusedPort(first);
    opened.push({ close: () => new Promise<void>(r => first.close(() => r())) });
    const second = net.createServer();
    const p2 = await listenOnRefusedPort(second);
    opened.push({ close: () => new Promise<void>(r => second.close(() => r())) });
    expect(p2).not.toBe(p1);
    expect(REFUSED_LISTEN_PORTS).toContain(p2);

    const third = net.createServer();
    await expect(listenOnRefusedPort(third, '127.0.0.1', [p1, p2]))
      .rejects.toThrow(`none of the ports Node's fetch refuses could be listened on at 127.0.0.1 (${p1} EADDRINUSE, ${p2} EADDRINUSE)`);
    expect(third.listening).toBe(false);
  });

  it('listens on a port fetch accepts by default, and on one it refuses when asked', async () => {
    const echo = await startEcho();
    opened.push(echo);
    const plain = await startChaosProxy('127.0.0.1', echo.port);
    opened.push(plain);
    const refused = await startChaosProxy('127.0.0.1', echo.port, { listen: 'fetch-refused' });
    opened.push(refused);
    expect(fetchRefusesUrl(`http://127.0.0.1:${plain.port}`)).toBe(false);
    expect(fetchRefusesUrl(`http://127.0.0.1:${refused.port}`)).toBe(true);
    const client = await connect(refused.port);
    expect(await sendAndReceive(client, 'through a refused port')).toBe('through a refused port');
    client.destroy();
  });

  it('an RWS 1.0 session through a proxy on a refused port sends through node:http: a cut answer is a typed error, then it recovers', async () => {
    const srv: ScriptedServer = await scriptedServer();
    opened.push(srv);
    srv.alwaysBy(r => (r.headers.authorization
      ? answer(200, '<html><body><span class="ctrlstate">motoroff</span></body></html>')
      : answer(401, '', { 'www-authenticate': 'Digest realm="robot", nonce="proxy-nonce", qop="auth", algorithm=MD5' })));
    const proxy = await startChaosProxy('127.0.0.1', srv.port, { listen: 'fetch-refused' });
    opened.push(proxy);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const session = new HttpSession({
      baseUrl: `http://127.0.0.1:${proxy.port}`, username: 'Default User', password: 'robotics',
      requestIntervalMs: 0, timeoutMs: 3000,
    });
    opened.push({ close: async () => { session.close(); } });

    expect((await session.get('/rw/panel/ctrlstate')).status).toBe(200);

    // Cut the next answer 20 bytes in and drop the connection, as cell S01 does.
    proxy.setCorruption({ kind: 'truncate-and-drop', afterBytes: 20 });
    const err = await session.get('/rw/panel/ctrlstate').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect((err as RwsError).code).toBe('NETWORK_ERROR');

    proxy.setCorruption({ kind: 'none' });
    expect((await session.get('/rw/panel/ctrlstate')).status).toBe(200);
    // Every request went through the proxy, and none through fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(srv.requests.length).toBeGreaterThanOrEqual(4);
  });
});

void wait;
