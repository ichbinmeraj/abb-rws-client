import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { WsSubscriber } from '../src/WsSubscriber.js';
import { RwsError, type SubscriptionResource } from '../src/types.js';
import type { HttpSession } from '../src/HttpSession.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const COOKIE = 'ABBCX=abc123; -http-session-=xyz789';
const LOCATION = 'http://127.0.0.1:1/subscription/42';

/**
 * Minimal HttpSession stand-in: POST /subscription → 201 + Location, records DELETEs.
 * Pass an array of locations to script successive POSTs (last entry repeats).
 */
function makeFakeSession(location: string | string[] = LOCATION): {
  session: HttpSession; deletes: string[]; posts: { count: number };
} {
  const deletes: string[] = [];
  const posts = { count: 0 };
  const locations = Array.isArray(location) ? [...location] : [location];
  const session = {
    post: async () => ({
      status: 201,
      body: '',
      headers: new Headers({
        location: locations.length > 1 ? locations.shift()! : locations[0],
      }),
    }),
    delete: async (url: string) => {
      deletes.push(url);
      return { status: 200, body: '', headers: new Headers() };
    },
    getCookieHeader: () => COOKIE,
  } as unknown as HttpSession;
  const post = session.post.bind(session);
  (session as unknown as { post: typeof post }).post = async (...args: Parameters<typeof post>) => {
    posts.count++;
    return post(...args);
  };
  return { session, deletes, posts };
}

interface CapturedCtorArgs {
  url: string;
  protocols: string[];
  options: { headers: Record<string, string> };
}

type FakeHandlers = {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((e: { wasClean?: boolean }) => void) | null;
};

/** Build a fake WebSocket class that opens (or fails) asynchronously */
function makeFakeWs(behavior: 'open' | 'fail') {
  const captured: CapturedCtorArgs[] = [];
  const state = { opened: false };
  class FakeWs implements FakeHandlers {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((e: { wasClean?: boolean }) => void) | null = null;
    constructor(url: string, protocols: string[], options: { headers: Record<string, string> }) {
      captured.push({ url, protocols, options });
      setTimeout(() => {
        if (behavior === 'open') {
          state.opened = true;
          this.onopen?.();
        } else {
          this.onerror?.();
          this.onclose?.({ wasClean: false });
        }
      }, 10);
    }
    close(): void {
      this.onclose?.({ wasClean: true });
    }
  }
  return { FakeWs: FakeWs as unknown as typeof WebSocket, captured, state };
}

/**
 * Scripted fake WebSocket: each construction consumes the next behavior from the
 * script ('open' or 'fail'); when the script is exhausted the last entry repeats.
 * Exposes the ws-package surface the subscriber relies on for heartbeat/reconnect
 * (ping/terminate/EventEmitter-style pong listener) plus test triggers.
 */
