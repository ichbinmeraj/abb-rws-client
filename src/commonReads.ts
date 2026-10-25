/**
 * Parsing shared by the RWS 1.0 adapter and the RWS 2.0 client for the reads
 * both generations serve under the same resource classes: one RAPID task, the
 * motion pointer, the task selection, one configuration type, a DIPC queue's
 * information, one I/O network or device, a module's routines, a file's
 * metadata and a controller environment variable; and the niche reads: the
 * session's subscription groups and one group's members, motion and path
 * supervision, a mechanical unit's SMB data, motor calibration names and
 * lead-through state.
 *
 * Internal: not exported from the package. Each function takes the entries a
 * parser found (`getAllEntries()`, every typed entry with its `_type`) so the
 * same reading applies to the RWS 2.0 hal+json and XHTML bodies and to the
 * RWS 1.0 `?json=1` and XHTML bodies, which use the same class names.
 *
 * Where no body of a resource has been captured on any build yet, the reader
 * takes the class ABB documents (or the class the other generation serves)
 * and fails with PARSE_ERROR, naming the classes it did see, rather than
 * answering an empty value that looks like a real reading.
 */

import { HalJsonParser } from './HalJsonParser.js';
import {
  RwsError, type CfgTypeInfo, type DipcQueueInfo, type FileMetadata, type LeadThroughState, type MechunitMotorCalib,
  type MotionSupervisionState, type PathSupervisionState, type RapidBuildError, type RapidRoutineInfo, type RobotWareCompatibility,
  type SubscriptionGroupInfo, type SubscriptionGroupMember,
} from './types.js';
import { XhtmlParser } from './XhtmlParser.js';
import { decodeEntities } from './ResponseParser.js';

/** A body as a parser: hal+json / `?json=1` when it starts with `{`, XHTML otherwise. */
export function parseBody(body: string): XhtmlParser | HalJsonParser {
  return HalJsonParser.looksLikeJson(body) ? new HalJsonParser(body) : new XhtmlParser(body);
}

/**
 * Next-page path from a paginated list response (HAL `_links.next.href` or the
 * XHTML `rel="next"` link), or '' when there is no further page.
 *
 * The href is relative to the response's base (HAL `_links.base.href`, XHTML
 * `<base href>`), so it is resolved against that base's pathname when the
 * response carries one, and against the parent of `currentPath` otherwise.
 * The two differ for CFG instances: `/rw/cfg/{domain}/{type}/instances`
 * answers under base `/rw/cfg/` with next `{domain}/{type}/instances?start=70&limit=70`;
 * resolved against the request's parent that became
 * `/rw/cfg/{domain}/{type}/{domain}/{type}/instances?...` and answered 404,
 * so listCfgInstances stopped at the first 70 rows. Resolved against the base
 * it serves the rest (live-verified 2026-09-29 on RW 8.2.1+1023, EIO_SIGNAL:
 * 70 + 24 rows). For the event log, signal lists and CFG types the base is
 * the request's parent path, so both rules agree there. Both representations
 * XML-escape ampersands in the href (even inside JSON strings), hence the
 * unescape.
 */
export function nextPagePath(responseBody: string, currentPath: string): string {
  const json = HalJsonParser.looksLikeJson(responseBody);
  const rel = json
    ? new HalJsonParser(responseBody).nextHref()
    : responseBody.match(/<a\s+href="([^"]+)"\s+rel="next"/)?.[1];
  if (!rel) { return ''; }
  const href = rel.replace(/&amp;/g, '&');
  if (href.startsWith('/')) { return href; }
  const base = json
    ? responseBody.match(/"base"\s*:\s*\{\s*"href"\s*:\s*"([^"]*)"/)?.[1]
    : responseBody.match(/<base\s+href="([^"]*)"/)?.[1];
  const basePath = base ? pathnameOf(base) : '';
  const dir = basePath.endsWith('/') ? basePath : currentPath.replace(/[^/]*$/, '');
  return dir + href;
}

/** Pathname of an absolute or root-relative href; '' when it has none. */
function pathnameOf(href: string): string {
  try { return new URL(href.replace(/&amp;/g, '&'), 'http://base.invalid').pathname; }
  catch { return ''; }
}

/**
 * The answer bodies of a paged listing, page by page: `first`, then each
 * answer's `next` link (nextPagePath), at most `maxPages` pages. A link to
 * another resource, or to a page already read, ends the walk, as does an
 * answer without one. `fetchPage` sends one GET and returns its body, and
 * throws the controller's error; a failed page fails the whole read.
 */
