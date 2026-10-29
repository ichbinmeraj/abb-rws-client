# Changelog

All notable changes to `abb-rws-client` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.2] - 2026-10-29

### Fixed

- **`RobotManager.loadProgram` refuses a local file that is not valid
  UTF-8.** Up to 1.5.1 it read the file as UTF-8 text, and Node turns every
  byte sequence that is not UTF-8 into U+FFFD without a word. A module saved
  as Windows-1252 or Latin-1 was uploaded with replacement characters where
  its accented letters had been. Now the bytes are decoded strictly. Such a
  file is refused with `INVALID_ARGUMENT` before anything is sent, the access
  request included. The message names the file, the line where the first bad
  byte sequence starts, and its first byte. Save the file as UTF-8 and load
  it again.
- **`loadProgram` refuses a file with no text** (empty, white space only, or
  a byte order mark only) the same way. It holds no module, and loading it
  would first unload the loaded module of the same name.
- A valid UTF-8 file is sent exactly as before, a byte order mark included.
  No error code and no signature changed.

### Documentation

- The README's RobotWare 8 motion-control section no longer says ABB's PC
  SDK lets a tool allow motion control automatically on virtual controllers
  only. ABB's PC SDK has an Automatic policy that turns it on before each
  action, and ABB allows that policy on virtual controllers only. On a real
  controller the tool has to turn it on itself, and ABB asks it to confirm
  both stops first. This client still never allows it on its own.
- The `motors-on` remedy row no longer reads as if `setMotorsOn` worked on
  RobotWare 6 and 7 only. The remedy offers that call on RobotWare 6 and 7.
  On an 8.2.1 virtual controller in Auto, `setMotorsOn` after `setMotorsOff`
  was accepted (204), and in guard stop it was refused (403 -1073445806).
  The functional-suite notes no longer say RobotWare 8 motors come on only
  at the FlexPendant.
- A line on ABB's OmniCore App SDK, the library for apps that run on the
  OmniCore FlexPendant. This client is for code on a PC or a server.
- The trademark and disclaimer lines in the README, `TRADEMARKS.md` and
  `NOTICE` name ABB Asea Brown Boveri Ltd. as the owner of the ABB mark and
  the product names as trademarks of their respective owners. The project is
  not affiliated with, endorsed by, sponsored by or supported by ABB, ABB
  Robotics or any later owner of these products. In `TRADEMARKS.md` the list
  of what this project will not do and the promise to rename on request cover
  all of them, and the clean-room line names RobotStudio virtual controllers
  as the controllers observed.

### Removed

- **`VALIDATION.md`** (not part of the npm package). Its manual scenarios
  covered RWS 1.0 only, and several no longer matched the client. The live
  checks are described under Functional tests in the README.

## [1.5.1] - 2026-10-25

1.4.0 and 1.5.0 were prepared but not published; their changes ship in
this release, under "Prepared as 1.5.0 (not published)" and "Prepared as
1.4.0 (not published)" below, so this section lists everything since
1.3.1. Entries that compare with 1.4.0 or 1.5.0 compare with those
prepared versions.

### Added

- **`RefusalHolder.isPendant`**: true when the holder of the access is the
  FlexPendant, in the two forms the controllers were seen to name it:
  RobotWare 7 reports the pendant's mastership as kind `local` with
  application `TPU` (RW 7.21.4), RobotWare 8 its write access as held by the
  station `FlexPendant` (kind `unknown`, RW 8.2.1; both 2026-10-18). Set on
  every holder the client reports that is the pendant (`refusal.holder`, the
  status-read holders), left out for any other, a `remote` holder with
  application `TPU` and a station named `TPU` included; no other field
  changes. RAPID Live, the daemon and the panel use the same rule. A RobotWare
  6 pendant holder has not been observed, so a `local` holder without
  application `TPU` is not marked. The same rule now picks the next step of a
  mastership refusal: a `remote` holder with application `TPU` gets "the
  holder releases it", not the FlexPendant's release (since 1.5.0); a `local`
  holder still gets the FlexPendant's.
- **A warning when https goes out without the certificate check.** The check
  stays off by default (the virtual controllers and, by ABB default,
  OmniCore controllers present a self-signed certificate). Now the RWS 2.0
  client logs one line at warn level, once per process for each host and
  port, before the first request, subscription POST or WebSocket it sends
  unchecked: the connections that carry the credentials and the session
  cookie. The line names `strictTls: true` (`rejectUnauthorized: true` on
  `RwsClient2`), how to make the controller's certificate or its CA trusted
  (`NODE_EXTRA_CA_CERTS`, or this PC's certificate store on Node 22.15 and
  later), and that the
  client has no option that pins one certificate per controller. Nothing is
  logged for this PC's loopback (127.0.0.0/8, `::1`, `localhost`), where the
  client reaches the virtual controllers and the connection does not leave
  the PC, nor for the unauthenticated probes of discovery and connect. RWS
  1.0 over https always checks, against Node's own default set (the client
  does not add the operating system's store there). The README's new "TLS
  certificates" section says how to turn the check on, what it trusts and
  how to give it a
  controller's own self-signed certificate (checked with a test certificate
  for 127.0.0.1; not tried against a controller); `pinnedFingerprints`
  applies to discovery's own logins only.

### Changed

- **RWS 2.0 sends the Basic credentials only until it holds a session
  cookie.** Until now every request carried them beside the cookie, the
  subscription POST too. Now a request carries the cookie alone once the
  controller has issued one; the WebSocket upgrade already did. When the
  controller answers 401 to the cookie (the session is gone: an idle expiry
  after about 5 minutes, a restart, a logout; RW 7.21.4 and 8.2.1 answer 401
  "Login required" then, 2026-09-29), the client logs in once with a short
  request of its own (`GET /rw/system` with the credentials and without the
  cookie, as `connect()` does) and then sends the request once more with the
  new cookie, a write too (the 401 means it was not taken). The new cookie
  replaces the old one, which forgets the old session's registration and
  holds as before. A 401 to the login is `AUTH_FAILED`, and later calls send
  the credentials alone, one request each. Requests in flight at the expiry,
  and requests and subscribes started during the login, wait for that one
  login and then go out paced, 100 ms apart. A request the controller holds
  open (a DIPC read waiting for a message) is never the login, so nothing
  waits for its answer. A cookie set on a 401 is not kept. `/logout`
  answered 401 is not sent again, and a `disconnect()` during the login logs
  out the new session. On RobotWare 8 a write-access request that is itself the
  first request after the session ended still lands on the new, unregistered
  session and is refused once (-1073435871), as before; the next one
  registers again.
- **Under `strictTls` (RWS 2.0: `rejectUnauthorized: true`) every
  connection checks a controller's certificate against one set of
  authorities**: Node's default ones (with `NODE_EXTRA_CA_CERTS`) and the
  operating system's certificate store (`tls.getCACertificates`, Node 22.15
  and later). That is the discovery probe, the protocol probe, RWS 2.0
  requests, the subscription POST and its WebSocket. Inside VS Code the
  probe's own TLS connection got Node's default authorities only, while the
  client's requests also got the system store from the extension host, so a
  controller whose certificate a company CA signed was listed as unverified
  and then connected. Outside VS Code the requests now trust the system store
  too. On an older Node, or when Node cannot read its sets, each connection
  keeps Node's default, as before.
- **`RobotManager` walks the signal table by the clock, not every fifth
  poll.** Each walk of `state.ioSignals` is one request per page of signals
  (about 30 on an IRC5 with 3000 signals), and the poll waits for it. It was
  walked on the first poll, every fifth poll and every poll until a load
  succeeded, so every 5 to 25 s at the default cadence. Now it is walked at
  the first poll of a connection, then at the first poll 60 s after the
  last walk that landed (counted from the walk's end). A failed walk is
  tried again after 5 s, 10 s, 20 s, 40 s, then each minute, never on every
  poll; the log line says when. `refreshIoSignals()` still walks at once,
  and starts the minute again. A clock set back does not hold the next walk
  off, and when the poll's walk and a `refreshIoSignals()` overlap, a walk
  that started earlier than the one whose table is shown changes neither the
  table nor the schedule, and a failure while the other landed starts no
  backoff. A value in `state.ioSignals` can therefore be a minute old: read
  the signal (`readIoSignal`), or add it to the manager's subscription group
  and take its events from `onSubscriptionEvent`, for a live one.
  Subscriptions and the rest of the poll are unchanged.

### Fixed

- **`RobotManager` subscribes again after a failed subscribe at connect, and
  after a lost stream.** The subscribe was tried once per connection, as in
  1.3.1: when it failed, the manager fast-polled for the whole connection and
  no events came, and a stream the adapter gave up ended the same way. An RW
  6.16.03 virtual controller connected together with two others did not
  answer `POST /subscription` within the 5 s timeout in three rounds out of
  three (2026-10-25), while a lone connect subscribed. The data stayed
  correct; the cost was controller load and no pushed events. Now, while
  connected without a stream, the subscribe is tried again after 5 s, 10 s,
  20 s, 40 s, then each minute, at the end of a poll that succeeded, one
  attempt at a time, timed by the clock (a clock set back does not hold it
  off), from 5 s again on each connection; after three creates in a row that
  got no answer in time, the tries are 10 minutes apart until one is
  answered. A retry that lands ends as a subscribe at connect does: quality
  `live` with the reason "WebSocket events streaming after a retry", the slow
  poll rate, and one immediate poll to resync (`polling` and the fast rate
  while the controller leaves a status resource out of the group). One that
  lands after a disconnect or a reconnect unsubscribes the group it got and
  changes nothing. An adapter that answers `UNSUPPORTED_OPERATION`, or has no
  `subscribe`, is not tried again; the RWS 1.0 subscriber answers that, before
  it sends anything, when the `ws` package cannot be loaded (until now a
  `NETWORK_ERROR` after the group create). Each failed retry is logged once at
  info. On RWS 1.0 the group create (`POST /subscription`) now waits 10 s for
  its answer (the session's timeout plus 5 s) and no other request does: on
  RW 6.16.03 it is the slowest request a connection sends (0.8 s at the
  median, against 18 ms for the rest), and a create the client gives up on
  may still leave a group on the controller (seen on RW 7.21.4 over RWS 2.0,
  listed for 25-35 s; not probed on RWS 1.0). The cost: RWS 1.0 requests go
  one at a time per session, so a create that is never answered holds the
  requests behind it, a write or the disconnect's `/logout` among them, for
  up to 10 s, and the retries can repeat that, at most three times in a row
  before they are 10 minutes apart.
- **RWS 1.0: a WebSocket the controller closes is reconnected.** A close the
  controller starts reads as clean in the `ws` package, which answers the
  close frame, and a clean close neither reconnected nor fired `onLost`: the
  events stopped while `RobotManager` stayed `live` at the slow poll rate.
  Every close the client did not ask for now goes through the reconnect, and
  `onLost` once its attempts are used up, as on RWS 2.0.
- **RWS 2.0: no subscription create once `disconnect()` has begun.** The
  create is sent outside the client's request queue, and the re-create of a
  group that left a panel resource out did not check whether the client was
  closing: a first answer that came after the teardown sent the re-create
  with the credentials (no cookie is held by then), which started a session,
  with a group, that nothing logged out. It is now refused as
  `NOT_CONNECTED`, as every other request is.
- **RWS 1.0: the cookies a 401 sets are no longer kept as the session's.**
  Since 1.5.0 the cookies of every answer were kept, a 401's too, so on a
  controller that sets a new `-http-session-` on every 401 each rejected call
  after the first cost a third request (the fresh-session attempt) and
  reported a replaced session that never existed. Now a 401's cookies go out
  only with the same request's digest answer, become the session's when an
  answer to it is not a 401, and are dropped with its `AUTH_FAILED`. The
  cookies of every other error answer are still kept (the subscription
  recovery after dropped connections, 2026-10-22, needs those of a 400 and a
  503), and a dead saved cookie still gets one fresh-session attempt. RW
  6.16.03 sets no cookie on a 401.
- **Wording**: README and comments say that withdrawing motion control only
  removes the permission and is not a stop; `stopRapid` and `setMotorsOff`
  are described as sent first, without the "safe direction" label.
- **A configuration file refused with -1073437686 (SYS_CTRL_E_CFG_VERSION)
  is now `INVALID_ARGUMENT` with a refusal of kind `invalid-argument`**
  (it was `UNKNOWN`). The RobotWare 6.16.03, 7.21.4 and 8.2.1 virtual
  controllers answered it, 400, to a validation of a file whose first line is
  not a version header (2026-10-24; 7.21.4 and 8.2.1 also on 2026-10-01;
  "Wrong layout of version string" on RWS 2.0). The refusal says the file's
  version header is malformed, with ABB's description ("Invalid cfg domain
  version or invalid layout of version string."), and its remedy is to fix
  the file and run the validation or load again, as for -1073437689 and
  -1073437688, naming a header those controllers took
  (`EIO:CFG_1.0:6:1::` on RobotWare 6, `EIO:CFG_1.0:7:0::` on 7.21.4 and
  8.2.1). Outside a file load or validation it is the configuration data
  that is refused.

### Prepared as 1.5.0 (not published)

#### Added

- **`RobotManager.getProgress(id)`** and the optional
  **`IRWSAdapter.getProgress`**: one controller job by its progress id,
  `GET /progress/{id}`. `RwsClient2` and `RWS1Adapter` already had it.
  `NOT_CONNECTED` without a session; `UNSUPPORTED_OPERATION` when the
  adapter has no progress read.
- **`startJob(name, source, destination)`**: starts a compress or a
  decompress (`'compressPath'` or `'decompressPath'`, the same request as
  that method) and returns the job's progress id, on both generations
  (`RwsClient2`, `RWS1Adapter`, the optional `IRWSAdapter.startJob`) and
  through `RobotManager`. The controller answers 202 and runs the job after
  that; ABB's answer carries `Location: /progress/{id}` (RWS 1.0 Rev M,
  RWS 2.0 Rev L), which the client dropped, so a caller could not wait for
  the archive. The result is the id, or `undefined` when the answer has no
  such header. To wait, poll `getProgress(id)` until `state` is no longer
  `pending` (ABB's finished state is `ready`); `details.code` is then the
  controller's return code, negative when the job failed. `compressPath`
  and `decompressPath` still return nothing, as in 1.4.0. A name that is not
  one of the jobs is `INVALID_ARGUMENT`, nothing sent; the names are
  exported as `CONTROLLER_JOB_NAMES` and the type `ControllerJobName`.
  `RobotManager.startJob` with an adapter of another make that has no
  `startJob` starts the job with its `compressPath` or `decompressPath` and
  answers `undefined`; `NOT_CONNECTED` without a session, also once
  `disconnect()` began. An RWS 2.0 virtual controller answered a raw
  compress 202 with `Location: /progress/1` (2026-10-06), and the client's
  compress ran on RW 6.16.03 (202); `startJob` itself has not run yet.
- **`RwsClient.request` returns the answer headers** as `headers`, next to
  `status` and `body`.
- **`getCompatibility(robotWareVersion?)` on RWS 2.0** (`RwsClient2`), the
  optional **`IRWSAdapter.getCompatibility`** and
  **`RobotManager.getCompatibility`**, with the result type
  `RobotWareCompatibility`. See Changed and Fixed for what the method does.
  `RobotManager` throws `NOT_CONNECTED` without a session and
  `UNSUPPORTED_OPERATION` when the adapter has no such read. The
  `IRWSAdapter` member also takes the result 1.4.0's RWS 1.0 adapter had,
  `{ compatible, details? }`, so an adapter of another make written against
  1.4.0 with that method still compiles; `RobotManager` then fills
  `details` (`{}` without them) and `status` (`details.status`, or `'true'`
  or `'false'` from `compatible`).
- **Refusals carry a next step** (`refusal.remedy`, `refusal.otherRemedies`):
  what to do, who does it (`byWhom`: a person who confirms in a tool, the
  person at this tool, a person at the FlexPendant, the current holder, a UAS
  administrator, the integrator, or nobody from a remote tool), how far it
  reaches, and, for a step a tool can take after a person confirms, the call
  (`setAllowMotionControl(true)`, `requestRmmp(level)`, `stopRapid()` or
  `setMotorsOn()`). The client never takes it. Every refusal the client
  builds carries one, the controller's answers and its own pre-flight
  checks alike. `safetyDeclaration` marks the one step that is a person's
  safety confirmation, allowing RobotWare 8 motion control. New types
  `RefusalRemedy`, `RemedyActor`, `RemedyKind`, `RemedyCall`. Both fields are
  optional in the type. Built and tested offline; not yet run against a
  controller.
- **`confirmationFor(remedy, target)`** and the type `RemedyConfirmation`:
  the text a tool shows a person before it makes a remedy's call (title,
  lines, button, and whether the person types the robot's name), so every
  tool asks the same. For allowing motion control it says the person
  confirms that an emergency stop and a normal stop are within reach for
  every robot and axis the controller moves, and what a normal stop is.
  Null for a remedy without a call. The client never calls it.
- **`RobotManager.getAllowMotionControl()`**: reads whether RobotWare 8
  motion control is allowed for this control station and updates the state;
  on a session that is not registered yet it sends nothing and returns null.
  `NOT_CONNECTED` without a session, also once `disconnect()` began;
  `UNSUPPORTED_OPERATION` on RobotWare 6 and 7, before sending.
- **`RobotManager.getLocalStationStatus()`** and the type
  **`LocalStationStatus`**: whether the FlexPendant reads as connected, from
  ABB's two RobotWare 8 reads (`/rw/controlstation/local/isconnected` and
  `/rw/controlstation/tpu/safety/protocol/status`); each is null when its read
  fails or its answer has no such field. A read for a confirmation text; it
  decides nothing. `NOT_CONNECTED` without a session, also once
  `disconnect()` began. Not yet run.
- **`MultiRobotManager.disconnectAll()`**: disconnects every robot at once,
  so every RobotWare 8 withdrawal goes out before any slow step of any
  robot's teardown. Never rejects; the robots stay configured.
- **The `motionControl` access event** (`onAccessEvent`): RobotWare 8 motion
  control allowed, withdrawn or not known, with `allowed` and a `cause` of
  the new type `MotionControlCause` (`set`, `read`, `session-reissued`,
  `withdrawn-at-disconnect`, `withdrawn-after-reissue`,
  `withdrawn-at-registration`, `withdrawn-on-mode-change`,
  `withdrawn-on-take-back`, `withdraw-failed`). `lock` is always
  `writeaccess`.
- **`RobotState.access.rw8.allowMotionControlSince`**: the time of this
  client's set that made motion control allowed, while it reads true.
- **`RobotManager.read(name, ...args)`**: one generic read path to the
  adapter's reads that had no manager method, so a tool that reaches the
  client through `RobotManager` or `MultiRobotManager.active` can call them:
  `getEventLogMessage`, `getEventLogMessageBySeqnum` (RWS 2.0),
  `listEventLogDomains`, the RobotWare 8 control-station reads
  `getControlStationType`, `getControlStationId`,
  `isLocalControlStationConnected`, `getTpuSafetyProtocolStatus` and
  `getWriteAccessAppealChangeCount`, `listCurrentUserGrants`,
  `checkGrantExists` (RWS 2.0) and `describeReturnCode` (a return code with
  its severity). Each runs the adapter's own method on the manager's session,
  as it ran on the adapter, and passes its answer and errors through. New
  exports: the type `AdapterReads` (each read's arguments, answer and
  generation), `AdapterReadName`, `EventLogDomain` and the list
  `ADAPTER_READ_NAMES`. A name that is not one of these reads is
  `INVALID_ARGUMENT`; a read the adapter does not have is
  `UNSUPPORTED_OPERATION`; nothing is sent for either. `NOT_CONNECTED`
  without a session, also once `disconnect()` began.
- **`RobotManager.appealWriteAccessRelease()`**: RobotWare 8, asks the
  station that holds write access to release it (ABB's
  `POST /rw/controlstation/writeaccess/release/appeal`, no body); a write, so
  a method of its own rather than one of `read`'s. ABB lists "Registered as a
  Control station" as the appeal's prerequisite (Control Station Service
  Rev C), so the session registers first when it is not yet, as for
  `setAllowMotionControl`, and takes no write access; a -1073435871 answer
  registers once and appeals once more. `RwsClient2.appealWriteAccessRelease`
  does the same now: it sent the appeal unregistered, so a session that had
  only read would be refused, and the refusal's next step, run it again, sent
  the same request. `UNSUPPORTED_OPERATION` on RWS 1.0; RobotWare 7 answers
  404. The appeal ran on RW 8.2.1 from a registered session; one from a
  session that had not registered yet has not run.
- **Two subscription kinds and the type `AnySubscriptionResource`**:
  `SubscriptionResource` plus the kinds added in this release, kept out of
  `SubscriptionResource` so that an `IRWSAdapter` of another make written
  against 1.4.0, whose `subscribe` handles every `SubscriptionResource`,
  still compiles. `RwsClient.subscribe`, `RWS1Adapter.subscribe` and
  `RwsClient2.subscribe` take them, and so do `updateSubscriptionGroup` and
  `unsubscribeResource` on the clients and on `RobotManager`; an adapter of
  another make may refuse them there. Live on RW 6.16.03 and 7.21.4, added
  to `RobotManager`'s group: a RAPID mastership request and release sent
  its two events, the motion error state its initial value. On RWS 1.0 add
  them to the group the session has: ABB allows one WebSocket per session,
  and a second `subscribe()` beside `RobotManager`'s stream failed before
  it opened on RW 6.16.03 (the error now says so).
  - `{ type: 'mastership', domain? }`: mastership changes, ABB's RWS 1.0
    "Mastership Domain Subscribe" (`/rw/mastership/{cfg|motion|rapid}`,
    Rev M); on RWS 2.0 `/rw/mastership/{domain}` with RobotWare 7's names,
    `rapid` and `cfg` sent as `edit` (Rev L). Without a domain, every
    domain: each domain's resource (RWS 1.0 cfg, motion and rapid; RWS 2.0
    edit and motion), and `unsubscribeResource` drops each. ABB's RWS 1.0
    "Mastership Subscribe" form `/rw/mastership` was refused by RW 6.16.03
    (400 -1073445866), and RW 7.21.4 bound it on RWS 2.0, where Rev L lists
    no such form, in a group update it never answered, after which the group
    refused every edit until logout. A domain other than cfg, motion or rapid
    is `INVALID_ARGUMENT` before sending. ABB's event entry
    (`msh-resource-value`) carries no link on either generation, so both
    subscribers now take such an entry's resource from its title,
    `/rw/mastership/{domain}`; the value is its first field,
    `holdmastership`. A tool that polled `getMastershipStatus` can listen
    instead.
  - `{ type: 'motionerrorstate' }`: the motion system's error state,
    `/rw/motionsystem/errorstate;erroreventchange` on both generations (Rev M
    "Subscribe on Error EventChange", Rev L Motion System); the value is the
    error state. A raw create of it answered 201 on RobotWare 6.16.03 and 8
    virtual controllers. A tool that polled `getMotionErrorState` can listen
    instead.
