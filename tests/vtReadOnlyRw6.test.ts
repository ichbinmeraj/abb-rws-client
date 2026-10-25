import { describe, it, expect, beforeEach } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import { RobotManager } from '../src/RobotManager.js';
import { setLogger } from '../src/Logger.js';
import { RwsError } from '../src/types.js';
import { ALL_TABLES, evidenceOf } from '../src/paths/index.js';

/** The client sends no virtual-time write to RobotWare 6 in this release, although ABB documents the speed write: it is refused before sending. */

const SENTENCE = 'The client sends no virtual-time write to RobotWare 6 in this release, although ABB documents the speed write for virtual controllers; change the simulation speed in RobotStudio.';

beforeEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

function rws1() {
  const wire: string[] = [];
  const client = {
    requestMastership: async (d: string) => { wire.push(`mastership-request ${d}`); },
    releaseMastership: async (d: string) => { wire.push(`mastership-release ${d}`); },
    request: async (method: string, url: string) => { wire.push(`${method} ${url}`); return { status: 204, body: '' }; },
  };
  return { wire, adapter: new RWS1Adapter(client as unknown as RwsClient) };
}

async function expectNotSent(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e as RwsError);
  expect(err).toBeInstanceOf(RwsError);
  expect(err).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  // The client's own policy, not an ABB document: Rev M documents the vtspeed write.
  expect(err!.refusal).toMatchObject({ kind: 'unsupported', sentence: SENTENCE, generation: 'rw6', evidence: 'unverified' });
}

describe('setVirtualTimeScale on RobotWare 6: refused before sending', () => {
  for (const scale of [1, 2, Infinity, 0]) {
    it(`RWS1Adapter, scale ${scale}: UNSUPPORTED_OPERATION, nothing on the wire`, async () => {
      const { wire, adapter } = rws1();
      await expectNotSent(adapter.setVirtualTimeScale(scale));
      expect(wire).toEqual([]);
    });
  }

  it('RobotManager on RobotWare 6: the same refusal, nothing on the wire', async () => {
    const { wire, adapter } = rws1();
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = adapter;
    await expectNotSent(mgr.setVirtualTimeScale(2));
    expect(wire).toEqual([]);
  });

  it('the path row: the RWS 1.0 side is unsupported (a recorded gap), the RWS 2.0 side stays live', () => {
    const op = ALL_TABLES.ctrl.setVirtualTimeScale;
    expect(op.rws1?.gap).toMatch(/not sent in this release/);
    expect(op.rws1?.gap).toMatch(/no virtual-time write on RobotWare 6/);
    expect(evidenceOf(op, 'rws1')).toBeUndefined();
    expect(evidenceOf(op, 'rws2')).toBe('live');
  });

  it('RobotWare 7 and 8 are unchanged: the speed write is sent', async () => {
    const wire: string[] = [];
    const a = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    (a as unknown as Record<string, unknown>).req = async (method: string, at: string, fields?: Record<string, string>) => {
      wire.push(`${method} ${at} ${new URLSearchParams(fields ?? {}).toString()}`); return '';
    };
    await a.setVirtualTimeScale(2);
    expect(wire).toContain('POST /ctrl/virtualtime/vtspeed vtspeed=200');
  });
});