export async function readPages(
  first: string, fetchPage: (path: string) => Promise<string>, maxPages: number,
): Promise<string[]> {
  const resource = first.split('?')[0];
  const bodies: string[] = [];
  const read = new Set<string>();
  for (let path = first; path && bodies.length < maxPages && !read.has(path);) {
    read.add(path);
    const body = await fetchPage(path);
    bodies.push(body);
    const next = nextPagePath(body, resource);
    path = next.split('?')[0] === resource ? next : '';
  }
  return bodies;
}

/** The entry without its `_type` key (getState() parity). */
function withoutType(e: Record<string, string>): Record<string, string> {
  const rest = { ...e };
  delete rest['_type'];
  return rest;
}

/** The distinct classes of a body, for a PARSE_ERROR message. */
function seen(entries: Array<Record<string, string>>): string {
  const types = [...new Set(entries.map(e => e['_type']).filter(Boolean))];
  return types.length ? types.join(', ') : 'none';
}

/**
 * The first entry whose class is one of `classes` (earlier classes win), as
 * getState() would return it. Throws PARSE_ERROR when no entry matches.
 */
export function pickEntry(
  entries: Array<Record<string, string>>, classes: readonly string[], what: string,
): Record<string, string> {
  for (const c of classes) {
    const hit = entries.find(e => e['_type'] === c);
    if (hit) { return withoutType(hit); }
  }
  throw new RwsError(
    `${what}: the answer carried no ${classes.join(' / ')} entry (classes seen: ${seen(entries)})`,
    'PARSE_ERROR',
  );
}

/**
 * One RAPID task. RWS 2.0 lists tasks as `rap-task-li` (RW 7.21.4 and 8.2.1,
 * 2026-09-29) and RWS 1.0 does the same; the single-task body has not been
 * captured, so `rap-task` is read first, then the `rap-task-li` that names
 * the task. A list whose items name other tasks only is PARSE_ERROR, never
 * another task's state under the name asked for.
 */
export function rapidTaskFrom(entries: Array<Record<string, string>>, task: string, what: string): Record<string, string> {
  const single = entries.find(e => e['_type'] === 'rap-task');
  if (single) { return withoutType(single); }
  const items = entries.filter(e => e['_type'] === 'rap-task-li');
  const named = items.find(e => e['name'] === task || e['_title'] === task);
  if (named) { return withoutType(named); }
  if (items.length > 0) {
    const listed = items.map(e => e['name'] ?? e['_title'] ?? '?').join(', ');
    throw new RwsError(`${what}: the answer listed no task named ${task} (tasks listed: ${listed})`, 'PARSE_ERROR');
  }
  throw new RwsError(
    `${what}: the answer carried no rap-task / rap-task-li entry (classes seen: ${seen(entries)})`,
    'PARSE_ERROR',
  );
}

const count = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === '') { return undefined; }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * The motion pointer from a task's pcp answer: the `pcp-info` entry titled
 * `motionpointer`, beside the one titled `progpointer` (ABB RWS 1.0 Rev M
 * "Get RAPID task Motion&Program pointer positions"; RWS 2.0 Rev L RAPID
 * service, `/rw/rapid/tasks/{task}/pcp`). It is found by its title, not its
 * class: RW 6.16.03 typed it `rap-text` in a `?json=1` answer that carried no
 * position (2026-09-27). The start is "row,col", read under `beginposition`
 * first, then under `begposition`. RW 6.16.03 and RW 7.21.4 send the start
 * as `begposition` in this entry and as `beginposition` in the progpointer
 * entry (2026-10-18). ABB's RAPID service says only v=2.2 sends
 * `beginposition` in place of `begposition`. ABB's RWS 1.0 Rev M example
 * keeps the start under `beginposition` in this entry and puts a
 * `begposition` span where the end goes, so `beginposition` is read first.
 * The module is read under `modulename` and under `modulemame`, the spelling
 * ABB's RWS 1.0 page and the controllers also use.
 *
 * An entry with no position (no program started: the controllers answer it
 * with an error link and no spans) gives `{}`. An answer with no
 * `motionpointer` entry at all is PARSE_ERROR, naming the titles it had.
 */
export function motionPointerFrom(
  entries: Array<Record<string, string>>, what: string,
): { module?: string; routine?: string; row?: number; col?: number } {
  const mp = entries.find(e => e['_title'] === 'motionpointer');
  if (!mp) {
    const titles = [...new Set(entries.map(e => e['_title']).filter(Boolean))];
    throw new RwsError(
      `${what}: the answer carried no entry titled motionpointer (titles seen: ${titles.length ? titles.join(', ') : 'none'})`,
      'PARSE_ERROR',
    );
  }
  const [row, col] = (mp['beginposition'] ?? mp['begposition'] ?? '').split(',').map(v => count(v));
  const out: { module?: string; routine?: string; row?: number; col?: number } = {};
  const mod = mp['modulename'] ?? mp['modulemame'];
  if (mod !== undefined) { out.module = mod; }
  if (mp['routinename'] !== undefined) { out.routine = mp['routinename']; }
  if (row !== undefined) { out.row = row; }
  if (col !== undefined) { out.col = col; }
  return out;
}

