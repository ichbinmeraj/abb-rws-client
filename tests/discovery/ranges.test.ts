import { describe, it, expect } from 'vitest';
import {
  parseRange, planRanges, rangeHosts, parseIPv4, formatIPv4, isLoopbackIPv4,
  DiscoveryOptionError, MAX_RANGE_ENTRIES, type RangeRules,
} from '../../src/discovery/ranges.js';
import { RwsError } from '../../src/types.js';

/** Range parsing and planning for findControllers. Addresses are private or RFC 5737 documentation addresses. */

const RULES: RangeRules = { maxRangeHosts: 256, allowPublicRanges: false, loopbackOnly: false };

function refusal(fn: () => unknown): DiscoveryOptionError {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(RwsError);
    expect(e).toBeInstanceOf(DiscoveryOptionError);
    expect((e as RwsError).code).toBe('INVALID_ARGUMENT');
    expect((e as Error).message).toMatch(/^findControllers: .+\. Nothing was sent\.$/);
    return e as DiscoveryOptionError;
  }
  throw new Error('expected a refusal');
}

describe('parseIPv4 / formatIPv4', () => {
  it('round-trips dotted quads', () => {
    for (const a of ['0.0.0.0', '10.0.5.20', '192.168.125.1', '255.255.255.255']) {
      const n = parseIPv4(a);
      expect(n).toBeDefined();
      expect(formatIPv4(n as number)).toBe(a);
    }
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
    expect(parseIPv4('128.0.0.1')).toBe(0x80000001);
  });

  it('refuses anything but a strict dotted quad', () => {
    for (const a of ['', '10.0.0', '10.0.0.0.1', '10.0.0.256', '010.0.0.1', '10.0.0.-1', '+10.0.0.1',
      ' 10.0.0.1', '10.0.0.1 ', '0x0a.0.0.1', '10..0.1', '1e1.0.0.1']) {
      expect(parseIPv4(a), a).toBeUndefined();
    }
  });

  it('isLoopbackIPv4 covers 127/8 only', () => {
    expect(isLoopbackIPv4('127.0.0.1')).toBe(true);
    expect(isLoopbackIPv4('127.255.255.254')).toBe(true);
    expect(isLoopbackIPv4('128.0.0.1')).toBe(false);
    expect(isLoopbackIPv4('localhost')).toBe(false);
  });
});

describe('parseRange', () => {
  it('CIDR /24 drops network and broadcast: 254 hosts', () => {
    const r = parseRange('10.0.5.0/24');
    expect(formatIPv4(r.first)).toBe('10.0.5.1');
    expect(formatIPv4(r.last)).toBe('10.0.5.254');
    expect(r.size).toBe(254);
    expect(r.text).toBe('10.0.5.0/24');
  });

  it('CIDR /30 keeps 2 hosts; /31 and /32 keep every address', () => {
    expect(parseRange('10.0.5.4/30')).toMatchObject({ size: 2, first: parseIPv4('10.0.5.5'), last: parseIPv4('10.0.5.6') });
    expect(parseRange('10.0.5.4/31')).toMatchObject({ size: 2, first: parseIPv4('10.0.5.4'), last: parseIPv4('10.0.5.5') });
    expect(parseRange('10.0.5.4/32')).toMatchObject({ size: 1, first: parseIPv4('10.0.5.4'), last: parseIPv4('10.0.5.4') });
  });

  it('CIDR ignores host bits after the prefix', () => {
    const a = parseRange('10.0.5.7/24');
    const b = parseRange('10.0.5.0/24');
    expect([a.first, a.last]).toEqual([b.first, b.last]);
  });

  it('sizes by arithmetic, including /0 and /8, without expanding', () => {
    expect(parseRange('0.0.0.0/0').size).toBe(2 ** 32 - 2);
    expect(parseRange('10.0.0.0/8').size).toBe(2 ** 24 - 2);
    expect(parseRange('192.0.2.0/1').size).toBe(2 ** 31 - 2);
  });

  it('dash includes both ends; whitespace around the parts is tolerated', () => {
    expect(parseRange('10.0.5.20-10.0.5.60').size).toBe(41);
    expect(parseRange(' 10.0.5.20 - 10.0.5.20 ').size).toBe(1);
    expect(parseRange('10.0.4.250-10.0.5.5').size).toBe(12);
  });

  it('refuses a dash range written backwards', () => {
    expect(refusal(() => parseRange('10.0.5.60-10.0.5.20', 'ranges[3]')).field).toBe('ranges[3]');
  });

  it('refuses IPv6 ranges with the RobotWare reason', () => {
    for (const t of ['fe80::/64', '::1-::2', '2001:db8::/32']) {
      expect(refusal(() => parseRange(t)).message).toMatch(/RobotWare does not support IPv6/);
    }
  });

  it('refuses malformed entries', () => {
    for (const t of ['', '10.0.5.0/33', '10.0.5.0/', '10.0.5.0/-1', '10.0.5.0/2a', '10.0.5/24', '10.0.5.20-60',
      '10.0.5.20-', 'robot.local/24', '10.0.5.0/24/1', 'x'.repeat(100)]) {
      refusal(() => parseRange(t));
    }
    for (const t of [42, null, {}, ['10.0.5.0/24']]) {
      refusal(() => parseRange(t));
    }
  });

  it('refuses a single address and points to manual', () => {
    expect(refusal(() => parseRange('10.0.5.20')).message).toMatch(/single address goes in manual/);
  });
});

