import { describe, it, expect, vi, afterEach } from 'vitest';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  REMOTE_PER_HOST, isLoopbackHost, loopbackSweepPorts, runProbes, sweepOpenPorts, tcpOpen,
  type RunProbesOptions,
} from '../../src/discovery/scheduler.js';
import { DENIED_LOCAL_PORTS } from '../../src/discovery/listeningPorts.js';
import type { ProbeOutcome, ProbeUnit } from '../../src/discovery/types.js';

// No socket is opened here except to loopback test servers in the tcpOpen block.

const local = (port: number, host = '127.0.0.1'): ProbeUnit => ({ host, port, https: true, lane: 'local', source: 'this-pc' });
const remote = (host: string, port: number, https = true): ProbeUnit => ({ host, port, https, lane: 'remote', source: 'manual' });
const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const FAST = { concurrency: 64, minGapMs: 0 };

/** A fake probe that takes `ms`, records starts and the most sockets in flight (in all and per host). */
function timedProbe(ms: number, answer: (u: ProbeUnit) => ProbeOutcome = () => ({ kind: 'refused' })) {
  const starts: Array<{ unit: ProbeUnit; at: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const perHost = new Map<string, number>();
  const maxPerHost = new Map<string, number>();
  const probe: RunProbesOptions['probe'] = async unit => {
    starts.push({ unit, at: Date.now() });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const n = (perHost.get(unit.host) ?? 0) + 1;
    perHost.set(unit.host, n);
    maxPerHost.set(unit.host, Math.max(maxPerHost.get(unit.host) ?? 0, n));
    await delay(ms);
    inFlight--;
    perHost.set(unit.host, (perHost.get(unit.host) ?? 1) - 1);
    return answer(unit);
  };
  return { probe, starts, max: () => maxInFlight, maxPerHost };
}

describe('runProbes: budgets', () => {
  it('never has more sockets in flight than the lane concurrency', async () => {
    const t = timedProbe(15);
    const units = Array.from({ length: 10 }, (_, i) => local(1000 + i));
    const r = await runProbes(units, { local: { concurrency: 3, minGapMs: 0 }, remote: FAST, probe: t.probe });
    expect(r.hits).toHaveLength(10);
    expect(t.max()).toBe(3);
    expect(r.aborted).toBe(false);
  });

  it('keeps at least minGapMs between the starts of two connections in a lane', async () => {
    const t = timedProbe(1);
    const units = Array.from({ length: 4 }, (_, i) => local(2000 + i));
    await runProbes(units, { local: { concurrency: 8, minGapMs: 40 }, remote: FAST, probe: t.probe });
    const at = t.starts.map(s => s.at);
    for (let i = 1; i < at.length; i++) { expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(38); }
  });

  it('remote lane: at most 2 in flight per host, hosts in numeric address order', async () => {
    expect(REMOTE_PER_HOST).toBe(2);
    const t = timedProbe(20);
    // Plan order puts .20 first; numeric order puts .3 first ('10.0.0.20' < '10.0.0.3' as text).
    const units = [
      remote('10.0.0.20', 443), remote('10.0.0.20', 80), remote('10.0.0.20', 8443),
      remote('10.0.0.3', 443), remote('10.0.0.3', 80), remote('10.0.0.3', 8443),
    ];
    const r = await runProbes(units, { local: FAST, remote: { concurrency: 8, minGapMs: 0 }, probe: t.probe });
    expect(r.hits).toHaveLength(6);
    expect(t.starts[0].unit.host).toBe('10.0.0.3');
    expect(t.starts.slice(0, 2).map(s => s.unit.port)).toEqual([443, 80]);   // plan order within a host
    expect(t.maxPerHost.get('10.0.0.3')).toBe(2);
    expect(t.maxPerHost.get('10.0.0.20')).toBe(2);
  });

  it('runs both lanes at the same time', async () => {
    const t = timedProbe(60);
    const started = Date.now();
    await runProbes([local(3000), remote('192.0.2.7', 443)], {
      local: { concurrency: 1, minGapMs: 0 }, remote: { concurrency: 1, minGapMs: 100 }, probe: t.probe,
    });
    expect(t.starts).toHaveLength(2);
    expect(Math.abs(t.starts[0].at - t.starts[1].at)).toBeLessThan(40);
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe('runProbes: follow-ups, progress, failures', () => {
  it('schedules a follow-up in the same lane, counts it in total and runs it', async () => {
    const seen: Array<{ label: string; probed: number; total: number }> = [];
    const t = timedProbe(1, u => (u.port === 80 && u.https ? { kind: 'tls-failed' } : { kind: 'refused' }));
    const r = await runProbes([remote('192.0.2.7', 443), remote('192.0.2.7', 80)], {
      local: FAST,
      remote: { concurrency: 8, minGapMs: 0 },
      probe: t.probe,
      followUp: hit => (hit.outcome.kind === 'tls-failed' ? [{ ...hit.unit, https: false, fallback: true, lane: 'local' }] : []),
      onDone: (hit, c) => seen.push({ label: `${hit.unit.port}/${hit.unit.https ? 's' : 'p'}`, ...c }),
    });
    expect(r.hits.map(h => `${h.unit.port}/${h.unit.https ? 's' : 'p'}`)).toContain('80/p');
    const http = r.hits.find(h => h.unit.port === 80 && !h.unit.https);
    expect(http?.unit.lane).toBe('remote');         // kept in its parent's lane
    expect(http?.unit.fallback).toBe(true);
    expect(seen.map(s => s.total)).toEqual(expect.arrayContaining([3]));
    expect(seen[seen.length - 1]).toMatchObject({ probed: 3, total: 3 });
  });

  it('a probe that rejects counts as refused and the run goes on', async () => {
    const r = await runProbes([local(1), local(2)], {
      local: FAST, remote: FAST,
      probe: async u => { if (u.port === 1) { throw new Error('boom'); } return { kind: 'not-rws' }; },
    });
    expect(r.hits.map(h => h.outcome.kind).sort()).toEqual(['not-rws', 'refused']);
  });
});

describe('runProbes: cancel', () => {
  it('starts nothing after the abort and resolves only after the units in flight settled', async () => {
    const ac = new AbortController();
    const settled: number[] = [];
    let started = 0;
    const probe: RunProbesOptions['probe'] = (unit, signal) => new Promise(resolve => {
      started++;
      // Like probeOne: on abort the socket is destroyed, and the probe settles after it closed.
      signal?.addEventListener('abort', () => {
        setTimeout(() => { settled.push(unit.port); resolve({ kind: 'aborted' }); }, 30);
      }, { once: true });
    });
    const units = Array.from({ length: 10 }, (_, i) => local(4000 + i));
    const done = runProbes(units, { local: { concurrency: 2, minGapMs: 0 }, remote: FAST, probe, signal: ac.signal });
    await delay(20);
    expect(started).toBe(2);
    ac.abort();
    const r = await done;
    expect(r.aborted).toBe(true);
    expect(started).toBe(2);                 // nothing new after the abort
    expect(settled.sort()).toEqual([4000, 4001]);   // both settled before runProbes resolved
    expect(r.hits).toHaveLength(2);
  });

  it('an already aborted signal starts nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const probe = vi.fn(async (): Promise<ProbeOutcome> => ({ kind: 'refused' }));
    const r = await runProbes([local(1), remote('192.0.2.7', 443)], { local: FAST, remote: FAST, probe, signal: ac.signal });
    expect(probe).not.toHaveBeenCalled();
    expect(r).toEqual({ hits: [], aborted: true });
  });

  it('a gap wait ends at once on abort', async () => {
    const ac = new AbortController();
    const t = timedProbe(1);
    const started = Date.now();
    const done = runProbes([local(1), local(2)], { local: { concurrency: 4, minGapMs: 5000 }, remote: FAST, probe: t.probe, signal: ac.signal });
    await delay(30);
    ac.abort();
    const r = await done;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t.starts).toHaveLength(1);
    expect(r.aborted).toBe(true);
  });
});

describe('loopback sweep', () => {
  it('tries 80 and 443, then 1024-65535, without the denied ports', () => {
    const ports = loopbackSweepPorts();
    expect(ports.slice(0, 3)).toEqual([80, 443, 1024]);
    expect(ports[ports.length - 1]).toBe(65535);
    for (const p of DENIED_LOCAL_PORTS.keys()) { expect(ports).not.toContain(p); }
    const deniedInRange = [...DENIED_LOCAL_PORTS.keys()].filter(p => p >= 1024).length;
    expect(ports).toHaveLength(2 + (65535 - 1024 + 1) - deniedInRange);
  });

  it('isLoopbackHost: 127/8, ::1 and localhost only', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '0:0:0:0:0:0:0:1', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ['192.0.2.10', '10.0.0.1', '::', 'fe80::1', 'example.test', '0.0.0.0']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it('refuses another machine with INVALID_ARGUMENT before any connect', async () => {
    const check = vi.fn(async () => true);
    await expect(sweepOpenPorts('192.0.2.10', { check })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(check).not.toHaveBeenCalled();
  });

  it('returns the open ports in order, maps localhost to 127.0.0.1 and reports progress', async () => {
    const hosts = new Set<string>();
    const progress: Array<[number, number]> = [];
    const r = await sweepOpenPorts('localhost', {
      ports: Array.from({ length: 600 }, (_, i) => 2000 + i),
      concurrency: 7,
      check: async (host, port) => { hosts.add(host); return port % 250 === 0; },
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect([...hosts]).toEqual(['127.0.0.1']);
    expect(r).toEqual({ open: [2000, 2250, 2500], complete: true });
    expect(progress[progress.length - 1]).toEqual([600, 600]);
    expect(progress.length).toBeLessThanOrEqual(4);
  });

  it('stops on abort and says it is incomplete', async () => {
    const ac = new AbortController();
    let calls = 0;
    const r = await sweepOpenPorts('127.0.0.1', {
      ports: Array.from({ length: 1000 }, (_, i) => 3000 + i),
      concurrency: 2,
      signal: ac.signal,
      check: async () => { if (++calls === 10) { ac.abort(); } await delay(1); return false; },
    });
    expect(r.complete).toBe(false);
    expect(calls).toBeLessThan(20);
  });
});

describe('tcpOpen (loopback only)', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  });

  it('true for a listening loopback port, false for a closed one, and settles after the socket closed', async () => {
    const server = net.createServer(s => { s.on('error', () => { /* client closed */ }); s.resume(); });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    expect(await tcpOpen('127.0.0.1', port, 1000)).toBe(true);

    // A port nothing listens on, and nothing can start listening on while the
    // check runs: the local port of a connection this test holds open. A port
    // freed by closing a listener is not that: under full-suite load another
    // test's listener took one between the close and the check (read open
    // once, 2026-10-21). While the connection stands, the operating system
    // gives its local port to no other socket, so a connect to it is refused
    // (ECONNREFUSED within 1 ms on Windows, Node 24, 2026-10-25), and a
    // connect that ran into the timeout instead would read closed too.
    const held = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => resolve(s));
      s.once('error', reject);
    });
    try {
      const heldPort = held.localPort;
      expect(heldPort).toBeGreaterThan(0);
      expect(heldPort).not.toBe(port);
      expect(await tcpOpen('127.0.0.1', heldPort!, 1000)).toBe(false);
    } finally {
      held.destroy();
    }
  });

  it('an aborted signal opens nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await tcpOpen('127.0.0.1', 9, 1000, ac.signal)).toBe(false);
  });
});
