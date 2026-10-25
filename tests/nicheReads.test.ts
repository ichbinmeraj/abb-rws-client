import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RobotManager } from '../src/RobotManager.js';
import { ALL_TABLES, buildPath } from '../src/paths/index.js';
import type { PathSpec } from '../src/paths/index.js';
import {
  leadThroughFrom, motionSupervisionFrom, motorCalibFrom, parseBody, pathSupervisionFrom, subscriptionGroupId,
  subscriptionGroupsFrom,
} from '../src/commonReads.js';
import { RwsError } from '../src/types.js';

/**
 * Niche reads both generations serve: the session's subscription groups and
 * one group's members, motion and path supervision, and a mechanical unit's
 * SMB data, motor calibration names and lead-through state.
 *
 * Shapes, and where they come from:
 * - the subscription list and group bodies are the XHTML RW 6.16.03, 7.21.4
 *   and 8.2.1 answered on 2026-09-29 (all three answer XHTML whatever was
 *   asked), and the 400 a foreign group answers on all three;
 * - motion supervision is the RW 6.16.03 `?mechunit=ROB_1&json=1` answer, its
 *   XHTML answer (values in double quotes) and its 400 without the query
 *   (2026-09-29), and the RW 8.1.1 hal+json answer
 *   (2026-09-27); path supervision is the RW 8.1.1 hal+json answer
 *   (2026-09-27);
 * - the RW 6.16.03 mechunit body (2026-09-29) carries the lead-through LINK
 *   under the status class, without a status;
 * - SMB data, motor calibration names and lead-through state are ABB's
 *   Motion_System (Rev L) examples: no build's answer has been captured.
 */

// ── RWS 1.0 fake ────────────────────────────────────────────────────────────

function fake1(respond: (method: string, url: string) => { status: number; body: string } | undefined) {
  const calls: string[] = [];
  const client = {
    request: async (method: string, url: string) => {
      calls.push(`${method} ${url}`);
      return respond(method, url) ?? { status: 204, body: '' };
    },
  };
  return { calls, adapter: new RWS1Adapter(client as unknown as RwsClient) };
}

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(RwsError);
  return e as RwsError;
}

// ── RWS 2.0 server ──────────────────────────────────────────────────────────

type Reply = { status: number; headers?: Record<string, string>; body?: string };

async function server2(reply: (method: string, url: string) => Reply) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push(`${req.method ?? ''} ${req.url ?? ''}`);
      const r = reply(req.method ?? '', req.url ?? '');
      res.writeHead(r.status, r.headers ?? {});
      res.end(r.body ?? '');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, requests, client: new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics') };
}

const XHTML = { 'Content-Type': 'application/xhtml+xml;v=2.0' };
const HAL = { 'Content-Type': 'application/hal+json;v=2.0' };

// ── Captured bodies ─────────────────────────────────────────────────────────

/** RW 6.16.03, 2026-09-29: `GET /subscription?json=1` with one group (XHTML despite json=1). */
const GROUPS_RW6 = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Groups</title> <base href="http://127.0.0.1:4578/subscription/"/></head> <body> <div class="state"><a href="" rel="self"></a><a href="?action=show" rel="action"></a><ul><li class="subsgrp-li" title="1"><a href="ws:///poll/1" rel="events"></a><a href="1?action=show" rel="action"></a></li> </ul></div></body></html>';
/** RW 6.16.03, 2026-09-29: the same list with no group. */
const GROUPS_RW6_EMPTY = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Groups</title> <base href="http://127.0.0.1:4578/subscription/"/></head> <body> <div class="state"><a href="" rel="self"></a><a href="?action=show" rel="action"></a><ul></ul></div></body></html>';
/** RW 8.2.1+1023, 2026-09-29: `GET /subscription` with three groups. */
const GROUPS_RW8 = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <base href="https://127.0.0.1:80/subscription/"/></head> <body> <div class="state"><a href="" rel="self"></a><ul><li class="subsgrp-li" title="23"><a href="wss://127.0.0.1:80/poll/23" rel="events"></a></li> <li class="subsgrp-li" title="24"><a href="wss://127.0.0.1:80/poll/24" rel="events"></a></li> <li class="subsgrp-li" title="27"><a href="wss://127.0.0.1:80/poll/27" rel="events"></a></li> </ul></div></body></html>';
/** RW 7.21.4+417, 2026-09-29: `GET /subscription` with no group. */
const GROUPS_RW7_EMPTY = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <base href="https://127.0.0.1:5466/subscription/"/></head> <body> <div class="state"><a href="" rel="self"></a><ul></ul></div></body></html>';

