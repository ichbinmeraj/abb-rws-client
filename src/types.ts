// abb-rws-client - shared type definitions
// Used by BOTH protocol clients: RwsClient (RWS 1.0 / IRC5 / RW6) and
// RwsClient2 (RWS 2.0 / OmniCore / RW7). See src/index.ts for the public surface.

export type ControllerState =
  | 'init'
  | 'motoroff'
  | 'motoron'
  | 'guardstop'
  | 'emergencystop'
  | 'emergencystopreset'
  | 'sysfail';

export type OperationMode = 'AUTO' | 'MANR' | 'MANF';
export type ExecutionState = 'running' | 'stopped';

/** Full execution state including current cycle mode. */
export interface ExecutionInfo {
  state: ExecutionState;
  /** Current cycle mode: 'once' | 'forever' | 'asis' | 'oncedone' */
  cycle: string;
}

export interface JointTarget {
  rax_1: number;
  rax_2: number;
  rax_3: number;
  rax_4: number;
  rax_5: number;
  rax_6: number;
}

export interface RobTarget {
  x: number;
  y: number;
  z: number;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
}

/**
 * A RAPID task's current robtarget, as `GET /rw/rapid/tasks/{task}/motion/robtarget`
 * reports it (RWS 2.0, class `rapid-robtarget`): position in mm, orientation
 * as a quaternion, the robot configuration (RAPID `robconf`: cf1, cf4, cf6,
 * cfx) and the six external axes `eax_a..eax_f`, where 9E9
 * (`JOINT_NOT_PRESENT`) means no axis in that slot - test with
 * `isJointValuePresent()`. Read on RW 7.21.0, 7.21.4, 8.1.1 and 8.2.1
 * virtual controllers (2026-10-03).
 */
export interface TaskRobTarget extends RobTarget {
  cf1: number;
  cf4: number;
  cf6: number;
  cfx: number;
  /** eax_a..eax_f, in that order; an omitted field reads as `JOINT_NOT_PRESENT`. */
  eax: [number, number, number, number, number, number];
}

/**
 * One mechanical unit a RAPID task drives, as `GET
 * /rw/rapid/tasks/{task}/motion/mechunits` lists it (RWS 2.0, class
 * `rapid-mechunit`). Read on RW 7.21.0, 7.21.4, 8.1.1 and 8.2.1 as
 * `ROB_1`, `active`, `tcp_robot` (2026-10-03).
 */
export interface TaskMechunit {
  /** The unit's name, e.g. `ROB_1`. */
  name: string;
  /** As reported, e.g. `active`. */
  mode: string;
  /** As reported, e.g. `tcp_robot`. */
  type: string;
}

export interface Signal {
  name: string;
  value: string;
  type: 'DI' | 'DO' | 'AI' | 'AO' | 'GI' | 'GO';
  lvalue: string;
}

export interface RapidTask {
  name: string;
  type: string;
  taskstate: string;
  excstate: ExecutionState;
  active: boolean;
  motiontask: boolean;
}

/** Extended RobTarget that includes robot configuration flags returned by /cartesian */
export interface CartesianFull extends RobTarget {
  /** Shoulder configuration: 0 = front, -1 = back */
  j1: number;
  /** Elbow configuration: -1 = down, 1 = up */
  j4: number;
  /** Wrist configuration: -1 = flip, 1 = no flip */
  j6: number;
  /** External axis configuration */
  jx: number;
}

/**
 * Every axis slot of one mechanical unit, as `GET .../mechunits/{unit}/jointtarget`
 * reports it: the six robot axes `rax_1..rax_6` AND the six external axes
 * `eax_a..eax_f`. `JointTarget` keeps only the robot half.
 *
 * Values are as RWS reports them: degrees for a revolute axis, millimetres for a
 * prismatic one (RWS converts from the SI values the motion configuration
 * stores; the revolute half is live-verified, the prismatic half is inferred).
 *
 * `9E9` (`JOINT_NOT_PRESENT`) in a slot means "no axis here" - use
 * `isJointValuePresent()` rather than comparing for equality. A slot is NOT
 * guaranteed to carry the marker when it is unused, though: all twelve fields
 * are sent even for a 6-axis robot with nothing external, and on the RW 7.21
 * VC the unused `eax_*` slots read `0`, not 9E9 (live-verified 2026-09-23).
 * Which slots a unit really uses therefore comes from the
 * unit's axis count (`MechunitDetails.axes` / `axesTotal`), not from the values.
 */
export interface JointTargetFull {
  /** rax_1..rax_6, in that order. */
  rax: [number, number, number, number, number, number];
  /**
   * eax_a..eax_f, in that order. A field the controller omitted is reported as
   * `JOINT_NOT_PRESENT` (9E9) - omission is read as "no axis in this slot".
   */
  eax: [number, number, number, number, number, number];
}

/**
 * A mechanical unit's own description, normalised from
 * `GET /rw/motionsystem/mechunits/{unit}` on both generations. Every field is
 * null when the controller did not send it (or sent it empty); `raw` keeps the
 * resource exactly as received.
 *
 * Field spellings differ by representation: RW 6 JSON says
 * `task` and `is-integrated-unitname` / `has-integrated-unitname` where XHTML and
 * RWS 2.0 say `task-name` and `is-integrated-unit` / `has-integrated-unit`. Both
 * spellings are read.
 *
 * Read live on an RW 7.21 VC (2026-09-23): `type: TCPRobot`, `axes: 6`,
 * `axes-total: 6`, `mode: Activated`, `status: Synchronized`, `task-name: T_ROB1`,
 * `coord-system: World`, `is-/has-integrated-unit: NoIntegratedUnit`. Only
 * `TCPRobot` has been observed as a type; the values for a positioner, a track
 * or a single external axis are not yet known.
 */
export interface MechunitDetails {
  /** The unit asked for, e.g. ROB_1. */
  name: string;
  /** Unit type as reported, e.g. `TCPRobot`. */
  type: string | null;
  /** `axes` - the unit's axis count. */
  axes: number | null;
  /**
   * `axes-total`. Equal to `axes` on every unit observed so far; how the two
   * differ (presumably an integrated external axis such as a track) is not yet
   * observed.
   */
  axesTotal: number | null;
  /** The RAPID task that drives this unit (`task-name`, RW 6 JSON `task`). */
  task: string | null;
  /** `mode`, e.g. Activated / Deactivated. */
  mode: string | null;
  /** `status`, e.g. Synchronized. */
  status: string | null;
  /** `coord-system` - the unit's current (jog) coordinate system, e.g. World. */
  coordSystem: string | null;
  /** `tool-name` - the active tool. */
  tool: string | null;
  /** `wobj-name` - the active work object. */
  wobj: string | null;
  /** `is-integrated-unit` as reported; `NoIntegratedUnit` when none. */
  isIntegratedUnit: string | null;
  /** `has-integrated-unit` as reported; `NoIntegratedUnit` when none. */
  hasIntegratedUnit: string | null;
  /** The resource exactly as received. */
  raw: Record<string, string>;
}

export interface IoNetwork {
  name: string;
  /** Physical state: 'running' | 'stopped' */
  pstate: string;
  /** Logical state: 'started' | 'stopped' */
  lstate: string;
}

