import { describe, it, expect, expectTypeOf } from 'vitest';
import { WsSubscriber, buildSubscriptionBody, parseWsMessage } from '../src/WsSubscriber.js';
import { Rws2Core } from '../src/rws2/core.js';
import { subscriptionFrameEntries, MOTION_ERROR_STATE_RESOURCE } from '../src/subscriptionKinds.js';
import type { HttpSession } from '../src/HttpSession.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import type { AnySubscriptionResource, SubscriptionEvent, SubscriptionResource } from '../src/types.js';

/**
 * The two subscription kinds added in 1.5.0, as ABB documents them:
 *
 * - mastership: RWS 1.0 Rev M "Mastership Domain Subscribe"
 *   (`/rw/mastership/{domain}`, cfg, motion or rapid); RWS 2.0 Rev L
 *   Mastership service and Subscription service (`/rw/mastership/{domain-name}`,
 *   edit or motion). Every domain is sent as each domain's resource: Rev M's
 *   `/rw/mastership` was refused by RW 6.16.03 (400 -1073445866), and on
 *   RWS 2.0, where Rev L lists no such form, RW 7.21.4 bound it in a PUT it
 *   never answered and the group then refused every edit (2026-10-21). The
 *   event entry is `msh-resource-value`, titled with the domain and, in ABB's
 *   examples on both generations and on RW 6.16.03 and 7.21.4, without a link;
 * - the motion system's error state: `/rw/motionsystem/errorstate;erroreventchange`
 *   on both (Rev M "Subscribe on Error EventChange", Rev L Motion System),
 *   event entry `motionsystem-errorstate-ev`. A raw create of it answered 201
 *   on RW 6.16.03 (2026-09-29) and on a RobotWare 8 virtual controller
 *   (2026-09-27).
 *
 * The client sends priority 1; ABB allows 0 and 1 on these resources.
 */

// ABB's examples (RWS 1.0 Rev M).
const MSH_ALL_REV_M = '<?xml version="1.0" encoding="utf-8"?> <html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Subscription Event</title> </head> <body> <div class="state"> '
  + '<a href="http://localhost/subscription/1" name="poll"></a> <a href="http://localhost/subscription/1?action=show" rel="action"></a> <a href="http://localhost/subscription/1" rel="group"></a> <ul class="list"> '
  + '<li class="msh-resource-value" title="cfg"> <span class="holdmastership">true</span> <span class="uid">65</span> <span class="location">remote</span> <span class="alias"></span> <span class="application">RobotStudio</span> </li> '
  + '<li class="msh-resource-value" title="rapid"> <span class="holdmastership">true</span> <span class="uid">65</span> <span class="location">remote</span> <span class="alias"></span> <span class="application">RobotStudio</span> </li> </ul> </div> </body> </html>';
const ERRORSTATE_REV_M = '<?xml version="1.0" encoding="utf-8"?> <html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Event</title> <base href="http://localhost/"/> </head> <body> <div class="state"> '
  + '<a href="subscription/4" rel="group"/> <a href="ws://localhost/poll/4" rel="self"/> <a href="subscription/4?action=show" rel="action"/> <ul> '
  + '<li class="motionsystem-errorstate-ev" title="error-state"> <a href="/rw/motionsystem/errorstate;erroreventchange" rel="self"/> <span class="errorstate">HPJ_ERR_ROBHOLD_MISMATCH</span> <span class="errorcounter">1</span> </li> </ul> </div> </body> </html>';
// ABB's example (RWS 2.0 Rev L, Mastership Domain subscription).
const MSH_EDIT_REV_L = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://localhost/" /></head><body><div class="state">'
  + '<a href="subscription/7" rel="group"></a><a href="ws://localhost/poll/7" rel="self"></a><ul>'
  + '<li class="msh-resource-value" title="edit"><span class="holdmastership">TRUE</span><span class="uid">19</span><span class="location"></span><span class="alias"></span><span class="application">RobAPI2-Client</span><span class="mastership">remote</span></li></ul></div></body></html>';