/**
 * The task selection: one `rap-taskselection` entry per task, with `name`,
 * `state` (ON / OFF), `motiontask` and `usermodify` (ABB RWS 1.0 Rev M "Get
 * user modify from taskpanel", `/rw/rapid/taskselection`; the class RWS 2.0
 * serves too). `selected` holds the tasks whose state reads ON. An answer
 * with no such entry is PARSE_ERROR: every system has at least one task.
 */
export function taskSelectionFrom(
  entries: Array<Record<string, string>>, what: string,
): { selected: string[]; available: string[]; entries: Array<Record<string, string>> } {
  const tasks = entries.filter(e => e['_type'] === 'rap-taskselection').map(withoutType);
  if (tasks.length === 0) {
    throw new RwsError(`${what}: the answer carried no rap-taskselection entry (classes seen: ${seen(entries)})`, 'PARSE_ERROR');
  }
  const nameOf = (t: Record<string, string>): string => t['name'] ?? t['_title'] ?? '';
  return {
    selected: tasks.filter(t => (t['state'] ?? '').toUpperCase() === 'ON').map(nameOf).filter(Boolean),
    available: tasks.map(nameOf).filter(Boolean),
    entries: tasks,
  };
}

/**
 * A controller environment variable's name as the request carries it: the
 * name without its leading `$`, which the path row sends as `%24` (ABB RWS
 * 1.0 Rev M "Get Controller environment variable"; RWS 2.0 Rev L
 * `/ctrl/${ENVNAME}`). INVALID_ARGUMENT for an empty name, before anything is
 * sent.
 */
export function envName(name: string, what: string): string {
  const bare = typeof name === 'string' ? name.trim().replace(/^\$/, '') : '';
  if (bare === '') {
    throw new RwsError(`${what}: the variable name must not be empty (for example HOME or $TEMP)`, 'INVALID_ARGUMENT');
  }
  return bare;
}

/**
 * The value of a controller environment variable: the `ctrl-env` entry's
 * `value` span (ABB's example answers `$TEMP` with `/hd0a/TEMP` on RWS 1.0
 * and `/TEMP` on RWS 2.0), else its `_value`. RW 6.16.03 answers the RWS 1.0
 * `?json=1` form with the value under `_value` (2026-10-18). PARSE_ERROR
 * when the answer has no such entry or the entry no value.
 */
export function envValueFrom(entries: Array<Record<string, string>>, what: string): string {
  const e = entries.find(x => x['_type'] === 'ctrl-env');
  const value = e?.['value'] ?? e?.['Value'] ?? e?.['_value'];
  if (value === undefined) {
    throw new RwsError(
      `${what}: the answer carried no ctrl-env entry with a value (classes seen: ${seen(entries)})`,
      'PARSE_ERROR',
    );
  }
  return value;
}

/**
 * The RobotWare version `getCompatibility` asks about, trimmed. ABB's path
 * is `/ctrl/compatibility/{robotware version}`, with `6.03.0101` and `7.16`
 * as its examples. A given version that is empty is refused before sending.
 * Without one, the method asks about the RobotWare the controller runs:
 * `own()` gives the `rwversion` of `GET /rw/system` (for example
 * `6.16.3007` or `8.2.1+1023`), sent as the controller wrote it. An own
 * version with no digit in it is PARSE_ERROR, before the compatibility
 * request is sent.
 */
export async function compatibilityVersion(
  version: string | undefined, own: () => Promise<string>, what: string,
): Promise<string> {
  if (version === undefined) {
    const mine = (await own()).trim();
    if (!/\d/.test(mine)) {
      throw new RwsError(
        `${what}: no version was given, and the controller's /rw/system answer carried no RobotWare version (rwversion ${mine === '' ? 'empty' : `'${mine}'`}). Nothing more was sent.`,
        'PARSE_ERROR',
      );
    }
    return mine;
  }
  const v = typeof version === 'string' ? version.trim() : '';
  if (v === '') {
    throw new RwsError(`${what}: the RobotWare version must not be empty (for example 7.16 or 6.03.0101); leave it out to ask about the version the controller runs`, 'INVALID_ARGUMENT');
  }
  return v;
}

