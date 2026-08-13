import { defineConfig } from 'vitest/config';

// Many unit tests are integration-style: they stand up a mock HTTP controller and
// drive the real client through it, and the client enforces a mandatory >=55 ms
// gap between requests (the RWS rate limit). A test that makes a dozen paced
// requests already spends most of a second in deliberate delay, and the whole
// suite runs its files in parallel. Under CPU contention (e.g. a CI runner, or a
// dev box also running other work) the default 5 s per-test timeout is too tight
// and produces rare, non-reproducible failures that always pass on retry. Give
// the paced-HTTP tests real headroom - a genuine hang still blows past 20 s.
export default defineConfig({
  test: {
    // Only this package's own test tree. Without the explicit scope vitest
    // globs **/*.test.ts from the repo root and can pick up copies of the
    // suite in nested working directories (editor tooling, linked checkouts),
    // running every test twice and doubling the CPU load on the timing tests.
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