/** RW 6.16.03, 2026-09-29: `GET /subscription/8`, two members. */
const GROUP_RW6 = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Resources</title> <base href="http://127.0.0.1:4578/" /></head> <body><div class="state"> <a href="subscription/8" rel="self"></a> <ul><li class="sub-resource" title="1"><a href="/rw/panel/speedratio;speedratio" rel="self"></a> </li><li class="sub-resource" title="2"><a href="/rw/panel/coldetstate;coldetstate" rel="self"></a> </li></ul></div> </body></html>';
/** RW 8.2.1+1023, 2026-09-29: `GET /subscription/3`, two members. */
const GROUP_RW8 = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <base href="https://127.0.0.1:80/" /></head> <body><div class="state"> <a href="subscription/3" rel="self"></a> <ul><li class="sub-resource" title="1"><a href="/rw/panel/coldetstate;coldetstate" rel="self"></a> </li><li class="sub-resource" title="2"><a href="/rw/panel/speedratio;speedratio" rel="self"></a> </li></ul></div> </body></html>';
/** RW 7.21.4+417, 2026-09-29: `GET /subscription/9` after the group was deleted. */
const GROUP_GONE_RW7 = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <base href="https://127.0.0.1:5466/"/> </head> <body> <div class="status"> <span class="code">-1073435900</span> <span class="msg">Group 9 does not belong to Client 1673144146.</span></div> </body></html>';
/** RW 6.16.03, 2026-09-29: the same refusal on RWS 1.0. */
const GROUP_GONE_RW6 = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Error</title> <base href="http://127.0.0.1:4578/" /> </head> <body> <div class="status"> <span class="code">-1073435900</span> <span class="msg">Group 8 does not belong to Client 30.</span></div> </body></html>';

/** RW 6.16.03, 2026-09-29: `GET /rw/motionsystem/motionsupervision?mechunit=ROB_1&json=1`. */
const MOTION_SUP_RW6 = '{ "_links": { "base": { "href": "http://127.0.0.1:4578/rw/motionsystem/" } }, "_embedded": {  "_state": [ { "_type": "ms-motionsupervision", "_title": "motionsupervision", "mode-enabled": "TRUE", "level": "100" }, { "_type" : "ms-supervision-collision-prediction-mode", "_title" : "supervision-collision-prediction-mode", "self": { "href": "motionsupervision?action=collision-prediction-mode" } }] }}';
/** RW 6.16.03, 2026-09-29: the same GET asked as XHTML; the values come in double quotes. */
const MOTION_SUP_XHTML_RW6 = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>motionsystem</title><base href="http://127.0.0.1:4578/rw/motionsystem/"/></head><body><div class="state"> <a href="motionsupervision?mechunit=ROB_1" rel="self"/> <a href="motionsupervision?action=show" rel="action"/> <ul> <li class="ms-motionsupervision" title="motionsupervision"> <span class="mode-enabled">"TRUE"</span><span class="level">"100"</span> </li> <li class="ms-supervision-collision-prediction-mode" title="supervision-collision-prediction-mode"><a href="motionsupervision?action=collision-prediction-mode" rel="self"/> </li> </ul></div></body></html>';
/**
 * Path supervision as XHTML, its values quoted the way the motion supervision
 * XHTML is (by analogy: no build's XHTML path supervision has been captured).
 */
const PATH_SUP_XHTML_QUOTED = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1/rw/motionsystem/"/></head><body><div class="state"><a href="mechunits/ROB_1/pathsupervision" rel="self"/><ul><li class="ms-pathsupervision" title="pathsupervision"><span class="mode">"ON"</span><span class="level">"100"</span></li></ul></div></body></html>';
/** RW 6.16.03, 2026-09-29: the same GET without `mechunit` (controller build path trimmed). */
const MOTION_SUP_NO_UNIT_RW6 = '{"_links":{"base": { "href": "http://127.0.0.1:4578/" }},"_embedded" :{ "status" : {"code":-1073445879, "msg": "rws_resource_motionsystem.cpp[1717] No/Invalid Mechanical unit code:-1073445879 icode:-1"}, "_state":[  ] }}';
/** RW 8.1.1, 2026-09-27: `GET .../mechunits/ROB_1/motionsupervision` (hal+json). */
const MOTION_SUP_RW8 = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:80/rw/motionsystem/" }, "self" : { "href" : "mechunits/ROB_1/motionsupervision" } }  , "state" : [ { "_type" : "ms-motionsupervision", "_title" : "motionsupervision", "mode-enabled" : "TRUE", "level" : "100" } ]}';
/** RW 8.1.1, 2026-09-27: `GET .../mechunits/ROB_1/pathsupervision` (hal+json). */
const PATH_SUP_RW8 = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:80/rw/motionsystem/" }, "self" : { "href" : "mechunits/ROB_1/pathsupervision" } }  , "state" : [ { "_type" : "ms-pathsupervision", "_title" : "pathsupervision", "mode" : "ON", "level" : "100" } ]}';