/**
 * ABB's answer to `GET /ctrl/compatibility/{robotware version}`: one
 * `ctrl-compatibility` entry with a `status` of `true` or `false` (RWS 1.0
 * Rev M and RWS 2.0 Rev L show `true`). A status that is neither, or an
 * answer with no such entry, is PARSE_ERROR, never `compatible: false`.
 */
export function compatibilityFrom(entries: Array<Record<string, string>>, what: string): RobotWareCompatibility {
  const details = pickEntry(entries, ['ctrl-compatibility'], what);
  const status = details['status'];
  const flag = (status ?? '').trim().toLowerCase();
  if (flag !== 'true' && flag !== 'false') {
    throw new RwsError(
      `${what}: the ctrl-compatibility entry carried ${status === undefined ? 'no status' : `the status '${status}'`}, not true or false`,
      'PARSE_ERROR',
    );
  }
  return { compatible: flag === 'true', status: status.trim(), details };
}

/**
 * One configuration type: `cfg-dt-attributes-li` carrying `cfg-no-of-attributes`
 * and `cfg-dt-instances-li` carrying `cfg-no-of-instances` (ABB CFG_Service
 * Rev L "Get CFG Type"; the RW 6.16.03 XHTML form of the type, read 2026-09-29,
 * has the same two items). PARSE_ERROR when neither item is present.
 */
export function cfgTypeFrom(
  entries: Array<Record<string, string>>, domain: string, type: string, what: string,
): CfgTypeInfo {
  const attrs = entries.find(e => e['_type'] === 'cfg-dt-attributes-li');
  const insts = entries.find(e => e['_type'] === 'cfg-dt-instances-li');
  if (!attrs && !insts) {
    throw new RwsError(
      `${what}: the answer carried no cfg-dt-attributes-li / cfg-dt-instances-li entry (classes seen: ${seen(entries)})`,
      'PARSE_ERROR',
    );
  }
  return {
    domain,
    type,
    attributeCount: count(attrs?.['cfg-no-of-attributes']),
    instanceCount: count(insts?.['cfg-no-of-instances']),
  };
}

/**
 * The attribute definitions of a configuration type. Both generations answer
 * class `cfg-dt-attribute`: RWS 2.0 on RW 7.21, and the RWS 1.0 `?json=1` body
 * on RW 6.16.03 (read live 2026-10-03). The list spelling
 * `cfg-dt-attribute-li` is read too. `_type` is dropped.
 */
export function cfgAttributesFrom(entries: Array<Record<string, string>>): Array<Record<string, string>> {
  return entries
    .filter(e => e['_type'] === 'cfg-dt-attribute' || e['_type'] === 'cfg-dt-attribute-li')
    .map(withoutType);
}

/** Field names the DIPC queue information has been seen or documented under. */
const DIPC_NAME = ['queue-name', 'dipc-queue-name'];
const DIPC_SIZE = ['queue-size', 'dipc-queue-size'];
const DIPC_MAX = ['queue-max-msg-size', 'dipc-max-msg-size', 'max-msg-size'];
const DIPC_SLOT = ['queue-slot-id', 'dipc-queue-slot-id', 'slot-id'];

const first = (e: Record<string, string>, keys: readonly string[]): string | undefined => {
  for (const k of keys) { if (e[k] !== undefined && e[k] !== '') { return e[k]; } }
  return undefined;
};

/**
 * A DIPC queue's information. RWS 2.0 `/rw/dipc/{queue}/information` answers
 * class `dipc-queue` with `queue-name`, `queue-size`, `queue-max-msg-size` and
 * `queue-slot-id` (RW 7.21, 2026-08-04). The RWS 1.0 queue body is not
 * captured: a `dipc-queue*` entry, else any entry carrying one of those fields
 * (or its `dipc-` spelling), is read. PARSE_ERROR when none is present.
 */
export function dipcQueueInfoFrom(entries: Array<Record<string, string>>, queue: string, what: string): DipcQueueInfo {
  const known = [...DIPC_NAME, ...DIPC_SIZE, ...DIPC_MAX, ...DIPC_SLOT];
  const e = entries.find(x => x['_type'] === 'dipc-queue')
    ?? entries.find(x => /^dipc-queue/.test(x['_type'] ?? '') && known.some(k => x[k] !== undefined))
    ?? entries.find(x => known.some(k => x[k] !== undefined));
  if (!e) {
    throw new RwsError(`${what}: the answer carried no DIPC queue information (classes seen: ${seen(entries)})`, 'PARSE_ERROR');
  }
  return {
    name: first(e, DIPC_NAME) ?? e['_title'] ?? queue,
    size: count(first(e, DIPC_SIZE)),
    maxMsgSize: count(first(e, DIPC_MAX)),
    slotId: first(e, DIPC_SLOT),
  };
}

