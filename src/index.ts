/**
 * abb-rws-client — public API
 *
 * Typed HTTP/WebSocket client for ABB robot controllers, covering BOTH RWS protocols:
 *   - RWS 1.0 — IRC5 / RobotWare 6.x   → use `RwsClient` (HTTP Digest, JSON via ?json=1)
 *   - RWS 2.0 — OmniCore / RobotWare 7.x → use `RwsClient2` (HTTP Basic, XHTML;v=2.0)
 *
 * Don't know which protocol the controller speaks? Use `createClient(host)` —
 * it probes the WWW-Authenticate header and returns the right one.
 *
 * For polymorphic code that wants a single type across both protocols, use
 * the `IRWSAdapter` interface and the `RWS1Adapter` / `RWS2Adapter` wrappers
 * — or the `createAdapter(host)` helper.
 *
 * Higher-level helpers:
 *   - `RobotManager` — connection lifecycle, polling, WS subscriptions, port discovery
 *   - `MultiRobotManager` — multi-controller orchestration
 *   - `XhtmlParser` — RWS 2.0 response parser (exported for advanced users)
 *   - `setLogger(impl)` — install your own logging backend
 */

// Protocol clients
export { RwsClient } from './RwsClient.js';
export { RwsClient2 } from './RwsClient2.js';

// Unified-interface adapters
export { RWS1Adapter } from './RWS1Adapter.js';
export { RWS2Adapter } from './RWS2Adapter.js';
export type { IRWSAdapter } from './IRWSAdapter.js';

// High-level managers
export { RobotManager } from './RobotManager.js';
export type { RobotState, ChangeHandler, ProbeResult, DiscoveredController, ErrorListener, RobotManagerOptions } from './RobotManager.js';
export { MultiRobotManager } from './MultiRobotManager.js';
export type { RobotConfig } from './MultiRobotManager.js';

// mDNS/Bonjour discovery (also reachable as RobotManager.discoverControllersMdns)
export { discoverControllersMdns } from './MdnsDiscovery.js';
export type { MdnsController, MdnsDiscoveryOptions } from './MdnsDiscovery.js';

// Auto-detection helpers
export { createClient, createAdapter, probeHost, probeProtocol } from './detect.js';
export type { AnyClient, Protocol, ConnectOptions, ProbeResult as DetectProbeResult } from './detect.js';

// Helpers
export { XhtmlParser } from './XhtmlParser.js';
export { setLogger } from './Logger.js';
export type { Logger } from './Logger.js';

// Errors
export { RwsError } from './types.js';

// Type exports (preserved from v0.6.0 + new additions)
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
