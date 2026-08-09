/**
 * S07 - Mastership / write-access conflict.
 *
 * Write access on a controller is exclusive, so the interesting question is what
 * the SECOND client sees. It must be a TYPED MASTERSHIP_REQUIRED carrying the
 * controller's own status code - not a raw 403, not AUTH_FAILED, not UNKNOWN -
 * because that code is the only thing a consumer can branch on to say "someone
 * else holds write access, release it there and retry". The cell then proves the
 * two recovery paths: an explicit release by the holder, and a holder that just
 * disappears (disconnect without release).
 *
 * Generation differences this cell has to straddle:
 *   - RWS 1.0 (IRC5) and RWS 2.0 on RobotWare 7 both use /rw/mastership, and the
 *     conflict body carries -1073445862 "Requested resource is held by someone
 *     else" -> MASTERSHIP_REQUIRED.
 *   - RobotWare 8 REMOVED mastership (/rw/mastership answers 410 GONE) and moved
 *     write access to the Control Station Service. RwsClient2.requestMastership
 *     routes there automatically, and the refusal is a control-station SPoC
 *     conflict whose native code lands on GRANT_DENIED rather than
 *     MASTERSHIP_REQUIRED. The matrix property for that path is the weaker but
 *     still strict "typed, not a raw 403", so the assertion branches on the
 *     RobotWare major - it is not loosened for RW7/RW6.
 *
 * Not a conflict, and deliberately not asserted on: on RW8 any write clears
 * control-station write access as a side effect, so the release afterwards is
 * refused with 403 "The control station does not have SPoC" and the client
 * swallows it on purpose. These tests never write between acquire and release,
 * and never read getWriteAccessStatus().held as a "can I write" signal.
 *
 * Every acquire is paired with a release in a finally: a stranded hold blocks
 * every other client on the VC until the controller times the session out.
 */

import { it, expect, afterEach } from 'vitest';
import { startChaosProxy, type ChaosProxy } from '../helpers/chaosProxy.js';
import { discoverControllers, TEST_USER, TEST_PASS } from '../helpers/liveControllers.js';
import type { RobotManager } from '../../src/RobotManager.js';
import { RwsClient2 } from '../../src/RwsClient2.js';
import {
  cell, expectRwsError, until, assertQualityHonest, type AnyClient, type RwsError,
} from '../helpers/structuralHarness.js';

/** The structural surface both generations share, without a union cast per call. */
interface WriteAccessClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  requestMastership(domain: 'cfg' | 'motion' | 'rapid'): Promise<void>;
  releaseMastership(domain: 'cfg' | 'motion' | 'rapid'): Promise<void>;
  getControllerState(): Promise<string>;
}

const asWriteClient = (c: AnyClient): WriteAccessClient => c as unknown as WriteAccessClient;

/**
 * 'motion' rather than 'rapid'/'cfg': it is valid on both generations (RWS 2.0
 * folds cfg+rapid into 'edit' but keeps 'motion'), and holding it touches
 * nothing RAPID-related, so a stranded hold could not affect program execution.
 */
const DOMAIN = 'motion' as const;

/**
 * Back-off inside `until` predicates that retry a controller request. `until`
 * polls every 25 ms; retrying an acquire that fast would push this suite past
 * the <20 req/s ceiling the controller enforces with 503s, and the point of a
 * retry here is to wait out the other side, not to hammer the session pool.
 */
const RETRY_BACKOFF_MS = 500;
const backoff = (): Promise<void> => new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));

/**
 * The refusal assertion every conflict site in this cell shares.
 *
 * RW6/RW7 must land EXACTLY on MASTERSHIP_REQUIRED. Only the RW8
 * control-station path gets the weaker form the matrix asks for there ("typed,
 * not a raw 403"), and even that is a two-code allow-list, not "any error".
 *
 * The controllerCode check is what makes "not a raw 403" mean something: it
 * proves the code was derived from the controller's own status block. A 403
 * that arrives with no status block is classified by HTTP fallback, which is
 * exactly the failure this guards - and the only thing left in a false-green
 * world if the code allow-list ever has to grow.
 */
function expectConflict(err: RwsError, viaControlStation: boolean): void {
  if (viaControlStation) { expect(['MASTERSHIP_REQUIRED', 'GRANT_DENIED']).toContain(err.code); }
  else { expect(err.code).toBe('MASTERSHIP_REQUIRED'); }
  expect(typeof err.controllerCode).toBe('number');
  expect(err.httpStatus).toBeGreaterThanOrEqual(400);
  expect(err.httpStatus).toBeLessThan(500);
  expect(err.code).not.toBe('AUTH_FAILED');
  expect(err.code).not.toBe('UNKNOWN');
  expect(err.message.trim()).not.toBe('');
}

