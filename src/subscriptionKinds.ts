/**
 * What both generations' subscribers share about subscription resources: the
 * paths of the kinds added in 1.5.0 (mastership, the motion system's error
 * state) and how one event frame names its resources. Internal: not exported
 * from the package.
 */

import { RwsError, type AnySubscriptionResource, type MastershipDomain } from './types.js';
import { withReport } from './refusal.js';

/** The RWS 1.0 mastership domains (ABB Rev M); RWS 2.0 names cfg and rapid `edit`. */
const MASTERSHIP_DOMAINS: readonly MastershipDomain[] = ['cfg', 'motion', 'rapid'];

/**
 * The motion system's error state, the same resource on both generations
 * (ABB RWS 1.0 Rev M "Subscribe on Error EventChange", RWS 2.0 Rev L Motion
 * System). A raw create answered 201 on RW 6.16.03 (2026-09-29) and on a
 * RobotWare 8 virtual controller (2026-09-27), each with an initial
 * `motionsystem-errorstate-ev` entry (`errorstate` HPJ_OK, `errorcounter` 0).
 */
export const MOTION_ERROR_STATE_RESOURCE = '/rw/motionsystem/errorstate;erroreventchange';

/**
 * The paths of a kind added in 1.5.0 on one generation, or null for any other
 * kind:
 *
 * - mastership of one domain: RWS 1.0 `/rw/mastership/{cfg|motion|rapid}`
 *   (Rev M "Mastership Domain Subscribe"); RWS 2.0
 *   `/rw/mastership/{edit|motion}`, rapid and cfg sent as `edit` (Rev L
 *   Mastership service).
 * - mastership of every domain (no domain given): each domain's resource,
 *   RWS 1.0 cfg, motion and rapid, RWS 2.0 edit and motion. ABB's RWS 1.0
 *   Rev M also lists `/rw/mastership` for every domain ("Mastership
 *   Subscribe"), but RW 6.16.03 refused it (400 -1073445866 "Invalid resource
 *   URI"); Rev L lists no such form for RWS 2.0, and RW 7.21.4 bound
 *   `/rw/mastership` in a PUT it never answered, after which the group
 *   refused every edit and its own delete with -1073445863 "Group N already
 *   has a response waiting" until the session logged out. The per-domain
 *   resources bound and sent events on both (2026-10-21).
 * - motion error state: `MOTION_ERROR_STATE_RESOURCE` on both.
 *
 * A domain other than cfg, motion or rapid is `INVALID_ARGUMENT`, before
 * anything is sent: the path goes into the request body unencoded.
 */
export function addedResourcePaths(r: AnySubscriptionResource, gen: 'rws1' | 'rws2'): string[] | null {
  if (typeof r !== 'object' || r === null) { return null; }
  if (r.type === 'motionerrorstate') { return [MOTION_ERROR_STATE_RESOURCE]; }
  if (r.type !== 'mastership') { return null; }
  if (r.domain === undefined) {
    return gen === 'rws2' ? ['/rw/mastership/edit', '/rw/mastership/motion'] : MASTERSHIP_DOMAINS.map(d => `/rw/mastership/${d}`);
  }
  if (!MASTERSHIP_DOMAINS.includes(r.domain)) {
    throw new RwsError(
      `mastership subscription: the domain must be cfg, motion or rapid, not ${JSON.stringify(r.domain)}; nothing was sent`,
      'INVALID_ARGUMENT',
    );
  }
  return [`/rw/mastership/${gen === 'rws2' && r.domain !== 'motion' ? 'edit' : r.domain}`];
}

/** Each path once, in first-seen order: one kind may stand for several resources, and two kinds for the same one. */
export function distinctPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/**
 * The request path that drops one resource from a group, `{group}{resource}`
 * (ABB: `DELETE /subscription/{group-id}/{resource-uri}`, RWS 1.0 Rev M; the
 * same on RWS 2.0, from the group's own form). The resource path is appended
 * as subscribed, `;suffix` included, so it must come through URL parsing as
 * the same path and stay inside the group: a dot segment collapses, and a
 * `?` or `#` cuts the path short, each sending the DELETE to some other
 * resource. Such a resource is `INVALID_ARGUMENT`, before anything is sent.
 */
export function groupResourcePath(groupPath: string, resourcePath: string, what: string): string {
  const target = `${groupPath}${resourcePath}`;
  let resolved = '';
  try { resolved = new URL(target, 'http://controller.invalid').pathname; } catch { /* refused below */ }
  if (!target.startsWith(`${groupPath}/`) || resolved !== target) {
    throw new RwsError(`${what}: ${JSON.stringify(resourcePath)} does not resolve to a path under ${groupPath}; nothing was sent`, 'INVALID_ARGUMENT');
  }
  return target;
}

/**
 * Drop the paths of one resource from a group, one DELETE each, in order
 * (mastership of every domain is one path per domain). Every path is checked
 * with `groupResourcePath` before the first DELETE goes out. A failed DELETE
 * after one that succeeded keeps its error and says which were dropped.
 */
export async function dropFromGroup(
  groupPath: string, resourcePaths: readonly string[], what: string, del: (path: string) => Promise<void>,
): Promise<void> {
  const targets = resourcePaths.map(p => groupResourcePath(groupPath, p, what));
  const dropped: string[] = [];
  for (const [i, target] of targets.entries()) {
    try {
      await del(target);
    } catch (e) {
      throw dropped.length === 0 ? e : withReport(e, `${what}: ${dropped.join(', ')} dropped from ${groupPath}, then ${resourcePaths[i]} failed.`);
    }
    dropped.push(resourcePaths[i]);
  }
}

/**
 * The entries of one subscription event frame, in order: the resource each
 * `<li>` names and its first field's value (null when it has none). The
 * resource is the entry's link. ABB documents the mastership entry
 * (`msh-resource-value`) without one, on both generations, with the domain
 * as its title, so such an entry names `/rw/mastership/{title}`. Any other
 * entry without a link is left out.
 */
export function subscriptionFrameEntries(frame: string): Array<{ resource: string; value: string | null }> {
  const out: Array<{ resource: string; value: string | null }> = [];
  for (const [, attrs, block] of frame.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const resource = block.match(/<a[^>]*href="([^"]+)"/i)?.[1] ?? linklessResource(attrs);
    if (!resource) { continue; }
    const span = block.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    out.push({ resource, value: span ? span[1].trim() : null });
  }
  return out;
}

/** The resource of an entry ABB documents without a link, or null. */
function linklessResource(attrs: string): string | null {
  if (!/\bclass="msh-resource-value"/.test(attrs)) { return null; }
  const title = /\btitle="([^"]+)"/.exec(attrs)?.[1];
  return title ? `/rw/mastership/${title}` : null;
}
