/**
 * The bytes a controller reads a RAPID module file in.
 *
 * RobotWare 6.16.03, 7.21.4 and 8.2.1 read a module file one character per
 * byte, the Latin-1 range (live, 2026-10-30). A file with `ä` as the byte E4
 * loads as `ä` on all three. The UTF-8 bytes C3 A4 load as `Ã¤`, with no
 * error and no event-log message, and RobotWare 7 and 8 save that back
 * encoded once more. So module text goes out one byte per character.
 *
 * The probe sent ä, ö, é and °, all from U+00A0 to U+00FF, where Latin-1 and
 * Windows-1252 agree, and the rest of that range is taken to go the same way.
 * U+0080 to U+009F, where the two differ, were not tried and are refused, and
 * so is anything above U+00FF, which one byte cannot carry. NUL passes, as it
 * did before.
 */

/** Where the first character that cannot be sent is. */
export interface ModuleCharFault {
  /** 1-based line (a line ends at LF, CRLF or CR). */
  line: number;
  /** 1-based column, in characters. */
  column: number;
  /** The character's Unicode code point. */
  codePoint: number;
}

/**
 * `text` as the bytes a controller reads, one per character, and whether every
 * character was ASCII; or where the first character that cannot be sent is.
 */
export function encodeModuleLatin1(text: string): { bytes: Uint8Array; ascii: boolean } | { fault: ModuleCharFault } {
  const bytes = new Uint8Array(text.length);
  let n = 0;
  let ascii = true;
  let line = 1;
  let column = 0;
  let afterCr = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    column++;
    if (cp > 0xff || (cp >= 0x80 && cp <= 0x9f)) {
      return { fault: { line, column, codePoint: cp } };
    }
    if (cp === 0x0a) {
      if (!afterCr) { line++; }
      column = 0;
    } else if (cp === 0x0d) {
      line++;
      column = 0;
    }
    afterCr = cp === 0x0d;
    if (cp > 0x7f) { ascii = false; }
    bytes[n++] = cp;
  }
  return { bytes: bytes.subarray(0, n), ascii };
}