- **`RWS1Adapter.unsubscribeResource(groupPath, resource)`**: drops one
  resource from a live RWS 1.0 subscription group, ABB's RWS 1.0 "Unsubscribe
  or remove the resource from subscription group", `DELETE
  /subscription/{group}/{resource}` (Rev M; the resource as it was
  subscribed, `;suffix` included, as on RWS 2.0). `RobotManager.unsubscribeResource`
  now reaches it on RobotWare 6, where it was `UNSUPPORTED_OPERATION`. The
  RWS 1.0 subscribe handle carries no group path: take it from
  `listSubscriptionGroups()`. A group path that is not `/subscription/{id}`,
  a bad signal name, or a resource path that would leave the group is
  `INVALID_ARGUMENT` before sending. The resource-path check is now one
  helper on both generations. Live on RW 6.16.03: 200, and the dropped
  resource sent no more events.
- **`getExecutionErrorState()`** (RobotWare 8.2 and later): whether the
  most recent RAPID execution stop was caused by an error, the flag ABB
  documents on the RWS site's RobotWare 8 view ("Get RAPID Execution Error
  State", `GET /rw/rapid/execution/execerrorstate`, since 8.2.0; not in
  Rev L); it goes back to false when the program restarts. On `RwsClient2`
  and through `RobotManager.read('getExecutionErrorState')`. Sent on any
  RWS 2.0 controller: RW 7.21.4 answered a raw GET 404, which is passed on
  as the controller's typed error. RWS 1.0 has no such resource
  (`UNSUPPORTED_OPERATION` from the manager, nothing sent). A value other
  than TRUE or FALSE is `PARSE_ERROR`. Live on RW 8.2.1 (false); RW 7.21.4
  answered the client's request the typed 404.
- **`getBuildErrors(task)`** and the type **`RapidBuildError`**: why a
  program load or link failed. ABB's "Get Build Errors" on both generations,
  `GET /rw/rapid/tasks/{task}/program/builderror` (RWS 1.0 Rev M, RWS 2.0
  Rev L): one entry per error with the module, row, column, the error text
  and, when the answer carries them, the error number (ABB's `error-num`)
  and the kind of error (`typeOfError`, the controllers' `type_of_error`,
  `SYNTAX` or `SEMANTIC`); the text is trimmed (the controllers end it with
  a tab).
  ABB serves at most 30 errors a page; the client follows the `next` link
  and reads every page. `[]` when the program builds. On `RwsClient2` and
  `RWS1Adapter`, read as XHTML on both (the form of ABB's examples: RW
  7.21.4 and 8.2.1 write the error text unescaped into their hal+json, which
  is then not JSON), and through `RobotManager.read('getBuildErrors', task)`.
  An answer whose entries are not ABB's, or an error with no readable row or
  column, is `PARSE_ERROR`. Live on RW 6.16.03, 7.21.4 and 8.2.1 with a
  module that did not build (an undeclared name) and one with a syntax error.
- **`unloadProgram(task)`**, the counterpart of `loadProgram`, on both
  generations: ABB's RWS 2.0 `POST /rw/rapid/tasks/{task}/program/unload`
  (Rev L) and RWS 1.0 `POST /rw/rapid/tasks/{task}/program?action=unloadprog`
  (Rev M), no body on either. On `RwsClient2`, `RWS1Adapter`, the optional
  `IRWSAdapter.unloadProgram`, and `RobotManager.unloadProgram(task,
  { stopIfRunning? })`. It is held like a program load (RobotWare 6: RAPID
  mastership; 7: edit; 8: write access). The manager reads the execution
  state first and stops a running program only when asked, as
  `unloadModule` does, and reads the task's modules again afterwards.
  `UNSUPPORTED_OPERATION` from the manager when the adapter has no such
  write. It takes out every program module of the task and leaves the
  system modules: on RW 6.16.03 the controller's own `Module1` went too.
  Live on RW 6.16.03, 7.21.4 and 8.2.1 (204). `IRWSAdapterCore` now picks
  it.

#### Changed

- **`getRobotType()` lists every robot of a MultiMove system** in a new
  field, `types`, in the controller's order, on both generations and
  through `RobotManager`. ABB's "Get robot type" answers one `sys-robottype`
  entry per robot (RWS 1.0 Rev M, RWS 2.0 Rev L; both examples list two),
  and the client kept only the first. `type` is still the first robot's.
  In `IRWSAdapter` and on `RobotManager`, `types` is optional, so an adapter
  of another make written against 1.4.0 still compiles; this package's
  adapters always fill it. The single-robot RW 6.16.03, 7.21.4 and 8.2.1
  virtual controllers answered one type each; the list has not yet been
  read from a controller with two robots.
- **The RWS 1.0 event log reads past its newest 50 messages.**
  `RwsClient.getEventLog(domain, lang, maxPages?)` and
  `RWS1Adapter.getEventLog` follow the listing's `next` link page by page,
  as the controller advertises it (RW 6.16.03 lists 50 messages a page,
  newest first, and its `next` link, `start=2`, served the older ones), up
  to `maxPages` pages, 20 by default (about 1000 messages), as on RWS 2.0.
  They read the first page only up to 1.4.x, so a RobotWare 6 controller
  had no history beyond 50 messages; `RobotManager.getEventLog` now returns
  the whole log there too. A message listed on two pages is kept once; a
  later page that fails ends the walk with the messages read (logged).
  Live on RW 6.16.03: one call read 312 messages over seven pages (one page
  answered 50).
  `maxPages: 1` reads the newest page only, as before. `RobotManager`'s own
  reads still keep the newest page in `state.eventLog` on RWS 1.0. RW
  6.16.03's XHTML listing, the form the client reads, carried the `next` link
  and a `last` link at `start=20` (2026-10-09). So one `getEventLog` call,
  `RobotManager.getEventLog` included, now sends one request per page on
  RobotWare 6, up to 20 for a full log, where 1.4.x sent one, as on RWS 2.0
  already. A tool that polls it and paced one request per read on
  RobotWare 6 counts one request per 50 messages instead, or reads through
  `RwsClient` or `RWS1Adapter` with `maxPages: 1`.
- **`getCompatibility` sends ABB's request on both generations and takes
  an optional RobotWare version.** The RWS 1.0 method used to send
  `GET /ctrl/compatible`, a path in no ABB page, and took no version. It
  now sends ABB's `GET /ctrl/compatibility/{robotware version}` (RWS 1.0
  Rev M, RWS 2.0 Rev L) for the version given, for example `'7.16'` or
  `'6.03.0101'`. Called without one, as in 1.4.0, it asks about the version
  the controller runs: the `rwversion` of `GET /rw/system` (for example
  `6.16.3007` or `8.2.1+1023`), sent as the controller wrote it; RWS 2.0
  uses the one `connect()` read. The result keeps the two fields 1.4.0
  returned, `compatible` and `details` (now always present), and adds
  `status`, from the `ctrl-compatibility` entry: `compatible` is true when
  the controller's `status` is true and false when it is false. A status
  other than true or false is `PARSE_ERROR`; an empty version is
  `INVALID_ARGUMENT` before sending. What changed for errors is under
  Fixed. ABB lists the request for real controllers only, and the virtual
  controllers answer 404, so it has not run yet; whether a real controller
  takes the RobotWare 7 and 8 form with its `+build` suffix is not known.
- **`registerUser` names ABB's two `locale` values when the controller
  refuses another one.** ABB marks `ulocale` required, with the values
  `local` and `remote`, on both generations (RWS 1.0 Rev M "Register the
  user", RWS 2.0 Rev L `/users/register`, whose schema types it a plain
  string). A given `locale` string is still sent as `ulocale` as it is, as
  in 1.4.0, and the controller decides. When it answers 400 to a value other
  than those two, the error's message starts with what was sent and ABB's
  two values, and a refusal it carries gets correcting the input as its next
  step; the code, the HTTP status and the controller's answer are kept. A
  `locale` that is not a string (a type error) is now `INVALID_ARGUMENT`
  before sending. `UserRegistration.locale` stays optional and typed
  `string`; without it the request carries no `ulocale`, as in 1.4.0. A
  remote tool passes `locale: 'remote'`; ABB accepts `local` only from the
  service port or the FlexPendant port. RW 7.21.4 and 8.2.1 answered
  `remote` 201 and refused a registration without a locale (see Fixed).
- **`saveSystemInfo(path, fileType?)` takes `fileType` as optional**, on
  RWS 2.0 and through `RobotManager`. ABB marks `file-type` optional
  (default every type); the client sends it only when it is given and not
  empty. It still returns nothing, as in 1.4.0: ABB's 200 answer lists the
  copied files, and a caller lists the `path` directory to see them. Not yet
  run: the virtual controllers refuse the request.
- **`listAliasIO` entries carry the signal `type`** (DI, DO, AI, AO, GI or
  GO) when the controller sends it.
- **`disconnect()` withdraws a RobotWare 8 motion-control allowance as its
  first request**, registering first when needed, before the jog release,
  RMMP, the subscription, the write-access release and `/logout`; on
  `RobotManager` and on `RwsClient2` used alone. It is sent only when this
  client may have one standing: from the moment it sent a true until a false
  sent as the same control station was taken, or a registered session of
  that station read false. A true that got no answer counts until a false is
  taken, whatever a read says, because the controller may take it after the
  read. The withdrawal takes no write access and gives up after 3 s. A
  refused withdrawal is logged and the disconnect goes on. A withdrawal
  already on its way when the disconnect starts (after a re-issued session,
  say) goes out before `/logout`, and a true sent while the disconnect's own
  withdrawal was on the wire is withdrawn again before `/logout`. The next
  registration of the same station, and a re-issued session, withdraw one
  that may remain, then read it; nothing is allowed again. A client
  registered again as another station (`registerControlStationRemote` with
  another id) cannot withdraw the first station's allowance: it logs a
  warning and sends nothing for it, and registering as the first station
  again withdraws it. Withdrawals on an operating-mode change and on the
  FlexPendant taking write access are built and off in this release, until
  a run on a controller shows what a withdrawal does to a running program.
  On RW 8.2.1 the disconnect's withdrawal went out first (204), before the
  subscription delete and `/logout`.
- **A RobotWare 8 registration that finds motion control allowed withdraws it
  when this client made no allowance in this run.** The allowance belongs to
  the control station: on RW 8.2.1 a process killed after allowing left it
  standing for its station, and a new session registered with the same id
  read it allowed 7 min 42 s later (2026-10-21). With a fixed
  `controlStation` a tool that restarts after a crash would have found
  motion control allowed that no person confirmed in that run. Now the read
  after each registration withdraws such a leftover at once (POST false,
  read back), before the write that needed the registration; the state never
  reads it as allowed, the `motionControl` access event carries the new
  cause `withdrawn-leftover` (allowed false), and one warning is logged. A
  person allows it again before a start or a jog; the client never does. A
  withdrawal that is refused or gets no answer leaves the allowance not known
  (null, cause `withdraw-failed`), never true, and is sent again at the
  disconnect and the next registration. Not done while a person's
  `setAllowMotionControl(true)` of this client is the write that registers.
  With a fixed station id it also withdraws an allowance another live session
  of that station made. `MotionControlCause` gains `withdrawn-leftover`.
- **`allowMotionControl` is `null` until the session registers**, then read
  once after each registration: RW 8.2.1 answers a session that is not a
  registered control station false whatever the station allows. It
  reads `null` while a `setAllowMotionControl(true)` is on the wire and
  after a set that got no answer (one read follows); a refused set leaves it
  as it was. `setAllowMotionControl(true)` is refused with `NOT_CONNECTED`,
  nothing sent, once a disconnect began (the disconnect withdraws); false is
  not refused for that reason. A connection with other settings is another
  station: when the old one may still have an allowance standing, the
  manager logs a warning.
- **`MultiRobotManager.removeRobot` returns the disconnect's promise.** The
  robot still leaves the lists at once; the promise settles after the
  withdrawal and `/logout` and never rejects. Code that ignores it is
  unchanged.
- **The RMMP sentences offer `requestRmmp` only where RMMP covers the
  operation**: not for a start, PP to Main, or a program-pointer move other
  than RobotWare 7's to a routine (ABB gives those to a remote tool in Auto,
  or to the FlexPendant). Such a refusal now says to do it at the
  FlexPendant or from this tool in Auto. A jog refused this way in manual
  mode on RobotWare 6 or 7 says to jog at the FlexPendant only: ABB's jog
  pages require a local client with mastership, and a jog is not done in
  Auto. A RobotWare 7 pointer move in manual mode other than to a routine
  no longer names RMMP exec.
- **The motion-control refusal sentence no longer names the method**; `fix`
  and `remedy.call` do. The sentence reads "motion control is not allowed for
  this control station" and no longer says the declaration belongs to the
  session that made it: on RW 8.2.1 another station, which registers with
  its own id, read it as not allowed. On RW 8.2.1 it belongs to the station:
  a second session with the same station id read it allowed, and kept it
  after the allowing session logged out; a process killed after allowing
  left it standing for the station for more than 7 minutes. A jog refused while motion control only
  read as not allowed says it "may be the reason", with evidence
  `unverified`.
- **RWS 2.0 session cookies are no longer written to the session file**
  (`~/.abb-rws-session`). Only RWS 1.0 reuses a saved cookie, and on
  RobotWare 8 a cookie left on disk after a crash would name a session that
  may hold a motion-control allowance.
- **RWS 1.0 `listAllSignals(start, limit)` returns every signal from
  `start` to the end of the list**, not one page (see Fixed), as RWS 2.0
  already did. A caller that paged with `start` and `limit` itself, as
  1.4.x needed, should call once: each of its calls now returns the rest of
  the list, so such a loop collects signals more than once.
- **`RwsClient2` refuses `timeout: 0`** with `INVALID_ARGUMENT` from the
  constructor (see Fixed). 0 turned the idle limit off, which was not
  documented; a caller that passed it for a long transfer passes a long
  timeout instead (at most 2147483647 ms). `requestDeadlineMs` still takes 0
  as off and caps a longer value, so the two options treat these values
  differently, as the README says.

#### Fixed

- **RWS 1.0 controllers on ports that Node's fetch refuses (such as 7, 6000
  or 10080) could not be reached; such ports now go through node:http/https,
  every other port through fetch as before.** The RWS 1.0 client sends
  through Node's global `fetch`, which refuses the Fetch standard's 83 "bad
  ports" (7, 21, 22, 6000, 6665-6669 and 10080 among them) before sending
  anything, so a controller on such a port could not be reached at all
  ("fetch failed", cause "bad port"). A RW 6.16.03 virtual controller came
  back on port 7 after a restart (2026-10-22); a real IRC5 behind port
  forwarding can sit on any port. A session now picks its transport once,
  from the port of its base URL (80 when it names none): on a bad port
  `node:http` / `node:https`, as RWS 2.0's always have, on any other port
  `fetch`, unchanged from 1.4.0. Port 0, on the standard's list, stays on
  `fetch`: Node's fetch accepts it, and `node:http` would turn it into port
  80. Through `node:http` a session keeps one
  connection open from request to request, closed once the session is
  closed and its `/logout` has gone out (inside VS Code with its proxy
  support on, each request goes on a connection of its own, as RWS 2.0's
  do); the request's configured timeout (plus its hold) is its only bound;
  it asks for an uncompressed answer (`Accept-Encoding: identity`) and still
  unpacks a compressed one; a read (GET) that fails on a kept connection the
  controller had just closed, within a second of being sent, is sent once
  more on a new one, inside the same timeout (never a write, a DIPC read,
  which takes the message off the queue, `/logout`, or a read the controller
  holds on purpose); redirects are not followed (no RWS 1.0 answer has been
  one), a 3xx is thrown with its status. On both: the timeout covers the
  whole answer, body included; every `Set-Cookie` line reaches
  `headers.getSetCookie()`; a network error is `NETWORK_ERROR` and now names
  Node's error (such as `connect ECONNREFUSED 192.0.2.10:80`) where 1.4.0
  said only "fetch failed". Should a Node release refuse a port the client's
  list lacks, the error says that fetch refused that port.
- **RWS 1.0: a subscription comes back after its connections drop, on the
  kept connection too.** The cookies of an answer were kept only when it
  was a 2xx. On RW 6.16.03, once the controller has let go of a client's
  `ABBCX`, the first request on a new connection is answered under a new
  client, and after a drop that first answer is an error (the best-effort
  DELETE of the old group, 400); every later request on that connection
  with the old `ABBCX` got 503, so the subscription never came back
  (functional test 10-subscriptions through `node:http`, port 7,
  2026-10-22). Through fetch the same test passed, because the request after
  a 503 went out on a second connection. Now the cookies of every answer are
  kept, whatever its status, through `fetch` and `node:http` alike, and
  through `node:http` the one retry after a 503 goes out on a new connection
  (through `fetch` its pool picks the connection, as in 1.4.0). RW 6.16.03
  sets the new `ABBCX` on that 400 (the trace of the fixed run), so the
  requests after it carry it on either transport. A different
  `-http-session-` on an error answer is reported as a new session, as on a
  2xx; a cookie set on a 401 is not taken for a dead session cookie. The trace names the cookies an answer sets (never their values) and
  the body of a 503.
- **`registerUser` without a locale: RobotWare 7.21.4 and 8.2.1 refuse it,
  and the error now says why.** They answer 400 -1073414146 "UserRegistration
  failed:locale name is empty or exceeded size of ulocale" (2026-10-21),
  which the client reported as `RESOURCE_NOT_FOUND`, "Resource does not
  exist on the controller", as in 1.4.0. It is now `INVALID_ARGUMENT`, and
  the message starts with what was sent: no `ulocale`, which ABB marks
  required, with the values `local` and `remote`. The request is unchanged;
  the controller decides.
- **RWS 1.0: a second subscription WebSocket in one session says why it
  failed.** ABB's RWS 1.0 allows one WebSocket per session, and RW 6.16.03
  failed a second `subscribe()` beside `RobotManager`'s stream before it
  opened. The error (`NETWORK_ERROR`, as before) now names the open
  subscription and says to add the resources to its group with
  `updateSubscriptionGroup`, or to subscribe from a session of its own; the
  refused group is deleted, as before.
- **A resource the controller leaves out of `RobotManager`'s subscription
  group is polled, and the quality reason says so.** RW 6.16.03 created the
  manager's group without `/rw/elog/0` for a whole run, answering 201 and
  naming the event log in a status block (2026-10-22). The client only
  logged it: no elog event came, `state.eventLog` went stale, and the
  quality read `live`, "WebSocket events streaming". The function
  `subscribe` returns now carries `unbound` (read live, both adapters):
  the resources the controller left out of the group it holds now, panel
  resources aside (those are still re-created in their other spelling, or
  fail the subscribe). It is optional on `SubscriptionHandle` and the
  declared `IRWSAdapter.subscribe` type is unchanged, so 1.4.0 code still
  compiles. `RobotManager` reads it at subscribe and after every restore:
  while the event log is unbound, the poll reads its newest page as an
  elog event would, about once per 5 x `refreshIntervalMs`; while a status
  resource the poll reads is unbound (controller state, operating mode,
  speed ratio, execution, collision detection; in practice only the
  execution state can be, since a refused panel resource is re-created in
  its other spelling or fails the subscribe), the poll runs at the fast
  rate. The quality stays `live` while the poll keeps the slow rate (an
  unbound event log) and reads `polling` while it runs fast, as `live` is
  documented; its reason names what is polled, for example "WebSocket
  events streaming, but the controller did not bind /rw/elog/0, so the
  event log is polled". Only an unbound event log has been seen on a
  controller.
- **RWS 1.0 `getCompatibility` no longer answers `compatible: false` when
  its request fails.** It answered false on any error, and its request went
  to a path in no ABB page, so it read false on every controller, whatever
  the hardware could run. It now throws only where that old answer was
  wrong: a refusal is the controller's typed `RwsError` (the virtual
  controllers answer 404), and an answer with no `ctrl-compatibility`
  status of true or false is `PARSE_ERROR`. `compatible: false` now means
  the controller answered false. Code that read `compatible: false` as "not
  compatible" gets an error where the answer is not known.
- **`RobotState.access.rw8.allowMotionControl` follows
  `setAllowMotionControl`.** After a successful `setAllowMotionControl(true)`
  through `RobotManager` the state still read false until the next poll,
  while the controller read true. The manager now takes the value from the
  call, true or false, and tells change listeners; a refused call leaves the
  state as it was.
- **`loadProgram` reports the name the controller gave the module.** A
  RobotWare 7.21.4 virtual controller loaded a module whose name clashed
  with one of its own names as `<NAME>#2`, and the report of the failed
  step said the module was loaded under its own name. The report now says
  "loaded module X into T as X#2, the name the controller gave it (unload it
  by that name)", from the module list the manager reads after the load.
  When the load is refused, or that list was not read, the manager reads
  the module list once more and reports such a name. A successful load under
  another name is logged as a warning.
- **An unload refused with 403 -1073414145 is explained.** The controller
  answers "Reason written in elog", which the client explained as "gave no
  reason". `RobotManager.unloadModule`, and the unload step of
  `loadProgram`, now read the newest event-log message once (a read; nothing
  is changed) and put its code, title and description in the sentence, as
  context: that message may be about something else, so the fix stays "Read
  the reason in the controller's event log". When the held module list
  shows the module under a name the controller gave it, the sentence and the
  fix say to unload it by that name. The code is generic (ABB:
  SYS_CTRL_E_UNEXPECTED), so only the unload request's own refusal, with the
  controller's "written in elog" text, is explained this way; a refusal of
  the access request, the stop or the module-list read keeps its own
  explanation, with no event-log read. The controller's code and answer are
  kept.
- **Refusal codes -1073435869 and -1073435856 (RobotWare 8).** -1073435869
  SYS_CTRL_E_REJECT_NOT_A_LOCAL_CONTROL_STATION is now explained as
  `local-only`: only the FlexPendant, the local control station, can do it.
  RW 8.2.1 answered a remote station's `disableExternalControl` with it.
  -1073435856 carried that name by mistake; the controller's own code list
  names it SYS_CTRL_E_REJECT_WRONG_LOCAL_PRESENCE_CERTIFICATE_KEY (the
  local-presence key is not correct), and its sentence now says so. It
  stays `local-only`. Its evidence is `vc`, as for -1073435869: the wording
  is the controller's, and ABB's page words the code differently.
- **The deprecated `setVirtualTimeRunning` error carries a refusal**, kind
  `unsupported`, with the fix (pause and resume the virtual clock from
  RobotStudio's Simulation tab), like the client's other refusals before
  sending. The message and the code (`UNSUPPORTED_OPERATION`) are
  unchanged.
- **A jog refused with -1073435864 is explained as `motion-control-off`
  whichever adapter sent it.** The jog explanation relied on a mark that
  only this package's adapters put on the jog request's error, so an
  `IRWSAdapter` of another make got the controller's bare answer.
  `RobotManager.jog` now reads the controller's code: -1073435864 (RobotWare
  8, the station has not declared motion control) becomes `GRANT_DENIED`
  with `refusal.kind` `motion-control-off`.
- **RWS 2.0 `getTaskActivationRecord` reads ABB's `rap-stackframe`
  entry.** It looked for `rap-activation-record`, a class ABB does not use,
  so a 200 answer read as `{}`. ABB documents `rap-stackframe` on both
  generations, with `execlevel`, `beg-row`, `beg-col`, `end-row`,
  `end-col`, `stack-url` and `routine-url`. Not yet run.
- **`listAliasIO` reads ABB's `rap-alias-io` entries, on both
  generations.** RWS 2.0 filtered on `rap-aliasio-li`, the link to the
  alias list in the `/rw/rapid` listing, and both generations read fields
  ABB does not send, so the list was empty even with aliases defined. The
  alias now comes from `alias-name` and the signal from `signal-name`. On
  RWS 2.0 an answer with typed entries but no `rap-alias-io` is
  `PARSE_ERROR`; RWS 1.0 reads a JSON or an XHTML answer and still answers
  `[]` when the controller refuses the read. The RWS 1.0 runs so far
  answered an empty list; RWS 2.0 is not yet run.
- **RWS 1.0 `getDnsConfig` returns every DNS entry.** ABB's answer has one
  `ctrl-netw-dns` entry per setting, and the method returned only the first
  (the DNS name). The result keeps the first entry's fields and adds one key
  per entry title: `name`, `primaryns`, `secondaryns`, `tertiaryns`,
  `quaternaryns` and `port`. ABB lists it for real controllers only; not
  yet run.
- **RWS 2.0 `getProgress` reads a `progress-ev` entry** when the answer
  has no `progress` entry. The fallback never applied before.
- **RWS 2.0: a subscription could go live without one of its panel
  resources.** A RobotWare 8.2.1 virtual controller answered
  `RobotManager`'s six-resource create 201 and left
  `/rw/panel/speedratio;speedratio` out of the group on some days, while
  the same request bound all six on others; the cause is not known. The
  client read only the status, so the manager reported live events and
  refreshed the speed ratio only with the slow poll. The RWS 2.0 subscriber
  now reads the 201 answer for the four panel resources: one a status
  block names is not bound, and one with no initial event is checked
  against the group's own listing (`GET /subscription/{group}`, only then).
  A group missing one is deleted and created once more with that resource
  in its other spelling (for example `/rw/panel/speedratio`), which
  reconnects then keep. If it is still missing, the group is deleted and
  `subscribe` throws, so the manager polls everything at the full rate, as
  the RWS 1.0 subscriber already does. A resource the answer refuses that
  is not a panel one is logged and the group kept. Each create's bound and
  refused lists are logged at trace level. The check costs nothing when
  every panel resource has its initial event. In a test run on 2026-10-22
  the RobotWare 8.2.1 virtual controller left speed ratio out of every
  group that asked for `/rw/panel/speedratio;speedratio` (24), and each
  group created with `/rw/panel/speedratio` bound it; the full-rate
  polling, for a resource left out in both spellings, has not run against
  a controller.
- **RWS 1.0 `listAllSignals` reads every page.** It sent one
  `GET /rw/iosystem/signals?start=0&limit=100`, so on an IRC5 with more than
  100 signals the rest was missing from `state.ioSignals`. It now follows
  each page's `next` link as given, as RWS 2.0 does, up to `maxPages` (new
  third parameter, default 50; logged when it ends the walk); a failed page
  fails the read. A page that links a next page the walk does not follow,
  or a full page with no link, is logged once per client, since only what
  was read is returned then. Each page is one request: `RobotManager`
  reads the table on its first poll, every fifth poll and every poll until
  a load succeeds, so on a controller with many signals each of those reads
  sends one request per 100 signals. RW 6.16.03 (62 signals) honours
  `limit`: the functional suite read it in pages of 20 by `start`
  (2026-10-22). Whether those pages carry a `next` link was not recorded,
  so the link walk has not run against a controller. The functional suite
  now checks it there with one call and a page size of 20; that check has
  not run yet.
- **Configuration loads refused with -1073437689 (SYS_CTRL_E_CFG_NAME_EXIST)
  or -1073437688 (SYS_CTRL_E_CFG_DATA_INCORRECT) are now `INVALID_ARGUMENT`
  with a refusal of kind `invalid-argument`** (they were `UNKNOWN`). Seen on
  loads with `add` of a domain the same controller had saved (RW 6.16.03,
  7.21.4 and 8.2.1 virtual controllers). On RobotWare 6 the refusal says
  that `new_code: 0xc0048410` (a held resource) in the message is not the
  cause, and under RobotWare 6's generic outer code -1073414146 the
  `code:` annotation is now read before that `new_code`, which 1.4.0
  read as a held resource. Which outer code RW 6.16.03 sent for these loads
  was not kept.
- **The `timeout` option is checked at construction, one rule for both
  generations** (`RwsClient`, `RwsClient2`). A finite number above 0 and at
  most 2147483647 ms (about 24.8 days, the longest delay a Node timer holds)
  is used as given; anything else (0, a negative value, NaN, Infinity, a
  longer value, or something that is not a number) throws
  `INVALID_ARGUMENT` naming the allowed range. Until now the value reached
  Node's timers as given. On RWS 1.0 every value outside the range (0, a
  negative value, NaN, 3e9, Infinity) fired after 1 ms, with a Node warning
  for each but 0, so every request failed with `NETWORK_ERROR`. On RWS 2.0,
  Infinity, a negative value or NaN failed every request with a raw
  `RangeError`, and a longer value printed a `TimeoutOverflowWarning`. A
  DIPC read's wait is still added for that one read, capped at the same
  limit. `timeout: 0` on `RwsClient2` is now refused (see Changed).
  `createClient` and `createAdapter` check `ConnectOptions.timeout` the
  same way, and `probeProtocol` and `probeHost` their `timeoutMs`, before
  any probe is sent. There, -1 or Infinity threw a raw `RangeError` and
  then, about 1 ms later, an uncaught "socket hang up" from the probe's
  request, which could end the host process; 0 or 3e9 ended the probe after
  1 ms as `PROTOCOL_DETECT_FAILED`. The probe now listens for request
  errors before it sets its timers, and its cap of four waits stays within
  what a timer holds.

#### Documentation

- `/uas/configuration` is recorded as a deliberate gap
  (`getUasConfiguration`, `uploadUasConfiguration`); `CONFORMANCE.md` now
  has 0 unmapped families.
- The functional suite fails a lane, instead of skipping it, when a
  controller of that RobotWare was found but could not be used (its login
  or system read failed, or it answered with the other generation's
  challenge) and no other controller of that RobotWare took the lane; the
  message names its address. An RWS 2.0 controller whose version could not
  be read fails both RWS 2.0 lanes. A lane left out by
  `RWS_FUNCTIONAL_ONLY`, or with no controller found, still skips. A run
  that reuses its `fleet.json` discovers again when that file names such a
  controller, so one that was still starting is not failed for the whole
  run.
- `getDiagnostics` no longer says it never ran: the RobotWare 7 and 8
  virtual controllers answered its read with the empty-state 400, which it
  reports as `empty`. It stays experimental, with no logged 2xx.
- `requestRmmp`: the code comments list the same cases as the README in
  which nothing is sent (RobotWare 8, a level this session already holds
  or covers, and a higher level while it holds a lower one), and the README
  adds the one the code also has: a second request while one waits is
  refused with `CONTROLLER_BUSY`.
- Older entries below that said "live controller" or "live IRC5" for runs
  on RobotStudio virtual controllers now say virtual controller.
- The functional suite (`npm run functional`) allows RobotWare 8 motion
  control for its RAPID-run tests only when
  `RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL` names the system name of the
  controller under test, as `/rw/system` reads it, and that controller
  identifies as virtual. A person at its virtual FlexPendant sets it; a value
  that names no controller (a left-over `1` or `rw8`) allows nothing. It is
  withdrawn when the lane ends; without it those tests skip and say why.

### Prepared as 1.4.0 (not published)

#### Added

- **`getEnv(name)` on both generations** (`RwsClient2`, `RWS1Adapter`,
  `IRWSAdapter`, `RobotManager`): one controller environment variable such as
  `HOME`, `TEMP` or `SYSTEM`, a leading `$` accepted. It sends ABB's
  `GET /ctrl/${ENVNAME}` with the `$` as `%24` and returns the `ctrl-env`
  value; an unknown name is the controller's 404. The old Unsupported entry
  recorded `/ctrl/env`, a path in no ABB document. Live on both
  generations: RW 6.16.03, 7.21.4 and 8.2.1 virtual controllers answered
  `TEMP`, `HOME` and `BACKUP`, and 404 for an unknown name. RW 6.16.03's
  answer is read since the `_value` fix under Fixed.
- **`getTaskSelection` on RWS 1.0**: `GET /rw/rapid/taskselection`, ABB's
  RWS 1.0 task-panel read, the same `rap-taskselection` class as on RWS 2.0.
  `RobotManager.getTaskSelection` used to answer an empty selection on
  RobotWare 6. Live: a RW 6.16.03 virtual controller answered T_ROB1 ON, so
  `getTaskSelection` is in `IRWSAdapterCore`.
- **RWS 1.0 forms for writes `RwsClient2` already had**, each built from
  ABB's RWS 1.0 page:
  - `setSignalSimulated`: the signal with `?action=set` and `lstate`
    (`simulated` / `not simulated`); network, device and name are needed.
  - `unblockSignals`: `POST /rw/iosystem/signals?action=unblock-signal`.
  - `setIoDeviceLState`: `POST /rw/iosystem/devices/{device}?action=set`
    with `lstate` (`enable` / `disable`); the device is named without its
    network, as `getIoDeviceInfo` names it.
  - `setKeylessMotorOn`: `POST /rw/cfg?action=keyless` with `state=run`,
    under RAPID mastership as for the ordinary motors-on.
  - `setMechunitBaseFrame`: the base frame with `?action=set` and x, y, z,
    q1..q4, under motion mastership as for the tool set on the same unit;
    `RobotManager` takes no RAPID mastership for it on RobotWare 6 (on RWS
    2.0 it still holds `edit`, RobotWare 8 write access).

  `setKeylessMotorOn` and `setMechunitBaseFrame` are live on a RW 6.16.03
  virtual controller: the keyless motors-on answered 204 with the motors off,
  and the motors read on 1.1 s later; ROB_1's own frame written back answered
  202 and read back unchanged. The three I/O forms are not yet run: that
  virtual controller has only drive and safety-panel I/O, nothing safe to
  change.
- **`IRWSAdapter.setSignalSimulated`, `unblockSignals`, `setIoDeviceLState`
  and `getEnv`** (optional members), and **`RobotManager` wrappers** for
  them. The I/O writes take no mastership or write access, as a value
  write does; through `RobotManager` an adapter without them gives
  `UNSUPPORTED_OPERATION`, and `getEnv` gives null.
- **The writes ABB documents with conditions no hold satisfies are explained
  in the README** ("Writes with conditions ABB states"): `setKeylessMotorOn`,
  `setExternalEmergencyStop`, `impersonateUser`, `changePassword`,
  `registerUser`, `requestMastershipWithId` / `releaseMastershipWithId`,
  `registerControlStationLocal`, `registerControlStationRemote`,
  `disableExternalControl` and `setAllowMotionControl`, each with ABB's own
  words on who may call it, in which mode, and what it does, and the document
  and section they come from. Every one of them stays available; the
  controller decides, and the client explains a refusal.
- **`RobotState.access.rw8.identity` and `.allowMotionControl`**: where the
  registered RobotWare 8 station identity came from (`option`, `explicit` or
  `default`; the name only, never the id or the PIN) and the station's
  allow-motion-control declaration as this client last set or read it.
  `registerControlStationRemote(name, id, pincode)` with explicit arguments
  overrides the `controlStation` option for that session;
  `setAllowMotionControl` logs the change at info level, naming the station.
