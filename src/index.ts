/**
 * abb-rws-client - public API
 *
 * Typed HTTP/WebSocket client for ABB robot controllers, covering BOTH RWS protocols:
 *   - RWS 1.0 - IRC5 / RobotWare 6.x   → use `RwsClient` (HTTP Digest, JSON via ?json=1)
 *   - RWS 2.0 - OmniCore / RobotWare 7.x → use `RwsClient2` (HTTP Basic, XHTML;v=2.0)
 *
 * Don't know which protocol the controller speaks? Use `createClient(host)` -
 * it probes the WWW-Authenticate header and returns the right one.
 *
 * For polymorphic code that wants a single type across both protocols, use
 * the `IRWSAdapter` interface and the `RWS1Adapter` / `RWS2Adapter` wrappers
 * - or the `createAdapter(host)` helper.
 *
 * Higher-level helpers:
 *   - `findControllers(options)` - find controllers on this PC and, when asked, on the network
 *   - `RobotManager` - connection lifecycle, polling, WS subscriptions, port discovery
 *   - `MultiRobotManager` - multi-controller orchestration
 *   - `XhtmlParser` - RWS 2.0 response parser (exported for advanced users)
 *   - `setLogger(impl)` - install your own logging backend
 */

// Protocol clients
export { RwsClient } from './RwsClient.js';
export type { WsSubscribeOptions } from './WsSubscriber.js';
export { RwsClient2 } from './RwsClient2.js';

// Unified-interface adapters
export { RWS1Adapter } from './RWS1Adapter.js';
export { RWS2Adapter } from './RWS2Adapter.js';
export type { IRWSAdapter, IRWSAdapterCore } from './IRWSAdapter.js';

// High-level managers
export { RobotManager } from './RobotManager.js';
// The reads RobotManager.read(name, ...args) takes, by name
export { ADAPTER_READ_NAMES } from './adapterReads.js';
export { CONTROLLER_JOB_NAMES } from './controllerJobs.js';
export type { ControllerJobName } from './controllerJobs.js';
export type { AdapterReads, AdapterReadName, EventLogDomain } from './adapterReads.js';
export type { RobotState, ChangeHandler, ProbeResult, DiscoveredController, ErrorListener, RobotManagerOptions } from './RobotManager.js';
export { MultiRobotManager } from './MultiRobotManager.js';
export type { RobotConfig } from './MultiRobotManager.js';

// Controller discovery: every source, one merged entry per controller
// (also reachable as RobotManager.findControllers)
export { findControllers } from './discovery/findControllers.js';
export { discoveryKey, isLocalAddress } from './discovery/addresses.js';
export type {
  FindControllersOptions,
  FindControllersResult,
  FoundController,
  FoundAddress,
  ControllerSource,
  ManualTarget,
  DiscoveryProgress,
  LocalScanStatus,
  LocalScanReport,
  DiscoveredProbe,
} from './discovery/types.js';

// mDNS/Bonjour discovery (also reachable as RobotManager.discoverControllersMdns)
export { discoverControllersMdns } from './MdnsDiscovery.js';
export type { MdnsController, MdnsDiscoveryOptions } from './MdnsDiscovery.js';

// Auto-detection helpers
export { createClient, createAdapter, probeHost, probeProtocol } from './detect.js';
export type { AnyClient, Protocol, ConnectOptions, ProbeResult as DetectProbeResult } from './detect.js';

// RobotWare 8 control-station identity (ConnectOptions, RobotManagerOptions, RobotConfig)
export type { ControlStationIdentity } from './controlStation.js';

// What a session holds (RobotState.access) and how it changes (onAccessEvent)
export type {
  AccessState,
  AccessLockState,
  AccessLockStatus,
  AccessLock,
  AccessGeneration,
  AccessEvent,
  AccessLossReason,
  AccessRiskReason,
  AccessWarningKind,
  MotionControlCause,
} from './access/AccessManager.js';
export type { WatchdogState as AccessWatchdogState } from './access/MastershipWatchdog.js';
// RobotWare 8: what RobotManager.getLocalStationStatus() returns
export type { LocalStationStatus } from './access/motionControl.js';

// Helpers
export { XhtmlParser } from './XhtmlParser.js';
export { setLogger } from './Logger.js';
export type { Logger } from './Logger.js';

// Errors
export { RwsError } from './types.js';
// A subscription group edit answered 400, with the resources bound anyway
export { SubscriptionUpdateError } from './subscriptionUpdateError.js';
// Refusals in plain words (RwsError.refusal), and refining one with what the caller knows
export { explainRefusal } from './refusal.js';
// The next step of a refusal (RwsRefusal.remedy), and the text a tool shows a
// person before it makes a remedy's call. The client never makes the call.
export { confirmationFor } from './refusal.js';
export type {
  RwsRefusal,
  RefusalKind,
  RefusalCondition,
  RefusalGrantor,
  RefusalGrant,
  RefusalHolder,
  RefusalController,
  RefusalContext,
  RefusalRemedy,
  RemedyActor,
  RemedyKind,
  RemedyCall,
  RemedyConfirmation,
} from './types.js';

// Joint-value helpers (the 9E9 "no axis in this slot" marker)
export { JOINT_NOT_PRESENT, isJointValuePresent } from './mechunit.js';

// Type exports (preserved from v0.6.0 + new additions)
export type {
  RwsClientOptions,
  RwsErrorCode,
  ConnectionQuality,
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
  ElogArg,
  ReturnCodeInfo,
  FileEntry,
  MastershipDomain,
  CollisionDetectionState,
  RapidSymbolProperties,
  RapidSymbolInfo,
  RapidSymbolSearchParams,
  UiInstruction,
  RestartMode,
  SubscriptionResource,
  // SubscriptionResource and the kinds added in 1.5.0 (mastership, motion error state)
  AnySubscriptionResource,
  SubscriptionEvent,
  // Endpoint-completion additions (2026-08-09)
  SubscriptionHandle,
  SignalSearchExCriteria,
  CfgValidateRequest,
  ModifyPositionOptions,
  RapidModuleQuery,
  DiagnosticsInfo,
  UserRegistration,
  RobotWareCompatibility,
  // Motion sampling additions (2026-09-25)
  JointTargetFull,
  MechunitDetails,
  // RMMP and jog (1.4.0)
  RmmpLevel,
  RmmpOutcome,
  RmmpRequestOptions,
  RmmpResult,
  JogIncrement,
  JogParams,
  // Common reads on both generations (2026-10-01)
  CfgTypeInfo,
  DipcQueueInfo,
  FileMetadata,
  RapidRoutineInfo,
  // Niche reads on both generations (2026-10-01)
  SubscriptionGroupInfo,
  SubscriptionGroupMember,
  MotionSupervisionState,
  PathSupervisionState,
  MechunitMotorCalib,
  LeadThroughState,
  // Task motion sub-reads, RWS 2.0 (2026-10-03)
  TaskRobTarget,
  TaskMechunit,
  // RobotWare 8 write-access status (RobotManager.getWriteAccessStatus)
  WriteAccessStatus,
  // A task's build errors (getBuildErrors, 1.5.0)
  RapidBuildError,
} from './types.js';