function makeScriptedWs(script: Array<'open' | 'fail'>, opts: { autoPong?: boolean } = {}) {
  const instances: ScriptedInstance[] = [];
  const pending = [...script];
  const autoPong = opts.autoPong ?? true;

  class ScriptedInstance implements FakeHandlers {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((e: { wasClean?: boolean }) => void) | null = null;
    url: string;
    opened = false;
    pings = 0;
    terminated = false;
    private pongListeners: Array<() => void> = [];

    constructor(url: string, _protocols: string[], _options: { headers: Record<string, string> }) {
      this.url = url;
      instances.push(this);
      const behavior = pending.length > 1 ? pending.shift()! : pending[0];
      setTimeout(() => {
        if (behavior === 'open') {
          this.opened = true;
          this.onopen?.();
        } else {
          this.onerror?.();
          this.onclose?.({ wasClean: false });
        }
      }, 1);
    }

    on(event: string, cb: () => void): void {
      if (event === 'pong') { this.pongListeners.push(cb); }
    }

    ping(): void {
      this.pings++;
      if (autoPong) { setTimeout(() => this.pongListeners.forEach(cb => cb()), 0); }
    }

    /** Test trigger: answer the outstanding ping manually. */
    emitPong(): void {
      this.pongListeners.forEach(cb => cb());
    }

    terminate(): void {
      this.terminated = true;
      this.onclose?.({ wasClean: false });
    }

    close(): void {
      this.onclose?.({ wasClean: true });
    }

    /** Test trigger: unclean drop initiated by the "controller". */
    serverClose(): void {
      this.onclose?.({ wasClean: false });
    }

    /**
     * Test trigger: a close frame from the "controller". The ws package
     * answers it with its own, so the close event reads as clean.
     */
    serverCloseClean(): void {
      this.onclose?.({ wasClean: true });
    }

    /** Test trigger: deliver an event frame. */
    serverMessage(data: string): void {
      this.onmessage?.({ data });
    }
  }

  return { FakeWs: ScriptedInstance as unknown as typeof WebSocket, instances };
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Poll until a condition holds, instead of sleeping a fixed span and hoping.
 *
 * The heartbeat tests drive a chain of short timers (ping -> pong timeout ->
 * terminate -> reconnect). A fixed sleep has to be longer than the worst-case
 * scheduling delay of that whole chain, and under parallel-suite CPU load it
 * is not - the assertions then fail for a late timer rather than a real bug.
 * Polling costs nothing when things are fast and simply waits when they are not.
 */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) { throw new Error('condition not met in time'); }
    await wait(5);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WsSubscriber - transport selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('default transport is the ws package, never native: Cookie and subprotocol reach the wire', async () => {
    // Native (undici) WebSocket ignores the ws-style headers option - the Cookie
    // would be silently dropped and RWS 1.0 WS auth would fail. Prove the default
    // (no injected constructor) transport delivers both on the upgrade request.
    const nativeCtor = vi.fn();
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(...args: unknown[]) {
          nativeCtor(args);
        }
      },
    );

    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols) => protocols.values().next().value ?? false,
    });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;

    const upgrade = new Promise<{ cookie?: string; protocol?: string }>((resolve) => {
      wss.once('connection', (_socket, req) =>
        resolve({
          cookie: req.headers.cookie,
          protocol: req.headers['sec-websocket-protocol'],
        }),
      );
    });

    const { session } = makeFakeSession(`http://127.0.0.1:${port}/subscription/42`);
    const subscriber = new WsSubscriber(session, '127.0.0.1', port);

    try {
      const unsubscribe = await subscriber.subscribe(['execution'], () => undefined);
      const headers = await upgrade;
      expect(headers.cookie).toBe(COOKIE);
      expect(headers.protocol).toBe('robapi2_subscription');
      expect(nativeCtor).not.toHaveBeenCalled();
      await unsubscribe();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('passes the session Cookie header to the WebSocket constructor', async () => {
    const { session } = makeFakeSession();
    const { FakeWs, captured } = makeFakeWs('open');
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);

    const unsubscribe = await subscriber.subscribe(['execution'], () => undefined);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('ws://127.0.0.1:1/subscription/42');
    expect(captured[0].protocols).toEqual(['robapi2_subscription']);
    expect(captured[0].options.headers['Cookie']).toBe(COOKIE);

    await unsubscribe();
  });

  it('passes a handshake timeout to the WebSocket constructor so half-open upgrades cannot hang', async () => {
    const { session } = makeFakeSession();
    const { FakeWs, captured } = makeFakeWs('open');
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);

    const unsubscribe = await subscriber.subscribe(['execution'], () => undefined);
    const options = captured[0].options as { handshakeTimeout?: number };
    expect(options.handshakeTimeout).toBe(8000);
    await unsubscribe();

    const unsubscribe2 = await subscriber.subscribe(['execution'], () => undefined, {
      openTimeoutMs: 1234,
    });
    const options2 = captured[1].options as { handshakeTimeout?: number };
    expect(options2.handshakeTimeout).toBe(1234);
    await unsubscribe2();
  });
});

