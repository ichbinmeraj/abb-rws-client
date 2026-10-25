import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MdnsController } from '../../src/MdnsDiscovery.js';
import type { ControllerSource, ProbeHit, ProbeOutcome } from '../../src/discovery/types.js';

// This PC's LAN address in these tests (RFC 5737 documentation address).
const LAN = '192.0.2.10';

const osMock = vi.hoisted(() => ({ networkInterfaces: vi.fn() }));
vi.mock('os', async importOriginal => ({ ...(await importOriginal<typeof import('os')>()), networkInterfaces: osMock.networkInterfaces }));

import { compareByAddress, mergeFound } from '../../src/discovery/merge.js';

beforeEach(() => {
  osMock.networkInterfaces.mockReset();
  osMock.networkInterfaces.mockReturnValue({
    eth0: [{ address: LAN, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: `${LAN}/24` }],
  });
});

const REALM = 'validusers@robapi.abb';
const isLocal = (h: string): boolean => h === 'localhost' || h === '::1' || h.startsWith('127.') || h === LAN;

function hit(
  host: string, port: number, https: boolean, source: ControllerSource,
  outcome: ProbeOutcome | 'basic' | 'digest',
  extra: Partial<ProbeHit['unit']> = {},
): ProbeHit {
  const o: ProbeOutcome = typeof outcome === 'string' ? { kind: 'rws', authType: outcome, realm: REALM } : outcome;
  const lane = host.startsWith('127.') || host === '::1' ? 'local' : 'remote';
  return { unit: { host, port, https, lane, source, ...extra }, outcome: o };
}

const mdns = (
  systemName: string, host: string, port: number,
  extra: Partial<MdnsController> = {},
): MdnsController => ({
  instanceName: `RobotWebServices_${systemName}`, systemName, host, port, probableProtocol: 'rws2', ...extra,
});

describe('mergeFound: same key', () => {
  // Three VCs on this PC, each seen by the listening-port probe on 127.0.0.1 and by mDNS on the
  // PC's LAN address (the shape seen on 2026-09-23, addresses replaced).
  const HITS = [
    hit('127.0.0.1', 5466, true, 'this-pc', 'basic', { pid: 4100 }),
    hit('127.0.0.1', 9403, true, 'this-pc', 'basic', { pid: 4200 }),
    hit('127.0.0.1', 33806, false, 'this-pc', 'digest', { pid: 4300 }),
  ];
  const MDNS = [
    mdns('CRB1910_10_1520', LAN, 5466, { rwVersion: '8.1.1' }),
    mdns('IRB1600_6_120_1', LAN, 9403, { rwVersion: '7.21.0', sysGuid: '{AAAA}' }),
    mdns('IRB1600_6_145', LAN, 33806, { probableProtocol: 'rws1' }),
  ];

  it('shows a VC seen by the port scan and by mDNS once, with the probed protocol and the announced name', () => {
    const out = mergeFound({ hits: HITS, mdns: MDNS, isLocal });
    expect(out).toHaveLength(3);
    expect(out.map(c => c.key)).toEqual(['local:5466', 'local:9403', 'local:33806']);
    expect(out[1]).toEqual({
      key: 'local:9403', host: '127.0.0.1', port: 9403, https: true,
      generation: 'rws2', authType: 'basic',
      probe: { host: '127.0.0.1', port: 9403, useHttps: true, authType: 'basic' },
      identified: true, realm: REALM,
      systemName: 'IRB1600_6_120_1', rwVersion: '7.21.0', systemId: '{AAAA}',
      sources: ['this-pc', 'mdns'],
      process: { pid: 4200 },
    });
    expect(out[2]).toMatchObject({ generation: 'rws1', authType: 'digest', https: false, systemName: 'IRB1600_6_145' });
  });

  it('reads this PC\'s addresses from the interface list when no checker is given', () => {
    const out = mergeFound({ hits: HITS, mdns: MDNS });
    expect(out).toHaveLength(3);
    expect(out.every(c => c.sources.join() === 'this-pc,mdns')).toBe(true);
    expect(osMock.networkInterfaces).toHaveBeenCalledTimes(1);
  });

  it('unites sources when two of them reach the same listener', () => {
    const out = mergeFound({
      hits: [
        hit('127.0.0.1', 9403, true, 'this-pc', 'basic', { pid: 4200 }),
        hit('127.0.0.1', 9403, true, 'manual', 'basic', { name: 'localhost' }),
        hit('127.0.0.1', 9403, true, 'range', 'basic'),
      ],
      isLocal,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ host: '127.0.0.1', name: 'localhost', sources: ['this-pc', 'manual', 'range'], process: { pid: 4200 } });
  });

  it('labels the service address, manual hosts and ranges by how they were found', () => {
    const out = mergeFound({
      hits: [
        hit('192.168.125.1', 443, true, 'service-address', 'basic'),
        hit('198.51.100.7', 80, false, 'manual', 'digest', { name: 'cell7.example' }),
        hit('203.0.113.5', 443, true, 'range', 'basic'),
      ],
      isLocal,
    });
    expect(out.map(c => [c.key, c.sources])).toEqual([
      ['192.168.125.1:443', ['service-address']],
      ['198.51.100.7:80', ['manual']],
      ['203.0.113.5:443', ['range']],
    ]);
    expect(out[1]).toMatchObject({ name: 'cell7.example', generation: 'rws1', https: false });
  });

  it('keeps one address per listener: RWS realm over a foreign 401, HTTPS over HTTP, IPv4 over ::1', () => {
    const out = mergeFound({
      hits: [
        hit('198.51.100.7', 80, false, 'manual', { kind: 'other-401', authType: 'basic', realm: 'router' }),
        hit('198.51.100.7', 80, false, 'manual', 'digest', { fallback: true }),
        hit('203.0.113.5', 80, false, 'range', 'basic', { fallback: true }),
        hit('203.0.113.5', 80, true, 'range', 'basic'),
        hit('::1', 5466, true, 'this-pc', 'basic', { pid: 1 }),
        hit('127.0.0.1', 5466, true, 'this-pc', 'basic', { pid: 1 }),
      ],
      isLocal,
    });
    expect(out.map(c => [c.key, c.host, c.https, c.identified])).toEqual([
      ['local:5466', '127.0.0.1', true, true],
      ['198.51.100.7:80', '198.51.100.7', false, true],
      ['203.0.113.5:80', '203.0.113.5', true, true],
    ]);
    expect(out[1].realm).toBe(REALM);
  });

  it('keeps a ::1-only listener on ::1', () => {
    const out = mergeFound({ hits: [hit('::1', 5466, true, 'this-pc', 'basic', { pid: 9 })], isLocal });
    expect(out[0]).toMatchObject({ key: 'local:5466', host: '::1', probe: { host: '::1' } });
  });
});

