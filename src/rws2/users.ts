import { Logger } from '../Logger.js';
import { USERS_UAS } from '../paths/index.js';
import { registrationLocale, registrationLocaleNote } from '../paths/usersUas.js';
import { withInputNote } from '../refusal.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import { RwsError, type UserRegistration } from '../types.js';
import { nextPagePath, parse, requireState } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/** A UAS user or role as the listings name it. */
type UasEntry = { name: string; description?: string };

/** Page cap for the paged UAS listings; a `next` link that never ends stops here. */
const MAX_UAS_PAGES = 50;

/**
 * Follow a paged UAS listing (`?start=&limit=`, `rel="next"`), handing each
 * page body to `collect`. A `next` link back at a page already read (the page
 * itself, or a loop of pages) ends the walk rather than reading the same
 * entries again. Stops with a `Logger.warn` at {@link MAX_UAS_PAGES}.
 */
async function readUasPages(
  get: (path: string) => Promise<string>, first: string, collect: (body: string) => void, what: string,
): Promise<void> {
  const visited = new Set<string>();
  let path = first;
  let pages = 0;
  while (path && pages < MAX_UAS_PAGES) {
    if (visited.has(path)) {
      Logger.warn(`RWS2 ${what}: the controller's next link points back at ${path}, `
        + `already read; stopping after ${pages} page(s)`);
      return;
    }
    visited.add(path);
    const body = await get(path);
    collect(body);
    path = nextPagePath(body, path);
    pages++;
  }
  if (path) {
    Logger.warn(`RWS2 ${what}: stopped after ${MAX_UAS_PAGES} pages; the list may be incomplete`);
  }
}

/**
 * A user or role name for a `{user}` / `{role}` path segment. An empty name
 * would turn `/uas/users/{user}` into the users listing, a different resource.
 * `.` and `..` pass `encodeURIComponent` unescaped, so a server that normalizes
 * dot segments could read `/uas/users/../grants` as `/uas/grants`. All of these
 * are refused before anything is sent.
 */
function requireName(name: string, what: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new RwsError(`${what}: a non-empty name is required`, 'INVALID_ARGUMENT');
  }
  if (name === '.' || name === '..') {
    throw new RwsError(`${what}: '${name}' cannot be used as a name in a path segment`, 'INVALID_ARGUMENT');
  }
  return name;
}