describe('WsSubscriber - subscription resource paths', () => {
  /** Fake session that records the form body posted to /subscription. */
  function makeBodyCapturingSession() {
    const bodies: string[] = [];
    const session = {
      post: async (_url: string, body: string) => {
        bodies.push(body);
        return {
          status: 201,
          body: '',
          headers: new Headers({ location: 'http://127.0.0.1:1/subscription/42' }),
        };
      },
      delete: async () => ({ status: 200, body: '', headers: new Headers() }),
      getCookieHeader: () => COOKIE,
    } as unknown as HttpSession;
    return { session, bodies };
  }

  async function pathFor(resource: SubscriptionResource): Promise<string> {
    const { session, bodies } = makeBodyCapturingSession();
    const { FakeWs } = makeFakeWs('open');
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);
    const unsubscribe = await subscriber.subscribe([resource], () => undefined);
    await unsubscribe();
    return decodeURIComponent(bodies[0].match(/&1=([^&]*)/)![1]);
  }

  it('subscribes signals on ;state', async () => {
    expect(await pathFor({ type: 'signal', name: 'NET/DEV/di_1' }))
      .toBe('/rw/iosystem/signals/NET/DEV/di_1;state');
  });

  it('refuses a signal name that would add form fields, before posting anything', async () => {
    // The name goes into the body verbatim; '&resources=2&2=...' used to bind
    // a second resource the caller never asked for.
    const { session, bodies } = makeBodyCapturingSession();
    const { FakeWs } = makeFakeWs('open');
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);
    for (const name of ['di_1&resources=2&2=/rw/panel/ctrlstate', 'di=1', 'Local/../di_1']) {
      await expect(subscriber.subscribe([{ type: 'signal', name }], () => undefined))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(bodies).toHaveLength(0);
  });

  it('prefixes persistent variables with the RAPID domain', async () => {
    // Without RAPID/ the controller answers 400 "Resource does not exist on the
    // controller" (live-verified on RW6.16).
    expect(await pathFor({ type: 'persvar', name: 'T_ROB1/BASE/tool0' }))
      .toBe('/rw/rapid/symbol/data/RAPID/T_ROB1/BASE/tool0;value');
  });

  it('does not double the RAPID prefix when the caller already supplied it', async () => {
    // The RWS 2.0 builder takes the bare form, so the same resource object has
    // to survive both adapters.
    expect(await pathFor({ type: 'persvar', name: 'RAPID/T_ROB1/BASE/tool0' }))
      .toBe('/rw/rapid/symbol/data/RAPID/T_ROB1/BASE/tool0;value');
  });
});

describe('WsSubscriber - subscribe awaits the WebSocket open', () => {
  it('does not resolve before the WebSocket has opened', async () => {
    const { session } = makeFakeSession();
    const { FakeWs, state } = makeFakeWs('open');
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);

    const unsubscribe = await subscriber.subscribe(['execution'], () => undefined);

    expect(state.opened).toBe(true);
    await unsubscribe();
  });

  it('rejects when the WebSocket fails before opening', async () => {
    const { session } = makeFakeSession();
    const { FakeWs } = makeFakeWs('fail');
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);

    await expect(
      subscriber.subscribe(['execution'], () => undefined),
    ).rejects.toBeInstanceOf(RwsError);
  });

  it('deletes the registered subscription on the controller when the WebSocket fails', async () => {
    const { session, deletes } = makeFakeSession();
    const { FakeWs } = makeFakeWs('fail');
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);

    await subscriber.subscribe(['execution'], () => undefined).catch(() => undefined);

    // Must be a PATH: HttpSession prepends its base URL, so an absolute delete
    // URL would concatenate into garbage and the DELETE would silently fail,
    // leaking the controller-side registration.
    expect(deletes).toContain('/subscription/42');
  });
});

