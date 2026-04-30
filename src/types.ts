// abb-rws-client — type definitions
// Targets RWS 1.0 (RobotWare 6.x) only. Not compatible with RWS 2.0 / RobotWare 7.x / OmniCore.
// v0.5.0 — added: UI instructions, RAPID symbol search, controller clock, execution cycle in state, task activate/deactivate, elog seqnum, subscription coldetstate/execycle/elog/uiinstr, opmode lock, controller restart

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
  /** Timestamp when RobotWare started */
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

export interface ElogMessage {
  /** Sequence number */
  seqnum: number;
  /** Event code, e.g. 10126 */
  code: number;
  /** 1 = info, 2 = warning, 3 = error */
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
  /** Stack URL — used as {stackurl} when setting a parameter value */
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
export type RestartMode = 'restart' | 'istart' | 'pstart' | 'bstart';

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

export type MastershipDomain = 'cfg' | 'motion' | 'rapid';

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
  /** Default 'Default User' */
  username?: string;
  /** Default 'robotics' */
  password?: string;
  /** Minimum ms between requests; default 55ms (enforces <20 req/sec RWS rate limit) */
  requestIntervalMs?: number;
  /** Request timeout in ms; default 5000 */
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

export interface SubscriptionEvent {
  resource: string;
  value: string;
  timestamp: Date;
}

export type RwsErrorCode =
  | 'SESSION_EXPIRED'
  | 'AUTH_FAILED'
  | 'MOTORS_OFF'
  | 'MODULE_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CONTROLLER_BUSY'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'
  | 'UNKNOWN';

/**
 * Typed error thrown by all abb-rws-client public methods.
 * Always check `code` for programmatic error handling.
 */
export class RwsError extends Error {
  readonly code: RwsErrorCode;
  readonly httpStatus?: number;
  readonly rwsDetail?: string;

  constructor(message: string, code: RwsErrorCode, httpStatus?: number, rwsDetail?: string) {
    super(message);
    this.name = 'RwsError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.rwsDetail = rwsDetail;
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
  /** 'auth' | 'auth-int' — if absent, use RFC 2069 compat mode */
  qop?: string;
  /** Hash algorithm — typically 'MD5' (default) */
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
