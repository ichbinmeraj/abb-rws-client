# abb-rws-client - Architecture

> Typed TypeScript/Node.js client for ABB Robot Web Services, covering **both** protocols:
> RWS 1.0 (IRC5 / RobotWare 6.x, HTTP Digest, JSON via `?json=1`) and RWS 2.0 (OmniCore /
> RobotWare 7.x, HTTP Basic, XHTML `;v=2.0`). ESM-only npm package, single runtime
> dependency (`ws`). Version at time of writing: **1.2.0** (`package.json:3`).

This document was produced by a full read of every source, test, and example file on
2026-07-02, and updated 2026-08-11 for the `Rws2Core` + nine-domain-mixin restructure
and the two-generation endpoint sweep (§1 and the subscription heartbeat reflect the
newer state). Line numbers refer to those snapshots. Claims marked **(inferred)** were
not directly verified against a live controller.

---

## 1. Overview

The package is layered (documented in `src/index.ts:1-20`):

```
                 ┌────────────────────────────┐
                 │  MultiRobotManager          │  many robots, one "active"
                 └──────────────┬─────────────┘
                 ┌──────────────┴─────────────┐
                 │  RobotManager               │  lifecycle, discovery, polling,
                 └──────────────┬─────────────┘  WS-with-polling-fallback, ~120 wrappers
                 ┌──────────────┴─────────────┐
                 │  IRWSAdapter (interface)    │  unified contract, ~60 required
                 └───────┬─────────────┬──────┘  + ~90 optional methods
             ┌───────────┴──┐      ┌───┴────────────┐
             │ RWS1Adapter  │      │ RWS2Adapter     │  1.0: wraps (composition)
             │ (wraps)      │      │ (extends, empty)│  2.0: brands (inheritance)
             └───────┬──────┘      └───┬────────────┘
             ┌───────┴──────┐      ┌───┴────────────┐
             │ RwsClient    │      │ RwsClient2      │  protocol clients
             └───────┬──────┘      └────────────────┘  (RwsClient2 is self-contained)
       ┌─────────────┼──────────────┐
  HttpSession   ResourceMapper  ResponseParser        RWS1-only internals
  (digest+queue) (paths/bodies)  (XHTML→types)
       │
  WsSubscriber  (RWS1 WebSocket events)
```

Both sides are decomposed. The RWS 1.0 side is `HttpSession` + `ResourceMapper` +
`ResponseParser` + `WsSubscriber`, orchestrated by `RwsClient` and extended by
`RWS1Adapter`. The RWS 2.0 side is `Rws2Core` (`src/rws2/core.ts` - transport,
connection, subscriptions, mastership / control-station, RMMP) plus nine
per-RWS-domain mixins under `src/rws2/` (`panel`, `rapid`, `motion`, `io`,
`cfgElogDipc`, `ctrl`, `system`, `users`, `files`) composed onto `RwsClient2`
(`src/RwsClient2.ts`): `export class RwsClient2 extends PanelOps(RapidOps(…(Rws2Core))) {}`.
Splitting by RWS domain mirrors how ABB organises RWS itself, so a protocol
change lands in one obvious module beside its `src/paths` table. `RWS2Adapter` is
an empty type-brand:
`export class RWS2Adapter extends RwsClient2 implements IRWSAdapter {}`
(`src/RWS2Adapter.ts:19`).

Protocol detection is auth-scheme sniffing, not a version endpoint: GET `/rw/system`,
then `WWW-Authenticate: Digest…` → RWS 1.0, `Basic…` → RWS 2.0 (`src/detect.ts:40-74`).

---

## 2. Public API surface

Everything below is exported from `src/index.ts` (the only entry point;
`package.json` `exports` maps only `"."`).

