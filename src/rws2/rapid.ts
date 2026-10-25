import { MOTION, RAPID } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { RwsError, type RapidBuildError, type RapidRoutineInfo, type RefusalCondition, type ExecutionCycle, type ExecutionInfo, type ExecutionState, type ModifyPositionOptions, type RapidSymbolInfo, type RapidSymbolProperties, type RapidSymbolSearchParams, type RapidModuleQuery, type RapidTask, type RobTarget, type UiInstruction, type JointTargetFull, type TaskMechunit, type TaskRobTarget } from '../types.js';
import { isNotHeldRefusal } from '../access/AccessManager.js';
import { codeForControllerCode, SYS_CTRL_E_BUFFER_OVERFLOW } from '../ControllerError.js';
import { withReport } from '../refusal.js';
import { ACCEPT_XHTML, parse, requireState } from './core.js';
import { XhtmlParser } from '../XhtmlParser.js';
import { decodeEntities } from '../ResponseParser.js';
import { aliasIoFrom, BUILD_ERROR_PAGES, buildErrorsFrom, motionPointerFrom, pickEntry, rapidTaskFrom, readPages, routinesFromSymbols } from '../commonReads.js';
import { JOINT_NOT_PRESENT, toJointTargetFull } from '../mechunit.js';
import type { FilesMethods } from './files.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * Refusal conditions that are access controls someone has to supply, not a
 * verdict on a value: validateRapidValue throws on these and answers `false`
 * for every other 400.
 */
const ACCESS_CONDITIONS: ReadonlySet<RefusalCondition> = new Set<RefusalCondition>([
  'mastership', 'write-access', 'control-station', 'uas-grant', 'remote-access', 'rmmp', 'operating-mode', 'session',
]);

/** `{ task, module }` path parameters, refused before sending when either is empty. */
function moduleParams(what: string, task: string, module: string): { task: string; module: string } {
  if (typeof task !== 'string' || task.trim() === '' || typeof module !== 'string' || module.trim() === '') {
    throw new RwsError(`RWS2 ${what}: task and module names must not be empty`, 'INVALID_ARGUMENT');
  }
  return { task, module };
}

/**
 * `?k=v&...` from a pass-through query, URL-encoded; '' when there is none.
 * `undefined` or `null` means no query; anything else that is not a plain
 * object is refused. A key must be non-empty and a value a string or a finite
 * number.
 */
function queryString(what: string, query?: RapidModuleQuery | null): string {
  if (query == null) { return ''; }
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw new RwsError(`RWS2 ${what}: query must be an object of parameter names to values`, 'INVALID_ARGUMENT');
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (k === '' || !((typeof v === 'string') || (typeof v === 'number' && Number.isFinite(v)))) {
      throw new RwsError(`RWS2 ${what}: query parameter ${JSON.stringify(k)} must have a string or finite-number value`, 'INVALID_ARGUMENT');
    }
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * A RAPID value as RWS 2.0 must receive it in the `value` field of a symbol
 * data write: every '%' becomes '%25' before the form encoding (which then
 * sends it as '%2525').
 *
 * On RW 7.21.4 and RW 8.2.1 a RAPID string written through RWS reads back
 * with `%XX` decoded once more than the form layer requires (functional runs,
 * 2026-09-30): a correctly form-encoded `"%41"` read back as `"A"`, and
 * `"a&b=c<d>%25 e+f"` as `a&b=c<d>% e+f`. Only `%XX` is decoded again; '+',
 * '&', '=', '<', '>' and the space come back as written. The decode is on the
 * write: strings declared in RAPID read back exactly on all three builds, and
 * on RW 7.21.4 a RAPID routine sees the escaped write at its full StrLen and
 * equal to the same RAPID literal (2026-10-01; not run on RW 8.2.1, where the
 * routine needs the motors on from the pendant). With this escape the text
 * round-trips exactly. RW 6.16.03 (RWS 1.0) keeps the value as written and goes through
 * its own path, without this escape. Measured on string values only; a
 * record with a string field was not measured.
 */
/** The path of one task motion sub-read; INVALID_ARGUMENT, before anything is sent, for an empty task. */
function taskMotionPath(task: string, op: { rws2?: PathSpec }, what: string): string {
  if (typeof task !== 'string' || task.trim() === '') {
    throw new RwsError(`RWS2 ${what}: the task name must not be empty`, 'INVALID_ARGUMENT');
  }
  return buildPath(op.rws2 as PathSpec, { task });
}

const EAX_FIELDS = ['eax_a', 'eax_b', 'eax_c', 'eax_d', 'eax_e', 'eax_f'] as const;

/** One numeric field of a task motion entry; PARSE_ERROR when it is missing, blank or not a number. */
function taskMotionNumber(d: Record<string, string>, key: string, what: string): number {
  const raw = d[key];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw.trim());
  if (Number.isNaN(n)) {
    throw new RwsError(`RWS2 ${what}: "${key}" is ${raw === undefined ? 'missing' : `not a number ("${raw}")`}`, 'PARSE_ERROR');
  }
  return n;
}

function escapePercentForRws2Value(value: string): string {
  return value.replace(/%/g, '%25');
}

/**
 * The per-task loop behind `activateAllRapidTasks` and
 * `deactivateAllRapidTasks`: `send` for every task in turn, all under one
 * `hold`. A task that fails is recorded and the loop goes on, so one refused
 * task does not leave the later ones untouched. Two things end the loop early
 * and are thrown with the report so far in front: a refusal as "not held",
 * which means the operation's own hold is gone (the access manager records
 * the loss, and nothing more is sent under it), and a failure of the hold
 * itself.
 *
 * When every task was sent and any failed, one `RwsError` is thrown: the
 * first failed task's code, HTTP status, controller answer and refusal, with
 * a message - and a refusal sentence - naming the tasks that were done and
 * each failed task with the controller's reason.
 */
async function eachTask(
  verb: 'activate' | 'deactivate',
  tasks: readonly string[],
  hold: (fn: () => Promise<void>) => Promise<void>,
  send: (task: string) => Promise<unknown>,
): Promise<void> {
  const op = verb === 'activate' ? 'activateAllRapidTasks' : 'deactivateAllRapidTasks';
  const past = `${verb}d`;
  const done: string[] = [];
  const failed: Array<{ task: string; error: RwsError }> = [];
  let at = -1;
  const summary = (text: (e: RwsError) => string): string => {
    const ok = done.length > 0
      ? `${past.charAt(0).toUpperCase()}${past.slice(1)}: ${done.join(', ')}.`
      : `No task was ${past}.`;
    return ok + failed.map(f => ` ${f.task} was not ${past}: ${text(f.error)}`).join('');
  };
  try {
    await hold(async () => {
      for (at = 0; at < tasks.length; at++) {
        try {
          await send(tasks[at]);
          done.push(tasks[at]);
        } catch (e) {
          if (!(e instanceof RwsError) || isNotHeldRefusal(e)) { throw e; }
          failed.push({ task: tasks[at], error: e });
        }
      }
    });
  } catch (e) {
    const where = at < 0 ? `${op} stopped before any task was sent.`
      : at < tasks.length ? `${op} stopped at ${tasks[at]} (task ${at + 1} of ${tasks.length}); the tasks after it were not sent.`
        : `${op} failed after every task was sent.`;
    throw withReport(e, `${where} ${summary(f => f.message)}`);
  }
  if (failed.length === 0) { return; }
  const head = `${op}: ${failed.length} of ${tasks.length} task(s) not ${past}.`;
  const first = failed[0].error;
  const refusal = first.refusal
    ? { ...first.refusal, sentence: `${head} ${summary(f => f.refusal?.sentence ?? f.message)}` }
    : undefined;
  throw new RwsError(`${head} ${summary(f => f.message)}`,
    first.code, first.httpStatus, first.rwsDetail, first.controllerCode, first.controllerMsg, refusal);
}

/**
 * RAPID domain (`/rw/rapid`): execution, tasks, modules, symbols, program pointer, breakpoints, service routines.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 *
 * Access. Every write here that ABB gates by mastership holds `edit`
 * mastership around itself on RobotWare 7 and the control station's write
 * access on RobotWare 8 (`withAccess(['rapid'])`: `rapid` is RWS 2.0's `edit`,
 * and on RobotWare 8 every domain is the one write access). ABB's RWS pages
 * for RobotWare 7 say "Mastership is required on edit domain" for execution
 * start and cycle, PP to main and the per-task PP reset, the program-pointer
 * moves, breakpoints, task activation, module and program load, unload and
 * program save, module text, modify-position, hold-to-run and the RAPID
 * variable write ("When updating a rapid variable, mastership over rapid is
 * required"); the RobotWare 8 pages ask for write access on each. A hold the
 * session already has - a caller's, or an operation's in progress - is reused
 * and never ended by the write. Stop takes nothing (a stop never waits for
 * access), and the module save that `getModuleSource` round-trips through
 * TEMP takes nothing either (ABB lists no mastership for it, and on
 * RobotWare 7 it answered 204 without any).
 */
function rapidOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    async getRapidExecutionState(): Promise<ExecutionState> {
      const p = parse(await this.req('GET', R2.rapidExecution()));
      const d = requireState(p, ['rap-execution'], 'getRapidExecutionState');
      return (d['ctrlexecstate'] ?? 'stopped') as ExecutionState;
    }

    async getRapidExecutionInfo(): Promise<ExecutionInfo> {
      const p = parse(await this.req('GET', R2.rapidExecution()));
      // Live: <li class="rap-execution"><span class="ctrlexecstate">stopped</span><span class="cycle">forever</span>
      const d = p.getState('rap-execution');
      return {
        state: (d['ctrlexecstate'] ?? 'stopped') as ExecutionState,
        cycle: d['cycle'] ?? 'asis',
      };
    }

    /** RobotWare 8.2 and later: whether the most recent RAPID execution stop
     *  was caused by an error. ABB's `GET /rw/rapid/execution/execerrorstate`
     *  (RWS site, RAPID Service, RobotWare 8 view, "Since RW8.2.0"; not in
     *  Rev L): a TRUE/FALSE flag that goes back to FALSE when the program
     *  restarts. Entry `rap-execerrorstate`, field `execerrorstate`, as RW
     *  8.2.1 answered a raw GET (2026-10-06). Sent on any RWS 2.0 controller:
     *  RW 7.21.4 answered 404, passed on as the controller's typed error. An
     *  answer with no such entry, or a value other than TRUE or FALSE, is
     *  PARSE_ERROR. A read; it changes nothing. The client's read answered
     *  false on RW 8.2.1 (2026-10-21). */
    async getExecutionErrorState(): Promise<boolean> {
      const what = 'RWS2 getExecutionErrorState';
      const body = await this.req('GET', buildPath(RAPID.getExecutionErrorState.rws2 as PathSpec));
      const value = pickEntry(parse(body).getAllEntries(), ['rap-execerrorstate'], what)['execerrorstate'] ?? '';
      if (/^true$/i.test(value.trim())) { return true; }
      if (/^false$/i.test(value.trim())) { return false; }
      throw new RwsError(`${what}: the answer's execerrorstate is ${JSON.stringify(value)}, not TRUE or FALSE`, 'PARSE_ERROR');
    }

    /** Start execution. Holds `edit` only (RW8: write access): ABB's RWS 2.0
     *  start page says that with explicit mastership the client takes it on the
     *  edit domain alone, and a start with this session's own `motion` held was
     *  refused (live-verified 2026-09-15 on an RW 7.21 VC).
     *  RobotWare 8 also asks for the station's motion-control allowance
     *  (`setAllowMotionControl(true)`, after a person's confirmation), even for
     *  a program that does not move the robot: RW 8.2.1 refused a start
     *  without it with 403 -1073435864, which the client explains as
     *  `motion-control-off`, and ran it once it was allowed (2026-10-18). */
    async startRapid(): Promise<void> {
      const { path, body } = R2.startRapid();
      await this.withAccess(['rapid'], () => this.req('POST', path, body));
    }

    /** Stop execution. Sent at once, with no mastership or write access taken
     *  first: a stop must never wait for access. ABB's RWS 2.0 reference lists
     *  no prerequisite for execution/stop ("Pre-requisites: None"). A stop over
     *  RWS is a program stop, not a safety stop; use the emergency stop. */
    stopRapid(): Promise<void> {
      const { path, body } = R2.stopRapid();
      return this.req('POST', path, body).then(() => {});
    }

    /** Reset the program pointer to main. Holds edit mastership (RW8: write
     *  access) around it - live-verified 2026-08-04 (RW7.21): without it the
     *  controller answers MASTERSHIP_REQUIRED. A hold this session already has
     *  is reused and not ended. */
    async resetRapid(): Promise<void> {
      await this.withAccess(['rapid'], async () => {
        const { path } = R2.resetRapid();
        await this.req('POST', path);
      });
    }

    /** Set the execution cycle. Holds `edit` mastership (RW8: write access). */
    async setExecutionCycle(cycle: ExecutionCycle): Promise<void> {
      const { path, body } = R2.setExecutionCycle(cycle);
      await this.withAccess(['rapid'], () => this.req('POST', path, body));
    }

    /** Start RAPID execution from the production entry point (task list main).
     *  OPTIONS-verified 2026-08-04 (RW7.21): POST, no body. Acquires edit
     *  mastership internally (MASTERSHIP_REQUIRED without it, live-verified).
     */
    async startProductionEntry(): Promise<void> {
      await this.withAccess(['rapid'], async () => {
        const { path } = R2.startProductionEntry();
        await this.req('POST', path);
      });
    }

    /** Load a full RAPID program (.pgf + modules) into a task from disk. Distinct
     *  from loadModule (single module). OPTIONS-verified 2026-08-04 (RW7.21).
     *  Holds `edit` mastership (RW8: write access).
     */
    async loadProgram(task: string, progpath: string, loadmode: 'add' | 'replace' = 'replace'): Promise<void> {
      const { path, body } = R2.loadProgram(task, progpath, loadmode);
      await this.withAccess(['rapid'], () => this.req('POST', path, body));
    }

    /** Unload the program from a task, the counterpart of loadProgram: ABB's
     *  `POST /rw/rapid/tasks/{task}/program/unload`, no body, answered 204
     *  (RWS 2.0 Rev L "Unload Program from a RAPID Task", "Mastership is
     *  required"). Holds `edit` mastership (RW8: write access), as loadProgram;
     *  the controller decides the rest. RW 7.21.4 and 8.2.1 answered the
     *  client's unload 204 (2026-10-21). */
    async unloadProgram(task: string): Promise<void> {
      const path = buildPath(RAPID.unloadProgram.rws2 as PathSpec, { task });
      await this.withAccess(['rapid'], () => this.req('POST', path));
    }

    /** The build errors of a task's program: ABB's
     *  `GET /rw/rapid/tasks/{task}/program/builderror` (RWS 2.0 Rev L "Get
     *  Build Errors"), every page (at most 30 errors a page; the `next` link
     *  is followed). One entry per `rap-builderrs`: module, row, column, the
     *  error text and, when the answer carries them, the error number and the
     *  kind of error. `[]` when the program builds. A read; it changes nothing.
     *
     *  Read as XHTML, the form of ABB's Rev L example: RW 7.21.4 and 8.2.1
     *  write the error text into their hal+json unescaped (`"error" :
     *  "S:"zz_undeclared"<tab>"`), which is not JSON, so a hal+json read found
     *  no error and answered `[]` for a program that did not build. Their XHTML
     *  answer to the same request carries the errors (2026-10-21). */
    async getBuildErrors(task: string): Promise<RapidBuildError[]> {
      const first = buildPath(RAPID.getBuildErrors.rws2 as PathSpec, { task });
      const pages = await readPages(first, path => this.req('GET', path, undefined, undefined, undefined, [], ACCEPT_XHTML), BUILD_ERROR_PAGES);
      return buildErrorsFrom(pages, `RWS2 getBuildErrors(${task})`);
    }

    /** Save a task's currently loaded RAPID program to disk. OPTIONS-verified 2026-08-04.
     *  Holds `edit` mastership (RW8: write access): ABB's RWS pages list it for
     *  the program save, unlike the single-module save.
     */
    async saveProgram(task: string, destination: string): Promise<void> {
      const { path, body } = R2.saveProgram(task, destination);
      await this.withAccess(['rapid'], () => this.req('POST', path, body));
    }

    async getRapidTasks(): Promise<RapidTask[]> {
      const p = parse(await this.req('GET', buildPath(RAPID.getRapidTasks.rws2 as PathSpec)));
      return p.getAllStates('rap-task-li').map(t => ({
        name:       t['name'] ?? '',
        type:       t['type'] ?? 'normal',
        taskstate:  t['taskstate'] ?? '',
        excstate:   (t['excstate'] === 'running' ? 'running' : 'stopped') as ExecutionState,
        active:     t['active'] === 'On' || t['active'] === 'true',
        motiontask: t['motiontask'] === 'TRUE' || t['motiontask'] === 'True',
      }));
    }

    /**
     * One RAPID task's state and properties: `GET /rw/rapid/tasks/{task}`,
     * ABB's "Get RAPID Task State" (RAPID service, Rev L). RW 7.21.4+417 and
     * 8.2.1+1023 link `tasks/T_ROB1` from the task list (read 2026-09-29);
     * the single-task body has not been captured yet, so the `rap-task` entry
     * (else the task's `rap-task-li`) is returned as the controller gave it
     * (name, type, taskstate, excstate, active, motiontask, ...), and an
     * answer with neither is PARSE_ERROR. An unknown task is the controller's
     * typed refusal.
     */
    async getRapidTask(task: string): Promise<Record<string, string>> {
      if (typeof task !== 'string' || task.trim() === '') {
        throw new RwsError('RWS2 getRapidTask: the task name must not be empty', 'INVALID_ARGUMENT');
      }
      const p = parse(await this.req('GET', buildPath(RAPID.getRapidTask.rws2 as PathSpec, { task })));
      return rapidTaskFrom(p.getAllEntries(), task, 'RWS2 getRapidTask');
    }

    /** Activate one task: POST /rw/rapid/tasks/{task}/activate with no body,
     *  the per-task resource ABB documents and the controller serves (RW
     *  7.21.4 and 8.2.1). It used to post `task=` to the all-tasks resource,
     *  whose form has no fields (spec check 2026-10-07). Holds `edit`
     *  mastership (RW8: write access).
     */
    async activateRapidTask(task: string): Promise<void> {
      await this.withAccess(['rapid'], async () => {
        await this.req('POST', buildPath(RAPID.activateRapidTask.rws2 as PathSpec, { task }));
      });
    }

    /** Deactivate one task: POST /rw/rapid/tasks/{task}/deactivate, no body
     *  (see `activateRapidTask`).
     */
    async deactivateRapidTask(task: string): Promise<void> {
      await this.withAccess(['rapid'], async () => {
        await this.req('POST', buildPath(RAPID.deactivateRapidTask.rws2 as PathSpec, { task }));
      });
    }

    /**
     * Activate every task, each on its own per-task resource under one hold.
     * ABB does document an all-tasks POST /rw/rapid/tasks/activate (no
     * fields), but which tasks it covers (all, or the FlexPendant task-panel
     * selection) is unrecorded, so it is not used until a MultiMove run shows
     * it. A task the controller refuses does not stop the others; once all
     * were sent, the call throws if any was refused, naming each refused task
     * with the controller's reason and the tasks that were activated (see
     * `eachTask`). Up to 1.3.x per-task refusals were dropped and the call
     * resolved.
     */
    async activateAllRapidTasks(): Promise<void> {
      const tasks = await this.getRapidTasks();
      await eachTask('activate', tasks.map(t => t.name),
        fn => this.withAccess(['rapid'], fn), task => this.req('POST', buildPath(RAPID.activateRapidTask.rws2 as PathSpec, { task })));
    }

    /** Deactivate every task, one by one; refusals are reported as for `activateAllRapidTasks`. */
    async deactivateAllRapidTasks(): Promise<void> {
      const tasks = await this.getRapidTasks();
      await eachTask('deactivate', tasks.map(t => t.name),
        fn => this.withAccess(['rapid'], fn), task => this.req('POST', buildPath(RAPID.deactivateRapidTask.rws2 as PathSpec, { task })));
    }

    async listModules(task: string): Promise<string[]> {
      const p = parse(await this.req('GET', buildPath(RAPID.listModules.rws2 as PathSpec, { task })));
      return p.getAllStates('rap-module-info-li').map(m => m['name']).filter(Boolean) as string[];
    }

    /**
     * Returns each loaded module's name + type (SysMod | ProgMod | …).
     * Single round-trip - same endpoint as `listModules` but exposes more fields.
     */
    async listModulesDetailed(task: string): Promise<Array<{ name: string; type: string }>> {
      const p = parse(await this.req('GET', buildPath(RAPID.listModulesDetailed.rws2 as PathSpec, { task })));
      return p.getAllStates('rap-module-info-li')
        .map(m => ({ name: m['name'] ?? '', type: m['type'] ?? '' }))
        .filter(m => m.name);
    }

    async loadModule(task: string, path: string, replace = false): Promise<void> {
      // RWS 2.0 module-load endpoint: POST /rw/rapid/tasks/{task}/loadmod with `modulepath`.
      // (The /program/load endpoint is for full multi-module .pgf programs and uses a different
      // "virtual root" path scheme that doesn't accept user-uploaded HOME/* files.)
      //
      // The path needs to be in fileservice form WITHOUT the leading `$` - translate
      // `$HOME/...` → `HOME/...` so the same code works for callers passing either format.
      const modulePath = path.replace(/^\$HOME\//, 'HOME/').replace(/^\$/, '');
      const body: Record<string, string> = { modulepath: modulePath };
      if (replace) { body['replace'] = 'true'; }
      // Holds edit mastership (RW8: write access). Live-verified 2026-09-27:
      // on RW 7.21 loadmod answers 403 -1073445859 without edit and 200 with
      // it; on RW 8.1.1 it answers 403 -1073435873 without write access and
      // 200 with write access alone.
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(RAPID.loadModule.rws2 as PathSpec, { task }), body));
    }

    /** Unload a module. Holds `edit` mastership (RW8: write access). */
    async unloadModule(task: string, name: string): Promise<void> {
      // RWS 2.0 unload is path-based action: POST /rw/rapid/tasks/{task}/unloadmod
      // (DELETE on the module URL returns 405; only POST + body works.)
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(RAPID.unloadModule.rws2 as PathSpec, { task }), { module: name }));
    }

    /**
     * Read a RAPID symbol's current value, as the controller formats it.
     *
     * An answer with no value at all is an error, not an empty value.
     * Live-verified 2026-09-29 on RW 7.21.4: a num array over the read ceiling
     * (10200 elements; 10000 read in full) answers HTTP 200 with a self link
     * `symbol//data`, no `value` field, and error links to
     * `/rw/retcode?code=-1073445865` (SYS_CTRL_E_BUFFER_OVERFLOW). That was
     * returned as '', indistinguishable from a real value. It is now an
     * RwsError carrying the linked code: `INVALID_ARGUMENT` for the buffer
     * overflow, the code's mapping (else `UNKNOWN`) for another linked code,
     * and `PARSE_ERROR` when no code is linked either.
     *
     * A `value` that is present is returned as it is, even empty: a string
     * arrives quoted, and on RW 7.21.4 a VAR of a type with no printable
     * value (mecunit, signaldo) answers `"value" : ""` beside an error link.
     * RW 8.2.1 answers an over-ceiling read with `"value" : ""` and no link
     * (live-verified 2026-09-29), so there it still reads as ''.
     */
    async getRapidVariable(task: string, module: string, symbol: string): Promise<string> {
      // RWS 2.0 symbol API: suffix-style - /rw/rapid/symbol/{symburl}/data
      // (RWS 1.0 puts /data at the front: /rw/rapid/symbol/data/{symburl})
      const path = buildPath(RAPID.getRapidVariable.rws2 as PathSpec, { task, module, symbol });
      const body = await this.req('GET', path);
      const value = parse(body).get('value');
      if (value !== undefined) { return value; }
      const linked = body.match(/retcode\?code=(-?\d+)/)?.[1];
      const controllerCode = linked !== undefined ? Number(linked) : undefined;
      const at = `HTTP 200 from GET ${path}`;
      if (controllerCode === undefined) {
        throw new RwsError(`RWS2 getRapidVariable: the answer carried no value: ${at}`, 'PARSE_ERROR', 200, body);
      }
      const why = controllerCode === SYS_CTRL_E_BUFFER_OVERFLOW
        ? 'the value is too large for one RWS read (SYS_CTRL_E_BUFFER_OVERFLOW)'
        : `the controller linked error code ${controllerCode}`;
      throw new RwsError(
        `RWS2 getRapidVariable: no value, ${why}: ${at}`,
        codeForControllerCode(controllerCode) ?? 'UNKNOWN', 200, body, controllerCode,
      );
    }

    /**
     * Write a RAPID variable's current value. Holds `edit` mastership (RW8:
     * write access) around the write: ABB's RWS 2.0 RAPID service says "When
     * updating a rapid variable, mastership over rapid is required", and its
     * RobotWare 8 page asks for write access. Taken from ABB's documents; a
     * write without a hold has not been tried on our controllers, so what the
     * controller answers then is not recorded.
     *
     * Every '%' in `value` is sent escaped once more (as '%25' before the
     * form encoding): on RW 7.21.4 and RW 8.2.1 a string written without the
     * escape reads back with `%XX` decoded a second time (`"%41"` read back
     * as `"A"`; functional runs, 2026-09-30), and the decode is on the write
     * (see `escapePercentForRws2Value`). Pass the RAPID text as it should be;
     * the escape is this method's job.
     */
    async setRapidVariable(task: string, module: string, symbol: string, value: string): Promise<void> {
      const path = buildPath(RAPID.setRapidVariable.rws2 as PathSpec, { task, module, symbol });
      await this.withAccess(['rapid'], () => this.req('POST', path, { value: escapePercentForRws2Value(value) }));
    }

    /**
     * Validate a value against a RAPID data type without writing it.
     *
     * POST /rw/rapid/symbols/validate, the path ABB's RWS 2.0 RAPID service
     * documents ("Validate RAPID Variable", Rev L), with `task`, `value` and
     * `datatype`: the fields of the controller's own form for the resource
     * (OPTIONS `Allow: POST,OPTIONS`, form `validate` with task, datatype and
     * value, on RW 7.21.4+417 and 8.2.1+1023, 2026-10-01).
     *
     * Not a check of the value on those builds: both answered 204 to every
     * value sent, `42` as num and `[1,2,3]` as pos, but also the malformed
     * `[1,2` as pos, `"zz"` as num and `[1,2]` as pos, and the same with the
     * datatype as a type URL (`RAPID/num`) (2026-10-01). So `true` means only
     * that the controller did not refuse the request; it does not mean the
     * value is valid. RW 6.16.03 behaves the same on its RWS 1.0 form.
     *
     * @returns `true` when the controller accepts the value; `false` for the
     *   controller's validation refusal: every 400 that does not name an
     *   access control (mastership, write access, a grant, remote access,
     *   RMMP, the operating mode, the session), and a 2xx answer that carries
     *   an error status. A malformed literal may well be refused
     *   SYS_CTRL_E_RAPID_SYNTAX_ERROR, which the refusal classifier reads as
     *   a program-state refusal; here it is the value's refusal, so `false`,
     *   as on RWS 1.0, which answers `false` for every 400. Anything else (a
     *   missing path, a transport failure, an access refusal) throws a typed
     *   `RwsError`. Which code RWS 2.0 answers for a bad value is not
     *   recorded.
     */
    async validateRapidValue(task: string, value: string, datatype: string): Promise<boolean> {
      const path = buildPath(RAPID.validateRapidValue.rws2 as PathSpec);
      let body: string;
      try {
        body = await this.req('POST', path, { task, value, datatype });
      } catch (e) {
        if (e instanceof RwsError) {
          // A 400 is the validation answer unless it names an access control
          // someone has to supply; those still throw, so a caller can tell
          // "the value is wrong" from "this session may not ask".
          if (e.httpStatus === 400 && !(e.refusal && ACCESS_CONDITIONS.has(e.refusal.condition))) { return false; }
          throw e;
        }
        throw new RwsError(`RWS2 validateRapidValue failed: ${String(e)}`, 'UNKNOWN');
      }
      return body.trim() === '' || parse(body).getError() === null;
    }

    async getRapidSymbolProperties(task: string, module: string, symbol: string): Promise<RapidSymbolProperties> {
      const p = parse(
        await this.req('GET', buildPath(RAPID.getRapidSymbolProperties.rws2 as PathSpec, { task, module, symbol }))
      );
      // The class encodes the symbol KIND: rap-sympropvar (VAR),
      // rap-symproppers (PERS - e.g. tool0, live-verified 2026-08),
      // rap-sympropconstant (CONST), rap-sympropfunction (FUNC),
      // rap-sympropproc (PROC). Only the VAR spelling was checked before, so
      // persistents parsed as empty.
      //
      // Constants and functions were looked for as rap-sympropconst and
      // rap-sympropfun, which the controller never sends: live-verified
      // 2026-09-29 on RW 7.21.4 and RW 8.2.1, the symbol search lists them as
      // rap-sympropconstant-li and rap-sympropfunction-li, and 2026-09-30 a
      // CONST properties read on both matched none of the old spellings. Each
      // CONST then came back as an all-empty record (symtyp '', dattyp '',
      // ndim 0). The properties spelling is the search class without `-li`,
      // as for every kind recorded both ways (RW 6.16.03 answers
      // rap-sympropconstant). The short spellings stay as fallbacks. A
      // response with none of these blocks is now PARSE_ERROR, as on RWS 1.0,
      // instead of a record of defaults.
      const d = requireState(p, ['rap-sympropvar', 'rap-symproppers', 'rap-sympropconstant',
        'rap-sympropfunction', 'rap-sympropproc', 'rap-symproptrap', 'rap-sympropmod',
        'rap-sympropconst', 'rap-sympropfun', 'rap-sympropvar-li', 'rap-symbol-properties'],
      'getRapidSymbolProperties');
      return {
        symburl: d['symburl'] ?? `RAPID/${task}/${module}/${symbol}`,
        symtyp:  d['symtyp']  ?? '',
        named:   d['named']   === 'true',
        dattyp:  d['dattyp']  ?? '',
        ndim:    Number(d['ndim']   ?? 0),
        dim:     d['dim']     ?? '',
        heap:    d['heap']    === 'true',
        linked:  d['linked']  === 'true',
        local:   d['local']   === 'true',
        ro:      d['rdonly']  === 'true' || d['ro'] === 'true',
        taskvar: d['taskvar'] === 'true',
        storage: d['storage'] ?? '',
        typurl:  d['typurl']  ?? '',
      };
    }

    async searchRapidSymbols(params: RapidSymbolSearchParams): Promise<RapidSymbolInfo[]> {
      // RWS 2.0 /rw/rapid/symbols/search expects view=block + blockurl + symtyp=any
      // (NOT a `task` field - that returns 400 "Invalid parameter").
      // It returns one <li> per match. The `class` of the <li> tells you the kind:
      //   rap-sympropvar-li      → variable (VAR)
      //   rap-symproppers-li     → persistent (PERS)
      //   rap-sympropconstant-li → constant (CONST)
      //   rap-sympropproc-li     → procedure (PROC)
      //   rap-sympropfunction-li → function (FUNC)
      //   rap-sympropmod-li      → module
      // Earlier versions only parsed vars - missing all the routines.
      //
      // Live-verified 2026-09-29 on RW 7.21.4 and RW 8.2.1: constants and
      // functions are rap-sympropconstant-li and rap-sympropfunction-li. This
      // list had rap-sympropconst-li and rap-sympropfun-li, never seen live,
      // so every CONST and FUNC hit was dropped from every search (and FUNCs
      // from RobotManager.listRoutines). The short spellings stay as
      // fallbacks. The trap class is not recorded yet.
      const body: Record<string, string> = {};
      if (params.view)      { body['view']      = params.view; }
      if (params.vartyp)    { body['vartyp']    = params.vartyp; }
      if (params.symtyp)    { body['symtyp']    = params.symtyp; }
      if (params.dattyp)    { body['dattyp']    = params.dattyp; }
      if (params.regexp)    { body['regexp']    = params.regexp; }
      if (params.recursive !== undefined) { body['recursive'] = String(params.recursive); }
      if (params.blockurl)  { body['blockurl']  = params.blockurl; }
      // Sensible defaults so callers can pass just `{ blockurl }`
      if (!body['view'])      { body['view']     = 'block'; }
      if (!body['symtyp'])    { body['symtyp']   = 'any'; }
      if (!body['recursive']) { body['recursive']= 'TRUE'; }

      const xhtml = await this.req('POST', buildPath(RAPID.searchRapidSymbols.rws2 as PathSpec), body);
      const liClasses = [
        'rap-sympropvar-li',
        // 'rap-symproppers-li' was spelled 'rap-syproppers-li' here (missing the
        // 'm'), so persistents - tool0, wobj0, load0, the most common symbols on
        // any controller - were silently dropped from every search result.
        // Live-verified spelling 2026-08 on RW7.21/RW8.1.1.
        'rap-symproppers-li',
        'rap-sympropconstant-li',
        'rap-sympropconst-li',
        'rap-sympropproc-li',
        'rap-sympropfunction-li',
        'rap-sympropfun-li',
        'rap-sympropmod-li',
        'rap-symproptrap-li',
      ];
      const out: RapidSymbolInfo[] = [];
      for (const cls of liClasses) {
        const p = parse(xhtml);
        for (const s of p.getAllStates(cls)) {
          out.push({
            symburl: s['symburl'] ?? '',
            name:    s['name']    ?? '',
            symtyp:  s['symtyp']  ?? '',
            dattyp:  s['dattyp']  ?? '',
            ndim:    Number(s['ndim'] ?? 0),
            local:   s['local']   === 'true',
            ro:      s['rdonly']  === 'true',
            taskvar: s['taskvar'] === 'true',
          });
        }
      }
      return out;
    }

    async getActiveUiInstruction(): Promise<UiInstruction | null> {
      try {
        const p = parse(await this.req('GET', buildPath(RAPID.getActiveUiInstruction.rws2 as PathSpec)));
        // ABB documents the entry as class `rap-uiactive-li` (RWS 2.0 Rev L,
        // "Get Active UI Instruction"), which is what RW 7.21.4 answered in
        // hal+json for a running TPReadNum (2026-10-11); the older
        // rap-uiinstr classes are still read.
        const d = [p.getState('rap-uiactive-li'), p.getState('rap-uiinstr-li'), p.getState('rap-uiinstr')]
          .find(s => s['instr']) ?? {};
        if (!d['instr']) { return null; }
        return { instr: d['instr'], event: d['event'] ?? '', stack: d['stack'] ?? '', execlv: d['execlv'] ?? '', msg: d['msg'] ?? '' };
      } catch { return null; }
    }

    /**
     * Answer the active UI instruction (TPReadNum, TPReadFK, ...). Holds `edit`
     * mastership (RW8: write access). ABB's RWS 2.0 page says "Mastership is
     * required" without naming the domain, and the PC SDK's answer to a UI
     * instruction needs RAPID mastership, which is RWS 2.0's `edit`; that the
     * controller checks `edit` here has not been observed.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void> {
      // RWS 2.0: POST /rw/rapid/uiinstr/active/param/{stackurl}/{uiparam}
      const path = buildPath(RAPID.setUiInstructionParam.rws2 as PathSpec, { stackurl, uiparam });
      await this.withAccess(['rapid'], () => this.req('POST', path, { value }));
    }

    /** Step the program pointer back one instruction (manual-mode debugger).
     *  Holds `edit` mastership (RW8: write access).
     */
    async ppPrevInst(task: string): Promise<void> {
      const { path } = R2.ppPrevInst(task);
      await this.withAccess(['rapid'], () => this.req('POST', path));
    }

    /** Step the program pointer forward one instruction (manual-mode debugger).
     *  Holds `edit` mastership (RW8: write access).
     */
    async ppNextInst(task: string): Promise<void> {
      const { path } = R2.ppNextInst(task);
      await this.withAccess(['rapid'], () => this.req('POST', path));
    }

    /** Set the program pointer to a routine by its URL, `/RAPID/{task}/{module}/{routine}`
     *  as ABB's sample gives it, with `userlevel` (false unless asked); see
     *  ResourceMapper2.setPPToRoutineFromUrl for the recorded answers. Holds
     *  `edit` mastership (RW8: write access).
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async setPPToRoutineFromUrl(task: string, routineurl: string, userlevel: boolean | string = false): Promise<void> {
      const { path, body } = R2.setPPToRoutineFromUrl(task, routineurl, userlevel);
      await this.withAccess(['rapid'], () => this.req('POST', path, body));
    }

    /** Full source text of a module straight from program memory, with its change
     *  count. Class rap-module-text (spans change-count, module-text). Unlike
     *  getModuleSource this needs no TEMP round trip, but it is RWS 2.0 only.
     *  In the XHTML representation the module-text span carries XML entities,
     *  decoded here once (`&amp;` last), as for getModuleTextRange; the
     *  hal+json string is returned as read. */
    async getModuleText(task: string, module: string): Promise<{ text: string; changeCount: number }> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.getModuleText.rws2 as PathSpec, { task, module })));
      const d = p.getState('rap-module-text');
      const text = d['module-text'] ?? '';
      return {
        text: p instanceof XhtmlParser ? decodeEntities(text) : text,
        changeCount: Number((d['change-count'] ?? '0').trim()),
      };
    }

    /** A source range of a module (rows/columns are 1-based). Class rap-mod-text.
     *  In the XHTML representation (the client falls back to it when a
     *  controller does not serve hal+json) the span text carries XML entities,
     *  and the XHTML parser does not decode span values, so they are decoded
     *  here, once (`&amp;` last). The hal+json string is returned as read. */
    async getModuleTextRange(task: string, module: string, startRow: number, startCol: number, endRow: number, endCol: number): Promise<string> {
      const p = parse(await this.req(
        'GET', `${buildPath(RAPID.getModuleTextRange.rws2 as PathSpec, { task, module })}?startrow=${startRow}&startcol=${startCol}&endrow=${endRow}&endcol=${endCol}`));
      const text = p.getState('rap-mod-text')['text'] ?? '';
      return p instanceof XhtmlParser ? decodeEntities(text) : text;
    }

    /** Search a module's source for a string. The query parameter is `text` (the
     *  documented `searchstring` answers "Search Text invalid"); each hit is a
     *  rap-text-position with capitalized Row/Column spans (live RW7.21/RW8.1.1). */
    async searchModuleText(task: string, module: string, text: string): Promise<Array<{ row: number; column: number }>> {
      const p = parse(await this.req(
        'GET', `${buildPath(RAPID.searchModuleText.rws2 as PathSpec, { task, module })}?text=${encodeURIComponent(text)}`));
      return p.getAllStates('rap-text-position').map(d => ({
        row: Number(d['Row'] ?? 0), column: Number(d['Column'] ?? 0),
      }));
    }

    /**
     * Change count of one module (class rap-module-changecount, span count).
     */
    async getModuleChangeCount(task: string, module: string): Promise<number> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.getModuleChangeCount.rws2 as PathSpec, { task, module })));
      return Number(p.getState('rap-module-changecount')['count'] ?? 0);
    }

    /**
     * SyncPers status of a module (class rap-syncper-status).
     */
    async getModuleSyncPersStatus(task: string, module: string): Promise<boolean> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.getModuleSyncPersStatus.rws2 as PathSpec, { task, module })));
      return (p.getState('rap-syncper-status')['syncperstatus'] ?? '0') === '1';
    }

    /** Module extension info: line count, max column, change count
     *  (class rap-module-extension).
     */
    async getModuleExtension(task: string, module: string): Promise<{ lines: number; maxColumns: number; changeCount: number }> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.getModuleExtension.rws2 as PathSpec, { task, module })));
      const d = p.getState('rap-module-extension');
      return { lines: Number(d['num-of-lines'] ?? 0), maxColumns: Number(d['max-num-of-col'] ?? 0), changeCount: Number(d['count'] ?? 0) };
    }

    /**
     * Whether modification (ModPos) is possible across all modules.
     * GET /rw/rapid/modules - RWS 2.0 only; on RWS 1.0 the same path is the
     * module list (`listModules`), a different operation.
     *
     * ABB's RAPID Service page names it "Get Mod Possible All". The resource is
     * linked from /rw/rapid on RW 7.21.4+417 and 8.2.1+1023 (2026-09-29); its
     * item classes are not recorded (a RobotWare 7.21.0 VC answered with no
     * entries on 2026-05-04, RW 7.21.4 and 8.2.1 the same on 2026-10-01), so
     * every entry is returned as read: its class as `_type`, `_title`, `_href`
     * and its fields. An empty list is that empty answer.
     */
    async getModPossibleAll(): Promise<Array<Record<string, string>>> {
      const p = parse(await this.req('GET', buildPath(RAPID.getModPossibleAll.rws2 as PathSpec)));
      return p.getAllEntries();
    }

    /**
     * Whether modification (ModPos) is possible in one module.
     * GET /rw/rapid/tasks/{task}/modules/{module}/mod-possible.
     *
     * ABB's RAPID Service page names it "Get Mod Possible"; the module links it
     * (rap-module-mod-possible-li) on RW 7.21.4+417 and 8.2.1+1023
     * (2026-09-29). A bare GET was refused 400 asking for `endrow` on a
     * RobotWare 7.21.0 VC (2026-05-04), so the resource wants a text range:
     * pass it in `query` (e.g. `{ startrow: 1, startcol: 1, endrow: 26,
     * endcol: 1 }`, the names getModuleTextRange uses). The parameter set is
     * not documented; RW 7.21.4 and 8.2.1 refused a bare GET 400 "endrow URL
     * parameter is required" and answered those four with one
     * `rap-module-mod-possible` entry carrying `no_lines_modifiable`
     * (2026-10-01). Every entry is returned as read (`_type`, `_title`,
     * `_href`, fields).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task or module or a query value that is not a string or a finite
     *   number; the controller's refusal of a missing parameter is thrown as
     *   answered.
     */
    async getModuleModPossible(task: string, module: string, query?: RapidModuleQuery): Promise<Array<Record<string, string>>> {
      const path = buildPath(RAPID.getModuleModPossible.rws2 as PathSpec, moduleParams('getModuleModPossible', task, module));
      const p = parse(await this.req('GET', path + queryString('getModuleModPossible', query)));
      return p.getAllEntries();
    }

    /**
     * A module's symbol resource. GET /rw/rapid/tasks/{task}/modules/{module}/symbol.
     *
     * ABB's RAPID Service page names it "Get Symbol Information"; the module
     * links it (rap-module-symbol-li) on RW 7.21.4+417 and 8.2.1+1023
     * (2026-09-29). Its item classes are not recorded: a bare GET answered 200
     * with no entry on RW 7.21.4 and 8.2.1 for a module holding data and
     * routines (2026-10-01), so the resource likely wants parameters no
     * document names. Every entry is returned as read (`_type`, `_title`,
     * `_href`, fields); `query` is passed through for parameters the resource
     * takes. `listModuleSymbols` reads the module's symbols through
     * symbols/search on both generations and is the typed route.
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task or module or a bad query value.
     */
    async getModuleSymbolInfo(task: string, module: string, query?: RapidModuleQuery): Promise<Array<Record<string, string>>> {
      const path = buildPath(RAPID.getModuleSymbolInfo.rws2 as PathSpec, moduleParams('getModuleSymbolInfo', task, module));
      const p = parse(await this.req('GET', path + queryString('getModuleSymbolInfo', query)));
      return p.getAllEntries();
    }

    /**
     * A module's possible attributes.
     * GET /rw/rapid/tasks/{task}/modules/{module}/attributes.
     *
     * ABB's RAPID Service page names it "Get Module Possible Attributes"; the
     * module links it (rap-module-possible-attributes-li) on RW 7.21.4+417 and
     * 8.2.1+1023 (2026-09-29). The required query parameter is `attribute`
     * (Rev L), with the values noview, nostepin, viewonly, readonly and
     * systemmod, several grouped as `attribute=[nostepin,readonly]`: pass it
     * in `query`. The controller's 400 text says "attrib parameter not
     * provided", but `attrib=` is refused with the same text, while
     * `attribute=nostepin` and `attribute=[nostepin]` answer 200
     * rap-posattribs (RW 7.21.4 and 8.2.1, 2026-10-07/09). The earlier note
     * that no value was accepted came from sending the name in the error text
     * (2026-10-01). Every entry is returned as read (`_type`, `_title`,
     * `_href`, fields).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task or module or a bad query value.
     */
    async getModuleAttributes(task: string, module: string, query?: RapidModuleQuery): Promise<Array<Record<string, string>>> {
      const path = buildPath(RAPID.getModuleAttributes.rws2 as PathSpec, moduleParams('getModuleAttributes', task, module));
      const p = parse(await this.req('GET', path + queryString('getModuleAttributes', query)));
      return p.getAllEntries();
    }

    /**
     * A module's RAPID object resource.
     * GET /rw/rapid/tasks/{task}/modules/{module}/object.
     *
     * ABB's RAPID Service page names it "Get RAPID Object"; the module links it
     * (rap-module-object-li) on RW 7.21.4+417 and 8.2.1+1023 (2026-09-29). A
     * bare GET answered with the object at row 1, column 1 on a RobotWare
     * 7.21.0 VC (2026-05-04), and on RW 7.21.4 and 8.2.1 with one `rap-object`
     * entry spanning the whole module (`start-row` 1 to `end-row` its last
     * line, 2026-10-01); a position is presumably chosen with query
     * parameters, passed through `query`, which are not documented. Every
     * entry is returned as read (`_type`, `_title`, `_href`, fields).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task or module or a bad query value.
     */
    async getModuleObject(task: string, module: string, query?: RapidModuleQuery): Promise<Array<Record<string, string>>> {
      const path = buildPath(RAPID.getModuleObject.rws2 as PathSpec, moduleParams('getModuleObject', task, module));
      const p = parse(await this.req('GET', path + queryString('getModuleObject', query)));
      return p.getAllEntries();
    }

    /**
     * Program-pointer sync state across all tasks (class rap-sync-state).
     */
    async getProgramPointerSyncState(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(RAPID.getProgramPointerSyncState.rws2 as PathSpec)));
      return p.getState('rap-sync-state')['program-pointer-state'] ?? 'unknown';
    }

    /**
     * Motion-pointer sync state across all tasks (class rap-sync-state).
     */
    async getMotionPointerSyncState(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(RAPID.getMotionPointerSyncState.rws2 as PathSpec)));
      return p.getState('rap-sync-state')['motion-pointer-state'] ?? 'unknown';
    }

    /** RAPID spy (execution trace) logging status, e.g. 'Not Logging'
     *  (class rap-spy-status).
     */
    async getSpyStatus(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(RAPID.getSpyStatus.rws2 as PathSpec)));
      return p.getState('rap-spy-status')['status'] ?? 'unknown';
    }

    /**
     * RAPID instruction catalog: the categories the pendant groups instructions
     * into (Common, Prog.Flow, Motion&Proc., I/O, ...). Undocumented resource
     * found by crawling the task tree (class rap-pallet-head). Pair with
     * listInstructions() to build an instruction picker.
     */
    async listInstructionCategories(task: string): Promise<Array<{ number: number; name: string }>> {
      const p = parse(await this.req('GET', buildPath(RAPID.listInstructionCategories.rws2 as PathSpec, { task })));
      return p.getAllStates('rap-pallet-head').map(d => ({
        number: Number(d['Number'] ?? 0), name: d['Name'] ?? '',
      })).filter(c => c.name);
    }

    /**
     * RAPID instructions in one catalog category (class rap-pallet; spans Name,
     * Instruction, Parameter, Alternative, Keyword). Undocumented resource; the
     * category number comes from listInstructionCategories().
     */
    async listInstructions(task: string, category: number): Promise<Array<Record<string, string>>> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.listInstructions.rws2 as PathSpec, { task, category })));
      return p.getAllStates('rap-pallet');
    }

    /** List callable service routines of a task. Live-verified 2026-08-04 on RW7.21
     *  and RW8.1.1 VCs: class rap-task-routine, spans routine_name / url_to_routine
     *  (RWS 1.0 spells them with hyphens - both read for safety). */
    async listServiceRoutines(task: string): Promise<Array<{ name: string; url: string }>> {
      try {
        const p = parse(await this.req('GET', buildPath(RAPID.listServiceRoutines.rws2 as PathSpec, { task })));
        return p.getAllStates('rap-task-routine')
          .map(d => ({ name: d['routine_name'] ?? d['routine-name'] ?? '', url: d['url_to_routine'] ?? d['url-to-routine'] ?? '' }))
          .filter(x => x.name);
      } catch { return []; }
    }

    /**
     * NOTE (RWS 2.0): there is no direct "call service routine" endpoint. POST to
     * /rw/rapid/tasks/{task}/serviceroutine answers HTTP 405 (the resource is
     * GET-only - see listServiceRoutines), live-verified 2026-08 on RW7.21/RW8.1.1.
     * On RWS 2.0 a service routine is invoked by setting the program pointer to it
     * (setProgramPointer / setPPToRoutineFromUrl) and then starting execution -
     * which is a motion-producing operation and must be gated accordingly. This
     * method is kept for source compatibility and throws `RwsError`
     * `UNSUPPORTED_OPERATION` before anything is sent: ABB's Rev L documents
     * the resource as a GET listing and the controller advertises Allow
     * GET,OPTIONS (RW 7.21.4 and 8.2.1, 2026-10-09). It used to POST and get
     * the 405 (spec check 2026-10-07).
     */
    async callServiceRoutine(task: string, routineName: string, args: Record<string, string> = {}): Promise<void> {
      void args;
      throw new RwsError(
        `RWS 2.0 has no operation that calls a service routine ('${routineName}' in task '${task}'): set the program pointer to it (setPPToRoutine / setPPToRoutineFromUrl) and start execution`,
        'UNSUPPORTED_OPERATION',
      );
    }

    /**
     * Read the Cartesian robtarget of a mechanical unit relative to a specific tool
     * and work object. Distinct from getCartesianFull (which reads /cartesian with
     * configuration flags and no tool/wobj). GET /rw/motionsystem/mechunits/{m}/robtarget,
     * live-verified 2026-08-04 (RW7.21, class ms-robtargets).
     */
    async getRobTarget(mechunit = 'ROB_1', tool = 'tool0', wobj = 'wobj0'): Promise<RobTarget> {
      const p = parse(await this.req(
        'GET',
        `${buildPath(MOTION.getRobTarget.rws2 as PathSpec, { mechunit })}?tool=${encodeURIComponent(tool)}&wobj=${encodeURIComponent(wobj)}`,
      ));
      const d = p.getState('ms-robtargets');
      return {
        x: +d['x'], y: +d['y'], z: +d['z'],
        q1: +d['q1'], q2: +d['q2'], q3: +d['q3'], q4: +d['q4'],
      };
    }

    /**
     * Set the program pointer to a routine. The endpoint's own OPTIONS form
     * accepts `routine`, `module` and `userlevel` only - it has no row/column
     * fields, so the previously sent begin-position-row/col were not part of the
     * form (use setPPToCursor for a source position). They are no longer sent;
     * the parameters stay in the signature for source compatibility and now map
     * to the cursor endpoint's job. Verified against the live form 2026-08.
     */
    async setProgramPointer(task: string, params: { module?: string; routine: string; row?: number; col?: number; userlevel?: string }): Promise<void> {
      const body: Record<string, string> = { routine: params.routine };
      if (params.module) { body['module'] = params.module; }
      if (params.userlevel) { body['userlevel'] = params.userlevel; }
      // Holds edit mastership (RW8: write access).
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(RAPID.setProgramPointer.rws2 as PathSpec, { task }), body));
    }

    /** Set the program pointer to a source position: form fields `module`,
     *  `line`, `column`, as the controller's cursor form (RW 7.21.4, 8.2.1)
     *  and Rev L name them; this used to send begin-position-row/-col (spec
     *  check 2026-10-07). Holds `edit` mastership (RW8: write access).
     */
    async setPPToCursor(task: string, module: string, row: number, col: number): Promise<void> {
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(RAPID.setPPToCursor.rws2 as PathSpec, { task }), {
          module,
          line: String(row),
          column: String(col),
        }));
    }

    /**
     * Single-step RAPID. There is NO /rw/rapid/tasks/{task}/step resource (it 404s,
     * live-verified 2026-08-04 on RW7.21); stepping is the START endpoint with a
     * step `execmode`. The OPTIONS form of /rw/rapid/execution/start advertises
     * execmode = stepin | stepover | stepout | stepback | steplast | stepmotion.
     * Requires MANUAL mode (in AUTO the controller answers 403 "Current execution
     * state does not allow this operation") plus motors on and a loaded program.
     */
    async stepRapid(_task: string, mode: 'into' | 'over' | 'out'): Promise<void> {
      const execmode = mode === 'into' ? 'stepin' : mode === 'over' ? 'stepover' : 'stepout';
      // A step is a start with a step execmode, so it holds what a start holds:
      // edit only (RW8: write access).
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(RAPID.stepRapid.rws2 as PathSpec), {
          regain: 'continue', execmode, cycle: 'asis',
          condition: 'none', stopatbp: 'disabled', alltaskbytsp: 'false',
        }));
    }

    /**
     * Hold-to-run (dead-man) control. POST /rw/rapid/execution/holdtorun, field
     * `state` (not /tasks/{task}/holdtorun with `action`, which 404s - fixed
     * 2026-08-04). `state` is press, held or release: ABB documents sending
     * `held` about every 2 s to keep the motion going. `press` is an accepted
     * value; hold-to-run is a MANUAL-mode function, so in AUTO the controller
     * rejects the operation on execution state.
     *
     * Holds `edit` mastership (RW8: write access) around each call. ABB's RWS
     * pages also require a local client (RobotWare 7) or a local control
     * station (RobotWare 8), and document it for virtual controllers only;
     * this client always connects as a remote client.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async holdToRun(_task: string, action: 'press' | 'held' | 'release'): Promise<void> {
      // RobotWare 8 answers the usual `application/x-www-form-urlencoded;v=2.0`
      // with 415 -1073414146 "Content type is not supported. Use Content type
      // as 'application/x-www-form-urlencoded' for POST request" (RW 8.2.1,
      // 2026-10-11), so the plain type is sent there. RobotWare 7 takes the
      // versioned type (RW 7.21.4 accepted the request far enough to answer
      // 400 icode 107938816 with the VC in Auto, where hold-to-run does not
      // apply; the tokens press, held and release are ABB's).
      const path = buildPath(RAPID.holdToRun.rws2 as PathSpec);
      const body = `state=${action}`;
      const rw8 = Number((this.cachedRobotWareVersion() ?? '').split('.')[0]) >= 8;
      await this.withAccess(['rapid'], () => (rw8
        ? this.req('POST', path, undefined, body, 'application/x-www-form-urlencoded')
        : this.req('POST', path, { state: action })));
    }

    async listBreakpoints(task: string): Promise<Array<{ module: string; row: number; col?: number }>> {
      try {
        // GET /rw/rapid/tasks/{task}/program/breakpoints. ABB documents the
        // entries as class `rap-program-breakpoint` with spans module-name,
        // start-row, start-col, end-row, end-col (RWS 2.0 Rev L "Get Break
        // Points"). The earlier guess (`rap-breakpoint-li` with module / row /
        // column) is still read, so a controller that answers that way is not
        // read as empty. The set written on RW 7.21.4 (2026-10-11) answered
        // 2xx and this read listed nothing under the guessed class; whether
        // the documented class was in the answer is not recorded.
        const p = parse(await this.req('GET', buildPath(RAPID.listBreakpoints.rws2 as PathSpec, { task })));
        const documented = p.getAllStates('rap-program-breakpoint').map(b => ({
          module: b['module-name'] ?? b['module'] ?? '',
          row: +(b['start-row'] ?? b['row'] ?? '0'),
          col: b['start-col'] ? +b['start-col'] : (b['column'] ? +b['column'] : undefined),
        }));
        if (documented.length > 0) { return documented; }
        return p.getAllStates('rap-breakpoint-li').map(b => ({
          module: b['module'] ?? b['modulename'] ?? '',
          row: +(b['row'] ?? b['begin-position-row'] ?? '0'),
          col: b['column'] ? +b['column'] : (b['begin-position-col'] ? +b['begin-position-col'] : undefined),
        }));
      } catch { return []; }
    }

    /**
     * Set a breakpoint. The controller's OPTIONS form lists fields
     * `module` / `row` / `column` - the previous `begin-position-row/col` names
     * were rejected with "row parameter invalid or missing" (fixed 2026-08-04,
     * RW7.21). The row must be an executable source position or the controller
     * answers 400 "The given source position is illegal". `column` defaults to 1.
     */
    async setBreakpoint(task: string, module: string, row: number, col = 1): Promise<void> {
      // Holds edit mastership (RW8: write access), as ABB's RWS pages require
      // for setting and clearing breakpoints.
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(RAPID.setBreakpoint.rws2 as PathSpec, { task }),
          { module, row: String(row), column: String(col) }));
    }

    /**
     * Remove a breakpoint: POST /rw/rapid/tasks/{task}/program/breakpoints/remove
     * with `module`, `row` and `columno`. The field is spelled `columno`, not
     * `column`, because that is how the controller's own form spells it: RW 7.21.4
     * and RW 8.2.1 answer OPTIONS on the `remove` resource with
     * `Allow: POST,OPTIONS` and the form `clear-breakpoint` (module, row,
     * columno), read 2026-09-29. The previous DELETE on program/breakpoints
     * answered 405. `col` defaults to 1, as in setBreakpoint.
     *
     * Holds edit mastership (RW8: write access), like setBreakpoint.
     * Built-not-run: the form was read, the remove was not sent.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async removeBreakpoint(task: string, module: string, row: number, col = 1): Promise<void> {
      // Fields module, row, column as ABB documents them. The controller's
      // OPTIONS form spells the third one `columno`, which it then refuses
      // (400 "Column parameter invalid or missing", RW 7.21.4 and 8.2.1,
      // 2026-10-11).
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(RAPID.removeBreakpoint.rws2 as PathSpec, { task }),
          { module, row: String(row), column: String(col) }));
    }

    /**
     * Read a module's source by round-tripping it through the TEMP volume.
     * Live-verified 2026-07-08 on OmniCore VC RW7.21:
     *   POST /rw/rapid/tasks/{task}/modules/{module}/save  body name=<tmp>&path=TEMP:
     *   → 204, no mastership required. The controller ALWAYS appends '.modx' to
     *   the given name (even for SysMod modules - never '.sysx'), so the name is
     *   passed without extension. TEMP: avoids any risk of clobbering HOME files.
     *
     * File I/O (readFile/deleteFile) lives in the files domain; this rapid helper
     * reaches it through the composed client instance.
     */
    private async readModuleViaSave(task: string, moduleName: string): Promise<string> {
      const tmp = `${moduleName}_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
      const { path, body } = R2.saveModuleAs(task, moduleName, tmp, 'TEMP:');
      await this.req('POST', path, body);
      const files = this as unknown as FilesMethods;
      try {
        return await files.readFile(`TEMP/${tmp}.modx`);
      } finally {
        await files.deleteFile(`TEMP/${tmp}.modx`).catch(() => {});
      }
    }

    async getModuleSource(task: string, moduleName: string): Promise<string> {
      // Program memory is the source of truth - the save round-trip reads it
      // directly, so it is the PRIMARY path. A direct file read can return a
      // stale on-disk copy (module edited in memory, or a leftover HOME file
      // shadowing a module that was actually loaded from .pgf / RobotStudio),
      // and module metadata exposes no reliable backing path to trust: the
      // per-module GET only carries a bare `filename` span (live-verified
      // 2026-07-09 on OmniCore VC RW7.21 - no path/file-path field exists).
      try {
        return await this.readModuleViaSave(task, moduleName);
      } catch {
        // Save endpoint failed (permissions, disk, transient) - fall back to the
        // backing file named by metadata, or the conventional HOME location.
        const info = await this.getModuleInfo(task, moduleName).catch(() => ({} as Record<string, string>));
        const filepath = info['path'] ?? info['file-path']
          ?? (info['filename'] ? `HOME/${info['filename']}` : `$HOME/${moduleName}.mod`);
        return (this as unknown as FilesMethods).readFile(filepath);
      }
    }

    /**
     * Save a module's source to a file on a controller volume. Mirrors the RWS 1.0
     * adapter's saveModule(task, module, filepath). The controller always writes
     * `{name}.modx` (never .sysx) into the VOLUME ROOT: subdirectories are rejected
     * with 400 (live-verified 2026-08-04, RW7.21), so any directory part beyond the
     * volume is invalid. Accepts 'TEMP/My.mod', 'HOME:', '$HOME/My', etc.
     */
    async saveModule(task: string, moduleName: string, filepath: string): Promise<void> {
      const clean = filepath.replace(/\/+$/, '');
      const ext = /\.(modx?|sysx?)$/i;
      const slash = clean.lastIndexOf('/');
      const last = clean.slice(slash + 1);
      let dir: string;
      let name: string;
      if (ext.test(last)) {
        dir = slash >= 0 ? clean.slice(0, slash) : 'TEMP';
        name = last.replace(ext, '');
      } else {
        dir = clean || 'TEMP';
        name = moduleName.replace(ext, '');
      }
      // Normalize the volume to the colon form the save action expects:
      // '$HOME' | 'HOME' | 'HOME:' all become 'HOME:'.
      const volume = `${dir.replace(/^\$/, '').replace(/:$/, '')}:`;
      const { path, body } = R2.saveModuleAs(task, moduleName, name, volume);
      await this.req('POST', path, body);
    }

    async getModuleInfo(task: string, moduleName: string): Promise<Record<string, string>> {
      // Live-verified 2026-07-09 on OmniCore VC RW7.21: the per-module GET returns
      // <li class="rap-module" title="{task}/{module}"> with spans modname,
      // filename (bare name like 'BASE.sysx' - NO path) and attribute.
      // (rap-module-info-li is the class used by the module LIST endpoint.)
      const p = parse(await this.req('GET', buildPath(RAPID.getModuleInfo.rws2 as PathSpec, { task, module: moduleName })));
      const d = p.getState('rap-module');
      if (Object.keys(d).length > 0) { return d; }
      return p.getState('rap-module-info-li') || p.getState('rap-module-info');
    }

    /**
     * The routines (PROC, FUNC, TRAP) of one module, from the module-scoped
     * RAPID symbol search: `POST /rw/rapid/symbols/search` with `view=block`,
     * `blockurl=RAPID/{task}/{module}`, `symtyp=any` and `recursive=FALSE`
     * (the search listModuleSymbols sends). The hits whose `symtyp` is prc,
     * fun or trp and whose symbol URL is directly in the module are kept;
     * `type` is that `symtyp`. Every entry of the answer is read whatever its
     * class, so a routine kind whose list class is not recorded (the trap's)
     * is not dropped. RW 7.21.4+417 answered this search with the module's
     * PROC as `rap-sympropproc-li`, symtyp `prc` (2026-09-29). Parity with
     * RWS1Adapter.listModuleRoutines.
     *
     * ABB's "Get Routine Information", `GET .../modules/{module}/routine`
     * (RAPID service, Rev L), is not a listing: RW 7.21.4+417 answered a
     * plain GET of it 400 "Row or Column invalid/missing" (2026-10-01), so it
     * reads the routine at a text position. It is not used here.
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task or module name; otherwise the controller's refusal of the
     *   search, typed.
     */
    async listModuleRoutines(task: string, moduleName: string): Promise<RapidRoutineInfo[]> {
      moduleParams('listModuleRoutines', task, moduleName);
      const body = await this.req('POST', buildPath(RAPID.listModuleRoutines.rws2 as PathSpec), {
        view: 'block', blockurl: `RAPID/${task}/${moduleName}`, symtyp: 'any', recursive: 'FALSE',
      });
      const hits = parse(body).getAllEntries()
        .map(e => ({ symburl: e['symburl'] ?? '', name: e['name'] ?? '', symtyp: e['symtyp'] ?? '' }));
      return routinesFromSymbols(hits, task, moduleName);
    }

    async listModuleSymbols(task: string, moduleName: string): Promise<Array<{ name: string; type: string; dattyp?: string }>> {
      const symbols = await this.searchRapidSymbols({ task, blockurl: `RAPID/${task}/${moduleName}`, recursive: false });
      return symbols.map(s => ({ name: s.name, type: s.symtyp, dattyp: s.dattyp }));
    }

    /**
     * Structural change count of a task - bumped when the task's PROGRAM STRUCTURE
     * changes (modules/routines added or removed), so it is the cheap "did the
     * program shape change" poll. Class rap-task-struc-change-count carries BOTH
     * `struc-change-count` (structural) and `change-count` (any edit); this method
     * returns the structural one - it previously returned `change-count`, i.e. the
     * wrong number. Use getTaskChangeCount() for the any-edit counter.
     */
    async getTaskStructuralChangeCount(task: string): Promise<number> {
      const p = parse(await this.req('GET', buildPath(RAPID.getTaskStructuralChangeCount.rws2 as PathSpec, { task })));
      const d = p.getState('rap-task-struc-change-count');
      return Number(d['struc-change-count'] ?? d['change-count'] ?? 0);
    }

    /** Any-edit change count of a task (the sibling of the structural count above,
     *  same resource and class).
     */
    async getTaskChangeCount(task: string): Promise<number> {
      const p = parse(await this.req('GET', buildPath(RAPID.getTaskChangeCount.rws2 as PathSpec, { task })));
      return Number(p.getState('rap-task-struc-change-count')['change-count'] ?? 0);
    }

    async getTaskMotion(task: string): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(RAPID.getTaskMotion.rws2 as PathSpec, { task })));
      // /motion is a directory of sub-resources (robtarget, jointtarget,
      // mechunits, extjointstate) - there is no `rap-task-motion` aggregate class,
      // so this always returned {}. Report which motion sub-resources the task
      // exposes; read the values via getRobTarget/getJointPositions (fixed 2026-08).
      const out: Record<string, string> = {};
      for (const cls of ['rapid-robtarget-li', 'rapid-jointtarget-li', 'rapid-mechunit-li', 'rapid-extjointstate-li']) {
        for (const d of p.getAllStates(cls)) {
          const name = d['_title'] ?? cls.replace(/^rapid-|-li$/g, '');
          out[name] = cls.replace(/^rapid-|-li$/g, '');
        }
      }
      return out;
    }

    // ── Task motion sub-reads ───────────────────────────────────────────────
    // The four resources the /motion directory links (ABB's RAPID service
    // page, "Get RobTarget", "Get Joint Target", "Get Mechanical Units",
    // "Get External Joint States"). Live-verified 2026-10-03 via
    // scripts/probe-config-task-motion.mjs: RW 7.21.0, 7.21.4, 8.1.1 and 8.2.1
    // link all four from /motion and answer each 200 in hal+json and XHTML.

    /**
     * The task's current robtarget: `GET /rw/rapid/tasks/{task}/motion/robtarget`,
     * class `rapid-robtarget` (x y z in mm, q1..q4, cf1 cf4 cf6 cfx,
     * eax_a..eax_f). On RW 7.21.4 and 8.2.1, with ROB_1 at joints
     * [0, 0, 0, 0, 30, 0], it read x 806.29, y 0, z 929, q [0.5, 0, 0.866, 0]
     * and every eax 9E+9 (2026-10-03).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task name; `PARSE_ERROR` when the answer has no rapid-robtarget
     *   entry or a position, orientation or configuration field is missing or
     *   not a number; otherwise the controller's classified error.
     */
    async getTaskRobTarget(task: string): Promise<TaskRobTarget> {
      const what = `getTaskRobTarget(${task})`;
      const d = await this.taskMotionState(task, RAPID.getTaskRobTarget, 'rapid-robtarget', what);
      const n = (k: string): number => taskMotionNumber(d, k, what);
      return {
        x: n('x'), y: n('y'), z: n('z'),
        q1: n('q1'), q2: n('q2'), q3: n('q3'), q4: n('q4'),
        cf1: n('cf1'), cf4: n('cf4'), cf6: n('cf6'), cfx: n('cfx'),
        eax: EAX_FIELDS.map(k => (d[k] === undefined || d[k].trim() === '' ? JOINT_NOT_PRESENT : n(k))) as TaskRobTarget['eax'],
      };
    }

    /**
     * The task's current jointtarget: `GET /rw/rapid/tasks/{task}/motion/jointtarget`,
     * class `rapid-jointtarget` (rax_1..rax_6 in degrees, eax_a..eax_f). On
     * RW 7.21.4 and 8.2.1 it read [0, 0, 0, 0, 30, ~0] with every eax 9E+9
     * - the marker, where the motion system's own jointtarget of the same unit
     * reads 0 in unused external slots (2026-10-03).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task name; `PARSE_ERROR` when the answer has no
     *   rapid-jointtarget entry or a robot axis is missing or not a number;
     *   otherwise the controller's classified error.
     */
    async getTaskJointTarget(task: string): Promise<JointTargetFull> {
      const what = `getTaskJointTarget(${task})`;
      const d = await this.taskMotionState(task, RAPID.getTaskJointTarget, 'rapid-jointtarget', what);
      return toJointTargetFull(d, `RWS2 ${what}`);
    }

    /**
     * The mechanical units the task drives: `GET
     * /rw/rapid/tasks/{task}/motion/mechunits`, one `rapid-mechunit` entry
     * per unit (name, mode, type). RW 7.21.0 through 8.2.1 listed
     * `ROB_1`, `active`, `tcp_robot` for T_ROB1 (2026-10-03).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task name; `PARSE_ERROR` when an entry carries no name;
     *   otherwise the controller's classified error. A task with no unit
     *   answers `[]`.
     */
    async getTaskMechunits(task: string): Promise<TaskMechunit[]> {
      const what = `getTaskMechunits(${task})`;
      const p = parse(await this.req('GET', taskMotionPath(task, RAPID.getTaskMechunits, what)));
      return p.getAllStates('rapid-mechunit').map(e => {
        const name = (e['name'] ?? e['_title'] ?? '').trim();
        if (!name) { throw new RwsError(`RWS2 ${what}: a rapid-mechunit entry carries no name`, 'PARSE_ERROR'); }
        return { name, mode: e['mode'] ?? '', type: e['type'] ?? '' };
      });
    }

    /**
     * The state of the task's six external joints: `GET
     * /rw/rapid/tasks/{task}/motion/extjointstate`, class
     * `rapid-extjointstate`, returned as the controller names them (`j1` ..
     * `j6`). Every joint read `not_active` on RW 7.21.0 through 8.2.1 for a
     * robot with no external axis (2026-10-03).
     *
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty task name; `PARSE_ERROR` when the answer has no
     *   rapid-extjointstate entry; otherwise the controller's classified error.
     */
    async getTaskExtJointState(task: string): Promise<Record<string, string>> {
      const what = `getTaskExtJointState(${task})`;
      const d = await this.taskMotionState(task, RAPID.getTaskExtJointState, 'rapid-extjointstate', what);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(d)) { if (!k.startsWith('_')) { out[k] = v; } }
      return out;
    }

    /** GET one task motion sub-read and return its `cls` entry (PARSE_ERROR without it). */
    private async taskMotionState(task: string, op: { rws2?: PathSpec }, cls: string, what: string): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', taskMotionPath(task, op, what)));
      return requireState(p, [cls], what);
    }

    /**
     * The task's current activation record (stack frame 1, the one that holds
     * the program pointer). ABB's entry class is `rap-stackframe` on both
     * generations (RWS 2.0 Rev L, RWS 1.0 Rev M), with `execlevel`, `beg-row`,
     * `beg-col`, `end-row`, `end-col`, `stack-url` and `routine-url`. `{}`
     * when the answer has no such entry. ABB lists motors on, a loaded
     * program and a running program as the preconditions.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async getTaskActivationRecord(task: string): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(RAPID.getTaskActivationRecord.rws2 as PathSpec, { task })));
      return p.getState('rap-stackframe');
    }

    async getTaskProgramInfo(task: string): Promise<Record<string, string>> {
      // Endpoint returns 204 (no content) when no program is loaded - caller handles this.
      const xml = await this.req('GET', buildPath(RAPID.getTaskProgramInfo.rws2 as PathSpec, { task }));
      if (!xml) { return {}; }
      // Class is rap-program (spans name, entrypoint); `rap-program-info` is never
      // emitted, so this returned {} even with a program loaded (fixed 2026-08).
      return parse(xml).getState('rap-program');
    }

    /**
     * The aliases the running RAPID program defines for I/O signals: one
     * entry per `rap-alias-io`, with the alias (`alias-name`), the signal
     * (`signal-name`) and the signal type (`type`), as ABB documents them.
     *
     * @throws RwsError `PARSE_ERROR` when the answer has typed entries but no
     *   `rap-alias-io`; otherwise the controller's classified error.
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async listAliasIO(): Promise<Array<{ alias: string; signal: string; type?: string }>> {
      const p = parse(await this.req('GET', buildPath(RAPID.listAliasIO.rws2 as PathSpec)));
      return aliasIoFrom(p.getAllEntries(), 'RWS2 listAliasIO');
    }

    /**
     * Task-panel selection state. The live class is `rap-taskselection` (NOT the
     * `-li` variant this previously parsed, which made the result always empty -
     * fixed 2026-08 after reading the real response on RW7.21). Each entry carries
     * name, state (ON/OFF), motiontask and usermodify.
     */
    async getTaskSelection(): Promise<{ selected: string[]; available: string[]; entries: Array<Record<string, string>> }> {
      const p = parse(await this.req('GET', buildPath(RAPID.getTaskSelection.rws2 as PathSpec)));
      const entries = p.getAllStates('rap-taskselection');
      const available = entries.map(t => t['name']).filter(Boolean) as string[];
      const selected = entries.filter(t => (t['state'] ?? '').toUpperCase() === 'ON')
        .map(t => t['name']).filter(Boolean) as string[];
      return { selected, available, entries };
    }

    /**
     * Select the tasks the task panel runs.
     *
     * Refused before sending: no resource takes the whole task selection.
     * ABB documents only GET on `/rw/rapid/taskselection` (RWS 2.0 Rev L, and
     * RWS 1.0 Rev M too), and RW 7.21.4 and 8.2.1 answer a POST there with 405
     * -1073414146 (OPTIONS lists GET,OPTIONS and a subscription form; recorded
     * 2026-10-11). The selection is read with `getTaskSelection` and changed
     * one task at a time with `activateRapidTask` / `deactivateRapidTask`, as
     * ABB documents, or at the FlexPendant task panel.
     *
     * @experimental Refused before sending (UNSUPPORTED_OPERATION): no RWS 2.0 resource takes the write.
     */
    async setTaskSelection(tasks: string[]): Promise<void> {
      const spec = RAPID.setTaskSelection.rws2 as PathSpec;
      throw new RwsError(
        `RWS2 setTaskSelection (${tasks.join(', ')}): ${spec.gap ?? 'no RWS 2.0 resource takes the task selection'}`,
        'UNSUPPORTED_OPERATION');
    }

    async getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; executionType?: string }> {
      // Live-verified: class="pcp-info" with spans:
      //   modulemame (sic - controller typo for modulename)
      //   routinename
      //   beginposition  → "row,col" combined string (begposition before
      //                    v=2.2, ABB RAPID service; read under either)
      //   endposition    → "row,col"
      //   changecount, executiontype
      const p = parse(await this.req('GET', buildPath(RAPID.getProgramPointer.rws2 as PathSpec, { task })));
      const d = p.getState('pcp-info') || p.getState('program-pointer-state') || p.getState('rap-pcp-li');
      const begin = (d['beginposition'] ?? d['begposition'] ?? '').split(',');
      return {
        module:  d['modulename'] ?? d['modulemame'] ?? d['module'],
        routine: d['routinename'] ?? d['routine'],
        row:     begin[0] ? +begin[0] : (d['begin-position-row'] ? +d['begin-position-row'] : undefined),
        col:     begin[1] ? +begin[1] : (d['begin-position-col'] ? +d['begin-position-col'] : undefined),
        executionType: d['executiontype'],
      };
    }

    /**
     * The task's motion pointer: the instruction the robot is executing now;
     * the program pointer normally runs ahead of it to prepare the motion.
     * `GET /rw/rapid/tasks/{task}/pcp`, the same request as
     * `getProgramPointer`, read for the entry ABB titles `motionpointer` (Rev L
     * RAPID service). `row` and `col` are the start of the instruction, read
     * under `beginposition` first, else under `begposition`: RW 7.21.4 sends
     * `begposition` in this entry (2026-10-18). With no program started the
     * controller answers that entry without a position, and the result is
     * `{}`; an answer with no such entry is `PARSE_ERROR`.
     *
     * `state` is no longer filled: the method used to read the task's
     * motion-pointer sync state, which holds no position.
     *
     * @experimental The evidence index does not credit this read: it sends the same request as `getProgramPointer`, whose answer carries this entry with no position when no program has started, and the logs keep no answer body, so a logged 2xx does not show that a position was read. On a RobotWare 7.21.4 virtual controller it read row 9 col 16 while a MoveAbsJ ran (2026-10-18).
     */
    async getMotionPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; state?: string }> {
      const p = parse(await this.req('GET', buildPath(RAPID.getMotionPointer.rws2 as PathSpec, { task })));
      return motionPointerFrom(p.getAllEntries(), 'RWS2 getMotionPointer');
    }

    /**
     * Replace a module's source text in place.
     * POST /rw/rapid/tasks/{task}/modules/{module}/text, form fields `task`,
     * `text`, `path` (live-read 2026-08-09 on RW7.21 and RW8.1.1, form id
     * `set-module-text`).
     *
     * The read side is `getModuleText`. This is the write side, and it edits
     * program memory directly - no TEMP file round trip, unlike `saveModule`.
     *
     * It rewrites a loaded program; run against RWS 2.0 (RobotWare 7.21.4).
     * Holds `edit` mastership (RW8: write access), as ABB's RWS pages require.
     */
    async setModuleText(task: string, module: string, text: string, path?: string): Promise<void> {
      const body: Record<string, string> = { task, text };
      if (path !== undefined) { body['path'] = path; }
      await this.withAccess(['rapid'], () => this.req(
        'POST',
        buildPath(RAPID.setModuleText.rws2 as PathSpec, { task, module }),
        body,
      ));
    }

    /**
     * Replace a ROW/COLUMN range of a module's source in place.
     * POST /rw/rapid/tasks/{task}/modules/{module}/text/range, form fields `task`,
     * `replace-mode`, `query-mode`, `startrow`, `startcol`, `endrow`, `endcol`,
     * `text` (live-read 2026-08-09, form id `set-text-range`; the controller's
     * defaults are replace-mode "After" and query-mode "Force").
     *
     * The form's own `action` attribute says `.../textrange`, with no slash. That
     * is wrong: `/textrange` answers 404 on both RW7.21 and RW8.1.1, while
     * `/text/range` - where OPTIONS is served and where `getModuleTextRange`
     * already reads - answers 200. This is the one place in this sweep where the
     * controller's form contradicts the live path, so the path wins.
     *
     * It rewrites a loaded program; run against RWS 2.0 (RobotWare 7.21.4).
     * Holds `edit` mastership (RW8: write access), as ABB's RWS pages require.
     */
    async setModuleTextRange(
      task: string, module: string,
      range: { startRow: number; startCol: number; endRow: number; endCol: number },
      text: string,
      opts?: { replaceMode?: string; queryMode?: string },
    ): Promise<void> {
      await this.withAccess(['rapid'], () => this.req(
        'POST',
        buildPath(RAPID.setModuleTextRange.rws2 as PathSpec, { task, module }),
        {
          task,
          'replace-mode': opts?.replaceMode ?? 'After',
          'query-mode':   opts?.queryMode ?? 'Force',
          startrow: String(range.startRow), startcol: String(range.startCol),
          endrow:   String(range.endRow),   endcol:   String(range.endCol),
          text,
        },
      ));
    }

    /**
     * ModPos - rewrite a robtarget in place from the robot's current position.
     * POST /rw/rapid/tasks/{task}/modules/{module}/modify-position, form fields
     * `startrow`, `startcol`, `endrow`, `endcol`, `checklimit`, `checkdeactaxes`,
     * `text`, `allowdeact` (live-read 2026-08-09 on RW7.21 AND RW8.1.1 - both
     * report the identical field set).
     *
     * Requires RAPID mastership. `endrow`/`endcol` default to the start position,
     * which is what the pendant sends when modifying a single target.
     *
     * Holds `edit` mastership (RW8: write access) around the write. ABB's RWS
     * pages add conditions this client does not create: a local client in
     * manual mode (RobotWare 7; RobotWare 8: a local control station in
     * manual), motors on, and a motion program loaded. Whether a remote client
     * may do it in Auto on RobotWare 7 is not established.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async modifyPosition(
      task: string, module: string, opts: ModifyPositionOptions,
    ): Promise<void> {
      const body: Record<string, string> = {
        startrow: String(opts.startRow),
        startcol: String(opts.startCol),
        endrow:   String(opts.endRow ?? opts.startRow),
        endcol:   String(opts.endCol ?? opts.startCol),
      };
      if (opts.checkLimit     !== undefined) { body['checklimit']     = String(opts.checkLimit); }
      if (opts.checkDeactAxes !== undefined) { body['checkdeactaxes'] = String(opts.checkDeactAxes); }
      if (opts.allowDeact     !== undefined) { body['allowdeact']     = String(opts.allowDeact); }
      if (opts.text           !== undefined) { body['text']           = opts.text; }
      await this.withAccess(['rapid'], () => this.req(
        'POST',
        buildPath(RAPID.modifyPosition.rws2 as PathSpec, { task, module }),
        body,
      ));
    }

    /**
     * Reset the program pointer of ONE task.
     * POST /rw/rapid/tasks/{task}/pcp/reset - `Allow: POST,OPTIONS`, no form
     * fields (live-read 2026-08-09).
     *
     * Distinct from the global `resetProgramPointer()`, which drives
     * /rw/rapid/execution/resetpp and resets every task at once.
     *
     * Holds `edit` mastership (RW8: write access), as ABB's RWS pages require.
     */
    async resetTaskProgramPointer(task: string): Promise<void> {
      await this.withAccess(['rapid'], () =>
        this.req('POST', buildPath(RAPID.resetTaskProgramPointer.rws2 as PathSpec, { task })));
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface RapidMethods {
  getRapidExecutionState(): Promise<ExecutionState>;
  getRapidExecutionInfo(): Promise<ExecutionInfo>;
  getExecutionErrorState(): Promise<boolean>;
  startRapid(): Promise<void>;
  stopRapid(): Promise<void>;
  resetRapid(): Promise<void>;
  setExecutionCycle(cycle: ExecutionCycle): Promise<void>;
  startProductionEntry(): Promise<void>;
  loadProgram(task: string, progpath: string, loadmode?: 'add' | 'replace'): Promise<void>;
  unloadProgram(task: string): Promise<void>;
  getBuildErrors(task: string): Promise<RapidBuildError[]>;
  saveProgram(task: string, destination: string): Promise<void>;
  getRapidTasks(): Promise<RapidTask[]>;
  getRapidTask(task: string): Promise<Record<string, string>>;
  listModuleRoutines(task: string, moduleName: string): Promise<RapidRoutineInfo[]>;
  activateRapidTask(task: string): Promise<void>;
  deactivateRapidTask(task: string): Promise<void>;
  activateAllRapidTasks(): Promise<void>;
  deactivateAllRapidTasks(): Promise<void>;
  listModules(task: string): Promise<string[]>;
  listModulesDetailed(task: string): Promise<Array<{ name: string; type: string }>>;
  loadModule(task: string, path: string, replace?: boolean): Promise<void>;
  unloadModule(task: string, name: string): Promise<void>;
  getRapidVariable(task: string, module: string, symbol: string): Promise<string>;
  setRapidVariable(task: string, module: string, symbol: string, value: string): Promise<void>;
  validateRapidValue(task: string, value: string, datatype: string): Promise<boolean>;
  getRapidSymbolProperties(task: string, module: string, symbol: string): Promise<RapidSymbolProperties>;
  searchRapidSymbols(params: RapidSymbolSearchParams): Promise<RapidSymbolInfo[]>;
  getActiveUiInstruction(): Promise<UiInstruction | null>;
  setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void>;
  ppPrevInst(task: string): Promise<void>;
  ppNextInst(task: string): Promise<void>;
  setPPToRoutineFromUrl(task: string, routineurl: string, userlevel?: string): Promise<void>;
  getModuleText(task: string, module: string): Promise<{ text: string; changeCount: number }>;
  getModuleTextRange(task: string, module: string, startRow: number, startCol: number, endRow: number, endCol: number): Promise<string>;
  searchModuleText(task: string, module: string, text: string): Promise<Array<{ row: number; column: number }>>;
  getModuleChangeCount(task: string, module: string): Promise<number>;
  getModuleSyncPersStatus(task: string, module: string): Promise<boolean>;
  getModuleExtension(task: string, module: string): Promise<{ lines: number; maxColumns: number; changeCount: number }>;
  getModPossibleAll(): Promise<Array<Record<string, string>>>;
  getModuleModPossible(task: string, module: string, query?: RapidModuleQuery): Promise<Array<Record<string, string>>>;
  getModuleSymbolInfo(task: string, module: string, query?: RapidModuleQuery): Promise<Array<Record<string, string>>>;
  getModuleAttributes(task: string, module: string, query?: RapidModuleQuery): Promise<Array<Record<string, string>>>;
  getModuleObject(task: string, module: string, query?: RapidModuleQuery): Promise<Array<Record<string, string>>>;
  getProgramPointerSyncState(): Promise<string>;
  getMotionPointerSyncState(): Promise<string>;
  getSpyStatus(): Promise<string>;
  listInstructionCategories(task: string): Promise<Array<{ number: number; name: string }>>;
  listInstructions(task: string, category: number): Promise<Array<Record<string, string>>>;
  listServiceRoutines(task: string): Promise<Array<{ name: string; url: string }>>;
  callServiceRoutine(task: string, routineName: string, args?: Record<string, string>): Promise<void>;
  getRobTarget(mechunit?: string, tool?: string, wobj?: string): Promise<RobTarget>;
  setProgramPointer(task: string, params: { module?: string; routine: string; row?: number; col?: number; userlevel?: string }): Promise<void>;
  setPPToCursor(task: string, module: string, row: number, col: number): Promise<void>;
  stepRapid(_task: string, mode: 'into' | 'over' | 'out'): Promise<void>;
  holdToRun(_task: string, action: 'press' | 'held' | 'release'): Promise<void>;
  listBreakpoints(task: string): Promise<Array<{ module: string; row: number; col?: number }>>;
  setBreakpoint(task: string, module: string, row: number, col?: number): Promise<void>;
  removeBreakpoint(task: string, module: string, row: number, col?: number): Promise<void>;
  getModuleSource(task: string, moduleName: string): Promise<string>;
  saveModule(task: string, moduleName: string, filepath: string): Promise<void>;
  getModuleInfo(task: string, moduleName: string): Promise<Record<string, string>>;
  listModuleSymbols(task: string, moduleName: string): Promise<Array<{ name: string; type: string; dattyp?: string }>>;
  getTaskStructuralChangeCount(task: string): Promise<number>;
  getTaskChangeCount(task: string): Promise<number>;
  getTaskMotion(task: string): Promise<Record<string, string>>;
  getTaskRobTarget(task: string): Promise<TaskRobTarget>;
  getTaskJointTarget(task: string): Promise<JointTargetFull>;
  getTaskMechunits(task: string): Promise<TaskMechunit[]>;
  getTaskExtJointState(task: string): Promise<Record<string, string>>;
  getTaskActivationRecord(task: string): Promise<Record<string, string>>;
  getTaskProgramInfo(task: string): Promise<Record<string, string>>;
  listAliasIO(): Promise<Array<{ alias: string; signal: string; type?: string }>>;
  getTaskSelection(): Promise<{ selected: string[]; available: string[]; entries: Array<Record<string, string>> }>;
  setTaskSelection(tasks: string[]): Promise<void>;
  getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; executionType?: string }>;
  /** `state` is never filled; kept so code that reads it still compiles. */
  getMotionPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; state?: string }>;
  setModuleText(task: string, module: string, text: string, path?: string): Promise<void>;
  setModuleTextRange(task: string, module: string, range: { startRow: number; startCol: number; endRow: number; endCol: number }, text: string, opts?: { replaceMode?: string; queryMode?: string }): Promise<void>;
  modifyPosition(task: string, module: string, opts: ModifyPositionOptions): Promise<void>;
  resetTaskProgramPointer(task: string): Promise<void>;
}

/** Guard: the mixin class must provide every RapidMethods member (never exported). */
type _RapidMethodsComplete = InstanceType<ReturnType<typeof rapidOps>> extends RapidMethods ? true : never;
const _rapidComplete: _RapidMethodsComplete = true;
void _rapidComplete;

export function RapidOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<RapidMethods> {
  return rapidOps(Base) as unknown as TBase & GConstructor<RapidMethods>;
}
