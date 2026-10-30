/**
 * Path tables - the single source of "which URL does operation X use", per
 * generation, for the whole RWS surface.
 *
 * See PathSpec.ts for the design rationale. This barrel assembles the per-domain
 * tables into `ALL_TABLES`, which the conformance check (`npm run conformance`)
 * diffs against a live controller crawl, and which the clients will read for
 * their paths as call sites migrate off inline literals, domain by domain.
 *
 * Public surface: since 1.6.0 the package entry (`src/index.ts`) exports
 * `ALL_TABLES`, the table types, `flatten` and `evidenceOf`, so a tool can
 * build its own view of the surface from the same rows the client sends. The
 * tables are frozen, row by row, when this module loads: an operation's path
 * and effect are facts the client relies on, and nothing that imports them can
 * change them. The per-domain constants and `buildPath` stay internal.
 */

export type { DomainTable, Operation, PathSpec, HttpVerb, Tier, Evidence, OperationEvidence, Effect, AccessKind } from './PathSpec.js';
export { buildPath, flatten, evidenceOf, isBuiltOnly } from './PathSpec.js';

import type { DomainTable } from './PathSpec.js';
import { PANEL } from './panel.js';
import { RAPID } from './rapid.js';
import { MOTION } from './motion.js';
import { IO } from './io.js';
import { CFG_ELOG_DIPC } from './cfgElogDipc.js';
import { CTRL } from './ctrl.js';
import { SYSTEM_MASTERSHIP } from './systemMastership.js';
import { USERS_UAS } from './usersUas.js';
import { FILES_VISION } from './filesVision.js';

/** `table` with every row, path spec, field list and evidence pair frozen, and the table itself. */
function frozen(table: DomainTable): DomainTable {
  for (const op of Object.values(table)) {
    for (const spec of [op.rws1, op.rws2]) {
      if (spec === undefined) { continue; }
      if (spec.fields !== undefined) { Object.freeze(spec.fields); }
      Object.freeze(spec);
    }
    if (typeof op.evidence === 'object') { Object.freeze(op.evidence); }
    Object.freeze(op);
  }
  return Object.freeze(table);
}

/** Every domain table, keyed by domain id. The conformance crawler flattens this. Frozen. */
export const ALL_TABLES: Readonly<Record<string, DomainTable>> = Object.freeze({
  panel: frozen(PANEL),
  rapid: frozen(RAPID),
  motion: frozen(MOTION),
  io: frozen(IO),
  cfgElogDipc: frozen(CFG_ELOG_DIPC),
  ctrl: frozen(CTRL),
  systemMastership: frozen(SYSTEM_MASTERSHIP),
  usersUas: frozen(USERS_UAS),
  filesVision: frozen(FILES_VISION),
});

export { PANEL, RAPID, MOTION, IO, CFG_ELOG_DIPC, CTRL, SYSTEM_MASTERSHIP, USERS_UAS, FILES_VISION };
