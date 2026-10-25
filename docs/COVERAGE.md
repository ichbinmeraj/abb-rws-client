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
| `live` | WebSocket events streaming; polling at slow cadence (5×) | subscriptions started (at connect or on a later retry), or stream restored after a reconnect, with every status resource bound |
| `polling` | fast polling covers all state | subscription start failed, the stream was terminally lost (`onLost`), or the controller created the group without a status resource the poll reads (the reason names it); after a failed start or a loss the manager subscribes again after 5, 10, 20, 40 s, then each minute (10 minutes apart after three unanswered creates in a row) |
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
  RFC6455 pings). RWS 2.0 is deliberately **silent** on the subscription socket -
  OmniCore rejects any client frame on it (`PING` included) with a 1008
  "Client cannot send data" close - and instead establishes liveness **out of
  band**: each tick marks the connection unproven and fires a cheap `GET` probe,
  and any inbound event frame or a successful probe counts as proof of life. A
  half-open connection (frozen NAT, yanked cable) is force-closed within ~2 ping
  intervals and recovery runs.
- **Backoff**: capped exponential (RWS 1.0: 1 s doubling to 30 s, 6 attempts;
  RWS 2.0: 500 ms doubling to 30 s, 6 attempts), tunable per subscription via
  `WsSubscribeOptions`. `onLost` fires exactly once when the budget is
  exhausted; `RobotManager` then returns to fast polling and, while
  connected, subscribes again after 5, 10, 20, 40 s, then each minute
  (10 minutes apart after three unanswered creates in a row).
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
chaos-proxy acceptance suites against both VCs (`tests/live/*.live.test.ts`,
enabled by `RWS_TEST_HOST`: a host of this PC, or an http(s) URL naming one as
RAPID Live's host tests set it, read by `tests/helpers/liveHost.ts`):
hard drop, dead registration, blocked port, half-open freeze, and a gated real
warm restart (`RWS_TEST_ALLOW_RESTART=1`), sent only to a lane off the test
suites' never-restart list (`tests/helpers/restartPolicy.ts`: RW6 and RW8 are
on it, so it runs on RW7).

### Controller-level error codes

`RwsError` carries the classified `code` plus `controllerCode`/`controllerMsg`
parsed from the controller's own error body (all three wire shapes: RWS 1.0
`?json=1`, RWS 2.0 hal+json, and XHTML status blocks). HTTP status alone is
never trusted for 4xx classification:

| RwsError code | Trigger (controller codes, shared by both generations) |
|---|---|
| `MASTERSHIP_REQUIRED` | -1073445862 "held by someone else", -1073445859 "does not have required mastership" |
| `GRANT_DENIED` | -1073445881 "Rejected" (RMMP not granted / UAS grant missing) |
| `WRONG_MODE` | -1073442809 (an operation refused in the current execution state, on both generations: for example a RAPID start with no program pointer on RW 7.21, or a program pointer move while RAPID runs on RW 7.21.4 and 8.2.1, functional runs of 2026-10-24) |
| `MODULE_NOT_FOUND` | -1073442813, or not-found on a `/modules/` path |
| `RESOURCE_NOT_FOUND` | -1073414146, -1073445866, -1073438713, or any other 404 |
| `AUTH_FAILED` | credential/handshake failures ONLY - a body-carrying 403 is never blamed on credentials |
| `INVALID_ARGUMENT` | -1073437689 "Name already exists in database (for named instances)" and -1073437688 "Cfg file contains errors.", with a refusal of kind `invalid-argument` that says whether a configuration file or an instance name was refused (the controller names neither the instance nor the line) (since 1.5.0; `UNKNOWN` before) |
| `INVALID_ARGUMENT` | -1073437686 SYS_CTRL_E_CFG_VERSION "Invalid cfg domain version or invalid layout of version string." ("Wrong layout of version string" on RWS 2.0), with a refusal of kind `invalid-argument`: the file's version header is malformed; the remedy is to fix the file's first line and validate or load again (since 1.5.1; `UNKNOWN` before). Answered 400 to the validation of a file with no version header on the 6.16.03, 7.21.4 and 8.2.1 VCs, 2026-10-24 |

Every mapping is backed by a raw payload captured live 2026-08-02 from both
VCs (`tests/fixtures/errors/`), replayed in fixture-driven unit tests
(`tests/ControllerError.test.ts`) and transport-integration tests. The
configuration codes are the exception. -1073437689 and -1073437688 answered a
load with `add` of a domain the same controller had saved on the RobotWare
6.16.03, 7.21.4 and 8.2.1 virtual controllers (2026-10-12), and only the code
and message the client logged were kept. -1073437686 answered the validation
of a file with no version header on the same three (2026-10-24), and the RWS
2.0 XHTML body up to its closing tags and RWS 1.0's code and message were
kept. `tests/cfgRefusal.test.ts` puts them in each generation's error shape.

**Pending fixture (needs a human once):** a true UAS grant-denied 403 requires
a limited user (without e.g. "Remote Start and Stop in Auto") created via the
FlexPendant/RobotStudio UAS UI. When captured, add it under
`tests/fixtures/errors/` and extend the classifier if its signature differs
from the RMMP `Rejected` shape.
