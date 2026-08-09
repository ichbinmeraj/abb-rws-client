/**
 * S01 - Connection drop mid-request.
 *
 * A network blip while a request is in flight must surface as a TYPED RwsError,
 * never as a raw socket error or an unhandled rejection, and must leave the
 * client usable afterwards. The mastership variant additionally proves the hold
 * does not get stuck: a drop while holding write access must still allow a
 * later acquire.
 */

import { it, expect, afterEach } from 'vitest';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import {
  cell, expectRwsError, until, assertQualityHonest, type AnyClient,
} from '../helpers/structuralHarness.js';

const open: Array<{ proxy?: ChaosProxy; client?: AnyClient; manager?: RobotManager }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> })?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
});

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S01-drop-midrequest', generation, ctx => {
    it('a plain GET dropped mid-flight throws a typed RwsError, not a socket error', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: 8000 });
      open.push({ proxy, client });

      await (client as { connect: () => Promise<void> }).connect();
      // Sanity: the path works before the fault, so a failure below is the fault.
      await expect(
        (client as { getControllerState: () => Promise<string> }).getControllerState(),
      ).resolves.toBeTruthy();

      // Cut the connection PART-WAY THROUGH the response rather than calling
      // dropAll() and hoping. The client paces requests (55 ms queue), so a
      // synchronous dropAll() after starting the promise usually kills an idle
      // keep-alive socket before the request is even written - the client then
      // opens a fresh connection and succeeds, which tests nothing. Truncating
      // the response body and destroying the socket reproduces the real fault:
      // headers started, body never finished.
      proxy.setCorruption({ kind: 'truncate-and-drop', afterBytes: 20 });

      const err = await expectRwsError(
        () => (client as { getControllerState: () => Promise<string> }).getControllerState(),
      );
      expect(err.code).toBeTruthy();
      expect(typeof err.code).toBe('string');

      // …and the client is still usable once the network is healthy again.
      proxy.setCorruption({ kind: 'none' });
      await until(async () => {
        try {
          await (client as { getControllerState: () => Promise<string> }).getControllerState();
          return true;
        } catch { return false; }
      }, 20000, 'client recovers after the drop');
    }, 60000);

    it('a drop while holding write access does not strand the hold', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: 8000 });
      open.push({ proxy, client });

      const c = client as unknown as {
        connect(): Promise<void>;
        requestMastership(d: string): Promise<void>;
        releaseMastership(d: string): Promise<void>;
      };
      await c.connect();
      await c.requestMastership('motion');

      proxy.dropAll();

      // Releasing over a dead connection may fail - that is allowed. What is NOT
      // allowed is being unable to acquire again afterwards, which would mean the
      // controller still believes we hold it.
      await c.releaseMastership('motion').catch(() => undefined);

      await until(async () => {
        try { await c.requestMastership('motion'); return true; }
        catch { return false; }
      }, 25000, 'write access is re-acquirable after a drop');
      await c.releaseMastership('motion').catch(() => undefined);
    }, 60000);

    it('quality stops claiming "live" when the connection drops (S14 cross-cutting)', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 300 });
      open.push({ proxy, manager });

      await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
        20000, 'manager reaches a steady quality');

      proxy.refuseNew(true);
      proxy.dropAll();

      // With the port blocked, polls fail; quality must degrade and explain itself.
      await until(() => manager.state.quality !== 'live', 25000, 'quality leaves "live"');
      assertQualityHonest(manager, { notLive: true });

      proxy.refuseNew(false);
    }, 60000);
  });
}