/**
 * A routine kind as the symbol search spells it: `prc`, `fun` or `trp`. Other
 * spellings a routine listing might use (PROC, procedure, FUNC, TRAP) map to
 * those; anything else is passed through lowercased.
 */
export function routineType(raw: string | undefined): string {
  const t = (raw ?? '').trim().toLowerCase();
  if (t === 'prc' || t === 'proc' || t === 'procedure') { return 'prc'; }
  if (t === 'fun' || t === 'func' || t === 'function') { return 'fun'; }
  if (t === 'trp' || t === 'trap') { return 'trp'; }
  return t;
}

const ROUTINE_KINDS: ReadonlySet<string> = new Set(['prc', 'fun', 'trp']);

/**
 * Routines of a module from a RAPID symbol search scoped to it: the PROC, FUNC
 * and TRAP hits whose symbol URL is directly `RAPID/{task}/{module}/{name}`
 * (RAPID names compare case-insensitively). A routine's own parameters and
 * local data are deeper in the URL and are left out.
 */
export function routinesFromSymbols(
  symbols: Array<{ symburl: string; name: string; symtyp: string }>, task: string, module: string,
): RapidRoutineInfo[] {
  const prefix = `RAPID/${task}/${module}/`.toLowerCase();
  return symbols
    .filter(s => ROUTINE_KINDS.has(routineType(s.symtyp)))
    .filter(s => {
      const url = (s.symburl || '').toLowerCase();
      return url.startsWith(prefix) && !url.slice(prefix.length).includes('/');
    })
    .map(s => ({ name: s.name || s.symburl.split('/').pop() || '', type: routineType(s.symtyp) }))
    .filter(r => r.name);
}

/** Headers never copied into FileMetadata.fields. */
const PRIVATE_HEADERS: ReadonlySet<string> = new Set(['set-cookie', 'cookie', 'authorization', 'www-authenticate']);

/**
 * A file's metadata from an RWS 2.0 `HEAD /fileservice/{path}` answer (ABB's
 * file service page Rev L, "Get File Meta Data", documented answer 204). No
 * answer has been captured on any build: every header is kept in `fields`
 * (cookies and credentials left out), `Last-Modified` and `Content-Type` are
 * named, and the size is `Content-Length` only on a 200 (a 204 has no body
 * whose length the header could state).
 */
export function fileMetadataFromHeaders(
  path: string, status: number, headers: Record<string, string | string[] | undefined>,
): FileMetadata {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (v === undefined || PRIVATE_HEADERS.has(key)) { continue; }
    fields[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return {
    path,
    size: status === 200 ? count(fields['content-length']) : undefined,
    modified: fields['last-modified'],
    contentType: fields['content-type'],
    fields,
  };
}

// ── Niche reads on both generations (2026-10-01) ─────────────────────────────

/**
 * The group id from a group argument: the id itself (`'7'`), or the group
 * resource `subscribe()` hands out (`'/subscription/7'`). Group ids are
 * decimal on every build seen (RW 6.16.03, 7.21.4, 8.2.1, 2026-09-29); letters,
 * digits, `_` and `-` are let through, anything else is INVALID_ARGUMENT
 * before a request is sent, so the read can only ever reach a group resource.
 */
export function subscriptionGroupId(group: string, what: string): string {
  const raw = typeof group === 'string' ? group.trim() : '';
  const id = raw.startsWith('/subscription/') ? raw.slice('/subscription/'.length) : raw;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new RwsError(
      `${what}: ${JSON.stringify(group)} is not a subscription group id or /subscription/{id} path`,
      'INVALID_ARGUMENT',
    );
  }
  return id;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Every JSON object whose `_type` is `type`, depth first, `_links` blocks skipped. */
function jsonOfType(node: Json, type: string, out: Array<{ [k: string]: Json }> = []): Array<{ [k: string]: Json }> {
  if (Array.isArray(node)) {
    for (const n of node) { jsonOfType(n, type, out); }
    return out;
  }
  if (node && typeof node === 'object') {
    if (node['_type'] === type) { out.push(node); }
    for (const [k, v] of Object.entries(node)) {
      if (k !== '_links' && v && typeof v === 'object') { jsonOfType(v, type, out); }
    }
  }
  return out;
}

/** A link href in an entry's `_links` block (`rel` = key). */
function jsonLink(e: { [k: string]: Json }, rel: string): string | undefined {
  const links = e['_links'];
  if (!links || typeof links !== 'object' || Array.isArray(links)) { return undefined; }
  const l = links[rel];
  if (!l || typeof l !== 'object' || Array.isArray(l)) { return undefined; }
  return typeof l['href'] === 'string' ? l['href'] : undefined;
}

/**
 * The subscription groups of a `GET /subscription` answer: one `subsgrp-li`
 * per group, its title the id and its `rel="events"` link the poll URL.
 * Every build answers XHTML here (RW 6.16.03 even to `?json=1`, RW 7.21.4 and
 * 8.2.1 even to a hal+json Accept; 2026-09-29); a JSON answer is read as
 * well, the poll URL then from `_links.events`. An empty answer, or an empty
 * list, is no group; an answer with typed entries and no `subsgrp-li` is
 * PARSE_ERROR.
 */
export function subscriptionGroupsFrom(body: string, what: string): SubscriptionGroupInfo[] {
  const group = (id: string, pollUrl?: string): SubscriptionGroupInfo =>
    ({ id, groupPath: `/subscription/${id}`, ...(pollUrl ? { pollUrl } : {}) });
  const out: SubscriptionGroupInfo[] = [];
  if (HalJsonParser.looksLikeJson(body)) {
    let root: Json = null;
    try { root = JSON.parse(body) as Json; } catch { root = null; }
    for (const e of jsonOfType(root, 'subsgrp-li')) {
      const id = typeof e['_title'] === 'string' ? e['_title'] : '';
      if (id) { out.push(group(id, jsonLink(e, 'events'))); }
    }
  } else {
    for (const m of body.matchAll(/<li class="subsgrp-li"([^>]*)>([\s\S]*?)<\/li>/g)) {
      const id = /title="([^"]*)"/.exec(m[1])?.[1] ?? '';
      const poll = /href="([^"]*)"\s+rel="events"/.exec(m[2])?.[1] ?? /rel="events"\s+href="([^"]*)"/.exec(m[2])?.[1];
      if (id) { out.push(group(id, poll)); }
    }
  }
  if (out.length === 0) {
    const entries = parseBody(body).getAllEntries();
    if (entries.length > 0) {
      throw new RwsError(`${what}: the answer carried no subsgrp-li entry (classes seen: ${seen(entries)})`, 'PARSE_ERROR');
    }
  }
  return out;
}

