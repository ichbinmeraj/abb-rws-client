/**
 * RAPID domain path table (`/rw/rapid/**`) - execution, tasks, modules,
 * symbols, UI instructions and the program pointer.
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 *
 * Two systematic generation differences run through this domain:
 *   - SUFFIX vs PREFIX symbol paths: 2.0 `…/{symburl}/data|properties`, 1.0
 *     `…/data|properties/{symburl}`. Backwards produces 404 (read) or 500
 *     (subscribe).
 *   - task in the PATH (2.0 `/tasks/{task}/…`) vs task as a `?task=` QUERY (1.0
 *     `/rw/rapid/modules?task={task}`). Query params are documented in `note`,
 *     never put in `path`.
 */

import type { DomainTable } from './PathSpec.js';

export const RAPID: DomainTable = {
  // ── Execution ─────────────────────────────────────────────────────────────
  getRapidExecutionState: {
    summary: 'Read the RAPID execution state (running / stopped / …).',
    rws2: { method: 'GET', path: '/rw/rapid/execution' },
    rws1: { method: 'GET', path: '/rw/rapid/execution' },
    note: 'identical path.',
  },
  getRapidExecutionInfo: {
    summary: 'Read execution state and cycle from the same resource.',
    rws2: { method: 'GET', path: '/rw/rapid/execution' },
    rws1: { method: 'GET', path: '/rw/rapid/execution' },
    note: 'same resource as getRapidExecutionState (state + cycle).',
  },
  startRapid: {
    summary: 'Start RAPID execution.',
    rws2: { method: 'POST', path: '/rw/rapid/execution/start', fields: ['regain', 'execmode', 'cycle', 'condition', 'stopatbp', 'alltaskbytsp'] },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'start', fields: ['regain', 'execmode', 'cycle', 'condition', 'stopatbp', 'alltaskbytsp'] },
    note: 'path-action vs query-action; default cycle drifts: 2.0 sends `asis`, 1.0 sends `forever`.',
  },
  stopRapid: {
    summary: 'Stop RAPID execution.',
    rws2: { method: 'POST', path: '/rw/rapid/execution/stop', fields: ['stopmode'] },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'stop', fields: ['stopmode'] },
    note: 'action style only.',
  },
  resetRapid: {
    summary: 'Reset the program pointer for ALL tasks (global PP reset).',
    rws2: { method: 'POST', path: '/rw/rapid/execution/resetpp' },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'resetpp' },
    note: '2.0 wraps in edit mastership internally; resets all tasks - per-task variant is resetTaskProgramPointer.',
  },
  setExecutionCycle: {
    summary: 'Set the run cycle (once / forever / asis).',
    rws2: { method: 'POST', path: '/rw/rapid/execution/cycle', fields: ['cycle'] },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'setcycle', fields: ['cycle'] },
    note: 'action style only.',
  },
  startProductionEntry: {
    summary: 'Start from the production entry routine.',
    rws2: { method: 'POST', path: '/rw/rapid/execution/startprodentry' },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'startprodentry' },
    note: '2.0 wraps in mastership; 1.0 `?action=start-prod` never existed (live-disproved) - the real verb is startprodentry.',
  },
  stepRapid: {
    summary: 'Single-step execution (step in / over / out).',
    // No dedicated /step resource - stepping is /execution/start with a step
    // execmode. RW6 has neither /execution/start nor a step execmode, so 1.0 is
    // unreachable here. The `task` arg is ignored (start is global).
    rws2: { method: 'POST', path: '/rw/rapid/execution/start', fields: ['execmode', 'regain', 'cycle', 'condition', 'stopatbp', 'alltaskbytsp'] },
    note: 'no /step resource (404); reuses /execution/start with execmode=stepin|stepover|stepout. 1.0 unreachable (RW6 has no /execution/start).',
  },
  holdToRun: {
    summary: 'Hold-to-run dead-man gating for stepped/continuous motion.',
    // Completely different resources per generation. 2.0 ignores `task`.
    rws2: { method: 'POST', path: '/rw/rapid/execution/holdtorun', fields: ['state'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'holdtorun', fields: ['action'] },
    note: 'different resources; 1.0 wire form UNVERIFIED (400 live on RW6.16); 2.0 ignores `task`.',
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  getRapidTasks: {
    summary: 'List the RAPID tasks.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks' },
    note: 'identical; RW6.16 quirk: a healthy controller can answer 200 with an empty list mid-boot.',
  },
  activateRapidTask: {
    summary: 'Activate one RAPID task.',
    // 2.0 = collection endpoint + body field; 1.0 = item endpoint + query action.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/activate', fields: ['task'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'activate' },
    note: '2.0 collection + `task` body field (wraps mastership); 1.0 item URL + query action.',
  },
  deactivateRapidTask: {
    summary: 'Deactivate one RAPID task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/deactivate', fields: ['task'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'deactivate' },
    note: 'mirror of activateRapidTask.',
  },
  activateAllRapidTasks: {
    summary: 'Activate all RAPID tasks.',
    // 2.0 has no all-tasks path - it loops per-task activate client-side, so it
    // owns no path here. Only the 1.0 collection action is a real endpoint.
    rws1: { method: 'POST', path: '/rw/rapid/tasks', action: 'activate' },
    note: 'real all-tasks collection action exists only on 1.0; 2.0 iterates per-task client-side (no own path).',
  },
  deactivateAllRapidTasks: {
    summary: 'Deactivate all RAPID tasks.',
    rws1: { method: 'POST', path: '/rw/rapid/tasks', action: 'deactivate' },
    note: 'mirror; 2.0 iterates per-task client-side (no own path).',
  },
  getTaskStructuralChangeCount: {
    summary: 'Read the task structural-change counter.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/structural-changecount' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/structural-changecount' },
    note: 'path is 2.0-only in practice - 404 on RW6.16, where the adapter returns 0.',
  },
  getTaskChangeCount: {
    summary: 'Read the task change counter (change-count span).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/structural-changecount' },
    note: 'same resource as getTaskStructuralChangeCount, other span (`change-count`). 2.0 only.',
  },
  getTaskMotion: {
    summary: 'Read the task motion directory (links).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion' },
    note: 'both treat it as a directory of links.',
  },
  getMotionPointer: {
    summary: 'Read the per-task motion pointer.',
    // DIFFERENT resources. 1.0 reads the /motion directory as if it were pointer
    // state, so its parse almost certainly always yields `{}`.
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/syncstate/motion-pointer' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion' },
    note: 'different resources; 1.0 reads the /motion link-directory as pointer state (likely always `{}`).',
  },
  getTaskActivationRecord: {
    summary: 'Read the task activation record (stack frame).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/activation-record' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/activation-record' },
    note: '1.0 answers 400 "No such stack frame" when idle.',
  },
  getTaskProgramInfo: {
    summary: 'Read the loaded program info for a task.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/program' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/program' },
    note: '204 when no program; 1.0 `?json=1` representation is a broken template - XML only.',
  },
  loadProgram: {
    summary: 'Load a program (.pgf) into a task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/load', fields: ['progpath', 'loadmode'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/program', action: 'loadprog', fields: ['progpath'] },
    note: '1.0 has no `loadmode` field (arg accepted+ignored); action names differ (load vs loadprog).',
  },
  saveProgram: {
    summary: 'Save the task program to disk.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/save', fields: ['path'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/program', action: 'save', fields: ['path'] },
    note: 'action style only.',
  },
  getProgramPointerSyncState: {
    summary: 'Read the global program-pointer sync state.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/syncstate/program-pointer' },
    note: 'global (no {task} segment) - contrast the per-task syncstate of getMotionPointer. 2.0 only.',
  },
  getMotionPointerSyncState: {
    summary: 'Read the global motion-pointer sync state.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/syncstate/motion-pointer' },
    note: 'global variant of getMotionPointer\'s per-task path; both spellings live-used. 2.0 only.',
  },
  getSpyStatus: {
    summary: 'Read the RAPID spy status.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/spy' },
    note: 'RWS 2.0 only.',
  },
  listServiceRoutines: {
    summary: 'List a task\'s service routines.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/serviceroutine' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/serviceroutine' },
    note: 'same path; span names differ (2.0 routine_name/url_to_routine, 1.0 hyphenated) - both parse both.',
  },
  callServiceRoutine: {
    summary: 'Invoke a service routine by POSTing to the routine collection.',
    // KNOWN DEAD: the resource is GET-only, so POST returns 405. Kept for source
    // compat; the real invoke is set-PP + start. Body: routine plus arg fields.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/serviceroutine', fields: ['routine'], gap: 'GET-only resource - POST 405; kept for source compat.' },
    note: 'dead on 2.0 (POST 405); body carries `routine` plus variadic args. Real invoke = set PP + start.',
  },
  listInstructionCategories: {
    summary: 'List RAPID instruction categories (pallet head).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/pallet-head' },
    note: 'undocumented, 2.0 only.',
  },
  listInstructions: {
    summary: 'List instructions within a category (pallet).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/pallet/{category}' },
    note: 'undocumented, 2.0 only.',
  },
  getTaskSelection: {
    summary: 'Read the selected-task set.',
    rws2: { method: 'GET', path: '/rw/rapid/taskselection' },
    note: 'optional in IRWSAdapter; `/rw/rapid/taskpanel` is 404 everywhere - taskselection is the real resource. 2.0 only.',
  },
  setTaskSelection: {
    summary: 'Set the selected-task set.',
    // Hand-assembled positional body (task-1 … task-N) with an explicit
    // `application/x-www-form-urlencoded;v=2.0` content type - the only rapid
    // write that bypasses the normal body builder, so `fields` cannot name them.
    rws2: { method: 'POST', path: '/rw/rapid/taskselection' },
    note: 'positional task-1…task-N body + explicit `application/x-www-form-urlencoded;v=2.0` content type; bypasses the standard body builder. 2.0 only.',
  },
  listAliasIO: {
    summary: 'List RAPID alias-I/O signals.',
    rws2: { method: 'GET', path: '/rw/rapid/aliasio' },
    rws1: { method: 'GET', path: '/rw/rapid/aliasio' },
    note: 'identical path.',
  },

  // ── Modules ───────────────────────────────────────────────────────────────
  listModules: {
    summary: 'List the modules in a task.',
    // task-scoped subtree (2.0) vs flat collection + query param (1.0).
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules' },
    rws1: { method: 'GET', path: '/rw/rapid/modules' },
    note: '1.0 is a flat collection scoped by `?task={task}` query; 2.0 is a task-scoped subtree.',
  },
  listModulesDetailed: {
    summary: 'List modules with extended fields.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules' },
    rws1: { method: 'GET', path: '/rw/rapid/modules' },
    note: 'same endpoints as listModules, more fields parsed; 1.0 uses `?task={task}` query.',
  },
  loadModule: {
    summary: 'Load a module into a task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/loadmod', fields: ['modulepath', 'replace'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'loadmod', fields: ['modulepath', 'replace'] },
    note: '2.0 strips `$` from the path (`HOME/x`); 1.0 wants literal `$HOME/x`. 2.0 `replace` optional.',
  },
  unloadModule: {
    summary: 'Unload a module from a task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/unloadmod', fields: ['module'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'unloadmod', fields: ['module'] },
    note: 'DELETE on the module URL is 405 on 2.0 - POST only.',
  },
  getModuleInfo: {
    summary: 'Read one module\'s info.',
    // task-in-path (2.0) vs task-as-query (1.0). R1.getModule builds the
    // 2.0-shaped path inside the 1.0 mapper but is DEAD CODE (never called).
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}' },
    rws1: { method: 'GET', path: '/rw/rapid/modules/{module}' },
    note: 'task-in-path (2.0) vs `?task={task}` query (1.0). R1.getModule\'s 2.0-shaped 1.0 path is dead code.',
  },
  saveModule: {
    summary: 'Save one module to disk.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/modules/{module}/save', fields: ['name', 'path'] },
    rws1: { method: 'POST', path: '/rw/rapid/modules/{module}', action: 'save', fields: ['name', 'path'] },
    note: '1.0 scopes with `?task={task}` query. Volume form differs: 2.0 `TEMP:` colon-root only (subdirs 400) vs 1.0 `$TEMP`/full dirs. Ext: 2.0 always `.modx`, 1.0 always `.mod`. 1.0 task-level `?action=savemod` is DEAD (400 ARG_ERROR).',
  },
  listModuleRoutines: {
    summary: 'List routines in a module.',
    // 1.0 only. Path shape SUSPECT: task as a path segment, unlike every other
    // 1.0 module path (`?task=` query). Unencoded params; swallows errors and
    // silently returns [] - probably never verified.
    rws1: { method: 'GET', path: '/rw/rapid/modules/{task}/{module}/routines' },
    note: '1.0 only; SUSPECT path (task as a path segment, unlike the `?task=` convention); unencoded params; silently returns [].',
  },
  getModuleText: {
    summary: 'Read module text from program memory.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/text' },
    note: '2.0 only (program memory direct).',
  },
  setModuleText: {
    summary: 'Replace module text in program memory.',
    // `task` appears BOTH as a path segment and as a body field.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/modules/{module}/text', fields: ['task', 'text', 'path'] },
    note: '404 on 1.0; built-not-run; `task` is both a path segment and a body field.',
  },
  getModuleTextRange: {
    summary: 'Read a text range from a module.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/text/range' },
    note: 'read uses query params (startrow/startcol/endrow/endcol); the write below uses form fields - same resource, two encodings. 2.0 only.',
  },
  setModuleTextRange: {
    summary: 'Replace a text range in a module.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/modules/{module}/text/range', fields: ['task', 'replace-mode', 'query-mode', 'startrow', 'startcol', 'endrow', 'endcol', 'text'] },
    note: 'controller\'s own form action advertises `/textrange` (no slash) which 404s - `/text/range` is correct. 2.0 only.',
  },
  searchModuleText: {
    summary: 'Search module text.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/text/search' },
    note: 'query param is `text`; the documented `searchstring` is rejected. 2.0 only.',
  },
  getModuleChangeCount: {
    summary: 'Read a module\'s change counter.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/changecount' },
    note: '2.0 only.',
  },
  getModuleSyncPersStatus: {
    summary: 'Read a module\'s persistent-variable sync status.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/sync-pers' },
    note: '2.0 only.',
  },
  getModuleExtension: {
    summary: 'Read a module\'s extension info.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/module-extension' },
    note: '2.0 only.',
  },
  modifyPosition: {
    summary: 'Modify a position (ModPos) in a module.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/modules/{module}/modify-position', fields: ['startrow', 'startcol', 'endrow', 'endcol', 'checklimit', 'checkdeactaxes', 'allowdeact', 'text'] },
    note: 'built-not-run; needs RAPID mastership; endrow/col default to start. 2.0 only.',
  },

  // ── Symbols / variables ───────────────────────────────────────────────────
  getRapidVariable: {
    summary: 'Read a RAPID symbol\'s value.',
    // SUFFIX vs PREFIX: 2.0 puts `/data` AFTER the symburl, 1.0 BEFORE it.
    rws2: { method: 'GET', path: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data' },
    rws1: { method: 'GET', path: '/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}' },
    note: 'suffix vs prefix: 2.0 `…/{symburl}/data`, 1.0 `…/data/{symburl}`.',
  },
  setRapidVariable: {
    summary: 'Write a RAPID symbol\'s value.',
    rws2: { method: 'POST', path: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data', fields: ['value'] },
    rws1: { method: 'POST', path: '/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}', action: 'set', fields: ['value'] },
    note: '2.0 plain POST, 1.0 `?action=set`; same suffix/prefix inversion as getRapidVariable.',
  },
  getRapidSymbolProperties: {
    summary: 'Read a RAPID symbol\'s properties.',
    rws2: { method: 'GET', path: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/properties' },
    rws1: { method: 'GET', path: '/rw/rapid/symbol/properties/RAPID/{task}/{module}/{symbol}' },
    note: 'same suffix/prefix inversion (2.0 `…/properties`, 1.0 `properties/…`).',
  },
  searchRapidSymbols: {
    summary: 'Search RAPID symbols.',
    // Scoping differs: 2.0 by `blockurl` (a `task` field 400s), 1.0 by `task`.
    rws2: { method: 'POST', path: '/rw/rapid/symbols/search', fields: ['view', 'symtyp', 'recursive', 'vartyp', 'dattyp', 'regexp', 'blockurl'] },
    rws1: { method: 'POST', path: '/rw/rapid/symbols', action: 'search-symbol', fields: ['task', 'view', 'vartyp', 'symtyp', 'dattyp', 'regexp', 'blockurl', 'recursive'] },
    note: '1.0 is BROKEN on RW6.16 (documented `?action=search-symbol` → 400; wire form undiscovered). Scoping: 2.0 `blockurl` (a `task` field 400s) vs 1.0 `task`.',
  },
  validateRapidValue: {
    summary: 'Validate a value against a RAPID data type.',
    // The ONLY rapid 2.0 write still using a `?action=` query action; and its
    // path is task-scoped while 1.0's is global. Field name differs too.
    rws2: { method: 'POST', path: '/rw/rapid/symbol/RAPID/{task}/data', action: 'validate', fields: ['value', 'dattyp'] },
    rws1: { method: 'POST', path: '/rw/rapid/symbol/data', action: 'validate', fields: ['task', 'value', 'datatype'] },
    note: 'field name `dattyp` (2.0) vs `datatype` (1.0); 2.0 path task-scoped, 1.0 global; 2.0 is the only rapid 2.0 write still using a `?action=` query action.',
  },

  // ── UI instructions ───────────────────────────────────────────────────────
  getActiveUiInstruction: {
    summary: 'Read the active UI instruction.',
    rws2: { method: 'GET', path: '/rw/rapid/uiinstr/active' },
    rws1: { method: 'GET', path: '/rw/rapid/uiinstr/active' },
    note: 'identical; `GET …/active/params` is 404 everywhere (no read side for params).',
  },
  setUiInstructionParam: {
    summary: 'Answer a UI instruction parameter.',
    rws2: { method: 'POST', path: '/rw/rapid/uiinstr/active/param/{stackurl}/{uiparam}', fields: ['value'] },
    rws1: { method: 'POST', path: '/rw/rapid/uiinstr/active/param/{stackurl}/{uiparam}', action: 'set', fields: ['value'] },
    note: 'action-suffix only; both encodeURIComponent the stackurl.',
  },

  // ── Program pointer (pcp) & breakpoints ────────────────────────────────────
  getProgramPointer: {
    summary: 'Read the program pointer for a task.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/pcp' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/pcp' },
    note: 'identical; both tolerate the controller\'s `modulemame` span typo.',
  },
  setProgramPointer: {
    summary: 'Set the program pointer to a routine.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/routine', fields: ['routine', 'module', 'userlevel'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp', action: 'set-pp-routine', fields: ['module', 'routine'] },
    note: '1.0 requires `module` (throws without) and both are mandatory; no row/col on either (2.0 form has none - use cursor).',
  },
  setPPToCursor: {
    summary: 'Set the program pointer to a module cursor position.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/cursor', fields: ['module', 'begin-position-row', 'begin-position-col'] },
    note: '2.0 only.',
  },
  ppPrevInst: {
    summary: 'Move the program pointer to the previous instruction (manual mode).',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/prev-inst' },
    note: '2.0 only, manual mode.',
  },
  ppNextInst: {
    summary: 'Move the program pointer to the next instruction (manual mode).',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/next-inst' },
    note: '2.0 only.',
  },
  setPPToRoutineFromUrl: {
    summary: 'Set the program pointer to a routine by URL.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/routine-from-url', fields: ['routineurl', 'userlevel'] },
    note: '2.0 only.',
  },
  resetTaskProgramPointer: {
    summary: 'Reset the program pointer for one task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/reset' },
    note: '2.0 only; per-task counterpart of the global execution/resetpp (resetRapid).',
  },
  listBreakpoints: {
    summary: 'List breakpoints in a task.',
    // PARENT differs: 2.0 under /program, 1.0 at the task root.
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/program/breakpoints' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/breakpoints' },
    note: 'parent differs: 2.0 under `/program`, 1.0 at task root; item class/spans best-effort on both.',
  },
  setBreakpoint: {
    summary: 'Set a breakpoint.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/breakpoints', fields: ['module', 'row', 'column'] },
    note: 'field names are `row`/`column` (begin-position-* rejected). 2.0 only.',
  },
  removeBreakpoint: {
    summary: 'Remove a breakpoint.',
    // The only rapid-domain DELETE; the form is UNCONFIRMED (DELETE answered 405
    // in probes). module/row/column are passed as query params.
    rws2: { method: 'DELETE', path: '/rw/rapid/tasks/{task}/program/breakpoints' },
    note: 'UNCONFIRMED form (DELETE → 405 in probes); only rapid-domain DELETE; module/row/column passed as query params. 2.0 only.',
  },
};
