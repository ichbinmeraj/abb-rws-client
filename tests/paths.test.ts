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
});
