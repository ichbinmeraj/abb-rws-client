/**
 * Functional tests, per controller: the operations added or corrected on
 * 2026-10-01 that are safe to send to a live controller, each one read back
 * (a value checked against another read, a list, or a typed refusal), never
 * only "the call returned".
 *
 * Both generations (RobotManager, the consumer path):
 * - common reads: getRapidTask, getCfgType, listCfgTypeAttributes,
 *   getDipcQueueInfo (on a ZZ_PROBE queue holding one message, which must
 *   still be there afterwards), getIoNetwork, getIoDeviceInfo,
 *   listModuleRoutines (of a ZZ_PROBE module with one PROC, FUNC and TRAP),
 *   getFileMetadata (of a ZZ_PROBE file, against the directory listing);
 * - niche reads: listSubscriptionGroups and getSubscriptionGroup (the
 *   manager's own group), motion and path supervision, SMB data, motor
 *   calibration names, lead-through state;
 * - getMechunitPjoints, listBreakpoints, validateRapidValue,
 *   validateCfgFile (a dry run of a ZZ_PROBE .cfg file in TEMP; nothing is
 *   loaded, which is read back);
 * - writes inside the envelope: updateSubscriptionGroup on a group of the
 *   test's own session (deleted again), and setMechunitForJogging selecting
 *   the unit the controller already has selected (read back before and
 *   after; a different unit is never selected).
 *
 * RWS 2.0 only (OmniCore; not declared on the RWS 1.0 lane): the safety
 * configuration and its change count, a controller feature by id, a
 * mechanical unit's calibration resources, the module sub-resources
 * (mod-possible, symbol, attributes, object), and the UAS user and role
 * reads, which the OmniCore Default User is expected to be refused
 * (GRANT_DENIED) where it lacks UAS administration.
 *
 * Added 2026-10-03: the I/O configuration reads on both generations
 * (getSignalConfig, getIoNetworkConfig, getIoDeviceConfig; RWS 1.0 reads
 * them as `?resource=config`), each checked against the signal read or the
 * network and device lists; and on RWS 2.0 the task motion sub-reads
 * (getTaskMechunits, getTaskJointTarget, getTaskRobTarget,
 * getTaskExtJointState), each checked against the motion system's own read
 * of the same unit. The RWS 1.0 operating-mode acknowledge is not sent: it
 * is the person's confirmation at the FlexPendant.
 *
 * Not sent (they change a program, a breakpoint, the program pointer or a
 * backup check): setBreakpoint, removeBreakpoint, setPPToCursor,
 * setModuleText, setModuleTextRange, ppPrevInst, ppNextInst, checkRestore.
 *
 * Where a read fails, the test reads the same resource once more on the
 * session's own cookie and writes the raw answer to the lane's trace, so a
 * parse failure can be judged from the trace alone.
 *
 * Runs only under `npm run functional` (RWS_FUNCTIONAL=1), against local
 * virtual controllers. Every module, file and queue it makes is named
 * ZZ_PROBE and removed in the test and again by the harness restore.
 */

import http from 'node:http';
import https from 'node:https';
import { it, expect } from 'vitest';
import { RWS2Adapter, RwsError, isJointValuePresent, type IRWSAdapter, type RobotManager } from '../../src/index.js';
import { ALL_TABLES, buildPath, type PathSpec } from '../../src/paths/index.js';
import {
  forEachController, assertLocalhost, describeError, diffSnapshots, expectRwsError, waitFor, waitUntil,
  RUN_ID, TEST_USER,
  type FunctionalContext, type TestHandle,
} from './helpers/index.js';

const FILE = '15-new-operations';

// ─── Names ───────────────────────────────────────────────────────────────────

/** A short, run-unique suffix for the names this file creates. */
const RUN_TAG = RUN_ID.replace(/[^0-9A-Za-z]/g, '').slice(-8);

/** The RAPID module this file loads (one PERS, one PROC, one FUNC, one TRAP). */
const MODULE = 'ZZ_PROBE_NEWOPS';
const SYM = MODULE.toLowerCase();
const ROUTINES = { proc: `${SYM}_proc`, func: `${SYM}_func`, trap: `${SYM}_trap` } as const;
const MODULE_TEXT = [
  `MODULE ${MODULE}`,
  `  PERS num ${SYM}_num := 7;`,
  `  PROC ${ROUTINES.proc}()`,
  `    ${SYM}_num := ${SYM}_num + 1;`,
  '  ENDPROC',
  `  FUNC num ${ROUTINES.func}(num x)`,
  '    RETURN x + 1;',
  '  ENDFUNC',
  `  TRAP ${ROUTINES.trap}`,
  `    ${SYM}_num := 0;`,
  '  ENDTRAP',
  'ENDMODULE',
  '',
].join('\n');

/** The DIPC queue (16 characters, like the other suites' queues). */
const QUEUE = `ZZ_PROBE_D${RUN_TAG.slice(-6)}`;
const QUEUE_ABSENT = 'ZZ_PROBE_NOQUEUE';
const DIPC_PAYLOAD = `ZZ_PROBE_newops_${RUN_TAG}`;

/** The file whose metadata is read, in TEMP. */
const META_FILE = `ZZ_PROBE_META_${RUN_TAG}.txt`;
const META_TEXT = 'ZZ_PROBE metadata probe, ASCII only\n';

/** The configuration files validated (never loaded), in TEMP. */
const CFG_GOOD = `ZZ_PROBE_VAL_${RUN_TAG}.cfg`;
const CFG_BAD = `ZZ_PROBE_BAD_${RUN_TAG}.cfg`;
const CFG_SIGNAL = 'ZZ_PROBE_VAL_DI';

/** The six resources `RobotManager` subscribes on connect. */
const MANAGER_RESOURCES = ['controllerstate', 'operationmode', 'speedratio', 'execution', 'coldetstate', 'elog'] as const;

/** A built-in network and one of its devices per build (listed live on 2026-09-29). */
const IO_TARGET: Record<'rw6' | 'rw7' | 'rw8', { network: string; device: string }> = {
  rw6: { network: 'Local', device: 'DRV_1' },
  rw7: { network: 'IntBus', device: 'DrvSys' },
  rw8: { network: 'IntBus', device: 'DrvSys' },
};

/** The configuration type read by getCfgType and listCfgTypeAttributes: three attributes on every build. */
const CFG_DOMAIN = 'SYS';
const CFG_TYPE = 'MASTER_BOOL';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Outcome<T> = { ok: true; value: T } | { ok: false; error: RwsError };

/** Run `fn`; a failure must be a typed RwsError, which is returned instead of thrown. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (!(e instanceof RwsError)) { throw new Error(`${what} failed with a non-RwsError: ${errText(e)}`); }
    return { ok: false, error: e };
  }
}

/** The resource name of a subscription group member (an href), as RobotManager names it. */
function resourceName(resource: string): string {
  const p = resource.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\/?/, '/');
  if (/^\/rw\/panel\/(?:ctrlstate|ctrl-state)(?:[;/?]|$)/.test(p)) { return 'controllerstate'; }
  if (/^\/rw\/panel\/opmode(?:[;/?]|$)/.test(p)) { return 'operationmode'; }
  if (/^\/rw\/panel\/speedratio(?:[;/?]|$)/.test(p)) { return 'speedratio'; }
  if (/^\/rw\/panel\/coldetstate(?:[;/?]|$)/.test(p)) { return 'coldetstate'; }
  if (/^\/rw\/rapid\/execution;ctrlexecstate(?:[;/?]|$)/.test(p)) { return 'execution'; }
  if (/^\/rw\/elog\/\d+(?:[;/?]|$)/.test(p)) { return 'elog'; }
  return resource;
}

