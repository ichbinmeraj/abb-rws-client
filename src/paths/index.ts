/**
 * Path tables - the single source of "which URL does operation X use", per
 * generation, for the whole RWS surface.
 *
 * See PathSpec.ts for the design rationale. This barrel assembles the per-domain
 * tables into `ALL_TABLES`, which the conformance check (`npm run conformance`)
 * diffs against a live controller crawl, and which the clients will read for
 * their paths as call sites migrate off inline literals, domain by domain.
 *
 * Public surface note: nothing here is exported from `src/index.ts` yet. The
 * tables are an internal source of truth; exposing them is a separate, additive
 * decision.
 */

export type { DomainTable, Operation, PathSpec, HttpVerb } from './PathSpec.js';
export { buildPath, flatten } from './PathSpec.js';

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

/** Every domain table, keyed by domain id. The conformance crawler flattens this. */
export const ALL_TABLES: Record<string, DomainTable> = {
  panel: PANEL,
  rapid: RAPID,
  motion: MOTION,
  io: IO,
  cfgElogDipc: CFG_ELOG_DIPC,
  ctrl: CTRL,
  systemMastership: SYSTEM_MASTERSHIP,
  usersUas: USERS_UAS,
  filesVision: FILES_VISION,
};

export { PANEL, RAPID, MOTION, IO, CFG_ELOG_DIPC, CTRL, SYSTEM_MASTERSHIP, USERS_UAS, FILES_VISION };
