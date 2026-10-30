/**
 * The operation catalogue (1.6.0): every RWS operation the client sends, by
 * one key `<domain>.<id>`, with what it does, how `RobotManager.call` reaches
 * it, its parameters in call order and the read that verifies it. The table
 * rows of `ALL_TABLES` plus the composites, the operations the client sends
 * with no row of their own (the module push, return codes, the device tree,
 * backups, controller jobs, a module's source).
 *
 * The routes, parameters and read-backs are generated
 * (scripts/gen-operations.mjs into ./generated.ts); this file shapes them
 * into the public catalogue and the types `call` is checked against.
 */
import type { IRWSAdapter } from '../IRWSAdapter.js';
import type { RobotManager } from '../RobotManager.js';
import type { RWS1Adapter } from '../RWS1Adapter.js';
import type { RwsClient2 } from '../RwsClient2.js';
import { ALL_TABLES } from '../paths/index.js';
import type { AccessKind, Effect, Tier } from '../paths/index.js';
import { RwsError } from '../types.js';
import { COMPOSITE_OPERATIONS, OPERATION_DETAILS, OPERATION_ROUTES } from './generated.js';

/** Every operation key, `<domain>.<id>`: a table row's domain and id, or a composite's. */
export type OperationKey = keyof typeof OPERATION_ROUTES;

/** An RWS generation: 1.0 (RobotWare 6) or 2.0 (RobotWare 7 and 8). */
export type OperationGeneration = 'rws1' | 'rws2';

/** One parameter, in call order. `type` is the TypeScript type as the method declares it. */
export interface OperationParam {
  readonly name: string;
  readonly optional: boolean;
  readonly type: string;
  readonly rest?: boolean;
}

/**
 * The read that verifies a write: its key, the write's parameters it takes
 * (by name, in the read's order) and the generations it covers. A write whose
 * generations are not all listed is not read back on the others.
 */
export interface OperationReadBack {
  readonly key: OperationKey;
  readonly args: readonly string[];
  readonly generations: readonly OperationGeneration[];
}

/**
 * How `RobotManager.call` reaches an operation:
 * - `manager`: the RobotManager method, so its access handling and refusals
 *   apply. `adapterMethod`
 *   is the adapter method it relies on: without it `call` refuses, where the
 *   RobotManager method would answer an empty value;
 * - `adapter`: the connected adapter's method, which takes the access it needs;
 * - `manager-by-arg`: the RobotManager method the argument at `arg` names
 *   (motors on and motors off);
 * - `none`: not callable. Access, mastership, RMMP and user rows (the client
 *   takes access around each write itself), the subscription rows (a session's
 *   own group), rows no generation has, and the operating-mode confirmation
 *   (`person`: the person's, at the FlexPendant).
 */
export type OperationRoute =
  | { readonly via: 'manager'; readonly method: string; readonly adapterMethod?: string }
  | { readonly via: 'adapter'; readonly method: string }
  | { readonly via: 'manager-by-arg'; readonly arg: number; readonly methods: Readonly<Record<string, string>>; readonly adapterMethod: string }
  | { readonly via: 'none'; readonly reason: 'access' | 'session' | 'gap' | 'person' };

/** One operation of the catalogue. */
export interface OperationInfo {
  readonly key: OperationKey;
  readonly domain: string;
  readonly id: string;
  /** A table row of `ALL_TABLES`, or a composite the client sends with no row. */
  readonly kind: 'row' | 'composite';
  readonly summary: string;
  readonly tier: Tier;
  /** read, write or session, as the table row says (see `Effect`). */
  readonly effect: Effect;
  /** The access row's kind, for the rows `call` refuses. */
  readonly access?: AccessKind;
  /** The generations the client sends it on. */
  readonly generations: readonly OperationGeneration[];
  readonly route: OperationRoute;
  readonly params: readonly OperationParam[];
  /**
   * RobotWare 8 control-station write access: `self` when the method takes it
   * itself, `call` when `RobotManager.call` takes it around the method and
   * releases it after, `none` for a read and for a write sent as a GET.
   */
  readonly rw8Access: 'self' | 'call' | 'none';
  /** The read that verifies a write, or null (every read, and a write no read verifies). */
  readonly readBack: OperationReadBack | null;
  /** A composite's rows, as the client sends them. */
  readonly sends?: readonly OperationKey[];
  /** A composite's request, where it has no row. */
  readonly wire?: string;
  readonly note?: string;
}

function build(): Readonly<Record<OperationKey, OperationInfo>> {
  const out: Record<string, OperationInfo> = {};
  const details = OPERATION_DETAILS as Record<string, { params: readonly OperationParam[]; rw8Access: OperationInfo['rw8Access']; readBack: OperationReadBack | null }>;
  const routes = OPERATION_ROUTES as Record<string, OperationRoute>;
  const freezeDeep = <T>(v: T): T => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      for (const x of Object.values(v)) { freezeDeep(x); }
      Object.freeze(v);
    }
    return v;
  };
  for (const [domain, table] of Object.entries(ALL_TABLES)) {
    for (const [id, op] of Object.entries(table)) {
      const key = `${domain}.${id}`;
      const d = details[key];
      out[key] = freezeDeep({
        key: key as OperationKey, domain, id, kind: 'row', summary: op.summary, tier: op.tier, effect: op.effect,
        ...(op.access ? { access: op.access } : {}),
        generations: (['rws1', 'rws2'] as const).filter(g => op[g] !== undefined && !op[g]?.gap),
        route: routes[key], params: d.params, rw8Access: d.rw8Access, readBack: d.readBack,
        ...(op.note ? { note: op.note } : {}),
      });
    }
  }
  for (const c of COMPOSITE_OPERATIONS) {
    const key = `${c.domain}.${c.id}`;
    const d = details[key];
    out[key] = freezeDeep({
      key: key as OperationKey, domain: c.domain, id: c.id, kind: 'composite', summary: c.summary, tier: c.tier, effect: c.effect,
      generations: [...c.generations], route: routes[key], params: d.params, rw8Access: d.rw8Access, readBack: d.readBack,
      sends: [...c.sends] as OperationKey[],
      ...('wire' in c ? { wire: c.wire } : {}),
      ...('note' in c ? { note: c.note } : {}),
    });
  }
  return Object.freeze(out) as Readonly<Record<OperationKey, OperationInfo>>;
}

