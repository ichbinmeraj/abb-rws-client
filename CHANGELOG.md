# Changelog

All notable changes to `abb-rws-client` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.3] — 2026-07-03

### Fixed

- **TLS bypass now applied per-request, not only on the HTTP agent** — fixes
  connections to real controllers from inside VS Code
  ([abb-rws-vscode#2](https://github.com/ichbinmeraj/abb-rws-vscode/issues/2)).
  VS Code's extension host patches Node's `http`/`https` modules and replaces
  custom agents for non-localhost targets, which silently dropped the
  agent-level `rejectUnauthorized: false` and re-enabled certificate
  verification — every real OmniCore (self-signed cert) then failed with
  `self signed certificate`. Localhost VCs were never affected because the
  extension host doesn't intercept localhost traffic. The setting is now also
  set on each request's options in `RwsClient2.req()`, the subscription POST,
  `RobotManager` port probing, and `detect.probeProtocol()`.
- **Examples 05 & 06 rewritten against the real API** — they previously used an
  options-object `RwsClient2` constructor and `RobotManager` methods that never
  existed. Both now use `new RobotManager()` + `connect(host, user, pass, port?)`.
- **`repository`/`homepage`** now point at the actual GitHub org (`ichbinmeraj`);
  the previous links 404'd from the npm package page.
- Stale `types.ts` header no longer claims the package is RWS 1.0-only.

### Added

- **`prepack` guard** — `npm pack`/`npm publish` now runs the build and the full
  116-test suite first, so a stale or broken artifact cannot be packed.

## [0.7.2] — 2026-05-08

### Documentation

- **Fixed the embarrassing compatibility table** that incorrectly claimed
  RobotWare 7.x / OmniCore was "Not compatible". The package has supported
  both protocols since v0.7.0 — the table was a stale leftover from when
  only RWS 1.0 shipped. Now correctly shows both ✅, with live-tested
  versions called out (RW7.21 + RW6.16).
- **Documented `RobotManager` higher-level surface** — the README's
  API-reference tables only covered the protocol-level `RwsClient`, so
  callers couldn't see what `RobotManager` adds on top: RMMP, mastership
  status, opmode auto-routing, backup, FK, service-routine call,
  tool/wobj activation, CFG write surface, DIPC messaging, file volumes,
  module source, compress, value validation. New section lists all of
  these with descriptions.
- **Clarified RWS 2.0 subscription quirks** — the polling-fallback
  paragraph now names the specific RWS 2.0 VC `robapi2_subscription`
  rejection that triggers the fallback, rather than implying it's
  always 5s polling.
- **Session-pool clarifications** — IRC5's 70-session number was being
  presented as universal; called out OmniCore's also-finite-but-different
  pool with the empirical 503-once-full behaviour we observed during
  protocol probes.
- **`RobotManager` polling cadence** correctly described as hybrid:
  5 s when WS subscriptions handle state changes, 1 s when polling
  covers everything.

No code changes — pure README updates. `RwsClient`, `RwsClient2`,
`RobotManager`, `MultiRobotManager`, `createClient`, all examples and
unit tests are bit-for-bit identical to v0.7.1.

## [0.7.1] — 2026-05-07

### Added

- **RMMP (Remote Mastership Privilege)** is now part of the public `RobotManager`
  surface — `getRmmpPrivilege()` and `requestRmmp(level)`. The `withMastership()`
  helper now also gates on RMMP, so any modify operation in AUTO mode will
  automatically request RMMP and surface an actionable error ("approve the
  popup on the FlexPendant") when the operator hasn't granted remote control
  yet. This matches RobotStudio Online's behaviour and removes the most common
  cause of mastership-acquired-but-403 failures.
- **Service-routine / arbitrary PROC call** — `callServiceRoutine(task, name,
  args?)` lets a remote client kick off a service routine (calibration, brake
  check, custom service procs) without going through the FlexPendant's
  Service Routine menu.
- **Tool / Work-object activation** — `setActiveTool(mechunit, name)` and
  `setActiveWobj(mechunit, name)` switch the active persistent tooldata /
  wobjdata mid-session.
- **Module metadata** — `getModuleInfo(task, module)` exposed publicly (was
  adapter-only). Returns path, attributes, type, line count.
- **Backup restore** — `restoreBackup(name)` exposed publicly (was adapter-only).
- **Backup status** type-narrowed — `getBackupStatus()` now returns the full
  `{ active; progress?; phase? }` shape on every code path (no more union
  with bare `{ active }`).
- **CFG write surface** exposed publicly with mastership wrapping —
  `setCfgInstance`, `createCfgInstance`, `removeCfgInstance`, `loadCfgFile`,
  `saveCfgFile`. Each acquires `'edit'` mastership for the duration of the
  call.
- **DIPC public API** — `listDipcQueues`, `createDipcQueue`, `sendDipcMessage`,
  `readDipcMessage`, `removeDipcQueue` exposed on `RobotManager`.
- **File volumes** — `listFileVolumes()` returns the controller's available
  volumes (HOME, BACKUP, DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP).
- **Compress** — `compressPath(source, destination)` for archiving controller
  files in-place.
- **Mastership status** — `getMastershipStatus(domain)` returns
  `{ mastership; uid?; application? }`. Useful for diagnosing 403s ("which
  client / FlexPendant is currently holding the lock?").

### Improved

- `getRobotType`, `getProgramPointer`, `getMotionPointer` now have explicit
  return-type annotations on the `RobotManager` wrappers — TypeScript no
  longer collapses the empty-default into a property-less union.

### No breaking changes

- All additions are new methods or default-no-op widening. Existing callers
  using `RobotManager` keep working without any changes.

## [0.7.0] — 2026-05-06

This release adds RWS 2.0 (OmniCore / RobotWare 7) support, multi-robot
management, auto-detection helpers, and a full set of higher-level building
blocks. The package now legitimately covers BOTH RWS protocols ABB ships,
including the long-tail endpoints (devices, all-IO-devices, mastership
extras, forward kinematics) that were missing from prior versions.

### Added

- **`RwsClient2`** — RWS 2.0 protocol client for OmniCore controllers.
  HTTP Basic auth, XHTML responses (`Accept: application/xhtml+xml;v=2.0`),
  path-based actions (`/rw/rapid/execution/stop`), `'edit'` mastership
  domain, `HOME` file-service prefix, self-signed-TLS tolerance for VCs,
  WebSocket subscriptions via `robapi2_subscription` subprotocol.

- **`IRWSAdapter`** — common interface implemented by both RWS 1.0 and 2.0
  adapters. ~140 methods covering panel, RAPID exec, modules, variables,
  motion, system, event log, I/O, file service, CFG database, mastership,
  backup, DIPC, vision, safety, virtual time, certs, registry, jog, IK/FK.

- **`RWS1Adapter`** / **`RWS2Adapter`** — wrappers that satisfy `IRWSAdapter`
  on top of `RwsClient` and `RwsClient2` respectively. Use these when you
  want a single typed handle that works across both protocols.

- **`RobotManager`** — high-level connection lifecycle: auto port discovery,
  protocol auto-detection, polling, WebSocket subscriptions with polling
  fallback, reconnect-on-failure, state events. `onError` listener lets the
  host (CLI / UI) decide how to surface failures.

- **`MultiRobotManager`** — orchestrates several `RobotManager` instances.
  Tracks an "active" robot for UIs that show one at a time, while polling
  state for all. `onError` cascades to every existing and future robot.

- **`createClient(opts)`** / **`createAdapter(opts)`** — auto-detect helpers
  that probe the WWW-Authenticate header and return the matching client
  (or `IRWSAdapter`) already connected. Probes common RWS ports if `port`
  is omitted (5466, 9403, 443, 80, 11811).

- **`probeProtocol(host, port, https)`** / **`probeHost(host)`** — lower-level
  protocol detection for callers that want explicit control.

- **Mastership extras** (RWS 2.0 + partial RWS 1.0):
  - `requestMastershipAll()` / `releaseMastershipAll()` — all-domains in one call
  - `requestMastershipWithId(domain)` / `releaseMastershipWithId(domain, id)` —
    token-based mastership that survives session loss; useful for clients
    that periodically reconnect (RWS 2.0 only)
  - `resetMastershipWatchdog()` — heartbeat for RobotWare 7.8+ during long
    RAPID runs
  - `getMastershipStatus(domain)` / `listMastershipDomains()` — read state

- **Devices** — both `/rw/devices` (system hardware/software inventory) and
  `/rw/iosystem/devices` (all configured I/O devices across networks):
  - `listSystemDevices()` — top-level groupings (HW_DEVICES, SW_RESOURCES)
  - `getDeviceTree(group)` — drill into a group
  - `listAllIoDevices()` — flat list of every I/O device with state

- **Forward Kinematics** — `calcCartesianFromJoints(joints, mechunit?, tool?, wobj?)`,
  the missing mirror of `calcJointsFromCartesian`. Same VC-license caveat as IK:
  virtual controllers without PC Interface 616-1 reject the call (clean error
  message; no NaN leakage).

- **`XhtmlParser`** — exported for advanced users parsing RWS 2.0 responses
  manually. Handles span / li / state extraction with regex.

- **`setLogger(impl)`** — pluggable logging interface. The lib ships with a
  no-op default; hosts (e.g. the VS Code extension) install their own
  backend (output channel, console, file, etc.).

- **`RwsErrorCode`**: new value `'PROTOCOL_DETECT_FAILED'` for cases where
  no RWS endpoint answers on the probed port(s).

- `examples/` directory with four scripts: quickstart-auto, rws1-explicit,
  rws2-explicit, multi-robot.

### Changed

- **README** rewritten for dual-protocol support. Quick Start now uses
  `createClient` for the typical case; explicit-protocol usage documented.

- **`RwsClient.disconnect()`** now calls `GET /logout` server-side before
  clearing the local session. Without this, the controller-side session
  lingered for several minutes, holding any acquired mastership and
  filling the controller's session pool. Live-verified.

- **`RwsClient` createDirectory**: params now in body (`fs-action=create`
  in body, not URL query). Live-verified — RWS 1.0 fileservice returns
  HTTP 400 "Invalid/No Query Parameter" for the URL-query form.

- **`RwsClient` copyFile**: `fs-newname` now sends only the basename of the
  destination path. RWS 1.0 fileservice copy operates within the source's
  directory — passing a full path returns 400 "Invalid". Cross-directory
  copy must use read+upload.

- `package.json`: added `description`, `keywords`, `homepage`, `repository`,
  `engines.node`, `prepublishOnly` script. Removed invalid self-reference
  in `dependencies`. Added `@types/ws` to devDependencies.

### Compatibility

- **Node.js 18+** required (matches existing minimum).
- **No breaking changes for existing RWS 1.0 users.** `RwsClient` and its
  type exports are unchanged in behavior except for the bug fixes above.
- New names (`RwsClient2`, `RobotManager`, etc.) sit alongside the old API.

## [0.6.0] — 2026-04-30

- WebSocket subscriptions via `subscribe(resources, handler)`.
- Generic `request(method, path, body?)` escape hatch for RWS endpoints
  not covered by typed methods.
- ~57 typed RWS 1.0 methods.

## [0.5.0] and earlier

- Initial RWS 1.0 client: HTTP Digest auth, session cookie management,
  request rate limiting, automatic re-authentication, typed `RwsError`.
