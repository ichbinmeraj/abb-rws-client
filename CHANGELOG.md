# Changelog

All notable changes to `abb-rws-client` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-08-09

Everything below accumulated after the 1.1.0 entry was written on 2026-08-02.
1.1.0 was version-bumped and changelogged but never tagged or published, so npm
goes 1.0.0 → 1.2.0; the 1.1.0 section is kept as the record of what was true on
its date rather than being back-filled.

### Fixed

- **RobotWare 8 no longer throws when releasing write access.** Any write clears
  control-station write access as a side effect on RW8 — the status resource
  reports `held=false` immediately after a write while the session keeps writing
  successfully — so the release that followed was refused with
  `403 "The control station does not have SPoC."` and `releaseMastership`
  propagated it. Because the documented pattern is acquire → try →
  release-in-finally, that surfaced from the `finally` and masked the caller's
  real result: a write that had actually succeeded looked like a failure.
  Nothing ever leaked (`held` reads false throughout, and a fresh acquire always
  succeeds), so this specific refusal is now treated as "already released".
  Every other 403 from release still throws. RobotWare 7 was never affected.

### Added

- **In-place RAPID module source editing**: `setModuleText` replaces a module's
  source directly in program memory (the write side of the existing
  `getModuleText`, with no TEMP round trip), and `setModuleTextRange` replaces a
  row/column range. Both are RWS 2.0 only. Note the controller's own form for the
  ranged variant advertises `action=".../textrange"`, which 404s — the real path
  is `/text/range`, the one its OPTIONS is served at.
- `setKeylessMotorOn` — motors on without the key switch, for controllers with
  the Keyless Mode Switch option. The resource lives at
  `/rw/panel/ctrl-state/keyless-motoron`; the widely-recorded
  `/rw/panel/keyless-motoron` 404s on every generation.
- **The endpoint-completion surface is reachable from every layer**, not just
  `RwsClient2`: the 19 methods are declared on `IRWSAdapter` (optional, since
  all of them answer 404 on IRC5) and wrapped by `RobotManager`. Reads degrade
  to a neutral value on RobotWare 6; **writes throw a typed
  `UNSUPPORTED_OPERATION`** rather than silently doing nothing. A shape test
  asserts the RWS 2.0-only asymmetry so it stays a deliberate decision.
- `RobotManager.subscriptionGroupPath` exposes the manager's own live
  subscription group, so `updateSubscriptionGroup` / `unsubscribeResource` can
  add or drop resources on the manager's stream without tearing it down.
- Endpoint-completion sweep. Every remaining endpoint the controllers advertise
  is now either implemented and live-verified or documented as unreachable with
  the controller's own refusal as the evidence; `docs/tasks/endpoint-completion.md`
  carries the per-endpoint record. New methods: `setPanelLanguage`,
  `setControllerLanguage`, `setExternalEmergencyStop`, `searchSignalsEx`,
  `validateCfgInstances`, `getCollisionPredictionModelName`,
  `saveCollisionAvoidanceSnapshot`, `loadCollisionAvoidanceConfig`,
  `modifyPosition` (ModPos), `resetTaskProgramPointer`, `getDiagnostics`,
  `saveDiagnostics`, `saveSystemInfo`, `registerUser`, `impersonateUser`,
  `isPasswordChangeAllowed` and `changePassword`.
- **Subscription groups can be edited in place.** `updateSubscriptionGroup` adds
  resources to a live group (the controller answers with the added resource's
  initial value event, so there is no wait for the first change) and
  `unsubscribeResource` drops a single resource without tearing the group down.
  Both clients previously rebuilt the entire group on any change. The group's
  path is exposed as `groupPath` on the handle `subscribe()` returns — the
  handle is still callable exactly as before.
- Several endpoints behave differently from what the specification implies, all
  live-verified on RobotWare 7.21 and 8.1.1: `signal-search-ex`'s second criteria
  set **narrows** rather than unions, and it does not glob; `validate-instances`
  takes a **numeric** `operation` (only 0 or 1) and validates instances that
  **already exist** rather than proposed ones; `collisionprediction/modelname`
  numbers robots from **zero**; and `/ctrl/system/info` is a POST that writes a
  file, not a getter. Each is recorded in the method's doc comment.
- `listCurrentUserGrants` now works on RobotWare 6 as well: RWS 1.0 serves the
  logged-in user's grants at `/users/grants` (26 grants on a live IRC5), so the
  method name is the same on both protocols. Only the `/uas/*` tree is genuinely
  RWS 2.0 only. `listNetworkInterfaces` added for the full interface list.
- Resource-tree crawl batch. Crawling what the controllers advertise about
  themselves surfaced resources no documentation lists: `listEventLogDomains`
  (a live controller carries events in six domains, while `getEventLog`
  defaults to domain 0 alone), `getCyclicBrakeCheckStatus` (the resource
  requires a `drivenum` query parameter, which is why the old call never
  worked), `listInstructionCategories` and `listInstructions` (the pendant's
  RAPID instruction catalog, 20 categories - useful for editors),
  `getRegistryFile` (the eleven controller registry files, content inline),
  and `getTaskChangeCount`.
- `RestartMode` now includes `shutdown` and `xstart`, which RobotWare 7/8
  accept; calling either against an IRC5 throws `UNSUPPORTED_OPERATION` (a new
  error code) rather than failing at the controller.
- `describeReturnCode` translates a controller status code through the
  controller's own dictionary, returning ABB's symbolic name
  (`SYS_CTRL_E_NO_SUCH_SYMBOL`), a severity and a sentence of prose. Every
  `RwsError` already carries a `controllerCode`; this turns it into something
  worth showing a person, including for codes this client has never seen. It
  works on all three generations, and the dictionary is per-generation, so a
  RobotWare 8 code comes back null on RobotWare 7.
