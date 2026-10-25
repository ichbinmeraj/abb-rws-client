import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpSession } from '../src/HttpSession.js';
import { WsSubscriber } from '../src/WsSubscriber.js';

// RWS 1.0: the group create (POST /subscription) gets 5 s on top of the
// session's timeout, and no other request does. On RW 6.16.03 the create is
// the slowest request a connection sends (0.8 s at the median, 18 ms for the
// rest), no answer to it came within the 5 s timeout in a connect of three
// controllers at once (2026-10-25), and a create the client gives up on may
// still leave a group on the controller. Here the session's timeout is 100 ms
// and the controller answers every request after 300 ms.

/** A WebSocket that opens at once (the subscriber's ws-style constructor). */
class OpeningWs {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { wasClean?: boolean }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  close(): void { this.onclose?.({ wasClean: true }); }
}

describe('RWS 1.0 subscription create timeout', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function slowController(answerAfterMs: number): Promise<{ port: number; seen: string[] }> {
    const seen: string[] = [];
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      setTimeout(() => {
        if (req.method === 'POST' && req.url === '/subscription') {
          res.writeHead(201, { Location: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/poll/7` });
          res.end('');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/xhtml+xml' });
          res.end('<html/>');
        }
      }, answerAfterMs);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  it('the create waits 5 s longer than the session\'s timeout; other requests keep it', async () => {
    const { port, seen } = await slowController(300);
    const session = new HttpSession({
      baseUrl: `http://127.0.0.1:${port}`, username: 'u', password: 'p', requestIntervalMs: 0, timeoutMs: 100,
    });

    await expect(session.get('/rw/panel/ctrlstate')).rejects.toThrow('Request timed out after 100ms: GET /rw/panel/ctrlstate');
    await expect(session.post('/rw/panel/speedratio', 'speed-ratio=50')).rejects.toThrow('Request timed out after 100ms: POST /rw/panel/speedratio');

    const post = vi.spyOn(session, 'post');
    const subscriber = new WsSubscriber(session, '127.0.0.1', port, OpeningWs as never);
    const stop = await subscriber.subscribe(['execution'], () => {});
    expect(seen).toContain('POST /subscription');
    // Exactly 5 s more for the create, as HttpSession's holdMs.
    expect(post.mock.calls).toEqual([['/subscription', 'resources=1&1=/rw/rapid/execution;ctrlexecstate&1-p=1', 5000]]);
    await stop();
    expect(seen.at(-1)).toBe('DELETE /subscription/7');
  });
});
