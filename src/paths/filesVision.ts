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
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'List the file-service volumes (drives / home).',
    rws2: { method: 'GET', path: '/fileservice' },
    rws1: { method: 'GET', path: '/fileservice' },
    note: 'Same path; list class fs-dir (2.0) vs fs-device (1.0); 1.0 titles are drive-style (C:), volume-root fallbacks HOME (2.0) vs $HOME (1.0).',
  },
  listDirectory: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'List the contents of a file-service directory.',
    // Volume-root encoding splits the whole tree here: 2.0 `rws2Path` maps
    // $HOME -> HOME and percent-encodes each segment; 1.0 `fileServicePath`
    // keeps the leading $ literal (which works; %24 is accepted too) and
    // encodes the rest. RW 6.16.03 refuses a volume with no $ on GET and
    // directory create (live-verified 2026-09-29).
    rws2: { method: 'GET', path: '/fileservice/{path}' },
    rws1: { method: 'GET', path: '/fileservice/{path}' },
    note: '2.0 strips $ ($HOME->HOME) and percent-encodes segments; 1.0 keeps $ literal (%24 also works on 6.16.03; a bare volume name without $ is refused on GET and directory create). Same encoding split applies to readFile/uploadFile/deleteFile.',
  },
  readFile: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: "Read a file's raw bytes.",
    // GET returns raw file bytes, not XHTML - 2.0 special-cases
    // path.startsWith('/fileservice') to drop the XHTML Accept header.
    rws2: { method: 'GET', path: '/fileservice/{path}' },
    rws1: { method: 'GET', path: '/fileservice/{path}' },
    note: 'Raw-bytes GET: 2.0 must NOT send the XHTML Accept header (per-path raw flag), unlike every other GET.',
  },
  getFileMetadata: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: "Read a file's metadata without downloading it.",
    // RWS 2.0: ABB's file service page Rev L, "Get File Meta Data" (HEAD, 204).
    // RW 7.21.4 and 8.2.1 list HEAD in a file's Allow header (read 2026-09-29).
    rws2: { method: 'HEAD', path: '/fileservice/{path}' },
    // RWS 1.0: the file's entry in its parent directory's listing, which carries
    // fs-size, fs-cdate, fs-mdate and fs-readonly. ABB's manual (Rev M, "Get
    // file Meta data") gives HEAD, which RW 6.16.03 answers 204 with only
    // Content-Length (2026-10-09). The ?action=metadata this row used to send
    // is in no Rev M page and answers 400 "Invalid action or resource".
    rws1: { method: 'GET', path: '/fileservice/{parent}' },
    note: '2.0 HEAD (metadata in the headers); 1.0 the parent listing\'s entry for the file. Same per-generation $-encoding as readFile.',
  },
  uploadFile: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Write or replace a file (raw body).',
    rws2: { method: 'PUT', path: '/fileservice/{path}' },
    rws1: { method: 'PUT', path: '/fileservice/{path}' },
    note: 'Raw body PUT. 2.0 requires Content-Type text/plain;v=2.0 (plain text/plain -> 415); 1.0 sends raw UTF-8 bytes.',
  },
  deleteFile: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Delete a file or directory.',
    rws2: { method: 'DELETE', path: '/fileservice/{path}' },
    rws1: { method: 'DELETE', path: '/fileservice/{path}' },
    note: 'Same path both; only the $-encoding difference from listDirectory applies.',
  },
  createDirectory: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Create a directory.',
    // 2.0 = path-suffix action + minimal body; 1.0 posts to the parent itself
    // with the action folded into the BODY.
    rws2: { method: 'POST', path: '/fileservice/{parent}/create', fields: ['fs-newname'] },
    rws1: { method: 'POST', path: '/fileservice/{parent}', fields: ['fs-action', 'fs-newname'] },
    note: '2.0 = /create suffix, body fs-newname; 1.0 = fs-action=create in the BODY (fs-action in the query string -> 400). ResourceMapper.createDirectory (1.0) exists but is DEAD - path built inline.',
  },
  copyFile: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Copy a file within its own directory.',
    rws2: { method: 'POST', path: '/fileservice/{source}/copy', fields: ['fs-newname', 'fs-overwrite'] },
    rws1: { method: 'POST', path: '/fileservice/{source}', fields: ['fs-action', 'fs-newname'] },
    note: 'Copies within the source directory only (fs-newname is a bare name, dest dir dropped). 2.0 = /copy suffix + optional fs-overwrite; the spec destination field 400s. 1.0 = fs-action=copy in body, no overwrite flag.',
  },
  renameFile: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Rename a file in place.',
    rws2: { method: 'POST', path: '/fileservice/{path}/rename', fields: ['fs-newname'] },
    // RWS 1.0 renames in-directory via the file's own fileservice path with
    // fs-action=rename + a bare-filename fs-newname (same shape as copy).
    // Live-verified on the RobotWare 6.16 virtual controller (2026-08-11): 204.
    rws1: { method: 'POST', path: '/fileservice/{path}', fields: ['fs-action', 'fs-newname'] },
    note: 'The published new-filename field is rejected - fs-newname is the live-verified field. RWS 1.0 uses fs-action=rename (query-less POST to the file path).',
  },

  // ── Subscriptions ─────────────────────────────────────────────────────────
  createSubscription: {
    tier: 'common', evidence: 'live', effect: 'session',
    summary: 'Create a subscription group and open its event stream.',
    // Hand-rolled http.request (NOT this.req) with its own headers on 2.0.
    rws2: { method: 'POST', path: '/subscription', fields: ['resources'] },
    rws1: { method: 'POST', path: '/subscription', fields: ['resources'] },
    note: 'Body resources=N&i={path}&i-p={priority}, paths NOT percent-encoded (;stateParam semicolons stay literal); 201 + Location = ws URL. WS subprotocol rws_subscription (2.0) vs robapi2_subscription (1.0) - 2.0 rejects the 1.0 name with 400 and auths the socket by Cookie.',
  },
  unsubscribeGroup: {
    tier: 'common', evidence: 'live', effect: 'session',
    summary: 'Delete a subscription group.',
    rws2: { method: 'DELETE', path: '/subscription/{group}' },
    rws1: { method: 'DELETE', path: '/subscription/{group}' },
    note: 'DELETE the group id, not the poll URL (DELETE /poll/{id} -> 404). 1.0 poll URLs are REUSABLE after a drop; 2.0 poll URLs are spent - drop the group and re-POST on reconnect.',
  },
  updateSubscriptionGroup: {
    tier: 'common', evidence: 'live', effect: 'session',
    summary: 'Add resources to an existing subscription group.',
    rws2: { method: 'PUT', path: '/subscription/{group}', fields: ['resources'] },
    // RWS 1.0: ABB's RWS 1.0 manual documents "Update Subscription Group" as
    // the same PUT; RW 6.16.03 serves GET /subscription/{group} (2026-09-29).
    rws1: { method: 'PUT', path: '/subscription/{group}', fields: ['resources'] },
    note: '2.0 form update-resource-priority. ADDITIVE - body resources=N&…; the 200 body carries initial value events. Live-verified 2026-08-09 RW8.1.1. 1.0 from ABB\'s RWS 1.0 manual; no PUT sent to RW 6.16 yet.',
  },
  unsubscribeResource: {
    tier: 'niche', evidence: 'live', effect: 'session',
    summary: 'Remove a single resource from a subscription group.',
    // {resource} is the subscribed resource path verbatim, incl. its leading /
    // and any ;stateParam suffix - concatenated onto the group id, not encoded.
    rws2: { method: 'DELETE', path: '/subscription/{group}{resource}' },
    // RWS 1.0 Rev M "Unsubscribe or remove the resource from subscription
    // group": DELETE, 200, sample /subscription/1/rw/iosystem/signals/
    // Virtual1/Board1/di1;state (the page's URL line spells /subscripion).
    rws1: { method: 'DELETE', path: '/subscription/{group}{resource}' },
    note: 'Same request on both generations. Membership is the EXACT string subscribed (with the ;stateParam suffix) - a suffix mismatch -> 400 on RWS 2.0. Removing the last resource retires the group. RWS 1.0: RW 6.16.03 answered 200 and the dropped resource sent no more events (2026-10-21); its subscribe handle carries no group path (listSubscriptionGroups finds it). Mastership of every domain is one DELETE per domain.',
  },
  listSubscriptionGroups: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: "List the session's subscription groups.",
    // Served 200 on RW 6.16.03, 7.21.4+417 and 8.2.1+1023 (2026-09-29): one
    // `subsgrp-li` per group, title = id, a rel="events" poll link. The RWS
    // 2.0 Subscription_Service page (Rev L) documents no GET here.
    rws2: { method: 'GET', path: '/subscription' },
    rws1: { method: 'GET', path: '/subscription' },
    note: 'XHTML on every build, whatever the Accept or ?json=1 (RW 6.16.03 ignores ?json=1; RW 7.21.4 and 8.2.1 answer XHTML to a hal+json Accept). Lists the groups of the session that asks. RW 6.16.03 writes the poll link without a host (ws:///poll/{id}).',
  },
  getSubscriptionGroup: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'List the resources bound to one subscription group.',
    // Served 200 on all three builds (2026-09-29): one `sub-resource` per
    // member, title = index, self link = the resource as stored.
    rws2: { method: 'GET', path: '/subscription/{group}' },
    rws1: { method: 'GET', path: '/subscription/{group}' },
    note: 'XHTML on every build. A group of another session, or a deleted one, answers 400 -1073435900 "Group N does not belong to Client M." on all three. The member strings keep their ;stateParam suffix.',
  },

  // ── Vision ────────────────────────────────────────────────────────────────
  listVisionSystems: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'List the configured vision systems / cameras.',
    rws2: { method: 'GET', path: '/rw/vision' },
    rws1: { method: 'GET', path: '/rw/vision' },
    note: 'Same URL as getVisionCameraCount - one GET, two operations. Real signal is number-of-cameras-li + per-camera links; vision-system-li was a guessed class that never matched (kept only as fallback).',
  },
  getVisionCameraCount: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the number of connected vision cameras.',
    rws2: { method: 'GET', path: '/rw/vision' },
    note: 'RWS 2.0 only. Same URL as listVisionSystems (class number-of-cameras-li, field number-of-cameras).',
  },
  getVisionSystemInfo: {
    tier: 'niche', evidence: 'built', effect: 'read',
    summary: "Read one camera's details.",
    // ABB Integrated_Vision_Service.yaml Rev L: GET /rw/vision/{camera-identifier}/info
    // (class camera-info-li). The bare /rw/vision/{name} the client used to
    // read is not a route on RW 7.21.4 or 8.2.1 (404 like a made-up path),
    // while the documented children are routed (spec check 2026-10-07). The
    // class name comes from ABB's example: no VC has the option or a camera.
    rws2: { method: 'GET', path: '/rw/vision/{name}/info' },
    // RWS 1.0: GET /rw/vision?resource=camera-info&name=<camera> (ABB's RWS 1.0
    // manual Rev M, camera info). On RW 6.16.03 that query reaches the vision
    // handler, while /rw/vision/{name} is refused by the router as an unknown
    // resource (2026-10-10). The adapter appends &name=.
    rws1: { method: 'GET', path: '/rw/vision', query: 'resource=camera-info' },
    note: '2.0 reads the documented /info child (class camera-info-li, from ABB\'s example); 1.0 a camera-info query on /rw/vision. No VC has a camera, so neither answer is seen.',
  },
  listVisionJobs: {
    tier: 'niche', evidence: 'built', effect: 'read',
    summary: "Read a camera's job name.",
    // Rev L has one job name per camera, GET /rw/vision/{camera-name}/job-name
    // (class vision-camera-job, field jobname); there is no jobs list. The
    // client's /rw/vision/{system}/jobs is not routed (404) on either build.
    rws2: { method: 'GET', path: '/rw/vision/{system}/job-name' },
    note: 'RWS 2.0 only; one job per camera (class vision-camera-job, field jobname, from ABB\'s example). A controller without the option answers 403.',
  },
  triggerVisionJob: {
    tier: 'niche', evidence: 'built', effect: 'write',
    summary: 'Trigger a vision job (no such RWS operation).',
    // Rev L documents no trigger operation, and the client's path sits under
    // the unrouted `jobs` segment (404 on RW 7.21.4 and 8.2.1, 2026-10-07).
    // Rev M's Integrated Vision pages have no trigger either. Both clients
    // throw UNSUPPORTED_OPERATION without sending.
    rws2: { method: 'POST', path: '/rw/vision/{system}/jobs/{job}/trigger', gap: 'in no ABB document and not routed; nothing is sent (UNSUPPORTED_OPERATION)' },
    rws1: { method: 'POST', path: '/rw/vision/{system}', action: 'trigger', gap: 'in no ABB document; nothing is sent (UNSUPPORTED_OPERATION)' },
    note: 'not an RWS operation on either generation (no trigger in Rev M or Rev L); nothing is sent.',
  },
  refreshVisionCameras: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Rescan for connected vision cameras.',
    rws2: { method: 'POST', path: '/rw/vision/refresh' },
    note: 'RWS 2.0 only; no body.',
  },
};