describe('WsSubscriber - reconnect give-up', () => {
  it('fires onLost exactly once when reconnect attempts are exhausted', async () => {
    const { session } = makeFakeSession();
    // First socket opens; every later construction fails before opening.
    const { FakeWs, instances } = makeScriptedWs(['open', 'fail']);
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);
    const onLost = vi.fn();

    await subscriber.subscribe(['execution'], () => undefined, {
      onLost,
      maxReconnectAttempts: 2,
      reconnectBaseMs: 5,
    });

    (instances[0] as { serverClose(): void }).serverClose();
    await until(() => onLost.mock.calls.length >= 1);

    expect(onLost).toHaveBeenCalledTimes(1);

    // Give-up is terminal: no further reconnect constructions after onLost.
    const countAtGiveUp = instances.length;
    await wait(100);
    expect(instances.length).toBe(countAtGiveUp);
  });
});

describe('WsSubscriber - poll-URL Location (live RW6.16 form)', () => {
  it('streams from the advertised poll path but DELETEs /subscription/{id}', async () => {
    // Live RW6.16 returns Location: ws://host:vcport/poll/{id}. The poll URL is
    // NOT a deletable resource (DELETE → 404); cleanup must target
    // /subscription/{id}. The WS must also reconnect via the configured
    // host:port, not the advertised authority.
    const { session, deletes } = makeFakeSession('ws://127.0.0.1:9999/poll/7');
    const { FakeWs, instances } = makeScriptedWs(['open']);
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);

    const unsubscribe = await subscriber.subscribe(['execution'], () => undefined);

    expect((instances[0] as { url: string }).url).toBe('ws://127.0.0.1:1/poll/7');
    await unsubscribe();
    expect(deletes).toContain('/subscription/7');
  });
});

describe('WsSubscriber - dead-registration recovery', () => {
  it('re-registers a fresh subscription when the stored poll URL is dead and resumes events', async () => {
    // Controller restarted: the old /subscription/42 registration is gone, so the
    // reconnect to its URL fails; the subscriber must POST a fresh registration
    // (Location → /subscription/99) and stream from the new URL.
    const { session, deletes, posts } = makeFakeSession([
      'http://127.0.0.1:1/subscription/42',
      'http://127.0.0.1:1/subscription/99',
    ]);
    const { FakeWs, instances } = makeScriptedWs(['open', 'fail', 'open']);
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);
    const received: string[] = [];

    await subscriber.subscribe(['execution'], e => { received.push(e.value); }, {
      reconnectBaseMs: 5,
    });

    (instances[0] as { serverClose(): void }).serverClose();
    await until(() => posts.count >= 2 && instances.length >= 3);

    expect(posts.count).toBe(2);
    expect(instances).toHaveLength(3);
    expect((instances[2] as { url: string }).url).toBe('ws://127.0.0.1:1/subscription/99');
    expect(deletes).toContain('/subscription/42');

    (instances[2] as { serverMessage(d: string): void }).serverMessage(
      '<li><a href="/rw/rapid/execution;ctrlexecstate">x</a><span>running</span></li>',
    );
    expect(received).toEqual(['running']);
  });
});