export interface IoDevice {
  name: string;
  network: string;
  lstate: string;
  pstate: string;
  address: string;
}

export interface SystemInfo {
  /** Controller/system name */
  name: string;
  /** RobotWare version string, e.g. '6.13.0164' */
  rwVersion: string;
  /** System GUID */
  sysid: string;
  /**
   * Timestamp when RobotWare started, in the controller's local time (not
   * UTC; the controller's `starttm`, on RobotWare 6, 7 and 8).
   *
   * Do not use it to detect a restart: on an RW 6.16.03 virtual controller it
   * read the process start time for a while and then, with no restart (same
   * process, same session), began to read the time of each request
   * (observed 2026-09-29; cause unknown).
   */
  startTime: string;
  /** Licensed RobotWare options */
  options: string[];
}

export interface ControllerIdentity {
  /** Controller name */
  name: string;
  /** Controller ID */
  id: string;
  /** 'Real Controller' | 'Virtual Controller' */
  type: string;
  /** MAC address */
  mac: string;
}

/**
 * One substituted argument of an event-log message. The controller stores the
 * message text as a template and supplies the values separately, so "The speed
 * has been adjusted to 100% by Default User" arrives as a title plus
 * `[{type:'long', value:'100'}, {type:'string', value:'Default User'}]`.
 */
export interface ElogArg {
  /** Controller-declared type, e.g. 'long', 'string', 'float'. */
  type: string;
  value: string;
}

export interface ElogMessage {
  /**
   * Sequence number, as the controller numbers the message inside its domain.
   * On RWS 1.0 it is not safe to treat as monotonic. The wrap itself is a
   * field report, not a release-note item: on RW 6.13.02 the number wrapped at
   * 2^16 in listings and events, and ABB called it a known issue with no fix
   * version (ABB Robotics technical community thread "Sequence number
   * overflow bug in RWS",
   * https://tech-community.robotics.abb.com/t/sequence-number-overflow-bug-in-rws/10673,
   * read 2026-09-29). The only candidate fix in ABB's notes is the title-only
   * "Elog Issue using RWS on IRC5" in ABB RobotWare release notes 6.13.04 §1
   * Corrections (release notes, 2026-09-29); no note states a cap or a
   * mechanism, so whether that title is this wrap is an inference. This client
   * never orders or de-duplicates by seqnum; a consumer that does should treat
   * a value lower than the last seen by more than 32768 as a wrap, not as
   * stale.
   */
  seqnum: number;
  /** Event code, e.g. 10126 */
  code: number;
  /**
   * 1 = info, 2 = warning, 3 = error; 0 = unknown: the controller omitted or
   * mangled msgtype. RW6 could omit a parameter in Message Get (ABB RobotWare
   * release notes 6.15.04 §4 Corrections, "RWS Elog Message Get missing
   * response parameter"; release notes, 2026-09-29) - a title only, so the
   * affected range is not stated; "RW6 before 6.15.04" is inferred from the
   * fix version, and that the parameter is msgtype is an inference too. The
   * 0 applies to the listings and single-message reads of both protocols so
   * they agree. Never assume 0 is information - render it as unknown
   * severity.
   */
  msgtype: number;
  /** Timestamp string from controller */
  timestamp: string;
  /** Source name (subsystem that generated the event) */
  srcName: string;
  title: string;
  desc: string;
  causes: string;
  consequences: string;
  actions: string;
  /**
   * Substituted values for this message, in order. Empty when the message
   * takes none. Both protocols carry them; they were never read until 2026-08.
   */
  args: ElogArg[];
}

/**
 * A controller status code translated by the controller's own dictionary
 * (`GET /rw/retcode?code=N`). Available on every generation.
 */
export interface ReturnCodeInfo {
  code: number;
  /** ABB's symbolic name, e.g. 'SYS_CTRL_E_NO_SUCH_SYMBOL'. */
  name: string;
  /** e.g. 'Error', 'Warning'. */
  severity: string;
  description: string;
}

/** Controller clock date/time. */
export interface ControllerClock {
  /** Format: 'YYYY-MM-DD T HH:MM:SS' */
  datetime: string;
}

/** Active RAPID UI instruction (e.g. TPReadNum, TPReadFK waiting for input). */
export interface UiInstruction {
  /** Instruction name, e.g. 'TPReadNum', 'TPReadFK' */
  instr: string;
  /** Event type: 'SEND' | 'POST' | 'ABORT' */
  event: string;
  /** Stack URL - used as {stackurl} when setting a parameter value */
  stack: string;
  /** Execution level: 'NORMAL' | 'TRAP' | ... */
  execlv: string;
  /** Message text displayed on FlexPendant */
  msg: string;
}

/** A RAPID symbol found by search (abbreviated properties). */
export interface RapidSymbolInfo {
  /** Full symbol path, e.g. 'RAPID/T_ROB1/user/reg1' */
  symburl: string;
  name: string;
  /** Symbol type: 'var' | 'per' | 'con' | 'fun' | 'prc' | etc. */
  symtyp: string;
  /** Data type name, e.g. 'num', 'string', 'bool', 'robtarget' */
  dattyp: string;
  /** Number of array dimensions (0 = scalar) */
  ndim: number;
  local: boolean;
  ro: boolean;
  taskvar: boolean;
}

/** Parameters for RAPID symbol search. */
export interface RapidSymbolSearchParams {
  /** Task name; required */
  task: string;
  /** Search scope: 'block' | 'scope' | 'stack' */
  view?: 'block' | 'scope' | 'stack';
  /** Variable filter: 'rw' | 'ro' | 'loop' | 'any' */
  vartyp?: string;
  /** Symbol type filter: 'var' | 'per' | 'con' | 'fun' | 'prc' | 'mod' | 'tsk' | 'any' */
  symtyp?: string;
  /** Data type filter, e.g. 'num', 'bool', 'robtarget' */
  dattyp?: string;
  /** Regex pattern for symbol name matching */
  regexp?: string;
  /** Whether to search recursively; default true */
  recursive?: boolean;
  /** URL of module/routine to search within */
  blockurl?: string;
}

/** Controller restart mode. */
/**
 * Controller restart modes. `restart` (warm), `istart` (re-install the system),
 * `pstart` (restart and delete the program), `bstart` (restart from the last
 * backup) are accepted on both protocol generations.
 *
 * `shutdown` and `xstart` are RWS 2.0 only: the RobotWare 7/8 `/ctrl/restart`
 * form advertises all six, while the RWS 1.0 panel form lists only the first
 * four (live-verified 2026-08 by reading each controller's own OPTIONS form).
 */
export type RestartMode = 'restart' | 'istart' | 'pstart' | 'bstart' | 'shutdown' | 'xstart';

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  /** File size in bytes (files only) */
  size?: number;
  /** Creation timestamp from controller */
  created?: string;
  /** Last-modified timestamp from controller */
  modified?: string;
  /** Whether the file is read-only (files only) */
  readonly?: boolean;
}

/**
 * A file's metadata, read without downloading the file (`getFileMetadata`).
 * Every field the controller gave is in `fields` as well; the named fields
 * are the ones this client can interpret.
 */
