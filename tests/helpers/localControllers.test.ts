/**
 * Offline checks of the discovery helper the scripts share
 * (scripts/local-controllers.mjs): what it asks `findControllers` for, that
 * it refuses any host off this PC's loopback, and the order it picks in.
 * No socket, no child process: `findControllers` is a fake.
 */

import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error - plain .mjs script without type declarations
import * as helper from '../../scripts/local-controllers.mjs';

interface Row {
  key?: string; host: string; port: number; https: boolean | null; generation: 'rws1' | 'rws2' | null;
  authType?: 'basic' | 'digest' | null; identified: boolean; probe: object | null;
  rwVersion?: string; systemName?: string; process?: { pid: number; image?: string };
  addresses?: Array<{ host: string; port: number }>;
}

const h = helper as {
  LOCAL_DISCOVERY: Record<string, unknown>;
  envPorts(say?: (m: string) => void): Map<number, string>;
  findLocalControllers(client: unknown, opts?: { identify?: string; ports?: number[] }): Promise<{ rows: Row[] }>;
  byPreference(named: Set<number>): (a: Row, b: Row) => number;
  isVcOf(row: Row, generation: 'rws1' | 'rws2'): boolean;
  assertLocalhost(host: string): void;
};

function row(port: number, generation: 'rws1' | 'rws2', over: Partial<Row> = {}): Row {
  return {
    host: '127.0.0.1', port, https: generation === 'rws2', generation,
    authType: generation === 'rws1' ? 'digest' : 'basic', identified: true, probe: {}, ...over,
  };
}

function fakeClient(controllers: Row[]): { client: unknown; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    client: {
      findControllers: async (options: Record<string, unknown>) => {
        calls.push(options);
        return { controllers, aborted: false, localScan: { status: 'ok', attempts: [], vcFilter: 'on', sweep: false }, notes: [] };
      },
    },
  };
}

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['RWS_TEST_PORT_RW6', 'RWS_TEST_PORT_RW7', 'RWS_TEST_PORT_RW8']) {
    if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; }
  }
});

describe('scripts/local-controllers.mjs', () => {
  it('asks for this PC\'s loopback only, no service address, no mDNS, the VC filter and paced probes', async () => {
    const { client, calls } = fakeClient([]);
    await h.findLocalControllers(client, { identify: 'anonymous', ports: [5466, 5466, 39127] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      loopbackOnly: true, serviceAddress: false, mdns: false, filterToVcProcesses: true,
      pacing: { local: { concurrency: 1, minGapMs: 1000 } }, identify: 'anonymous',
      manual: [{ host: '127.0.0.1', port: 5466 }, { host: '127.0.0.1', port: 39127 }],
    });
  });

  it('sends no manual targets when no port is named, and identify defaults to none', async () => {
    const { client, calls } = fakeClient([]);
    await h.findLocalControllers(client);
    expect(calls[0].identify).toBe('none');
    expect(calls[0]).not.toHaveProperty('manual');
  });

  it('refuses a result that names a host off this PC\'s loopback, also inside folded addresses', async () => {
    await expect(h.findLocalControllers(fakeClient([row(5466, 'rws2', { host: '192.0.2.10' })]).client))
      .rejects.toThrow(/refuses non-localhost host "192\.0\.2\.10"/);
    await expect(h.findLocalControllers(fakeClient([row(5466, 'rws2', { addresses: [{ host: '198.51.100.7', port: 443 }] })]).client))
      .rejects.toThrow(/198\.51\.100\.7/);
  });

  it('keeps only realm-verified RWS rows with a known scheme on 127.0.0.1', async () => {
    const { client } = fakeClient([
      row(5466, 'rws2'),
      row(9403, 'rws2', { identified: false }),
      row(9805, 'rws2', { https: null, probe: null }),
      row(80, 'rws2', { generation: null }),
      row(39127, 'rws1', { host: '::1' }),
    ]);
    expect((await h.findLocalControllers(client)).rows.map(r => r.port)).toEqual([5466]);
  });

  it('orders env-named ports first, then RobotWare major (RWS 1.0 is 6, unknown last), then port', () => {
    const rows = [
      row(80, 'rws2', { rwVersion: '8.1.1+614' }),
      row(9805, 'rws2'),
      row(9403, 'rws2', { rwVersion: '7.21.4+417' }),
      row(5466, 'rws2', { rwVersion: '7.21.0+229' }),
      row(39127, 'rws1'),
    ];
    expect(rows.slice().sort(h.byPreference(new Set())).map(r => r.port)).toEqual([39127, 5466, 9403, 80, 9805]);
    expect(rows.slice().sort(h.byPreference(new Set([9805]))).map(r => r.port)).toEqual([9805, 39127, 5466, 9403, 80]);
  });

  it('reads the RWS_TEST_PORT_* ports and ignores a value that is not a port', () => {
    process.env.RWS_TEST_PORT_RW6 = '39127';
    process.env.RWS_TEST_PORT_RW7 = 'abc';
    process.env.RWS_TEST_PORT_RW8 = '80';
    const said: string[] = [];
    expect([...h.envPorts(m => said.push(m))]).toEqual([[39127, 'rw6'], [80, 'rw8']]);
    expect(said).toEqual(['RWS_TEST_PORT_RW7=abc is not a port - ignored']);
  });

  it('matches the VC process of a generation, case-blind, and accepts a row whose owner the OS did not name', () => {
    expect(h.isVcOf(row(39127, 'rws1', { process: { pid: 1, image: 'RobVC.exe' } }), 'rws1')).toBe(true);
    expect(h.isVcOf(row(5466, 'rws2', { process: { pid: 2, image: 'VRCHOST64.EXE' } }), 'rws2')).toBe(true);
    expect(h.isVcOf(row(5466, 'rws2', { process: { pid: 3, image: 'RobVC.exe' } }), 'rws2')).toBe(false);
    expect(h.isVcOf(row(5466, 'rws2'), 'rws2')).toBe(true);
  });
});