/** Every operation by key, frozen. */
export const OPERATIONS: Readonly<Record<OperationKey, OperationInfo>> = build();

/** Every operation key, table rows first in table order, then the composites. */
export const OPERATION_KEYS: readonly OperationKey[] = Object.freeze(Object.keys(OPERATIONS) as OperationKey[]);

/** True when `key` is one of the operation keys. */
export function isOperationKey(key: unknown): key is OperationKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(OPERATIONS, key);
}

/**
 * The positional arguments of `key` from arguments by name, for a caller that
 * has them by name (a route's query or body). Each parameter takes the value
 * of its name; an optional one may be left out, and the list ends at the last
 * one given. Throws INVALID_ARGUMENT for an unknown key, a name the operation
 * does not take, or a required parameter left out; nothing is sent.
 */
export function operationArgs(key: OperationKey, named: Readonly<Record<string, unknown>>): unknown[] {
  if (!isOperationKey(key)) {
    throw new RwsError(`operationArgs: ${JSON.stringify(key)} is not an operation key`, 'INVALID_ARGUMENT');
  }
  const params = OPERATIONS[key].params;
  const unknown = Object.keys(named).filter(n => !params.some(p => p.name === n));
  if (unknown.length) {
    throw new RwsError(`${key}: no parameter ${unknown.join(', ')} (it takes ${params.map(p => p.name).join(', ') || 'none'})`, 'INVALID_ARGUMENT');
  }
  const out: unknown[] = [];
  let last = -1;
  params.forEach((p, i) => {
    const given = Object.prototype.hasOwnProperty.call(named, p.name) && named[p.name] !== undefined;
    if (!given && !p.optional) {
      throw new RwsError(`${key}: the parameter ${p.name} is required`, 'INVALID_ARGUMENT');
    }
    out[i] = given ? named[p.name] : undefined;
    if (given) { last = i; }
  });
  return out.slice(0, last + 1);
}

// ── Types of RobotManager.call ──────────────────────────────────────────────

type Routes = typeof OPERATION_ROUTES;
type AnyFn = (...args: never[]) => unknown;

/** An adapter method by name: IRWSAdapter's where it has one, else RwsClient2's, else RWS1Adapter's. */
type AdapterMethod<M> =
  M extends keyof IRWSAdapter ? NonNullable<IRWSAdapter[M]>
    : M extends keyof RwsClient2 ? RwsClient2[M]
      : M extends keyof RWS1Adapter ? RWS1Adapter[M]
        : never;

/** The method a route reaches. */
type RouteTarget<R> =
  R extends { readonly via: 'manager'; readonly method: infer M } ? (M extends keyof RobotManager ? RobotManager[M] : never)
    : R extends { readonly via: 'adapter'; readonly method: infer M } ? AdapterMethod<M>
      : R extends { readonly via: 'manager-by-arg'; readonly params: { readonly method: infer M } } ? AdapterMethod<M>
        : never;

type ParamsOf<F> = F extends (...args: infer A) => unknown ? A : never;
type AnswerOf<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

/** The arguments of `call(key, args)`, in the order of `OPERATIONS[key].params`. */
export type OperationArgs<K extends OperationKey> =
  Routes[K] extends { readonly via: 'none' } ? readonly unknown[] : ParamsOf<RouteTarget<Routes[K]>>;

/** What `call(key, args)` answers. */
export type OperationAnswer<K extends OperationKey> =
  Routes[K] extends { readonly via: 'none' } ? never
    : Routes[K] extends { readonly via: 'manager-by-arg' } ? void
      : AnswerOf<RouteTarget<Routes[K]>>;

/** Compile-time check: every routed key reaches a method of RobotManager or an adapter (a name that resolves to nothing is `never`). */
type Unresolved = {
  [K in OperationKey]: Routes[K] extends { readonly via: 'none' } ? never
    : [RouteTarget<Routes[K]>] extends [never] ? K
      : [RouteTarget<Routes[K]>] extends [AnyFn] ? never : K
}[OperationKey];
const _resolved: [Unresolved] extends [never] ? true : Unresolved = true;
void _resolved;

/** Compile-time check: the methods motors on and off go through are RobotManager's. */
type ByArgMethods = {
  [K in OperationKey]: Routes[K] extends { readonly via: 'manager-by-arg'; readonly methods: infer M } ? M[keyof M] : never
}[OperationKey];
const _byArg: [Exclude<ByArgMethods, keyof RobotManager>] extends [never] ? true : Exclude<ByArgMethods, keyof RobotManager> = true;
void _byArg;
