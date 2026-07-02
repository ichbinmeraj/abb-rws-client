# abb-rws-client — Architecture

> Typed TypeScript/Node.js client for ABB Robot Web Services, covering **both** protocols:
> RWS 1.0 (IRC5 / RobotWare 6.x, HTTP Digest, JSON via `?json=1`) and RWS 2.0 (OmniCore /
> RobotWare 7.x, HTTP Basic, XHTML `;v=2.0`). ESM-only npm package, single runtime
> dependency (`ws`). Version at time of writing: **0.7.2** (`package.json:3`).

This document was produced by a full read of every source, test, and example file on
2026-07-02. Line numbers refer to that snapshot. Claims marked **(inferred)** were not
directly verified against a live controller.

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

Key asymmetry: the RWS 1.0 side is decomposed (`HttpSession` + `ResourceMapper` +
`ResponseParser` + `WsSubscriber`, orchestrated by `RwsClient`, extended by
`RWS1Adapter`), while the RWS 2.0 side is one monolithic 1,814-line class
(`RwsClient2`) that contains its own transport, parsing (via `XhtmlParser`), and
subscriptions. `RWS2Adapter` is an empty type-brand:
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
| Helpers | `XhtmlParser`, `setLogger` (+ `Logger` type) | `src/XhtmlParser.ts`, `src/Logger.ts` |
| Errors | `RwsError` (class), `RwsErrorCode` (type) | `src/types.ts:284-314` |
| Domain types | `RwsClientOptions`, `ControllerState`, `OperationMode`, `ExecutionState`, `ExecutionInfo`, `ExecutionCycle`, `JointTarget`, `RobTarget`, `CartesianFull`, `Signal`, `RapidTask`, `IoNetwork`, `IoDevice`, `SystemInfo`, `ControllerIdentity`, `ControllerClock`, `ElogMessage`, `FileEntry`, `MastershipDomain`, `CollisionDetectionState`, `RapidSymbolProperties`, `RapidSymbolInfo`, `RapidSymbolSearchParams`, `UiInstruction`, `RestartMode`, `SubscriptionResource`, `SubscriptionEvent` | `src/types.ts` |

Deliberately **not** exported: `HttpSession`, `ResourceMapper`, `ResponseParser`,
`WsSubscriber` (internal RWS1 machinery), and the `@internal` types
`DigestChallenge` / `HttpResponse` (`src/types.ts:316-337`).

Naming trap: there are **two** `ProbeResult` shapes in the public API —
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
| `src/types.ts` | 336 | All shared types + `RwsError` class with typed `code` | — | everything |
| `src/Logger.ts` | 54 | Pluggable logger facade; no-op default, `setLogger()` swaps backend at call time | — | HttpSession, RwsClient2, RobotManager |
| `src/XhtmlParser.ts` | 53 | Regex parser for RWS 2.0 XHTML (`<li class>` → `<span class>` field maps, `getError()`) | — | RwsClient2 (also public export) |
| `src/HttpSession.ts` | 444 | RWS 1.0 transport: RFC 2617 digest from scratch, cookie jar, serial rate-limit queue, 401/503 retry | types, Logger | RwsClient, WsSubscriber |
| `src/ResourceMapper.ts` | 509 | Pure functions: operation → RWS 1.0 path + form body. **RWS 1.0 only** (header, L6) | — | RwsClient, WsSubscriber |
| `src/ResponseParser.ts` | 710 | Pure functions: RWS 1.0 XHTML → typed objects; throws `RwsError('PARSE_ERROR')` | types | RwsClient, WsSubscriber |
| `src/WsSubscriber.ts` | 289 | RWS 1.0 WebSocket subscriptions: POST `/subscription`, `robapi2_subscription` subprotocol, cookie auth, 3-retry backoff | HttpSession, ResourceMapper, ResponseParser, types | RwsClient |
| `src/RwsClient.ts` | 1,150 | RWS 1.0 typed facade — ~57 endpoint methods + generic `request()` escape hatch (L164-175) | HttpSession, WsSubscriber, ResourceMapper, ResponseParser, types | RWS1Adapter, detect, RobotManager |
| `src/RwsClient2.ts` | 1,814 | RWS 2.0 everything: transport (Basic auth, keep-alive agents, 55 ms pacing), full endpoint surface, subscriptions, mastership/RMMP | XhtmlParser, Logger, types, `ws` (dynamic import) | RWS2Adapter, detect |
| `src/IRWSAdapter.ts` | 415 | The unified contract: ~60 required, ~90 optional (`?`) methods | types | adapters, RobotManager, detect |
| `src/RWS1Adapter.ts` | 865 | IRWSAdapter for RWS 1.0: delegation + ~55 extra endpoints via `?json=1` helpers + self-contained `digestPost` for FK/IK/jog | RwsClient, IRWSAdapter, types, node:http/crypto | detect, RobotManager |
| `src/RWS2Adapter.ts` | 19 | Empty type-brand: `extends RwsClient2 implements IRWSAdapter` | RwsClient2, IRWSAdapter | detect, RobotManager |
| `src/detect.ts` | 206 | Probe auth scheme/ports; factories `createClient` / `createAdapter` | both clients, both adapters, types | index (public) |
| `src/RobotManager.ts` | 1,478 | Single-robot manager: discovery (port probe + wide TCP scan), connect/reconnect, 1 s/5 s polling + WS augmentation, mastership/RMMP policy, ~120 wrappers | adapters, IRWSAdapter, RwsClient, Logger, types, node:net/fs/os | MultiRobotManager, index |
| `src/MultiRobotManager.ts` | 156 | Map of RobotManagers keyed by config id; one **active** robot; event fan-in | RobotManager, types, node:crypto | index |
| `src/index.ts` | 79 | Public barrel | all of the above | consumers |