/** RW 6.16.03, 2026-09-29: `GET /rw/motionsystem/mechunits/ROB_1?json=1`, trimmed to the entries that matter here. */
const MECHUNIT_RW6 = '{ "_links" : { "base" : { "href" : "http://127.0.0.1:4578/rw/motionsystem/mechunits/" } , "self" : { "href" : "ROB_1?json=1" } }, "_embedded" : {  "_state" : [ { "_type" : "ms-mechunit", "_title" : "ROB_1" , "mode" : "Activated" , "axes" : "6" } , { "_type" : "ms-mechunit-complianceleadthrough", "_title" : "complianceleadthrough", "_links" : { "self" : { "href" : "ROB_1?resource=lead-through&json=1" } } },{ "_type" : "ms-mechunit-smbdata-li", "_title" : "smbdata", "_links" : { "self" : { "href" : "ROB_1/smbdata?json=1" } } },{ "_type" : "ms-mechunit-motorcalib-li", "_title" : "motorcalib", "_links" : { "self" : { "href" : "ROB_1/motorcalib?json=1" } } } ] }}';

/** ABB Motion_System Rev L, "Get SMB Data" example (XHTML). */
const SMB_ABB = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://localhost/rw/motionsystem/mechunits/"/></head><body><div class="state"><a href="smbdata" rel="self"/><ul><li class="ms-mechunit-smbdata" title="smbdata"><span class="cabinet_serial_number_valid">0</span><span class="cabinet_serial_number_high_part">0000</span><span class="cabinet_serial_number_low_part">0</span><span class="cabinet_sis_data_status">2</span><span class="cabinet_abs_acc_data_status">3</span><span class="cabinet_calib_data_status">2</span><span class="sensor_memory_serial_number_valid">0</span><span class="sensor_memory_serial_number_high_part">0000</span><span class="sensor_memory_serial_number_low_part">0</span><span class="sensor_memory_sis_data_status">2</span><span class="sensor_memory_abs_acc_data_status">3</span><span class="sensor_memory_calib_data_status">2</span><span class="cab_drive_module">1</span><span class="cab_measurement_link">1</span><span class="cab_measurement_board">1</span><span class="cabinet_axis_cal_data_status">3</span><span class="sensor_memory_axis_cal_data_status">3</span></li></ul></div></body></html>';
/** ABB Motion_System Rev L, "Get Motor Calib Names" example (XHTML), joints 1-2 of 6. */
const MOTORCALIB_ABB = '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n<base href="https://localhost/rw/motionsystem"/>\n</head>\n<body>\n<div class="state">\n<a href="mechunits/ROB_1/motorcalib" rel="self"/>\r\n      <ul>\n<li class="ms-mechunit-joint" title="joint1">\n<span class="joint-name">rob1_1</span>\n<span class="calib-name">rob1_1</span>\n</li>\n<li class="ms-mechunit-joint" title="joint2">\n<span class="joint-name">rob1_2</span>\n<span class="calib-name">rob1_2</span>\n</li>\n</ul>\n</div>\n</body>\n</html>\n';
/** ABB Motion_System Rev L, "Get Compliance Lead Through" example (XHTML). */
const LEADTHROUGH_ABB = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://localhost/rw/motionsystem/mechunits/"/></head><body><div class="state"> <a href="ROB_1/lead-through" rel="self"/><ul><li class="ms-mechunit-complianceleadthrough" title="complianceleadthrough"><span class="status">Inactive</span></li></ul></div></body></html>';

// ── Path rows ───────────────────────────────────────────────────────────────