describe('mergeFound: what becomes an entry', () => {
  it('ignores every outcome that is not a Digest or Basic 401', () => {
    const outcomes: ProbeOutcome[] = [
      { kind: 'not-rws' }, { kind: 'tls-failed' }, { kind: 'tls-unverified', error: 'self-signed' },
      { kind: 'refused' }, { kind: 'timeout' }, { kind: 'aborted' },
    ];
    const hits = outcomes.map((o, i) => hit('203.0.113.5', 1000 + i, true, 'range', o));
    expect(mergeFound({ hits, isLocal })).toEqual([]);
  });

  it('lists a 401 from a foreign realm as not identified, with no generation claimed', () => {
    const out = mergeFound({
      hits: [hit('203.0.113.5', 443, true, 'range', { kind: 'other-401', authType: 'basic', realm: 'Camera' })],
      isLocal,
    });
    expect(out[0]).toMatchObject({
      identified: false, generation: null, authType: 'basic', realm: 'Camera',
      probe: { host: '203.0.113.5', port: 443, useHttps: true, authType: 'basic' },
    });
  });

  it('keeps an mDNS-only controller with nothing probed and the generation as the announcement suggests', () => {
    const out = mergeFound({
      hits: [],
      mdns: [
        mdns('CELL_7', '198.51.100.7', 443, { rwVersion: '7.21.0' }),
        mdns('ODD', '198.51.100.8', 443, { probableProtocol: 'unknown' }),
      ],
      isLocal,
    });
    expect(out[0]).toEqual({
      key: '198.51.100.7:443', host: '198.51.100.7', port: 443, https: null,
      generation: 'rws2', authType: null, probe: null, identified: false,
      systemName: 'CELL_7', rwVersion: '7.21.0', sources: ['mdns'],
    });
    expect(out[1]).toMatchObject({ generation: null, identified: false });
  });

  it('records the certificate fingerprint for HTTPS entries only', () => {
    const out = mergeFound({
      hits: [
        hit('203.0.113.5', 443, true, 'range', { kind: 'rws', authType: 'basic', realm: REALM, tlsFingerprint: 'ab'.repeat(32) }),
        hit('203.0.113.6', 80, false, 'range', { kind: 'rws', authType: 'digest', realm: REALM, tlsFingerprint: 'cd'.repeat(32) }),
      ],
      isLocal,
    });
    expect(out[0].tlsFingerprint).toBe('ab'.repeat(32));
    expect(out[1].tlsFingerprint).toBeUndefined();
  });
});

