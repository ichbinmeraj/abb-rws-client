#!/usr/bin/env node
/**
 * Writes src/version.ts from package.json, so the client knows its own version
 * without reading package.json at run time: a bundle (the VS Code extension
 * builds one with esbuild) has no package.json next to the module.
 *
 * Run by `npm run build` (and so by `prepack`). The file is tracked, and
 * tests/version.test.ts fails when it disagrees with package.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'abb-rws-client' || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  console.error(`write-version: package.json has no usable version (${JSON.stringify(pkg.version)})`);
  process.exit(1);
}

const out = path.join(root, 'src', 'version.ts');
const text = [
  '// Generated from package.json by scripts/write-version.mjs (npm run build). Do not edit.',
  '',
  '/** This package\'s version, fixed at build time so that it is known inside a bundle too. */',
  `export const CLIENT_VERSION = '${pkg.version}';`,
  '',
].join('\n');

const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : null;
if (current !== text) {
  fs.writeFileSync(out, text);
  console.log(`write-version: src/version.ts set to ${pkg.version}`);
}
