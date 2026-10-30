/**
 * Path tables - the single source of "which URL does operation X use", per
 * protocol generation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this module, ~233 URL path literals were scattered across eight files:
 * some in the mapper functions (ResourceMapper / ResourceMapper2), most inline
 * in method bodies. There was no owner of the path for an operation, so:
 *   - an ABB endpoint change meant hunting six files to find every reference;
 *   - the two generations drifted (RWS 1.0 `ctrlstate`, RWS 2.0 `ctrl-state`)
 *     with nothing forcing the difference to be visible or intentional;
 *   - a path could be wrong for months (keyless-motoron was written off on
 *     `/rw/panel/keyless-motoron`; it is real at
 *     `/rw/panel/ctrl-state/keyless-motoron`) because no one place listed it;
 *   - building a conformance map - "does the client cover what the controller
 *     advertises?" - was archaeology instead of a table lookup.
 *
 * A path table fixes all of that at once. Every operation states its URL here,
 * keyed by a stable operation id, for each generation that has it. Because this
 * is the ONLY source of paths, a wrong entry is a broken request that the tests
 * catch - not a stale comment nobody notices. And because it is data, it can be
 * enumerated: `npm run conformance` diffs these tables against a live controller
 * crawl, so after any RobotWare upgrade the new/moved/removed endpoints are a
 * diff rather than an investigation.
 *
 * WHAT "CONFORMANCE" MEANS HERE
 * ----------------------------
 * Not that the public API mirrors RWS paths literally - it cannot (no breaking
 * changes to src/index.ts, and the generations genuinely differ in shape:
 * mastership vs the Control Station Service, `$HOME` vs `HOME`, prefix vs suffix
 * symbol paths). It means one obvious home per operation, and a mechanical,
 * checkable path -> operation mapping.
 *
 * Paths come from the controllers' own forms and live calls on the VCs (IRC5
 * RW6.16, OmniCore RW7.21 / RW8.x); the ABB PDF has errors, so the controller
 * wins. Not every row has run: each row's `evidence` says whether its request
 * has a logged success (`live`: a 2xx in a probe log or a functional-test
 * trace) or not (`built`), and its `tier` says how central it is. `npm run conformance`
 * checks the resource paths against the live controllers.
 */

/**
 * HTTP methods the RWS surface uses. `HEAD` is RWS 2.0's file metadata read
 * (`HEAD /fileservice/{path}`, ABB's file service page Rev L); RW 7.21.4 and
 * 8.2.1 list it in a file's `Allow` header (read 2026-09-29).
 */
export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';

/**
 * One operation's URL on one generation.
 *
 * `path` is the RESOURCE path with `{param}` placeholders for runtime values
 * (`{task}`, `{module}`, `{name}`, ...). It is what the conformance crawler
 * diffs against the controller's advertised resource tree, so it must be the
 * bare resource - query modifiers live in their own fields.
 */
export interface PathSpec {
  method: HttpVerb;
  /** Resource path, `{param}` placeholders, NO query string. */
  path: string;
  /**
   * RWS 1.0 `?action=` verb, when the operation is a query-action rather than a
   * distinct resource. RWS 1.0 writes to `/rw/panel/ctrlstate?action=setctrlstate`;
   * RWS 2.0 POSTs plainly to `/rw/panel/ctrl-state`. Encoding this here is what
   * makes that difference visible instead of buried in two method bodies.
   */
  action?: string;
  /**
   * A fixed query that selects the resource, without the `?`: RWS 1.0 reads
   * some resources as a query on their parent (`/rw/rapid/tasks/{task}` with
   * `resource=task-struc-change-count`, ABB's RWS 1.0 manual Rev M), where
   * RWS 2.0 has a path of their own. `buildPath` puts it before `action`.
   */
  query?: string;
  /**
   * Body form-field names for a write, in the order the controller's OPTIONS
   * form lists them. Documentation and a conformance signal; the mapper still
   * owns turning caller arguments into values.
   */
  fields?: readonly string[];
  /**
   * Set when the shipped client deliberately does NOT wrap this, with the
   * controller's own reason (e.g. "404 on all three - resource absent",
   * "403 Option is missing"). Keeps the table a complete record of the surface,
   * not just the implemented part, so conformance can tell "we chose not to"
   * from "we missed it".
   */
  gap?: string;
}

/**
 * How much of the RWS surface an operation stands for.
 *
 * - `core`: what every robot application needs: motors, operating mode,
 *   speed, RAPID run/stop/reset and variables, signals, mastership and RW8
 *   write access, the event log, joint and Cartesian position reads.
 * - `common`: what a cell tool reaches for regularly: modules and programs,
 *   files, configuration, tasks, the program pointer, backups, I/O networks
 *   and devices, kinematics, jogging, subscriptions.
 * - `niche`: options, commissioning, diagnostics, virtual-controller
 *   simulation and the rest of the long tail.
 */
export type Tier = 'core' | 'common' | 'niche';

/**
 * Whether a row's request has run against a controller.
 *
 * - `live`: a probe log or a functional-test trace holds this request with a
 *   2xx answer. Nothing else counts: an unlogged record, a form read or a
 *   resource listing is not `live`. tests/fixtures/evidence-index.json lists
 *   one logged success per live side (scripts/evidence-index.mjs writes it).
 * - `built`: built from the controller's own form or ABB's documentation, with
 *   no logged success.
 */
