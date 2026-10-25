import { describe, it, expect } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import { RwsError } from '../src/types.js';
import { ALL_TABLES, evidenceOf } from '../src/paths/index.js';

/**
 * The RWS 1.0 side of unsubscribeResource, ABB's "Unsubscribe or remove the
 * resource from subscription group" (RWS 1.0 Rev M): `DELETE
 * /subscription/{group-id}/{resource-uri}`, answered 200, sample call
 * `DELETE /subscription/1/rw/iosystem/signals/Virtual1/Board1/di1;state`
 * (the page's URL line spells `/subscripion`; its sample call, and every
 * subscription path RW 6.16.03 serves, `/subscription`).
 */

interface Call { method: string; url: string }

function fake(status = 200): { calls: Call[]; client: RwsClient } {
  const calls: Call[] = [];
  const client = {
    requestMastership: async () => {},
    releaseMastership: async () => {},
    request: async (method: string, url: string) => {
      calls.push({ method, url });
      return status >= 400
        ? { status, body: JSON.stringify({ _embedded: { status: { code: -1073445879, msg: 'Invalid resource' } } }) }
        : { status, body: '' };
    },
  };
  return { calls, client: client as unknown as RwsClient };
}

describe('unsubscribeResource on RWS 1.0', () => {
  it('the path row: the same DELETE as RWS 2.0, live on both (RW 6.16.03, 2026-10-21)', () => {
    const op = ALL_TABLES.filesVision.unsubscribeResource;
    expect(op.rws1).toEqual({ method: 'DELETE', path: '/subscription/{group}{resource}' });
    expect(op.rws2).toEqual({ method: 'DELETE', path: '/subscription/{group}{resource}' });
    expect([evidenceOf(op, 'rws1'), evidenceOf(op, 'rws2')]).toEqual(['live', 'live']);
  });

  it('sends ABB\'s sample request: the group, then the resource as subscribed', async () => {
    const { calls, client } = fake();
    await new RWS1Adapter(client).unsubscribeResource('/subscription/1', { type: 'signal', name: 'Virtual1/Board1/di1' });
    expect(calls).toEqual([{ method: 'DELETE', url: '/subscription/1/rw/iosystem/signals/Virtual1/Board1/di1;state' }]);
  });

  it('keeps the RWS 1.0 spelling and suffix of each kind', async () => {
    const { calls, client } = fake();
    const a = new RWS1Adapter(client);
    await a.unsubscribeResource('/subscription/7', 'speedratio');
    await a.unsubscribeResource('/subscription/7', 'controllerstate');
    await a.unsubscribeResource('/subscription/7', { type: 'persvar', name: 'T_ROB1/user/reg1' });
    await a.unsubscribeResource('/subscription/7', { type: 'mastership', domain: 'rapid' });
    await a.unsubscribeResource('/subscription/7', { type: 'motionerrorstate' });
    expect(calls.map(c => c.url)).toEqual([
      '/subscription/7/rw/panel/speedratio;speedratio',
      '/subscription/7/rw/panel/ctrlstate;ctrlstate',
      '/subscription/7/rw/rapid/symbol/data/RAPID/T_ROB1/user/reg1;value',
      '/subscription/7/rw/mastership/rapid',
      '/subscription/7/rw/motionsystem/errorstate;erroreventchange',
    ]);
  });

  it('mastership of every domain drops each domain\'s resource, one DELETE each', async () => {
    const { calls, client } = fake();
    await new RWS1Adapter(client).unsubscribeResource('/subscription/7', { type: 'mastership' });
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'DELETE /subscription/7/rw/mastership/cfg',
      'DELETE /subscription/7/rw/mastership/motion',
      'DELETE /subscription/7/rw/mastership/rapid',
    ]);
  });

  it('a DELETE refused after one that went through says which were dropped', async () => {
    const calls: string[] = [];
    const client = {
      requestMastership: async () => {},
      releaseMastership: async () => {},
      request: async (_method: string, url: string) => {
        calls.push(url);
        return url.endsWith('/motion')
          ? { status: 400, body: JSON.stringify({ _embedded: { status: { code: -1073445879, msg: 'Invalid resource' } } }) }
          : { status: 200, body: '' };
      },
    } as unknown as RwsClient;
    const err = await new RWS1Adapter(client).unsubscribeResource('/subscription/7', { type: 'mastership' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 400 });
    expect((err as Error).message).toMatch(/^unsubscribeResource: \/rw\/mastership\/cfg dropped from \/subscription\/7, then \/rw\/mastership\/motion failed\./);
    // The walk stops at the refusal.
    expect(calls).toEqual(['/subscription/7/rw/mastership/cfg', '/subscription/7/rw/mastership/motion']);
  });

  it('refuses before sending: a group path that is not /subscription/{id}, a bad signal name, a path leaving the group', async () => {
    const { calls, client } = fake();
    const a = new RWS1Adapter(client);
    for (const group of ['ws://127.0.0.1/poll/7', '/subscription/', '/subscription/7/x', 'subscription/7']) {
      await expect(a.unsubscribeResource(group, 'speedratio')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    await expect(a.unsubscribeResource('/subscription/7', { type: 'signal', name: 'di&1=x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    for (const name of ['T_ROB1/../../../../subscription/3', 'T_ROB1/M/x?y', 'T_ROB1/M/x#y']) {
      await expect(a.unsubscribeResource('/subscription/7', { type: 'persvar', name })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toEqual([]);
  });

  it('a refusal is the controller\'s typed error', async () => {
    const { client } = fake(400);
    const err = await new RWS1Adapter(client).unsubscribeResource('/subscription/7', 'speedratio').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ httpStatus: 400 });
  });

  it('RobotManager.unsubscribeResource reaches it on RWS 1.0 (it was UNSUPPORTED_OPERATION there)', async () => {
    const { calls, client } = fake();
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: IRWSAdapter }).adapter = new RWS1Adapter(client);
    await mgr.unsubscribeResource('/subscription/3', { type: 'motionerrorstate' });
    expect(calls).toEqual([{ method: 'DELETE', url: '/subscription/3/rw/motionsystem/errorstate;erroreventchange' }]);
  });
});
