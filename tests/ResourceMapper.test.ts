import { describe, it, expect } from 'vitest';
import {
  controllerState,
  operationMode,
  rapidTasks,
  rapidExecutionState,
  startRapid,
  stopRapid,
  resetRapid,
  jointTarget,
  robTarget,
  loadModule,
  getModule,
  listModules,
  uploadFile,
  signal,
  setSignal,
  subscriptions,
} from '../src/ResourceMapper.js';

describe('ResourceMapper', () => {
  describe('controllerState', () => {
    it('returns the correct RWS 1.0 path', () => {
      expect(controllerState()).toBe('/rw/panel/ctrlstate');
    });
  });

  describe('operationMode', () => {
    it('returns the correct RWS 1.0 path', () => {
      expect(operationMode()).toBe('/rw/panel/opmode');
    });
  });

  describe('rapidTasks', () => {
    it('returns the correct RWS 1.0 path', () => {
      expect(rapidTasks()).toBe('/rw/rapid/tasks');
    });
  });

  describe('rapidExecutionState', () => {
    it('returns the correct RWS 1.0 path', () => {
      expect(rapidExecutionState()).toBe('/rw/rapid/execution');
    });
  });

  describe('startRapid', () => {
    it('returns path with action=start query param', () => {
      expect(startRapid().path).toBe('/rw/rapid/execution?action=start');
    });

    it('body contains all required RWS form fields', () => {
      const { body } = startRapid();
      expect(body).toContain('regain=continue');
      expect(body).toContain('execmode=continue');
      expect(body).toContain('cycle=forever');
      expect(body).toContain('condition=none');
      expect(body).toContain('stopatbp=disabled');
      expect(body).toContain('alltaskbytsp=false');
    });
  });

  describe('stopRapid', () => {
    it('returns path with action=stop query param', () => {
      expect(stopRapid().path).toBe('/rw/rapid/execution?action=stop');
    });

    it('body contains stopmode field', () => {
      expect(stopRapid().body).toContain('stopmode=stop');
    });
  });

  describe('resetRapid', () => {
    it('returns path with action=resetpp query param', () => {
      expect(resetRapid().path).toBe('/rw/rapid/execution?action=resetpp');
    });

    it('body is empty string (Content-Type still sent by HttpSession)', () => {
      expect(resetRapid().body).toBe('');
    });
  });

  describe('jointTarget', () => {
    it('uses default mechunit ROB_1', () => {
      expect(jointTarget()).toBe('/rw/mechunit/ROB_1/joint-target');
    });

    it('accepts a custom mechunit', () => {
      expect(jointTarget('ROB_2')).toBe('/rw/mechunit/ROB_2/joint-target');
    });

    it('URL-encodes mechunit names with special characters', () => {
      expect(jointTarget('ROB 1')).toBe('/rw/mechunit/ROB%201/joint-target');
    });
  });

  describe('robTarget', () => {
    it('uses defaults (ROB_1, tool0, wobj0)', () => {
      expect(robTarget()).toBe('/rw/mechunit/ROB_1/robtarget?tool=tool0&wobj=wobj0');
    });

    it('accepts custom mechunit, tool, and wobj', () => {
      expect(robTarget('ROB_2', 'myTool', 'myWobj')).toBe(
        '/rw/mechunit/ROB_2/robtarget?tool=myTool&wobj=myWobj',
      );
    });

    it('URL-encodes tool and wobj names', () => {
      expect(robTarget('ROB_1', 'my tool', 'my wobj')).toBe(
        '/rw/mechunit/ROB_1/robtarget?tool=my%20tool&wobj=my%20wobj',
      );
    });
  });

  describe('loadModule', () => {
    it('returns path with task name and action=loadmod', () => {
      const { path } = loadModule('T_ROB1', '$HOME/MyMod.mod');
      expect(path).toBe('/rw/rapid/tasks/T_ROB1?action=loadmod');
    });

    it('body contains modulepath field with encoded path', () => {
      const { body } = loadModule('T_ROB1', '$HOME/MyMod.mod');
      expect(body).toContain('modulepath=');
      expect(body).toContain(encodeURIComponent('$HOME/MyMod.mod'));
    });

    it('body contains replace=false', () => {
      expect(loadModule('T_ROB1', '$HOME/mod.mod').body).toContain('replace=false');
    });

    it('URL-encodes the task name', () => {
      const { path } = loadModule('T ROB1', '$HOME/mod.mod');
      expect(path).toContain('T%20ROB1');
    });
  });

  describe('getModule', () => {
    it('returns correct path with task and module names', () => {
      expect(getModule('T_ROB1', 'MyModule')).toBe(
        '/rw/rapid/tasks/T_ROB1/modules/MyModule',
      );
    });

    it('URL-encodes both names', () => {
      expect(getModule('T ROB1', 'My Module')).toBe(
        '/rw/rapid/tasks/T%20ROB1/modules/My%20Module',
      );
    });
  });

  describe('listModules', () => {
    it('returns correct path', () => {
      expect(listModules('T_ROB1')).toBe('/rw/rapid/tasks/T_ROB1/modules');
    });
  });

  describe('uploadFile', () => {
    it('returns /fileservice/ path', () => {
      expect(uploadFile('$HOME/MyMod.mod')).toBe('/fileservice/$HOME/MyMod.mod');
    });

    it('strips a leading slash from the remote path', () => {
      expect(uploadFile('/$HOME/MyMod.mod')).toBe('/fileservice/$HOME/MyMod.mod');
    });

    it('does not double-encode the $ prefix used by IRC5', () => {
      const result = uploadFile('$HOME/file.mod');
      expect(result).toContain('$HOME');
      expect(result).not.toContain('%24');
    });
  });

  describe('signal', () => {
    it('returns path with network/device/name and ;state suffix', () => {
      expect(signal('Local', 'DRV_1', 'DI_1')).toBe(
        '/rw/iosystem/signals/Local/DRV_1/DI_1;state',
      );
    });

    it('URL-encodes each path segment', () => {
      expect(signal('My Net', 'My Dev', 'My Sig')).toBe(
        '/rw/iosystem/signals/My%20Net/My%20Dev/My%20Sig;state',
      );
    });
  });

  describe('setSignal', () => {
    it('returns path with ?action=set and no ;state suffix', () => {
      const { path } = setSignal('Local', 'DRV_1', 'DO_1');
      expect(path).toBe('/rw/iosystem/signals/Local/DRV_1/DO_1?action=set');
      expect(path).not.toContain(';state');
    });
  });

  describe('subscriptions', () => {
    it('returns /subscription', () => {
      expect(subscriptions()).toBe('/subscription');
    });
  });
});