describe('WsSubscriber - onRestored', () => {
  it('fires onRestored after each successful reconnect, never on initial subscribe', async () => {
    const { session } = makeFakeSession();
    const { FakeWs, instances } = makeScriptedWs(['open']);
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);
    const onRestored = vi.fn();
    const onLost = vi.fn();

    await subscriber.subscribe(['execution'], () => undefined, {
      onRestored,
      onLost,
      reconnectBaseMs: 5,
    });
    expect(onRestored).not.toHaveBeenCalled();

    // First drop → reconnect succeeds → restored once
    (instances[0] as { serverClose(): void }).serverClose();
    await until(() => onRestored.mock.calls.length >= 1);
    expect(onRestored).toHaveBeenCalledTimes(1);

    // Second drop → reconnect succeeds again → restored twice.
    // Also proves the attempt budget was reset by the first successful reconnect.
    (instances[1] as { serverClose(): void }).serverClose();
    await until(() => onRestored.mock.calls.length >= 2);
    expect(onRestored).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe('WsSubscriber - a clean close the client did not ask for', () => {
  it('reconnects as after a drop, and gives up with onLost when it cannot; its own close does not reconnect', async () => {
    // Until 1.5.1 a close the controller started (a close frame, which the
    // ws package answers, so the event reads as clean) neither reconnected
    // nor fired onLost: the stream stopped and RobotManager stayed `live`.
    const { session } = makeFakeSession();
    const { FakeWs, instances } = makeScriptedWs(['open', 'open', 'fail']);
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);
    const onRestored = vi.fn();
    const onLost = vi.fn();

    const unsubscribe = await subscriber.subscribe(['execution'], () => undefined, {
      onRestored, onLost, reconnectBaseMs: 5, maxReconnectAttempts: 2,
    });
    (instances[0] as { serverCloseClean(): void }).serverCloseClean();
    await until(() => onRestored.mock.calls.length === 1);
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe(instances[0].url);

    // Every later open fails: after the attempts, onLost once.
    (instances[1] as { serverCloseClean(): void }).serverCloseClean();
    await until(() => onLost.mock.calls.length === 1);
    expect(onRestored).toHaveBeenCalledTimes(1);

    // The client's own close (the handle) is not a lost stream.
    const { FakeWs: OwnWs, instances: own } = makeScriptedWs(['open']);
    const other = new WsSubscriber(makeFakeSession().session, '127.0.0.1', 1, OwnWs);
    const stop = await other.subscribe(['execution'], () => undefined, { reconnectBaseMs: 5 });
    await stop();
    await wait(30);
    expect(own).toHaveLength(1);
    await unsubscribe();
  });
});

describe('WsSubscriber - backoff schedule', () => {
  it('doubles from the base and caps at the ceiling', async () => {
    const { backoffDelay } = await import('../src/WsSubscriber.js');
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(4)).toBe(16000);
    expect(backoffDelay(5)).toBe(30000);  // 32000 capped
    expect(backoffDelay(9)).toBe(30000);  // stays capped
    expect(backoffDelay(2, 5, 100)).toBe(20);
    expect(backoffDelay(6, 5, 100)).toBe(100);
  });
});

describe('WsSubscriber - unsubscribe during reconnect', () => {
  it('cancels a pending backoff timer so no further sockets are opened', async () => {
    const { session } = makeFakeSession();
    const { FakeWs, instances } = makeScriptedWs(['open', 'fail']);
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);

    const unsubscribe = await subscriber.subscribe(['execution'], () => undefined, {
      reconnectBaseMs: 30,
    });

    (instances[0] as { serverClose(): void }).serverClose();
    // Backoff timer (30 ms) is now pending; unsubscribe before it fires
    await unsubscribe();
    await wait(80);

    expect(instances).toHaveLength(1);
  });
});

