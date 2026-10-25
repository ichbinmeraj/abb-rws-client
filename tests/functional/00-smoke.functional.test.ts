/**
 * Functional smoke, per controller: the harness connects the lane's
 * RobotManager, the identity and state it reports match a direct read from
 * the controller, snapshot and restore change nothing on an untouched
 * controller, restore removes a ZZ_PROBE module loaded through the client,
 * the guard follows the lane, the wire trace is captured without
 * credentials, and a disconnect logs out and clears the manager's state.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers.
 */

import fs from 'node:fs';
import { it, expect } from 'vitest';
import {
  forEachController, diffSnapshots, laneForVersion, traceFile, waitUntil, zzDataModule, TEST_PASS,
  type TraceLine,
} from './helpers/index.js';

await forEachController('00-smoke', ctx => {
  it('connects to the controller it was classified as', async () => {
    const m = ctx.manager;
    expect(m.state.connected).toBe(true);
    expect(['live', 'polling']).toContain(m.state.quality);
    const info = m.state.systemInfo;
    expect(info).not.toBeNull();
    expect(info!.rwVersion).toBe(ctx.rwVersion);
    expect(laneForVersion(info!.rwVersion)).toBe(ctx.lane);
    expect(info!.name).toBe(ctx.systemName);
    expect(m.currentPort).toBe(ctx.port);
    expect(m.currentUseHttps).toBe(ctx.https);
  });

  it('reads panel, execution, tasks and joints, in agreement with a direct read', async () => {
    const m = ctx.manager;
    const panel = await ctx.panel();
    for (const v of [panel.opmode, panel.ctrlstate, panel.execstate]) { expect(typeof v).toBe('string'); }
    expect(typeof panel.speedRatio).toBe('number');
    // The manager's state comes from its own polls and subscription events;
    // on an idle controller it settles on what the observer reads.
    await waitUntil(() => m.state.opmode === panel.opmode
      && m.state.ctrlstate === panel.ctrlstate
      && m.state.speedRatio === panel.speedRatio
      && m.state.execstate === panel.execstate, 15000, 250, 'manager state equal to the observer read');

    expect(m.state.tasks.map(t => t.name)).toContain(ctx.task);
    expect(Object.keys(m.state.modulesByTask)).toContain(ctx.task);
    expect(m.state.mechunits).toContain(ctx.mechunit);
    const j = m.state.joints;
    expect(j).not.toBeNull();
    for (const v of Object.values(j!)) { expect(Number.isFinite(v)).toBe(true); }
  });

  it('snapshot and restore are a no-op on an untouched controller', async () => {
    const before = await ctx.snapshot();
    expect(before.errors).toEqual([]);
    expect(diffSnapshots(ctx.baseline, before)).toEqual([]);
    const report = await ctx.restore();
    expect(report.actions).toEqual([]);
    expect(report.residual).toEqual([]);
    expect(report.ok).toBe(true);
    const after = await ctx.snapshot();
    expect(diffSnapshots(before, after)).toEqual([]);
    // Idempotent: a second restore still has nothing to do.
    const again = await ctx.restore();
    expect(again.actions).toEqual([]);
    expect(again.ok).toBe(true);
  });

  it('restore unloads a ZZ_PROBE module loaded through the client and deletes its file', async () => {
    const mod = zzDataModule();
    const loaded = await ctx.loadModule(mod);
    const during = await ctx.snapshot();
    expect(during.modulesByTask[ctx.task]).toContain(mod.name);
    expect(during.probeEntries.map(e => e.path)).toContain(loaded.remotePath);
    expect(await ctx.manager.getRapidVariable(ctx.task, mod.name, mod.symbols.const)).toBe('42');

    const report = await ctx.restore();
    expect(report.residual).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.actions.map(a => a.step)).toEqual(expect.arrayContaining([
      `unload ${mod.name} from ${ctx.task}`, `delete ${loaded.remotePath}`,
    ]));
    const after = await ctx.snapshot();
    expect(after.modulesByTask[ctx.task]).not.toContain(mod.name);
    expect(after.probeEntries).toEqual([]);
    expect(diffSnapshots(ctx.baseline, after)).toEqual([]);
  });

  it('guard decisions follow the lane and its live state', async () => {
    const { ctrlstate } = await ctx.panel();
    const motion = await ctx.allowedNow('motion');
    if (ctx.lane === 'rw8') {
      expect(motion.ok).toBe(ctrlstate === 'motoron');
      if (!motion.ok) { expect(motion.reason).toBe('needs motors on from the RW8 pendant'); }
      expect(ctx.allowed('motors').ok).toBe(false);
      expect(ctx.allowed('opmode').ok).toBe(false);
      expect(ctx.allowed('motors-refusal').ok).toBe(true);
    } else {
      expect(motion.ok).toBe(true);
      expect(ctx.allowed('motors').ok).toBe(true);
      expect(ctx.allowed('opmode').ok).toBe(true);
    }
    for (const never of ['backup-restore', 'cfg-write', 'rmmp-request', 'safety-write'] as const) {
      expect(ctx.allowed(never).ok).toBe(false);
    }
    if (ctx.lane !== 'rw7') { expect(ctx.allowed('restart').ok).toBe(false); }
  });

  it('captures the wire trace of this lane without credentials', () => {
    const file = traceFile(ctx.lane);
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.trim().split('\n').map(l => JSON.parse(l) as TraceLine);
    expect(lines.some(l => l.cat === 'http.req' && l.file === '00-smoke')).toBe(true);
    expect(lines.some(l => l.cat === 'http.res' && l.file === '00-smoke')).toBe(true);
    // The whole lane trace, every file that ran before this one included. The
    // writer masks the password in every string and every object key, so it
    // must not occur anywhere; a hit names the file and message that held it.
    const holding = raw.trim().split('\n')
      .map((l, i) => ({ line: i + 1, l }))
      .filter(x => x.l.includes(TEST_PASS))
      .map(x => {
        const p = JSON.parse(x.l) as TraceLine;
        // The report names where, never what: the password stays masked in it.
        return `line ${x.line}: ${p.file ?? '-'} ${p.cat ?? p.level} ${p.msg}`.split(TEST_PASS).join('***').slice(0, 200);
      });
    expect(holding, 'trace lines holding the test password').toEqual([]);
    expect(raw).not.toMatch(/Basic [A-Za-z0-9+/=]{6,}/);
    expect(raw).not.toMatch(/-http-session-=[^*]/);
  });

  it('disconnect logs out and clears the state; a reconnect works', async () => {
    const m = ctx.manager;
    await m.disconnect();
    expect(m.state.connected).toBe(false);
    expect(m.state.quality).toBe('disconnected');
    expect(m.state.systemInfo).toBeNull();
    const again = await ctx.reconnect();
    expect(again).toBe(m);
    expect(m.state.connected).toBe(true);
    await waitUntil(() => m.state.systemInfo?.rwVersion === ctx.rwVersion, 20000, 250, 'system info after reconnect');
  });
});
