/**
 * Offline checks of the live-test discovery helper (tests/helpers/liveControllers.ts):
 * what it asks `findControllers` for, the order it lists controllers in, how
 * `findVcAgain` picks a controller after a restart, and the run cache. No socket,
 * no child process and no file: `findControllers` and `fs` are fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FindControllersOptions, FoundController } from '../../src/index.js';

const fake = vi.hoisted(() => ({
  calls: [] as unknown[],
  answer: (_o: unknown): unknown[] => [],
  files: new Map<string, string>(),
}));

vi.mock('../../src/index.js', () => ({
  findControllers: vi.fn(async (o: unknown) => {
    fake.calls.push(o);
    return {
      controllers: fake.answer(o), aborted: false, environment: { wsl: false }, tlsFailures: [],
      unmatchedCredentials: [], notes: [], localScan: { status: 'ok', attempts: [], vcFilter: 'on', sweep: false },
    };
  }),
}));

vi.mock('node:fs', () => {
  const api = {
    readFileSync: (p: unknown): string => {
      const v = fake.files.get(String(p));
      if (v === undefined) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
      return v;
    },
    writeFileSync: (p: unknown, d: unknown): void => { fake.files.set(String(p), String(d)); },
    mkdirSync: (): undefined => undefined,
    rmSync: (p: unknown): void => { fake.files.delete(String(p)); },
  };
  return { default: api, ...api };
});

import {
  findVcAgain, listLocalControllers, discoverControllers, forgetControllers,
} from './liveControllers.js';

function row(port: number, generation: 'rws1' | 'rws2', over: Partial<FoundController> = {}): FoundController {
  const https = generation === 'rws2';
  return {
    key: `local:${port}`, host: '127.0.0.1', port, https, generation, identified: true,
    authType: https ? 'basic' : 'digest',
    probe: { host: '127.0.0.1', port, useHttps: https, authType: https ? 'basic' : 'digest' },
    sources: ['this-pc'], addresses: [{ host: '127.0.0.1', port, https, sources: ['this-pc'] }],
    ...over,
  } as FoundController;
}

const opts = (i: number): FindControllersOptions => fake.calls[i] as FindControllersOptions;
const ENV = { ...process.env };

beforeEach(() => {
  fake.calls.length = 0;
  fake.files.clear();
  fake.answer = () => [];
  delete process.env.RWS_TEST_PORT_RW6;
  delete process.env.RWS_TEST_PORT_RW7;
  forgetControllers();
});
afterEach(() => { process.env = { ...ENV }; });

describe('every discovery stays on this PC', () => {
  it('asks for loopback only, no service address, no mDNS, the VC filter, one probe at a time', async () => {
    await listLocalControllers({ fresh: true });
    await findVcAgain('rws2');
    expect(fake.calls).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(opts(i)).toMatchObject({
        loopbackOnly: true, serviceAddress: false, mdns: false, filterToVcProcesses: true,
        pacing: { local: { concurrency: 1, minGapMs: 1000 } },
      });
    }
  });

  it('refuses a result with a host off this PC, folded addresses included', async () => {
    fake.answer = () => [row(5466, 'rws2', { addresses: [{ host: '192.0.2.10', port: 5466, https: true, sources: ['this-pc'] }] })];
    await expect(listLocalControllers({ fresh: true })).rejects.toThrow(/refuse non-localhost host "192\.0\.2\.10"/);
  });
});

describe('listLocalControllers', () => {
  it('env-named ports first (and probed as manual targets), then RobotWare major, then port; RWS rows only', async () => {
    process.env.RWS_TEST_PORT_RW7 = '9805';
    fake.answer = () => [
      row(5466, 'rws2', { rwVersion: '7.21.0+229' }),
      row(80, 'rws2', { rwVersion: '8.1.1+614' }),
      row(9805, 'rws2', { rwVersion: '8.2.1+1023' }),
      row(9403, 'rws2', { rwVersion: '7.21.4+417' }),
      row(39127, 'rws1'),
      row(41000, 'rws2', { identified: false, generation: null }),
    ];
    const list = await listLocalControllers({ fresh: true });
    expect(opts(0)).toMatchObject({ identify: 'anonymous', manual: [{ host: '127.0.0.1', port: 9805 }] });
    expect(list.map(c => c.port)).toEqual([9805, 39127, 5466, 9403, 80]);
    expect(list[0].label).toContain('(env)');
    expect(list.find(c => c.port === 39127)).toMatchObject({ generation: 'rws1', tls: false, baseUrl: 'http://127.0.0.1:39127' });
  });

  it('discoverControllers keeps one controller per generation, in that order', async () => {
    fake.answer = () => [row(9403, 'rws2', { rwVersion: '7.21.4+417' }), row(5466, 'rws2', { rwVersion: '7.21.0+229' }), row(39127, 'rws1')];
    const picked = await discoverControllers();
    expect(picked.map(c => [c.generation, c.port])).toEqual([['rws1', 39127], ['rws2', 5466]]);
  });

  it('the run cache is reused after one probe of each cached port, and dropped when one changed', async () => {
    fake.answer = () => [row(9403, 'rws2', { rwVersion: '7.21.4+417' }), row(39127, 'rws1')];
    await listLocalControllers();
    expect(fake.calls).toHaveLength(1);

    // Revalidation: a loopback-only run with no scan, one manual entry per cached port and scheme.
    const again = await listLocalControllers();
    expect(fake.calls).toHaveLength(2);
    expect(opts(1)).toMatchObject({
      local: false, identify: 'none', loopbackOnly: true,
      manual: [{ host: '127.0.0.1', port: 39127, https: false }, { host: '127.0.0.1', port: 9403, https: true }],
    });
    expect(again.map(c => c.port)).toEqual([39127, 9403]);

    // A cached port that now answers with another scheme: discover again (revalidation + scan).
    fake.answer = o => ((o as FindControllersOptions).local === false
      ? [row(9403, 'rws2', { https: false }), row(39127, 'rws1')]
      : [row(9805, 'rws2', { rwVersion: '8.2.1+1023' }), row(39127, 'rws1')]);
    const moved = await listLocalControllers();
    expect(fake.calls).toHaveLength(4);
    expect(moved.map(c => c.port)).toEqual([39127, 9805]);
  });

  it('the run cache is not used when the env ports changed', async () => {
    fake.answer = () => [row(9403, 'rws2', { rwVersion: '7.21.4+417' })];
    await listLocalControllers();
    process.env.RWS_TEST_PORT_RW7 = '9403';
    await listLocalControllers();
    expect(fake.calls).toHaveLength(2);
    expect(opts(1).local).not.toBe(false);   // a full discovery, not a revalidation
  });
});

describe('findVcAgain', () => {
  const answers = (): FoundController[] => [
    row(5466, 'rws2', { process: { pid: 1, image: 'Vrchost64.exe' }, systemName: 'IRB1600_6_120_1' }),
    row(9403, 'rws2', { process: { pid: 2, image: 'Vrchost64.exe' }, systemName: 'IRB1600_6_120_5' }),
    row(9805, 'rws2', { process: { pid: 3, image: 'Vrchost64.exe' } }),
    row(11000, 'rws2', { process: { pid: 4, image: 'proxy.exe' } }),
    row(39127, 'rws1', { process: { pid: 5, image: 'RobVC.exe' } }),
  ];

  it('prefers the original port; otherwise the lowest port of this generation', async () => {
    fake.answer = answers;
    expect((await findVcAgain('rws2', { originPort: 9403 }))?.port).toBe(9403);
    expect((await findVcAgain('rws2', { originPort: 62214 }))).toMatchObject({ port: 5466, label: expect.stringContaining('(found again)') });
    expect((await findVcAgain('rws1'))?.port).toBe(39127);
  });

  it('drops excluded ports and ports of another process image', async () => {
    fake.answer = () => answers().filter(r => r.port !== 5466 && r.port !== 9403 && r.port !== 9805);
    expect(await findVcAgain('rws2')).toBeNull();          // only the proxy is left: not a VC process
    fake.answer = answers;
    expect((await findVcAgain('rws2', { excludePorts: new Set([5466, 9403]) }))?.port).toBe(9805);
  });

  it('with systemName: reads names (identify anonymous) and drops a VC whose folder names another system', async () => {
    fake.answer = answers;
    const hit = await findVcAgain('rws2', { originPort: 5466, systemName: 'IRB1600_6_120_5' });
    expect(opts(0).identify).toBe('anonymous');
    expect(hit?.port).toBe(9403);
    // An entry whose name could not be read is still a candidate.
    expect((await findVcAgain('rws2', { systemName: 'IRB1600_6_120_9', excludePorts: new Set([5466, 9403]) }))?.port).toBe(9805);
    await findVcAgain('rws2');
    expect(opts(2).identify).toBe('none');
  });
});

