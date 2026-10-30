/**
 * I/O system domain path table (`/rw/iosystem`) - signals, networks, devices.
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 *
 * The generation split is stark: RWS 1.0 covers list/read/write signals,
 * signal and device search, one network or device, the three config reads
 * (as a ?resource=config query on the resource itself), the network and
 * device lists, and ABB's RWS 1.0 query-action forms for signal simulation,
 * unblock and device state. The network lstate write is RWS 2.0 only in this
 * client. Encoding is inconsistent
 * inside RWS 2.0: signal-scoped paths interpolate segments RAW, while
 * network/device-scoped paths encode them; RWS 1.0 encodes all three. The
 * subscribeSignal resource is a subscription (`;state`), not an HTTP path, so it
 * lives with the subscription layer and is not in this table.
 */

import type { DomainTable } from './PathSpec.js';

export const IO: DomainTable = {
  // ── Signals ───────────────────────────────────────────────────────────────
  listAllSignals: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'List all I/O signals (paginated).',
    // Paging (start/limit) is a read-side query, not part of the resource path.
    rws2: { method: 'GET', path: '/rw/iosystem/signals' },
    rws1: { method: 'GET', path: '/rw/iosystem/signals' },
    note: 'read-side query ?start=&limit=. RWS 2.0 caps a page at 100 and IGNORES a larger limit — client walks `next`. RWS 1.0 is walked the same way since 1.5.0 (up to 1.4.x the first page only). RW 6.16.03 (62 signals) honours `limit`: the functional suite read it in pages of 20 by `start` (2026-10-22); whether those pages carry a `next` link was not recorded, so the RWS 1.0 link walk has not run against a controller.',
  },
  readSignal: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read one signal by network/device/name.',
    rws2: { method: 'GET', path: '/rw/iosystem/signals/{network}/{device}/{name}' },
    rws1: { method: 'GET', path: '/rw/iosystem/signals/{network}/{device}/{name}' },
    note: 'RWS 1.0 uses the bare-name form (readSignalByName) when network and device are empty. RWS 2.0 readSignal("","",name) sends /signals///{name}, which RW 7.21 answers like the bare-name read.',
  },
  readSignalByName: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read one signal by its bare name, without network and device.',
    // Observed 2026-09-27 on RW 6.16, 7.21 and 8.1.1 VCs: 200 for signals bound
    // to a device and for signals with none. On RWS 2.0 the entry's title is
    // network/device/name for a device-bound signal and the bare name for one
    // with no device; the entry's own self link points at the DEVICE
    // (devices/{device}, or devices/ with none), not at the signal.
    rws2: { method: 'GET', path: '/rw/iosystem/signals/{name}' },
    rws1: { method: 'GET', path: '/rw/iosystem/signals/{name}' },
    note: 'Answers 200 on RW 6.16, 7.21 and 8.1.1. RWS 2.0 writeSignal("","",name) reads it to learn the signal\'s network and device, or that it has none.',
  },
  writeSignal: {
    tier: 'core', evidence: 'live', effect: 'write',
    summary: 'Set a signal value.',
    // 2.0 path-action /set-value vs 1.0 ?action=set; body field lvalue on both.
    rws2: { method: 'POST', path: '/rw/iosystem/signals/{network}/{device}/{name}/set-value', fields: ['lvalue'] },
    rws1: { method: 'POST', path: '/rw/iosystem/signals/{network}/{device}/{name}', action: 'set', fields: ['lvalue'] },
    note: '2.0 sub-path /set-value vs 1.0 ?action=set. RWS 1.0 splits path (mapper) from lvalue body (client); RWS 2.0 mapper returns both. With empty network/device, see writeSignalByName.',
  },
  writeSignalByName: {
    tier: 'core', evidence: 'live', effect: 'write',
    summary: 'Set the value of a signal addressed by its bare name.',
    // RWS 1.0: the flat form every writeSignal("","",name) uses; on RW 6.16 it
    // reached the signal (a drive-unit DO answered the signal-level 403
    // -1073445881). RWS 2.0: only for a signal the controller reports with no
    // device - its own resource path is signals/{name} - with ABB's set-value
    // action appended. That RWS 2.0 form has run on RW 8.2.1 (see the note).
    rws2: { method: 'POST', path: '/rw/iosystem/signals/{name}/set-value', fields: ['lvalue'] },
    rws1: { method: 'POST', path: '/rw/iosystem/signals/{name}', action: 'set', fields: ['lvalue'] },
    note: 'RWS 1.0: the flat form for any signal. RWS 2.0: signals with no device only (their title is the bare name); device-bound signals are written at their full path. RWS 2.0 form run live on RW 8.2.1 (2026-10-12): a DO with no device (ZZ_PROBE_DO2, access All) written 1 then 0 and read back.',
  },
  searchSignals: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Search signals by criteria (case-insensitive prefix on name, AND-composed).',
    rws2: { method: 'POST', path: '/rw/iosystem/signals/signal-search', fields: ['name', 'device', 'network', 'category', 'type'] },
    // RWS 1.0 uses the query-action form; same ios-signal-li result and semantics
    // (prefix name, AND-composed). Live-verified on the RobotWare 6.16 virtual controller (2026-08-11).
    // Corrected 2026-09-29: `name` is a case-insensitive PREFIX match, not a
    // substring match, on RW 6.16, 7.21 and 8.1.1 (2026-09-27: RW6 `RAKE` 0 /
    // `DRV1BRAKE` 3 / `drv1brake` 3, RW7 `Mode` 0 / `Auto` 5, RW8 `do8` 0 /
    // `IIO_do` 8). `device`, `network` and `category` match whole values,
    // ignoring case (network: `intbus` and `INTBUS` both 30 on RW 7.21.4 and
    // 8.2.1, live-verified 2026-09-29). No glob or
    // regex: `*`, `?`, `.*` match nothing. An empty body returns every signal.
    // The filter runs on the controller on both generations (RW6 `name=S` 14 of
    // 62). The controller's base form accepts the same 16 fields as the
    // extended one and honours a second set (RW 6.16, 8.1.1); this row lists
    // only the five fields the client sends on this path - a second set goes
    // through searchSignalsEx. RWS 2.0 pages hits at 100 with a `next` link
    // (RW 8.1.1: 100 then 41 for an empty body); the client walks it.
    rws1: { method: 'POST', path: '/rw/iosystem/signals', action: 'signal-search', fields: ['name', 'device', 'network', 'category', 'type'] },
    note: 'name is a case-insensitive PREFIX match (not substring - corrected 2026-09-29); device/network/category match whole values, ignoring case; criteria AND-compose; `*` matches nothing; empty body returns everything (live-verified RW6.16 / RW7.21 / RW8.1.1, 2026-09-27). RWS 2.0 pages hits at 100 with `next`.',
  },
  searchSignalsEx: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Extended signal search - up to two AND-narrowing criteria sets.',
    // The only io write bypassing both mappers: path AND hand-built urlencoded
    // body are inline in RwsClient2, with a bespoke content-type
    // application/x-www-form-urlencoded;v=2.0.
    rws2: {
      method: 'POST',
      path: '/rw/iosystem/signals/signal-search-ex',
      fields: [
        'name', 'device', 'network', 'category', 'category-pon', 'type', 'invert', 'blocked',
        'name2', 'device2', 'network2', 'category2', 'category-pon2', 'type2', 'invert2', 'blocked2',
      ],
    },
    // RWS 1.0 uses the query-action form with the SAME 16-field roster.
    // Live-verified on the RobotWare 6.16 virtual controller (2026-08-11): 200, ios-signal-li result.
    rws1: {
      method: 'POST',
      path: '/rw/iosystem/signals',
      action: 'signal-searchex',
      fields: [
        'name', 'device', 'network', 'category', 'category-pon', 'type', 'invert', 'blocked',
        'name2', 'device2', 'network2', 'category2', 'category-pon2', 'type2', 'invert2', 'blocked2',
      ],
    },
    note: 'Second criteria set NARROWS (AND, not union); max 2 sets (a third is ignored by the controller; the client refuses it); name/name2 are case-insensitive PREFIX matches, device/network/category whole values ignoring case (2026-09-27, network 2026-09-29); invert/invert2 negate their own set, they are not a filter for inverted signals (invert alone matches nothing; 2026-09-29, RW 6.16.03, 7.21.4, 8.2.1); no glob; empty body returns everything. RWS 2.0 path /signal-search-ex (bespoke content-type ;v=2.0), hits paged at 100 with `next` (client walks it); RWS 1.0 query-action ?action=signal-searchex.',
  },
  getSignalConfig: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the config record for one signal.',
    rws2: { method: 'GET', path: '/rw/iosystem/signals/{network}/{device}/{name}/config' },
    // RWS 1.0: the signal resource itself with a read-side ?resource=config
    // query (the client adds it). RW 6.16.03 answered 200 with the classes
    // ios-signal-config-general and ios-signal-config-runtime; the 2.0
    // sub-path /config answered 404 -1073414146 (2026-10-03,
    // scripts/probe-config-task-motion.mjs).
    rws1: { method: 'GET', path: '/rw/iosystem/signals/{network}/{device}/{name}' },
    note: '2.0 sub-path /config (segments RAW); 1.0 the signal with ?resource=config, read as XHTML (the ?json=1 answer packs the general and runtime classes into one object with duplicate keys). Both return the ios-signal-config-general entry.',
  },
  setSignalSimulated: {
    tier: 'niche', evidence: { rws1: 'built', rws2: 'live' }, effect: 'write',
    summary: 'Simulate / unsimulate one signal.',
    rws2: { method: 'POST', path: '/rw/iosystem/signals/{network}/{device}/{name}/set-lstate', fields: ['lstate'] },
    // RWS 1.0 Rev M "Update IO Signal State": the signal with ?action=set and
    // lstate, 204. The same path and action as writeSignal, which sends lvalue.
    rws1: { method: 'POST', path: '/rw/iosystem/signals/{network}/{device}/{name}', action: 'set', fields: ['lstate'] },
    note: 'lstate = simulated | not simulated. RWS 2.0 segments unencoded, unlike the network/device lstate siblings. RWS 1.0 encodes them and shares the path and action of writeSignal; the lstate field tells the two apart. The RWS 1.0 form is built, not yet run.',
  },
  unblockSignals: {
    tier: 'niche', evidence: { rws1: 'built', rws2: 'live' }, effect: 'write',
    summary: 'Unblock all blocked signals (collection-level action).',
    rws2: { method: 'POST', path: '/rw/iosystem/signals/unblock-signal' },
    // RWS 1.0 Rev M "Unblock Signals": ?action=unblock-signal on the signal
    // collection, no body, 204. ABB says it removes simulation from every
    // simulated signal.
    rws1: { method: 'POST', path: '/rw/iosystem/signals', action: 'unblock-signal' },
    note: 'No body. Singular unblock-signal under plural signals: a sub-path on RWS 2.0, a query action on RWS 1.0 (built, not yet run).',
  },

  // ── Networks ──────────────────────────────────────────────────────────────
  listNetworks: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'List all I/O networks.',
    rws2: { method: 'GET', path: '/rw/iosystem/networks' },
    rws1: { method: 'GET', path: '/rw/iosystem/networks' },
    note: 'Identical path on both generations.',
  },
  getIoNetwork: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read one I/O network.',
    rws2: { method: 'GET', path: '/rw/iosystem/networks/{network}' },
    // RWS 1.0 "Get IO Network" (Rev M). RW 6.16.03 links the network list from
    // /rw/iosystem (read 2026-09-29); no per-network body captured yet.
    rws1: { method: 'GET', path: '/rw/iosystem/networks/{network}' },
    note: 'Same path; segment encoded. 1.0 body not captured: read as the ios-network entry.',
  },
  getIoNetworkConfig: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the config record for one I/O network.',
    rws2: { method: 'GET', path: '/rw/iosystem/networks/{network}/config' },
    // RWS 1.0: the network with ?resource=config (added by the client). RW
    // 6.16.03 answered 200 with ios-network-config-general and
    // ios-network-config-runtime; /config answered 404 (2026-10-03,
    // scripts/probe-config-task-motion.mjs).
    rws1: { method: 'GET', path: '/rw/iosystem/networks/{network}' },
    note: '2.0 sub-path /config; 1.0 the network with ?resource=config, read as XHTML. Segment encoded on both. Both return the ios-network-config-general entry.',
  },
  setNetworkLState: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Start / stop an I/O network.',
    rws2: { method: 'POST', path: '/rw/iosystem/networks/{network}/set-lstate', fields: ['lstate'] },
    note: 'RWS 2.0 only. lstate = start | stop. Segment encoded.',
  },

  // ── Devices ───────────────────────────────────────────────────────────────
  listDevices: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'List the devices on one network.',
    // ?network={network} is a read-side query, not part of the resource path.
    rws2: { method: 'GET', path: '/rw/iosystem/devices' },
    rws1: { method: 'GET', path: '/rw/iosystem/devices' },
    note: 'read-side query ?network={network}, identical both generations; not part of the resource path.',
  },
  listAllIoDevices: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'List all I/O devices across every network.',
    rws2: { method: 'GET', path: '/rw/iosystem/devices' },
    rws1: { method: 'GET', path: '/rw/iosystem/devices' },
    note: 'Same path as listDevices minus the network query. RWS 1.0 side lives in RWS1Adapter (via rws1Get, which appends ?json=1), not RwsClient/ResourceMapper.',
  },
  searchIoDevices: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Search I/O devices by name / lstate / network (ios-device-li).',
    // Distinct from searchDevices, which searches the /rw/devices HARDWARE tree.
    // BOTH generations use the same ?action=search query-action (unusual for RWS
    // 2.0, which normally uses path-actions - but the /device-search and /search
    // sub-paths both 405 on RW7.21; ?action=search answers 200). At least one of
    // name OR lstate is required (else 400 "device name (or) device lstate is
    // needed"). Live-verified on the RobotWare 6.16 and 7.21 virtual controllers (2026-08-11).
    rws2: { method: 'POST', path: '/rw/iosystem/devices', action: 'search', fields: ['name', 'lstate', 'network'] },
    rws1: { method: 'POST', path: '/rw/iosystem/devices', action: 'search', fields: ['name', 'lstate', 'network'] },
    note: 'At least one of name|lstate required. Returns ios-device-li rows. Same ?action=search query-action on BOTH generations (RWS 2.0 /device-search and /search sub-paths 405).',
  },
  getIoDeviceInfo: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read one I/O device.',
    rws2: { method: 'GET', path: '/rw/iosystem/devices/{network}/{device}' },
    // RWS 1.0 "Get IO Device" (Rev M) names the device WITHOUT its network;
    // RW 6.16.03 signal bodies link devices/DRV_1 and devices/PANEL that way
    // (read 2026-09-29).
    rws1: { method: 'GET', path: '/rw/iosystem/devices/{device}' },
    note: '2.0 network/device vs 1.0 device only (the network argument is not sent). Segments encoded.',
  },
  getIoDeviceConfig: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the config record for one I/O device.',
    rws2: { method: 'GET', path: '/rw/iosystem/devices/{network}/{device}/config' },
    // RWS 1.0: the device, named without its network as getIoDeviceInfo names
    // it, with ?resource=config (added by the client). RW 6.16.03 answered 200
    // with ios-device-config-general and ios-device-config-runtime; both
    // devices/{device}/config and devices/{network}/{device}/config answered
    // 404 (2026-10-03, scripts/probe-config-task-motion.mjs).
    rws1: { method: 'GET', path: '/rw/iosystem/devices/{device}' },
    note: '2.0 network/device/config vs 1.0 the device (no network) with ?resource=config, read as XHTML. Segments encoded. Both return the ios-device-config-general entry.',
  },
  setIoDeviceLState: {
    tier: 'niche', evidence: { rws1: 'built', rws2: 'live' }, effect: 'write',
    summary: 'Enable / disable an I/O device.',
    rws2: { method: 'POST', path: '/rw/iosystem/devices/{network}/{device}/set-lstate', fields: ['lstate'] },
    // RWS 1.0 Rev M "Update IO Device": /rw/iosystem/devices/{device} with
    // ?action=set and lstate, 204. The device is named without its network,
    // as the page's URL and getIoDeviceInfo name it (GET devices/DRV_1
    // answered 200 on RW 6.16.03). ABB's sample call and form example show
    // devices/Local/DRV_1; a live run settles which the controller takes.
    rws1: { method: 'POST', path: '/rw/iosystem/devices/{device}', action: 'set', fields: ['lstate'] },
    note: 'lstate = enable | disable. Segments encoded. RWS 1.0 names the device without its network (the network argument is not sent); built, not yet run.',
  },
};