export interface FileMetadata {
  /** The path as the caller gave it. */
  path: string;
  /** File size in bytes, when the controller states it. */
  size?: number;
  /** Creation timestamp, when the controller states it (RWS 1.0 `fs-cdate`). */
  created?: string;
  /** Last-modified timestamp (RWS 1.0 `fs-mdate`, RWS 2.0 `Last-Modified`). */
  modified?: string;
  /** Whether the file is read-only, when the controller states it. */
  readonly?: boolean;
  /** RWS 2.0: the `Content-Type` header of the HEAD answer. */
  contentType?: string;
  /** Every field of the answer: RWS 2.0 response headers (cookies left out), RWS 1.0 body fields. */
  fields: Record<string, string>;
}

/** One configuration type (`GET /rw/cfg/{domain}/{type}`): how many attributes and instances it has. */
export interface CfgTypeInfo {
  domain: string;
  type: string;
  /** `cfg-no-of-attributes`, when the controller states it. */
  attributeCount?: number;
  /** `cfg-no-of-instances`, when the controller states it. */
  instanceCount?: number;
}

/** One DIPC queue's information (`getDipcQueueInfo`). */
export interface DipcQueueInfo {
  name: string;
  /** Queue depth (`queue-size`). */
  size?: number;
  /** Largest message the queue takes, in bytes. */
  maxMsgSize?: number;
  /** The queue's slot id. */
  slotId?: string;
}

/** One routine of a RAPID module (`listModuleRoutines`). */
export interface RapidRoutineInfo {
  name: string;
  /** `prc` (PROC), `fun` (FUNC) or `trp` (TRAP); other controller spellings are passed through lowercased. */
  type: string;
}

/**
 * One build error of a task's program (`getBuildErrors`): ABB's
 * `rap-builderrs` entry, the same on RWS 1.0 (Rev M) and RWS 2.0 (Rev L),
 * "Get Build Errors".
 */
export interface RapidBuildError {
  /** The module the error is in (ABB's `ModuleName`). */
  module: string;
  /** Row of the error in the module. */
  row: number;
  /** Column of the error in the row. */
  column: number;
  /** The RAPID build error as the controller words it (ABB's `error`, e.g. `S:"';'"`), without the whitespace around it (RW 6.16.03, 7.21.4 and 8.2.1 end it with a tab). */
  error: string;
  /** The error number, when the answer carries one (ABB's `error-num`, in Rev L's example; RW 7.21.4 and 8.2.1 send it, RW 6.16.03 does not). */
  errorNumber?: number;
  /** The kind of error, when the answer carries it: `type_of_error`, which ABB's examples do not show; RW 7.21.4 and 8.2.1 sent `SYNTAX` and `SEMANTIC`. */
  typeOfError?: string;
}

/** One subscription group of this session (`listSubscriptionGroups`). */
export interface SubscriptionGroupInfo {
  /** The group id, the list item's title (`subsgrp-li`). */
  id: string;
  /** The group resource, `/subscription/{id}`: what `getSubscriptionGroup`, `updateSubscriptionGroup` and the delete take. */
  groupPath: string;
  /**
   * The group's poll (WebSocket) URL as the controller wrote it, when given
   * (`rel="events"`). RWS 2.0 writes it in full (`wss://host:port/poll/{id}`);
   * RW 6.16.03 writes it without a host (`ws:///poll/{id}`).
   */
  pollUrl?: string;
}

/** One resource bound to a subscription group (`getSubscriptionGroup`). */
export interface SubscriptionGroupMember {
  /** The member's index in the group, the list item's title (`sub-resource`). */
  index: string;
  /** The resource exactly as the group stores it, `;stateParam` suffix included (e.g. `/rw/panel/speedratio;speedratio`). */
  resource: string;
}

/** Motion (jog) supervision of a mechanical unit (`getMotionSupervision`). */
export interface MotionSupervisionState {
  /** `mode-enabled` is TRUE. */
  enabled: boolean;
  /** Supervision level (`level`, 100 = the default sensitivity). */
  level: number;
}

/** Path supervision of a mechanical unit (`getPathSupervision`). */
export interface PathSupervisionState {
  /** `mode` as the controller gave it (ABB documents ON / OFF). */
  mode: string;
  /** Supervision level (`level`). */
  level: number;
}

/** One joint's motor calibration name (`getMechunitMotorCalib`). */
export interface MechunitMotorCalib {
  /** The list item's title, `joint1`..`jointN`. */
  joint: string;
  /** `joint-name`, e.g. `rob1_1`. */
  jointName?: string;
  /** `calib-name`, e.g. `rob1_1`. */
  calibName?: string;
}

/** Compliance lead-through state of a mechanical unit (`getLeadThrough`). */
export interface LeadThroughState {
  /**
   * `status` is `active` (any case). ABB (Motion_System Rev L) defines `status`
   * as active "if complianceleadthrough functionality is opted for", which may
   * mean the option is present rather than that lead-through is engaged now;
   * no build's answer has been captured to settle which.
   */
  active: boolean;
  /** `status` as the controller gave it (ABB documents `active` / `Inactive`). */
  status: string;
}

export type MastershipDomain = 'cfg' | 'motion' | 'rapid';

/**
 * The controller's control-station write-access status, RobotWare 8
 * (`RobotManager.getWriteAccessStatus`). Each field is what the answer said,
 * and null where it did not say: a flag is true only for the text `true` and
 * false only for the text `false`; any other text, and an absent field, is
 * null. The holder's station id is never part of it.
 */
export interface WriteAccessStatus {
  /** Write access is held by some control station. Null when the answer does not carry the field, or carries another text. */
  held: boolean | null;
  /**
   * The holder is this client's own control station: the holder id the
   * controller names, compared without case with the id this client registers
   * as. False when `held` is false; null when `held` is null, or when it is
   * true and the answer names no holder id (absent, empty or `none`). An id
   * comparison, not a record of what this session did.
   */
  heldByMe: boolean | null;
  /** The holding station's name as the controller reports it. Null when it reports none: the field absent, empty, or the text `none`. */
  heldByName: string | null;
  /** The controller's "external control enabled" flag. Null when the answer does not carry the field, or carries another text. */
  externalControlEnabled: boolean | null;
}

/**
 * The RMMP (Request Manual Mode Privileges) levels ABB documents for a request,
 * `privilege={modify|exec}` (RWS 1.0 and 2.0 user pages). The privilege a
 * session holds reads as `none`, `pending modify`, `modify` or `exec`.
 * `RobotManager.requestRmmp` sends the level asked for (`modify` by default).
 */
export type RmmpLevel = 'modify' | 'exec';

/**
 * How `RobotManager.requestRmmp` ended:
 * - `granted`: the controller reports the privilege as this session's.
 * - `denied`: the controller reported the request as denied.
 * - `expired`: no grant within the wait, or the request stopped being pending
 *   without a grant; the request was cancelled.
 * - `cancelled`: the caller aborted the wait; the request was cancelled.
 * - `held-lower`: `exec` was asked for while this session holds `modify`.
 *   Nothing was sent and `modify` is still held; call `cancelRmmp()` to give
 *   it back first, then request `exec`.
 */
