/**
 * Functional tests, per controller: the system operations a tool on this
 * client runs besides RAPID and motion - backup, DIPC queues, UAS reads, and
 * the controller clock and identity.
 *
 * Backup: a ZZ_PROBE backup is created in the BACKUP volume through
 * `RobotManager.createBackup`, waited for until the controller has finished
 * writing it, found through `listBackups`, and deleted again, file by file,
 * through the client. A backup is never restored, and check-restore is not
 * sent.
 *
 * DIPC: a ZZ_PROBE queue is created, a message is sent to it and read back
 * once (a read consumes it), and the queue is removed - all through
 * RobotManager.
 *
 * UAS: the grants the session's user holds, the grant catalogue, grant-exists
 * for held, missing and undefined grants, the login info, and the typed
 * refusal of a UAS-gated read. No UAS setting is changed and no UAS write is
 * sent: the client has no UAS administration write to assert a refusal with
 * (see the note after the UAS tests).
 *
 * Clock and identity: reads only. Diagnostics save is not sent.
 *
 * Expectations per build come from live reads of RW 6.16.03 (6.16.3007),
 * RW 7.21.4+417 and RW 8.2.1+1023 virtual controllers on 2026-09-29, earlier
 * live records on RW 6.16 and 7.21 (2026-08), ABB's RWS documentation and the
 * client's own doc comments; where those do not settle what a build does, the
 * test asserts only what must hold and records the observed value in the
 * lane's trace (tests titled "records ...").
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers. Every backup and queue it makes is removed in the test
 * and again in afterAll (a deferred step for the backup, the harness restore
 * for queues).
 */

import { it, expect } from 'vitest';
import { RWS1Adapter, RWS2Adapter, RwsError, type IRWSAdapter } from '../../src/index.js';
import type { FileEntry } from '../../src/types.js';
import {
  forEachController, expectRwsError, isProbeName, waitFor, waitUntil, RUN_ID, TEST_USER,
  type TestHandle,
} from './helpers/index.js';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** Controller time as RWS writes it, on RW 6.16, 7.21 and 8.2 alike: `2026-09-29 T 15:09:37`. */
const CTRL_TIME = /^(\d{4})-(\d{2})-(\d{2}) T (\d{2}):(\d{2}):(\d{2})$/;

/** A short, run-unique suffix for the names this file creates (digits of the run id). */
const RUN_TAG = RUN_ID.replace(/[^0-9A-Za-z]/g, '').slice(-8);

/** The backup this file creates, in the BACKUP volume. */
const BACKUP_NAME = `ZZ_PROBE_BK_${RUN_TAG}`;
/** The DIPC queues this file creates. */
const QUEUE_NAME = `ZZ_PROBE_Q${RUN_TAG.slice(-6)}`;
const QUEUE_NO_SIZE = `ZZ_PROBE_N${RUN_TAG.slice(-6)}`;
const DIPC_PAYLOAD = `ZZ_PROBE_msg_${RUN_TAG}`;

/**
 * ABB's backup states (Controller_Service, `GET /ctrl/backup/state`):
 * None | Init State | Backup in Progress | Backup Ready | Error during backup | Invalid.
 */
