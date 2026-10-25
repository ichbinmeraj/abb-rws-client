/**
 * The classifier of the conformance check (scripts/conformance.mjs): which
 * resource family each advertised node belongs to, and which client operation
 * (if any) claims that family.
 *
 * A crawl below /rw meets nodes that are instances, not operations: one per
 * hardware device and per device property under /rw/devices, one per RAPID
 * task, mechanical unit, axis, I/O network and device. Counted one by one they
 * swamp the totals and move with whatever is configured on the controller, so
 * each node is first rewritten to its family (instance names become
 * parameters) and the family is what gets a verdict.
 *
 * Test infrastructure only - never shipped in the package.
 */

import { normalise } from './conformance-links.mjs';

// ─── families ────────────────────────────────────────────────────────────────

/**
 * Instance positions, applied in order. `{name}` takes any one segment except
 * the static names listed in `except`; `{name...}` takes every segment that is
 * left. A position already rewritten by an earlier rule matches its literal.
 */
export const FAMILY_RULES = [
  { template: '/rw/devices/{group}' },
  { template: '/rw/devices/{group}/{node...}' },
  // Beside the task instances, /rw/rapid/tasks holds static resources (RWS 2.0).
  { template: '/rw/rapid/tasks/{task}', except: ['spy', 'syncstate'] },
  { template: '/rw/rapid/tasks/{task}/pallet/{n}' },
  { template: '/rw/motionsystem/mechunits/{mechunit}' },
  { template: '/rw/motionsystem/mechunits/{mechunit}/axes/{axis}' },
  { template: '/rw/motionsystem/checkchangecount/{n}' },
  { template: '/rw/iosystem/networks/{network}' },
  { template: '/rw/iosystem/devices/{network}/{device}' },
  { template: '/rw/cfg/{domain}' },
  { template: '/rw/mastership/{domain}' },
];

const segs = p => p.split('/').filter(Boolean);
const isParam = s => s.startsWith('{') && s.endsWith('}');
const join = parts => '/' + parts.join('/');

/** The family of one advertised node: its path with instance names as parameters. */
export function familyOf(node) {
  let parts = segs(normalise(node));
  for (const rule of FAMILY_RULES) {
    const t = segs(rule.template);
    const rest = t[t.length - 1].endsWith('...}');
    if (parts.length < t.length) { continue; }
    let ok = true;
    for (let i = 0; i < t.length && ok; i++) {
      if (!isParam(t[i])) { ok = parts[i] === t[i]; continue; }
      if (parts[i] === t[i]) { continue; }
      if (isParam(parts[i]) || (rule.except ?? []).includes(parts[i])) { ok = false; }
    }
    if (!ok) { continue; }
    parts = rest ? [...t] : [...t, ...parts.slice(t.length)];
  }
  return join(parts);
}

// ─── claims the path tables do not carry ─────────────────────────────────────

/**
 * Verdicts for families the path tables in src/paths do not name. An
 * `implemented` claim lists the adapter methods that read the family (a unit
 * test checks each exists for each generation named); a `deliberate-gap` gives
 * the reason the client leaves it alone.
 */
export const CLAIMS = [
  {
    gens: ['rws1', 'rws2'], family: '/rw/retcode', verdict: 'implemented',
    methods: ['getReturnCode', 'describeReturnCode'],
    reason: 'Read with the code in the query (/rw/retcode?code=N); a bare GET is the dictionary entry point the crawl sees.',
  },
  {
    gens: ['rws1', 'rws2'], family: '/rw/devices', verdict: 'implemented',
    methods: ['listDeviceGroups', 'listSystemDevices'],
    reason: 'The device groups (HW_DEVICES, SW_RESOURCES).',
  },
  {
    gens: ['rws1', 'rws2'], family: '/rw/devices/{group}', verdict: 'implemented',
    methods: ['listControllerDevices', 'getDeviceTree'],
    reason: 'The devices of one group.',
  },
  {
    gens: ['rws1', 'rws2'], family: '/rw/devices/{group}/{node...}', verdict: 'implemented',
    methods: ['listControllerDevices'],
    reason: 'One node per hardware device, software resource and property: the same device-tree resource at any depth, read by passing the nested path (listControllerDevices(\'HW_DEVICES/CONTROLLER\')).',
  },
  {
    gens: ['rws1'], family: '/rw/rim', verdict: 'deliberate-gap', methods: [],
    reason: 'RobotWare installation service (default license, default settings, systems, boot server). Not in the RWS 1.0 reference, answers XHTML only (no JSON form), and installs systems rather than operating one.',
  },
  {
    gens: ['rws1'], family: '/rw/rim/infra', verdict: 'deliberate-gap', methods: [],
    reason: 'Part of the RobotWare installation service under /rw/rim (see there).',
  },
];

