import { describe, it, expect } from 'vitest';
import { discoverControllersMdns } from '../src/MdnsDiscovery.js';
import type { MdnsSocket } from '../src/MdnsDiscovery.js';

// ─── DNS response builder (hand-rolled, with name compression) ───────────────

/**
 * Builds mDNS response packets the way real responders emit them: answers
 * first, then additionals, with name-compression pointers and the mDNS
 * cache-flush bit (0x8001) set on record classes.
 */
class DnsResponseBuilder {
  private buf = Buffer.alloc(4096);
  private pos = 12;
  private counts = { an: 0, ns: 0, ar: 0 };
  private section: 'an' | 'ns' | 'ar' = 'an';
  private comp = new Map<string, number>();
  private rdlenPos = 0;

  constructor(id = 0) {
    this.buf.writeUInt16BE(id, 0);
    this.buf.writeUInt16BE(0x8400, 2); // QR=1 (response), AA=1
  }

  /** Switch record section (records must be added in an → ns → ar order). */
  in(section: 'an' | 'ns' | 'ar'): this { this.section = section; return this; }

  /** Write a domain name, compressing against every name written so far. */
  private name(n: string): void {
    const labels = n.split('.');
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.').toLowerCase();
      const ptr = this.comp.get(suffix);
      if (ptr !== undefined) {
        this.buf.writeUInt16BE(0xc000 | ptr, this.pos);
        this.pos += 2;
        return;
      }
      if (this.pos < 0x4000) { this.comp.set(suffix, this.pos); }
      const lb = Buffer.from(labels[i], 'utf8');
      this.buf[this.pos++] = lb.length;
      lb.copy(this.buf, this.pos);
      this.pos += lb.length;
    }
    this.buf[this.pos++] = 0;
  }

  private rrStart(owner: string, type: number): void {
    this.name(owner);
    this.buf.writeUInt16BE(type, this.pos); this.pos += 2;
    this.buf.writeUInt16BE(0x8001, this.pos); this.pos += 2; // IN + cache-flush
    this.buf.writeUInt32BE(120, this.pos); this.pos += 4;
    this.rdlenPos = this.pos; this.pos += 2;
  }

  private rrEnd(): void {
    this.buf.writeUInt16BE(this.pos - this.rdlenPos - 2, this.rdlenPos);
    this.counts[this.section]++;
  }

  ptr(owner: string, target: string): this {
    this.rrStart(owner, 12);
    this.name(target);
    this.rrEnd();
    return this;
  }

  srv(owner: string, port: number, target: string): this {
    this.rrStart(owner, 33);
    this.buf.writeUInt16BE(0, this.pos); this.pos += 2; // priority
    this.buf.writeUInt16BE(0, this.pos); this.pos += 2; // weight
    this.buf.writeUInt16BE(port, this.pos); this.pos += 2;
    this.name(target);
    this.rrEnd();
    return this;
  }

  txt(owner: string, entries: string[]): this {
    this.rrStart(owner, 16);
    for (const e of entries) {
      const eb = Buffer.from(e, 'utf8');
      this.buf[this.pos++] = eb.length;
      eb.copy(this.buf, this.pos);
      this.pos += eb.length;
    }
    this.rrEnd();
    return this;
  }

  a(owner: string, ip: string): this {
    this.rrStart(owner, 1);
    for (const octet of ip.split('.')) { this.buf[this.pos++] = parseInt(octet, 10); }
    this.rrEnd();
    return this;
  }

  build(): Buffer {
    this.buf.writeUInt16BE(this.counts.an, 6);
    this.buf.writeUInt16BE(this.counts.ns, 8);
    this.buf.writeUInt16BE(this.counts.ar, 10);
    return Buffer.from(this.buf.subarray(0, this.pos));
  }
}

// ─── Fake socket ──────────────────────────────────────────────────────────────

class FakeSocket implements MdnsSocket {
  sent: { msg: Buffer; port: number; address: string }[] = [];
  multicastInterfaces: string[] = [];
  closed = false;
  private listeners = new Map<string, ((...args: never[]) => void)[]>();

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }
  bind(_port: number, _address: string, cb: () => void): void { cb(); }
  send(msg: Uint8Array, port: number, address: string, cb?: (err: Error | null) => void): void {
    this.sent.push({ msg: Buffer.from(msg), port, address });
    cb?.(null);
  }
  setMulticastInterface(addr: string): void { this.multicastInterfaces.push(addr); }
  close(): void { this.closed = true; }

  emitMessage(buf: Buffer, address = '127.0.0.1'): void {
    for (const cb of this.listeners.get('message') ?? []) {
      (cb as (msg: Buffer, rinfo: { address: string; port: number }) => void)(buf, { address, port: 5353 });
    }
  }
  emitError(err: Error): void {
    for (const cb of this.listeners.get('error') ?? []) {
      (cb as (err: Error) => void)(err);
    }
  }
}

