import { describe, it, expect, vi, beforeEach } from 'vitest';

// This PC, for these tests: one LAN IPv4 address, one global IPv6 address reported with the
// numeric family some Node versions use, and one link-local IPv6 address. Documentation
// addresses only (RFC 5737, RFC 3849).
const IFACES = {
  lo: [
    { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
    { address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', mac: '00:00:00:00:00:00', internal: true, cidr: '::1/128', scopeid: 0 },
  ],
  eth0: [
    { address: '192.0.2.10', netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: '192.0.2.10/24' },
    { address: '2001:DB8::10', netmask: 'ffff:ffff:ffff:ffff::', family: 6, mac: '02:00:00:00:00:01', internal: false, cidr: '2001:db8::10/64', scopeid: 0 },
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '02:00:00:00:00:01', internal: false, cidr: 'fe80::1/64', scopeid: 7 },
  ],
};

const osMock = vi.hoisted(() => ({ networkInterfaces: vi.fn() }));
vi.mock('os', async importOriginal => ({ ...(await importOriginal<typeof import('os')>()), networkInterfaces: osMock.networkInterfaces }));

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('dns', async importOriginal => ({ ...(await importOriginal<typeof import('dns')>()), lookup: dnsMock.lookup }));

import {
  IPV6_ONLY_NOTE,
  canonicalHost,
  discoveryKey,
  discoveryKeyWith,
  isLocalAddress,
  localAddressChecker,
  resolveIPv4,
  type LookupAll,
} from '../../src/discovery/addresses.js';

beforeEach(() => {
  osMock.networkInterfaces.mockReset();
  osMock.networkInterfaces.mockReturnValue(IFACES);
  dnsMock.lookup.mockReset();
});

describe('canonicalHost', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['  198.51.100.7  ', '198.51.100.7'],
    ['[::1]', '::1'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['FE80::1%eth0', 'fe80::1'],
    ['[fe80::1%25]', 'fe80::1'],
    ['::ffff:192.0.2.10', '192.0.2.10'],
    ['::FFFF:c000:020a', '192.0.2.10'],
    ['0:0:0:0:0:ffff:198.51.100.7', '198.51.100.7'],
    ['[::ffff:127.0.0.1]', '127.0.0.1'],
    ['2001:DB8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0010', '2001:db8::10'],
    ['::', '::'],
    [' Robot-1.Example. ', 'robot-1.example'],
    ['LOCALHOST', 'localhost'],
  ])('%j gives %j', (input, expected) => {
    expect(canonicalHost(input)).toBe(expected);
  });
});

describe('isLocalAddress', () => {
  it.each([
    'localhost', 'LocalHost', '127.0.0.1', '127.5.6.7', '::1', '[::1]', '::ffff:127.0.0.1',
    '192.0.2.10', '::ffff:192.0.2.10', '2001:DB8::10', '2001:db8:0:0:0:0:0:10', 'fe80::1%eth0',
  ])('%j is this PC', host => {
    expect(isLocalAddress(host)).toBe(true);
  });

  it.each([
    '192.0.2.11', '198.51.100.7', '203.0.113.5', '128.0.0.1', '0.0.0.0', '::2', 'robot.example', '',
  ])('%j is not this PC', host => {
    expect(isLocalAddress(host)).toBe(false);
  });

  it('reads the interface list on every call', () => {
    expect(isLocalAddress('192.0.2.10')).toBe(true);
    osMock.networkInterfaces.mockReturnValue({});
    expect(isLocalAddress('192.0.2.10')).toBe(false);
    expect(isLocalAddress('127.0.0.1')).toBe(true);
  });

  it('still knows loopback when the interface list cannot be read', () => {
    osMock.networkInterfaces.mockImplementation(() => { throw new Error('uv_interface_addresses'); });
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
    expect(isLocalAddress('192.0.2.10')).toBe(false);
  });

  it('localAddressChecker reads the interface list once', () => {
    const check = localAddressChecker();
    expect(osMock.networkInterfaces).toHaveBeenCalledTimes(1);
    expect(check('192.0.2.10')).toBe(true);
    expect(check('198.51.100.7')).toBe(false);
    expect(osMock.networkInterfaces).toHaveBeenCalledTimes(1);
  });
});