| Group | Exports | Source |
|---|---|---|
| Protocol clients | `RwsClient`, `RwsClient2` | `src/RwsClient.ts`, `src/RwsClient2.ts` |
| Adapters | `RWS1Adapter`, `RWS2Adapter`, `IRWSAdapter` (type) | `src/RWS1Adapter.ts`, `src/RWS2Adapter.ts`, `src/IRWSAdapter.ts` |
| Managers | `RobotManager` (+ types `RobotState`, `ChangeHandler`, `ProbeResult`, `DiscoveredController`, `ErrorListener`), `MultiRobotManager` (+ `RobotConfig`) | `src/RobotManager.ts`, `src/MultiRobotManager.ts` |
| Auto-detect | `createClient`, `createAdapter`, `probeHost`, `probeProtocol` (+ types `AnyClient`, `Protocol`, `ConnectOptions`, `DetectProbeResult`) | `src/detect.ts` |
| Helpers | `XhtmlParser`, `setLogger` (+ `Logger` type), `JOINT_NOT_PRESENT`, `isJointValuePresent` | `src/XhtmlParser.ts`, `src/Logger.ts`, `src/mechunit.ts` |
| Errors | `RwsError` (class), `RwsErrorCode` (type) | `src/types.ts:284-314` |
| Domain types | `RwsClientOptions`, `ControllerState`, `OperationMode`, `ExecutionState`, `ExecutionInfo`, `ExecutionCycle`, `JointTarget`, `JointTargetFull`, `MechunitDetails`, `RobTarget`, `CartesianFull`, `Signal`, `RapidTask`, `IoNetwork`, `IoDevice`, `SystemInfo`, `ControllerIdentity`, `ControllerClock`, `ElogMessage`, `FileEntry`, `MastershipDomain`, `CollisionDetectionState`, `RapidSymbolProperties`, `RapidSymbolInfo`, `RapidSymbolSearchParams`, `UiInstruction`, `RestartMode`, `SubscriptionResource`, `SubscriptionEvent` | `src/types.ts` |

Deliberately **not** exported: `HttpSession`, `ResourceMapper`, `ResponseParser`,
`WsSubscriber` (internal RWS1 machinery), and the `@internal` types
`DigestChallenge` / `HttpResponse` (`src/types.ts:316-337`).

Naming trap: there are **two** `ProbeResult` shapes in the public API -
`RobotManager`'s `{port, useHttps, authType}` and `detect.ts`'s
`{protocol, port, https}`, re-exported as `DetectProbeResult` (`src/index.ts:39`).

### Constructor signatures (verified)

```ts
new RwsClient(options: RwsClientOptions)            // options object; http only (src/RwsClient.ts:132-143)
new RwsClient2(baseUrl: string, user, pass)         // POSITIONAL, base URL string (src/RwsClient2.ts:45-49)
new RWS1Adapter(client: RwsClient, creds?: {host, port, username, password})  // composition (src/RWS1Adapter.ts:22-26)
new RWS2Adapter(baseUrl, user, pass)                // inherits RwsClient2's signature
new RobotManager()                                  // NO constructor args; connect(host, user, pass, port?, useHttps?)
MultiRobotManager.fromConfigs(configs: RobotConfig[])
```

`RWS1Adapter`'s optional second argument (credentials) is required **only** by
FK / IK / jog, which re-implement digest auth themselves (`digestPost`,
`src/RWS1Adapter.ts:810-864`); without it those three throw and everything else works.

---

## 3. Module map