---

## 4. Control / data flow traces

### 4.1 `createClient({ host })` — auto-detect connect

1. `createClient` defaults `username: 'Admin'`, `password: 'robotics'`, `timeout: 5000`
   (`src/detect.ts:104-164`).
2. Port omitted → `probeHost` tries **sequentially** `[5466 https, 9403 https, 443 https,
   80 http, 11811 http]` (`src/detect.ts:81-94`); port given → https inferred only from
   exact match 443/5466/9403 (`src/detect.ts:120`).
3. `probeProtocol` GETs `/rw/system` (raw `node:http(s)`, `rejectUnauthorized: false`),
   sniffs `WWW-Authenticate`: `Digest` → `'rws1'`, `Basic` → `'rws2'`; **no challenge but
   status < 500 → assumes `'rws2'`** (`src/detect.ts:64-67`).
4. `'rws1'` → `new RwsClient({...})`; `'rws2'` → `new RwsClient2(baseUrl, user, pass)`
   — note `opts.timeout` is dropped on the RWS 2.0 branch (`src/detect.ts:152`).
5. `client.connect()`. RWS 1.0: GET controller-state through `HttpSession`, which does
   the 401 → digest handshake (`src/HttpSession.ts:184-199`). RWS 2.0: Basic header on
   first request; `Set-Cookie` captured and replayed (`src/RwsClient2.ts:107-112`).
6. If connect fails with `/401|unauthor/i` **and** the caller didn't pin a username,
   `createClient` retries once with `'Default User'` (`src/detect.ts:132-161`).
   `createAdapter` duplicates the probe logic but **omits** this fallback
   (`src/detect.ts:172-206`).

### 4.2 RWS 2.0 write with mastership — `RwsClient2.setSpeedRatio(n)`