describe('niche reads - path rows on both generations', () => {
  const P = { group: '7', mechunit: 'ROB_1' };
  const url = (domain: string, op: string, gen: 'rws1' | 'rws2'): string =>
    buildPath(ALL_TABLES[domain][op][gen] as PathSpec, P);

  it('each operation has a GET row for each generation', () => {
    expect(url('filesVision', 'listSubscriptionGroups', 'rws1')).toBe('/subscription');
    expect(url('filesVision', 'listSubscriptionGroups', 'rws2')).toBe('/subscription');
    expect(url('filesVision', 'getSubscriptionGroup', 'rws1')).toBe('/subscription/7');
    expect(url('filesVision', 'getSubscriptionGroup', 'rws2')).toBe('/subscription/7');
    expect(url('motion', 'getMotionSupervision', 'rws1')).toBe('/rw/motionsystem/motionsupervision');
    expect(url('motion', 'getMotionSupervision', 'rws2')).toBe('/rw/motionsystem/mechunits/ROB_1/motionsupervision');
    expect(url('motion', 'getPathSupervision', 'rws1')).toBe('/rw/motionsystem/pathsupervision');
    expect(url('motion', 'getPathSupervision', 'rws2')).toBe('/rw/motionsystem/mechunits/ROB_1/pathsupervision');
    expect(url('motion', 'getMechunitSmbData', 'rws1')).toBe('/rw/motionsystem/mechunits/ROB_1/smbdata');
    expect(url('motion', 'getMechunitSmbData', 'rws2')).toBe('/rw/motionsystem/mechunits/ROB_1/smbdata');
    expect(url('motion', 'getMechunitMotorCalib', 'rws1')).toBe('/rw/motionsystem/mechunits/ROB_1/motorcalib');
    expect(url('motion', 'getMechunitMotorCalib', 'rws2')).toBe('/rw/motionsystem/mechunits/ROB_1/motorcalib');
    expect(url('motion', 'getLeadThrough', 'rws1')).toBe('/rw/motionsystem/mechunits/ROB_1');
    expect(url('motion', 'getLeadThrough', 'rws2')).toBe('/rw/motionsystem/mechunits/ROB_1/lead-through');
    for (const [d, op] of [
      ['filesVision', 'listSubscriptionGroups'], ['filesVision', 'getSubscriptionGroup'],
      ['motion', 'getMotionSupervision'], ['motion', 'getPathSupervision'], ['motion', 'getMechunitSmbData'],
      ['motion', 'getMechunitMotorCalib'], ['motion', 'getLeadThrough'],
    ]) {
      expect(ALL_TABLES[d][op].rws1?.method).toBe('GET');
      expect(ALL_TABLES[d][op].rws2?.method).toBe('GET');
    }
  });
});

// ── Subscription groups ─────────────────────────────────────────────────────

describe('listSubscriptionGroups', () => {
  it('RWS 1.0 GETs /subscription?json=1 and reads the XHTML list, host-less poll link as given', async () => {
    const f = fake1(() => ({ status: 200, body: GROUPS_RW6 }));
    expect(await f.adapter.listSubscriptionGroups()).toEqual([
      { id: '1', groupPath: '/subscription/1', pollUrl: 'ws:///poll/1' },
    ]);
    expect(f.calls).toEqual(['GET /subscription?json=1']);
    const g = fake1(() => ({ status: 200, body: GROUPS_RW6_EMPTY }));
    expect(await g.adapter.listSubscriptionGroups()).toEqual([]);
  });

  it('RWS 2.0 GETs /subscription and lists every group with its poll URL', async () => {
    const { server, requests, client } = await server2(() => ({ status: 200, headers: XHTML, body: GROUPS_RW8 }));
    try {
      const groups = await client.listSubscriptionGroups();
      expect(groups.map(g => g.id)).toEqual(['23', '24', '27']);
      expect(groups[2]).toEqual({ id: '27', groupPath: '/subscription/27', pollUrl: 'wss://127.0.0.1:80/poll/27' });
      expect(requests).toEqual(['GET /subscription']);
    } finally { server.close(); }
    const empty = await server2(() => ({ status: 200, headers: XHTML, body: GROUPS_RW7_EMPTY }));
    try { expect(await empty.client.listSubscriptionGroups()).toEqual([]); } finally { empty.server.close(); }
  });

  it('RWS 2.0 asks XHTML for subscription reads, so later GETs keep negotiating hal+json', async () => {
    const accepts: string[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        accepts.push(`${req.url} ${req.headers['accept']}`);
        if ((req.url ?? '').startsWith('/subscription')) {
          res.writeHead(200, XHTML); res.end(req.url === '/subscription' ? GROUPS_RW8 : GROUP_RW8);
        } else {
          res.writeHead(200, HAL); res.end(MOTION_SUP_RW8);
        }
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const client = new RwsClient2(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'Default User', 'robotics');
      await client.listSubscriptionGroups();
      await client.getSubscriptionGroup('23');
      await client.getMotionSupervision();
      expect(accepts).toEqual([
        '/subscription application/xhtml+xml;v=2.0',
        '/subscription/23 application/xhtml+xml;v=2.0',
        '/rw/motionsystem/mechunits/ROB_1/motionsupervision application/hal+json;v=2.0',
      ]);
    } finally { server.close(); }
  });

  it('reads a hal+json list too, and an answer of other classes is PARSE_ERROR', () => {
    const json = JSON.stringify({ _embedded: { resources: [
      { _type: 'subsgrp-li', _title: '4', _links: { events: { href: 'wss://h/poll/4' } } },
      { _type: 'subsgrp-li', _title: '5' },
    ] } });
    expect(subscriptionGroupsFrom(json, 'x')).toEqual([
      { id: '4', groupPath: '/subscription/4', pollUrl: 'wss://h/poll/4' },
      { id: '5', groupPath: '/subscription/5' },
    ]);
    expect(subscriptionGroupsFrom('', 'x')).toEqual([]);
    const e = (() => { try { subscriptionGroupsFrom(GROUP_RW6, 'x'); return null; } catch (x) { return x as RwsError; } })();
    expect(e?.code).toBe('PARSE_ERROR');
    expect(e?.message).toMatch(/classes seen: sub-resource/);
  });
});

