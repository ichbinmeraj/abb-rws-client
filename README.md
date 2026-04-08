# abb-rws-client

A typed TypeScript/Node.js HTTP and WebSocket client for **ABB IRC5 robot controllers** using [Robot Web Services (RWS) 1.0](https://developercenter.robotstudio.com/api/rwsApi/).

> **Compatibility:** RWS 1.0 / RobotWare 6.x only.  
> **Not compatible** with OmniCore controllers, RobotWare 7.x, or RWS 2.0.

---

## Features

- HTTP Digest Authentication (RFC 2617) — no external auth libraries
- Session cookie management (`ABBCX`, `-http-session-`)
- Request rate limiting (< 20 req/sec, configurable)
- Automatic session re-authentication after 5-minute inactivity
- WebSocket subscriptions for real-time events (execution state, I/O signals, etc.)
- Auto-reconnect on WebSocket disconnect (3 retries, exponential backoff)
- Fully typed public API — every method throws `RwsError` with a typed `code`
- Zero runtime dependencies — Node 18+ built-ins only

---

## Installation

```bash
npm install abb-rws-client
```

**Requirements:** Node.js 21+ (or Node 18 with `--experimental-websocket` for WebSocket subscription support).

---

## Quick Start — RobotStudio virtual controller

```ts
import { RwsClient, RwsError } from 'abb-rws-client';

const client = new RwsClient({
  host: '127.0.0.1',   // RobotStudio default
  port: 80,
  username: 'Default User',
  password: 'robotics',
});

try {
  await client.connect();

  // Read state
  const state = await client.getControllerState();
  console.log('Controller state:', state); // e.g. 'motoron'

  const mode = await client.getOperationMode();
  console.log('Operation mode:', mode); // e.g. 'AUTO'

  // Read positions
  const joints = await client.getJointPositions();
  console.log('J1:', joints.rax_1, 'degrees');

  const tcp = await client.getCartesianPosition();
  console.log('TCP:', tcp.x, tcp.y, tcp.z, 'mm');

  // RAPID execution
  await client.startRapid();
  await client.stopRapid();

  // I/O signals
  const di = await client.readSignal('Local', 'DRV_1', 'DI_1');
  console.log('DI_1 =', di.value);
  await client.writeSignal('Local', 'DRV_1', 'DO_1', '1');

  // Upload and load a RAPID module
  const modSource = `MODULE MyMod\n  PROC main()\n    TPWrite "Hello";\n  ENDPROC\nENDMODULE`;
  await client.uploadModule('$HOME/MyMod.mod', modSource);
  await client.loadModule('T_ROB1', '$HOME/MyMod.mod');

  // Subscribe to real-time events
  const unsubscribe = await client.subscribe(
    ['execution', 'controllerstate'],
    (event) => {
      console.log(`[${event.timestamp.toISOString()}] ${event.resource} = ${event.value}`);
    }
  );

  // ... later, unsubscribe and disconnect
  await unsubscribe();
  await client.disconnect();

} catch (e) {
  if (e instanceof RwsError) {
    console.error(`[${e.code}] ${e.message} (HTTP ${e.httpStatus ?? 'N/A'})`);
  } else {
    throw e;
  }
}
```

---

## API Reference

### `new RwsClient(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | — | Controller IP or hostname |
| `port` | `number` | `80` | HTTP port |
| `username` | `string` | `'Default User'` | RWS username |
| `password` | `string` | `'robotics'` | RWS password |
| `requestIntervalMs` | `number` | `55` | Minimum ms between requests (enforces < 20 req/sec) |
| `timeout` | `number` | `5000` | Request timeout in ms |

---

### Connection

| Method | Returns | Description |
|---|---|---|
| `connect()` | `Promise<void>` | Establish session and authenticate |
| `disconnect()` | `Promise<void>` | Close subscriptions and clear session |

---

### Controller State

| Method | Returns | Description |
|---|---|---|
| `getControllerState()` | `Promise<ControllerState>` | `'init'` \| `'motoroff'` \| `'motoron'` \| `'guardstop'` \| `'emergencystop'` \| `'emergencystopreset'` \| `'sysfail'` |
| `getOperationMode()` | `Promise<OperationMode>` | `'AUTO'` \| `'MANR'` \| `'MANF'` |

---

### RAPID Execution

| Method | Returns | Description |
|---|---|---|
| `getRapidExecutionState()` | `Promise<ExecutionState>` | `'running'` \| `'stopped'` |
| `getRapidTasks()` | `Promise<RapidTask[]>` | All RAPID tasks and their states |
| `startRapid()` | `Promise<void>` | Start RAPID execution (requires AUTO + motors on) |
| `stopRapid()` | `Promise<void>` | Stop RAPID execution |
| `resetRapid()` | `Promise<void>` | Reset program pointer to main |

---

### Motion

| Method | Returns | Description |
|---|---|---|
| `getJointPositions(mechunit?)` | `Promise<JointTarget>` | Joint angles in degrees for all 6 axes |
| `getCartesianPosition(mechunit?, tool?, wobj?)` | `Promise<RobTarget>` | TCP position (mm) and orientation (quaternion) |

---

### Modules

| Method | Returns | Description |
|---|---|---|
| `uploadModule(remotePath, content)` | `Promise<void>` | Upload RAPID `.mod` source to controller filesystem |
| `loadModule(taskName, modulePath)` | `Promise<void>` | Load an uploaded module into a RAPID task |
| `listModules(taskName)` | `Promise<string[]>` | Names of all loaded modules in a task |

---

### I/O Signals

| Method | Returns | Description |
|---|---|---|
| `readSignal(network, device, name)` | `Promise<Signal>` | Read current signal value |
| `writeSignal(network, device, name, value)` | `Promise<void>` | Write a value to an output signal |

---

### Subscriptions

```ts
subscribe(
  resources: SubscriptionResource[],
  handler: (event: SubscriptionEvent) => void
): Promise<() => Promise<void>>
```

Subscribe to real-time RWS events. Returns an async unsubscribe function.

**`SubscriptionResource`** can be:
- `'execution'` — RAPID execution state changes
- `'controllerstate'` — controller state changes
- `'operationmode'` — operation mode changes
- `{ type: 'signal'; name: 'network/device/signalname' }` — I/O signal changes
- `{ type: 'persvar'; name: 'task/varname' }` — RAPID persistent variable changes

**`SubscriptionEvent`**:
```ts
{
  resource: string;   // RWS path of the changed resource
  value: string;      // New value as string
  timestamp: Date;    // When the event was received
}
```

---

### Error Handling

All public methods throw `RwsError` (never plain `Error`) with a typed `code`:

| Code | Meaning |
|---|---|
| `'AUTH_FAILED'` | Wrong credentials or session rejected |
| `'SESSION_EXPIRED'` | Session timed out and re-auth was not possible |
| `'MOTORS_OFF'` | Action requires motors to be on |
| `'MODULE_NOT_FOUND'` | Module file not found on controller filesystem |
| `'CONTROLLER_BUSY'` | Controller returned 503; retry later |
| `'RATE_LIMITED'` | Too many requests (429) |
| `'NETWORK_ERROR'` | TCP/timeout/WebSocket error |
| `'PARSE_ERROR'` | Unexpected XML response format |
| `'UNKNOWN'` | Unmapped error; check `httpStatus` and `rwsDetail` |

```ts
try {
  await client.startRapid();
} catch (e) {
  if (e instanceof RwsError) {
    switch (e.code) {
      case 'MOTORS_OFF':
        console.error('Enable motors on the FlexPendant first');
        break;
      case 'AUTH_FAILED':
        console.error('Check username/password');
        break;
      default:
        console.error(`Unexpected error [${e.code}]: ${e.message}`);
    }
  }
}
```

---

## Compatibility

| Feature | RobotWare 6.x (RWS 1.0) | RobotWare 7.x (RWS 2.0) |
|---|---|---|
| This package | ✓ Supported | ✗ Not compatible |
| Controller: IRC5 | ✓ | n/a |
| Controller: OmniCore | n/a | ✗ |
| RobotStudio (virtual) | ✓ (127.0.0.1) | ✗ |

RWS 2.0 uses a completely different API structure. This package implements RWS 1.0 only and will not function with RobotWare 7.x or OmniCore controllers.

---

## Resources

- [ABB RWS 1.0 API Reference](https://developercenter.robotstudio.com/api/rwsApi/)
- [ABB Developer Center](https://developercenter.robotstudio.com/api/RWS)
- [VALIDATION.md](./VALIDATION.md) — Manual test procedures against a real IRC5 / RobotStudio controller

---

## License

MIT — see [LICENSE](./LICENSE)
