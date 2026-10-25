import { describe, it, expect, afterEach } from 'vitest';
import { liveHost, parseLiveHost } from './liveHost.js';

// RWS_TEST_HOST for the live suites: a bare host or the base URL RAPID
// Live's host harness sets, this PC only. Offline: nothing is sent.

describe('parseLiveHost (RWS_TEST_HOST)', () => {
  const saved = process.env.RWS_TEST_HOST;
  afterEach(() => {
    if (saved === undefined) { delete process.env.RWS_TEST_HOST; } else { process.env.RWS_TEST_HOST = saved; }
  });

  it('unset or blank leaves the live suites off', () => {
    expect(parseLiveHost(undefined)).toBeNull();
    expect(parseLiveHost('')).toBeNull();
    expect(parseLiveHost('   ')).toBeNull();
  });

  it('takes a bare host of this PC', () => {
    expect(parseLiveHost('127.0.0.1')).toBe('127.0.0.1');
    expect(parseLiveHost(' localhost ')).toBe('localhost');
    expect(parseLiveHost('LOCALHOST')).toBe('localhost');
    expect(parseLiveHost('::1')).toBe('::1');
    expect(parseLiveHost('[::1]')).toBe('::1');
  });

  it('takes the host of an http or https URL, as RAPID Live\'s harness sets it, and leaves its port alone', () => {
    expect(parseLiveHost('https://127.0.0.1:80')).toBe('127.0.0.1');
    expect(parseLiveHost('http://127.0.0.1')).toBe('127.0.0.1');
    expect(parseLiveHost('https://localhost:443/')).toBe('localhost');
    expect(parseLiveHost('HTTPS://LocalHost:1')).toBe('localhost');
    expect(parseLiveHost('http://[::1]:7')).toBe('::1');
  });

  it('refuses any other host, bare or in a URL', () => {
    for (const raw of ['192.168.125.1', '10.0.0.5', 'robot.plant.example', 'https://192.168.125.1:443', 'http://127.0.0.1.example.com',
      'https://192.0.2.10/', '127.0.0.2']) {
      expect(() => parseLiveHost(raw), raw).toThrow(/is not localhost\. Live suites only ever target local virtual controllers/);
    }
  });

  it('refuses what is neither a host nor an http(s) URL, naming the forms it takes', () => {
    expect(() => parseLiveHost('ws://127.0.0.1:80')).toThrow(/not an http or https URL; give a host \(127\.0\.0\.1\) or an http\(s\) URL/);
    expect(() => parseLiveHost('127.0.0.1:80')).toThrow(/names a port without a scheme/);
    expect(() => parseLiveHost('https://')).toThrow(/is not a URL this suite can read/);
  });

  it('names the variable it read', () => {
    expect(() => parseLiveHost('192.0.2.10', 'RWS_OTHER')).toThrow(/^RWS_OTHER=192\.0\.2\.10 is not localhost/);
  });

  it('liveHost reads RWS_TEST_HOST', () => {
    delete process.env.RWS_TEST_HOST;
    expect(liveHost()).toBeNull();
    process.env.RWS_TEST_HOST = 'https://127.0.0.1:80';
    expect(liveHost()).toBe('127.0.0.1');
    process.env.RWS_TEST_HOST = '192.0.2.10';
    expect(() => liveHost()).toThrow(/is not localhost/);
  });
});
