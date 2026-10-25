import { describe, it, expect } from 'vitest';
import { FETCH_BAD_PORTS, effectivePort, fetchRefusesUrl } from '../src/badPorts.js';
import { scriptedServer } from './helpers/scriptedHttp.js';

// The list HttpSession uses to send a session through node:http instead of
// fetch (src/badPorts.ts), checked against the standard and against what the
// running Node's fetch refuses.

/**
 * The bad-port table of the WHATWG Fetch standard, "Port blocking"
 * (https://fetch.spec.whatwg.org/#port-blocking), as read on 2026-10-23.
 */
const STANDARD_BAD_PORTS = [
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];

describe('badPorts - the Fetch standard bad-port list', () => {
  it('is exactly the standard table (83 ports)', () => {
    expect([...FETCH_BAD_PORTS].sort((a, b) => a - b)).toEqual(STANDARD_BAD_PORTS);
    expect(FETCH_BAD_PORTS.size).toBe(83);
  });

  it('the effective port is the URL\'s own, else 80 for http and 443 for https', () => {
    expect(effectivePort('http://192.0.2.10')).toBe(80);
    expect(effectivePort('https://192.0.2.10')).toBe(443);
    expect(effectivePort('http://192.0.2.10:80')).toBe(80);
    expect(effectivePort('https://192.0.2.10:443')).toBe(443);
    expect(effectivePort('http://192.0.2.10:443')).toBe(443);
    expect(effectivePort('http://127.0.0.1:7')).toBe(7);
    expect(effectivePort('HTTP://127.0.0.1:0007')).toBe(7);
    expect(effectivePort('http://[::1]:10080')).toBe(10080);
    expect(effectivePort('http://localhost:23093/')).toBe(23093);
    // Neither http nor https, or not a URL: no port to judge.
    expect(effectivePort('ws://127.0.0.1:7')).toBeUndefined();
    expect(effectivePort('127.0.0.1:7')).toBeUndefined();
    expect(effectivePort('not a url')).toBeUndefined();
  });

  it('fetch refuses a base URL on a bad port, and only then', () => {
    for (const url of ['http://127.0.0.1:7', 'http://127.0.0.1:0007', 'https://192.0.2.10:6000', 'http://localhost:10080', 'http://[::1]:6665']) {
      expect(fetchRefusesUrl(url), url).toBe(true);
    }
    for (const url of ['http://192.0.2.10', 'https://192.0.2.10', 'http://192.0.2.10:80', 'https://192.0.2.10:443',
      'http://127.0.0.1:23093', 'http://127.0.0.1:8080', 'ws://127.0.0.1:7', 'not a url']) {
      expect(fetchRefusesUrl(url), url).toBe(false);
    }
  });

  it('port 0 goes through fetch, though the standard lists it: node:http would connect to the default port', () => {
    expect(FETCH_BAD_PORTS.has(0)).toBe(true);
    for (const url of ['http://127.0.0.1:0', 'https://192.0.2.10:0', 'http://[::1]:0000']) {
      expect(effectivePort(url), url).toBe(0);
      expect(fetchRefusesUrl(url), url).toBe(false);
    }
  });
});

describe('badPorts - against the running Node\'s fetch', () => {
  /** Where Node's fetch looks up its dispatcher (undici's global dispatcher). */
  const DISPATCHER = Symbol.for('undici.globalDispatcher.1');

  /**
   * Run `body` with fetch's dispatcher replaced by one that refuses every
   * request at once, so no fetch reaches the network: a port fetch refuses
   * fails with cause "bad port" before the dispatcher is asked, any other
   * port with the stand-in's error. False when the stand-in did not take (a
   * Node whose fetch looks elsewhere): checked first with a request to a
   * server of this test's own.
   */
  async function withoutNetwork(body: () => Promise<void>): Promise<boolean> {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const saved = g[DISPATCHER];
    const own = await scriptedServer();
    g[DISPATCHER] = {
      dispatch() { throw new Error('stand-in dispatcher: nothing sent'); },
      close() { /* nothing open */ },
      destroy() { /* nothing open */ },
      on() { return this; },
      off() { return this; },
    };
    try {
      const cause = await fetch(`${own.baseUrl}/`).then(
        () => 'answered',
        (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e),
      );
      if (cause !== 'stand-in dispatcher: nothing sent' || own.requests.length > 0) { return false; }
      await body();
      return true;
    } finally {
      g[DISPATCHER] = saved;
      await own.close();
    }
  }

  /** Whether this Node's fetch refuses `port` ("bad port"). Only inside withoutNetwork(). */
  const refuses = (port: number): Promise<boolean> => fetch(`http://127.0.0.1:${port}/`).then(
    () => false,
    (e: unknown) => (e as { cause?: { message?: string } }).cause?.message === 'bad port',
  );

  it('every port it refuses is on the list (ports 0-11000, past the highest listed one)', async () => {
    let refused: number[] = [];
    const ran = await withoutNetwork(async () => {
      for (let start = 0; start <= 11000; start += 1000) {
        const ports = Array.from({ length: Math.min(1000, 11001 - start) }, (_, i) => start + i);
        const results = await Promise.all(ports.map(refuses));
        refused = refused.concat(ports.filter((_, i) => results[i]));
      }
    });
    // Fails rather than skips (a skip until 1.5.1): on a Node whose fetch keeps
    // its dispatcher elsewhere this check of the list never ran, and only a
    // warning said so. Find where that Node's fetch looks for it and update
    // withoutNetwork; the ports are never tried over the network instead.
    expect(ran, `fetch's dispatcher could not be replaced on Node ${process.version}, so the ports were not tried`).toBe(true);
    // The direction that matters: a port fetch refuses and the session still
    // sends through fetch would fail. Port 0 is sent through fetch on purpose
    // (src/badPorts.ts) and fails to connect whichever way it is sent.
    expect(refused.filter(p => p !== 0 && !fetchRefusesUrl(`http://127.0.0.1:${p}`))).toEqual([]);
    // The other way is harmless (such a port goes through node:http, which
    // reaches it). Node 24.19.0 (undici 7.29.0) refuses all but 0.
    const accepted = [...FETCH_BAD_PORTS].filter(p => !refused.includes(p));
    if (accepted.length > 0) {
      console.info(`Node ${process.version} fetch accepts these listed ports: ${accepted.join(', ')}`);
    }
    expect(refused.length).toBeGreaterThan(0);
  });
});
