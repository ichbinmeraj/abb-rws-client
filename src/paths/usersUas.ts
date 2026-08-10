/**
 * Users / UAS domain path table (`/users`, `/uas`) - session login, RMMP
 * privilege, grants, and LDAP resources.
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 *
 * Two roots live here: `/users/*` (present on both generations) and `/uas/*`
 * (RWS 2.0 only - the whole tree 404s on RW6). No path in this domain touches a
 * ResourceMapper; every one is an inline literal in RwsClient2 / RWS1Adapter.
 * The RWS 1.0 side appends `?json=1` generically in rws1Get/rws1Post - treat that
 * as transport, not part of the path.
 */

import type { DomainTable } from './PathSpec.js';

export const USERS_UAS: DomainTable = {
  // ── RMMP privilege ────────────────────────────────────────────────────────
  getRmmpPrivilege: {
    summary: 'Read the RMMP (request manual mode privileges) grant for this session.',
    rws2: { method: 'GET', path: '/users/rmmp' },
    rws1: { method: 'GET', path: '/users/rmmp' },
    note: 'Same path both generations (rare). Response must check rmmpheldbyme to attribute the privilege. RW8.1.1: the whole RMMP service answers HTTP 500 on every verb; 2.0 maps that to \'none\'.',
  },
  requestRmmp: {
    summary: 'Request an RMMP privilege level.',
    rws2: { method: 'POST', path: '/users/rmmp', fields: ['privilege'] },
    rws1: { method: 'POST', path: '/users/rmmp', fields: ['privilege'] },
    note: 'Same path and field as the getter. Encoding differs: 2.0 passes a field object, 1.0 a pre-encoded privilege={level} string. RW8.1.1 500 -> UNSUPPORTED_OPERATION.',
  },
  pollRmmp: {
    summary: 'Poll a pending RMMP request - keeps the grant window alive and reports its status.',
    rws2: { method: 'GET', path: '/users/rmmp/poll' },
    rws1: { method: 'GET', path: '/users/rmmp/poll' },
    note: 'Same path both generations. Live-verified 200 on RW6.16 and RW7.21 (2026-08-11), class user-rmmp-poll (code + status, e.g. "NO SUCH REQUEST" when none pending).',
  },
  cancelRmmp: {
    summary: 'Cancel this session\'s pending/held RMMP request.',
    rws2: { method: 'POST', path: '/users/rmmp/cancel' },
    rws1: { method: 'POST', path: '/users/rmmp', action: 'cancel' },
    note: 'Generation split: RWS 2.0 path-action /users/rmmp/cancel, RWS 1.0 query-action /users/rmmp?action=cancel. Both live-verified 204 (2026-08-11, RW7.21 / RW6.16).',
  },

  // ── Login info ────────────────────────────────────────────────────────────
  getLoginInfo: {
    summary: 'Read the current session login info.',
    rws2: { method: 'GET', path: '/users/login-info' },
    note: 'RWS 2.0 only; 404 (protocol-absent) on RW6.16. Class user-login-info.',
  },

  // ── Grants ────────────────────────────────────────────────────────────────
  checkGrantExists: {
    summary: 'Check whether a named UAS grant exists.',
    rws2: { method: 'GET', path: '/users/grant-exists' },
    note: 'RWS 2.0 only; 404 on RW6.16. The domain\'s only query-parameterized GET: read-side ?grant={grant} kept out of the path.',
  },
  listAllGrants: {
    summary: 'List every UAS grant defined on the controller.',
    rws2: { method: 'GET', path: '/uas/grants' },
    note: 'RWS 2.0 only (/uas/* tree absent on RW6). One resource, two schemas: hal+json class grant-info / span grant-description vs XHTML class uas-grant / span description.',
  },
  listCurrentUserGrants: {
    summary: 'List the grants held by the current user.',
    // The domain's ONE cross-tree divergence: the generations use entirely
    // different resources, classes, and name-carrying fields. Key by operation.
    rws2: { method: 'GET', path: '/uas/user/grants' },
    rws1: { method: 'GET', path: '/users/grants' },
    note: '2.0 /uas/user/grants (class uas-grant, field grantname) vs 1.0 /users/grants (class user-grant, grant name in _title). Only cross-tree divergence in the domain.',
  },

  // ── User management ───────────────────────────────────────────────────────
  registerUser: {
    summary: 'Register a local user/application session.',
    rws2: { method: 'POST', path: '/users/register', fields: ['application', 'username', 'location', 'ulocale'] },
    note: 'RWS 2.0 only; 404 on RWS 1.0. Built from live form, never executed (built-not-run). Field is ulocale (optional), not locale.',
  },
  impersonateUser: {
    summary: 'Impersonate another user by uid.',
    rws2: { method: 'POST', path: '/users/impersonate', fields: ['uid'] },
    note: 'RWS 2.0 only. Built-not-run (UAS mutation barred on VCs).',
  },

  // ── Password ──────────────────────────────────────────────────────────────
  isPasswordChangeAllowed: {
    summary: 'Read whether the current user may change their password.',
    rws2: { method: 'GET', path: '/uas/user/password-change-allow' },
    note: 'RWS 2.0 only; live-verified 200 on RW7.21 and RW8.1.1. Response key not pinned - code probes password-change-allow / status / state.',
  },
  changePassword: {
    summary: 'Change the current user password.',
    rws2: { method: 'POST', path: '/uas/user/password', fields: ['old-password', 'new-password'] },
    note: 'RWS 2.0 only. Built-not-run. Hyphenated body fields, unlike the bare privilege / ulocale elsewhere in the domain.',
  },

  // ── LDAP ──────────────────────────────────────────────────────────────────
  listLdapResources: {
    summary: 'List the LDAP configuration sub-resources.',
    rws2: { method: 'GET', path: '/uas/ldap' },
    note: 'RWS 2.0 only. Listing answers 200 for a normal user; entry classes are uas-ldap-{name}-li for enabled, searchpassword, configuration, settings, certificate, verify.',
  },
  getLdapResource: {
    summary: 'Read one LDAP configuration sub-resource by name.',
    rws2: { method: 'GET', path: '/uas/ldap/{name}' },
    note: 'RWS 2.0 only. Every sub-resource answers 403 SYS_CTRL_E_UAS_REJECT on both VCs (feature unlicensed); parser accepts class with and without the -li suffix. Unverified against an LDAP-licensed controller.',
  },
};
