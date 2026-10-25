/**
 * Assertion helpers the structural cells share between their live halves
 * (tests/structural/S<nn>-*.test.ts, against a controller) and their mock
 * halves (tests/structural/S<nn>-*.mock.test.ts, against a local server, in
 * plain `npm test` too): counting what a server saw, and proving that a call
 * settles and that nothing escapes as an uncaught exception.
 *
 * Test infrastructure only - never shipped in the package.
 */

import { expect } from 'vitest';

/**
 * One request as the server saw it.
 *
 * `at` is the ARRIVAL time, never the completion time: the property under test is
 * "the client never sent 20 requests in a second", and timing a relayed request
 * by when its response finished would fold controller latency into the reading -
 * a slow first response followed by fast ones bunches the completions and reads
 * as a burst the client never produced (and, the other way round, spreads a real
 * burst out). It is monotonic (performance.now()) because the rate assertions do
 * interval arithmetic and Date.now() can step.
 */
export interface ServerRequest { method: string; url: string; status: number; at: number }

/**
 * Highest number of requests contained in any one-second window.
 *
 * Written as a sliding window rather than fixed buckets on purpose: bucketing by
 * wall-clock second lets a burst straddle a boundary and read as two half-rate
 * seconds, which is exactly the shape a client that fires everything at once
 * would produce.
 */
export function peakRequestsPerSecond(times: number[]): number {
  const t = [...times].sort((a, b) => a - b);
  let peak = 0;
  let lo = 0;
  for (let hi = 0; hi < t.length; hi++) {
    while (t[hi] - t[lo] >= 1000) { lo++; }
    peak = Math.max(peak, hi - lo + 1);
  }
  return peak;
}

/**
 * Watch a counter until it stops moving, then return its final value
 * (cells S06 and S10).
 *
 * "No infinite retry loop" is a claim about what happens AFTER the call has
 * already rejected, so a single reading taken at the rejection would pass even
 * for a client that keeps retrying in the background forever. The only honest
 * form of the assertion is "the counter goes quiet and stays quiet", and this
 * throws rather than returning if it never does.
 *
 * `quietMs` MUST exceed the cadence of whatever loop the test is trying to
 * disprove, or the check is worthless: a manager polling every 1500 ms looks
 * perfectly quiet to a 1200 ms window and this returns "settled" for a client
 * that never stopped. Callers driving a RobotManager pass a multiple of the
 * poll interval; the default only covers the tight in-request retry paths
 * (HttpSession's 200 ms 503 backoff, the WS reconnect cap).
 */
export async function settledCount(
  count: () => number, quietMs = 1500, timeoutMs = 25000, label = 'request count',
): Promise<number> {
  const t0 = Date.now();
  let last = count();
  let lastChange = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 40));
    const now = count();
    if (now !== last) { last = now; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) { return last; }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`${label} never settled - still growing after ${timeoutMs} ms (at ${last})`);
    }
  }
}

export interface Settled { settled: boolean; error?: unknown; value?: unknown; elapsedMs: number }

/**
 * Run `fn` against a wall clock and report whether it finished at all.
 *
 * "Does not hang" cannot be asserted by awaiting the call - a hung call simply
 * consumes the whole test timeout and reports nothing useful. Racing it against
 * a watchdog turns the hang into a named failure with a number attached, and
 * leaves the abandoned promise handled so a late rejection is not mistaken for
 * an uncaught one.
 */
export async function settleWithin(fn: () => Promise<unknown>, budgetMs: number): Promise<Settled> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = fn().then(
    value => ({ settled: true, value, elapsedMs: Date.now() - t0 }),
    error => ({ settled: true, error, elapsedMs: Date.now() - t0 }),
  );
  const watchdog = new Promise<Settled>(resolve => {
    timer = setTimeout(() => resolve({ settled: false, elapsedMs: Date.now() - t0 }), budgetMs);
  });
  try { return await Promise.race([call, watchdog]); }
  finally { if (timer) { clearTimeout(timer); } }
}

export interface UncaughtWatch { seen: unknown[]; stop(): void }

/**
 * Record anything that escapes to the process.
 *
 * "Parsers never throw uncaught" is a claim about what does NOT happen anywhere,
 * so it cannot be checked by catching around the call - a regex that throws
 * inside a detached promise, or a parser reached from a timer, would never pass
 * through the caller's try block at all.
 */
export function watchUncaught(): UncaughtWatch {
  const seen: unknown[] = [];
  const record = (e: unknown): void => { seen.push(e); };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  return {
    seen,
    stop: () => {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
    },
  };
}

export async function assertNoUncaught(watch: UncaughtWatch): Promise<void> {
  // unhandledRejection is reported a turn or two later than the rejection, so a
  // reading taken in the same tick would always look clean. This is a wait that
  // cannot be a poll: it waits for the ABSENCE of an event, and
  // there is nothing to poll for. Generous rather than tight, because a window
  // that closes early under load turns a real escape into a green.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setTimeout(r, 250));
  const described = watch.seen.map(e =>
    e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));
  expect(described, 'something escaped as an uncaught exception / unhandled rejection').toEqual([]);
}

/**
 * Await `p`, but never longer than `ms`.
 *
 * A cell (S12) can leave a request wedged behind a stalled body, and RWS 1.0
 * serialises everything through one queue - so an unbounded `disconnect()` in
 * cleanup would queue behind the wedged request and hang the whole suite.
 * disconnect still gets a real chance first, because /logout is what frees the
 * controller's session slot.
 */
export async function withDeadline(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!p) { return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<void>(resolve => { timer = setTimeout(() => resolve(), ms); });
  try { await Promise.race([p.then(() => undefined, () => undefined), guard]); }
  finally { if (timer) { clearTimeout(timer); } }
}
