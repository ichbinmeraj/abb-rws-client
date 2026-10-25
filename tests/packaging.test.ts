import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The tarball is what the extension and the daemon consume. A node_modules that
// drifted from the lockfile (e.g. an older `ws` than the one locked) builds and
// tests fine, so the pack must refuse on its own before anything is built.
describe('package scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('prepack checks the installed runtime tree against the lockfile first', () => {
    expect(pkg.scripts.prepack.startsWith('npm ls --omit=dev && ')).toBe(true);
  });

  it('prepack still builds and tests', () => {
    expect(pkg.scripts.prepack).toContain('npm run build');
    expect(pkg.scripts.prepack).toContain('npm test');
  });

  // dist/ is gitignored and only ever added to: a module removed from src/ leaves its
  // old output behind, and that machine then packs files a fresh clone does not have.
  it('prepack empties dist/ before it builds, so the tarball holds only what this commit compiles to', () => {
    const p = pkg.scripts.prepack;
    const clean = p.indexOf("rmSync('dist'");
    expect(clean).toBeGreaterThan(0);
    expect(clean).toBeLessThan(p.indexOf('npm run build'));
  });

  // RWS_TEST_HOST turns on the live suites (tests/live), which reach the VCs on this
  // PC. RAPID Live's host tests set the same variable, and its `npm run vendor` packs
  // this client, so a shell left with their value would otherwise run the live
  // suites inside a pack or a publish.
  it('prepack and prepublishOnly run the tests without RWS_TEST_HOST', () => {
    for (const name of ['prepack', 'prepublishOnly']) {
      const p = pkg.scripts[name];
      const unset = p.indexOf('delete process.env.RWS_TEST_HOST');
      expect(unset, name).toBeGreaterThan(0);
      expect(unset, name).toBeLessThan(p.indexOf('npm test'));
      expect(p.match(/npm test/g), name).toHaveLength(1);
    }
  });
});
