/**
 * File-service, subscription and vision path table - three resource trees the
 * client treats as one domain (`/fileservice`, `/subscription`, `/rw/vision`).
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 *
 * Two things this domain needs that the PathSpec shape cannot hold, so they
 * live in the notes: fileservice GETs return RAW bytes (2.0 must drop the XHTML
 * Accept header), and 2.0 uploads need Content-Type `text/plain;v=2.0`. The
 * poll-stream WebSocket upgrade (`wss://.../poll/{id}`) is not a GET/POST/PUT/
 * DELETE resource, so it is not a row here - it is handled by the subscriber.
 */

import type { DomainTable } from './PathSpec.js';

export const FILES_VISION: DomainTable = {
  // ── File service ──────────────────────────────────────────────────────────
  listFileVolumes: {
    summary: 'List the file-service volumes (drives / home).',
    rws2: { method: 'GET', path: '/fileservice' },
    rws1: { method: 'GET', path: '/fileservice' },
    note: 'Same path; list class fs-dir (2.0) vs fs-device (1.0); 1.0 titles are drive-style (C:), volume-root fallbacks HOME (2.0) vs $HOME (1.0).',
  },
  listDirectory: {
    summary: 'List the contents of a file-service directory.',
    // Volume-root encoding splits the whole tree here: 2.0 `rws2Path` maps
    // $HOME -> HOME and percent-encodes each segment; 1.0 `fileServicePath`
    // keeps the leading $ LITERAL (controller rejects %24) and encodes the rest.
    rws2: { method: 'GET', path: '/fileservice/{path}' },
    rws1: { method: 'GET', path: '/fileservice/{path}' },
    note: '2.0 strips $ ($HOME->HOME) and percent-encodes segments; 1.0 keeps $ literal and rejects %24. Same encoding split applies to readFile/uploadFile/deleteFile.',
  },
  readFile: {
    summary: "Read a file's raw bytes.",
    // GET returns raw file bytes, not XHTML - 2.0 special-cases
    // path.startsWith('/fileservice') to drop the XHTML Accept header.
    rws2: { method: 'GET', path: '/fileservice/{path}' },
    rws1: { method: 'GET', path: '/fileservice/{path}' },
    note: 'Raw-bytes GET: 2.0 must NOT send the XHTML Accept header (per-path raw flag), unlike every other GET.',
  },
  uploadFile: {
    summary: 'Write or replace a file (raw body).',
    rws2: { method: 'PUT', path: '/fileservice/{path}' },
    rws1: { method: 'PUT', path: '/fileservice/{path}' },
    note: 'Raw body PUT. 2.0 requires Content-Type text/plain;v=2.0 (plain text/plain -> 415); 1.0 sends raw UTF-8 bytes.',
  },
  deleteFile: {
    summary: 'Delete a file or directory.',
    rws2: { method: 'DELETE', path: '/fileservice/{path}' },
    rws1: { method: 'DELETE', path: '/fileservice/{path}' },
    note: 'Same path both; only the $-encoding difference from listDirectory applies.',
  },
  createDirectory: {
    summary: 'Create a directory.',
    // 2.0 = path-suffix action + minimal body; 1.0 posts to the parent itself
    // with the action folded into the BODY.
    rws2: { method: 'POST', path: '/fileservice/{parent}/create', fields: ['fs-newname'] },
    rws1: { method: 'POST', path: '/fileservice/{parent}', fields: ['fs-action', 'fs-newname'] },
    note: '2.0 = /create suffix, body fs-newname; 1.0 = fs-action=create in the BODY (fs-action in the query string -> 400). ResourceMapper.createDirectory (1.0) exists but is DEAD - path built inline.',
  },
  copyFile: {
    summary: 'Copy a file within its own directory.',
    rws2: { method: 'POST', path: '/fileservice/{source}/copy', fields: ['fs-newname', 'fs-overwrite'] },
    rws1: { method: 'POST', path: '/fileservice/{source}', fields: ['fs-action', 'fs-newname'] },
    note: 'Copies within the source directory only (fs-newname is a bare name, dest dir dropped). 2.0 = /copy suffix + optional fs-overwrite; the spec destination field 400s. 1.0 = fs-action=copy in body, no overwrite flag.',
  },
  renameFile: {
    summary: 'Rename a file in place.',
    rws2: { method: 'POST', path: '/fileservice/{path}/rename', fields: ['fs-newname'] },
    // RWS 1.0 renames in-directory via the file's own fileservice path with
    // fs-action=rename + a bare-filename fs-newname (same shape as copy).
    // Live-verified on IRC5 RW6.16 (2026-08-11): 204.
    rws1: { method: 'POST', path: '/fileservice/{path}', fields: ['fs-action', 'fs-newname'] },
    note: 'The published new-filename field is rejected - fs-newname is the live-verified field. RWS 1.0 uses fs-action=rename (query-less POST to the file path).',
  },

  // ── Subscriptions ─────────────────────────────────────────────────────────
  createSubscription: {
    summary: 'Create a subscription group and open its event stream.',
    // Hand-rolled http.request (NOT this.req) with its own headers on 2.0.
    rws2: { method: 'POST', path: '/subscription', fields: ['resources'] },
    rws1: { method: 'POST', path: '/subscription', fields: ['resources'] },
    note: 'Body resources=N&i={path}&i-p={priority}, paths NOT percent-encoded (;stateParam semicolons stay literal); 201 + Location = ws URL. WS subprotocol rws_subscription (2.0) vs robapi2_subscription (1.0) - 2.0 rejects the 1.0 name with 400 and auths the socket by Cookie.',
  },
  unsubscribeGroup: {
    summary: 'Delete a subscription group.',
    rws2: { method: 'DELETE', path: '/subscription/{group}' },
    rws1: { method: 'DELETE', path: '/subscription/{group}' },
    note: 'DELETE the group id, not the poll URL (DELETE /poll/{id} -> 404). 1.0 poll URLs are REUSABLE after a drop; 2.0 poll URLs are spent - drop the group and re-POST on reconnect.',
  },
  updateSubscriptionGroup: {
    summary: 'Add resources to an existing subscription group.',
    rws2: { method: 'PUT', path: '/subscription/{group}', fields: ['resources'] },
    note: 'RWS 2.0 only (form update-resource-priority). ADDITIVE - body resources=N&…; the 200 body carries initial value events. Live-verified 2026-08-09 RW8.1.1.',
  },
  unsubscribeResource: {
    summary: 'Remove a single resource from a subscription group.',
    // {resource} is the subscribed resource path verbatim, incl. its leading /
    // and any ;stateParam suffix - concatenated onto the group id, not encoded.
    rws2: { method: 'DELETE', path: '/subscription/{group}{resource}' },
    note: 'RWS 2.0 only. Membership is the EXACT string subscribed (with the ;stateParam suffix) - a suffix mismatch -> 400. Removing the last resource retires the group.',
  },

  // ── Vision ────────────────────────────────────────────────────────────────
  listVisionSystems: {
    summary: 'List the configured vision systems / cameras.',
    rws2: { method: 'GET', path: '/rw/vision' },
    rws1: { method: 'GET', path: '/rw/vision' },
    note: 'Same URL as getVisionCameraCount - one GET, two operations. Real signal is number-of-cameras-li + per-camera links; vision-system-li was a guessed class that never matched (kept only as fallback).',
  },
  getVisionCameraCount: {
    summary: 'Read the number of connected vision cameras.',
    rws2: { method: 'GET', path: '/rw/vision' },
    note: 'RWS 2.0 only. Same URL as listVisionSystems (class number-of-cameras-li, field number-of-cameras).',
  },
  getVisionSystemInfo: {
    summary: "Read one vision system's details.",
    rws2: { method: 'GET', path: '/rw/vision/{name}' },
    rws1: { method: 'GET', path: '/rw/vision/{name}' },
    note: 'Same path both generations (class vision-system).',
  },
  listVisionJobs: {
    summary: "List a vision system's jobs.",
    rws2: { method: 'GET', path: '/rw/vision/{system}/jobs' },
    note: 'RWS 2.0 only (class vision-job-li).',
  },
  triggerVisionJob: {
    summary: 'Trigger a vision job.',
    // 2.0 addresses the job; 1.0 is a query-action on the SYSTEM with no job
    // segment, so the job argument is silently dropped.
    rws2: { method: 'POST', path: '/rw/vision/{system}/jobs/{job}/trigger' },
    rws1: { method: 'POST', path: '/rw/vision/{system}', action: 'trigger' },
    note: '1.0 has NO job segment (?action=trigger, empty body) - the adapter drops the job arg IRWSAdapter.triggerVisionJob(system, job) declares. Flag for a live probe before freezing.',
  },
  refreshVisionCameras: {
    summary: 'Rescan for connected vision cameras.',
    rws2: { method: 'POST', path: '/rw/vision/refresh' },
    note: 'RWS 2.0 only; no body.',
  },
};
