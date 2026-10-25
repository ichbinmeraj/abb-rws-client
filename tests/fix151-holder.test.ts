import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  explainRefusal, holderFromMastership, holderFromWriteAccess, isPendantApplication, markPendant, refusalFor,
  type ControllerAnswer,
} from '../src/refusal.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError, type RefusalHolder } from '../src/types.js';

// The FlexPendant as a holder is named one way per generation: RobotWare 7
// reports the pendant's edit mastership as `local` with application `TPU`
// (RW 7.21.4), RobotWare 8 its write access as held by the station
// `FlexPendant` (RW 8.2.1), both seen with the virtual FlexPendant on
// 2026-10-18. `RefusalHolder.isPendant` says it for both; every other field
// stays as the controller gave it.

describe('RefusalHolder.isPendant', () => {
  it('RobotWare 7: a mastership holder with application TPU is the pendant', () => {
    expect(holderFromMastership({ mastership: 'local', application: 'TPU' }))
      .toEqual({ kind: 'local', application: 'TPU', isPendant: true });
    expect(holderFromMastership({ mastership: 'local', uid: '5', application: ' tpu ' }))
      .toEqual({ kind: 'local', id: '5', application: ' tpu ', isPendant: true });
    // Only a local holder: a remote one with application TPU has not been
    // seen, and RAPID Live, the daemon and the panel do not count it either.
    expect(holderFromMastership({ mastership: 'remote', application: 'TPU' })).toEqual({ kind: 'remote', application: 'TPU' });
    expect(holderFromMastership({ mastership: 'internal', application: 'TPU' })?.isPendant).toBeUndefined();
  });

  it('RobotWare 8: the write-access station FlexPendant is the pendant', () => {
    expect(holderFromWriteAccess({ held: true, heldByMe: false, heldByName: 'FlexPendant' }))
      .toEqual({ kind: 'unknown', name: 'FlexPendant', isPendant: true });
    expect(holderFromWriteAccess({ held: true, heldByMe: false, heldByName: 'flexpendant ' })?.isPendant).toBe(true);
    // A station named TPU has not been seen: not marked.
    expect(holderFromWriteAccess({ held: true, heldByMe: false, heldByName: 'TPU' })).toEqual({ kind: 'unknown', name: 'TPU' });
  });

  it('any other holder carries no isPendant, and its fields are unchanged', () => {
    expect(holderFromMastership({ mastership: 'remote', uid: '17', application: 'RobotStudio' }))
      .toEqual({ kind: 'remote', id: '17', application: 'RobotStudio' });
    expect(holderFromMastership({ mastership: 'internal' })).toEqual({ kind: 'internal' });
    // A RobotWare 6 pendant holder has not been observed: `local` without the
    // TPU application keeps its kind and is not marked.
    expect(holderFromMastership({ mastership: 'local' })).toEqual({ kind: 'local' });
    expect(holderFromWriteAccess({ held: true, heldByMe: false, heldByName: 'Line PLC' })).toEqual({ kind: 'unknown', name: 'Line PLC' });
    expect(holderFromWriteAccess({ held: true, heldByMe: true, heldByName: 'FlexPendant' })).toEqual({ kind: 'self' });
    expect(holderFromWriteAccess({ held: false, heldByMe: false, heldByName: 'FlexPendant' })).toBeNull();
    // A name that only contains the word is not the pendant.
    expect(holderFromWriteAccess({ held: true, heldByMe: false, heldByName: 'FlexPendant 2' })?.isPendant).toBeUndefined();
    expect(isPendantApplication('TPU-Tool')).toBe(false);
  });

  it('markPendant leaves its argument alone and returns none as none', () => {
    const given: RefusalHolder = { kind: 'unknown', name: 'FlexPendant' };
    const marked = markPendant(given);
    expect(marked).toEqual({ kind: 'unknown', name: 'FlexPendant', isPendant: true });
    expect(given).toEqual({ kind: 'unknown', name: 'FlexPendant' });
    expect(markPendant(null)).toBeNull();
    expect(markPendant(undefined)).toBeUndefined();
  });

  it('a refusal names a pendant holder with isPendant, whichever way the holder came in', () => {
    const wa: ControllerAnswer = {
      http: 403, code: -1073435870, msg: 'Remote Control Station cannot take SPoC when it is taken. code:-1073435870 icode:-20109',
      method: 'POST', path: '/rw/controlstation/writeaccess/request',
    };
    const rw8 = refusalFor(wa, { generation: 'rw8', holder: { kind: 'unknown', name: 'FlexPendant' } });
    expect(rw8?.refusal.holder).toEqual({ kind: 'unknown', name: 'FlexPendant', isPendant: true });

    const ms: ControllerAnswer = {
      http: 403, code: -1073445862, msg: 'Resource held code:-1073445862 icode:-1', method: 'POST', path: '/rw/mastership/edit/request',
    };
    const plain = refusalFor(ms, { generation: 'rw7', opmode: 'AUTO' })!;
    const err = new RwsError(plain.message, plain.code, 403, undefined, ms.code ?? undefined, ms.msg ?? undefined, plain.refusal);
    const named = explainRefusal(err, { holder: { kind: 'local', application: 'TPU' } });
    expect(named.refusal?.holder).toEqual({ kind: 'local', application: 'TPU', isPendant: true });
    expect(named.refusal?.remedy?.kind).toBe('release-pendant-mastership');
  });

  it('RwsClient2 on RobotWare 8: a write-access request refused while the FlexPendant holds it names the pendant', async () => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
      if (url === '/rw/controlstation/writeaccess/request') {
        res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073435870,"msg":"rws_resource_controlstation.cpp[1] Remote Control Station cannot take SPoC when it is taken. code:-1073435870 icode:-20109"}}');
        return;
      }
      if (req.method === 'GET' && url.startsWith('/rw/controlstation/writeaccess')) {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(JSON.stringify({ _links: {}, state: [{
          _type: 'controlstation-write-access-status', _title: 'write-access-status',
          'held-by-control-station-Id': '{AAAAAAAA-0000-4000-8000-000000000001}',
          'held-by-control-station-name': 'FlexPendant',
          'control-station-write-access-held': 'true',
          'control-station-external-control-enabled': 'false',
        }] }));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/rw/system')) {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end(JSON.stringify({ _links: {}, state: [{ _type: 'sys-system', _title: 'system', rwversion: '8.2.1+1023' }] }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{},"state":[]}');
        return;
      }
      res.writeHead(204); res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'u', 'p');
      await client.connect();
      const err = await client.requestMastership('rapid').then(() => null, (e: unknown) => e as RwsError);
      expect(err).toBeInstanceOf(RwsError);
      expect(err!.controllerCode).toBe(-1073435870);
      expect(err!.refusal?.holder).toEqual({ kind: 'unknown', name: 'FlexPendant', isPendant: true });
      // The station id is compared, never shown.
      expect(JSON.stringify(err!.refusal)).not.toContain('AAAAAAAA');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});