export type Evidence = 'live' | 'built';

/**
 * A row's evidence: one value when every generation it wraps agrees, or one
 * value per wrapped generation when they differ. A recorded `gap` side wraps
 * nothing, so it carries no evidence; a row with only gap sides is `built`.
 */
export type OperationEvidence = Evidence | { readonly rws1: Evidence; readonly rws2: Evidence };

/**
 * What an operation does to the controller, whatever HTTP verb carries it.
 *
 * - `read`: changes nothing on the controller. Some reads are POSTs: the
 *   RAPID symbol, signal and device searches, IK and FK, the validations, and
 *   the RWS 2.0 restore check.
 * - `write`: changes the controller's state, program, configuration, files or
 *   a queue. One write is a GET: reading a DIPC message removes it from the
 *   queue (ABB's DIPC Service, Rev L).
 * - `session`: changes only this client's own session on the controller (its
 *   subscription group), nothing the controller does or shows a person.
 */
export type Effect = 'read' | 'write' | 'session';

/**
 * The client's own access handling, which an operation belongs to. The client
 * sends these itself: it takes mastership or RobotWare 8 write access inside
 * each write that needs it, registers the control station at connect, and
 * leaves RMMP and the motion-control declaration to a person.
 *
 * - `mastership`: mastership domains, with or without an id, and the
 *   mastership watchdog.
 * - `control-station`: RobotWare 8 control-station registration, write
 *   access, the release appeal, the motion-control declaration and external
 *   control.
 * - `rmmp`: requesting and cancelling RMMP (RobotWare 6 and 7, manual mode).
 * - `user`: the session's own user (its registration, impersonation).
 */
export type AccessKind = 'mastership' | 'control-station' | 'rmmp' | 'user';

/** An operation across both generations. Either side may be absent. */
export interface Operation {
  /** Which tier of the RWS surface the operation belongs to. */
  readonly tier: Tier;
  /** Whether the request has run against a controller, per generation where they differ. */
  readonly evidence: OperationEvidence;
  /** What the operation does to the controller (see `Effect`); the verb alone misleads for some rows. */
  readonly effect: Effect;
  /**
   * Set when the row is part of the client's own access handling (see
   * `AccessKind`). `RobotManager.call` refuses these, and a tool that offers
   * the operations to a person should not offer them.
   */
  readonly access?: AccessKind;
  /** One-line human description - what the operation does. */
  readonly summary: string;
  /** RWS 1.0 (IRC5 / RobotWare 6) spec, or undefined if 1.0 lacks it. */
  readonly rws1?: PathSpec;
  /** RWS 2.0 (OmniCore / RobotWare 7+) spec, or undefined if 2.0 lacks it. */
  readonly rws2?: PathSpec;
  /**
   * A generation difference worth stating: different path shape, query-action
   * vs plain POST, one-generation-only, a known controller quirk. Read by
   * CONFORMANCE.md so the differences are documented in one place.
   */
  readonly note?: string;
}

/** A domain table: operation id -> operation. */
export type DomainTable = Readonly<Record<string, Operation>>;

/**
 * The evidence for one generation of an operation, or `undefined` when the
 * generation is absent or a recorded gap (nothing is wrapped there).
 */
export function evidenceOf(op: Operation, generation: 'rws1' | 'rws2'): Evidence | undefined {
  const spec = op[generation];
  if (spec === undefined || spec.gap !== undefined) { return undefined; }
  return typeof op.evidence === 'string' ? op.evidence : op.evidence[generation];
}

/** True when no generation of the operation has run against a controller. */
export function isBuiltOnly(op: Operation): boolean {
  return typeof op.evidence === 'string' ? op.evidence === 'built' : false;
}

/**
 * Fill `{param}` placeholders in a path spec.
 *
 * The one place path interpolation happens, so encoding is consistent and a
 * missing parameter fails loudly rather than sending a literal `{task}` to the
 * controller. Values are URL-encoded EXCEPT the placeholder-free segments, which
 * are already safe.
 */
export function buildPath(spec: PathSpec, params: Record<string, string | number> = {}): string {
  const filled = spec.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = params[key];
    if (v === undefined || v === null) {
      throw new Error(`buildPath: missing parameter "${key}" for ${spec.method} ${spec.path}`);
    }
    return encodeURIComponent(String(v));
  });
  const query = [spec.query, spec.action ? `action=${spec.action}` : undefined].filter(Boolean).join('&');
  return query ? `${filled}?${query}` : filled;
}

/**
 * Every path spec across a set of domain tables, flattened for the conformance
 * crawler. Each entry keeps its operation id, generation and domain so the diff
 * report can name exactly what is unmapped or orphaned.
 */
export function flatten(
  tables: Record<string, DomainTable>,
): Array<{ domain: string; operation: string; generation: 'rws1' | 'rws2'; spec: PathSpec }> {
  const out: Array<{ domain: string; operation: string; generation: 'rws1' | 'rws2'; spec: PathSpec }> = [];
  for (const [domain, table] of Object.entries(tables)) {
    for (const [operation, op] of Object.entries(table)) {
      if (op.rws1) { out.push({ domain, operation, generation: 'rws1', spec: op.rws1 }); }
      if (op.rws2) { out.push({ domain, operation, generation: 'rws2', spec: op.rws2 }); }
    }
  }
  return out;
}
