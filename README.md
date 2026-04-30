# abb-rws-client

A typed TypeScript/Node.js HTTP and WebSocket client for **ABB IRC5 robot controllers** using [Robot Web Services (RWS) 1.0](https://developercenter.robotstudio.com/api/rwsApi/).

> **Compatibility:** RWS 1.0 / RobotWare 6.x only.  
> Not compatible with OmniCore, RobotWare 7.x, or RWS 2.0.

---

## VS Code Extension

Prefer a GUI? The companion VS Code extension gives you live status, motion data, RAPID control, I/O signals, event log, and file management directly from the sidebar — no code required.

**[ABB Robot (RWS) — VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=merajsafari.abb-rws)**

---

## Features

- HTTP Digest Authentication (RFC 2617) — no external auth libraries
- Session cookie management (`ABBCX`, `-http-session-`) with automatic reuse
- Request rate limiting (< 20 req/sec, configurable)
- Automatic re-authentication after session expiry
- WebSocket subscriptions for real-time events
- Auto-reconnect on WebSocket disconnect (3 retries, exponential backoff)
- Fully typed public API — every method throws `RwsError` with a typed `code`
- Zero runtime dependencies — Node.js built-ins only

---

## Installation

```bash
npm install abb-rws-client
```

**Requirements:** Node.js 18+ (WebSocket subscriptions require Node 21+ or Node 18 with `--experimental-websocket`).

---

## Quick Start

```ts
import { RwsClient, RwsError } from 'abb-rws-client';

const client = new RwsClient({
  host: '192.168.125.1',
  username: 'Default User',
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

## API Reference

### Constructor

```ts
new RwsClient(options: RwsClientOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | — | Controller IP or hostname |
| `port` | `number` | `80` | HTTP port |
| `username` | `string` | `'Default User'` | RWS username |
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

The IRC5 controller allows a maximum of **70 concurrent RWS sessions**. Persist the session cookie across restarts to always reuse the same slot:

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

| Constraint | Value |
|------------|-------|
| Max request rate | 20 req/sec |
| Client enforced interval | 55 ms between requests |
| Max concurrent sessions | 70 |
| Session inactivity timeout | 5 minutes |
| Max session lifetime | 25 minutes |
| Max file upload | 800 MB |

---

## Compatibility

| | RobotWare 6.x (RWS 1.0) | RobotWare 7.x (RWS 2.0) |
|--|--|--|
| This package | ✅ Supported | ❌ Not compatible |
| IRC5 controller | ✅ | n/a |
| OmniCore controller | n/a | ❌ |
| RobotStudio virtual | ✅ (127.0.0.1) | ❌ |

---

## Resources

- [ABB Developer Center — RWS API](https://developercenter.robotstudio.com/api/rwsApi/)
- [Companion VS Code Extension](https://marketplace.visualstudio.com/items?itemName=merajsafari.abb-rws)

---

## License

MIT — see [LICENSE](./LICENSE)