/**
 * Poll `acquire` until it succeeds, then hand the hold straight back.
 *
 * Wrapping `until` instead of inlining a try/catch keeps the swallowed
 * controller errors: a bare "condition not met" cannot tell a stuck hold from a
 * dead session, and a 60 s live run is expensive to repeat just to find out
 * which one it was.
 */
async function reacquires(
  acquire: () => Promise<void>, release: () => Promise<void>,
  timeoutMs: number, label: string,
): Promise<void> {
  const refusals: unknown[] = [];
  try {
    await until(async () => {
      try { await acquire(); return true; }
      catch (e) { refusals.push(e); await backoff(); return false; }
    }, timeoutMs, label);
  } catch (e) {
    const last = refusals[refusals.length - 1];
    const why = last instanceof Error ? `${last.name}: ${last.message}` : String(last);
    throw new Error(
      `${e instanceof Error ? e.message : String(e)} `
      + `- ${refusals.length} refusal(s), last: ${why}`,
    );
  }
  await release().catch(() => undefined);
}

const open: Array<{ proxy?: ChaosProxy; client?: AnyClient; manager?: RobotManager }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.manager?.disconnect().catch(() => undefined);
    await (o.client as { disconnect?: () => Promise<void> })?.disconnect?.().catch(() => undefined);
    await o.proxy?.close();
  }
});

/** RobotWare major behind a connected RwsClient2; 0 when it cannot be read. */
async function robotWareMajor(client: AnyClient): Promise<number> {
  if (!(client instanceof RwsClient2)) { return 0; }
  const raw = await client.getRobotWareVersion().catch(() => '');
  const major = Number(raw.split('.')[0]);
  return Number.isFinite(major) ? major : 0;
}

