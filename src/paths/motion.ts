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
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read the current joint target of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/jointtarget' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/jointtarget' },
    note: '1.0 mapper URL-encodes mechunit; 2.0 inline did not (buildPath now encodes both).',
  },
  getJointTargetFull: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read every axis slot of a mechanical unit (rax_1..6 and eax_a..f).',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/jointtarget' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/jointtarget' },
    note: 'same URL as getJointPositions; also reads the eax_a..eax_f fields (read live on an RW 7.21 VC, 2026-09-23).',
  },
  getRobTarget: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read the current cartesian robtarget of a mechanical unit.',
    // tool/wobj are read-side query params (?tool={tool}&wobj={wobj}); they
    // select the frame the pose is expressed in, so they stay out of the path.
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/robtarget' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/robtarget' },
    note: 'read-side query params tool & wobj. 1.0 public method is getCartesianPosition; adapter aliases it to getRobTarget for parity.',
  },
  getCartesianFull: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read the full cartesian pose plus configuration of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/cartesian' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/cartesian' },
    note: '2.0 state class ms-mechunit-cartesian; cf1/cf4/cf6/cfx map to j1/j4/j6/jx.',
  },

  // ── Mechunits & active tool / wobj / payload ──────────────────────────────
  listMechunits: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'List the mechanical units of the motion system.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits' },
    note: "1.0 falls back to ['ROB_1'] on empty parse.",
  },
  getMechunitInfo: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read a mechanical unit resource (type, mode, active tool/wobj/payload).',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: 'shared path - one URL backs 4 reads: info, active tool, active wobj, active payload.',
  },
  getActiveTool: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the active tool of a mechanical unit (tool-name attribute).',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: 'same URL as getMechunitInfo; reads the tool-name attribute.',
  },
  getActiveWobj: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the active work object of a mechanical unit (wobj-name attribute).',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: 'same URL as getMechunitInfo; reads the wobj-name attribute.',
  },
  getActivePayload: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the active payload of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: 'same URL as getMechunitInfo; reads total-payload-name / payload-name.',
  },
  setActiveTool: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Set the active tool of a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', fields: ['tool'] },
    rws1: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', action: 'set', fields: ['tool'] },
    note: '2.0 plain POST vs 1.0 ?action=set; 1.0 also acquires+releases motion mastership internally, 2.0 does not.',
  },
  setActiveWobj: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Set the active work object of a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', fields: ['wobj'] },
    rws1: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', action: 'set', fields: ['wobj'] },
    note: 'same split as setActiveTool: 2.0 plain POST, 1.0 ?action=set with internal mastership.',
  },

  // ── Base frame ────────────────────────────────────────────────────────────
  getMechunitBaseFrame: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the base frame of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/baseframe' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/baseframe' },
    note: '2.0 state class is ms-mechunit-baseframe (not ms-baseframe).',
  },
  setMechunitBaseFrame: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Set the base frame of a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/baseframe', fields: ['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4'] },
    // RWS 1.0 Rev M "Set Base Frame": the same resource with ?action=set and
    // the same seven fields, 202.
    rws1: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/baseframe', action: 'set', fields: ['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4'] },
    note: 'same path; RWS 2.0 plain POST, RWS 1.0 ?action=set. Both answer 202. RW 6.16.03 virtual controller: the frame read from ROB_1 was written back under motion mastership, 202, and read back unchanged (2026-10-18).',
  },

  // ── Axes ──────────────────────────────────────────────────────────────────
  getMechunitAxes: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the axis status of a mechanical unit.',
    // Fan-out: one GET on /axes, then one GET per axis on .../axes/{axis}. Only
    // the collection path lives here; the per-axis leaf is documented, not keyed.
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/axes' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/axes' },
    note: 'fan-out of 1 + N requests, per-axis leaf GET .../axes/{axis}; 2.0 per-axis classes ms-mechunit-axisstatus / ms-mechunit-logicalaxis.',
  },
  getAxisPose: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the pose of a single axis of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/axes/{axis}/pose' },
    note: 'RWS 2.0 only. axis is 1-based (unlike the zero-based robotnumber on collision-prediction).',
  },
  getMechunitPjoints: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the physical-joint (pjoints) values of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/pjoints' },
    // RW 6.16.03 links it from the mechunit resource (`ROB_1/pjoints`, 2026-09-29).
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/pjoints' },
    note: 'same path on both; item class ms-mechunit-pjoints with j1..j6 (ABB RWS 2.0 Motion System page, Rev L). No 1.0 body captured yet.',
  },
  getMechunitCalib: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'List the calibration resources of a mechanical unit.',
    // ABB Motion_System.yaml Rev L "Get resource urls to Calibrate Mechunits":
    // item class ms-mechunit-calib-li, one per calibration resource (the
    // example lists singleuserlin, a POST-only resource). Linked from the
    // mechunit on RW 7.21.4+417 and 8.2.1+1023 (2026-09-29); RW 6.16.03 does
    // not link it.
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/calib' },
    note: 'RWS 2.0 only (not linked from the RW 6.16.03 mechunit). Lists links; the calibrations themselves are POSTs that are not wrapped.',
  },
  getMechunitSmbData: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the serial measurement board (SMB) data of a mechanical unit.',
    // ABB Motion_System.yaml Rev L "Get SMB Data": one ms-mechunit-smbdata
    // entry (cabinet_* / sensor_memory_* serial numbers and data statuses,
    // cab_drive_module, cab_measurement_link, cab_measurement_board). Linked
    // from the mechunit (ms-mechunit-smbdata-li) on RW 6.16.03, 7.21.4+417 and
    // 8.2.1+1023 (2026-09-29).
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/smbdata' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/smbdata' },
    note: 'Same path on both (1.0 with ?json=1). Class ms-mechunit-smbdata (ABB Rev L); no body captured on any build yet. The set/clear POSTs are not wrapped.',
  },
  getMechunitMotorCalib: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the motor calibration names of a mechanical unit.',
    // ABB Motion_System.yaml Rev L "Get Motor Calib Names": one
    // ms-mechunit-joint per joint (title jointN, joint-name, calib-name).
    // Linked from the mechunit (ms-mechunit-motorcalib-li) on all three
    // builds (2026-09-29).
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/motorcalib' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/motorcalib' },
    note: 'Same path on both (1.0 with ?json=1). Class ms-mechunit-joint (ABB Rev L); no body captured on any build yet.',
  },
  getLeadThrough: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the compliance lead-through state of a mechanical unit.',
    // ABB Motion_System.yaml Rev L "Get Compliance Lead Through": class
    // ms-mechunit-complianceleadthrough, field status (active | Inactive).
    // RW 7.21.4 and 8.2.1 link it as ROB_1/lead-through; RW 6.16.03 links it
    // as ROB_1?resource=lead-through on the mechunit itself (2026-09-29).
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/lead-through' },
    rws1: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}' },
    note: '2.0 sub-resource /lead-through; 1.0 the mechunit itself with a ?resource=lead-through query (the link RW 6.16.03 serves). Status class ms-mechunit-complianceleadthrough with status; the 1.0 mechunit body uses the same class for its LINK entry (no status), so an answer without status is not read as a state. No body captured on any build yet; the set POST is not wrapped.',
  },

  // ── Teleport (VC only) ────────────────────────────────────────────────────
  teleportMechunit: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Jump a mechanical unit to a joint position (VC only).',
    // Raw body rob_joint=[...]&ext_joint=[...] - BOTH keys required even for a
    // 6-axis robot with no external axes.
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/position', fields: ['rob_joint', 'ext_joint'] },
    note: '2.0 VC-only (real hardware / RW6 -> 404); 403 while an opmode change is pending. Both body keys required.',
  },

  // ── Jogging ───────────────────────────────────────────────────────────────
  jog: {
    tier: 'common', evidence: { rws1: 'built', rws2: 'live' }, effect: 'write',
    summary: 'Jog a mechanical unit.',
    // Entirely different shape per generation: 2.0 has a /jog subresource, 1.0
    // is a query-action on the root. Content-type carries ;v=2.0 on 2.0.
    // The fields are the jog form's, read live on RW 6.16, 7.21 and 8.1.1 (2026-09-27).
    rws2: { method: 'POST', path: '/rw/motionsystem/jog', fields: ['axis1', 'axis2', 'axis3', 'axis4', 'axis5', 'axis6', 'ccount', 'inc-mode'] },
    rws1: { method: 'POST', path: '/rw/motionsystem', action: 'jog', fields: ['axis1', 'axis2', 'axis3', 'axis4', 'axis5', 'axis6', 'ccount', 'inc-mode'] },
    note: 'path differs entirely (2.0 /jog subresource vs 1.0 ?action=jog); the form is the same. ccount is the controller\'s current motion-system change count, read with GET /rw/motionsystem right before the jog; inc-mode is {User|Medium|Small|Large}. No mode, unit or speed field. 1.0 goes through the shared session. RW 8.2.1 in MANR (Reset and Enable at the pendant, station registered, allow-motion-control true) answered 2xx both ways and axis 5 read back 30.00, 30.01, 29.99 (2026-10-13, RobotStudio virtual controller): the first RobotWare 8 motion-tier 2xx. ABB documents the axis fields only as {axis1}..{axis6}.',
  },
  setMechunitForJogging: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Select the mechanical unit that subsequent jog calls act on.',
    // The field is `mechunit-name`: the form RW 6.16.03 serves on
    // `/rw/motionsystem?action=show` (read 2026-09-29). The client used to
    // send `mechunit`.
    rws1: { method: 'POST', path: '/rw/motionsystem', action: 'set-mechunit', fields: ['mechunit-name'] },
    // RWS 2.0: ABB Motion_System Rev L "Set Mechanical Unit for Jogging": the
    // unit is the last path segment (case sensitive), there is no body, and
    // success is 204. The 2.0 form matches: OPTIONS /rw/motionsystem/ROB_1 on
    // RW 7.21.4 and 8.2.1 (2026-10-07, broker rw7 seq 474, rw8 seq 445) gives
    // Allow POST,OPTIONS and a form id="set" with no inputs.
    rws2: { method: 'POST', path: '/rw/motionsystem/{mechunit}' },
    note: '1.0 field `mechunit-name` (RW 6.16.03 form, 2026-09-29); 2.0 puts the unit in the path with no body (Rev L). A 2.0 unit name equal to a sibling resource (jog, mechunits, errorstate, ...) would address that resource, so the client refuses such names. The 2.0 template also matches every one-segment child of /rw/motionsystem in the conformance crawl.',
  },
  setRobtargetForJogging: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Set the position target used by jogging to a position.',
    // RW 6.16.03's own form (`/rw/motionsystem?action=show`, 2026-09-29) is
    // ?action=positiontarget with the 17 fields below, the same set as the RWS
    // 2.0 position-target form. The row used to send ?action=set-target with
    // x..q4, an action and field names no ABB document or form has (spec
    // check 2026-10-07; audit: FIX).
    rws1: {
      method: 'POST', path: '/rw/motionsystem', action: 'positiontarget',
      fields: ['pos-x', 'pos-y', 'pos-z', 'orient-q1', 'orient-q2', 'orient-q3', 'orient-q4',
        'config-j1', 'config-j4', 'config-j6', 'config-jx',
        'extjoint-1', 'extjoint-2', 'extjoint-3', 'extjoint-4', 'extjoint-5', 'extjoint-6'],
    },
    note: 'RWS 1.0 only; run live on RW 6.16.03 (2026-10-09). 17 fields as the RW 6.16.03 form lists them (position, quaternion, robconf, six external joints; 9E9 = no axis).',
  },

  // ── Change count ──────────────────────────────────────────────────────────
  getMotionChangeCount: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the motion-system change counter.',
    // 2.0 selects it via a read-side ?resource=change-count query; 1.0 reads the
    // change-count attribute off the bare root resource.
    rws2: { method: 'GET', path: '/rw/motionsystem' },
    rws1: { method: 'GET', path: '/rw/motionsystem' },
    note: '2.0 uses ?resource=change-count selector; 1.0 reads change-count off the root resource.',
  },
  checkMotionChangeCount: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Check whether a known change count is still current.',
    rws2: { method: 'GET', path: '/rw/motionsystem/checkchangecount/{changecount}' },
    // RWS 1.0 uses the same static segment but the count as a ?changecount= query.
    // Live-verified on the RobotWare 6.16 virtual controller (2026-08-11): 200, span class=changestate.
    rws1: { method: 'GET', path: '/rw/motionsystem/checkchangecount' },
    note: 'RWS 2.0 count is a path segment /checkchangecount/{n}; RWS 1.0 is /checkchangecount?changecount={n}.',
  },

  // ── Error / execution state ───────────────────────────────────────────────
  getMotionErrorState: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the motion error state.',
    rws2: { method: 'GET', path: '/rw/motionsystem/errorstate' },
    rws1: { method: 'GET', path: '/rw/motionsystem/errorstate' },
  },
  getNonMotionExecution: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the non-motion (dry-run) execution mode.',
    rws2: { method: 'GET', path: '/rw/motionsystem/nonmotionexecution' },
    rws1: { method: 'GET', path: '/rw/motionsystem/nonmotionexecution' },
    note: '2.0 span mode comes back quoted ("ON").',
  },
  setNonMotionExecution: {
    tier: 'niche', evidence: { rws1: 'built', rws2: 'live' }, effect: 'write',
    summary: 'Set the non-motion (dry-run) execution mode.',
    rws2: { method: 'POST', path: '/rw/motionsystem/nonmotionexecution', fields: ['mode'] },
    // RWS 1.0: ?action=set-mode, as the RW 6.16.03 form and ABB's manual (Rev M,
    // "Set NonMotion Execution Mode") name it. The row said ?action=set, which
    // RW 6.16.03 refuses 400 "Invalid action parameter value" (spec check
    // 2026-10-09); set-mode reaches the controller's own checks.
    rws1: { method: 'POST', path: '/rw/motionsystem/nonmotionexecution', action: 'set-mode', fields: ['mode'] },
    note: 'plain POST (2.0) vs ?action=set-mode (1.0); body mode = ON|OFF.',
  },

  // ── Collision prediction ──────────────────────────────────────────────────
  getCollisionPredictionMode: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read whether collision prediction is enabled.',
    rws2: { method: 'GET', path: '/rw/motionsystem/collisionprediction' },
    note: 'RWS 2.0 only; reads bool collision-prediction-mode-enabled, mapped to ON/OFF.',
  },
  setCollisionPredictionMode: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Enable or disable collision prediction.',
    rws2: { method: 'POST', path: '/rw/motionsystem/collisionprediction', fields: ['mode'] },
    note: 'RWS 2.0 only; write takes a mode string while read returns a boolean span - asymmetric.',
  },
  getCollisionPredictionModelName: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the collision-prediction model name for a robot.',
    // robotnumber is a read-side query param, REQUIRED, and ZERO-based - a
    // missing or 1-based value is a 400 (live-verified RW8.1.1).
    rws2: { method: 'GET', path: '/rw/motionsystem/collisionprediction/modelname' },
    note: 'RWS 2.0 only; ?robotnumber= query REQUIRED and ZERO-based (400 otherwise), unlike the 1-based /axes/{axis}.',
  },
  getCollisionPredictionModel: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the collision-prediction model for a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/coll-pred-model' },
    note: 'RWS 2.0 only; per-mechunit variant abbreviates+hyphenates (coll-pred-model) while the root spells collisionprediction.',
  },

  // ── Collision avoidance ───────────────────────────────────────────────────
  saveCollisionAvoidanceSnapshot: {
    tier: 'niche', evidence: 'built', effect: 'write',
    summary: 'Save a collision-avoidance snapshot to file.',
    rws2: { method: 'POST', path: '/rw/motionsystem/collisionavoidance/snapshot', fields: ['filepath', 'motiongroup'] },
    note: 'RWS 2.0 only; built-not-run - it needs the same option as loadconfig.',
  },
  loadCollisionAvoidanceConfig: {
    tier: 'niche', evidence: 'built', effect: 'write',
    summary: 'Load the collision-avoidance configuration.',
    rws2: { method: 'POST', path: '/rw/motionsystem/collisionavoidance/loadconfig' },
    note: 'RWS 2.0 only; empty body. 403 "Option is missing" (icode -7301) without the Collision Avoidance option.',
  },

  // ── Motion / path supervision ─────────────────────────────────────────────
  getMotionSupervision: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the motion-supervision state of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/motionsupervision' },
    // RWS 1.0 keeps it at the motion-system root with a REQUIRED ?mechunit=
    // query: RW 6.16.03 answers 200 with it, 400 -1073445879 "No/Invalid
    // Mechanical unit" without it, and 404 on the mechunit-scoped path
    // (2026-09-27 and 2026-09-29).
    rws1: { method: 'GET', path: '/rw/motionsystem/motionsupervision' },
    note: '2.0 per mechunit; 1.0 at the root with a required ?mechunit={mechunit} query (400 without). Same class ms-motionsupervision with mode-enabled and level on both.',
  },
  setMotionSupervisionMode: {
    tier: 'niche', evidence: 'built', effect: 'write',
    summary: 'Turn motion supervision (collision detection) while jogging on or off for a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/motionsupervision/mode', fields: ['mode'] },
    note: 'RWS 2.0 only in this client; ABB calls it Jog Supervision Mode, and its RWS 1.0 form (?action=set-mode with mechunit-name and mode at /rw/motionsystem/motionsupervision) is not wrapped. RW 7.21.4 and the RobotWare 8 VCs refused it 403 "Collision Detection is not opted during system setup" (2026-10-11). One of only 3 motion paths already living in a mapper.',
  },
  setMotionSupervisionSensitivity: {
    tier: 'niche', evidence: 'built', effect: 'write',
    summary: 'Set the motion-supervision sensitivity for a mechanical unit.',
    // Path segment is /level but the body field is `sensitivity` - the two
    // intentionally disagree (OPTIONS-verified).
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/motionsupervision/level', fields: ['sensitivity'] },
    note: 'RWS 2.0 only; path segment says level but the body field is sensitivity (OPTIONS-verified).',
  },
  getPathSupervision: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the path-supervision state of a mechanical unit.',
    rws2: { method: 'GET', path: '/rw/motionsystem/mechunits/{mechunit}/pathsupervision' },
    // RWS 1.0: RW 6.16.03 links it from the motion-system root
    // (`ms-pathsupervision-li`, 2026-09-29), next to motionsupervision.
    rws1: { method: 'GET', path: '/rw/motionsystem/pathsupervision' },
    note: '2.0 per mechunit; 1.0 at the root, sent with ?mechunit={mechunit} as motionsupervision needs it (200 on RW 6.16.03). Class ms-pathsupervision with mode and level (ABB Motion_System Rev L).',
  },
  setPathSupervisionMode: {
    tier: 'niche', evidence: 'built', effect: 'write',
    summary: 'Enable or disable path supervision for a mechanical unit.',
    rws2: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}/pathsupervision/mode', fields: ['mode'] },
    note: 'RWS 2.0 only.',
  },

  // ── Kinematics (IK / FK) ──────────────────────────────────────────────────
  calcJointsFromCartesian: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Inverse kinematics: compute joint values for a cartesian pose.',
    // 2.0 moved IK to the /joints-from-cartesian subresource; 1.0 kept the
    // CamelCase query-action, sent on the shared session. Content-type
    // carries ;v=2.0 on 2.0.
    //
    // 2.0 fields are the controller's form, in its order (OPTIONS, read
    // 2026-09-29 on RW 7.21.4 and 8.2.1: 11 fields; RW 7.21.0 had 10, without
    // absolute_accuracy). The form writes three names with a trailing space
    // (`old_rob_joints `, `old_ext_joints `, `robot_fixed_object `); they are
    // listed and sent without it, as ABB's page names them, and a request
    // with the plain names reached the solver on both builds (2026-09-30).
    // The client sends the ten ABB documents, in SI units, and not
    // absolute_accuracy. joints-from-pose offers the same 11 fields (only
    // `robot_fixed_object ` with a trailing space) and is not used.
    rws2: {
      method: 'POST',
      path: '/rw/motionsystem/mechunits/{mechunit}/joints-from-cartesian',
      fields: ['curr_position', 'curr_ext_joints', 'tool_frame_position', 'curr_orientation', 'tool_frame_orientation', 'old_rob_joints', 'old_ext_joints', 'robot_fixed_object', 'robot_configuration', 'elog_at_error', 'absolute_accuracy'],
    },
    // 1.0 fields are SI (metres, radians). Live-verified 2026-09-30 on
    // RW 6.16.03: solves on a virtual controller; the wobj_frame_* fields are
    // not ABB's and made no difference, so 1.0 no longer sends them.
    rws1: {
      method: 'POST',
      path: '/rw/motionsystem/mechunits/{mechunit}',
      action: 'CalcJointsFromPose',
      fields: ['curr_position', 'curr_orientation', 'curr_ext_joints', 'old_rob_joints', 'old_ext_joints', 'robot_fixed_object', 'tool_frame_position', 'tool_frame_orientation', 'robot_configuration', 'elog_at_error'],
    },
    note: '2.0 renamed to a subresource; 1.0 kept the CamelCase ?action=CalcJointsFromPose on the shared session. Both take and answer SI units (metres, radians; answer robotjoint1..6 in radians - 2.0 class joints-from-cartesian, 1.0 all-joint-solutions). 1.0 solves on a RW 6.16.03 virtual controller (live-verified 2026-09-30); millimetres and degrees answer 400 -1073436654 "Position outside of reach", as they did on RW 7.21.4 and 8.2.1 (2026-09-30). 2.0 in SI units solves on RW 7.21.4 and 8.2.1 (live-verified 2026-09-30, functional run ikfk-final: the current pose gives back the current joints). The 2.0 form lists three names with a trailing space; the plain names are sent.',
  },
  calcCartesianFromJoints: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Forward kinematics: compute a cartesian pose from joint values.',
    // 2.0 is ABB's pose-from-joints subresource. Its fields are the
    // controller's form, in its order (OPTIONS, read 2026-09-29 on RW 7.21.4
    // and 8.2.1: 7 fields); the client sends the six ABB documents, not
    // absolute_accuracy. It used to send ?action=CalcRobTFromJoints on the
    // mechunit, which no ABB document names: RW 7.21.4 and 8.2.1 answered it
    // 200 with an error link (-1073445859, -1073435873), and RW 6.16.03
    // answers 400 -1073445879 "Invalid action parameter value", like a
    // made-up action name (live-verified 2026-09-30). 1.0 uses ABB's
    // CalcPoseFromJoints.
    rws2: {
      method: 'POST',
      path: '/rw/motionsystem/mechunits/{mechunit}/pose-from-joints',
      fields: ['tool_frame_position', 'tool_frame_orientation', 'rob_joints', 'ext_joints', 'robot_fixed_object', 'elog_at_error', 'absolute_accuracy'],
    },
    rws1: { method: 'POST', path: '/rw/motionsystem/mechunits/{mechunit}', action: 'CalcPoseFromJoints', fields: ['tool_frame_position', 'tool_frame_orientation', 'rob_joints', 'ext_joints', 'robot_fixed_object', 'elog_at_error'] },
    note: '2.0: /pose-from-joints subresource; 1.0: ?action=CalcPoseFromJoints. Both SI units (rob_joints in radians; answer position-x/y/z in metres, class position-from-joint with robtargetorientation-u0..u3 on 2.0; robtarget-orientation-u0..u3 on 1.0). The metres are the controller\'s: ABB\'s pose-from-joints page states no unit and its sample request and answer are on a millimetre scale (Rev L; spec check 2026-10-07). 1.0 solves on a RW 6.16.03 virtual controller and 2.0 on RW 7.21.4 and 8.2.1 (live-verified 2026-09-30, functional run ikfk-final: the current joints give back the current pose within 1 mm). 2.0 may return HTTP 200 with an embedded rel="error" retcode link instead of a status code.',
  },
};
