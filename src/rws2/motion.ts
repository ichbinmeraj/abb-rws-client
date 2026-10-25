import { MOTION } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import {
  RwsError, type CartesianFull, type JogParams, type JointTarget, type JointTargetFull, type LeadThroughState,
  type MechunitMotorCalib, type MotionSupervisionState, type PathSupervisionState, type RobTarget,
} from '../types.js';
import {
  leadThroughFrom, mechunitName, motionSupervisionFrom, motorCalibFrom, pathSupervisionFrom, smbDataFrom,
} from '../commonReads.js';
import { asJogPostError, checkJog, checkJogUnit, jogBody, jogChangeCount, jogUnitToSelect, rws2JogUnitSegment } from '../jog.js';
import { toJointTargetFull } from '../mechunit.js';
import { codeForControllerCode } from '../ControllerError.js';
import { hexCode, REFUSAL_CODES } from '../refusal.js';
import { parse } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

// ── Kinematics helpers (RWS 2.0) ─────────────────────────────────────────────
//
// ABB's RWS 2.0 kinematics resources work in SI units: metres and radians in
// and out ("The API supports SI units only", ABB's joints-from-cartesian and
// joints-from-pose pages). The pose-from-joints page states no unit, and its
// sample request and answer are on a millimetre scale (Rev L, spec check
// 2026-10-07); the metres come from the controller, where the forward
// solution matches the cartesian read within 1 mm only after a x1000 (RW
// 7.21.4 and 8.2.1, 2026-09-30). The public methods keep the units of the
// jointtarget and cartesian reads, degrees and millimetres, and convert here.

const DEG_PER_RAD = 180 / Math.PI;

/**
 * ABB's token for the motion-supervision and collision-prediction `mode`
 * field: `'true'` or `'false'` (Motion_System.yaml Rev L). Accepts a boolean,
 * 'true'/'false' and 'on'/'off' in any case, so callers that read the
 * 'ON'/'OFF' of `getCollisionPredictionMode` can write it back.
 * @throws RwsError `INVALID_ARGUMENT` for anything else, before sending.
 */
function supervisionToken(mode: boolean | string, who: string): 'true' | 'false' {
  if (mode === true) { return 'true'; }
  if (mode === false) { return 'false'; }
  const m = String(mode).trim().toLowerCase();
  if (m === 'true' || m === 'on') { return 'true'; }
  if (m === 'false' || m === 'off') { return 'false'; }
  throw new RwsError(`RWS2 ${who}: mode must be true/false (or 'on'/'off'), got '${String(mode)}'`, 'INVALID_ARGUMENT');
}

/** Six external axes sent as absent. */
const EXT_ABSENT = '[9E9,9E9,9E9,9E9,9E9,9E9]';

/** The form content type the kinematics POSTs carry. */
const FORM_V2 = 'application/x-www-form-urlencoded;v=2.0';

/**
 * A number as a plain decimal with at most 9 decimals, never in exponent
 * form: kinematics bodies carry metres, radians and quaternions, where 9
 * decimals is a nanometre and a nanoradian.
 */