function discover(fake: FakeSocket, timeoutMs = 30): ReturnType<typeof discoverControllersMdns> {
  return discoverControllersMdns({ timeoutMs, socketFactory: () => fake, interfaceAddrs: [] });
}

const SVC = '_http._tcp.local';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MdnsDiscovery', () => {
  it('sends PTR queries for the rws subtype and the _http fallback to 224.0.0.251:5353', async () => {
    const fake = new FakeSocket();
    await discover(fake, 10);
    expect(fake.sent.length).toBeGreaterThanOrEqual(2);
    for (const s of fake.sent) {
      expect(s.address).toBe('224.0.0.251');
      expect(s.port).toBe(5353);
      // standard query header: QR=0, QDCOUNT=1
      expect(s.msg.readUInt16BE(2) & 0x8000).toBe(0);
      expect(s.msg.readUInt16BE(4)).toBe(1);
    }
    const names = fake.sent.map(s => s.msg.toString('latin1'));
    expect(names.some(n => n.includes('rws') && n.includes('_sub'))).toBe(true);
    expect(names.some(n => n.includes('_http') && !n.includes('_sub'))).toBe(true);
    expect(fake.closed).toBe(true);
  });

  it('parses an RW7-style reply (PTR+SRV+TXT+A, compressed names) into a full MdnsController', async () => {
    const fake = new FakeSocket();
    const pkt = new DnsResponseBuilder()
      .ptr(`rws._sub.${SVC}`, `RobotWebServices_Omni1.${SVC}`)
      .srv(`RobotWebServices_Omni1.${SVC}`, 5466, 'DESKTOP-VC.local')
      .txt(`RobotWebServices_Omni1.${SVC}`, [
        'RwVer=7.21.0',
        'SysGuid={8a3e0f9e-1111-2222-3333-444455556666}',
        'RwsPort=5466',
        'RobApiP=2558',
        'WanIp=',
        'VC=',
      ])
      .in('ar')
      .a('DESKTOP-VC.local', '192.168.70.149')
      .build();

    const promise = discover(fake);
    fake.emitMessage(pkt, '192.168.70.149');
    const found = await promise;

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      instanceName: 'RobotWebServices_Omni1',
      systemName: 'Omni1',
      host: '192.168.70.149',
      port: 5466,
      rwVersion: '7.21.0',
      sysGuid: '{8a3e0f9e-1111-2222-3333-444455556666}',
      robApiPort: 2558,
      probableProtocol: 'rws2',
    });
  });

  it('parses an RW6-style reply (no TXT, no A) using the responder source address', async () => {
    const fake = new FakeSocket();
    const pkt = new DnsResponseBuilder()
      .ptr(SVC, `RobotWebServices_IRC5_A.${SVC}`)
      .srv(`RobotWebServices_IRC5_A.${SVC}`, 23308, 'DESKTOP-VC.local')
      .build();

    const promise = discover(fake);
    fake.emitMessage(pkt, '127.0.0.1');
    const found = await promise;

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      instanceName: 'RobotWebServices_IRC5_A',
      systemName: 'IRC5_A',
      host: '127.0.0.1',
      port: 23308,
      probableProtocol: 'rws1',
    });
  });

  it('ignores non-ABB _http._tcp instances', async () => {
    const fake = new FakeSocket();
    const pkt = new DnsResponseBuilder()
      .ptr(SVC, `SomePrinter.${SVC}`)
      .srv(`SomePrinter.${SVC}`, 631, 'printer.local')
      .build();

    const promise = discover(fake);
    fake.emitMessage(pkt);
    expect(await promise).toEqual([]);
  });

  it('dedupes an instance answered on both the subtype and the base service', async () => {
    const fake = new FakeSocket();
    const pkt1 = new DnsResponseBuilder()
      .ptr(`rws._sub.${SVC}`, `RobotWebServices_Omni1.${SVC}`)
      .srv(`RobotWebServices_Omni1.${SVC}`, 5466, 'DESKTOP-VC.local')
      .txt(`RobotWebServices_Omni1.${SVC}`, ['RwVer=7.21.0', 'RwsPort=5466'])
      .build();
    const pkt2 = new DnsResponseBuilder()
      .ptr(SVC, `RobotWebServices_Omni1.${SVC}`)
      .srv(`RobotWebServices_Omni1.${SVC}`, 5466, 'DESKTOP-VC.local')
      .build();

    const promise = discover(fake);
    fake.emitMessage(pkt1, '192.168.70.149');
    fake.emitMessage(pkt2, '192.168.70.149');
    const found = await promise;
    expect(found).toHaveLength(1);
    expect(found[0].probableProtocol).toBe('rws2');
  });

  it('aggregates SRV/TXT/A arriving in separate packets', async () => {
    const fake = new FakeSocket();
    const pkt1 = new DnsResponseBuilder()
      .ptr(`rws._sub.${SVC}`, `RobotWebServices_Omni2.${SVC}`)
      .build();
    const pkt2 = new DnsResponseBuilder()
      .srv(`RobotWebServices_Omni2.${SVC}`, 9805, 'DESKTOP-VC.local')
      .txt(`RobotWebServices_Omni2.${SVC}`, ['RwVer=7.21.0', 'RwsPort=9805'])
      .in('ar')
      .a('DESKTOP-VC.local', '10.0.0.5')
      .build();

    const promise = discover(fake);
    fake.emitMessage(pkt1, '10.0.0.5');
    fake.emitMessage(pkt2, '10.0.0.5');
    const found = await promise;
    expect(found).toHaveLength(1);
    expect(found[0].host).toBe('10.0.0.5');
    expect(found[0].port).toBe(9805);
  });

  it('classifies TXT without RwsPort/RwVer as unknown', async () => {
    const fake = new FakeSocket();
    const pkt = new DnsResponseBuilder()
      .ptr(SVC, `RobotWebServices_X.${SVC}`)
      .srv(`RobotWebServices_X.${SVC}`, 8080, 'h.local')
      .txt(`RobotWebServices_X.${SVC}`, ['foo=bar'])
      .build();

    const promise = discover(fake);
    fake.emitMessage(pkt);
    const found = await promise;
    expect(found[0].probableProtocol).toBe('unknown');
  });

  it('treats an empty TXT record like no TXT (rws1)', async () => {
    const fake = new FakeSocket();
    const pkt = new DnsResponseBuilder()
      .ptr(SVC, `RobotWebServices_Y.${SVC}`)
      .srv(`RobotWebServices_Y.${SVC}`, 80, 'h.local')
      .txt(`RobotWebServices_Y.${SVC}`, [''])
      .build();

    const promise = discover(fake);
    fake.emitMessage(pkt);
    const found = await promise;
    expect(found[0].probableProtocol).toBe('rws1');
  });

  it('survives malformed packets (garbage, truncation, pointer loops) without throwing', async () => {
    const fake = new FakeSocket();
    const good = new DnsResponseBuilder()
      .ptr(SVC, `RobotWebServices_Z.${SVC}`)
      .srv(`RobotWebServices_Z.${SVC}`, 1234, 'h.local')
      .build();

    // pointer loop: header claims one answer whose name points at itself
    const loop = Buffer.alloc(14);
    loop.writeUInt16BE(0x8400, 2);
    loop.writeUInt16BE(1, 6);
    loop.writeUInt16BE(0xc00c, 12);

    const promise = discover(fake);
    fake.emitMessage(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    fake.emitMessage(Buffer.alloc(0));
    fake.emitMessage(good.subarray(0, 20)); // truncated mid-record
    fake.emitMessage(loop);
    fake.emitMessage(good);
    const found = await promise;
    expect(found).toHaveLength(1);
    expect(found[0].instanceName).toBe('RobotWebServices_Z');
  });

  it('skips instances that never produced a port', async () => {
    const fake = new FakeSocket();
    const pkt = new DnsResponseBuilder()
      .ptr(SVC, `RobotWebServices_NoSrv.${SVC}`)
      .build();

    const promise = discover(fake);
    fake.emitMessage(pkt);
    expect(await promise).toEqual([]);
  });

  it('resolves with what it has when the socket errors', async () => {
    const fake = new FakeSocket();
    const promise = discover(fake, 5000);
    fake.emitError(new Error('EACCES'));
    expect(await promise).toEqual([]);
    expect(fake.closed).toBe(true);
  });

  it('retries the query through each supplied interface address', async () => {
    const fake = new FakeSocket();
    await discoverControllersMdns({
      timeoutMs: 10,
      socketFactory: () => fake,
      interfaceAddrs: ['192.168.70.149', '10.0.0.5'],
    });
    expect(fake.multicastInterfaces).toEqual(['192.168.70.149', '10.0.0.5']);
    // 2 queries × (1 default send + 2 interface sends) = 6
    expect(fake.sent).toHaveLength(6);
  });
});
