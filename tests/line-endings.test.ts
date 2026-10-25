import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm pack` ships what is on disk. A checkout with CRLF sources (core.autocrlf on
// Windows) packs to other bytes than an LF one, and a consumer's lock integrity then
// fails. .gitattributes makes every text file check out with LF; this checks it held.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packed = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { files: string[] }).files;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

describe('line endings', () => {
  it('.gitattributes checks every text file out with LF', () => {
    const lines = readFileSync(path.join(root, '.gitattributes'), 'utf8').split(/\r?\n/);
    expect(lines).toContain('* text=auto eol=lf');
  });

  it('the tracked text the package ships (src, examples, README and the other root files) has no CR', () => {
    const files = packed
      .filter(p => p !== 'dist')
      .flatMap(p => statSync(path.join(root, p)).isDirectory() ? walk(path.join(root, p)) : [path.join(root, p)]);
    expect(files.length).toBeGreaterThan(50);
    const withCr = files.filter(f => readFileSync(f).includes(0x0d)).map(f => path.relative(root, f));
    expect(withCr).toEqual([]);
  });
});
