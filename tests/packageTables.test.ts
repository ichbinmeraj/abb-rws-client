import { describe, it, expect, expectTypeOf } from 'vitest';
import * as api from '../src/index.js';
import type { DomainTable, Operation, PathSpec, Effect, AccessKind } from '../src/index.js';
import { ALL_TABLES as INTERNAL, buildPath } from '../src/paths/index.js';
import { PANEL } from '../src/paths/panel.js';

/**
 * The path tables from the package entry (1.6.0): `ALL_TABLES`, `flatten`,
 * `evidenceOf` and the table types, so a tool builds its view of the surface
 * from the rows the client itself sends. They are the client's own tables,
 * frozen: nothing that imports them can change a path or an effect.
 */

describe('the path tables on the package entry', () => {
  it('are the tables the client reads, with flatten and evidenceOf', () => {
    expect(api.ALL_TABLES).toBe(INTERNAL);
    expect(api.ALL_TABLES.panel).toBe(PANEL);
    expect(Object.keys(api.ALL_TABLES)).toEqual([
      'panel', 'rapid', 'motion', 'io', 'cfgElogDipc', 'ctrl', 'systemMastership', 'usersUas', 'filesVision',
    ]);
    const sides = api.flatten(api.ALL_TABLES);
    // 509 sides in 1.5.4, less the two of the removed ctrl.restartController mirror.
    expect(sides.length).toBe(507);
    expect(sides.find(s => s.domain === 'panel' && s.operation === 'getSpeedRatio' && s.generation === 'rws2')?.spec)
      .toEqual({ method: 'GET', path: '/rw/panel/speedratio' });
    expect(api.evidenceOf(api.ALL_TABLES.panel.lockOperationMode, 'rws1')).toBe('built');
    expect(api.evidenceOf(api.ALL_TABLES.panel.lockOperationMode, 'rws2')).toBe('live');
    expect(api.evidenceOf(api.ALL_TABLES.panel.setOperationMode, 'rws1')).toBeUndefined();
  });

  it('export the table types', () => {
    expectTypeOf<Operation['effect']>().toEqualTypeOf<Effect>();
    expectTypeOf<NonNullable<Operation['access']>>().toEqualTypeOf<AccessKind>();
    expectTypeOf<DomainTable[string]>().toEqualTypeOf<Operation>();
    expectTypeOf<NonNullable<Operation['rws2']>>().toEqualTypeOf<PathSpec>();
  });

  it('keep the rest of src/paths internal: buildPath and the per-domain constants', () => {
    const names = Object.keys(api);
    for (const internal of ['buildPath', 'isBuiltOnly', 'PANEL', 'RAPID', 'CTRL']) { expect(names).not.toContain(internal); }
    expect(typeof buildPath).toBe('function');
  });

  it('are frozen all the way down: the map, each table, row, path spec, field list and evidence pair', () => {
    expect(Object.isFrozen(api.ALL_TABLES)).toBe(true);
    for (const table of Object.values(api.ALL_TABLES)) {
      expect(Object.isFrozen(table)).toBe(true);
      for (const op of Object.values(table)) {
        expect(Object.isFrozen(op)).toBe(true);
        if (typeof op.evidence === 'object') { expect(Object.isFrozen(op.evidence)).toBe(true); }
        for (const spec of [op.rws1, op.rws2]) {
          if (!spec) { continue; }
          expect(Object.isFrozen(spec)).toBe(true);
          if (spec.fields) { expect(Object.isFrozen(spec.fields)).toBe(true); }
        }
      }
    }
  });

  it('refuse a change: an assignment throws and the row keeps its value', () => {
    const op = api.ALL_TABLES.cfgElogDipc.readDipcMessage as unknown as Record<string, unknown>;
    expect(() => { op.effect = 'read'; }).toThrow(TypeError);
    expect(api.ALL_TABLES.cfgElogDipc.readDipcMessage.effect).toBe('write');
    const spec = api.ALL_TABLES.panel.setSpeedRatio.rws2 as unknown as { path: string; fields: string[] };
    expect(() => { spec.path = '/elsewhere'; }).toThrow(TypeError);
    expect(() => { spec.fields.push('x'); }).toThrow(TypeError);
    const tables = api.ALL_TABLES as unknown as Record<string, unknown>;
    expect(() => { tables.extra = {}; }).toThrow(TypeError);
    expect(() => { delete tables.panel; }).toThrow(TypeError);
    expect(buildPath(api.ALL_TABLES.panel.setSpeedRatio.rws2 as PathSpec)).toBe('/rw/panel/speedratio?action=setspeedratio');
  });
});
