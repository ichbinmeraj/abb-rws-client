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
    await wait(200);

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
    await wait(100);

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
    await wait(50);
    expect(onRestored).toHaveBeenCalledTimes(1);

    // Second drop → reconnect succeeds again → restored twice.
    // Also proves the attempt budget was reset by the first successful reconnect.
    (instances[1] as { serverClose(): void }).serverClose();
    await wait(50);
    expect(onRestored).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
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

    await wait(80);

    const first = instances[0] as { pings: number; terminated: boolean };
    expect(first.pings).toBeGreaterThanOrEqual(2);
    expect(first.terminated).toBe(false);
    expect(instances).toHaveLength(1);
    await unsubscribe();
  });
});
