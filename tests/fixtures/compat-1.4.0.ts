/**
 * Code written against abb-rws-client 1.4.0, for the signatures that changed
 * after it: getCompatibility (called, and on an IRWSAdapter of another make
 * with the result 1.4.0's RWS1Adapter had), registerUser's locale, compressPath,
 * decompressPath and saveSystemInfo (an adapter of another make, one that
 * passes an inner adapter's promise on, and callers that pass the promise on
 * where a Promise<void> is asked for), the subscription kinds (an exhaustive
 * switch over SubscriptionResource) and getRobotType. The next release is a
 * minor one, so every line here must still compile.
 * tests/compat140.types.test.ts compiles this file against src with the
 * TypeScript compiler and expects no error. Each `@ts-expect-error` line is a
 * control: it must stay an error, so a type widened too far fails the test.
 * Nothing here runs.
 */
import type {
  IRWSAdapter, RobotManager, RWS1Adapter, RwsClient2, UserRegistration, SubscriptionResource, SubscriptionEvent,
  ControllerJobName,
} from '../../src/index.js';

// ── An IRWSAdapter of another make, as written for 1.4.0 ─────────────────────
// These three return Promise<void>, as in 1.4.0; saveSystemInfo took a
// required fileType there.

type ChangedMembers = Pick<IRWSAdapter, 'compressPath' | 'decompressPath' | 'saveSystemInfo'>;

export class OtherMake140 implements ChangedMembers {
  async compressPath(_source: string, _destination: string): Promise<void> { /* 1.4.0 */ }
  async decompressPath(_source: string, _destination: string): Promise<void> { /* 1.4.0 */ }
  async saveSystemInfo(_path: string, _fileType: string): Promise<void> { /* 1.4.0 */ }
}

export const asInterface: ChangedMembers = new OtherMake140();

/** A decorator of another make: it passes the inner adapter's promise on, as 1.4.0's own RobotManager did. */
export class Decorator140 implements ChangedMembers {
  private readonly inner: IRWSAdapter;
  constructor(inner: IRWSAdapter) { this.inner = inner; }
  async compressPath(source: string, destination: string): Promise<void> { return this.inner.compressPath!(source, destination); }
  async decompressPath(source: string, destination: string): Promise<void> { return this.inner.decompressPath!(source, destination); }
  async saveSystemInfo(path: string, fileType: string): Promise<void> { return this.inner.saveSystemInfo!(path, fileType); }
}

/** The 1.5 member: a job with its progress id, next to the 1.4.0 methods. */
export class OtherMakeNew implements Pick<IRWSAdapter, 'compressPath' | 'startJob'> {
  async compressPath(_source: string, _destination: string): Promise<void> { /* starts it */ }
  async startJob(_name: ControllerJobName, _source: string, _destination: string): Promise<string | undefined> { return 'job-1'; }
}

// ── An IRWSAdapter of another make whose subscribe handles every kind ────────
// 1.5.0 adds two subscription kinds in AnySubscriptionResource, not in
// SubscriptionResource, so an exhaustive switch written for 1.4.0 still
// compiles against IRWSAdapter.subscribe.

function pathOf140(r: SubscriptionResource): string {
  if (typeof r === 'string') { return r; }
  switch (r.type) {
    case 'signal': return r.name;
    case 'persvar': return r.name;
    case 'taskchange': return r.task;
    case 'execycle': return 'execycle';
    case 'elog': return String(r.domain);
    default: { const exhaustive: never = r; return exhaustive; }
  }
}

export class OtherMakeSubscriber implements Pick<IRWSAdapter, 'subscribe' | 'getRobotType'> {
  async subscribe(resources: SubscriptionResource[], _handler: (e: SubscriptionEvent) => void): Promise<() => Promise<void>> {
    for (const r of resources) { pathOf140(r); }
    return async () => {};
  }
  // getRobotType returned { type, variant? } in 1.4.0.
  async getRobotType(): Promise<{ type: string; variant?: string }> { return { type: 'IRB 120' }; }
}

// ── An IRWSAdapter of another make with getCompatibility, as 1.4.0's RWS1Adapter had it ──
// IRWSAdapter had no getCompatibility in 1.4.0; the RWS 1.0 adapter answered
// { compatible, details? }, and an adapter of another make may have copied it.

type Compat140 = { compatible: boolean; details?: Record<string, string> };

export class OtherMakeCompat140 implements Pick<IRWSAdapter, 'getCompatibility'> {
  async getCompatibility(): Promise<Compat140> { return { compatible: false }; }
}

export interface ExtendsAdapter140 extends IRWSAdapter {
  getCompatibility(): Promise<Compat140>;
}

export function asAdapter140(a: Omit<IRWSAdapter, 'getCompatibility'> & { getCompatibility(): Promise<Compat140> }): IRWSAdapter {
  return a;
}

/** Controls: a result other than nothing is still refused. */
export class WrongMake implements ChangedMembers {
  // @ts-expect-error compressPath returns nothing
  async compressPath(_source: string, _destination: string): Promise<number> { return 1; }
  // @ts-expect-error saveSystemInfo returns nothing
  async saveSystemInfo(_path: string, _fileType?: string): Promise<string> { return ''; }
}

