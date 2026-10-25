import { describe, it, expect } from 'vitest';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';

/**
 * RWS 1.0 DIPC (RobotWare 6).
 *
 * Live-verified 2026-09-30 on RW 6.16.03: `POST /rw/dipc?action=dipc-create`
 * with `dipc-queue-name`, `dipc-queue-size` and `dipc-max-msg-size` answers
 * 201; the `?action=create` the adapter used to send answers 400
 * -1073445879 "Invalid action"; `DELETE /rw/dipc/{queue}` answers 204. The
 * send form is the one RW 6.16.03 serves for a queue (`?action=show`, read
 * 2026-09-29): `?action=dipc-send` with `dipc-src-queue-name`, `dipc-cmd`,
 * `dipc-userdef`, `dipc-msgtype`, `dipc-data`. The listing body is the one
 * RW 6.16.03 answered (`GET /rw/dipc?json=1`, 2026-09-29).
 */

interface Call { what: string; body?: string }

function makeFake(respond?: (method: string, url: string) => { status: number; body: string } | undefined): { calls: Call[]; client: RwsClient } {
  const calls: Call[] = [];
  const fake = {
    requestMastership: async (d: string) => { calls.push({ what: `mastership-request ${d}` }); },
    releaseMastership: async (d: string) => { calls.push({ what: `mastership-release ${d}` }); },
    request: async (method: string, url: string, body?: string) => {
      calls.push({ what: `${method} ${url}`, body });
      return respond?.(method, url) ?? { status: 204, body: '' };
    },
  };
  return { calls, client: fake as unknown as RwsClient };
}

const LISTING_RW6 = '{ "_links" : { "base" : { "href" : "http://127.0.0.1:4578/rw/" },"self" : {"href":"dipc&json=1"}},"_embedded" : { "_state" : [ '
  + '{ "_type" : "dipc-info-li", "_title" : "info", "max-body-size" : "444", "max-pkg-size" : "5000" }, '
  + '{ "_type" : "dipc-queue-li", "_title" : "PyInternalslot0","_links" : { "self" : { "href" : "dipc/PyInternalslot0?json=1" } } } , '
  + '{ "_type" : "dipc-queue-li", "_title" : "PyExternalslot1","_links" : { "self" : { "href" : "dipc/PyExternalslot1?json=1" } } } , '
  + '{ "_type" : "dipc-queue-li", "_title" : "RimDispatcher","_links" : { "self" : { "href" : "dipc/RimDispatcher?json=1" } } }]}}';

/** RW 6.16.03, 2026-09-30: the answer to the old `?action=create`, as recorded. */
const INVALID_ACTION = String.raw`{"_links":{"base": { "href": "http://127.0.0.1:56791/" }},"_embedded" :{ "status" : {"code":-1073445879, "msg": "C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rws_dipc\\rws_resource_dipc.cpp[219] Invalid action code:-1073445879 icode:-1"}, "_state":[  ] }}`;

