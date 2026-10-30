import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeModuleLatin1 } from '../src/moduleEncoding.js';
import { RwsClient } from '../src/RwsClient.js';

/**
 * The bytes a controller reads a module file in: one per character, the
 * Latin-1 range (RobotWare 6.16.03, 7.21.4 and 8.2.1, 2026-10-30).
 */
describe('encodeModuleLatin1', () => {
  it('ASCII comes back byte for byte and says so', () => {
    const r = encodeModuleLatin1('MODULE A\r\nENDMODULE\n');
    expect('bytes' in r && r.ascii).toBe(true);
    expect('bytes' in r && Buffer.from(r.bytes).toString('latin1')).toBe('MODULE A\r\nENDMODULE\n');
  });

  it('U+00A0 to U+00FF go as one byte each', () => {
    const r = encodeModuleLatin1('\u00A0\u00E4\u00FF');
    expect('bytes' in r && [...r.bytes]).toEqual([0xa0, 0xe4, 0xff]);
    expect('bytes' in r && r.ascii).toBe(false);
  });

  it('NUL passes, as it did before', () => {
    const r = encodeModuleLatin1('a\u0000b');
    expect('bytes' in r && [...r.bytes]).toEqual([0x61, 0x00, 0x62]);
  });

  it('the first character that cannot be sent, by line and column, for LF, CRLF and lone CR', () => {
    expect(encodeModuleLatin1('ab\ncd\u0100')).toEqual({ fault: { line: 2, column: 3, codePoint: 0x100 } });
    expect(encodeModuleLatin1('ab\r\ncd\r\n\u0080')).toEqual({ fault: { line: 3, column: 1, codePoint: 0x80 } });
    expect(encodeModuleLatin1('a\rb\rc\u009F')).toEqual({ fault: { line: 3, column: 2, codePoint: 0x9f } });
    expect(encodeModuleLatin1('\u{1F600}')).toEqual({ fault: { line: 1, column: 1, codePoint: 0x1f600 } });
  });
});

describe('RWS 1.0 uploadFile sends a string as UTF-8 and bytes as they are', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a string as its UTF-8 bytes, a Uint8Array unchanged', async () => {
    const client = new RwsClient({ host: '127.0.0.1', port: 1, username: 'u', password: 'p' });
    const bodies: Array<string | Uint8Array> = [];
    (client as unknown as { session: unknown }).session = {
      put: async (_path: string, body: string | Uint8Array) => { bodies.push(body); return { status: 201, body: '', headers: new Headers() }; },
    };
    await client.uploadFile('$HOME/A.mod', 'ä');
    await client.uploadFile('$HOME/A.mod', new Uint8Array([0xe4]));
    expect([...(bodies[0] as Uint8Array)]).toEqual([0xc3, 0xa4]);
    expect([...(bodies[1] as Uint8Array)]).toEqual([0xe4]);
  });
});