/** Control: a compatibility answer with no `compatible` is still refused. */
export class WrongCompat implements Pick<IRWSAdapter, 'getCompatibility'> {
  // @ts-expect-error compatible is required
  async getCompatibility(): Promise<{ details?: Record<string, string> }> { return {}; }
}

// ── Callers, as written for 1.4.0 ─────────────────────────────────────────────

export async function callers140(
  manager: RobotManager,
  rws1: RWS1Adapter,
  rws2: RwsClient2,
  locale: string,
): Promise<void> {
  // getCompatibility took no version and returned { compatible, details? }.
  const answer: { compatible: boolean; details?: Record<string, string> } = await rws1.getCompatibility();
  const compatible: boolean = answer.compatible;
  void compatible;

  // registerUser: locale optional and typed string.
  const reg: UserRegistration = { application: 'app', username: 'user', location: 'cell 1' };
  await rws2.registerUser(reg);
  await manager.registerUser({ application: 'app', username: 'user', location: 'cell 1', locale });
  const loose = { application: 'app', username: 'user', location: 'cell 1', locale: 'remote' };
  await manager.registerUser(loose);

  // compressPath, decompressPath and saveSystemInfo: the result was ignored.
  await manager.compressPath('$HOME/a', '$HOME/a.zip');
  await manager.decompressPath('$HOME/a.zip', '$HOME/b');
  await manager.saveSystemInfo('$TEMP/info', 'FileType_RMF');
  await rws2.compressPath('$HOME/a', '$HOME/a.zip');
  await rws2.saveSystemInfo('$TEMP/info', 'FileType_RMF');
  await rws1.compressPath('$HOME/a', '$HOME/a.zip');

  // ... and passed on where a Promise<void> was asked for.
  const viaManager = async (): Promise<void> => manager.compressPath('$HOME/a', '$HOME/a.zip');
  const viaRws2 = (): Promise<void> => rws2.decompressPath('$HOME/a.zip', '$HOME/b');
  const viaRws1 = async (): Promise<void> => { return rws1.decompressPath('$HOME/a.zip', '$HOME/b'); };
  const info = async (): Promise<void> => manager.saveSystemInfo('$TEMP/info', 'FileType_RMF');
  const infoRws2 = (): Promise<void> => rws2.saveSystemInfo('$TEMP/info', 'FileType_RMF');
  const bound: (source: string, destination: string) => Promise<void> = manager.compressPath.bind(manager);
  const chained: Promise<void> = manager.decompressPath('$HOME/a.zip', '$HOME/b').then(() => manager.compressPath('$HOME/a', '$HOME/a.zip'));
  await Promise.all([viaManager(), viaRws2(), viaRws1(), info(), infoRws2(), bound('$HOME/a', '$HOME/a.zip'), chained]);

  // Subscriptions and group edits with the 1.4.0 kinds; getRobotType's type.
  const handle = await rws2.subscribe(['controllerstate', { type: 'elog', domain: 0 }], () => {});
  await manager.updateSubscriptionGroup(handle.groupPath, ['speedratio']);
  await manager.unsubscribeResource(handle.groupPath, 'speedratio');
  await rws1.subscribe([{ type: 'signal', name: 'di1' }], () => {});
  const robot: { type: string; variant?: string } = await manager.getRobotType();
  void robot;

  // Control: a locale that is not a string is still refused.
  // @ts-expect-error locale is a string
  await manager.registerUser({ application: 'app', username: 'user', location: 'cell 1', locale: 1 });
}

/** The 1.5 calls: a version, and the new results. */
export async function callersNew(manager: RobotManager, rws2: RwsClient2): Promise<void> {
  const handle = await rws2.subscribe([{ type: 'mastership', domain: 'motion' }, { type: 'motionerrorstate' }], () => {});
  await manager.updateSubscriptionGroup(handle.groupPath, [{ type: 'motionerrorstate' }]);
  // Control: IRWSAdapter.subscribe keeps the 1.4.0 kinds.
  const adapter = manager as unknown as IRWSAdapter;
  // @ts-expect-error the 1.5.0 kinds are not SubscriptionResource
  await adapter.subscribe([{ type: 'motionerrorstate' }], () => {});
  const r = await rws2.getCompatibility('7.16');
  const status: string = r.status;
  void status;
  const own = await manager.getCompatibility();
  void own.details;
  const id: string | undefined = await manager.startJob('compressPath', '$HOME/a', '$HOME/a.zip');
  const again: string | undefined = await rws2.startJob('decompressPath', '$HOME/a.zip', '$HOME/b');
  void id; void again;
  await manager.saveSystemInfo('$TEMP/info');
  // Control: compressPath returns nothing, as in 1.4.0.
  // @ts-expect-error the progress id comes from startJob
  const notAnId: string = await manager.compressPath('$HOME/a', '$HOME/a.zip');
  void notAnId;
  // Control: only the jobs startJob starts.
  // @ts-expect-error createBackup is not one of them
  await manager.startJob('createBackup', '$HOME/a', '$HOME/b');
}
