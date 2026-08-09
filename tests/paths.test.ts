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
/**
 * Post-migration LOCK: the mappers now source paths from the tables, so
 * comparing a mapper to buildPath(table) would be tautological. These assert the
 * EXACT expected URL literals instead - the real regression net. Every value
 * here is the path the code produced BEFORE the migration; if a table edit (or a
 * migration mis-mapping) changes a URL, it fails here rather than as a 404
 * against a robot. Covers the highest-risk / trickiest ops across every domain.
 */
describe('path tables - exact URLs (RWS 2.0)', () => {
  it('panel', () => {
    expect(R2.controllerState()).toBe('/rw/panel/ctrl-state');
    expect(R2.setControllerState('motoron').path).toBe('/rw/panel/ctrl-state');
    expect(R2.operationMode()).toBe('/rw/panel/opmode');
    expect(R2.speedRatio()).toBe('/rw/panel/speedratio');
    expect(R2.setSpeedRatio(50).path).toBe('/rw/panel/speedratio?action=setspeedratio');
    expect(R2.collisionDetectionState()).toBe('/rw/panel/coldetstate');
    expect(R2.lockOperationMode('1234', true).path).toBe('/rw/panel/opmode/lock');
    expect(R2.unlockOperationMode().path).toBe('/rw/panel/opmode/unlock');
    expect(R2.acknowledgeOperationMode('auto').path).toBe('/rw/panel/opmode/acknowledge');
  });
  it('rapid execution', () => {
    expect(R2.rapidExecution()).toBe('/rw/rapid/execution');
    expect(R2.startRapid().path).toBe('/rw/rapid/execution/start');
    expect(R2.stopRapid().path).toBe('/rw/rapid/execution/stop');
    expect(R2.resetRapid().path).toBe('/rw/rapid/execution/resetpp');
    expect(R2.setExecutionCycle('once').path).toBe('/rw/rapid/execution/cycle');
    expect(R2.startProductionEntry().path).toBe('/rw/rapid/execution/startprodentry');
  });
  it('rapid load/save with params', () => {
    expect(R2.loadProgram('T_ROB1', 'HOME/p.pgf', 'add').path).toBe('/rw/rapid/tasks/T_ROB1/program/load');
    expect(R2.saveProgram('T_ROB1', 'HOME/p.pgf').path).toBe('/rw/rapid/tasks/T_ROB1/program/save');
    expect(R2.saveModuleAs('T_ROB1', 'Module1', 'm', 'TEMP:').path).toBe('/rw/rapid/tasks/T_ROB1/modules/Module1/save');
  });
  it('motion supervision (level segment, sensitivity field)', () => {
    expect(R2.setMotionSupervisionMode('ROB_1', 'on').path).toBe('/rw/motionsystem/mechunits/ROB_1/motionsupervision/mode');
    expect(R2.setMotionSupervisionSensitivity('ROB_1', 80).path).toBe('/rw/motionsystem/mechunits/ROB_1/motionsupervision/level');
    expect(R2.setPathSupervisionMode('ROB_1', 'on').path).toBe('/rw/motionsystem/mechunits/ROB_1/pathsupervision/mode');
  });
  it('ctrl backup', () => {
    expect(R2.createBackup('b').path).toBe('/ctrl/backup/create');
    expect(R2.restoreBackup('b').path).toBe('/ctrl/backup/restore');
    expect(R2.checkRestore('b').path).toBe('/ctrl/backup/check-restore');
  });
  it('mastership + control station', () => {
    expect(R2.requestMastership('edit').path).toBe('/rw/mastership/edit/request');
    expect(R2.releaseMastership('edit').path).toBe('/rw/mastership/edit/release');
    expect(R2.requestWriteAccess().path).toBe('/rw/controlstation/writeaccess/request');
    expect(R2.releaseWriteAccess().path).toBe('/rw/controlstation/writeaccess/release');
  });
});

describe('path tables - exact URLs (RWS 1.0)', () => {
  it('panel', () => {
    expect(R1.controllerState()).toBe('/rw/panel/ctrlstate');
    expect(R1.setControllerState('motoron').path).toBe('/rw/panel/ctrlstate?action=setctrlstate');
    expect(R1.operationMode()).toBe('/rw/panel/opmode');
    expect(R1.setSpeedRatio(50).path).toBe('/rw/panel/speedratio?action=setspeedratio');
    expect(R1.collisionDetectionState()).toBe('/rw/panel/coldetstate');
    expect(R1.restartController('restart').path).toBe('/rw/panel?action=restart');
    expect(R1.lockOperationMode('1234', true).path).toBe('/rw/panel/opmode?action=lock');
    expect(R1.unlockOperationMode().path).toBe('/rw/panel/opmode?action=unlock');
  });
  it('rapid execution (query-action form)', () => {
    expect(R1.rapidExecutionState()).toBe('/rw/rapid/execution');
    expect(R1.startRapid().path).toBe('/rw/rapid/execution?action=start');
    expect(R1.stopRapid().path).toBe('/rw/rapid/execution?action=stop');
    expect(R1.resetRapid().path).toBe('/rw/rapid/execution?action=resetpp');
    expect(R1.setExecutionCycle('once').path).toBe('/rw/rapid/execution?action=setcycle');
  });
  it('rapid tasks with params', () => {
    expect(R1.activateRapidTask('T_ROB1').path).toBe('/rw/rapid/tasks/T_ROB1?action=activate');
    expect(R1.loadModule('T_ROB1', '$HOME/m.mod', false).path).toBe('/rw/rapid/tasks/T_ROB1?action=loadmod');
  });
  it('mastership + system', () => {
    expect(R1.requestMastership('motion').path).toBe('/rw/mastership/motion?action=request');
    expect(R1.releaseMastership('motion').path).toBe('/rw/mastership/motion?action=release');
    expect(R1.systemInfo()).toBe('/rw/system');
  });
});