- **`RobotState.access.watchdog` on RobotWare 8**, with the new `resettable`
  field: `enforced` and `timeoutMs` as read from `SYS/MASTER_BOOL/HeartBeat`
  once at connect, `running: false` and `resettable: false`, because the
  mastership service and its watchdog are gone on RobotWare 8 and ABB
  documents no RWS way to send the heartbeat there (`resettable: true` on
  RobotWare 7.8 and later, where the client keeps resetting it while it holds
  `edit`).
- **Access event `warning`, kind `heartbeat-required`**: on RobotWare 8 with
  HeartBeat `Select` true, `RobotManager` warns once per connection (a log
  line and the event) before a RAPID start or step under its write access:
  the controller's own event 10139 says a station holding write access while
  RAPID runs must send a periodic watchdog command or execution stops, and
  RobotWare 8 offers no RWS way to send it. The start goes out; nothing is
  blocked.
- **Access event `uncertain`**: a request for a lock did not answer, and
  whether the controller granted it could not be read either; the lock is
  `uncertain`, nothing is counted, and the next write requests afresh.
- **`npm run vc-ready`** (`scripts/vc-ready.mjs`): which RobotStudio virtual
  controllers on this PC are ready, one lane per RobotWare major (rw6, rw7,
  rw8): three reads per controller (`/rw/system`, operating mode, controller
  state) and a logout; a table or `--json`; `--lanes rw7,rw8`; exit 0 only
  when every requested lane is ready. `npm run functional` runs it first and
  leaves out the lanes whose controller is down, naming them, instead of
  failing every test of those lanes (`--no-vc-ready` skips the check).
- **Access manager and driver surface** used by the teardown and the
  read-back: `AccessManager.drain(ms)`, `inTurn()`, `refuseNewTurns()` /
  `allowTurns()`, `noteWarning()` and `noteReleaseFailed()`;
  `AccessDriver.heldByMe(lock)` (optional); `RwsClient2.DISCONNECT_DRAIN_MS`
  (5000); the exported type `AccessWarningKind`. `setPPToRoutineFromUrl`'s
  `userlevel` takes a boolean or a string.
- **Structural cell S16** (`tests/structural/S16-timed-out-write.test.ts`):
  a write whose answer is cut by the chaos proxy, then the read-back that
  decides what the controller holds; both generations, not yet run against a
  controller.
- **Tiers and evidence on every operation.** Each row of the path tables
  (`src/paths`, 313 operations) now states its `tier` - `core` (motors,
  operating mode, speed, RAPID run/stop/reset and variables, signals,
  mastership and RobotWare 8 write access, the event log, joint and Cartesian
  reads), `common` or `niche` - and its `evidence`: `live` when a probe log or
  a functional-test trace holds that request with a 2xx answer, and nothing
  else (an unlogged record or a form read is not `live`); `built` when there
  is no logged success. Where the two generations differ, the evidence is
  given per generation; a recorded gap carries none.
  `scripts/evidence-index.mjs` writes `tests/fixtures/evidence-index.json`
  from the logs (one logged success per live side), and a test checks that
  the tags match it in both directions; the reader takes four log line
  shapes (scripts/evidence-logs.mjs, with a test). Counts: core 33 (33 live),
  common 141 (133 live, 5 built, 3 live on one generation only), niche 139
  (93 live, 37 built, 9 on one generation); the counts are those of the
  README's generated block at release.
  `evidenceOf(op, generation)` and `isBuiltOnly(op)` read the tags.
- **`IRWSAdapterCore`** (exported type): the surface every generation has run
  against a controller - the core and common members of `IRWSAdapter` with a
  logged success on each generation that has them, plus `connect`,
  `disconnect`, `getSessionCookie` and `subscribe`. It picks members from
  `IRWSAdapter` with the same signatures, so every `IRWSAdapter` is one.
  Added alongside; nothing is removed from `IRWSAdapter`.
- **Generated README tables and "Known limits".** `npm run readme:gen`
  writes the README's operations-by-tier tables and a Known limits section
  (every operation built but never run, per generation, the UAS writes never
  sent, and the operations not wrapped with the controller's reason) from the
  path tables; `npm run readme:check` exits 1 when the README has drifted,
  and CI runs it after lint.

- **`clearCertificateStore(scope, store)`** on `RwsClient2`, `RobotManager`
  and (optional) `IRWSAdapter`: `POST /ctrl/certstore/{scope}/{store}/clear`
  with an empty form, the one certificate removal ABB documents and the
  controller serves (RWS 2.0 only; built-not-run).
- **`getVirtualTime().state`**: the controller's own virtual-time word
  (`VTSTOP`, `VTFREERUN`, `VTRUNSLICE`, `VTNEXTEVENT`), beside `running`.
- **`getBackupStatus().failed`**: true after 'Error during backup',
  'Invalid' or an unknown state text (RWS 2.0).
- **`RobotManager.listServiceRoutines(task)`** (and the optional
  `IRWSAdapter` member): the task's service routines as `{ name, url }`,
  the read both adapters already had. Run one with `setPPToRoutine` and a
  start; see `callServiceRoutine` under Fixed.
- **`RobotManager.setPPToServiceRoutine(task, routine, module?, { stopIfRunning? })`**:
  sets the program pointer to a service routine. The controller decides the
  mode (ABB documents PP to routine for a remote client in Auto on RobotWare 6
  and 7; RobotWare 8.2.1 in MANR with write access accepted it); RobotWare 8 in
  Auto is held back with `WRONG_MODE` before anything is sent (no run has
  shown it works there). It then reads the task's service-routine listing
  and refuses a routine not in it (`INVALID_ARGUMENT`), then calls
  `setPPToRoutine`, which is unchanged.
- **`SubscriptionUpdateError` (exported).** An `RwsError` thrown by
  `updateSubscriptionGroup` when the controller refuses resources in the PUT:
  on either generation for a 400 answer (same code, status, controller code,
  controller message and message as the classified error), and on RWS 1.0 also
  for a 2xx answer whose status divs name refused resources (`httpStatus` is
  then the 2xx). It adds `bound` (resource paths the controller bound anyway,
  matched by path, no `;state` suffix; an event-log entry is given as its
  domain, `/rw/elog/0`, not its message link), `refused` (the paths named by
  every status div) and `body` (the raw answer, which carries the bound
  resources' starting values).
- **`RwsError.responseBody` (optional).** The controller's answer body. It is
  set on errors the RWS 2.0 client's request path builds from an HTTP error
  answer read in full (up to `maxResponseBytes`) and on every
  `SubscriptionUpdateError`. RWS 1.0 errors, the subscription create and
  errors rebuilt from another do not carry it.
- **`RwsClient.request(method, path, body?, options?)` takes
  `options.holdMs`:** how long the controller may hold that one request open
  on purpose. Its timeout is the client's `timeout` plus the hold.
- **`findControllers(options)`: every discovery source in one call, one
  merged entry per controller.** Also `RobotManager.findControllers`. A bare
  call reads this PC's listening TCP ports and probes them on loopback (on
  Windows only the ports of RobotStudio virtual-controller processes,
  `filterToVcProcesses`; on Linux and macOS only listeners on the known RWS
  ports and `ports` unless `filterToVcProcesses: false`), and sends nothing
  off this PC. Opt-in sources: the
  service address 192.168.125.1 (`serviceAddress: true | 'auto'`), hosts you
  name (`manual`, up to 16, IPv4 or a host name looked up once, IPv4 only),
  IPv4 ranges (`ranges`, CIDR or dash, up to 16 entries and `maxRangeHosts`
  addresses, default 256, private addresses only unless `allowPublicRanges`),
  extra `ports`, and mDNS (`mdns`, the only switch for mDNS traffic).
  `identify` sets how far it goes to name a controller: `'none'` (one
  unauthenticated `GET /rw/system` per probe), `'anonymous'` (the default;
  adds the RobotWare version and system name of an OmniCore VC from its system
  folder on this PC, with no network traffic) or `'with-credentials'` (one
  login per controller that has a `credentials` entry, one at a time, each
  followed by `/logout`; no default user, and never over plain HTTP to
  another computer). Another host is probed on 443 and 80, HTTPS first, with
  HTTP only where HTTPS found the port open and not speaking TLS or not
  answering the TLS handshake (an IRC5 on 80); the virtual-controller ports
  are probed on loopback only. Probes are paced (`pacing`: on other hosts 8
  sockets in flight by default, up to 16 when a caller asks, 2 per host, and
  new connections at least 100 ms apart, so never more than 10 a second), carry
  `User-Agent: abb-rws-client/<version> discovery`, and record the leaf
  certificate's SHA-256 (`tlsFingerprint`; `strictTls`, `pinnedFingerprints`,
  `tlsFailures`). `loopbackOnly: true` refuses every target off this PC's
  loopback before anything is sent. The call resolves with `{ controllers,
  aborted, localScan, environment, tlsFailures, unmatchedCredentials, notes }`:
  invalid options reject with `INVALID_ARGUMENT` before any socket, process or
  DNS lookup, a failing OS source never fails the call (`localScan.attempts`
  says how each one ended, and a note says when none could list the ports),
  `signal` resolves with `aborted: true` and the
  entries found so far, and `onProgress` reports each phase. Listening-port
  sources: Windows `netstat -ano` (opt-in `Get-NetTCPConnection` and a
  loopback sweep through `localFallback`), Linux `/proc/net/tcp` then `ss`,
  macOS `netstat` then `lsof`; inside WSL a note says that VCs on Windows may
  not be visible. The README section "Finding controllers" lists what
  discovery sends and what it runs on this PC.
- **`discoveryKey(host, port)` and `isLocalAddress(host)`**: the key
  `findControllers` merges by (`'local:<port>'` for any address of this PC,
  else `'<ipv4>:<port>'`), for products that store controllers found by it.
  New exported types: `FindControllersOptions`, `FindControllersResult`,
  `FoundController`, `FoundAddress`, `ControllerSource`, `ManualTarget`,
  `DiscoveryProgress`, `LocalScanStatus`, `LocalScanReport`,
  `DiscoveredProbe`.
- **`RwsError.refusal` and `explainRefusal(err, context)`.** An error that is
  a refusal - by the controller, or by this client's own pre-flight check
  (jog, RMMP) - carries `refusal`: its `kind`, the missing `condition` and
  `missing` in plain words, the `grantor` (`pendant-operator`,
  `uas-administrator`, `current-holder`, `integrator`, `key-switch`,
  `cell-safety`, `abb-option`, `this-tool`, `nobody`), the `fix`, the whole
  `sentence`, for a missing grant its identifiers and RobotStudio names and
  the user, for a held lock the holder, the controller's answer (HTTP status,
  code in decimal and hex, ABB's name, `icode`, message), the RobotWare
  generation and how sure the explanation is (`evidence`). `code` is
  unchanged, and no `RwsErrorCode` member is added. `RobotManager` explains
  its session's refusals with its current operating mode, controller state,
  RMMP and controller name; `explainRefusal` lets any caller add what it
  knows. `RmmpResult` carries the refusal of a `denied` or `expired` wait.
  New exported types: `RwsRefusal`, `RefusalKind`, `RefusalCondition`,
  `RefusalGrantor`, `RefusalGrant`, `RefusalHolder`, `RefusalController`,
  `RefusalContext`.
- **An explicit stop option on `RobotManager` writes that change a program
  that may be running**: `setPPToRoutine(task, module, routine, { stopIfRunning })`,
  `unloadModule(task, module, { stopIfRunning })` and
  `loadProgram(localFile, task, { stopIfRunning, resetPP })`. Optional last
  arguments, so existing calls compile unchanged; what they change is
  described under Changed.
- **`RobotState.access`, `RobotManager.onAccessEvent(fn)` and
  `MultiRobotManager.onAccessEvent((id, e) => ...)`**: what the session
  holds, and every change to it. `RobotState.access` gives the generation
  (`'rw6' | 'rw7' | 'rw8'`), one entry per lock of the generation with its
  state (`idle`, `held`, `uncertain` after a release that did not go through,
  `lost`), the count of holds, since when, and for a lost lock the reason
  and, on RobotWare 8, the station now holding it; the RobotWare 7.8+
  watchdog (`running`, `enforced`, `timeoutMs`, `intervalMs`, `lastKick`); and
  the RobotWare 8 station (`registered`, `stationName`; never the id or the
  PIN). `onAccessEvent` reports `acquired`, `released` (`alreadyCleared`),
  `lost` (`reason`, `detail`, `by`), `releaseFailed` and `atRisk` events, each
  with `lock` and `at`; each event also fires `onDidChange`. Both are
  observations, never permission to write. New exported types:
  `AccessState`, `AccessLockState`, `AccessLockStatus`, `AccessLock`,
  `AccessGeneration`, `AccessEvent`, `AccessLossReason`, `AccessRiskReason`,
  `AccessWatchdogState`. Additive; a consumer that builds its own
  `RobotState` literal (a mock or a fallback state) adds
  `access: { generation: null, locks: [], watchdog: null, rw8: null }`.
- **RobotWare 8: a named control station with a stored id.** New
  `ControlStationIdentity` `{ name, id, pincode, releaseWriteAccessWhenLost? }`,
  accepted as `ConnectOptions.controlStation` (`createClient`,
  `createAdapter`), `RobotManagerOptions.controlStation` (so also
  `MultiRobotManager`'s options, for every robot), per robot as
  `RobotConfig.controlStation`, and through the new
  `RobotManager.setControlStation(identity)`, which takes effect at the next
  connect. Every RWS 2.0 client a manager builds registers with it, so the
  station stays the same across reconnects, also when a virtual controller's
  port moves. The id must be a braced GUID of 38 characters and the PIN
  digits only, at most 11 (ABB documents an integer with up to 11 digits);
  the name must not be empty. A malformed value throws `INVALID_ARGUMENT`
  naming the field, never echoing the id or the PIN, before anything is sent.
  Ignored on RobotWare 6 and 7. Additive.
  - `releaseWriteAccessWhenLost` (default false; also on `RwsClient2`'s
    `controlStation` constructor option) adds ABB's optional
    `release-write-access-when-lost=TRUE` field to `register/remote`, the
    `{TRUE|FALSE}` form ABB's RobotWare 8 Control Station Service documents.
    Pending live confirmation: the field has not been sent to a controller
    yet, and ABB does not define when a station counts as lost. When false the
    field is not sent, so the body is unchanged.
  - Without the option nothing changes on the wire: the anonymous
    `abb-rws-client` station with an id generated for each client instance
    and the PIN `1234`. `RwsClient2` now logs a warning once per client
    instance, at its first registration, that the station is anonymous and
    how to name it.
  - Trace logs now mask `control-station-id` in request bodies, as they
    already masked `pincode`.
- **`RobotManager.onSubscriptionEvent(fn)`**: a raw tap on the manager's
  subscription-event stream, returning an untap function. Events for resources
  the manager does not consume itself - e.g. `{ type: 'signal', name }` added
  to the live group via `updateSubscriptionGroup` (RWS 2.0, see
  `subscriptionGroupPath`) - were previously dropped unseen; they only surface
  through this tap, as they are not part of `RobotState`. Known panel resources
  pass through too, before the manager applies them. Built for the daemon's
  I/O watch (slice 5). Additive.
- **`RobotManager.getWriteAccessStatus()`** -> `WriteAccessStatus` `{ held,
  heldByMe, heldByName, externalControlEnabled }` (RobotWare 8): one GET of
  the control-station write-access status on the manager's session; it
  registers no control station and requests nothing. Each field is what the
  answer said: a flag is true only for the text `true` and false only for
  `false`, and any other text or an absent field is null, never false;
  `heldByName` is null for `none`; `heldByMe` compares the holder id with this
  client's station id (false when not held, null when no holder id is given),
  and no station id is in the result. An answer with no write-access status
  (an empty body included) throws `PARSE_ERROR`; any other failure is the
  adapter's own error; it never answers null. RobotWare 6 (RWS 1.0) and 7
  have mastership instead: `UNSUPPORTED_OPERATION`, nothing sent. On an RWS
  2.0 connection whose RobotWare version was not usable the GET is sent and
  the answer decides. `RwsClient2.getWriteAccessStatus()` is unchanged. New
  exported type: `WriteAccessStatus`.
- **`getWriteAccessStatus().heldByMe`** (RWS 2.0 / RW8): whether the holder of
  control-station write access is THIS client. `held` alone cannot tell "I can
  write" from "another station owns it"; the PC SDK exposes HeldByMe and the
  RWS resource does not, so it is derived from the holder id (case-insensitive).
  Additive - existing consumers of the status object are unaffected.
- **`getJointTargetFull(mechunit?)`** (both generations; `RwsClient`,
  `RwsClient2`, `RWS1Adapter`, optional on `IRWSAdapter`, wrapped on
  `RobotManager`): every axis slot of a mechanical unit - `rax_1..rax_6` AND the
  external axes `eax_a..eax_f` - as a `JointTargetFull { rax, eax }`. The
  controller has always sent all twelve fields; `JointTarget` /
  `getJointPositions` keep only the robot half and are unchanged. One GET of the
  same `jointtarget` resource. A missing robot field is `PARSE_ERROR`, never an
  invented zero; a missing external field reads as 9E9.
- **`JOINT_NOT_PRESENT` (9E9) and `isJointValuePresent(value)`**: the RAPID/RWS
  "no axis in this slot" marker and a threshold test for it (it can arrive as
  `9E+09`, `9000000000` or, through a 32-bit float, `8999999488`). Unused slots
  are not guaranteed to carry it: the RW 7.21 VC reports unused `eax_*` as `0` -
  which slots a unit uses comes from its axis count.
- **`RobotManager.getMechunitDetails(mechunit?)`** -> `MechunitDetails`: the
  mechanical-unit resource typed - `type` (e.g. `TCPRobot`), `axes`,
  `axesTotal`, the driving RAPID `task`, `mode`, `status`, `coordSystem`,
  `tool`, `wobj`, the integrated-unit pair, plus `raw`. Normalises the RW 6
  JSON spellings (`task`, `*-unitname`). Absent or malformed
  fields are null.
- **`RobotManager.getCartesianFull(mechunit?)`**: the existing adapter read,
  now reachable through the manager without going through the polled
  `RobotState`.
- `getJointTargetFull`, `getMechunitDetails` and `getCartesianFull` on
  `RobotManager` throw `NOT_CONNECTED` (and `UNSUPPORTED_OPERATION` for an
  adapter without the read) rather than returning a neutral value, so a
  sampler never mistakes "no data" for a reading.
- **RWS 2.0 response limits: `maxResponseBytes` and `requestDeadlineMs`**
  (`RwsClient2` constructor options). A response body over `maxResponseBytes`
  (default 64 MiB) is refused with `NETWORK_ERROR` and its connection dropped;
  the same cap applies to one subscription event frame (the socket closes with
  1009 and the reconnect path runs). `requestDeadlineMs` bounds one request
  from send to last byte (default 120 s, or `timeout` when longer): `timeout`
  is an idle limit that every received byte resets, so a peer trickling a body
  never tripped it and the body grew without limit. `requestDeadlineMs: 0` (or
  `Infinity`) turns the deadline off; a value above 2^31-1 ms (about 24.8 days)
  is capped there. Additive.
- **`RobotState.ioSignalsLoaded`**: true once `ioSignals` was loaded on the
  current connection; false while connecting, after every disconnect and until
  the first successful signal-table load. `ioSignals: []` alone could not tell
  "not loaded yet" from "no signals". Additive.
- **RMMP and jog types**: `RmmpLevel` (`'modify' | 'exec'`), `RmmpOutcome`,
  `RmmpRequestOptions` and `RmmpResult` for `RobotManager.requestRmmp(level,
  options)`, which now resolves an `RmmpResult` (it resolved nothing); and
  `JogIncrement` and `JogParams`, the jog parameters with the new optional
  `incMode`. The adapters' `requestRmmp` accepts `'exec'` (with `'exclusive'`
  as a deprecated alias of it). Additive.
- **A warning before `saveDiagnostics` on RobotWare 7.15.0.** ABB's 7.15.1
  release notes list "System failure when requesting a system diagnostics"
  among the corrections in 7.15.1 (title only; no affected range is stated
  and whether an RWS request triggers it is not said). When the RobotWare
  version `connect()` cached is 7.15.0 the method logs a warning and still
  sends; nothing extra is fetched.
- **A hal+json GET whose body is not valid JSON is now reported.**
  `HalJsonParser` swallows the `JSON.parse` failure and every read on it
  answers empty, so a caller saw an empty list or a default with no sign of
  the fault. ABB's 7.10.0 release notes §3.9 say some RWS APIs under `/rw/cfg`
  could return an invalid value such as four consecutive double quotes and
  that 7.10.0 corrects it (ABB names no affected range; earlier RobotWare 7
  builds are the inference). The client now logs one warning per request with
  the path and the first 80 characters of the body; the return value and
  every throw are unchanged.
- **Functional tests: `npm run functional`.** A live suite that drives local
  RobotStudio virtual controllers through the client's own API
  (`RobotManager`, `MultiRobotManager`, `createAdapter`, `createClient`), one
  lane per RobotWare major (6, 7, 8): connecting and detection, panel and
  system reads, I/O, event log, files, configuration reads, RAPID data and
  execution, small joint moves out and back, subscriptions, write access and
  mastership, system operations and an opt-in warm restart. Each lane takes a
  snapshot of the controller first and restores it afterwards; motion stays
  within a few degrees at a speed ratio of 50 % or less. It needs
  `RWS_FUNCTIONAL=1` (the script sets it) and is skipped in `npm test`. See
  the README section "Functional tests".
  - On RWS 1.0 the I/O write tests use a session of their own (the manager
    logged out) instead of a second subscription group on the manager's
    session.
  - The warm restart lane waits, sending only controller-state reads, until
    the state has read what it read before the restart for 20 s in a row:
    before the tests that compare state with before, again after the
    speed-ratio write that follows the restart, and a last time before the
    restore. The RobotWare 7.21.4 virtual controller, restarted in Auto with
    the motors off, read guard stop about 9-11 s after the restart (or after
    the first write that followed it; the evidence does not yet tell which),
    in one run with a motors-on read just before, and returned to motors off
    by itself.
  - `npm run functional:fixtures` adds or removes the simulated digital input
    and output the I/O tests write to on the RobotWare 6 and 7 virtual
    controllers (localhost only; nothing is sent without
    `RWS_FIXTURES_APPLY=1` and a lane list). On RWS 2.0 it also tries
    `/fileservice/TEMP/<file>` for the validate and the load, accepts only
    the documented `cfg-validate` body as a pass, and reports 404 on every
    form as a missing validate endpoint. It refuses when the configuration
    list read looks cut off.
- **RWS 1.0 RAPID editing and program-pointer writes.** `setBreakpoint`
  (`program/breakpoint?action=set`), `setPPToCursor`
  (`pcp?action=set-pp-curser`), `setModuleText` (`?action=set-module-text`),
  `setModuleTextRange` (`?action=set-text-range`) and `ppPrevInst` /
  `ppNextInst` (`pcp?action=set-pp-prev-inst` / `set-pp-next-inst`), built
  from the forms RobotWare 6.16.03 serves. Each holds RAPID mastership.
  `ppPrevInst` / `ppNextInst` are also optional `IRWSAdapter` members with
  `RobotManager` wrappers. All six have run against RobotWare 6.16.03
  (`setPPToCursor` in the form given under Fixed).
- **RWS 1.0 `updateSubscriptionGroup`** (PUT `/subscription/{id}`, ABB's
  RWS 1.0 manual). It refuses a malformed group path, an empty list or an
  invalid signal name before sending.
- **RWS 1.0 `getMechunitPjoints`** (GET
  `/rw/motionsystem/mechunits/{mechunit}/pjoints`).
- **RWS 1.0 `checkRestore`** (`GET /ctrl/backup?action=check-restore` with
  the backup as the `backup` query parameter, a `/fileservice/` URI, as ABB's
  RWS 1.0 manual documents). It takes no mastership and resolves only when the
  controller answers status `Accepted`; any other status is
  `INVALID_ARGUMENT`. Live on RobotWare 6.16.03. Also an optional
  `IRWSAdapter.checkRestore` and `RobotManager.checkRestore`.
- **RWS 1.0 `getMotionSupervision` and `getPathSupervision`**, read at the
  motion-system root with `?mechunit=` (RobotWare 6.16.03 serves motion
  supervision there and answers 400 without the query). Both are now
  `IRWSAdapter` and `RobotManager` members.
- **RWS 2.0 `validateCfgFile`** (`POST /rw/cfg/validate`, `filepath` +
  `action-type`, ABB CFG service Rev L), so the CFG load dry-run works on both
  generations through `IRWSAdapter` and `RobotManager`. A 2xx answer with an
  error status throws `INVALID_ARGUMENT`; an answer with neither a
  `cfg-validate` item nor an error status is not counted as a pass and throws
  `UNKNOWN`.
- **RWS 2.0 `setMechunitForJogging`** (`POST /rw/motionsystem/{mechunit}`,
  ABB Motion_System Rev L) under motion mastership (RobotWare 8: write
  access), plus the `IRWSAdapter` member and
  `RobotManager.setMechunitForJogging`. Unit names that are empty, contain
  spaces or match a sibling motion-system resource are refused before
  sending.
- **RWS 2.0 (OmniCore) reads on `RwsClient2`.**
  - `verifyControllerFeature(featureId, robno?)`: whether one controller
    feature is present (true on 204, false on 404).
  - `getSafetyConfigChangeCount()`: the safety-configuration change count
    (RobotWare 7.20+), so a caller can poll for safety-configuration changes.
  - `getSafetyConfig()`: the loaded safety configuration's status, versions,
    creator and checksum.
  - `getMechunitCalib(mechunit?)`: a mechanical unit's calibration resources.
  - RAPID module sub-resource reads `getModPossibleAll()`,
    `getModuleModPossible()`, `getModuleSymbolInfo()`, `getModuleAttributes()`
    and `getModuleObject()`. Each returns every entry as read; the per-module
    ones take an optional pass-through query (new exported type
    `RapidModuleQuery`). The query is checked before sending: a non-object
    query, an empty key or a non-finite or non-string value is refused with
    `INVALID_ARGUMENT`, and a null query means no query.
  - `listModuleRoutines` (the module-scoped RAPID symbol search, on both
    generations), now on `IRWSAdapter` and `RobotManager`, typed
    `RapidRoutineInfo[]` with type `prc` / `fun` / `trp`.
- **UAS user and role reads on `RwsClient2` (RWS 2.0 only).**
  `listUasUsers`, `getUasUser`, `listUasUserGrants`, `listUasUserRoles`,
  `isUasUserEnabled`, `getUasUserDescription`,
  `isUasUserPasswordChangeAllowed`, `listUasRoles`, `getUasRole`,
  `listUasRoleGrants`, `getUasRoleDescription`; also optional members on
  `IRWSAdapter`. The users and roles listings follow the controller's pages,
  stop when a next link points back at a page already read, and log a warning
  when the 50-page cap cuts a listing short. Without the UAS administration
  grant they throw `GRANT_DENIED`; the OmniCore Default User gets 403
  -1073445867 on RobotWare 7.21.4 and 8.2.1. An empty user or role name, and
  `.` or `..` as a name, are refused with `INVALID_ARGUMENT` before anything
  is sent. The enabled and password-change flags are strict: an answer that
  is not true or false throws `PARSE_ERROR`.
- **Reads on both generations** (optional `IRWSAdapter` members and
  `RobotManager` reads):
  - `getRapidTask(task)` (`GET /rw/rapid/tasks/{task}`).
  - `getCfgType(domain, type)`: a CFG type's attribute and instance counts
    (`CfgTypeInfo`).
  - `getFileMetadata(path)` (`FileMetadata`): RWS 2.0
    `HEAD /fileservice/{path}`; RWS 1.0 the file's entry in its parent
    directory's listing (`GET /fileservice/{parent}`: `fs-size`, `fs-cdate`,
    `fs-mdate`, `fs-readonly`), where RobotWare 6.16.03 answers ABB's HEAD
    with only `Content-Length`. A name the listing does not hold is
    `RESOURCE_NOT_FOUND`, a directory `UNSUPPORTED_OPERATION`. `HttpVerb` now
    includes `HEAD`.
  - `listSubscriptionGroups()` and `getSubscriptionGroup(group)`: the
    session's subscription groups with their poll URLs, and one group's
    members exactly as the group stores them. `group` is the id or
    `/subscription/{id}`. Useful to find a group a crashed caller left behind.
  - `getMechunitSmbData`, `getMechunitMotorCalib` and `getLeadThrough` (ABB
    Motion_System Rev L; RWS 1.0 lead-through via `?resource=lead-through`).
- **RWS 1.0 reads now on `IRWSAdapter` and `RobotManager`:**
  `listCfgTypeAttributes` (follows next links), `getDipcQueueInfo`
  (`GET /rw/dipc/{queue}`, ABB's "Get DIPC Queue"; null for an unknown queue;
  typed `DipcQueueInfo`), `getIoNetwork` and `getIoDeviceInfo`
  (`/rw/iosystem/devices/{device}`: RWS 1.0 names the device without its
  network).