/**
 * Why a family nothing claims is still unmapped, for the report. The verdict
 * stays unmapped: these are real gaps in the client, not excused ones.
 */
export const UNMAPPED_NOTES = [
  {
    gens: ['rws1'], family: '/rw/rapid/taskselection',
    note: 'getTaskSelection reads the RWS 2.0 resource only (setTaskSelection is refused before sending); the RWS 1.0 one is not wrapped yet.',
  },
];

// ─── matching against the path tables ────────────────────────────────────────

const segMatch = (a, b) => a === b || isParam(a) || isParam(b);
/** True when every segment of `short` matches the same position of `long`. */
const prefixMatch = (short, long) => short.length <= long.length && short.every((s, i) => segMatch(s, long[i]));

/**
 * The table entry that claims a family, most specific first:
 *   exact    - the entry's path is the family (parameters match any segment)
 *   beneath  - the entry sits under the family (the client does something in it);
 *              the nearest such entry
 *   ancestor - the family sits under the entry (the entry's resource lists or
 *              acts on it); the deepest such entry
 * Within one kind, an implemented entry wins over a gap entry.
 */
function bestSpec(family, genSpecs) {
  const f = segs(family);
  let best = null;
  for (const s of genSpecs) {
    const p = segs(normalise(s.spec.path));
    let kind; let score;
    if (p.length === f.length && prefixMatch(p, f)) { kind = 'exact'; score = 3000; }
    else if (p.length > f.length && prefixMatch(f, p)) { kind = 'beneath'; score = 2000 - p.length; }
    else if (p.length < f.length && prefixMatch(p, f)) { kind = 'ancestor'; score = 1000 + p.length; }
    else { continue; }
    score = score * 2 + (s.spec.gap ? 0 : 1);
    if (!best || score > best.score) { best = { s, kind, score }; }
  }
  return best;
}

const unmappedNote = (fam, gen) => {
  const n = UNMAPPED_NOTES.find(u => u.family === fam && u.gens.includes(gen));
  return n ? { reason: n.note } : {};
};

/**
 * Classify one generation's advertised nodes. Returns one row per family,
 * sorted: `{ gen, resource, verdict, by, match, instances, reason? }`, where
 * `resource` is the family, `instances` how many advertised nodes it holds,
 * and `match` how the claim was found (`claim` for CLAIMS, else see bestSpec).
 */
export function classify(advertised, gen, specs) {
  const families = new Map();
  for (const node of advertised) {
    const fam = familyOf(node);
    families.set(fam, (families.get(fam) ?? 0) + 1);
  }
  const genSpecs = specs.filter(s => s.generation === gen);
  const rows = [];
  for (const [fam, instances] of [...families].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const claim = CLAIMS.find(c => c.family === fam && c.gens.includes(gen));
    if (claim) {
      rows.push({ gen, resource: fam, verdict: claim.verdict, by: claim.methods.join(', '), match: 'claim', instances, reason: claim.reason });
      continue;
    }
    const hit = bestSpec(fam, genSpecs);
    rows.push(hit
      ? { gen, resource: fam, verdict: hit.s.spec.gap ? 'deliberate-gap' : 'implemented', by: `${hit.s.domain}.${hit.s.operation}`, match: hit.kind, instances, ...(hit.s.spec.gap ? { reason: String(hit.s.spec.gap) } : {}) }
      : { gen, resource: fam, verdict: 'unmapped', by: '', match: '', instances, ...unmappedNote(fam, gen) });
  }
  return rows;
}

const staticPrefix = p => {
  const i = p.indexOf('{');
  return normalise(i === -1 ? p : p.slice(0, i));
};
const underOrEqual = (a, b) => a === b || a.startsWith(b.endsWith('/') ? b : b + '/');

/**
 * Table entries whose path no controller advertises. Only static paths count
 * (a parameterised one cannot be confirmed absent from a directory crawl), and
 * not gap entries or entries under a root the crawl never walks (`pruned`).
 */
export function orphans(advertised, gen, specs, pruned) {
  const out = [];
  for (const s of specs.filter(x => x.generation === gen)) {
    if (s.spec.gap || s.spec.path.includes('{')) { continue; }
    const prefix = staticPrefix(s.spec.path);
    if (pruned(prefix)) { continue; }
    if (!advertised.some(r => underOrEqual(prefix, r) || underOrEqual(r, prefix))) {
      out.push({ gen, resource: s.spec.path, verdict: 'orphan', by: `${s.domain}.${s.operation}`, match: '', instances: 0 });
    }
  }
  return out;
}

/** Counts per verdict. */
export function summarise(rows) {
  const count = v => rows.filter(r => r.verdict === v).length;
  return {
    implemented: count('implemented'),
    'deliberate-gap': count('deliberate-gap'),
    unmapped: count('unmapped'),
    orphan: count('orphan'),
  };
}
