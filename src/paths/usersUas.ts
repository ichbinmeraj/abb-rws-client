/**
 * Users / UAS domain path table (`/users`, `/uas`) - session login, RMMP
 * privilege, grants, and LDAP resources; the UAS configuration database
 * (`/uas/configuration`) is recorded as a gap, not wrapped.
 *
 * Not every row here has had a 200 from a controller; each row's note says
 * which kind it is. Most rows are live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1), and where such a note states a controller
 * behaviour, it was observed, not read from the ABB PDF (which has errors).
 * The writes marked built-not-run (impersonateUser, changePassword) were
 * built from the controller's own forms but never sent; registerUser,
 * built the same way, answered 201 on RW 7.21.4 and 8.2.1 (2026-10-21).
 * ABB's RWS 1.0 documents registerUser (POST /users) and impersonateUser
 * (POST /users?action=impersonate) as well; this client wraps them on RWS 2.0
 * only. RWS 1.0 has no password operation.
 * The UAS user and role reads follow ABB's UAS_Service Rev L shapes. For the
 * OmniCore Default User (no UAS_UAS_ADMINISTRATION) on RW 7.21.4 and 8.2.1,
 * GET /uas/users/{user}, its /grants, /roles and /password-change-allow, and
 * GET /uas/roles/{role} answer 200 (2026-10-01, 2026-10-09); the two listings
 * and the /enable, /description, role /grants and role /description reads
 * answer 403 -1073445867. Anomalies worth carrying forward are
 * stated on the operation, not hidden.
 *
 * Two roots live here: `/users/*` (present on both generations) and `/uas/*`
 * (RWS 2.0 only - the whole tree 404s on RW6). No path in this domain touches a
 * ResourceMapper; every one is an inline literal in RwsClient2 / RWS1Adapter.
 * The RWS 1.0 side appends `?json=1` generically in rws1Get/rws1Post - treat that
 * as transport, not part of the path.
 */

import { RwsError } from '../types.js';
import type { DomainTable } from './PathSpec.js';

/**
 * The `ulocale` value of a user registration. ABB gives two values, `local`
 * and `remote`, and marks the field required (RWS 1.0 Rev M "Register the
 * user", RWS 2.0 Rev L `/users/register`, whose schema types it a plain
 * string). A given string is sent as it is, as 1.4.0 did, and the controller
 * decides; a controller's 400 to a value other than those two is explained
 * with them (`registrationLocaleNote`). Without one the registration carries
 * no `ulocale`, as in 1.4.0 (`undefined`); RW 7.21.4 and 8.2.1 refuse that
 * with 400 "UserRegistration failed:locale name is empty or exceeded size of
 * ulocale" (2026-10-21), which is explained the same way. A value that is not
 * a string is a type error, refused before sending.
 * @throws RwsError `INVALID_ARGUMENT` for a value that is not a string
 */
export function registrationLocale(value: unknown, who: string): string | undefined {
  if (value === undefined || typeof value === 'string') { return value; }
  throw new RwsError(
    `${who} registerUser: locale (ABB's ulocale) must be a string, and ABB's values are 'local' and 'remote'; got ${value === null ? 'null' : typeof value}. Leave it out to send no ulocale. Nothing was sent.`,
    'INVALID_ARGUMENT');
}

/**
 * What a controller's 400 to a registration is told when the `ulocale` sent
 * is not one of ABB's two values, or none was sent; null when it is one of
 * them. It names ABB's values and does not say the value was the reason: the
 * controller's answer is kept beside it.
 */
export function registrationLocaleNote(ulocale: string | undefined): string | null {
  if (ulocale === 'local' || ulocale === 'remote') { return null; }
  if (ulocale === undefined) {
    return "registerUser sent no ulocale, which ABB marks required, with the values 'local' and 'remote' (a remote tool sends 'remote').";
  }
  return `registerUser sent ulocale '${ulocale}', and ABB's values are 'local' and 'remote' (a remote tool sends 'remote').`;
}