describe('WsSubscriber - heartbeat', () => {
  it('terminates a half-open connection when pongs stop and recovers via reconnect', async () => {
    const { session } = makeFakeSession();
    // autoPong: false = frozen connection; pings go out, nothing comes back
    const { FakeWs, instances } = makeScriptedWs(['open'], { autoPong: false });
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);
    const onRestored = vi.fn();

    const unsubscribe = await subscriber.subscribe(['execution'], () => undefined, {
      onRestored,
      pingIntervalMs: 10,
      reconnectBaseMs: 5,
    });

    // Wait for the whole chain to land rather than for a fixed span: ping ->
    // pong timeout -> terminate -> reconnect -> onRestored.
    const first = instances[0] as { pings: number; terminated: boolean };
    await until(() =>
      first.pings > 0 && first.terminated
      && instances.length > 1 && onRestored.mock.calls.length > 0);

    expect(first.pings).toBeGreaterThan(0);
    expect(first.terminated).toBe(true);       // heartbeat killed the frozen socket
    expect(instances.length).toBeGreaterThan(1); // and the reconnect path ran
    expect(onRestored).toHaveBeenCalled();
    await unsubscribe();
  });

  it('keeps a healthy connection alive when pongs are answered', async () => {
    const { session } = makeFakeSession();
    const { FakeWs, instances } = makeScriptedWs(['open'], { autoPong: true });
    const subscriber = new WsSubscriber(session, '127.0.0.1', 1, FakeWs);

    const unsubscribe = await subscriber.subscribe(['execution'], () => undefined, {
      pingIntervalMs: 10,
    });

    const first = instances[0] as { pings: number; terminated: boolean };
    await until(() => first.pings >= 2);

    expect(first.pings).toBeGreaterThanOrEqual(2);
    expect(first.terminated).toBe(false);
    expect(instances).toHaveLength(1);
    await unsubscribe();
  });
});

describe('WsSubscriber - loading the ws package', () => {
  // Each test loads a fresh copy of the module, so the 'ws' constructor it keeps
  // after the first load does not carry over, and mocks 'ws' for that copy.
  // The fresh copy has its own RwsError class, so errors are checked by code.
  afterEach(() => {
    vi.doUnmock('ws');
    vi.resetModules();
  });

  it('a ws package that cannot be loaded fails the subscribe with UNSUPPORTED_OPERATION before anything is sent', async () => {
    // No socket can open in this process, so nothing is posted (no group
    // created and deleted again), and RobotManager does not try the
    // subscribe again on the connection, as it would after a NETWORK_ERROR.
    vi.resetModules();
    vi.doMock('ws', () => { throw new Error('Cannot find module ws'); });
    const { WsSubscriber: Fresh } = await import('../src/WsSubscriber.js');
    const { session, deletes, posts } = makeFakeSession();
    const subscriber = new Fresh(session, '127.0.0.1', 1);

    const err = await subscriber.subscribe(['execution'], () => undefined).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ name: 'RwsError', code: 'UNSUPPORTED_OPERATION' });
    expect(String((err as Error).message)).toContain('"ws" package');
    expect(posts.count).toBe(0);
    expect(deletes).toEqual([]);
  });

  it('loads ws once: a second subscription reuses the constructor', async () => {
    vi.resetModules();
    const loads = { count: 0 };
    const { FakeWs, captured } = makeFakeWs('open');
    vi.doMock('ws', () => { loads.count++; return { default: FakeWs, WebSocket: FakeWs }; });
    const { WsSubscriber: Fresh } = await import('../src/WsSubscriber.js');
    const { session } = makeFakeSession();
    const subscriber = new Fresh(session, '127.0.0.1', 1);

    const stop1 = await subscriber.subscribe(['execution'], () => undefined);
    const stop2 = await subscriber.subscribe(['speedratio'], () => undefined);
    expect(captured).toHaveLength(2);
    expect(captured[0].options.headers['Cookie']).toBe(COOKIE);
    expect(loads.count).toBe(1);
    await stop1();
    await stop2();
  });

  it('loads ws before the create: nothing is posted while it loads', async () => {
    vi.resetModules();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { FakeWs, captured } = makeFakeWs('open');
    vi.doMock('ws', async () => { await gate; return { default: FakeWs, WebSocket: FakeWs }; });
    const { WsSubscriber: Fresh } = await import('../src/WsSubscriber.js');
    const { session, posts } = makeFakeSession();
    const subscriber = new Fresh(session, '127.0.0.1', 1);

    const pending = subscriber.subscribe(['execution'], () => undefined);
    await wait(20);
    expect(posts.count).toBe(0);
    release();

    const stop = await pending;
    expect(posts.count).toBe(1);
    expect(captured).toHaveLength(1);
    await stop();
  });
});