describe('RWS1Adapter DIPC', () => {
  it('createDipcQueue POSTs ?action=dipc-create with dipc-queue-name, dipc-queue-size and dipc-max-msg-size', async () => {
    const { calls, client } = makeFake((m, url) => m === 'POST' && url.startsWith('/rw/dipc?') ? { status: 201, body: '' } : undefined);
    await new RWS1Adapter(client).createDipcQueue('ZZ_PROBE_Q', { maxmessages: 10, maxsize: 400 });
    expect(calls).toEqual([{ what: 'POST /rw/dipc?action=dipc-create&json=1', body: 'dipc-queue-name=ZZ_PROBE_Q&dipc-queue-size=10&dipc-max-msg-size=400' }]);
    // The fields the adapter used to send are not ABB's and not the controller's.
    expect(calls[0].body).not.toMatch(/dipc-max-size|dipc-max-number-of-messages/);
  });

  it('createDipcQueue sends only the name when no size is given (as on RWS 2.0), and encodes it', async () => {
    const { calls, client } = makeFake(() => ({ status: 201, body: '' }));
    await new RWS1Adapter(client).createDipcQueue('ZZ PROBE&Q');
    expect(calls[0].body).toBe('dipc-queue-name=ZZ%20PROBE%26Q');
  });

  it('a refused create throws the controller\'s typed error (the recorded 400 -1073445879 is INVALID_ARGUMENT)', async () => {
    const { client } = makeFake(() => ({ status: 400, body: INVALID_ACTION }));
    const err = await new RWS1Adapter(client).createDipcQueue('ZZ_PROBE_Q', { maxmessages: 10, maxsize: 400 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({
      code: 'INVALID_ARGUMENT', httpStatus: 400, controllerCode: -1073445879, controllerMsg: 'Invalid action code:-1073445879 icode:-1',
    });
  });

  it('sendDipcMessage POSTs ?action=dipc-send with the queue form\'s fields, dipc-userdef included', async () => {
    const { calls, client } = makeFake();
    await new RWS1Adapter(client).sendDipcMessage('ZZ_PROBE_Q', 'hello world', 'string');
    expect(calls).toEqual([{
      what: 'POST /rw/dipc/ZZ_PROBE_Q?action=dipc-send&json=1',
      body: 'dipc-src-queue-name=ZZ_PROBE_Q&dipc-cmd=111&dipc-userdef=0&dipc-msgtype=0&dipc-data=hello%20world',
    }]);
  });

  it('readDipcMessage GETs ABB\'s ?action=dipc-read, with the timeout when one is given', async () => {
    const answer = JSON.stringify({ _embedded: { _state: [{ _type: 'dipc-read-li', 'dipc-data': '"hello"', 'dipc-msgtype': '0' }] } });
    const { calls, client } = makeFake((m, url) => m === 'GET' && url.includes('dipc-read') ? { status: 200, body: answer } : undefined);
    const a = new RWS1Adapter(client);
    expect(await a.readDipcMessage('ZZ_PROBE_Q', 0)).toEqual({ payload: '"hello"', type: '0' });
    expect(await a.readDipcMessage('ZZ_PROBE_Q')).toEqual({ payload: '"hello"', type: '0' });
    expect(calls.map(c => c.what)).toEqual([
      'GET /rw/dipc/ZZ_PROBE_Q?action=dipc-read&timeout=0&json=1',
      'GET /rw/dipc/ZZ_PROBE_Q?action=dipc-read&json=1',
    ]);
  });

  it('readDipcMessage answers null for an empty queue and for a read error', async () => {
    expect(await new RWS1Adapter(makeFake(() => ({ status: 204, body: '' })).client).readDipcMessage('Q')).toBeNull();
    expect(await new RWS1Adapter(makeFake(() => ({ status: 400, body: INVALID_ACTION })).client).readDipcMessage('Q')).toBeNull();
  });

  it('listDipcQueues lists the queues RW 6.16.03 answers, without its info entry', async () => {
    const { client } = makeFake((m, url) => url === '/rw/dipc?json=1' ? { status: 200, body: LISTING_RW6 } : undefined);
    expect((await new RWS1Adapter(client).listDipcQueues()).map(q => q.name)).toEqual(['PyInternalslot0', 'PyExternalslot1', 'RimDispatcher']);
  });

  it('removeDipcQueue DELETEs the queue (204) and throws a refusal instead of ignoring it', async () => {
    const ok = makeFake();
    await new RWS1Adapter(ok.client).removeDipcQueue('ZZ_PROBE_Q');
    expect(ok.calls.map(c => c.what)).toEqual(['DELETE /rw/dipc/ZZ_PROBE_Q?json=1']);

    const refused = makeFake(() => ({ status: 400, body: INVALID_ACTION }));
    const err = await new RWS1Adapter(refused.client).removeDipcQueue('ZZ_PROBE_Q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ httpStatus: 400, controllerCode: -1073445879 });
    expect((err as RwsError).message).toContain('HTTP 400 from DELETE /rw/dipc/ZZ_PROBE_Q');
  });
});
