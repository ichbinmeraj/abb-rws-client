# VALIDATION.md — Manual Validation Guide

Procedures for validating `abb-rws-client` against a real ABB IRC5 controller or ABB RobotStudio virtual controller.

## Prerequisites

- ABB RobotStudio installed (free virtual controller option)  
  OR access to a physical IRC5 controller on the network
- Node.js 21+ (or Node 18 with `--experimental-websocket`)
- Package built: `npm run build`

## Test Harness

Create a temporary `validate.mjs` script at the project root:

```js
import { RwsClient, RwsError } from './dist/index.js';

const client = new RwsClient({ host: '127.0.0.1', port: 80 });

async function run() {
  try {
    await client.connect();
    console.log('✓ Connected');
    // ... paste scenario code here ...
  } catch (e) {
    if (e instanceof RwsError) {
      console.error(`RwsError [${e.code}]: ${e.message}`);
    } else {
      console.error(e);
    }
  } finally {
    await client.disconnect();
  }
}
run();
```

Run with: `node validate.mjs`

---

## Scenario 1 — Basic smoke test (connect to RobotStudio virtual controller)

**Setup**: Start ABB RobotStudio → Create new station → Start virtual controller at `127.0.0.1:80`.

```js
const state = await client.getControllerState();
console.log('Controller state:', state);
// Expected: 'motoron' | 'motoroff' | 'init'
```

**Pass criteria**: No exception thrown; state is one of the known `ControllerState` values.

---

## Scenario 2 — Digest auth challenge-response

**Validation**: Observe the first HTTP exchange in Wireshark or by adding a debug log to `HttpSession.ts`.

**Pass criteria**:
1. First request returns HTTP 401 with `WWW-Authenticate: Digest` header
2. Second request includes `Authorization: Digest username="Default User", ...`
3. Response to authenticated request is HTTP 200
4. No `RwsError` thrown

---

## Scenario 3 — Session cookie persists across 10+ consecutive requests

```js
for (let i = 0; i < 12; i++) {
  const state = await client.getControllerState();
  console.log(`Request ${i + 1}: ${state}`);
}
```

**Pass criteria**: All 12 requests succeed without re-authenticating (only one digest handshake at the start, visible via a single 401 in the network trace).

---

## Scenario 4 — Rate limiter prevents 429/503 under rapid calls

```js
// Fire 20 requests as fast as possible
const promises = Array.from({ length: 20 }, () => client.getControllerState());
const results = await Promise.all(promises);
console.log(`All ${results.length} requests completed`);
```

**Pass criteria**: All requests succeed; no HTTP 429 or 503 errors; elapsed time ≥ 19 × 55ms ≈ 1.05s (demonstrating the rate limiter is active).

---

## Scenario 5 — Upload a `.mod` file

```js
const modContent = `MODULE TestMod
  PROC main()
    TPWrite "Hello from TestMod";
  ENDPROC
ENDMODULE`;

await client.uploadModule('$HOME/TestMod.mod', modContent);
console.log('✓ File uploaded to $HOME/TestMod.mod');
```

**Verify**: In RobotStudio → Controller tab → File System → HOME directory — `TestMod.mod` should be listed.

**Pass criteria**: No exception; file visible on controller filesystem.

---

## Scenario 6 — Load uploaded module into RAPID task

```js
await client.loadModule('T_ROB1', '$HOME/TestMod.mod');
console.log('✓ Module loaded into T_ROB1');

const modules = await client.listModules('T_ROB1');
console.log('Loaded modules:', modules);
// Expected: includes 'TestMod'
```

**Pass criteria**: No exception; `listModules` result includes `'TestMod'`.

---

## Scenario 7 — Start and stop RAPID execution; verify state transitions

```js
// Motor on and AUTO mode required for this scenario
await client.startRapid();
let state = await client.getRapidExecutionState();
console.log('After start:', state); // Expected: 'running'

await new Promise(r => setTimeout(r, 500));

await client.stopRapid();
state = await client.getRapidExecutionState();
console.log('After stop:', state); // Expected: 'stopped'
```

**Pass criteria**: `getRapidExecutionState` returns `'running'` after start and `'stopped'` after stop.

---

## Scenario 8 — Read a digital input signal value

```js
// Replace 'Local', 'DRV_1', 'DI_1' with actual signal coordinates from your system
const sig = await client.readSignal('Local', 'DRV_1', 'DI_1');
console.log(`Signal ${sig.name} = ${sig.value} (type: ${sig.type})`);
```

