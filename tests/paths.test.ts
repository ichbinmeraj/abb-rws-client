/**
 * Path-table integrity and fidelity tests.
 *
 * The path tables in src/paths are the single source of RWS URLs, but they are
 * only trustworthy if (a) every entry is well-formed and (b) they agree with the
 * paths the shipped code actually issues today. This suite asserts both, so a
 * typo in a table is caught here rather than as a 404 against a controller - and
 * so the eventual migration of call sites onto the tables has a safety net that
 * proves the tables match the current behaviour before anything is rewired.
 */

import { describe, it, expect } from 'vitest';
import { ALL_TABLES, buildPath, flatten } from '../src/paths/index.js';
import type { PathSpec } from '../src/paths/index.js';
import * as R2 from '../src/ResourceMapper2.js';
import * as R1 from '../src/ResourceMapper.js';

const specs = flatten(ALL_TABLES);

describe('path tables - structural integrity', () => {
  it('has the expected shape and scale', () => {
    // A regression guard on the coarse totals - a domain silently emptying, or
    // a table failing to load, changes these.
    expect(Object.keys(ALL_TABLES).length).toBe(9);
    expect(specs.length).toBeGreaterThan(380);
    const byGen = { rws1: 0, rws2: 0 };
    for (const s of specs) { byGen[s.generation]++; }
    expect(byGen.rws1).toBeGreaterThan(120);
    expect(byGen.rws2).toBeGreaterThan(240);
  });

  it('every spec is well-formed', () => {
    const bad: string[] = [];
    for (const { domain, operation, generation, spec } of specs) {
      const where = `${domain}.${operation}.${generation}`;
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(spec.method)) { bad.push(`${where}: bad method ${spec.method}`); }
      if (!spec.path.startsWith('/')) { bad.push(`${where}: path must start with / (${spec.path})`); }
      if (/\/\//.test(spec.path)) { bad.push(`${where}: double slash in ${spec.path}`); }
      if (spec.path.includes('?')) { bad.push(`${where}: query string in path (use action) ${spec.path}`); }
      // Balanced {param} braces.
      const open = (spec.path.match(/\{/g) ?? []).length;
      const close = (spec.path.match(/\}/g) ?? []).length;
      if (open !== close) { bad.push(`${where}: unbalanced braces in ${spec.path}`); }
      // A GET/DELETE with body fields is suspicious.
      if ((spec.method === 'GET') && spec.fields?.length) { bad.push(`${where}: GET with fields`); }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('operation ids are unique within each domain', () => {
    for (const [domain, table] of Object.entries(ALL_TABLES)) {
      const ids = Object.keys(table);
      expect(new Set(ids).size, `duplicate op id in ${domain}`).toBe(ids.length);
    }
  });

  it('buildPath fills parameters and rejects missing ones', () => {
    expect(buildPath({ method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/reset' }, { task: 'T_ROB1' }))
      .toBe('/rw/rapid/tasks/T_ROB1/pcp/reset');
    // action becomes a query.
    expect(buildPath({ method: 'POST', path: '/rw/panel/ctrlstate', action: 'setctrlstate' }))
      .toBe('/rw/panel/ctrlstate?action=setctrlstate');
    // encodes values.
    expect(buildPath({ method: 'GET', path: '/x/{name}' }, { name: 'a/b' })).toBe('/x/a%2Fb');
    // missing param throws, naming the param.
    expect(() => buildPath({ method: 'GET', path: '/x/{task}' }, {})).toThrow(/task/);
  });
});

/**
 * Fidelity: where a mapper function still exists, the table must produce the
 * SAME path. This is the proof the tables are faithful to shipped behaviour, and
 * the precondition for migrating call sites onto them.
 */
describe('path tables - fidelity to the RWS 2.0 mapper', () => {
  const cases: Array<[string, string, string]> = [
    // [op, table path via buildPath, mapper path]
    ['getControllerState', buildPath(ALL_TABLES.panel.getControllerState.rws2 as PathSpec), R2.controllerState()],
    ['operationMode', buildPath(ALL_TABLES.panel.getOperationMode.rws2 as PathSpec), R2.operationMode()],
    ['speedRatio', buildPath(ALL_TABLES.panel.getSpeedRatio.rws2 as PathSpec), R2.speedRatio()],
    ['collisionDetectionState', buildPath(ALL_TABLES.panel.getCollisionDetectionState.rws2 as PathSpec), R2.collisionDetectionState()],
  ];
  for (const [op, tablePath, mapperPath] of cases) {
    it(`panel.${op} matches ResourceMapper2`, () => {
      expect(tablePath).toBe(mapperPath);
    });
  }

  it('panel.setControllerState matches ResourceMapper2 (path)', () => {
    const spec = ALL_TABLES.panel.setControllerState.rws2 as PathSpec;
    expect(buildPath(spec)).toBe(R2.setControllerState('motoron').path);
  });

  it('panel.setSpeedRatio keeps the ?action= form the mapper uses', () => {
    const spec = ALL_TABLES.panel.setSpeedRatio.rws2 as PathSpec;
    // ResourceMapper2.setSpeedRatio returns { path } already carrying the query.
    expect(buildPath(spec)).toBe(R2.setSpeedRatio(50).path);
  });

  // Every migrated panel WRITE: the mapper now sources its path from the table,
  // so these lock that the round-trip is identical to the pre-migration literal.
  it('all migrated RWS 2.0 panel writes match table paths', () => {
    expect(R2.setControllerState('motoron').path).toBe(buildPath(ALL_TABLES.panel.setControllerState.rws2 as PathSpec));
    expect(R2.setOperationMode('auto').path).toBe(buildPath(ALL_TABLES.panel.setOperationMode.rws2 as PathSpec));
    expect(R2.lockOperationMode('1234', true).path).toBe(buildPath(ALL_TABLES.panel.lockOperationMode.rws2 as PathSpec));
    expect(R2.unlockOperationMode().path).toBe(buildPath(ALL_TABLES.panel.unlockOperationMode.rws2 as PathSpec));
    expect(R2.acknowledgeOperationMode('auto').path).toBe(buildPath(ALL_TABLES.panel.acknowledgeOperationMode.rws2 as PathSpec));
  });
});

describe('path tables - fidelity to the RWS 1.0 mapper', () => {
  const cases: Array<[string, string, string]> = [
    ['controllerState', buildPath(ALL_TABLES.panel.getControllerState.rws1 as PathSpec), R1.controllerState()],
    ['operationMode', buildPath(ALL_TABLES.panel.getOperationMode.rws1 as PathSpec), R1.operationMode()],
    ['speedRatio', buildPath(ALL_TABLES.panel.getSpeedRatio.rws1 as PathSpec), R1.speedRatio()],
  ];
  for (const [op, tablePath, mapperPath] of cases) {
    it(`panel.${op} matches ResourceMapper`, () => {
      expect(tablePath).toBe(mapperPath);
    });
  }

  it('panel.setControllerState matches ResourceMapper (?action= form)', () => {
    const spec = ALL_TABLES.panel.setControllerState.rws1 as PathSpec;
    expect(buildPath(spec)).toBe(R1.setControllerState('motoron').path);
  });

  it('all migrated RWS 1.0 panel writes match table paths', () => {
    expect(R1.setSpeedRatio(50).path).toBe(buildPath(ALL_TABLES.panel.setSpeedRatio.rws1 as PathSpec));
    expect(R1.collisionDetectionState()).toBe(buildPath(ALL_TABLES.panel.getCollisionDetectionState.rws1 as PathSpec));
    expect(R1.restartController('restart').path).toBe(buildPath(ALL_TABLES.panel.restartController.rws1 as PathSpec));
    expect(R1.lockOperationMode('1234', true).path).toBe(buildPath(ALL_TABLES.panel.lockOperationMode.rws1 as PathSpec));
    expect(R1.unlockOperationMode().path).toBe(buildPath(ALL_TABLES.panel.unlockOperationMode.rws1 as PathSpec));
  });
});

/**
 * Broad cross-domain verification. These operations are NOT migrated yet - the
 * assertions instead check that the agent-authored tables for rapid, motion and
 * ctrl agree with what the mapper functions produce today. A mismatch here means
 * a table is WRONG (a path the migration would then get wrong), so this both
 * validates the tables beyond panel and is the safety net for migrating those
 * domains next.
 */
describe('path tables - cross-domain fidelity (rapid / motion / ctrl)', () => {
  it('rapid execution paths agree with ResourceMapper2', () => {
    expect(buildPath(ALL_TABLES.rapid.getRapidExecutionState.rws2 as PathSpec)).toBe(R2.rapidExecution());
    expect(buildPath(ALL_TABLES.rapid.startRapid.rws2 as PathSpec)).toBe(R2.startRapid().path);
    expect(buildPath(ALL_TABLES.rapid.stopRapid.rws2 as PathSpec)).toBe(R2.stopRapid().path);
    expect(buildPath(ALL_TABLES.rapid.resetRapid.rws2 as PathSpec)).toBe(R2.resetRapid().path);
    expect(buildPath(ALL_TABLES.rapid.setExecutionCycle.rws2 as PathSpec)).toBe(R2.setExecutionCycle('once').path);
    expect(buildPath(ALL_TABLES.rapid.startProductionEntry.rws2 as PathSpec)).toBe(R2.startProductionEntry().path);
  });

  it('rapid execution paths agree with ResourceMapper (RWS 1.0)', () => {
    expect(buildPath(ALL_TABLES.rapid.getRapidExecutionState.rws1 as PathSpec)).toBe(R1.rapidExecutionState());
    expect(buildPath(ALL_TABLES.rapid.startRapid.rws1 as PathSpec)).toBe(R1.startRapid().path);
    expect(buildPath(ALL_TABLES.rapid.stopRapid.rws1 as PathSpec)).toBe(R1.stopRapid().path);
    expect(buildPath(ALL_TABLES.rapid.resetRapid.rws1 as PathSpec)).toBe(R1.resetRapid().path);
    expect(buildPath(ALL_TABLES.rapid.setExecutionCycle.rws1 as PathSpec)).toBe(R1.setExecutionCycle('once').path);
  });

  it('motion supervision paths agree with ResourceMapper2 (incl. the level/sensitivity trap)', () => {
    expect(buildPath(ALL_TABLES.motion.setMotionSupervisionMode.rws2 as PathSpec, { mechunit: 'ROB_1' }))
      .toBe(R2.setMotionSupervisionMode('ROB_1', 'on').path);
    // The path segment is `level` but the body field is `sensitivity` - the
    // table must carry the segment, and this proves it does.
    expect(buildPath(ALL_TABLES.motion.setMotionSupervisionSensitivity.rws2 as PathSpec, { mechunit: 'ROB_1' }))
      .toBe(R2.setMotionSupervisionSensitivity('ROB_1', 80).path);
    expect(buildPath(ALL_TABLES.motion.setPathSupervisionMode.rws2 as PathSpec, { mechunit: 'ROB_1' }))
      .toBe(R2.setPathSupervisionMode('ROB_1', 'on').path);
  });

  it('ctrl backup paths agree with ResourceMapper2', () => {
    expect(buildPath(ALL_TABLES.ctrl.createBackup.rws2 as PathSpec)).toBe(R2.createBackup('b').path);
    expect(buildPath(ALL_TABLES.ctrl.restoreBackup.rws2 as PathSpec)).toBe(R2.restoreBackup('b').path);
    expect(buildPath(ALL_TABLES.ctrl.checkRestore.rws2 as PathSpec)).toBe(R2.checkRestore('b').path);
  });
});