export type RmmpOutcome = 'granted' | 'denied' | 'expired' | 'cancelled' | 'held-lower';

/** Options for `RobotManager.requestRmmp`. */
export interface RmmpRequestOptions {
  /**
   * How long to wait for the operator at the FlexPendant, in ms (default
   * 30000). When it runs out the request is cancelled and the outcome is
   * `expired`.
   */
  waitMs?: number;
  /**
   * How often to poll the pending request, in ms (default 1000, 250 to 5000).
   * ABB deletes a request that is not polled within 10 s.
   */
  pollMs?: number;
  /** Aborts the wait; the request is then cancelled and the outcome is `cancelled`. */
  signal?: AbortSignal;
  /**
   * Called once the request was accepted and is waiting for the operator, so a
   * user interface can say "Waiting for the operator at the FlexPendant to
   * press Grant".
   */
  onPending?: () => void;
}

/** What `RobotManager.requestRmmp` observed. */
export interface RmmpResult {
  outcome: RmmpOutcome;
  /**
   * The privilege as last read for this session (`none`, `pending modify`,
   * `modify`, `exec`), or null when it was never read during the wait.
   */
  privilege: string | null;
  /** Plain words: what happened and what was sent. */
  detail: string;
  /**
   * For `denied` and `expired`: the refusal in plain words (kind
   * `rmmp-denied` or `rmmp-expired`, grantor `pendant-operator`).
   */
  refusal?: RwsRefusal;
}

/**
 * The jog increment ABB's jog form offers as `inc-mode`
 * (`{User | Medium | Small | Large}`), the FlexPendant's incremental jog
 * sizes. `User` is the controller's user-defined increment.
 */
export type JogIncrement = 'Small' | 'Medium' | 'Large' | 'User';

/** One jog request (`IRWSAdapter.jog`, `RobotManager.jog`). */
export interface JogParams {
  /**
   * The motion the caller means. Not sent: ABB's jog form has no mode field,
   * and the controller jogs in the jog mode of the unit selected for jogging.
   */
  mode: 'Joint' | 'Cartesian';
  /**
   * Six values, sent as ABB's `axis1`..`axis6`. They are not degrees or
   * millimetres: ABB documents the fields only as `{axis1}`..`{axis6}`, with a
   * sample of `axis1=900` and `inc-mode=Large` (RWS 1.0 manual Rev M and RWS 2.0
   * Rev L, Perform Jogging), and states no unit. The sign sets the direction of
   * one jog step; zero leaves that axis (or direction) still. What the
   * magnitude does is not documented. One call is one step: on RW 8.2.1 a jog
   * with axis 5 set to 1 and the default `Small` increment moved axis 5 by
   * about 0.01 degree (2026-10-13). Repeat the call to move further.
   */
  axes: [number, number, number, number, number, number];
  /** Not sent: ABB's jog form has no speed field. Kept for compatibility. */
  speed: number;
  /**
   * The unit the caller means. Not sent: ABB's jog form has no unit field, and
   * the controller jogs the unit selected for jogging. When given and the
   * controller names another unit (or none) as selected, the jog selects this
   * unit first (ABB's "set mechanical unit for jogging") and is sent only if
   * the controller then names it.
   */
  mechunit?: string;
  /** Increment size sent as `inc-mode` (default `Small`, the smallest). */
  incMode?: JogIncrement;
}

/**
 * Collision detection state returned by GET /rw/panel/coldetstate.
 * INIT = no collision detected (normal operation).
 * TRIGGERED = collision detected, not yet acknowledged.
 * CONFIRMED = collision confirmed.
 * TRIGGERED_ACK = collision acknowledged.
 */
export type CollisionDetectionState = 'INIT' | 'TRIGGERED' | 'CONFIRMED' | 'TRIGGERED_ACK';

/** Execution cycle mode returned/set by /rw/rapid/execution */
export type ExecutionCycle = 'once' | 'forever' | 'asis';

/**
 * RAPID symbol properties returned by GET /rw/rapid/symbol/properties/RAPID/{task}/{module}/{symbol}.
 * symtyp: 'var' | 'per' | 'con' | 'par' | 'fun' | 'prc' | 'mod' | 'tsk' | 'any' | 'udef' | 'atm' | 'rec' | 'ali' | 'rcp'
 */
export interface RapidSymbolProperties {
  /** Full symbol URL path */
  symburl: string;
  /** Symbol type: var/per/con/par/fun/prc/mod/tsk/any/udef/atm/rec/ali/rcp */
  symtyp: string;
  /** Whether the symbol has a name */
  named: boolean;
  /** Data type name, e.g. 'num', 'string', 'bool', 'robtarget' */
  dattyp: string;
  /** Number of array dimensions (0 = scalar) */
  ndim: number;
  /** Dimension sizes as a string, e.g. '[3]' for 3-element array */
  dim: string;
  /** Whether the symbol is heap-allocated */
  heap: boolean;
  /** Whether the symbol definition is complete (linked) */
  linked: boolean;
  /** Whether the symbol is module-local (not global) */
  local: boolean;
  /** Whether the persistent is read-only */
  ro: boolean;
  /** Whether the symbol is task-global (taskvar) */
  taskvar: boolean;
  /** Storage type: 'local' | 'task' | 'global' */
  storage: string;
  /** URL reference to the type symbol */
  typurl: string;
}

export interface RwsClientOptions {
  /** IP address or hostname, e.g. '192.168.125.1' or '127.0.0.1' for RobotStudio */
  host: string;
  /** HTTP port; default 80 */
  port?: number;
  /** Default 'Admin' */
  username?: string;
  /** Default 'robotics' */
  password?: string;
  /** Minimum ms between requests; default 100 ms (ABB states 50 ms minimum per request, 20 req/s) */
  requestIntervalMs?: number;
  /**
   * Request timeout in ms; default 5000. A finite number above 0 and at most
   * 2^31-1 (about 24.8 days); anything else throws INVALID_ARGUMENT from the
   * constructor.
   */
  timeout?: number;
  /** Saved -http-session- cookie value to reuse an existing controller session slot */
  sessionCookie?: string;
}

export type SubscriptionResource =
  | 'execution'
  | 'controllerstate'
  | 'operationmode'
  | 'speedratio'
  | 'coldetstate'
  | 'uiinstr'
  | { type: 'signal'; name: string }
  | { type: 'persvar'; name: string }
  | { type: 'taskchange'; task: string }
  | { type: 'execycle' }
  | { type: 'elog'; domain: number };

/**
 * Every subscription kind this package's subscribers take: the
 * `SubscriptionResource` kinds and two added in 1.5.0, kept out of
 * `SubscriptionResource` so that an `IRWSAdapter` of another make written
 * against 1.4.0, whose `subscribe` handles every `SubscriptionResource`,
 * still compiles:
 *
 * - `{ type: 'mastership', domain? }`: mastership changes. RWS 1.0
 *   `/rw/mastership` (every domain) or `/rw/mastership/{domain}` (ABB Rev M,
 *   "Mastership Subscribe", "Mastership Domain Subscribe"); RWS 2.0
 *   `/rw/mastership/{domain}`, `rapid` and `cfg` sent as RobotWare 7's
 *   `edit` (Rev L). RobotWare 8 has no mastership service.
 * - `{ type: 'motionerrorstate' }`: the motion system's error state,
 *   `/rw/motionsystem/errorstate;erroreventchange` on both generations
 *   (Rev M "Subscribe on Error EventChange", Rev L Motion System).
 *
 * `RwsClient`, `RWS1Adapter` and `RwsClient2` take them in `subscribe`,
 * `updateSubscriptionGroup` and `unsubscribeResource`, and so do
 * `RobotManager`'s group edits.
 */
