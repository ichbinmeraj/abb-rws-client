import { describe, it, expect } from 'vitest';
import { ALL_TABLES } from '../src/paths/index.js';
import type { Operation, PathSpec } from '../src/paths/index.js';

/**
 * Every path-table row says what it does to the controller (`effect`), and the
 * rows that belong to the client's own access handling say so (`access`). A
 * tool that offers the operations to a person reads these instead of the HTTP
 * verb, which misleads for 17 rows. The lists below are exact on purpose: a
 * new row whose effect the verb does not give, or a new row on an access
 * resource, fails here until it is classified.
 */

const EFFECTS = ['read', 'write', 'session'] as const;
const ACCESS = ['mastership', 'control-station', 'rmmp', 'user'] as const;

function rows(): Array<{ key: string; id: string; op: Operation }> {
  const out: Array<{ key: string; id: string; op: Operation }> = [];
  for (const [domain, table] of Object.entries(ALL_TABLES)) {
    for (const [id, op] of Object.entries(table)) { out.push({ key: `${domain}.${id}`, id, op }); }
  }
  return out;
}

function sides(op: Operation): PathSpec[] {
  return [op.rws1, op.rws2].filter((s): s is PathSpec => s !== undefined);
}

/** The effect a row's verb alone would suggest: GET and HEAD read, anything else writes. */
function verbEffect(op: Operation): string {
  const verbs = new Set(sides(op).map(s => (s.method === 'GET' || s.method === 'HEAD') ? 'read' : 'write'));
  return verbs.size === 1 ? [...verbs][0] : 'mixed';
}

describe('path-table effects', () => {
  it('every row carries an effect, and access only where it belongs to the access handling', () => {
    const bad = rows().filter(({ op }) =>
      !(EFFECTS as readonly string[]).includes(op.effect)
      || (op.access !== undefined && !(ACCESS as readonly string[]).includes(op.access))).map(r => r.key);
    expect(bad).toEqual([]);
  });

  it('the effect follows the verb except on exactly these 17 rows', () => {
    const differs = rows().filter(({ op }) => op.effect !== verbEffect(op)).map(({ key, op }) => `${key} ${op.effect}`);
    expect(differs.sort()).toEqual([
      // POSTs that change nothing: searches, IK and FK, validations, and the
      // RWS 2.0 restore check (a GET on RWS 1.0).
      'cfgElogDipc.validateCfgFile read',
      'cfgElogDipc.validateCfgInstances read',
      'cfgElogDipc.validateInstanceBeforeDelete read',
      'ctrl.checkRestore read',
      'io.searchIoDevices read',
      'io.searchSignals read',
      'io.searchSignalsEx read',
      'motion.calcCartesianFromJoints read',
      'motion.calcJointsFromCartesian read',
      'rapid.listModuleRoutines read',
      'rapid.searchRapidSymbols read',
      'rapid.validateRapidValue read',
      // A GET that removes the message it reads from the queue.
      'cfgElogDipc.readDipcMessage write',
      // The subscription group is the session's own.
      'filesVision.createSubscription session',
      'filesVision.unsubscribeGroup session',
      'filesVision.unsubscribeResource session',
      'filesVision.updateSubscriptionGroup session',
    ].sort());
  });

  it('the session rows are the subscription group, and every subscription change is one', () => {
    for (const { key, op } of rows()) {
      const onGroup = sides(op).some(s => s.path.startsWith('/subscription') && s.method !== 'GET');
      expect(op.effect === 'session', key).toBe(onGroup);
    }
  });

  it('every row with a gap on every side still says what it would do', () => {
    const gapOnly = rows().filter(({ op }) => sides(op).every(s => s.gap !== undefined));
    expect(gapOnly.length).toBe(14);
    for (const { key, op } of gapOnly) { expect(op.effect, key).toBe(verbEffect(op)); }
  });
});

describe('path-table access rows', () => {
  it('are exactly the writes on the mastership, control-station and session-user resources', () => {
    const onAccessResource = (op: Operation): boolean => sides(op).some(s =>
      s.method !== 'GET' && /^\/(rw\/mastership|rw\/controlstation|users)(\/|$)/.test(s.path));
    for (const { key, op } of rows()) {
      expect(op.access !== undefined, key).toBe(onAccessResource(op));
      if (op.access !== undefined) { expect(op.effect, key).toBe('write'); }
    }
  });

  it('name these 18 rows, by kind', () => {
    const byKind: Record<string, string[]> = {};
    for (const { key, op } of rows()) {
      if (op.access) { (byKind[op.access] ??= []).push(key); }
    }
    expect(byKind).toEqual({
      mastership: [
        'systemMastership.requestMastership', 'systemMastership.releaseMastership',
        'systemMastership.requestMastershipAll', 'systemMastership.releaseMastershipAll',
        'systemMastership.requestMastershipWithId', 'systemMastership.releaseMastershipWithId',
        'systemMastership.resetMastershipWatchdog',
      ],
      'control-station': [
        'systemMastership.registerControlStationRemote', 'systemMastership.registerControlStationLocal',
        'systemMastership.requestWriteAccess', 'systemMastership.releaseWriteAccess',
        'systemMastership.appealWriteAccessRelease', 'systemMastership.setAllowMotionControl',
        'systemMastership.disableExternalControl',
      ],
      rmmp: ['usersUas.requestRmmp', 'usersUas.cancelRmmp'],
      user: ['usersUas.registerUser', 'usersUas.impersonateUser'],
    });
  });

  it('the UAS account writes are not access rows: they change the controller\'s user data', () => {
    expect(ALL_TABLES.usersUas.changePassword.access).toBeUndefined();
    expect(ALL_TABLES.usersUas.uploadUasConfiguration.access).toBeUndefined();
  });
});

describe('operation keys', () => {
  it('every id is unique across the whole surface, so `<domain>.<id>` and the id alone each name one row', () => {
    const all = rows();
    expect(new Set(all.map(r => r.id)).size).toBe(all.length);
    expect(new Set(all.map(r => r.key)).size).toBe(all.length);
    expect(all.length).toBe(317);
  });

  it('the controller restart is one row, panel.restartController, with both generations', () => {
    expect(ALL_TABLES.ctrl.restartController).toBeUndefined();
    const op = ALL_TABLES.panel.restartController;
    expect(op.rws2).toMatchObject({ method: 'POST', path: '/ctrl/restart' });
    expect(op.rws1).toMatchObject({ method: 'POST', path: '/rw/panel', action: 'restart' });
    expect(op.effect).toBe('write');
  });
});
