/**
 * The pendant session: tests that need the owner at a virtual FlexPendant ask
 * him on the console and wait for the controller to show he did it.
 *
 * `npm run functional:pendant` (scripts/functional-pendant.mjs) runs the
 * manual-mode tests lane by lane with RWS_FUNCTIONAL_PENDANT=1, which says
 * the owner is at the pendant now and is watching the console. Without it,
 * the tests keep their shorter waits and record what the controller did.
 *
 * Test infrastructure only - never shipped in the package.
 */

/** RWS_FUNCTIONAL_PENDANT=1: the owner sits at the virtual pendants and answers the console prompts. */
export function pendantSession(): boolean {
  return process.env.RWS_FUNCTIONAL_PENDANT === '1';
}

/** How long `waitForPerson` waits by default. */
export const PERSON_WAIT_MS = 180_000;

export interface PersonWait {
  /** `check` passed before the timeout. */
  met: boolean;
  /** How long the wait took, ms. */
  ms: number;
  /** How many times `check` ran. */
  checks: number;
  /** The last error `check` threw (a throw counts as not done yet), or null. */
  lastError: string | null;
}

export interface PersonWaitOptions {
  /** Pause between checks, ms (default 1000). */
  pollMs?: number;
  /** Where the lines go (default: process.stderr). */
  write?: (text: string) => void;
}

const defaultWrite = (text: string): void => { process.stderr.write(text); };

/**
 * Ask the person at the pendant to do something and wait until the
 * controller shows it: `prompt` is printed once (stderr), then `check` runs
 * every `pollMs` until it returns true or `timeoutMs` (default 180 s) has
 * passed. A check that throws counts as not done yet. One closing line says
 * whether it was seen, so the person knows the test moved on. Never throws.
 */
export async function waitForPerson(
  prompt: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs: number = PERSON_WAIT_MS,
  opts: PersonWaitOptions = {},
): Promise<PersonWait> {
  const write = opts.write ?? defaultWrite;
  const pollMs = opts.pollMs ?? 1000;
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let checks = 0;
  let lastError: string | null = null;
  write(`\n>>> PENDANT: ${prompt} (waiting up to ${Math.round(timeoutMs / 1000)} s)\n`);
  for (;;) {
    checks++;
    let done = false;
    try { done = await check(); } catch (e) { lastError = e instanceof Error ? e.message : String(e); }
    const ms = Date.now() - t0;
    if (done) {
      write(`>>> PENDANT: done, seen after ${Math.round(ms / 1000)} s\n\n`);
      return { met: true, ms, checks, lastError };
    }
    if (Date.now() >= deadline) {
      write(`>>> PENDANT: not seen within ${Math.round(timeoutMs / 1000)} s - the test goes on without it\n\n`);
      return { met: false, ms, checks, lastError };
    }
    await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
