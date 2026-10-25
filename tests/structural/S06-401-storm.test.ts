/**
 * S06 - 401 storm / credentials changed mid-session: the live half.
 *
 * The failure this cell exists to prevent is a client that answers a credential
 * rejection by asking again, forever. A 401 is a statement about the caller, not
 * about the network, so nothing about repeating the request can change the
 * answer.
 *
 * The storm itself (every request refused, credentials revoked mid-session,
 * RobotManager ending disconnected, a WebSocket upgrade refused) runs against
 * a mock controller in tests/structural/S06-401-storm.mock.test.ts: revoking a
 * VC's credentials is a UAS change, which this suite never makes, and the
 * number of requests a client spends is only observable server-side. That file
 * needs no controller and runs in plain `npm test` too; the runner maps both
 * files onto the same cells.
 *
 * This half pins the typing to the real controllers: a wrong password on a
 * real VC must produce the same AUTH_FAILED the mock produces, and nothing
 * may keep trying afterwards. It is deliberately one attempt per generation:
 * a rejected credential mints no session, and one attempt keeps load off the
 * VC's auth path.
 */

import { it, expect, afterEach } from 'vitest';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import { RwsClient } from '../../src/RwsClient.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import { cell, expectRwsError, type AnyClient } from '../helpers/structuralHarness.js';
import { TEST_USER } from '../helpers/liveControllers.js';
import { settledCount } from '../helpers/faultChecks.js';

/** Never a real credential on either VC - the live half must be refused. */
const WRONG_PASS = 'not-the-password-9f31c7';

interface Connectable { connect(): Promise<void>; disconnect(): Promise<void> }

// ─── Cell, live half ─────────────────────────────────────────────────────────

interface OpenResource {
  proxy?: ChaosProxy;
  client?: AnyClient;
}

const open: OpenResource[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await (o.client as { disconnect?: () => Promise<void> } | undefined)
      ?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S06-401-storm', generation, ctx => {
    it('the live controller refuses a wrong password with a typed AUTH_FAILED', async () => {
      const controller = await ctx.controller();
      const proxy = await ctx.proxy();
      // Not ctx.client(): the harness always builds the working credentials.
      // TLS (RWS 2.0) passes through the TCP proxy untouched, so the scheme
      // follows the REAL controller, not the proxy hop.
      const client: AnyClient = generation === 'rws1'
        ? new RwsClient({
          host: '127.0.0.1', port: proxy.port,
          username: TEST_USER, password: WRONG_PASS, timeout: 8000,
        })
        : new RwsClient2(
          `${controller.tls ? 'https' : 'http'}://127.0.0.1:${proxy.port}`,
          TEST_USER, WRONG_PASS, { timeout: 8000 },
        );
      open.push({ proxy, client });

      // ONE attempt. A rejected credential mints no session, and one attempt
      // per generation keeps load off the VC's auth path.
      const err = await expectRwsError(() => (client as unknown as Connectable).connect());
      expect(err.code).toBe('AUTH_FAILED');
      expect(err.httpStatus).toBe(401);

      // Server-side proof that nothing keeps trying. Bytes, not requests: the
      // chaos proxy is a TCP hop and cannot count HTTP messages - but a client
      // retrying in the background still has to put bytes on the wire.
      const settled = await settledCount(
        () => proxy.stats().bytesUp, 1500, 25000, 'bytes sent to the controller',
      );
      expect(settled).toBe(proxy.stats().bytesUp);
      // Weak but real: keep-alive means a retry loop could reuse one socket, so
      // the flatness check above carries the argument. A client that opened a
      // fresh connection per retry would blow through this.
      expect(proxy.stats().connectionsTotal,
        'a wrong password opened an implausible number of connections')
        .toBeLessThanOrEqual(4);

      await expect((client as unknown as Connectable).disconnect()).resolves.toBeUndefined();
    }, 60000);
  });
}
