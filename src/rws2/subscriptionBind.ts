/**
 * What an RWS 2.0 subscription create answer says was bound, for the panel
 * resources the controller accepts in two spellings. Used by the RWS 2.0
 * subscriber (Rws2Core.subscribe); not part of the package's public surface.
 *
 * ABB calls the 201 answer to `POST /subscription` a list of initial events:
 * one `...-ev` entry per bound resource with its current value. For the panel
 * resources the entry's self link has no suffix (`/rw/panel/speedratio`;
 * RW 7.21.4 and 8.2.1, 2026-09-29). A refused resource is named in a status
 * block, as in the answers to a group PUT.
 */

import { readSubscriptionUpdateAnswer } from '../subscriptionUpdateError.js';

/** The RWS 2.0 panel resources with two spellings: bare, or with this `;suffix`. */
const PANEL_SUFFIX: Readonly<Record<string, string>> = {
  'ctrl-state': 'ctrlstate', opmode: 'opmode', speedratio: 'speedratio', coldetstate: 'coldetstate',
};

/**
 * The other spelling of an RWS 2.0 panel resource the controller accepts in
 * two (`/rw/panel/speedratio;speedratio` and `/rw/panel/speedratio`; RW
 * 7.21.4 and 8.2.1 bound both, 2026-09-29), or null for any other URI.
 */
export function otherPanelSpelling(uri: string): string | null {
  const m = /^\/rw\/panel\/([a-z-]+)(?:;([a-z]+))?$/.exec(uri);
  const suffix = m ? PANEL_SUFFIX[m[1]] : undefined;
  if (!m || suffix === undefined) { return null; }
  if (m[2] === undefined) { return `/rw/panel/${m[1]};${suffix}`; }
  return m[2] === suffix ? `/rw/panel/${m[1]}` : null;
}

/**
 * -1073445866 SYS_CTRL_E_UNRESOLVED_URL (Retcode Service Rev L), answered
 * with 400 "Invalid resource URI in Create Subscription request".
 */
export const UNRESOLVED_URL = -1073445866;

/**
 * The resource to create once more in its other spelling after the
 * controller refused the whole create: a body naming one panel resource,
 * answered 400 -1073445866. A RobotWare 8.2.1 virtual controller answered a
 * one-resource create of `/rw/panel/speedratio;speedratio` that way
 * (2026-10-01, and twice on 2026-10-25, once 0.1 s before the same session
 * bound a one-resource create of `/rw/panel/opmode;opmode`), while each group
 * created with the bare `/rw/panel/speedratio`, the only spelling ABB
 * documents, bound it (25 of 25 in the 2026-10-25 run; none of them a
 * one-resource create). Null for anything else: a group's 400 does not say
 * which resource it refused.
 */
export function respellableRefusal(body: string, httpStatus: number | undefined, controllerCode: number | undefined): string | null {
  if (httpStatus !== 400 || controllerCode !== UNRESOLVED_URL) { return null; }
  const resources = subscriptionBodyResources(body);
  return resources.length === 1 && otherPanelSpelling(resources[0]) !== null ? resources[0] : null;
}

/** The resource URIs a subscription body names (`N=<uri>`), in order. */
export function subscriptionBodyResources(body: string): string[] {
  return [...body.matchAll(/(?:^|&)\d+=([^&]+)/g)].map(m => m[1]);
}

/**
 * The panel resources of `requestBody` that a create answer shows unbound.
 * A resource is unbound when a status block of the answer names it, or when
 * the answer lists initial events and none is for it. An answer with no
 * initial events at all is not read as unbound. Only the four panel resources
 * are judged: each has a current value, so a bound one always has its event;
 * other resources need not have one.
 *
 * `refused`: the ones a status block names. `suspect`: the ones only the
 * missing event points at. `otherRefused`: what status blocks name outside
 * the panel resources, as the request sent them (see refusedAsSent).
 * `bound`: the resources the answer lists as bound (paths without the
 * suffix).
 */
export function unboundPanelResources(requestBody: string, answer: string): {
  refused: string[]; suspect: string[]; otherRefused: string[]; bound: string[];
} {
  const read = readSubscriptionUpdateAnswer(answer);
  const requested = subscriptionBodyResources(requestBody);
  const panel = requested.filter(u => otherPanelSpelling(u) !== null);
  const refused = panel.filter(u => read.refused.includes(baseOf(u)));
  const suspect = read.bound.length === 0 ? [] : panel.filter(u => !refused.includes(u) && !read.bound.includes(baseOf(u)));
  const otherBases = read.refused.filter(r => !panel.some(u => baseOf(u) === r));
  return { refused, suspect, otherRefused: refusedAsSent(otherBases, requested, answer), bound: read.bound };
}

/** A resource URI without its `;suffix`. */
function baseOf(uri: string): string {
  return uri.split(';')[0];
}

/**
 * The refused resources `bases` (paths without the `;suffix`, as
 * readSubscriptionUpdateAnswer gives them) as the request named them, so
 * that `unbound` reads the same on both protocols (the RWS 1.0 subscriber
 * reports the URI as sent) and two resources on one path stay apart
 * (`/rw/rapid/execution;ctrlexecstate` and `;rapidexeccycle`): a status
 * block whose self link is a URI the request sent names that one; one that
 * names only the path stands for every URI sent on it; a path the request
 * did not send is kept as the answer names it.
 */
function refusedAsSent(bases: readonly string[], requested: readonly string[], answer: string): string[] {
  const links = statusSelfLinks(answer);
  const out: string[] = [];
  for (const b of bases) {
    const sent = requested.filter(u => baseOf(u) === b);
    const named = sent.filter(u => links.includes(u));
    for (const u of named.length > 0 ? named : sent.length > 0 ? sent : [b]) {
      if (!out.includes(u)) { out.push(u); }
    }
  }
  return out;
}

/** The self links of the answer's status blocks, scheme, host and query dropped, the `;suffix` kept. */
function statusSelfLinks(answer: string): string[] {
  const links: string[] = [];
  for (const [, status] of answer.matchAll(/<div class="status"[^>]*>([\s\S]*?)<\/div>/g)) {
    for (const [, attrs] of status.matchAll(/<a\b([^>]*)>/g)) {
      if (!/\brel="self"/.test(attrs)) { continue; }
      const href = (/\bhref="([^"]*)"/.exec(attrs)?.[1] ?? '').trim()
        .replace(/&amp;/g, '&')
        .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
        .split(/[?#]/)[0];
      if (href !== '') { links.push(href.startsWith('/') ? href : `/${href}`); }
    }
  }
  return links;
}

/** The subscription body with each `N=<from>` resource entry swapped to `N=<to>`. */
export function swapSubscriptionResources(body: string, swaps: ReadonlyArray<readonly [string, string]>): string {
  let out = body;
  for (const [from, to] of swaps) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|&)(\\d+)=${esc}(?=&|$)`), (_all, lead: string, n: string) => `${lead}${n}=${to}`);
  }
  return out;
}