- **I/O configuration reads on RWS 1.0, and on `IRWSAdapter` and
  `RobotManager`:** `getSignalConfig(network, device, name)`,
  `getIoNetworkConfig(network)` and `getIoDeviceConfig(network, device)`.
  RobotWare 6.16.03 serves them as a `?resource=config` query on the signal,
  network or device (the device named without its network) and answers the
  RWS 2.0 `/config` sub-path 404. The XHTML answer is read, because the
  `?json=1` answer packs the general and runtime classes into one object
  with duplicate keys; the general entry is returned on both generations.
  Live-verified 2026-10-03 on RobotWare 6.16.03, 7.21.0, 7.21.4, 8.1.1 and
  8.2.1; an unknown name is refused 400 (`INVALID_ARGUMENT`) on all of them.
- **Task motion reads on `RwsClient2` (RWS 2.0 only):**
  `getTaskRobTarget(task)` (`TaskRobTarget`: x y z, q1..q4, cf1 cf4 cf6 cfx
  and the six external axes), `getTaskJointTarget(task)`
  (`JointTargetFull`), `getTaskMechunits(task)` (`TaskMechunit[]`: name, mode,
  type) and `getTaskExtJointState(task)` (`j1`..`j6`), from
  `/rw/rapid/tasks/{task}/motion/robtarget`, `jointtarget`, `mechunits` and
  `extjointstate`. RobotWare 7.21.0, 7.21.4, 8.1.1 and 8.2.1 serve all four;
  the task robtarget is rounded to 0.01 mm, and unused external slots read
  9E9 where the motion system's own jointtarget reads 0. An empty task name
  is refused with `INVALID_ARGUMENT` before anything is sent.
- **`scripts/probe-config-task-motion.mjs`**: the read-only probe behind the
  two entries above (GET and OPTIONS only, one request a second, a health
  check after each, every session logged out).
- **`XhtmlParser.getAllEntries()`** returns every typed entry with its class
  as `_type`.
- **New exported types:** `CfgTypeInfo`, `DipcQueueInfo`, `FileMetadata`,
  `RapidRoutineInfo`, `RapidModuleQuery`, `SubscriptionGroupInfo`,
  `SubscriptionGroupMember`, `MotionSupervisionState`, `PathSupervisionState`,
  `MechunitMotorCalib`, `LeadThroughState`, `TaskRobTarget`, `TaskMechunit`.

#### Changed

- **The HeartBeat configuration is read at connect**, once per connection, on
  RobotWare 7.8 and later including RobotWare 8 (before: one moment after the
  first `edit` hold, RobotWare 7 only). Still read only, never written; a
  refused or failed read leaves `enforced` and `timeoutMs` null and does not
  fail the connect.
- **`RwsClient2.disconnect()` order**: the watchdog stops; the write in
  progress finishes, for at most 5 s (then a warning, and the teardown goes
  on); RobotWare 8 write access is released when this session ever requested
  it, answered or not (a "does not have SPoC" answer is taken as already
  cleared; any other refusal is observed as `releaseFailed` and logged, where
  it was swallowed before); with-id mastership tokens are released; then
  `/logout`. From the first tick of `disconnect()` a request from outside the
  operation in progress is refused as `NOT_CONNECTED`, while the operation's
  own requests still go out ahead of the logout.
- **README**: the logout lines say what each generation does (RobotWare 6 and 7
  end the session's mastership on logout; RobotWare 8 write access persists,
  so `disconnect()` releases it first); the generated tables print a side the
  generation does not have as `unsupported` (was `not wrapped`), and the
  Known limits list calls that section "Unsupported".
- **Request spacing is 100 ms on both generations** (was 55 ms): `RwsClient`'s
  `requestIntervalMs` defaults to 100 and `RwsClient2` keeps at least 100 ms
  between the starts of any two requests. ABB's RWS introduction states 50 ms
  minimum per request (20 requests per second); 100 ms keeps twice that floor.
  Pass `requestIntervalMs` to `RwsClient` for another value.