- Certificate store, backup state and controller device inventory, found by
  crawling what the controllers advertise and diffing it against every path
  the client references. `getBackupState` closes a real hole: `createBackup`
  answers 202 and finishes asynchronously, and there was no way to tell when.
  `listCertificateStores` and `getCertificates` read the PEM the controller
  presents for RWS and the CA store it trusts. `listDeviceGroups` and
  `listControllerDevices` list the drive links, mechanical units and
  FlexPendant, and the software resources. `listLdapResources` and
  `getLdapResource` reach the last advertised resource left, the latter as a
  deliberate pass-through returning whatever fields the controller sends,
  because both VCs refuse every LDAP read and carry no LDAP option, so the
  field names cannot be learned here and are not guessed. RobotWare 6 serves the same
  inventory in a different body shape and one level deeper (HW_DEVICES holds
  CONTROLLER, which holds COMPUTER_SYSTEM), so it has its own walker and a
  nested path reads any level. After this the only advertised
  resource the client does not touch is `/uas/ldap`, whose sub-resources
  answer 403 for a normal user, so its success shape cannot be verified here
  and it is deliberately not implemented blind.
- `getEventLog` can list newest-first: pass `'newest'` as the fourth argument.
  Paging from the oldest end meant a controller with a long log handed back
  boot messages instead of what just happened, which is backwards for
  diagnostics. This needs the `v=2.1` media type, which is not in the
  published API reference and which the event log is the only resource to
  accept; under `v=2.0` the controller refuses `order=lifo` and names 2.1 in
  the error. Live-verified on RW7.21 and RW8.1.1.
- `ElogMessage.args` carries the substituted values of an event-log message.
  The controller stores the text as a template and sends the values
  separately, so "The speed has been adjusted to 100% by Default User" arrived
  as a generic title with the two values dropped on the floor. On the live
  controllers 58 of 153 messages (RW7) and 48 of 83 (RW8) carry arguments, so
  a large share of the log was losing the detail that says which task, which
  value, which user. Read on both protocols and both representations.

### Fixed

- **The RWS 2.0 rate limit did not hold under concurrency.** Pacing read the
  last-request timestamp, awaited a timer, then wrote it back, so callers that
  arrived together all saw the same stale value and all fired at once: five
  concurrent reads went out in 81 ms against the controller's documented
  ceiling of 20 per second. Exceeding that ceiling is exactly what makes a
  controller start answering 503. Request starts are now chained, so the gap
  holds however calls arrive; the requests themselves still overlap, so a call
  that blocks server-side cannot stall the ones behind it. RWS 1.0 had a
  proper queue all along.
- **About a hundred public methods threw a plain `Error`,** so
  `catch (e) { if (e.code === ...) }` silently matched nothing on those paths
  even though every method is documented to throw `RwsError`. The worst of it
  was `RWS1Adapter`'s two generic `?json=1` helpers, which back roughly fifty
  endpoints and turned every controller failure into an untyped error. They
  now classify through the same taxonomy as the rest. `RobotManager` and
  `MultiRobotManager` guards carry codes too: `NOT_CONNECTED` (new),
  `UNSUPPORTED_OPERATION`, and, where the manager already knew the reason,
  `MOTORS_OFF`, `WRONG_MODE` and `GRANT_DENIED`. Messages are unchanged, so
  anything matching on text still works. A test now fails the build if a plain
  `Error` reappears on a public path.
- `XhtmlParser` dropped every `<span>` that carried attributes beyond `class`.
  The pattern required `>` immediately after the class, and event-log
  arguments are served as `<span class="arg1" type="long">100</span>`, so they
  never parsed. A test had pinned this as intended behavior; it was a bug.
  The RWS 1.0 parser already tolerated extra attributes.
- **The client leaked RobotWare 8 write access on disconnect.** RW8 does not
  drop control-station write access when the session ends, unlike the
  mastership service it replaces, so logging out while holding it left the
  controller believing a station that no longer existed still owned write
  access. Every later client, ours or anyone's, was then refused with 403
  "Remote Control Station cannot take SPoC when it is taken" until someone
  released it by hand. `disconnect()` now releases first, and only if this
  session actually took it. Found by hitting the leak on a live RW8.
- `setSpeedRatio` rejects a ratio outside 0-100 instead of silently clamping
  it. Clamping meant a caller who passed 500, or 0.85 intending 85%, got a
  different robot speed than they asked for with no error. Speed is a motion
  parameter, so it now throws `INVALID_ARGUMENT` (a new error code) and sends
  nothing. Validation also moved ahead of the write-access acquire, so a bad
  argument costs no controller round trip and its error is not masked by an
  unrelated write-access failure on RW8.
- Seven controller error codes were unmapped, so callers got `UNKNOWN`. Found
  by triggering safe rejected operations on all three generations and recording
  every native code each returns. `unloadModule` on a module that is not loaded
  now reports `MODULE_NOT_FOUND` instead of `UNKNOWN`, and a bad volume in a
  file path reports `RESOURCE_NOT_FOUND` on RWS 2.0 as it already did on RWS
  1.0 (same call, two different codes, because the controller answers 400 on
  one protocol and 404 on the other).
- Classification no longer trusts the controller code alone where the
  controller overloads it. `-1073442816` covers at least three distinct
  conditions with different wording and HTTP status: "Unknown module name",
  "Symbol not found", and an untranslated "org_code: -517". Mapping the number
  straight to `MODULE_NOT_FOUND` made every missing *symbol* look like a
  missing *module*, so the message decides where it is specific. Both meanings
  are pinned by live-captured fixtures.
- **Signal subscriptions never worked on RWS 2.0.** The builder asked for
  `/rw/iosystem/signals/{sig};lvalue`, which OmniCore rejects with HTTP 400
  "Invalid resource URI in Create Subscription request", so every attempt to
  watch an I/O signal in real time failed at subscribe time on RobotWare 7 and
  8. The suffix is `;state` (`lvalue` is the field the event carries, not the
  resource to subscribe on). RWS 1.0 had it right all along. Verified against
  RW7.21 and RW8.1.1.
- **Persistent-variable subscriptions never worked on RWS 2.0 either.** The
  builder used the RWS 1.0 shape `/rw/rapid/symbol/data/RAPID/{sym};value`.
  RobotWare 7 answers that with HTTP 500 "RW-Subscription service is down" (a
  misleading message - the service is fine) and RobotWare 8 with HTTP 400. The
  RWS 2.0 shape puts `data` after the symbol path:
  `/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data;value`.
- **The same `{ type: 'persvar' }` resource no longer behaves differently per
  adapter.** RWS 1.0 requires the leading `RAPID/` domain and rejects the bare
  path with HTTP 400; RWS 2.0 wants it bare. Both builders now normalize, so
  one resource object works on either protocol with or without the prefix -
  which matters because `MultiRobotManager` switches adapters underneath a
  single contract. The full 12-resource subscription surface is now accepted on
  RW6.16, RW7.21 and RW8.1.1 alike.