| File | LOC | Responsibility | Depends on | Depended on by |
|---|---|---|---|---|
| `src/types.ts` | 336 | All shared types + `RwsError` class with typed `code` | - | everything |
| `src/Logger.ts` | 54 | Pluggable logger facade; no-op default, `setLogger()` swaps backend at call time | - | HttpSession, RwsClient2, RobotManager |
| `src/XhtmlParser.ts` | 53 | Regex parser for RWS 2.0 XHTML (`<li class>` → `<span class>` field maps, `getError()`) | - | RwsClient2 (also public export) |
| `src/HttpSession.ts` | 444 | RWS 1.0 transport: RFC 2617 digest from scratch, cookie jar, serial rate-limit queue, 401/503 retry | types, Logger | RwsClient, WsSubscriber |
| `src/ResourceMapper.ts` | 509 | Pure functions: operation → RWS 1.0 path + form body. **RWS 1.0 only** (header, L6) | - | RwsClient, WsSubscriber |
| `src/ResponseParser.ts` | 710 | Pure functions: RWS 1.0 XHTML → typed objects; throws `RwsError('PARSE_ERROR')` | types | RwsClient, WsSubscriber |
| `src/WsSubscriber.ts` | 289 | RWS 1.0 WebSocket subscriptions: POST `/subscription`, `robapi2_subscription` subprotocol, cookie auth, 3-retry backoff | HttpSession, ResourceMapper, ResponseParser, types | RwsClient |
| `src/RwsClient.ts` | 1,150 | RWS 1.0 typed facade - ~57 endpoint methods + generic `request()` escape hatch (L164-175) | HttpSession, WsSubscriber, ResourceMapper, ResponseParser, types | RWS1Adapter, detect, RobotManager |
| `src/RwsClient2.ts` | ~27 | RWS 2.0 composition façade: `class RwsClient2 extends PanelOps(RapidOps(…(Rws2Core))) {}` | Rws2Core + the 9 domain mixins | RWS2Adapter, detect |
| `src/rws2/core.ts` | ~1,580 | `Rws2Core`: RWS 2.0 transport (Basic auth, keep-alive agents, 100 ms pacing), connection, subscriptions, mastership/control-station, RMMP | XhtmlParser, HalJsonParser, Logger, types, `ws` (dynamic import) | RwsClient2, the 9 mixins |
| `src/rws2/{panel,rapid,motion,io,cfgElogDipc,ctrl,system,users,files}.ts` | ~90-930 each | One per-RWS-domain mixin `XOps(Base)` + its public-methods interface `XMethods`; the 236 endpoint methods, each beside its `src/paths` table | core (helpers), paths, ResourceMapper2, types | RwsClient2 |
| `src/IRWSAdapter.ts` | 415 | The unified contract: ~60 required, ~90 optional (`?`) methods | types | adapters, RobotManager, detect |
| `src/RWS1Adapter.ts` | 865 | IRWSAdapter for RWS 1.0: delegation + ~55 extra endpoints via `?json=1` helpers + self-contained `digestPost` for FK/IK/jog | RwsClient, IRWSAdapter, types, node:http/crypto | detect, RobotManager |
| `src/RWS2Adapter.ts` | 19 | Empty type-brand: `extends RwsClient2 implements IRWSAdapter` | RwsClient2, IRWSAdapter | detect, RobotManager |
| `src/detect.ts` | 206 | Probe auth scheme/ports; factories `createClient` / `createAdapter` | both clients, both adapters, types | index (public) |
| `src/RobotManager.ts` | 1,478 | Single-robot manager: discovery (port probe + wide TCP scan), connect/reconnect, 1 s/5 s polling + WS augmentation, mastership/RMMP policy, ~120 wrappers | adapters, IRWSAdapter, RwsClient, Logger, types, node:net/fs/os | MultiRobotManager, index |
| `src/MultiRobotManager.ts` | 156 | Map of RobotManagers keyed by config id; one **active** robot; event fan-in | RobotManager, types, node:crypto | index |
| `src/index.ts` | 79 | Public barrel | all of the above | consumers |

> Note: line counts above are approximate and some `src/RwsClient2.ts:NNN` pointers
> in the flow traces below predate the RWS 2.0 domain split - the referenced code
> now lives in `src/rws2/core.ts` (transport, subscriptions, mastership) or the
> matching `src/rws2/<domain>.ts` mixin. Search by symbol name, not line number.

---

## 4. Control / data flow traces

### 4.1 `createClient({ host })` - auto-detect connect

1. `createClient` defaults `username: 'Admin'`, `password: 'robotics'`, `timeout: 5000`
   (`src/detect.ts:104-164`).
2. Port omitted → `probeHost` tries **sequentially** `[5466 https, 9403 https, 443 https,
   80 http, 11811 http]` (`src/detect.ts:81-94`); port given → https inferred only from
   exact match 443/5466/9403 (`src/detect.ts:120`).
3. `probeProtocol` GETs `/rw/system` (raw `node:http(s)`, `rejectUnauthorized: false`),
   sniffs `WWW-Authenticate`: `Digest` → `'rws1'`, `Basic` → `'rws2'`; **no challenge but
   status < 500 → assumes `'rws2'`** (`src/detect.ts:64-67`).
4. `'rws1'` → `new RwsClient({...})`; `'rws2'` → `new RwsClient2(baseUrl, user, pass)`
   - note `opts.timeout` is dropped on the RWS 2.0 branch (`src/detect.ts:152`).
5. `client.connect()`. RWS 1.0: GET controller-state through `HttpSession`, which does
   the 401 → digest handshake (`src/HttpSession.ts:184-199`). RWS 2.0: Basic header on
   first request; `Set-Cookie` captured and replayed (`src/RwsClient2.ts:107-112`).
6. One login only. A refused login (`AUTH_FAILED` from either client) is re-thrown as
   `AUTH_FAILED` naming the host, port and user tried (`loginRefused` in `src/detect.ts`);
   no other account is tried. (Up to 1.3.x both factories retried as `'Default User'`
   when the default `'Admin'` was refused.)

### 4.2 RWS 2.0 write with mastership - `RwsClient2.setSpeedRatio(n)`

