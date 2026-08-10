import { MOTION } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { RwsError, type CartesianFull, type JointTarget, type RobTarget } from '../types.js';
import { parse } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

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

    /** Motion (jog) supervision state of a mechunit: enabled + sensitivity level.
     *  Live-verified 2026-08-04 (RW7.21), class ms-motionsupervision. */
    async getMotionSupervision(mechunit = 'ROB_1'): Promise<{ enabled: boolean; level: number }> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getMotionSupervision.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-motionsupervision');
      return { enabled: (d['mode-enabled'] ?? '').toUpperCase() === 'TRUE', level: Number(d['level'] ?? 0) };
    }

    /** Path supervision state of a mechunit: mode + level. Live-verified
     *  2026-08-04 (RW7.21), class ms-pathsupervision. */
    async getPathSupervision(mechunit = 'ROB_1'): Promise<{ mode: string; level: number }> {
      const p = parse(await this.req(
        'GET', buildPath(MOTION.getPathSupervision.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-pathsupervision');
      return { mode: d['mode'] ?? 'unknown', level: Number(d['level'] ?? 0) };
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

    /** Set motion (jog) supervision mode (e.g. 'on' | 'off'). Acquires motion mastership. */
    async setMotionSupervisionMode(mode: string, mechunit = 'ROB_1'): Promise<void> {
      await this.requestMastership('motion');
      try { const { path, body } = R2.setMotionSupervisionMode(mechunit, mode); await this.req('POST', path, body); }
      finally { await this.releaseMastership('motion').catch(() => {}); }
    }

    /** Set motion supervision sensitivity. The controller's form field is
     *  `sensitivity`, not `level` (despite the endpoint name). Acquires motion mastership. */
    async setMotionSupervisionSensitivity(sensitivity: number, mechunit = 'ROB_1'): Promise<void> {
      await this.requestMastership('motion');
      try { const { path, body } = R2.setMotionSupervisionSensitivity(mechunit, sensitivity); await this.req('POST', path, body); }
      finally { await this.releaseMastership('motion').catch(() => {}); }
    }

    /** Set path supervision mode (e.g. 'ON' | 'OFF'). Acquires motion mastership. */
    async setPathSupervisionMode(mode: string, mechunit = 'ROB_1'): Promise<void> {
      await this.requestMastership('motion');
      try { const { path, body } = R2.setPathSupervisionMode(mechunit, mode); await this.req('POST', path, body); }
      finally { await this.releaseMastership('motion').catch(() => {}); }
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

    async setActiveTool(mechunit: string, toolName: string): Promise<void> {
      await this.req('POST', buildPath(MOTION.setActiveTool.rws2 as PathSpec, { mechunit }), { 'tool': toolName });
    }

    async setActiveWobj(mechunit: string, wobjName: string): Promise<void> {
      await this.req('POST', buildPath(MOTION.setActiveWobj.rws2 as PathSpec, { mechunit }), { 'wobj': wobjName });
    }

    /**
     * Forward kinematics: compute Cartesian pose from joint angles.
     * Mirror of `calcJointsFromCartesian()` (which is inverse kinematics).
     *
     * Note: like IK, virtual controllers without the PC Interface (616-1) option
     * generally reject this - the response comes back HTTP 200 but the body
     * contains a retcode error link instead of the result. Real hardware with
     * PC Interface licensed returns a valid pose.
     */
    async calcCartesianFromJoints(
      joints: JointTarget,
      mechunit = 'ROB_1',
      tool = 'tool0',
      wobj = 'wobj0',
    ): Promise<RobTarget> {
      const body = new URLSearchParams({
        curr_joints: `[${joints.rax_1},${joints.rax_2},${joints.rax_3},${joints.rax_4},${joints.rax_5},${joints.rax_6}]`,
        curr_ext_joints: '[9E9,9E9,9E9,9E9,9E9,9E9]',
        tool, wobj,
      }).toString();
      const xhtml = await this.req('POST', buildPath(MOTION.calcCartesianFromJoints.rws2 as PathSpec, { mechunit }), undefined, body);
      const p = parse(xhtml);
      if (p.getError()) {
        throw new RwsError(`FK rejected: ${p.getError()?.msg ?? 'unknown'} (likely missing PC Interface 616-1 license)`, 'UNSUPPORTED_OPERATION');
      }
      // RWS 2.0 sometimes returns HTTP 200 with the error embedded as
      // `<a href="…/retcode?code=N" rel="error"/>` - no <span class="code"> block.
      // Match either attribute order (href-first or rel-first).
      const errLink = xhtml.match(/<a [^>]*retcode\?code=(-?\d+)[^>]*rel="error"|<a [^>]*rel="error"[^>]*retcode\?code=(-?\d+)/);
      if (errLink) {
        const code = errLink[1] ?? errLink[2];
        throw new RwsError(`FK rejected: controller return code ${code} (likely missing PC Interface 616-1 license, or pose unreachable)`, 'UNSUPPORTED_OPERATION');
      }
      const d = p.getState('ms-robtarget') || p.getState('ms-cartesian');
      const x = +d['x'];
      if (Number.isNaN(x)) {
        throw new RwsError(`FK returned no valid pose data (response had no <li class="ms-robtarget|ms-cartesian">; check controller logs)`, 'PARSE_ERROR');
      }
      return {
        x, y: +d['y'], z: +d['z'],
        q1: +d['q1'], q2: +d['q2'], q3: +d['q3'], q4: +d['q4'],
      };
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
     *  object on every controller (fixed 2026-08). */
    async getMechunitPjoints(mechunit = 'ROB_1'): Promise<Record<string, number>> {
      const p = parse(await this.req('GET', buildPath(MOTION.getMechunitPjoints.rws2 as PathSpec, { mechunit })));
      const d = p.getState('ms-mechunit-pjoints');
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(d)) { if (!k.startsWith('_')) { out[k] = +v; } }
      return out;
    }

    async getMechunitInfo(mechunit = 'ROB_1'): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(MOTION.getMechunitInfo.rws2 as PathSpec, { mechunit })));
      return p.getState('ms-mechunit');
    }

    async jog(params: {
      mode: 'Joint' | 'Cartesian';
      axes: [number, number, number, number, number, number];
      speed: number;
      mechunit?: string;
    }): Promise<void> {
      const { mode, axes, speed } = params;
      const mechunit = params.mechunit ?? 'ROB_1';
      this.jogCcount++;

      const body = [
        `jogmode=${mode}`,
        `mechunit=${mechunit}`,
        ...axes.map((v, i) => `axis${i + 1}=${v}`),
        `cjogspeed=${speed}`,
        `ccount=${this.jogCcount}`,
      ].join('&');

      await this.req(
        'POST',
        buildPath(MOTION.jog.rws2 as PathSpec),
        undefined,
        body,
        'application/x-www-form-urlencoded;v=2.0',
      );
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

    async setNonMotionExecution(enabled: boolean): Promise<void> {
      await this.req('POST', buildPath(MOTION.setNonMotionExecution.rws2 as PathSpec), { mode: enabled ? 'ON' : 'OFF' });
    }

    async getCollisionPredictionMode(): Promise<string> {
      // Live-verified: class="ms-collision-prediction-mode" with span "collision-prediction-mode-enabled"
      // returning "true" / "false". Map back to ON/OFF for caller convenience.
      const p = parse(await this.req('GET', buildPath(MOTION.getCollisionPredictionMode.rws2 as PathSpec)));
      const enabled = p.get('collision-prediction-mode-enabled') ?? p.get('mode') ?? 'false';
      return enabled.toLowerCase() === 'true' ? 'ON' : 'OFF';
    }

    async setCollisionPredictionMode(mode: string): Promise<void> {
      await this.req('POST', buildPath(MOTION.setCollisionPredictionMode.rws2 as PathSpec), { mode });
    }

    async calcJointsFromCartesian(
      pos: RobTarget,
      seedJoints?: JointTarget,
      mechunit = 'ROB_1',
    ): Promise<JointTarget> {
      const seed = seedJoints
        ? `[${seedJoints.rax_1},${seedJoints.rax_2},${seedJoints.rax_3},${seedJoints.rax_4},${seedJoints.rax_5},${seedJoints.rax_6}]`
        : '[0,0,0,0,0,0]';

      const bodyStr = [
        `curr_position=[${pos.x},${pos.y},${pos.z}]`,
        `curr_orientation=[${pos.q1},${pos.q2},${pos.q3},${pos.q4}]`,
        `curr_ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]`,
        `old_rob_joints=${seed}`,
        `old_ext_joints=[9E9,9E9,9E9,9E9,9E9,9E9]`,
        `robot_fixed_object=false`,
        `tool_frame_position=[0,0,0]`,
        `tool_frame_orientation=[1,0,0,0]`,
        `wobj_frame_position=[0,0,0]`,
        `wobj_frame_orientation=[1,0,0,0]`,
        `robot_configuration=[0,0,0,0]`,
        `elog_at_error=false`,
      ].join('&');

      const html = await this.req(
        'POST',
        buildPath(MOTION.calcJointsFromCartesian.rws2 as PathSpec, { mechunit }),
        undefined,
        bodyStr,
        'application/x-www-form-urlencoded;v=2.0',
      );
      const p = parse(html);
      const d = p.getState('ms-jointtarget');
      if (!d['rax_1']) { throw new RwsError('IK: no joint values in response', 'PARSE_ERROR'); }
      return {
        rax_1: +d['rax_1'], rax_2: +d['rax_2'], rax_3: +d['rax_3'],
        rax_4: +d['rax_4'], rax_5: +d['rax_5'], rax_6: +d['rax_6'],
      };
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
     * real endpoint, not a client bug - it surfaces as `RwsError` GRANT_DENIED.
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
  getCartesianFull(mechunit?: string): Promise<CartesianFull>;
  listMechunits(): Promise<string[]>;
  getMotionSupervision(mechunit?: string): Promise<{ enabled: boolean; level: number }>;
  getPathSupervision(mechunit?: string): Promise<{ mode: string; level: number }>;
  getCollisionPredictionModel(mechunit?: string): Promise<Record<string, string>>;
  getAxisPose(mechunit: string, axis: number): Promise<RobTarget>;
  checkMotionChangeCount(changecount: number): Promise<boolean>;
  setMotionSupervisionMode(mode: string, mechunit?: string): Promise<void>;
  setMotionSupervisionSensitivity(sensitivity: number, mechunit?: string): Promise<void>;
  setPathSupervisionMode(mode: string, mechunit?: string): Promise<void>;
  getActiveTool(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  getActiveWobj(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  getActivePayload(mechunit?: string): Promise<{ name: string; data?: Record<string, string> }>;
  setActiveTool(mechunit: string, toolName: string): Promise<void>;
  setActiveWobj(mechunit: string, wobjName: string): Promise<void>;
  calcCartesianFromJoints(joints: JointTarget, mechunit?: string, tool?: string, wobj?: string): Promise<RobTarget>;
  getMechunitBaseFrame(mechunit?: string): Promise<{ x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }>;
  setMechunitBaseFrame(mechunit: string, frame: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number }): Promise<void>;
  getMechunitAxes(mechunit?: string): Promise<Array<Record<string, string>>>;
  getMechunitPjoints(mechunit?: string): Promise<Record<string, number>>;
  getMechunitInfo(mechunit?: string): Promise<Record<string, string>>;
  jog(params: {
    mode: 'Joint' | 'Cartesian';
    axes: [number, number, number, number, number, number];
    speed: number;
    mechunit?: string;
  }): Promise<void>;
  getMotionChangeCount(): Promise<number>;
  getMotionErrorState(): Promise<{ state: string; details?: Record<string, string> }>;
  getNonMotionExecution(): Promise<boolean>;
  setNonMotionExecution(enabled: boolean): Promise<void>;
  getCollisionPredictionMode(): Promise<string>;
  setCollisionPredictionMode(mode: string): Promise<void>;
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