/**
 * The members of a `GET /subscription/{group}` answer: one `sub-resource` per
 * bound resource, its title the index and its self link the resource as the
 * group stores it (`;stateParam` suffix included). Read on RW 6.16.03, 7.21.4
 * and 8.2.1 (XHTML, 2026-09-29). No entry is an empty group; typed entries
 * none of which is a member are PARSE_ERROR.
 */
export function subscriptionMembersFrom(entries: Array<Record<string, string>>, what: string): SubscriptionGroupMember[] {
  const out = entries
    .filter(e => e['_type'] === 'sub-resource' && (e['_href'] ?? '') !== '')
    .map(e => ({ index: e['_title'] ?? '', resource: e['_href'] }));
  if (out.length === 0 && entries.length > 0) {
    throw new RwsError(`${what}: the answer carried no sub-resource entry (classes seen: ${seen(entries)})`, 'PARSE_ERROR');
  }
  return out;
}

/** A mechanical unit name as given; INVALID_ARGUMENT, before anything is sent, when it is empty. */
export function mechunitName(mechunit: string, what: string): string {
  if (typeof mechunit !== 'string' || mechunit.trim() === '') {
    throw new RwsError(`${what}: mechunit name is empty`, 'INVALID_ARGUMENT');
  }
  return mechunit;
}

/**
 * A value without one pair of surrounding double quotes. The XHTML form of the
 * motion supervision read quotes its values (`<span class="level">"100"</span>`
 * on RW 6.16.03, 2026-09-29, and in ABB Motion_System Rev L's XHTML example);
 * the json and hal+json forms do not.
 */
function unquote(v: string | undefined): string | undefined {
  if (v === undefined) { return undefined; }
  const t = v.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : v;
}

/** A number field that must be present and numeric (quoted or not); PARSE_ERROR otherwise. */
function requiredNumber(e: Record<string, string>, key: string, what: string): number {
  const n = count(unquote(e[key]));
  if (n === undefined) {
    throw new RwsError(`${what}: the answer carried no numeric ${key} (${JSON.stringify(e[key] ?? null)})`, 'PARSE_ERROR');
  }
  return n;
}

/**
 * Motion supervision: class `ms-motionsupervision` with `mode-enabled`
 * (TRUE/FALSE) and `level`, the same on both generations (RWS 2.0 per
 * mechunit on RW 7.21.4 and 8.2.1, RWS 1.0 at the root on RW 6.16.03; all
 * answered TRUE / 100 on 2026-09-29). The XHTML form wraps the values in
 * double quotes (`"TRUE"`, `"100"` on RW 6.16.03, 2026-09-29); one pair is
 * stripped. A missing entry or field is PARSE_ERROR.
 */