describe('getSubscriptionGroup', () => {
  it('RWS 1.0 GETs /subscription/{id} and returns each member as the group stores it', async () => {
    const f = fake1(() => ({ status: 200, body: GROUP_RW6 }));
    expect(await f.adapter.getSubscriptionGroup('/subscription/8')).toEqual([
      { index: '1', resource: '/rw/panel/speedratio;speedratio' },
      { index: '2', resource: '/rw/panel/coldetstate;coldetstate' },
    ]);
    expect(await f.adapter.getSubscriptionGroup('8')).toHaveLength(2);
    expect(f.calls).toEqual(['GET /subscription/8', 'GET /subscription/8']);
  });

  it('RWS 2.0 GETs /subscription/{id}', async () => {
    const { server, requests, client } = await server2(() => ({ status: 200, headers: XHTML, body: GROUP_RW8 }));
    try {
      expect(await client.getSubscriptionGroup('/subscription/3')).toEqual([
        { index: '1', resource: '/rw/panel/coldetstate;coldetstate' },
        { index: '2', resource: '/rw/panel/speedratio;speedratio' },
      ]);
      expect(requests).toEqual(['GET /subscription/3']);
    } finally { server.close(); }
  });

  it('a group that is not the session\'s is the controller\'s typed refusal on both generations', async () => {
    const f = fake1(() => ({ status: 400, body: GROUP_GONE_RW6 }));
    expect(await rejection(f.adapter.getSubscriptionGroup('8'))).toMatchObject({ httpStatus: 400, controllerCode: -1073435900 });
    const { server, client } = await server2(() => ({ status: 400, headers: XHTML, body: GROUP_GONE_RW7 }));
    try {
      expect(await rejection(client.getSubscriptionGroup('9'))).toMatchObject({ httpStatus: 400, controllerCode: -1073435900 });
    } finally { server.close(); }
  });

  it('refuses anything but an id or /subscription/{id} before sending', async () => {
    const f = fake1(() => undefined);
    for (const bad of ['', 'ws://127.0.0.1/poll/2', '/subscription/2/../../rw/panel', '../x', '/subscription/', '2?x=1']) {
      expect((await rejection(f.adapter.getSubscriptionGroup(bad))).code).toBe('INVALID_ARGUMENT');
    }
    expect(f.calls).toEqual([]);
    const { server, requests, client } = await server2(() => ({ status: 200, body: '' }));
    try {
      expect((await rejection(client.getSubscriptionGroup('/rw/panel'))).code).toBe('INVALID_ARGUMENT');
      expect(requests).toEqual([]);
    } finally { server.close(); }
    expect(subscriptionGroupId(' /subscription/12 ', 'x')).toBe('12');
  });
});

// ── Motion and path supervision ─────────────────────────────────────────────