**Pass criteria**: Returns a `Signal` object with correct `name`, `value`, and `type`. No exception.

---

## Scenario 9 — Write a digital output signal value

```js
// Ensure DO_1 is a writable digital output in your I/O configuration
await client.writeSignal('Local', 'DRV_1', 'DO_1', '1');
console.log('✓ Wrote DO_1 = 1');

const sig = await client.readSignal('Local', 'DRV_1', 'DO_1');
console.log('Read back:', sig.value); // Expected: '1'
```

**Pass criteria**: Write succeeds; subsequent read returns the written value.

---

## Scenario 10 — Subscribe to execution state changes

```js
const unsubscribe = await client.subscribe(['execution'], (event) => {
  console.log(`Event: ${event.resource} = ${event.value} at ${event.timestamp.toISOString()}`);
});

await client.startRapid();
await new Promise(r => setTimeout(r, 1000));
await client.stopRapid();
await new Promise(r => setTimeout(r, 1000));

await unsubscribe();
```

**Pass criteria**: At least 2 events received — one with `value='running'` and one with `value='stopped'`.

---

## Scenario 11 — Subscribe to a signal value change

```js
const unsubscribe = await client.subscribe(
  [{ type: 'signal', name: 'Local/DRV_1/DO_1' }],
  (event) => {
    console.log(`Signal event: ${event.value}`);
  }
);

await client.writeSignal('Local', 'DRV_1', 'DO_1', '1');
await new Promise(r => setTimeout(r, 500));
await client.writeSignal('Local', 'DRV_1', 'DO_1', '0');
await new Promise(r => setTimeout(r, 500));

await unsubscribe();
```

**Pass criteria**: Handler fires with values `'1'` and `'0'`.

---

## Scenario 12 — Session expiry recovery

```js
// Step 1: Establish session
await client.getControllerState();

// Step 2: Simulate 5-minute inactivity by sleeping (or by patching lastActivityTime)
console.log('Waiting 6 minutes to trigger session expiry...');
await new Promise(r => setTimeout(r, 6 * 60 * 1000));

// Step 3: Request after expiry should auto re-authenticate
const state = await client.getControllerState();
console.log('State after re-auth:', state);
```

**Pass criteria**: Request after 5+ minute gap succeeds without throwing; network trace shows a new 401 challenge-response cycle.

---

## Scenario 13 — Network disconnect recovery (WsSubscriber)

```js
const unsubscribe = await client.subscribe(['execution'], (event) => {
  console.log('Event:', event.value);
});

// Simulate disconnect: disable network adapter for ~3 seconds, then re-enable
console.log('Manually disconnect network adapter now (5 seconds)...');
await new Promise(r => setTimeout(r, 8000));

// WebSocket should have reconnected by now
await client.startRapid();
await new Promise(r => setTimeout(r, 1000));

await unsubscribe();
```

**Pass criteria**: Events resume after network is restored; no unhandled exception; reconnect log messages visible in stderr.

---

## Scenario 14 — Wrong credentials → RwsError AUTH_FAILED

```js
const badClient = new RwsClient({
  host: '127.0.0.1',
  username: 'Default User',
  password: 'wrongpassword'
});

try {
  await badClient.connect();
  console.error('ERROR: expected exception not thrown');
} catch (e) {
  if (e instanceof RwsError && e.code === 'AUTH_FAILED') {
    console.log('✓ RwsError AUTH_FAILED thrown as expected');
  } else {
    throw e;
  }
}
```

**Pass criteria**: `RwsError` thrown with `code === 'AUTH_FAILED'`.

---

## Scenario 15 — Motors off state → RwsError MOTORS_OFF

**Setup**: Set controller to motors-off state (press E-stop or use FlexPendant).

```js
try {
  await client.startRapid();
  console.error('ERROR: expected exception not thrown');
} catch (e) {
  if (e instanceof RwsError && e.code === 'MOTORS_OFF') {
    console.log('✓ RwsError MOTORS_OFF thrown as expected');
  } else {
    // Some controllers return a generic error code; print for debugging
    console.log('Got error:', e instanceof RwsError ? e.code : e);
  }
}
```

**Pass criteria**: `RwsError` thrown with `code === 'MOTORS_OFF'`. Note that the exact HTTP status from the controller when motors are off may vary by firmware version — check `e.httpStatus` and `e.rwsDetail` if the code is `'UNKNOWN'`.
