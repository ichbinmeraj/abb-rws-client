import { USERS_UAS } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import { type UserRegistration } from '../types.js';
import { parse } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * Users / UAS domain (`/users`, `/uas`): registration, impersonation, password.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function usersOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    /**
     * Register this application as an RWS user session.
     * POST /users/register, form fields `application`, `username`, `location`,
     * `ulocale` (live-read 2026-08-09).
     */
    async registerUser(reg: UserRegistration): Promise<void> {
      const body: Record<string, string> = {
        application: reg.application,
        username:    reg.username,
        location:    reg.location,
      };
      if (reg.locale !== undefined) { body['ulocale'] = reg.locale; }
      await this.req('POST', buildPath(USERS_UAS.registerUser.rws2 as PathSpec), body);
    }

    /**
     * Impersonate another UAS user. POST /users/impersonate, form field `uid`
     * (live-read 2026-08-09).
     *
     * Implemented from the live form but NEVER executed against the VCs - UAS
     * mutation is barred by the endpoint-completion loop's hard rules. Treat as
     * unverified at runtime.
     */
    async impersonateUser(uid: string): Promise<void> {
      await this.req('POST', buildPath(USERS_UAS.impersonateUser.rws2 as PathSpec), { uid });
    }

    /**
     * Whether the current user may change their own password.
     * GET /uas/user/password-change-allow - `Allow: GET`, answers 200
     * (live-verified 2026-08-09 on RW7.21 and RW8.1.1).
     */
    async isPasswordChangeAllowed(): Promise<boolean> {
      const p = parse(await this.req('GET', buildPath(USERS_UAS.isPasswordChangeAllowed.rws2 as PathSpec)));
      const v = p.get('password-change-allow') ?? p.get('status') ?? p.get('state') ?? 'false';
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
     */
    async changePassword(oldPassword: string, newPassword: string): Promise<void> {
      await this.req('POST', buildPath(USERS_UAS.changePassword.rws2 as PathSpec), {
        'old-password': oldPassword, 'new-password': newPassword,
      });
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
}

/** Guard: the mixin class must provide every UsersMethods member (never exported). */
type _UsersMethodsComplete = InstanceType<ReturnType<typeof usersOps>> extends UsersMethods ? true : never;
const _usersComplete: _UsersMethodsComplete = true;
void _usersComplete;

export function UsersOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<UsersMethods> {
  return usersOps(Base) as unknown as TBase & GConstructor<UsersMethods>;
}