describe('discoveryKey', () => {
  it('folds every address of this PC into local:<port>', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '192.0.2.10', '::ffff:192.0.2.10', '127.0.0.2']) {
      expect(discoveryKey(h, 9403)).toBe('local:9403');
    }
  });

  it('uses the canonical host for other addresses', () => {
    expect(discoveryKey('198.51.100.7', 443)).toBe('198.51.100.7:443');
    expect(discoveryKey('[::ffff:198.51.100.7]', 443)).toBe('198.51.100.7:443');
    expect(discoveryKey(' Robot.Example. ', 80)).toBe('robot.example:80');
  });

  it('discoveryKeyWith takes the caller\'s checker', () => {
    const none = (): boolean => false;
    expect(discoveryKeyWith(none, '127.0.0.1', 80)).toBe('127.0.0.1:80');
    expect(discoveryKeyWith(h => h === '203.0.113.5', '203.0.113.5', 80)).toBe('local:80');
  });
});

describe('resolveIPv4', () => {
  const never: LookupAll = () => { throw new Error('no lookup expected'); };

  it('maps localhost to 127.0.0.1 without a lookup', async () => {
    const lookup = vi.fn(never);
    await expect(resolveIPv4('localhost', { lookup })).resolves.toEqual({ name: 'localhost', ipv4: '127.0.0.1' });
    await expect(resolveIPv4('LOCALHOST.', { lookup })).resolves.toEqual({ name: 'LOCALHOST.', ipv4: '127.0.0.1' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns an IPv4 literal without a lookup', async () => {
    const lookup = vi.fn(never);
    await expect(resolveIPv4('198.51.100.7', { lookup })).resolves.toEqual({ name: '198.51.100.7', ipv4: '198.51.100.7' });
    await expect(resolveIPv4('::ffff:198.51.100.7', { lookup })).resolves.toEqual({ name: '::ffff:198.51.100.7', ipv4: '198.51.100.7' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not resolve an IPv6 literal', async () => {
    const lookup = vi.fn(never);
    const r = await resolveIPv4('2001:db8::5', { lookup });
    expect(r.ipv4).toBeUndefined();
    expect(r.note).toContain(IPV6_ONLY_NOTE);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('takes the first IPv4 address even when an IPv6 address comes first', async () => {
    const lookup = vi.fn(async (_name: string) => [
      { address: '2001:db8::7', family: 6 },
      { address: '198.51.100.7', family: 4 },
      { address: '198.51.100.8', family: 4 },
    ]);
    await expect(resolveIPv4('Cell7.Example', { lookup })).resolves.toEqual({ name: 'Cell7.Example', ipv4: '198.51.100.7' });
    expect(lookup).toHaveBeenCalledWith('cell7.example');
  });

  it('skips a name with IPv6 addresses only, with a note', async () => {
    const r = await resolveIPv4('v6only.example', { lookup: async () => [{ address: '2001:db8::9', family: 6 }] });
    expect(r).toEqual({ name: 'v6only.example', note: `v6only.example: ${IPV6_ONLY_NOTE}` });
  });

  it('notes a name with no address, a failed lookup and a timeout; never rejects', async () => {
    expect((await resolveIPv4('empty.example', { lookup: async () => [] })).note).toMatch(/no address/);
    const failed = await resolveIPv4('missing.example', {
      lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); },
    });
    expect(failed).toEqual({ name: 'missing.example', note: 'missing.example: name lookup failed (ENOTFOUND)' });
    const slow = await resolveIPv4('slow.example', { timeoutMs: 20, lookup: () => new Promise(() => undefined) });
    expect(slow.ipv4).toBeUndefined();
    expect(slow.note).toMatch(/timed out after 20 ms/);
    expect((await resolveIPv4('   ')).note).toBe('empty host name');
  });

  it('uses dns.lookup with every address by default', async () => {
    dnsMock.lookup.mockImplementation((_name: string, _opts: unknown, cb: (e: Error | null, a: unknown) => void) => {
      cb(null, [{ address: '203.0.113.5', family: 4 }]);
    });
    await expect(resolveIPv4('robot.example')).resolves.toEqual({ name: 'robot.example', ipv4: '203.0.113.5' });
    expect(dnsMock.lookup).toHaveBeenCalledTimes(1);
    expect(dnsMock.lookup.mock.calls[0][0]).toBe('robot.example');
    expect(dnsMock.lookup.mock.calls[0][1]).toEqual({ all: true });
  });
});
