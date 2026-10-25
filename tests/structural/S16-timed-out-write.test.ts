/**
 * S16 - A write whose answer never arrives, then the read-back.
 *
 * The request reaches the controller; the answer does not reach the client
 * (the chaos proxy cuts the response after its first byte and drops the
 * connection). From the client's side that is a timed-out write: it cannot
 * know whether the controller applied it. The failure mode this cell exists
 * to prevent is a client that takes "no answer" for "not done" (or for
 * "done") and acts on that guess, or that leaves the session's access in a
 * state its own bookkeeping no longer matches.
 *
 * Three properties, per the matrix:
 *   - the write surfaces as a typed RwsError (NETWORK_ERROR), never an
 *     uncaught throw, and the client says nothing about the value;
 *   - the read-back decides: once the network is healthy, a read of the same
 *     resource through the same client reports what the controller holds (the
 *     new value when the write was applied, the old one when it was not), and
 *     the cell records which;
 *   - the session's access is not stranded: the next write through the same
 *     client succeeds, which means any mastership or write access the lost
 *     write held was released, re-acquirable or read back
 *     (AccessManager: a request that did not answer is read back once; a
 *     release that did not go through leaves the lock `uncertain`, never
 *     `held`).
 *
 * The write is the speed ratio: AUTO-only on every generation, reversible,
 * and read back with one GET. The cell restores the value it found.
 *
 * WHY A PROXY, NOT A MOCK. A mock could script "answer lost", but only a real
 * controller decides whether a request whose answer was cut was applied; that
 * is the thing read back. So the cell is live-only, through the chaos proxy in
 * front of the VC (`truncate-and-drop`, as S01 cuts a GET). Nothing here can
 * drive the controller past a speed change.
 */

import { it, expect, afterEach } from 'vitest';
import { RwsError } from '../../src/types.js';
import { accessOf } from '../../src/access/AccessManager.js';
import { cell, expectRwsError, until, type AnyClient } from '../helpers/structuralHarness.js';
import type { ChaosProxy } from '../helpers/chaosProxy.js';

interface SpeedClient {
  connect(): Promise<void>;
  getSpeedRatio(): Promise<number>;
  setSpeedRatio(ratio: number): Promise<void>;
  getOperationMode(): Promise<string>;
}

const open: Array<{ proxy: ChaosProxy; client?: AnyClient }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await (o.client as { disconnect?: () => Promise<void> } | undefined)?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
});

/** A speed value that differs from `current` and is a legal ratio. */
const other = (current: number): number => (current === 50 ? 40 : 50);

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S16-timed-out-write', generation, ctx => {
    it('a write whose answer is cut throws a typed RwsError, and the read-back decides what the controller holds', async () => {
      const proxy = await ctx.proxy();
      const client = await ctx.client(proxy, { timeout: 8000 });
      open.push({ proxy, client });
      const c = client as unknown as SpeedClient;
      await c.connect();

      // Speed ratio writes are AUTO-only on every generation; outside AUTO
      // the controller refuses and the cell would test the refusal, not the
      // lost answer.
      const mode = await c.getOperationMode();
      if (!/auto/i.test(mode)) { throw new Error(`S16 needs AUTO (the VC is in ${mode})`); }

      const before = await c.getSpeedRatio();
      const target = other(before);

      // The request reaches the controller in full; the answer is cut after its
      // first byte and the connection dropped, so the client never learns the
      // outcome. The corruption is set right before the write and lifted right
      // after, so the read-back below travels on a healthy connection.
      proxy.setCorruption({ kind: 'truncate-and-drop', afterBytes: 1 });
      const err = await expectRwsError(() => c.setSpeedRatio(target));
      proxy.setCorruption({ kind: 'none' });
      expect(err).toBeInstanceOf(RwsError);
      expect(err.code).toBe('NETWORK_ERROR');

      // The read-back is the only thing that says what happened.
      let after = before;
      await until(async () => {
        try { after = await c.getSpeedRatio(); return true; } catch { return false; }
      }, 20000, 'the speed ratio can be read again');
      expect([before, target]).toContain(after);
      // eslint-disable-next-line no-console
      console.log(`S16/${generation}: write of ${target} with the answer cut - the controller holds ${after} (${after === target ? 'applied' : 'not applied'})`);

      // Nothing is stranded: the client counts no hold, and the next write
      // through the same session goes through.
      const access = accessOf(client);
      if (access) {
        for (const lock of access.snapshot().locks) { expect(lock.state).not.toBe('held'); }
      }
      await c.setSpeedRatio(before);
      expect(await c.getSpeedRatio()).toBe(before);
    }, 60000);
  });
}
