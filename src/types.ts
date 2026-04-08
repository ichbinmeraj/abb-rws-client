// abb-rws-client — type definitions
// Targets RWS 1.0 (RobotWare 6.x) only. Not compatible with RWS 2.0 / RobotWare 7.x / OmniCore.

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
}

export type SubscriptionResource =
  | 'execution'
  | 'controllerstate'
  | 'operationmode'
  | { type: 'signal'; name: string }
  | { type: 'persvar'; name: string };

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