describe('getMotionSupervision', () => {
  it('RWS 1.0 GETs the motion-system root with ?mechunit= and reads ms-motionsupervision', async () => {
    const f = fake1(() => ({ status: 200, body: MOTION_SUP_RW6 }));
    expect(await f.adapter.getMotionSupervision()).toEqual({ enabled: true, level: 100 });
    await f.adapter.getMotionSupervision('ROB 2');
    expect(f.calls).toEqual([
      'GET /rw/motionsystem/motionsupervision?mechunit=ROB_1&json=1',
      'GET /rw/motionsystem/motionsupervision?mechunit=ROB%202&json=1',
    ]);
  });

  it('RWS 1.0: the 400 without a unit is typed, an empty unit is refused before sending', async () => {
    const f = fake1(() => ({ status: 400, body: MOTION_SUP_NO_UNIT_RW6 }));
    expect(await rejection(f.adapter.getMotionSupervision('X'))).toMatchObject({ httpStatus: 400, controllerCode: -1073445879 });
    const g = fake1(() => undefined);
    expect((await rejection(g.adapter.getMotionSupervision(''))).code).toBe('INVALID_ARGUMENT');
    expect(g.calls).toEqual([]);
  });

  it('RWS 2.0 GETs the mechunit sub-resource; an answer without the class is PARSE_ERROR', async () => {
    const { server, requests, client } = await server2(() => ({ status: 200, headers: HAL, body: MOTION_SUP_RW8 }));
    try {
      expect(await client.getMotionSupervision()).toEqual({ enabled: true, level: 100 });
      expect(requests).toEqual(['GET /rw/motionsystem/mechunits/ROB_1/motionsupervision']);
    } finally { server.close(); }
    const bad = await server2(() => ({ status: 200, headers: HAL, body: PATH_SUP_RW8 }));
    try {
      expect((await rejection(bad.client.getMotionSupervision())).code).toBe('PARSE_ERROR');
    } finally { bad.server.close(); }
  });

  it('reads the XHTML form, whose values come in double quotes (RW 6.16.03 capture)', () => {
    expect(motionSupervisionFrom(parseBody(MOTION_SUP_XHTML_RW6).getAllEntries(), 'x')).toEqual({ enabled: true, level: 100 });
    const off = MOTION_SUP_XHTML_RW6.replace('"TRUE"', '"FALSE"').replace('"100"', '"80"');
    expect(motionSupervisionFrom(parseBody(off).getAllEntries(), 'x')).toEqual({ enabled: false, level: 80 });
    const e = (() => {
      try { motionSupervisionFrom(parseBody(MOTION_SUP_XHTML_RW6.replace('"100"', '"high"')).getAllEntries(), 'x'); return null; }
      catch (x) { return x as RwsError; }
    })();
    expect(e?.code).toBe('PARSE_ERROR');
  });

  it('RWS 2.0 reads an XHTML answer (the form a client falls back to) with its quoted values', async () => {
    const { server, client } = await server2((_m, url) => ({
      status: 200, headers: XHTML,
      body: url.endsWith('pathsupervision') ? PATH_SUP_XHTML_QUOTED : MOTION_SUP_XHTML_RW6,
    }));
    try {
      expect(await client.getMotionSupervision()).toEqual({ enabled: true, level: 100 });
      expect(await client.getPathSupervision()).toEqual({ mode: 'ON', level: 100 });
    } finally { server.close(); }
    expect(pathSupervisionFrom(parseBody(PATH_SUP_XHTML_QUOTED).getAllEntries(), 'x')).toEqual({ mode: 'ON', level: 100 });
  });
});

describe('getPathSupervision', () => {
  it('RWS 2.0 GETs the mechunit sub-resource and reads mode and level', async () => {
    const { server, requests, client } = await server2(() => ({ status: 200, headers: HAL, body: PATH_SUP_RW8 }));
    try {
      expect(await client.getPathSupervision('ROB_1')).toEqual({ mode: 'ON', level: 100 });
      expect(requests).toEqual(['GET /rw/motionsystem/mechunits/ROB_1/pathsupervision']);
    } finally { server.close(); }
  });

  it('RWS 1.0 GETs the motion-system root with ?mechunit= (not yet captured: the 2.0 class is read)', async () => {
    const body = JSON.stringify({ _embedded: { _state: [{ _type: 'ms-pathsupervision', _title: 'pathsupervision', mode: 'OFF', level: '80' }] } });
    const f = fake1(() => ({ status: 200, body }));
    expect(await f.adapter.getPathSupervision()).toEqual({ mode: 'OFF', level: 80 });
    expect(f.calls).toEqual(['GET /rw/motionsystem/pathsupervision?mechunit=ROB_1&json=1']);
  });

  it('a body without mode or a numeric level is PARSE_ERROR, never a made-up value', async () => {
    const noLevel = JSON.stringify({ _embedded: { _state: [{ _type: 'ms-pathsupervision', mode: 'ON' }] } });
    expect((await rejection(fake1(() => ({ status: 200, body: noLevel })).adapter.getPathSupervision())).code).toBe('PARSE_ERROR');
    const noMode = JSON.stringify({ _embedded: { _state: [{ _type: 'ms-pathsupervision', level: '100' }] } });
    expect((await rejection(fake1(() => ({ status: 200, body: noMode })).adapter.getPathSupervision())).code).toBe('PARSE_ERROR');
    const links = JSON.stringify({ _embedded: { _state: [{ _type: 'ms-pathsupervision-li', _title: 'pathsupervision' }] } });
    const e = await rejection(fake1(() => ({ status: 200, body: links })).adapter.getPathSupervision());
    expect(e.code).toBe('PARSE_ERROR');
    expect(e.message).toMatch(/classes seen: ms-pathsupervision-li/);
  });
});