const BACKUP_BUSY = new Set(['Init State', 'Backup in Progress']);
const BACKUP_FAILED = new Set(['Error during backup', 'Invalid']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Controller local time as ms since the epoch in this PC's time zone; NaN if malformed. */
function ctrlTimeMs(s: string): number {
  const m = CTRL_TIME.exec(s.trim());
  if (!m) { return Number.NaN; }
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** The same fields read as UTC, to record the controller's offset from UTC. */
function ctrlFieldsAsUtcMs(s: string): number {
  const m = CTRL_TIME.exec(s.trim());
  if (!m) { return Number.NaN; }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** `major.minor` of a RobotWare version string (6.16.3007, 7.21.4+417, 8.2.1+1023). */
function majorMinor(rwVersion: string): [number, number] {
  const [a, b] = rwVersion.split(/[.+]/).map(Number);
  return [a, b];
}

/**
 * The OmniCore grant counts for this build: the catalogue at /uas/grants and
 * what the Default User holds at /uas/user/grants. 33 and 23 on RW 7.21.0,
 * 7.21.4 and 8.1.1; RW 8.2 adds UAS_ALLOW_REMOTE_ACCESS_IN_MAN_MODE to both
 * (34 and 24 on 8.2.1+1023). Live-verified 2026-09-27 and 2026-09-29.
 */
function omnicoreGrants(rwVersion: string): { catalogue: number; held: number; manModeGrant: boolean } {
  const [major, minor] = majorMinor(rwVersion);
  const rw82 = major > 8 || (major === 8 && minor >= 2);
  return { catalogue: rw82 ? 34 : 33, held: rw82 ? 24 : 23, manModeGrant: rw82 };
}

const MAN_MODE_GRANT = 'UAS_ALLOW_REMOTE_ACCESS_IN_MAN_MODE';

/**
 * The grants the grant-exists test checks: some the Default User holds and
 * some it does not (the RW 8.2 grant is in the catalogue on 8.2.1 only, as
 * 7.21.4 does not define it).
 */
const GRANT_EXISTS_SAMPLE: ReadonlySet<string> = new Set([
  'UAS_UAS_ADMINISTRATION', 'UAS_CFG_WRITE', 'UAS_BACKUP', 'UAS_FILE_ACCESS_READ',
  'UAS_IO_WRITE', 'UAS_REMOTE_WARMSTART', 'UAS_RAPID_EDIT', 'UAS_RAPID_EXECUTE',
  'UAS_SAFETY_SERVICES', 'UAS_REMOTE_LOGIN', 'UAS_REMOTE_START_STOP_IN_AUTO', MAN_MODE_GRANT,
]);

/** Run `fn`; a failure must be a typed RwsError, which is returned instead of thrown. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: RwsError }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (!(e instanceof RwsError)) { throw new Error(`${what} failed with a non-RwsError: ${errText(e)}`); }
    return { ok: false, error: e };
  }
}

const describeError = (e: RwsError): Record<string, unknown> => ({
  code: e.code, httpStatus: e.httpStatus, controllerCode: e.controllerCode, controllerMsg: e.controllerMsg,
  message: e.message, refusal: e.refusal?.kind,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

await forEachController('12-system-ops', ctx => {
  /** The BACKUP volume in this lane's path convention. */
  const backupVolume = ctx.generation === 'rws1' ? '$BACKUP' : 'BACKUP';
  const backupPath = `${backupVolume}/${BACKUP_NAME}`;

  /** The observer as the RWS 2.0 adapter (the UAS reads are RWS 2.0 adapter methods, not on IRWSAdapter). */
  const rws2 = async (): Promise<RWS2Adapter> => {
    const a: IRWSAdapter = await ctx.observer();
    if (!(a instanceof RWS2Adapter)) { throw new Error(`${ctx.lane}: expected an RWS2Adapter, got ${a.constructor.name}`); }
    return a;
  };

  // ── Clock and identity ─────────────────────────────────────────────────────

  it('the controller clock ticks with this PC\'s clock and reads local time', async () => {
    const m = ctx.manager;
    const first = await m.getControllerClock();
    expect(first).toMatch(CTRL_TIME);
    let second = first;
    // The clock has one-second resolution: the next distinct reading comes
    // within about a second.
    await waitUntil(async () => {
      second = await m.getControllerClock();
      return second !== first;
    }, 5000, 300, 'the controller clock to advance');
    const stepMs = ctrlTimeMs(second) - ctrlTimeMs(first);
    expect(stepMs).toBeGreaterThan(0);
    expect(stepMs).toBeLessThanOrEqual(6000);
    // A virtual controller runs on this PC's clock in the PC's time zone, not
    // UTC (live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and 8.2.1).
    const skewMs = ctrlTimeMs(second) - Date.now();
    expect(Math.abs(skewMs)).toBeLessThan(120_000);
    ctx.note('clock', {
      first, second, stepMs, skewMs,
      utcOffsetMin: Math.round((ctrlFieldsAsUtcMs(second) - Date.now()) / 60_000),
    });
  });

  it('reads the same identity twice, naming a virtual controller, as the manager state holds it', async () => {
    const a = await ctx.observer();
    const one = await a.getControllerIdentity();
    const two = await a.getControllerIdentity();
    expect(two).toEqual(one);
    // `Virtual Controller` (XHTML, RWS 1.0 JSON) or `VIRTUAL_CONTROLLER`
    // (RWS 2.0 hal+json), live-verified 2026-09-29.
    expect(one.type.replace(/_/g, ' ')).toMatch(/^virtual controller$/i);
    expect(one.name).not.toBe('');
    const m = ctx.manager;
    await waitUntil(() => m.state.identity !== null, 15000, 250, 'manager identity');
    expect(m.state.identity).toEqual(one);
  });

  // ── UAS ────────────────────────────────────────────────────────────────────

  if (ctx.generation === 'rws1') {
    it('lists the held grants at /users/grants: UAS_FULL_ACCESS twice and UAS_UAS_ADMINISTRATION included', async () => {
      const a = await ctx.observer();
      expect(a).toBeInstanceOf(RWS1Adapter);
      const held = await (a as RWS1Adapter).listCurrentUserGrants();
      ctx.note('held grants (RWS 1.0)', { count: held.length, held });
      // RWS 1.0 lists the grants at /users/grants, by title; the adapter keeps
      // the controller's duplicate entry (live-verified 2026-09-27 on RW 6.16
      // and 2026-09-29 on 6.16.03).
      expect(held.filter(g => g === 'UAS_FULL_ACCESS')).toHaveLength(2);
      expect(held).toContain('UAS_UAS_ADMINISTRATION');
      // The 6.16 Default User lacks the three safety-service grants and the
      // key-less mode selector (live-verified 2026-09-29 on 6.16.03).
      for (const g of ['UAS_SAFETY_SERVICES', 'UAS_SAFETY_SYNCHRONIZATION', 'UAS_SAFETY_COMMISSIONING_MODE', 'UAS_KL_MODE_SELECTOR']) {
        expect(held).not.toContain(g);
      }
      const [major, minor] = majorMinor(ctx.rwVersion);
      if (major === 6 && minor === 16) {
        // 26 entries on RW 6.16 (live-verified 2026-09-27 and 2026-09-29).
        expect(held).toHaveLength(26);
      }
    });

    it('has no grant catalogue, grant-exists or login-info read on RWS 1.0', async () => {
      // The /uas tree and /users/grant-exists are unrouted on RW 6.16.03 (bare
      // 404 and 404 -1073414146, live-verified 2026-09-29); /users/login-info
      // is 404 on RW 6.16. The RWS 1.0 adapter offers none of these reads.
      const a = await ctx.observer();
      for (const method of ['listAllGrants', 'checkGrantExists', 'getLoginInfo', 'getLdapResource']) {
        expect(method in a, method).toBe(false);
      }
    });
  } else {
    it('lists the grants this user holds: the build\'s count, without UAS_UAS_ADMINISTRATION or remote start/stop in Auto', async () => {
      const a = await rws2();
      const held = await a.listCurrentUserGrants();
      const want = omnicoreGrants(ctx.rwVersion);
      ctx.note('held grants', { count: held.length, held, holdsBackup: held.includes('UAS_BACKUP') });
      expect(held).toHaveLength(want.held);
      expect(new Set(held).size).toBe(held.length);
      for (const g of ['UAS_RAPID_EXECUTE', 'UAS_REMOTE_WARMSTART', 'UAS_SYSTEM_ADMINISTRATION']) {
        expect(held).toContain(g);
      }
      // Not held by the OmniCore Default User (live-verified 2026-09-27 on RW
      // 7.21 and 8.1.1, 2026-09-29 on 7.21.4 and 8.2.1).
      expect(held).not.toContain('UAS_UAS_ADMINISTRATION');
      expect(held).not.toContain('UAS_REMOTE_START_STOP_IN_AUTO');
      if (want.manModeGrant) { expect(held).toContain(MAN_MODE_GRANT); } else { expect(held).not.toContain(MAN_MODE_GRANT); }
    });

    it('lists the grant catalogue: the build\'s count, and every held grant is defined', async () => {
      const a = await rws2();
      const catalogue = await a.listAllGrants();
      const held = await a.listCurrentUserGrants();
      const want = omnicoreGrants(ctx.rwVersion);
      ctx.note('grant catalogue', { count: catalogue.length, names: catalogue.map(g => g.name) });
      expect(catalogue).toHaveLength(want.catalogue);
      const names = catalogue.map(g => g.name);
      expect(new Set(names).size).toBe(names.length);
      for (const g of catalogue) { expect(g.name).toMatch(/^UAS_[A-Z0-9_]+$/); }
      for (const g of held) { expect(names).toContain(g); }
      expect(names).toContain('UAS_UAS_ADMINISTRATION');
      if (want.manModeGrant) { expect(names).toContain(MAN_MODE_GRANT); } else { expect(names).not.toContain(MAN_MODE_GRANT); }
    });

    it('grant-exists agrees with the held-grant list for every sampled grant in the catalogue', async () => {
      const a = await rws2();
      const held = new Set(await a.listCurrentUserGrants());
      const catalogue = (await a.listAllGrants()).map(g => g.name);
      expect(catalogue.length).toBeGreaterThan(0);
      const disagree: string[] = [];
      for (const g of catalogue.filter(n => GRANT_EXISTS_SAMPLE.has(n))) {
        const exists = await a.checkGrantExists(g);
        if (exists !== held.has(g)) { disagree.push(`${g}: grant-exists ${exists}, held ${held.has(g)}`); }
      }
      // Both reads agree on RW 7.21 and 8.2.1 over hal+json (live-verified
      // 2026-09-27 and 2026-09-29): grant-exists reads true for UAS_RAPID_EXECUTE,
      // UAS_REMOTE_WARMSTART and UAS_REMOTE_LOGIN, false for
      // UAS_UAS_ADMINISTRATION and UAS_REMOTE_START_STOP_IN_AUTO.
      expect(disagree).toEqual([]);
      expect(await a.checkGrantExists('UAS_UAS_ADMINISTRATION')).toBe(false);
      expect(await a.checkGrantExists('UAS_REMOTE_START_STOP_IN_AUTO')).toBe(false);
      expect(await a.checkGrantExists('UAS_REMOTE_LOGIN')).toBe(true);
    });

    it('grant-exists refuses a grant name this build does not define with INVALID_ARGUMENT (400 -1073445827)', async () => {
      const a = await rws2();
      // An undefined name is refused, not answered false (live-verified
      // 2026-09-29 on RW 7.21.4 and 8.2.1): 400 -1073445827
      // SYS_CTRL_E_INVALID_GRANT, icode -779.
      const undefinedNames = ['UAS_ZZ_PROBE_NO_SUCH_GRANT'];
      // RW 7.21.4 does not define the RW 8.2 grant and refuses it the same way.
      if (!omnicoreGrants(ctx.rwVersion).manModeGrant) { undefinedNames.push(MAN_MODE_GRANT); }
      for (const name of undefinedNames) {
        const e = await expectRwsError(() => a.checkGrantExists(name));
        ctx.note(`grant-exists ${name}`, describeError(e));
        expect(e.code).toBe('INVALID_ARGUMENT');
        expect(e.httpStatus).toBe(400);
        expect(e.controllerCode).toBe(-1073445827);
        expect(e.refusal?.kind).toBe('invalid-argument');
        expect(e.refusal?.sentence).toContain(name);
      }
      if (omnicoreGrants(ctx.rwVersion).manModeGrant) {
        // RW 8.2.1 defines it and the Default User holds it.
        expect(await a.checkGrantExists(MAN_MODE_GRANT)).toBe(true);
      }
    });

    it('login info names this user as a remote user on the loopback network', async () => {
      const info = await (await rws2()).getLoginInfo();
      ctx.note('login info', info);
      // Live-verified 2026-09-27 and 2026-09-29 on RW 7.21.4 and 8.2.1:
      // user-locale REMOTE, user-network-locality LOOPBACK, a numeric uas-id.
      expect(info['user-name']).toBe(TEST_USER);
      expect(info['user-locale']).toBe('REMOTE');
      expect(info['user-network-locality']).toBe('LOOPBACK');
      expect(info['uas-id']).toMatch(/^\d+$/);
    });

    it('a UAS-gated read (the LDAP configuration) is refused with GRANT_DENIED (403 -1073445867) and explained', async () => {
      const a = await rws2();
      // Every /uas/ldap/* read answers 403 -1073445867 SYS_CTRL_E_UAS_REJECT
      // ("The user is not allowed access", trailer -757) to the Default User,
      // as /uas/users and /uas/roles do (live-verified 2026-09-29 on RW 7.21.4
      // and 8.2.1). The listing itself answers 200.
      const listed = await a.listLdapResources();
      ctx.note('LDAP resources listed', listed);
      expect(listed.length).toBeGreaterThan(0);
      const e = await expectRwsError(() => a.getLdapResource('configuration'));
      ctx.note('LDAP configuration read', describeError(e));
      expect(e.code).toBe('GRANT_DENIED');
      expect(e.httpStatus).toBe(403);
      expect(e.controllerCode).toBe(-1073445867);
      expect(e.refusal?.kind).toBe('grant-missing');
      expect(e.refusal?.grantor).toBe('uas-administrator');
      expect(e.refusal?.sentence).toMatch(/not allowed/i);
    });
  }

  // No test sends a UAS administration write (a user or role created, edited
  // or deleted): the client has no such call, which the unit suite asserts
  // for both adapters and RobotManager (tests/IRWSAdapter.shape.test.ts). Its
  // UAS writes are registerUser and impersonateUser, which ABB documents with
  // no grant prerequisite, and changePassword, which would change the shared
  // account's password if the controller accepted it, so none of them can
  // stand in for one. That the OmniCore Default User lacks the grant ABB
  // requires for one (UAS_UAS_ADMINISTRATION) is asserted above, by the
  // held-grant list and by grant-exists. A placeholder test here only skipped
  // on every lane (until 1.5.1).

  // ── DIPC ───────────────────────────────────────────────────────────────────

  /**
   * DIPC create, send and read through this client were live-verified on
   * RW 7.21 only (2026-08-03: create 201, send 204, GET read). On RW8 no DIPC
   * write has been observed, and the RWS 1.0 adapter's create, send and read
   * forms are not ABB's documented ones, so there each step is recorded.
   */
  const dipcEstablished = ctx.lane === 'rw7';
  let queueCreated = false;
  let queueFailure: string | null = null;

  const requireQueue = (t: TestHandle): void => {
    if (!queueCreated) { ctx.skip(t, `no DIPC queue: ${queueFailure ?? 'the create test did not run'}`); }
  };

  const queueListed = async (name: string): Promise<boolean> =>
    (await ctx.manager.listDipcQueues()).some(q => q.name === name);

  it(dipcEstablished
    ? 'creates a ZZ_PROBE DIPC queue with a size and lists it'
    : 'records whether this build creates a ZZ_PROBE DIPC queue through the client', async t => {
    await ctx.requireAllowed(t, 'dipc');
    const m = ctx.manager;
    const before = await m.listDipcQueues();
    ctx.note('DIPC queues before', before);
    expect(before.some(q => q.name === QUEUE_NAME)).toBe(false);

    // ABB: dipc-queue-size 1-32767 (required), dipc-max-msg-size 1-448 on
    // RWS 2.0 and 1-444 on RWS 1.0 (the controllers' own forms, 2026-09-29).
    const created = await attempt('createDipcQueue', () => m.createDipcQueue(QUEUE_NAME, { maxmessages: 10, maxsize: 400 }));
    if (!created.ok) {
      queueFailure = `createDipcQueue was refused: ${created.error.code} ${created.error.message}`;
      ctx.note('DIPC create refused', describeError(created.error));
      if (dipcEstablished) { throw created.error; }
      return;
    }
    const listed = await waitFor(() => queueListed(QUEUE_NAME), 5000, 250);
    ctx.note('DIPC create', { listed });
    if (dipcEstablished) {
      expect(listed).toBe(true);
    } else if (!listed) {
      queueFailure = 'createDipcQueue resolved but the queue was not listed within 5 s';
      return;
    }
    queueCreated = true;
    const a = await ctx.observer();
    if (a instanceof RWS2Adapter) {
      const info = await a.getDipcQueueInfo(QUEUE_NAME);
      ctx.note('DIPC queue information', info);
      expect(info).not.toBeNull();
    }
  });

  it(dipcEstablished
    ? 'sends a string message and reads it back once; the read consumes it'
    : 'records whether a message sent to the ZZ_PROBE queue reads back through the client', async t => {
    requireQueue(t);
    const m = ctx.manager;
    const sent = await attempt('sendDipcMessage', () => m.sendDipcMessage(QUEUE_NAME, DIPC_PAYLOAD, 'string'));
    if (!sent.ok) {
      ctx.note('DIPC send refused', describeError(sent.error));
      if (dipcEstablished) { throw sent.error; }
      return;
    }
    // The client returns null for an empty queue and for any read error, so
    // a message that never arrives shows as the deadline passing.
    const read: { msg: { payload: string; type: string } | null } = { msg: null };
    const got = await waitFor(async () => {
      read.msg = await m.readDipcMessage(QUEUE_NAME, 0);
      return read.msg !== null;
    }, 5000, 250);
    ctx.note('DIPC read', { got, msg: read.msg });
    if (!dipcEstablished && !got) { return; }
    expect(got, 'a message read back within 5 s').toBe(true);
    expect(read.msg!.payload.replace(/^"|"$/g, '')).toBe(DIPC_PAYLOAD);
    // ABB: a message is removed from the queue when it is read.
    const again = await m.readDipcMessage(QUEUE_NAME, 0);
    ctx.note('DIPC read after the message was consumed', { again });
    expect(again).toBeNull();
  });

  it('removes the ZZ_PROBE DIPC queue; it is no longer listed', async t => {
    requireQueue(t);
    const removed = await attempt('removeDipcQueue', () => ctx.manager.removeDipcQueue(QUEUE_NAME));
    if (!removed.ok) { ctx.note('DIPC remove refused', describeError(removed.error)); throw removed.error; }
    // The RWS 1.0 adapter does not check the DELETE's status, so the listing
    // is the evidence on every lane.
    const gone = await waitFor(async () => !(await queueListed(QUEUE_NAME)), 5000, 250);
    expect(gone, `${QUEUE_NAME} is still listed after removeDipcQueue resolved`).toBe(true);
    queueCreated = false;
  });

  if (ctx.generation === 'rws2') {
    it('records whether a queue is created without a size (the client sends dipc-queue-size only with maxmessages)', async t => {
      await ctx.requireAllowed(t, 'dipc');
      const m = ctx.manager;
      // ABB marks dipc-queue-size required; the RWS 2.0 client leaves it out
      // when no maxmessages is given. The harness restore removes the queue
      // if this test stops before it does.
      const created = await attempt('createDipcQueue without a size', () => m.createDipcQueue(QUEUE_NO_SIZE));
      if (!created.ok) {
        ctx.note('DIPC create without a size refused', describeError(created.error));
        expect(await queueListed(QUEUE_NO_SIZE)).toBe(false);
        return;
      }
      const listed = await waitFor(() => queueListed(QUEUE_NO_SIZE), 5000, 250);
      ctx.note('DIPC create without a size accepted', { listed });
      if (listed) {
        await m.removeDipcQueue(QUEUE_NO_SIZE);
        expect(await waitFor(async () => !(await queueListed(QUEUE_NO_SIZE)), 5000, 250)).toBe(true);
      }
    });
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

  /**
   * Backup create answered 202 on RW 6.16 and 7.21 with a fileservice URI,
   * which the client sends (records of 2026-08). On RW8 no backup has been
   * created over RWS; ABB's RW8 page lists no write access for it, so there
   * the outcome is recorded.
   */
  const backupEstablished = ctx.lane !== 'rw8';
  let backupCreated = false;
  let backupFailure: string | null = null;

  const requireBackup = (t: TestHandle): void => {
    if (!backupCreated) { ctx.skip(t, `no ZZ_PROBE backup: ${backupFailure ?? 'the create test did not run'}`); }
  };

  /** Delete a controller path under BACKUP/ZZ_PROBE..., emptying directories first. */
  const deleteTree = async (
    path: string, type: FileEntry['type'], out: { files: number; dirs: number; failed: string[] }, depth = 0,
  ): Promise<void> => {
    const top = path.slice(backupVolume.length + 1).split('/')[0];
    if (!path.startsWith(`${backupVolume}/`) || !isProbeName(top)) {
      throw new Error(`refusing to delete ${path}: only ${backupVolume}/ZZ_PROBE... is this file's to delete`);
    }
    const m = await ctx.ensureManager();
    if (type === 'dir' && depth < 12) {
      let children: FileEntry[] = [];
      try { children = await m.listDirectory(path); } catch (e) { out.failed.push(`list ${path}: ${errText(e)}`); }
      for (const c of children) { await deleteTree(`${path}/${c.name}`, c.type, out, depth + 1); }
    }
    try {
      await m.deleteControllerFile(path);
      if (type === 'dir') { out.dirs++; } else { out.files++; }
    } catch (e) {
      out.failed.push(`delete ${path}: ${errText(e)}`);
    }
  };

  /** Every ZZ_PROBE entry at the top of the BACKUP volume. */
  const probeBackups = async (): Promise<FileEntry[]> =>
    (await (await ctx.ensureManager()).listDirectory(backupVolume)).filter(e => isProbeName(e.name));

  /** Delete every ZZ_PROBE backup; throws naming what is left. */
  const deleteProbeBackups = async (): Promise<{ files: number; dirs: number; failed: string[] }> => {
    const out = { files: 0, dirs: 0, failed: [] as string[] };
    for (const e of await probeBackups()) { await deleteTree(`${backupVolume}/${e.name}`, e.type, out); }
    const left = (await probeBackups()).map(e => e.name);
    if (left.length) { throw new Error(`ZZ_PROBE backups left in ${backupVolume}: ${left.join(', ')} (${out.failed.join('; ')})`); }
    return out;
  };

  /** The top level of the backup and one level below it, as a comparable signature. */
  const backupShape = async (): Promise<{ top: string[]; signature: string }> => {
    const m = ctx.manager;
    const top = await m.listDirectory(backupPath);
    const parts: string[] = [];
    for (const e of [...top].sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.type === 'dir') {
        const inner = await m.listDirectory(`${backupPath}/${e.name}`);
        parts.push(`${e.name}/[${inner.map(i => `${i.name}:${i.size ?? ''}`).sort().join(',')}]`);
      } else {
        parts.push(`${e.name}:${e.size ?? ''}`);
      }
    }
    return { top: top.map(e => e.name), signature: parts.join('|') };
  };

  it(backupEstablished
    ? 'creates a ZZ_PROBE backup in BACKUP and the controller finishes writing it'
    : 'records whether this build creates a ZZ_PROBE backup without control-station write access', async t => {
    await ctx.requireAllowed(t, 'backup');
    const m = ctx.manager;
    // A backup left by an earlier run that stopped is removed first.
    const leftovers = await probeBackups();
    if (leftovers.length) {
      ctx.note('ZZ_PROBE backups left by an earlier run - deleting them', leftovers.map(e => e.name));
      await deleteProbeBackups();
    }
    ctx.defer('delete ZZ_PROBE backups', async () => { await deleteProbeBackups(); });
    const statusBefore = await m.getBackupStatus();
    const a = await ctx.observer();
    const stateBefore = a instanceof RWS2Adapter ? await a.getBackupState() : null;

    const created = await attempt('createBackup', () => m.createBackup(BACKUP_NAME));
    if (!created.ok) {
      backupFailure = `createBackup was refused: ${created.error.code} ${created.error.message}`;
      ctx.note('backup create refused', describeError(created.error));
      if (backupEstablished) { throw created.error; }
      return;
    }

    // Finished means: the backup directory is there, RWS 2.0 no longer reports
    // a backup in progress, and two readings of its first two levels, taken
    // 1.5 s apart, are the same. (The client's getBackupStatus reads fields
    // the controllers do not send, and the /progress id of the 202 is not
    // returned by createBackup, so neither can say it finished.)
    const seen = { last: '', top: [] as string[], state: null as string | null, failed: false };
    await waitUntil(async () => {
      if (a instanceof RWS2Adapter) {
        seen.state = await (await rws2()).getBackupState();
        if (BACKUP_FAILED.has(seen.state)) { seen.failed = true; return true; }
        if (BACKUP_BUSY.has(seen.state)) { return false; }
      }
      const shape = await backupShape();
      const same = shape.signature !== '' && shape.signature === seen.last;
      seen.last = shape.signature;
      seen.top = shape.top;
      return same;
    }, 110_000, 1500, `backup ${BACKUP_NAME} finished`);
    // Whatever was written is deleted by the following tests and the deferred step.
    backupCreated = (await m.listDirectory(backupVolume)).some(e => e.name === BACKUP_NAME);
    if (seen.failed) { throw new Error(`the controller reports the backup state "${seen.state}" for ${BACKUP_NAME}`); }

    const statusAfter = await m.getBackupStatus();
    ctx.note('backup created', {
      name: BACKUP_NAME, top: seen.top, stateBefore, stateAfter: seen.state, statusBefore, statusAfter,
    });
    expect(backupCreated).toBe(true);
    // A controller backup carries its identification (BACKINFO) and system
    // parameters (SYSPAR) at the top, next to HOME and RAPID (ABB operating
    // manuals, IRC5 and OmniCore).
    const top = seen.top.map(n => n.toUpperCase());
    expect(top).toContain('BACKINFO');
    expect(top).toContain('SYSPAR');
    if (seen.state !== null) { expect(seen.state).toBe('Backup Ready'); }
  }, 170_000);

  it('lists the ZZ_PROBE backup through listBackups, as a directory in BACKUP', async t => {
    requireBackup(t);
    const m = ctx.manager;
    const backups = await m.listBackups();
    ctx.note('backups', backups.map(b => b.name));
    expect(backups.map(b => b.name)).toContain(BACKUP_NAME);
    const entry = (await m.listDirectory(backupVolume)).find(e => e.name === BACKUP_NAME);
    expect(entry?.type).toBe('dir');
  });

  it('deletes the ZZ_PROBE backup through the client; it is no longer listed', async t => {
    requireBackup(t);
    const out = { files: 0, dirs: 0, failed: [] as string[] };
    await deleteTree(backupPath, 'dir', out);
    ctx.note('backup deleted', out);
    expect(out.failed).toEqual([]);
    expect(out.files).toBeGreaterThan(0);
    const m = ctx.manager;
    expect((await m.listDirectory(backupVolume)).some(e => e.name === BACKUP_NAME)).toBe(false);
    expect((await m.listBackups()).some(b => b.name === BACKUP_NAME)).toBe(false);
    backupCreated = false;
  }, 170_000);
});