/** The requests the test sends outside the client: reads only. */
type RawMethod = 'GET' | 'HEAD' | 'OPTIONS';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** The first JSON object whose `_type` is `type`, depth first. */
function jsonOfType(node: Json, type: string): { [k: string]: Json } | null {
  if (Array.isArray(node)) {
    for (const n of node) { const hit = jsonOfType(n, type); if (hit) { return hit; } }
    return null;
  }
  if (node && typeof node === 'object') {
    if (node['_type'] === type) { return node; }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') { const hit = jsonOfType(v, type); if (hit) { return hit; } }
    }
  }
  return null;
}

/** Joint values in degrees by axis, from a JointTarget. */
const jointsDeg = (j: Record<string, number>): number[] => [1, 2, 3, 4, 5, 6].map(i => j[`rax_${i}`]);

const PJOINTS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'] as const;

/**
 * The scalar fields of the entry of class `type` in a raw answer: JSON
 * (hal+json or RWS 1.0 `?json=1`, else the first `_state` entry) or XHTML
 * (the spans of the `<li class="{type}">`).
 */
function statedFields(body: string, type: string): Record<string, string> {
  const out: Record<string, string> = {};
  const t = body.trim();
  if (t.startsWith('{')) {
    let root: Json = null;
    try { root = JSON.parse(t) as Json; } catch { return out; }
    const top = root as { _embedded?: { _state?: Json[] }; state?: Json[] } | null;
    const first = (top?._embedded?._state ?? top?.state ?? [])[0];
    const hit = jsonOfType(root, type) ?? (first && typeof first === 'object' && !Array.isArray(first) ? first : null);
    for (const [k, v] of Object.entries(hit ?? {})) {
      if (!k.startsWith('_') && (typeof v === 'string' || typeof v === 'number')) { out[k] = String(v); }
    }
    return out;
  }
  const li = new RegExp(`<li class="${type}"[^>]*>([\\s\\S]*?)</li>`).exec(t)?.[1] ?? t;
  for (const m of li.matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)) { out[m[1]] = m[2]; }
  return out;
}

// ─── Per controller ──────────────────────────────────────────────────────────