for (const generation of ['rws1', 'rws2'] as const) {
  cell('S07-mastership-conflict', generation, ctx => {
    it('a second client is refused with a typed MASTERSHIP_REQUIRED, and gets it once the holder releases', async () => {
      const proxy = await ctx.proxy();
      const clientA = await ctx.client(proxy, { timeout: 8000 });
      const clientB = await ctx.client(proxy, { timeout: 8000 });
      // Clients first, proxy last: afterEach drains in order, so both /logout
      // calls still have a route when they run.
      open.push({ client: clientA }, { client: clientB }, { proxy });

      const a = asWriteClient(clientA);
      const b = asWriteClient(clientB);
      await a.connect();
      await b.connect();

      // Sanity: B has a working session of its own before the conflict, so a
      // failure below is the conflict and not a broken second client. Both
      // clients authenticate as the same user - mastership is scoped to the
      // SESSION, not the user, which is exactly what this asserts.
      await expect(b.getControllerState()).resolves.toBeTruthy();

      const major = await robotWareMajor(clientA);
      const viaControlStation = major >= 8;

      await a.requestMastership(DOMAIN);
      try {
        // On RW8 the refusal comes from the Control Station Service ("Remote
        // Control Station cannot take SPoC when it is taken"), whose native
        // code is in the grant family - see expectConflict for why that path,
        // and only that path, is allowed the two-code form.
        expectConflict(await expectRwsError(() => b.requestMastership(DOMAIN)), viaControlStation);
      } finally {
        await a.releaseMastership(DOMAIN).catch(() => undefined);
      }

      // Recovery: with A's hold gone, B must be able to take it.
      await reacquires(
        () => b.requestMastership(DOMAIN), () => b.releaseMastership(DOMAIN),
        20000, 'B acquires write access after A released it',
      );
    }, 60000);

    it('a holder that disconnects without releasing does not strand write access', async () => {
      const proxy = await ctx.proxy();
      const clientA = await ctx.client(proxy, { timeout: 8000 });
      const clientB = await ctx.client(proxy, { timeout: 8000 });
      open.push({ client: clientA }, { client: clientB }, { proxy });

      const a = asWriteClient(clientA);
      const b = asWriteClient(clientB);
      await a.connect();
      await b.connect();

      const viaControlStation = (await robotWareMajor(clientA)) >= 8;

      await a.requestMastership(DOMAIN);

      // Prove the hold is REAL and exclusive BEFORE taking it away. Without
      // this the test is a tautology: if requestMastership silently did
      // nothing - wrong domain, a 200 on a no-op path, a swallowed refusal -
      // B would acquire happily after the disconnect and the cell would go
      // green having proved that no release ever has to happen.
      expectConflict(await expectRwsError(() => b.requestMastership(DOMAIN)), viaControlStation);

      // No releaseMastership here on purpose. disconnect() is the only cleanup:
      // RWS 1.0 and RW7 rely on GET /logout dropping mastership server-side,
      // while RW8 does NOT drop control-station write access with the session -
      // RwsClient2.disconnect() has to release it explicitly first. Either way,
      // the observable contract is the same: B can take it afterwards.
      await a.disconnect();

      await reacquires(
        () => b.requestMastership(DOMAIN), () => b.releaseMastership(DOMAIN),
        25000, 'write access is acquirable after the holder disconnected without releasing',
      );
    }, 60000);

    if (generation === 'rws2') {
      it('RW8 control-station conflict surfaces a typed error, not a raw 403', async t => {
        // The harness hands out the FIRST rws2 controller it discovers, which on
        // this rig is normally the RW7 VC - and RW7 has no Control Station
        // Service (those paths 404). So this test looks for an RW8 controller
        // specifically. When none is running the RW8 property is not asserted;
        // it is skipped rather than faked, and reported as conditional.
        let proxy: ChaosProxy | null = null;
        let baseUrl = '';
        for (const c of (await discoverControllers()).filter(x => x.generation === 'rws2')) {
          const p = await startChaosProxy(c.host, c.port);
          const url = `${c.tls ? 'https' : 'http'}://127.0.0.1:${p.port}`;
          const probeClient = new RwsClient2(url, TEST_USER, TEST_PASS, { timeout: 8000 });
          let major = 0;
          try {
            await probeClient.connect();
            major = await robotWareMajor(probeClient);
          } catch { major = 0; }
          await probeClient.disconnect().catch(() => undefined);
          if (major >= 8) { proxy = p; baseUrl = url; break; }
          await p.close();
        }
        if (!proxy) { t.skip(); return; }

        // Fixed control-station ids (braced GUIDs - other forms are rejected).
        // Registration is session-scoped, so if a run ever died holding SPoC the
        // only way back is to register the SAME id again and release; a random
        // per-instance id would make that impossible.
        const mk = (id: string): RwsClient2 => new RwsClient2(baseUrl, TEST_USER, TEST_PASS, {
          timeout: 8000,
          controlStation: { name: 'abb-rws-client-structural', id, pincode: '1234' },
        });
        const a = mk('{07000000-0000-4000-8000-000000000001}');
        const b = mk('{07000000-0000-4000-8000-000000000002}');
        open.push({ client: a }, { client: b }, { proxy });

        await a.connect();
        await b.connect();

        await a.requestWriteAccess();
        try {
          expectConflict(await expectRwsError(() => b.requestWriteAccess()), true);
        } finally {
          // A held write access and performed no write, so this release is the
          // clean 204 path - the swallowed "does not have SPoC" refusal only
          // happens after a write, and is not what this cell is about.
          await a.releaseWriteAccess().catch(() => undefined);
        }

        await reacquires(
          () => b.requestWriteAccess(), () => b.releaseWriteAccess(),
          20000, 'B takes control-station write access after A released it',
        );
      }, 120000);
    }

    it('quality stays truthful while only WRITE access is contended (S14 cross-cutting)', async () => {
      const proxy = await ctx.proxy();
      const manager = await ctx.manager(proxy, { refreshIntervalMs: 300 });
      const holderClient = await ctx.client(proxy, { timeout: 8000 });
      const probeClient = await ctx.client(proxy, { timeout: 8000 });
      // Clients before the proxy: afterEach drains in push order, so every
      // /logout still has a route. A client left connected past the proxy's
      // close keeps its session on the controller until the idle timeout.
      open.push({ manager }, { client: holderClient }, { client: probeClient }, { proxy });

      await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
        20000, 'manager reaches a steady quality');

      const holder = asWriteClient(holderClient);
      await holder.connect();
      await holder.requestMastership(DOMAIN);
      try {
        // The contention has to be REAL, or this degrades into "quality is
        // honest while nothing at all is happening" - which is S14's job, not
        // this cell's. A third session that is actually refused is the proof.
        const probe = asWriteClient(probeClient);
        await probe.connect();
        expectConflict(
          await expectRwsError(() => probe.requestMastership(DOMAIN)),
          (await robotWareMajor(holderClient)) >= 8,
        );

        // Someone else holding write access says nothing about the link: reads
        // keep working, so quality must not degrade and must never claim
        // "disconnected" while polls succeed.
        await manager.refresh();
        expect(manager.state.connected).toBe(true);
        await until(() => manager.state.quality === 'live' || manager.state.quality === 'polling',
          15000, 'quality stays live/polling while write access is held elsewhere');
        assertQualityHonest(manager, { notDisconnected: true });
      } finally {
        await holder.releaseMastership(DOMAIN).catch(() => undefined);
      }

      // …and the reason is still populated after the contention clears.
      assertQualityHonest(manager, { notDisconnected: true });
    }, 60000);
  });
}