1. `requestMastership('rapid')` → `rws2Domain()` maps `'rapid'`→`'edit'`
   (`src/RwsClient2.ts:897-908`; comment: *"'rapid' and 'cfg' both become 'edit'
   (confirmed: /rapid/request → 404)"*).
2. POST `/rw/panel/speedratio?action=setspeedratio` with body `speed-ratio=N` — the one
   endpoint where RWS 2.0 kept the legacy `?action=` form; the bare endpoint returns 400
   (`src/RwsClient2.ts:193-211`, live-verified via `scripts/probe-speedratio.js`).
3. All requests funnel through the private `req()` (`src/RwsClient2.ts:63-153`): ≥55 ms
   between requests, `Accept: application/xhtml+xml;v=2.0`, Content-Type +
   Content-Length on **all** POST/PUT/DELETE even with empty body (406 otherwise),
   session cookie replay, 10 s socket timeout, errors surfaced via
   `XhtmlParser.getError()`.
4. `releaseMastership('rapid')` in `finally`, release errors swallowed
   (`.catch(()=>{})`) so they never mask the primary failure.

### 4.3 Live state — subscriptions with polling fallback (`RobotManager`)

1. `connect()` coalesces concurrent calls (`connectingPromise`,
   `src/RobotManager.ts:285-293`), probes/recovers the port, selects the adapter by
   `authType` (`basic`→RWS2Adapter, `digest`→RWS1Adapter with persisted session cookie
   keyed `host:port` from `~/.abb-rws-session`, `src/RobotManager.ts:30, 359-375`).
2. `startSubscriptions()` subscribes to `['controllerstate','operationmode',
   'speedratio','execution','coldetstate',{type:'elog',domain:0}]`
   (`src/RobotManager.ts:1284-1308`).
   - RWS 1.0 path: `WsSubscriber` POSTs `/subscription` (expects 201 + `Location`),
     opens WS with subprotocol `robapi2_subscription` and the **session Cookie** (not
     Digest), reconnects ≤3 times with 1 s/2 s/4 s backoff on unclean close
     (`src/WsSubscriber.ts:161-288`).
   - RWS 2.0 path: `RwsClient2.subscribe()` hand-rolls the POST (semicolons in the body
     must stay **literal**, `src/RwsClient2.ts:1337`), takes the WS URL from `Location`
     (real hardware) or the XHTML body (VC), authenticates the WS with the Cookie from
     that response, sends `'PING'` every 25 s (controller closes idle sockets at 30 s)
     (`src/RwsClient2.ts:1375-1530`).
3. Success → poll every **5 s** (positions etc.); failure → subscription-less full
   polling every **1 s** (`src/RobotManager.ts:392-413`). A `fetchInFlight` single-flight
   guard prevents the request pile-up that caused 10 s timeouts during heavy motion
   (`src/RobotManager.ts:404-409`).
4. `handleSubscriptionEvent` matches `event.resource` against both friendly names (RWS1)
   and URL paths (RWS2) via regex (`src/RobotManager.ts:1310-1351`).
5. Three consecutive `fetchAll` failures → auto-disconnect + `errorListener(msg,
   ['Show Logs','Reconnect'])` (`src/RobotManager.ts:1455-1472`).

---

## 5. Conventions & invariants

- **Zero external dependencies** except `ws`: digest auth via `node:crypto`, parsing via
  regex only (`src/ResponseParser.ts:5` — *"no external XML libraries"*), probing via raw
  `node:http(s)`. `ws` is dynamically imported only when subscribing
  (`src/RwsClient2.ts:1450-1451`).
- **ESM-only**: `"type": "module"`, internal imports use explicit `.js` extensions;
  `WsSubscriber` uses `createRequire` to load the CJS `ws` package.
- **Session-slot conservation is a design invariant.** IRC5 allows 70 concurrent RWS
  sessions; filling the pool causes persistent 503s. Hence: `HttpSession.clearSession()`
  is a documented **no-op** (`src/HttpSession.ts:120-131`), session expiry clears only
  digest state (never cookies), `disconnect()` GETs `/logout` to free the slot
  (`src/RwsClient.ts:201-211`, `src/RwsClient2.ts:159-166`), cookies persist to
  `~/.abb-rws-session` keyed by `host:port`, and keep-alive agents reuse TCP connections.
- **Rate limiting**: ≥55 ms between requests on both protocols (< 20 req/s controller
  limit) — serial promise queue in `HttpSession` (`enqueue`, L140-158), timestamp gate in
  `RwsClient2.req()` (L71-73).
- **Error convention**: public methods throw `RwsError` with a typed `code`
  (`src/types.ts:284-314`) — but see §7: large parts of `RWS1Adapter` and the optional
  endpoints throw plain `Error` or silently return defaults instead.
- **Mastership**: package vocabulary is always the RWS 1.0 domains
  `'cfg' | 'motion' | 'rapid'` (`src/types.ts:201`); the `'edit'` rename is internal to
  `RwsClient2`. Pattern: acquire → try → release-in-`finally` (`withMastership`,
  `src/RobotManager.ts:550-555`). Exception: `jog()` holds `'motion'` mastership across
  calls and auto-releases 2 s after the last jog (`src/RobotManager.ts:1249-1268`).
- **RMMP policy** (OmniCore remote-control-in-AUTO): `withMastership` deliberately does
  **not** pre-check RMMP (doc at `src/RobotManager.ts:539-549` lists the false-positive
  cases); `jog()` **does** pre-check and throws with a "approve the popup on the
  FlexPendant" message (`src/RobotManager.ts:1234-1247`).
- **Optional-method feature detection**: `IRWSAdapter` has ~90 optional methods; RWS 1.0
  leaves unsupported ones `undefined` so callers can feature-test
  (`if ('resetMastershipWatchdog' in adapter)`, `src/RWS1Adapter.ts:129-133`).
- **Live-probe provenance**: undocumented protocol behavior is recorded in doc comments
  citing probe scripts and dates (e.g. *"Live-verified 2026-05-07 via
  scripts/probe-speedratio.js"* pattern in `RwsClient2.ts`). These comments are the
  protocol documentation of record — preserve them when editing.

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
- **Token mastership** (`requestMastershipWithId`) is RWS 2.0-only; release body field is
  `mastershipid` — no dash, *"confirmed via 400 'Invalid value' probing"*
  (`src/RwsClient2.ts:936-938`). Watchdog: RW 7.8+ requires ~1 s heartbeat pings while
  holding mastership during execution or motors go off (`src/RwsClient2.ts:947-951`).
- **Op-mode writes**: RWS 1.0 wire values are `auto|man|manfs` (`src/RwsClient.ts:328-336`);
  RWS 2.0 wants `manf` **not** `manfs` (`src/RwsClient2.ts:238-247`). AUTO↔MANF must
  transit through MANR with a 600 ms settle pause (`src/RobotManager.ts:496-508`). Going
  to AUTO needs edit mastership **plus a FlexPendant confirmation popup — "no API path
  bypasses it — verified live"** (`src/RobotManager.ts:485-491`). VC-only on real
  hardware (key switch wins, 403).
- **IK/FK on VCs always fails**: standard VCs lack the PC Interface (616-1) option; every
  input returns HTTP 400 `SYS_CTRL_E_POSE_OUTSIDE_REACH` (−1073436654) *"even the
  controller's own current pose"* (`src/IRWSAdapter.ts:81-87`). The 12-parameter body
  format was confirmed by sequential field probing (`src/IRWSAdapter.ts:76-79`). FK on
  RWS 2.0 can return HTTP 200 with the error only as
  `<a href=".../retcode?code=N" rel="error"/>` (`src/RwsClient2.ts:1037-1043`).
- **Fileservice quirks** (all live-verified, `CHANGELOG.md:173-180`):
  `createDirectory` params go in the **body** (`fs-action=create`; query form → 400
  *"Invalid/No Query Parameter"*, `src/RwsClient.ts:870-872`); `copyFile` is
  same-directory-only (`fs-newname` must be a bare filename,
  `src/ResourceMapper.ts:412-416`); RWS 1.0 home is `$HOME` (keep the `$` literal in
  paths — `src/ResourceMapper.ts:292-293`), RWS 2.0 home is `HOME`
  (`rws2Path()` strips `$`, `src/RwsClient2.ts:655`); RWS 2.0 upload needs the
  **versioned** content type `text/plain;v=2.0` (plain → 415, `src/RwsClient2.ts:667-668`);
  RWS 2.0 module unload is `POST .../unloadmod` (DELETE → 405, `src/RwsClient2.ts:382-384`).
- **`loadmod replace=true` leaves a stale symbol table** — after replace, `resetRapid()`
  reports "no main" even though the new file has one; explicit unload + load fixes it
  (`src/RobotManager.ts:933-938`). `loadProgram` deliberately does **not** unload other
  modules (older versions destroyed e.g. OmniCore's `Module1`,
  `src/RobotManager.ts:944-946`).
- **Subscription bodies must not percent-encode semicolons**
  (`src/WsSubscriber.ts:87-89`, `src/RwsClient2.ts:1337`). WS auth is **Cookie, not
  Authorization/Digest** on both protocols (`src/WsSubscriber.ts:251`,
  `src/RwsClient2.ts:1434-1448`). RWS 2.0 VCs may reject the `robapi2_subscription`
  subprotocol entirely → polling fallback (README `L221`).
- **Jog needs a monotonic `ccount`** — the controller rejects repeated values; counter is
  per-instance state (`src/RWS1Adapter.ts:210`, `src/RwsClient2.ts:1561`).
- **Controller-side typo**: the program-pointer response emits span class `modulemame`
  (sic); code checks both spellings (`src/RwsClient2.ts:1715-1725`; the same fallback in
  `src/RWS1Adapter.ts:418` is compensating for the same firmware typo).
- **RWS 1.0 licence path is singular** `/rw/system/license` — the official doc's plural
  `/licenses` 404s on live IRC5 (`src/RWS1Adapter.ts:289-291`).
- **Wide port scan**: RobotStudio assigns VC ports across 1024–30000 (observed: 5466,
  9403, 11811, 15120, 16146, 28447); scan uses 300 concurrent sockets — *"~500 is the
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
npm test          # vitest run — 116 unit tests, offline (stubbed fetch / localhost fixtures)
npm run lint      # eslint src (flat config; tests/ and examples/ are NOT linted)
npm publish       # prepublishOnly runs build + test automatically
node validate.mjs # manual smoke against a live controller (hardcoded 192.168.125.1, 'Default User')
```

Live validation: `VALIDATION.md` (15 manual scenarios, **RWS 1.0 only**) plus the VS Code
extension repo's `test-*.js` live suites. README's claim of "116 unit tests" is exact;
the "339 live protocol-coverage tests" refers to the extension-side live scripts
**(inferred — not re-counted)**.

Test coverage skew (from reading every test): digest handshake, cookies, rate limiting,
and 9/24 ResponseParser parsers are well covered; **untested**: all POST/PUT/DELETE
paths in HttpSession, timeout/abort, session-cookie persistence, `createAdapter`,
`probeHost`, everything in `RobotManager`/`MultiRobotManager`/`WsSubscriber`/adapters,
15/24 parsers, ~36/52 ResourceMapper builders. `RwsClient2.unit.test.ts` is smoke-only
by design (*"protocol-level methods are exercised by … live tests"*, L5-7).

---

## 8. Discrepancies (doc vs code vs types vs changelog)

| # | Discrepancy | Evidence |
|---|---|---|
| 1 | **Examples 05 & 06 are broken**: `new RwsClient2({host,…})` (options object) but the constructor is positional (`src/RwsClient2.ts:45-49`); `new RobotManager({adapter})` + `robot.start()`/`robot.stop()` — RobotManager has no such constructor/methods. Both examples ship in the npm tarball. | `examples/05-remote-control-rmmp.mjs:12-21`, `examples/06-pull-module-source.mjs:23-28` |
| 2 | `types.ts` header still says *"Targets RWS 1.0 … only. v0.5.0"* — contradicts the dual-protocol package | `src/types.ts:2-3` |
| 3 | `package.json` `exports` lists `"import"` before `"types"`; TS honors `types` only when it comes **first** — type resolution under `moduleResolution: nodenext` may fall back or fail | `package.json:25-30` |
| 4 | `repository`/`homepage` point to `github.com/merajsafari/abb-rws-client` but the actual git remote is `github.com/ichbinmeraj/abb-rws-client` | `package.json:17-21` vs `git remote -v` |
| 5 | README says both clients expose "the same method names for ~140 endpoints" — false at client level (`getModuleSource` exists on `RwsClient2:1292` but not on `RwsClient`/`RWS1Adapter`); parity holds at the IRWSAdapter/RobotManager level | `README.md:78`, `examples/06:24-25` |
| 6 | README error-code table omits `PROTOCOL_DETECT_FAILED` (added in 0.7.0 per `CHANGELOG.md:157-158`) | `README.md:459-469` |
| 7 | Default username: README/examples say `'Admin'`; `validate.mjs:5` and `VALIDATION.md` scenario 2 use `'Default User'`. Code default is `'Admin'` (`src/RwsClient.ts:134`); `createClient` falls back to `'Default User'` on 401 | `validate.mjs:5`, `VALIDATION.md:63` |
| 8 | `VALIDATION.md:9` requires "Node 21+ (or Node 18 with `--experimental-websocket`)" — stale; the package depends on `ws` and declares engines ≥18 | `VALIDATION.md:9` vs `package.json:38-40` |
| 9 | CHANGELOG 0.7.0 says examples/ has "four scripts"; six exist; 0.7.2 claims to be "bit-for-bit identical to v0.7.1" — provenance of examples 05/06 unrecorded | `CHANGELOG.md:160-161, 35-37` |
| 10 | `ResponseParser` docstrings cite li classes `rap-jointtarget`/`rap-robtarget` and path `/rw/mechunit/…`; code + fixtures (real IRC5 output) use `ms-jointtarget`/`ms-robtargets` and `/rw/motionsystem/mechunits/…` — trust the code | `src/ResponseParser.ts:195-196, 227-228` vs tests |
| 11 | The `\b` word-boundary class matching does **not** prevent hyphen-suffix collisions (`\b` fires at letter↔`-`); the comment claiming `'rap-task-li'` won't match `'rap-task-li-selected'` is wrong (behavior benign today) | `src/ResponseParser.ts:52-58` |
| 12 | `detect.ts` doc claims "≥443 → https" but code checks exact ports 443/5466/9403; `opts.timeout` never reaches RWS 2.0 constructions; `createAdapter` lacks the Default-User fallback `createClient` has | `src/detect.ts:19, 120, 152, 172-206` |
| 13 | `RwsClient.uploadModule` is `@deprecated` in favor of `uploadFile`, yet `RWS1Adapter.uploadFile` calls the deprecated alias | `src/RwsClient.ts:768-771`, `src/RWS1Adapter.ts:107` |
| 14 | `fetchAll` hardcodes `taskName = 'T_ROB1'` for the module list despite `activeTaskName()` existing — multi-task systems poll the wrong list | `src/RobotManager.ts:1384, 615-619` |
| 15 | `RWS1Adapter` stage-header method counts don't match bodies (e.g. "Stage 8: DIPC (6 methods)" has 5) — cosmetic drift from incremental buildout | `src/RWS1Adapter.ts:540-681` |
| 16 | Three duplicated default-`RobotState` literals must be kept in sync when the shape grows | `src/RobotManager.ts:69-75, 430-436`; `src/MultiRobotManager.ts:49-56` |
| 18 | `MultiRobotManager.fromConfigs` doc claims "backward compatibility for legacy single-robot settings" — no such logic exists in the method (it lives in the extension) | `src/MultiRobotManager.ts:142` |
| 19 | `probeProtocol` resolves `'rws2'` for **any** sub-500 response lacking a `Digest`/`Basic` challenge — an unknown scheme (`Bearer …`) or a plain non-RWS web server is misdetected as an OmniCore. The Bearer fixture in `detect.test.ts` is created but never asserted | `src/detect.ts:62-66`, `tests/detect.test.ts` |
| 20 | `SESSION_EXPIRED` is declared in `RwsErrorCode` but thrown nowhere in `src/` (grep-verified); `mapHttpStatus` maps **every** 404 to `MODULE_NOT_FOUND` (missing signals/files included) | `src/types.ts:285`, `src/HttpSession.ts:429-443` |
| 21 | `XhtmlParser` is stricter than `ResponseParser` without saying so: `<li>` matching requires `class` to be the **first** attribute with an exact value (no `\b`/multi-class), `getError()` only matches **negative** codes (`(-\d+)`), and no HTML entities are decoded. Untested limits | `src/XhtmlParser.ts:20-27,44-46` |
| 22 | `HttpSession.storeCookies` runs only on 2xx — a `Set-Cookie` on the 401 challenge (or any error response) is dropped; `RwsClientOptions.sessionCookie` doc says "cookie **value**" but the parser expects the full Cookie header string | `src/HttpSession.ts:231,79`, `src/types.ts:261` |

---

## 9. Open questions

1. **`WsSubscriber` on Node 22+**: it prefers native `globalThis.WebSocket` but passes the
   session Cookie via a third constructor argument only the `ws` package supports — native
   undici WebSocket ignores it, so RWS 1.0 WS auth may silently fail exactly on modern
   Node (`src/WsSubscriber.ts:21-33, 246-253`). Needs a live probe on Node 22.
2. `rap-syproppers-li` (PERS symbol li class, `src/RwsClient2.ts:440`) is missing the "m"
   every sibling class has (`rap-sympropvar-li`…) — real controller class name or typo
   that silently drops PERS results from symbol search?
3. `setCfgInstance` writes to `/rw/cfg/{d}/{t}/{instance}` while reads use
   `…/{t}/instances/{instance}` — is the write path live-verified?
   (`src/RwsClient2.ts:753, 766`). Same for `createCfgInstance` (comment/code disagree,
   L770-771) and `setActiveTool`/`setActiveWobj` bare POSTs (L841-845).
4. Have `runCyclicBrakeCheck`, `listSafetyZones`, `listBreakpoints` (RWS 1.0 side) ever
   succeeded live? All are doc-derived with hedging comments
   (`src/RWS1Adapter.ts:621-628, 700`), and project probing found `/ctrl/safety` blocked.
5. `removeBreakpoint` uses a different, singular path than list/set
   (`src/RwsClient2.ts:1236`) — untested?
6. Does a pre-loaded `sessionCookie` let RWS 1.0 skip the digest handshake entirely on
   real firmware, or does it always bounce through one 401?
7. Auth `qop=auth-int` is accepted but hashed as `auth` with no body hash — would fail on
   a controller that actually demands auth-int (`src/HttpSession.ts:348-350`). Do any?
8. WS reconnect reuses the same subscription URL without re-POSTing `/subscription`; if
   the controller GC'd it during the outage all 3 retries fail **silently** and events
   stop with no error to the caller (`src/WsSubscriber.ts:277-287`). Wanted behavior?
