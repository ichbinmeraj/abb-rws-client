/**
 * I/O system domain path table (`/rw/iosystem`) - signals, networks, devices.
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 *
 * The generation split is stark: RWS 1.0 covers only list/read/write signals,
 * list networks, and list devices (x2). Every signal-search, config-read,
 * lstate-write and unblock operation is RWS 2.0 only. Encoding is inconsistent
 * inside RWS 2.0: signal-scoped paths interpolate segments RAW, while
 * network/device-scoped paths encode them; RWS 1.0 encodes all three. The
 * subscribeSignal resource is a subscription (`;state`), not an HTTP path, so it
 * lives with the subscription layer and is not in this table.
 */

import type { DomainTable } from './PathSpec.js';

export const IO: DomainTable = {
  // ── Signals ───────────────────────────────────────────────────────────────
  listAllSignals: {
    summary: 'List all I/O signals (paginated).',
    // Paging (start/limit) is a read-side query, not part of the resource path.
    rws2: { method: 'GET', path: '/rw/iosystem/signals' },
    rws1: { method: 'GET', path: '/rw/iosystem/signals' },
    note: 'read-side query ?start=&limit=. RWS 2.0 caps a page at 100 and IGNORES a larger limit — client walks `next`; RW6.16 returns the whole list with no `next` link.',
  },
  readSignal: {
    summary: 'Read one signal by network/device/name.',
    rws2: { method: 'GET', path: '/rw/iosystem/signals/{network}/{device}/{name}' },
    rws1: { method: 'GET', path: '/rw/iosystem/signals/{network}/{device}/{name}' },
    note: 'RWS 1.0 also has a flat form /signals/{name} (empty network+device) and encodes every segment; RWS 2.0 does neither — readSignal("","",name) degenerates to /signals///{name} with no guard.',
  },
  writeSignal: {
    summary: 'Set a signal value.',
    // 2.0 path-action /set-value vs 1.0 ?action=set; body field lvalue on both.
    rws2: { method: 'POST', path: '/rw/iosystem/signals/{network}/{device}/{name}/set-value', fields: ['lvalue'] },
    rws1: { method: 'POST', path: '/rw/iosystem/signals/{network}/{device}/{name}', action: 'set', fields: ['lvalue'] },
    note: '2.0 sub-path /set-value vs 1.0 ?action=set. RWS 1.0 splits path (mapper) from lvalue body (client); RWS 2.0 mapper returns both and leaves segments unencoded. RWS 1.0 flat form also applies.',
  },
  searchSignals: {
    summary: 'Search signals by criteria (substring name, AND-composed).',
    rws2: { method: 'POST', path: '/rw/iosystem/signals/signal-search', fields: ['name', 'device', 'network', 'category', 'type'] },
    // RWS 1.0 uses the query-action form; same ios-signal-li result and semantics
    // (substring name, AND-composed). Live-verified on IRC5 RW6.16 (2026-08-11).
    rws1: { method: 'POST', path: '/rw/iosystem/signals', action: 'signal-search', fields: ['name', 'device', 'network', 'category', 'type'] },
    note: 'name is SUBSTRING match; criteria AND-compose; `*` matches nothing (live-verified RW7.21 / RW6.16).',
  },
  searchSignalsEx: {
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
    note: 'RWS 2.0 only. Second criteria set NARROWS (AND, not union); max 2 sets; no glob; empty body returns everything (live-verified RW8.1.1). Bespoke content-type application/x-www-form-urlencoded;v=2.0.',
  },
  getSignalConfig: {
    summary: 'Read the config record for one signal.',
    rws2: { method: 'GET', path: '/rw/iosystem/signals/{network}/{device}/{name}/config' },
    note: 'RWS 2.0 only. Segments interpolated RAW (unencoded).',
  },
  setSignalSimulated: {
    summary: 'Simulate / unsimulate one signal.',
    rws2: { method: 'POST', path: '/rw/iosystem/signals/{network}/{device}/{name}/set-lstate', fields: ['lstate'] },
    note: 'RWS 2.0 only. lstate = simulated | not simulated. Segments unencoded, unlike the network/device lstate siblings.',
  },
  unblockSignals: {
    summary: 'Unblock all blocked signals (collection-level action).',
    rws2: { method: 'POST', path: '/rw/iosystem/signals/unblock-signal' },
    note: 'RWS 2.0 only. No body. Singular unblock-signal under plural signals.',
  },

  // ── Networks ──────────────────────────────────────────────────────────────
  listNetworks: {
    summary: 'List all I/O networks.',
    rws2: { method: 'GET', path: '/rw/iosystem/networks' },
    rws1: { method: 'GET', path: '/rw/iosystem/networks' },
    note: 'Identical path on both generations.',
  },
  getIoNetwork: {
    summary: 'Read one I/O network.',
    rws2: { method: 'GET', path: '/rw/iosystem/networks/{network}' },
    note: 'RWS 2.0 only. Segment encoded.',
  },
  getIoNetworkConfig: {
    summary: 'Read the config record for one I/O network.',
    rws2: { method: 'GET', path: '/rw/iosystem/networks/{network}/config' },
    note: 'RWS 2.0 only. Segment encoded.',
  },
  setNetworkLState: {
    summary: 'Start / stop an I/O network.',
    rws2: { method: 'POST', path: '/rw/iosystem/networks/{network}/set-lstate', fields: ['lstate'] },
    note: 'RWS 2.0 only. lstate = start | stop. Segment encoded.',
  },

  // ── Devices ───────────────────────────────────────────────────────────────
  listDevices: {
    summary: 'List the devices on one network.',
    // ?network={network} is a read-side query, not part of the resource path.
    rws2: { method: 'GET', path: '/rw/iosystem/devices' },
    rws1: { method: 'GET', path: '/rw/iosystem/devices' },
    note: 'read-side query ?network={network}, identical both generations; not part of the resource path.',
  },
  listAllIoDevices: {
    summary: 'List all I/O devices across every network.',
    rws2: { method: 'GET', path: '/rw/iosystem/devices' },
    rws1: { method: 'GET', path: '/rw/iosystem/devices' },
    note: 'Same path as listDevices minus the network query. RWS 1.0 side lives in RWS1Adapter (via rws1Get, which appends ?json=1), not RwsClient/ResourceMapper.',
  },
  getIoDeviceInfo: {
    summary: 'Read one I/O device.',
    rws2: { method: 'GET', path: '/rw/iosystem/devices/{network}/{device}' },
    note: 'RWS 2.0 only. Segments encoded.',
  },
  getIoDeviceConfig: {
    summary: 'Read the config record for one I/O device.',
    rws2: { method: 'GET', path: '/rw/iosystem/devices/{network}/{device}/config' },
    note: 'RWS 2.0 only. Segments encoded.',
  },
  setIoDeviceLState: {
    summary: 'Enable / disable an I/O device.',
    rws2: { method: 'POST', path: '/rw/iosystem/devices/{network}/{device}/set-lstate', fields: ['lstate'] },
    note: 'RWS 2.0 only. lstate = enable | disable. Segments encoded.',
  },
};
