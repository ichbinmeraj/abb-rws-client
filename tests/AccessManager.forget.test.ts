import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessManager, type AccessDriver, type AccessEvent, type AccessLock, type AccessObservation } from '../src/access/AccessManager.js';
import { RobotManager } from '../src/RobotManager.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { setLogger } from '../src/Logger.js';
import type { MastershipDomain } from '../src/types.js';

/**
 * A hold the controller ends itself (an accepted warm restart) is forgotten
 * without a wire release. Forgetting the last hold on a lock now emits
 * `released` with `alreadyCleared: true`, so RobotManager's
 * `RobotState.access` follows at once. Seen 2026-09-30 on RW 7.21.4 (the
 * functional suite's restart test): after an accepted restart the manager
 * still reported edit mastership held, and a consumer then sent a needless
 * release on the new session.
 */

function rw7Driver(wire: string[]): AccessDriver {
  return {
    label: 'TEST',
    locks: (): readonly AccessLock[] => ['edit', 'motion'],
    lockOf: (d: MastershipDomain): AccessLock => (d === 'motion' ? 'motion' : 'edit'),
    domainOf: (l: AccessLock): MastershipDomain => (l === 'motion' ? 'motion' : 'rapid'),
    request: async (l: AccessLock) => { wire.push(`request ${l}`); },
    release: async (l: AccessLock) => { wire.push(`release ${l}`); },
  };
}

function setup() {
  const wire: string[] = [];
  const events: AccessObservation[] = [];
  const m = new AccessManager(rw7Driver(wire));
  m.on(e => events.push(e));
  return { m, wire, events };
}

afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

describe('AccessManager.forget', () => {
  it('an accepted restart: the last hold ends with released (alreadyCleared), no release on the wire, lock idle', async () => {
    const { m, wire, events } = setup();
    await m.withAccess(['rapid'], async () => { wire.push('restart'); }, { releaseOnSuccess: false });
    expect(wire).toEqual(['request edit', 'restart']);
    expect(events).toEqual([
      { type: 'acquired', lock: 'edit' },
      { type: 'released', lock: 'edit', alreadyCleared: true },
    ]);
    expect(m.count('edit')).toBe(0);
    expect(m.snapshot().locks.find(l => l.lock === 'edit')).toMatchObject({ state: 'idle', count: 0 });
  });

  it('with another hold still on the lock: nothing is emitted and the lock stays held', async () => {
    const { m, events } = setup();
    const outer = await m.acquire('cfg');
    const inner = await m.acquire('rapid');
    events.length = 0;
    await m.forget(inner);
    expect(events).toEqual([]);
    expect(m.count('edit')).toBe(1);
    await m.forget(outer);
    expect(events).toEqual([{ type: 'released', lock: 'edit', alreadyCleared: true }]);
  });

  it('a hold already ended is not forgotten twice', async () => {
    const { m, events } = setup();
    const h = await m.acquire('rapid');
    await m.forget(h);
    await m.forget(h);
    expect(events.filter(e => e.type === 'released')).toHaveLength(1);
  });

  it('a refused restart is still released on the wire, as an ordinary release', async () => {
    const { m, wire, events } = setup();
    await expect(m.withAccess(['rapid'], async () => { throw new Error('refused'); }, { releaseOnSuccess: false })).rejects.toThrow('refused');
    expect(wire).toEqual(['request edit', 'release edit']);
    expect(events.at(-1)).toEqual({ type: 'released', lock: 'edit' });
  });
});

// ─── RobotManager follows the forgotten hold (RWS 2.0 over a mock controller) ─

describe('RobotManager: state.access after an accepted restart', () => {
  it('RobotWare 7.21: edit reads idle as soon as the restart is accepted, with no poll and no release sent', async () => {
    const wire: string[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        wire.push(`${req.method} ${req.url}`);
        if (req.url === '/rw/system') {
          res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
          res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"7.21.4+417"}]}');
          return;
        }
        res.writeHead(204); res.end();
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const adapter = new RWS2Adapter(`http://127.0.0.1:${port}`, 'u', 'p');
      await adapter.connect();
      const mgr = new RobotManager();
      (mgr as any).adapter = adapter;
      (mgr as any)._state.connected = true;
      const seen: AccessEvent[] = [];
      mgr.onAccessEvent(e => seen.push(e));

      await mgr.restartController('restart');

      expect(wire).toContain('POST /rw/mastership/edit/request');
      expect(wire).toContain('POST /ctrl/restart');
      expect(wire).not.toContain('POST /rw/mastership/edit/release');
      // The consumer's check, as the functional restart test makes it.
      const held = mgr.state.access.locks.filter(l => l.state === 'held' && l.count > 0).map(l => l.lock);
      expect(held).toEqual([]);
      expect(mgr.state.access.locks.find(l => l.lock === 'edit')).toMatchObject({ state: 'idle', count: 0 });
      await new Promise(r => setImmediate(r));
      expect(seen.map(e => [e.type, e.lock, (e as { alreadyCleared?: boolean }).alreadyCleared])).toEqual([
        ['acquired', 'edit', undefined],
        ['released', 'edit', true],
      ]);
      await adapter.disconnect();
    } finally { server.close(); }
  });
});
