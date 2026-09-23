import { describe, it, expect } from 'vitest';
import { buildSubscriptionBody as rws1Body } from '../src/WsSubscriber.js';
import { Rws2Core } from '../src/rws2/core.js';
import type { SubscriptionResource } from '../src/types.js';

// The six resources RobotManager subscribes to.
const SIX: SubscriptionResource[] = ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', { type: 'elog', domain: 0 }];

/** Resource indices announced by `resources=<i>`, in order. */
const announced = (body: string) => [...body.matchAll(/(?:^|&)resources=(\d+)/g)].map(m => Number(m[1]));

describe('subscription body', () => {
  // Live 2026-09-24, RW 7.21 and 8.1.1: `resources=6` once bound only resource 6;
  // repeating `resources=<i>` per resource bound all six.
  it('RWS 2.0 announces every resource index, not a count', () => {
    const body = Rws2Core.buildSubscriptionBody(SIX)!;
    expect(announced(body)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(body.startsWith('resources=1&1=/rw/panel/ctrl-state;ctrlstate&1-p=1&resources=2&')).toBe(true);
    expect(body).toContain('resources=6&6=/rw/elog/0&6-p=1');
  });

  it('RWS 1.0 announces every resource index, not a count', () => {
    const body = rws1Body(SIX);
    expect(announced(body)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(body).toContain('resources=6&6=/rw/elog/0&6-p=1');
  });

  it('a single resource is unchanged', () => {
    expect(Rws2Core.buildSubscriptionBody(['speedratio'])).toBe('resources=1&1=/rw/panel/speedratio;speedratio&1-p=1');
  });

  it('keeps semicolons literal', () => {
    expect(Rws2Core.buildSubscriptionBody(['controllerstate'])).toContain(';ctrlstate');
    expect(rws1Body(['controllerstate'])).not.toContain('%3B');
  });
});