1. `withAccess(['rapid'], ...)` on the session's `AccessManager` (`src/access/AccessManager.ts`)
   takes this controller's one write turn and holds `edit` (RobotWare 8: the control
   station's write access); a hold the session already has is counted, not requested
   again. `rws2Domain()` maps `'rapid'`→`'edit'`
   (`src/RwsClient2.ts:897-908`; comment: *"'rapid' and 'cfg' both become 'edit'
   (confirmed: /rapid/request → 404)"*).
2. POST `/rw/panel/speedratio?action=setspeedratio` with body `speed-ratio=N` - the one
   endpoint where RWS 2.0 kept the legacy `?action=` form; the bare endpoint returns 400
   (`src/RwsClient2.ts:193-211`, live-verified via `scripts/probe-speedratio.js`).
3. All requests funnel through the private `req()` (`src/RwsClient2.ts:63-153`): ≥55 ms
   between requests, `Accept: application/xhtml+xml;v=2.0`, Content-Type +
   Content-Length on **all** POST/PUT/DELETE even with empty body (406 otherwise),
   session cookie replay, 10 s socket timeout, errors surfaced via
   `XhtmlParser.getError()`.
4. The hold ends in `finally`; the release goes on the wire only when no other hold of
   the session is on the lock. A failed release is logged ("may stay held until this
   session ends"), never thrown over the write's own result; a "not held" answer while a
   hold was counted - to the release, or to the write itself - is recorded as a lost
   hold. After a loss the operation requests no access again (its next access-taking
   step fails with `MASTERSHIP_REQUIRED`); the next operation requests afresh.

### 4.3 Live state - subscriptions with polling fallback (`RobotManager`)

1. `connect()` coalesces concurrent calls (`connectingPromise`,
   `src/RobotManager.ts:285-293`), probes/recovers the port, selects the adapter by
   `authType` (`basic`→RWS2Adapter, `digest`→RWS1Adapter with persisted session cookie
   from `~/.abb-rws-session`, keyed `host:port#<scrypt verifier of the credentials>` so a
   cookie is reused only with the credentials that created it; `disconnect()` removes
   its own entry after the logout; `RobotManager.sessionFileKey`).
2. `startSubscriptions()` subscribes to `['controllerstate','operationmode',
   'speedratio','execution','coldetstate',{type:'elog',domain:0}]`
   (`src/RobotManager.ts:1284-1308`).
   - RWS 1.0 path: `WsSubscriber` POSTs `/subscription` (expects 201 + `Location`),
     opens WS with subprotocol `robapi2_subscription` and the **session Cookie** (not
     Digest), reconnects on any close it did not ask for, a clean one included (6
     attempts, 1 s doubling to 30 s)
     (`src/WsSubscriber.ts:161-288`).
   - RWS 2.0 path: `RwsClient2.subscribe()` hand-rolls the POST (semicolons in the body
     must stay **literal**, `src/RwsClient2.ts:1337`), takes the WS URL from `Location`
     (real hardware) or the XHTML body (VC), authenticates the WS with the Cookie from
     that response, then stays **silent** on the subscription socket (OmniCore answers
     any client frame - `PING` included - with a 1008 "Client cannot send data" close),
     establishing liveness **out of band** with a cheap `GET` probe each tick
     (`src/rws2/core.ts:1185-1216`).
3. Success → poll every **5 s** (positions etc.); failure → subscription-less full
   polling every **1 s** (`src/RobotManager.ts:392-413`), and the subscribe is tried
   again while connected (5, 10, 20, 40 s, then each minute). A `fetchInFlight` single-flight
   guard prevents the request pile-up that caused 10 s timeouts during heavy motion
   (`src/RobotManager.ts:404-409`).
4. `handleSubscriptionEvent` matches `event.resource` against both friendly names (RWS1)
   and URL paths (RWS2) via regex (`src/RobotManager.ts:1310-1351`).
5. Three consecutive `fetchAll` failures → auto-disconnect + `errorListener(msg,
   ['Show Logs','Reconnect'])` (`src/RobotManager.ts:1455-1472`).

---

## 5. Conventions & invariants

- **Zero external dependencies** except `ws`: digest auth via `node:crypto`, parsing via
  regex only (`src/ResponseParser.ts:5` - *"no external XML libraries"*), probing via raw
  `node:http(s)`. `ws` is dynamically imported (`import('ws')`) only when subscribing, on
  both generations (`src/rws2/core.ts`, `src/WsSubscriber.ts`).
- **ESM-only**: `"type": "module"`, internal imports use explicit `.js` extensions. Nothing
  in `src/` uses `import.meta` or `createRequire`: a CommonJS bundle (the VS Code
  extension's) has no `import.meta`. The package version comes from `src/version.ts`,
  which the build writes from `package.json`.
- **Session-slot conservation is a design invariant.** IRC5 allows 70 concurrent RWS
  sessions; filling the pool causes persistent 503s. Hence: `HttpSession.clearSession()`
  is a documented **no-op** (`src/HttpSession.ts:120-131`), session expiry clears only
  digest state (never cookies), `disconnect()` GETs `/logout` to free the slot
  (`src/RwsClient.ts:201-211`, `src/RwsClient2.ts:159-166`), cookies persist to
  `~/.abb-rws-session` keyed by `host:port#<credentials verifier>` (an entry is removed
  by the disconnect that logged its session out), and keep-alive agents reuse TCP
  connections.
- **Rate limiting**: ≥55 ms between requests on both protocols (< 20 req/s controller
  limit) - serial promise queue in `HttpSession` (`enqueue`, L140-158), timestamp gate in
  `RwsClient2.req()` (L71-73).
- **Error convention**: public methods throw `RwsError` with a typed `code`
  (`src/types.ts:284-314`) - but see §7: large parts of `RWS1Adapter` and the optional
  endpoints throw plain `Error` or silently return defaults instead.
- **Mastership**: package vocabulary is always the RWS 1.0 domains
  `'cfg' | 'motion' | 'rapid'` (`src/types.ts:201`); the `'edit'` rename is internal to
  `RwsClient2`. Every write takes the access it needs itself, per operation, through
  the session's one `AccessManager` (`src/access/AccessManager.ts`): holds are counted
  per real lock (RobotWare 6 cfg/motion/rapid, RobotWare 7 edit/motion, RobotWare 8 the
  one write access), writes that take access run one at a time, and a nested hold (an
  adapter write inside a `RobotManager` wrap or a caller's `requestMastership`) sends
  nothing. README "Access each write takes" lists the lock per write and generation.
  Stop and motors off are sent first and never wait for access. Exception: `jog()` holds
  `'motion'` across calls and releases its own hold 2 s after the last jog, or earlier
  on RobotWare 6 and 7, where a `startRapid` (on RobotWare 7 also a `stepRapid`; the RWS 1.0
  adapter has no step) ends it first, in the same write turn as the start.
- **Lost holds**: the access manager records a hold as lost - and stops counting it -
  when a write or release under it is refused as not held, when the session is re-issued
  (RWS 2.0 cookie change; RWS 1.0 fresh-session retry or new `-http-session-`), when
  `RobotManager` sees the operating mode change (RobotWare 8: after one write-access status
  read) or disconnects after failed polls, and when the RobotWare 7.8+ watchdog lapses.
  After a mode change or a lapsed watchdog the lock is also released once, to be sure.
  `RobotManager` reports it all as `RobotState.access` and `onAccessEvent`.
- **RMMP policy** (Request Manual Mode Privileges, ABB's manual-mode counterpart of a
  mastership request; RobotWare 6/7 only): `withMastership` deliberately does **not**
  pre-check RMMP (see its doc comment for the false-positive cases). `requestRmmp()`
  sends the level asked for (`modify` or `exec`), polls inside ABB's 10 s window and
  resolves granted / denied / expired / cancelled / held-lower, cancelling on expiry,
  abort and disconnect
  (`src/access/rmmp.ts`). `jog()` reads the mode, motors and RMMP fresh before it
  requests motion access, and never requests RMMP itself; on RobotWare 8 it sends no
  RMMP call and checks the station's motion-control declaration instead.
- **Optional-method feature detection**: `IRWSAdapter` has ~90 optional methods; RWS 1.0
  leaves unsupported ones `undefined` so callers can feature-test
  (`if ('resetMastershipWatchdog' in adapter)`, `src/RWS1Adapter.ts:129-133`).
- **Live-probe provenance**: undocumented protocol behavior is recorded in doc comments
  citing probe scripts and dates (e.g. *"Live-verified 2026-05-07 via
  scripts/probe-speedratio.js"* pattern in `RwsClient2.ts`). These comments are the
  protocol documentation of record - preserve them when editing.

---

## 6. Gotchas & hard-won knowledge

Protocol facts embedded in code comments that future work must not regress:

- **Digest details** (`src/HttpSession.ts:335-337`): *"the space in 'Default User' is NOT
  percent-encoded for HA1. The nc value is NOT quoted in the Authorization header. The
  URI is path+query only, not scheme://host:port/path."* Tests pin these exactly
  (`tests/HttpSession.test.ts:69-108`).
- **Empty body still needs Content-Type** on both protocols: RWS 1.0 form posts
  (`src/HttpSession.ts:256-257`, e.g. `resetpp`); RWS 2.0 returns **406** without
  Content-Type on any POST/PUT/DELETE (`src/RwsClient2.ts:78-79`).
- **Mastership rename**: `'rapid'`/`'cfg'` → `'edit'` on RWS 2.0; `/rw/mastership/rapid/request`
  → 404 (`src/RwsClient2.ts:898`).
- **Mastership 403 disguise**: calling `resetpp` without mastership returns HTTP 403
  org_code −4501 / 0xc004841d *"which the controller misleadingly tags as 'RAPID error'"*
  (`src/RobotManager.ts:526-533`).
- **Token mastership** (`requestMastershipWithId`) is RWS 2.0-only. The two calls spell
  the id differently, and ABB's Mastership service documents both: the request-with-id
  answer carries `mastership-id`, release-with-id takes the form field `mastershipid`
  with no dash; sent as `mastership-id`, the release is refused 400 "Invalid value for
  mastershipid" (`releaseMastershipWithId` in `src/rws2/core.ts`). Watchdog: on RW 7.8+
  a holder of edit mastership must reset `/rw/mastership/watchdog` within the HeartBeat
  Timeout (with `Select` set, a
  missed heartbeat during execution stops it and switches the motors off, per ABB's
  PC SDK). `src/access/MastershipWatchdog.ts` does this while the session's access
  manager counts a hold on `edit`, at `min(Timeout / 2, 1 s)`; it reads
  `SYS/MASTER_BOOL/HeartBeat` once per connection and never writes it. A refused reset,
  or none accepted within the Timeout, is a lost hold.
- **Op-mode writes**: RWS 1.0 wire values are `auto|man|manfs` (`src/RwsClient.ts:328-336`);
  RWS 2.0 wants `manf` **not** `manfs` (`src/RwsClient2.ts:238-247`). AUTO↔MANF must
  transit through MANR with a 600 ms settle pause (`RobotManager.setOperationMode`).
  Going to AUTO takes edit mastership on RobotWare 7 and then waits for a
  confirmation at the FlexPendant (the mode reads AUTO_CH); setOperationMode does
  not send it. VC-only on real hardware (key switch wins, 403).
- **IK/FK work on VCs** (live-verified 2026-09-30 on RW 6.16.03, 7.21.4 and 8.2.1: the
  current pose solves to the current joints and back). The old reading, "always fails on a
  VC for want of the PC Interface option", was wrong: every pose was refused with HTTP 400
  `SYS_CTRL_E_POSE_OUTSIDE_REACH` (−1073436654) because the client sent millimetres and
  degrees where the controller takes metres and radians, and RWS 1.0 used the wrong action.
  Both generations now convert (`calcJointsFromCartesian` / `calcCartesianFromJoints` doc
  comments in `src/IRWSAdapter.ts`). A pose really out of reach is still that 400. FK on
  RWS 2.0 can return HTTP 200 with the error only as
  `<a href=".../retcode?code=N" rel="error"/>`; the client throws it typed by its code.
- **Fileservice quirks** (all live-verified, `CHANGELOG.md:173-180`):
  `createDirectory` params go in the **body** (`fs-action=create`; query form → 400
  *"Invalid/No Query Parameter"*, `src/RwsClient.ts:870-872`); `copyFile` is
  same-directory-only (`fs-newname` must be a bare filename,
  `src/ResourceMapper.ts:412-416`); RWS 1.0 home is `$HOME` (keep the `$` literal in
  paths - `src/ResourceMapper.ts:292-293`), RWS 2.0 home is `HOME`
  (`rws2Path()` strips `$`, `src/RwsClient2.ts:655`); RWS 2.0 upload needs the
  **versioned** content type `text/plain;v=2.0` (plain → 415, `src/RwsClient2.ts:667-668`);
  RWS 2.0 module unload is `POST .../unloadmod` (DELETE → 405, `src/RwsClient2.ts:382-384`).
- **`loadmod replace=true` leaves a stale symbol table** - after replace, `resetRapid()`
  reports "no main" even though the new file has one; explicit unload + load fixes it
  (`src/RobotManager.ts:933-938`). `loadProgram` deliberately does **not** unload other
  modules (older versions destroyed e.g. OmniCore's `Module1`,
  `src/RobotManager.ts:944-946`).
- **Subscription bodies must not percent-encode semicolons**
  (`src/WsSubscriber.ts:87-89`, `src/RwsClient2.ts:1337`). WS auth is **Cookie, not
  Authorization/Digest** on both protocols (`src/WsSubscriber.ts:251`,
  `src/RwsClient2.ts:1434-1448`). RWS 2.0 VCs may reject the `robapi2_subscription`
  subprotocol entirely → polling fallback (README `L221`).
- **Jog `ccount` is the controller's current motion-system change count**, read with
  `GET /rw/motionsystem` right before each jog; a different value is refused as a
  change-count mismatch. The jog body is exactly ABB's jog form (`axis1`..`axis6`,
  `ccount`, `inc-mode`) on both generations (`src/jog.ts`).
- **Controller-side typo**: the program-pointer response emits span class `modulemame`
  (sic); code checks both spellings (`src/RwsClient2.ts:1715-1725`; the same fallback in
  `src/RWS1Adapter.ts:418` is compensating for the same firmware typo).
- **RWS 1.0 licence path is singular** `/rw/system/license` - the official doc's plural
  `/licenses` 404s on live IRC5 (`src/RWS1Adapter.ts:289-291`).
- **Wide port scan**: RobotStudio assigns VC ports across 1024-30000 (observed: 5466,
  9403, 11811, 15120, 16146, 28447); scan uses 300 concurrent sockets - *"~500 is the
  practical ceiling"* on Windows before silent socket drops
  (`src/RobotManager.ts:239-244`).
- **`getEventLog` needs `lang=en`** to get title/desc/causes/actions on RWS 2.0
  (`src/RwsClient2.ts:574`).
- **CFG pagination**: RWS 2.0 `rel="next"` hrefs resolve against `<base href>` `/rw/cfg/`,
  not `/rw/` (`src/RwsClient2.ts:702-716`); RWS 1.0 pagination follows
  `_links.next.href` with a 50-page cap (`src/RWS1Adapter.ts:453-459`).

---

## 7. Build, test, release

```bash
npm run build     # tsc → dist/ (ES2022, NodeNext, strict; tests/ NOT type-checked)
npm test          # vitest run - 116 unit tests, offline (scripted local HTTP server / localhost fixtures)
npm run lint      # eslint src (flat config; tests/ and examples/ are NOT linted)
npm publish       # prepublishOnly runs build + test automatically
node validate.mjs # manual smoke against a live controller (hardcoded 192.168.125.1, 'Default User')
```

Live validation: `VALIDATION.md` (15 manual scenarios, **RWS 1.0 only**) plus the VS Code
extension repo's `test-*.js` live suites. README's claim of "116 unit tests" is exact;
the "339 live protocol-coverage tests" refers to the extension-side live scripts
**(inferred - not re-counted)**.

Test coverage skew (from reading every test): digest handshake, cookies, rate limiting,
and 9/24 ResponseParser parsers are well covered; **untested**: all POST/PUT/DELETE
paths in HttpSession, timeout/abort, session-cookie persistence, `createAdapter`,
`probeHost`, everything in `RobotManager`/`MultiRobotManager`/`WsSubscriber`/adapters,
15/24 parsers, ~36/52 ResourceMapper builders. `RwsClient2.unit.test.ts` is smoke-only
by design (*"protocol-level methods are exercised by … live tests"*, L5-7).

---

## 8. Discrepancies (doc vs code vs types vs changelog)

Open items only: rows fixed since are removed, and the numbers of the rest are
kept so earlier references still point at the same row.

| # | Discrepancy | Evidence |
|---|---|---|
| 7 | Default username: the code default is `'Admin'` (`src/RwsClient.ts:158`, `src/detect.ts:353`), as README and examples say; the `VALIDATION.md` harness passes no username (so it logs in as `'Admin'`), yet its scenario 2 expects `username="Default User"`. `validate.mjs` passes `'Default User'` explicitly | `VALIDATION.md:19, 63`, `validate.mjs:5` |
| 9 | CHANGELOG 0.7.0 says examples/ has "four scripts"; six exist; 0.7.2 claims to be "bit-for-bit identical to v0.7.1"; 0.7.3 records the rewrite of examples 05/06 but not when they were added | `CHANGELOG.md` 0.7.0, 0.7.2 and 0.7.3 entries |
| 10 | `ResponseParser` docstrings cite the path `/rw/mechunit/{unit}/…`; the client reads `/rw/motionsystem/mechunits/…` - trust the code | `src/ResponseParser.ts:228, 284` |
| 11 | The `\b` word-boundary class matching does **not** prevent hyphen-suffix collisions (`\b` fires at letter↔`-`); the comment claiming `'rap-task-li'` won't match `'rap-task-li-selected'` is wrong (behavior benign today) | `src/ResponseParser.ts:85-91` |
| 13 | `RwsClient.uploadModule` is `@deprecated` in favor of `uploadFile`, yet `RWS1Adapter.uploadFile` calls the deprecated alias | `src/RwsClient.ts:900-903`, `src/RWS1Adapter.ts:283` |
| 15 | `RWS1Adapter` stage-header method counts don't match bodies (e.g. "Stage 8: DIPC (6 methods)" has 5) - cosmetic drift from incremental buildout | `src/RWS1Adapter.ts:1422-2646` |
| 16 | Three duplicated default-`RobotState` literals must be kept in sync when the shape grows | `src/RobotManager.ts:190-198, 1275-1283`; `src/MultiRobotManager.ts:93-100` |
| 17 | `.gitignore` ignores itself (L141) - cosmetic quirk of the stock template | `.gitignore:141` |
| 18 | `MultiRobotManager.fromConfigs` doc claims "backward compatibility for legacy single-robot settings" - no such logic exists in the method (it lives in the extension) | `src/MultiRobotManager.ts:246` |
| 21 | `XhtmlParser` is stricter than `ResponseParser` without saying so: `<li>` matching requires `class` to be the **first** attribute with an exact value (no `\b`/multi-class), `getError()` only matches **negative** codes (`(-\d+)`), and no HTML entities are decoded. Untested limits | `src/XhtmlParser.ts:16, 29, 55, 73` |
| 22 | `RwsClientOptions.sessionCookie` doc says "cookie **value**" but the parser expects the full Cookie header string. (The row's other half, cookies kept only from 2xx answers, was fixed 2026-10-22.) | `src/types.ts:698-699` |

---

## 9. Open questions

1. **`WsSubscriber` on Node 22+**: it prefers native `globalThis.WebSocket` but passes the
   session Cookie via a third constructor argument only the `ws` package supports - native
   undici WebSocket ignores it, so RWS 1.0 WS auth may silently fail exactly on modern
   Node (`src/WsSubscriber.ts:21-33, 246-253`). Needs a live probe on Node 22.
2. `rap-syproppers-li` (PERS symbol li class, `src/RwsClient2.ts:440`) is missing the "m"
   every sibling class has (`rap-sympropvar-li`…) - real controller class name or typo
   that silently drops PERS results from symbol search?
3. `setCfgInstance` writes to `/rw/cfg/{d}/{t}/{instance}` while reads use
   `…/{t}/instances/{instance}` - is the write path live-verified?
   (`src/RwsClient2.ts:753, 766`). Same for `createCfgInstance` (comment/code disagree,
   L770-771) and `setActiveTool`/`setActiveWobj` bare POSTs (L841-845).
4. Have `runCyclicBrakeCheck`, `listSafetyZones`, `listBreakpoints` (RWS 1.0 side) ever
   succeeded live? All are doc-derived with hedging comments
   (`src/RWS1Adapter.ts:621-628, 700`), and project probing found `/ctrl/safety` blocked.
5. Answered: on RWS 2.0 `removeBreakpoint` now POSTs the `remove` sub-resource of
   `program/breakpoints` (the same collection as list/set) with the controller's
   `clear-breakpoint` form, fields module, row and columno, read on RW 7.21.4 and
   8.2.1 on 2026-09-29 (`src/paths/rapid.ts`). The old DELETE answered 405. The call
   itself is built-not-run; RWS 1.0 has no remove form and throws UNSUPPORTED_OPERATION.
6. Does a pre-loaded `sessionCookie` let RWS 1.0 skip the digest handshake entirely on
   real firmware, or does it always bounce through one 401?
7. Auth `qop=auth-int` is accepted but hashed as `auth` with no body hash - would fail on
   a controller that actually demands auth-int (`src/HttpSession.ts:348-350`). Do any?
8. WS reconnect reuses the same subscription URL without re-POSTing `/subscription`; if
   the controller GC'd it during the outage all 3 retries fail **silently** and events
   stop with no error to the caller (`src/WsSubscriber.ts:277-287`). Wanted behavior?