describe('planRanges', () => {
  it('no ranges: an empty plan', () => {
    expect(planRanges(undefined, RULES)).toEqual({ ranges: [], intervals: [], totalHosts: 0 });
    expect(planRanges([], RULES)).toEqual({ ranges: [], intervals: [], totalHosts: 0 });
  });

  it('merges overlapping and touching entries and counts each address once', () => {
    const plan = planRanges(['10.0.5.0/25', '10.0.5.100-10.0.5.200', '10.0.5.201-10.0.5.210', '10.0.9.1-10.0.9.1'], RULES);
    // /25: .1-.126; dash .100-.200; touching .201-.210 -> one interval .1-.210, plus 10.0.9.1.
    expect(plan.intervals.map(([a, b]) => [formatIPv4(a), formatIPv4(b)])).toEqual([
      ['10.0.5.1', '10.0.5.210'], ['10.0.9.1', '10.0.9.1'],
    ]);
    expect(plan.totalHosts).toBe(211);
    expect(plan.ranges).toHaveLength(4);
  });

  it('the total cap counts distinct addresses after overlap removal', () => {
    // Two copies of a /24 = 254 distinct, under 256.
    expect(planRanges(['10.0.5.0/24', '10.0.5.0/24'], RULES).totalHosts).toBe(254);
    // Two different /24s = 508, above 256.
    const e = refusal(() => planRanges(['10.0.5.0/24', '10.0.6.0/24'], RULES));
    expect(e.field).toBe('ranges');
    expect(e.limit).toBe(256);
    expect(e.message).toMatch(/508 distinct addresses/);
  });

  it('a single entry above maxRangeHosts is refused before anything else, /0 included', () => {
    const e = refusal(() => planRanges(['10.0.0.0/23'], { ...RULES, maxRangeHosts: 100 }));
    expect(e.field).toBe('ranges[0]');
    expect(e.limit).toBe(100);
    expect(refusal(() => planRanges(['0.0.0.0/0'], { ...RULES, maxRangeHosts: 4096, allowPublicRanges: true })).message)
      .toMatch(/4294967294 addresses/);
  });

  it('maxRangeHosts 4096 admits a /20 (4094 hosts)', () => {
    expect(planRanges(['10.1.0.0/20'], { ...RULES, maxRangeHosts: 4096 }).totalHosts).toBe(4094);
  });

  it('refuses multicast, 0.0.0.0/8 and 240.0.0.0/4 even with allowPublicRanges', () => {
    const rules = { ...RULES, allowPublicRanges: true };
    expect(refusal(() => planRanges(['224.0.0.251-224.0.0.251'], rules)).message).toMatch(/multicast/);
    expect(refusal(() => planRanges(['239.255.255.0/24'], rules)).message).toMatch(/multicast/);
    expect(refusal(() => planRanges(['0.0.0.1-0.0.0.9'], rules)).message).toMatch(/0\.0\.0\.0\/8/);
    expect(refusal(() => planRanges(['255.255.255.255/32'], rules)).message).toMatch(/240\.0\.0\.0\/4/);
    expect(refusal(() => planRanges(['240.0.0.0/24'], rules)).message).toMatch(/reserved/);
    // A range that only touches a forbidden block at one end is refused too.
    expect(refusal(() => planRanges(['223.255.255.250-224.0.0.1'], rules)).field).toBe('ranges[0]');
  });

  it('refuses public addresses unless allowPublicRanges', () => {
    for (const t of ['192.0.2.0/24', '198.51.100.10-198.51.100.20', '203.0.113.5/32', '8.8.8.8/32']) {
      expect(refusal(() => planRanges([t], RULES)).message).toMatch(/allowPublicRanges/);
      expect(planRanges([t], { ...RULES, allowPublicRanges: true }).totalHosts).toBeGreaterThan(0);
    }
  });

  it('accepts every private, loopback and link-local block, and refuses a range straddling a block edge', () => {
    for (const t of ['10.255.255.0/24', '172.16.0.0/24', '172.31.255.0/24', '192.168.125.0/24', '127.0.0.1-127.0.0.1', '169.254.1.0/24']) {
      expect(planRanges([t], RULES).totalHosts, t).toBeGreaterThan(0);
    }
    for (const t of ['172.15.255.250-172.16.0.5', '172.32.0.0/24', '192.169.0.0/24', '9.255.255.255-10.0.0.1', '169.253.255.0/24']) {
      refusal(() => planRanges([t], RULES));
    }
  });

  it('loopbackOnly admits 127/8 only', () => {
    const rules = { ...RULES, loopbackOnly: true };
    expect(planRanges(['127.0.0.1-127.0.0.1'], rules).totalHosts).toBe(1);
    expect(planRanges(['127.0.0.0/24'], rules).totalHosts).toBe(254);
    const e = refusal(() => planRanges(['127.0.0.1-127.0.0.1', '10.0.5.0/30'], rules));
    expect(e.field).toBe('ranges[1]');
    expect(e.message).toMatch(/loopbackOnly/);
  });

  it(`at most ${MAX_RANGE_ENTRIES} entries`, () => {
    const ok = Array.from({ length: MAX_RANGE_ENTRIES }, (_, i) => `10.0.${i}.1-10.0.${i}.1`);
    expect(planRanges(ok, RULES).totalHosts).toBe(MAX_RANGE_ENTRIES);
    const e = refusal(() => planRanges([...ok, '10.0.99.1-10.0.99.1'], RULES));
    expect(e.field).toBe('ranges');
    expect(e.limit).toBe(MAX_RANGE_ENTRIES);
  });

  it('refuses a non-array', () => {
    refusal(() => planRanges('10.0.5.0/24', RULES));
  });

  it('names the failing entry by index', () => {
    expect(refusal(() => planRanges(['10.0.5.0/30', 'nonsense'], RULES)).field).toBe('ranges[1]');
  });
});

describe('rangeHosts', () => {
  it('yields each address once, in ascending order', () => {
    const plan = planRanges(['10.0.5.6-10.0.5.8', '10.0.5.0/30', '10.0.5.7/32'], RULES);
    expect([...rangeHosts(plan)]).toEqual(['10.0.5.1', '10.0.5.2', '10.0.5.6', '10.0.5.7', '10.0.5.8']);
  });

  it('crosses octet boundaries and is lazy', () => {
    const plan = planRanges(['10.0.4.254-10.0.5.1'], RULES);
    expect([...rangeHosts(plan)]).toEqual(['10.0.4.254', '10.0.4.255', '10.0.5.0', '10.0.5.1']);
    const big = planRanges(['10.1.0.0/20'], { ...RULES, maxRangeHosts: 4096 });
    const it = rangeHosts(big);
    expect(it.next().value).toBe('10.1.0.1');
  });

  it('a loopback single-address range plans exactly 127.0.0.1', () => {
    expect([...rangeHosts(planRanges(['127.0.0.1-127.0.0.1'], RULES))]).toEqual(['127.0.0.1']);
  });
});
