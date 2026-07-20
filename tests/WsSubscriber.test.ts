import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { WsSubscriber } from '../src/WsSubscriber.js';
import { RwsError } from '../src/types.js';
import type { HttpSession } from '../src/HttpSession.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const COOKIE = 'ABBCX=abc123; -http-session-=xyz789';
const LOCATION = 'http://127.0.0.1:1/subscription/42';

/** Minimal HttpSession stand-in: POST /subscription → 201 + Location, records DELETEs */
function makeFakeSession(location = LOCATION): { session: HttpSession; deletes: string[] } {
  const deletes: string[] = [];
  const session = {
    post: async () => ({
      status: 201,
      body: '',
      headers: new Headers({ location }),
    }),
    delete: async (url: string) => {
      deletes.push(url);
      return { status: 200, body: '', headers: new Headers() };
    },
    getCookieHeader: () => COOKIE,
  } as unknown as HttpSession;
  return { session, deletes };
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

    expect(deletes).toContain(LOCATION);
  });
});