- `RobotManager` no longer pages over `listAllSignals` itself. That loop was
  correct while the adapter returned a single page, but once the adapter began
  following the controller's pagination it re-fetched from an offset and
  appended duplicates. Verified live: 130 and 141 signals on the two OmniCore
  controllers with no duplicates.
- `listAllGrants` returned an empty list whenever a controller served XHTML.
  The two representations of that one resource use different class and field
  names (`grant-info`/`grant-description` in JSON, `uas-grant`/`description` in
  XHTML), and only the JSON spelling was handled. Both are accepted now. Every
  other read was checked the same way: 80 of 81 parse identically in both
  representations, so this was the only gap.
- **`listAllSignals` and `getEventLog` were silently truncating.** The
  controller caps a page (100 signals, 50 log messages) and ignores a larger
  `limit`, advertising a `next` link instead. Both read a single page, so
  callers saw 100 of 130 signals and 50 of 148 messages without any indication
  that more existed. Both now follow `next` to the end, with a page bound and a
  guard against a controller that points `next` at the current page. Verified
  live: 130 and 141 signals on the two OmniCore controllers, and event-log
  counts that match what the controller reports for the domain.
- **`copyFile` never worked on RWS 2.0.** It sent a `destination` field, which
  the controller rejects with HTTP 400; the copy endpoint takes `fs-newname`
  (a bare target name) plus an optional `fs-overwrite`. Copying now works on
  RobotWare 7.21 and 8.1.1, verified by reading the copy back. A directory part
  in the destination is dropped, matching the RWS 1.0 behavior, and an
  `overwrite` argument was added.
- `setProgramPointer` no longer sends row and column fields that the endpoint's
  form does not accept (a source position is set through the cursor endpoint);
  `userlevel`, which the form does accept, can now be passed.
- **RWS 1.0 symbol properties threw for every persistent.** The parser required
  the VAR list class, but the class encodes the symbol kind, so reading the
  properties of `tool0`, `wobj0` or any PERS raised `PARSE_ERROR` on RobotWare 6.
  All symbol kinds are now accepted (a test that had been marked as a known
  failure now passes).
- RWS 1.0 `listControllerOptions` returned nothing: `/ctrl/options` answers 204
  No Content on RobotWare 6 too. It now reads `/rw/system/options` and returns
  the installed options.
- RWS 1.0 resources that reply in the RobotWare 7 shape (a top-level `state`
  array rather than `_embedded._state`) are now read correctly - `listProducts`
  was empty for this reason.
- **RAPID symbol search silently dropped every persistent.** The PERS result
  class was spelled `rap-syproppers-li` (missing an "m"), so `tool0`, `wobj0`,
  `load0` and every other PERS never appeared in `searchRapidSymbols` or
  `listModuleSymbols` results. Searching the BASE module now returns all three
  on both RobotWare 7.21 and 8.1.1 where it returned nothing.
- **Ten methods were parsing classes the controllers never send, so they
  returned empty or wrong data on every controller.** Found by harvesting every
  class the three controllers actually emit and diffing it against what the
  client expects. Each is now read from the real response and verified live on
  RobotWare 7.21 and 8.1.1:
  `getReturnCode` (the class is `err-desc` with name/description - it returned
  null for every code), `listControllerOptions` (the installed-option list is
  `/rw/system/options`, not `/ctrl/options`, which serves no list at all - 24
  options now returned), `listFileVolumes` (volumes are `fs-dir` entries; it
  silently fell back to a hardcoded list every time), `listCertificates`,
  `getRegistry`, `getSafetyStatus` (`/ctrl/safety` is only a directory of links,
  so the status is now composed from the mode, violation and load resources),
  `getMechunitPjoints`, `getMechunitAxes` (each axis carries a status and a
  logical-axis entry), `getTaskProgramInfo`, `getTaskMotion`, and
  `getRapidSymbolProperties` (persistents and constants use their own classes,
  so only plain variables ever parsed).
- `listSafetyZones` documented as unavailable: `/ctrl/safety/zones` does not
  exist on RobotWare 7 or 8.
- **RobotWare 8.1.1 ships with its RMMP service broken** - every verb answers
  HTTP 500 (verified back to back against a working RobotWare 7.21). The client
  no longer surfaces a bare 500: `getRmmpPrivilege` reports no privilege held,
  and `requestRmmp` explains the situation with `UNSUPPORTED_OPERATION`.
- `listVisionSystems` parsed a class the controller never sends, so it always
  returned an empty list. It now reads the real camera entries, with
  `getVisionCameraCount` for the camera count.
- `getTaskStructuralChangeCount` returned the wrong number: the resource
  carries both a structural and an any-edit counter, and it read the latter
  (215 instead of 6966 on a live controller). It now returns the structural
  count, with `getTaskChangeCount` for the other one.
- `getTaskSelection` parsed a class the controller never sends, so it always
  returned empty lists. It now reads the real entries, including which tasks
  are ON.
- `runCyclicBrakeCheck` documented as unavailable on virtual controllers
  (the resource answers 404 there, and the status resource is read-only).

### Added (continued)

- Deep-coverage read batch, shapes captured live and identical on RW7.21 and
  RW8.1: `getModuleText` (full source straight from program memory, no TEMP
  round trip), `getModuleTextRange`, `searchModuleText` (query param is `text`;
  hits are Row/Column positions), `getModuleChangeCount`,
  `getModuleSyncPersStatus`, `getModuleExtension`, `getProgramPointerSyncState`,
  `getMotionPointerSyncState`, `getSpyStatus`, `getSafetyMode`,
  `getSafetyViolationInfo`, `getSafetyLoadStatus`, `getSafetyStartupStatus`
  (the controller misspells the class as `...-load-satus` on both generations;
  read as-is with the corrected spelling as fallback), and
  `getVirtualTimeTimeslice`.
- `decompressPath` added, and `compressPath` fixed: the controller fields are
  `srcpath`/`dstpath` as fileservice URIs (the documented `source`/`destination`
  are rejected). Compress verified creating the archive on the VC; note the VC's
  compression backend leaves the archive empty (controller-side limitation).
- RWS 1.0 `createBackup`/`restoreBackup` fixed: the backup value must be a
  fileservice URI (`/fileservice/$BACKUP/name`); the previous bare form answered
  400 "Invalid File Service path". Verified 202 + backup created on RW6.16.
  RWS 1.0 `holdToRun` marked unverified: its wire form answers 400 on RW6.16.