export type AnySubscriptionResource =
  | SubscriptionResource
  | { type: 'mastership'; domain?: MastershipDomain }
  | { type: 'motionerrorstate' };

/**
 * Strip a leading `RAPID/` from a symbol path.
 *
 * The two protocols disagree on the shape of a persistent-variable subscription:
 * RWS 1.0 wants `/rw/rapid/symbol/data/RAPID/{task}/{module}/{sym};value` and
 * RWS 2.0 wants `/rw/rapid/symbol/RAPID/{task}/{module}/{sym}/data;value`, and
 * each rejects the other's shape. Both builders normalize through this helper so
 * one `{ type: 'persvar', name }` works on either adapter, with or without the
 * prefix. Live-verified 2026-08 on RW6.16, RW7.21 and RW8.1.1.
 */
export function stripRapidDomain(name: string): string {
  return name.replace(/^\/?RAPID\//i, '');
}

export interface SubscriptionEvent {
  resource: string;
  value: string;
  timestamp: Date;
}

/**
 * How healthy the connection to a controller currently is:
 * - 'live'          - WebSocket subscriptions streaming; polling at slow cadence
 * - 'polling'       - fast polling covers state: no WebSocket (unavailable or
 *                     lost), or a stream whose group the controller created
 *                     without a status resource the poll reads (the reason
 *                     names it)
 * - 'reconnecting'  - a connect attempt is in flight
 * - 'stale'         - 1-2 consecutive polls failed; data may be outdated
 * - 'disconnected'  - not connected (never, by user, or after repeated failures)
 * The accompanying `qualityReason` on RobotState says why in human terms.
 */
export type ConnectionQuality = 'live' | 'polling' | 'reconnecting' | 'stale' | 'disconnected';

export type RwsErrorCode =
  | 'SESSION_EXPIRED'
  | 'AUTH_FAILED'          // credential/handshake failure ONLY - other 403s get the codes below
  | 'MOTORS_OFF'
  | 'MODULE_NOT_FOUND'
  | 'RESOURCE_NOT_FOUND'   // 404-family: signal/file/symbol/path does not exist
  | 'MASTERSHIP_REQUIRED'  // write needs mastership, or another client holds it
  | 'GRANT_DENIED'         // refused for this user or by the controller's access rules (UAS grant, safety access restriction, RMMP not granted, RobotWare 8 motion control not declared); see RwsError.refusal
  | 'WRONG_MODE'           // operation not allowed in the current controller state or op-mode
  | 'UNSUPPORTED_OPERATION' // this protocol generation / controller does not have the operation
  | 'INVALID_ARGUMENT'     // a value was refused: by this client before sending, or by the controller
  | 'NOT_CONNECTED'        // connect() has not run (or the manager has no adapter yet)
  | 'RATE_LIMITED'
  | 'CONTROLLER_BUSY'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'
  | 'PROTOCOL_DETECT_FAILED'
  | 'UNKNOWN';

// ─── Refusals (RwsError.refusal) ─────────────────────────────────────────────

/**
 * What kind of refusal an error is, finer than its `RwsErrorCode`. The
 * distinctions are the ones ABB draws between "held by another", "not held",
 * "wrong mode" and "missing grant" (the PC SDK's ResourceHeldException,
 * MasterRejectException, ModeRejectException, UasRejectException,
 * WriteAccessRejectException, ExternalControlRejectException and
 * MotionControlRejectException).
 *
 * - `held-by-other`: another client, the FlexPendant, a PLC or the controller
 *   itself holds the mastership or write access the operation needs.
 * - `not-held`: this session does not hold it. `not-registered`: RobotWare 8,
 *   the session is not a registered control station. `lost`: this session
 *   held it when the operation began and lost it during the operation.
 * - `remote-access-off`: RobotWare 8, Remote Access is not allowed at the
 *   FlexPendant. `motion-control-off`: RobotWare 8, this station has not
 *   declared that an emergency stop and a normal stop are within reach.
 * - `motion-held`: a RAPID start while this session holds motion mastership.
 *   `external-client-motion`: an external client controls motion.
 * - `rmmp-required` / `rmmp-pending` / `rmmp-denied` / `rmmp-expired` /
 *   `rmmp-wrong-mode`: the manual-mode remote access (RMMP) of RobotWare 6/7.
 * - `grant-missing`: the logged-in user lacks a UAS grant.
 * - `wrong-mode`: the operating mode does not allow it. `wrong-state`: the
 *   controller or execution state does not (motors off, no program pointer).
 *   `safety-state`: a safety stop or a pending Reset blocks it.
 * - `access-restricted`: the controller's safety access restriction refused a
 *   signal write (often the signal's access level).
 * - `local-only`: only someone at the controller can do it. `vc-only` /
 *   `rc-only`: only on virtual / real controllers. `by-design`: not open to a
 *   remote tool by ABB's design. `option-missing`: a RobotWare option is not
 *   installed. `unsupported`: this RobotWare does not offer it.
 * - `watchdog-expired`: reserved for the RobotWare 7.8+ mastership heartbeat.
 * - `invalid-argument`: the controller refused a value. `unknown`: the
 *   controller gave no reason this client can explain; its text is kept.
 */
export type RefusalKind =
  | 'held-by-other' | 'not-held' | 'not-registered' | 'lost'
  | 'remote-access-off' | 'motion-control-off' | 'motion-held' | 'external-client-motion'
  | 'rmmp-required' | 'rmmp-pending' | 'rmmp-denied' | 'rmmp-expired' | 'rmmp-wrong-mode'
  | 'grant-missing' | 'wrong-mode' | 'wrong-state' | 'safety-state' | 'access-restricted'
  | 'local-only' | 'vc-only' | 'rc-only' | 'by-design' | 'option-missing'
  | 'watchdog-expired' | 'unsupported' | 'invalid-argument' | 'unknown';

/**
 * The missing condition, as one of the controls ABB puts in front of a write.
 * `none`: nothing anyone can supply (by design, or unsupported).
 */
export type RefusalCondition =
  | 'mastership' | 'write-access' | 'control-station' | 'remote-access' | 'motion-control'
  | 'rmmp' | 'uas-grant' | 'operating-mode' | 'motors' | 'safety-state' | 'controller-state'
  | 'signal-access-level' | 'local-only' | 'option' | 'platform' | 'argument' | 'session'
  | 'none' | 'unknown';

/**
 * Who can supply the missing condition:
 * `pendant-operator` a person at the FlexPendant; `uas-administrator` a user
 * with 'Manage UAS settings'; `current-holder` the tool, station or client
 * that holds access now; `integrator` the owner of the I/O and
 * system-parameter configuration; `key-switch` the operating-mode selector
 * at the controller; `cell-safety` the Reset, the enabling device or the
 * safety circuit; `abb-option` a RobotWare option or licence; `this-tool`
 * the caller itself; `nobody` not possible from a remote tool.
 */
export type RefusalGrantor =
  | 'pendant-operator' | 'uas-administrator' | 'current-holder' | 'integrator'
  | 'key-switch' | 'cell-safety' | 'abb-option' | 'this-tool' | 'nobody';

/**
 * A UAS grant a refusal names: the identifier the controller checks and the
 * name RobotStudio shows. `labelEvidence` says how the two are paired: `abb`
 * when an ABB document names the identifier for the action, `name-match` when
 * they are paired only because the names match (sentences then say
 * "probably").
 */
export interface RefusalGrant {
  id: string;
  label: string;
  labelEvidence: 'abb' | 'name-match';
}

/**
 * Who holds the access the operation needed, as the controller reported it.
 * `local` is the FlexPendant; `internal` the controller itself (an operation
 * in progress); `remote` another RWS client; `unknown` a holder the status
 * names without saying what it is (RobotWare 8 names only the station).
 * Control-station ids are never included: they are compared, never shown.
 */
export interface RefusalHolder {
  kind: 'remote' | 'local' | 'internal' | 'plc' | 'self' | 'unknown';
  /** RobotWare 8: the holding control station's name. */
  name?: string;
  /** RobotWare 6/7: the holder's user id from the mastership status. */
  id?: string;
  application?: string;
  location?: string;
  alias?: string;
  /**
   * True when the holder is the FlexPendant, in the two forms the
   * controllers were seen to name it: RobotWare 7 reports the pendant's
   * mastership as kind `local` with application `TPU` (RW 7.21.4,
   * 2026-10-18), RobotWare 8 reports its write access as held by the station
   * `FlexPendant` (kind `unknown`; RW 8.2.1, 2026-10-18). Both compared
   * without case or surrounding blanks. No other form is marked: not a
   * `remote` holder with application `TPU`, not a station named `TPU`.
   * The client sets it on every holder it reports that is the pendant and
   * leaves it out for any other; the other fields stay as the controller gave
   * them. A RobotWare 6 pendant holder has not been observed: a `local`
   * holder without application `TPU` is not marked.
   */
  isPendant?: boolean;
}

/** The controller's own answer behind a refusal. */
export interface RefusalController {
  /** `METHOD /path` of the refused request, without its query string. */
  request?: string;
  http?: number;
  /** The controller's code, in decimal. */
  code?: number;
  /** The same code as ABB's documents and forums write it, e.g. `0xC004841A`. */
  hex?: string;
  /** The code's name in ABB's return-code lists, when this client knows it. */
  name?: string;
  /** The controller's inner code (`icode`) from its message, when present. */
  icode?: number;
  /** The controller's message, cleaned of build-path noise. */
  message?: string;
}

/**
 * Who carries out a remedy (`RefusalRemedy.byWhom`). The client itself never
 * does.
 *
 * - `person-confirms-in-a-tool`: a client method does it (`call`), called by a
 *   tool only after a person confirms there.
 * - `person-at-this-tool`: the person changes the input, or runs the operation
 *   again.
 * - `person-at-pendant`: a person at the robot: the FlexPendant, the mode
 *   selector, a safety reset.
 * - `other-station`: the current holder of the access: another tool, a PLC,
 *   another session.
 * - `administrator`: a UAS administrator.
 * - `integrator`: the owner of the I/O and system-parameter configuration.
 * - `none`: nobody can supply it from a remote tool.
 */
export type RemedyActor =
  | 'person-confirms-in-a-tool'
  | 'person-at-this-tool'
  | 'person-at-pendant'
  | 'other-station'
  | 'administrator'
  | 'integrator'
  | 'none';

/**
 * The kind of a remedy (`RefusalRemedy.kind`). A consumer shows a kind it does
 * not know as text (`label`, `detail`), never as a button. More kinds may be
 * added in minor releases.
 */
export type RemedyKind =
  | 'declare-motion-control' | 'request-rmmp' | 'grant-rmmp-at-pendant' | 'remote-access-on'
  | 'release-pendant-write-access' | 'release-pendant-mastership' | 'holder-releases'
  | 'release-own-hold' | 'stop-program-first' | 'motors-on' | 'reset-safety-stop' | 'mode'
  | 'confirm-mode-change' | 'do-at-pendant' | 'grant-missing' | 'signal-access-level' | 'run-again'
  | 'reconnect' | 'fix-input' | 'check-state' | 'wait' | 'nothing-needed' | 'option-missing'
  | 'not-available' | 'report' | 'none-known';

/**
 * The one client call a `person-confirms-in-a-tool` remedy names, as data:
 * `RobotManager.setAllowMotionControl(true)`, `requestRmmp(level)`,
 * `stopRapid()` or `setMotorsOn()`. Flat, with no arrays, so it survives a
 * consumer that passes refusals on as bounded JSON. The client never makes the
 * call itself.
 */
export type RemedyCall =
  | { method: 'setAllowMotionControl'; allow: true }
  | { method: 'requestRmmp'; level: 'modify' | 'exec' }
  | { method: 'stopRapid' }
  | { method: 'setMotorsOn' };

/**
 * The next step of a refusal (`RwsRefusal.remedy`): what to do, who does it,
 * where, and how far it reaches. It explains; the client never carries it
 * out. A remedy with a `call` is for a person's action in a tool, after
 * `confirmationFor`'s text; a consumer that cannot act shows a remedy without
 * a `call` as the step.
 */
export interface RefusalRemedy {
  kind: RemedyKind;
  byWhom: RemedyActor;
  /** Short and tool-neutral, e.g. "Allow motion control". Each consumer names its own button. */
  label: string;
  /** Who does what, where, in the client's own words. Never controller-supplied text such as a holder's station name: that stays in `refusal.holder`. */
  detail: string;
  appliesTo: {
    generation: 'rw6' | 'rw7' | 'rw8' | null;
    /**
     * How far the remedy reaches once done: this `session`, the control
     * `station` (RobotWare 8; possibly wider than one session), the whole
     * `controller`, the UAS `user`, the cell's `configuration`, or this one
     * `operation`.
     */
    scope: 'session' | 'station' | 'controller' | 'user' | 'configuration' | 'operation';
    /** `METHOD /path` of the refused request, when the controller refused one. */
    operation?: string;
  };
  /** Only for `byWhom` `person-confirms-in-a-tool`, and always there for it. */
  call?: RemedyCall;
  /** Only on `declare-motion-control`: a person's safety confirmation. Never automated. */
  safetyDeclaration?: true;
  /** After the remedy: the person runs the refused operation again, or nothing. Never the client. */
  afterwards: 'run-again' | 'nothing';
  /** How sure the remedy is, as for `RwsRefusal.evidence`. */
  evidence: 'abb' | 'vc' | 'field' | 'unverified';
  /** The ABB document or the run it rests on, short. */
  basis: string;
}

/**
 * The text a tool shows a person before it makes a remedy's call
 * (`confirmationFor`). The client never shows or calls it itself.
 */
export interface RemedyConfirmation {
  /** e.g. "Allow Motion Control on IRB1600 (127.0.0.1:80)". */
  title: string;
  /** The client's lines, one fact each. A consumer shows them verbatim, and may add its own after them. */
  lines: string[];
  /** The confirming button. */
  confirmLabel: string;
  /** True: after the button, the person types the robot's name. */
  typeName: boolean;
  /** The question for that box, so every consumer asks the same; null when no name is typed. */
  typePrompt: string | null;
}

/**
 * A refusal in plain words (`RwsError.refusal`): what kind it is, which
 * condition is missing, who can supply it and what they do, and the
 * controller's own answer. `sentence` is the whole explanation for a person;
 * `RwsError.message` is `sentence` followed by the controller detail.
 *
 * An explanation is only as sure as `evidence`: `abb` (an ABB document),
 * `vc` (seen on virtual controllers), `field` (community reports) or
 * `unverified` (inferred). A refusal is never permission, and never a
 * reason to retry: supply the condition first.
 */
export interface RwsRefusal {
  kind: RefusalKind;
  condition: RefusalCondition;
  /** RobotWare generation of the controller, or null when not known yet. */
  generation: 'rw6' | 'rw7' | 'rw8' | null;
  /** The missing condition, in plain words. */
  missing: string;
  /** Who can supply it; null when the reason is not known. */
  grantor: RefusalGrantor | null;
  /** Who does what, and where, in plain words. */
  fix: string;
  /** The whole explanation for a person. */
  sentence: string;
  /** For `grant-missing`: the grant, or the candidate grants. */
  grants?: RefusalGrant[];
  /** For `held-by-other`: the holder, when the controller named one. */
  holder?: RefusalHolder;
  /** For `grant-missing`: the UAS user the controller refused. */
  user?: string;
  controller: RefusalController;
  evidence: 'abb' | 'vc' | 'field' | 'unverified';
  /**
   * The next step (`RefusalRemedy`). Every refusal this client builds carries
   * one. Optional in the type, so code that builds `RwsRefusal` values still
   * compiles.
   */
  remedy?: RefusalRemedy;
  /** Other ways, in the order the sentence names them. */
  otherRemedies?: RefusalRemedy[];
}

/**
 * What a caller knows about the controller when a refusal is explained
 * (`explainRefusal`). Every field is optional; an unknown field leaves the
 * explanation general. `RobotManager` supplies it from its state for every
 * error of its session.
 */
export interface RefusalContext {
  generation?: 'rw6' | 'rw7' | 'rw8' | null;
  /** Operating mode as last read: 'AUTO', 'MANR', 'MANF', ... */
  opmode?: string | null;
  /** Controller state as last read: 'motoron', 'motoroff', 'guardstop', ... */
  ctrlstate?: string | null;
  /** This session's RMMP: granted, a request waiting at the FlexPendant, or none. */
  rmmp?: 'granted' | 'pending' | 'none' | null;
  /** Controller name, for the sentence. */
  robot?: string | null;
  /** The UAS user this session logged in as. */
  user?: string | null;
  rwVersion?: string | null;
  /** True for a virtual controller, false for a real one. */
  virtual?: boolean | null;
  /** RobotWare 8: whether this session is a registered control station. */
  registered?: boolean | null;
  /** The holder of the access, when the caller has read it. */
  holder?: RefusalHolder | null;
}

/**
 * Typed error thrown by all abb-rws-client public methods.
 * Always check `code` for programmatic error handling.
 */
export class RwsError extends Error {
  readonly code: RwsErrorCode;
  readonly httpStatus?: number;
  readonly rwsDetail?: string;
  /** Controller-native status code from the error body (e.g. -1073445862), when present. */
  readonly controllerCode?: number;
  /** Controller-native message from the error body, cleaned of build-path noise. */
  readonly controllerMsg?: string;
  /**
   * The refusal in plain words, for an error that is a refusal: the missing
   * condition, who can supply it, a sentence, and the controller's answer.
   * Absent for errors that are not refusals (a missing resource, a network
   * failure). See `RwsRefusal`.
   */
  readonly refusal?: RwsRefusal;
  /**
   * The controller's answer body, as received. Some refusals carry more than
   * the code and message: a subscription group PUT answered 400 lists the
   * resources it bound anyway (see `SubscriptionUpdateError`). Set in two
   * places only: on the error the RWS 2.0 client's request path builds from
   * an HTTP error answer (status 400 and above) read in full, no longer than
   * its `maxResponseBytes` (a longer answer is refused before it is read in
   * full); and on every `SubscriptionUpdateError`, on both generations.
   * Absent otherwise, even where an HTTP answer was read: RWS 1.0 errors keep
   * the body in `rwsDetail`, the RWS 2.0 subscription create (`subscribe()`)
   * does not set it, and an error rebuilt from another (a refusal explained
   * with more context, a step of a several-step operation reported, an error
   * reworded by `RobotManager`) does not carry it over.
   */
  readonly responseBody?: string;

  constructor(
    message: string, code: RwsErrorCode, httpStatus?: number, rwsDetail?: string,
    controllerCode?: number, controllerMsg?: string, refusal?: RwsRefusal,
    responseBody?: string,
  ) {
    super(message);
    this.name = 'RwsError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.rwsDetail = rwsDetail;
    this.controllerCode = controllerCode;
    this.controllerMsg = controllerMsg;
    if (refusal) { this.refusal = refusal; }
    if (responseBody !== undefined) { this.responseBody = responseBody; }
    // Restore prototype chain so instanceof checks work correctly when targeting ES2022
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Internal types (not re-exported from index.ts) ─────────────────────────

/** @internal Parsed fields from a WWW-Authenticate: Digest ... header (RFC 2617) */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  /** 'auth' | 'auth-int' - if absent, use RFC 2069 compat mode */
  qop?: string;
  /** Hash algorithm - typically 'MD5' (default) */
  algorithm?: string;
  stale?: boolean;
  domain?: string;
}

/** @internal Return type for all HttpSession HTTP methods */
export interface HttpResponse {
  status: number;
  body: string;
  headers: Headers;
}

/**
 * Read the substituted arguments out of one parsed event-log message.
 *
 * The two representations carry them differently and neither is documented:
 *   hal+json / ?json=1 : "argv":[{"type":"long","value":100}, ...]
 *   XHTML              : <span class="arg1" type="long">100</span> ...
 * Handles both, on both protocol generations. Returns [] when the message
 * takes no arguments, which is the common case.
 */
export function decodeElogArgs(fields: Record<string, unknown>): ElogArg[] {
  const raw = fields['argv'];
  // RWS 1.0's ?json=1 path hands over the parsed array; the hal+json parser
  // keeps it as a JSON string. Accept either.
  const list: unknown = typeof raw === 'string' && raw
    ? ((): unknown => { try { return JSON.parse(raw); } catch { return undefined; } })()
    : raw;
  if (Array.isArray(list)) {
    return (list as Array<{ type?: unknown; value?: unknown }>).map(a => ({
      type: String(a?.type ?? ''),
      value: String(a?.value ?? ''),
    }));
  }
  const count = Number(fields['argc'] ?? 0);
  if (!Number.isFinite(count) || count <= 0) { return []; }
  const out: ElogArg[] = [];
  for (let i = 1; i <= count; i++) {
    const v = fields[`arg${i}`];
    if (v === undefined) { continue; }
    out.push({ type: '', value: String(v) });
  }
  return out;
}

// ─── Endpoint-completion additions (2026-08-09) ──────────────────────────────
// Every shape below was read off a controller's own OPTIONS form, not the
// specification.

/**
 * What `RwsClient2.subscribe()` returns: call it to unsubscribe, exactly as
 * before, but it also carries the group's resource path so the group can be
 * edited in place via `updateSubscriptionGroup` / `unsubscribeResource`.
 *
 * `groupPath` is read live rather than snapshotted - a reconnect mints a new
 * group - and is `''` while no group is currently held.
 *
 * `unbound` (since 1.5.0) lists the resources the controller left out of the
 * group it holds now: the resources the create answer's status blocks name,
 * as the request sent them on both protocols (on RWS 2.0 a status block
 * that names only the path stands for every resource sent on it), other
 * than the panel resources (a refused panel resource is re-created in its
 * other spelling, and fails the subscribe when it is refused in both). No
 * event ever comes for them; read them some other way. RW 6.16.03 left
 * `/rw/elog/0` out of RobotManager's group this way while answering 201
 * (2026-10-22). Read live like `groupPath`: each group a reconnect creates is
 * judged on its own answer. Optional so a handle built for 1.4.0 still is
 * one; absent means nothing was found refused. The RWS 1.0 adapter's handle
 * carries it too (it has no `groupPath`).
 */
export type SubscriptionHandle = (() => Promise<void>) & {
  readonly groupPath: string;
  readonly unbound?: readonly string[];
};

/**
 * Criteria for POST /rw/iosystem/signals/signal-search-ex.
 *
 * The OPTIONS form (live-read 2026-08-09 on RW7.21 and RW8.1.1) advertises every
 * field twice - `name`/`name2`, `device`/`device2`, ... - so the controller
 * takes up to TWO criteria sets. The second set NARROWS the first (logical AND),
 * it does not union with it. Live-verified 2026-08-09 on RW8.1.1:
 *   type=DI            -> 33 signals
 *   type=DO            -> 39 signals
 *   type=DI & type2=DI -> 33 signals   (intersection with itself)
 *   type=DI & type2=DO ->  0 signals   (nothing is both)
 * An empty body returns everything. `name` matches literally - there is no glob
 * support, and `name=*` returns 0 rather than all.
 */
export interface SignalSearchExCriteria {
  name?: string;
  device?: string;
  network?: string;
  category?: string;
  /** Maps to the form's `category-pon` field. */
  categoryPon?: string;
  type?: string;
  /**
   * Negate this criteria set (sent as `invert` for the first set, `invert2`
   * for the second): the set matches every signal the other criteria of the
   * set would NOT match. It is not a filter for inverted signals. With no
   * other criterion in the set it matches nothing. Live-verified 2026-09-29 on
   * RW 6.16.03, 7.21.4 and 8.2.1 (on 8.2.1: `type=DO` + `invert` → every
   * non-DO signal; `type=DO` then `name2=IIO` + `invert2` → the DOs whose
   * names do not start with IIO).
   */
  invert?: boolean;
  blocked?: boolean;
}

/**
 * Request for POST /rw/cfg/validate-instances.
 *
 * This validates CFG instances that ALREADY EXIST; it is not a dry run for
 * instances you are about to create. Live-verified 2026-08-09 on RW8.1.1: an
 * existing signal name (`ASI_C1_PIN8_DI`) answers 204, while every synthetic
 * name and every `-Name "..." -SignalType "..."` instance body answers 200 with
 * "Instance name not found, or the type is not named".
 */
export interface CfgValidateRequest {
  /**
   * The form's `operation` field - numeric, NOT a verb. The controller accepts
   * only 0 and 1 and rejects every other value (including 'add', 'update',
   * 'validate' and any integer outside 0..1) with
   * "Invalid operation parameter value". Live-verified 2026-08-09.
   */
  operation: 0 | 1;
  /** The form's `cfgdomain` field, e.g. 'EIO', 'MOC', 'SYS'. */
  domain: string;
  /** The form's `cfgtype` field, e.g. 'EIO_SIGNAL'. */
  type: string;
  /** Names of existing instances; sent as `instances`, `instancescount` derived. */
  instances: string[];
}

/**
 * ModPos - POST /rw/rapid/tasks/{task}/modules/{module}/modify-position.
 * Form fields live-read 2026-08-09 on RW7.21.
 */
export interface ModifyPositionOptions {
  startRow: number;
  startCol: number;
  endRow?: number;
  endCol?: number;
  /** Form field `checklimit`. */
  checkLimit?: boolean;
  /** Form field `checkdeactaxes`. */
  checkDeactAxes?: boolean;
  /** Form field `allowdeact`. */
  allowDeact?: boolean;
  /** Form field `text`. */
  text?: string;
}

/**
 * Query parameters passed through, URL-encoded, to an RWS 2.0 module
 * sub-resource read whose parameters ABB does not document
 * (getModuleModPossible, getModuleSymbolInfo, getModuleAttributes,
 * getModuleObject), e.g. `{ startrow: 1, startcol: 1, endrow: 26, endcol: 1 }`.
 * Values must be strings or finite numbers.
 */
export type RapidModuleQuery = Readonly<Record<string, string | number>>;

/** A saved-diagnostics record from GET /ctrl/diagnostics. */
export interface DiagnosticsInfo {
  /** True when the controller has no diagnostics saved yet (it answers 400). */
  empty: boolean;
  entries: Array<Record<string, string>>;
}

/**
 * POST /users/register - form fields live-read 2026-08-09
 * (`application`, `username`, `location`, `ulocale`).
 */
export interface UserRegistration {
  application: string;
  username: string;
  location: string;
  /**
   * Form field `ulocale`: whether the session registers as a `local` or a
   * `remote` client. ABB marks it required and gives these two values (RWS
   * 1.0 Rev M and RWS 2.0 Rev L); `local` is accepted only from the service
   * port or the FlexPendant port. A remote tool passes `'remote'`. A given
   * string is sent as it is, as in 1.4.0, and the controller decides; when it
   * answers 400 to a value other than those two, the error names them.
   * Without it the request carries no `ulocale`, as in 1.4.0. Typed
   * `string`, as in 1.4.0; a value that is not a string is refused before
   * sending (`INVALID_ARGUMENT`).
   */
  locale?: string;
}

/**
 * The answer to `getCompatibility(robotWareVersion?)`: ABB's
 * `ctrl-compatibility` entry, whose `status` says whether the controller
 * hardware can run that RobotWare version. It keeps the two fields the
 * RWS 1.0 method returned in 1.4.0, `compatible` and `details` (now always
 * present), and adds `status`.
 */
export interface RobotWareCompatibility {
  /** True when the controller answered `status` true, false when it answered false. */
  compatible: boolean;
  /** The `status` value as the controller sent it. */
  status: string;
  /** The whole `ctrl-compatibility` entry as the controller sent it. */
  details: Record<string, string>;
}
