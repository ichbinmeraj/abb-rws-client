/**
 * Strict UTF-8 for a local file the client sends to a controller.
 *
 * `fs.readFileSync(file, 'utf8')` turns every byte sequence that is not
 * UTF-8 into U+FFFD without a word. Up to 1.5.1, loadProgram read a module
 * saved as Windows-1252 or Latin-1 that way and uploaded the replacement
 * characters where its accented letters had been. Here the decoded text is
 * encoded again and compared with the file's bytes: valid UTF-8 comes back
 * byte for byte, and a sequence that is not UTF-8 does not, because it was
 * replaced. A file that is not valid UTF-8 is refused, with the line where
 * its first bad sequence starts.
 *
 * The text of a valid file is the one readFileSync gives, a byte order mark
 * included (loadProgram leaves a leading one out since 1.5.4). Buffer's
 * decoder is used rather than TextDecoder's fatal mode, which a Node built
 * without Intl does not have.
 */

/** Where the first byte sequence that is not UTF-8 starts. */
export interface Utf8Fault {
  /** 1-based line of the sequence's first byte (a line ends at LF, CRLF or CR). */
  line: number;
  /** The sequence's first byte. */
  byte: number;
}

/** The text of `bytes`, or where its first sequence that is not UTF-8 starts. */
export function decodeUtf8Strict(bytes: Uint8Array): { text: string } | { fault: Utf8Fault } {
  const given = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = given.toString('utf8');
  const again = Buffer.from(text, 'utf8');
  return again.equals(given) ? { text } : { fault: firstFault(given, again) };
}

/**
 * Up to the first bad sequence the text came back unchanged, and from there
 * the replacement character's bytes (EF BF BD) stand in its place. So the
 * first byte that differs is the sequence's own first byte, unless the
 * sequence began with EF or EF BF, the replacement's own first bytes: then it
 * starts one or two bytes earlier. EF is never a continuation byte, and EF BF
 * followed by a continuation byte would have been a valid character.
 */
function firstFault(given: Buffer, again: Buffer): Utf8Fault {
  let d = 0;
  while (d < given.length && given[d] === again[d]) { d++; }
  let start = d;
  if (d >= 2 && given[d - 2] === 0xef && given[d - 1] === 0xbf) {
    start = d - 2;
  } else if (d >= 1 && given[d - 1] === 0xef) {
    start = d - 1;
  }
  let line = 1;
  for (let i = 0; i < start; i++) {
    if (given[i] === 0x0a || (given[i] === 0x0d && given[i + 1] !== 0x0a)) { line++; }
  }
  return { line, byte: given[start] };
}
