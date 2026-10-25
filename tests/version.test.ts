import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLIENT_VERSION } from '../src/version.js';
import { defaultUserAgent } from '../src/discovery/probe.js';

// src/version.ts is written from package.json by scripts/write-version.mjs, which
// `npm run build` runs first. A version bump without a build fails here, and the
// pack (prepack: build, then test) can never ship a stale one.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
};

describe('the version fixed at build time', () => {
  it('src/version.ts carries the package.json version', () => {
    expect(CLIENT_VERSION).toBe(pkg.version);
  });

  it('the build writes src/version.ts before compiling', () => {
    expect(pkg.scripts.build.startsWith('node scripts/write-version.mjs && ')).toBe(true);
  });

  it('the discovery User-Agent carries that version', () => {
    expect(defaultUserAgent()).toBe(`abb-rws-client/${pkg.version} discovery`);
  });
});