- Niche coverage batch, forms taken from each endpoint's own `OPTIONS` response
  and cross-checked live on RW7.21: motion supervision (`setMotionSupervisionMode`,
  `setMotionSupervisionSensitivity`, where the controller field is `sensitivity`,
  not `level`; `setPathSupervisionMode`, all gated behind the Collision Detection
  option), IO (`setSignalSimulated`, `unblockSignals`, `setNetworkLState`,
  `setIoDeviceLState`), `searchDevices` (the field is `property`, not the
  OPTIONS-advertised `properties`), program-pointer navigation (`ppPrevInst`,
  `ppNextInst`, `setPPToRoutineFromUrl`), and `setVirtualTimeTimeslice`,
  `refreshVisionCameras`, `resetEnergy`. Verified live: `setVirtualTimeTimeslice`
  and `unblockSignals` (204); `setSignalSimulated` correctly refused (403) on a
  protected safety signal.
- **RobotWare 8 support.** RW8 removes the mastership service (HTTP 410) and
  requires a registered control station for write access. The client now detects
  the RobotWare version on connect and routes write access automatically:
  mastership on RW7, Control Station write access on RW8 (register once per
  session, then request/release). Every existing write method works unchanged on
  both. The full Control Station Service is also exposed directly:
  `registerControlStationRemote/Local`, `requestWriteAccess`, `releaseWriteAccess`,
  `getWriteAccessStatus`, `appealWriteAccessRelease` (+ change count),
  `getControlStationType/Id`, `isLocalControlStationConnected`,
  `getAllowMotionControl`, `setAllowMotionControl`, `disableExternalControl`,
  `getTpuSafetyProtocolStatus`, plus `getRobotWareVersion`. Wire forms
  discovered and verified end to end on an OmniCore VC RW8.1.1 (the register
  id must be a braced GUID; registration is session-scoped).

- RWS 2.0 coverage additions (verified against an OmniCore VC RW7.21): start RAPID
  from the production entry (`startProductionEntry`), load/save a full RAPID program
  (`loadProgram` / `saveProgram`), acknowledge a pending operation-mode switch
  (`acknowledgeOperationMode`), and dump the event log to file (`saveEventLogRaw`).
  First batch of a coverage pass driven by a full audit of the client against the
  documented RWS surface on both protocols.
- RWS 2.0 read additions, all live-verified on the VC: `getRestartCount`
  (controller restart counter), `getDipcQueueInfo` (queue depth, max message size,
  slot id), and `getRobTarget` (Cartesian pose relative to a chosen tool and work
  object, complementing `getCartesianFull`).
- RWS 2.0 parity with the RWS 1.0 adapter, live-verified on the VC: `saveModule`
  (save a module's source to a controller volume; the controller always writes
  `{name}.modx` into the volume root, subdirectories are rejected), `listProgress`
  and `getProgress` (track asynchronous operations such as backups and event-log
  dumps).
- Motion niche reads, live-verified on the RW7.21 VC: `getMotionSupervision`,
  `getPathSupervision`, `getCollisionPredictionModel`, `getAxisPose`, and
  `checkMotionChangeCount`. On the RWS 1.0 side `getEventLogMessage` (the only
  one of these RW6.16 serves; supervision, UAS and lock-state reads are
  protocol-absent there).
- Niche read batch, all live-verified on the RW7.21 VC: `getOperationModeLockState`,
  `getEventLogMessage` and `getEventLogMessageBySeqnum` (single-message lookup),
  `getLoginInfo`, `checkGrantExists`, `listAllGrants`, `listCurrentUserGrants`
  (UAS reads; `/uas/users` and `/uas/roles` need the UAS administration grant),
  `getIoNetwork`, `getIoNetworkConfig`, `getIoDeviceInfo`, `getIoDeviceConfig`,
  and `listCfgTypeAttributes` (attribute schema of a configuration type).
- RWS 1.0 debugger and program parity, live-verified on the RW6.16 VC:
  `setProgramPointer` (pcp `?action=set-pp-routine`; the controller requires
  BOTH module and routine) and `loadProgram` (`?action=loadprog`, body
  `progpath`). Breakpoint endpoints turned out to be protocol-absent on RW6.16
  (`/program/breakpoints` is 404), so `listBreakpoints` returning empty there
  is controller behavior, not a client gap.
- IO and file additions, live-verified on the RW7.21 VC: `searchSignals`
  (server-side signal search; the name criterion is a substring match, filters
  compose as AND, and hits feed the same coordinate cache `writeSignal` uses),
  `getSignalConfig` (EIO_SIGNAL configuration of one signal), and `renameFile`
  (the wire field is `fs-newname`; the published spec's `new-filename` is
  rejected by the controller).
- Cross-protocol parity batch, live-verified on RW6.16, RW7.21 and RW8.1 VCs:
  `listServiceRoutines` (all three generations; the controller spells the field
  `routine-name` on RWS 1.0 and `routine_name` on RWS 2.0, both handled), and on
  the RWS 1.0 side `getModuleInfo`, `getTaskProgramInfo` (XML representation:
  the RW6.16 JSON template for this resource is broken and returns unrendered
  template source), `listFileVolumes`, `saveProgram`, `loadCfgFile`,
  `saveCfgFile`, `setActiveTool` and `setActiveWobj` (mechunit `?action=set`
  under motion mastership).

### Fixed

- **RAPID debugger endpoints were wrong (never live-verified); fixed on RW7.21.**
  `stepRapid` posted to /rw/rapid/tasks/{task}/step, which does not exist (404) -
  stepping is the execution START endpoint with a step `execmode`
  (stepin/stepover/stepout/...). `holdToRun` posted `action` to a non-existent
  task path - the real resource is /rw/rapid/execution/holdtorun with field
  `state`. `setBreakpoint` sent `begin-position-row/col`, which the controller
  rejects ("row parameter invalid or missing"); the form fields are
  `module`/`row`/`column`. All three now reach the correct resource (verified:
  stepRapid returns WRONG_MODE instead of 404 - these are manual-mode functions,
  so full happy-path exercise needs the pendant in MANR). `removeBreakpoint` is
  marked best-effort until it can be set-then-removed in manual mode.