describe('mergeFound: enrichment', () => {
  it('marks entries owned by a RobotStudio VC process, case-insensitively', () => {
    const out = mergeFound({
      hits: [
        hit('127.0.0.1', 5466, true, 'this-pc', 'basic', { pid: 10 }),
        hit('127.0.0.1', 39127, false, 'this-pc', 'digest', { pid: 11 }),
        hit('127.0.0.1', 8080, false, 'this-pc', 'basic', { pid: 12 }),
        hit('127.0.0.1', 8081, false, 'this-pc', 'basic', { pid: 13 }),
      ],
      pidImages: new Map<number, string>([[10, 'Vrchost64.exe'], [11, 'robvc.exe'], [12, 'node.exe']]),
      isLocal,
    });
    expect(out.map(c => [c.port, c.process, c.isVirtual])).toEqual([
      [5466, { pid: 10, image: 'Vrchost64.exe' }, true],
      [8080, { pid: 12, image: 'node.exe' }, false],
      [8081, { pid: 13 }, undefined],
      [39127, { pid: 11, image: 'robvc.exe' }, true],
    ]);
  });

  it('prefers the local system folder over mDNS TXT, and a login over both', () => {
    const hits = [
      hit('127.0.0.1', 9805, true, 'this-pc', 'basic', { pid: 20 }),
      hit('127.0.0.1', 9403, true, 'this-pc', 'basic', { pid: 21 }),
    ];
    const out = mergeFound({
      hits,
      mdns: [mdns('OLD_NAME', LAN, 9805, { rwVersion: '8.2.0' }), mdns('IRB1600_6_120_5', LAN, 9403, { rwVersion: '7.21.4' })],
      vcDetails: [{ pid: 20, image: 'Vrchost64.exe', systemName: 'IRB1600_6_120_4', rwVersion: '8.2.1+1023' }],
      identities: [
        { key: 'local:9403', status: 'identified', generation: 'rws2', systemName: 'IRB1600_6_120_5', rwVersion: '7.21.4+417', systemId: 'id-5', robotType: 'IRB 1600-6/1.2' },
        { key: 'local:9805', status: 'skipped', note: 'no credentials' },
      ],
      isLocal,
    });
    expect(out[0]).toMatchObject({ port: 9403, rwVersion: '7.21.4+417', systemId: 'id-5', robotType: 'IRB 1600-6/1.2', identified: true });
    expect(out[1]).toMatchObject({
      port: 9805, systemName: 'IRB1600_6_120_4', rwVersion: '8.2.1+1023',
      process: { pid: 20, image: 'Vrchost64.exe' }, isVirtual: true,
    });
    expect(out[1].robotType).toBeUndefined();
  });

  it('a login identifies an entry that only had a foreign realm, and sets its generation', () => {
    const out = mergeFound({
      hits: [hit('203.0.113.5', 443, true, 'manual', { kind: 'other-401', authType: 'basic', realm: 'x' })],
      identities: [{ key: '203.0.113.5:443', status: 'identified', generation: 'rws2' }],
      isLocal,
    });
    expect(out[0]).toMatchObject({ identified: true, generation: 'rws2' });
  });

  it('does not change its input and gives the same answer twice', () => {
    const input = {
      hits: [hit('127.0.0.1', 9403, true, 'this-pc' as const, 'basic' as const, { pid: 1 })],
      mdns: [mdns('A', LAN, 9403)],
      isLocal,
    };
    const snapshot = JSON.stringify(input);
    const a = mergeFound(input);
    const b = mergeFound(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('mergeFound: folding by system id', () => {
  it('folds one controller seen on the service address and on its LAN address', () => {
    const out = mergeFound({
      hits: [
        hit('192.168.125.1', 443, true, 'service-address', 'basic'),
        hit('198.51.100.7', 443, true, 'manual', 'basic'),
      ],
      identities: [
        { key: '192.168.125.1:443', status: 'identified', systemId: '{1B2C-DEAD}', systemName: 'CELL_7' },
        { key: '198.51.100.7:443', status: 'identified', systemId: '1b2c-dead', systemName: 'CELL_7' },
      ],
      isLocal,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: '192.168.125.1:443', host: '192.168.125.1', systemId: '{1B2C-DEAD}',
      sources: ['service-address', 'manual'],
      addresses: [{ host: '198.51.100.7', port: 443, https: true, sources: ['manual'] }],
    });
  });

  it('shows a probed address rather than an mDNS-only one, and fills fields from the folded entry', () => {
    const out = mergeFound({
      hits: [hit('203.0.113.5', 443, true, 'range', 'basic')],
      mdns: [mdns('CELL_9', '198.51.100.9', 443, { sysGuid: 'g-9', rwVersion: '7.21.0' })],
      identities: [{ key: '203.0.113.5:443', status: 'identified', systemId: 'G-9' }],
      isLocal,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      host: '203.0.113.5', https: true, identified: true, systemName: 'CELL_9', rwVersion: '7.21.0',
      sources: ['range', 'mdns'],
      addresses: [{ host: '198.51.100.9', port: 443, https: null, sources: ['mdns'] }],
    });
  });

  it('keeps entries without a system id apart', () => {
    const out = mergeFound({
      hits: [hit('198.51.100.7', 443, true, 'manual', 'basic'), hit('198.51.100.8', 443, true, 'manual', 'basic')],
      mdns: [mdns('SAME', '198.51.100.7', 443), mdns('SAME', '198.51.100.8', 443)],
      isLocal,
    });
    expect(out).toHaveLength(2);
    expect(out.every(c => c.addresses === undefined)).toBe(true);
  });

  it('keeps cloned VCs that share a system id apart', () => {
    // VCs cloned from one template share their system id; each is its own controller.
    const out = mergeFound({
      hits: [
        hit('127.0.0.1', 5466, true, 'this-pc', 'basic'),
        hit('127.0.0.1', 9403, true, 'this-pc', 'basic'),
        hit('198.51.100.20', 7001, true, 'range', 'basic'),
        hit('198.51.100.20', 7002, true, 'range', 'basic'),
        hit('198.51.100.21', 7003, true, 'range', 'basic'),
      ],
      mdns: [
        mdns('CLONE', LAN, 5466, { sysGuid: 'shared' }),
        mdns('CLONE', LAN, 9403, { sysGuid: 'shared' }),
        mdns('CLONE', '198.51.100.20', 7001, { sysGuid: 'shared' }),
        mdns('CLONE', '198.51.100.20', 7002, { sysGuid: 'shared' }),
        mdns('CLONE', '198.51.100.21', 7003, { sysGuid: 'shared' }),
        mdns('CLONE', '198.51.100.22', 5466, { sysGuid: 'shared' }),
      ],
      isLocal,
    });
    expect(out.map(c => c.key)).toEqual([
      'local:5466', 'local:9403', '198.51.100.20:7001', '198.51.100.20:7002', '198.51.100.21:7003', '198.51.100.22:5466',
    ]);
    expect(out.every(c => c.addresses === undefined)).toBe(true);
  });

  it('does not fold entries whose system names differ', () => {
    const out = mergeFound({
      hits: [],
      mdns: [mdns('A', '198.51.100.7', 443, { sysGuid: 'x' }), mdns('B', '198.51.100.8', 443, { sysGuid: 'x' })],
      isLocal,
    });
    expect(out).toHaveLength(2);
  });

  it('folds a third address into the same entry and orders the extra addresses', () => {
    const out = mergeFound({
      hits: [hit('203.0.113.9', 443, true, 'range', 'basic')],
      mdns: [mdns('C', '198.51.100.9', 443, { sysGuid: 'z' }), mdns('C', '198.51.100.3', 443, { sysGuid: 'z' })],
      identities: [{ key: '203.0.113.9:443', status: 'identified', systemId: 'z' }],
      isLocal,
    });
    expect(out).toHaveLength(1);
    expect(out[0].host).toBe('203.0.113.9');
    expect(out[0].addresses?.map(a => a.host)).toEqual(['198.51.100.3', '198.51.100.9']);
  });
});

describe('order', () => {
  it('this PC first by port, then other hosts by numeric IPv4 and port, mDNS-only rows included', () => {
    const out = mergeFound({
      hits: [
        hit('198.51.100.1', 443, true, 'range', 'basic'),
        hit('192.0.2.9', 80, false, 'range', 'digest'),
        hit('127.0.0.1', 9805, true, 'this-pc', 'basic'),
        hit('192.0.2.200', 443, true, 'manual', 'basic'),
        hit('127.0.0.1', 80, true, 'this-pc', 'basic'),
        hit('192.0.2.9', 443, true, 'range', 'basic'),
      ],
      mdns: [mdns('M', '192.0.2.50', 443), mdns('L', LAN, 5466)],
      isLocal,
    });
    expect(out.map(c => c.key)).toEqual([
      'local:80', 'local:5466', 'local:9805',
      '192.0.2.9:80', '192.0.2.9:443', '192.0.2.50:443', '192.0.2.200:443', '198.51.100.1:443',
    ]);
  });

  it('compareByAddress puts hosts that are not IPv4 literals after IPv4, by text', () => {
    const rows = [
      { key: 'robot.example:443', host: 'robot.example', port: 443 },
      { key: '203.0.113.1:443', host: '203.0.113.1', port: 443 },
      { key: 'arm.example:443', host: 'arm.example', port: 443 },
      { key: 'local:1', host: '127.0.0.1', port: 1 },
    ];
    expect([...rows].sort(compareByAddress).map(r => r.host)).toEqual(['127.0.0.1', '203.0.113.1', 'arm.example', 'robot.example']);
  });
});