await forEachController(FILE, ctx => {
  const isRws1 = ctx.generation === 'rws1';
  const io = IO_TARGET[ctx.lane];

  /** The URL the client builds for `op` on this lane (path tables), `?json=1` added where the RWS 1.0 read adds it. */
  const opPath = (domain: string, op: string, params: Record<string, string> = {}, json = true): string => {
    const spec = ALL_TABLES[domain][op][ctx.generation] as PathSpec | undefined;
    if (!spec) { throw new Error(`${domain}.${op} has no ${ctx.generation} row`); }
    const p = buildPath(spec, params);
    return isRws1 && json ? `${p}${p.includes('?') ? '&' : '?'}json=1` : p;
  };

  /**
   * One request on the adapter's own session: its cookie, no credentials (a
   * refused cookie is answered 401 and opens nothing), straight to the
   * controller's port. For the read-back of the jog selection, which the
   * client has no read for, and for the evidence of a failed read.
   */
  const rawRequest = async (
    adapter: IRWSAdapter, method: RawMethod, path: string,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> => {
    assertLocalhost(ctx.host);
    const cookie = adapter.getSessionCookie();
    if (!cookie) { throw new Error(`${ctx.lane}: the adapter holds no session cookie to read ${path} with`); }
    // RWS 2.0 serves OPTIONS forms only as application/xhtml+xml;v=2.0.
    const accept = isRws1 ? 'application/xhtml+xml' : method === 'OPTIONS' ? 'application/xhtml+xml;v=2.0' : 'application/hal+json;v=2.0';
    return new Promise((resolve, reject) => {
      const opts: https.RequestOptions = {
        host: ctx.host, port: ctx.port, path, method, agent: false, timeout: 8000,
        headers: { Accept: accept, Cookie: cookie },
        ...(ctx.https ? { rejectUnauthorized: false } : {}),
      };
      const req = (ctx.https ? https : http).request(opts, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
      req.on('error', reject);
      req.end();
    });
  };

  /** Read `path` once more on the observer's session and write the raw answer to the trace. Never throws. */
  const evidence = async (label: string, method: RawMethod, path: string): Promise<void> => {
    try {
      const r = await rawRequest(await ctx.observer(), method, path);
      ctx.note(`evidence for ${label}: ${method} ${path} -> ${r.status}`, {
        status: r.status,
        contentType: r.headers['content-type'] ?? null,
        ...(method !== 'GET' ? { headers: r.headers } : {}),
        body: r.body.slice(0, 4000),
      });
    } catch (e) {
      ctx.note(`evidence for ${label}: ${method} ${path} could not be read`, describeError(e));
    }
  };

  /** Run `body`; when it fails (a refusal, a parse error or an assertion), write the evidence of `path`, then fail. */
  const withEvidence = async <T>(label: string, path: string, body: () => Promise<T>, method: RawMethod = 'GET'): Promise<T> => {
    try {
      return await body();
    } catch (e) {
      ctx.note(`${label} failed`, describeError(e));
      await evidence(label, method, path);
      throw e;
    }
  };

  /** The manager, connected (a test may have logged it out on the RWS 1.0 lane). */
  const mgr = (): Promise<RobotManager> => ctx.ensureManager();

  /** The observer as the RWS 2.0 client (OmniCore-only reads). */
  const rws2 = async (): Promise<RWS2Adapter> => {
    const a = await ctx.observer();
    if (!(a instanceof RWS2Adapter)) { throw new Error(`${ctx.lane}: expected an RWS2Adapter, got ${a.constructor.name}`); }
    return a;
  };

  /** Load the ZZ_PROBE module once for the tests that read it; the harness restore unloads it too. */
  let moduleLoaded: Promise<void> | null = null;
  const probeModule = (): Promise<void> => {
    moduleLoaded ??= (async () => {
      await ctx.loadModule({ name: MODULE, text: MODULE_TEXT });
      ctx.defer(`unload ${MODULE}`, () => ctx.unloadModule(MODULE));
    })();
    return moduleLoaded;
  };

  /** The unit the controller has selected for jogging (`mechunit-name` of the motion system), read on the observer's session. */
  const jogSelection = async (): Promise<string | null> => {
    const path = isRws1 ? '/rw/motionsystem?json=1' : '/rw/motionsystem';
    const r = await rawRequest(await ctx.observer(), 'GET', path);
    if (r.status !== 200) { throw new Error(`GET ${path} answered ${r.status}: ${r.body.slice(0, 200)}`); }
    let root: Json = null;
    try { root = JSON.parse(r.body) as Json; } catch { throw new Error(`GET ${path} did not answer JSON: ${r.body.slice(0, 200)}`); }
    const ms = jsonOfType(root, 'ms');
    const name = ms?.['mechunit-name'];
    return typeof name === 'string' ? name : null;
  };

  // ── Common reads, both generations ─────────────────────────────────────────

  it('getRapidTask reads the motion task by name, and refuses an unknown task with a typed error', async () => {
    const m = await mgr();
    const task = await withEvidence('getRapidTask', opPath('rapid', 'getRapidTask', { task: ctx.task }),
      () => m.getRapidTask(ctx.task));
    ctx.note('getRapidTask', task);
    expect(task['name'] ?? task['_title']).toBe(ctx.task);
    // The state fields the task list carries; at least one is in the single-task answer.
    const stateFields = ['type', 'taskstate', 'excstate', 'active', 'motiontask'].filter(k => (task[k] ?? '') !== '');
    expect(stateFields.length, `task fields: ${Object.keys(task).join(', ')}`).toBeGreaterThan(0);
    const listed = (await (await ctx.observer()).getRapidTasks()).find(x => x.name === ctx.task);
    expect(listed).toBeDefined();
    if (task['type'] !== undefined) { expect(task['type'].toLowerCase()).toBe(listed!.type.toLowerCase()); }

    const err = await expectRwsError(() => m.getRapidTask('ZZ_PROBE_NOTASK'));
    ctx.note('getRapidTask of an unknown task', describeError(err));
    expect(err.httpStatus ?? 0).toBeGreaterThanOrEqual(400);
  });

  it('getCfgType counts the instances of SYS/MASTER_BOOL as the instance list does', async () => {
    const m = await mgr();
    const info = await withEvidence('getCfgType', opPath('cfgElogDipc', 'getCfgType', { domain: CFG_DOMAIN, type: CFG_TYPE }, false),
      () => m.getCfgType(CFG_DOMAIN, CFG_TYPE));
    ctx.note('getCfgType', info);
    expect(info).not.toBeNull();
    expect(info!.domain).toBe(CFG_DOMAIN);
    expect(info!.type).toBe(CFG_TYPE);
    // Three on every build (Name, Select and TimeOut or ZeroSpeedEMStop; 2026-10-01).
    expect(info!.attributeCount ?? 0).toBeGreaterThanOrEqual(3);
    const instances = await m.listCfgInstances(CFG_DOMAIN, CFG_TYPE);
    ctx.note('SYS/MASTER_BOOL instances', instances);
    expect(info!.instanceCount).toBe(instances.length);
  });

  it('listCfgTypeAttributes lists the attributes of SYS/MASTER_BOOL, as many as getCfgType counts', async () => {
    const m = await mgr();
    const attrs = await withEvidence('listCfgTypeAttributes',
      opPath('cfgElogDipc', 'listCfgTypeAttributes', { domain: CFG_DOMAIN, type: CFG_TYPE }),
      () => m.listCfgTypeAttributes(CFG_DOMAIN, CFG_TYPE));
    ctx.note('listCfgTypeAttributes', attrs);
    const names = attrs.map(a => a['name'] ?? a['_title'] ?? '');
    // RW 7.21.4 and 8.2.1: Name, Select, TimeOut; RW 6.16.03: Name, Select,
    // ZeroSpeedEMStop (2026-10-01).
    expect(names).toEqual(expect.arrayContaining(isRws1 ? ['Name', 'Select', 'ZeroSpeedEMStop'] : ['Name', 'Select', 'TimeOut']));
    const counted = await attempt('getCfgType', () => m.getCfgType(CFG_DOMAIN, CFG_TYPE));
    if (counted.ok && counted.value?.attributeCount !== undefined) {
      expect(attrs.length).toBe(counted.value.attributeCount);
    } else {
      ctx.note('getCfgType gave no attribute count to compare with', counted.ok ? counted.value : describeError(counted.error));
    }
  });

  it('getDipcQueueInfo reads a ZZ_PROBE queue without taking its message, and an absent queue as null', async t => {
    await ctx.requireAllowed(t, 'dipc');
    const m = await mgr();
    await m.createDipcQueue(QUEUE, { maxmessages: 10, maxsize: 400 });
    ctx.defer(`remove DIPC queue ${QUEUE}`, async () => {
      const again = await mgr();
      if ((await again.listDipcQueues()).some(q => q.name === QUEUE)) { await again.removeDipcQueue(QUEUE); }
    });
    await waitUntil(async () => (await m.listDipcQueues()).some(q => q.name === QUEUE), 5000, 250, `${QUEUE} listed`);
    await m.sendDipcMessage(QUEUE, DIPC_PAYLOAD, 'string');

    const info = await withEvidence('getDipcQueueInfo', opPath('cfgElogDipc', 'getDipcQueueInfo', { queue: QUEUE }),
      () => m.getDipcQueueInfo(QUEUE));
    ctx.note('getDipcQueueInfo', info);
    expect(info).not.toBeNull();
    expect(info!.name).toBe(QUEUE);
    if (isRws1) {
      // The RWS 1.0 queue body was not captured before this run: what it gives is recorded.
      if (info!.size !== undefined) { expect(info!.size).toBe(10); }
      if (info!.maxMsgSize !== undefined) { expect(info!.maxMsgSize).toBe(400); }
    } else {
      // RW 7.21.4 and 8.2.1 answer the created size and message size (2026-09-30).
      expect(info!.size).toBe(10);
      expect(info!.maxMsgSize).toBe(400);
    }

    // The information read must not have consumed the message.
    let msg: { payload: string; type: string } | null = null;
    const got = await waitFor(async () => { msg = await m.readDipcMessage(QUEUE, 0); return msg !== null; }, 5000, 500);
    ctx.note('DIPC read after the information read', { got, msg });
    expect(got, 'the message sent before getDipcQueueInfo is still in the queue').toBe(true);
    expect(msg!.payload.replace(/^"|"$/g, '')).toBe(DIPC_PAYLOAD);

    const absent = await withEvidence('getDipcQueueInfo (absent queue)', opPath('cfgElogDipc', 'getDipcQueueInfo', { queue: QUEUE_ABSENT }),
      () => m.getDipcQueueInfo(QUEUE_ABSENT));
    expect(absent).toBeNull();

    await m.removeDipcQueue(QUEUE);
    expect(await waitFor(async () => !(await m.listDipcQueues()).some(q => q.name === QUEUE), 5000, 250)).toBe(true);
  });

  it(`getIoNetwork reads ${io.network} with the name and states the network list gives`, async () => {
    const m = await mgr();
    const listed = (await m.listNetworks()).find(n => n.name === io.network);
    expect(listed, `${io.network} in listNetworks`).toBeDefined();
    const net = await withEvidence('getIoNetwork', opPath('io', 'getIoNetwork', { network: io.network }),
      async () => {
        const r = await m.getIoNetwork(io.network);
        expect(r['name'] ?? r['_title']).toBe(io.network);
        return r;
      });
    ctx.note('getIoNetwork', net);
    if (net['lstate'] !== undefined) { expect(net['lstate']).toBe(listed!.lstate); }
    if (net['pstate'] !== undefined) { expect(net['pstate']).toBe(listed!.pstate); }
  });

  it(`getIoDeviceInfo reads ${io.network}/${io.device} with the name and states the device list gives`, async () => {
    const m = await mgr();
    const listed = (await m.listDevices(io.network)).find(d => d.name === io.device);
    expect(listed, `${io.device} in listDevices(${io.network})`).toBeDefined();
    const path = isRws1
      ? opPath('io', 'getIoDeviceInfo', { device: io.device })
      : opPath('io', 'getIoDeviceInfo', { network: io.network, device: io.device });
    const dev = await withEvidence('getIoDeviceInfo', path, async () => {
      const r = await m.getIoDeviceInfo(io.network, io.device);
      expect(r['name'] ?? r['_title']).toBe(io.device);
      return r;
    });
    ctx.note('getIoDeviceInfo', dev);
    if (dev['lstate'] !== undefined) { expect(dev['lstate']).toBe(listed!.lstate); }
    if (dev['pstate'] !== undefined) { expect(dev['pstate']).toBe(listed!.pstate); }
  });

  // ── I/O configuration reads, both generations (2026-10-03) ────────────────
  // RWS 1.0 reads them as ?resource=config on the resource (RW 6.16.03,
  // probed 2026-10-03); RWS 2.0 as the /config sub-path.

  /** The path the client reads a configuration from, for the evidence of a failure. */
  const configPath = (op: 'getSignalConfig' | 'getIoNetworkConfig' | 'getIoDeviceConfig', params: Record<string, string>): string =>
    isRws1 ? `${opPath('io', op, params, false)}?resource=config` : opPath('io', op, params);

  /** A signal bound to a device of the lane's network: the lane's device first, then the network's other devices. */
  const deviceSignal = async (): Promise<{ network: string; device: string; name: string; type: string } | null> => {
    const m = await mgr();
    const devices = [io.device, ...(await m.listDevices(io.network)).map(d => d.name).filter(d => d !== io.device)];
    for (const device of devices.slice(0, 6)) {
      const hits = await m.searchSignals({ network: io.network, device });
      if (hits.length) { return { network: io.network, device, name: hits[0].name, type: hits[0].type }; }
    }
    return null;
  };

  it('getSignalConfig reads a device signal\'s configuration with the name, type and device the signal read gives', async t => {
    const sig = await deviceSignal();
    if (!sig) { return ctx.skip(t, `no signal found on the first devices of ${io.network}`); }
    const m = await mgr();
    const read = await m.readIoSignal(sig.network, sig.device, sig.name);
    const cfg = await withEvidence('getSignalConfig', configPath('getSignalConfig', { network: sig.network, device: sig.device, name: sig.name }),
      () => m.getSignalConfig(sig.network, sig.device, sig.name));
    ctx.note('getSignalConfig', { signal: sig, read, cfg });
    expect(cfg['name']).toBe(sig.name);
    expect(cfg['signaltype']).toBe(read.type);
    expect(cfg['device']).toBe(sig.device);
    expect((cfg['cfgname'] ?? '').trim()).not.toBe('');

    const err = await expectRwsError(() => m.getSignalConfig(sig.network, sig.device, 'ZZ_PROBE_NOSIGNAL'));
    ctx.note('getSignalConfig of an unknown signal', describeError(err));
    expect(err.httpStatus ?? 0).toBeGreaterThanOrEqual(400);
  });

  it(`getIoNetworkConfig reads ${io.network}'s configuration under the name the network list gives`, async () => {
    const m = await mgr();
    expect((await m.listNetworks()).some(n => n.name === io.network), `${io.network} in listNetworks`).toBe(true);
    const cfg = await withEvidence('getIoNetworkConfig', configPath('getIoNetworkConfig', { network: io.network }),
      () => m.getIoNetworkConfig(io.network));
    ctx.note('getIoNetworkConfig', cfg);
    expect(cfg['name']).toBe(io.network);
    expect((cfg['cfgname'] ?? '').trim()).not.toBe('');

    const err = await expectRwsError(() => m.getIoNetworkConfig('ZZ_PROBE_NONET'));
    ctx.note('getIoNetworkConfig of an unknown network', describeError(err));
    expect(err.httpStatus ?? 0).toBeGreaterThanOrEqual(400);
  });

  it(`getIoDeviceConfig reads ${io.network}/${io.device}'s configuration under the name and network the device list gives`, async () => {
    const m = await mgr();
    expect((await m.listDevices(io.network)).some(d => d.name === io.device), `${io.device} in listDevices(${io.network})`).toBe(true);
    const params: Record<string, string> = isRws1 ? { device: io.device } : { network: io.network, device: io.device };
    const cfg = await withEvidence('getIoDeviceConfig', configPath('getIoDeviceConfig', params),
      () => m.getIoDeviceConfig(io.network, io.device));
    ctx.note('getIoDeviceConfig', cfg);
    expect(cfg['name']).toBe(io.device);
    if (cfg['network'] !== undefined) { expect(cfg['network']).toBe(io.network); }
    expect((cfg['cfgname'] ?? '').trim()).not.toBe('');

    const err = await expectRwsError(() => m.getIoDeviceConfig(io.network, 'ZZ_PROBE_NODEVICE'));
    ctx.note('getIoDeviceConfig of an unknown device', describeError(err));
    expect(err.httpStatus ?? 0).toBeGreaterThanOrEqual(400);
  });

  it('listModuleRoutines lists the PROC, FUNC and TRAP of a loaded ZZ_PROBE module, typed prc / fun / trp', async () => {
    await probeModule();
    const m = await mgr();
    // RWS 1.0 reads the routines with a symbol search (a POST); its evidence is the module resource.
    const path = isRws1
      ? `/rw/rapid/modules/${MODULE}?task=${ctx.task}&json=1`
      : opPath('rapid', 'listModuleRoutines', { task: ctx.task, module: MODULE });
    const routines = await withEvidence('listModuleRoutines', path, () => m.listModuleRoutines(ctx.task, MODULE));
    ctx.note('listModuleRoutines', routines);
    const byName = Object.fromEntries(routines.map(r => [r.name.toLowerCase(), r.type]));
    expect(byName).toEqual({ [ROUTINES.proc]: 'prc', [ROUTINES.func]: 'fun', [ROUTINES.trap]: 'trp' });
  });

  it('getFileMetadata reads a ZZ_PROBE file in TEMP in agreement with the directory listing; a missing file is a typed refusal', async () => {
    const m = await mgr();
    const path = `${ctx.temp}/${META_FILE}`;
    await m.uploadFile(path, META_TEXT);
    ctx.defer(`delete ${path}`, async () => { await (await mgr()).deleteControllerFile(path).catch(() => undefined); });
    const entry = (await m.listDirectory(ctx.temp)).find(e => e.name === META_FILE);
    expect(entry, `${META_FILE} listed in ${ctx.temp}`).toBeDefined();
    ctx.note('directory entry', entry);
    const bytes = Buffer.byteLength(META_TEXT, 'utf8');

    const rawPath = isRws1 ? `/fileservice/${path}?action=metadata&json=1` : `/fileservice/${path}`;
    if (isRws1) {
      // RW 6.16.03 refuses `?action=metadata` (400 "Invalid action or
      // resource", 2026-10-01); the client then reads the file's entry in the
      // directory listing, so the answer is the listing's.
      const meta = await withEvidence('getFileMetadata', rawPath, () => m.getFileMetadata(path));
      ctx.note('getFileMetadata (RWS 1.0)', meta);
      expect(meta).not.toBeNull();
      expect(meta!.path).toBe(path);
      expect(meta!.size).toBe(bytes);
      expect(meta!.size).toBe(entry!.size);
      expect(meta!.modified).toBe(entry!.modified);
      expect(meta!.readonly).toBe(entry!.readonly);
    } else {
      const meta = await withEvidence('getFileMetadata', rawPath, () => m.getFileMetadata(path), 'HEAD');
      ctx.note('getFileMetadata (RWS 2.0 HEAD)', meta);
      expect(meta).not.toBeNull();
      expect(meta!.path).toBe(path);
      expect(Object.keys(meta!.fields).length).toBeGreaterThan(0);
      if (meta!.size !== undefined) { expect(meta!.size).toBe(bytes); }
      for (const k of Object.keys(meta!.fields)) { expect(['set-cookie', 'cookie', 'authorization']).not.toContain(k); }
    }

    const missing = `${ctx.temp}/ZZ_PROBE_NOFILE_${RUN_TAG}.txt`;
    const err = await expectRwsError(() => m.getFileMetadata(missing));
    ctx.note('getFileMetadata of a missing file', describeError(err));
    if (!isRws1) { expect(err.httpStatus).toBe(404); }

    await m.deleteControllerFile(path);
    expect((await m.listDirectory(ctx.temp)).some(e => e.name === META_FILE)).toBe(false);
  });

  // ── Niche reads, both generations ──────────────────────────────────────────

  /** The manager with a live subscription, or a skip with the reason. */
  const liveManager = async (t: TestHandle): Promise<RobotManager> => {
    const m = await mgr();
    if (!await waitFor(() => m.state.quality === 'live', 15_000)) {
      return ctx.skip(t, `the manager's subscription is not live (quality ${m.state.quality}: ${m.state.qualityReason})`);
    }
    return m;
  };

  it('listSubscriptionGroups lists the manager session\'s one group, with its poll URL', async t => {
    const m = await liveManager(t);
    const groups = await withEvidence('listSubscriptionGroups', isRws1 ? '/subscription?json=1' : '/subscription',
      () => m.listSubscriptionGroups());
    ctx.note('listSubscriptionGroups', groups);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.groupPath).toBe(`/subscription/${g.id}`);
    if (!isRws1) { expect(g.groupPath).toBe(m.subscriptionGroupPath); }
    expect(g.pollUrl ?? '').toMatch(new RegExp(`/poll/${g.id}$`));
  });

  it('getSubscriptionGroup lists the resources the manager\'s group holds; a group of no session is refused 400', async t => {
    const m = await liveManager(t);
    const [g] = await m.listSubscriptionGroups();
    expect(g).toBeDefined();
    const members = await withEvidence('getSubscriptionGroup', g.groupPath, () => m.getSubscriptionGroup(g.groupPath));
    const names = members.map(x => resourceName(x.resource));
    const missing = MANAGER_RESOURCES.filter(r => !names.includes(r));
    ctx.note('getSubscriptionGroup', { members, missingOfTheSixTheManagerAsksFor: missing });
    // Each member is one of the six resources the manager subscribes, once.
    // Whether all six bound is 10-subscriptions' check: RW 8.2.1 held five,
    // without speedratio, on 2026-10-01 (all six on 2026-09-29).
    expect(members.length).toBeGreaterThan(0);
    for (const n of names) { expect(MANAGER_RESOURCES as readonly string[]).toContain(n); }
    expect(new Set(names).size).toBe(names.length);
    for (const x of members) { expect(x.index).toMatch(/^\d+$/); }
    // By id too, the same members.
    expect(await m.getSubscriptionGroup(g.id)).toEqual(members);

    // A group id no session holds: 400 -1073435900 "Group N does not belong to Client M"
    // for a deleted group on RW 6.16.03, 7.21.4 and 8.2.1 (2026-09-29).
    const err = await expectRwsError(() => m.getSubscriptionGroup('987654'));
    ctx.note('getSubscriptionGroup of a group of no session', describeError(err));
    expect([400, 404]).toContain(err.httpStatus);
  });

  it('getMotionSupervision reads motion supervision on, level 100', async () => {
    const m = await mgr();
    const path = isRws1
      ? `${opPath('motion', 'getMotionSupervision', {}, false)}?mechunit=${ctx.mechunit}&json=1`
      : opPath('motion', 'getMotionSupervision', { mechunit: ctx.mechunit });
    const s = await withEvidence('getMotionSupervision', path, () => m.getMotionSupervision(ctx.mechunit));
    ctx.note('getMotionSupervision', s);
    // TRUE / 100 on RW 6.16.03, 7.21.4 and 8.2.1 (2026-09-29).
    expect(s).toEqual({ enabled: true, level: 100 });
  });

  it('getPathSupervision reads a mode and a numeric level', async () => {
    const m = await mgr();
    const path = isRws1
      ? `${opPath('motion', 'getPathSupervision', {}, false)}?mechunit=${ctx.mechunit}&json=1`
      : opPath('motion', 'getPathSupervision', { mechunit: ctx.mechunit });
    const s = await withEvidence('getPathSupervision', path, () => m.getPathSupervision(ctx.mechunit));
    ctx.note('getPathSupervision', s);
    expect(s).not.toBeNull();
    expect(s!.mode).toMatch(/^(on|off)$/i);
    expect(Number.isFinite(s!.level)).toBe(true);
    expect(s!.level).toBeGreaterThanOrEqual(0);
  });

  it('getMechunitSmbData reads the unit\'s SMB data fields, or the controller\'s typed "No moc data"', async () => {
    const m = await mgr();
    const path = opPath('motion', 'getMechunitSmbData', { mechunit: ctx.mechunit });
    const got = await attempt('getMechunitSmbData', () => m.getMechunitSmbData(ctx.mechunit));
    ctx.note('getMechunitSmbData', got.ok ? got.value : describeError(got.error));
    if (got.ok) {
      expect(Object.keys(got.value).filter(k => !k.startsWith('_')).length, 'SMB data fields').toBeGreaterThan(0);
      return;
    }
    // RW 8.2.1 (a virtual controller) answered 404 -1073445883 "No moc data"
    // (2026-10-01); RW 7.21.4 answered the fields.
    await evidence('getMechunitSmbData', 'GET', path);
    expect(got.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(got.error.controllerCode).toBe(-1073445883);
  });

  it('getMechunitMotorCalib names one calibration per joint of the unit', async () => {
    const m = await mgr();
    const calib = await withEvidence('getMechunitMotorCalib', opPath('motion', 'getMechunitMotorCalib', { mechunit: ctx.mechunit }),
      () => m.getMechunitMotorCalib(ctx.mechunit));
    ctx.note('getMechunitMotorCalib', calib);
    const info = (await m.getMechunitInfo(ctx.mechunit)) as Record<string, string>;
    const axes = Number(info['axes'] ?? info['axes-total'] ?? 6);
    expect(calib).toHaveLength(Number.isFinite(axes) && axes > 0 ? axes : 6);
    for (const c of calib) {
      expect(c.joint).not.toBe('');
      expect((c.calibName ?? c.jointName ?? '').length, `calibration name of ${c.joint}`).toBeGreaterThan(0);
    }
  });

  it('getLeadThrough reads the lead-through status, active only when it says so', async () => {
    const m = await mgr();
    const path = isRws1
      ? `${opPath('motion', 'getLeadThrough', { mechunit: ctx.mechunit }, false)}?resource=lead-through&json=1`
      : opPath('motion', 'getLeadThrough', { mechunit: ctx.mechunit });
    const lt = await withEvidence('getLeadThrough', path, () => m.getLeadThrough(ctx.mechunit));
    ctx.note('getLeadThrough', lt);
    expect(lt).not.toBeNull();
    expect(lt!.status.trim()).not.toBe('');
    expect(lt!.active).toBe(lt!.status.trim().toLowerCase() === 'active');
  });

  // ── RWS 1.0 forms and fixes (both lanes read back) ─────────────────────────

  it('getMechunitPjoints reads j1..j6 as the numbers the controller states for them', async () => {
    const m = await mgr();
    const path = opPath('motion', 'getMechunitPjoints', { mechunit: ctx.mechunit });
    const pj = await withEvidence('getMechunitPjoints', path, async () => {
      const r = await m.getMechunitPjoints(ctx.mechunit);
      for (const k of PJOINTS) { expect(Number.isFinite(r[k]), `${k} = ${r[k]}`).toBe(true); }
      return r;
    });
    // The same resource read raw on the observer's session: the client must
    // give exactly the controller's values. They are not compared with the
    // joints: RW 7.21.4 (a virtual controller) stated j1..j6 = 0..5 while the
    // robot stood at [0, 0, 0, 0, 30, 0] (2026-10-01).
    const raw = await rawRequest(await ctx.observer(), 'GET', path);
    expect(raw.status).toBe(200);
    const stated = statedFields(raw.body, 'ms-mechunit-pjoints');
    const joints = jointsDeg((await (await ctx.observer()).getJointPositions(ctx.mechunit)) as unknown as Record<string, number>);
    ctx.note('getMechunitPjoints', { client: pj, stated, jointsDeg: joints, body: raw.body.slice(0, 1500) });
    for (const k of PJOINTS) {
      expect(stated[k], `${k} in the raw answer`).toBeDefined();
      expect(pj[k], k).toBe(Number(stated[k]));
    }
  });

  it('listBreakpoints lists no breakpoint on a task where none is set', async () => {
    await probeModule();
    const m = await mgr();
    const bps = await withEvidence('listBreakpoints', opPath('rapid', 'listBreakpoints', { task: ctx.task }),
      () => m.listBreakpoints(ctx.task));
    ctx.note('listBreakpoints', bps);
    // RWS 1.0 now reads the singular program/breakpoint resource and throws
    // on a refusal; RWS 2.0 still reads every failure as an empty list.
    expect(bps).toEqual([]);
  });

  // ── RWS 2.0 fixes, both lanes read back ────────────────────────────────────

  it('validateRapidValue accepts values of the type; what it answers for a bad value is recorded', async () => {
    const m = await mgr();
    const cases: Array<[string, string, boolean]> = [
      ['42', 'num', true],
      ['[1,2,3]', 'pos', true],
      ['TRUE', 'bool', true],
      ['[1,2', 'pos', false],
      ['"zz"', 'num', false],
      ['[1,2]', 'pos', false],
    ];
    const seen: Array<{ value: string; datatype: string; result: boolean | Record<string, unknown> }> = [];
    try {
      for (const [value, datatype] of cases) {
        const got = await attempt('validateRapidValue', () => m.validateRapidValue(ctx.task, value, datatype));
        seen.push({ value, datatype, result: got.ok ? got.value : describeError(got.error) });
        if (!got.ok) { throw got.error; }
      }
    } finally {
      ctx.note('validateRapidValue', seen);
    }
    const results = seen.map(s => s.result);
    // RW 6.16.03, 7.21.4 and 8.2.1 all answered 204 to every value sent here,
    // the malformed `[1,2` and the type mismatches included (2026-10-01). On
    // RWS 2.0 the request carries exactly the fields of the controller's own
    // form for the resource (task, datatype, value; read with OPTIONS), and a
    // type URL (`RAPID/num`) as the datatype changed nothing. So only the
    // valid values are asserted; the answers for the bad ones are in the note.
    cases.forEach(([, , valid], i) => {
      if (valid) { expect(results[i], `${cases[i][0]} as ${cases[i][1]}`).toBe(true); } else { expect(typeof results[i]).toBe('boolean'); }
    });
  });

  it('validateCfgFile passes a well-formed EIO file and refuses a malformed one, loading nothing', async () => {
    const m = await mgr();
    const header = isRws1 ? 'EIO:CFG_1.0:6:1::' : 'EIO:CFG_1.0:7:0::';
    const good = [header, '#', 'EIO_SIGNAL:', '', `      -Name "${CFG_SIGNAL}" -SignalType "DI" -Access "All"`, ''].join('\n');
    const bad = 'ZZ_PROBE this is not a configuration file\n';
    const goodPath = `${ctx.temp}/${CFG_GOOD}`;
    const badPath = `${ctx.temp}/${CFG_BAD}`;
    for (const p of [goodPath, badPath]) {
      ctx.defer(`delete ${p}`, async () => { await (await mgr()).deleteControllerFile(p).catch(() => undefined); });
    }
    await m.uploadFile(goodPath, good);
    await m.uploadFile(badPath, bad);

    // ABB's pages name the file as a bare volume path; RW 7.21.4 validated `$TEMP/<file>` (2026-09-30).
    const passed = await attempt('validateCfgFile (well-formed)', () => m.validateCfgFile(`$TEMP/${CFG_GOOD}`, 'add'));
    ctx.note('validateCfgFile of a well-formed file', passed.ok ? 'passed' : describeError(passed.error));
    const refused = await attempt('validateCfgFile (malformed)', () => m.validateCfgFile(`$TEMP/${CFG_BAD}`, 'add'));
    ctx.note('validateCfgFile of a malformed file', refused.ok ? 'passed' : describeError(refused.error));

    // A validation is a dry run: the signal it names is not configured afterwards.
    const signals = await m.listCfgInstances('EIO', 'EIO_SIGNAL');
    expect(signals).not.toContain(CFG_SIGNAL);

    await m.deleteControllerFile(goodPath);
    await m.deleteControllerFile(badPath);
    expect(passed.ok, passed.ok ? '' : `the well-formed file was refused: ${passed.error.code} ${passed.error.message}`).toBe(true);
    expect(refused.ok, 'the malformed file was refused').toBe(false);
  });

  // ── Writes inside the envelope, both generations ───────────────────────────

  it('setMechunitForJogging selects the unit already selected; the selection reads the same before and after', async t => {
    const before = await jogSelection();
    ctx.note('jog selection before', { before, mechunit: ctx.mechunit });
    if (before !== ctx.mechunit) {
      ctx.skip(t, `the controller has ${before ?? 'no unit'} selected for jogging, not ${ctx.mechunit}; the suite never selects another unit`);
    }
    const m = await mgr();
    const done = await attempt('setMechunitForJogging', () => m.setMechunitForJogging(ctx.mechunit));
    ctx.note('setMechunitForJogging', done.ok ? 'accepted' : describeError(done.error));
    const after = await jogSelection();
    ctx.note('jog selection after', { after });
    expect(after).toBe(before);
    if (!done.ok) { throw done.error; }
  });

  it('updateSubscriptionGroup adds a resource to a live group of its own session; the group lists both, and is deleted after', async () => {
    // RW 6.16.03 refuses a further session while the lane's manager is connected (see the harness).
    if (isRws1) { await ctx.connectedManager()?.disconnect(); }
    const a = await ctx.newAdapter();
    try {
      expect(await a.listSubscriptionGroups!()).toEqual([]);
      // Recorded: RW 8.2.1 refused a speedratio-only subscribe 400 on
      // 2026-10-01, and its manager group held no speedratio; the update is
      // therefore made on operation mode and controller state.
      const speed = await attempt('subscribe speedratio', () => a.subscribe(['speedratio'], () => undefined));
      ctx.note('a speedratio subscribe on a fresh session', speed.ok ? 'bound' : describeError(speed.error));
      if (speed.ok) { await speed.value(); }
      expect(await a.listSubscriptionGroups!()).toEqual([]);

      const stop = await a.subscribe(['operationmode'], () => undefined);
      let stopped = false;
      try {
        const groups = await a.listSubscriptionGroups!();
        expect(groups).toHaveLength(1);
        const g = groups[0];
        const before = await a.getSubscriptionGroup!(g.groupPath);
        ctx.note('own group before the update', { group: g, members: before });
        expect(before.map(x => resourceName(x.resource))).toEqual(['operationmode']);

        const answer = await withEvidence('updateSubscriptionGroup', g.groupPath,
          () => a.updateSubscriptionGroup!(g.groupPath, ['controllerstate']));
        const after = await a.getSubscriptionGroup!(g.groupPath);
        ctx.note('own group after the update', { answer: answer.slice(0, 600), members: after });
        expect(after.map(x => resourceName(x.resource)).sort()).toEqual(['controllerstate', 'operationmode']);

        await stop();
        stopped = true;
        expect(await a.listSubscriptionGroups!()).toEqual([]);
      } finally {
        if (!stopped) { await stop().catch(() => undefined); }
      }
    } finally {
      await ctx.release(a);
      await ctx.ensureManager();
    }
  });

  // ── RWS 2.0 only: OmniCore reads ───────────────────────────────────────────

  if (ctx.generation === 'rws2') {
    it('getSafetyConfigChangeCount reads a whole count that does not move between two reads', async () => {
      const a = await rws2();
      const first = await withEvidence('getSafetyConfigChangeCount', opPath('ctrl', 'getSafetyConfigChangeCount'),
        () => a.getSafetyConfigChangeCount());
      const second = await a.getSafetyConfigChangeCount();
      ctx.note('getSafetyConfigChangeCount', { first, second });
      expect(Number.isInteger(first)).toBe(true);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBe(first);
    });

    it('getSafetyConfig reads the loaded safety configuration\'s status', async () => {
      const a = await rws2();
      const cfg = await withEvidence('getSafetyConfig', opPath('ctrl', 'getSafetyConfig'), () => a.getSafetyConfig());
      ctx.note('getSafetyConfig', cfg);
      expect(cfg.status).not.toBe('unknown');
      expect(cfg.status.trim()).not.toBe('');
    });

    it('verifyControllerFeature answers false for a feature id no controller has, and refuses an empty id unsent', async () => {
      const a = await rws2();
      const absent = 'zz.probe.absent.feature';
      const got = await withEvidence('verifyControllerFeature',
        opPath('ctrl', 'verifyControllerFeature', { feature: absent }),
        () => a.verifyControllerFeature(absent));
      expect(got).toBe(false);
      const example = 'abb.robotics.robotcontrol.controllerhw.m28.01';
      const ex = await attempt('verifyControllerFeature (ABB example id)', () => a.verifyControllerFeature(example));
      ctx.note('verifyControllerFeature', { [absent]: got, [example]: ex.ok ? ex.value : describeError(ex.error) });
      const empty = await expectRwsError(() => a.verifyControllerFeature(' '));
      expect(empty.code).toBe('INVALID_ARGUMENT');
    });

    it('getMechunitCalib lists the unit\'s calibration resources by name and link', async () => {
      const a = await rws2();
      const calib = await withEvidence('getMechunitCalib', opPath('motion', 'getMechunitCalib', { mechunit: ctx.mechunit }),
        () => a.getMechunitCalib(ctx.mechunit));
      ctx.note('getMechunitCalib', calib);
      expect(calib.length).toBeGreaterThan(0);
      for (const c of calib) {
        expect(c.name).not.toBe('');
        expect(c.href ?? '').toContain(c.name);
      }
    });

    it('getModPossibleAll answers a list of typed entries', async () => {
      const a = await rws2();
      const all = await withEvidence('getModPossibleAll', opPath('rapid', 'getModPossibleAll'), () => a.getModPossibleAll());
      ctx.note('getModPossibleAll', all);
      expect(Array.isArray(all)).toBe(true);
      for (const e of all) { expect(e['_type'] ?? '').not.toBe(''); }
    });

    it('getModuleModPossible refuses a read without a text range; a ranged read is recorded', async () => {
      await probeModule();
      const a = await rws2();
      const path = opPath('rapid', 'getModuleModPossible', { task: ctx.task, module: MODULE });
      const bare = await attempt('getModuleModPossible', () => a.getModuleModPossible(ctx.task, MODULE));
      const rows = MODULE_TEXT.split('\n').length;
      const ranged = await attempt('getModuleModPossible (range)',
        () => a.getModuleModPossible(ctx.task, MODULE, { startrow: 1, startcol: 1, endrow: rows, endcol: 1 }));
      ctx.note('getModuleModPossible', {
        bare: bare.ok ? bare.value : describeError(bare.error),
        ranged: ranged.ok ? ranged.value : describeError(ranged.error),
      });
      if (!ranged.ok) { await evidence('getModuleModPossible (range)', 'GET', `${path}?startrow=1&startcol=1&endrow=${rows}&endcol=1`); }
      // A bare read was refused 400 asking for endrow on RW 7.21.0 (2026-05-04).
      if (!bare.ok) { expect(bare.error.httpStatus).toBe(400); } else { expect(Array.isArray(bare.value)).toBe(true); }
      expect(ranged.ok, ranged.ok ? '' : `the ranged read was refused: ${ranged.error.message}`).toBe(true);
      if (ranged.ok) { expect(Array.isArray(ranged.value)).toBe(true); }
    });

    it('getModuleSymbolInfo answers the module\'s symbol resource as typed entries', async () => {
      await probeModule();
      const a = await rws2();
      const info = await withEvidence('getModuleSymbolInfo', opPath('rapid', 'getModuleSymbolInfo', { task: ctx.task, module: MODULE }),
        () => a.getModuleSymbolInfo(ctx.task, MODULE));
      ctx.note('getModuleSymbolInfo', info);
      expect(Array.isArray(info)).toBe(true);
      for (const e of info) { expect(e['_type'] ?? '').not.toBe(''); }
    });

    it('getModuleAttributes refuses a read without an attribute; a named attribute is recorded', async () => {
      await probeModule();
      const a = await rws2();
      const bare = await attempt('getModuleAttributes', () => a.getModuleAttributes(ctx.task, MODULE));
      const named = await attempt('getModuleAttributes (attrib)', () => a.getModuleAttributes(ctx.task, MODULE, { attrib: 'nostepin' }));
      const upper = await attempt('getModuleAttributes (ATTRIB)', () => a.getModuleAttributes(ctx.task, MODULE, { attrib: 'NOSTEPIN' }));
      ctx.note('getModuleAttributes', {
        bare: bare.ok ? bare.value : describeError(bare.error),
        nostepin: named.ok ? named.value : describeError(named.error),
        NOSTEPIN: upper.ok ? upper.value : describeError(upper.error),
      });
      // A bare read was refused 400 asking for attrib on RW 7.21.0 (2026-05-04).
      if (!bare.ok) { expect(bare.error.httpStatus).toBe(400); } else { expect(Array.isArray(bare.value)).toBe(true); }
      for (const o of [named, upper]) {
        if (o.ok) { expect(Array.isArray(o.value)).toBe(true); } else { expect(o.error.httpStatus ?? 0).toBeGreaterThanOrEqual(400); }
      }
    });

    it('getModuleObject answers the RAPID object at the module\'s start', async () => {
      await probeModule();
      const a = await rws2();
      const obj = await withEvidence('getModuleObject', opPath('rapid', 'getModuleObject', { task: ctx.task, module: MODULE }),
        () => a.getModuleObject(ctx.task, MODULE));
      ctx.note('getModuleObject', obj);
      expect(obj.length).toBeGreaterThan(0);
      for (const e of obj) { expect(e['_type'] ?? '').not.toBe(''); }
    });

    // ── Task motion sub-reads (2026-10-03) ───────────────────────────────────
    // RW 7.21.0, 7.21.4, 8.1.1 and 8.2.1 serve all four (probed 2026-10-03).
    // Nothing moves the robot in this file, so two reads of one pose agree.

    it('getTaskMechunits lists the lane\'s unit, and each unit listed names this task as its own', async () => {
      const a = await rws2();
      const units = await withEvidence('getTaskMechunits', opPath('rapid', 'getTaskMechunits', { task: ctx.task }),
        () => a.getTaskMechunits(ctx.task));
      ctx.note('getTaskMechunits', units);
      expect(units.map(u => u.name)).toContain(ctx.mechunit);
      const all = await a.listMechunits();
      const m = await mgr();
      for (const u of units) {
        expect(all).toContain(u.name);
        expect(u.mode.trim()).not.toBe('');
        expect(u.type.trim()).not.toBe('');
        expect((await m.getMechunitDetails(u.name)).task).toBe(ctx.task);
      }
      const err = await expectRwsError(() => a.getTaskMechunits('ZZ_PROBE_NOTASK'));
      ctx.note('getTaskMechunits of an unknown task', describeError(err));
      expect(err.httpStatus ?? 0).toBeGreaterThanOrEqual(400);
    });

    it('getTaskJointTarget reads the robot axes the motion system reads for the task\'s unit', async () => {
      const a = await rws2();
      const task = await withEvidence('getTaskJointTarget', opPath('rapid', 'getTaskJointTarget', { task: ctx.task }),
        () => a.getTaskJointTarget(ctx.task));
      const unit = await a.getJointTargetFull(ctx.mechunit);
      ctx.note('getTaskJointTarget', { task, motionSystem: unit });
      for (let i = 0; i < 6; i++) { expect(Math.abs(task.rax[i] - unit.rax[i]), `rax_${i + 1}`).toBeLessThan(0.01); }
    });

    it('getTaskRobTarget reads the pose the unit\'s robtarget gives for its active tool and work object', async () => {
      const a = await rws2();
      const task = await withEvidence('getTaskRobTarget', opPath('rapid', 'getTaskRobTarget', { task: ctx.task }),
        () => a.getTaskRobTarget(ctx.task));
      const details = await (await mgr()).getMechunitDetails(ctx.mechunit);
      const tool = details.tool ?? 'tool0';
      const wobj = details.wobj ?? 'wobj0';
      const unit = await a.getRobTarget(ctx.mechunit, tool, wobj);
      ctx.note('getTaskRobTarget', { task, tool, wobj, unitRobTarget: unit });
      for (const k of ['x', 'y', 'z'] as const) { expect(Math.abs(task[k] - unit[k]), k).toBeLessThan(0.05); }
      // q and -q are one orientation.
      const dot = task.q1 * unit.q1 + task.q2 * unit.q2 + task.q3 * unit.q3 + task.q4 * unit.q4;
      expect(Math.abs(Math.abs(dot) - 1)).toBeLessThan(1e-4);
      for (const k of ['cf1', 'cf4', 'cf6', 'cfx'] as const) { expect(Number.isInteger(task[k]), k).toBe(true); }
    });

    it('getTaskExtJointState names six external joints; a joint read not_active has no axis in the task jointtarget', async () => {
      const a = await rws2();
      const states = await withEvidence('getTaskExtJointState', opPath('rapid', 'getTaskExtJointState', { task: ctx.task }),
        () => a.getTaskExtJointState(ctx.task));
      const joints = await a.getTaskJointTarget(ctx.task);
      ctx.note('getTaskExtJointState', { states, eax: joints.eax });
      expect(Object.keys(states).sort()).toEqual(['j1', 'j2', 'j3', 'j4', 'j5', 'j6']);
      for (let i = 0; i < 6; i++) {
        const state = states[`j${i + 1}`];
        expect(state.trim()).not.toBe('');
        if (state === 'not_active') { expect(isJointValuePresent(joints.eax[i]), `eax slot ${i + 1}`).toBe(false); }
      }
    });

    // ── UAS reads ────────────────────────────────────────────────────────────

    /** Whether this session holds UAS administration (read once). */
    let adminGrant: Promise<boolean> | null = null;
    const isUasAdmin = (): Promise<boolean> => {
      adminGrant ??= rws2().then(a => a.listCurrentUserGrants()).then(g => g.includes('UAS_UAS_ADMINISTRATION'));
      return adminGrant;
    };

    /**
     * A UAS read: with UAS administration it must answer; without it, it
     * answers (`check` then holds) or is refused GRANT_DENIED (HTTP 403).
     * `strict`: without UAS administration it must be refused.
     */
    const uasRead = async <T>(what: string, path: string, fn: () => Promise<T>, check: (v: T) => void | Promise<void>, strict = false): Promise<Outcome<T>> => {
      const admin = await isUasAdmin();
      const got = await attempt(what, fn);
      ctx.note(what, { uasAdministration: admin, outcome: got.ok ? got.value : describeError(got.error) });
      if (!got.ok && got.error.code !== 'GRANT_DENIED') { await evidence(what, 'GET', path); }
      if (admin && !got.ok) { throw got.error; }
      if (!admin && strict) { expect(got.ok, `${what} answered without UAS administration`).toBe(false); }
      if (got.ok) {
        await check(got.value);
      } else {
        expect(got.error.code).toBe('GRANT_DENIED');
        expect(got.error.httpStatus).toBe(403);
      }
      return got;
    };

    it('listUasUsers is refused GRANT_DENIED to a user without UAS administration (a list with it)', async () => {
      const a = await rws2();
      await uasRead('listUasUsers', opPath('usersUas', 'listUasUsers'), () => a.listUasUsers(), users => {
        expect(users.map(u => u.name)).toContain(TEST_USER);
      }, true);
    });

    it('getUasUser reads the session user\'s sub-resources, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      await uasRead('getUasUser', opPath('usersUas', 'getUasUser', { user: TEST_USER }), () => a.getUasUser(TEST_USER), subs => {
        expect(subs.length).toBeGreaterThan(0);
      });
    });

    it('listUasUserGrants reads the session user\'s grants as the current-user read lists them, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      const own = await a.listCurrentUserGrants();
      await uasRead('listUasUserGrants', opPath('usersUas', 'listUasUserGrants', { user: TEST_USER }),
        () => a.listUasUserGrants(TEST_USER), grants => {
          expect([...grants].sort()).toEqual([...own].sort());
        });
    });

    it('listUasUserRoles reads the session user\'s roles, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      await uasRead('listUasUserRoles', opPath('usersUas', 'listUasUserRoles', { user: TEST_USER }),
        () => a.listUasUserRoles(TEST_USER), roles => {
          expect(roles.length).toBeGreaterThan(0);
        });
    });

    it('isUasUserEnabled reads the logged-in session user as enabled, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      await uasRead('isUasUserEnabled', opPath('usersUas', 'isUasUserEnabled', { user: TEST_USER }),
        () => a.isUasUserEnabled(TEST_USER), enabled => {
          expect(enabled).toBe(true);
        });
    });

    it('getUasUserDescription reads the session user\'s description, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      await uasRead('getUasUserDescription', opPath('usersUas', 'getUasUserDescription', { user: TEST_USER }),
        () => a.getUasUserDescription(TEST_USER), desc => {
          expect(typeof desc).toBe('string');
        });
    });

    it('isUasUserPasswordChangeAllowed agrees with the current-user read, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      const own = await a.isPasswordChangeAllowed();
      await uasRead('isUasUserPasswordChangeAllowed', opPath('usersUas', 'isUasUserPasswordChangeAllowed', { user: TEST_USER }),
        () => a.isUasUserPasswordChangeAllowed(TEST_USER), async allowed => {
          if (allowed !== own) {
            ctx.note('the named and the current-user password-change reads disagree', { named: allowed, currentUser: own });
            await evidence('isPasswordChangeAllowed (current user)', 'GET', opPath('usersUas', 'isPasswordChangeAllowed'));
          }
          expect(allowed).toBe(own);
        });
    });

    it('listUasRoles is refused GRANT_DENIED to a user without UAS administration (a list with it)', async () => {
      const a = await rws2();
      await uasRead('listUasRoles', opPath('usersUas', 'listUasRoles'), () => a.listUasRoles(), roles => {
        expect(roles.length).toBeGreaterThan(0);
      }, true);
    });

    /** A role to read: the session user's first role when that read answers, else ABB's predefined Admin role. */
    const roleToRead = async (): Promise<string> => {
      const a = await rws2();
      const roles = await attempt('listUasUserRoles', () => a.listUasUserRoles(TEST_USER));
      return roles.ok && roles.value.length ? roles.value[0] : 'Admin';
    };

    it('getUasRole reads a role\'s sub-resources, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      const role = await roleToRead();
      await uasRead('getUasRole', opPath('usersUas', 'getUasRole', { role }), () => a.getUasRole(role), subs => {
        expect(subs.length).toBeGreaterThan(0);
      });
    });

    it('listUasRoleGrants reads a role\'s grants, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      const role = await roleToRead();
      await uasRead('listUasRoleGrants', opPath('usersUas', 'listUasRoleGrants', { role }), () => a.listUasRoleGrants(role), grants => {
        for (const g of grants) { expect(g).toMatch(/^UAS_/); }
      });
    });

    it('getUasRoleDescription reads a role\'s description, or is refused GRANT_DENIED', async () => {
      const a = await rws2();
      const role = await roleToRead();
      await uasRead('getUasRoleDescription', opPath('usersUas', 'getUasRoleDescription', { role }),
        () => a.getUasRoleDescription(role), desc => {
          expect(typeof desc).toBe('string');
        });
    });
  }

  // ── The end state ──────────────────────────────────────────────────────────

  it('leaves the controller as the baseline found it once the probe module, file and queue are gone', async () => {
    if (moduleLoaded) { await ctx.unloadModule(MODULE); }
    const now = await ctx.snapshot();
    ctx.note('end snapshot', now);
    expect(now.errors).toEqual([]);
    expect(diffSnapshots(ctx.baseline, now)).toEqual([]);
  });
});