- **File-target writes were broken on both protocols; all fixed by one discovery.**
  cfg saveas, elog saveraw and backup create/restore reject every bare volume
  path ('TEMP/x', '$TEMP/x', 'BACKUP/x') - the value must be a fileservice URI
  ('/fileservice/TEMP/x'). Found during live finishing tests on RW7.21 and
  confirmed on RW6.16; the client now normalizes automatically, so
  `saveCfgFile('SYS', 'TEMP/sys.cfg')` and `createBackup('name')` just work.
  Full round trips verified: cfg file created and read back on both protocols,
  elog dump created, backup created and validated with the new `checkRestore`.
- `resetRapid` and `startProductionEntry` (RWS 2.0) now acquire edit mastership
  internally like `setSpeedRatio` does - without it the controller answers
  MASTERSHIP_REQUIRED (live-verified). `stopRapid` stays unwrapped on purpose:
  a stop must never be blocked by mastership contention.
- The RWS 1.0 production-start action is `startprodentry`, not `start-prod`
  (which answers 400 "Invalid argument" on RW6.16 - the old form never worked).
  Verified with a full start/stop/reset cycle on the live VC.
- **RWS 2.0 DIPC was fully broken; now works end to end.** Verified against an
  OmniCore VC RW7.21 by round-tripping create, send, and read.
  - `createDipcQueue` sent `dipc-max-size` / `dipc-max-number-of-messages`, which
    the controller rejects (HTTP 400). The accepted fields are `dipc-queue-size`
    (max message count) and `dipc-max-msg-size` (max bytes per message).
  - `sendDipcMessage` omitted the required `dipc-userdef` field, so every send
    returned HTTP 400. It is now included.
  - `readDipcMessage` parsed the wrong element class (`dipc-message`), so it
    always returned null. The message arrives as `dipc-read`; the payload is now
    returned and the message is consumed on read as expected.

### Changed

- RWS 2.0 control and write endpoints (panel, RAPID execution, mastership, IO
  set, event log, CFG load/save, DIPC, backup) are now centralized in
  `ResourceMapper2`, mirroring the RWS 1.0 `ResourceMapper`. Behavior is
  unchanged for the endpoints that already worked; the map documents the wire
  forms the controller actually accepts (verified via OPTIONS), which differ
  from the published spec in a few places.
- Minimum supported Node.js is now 20 (was 18). Node 18 reached end-of-life in
  April 2025 and the build toolchain already requires Node 20.19+. CI runs on
  Node 20, 22, and 24.

## [1.1.0] - 2026-08-02

Structural-fixes round: the event stream self-heals on both protocol
generations, connection health is first-class state, and controller errors
carry the controller's own diagnosis. Everything below was driven by live
probing against the RW6.16 IRC5 VC and RW7.21 OmniCore VC through a chaos
proxy (drops, freezes, blocked ports, real warm restarts).

### Added

- **Connection quality as first-class state** - `RobotState.quality`
  (`live` / `polling` / `reconnecting` / `stale` / `disconnected`) with a
  human-readable `qualityReason`, driven by the manager's existing signals:
  subscriptions up, stream lost/restored, consecutive poll failures, connect
  lifecycle. `MultiRobotManager.onRobotChanged(id => ...)` reports which robot
  changed so fleet consumers stop diffing every state; the zero-arg
  `onDidChange` is untouched.
- **Controller-level error taxonomy** - new `RwsError` codes
  `MASTERSHIP_REQUIRED`, `GRANT_DENIED`, `WRONG_MODE`, `RESOURCE_NOT_FOUND`,
  plus `controllerCode`/`controllerMsg` parsed from the controller's own error
  body (RWS 1.0 `?json=1`, RWS 2.0 hal+json, and XHTML status blocks). 4xx
  responses are classified by body content, never by HTTP status alone, and
  messages say what to do (acquire mastership, request RMMP and approve on the
  FlexPendant, check the op-mode). Every mapping is backed by raw payloads
  captured from live controllers (`tests/fixtures/errors/`).
- **RWS 2.0 subscriber parity with RWS 1.0** - the OmniCore stream gained the
  pieces the IRC5 stream got in this round:
  - Half-open detection: a `PING` still unanswered at the next tick terminates
    the socket so recovery runs (any inbound frame counts as proof of life).
  - The WebSocket connects via the configured base URL instead of the
    authority the controller advertises, so subscriptions survive NAT and
    port forwarding.
  - Reconnect tuning (base/cap/attempts, ping interval, open timeout) is
    configurable per subscription; backoff is now capped.

- **RWS 1.0 subscriber parity with RWS 2.0** - the IRC5 event stream now
  survives everything the OmniCore stream survives:
  - Heartbeat: WebSocket protocol pings every 10 s; an unanswered ping marks
    the connection half-open and force-closes it so recovery runs (a frozen
    NAT or yanked cable is detected within about 2 ping intervals).
  - Reconnect with capped exponential backoff (1 s doubling to 30 s, 6
    attempts before giving up, about 61 s total by default) instead of the old
    three quick retries.
  - Dead-registration recovery: when the controller restarts, the stored poll
    URL is gone; the subscriber re-registers a fresh subscription on the same
    HTTP session (no session slot leaks) and resumes.
  - `subscribe()` accepts a new options argument (`WsSubscribeOptions`):
    `onLost` fires exactly once when the reconnect budget is exhausted,
    `onRestored` fires after every successful recovery so consumers can
    resync, plus tuning for backoff, heartbeat, and handshake timeout.
- `onRestored` on RWS 2.0 subscriptions too: `RwsClient2.subscribe()` takes an
  optional fourth callback invoked after each successful re-subscribe.
- `RobotManager` resyncs automatically: one immediate full poll whenever a
  subscription stream is restored; fast polling on terminal loss (as before).

### Changed

- **4xx classification changed on existing paths** (the point of the error
  taxonomy): a 403 that used to throw `AUTH_FAILED` now throws
  `MASTERSHIP_REQUIRED`, `GRANT_DENIED`, or `WRONG_MODE` depending on the
  controller's error body; a generic 404 now throws `RESOURCE_NOT_FOUND`
  (`MODULE_NOT_FOUND` stays for module paths). Code that matched on the old
  codes for these cases needs updating. Error messages keep the
  `HTTP <status> from <method> <path>` phrase for compatibility with
  message-matching consumers.
