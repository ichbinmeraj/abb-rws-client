/**
 * abb-rws-client — public API
 *
 * Typed HTTP/WebSocket client for ABB IRC5 robot controllers (RWS 1.0, RobotWare 6.x only).
 * Not compatible with RWS 2.0 / RobotWare 7.x / OmniCore.
 */

export { RwsClient } from './RwsClient.js';
export { RwsError } from './types.js';

export type {
  RwsClientOptions,
  RwsErrorCode,
  ControllerState,
  OperationMode,
  ExecutionState,
  JointTarget,
  RobTarget,
  Signal,
  RapidTask,
  SubscriptionResource,
  SubscriptionEvent,
} from './types.js';
