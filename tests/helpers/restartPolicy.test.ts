/**
 * Offline checks of the test suites' never-restart list
 * (tests/helpers/restartPolicy.ts): which lanes it names, how a controller's
 * lane is found, that the functional guard answers from it, and that the I/O
 * fixture script refuses every listed lane but the one it restarts attended.
 * The live suites and the warm-restart structural cell skip on the same
 * answers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  ATTENDED_RESTARTS, NEVER_RESTART, laneOf, restartRefusal, restartVerdict,
} from './restartPolicy.js';
import { allowed } from '../functional/helpers/guard.js';
// @ts-expect-error - plain .mjs script without type declarations
import { parseOptions } from '../../scripts/functional-fixtures.mjs';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe('never-restart list', () => {
  it('names rw6 and rw8, each with a reason, and not rw7', () => {
    expect(Object.keys(NEVER_RESTART).sort()).toEqual(['rw6', 'rw8']);
    expect(NEVER_RESTART.rw6).toMatch(/RW6 virtual controller/);
    expect(NEVER_RESTART.rw8).toMatch(/Remote Access/);
    expect(NEVER_RESTART.rw7).toBeUndefined();
  });

  it('refuses the listed lanes with their reason and an unknown lane, and allows rw7', () => {
    expect(restartRefusal('rw6')).toBe(NEVER_RESTART.rw6);
    expect(restartRefusal('rw8')).toBe(NEVER_RESTART.rw8);
    expect(restartRefusal('rw7')).toBeNull();
    expect(restartRefusal(null)).toMatch(/RobotWare major of this controller could not be read.*\(rw6, rw8\)/);
  });
});

describe('lane of a controller', () => {
  it('is rw6 for RWS 1.0 whatever the version says', () => {
    expect(laneOf('rws1')).toBe('rw6');
    expect(laneOf('rws1', '7.21.4')).toBe('rw6');
  });

  it('is the RobotWare major for RWS 2.0, and unknown without one', () => {
    expect(laneOf('rws2', '7.21.4+417')).toBe('rw7');
    expect(laneOf('rws2', '8.2.1')).toBe('rw8');
    expect(laneOf('rws2', ' 8.1.1+614')).toBe('rw8');
    expect(laneOf('rws2', '6.16.3007')).toBeNull();
    expect(laneOf('rws2', '')).toBeNull();
    expect(laneOf('rws2')).toBeNull();
  });

});

describe('restart verdict for a controller a suite found', () => {
  const answers = (version: string): { read: () => Promise<string>; reads: () => number } => {
    let n = 0;
    return { read: async () => { n++; return version; }, reads: () => n };
  };

  it('refuses RWS 1.0 as rw6 without reading anything', async () => {
    const v = answers('7.21.4');
    expect(await restartVerdict({ generation: 'rws1' }, v.read)).toEqual({ lane: 'rw6', refusal: NEVER_RESTART.rw6 });
    expect(v.reads()).toBe(0);
  });

  it('allows rw7 when the controller answers 7.x, with or without a version from discovery', async () => {
    const v = answers('7.21.4+417');
    expect(await restartVerdict({ generation: 'rws2', rwVersion: '7.21.4' }, v.read)).toEqual({ lane: 'rw7', refusal: null });
    expect(await restartVerdict({ generation: 'rws2' }, v.read)).toEqual({ lane: 'rw7', refusal: null });
    expect(v.reads()).toBe(2);
  });

  it('reads the controller even when discovery named a version, and refuses when it answers 8.x', async () => {
    // A stale discovery entry: the port that was RW7 is an RW8 VC now.
    const v = answers('8.2.1+1023');
    expect(await restartVerdict({ generation: 'rws2', rwVersion: '7.21.4' }, v.read))
      .toEqual({ lane: 'rw8', refusal: NEVER_RESTART.rw8 });
    expect(v.reads()).toBe(1);
  });

  it('refuses when discovery names a listed lane, whatever the controller answers', async () => {
    expect(await restartVerdict({ generation: 'rws2', rwVersion: '8.2.1' }, answers('7.21.4').read))
      .toEqual({ lane: 'rw8', refusal: NEVER_RESTART.rw8 });
  });

  it('refuses when the two versions name different majors off the list', async () => {
    const verdict = await restartVerdict({ generation: 'rws2', rwVersion: '9.0.0' }, answers('7.21.4').read);
    expect(verdict.lane).toBeNull();
    expect(verdict.refusal).toMatch(/discovery named RobotWare 9\.0\.0 .* answers 7\.21\.4, so its lane is not certain/);
  });

  it('refuses an unknown lane: a failed read, an empty or unknown answer, no reader', async () => {
    const failed = await restartVerdict({ generation: 'rws2', rwVersion: '7.21.4' }, async () => { throw new Error('503'); });
    expect(failed).toEqual({ lane: null, refusal: restartRefusal(null) });
    expect(await restartVerdict({ generation: 'rws2' }, answers('').read)).toEqual({ lane: null, refusal: restartRefusal(null) });
    expect(await restartVerdict({ generation: 'rws2' }, answers('6.16.3007').read)).toEqual({ lane: null, refusal: restartRefusal(null) });
    expect(await restartVerdict({ generation: 'rws2', rwVersion: '7.21.4' })).toEqual({ lane: null, refusal: restartRefusal(null) });
  });
});

describe('restarts outside the test suites', () => {
  it('names only lanes on the list', () => {
    for (const lane of Object.keys(ATTENDED_RESTARTS)) { expect(Object.keys(NEVER_RESTART)).toContain(lane); }
  });

  it('has the I/O fixture script refuse every listed lane but the attended ones', () => {
    for (const lane of Object.keys(NEVER_RESTART)) {
      let refused = false;
      try {
        parseOptions([], { RWS_FIXTURES_APPLY: '1', RWS_FIXTURES_LANES: lane });
      } catch {
        refused = true;
      }
      expect(refused, `functional-fixtures.mjs on ${lane}`).toBe(!(lane in ATTENDED_RESTARTS));
    }
  });
});

describe('functional guard', () => {
  it('refuses a restart on the listed lanes with the list\'s reason, whatever RWS_FUNCTIONAL_ALLOW_RESTART lists', () => {
    process.env.RWS_FUNCTIONAL_ALLOW_RESTART = 'rw6,rw7,rw8';
    expect(allowed('restart', 'rw6')).toEqual({ ok: false, reason: NEVER_RESTART.rw6 });
    expect(allowed('restart', 'rw8')).toEqual({ ok: false, reason: NEVER_RESTART.rw8 });
    expect(allowed('restart', 'rw7').ok).toBe(true);
  });
});