export function motionSupervisionFrom(entries: Array<Record<string, string>>, what: string): MotionSupervisionState {
  const e = pickEntry(entries, ['ms-motionsupervision'], what);
  const enabled = unquote(e['mode-enabled']);
  if (enabled === undefined) {
    throw new RwsError(`${what}: the answer carried no mode-enabled field`, 'PARSE_ERROR');
  }
  return { enabled: enabled.trim().toUpperCase() === 'TRUE', level: requiredNumber(e, 'level', what) };
}

/**
 * Path supervision: class `ms-pathsupervision` with `mode` and `level` (ABB
 * Motion_System Rev L "Get Path Supervision"; RW 8.1.1 answered ON / 100 on
 * 2026-09-27). As with motion supervision, one pair of double quotes around a
 * value (the XHTML form) is stripped. A missing entry or field is PARSE_ERROR.
 */
export function pathSupervisionFrom(entries: Array<Record<string, string>>, what: string): PathSupervisionState {
  const e = pickEntry(entries, ['ms-pathsupervision'], what);
  const mode = unquote(e['mode']);
  if (mode === undefined) {
    throw new RwsError(`${what}: the answer carried no mode field`, 'PARSE_ERROR');
  }
  return { mode, level: requiredNumber(e, 'level', what) };
}

/**
 * SMB data: the one `ms-mechunit-smbdata` entry (ABB Motion_System Rev L "Get
 * SMB Data"), its fields as the controller gave them. The mechunit's link to
 * the resource is `ms-mechunit-smbdata-li` and is never read as data.
 */
export function smbDataFrom(entries: Array<Record<string, string>>, what: string): Record<string, string> {
  return pickEntry(entries, ['ms-mechunit-smbdata'], what);
}

/**
 * Motor calibration names: one entry per joint, title `JointN` with
 * `joint-name` and `calib-name` (ABB Motion_System Rev L "Get Motor Calib
 * Names"). The class is `ms-mechunit-joint` on RW 7.21.4 and 8.2.1 and
 * numbered, `ms-mechunit-joint1` .. `ms-mechunit-joint6`, on RW 6.16.03
 * (`?json=1`, 2026-10-01); both are read. No entry is an empty list; typed
 * entries none of which is a joint are PARSE_ERROR.
 */
export function motorCalibFrom(entries: Array<Record<string, string>>, what: string): MechunitMotorCalib[] {
  const joints = entries.filter(e => /^ms-mechunit-joint\d*$/.test(e['_type'] ?? ''));
  if (joints.length === 0 && entries.length > 0) {
    throw new RwsError(`${what}: the answer carried no ms-mechunit-joint entry (classes seen: ${seen(entries)})`, 'PARSE_ERROR');
  }
  return joints.map(e => ({
    joint: e['_title'] ?? '',
    ...(e['joint-name'] !== undefined ? { jointName: e['joint-name'] } : {}),
    ...(e['calib-name'] !== undefined ? { calibName: e['calib-name'] } : {}),
  }));
}

/**
 * Compliance lead-through: class `ms-mechunit-complianceleadthrough` with
 * `status` (`active` / `Inactive`, ABB Motion_System Rev L "Get Compliance
 * Lead Through"). The RW 6.16.03 mechunit body uses the same class for its
 * LINK to the resource, with no `status` (2026-09-29), so only an entry that
 * carries `status` is read: a controller that ignored `?resource=lead-through`
 * and answered the mechunit is PARSE_ERROR, not a reading.
 */
export function leadThroughFrom(entries: Array<Record<string, string>>, what: string): LeadThroughState {
  const e = entries.find(x => x['_type'] === 'ms-mechunit-complianceleadthrough' && x['status'] !== undefined);
  if (!e) {
    throw new RwsError(
      `${what}: the answer carried no ms-mechunit-complianceleadthrough entry with a status (classes seen: ${seen(entries)})`,
      'PARSE_ERROR',
    );
  }
  return { active: e['status'].trim().toLowerCase() === 'active', status: e['status'] };
}

// ── Alias I/O and long-running jobs (both generations) ───────────────────────

/**
 * The alias I/O list: one `rap-alias-io` entry per alias, with `alias-name`,
 * `signal-name` and `type` (DI, DO, AI, AO, GI or GO). ABB documents the same
 * class and fields on both generations (RWS 1.0 Rev M and RWS 2.0 Rev L, "Get
 * AliasIO List"). `rap-aliasio-li` is the link to this resource in the
 * /rw/rapid listing, not an alias. An answer with no entries is an empty
 * list; one with typed entries but no `rap-alias-io` is PARSE_ERROR.
 */