// ── Mechunit SMB data, motor calibration, lead-through ──────────────────────

describe('getMechunitSmbData', () => {
  it('RWS 2.0 returns the ms-mechunit-smbdata fields as given', async () => {
    const { server, requests, client } = await server2(() => ({ status: 200, headers: XHTML, body: SMB_ABB }));
    try {
      const smb = await client.getMechunitSmbData();
      expect(smb).toMatchObject({ cabinet_serial_number_high_part: '0000', cabinet_sis_data_status: '2', cab_measurement_board: '1', sensor_memory_axis_cal_data_status: '3' });
      expect(smb['_type']).toBeUndefined();
      // ABB's example is XHTML: the client asks hal+json first, then XHTML.
      expect(new Set(requests)).toEqual(new Set(['GET /rw/motionsystem/mechunits/ROB_1/smbdata']));
    } finally { server.close(); }
  });

  it('RWS 1.0 GETs .../smbdata?json=1; the mechunit\'s link entry is not data', async () => {
    const body = JSON.stringify({ _embedded: { _state: [{ _type: 'ms-mechunit-smbdata', _title: 'smbdata', cab_drive_module: '1' }] } });
    const f = fake1(() => ({ status: 200, body }));
    expect(await f.adapter.getMechunitSmbData('ROB_1')).toMatchObject({ cab_drive_module: '1' });
    expect(f.calls).toEqual(['GET /rw/motionsystem/mechunits/ROB_1/smbdata?json=1']);
    const g = fake1(() => ({ status: 200, body: MECHUNIT_RW6 }));
    expect((await rejection(g.adapter.getMechunitSmbData())).code).toBe('PARSE_ERROR');
  });

  it('RWS 1.0 reads the RW 6.16.03 answer, whose JSON has a comma before its closing brace (2026-10-01)', async () => {
    // As the controller wrote it (a shortened field list), the trailing comma included.
    const body = '{"_links":{"base": { "href": "http://127.0.0.1:60654/rw/motionsystem/mechunits/" }},"_embedded" :{  "_state":[ '
      + '{ "_type":"ms-mechunit-smbdata", "_title":"smbdata", "cabinet_serial_number_valid":"0", '
      + '"cab_measurement_board":"1","sensor_memory_axis_cal_data_status":"3", } ] }}';
    expect(() => JSON.parse(body)).toThrow();
    const f = fake1(() => ({ status: 200, body }));
    expect(await f.adapter.getMechunitSmbData('ROB_1')).toEqual({
      _title: 'smbdata', cabinet_serial_number_valid: '0', cab_measurement_board: '1', sensor_memory_axis_cal_data_status: '3',
    });
  });
});

describe('getMechunitMotorCalib', () => {
  it('RWS 2.0 returns one entry per ms-mechunit-joint', async () => {
    const { server, requests, client } = await server2(() => ({ status: 200, headers: XHTML, body: MOTORCALIB_ABB }));
    try {
      expect(await client.getMechunitMotorCalib()).toEqual([
        { joint: 'joint1', jointName: 'rob1_1', calibName: 'rob1_1' },
        { joint: 'joint2', jointName: 'rob1_2', calibName: 'rob1_2' },
      ]);
      // ABB's example is XHTML: the client asks hal+json first, then XHTML.
      expect(new Set(requests)).toEqual(new Set(['GET /rw/motionsystem/mechunits/ROB_1/motorcalib']));
    } finally { server.close(); }
  });

  it('RWS 1.0 GETs .../motorcalib?json=1; other classes are PARSE_ERROR, no entry an empty list', async () => {
    const body = JSON.stringify({ _embedded: { _state: [{ _type: 'ms-mechunit-joint', _title: 'joint1', 'joint-name': 'rob1_1', 'calib-name': 'rob1_1' }] } });
    const f = fake1(() => ({ status: 200, body }));
    expect(await f.adapter.getMechunitMotorCalib('ROB_1')).toEqual([{ joint: 'joint1', jointName: 'rob1_1', calibName: 'rob1_1' }]);
    expect(f.calls).toEqual(['GET /rw/motionsystem/mechunits/ROB_1/motorcalib?json=1']);
    expect((await rejection(fake1(() => ({ status: 200, body: MECHUNIT_RW6 })).adapter.getMechunitMotorCalib())).code).toBe('PARSE_ERROR');
    expect(motorCalibFrom([], 'x')).toEqual([]);
  });

  it('RWS 1.0 reads the numbered classes RW 6.16.03 answers (ms-mechunit-joint1 .. 6, 2026-10-01)', async () => {
    const joint = (n: number) => ({ _type: `ms-mechunit-joint${n}`, _title: `Joint${n}`, 'joint-name': `rob1_${n}`, 'calib-name': `rob1_${n}` });
    const body = JSON.stringify({
      _links: { base: { href: 'http://127.0.0.1/rw/motionsystem/' } },
      _embedded: { _state: [1, 2, 3, 4, 5, 6].map(joint) },
    });
    const f = fake1(() => ({ status: 200, body }));
    const calib = await f.adapter.getMechunitMotorCalib('ROB_1');
    expect(calib).toHaveLength(6);
    expect(calib[0]).toEqual({ joint: 'Joint1', jointName: 'rob1_1', calibName: 'rob1_1' });
    expect(calib[5]).toEqual({ joint: 'Joint6', jointName: 'rob1_6', calibName: 'rob1_6' });
    // A class that merely starts with the joint class is not a joint.
    expect(() => motorCalibFrom([{ _type: 'ms-mechunit-jointtarget-li', _title: 'jointtarget' }], 'x')).toThrow(RwsError);
  });
});

