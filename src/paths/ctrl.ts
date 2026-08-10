/**
 * Controller domain path table (`/ctrl`).
 *
 * Hand-built from the ctrl inventory (the authoring agent's file write dropped
 * on an auth blip; its data was intact). Operations whose "path" actually lives
 * under another root are OMITTED and belong to that domain's table:
 *   - getEnergyStats / resetEnergy      -> /rw/system/energy  (systemMastership)
 *   - listControllerOptions             -> /rw/system/options (systemMastership)
 *   - getTpuSafetyProtocolStatus        -> /rw/controlstation/tpu/... (systemMastership)
 *   - listBackups                       -> /fileservice/BACKUP (filesVision)
 * Composite operations that issue no single URL (getSafetyStatus, getVirtualTime)
 * are omitted - the table holds atomic request paths, not orchestration.
 *
 * Every path is live-verified; the ABB PDF has errors, so the controller wins.
 */

import type { DomainTable } from './PathSpec.js';

export const CTRL: DomainTable = {
  // ── Identity / clock ──────────────────────────────────────────────────────
  getControllerIdentity: {
    summary: 'Read controller name, id, type, MAC.',
    rws2: { method: 'GET', path: '/ctrl/identity' },
    rws1: { method: 'GET', path: '/ctrl/identity' },
  },
  getControllerClock: {
    summary: 'Read the controller date/time (UTC).',
    rws2: { method: 'GET', path: '/ctrl/clock' },
    rws1: { method: 'GET', path: '/ctrl/clock' },
  },
  setControllerClock: {
    summary: 'Set the controller date/time (UTC).',
    rws2: { method: 'PUT', path: '/ctrl/clock', fields: ['sys-clock-year', 'sys-clock-month', 'sys-clock-day', 'sys-clock-hour', 'sys-clock-min', 'sys-clock-sec'] },
    rws1: { method: 'PUT', path: '/ctrl/clock', fields: ['sys-clock-year', 'sys-clock-month', 'sys-clock-day', 'sys-clock-hour', 'sys-clock-min', 'sys-clock-sec'] },
    note: 'one of very few PUTs in either generation.',
  },
  getTimezone: {
    summary: 'Read the controller timezone.',
    rws1: { method: 'GET', path: '/ctrl/clock/timezone' },
    note: 'RWS 1.0 only.',
  },

  // ── Restart / restart count ───────────────────────────────────────────────
  restartController: {
    summary: 'Restart the controller (canonical /ctrl form on 2.0).',
    // The biggest cross-generation split in this domain: 2.0 /ctrl/restart
    // (needs edit mastership), 1.0 /rw/panel?action=restart. Same body field.
    // Mirrors panel.restartController - kept in both tables intentionally, as
    // the operation legitimately belongs to both trees by generation.
    rws2: { method: 'POST', path: '/ctrl/restart', fields: ['restart-mode'] },
    rws1: { method: 'POST', path: '/rw/panel', action: 'restart', fields: ['restart-mode'] },
    note: '2.0 /ctrl/restart (6 modes, edit mastership) vs 1.0 /rw/panel?action=restart (4 modes).',
  },
  getRestartCount: {
    summary: 'Read how many times the controller has restarted.',
    rws2: { method: 'GET', path: '/ctrl/restart/restartcount' },
    note: 'RWS 2.0 only.',
  },

  // ── Network (RWS 1.0 only) ────────────────────────────────────────────────
  getNetworkConfig: {
    summary: 'Read network configuration.',
    rws1: { method: 'GET', path: '/ctrl/network' },
    note: 'RWS 1.0 only; same URL backs listNetworkInterfaces.',
  },
  getDnsConfig: {
    summary: 'Read DNS configuration.',
    rws1: { method: 'GET', path: '/ctrl/network/dns' },
    note: 'RWS 1.0 only.',
  },
  getRoutingTable: {
    summary: 'Read the routing table.',
    rws1: { method: 'GET', path: '/ctrl/network/routes' },
    note: 'RWS 1.0 only.',
  },

  // ── Diagnostics / language / system info ──────────────────────────────────
  getDiagnostics: {
    summary: 'Read saved controller diagnostics.',
    rws2: { method: 'GET', path: '/ctrl/diagnostics' },
    note: 'RWS 2.0 only. Empty controller answers 400 "No Diagnostics Saved" - an empty state, not an error.',
  },
  saveDiagnostics: {
    summary: 'Ask the controller to save a diagnostics bundle.',
    rws2: { method: 'POST', path: '/ctrl/diagnostics/save', fields: ['data'] },
    note: 'RWS 2.0 only; built-not-run. Every VC request answers 400; kept for physical controllers.',
  },
  setControllerLanguage: {
    summary: 'Set the controller language.',
    // Field is `lang`, NOT the panel's `lang-code` - easy to confuse.
    rws2: { method: 'POST', path: '/ctrl/lang', fields: ['lang'] },
    note: 'RWS 2.0 only. Write-only (GET 405). Field lang, not the panel lang-code.',
  },
  saveSystemInfo: {
    summary: 'Write a system-information report to a controller file.',
    rws2: { method: 'POST', path: '/ctrl/system/info', fields: ['path', 'file-type'] },
    note: 'RWS 2.0 only. NOT a getter (GET 405). 403 on VCs "not supported on platform".',
  },

  // ── Compatibility ─────────────────────────────────────────────────────────
  getCompatibility: {
    summary: 'Check RobotWare version compatibility.',
    // Genuinely different resources by generation, and both 404 on the VCs.
    rws2: { method: 'GET', path: '/ctrl/compatibility/{version}', gap: '404 on VC "not supported on virtual controller"; no code on 2.0' },
    rws1: { method: 'GET', path: '/ctrl/compatible' },
    note: '1.0 /ctrl/compatible vs 2.0 /ctrl/compatibility/{version}; both 404 on live VCs.',
  },

  // ── Excluded /ctrl endpoints (recorded, not implemented) ──────────────────
  getSyslog: {
    summary: 'Read the controller system log.',
    rws2: { method: 'GET', path: '/ctrl/syslog', gap: 'OPTIONS advertises GET but GET answers 406 in all six representations; 404 on RWS 1.0' },
    note: 'excluded - recorded refusal.',
  },
  getEnv: {
    summary: 'Read controller environment variables.',
    rws2: { method: 'GET', path: '/ctrl/env', gap: '404 "not supported on virtual controller"' },
    note: 'excluded.',
  },
  getSystems: {
    summary: 'List installed systems.',
    rws2: { method: 'GET', path: '/ctrl/systems', gap: '404 "not supported on virtual controller"' },
    note: 'excluded.',
  },
  tpuScreendump: {
    summary: 'Capture a FlexPendant screenshot.',
    rws2: { method: 'POST', path: '/ctrl/tpu/screendump', gap: '404 "not supported on virtual controller" on all controllers' },
    note: 'excluded.',
  },
  tpuDetach: {
    summary: 'Detach the FlexPendant for hot-swap.',
    rws2: { method: 'POST', path: '/ctrl/tpu/detach', gap: '404 on all controllers' },
    note: 'excluded.',
  },
  systemUpdate: {
    summary: 'Software update (barred by the destructive ceiling).',
    rws2: { method: 'POST', path: '/ctrl/system/update', fields: ['path'], gap: 'beyond the destructive ceiling - never executed; form recorded only' },
    note: 'barred - form recorded for the record.',
  },

  // ── Safety ────────────────────────────────────────────────────────────────
  getSafetyMode: {
    summary: 'Read the safety mode.',
    rws2: { method: 'GET', path: '/ctrl/safety/mode' },
    note: 'RWS 2.0 only.',
  },
  getSafetyViolationInfo: {
    summary: 'Read safety violation info.',
    rws2: { method: 'GET', path: '/ctrl/safety/violation' },
    note: 'RWS 2.0 only.',
  },
  getSafetyLoadStatus: {
    summary: 'Read the safety load status.',
    rws2: { method: 'GET', path: '/ctrl/safety/load' },
    note: 'RWS 2.0 only.',
  },
  getSafetyStartupStatus: {
    summary: 'Read the safety startup status.',
    rws2: { method: 'GET', path: '/ctrl/safety/config/startupstatus' },
    note: 'RWS 2.0 only; controller misspells the response class (…-load-satus), code reads both.',
  },
  getSafetyStatus: {
    summary: 'Read the aggregate controller safety status.',
    rws1: { method: 'GET', path: '/ctrl/safety' },
    note: '1.0 reads /ctrl/safety directly; 2.0 has no single URL - it composes getSafetyMode + getSafetyViolationInfo + getSafetyLoadStatus, so no rws2 entry here.',
  },
  listSafetyZones: {
    summary: 'List safety zones.',
    rws2: { method: 'GET', path: '/ctrl/safety/zones', gap: '404 on RW7/8 - resource absent, kept for source compat' },
    rws1: { method: 'GET', path: '/ctrl/safety/zones' },
    note: 'dead on 2.0 (404 -> []).',
  },
  runCyclicBrakeCheck: {
    summary: 'Run a cyclic brake check.',
    rws2: { method: 'POST', path: '/ctrl/safety/cyclic-brake-check', gap: '404 on VC "not supported on virtual controller"; retained for hardware' },
    rws1: { method: 'POST', path: '/ctrl/safety/cyclic-brake-check' },
    note: 'POST-only; 404 on VC.',
  },
  getCyclicBrakeCheckStatus: {
    summary: 'Read cyclic-brake-check status.',
    // drivenum query param is REQUIRED; documented in note (queries not in path).
    rws2: { method: 'GET', path: '/ctrl/safety/cbc' },
    note: 'RWS 2.0 only. GET-only (405 on POST). REQUIRES ?drivenum={n} query param.',
  },

  // ── Backup ────────────────────────────────────────────────────────────────
  createBackup: {
    summary: 'Create a backup (async, 202).',
    // Both require a /fileservice/... URI value; bare names 400 on both.
    rws2: { method: 'POST', path: '/ctrl/backup/create', fields: ['backup'] },
    rws1: { method: 'POST', path: '/ctrl/backup', action: 'backup', fields: ['backup'] },
    note: '2.0 subresource vs 1.0 ?action=backup; value must be a /fileservice/ URI.',
  },
  restoreBackup: {
    summary: 'Restore a backup.',
    rws2: { method: 'POST', path: '/ctrl/backup/restore', fields: ['backup'] },
    rws1: { method: 'POST', path: '/ctrl/backup', action: 'restore', fields: ['backup'] },
    note: 'same subresource-vs-query-action split as create.',
  },
  checkRestore: {
    summary: 'Validate a backup before restoring.',
    rws2: { method: 'POST', path: '/ctrl/backup/check-restore', fields: ['backup'] },
    note: 'RWS 2.0 only.',
  },
  getBackupStatus: {
    summary: 'Read backup progress (progress-state / phase).',
    rws2: { method: 'GET', path: '/ctrl/backup' },
    rws1: { method: 'GET', path: '/ctrl/backup' },
  },
  getBackupState: {
    summary: 'Read the backup state.',
    rws2: { method: 'GET', path: '/ctrl/backup/state' },
    note: 'RWS 2.0 only; overlaps semantically with getBackupStatus.',
  },

  // ── Virtual time ──────────────────────────────────────────────────────────
  setVirtualTimeRunning: {
    summary: 'Start/stop virtual time (VC).',
    // The cleanest illustration of the generational split: value-in-body (2.0)
    // vs verb-in-query-action (1.0). 1.0 uses ?action=run|pause per value.
    rws2: { method: 'POST', path: '/ctrl/virtualtime/vtstate', fields: ['vtcurrstate'] },
    rws1: { method: 'POST', path: '/ctrl/virtualtime/vtstate', action: 'run', fields: [] },
    note: '2.0 body vtcurrstate=running|stopped; 1.0 ?action=run|pause, empty body.',
  },
  setVirtualTimeScale: {
    summary: 'Set the virtual-time speed.',
    rws2: { method: 'POST', path: '/ctrl/virtualtime/vtspeed', fields: ['vtcurrspeed'] },
    rws1: { method: 'POST', path: '/ctrl/virtualtime/vtspeed', action: 'set', fields: ['vtcurrspeed'] },
    note: 'same body field; 1.0 adds ?action=set.',
  },
  getVirtualTimeClock: {
    summary: 'Read the current virtual time.',
    // Atomic sub-resource of the getVirtualTime composite (vttime + vtstate +
    // vtspeed). Added 2026-08-10 after the conformance check flagged
    // /ctrl/virtualtime/vttime as unmapped - the composite was skipped, but its
    // atomic reads deserve table entries.
    rws2: { method: 'GET', path: '/ctrl/virtualtime/vttime' },
    rws1: { method: 'GET', path: '/ctrl/virtualtime/vttime' },
    note: 'atomic read; getVirtualTime composes this with vtstate + vtspeed.',
  },
  getVirtualTimeState: {
    summary: 'Read the virtual-time running state.',
    rws2: { method: 'GET', path: '/ctrl/virtualtime/vtstate' },
    rws1: { method: 'GET', path: '/ctrl/virtualtime/vtstate' },
  },
  getVirtualTimeScale: {
    summary: 'Read the virtual-time speed.',
    rws2: { method: 'GET', path: '/ctrl/virtualtime/vtspeed' },
    rws1: { method: 'GET', path: '/ctrl/virtualtime/vtspeed' },
  },
  getVirtualTimeTimeslice: {
    summary: 'Read the virtual-time timeslice.',
    rws2: { method: 'GET', path: '/ctrl/virtualtime/vttimeslice' },
    // The IRC5 also advertises this (conformance check, 2026-08-10), but the
    // client only wraps it on RWS 2.0 - recorded as a gap so the divergence is
    // documented rather than showing as unmapped drift.
    rws1: { method: 'GET', path: '/ctrl/virtualtime/vttimeslice' },
    note: 'wrapped on RWS 2.0; RW6 advertises it too but the client does not use it there.',
  },
  setVirtualTimeTimeslice: {
    summary: 'Set the virtual-time timeslice.',
    rws2: { method: 'POST', path: '/ctrl/virtualtime/vttimeslice', fields: ['vttimeslice'] },
    note: 'RWS 2.0 only.',
  },

  // ── Certificates (RWS 2.0 only) ───────────────────────────────────────────
  listCertificateStores: {
    summary: 'List certificate stores.',
    rws2: { method: 'GET', path: '/ctrl/certstore' },
    note: 'RWS 2.0 only; same URL as listCertificates, different parse.',
  },
  getCertificates: {
    summary: 'Read certificates in a store.',
    // {storePath} is multi-segment (e.g. system/rws_store) and slashes are kept.
    rws2: { method: 'GET', path: '/ctrl/certstore/{storePath}' },
    note: 'RWS 2.0 only; {storePath} keeps its slashes (not encoded).',
  },
  uploadCertificate: {
    summary: 'Upload a certificate (raw PEM body).',
    rws2: { method: 'POST', path: '/ctrl/certstore/{name}' },
    note: 'RWS 2.0 only; raw application/x-pem-file body, not a form. Encoding trap: {name} IS encodeURIComponent-encoded here, unlike getCertificates which keeps slashes in {storePath}.',
  },
  removeCertificate: {
    summary: 'Delete a certificate.',
    rws2: { method: 'DELETE', path: '/ctrl/certstore/{name}' },
    note: 'RWS 2.0 only; one of the few DELETEs.',
  },

  // ── Registry / compress ───────────────────────────────────────────────────
  getRegistry: {
    summary: 'Read the controller registry index.',
    rws2: { method: 'GET', path: '/ctrl/registry' },
    note: 'RWS 2.0 only.',
  },
  getRegistryFile: {
    summary: 'Read a registry file.',
    rws2: { method: 'GET', path: '/ctrl/registry/{name}' },
    note: 'RWS 2.0 only.',
  },
  compressPath: {
    summary: 'Compress a controller path.',
    // Spec field names (source/destination) are WRONG - controller wants srcpath/dstpath.
    rws2: { method: 'POST', path: '/ctrl/compress', fields: ['srcpath', 'dstpath'] },
    // IRC5 advertises /ctrl/compress (OPTIONS Allow: GET,POST,OPTIONS) but its
    // RW6 request form is undiscoverable by probing (live 2026-08-11): the OPTIONS
    // form body is EMPTY in every representation, and the RW7 srcpath/dstpath form
    // - plus HOME/$HOME//fileservice path variants and a `path` field - all answer
    // 400 INVALID Request (-1073414146). Left a gap rather than ship a method that
    // 400s; closing it needs ABB RW6 form docs, not guesswork.
    rws1: { method: 'POST', path: '/ctrl/compress', gap: 'advertised on RW6 but its request form is not the RW7 srcpath/dstpath form and is not advertised (empty OPTIONS); all probed forms 400. Needs RW6 form docs.' },
    note: 'wrapped on RWS 2.0 (fields srcpath/dstpath); RW6 advertises the endpoint but with a different, undocumented form.',
  },
  decompressPath: {
    summary: 'Decompress a controller path.',
    rws2: { method: 'POST', path: '/ctrl/decompress', fields: ['srcpath', 'dstpath'] },
    note: 'RWS 2.0 only; sibling of /ctrl/compress, not a subresource.',
  },

  // ── Options (the controller advertises /ctrl/options, but…) ───────────────
  ctrlOptionsVerify: {
    summary: 'Controller options verify-endpoint (NOT used - see listControllerOptions).',
    // The controller advertises /ctrl/options, but it is an empty verify-style
    // endpoint (200 no-content on RW7/8, 204 on RW6). The real option list the
    // client reads is /rw/system/options (systemMastership.listControllerOptions).
    // Recorded here so the conformance check sees /ctrl/options as a deliberate
    // gap rather than unmapped drift. Flagged by the check 2026-08-10.
    rws2: { method: 'GET', path: '/ctrl/options', gap: 'empty verify-endpoint; the real list is /rw/system/options' },
    rws1: { method: 'GET', path: '/ctrl/options', gap: 'empty verify-endpoint; the real list is /rw/system/options' },
    note: 'deliberately not used on either generation; client reads /rw/system/options instead.',
  },

  // ── Features ──────────────────────────────────────────────────────────────
  listFeatures: {
    summary: 'List controller features.',
    rws2: { method: 'GET', path: '/ctrl/features' },
    note: 'RWS 2.0 only; verify-style, bare listing is always empty.',
  },
};