- `RobotState` gained two required fields (`quality`, `qualityReason`) -
  additive for readers, but code constructing complete `RobotState` literals
  must add them.

### Fixed

- A dropped RWS 1.0 WebSocket used to give up silently after ~7 s: no
  heartbeat, no terminal signal, and the adapter swallowed the loss callback.
  A controller reboot (minutes) therefore permanently killed IRC5 live events
  until manual reconnect.
- RWS 1.0 subscription cleanup never actually worked against live IRC5: the
  DELETE targeted the poll URL from the Location header, which the controller
  answers with 404 (the deletable resource is `/subscription/{id}`, same as
  RWS 2.0 - live-verified on RW 6.16). Unsubscribe also passed an absolute
  URL where `HttpSession` expects a path, so the request could not even be
  built. Registrations leaked for the life of the session; both are fixed.
- The subscription WebSocket now connects via the host and port the client
  was configured with instead of the authority the controller advertises in
  the Location header, so RWS 1.0 subscriptions work across NAT and port
  forwarding.
- Stray `console.*` calls in `RobotManager` and `RwsClient2` now go through
  `Logger`.
- **RWS 2.0 subscriptions could never recover from a controller restart**: the
  client adopted the session cookie only on the first response, so after a
  restart killed the session, the re-POST minted a fresh cookie the client
  ignored and every WebSocket upgrade was rejected 401 forever (live-observed
  on RW7.21 across a warm restart). Set-Cookie is now adopted from every
  response that carries one.
- `RwsClient2.restartController()` acquires `edit` mastership internally - the
  bare POST is refused with 403 (live-verified on RW7.21). If the restart POST
  itself is refused, the mastership is released again instead of leaking.
- The RWS 2.0 subscription POST and the upgrade-rejection path both settle on
  connection loss now (timeout on the POST; abort/error/close handling on the
  rejection response) - a connection cut mid-handshake used to hang the
  reconnect loop forever with no `onLost`.
- Consumer callbacks (event handlers, `onDidChange`) are guarded everywhere:
  a throwing consumer can no longer crash the process from inside the RWS 2.0
  message listener or be miscounted as a poll failure by `RobotManager`.

## [1.0.0] - 2026-07-09

The library is feature-complete for both controller generations and every wire
recipe below has been verified against live controllers (RW 6.16 IRC5 +
RW 7.21 OmniCore). Time to call it 1.0.

### Added

- **mDNS/Bonjour controller discovery** - `RobotManager.discoverControllersMdns()`
  finds every ABB controller (real or virtual) announcing on the local network:
  zero-dependency DNS-SD implementation, returns system name, host, RWS port,
  RobotWare version, system GUID, and a protocol classification. No more port
  scanning to find RobotStudio's randomly-assigned VC ports.
- **HAL JSON parsing for RWS 2.0** - GETs negotiate
  `application/hal+json;v=2.0` (officially supported; live-verified) with an
  automatic, remembered per-controller fallback to XHTML for older RobotWare 7
  releases. Byte-identical results across both representations verified live
  over seven read families.
- **Simulation panel (virtual controllers, RW7)** - `simEmergencyStop()`,
  `simResetEmergencyStop()`, `simGeneralStop()`, `simAutoStop()`,
  `simEnableSwitch(on)`, and `teleportMechunit(mechunit, joints)`. Drive the
  E-stop/guard-stop chain and reposition the simulated robot from the API -
  every recipe converged from live controller validation errors, including the
  undocumented inverted `state=off`-engages polarity.
- **`RWS1Adapter.saveModule` migrated off a dead endpoint** - the legacy
  `?action=savemod` form returns a blanket 400 on RW6 regardless of body; the
  method now uses the live-verified `?action=save` recipe (and percent-encodes
  the destination path).

### Changed

- Published packages now include `src/` so the shipped source maps resolve;
  the `exports` map lists `types` first for `nodenext` consumers.
- 169 new unit tests (368 total): every previously-untested `ResourceMapper`
  builder and `ResponseParser` parser, the RWS 1.0 digest/cookie/pacing
  request path, the mDNS wire parser, HAL/XHTML parity, and the simulation
  panel.

## [0.8.0] - 2026-07-09

### Fixed

- **RWS 2.0 real-time subscriptions actually work now.** The WebSocket handshake
  offered `robapi2_subscription` - the RWS **1.0** subprotocol name - and
  RobotWare 7 rejects it with HTTP 400, so every OmniCore connection silently
  fell back to polling since the feature shipped. The client now offers the
  official `rws_subscription` (RWS 2.0 manual 3HAC073675-001). Live-verified on
  RW 7.21: handshake 101, real event frames delivered.
- **RWS 2.0 WebSocket drops no longer kill live updates for the session** - the
  25 s ping interval is cleared on close, the client re-registers the
  subscription with bounded exponential backoff, and when it finally gives up
  it tells the owner (see `onLost` below) so `RobotManager` can restore fast
  polling instead of idling at the slow cadence forever.