describe('the request bodies', () => {
  it('RWS 1.0: ABB\'s resources, unencoded; every domain is each domain\'s resource', () => {
    expect(buildSubscriptionBody([{ type: 'mastership' }]))
      .toBe('resources=1&1=/rw/mastership/cfg&1-p=1&resources=2&2=/rw/mastership/motion&2-p=1&resources=3&3=/rw/mastership/rapid&3-p=1');
    expect(buildSubscriptionBody([{ type: 'mastership', domain: 'cfg' }])).toBe('resources=1&1=/rw/mastership/cfg&1-p=1');
    expect(buildSubscriptionBody([{ type: 'mastership', domain: 'rapid' }])).toBe('resources=1&1=/rw/mastership/rapid&1-p=1');
    // The body RW 6.16.03 answered 201 (2026-09-29).
    expect(buildSubscriptionBody([{ type: 'motionerrorstate' }])).toBe('resources=1&1=/rw/motionsystem/errorstate;erroreventchange&1-p=1');
    expect(MOTION_ERROR_STATE_RESOURCE).toBe('/rw/motionsystem/errorstate;erroreventchange');
  });

  it('RWS 2.0: the domain under its RobotWare 7 name (rapid and cfg are edit)', () => {
    expect(Rws2Core.buildSubscriptionBody([{ type: 'mastership', domain: 'rapid' }])).toBe('resources=1&1=/rw/mastership/edit&1-p=1');
    expect(Rws2Core.buildSubscriptionBody([{ type: 'mastership', domain: 'cfg' }])).toBe('resources=1&1=/rw/mastership/edit&1-p=1');
    expect(Rws2Core.buildSubscriptionBody([{ type: 'mastership', domain: 'motion' }])).toBe('resources=1&1=/rw/mastership/motion&1-p=1');
    expect(Rws2Core.buildSubscriptionBody(['controllerstate', { type: 'motionerrorstate' }]))
      .toBe('resources=1&1=/rw/panel/ctrl-state;ctrlstate&1-p=1&resources=2&2=/rw/motionsystem/errorstate;erroreventchange&2-p=1');
  });

  it('RWS 2.0: every domain is edit and motion, never /rw/mastership (RW 7.21.4 left a PUT of it unanswered)', () => {
    expect(Rws2Core.buildSubscriptionBody([{ type: 'mastership' }]))
      .toBe('resources=1&1=/rw/mastership/edit&1-p=1&resources=2&2=/rw/mastership/motion&2-p=1');
  });

  it('a path two resources map to is sent once', () => {
    expect(Rws2Core.buildSubscriptionBody([{ type: 'mastership' }, { type: 'mastership', domain: 'rapid' }, { type: 'mastership', domain: 'cfg' }]))
      .toBe('resources=1&1=/rw/mastership/edit&1-p=1&resources=2&2=/rw/mastership/motion&2-p=1');
    expect(buildSubscriptionBody([{ type: 'mastership', domain: 'rapid' }, { type: 'mastership' }]))
      .toBe('resources=1&1=/rw/mastership/rapid&1-p=1&resources=2&2=/rw/mastership/cfg&2-p=1&resources=3&3=/rw/mastership/motion&3-p=1');
  });

  it('a domain other than cfg, motion or rapid is INVALID_ARGUMENT before anything is built', () => {
    const bad = { type: 'mastership', domain: 'edit&2=/rw/x' } as unknown as AnySubscriptionResource;
    expect(() => buildSubscriptionBody([bad])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => Rws2Core.buildSubscriptionBody([bad])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('the events', () => {
  it('ABB\'s mastership entries carry no link: each names /rw/mastership/{domain}', () => {
    expect(parseWsMessage(MSH_ALL_REV_M).map(e => [e.resource, e.value])).toEqual([
      ['/rw/mastership/cfg', 'true'],
      ['/rw/mastership/rapid', 'true'],
    ]);
    expect(subscriptionFrameEntries(MSH_EDIT_REV_L)).toEqual([{ resource: '/rw/mastership/edit', value: 'TRUE' }]);
  });

  it('the motion error state names its resource; the value is the error state', () => {
    expect(parseWsMessage(ERRORSTATE_REV_M).map(e => [e.resource, e.value])).toEqual([
      ['/rw/motionsystem/errorstate;erroreventchange', 'HPJ_ERR_ROBHOLD_MISMATCH'],
    ]);
  });

  it('other entries without a link are still left out', () => {
    expect(subscriptionFrameEntries('<ul><li class="pnl-ctrlstate-ev" title="x"><span class="ctrlstate">motoron</span></li></ul>')).toEqual([]);
  });
});

describe('RWS 1.0 subscriber, end to end', () => {
  it('posts the mastership resource and hands ABB\'s event to the handler', async () => {
    const bodies: string[] = [];
    const session = {
      post: async (_url: string, body: string) => {
        bodies.push(body);
        return { status: 201, body: '', headers: new Headers({ location: 'http://127.0.0.1:1/poll/9' }) };
      },
      delete: async () => ({ status: 200, body: '', headers: new Headers() }),
      getCookieHeader: () => 'ABBCX=a; -http-session-=b',
    } as unknown as HttpSession;
    let socket: { onmessage: ((e: { data: string }) => void) | null; close(): void } | null = null;
    class FakeWs {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((e: { wasClean?: boolean }) => void) | null = null;
      constructor() { socket = this; setTimeout(() => this.onopen?.(), 1); }
      close(): void { this.onclose?.({ wasClean: true }); }
    }
    const events: SubscriptionEvent[] = [];
    const sub = new WsSubscriber(session, '127.0.0.1', 1, FakeWs as unknown as ConstructorParameters<typeof WsSubscriber>[3]);
    const stop = await sub.subscribe([{ type: 'mastership' }, { type: 'motionerrorstate' }], e => events.push(e));
    expect(bodies).toEqual(['resources=1&1=/rw/mastership/cfg&1-p=1&resources=2&2=/rw/mastership/motion&2-p=1&resources=3&3=/rw/mastership/rapid&3-p=1'
      + '&resources=4&4=/rw/motionsystem/errorstate;erroreventchange&4-p=1']);
    socket!.onmessage?.({ data: MSH_ALL_REV_M });
    expect(events.map(e => [e.resource, e.value])).toEqual([['/rw/mastership/cfg', 'true'], ['/rw/mastership/rapid', 'true']]);
    await stop();
  });
});

describe('RWS 1.0: one WebSocket per session', () => {
  function rig(): { sub: WsSubscriber; failNext: () => void; deletes: string[] } {
    let id = 8;
    const deletes: string[] = [];
    const session = {
      post: async () => { id += 1; return { status: 201, body: '', headers: new Headers({ location: `http://127.0.0.1:1/poll/${id}` }) }; },
      delete: async (url: string) => { deletes.push(url); return { status: 200, body: '', headers: new Headers() }; },
      getCookieHeader: () => 'ABBCX=a; -http-session-=b',
    } as unknown as HttpSession;
    let fail = false;
    class FakeWs {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((e: { wasClean?: boolean }) => void) | null = null;
      constructor() {
        const failing = fail;
        fail = false;
        setTimeout(() => (failing ? this.onclose?.({ wasClean: false }) : this.onopen?.()), 1);
      }
      close(): void { this.onclose?.({ wasClean: true }); }
    }
    return { sub: new WsSubscriber(session, '127.0.0.1', 1, FakeWs as unknown as ConstructorParameters<typeof WsSubscriber>[3]), failNext: () => { fail = true; }, deletes };
  }

  it('a second WebSocket that fails before opening names the open one and the way to add to it', async () => {
    const { sub, failNext, deletes } = rig();
    const first = await sub.subscribe(['operationmode'], () => {});
    failNext();
    const err = await sub.subscribe([{ type: 'mastership', domain: 'rapid' }], () => {}).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(err.message).toBe('WebSocket for subscription 10 failed before opening. This session already has the WebSocket of subscription 9 open, '
      + "and ABB's RWS 1.0 allows one WebSocket per session: add the resources to that group (updateSubscriptionGroup on /subscription/9), "
      + 'or subscribe from a session of its own.');
    // The refused group is deleted, as before.
    expect(deletes).toHaveLength(1);
    await first();
  });

  it('a WebSocket that fails with no other open keeps its message', async () => {
    const { sub, failNext } = rig();
    failNext();
    const err = await sub.subscribe(['operationmode'], () => {}).catch((e: unknown) => e as Error);
    expect(err.message).toBe('WebSocket for subscription 9 failed before opening');
  });
});

describe('IRWSAdapter keeps its 1.4.0 subscription type', () => {
  it('an adapter of another make with an exhaustive switch over SubscriptionResource still compiles', () => {
    // The 1.5.0 kinds are in AnySubscriptionResource, not in SubscriptionResource.
    const path = (r: SubscriptionResource): string => {
      if (typeof r === 'string') { return r; }
      switch (r.type) {
        case 'signal': case 'persvar': return r.name;
        case 'taskchange': return r.task;
        case 'execycle': return 'cycle';
        case 'elog': return String(r.domain);
        default: { const never: never = r; return never; }
      }
    };
    expect(path({ type: 'elog', domain: 0 })).toBe('0');
    expectTypeOf<Parameters<IRWSAdapter['subscribe']>[0]>().toEqualTypeOf<SubscriptionResource[]>();
    expectTypeOf<SubscriptionResource>().toMatchTypeOf<AnySubscriptionResource>();
  });
});
