/**
 * Event-log / configuration / DIPC path table (`/rw/elog`, `/rw/cfg`, `/rw/dipc`).
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 *
 * Two transport conventions live below the resource path and stay OUT of it:
 * RWS 1.0 requests get `?json=1` auto-appended by RWS1Adapter's helpers (a couple
 * of deletes hand-append it instead), and read-side query params (`lang`,
 * `order`, the DIPC read's `timeout`) are modifiers, not resources - both are
 * noted, never baked into `path`. The write-verb split is perfectly systematic
 * here: RWS 2.0 uses a path segment (`/clear`, `/clearall`, `/create-default`,
 * `/load`, `/saveas`, or a plain POST) where RWS 1.0 uses `?action=`.
 */

import type { DomainTable } from './PathSpec.js';

export const CFG_ELOG_DIPC: DomainTable = {
  // ── Event log (/rw/elog) ──────────────────────────────────────────────────
  getEventLog: {
    tier: 'core', evidence: 'live',
    summary: 'Read a domain of event-log messages (paginated on 2.0).',
    rws2: { method: 'GET', path: '/rw/elog/{domain}' },
    rws1: { method: 'GET', path: '/rw/elog/{domain}' },
    note: 'Same base path. lang is a read-side query. 2.0 oldest-first (v=2.0) walks rel=next. Newest-first (&order=lifo) needs Accept: application/hal+json;v=2.1 (documented in Rev L; /ctrl and /rw/panel/opmode/lock-state accept v=2.1 too); its next link never advances, so further pages go by &elogseqnum=(lowest seen - 1). RW 6.16 lists newest-first, 50 per page, with a next link that advances (?json=1; start=2 served the older messages, a limit above 50 still served 50). Live-verified 2026-09-29. The RWS 1.0 client (RwsClient.getEventLog) follows that link, up to 20 pages by default (1.4.x read the first page only); the XHTML listing it reads has not been captured with a next link yet. RobotManager keeps the newest page in state.eventLog on RWS 1.0.',
  },
  clearEventLog: {
    tier: 'common', evidence: 'live',
    summary: 'Clear one event-log domain.',
    rws2: { method: 'POST', path: '/rw/elog/{domain}/clear' },
    rws1: { method: 'POST', path: '/rw/elog/{domain}', action: 'clear' },
    note: '2.0 path-segment /clear vs 1.0 ?action=clear; empty body either way.',
  },
  clearAllEventLogs: {
    tier: 'niche', evidence: 'live',
    summary: 'Clear every event-log domain.',
    rws2: { method: 'POST', path: '/rw/elog/clearall' },
    rws1: { method: 'POST', path: '/rw/elog', action: 'clearall' },
    note: '2.0 path-segment /clearall vs 1.0 ?action=clearall.',
  },
  getEventLogMessage: {
    tier: 'core', evidence: 'live',
    summary: 'Read a single event-log message by domain + sequence number.',
    rws2: { method: 'GET', path: '/rw/elog/{domain}/{seqnum}' },
    rws1: { method: 'GET', path: '/rw/elog/{domain}/{seqnum}' },
    note: 'Identical path on both generations (rare); lang is a read-side query. Message args come from argc/arg{N} spans in this payload - there is no /args sub-resource.',
  },
  getEventLogMessageBySeqnum: {
    tier: 'common', evidence: 'live',
    summary: 'Read a message by global sequence number (domain-agnostic lookup).',
    rws2: { method: 'GET', path: '/rw/elog/seqnum/{seqnum}' },
    note: 'RWS 2.0 only. lang is a read-side query.',
  },
  saveEventLogRaw: {
    tier: 'common', evidence: 'live',
    summary: 'Save the raw event log to a file.',
    rws2: { method: 'POST', path: '/rw/elog/saveraw', fields: ['path'] },
    // RWS 1.0 query-action form, same single `path` field (a /fileservice/ URI).
    // Async: 202 ACCEPTED. Live-verified on the RobotWare 6.16 virtual controller (2026-08-11).
    rws1: { method: 'POST', path: '/rw/elog', action: 'saveraw', fields: ['path'] },
    note: 'path MUST be a fileservice URI; bare volume paths are rejected. RWS 2.0 path /rw/elog/saveraw; RWS 1.0 query-action /rw/elog?action=saveraw (202).',
  },
  listEventLogDomains: {
    tier: 'core', evidence: 'live',
    summary: 'List the event-log domains.',
    rws2: { method: 'GET', path: '/rw/elog' },
    rws1: { method: 'GET', path: '/rw/elog' },
    note: 'Same path; RW6 omits numevts/buffsize (come back 0).',
  },
  // subscribeElog: subscription resource (/rw/elog/{domain}), not an HTTP path -
  // handled by the subscription layer; the only subscription resource in either
  // generation without a ;state suffix.

  // ── Configuration (/rw/cfg) ───────────────────────────────────────────────
  listCfgDomains: {
    tier: 'common', evidence: 'live',
    summary: 'List the configuration domains (EIO, MOC, SYS, …).',
    rws2: { method: 'GET', path: '/rw/cfg' },
    rws1: { method: 'GET', path: '/rw/cfg' },
  },
  listCfgTypes: {
    tier: 'common', evidence: 'live',
    summary: 'List the instance types within a configuration domain.',
    rws2: { method: 'GET', path: '/rw/cfg/{domain}' },
    rws1: { method: 'GET', path: '/rw/cfg/{domain}' },
    note: 'Both paginated, different next-link plumbing: 2.0 rel=next hrefs relative to /rw/cfg/; 1.0 _links.next.href with json=1 stripped.',
  },
  listCfgInstances: {
    tier: 'common', evidence: 'live',
    summary: 'List the instances of a configuration type.',
    rws2: { method: 'GET', path: '/rw/cfg/{domain}/{type}/instances' },
    rws1: { method: 'GET', path: '/rw/cfg/{domain}/{type}/instances' },
    note: 'Same path; RWS2 paginates, RWS1 single page.',
  },
  getCfgInstance: {
    tier: 'common', evidence: 'live',
    summary: 'Read one configuration instance by name.',
    // 1.0 deliberately hits the LIST path and filters by _title client-side -
    // it works, but it is a genuinely different URL than 2.0's single-instance
    // resource, not a quirk of encoding.
    rws2: { method: 'GET', path: '/rw/cfg/{domain}/{type}/instances/{instance}' },
    rws1: { method: 'GET', path: '/rw/cfg/{domain}/{type}/instances' },
    note: '1.0 hits the LIST path (then filters by _title), NOT the single-instance path 2.0 uses.',
  },
  setCfgInstance: {
    tier: 'common', evidence: 'live',
    summary: 'Update a configuration instance. Needs cfg/edit mastership.',
    // Verb split AND body-encoding split. 2.0 body is bracket form
    // `Attr=[value,1]&…` with values NOT percent-encoded; 1.0 body is plain
    // `Attr=value&…` percent-encoded. Field names are the instance's attributes,
    // so there is no fixed `fields` list. 1.0 self-acquires 'cfg' mastership;
    // 2.0 relies on RobotManager.withMastership ('edit').
    rws2: { method: 'POST', path: '/rw/cfg/{domain}/{type}/instances/{instance}' },
    rws1: { method: 'POST', path: '/rw/cfg/{domain}/{type}/instances/{instance}', action: 'set' },
    note: '2.0 plain POST + bracket body (unencoded values, form-urlencoded;v=2.0) vs 1.0 ?action=set + plain percent-encoded body.',
  },
  createCfgInstance: {
    tier: 'common', evidence: 'live',
    summary: 'Create a default-valued configuration instance.',
    rws2: { method: 'POST', path: '/rw/cfg/{domain}/{type}/instances/create-default', fields: ['name'] },
    rws1: { method: 'POST', path: '/rw/cfg/{domain}/{type}/instances', action: 'create-default', fields: ['name'] },
    note: '2.0 path-segment /create-default vs 1.0 ?action=create-default. 1.0 percent-encodes name; 2.0 sends name RAW in the body (an & or % in the name breaks the 2.0 create).',
  },
  removeCfgInstance: {
    tier: 'common', evidence: 'live',
    summary: 'Delete a configuration instance.',
    rws2: { method: 'DELETE', path: '/rw/cfg/{domain}/{type}/instances/{instance}' },
    rws1: { method: 'DELETE', path: '/rw/cfg/{domain}/{type}/instances/{instance}' },
    note: 'Same path; 1.0 hand-appends ?json=1 (via client.request, bypassing the helpers). Readback after delete: 404 on 2.0 vs 400 "unknown instance" on RW6.',
  },
  getCfgType: {
    tier: 'common', evidence: 'live',
    summary: 'Read one configuration type: its attribute and instance counts.',
    // ABB: CFG_Service Rev L "Get CFG Type" (cfg-dt-attributes-li with
    // cfg-no-of-attributes, cfg-dt-instances-li with cfg-no-of-instances);
    // RWS 1.0 "Get CFG Type" (Rev M). Every domain listing links the type on
    // RW 6.16.03, 7.21.4 and 8.2.1, and RW 6.16.03 serves its show form with
    // the same two classes (read 2026-09-29).
    rws2: { method: 'GET', path: '/rw/cfg/{domain}/{type}' },
    rws1: { method: 'GET', path: '/rw/cfg/{domain}/{type}' },
    note: 'Same path. The plain GET bodies (1.0 XHTML, 2.0 hal+json) are not captured; the classes are ABB\'s and those of the RW 6.16.03 ?action=show page.',
  },
  listCfgTypeAttributes: {
    tier: 'common', evidence: 'live',
    summary: 'List the attribute definitions of a configuration type.',
    rws2: { method: 'GET', path: '/rw/cfg/{domain}/{type}/attributes' },
    // RW 6.16.03 links it from the type (cfg-dt-attributes-li, read 2026-09-29).
    rws1: { method: 'GET', path: '/rw/cfg/{domain}/{type}/attributes' },
    note: 'Same path. Class cfg-dt-attribute on both: 2.0 on RW 7.21.4 and 8.2.1 (200, 2026-09-29), 1.0 in the ?json=1 body on RW 6.16.03 (2026-10-03). The client reads cfg-dt-attribute or cfg-dt-attribute-li and follows next links.',
  },
  loadCfgFile: {
    tier: 'common', evidence: 'live',
    summary: 'Load a configuration file into the controller.',
    // Field order differs per the OPTIONS form: 2.0 action-type first, 1.0
    // filepath first. Neither side fileservice-normalizes filepath here (read
    // side; the controller resolves bare volume paths), unlike saveCfgFile.
    rws2: { method: 'POST', path: '/rw/cfg/load', fields: ['action-type', 'filepath'] },
    rws1: { method: 'POST', path: '/rw/cfg', action: 'load', fields: ['filepath', 'action-type'] },
    note: 'Dedicated /load resource vs 1.0 ?action=load on the collection; same fields, order differs. filepath NOT fileservice-normalized on either side.',
  },
  saveCfgFile: {
    tier: 'common', evidence: 'live',
    summary: 'Save a configuration domain to a file.',
    rws2: { method: 'POST', path: '/rw/cfg/{domain}/saveas', fields: ['filepath'] },
    rws1: { method: 'POST', path: '/rw/cfg/{domain}', action: 'saveas', fields: ['filepath'] },
    note: '2.0 /saveas segment vs 1.0 ?action=saveas (/save 405s on 2.0). filepath is a fileservice URI (toFileserviceUri) on both; 1.0 duplicates that logic inline.',
  },
  validateCfgInstances: {
    tier: 'niche', evidence: 'built',
    summary: 'Validate existing configuration instances (not a create dry-run).',
    rws2: {
      method: 'POST',
      path: '/rw/cfg/validate-instances',
      fields: ['operation', 'cfgdomain', 'cfgtype', 'instancescount', 'instances'],
    },
    note: 'RWS 2.0 only; form-urlencoded;v=2.0, operation is numeric 0/1, instances repeated. 204 = valid, 200+body = problem. Validates EXISTING instances.',
  },
  validateCfgFile: {
    tier: 'common', evidence: 'live',
    summary: 'Validate a configuration file (a load dry-run) without applying it.',
    // The validation sibling of loadCfgFile - same fields, dry-run only.
    // RWS 1.0 collection query-action (per-domain /rw/cfg/{domain} is rejected).
    // Documented in the ABB RWS 1.0 reference; live-verified on the RobotWare 6.16 virtual controller, and
    // RW 6.16.03 still lists the form (`/rw/cfg?action=show`, read 2026-09-29).
    // RWS 2.0: the dedicated /rw/cfg/validate resource, ABB's CFG service
    // "Validate CFG File" (Rev L), same two fields; it answers 200 with a
    // `cfg-validate` item per domain. Answered live on RW 7.21.4 (2026-09-30,
    // `filepath=$TEMP/<file>`, `action-type=add`: 200, cfg-validate EIO);
    // RW 8.2.1 not sent.
    rws2: { method: 'POST', path: '/rw/cfg/validate', fields: ['filepath', 'action-type'] },
    rws1: { method: 'POST', path: '/rw/cfg', action: 'validate', fields: ['filepath', 'action-type'] },
    note: 'Collection-level (NOT per-domain) on both. Same fields as loadCfgFile but dry-run. 2.0 dedicated /validate resource (CFG service Rev L; 200 with cfg-validate items, RW 7.21.4 2026-09-30), 1.0 ?action=validate. filepath is a bare volume path ($TEMP/x.cfg), not a fileservice URI. Not validateCfgInstances (a different op).',
  },
  validateInstanceBeforeDelete: {
    tier: 'niche', evidence: 'live',
    summary: 'Check whether a configuration instance can be safely deleted (dry-run).',
    // RWS 1.0 collection query-action; body is the instance name. 204 = deletable.
    // Live-verified on the RobotWare 6.16 virtual controller (2026-08-11). Unsupported in bootserver mode.
    rws1: { method: 'POST', path: '/rw/cfg', action: 'validate-inst-at-del', fields: ['name'] },
    note: 'RWS 1.0 only (delete dry-run). 204 = ok to delete; 400/404 otherwise.',
  },

  // ── DIPC queues (/rw/dipc) ────────────────────────────────────────────────
  listDipcQueues: {
    tier: 'common', evidence: 'live',
    summary: 'List the DIPC (inter-process communication) queues.',
    rws2: { method: 'GET', path: '/rw/dipc' },
    rws1: { method: 'GET', path: '/rw/dipc' },
  },
  createDipcQueue: {
    tier: 'common', evidence: 'live',
    summary: 'Create a DIPC queue.',
    // The same three fields on both generations, as the controllers' own
    // create forms list them (RW 6.16.03, 7.21.4 and 8.2.1). RWS 1.0 is the
    // query-action dipc-create: live-verified 2026-09-30 on RW 6.16.03,
    // ?action=dipc-create with these fields answers 201, while the
    // ?action=create this row used to carry answers 400 -1073445879
    // "Invalid action".
    rws2: { method: 'POST', path: '/rw/dipc', fields: ['dipc-queue-name', 'dipc-queue-size', 'dipc-max-msg-size'] },
    rws1: { method: 'POST', path: '/rw/dipc', action: 'dipc-create', fields: ['dipc-queue-name', 'dipc-queue-size', 'dipc-max-msg-size'] },
    note: '2.0 plain POST vs 1.0 ?action=dipc-create (201; ?action=create is 400 -1073445879 "Invalid action", live-verified 2026-09-30 on RW 6.16.03). Same fields: dipc-queue-size is the message count, dipc-max-msg-size the largest message (RW6 form limit 444 bytes, RW7/RW8 448).',
  },
  sendDipcMessage: {
    tier: 'common', evidence: 'live',
    summary: 'Send a message to a DIPC queue.',
    // dipc-cmd is fixed 111, dipc-userdef fixed 0. 2.0 REQUIRES dipc-userdef
    // (400 without it). The RWS 1.0 row is the send form RW 6.16.03 serves
    // for a queue (GET /rw/dipc/{queue}?action=show, read 2026-09-29):
    // ?action=dipc-send with dipc-userdef among its fields, as ABB's RWS 1.0
    // page documents. This form has run on RW 6.16.03.
    rws2: {
      method: 'POST',
      path: '/rw/dipc/{queue}',
      fields: ['dipc-src-queue-name', 'dipc-cmd', 'dipc-userdef', 'dipc-data', 'dipc-msgtype'],
    },
    rws1: {
      method: 'POST',
      path: '/rw/dipc/{queue}',
      action: 'dipc-send',
      fields: ['dipc-src-queue-name', 'dipc-cmd', 'dipc-userdef', 'dipc-msgtype', 'dipc-data'],
    },
    note: '2.0 plain POST vs 1.0 ?action=dipc-send (the RW 6.16.03 queue form, run on RW 6.16.03). Both REQUIRE dipc-userdef (2.0: 400 without it). dipc-cmd is fixed 111.',
  },
  readDipcMessage: {
    tier: 'common', evidence: 'live',
    summary: 'Read (and consume) one message from a DIPC queue.',
    rws2: { method: 'GET', path: '/rw/dipc/{queue}' },
    // ABB's RWS 1.0 page: GET ?action=dipc-read with an optional timeout in
    // ms, answer class dipc-read-li. Run on RW 6.16.03.
    rws1: { method: 'GET', path: '/rw/dipc/{queue}', action: 'dipc-read' },
    note: '2.0 is a GET with ABB\'s timeout={ms} read-side query (POST /{queue}/read 404s); the client used to send dipc-timeout, a name the controller ignores, so the read never waited. The wait itself is not yet verified live. 1.0 is ABB\'s ?action=dipc-read with an optional timeout={ms} query (run on RW 6.16.03). Message class dipc-read (1.0: dipc-read-li), consumed on read.',
  },
  removeDipcQueue: {
    tier: 'common', evidence: 'live',
    summary: 'Delete a DIPC queue.',
    rws2: { method: 'DELETE', path: '/rw/dipc/{queue}' },
    rws1: { method: 'DELETE', path: '/rw/dipc/{queue}' },
    note: 'Same path. 1.0 answers 204 (live-verified 2026-09-30 on RW 6.16.03) and hand-appends ?json=1 (via client.request, bypassing the helpers).',
  },
  getDipcQueueInfo: {
    tier: 'common', evidence: 'live',
    summary: 'Read a DIPC queue\'s information (size, message count, …).',
    rws2: { method: 'GET', path: '/rw/dipc/{queue}/information' },
    // RWS 1.0 "Get DIPC Queue" (Rev M): the plain GET on the queue, no action
    // (?action=dipc-read stays the read). RW 6.16.03 links each queue from
    // /rw/dipc and serves its show form (read 2026-09-29).
    rws1: { method: 'GET', path: '/rw/dipc/{queue}' },
    note: '2.0 /information sub-resource vs 1.0 the queue resource itself. On 2.0 a plain GET on the queue is the consuming read; on 1.0 the read is ?action=dipc-read, so the plain GET is expected to be non-consuming, but no RW 6 build has confirmed it yet. The 1.0 body is not captured yet.',
  },
};
