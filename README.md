# abb-rws-client

A typed TypeScript/Node.js client for **ABB Robot Web Services** — both protocols ABB ships:

- **RWS 1.0** — IRC5 / RobotWare 6.x → `RwsClient`
- **RWS 2.0** — OmniCore / RobotWare 7.x → `RwsClient2`

> **Compatibility:** dual-protocol since v0.7.0. Single-line auto-detection via `createClient()` if you don't know which one your controller speaks.

---

## VS Code Extension

Prefer a GUI? The companion VS Code extension gives you live status, motion data, RAPID control, I/O signals, event log, file management, and CFG database editing directly from the sidebar — no code required. Works against both IRC5 and OmniCore.

**[ABB Robot (RWS) — VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=merajsafari.abb-rws)**

---

## Features

- **Dual-protocol** — RWS 1.0 (Digest, JSON) and RWS 2.0 (Basic, XHTML;v=2.0)
- **Auto-detection** — `createClient(host)` probes the auth challenge and returns the right client
- **Multi-robot** — `MultiRobotManager` for orchestrating several controllers in one process
- **Connection lifecycle** — `RobotManager` handles port discovery, polling, WebSocket subscriptions with polling fallback, reconnect-on-failure
- **Typed adapter pattern** — `IRWSAdapter` lets you write code that works across both protocols
- **WebSocket subscriptions** for real-time events (panel state, RAPID exec, signals, persvar, elog, jointtarget, …)
- Session cookie management (IRC5: avoids the controller's 70-session pool fill; OmniCore: avoids 503 lockout from session-pool exhaustion)
- Automatic `/logout` on disconnect to release server-side mastership and free the session slot
- Request rate limiting (< 20 req/sec)
- Fully typed public API — every method throws `RwsError` with a typed `code`
- Single dependency: `ws` (only one we don't reimplement)

---

## Installation

```bash
npm install abb-rws-client
```

**Requirements:** Node.js 18+.

---

## Quick Start (auto-detect)

The simplest path: `createClient` probes the controller and returns the right protocol's client.

```ts
import { createClient, RwsClient2 } from 'abb-rws-client';

const client = await createClient({
  host: '192.168.125.1',
  // username/password default to 'Admin' / 'robotics' (built-in admin account, full UAS grants)
});

console.log(`Connected via ${client instanceof RwsClient2 ? 'RWS 2.0' : 'RWS 1.0'}`);

const state = await client.getControllerState();   // 'motoron' | 'motoroff' | …
const mode  = await client.getOperationMode();     // 'AUTO' | 'MANR' | 'MANF'
const joints = await client.getJointPositions();   // { rax_1, …, rax_6 }

await client.disconnect();
```

If you only target one protocol, skip the helper and instantiate the client directly. See [`examples/`](./examples/) for runnable scripts.

---

## Choosing a client

| Controller | Protocol | Class | Auth | Default port |
|---|---|---|---|---|
| **IRC5** (RobotWare 6.x) | RWS 1.0 | `RwsClient` | HTTP Digest | 80 (real), 80 / 11811 (VC) |
| **OmniCore** (RobotWare 7.x) | RWS 2.0 | `RwsClient2` | HTTP Basic | 443 (real), 5466 (VC HTTPS) |

Both classes expose **the same method names** for ~140 endpoints (controller state, RAPID execution, modules, variables, motion, I/O, file service, CFG database, mastership, event log, etc.). The protocol differences (URL shapes, response format, mastership-domain naming, `$HOME` vs `HOME`) are handled internally — your code looks the same.

If you need a single typed reference that holds either:

```ts
import { createAdapter, type IRWSAdapter } from 'abb-rws-client';

const adapter: IRWSAdapter = await createAdapter({ host: '192.168.125.1' });
// adapter is RWS1Adapter or RWS2Adapter — both implement IRWSAdapter
```

---

## RWS 1.0 explicit usage

```ts
import { RwsClient, RwsError } from 'abb-rws-client';

const client = new RwsClient({
  host: '192.168.125.1',
  username: 'Admin',
  password: 'robotics',
});

await client.connect();

// Controller state
const state = await client.getControllerState(); // 'motoron' | 'motoroff' | ...
const mode  = await client.getOperationMode();   // 'AUTO' | 'MANR' | 'MANF'

// Motion
const joints    = await client.getJointPositions();    // rax_1..rax_6 in degrees
const tcp       = await client.getCartesianPosition(); // x/y/z mm + quaternion
const tcpConfig = await client.getCartesianFull();     // + j1/j4/j6/jx config flags

// RAPID
await client.startRapid();
await client.stopRapid();
await client.resetRapid(); // PP to Main

// Variables
const val = await client.getRapidVariable('T_ROB1', 'user', 'reg1');
await client.setRapidVariable('T_ROB1', 'user', 'reg1', '42');

// I/O signals
const signals = await client.listAllSignals();
await client.writeSignal('Local', 'DRV_1', 'DO_1', '1');

// Real-time subscriptions
const unsubscribe = await client.subscribe(
  ['execution', 'controllerstate', { type: 'signal', name: 'Local/DRV_1/DI_1' }],
  (event) => console.log(event.resource, '=', event.value),
);
await unsubscribe();

await client.disconnect();
```

---

## RWS 2.0 explicit usage

```ts
import { RwsClient2 } from 'abb-rws-client';

// RWS 2.0 takes a base URL (scheme + host + port).
//   Real OmniCore:  https://<host>:443
//   OmniCore VC:    https://127.0.0.1:5466
const client = new RwsClient2(
  'https://127.0.0.1:5466',
  'Admin',
  'robotics',
);

await client.connect();

// Same method names as RWS 1.0 — only the underlying protocol differs.
console.log('state:', await client.getControllerState());
console.log('joints:', await client.getJointPositions());

// RAPID variable read — RWS 2.0 symbol API uses suffix-style URLs internally
// (`/rw/rapid/symbol/{symburl}/data`); the method shape is the same.
const tool0 = await client.getRapidVariable('T_ROB1', 'BASE', 'tool0');

// WebSocket subscriptions over the `rws_subscription` subprotocol
// (RWS 1.0 uses `robapi2_subscription` — the names are NOT interchangeable:
// RobotWare 7 rejects the 1.0 name with HTTP 400).
const unsubscribe = await client.subscribe(
  ['controllerstate', 'execution'],
  (event) => console.log(event.resource, '=', event.value),
);

await unsubscribe();
await client.disconnect();
```

### Notable RWS 2.0 quirks (handled automatically)

These are documented because they bite anyone who tries to write an RWS 2.0 client from scratch:

- **HTTP Basic auth**, not Digest (RWS 1.0).
- **XHTML responses only** — `Accept: application/json` returns 406. Library uses `Accept: application/xhtml+xml;v=2.0`.
- **Path-based actions** — `/rw/rapid/execution/stop`, not `?action=stop`.
- **Mastership domains collapsed** — both `'rapid'` and `'cfg'` map to `'edit'`. The adapter maps internally so either name works.
- **File service home** is `'HOME'`, not `'$HOME'`.
- **Symbol API path is suffix-style** — `/rw/rapid/symbol/{symburl}/data` (RWS 1.0 puts `/data` at the front).
- **Module unload** is `POST /rw/rapid/tasks/{task}/unloadmod` with body, NOT `DELETE` on the module URL (returns 405).
- **Self-signed TLS** everywhere — controllers ship self-signed certs, so certificate
  verification is off by default. Pass `strictTls: true` (`RobotManagerOptions`) or
  `rejectUnauthorized: true` (`RwsClient2` options) if your plant installed real certs.
- **WebSocket subscription URL** comes from the `Location` header (real hardware) or the XHTML body (VC). Subprotocol: `rws_subscription` (RWS 2.0) / `robapi2_subscription` (RWS 1.0).

---

## Multi-robot orchestration

For applications that talk to several controllers, use `MultiRobotManager`:

```ts
import { MultiRobotManager } from 'abb-rws-client';

const multi = MultiRobotManager.fromConfigs([
  { id: 'cell-A', name: 'Cell A IRB120',  host: '192.168.125.1', port: 80,   useHttps: false, username: 'Admin', password: 'robotics' },
  { id: 'cell-B', name: 'Cell B IRB1200', host: '192.168.125.2', port: 443,  useHttps: true,  username: 'Admin', password: 'robotics' },
], {
  refreshIntervalMs: 1000, // polling cadence (min 200); slow poll scales at 5×
  strictTls: false,        // true = verify controller TLS certificates
});

multi.onError((msg, actions) => {
  console.error(`Robot error: ${msg}`);
  return Promise.resolve(undefined); // headless: just log
});

multi.onDidChange(() => {
  console.log(`active=${multi.activeId} state=${multi.state.ctrlstate}`);
});

for (const { id } of multi.entries) {
  await multi.connectRobot(id);
}
// One robot is "active" at a time (handy for UIs); state for all is polled.
multi.setActive('cell-B');
```

`MultiRobotManager` wraps individual `RobotManager` instances. Each `RobotManager` handles its own:
- Auto port discovery (probes 5466 / 9403 / 443 / 80 / 11811 in that order, plus a wide-scan fallback when none of those answer — RobotStudio assigns random VC ports above 30000)
- Protocol auto-detection (`WWW-Authenticate: Digest` → RWS 1.0; `Basic` → RWS 2.0)
- Hybrid polling cadence: **5× the refresh interval when WebSocket subscriptions are active** (positions only — state-change resources stream over WS); **the plain refresh interval when subscriptions are unavailable** (full state coverage via polling). Default 1 s / 5 s, configurable via `refreshIntervalMs`.
- WebSocket subscriptions on both protocols, with dropped-socket auto-reconnect and automatic degradation to fast polling if the event stream is terminally lost
- Reconnect-on-failure (3-strike, surfaces via `onError` listener)
- Clean `GET /logout` on disconnect — releases server-side mastership and frees the session slot

You can also create a `RobotManager` directly if you only have one robot.

---

## `RobotManager` — higher-level surface

`RobotManager` wraps either client with operational helpers that handle mastership, polling, and protocol differences for you. In addition to delegating every protocol method to the underlying client, it exposes:

- **`getRmmpPrivilege()`**, **`requestRmmp(level)`** — Remote Mastership Privilege management. Required on OmniCore in AUTO mode for any modify op.
- **`getMastershipStatus(domain?)`** — read who currently holds rapid/cfg/motion mastership (uid + application name).
- **`setOperationMode('AUTO' | 'MANR' | 'MANF')`** — VC-only switch with auto-routing through MANR for AUTO ↔ MANF (the controller rejects direct transitions). Acquires `edit` mastership for the higher-privilege direction.
- **`setSpeedRatio(0..100)`** — wraps `edit` mastership; uses the live-verified `?action=setspeedratio&speed-ratio=N` form on RWS 2.0 (the bare endpoint returns 400).
- **`createBackup(name)`**, **`restoreBackup(name)`**, **`getBackupStatus()`**, **`listBackups()`** — `/ctrl/backup/...`
- **`callServiceRoutine(task, name, args?)`** — invoke a service routine remotely (calibration, brake check, etc.).
- **`calcJointsFromCartesian(...)`** — inverse kinematics. **`calcCartesianFromJoints(...)`** — forward kinematics.
- **`setActiveTool(mechunit, name)`**, **`setActiveWobj(mechunit, name)`** — switch active persistent tooldata / wobjdata.
- **CFG write** — `setCfgInstance` / `createCfgInstance` / `removeCfgInstance` / `loadCfgFile` / `saveCfgFile`, on **both** protocols (RWS 2.0 uses `instances/create-default` + the bracket value representation; RWS 1.0 uses the `?action=` forms — handled by the adapters). Each acquires the needed mastership for the duration.
- **DIPC** — `listDipcQueues` / `createDipcQueue` / `sendDipcMessage` / `readDipcMessage` / `removeDipcQueue`. Bidirectional messaging between RAPID and external clients.
- **`listFileVolumes()`** — every controller volume (HOME, BACKUP, DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP).
- **`getModuleSource(task, name)`** — pull a module's RAPID text in one call. Works even when the module has no backing file in `HOME` (loaded from `.pgf`/RobotStudio/pendant): the client saves it to the controller's TEMP volume, reads it, and deletes it.
- **`compressPath(source, dest)`** — controller-side compression.
- **`validateRapidValue(task, value, datatype)`** — pre-flight a literal before writing.
- **`RobotManager.discoverControllersMdns(opts?)`** *(static)* — find every ABB controller (real or virtual) announcing on the local network via mDNS/Bonjour. Returns system name, host, RWS port, RobotWare version, system GUID, and a `'rws1' | 'rws2'` classification — no port scanning needed.
- **Simulation panel** *(RWS 2.0 virtual controllers only)* — `simEmergencyStop()`, `simResetEmergencyStop()`, `simGeneralStop(engage?)`, `simAutoStop(engage?)`, `simEnableSwitch(on)`, `teleportMechunit(mechunit, joints, extJoints?)`. Drive the E-stop / guard-stop chain and reposition the simulated robot from the API. Throw `RwsError` on real hardware and RW6 (VC-only endpoints).

Every method returns `Promise<...>` and throws `RwsError` on failure.

---

## Logging

The lib ships a no-op logger by default. Hosts (CLIs, services, the VS Code extension) install their own:

```ts
import { setLogger } from 'abb-rws-client';

setLogger({
  info:  (msg) => console.log(`[info]  ${msg}`),
  warn:  (msg) => console.warn(`[warn]  ${msg}`),
  error: (msg, err) => console.error(`[error] ${msg}`, err),
  show:  () => { /* bring log surface to front; no-op for CLIs */ },
});
```

Internal lifecycle events (connect/disconnect, polling cycles, subscription state, error recovery) flow through this.

---

## API Reference

### Constructor

```ts
new RwsClient(options: RwsClientOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | — | Controller IP or hostname |
| `port` | `number` | `80` | HTTP port |
| `username` | `string` | `'Admin'` | RWS username |
| `password` | `string` | `'robotics'` | RWS password |
| `requestIntervalMs` | `number` | `55` | Min ms between requests (enforces < 20 req/sec) |
| `timeout` | `number` | `5000` | Request timeout in ms |
| `sessionCookie` | `string` | — | Saved cookie to reuse an existing session slot |

---

### Connection

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `void` | Establish session and authenticate |
| `disconnect()` | `void` | Close WebSocket subscriptions and clear session |
| `getSessionCookie()` | `string \| null` | Current session cookie — persist to avoid 70-session limit |

---

### Controller State & Panel

| Method | Returns | Description |
|--------|---------|-------------|
| `getControllerState()` | `ControllerState` | Motor state: motoron / motoroff / guardstop / emergencystop / … |
| `setControllerState(state)` | `void` | Set motor state — requires mastership |
| `getOperationMode()` | `OperationMode` | AUTO / MANR / MANF |
| `lockOperationMode(pin, permanent?)` | `void` | Lock FlexPendant key switch with PIN |
| `unlockOperationMode()` | `void` | Unlock FlexPendant key switch |
| `getSpeedRatio()` | `number` | Speed override 0–100 |
| `setSpeedRatio(ratio)` | `void` | Set speed override — AUTO mode only |
| `getCollisionDetectionState()` | `CollisionDetectionState` | INIT / TRIGGERED / CONFIRMED / TRIGGERED_ACK |
| `restartController(mode?)` | `void` | restart / istart / pstart / bstart |
| `getControllerIdentity()` | `ControllerIdentity` | Name, ID, type, MAC address |
| `getSystemInfo()` | `SystemInfo` | RobotWare version, options, system ID |
| `getControllerClock()` | `ControllerClock` | Current date/time (UTC) |
| `setControllerClock(y,mo,d,h,mi,s)` | `void` | Set controller date/time (UTC) |

---

### RAPID Execution

| Method | Returns | Description |
|--------|---------|-------------|
| `getRapidExecutionState()` | `ExecutionState` | `'running'` \| `'stopped'` |
| `getRapidExecutionInfo()` | `ExecutionInfo` | State + current cycle mode |
| `getRapidTasks()` | `RapidTask[]` | All tasks with name, type, state, active flag |
| `startRapid()` | `void` | Start execution (AUTO + motors on required) |
| `stopRapid()` | `void` | Stop execution |
| `resetRapid()` | `void` | Reset program pointer to Main |
| `setExecutionCycle(cycle)` | `void` | `'once'` \| `'forever'` \| `'asis'` |
| `activateRapidTask(task)` | `void` | Activate a task (multitasking) |
| `deactivateRapidTask(task)` | `void` | Deactivate a task |
| `activateAllRapidTasks()` | `void` | Activate all tasks |
| `deactivateAllRapidTasks()` | `void` | Deactivate all tasks |

---

### RAPID Variables & Symbols

| Method | Returns | Description |
|--------|---------|-------------|
| `getRapidVariable(task, module, symbol)` | `string` | Read variable as RAPID-syntax string |
| `setRapidVariable(task, module, symbol, value)` | `void` | Write variable (RAPID syntax: `'42'`, `'"hello"'`, `'[1,0,0,0]'`) |
| `validateRapidValue(task, value, datatype)` | `boolean` | Validate value against datatype before writing |
| `getRapidSymbolProperties(task, module, symbol)` | `RapidSymbolProperties` | Type, dims, storage class, flags |
| `searchRapidSymbols(params)` | `RapidSymbolInfo[]` | Search by task, type, datatype, or regex |
| `getActiveUiInstruction()` | `UiInstruction \| null` | Detect if RAPID is waiting for operator input |
| `setUiInstructionParam(stackurl, param, value)` | `void` | Respond to a UI instruction (TPReadNum, TPReadFK…) |

---

### RAPID Modules

| Method | Returns | Description |
|--------|---------|-------------|
| `listModules(taskName)` | `string[]` | Names of all loaded modules in a task |
| `loadModule(task, modulePath, replace?)` | `void` | Load module from controller filesystem into task |
| `unloadModule(task, moduleName)` | `void` | Unload module from task (RAPID must be stopped) |

---

### Motion

| Method | Returns | Description |
|--------|---------|-------------|
| `getJointPositions(mechunit?)` | `JointTarget` | rax_1–rax_6 in degrees (default mechunit: ROB_1) |
| `getCartesianPosition(mechunit?, tool?, wobj?)` | `RobTarget` | TCP x/y/z (mm) + q1–q4 quaternion |
| `getCartesianFull(mechunit?)` | `CartesianFull` | TCP pose + j1/j4/j6/jx configuration flags |

---

### File System

| Method | Returns | Description |
|--------|---------|-------------|
| `listDirectory(remotePath)` | `FileEntry[]` | Browse a directory (`$HOME`, `$TEMP`, …) |
| `readFile(remotePath)` | `string` | Download file as UTF-8 string |
| `uploadModule(remotePath, content)` | `void` | Upload file content (max 800 MB) |
| `deleteFile(remotePath)` | `void` | Delete file |
| `createDirectory(parentPath, dirName)` | `void` | Create directory |
| `copyFile(sourcePath, destPath)` | `void` | Copy file on controller |

---

### I/O Signals

| Method | Returns | Description |
|--------|---------|-------------|
| `listAllSignals(start?, limit?)` | `Signal[]` | Paginated flat list of all signals |
| `readSignal(network, device, name)` | `Signal` | Read a specific signal by address |
| `writeSignal(network, device, name, value)` | `void` | Write DO/AO/GO — value as string: `'1'`, `'0'`, `'3.14'` |
| `listNetworks()` | `IoNetwork[]` | All I/O networks |
| `listDevices(network)` | `IoDevice[]` | Devices on a network |

> Pass `''` for `network` and `device` to use the flat signal path (works by signal name alone).

---

### Event Log

| Method | Returns | Description |
|--------|---------|-------------|
| `getEventLog(domain?, lang?)` | `ElogMessage[]` | Read log messages (domain 0 = main, newest first) |
| `clearEventLog(domain?)` | `void` | Clear messages in one domain |
| `clearAllEventLogs()` | `void` | Clear all domains |

---

### Mastership

Required before modifying motor state, speed ratio, or certain RAPID operations.

| Method | Returns | Description |
|--------|---------|-------------|
| `requestMastership(domain)` | `void` | Take control — `'cfg'` \| `'motion'` \| `'rapid'` |
| `releaseMastership(domain)` | `void` | Release control — always call in `finally` |

```ts
await client.requestMastership('rapid');
try {
  await client.setControllerState('motoron');
} finally {
  await client.releaseMastership('rapid');
}
```

---

### WebSocket Subscriptions

```ts
const unsubscribe = await client.subscribe(resources, handler);
// ...
await unsubscribe();
```

| Resource | Type | Description |
|----------|------|-------------|
| `'execution'` | string | RAPID execution state changes |
| `'controllerstate'` | string | Motor state changes |
| `'operationmode'` | string | Operation mode changes |
| `'speedratio'` | string | Speed ratio changes |
| `'coldetstate'` | string | Collision detection state |
| `'uiinstr'` | string | Active UI instruction changes |
| `{ type: 'execycle' }` | object | Execution cycle mode changes |
| `{ type: 'taskchange', task }` | object | Task state changes |
| `{ type: 'signal', name }` | object | I/O signal value changes |
| `{ type: 'persvar', name }` | object | RAPID persistent variable changes |
| `{ type: 'elog', domain }` | object | New event log entries |

`SubscriptionEvent`: `{ resource: string, value: string, timestamp: Date }`

---

### Error Handling

All public methods throw `RwsError` — never a plain `Error`.

| Code | Meaning |
|------|---------|
| `'AUTH_FAILED'` | Wrong credentials or session rejected |
| `'SESSION_EXPIRED'` | Session timed out |
| `'MOTORS_OFF'` | Action requires motors on |
| `'MODULE_NOT_FOUND'` | Module file not found on controller |
| `'CONTROLLER_BUSY'` | Controller returned 503 — retry later |
| `'RATE_LIMITED'` | Too many requests (429) |
| `'NETWORK_ERROR'` | TCP / timeout / WebSocket error |
| `'PARSE_ERROR'` | Unexpected XML response format |
| `'UNKNOWN'` | Unmapped error — check `httpStatus` and `rwsDetail` |

```ts
try {
  await client.startRapid();
} catch (e) {
  if (e instanceof RwsError) {
    if (e.code === 'MOTORS_OFF') console.error('Enable motors first');
    else throw e;
  }
}
```

---

## Session Persistence

IRC5 controllers allow a maximum of **70 concurrent RWS sessions**; OmniCore controllers also have a finite session pool (the exact number isn't published, but heavy probing without `/logout` returns HTTP 503 once it fills). Persist the session cookie across restarts to always reuse the same slot — the lib calls `/logout` on `disconnect()` to free the slot cleanly, but a saved cookie is the most robust path:

```ts
import fs from 'fs';

// Save after connecting
const cookie = client.getSessionCookie();
if (cookie) fs.writeFileSync('.rws-session', cookie, 'utf8');

// Restore on next start
let sessionCookie: string | undefined;
try { sessionCookie = fs.readFileSync('.rws-session', 'utf8'); } catch {}

const client = new RwsClient({ host, username, password, sessionCookie });
await client.connect(); // reuses the existing session slot
```

---

## Rate Limits

| Constraint | Value | Source |
|------------|-------|--------|
| Max request rate | 20 req/sec | Both protocols (controller-enforced) |
| Client-enforced interval | 55 ms between requests | This package, default |
| Max concurrent sessions | 70 (IRC5) / finite (OmniCore) | Controller-enforced |
| Session inactivity timeout | 5 minutes (IRC5) | Controller-enforced |
| Max session lifetime | 25 minutes (IRC5) | Controller-enforced |
| Max file upload | 800 MB (IRC5) | Controller-enforced; OmniCore is similar |

OmniCore-specific limits aren't fully documented by ABB; what the lib observes empirically matches the IRC5 numbers within an order of magnitude.

---

## Compatibility

| | RobotWare 6.x (RWS 1.0) | RobotWare 7.x (RWS 2.0) |
|--|--|--|
| This package | ✅ `RwsClient` | ✅ `RwsClient2` |
| IRC5 controller (real) | ✅ | n/a |
| OmniCore controller (real) | n/a | ✅ |
| RobotStudio virtual controller | ✅ (RW6.x VC) | ✅ (RW7.x VC) |
| Auto-detect from one entry point | ✅ via `createClient()` | ✅ via `createClient()` |

**Live-tested matrix** as of v0.7.1: RobotWare 7.21 (OmniCore VC, RWS 2.0), RobotWare 6.16 (IRC5 VC, RWS 1.0). 116 unit tests + 339 live protocol-coverage tests pass against both.

---

## Resources

- [ABB Developer Center — RWS API](https://developercenter.robotstudio.com/api/rwsApi/)
- [Companion VS Code Extension](https://marketplace.visualstudio.com/items?itemName=merajsafari.abb-rws)

---

## License

MIT — see [LICENSE](./LICENSE)
