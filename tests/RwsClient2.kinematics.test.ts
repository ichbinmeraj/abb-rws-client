import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';

/**
 * RWS 2.0 kinematics (2026-09-30): inverse kinematics on ABB's
 * `joints-from-cartesian` and forward kinematics on ABB's `pose-from-joints`,
 * both in SI units (metres and radians in and out).
 *
 * The request fields are the controllers' own forms (OPTIONS, read
 * 2026-09-29 on RW 7.21.4 and 8.2.1) as ABB's RWS 2.0 page names them. The
 * answers are built in the XHTML shape ABB's RWS 2.0 page shows for each
 * resource (classes `joints-from-cartesian` and `position-from-joint`), with
 * the values RW 6.16.03 answered live for the same robot pose over RWS 1.0:
 * joints 0, 0, 0, 0, 30, 0 degrees and the pose 806.2917, 0, 929 mm,
 * q 0.5, 0, 0.8660254, 0. The 400 out-of-reach body is the one RW 7.21.4
 * answered on 2026-09-30 to the old millimetre request, recorded up to its
 * message; the closing tags are rebuilt.
 */

interface Recorded { method: string; url: string; contentType: string; body: string }

async function startServer(
  answer: (req: Recorded) => { status: number; body: string },
): Promise<{ server: http.Server; base: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: Recorded = {
        method: req.method ?? '', url: req.url ?? '',
        contentType: String(req.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(rec);
      const a = answer(rec);
      res.writeHead(a.status, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(a.body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function withServer(
  answer: (req: Recorded) => { status: number; body: string },
  run: (c: RwsClient2, requests: Recorded[]) => Promise<void>,
): Promise<void> {
  const { server, base, requests } = await startServer(answer);
  try { await run(new RwsClient2(base, 'u', 'p'), requests); } finally { server.close(); }
}

/** An XHTML answer as ABB's RWS 2.0 page lays it out (line breaks included). */
const xhtml = (self: string, li: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<html>\n<head>\n<base href="https://localhost/rw/motionsystem/mechunits/ROB_1/" />\n</head>\n<body>\n'
  + `<div class="state">\n<a href= "${self}" rel="self"/>\n<ul>\n${li}\n</ul>\n</div>\n</body>\n</html>`;

const spans = (fields: Record<string, string>): string =>
  Object.entries(fields).map(([k, v]) => `<span class="${k}">${v}</span>`).join('\n');

const EXT_ANSWER = Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [`extjoint${i}`, '8.999999e+09']));

const FK_FIELDS: Record<string, string> = {
  'position-x': '0.8062917', 'position-y': '0', 'position-z': '0.929',
  'robtargetorientation-u0': '0.5', 'robtargetorientation-u1': '0',
  'robtargetorientation-u2': '0.8660254', 'robtargetorientation-u3': '0',
  'quarter-rev-j1': '0', 'quarter-rev-j4': '0', 'quarter-rev-j6': '0', 'quarter-rev-jx': '0',
  ...EXT_ANSWER,
};
const fkAnswer = (fields: Record<string, string> = FK_FIELDS): string =>
  xhtml('pose-from-joints', `<li class="position-from-joint" title="positionData">\n${spans(fields)}\n</li>`);

const IK_FIELDS: Record<string, string> = {
  robotjoint1: '0', robotjoint2: '4.19e-08', robotjoint3: '-9.02e-08',
  robotjoint4: '0', robotjoint5: '0.5235988', robotjoint6: '0',
  ...EXT_ANSWER,
};
const ikAnswer = (cls = 'joints-from-cartesian', fields: Record<string, string> = IK_FIELDS): string =>
  xhtml('joints-from-cartesian', `<li class="${cls}" title="jointData">\n${spans(fields)}\n</li>`);

/** RW 7.21.4, 2026-09-30: the old millimetre IK request for the current pose. */
const IK_OUT_OF_REACH_RW7 = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:5466/"/></head>'
  + '<body><div class="status"><span class="code">-1073436654</span><span class="msg">rws_resource_motionsystem.cpp[9943] Position outside of reach code:-1073436654 icode:-1</span></div></body></html>';

const JOINTS_30 = { rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 30, rax_6: 0 };
const POSE_30 = { x: 806.2917, y: 0, z: 929, q1: 0.5, q2: 0, q3: 0.8660254, q4: 0 };
const EXT = '[9E9,9E9,9E9,9E9,9E9,9E9]';

// ─── Forward kinematics ──────────────────────────────────────────────────────

describe('RwsClient2.calcCartesianFromJoints (pose-from-joints, SI units)', () => {
  it('POSTs ABB\'s six documented fields to pose-from-joints, joints in radians, tool0 as the identity frame', async () => {
    await withServer(() => ({ status: 200, body: fkAnswer() }), async (c, requests) => {
      await c.calcCartesianFromJoints(JOINTS_30);
      expect(requests).toHaveLength(1);
      const [r] = requests;
      expect(`${r.method} ${r.url}`).toBe('POST /rw/motionsystem/mechunits/ROB_1/pose-from-joints');
      expect(r.contentType).toBe('application/x-www-form-urlencoded;v=2.0');
      expect(r.body).toBe('tool_frame_position=[0,0,0]&tool_frame_orientation=[1,0,0,0]'
        + `&rob_joints=[0,0,0,0,0.523598776,0]&ext_joints=${EXT}&robot_fixed_object=FALSE&elog_at_error=FALSE`);
      // Neither the old action nor the form's undocumented seventh field.
      expect(r.url).not.toMatch(/CalcRobTFromJoints/);
      expect(r.body).not.toMatch(/absolute_accuracy|curr_joints|tool=|wobj=/);
    });
  });

  it('reads position-x/y/z in metres as millimetres, and the robtargetorientation-uN orientation', async () => {
    await withServer(() => ({ status: 200, body: fkAnswer() }), async c => {
      const pose = await c.calcCartesianFromJoints(JOINTS_30, 'ROB_1', 'tool0', 'wobj0');
      expect(pose).toEqual({ x: 806.2917, y: 0, z: 929, q1: 0.5, q2: 0, q3: 0.8660254, q4: 0 });
    });
  });

  it('also reads the RW 6.16.03 spelling robtarget-orientation-uN', async () => {
    const fields = Object.fromEntries(Object.entries(FK_FIELDS).map(([k, v]) => [k.replace('robtargetorientation-', 'robtarget-orientation-'), v]));
    await withServer(() => ({ status: 200, body: fkAnswer(fields) }), async c => {
      const pose = await c.calcCartesianFromJoints(JOINTS_30);
      expect([pose.q1, pose.q2, pose.q3, pose.q4]).toEqual([0.5, 0, 0.8660254, 0]);
    });
  });

  it('rounds the millimetres to 1e-6 so the metre conversion leaves no binary noise', async () => {
    // The position RW 6.16.03 answered for joints 10,-10,20,5,40,15
    // (2026-09-30); unrounded, x and y read 688.9404999999999 and 125.17639999999999.
    await withServer(() => ({ status: 200, body: fkAnswer({ ...FK_FIELDS, 'position-x': '0.6889405', 'position-y': '0.1251764' }) }), async c => {
      const pose = await c.calcCartesianFromJoints(JOINTS_30);
      expect(pose.x).toBe(688.9405);
      expect(pose.y).toBe(125.1764);
    });
  });

  it('refuses a tool or work object other than tool0/wobj0 with INVALID_ARGUMENT before sending', async () => {
    await withServer(() => ({ status: 200, body: fkAnswer() }), async (c, requests) => {
      await expect(c.calcCartesianFromJoints(JOINTS_30, 'ROB_1', 'tGripper', 'wobj0')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(c.calcCartesianFromJoints(JOINTS_30, 'ROB_1', 'tool0', 'wobjTable')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(requests).toEqual([]);
      // RAPID names are case-insensitive.
      await expect(c.calcCartesianFromJoints(JOINTS_30, 'ROB_1', 'TOOL0', 'WObj0')).resolves.toBeTruthy();
    });
  });

  it('an answer without a position-from-joint entry is PARSE_ERROR, not a pose of NaN', async () => {
    // The shape the client used to expect (ms-robtarget x/y/z/q1..q4); ABB's page shows none.
    const old = xhtml('x', `<li class="ms-robtarget" title="ROB_1">${spans({ x: '806', y: '0', z: '929', q1: '0.5', q2: '0', q3: '0.866', q4: '0' })}</li>`);
    await withServer(() => ({ status: 200, body: old }), async c => {
      await expect(c.calcCartesianFromJoints(JOINTS_30)).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    });
  });

  it('an error embedded in a 200 (link, either attribute order) is typed by its code and keeps it', async () => {
    for (const link of [
      '<a href="/rw/retcode?code=-1073436654" rel="error"></a>',
      '<a rel="error" href="/rw/retcode?code=-1073436654"></a>',
    ]) {
      await withServer(() => ({ status: 200, body: xhtml('pose-from-joints', link) }), async c => {
        const err = await c.calcCartesianFromJoints(JOINTS_30).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RwsError);
        expect(err).toMatchObject({ code: 'INVALID_ARGUMENT', httpStatus: 200, controllerCode: -1073436654 });
        expect((err as RwsError).message).toContain('SYS_CTRL_E_POSE_OUTSIDE_REACH');
      });
    }
    // A code this client does not map is UNKNOWN, with the code kept.
    await withServer(() => ({ status: 200, body: xhtml('pose-from-joints', '<a href="/rw/retcode?code=-1073400000" rel="error"></a>') }), async c => {
      await expect(c.calcCartesianFromJoints(JOINTS_30)).rejects.toMatchObject({ code: 'UNKNOWN', controllerCode: -1073400000 });
    });
  });
});

// ─── Inverse kinematics ──────────────────────────────────────────────────────

describe('RwsClient2.calcJointsFromCartesian (joints-from-cartesian, SI units)', () => {
  it('POSTs ABB\'s ten documented fields in the form\'s order: metres, radians, plain names, no wobj_frame_*', async () => {
    await withServer(() => ({ status: 200, body: ikAnswer() }), async (c, requests) => {
      await c.calcJointsFromCartesian(POSE_30, JOINTS_30);
      expect(requests).toHaveLength(1);
      const [r] = requests;
      expect(`${r.method} ${r.url}`).toBe('POST /rw/motionsystem/mechunits/ROB_1/joints-from-cartesian');
      expect(r.contentType).toBe('application/x-www-form-urlencoded;v=2.0');
      expect(r.body).toBe(`curr_position=[0.8062917,0,0.929]&curr_ext_joints=${EXT}&tool_frame_position=[0,0,0]`
        + '&curr_orientation=[0.5,0,0.8660254,0]&tool_frame_orientation=[1,0,0,0]'
        + `&old_rob_joints=[0,0,0,0,0.523598776,0]&old_ext_joints=${EXT}&robot_fixed_object=FALSE`
        + '&robot_configuration=[0,0,0,0]&elog_at_error=FALSE');
      // The form writes three of these names with a trailing space; ABB's page does not.
      expect(r.body).not.toMatch(/ =|%20=|\+=/);
      expect(r.body).not.toMatch(/wobj_frame|absolute_accuracy/);
    });
  });

  it('never writes a number in exponent form (the values RW 7.21.4 read on 2026-09-30)', async () => {
    await withServer(() => ({ status: 200, body: ikAnswer() }), async (c, requests) => {
      await c.calcJointsFromCartesian(
        { x: 806.291699409485, y: 0, z: 928.999960422516, q1: 0.5, q2: 7.41645749258169e-8, q3: 0.866025388240814, q4: 4.28189395051959e-8 },
        { rax_1: 0, rax_2: 0, rax_3: 0, rax_4: 0, rax_5: 30.0000019073486, rax_6: 0.00000981337780103786 });
      const body = requests[0].body;
      expect(body).toContain('curr_position=[0.806291699,0,0.92899996]');
      expect(body).toContain('curr_orientation=[0.5,0.000000074,0.866025388,0.000000043]');
      expect(body).toContain('old_rob_joints=[0,0,0,0,0.523598809,0.000000171]');
      expect(body.replace(/9E9/g, '')).not.toMatch(/\de[-+]?\d/i);
    });
  });

  it('with no seed sends zero seed joints', async () => {
    await withServer(() => ({ status: 200, body: ikAnswer() }), async (c, requests) => {
      await c.calcJointsFromCartesian(POSE_30);
      expect(requests[0].body).toContain('old_rob_joints=[0,0,0,0,0,0]');
    });
  });

  it('reads robotjoint1..6 in radians as degrees, rounded to 1e-6', async () => {
    await withServer(() => ({ status: 200, body: ikAnswer() }), async c => {
      const j = await c.calcJointsFromCartesian(POSE_30, JOINTS_30);
      // 0.5235988 rad is 30.0000014 degrees; 4.19e-08 rad is 2.4e-06 degrees.
      expect(j).toEqual({ rax_1: 0, rax_2: 0.000002, rax_3: -0.000005, rax_4: 0, rax_5: 30.000001, rax_6: 0 });
      expect(Object.is(j.rax_1, -0)).toBe(false);
    });
  });

  it('also reads the joints-from-pose and RW 6.16.03 (all-joint-solutions) answer classes', async () => {
    for (const cls of ['joints-from-pose', 'all-joint-solutions']) {
      await withServer(() => ({ status: 200, body: ikAnswer(cls) }), async c => {
        expect((await c.calcJointsFromCartesian(POSE_30, JOINTS_30)).rax_5).toBe(30.000001);
      });
    }
  });

  it('an answer without robotjoint1..6 is PARSE_ERROR, not joints of NaN', async () => {
    // The shape the client used to expect (ms-jointtarget rax_1..rax_6); ABB's page shows none.
    const old = xhtml('x', `<li class="ms-jointtarget" title="ROB_1">${spans({ rax_1: '0', rax_2: '0', rax_3: '0', rax_4: '0', rax_5: '30', rax_6: '0' })}</li>`);
    await withServer(() => ({ status: 200, body: old }), async c => {
      await expect(c.calcJointsFromCartesian(POSE_30, JOINTS_30)).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    });
    await withServer(() => ({ status: 200, body: ikAnswer('joints-from-cartesian', { robotjoint1: '0' }) }), async c => {
      await expect(c.calcJointsFromCartesian(POSE_30, JOINTS_30)).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    });
  });

  it('a pose out of reach (the recorded RW 7.21.4 400 -1073436654) is INVALID_ARGUMENT with an invalid-argument refusal', async () => {
    await withServer(() => ({ status: 400, body: IK_OUT_OF_REACH_RW7 }), async c => {
      const err = await c.calcJointsFromCartesian({ ...POSE_30, x: POSE_30.x + 5000 }, JOINTS_30).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect(err).toMatchObject({
        code: 'INVALID_ARGUMENT', httpStatus: 400, controllerCode: -1073436654,
        controllerMsg: 'Position outside of reach code:-1073436654 icode:-1',
        refusal: { kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool' },
      });
      expect((err as RwsError).message).toMatch(/outside the robot's reach/);
      expect((err as RwsError).message).toContain('HTTP 400 from POST /rw/motionsystem/mechunits/ROB_1/joints-from-cartesian');
    });
  });

  it('an error embedded in a 200 is typed by its code', async () => {
    await withServer(() => ({ status: 200, body: xhtml('joints-from-cartesian', '<a href="/rw/retcode?code=-1073436654" rel="error"></a>') }), async c => {
      await expect(c.calcJointsFromCartesian(POSE_30, JOINTS_30))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', httpStatus: 200, controllerCode: -1073436654 });
    });
  });

  it('encodes the mechanical unit in the path', async () => {
    await withServer(() => ({ status: 200, body: ikAnswer() }), async (c, requests) => {
      await c.calcJointsFromCartesian(POSE_30, JOINTS_30, 'ROB 2');
      expect(requests[0].url).toBe('/rw/motionsystem/mechunits/ROB%202/joints-from-cartesian');
    });
  });
});
