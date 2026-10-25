/**
 * Offline checks of the log reader behind scripts/evidence-index.mjs: each
 * line shape it accepts, and the generation it gives a request. The hand-probe
 * lines are shaped like the 2026-10-10 operation-mode lock runs on RW 8.2.1,
 * 7.21.4 and 8.1.1 virtual controllers. No socket.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs script without type declarations
import { requestsFromLog, requestsFromTextTrace } from '../scripts/evidence-logs.mjs';

const lines = (...xs: object[]): string => xs.map(x => JSON.stringify(x)).join('\n') + '\n';

describe('evidence log reader', () => {
  it('reads hand-probe req lines, taking the generation from the start label', () => {
    const text = lines(
      { port: 80, step: 'start', label: '8.2.1+1023 CRB1910FT_10_1520', opmode: 'AUTO' },
      { port: 80, req: 'GET lock-state', status: 200, lockstate: 'unlocked' },
      { port: 80, req: 'POST /rw/panel/opmode/lock', body: 'pin=1234&permanent=1', status: 204, text: '' },
      { port: 80, req: 'POST /rw/panel/opmode/unlock', body: 'pin=0000', status: 204, text: '' },
      { port: 80, step: 'end', label: '8.2.1+1023 CRB1910FT_10_1520' },
    );
    expect(requestsFromLog(text, 'probes/opmode-lock/80.jsonl', 'probe log')).toEqual([
      { gen: 'rws2', method: 'POST', url: '/rw/panel/opmode/lock', status: 204, body: 'pin=1234&permanent=1', source: 'probe log' },
      { gen: 'rws2', method: 'POST', url: '/rw/panel/opmode/unlock', status: 204, body: 'pin=0000', source: 'probe log' },
    ]);
  });

  it('gives RobotWare 6 labels RWS 1.0 and leaves an unlabelled req without a generation', () => {
    const rw6 = lines({ step: 'start', label: '6.16.03 IRB1600' }, { req: 'GET /rw/panel/opmode', status: 200 });
    expect(requestsFromLog(rw6, 'x/1.jsonl', 'probe log')[0].gen).toBe('rws1');
    const none = lines({ req: 'GET /rw/panel/opmode', status: 200 });
    expect(requestsFromLog(none, 'x/2.jsonl', 'probe log')[0].gen).toBeNull();
  });

  it('still reads trace, wire and one-request lines', () => {
    const text = lines(
      { cat: 'http.res', data: { protocol: 'rws2', method: 'GET', path: '/rw/panel/speedratio', status: 200 } },
      { gen: 'rws1', wire: [{ m: 'POST', p: '/rw/panel/speedratio?action=setspeedratio', status: 204, reqBody: 'speed-ratio=50' }] },
      { gen: 'rws2', method: 'GET', path: '/ctrl', status: 200 },
    );
    expect(requestsFromLog(text, 'x/3.jsonl', 'probe log').map((r: { gen: string; method: string; url: string; body: string | null }) =>
      [r.gen, r.method, r.url, r.body])).toEqual([
      ['rws2', 'GET', '/rw/panel/speedratio', null],
      ['rws1', 'POST', '/rw/panel/speedratio?action=setspeedratio', 'speed-ratio=50'],
      ['rws2', 'GET', '/ctrl', null],
    ]);
  });
});

describe('text trace reader', () => {
  const res = (proto: string, method: string, path: string, status: number): string =>
    `20:48:10.426 trace http.res ${proto.toUpperCase()} ${method} ${path} → ${status} `
    + JSON.stringify({ protocol: proto, method, path, status, durationMs: 20 });

  it('reads the http.res lines of a trace file and skips every other line', () => {
    const text = [
      '20:48:10.406 trace http.req RWS1 POST /users/rmmp?json=1 {"protocol":"rws1","method":"POST","path":"/users/rmmp?json=1","bodyPreview":"privilege=modify"}',
      res('rws1', 'POST', '/users/rmmp?json=1', 202),
      "20:48:11.455 trace rmmp RMMP poll answered 'PENDING' ",
      res('rws2', 'GET', '/rw/panel/opmode', 200),
      '20:48:12.000 trace http.res RWS1 GET /broken → 200 {not json',
    ].join('\n');
    expect(requestsFromTextTrace(text, 'probe log')).toEqual([
      { gen: 'rws1', method: 'POST', url: '/users/rmmp?json=1', status: 202, body: null, source: 'probe log' },
      { gen: 'rws2', method: 'GET', url: '/rw/panel/opmode', status: 200, body: null, source: 'probe log' },
    ]);
  });

  it('reads trace lines kept as JSON strings in a result file', () => {
    const file = JSON.stringify({ lane: 'rw6', trace: [res('rws1', 'GET', '/users/rmmp/poll?json=1', 200), 'other'] }, null, 1);
    expect(requestsFromTextTrace(file, 'probe log').map((r: { gen: string; method: string; url: string; status: number }) =>
      [r.gen, r.method, r.url, r.status])).toEqual([['rws1', 'GET', '/users/rmmp/poll?json=1', 200]]);
  });

  it('leaves a line without a known protocol out', () => {
    expect(requestsFromTextTrace(res('rws3', 'GET', '/ctrl', 200), 'probe log')).toEqual([]);
  });
});