describe('getLeadThrough', () => {
  it('RWS 2.0 GETs .../lead-through and reads the status', async () => {
    const { server, requests, client } = await server2(() => ({ status: 200, headers: XHTML, body: LEADTHROUGH_ABB }));
    try {
      expect(await client.getLeadThrough()).toEqual({ active: false, status: 'Inactive' });
      // ABB's example is XHTML: the client asks hal+json first, then XHTML.
      expect(new Set(requests)).toEqual(new Set(['GET /rw/motionsystem/mechunits/ROB_1/lead-through']));
    } finally { server.close(); }
  });

  it('RWS 1.0 GETs the mechunit with ?resource=lead-through&json=1', async () => {
    const body = JSON.stringify({ _embedded: { _state: [{ _type: 'ms-mechunit-complianceleadthrough', _title: 'complianceleadthrough', status: 'active' }] } });
    const f = fake1(() => ({ status: 200, body }));
    expect(await f.adapter.getLeadThrough('ROB_1')).toEqual({ active: true, status: 'active' });
    expect(f.calls).toEqual(['GET /rw/motionsystem/mechunits/ROB_1?resource=lead-through&json=1']);
  });

  it('the RW 6.16 mechunit body (its link under the same class, no status) is PARSE_ERROR, not a reading', async () => {
    const f = fake1(() => ({ status: 200, body: MECHUNIT_RW6 }));
    const e = await rejection(f.adapter.getLeadThrough());
    expect(e.code).toBe('PARSE_ERROR');
    expect(e.message).toMatch(/with a status/);
    expect(() => leadThroughFrom(parseBody(MECHUNIT_RW6).getAllEntries(), 'x')).toThrow(RwsError);
    expect((await rejection(fake1(() => undefined).adapter.getLeadThrough(' '))).code).toBe('INVALID_ARGUMENT');
  });
});

// ── RobotManager ────────────────────────────────────────────────────────────

describe('RobotManager niche reads', () => {
  it('answer an empty value when the adapter lacks the read', async () => {
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = {};
    expect(await mgr.listSubscriptionGroups()).toEqual([]);
    expect(await mgr.getSubscriptionGroup('1')).toEqual([]);
    expect(await mgr.getMotionSupervision()).toBeNull();
    expect(await mgr.getPathSupervision()).toBeNull();
    expect(await mgr.getMechunitSmbData()).toEqual({});
    expect(await mgr.getMechunitMotorCalib()).toEqual([]);
    expect(await mgr.getLeadThrough()).toBeNull();
  });

  it('forward to the adapter, refusals included', async () => {
    const mgr = new RobotManager();
    const adapter = {
      listSubscriptionGroups: vi.fn(async () => [{ id: '1', groupPath: '/subscription/1' }]),
      getMotionSupervision: vi.fn(async () => ({ enabled: true, level: 100 })),
      getLeadThrough: vi.fn(async () => { throw new RwsError('no', 'RESOURCE_NOT_FOUND', 404); }),
    };
    (mgr as unknown as { adapter: unknown }).adapter = adapter;
    expect(await mgr.listSubscriptionGroups()).toEqual([{ id: '1', groupPath: '/subscription/1' }]);
    expect(await mgr.getMotionSupervision('ROB_2')).toEqual({ enabled: true, level: 100 });
    expect(adapter.getMotionSupervision).toHaveBeenCalledWith('ROB_2');
    await expect(mgr.getLeadThrough()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
