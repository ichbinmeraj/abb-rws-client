import type { Rws2Core } from './core.js';

/**
 * Constructor shape a mixin can extend. `...args: any[]` is required by the
 * TypeScript mixin pattern - the composed class inherits Rws2Core's real
 * constructor signature, so callers still see `new RwsClient2(url, user, pass)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GConstructor<T = object> = new (...args: any[]) => T;

/**
 * Base constraint for every RWS 2.0 domain mixin. Each domain module is a
 * function `(<TBase>) => class extends TBase { ...domain methods... }` that
 * composes onto `Rws2Core` (transport, connection, subscriptions, write-access).
 * The methods reach the shared machinery through `this` (protected on Rws2Core)
 * and the module-level `parse` / `requireState` / `nextPagePath` helpers.
 */
export type Rws2Base = GConstructor<Rws2Core>;
