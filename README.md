# abb-rws-client

A typed TypeScript/Node.js client for **ABB Robot Web Services** - both protocols ABB ships:

- **RWS 1.0** - IRC5 / RobotWare 6.x → `RwsClient`
- **RWS 2.0** - OmniCore / RobotWare 7.x & 8.x → `RwsClient2`

> **Compatibility:** dual-protocol since v0.7.0. Single-line auto-detection via `createClient()` if you don't know which one your controller speaks.

---

## VS Code Extension

Prefer a GUI? The companion VS Code extension gives you live status, motion data, RAPID control, I/O signals, event log, file management, and CFG database editing directly from the sidebar - no code required. It speaks RWS 1.0 (IRC5) and RWS 2.0 (OmniCore); it has been tested on virtual controllers.

**[RAPID Live for ABB Robots](https://marketplace.visualstudio.com/items?itemName=merajsafari.abb-rws)**

---

## Features

- **Dual-protocol** - RWS 1.0 (Digest, JSON) and RWS 2.0 (Basic, XHTML;v=2.0)
- **Auto-detection** - `createClient(host)` probes the auth challenge and returns the right client
- **Multi-robot** - `MultiRobotManager` for orchestrating several controllers in one process
- **Controller discovery** - `findControllers()` finds controllers that answer on the ports and hosts you allow: local RobotStudio VCs on their reassigned ports (OS listening-port scan, no port-range cap) by default, and, when you turn them on, the service address, hosts you name, IPv4 ranges and mDNS/Bonjour - one merged entry per controller. Nothing leaves this PC unless you ask
- **Connection lifecycle** - `RobotManager` handles port discovery, polling, WebSocket subscriptions with polling fallback, reconnect-on-failure
- **Typed adapter pattern** - `IRWSAdapter` lets you write code that works across both protocols; its members built from a controller form but never run are marked `@experimental` and listed under [Known limits](#known-limits). `IRWSAdapterCore` picks the members every generation has run against a controller
- **WebSocket subscriptions** for real-time events (panel state, RAPID exec, signals, persvar, elog, jointtarget, …)
- Session cookie management (IRC5: avoids the controller's 70-session pool fill; OmniCore: avoids 503 lockout from session-pool exhaustion)
- Automatic `/logout` on disconnect, which frees the session slot. On RobotWare 6 and 7 the logout also ends the session's mastership; on RobotWare 8 write access persists past the session, so `disconnect()` releases it first, and the with-id mastership tokens with it; on RobotWare 8, a motion-control allowance this client may have made is withdrawn as the first request of `disconnect()`
- **Refusals in plain words, with a next step** - every refusal says what is missing, who can supply it, and (`refusal.remedy`) what to do next; the client never takes that step itself
- Request rate limiting (< 20 req/sec)
- Fully typed public API - every method throws `RwsError` with a typed `code`
- Single dependency: `ws` (only one we don't reimplement)

---

## Installation

```bash
npm install abb-rws-client
```

**Requirements:** Node.js 20+.

### Build from source

```bash
git clone https://github.com/ichbinmeraj/abb-rws-client.git
cd abb-rws-client
npm ci
npm run build
npm test
npm run readme:check
npm pack
```

`npm test` runs the offline suite; the live suites need a controller and skip without
one. `npm run readme:check` fails when the operation tables below disagree with the
code. `npm pack` runs the build and the tests again and writes
`abb-rws-client-<version>.tgz`. Every text file checks out with LF on every platform
(`.gitattributes`), so the same commit packs to the same bytes on Windows, macOS
and Linux.

---

## Quick Start (auto-detect)

The simplest path: `createClient` probes the controller and returns the right protocol's client.

```ts
import { createClient, RwsClient2 } from 'abb-rws-client';

const client = await createClient({
  host: '192.168.125.1',
  // username/password default to 'Admin' / 'robotics' (built-in admin account, full UAS grants).
  // The client logs in once, as this user: a refused login throws AUTH_FAILED and no other
  // account is tried, so pass the account you mean (an IRC5 ships with 'Default User').
  username: 'Admin',
});

console.log(`Connected via ${client instanceof RwsClient2 ? 'RWS 2.0' : 'RWS 1.0'}`);

const state = await client.getControllerState();   // 'motoron' | 'motoroff' | …
const mode  = await client.getOperationMode();     // 'AUTO' | 'MANR' | 'MANF'
const joints = await client.getJointPositions();   // { rax_1, …, rax_6 }

await client.disconnect();
```

If you only target one protocol, skip the helper and instantiate the client directly. See [`examples/`](./examples/) for runnable scripts.

---

## Finding controllers

Don't know the host or port? `findControllers` finds the controllers that answer on the ports and hosts you allow - including RobotStudio virtual controllers, whose RWS ports are reassigned on every restart - and returns one merged entry per controller:

```ts
import { findControllers, createAdapter } from 'abb-rws-client';

// Default: this PC only. Nothing leaves this PC.
const { controllers, localScan, notes } = await findControllers();
for (const c of controllers) {
  // c.key 'local:9403', c.generation 'rws2', c.https true, c.rwVersion '7.21.4+417' (from the VC's folder)
  console.log(c.key, c.generation, c.https, c.rwVersion ?? '', c.systemName ?? '');
}

// Then connect to one of them.
const pick = controllers[0];
const adapter = await createAdapter({
  host: pick.host, port: pick.port, https: pick.https ?? undefined,
  username: 'Default User', password: 'robotics',
});
```

Reaching other machines is opt-in, source by source:

```ts
const result = await findControllers({
  serviceAddress: 'auto',                       // 192.168.125.1, only when this PC has a 192.168.125.x address
  manual: [{ host: 'cell7-robot' }, { host: '10.0.5.21', port: 443 }],
  ranges: ['10.0.5.0/28'],                      // read "What discovery sends" first
  mdns: true,
  onProgress: e => console.log(e.phase, `${e.probed}/${e.total}`, e.found),
  signal: AbortSignal.timeout(60_000),          // resolves with aborted: true and the partial list
});
```

`RobotManager.findControllers(options)` is the same function.

### Sources

| Source | Option | Default | What it does |
|---|---|---|---|
| This PC | `local` | on | Reads this PC's listening TCP ports from the OS and probes them on 127.0.0.1. On Windows only the ports of RobotStudio virtual-controller processes (`RobVC.exe`, `Vrchost64.exe`) are probed (`filterToVcProcesses`, default true); a relay or tunnel on loopback goes in `manual` |
| Service address | `serviceAddress` | off | 192.168.125.1, the controller's service port. `'auto'` probes it only when one of this PC's IPv4 interfaces is in 192.168.125.0/24 |
| Manual | `manual` | none | Up to 16 hosts you name, IPv4 or a host name (looked up once, IPv4 only), with or without a port and scheme. A name with only an IPv6 address is skipped with a note (RobotWare does not support IPv6) |
| Ranges | `ranges` | none | Up to 16 IPv4 ranges, CIDR (`'10.0.5.0/24'`) or dash (`'10.0.5.20-10.0.5.60'`), private addresses only unless `allowPublicRanges`; at most `maxRangeHosts` addresses in all (default 256, at most 4096) |
| mDNS | `mdns` | off | One DNS-SD query; answers are merged with the probed entries |

Every entry carries `sources`, `key` (`discoveryKey(host, port)`: `'local:<port>'` for any address of this PC, else `'<ipv4>:<port>'`), `generation` (`'rws1'` / `'rws2'`, from the 401 challenge), `identified` (true only for the RWS realm `validusers@robapi.abb` or a login), and on this PC the owning `process` and `isVirtual` where the OS reports them. A RobotStudio VC seen on 127.0.0.1 and announced over mDNS on this PC's LAN address is one entry.

### How far to go to name a controller: `identify`

| `identify` | `mdns` | mDNS packets leave this PC | mDNS fields attached | Local VC folder read | Logins |
|---|---|---|---|---|---|
| `'none'` | false | no | - | no | none |
| `'none'` | true | yes, one query | yes | no | none |
| `'anonymous'` (default) | false | no | - | yes | none |
| `'anonymous'` | true | yes | yes | yes | none |
| `'with-credentials'` | either | as `mdns` | yes | yes | one per identified entry with a matching `credentials` entry |

`mdns` alone decides mDNS traffic; `identify` decides only reads on this PC and logins. `'none'` makes no authenticated read: it sends exactly one unauthenticated `GET /rw/system` per probe. The local VC folder read (Windows) reads the system name and RobotWare version of a running OmniCore VC from its system folder on this PC; it sends nothing over the network. Under `'with-credentials'` a controller is logged in to only with a `credentials` entry for it (keyed by `discoveryKey`, `'host:port'` or `'host'`, matched against the entry's own address or the name you typed, never against another address merged into it; no default user is ever tried), one login at a time, each followed by `/logout`; credentials are never sent over plain HTTP to another computer.

### Ports

Remote hosts (service address, manual and range addresses without a port) are probed on the real controllers' ports, HTTPS first; HTTP is tried only where HTTPS found the port open but not speaking TLS, or the TLS handshake got no answer (an IRC5's plain-HTTP server on 80 leaves it unanswered):

| Port | Scheme | Why |
|---|---|---|
| 443 | HTTPS | OmniCore |
| 80 | HTTPS | The RW 8.1.1 virtual controller serves HTTPS on 80 |
| 80 | HTTP | IRC5, RWS 1.0 |

`ports` (up to 8) adds ports for every host that has no port of its own. The virtual-controller ports are tried on loopback only (a VC accepts RWS connections from its own PC only):

| Port | Scheme |
|---|---|
| 5466, 9403, 9805, 11622 | HTTPS (OmniCore VCs) |
| 11811, 28447 | HTTP (IRC5 VCs) |

Both tables together are `KNOWN_RWS_PORTS`, which `probeHost`, `createClient` / `createAdapter` without a port, and connect-time recovery use on any host. A port listed with one scheme is probed with it; port 80 and any port not in the tables are tried over HTTPS and HTTP.

### What discovery sends

- **This PC:** nothing leaves this PC. Each listening port is probed on 127.0.0.1: on Windows the ports of RobotStudio virtual-controller processes; on Linux and macOS, where no virtual controller runs, only listeners on the known RWS ports and `ports` (`filterToVcProcesses: false` probes every listener except ports of industrial protocols).
- **Service address** (only when turned on): up to 3 TCP connections to 192.168.125.1.
- **Manual:** up to 3 connection attempts per host (443; 80 over TLS; 80 over HTTP only when 80 is open and does not speak or answer TLS, as on an IRC5), plus up to 2 per extra port, plus one DNS lookup per host name, which goes to the configured DNS server (often the company's).
- **Ranges:** the same per address, new connections at least 100 ms apart (at most 10 per second; `pacing.remote.minGapMs` can raise the gap, never lower it), 8 in flight by default and up to 16 when you ask (`pacing.remote.concurrency`), at most 2 in flight per host. A /24 takes at least 51 s at these numbers (254 addresses x at least 2 attempts at 10 per second), plus the timeout of every silent address.
- **mDNS** (only when turned on): one multicast query to 224.0.0.251:5353 on each non-internal IPv4 interface, VPN adapters included, repeated twice in the first second.
- **Every probe** is one unauthenticated `GET /rw/system` with `Accept: application/xhtml+xml;v=2.0` and `User-Agent: abb-rws-client/<version> discovery`, plus the TLS handshake on HTTPS. Timeout `timeoutMs` (default 1500 ms).

> **Ranges and company networks.** Scanning a range opens TCP connections to every address in it. On a company network IT can see these attempts, and intrusion detection may flag them. Off unless you turn it on; ask before you scan a network you do not run.

### What discovery runs on your PC

- Windows: `netstat.exe -ano` and `tasklist.exe` (the VC process filter) on every run with `local` on; `powershell.exe` with one CIM process read of the VC processes' command lines when `identify` is not `'none'` and an OmniCore VC is found; `powershell.exe` with `Get-NetTCPConnection` only with `localFallback.powershell`. A blind loopback connect sweep runs only with `localFallback.sweep`, after the listening-port sources that ran (`netstat`, and `Get-NetTCPConnection` when turned on) failed.
- Linux: a read of `/proc/net/tcp` and `/proc/net/tcp6`, then `ss -ltn` if that fails. Inside WSL the result carries a note: VCs on Windows may not be visible from there.
- macOS: `netstat -an -p tcp`, then `lsof` if that fails.

All are read-only and run without a shell. `localScan` in the result says which source answered and how each attempt ended (`ok`, `missing`, `timeout`, `failed`, `unrecognised`, `skipped`); a source that fails never fails the call. When no source could list the ports (and no sweep ran), `notes` says so: VCs on this PC were then not searched, and one can still be added as `127.0.0.1:<port>`.

### Results, errors, cancelling

`findControllers` resolves with `{ controllers, aborted, localScan, environment, tlsFailures, unmatchedCredentials, notes }`. Entries on this PC come first by port, then other hosts by address and port. Invalid options (a bad host, port, range or count, a cap exceeded, credentials without `'with-credentials'`, any `loopbackOnly` violation) reject with `RwsError` `INVALID_ARGUMENT` before any socket, process or DNS lookup; nothing else rejects. `signal` cancels: the call then resolves with `aborted: true` and the entries found so far, once every socket is closed and every login already sent has logged out.

`loopbackOnly: true` refuses, before anything is sent, every target off this PC's loopback (`serviceAddress` and `mdns` must be off, manual hosts and ranges in 127.0.0.0/8). The client's own test helpers and scripts discover with it.

TLS: RobotStudio VCs use a self-signed certificate for 127.0.0.1, and real controllers ship a self-signed certificate by ABB default (real controllers not checked here), so certificates are not verified unless `strictTls: true`. Every HTTPS entry carries `tlsFingerprint` (SHA-256); `pinnedFingerprints` gives trust on first use for discovery's own logins (`identify: 'with-credentials'`) only, and under `strictTls` an address whose certificate fails verification is listed in `tlsFailures` instead of going missing. See [TLS certificates](#tls-certificates) for how to trust a controller's certificate.

### Older entry points

They stay and keep their signatures:

- `RobotManager.discoverControllers(extraHosts?)` - this PC's listening ports plus every `KNOWN_RWS_PORTS` entry on 192.168.125.1 and on each extra host. It always probes the service address; an extra host that is not an IPv4 address or host name is dropped with a warning. Results: this PC first, then other hosts by address and port.
- `RobotManager.discoverLocalControllers(host?)` - the listening-port scan of this PC alone, each port probed on `host` (default 127.0.0.1), in port order. It falls back to `wideHostScan` only when the OS gives no listening-port list at all, and only for a loopback host.
- `RobotManager.wideHostScan(host)` - a blind connect sweep of a loopback address (80, 443 and 1024-65535, without a fixed list of industrial-protocol and printer ports); any other host is refused with `INVALID_ARGUMENT`.
- `RobotManager.discoverControllersMdns(opts?)` / `discoverControllersMdns` - mDNS only, with RobotWare metadata. A RobotStudio VC announces itself only when a Bonjour responder runs on its PC, so the listening-port scan is the reliable way to find VCs.

---

## Choosing a client

| Controller | Protocol | Class | Auth | Default port |
|---|---|---|---|---|
| **IRC5** (RobotWare 6.x) | RWS 1.0 | `RwsClient` | HTTP Digest | 80 HTTP (real); a VC gets a port from RobotStudio (11811, 28447 seen) |
| **OmniCore** (RobotWare 7.x / 8.x) | RWS 2.0 | `RwsClient2` | HTTP Basic | 443 HTTPS (real); a VC gets a port from RobotStudio (80 HTTPS on RW 8.1.1, 5466, 9403, 9805 seen) |

Port 80 can be either scheme: plain HTTP on an IRC5, HTTPS on the RW 8.1.1 virtual controller. Without `https`, `createClient` / `createAdapter` try both on 80 and on any port not in [the port tables](#ports).

Building an app that runs on the OmniCore FlexPendant? ABB's [OmniCore App SDK](https://developercenter.robotstudio.com/omnicore-sdk) is made for that. This client is for code that runs on a PC or a server, and it speaks RWS 1.0 to IRC5 as well as RWS 2.0 to OmniCore.

The two generations expose one API: `RwsClient2` carries **312 public methods** (counted from the generated type declarations, so TypeScript-private helpers are excluded), the RWS 1.0 side is checked by `npm run conformance` against what live controllers advertise (the last full crawl, 2026-10-03, did not get below `/rw`; see `CONFORMANCE.md`), and the shared cross-protocol contract - **`IRWSAdapter`, 226 methods** (59 required + 167 optional) (controller state, RAPID execution, modules, variables, motion, I/O, file service, CFG database, mastership, event log, search, …) - has the same names and signatures on both. The protocol differences (URL shapes, query-action vs path-action forms, response format, mastership-domain naming, `$HOME` vs `HOME`) are handled internally - your code looks the same.

If you need a single typed reference that holds either:

```ts
import { createAdapter, type IRWSAdapter } from 'abb-rws-client';

const adapter: IRWSAdapter = await createAdapter({ host: '192.168.125.1' });
// adapter is RWS1Adapter or RWS2Adapter - both implement IRWSAdapter
```

---

## RWS 1.0 explicit usage

```ts
import { RwsClient, RwsError } from 'abb-rws-client';

const client = new RwsClient({
  host: '192.168.125.1',
  username: 'Admin',
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

## RWS 2.0 explicit usage

```ts
import { RwsClient2 } from 'abb-rws-client';

// RWS 2.0 takes a base URL (scheme + host + port).
//   Real OmniCore:  https://<host>:443
//   OmniCore VC:    https://127.0.0.1:5466
const client = new RwsClient2(
  'https://127.0.0.1:5466',
  'Admin',
  'robotics',
);

await client.connect();

// Same method names as RWS 1.0 - only the underlying protocol differs.
console.log('state:', await client.getControllerState());
console.log('joints:', await client.getJointPositions());

// RAPID variable read - RWS 2.0 symbol API uses suffix-style URLs internally
// (`/rw/rapid/symbol/{symburl}/data`); the method shape is the same.
const tool0 = await client.getRapidVariable('T_ROB1', 'BASE', 'tool0');

// WebSocket subscriptions over the `rws_subscription` subprotocol
// (RWS 1.0 uses `robapi2_subscription` - the names are NOT interchangeable:
// RobotWare 7 rejects the 1.0 name with HTTP 400).
const unsubscribe = await client.subscribe(
  ['controllerstate', 'execution'],
  (event) => console.log(event.resource, '=', event.value),
);

await unsubscribe();
await client.disconnect();
```

### Notable RWS 2.0 quirks (handled automatically)

These are documented because they bite anyone who tries to write an RWS 2.0 client from scratch:

- **HTTP Basic auth**, not Digest (RWS 1.0), sent only until the controller issues a session
  cookie; after that each request carries the cookie alone (a Basic login on a request without
  the cookie starts another session). When the controller answers 401 to the cookie (the
  session idled out after about 5 minutes, or the controller restarted), the client logs in once
  with `GET /rw/system` and the credentials, then sends the request once more with the new
  cookie, which is used from then on.
- **XHTML responses only** - `Accept: application/json` returns 406. Library uses `Accept: application/xhtml+xml;v=2.0`.
- **Path-based actions** - `/rw/rapid/execution/stop`, not `?action=stop`.
- **Mastership domains collapsed** - both `'rapid'` and `'cfg'` map to `'edit'`. The adapter maps internally so either name works.
- **File service home** is `'HOME'`, not `'$HOME'`.
- **Symbol API path is suffix-style** - `/rw/rapid/symbol/{symburl}/data` (RWS 1.0 puts `/data` at the front).
- **Module unload** is `POST /rw/rapid/tasks/{task}/unloadmod` with body, NOT `DELETE` on the module URL (returns 405).
- **Self-signed TLS** - RobotStudio VCs and, by ABB default, OmniCore controllers use
  self-signed certificates (real controllers not checked here), so certificate
  verification is off by default and a warning says so once per controller. Pass
  `strictTls: true` (`RobotManagerOptions`) or `rejectUnauthorized: true`
  (`RwsClient2` options) to check it; see [TLS certificates](#tls-certificates).
- **Response limits** - a body over `maxResponseBytes` (default 64 MiB) is refused with
  `NETWORK_ERROR`, and `requestDeadlineMs` (default 120 s) bounds one request end to end
  (0 turns it off; values above 2^31-1 ms are capped there); `timeout` is the idle limit
  (`RwsClient2` options), above 0 and at most 2^31-1 ms: no value turns it off,
  and 0 is refused at construction. A DIPC read's wait is added to both for that one read.
- **WebSocket subscription URL** comes from the `Location` header (real hardware) or the XHTML body (VC). Subprotocol: `rws_subscription` (RWS 2.0) / `robapi2_subscription` (RWS 1.0).

---

## TLS certificates

RobotStudio's virtual controllers present a self-signed certificate for 127.0.0.1, and
OmniCore controllers ship a self-signed certificate by ABB default (real controllers not
checked here), so the client does not check a controller's certificate unless asked.

- **Turn the check on** with `strictTls: true`: `RobotManagerOptions` (also the options of
  `MultiRobotManager` and `MultiRobotManager.fromConfigs`), `ConnectOptions` of
  `createClient` / `createAdapter`, and `findControllers`. On `RwsClient2` it is
  `rejectUnauthorized: true`. RWS 1.0 over https always checks.
- **What it is checked against**: Node's default authorities (with `NODE_EXTRA_CA_CERTS`) and
  the operating system's certificate store (Node 22.15 and later; on an older Node, Node's own
  default), the same set for discovery, the protocol probe, and RWS 2.0's requests, subscription
  POST and WebSocket. RWS 1.0 over https checks against Node's own default set (its bundled
  authorities and `NODE_EXTRA_CA_CERTS`); the client does not add the operating system's store
  to it, though a host such as VS Code may. The certificate must also name the host or address
  you connect to.
- **Trust a controller's certificate** by giving the certificate, or the CA that signed it, to
  that set: in a PEM file (one or more certificates) named by `NODE_EXTRA_CA_CERTS`, which Node
  reads once when it starts (`NODE_EXTRA_CA_CERTS=/path/cell-a.pem node app.js`), or in this PC's
  store of trusted root certificates (RWS 2.0 and discovery, Node 22.15 and later). A controller's own self-signed certificate can be given
  this way: it is then its own CA, and only a certificate signed with its key verifies
  (`tests/tlsWarning.test.ts` checks this with a self-signed certificate for 127.0.0.1; not tried
  against a controller here). Take the certificate from whoever installed it on the controller,
  or save the one the controller presents over a link you trust, such as a cable to its service
  port (for example with `openssl s_client -connect <host>:443 -showcerts`); `findControllers`
  reports the SHA-256 fingerprint it saw as `tlsFingerprint`.
- **Pinning is not offered yet**: no option ties a connection to one certificate or fingerprint
  per controller. `findControllers`' `pinnedFingerprints` decides only whether discovery logs in
  to an entry (`identify: 'with-credentials'`); `createClient`, `createAdapter`,
  `RobotManager` and `RwsClient2` do not read it. Trusting the controller's own certificate, as
  above, is the nearest.
- **Without the check**, the RWS 2.0 client logs one warning per process for each host and port
  (`Logger.warn`, see [Logging](#logging)) before the first request, subscription POST or
  WebSocket that goes out unchecked, naming `strictTls` and the steps above. These are the
  connections that carry the credentials and the session cookie; the unauthenticated probes of
  discovery and of a connect send neither and log nothing. Nothing is logged for this PC's
  loopback (127.0.0.0/8, `::1`, `localhost`), where the client reaches the virtual controllers
  and the connection does not leave the PC; a virtual controller reached by one of this PC's
  network addresses is warned about, a tunnel or proxy on loopback to a controller elsewhere is
  not.

---

## Multi-robot orchestration

For applications that talk to several controllers, use `MultiRobotManager`:

```ts
import { MultiRobotManager } from 'abb-rws-client';

const multi = MultiRobotManager.fromConfigs([
  { id: 'cell-A', name: 'Cell A IRB120',  host: '192.168.125.1', port: 80,   useHttps: false, username: 'Admin', password: 'robotics' },
  { id: 'cell-B', name: 'Cell B IRB1200', host: '192.168.125.2', port: 443,  useHttps: true,  username: 'Admin', password: 'robotics' },
], {
  refreshIntervalMs: 1000, // polling cadence (min 200); slow poll scales at 5×
  strictTls: false,        // true = verify controller TLS certificates
});

multi.onError((msg, actions) => {
  console.error(`Robot error: ${msg}`);
  return Promise.resolve(undefined); // headless: just log
});

multi.onDidChange(() => {
  console.log(`active=${multi.activeId} state=${multi.state.ctrlstate}`);
});

for (const { id } of multi.entries) {
  await multi.connectRobot(id);
}
// One robot is "active" at a time (handy for UIs); state for all is polled.
multi.setActive('cell-B');
```

`MultiRobotManager` wraps individual `RobotManager` instances. Each `RobotManager` handles its own:
- Auto port discovery: with no port given it probes the `KNOWN_RWS_PORTS` table (443 HTTPS, 80 HTTPS and HTTP, 5466, 9403, 9805, 11622 HTTPS, 11811, 28447 HTTP) and takes the first that answers. When a saved port stops answering, recovery probes the same table and, on this PC, the OS listening ports (RobotStudio reassigns VC ports on every restart), and adopts a candidate only by its system id, or as the only candidate of the expected protocol when no system id is known
- Protocol auto-detection (`WWW-Authenticate: Digest` → RWS 1.0; `Basic` → RWS 2.0)
- Hybrid polling cadence: **5× the refresh interval when WebSocket subscriptions are active** (positions only - state-change resources stream over WS); **the plain refresh interval when subscriptions are unavailable** (full state coverage via polling). Default 1 s / 5 s, configurable via `refreshIntervalMs`.
- WebSocket subscriptions on both protocols, with dropped-socket auto-reconnect and automatic degradation to fast polling if the event stream is terminally lost
- Reconnect-on-failure (3-strike, surfaces via `onError` listener)
- Clean `GET /logout` on disconnect, which frees the session slot. RobotWare 6 and 7 end the session's mastership on logout; RobotWare 8 write access persists past the session, so `disconnect()` releases it (and any with-id mastership tokens) before the logout. On RobotWare 8 the first request of `disconnect()` withdraws a motion-control allowance the manager may have made (see [RobotWare 8 motion control](#robotware-8-motion-control))

`multi.disconnectAll()` disconnects every robot at once (`Promise.allSettled`),
for a host that is closing: each manager sends its RobotWare 8 withdrawal as its
first request, so every withdrawal goes out before any slow step of any robot's
teardown. It never rejects, and the robots stay configured. `removeRobot(id)`
takes the robot out of the lists at once and returns the disconnect's promise,
which settles after the withdrawal and the logout and never rejects; code that
ignores it is unchanged.

On RobotWare 8, give each robot its control-station identity with
`controlStation` in its `RobotConfig`, or one for all robots in the options (see
[RobotWare 8 control-station identity](#robotware-8-control-station-identity)).

You can also create a `RobotManager` directly if you only have one robot.

---

## `RobotManager` - higher-level surface

`RobotManager` wraps either client with operational helpers that handle mastership, polling, and protocol differences for you. In addition to delegating every protocol method to the underlying client, it exposes:

- **`requestRmmp(level = 'modify', { waitMs?, pollMs?, signal?, onPending? })`**, **`getRmmpPrivilege()`**, **`pollRmmp()`**, **`cancelRmmp()`** - RMMP (Request Manual Mode Privileges), ABB's manual-mode counterpart of a mastership request: in manual mode mastership needs RMMP granted by an operator at the FlexPendant first (a jog also needs a local client, which RMMP does not make this tool). `requestRmmp` sends the request, polls it every second so it outlives ABB's 10 s window, and resolves `{ outcome: 'granted' | 'denied' | 'expired' | 'cancelled' | 'held-lower', privilege, detail }`; on expiry or abort it cancels the request. When the controller never reported the request as waiting, an `expired` result says so and names the last poll and privilege answers instead of saying no one granted it; every answer is logged at trace level. It sends the level asked for, `modify` or `exec` (`exclusive` is the deprecated alias of `exec`), and the controller decides: a RobotWare 7.21.4 virtual controller refused `exec` in MANR with the enabling-device answer, also with Enable held at the virtual FlexPendant, and that refusal is thrown with its explanation. It refuses RobotWare 8 (no RMMP; nothing is sent) and sends nothing when this session already holds a level that covers the one asked for (`exec` covers `modify`). Asked for `exec` while this session holds `modify`, it sends nothing and resolves `held-lower`: call `cancelRmmp()` first, then request `exec`. A second request while one of this session waits is refused with `CONTROLLER_BUSY`, also before sending. On RobotWare 7 the request is sent in any mode: ABB accepts it in MANR only, and the controller's refusal outside MANR is passed on as `rmmp-wrong-mode`. Start it from a person's action and show them the wait (`onPending`). Pair a grant with `cancelRmmp()`; `disconnect()` cancels too. ABB states no lifetime for a grant; on RobotWare 7.21.4 a granted `modify` was still held after 180 s, and longer was not measured. `getRmmpPrivilege()` reads `none`, `pending modify`, `modify` or `exec` (`unsupported` on RobotWare 8) and throws a failed read instead of reporting `none`.
- **`jog({ mode, axes, speed, mechunit?, incMode? })`** - one jog step, not a move to a position: `axes` are sent as ABB's `axis1`..`axis6`, which ABB documents without a unit (its sample sends `axis1=900` with `inc-mode=Large`); the sign sets each axis's direction, and on RW 8.2.1 one call with axis 5 set to 1 and the default `Small` increment moved it about 0.01 degree. One jog request after a pre-flight read fresh from the controller (on RobotWare 6 and 7 in manual mode there is no RMMP check: ABB's jog pages require a local client with mastership, which RMMP does not make this tool, so the jog is sent and a refusal says so): the operating mode, the motors and, on RobotWare 8, the station's motion-control declaration are read but not required: the jog is sent and the controller decides. A refusal of the jog request itself that the controller does not explain more specifically is explained with that reading (a refused motion-system read or unit selection before it keeps its own explanation): `WRONG_MODE` outside a manual mode, or on RobotWare 6 in MANF, where ABB disables jogging in manual full speed; `MOTORS_OFF`; or `motion-control-off`, which then says motion control "may be the reason" (evidence `unverified`; its remedy is to check, and allowing motion control is another way). The controller's own -1073435864 answer is `motion-control-off` with the remedy `declare-motion-control`. Only a person allows motion control (`RobotManager.setAllowMotionControl(true)`, RobotWare 8 only, which registers the station first; see [RobotWare 8 motion control](#robotware-8-motion-control)). It holds motion mastership (RobotWare 6/7) or write access (RobotWare 8) from the first jog until 2 s after the last, except that on RobotWare 6 and 7 a `startRapid` or a `stepRapid` ends that hold first: ABB's RobotWare 7 start page says a start does not succeed while the client holds motion mastership, and on RobotWare 6 ending it is a precaution. A motion hold you took with `requestMastership('motion')` or `requestMastershipAll()` covers the jogs instead and stays yours until you release it. The request carries exactly ABB's jog form: `axis1`..`axis6`, `ccount` (the controller's change count, read right before) and `inc-mode` (`incMode`, default `'Small'`). `mode`, `speed` and `mechunit` are not sent: the controller jogs the unit selected for jogging in that unit's jog mode. A named `mechunit` (a RAPID name such as `ROB_1`, compared without case) it does not have selected is selected first with `setMechunitForJogging` (under the same motion hold), and the jog is sent only when the controller then names it. That selection is not restored after the jog: the controller's and the FlexPendant's jog unit stays changed. On RobotWare 6 and 7 a remote jog has not been seen to succeed yet (see Known limits); a refusal is passed on as the controller gave it.
- **`getMastershipStatus(domain?)`** - read who currently holds rapid/cfg/motion mastership (uid + application name).
- **`requestMastership(domain)`** / **`releaseMastership(domain)`** - keep a hold across several writes. Holds are counted per lock the controller really has (RobotWare 6: cfg, motion, rapid; RobotWare 7: edit - which `rapid` and `cfg` both name - and motion; RobotWare 8: the one control-station write access), and the manager's and adapters' own write wraps share the count: inside your hold they request nothing more and never end it, and the release goes on the wire when the last hold on the lock ends. Writes that take access run one at a time per controller; one that waits more than 10 s for the write in progress is refused with `CONTROLLER_BUSY` and not sent.
- **`state.access`**, **`onAccessEvent(fn)`** - what the session holds per lock and since when, and every change to it: a lock granted or released, a hold lost (a write refused as not held, a re-issued session, an operating-mode change, a lapsed RobotWare 7.8+ watchdog, a lost connection) with the reason. After a loss the client never takes the access back by itself; the next operation requests afresh. See [Lost holds](#lost-holds-and-robotstateaccess).
- **`stopRapid()`**, **`setMotorsOff()`** - sent first, never waiting for mastership or write access. Only a "not held" refusal makes the manager request access, send once more and release; any other refusal is passed on with the controller's code and names the holder when the controller says who. A stop over RWS is a program stop, not a safety stop - use the emergency stop for safety.
- **`startRapid()`** - starts from where the program pointer is: the start does not move the program pointer. To run a routine from its start, call `setPPToRoutine` first. On RobotWare 6 and 7 a start right after a `jog` first ends the jog's own motion hold (see `jog` above). On RobotWare 8 a virtual controller (8.2.1) refused a start from a station for which motion control was not allowed, also for a program that does not move the robot, and ran it once it was allowed; another station, which registers with its own id, read it as not allowed. That refusal (-1073435864) is `GRANT_DENIED` with `refusal.kind` `motion-control-off` on every call that gets it. The refusal's `remedy` is `declare-motion-control`. It names `setAllowMotionControl(true)` and the confirmation a person gives; the client never calls it.
- **`setAllowMotionControl(allow)`**, **`getAllowMotionControl()`**, **`getLocalStationStatus()`** - RobotWare 8 only (`UNSUPPORTED_OPERATION` on 6 and 7, nothing sent): allow or withdraw motion control for this control station, read it (null, and nothing sent, before the session is a registered control station), and read whether the FlexPendant is connected (`{ flexPendantConnected, safetyProtocolConnected }`, each null when its read fails or its answer has no such field; ABB's `control-station-local-isconnected` and `is-connected`). See [RobotWare 8 motion control](#robotware-8-motion-control).
- **`read(name, ...args)`** - one read of the adapter by its name, for the reads with no manager method of their own (`AdapterReads` lists each one's arguments, answer and generation; `ADAPTER_READ_NAMES` the names): `getEventLogMessage(domain, seqnum, lang?)`, `getEventLogMessageBySeqnum(seqnum, lang?)` (RWS 2.0), `listEventLogDomains()`, the RobotWare 8 control-station reads `getControlStationType()`, `getControlStationId()`, `isLocalControlStationConnected()`, `getTpuSafetyProtocolStatus()` and `getWriteAccessAppealChangeCount()`, `listCurrentUserGrants()`, `checkGrantExists(grant)` (RWS 2.0), `describeReturnCode(code)` (the code in words, with its severity), `getBuildErrors(task)` (a program's build errors) and `getExecutionErrorState()` (RobotWare 8.2 and later: whether the last stop was caused by an error). The adapter's own method runs on the manager's session and its answer and errors pass through unchanged. A name that is not one of these reads is `INVALID_ARGUMENT`; a read the adapter does not have (RobotWare 6 has no control stations, for one) is `UNSUPPORTED_OPERATION`; nothing is sent for either. **`appealWriteAccessRelease()`** - RobotWare 8: ask the station that holds write access to release it (ABB's `POST /rw/controlstation/writeaccess/release/appeal`); the holder decides. ABB lists a registered control station as its prerequisite, so the session registers first when it is not yet, as for `setAllowMotionControl`; it takes no write access. `UNSUPPORTED_OPERATION` on RWS 1.0.
- **`setPPToRoutine(task, module, routine, { stopIfRunning? })`**, **`unloadModule(task, module, { stopIfRunning? })`**, **`unloadProgram(task, { stopIfRunning? })`**, **`loadProgram(localFile, task, { stopIfRunning?, resetPP? })`** - never stop a running program unasked: each reads the execution state first; `stopIfRunning: true` stops the program before the write. Without it the write is sent anyway (ABB lists no execution-state prerequisite for these) and the controller decides; while the program ran, an execution-state refusal (-1073442809) or a 400 or 403 the controller leaves unexplained is explained as the running program (`WRONG_MODE`, `refusal.kind` `wrong-state`), and a refusal the controller explains more specifically, a mode refusal (-1073445860) among them, keeps its own explanation. `loadProgram` unloads a loaded module of the same name, uploads the file to `$HOME`, loads it and, when it declares `PROC main()`, sets the program pointer to main (`resetPP: false` skips that); any failed step fails the call, and the message says which step failed and what was already done. `loadProgram` reads the local file as UTF-8 and refuses it with `INVALID_ARGUMENT` before anything is sent when it is not valid UTF-8 (the message names the line of the first bad byte sequence) or when it has no text. A file saved as Windows-1252 or Latin-1 with accented letters is refused this way. Up to 1.5.1 those bytes were uploaded as U+FFFD replacement characters. A byte order mark is sent as it is.
- **`activateAllRapidTasks()`**, **`deactivateAllRapidTasks()`** - RWS 2.0 sends one request per task: a refused task makes the call throw, naming the tasks that were done and each refused task with the controller's reason. RWS 1.0 sends ABB's one all-tasks action.
- **`setOperationMode('AUTO' | 'MANR' | 'MANF')`** - RWS 2.0 only: on RobotWare 6 (RWS 1.0, which has no operating-mode change) it throws `UNSUPPORTED_OPERATION` before sending anything, mastership included. Verified on virtual controllers only: ABB's RWS 2.0 pages require Local Client privileges for it, which station virtual controllers do not enforce for a remote session; a real controller may refuse it, and a refusal says so. Switch with auto-routing through MANR for AUTO ↔ MANF (the controller rejects direct transitions). Acquires `edit` mastership for the higher-privilege direction on RobotWare 7; on RobotWare 8 holds control-station write access around every switch, and sends nothing when that access is refused. A switch to Auto then waits in `AUTO_CH` until someone confirms it at the FlexPendant (RobotWare 7.21 and 8.2 virtual controllers): the confirmation is the person's there, and `setOperationMode` does not send it. No controller state is read before a switch: an RW 8.2.1 virtual controller in guard stop accepted it both ways.
- **`setSpeedRatio(0..100)`** - holds `edit` mastership (RobotWare 7) or control-station write access (RobotWare 8); sends `speed-ratio=N` with `?action=setspeedratio`, a query the controller ignores: the documented plain POST works the same (verified 2026-09-27 on RobotWare 7.21 and 8.1.1).
- **`createBackup(name)`**, **`restoreBackup(name, { deleteBackup? })`**, **`getBackupStatus()`**, **`listBackups()`** - `/ctrl/backup/...`. A restore keeps the backup it restored; `{ deleteBackup: true }` deletes it afterwards (ABB's `delete-dir` on both generations, which the controller otherwise defaults to true; the client always sends it).
- **`callServiceRoutine(task, name, args?)`** - throws `UNSUPPORTED_OPERATION` on RWS 2.0: the resource is a GET listing. Run a service routine by setting the program pointer to it (`setPPToServiceRoutine`) and starting.
- **`setPPToServiceRoutine(task, routine, module?, { stopIfRunning? })`** - the controller decides the mode: ABB documents PP to routine for a remote client in Auto on RobotWare 6 and 7 (in manual on RobotWare 7 only with RMMP `exec`), and RobotWare 8.2.1 in MANR with write access accepted it. One case is held back before anything is sent: RobotWare 8 in Auto (`WRONG_MODE`), where no run has shown it works. Then reads the task's service-routine listing and refuses a routine not in it (`INVALID_ARGUMENT`), then calls `setPPToRoutine`. The start stays with the caller.
- **`calcJointsFromCartesian(...)`** - inverse kinematics. **`calcCartesianFromJoints(...)`** - forward kinematics.
- **`setActiveTool(mechunit, name)`**, **`setActiveWobj(mechunit, name)`** - switch active persistent tooldata / wobjdata.
- **`getJointTargetFull(mechunit?)`**, **`getCartesianFull(mechunit?)`**, **`getMechunitDetails(mechunit?)`** - one-request motion reads for a sampler of your own (joint positions cannot be subscribed to on any generation, so they must be polled): every axis slot incl. external axes, the TCP pose, and the unit's typed description (type, axis count, driving task, mode, active tool/wobj). They throw `NOT_CONNECTED` instead of returning an empty value, and ride the manager's own session, whose request spacing keeps you under the controller's 20 req/s limit.
- **CFG write** - `setCfgInstance` / `createCfgInstance` / `removeCfgInstance` / `loadCfgFile` / `saveCfgFile`, on **both** protocols (RWS 2.0 uses `instances/create-default` + the bracket value representation; RWS 1.0 uses the `?action=` forms - handled by the adapters). Each holds the configuration lock for the duration: CFG mastership on RobotWare 6, `edit` on RobotWare 7, write access on RobotWare 8 (see [Access each write takes](#access-each-write-takes)).
- **DIPC** - `listDipcQueues` / `createDipcQueue` / `sendDipcMessage` / `readDipcMessage` / `removeDipcQueue`. Bidirectional messaging between RAPID and external clients. `readDipcMessage(queue, timeoutMs)` lets the controller wait up to `timeoutMs` for a message (ABB's `timeout`, default 0); the client's own timeout for that read is extended by the wait. On RWS 1.0 the wait occupies the client's serial request queue, so every later request on that client waits until the read answers. `readDipcMessage` is a write despite its name: ABB's DIPC queue removes a message when it is read, so a message one client read is gone for every other reader. RWS has no read that leaves the message in the queue. `getDipcQueueInfo` reads the queue's counts without taking anything.
- **`listFileVolumes()`** - every controller volume (HOME, BACKUP, DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP).
- **`getModuleSource(task, name)`** - pull a module's RAPID text in one call. Works even when the module has no backing file in `HOME` (loaded from `.pgf`/RobotStudio/pendant): the client saves it to the controller's TEMP volume, reads it, and deletes it.
- **`compressPath(source, dest)`** / **`decompressPath(source, dest)`** - controller-side archive compression, both generations (RWS 1.0 uses the `?action=comp`/`dcomp` query-actions internally). The controller answers 202 and runs the job after that; both methods resolve at the 202 and return nothing. **`startJob(name, source, dest)`** sends the same request (`name` is `'compressPath'` or `'decompressPath'`, `CONTROLLER_JOB_NAMES`) and returns the job's progress id (`undefined` when the answer names none). To wait, poll **`getProgress(id)`** until `state` is no longer `pending` (ABB's finished state is `ready`); `details.code` is then the controller's return code, negative when the job failed. Decompress an archive only after its compress job is done.
- **`state.ioSignals`**, **`refreshIoSignals()`** - the signal table, walked whole (one request per page of signals) at the first poll of a connection and then at the first poll 60 s after the last walk that landed, timed by the clock; a failed walk is tried again after 5 s, 10 s, 20 s, 40 s, then each minute, never on every poll. `refreshIoSignals()` walks at once and starts the minute again. A value in the table can be a minute old: for a live one read the signal (`readIoSignal`), or add it to the manager's subscription group (`updateSubscriptionGroup`) and take its events from `onSubscriptionEvent`. `state.ioSignalsLoaded` says whether the table was loaded on this connection.
- **`searchSignals(criteria)`** / **`searchSignalsEx(criteriaSets)`** / **`searchIoDevices(criteria)`** - server-side I/O search on **both** generations: `name` is a case-insensitive prefix match (no glob - `*` matches nothing), `device`/`network`/`category` match whole values, criteria AND-compose, empty criteria return every signal; device search by name/lstate/network. RWS 2.0 pages hits at 100 and the client reads every page. No more paging the full signal list client-side.
- **`getModuleText(task, module)`** / **`getModuleTextRange(task, module, …)`** - read a module's source (or a row/col span) straight from the RAPID domain, with the change-count for optimistic concurrency against `setModuleText`/`setModuleTextRange`.
- **`checkMotionChangeCount(count)`**, **`saveEventLogRaw(dest)`**, **`renameFile(path, newName)`**, **`getVirtualTimeTimeslice()`** - motion-config freshness check, raw event-log export, in-place rename, VC timeslice - all on both generations.
- **`validateCfgFile(path, actionType?)`** - dry-run a CFG load before committing, on both generations (`path` is a bare volume path such as `$TEMP/x.cfg`). **`validateInstanceBeforeDelete(name)`** - dry-run a CFG instance delete, RWS 1.0 only (OmniCore has `validateCfgInstances` for existing instances).
- **`validateRapidValue(task, value, datatype)`** - pre-flight a literal before writing.
- **`RobotManager.findControllers(options?)`** *(static)* - the same as the `findControllers` export: this PC's VCs by default, and the service address, hosts you name, ranges and mDNS when you turn them on, one merged entry per controller. See [Finding controllers](#finding-controllers).
- **`RobotManager.discoverControllers(extraHosts?)`** *(static)* - the older entry point: this PC's listening ports plus the known ports on the service address and each extra host.
- **`RobotManager.discoverControllersMdns(opts?)`** *(static)* - ABB controllers (real or virtual) announcing on the local network via mDNS/Bonjour, with system name, host, RWS port, RobotWare version, system GUID and a `'rws1' | 'rws2'` classification. A VC announces itself only when a Bonjour responder runs on its PC.
- **Simulation panel** *(RWS 2.0 virtual controllers only)* - `simEmergencyStop()`, `simResetEmergencyStop()`, `simGeneralStop(engage?)`, `simAutoStop(engage?)`, `simEnableSwitch(on)`, `teleportMechunit(mechunit, joints, extJoints?)`. Drive the E-stop / guard-stop chain and reposition the simulated robot from the API. Throw `RwsError` on real hardware and RW6 (VC-only endpoints).

Every method returns `Promise<...>` and throws `RwsError` on failure.

### Connection quality

`RobotState.quality` reports connection health as
`'live' | 'polling' | 'reconnecting' | 'stale' | 'disconnected'`, with a
human-readable `state.qualityReason`:

- `live` - WebSocket events streaming; polling runs at the slow cadence
- `polling` - no WebSocket (unavailable or terminally lost), or the controller left a status resource out of the subscription group; fast polling covers all state
- `reconnecting` - a connect attempt is in flight
- `stale` - 1-2 consecutive polls failed; data may be outdated (heals on the next success)
- `disconnected` - not connected (initial, user disconnect, or auto-disconnect after 3 failed polls)

`MultiRobotManager.onRobotChanged(id => ...)` tells fleet consumers WHICH robot
changed, so a dashboard updates one row instead of diffing every robot's state.
The zero-arg `onDidChange` keeps working unchanged. `MultiRobotManager.onAccessEvent((id, e) => ...)`
does the same for access events (see [Lost holds](#lost-holds-and-robotstateaccess)).

---

## Logging

The lib ships a no-op logger by default. Hosts (CLIs, services, the VS Code extension) install their own:

```ts
import { setLogger } from 'abb-rws-client';

setLogger({
  info:  (msg) => console.log(`[info]  ${msg}`),
  warn:  (msg) => console.warn(`[warn]  ${msg}`),
  error: (msg, err) => console.error(`[error] ${msg}`, err),
  show:  () => { /* bring log surface to front; no-op for CLIs */ },
});
```

Internal lifecycle events (connect/disconnect, polling cycles, subscription state, error recovery) flow through this.

---

## API Reference

### Constructor

```ts
new RwsClient(options: RwsClientOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | - | Controller IP or hostname |
| `port` | `number` | `80` | HTTP port |
| `username` | `string` | `'Admin'` | RWS username |
| `password` | `string` | `'robotics'` | RWS password |
| `requestIntervalMs` | `number` | `100` | Min ms between requests (ABB: 50 ms minimum per request) |
| `timeout` | `number` | `5000` | Request timeout in ms (a DIPC read's wait is added for that one read): a finite number above 0 and at most 2147483647 (about 24.8 days), the longest delay a Node timer holds. Anything else (0, a negative value, NaN, Infinity, a longer one) throws `INVALID_ARGUMENT` from the constructor. The same rule holds for `RwsClient2`'s `timeout` (default 10000) |
| `sessionCookie` | `string` | - | Saved cookie to reuse an existing session slot |

---

### Connection

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `void` | Establish session and authenticate |
| `disconnect()` | `void` | Close WebSocket subscriptions and clear session |
| `getSessionCookie()` | `string \| null` | Current session cookie - persist to avoid 70-session limit |

---

### Controller State & Panel

| Method | Returns | Description |
|--------|---------|-------------|
| `getControllerState()` | `ControllerState` | Motor state: motoron / motoroff / guardstop / emergencystop / … |
| `setControllerState(state)` | `void` | Set motor state; takes no mastership itself (remote motors on: AUTO only) |
| `getOperationMode()` | `OperationMode` | AUTO / MANR / MANF |
| `acknowledgeOperationMode(mode)` | `void` | Confirm a pending mode switch; `RwsClient2` only, see the note below |
| `lockOperationMode(pin, permanent?)` | `void` | Lock the operating-mode selection with a PIN (ABB names two UAS grants for it); RWS 1.0 refused on an RW 6.16.03 virtual controller (an option missing) |
| `unlockOperationMode(pin)` | `void` | Unlock the operating-mode selection with the PIN the lock set (required by the controller form) |
| `getSpeedRatio()` | `number` | Speed override 0-100 |
| `setSpeedRatio(ratio)` | `void` | Set speed override - AUTO mode only |
| `getCollisionDetectionState()` | `CollisionDetectionState` | INIT / TRIGGERED / CONFIRMED / TRIGGERED_ACK |
| `restartController(mode?)` | `void` | restart / istart / pstart / bstart |
| `getControllerIdentity()` | `ControllerIdentity` | Name, ID, type, MAC address |
| `getSystemInfo()` | `SystemInfo` | RobotWare version, options, system ID |
| `getRobotType()` | `{ type, variant?, types }` | Robot types, `/rw/system/robottype`, both generations: `types` lists every robot in the controller's order (a MultiMove system answers one entry per robot), `type` is the first. ABB lists standard robots only (no positioners or tracks); none: `{ type: '', types: [] }` |
| `getControllerClock()` | `ControllerClock` | Current date/time (UTC) |
| `setControllerClock(y,mo,d,h,mi,s)` | `void` | Set controller date/time (UTC). ABB lists it for real controllers only; the virtual controllers answer 405 |
| `getRestartCount()` | `number` | Times the controller has restarted, RWS 2.0 |
| `listProgress()` / `getProgress(id)` | - | Track async operations (backup, log dump) |
| `setPanelLanguage(code)` | `void` | Panel language, both generations (field `lang-code`) |
| `setControllerLanguage(lang)` | `void` | Controller language, both generations (field `lang`) |
| `setExternalEmergencyStop(state)` | `void` | Simulated **external** e-stop circuit, RWS 2.0 |
| `getDiagnostics()` | `DiagnosticsInfo` | Saved diagnostics; `empty: true` when none |
| `getEnv(name)` | `string` | One controller environment variable (`HOME`, `TEMP`, `SYSTEM`, ...; a leading `$` is accepted), ABB's `GET /ctrl/${ENVNAME}` with the `$` sent as `%24`, both generations (RW 6.16.03, 7.21.4 and 8.2.1 virtual controllers answered it) |
| `getCompatibility(robotWareVersion?)` | `RobotWareCompatibility` | Whether the controller hardware can run that RobotWare version (`7.16`, `6.03.0101`), ABB's `GET /ctrl/compatibility/{robotware version}`, both generations: `compatible` is the controller's `status`, and a refusal is the controller's typed error, never `compatible: false`. Without a version it asks about the one the controller runs, the `rwversion` of `GET /rw/system` (`6.16.3007`, `8.2.1+1023`), sent as written |
| `setKeylessMotorOn()` | `void` | Motors on without the key switch (Keyless Mode Switch option), both generations: RWS 2.0 `/rw/panel/ctrl-state/keyless-motoron`, RWS 1.0 `/rw/cfg?action=keyless` (204 on a RW 6.16.03 virtual controller) |

ABB lists these for real controllers only, and the virtual controllers refuse
them: `saveSystemInfo` (403), `setControllerClock` (405) and `getCompatibility`
(404), as typed `RwsError`s; the `/ctrl/tpu/*` and `/ctrl/system` resources (404) have no client
method. `saveDiagnostics` is marked not supported on a virtual controller as
well, yet RobotWare 7.21.4 answered it 204. `/ctrl/syslog` is not wrapped: the
virtual controllers answered 406 to the Accept values tried, which did not
include ABB's `text/plain;v=2.0`.

> **The operating-mode acknowledge is left out on purpose on RWS 1.0.** RobotWare
> 6.16.03 offers the form (`POST /rw/panel/opmode?action=acknowledge`), but
> confirming a change of operating mode is the person's confirmation at the
> FlexPendant: RobotWare asks for it so that someone at the robot sees the change.
> `RWS1Adapter` has no acknowledge, and neither `IRWSAdapter` nor `RobotManager`
> declares one; the RWS 2.0 method stays on `RwsClient2` (and `RWS2Adapter`).
>
> **The rows tagged `RWS 2.0` above are RWS 2.0 only** (e.g.
> `getRestartCount`, `setExternalEmergencyStop`). Every one of their paths answers
> 404 on an IRC5, so they are declared optional on `IRWSAdapter` and `RWS1Adapter`
> does not implement them. Through `RobotManager` the behaviour is explicit: reads
> return a neutral value on RobotWare 6, and **writes throw `UNSUPPORTED_OPERATION`**
> rather than quietly doing nothing. `setPanelLanguage` and
> `setControllerLanguage` are live-verified on RWS 1.0 too and work on either
> controller. `getEnv` works on both generations: RW 6.16.03, 7.21.4 and 8.2.1
> virtual controllers answered it. RW 6.16.03 sends the value in `_value`, which
> the client reads. On a RW 6.16.03 virtual controller the RWS 1.0 keyless
> motors-on switched the motors on.

---

### RAPID Execution

| Method | Returns | Description |
|--------|---------|-------------|
| `getRapidExecutionState()` | `ExecutionState` | `'running'` \| `'stopped'` |
| `getRapidExecutionInfo()` | `ExecutionInfo` | State + current cycle mode |
| `getExecutionErrorState()` | `boolean` | Why did it stop: whether the most recent RAPID execution stop was caused by an error (ABB: back to false when the program restarts). RobotWare 8.2 and later, ABB's `GET /rw/rapid/execution/execerrorstate` (RWS site, RobotWare 8 view); RobotWare 7 answers 404, and RWS 1.0 has no such resource. `RwsClient2`; through `RobotManager`: `read('getExecutionErrorState')`. Live on RW 8.2.1 (false; RW 7.21.4 answered the typed 404) |
| `getRapidTasks()` | `RapidTask[]` | All tasks with name, type, state, active flag |
| `startRapid()` | `void` | Start execution (AUTO + motors on required; RobotWare 8 also needs motion control allowed for this control station, `setAllowMotionControl(true)` after a person's confirmation) |
| `startProductionEntry()` | `void` | Start from the production entry point |
| `stopRapid()` | `void` | Stop execution |
| `resetRapid()` | `void` | Reset program pointer to Main |
| `setExecutionCycle(cycle)` | `void` | `'once'` \| `'forever'` \| `'asis'` |
| `activateRapidTask(task)` | `void` | Activate a task (multitasking) |
| `deactivateRapidTask(task)` | `void` | Deactivate a task |
| `activateAllRapidTasks()` | `void` | Activate all tasks. RWS 2.0 sends one request per task and throws, naming each refused task, when any was refused |
| `deactivateAllRapidTasks()` | `void` | Deactivate all tasks (same reporting as `activateAllRapidTasks`) |
| `getTaskSelection()` | `{ selected, available }` | Every task and the ones selected (state ON), `/rw/rapid/taskselection`, both generations |
| `getMotionPointer(task)` | `{ module?, routine?, row?, col? }` | The motion pointer: the `motionpointer` entry of the task's pcp resource (the one `getProgramPointer` reads), both generations; `{}` while the controller reports no position. RW 6.16.03 and 7.21.4 virtual controllers send the start as `begposition` (ABB's Rev M example: `beginposition`); the client reads both, and read row 9 col 16 there. Still `built`: the request is `getProgramPointer`'s, and its answer carries this entry with no position when no program has started, so a logged 2xx (the logs keep no answer body) does not show that a position was read |

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
| `setUiInstructionParam(stackurl, param, value)` | `void` | Respond to a UI instruction with one of its own parameters, listed at `GET /rw/rapid/uiinstr/active/params/{stackurl}` (a TPReadNum takes `TPAnswer`, then `TPCompleted` = `TRUE`) |

---

### RAPID Modules

| Method | Returns | Description |
|--------|---------|-------------|
| `listModules(taskName)` | `string[]` | Names of all loaded modules in a task |
| `loadModule(task, modulePath, replace?)` | `void` | Load module from controller filesystem into task |
| `unloadModule(task, moduleName)` | `void` | Unload module from task (RAPID must be stopped) |
| `saveModule(task, moduleName, filepath)` | `void` | Save a module's source to a controller volume |
| `loadProgram(task, progpath, loadmode?)` | `void` | Load a full RAPID program (.pgf), RWS 2.0 |
| `unloadProgram(task)` | `void` | Unload the task's program, the counterpart of `loadProgram`: ABB's RWS 2.0 `POST .../program/unload` and RWS 1.0 `POST .../program?action=unloadprog`, no body on either. It takes out every program module of the task and leaves the system modules (on RW 6.16.03 the controller's own `Module1` went too). Live on RW 6.16.03, 7.21.4 and 8.2.1 |
| `getBuildErrors(task)` | `RapidBuildError[]` | Why a load or link failed: the program's build errors (module, row, column, the error text, and the error number and `typeOfError` when the answer carries them), ABB's `GET .../program/builderror` on both generations, every page (at most 30 errors a page), read as XHTML (RobotWare 7.21.4 and 8.2.1 write the error text unescaped into their hal+json). `[]` when the program builds. Through `RobotManager`: `read('getBuildErrors', task)`. Live on RW 6.16.03, 7.21.4 and 8.2.1 with a semantic and a syntax error |
| `saveProgram(task, destination)` | `void` | Save the loaded program to disk, RWS 2.0 |

---

### Motion

| Method | Returns | Description |
|--------|---------|-------------|
| `getJointPositions(mechunit?)` | `JointTarget` | rax_1-rax_6 in degrees (default mechunit: ROB_1) |
| `getJointTargetFull(mechunit?)` | `JointTargetFull` | Every axis slot: `rax` (rax_1..6) and `eax` (external axes eax_a..f). 9E9 = no axis in that slot - test with `isJointValuePresent()`; unused slots may also read 0, so use the unit's axis count |
| `getRobTarget(mechunit?, tool?, wobj?)` | `RobTarget` | TCP x/y/z (mm) + q1-q4 quaternion for a chosen tool/wobj |
| `getCartesianPosition(mechunit?, tool?, wobj?)` | `RobTarget` | RWS 1.0 name for `getRobTarget` |
| `getCartesianFull(mechunit?)` | `CartesianFull` | TCP pose + j1/j4/j6/jx configuration flags |
| `getMotionSupervision(mechunit?)` / `getPathSupervision(mechunit?)` | `MotionSupervisionState` / `PathSupervisionState` | Supervision mode + level, both generations (RWS 1.0 reads them at the motion-system root with `?mechunit=`) |
| `getMechunitSmbData(mechunit?)` | `Record<string, string>` | Serial measurement board data (serial numbers, data statuses), both generations |
| `getMechunitMotorCalib(mechunit?)` | `MechunitMotorCalib[]` | Motor calibration name per joint, both generations |
| `getLeadThrough(mechunit?)` | `LeadThroughState` | Compliance lead-through status (`active` / `Inactive`; ABB defines it as whether the function is opted for, not necessarily engaged now), both generations |
| `getAxisPose(mechunit, axis)` | `RobTarget` | Pose of one axis, RWS 2.0 |
| `getTaskRobTarget(task)` | `TaskRobTarget` | The task's current robtarget: x/y/z (mm, rounded to 0.01), q1-q4, cf1/cf4/cf6/cfx, external axes; `RwsClient2`, RWS 2.0 |
| `getTaskJointTarget(task)` | `JointTargetFull` | The task's current jointtarget (unused external slots read 9E9 here); `RwsClient2`, RWS 2.0 |
| `getTaskMechunits(task)` | `TaskMechunit[]` | The units the task drives, with mode and type; `RwsClient2`, RWS 2.0 |
| `getTaskExtJointState(task)` | `Record<string, string>` | State of external joints `j1`..`j6` (e.g. `not_active`); `RwsClient2`, RWS 2.0 |
| `setMechunitBaseFrame(mechunit, frame)` | `void` | Write a unit's base frame (x, y, z, q1..q4); it changes the calibration, so read it first with `getMechunitBaseFrame`. Both generations (RWS 1.0 `?action=set`; 202 on a RW 6.16.03 virtual controller) |

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
| `renameFile(path, newName)` | `void` | Rename a file in place, both generations |
| `listFileVolumes()` | `string[]` | Controller volumes/devices |

---

### I/O Signals

| Method | Returns | Description |
|--------|---------|-------------|
| `listAllSignals(start?, limit?, maxPages?)` | `Signal[]` | Every signal from `start` to the end of the list, following the controller's page links (one request per page, at most `maxPages` pages, default 50) |
| `searchSignals(criteria)` | `Signal[]` | Server-side search (name = case-insensitive prefix, type, device, network, category; empty criteria = every signal), both generations |
| `searchSignalsEx(criteria[])` | `Signal[]` | Two-criteria search, both generations - the second set **narrows** the first |
| `readSignal(network, device, name)` | `Signal` | Read a specific signal by address |
| `getSignalConfig(network, device, name)` | `Record` | Configuration instance of a signal (type, device, device map, category, access, ...), both generations (RWS 1.0 reads the signal with `?resource=config`) |
| `getIoNetworkConfig(network)` | `Record` | Configuration instance of a network, both generations |
| `getIoDeviceConfig(network, device)` | `Record` | Configuration instance of a device, both generations (RWS 1.0 names the device without its network) |
| `writeSignal(network, device, name, value)` | `void` | Write DO/AO/GO - value as string: `'1'`, `'0'`, `'3.14'`. Takes no mastership or write access: the signal's access level decides |
| `listNetworks()` | `IoNetwork[]` | All I/O networks |
| `listDevices(network)` | `IoDevice[]` | Devices on a network |
| `setSignalSimulated(network, device, name, simulated)` | `void` | Simulate a signal or end its simulation (`lstate`), both generations (RWS 1.0 `?action=set` on the signal, which needs all three segments; built, not yet run) |
| `unblockSignals()` | `void` | End the simulation of every simulated signal, both generations (RWS 1.0 `?action=unblock-signal`; built, not yet run) |
| `setIoDeviceLState(network, device, enable)` | `void` | Enable or disable an I/O device; its signals are unavailable while it is disabled. Both generations (RWS 1.0 names the device without its network; built, not yet run) |

> Pass `''` for `network` and `device` to write by the signal's name alone
> (`RobotManager.writeIoSignal(name, value)` always does). RWS 1.0 uses the
> flat signal path. RWS 2.0 needs to know where the signal lives: it takes that
> from a signal list or search already read, or reads the signal once by name
> (`GET /rw/iosystem/signals/{name}`) and remembers the answer. A signal bound
> to a device is then written at `{network}/{device}/{name}/set-value`; a signal
> with no device (the safety controller's `SCnCBC*` signals, for example) at
> `/rw/iosystem/signals/{name}/set-value`, a form that has run against
> RobotWare 8.2.1 - its answer is passed on as given. On RWS 2.0, a name that is
> not letters, digits and underscores is refused with `INVALID_ARGUMENT`, and
> an unknown name with the controller's `RESOURCE_NOT_FOUND`, before any write
> is sent.

---

### Event Log

| Method | Returns | Description |
|--------|---------|-------------|
| `getEventLog(domain?, lang?)` | `ElogMessage[]` | Read log messages (domain 0 = main), every page up to 20 (about 1000 messages) on both generations. Newest first on RWS 1.0, which follows the listing's `next` link (`RwsClient.getEventLog(domain, lang, maxPages)`; `maxPages: 1` reads the newest 50 only, as earlier versions did); oldest first on RWS 2.0 by default (`RwsClient2.getEventLog(domain, lang, maxPages, 'newest')` for newest first). `RobotManager.state.eventLog` keeps the newest page on RWS 1.0. One call sends one request per page, up to 20, so a poller paces by pages |
| `clearEventLog(domain?)` | `void` | Clear messages in one domain |
| `clearAllEventLogs()` | `void` | Clear all domains |
| `saveEventLogRaw(destination)` | `void` | Dump the full log to a file in system-dump format, both generations |
| `getEventLogMessage(domain, seqnum, lang?)` | `ElogMessage \| null` | One message by domain + sequence number |

---

### Mastership

Required before modifying motor state, speed ratio, or certain RAPID operations.

| Method | Returns | Description |
|--------|---------|-------------|
| `requestMastership(domain)` | `void` | Take control - `'cfg'` \| `'motion'` \| `'rapid'`. Counted: a request for a domain this session already holds sends nothing |
| `releaseMastership(domain)` | `void` | Release control - always call in `finally`, once per request. The release goes out when the last hold on the domain ends |
| `RobotManager.getWriteAccessStatus()` | `WriteAccessStatus` | RobotWare 8: `{ held, heldByMe, heldByName, externalControlEnabled }` from one GET that registers nothing and requests nothing. A field is `true`/`false` only for the controller's text `true`/`false`, else `null` (absent included); `heldByName` is `null` for `none`; `heldByMe` compares the holder id with this client's station id, and no id is returned. `PARSE_ERROR` when the answer has no write-access status; RobotWare 6 and 7: `UNSUPPORTED_OPERATION`, nothing sent; on an RWS 2.0 connection whose RobotWare version was not read, the GET is sent and the controller's answer decides |

```ts
await client.requestMastership('rapid');
try {
  await client.setControllerState('motoron');
} finally {
  await client.releaseMastership('rapid');
}
```

On RobotWare 7.8 and later, while the session holds `edit` mastership (`rapid`
or `cfg`, yours or a write's own), `RwsClient2` resets the controller's
edit-mastership watchdog (`POST /rw/mastership/watchdog`) every
`min(Timeout / 2, 1 s)` and stops when the last hold ends or you disconnect.
`Timeout` comes from the HeartBeat configuration (`SYS/MASTER_BOOL/HeartBeat`),
which the client reads once at connect on RobotWare 7.8 and later, RobotWare 8
included, and never writes; ABB's default of 2000 ms applies when it cannot be
read. On RobotWare 8 the mastership service and its watchdog are gone and ABB
documents no RWS way to send the heartbeat, yet the controller's own event
10139 says a station holding write access while RAPID runs must send one or
execution stops. The client cannot send it, so `RobotState.access.watchdog`
reports what it read with `resettable: false`, and `RobotManager` warns once
per connection (a log line and a `warning` access event, kind
`heartbeat-required`) before a RAPID start under its write access while
`enforced` is true. The start goes out: the controller decides. A reset the controller refuses, or no
accepted reset for longer than the Timeout, loses the hold (see
[Lost holds](#lost-holds-and-robotstateaccess)); a reset that did not get
through while the Timeout has not run out is logged as a warning that the hold
may be at risk. Call `resetMastershipWatchdog()` yourself only for a
`requestMastershipWithId` hold, which the client does not count.

#### Writes with conditions ABB states

Every write ABB documents stays available on every generation that has it; the
controller's own controls decide, and the client explains a refusal and reads
back a write. These writes carry conditions or effects ABB states that no hold
satisfies, so the person who calls one knows them. Quotes are ABB's; the
document and section follow each.

- `setKeylessMotorOn()` - "Set motor ON when using a keyless panel." Pre-requisites: "None". Energises the drives from a remote client; the client holds `edit` (RobotWare 8: write access; RobotWare 6: RAPID mastership) around it as for any motors-on. (RWS 2.0 Swagger 3HAC073675-001 Rev L, Panel Service, `/rw/panel/ctrl-state/keyless-motoron`; RWS 1.0 manual 3HAC050973-001 Rev M, "Keyless motor ON", `/rw/cfg?action=keyless` with `state=run`.)
- `setExternalEmergencyStop(state)` - "Set external emergency stop switch to either ON or OFF." Limitation: "Supported only in VC". A real controller refuses it. (RWS 2.0 Swagger Rev L, Panel Service, `/rw/panel/external-emergency-stop`.)
- `impersonateUser(uid)` - "Impersonate a user having same credentials and running on the same machine." Pre-requisites: "None". The session then acts as that user for UAS. (RWS 2.0 Swagger Rev L, User Service, `/users/impersonate`; RWS 1.0 manual Rev M, "Impersonate a user", documents `POST /users?action=impersonate` too, which this client does not wrap.)
- `changePassword(old, new)` - "Change password of an existing UAS user." Pre-requisites: "UAS grant is required for this operation". The old password is "only required when changing password for current user". (RWS 2.0 Swagger Rev L, UAS Service, `/uas/user/password`.)
- `registerUser(reg)` - "Register current logged-in user with given username, application name, location and locale. Given username, application and location are used only as free-text information. User can be registered as local client (ulocale=local) only if the request comes from service port or the TPU port." Both pages mark `ulocale` required, with the values `local` and `remote`. A given `reg.locale` string is sent as `ulocale` as it is, and the controller decides; when it answers 400 to a value other than those two, the error names them. Without one the request carries no `ulocale`; RobotWare 7.21.4 and 8.2.1 refuse that with 400 ("locale name is empty"), which the error explains the same way. A remote tool passes `locale: 'remote'` (201 on both). (RWS 2.0 Swagger Rev L, User Service, `/users/register`; RWS 1.0 manual 3HAC050973-001 Rev M, users registration page, says the same.)
- `requestMastershipWithId(domain)` / `releaseMastershipWithId(domain, id)` - "Mastership Id value will be obtained after executing this API. This Id must be used for releasing mastership in release request with mastership Id"; "In manual mode, mastership can be gained after getting RMMP." The client remembers the id and releases it on `disconnect()`; the hold is not counted by the access manager and the RobotWare 7.8+ watchdog is not reset for it. (RWS 2.0 Swagger Rev L, Mastership Service, `/rw/mastership/{domain}/request-with-id` and `release-with-id`.)
- `registerControlStationLocal(key)` - "Register Local Control Station" needs the local-presence key of the FlexPendant side; ABB's RWS site for RobotWare 8.1 lists RMMP and `register/local` as having no implementation, and "All control stations other than the FlexPendant are considered as remote control stations." Not reachable from a remote client. (RWS site RobotWare 8 Control Station Service Rev C; Technical reference System parameters RW8 3HAC098390-001 Rev C §4.3.6.)
- `registerControlStationRemote(name, id, pincode)` - "Register a remote control station with the system." Pre-requisites: "None". Once Remote Access is on at the FlexPendant, a remote station "can request write access to the controller without approval if the FlexPendant is connected"; the FlexPendant "can always take Write Access from any other control station". Explicit arguments override the `controlStation` option for that session, and `RobotState.access.rw8` records the name and that it was explicit. (RWS site RobotWare 8 Control Station Service Rev C, `register/remote`; Operating manual RobotStudio 3HAC032104-001 Rev BC §1.6.2 p.48; RobotWare 8.0.0 release notes §1.14.)
- `disableExternalControl()` - "Disable external control." listed by the RobotWare 8 Control Station Service with no further text; ABB's PC SDK documents the matching `EnableExternalControl` as "only available for virtual controllers". (RWS site RobotWare 8 Control Station Service Rev C, `disableexternalcontrol`; PC SDK class `ControlStation`.)
- `setAllowMotionControl(allow)` - "Enable or disable the possibility to initiate motion." Pre-requisites: "The client must be registered as a control station." Notes: "To comply with ISO 10218-1:2025, it's the responsibility of the user to ensure that the required safety functions (emergency stop and normal stop) are available at the control station to allow initiation of motion. Setting this property is considered as a confirmation that those safety functions are available." The client never sets it to true on its own; it logs the change at info level and shows it in `RobotState.access.rw8.allowMotionControl`. `disconnect()` withdraws it first. A reconnect, a re-issued session or the next registration of the same station withdraws one that may remain. `RobotState.access.rw8.allowMotionControl` is `null` until the session registers, then follows each set and read. `RobotManager.getAllowMotionControl()` reads it. On an RW 8.2.1 virtual controller a RAPID start needed it too, also for a program that does not move the robot; another station, which registers with its own id, read it as false. On RW 8.2.1 it belongs to the control station: a second session with the same station id read it true, also after the allowing session logged out. (RWS site RobotWare 8 Control Station Service Rev C, `allowmotioncontrol`; Product specification Changed software features RW8 3HAC098573-001 Rev D §2.)

#### Access each write takes

Every write below takes the access it needs itself, for that one operation, and
releases it when the write returns; you do not have to request anything first.
Inside a hold you took with `requestMastership` / `requestWriteAccess` the write
requests and releases nothing of its own, so it never ends your hold. Most rows
follow ABB's RWS pages for the generation; rows marked † are a conservative
choice where ABB's documents name no domain or disagree, and are held until a
live run shows what the controller checks. "-" means the write does not exist
on that generation.

| Write | RobotWare 6 (RWS 1.0) | RobotWare 7 | RobotWare 8 |
|-------|-----------------------|-------------|-------------|
| `startRapid`, `stepRapid`, `startProductionEntry`, `resetRapid`, `setExecutionCycle`, `setProgramPointer`, task activation | rapid | edit | write access (a start: also motion control declared) |
| `ppPrevInst`, `ppNextInst`, `setPPToCursor` | rapid | edit | write access |
| `setBreakpoint` | rapid † | edit | write access |
| `setPPToRoutineFromUrl`, `resetTaskProgramPointer`, `removeBreakpoint` | - | edit | write access |
| `holdToRun` | rapid † | edit | write access |
| `setTaskSelection` (refused before sending, `UNSUPPORTED_OPERATION`: ABB has no write for the whole selection on either generation; use task activation, one task at a time) | - | - | - |
| `setRapidVariable` | rapid | edit | write access |
| `setUiInstructionParam` | rapid † | edit † | write access |
| `loadModule`, `unloadModule`, `loadProgram`, `unloadProgram` | rapid (`loadProgram` and `unloadProgram` †) | edit | write access |
| `saveProgram` | none | edit | write access |
| `setModuleText`, `setModuleTextRange` | rapid † | edit | write access |
| `modifyPosition` | - | edit | write access |
| CFG writes (`setCfgInstance`, `createCfgInstance`, `removeCfgInstance`, `loadCfgFile`, `saveCfgFile`) | cfg † | edit † | write access † |
| `setActiveTool`, `setActiveWobj` | motion | edit + motion † | write access |
| motion and path supervision writes | - | edit + motion | write access |
| `setNonMotionExecution` | cfg + motion + rapid † | edit | write access |
| `setSpeedRatio` | none | edit | write access |
| `restoreBackup` | rapid + cfg † | edit | write access |
| `checkRestore` | none | none | none |
| `setMechunitForJogging` (and the selection `jog` makes) | motion † | motion † | write access |
| `restartController` | none | edit | write access |
| `setKeylessMotorOn` | rapid † | edit † | write access † |
| `setMechunitBaseFrame` | motion † | edit †, taken by `RobotManager` only (`RwsClient2` sends the write without it) | write access †, taken by `RobotManager` only |
| `RobotManager.setMotorsOn` | rapid | edit | write access |
| `stopRapid`, `RobotManager.setMotorsOff` | none: sent first; access is taken once, only if the controller refuses as not held | | |
| `RobotManager.jog` (sent in any mode; the controller decides) | motion (ABB: local client) | motion (ABB: local client) | write access (ABB: motion control declared) |
| `saveModule`, `getModuleSource`, file service, I/O writes (values, `setSignalSimulated`, `unblockSignals`, `setIoDeviceLState`), backup create, event log, clock, DIPC (`createDipcQueue`, `sendDipcMessage`, `readDipcMessage`, `removeDipcQueue`) | none | none | none |

Some of these writes carry conditions no hold satisfies, and the controller
refuses them when they are missing: ABB documents `modifyPosition` and
`holdToRun` for a local client (RobotWare 8: a local control station) in manual
mode, and on RobotWare 6 a RAPID variable write in manual mode also needs RMMP.
On RobotWare 6 `holdToRun` uses the form the controller advertises, which was
accepted on RobotWare 6.16.03; it is held under rapid like `startRapid`.
ABB's jog pages ask for a local client plus mastership on RobotWare 6 and 7,
and RMMP does not make a client local; this client always connects as a remote
client, so a real controller may refuse its jog in manual mode. The jog is
sent in any mode, with the motors off and, on RobotWare 8, with motion control
not declared; the controller decides, and a refusal says what was read before
it.

#### RobotWare 8 control-station identity

On RobotWare 8 each session registers as a remote control station before it
takes write access, and the controller reports that station's name as the
holder (`getWriteAccessStatus().heldByName`). Give the client
a name, an id and a PIN of your own so it registers as the same station on every
run:

```ts
const mgr = new RobotManager({
  controlStation: {
    name: 'Line 3 cell PC',                            // shown as the holder
    id: '{6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b}',      // generate once, store, reuse
    pincode: '4711',
  },
});
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Name the controller shows as the write-access holder. Must not be empty |
| `id` | `string` | Braced GUID, 38 characters: `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`. Generate it once (for example `` `{${crypto.randomUUID()}}` ``), store it, pass the same value every time |
| `pincode` | `string` | Registration PIN: digits only, at most 11 (ABB documents an integer with up to 11 digits) |
| `releaseWriteAccessWhenLost` | `boolean` | Default `false`. When `true`, the registration carries ABB's optional `release-write-access-when-lost=TRUE` field, which asks the controller to release write access itself "if the last session connected to the station is lost" (ABB does not define "lost"). **Pending live confirmation**: not yet sent to a controller by this project. The client still releases write access after every operation that took it |

The same `ControlStationIdentity` is accepted by `createClient` / `createAdapter`
(`ConnectOptions.controlStation`), `RobotManager` (`RobotManagerOptions.controlStation`,
or later `setControlStation()`, which takes effect at the next connect) and
`MultiRobotManager` (in its options for every robot, or per robot in
`RobotConfig.controlStation`). It is checked where it enters: a malformed value
throws `INVALID_ARGUMENT` naming the field, before anything is sent. The id and
the PIN are masked in trace logs. RobotWare 6 and 7 have no control stations and
ignore it.

Without it, nothing changes: the client registers as `abb-rws-client` with an id
generated for each client instance and the PIN `1234`, and logs once per client
instance that the station is anonymous.

With a fixed control-station id, a motion-control allowance counts for every
session of that station, in any process (RobotWare 8.2.1; see Whose allowance
it is, below). A default id lives only in its client instance: a `RobotManager` keeps its client
across reconnects with the same settings, so it stays one station for its life,
and two processes are two stations.

#### RobotWare 8 motion control

RobotWare 8 refuses a jog and a RAPID start from a remote control station until
motion control is allowed for it (403 -1073435864, `refusal.kind`
`motion-control-off`); an 8.2.1 virtual controller refused a start even for a
program that moves nothing. ABB: a control station needs an emergency stop and a
normal stop to start RAPID or to jog, and allowing motion control is the
station's confirmation that both are available (Control Station Service, Allow
Motion Control). ABB's PC SDK has an Automatic policy that turns it on before
each action, and ABB allows that policy on virtual controllers only. On a real
controller the tool has to turn it on itself, and ABB asks it to confirm both
stops first. This client never allows it on its own, on a virtual controller or
a real one. `RobotManager.setAllowMotionControl(true)` is for a tool to call
after a person has confirmed that both stops are within their reach, with the
text `confirmationFor(refusal.remedy, target)` gives.

Withdrawing only removes the permission and is not a stop. The client does it
on its own:

- `disconnect()` withdraws as its first request, before the jog release, RMMP,
  the subscription, the write-access release and `/logout` (`RobotManager`, and
  `RwsClient2` used alone). It registers the session first when needed, takes no
  write access, and gives up after 3 s. A refused or unanswered withdrawal is
  logged as a warning (`withdraw-failed`) and the disconnect goes on. A
  withdrawal already on its way (after a re-issued session, say) goes out
  before `/logout`, and a true sent while the disconnect's withdrawal was on
  the wire is withdrawn again.
- The client remembers that it may have an allowance standing from the moment it
  sends a true until a false sent as the same control station is taken, or a
  registered session of that station reads false. A true that got no answer
  counts until a false is taken, whatever a read says: the controller may take
  it after the read. While it stands, the next registration of the same
  station (a reconnect with the same settings) and a re-issued session (an
  idle expiry, a restart) send a withdrawal first, then read. Nothing is
  allowed again: a person does that.
- A registration that finds the station allowed when this client made no
  allowance in this run (left by an earlier run with the same station id, or
  by another session registered as it) withdraws it at once and reads it back,
  before the write that needed the registration: the `motionControl` event
  with cause `withdrawn-leftover` (allowed false) and one warning. It never
  reads as allowed on the way. A withdrawal that is refused or gets no answer
  leaves the allowance not known (null, cause `withdraw-failed`), never true,
  and it is sent again at the disconnect and the next registration. Not while
  a person's `setAllowMotionControl(true)` of this client is the write that
  registers: that confirmation counts. With a fixed `controlStation` it also
  withdraws an allowance another live session of that station made.
- A connection with other settings is another station; when the old one may
  still have an allowance standing, the manager logs a warning. So does the
  client when it registers again as another station
  (`registerControlStationRemote` with another id): that station cannot
  withdraw the first one's allowance, so nothing is sent for it; registering
  as the first station again withdraws it.
- Withdrawals on an operating-mode change and on the FlexPendant taking write
  access are built and off in this release, until a run on a controller shows
  what a withdrawal does to a running program.

Whose allowance it is (RobotWare 8.2.1 virtual controller): the control
station's, not the session's. A second session registered with the same
station id reads it true, and keeps it after the session that allowed it logs
out; another station reads false. It ends with a withdrawal or when the
station's last session ends. A process killed after allowing left it
standing: a new session of the same station read true 7 min 42 s later. With
the default identity (an id made for each client instance) no other process
registers as that station; with a fixed `controlStation`, a process that
starts after a crash finds motion control allowed by the one before, and its
first registration withdraws it (above).

What the client shows (`RobotState.access.rw8`, and the `motionControl`
access event):

- `allowMotionControl` is `null` until the session registers (nothing is read
  before: RobotWare 8.2.1 answers a session that is not a registered control
  station false whatever the station allows), then read once after each
  registration.
  It reads `null` while a `setAllowMotionControl(true)` is on the wire, after a
  set that got no answer (one read follows), and after a re-issued session.
  A refused set leaves it as it was.
- `allowMotionControlSince` is the time of this client's set that made it true,
  while it reads true.
- `setAllowMotionControl(true)` is refused with `NOT_CONNECTED`, nothing sent,
  once a disconnect began (the disconnect withdraws); `false` is not refused for
  that reason.
- `RobotManager.getLocalStationStatus()` reads whether the FlexPendant is
  connected (`LocalStationStatus`), for a confirmation text. It decides
  nothing. It and `getAllowMotionControl()` throw `NOT_CONNECTED` without a
  session, also once a disconnect began.

Not measured: how long an allowance outlives a crashed session beyond 7
minutes; whether a mode change, a FlexPendant take-back, Remote Access off or
a restart ends it; whether allowing it needs Remote Access on; and what a
withdrawal does to a running program.

#### Lost holds and `RobotState.access`

`RobotManager.state.access` reports what the session holds, per lock, and
since when; `onAccessEvent` reports every change to it, and each change also
fires `onDidChange`. It is an observation, never permission: the controller
decides every write, and on RobotWare 8 the FlexPendant can take write access at
any time.

```ts
const off = mgr.onAccessEvent(e => {
  if (e.type === 'lost') {
    console.warn(`${e.lock} lost (${e.reason})${e.by ? ` - now held by ${e.by}` : ''}: ${e.detail}`);
  }
});
mgr.state.access.locks; // [{ lock: 'edit', state: 'held', count: 1, since: 1759132800000 }, ...]
```

| `RobotState.access` field | Description |
|---------------------------|-------------|
| `generation` | `'rw6'` \| `'rw7'` \| `'rw8'`, once known after connecting; `null` before |
| `locks` | One entry per lock of the generation (RobotWare 6: `cfg`, `motion`, `rapid`; RobotWare 7: `edit`, `motion`; RobotWare 8: `writeaccess`); none while not connected |
| `locks[].state` | `idle`; `held` (this session counts `count` holds on it); `uncertain` (a release did not go through, or a request did not answer and whether it was granted could not be read, so the controller may still count it as this session's); `lost` (the last hold was lost, see `lost`) |
| `locks[].since` | When the lock entered its state, ms since the epoch; for `held`, when the first of the current holds was granted |
| `locks[].lost` | While `lost`: `reason`, `detail`, and `by` (the station now holding it, RobotWare 8, when the controller says) |
| `watchdog` | RobotWare 7.8 and later, RobotWare 8 included: `enforced` (HeartBeat `Select`) and `timeoutMs` as read once at connect, `resettable` (true on RobotWare 7.8+, where the client resets the watchdog while it holds `edit`; false on RobotWare 8, where ABB documents no RWS way to send the heartbeat), `running`, `intervalMs`, `lastKick`; `null` before 7.8 |
| `rw8` | RobotWare 8: `registered`, `stationName` (never the id or the PIN), `identity` once registered (`option`: the `controlStation` option; `explicit`: a `registerControlStationRemote(name, id, pincode)` or `registerControlStationLocal` call, which overrides the option for that session; `default`: the anonymous default), `allowMotionControl` (`null` until the session registers, then each set and read; `null` while a true is on the wire, after a set with no answer and after a re-issued session) and `allowMotionControlSince` (the time of this client's set that made it true, while it reads true; else `null`); `null` on 6 and 7. See [RobotWare 8 motion control](#robotware-8-motion-control) |

| Event `type` | When |
|--------------|------|
| `acquired` | The first hold on a lock was granted (nested holds are not reported) |
| `released` | The last hold on a lock was released; `alreadyCleared` when the controller answered that this session held nothing any more |
| `lost` | The client stopped relying on a hold it counted; `reason` below, `detail` in words, `by` as above |
| `releaseFailed` | A release did not go through; the lock may stay held until the session ends |
| `atRisk` | A watchdog reset did not get through, while the HeartBeat Timeout has not run out |
| `warning` | Something about the next write to show the person, nothing blocked: `kind` `heartbeat-required` (RobotWare 8, HeartBeat enforced, a RAPID start about to go out under this session's write access; once per connection) and `detail` |
| `uncertain` | A request for the lock did not answer, and whether the controller granted it could not be read either; nothing is counted and the next write requests afresh (`detail`) |
| `motionControl` | RobotWare 8: motion control allowed, withdrawn or not known. `allowed` (true, false or null); `cause`: `set`, `read`, `session-reissued` (with `allowed` null: the session changed, not necessarily the allowance), `withdrawn-at-disconnect`, `withdrawn-after-reissue`, `withdrawn-at-registration`, `withdrawn-on-mode-change`, `withdrawn-on-take-back` or `withdraw-failed`. `lock` is always `writeaccess` |

Every event carries `lock` and `at` (ms since the epoch). More event types and
reasons may be added in minor releases; ignore the ones you do not handle.
`MultiRobotManager.onAccessEvent((id, e) => ...)` reports every robot's events
with the robot's id.

| `lost` reason | Cause |
|---------------|-------|
| `unknown` | The controller refused a write of the operation, or the release of the hold, as not held, without saying why (the FlexPendant taking control back is one cause) |
| `session-reissued` | The controller issued a new session: RWS 2.0 set a new session cookie (after a restart, say); RWS 1.0 set a new `-http-session-` value, or the client had to sign in on a fresh session |
| `opmode` | The operating mode changed. RobotWare 6 and 7: ABB documents that a change between Auto and manual ends mastership (RobotWare 6: both directions; RobotWare 7: Auto to manual; the other direction is treated the same way). RobotWare 8: write access is documented to persist, so the client reads the write-access status once, and only when the controller no longer names this station, or cannot be asked, is it lost |
| `holder-changed` | RobotWare 8, after a mode change: the controller names another station as holder (`by`) |
| `watchdog` | RobotWare 7.8+: the controller refused an edit-mastership watchdog reset, or no reset was accepted for longer than the HeartBeat Timeout |
| `connection-lost` | Three polls in a row failed and the manager disconnected; the hold is reported lost, not released |

After a loss the client does not take the access back by itself. The holds on
that lock end, so their releases send nothing; the operation that held it sends
no further access request, and its next step that needs access fails with
`MASTERSHIP_REQUIRED` ("... was lost during this operation"); the next
operation requests afresh, and the controller decides. After a mode change or a
lapsed watchdog, where the controller may still count the lock as this
session's, the client also releases it once, to be sure; a "not held" answer to
that release only confirms the loss. Refusals, re-issued sessions and the
watchdog are handled inside `RwsClient`, `RwsClient2` and the adapters as well;
watching the operating mode and the connection, and the reporting, are
`RobotManager`'s.

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
| `{ type: 'mastership', domain? }` | object | Mastership changes of one domain, `cfg`, `motion` or `rapid` (`/rw/mastership/{domain}`; RWS 2.0 sends `rapid` and `cfg` as RobotWare 7's `edit`), or, without a domain, of every domain: each domain's resource (RWS 1.0 `cfg`, `motion` and `rapid`; RWS 2.0 `edit` and `motion`). The event's resource is `/rw/mastership/{domain}` and its value the first field ABB lists, `holdmastership` (`1`/`0` on RW 6.16.03, `TRUE`/`FALSE` on 7.21.4). RobotWare 8 has no mastership service |
| `{ type: 'motionerrorstate' }` | object | The motion system's error state, `/rw/motionsystem/errorstate;erroreventchange` on both generations; the value is the error state (`HPJ_OK` when there is none) |

`SubscriptionEvent`: `{ resource: string, value: string, timestamp: Date }`

The last two rows are `AnySubscriptionResource` kinds, added in 1.5.1 and
kept out of `SubscriptionResource`, so an `IRWSAdapter` of another make
written before them still compiles: `RwsClient`, `RWS1Adapter` and `RwsClient2`
take them in `subscribe`, `updateSubscriptionGroup` and `unsubscribeResource`,
and so do `RobotManager`'s group edits. They are built from ABB's pages (RWS
1.0 Rev M, RWS 2.0 Rev L) and ran on RobotWare 6.16.03 and 7.21.4: added to
`RobotManager`'s group, a RAPID mastership request and release sent its two
events, and the motion error state answered its initial value. ABB's
mastership event entry has no link, so its resource is taken from its title
(the domain). Mastership of every domain is sent as each domain's resource:
ABB's RWS 1.0 `/rw/mastership` was refused by RobotWare 6.16.03, and on RWS
2.0, where ABB lists no such form, RobotWare 7.21.4 bound it in a group update
it never answered, after which the group refused every edit until logout.

On RWS 1.0 add these kinds to the group the session already has
(`updateSubscriptionGroup`): ABB's RWS 1.0 allows one WebSocket per session,
and RobotWare 6.16.03 failed a second `subscribe()` beside `RobotManager`'s
stream before it opened (the error says so).

The stream self-heals on both protocol generations. Heartbeats detect half-open
connections, drops (any close the client did not ask for, a clean one the
controller started included) reconnect with capped exponential backoff (defaults: RWS 1.0
starts at 1 s, RWS 2.0 at 500 ms, both doubling to a 30 s cap over 6 attempts),
and a controller restart triggers a fresh registration - on RWS 1.0 riding the
same session, on RWS 2.0 adopting the fresh session the restart forces. Tune it
or hook the lifecycle via the options:

```ts
// RWS 1.0 (RwsClient): options are the third argument
const unsubscribe = await client.subscribe(resources, handler, {
  onRestored: () => resyncState(),   // reconnected - events may have been missed
  onLost:     () => usePolling(),    // reconnect budget exhausted, stream is gone
  maxReconnectAttempts: 6,
  reconnectBaseMs: 1000,
  reconnectCapMs: 30000,
  pingIntervalMs: 10000,
  openTimeoutMs: 8000,
});

// RWS 2.0 (RwsClient2): callbacks are positional, tuning is the fifth argument
const unsub2 = await client2.subscribe(resources, handler, onLost, onRestored, {
  reconnectBaseMs: 500,
  pingIntervalMs: 25000,
});
```

`RobotManager` wires this automatically: it resyncs with a full poll on restore and
falls back to fast polling on loss. While connected without a stream (the subscribe
at connect failed, or the stream was lost) it subscribes again after 5 s, 10 s,
20 s, 40 s, then each minute, and 10 minutes apart after three creates in a row
that got no answer in time; once a retry lands the quality is `live` again
("WebSocket events streaming after a retry"), or `polling` at the fast rate while
the controller leaves a status resource out of the group. An adapter that answers
`UNSUPPORTED_OPERATION` is not tried again.

On RWS 1.0 a session sends one request at a time, and a group create waits up to
10 s for its answer. Stop RAPID, motors off, deleting a group and the disconnect's
logout do not wait for it: they cut the create short (it fails with "Request cut
short") and go out next. A mastership or RMMP release cuts a create that has not
been sent yet and waits for one already sent. A retry follows on the usual
backoff, and a create cut short does not count as one that got no answer. Other
requests still wait for the create.

A create can bind less than it asked for and still answer 201. On both
generations the subscriber checks the answer for the four panel resources
(`controllerstate`, `operationmode`, `speedratio`, `coldetstate`): one named
in a status block, or, on RWS 2.0, one with no initial event that the group's
own listing also leaves out, was not bound. The group is then deleted and
created once more with that resource in its other spelling (for example
`/rw/panel/speedratio` instead of `/rw/panel/speedratio;speedratio`), and
reconnects keep that spelling. If it is still not bound, the group is deleted
and `subscribe` throws, so `RobotManager` polls everything at the full rate
instead of waiting for events that never come. A RobotWare 6.16.03 virtual
controller drops a panel resource that another live group holds in the other
spelling. A RobotWare 8.2.1 virtual controller left speed ratio out of the
manager's group on some days and not on others, for a reason not yet known.
In a test run on 2026-10-22 it left speed ratio out of every group that
asked for `/rw/panel/speedratio;speedratio` (24), and each group created
with `/rw/panel/speedratio` bound it; the full-rate polling, for a resource
left out in both spellings, has not run against a controller.
After a re-create,
`unsubscribeResource` for that resource sends the client's usual spelling,
which the group no longer holds: drop the whole group instead.

#### Editing a live group

A subscription group can be changed in place instead of being torn down and
rebuilt. The handle `subscribe()` returns is still just the unsubscribe
function, but it also carries the group's path:

```ts
const unsubscribe = await client2.subscribe(['controllerstate'], handler);

// Add a resource. The PUT response carries its INITIAL value event, so you get
// the starting state without waiting for the first change.
await client2.updateSubscriptionGroup(unsubscribe.groupPath, ['speedratio']);

// Drop just that one resource; the group and its WebSocket stay up.
await client2.unsubscribeResource(unsubscribe.groupPath, 'speedratio');

await unsubscribe();   // tears down the whole group, as before
```

Adding is additive, not a replace. Removing the *last* resource retires the
group, after which the controller rejects further edits - call the unsubscribe
handle when you mean to tear everything down.

RWS 1.0 has both edits too: `RWS1Adapter.updateSubscriptionGroup` and
`RWS1Adapter.unsubscribeResource`, ABB's `PUT /subscription/{group}` and
`DELETE /subscription/{group}/{resource}` (Rev M; the resource as it was
subscribed, `;suffix` included). The RWS 1.0 subscribe handle carries no group
path: take it from `listSubscriptionGroups()`. A group the RWS 1.0 subscriber
re-creates after a controller restart has a new id and only the resources it
was created with. RobotWare 6.16.03 answered the resource drop 200, and the
dropped resource sent no more events.

`RobotManager` owns its own subscription; edit that one through
`manager.subscriptionGroupPath` (it is `undefined` when the manager is
polling-only or talking to an IRC5):

```ts
const group = manager.subscriptionGroupPath;
if (group) { await manager.updateSubscriptionGroup(group, ['uiinstr']); }
```

To see what a session holds, both generations list its groups and each
group's members (the resource strings exactly as the group stores them).
The list is per session (a group of another session answers 400
-1073435900 "does not belong to Client"), so it finds a group a crashed
caller left behind only when the restarted caller reuses the same session
cookie:

```ts
for (const g of await manager.listSubscriptionGroups()) {
  console.log(g.groupPath, await manager.getSubscriptionGroup(g.groupPath));
}
```

Events for a resource the manager does not consume itself (a signal, a
persistent variable) are not part of `RobotState`; receive them through the
raw event tap:

```ts
const untap = manager.onSubscriptionEvent(e => {
  if (e.resource.includes('/iosystem/signals/')) { lamp(e.resource, e.value); }
});
// later
untap();
```

---

### Error Handling

All public methods throw `RwsError` - never a plain `Error`.

| Code | Meaning |
|------|---------|
| `'AUTH_FAILED'` | Wrong credentials (auth handshake failed) - never used for permission errors |
| `'MASTERSHIP_REQUIRED'` | Write needs mastership (RobotWare 8: write access), another client holds it, or a hold was lost during the operation |
| `'GRANT_DENIED'` | Refused for this user or by the controller's access rules (UAS grant, safety access restriction, RMMP not granted, RobotWare 8 motion control not declared) - see `refusal` |
| `'WRONG_MODE'` | Operation not allowed in the current controller state / op-mode, or refused by the controller while the program runs (`RobotManager.setPPToRoutine`, `unloadModule`, `loadProgram` without `stopIfRunning`) |
| `'RESOURCE_NOT_FOUND'` | Signal / file / symbol / path does not exist on the controller |
| `'MODULE_NOT_FOUND'` | RAPID module not loaded on the controller |
| `'SESSION_EXPIRED'` | Session timed out |
| `'MOTORS_OFF'` | Action requires motors on |
| `'CONTROLLER_BUSY'` | Controller returned 503 - retry later. Also: a write that waited more than 10 s for another write to the same controller (not sent), or a second RMMP request while one waits |
| `'RATE_LIMITED'` | Too many requests (429) |
| `'NETWORK_ERROR'` | TCP / timeout / WebSocket error |
| `'PARSE_ERROR'` | Unexpected XML response format |
| `'UNSUPPORTED_OPERATION'` | This protocol generation / controller does not have the operation (also a missing RobotWare option, a real-only or virtual-only function, local-only operations, 410 Gone) |
| `'INVALID_ARGUMENT'` | A value was refused - by this client before sending, or by the controller |
| `'NOT_CONNECTED'` | `connect()` has not run (or the manager has no adapter yet) |
| `'PROTOCOL_DETECT_FAILED'` | Could not determine RWS 1.0 vs 2.0 during connect |
| `'UNKNOWN'` | Unmapped error, or a 403 the controller gave no known reason for - check `httpStatus`, `controllerCode` and `rwsDetail` |

4xx responses are classified by the controller's own error body, not the HTTP
status: `RwsError.controllerCode` / `controllerMsg` carry the native status
(e.g. `-1073445862` "held by someone else") and the message says what to do
about it. Every mapping is backed by payloads captured from the virtual
controllers (`tests/fixtures/errors/`), except the three configuration codes
(-1073437689, -1073437688, -1073437686): of the first two only the code and
message were logged, of -1073437686 the RWS 2.0 body up to its closing tags and
RWS 1.0's code and message, and `tests/cfgRefusal.test.ts` rebuilds each
generation's body from them.

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

#### Refusals in plain words: `RwsError.refusal`

An error that is a refusal - the controller, or this client's own pre-flight
check, declined the operation - carries `refusal` (`RwsRefusal`), in addition
to the unchanged `code`:

| Field | Meaning |
|-------|---------|
| `kind` | What kind of refusal: `held-by-other`, `not-held`, `not-registered`, `lost`, `remote-access-off`, `motion-control-off`, `motion-held`, `external-client-motion`, `rmmp-required`, `rmmp-pending`, `rmmp-denied`, `rmmp-expired`, `rmmp-wrong-mode`, `grant-missing`, `wrong-mode`, `wrong-state`, `safety-state`, `access-restricted`, `local-only`, `vc-only`, `rc-only`, `by-design`, `option-missing`, `unsupported`, `invalid-argument`, `unknown` (`watchdog-expired` is reserved) |
| `condition` | The missing condition: `mastership`, `write-access`, `control-station`, `remote-access`, `motion-control`, `rmmp`, `uas-grant`, `operating-mode`, `motors`, `safety-state`, `controller-state`, `signal-access-level`, `local-only`, `option`, `platform`, `argument`, `session`, `none`, `unknown` |
| `missing` | The missing condition, in plain words |
| `grantor` | Who can supply it: `pendant-operator`, `uas-administrator`, `current-holder`, `integrator`, `key-switch`, `cell-safety`, `abb-option`, `this-tool`, `nobody` (null when the reason is not known) |
| `fix` | Who does what, and where - for a missing UAS grant, the RobotStudio path ABB's operating manual gives (IRC5: the Groups tab; OmniCore: the Roles tab; RobotWare 8: an operator first allows Remote Access at the FlexPendant) |
| `sentence` | The whole explanation for a person; `message` is `sentence` followed by the controller detail |
| `grants` | For `grant-missing`: the UAS identifier and RobotStudio name of each candidate grant (a name paired only by matching is marked `name-match`, and the sentence says "probably") |
| `holder` | For `held-by-other`: who holds the access, when the controller said (RobotWare 8: the station name, never its id). `holder.isPendant` is true when it is the FlexPendant in the two forms seen (RobotWare 7: a `local` holder with application `TPU`; RobotWare 8: station `FlexPendant`), and absent for any other holder |
| `user` | For `grant-missing`: the UAS user the controller refused |
| `controller` | The controller's answer: request, HTTP status, code in decimal and hex, ABB's name for it, `icode`, message |
| `generation` | `rw6`, `rw7`, `rw8`, or null while not known |
| `evidence` | How sure the explanation is: `abb` (ABB documents), `vc` (seen on virtual controllers), `field` (community reports), `unverified` |
| `remedy` | The next step (`RefusalRemedy`, see [Remedies](#remedies-refusalremedy)). Every refusal this client builds carries one; optional in the type, so code that builds `RwsRefusal` values still compiles |
| `otherRemedies` | Other ways, in the order the sentence names them |

The explanation never advises RMMP in Auto, on RobotWare 8, for a signal write
or for a missing option; names the owner (the integrator, an administrator)
instead of suggesting to relax an access level or a grant; and claims no cause
for a 403 that names none. `RobotManager` explains every refusal of its
session with its current operating mode, controller state, RMMP and
controller name. Other callers can refine a refusal with what they know:

```ts
import { RwsError, explainRefusal } from 'abb-rws-client';

try {
  await client.setSpeedRatio(50);
} catch (e) {
  if (e instanceof RwsError && e.refusal) {
    const r = explainRefusal(e, { opmode: 'MANR', robot: 'Cell 3' }).refusal!;
    console.error(r.sentence, r.grantor);   // grantor e.g. 'pendant-operator'
  }
}
```

A refusal is never permission to retry: supply the condition first.

#### Remedies: `RefusalRemedy`

`refusal.remedy` is the next step of a refusal: what to do, who does it, where,
and how far it reaches. `refusal.otherRemedies` lists other ways. The client
never runs a remedy. A remedy with a `call` is for a person's action in a tool,
after `confirmationFor`'s text. A consumer that cannot act shows the remedy
without a `call`. An unknown kind is text.

| Field | Meaning |
|-------|---------|
| `kind` | The step (`RemedyKind`, below) |
| `byWhom` | Who does it (`RemedyActor`, below); never the client |
| `label` | Short and tool-neutral, e.g. "Allow motion control"; each tool names its own button |
| `detail` | Who does what, where, in the client's own words; never controller text such as the holder's station name, which stays in `refusal.holder` |
| `appliesTo` | `generation`; `scope`, how far the step reaches once done: `session`, `station` (the RobotWare 8 control station, possibly wider than one session), `controller`, `user`, `configuration` or `operation`; `operation`, the refused request as `METHOD /path` |
| `call` | Only for `person-confirms-in-a-tool`, and always there for it: `{ method: 'setAllowMotionControl', allow: true }`, `{ method: 'requestRmmp', level: 'modify' \| 'exec' }`, `{ method: 'stopRapid' }` or `{ method: 'setMotorsOn' }`. Flat, so it survives a consumer that passes refusals on as bounded JSON |
| `safetyDeclaration` | `true` on `declare-motion-control` only: a person's safety confirmation, never automated |
| `afterwards` | `run-again` (the person runs the refused operation again; never the client) or `nothing` |
| `evidence`, `basis` | How sure, as for the refusal, and the ABB document or run it rests on |

| `byWhom` | Who |
|----------|-----|
| `person-confirms-in-a-tool` | A client method does it (`call`), called by a tool only after a person confirms there |
| `person-at-this-tool` | The person changes the input or runs the operation again |
| `person-at-pendant` | A person at the robot: the FlexPendant, the mode selector, a safety reset |
| `other-station` | The current holder: another tool, a PLC, another session |
| `administrator` | A UAS administrator |
| `integrator` | The owner of the I/O and system-parameter configuration |
| `none` | Nobody can supply it from a remote tool |

| `kind` | Step | `call` |
|--------|------|--------|
| `declare-motion-control` | RobotWare 8: a person with both stops within reach allows motion control for this control station; or start or jog at the FlexPendant | `setAllowMotionControl` (`allow: true`) |
| `request-rmmp` | RobotWare 6 and 7 in manual mode: this tool asks for RMMP at the level that covers the operation (`modify`; `exec` for a RobotWare 7 program-pointer move to a routine) | `requestRmmp` |
| `grant-rmmp-at-pendant` | The operator presses Grant at the FlexPendant (after a denial: speak to them first) | |
| `remote-access-on` | An operator allows Remote Access at the FlexPendant (Messages button, more than 1 s) | |
| `release-pendant-write-access`, `release-pendant-mastership` | The FlexPendant holds the access; the person there releases it | |
| `holder-releases` | The holder releases it (RobotWare 8: the FlexPendant can always take write access back) | |
| `release-own-hold` | This session's own hold ends first | |
| `stop-program-first` | A person stops RAPID (a program stop), then runs the operation again | `stopRapid` |
| `motors-on` | RobotWare 6 and 7 in Auto: from this tool after a person confirms; otherwise at the controller (RobotWare 8: Reset; manual mode: the enabling device) | `setMotorsOn` (offered on RobotWare 6 and 7 in Auto) |
| `reset-safety-stop` | Someone at the cell clears and resets a guard stop or emergency stop | |
| `mode`, `confirm-mode-change` | The operating mode changes at the controller; a pending change is confirmed at the FlexPendant | |
| `do-at-pendant` | Someone does it at the FlexPendant | |
| `grant-missing`, `signal-access-level` | The owner (a UAS administrator, the integrator) decides; relaxing a grant or an access level is never the remedy | |
| `run-again`, `reconnect`, `fix-input`, `check-state` | The person runs it again, connects again, corrects the input, or checks the controller state | |
| `wait`, `nothing-needed`, `option-missing`, `not-available`, `report`, `none-known` | An operation in progress ends by itself; nothing is missing; a RobotWare option; not offered here; a client error to report; no known step | |

Rules: `call` is set if and only if `byWhom` is `person-confirms-in-a-tool`, and
every refusal with such a remedy also carries one without a `call`.
`declare-motion-control` is offered only on RobotWare 8, only for
`motion-control-off`, and is the primary remedy only when the controller itself
answered -1073435864; a jog refused while motion control merely read as not
allowed gets `check-state` first. `request-rmmp` is never offered on RobotWare
8, in Auto, for a start, PP to Main, another pointer move, a signal write, a jog,
a motors write or a missing option. The `motors-on` call is offered on RobotWare
6 and 7 only, and that is the remedy's rule, not a limit of `setMotorsOn`. On an
8.2.1 virtual controller in Auto, `setMotorsOn` after `setMotorsOff` was
accepted (204), and in guard stop it was refused (403 -1073445806). A jog is never sent to Auto: on RobotWare 6
and 7 in manual mode its remedy is `do-at-pendant` alone. Every remedy string is
one line, under 1000 characters. More kinds may be added in minor releases.

`confirmationFor(remedy, { name, label, virtual?, flexPendantConnected? })` gives
the text a tool shows a person before it makes the call: `title`, `lines` (the
client's, one fact each; a tool may add its own after them), `confirmLabel`,
`typeName` (true: the person then types the robot's name) and `typePrompt`. For
`declare-motion-control` the lines say the person confirms that an emergency
stop and a normal stop are within reach for every robot and axis the controller
moves, what a normal stop is (the FlexPendant's Stop button held for more than
1 s, a category 1 stop), a line for a virtual controller, a line when the
FlexPendant reads as not connected, and that allowing it moves nothing by
itself. It is null for a remedy without a `call`. The client never calls it.

```ts
import { RwsError, confirmationFor } from 'abb-rws-client';

try {
  await mgr.startRapid();
} catch (e) {
  const r = e instanceof RwsError ? e.refusal : undefined;
  if (r?.remedy?.call) {
    const text = confirmationFor(r.remedy, { name: 'IRB1600', label: 'IRB1600 (127.0.0.1:80)' });
    // Show text to the person; only on their confirmation (and typed name)
    // does the tool make r.remedy.call. Nothing is retried on its own.
  } else if (r?.remedy) {
    console.log(`${r.remedy.label}: ${r.remedy.detail}`);
  }
}
```

---

## Session Persistence

IRC5 controllers allow a maximum of **70 concurrent RWS sessions**; OmniCore controllers also have a finite session pool (the exact number isn't published, but heavy probing without `/logout` returns HTTP 503 once it fills). Persist the session cookie across restarts to always reuse the same slot - the lib calls `/logout` on `disconnect()` to free the slot cleanly, but a saved cookie is the most robust path:

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

Reuse a saved cookie only with the credentials that created it, and log in with the given credentials otherwise. `RobotManager` does this for you on RWS 1.0: it keeps its cookies in `~/.abb-rws-session` (owner-only), keyed by host, port and a one-way verifier of the credentials, and removes an entry when its `disconnect()` logs that session out. It writes no RWS 2.0 cookie there: only RWS 1.0 reuses one, and on RobotWare 8 a cookie left on disk after a crash would name a session that may hold a motion-control allowance.

---

## Rate Limits

| Constraint | Value | Source |
|------------|-------|--------|
| Max request rate | 20 req/sec | Both protocols (controller-enforced) |
| Client-enforced interval | 100 ms between requests | This package, default (twice the 50 ms ABB states) |
| Max concurrent sessions | 70 (IRC5) / finite (OmniCore) | Controller-enforced |
| Session inactivity timeout | 5 minutes (IRC5) | Controller-enforced |
| Max session lifetime | 25 minutes (IRC5) | Controller-enforced |
| Max file upload | 800 MB (IRC5) | Controller-enforced; OmniCore is similar |

OmniCore-specific limits aren't fully documented by ABB; what the lib observes empirically matches the IRC5 numbers within an order of magnitude.

---

<!-- BEGIN GENERATED: operations (npm run readme:gen; do not edit by hand) -->

## Operations by tier

Every RWS operation the client knows is one row of its path tables (`src/paths`).
Each row has a **tier** - `core` (what every robot application needs), `common`
(what a cell tool reaches for regularly) or `niche` (options, commissioning,
diagnostics, virtual-controller simulation) - and, per generation, its **evidence**:
`live` when a probe log or a functional-test trace holds that request with a 2xx
answer (nothing else counts; `tests/fixtures/evidence-index.json` lists one logged
success per live side), `built` when there is no logged success. `unsupported` is
an operation that generation does not have, or that its controller refuses; the
client refuses it before sending, and the row records why.

`IRWSAdapterCore` declares the core and common operations that have run on every
generation they have; `IRWSAdapter` declares every operation, with the never-run
ones marked `@experimental`.

| Tier | Rows | Live on every generation it has | Built, never run | Live on one generation only |
|------|-----:|-----:|-----:|-----:|
| core | 33 | 33 | 0 | 0 |
| common | 144 | 136 | 5 | 3 |
| niche | 141 | 94 | 38 | 9 |
| **all** | **318** | | | |

<details><summary>Panel (20)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `getControllerState` | core | live | live | Read the controller motor state (motoron / motoroff / init / …). |
| `getOperationMode` | core | live | live | Read the operation mode (AUTO / MANR / MANF). |
| `getSpeedRatio` | core | live | live | Read the speed override (0-100). |
| `setControllerState` | core | live | live | Set the motor state. Requires mastership (acquired one layer up). |
| `setOperationMode` | core | unsupported | live | Switch the operation mode. Virtual controllers only. |
| `setSpeedRatio` | core | live | live | Set the speed override. AUTO mode only. |
| `acknowledgeOperationMode` | common | unsupported | built | Confirm a pending operation-mode switch. |
| `getCollisionDetectionState` | common | live | live | Read the collision-detection state (INIT / TRIGGERED / …). |
| `restartController` | common | live | live | Restart the controller. |
| `getEnableRequest` | niche | - | live | Read the enable-request state. |
| `getOperationModeLockState` | niche | - | live | Read whether the operation-mode key switch is locked. |
| `lockOperationMode` | niche | built | live | Lock the operating-mode selection with a PIN. |
| `setExternalEmergencyStop` | niche | - | live | Simulate the external emergency-stop circuit. |
| `setKeylessMotorOn` | niche | live | live | Motors on without the key switch (Keyless Mode Switch option). |
| `setPanelLanguage` | niche | live | live | Set the panel language. |
| `simAutoStop` | niche | - | live | Simulate the auto stop (VC only). INVERTED polarity. |
| `simEmergencyStop` | niche | - | live | Simulate the emergency stop (VC only). INVERTED polarity: state=off engages. |
| `simEnableSwitch` | niche | - | live | Simulate the enable switch (VC only). DIRECT polarity: state=on pressed. |
| `simGeneralStop` | niche | - | live | Simulate the general stop (VC only). INVERTED polarity. |
| `unlockOperationMode` | niche | built | live | Unlock the operating-mode selection with the PIN the lock set. |

</details>

<details><summary>RAPID (78)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `getRapidExecutionInfo` | core | live | live | Read execution state and cycle from the same resource. |
| `getRapidExecutionState` | core | live | live | Read the RAPID execution state (running / stopped / …). |
| `getRapidVariable` | core | live | live | Read a RAPID symbol's value. |
| `resetRapid` | core | live | live | Reset the program pointer for ALL tasks (global PP reset). |
| `setRapidVariable` | core | live | live | Write a RAPID symbol's value. |
| `startRapid` | core | live | live | Start RAPID execution. |
| `stopRapid` | core | live | live | Stop RAPID execution. |
| `activateAllRapidTasks` | common | live | - | Activate all RAPID tasks. |
| `activateRapidTask` | common | live | live | Activate one RAPID task. |
| `deactivateAllRapidTasks` | common | live | - | Deactivate all RAPID tasks. |
| `deactivateRapidTask` | common | live | live | Deactivate one RAPID task. |
| `getActiveUiInstruction` | common | live | live | Read the active UI instruction. |
| `getBuildErrors` | common | live | live | List the build errors of a task's program (module, row, column, error). |
| `getExecutionErrorState` | common | - | live | Read whether the most recent RAPID stop was caused by an error (RobotWare 8.2 and later). |
| `getModuleChangeCount` | common | - | live | Read a module's change counter. |
| `getModuleInfo` | common | live | live | Read one module's info. |
| `getModuleText` | common | live | live | Read module text from program memory. |
| `getModuleTextRange` | common | live | live | Read a text range from a module. |
| `getMotionPointer` | common | built | built | Read the per-task motion pointer. |
| `getProgramPointer` | common | live | live | Read the program pointer for a task. |
| `getRapidSymbolProperties` | common | live | live | Read a RAPID symbol's properties. |
| `getRapidTask` | common | live | live | Read one RAPID task (state and properties). |
| `getRapidTasks` | common | live | live | List the RAPID tasks. |
| `getTaskChangeCount` | common | - | live | Read the task change counter (change-count span). |
| `getTaskJointTarget` | common | - | live | Read the task's current jointtarget (degrees; external axes 9E9 when absent). |
| `getTaskMechunits` | common | - | live | List the mechanical units the task drives, with mode and type. |
| `getTaskMotion` | common | live | live | Read the task motion directory (links). |
| `getTaskProgramInfo` | common | live | live | Read the loaded program info for a task. |
| `getTaskRobTarget` | common | - | live | Read the task's current robtarget (mm, quaternion, robconf, external axes). |
| `getTaskSelection` | common | live | live | Read the selected-task set. |
| `getTaskStructuralChangeCount` | common | live | live | Read the task structural-change counter. |
| `listBreakpoints` | common | live | live | List breakpoints in a task. |
| `listModuleRoutines` | common | live | live | List routines in a module. |
| `listModules` | common | live | live | List the modules in a task. |
| `listModulesDetailed` | common | live | live | List modules with extended fields. |
| `listServiceRoutines` | common | live | live | List a task's service routines. |
| `loadModule` | common | live | live | Load a module into a task. |
| `loadProgram` | common | live | live | Load a program (.pgf) into a task. |
| `ppNextInst` | common | live | live | Move the program pointer to the next instruction (manual mode). |
| `ppPrevInst` | common | live | live | Move the program pointer to the previous instruction (manual mode). |
| `removeBreakpoint` | common | - | built | Remove a breakpoint. |
| `resetTaskProgramPointer` | common | - | live | Reset the program pointer for one task. |
| `saveModule` | common | live | live | Save one module to disk. |
| `saveProgram` | common | live | live | Save the task program to disk. |
| `searchModuleText` | common | - | live | Search module text. |
| `searchRapidSymbols` | common | live | live | Search RAPID symbols. |
| `setBreakpoint` | common | live | live | Set a breakpoint. |
| `setExecutionCycle` | common | live | live | Set the run cycle (once / forever / asis). |
| `setModuleText` | common | live | live | Replace module text in program memory. |
| `setModuleTextRange` | common | live | live | Replace a text range in a module. |
| `setPPToCursor` | common | live | live | Set the program pointer to a module cursor position. |
| `setProgramPointer` | common | live | live | Set the program pointer to a routine. |
| `setTaskSelection` | common | - | unsupported | Set the whole task selection at once (no such RWS operation). |
| `setUiInstructionParam` | common | live | built | Answer a UI instruction parameter. |
| `startProductionEntry` | common | live | live | Start from the production entry routine. |
| `stepRapid` | common | built | live | Single-step execution (step in / over / out). |
| `unloadModule` | common | live | live | Unload a module from a task. |
| `unloadProgram` | common | live | live | Unload the program from a task. |
| `validateRapidValue` | common | live | live | Validate a value against a RAPID data type. |
| `callServiceRoutine` | niche | - | unsupported | Invoke a service routine (no such RWS 2.0 operation). |
| `getModPossibleAll` | niche | - | live | Read whether modification (ModPos) is possible across all modules. |
| `getModuleAttributes` | niche | - | live | Read a module's possible attributes. |
| `getModuleExtension` | niche | - | live | Read a module's extension info. |
| `getModuleModPossible` | niche | - | live | Read whether modification is possible in one module. |
| `getModuleObject` | niche | - | live | Read a module's RAPID object resource. |
| `getModuleSymbolInfo` | niche | - | live | Read a module's symbol resource. |
| `getModuleSyncPersStatus` | niche | - | live | Read a module's persistent-variable sync status. |
| `getMotionPointerSyncState` | niche | - | live | Read the global motion-pointer sync state. |
| `getProgramPointerSyncState` | niche | - | live | Read the global program-pointer sync state. |
| `getSpyStatus` | niche | - | live | Read the RAPID spy status. |
| `getTaskActivationRecord` | niche | built | built | Read the task activation record (stack frame). |
| `getTaskExtJointState` | niche | - | live | Read the state of the task's six external joints. |
| `holdToRun` | niche | live | built | Hold-to-run dead-man gating for stepped/continuous motion. |
| `listAliasIO` | niche | live | built | List RAPID alias-I/O signals. |
| `listInstructionCategories` | niche | - | live | List RAPID instruction categories (pallet head). |
| `listInstructions` | niche | - | live | List instructions within a category (pallet). |
| `modifyPosition` | niche | - | built | Modify a position (ModPos) in a module. |
| `setPPToRoutineFromUrl` | niche | - | built | Set the program pointer to a routine by URL. |

</details>

<details><summary>Motion system (42)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `getCartesianFull` | core | live | live | Read the full cartesian pose plus configuration of a mechanical unit. |
| `getJointPositions` | core | live | live | Read the current joint target of a mechanical unit. |
| `getJointTargetFull` | core | live | live | Read every axis slot of a mechanical unit (rax_1..6 and eax_a..f). |
| `getRobTarget` | core | live | live | Read the current cartesian robtarget of a mechanical unit. |
| `calcCartesianFromJoints` | common | live | live | Forward kinematics: compute a cartesian pose from joint values. |
| `calcJointsFromCartesian` | common | live | live | Inverse kinematics: compute joint values for a cartesian pose. |
| `checkMotionChangeCount` | common | live | live | Check whether a known change count is still current. |
| `getActivePayload` | common | live | live | Read the active payload of a mechanical unit. |
| `getActiveTool` | common | live | live | Read the active tool of a mechanical unit (tool-name attribute). |
| `getActiveWobj` | common | live | live | Read the active work object of a mechanical unit (wobj-name attribute). |
| `getMechunitAxes` | common | live | live | Read the axis status of a mechanical unit. |
| `getMechunitBaseFrame` | common | live | live | Read the base frame of a mechanical unit. |
| `getMechunitInfo` | common | live | live | Read a mechanical unit resource (type, mode, active tool/wobj/payload). |
| `getMotionChangeCount` | common | live | live | Read the motion-system change counter. |
| `getMotionErrorState` | common | live | live | Read the motion error state. |
| `jog` | common | built | live | Jog a mechanical unit. |
| `listMechunits` | common | live | live | List the mechanical units of the motion system. |
| `setActiveTool` | common | live | live | Set the active tool of a mechanical unit. |
| `setActiveWobj` | common | live | live | Set the active work object of a mechanical unit. |
| `setMechunitForJogging` | common | live | live | Select the mechanical unit that subsequent jog calls act on. |
| `getAxisPose` | niche | - | live | Read the pose of a single axis of a mechanical unit. |
| `getCollisionPredictionMode` | niche | - | live | Read whether collision prediction is enabled. |
| `getCollisionPredictionModel` | niche | - | live | Read the collision-prediction model for a mechanical unit. |
| `getCollisionPredictionModelName` | niche | - | live | Read the collision-prediction model name for a robot. |
| `getLeadThrough` | niche | live | live | Read the compliance lead-through state of a mechanical unit. |
| `getMechunitCalib` | niche | - | live | List the calibration resources of a mechanical unit. |
| `getMechunitMotorCalib` | niche | live | live | Read the motor calibration names of a mechanical unit. |
| `getMechunitPjoints` | niche | live | live | Read the physical-joint (pjoints) values of a mechanical unit. |
| `getMechunitSmbData` | niche | live | live | Read the serial measurement board (SMB) data of a mechanical unit. |
| `getMotionSupervision` | niche | live | live | Read the motion-supervision state of a mechanical unit. |
| `getNonMotionExecution` | niche | live | live | Read the non-motion (dry-run) execution mode. |
| `getPathSupervision` | niche | live | live | Read the path-supervision state of a mechanical unit. |
| `loadCollisionAvoidanceConfig` | niche | - | built | Load the collision-avoidance configuration. |
| `saveCollisionAvoidanceSnapshot` | niche | - | built | Save a collision-avoidance snapshot to file. |
| `setCollisionPredictionMode` | niche | - | live | Enable or disable collision prediction. |
| `setMechunitBaseFrame` | niche | live | live | Set the base frame of a mechanical unit. |
| `setMotionSupervisionMode` | niche | - | built | Turn motion supervision (collision detection) while jogging on or off for a mechanical unit. |
| `setMotionSupervisionSensitivity` | niche | - | built | Set the motion-supervision sensitivity for a mechanical unit. |
| `setNonMotionExecution` | niche | built | live | Set the non-motion (dry-run) execution mode. |
| `setPathSupervisionMode` | niche | - | built | Enable or disable path supervision for a mechanical unit. |
| `setRobtargetForJogging` | niche | live | - | Set the position target used by jogging to a position. |
| `teleportMechunit` | niche | - | live | Jump a mechanical unit to a joint position (VC only). |

</details>

<details><summary>I/O (20)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `listAllSignals` | core | live | live | List all I/O signals (paginated). |
| `readSignal` | core | live | live | Read one signal by network/device/name. |
| `readSignalByName` | core | live | live | Read one signal by its bare name, without network and device. |
| `writeSignal` | core | live | live | Set a signal value. |
| `writeSignalByName` | core | live | live | Set the value of a signal addressed by its bare name. |
| `getIoDeviceConfig` | common | live | live | Read the config record for one I/O device. |
| `getIoDeviceInfo` | common | live | live | Read one I/O device. |
| `getIoNetwork` | common | live | live | Read one I/O network. |
| `getIoNetworkConfig` | common | live | live | Read the config record for one I/O network. |
| `getSignalConfig` | common | live | live | Read the config record for one signal. |
| `listAllIoDevices` | common | live | live | List all I/O devices across every network. |
| `listDevices` | common | live | live | List the devices on one network. |
| `listNetworks` | common | live | live | List all I/O networks. |
| `searchIoDevices` | common | live | live | Search I/O devices by name / lstate / network (ios-device-li). |
| `searchSignals` | common | live | live | Search signals by criteria (case-insensitive prefix on name, AND-composed). |
| `searchSignalsEx` | common | live | live | Extended signal search - up to two AND-narrowing criteria sets. |
| `setIoDeviceLState` | niche | built | live | Enable / disable an I/O device. |
| `setNetworkLState` | niche | - | live | Start / stop an I/O network. |
| `setSignalSimulated` | niche | built | live | Simulate / unsimulate one signal. |
| `unblockSignals` | niche | built | live | Unblock all blocked signals (collection-level action). |

</details>

<details><summary>Configuration, event log and DIPC (27)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `getEventLog` | core | live | live | Read a domain of event-log messages (paginated on 2.0). |
| `getEventLogMessage` | core | live | live | Read a single event-log message by domain + sequence number. |
| `listEventLogDomains` | core | live | live | List the event-log domains. |
| `clearEventLog` | common | live | live | Clear one event-log domain. |
| `createCfgInstance` | common | live | live | Create a default-valued configuration instance. |
| `createDipcQueue` | common | live | live | Create a DIPC queue. |
| `getCfgInstance` | common | live | live | Read one configuration instance by name. |
| `getCfgType` | common | live | live | Read one configuration type: its attribute and instance counts. |
| `getDipcQueueInfo` | common | live | live | Read a DIPC queue's information (size, message count, …). |
| `getEventLogMessageBySeqnum` | common | - | live | Read a message by global sequence number (domain-agnostic lookup). |
| `listCfgDomains` | common | live | live | List the configuration domains (EIO, MOC, SYS, …). |
| `listCfgInstances` | common | live | live | List the instances of a configuration type. |
| `listCfgTypeAttributes` | common | live | live | List the attribute definitions of a configuration type. |
| `listCfgTypes` | common | live | live | List the instance types within a configuration domain. |
| `listDipcQueues` | common | live | live | List the DIPC (inter-process communication) queues. |
| `loadCfgFile` | common | live | live | Load a configuration file into the controller. |
| `readDipcMessage` | common | live | live | Read (and consume) one message from a DIPC queue. |
| `removeCfgInstance` | common | live | live | Delete a configuration instance. |
| `removeDipcQueue` | common | live | live | Delete a DIPC queue. |
| `saveCfgFile` | common | live | live | Save a configuration domain to a file. |
| `saveEventLogRaw` | common | live | live | Save the raw event log to a file. |
| `sendDipcMessage` | common | live | live | Send a message to a DIPC queue. |
| `setCfgInstance` | common | live | live | Update a configuration instance. Needs cfg/edit mastership. |
| `validateCfgFile` | common | live | live | Validate a configuration file (a load dry-run) without applying it. |
| `clearAllEventLogs` | niche | live | live | Clear every event-log domain. |
| `validateCfgInstances` | niche | - | built | Validate existing configuration instances (not a create dry-run). |
| `validateInstanceBeforeDelete` | niche | live | - | Check whether a configuration instance can be safely deleted (dry-run). |

</details>

<details><summary>Controller (53)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `checkRestore` | common | live | live | Validate a backup before restoring. |
| `createBackup` | common | live | live | Create a backup (async, 202). |
| `getBackupState` | common | - | live | Read the backup state. |
| `getBackupStatus` | common | live | live | Read whether a backup is running (from the backup state). |
| `getControllerClock` | common | live | live | Read the controller date/time (UTC). |
| `getControllerIdentity` | common | live | live | Read controller name, id, type, MAC. |
| `restartController` | common | live | live | Restart the controller (canonical /ctrl form on 2.0). |
| `setControllerClock` | common | built | built | Set the controller date/time (UTC). |
| `clearCertificateStore` | niche | - | built | Remove every certificate from one store. |
| `compressPath` | niche | live | live | Compress a controller path. |
| `ctrlOptionsVerify` | niche | unsupported | unsupported | The bare /ctrl/options resource, which carries no option list (see listControllerOptions). |
| `decompressPath` | niche | built | built | Decompress a controller path. |
| `getCertificates` | niche | - | live | Read certificates in a store. |
| `getCompatibility` | niche | built | built | Check whether the controller hardware can run a RobotWare version (real controllers only). |
| `getCyclicBrakeCheckStatus` | niche | - | live | Read cyclic-brake-check status. |
| `getDiagnostics` | niche | - | built | Read saved controller diagnostics. |
| `getDnsConfig` | niche | built | - | Read DNS configuration. |
| `getEnv` | niche | live | live | Read one controller environment variable ($HOME, $TEMP, $SYSTEM, ...). |
| `getNetworkConfig` | niche | live | - | Read network configuration. |
| `getRegistry` | niche | - | live | Read the controller registry index. |
| `getRegistryFile` | niche | - | live | Read a registry file. |
| `getRestartCount` | niche | - | live | Read how many times the controller has restarted. |
| `getRoutingTable` | niche | built | - | Read the routing table (a path ABB does not document). |
| `getSafetyConfig` | niche | - | live | Read the safety configuration (status, versions, creator, checksum). |
| `getSafetyConfigChangeCount` | niche | - | live | Read the safety-configuration change count. |
| `getSafetyLoadStatus` | niche | - | live | Read the safety load status. |
| `getSafetyMode` | niche | - | live | Read the safety mode. |
| `getSafetyStartupStatus` | niche | - | live | Read the safety startup status. |
| `getSafetyStatus` | niche | live | - | Read the aggregate controller safety status. |
| `getSafetyViolationInfo` | niche | - | live | Read safety violation info. |
| `getSyslog` | niche | - | unsupported | Read the controller system log. |
| `getSystems` | niche | - | unsupported | Read the installed system (RC only). |
| `getTimezone` | niche | built | - | Read the controller timezone. |
| `getVirtualTimeClock` | niche | live | live | Read the current virtual time. |
| `getVirtualTimeScale` | niche | live | live | Read the virtual-time speed. |
| `getVirtualTimeState` | niche | live | live | Read the virtual-time running state. |
| `getVirtualTimeTimeslice` | niche | live | live | Read the virtual-time timeslice. |
| `listCertificateStores` | niche | - | live | List certificate stores. |
| `listFeatures` | niche | - | live | List controller features. |
| `listSafetyZones` | niche | unsupported | unsupported | List safety zones (no such RWS resource). |
| `removeCertificate` | niche | - | unsupported | Delete one certificate (no such RWS operation). |
| `restoreBackup` | niche | live | built | Restore a backup. |
| `runCyclicBrakeCheck` | niche | unsupported | unsupported | Run a cyclic brake check (no such RWS operation). |
| `saveDiagnostics` | niche | - | live | Ask the controller to save a diagnostics bundle. |
| `saveSystemInfo` | niche | - | built | Copy the system's installation files (RMF, RSF, RLF) into a controller directory (real controllers only). |
| `setControllerLanguage` | niche | live | live | Set the controller language. |
| `setVirtualTimeScale` | niche | unsupported | live | Set the virtual-time speed. |
| `setVirtualTimeTimeslice` | niche | - | live | Set the virtual-time timeslice. |
| `systemUpdate` | niche | - | unsupported | Software update (barred by the destructive ceiling). |
| `tpuDetach` | niche | - | unsupported | Detach the FlexPendant for hot-swap. |
| `tpuScreendump` | niche | - | unsupported | Capture a FlexPendant screenshot. |
| `uploadCertificate` | niche | - | built | Add a certificate to a store from a PEM file on the controller. |
| `verifyControllerFeature` | niche | - | live | Check whether one controller feature is present. |

</details>

<details><summary>System, mastership and control station (30)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `getMastershipStatus` | core | live | live | Read mastership status for a domain (who holds it). |
| `getSystemInfo` | core | live | live | Read system info (RobotWare version, system name, options). |
| `getWriteAccessStatus` | core | - | live | Read who holds write access. |
| `registerControlStationRemote` | core | - | live | Register a remote control station (RW8 SPoC). |
| `releaseMastership` | core | live | live | Release mastership for a domain. |
| `releaseWriteAccess` | core | - | live | Release write access. |
| `requestMastership` | core | live | live | Acquire mastership for a domain (needed before a write). |
| `requestWriteAccess` | core | - | live | Request write access (RW8 successor to mastership). |
| `getControlStationId` | common | - | live | Read the control-station id. |
| `getControlStationType` | common | - | live | Read the control-station type. |
| `getRobotType` | common | live | live | Read the robot types (one per robot on a MultiMove system). |
| `isLocalControlStationConnected` | common | - | live | Read whether the local control station is connected. |
| `listControllerOptions` | common | live | live | List installed controller options. |
| `listMastershipDomains` | common | live | live | List the mastership domains. |
| `releaseMastershipAll` | common | live | live | Release mastership for all domains. |
| `requestMastershipAll` | common | live | live | Acquire mastership for all domains at once. |
| `appealWriteAccessRelease` | niche | - | live | Appeal a pending write-access release. |
| `disableExternalControl` | niche | - | built | Turn off external control (Remote Access); a local control station (the FlexPendant) only. |
| `getAllowMotionControl` | niche | - | live | Read whether motion control is allowed. |
| `getEnergyStats` | niche | live | live | Read energy-consumption statistics. |
| `getLicenseInfo` | niche | live | live | Read the controller license. |
| `getTpuSafetyProtocolStatus` | niche | - | live | Read the TPU safety-protocol status. |
| `getWriteAccessAppealChangeCount` | niche | - | live | Read the write-access appeal change counter. |
| `listProducts` | niche | live | live | List installed RobotWare products. |
| `registerControlStationLocal` | niche | - | built | Register the local control station (RW8 SPoC). |
| `releaseMastershipWithId` | niche | - | live | Release a token-held mastership. |
| `requestMastershipWithId` | niche | - | live | Acquire mastership, returning an id token; released with the id on disconnect. |
| `resetEnergy` | niche | - | live | Reset the energy-consumption counters. |
| `resetMastershipWatchdog` | niche | - | live | Reset the mastership watchdog to keep the grant alive. |
| `setAllowMotionControl` | niche | - | live | Set whether motion control is allowed. |

</details>

<details><summary>Users and UAS (27)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `cancelRmmp` | common | live | live | Cancel this session's pending/held RMMP request. |
| `getLoginInfo` | common | - | live | Read the current session login info. |
| `getRmmpPrivilege` | common | live | live | Read the RMMP (request manual mode privileges) grant for this session. |
| `getUasUser` | common | - | live | List the sub-resources of one UAS user. |
| `listAllGrants` | common | - | live | List every UAS grant defined on the controller. |
| `listCurrentUserGrants` | common | live | live | List the grants held by the current user. |
| `listUasRoleGrants` | common | - | live | List the grants of one UAS role. |
| `listUasRoles` | common | - | live | List the UAS roles defined on the controller. |
| `listUasUserGrants` | common | - | live | List the grants of one UAS user. |
| `listUasUserRoles` | common | - | live | List the roles of one UAS user. |
| `listUasUsers` | common | - | live | List the UAS users defined on the controller. |
| `pollRmmp` | common | live | live | Poll a pending RMMP request - keeps the grant window alive and reports its status. |
| `requestRmmp` | common | live | live | Request an RMMP privilege level. |
| `changePassword` | niche | - | built | Change the current user password. |
| `checkGrantExists` | niche | - | live | Check whether a named UAS grant exists. |
| `getLdapResource` | niche | - | built | Read one LDAP configuration sub-resource by name. |
| `getUasConfiguration` | niche | - | unsupported | Read the controller's UAS database (not wrapped). |
| `getUasRole` | niche | - | live | List the sub-resources of one UAS role. |
| `getUasRoleDescription` | niche | - | live | Read one UAS role's description. |
| `getUasUserDescription` | niche | - | live | Read one UAS user's description. |
| `impersonateUser` | niche | - | built | Act as another session's UAS user, given its uid (same credentials, same machine). |
| `isPasswordChangeAllowed` | niche | - | live | Read whether the current user may change their password. |
| `isUasUserEnabled` | niche | - | live | Read whether one UAS user is enabled. |
| `isUasUserPasswordChangeAllowed` | niche | - | live | Read whether a named UAS user may change their password. |
| `listLdapResources` | niche | - | live | List the LDAP configuration sub-resources. |
| `registerUser` | niche | - | live | Register this session's user alias, application and location (free text) as a local or remote client. |
| `uploadUasConfiguration` | niche | - | unsupported | Upload a new UAS database, used after a restart (not wrapped). |

</details>

<details><summary>Files, subscriptions and vision (21)</summary>

| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |
|-----------|------|---------|---------|--------------|
| `copyFile` | common | live | live | Copy a file within its own directory. |
| `createDirectory` | common | live | live | Create a directory. |
| `createSubscription` | common | live | live | Create a subscription group and open its event stream. |
| `deleteFile` | common | live | live | Delete a file or directory. |
| `getFileMetadata` | common | live | live | Read a file's metadata without downloading it. |
| `listDirectory` | common | live | live | List the contents of a file-service directory. |
| `listFileVolumes` | common | live | live | List the file-service volumes (drives / home). |
| `readFile` | common | live | live | Read a file's raw bytes. |
| `renameFile` | common | live | live | Rename a file in place. |
| `unsubscribeGroup` | common | live | live | Delete a subscription group. |
| `updateSubscriptionGroup` | common | live | live | Add resources to an existing subscription group. |
| `uploadFile` | common | live | live | Write or replace a file (raw body). |
| `getSubscriptionGroup` | niche | live | live | List the resources bound to one subscription group. |
| `getVisionCameraCount` | niche | - | live | Read the number of connected vision cameras. |
| `getVisionSystemInfo` | niche | built | built | Read one camera's details. |
| `listSubscriptionGroups` | niche | live | live | List the session's subscription groups. |
| `listVisionJobs` | niche | - | built | Read a camera's job name. |
| `listVisionSystems` | niche | live | live | List the configured vision systems / cameras. |
| `refreshVisionCameras` | niche | - | live | Rescan for connected vision cameras. |
| `triggerVisionJob` | niche | unsupported | unsupported | Trigger a vision job (no such RWS operation). |
| `unsubscribeResource` | niche | live | live | Remove a single resource from a subscription group. |

</details>

## Known limits

These operations have no logged success on the generation named: no probe log and
no functional-test trace holds the request with a 2xx answer. They are built from
the controller's own form or ABB's documentation, in the client so the surface is
complete, and marked `@experimental`; try one on a virtual controller before relying
on it. An unlogged record of a past run does not count.

### Open at this release

- Every logged success comes from RobotStudio virtual controllers; a real controller may refuse what a virtual one accepted (the operating-mode switch, for one, which ABB ties to Local Client privileges), so try a write on a virtual controller first and take the controller's refusal as final.
- Each operation in the lists below has no logged 2xx on the generation it is listed under. Some have one on the other generation: `jog`, `lockOperationMode`, `setIoDeviceLState`, `setNonMotionExecution`, `setSignalSimulated`, `stepRapid`, `unblockSignals` and `unlockOperationMode` are live on RWS 2.0 and built on RWS 1.0; `holdToRun`, `listAliasIO`, `restoreBackup` and `setUiInstructionParam` are live on RWS 1.0 and built on RWS 2.0. A logged run moves an operation to `live` in a later release.
- `getMotionPointer` stays in both lists although its request answers 2xx: it sends the same `GET /rw/rapid/tasks/{task}/pcp` as `getProgramPointer`, and that answer carries the motionpointer entry with no position when no program has started. The logs keep no answer body, so a logged 2xx does not show that a motion pointer with a position was read, and the evidence index does not credit it. On RobotWare 6.16.03 and 7.21.4 virtual controllers it read row 9 col 16 while a MoveAbsJ ran. On RobotWare 8 no program ran for it: the start was refused without the motion-control declaration.
- RobotWare 6 (RWS 1.0): ABB's RWS 1.0 has no breakpoint removal (`removeBreakpoint`), no per-task program-pointer reset (`resetTaskProgramPointer`; `resetRapid` resets every task), no write for the whole task selection (`setTaskSelection`; change one task at a time with `activateRapidTask` / `deactivateRapidTask`) and no service-routine call (`callServiceRoutine`; use `setPPToServiceRoutine`, then start). ABB does document Modify Position on RWS 1.0, but the client has no RWS 1.0 form for `modifyPosition` yet; modify positions at the FlexPendant. The operating-mode acknowledge is left out on purpose. The client refuses all of these before sending. The RWS 1.0 forms for `setSignalSimulated`, `unblockSignals` and `setIoDeviceLState` are built from ABB's RWS 1.0 pages and not yet run: the RobotWare 6.16.03 virtual controller at hand has only drive and safety-panel I/O, nothing safe to change. The RWS 1.0 forms for `setKeylessMotorOn` and `setMechunitBaseFrame` ran on that virtual controller: the motors went from off to on, and the unit's own frame was written back unchanged.
- RobotWare 6: `registerUser` and `impersonateUser` are built for RWS 2.0 only, although ABB's RWS 1.0 documents both (`POST /users`, `POST /users?action=impersonate`); `changePassword` is RWS 2.0 only because RWS 1.0 has no password operation. On RobotWare 6 the three are refused with `UNSUPPORTED_OPERATION` before sending; manage users from RobotStudio or the FlexPendant. `restoreBackup` is live on RobotWare 6 and keeps the backup unless `deleteBackup` is asked for.
- RobotWare 6: the client sends no virtual-time write in this release. `setVirtualTimeScale` is refused before sending, although ABB's RWS 1.0 documents the speed write for virtual controllers. The virtual-time reads work on both generations. Change the simulation speed in RobotStudio.
- Remote jog: ABB's jog pages for RobotWare 6 and 7 ask for a local client with mastership, and this client connects as a remote one. RobotWare 6 refused the jog in Auto, the only mode tried. RobotWare 7.21.4 refused it in manual reduced speed with the motors on; Auto was tried only with the motors off. On a RobotWare 8.2.1 virtual controller, jogs in manual reduced speed were accepted with the motion-control declaration made, and refused in Auto. Elsewhere, jog from the FlexPendant.
- RobotWare 7: a 7.21.4 virtual controller in manual reduced speed refused `requestRmmp('exec')` with 403 -1073445800 (enabling device released), both with its enable switch on and with Enable held at the virtual FlexPendant (manual reduced speed and motors on read back). `exec` asked for while this session holds `modify` resolves `held-lower` and sends nothing. A granted `modify` was still held after 180 s, until `cancelRmmp()`; a longer hold was not measured, and ABB states no lifetime. Request `modify`, or do the `exec` steps at the FlexPendant. RobotWare 6: `exec` has not been sent.
- RobotWare 8: a RAPID start from this client needs motion control allowed for its control station (`setAllowMotionControl(true)`, after a person's confirmation). A RobotWare 8.2.1 virtual controller refused `startRapid` without it (403 -1073435864), also for a program that does not move the robot, and ran the program with it. The client explains that refusal as `GRANT_DENIED`, `refusal.kind` `motion-control-off`, on every call that starts RAPID, and never allows motion control on its own. The refusal carries `remedy.kind` `declare-motion-control`. `disconnect()` withdraws an allowance. Another station, which registers with its own id, read it as not allowed.
- RobotWare 8: a motion-control allowance belongs to the control station, not the session (8.2.1 virtual controller): a second session with the same station id reads it, and a process killed after allowing left it standing for that station for more than 7 minutes, so with a fixed station id a process that starts after a crash finds it allowed, and the client withdraws it at that process's first registration. Not measured: how long it lasts after a crash, whether a mode change, the FlexPendant taking write access, Remote Access off or a restart ends it, or what a withdrawal does to a running program. The client withdraws an allowance it may have left at the next registration of the same station and after a re-issued session; the withdrawals on a mode change and a FlexPendant take-back are built and off in this release.
- RobotWare 8: a virtual controller in guard stop refused both `setKeylessMotorOn` and the remote motors-on (403 -1073445806); switch the motors on at the FlexPendant. `startProductionEntry` and `stepRapid` have not run on RobotWare 8; they are live on RobotWare 7. `setUiInstructionParam` has no logged 2xx on RWS 2.0: RobotWare 7 refused the parameter names tried, and `TPAnswer` was not among them; it is live on RobotWare 6.
- RobotWare 8: `disableExternalControl` and `registerControlStationLocal` are accepted only from a local control station (the FlexPendant), so a remote client gets a refusal, explained as `refusal.kind` `local-only`; Remote Access is the pendant's to switch.
- RobotWare 8: `uploadCertificate`, `clearCertificateStore`, `impersonateUser` and `changePassword` have not been sent, so the write access each needs is unrecorded; the client sends them without a hold and the controller decides. `registerUser`, sent without a hold, answered 201 on an 8.2.1 virtual controller (2026-10-21). `restoreBackup` has not been sent on RWS 2.0; the client holds write access around it, as ABB's RobotWare 8 page asks.
- RobotWare 8: an 8.2.1 virtual controller left speed ratio out of `RobotManager`'s subscription group on some days while the create answered 201, so speed-ratio events did not arrive; the same request bound it on other days, and the cause is not known. The client now creates the group once more with that resource in its other spelling and, if it is still left out, polls everything at the full rate. In a test run on 2026-10-22 that virtual controller left speed ratio out of every group that asked for `/rw/panel/speedratio;speedratio` (24), and each group created with `/rw/panel/speedratio` bound it; the full-rate polling, for a resource left out in both spellings, has not run against a controller.
- RobotWare 8: ABB documents no RWS way to send the write-access watchdog command, so a RAPID start under the client's write access while HeartBeat is enforced is warned about, not blocked; start from the FlexPendant if the controller stops execution.
- Both generations: `setTaskSelection` is refused before sending (`UNSUPPORTED_OPERATION`): ABB has no write for the whole task selection (`/rw/rapid/taskselection` is a read on RWS 1.0 and 2.0); change one task at a time with `activateRapidTask` / `deactivateRapidTask`. `setControllerClock` got 405 from the virtual controllers (RobotWare 6.16.03, 7.21.4 and 8.2.1); ABB lists the clock write for real controllers only, which has not been tried. `getCompatibility` sends ABB's `/ctrl/compatibility/{robotware version}`, which ABB lists for real controllers only; the virtual controllers answer 404, so it has not run.
- RWS 2.0: a switch to Auto is confirmed by the person at the FlexPendant, and `setOperationMode` does not send that confirmation. `RwsClient2.acknowledgeOperationMode` posts ABB's documented `/rw/panel/opmode/acknowledge` and is `@experimental`. The client reads no controller state before a switch: a RobotWare 8.2.1 virtual controller in guard stop accepted it in both directions (Auto to manual reduced speed and back).
- RWS 2.0: `setPPToRoutineFromUrl` takes the routine URL in ABB's documented shape (`/RAPID/{task}/{module}/{routine}`) and always sends `userlevel` (false unless asked). That exact form has not been sent to a controller yet; the other forms tried on RobotWare 7 and 8 were refused (400). Use `setPPToRoutine`.
- RobotWare 7 (seen once, on 7.21.4): a module named like one of its own global symbols, ignoring case, breaks ABB's unique-name rule. The controller loaded it with errors under a renamed name (`<NAME>#2`), and `unloadModule` by the original name was refused (403 -1073414145, its reason written in the event log). `loadProgram` reports the name the controller gave the module, and that refusal of `unloadModule` carries the newest event-log message, which may be about something else. Unload the module by the name `listModules` reports, and name modules so they do not clash. Not tried on RobotWare 6 or 8.

### RWS 1.0 (17)

- `decompressPath` (niche) - Decompress a controller path.
- `getCompatibility` (niche) - Check whether the controller hardware can run a RobotWare version (real controllers only).
- `getDnsConfig` (niche) - Read DNS configuration.
- `getMotionPointer` (common) - Read the per-task motion pointer.
- `getRoutingTable` (niche) - Read the routing table (a path ABB does not document).
- `getTaskActivationRecord` (niche) - Read the task activation record (stack frame).
- `getTimezone` (niche) - Read the controller timezone.
- `getVisionSystemInfo` (niche) - Read one camera's details.
- `jog` (common) - Jog a mechanical unit.
- `lockOperationMode` (niche) - Lock the operating-mode selection with a PIN.
- `setControllerClock` (common) - Set the controller date/time (UTC).
- `setIoDeviceLState` (niche) - Enable / disable an I/O device.
- `setNonMotionExecution` (niche) - Set the non-motion (dry-run) execution mode.
- `setSignalSimulated` (niche) - Simulate / unsimulate one signal.
- `stepRapid` (common) - Single-step execution (step in / over / out).
- `unblockSignals` (niche) - Unblock all blocked signals (collection-level action).
- `unlockOperationMode` (niche) - Unlock the operating-mode selection with the PIN the lock set.

### RWS 2.0 (28)

- `acknowledgeOperationMode` (common) - Confirm a pending operation-mode switch.
- `clearCertificateStore` (niche) - Remove every certificate from one store.
- `decompressPath` (niche) - Decompress a controller path.
- `disableExternalControl` (niche) - Turn off external control (Remote Access); a local control station (the FlexPendant) only.
- `getCompatibility` (niche) - Check whether the controller hardware can run a RobotWare version (real controllers only).
- `getDiagnostics` (niche) - Read saved controller diagnostics.
- `getLdapResource` (niche) - Read one LDAP configuration sub-resource by name.
- `getMotionPointer` (common) - Read the per-task motion pointer.
- `getTaskActivationRecord` (niche) - Read the task activation record (stack frame).
- `getVisionSystemInfo` (niche) - Read one camera's details.
- `holdToRun` (niche) - Hold-to-run dead-man gating for stepped/continuous motion.
- `listAliasIO` (niche) - List RAPID alias-I/O signals.
- `listVisionJobs` (niche) - Read a camera's job name.
- `loadCollisionAvoidanceConfig` (niche) - Load the collision-avoidance configuration.
- `modifyPosition` (niche) - Modify a position (ModPos) in a module.
- `registerControlStationLocal` (niche) - Register the local control station (RW8 SPoC).
- `removeBreakpoint` (common) - Remove a breakpoint.
- `restoreBackup` (niche) - Restore a backup.
- `saveCollisionAvoidanceSnapshot` (niche) - Save a collision-avoidance snapshot to file.
- `saveSystemInfo` (niche) - Copy the system's installation files (RMF, RSF, RLF) into a controller directory (real controllers only).
- `setControllerClock` (common) - Set the controller date/time (UTC).
- `setMotionSupervisionMode` (niche) - Turn motion supervision (collision detection) while jogging on or off for a mechanical unit.
- `setMotionSupervisionSensitivity` (niche) - Set the motion-supervision sensitivity for a mechanical unit.
- `setPathSupervisionMode` (niche) - Enable or disable path supervision for a mechanical unit.
- `setPPToRoutineFromUrl` (niche) - Set the program pointer to a routine by URL.
- `setUiInstructionParam` (common) - Answer a UI instruction parameter.
- `uploadCertificate` (niche) - Add a certificate to a store from a PEM file on the controller.
- `validateCfgInstances` (niche) - Validate existing configuration instances (not a create dry-run).

### UAS writes never sent (2)

Built from the controller's forms; a UAS change on a controller is not made from a
test, so none of these has been sent.

- `changePassword` - Change the current user password.
- `impersonateUser` - Act as another session's UAS user, given its uid (same credentials, same machine).

### Unsupported (17)

The generation named has no such operation, or its controller refuses it; the
client refuses before sending and records the reason.

- `acknowledgeOperationMode` - RWS 1.0: deliberately not wrapped: the operating-mode confirmation belongs to the person at the FlexPendant
- `callServiceRoutine` - RWS 2.0: GET-only resource; nothing is sent (UNSUPPORTED_OPERATION)
- `ctrlOptionsVerify` - RWS 1.0: the bare GET carries no option list (204); the list is /rw/system/options (listControllerOptions). ABB documents a per-option check, GET /ctrl/options/{option}; it is not wrapped; RWS 2.0: the bare GET carries no option list; the list is /rw/system/options (listControllerOptions). ABB documents a per-option check, GET /ctrl/options/{option}; it is not wrapped
- `getSyslog` - RWS 2.0: not wrapped: ABB documents GET /ctrl/syslog (the security syslog, RFC 3164, RW 7.1 and later, answered as text/plain;v=2.0); the VCs answered 406 to the six Accept values tried, and text/plain;v=2.0 was not one of them. RWS 1.0 has no such resource (404)
- `getSystems` - RWS 2.0: RC only (Rev L: Supported only in RC); VC 404 -1073445866, the same answer as a made-up /ctrl path
- `getUasConfiguration` - RWS 2.0: returns the whole UAS configuration database (ABB, UAS service). UAS is administered in RobotStudio; this client reads users, roles and grants one by one (/uas/users, /uas/roles, /uas/grants) and does not export the database. Nothing is sent
- `listSafetyZones` - RWS 1.0: in no ABB document (Rev M lists six /ctrl/safety resources, none of them zones); nothing is sent, the method answers []; RWS 2.0: in no ABB document (Rev L has no zones resource under /ctrl/safety); nothing is sent, the method answers []
- `removeCertificate` - RWS 2.0: in no ABB document and not served; nothing is sent (UNSUPPORTED_OPERATION)
- `runCyclicBrakeCheck` - RWS 1.0: no ABB operation starts a cyclic brake check (ABB documents only the status read); nothing is sent (UNSUPPORTED_OPERATION); RWS 2.0: no ABB operation starts a cyclic brake check (ABB documents only the status read); nothing is sent (UNSUPPORTED_OPERATION)
- `setOperationMode` - RWS 1.0: RWS 1.0 has no operating-mode change: ABB's manual (Rev M) has none, the RW 6.16.03 form offers only lock, unlock and acknowledge, and POST opmode= answers 400 "NO/Invalid action parameter" (also with ?action=setopmode or set, 2026-10-09). The client refuses before sending.
- `setTaskSelection` - RWS 2.0: No operation sets the whole task selection on either generation: ABB documents only GET on /rw/rapid/taskselection (RWS 1.0 Rev M, RWS 2.0 Rev L), and RW 7.21.4 and 8.2.1 answer a POST with 405 -1073414146 "HTTP method not supported by resource" (OPTIONS: GET,OPTIONS; 2026-10-11). ABB changes the selection one task at a time: use activateRapidTask / deactivateRapidTask. The client refuses before sending, on RWS 1.0 too.
- `setVirtualTimeScale` - RWS 1.0: not sent in this release, a deliberate hold of this client: ABB documents POST /ctrl/virtualtime/vtspeed on RWS 1.0 (virtual controllers only), but the client sends no virtual-time write on RobotWare 6; change the simulation speed in RobotStudio
- `systemUpdate` - RWS 2.0: beyond the destructive ceiling - never executed; form recorded only
- `tpuDetach` - RWS 2.0: real controllers with the Hot Swappable FlexPendant option only (ABB Rev L documents the detach, its status read and a cancel, RC only); the RobotWare 7 and 8 VCs answer 404; no client method. RWS 1.0 has no such resource
- `tpuScreendump` - RWS 2.0: real controllers only (ABB Rev L: RC only, RW 7.3 and later); the VCs answer 404 -1073445866; no client method. RWS 1.0 has no such resource
- `triggerVisionJob` - RWS 1.0: in no ABB document; nothing is sent (UNSUPPORTED_OPERATION); RWS 2.0: in no ABB document and not routed; nothing is sent (UNSUPPORTED_OPERATION)
- `uploadUasConfiguration` - RWS 2.0: uploads a new UAS database, which the controller uses after a restart (ABB, UAS service). It replaces who may do what on the controller, which a UAS administrator decides in RobotStudio; this client does not replace UAS data. Nothing is sent

<!-- END GENERATED: operations -->

---

## Compatibility

| | RobotWare 6.x (RWS 1.0) | RobotWare 7.x (RWS 2.0) | RobotWare 8.x (RWS 2.0) |
|--|--|--|--|
| This package | ✅ `RwsClient` | ✅ `RwsClient2` | ✅ `RwsClient2` |
| IRC5 controller (real) | built for, not yet tried | n/a | n/a |
| OmniCore controller (real) | n/a | built for, not yet tried | built for, not yet tried |
| RobotStudio virtual controller | ✅ (RW6.x VC) | ✅ (RW7.x VC) | ✅ (RW8.x VC) |
| Auto-detect from one entry point | ✅ via `createClient()` | ✅ via `createClient()` | ✅ via `createClient()` |
| Write access | Mastership | Mastership | Control Station (automatic) |

Every logged success comes from RobotStudio virtual controllers; a real
controller may refuse what a virtual one accepted (see
[Known limits](#known-limits)).

RobotWare 8 removes the mastership service and requires a registered control
station for write access. The client detects the RobotWare version on connect
and routes write access automatically, so the same code runs on all three
generations. The full Control Station Service is also exposed directly
(`requestWriteAccess`, `getWriteAccessStatus`, `setAllowMotionControl`, ...).
Name the station with the `controlStation` option (see
[RobotWare 8 control-station identity](#robotware-8-control-station-identity)).

**Live-tested matrix**: RobotWare 8.2.1 (OmniCore VC), RobotWare 7.21.4 (OmniCore VC), RobotWare 6.16.03 (IRC5 VC). Unit tests, live protocol-coverage tests and chaos-proxy resilience suites. Endpoint conformance against what the live controllers advertise, from the last crawl (2026-10-10, five builds): 226 implemented · 5 deliberate-gap · 0 unmapped · 0 orphan resource families (`npm run conformance`, see `CONFORMANCE.md`). The gaps are `/ctrl/options` on both generations (the controller advertises it, but the bare resource carries no option list: 200 with an empty state on RW7/8, 204 on RW6; the real option list comes from `/rw/system/options` via `listControllerOptions`, and ABB's per-option check, `GET /ctrl/options/{option}`, is not wrapped) and the RobotWare installation service under `/rw/rim` on RWS 1.0. RWS 2.0 `/uas/configuration` (read or replace the whole UAS database) is a gap too: the client does neither. No family is unmapped.

**Kept until the next major version:** `listSafetyZones` and
`runCyclicBrakeCheck` have no ABB resource behind them on either RWS
generation (no page in ABB's RWS 1.0 or 2.0 documentation; the controllers
answer 404). Neither sends anything: the first answers `[]`, the second throws
`UNSUPPORTED_OPERATION`. `listSafetyZones` is deprecated; both stay for
compatibility until the next major version. For brake checks on RWS 2.0, read
the status with `RwsClient2.getCyclicBrakeCheckStatus` (this client has no
RWS 1.0 status read); a brake check itself is started from RAPID or the
FlexPendant.

---

## Functional tests

`npm run functional` runs a live suite that exercises the client the way its
consumers do: every call goes through the public API (`RobotManager`,
`MultiRobotManager`, `createAdapter`, `createClient`), against RobotStudio
virtual controllers running on the same PC. It is separate from `npm test`,
which stays offline and skips these files.

What it needs:

- One or more RobotStudio virtual controllers on this PC, found through the
  client's own `findControllers` with `loopbackOnly` (or pinned with
  `RWS_TEST_PORT_RW6/7/8`). The lane comes from the 401 challenge (RobotWare 6)
  or the VC's system folder (RobotWare 7 and 8) without a login where it can. There is one lane per RobotWare major (6, 7, 8);
  a lane with no running controller is skipped, with the reason printed.
- The suite talks to `127.0.0.1` only and refuses any other host. Never point
  it at a real robot.

What it does on a controller:

- It covers connecting and protocol detection, panel and system reads, I/O,
  the event log, files, configuration reads, RAPID data and execution,
  motion, subscriptions, mastership and RobotWare 8 write access, system
  operations (backup, DIPC, UAS reads) and, when enabled, a warm restart.
- It moves the virtual robot, in small steps: joint moves relative to where
  the robot stands (axis 1 by a few degrees, axes 4 and 6 by up to 10
  degrees), out and back, at low programmed speeds (`v20` and `v10` in the
  current tests) and a speed ratio of 50 % or less. It switches the motors off and on over RWS where the RobotWare
  version allows it.
- Everything it creates is named `ZZ_PROBE...` (modules, files, DIPC queues,
  backups). Each lane takes a snapshot of the controller first and restores
  it afterwards (RAPID stopped, modules, files, program pointer, cycle, speed
  ratio, operating mode, motors, and on RobotWare 8 a motion-control
  declaration left on); a restore that leaves a difference fails the run and
  names it. A switch to Auto that waits for the confirmation at the
  FlexPendant is never sent again: the restore reports it, and on RobotWare 8
  it writes nothing until the switch is confirmed there.
- It never restores a backup, writes or loads configuration, or writes safety
  configuration or UAS users. It requests RMMP only in the RobotWare 7
  manual-mode jog test (under `RWS_FUNCTIONAL_ALLOW_MANUAL`), and cancels it
  afterwards.
- On RobotWare 7 and 8 virtual controllers it uses the simulation endpoints
  that stand in for a person's hands: the enable switch, the emergency,
  general and auto stop, and a teleport of the robot to given joints (file
  `14-vc-sim-panel`, and the manual-mode tests in `09-motion`). They are
  sent only when the controller identifies itself as a virtual controller, and
  each test releases what it engaged. The manual-mode jog holds the simulated
  enable switch and reads the joints back from the controller after each jog.
- On RobotWare 8 the motion and RAPID-run tests on that lane skip unless the
  motors are already on, and Remote Access must be enabled at the pendant. RobotWare 8 also
  refuses a RAPID start from this client until motion control is allowed for
  its station, so those tests run there only under
  `RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<system name>`, on the virtual
  controller with that system name, and skip without it.

The I/O write tests skip on the RW6 and RW7 virtual controllers, which ship no
general-purpose input or output. A separate command, which unlike the suite
loads configuration and warm-restarts the controller, adds one of each
(`ZZ_PROBE_DI1`, `ZZ_PROBE_DO1`): `RWS_FIXTURES_APPLY=1
RWS_FIXTURES_LANES=rw7,rw6 npm run functional:fixtures` (`-- --remove` takes
them out; rw8 is refused).

Running it:

```bash
npm run functional                      # every functional file, every lane found
npm run functional -- 00-smoke          # files whose name contains "00-smoke"
npm run functional -- 07 09 -t "speed"  # several filters; options go to vitest
npm run vc-ready -- --lanes rw7,rw8     # which lanes have a virtual controller ready (exit 0 when all asked for are)
```

Before vitest starts, `npm run functional` runs `scripts/vc-ready.mjs`: one
read each of `/rw/system`, the operating mode and the controller state per
virtual controller on this PC, then a logout. A lane whose controller is down
is left out and named instead of failing every test of that lane; with no lane
ready nothing runs (`--no-vc-ready` skips the check). `npm run vc-ready` prints
the same table on its own (`--json` for scripts, `--lanes` to pick); it sends
only those reads.

Environment switches:

| Variable | Effect |
|--|--|
| `RWS_FUNCTIONAL_ONLY=rw7,rw8` | Run these lanes only |
| `RWS_FUNCTIONAL_ALLOW_RESTART=rw7` | Lanes the restart test may restart (never `rw6` or `rw8`) |
| `RWS_FUNCTIONAL_ALLOW_MANUAL=rw6,rw7,rw8` | Lanes the manual-mode tests (a jog, and on `rw8` a program move) may switch to manual reduced speed. Set it only with someone at the virtual FlexPendant: on RobotWare 7 and 8 the switch back to Auto waits there for a confirmation, which the test asks for on the console and waits for (up to 2 minutes), and on `rw7` the jog needs the RMMP request granted there within 30 s. On `rw8` the tests run only when the user holds the RobotWare 8.2 grant "Allow remote access in manual mode" and the motors are not on; they set the station's allow-motion-control declaration for the test and put it back before the switch back to Auto |
| `RWS_FUNCTIONAL_ALLOW_MOTION_CONTROL=<system name>` | Lets the RAPID-run tests on `rw8` (RAPID execution, the Auto program moves, the RAPID start and stop events, the stop without a hold) allow motion control for the suite's station, which a RAPID start from a remote station needs on RobotWare 8, on one controller: the one whose system name (as `/rw/system` reads it) the value names, and only when it identifies as a virtual controller. ABB treats allowing it as the station's confirmation that an emergency stop and a normal stop are within reach, so set it only when someone at that controller's virtual FlexPendant has checked that. A value that names no controller, such as a left-over `1` or `rw8`, allows nothing. It is allowed in the suite's own session and withdrawn when the lane ends, and the client withdraws it as the first request of every disconnect; without the variable those tests skip and say why |
| `RWS_FUNCTIONAL_SKIP_SLOW=1` | Skip the session idle-expiry test (it idles about 330 s per lane) |
| `RWS_TEST_PORT_RW6` / `_RW7` / `_RW8` | A port to try first for that lane |
| `RWS_TEST_USER` / `RWS_TEST_PASS` | The account to log in with (default `Default User`) |
| `RWS_FUNCTIONAL_STATION_ID` / `RWS_FUNCTIONAL_HOLDER_STATION_ID` | Fixed RobotWare 8 control-station ids for the suite's stations |
| `RWS_FUNCTIONAL_RUN_ID` | Name (or reuse) the run directory; default is a timestamp |

Files run one at a time. Each run writes to `test-results/functional/<run>/`:
one wire trace per lane (`<lane>.jsonl`, with credentials, cookies and PINs
masked, each line labelled with the session that sent it), `fleet.json`,
`skips.jsonl`, `hook-failures.jsonl` when a restore fails, and the vitest
report `results.json`. One lane takes roughly 13 minutes, most of it in
deliberate waits.

---

## Resources

**What this client is proven to do**

- [COVERAGE.md](./docs/COVERAGE.md) - the guarantees and how each one is tested.
- [STRUCTURAL.md](./STRUCTURAL.md) - what happens when the network, the controller
  or the clock misbehaves: a fault-injection matrix run against live controllers,
  where every cell is `verified`, `manual-only` or `excluded` and never assumed.
  Regenerate with `npm run structural`.
- [CONFORMANCE.md](./CONFORMANCE.md) - does the client cover what the controllers
  actually advertise? Diffs the path tables in `src/paths` against a live crawl of
  each controller's resource tree, flagging any advertised resource nothing maps.
  Regenerate with `npm run conformance`.
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) - how the pieces fit together.

**Where the URLs live**

Every RWS URL the client uses is declared once in [`src/paths`](./src/paths),
one table per RWS domain, keyed by operation and split by protocol generation.
That is the single source of truth an ABB update lands in - and what
`npm run conformance` checks against the live controllers.

**External**

- [ABB Developer Center - RWS API](https://developercenter.robotstudio.com/api/rwsApi/)
- [RAPID Live - the companion VS Code extension](https://marketplace.visualstudio.com/items?itemName=merajsafari.abb-rws)

---

## Licence

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). If you redistribute
this work, keep the NOTICE file.

Releases up to and including 1.3.1 were published under the MIT License and
remain available under those terms.

Contributions are accepted under the DCO - see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Disclaimer

Independent open-source project by [Meraj Safari](https://github.com/ichbinmeraj).
ABB is a trademark of ABB Asea Brown Boveri Ltd. IRC5, OmniCore, RobotWare, RobotStudio
and FlexPendant are trademarks of their respective owners. **This project is not
affiliated with, endorsed by, sponsored by or supported by ABB, ABB Robotics or any later
owner of these products.** Project names and trademark position: see
[TRADEMARKS.md](./TRADEMARKS.md).