/** A `true` / `false` span, strictly: anything else is a parse failure, not `false`. */
function readFlag(d: Record<string, string>, field: string, what: string): boolean {
  const raw = d[field];
  const v = (raw ?? '').replace(/"/g, '').trim().toLowerCase();
  if (v === 'true') { return true; }
  if (v === 'false') { return false; }
  throw new RwsError(
    `RWS2 ${what}: ${field} was ${raw === undefined ? 'absent' : `"${raw}"`}, not true or false`,
    'PARSE_ERROR',
  );
}

/**
 * The titles of a resource's sub-resource links (`{prefix}*-li` entries), for
 * the user and role resources, which carry links only. A 200 that lists none
 * is a parse failure: ABB documents these links on every user and role.
 */
function subResources(body: string, prefix: string, what: string): string[] {
  const names = parse(body).getAllEntries()
    .filter(e => (e['_type'] ?? '').startsWith(prefix) && (e['_type'] ?? '').endsWith('-li'))
    .map(e => e['_title'] ?? '')
    .filter(Boolean);
  if (names.length === 0) {
    throw new RwsError(`RWS2 ${what}: response listed no ${prefix}*-li sub-resources`, 'PARSE_ERROR');
  }
  return names;
}

/**
 * Users / UAS domain (`/users`, `/uas`): registration, impersonation, password,
 * and the UAS user and role reads.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function usersOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    /**
     * Register this session's user alias, application and location (free
     * text to ABB) as a local or a remote client.
     * POST /users/register, form fields `application`, `username`, `location`,
     * `ulocale` (live-read 2026-08-09). ABB marks `ulocale` required, with
     * the values `local` and `remote`, and allows `local` only from the
     * service port or the FlexPendant port. A given `locale` is sent as
     * `ulocale` as it is, as in 1.4.0, and the controller decides; when the
     * controller answers 400 to a value other than `local` or `remote`,
     * the error names ABB's two values, and its refusal's next step, when
     * it carries one, is correcting the input. Without a locale the request
     * carries no `ulocale`, as in 1.4.0; RW 7.21.4 and 8.2.1 refuse that with
     * 400 "UserRegistration failed:locale name is empty", explained the same
     * way, and answered `remote` 201 (2026-10-21). It changes no UAS data. ABB's RWS
     * 1.0 documents the same registration as `POST /users`; this client has
     * no RWS 1.0 form for it.
     *
     * @throws RwsError `INVALID_ARGUMENT` when `locale` is given and is not
     *   a string, before sending; otherwise the controller's typed error.
     */
    async registerUser(reg: UserRegistration): Promise<void> {
      const ulocale = registrationLocale(reg?.locale, 'RWS2');
      const body: Record<string, string> = {
        application: reg.application,
        username:    reg.username,
        location:    reg.location,
      };
      if (ulocale !== undefined) { body['ulocale'] = ulocale; }
      try {
        await this.req('POST', buildPath(USERS_UAS.registerUser.rws2 as PathSpec), body);
      } catch (e) {
        const note = registrationLocaleNote(ulocale);
        throw note ? withInputNote(e, note) : e;
      }
    }

    /**
     * Act as another session's UAS user, given its uid: ABB allows it for a
     * user with the same credentials on the same machine. POST
     * /users/impersonate, form field `uid` (live-read 2026-08-09). ABB's RWS
     * 1.0 documents `POST /users?action=impersonate`; this client has no RWS
     * 1.0 form for it.
     *
     * Implemented from the live form and not yet sent to a controller; treat
     * it as unverified at runtime.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async impersonateUser(uid: string): Promise<void> {
      await this.req('POST', buildPath(USERS_UAS.impersonateUser.rws2 as PathSpec), { uid });
    }

    /**
     * Whether the current user may change their own password.
     * GET /uas/user/password-change-allow - `Allow: GET`, answers 200
     * (live-verified 2026-08-09 on RW7.21 and RW8.1.1).
     *
     * The value is the span `password-change-allowed`: RW 7.21.4+417 answered
     * class `password-change-allow` with `password-change-allowed: "true"` for
     * the Default User (2026-10-01). This method read only
     * `password-change-allow` before, which that answer does not carry, and so
     * reported false for a user who may change the password. The older
     * spellings are still read when the live one is absent.
     */
    async isPasswordChangeAllowed(): Promise<boolean> {
      const p = parse(await this.req('GET', buildPath(USERS_UAS.isPasswordChangeAllowed.rws2 as PathSpec)));
      const v = p.get('password-change-allowed') ?? p.get('password-change-allow') ?? p.get('status') ?? p.get('state') ?? 'false';
      return /^(true|yes|1|allowed)$/i.test(v.replace(/"/g, '').trim());
    }

    /**
     * Change the current user's password.
     * POST /uas/user/password, form fields `old-password`, `new-password`
     * (live-read 2026-08-09).
     *
     * Implemented from the live form but NEVER executed - changing a password on
     * a controller is barred by the loop's hard rules. Treat as unverified at
     * runtime.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async changePassword(oldPassword: string, newPassword: string): Promise<void> {
      await this.req('POST', buildPath(USERS_UAS.changePassword.rws2 as PathSpec), {
        'old-password': oldPassword, 'new-password': newPassword,
      });
    }

    /**
     * The UAS users defined on the controller: name and description.
     * GET /uas/users, following the controller's pages. Entries are class `user`
     * with spans `name` and `description` (ABB UAS_Service Rev L, "Get Users
     * Resources"); the name falls back to the entry title, which ABB's example
     * sets to the user name. RWS 2.0 only: RW 6.16.03 answers 404.
     *
     * ABB requires a UAS grant for this read; its RWS pages name
     * UAS_UAS_ADMINISTRATION. The OmniCore Default User lacks it: RW 7.21.4+417
     * and RW 8.2.1+1023 answer 403 -1073445867 SYS_CTRL_E_UAS_REJECT in both
     * representations (read 2026-09-29), which this throws as `GRANT_DENIED`.
     * To Admin, which holds the grant, RW 7.21.4 and 8.2.1 virtual controllers
     * answered 200 and the users were read (2026-10-18).
     *
     * @throws RwsError `GRANT_DENIED` without the grant.
     */
    async listUasUsers(): Promise<UasEntry[]> {
      const users: UasEntry[] = [];
      await readUasPages(path => this.req('GET', path), buildPath(USERS_UAS.listUasUsers.rws2 as PathSpec), body => {
        for (const u of parse(body).getAllStates('user')) {
          const name = u['name'] ?? u['_title'] ?? '';
          if (name) { users.push({ name, description: u['description'] }); }
        }
      }, 'listUasUsers');
      return users;
    }

    /**
     * The sub-resources one UAS user exposes, by title - ABB lists
     * `description`, `password-change-allow`, `enable`, `roles` and `grants`.
     * GET /uas/users/{user} (ABB UAS_Service Rev L, "Get User Properties"); the
     * resource carries links only, and the values are the per-property reads
     * below. RWS 2.0 only.
     *
     * RW 7.21.4+417 and 8.2.1+1023 answered the GET for the Default User, a
     * session without UAS administration, with those five titles (2026-10-01).
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name, before sending;
     *   `PARSE_ERROR` when a 200 lists no sub-resources; `GRANT_DENIED` on a 403.
     */
    async getUasUser(user: string): Promise<string[]> {
      const path = buildPath(USERS_UAS.getUasUser.rws2 as PathSpec, { user: requireName(user, 'getUasUser') });
      return subResources(await this.req('GET', path), 'user-', 'getUasUser');
    }

    /**
     * The grants one UAS user holds. GET /uas/users/{user}/grants, class
     * `uas-grant`, span `grantname` - the shape of the current user's
     * `/uas/user/grants`, which RW 7.21.4 and 8.2.1 serve (ABB UAS_Service Rev
     * L, "Get All Grants for an User"). RW 7.21.4+417 and 8.2.1+1023 answered
     * it for the Default User, without UAS administration, with the same grants
     * as `/uas/user/grants` (2026-10-01); ABB documents a 403 for a caller
     * without the grant. RWS 2.0 only.
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name; `GRANT_DENIED` on a 403.
     */
    async listUasUserGrants(user: string): Promise<string[]> {
      const path = buildPath(USERS_UAS.listUasUserGrants.rws2 as PathSpec, { user: requireName(user, 'listUasUserGrants') });
      const p = parse(await this.req('GET', path));
      return p.getAllStates('uas-grant').map(g => g['grantname'] ?? g['grant'] ?? '').filter(Boolean);
    }

    /**
     * The roles one UAS user belongs to. GET /uas/users/{user}/roles, class
     * `user-role`, span `rolename` (ABB UAS_Service Rev L, "Get Roles in an
     * User"). RW 7.21.4+417 and 8.2.1+1023 answered `Operator` for the Default
     * User, without UAS administration (2026-10-01). RWS 2.0 only.
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name; `GRANT_DENIED` on a 403.
     */
    async listUasUserRoles(user: string): Promise<string[]> {
      const path = buildPath(USERS_UAS.listUasUserRoles.rws2 as PathSpec, { user: requireName(user, 'listUasUserRoles') });
      const p = parse(await this.req('GET', path));
      return p.getAllStates('user-role').map(r => r['rolename'] ?? r['name'] ?? '').filter(Boolean);
    }

    /**
     * Whether one UAS user is enabled. GET /uas/users/{user}/enable, class
     * `user-enabled`, span `enabled` true|false (ABB UAS_Service Rev L, "Get
     * User Enabled"). RW 7.21.4+417 and 8.2.1+1023 refused the Default User,
     * without UAS administration, 403 `GRANT_DENIED` (2026-10-01), and read
     * Admin as enabled (virtual controllers, 2026-10-18). RWS 2.0 only.
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name; `PARSE_ERROR` when
     *   the answer is not true or false; `GRANT_DENIED` on a 403.
     */
    async isUasUserEnabled(user: string): Promise<boolean> {
      const path = buildPath(USERS_UAS.isUasUserEnabled.rws2 as PathSpec, { user: requireName(user, 'isUasUserEnabled') });
      const d = requireState(parse(await this.req('GET', path)), ['user-enabled', 'user-enable'], 'isUasUserEnabled');
      return readFlag(d, 'enabled', 'isUasUserEnabled');
    }

    /**
     * One UAS user's description. GET /uas/users/{user}/description, class
     * `user-description`, span `description` (ABB UAS_Service Rev L, "Get User
     * Description"). An empty description reads as ''. RW 7.21.4+417 and
     * 8.2.1+1023 refused the Default User, without UAS administration, 403
     * `GRANT_DENIED` (2026-10-01), and answered Admin's description (virtual
     * controllers, 2026-10-18). RWS 2.0 only.
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name; `PARSE_ERROR` when
     *   the answer carries no description entry; `GRANT_DENIED` on a 403.
     */
    async getUasUserDescription(user: string): Promise<string> {
      const path = buildPath(USERS_UAS.getUasUserDescription.rws2 as PathSpec, { user: requireName(user, 'getUasUserDescription') });
      const d = requireState(parse(await this.req('GET', path)), ['user-description'], 'getUasUserDescription');
      return d['description'] ?? '';
    }

    /**
     * Whether a named UAS user may change their password. GET
     * /uas/users/{user}/password-change-allow, class `password-change-allow`
     * (ABB UAS_Service Rev L, "Get Password Change Property"). The value is
     * the span `password-change-allowed` (true|false): RW 7.21.4+417 answered
     * the Default User's read 200 with class `password-change-allow` and
     * `password-change-allowed: "true"` (2026-10-01), to a session without UAS
     * administration. ABB's example spells the span `password-change-allow`;
     * that spelling is read when the live one is absent. RWS 2.0 only.
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name; `PARSE_ERROR` when
     *   the answer is not true or false; `GRANT_DENIED` on a 403.
     */
    async isUasUserPasswordChangeAllowed(user: string): Promise<boolean> {
      const path = buildPath(USERS_UAS.isUasUserPasswordChangeAllowed.rws2 as PathSpec, {
        user: requireName(user, 'isUasUserPasswordChangeAllowed'),
      });
      const d = requireState(parse(await this.req('GET', path)), ['password-change-allow'], 'isUasUserPasswordChangeAllowed');
      const field = d['password-change-allowed'] !== undefined ? 'password-change-allowed' : 'password-change-allow';
      return readFlag(d, field, 'isUasUserPasswordChangeAllowed');
    }

    /**
     * The UAS roles defined on the controller: name and description.
     * GET /uas/roles, following the controller's pages. ABB's example classes
     * each entry `role-grants` with spans `rolename` and `description`, and its
     * schema names `user-role-li`; both are read (ABB UAS_Service Rev L, "Get
     * Roles List"). RWS 2.0 only: RW 6.16.03 answers 404 (2026-09-29).
     *
     * The OmniCore Default User is refused: RW 7.21.4+417 and RW 8.2.1+1023
     * answer 403 -1073445867 SYS_CTRL_E_UAS_REJECT (read 2026-09-29), thrown as
     * `GRANT_DENIED`. To Admin, which holds the grant, RW 7.21.4 and 8.2.1
     * virtual controllers answered 200 and the roles were read (2026-10-18).
     *
     * @throws RwsError `GRANT_DENIED` without the UAS administration grant.
     */
    async listUasRoles(): Promise<UasEntry[]> {
      const roles: UasEntry[] = [];
      await readUasPages(path => this.req('GET', path), buildPath(USERS_UAS.listUasRoles.rws2 as PathSpec), body => {
        const p = parse(body);
        for (const r of [...p.getAllStates('role-grants'), ...p.getAllStates('user-role-li')]) {
          const name = r['rolename'] ?? r['name'] ?? '';
          if (name) { roles.push({ name, description: r['description'] }); }
        }
      }, 'listUasRoles');
      return roles;
    }

    /**
     * The sub-resources one UAS role exposes, by title - ABB lists
     * `description` and `grants`. GET /uas/roles/{role} (ABB UAS_Service Rev L,
     * "Get Role Resources"; the role name is case sensitive). RW 7.21.4+417 and
     * 8.2.1+1023 answered `description` and `grants` for the role `Operator`
     * to the Default User, without UAS administration (2026-10-01). RWS 2.0
     * only.
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name; `PARSE_ERROR` when
     *   a 200 lists no sub-resources; `GRANT_DENIED` on a 403.
     */
    async getUasRole(role: string): Promise<string[]> {
      const path = buildPath(USERS_UAS.getUasRole.rws2 as PathSpec, { role: requireName(role, 'getUasRole') });
      return subResources(await this.req('GET', path), 'role-', 'getUasRole');
    }

    /**
     * The grants a UAS role carries. GET /uas/roles/{role}/grants, class
     * `uas-grant` with span `grant` - not `grantname` as on the user resources
     * (ABB UAS_Service Rev L, "Get Grants of an Existing Role"); both spellings
     * are read. RW 7.21.4+417 and 8.2.1+1023 refused the Default User, without
     * UAS administration, 403 `GRANT_DENIED` for the role `Operator`
     * (2026-10-01), and answered Admin with the grants of the role
     * `Administrator` (virtual controllers, 2026-10-18). RWS 2.0 only.
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name; `GRANT_DENIED` on a 403.
     */
    async listUasRoleGrants(role: string): Promise<string[]> {
      const path = buildPath(USERS_UAS.listUasRoleGrants.rws2 as PathSpec, { role: requireName(role, 'listUasRoleGrants') });
      const p = parse(await this.req('GET', path));
      return p.getAllStates('uas-grant').map(g => g['grant'] ?? g['grantname'] ?? '').filter(Boolean);
    }

    /**
     * One UAS role's description. GET /uas/roles/{role}/description, span
     * `description`. ABB's example classes the entry `role-description` (ABB
     * UAS_Service Rev L, "Get Role Description"); RW 7.21.4+417 and 8.2.1+1023
     * virtual controllers class it `group-description` (2026-10-18). Both
     * classes are read. An empty description reads as ''. RW 7.21.4+417 and
     * 8.2.1+1023 refused the Default User, without UAS administration, 403
     * `GRANT_DENIED` for the role `Operator` (2026-10-01). RWS 2.0 only.
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name; `PARSE_ERROR` when
     *   the answer carries no description entry; `GRANT_DENIED` on a 403.
     */
    async getUasRoleDescription(role: string): Promise<string> {
      const path = buildPath(USERS_UAS.getUasRoleDescription.rws2 as PathSpec, { role: requireName(role, 'getUasRoleDescription') });
      const d = requireState(parse(await this.req('GET', path)), ['role-description', 'group-description'], 'getUasRoleDescription');
      return d['description'] ?? '';
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface UsersMethods {
  registerUser(reg: UserRegistration): Promise<void>;
  impersonateUser(uid: string): Promise<void>;
  isPasswordChangeAllowed(): Promise<boolean>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  listUasUsers(): Promise<Array<{ name: string; description?: string }>>;
  getUasUser(user: string): Promise<string[]>;
  listUasUserGrants(user: string): Promise<string[]>;
  listUasUserRoles(user: string): Promise<string[]>;
  isUasUserEnabled(user: string): Promise<boolean>;
  getUasUserDescription(user: string): Promise<string>;
  isUasUserPasswordChangeAllowed(user: string): Promise<boolean>;
  listUasRoles(): Promise<Array<{ name: string; description?: string }>>;
  getUasRole(role: string): Promise<string[]>;
  listUasRoleGrants(role: string): Promise<string[]>;
  getUasRoleDescription(role: string): Promise<string>;
}

/** Guard: the mixin class must provide every UsersMethods member (never exported). */
type _UsersMethodsComplete = InstanceType<ReturnType<typeof usersOps>> extends UsersMethods ? true : never;
const _usersComplete: _UsersMethodsComplete = true;
void _usersComplete;

export function UsersOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<UsersMethods> {
  return usersOps(Base) as unknown as TBase & GConstructor<UsersMethods>;
}
