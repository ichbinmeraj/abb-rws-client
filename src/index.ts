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
  ExecutionInfo,
  ExecutionCycle,
  JointTarget,
  RobTarget,
  CartesianFull,
  Signal,
  RapidTask,
  IoNetwork,
  IoDevice,
  SystemInfo,
  ControllerIdentity,
  ControllerClock,
  ElogMessage,
  FileEntry,
  MastershipDomain,
  CollisionDetectionState,
  RapidSymbolProperties,
  RapidSymbolInfo,
  RapidSymbolSearchParams,
  UiInstruction,
  RestartMode,
  SubscriptionResource,
  SubscriptionEvent,
} from './types.js';
