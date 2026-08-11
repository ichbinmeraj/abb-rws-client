/**
 * Motion-system domain path table (`/rw/motionsystem`).
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 *
 * DOMAIN-WIDE FACTS
 * -----------------
 *   - `{mechunit}` encoding was inconsistent across the old call sites (some
 *     RwsClient2 reads encoded it, most inline paths did not). buildPath now
 *     URL-encodes every placeholder uniformly, so the table settles it.
 *   - Naming style is not uniform inside RWS 2.0 itself: the root resources
 *     spell out `collisionprediction` / `collisionavoidance` / `nonmotionexecution`
 *     / `checkchangecount`, but the per-mechunit collision resource is both
 *     abbreviated and hyphenated (`coll-pred-model`). Carried verbatim.
 *   - No motion subscription resources exist - WsSubscriber holds none for this
 *     domain (`coldetstate` is the panel domain), so nothing is skipped here.
 */

import type { DomainTable } from './PathSpec.js';

export const MOTION: DomainTable = {
  // ── Joint / Cartesian reads ───────────────────────────────────────────────
  getJointPositions: {
    summary: 'Read the current joint target of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/jointtarget' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/jointtarget' },
    note: '1.0 mapper URL-encodes mechunit; 2.0 inline did not (buildPath now encodes both).',
  },
  getRobTarget: {
    summary: 'Read the current cartesian robtarget of a mechanical unit.',
    // tool/wobj are read-side query params (?tool={tool}&wobj={wobj}); they
    // select the frame the pose is expressed in, so they stay out of the path.
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/robtarget' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/robtarget' },
    note: 'read-side query params tool & wobj. 1.0 public method is getCartesianPosition; adapter aliases it to getRobTarget for parity.',
  },
  getCartesianFull: {
    summary: 'Read the full cartesian pose plus configuration of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/cartesian' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/cartesian' },
    note: '2.0 state class ms-mechunit-cartesian; cf1/cf4/cf6/cfx map to j1/j4/j6/jx.',
  },

  // ── Mechunits & active tool / wobj / payload ──────────────────────────────
  listMechunits: {
    summary: 'List the mechanical units of the motion system.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits' },
    note: "1.0 falls back to ['ROB_1'] on empty parse.",
  },
  getMechunitInfo: {
    summary: 'Read a mechanical unit resource (type, mode, active tool/wobj/payload).',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: 'shared path - one URL backs 4 reads: info, active tool, active wobj, active payload.',
  },
  getActiveTool: {
    summary: 'Read the active tool of a mechanical unit (tool-name attribute).',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: 'same URL as getMechunitInfo; reads the tool-name attribute.',
  },
  getActiveWobj: {
    summary: 'Read the active work object of a mechanical unit (wobj-name attribute).',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: 'same URL as getMechunitInfo; reads the wobj-name attribute.',
  },
  getActivePayload: {
    summary: 'Read the active payload of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: 'same URL as getMechunitInfo; reads total-payload-name / payload-name.',
  },
  setActiveTool: {
    summary: 'Set the active tool of a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', fields: ['tool'] },
    rws1: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', action: 'set', fields: ['tool'] },
    note: '2.0 plain POST vs 1.0 ?action=set; 1.0 also acquires+releases motion mastership internally, 2.0 does not.',
  },
  setActiveWobj: {
    summary: 'Set the active work object of a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', fields: ['wobj'] },
    rws1: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', action: 'set', fields: ['wobj'] },
    note: 'same split as setActiveTool: 2.0 plain POST, 1.0 ?action=set with internal mastership.',
  },

  // ── Base frame ────────────────────────────────────────────────────────────
  getMechunitBaseFrame: {
    summary: 'Read the base frame of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/baseframe' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/baseframe' },
    note: '2.0 state class is ms-mechunit-baseframe (not ms-baseframe).',
  },
  setMechunitBaseFrame: {
    summary: 'Set the base frame of a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/baseframe', fields: ['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4'] },
    note: 'RWS 2.0 only.',
  },

  // ── Axes ──────────────────────────────────────────────────────────────────
  getMechunitAxes: {
    summary: 'Read the axis status of a mechanical unit.',
    // Fan-out: one GET on /axes, then one GET per axis on .../axes/{axis}. Only
    // the collection path lives here; the per-axis leaf is documented, not keyed.
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/axes' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/axes' },
    note: 'fan-out of 1 + N requests, per-axis leaf GET .../axes/{axis}; 2.0 per-axis classes ms-mechunit-axisstatus / ms-mechunit-logicalaxis.',
  },
  getAxisPose: {
    summary: 'Read the pose of a single axis of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/axes/{axis}/pose' },
    note: 'RWS 2.0 only. axis is 1-based (unlike the zero-based robotnumber on collision-prediction).',
  },
  getMechunitPjoints: {
    summary: 'Read the parallel-joint (pjoints) values of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/pjoints' },
    note: 'RWS 2.0 only.',
  },

  // ── Teleport (VC only) ────────────────────────────────────────────────────
  teleportMechunit: {
    summary: 'Jump a mechanical unit to a joint position (VC only).',
    // Raw body rob_joint=[...]&ext_joint=[...] - BOTH keys required even for a
    // 6-axis robot with no external axes.
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/position', fields: ['rob_joint', 'ext_joint'] },
    note: '2.0 VC-only (real hardware / RW6 -> 404); 403 while an opmode change is pending. Both body keys required.',
  },

  // ── Jogging ───────────────────────────────────────────────────────────────
  jog: {
    summary: 'Jog a mechanical unit.',
    // Entirely different shape per generation: 2.0 has a /jog subresource, 1.0
    // is a query-action on the root. Content-type carries ;v=2.0 on 2.0.
    rws2: { method: 'POST', path: '/rw/motionsystem/jog', fields: ['jogmode', 'mechunit', 'axis1', 'axis2', 'axis3', 'axis4', 'axis5', 'axis6', 'cjogspeed', 'ccount'] },
    rws1: { method: 'POST', path: '/rw/motionsystem', action: 'jog', fields: ['jogmode', 'mechunit', 'axis1', 'axis2', 'axis3', 'axis4', 'axis5', 'axis6', 'cjogspeed', 'ccount'] },
    note: 'path differs entirely (2.0 /jog subresource vs 1.0 ?action=jog). Both need a monotonic ccount; each generation keeps its own private counter. 1.0 goes through a private Digest POST outside the shared session.',
  },
  setMechunitForJogging: {
    summary: 'Select the mechanical unit that subsequent jog calls act on.',
    rws1: { method: 'POST', path: '/rw/motionsystem', action: 'set-mechunit', fields: ['mechunit'] },
    note: 'RWS 1.0 only.',
  },
  setRobtargetForJogging: {
    summary: 'Set the target robtarget used by cartesian jogging.',
    rws1: { method: 'POST', path: '/rw/motionsystem', action: 'set-target', fields: ['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4'] },
    note: 'RWS 1.0 only.',
  },

  // ── Change count ──────────────────────────────────────────────────────────
  getMotionChangeCount: {
    summary: 'Read the motion-system change counter.',
    // 2.0 selects it via a read-side ?resource=change-count query; 1.0 reads the
    // change-count attribute off the bare root resource.
    rws2: { method: 'GET', path: '/rw/motionsystem' },
    rws1: { method: 'GET', path: '/rw/motionsystem' },
    note: '2.0 uses ?resource=change-count selector; 1.0 reads change-count off the root resource.',
  },
  checkMotionChangeCount: {
    summary: 'Check whether a known change count is still current.',
    rws2: { method: 'GET', path: '/rw/motionsystem/checkchangecount/{changecount}' },
    // RWS 1.0 uses the same static segment but the count as a ?changecount= query.
    // Live-verified on IRC5 RW6.16 (2026-08-11): 200, span class=changestate.
    rws1: { method: 'GET', path: '/rw/motionsystem/checkchangecount' },
    note: 'RWS 2.0 count is a path segment /checkchangecount/{n}; RWS 1.0 is /checkchangecount?changecount={n}.',
  },

  // ── Error / execution state ───────────────────────────────────────────────
  getMotionErrorState: {
    summary: 'Read the motion error state.',
    rws2: { method: 'GET', path: '/rw/motionsystem/errorstate' },
    rws1: { method: 'GET', path: '/rw/motionsystem/errorstate' },
  },
  getNonMotionExecution: {
    summary: 'Read the non-motion (dry-run) execution mode.',
    rws2: { method: 'GET', path: '/rw/motionsystem/nonmotionexecution' },
    rws1: { method: 'GET', path: '/rw/motionsystem/nonmotionexecution' },
    note: '2.0 span mode comes back quoted ("ON").',
  },
  setNonMotionExecution: {
    summary: 'Set the non-motion (dry-run) execution mode.',
    rws2: { method: 'POST', path: '/rw/motionsystem/nonmotionexecution', fields: ['mode'] },
    rws1: { method: 'POST', path: '/rw/motionsystem/nonmotionexecution', action: 'set', fields: ['mode'] },
    note: 'classic plain-POST (2.0) vs ?action=set (1.0) split; body mode = ON|OFF.',
  },

  // ── Collision prediction ──────────────────────────────────────────────────
  getCollisionPredictionMode: {
    summary: 'Read whether collision prediction is enabled.',
    rws2: { method: 'GET', path: '/rw/motionsystem/collisionprediction' },
    note: 'RWS 2.0 only; reads bool collision-prediction-mode-enabled, mapped to ON/OFF.',
  },
  setCollisionPredictionMode: {
    summary: 'Enable or disable collision prediction.',
    rws2: { method: 'POST', path: '/rw/motionsystem/collisionprediction', fields: ['mode'] },
    note: 'RWS 2.0 only; write takes a mode string while read returns a boolean span - asymmetric.',
  },
  getCollisionPredictionModelName: {
    summary: 'Read the collision-prediction model name for a robot.',
    // robotnumber is a read-side query param, REQUIRED, and ZERO-based - a
    // missing or 1-based value is a 400 (live-verified RW8.1.1).
    rws2: { method: 'GET', path: '/rw/motionsystem/collisionprediction/modelname' },
    note: 'RWS 2.0 only; ?robotnumber= query REQUIRED and ZERO-based (400 otherwise), unlike the 1-based /axes/{axis}.',
  },
  getCollisionPredictionModel: {
    summary: 'Read the collision-prediction model for a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/coll-pred-model' },
    note: 'RWS 2.0 only; per-mechunit variant abbreviates+hyphenates (coll-pred-model) while the root spells collisionprediction.',
  },

  // ── Collision avoidance ───────────────────────────────────────────────────
  saveCollisionAvoidanceSnapshot: {
    summary: 'Save a collision-avoidance snapshot to file.',
    rws2: { method: 'POST', path: '/rw/motionsystem/collisionavoidance/snapshot', fields: ['filepath', 'motiongroup'] },
    note: 'RWS 2.0 only; built-not-run - option-gated the same as loadconfig.',
  },
  loadCollisionAvoidanceConfig: {
    summary: 'Load the collision-avoidance configuration.',
    rws2: { method: 'POST', path: '/rw/motionsystem/collisionavoidance/loadconfig' },
    note: 'RWS 2.0 only; empty body. 403 "Option is missing" (icode -7301) without the Collision Avoidance option.',
  },

  // ── Motion / path supervision ─────────────────────────────────────────────
  getMotionSupervision: {
    summary: 'Read the motion-supervision state of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/motionsupervision' },
    note: 'RWS 2.0 only.',
  },
  setMotionSupervisionMode: {
    summary: 'Enable or disable motion supervision for a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/motionsupervision/mode', fields: ['mode'] },
    note: 'RWS 2.0 only; one of only 3 motion paths already living in a mapper.',
  },
  setMotionSupervisionSensitivity: {
    summary: 'Set the motion-supervision sensitivity for a mechanical unit.',
    // Path segment is /level but the body field is `sensitivity` - the two
    // intentionally disagree (OPTIONS-verified).
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/motionsupervision/level', fields: ['sensitivity'] },
    note: 'RWS 2.0 only; path segment says level but the body field is sensitivity (OPTIONS-verified).',
  },
  getPathSupervision: {
    summary: 'Read the path-supervision state of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/pathsupervision' },
    note: 'RWS 2.0 only.',
  },
  setPathSupervisionMode: {
    summary: 'Enable or disable path supervision for a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/pathsupervision/mode', fields: ['mode'] },
    note: 'RWS 2.0 only.',
  },

  // ── Kinematics (IK / FK) ──────────────────────────────────────────────────
  calcJointsFromCartesian: {
    summary: 'Inverse kinematics: compute joint values for a cartesian pose.',
    // 2.0 moved IK to the /joints-from-cartesian subresource; 1.0 kept the
    // CamelCase query-action. 1.0 rides a private Digest POST outside the
    // shared session. Content-type carries ;v=2.0 on 2.0.
    rws2: {
      method: 'POST',
      path: '/rw/motionsystem/mechunits/{mechunit}/joints-from-cartesian',
      fields: ['curr_position', 'curr_orientation', 'curr_ext_joints', 'old_rob_joints', 'old_ext_joints', 'robot_fixed_object', 'tool_frame_position', 'tool_frame_orientation', 'wobj_frame_position', 'wobj_frame_orientation', 'robot_configuration', 'elog_at_error'],
    },
    rws1: {
      method: 'POST',
      path: '/rw/motionsystem/mechunits/{mechunit}',
      action: 'CalcJointsFromPose',
      fields: ['curr_position', 'curr_orientation', 'curr_ext_joints', 'old_rob_joints', 'old_ext_joints', 'robot_fixed_object', 'tool_frame_position', 'tool_frame_orientation', 'wobj_frame_position', 'wobj_frame_orientation', 'robot_configuration', 'elog_at_error'],
    },
    note: '2.0 renamed to a subresource; 1.0 kept the CamelCase ?action=CalcJointsFromPose and rides a private Digest POST. Always fails on VCs without PC Interface 616-1 (known limitation).',
  },
  calcCartesianFromJoints: {
    summary: 'Forward kinematics: compute a cartesian pose from joint values.',
    // FK is the ONE motion path where RWS 2.0 still uses a CamelCase ?action=
    // query - IK got a subresource, FK did not.
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', action: 'CalcRobTFromJoints', fields: ['curr_joints', 'curr_ext_joints', 'tool', 'wobj'] },
    rws1: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', action: 'CalcRobTFromJoints', fields: ['curr_joints', 'curr_ext_joints', 'tool', 'wobj'] },
    note: 'the ONE motion op where 2.0 still uses a CamelCase ?action= query. 2.0 may return HTTP 200 with an embedded rel="error" retcode link instead of a status code. Always fails on VCs without PC Interface 616-1 (known limitation).',
  },
};
