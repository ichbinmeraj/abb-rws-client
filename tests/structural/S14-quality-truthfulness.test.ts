/**
 * S14 - ConnectionQuality truthfulness.
 *
 * The task brief calls this "a cross-cutting assertion, not a separate run", and
 * the other cells do assert it inline via assertQualityHonest(). This file adds
 * the part that only a dedicated cell can prove: that quality tracks reality
 * across a FULL fault cycle - healthy, broken, healthy again - and that it never
 * lies in either direction.
 *
 * Two lies matter, and they are not symmetric:
 *   - claiming `live` while the stream is down makes a consumer trust stale data;
 *   - claiming `disconnected` while requests still succeed makes a consumer tear
 *     down a working connection.
 * Both are asserted, plus the rule that every state carries a reason a human can
 * read - a quality value with an empty reason is untriageable in the field.
 */

import { it, expect, afterEach } from 'vitest';
import type { ChaosProxy } from '../helpers/chaosProxy.js';
import type { RobotManager } from '../../src/RobotManager.js';
import type { ConnectionQuality } from '../../src/types.js';
import { cell, until } from '../helpers/structuralHarness.js';

const open: Array<{ proxy?: ChaosProxy; manager?: RobotManager }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.manager?.disconnect().catch(() => undefined);
    await o.proxy?.close();
  }
});

/** Every value the type allows - a state outside this set is a bug by itself. */
const VALID: ConnectionQuality[] = ['live', 'polling', 'reconnecting', 'stale', 'disconnected'];

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S14-quality-truthfulness', generation, ctx => {
    it('every observed quality is a declared state and carries a reason', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 250 });
      open.push({ proxy, manager });

      const seen: Array<{ q: ConnectionQuality; reason: string }> = [];
      const record = (): void => {
        const q = manager.state.quality;
        const reason = manager.state.qualityReason ?? '';
        if (!seen.length || seen[seen.length - 1].q !== q) { seen.push({ q, reason }); }
      };

      const ticker = setInterval(record, 40);
      try {
        record();
        await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
          20000, 'steady state reached');

        // Break it.
        proxy.refuseNew(true);
        proxy.dropAll();
        await until(() => manager.state.quality !== 'live' && manager.state.quality !== 'polling',
          25000, 'quality degrades');

        // Heal it.
        proxy.refuseNew(false);
        await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling'
          || manager.state.quality === 'disconnected',
          30000, 'quality settles after recovery');
      } finally {
        clearInterval(ticker);
      }

      expect(seen.length).toBeGreaterThan(1);
      for (const s of seen) {
        expect(VALID, `unknown quality ${s.q}`).toContain(s.q);
        // An empty reason is the failure mode that makes field triage impossible.
        expect(s.reason.trim(), `quality "${s.q}" carried no reason`).not.toBe('');
      }
    }, 90000);

    it('never claims "live" while the transport is blocked', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 250 });
      open.push({ proxy, manager });

      await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
        20000, 'steady state reached');

      proxy.refuseNew(true);
      proxy.dropAll();
      await until(() => manager.state.quality !== 'live', 25000, 'quality leaves live');

      // Hold the fault and keep checking: a single transition is not enough - the
      // claim must stay false for as long as the transport is actually down.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        expect(manager.state.quality, 'claimed live while the port was blocked').not.toBe('live');
        await new Promise(r => setTimeout(r, 100));
      }
      proxy.refuseNew(false);
    }, 90000);

    it('never claims "disconnected" while requests are still succeeding', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 250 });
      open.push({ proxy, manager });

      await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
        20000, 'steady state reached');

      // Degrade the link without breaking it: slow, but every request still lands.
      proxy.setLatency(120);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (manager.state.quality === 'disconnected') {
          // Only a real failure justifies this state - prove requests are failing.
          await expect(
            manager.getControllerState(),
          ).rejects.toBeTruthy();
        }
        await new Promise(r => setTimeout(r, 150));
      }
      proxy.setLatency(0);
    }, 90000);
  });
}