export function aliasIoFrom(
  entries: Array<Record<string, string>>, what: string,
): Array<{ alias: string; signal: string; type?: string }> {
  const aliases = entries.filter(e => e['_type'] === 'rap-alias-io');
  if (aliases.length === 0 && entries.length > 0) {
    throw new RwsError(`${what}: the answer carried no rap-alias-io entry (classes seen: ${seen(entries)})`, 'PARSE_ERROR');
  }
  return aliases.map(e => ({
    alias: e['alias-name'] ?? '',
    signal: e['signal-name'] ?? '',
    ...(e['type'] !== undefined ? { type: e['type'] } : {}),
  }));
}

/**
 * The robot types of `GET /rw/system/robottype`: one `sys-robottype` entry
 * per robot, the type in `robot-type`, titled with the robot's number (ABB's
 * "Get robot type", RWS 1.0 Rev M and RWS 2.0 Rev L; the example lists two
 * robots, IRB 120-3/0.6 and IRB 140T-5/0.8 Type C). `type` is the first
 * robot's, as up to 1.4.x; `types` every robot's, in the controller's order.
 * ABB lists standard robots only (no positioners or tracks) and answers 204
 * when there is none, read as `{ type: '', types: [] }`.
 */
export function robotTypesFrom(entries: Array<Record<string, string>>): { type: string; variant?: string; types: string[] } {
  const robots = entries.filter(e => e['_type'] === 'sys-robottype' || 'robot-type' in e);
  const types = robots.map(e => e['robot-type'] ?? e['robottype'] ?? e['type'] ?? '');
  const variant = robots[0]?.['variant'];
  return { type: types[0] ?? '', ...(variant !== undefined ? { variant } : {}), types };
}

/**
 * Most pages `getBuildErrors` reads. ABB serves at most 30 errors a page
 * ("maximum value of limit is 30", RWS 1.0 Rev M and RWS 2.0 Rev L), so this
 * reads up to 1500.
 */
export const BUILD_ERROR_PAGES = 50;

/**
 * A task's build errors from the pages of `GET .../program/builderror`: one
 * `rap-builderrs` entry per error, with `ModuleName`, `row`, `column` and
 * `error` (ABB's "Get Build Errors", RWS 1.0 Rev M and RWS 2.0 Rev L; Rev L's
 * example also carries `error-num`; RW 7.21.4 and 8.2.1 add `type_of_error`).
 * The error text is entity-decoded (Rev M's example writes `&#39;`) and
 * trimmed (the controllers end it with a tab). An empty list is `[]`. Typed
 * entries with no `rap-builderrs` among them, or an error whose row or column
 * is not a number, are PARSE_ERROR, never a list that looks complete.
 */
export function buildErrorsFrom(pages: readonly string[], what: string): RapidBuildError[] {
  const out: RapidBuildError[] = [];
  for (const body of pages) {
    const entries = parseBody(body).getAllEntries();
    const errors = entries.filter(e => e['_type'] === 'rap-builderrs');
    if (errors.length === 0 && entries.length > 0) {
      throw new RwsError(`${what}: the answer carried no rap-builderrs entry (classes seen: ${seen(entries)})`, 'PARSE_ERROR');
    }
    for (const e of errors) {
      const row = count(e['row']);
      const column = count(e['column']);
      if (row === undefined || column === undefined) {
        throw new RwsError(`${what}: a build error has no row or column this client can read (fields: ${Object.keys(e).join(', ')})`, 'PARSE_ERROR');
      }
      const errorNumber = count(e['error-num']);
      const typeOfError = e['type_of_error']?.trim();
      out.push({
        module: decodeEntities(e['ModuleName'] ?? e['modulename'] ?? ''),
        row, column,
        error: decodeEntities(e['error'] ?? '').trim(),
        ...(errorNumber !== undefined ? { errorNumber } : {}),
        ...(typeOfError ? { typeOfError } : {}),
      });
    }
  }
  return out;
}

/**
 * The job id from the `Location` header of a 202 answer, `/progress/{id}`
 * (ABB: RWS 1.0 Rev M "Compress/Decompress Resource", RWS 2.0 Rev L
 * Controller service, compress and decompress). An absolute URL is read too.
 * `undefined` when the header is missing or names no progress resource.
 */
export function progressIdFrom(location: string | null | undefined): string | undefined {
  const m = /\/progress\/([^/?#]+)/.exec(location ?? '');
  return m ? m[1] : undefined;
}
