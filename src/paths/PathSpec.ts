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
 * All paths and generation quirks in the tables are live-verified against the
 * running VCs (IRC5 RW6.16, OmniCore RW7.21 / RW8.1.1); the ABB PDF has errors,
 * so the controller wins. See docs/tasks/rws-conformance-loop.md.
 */

/** HTTP methods the RWS surface uses. */
export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'DELETE';

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

/** An operation across both generations. Either side may be absent. */
export interface Operation {
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
  return spec.action ? `${filled}?action=${spec.action}` : filled;
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
