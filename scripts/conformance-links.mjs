/**
 * Link resolution for the conformance crawler (scripts/conformance.mjs).
 *
 * Every RWS answer names the URL its relative links resolve against: hal+json
 * as `_links.base.href`, XHTML as the `<base href>` element in the head. That
 * base is not always the request path. `GET /rw` answers base `/` with the
 * children `rw/cfg`, `rw/rapid`, ... (RWS 2.0 hal+json and RWS 1.0 XHTML
 * alike), and `GET /rw/dipc` answers base `/rw/` with self link `dipc`.
 * Resolved against the request path instead, the children of /rw read as
 * /rw/rw/..., which do not exist, and a crawl never gets below /rw.
 *
 * Test infrastructure only - never shipped in the package.
 */

/** A live resource path, stripped of query and trailing slash. */
export function normalise(p) {
  const bare = p.split('?')[0].replace(/\/+$/, '');
  return bare || '/';
}

/** The request path as a directory URL: what links resolve against when an answer declares no base. */
function requestDir(requestPath) {
  const p = requestPath.split('?')[0];
  return `http://x${p.endsWith('/') ? p : p + '/'}`;
}

/** The base href an answer declares, as written, or null when it declares none. */
function declaredBase(body, gen) {
  if (gen === 2) {
    try {
      const href = JSON.parse(body)?._links?.base?.href;
      return typeof href === 'string' && href !== '' ? href : null;
    } catch {
      // Not whole JSON (a body cut short): the top-level _links, base first,
      // opens every hal+json answer.
      return /"base"\s*:\s*\{\s*"href"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? null;
    }
  }
  return /<base\b[^>]*\bhref\s*=\s*"([^"]+)"/i.exec(body)?.[1] ?? null;
}

/**
 * The URL an answer's relative links resolve against: the base link it
 * declares (hal+json `_links.base`, or the XHTML `<base>` element), itself
 * resolved against the request, or the request path when it declares none.
 * Only the path of the result matters to the crawl.
 */
export function linkBase(body, gen, requestPath) {
  const fallback = requestDir(requestPath);
  const declared = declaredBase(body, gen);
  if (declared) {
    try { return new URL(declared, fallback).href; } catch { /* unusable base: use the request path */ }
  }
  return fallback;
}

/**
 * The resource paths an answer links to, each resolved against the answer's
 * base (see linkBase) and normalised. The base link itself is not a child.
 */
export function childLinks(body, gen, requestPath) {
  const declared = declaredBase(body, gen);
  const base = linkBase(body, gen, requestPath);
  const hrefs = new Set();
  if (gen === 2) {
    for (const m of body.matchAll(/"href"\s*:\s*"([^"]+)"/g)) { hrefs.add(m[1]); }
  } else {
    for (const m of body.matchAll(/href="([^"]+)"/g)) { hrefs.add(m[1]); }
  }
  if (declared) { hrefs.delete(declared); }
  const out = new Set();
  for (const h of hrefs) {
    if (!h || h.startsWith('#') || /^wss?:\/\//i.test(h)) { continue; }
    let abs;
    try { abs = new URL(h, base).pathname; }
    catch { continue; }
    out.add(normalise(abs));
  }
  return [...out];
}
