/**
 * System / mastership / control-station path table - `/rw/system`,
 * `/rw/mastership`, `/rw/controlstation`.
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 *
 * The write-access story spans two shapes: RWS 1.0 / RW7 use `/rw/mastership`
 * (query-action POSTs, per-domain grants); RW8 removes that tree entirely (HTTP
 * 410 GONE) and moves to the global `/rw/controlstation` write-access model. The
 * client version-gates off `rwversion` from `GET /rw/system`, so both shapes are
 * kept here, one operation to two paths.
 */

import type { DomainTable } from './PathSpec.js';

export const SYSTEM_MASTERSHIP: DomainTable = {
  // ── System info & inventory (/rw/system) ──────────────────────────────────
  getSystemInfo: {
    summary: 'Read system info (RobotWare version, system name, options).',
    rws2: { method: 'GET', path: '/rw/system' },
    rws1: { method: 'GET', path: '/rw/system' },
    // `/rw/system` is ALSO the pre-auth version probe: connect/detect/RobotManager
    // read `rwversion` here to pick the mastership vs control-station model, so the
    // literal appears 4x - this entry is their shared home.
    note: 'Also the pre-auth version probe (reads rwversion). RWS2 options drift: class sys-option (XHTML) vs sys-options (HAL JSON).',
  },
  getLicenseInfo: {
    summary: 'Read the controller license.',
    rws2: { method: 'GET', path: '/rw/system/license' },
    rws1: { method: 'GET', path: '/rw/system/license' },
    note: 'Singular /license live-verified on IRC5; the RWS 1.0 doc 6.8 plural /licenses 404s.',
  },
  listProducts: {
    summary: 'List installed RobotWare products.',
    rws2: { method: 'GET', path: '/rw/system/products' },
    rws1: { method: 'GET', path: '/rw/system/products' },
    note: 'RW6 answers with a top-level state array, not _embedded._state (parse quirk in rws1Get).',
  },
  getRobotType: {
    summary: 'Read the robot type.',
    rws2: { method: 'GET', path: '/rw/system/robottype' },
    rws1: { method: 'GET', path: '/rw/system/robottype' },
    note: 'Span robot-type (hyphen), class sys-robottype; both generations.',
  },
  getEnergyStats: {
    summary: 'Read energy-consumption statistics.',
    rws2: { method: 'GET', path: '/rw/system/energy' },
    rws1: { method: 'GET', path: '/rw/system/energy' },
    note: 'RWS 1.0 side swallows errors to {} since RW6 may lack the resource.',
  },
  resetEnergy: {
    summary: 'Reset the energy-consumption counters.',
    rws2: { method: 'POST', path: '/rw/system/energy/reset' },
    note: 'RWS 2.0 only; no body.',
  },
  listControllerOptions: {
    summary: 'List installed controller options.',
    rws2: { method: 'GET', path: '/rw/system/options' },
    rws1: { method: 'GET', path: '/rw/system/options' },
    note: 'The true installed-options list on both generations (class sys-option-li); the plausible /ctrl/options is verify-only and returns an empty listing.',
  },

  // ── Mastership (/rw/mastership) - RWS 1.0 / RW7; 410 GONE on RW8 ───────────
  requestMastership: {
    summary: 'Acquire mastership for a domain (needed before a write).',
    rws2: { method: 'POST', path: '/rw/mastership/{domain}/request' },
    rws1: { method: 'POST', path: '/rw/mastership/{domain}', action: 'request' },
    note: '1.0 ?action=request (empty body) vs 2.0 /request subpath (no body). Domain rename: 2.0 folds cfg/rapid -> edit (/rapid/request 404s). RW8: 410 GONE, auto-routes to controlstation write access.',
  },
  releaseMastership: {
    summary: 'Release mastership for a domain.',
    rws2: { method: 'POST', path: '/rw/mastership/{domain}/release' },
    rws1: { method: 'POST', path: '/rw/mastership/{domain}', action: 'release' },
    note: 'Same shape difference as request. RW7 /logout releases mastership implicitly; RW8 write access does NOT auto-release.',
  },
  requestMastershipAll: {
    summary: 'Acquire mastership for all domains at once.',
    rws2: { method: 'POST', path: '/rw/mastership/request' },
    rws1: { method: 'POST', path: '/rw/mastership', action: 'request' },
    note: '1.0 bare collection + ?action=request; 2.0 a /request subpath. RWS1Adapter.rws1Post also appends json=1, so the 1.0 wire path is ...?action=request&json=1.',
  },
  releaseMastershipAll: {
    summary: 'Release mastership for all domains.',
    rws2: { method: 'POST', path: '/rw/mastership/release' },
    rws1: { method: 'POST', path: '/rw/mastership', action: 'release' },
    note: 'ditto requestMastershipAll; 1.0 wire path ...?action=release&json=1.',
  },
  requestMastershipWithId: {
    summary: 'Acquire mastership, returning a token that outlives the session.',
    rws2: { method: 'POST', path: '/rw/mastership/{domain}/request-with-id' },
    note: 'RWS 2.0 only; response span mastership-id. Inline in RwsClient2, NOT in ResourceMapper2.',
  },
  releaseMastershipWithId: {
    summary: 'Release a token-held mastership.',
    rws2: { method: 'POST', path: '/rw/mastership/{domain}/release-with-id', fields: ['mastershipid'] },
    note: 'RWS 2.0 only. Body field is mastershipid with NO dash - deliberate, probed live, inconsistent with the domain\'s otherwise-dashed naming.',
  },
  resetMastershipWatchdog: {
    summary: 'Reset the mastership watchdog to keep the grant alive.',
    rws2: { method: 'POST', path: '/rw/mastership/watchdog' },
    note: 'RWS 2.0 only (RW7.8+); no body. No RWS 1.0 concept.',
  },
  getMastershipStatus: {
    summary: 'Read mastership status for a domain (who holds it).',
    rws2: { method: 'GET', path: '/rw/mastership/{domain}' },
    rws1: { method: 'GET', path: '/rw/mastership/{domain}' },
    note: 'Same path, class msh-resource. Domain vocab differs (edit/motion vs cfg/motion/rapid). RWS 1.0 adapter appends json=1.',
  },
  listMastershipDomains: {
    summary: 'List the mastership domains.',
    rws2: { method: 'GET', path: '/rw/mastership' },
    rws1: { method: 'GET', path: '/rw/mastership' },
    note: 'Class msh-resource-li. Returns [edit,motion] on 2.0, [cfg,motion,rapid] on 1.0; 410 GONE on RW8. RWS 1.0 adapter appends json=1.',
  },

  // ── Control station / write access (/rw/controlstation) - RW8 only ────────
  // The entire /rw/controlstation tree is RW8 / RWS 2.0 only (404 on RW7).
  registerControlStationRemote: {
    summary: 'Register a remote control station (RW8 SPoC).',
    rws2: {
      method: 'POST',
      path: '/rw/controlstation/register/remote',
      fields: ['control-station-name', 'control-station-id', 'pincode'],
    },
    note: 'RW8 only. control-station-id must be a braced GUID; registration is session-scoped.',
  },
  registerControlStationLocal: {
    summary: 'Register the local control station (RW8 SPoC).',
    rws2: { method: 'POST', path: '/rw/controlstation/register/local', fields: ['local-presence-key'] },
    note: 'RW8 only. Field local-presence-key from the migration guide, not live-verified (needs local presence).',
  },
  requestWriteAccess: {
    summary: 'Request write access (RW8 successor to mastership).',
    rws2: { method: 'POST', path: '/rw/controlstation/writeaccess/request' },
    note: 'RW8 successor of requestMastership; global (no domain argument). No body.',
  },
  releaseWriteAccess: {
    summary: 'Release write access.',
    rws2: { method: 'POST', path: '/rw/controlstation/writeaccess/release' },
    note: 'RW8: any successful write already clears held-state, so release then answers 403 SPoC -1073435873 and is swallowed as already-released. RW7 releases cleanly. disconnect must release explicitly - /logout does NOT drop it on RW8.',
  },
  appealWriteAccessRelease: {
    summary: 'Appeal a pending write-access release.',
    rws2: { method: 'POST', path: '/rw/controlstation/writeaccess/release/appeal' },
    note: 'RW8 only; no body.',
  },
  getWriteAccessAppealChangeCount: {
    summary: 'Read the write-access appeal change counter.',
    rws2: { method: 'GET', path: '/rw/controlstation/writeaccess/release/appeal/changecount' },
    note: 'RW8 only.',
  },
  getWriteAccessStatus: {
    summary: 'Read who holds write access.',
    rws2: { method: 'GET', path: '/rw/controlstation/writeaccess/status' },
    note: 'RW8 only. Response span held-by-control-station-Id has a capital I (controller-side).',
  },
  getControlStationType: {
    summary: 'Read the control-station type.',
    rws2: { method: 'GET', path: '/rw/controlstation/type' },
    note: 'RW8 only.',
  },
  getControlStationId: {
    summary: 'Read the control-station id.',
    rws2: { method: 'GET', path: '/rw/controlstation/id' },
    note: 'RW8 only. Parse class is control-station (dashed), unlike the controlstation-* classes of sibling resources.',
  },
  isLocalControlStationConnected: {
    summary: 'Read whether the local control station is connected.',
    rws2: { method: 'GET', path: '/rw/controlstation/local/isconnected' },
    note: 'RW8 only.',
  },
  getAllowMotionControl: {
    summary: 'Read whether motion control is allowed.',
    rws2: { method: 'GET', path: '/rw/controlstation/allowmotioncontrol' },
    note: 'RW8 only. Controller misspells the class controstation-allow-motion-control (missing an l, live RW8.1.1); corrected spelling read as fallback.',
  },
  setAllowMotionControl: {
    summary: 'Set whether motion control is allowed.',
    rws2: { method: 'POST', path: '/rw/controlstation/allowmotioncontrol', fields: ['allow-motion-control'] },
    note: 'RW8 only. GET and POST share one path (rare in this service).',
  },
  disableExternalControl: {
    summary: 'Disable external control.',
    rws2: { method: 'POST', path: '/rw/controlstation/disableexternalcontrol' },
    note: 'RW8 only; no body.',
  },
  getTpuSafetyProtocolStatus: {
    summary: 'Read the TPU safety-protocol status.',
    rws2: { method: 'GET', path: '/rw/controlstation/tpu/safety/protocol/status' },
    note: 'RW8 only.',
  },
};