function plainNumber(v: number): string {
  const s = v.toFixed(9).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** `v` rounded to 6 decimals; NaN and infinities pass through, -0 becomes 0. */
function roundMicro(v: number): number {
  if (!Number.isFinite(v)) { return v; }
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

/** Six joint angles in degrees as the radians list a kinematics body carries. */
function jointsInRadians(j: JointTarget): string {
  return [j.rax_1, j.rax_2, j.rax_3, j.rax_4, j.rax_5, j.rax_6].map(d => plainNumber(d / DEG_PER_RAD)).join(',');
}

/** The first of `keys` present in `s` as a number; NaN when none is. */
function numField(s: Record<string, string>, ...keys: string[]): number {
  for (const k of keys) {
    const v = s[k];
    if (v !== undefined && v.trim() !== '') { return Number(v); }
  }
  return NaN;
}

/** The first entry of any of `classes` that carries fields; null when none does. */
function firstState(body: string, classes: string[]): Record<string, string> | null {
  const p = parse(body);
  for (const c of classes) {
    const d = p.getState(c);
    if (Object.keys(d).length > 0) { return d; }
  }
  return null;
}

/**
 * An error the controller put in a 200 answer instead of a result: a status
 * block, or a `rel="error"` link to `/rw/retcode?code=N` (either attribute
 * order). Typed by the controller code's meaning (`UNKNOWN` for a code this
 * client does not map), with the code kept. Null when the answer holds none.
 */
function embeddedError(what: string, path: string, body: string): RwsError | null {
  const block = parse(body).getError();
  const link = body.match(/<a [^>]*retcode\?code=(-?\d+)[^>]*rel="error"|<a [^>]*rel="error"[^>]*retcode\?code=(-?\d+)/);
  const raw = block?.code ?? link?.[1] ?? link?.[2];
  if (raw === undefined) { return null; }
  const code = Number(raw);
  const known = REFUSAL_CODES.get(code);
  const msg = block?.msg ? block.msg.trim() : '';
  return new RwsError(
    `${what} refused: HTTP 200 from POST ${path.split('?')[0]}, controller code ${code} (${hexCode(code)}${known ? `, ${known.name}` : ''})${msg ? `: ${msg}` : ''}`,
    codeForControllerCode(code) ?? known?.code ?? 'UNKNOWN', 200, body, code, msg || undefined,
  );
}

/**
 * Both RobotWare 7 mastership domains, `edit` (named `rapid` here) and
 * `motion`; on RobotWare 8 both are the one control-station write access.
 * Held where ABB's RWS pages ask for mastership on all domains, or ask for
 * mastership without naming the domain: holding both covers whichever one
 * the controller checks.
 */
const EVERY_DOMAIN = ['rapid', 'motion'] as const;

/**
 * Motion domain (`/rw/motionsystem`): positions, mechunits, jogging, tools/wobjs, supervision, kinematics.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function motionOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    async getJointPositions(mechunit = 'ROB_1'): Promise<JointTarget> {
      const p = parse(await this.req('GET', buildPath(MOTION.getJointPositions.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-jointtarget');
      return {
        rax_1: +d['rax_1'], rax_2: +d['rax_2'], rax_3: +d['rax_3'],
        rax_4: +d['rax_4'], rax_5: +d['rax_5'], rax_6: +d['rax_6'],
      };
    }

    /**
     * Every axis slot of a mechanical unit: `rax_1..rax_6` AND `eax_a..eax_f`
     * (`getJointPositions` keeps only the robot half). Same resource, one GET.
     * The twelve fields were live-read on an RW 7.21 VC (hal+json,
     * 2026-09-23); unused external slots read 0 there, not 9E9 - see
     * `JointTargetFull`. Throws PARSE_ERROR when a robot field is missing.
     */
    async getJointTargetFull(mechunit = 'ROB_1'): Promise<JointTargetFull> {
      const p = parse(await this.req('GET', buildPath(MOTION.getJointTargetFull.rws2 as PathSpec, { mechunit })));
      return toJointTargetFull(p.getState('ms-jointtarget'), `jointtarget of ${mechunit}`);
    }

    async getCartesianFull(mechunit = 'ROB_1'): Promise<CartesianFull> {
      const p = parse(await this.req('GET', buildPath(MOTION.getCartesianFull.rws2 as PathSpec, { mechunit })));
      // Live: cf1/cf4/cf6/cfx in RWS 2.0 map to j1/j4/j6/jx in CartesianFull type
      const d = p.getState('ms-mechunit-cartesian');
      return {
        x: +d['x'], y: +d['y'], z: +d['z'],
        q1: +d['q1'], q2: +d['q2'], q3: +d['q3'], q4: +d['q4'],
        j1: +d['cf1'], j4: +d['cf4'], j6: +d['cf6'], jx: +d['cfx'],
      };
    }

    async listMechunits(): Promise<string[]> {
      const p = parse(await this.req('GET', buildPath(MOTION.listMechunits.rws2 as PathSpec)));
      // Live: <li class="ms-mechunit-li" title="ROB_1">
      return p.getAllStates('ms-mechunit-li')
        .map(m => m['_title'])
        .filter(Boolean) as string[];
    }

    /**
     * Motion (jog) supervision state of a mechunit: enabled + sensitivity level.
     * GET /rw/motionsystem/mechunits/{mechunit}/motionsupervision, ABB
     * Motion_System Rev L. Class ms-motionsupervision with `mode-enabled` and
     * `level`: live-verified 2026-08-04 (RW 7.21) and read TRUE / 100 on
     * RW 7.21.4+417 and 8.2.1+1023 (2026-09-29).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty mechunit name; `PARSE_ERROR` when the answer carries no
     *   ms-motionsupervision entry, or one without `mode-enabled` or a numeric
     *   `level` (it used to answer `{ enabled: false, level: 0 }` then);
     *   otherwise the controller's classified error.
     */
    async getMotionSupervision(mechunit = 'ROB_1'): Promise<MotionSupervisionState> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getMotionSupervision.rws2 as PathSpec, { mechunit: mechunitName(mechunit, 'getMotionSupervision') })));
      return motionSupervisionFrom(p.getAllEntries(), 'RWS2 getMotionSupervision');
    }

    /**
     * Path supervision state of a mechunit: mode + level.
     * GET /rw/motionsystem/mechunits/{mechunit}/pathsupervision, ABB
     * Motion_System Rev L "Get Path Supervision". Class ms-pathsupervision:
     * live-verified 2026-08-04 (RW 7.21), RW 8.1.1 answered ON / 100
     * (2026-09-27); linked from the mechunit on RW 7.21.4+417 and 8.2.1+1023
     * (2026-09-29).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty mechunit name; `PARSE_ERROR` when the answer carries no
     *   ms-pathsupervision entry, or one without `mode` or a numeric `level`
     *   (it used to answer `{ mode: 'unknown', level: 0 }` then); otherwise
     *   the controller's classified error.
     */
    async getPathSupervision(mechunit = 'ROB_1'): Promise<PathSupervisionState> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getPathSupervision.rws2 as PathSpec, { mechunit: mechunitName(mechunit, 'getPathSupervision') })));
      return pathSupervisionFrom(p.getAllEntries(), 'RWS2 getPathSupervision');
    }

    /**
     * The serial measurement board (SMB) data of a mechanical unit.
     * GET /rw/motionsystem/mechunits/{mechunit}/smbdata, ABB Motion_System
     * Rev L "Get SMB Data": one ms-mechunit-smbdata entry whose fields are
     * returned as the controller gives them (ABB's example: the cabinet_* and
     * sensor_memory_* serial-number parts and data statuses, where 0 =
     * SMB_VALID, 1 = SMB_VALID_NOT_EQUAL, 2 = SMB_NOT_VALID, 3 = SMB_NOT_USED,
     * plus cab_drive_module, cab_measurement_link, cab_measurement_board).
     * RW 7.21.4+417 answered that entry (statuses 2 and 3 on the virtual
     * controller); RW 8.2.1+1023 answered 404 -1073445883 "No moc data", thrown
     * as RESOURCE_NOT_FOUND (2026-10-01). Read-only: the set/clear POSTs are
     * not wrapped.
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty mechunit name; `PARSE_ERROR` when the answer carries no
     *   ms-mechunit-smbdata entry; otherwise the controller's classified error.
     */
    async getMechunitSmbData(mechunit = 'ROB_1'): Promise<Record<string, string>> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getMechunitSmbData.rws2 as PathSpec, { mechunit: mechunitName(mechunit, 'getMechunitSmbData') })));
      return smbDataFrom(p.getAllEntries(), 'RWS2 getMechunitSmbData');
    }

    /**
     * The motor calibration names of a mechanical unit, one per joint.
     * GET /rw/motionsystem/mechunits/{mechunit}/motorcalib, ABB Motion_System
     * Rev L "Get Motor Calib Names": one ms-mechunit-joint per joint, title
     * `jointN`, with `joint-name` and `calib-name` (ABB's example: rob1_1 ..
     * rob1_6 for both). Linked from the mechunit on RW 7.21.4+417 and
     * 8.2.1+1023 (2026-09-29); no answer captured yet.
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty mechunit name; `PARSE_ERROR` when the answer carries typed
     *   entries but no ms-mechunit-joint; otherwise the controller's
     *   classified error.
     */
    async getMechunitMotorCalib(mechunit = 'ROB_1'): Promise<MechunitMotorCalib[]> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getMechunitMotorCalib.rws2 as PathSpec, { mechunit: mechunitName(mechunit, 'getMechunitMotorCalib') })));
      return motorCalibFrom(p.getAllEntries(), 'RWS2 getMechunitMotorCalib');
    }

    /**
     * The compliance lead-through state of a mechanical unit.
     * GET /rw/motionsystem/mechunits/{mechunit}/lead-through, ABB Motion_System
     * Rev L "Get Compliance Lead Through": class
     * ms-mechunit-complianceleadthrough with `status` (`active` / `Inactive`).
     * RW 7.21.4+417 and 8.2.1+1023 answered `Inactive` (2026-10-01; RW 6.16.03
     * too). Read-only: the set POST (which ABB says needs Motors On) is not
     * wrapped.
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty mechunit name; `PARSE_ERROR` when the answer carries no such
     *   entry with a `status`; otherwise the controller's classified error.
     */
    async getLeadThrough(mechunit = 'ROB_1'): Promise<LeadThroughState> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getLeadThrough.rws2 as PathSpec, { mechunit: mechunitName(mechunit, 'getLeadThrough') })));
      return leadThroughFrom(p.getAllEntries(), 'RWS2 getLeadThrough');
    }

    /** Collision-prediction model of a mechunit (model file + init state).
     *  Live-verified 2026-08-04 (RW7.21), class ms-mechunit-collision-prediction-model. */
    async getCollisionPredictionModel(mechunit = 'ROB_1'): Promise<Record<string, string>> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getCollisionPredictionModel.rws2 as PathSpec, { mechunit })));
      return p.getState('ms-mechunit-collision-prediction-model');
    }

    /** Pose of one axis of a mechunit. Live-verified 2026-08-04 (RW7.21),
     *  class ms-mechunit-axispose (x/y/z + q1..q4). */
    async getAxisPose(mechunit: string, axis: number): Promise<RobTarget> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getAxisPose.rws2 as PathSpec, { mechunit, axis })));
      const d = p.getState('ms-mechunit-axispose');
      return { x: +d['x'], y: +d['y'], z: +d['z'], q1: +d['q1'], q2: +d['q2'], q3: +d['q3'], q4: +d['q4'] };
    }

    /** Whether the motion configuration changed relative to a change count
     *  previously read from getMotionChangeCount. Live-verified 2026-08-04
     *  (RW7.21), class check-changecount, span change-state. */
    async checkMotionChangeCount(changecount: number): Promise<boolean> {
      const p = parse(await this.req('GET', buildPath(MOTION.checkMotionChangeCount.rws2 as PathSpec, { changecount })));
      return (p.getState('check-changecount')['change-state'] ?? '').toUpperCase() === 'TRUE';
    }

    /** Turn motion supervision (collision detection) while jogging on or off
     *  for a mechanical unit (ABB: Jog Supervision Mode). RW 7.21.4 and the
     *  RobotWare 8 VCs refused it 403 "Collision Detection is not opted during system
     *  setup" (2026-10-11). ABB documents the form field `mode`
     *  as `true` | `false` (Motion_System.yaml Rev L); `ON`/`OFF` belongs to
     *  path supervision. A boolean, 'true'/'false' or 'on'/'off' (any case) is
     *  sent as ABB's token; the JSDoc used to say 'on' | 'off' and the string
     *  went out as given (on/off was refused on RW 7.21). Holds edit
     *  and motion mastership (RW8: write access) around the write: ABB's
     *  RobotWare 7 RWS page says "Mastership needs to be acquired on all
     *  domains" for the supervision writes.
     *  @throws RwsError `INVALID_ARGUMENT` before sending for any other value.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async setMotionSupervisionMode(mode: boolean | string, mechunit = 'ROB_1'): Promise<void> {
      const token = supervisionToken(mode, 'setMotionSupervisionMode');
      await this.withAccess(EVERY_DOMAIN, async () => {
        const { path, body } = R2.setMotionSupervisionMode(mechunit, token); await this.req('POST', path, body);
      });
    }

    /** Set motion supervision sensitivity. The controller's form field is
     *  `sensitivity`, not `level` (despite the endpoint name). Holds edit and
     *  motion mastership (RW8: write access) around the write, as
     *  setMotionSupervisionMode does.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async setMotionSupervisionSensitivity(sensitivity: number, mechunit = 'ROB_1'): Promise<void> {
      await this.withAccess(EVERY_DOMAIN, async () => {
        const { path, body } = R2.setMotionSupervisionSensitivity(mechunit, sensitivity); await this.req('POST', path, body);
      });
    }

    /** Set path supervision mode (e.g. 'ON' | 'OFF'). Holds edit and motion
     *  mastership (RW8: write access) around the write, as
     *  setMotionSupervisionMode does.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async setPathSupervisionMode(mode: string, mechunit = 'ROB_1'): Promise<void> {
      await this.withAccess(EVERY_DOMAIN, async () => {
        const { path, body } = R2.setPathSupervisionMode(mechunit, mode); await this.req('POST', path, body);
      });
    }

    async getActiveTool(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
      const p = parse(await this.req('GET', buildPath(MOTION.getActiveTool.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-mechunit');
      return { name: d['tool-name'] ?? 'tool0' };
    }

    async getActiveWobj(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
      const p = parse(await this.req('GET', buildPath(MOTION.getActiveWobj.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-mechunit');
      return { name: d['wobj-name'] ?? 'wobj0' };
    }

    async getActivePayload(mechunit = 'ROB_1'): Promise<{ name: string; data?: Record<string, string> }> {
      const p = parse(await this.req('GET', buildPath(MOTION.getActivePayload.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-mechunit');
      return { name: d['total-payload-name'] ?? d['payload-name'] ?? 'load0' };
    }

    /**
     * Set the active tool of a mechunit. Holds edit and motion mastership (RW8:
     * write access) around the write. ABB's RWS 2.0 Motion System page says
     * "Mastership is required" for this POST without naming the domain; the
     * same write on RobotWare 6 applies under motion mastership (live-verified
     * 2026-08-04 on RW 6.16). Until a live run shows which RobotWare 7 domain
     * the controller checks, both are held. ABB's RobotWare 8 page also asks
     * for a local control station, which this client never registers as.
     */
    async setActiveTool(mechunit: string, toolName: string): Promise<void> {
      await this.withAccess(EVERY_DOMAIN, () =>
        this.req('POST', buildPath(MOTION.setActiveTool.rws2 as PathSpec, { mechunit }), { 'tool': toolName }));
    }

    /** Set the active work object of a mechunit. Holds the same access as
     *  setActiveTool, for the same reason.
     */
    async setActiveWobj(mechunit: string, wobjName: string): Promise<void> {
      await this.withAccess(EVERY_DOMAIN, () =>
        this.req('POST', buildPath(MOTION.setActiveWobj.rws2 as PathSpec, { mechunit }), { 'wobj': wobjName }));
    }

    /**
     * Forward kinematics: the pose of tool0 (the flange) for the given joint
     * angles, from ABB's `POST /rw/motionsystem/mechunits/{mechunit}/pose-from-joints`.
     * Mirror of `calcJointsFromCartesian()` (inverse kinematics).
     *
     * The resource works in SI units: it takes `rob_joints` in radians and the
     * tool frame in metres, and answers `position-x/y/z` in metres with the
     * orientation in `robtargetorientation-u0..u3` (class
     * `position-from-joint`). The metres are the controller's (RW 7.21.4 and
     * 8.2.1, 2026-09-30): ABB's page states no unit and its sample is on a
     * millimetre scale (Rev L, spec check 2026-10-07). This method converts, so it
     * takes degrees and returns millimetres, the units of the jointtarget and
     * cartesian reads. External axes are sent as absent (9E9). It sends the
     * six fields ABB documents; the resource's form on RW 7.21.4 and 8.2.1
     * lists a seventh, `absolute_accuracy`, which ABB's page does not name
     * and which is not sent (an IK request without it reached the solver on
     * both builds). ABB's optional `PoseinFrameChoice` (from RW 7.16, default
     * 0, the base frame) is in neither form and is not sent.
     *
     * The resource has no work-object field and takes the tool as a frame,
     * not by name, so only `tool` 'tool0' (the identity frame) and `wobj`
     * 'wobj0' are supported; any other tool or work object is refused with
     * `INVALID_ARGUMENT` before sending, since the answer would not be in it
     * (as on RWS 1.0).
     *
     * This method used to POST `?action=CalcRobTFromJoints` on the mechunit
     * with `curr_joints` in degrees and the tool and work object by name. No
     * ABB document names that action, and on 2026-09-30 it answered HTTP 200
     * with an error link instead of a pose on RW 7.21.4 (-1073445859) and
     * RW 8.2.1 (-1073435873): the codes of a mechunit write without mastership
     * or write access, so the POST most likely landed on the mechunit's own
     * write form. On RW 6.16.03 the same action is refused as unknown, while
     * ABB's action there, in SI units, solves on a virtual controller
     * (live-verified 2026-09-30). This request follows ABB's RWS 2.0 page and
     * that RWS 1.0 result, and solves the current joints to the current pose
     * on RW 7.21.4 and 8.2.1 virtual controllers (live-verified 2026-09-30).
     *
     * An error the controller puts in a 200 answer (a `rel="error"` retcode
     * link, or a status block) is thrown typed by its code, with the code kept.
     */
    async calcCartesianFromJoints(
      joints: JointTarget,
      mechunit = 'ROB_1',
      tool = 'tool0',
      wobj = 'wobj0',
    ): Promise<RobTarget> {
      if ((tool || 'tool0').toLowerCase() !== 'tool0' || (wobj || 'wobj0').toLowerCase() !== 'wobj0') {
        throw new RwsError(
          `Forward kinematics on RWS 2.0 computes the tool0 (flange) pose only: the controller's pose-from-joints takes no work object `
            + `and no tool name, so tool '${tool}' and work object '${wobj}' cannot be applied. Pass tool0 and wobj0.`,
          'INVALID_ARGUMENT',
        );
      }
      const body = [
        'tool_frame_position=[0,0,0]',
        'tool_frame_orientation=[1,0,0,0]',
        `rob_joints=[${jointsInRadians(joints)}]`,
        `ext_joints=${EXT_ABSENT}`,
        'robot_fixed_object=FALSE',
        'elog_at_error=FALSE',
      ].join('&');
      const path = buildPath(MOTION.calcCartesianFromJoints.rws2 as PathSpec, { mechunit });
      const answer = await this.req('POST', path, undefined, body, FORM_V2);
      const refused = embeddedError('Forward kinematics', path, answer);
      if (refused) { throw refused; }
      const d = firstState(answer, ['position-from-joint']);
      if (!d) {
        throw new RwsError(`Forward kinematics: the answer from POST ${path} carried no position-from-joint entry`, 'PARSE_ERROR');
      }
      // ABB's RWS 2.0 page spells the orientation `robtargetorientation-uN`;
      // RW 6.16.03 answers `robtarget-orientation-uN`. Both are read.
      const q = (i: number): number => numField(d, `robtargetorientation-u${i}`, `robtarget-orientation-u${i}`);
      // Metres to millimetres, rounded to 1e-6 mm so the product carries no
      // binary noise (0.6889405 m would read 688.9404999999999 mm).
      const pose: RobTarget = {
        x: roundMicro(numField(d, 'position-x') * 1000),
        y: roundMicro(numField(d, 'position-y') * 1000),
        z: roundMicro(numField(d, 'position-z') * 1000),
        q1: q(0), q2: q(1), q3: q(2), q4: q(3),
      };
      if (Object.values(pose).some(v => !Number.isFinite(v))) {
        throw new RwsError('Forward kinematics: the answer has no position-x/y/z and orientation values', 'PARSE_ERROR');
      }
      return pose;
    }

    async getMechunitBaseFrame(mechunit = 'ROB_1'): Promise<{ x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }> {
      // Live-verified class: ms-mechunit-baseframe (not ms-baseframe)
      const p = parse(await this.req('GET', buildPath(MOTION.getMechunitBaseFrame.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-mechunit-baseframe') || p.getState('ms-baseframe');
      return {
        x: +d['x'], y: +d['y'], z: +d['z'],
        q1: +d['q1'], q2: +d['q2'], q3: +d['q3'], q4: +d['q4'],
      };
    }

    /** Takes no access itself; `RobotManager.setMechunitBaseFrame` holds `edit` (RobotWare 8: write access) around it. */
    async setMechunitBaseFrame(mechunit: string, frame: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void> {
      await this.req('POST', buildPath(MOTION.setMechunitBaseFrame.rws2 as PathSpec, { mechunit }), {
        x:  String(frame.x),  y:  String(frame.y),  z:  String(frame.z),
        q1: String(frame.q1), q2: String(frame.q2), q3: String(frame.q3), q4: String(frame.q4),
      });
    }

    async getMechunitAxes(mechunit = 'ROB_1'): Promise<Array<Record<string, string>>> {
      // Live-verified: /axes returns a count + sub-resource links (axes/1..N).
      // Fetch each axis individually and assemble the result.
      const p = parse(await this.req('GET', buildPath(MOTION.getMechunitAxes.rws2 as PathSpec, { mechunit })));
      const total = p.getState('ms-mechunit-axes');
      const axisCount = +(total['axes'] ?? 0);
      if (axisCount === 0) { return []; }

      const axes: Array<Record<string, string>> = [];
      for (let i = 1; i <= axisCount; i++) {
        try {
          // Each axis returns TWO state entries: ms-mechunit-axisstatus (span
          // axis-status, e.g. 'Synchronized') and ms-mechunit-logicalaxis (span
          // logical-axis). The previously parsed ms-mechunit-axis / ms-axis are
          // not emitted, so every axis came back with no fields (fixed 2026-08).
          const ap = parse(await this.req('GET', `/rw/motionsystem/mechunits/${mechunit}/axes/${i}`));
          axes.push({
            axis: String(i),
            ...ap.getState('ms-mechunit-axisstatus'),
            ...ap.getState('ms-mechunit-logicalaxis'),
          });
        } catch { axes.push({ axis: String(i), error: 'unreachable' }); }
      }
      return axes;
    }

    /** Physical joint mapping of a mechunit. Class is ms-mechunit-pjoints; the
     *  previously parsed `ms-pjoints` is never emitted, so this returned an empty
     *  object on every controller (fixed 2026-08). The RW 7.21.4 and 8.2.1
     *  virtual controllers answer j1..j6 = 0, 1, 2, 3, 4, 5 whatever the pose
     *  (2026-10-01): not joint angles there. */
    async getMechunitPjoints(mechunit = 'ROB_1'): Promise<Record<string, number>> {
      const p = parse(await this.req('GET', buildPath(MOTION.getMechunitPjoints.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-mechunit-pjoints');
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(d)) { if (!k.startsWith('_')) { out[k] = +v; } }
      return out;
    }

    /**
     * The calibration resources of a mechanical unit.
     * GET /rw/motionsystem/mechunits/{mechunit}/calib.
     *
     * ABB's Motion_System.yaml (Rev L, "Get resource urls to Calibrate
     * Mechunits") answers one ms-mechunit-calib-li entry per calibration
     * resource, its title the name and its self link the path (ABB's example:
     * `singleuserlin`, `calib/singleuserlin`). Each entry comes back as
     * `{ name, href }`. The resource is linked from the mechunit on RW
     * 7.21.4+417 and 8.2.1+1023 (2026-09-29) and not on RW 6.16.03; a RobotWare
     * 7.21.0 VC listed singleuserlin alone on 2026-05-04. Read-only: the
     * calibrations themselves are POSTs and are not wrapped.
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty mechunit name; an unknown name is thrown as the controller
     *   answers it.
     */
    async getMechunitCalib(mechunit = 'ROB_1'): Promise<Array<{ name: string; href?: string }>> {
      if (typeof mechunit !== 'string' || mechunit.trim() === '') {
        throw new RwsError('RWS2 getMechunitCalib: mechunit name is empty', 'INVALID_ARGUMENT');
      }
      const p = parse(await this.req('GET', buildPath(MOTION.getMechunitCalib.rws2 as PathSpec, { mechunit })));
      return p.getAllStates('ms-mechunit-calib-li')
        .map(d => ({ name: d['_title'] ?? '', href: d['_href'] }))
        .filter(c => c.name !== '');
    }

    async getMechunitInfo(mechunit = 'ROB_1'): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(MOTION.getMechunitInfo.rws2 as PathSpec, { mechunit })));
      return p.getState('ms-mechunit');
    }

    /**
     * One jog request as ABB's RWS 2.0 jog form lists it: `axis1`..`axis6`,
     * the controller's current change count as `ccount` (read with
     * `GET /rw/motionsystem` right before), and `inc-mode` (default `Small`).
     * `mode`, `speed` and `mechunit` are not sent (no jog form field). A named
     * `mechunit` that the controller does not have selected for jogging is
     * selected first (`setMechunitForJogging`), and the motion system is read
     * again: the jog goes out with that read's change count, and only if it
     * names the unit (INVALID_ARGUMENT otherwise, nothing jogged). Takes no
     * access for the jog itself: `RobotManager.jog` holds motion mastership
     * (RobotWare 7) or write access (RobotWare 8) around it, after its
     * pre-flight, and that hold covers the selection.
     */
    async jog(params: JogParams): Promise<void> {
      const { axes, incMode } = checkJog(params);
      // A unit name that addresses a sibling resource is refused here, before
      // the motion-system read, not only inside setMechunitForJogging.
      if (params.mechunit !== undefined) { rws2JogUnitSegment(params.mechunit, 'jog'); }
      const motionSystem = buildPath(MOTION.getMotionChangeCount.rws2 as PathSpec);
      let p = parse(await this.req('GET', motionSystem));
      let ccount = jogChangeCount(p.get('change-count'), 'GET /rw/motionsystem');
      const select = jogUnitToSelect(params.mechunit, p.get('mechunit-name'));
      if (select !== undefined) {
        await this.setMechunitForJogging(select);
        p = parse(await this.req('GET', motionSystem));
        checkJogUnit(select, p.get('mechunit-name'));
        ccount = jogChangeCount(p.get('change-count'), 'GET /rw/motionsystem after selecting the unit');
      }
      const body = jogBody(axes, ccount, incMode);

      // Only this request's answer is tagged as the jog's (asJogPostError): a
      // refused read or unit selection above keeps its own explanation.
      try {
        await this.req(
          'POST',
          buildPath(MOTION.jog.rws2 as PathSpec),
          undefined,
          body,
          'application/x-www-form-urlencoded;v=2.0',
        );
      } catch (e) {
        throw asJogPostError(e);
      }
    }

    /**
     * Select the mechanical unit that jogging acts on: `POST
     * /rw/motionsystem/{mechunit}` with no body (ABB Motion_System Rev L, "Set
     * Mechanical Unit for Jogging": the unit is case sensitive, success is
     * 204; it needs mastership in Auto, and a local client plus mastership in
     * manual mode). Holds motion mastership (RobotWare 8: write access) around
     * the write; inside `RobotManager.jog` the jog's own hold covers it and
     * nothing more is requested. The 2.0 form agrees: OPTIONS
     * /rw/motionsystem/ROB_1 on RW 7.21.4 and 8.2.1 answers a form id="set"
     * with no inputs (2026-10-07; the unit is named `mechunit-name` on `GET
     * /rw/motionsystem`). Run live only as a selection of the unit already selected:
     * RW 7.21.4 and 8.2.1 accepted `ROB_1` in Auto, and `mechunit-name` read
     * `ROB_1` before and after (2026-10-01).
     *
     * @throws RwsError `INVALID_ARGUMENT` before sending for a name that is
     *   not a RAPID name (`jogUnitName`), or one that names a sibling resource of /rw/motionsystem
     *   (jog, mechunits, errorstate, ...); otherwise the controller's
     *   classified error.
     */
    async setMechunitForJogging(mechunit: string): Promise<void> {
      const unit = rws2JogUnitSegment(mechunit, 'setMechunitForJogging');
      const path = buildPath(MOTION.setMechunitForJogging.rws2 as PathSpec, { mechunit: unit });
      await this.withAccess(['motion'], () => this.req('POST', path));
    }

    async getMotionChangeCount(): Promise<number> {
      const p = parse(await this.req('GET', `${buildPath(MOTION.getMotionChangeCount.rws2 as PathSpec)}?resource=change-count`));
      return Number(p.get('change-count') ?? 0);
    }

    async getMotionErrorState(): Promise<{ state: string; details?: Record<string, string> }> {
      const p = parse(await this.req('GET', buildPath(MOTION.getMotionErrorState.rws2 as PathSpec)));
      const d = p.getState('ms-errorstate-li') || p.getState('ms-errorstate');
      return { state: d['err-state'] ?? d['state'] ?? 'unknown', details: d };
    }

    async getNonMotionExecution(): Promise<boolean> {
      // Live-verified: class="ms-nonmotionexecution", span "mode" returns quoted "OFF" or "ON".
      const p = parse(await this.req('GET', buildPath(MOTION.getNonMotionExecution.rws2 as PathSpec)));
      const v = (p.get('mode') ?? p.get('state') ?? 'OFF').replace(/"/g, '').toUpperCase();
      return v === 'ON';
    }

    /** Switch non-motion execution on or off. Holds edit mastership (RW8: write
     *  access): ABB's RobotWare 7 RWS page says "Mastership on Motion or Edit is
     *  allowed". ABB's RobotWare 8 page also asks for a local control station.
     */
    async setNonMotionExecution(enabled: boolean): Promise<void> {
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(MOTION.setNonMotionExecution.rws2 as PathSpec), { mode: enabled ? 'ON' : 'OFF' }));
    }

    async getCollisionPredictionMode(): Promise<string> {
      // Live-verified: class="ms-collision-prediction-mode" with span "collision-prediction-mode-enabled"
      // returning "true" / "false". Map back to ON/OFF for caller convenience.
      const p = parse(await this.req('GET', buildPath(MOTION.getCollisionPredictionMode.rws2 as PathSpec)));
      const enabled = p.get('collision-prediction-mode-enabled') ?? p.get('mode') ?? 'false';
      return enabled.toLowerCase() === 'true' ? 'ON' : 'OFF';
    }

    /** Set collision prediction on or off. ABB documents the field `mode` as
     *  `true` | `false` (Rev L); a boolean, 'true'/'false' or the 'ON'/'OFF'
     *  `getCollisionPredictionMode` answers (any case) is sent as ABB's token,
     *  so a read-modify-write round trip sends what the page documents. The
     *  string used to go out as given.
     *  @throws RwsError `INVALID_ARGUMENT` before sending for any other value.
     */
    async setCollisionPredictionMode(mode: boolean | string): Promise<void> {
      const token = supervisionToken(mode, 'setCollisionPredictionMode');
      await this.req('POST', buildPath(MOTION.setCollisionPredictionMode.rws2 as PathSpec), { mode: token });
    }

    /**
     * Inverse kinematics: the joint angles that put tool0 (the flange) at
     * `pos`, the solution nearest the seed joints (all zero when none are
     * given), from ABB's `POST /rw/motionsystem/mechunits/{mechunit}/joints-from-cartesian`.
     *
     * The resource works in SI units (ABB: "The API supports SI units only"):
     * it takes `curr_position` in metres and `old_rob_joints` in radians, and
     * answers `robotjoint1..6` in radians (class `joints-from-cartesian`,
     * ABB's RWS 2.0 page). This method converts, so it takes millimetres and
     * degrees and returns degrees, the units of the cartesian and jointtarget
     * reads. The tool frame is sent as the identity, so `pos` is the tool0
     * pose; external axes are sent as absent (9E9).
     *
     * It sends the ten fields ABB documents, named without the trailing space
     * the controller's own form shows on three of them (`old_rob_joints `,
     * `old_ext_joints `, `robot_fixed_object ` on RW 7.21.4 and 8.2.1); a
     * request with the plain names reached the solver on both builds
     * (2026-09-30). The form's eleventh field, `absolute_accuracy`, is not in
     * ABB's documented request and is not sent. `joints-from-pose` takes the
     * same fields and answers the same class; this method keeps
     * `joints-from-cartesian`.
     *
     * This method used to send millimetres and degrees unconverted, plus
     * `wobj_frame_*` fields no form lists. On 2026-09-30 RW 7.21.4 and 8.2.1
     * refused the current pose that way with 400 -1073436654 "Position outside
     * of reach", exactly as RW 6.16.03 did until its client converted, after
     * which it solved the current pose to the current joints on a virtual
     * controller. This request follows ABB's RWS 2.0 page and that RWS 1.0
     * result, and solves the current pose to the current joints on RW 7.21.4
     * and 8.2.1 virtual controllers (live-verified 2026-09-30). A pose really
     * out of reach is `INVALID_ARGUMENT` with an `invalid-argument` refusal.
     */
    async calcJointsFromCartesian(
      pos: RobTarget,
      seedJoints?: JointTarget,
      mechunit = 'ROB_1',
    ): Promise<JointTarget> {
      const seed = seedJoints ? jointsInRadians(seedJoints) : '0,0,0,0,0,0';
      // In the order of the controller's form (and ABB's sample request).
      const body = [
        `curr_position=[${[pos.x, pos.y, pos.z].map(v => plainNumber(v / 1000)).join(',')}]`,
        `curr_ext_joints=${EXT_ABSENT}`,
        'tool_frame_position=[0,0,0]',
        `curr_orientation=[${[pos.q1, pos.q2, pos.q3, pos.q4].map(plainNumber).join(',')}]`,
        'tool_frame_orientation=[1,0,0,0]',
        `old_rob_joints=[${seed}]`,
        `old_ext_joints=${EXT_ABSENT}`,
        'robot_fixed_object=FALSE',
        'robot_configuration=[0,0,0,0]',
        'elog_at_error=FALSE',
      ].join('&');

      const path = buildPath(MOTION.calcJointsFromCartesian.rws2 as PathSpec, { mechunit });
      const answer = await this.req('POST', path, undefined, body, FORM_V2);
      const refused = embeddedError('Inverse kinematics', path, answer);
      if (refused) { throw refused; }
      // ABB's page shows class joints-from-cartesian for both IK resources;
      // RW 6.16.03 names its answer all-joint-solutions.
      const d = firstState(answer, ['joints-from-cartesian', 'joints-from-pose', 'all-joint-solutions']);
      if (!d) {
        throw new RwsError(`Inverse kinematics: the answer from POST ${path} carried no joints-from-cartesian entry`, 'PARSE_ERROR');
      }
      // Radians to degrees, rounded to 1e-6 degree (finer than the answer's
      // own precision) so the product carries no binary noise.
      const deg = (i: number): number => roundMicro(numField(d, `robotjoint${i}`) * DEG_PER_RAD);
      const joints: JointTarget = {
        rax_1: deg(1), rax_2: deg(2), rax_3: deg(3), rax_4: deg(4), rax_5: deg(5), rax_6: deg(6),
      };
      if (Object.values(joints).some(v => !Number.isFinite(v))) {
        throw new RwsError('Inverse kinematics: the answer has no robotjoint1..6 values', 'PARSE_ERROR');
      }
      return joints;
    }

    /**
     * Collision-prediction model name for one robot.
     * GET /rw/motionsystem/collisionprediction/modelname.
     *
     * The `robotnumber` query parameter is REQUIRED - without it the controller
     * answers 400 "robotnumber parameter is required" (live-verified 2026-08-09).
     *
     * Robot numbering is ZERO-based: on a single-robot system only `0` is valid
     * and 1, 2 and -1 all answer 400 "robotnumber parameter is invalid"
     * (live-verified 2026-08-09 on RW8.1.1). Defaults to 0 for that reason.
     */
    async getCollisionPredictionModelName(robotNumber = 0): Promise<string> {
      const p = parse(await this.req(
        'GET', `${buildPath(MOTION.getCollisionPredictionModelName.rws2 as PathSpec)}?robotnumber=${robotNumber}`,
      ));
      return p.get('modelname') ?? p.get('model-name') ?? '';
    }

    /**
     * Write a collision-avoidance snapshot to a file on the controller.
     * POST /rw/motionsystem/collisionavoidance/snapshot, form fields
     * `filepath`, `motiongroup` (live-read 2026-08-09).
     *
     * The resource exists on the VCs even without the Collision Avoidance option;
     * a controller lacking the option refuses at execution time, not at OPTIONS.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async saveCollisionAvoidanceSnapshot(filePath: string, motionGroup: string): Promise<void> {
      await this.req('POST', buildPath(MOTION.saveCollisionAvoidanceSnapshot.rws2 as PathSpec), {
        filepath: filePath, motiongroup: motionGroup,
      });
    }

    /**
     * Reload the collision-avoidance configuration.
     * POST /rw/motionsystem/collisionavoidance/loadconfig - the OPTIONS form
     * advertises `Allow: POST,OPTIONS` and NO fields (live-read 2026-08-09), so
     * this deliberately sends an empty body.
     *
     * Option-gated: both VCs answer 403 "Option is missing" (icode -7301) because
     * neither carries Collision Avoidance. That is the controller declining a
     * real endpoint, not a client bug - it surfaces as `RwsError`
     * UNSUPPORTED_OPERATION with refusal kind `option-missing`.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async loadCollisionAvoidanceConfig(): Promise<void> {
      await this.req('POST', buildPath(MOTION.loadCollisionAvoidanceConfig.rws2 as PathSpec));
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface MotionMethods {
  getJointPositions(mechunit?: string): Promise<JointTarget>;
  getJointTargetFull(mechunit?: string): Promise<JointTargetFull>;
  getCartesianFull(mechunit?: string): Promise<CartesianFull>;
  listMechunits(): Promise<string[]>;
  getMotionSupervision(mechunit?: string): Promise<MotionSupervisionState>;
  getPathSupervision(mechunit?: string): Promise<PathSupervisionState>;
  getMechunitSmbData(mechunit?: string): Promise<Record<string, string>>;
  getMechunitMotorCalib(mechunit?: string): Promise<MechunitMotorCalib[]>;
  getLeadThrough(mechunit?: string): Promise<LeadThroughState>;
  getCollisionPredictionModel(mechunit?: string): Promise<Record<string, string>>;
  getAxisPose(mechunit: string, axis: number): Promise<RobTarget>;
  checkMotionChangeCount(changecount: number): Promise<boolean>;
  setMotionSupervisionMode(mode: boolean | string, mechunit?: string): Promise<void>;
  setMotionSupervisionSensitivity(sensitivity: number, mechunit?: string): Promise<void>;
  setPathSupervisionMode(mode: string, mechunit?: string): Promise<void>;
  getActiveTool(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  getActiveWobj(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  getActivePayload(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  setActiveTool(mechunit: string, toolName: string): Promise<void>;
  setActiveWobj(mechunit: string, wobjName: string): Promise<void>;
  calcCartesianFromJoints(joints: JointTarget, mechunit?: string, tool?: string, wobj?: string): Promise<RobTarget>;
  getMechunitBaseFrame(mechunit?: string): Promise<{ x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }>;
  /** Set the base frame (x, y, z, q1..q4). Takes no access itself: `RobotManager.setMechunitBaseFrame` holds `edit` (RobotWare 8: write access) around it. */
  setMechunitBaseFrame(mechunit: string, frame: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void>;
  getMechunitAxes(mechunit?: string): Promise<Array<Record<string, string>>>;
  getMechunitPjoints(mechunit?: string): Promise<Record<string, number>>;
  getMechunitCalib(mechunit?: string): Promise<Array<{ name: string; href?: string }>>;
  getMechunitInfo(mechunit?: string): Promise<Record<string, string>>;
  jog(params: JogParams): Promise<void>;
  setMechunitForJogging(mechunit: string): Promise<void>;
  getMotionChangeCount(): Promise<number>;
  getMotionErrorState(): Promise<{ state: string; details?: Record<string, string> }>;
  getNonMotionExecution(): Promise<boolean>;
  setNonMotionExecution(enabled: boolean): Promise<void>;
  getCollisionPredictionMode(): Promise<string>;
  setCollisionPredictionMode(mode: boolean | string): Promise<void>;
  calcJointsFromCartesian(pos: RobTarget, seedJoints?: JointTarget, mechunit?: string): Promise<JointTarget>;
  getCollisionPredictionModelName(robotNumber?: number): Promise<string>;
  saveCollisionAvoidanceSnapshot(filePath: string, motionGroup: string): Promise<void>;
  loadCollisionAvoidanceConfig(): Promise<void>;
}

/** Guard: the mixin class must provide every MotionMethods member (never exported). */
type _MotionMethodsComplete = InstanceType<ReturnType<typeof motionOps>> extends MotionMethods ? true : never;
const _motionComplete: _MotionMethodsComplete = true;
void _motionComplete;

export function MotionOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<MotionMethods> {
  return motionOps(Base) as unknown as TBase & GConstructor<MotionMethods>;
}
