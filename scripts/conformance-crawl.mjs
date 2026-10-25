/**
 * The walk of the conformance crawler (scripts/conformance.mjs): where it
 * starts, what it never reads, and the breadth-first loop itself. The loop
 * takes the GET as a function, so the request side (pacing, sessions, auth)
 * stays in conformance.mjs and the walk can run against canned answers.
 *
 * Test infrastructure only - never shipped in the package.
 */

import { childLinks, normalise } from './conformance-links.mjs';

// Crawl the STABLE resource trees only. /fileservice enumerates the controller
// disk (unbounded, and not an RWS operation surface) and /subscription needs a
// live WebSocket to exist at all, so both are excluded - their operations live
// in the tables as fixed paths, not as things to discover.
export const ROOTS = ['/rw', '/ctrl', '/users', '/uas'];

// Subtrees that only add size: instance listings (every signal, every event,
// every symbol) balloon the crawl without adding new OPERATION paths, and the
// trees outside ROOTS are never walked. Prune by path prefix.
export const PRUNE = [
  /^\/rw\/elog\/\d/,                 // per-message event log
  /^\/rw\/iosystem\/signals\/[^/]/,  // per-signal instances
  /^\/rw\/rapid\/symbol\//,          // per-symbol data (huge)
  /^\/rw\/cfg\/[^/]+\/[^/]/,         // per-cfg-instance
  // Per-queue DIPC instances, and not only for size: on RWS 2.0 a GET on a
  // queue is the DIPC read, which takes one message off the queue (one a RAPID
  // task may be waiting for). RWS 1.0 reads with ?action=dipc-read instead,
  // but a queue adds no operation path on either generation.
  /^\/rw\/dipc\/[^/]/,
  /^\/fileservice/, /^\/subscription/, /^\/poll/,
];

// Resources that mean something only with a query parameter a directory crawl
// does not have, so reading them bare teaches nothing.
export const NEEDS_QUERY = [
  /^\/users\/grant-exists/,
];

/** True for a path the crawl never reads. */
export const pruned = p => PRUNE.some(re => re.test(p)) || NEEDS_QUERY.some(re => re.test(p));

// One walk per controller, each with its own budget. A device tree below
// /rw/devices runs to several hundred nodes and a slow virtual controller
// answers in seconds, so a full walk of one build can take minutes.
export const MAX_NODES = 2000;
export const DEADLINE_MS = 20 * 60 * 1000;

/**
 * Walk the resource tree breadth-first from `roots`, one GET per node, and
 * return every node that answered 2xx, sorted. `get(path)` resolves to
 * `{ status, body }`; `gen` is 1 (XHTML) or 2 (hal+json). Children come from
 * the answer's links (see childLinks); a pruned path is never read.
 *
 * `stats`, when given, is filled with how the walk ended: `probed` nodes,
 * `queued` (left unread), `deadlineHit`, `nodeCapHit`, `complete` (neither
 * hit) and `elapsedMs`; `stoppedAnswering` is the node at which the walk
 * gave up on a controller that left STOP_AFTER_UNANSWERED reads in a row
 * unanswered (status 0: no answer within the request timeout).
 */
export const STOP_AFTER_UNANSWERED = 3;

export async function crawlTree(get, gen, {
  roots = ROOTS, maxNodes = MAX_NODES, deadlineMs = DEADLINE_MS, log = () => {}, stats = null,
} = {}) {
  const startedAt = Date.now();
  const seen = new Set();
  const advertised = new Set();
  const queue = [...roots];
  const stopAt = Date.now() + deadlineMs;
  let n = 0;
  let unanswered = 0;
  let stoppedAnswering = null;
  while (queue.length && seen.size < maxNodes && Date.now() < stopAt) {
    const node = normalise(queue.shift());
    if (seen.has(node) || pruned(node)) { continue; }
    seen.add(node);
    const res = await get(node);
    n++;
    if (!res.status) {
      unanswered++;
      log(`    no answer for ${node}`);
      // A controller that stops answering is left alone, not walked to the deadline.
      if (unanswered >= STOP_AFTER_UNANSWERED) { stoppedAnswering = node; break; }
      continue;
    }
    unanswered = 0;
    if (n % 25 === 0) { log(`    …${n} probed, ${advertised.size} advertised, ${queue.length} queued`); }
    if (res.status >= 200 && res.status < 300) {
      advertised.add(node);
      for (const child of childLinks(res.body, gen, node)) {
        if (!seen.has(child) && !pruned(child) && child.startsWith('/') && child.length > node.length) {
          queue.push(child);
        }
      }
    }
  }
  const pending = new Set(queue.map(normalise).filter(p => !seen.has(p) && !pruned(p))).size;
  const deadlineHit = pending > 0 && Date.now() >= stopAt;
  const nodeCapHit = pending > 0 && seen.size >= maxNodes;
  if (deadlineHit) { log(`    (deadline hit at ${seen.size} nodes)`); }
  if (stoppedAnswering) { log(`    (stopped: ${STOP_AFTER_UNANSWERED} reads in a row unanswered, last ${stoppedAnswering})`); }
  if (nodeCapHit) { log(`    (node cap hit at ${seen.size} nodes)`); }
  if (stats) {
    Object.assign(stats, {
      probed: n, queued: pending, deadlineHit, nodeCapHit,
      stoppedAnswering, complete: !deadlineHit && !nodeCapHit && !stoppedAnswering, elapsedMs: Date.now() - startedAt,
    });
  }
  return [...advertised].sort();
}