- **`getModuleSource` works for modules with no backing file** (loaded from
  `.pgf`, RobotStudio, or the FlexPendant - [abb-rws-vscode#3](https://github.com/ichbinmeraj/abb-rws-vscode/issues/3)):
  both protocols now fall back to saving the module to the controller's TEMP
  volume, reading it, and deleting it. On RWS 1.0 the save round-trip is the
  primary path so a stale `$HOME` copy can never shadow program memory.
  Wire recipes live-verified on RW 6.16 + RW 7.21 (no mastership needed).
- **CFG writes were broken on both protocols**: `setCfgInstance` POSTed a
  non-existent RWS 2.0 path (missing `/instances/`) and sent plain values where
  RobotWare 7 requires the bracket representation (`Attr=[value,1]`);
  `createCfgInstance` used an endpoint that does not exist (`…/{i}/create`) -
  the real flow is `instances/create-default` + set. RWS 1.0 had no CFG write
  support at all; the adapter now implements set/create/remove with the
  plain-value forms. Full create → set → readback → delete cycles live-verified
  on both controllers.
- **`probeProtocol` no longer misdetects arbitrary web servers as RWS 2.0** -
  classification now requires a Digest (RWS 1.0) or Basic (RWS 2.0) challenge;
  Bearer challenges and plain 200 responses are rejected.
- **`createAdapter` gained the Default-User fallback** `createClient` already
  had - and the fallback predicate now keys on the typed `AUTH_FAILED` error
  code (the old message regex never matched RWS 1.0 login failures).
- **`connect()`/`disconnect()` races**: disconnecting during an in-flight
  connect no longer resurrects timers or subscriptions; a second `connect()`
  with different host/credentials supersedes the in-flight attempt instead of
  being silently coalesced; a poll that loses the race with `disconnect()` can
  no longer write stale task state back into a cleared manager.
- **`writeSignal` with unknown network/device** now throws a descriptive
  `RwsError` instead of firing a malformed `/signals///…` request.
- **Fileservice paths are percent-encoded per segment on both protocols** -
  file names containing space, `#`, or `%` no longer break (or truncate at the
  `#`) list/read/upload/delete/copy operations. `$HOME`/`$TEMP` prefixes stay
  literal.
- **`RWS1Adapter.listMechunits` returns the controller's real mechunit list**
  instead of a hardcoded `['ROB_1']`.
- **Session-cookie store writes are atomic** (temp file + rename), so
  concurrent connects can't drop each other's entries.
- **Digest `qop=auth-int`** is now rejected with a clear error instead of
  silently hashing as `auth` and failing authentication downstream.
- **Class-name minification safety**: protocol detection for config
  persistence uses `instanceof`, not `constructor.name`.

### Added

- **`RobotManagerOptions`** - `new RobotManager({ refreshIntervalMs, strictTls })`
  and `MultiRobotManager.fromConfigs(configs, options)`:
  - `refreshIntervalMs` (default 1000, min 200) controls the polling cadence;
    the subscription-active slow poll scales at 5×.
  - `strictTls` (default false) turns real TLS certificate verification on for
    controllers with proper certificates. Off by default because controllers
    ship self-signed certs.
- **`RwsClient2` constructor options** `{ timeout, rejectUnauthorized }` - the
  per-request timeout is finally configurable (was hardcoded 10 s), and callers
  can opt into certificate verification.
- **`onLost` subscription callback** on the adapter `subscribe` surface -
  invoked once when the event stream is terminally lost so callers can degrade
  gracefully.
- **CI workflow** (Node 18/20/22 matrix: build, tests, lint) and `SECURITY.md`.

## [0.7.3] - 2026-07-03

### Fixed

- **TLS bypass now applied per-request, not only on the HTTP agent** - fixes
  connections to real controllers from inside VS Code
  ([abb-rws-vscode#2](https://github.com/ichbinmeraj/abb-rws-vscode/issues/2)).
  VS Code's extension host patches Node's `http`/`https` modules and replaces
  custom agents for non-localhost targets, which silently dropped the
  agent-level `rejectUnauthorized: false` and re-enabled certificate
  verification - every real OmniCore (self-signed cert) then failed with
  `self signed certificate`. Localhost VCs were never affected because the
  extension host doesn't intercept localhost traffic. The setting is now also
  set on each request's options in `RwsClient2.req()`, the subscription POST,
  `RobotManager` port probing, and `detect.probeProtocol()`.
- **Examples 05 & 06 rewritten against the real API** - they previously used an
  options-object `RwsClient2` constructor and `RobotManager` methods that never
  existed. Both now use `new RobotManager()` + `connect(host, user, pass, port?)`.
- **`repository`/`homepage`** now point at the actual GitHub org (`ichbinmeraj`);
  the previous links 404'd from the npm package page.
- Stale `types.ts` header no longer claims the package is RWS 1.0-only.

### Added

- **`prepack` guard** - `npm pack`/`npm publish` now runs the build and the full
  116-test suite first, so a stale or broken artifact cannot be packed.

## [0.7.2] - 2026-05-08

### Documentation

- **Fixed the embarrassing compatibility table** that incorrectly claimed
  RobotWare 7.x / OmniCore was "Not compatible". The package has supported
  both protocols since v0.7.0 - the table was a stale leftover from when
  only RWS 1.0 shipped. Now correctly shows both ✅, with live-tested
  versions called out (RW7.21 + RW6.16).
- **Documented `RobotManager` higher-level surface** - the README's
  API-reference tables only covered the protocol-level `RwsClient`, so
  callers couldn't see what `RobotManager` adds on top: RMMP, mastership
  status, opmode auto-routing, backup, FK, service-routine call,
  tool/wobj activation, CFG write surface, DIPC messaging, file volumes,
  module source, compress, value validation. New section lists all of
  these with descriptions.
- **Clarified RWS 2.0 subscription quirks** - the polling-fallback
  paragraph now names the specific RWS 2.0 VC `robapi2_subscription`
  rejection that triggers the fallback, rather than implying it's
  always 5s polling.
- **Session-pool clarifications** - IRC5's 70-session number was being
  presented as universal; called out OmniCore's also-finite-but-different
  pool with the empirical 503-once-full behaviour we observed during
  protocol probes.
- **`RobotManager` polling cadence** correctly described as hybrid:
  5 s when WS subscriptions handle state changes, 1 s when polling
  covers everything.

No code changes - pure README updates. `RwsClient`, `RwsClient2`,
`RobotManager`, `MultiRobotManager`, `createClient`, all examples and
unit tests are bit-for-bit identical to v0.7.1.

## [0.7.1] - 2026-05-07

### Added

- **RMMP (Remote Mastership Privilege)** is now part of the public `RobotManager`
  surface - `getRmmpPrivilege()` and `requestRmmp(level)`. The `withMastership()`
  helper now also gates on RMMP, so any modify operation in AUTO mode will
  automatically request RMMP and surface an actionable error ("approve the
  popup on the FlexPendant") when the operator hasn't granted remote control
  yet. This matches RobotStudio Online's behaviour and removes the most common
  cause of mastership-acquired-but-403 failures.
- **Service-routine / arbitrary PROC call** - `callServiceRoutine(task, name,
  args?)` lets a remote client kick off a service routine (calibration, brake
  check, custom service procs) without going through the FlexPendant's
  Service Routine menu.
- **Tool / Work-object activation** - `setActiveTool(mechunit, name)` and
  `setActiveWobj(mechunit, name)` switch the active persistent tooldata /
  wobjdata mid-session.
- **Module metadata** - `getModuleInfo(task, module)` exposed publicly (was
  adapter-only). Returns path, attributes, type, line count.
- **Backup restore** - `restoreBackup(name)` exposed publicly (was adapter-only).
- **Backup status** type-narrowed - `getBackupStatus()` now returns the full
  `{ active; progress?; phase? }` shape on every code path (no more union
  with bare `{ active }`).
- **CFG write surface** exposed publicly with mastership wrapping -
  `setCfgInstance`, `createCfgInstance`, `removeCfgInstance`, `loadCfgFile`,
  `saveCfgFile`. Each acquires `'edit'` mastership for the duration of the
  call.
- **DIPC public API** - `listDipcQueues`, `createDipcQueue`, `sendDipcMessage`,
  `readDipcMessage`, `removeDipcQueue` exposed on `RobotManager`.
- **File volumes** - `listFileVolumes()` returns the controller's available
  volumes (HOME, BACKUP, DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP).
- **Compress** - `compressPath(source, destination)` for archiving controller
  files in-place.
- **Mastership status** - `getMastershipStatus(domain)` returns
  `{ mastership; uid?; application? }`. Useful for diagnosing 403s ("which
  client / FlexPendant is currently holding the lock?").

### Improved

- `getRobotType`, `getProgramPointer`, `getMotionPointer` now have explicit
  return-type annotations on the `RobotManager` wrappers - TypeScript no
  longer collapses the empty-default into a property-less union.

### No breaking changes

- All additions are new methods or default-no-op widening. Existing callers
  using `RobotManager` keep working without any changes.

## [0.7.0] - 2026-05-06

This release adds RWS 2.0 (OmniCore / RobotWare 7) support, multi-robot
management, auto-detection helpers, and a full set of higher-level building
blocks. The package now legitimately covers BOTH RWS protocols ABB ships,
including the long-tail endpoints (devices, all-IO-devices, mastership
extras, forward kinematics) that were missing from prior versions.

### Added

- **`RwsClient2`** - RWS 2.0 protocol client for OmniCore controllers.
  HTTP Basic auth, XHTML responses (`Accept: application/xhtml+xml;v=2.0`),
  path-based actions (`/rw/rapid/execution/stop`), `'edit'` mastership
  domain, `HOME` file-service prefix, self-signed-TLS tolerance for VCs,
  WebSocket subscriptions via `robapi2_subscription` subprotocol.

- **`IRWSAdapter`** - common interface implemented by both RWS 1.0 and 2.0
  adapters. ~140 methods covering panel, RAPID exec, modules, variables,
  motion, system, event log, I/O, file service, CFG database, mastership,
  backup, DIPC, vision, safety, virtual time, certs, registry, jog, IK/FK.

- **`RWS1Adapter`** / **`RWS2Adapter`** - wrappers that satisfy `IRWSAdapter`
  on top of `RwsClient` and `RwsClient2` respectively. Use these when you
  want a single typed handle that works across both protocols.

- **`RobotManager`** - high-level connection lifecycle: auto port discovery,
  protocol auto-detection, polling, WebSocket subscriptions with polling
  fallback, reconnect-on-failure, state events. `onError` listener lets the
  host (CLI / UI) decide how to surface failures.

- **`MultiRobotManager`** - orchestrates several `RobotManager` instances.
  Tracks an "active" robot for UIs that show one at a time, while polling
  state for all. `onError` cascades to every existing and future robot.

- **`createClient(opts)`** / **`createAdapter(opts)`** - auto-detect helpers
  that probe the WWW-Authenticate header and return the matching client
  (or `IRWSAdapter`) already connected. Probes common RWS ports if `port`
  is omitted (5466, 9403, 443, 80, 11811).

- **`probeProtocol(host, port, https)`** / **`probeHost(host)`** - lower-level
  protocol detection for callers that want explicit control.

- **Mastership extras** (RWS 2.0 + partial RWS 1.0):
  - `requestMastershipAll()` / `releaseMastershipAll()` - all-domains in one call
  - `requestMastershipWithId(domain)` / `releaseMastershipWithId(domain, id)` -
    token-based mastership that survives session loss; useful for clients
    that periodically reconnect (RWS 2.0 only)
  - `resetMastershipWatchdog()` - heartbeat for RobotWare 7.8+ during long
    RAPID runs
  - `getMastershipStatus(domain)` / `listMastershipDomains()` - read state

- **Devices** - both `/rw/devices` (system hardware/software inventory) and
  `/rw/iosystem/devices` (all configured I/O devices across networks):
  - `listSystemDevices()` - top-level groupings (HW_DEVICES, SW_RESOURCES)
  - `getDeviceTree(group)` - drill into a group
  - `listAllIoDevices()` - flat list of every I/O device with state

- **Forward Kinematics** - `calcCartesianFromJoints(joints, mechunit?, tool?, wobj?)`,
  the missing mirror of `calcJointsFromCartesian`. Same VC-license caveat as IK:
  virtual controllers without PC Interface 616-1 reject the call (clean error
  message; no NaN leakage).

- **`XhtmlParser`** - exported for advanced users parsing RWS 2.0 responses
  manually. Handles span / li / state extraction with regex.

- **`setLogger(impl)`** - pluggable logging interface. The lib ships with a
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
  in body, not URL query). Live-verified - RWS 1.0 fileservice returns
  HTTP 400 "Invalid/No Query Parameter" for the URL-query form.

- **`RwsClient` copyFile**: `fs-newname` now sends only the basename of the
  destination path. RWS 1.0 fileservice copy operates within the source's
  directory - passing a full path returns 400 "Invalid". Cross-directory
  copy must use read+upload.

- `package.json`: added `description`, `keywords`, `homepage`, `repository`,
  `engines.node`, `prepublishOnly` script. Removed invalid self-reference
  in `dependencies`. Added `@types/ws` to devDependencies.

### Compatibility

- **Node.js 18+** required (matches existing minimum).
- **No breaking changes for existing RWS 1.0 users.** `RwsClient` and its
  type exports are unchanged in behavior except for the bug fixes above.
- New names (`RwsClient2`, `RobotManager`, etc.) sit alongside the old API.

## [0.6.0] - 2026-04-30

- WebSocket subscriptions via `subscribe(resources, handler)`.
- Generic `request(method, path, body?)` escape hatch for RWS endpoints
  not covered by typed methods.
- ~57 typed RWS 1.0 methods.

## [0.5.0] and earlier

- Initial RWS 1.0 client: HTTP Digest auth, session cookie management,
  request rate limiting, automatic re-authentication, typed `RwsError`.