export const USERS_UAS: DomainTable = {
  // ── RMMP privilege ────────────────────────────────────────────────────────
  getRmmpPrivilege: {
    tier: 'common', evidence: 'live',
    summary: 'Read the RMMP (request manual mode privileges) grant for this session.',
    rws2: { method: 'GET', path: '/users/rmmp' },
    rws1: { method: 'GET', path: '/users/rmmp' },
    note: 'Same path both generations (rare). Response must check rmmpheldbyme to attribute the privilege. Values none | pending modify | modify | exec. RobotWare 8: not supported (RW8.1.1 answers 500 -1073445885); the client sends nothing there and reports \'unsupported\'.',
  },
  requestRmmp: {
    tier: 'common', evidence: 'live',
    summary: 'Request an RMMP privilege level.',
    rws2: { method: 'POST', path: '/users/rmmp', fields: ['privilege'] },
    rws1: { method: 'POST', path: '/users/rmmp', fields: ['privilege'] },
    note: 'Same path and field as the getter. Encoding differs: 2.0 passes a field object, 1.0 a pre-encoded privilege={level} string. ABB values modify | exec. RobotWare 8: UNSUPPORTED_OPERATION, nothing sent. RW 6.16.03 (MANR): modify answered 202 and was granted at the FlexPendant; exec is still to be tried on RWS 1.0. RW 7.21.4 (MANR) refused exec with 403 -1073445800 also with Enable held at the virtual FlexPendant, and a granted modify was still held after 180 s (2026-10-18).',
  },
  pollRmmp: {
    tier: 'common', evidence: 'live',
    summary: 'Poll a pending RMMP request - keeps the grant window alive and reports its status.',
    rws2: { method: 'GET', path: '/users/rmmp/poll' },
    rws1: { method: 'GET', path: '/users/rmmp/poll' },
    note: 'Same path both generations. Live-verified 200 on RW6.16 and RW7.21 (2026-08-11), class user-rmmp-poll (code + status, e.g. "NO SUCH REQUEST" when none pending).',
  },
  cancelRmmp: {
    tier: 'common', evidence: 'live',
    summary: 'Cancel this session\'s pending/held RMMP request.',
    rws2: { method: 'POST', path: '/users/rmmp/cancel' },
    rws1: { method: 'POST', path: '/users/rmmp', action: 'cancel' },
    note: 'Generation split: RWS 2.0 path-action /users/rmmp/cancel, RWS 1.0 query-action /users/rmmp?action=cancel. Both live-verified 204 (2026-08-11, RW7.21 / RW6.16).',
  },

  // ── Login info ────────────────────────────────────────────────────────────
  getLoginInfo: {
    tier: 'common', evidence: 'live',
    summary: 'Read the current session login info.',
    rws2: { method: 'GET', path: '/users/login-info' },
    note: 'RWS 2.0 only; 404 (protocol-absent) on RW6.16. Class user-login-info.',
  },

  // ── Grants ────────────────────────────────────────────────────────────────
  checkGrantExists: {
    tier: 'niche', evidence: 'live',
    summary: 'Check whether a named UAS grant exists.',
    rws2: { method: 'GET', path: '/users/grant-exists' },
    note: 'RWS 2.0 only; 404 on RW6.16. The domain\'s only query-parameterized GET: read-side ?grant={grant} kept out of the path.',
  },
  listAllGrants: {
    tier: 'common', evidence: 'live',
    summary: 'List every UAS grant defined on the controller.',
    rws2: { method: 'GET', path: '/uas/grants' },
    note: 'RWS 2.0 only (/uas/* tree absent on RW6). One resource, two schemas: hal+json class grant-info / span grant-description vs XHTML class uas-grant / span description.',
  },
  listCurrentUserGrants: {
    tier: 'common', evidence: 'live',
    summary: 'List the grants held by the current user.',
    // The domain's ONE cross-tree divergence: the generations use entirely
    // different resources, classes, and name-carrying fields. Key by operation.
    rws2: { method: 'GET', path: '/uas/user/grants' },
    rws1: { method: 'GET', path: '/users/grants' },
    note: '2.0 /uas/user/grants (class uas-grant, field grantname) vs 1.0 /users/grants (class user-grant, grant name in _title). Only cross-tree divergence in the domain.',
  },

  // ── User management ───────────────────────────────────────────────────────
  registerUser: {
    tier: 'niche', evidence: 'live',
    summary: 'Register this session\'s user alias, application and location (free text) as a local or remote client.',
    rws2: { method: 'POST', path: '/users/register', fields: ['application', 'username', 'location', 'ulocale'] },
    note: 'RWS 2.0 only in this client; /users/register answers 404 on RWS 1.0, where ABB documents the registration as POST /users (Rev M), not wrapped. RW 7.21.4 and 8.2.1 answered ulocale remote 201 (2026-10-21). The field is ulocale, not locale; ABB marks it required (local | remote, local only from the service or FlexPendant port; the RWS 2.0 schema types it a plain string). The client sends a given locale string as ulocale, as 1.4.0 did, and the controller decides; a 400 to a value other than local or remote is explained with ABB\'s two values. Without one it sends no ulocale, as 1.4.0 did; RW 7.21.4 and 8.2.1 refuse that with 400 (locale name is empty), explained the same way. A locale that is not a string is INVALID_ARGUMENT before sending. It changes no UAS data.',
  },
  impersonateUser: {
    tier: 'niche', evidence: 'built',
    summary: 'Act as another session\'s UAS user, given its uid (same credentials, same machine).',
    rws2: { method: 'POST', path: '/users/impersonate', fields: ['uid'] },
    note: 'RWS 2.0 only in this client; ABB\'s RWS 1.0 documents POST /users?action=impersonate (Rev M), not wrapped. Built-not-run: not yet sent to a controller.',
  },

  // ── Password ──────────────────────────────────────────────────────────────
  isPasswordChangeAllowed: {
    tier: 'niche', evidence: 'live',
    summary: 'Read whether the current user may change their password.',
    rws2: { method: 'GET', path: '/uas/user/password-change-allow' },
    note: 'RWS 2.0 only; live-verified 200 on RW7.21 and RW8.1.1. Response key not pinned - code probes password-change-allow / status / state.',
  },
  changePassword: {
    tier: 'niche', evidence: 'built',
    summary: 'Change the current user password.',
    rws2: { method: 'POST', path: '/uas/user/password', fields: ['old-password', 'new-password'] },
    note: 'RWS 2.0 only. Built-not-run. Hyphenated body fields, unlike the bare privilege / ulocale elsewhere in the domain.',
  },

  // ── UAS users and roles (reads) ───────────────────────────────────────────
  // RWS 2.0 only: the whole /uas prefix answers a bare 404 on RW 6.16.03
  // (2026-09-29). Shapes are ABB's UAS_Service Rev L examples. To the OmniCore
  // Default User (no UAS_UAS_ADMINISTRATION) on RW 7.21.4 and 8.2.1 the user
  // row, its /grants, /roles and /password-change-allow, and the role row
  // answer 200 (2026-10-01, 2026-10-09); the two listings and the /enable,
  // /description, role /grants and role /description reads answer 403
  // -1073445867 SYS_CTRL_E_UAS_REJECT. To Admin on RW 7.21.4 and 8.2.1 virtual
  // controllers the two listings and those four reads answered 200
  // (2026-10-18).
  listUasUsers: {
    tier: 'common', evidence: 'live',
    summary: 'List the UAS users defined on the controller.',
    rws2: { method: 'GET', path: '/uas/users' },
    note: 'RWS 2.0 only. Paged (?start=&limit=, rel="next"). XHTML entries class user, spans name and description (ABB example). RW 7.21.4 / 8.2.1: 403 -1073445867 for the Default User; OPTIONS 204 Allow GET,POST (2026-09-29); 200 for Admin (2026-10-18).',
  },
  getUasUser: {
    tier: 'common', evidence: 'live',
    summary: 'List the sub-resources of one UAS user.',
    rws2: { method: 'GET', path: '/uas/users/{user}' },
    note: 'RWS 2.0 only. Links only: description, password-change-allow, enable, roles, grants (classes user-*-li, ABB example). RW 7.21.4 / 8.2.1: OPTIONS on an absent name 200 Allow GET,POST,DELETE with a user-create form (2026-09-29).',
  },
  listUasUserGrants: {
    tier: 'common', evidence: 'live',
    summary: 'List the grants of one UAS user.',
    rws2: { method: 'GET', path: '/uas/users/{user}/grants' },
    note: 'RWS 2.0 only. Class uas-grant, span grantname - the same shape as /uas/user/grants (ABB example).',
  },
  listUasUserRoles: {
    tier: 'common', evidence: 'live',
    summary: 'List the roles of one UAS user.',
    rws2: { method: 'GET', path: '/uas/users/{user}/roles' },
    note: 'RWS 2.0 only. Class user-role, span rolename (ABB example).',
  },
  isUasUserEnabled: {
    tier: 'niche', evidence: 'live',
    summary: 'Read whether one UAS user is enabled.',
    rws2: { method: 'GET', path: '/uas/users/{user}/enable' },
    note: 'RWS 2.0 only. Class user-enabled, span enabled true|false (ABB example). The parent lists this resource as user-enable-li titled enable.',
  },
  getUasUserDescription: {
    tier: 'niche', evidence: 'live',
    summary: 'Read one UAS user\'s description.',
    rws2: { method: 'GET', path: '/uas/users/{user}/description' },
    note: 'RWS 2.0 only. Class user-description, span description (ABB example).',
  },
  isUasUserPasswordChangeAllowed: {
    tier: 'niche', evidence: 'live',
    summary: 'Read whether a named UAS user may change their password.',
    rws2: { method: 'GET', path: '/uas/users/{user}/password-change-allow' },
    note: 'RWS 2.0 only. Class password-change-allow, span password-change-allow true|false (ABB example). The current-user variant is isPasswordChangeAllowed.',
  },
  listUasRoles: {
    tier: 'common', evidence: 'live',
    summary: 'List the UAS roles defined on the controller.',
    rws2: { method: 'GET', path: '/uas/roles' },
    note: 'RWS 2.0 only (404 on RW 6.16.03). Paged (?start=&limit=). ABB\'s example classes the entries role-grants with spans rolename and description; its schema names user-role-li. RW 7.21.4 / 8.2.1: 403 -1073445867 for the Default User (2026-09-29); 200 for Admin (2026-10-18).',
  },
  getUasRole: {
    tier: 'niche', evidence: 'live',
    summary: 'List the sub-resources of one UAS role.',
    rws2: { method: 'GET', path: '/uas/roles/{role}' },
    note: 'RWS 2.0 only. Links only: description, grants (classes role-description-li, role-grants-li, ABB example). Role name is case sensitive.',
  },
  listUasRoleGrants: {
    tier: 'common', evidence: 'live',
    summary: 'List the grants of one UAS role.',
    rws2: { method: 'GET', path: '/uas/roles/{role}/grants' },
    note: 'RWS 2.0 only. Class uas-grant, but the span is grant here, not grantname as on the user resources (ABB example).',
  },
  getUasRoleDescription: {
    tier: 'niche', evidence: 'live',
    summary: 'Read one UAS role\'s description.',
    rws2: { method: 'GET', path: '/uas/roles/{role}/description' },
    note: 'RWS 2.0 only. Span description. ABB\'s example classes it role-description; RW 7.21.4 and 8.2.1 answer group-description (2026-10-18). Both are read.',
  },

  // ── LDAP ──────────────────────────────────────────────────────────────────
  listLdapResources: {
    tier: 'niche', evidence: 'live',
    summary: 'List the LDAP configuration sub-resources.',
    rws2: { method: 'GET', path: '/uas/ldap' },
    note: 'RWS 2.0 only. Listing answers 200 for a normal user; entry classes are uas-ldap-{name}-li for enabled, searchpassword, configuration, settings, certificate, verify.',
  },
  getLdapResource: {
    tier: 'niche', evidence: 'built',
    summary: 'Read one LDAP configuration sub-resource by name.',
    rws2: { method: 'GET', path: '/uas/ldap/{name}' },
    note: 'RWS 2.0 only. Every sub-resource answers 403 SYS_CTRL_E_UAS_REJECT on both VCs (feature unlicensed); parser accepts class with and without the -li suffix. Unverified against an LDAP-licensed controller.',
  },

  // ── UAS configuration (not wrapped) ───────────────────────────────────────
  // ABB's UAS_Service Rev L documents /uas/configuration with two operations:
  // GET "Get the UAS configuration database" and PUT "Upload a new UAS
  // database to the system", which the system uses after a restart. The
  // conformance crawl's GET of it answered 2xx on RW 7.21.0 and 8.1.1
  // (2026-10-10; the body was not kept); OPTIONS
  // answered 204 Allow GET,PUT with no form on RW 7.21.4 and 8.2.1
  // (2026-09-29). The client sends neither: the UAS database is administered
  // in RobotStudio, and this client reads users, roles and grants one by one
  // above. Recorded so the conformance check sees the family as a deliberate
  // gap rather than unmapped drift.
  getUasConfiguration: {
    tier: 'niche', evidence: 'built',
    summary: 'Read the controller\'s UAS database (not wrapped).',
    rws2: { method: 'GET', path: '/uas/configuration', gap: 'returns the whole UAS configuration database (ABB, UAS service). UAS is administered in RobotStudio; this client reads users, roles and grants one by one (/uas/users, /uas/roles, /uas/grants) and does not export the database. Nothing is sent' },
    note: 'RWS 2.0 only (/uas is absent on RW6). Not wrapped, on purpose: see the gap. OPTIONS Allow GET,PUT on RW 7.21.4 and 8.2.1. The client never sends the GET; the conformance crawl\'s GET answered 2xx on RW 7.21.0 and 8.1.1 (2026-10-10; the body was not kept).',
  },
  uploadUasConfiguration: {
    tier: 'niche', evidence: 'built',
    summary: 'Upload a new UAS database, used after a restart (not wrapped).',
    rws2: { method: 'PUT', path: '/uas/configuration', gap: 'uploads a new UAS database, which the controller uses after a restart (ABB, UAS service). It replaces who may do what on the controller, which a UAS administrator decides in RobotStudio; this client does not replace UAS data. Nothing is sent' },
    note: 'RWS 2.0 only (/uas is absent on RW6). Not wrapped, on purpose: see the gap. ABB documents an application/octet-stream body with the file content; the PUT has never been sent.',
  },
};