- **Never-run operations are marked `@experimental`** with the reason ("built
  from the controller form; never run against a controller") on `IRWSAdapter`,
  on the `RwsClient2` methods whose RWS 2.0 request has never run, and on the
  `RWS1Adapter` and `RwsClient` methods whose RWS 1.0 request has never run.
  `IRWSAdapter` members that have run on one generation only say which.
  Documentation only: no signature, optional member or behaviour changes.
- **`lockOperationMode` / `unlockOperationMode` have run on RWS 2.0**: both
  answered 204 on RobotWare 7.21.4, 8.1.1 and 8.2.1 virtual controllers
  (2026-10-10), so their RWS 2.0 sides are `live` and no longer
  `@experimental`. The RWS 1.0 sides stay built, never run.
- **`unlockOperationMode(pin?)`** on `RobotManager`, `IRWSAdapter`,
  `RwsClient2`, `RwsClient` and `RWS1Adapter` takes the PIN the lock set.
  The parameter is optional in the signature for source compatibility, but
  the controller form requires it on both generations, so a call without one
  is refused with `INVALID_ARGUMENT` before anything is sent (it used to post
  an empty body).
- **`setVirtualTimeScale` refuses 0, a negative value and NaN**
  (`INVALID_ARGUMENT`, nothing sent). `Infinity` sends the controller's -1,
  "as fast as possible".
- **`RwsClient2.setMotionSupervisionMode` and
  `RwsClient2.setCollisionPredictionMode` take `boolean | string`** (so does
  `RWS2Adapter`, which extends it). A boolean, `'true'` / `'false'` or
  `'on'` / `'off'` (any case, so the `ON` / `OFF` that
  `getCollisionPredictionMode` answers can be written back) is sent as ABB's
  `true` / `false`; anything else is refused with `INVALID_ARGUMENT` before
  sending. `IRWSAdapter.setCollisionPredictionMode` and
  `RobotManager.setCollisionPredictionMode` are typed `string` and take the
  same strings; `RobotManager` has no `setMotionSupervisionMode`.
- **RWS 1.0 `setRobtargetForJogging` takes the full target**: position,
  quaternion, the RAPID `robconf` (`cf1`, `cf4`, `cf6`, `cfx`, required: no
  configuration is invented) and optionally the six external axes `eax`
  (an omitted axis is sent as 9E9, RAPID's "no axis"). The method had no
  caller in the family; the old seven-field object is refused with
  `INVALID_ARGUMENT`.
- **`getReturnCode(code, lang?)`: `lang` is accepted and ignored** (the
  controller serves English only).
- **`listSafetyZones` and `removeCertificate` are deprecated**: no RWS
  resource is behind them (see Fixed). They stay until the next major version.
- **`holdToRun` takes `'press' | 'held' | 'release'`** on `RobotManager`,
  `IRWSAdapter`, `RwsClient2` and `RWS1Adapter`. ABB documents sending `held`
  about every 2 s to keep the motion going. The RWS 2.0 wire form and its
  access handling are unchanged.
- **The `motion-held` refusal (-1073445844) describes the case that remains.**
  It names a hold taken with `requestMastership('motion')` or
  `requestMastershipAll()` and says to end it with the release that matches
  the request: `releaseMastership('motion')` after
  `requestMastership('motion')`, `releaseMastershipAll()` after
  `requestMastershipAll()` (`releaseMastership('motion')` does not end an
  all-domains hold). It no longer says "within 2 s of a jog".
- **`wideHostScan` and `discoverLocalControllers` sweep this PC's loopback
  only (behaviour change).** `wideHostScan(host)` with a host outside
  127.0.0.0/8, `::1` and `'localhost'` now rejects with `INVALID_ARGUMENT`
  instead of opening a connection to every port of another machine. On
  loopback it also tries 80 and 443, and it skips a fixed list of
  industrial-protocol and printer ports (102, 502, 1217, 2222, 2404, 4840,
  9100, 11740, 20000, 44818). `discoverLocalControllers(host)` falls back to
  that sweep only when no OS listening-port source answered at all (no longer
  when one answered with no ports), and never for a host off this PC's
  loopback. It skips the same ports and listeners bound to `::1` alone or to
  a LAN address only, and returns its results in port order (was the order the
  probes finished in).
- **`KNOWN_RWS_PORTS` lists port 80 over HTTPS as well as HTTP, and 9805 and
  11622.** The order is 443, 80 (HTTPS), 80 (HTTP), 5466, 9403, 9805, 11622
  (HTTPS), 11811, 28447 (HTTP). `probeHost`, `createClient` /
  `createAdapter` without a port, `detectAllControllers` and connect-time
  recovery therefore see more candidates: an RW 8.1.1 virtual controller on 80
  is found (first, on a PC that runs one), and recovery may refuse where it
  used to adopt the only candidate of a protocol when no system id is known.
- **`discoverControllers(extraHosts)` drops an extra host that is not an IPv4
  address or host name** (a `host:port` string, an IPv6 literal, text with
  spaces) with a warning instead of probing it, and never rejects. Results come
  in a fixed order: this PC's controllers first, then the others by address
  and port (was the order the probes finished in). It still always probes the
  service address.
- **Connect-time recovery on another computer** logs in only to candidates
  whose 401 carries the RWS realm (`validusers@robapi.abb`), and never sends
  Basic credentials over plain HTTP; other candidates are logged and skipped.
  `chooseRecoveryCandidate(candidates, expectedAuth, ...)` accepts
  `expectedAuth: null` (no protocol filter), which recovery uses for a saved
  port that serves either scheme (80, or a port not in the table) saved without
  `useHttps`; with no system id known, a lone candidate of either protocol is
  then adopted.
- **Discovery probes identify themselves** with `User-Agent: abb-rws-client/<version>
  discovery` (`findControllers` and the `RobotManager` discovery and probe
  methods).
- **Error and log texts list the ports from `KNOWN_RWS_PORTS`** (`createClient`
  / `createAdapter` when no port answers, `RobotManager` auto-detect) instead
  of stale lists, and a failure on a given port names the schemes tried.
- **The live test helpers and scripts discover through `findControllers`** with
  `loopbackOnly`, no service address, no mDNS, the virtual-controller process
  filter and one probe at a time at least 1 s apart. The fixed port lists and
  the helpers' own `netstat` parses (which needed the English word
  `LISTENING`) are gone. The structural helper picks one controller per
  generation (the `RWS_TEST_PORT_*` port, else the lowest RobotWare major,
  then the lowest port); the functional suite and `functional:fixtures` choose
  lanes from the 401 challenge and the VC's system folder, logging in only
  where the RobotWare version cannot be read that way, and find a restarted
  controller among its own generation's VC processes.
- **License: MIT to Apache-2.0.** The whole `abb-rws-*` family is now Apache-2.0,
  which adds an explicit patent grant (section 3) and a trademark clause - both
  of which matter for industrial adoption and for contributors. Releases up to
  and including 1.3.1 remain available under MIT; this and later releases are
  Apache-2.0. Added `NOTICE`, `CONTRIBUTING.md` (DCO sign-off) and
  `TRADEMARKS.md`.
- **`RobotManager.stopRapid` and `setMotorsOff` no longer wait for access
  (behaviour change).** Both are safe-direction writes, and both used to
  request mastership (RobotWare 6/7) or control-station write access
  (RobotWare 8) before sending, so another client's hold refused the stop at
  this client's own acquire step - against the rule stated in 1.2.0 that a
  stop must never be blocked by mastership contention. They now send first.
  Only when the controller refuses because this session holds no access
  (`-1073445859`, `-1073445880`, and on RobotWare 8 `-1073435873` or
  `-1073435871`) does the manager request access through the controller's
  normal request, send once more and release right after; there is no second
  retry. Every other refusal is passed on unretried with its controller code,
  HTTP status and text, and the message now says:
  - who holds the access, when the controller says (RobotWare 8: the holding
    control station's name, never its id; RobotWare 6/7: the FlexPendant, the
    controller itself, or the remote client's application and user id), and
    to use the FlexPendant stop or the emergency stop;
  - for a stop refused for the logged-in user in Auto, both grants ABB's
    documents name ('Remote Start and Stop in Auto' and 'Execute program'),
    since the documents disagree on whether a stop needs one;
  - that a stop or motors off over RWS is not a safety function.
  A successful stop sends one request instead of three. Whether a stop and
  motors off are accepted with no hold at all is still to be observed on
  each generation; the send-first path is correct either way. The adapters'
  own `stopRapid` and `setControllerState` never took access and are
  unchanged; their doc comments now say so (the RWS 1.0 one wrongly promised
  `AUTH_FAILED` for a missing hold).
- **Mastership and RobotWare 8 write access are counted per lock, and writes
  that take them run one at a time (behaviour change).** Every request and
  release of mastership (RobotWare 6/7) or control-station write access
  (RobotWare 8) now goes through one access manager per controller session:
  `RobotManager`'s wraps, the adapters' own wraps around a single write
  (`setSpeedRatio`, `resetRapid`, `startProductionEntry`, task activation,
  `restartController`, the motion and path supervision writes, and the RWS 1.0
  CFG instance, tool and work-object writes), `jog()`'s motion hold, and a
  caller's own `requestMastership`, `requestMastershipAll` and
  `requestWriteAccess`. Holds are counted per lock the controller really
  arbitrates - RobotWare 6: `cfg`, `motion`, `rapid`; RobotWare 7: `edit`
  (which `rapid` and `cfg` both name) and `motion`; RobotWare 8: the one write
  access. A request for a lock the session already holds sends nothing, and
  only the release that ends the last hold goes on the wire.
  - Before, each layer requested and released on its own, and RWS keeps no
    count - one release ends a hold however many requests came before it - so
    an inner release ended the outer hold. On RobotWare 8, where every domain
    is the one write access, a caller that took write access lost it to the
    first write it made (`setSpeedRatio`, a supervision write, a PP reset),
    and its own release was then refused with "does not have SPoC". On
    RobotWare 7 a caller's `rapid` hold ended the same way at the first
    `setSpeedRatio` or `resetRapid`.
  - The public request and release calls on `RwsClient`, `RwsClient2`,
    `RWS1Adapter`, `RWS2Adapter` and `RobotManager` are counted the same way:
    pair every request with one release. Two requests followed by one release
    now keep the lock, where that one release used to end it. A release with
    no request of the caller's to pair with is still sent when the session
    counts nothing on the lock, and is held back while an operation in
    progress holds it. `requestMastershipAll` counts every lock, and
    `releaseMastershipAll` ends the caller's all-domains hold (with none, every
    hold the caller took), releasing only the locks nothing else of the session
    still holds.
  - Writes that take access run one at a time per controller, first come
    first served, so two concurrent writes no longer interleave request,
    request, write, release, write. A write that waits more than 10 s for the
    one in progress is refused with `CONTROLLER_BUSY` ("another write to this
    controller is in progress") and not sent. `loadProgram` and
    `unloadModule` keep their turn for the whole sequence. A write that a
    `RobotManager` change handler starts while an operation runs waits for it.
  - `setOperationMode` to AUTO no longer sends a release after its own request
    was refused.
  - `jog()` inside a caller's hold on the motion lock takes no hold of its
    own, and its 2 s idle release ends only its own hold, never a caller's or
    an operation's on the same lock. `requestMastership('motion')` after
    jogging takes the jog's hold over; `releaseMastership('motion')` with no
    hold of the caller's still ends the jog's hold at once.
- **A lost hold is recorded instead of swallowed.** A release answered "not
  held" (RobotWare 8: `-1073435873`, "The control station does not have
  SPoC") used to be dropped with a trace line, on the reading that any write
  clears write access. A write does not clear it (live-verified 2026-09-27 on
  an RW 8.1.1 VC); that answer followed because the write's own release had
  already ended the hold. With holds counted, the same answer to the release
  of a hold the client still counted means the hold ended some other way -
  the FlexPendant, for one, can take write access back at any time - so it is
  now logged as a warning that the hold was lost, and the counted holds on
  that lock end: their later releases send nothing and the next write
  requests afresh. The release still resolves, since it runs in `finally`
  blocks. RobotWare 6/7's `-1073445880` ("The resource is not held by
  caller", in ABB's return-code lists but never observed here) is treated the
  same way, as is `-1073445872` ("already held by caller") on a request, which
  counts as held. When the controller re-issues the session cookie, the
  client's count of every hold taken on the old session ends and is logged as
  a loss, so the next write requests afresh; a `stopRapid` or `setMotorsOff`
  refused as not held while a hold was counted records the loss too.
- **Every write takes the access ABB documents for it (behaviour change).**
  Writes that took no mastership or write access at any layer now hold it
  around themselves, for that one operation, through the session's access
  manager - so a caller's own hold is reused and never ended, and a refused
  request fails the write before it is sent:
  - RWS 2.0 (RobotWare 7 `edit` mastership, RobotWare 8 control-station write
    access): `setRapidVariable`, `setModuleText`, `setModuleTextRange`,
    `modifyPosition`, `resetTaskProgramPointer`, `setUiInstructionParam`,
    `holdToRun`, `setBreakpoint`, `removeBreakpoint`, `ppPrevInst`,
    `ppNextInst`, `setPPToRoutineFromUrl`, `setNonMotionExecution`,
    `setKeylessMotorOn`, `loadModule`,
    `unloadModule`, `loadProgram`, `saveProgram`, `restoreBackup` and the CFG
    writes (`setCfgInstance`, `createCfgInstance`, `removeCfgInstance`,
    `loadCfgFile`, `saveCfgFile`). `startRapid`, `stepRapid`,
    `setExecutionCycle`, `setProgramPointer` and `setPPToCursor` now hold
    `edit` themselves too, as they already did through `RobotManager`.
  - RWS 2.0 `setActiveTool` and `setActiveWobj` hold both RobotWare 7 domains
    (`edit` and `motion`): ABB's page asks for mastership without naming the
    domain. The motion and path supervision writes now hold `edit` as well as
    `motion`, since ABB's RobotWare 7 page asks for mastership on all domains
    there; they used to take `motion` alone.
  - RWS 1.0 (RobotWare 6): RAPID mastership around `startRapid`, `resetRapid`,
    `setExecutionCycle`, task activation, `loadModule`, `unloadModule`,
    `loadProgram`, `setProgramPointer`, `startProductionMode`,
    `setRapidVariable` and `setUiInstructionParam`; CFG mastership around
    `loadCfgFile` and `saveCfgFile`; RAPID and CFG mastership around
    `restoreBackup`; and all three domains around `setNonMotionExecution`,
    whose page names no domain.
  - `RobotManager`'s CFG writes hold the configuration lock - CFG mastership
    on RobotWare 6 - instead of RAPID mastership, which configuration writes
    do not use. On RobotWare 7 and 8 nothing changes (`rapid` and `cfg` are
    the same lock there).
  - Unchanged on purpose: stop and motors off (sent first), the single-module
    save behind `getModuleSource`, file-service and I/O writes, backup create
    and the RobotWare 6 speed ratio take no access, as ABB documents none or
    it was observed not to be needed.
  - Where ABB's documents name no domain or disagree (the CFG writes on
    RobotWare 7 and 8, keyless motors-on, the RobotWare 7
    UI-instruction answer and tool/work-object writes, and on RobotWare 6 the
    program load, CFG file load, UI-instruction answer, restore and
    non-motion execution), the hold taken is the stricter reading until a
    live run shows what the controller checks. README "Access each write
    takes" lists every write.
  - What changes for callers: a write on RobotWare 8 now registers the
    control station (once per session) and requests and releases write
    access around itself, three requests where it sent one, and a write that
    another holder blocks is now refused at the access request (for example
    `-1073435870` on RobotWare 8, `-1073445862` on RobotWare 6/7) rather than
    by the write itself. Writes that take access run one at a time per
    controller, so these writes now queue behind a write in progress.
- **RobotWare 7.8 and later: the edit-mastership watchdog is reset while the
  client holds edit mastership (behaviour change).** ABB's RWS 2.0 Mastership
  service says edit mastership "is only valid for a period of time" and
  offers `POST /rw/mastership/watchdog` to start that period again; ABB's PC
  SDK documents the matching heartbeat from RobotWare 7.8: with the HeartBeat
  `Select` set, when a holder misses it during program execution, execution
  stops and the controller goes to motors off. That the RWS watchdog is this
  heartbeat is inferred; ABB does not say so. Nothing in this client reset it
  before, so a hold kept across a long operation relied on the controller not
  enforcing it.
  - `RwsClient2` (and so `RWS2Adapter` and `RobotManager`) now sends that
    reset every `min(Timeout / 2, 1 s)`, never faster than every 100 ms, from
    the moment the first hold on `edit` is taken (`requestMastership('rapid'
    | 'cfg')`, `requestMastershipAll`, or any write that holds it) until the
    last one ends, the session is re-issued or the client disconnects. A hold
    shorter than one interval sends none. `motion` holds, RobotWare 7 before
    7.8, RobotWare 8 and a client whose version is not known yet (no
    `connect()`) send none.
  - The interval comes from the HeartBeat configuration
    (`GET /rw/cfg/SYS/MASTER_BOOL/instances/HeartBeat`: `Select`, `Timeout`
    in ms), read once per connection just after the first `edit` hold; if it
    cannot be read, ABB's documented default Timeout of 2000 ms applies. The
    client only reads this configuration and never writes it: it decides
    whether a silent holder stops program execution and switches the motors
    off, which is the cell integrator's setting.
  - A reset the controller refuses (any HTTP error status but 503 and 429),
    or no accepted reset for longer than the Timeout (resets that did not get
    through, or one accepted too late), loses the hold, reason `watchdog`
    (see "Lost holds are detected" below). Whether the controller then ends
    the hold is not documented and has not been observed, so the client stops
    relying on it and releases edit mastership once, to be sure. A reset that
    did not get through (a network error, a timeout, a busy controller) while
    the Timeout has not run out is logged as a warning that edit mastership
    may be at risk, once until a reset is accepted on time again; the hold
    stays counted.
  - `resetMastershipWatchdog()` is still available for a hold the client
    does not count (`requestMastershipWithId`). On RobotWare 8, which has no
    mastership service, it now throws `UNSUPPORTED_OPERATION` without sending
    once `connect()` has read the version, and a 410 answer is reported as
    `UNSUPPORTED_OPERATION` (it was `GRANT_DENIED`, whose advice about RMMP
    and UAS grants did not apply).
- **Lost holds are detected and reported, and never restored behind the
  caller's back (behaviour change).** A hold this session counted can end
  without this client releasing it. The client used to keep counting such a
  hold and to rely on it; it now records the loss, logs it as a warning,
  reports it (`RobotState.access`, `RobotManager.onAccessEvent`, see Added) and
  stops counting it. A hold is lost when:
  - a write made under it is refused as not held (`-1073445859`,
    `-1073445880`, and on RobotWare 8 `-1073435873` or `-1073435871`) -
    reason `unknown`. This covers every write that takes access, `jog()` and
    the switch to Auto; the refusal itself is passed on unchanged;
  - `RobotManager` sees the operating mode change (a poll or a subscription
    event; the first reading after a connect is not a change). RobotWare 6
    and 7: every mastership hold is lost (`opmode`); ABB documents that a
    change between Auto and manual ends mastership on IRC5 in both directions
    and on OmniCore from Auto to manual, and the other direction on OmniCore
    is treated the same way. RobotWare 8, where ABB documents write access as
    persistent across a mode change: one `GET
    /rw/controlstation/writeaccess/status`; still this station - nothing
    changes; another station - lost (`holder-changed`, naming the station,
    never its id); nobody, or the read failed - lost (`opmode`);
  - RWS 1.0 signs in on a fresh session after a 401 that persists with a
    session cookie, or the controller sets a different `-http-session-`
    value (`session-reissued`; RWS 2.0 already did this for a new session
    cookie). That RWS 1.0 issues a new value only for a new session is
    inferred, as on RWS 2.0 where it is live-verified;
  - `RobotManager` disconnects after three failed polls (`connection-lost`,
    not `released`: the release could not be confirmed);
  - the RobotWare 7.8+ watchdog lapses (`watchdog`, above).
  After a loss, every hold on that lock ends and its release sends nothing.
  The operation that held it sends no further access request: its next step
  that needs access fails with `MASTERSHIP_REQUIRED` ("... was lost during
  this operation"), where it used to request the access again in the middle
  of the sequence. The next operation requests afresh, and the controller
  decides. After a mode change or a lapsed watchdog, where the controller may
  still count the lock as this session's, the lock is also released once, to
  be sure (unless a hold was granted again meanwhile); a "not held" answer to
  that release only confirms the loss.
- **`RobotManager.requestRmmp` waits for the operator (behaviour change).**
  RMMP (Request Manual Mode Privileges) is ABB's manual-mode counterpart of a
  mastership request, granted by an operator at the FlexPendant.
  `requestRmmp` used to send the request and return, and nothing polled it,
  so ABB deleted it after 10 s. It now sends the level asked for:
  `privilege=modify` (the default) or `privilege=exec`, ABB's two documented
  values; `exclusive` is a deprecated alias sent as `exec`, and any other
  level is refused with `INVALID_ARGUMENT` before sending. The controller
  decides. It polls every second (`pollMs`, 250 to 5000 ms), and resolves
  `{ outcome, privilege, detail }`: `granted` once the privilege reads as this
  session's, `denied` when the controller reports a denial, `expired` when
  `waitMs` (default 30 s) runs out or the request ends without a grant,
  `cancelled` when `signal` aborts. On `expired` and `cancelled` the request
  is cancelled. `onPending` fires once the request waits, so a user interface
  can say so. Before sending: the operating mode is not read, so on RobotWare
  7 outside MANR the request is sent and the controller's refusal is passed
  on as `rmmp-wrong-mode` (ABB: "Can be performed in MANR mode only"); a
  privilege this session already holds that covers the level asked for
  (`exec` covers `modify`) is reported `granted` with nothing sent; `exec`
  asked for while this session holds `modify` resolves `held-lower` with
  nothing sent, and its `detail` says to call `cancelRmmp()` first; a second
  request while one waits is refused (`CONTROLLER_BUSY`).
  `cancelRmmp()`
  stops a wait in progress, and `disconnect()` cancels a wait or a granted
  privilege before logging out. A refused request is passed on as the
  controller answered it.
- **RMMP reads report what the controller said (behaviour change).** A failed
  `getRmmpPrivilege` or `pollRmmp` read is thrown; it used to read as `none`
  ("no privilege held") for any error on RWS 1.0 and any HTTP 500 on RWS 2.0,
  and `RobotManager.jog` then raised a new pendant request. An answer without
  a privilege or status is a `PARSE_ERROR`. The privilege reads lower-case
  (`none`, `pending modify`, `modify`, `exec`, ABB's values; `None` used to
  come through as is). `requestRmmp('exclusive')` on the adapters sends
  `privilege=exec`: `exclusive` is on no ABB page, and is kept as a
  deprecated alias.
- **RobotWare 8: no RMMP call is sent (behaviour change).** ABB lists RMMP as
  not supported from RobotWare 8.1 on, and RobotWare 8 has no mastership for it
  to lead to. On a controller known to be RobotWare 8, `getRmmpPrivilege` and
  `pollRmmp` return `unsupported` and `requestRmmp` and `cancelRmmp` throw
  `UNSUPPORTED_OPERATION`, all without a request; the message names
  control-station write access and Remote Access at the FlexPendant instead
  of calling the service broken. Before the generation is known, the controller's
  "service not supported" answer (500 `-1073445885`) or a 410 reads as
  `unsupported` too.
- **Jog sends exactly ABB's jog form, with the controller's change count
  (behaviour change).** ABB's jog form, the same on both generations, lists
  `axis1`..`axis6`, `ccount` and `inc-mode`. The adapters' `jog` used to send
  `jogmode`, `mechunit` and `cjogspeed` as well, and a private counter as
  `ccount` (1, 2, 3...), where ABB's rule is the controller's current
  motion-system change count, so a first jog sent 1 against the count of 0
  our virtual controllers read. Each jog now reads `GET /rw/motionsystem`
  right before and sends its `change-count`; a missing count is a
  `PARSE_ERROR` and nothing is sent. `inc-mode` is sent from the new `incMode`
  (`'Small' | 'Medium' | 'Large' | 'User'`, default `'Small'`, the smallest
  increment). `mode`, `speed` and `mechunit` are still accepted but not sent:
  the controller jogs the unit selected for jogging, in that unit's jog mode,
  at its own jog speed. A named `mechunit` that the controller does not have
  selected is selected first (`setMechunitForJogging`); the motion system is
  read again, and the jog goes out only if the controller then names that
  unit (`INVALID_ARGUMENT` otherwise, nothing jogged).
- **`RobotManager.jog` is sent in any mode and the controller decides
  (behaviour change).** Inside the write turn it reads, fresh from the
  controller instead of from the last poll, the operating mode and the
  controller state, and on RobotWare 8, once write access is held, the
  station's motion-control declaration. None of them is required: the jog is
  sent in Auto and in RobotWare 6 MANF, with the motors off, and on RobotWare
  8 with motion control off. What was read only explains a refusal of the jog
  request itself (a refused motion-system read or unit selection before it
  keeps its own explanation) that the controller does not explain more
  specifically: outside a
  manual mode, or on RobotWare 6 in MANF (where ABB's IRC5 manual disables
  jogging), `WRONG_MODE` naming the mode read; with the motors off,
  `MOTORS_OFF`; on RobotWare 8 with motion control off, the
  `motion-control-off` refusal. A refusal the controller explains (a
  mastership or write-access refusal, the local-client rule) keeps its own
  explanation, and on RobotWare 6 and 7 a refusal in manual mode carries
  ABB's jog-page rule: a local client with mastership, which RMMP does not
  make a remote tool. `jog` checks no RMMP privilege and no longer sends an
  RMMP request itself; the pendant dialog is raised only by `requestRmmp`. On
  RobotWare 8 no RMMP call is made (it used to fail there before any jog).
  The motion-control declaration is ABB's confirmation that an emergency stop
  and a normal stop are available at the station, made only by a person
  (`setAllowMotionControl`); the client never makes it.
- **Refusal messages say what is missing and who can supply it (behaviour
  change).** Every access refusal's message is now a plain sentence - the
  missing condition, who can supply it and what they do - followed by the
  controller detail (`Controller: HTTP <status> from <METHOD> <path>, code
  <dec> (<hex>, <ABB name>): <controller text>`), which keeps the "HTTP
  <status> from <METHOD> <path>" phrase earlier messages carried. The fixed
  `GRANT_DENIED` text that advised RMMP at the FlexPendant or a UAS grant
  under "RobotStudio > UAS" for every refusal is gone: RMMP is advised only in
  manual mode on RobotWare 6 and 7, never in Auto, on RobotWare 8, for a signal
  write or for a missing option, and a missing grant names its identifier,
  its RobotStudio name ("probably" where the two are paired by name only) and
  the RobotStudio path from ABB's operating manual. A refused mastership or
  write-access request names the holder with one status read (RobotWare 8:
  the station name, never its id). The error code changes for these
  controller answers:
  - a 403 with no controller code, or a code this client does not know:
    `UNKNOWN` (was `GRANT_DENIED`), with the controller's text and no advice;
  - HTTP 410 Gone (the RobotWare 8 mastership paths, RMMP from RobotWare
    8.2): `UNSUPPORTED_OPERATION` (was `GRANT_DENIED` or `UNKNOWN`);
  - "Option is missing" (`icode -7301`) and "Functionality is not supported
    on the current platform": `UNSUPPORTED_OPERATION` (was `GRANT_DENIED`);
  - `-1073445806` "not allowed in current controller state" (the RobotWare 8
    motors-on refusal, which asks for the Reset at the controller):
    `WRONG_MODE` (was `GRANT_DENIED`);
  - `-1073435872` "External Control Enable is not set" (Remote Access off):
    `MASTERSHIP_REQUIRED`; `-1073445800` (RMMP needs MANR), `-1073445860`
    (mode) and `-1073435895` (manual only): `WRONG_MODE`; the local-presence
    codes `-1073445868`, `-1073445875`, `-1073445810` and `-1073435856`:
    `UNSUPPORTED_OPERATION`; `-1073445873` (not logged on): `SESSION_EXPIRED`;
    `-1073445827` (invalid grant name) and `-1073445879` (invalid argument, for
    example a control-station PIN the controller refuses): `INVALID_ARGUMENT`;
    `-1073445880` (not held) and `-1073445845` (external client controls
    motion): `MASTERSHIP_REQUIRED`; `-1073445863` and `-1073445870` (RMMP
    denied, no such request): `GRANT_DENIED`. Each was unmapped and took the
    HTTP fallback.
  - `-1073414146` "Unspecified error" (RobotWare 6's generic outer code) is
    explained by the inner code in its message; without one, a 403 is no
    longer reported as "Resource does not exist" (404 and 400 keep
    `RESOURCE_NOT_FOUND`).
  A write refused as not held while the operation's hold was counted now
  reports the loss (`refusal.kind` `lost`) instead of "not held".
- **`-1073445865` (SYS_CTRL_E_BUFFER_OVERFLOW) is now `INVALID_ARGUMENT`.**
  A RAPID value write too large for one request (7900 num elements on RW
  7.21.4 and 8.2.1, live-verified 2026-09-29) answers HTTP 500 with this code
  and was `UNKNOWN`. The message now begins "Too much data for one RWS
  request" and keeps "HTTP 500 from POST ...".
- **`-1073436654` (SYS_CTRL_E_POSE_OUTSIDE_REACH) is now `INVALID_ARGUMENT`
  with an `invalid-argument` refusal.** A pose the robot cannot reach was
  `UNKNOWN` with no refusal; the message now says the position is outside the
  robot's reach and keeps "HTTP 400 from POST ...".
- **A RAPID start refused because motion mastership is held is typed.** The
  controller answers HTTP 500 `-1073445844` with the untranslated text
  "org_code: -2302" when any session - the caller's own included - holds motion
  mastership; it fell through to `UNKNOWN`. It is `MASTERSHIP_REQUIRED` with a
  "release motion mastership first" message (retcode dictionary:
  `SYS_CTRL_E_RESOURCE_MOTION_HELD_REJECT`). Live 2026-09-15 on RW7.21.
- **`createClient` and `createAdapter` log in once and never switch accounts
  (behaviour change).** When no `username` was given and the controller
  refused the default `Admin`, both factories logged in again as
  `Default User` without telling the caller. The account that is logged in
  decides which UAS grants apply, so that silent switch changed what the
  client was allowed to do. A refused login now throws `AUTH_FAILED` naming
  the host, the port and the user tried (never the password), with the
  client's own message kept; when no username was given, the message says the
  default `Admin` was used and asks for the account to use. A refused default
  login is now one login attempt at the controller instead of two.
  `RobotManager` always logs in as the user it is given and is unchanged.
- **`RwsClient` and `RwsClient2` refuse requests after `disconnect()`
  (behaviour change).** From `disconnect()` until the next `connect()` every
  request throws `NOT_CONNECTED` and nothing is sent.
  Requests queued before `disconnect()` still
  go out first, and a second `disconnect()` sends nothing. A client that never
  called `connect()` is not affected.
- **`RobotManager.startRapid` no longer moves the program pointer (behaviour
  change).** Whenever the program was stopped, it set the program pointer
  back to the routine of the last `setPPToRoutine` before starting, ignoring
  a failure, and on the active task whichever task the routine had been set
  for. A Start after a Stop in the middle of that routine therefore ran it
  again from its top instead of continuing. `startRapid` now sends the start
  only, and execution continues from the program pointer. To run a routine
  from its start, call `setPPToRoutine` and then `startRapid`.
- **`RobotManager.setPPToRoutine`, `unloadModule` and `loadProgram` no longer
  stop a running program on their own (behaviour change).** Each sent a stop
  first and ignored its failure. Each now reads the RAPID execution state
  inside its hold. While the program runs, the call is still sent (ABB lists
  no execution-state prerequisite for these operations) and the controller
  decides. An execution-state refusal of the step that changes the program
  (-1073442809), or a 400 or 403 the controller leaves unexplained, is
  explained as the running program: `WRONG_MODE`, `refusal.kind`
  `wrong-state`, `grantor` `this-tool`, with the way to stop it first; that
  explanation's `evidence` is `unverified`. Any other refusal, a mode refusal
  (-1073445860) among them, keeps the controller's own explanation. With the
  new option
  `{ stopIfRunning: true }` the program is stopped first, and a stop the
  controller refuses fails the call. A stopped program gets no stop request.
- **`RobotManager.loadProgram` reports every failed step (behaviour change).**
  Three steps were ignored when they failed: a module list that could not be
  read counted as "no module loaded", a refused unload of the loaded module
  with the same name was followed by the load anyway, and a refused program
  pointer reset to main left the pointer where it was without a word. Every
  step's failure now fails the call. The error keeps that step's code, HTTP
  status, controller answer and refusal; its message, and the refusal's
  sentence, start with the step that failed and what had already been done -
  for example that the old module was unloaded and the new one did not load,
  or that the module was loaded but the program pointer was not moved. The
  new option `{ resetPP: false }` leaves the program pointer alone; by default
  it is still set to main when the module declares `PROC main()`. A local
  file that cannot be read now throws `INVALID_ARGUMENT` before anything is
  sent; it used to be Node's own error, thrown after access was requested.
- **RWS 2.0 `activateAllRapidTasks` and `deactivateAllRapidTasks` report
  refused tasks (behaviour change).** RWS 2.0 has no all-tasks action, so the
  client sends one request per task. A refused task was dropped and the call
  resolved, so a caller reported every task activated when some were not.
  Every task is still sent; when any was refused, the call now throws one
  `RwsError` with the first refused task's code, HTTP status, controller
  answer and refusal, and a message naming the tasks that were done and each
  refused task with the controller's reason. A refusal as "not held" ends the
  loop at once: the hold is gone, the later tasks are not sent, and the
  message says at which task it stopped. ABB's RobotStudio operating manual
  says only Normal tasks can be activated and deactivated; how a controller
  answers the request for a background task over RWS 2.0 has not been
  observed, and such an answer is reported like any other refusal. RWS 1.0
  sends ABB's one all-tasks action and is unchanged.
- **`RobotManager` reads less of the event log on elog events.** Every
  domain-0 elog subscription event used to start its own whole log read (5-20
  pages on RWS 2.0). The whole walk took 12 pages and 1.6-2.1 s on RW 7.21.4
  with 548 messages in domain 0, and delayed a speed-ratio event that arrived
  during it by 1.1-1.5 s.
  - An event now reads only the newest page and merges it into the held log
    by sequence number: on RWS 2.0 one newest-first page (`v=2.1`, 50
    messages), on RWS 1.0 the same single request as a whole read, whose
    first page is already the newest messages. The whole log is still read
    after connect, on the slow poll, when the newest page does not reach back
    to the messages already held (more new messages than one page), and for
    the rest of the connection when the controller refuses the newest-first
    read.
  - Reads are coalesced: one read in flight and at most one queued follow-up,
    however many events arrive, so a controller that floods the log - ABB's
    7.21.1 notes correct a "spamming of elog 36500" - no longer keeps the
    manager re-reading continuously.
  The poll-generation pin that keeps a late log off a disconnected or
  different controller is unchanged; a read that outlives a disconnect no
  longer delays the next connection's event-driven reads.
- **`jog()` with a named `mechunit` selects it first.** When the controller
  does not have that unit selected, `jog()` selects it, reads the motion
  system again, and jogs only if the controller then names that unit
  (`INVALID_ARGUMENT` otherwise). It used to refuse and ask for the unit to be
  selected at the FlexPendant. The selection stays in place afterwards
  (documented). The comparison with the controller's selection ignores case,
  so a different spelling of the selected unit writes no selection. Unit
  names must be RAPID names (letter first, then letters, digits or
  underscores); `.`, `..` and other path-like names are refused before
  anything is sent. On RWS 2.0 a name that matches a motion-system resource
  (`jog`, `mechunits`, `errorstate` and others) is refused before the
  motion-system read, and `RobotManager.jog` refuses it before the
  pre-flight.
- **Documentation** (no behaviour change):
  - **README "Finding controllers" rewritten around `findControllers`**: the
    sources and their defaults, the `identify` table, the port tables, "What
    discovery sends" (per-host connection counts, pacing, the cost of a /24, and
    a plain note that company IT can see a range scan's connection attempts) and
    "What discovery runs on your PC". Corrected: discovery finds the controllers
    that answer on the ports and hosts you allow (not "every reachable
    controller"); port 80 serves either scheme; RobotStudio VCs and, by ABB
    default, OmniCore controllers use self-signed certificates; a VC announces
    itself over mDNS only when a Bonjour responder runs on its PC; the auto port
    discovery text matches `KNOWN_RWS_PORTS`.
  - **The RWS 1.0 operating-mode acknowledge is left out on purpose.**
    RobotWare 6.16.03 offers the form (`POST /rw/panel/opmode?action=acknowledge`),
    but confirming a change of operating mode is the person's confirmation at
    the FlexPendant, so `RWS1Adapter` never sends it: it has no such
    method, and the path table records the form as a deliberate gap. The
    README's panel notes say so, and no longer list `acknowledgeOperationMode`
    among the optional `IRWSAdapter` members (it is on `RwsClient2` only).
  - **Speed-ratio notes corrected.** RWS 2.0 accepts the documented plain
    `POST /rw/panel/speedratio` with `speed-ratio=N` (204) and ignores the
    `?action=` query (`?action=nosuchaction` also answers 204); the 400 came
    from the field name `speedratio`, which fails with or without the action.
    Verified 2026-09-27 on RobotWare 7.21 and 8.1.1. The request the client
    sends is unchanged and works; the path-table, mapper and method comments no
    longer claim the plain POST fails or that OmniCore requires the action.
    README's `setSpeedRatio` bullet says so too.
  - **Signal search: the `name` criterion is documented as a case-insensitive
    prefix match, not a substring match.** The doc comments, the path table and
    the README said "substring" since 1.2.0 (the RWS 2.0 search; 1.3.0 repeated
    it for the RWS 1.0 form); on RobotWare 6.16, 7.21 and 8.1.1 virtual
    controllers (2026-09-27) `name` matches the start of the name only and
    ignores case (`IIO_do` finds IIO_do1..8, `IIO_DO8` finds IIO_do8, `do8`
    finds nothing), `device`, `network` and `category` match whole values
    (`device=IntegratedIO` finds nothing where `IntegratedIOInternalDevice`
    finds 26; device and category ignore case), there is no glob or regex,
    criteria AND-compose, and no criteria at all returns every signal. No
    request changed; only the wording and the recorded evidence, in the RWS 1.0
    and RWS 2.0 mapper comments, `IRWSAdapter`, the path table and the README.
    The comments also note that ABB's RobotWare 7.3.1 release notes (in the
    RobotWare 7.3.2 document, section 3.1 Incompatibilities) say RobotWare 7
    does not set a signal's Category by default - a statement ABB makes about
    the FlexPendant IO app - so a `category` criterion finds only signals whose
    Category was configured.
  - **`/ctrl/safety/config/startupstatus` is noted as new in RobotWare 7.20**,
    together with `/ctrl/safety/config/changecount` (ABB's 7.20.0 release notes
    §1.2, "RWS APIs for Safety controller functions"); changecount has no
    path-table row until it is probed live.
  - README "Session Persistence": reuse a saved session cookie only with the
    credentials that created it. `docs/ARCHITECTURE.md` describes the session
    file's `host:port#<verifier>` key and the entry a disconnect removes.
  - README: a "Functional tests" section (what `npm run functional` does, what
    it needs, how it keeps the virtual controllers safe, and its environment
    switches).
  - README and `CONFORMANCE.md` wording: exact surface counts (312 public
    `RwsClient2` methods, 226 `IRWSAdapter` methods) and the one deliberate
    conformance gap (`/ctrl/options`) named.
  - `setAllowMotionControl` (RW8) is exposed but not sequenced by `RobotManager`
    before a start; enabling motion control is the caller's job.
  - README reference tables follow the changes above: writing a signal by name
    on each generation, the per-task reporting of `activateAllRapidTasks` and
    `deactivateAllRapidTasks`, and the error codes' new cases
    (`MASTERSHIP_REQUIRED` for a hold lost during an operation, `WRONG_MODE`
    while the program runs, `CONTROLLER_BUSY` for a write that waited too long
    for another write).
  - README: `getEventLog` lists newest first on RWS 1.0 but oldest first on
    RWS 2.0 by default (newest first needs the `'newest'` order argument).
  - Doc comments re-checked against RobotWare 6.16.03, 7.21.4 and 8.2.1 virtual
    controllers (2026-09-29): the control-station id rule (every 38-character id
    tried registered and other lengths were refused, the character set was not
    tested; the braced GUID stays the client's own rule, and its refusal
    messages now say so), `SignalSearchExCriteria.invert`
    (it negates its own criteria set), `SystemInfo.startTime` (controller local
    time, not a restart marker), the RWS 1.0 `%24` volume encoding (accepted),
    `v=2.1` (documented in the RWS 2.0 reference, and also accepted by `/ctrl`
    and the opmode lock-state), and the WebSocket and subscription-group notes.
- **`npm run conformance` reaches below `/rw` and counts resource families.**
  The crawler follows the base link each answer declares (it used to resolve
  links against the request path and never got below `/rw`), so the 2026-10-03
  counts (59 implemented / 1 gap / 0 unmapped) covered `/ctrl`, `/users` and
  `/uas` only. Below `/rw` most nodes are instances (one per hardware device and
  device property under `/rw/devices`, per RAPID task, mechanical unit, axis,
  I/O network and device), so each node is now counted once with its family,
  instance names as parameters; a family is claimed by the most specific table
  entry, or by a claim with the methods that read it (`/rw/retcode` via
  `getReturnCode`, the `/rw/devices` tree via `listSystemDevices` /
  `listControllerDevices`) or the reason it is a gap (RWS 1.0 `/rw/rim`, the
  RobotWare installation service). `CONFORMANCE.md` gives the counts per
  RobotWare build: build string, node and family counts, and the crawl's
  completeness (nodes probed, deadline or node cap hit, `/rw/system` read
  again after the walk). Each controller gets its own 20-minute budget and
  2000-node cap (`CONFORMANCE_DEADLINE_S` overrides the deadline);
  `--ports a,b --gap 60` crawls only the named ports, one at a time, and
  `--carry-from <crawl.json> --carry <build>` keeps an earlier crawl of a
  build that is not running (`--not-crawled` names the builds left out). A
  walk stops after three reads in a row go unanswered instead of running to
  its deadline. The crawler refuses any method but GET and OPTIONS and spaces
  its requests 100 ms apart, as the client does.

- `setVirtualTimeScale` is not sent on RobotWare 6: the client sends no
  virtual-time write there in this release, although ABB's RWS 1.0 documents
  the speed write for virtual controllers.

#### Deprecated

- `setVirtualTimeRunning` on both generations (`RobotManager`, `IRWSAdapter`,
  `RWS1Adapter`, `RwsClient2`): it sends nothing and throws
  `UNSUPPORTED_OPERATION`. Pause and resume the virtual clock from
  RobotStudio's Simulation tab. It stays until the next major version, so
  code written for 1.3.x still compiles.

#### Fixed

- **`getMotionPointer` and `getProgramPointer` read `begposition` as well as
  `beginposition`, on both generations.** RW 6.16.03 and 7.21.4 virtual
  controllers send the start as `begposition` in the motionpointer entry, so
  the motion pointer had a module and a routine but no `row` or `col`. With
  the fix both read row 9 col 16 while a MoveAbsJ ran. `beginposition` is
  still read first: ABB's Rev M example keeps the start there and puts a
  `begposition` span where the end goes. The module is read under
  `modulename` or `modulemame`, as before.
- **RWS 2.0 `getUasRoleDescription` reads class `group-description`.** RW
  7.21.4 and 8.2.1 virtual controllers answer with that class, where ABB's
  example shows `role-description`, so the read was `PARSE_ERROR`. Both
  classes are read; an answer with neither is still `PARSE_ERROR`. With the
  fix both read the Administrator role's description.
- **RWS 1.0 `getEnv` reads the value under `_value`.** A RW 6.16.03
  virtual controller answers `?json=1` with the `ctrl-env` value under
  `_value`, which the client dropped, so the read was `PARSE_ERROR`. A
  `value` span is still read first. With the fix `TEMP`, `HOME` and
  `BACKUP` read there.
- **Known limits check (2026-10-18).** Every Known-limits line, path-table
  summary and doc comment was checked against ABB's RWS 1.0 (Rev M) and
  RWS 2.0 (Rev L) documentation and the logged answers.
  - `getMotionPointer` reads the motion pointer. On both generations it now
    reads the entry ABB titles `motionpointer` in
    `GET /rw/rapid/tasks/{task}/pcp`, the resource the program pointer comes
    from. RWS 1.0 used to read the task's `/motion` link directory and RWS
    2.0 the task's motion-pointer sync state; neither holds a position, so
    the result had no row. While the controller reports no position (no
    program started) the result is `{}`. `RwsClient2.getMotionPointer` no
    longer fills `state`. With the `begposition` read above it read row 9
    col 16 on RW 6.16.03 and 7.21.4 virtual controllers. The row stays
    `built`: it sends the same request as `getProgramPointer`, whose answer
    carries this entry with no position when no program has started, and
    the logs keep no answer body, so a logged 2xx does not show that a
    position was read.
  - RWS 2.0 `restoreBackup` keeps the backup. ABB's RWS 2.0 restore form
    defaults `delete-dir` to true, as RWS 1.0's does, so a restore deleted
    the backup it restored. The client now sends `delete-dir` on both
    generations: false unless `{ deleteBackup: true }`.
    `RwsClient2.restoreBackup` takes the same optional argument, and
    `RobotManager` passes it through. Not yet run against an RWS 2.0
    controller.
  - A RobotWare 8 RAPID start refused for the motion-control declaration is
    explained. The controller's -1073435864
    (SYS_CTRL_E_NOT_ALLOWED_TO_MOVE_ROBOT, "Control Station has not Motion
    Control enabled") was `UNKNOWN` with "gave no reason". It is now
    `GRANT_DENIED` with `refusal.kind` `motion-control-off`, as the jog's
    refusal already was, on every call that gets it (`startRapid`,
    `stepRapid`, `startProductionEntry`, hold-to-run, jog). The sentence
    names `setAllowMotionControl(true)`, which only a person makes; the
    client never makes the declaration on its own.
  - RWS 1.0 sends nothing to three paths ABB does not document.
    `listSafetyZones` answers `[]` without a request, and
    `runCyclicBrakeCheck` and `triggerVisionJob` throw
    `UNSUPPORTED_OPERATION` before sending, as on RWS 2.0. Their path rows
    record the RWS 1.0 side as a gap. The `RobotManager.triggerVisionJob`
    refusal for an adapter that takes no job name no longer says that RWS
    1.0 triggers the active job.
  - Known limits, "Open at this release": the built lists now say which of
    their operations are live on the other generation (computed from the
    path tables). The RobotWare 6 line separates what ABB's RWS 1.0 has no
    operation for (`removeBreakpoint`, a per-task program-pointer reset, a
    whole task-selection write, `callServiceRoutine`) from what ABB documents
    and the client does not wrap yet (`modifyPosition`, `registerUser`,
    `impersonateUser`); virtual time on RobotWare 6 is a hold of this
    client, not a missing ABB write; `setTaskSelection` is refused on both
    generations, with task activation as the way; the clock write got 405
    from the RobotWare 6.16.03 virtual controller too; the module name clash
    was seen once, on RobotWare 7.21.4.
  - Known limits, from the 2026-10-18 virtual-controller session: on
    RobotWare 8.2.1 a RAPID start needs the session's motion-control
    declaration, also for a program that does not move the robot, and a
    second session under the same station name reads it as false; a 7.21.4
    virtual controller refused RMMP `exec` also with Enable held at the
    virtual FlexPendant, `exec` asked while `modify` is held sends nothing
    (`held-lower`), and a granted `modify` was still held after 180 s; an
    8.2.1 virtual controller in guard stop accepted an operating-mode switch
    both ways (the client reads no controller state first).
  - Path-table summaries and gap texts: `lockOperationMode` and
    `unlockOperationMode` lock the operating-mode selection, not a key
    switch; `disableExternalControl` is for the local control station only
    (RW 8.2.1 answered a remote one 403 -1073435869);
    `setMotionSupervisionMode` is ABB's jog supervision mode;
    `saveSystemInfo` copies the system's installation files (real
    controllers only); `registerUser` is a session registration and leaves
    the "UAS writes" list, since it changes no UAS data; `impersonateUser`,
    `getCompatibility` (RWS 1.0 sends `/ctrl/compatible`, a path in no ABB
    page, and answers `compatible: false` on any error), `getRoutingTable`
    (a path ABB does not document), `getSyslog` (ABB's
    `text/plain;v=2.0` was not among the Accept values tried),
    `tpuDetach`, `tpuScreendump`, `ctrlOptionsVerify` (the bare
    `/ctrl/options` carries no option list; ABB's per-option check is not
    wrapped), `listSafetyZones`, `runCyclicBrakeCheck`,
    `setVirtualTimeScale` and `setTaskSelection` say what ABB documents
    and what the client does.
  - Doc comments: `IRWSAdapter.listControllerOptions` reads
    `/rw/system/options`, not `/ctrl/options`; the RWS 1.0 `requestRmmp`
    is live: `modify` was granted at the FlexPendant on a RobotWare 6.16.03
    virtual controller in manual mode (only `modify` was asked for), the
    evidence index now reads the client's text trace that logged it, and the
    method joins `IRWSAdapterCore`; `UserRegistration.locale` names ABB's values
    (`local`, `remote`) and that ABB marks the field required.
  - `RobotManager.registerUser`, `impersonateUser` and `modifyPosition` on
    RobotWare 6 throw the same `UNSUPPORTED_OPERATION`, now saying that this
    client has no RWS 1.0 form although ABB documents one (it said "RWS 2.0
    only").
  - `CONFORMANCE.md` and `docs/conformance/map.json` are rebuilt from the
    last crawl (offline, `--no-crawl`): RWS 1.0 `/rw/rapid/taskselection` is
    now claimed by `getTaskSelection`, and the README's conformance line
    gives that crawl's counts (it quoted an older crawl that stopped above
    `/rw`).
- **Traced pass (2026-10-18, RW 6.16.03, 7.21.4 and 8.2.1 virtual
  controllers).** The evidence index is rebuilt with that run's client
  traces added; no earlier entry was dropped. Live from it:
  - RWS 2.0 reads: `getModuleChangeCount`, `getModuleSyncPersStatus`,
    `getModuleExtension`, `getProgramPointerSyncState`,
    `getMotionPointerSyncState`, `getSpyStatus`,
    `listInstructionCategories`, `listInstructions`,
    `getTaskStructuralChangeCount`, `getTaskChangeCount`,
    `getRegistryFile`, `getSafetyLoadStatus`, `getSafetyViolationInfo`,
    `getEnv`, and, as Admin, `listUasUsers`, `listUasRoles`,
    `isUasUserEnabled`, `getUasUserDescription`, `listUasRoleGrants` and
    `getUasRoleDescription`. The index had also logged `getEnv` answers
    from an earlier RWS 2.0 probe.
  - RWS 1.0: `getTaskSelection`, `getEnv`, `setKeylessMotorOn` and
    `setMechunitBaseFrame`.
  - `getTaskSelection`, `getTaskStructuralChangeCount`, `listUasUsers`,
    `listUasRoles` and `listUasRoleGrants` join `IRWSAdapterCore`, and the
    methods of these rows lose `@experimental`. The README's RWS 1.0 Known
    limits list drops from 21 to 17 and the RWS 2.0 list from 48 to 28.
  - `getMotionPointer` stays `built` on both generations: it sends the same
    request as `getProgramPointer`, whose answer carries the motionpointer
    entry with no position when no program has started, so a logged 2xx
    does not show that a position was read. `getTaskChangeCount` shares its
    request with `getTaskStructuralChangeCount` too, but ABB gives both
    counters in that answer, `change-count` beside `struc-change-count`, so
    the index credits both.
- **Refusal wording (2026-10-17).**
  - A jog refused in Auto with the motors off says that jogging is done in
    manual mode at the FlexPendant (switch to MANR with the mode selector;
    the person there switches the motors on with the enabling device). It
    used to say "the motors are off. Switch them on first.", which does not
    make a jog possible in Auto. The code and `refusal.kind` (`wrong-state`)
    are unchanged.
  - Controller code -1073435886 (0xC004AB12, ABB's
    SYS_CTRL_E_OPERATION_IS_UNLOCKED, "OP-mode is not locked") on an unlock
    of the operating-mode selector is `WRONG_MODE` with a `wrong-state`
    refusal saying the selector is not locked, so there is nothing to
    unlock. It was `UNKNOWN`, with no explanation.
- **RobotWare 6 write run (2026-10-13, RW 6.16.03).**
  - `setUiInstructionParam` docs name the instruction's own parameters. A
    TPReadNum took `TPAnswer`, then `TPCompleted` = `TRUE`, and refused the
    old example `Result` (400 -1073445879). The controller lists the
    parameters at `GET /rw/rapid/uiinstr/active/params/{stackurl}`.
  - `saveProgram` refused with 500 -1073442812 is explained:
    SYS_CTRL_E_NO_PROGRAMNAME, `wrong-state`. No program name is set when
    only modules were loaded; load or name a program first.
  - A refusal whose text says an option "is not opted" is `option-missing`
    (`UNSUPPORTED_OPERATION`) and names the option. `setNonMotionExecution`
    was refused 403 with "Collision Detection is not opted during system
    setup" and used to be `UNKNOWN`.
  - A decompress of a file that is not a finished archive is
    `INVALID_ARGUMENT`, not `RESOURCE_NOT_FOUND`. `compressPath` on RWS 1.0
    resolves when the controller accepts the job (202), before the archive
    is done.
  - `listEventLogDomains` reports a count the controller does not give as
    `null`, not 0 (behaviour change: `events` and `bufferSize` are
    `number | null`). RWS 1.0 gives none.
  - RWS 1.0 `listBreakpoints` reads ABB's `start-row` and `start-col`. A
    breakpoint set at row 8 column 5 was read back as row 0. An entry whose
    row cannot be read is a `PARSE_ERROR` naming its fields.
  - New: `stepRapid` on RWS 1.0, ABB's start with
    `execmode=stepin|stepover|stepout`, under RAPID mastership. Built from
    ABB's RWS 1.0 page, not yet run. It leaves `IRWSAdapterCore` until it
    runs on RobotWare 6.
  - Mastership with an id and the mastership watchdog are n/a on RWS 1.0.
    `RobotManager` says so in an `unsupported` refusal.
  - Docs: on RW 6.16.03, `setModuleText` dropped RAPID mastership each time,
    so the release that followed was refused as not held. `setModuleTextRange`
    kept it.
  - Evidence: `setUiInstructionParam`, `startProductionEntry`, `compressPath`
    and `getActiveUiInstruction` are live on RWS 1.0. `getActiveUiInstruction`
    joins `IRWSAdapterCore`.
- **Refusal review (2026-10-13).**
  - A refused jog keeps the controller's own classified refusal. Motors off,
    motion control off and the operating mode are only hints, used for a
    refusal of the jog request itself that the controller does not explain
    more specifically.
  - The running-program explanation covers only an execution-state refusal
    (-1073442809), or an unclassified 400 or 403, of the step that changes
    the program; a mode refusal (-1073445860) keeps its operating-mode
    explanation. A missing module or routine, a bad argument and a holder of
    access are reported as the controller gave them.
  - A refusal the classifier has already explained (RMMP required, local
    client only, the operating mode) keeps its explanation while RAPID runs;
    it is no longer reported as the running program.
  - A jog is sent in any mode, including AUTO and RobotWare 6 MANF. An
    unexplained refusal is reported as `WRONG_MODE` naming the mode read.
    `requestRmmp` on RobotWare 7 outside MANR is sent, and the controller's
    refusal is passed on as `rmmp-wrong-mode`. `setPPToServiceRoutine` on
    RobotWare 8 in Auto is still held back before sending.
  - `setAllowMotionControl` called before `connect()` on RobotWare 8 is
    refused as not a control station; it now registers the session once and
    sends the request once more. RobotWare 7 never registers.
  - A message's `code:` annotation is no longer read from the end of
    `org_code:`.
- **acceptance step 6 (2026-10-13).**
  - RobotWare 8 `setAllowMotionControl` registers the control station first;
    an unregistered session was refused (403 -1073435871). New
    `RobotManager.setAllowMotionControl(allow)`, RobotWare 8 only. With it
    true, Reset and Enable at the pendant, RW 8.2.1 jogged: the first
    RobotWare 8 motion-tier 2xx.
  - A jog refused with -1073445860 in manual mode on RobotWare 6 and 7 is
    explained by ABB's local-client rule, not as a key-switch change.
  - The jog is sent when the motors read off, and on RobotWare 8 when motion
    control reads off; the controller decides, and a refusal keeps the
    motors-off or motion-control-off explanation.
  - `JogParams.axes` and the README say what the values mean: the direction
    of one jog step, not degrees.
  - `setPPToRoutine`, `unloadModule` and `loadProgram` are sent while RAPID
    runs (ABB lists no execution-state prerequisite for them); the controller
    decides, and its refusal is explained as the running program.
    `stopIfRunning: true` still stops the program first, and none of them
    stops it unasked.
- **acceptance step 5 rerun (2026-10-13).**
  - RWS 1.0: a refusal whose real code is only in the message's inner code
    (`icode`, or the hex `new_code`) is read by that code. PP to main in MANR
    on RW 6.16.03 was reported as RESOURCE_NOT_FOUND and, through
    `resetRapid`, as "task has no main routine"; it is now explained as the
    manual-mode program-pointer refusal. `resetRapid` says a task has no main
    routine only for a real 404.
  - The mode-selector lock and unlock refusals name the lock, not a mode
    change. On RW 6.16.03 both were refused for a missing option (403
    -1073445867); the RWS 1.0 path notes record it.
  - `setOperationMode` on RobotWare 8 with write access ran on RW 8.2.1; the
    docs record it.
- **Manual-mode behaviour checked against ABB's documents (2026-10-13).** No
  prohibitions of the client's own; the controller decides, and its answer is
  explained.
  - `setPPToServiceRoutine` no longer refuses by mode: ABB documents PP to
    routine for a remote client in Auto on RobotWare 6 and 7.
  - A program-pointer move refused in manual mode is explained per operation:
    RobotWare 7 allows PP to routine with RMMP exec (not modify) and never PP
    to Main; RobotWare 6 moves the pointer for a remote tool in Auto only.
  - The RMMP enabling-device refusal quotes the controller, says ABB does not
    say whose enabling device, and names what failed on virtual controllers;
    it promises no fix.
  - `setOperationMode` refusals name ABB's Local Client rule; the switch is
    verified on virtual controllers only.
  - The RMMP wait reads the privilege on every poll, understands the poll's
    code (294914 pending, 294915 granted), and says when the controller held
    the request and no local client answered it.
  - Messages name the controller by its `/rw/system` name, not the PC name a
    virtual IRC5 reports as controller name.
- **RMMP, from acceptance step 5 on RobotWare 7.21.4 in MANR (2026-10-12).**
  - A request the controller never reported as waiting is no longer reported
    as "no one granted": the expired result says the request never stood and
    names the last poll and privilege answers, and every answer is logged at
    trace level. As Admin the request never showed on the FlexPendant; as
    Default User it showed at once and was granted.
  - A program-pointer move refused with -1073445860 in manual mode on
    RobotWare 7 is explained as ABB's rule (a remote tool cannot move the
    program pointer in manual mode; RMMP does not cover it), not as a key
    switch change.
  - An RMMP request refused with -1073445800 in MANR names the enabling device
    as the missing part.
  - `RobotManager.requestRmmp` sends `exec` as well as `modify` (`exclusive`
    stays the deprecated alias of `exec`); the controller decides, and its
    refusal is passed through.
- **`RobotState.execCycle` follows `RobotManager.setExecutionCycle`.** The state
  kept the old cycle until the next full refresh: on RobotWare 6.16.03, 7.21.4
  and 8.2.1 it still read the old value 300 ms after a set the controller had
  logged (elog 10153, 2026-10-12). The manager now reads the cycle back once
  after a successful set and takes the controller's answer, with a change
  notification; a failed read-back leaves the state alone and does not fail
  the set.
- **`setOperationMode` holds control-station write access on RobotWare 8
  when called on `RwsClient2` or `RWS2Adapter` directly.** RW 8.2.1 refused the
  bare switch with 403 -1073435873 "User does not have write access", with and
  without the station registered (2026-10-12); `RobotManager` already held it.
  A hold the caller or `RobotManager` has is reused, so the manager still sends
  one request and one release. RobotWare 7 is unchanged. Of the other RWS 2.0
  writes sent without a hold, every one RobotWare 8 has answered did so with
  2xx and no write access held.
- **Eight RWS 2.0 request shapes corrected after the write run of 2026-10-11
  on RobotWare 7.21.4 and 8.2.1** (the controllers' recorded answers and ABB's
  RWS 2.0 Rev L documentation as the source; the evidence tags are as the logs
  say: `setExternalEmergencyStop` and `getActiveUiInstruction` are live on
  RWS 2.0 from that run, the others stay built):
  - `setExternalEmergencyStop` sends `state=on` (circuit closed) or
    `state=off` (circuit open, the stop is active), the values the
    controller's form lists and ABB's sample uses; `active` and `reset` were
    refused with 400 "Invalid state value" and now map to off and on.
  - `removeBreakpoint` sends `column`, as ABB documents; the controller's own
    form spells it `columno` and then refuses that spelling with 400 "Column
    parameter invalid or missing". `listBreakpoints` reads the documented
    `rap-program-breakpoint` entries (module-name, start-row, start-col); it
    read a guessed class and listed nothing.
  - `setTaskSelection` is a recorded gap on RWS 2.0: ABB documents only GET on
    `/rw/rapid/taskselection` and both builds answer a POST with 405. The
    client refuses with `UNSUPPORTED_OPERATION` naming the answer, sends
    nothing, and the README lists it under Unsupported.
  - `setControllerClock` keeps the documented `PUT /ctrl/clock`; ABB marks it
    "Supported only in RC", and a virtual controller answers 405. The row and
    the method say so.
  - `validateCfgInstances` refuses an `operation` other than 0 (add) or 1
    (delete) with `INVALID_ARGUMENT` before sending; the controller answers
    every word with 400 "Invalid operation parameter value".
  - `holdToRun` sends the plain `application/x-www-form-urlencoded` type on
    RobotWare 8, which answers the versioned type with 415 and names the plain
    one; RobotWare 7 keeps the versioned type.
  - `setPPToRoutineFromUrl` always sends `userlevel` (`false` unless asked),
    as ABB's sample does; the caller's `routineurl` is passed through as
    given, and ABB documents it as `/RAPID/{task}/{module}/{routine}`. Every
    form without `userlevel` was refused as "Invalid parameter"; the
    documented shape has not been sent to a controller yet.
  - `getActiveUiInstruction` (RWS 2.0) reads the documented `rap-uiactive-li`
    entry; it returned null for a running TPReadNum answered in hal+json.
- **Mastership taken with `requestMastershipWithId` is released on
  `disconnect()`.** The id is remembered by the session that took it and
  released with `release-with-id` before the logout; `releaseMastershipWithId`
  forgets it; a release the controller refuses at disconnect is logged and the
  logout still goes out. Before, nothing released such a hold at session end,
  and the method's documentation advertised a hold that outlives the session.
- **A request for mastership or write access that did not answer is no longer
  taken as refused.** On a `NETWORK_ERROR` the RWS 2.0 client reads once
  whether this station holds RobotWare 8 write access (by its registered
  station id): held, the hold is counted; not held, the error is passed on;
  the read fails, the lock is `uncertain` and an `uncertain` event goes out.
  RobotWare 7's mastership status carries a numeric user id the session cannot
  match to itself, so there the error is passed on as before. Before, a
  request the controller granted after the client stopped waiting was never
  counted and, on RobotWare 8, never released: `disconnect()` released only
  when a 2xx had been seen.
- **`RobotManager.setNonMotionExecution`, `setCollisionPredictionMode`,
  `setTaskSelection` and `setVirtualTimeScale`** refuse with
  `UNSUPPORTED_OPERATION` on an adapter without the method (RobotWare 6), as
  the other optional writes do. They returned `undefined` without sending
  anything.

The items below come from the 2026-10-09 check of every RWS 1.0 path-table
row against the form RobotWare 6.16.03 serves on `?action=show`, ABB's RWS 1.0
manual (3HAC050973-001 Rev M) and a live call on an RW 6.16.03 virtual
controller.

- **RWS 1.0 `restoreBackup` keeps the backup.** ABB's restore takes
  `delete-dir`, which defaults to true, so a restore deleted the backup it had
  just restored. The client now sends `delete-dir=false`; pass
  `{ deleteBackup: true }` (new optional argument, also on `RobotManager`) for
  the controller's default.
- **RWS 1.0 `setNonMotionExecution` posts `?action=set-mode`.** `?action=set`
  was refused as an invalid action.
- **RWS 1.0 `setRobtargetForJogging` holds motion mastership.** Without it the
  controller refused the position target with 403.
- **RWS 1.0 `getTaskStructuralChangeCount` and `getTaskActivationRecord`
  read the task with `?resource=task-struc-change-count` and
  `?resource=activation-record&stackframe=1`.** The sub-paths they used answer
  404, which these reads turned into 0 and `{}`.
- **RWS 1.0 `setOperationMode` throws `UNSUPPORTED_OPERATION` without sending**, mastership included.
  RWS 1.0 has no operating-mode change (ABB documents none, and every body the
  controller was offered answered 400); the mode is changed with the key
  switch, or the mode selector of RobotStudio's control panel.
- **RWS 1.0 `setPPToCursor` posts `?action=set-pp-cursor` with the routine**, as
  ABB documents. The controller form spells the action `set-pp-curser`, which
  is refused whatever the body. The new optional `routine` argument (also on
  `RobotManager`) names the routine; without it the routine around the row is
  read from the module text, and a row outside every routine is refused.
- **RWS 1.0 `loadProgram` sends `loadmode`.** The argument was accepted and
  dropped, so `'add'` replaced the program.
- **RWS 1.0 `getVisionSystemInfo` reads `/rw/vision?resource=camera-info&name=...`**,
  as ABB documents. `/rw/vision/{name}` is not a route; the documented query
  reaches the vision service.
- The RWS 1.0 path rows of `listSafetyZones` and `runCyclicBrakeCheck` say
  they have no ABB resource behind them and stay until the next major version.

The items below come from the 2026-10-07 check of ABB's RWS 2.0 OpenAPI
files (3HAC073675-001 Rev L) against the client's path tables, each re-checked
against the controller forms on RobotWare 7.21.4 and 8.2.1 (2026-10-07/09).

- **RWS 2.0 `saveDiagnostics` sends `dstpath`.** ABB documents one required
  body field, `dstpath`, a `/fileservice/` path; the client sent `data`,
  which the controller does not read ("No destination path in the data
  parameter" means the form body as a whole). A call with no destination is
  refused with `INVALID_ARGUMENT` before anything is sent.
- **RWS 2.0 `getVirtualTime` sees a running VC.** The controller's state words
  are `VTSTOP`, `VTFREERUN`, `VTRUNSLICE` and `VTNEXTEVENT`; `running` is now
  true for anything but `VTSTOP`. It compared the text to `running`, so it
  was always false.
- **RWS 2.0 `setVirtualTimeScale` posts `vtspeed`**, ABB's field name, with
  no action. The controller form names it `vtcurrspeed`, and RobotWare 7.21
  and 8.2 refuse it with 400 "Invalid data value", so changing the speed
  always failed on RWS 2.0. Run against RobotWare 7.21.0, 7.21.4 and 8.2.1:
  `vtspeed=1000`, `-1` and `100` answer 204 and read back as sent. Reads are
  unchanged; the controller answers them with `vtcurrspeed`.
- **`setVirtualTimeScale` sends a percent (RWS 2.0).** The wire value is a
  percent of real time (100 = real time, -1 = as fast as possible); the
  factor went out unchanged, so `1` meant 1 % and `10` meant 10 %.
  `getVirtualTime().speed` divides by 100 on the way back (`Infinity` for
  -1), on both generations.
- **`getVirtualTime().time` is documented as milliseconds** since the VC
  started (it said microseconds).
- **RWS 2.0 `getBackupStatus` reads the backup state.** It read
  `/ctrl/backup`, a listing of links with no progress fields, so `active` was
  always false and a caller polling after `createBackup` stopped at once. It
  now reads `/ctrl/backup/state` ('Init State' and 'Backup in Progress' are
  active; 'Backup Ready' and 'None' idle; 'Error during backup', 'Invalid'
  and any other text set the new `failed`).
- **RWS 2.0 `uploadCertificate` uses the documented form.** ABB's "Add
  Certificate" and the controller form take one field, `filepath`, naming a
  PEM file on the controller. The client POSTed the PEM itself as
  `application/x-pem-file` to a path no document describes. It now uploads
  the PEM to `$TEMP`, posts `filepath` to `/ctrl/certstore/{store}` (the
  first parameter is the store path, e.g. `controller/trust_ca_store`), and
  deletes the temporary file whether or not the add succeeded.
- **RWS 2.0 `removeCertificate` no longer sends a DELETE the controller does
  not serve.** No Allow header under `/ctrl/certstore` lists DELETE and ABB
  has no per-certificate resource; it throws `UNSUPPORTED_OPERATION` before
  sending and points to the new `clearCertificateStore`.
- **RWS 2.0 `listSafetyZones` and `runCyclicBrakeCheck` send nothing.** No
  ABB document has `/ctrl/safety/zones` or a brake-check start (ABB documents
  only the status read); the VC's 404 for both is the one it gives any
  unknown `/ctrl` path, not a "not on a virtual controller" refusal, so the
  "kept for hardware" reasoning did not hold. `listSafetyZones` answers `[]`;
  `runCyclicBrakeCheck` throws `UNSUPPORTED_OPERATION`.
- **RWS 2.0 vision paths follow ABB's Integrated Vision service.**
  `getVisionSystemInfo` reads `/rw/vision/{camera}/info` (class
  `camera-info-li`) and `listVisionJobs` reads `/rw/vision/{camera}/job-name`
  (one job per camera, class `vision-camera-job`); the paths the client used
  (`/rw/vision/{name}`, `/{system}/jobs`) are not routed on RW 7 or 8.
  `triggerVisionJob` throws `UNSUPPORTED_OPERATION`: RWS 2.0 documents no
  trigger. The class names come from ABB's example (no VC has a camera).
- **RWS 2.0 `activateRapidTask` and `deactivateRapidTask` use the per-task
  resource**, `POST /rw/rapid/tasks/{task}/activate` (`/deactivate`) with no
  body, which ABB documents and the controller serves. They posted `task=`
  to the all-tasks resource, whose form has no fields. `activateAllRapidTasks`
  and `deactivateAllRapidTasks` loop over the per-task resources the same way.
- **RWS 2.0 `setPPToCursor` sends `module`, `line`, `column`**, the fields of
  the controller's cursor form and ABB's page; it sent `begin-position-row`
  and `begin-position-col`.
- **RWS 2.0 `callServiceRoutine` throws `UNSUPPORTED_OPERATION` before
  sending.** The resource is a GET listing (Rev L; `Allow: GET,OPTIONS` on
  RW 7.21.4 and 8.2.1); it used to POST and get the 405. A service routine
  runs by setting the program pointer to it and starting.
- **`unlockOperationMode` sends the PIN.** The unlock form has a `pin` field
  on RW 6.16.03, 7.21.4 and 8.2.1 and ABB marks it required; the client
  posted an empty body. See Changed.
- **`setMotionSupervisionMode` and `setCollisionPredictionMode` send ABB's
  `true` / `false`.** The motion-supervision JSDoc said `'on' | 'off'` (that
  is path supervision's vocabulary) and both methods passed the string
  through. See Changed.
- **RWS 1.0 `setRobtargetForJogging` uses the controller's form.** RW 6.16.03
  serves `?action=positiontarget` with 17 fields (position, quaternion,
  `config-j1/j4/j6/jx`, `extjoint-1..6`); the client sent `?action=set-target`
  with `x..q4`, an action and fields no ABB document or form has. See
  Changed for the parameter.
- **`getReturnCode` no longer appends `lang`.** The query is undocumented,
  ignored (the controller serves English only) and went out unencoded on
  both generations. The parameter stays and is ignored. On RWS 1.0 the
  answer's `err-desc` `name` / `description` are read; the `title` / `desc`
  it looked for are never emitted, so RW6 answered empty strings.
- **Path-table and comment corrections** with no wire change: the
  installed-system row is `/ctrl/system` (RC only; `/ctrl/systems` is the
  RWS 1.0 name); `getModuleAttributes` takes `attribute=` (the controller's
  400 names `attrib`, which is refused the same way); the UAS read notes say
  which rows answer 200 to the Default User; the IK/FK notes record the
  2026-09-30 live solves and that ABB's pose-from-joints sample is on a
  millimetre scale while the controller answers metres; the jog-unit form.
- **RWS 2.0 `checkGrantExists` after the XHTML fallback.** It reads the grant
  status in both representations: the hal+json `status` field and the XHTML
  `grant-exist` span. After the client fell back to XHTML (a 406, or a
  hal+json GET answered with XHTML), it used to answer false for a grant the
  user holds. An answer with neither, or with a value other than true/false,
  now rejects with `PARSE_ERROR` instead of reporting "not held".
- **RWS 2.0 `readDipcMessage` waits.** It sends its wait as ABB's `timeout`
  query parameter, in whole, non-negative milliseconds. It used to send
  `dipc-timeout`, which the controller ignores, so a read never waited. The
  client's idle timeout and deadline for that one read are extended by the
  wait.
- **RWS 1.0 `readDipcMessage` is no longer cut off by the client's own
  timeout.** The request timeout of that one read is extended by its wait. A
  wait that reached the client's `timeout` (5000 ms by default) used to be
  aborted and answer null, and a message that reached the queue after the
  abort was consumed by a read nobody received. The wait is capped at 280 s,
  under the 300 s Node's fetch waits for an answer's headers. On RWS 1.0 the
  wait occupies the client's serial request queue, so later requests on that
  client, a disconnect's logout included, wait until the read answers.
- **RWS 1.0 `holdToRun` uses the form the controller advertises.** It posts
  `POST /rw/rapid/execution?action=holdtorun-state` with the one field
  `state`, the form RW 6.16 advertises on `GET
  /rw/rapid/execution?action=show` and ABB's RWS 1.0 manual documents, and
  holds RAPID mastership around the post like `startRapid`, `resetRapid` and
  `setExecutionCycle`. It used to post
  `/rw/rapid/tasks/{task}?action=holdtorun` with body `action=`, which RW 6.16
  refuses with 400, and took no mastership. Live on RobotWare 6.16.03.
- **RWS 1.0 `getModuleTextRange` decodes by the answer's key.** `text` gets
  entity decoding (`&amp;` last) and `module-text` gets URL decoding. It used
  to guess from the text's shape, so a mid-line range with no whitespace and a
  `%XX` in it (for example `&quot;100%25&quot;`) was URL-decoded and kept its
  entities escaped.
- **RWS 2.0 `getModuleText` and `getModuleTextRange` after the XHTML
  fallback.** They decode XML entities (once, `&amp;` last). They used to
  return the text with its entities still escaped. The hal+json text is
  returned as read.
- **`RobotManager.startRapid` and `stepRapid` right after a jog (RobotWare 6
  and 7).** `jog()` keeps motion mastership until 2 s after the last jog, so a
  start sent in that window went out while this session still held motion.
  ABB's RobotWare 7 start page says a start does not succeed while the client
  holds motion mastership, and RobotWare 7 refuses a start sent under this
  session's motion hold with 500 -1073445844 (`MASTERSHIP_REQUIRED`). A start
  or a step (a step is a start with a step mode) now first ends the jog's own
  idle motion hold and clears its timer, in the same write turn as the start,
  so no release fires 2 s later. A motion hold the caller took stays the
  caller's. On RobotWare 8 the start reuses the one write-access hold and
  releases nothing before it.
- **`updateSubscriptionGroup` says which resources were bound.** A group PUT
  that named an unknown resource is answered 400 -1073445866 "Invalid resource
  URI in Update Subscription request", and the controller still binds the
  valid resources and lists them in that body. The error used to keep no body,
  so callers treated the whole PUT as refused. On RWS 1.0 a 2xx answer whose
  status divs name refused resources used to be returned as plain success; it
  is now thrown as `SubscriptionUpdateError` too.
- **RWS 1.0 subscriptions failed inside a CommonJS bundle, such as the VS
  Code extension's.** `WsSubscriber` loaded `ws` through
  `createRequire(import.meta.url)`; a CommonJS bundle has no `import.meta`
  (esbuild turns it into `{}`) and `createRequire(undefined)` throws, so every
  RWS 1.0 subscription failed with `NETWORK_ERROR` and `RobotManager` fell back
  to polling. It now loads `ws` with `import('ws')`, as the RWS 2.0 client
  does. Node ESM consumers were not affected.
- **The discovery `User-Agent` lost its version inside a bundle.** The
  version was read from `package.json` at run time, which a bundle does not
  have next to the module, so the extension's probes sent
  `abb-rws-client discovery`. The build now writes the version into
  `src/version.ts` (`scripts/write-version.mjs`, run by `npm run build`), so
  every probe sends `abb-rws-client/<version> discovery`.
- **`npm run conformance` logs out of each controller after its crawl** (one
  `GET /logout` on the crawl's session cookie); a run used to leave one session
  per controller open until it expired.
- **`createClient` / `createAdapter` with a port and no `https`.** Only 443,
  5466 and 9403 used HTTPS; every other port was tried over HTTP only, so port
  80 and 9805 (RobotWare 8 virtual controllers) and any reassigned VC port
  serving HTTPS failed with `PROTOCOL_DETECT_FAILED`. A port the table lists
  with one scheme now uses it; port 80 and ports not in the table are tried
  over HTTPS and HTTP at once, and the first RWS challenge wins.
- **Connect-time recovery for a saved entry on 80, 5466 or 9805 without
  `useHttps`** assumed HTTP (RWS 1.0) unless the port was 443 or 9403, and so
  looked for the wrong generation. It now takes the saved scheme, else the
  table's, else probes the port again, and only then guesses HTTPS, logged as
  a guess.
- **The listening-port scan of this PC.** Windows runs `netstat -ano` (IPv4
  and IPv6 listeners; it was `-p TCP`, IPv4 only) by absolute path under
  `%SystemRoot%`. Linux reads `/proc/net/tcp` and `/proc/net/tcp6` before
  `ss`. macOS runs `netstat -an -p tcp`, then `lsof`: it ran `ss`, which macOS
  does not have, found no ports and fell back to a blind sweep. `ss` lines with
  v4-mapped (`[::ffff:127.0.0.1]:80`) and unbracketed IPv6 (`:::80`) addresses
  are read. POSIX commands run with `LC_ALL=C` and are looked up in
  `/usr/sbin`, `/usr/bin`, `/sbin` and `/bin` before `PATH`.
  `parseListeningPorts(output, platform)` gives the same result as before for
  every input it read, and also reads `/proc/net/tcp` and macOS `netstat` text.
- **`wideHostScan` missed port 80.** The sweep started at 1024, so an RW 8.1.1
  virtual controller serving HTTPS on 80 was never found by it.
- **A recovery login whose `connect()` failed after the controller accepted
  the login left the session open.** It now sends `/logout`.
- **RWS 1.0: a RAPID read too large for one answer is `INVALID_ARGUMENT`,
  not `RESOURCE_NOT_FOUND`.** RobotWare 6.16.03 answers an oversize array
  read with HTTP 400 and its generic -1073414146, "Buffer not enough to hold
  data", the same status and code it gives a symbol that does not exist. The
  client read it as "Resource does not exist" for a variable that is there.
  It now tells the two apart by the controller's message and says "Too much
  data for one RWS request", as it already did on RWS 2.0.
- **RWS 2.0: a RAPID string with a '%' in it is written as given
  (behaviour change).** On RobotWare 7.21.4 and 8.2.1 a RAPID string written
  through RWS read back with `%XX` decoded once more than the form encoding
  requires: a correctly encoded `"%41"` read back as `"A"`, and
  `"a&b=c<d>%25 e+f"` as `a&b=c<d>% e+f` (functional runs, 2026-09-30). The
  extra decode is on the write, not the read: strings declared in RAPID read
  back exactly as declared on 6.16.03, 7.21.4 and 8.2.1, and on 7.21.4 a
  RAPID routine finds the text written with the escape at its full length
  (`StrLen`) and equal to the same text as a RAPID literal (2026-10-01; the
  routine check needs the motors on and has not run on 8.2.1).
  `setRapidVariable` on RWS 2.0 now sends every `%` as `%25` before the form
  encoding, so the text round-trips exactly. A caller that escaped `%` itself
  to work around this now gets its escape kept as text; pass the RAPID text
  as it should be. RobotWare 6 (RWS 1.0) kept the value as written and is
  unchanged.
- **RobotWare 8: `RobotManager.setOperationMode` holds control-station write
  access around every switch (behaviour change).** It used to take write
  access only for a switch to Auto, so a switch from Auto to MANR was sent
  without it and RW 8.2.1 refused it with 403 `-1073435873`, explained as a
  possible client error. RobotWare 8 changes the operating mode only for a
  control station that holds write access. When the request for write
  access is refused, the switch is no longer sent anyway: the error is that
  refusal, with `setOperationMode('<mode>') was not sent` in front of its
  message. RobotWare 6 and 7 are unchanged (mastership only for a switch to
  Auto).
- **RobotWare 8: a write-access request refused while a switch to Auto waits
  for the confirmation at the FlexPendant is explained.** While the operating
  mode read `AUTO_CH`, RW 8.2.1 answered every write-access request with 403
  `-1073414145` ("Unknown Error", icode -4502), which this client typed
  `UNKNOWN` with no explanation. With the mode known to the caller (a
  `RobotManager` whose polling is current), that answer is now `WRONG_MODE`
  with a `wrong-mode` refusal whose grantor is the person at the FlexPendant:
  the change is confirmed there, and sending the switch again does not
  confirm it. The same code on any other request or in any other mode stays
  unexplained.
- **`RobotManager`'s simulation-panel methods refuse an RWS 1.0 connection
  as `UNSUPPORTED_OPERATION`, and a disconnected manager as
  `NOT_CONNECTED`.** `simEmergencyStop`, `simResetEmergencyStop`,
  `simGeneralStop`, `simAutoStop`, `simEnableSwitch` and `teleportMechunit`
  used to throw `UNKNOWN` in both cases. Nothing is sent either way, like
  every other RWS 2.0-only write through the manager. The endpoints exist
  only on RWS 2.0 virtual controllers.
- **RobotWare 8: the control station registers again once the session is no
  longer registered (behaviour change).** Registration is session-scoped, and
  the client kept trusting its own note that the session was registered: after
  a controller restart or an idle expiry each write-access request could be
  refused 403 `-1073435871` ("Session is not part of a Control Station"). The
  note and any hold are now reset when the controller re-issues the session
  cookie (the `-http-session-` id changes; live-verified 2026-09-15 on
  RW8.1.1), and the note is cleared when a request is answered
  `-1073435871`, so the next write registers the station again before it
  requests write access. No request is retried.
- **RobotWare 8: registering again the identity a session already registered
  succeeds.** `registerControlStationRemote` resolves when the controller
  answers "A control station has already been registered" (`-1073435874`)
  and this session registered exactly that name, id and PIN; another identity
  in the same session is still refused, because the controller keeps the
  first registration.
- **`heldByMe` was always false when an explicit control-station identity was
  passed to `registerControlStationRemote`.** The method sent the given id on the
  wire but did not adopt it, while `getWriteAccessStatus()` derives `heldByMe` by
  comparing the holder against the client's own `csId` - still the constructor
  default, a random GUID. Any caller that registered with its own identity read
  `heldByMe === false` even while it was demonstrably the holder. The method now
  adopts the name, id and pincode it registered. Live-verified 2026-09-23 on
  RW8.1.1 with two registered stations: the holder reads `heldByMe` true, the
  other station false. Registering with no arguments was never affected.
- **RW8 write-access refusals are `MASTERSHIP_REQUIRED`, not `GRANT_DENIED`.**
  `-1073435870` (write access held by another control station),
  `-1073435873` (this session holds no write access) and `-1073435871` (session
  not registered) told users to approve an RMMP popup on the pendant, which is
  the wrong remedy for all three. Each now carries its own actionable message
  (release it there / appeal, request it first, re-register).
  `-1073435867` (hex C004AB25) answering a control-station registration is
  `INVALID_ARGUMENT`: the controller takes an id of exactly 38 characters.
  Outside a registration it is `UNKNOWN`, because ABB's documents name that
  number two ways.
- **RMMP on RobotWare 8.1.x: no hard-coded build in the message.** The
  `UNSUPPORTED_OPERATION` thrown by `requestRmmp` names the RobotWare version
  actually read at `connect()`. The controller code `-1073445885`, which the
  controller's own dictionary files as "service not supported in this
  version", now classifies as `UNSUPPORTED_OPERATION` on its own.
- **RobotWare 8: `getAllowMotionControl` read false whenever the answer was
  XHTML.** The controller serves the motion-control state as class
  `controlstation` (title `allow-motion-control`) in XHTML and as the
  misspelled `controstation-allow-motion-control` in hal+json; only the
  latter was read, so an enabled declaration read false after an XHTML
  fallback. Both are read now, and an answer with no `is-enabled` is a
  `PARSE_ERROR` instead of false.
- **RobotWare 6: a RAPID start refused because the motors are off read as
  `GRANT_DENIED`, "by ABB's design".** Live-verified 2026-09-30 on RW 6.16.03:
  in Auto with the motors off, the start answers 400 `-1073445881`
  (SYS_CTRL_E_REJECT) with `org_code: -4506` in the message, not the
  `-1073442809` RobotWare 7 gives. The refusal said nothing a remote tool
  could supply, which hid the fixable cause. A start refused with this code is
  now `WRONG_MODE` with a `wrong-state` refusal on the motors ("the motors are
  off. Switch them on first.") when the message carries `org_code: -4506`, or
  when the manager knows the motors are off on RobotWare 6. A known motors-off
  state alone does not decide on other or unknown generations: RobotWare 8
  answers this code for its access restriction too, with the motors often off
  in Auto, and a RobotWare 8 start refused this way is not recorded yet. With
  the motors known to be on, or for other operations, it is unchanged. The
  code stays `WRONG_MODE`, as for the RobotWare 7 motors-off start
  (`-1073442809`); `RwsClient.startRapid` still gives `MOTORS_OFF` for a 400
  whose detail mentions the motors.
- **RWS 1.0: a saved session cookie is reused only with the credentials that
  created it.** `RobotManager` keeps session cookies in `~/.abb-rws-session`
  so a reconnect reuses its controller session. Entries are now keyed by
  host, port and a scrypt verifier of the username and password
  (`host:port#<verifier>`), so a saved cookie is reused only by a connect
  with the same credentials; every other connect logs in with the credentials
  it was given and reports a refusal as `AUTH_FAILED`. The file never holds
  the password. A disconnect now removes its own entry after `/logout`,
  unless another manager has saved a different cookie there since. Entries
  under the old `host:port` key, which clients up to 1.3.x read and write,
  are neither read nor removed, and values stay plain cookie strings. The
  first connect after upgrading logs in once instead of reusing an old entry.
- **RWS 1.0: a dead session cookie made every later connect fail as
  "Authentication failed".** `RobotManager` reuses the session cookie saved in
  `~/.abb-rws-session` for a host:port. Once that session had ended on the
  controller, the IRC5 answered 401 even to correct digest credentials while
  the old cookie was sent, so every reconnect failed with `AUTH_FAILED` until
  the entry was deleted by hand. On a 401 that persists after the digest
  handshake while a cookie is sent, the client now drops the cookies and signs
  in once more on a fresh session. Live-verified 2026-09-25 on an RW6.16 VC:
  with the dead cookie restored, connect succeeds on the fresh session.
- **`~/.abb-rws-session` was readable by other users on Linux and macOS.** The
  file holds live controller session cookies and was written with no mode,
  so 0644 under the usual umask. It is now created 0600, and on POSIX an
  existing file is set to 0600 on every save. Windows is unchanged: the
  profile's ACL protects it there.
- **Port recovery could connect to a different controller.** When a saved port
  no longer answered, `RobotManager` scanned the host and adopted the first
  controller of the same protocol generation - on a PC running several virtual
  controllers, that is whichever answers first, and with no fallback guard it
  could even cross generations. A saved RW7 entry was observed reconnecting to
  an RW8 controller on the same PC. Recovery now never crosses generation; it
  adopts a candidate only after confirming its system id (signing in once and
  out again), using the id from `setExpectedSystemId()` or the one read on the
  last successful connection; with no id and more than one candidate it keeps
  the saved port instead of guessing. New: `RobotManager.setExpectedSystemId()`,
  `RobotManager.chooseRecoveryCandidate()`, `RobotConfig.expectedSystemId`.
- **Port recovery on localhost missed a moved controller when another sat on a
  standard port.** The complete scan of the OS's listening ports ran only when
  the standard ports held no controller at all, so one virtual controller on a
  standard port hid every other one: an RW6 VC that moved to a new port was
  never considered while an RW8 VC answered on 5466. On localhost the listening
  ports are now always scanned when recovering.
- **A saved port taken over by another controller was used without question.**
  Virtual controllers restarting together can swap ports; the saved port then
  answers, so recovery never ran and the manager connected to a different
  controller. When the expected system id is known, the controller on the
  saved port is now identified first, and a stranger is treated like a dead
  port: recovery runs and finds the right controller elsewhere.
- **A failed recovery reported the dead port's network error instead of why.**
  With the expected system id known, a dead saved port and other controllers
  present but none of them the right one, `connect()` retried the dead port and
  surfaced its `fetch failed`. It now rejects with `PROTOCOL_DETECT_FAILED`
  naming the controller, the saved port and the recovery's conclusion (e.g.
  "none of 1 candidate(s) has system id ..."). Without an expected id the saved
  port is still kept, as before.
- **RWS 2.0: a connection cut mid-response left the call pending for good.**
  When the peer closed the connection cleanly before the promised body had
  arrived, neither the response nor the request reported an error, and the
  idle timer had stopped with the socket. The call now rejects at once with
  `NETWORK_ERROR`. The same holds for the subscription POST, whose failures
  are now `RwsError`s (`NETWORK_ERROR` for transport faults, the HTTP status on
  a non-201) instead of plain `Error`s, and for `probeProtocol`, which answers
  `null` for a cut or trickled answer. Its `timeoutMs` now also bounds the TCP
  connect (the name lookup not counted), so a dead host costs `timeoutMs`
  rather than the OS connect timeout; after the connect it bounds each
  silence, as before, so a high-latency link whose handshake and 401 together
  outlast `timeoutMs` is still detected. The probe as a whole is capped at four
  times `timeoutMs`, which ends a peer trickling bytes or a stalled lookup.
  Nothing a response handler throws (a body too large to decode, say) escapes
  as an uncaught exception any more; it rejects the call with `PARSE_ERROR`.
- **A port outside 0-65535 ended the host process.** `probeProtocol()` and
  `RobotManager.probeSpecificPort()` armed their timeout before creating the
  request. When the request could not be created at all (a port outside
  0-65535, a CR or LF in the host), the call failed, and the timer then fired
  on the missing request and threw from the timer: an uncaught exception,
  after the caller had already handled the failure. `connect()` with such a
  port, and `createClient()` / `createAdapter()`, reached it. Both probes now
  answer `null` for such input, as for any address where nothing answers, and
  leave no timer behind; `createClient()` and `createAdapter()` reject with
  `PROTOCOL_DETECT_FAILED`.
- **Constants and functions were missing from RAPID symbol reads on every
  generation.** The controller names these kinds `rap-sympropconstant` and
  `rap-sympropfunction` (`-li` in a search); the client looked only for
  `rap-sympropconst` and `rap-sympropfun`, which no controller has been seen
  to send (search classes live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and
  8.2.1; the properties class `rap-sympropconstant` live-verified 2026-09-30
  on RW 6.16.03, and taken from the search class for RobotWare 7 and 8,
  where a properties read of a CONST has not been captured yet). What callers
  saw:
  - `getRapidSymbolProperties` on a CONST threw `PARSE_ERROR` on RWS 1.0 and
    returned an all-empty record (`symtyp` `''`, `dattyp` `''`, `ndim` 0) on
    RWS 2.0;
  - `searchRapidSymbols` dropped every CONST and FUNC hit on both
    protocols, and so `RobotManager.listRoutines` never listed a FUNC.
  Both spellings are read now; the short ones stay as fallbacks. On RWS 2.0 a
  properties answer with no symbol-properties block is now `PARSE_ERROR`, as
  on RWS 1.0, instead of a record of defaults (behaviour change). Alias,
  record and atomic type hits are still not listed by the search.
- **RWS 1.0: `getRapidSymbolProperties` reported every symbol as writable.**
  The controller sends the read-only flag as `rdonly`; the parser read only
  `ro`. It now reads `rdonly` (and still `ro`), as the search already did.
- **RWS 2.0: `getRapidVariable` returned `''` for a value too large to read
  (behaviour change).** Live-verified 2026-09-29 on RW 7.21.4: a num array
  over the read ceiling answers HTTP 200 with no value and error links to
  `-1073445865` (SYS_CTRL_E_BUFFER_OVERFLOW). An answer with no value is now
  an `RwsError`: `INVALID_ARGUMENT` with `controllerCode` `-1073445865` and
  `httpStatus` 200 for this case, the linked code's mapping (else `UNKNOWN`)
  for another link, and `PARSE_ERROR` with no link. A value that is present is
  returned as before, even empty. RW 8.2.1 answers the same read with an
  empty value and no link, which still reads as `''`.
- **PP to main on a task without a `main` routine reported "Resource does not
  exist on the controller".** The controller answers 404; the path exists, the
  routine does not. `resetRapid()` now says the task has no main routine (code
  unchanged: `RESOURCE_NOT_FOUND`).
- **RWS 1.0: `searchRapidSymbols` works on RobotWare 6.16, and `listRoutines`
  finds routines there.** The client sent `POST
  /rw/rapid/symbols?action=search-symbol`, which a RobotWare 6.16.03 virtual
  controller refuses with 400 `-1073445879` for every body; the controller's
  own form names the action `search-symbols` (plural), which answers 200
  (2026-09-29). Three more changes make the answer useful: the search is
  scoped by `blockurl`, `RAPID/{task}` when the caller gives none, because
  6.16.03 accepts `task=` but ignores it and a `RAPID`-scope search does not
  reach task symbols; `view=block`, `symtyp=any` and `recursive=TRUE` are
  defaulted as on RWS 2.0 (without `symtyp` only the module entries come
  back); and the parser reads module, VAR, PERS, CONST, PROC, FUNC and TRAP
  hits, where it read VAR only, so `listRoutines` (the Modules tree, set PP to
  routine) found no routines on RobotWare 6. Module, VAR, PERS and PROC hits
  were seen on 6.16.03; the CONST, FUNC and TRAP class names come from the
  RWS 2.0 search. Task, parameter, atomic and record hits, which 6.16.03 also
  lists, are not returned. `task=` is still sent. A large search is paged by
  the controller (86 or 95 entries per page on 6.16.03); only the first page
  is read, which is enough for a module-scoped search such as `listRoutines`.
- **RWS 1.0: `getModuleTextRange` returned entity-escaped RAPID text.** On
  RobotWare 6.16.03 the range's JSON `text` value is not URL-encoded (raw
  spaces) but carries XML entities (`&quot;`, `&lt;`, `&gt;`, `&amp;`,
  `&apos;`), unlike the whole-module text, which is URL-encoded
  (2026-09-29). Entities are now decoded (`&amp;` last), and a literal `%` in
  RAPID text no longer throws (the decoding goes by the answer's key; see
  `getModuleTextRange` above).
- **RWS 1.0: forward kinematics failed on every call (behaviour
  change).** `calcCartesianFromJoints` POSTed `?action=CalcRobTFromJoints`
  with the fields `curr_joints`, `tool` and `wobj`. The controller does not
  know that action: live-verified 2026-09-30 on RW 6.16.03, it answers 400
  `-1073445879` "Invalid action parameter value", the same as for a made-up
  action name. It now uses ABB's `?action=CalcPoseFromJoints` with ABB's
  fields in SI units (joints converted from degrees to radians, tool0's
  identity frame, external axes absent) and reads `position-x/y/z` (metres,
  returned as millimetres) and `robtarget-orientation-u0..u3`, so it still
  takes degrees and returns millimetres. On the RW 6.16.03 virtual controller
  it returns the pose the cartesian read reports for the same joints. It
  computes the tool0 pose in the base frame only: the action takes no work
  object and a tool only as a frame, so a `tool` other than `tool0` or a
  `wobj` other than `wobj0` is now refused with `INVALID_ARGUMENT` before
  sending. The millimetres are rounded to 1e-6 mm, so the metre conversion
  leaves no binary noise (688.9405, not 688.9404999999999).
- **RWS 2.0: forward kinematics now uses ABB's `pose-from-joints` resource
  in SI units (behaviour change).** `calcCartesianFromJoints` POSTed
  `?action=CalcRobTFromJoints`, which answered HTTP 200 with an error link
  instead of a pose on RW 7.21.4 (`-1073445859`) and RW 8.2.1
  (`-1073435873`). It now posts to
  `/rw/motionsystem/mechunits/{mechunit}/pose-from-joints` with the joints in
  radians and tool0's identity frame and converts the answer's metres, so it
  still takes degrees and returns millimetres. An error embedded in a 200
  answer is now thrown typed by its controller code, with the code kept,
  instead of as `UNSUPPORTED_OPERATION`, and the refusal no longer blames a
  missing PC Interface 616-1 license. The same tool0/wobj0 `INVALID_ARGUMENT`
  pre-check as on RWS 1.0 applies. Live-verified 2026-09-30 on RW 7.21.4 and
  8.2.1 virtual controllers: the current joints solve to the current pose.
- **RWS 1.0: inverse kinematics was refused "out of reach" for every pose
  (behaviour change).** `calcJointsFromCartesian` sent the position in
  millimetres and the seed joints in degrees; the controller takes metres and
  radians, so every pose, the current one included, answered 400
  `-1073436654` "Position outside of reach". That was taken for a
  virtual-controller limitation; it was the units. The method now converts
  the pose to metres and the seed to radians, and reads the answer's
  `robotjoint1..6` (radians) as degrees; it used to read `rax_1..rax_6`, which
  the answer does not have. Live-verified 2026-09-30 on RW 6.16.03: the
  current pose with the current joints as the seed solves to those joints on
  a virtual controller. The `wobj_frame_position/orientation` fields, not in
  ABB's field list and without effect there, are no longer sent. The degrees
  are rounded to 1e-6 degree. Because the call now solves instead of always
  failing, note that `pos` must be the tool0 pose in wobj0, on both
  generations now that RWS 2.0 sends SI units too (below): the method takes no tool or work object, so a
  pose read with another active tool or work object is solved as a flange
  pose at that point and gives plausible but wrong joints, with no error.
  `getCartesianFull` and `RobotState.cartesian` (`/cartesian`) take no tool
  or work object and are not verified to report tool0 in wobj0 when another
  is active; the adapters' `getRobTarget(mechunit, 'tool0', 'wobj0')` names
  them in the request.
- **RWS 2.0: inverse kinematics (`calcJointsFromCartesian`) now sends SI
  units (behaviour change).** It sent millimetres and degrees unconverted,
  plus `wobj_frame_*` fields no form lists, so the current pose was refused
  as out of reach (400 `-1073436654`, RW 7.21.4 and 8.2.1), exactly as on
  RW 6.16.03 before its conversion. It now sends metres and radians, with
  tool0's identity frame, and returns degrees, following ABB's RWS 2.0 page.
  Live-verified 2026-09-30 on RW 7.21.4 and 8.2.1 virtual controllers: the
  current pose solves to the current joints. A pose really out of reach is
  `INVALID_ARGUMENT`.
- **RWS 2.0: `writeSignal('', '', name, value)` refused every signal it had
  not listed first, and so every signal with no device.** With network and
  device empty, the client took them from what `listAllSignals` or a signal
  search had read, and those recorded only signals bound to a device. Every
  other signal was refused with `UNKNOWN` before sending: all signals before a
  list was read, and always the signals with no device (the safety
  controller's `SCnCBC*` signals on RobotWare 7 and 8, and
  `CollaborativeOperationIsActive` on 8.1.1). `RobotManager.writeIoSignal`
  always passes empty network and device, so it failed the same way. The
  client now learns where the signal lives from the signal itself: from a
  list or search already read (which now also records the signals with no
  device), or else from one read by bare name, `GET
  /rw/iosystem/signals/{name}`, which answered 200 on RobotWare 6.16, 7.21
  and 8.1.1 virtual controllers. That read's entry title is
  `network/device/name`, or the bare name for a signal with no device; the
  answer is remembered for later writes. A device-bound signal is written at
  its full path, as before. A signal with no device is written at
  `/rw/iosystem/signals/{name}/set-value`, the controller's own path for that
  signal with ABB's `set-value` action appended. That form has run against
  RobotWare 8.2.1; whatever the controller answers is passed on unchanged,
  and the write is never retried in another form. No mastership or write
  access is taken, as before. What changes for callers:
  - a write by name for a signal the client has not read yet now sends one
    read first;
  - refusals before sending: a name that is not letters, digits and
    underscores is `INVALID_ARGUMENT`; an unknown name keeps the read's own
    code (`RESOURCE_NOT_FOUND`, 404 `-1073445866`), and the message says that
    nothing was written; an answer that does not say where the signal lives
    is `PARSE_ERROR`;
  - a remembered location that the controller answers 404 for is forgotten,
    so the next write reads the signal again.
  RWS 1.0 is unchanged: it writes by name at the flat signal path.
- **The signal table read empty for up to ~20 s after a reconnect.**
  `RobotManager` reloads `ioSignals` on the first poll and on every fifth, but
  the poll count survived a disconnect, so after a reconnect the table stayed
  `[]` until the count next reached a multiple of five. The count now restarts
  with every connection, so the first poll loads the table. A failed load is
  logged as a warning instead of being swallowed and is retried on every poll
  until one succeeds, rather than at the next multiple of five, and
  `refreshIoSignals()` no longer writes a table read on a connection that has
  since ended.
- **I/O signals named like a panel resource were taken for it.** Subscription
  events were mapped with unanchored patterns (`/\/opmode/`, `/\/execution/`,
  `/\/speedratio/` and friends), in `resourcePathToName` and again in
  `RobotManager`. A signal such as `opmode_sel`, `execution_done` or
  `speedratio_ao` was renamed to the panel resource: its event never reached
  the signal's consumer, and the manager's `opmode`, `execstate` or
  `speedRatio` took the signal's value. Both places now share one mapping
  anchored to `/rw/panel/{name}`, `/rw/rapid/execution` and `/rw/elog/`;
  everything else passes through unchanged. The execution-cycle resource
  (`/rw/rapid/execution;rapidexeccycle`) is no longer taken for execution
  state either.
- **Signal names reached the subscription body (both generations) and the
  RWS 2.0 DELETE path unchecked.** Both carry the name verbatim (semicolons
  must stay literal, so nothing is percent-encoded), so a name with `&` or `=`
  added form fields to the body, and one with `?`, `#` or `..` aimed the
  request at another resource. `subscribe()` on either generation (and so
  `IRWSAdapter.subscribe()` through either adapter), and on RWS 2.0
  `updateSubscriptionGroup()` and `unsubscribeResource()`, now refuse a
  `{ type: 'signal' }` name that is not letters, digits and underscores (alone
  or as `network/device/signal`) with `INVALID_ARGUMENT` before sending
  anything; both generations apply the same rule. `unsubscribeResource()` also
  refuses any resource whose DELETE target would not parse as the same path
  under the group.
- **Subscriptions bound only one resource, on both protocol generations.** The
  subscription body announced `resources=N` once, but `resources=<i>` names a
  resource index and must be repeated per resource. The controller bound only
  the last resource, silently dropped the rest, and still answered 201 - so
  `RobotManager` subscribed to six resources, received only event-log events,
  and reported its link `live` while controller state, operating mode, speed
  ratio, execution state and collision detection were refreshed only by the
  5-second slow poll. Live-verified on RobotWare 6.16, 7.21 and 8.1.1 virtual
  controllers: all six are now bound, and speed-ratio and controller-state
  events arrive within about 200 ms of the change.
- **A slow poll could overwrite a newer value with an older one.** A poll reads
  controller state, operating mode, speed ratio and execution state, then awaits
  several more requests before writing what it read into the state. A
  subscription event arriving in between was overwritten by the value the poll
  had read before the change: live, speed 50 was reported and then 100 again.
  Events (and `setSpeedRatio()`) are now numbered per field, and a poll skips
  any field set after it began reading.
- **RWS 2.0: `searchSignals` and `searchSignalsEx` returned at most 100
  hits.** The controller pages a signal search at 100 with a `next` link, the
  same way it pages the plain signal list (an empty search on a RobotWare
  8.1.1 virtual controller answered 100 hits, then 41, 2026-09-27; a filtered
  `signal-search-ex` the same way), and both methods read the first page
  only, so a search matching more than 100 signals silently returned 100.
  Both now follow `next` to the last page, re-sending the same criteria to
  each page path, so the result is the whole hit set and every hit is
  remembered for `writeSignal` by name. The walk stops, with a logged
  warning, on a `next` that points back at a page already read and after 100
  pages; the warning names the method and the page. One new way to fail: a
  search whose first page succeeds but a later page fails now throws that
  page's `RwsError` instead of returning a partial hit set, where before only
  the first page was ever requested. RWS 1.0 is unchanged: it returned the
  whole list already.
- **RWS 1.0: a subscription could go live without one of its panel
  resources.** RobotWare 6.16.03 accepts `/rw/panel/ctrlstate`, `opmode`,
  `speedratio` and `coldetstate` bare or with the `;suffix` the client sends,
  but while any live group (another client's, or this session's) holds one in
  the other spelling, a multi-resource create still answers 201 and drops
  that resource, naming it only in a status block of the 201 body
  (`-1073445866`, 2026-09-29). The client read only the status, so
  `RobotManager` treated the group as live while that resource sent no events
  and was refreshed only by the slow poll. The subscriber now reads the 201
  body: for a dropped panel resource it deletes the group and creates it once
  more with that resource in the other spelling, which binds it. If it is
  still refused, the group is deleted and `subscribe` throws, so the manager
  drops the whole event stream (event log and execution state included) and
  polls everything at the full rate. A dropped resource that is not a panel
  one is now logged and the group is kept; before, no dropped resource was
  detected or logged. The retry costs one extra create and delete, only when
  a resource was dropped. RWS 2.0 is unchanged.
- **`RwsClient2.resourcePathToName` no longer files ABB's extended execution
  resources under `execution`.** `/rw/rapid/execution;execstate` (an extended
  state carrying a change count, the user or task behind the change and the
  elog seqnum) and `/rw/rapid/execution;execstatechange` (a change count over
  the RAPID domain: module or program load, unload, delete) now map to their
  own names, `execstate` and `execstatechange`. Both are new in RobotWare
  7.19.1 or 7.20 (ABB's release notes list them under both). Before, either
  would have mapped to `execution`, the consumer of `;ctrlexecstate`, and an
  event on it would have overwritten `RobotState.execstate` with a value that
  is not an execution state. The client does not subscribe either resource
  yet; `/rw/rapid/execution`, `;ctrlexecstate` and the `;rapidexeccycle`
  exclusion are unchanged.
- **Event-log severity no longer defaults to information.** A message whose
  `msgtype` the controller omitted or mangled now has `msgtype: 0` (unknown)
  on both protocols - the RWS 1.0 listing and `getEventLogMessage`, and the
  RWS 2.0 `getEventLog`, `getEventLogMessage` and
  `getEventLogMessageBySeqnum` - instead of 1 (information). A value such as
  `3abc`, which used to parse as 3, is now 0 as well: a mangled field is not
  a known severity. ABB's RobotWare release notes for 6.15.04 list an RWS
  "Elog Message Get missing response parameter" correction (a title only:
  the parameter and the affected versions are not stated), so on RobotWare 6
  before 6.15.04 an error could have been shown as information. Viewers
  should render 0 as unknown severity. The `ElogMessage.msgtype` and
  `.seqnum` docs now say so, and note that RobotWare 6.13.02 wrapped
  event-log sequence numbers at 2^16 (candidate fix 6.13.04) - the client
  itself never orders by `seqnum`.
- **RWS 1.0 entity decoding.** `&amp;` is decoded last, so a doubly-escaped
  `&amp;lt;` in a span (the controller's literal text `&lt;`) no longer
  comes out as `<`; the XML `&apos;` is decoded alongside the HTML `&#39;`.
- **`getEventLogMessage` returned another message under the requested
  seqnum (RWS 1.0 and RWS 2.0; behaviour change).** A seqnum the domain does
  not hold (missing, or past the newest) is answered 200 with the nearest
  older message of that domain, not with a 404 or 204: on RobotWare 6.16.03
  (2026-09-29; asking for 9999 returns the newest) and on 7.21.4 and 8.2.1
  (recorded 2026-09-29, functional suite 2026-09-30). The entry's title (and
  on RWS 2.0 its self link) names the seqnum it really holds. The client
  stamped the requested seqnum on that message, so a seqnum past the newest
  read as the newest message, and a domain-0 seqnum held by another domain
  read as the nearest older domain-0 message. `getEventLogMessage` (both
  generations) and `getEventLogMessageBySeqnum` (RWS 2.0) now compare the
  entry's own seqnum (its title, else on RWS 2.0 its self link) with the
  requested one and return null for a different message. On RWS 2.0 an entry
  that names no seqnum is returned as before, and a trace line (category
  `elog`) names the requested and the answered seqnum. Seqnum 0 reads as null
  on both generations.
- **RWS 2.0: `getEventLog(domain, lang, maxPages, 'newest')` returned page 1
  again instead of page 2.** Under the `v=2.1` media type the controller's
  next link never advances, so a domain with more than one page returned its
  newest page twice (RobotWare 7.21.4 and 8.2.1, 2026-09-29). Newest-first
  pages now go by `elogseqnum` = (lowest seqnum read so far) - 1, which
  returns the newest stored entries at or below that number, and stop on an
  empty page or a page with no new seqnum. A failure on one of those further
  pages ends the walk with the entries already read (logged), because the
  answer below the oldest stored entry of a cleared or wrapped log has not
  been captured; a failure on the first page still throws. Oldest-first (the
  default) still follows the next link, which advances there.
- **Event-log text showed XML entities.** The RWS 2.0 hal+json strings
  (RobotWare 7.21.4 and 8.2.1, 2026-09-29) and the RWS 1.0 `?json=1`
  single-message read (RobotWare 6.16.03, functional suite 2026-09-30) carry
  them (`task&apos;s` in a description). On RWS 1.0 the XHTML listing read by
  `getEventLog` was already decoded, so the same message read both ways
  differed. `title`, `desc`, `causes`, `consequences` and `actions` are now
  entity-decoded (`&amp;` last) in `getEventLog` and `getEventLogMessage` on
  both generations and in `getEventLogMessageBySeqnum` (RWS 2.0), the same way
  the XHTML path decodes them. A literal `&amp;` in a message now reads as
  `&`, and a message without a title still reads `Event <code>`.
- **RWS 2.0: `RobotManager` held the oldest 1000 event-log messages once
  domain 0 held more.** The whole read of the domain-0 event log (after
  connect, on the slow poll, `refreshEventLog`, and an elog event's fallback)
  walked oldest first and stops after 20 pages of 50, so past 1000 messages it
  held the oldest 1000, and every elog event then fell back to a 20-page
  walk. It now reads the newest 1000 messages newest first and holds them
  oldest first as before. A controller that refuses the newest-first read
  gets the oldest-first walk.
- **A whole event-log read that landed after an elog event's page merge
  dropped the newer messages.** `RobotManager` now keeps the newer messages
  that merge added, instead of dropping them until the next event.
  `refreshEventLog` drops a read that lands after a reconnect.
- **RWS 2.0: `listCfgInstances` returned at most 70 instances.** The next-page
  link of `/rw/cfg/{domain}/{type}/instances` is relative to the response's
  base (`/rw/cfg/`), and the client resolved it against the request's parent
  path, so page 2 went to a doubled path, answered 404, and the method
  returned the first 70 rows (94 `EIO_SIGNAL` instances on a RobotWare
  8.2.1 virtual controller, 2026-09-29). Next links are now resolved against
  the response's base (HAL `_links.base.href` or XHTML `<base href>`), falling
  back to the request's parent path when there is none. For the event log,
  the signal lists, the signal searches and `listCfgTypes` the two are the
  same path, so nothing changes there.
- **RWS 1.0: DIPC follows the controller's forms (behaviour change).**
  `createDipcQueue` sent `?action=create` with `dipc-max-size` and
  `dipc-max-number-of-messages`, which RW 6.16.03 refuses with 400
  `-1073445879` "Invalid action", so every create failed. It now posts
  `?action=dipc-create` with `dipc-queue-name`, `dipc-queue-size` (from
  `maxmessages`) and `dipc-max-msg-size` (from `maxsize`), which answers 201
  (live-verified 2026-09-30 on RW 6.16.03). `sendDipcMessage` posts
  `?action=dipc-send` with `dipc-userdef`, as the RW 6.16.03 queue form lists,
  and `readDipcMessage` reads with `GET ?action=dipc-read`, passing the
  optional `timeoutMs` as ABB's `timeout`; create, send, read and delete in
  these forms are live-verified 2026-09-30 on RW 6.16.03 (the message read
  back unchanged, and a second read found the queue empty). `listDipcQueues` leaves out the
  service's `info` entry, which RobotWare 6 lists before the queues.
  `removeDipcQueue` now throws a typed `RwsError` on HTTP 400 or above
  instead of passing silently.
- **RWS 1.0 `listBreakpoints` reads `program/breakpoint` (paged).** The
  task-root `breakpoints` path answers 404 on RobotWare 6.16 and used to be
  swallowed into an empty list; a refusal now throws a typed error.
- **RWS 1.0 `setMechunitForJogging`** sends the form's `mechunit-name` field
  instead of `mechunit`, validates the unit name and holds motion mastership
  around the write.
- **`listModuleRoutines` uses the module-scoped RAPID symbol search on both
  generations.** RWS 1.0 used an unverified
  `/rw/rapid/modules/{task}/{module}/routines` path and returned `[]` on every
  error. RWS 2.0 sent `GET .../modules/{module}/routine`, which reads the
  routine at a text position: RobotWare 7.21.4 refused it 400 "Row or Column
  invalid/missing", so the call never worked. Both now search the module (on
  RWS 2.0 the same search as `listModuleSymbols`), keep the PROC, FUNC and
  TRAP hits directly in the module, whatever their list class, and throw
  typed errors.
- **RWS 2.0 `removeBreakpoint`** now POSTs
  `/rw/rapid/tasks/{task}/program/breakpoints/remove` (the controller's
  clear-breakpoint form on RobotWare 7.21.4 and 8.2.1); the previous DELETE
  answered 405. Its fields are ABB's `module`, `row` and `column` (see the
  RWS 2.0 request shapes corrected after the write run of 2026-10-11).
- **RWS 2.0 `validateRapidValue`** posts to `/rw/rapid/symbols/validate` (ABB
  RAPID service, Rev L) with `task`, `value` and `datatype`. It returns
  `false` for every 400 that is not an access refusal (a syntax error in the
  value included), matching RWS 1.0; a missing path, a transport failure or an
  access refusal now throws a typed `RwsError` instead of returning `false`.
  The fields are those of the controller's own form for the resource. Note:
  RobotWare 6.16.03, 7.21.4 and 8.2.1 answer 204 (`true`) to every value,
  a malformed literal and a value of another type included, so `true` means
  only that the controller did not refuse the request.
- **`RwsClient2` asks for XHTML on GETs under `/subscription`,** which every
  build answers in XHTML whatever the Accept. A hal+json request there would
  have been sent twice and switched the client to XHTML for every later GET.
- **RWS 2.0 `getMotionSupervision` / `getPathSupervision` read the XHTML
  form,** whose values come in double quotes (`"TRUE"`, `"100"`); before, a
  client that had fallen back to XHTML got `PARSE_ERROR`. An answer that lacks
  the supervision entry or its fields now throws `PARSE_ERROR` instead of
  returning `{ enabled: false, level: 0 }` or `{ mode: 'unknown', level: 0 }`
  (behaviour change).
- **`XhtmlParser.getAllStates`:** a capturing group inside the class pattern
  no longer shifts the title, href or span fields.
- **RWS 2.0 `isPasswordChangeAllowed` and `isUasUserPasswordChangeAllowed`
  read the `password-change-allowed` field** that RobotWare 7.21.4 and 8.2.1
  answer. `isPasswordChangeAllowed` read only `password-change-allow`, absent
  from that answer, and so reported `false` for a user who may change the
  password; `isUasUserPasswordChangeAllowed` threw `PARSE_ERROR`.
- **`getMechunitMotorCalib` reads the numbered classes RobotWare 6.16.03
  answers** (`ms-mechunit-joint1` .. `ms-mechunit-joint6`); it threw
  `PARSE_ERROR` there.
- **RWS 1.0 `getMechunitSmbData` reads the RobotWare 6.16.03 answer,** whose
  JSON has a comma before a closing brace. The JSON reader now drops such a
  comma (outside strings) when a body does not parse as it is; it threw
  `PARSE_ERROR` there.
- **A refused RWS 2.0 subscribe says why.** The error carries the
  controller's code and message (`controllerCode`, `controllerMsg`, and the
  message text) instead of the HTTP status alone; its `code` stays `UNKNOWN`.

## [1.3.1] - 2026-08-15

### Added

- **RobotManager wrapper-surface completion.** Adapter capabilities that existed
  on `IRWSAdapter` but had no `RobotManager` path are now first-class wrappers,
  so consumers no longer need adapter casts. Same house rules as the rest of the
  facade: reads degrade to a neutral value on controllers that lack the op,
  writes throw a typed `UNSUPPORTED_OPERATION` instead of silently no-opping.
  - **RMMP lifecycle:** `pollRmmp` (keeps the FlexPendant approval window
    alive), `cancelRmmp` (withdraws the popup) - closing the gap that forced
    UI consumers into a guarded adapter cast. Both (and `requestRmmp`) now
    throw `NOT_CONNECTED` when no adapter exists, reserving
    `UNSUPPORTED_OPERATION` for a real capability gap.
  - **Event log:** `getEventLog(domain, lang)` - fetch any domain directly;
    `refreshEventLog()` remains the state-updating domain-0 path.
  - **Files:** `uploadFile(path, content)` - write an arbitrary controller
    file without the module-load semantics of `loadProgram`.
  - **Mastership:** per-domain `requestMastership` / `releaseMastership` for
    caller-held multi-step edits, plus `listMastershipDomains`. A caller-held
    hold is coordinated with the rest of the facade: mastership-wrapped writes
    (`startRapid`, `stopRapid`, cfg writes, stepping) run inside the hold
    instead of acquiring and releasing their own (which would destroy it -
    RWS mastership is session-scoped with no refcount), and `jog()` neither
    re-requests nor auto-releases a hold the caller owns.
  - **RAPID debugger backbone:** `setPPToCursor`, `stepRapid`, `holdToRun`,
    `listBreakpoints`, `setBreakpoint`, `removeBreakpoint`. Stepping and PP
    moves post to the same mastership-gated execution/pcp family as
    `startRapid`, so they auto-acquire mastership like their siblings.
    Caveat: `holdToRun` is verified on RWS 2.0 only - the RWS 1.0 wire form
    is an unverified guess that answers HTTP 400 on RW6.
  - **Vision:** `getVisionSystemInfo`, `listVisionJobs`, `triggerVisionJob`.
    Caveat: RWS 1.0 cannot address a specific vision job (its wire form has
    no job segment), so naming one on an IRC5 throws instead of silently
    triggering whatever job is active.
  - **Safety:** `listSafetyZones`, `runCyclicBrakeCheck`.
  - **Mechunit:** `setMechunitBaseFrame` (write side of the already-wrapped
    read; auto-acquires mastership like the other config writes),
    `getMechunitPjoints`.
  - **Certificate store:** `listCertificates`, `uploadCertificate`,
    `removeCertificate`.
  - **Controller devices:** `listDeviceGroups`, `listControllerDevices`.

  No protocol changes - every wrapper delegates to endpoints that shipped in
  1.3.0 or earlier. Delegation, degrade/throw, and mastership-coordination
  behavior covered by new unit tests.

### Fixed

- **MultiMove: modules of every active task.** The poller listed modules for
  a single task (the first one flagged active), so on MultiMove systems the
  other motion tasks' modules were never fetched. `RobotState` now carries
  `modulesByTask` (every active task, keyed by name) alongside `modules`,
  which stays the primary task's list for compatibility. Load/unload refresh
  the task they touched. Reported against the VS Code extension
  (ichbinmeraj/abb-rws-vscode#4).

## [1.3.0] - 2026-08-12

### Added

- **RWS 1.0 coverage expansion - 20 endpoints closed via an ABB-doc + live-probe
  sweep.** A cross-check of the client against ABB's official RWS documentation
  (developercenter.robotstudio.com) surfaced a batch of endpoints the IRC5
  supports through **query-action forms** that differ from the RWS 2.0 path-action
  forms - the exact kind of generation split the path tables exist to capture.
  Each candidate form was then live-verified against the IRC5 RW6.16 VC before
  shipping (docs give the candidate, the controller gives the truth). Added on
  RWS 1.0 (and on both generations where noted):
  - **File / ctrl:** `compressPath` + `decompressPath` (`/ctrl/compress?action=comp`
    / `?action=dcomp`, `/fileservice/` paths), `getVirtualTimeTimeslice`,
    `renameFile` (`fs-action=rename`).
  - **I/O:** `searchSignals` + `searchSignalsEx` (`?action=signal-search` /
    `signal-searchex`), `searchIoDevices` (`/rw/iosystem/devices?action=search` by
    name/lstate - distinct from `searchDevices`, which searches the hardware tree).
  - **RAPID / motion:** `getModuleText` + `getModuleTextRange` (flat module
    collection scoped by `?task=`, whole text via `?resource=module-text`),
    `checkMotionChangeCount` (`?changecount=` vs the 2.0 path segment).
  - **Elog / cfg:** `saveEventLogRaw` (`?action=saveraw`), `validateCfgFile`
    (`?action=validate` load dry-run), `validateInstanceBeforeDelete`
    (`?action=validate-inst-at-del`).
  - **Panel / ctrl / users:** `setPanelLanguage` (`?action=setlang`, `lang-code`),
    `setControllerLanguage` (`?action=set-lang`, `lang`), and `pollRmmp` +
    `cancelRmmp` on **both** generations (RMMP grant lifecycle).

  Conformance now reports **59 implemented · 1 deliberate-gap · 0 unmapped · 0
  orphan** across both live generations. The lone residual gap is the
  `/ctrl/options` empty verify-stub (**204 no-content**; the real option list is
  `/rw/system/options`, which is implemented). The remaining uncovered endpoints
  are hardware/option-gated (vision, safety commissioning, calibration) and cannot
  be live-verified on a virtual controller.

- **Path tables - the single source of RWS URLs.** Every URL the client uses is
  now declared once in `src/paths`, one table per RWS domain, keyed by operation
  and split by protocol generation (269 operations, 398 path specs). Previously
  ~233 URL literals were scattered across eight files, most inline in method
  bodies, so an ABB endpoint change meant hunting six files and the two
  generations drifted with nothing forcing the difference to be intentional. The
  tables capture the anomalies that made updates expensive - symbol suffix/prefix
  inversion, inverted-polarity stop simulations, field-name-vs-path-segment
  mismatches, query-action vs plain-POST splits - as data. **The clients now READ
  the tables** (~356 `buildPath` call sites across both mappers, both clients and
  the adapter), so a path change means editing one table row, not a row plus a
  hidden literal. Additive: no public API change, and the migration is
  behaviour-preserving - every single-path RWS operation produces the exact URL
  it did before (locked by `tests/paths.test.ts`'s exact-URL assertions and the
  endpoint tests). The only literals that remain are genuine exceptions: the
  fileservice paths and multi-segment cert-store paths (custom per-segment
  encoding buildPath would break), the unmodelled hardware Devices Service, the
  non-resource endpoints (`/logout`, `/progress`, the `/rw/retcode` dictionary),
  and composite fan-outs with dynamic sub-paths.
- **`npm run conformance` - the drift check.** Crawls each running controller's
  resource tree and diffs it against the path tables, classifying every
  advertised resource as implemented / deliberate-gap / unmapped / orphan. After
  a RobotWare upgrade, new endpoints show up as `unmapped` in one run rather than
  as an investigation. Its first run already caught a genuine table omission
  (`/ctrl/virtualtime` atomic reads) and a deliberate divergence (`/ctrl/options`
  vs `/rw/system/options`). Report in `CONFORMANCE.md`.

### Fixed

- **Controller discovery is now fast AND complete - the first thing a user sees.**
  Three problems fixed, all live-verified against the rig (found all three VCs,
  incl. the IRC5 on a non-standard port, in ~1.5 s):
  - `discoverControllers` used to run the local port scan *only if the standard
    ports found nothing*, so with two VCs running - one on a standard port
    (5466), one not (14880) - it returned the first and **silently hid the
    second**. Localhost is now always discovered by probing the ports the OS
    reports as **listening** (`netstat`/`ss`), which is complete regardless of
    how many VCs run or where their ports landed.
  - The blind fallback scan capped at port **30000**, but RobotStudio assigns VC
    ports from the dynamic range (values of **40483** and **62214** observed on
    this rig) - so a drifted VC was undiscoverable. The OS-listening scan has no
    cap; the blind scan (now ceilinged at 65535) is a last resort only when the
    OS query is unavailable.
  - The protocol layer (`detect.probeHost`) and the discovery layer
    (`RobotManager.PROBE_PORTS`) kept **two divergent port lists** (one missing
    5466/11811, the other missing 28447). Both now derive from one shared
    `KNOWN_RWS_PORTS`, so they can't drift again.
  Discovery also got faster: `probeSpecificPort` probes HTTP/HTTPS concurrently
  instead of sequentially (halving the per-port worst case), which cut a full
  local scan from ~4.2 s to ~1.4 s. And mDNS now **re-queries within its window**
  (bursts at 0/250/750 ms) so a dropped UDP packet or a slow responder no longer
  makes a browse intermittently miss a controller that is right there.
- **The two-generation endpoint sweep is now reachable polymorphically.** The
  sweep added its methods to the concrete adapters but not to the shared
  `IRWSAdapter` contract, so nine methods live-verified on *both* generations -
  `searchSignals`, `searchIoDevices`, `renameFile`, `getModuleText`,
  `getModuleTextRange`, `checkMotionChangeCount`, `saveEventLogRaw`,
  `decompressPath`, `getVirtualTimeTimeslice` - plus the RWS-1.0-only
  `validateCfgFile` / `validateInstanceBeforeDelete` were unreachable through
  `createAdapter(): IRWSAdapter` and `RobotManager` without an unsafe cast. The
  sharpest case: you could `setModuleText` through the interface but not
  `getModuleText` to read it back first. All are now declared on `IRWSAdapter`
  and forwarded by `RobotManager`, so consumers reaching the client through the
  documented polymorphic surface (including the VS Code extension via
  `MultiRobotManager`) can call the read/search side, not only the write side.
- **Docs no longer deny capabilities the client ships.** The published `.d.ts`
  and README claimed `searchSignals`/`searchSignalsEx` were "RWS 2.0 only - the
  RWS 1.0 side has no server-side signal search at all" (false since the sweep),
  and six README rows tagged `renameFile` / `searchSignals` / `searchSignalsEx` /
  `saveEventLogRaw` / `setPanelLanguage` / `setControllerLanguage` "RWS 2.0" though
  they are live-verified on an IRC5 virtual controller too. The README
  error-code table listed only 13 of 17 `RwsErrorCode`s (missing
  `INVALID_ARGUMENT`, `UNSUPPORTED_OPERATION`, `NOT_CONNECTED`,
  `PROTOCOL_DETECT_FAILED`, all actively thrown), and
  `COVERAGE.md` / `ARCHITECTURE.md` still described the removed RWS 2.0 PING/PONG
  subscription heartbeat instead of the current silent-socket + out-of-band GET
  liveness probe. All corrected.
- **RWS 1.0 `searchSignalsEx` / `searchIoDevices` surface typed errors on a parse
  failure.** Both hand-build the request and called the raw client directly,
  bypassing the error-wrap their sibling `searchSignals` uses, so a parser throw
  on an unexpected 2xx body escaped as a bare `Error` instead of a typed
  `RwsError`. Now wrapped, matching the rest of the search surface.
- **Secrets no longer leak into trace logs.** Every write body was traced
  verbatim (first 200 chars) into the logger's structured `data`, so a host that
  persists trace output (the RAPID Live extension writes a log file) stored
  `changePassword`'s old/new passwords, the control-station pincode, and the
  operation-mode-lock PIN in cleartext at rest. Secret-named form fields are now
  redacted before logging on both generations; non-secret fields are untouched.
- **RWS 1.0 `startRapid()` honours the execution cycle.** It hardcoded
  `cycle=forever`, overriding a prior `setExecutionCycle('once')`, so a program
  the caller wanted to run once looped continuously and single-cycle mode was
  unreachable. Now sends `cycle=asis` (as RWS 2.0 already did) - the controller's
  default is `forever`, so a caller who never sets a cycle is unaffected.
- **RWS 1.0 `setControllerClock()` actually sets the clock.** Its form body was
  sent as `application/octet-stream`, so the controller's form parser ignored the
  `sys-clock-*` fields and the clock was silently unchanged. Now sent as
  `application/x-www-form-urlencoded`.
- **`copyFile()` no longer silently copies to the wrong place.** RWS fileservice
  copy is same-directory-only; a cross-directory destination had its directory
  dropped and the file was copied next to the source. Both generations now throw
  `INVALID_ARGUMENT` for a cross-directory destination instead.
- **`getActiveUiInstruction()` returns `null` when idle, as documented.** On IRC5
  the idle case answers HTTP 404; the method threw `RESOURCE_NOT_FOUND` on every
  idle poll instead of resolving to the documented `null`.
- **`RobotManager` no longer resurrects state after an intentional disconnect.**
  `refresh()` (and the async event-log subscription callback) kept operating on
  the torn-down adapter, so a refresh after disconnect could repopulate a
  "disconnected" state or re-fire the auto-disconnect "Reconnect" prompt.
  `refresh()` is now a no-op unless connected, the elog callback drops a
  late-arriving result across a disconnect/reconnect, and the failure counter is
  reset on disconnect.
- **RWS 2.0 survives the keep-alive race.** A controller that closes an idle
  pooled connection leaves a dead socket in the agent, and the next request
  adopts it and fails with `socket hang up` before anything is sent. RWS 1.0
  never showed this because undici retries a reused connection itself; the raw
  agent used by RWS 2.0 did not. Idempotent requests (`GET`, `OPTIONS`, `HEAD`)
  are now retried once on a fresh connection. Writes are deliberately **never**
  retried - re-sending a POST could start RAPID or toggle an output twice, and no
  reliability gain justifies that. Found by structural cell S09.
- **RWS 2.0 subscriptions no longer destroy themselves every 25 seconds.** The
  client sent an app-level `PING` frame on the subscription WebSocket as a
  keep-alive, on the premise that the controller closes an idle socket at 30 s,
  and terminated the stream if no `PONG` came back. Every part of that premise is
  false on the OmniCore RW7.21 virtual controller, and all three were verified
  there:
  - the controller **rejects client data on that socket entirely**, answering any
    frame - `PING` included - with a `1008 "Client cannot send data."` close. The
    keep-alive was itself killing the subscription roughly every 25 s; the
    reconnect logic then rebuilt it, which is why this looked like it worked
    rather than looking broken. Each cycle re-POSTs `/subscription`, mints a
    session, and drops events in the gap;
  - the socket needs no keep-alive at all - with the client silent it stayed open
    well past 75 s;
  - and the controller answers neither app-level `PING` nor a protocol-level ws
    ping, so the `PONG` deadline could never have been a liveness signal. On a
    quiet resource the only thing that could satisfy it was an event that never
    came, so a healthy idle stream was torn down every two intervals regardless.

  The client is now **silent on the subscription socket**, and establishes
  liveness out of band with a cheap GET on the same session each interval.
  Inbound frames still count as proof of life, so a busy stream never pays for
  the probe; two consecutive intervals with neither terminates and reconnects,
  keeping detection at the same two-interval bound as before. Found by structural
  cell S02.

  **Known limit:** because the client may not send on that socket and an idle
  subscription sends nothing back, a half-open state affecting *only* the
  WebSocket while HTTP still works cannot be detected in band. Detection covers
  link-level failure, which is the case that occurs in practice.

- **A stalled response body no longer hangs an RWS 1.0 request forever.** `fetch()`
  resolves as soon as response HEADERS arrive and streams the body afterwards, but
  the abort timer was cleared at that moment - so the body read had no deadline at
  all. A controller that sent headers and then stalled mid-body left the request
  pending indefinitely, and because this client serialises every request through a
  single paced queue, that one hung read stalled every request behind it while no
  configured timeout ever fired. The timeout now covers the whole exchange.
- **Unparseable RWS 2.0 responses are rejected instead of being answered with a
  plausible default.** `getState()` returns an empty map both for "block absent"
  and "block empty", so `getControllerState()` answered `init`, and
  `getOperationMode()` answered **`MANR`**, for a garbled or truncated response -
  reporting a specific, safety-relevant state the controller never sent. Those
  readers (plus speed ratio and RAPID execution state) now throw `PARSE_ERROR`
  when the state block is missing entirely, matching what RWS 1.0's parser already
  did for the same input. Field-level defaults are unchanged: a block that IS
  present but omits one span is a different situation.

Both were found by structural cell S12 (malformed / truncated responses).

### Changed

- **`package.json` declares `sideEffects: false`.** The modules are side-effect-free
  on import (verified: no top-level I/O, timers, sockets, or global mutation), so
  bundlers can now tree-shake unused adapters/mixins out of a downstream build.
- **`RwsClient2` restructured into per-RWS-domain modules.** The 4,300-line class
  was organised by protocol generation while RWS is organised by domain, so an ABB
  update never landed anywhere obvious. It is now a thin composition façade over
  `Rws2Core` (the shared machinery - transport, connection, subscriptions,
  mastership / control-station, RMMP) with the 236 endpoint methods split into
  nine domain mixins under `src/rws2/` (`panel`, `rapid`, `motion`, `io`,
  `cfgElogDipc`, `ctrl`, `system`, `users`, `files`). Each domain now has one
  obvious home - the mixin file beside its `src/paths` table - so a protocol
  change is a diff in one place, not archaeology across a monolith. `core.ts`
  drops from 4,333 to 1,583 lines. **No public API change:** the import path, the
  class name and every method are unchanged; each mixin publishes a named
  public-methods interface so the emitted `RwsClient2.d.ts` stays identical in
  surface. The move is behaviour-preserving - an AST diff against the pre-split
  class shows 275 of 283 method bodies byte-identical and the other eight only the
  mechanical edits the split required (four `private`→`protected` promotions, two
  constant dereferences, two type-only casts); 0 methods lost, added or
  duplicated. Verified by tsc, 585 unit tests, a leak-free declaration, a
  read-only smoke run against the OmniCore RW7.21 and RW8.1.1 virtual
  controllers, and structural cell S12 under fault injection.

## [1.2.0] - 2026-08-09

Everything below accumulated after the 1.1.0 entry was written on 2026-08-02.
1.1.0 was version-bumped and changelogged but never tagged or published, so npm
goes 1.0.0 → 1.2.0; the 1.1.0 section is kept as the record of what was true on
its date rather than being back-filled.

### Fixed

- **The flaky RWS 2.0 reconnect test is fixed at its cause.** The subscription
  tests addressed server sockets by index (`sockets[0]`, `sockets[1]`), which
  assumes every socket the server accepts is one the client kept. It is not: if
  the client's WS open timeout expires while the handshake is still settling -
  ordinary under parallel-suite CPU load - the client discards that connection
  and reconnects, leaving the server holding a dead entry. The test then sent
  its event to a closed socket and waited, which no timeout could rescue. This
  was reproduced deliberately (a 5 ms open timeout leaves the server holding one
  socket, state DEAD, while the client has moved on), so the diagnosis is
  demonstrated rather than inferred. Events are now delivered over the newest
  *open* socket and re-sent until the handler sees them, and drops terminate
  every current socket instead of index 0. Ten full-suite runs under doubled CPU
  contention pass, against roughly one failure in two before this work.

- **RobotWare 8 no longer throws when releasing write access.** Any write clears
  control-station write access as a side effect on RW8 - the status resource
  reports `held=false` immediately after a write while the session keeps writing
  successfully - so the release that followed was refused with
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
  ranged variant advertises `action=".../textrange"`, which 404s - the real path
  is `/text/range`, the one its OPTIONS is served at.
- `setKeylessMotorOn` - motors on without the key switch, for controllers with
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
  the controller's own refusal as the evidence. New methods: `setPanelLanguage`,
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
  path is exposed as `groupPath` on the handle `subscribe()` returns - the
  handle is still callable exactly as before.
- Several endpoints behave differently from what the specification implies, all
  live-verified on RobotWare 7.21 and 8.1.1: `signal-search-ex`'s second criteria
  set **narrows** rather than unions, and it does not glob; `validate-instances`
  takes a **numeric** `operation` (only 0 or 1) and validates instances that
  **already exist** rather than proposed ones; `collisionprediction/modelname`
  numbers robots from **zero**; and `/ctrl/system/info` is a POST that writes a
  file, not a getter. Each is recorded in the method's doc comment.
- `listCurrentUserGrants` now works on RobotWare 6 as well: RWS 1.0 serves the
  logged-in user's grants at `/users/grants` (26 grants on an RW 6.16 virtual
  controller), so the method name is the same on both protocols. Only the
  `/uas/*` tree is genuinely RWS 2.0 only. `listNetworkInterfaces` added for
  the full interface list.
- Resource-tree crawl batch. Crawling what the controllers advertise about
  themselves surfaced resources no documentation lists: `listEventLogDomains`
  (a virtual controller carries events in six domains, while `getEventLog`
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
  as a generic title with the two values dropped on the floor. On the virtual
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
- **RobotWare 8: `disconnect()` releases control-station write access before
  logging out**, and only if this session took it.
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
  virtual controllers with no duplicates.
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
  live: 130 and 141 signals on the two OmniCore virtual controllers, and
  event-log counts that match what the controller reports for the domain.
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
  (215 instead of 6966 on a virtual controller). It now returns the structural
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
  captured from the virtual controllers (`tests/fixtures/errors/`).
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
- RWS 1.0 subscription cleanup never actually worked on an IRC5: the
  DELETE targeted the poll URL from the Location header, which the controller
  answers with 404 (the deletable resource is `/subscription/{id}`, same as
  RWS 2.0 - live-verified on an RW 6.16 virtual controller). Unsubscribe also
  passed an absolute URL where `HttpSession` expects a path, so the request
  could not even be built. Registrations leaked for the life of the session;
  both are fixed.
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
recipe below has been verified against virtual controllers (RW 6.16 IRC5 +
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
  every recipe converged from the virtual controller's validation errors,
  including the undocumented inverted `state=off`-engages polarity.
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
