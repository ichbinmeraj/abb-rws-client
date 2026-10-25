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

// A signal name is written into the body verbatim (semicolons must stay
// literal, so nothing is percent-encoded): a '&' or '=' would add form fields.
// Both generations refuse the same names, since IRWSAdapter.subscribe forwards
// a caller's names to either one.
const BAD_SIGNAL_NAMES = [
  'di_1&resources=2&2=/rw/panel/ctrlstate', 'di=1', 'di?x=1', 'di#frag', '../../x', 'Local/../di_1',
  'di;lvalue', 'di%2e', 'di 1', 'DRV_1/di_1', 'a/b/c/d', '', 'dí_1',
];

describe('subscription body: signal names', () => {
  it.each(BAD_SIGNAL_NAMES)('both generations refuse %j with INVALID_ARGUMENT', name => {
    const signal: SubscriptionResource = { type: 'signal', name };
    expect(() => rws1Body([signal])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => Rws2Core.buildSubscriptionBody([signal])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('RWS 1.0 keeps the body for a flat name and the network/device/signal form', () => {
    expect(rws1Body([{ type: 'signal', name: 'di_1' }, { type: 'signal', name: 'Local/DRV_1/DO10_1' }])).toBe(
      'resources=1&1=/rw/iosystem/signals/di_1;state&1-p=1'
      + '&resources=2&2=/rw/iosystem/signals/Local/DRV_1/DO10_1;state&2-p=1');
  });
});
