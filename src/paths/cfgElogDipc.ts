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
 * `order`, `dipc-timeout`) are modifiers, not resources - both are noted, never
 * baked into `path`. The write-verb split is perfectly systematic here: RWS 2.0
 * uses a path segment (`/clear`, `/clearall`, `/create-default`, `/load`,
 * `/saveas`, or a plain POST) where RWS 1.0 uses `?action=`.
 */

import type { DomainTable } from './PathSpec.js';

export const CFG_ELOG_DIPC: DomainTable = {
  // ── Event log (/rw/elog) ──────────────────────────────────────────────────
  getEventLog: {
    summary: 'Read a domain of event-log messages (paginated on 2.0).',
    rws2: { method: 'GET', path: '/rw/elog/{domain}' },
    rws1: { method: 'GET', path: '/rw/elog/{domain}' },
    note: 'Same base path. lang is a read-side query. 2.0 walks rel=next; newest-first (&order=lifo) needs the undocumented Accept: application/hal+json;v=2.1 media type (elog is the only resource that accepts it). RW6 returns one page, no next link.',
  },
  clearEventLog: {
    summary: 'Clear one event-log domain.',
    rws2: { method: 'POST', path: '/rw/elog/{domain}/clear' },
    rws1: { method: 'POST', path: '/rw/elog/{domain}', action: 'clear' },
    note: '2.0 path-segment /clear vs 1.0 ?action=clear; empty body either way.',
  },
  clearAllEventLogs: {
    summary: 'Clear every event-log domain.',
    rws2: { method: 'POST', path: '/rw/elog/clearall' },
    rws1: { method: 'POST', path: '/rw/elog', action: 'clearall' },
    note: '2.0 path-segment /clearall vs 1.0 ?action=clearall.',
  },
  getEventLogMessage: {
    summary: 'Read a single event-log message by domain + sequence number.',
    rws2: { method: 'GET', path: '/rw/elog/{domain}/{seqnum}' },
    rws1: { method: 'GET', path: '/rw/elog/{domain}/{seqnum}' },
    note: 'Identical path on both generations (rare); lang is a read-side query. Message args come from argc/arg{N} spans in this payload - there is no /args sub-resource.',
  },
  getEventLogMessageBySeqnum: {
    summary: 'Read a message by global sequence number (domain-agnostic lookup).',
    rws2: { method: 'GET', path: '/rw/elog/seqnum/{seqnum}' },
    note: 'RWS 2.0 only. lang is a read-side query.',
  },
  saveEventLogRaw: {
    summary: 'Save the raw event log to a file.',
    rws2: { method: 'POST', path: '/rw/elog/saveraw', fields: ['path'] },
    // RWS 1.0 query-action form, same single `path` field (a /fileservice/ URI).
    // Async: 202 ACCEPTED. Live-verified on IRC5 RW6.16 (2026-08-11).
    rws1: { method: 'POST', path: '/rw/elog', action: 'saveraw', fields: ['path'] },
    note: 'path MUST be a fileservice URI; bare volume paths are rejected. RWS 2.0 path /rw/elog/saveraw; RWS 1.0 query-action /rw/elog?action=saveraw (202).',
  },
  listEventLogDomains: {
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
    summary: 'List the configuration domains (EIO, MOC, SYS, …).',
    rws2: { method: 'GET', path: '/rw/cfg' },
    rws1: { method: 'GET', path: '/rw/cfg' },
  },
  listCfgTypes: {
    summary: 'List the instance types within a configuration domain.',
    rws2: { method: 'GET', path: '/rw/cfg/{domain}' },
    rws1: { method: 'GET', path: '/rw/cfg/{domain}' },
    note: 'Both paginated, different next-link plumbing: 2.0 rel=next hrefs relative to /rw/cfg/; 1.0 _links.next.href with json=1 stripped.',
  },
  listCfgInstances: {
    summary: 'List the instances of a configuration type.',
    rws2: { method: 'GET', path: '/rw/cfg/{domain}/{type}/instances' },
    rws1: { method: 'GET', path: '/rw/cfg/{domain}/{type}/instances' },
    note: 'Same path; RWS2 paginates, RWS1 single page.',
  },
  getCfgInstance: {
    summary: 'Read one configuration instance by name.',
    // 1.0 deliberately hits the LIST path and filters by _title client-side -
    // it works, but it is a genuinely different URL than 2.0's single-instance
    // resource, not a quirk of encoding.
    rws2: { method: 'GET', path: '/rw/cfg/{domain}/{type}/instances/{instance}' },
    rws1: { method: 'GET', path: '/rw/cfg/{domain}/{type}/instances' },
    note: '1.0 hits the LIST path (then filters by _title), NOT the single-instance path 2.0 uses.',
  },
  setCfgInstance: {
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
    summary: 'Create a default-valued configuration instance.',
    rws2: { method: 'POST', path: '/rw/cfg/{domain}/{type}/instances/create-default', fields: ['name'] },
    rws1: { method: 'POST', path: '/rw/cfg/{domain}/{type}/instances', action: 'create-default', fields: ['name'] },
    note: '2.0 path-segment /create-default vs 1.0 ?action=create-default. 1.0 percent-encodes name; 2.0 sends name RAW in the body (an & or % in the name breaks the 2.0 create).',
  },
  removeCfgInstance: {
    summary: 'Delete a configuration instance.',
    rws2: { method: 'DELETE', path: '/rw/cfg/{domain}/{type}/instances/{instance}' },
    rws1: { method: 'DELETE', path: '/rw/cfg/{domain}/{type}/instances/{instance}' },
    note: 'Same path; 1.0 hand-appends ?json=1 (via client.request, bypassing the helpers). Readback after delete: 404 on 2.0 vs 400 "unknown instance" on RW6.',
  },
  listCfgTypeAttributes: {
    summary: 'List the attribute definitions of a configuration type.',
    rws2: { method: 'GET', path: '/rw/cfg/{domain}/{type}/attributes' },
    note: 'RWS 2.0 only.',
  },
  loadCfgFile: {
    summary: 'Load a configuration file into the controller.',
    // Field order differs per the OPTIONS form: 2.0 action-type first, 1.0
    // filepath first. Neither side fileservice-normalizes filepath here (read
    // side; the controller resolves bare volume paths), unlike saveCfgFile.
    rws2: { method: 'POST', path: '/rw/cfg/load', fields: ['action-type', 'filepath'] },
    rws1: { method: 'POST', path: '/rw/cfg', action: 'load', fields: ['filepath', 'action-type'] },
    note: 'Dedicated /load resource vs 1.0 ?action=load on the collection; same fields, order differs. filepath NOT fileservice-normalized on either side.',
  },
  saveCfgFile: {
    summary: 'Save a configuration domain to a file.',
    rws2: { method: 'POST', path: '/rw/cfg/{domain}/saveas', fields: ['filepath'] },
    rws1: { method: 'POST', path: '/rw/cfg/{domain}', action: 'saveas', fields: ['filepath'] },
    note: '2.0 /saveas segment vs 1.0 ?action=saveas (/save 405s on 2.0). filepath is a fileservice URI (toFileserviceUri) on both; 1.0 duplicates that logic inline.',
  },
  validateCfgInstances: {
    summary: 'Validate existing configuration instances (not a create dry-run).',
    rws2: {
      method: 'POST',
      path: '/rw/cfg/validate-instances',
      fields: ['operation', 'cfgdomain', 'cfgtype', 'instancescount', 'instances'],
    },
    note: 'RWS 2.0 only; form-urlencoded;v=2.0, operation is numeric 0/1, instances repeated. 204 = valid, 200+body = problem. Validates EXISTING instances.',
  },

  // ── DIPC queues (/rw/dipc) ────────────────────────────────────────────────
  listDipcQueues: {
    summary: 'List the DIPC (inter-process communication) queues.',
    rws2: { method: 'GET', path: '/rw/dipc' },
    rws1: { method: 'GET', path: '/rw/dipc' },
  },
  createDipcQueue: {
    summary: 'Create a DIPC queue.',
    // DIFFERENT size-field names per generation - and 1.0's names are exactly
    // the ones the 2.0 controller rejects with 400. 1.0's names are unverified
    // (never probed on RW6) and may be wrong there too.
    rws2: { method: 'POST', path: '/rw/dipc', fields: ['dipc-queue-name', 'dipc-queue-size', 'dipc-max-msg-size'] },
    rws1: { method: 'POST', path: '/rw/dipc', action: 'create', fields: ['dipc-queue-name', 'dipc-max-size', 'dipc-max-number-of-messages'] },
    note: '2.0 plain POST vs 1.0 ?action=create. Size fields differ: 2.0 dipc-queue-size/dipc-max-msg-size vs 1.0 dipc-max-size/dipc-max-number-of-messages (1.0 names are the ones 2.0 rejects; SUSPECT/unverified on RW6).',
  },
  sendDipcMessage: {
    summary: 'Send a message to a DIPC queue.',
    // dipc-cmd is fixed 111, dipc-userdef fixed 0. 2.0 REQUIRES dipc-userdef
    // (400 without it); 1.0 omits it entirely.
    rws2: {
      method: 'POST',
      path: '/rw/dipc/{queue}',
      fields: ['dipc-src-queue-name', 'dipc-cmd', 'dipc-userdef', 'dipc-data', 'dipc-msgtype'],
    },
    rws1: {
      method: 'POST',
      path: '/rw/dipc/{queue}',
      action: 'send',
      fields: ['dipc-src-queue-name', 'dipc-cmd', 'dipc-data', 'dipc-msgtype'],
    },
    note: '2.0 plain POST vs 1.0 ?action=send. 2.0 REQUIRES dipc-userdef=0 (400 without); 1.0 body omits it. dipc-cmd is fixed 111.',
  },
  readDipcMessage: {
    summary: 'Read (and consume) one message from a DIPC queue.',
    rws2: { method: 'GET', path: '/rw/dipc/{queue}' },
    rws1: { method: 'GET', path: '/rw/dipc/{queue}', action: 'read' },
    note: '2.0 is a GET with a dipc-timeout={ms} read-side query (POST /{queue}/read 404s); 1.0 uses ?action=read with no timeout support. Message class dipc-read, consumed on read.',
  },
  removeDipcQueue: {
    summary: 'Delete a DIPC queue.',
    rws2: { method: 'DELETE', path: '/rw/dipc/{queue}' },
    rws1: { method: 'DELETE', path: '/rw/dipc/{queue}' },
    note: 'Same path; 1.0 hand-appends ?json=1 (via client.request, bypassing the helpers).',
  },
  getDipcQueueInfo: {
    summary: 'Read a DIPC queue\'s information (size, message count, …).',
    rws2: { method: 'GET', path: '/rw/dipc/{queue}/information' },
    note: 'RWS 2.0 only.',
  },
};
