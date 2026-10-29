import { describe, it, expect } from 'vitest';
import { decodeUtf8Strict } from '../src/utf8.js';

const bytes = (...parts: Array<string | number[]>): Uint8Array =>
  Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));

describe('decodeUtf8Strict', () => {
  it('decodes valid UTF-8 as Buffer.toString does, non-ASCII and four-byte characters included', () => {
    const b = bytes('MODULE M\r\n  ! Größe 20 °C, ½ Hub, 🤖\r\nENDMODULE\r\n');
    expect(decodeUtf8Strict(b)).toEqual({ text: Buffer.from(b).toString('utf8') });
  });

  it('decodes an empty file to empty text', () => {
    expect(decodeUtf8Strict(new Uint8Array(0))).toEqual({ text: '' });
  });

  it('keeps a byte order mark as U+FEFF, as readFileSync(file, "utf8") does', () => {
    const b = bytes([0xef, 0xbb, 0xbf], 'MODULE M\nENDMODULE\n');
    expect(decodeUtf8Strict(b)).toEqual({ text: '﻿MODULE M\nENDMODULE\n' });
    expect(decodeUtf8Strict(b)).toEqual({ text: Buffer.from(b).toString('utf8') });
  });

  it('a Latin-1 file: the line and the first byte of its first bad sequence', () => {
    const b = Buffer.from('MODULE M\n  ! ok\n  ! Größe\nENDMODULE\n', 'latin1');
    expect(decodeUtf8Strict(b)).toEqual({ fault: { line: 3, byte: 0xf6 } });
  });

  it('a Latin-1 é before ASCII: the é is named, not the byte where the decoder stopped', () => {
    // 0xE9 starts a three-byte sequence, so the decoder refuses at the space after it.
    expect(decodeUtf8Strict(Buffer.from('! caf\xe9 run\n', 'latin1'))).toEqual({ fault: { line: 1, byte: 0xe9 } });
  });

  it('counts lines over CRLF and over the valid multi-byte characters before the fault', () => {
    const b = bytes('é\r\nü\r\n½ ', [0x93, 0x41], '\r\n');
    expect(decodeUtf8Strict(b)).toEqual({ fault: { line: 3, byte: 0x93 } });
  });

  it('a sequence cut by a line feed is placed on its own line', () => {
    expect(decodeUtf8Strict(bytes('a', [0xc3], '\nb'))).toEqual({ fault: { line: 1, byte: 0xc3 } });
  });

  it('a file that ends inside a character: the line of its first byte', () => {
    expect(decodeUtf8Strict(bytes('a\nb\n', [0xe2, 0x82]))).toEqual({ fault: { line: 3, byte: 0xe2 } });
  });

  it('refuses encoded surrogates and overlong forms, as TextDecoder does', () => {
    expect(decodeUtf8Strict(bytes('x', [0xed, 0xa0, 0x80]))).toEqual({ fault: { line: 1, byte: 0xed } });
    expect(decodeUtf8Strict(bytes([0xc0, 0xaf]))).toEqual({ fault: { line: 1, byte: 0xc0 } });
  });

  it('a UTF-16 file with its byte order mark is refused at line 1', () => {
    expect(decodeUtf8Strict(Buffer.from('﻿MODULE M', 'utf16le'))).toEqual({ fault: { line: 1, byte: 0xff } });
  });

  it('counts a line ending of CR alone, as well as LF and CRLF', () => {
    expect(decodeUtf8Strict(bytes('a\rb\r\nc\nd', [0xff]))).toEqual({ fault: { line: 4, byte: 0xff } });
    expect(decodeUtf8Strict(bytes('a\r', [0xff]))).toEqual({ fault: { line: 2, byte: 0xff } });
  });

  it('a bad sequence that begins with the replacement character\'s own bytes (EF, EF BF) is placed at its start', () => {
    expect(decodeUtf8Strict(bytes('a\n', [0xef], 'x'))).toEqual({ fault: { line: 2, byte: 0xef } });
    expect(decodeUtf8Strict(bytes('a\n', [0xef, 0xbf], 'x'))).toEqual({ fault: { line: 2, byte: 0xef } });
    expect(decodeUtf8Strict(bytes('a\n', [0xef, 0xbf]))).toEqual({ fault: { line: 2, byte: 0xef } });
  });

  it('a valid U+FFFD in the file is text, and a fault after it is still found', () => {
    expect(decodeUtf8Strict(bytes('! � ok\n'))).toEqual({ text: '! � ok\n' });
    expect(decodeUtf8Strict(bytes('�', [0xc3], 'x'))).toEqual({ fault: { line: 1, byte: 0xc3 } });
    expect(decodeUtf8Strict(bytes('�', [0xef], 'x'))).toEqual({ fault: { line: 1, byte: 0xef } });
  });

  it('needs no TextDecoder (a Node built without Intl has no fatal mode)', () => {
    const saved = globalThis.TextDecoder;
    (globalThis as { TextDecoder: unknown }).TextDecoder = class { constructor() { throw new TypeError('no ICU'); } };
    try {
      expect(decodeUtf8Strict(bytes('é'))).toEqual({ text: 'é' });
      expect(decodeUtf8Strict(Buffer.from('é', 'latin1'))).toEqual({ fault: { line: 1, byte: 0xe9 } });
    } finally {
      globalThis.TextDecoder = saved;
    }
  });
});
