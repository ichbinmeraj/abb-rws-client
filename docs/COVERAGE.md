# Coverage

What the client guarantees, and how each guarantee is tested. Endpoint-level
API coverage lives in the README tables; this file covers the structural
behavior added by the 2026-08 structural-fixes round.

## Structural

### Connection quality states

`RobotState.quality` (with a human-readable `qualityReason`) reports connection
health as one of five states, driven entirely by signals the manager already
has:

| State | Meaning | Entered when |
|---|---|---|
| `live` | WebSocket events streaming; polling at slow cadence (5×) | subscriptions started, or stream restored after a reconnect |
| `polling` | no WebSocket; fast polling covers all state | subscription start failed, or the stream was terminally lost (`onLost`) |
| `reconnecting` | a connect attempt is in flight | `connect()` entry until it settles |
| `stale` | 1-2 consecutive polls failed; data may be outdated | first/second poll failure; heals to `live`/`polling` on the next success |
| `disconnected` | not connected | initial state, user disconnect, connect failure, or auto-disconnect after 3 failed polls |

`MultiRobotManager.onRobotChanged(id => ...)` reports WHICH robot changed so
fleet consumers update one row instead of diffing every state; the zero-arg
`onDidChange` is unchanged. Every transition is unit-tested
(`tests/RobotManager.test.ts`, "connection quality").

### Reconnect guarantees (both protocols)

The event stream self-heals identically on RWS 1.0 (IRC5) and RWS 2.0
(OmniCore):

- **Heartbeat**: RWS 1.0 uses WebSocket protocol pings (the IRC5 answers
  RFC6455 pings; app-level `PING` text is RWS 2.0 only). RWS 2.0 sends `PING`
  text and treats a `PONG` still missing at the next tick as half-open; any
  inbound frame counts as proof of life. A half-open connection (frozen NAT,
  yanked cable) is force-closed within ~2 ping intervals and recovery runs.
- **Backoff**: capped exponential (RWS 1.0: 1 s doubling to 30 s, 6 attempts;
  RWS 2.0: 500 ms doubling to 30 s, 6 attempts), tunable per subscription via
  `WsSubscribeOptions`. `onLost` fires exactly once when the budget is
  exhausted; `RobotManager` then returns to fast polling.
- **Re-registration**: a controller restart invalidates the registration (and
  on RWS 2.0 the session). RWS 1.0 retries the stored poll URL (reusable on
  IRC5), then re-POSTs `/subscription` on the same HTTP session. RWS 2.0
  re-POSTs on every reconnect and adopts any re-issued session cookie - a
  restart mints a fresh session and the WebSocket must present the fresh
  cookie (live-verified: keeping the stale one loops 401 forever).
- **Resync**: `onRestored` fires after every successful recovery;
  `RobotManager` responds with one immediate full poll (events during the gap
  are gone - polling is the guarantee, WebSocket the accelerator).
- **Route stability**: both subscribers connect the WebSocket through the
  host/port the client was configured with, not the authority the controller
  advertises, so subscriptions survive NAT/port-forwarding.

Verified by unit tests (scripted sockets, mock subscription servers) plus live
chaos-proxy acceptance suites against both VCs (`tests/live/*.live.test.ts`):
hard drop, dead registration, blocked port, half-open freeze, and a gated real
warm restart (`RWS_TEST_ALLOW_RESTART=1`).

### Controller-level error codes

`RwsError` carries the classified `code` plus `controllerCode`/`controllerMsg`
parsed from the controller's own error body (all three wire shapes: RWS 1.0
`?json=1`, RWS 2.0 hal+json, and XHTML status blocks). HTTP status alone is
never trusted for 4xx classification:

| RwsError code | Trigger (controller codes, shared by both generations) |
|---|---|
| `MASTERSHIP_REQUIRED` | -1073445862 "held by someone else", -1073445859 "does not have required mastership" |
| `GRANT_DENIED` | -1073445881 "Rejected" (RMMP not granted / UAS grant missing) |
| `WRONG_MODE` | -1073442809 (RAPID start refused in current state; captured on RWS 1.0 - the RWS 2.0 equivalent reports the generic held/blocked code -1073445862 instead) |
| `MODULE_NOT_FOUND` | -1073442813, or not-found on a `/modules/` path |
| `RESOURCE_NOT_FOUND` | -1073414146, -1073445866, -1073438713, or any other 404 |
| `AUTH_FAILED` | credential/handshake failures ONLY - a body-carrying 403 is never blamed on credentials |

Every mapping is backed by a raw payload captured live 2026-08-02 from both
VCs (`tests/fixtures/errors/`), replayed in fixture-driven unit tests
(`tests/ControllerError.test.ts`) and transport-integration tests.

**Pending fixture (needs a human once):** a true UAS grant-denied 403 requires
a limited user (without e.g. "Remote Start and Stop in Auto") created via the
FlexPendant/RobotStudio UAS UI. When captured, add it under
`tests/fixtures/errors/` and extend the classifier if its signature differs
from the RMMP `Rejected` shape.
