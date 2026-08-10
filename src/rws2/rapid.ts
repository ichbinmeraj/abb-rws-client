import { MOTION, RAPID } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { type ExecutionCycle, type ExecutionInfo, type ExecutionState, type ModifyPositionOptions, type RapidSymbolInfo, type RapidSymbolProperties, type RapidSymbolSearchParams, type RapidTask, type RobTarget, type UiInstruction } from '../types.js';
import { parse, requireState } from './core.js';
import type { FilesMethods } from './files.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * RAPID domain (`/rw/rapid`): execution, tasks, modules, symbols, program pointer, breakpoints, service routines.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
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

    startRapid(): Promise<void> {
      const { path, body } = R2.startRapid();
      return this.req('POST', path, body).then(() => {});
    }

    stopRapid(): Promise<void> {
      const { path, body } = R2.stopRapid();
      return this.req('POST', path, body).then(() => {});
    }

    /** Reset the program pointer to main. Acquires edit mastership internally -
     *  live-verified 2026-08-04 (RW7.21): without it the controller answers
     *  MASTERSHIP_REQUIRED. */
    async resetRapid(): Promise<void> {
      await this.requestMastership('rapid');
      try {
        const { path } = R2.resetRapid();
        await this.req('POST', path);
      } finally {
        await this.releaseMastership('rapid').catch(() => {});
      }
    }

    setExecutionCycle(cycle: ExecutionCycle): Promise<void> {
      const { path, body } = R2.setExecutionCycle(cycle);
      return this.req('POST', path, body).then(() => {});
    }

    /** Start RAPID execution from the production entry point (task list main).
     *  OPTIONS-verified 2026-08-04 (RW7.21): POST, no body. Acquires edit
     *  mastership internally (MASTERSHIP_REQUIRED without it, live-verified). */
    async startProductionEntry(): Promise<void> {
      await this.requestMastership('rapid');
      try {
        const { path } = R2.startProductionEntry();
        await this.req('POST', path);
      } finally {
        await this.releaseMastership('rapid').catch(() => {});
      }
    }

    /** Load a full RAPID program (.pgf + modules) into a task from disk. Distinct
     *  from loadModule (single module). OPTIONS-verified 2026-08-04 (RW7.21). */
    loadProgram(task: string, progpath: string, loadmode: 'add' | 'replace' = 'replace'): Promise<void> {
      const { path, body } = R2.loadProgram(task, progpath, loadmode);
      return this.req('POST', path, body).then(() => {});
    }

    /** Save a task's currently loaded RAPID program to disk. OPTIONS-verified 2026-08-04. */
    saveProgram(task: string, destination: string): Promise<void> {
      const { path, body } = R2.saveProgram(task, destination);
      return this.req('POST', path, body).then(() => {});
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

    async activateRapidTask(task: string): Promise<void> {
      await this.requestMastership('rapid');
      try {
        await this.req('POST', buildPath(RAPID.activateRapidTask.rws2 as PathSpec), { task });
      } finally {
        await this.releaseMastership('rapid').catch(() => {});
      }
    }

    async deactivateRapidTask(task: string): Promise<void> {
      await this.requestMastership('rapid');
      try {
        await this.req('POST', buildPath(RAPID.deactivateRapidTask.rws2 as PathSpec), { task });
      } finally {
        await this.releaseMastership('rapid').catch(() => {});
      }
    }

    async activateAllRapidTasks(): Promise<void> {
      // Get task list then activate each
      const tasks = await this.getRapidTasks();
      await this.requestMastership('rapid');
      try {
        for (const t of tasks) {
          await this.req('POST', buildPath(RAPID.activateRapidTask.rws2 as PathSpec), { task: t.name }).catch(() => {});
        }
      } finally {
        await this.releaseMastership('rapid').catch(() => {});
      }
    }

    async deactivateAllRapidTasks(): Promise<void> {
      const tasks = await this.getRapidTasks();
      await this.requestMastership('rapid');
      try {
        for (const t of tasks) {
          await this.req('POST', buildPath(RAPID.deactivateRapidTask.rws2 as PathSpec), { task: t.name }).catch(() => {});
        }
      } finally {
        await this.releaseMastership('rapid').catch(() => {});
      }
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
      await this.req('POST', buildPath(RAPID.loadModule.rws2 as PathSpec, { task }), body);
    }

    unloadModule(task: string, name: string): Promise<void> {
      // RWS 2.0 unload is path-based action: POST /rw/rapid/tasks/{task}/unloadmod
      // (DELETE on the module URL returns 405; only POST + body works.)
      return this.req('POST', buildPath(RAPID.unloadModule.rws2 as PathSpec, { task }), { module: name }).then(() => {});
    }

    async getRapidVariable(task: string, module: string, symbol: string): Promise<string> {
      // RWS 2.0 symbol API: suffix-style - /rw/rapid/symbol/{symburl}/data
      // (RWS 1.0 puts /data at the front: /rw/rapid/symbol/data/{symburl})
      const p = parse(
        await this.req('GET', buildPath(RAPID.getRapidVariable.rws2 as PathSpec, { task, module, symbol }))
      );
      return p.get('value') ?? '';
    }

    setRapidVariable(task: string, module: string, symbol: string, value: string): Promise<void> {
      return this.req('POST', buildPath(RAPID.setRapidVariable.rws2 as PathSpec, { task, module, symbol }), { value }).then(() => {});
    }

    async validateRapidValue(task: string, value: string, datatype: string): Promise<boolean> {
      // RWS 2.0: endpoint path differs - use per-task validate
      try {
        await this.req('POST', buildPath(RAPID.validateRapidValue.rws2 as PathSpec, { task }), {
          value, dattyp: datatype,
        });
        return true;
      } catch {
        return false;
      }
    }

    async getRapidSymbolProperties(task: string, module: string, symbol: string): Promise<RapidSymbolProperties> {
      const p = parse(
        await this.req('GET', buildPath(RAPID.getRapidSymbolProperties.rws2 as PathSpec, { task, module, symbol }))
      );
      // The class encodes the symbol KIND: rap-sympropvar (VAR),
      // rap-symproppers (PERS - e.g. tool0, live-verified 2026-08),
      // rap-sympropconst (CONST), rap-sympropproc/fun (routines). Only the VAR
      // spelling was checked before, so persistents and constants parsed as empty.
      let d: Record<string, string> = {};
      for (const cls of ['rap-sympropvar', 'rap-symproppers', 'rap-sympropconst',
        'rap-sympropproc', 'rap-sympropfun', 'rap-sympropvar-li', 'rap-symbol-properties']) {
        d = p.getState(cls);
        if (Object.keys(d).length > 0) { break; }
      }
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
      //   rap-sympropvar-li  → variable (VAR)
      //   rap-symproppers-li → persistent (PERS)
      //   rap-sympropconst-li → constant (CONST)
      //   rap-sympropproc-li → procedure (PROC)
      //   rap-sympropfun-li  → function (FUNC)
      //   rap-sympropmod-li  → module
      // Earlier versions only parsed vars - missing all the routines.
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
        'rap-sympropconst-li',
        'rap-sympropproc-li',
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
        const d = p.getState('rap-uiinstr-li') || p.getState('rap-uiinstr');
        if (!d['instr']) { return null; }
        return { instr: d['instr'], event: d['event'] ?? '', stack: d['stack'] ?? '', execlv: d['execlv'] ?? '', msg: d['msg'] ?? '' };
      } catch { return null; }
    }

    setUiInstructionParam(stackurl: string, uiparam: string, value: string): Promise<void> {
      // RWS 2.0: POST /rw/rapid/uiinstr/active/param/{stackurl}/{uiparam}
      return this.req(
        'POST',
        buildPath(RAPID.setUiInstructionParam.rws2 as PathSpec, { stackurl, uiparam }),
        { value }
      ).then(() => {});
    }

    /** Step the program pointer back one instruction (manual-mode debugger). */
    async ppPrevInst(task: string): Promise<void> {
      const { path } = R2.ppPrevInst(task);
      await this.req('POST', path);
    }

    /** Step the program pointer forward one instruction (manual-mode debugger). */
    async ppNextInst(task: string): Promise<void> {
      const { path } = R2.ppNextInst(task);
      await this.req('POST', path);
    }

    /** Set the program pointer to a routine by its symbol URL (form: routineurl, userlevel). */
    async setPPToRoutineFromUrl(task: string, routineurl: string, userlevel = ''): Promise<void> {
      const { path, body } = R2.setPPToRoutineFromUrl(task, routineurl, userlevel);
      await this.req('POST', path, body);
    }

    /** Full source text of a module straight from program memory, with its change
     *  count. Class rap-module-text (spans change-count, module-text). Unlike
     *  getModuleSource this needs no TEMP round trip, but it is RWS 2.0 only. */
    async getModuleText(task: string, module: string): Promise<{ text: string; changeCount: number }> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.getModuleText.rws2 as PathSpec, { task, module })));
      const d = p.getState('rap-module-text');
      return { text: d['module-text'] ?? '', changeCount: Number((d['change-count'] ?? '0').trim()) };
    }

    /** A source range of a module (rows/columns are 1-based). Class rap-mod-text. */
    async getModuleTextRange(task: string, module: string, startRow: number, startCol: number, endRow: number, endCol: number): Promise<string> {
      const p = parse(await this.req(
        'GET', `${buildPath(RAPID.getModuleTextRange.rws2 as PathSpec, { task, module })}?startrow=${startRow}&startcol=${startCol}&endrow=${endRow}&endcol=${endCol}`));
      return p.getState('rap-mod-text')['text'] ?? '';
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

    /** Change count of one module (class rap-module-changecount, span count). */
    async getModuleChangeCount(task: string, module: string): Promise<number> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.getModuleChangeCount.rws2 as PathSpec, { task, module })));
      return Number(p.getState('rap-module-changecount')['count'] ?? 0);
    }

    /** SyncPers status of a module (class rap-syncper-status). */
    async getModuleSyncPersStatus(task: string, module: string): Promise<boolean> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.getModuleSyncPersStatus.rws2 as PathSpec, { task, module })));
      return (p.getState('rap-syncper-status')['syncperstatus'] ?? '0') === '1';
    }

    /** Module extension info: line count, max column, change count
     *  (class rap-module-extension). */
    async getModuleExtension(task: string, module: string): Promise<{ lines: number; maxColumns: number; changeCount: number }> {
      const p = parse(await this.req(
        'GET', buildPath(RAPID.getModuleExtension.rws2 as PathSpec, { task, module })));
      const d = p.getState('rap-module-extension');
      return { lines: Number(d['num-of-lines'] ?? 0), maxColumns: Number(d['max-num-of-col'] ?? 0), changeCount: Number(d['count'] ?? 0) };
    }

    /** Program-pointer sync state across all tasks (class rap-sync-state). */
    async getProgramPointerSyncState(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(RAPID.getProgramPointerSyncState.rws2 as PathSpec)));
      return p.getState('rap-sync-state')['program-pointer-state'] ?? 'unknown';
    }

    /** Motion-pointer sync state across all tasks (class rap-sync-state). */
    async getMotionPointerSyncState(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(RAPID.getMotionPointerSyncState.rws2 as PathSpec)));
      return p.getState('rap-sync-state')['motion-pointer-state'] ?? 'unknown';
    }

    /** RAPID spy (execution trace) logging status, e.g. 'Not Logging'
     *  (class rap-spy-status). */
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
     * method is kept for source compatibility but will reject with the controller's
     * 405 on RWS 2.0; use the PP + start path instead.
     */
    async callServiceRoutine(task: string, routineName: string, args: Record<string, string> = {}): Promise<void> {
      await this.req('POST', buildPath(RAPID.callServiceRoutine.rws2 as PathSpec, { task }), { routine: routineName, ...args });
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
      await this.req('POST', buildPath(RAPID.setProgramPointer.rws2 as PathSpec, { task }), body);
    }

    async setPPToCursor(task: string, module: string, row: number, col: number): Promise<void> {
      await this.req('POST', buildPath(RAPID.setPPToCursor.rws2 as PathSpec, { task }), {
        module,
        'begin-position-row': String(row),
        'begin-position-col': String(col),
      });
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
      await this.req('POST', buildPath(RAPID.stepRapid.rws2 as PathSpec), {
        regain: 'continue', execmode, cycle: 'asis',
        condition: 'none', stopatbp: 'disabled', alltaskbytsp: 'false',
      });
    }

    /**
     * Hold-to-run (dead-man) control. POST /rw/rapid/execution/holdtorun, field
     * `state` (not /tasks/{task}/holdtorun with `action`, which 404s - fixed
     * 2026-08-04). `press` is an accepted value; hold-to-run is a MANUAL-mode
     * function, so in AUTO the controller rejects the operation on execution state.
     */
    async holdToRun(_task: string, action: 'press' | 'release'): Promise<void> {
      await this.req('POST', buildPath(RAPID.holdToRun.rws2 as PathSpec), { state: action });
    }

    async listBreakpoints(task: string): Promise<Array<{ module: string; row: number; col?: number }>> {
      try {
        // GET /rw/rapid/tasks/{task}/program/breakpoints (verified path). The item
        // class was empty on the VC (no breakpoints set in AUTO), so both the
        // rap-breakpoint-li class and the row/col span names are best-effort.
        const p = parse(await this.req('GET', buildPath(RAPID.listBreakpoints.rws2 as PathSpec, { task })));
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
      await this.req('POST', buildPath(RAPID.setBreakpoint.rws2 as PathSpec, { task }),
        { module, row: String(row), column: String(col) });
    }

    /**
     * Remove a breakpoint. NOTE: the exact remove form is not yet confirmed - DELETE
     * on both /program/breakpoints and the task-root /breakpoint answered 405 on
     * RW7.21, and no breakpoint could be set in AUTO to exercise the removal. This
     * uses the OPTIONS field names; treat as best-effort until manual-mode verified.
     */
    async removeBreakpoint(task: string, module: string, row: number, col = 1): Promise<void> {
      const params = new URLSearchParams({ module, row: String(row), column: String(col) });
      await this.req('DELETE', `${buildPath(RAPID.removeBreakpoint.rws2 as PathSpec, { task })}?${params.toString()}`);
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
     * wrong number (live-verified 2026-08: struc=6966 vs change=215 on RW7.21).
     * Use getTaskChangeCount() for the any-edit counter.
     */
    async getTaskStructuralChangeCount(task: string): Promise<number> {
      const p = parse(await this.req('GET', buildPath(RAPID.getTaskStructuralChangeCount.rws2 as PathSpec, { task })));
      const d = p.getState('rap-task-struc-change-count');
      return Number(d['struc-change-count'] ?? d['change-count'] ?? 0);
    }

    /** Any-edit change count of a task (the sibling of the structural count above,
     *  same resource and class). */
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

    async getTaskActivationRecord(task: string): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(RAPID.getTaskActivationRecord.rws2 as PathSpec, { task })));
      return p.getState('rap-activation-record') || {};
    }

    async getTaskProgramInfo(task: string): Promise<Record<string, string>> {
      // Endpoint returns 204 (no content) when no program is loaded - caller handles this.
      const xml = await this.req('GET', buildPath(RAPID.getTaskProgramInfo.rws2 as PathSpec, { task }));
      if (!xml) { return {}; }
      // Class is rap-program (spans name, entrypoint); `rap-program-info` is never
      // emitted, so this returned {} even with a program loaded (fixed 2026-08).
      return parse(xml).getState('rap-program');
    }

    async listAliasIO(): Promise<Array<{ alias: string; signal: string }>> {
      const p = parse(await this.req('GET', buildPath(RAPID.listAliasIO.rws2 as PathSpec)));
      return p.getAllStates('rap-aliasio-li').map(a => ({
        alias: a['name'] ?? a['alias'] ?? '',
        signal: a['signal'] ?? a['_title'] ?? '',
      }));
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

    async setTaskSelection(tasks: string[]): Promise<void> {
      const body = tasks.map((t, i) => `task-${i + 1}=${encodeURIComponent(t)}`).join('&');
      await this.req('POST', buildPath(RAPID.setTaskSelection.rws2 as PathSpec), undefined, body, 'application/x-www-form-urlencoded;v=2.0');
    }

    async getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; executionType?: string }> {
      // Live-verified: class="pcp-info" with spans:
      //   modulemame (sic - controller typo for modulename)
      //   routinename
      //   beginposition  → "row,col" combined string
      //   endposition    → "row,col"
      //   changecount, executiontype
      const p = parse(await this.req('GET', buildPath(RAPID.getProgramPointer.rws2 as PathSpec, { task })));
      const d = p.getState('pcp-info') || p.getState('program-pointer-state') || p.getState('rap-pcp-li');
      const begin = (d['beginposition'] ?? '').split(',');
      return {
        module:  d['modulename'] ?? d['modulemame'] ?? d['module'],
        routine: d['routinename'] ?? d['routine'],
        row:     begin[0] ? +begin[0] : (d['begin-position-row'] ? +d['begin-position-row'] : undefined),
        col:     begin[1] ? +begin[1] : (d['begin-position-col'] ? +d['begin-position-col'] : undefined),
        executionType: d['executiontype'],
      };
    }

    async getMotionPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; state?: string }> {
      // Live-verified: /syncstate/motion-pointer returns class="rap-task-sync-state"
      // with a single span class="motion-pointer-state" containing 'Off' or position info.
      const p = parse(await this.req('GET', buildPath(RAPID.getMotionPointer.rws2 as PathSpec, { task })));
      const d = p.getState('rap-task-sync-state');
      const stateVal = d['motion-pointer-state'] ?? '';
      return {
        module:  d['modulename'] ?? d['modulemame'] ?? d['module'],
        routine: d['routinename'] ?? d['routine'],
        row:     d['begin-position-row'] ? +d['begin-position-row'] : undefined,
        col:     d['begin-position-col'] ? +d['begin-position-col'] : undefined,
        state:   stateVal,
      };
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
     * Built from the live form but NOT executed: it rewrites a loaded program.
     */
    async setModuleText(task: string, module: string, text: string, path?: string): Promise<void> {
      const body: Record<string, string> = { task, text };
      if (path !== undefined) { body['path'] = path; }
      await this.req(
        'POST',
        buildPath(RAPID.setModuleText.rws2 as PathSpec, { task, module }),
        body,
      );
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
     * Built from the live form but NOT executed: it rewrites a loaded program.
     */
    async setModuleTextRange(
      task: string, module: string,
      range: { startRow: number; startCol: number; endRow: number; endCol: number },
      text: string,
      opts?: { replaceMode?: string; queryMode?: string },
    ): Promise<void> {
      await this.req(
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
      );
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
      await this.req(
        'POST',
        buildPath(RAPID.modifyPosition.rws2 as PathSpec, { task, module }),
        body,
      );
    }

    /**
     * Reset the program pointer of ONE task.
     * POST /rw/rapid/tasks/{task}/pcp/reset - `Allow: POST,OPTIONS`, no form
     * fields (live-read 2026-08-09).
     *
     * Distinct from the global `resetProgramPointer()`, which drives
     * /rw/rapid/execution/resetpp and resets every task at once.
     */
    async resetTaskProgramPointer(task: string): Promise<void> {
      await this.req('POST', buildPath(RAPID.resetTaskProgramPointer.rws2 as PathSpec, { task }));
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
  startRapid(): Promise<void>;
  stopRapid(): Promise<void>;
  resetRapid(): Promise<void>;
  setExecutionCycle(cycle: ExecutionCycle): Promise<void>;
  startProductionEntry(): Promise<void>;
  loadProgram(task: string, progpath: string, loadmode?: 'add' | 'replace'): Promise<void>;
  saveProgram(task: string, destination: string): Promise<void>;
  getRapidTasks(): Promise<RapidTask[]>;
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
  holdToRun(_task: string, action: 'press' | 'release'): Promise<void>;
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
  getTaskActivationRecord(task: string): Promise<Record<string, string>>;
  getTaskProgramInfo(task: string): Promise<Record<string, string>>;
  listAliasIO(): Promise<Array<{ alias: string; signal: string }>>;
  getTaskSelection(): Promise<{ selected: string[]; available: string[]; entries: Array<Record<string, string>> }>;
  setTaskSelection(tasks: string[]): Promise<void>;
  getProgramPointer(task: string): Promise<{ module?: string; routine?: string; row?: number; col?: number; executionType?: string }>;
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
