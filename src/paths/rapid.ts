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
    tier: 'core', evidence: 'live',
    summary: 'Read the RAPID execution state (running / stopped / …).',
    rws2: { method: 'GET', path: '/rw/rapid/execution' },
    rws1: { method: 'GET', path: '/rw/rapid/execution' },
    note: 'identical path.',
  },
  getRapidExecutionInfo: {
    tier: 'core', evidence: 'live',
    summary: 'Read execution state and cycle from the same resource.',
    rws2: { method: 'GET', path: '/rw/rapid/execution' },
    rws1: { method: 'GET', path: '/rw/rapid/execution' },
    note: 'same resource as getRapidExecutionState (state + cycle).',
  },
  getExecutionErrorState: {
    tier: 'common', evidence: 'live',
    summary: 'Read whether the most recent RAPID stop was caused by an error (RobotWare 8.2 and later).',
    // ABB's RWS site, RAPID Service, RobotWare 8 view: "Get RAPID Execution
    // Error State", badged "Since RW8.2.0" (read 2026-10-09): a TRUE/FALSE
    // flag, whether the most recent RAPID execution stop was caused by an
    // error, back to FALSE when the program restarts. Not in RWS 2.0 Rev L.
    // A raw GET answered 200 on RW 8.2.1 (entry rap-execerrorstate, field
    // execerrorstate, FALSE) and 404 on RW 7.21.4 (2026-10-06); the client's
    // read answered false on RW 8.2.1 and RW 7.21.4's typed 404 (2026-10-21).
    rws2: { method: 'GET', path: '/rw/rapid/execution/execerrorstate' },
    note: 'RobotWare 8.2 and later (RWS site, RobotWare 8 view); not in Rev L, no RWS 1.0 resource, 404 on RW 7.21.4. Entry rap-execerrorstate, field execerrorstate TRUE or FALSE. Sent on any RWS 2.0 controller; the controller decides.',
  },
  startRapid: {
    tier: 'core', evidence: 'live',
    summary: 'Start RAPID execution.',
    rws2: { method: 'POST', path: '/rw/rapid/execution/start', fields: ['regain', 'execmode', 'cycle', 'condition', 'stopatbp', 'alltaskbytsp'] },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'start', fields: ['regain', 'execmode', 'cycle', 'condition', 'stopatbp', 'alltaskbytsp'] },
    note: 'path-action vs query-action; default cycle drifts: 2.0 sends `asis`, 1.0 sends `forever`.',
  },
  stopRapid: {
    tier: 'core', evidence: 'live',
    summary: 'Stop RAPID execution.',
    rws2: { method: 'POST', path: '/rw/rapid/execution/stop', fields: ['stopmode'] },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'stop', fields: ['stopmode'] },
    note: 'action style only.',
  },
  resetRapid: {
    tier: 'core', evidence: 'live',
    summary: 'Reset the program pointer for ALL tasks (global PP reset).',
    rws2: { method: 'POST', path: '/rw/rapid/execution/resetpp' },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'resetpp' },
    note: '2.0 wraps in edit mastership internally; resets all tasks - per-task variant is resetTaskProgramPointer.',
  },
  setExecutionCycle: {
    tier: 'common', evidence: 'live',
    summary: 'Set the run cycle (once / forever / asis).',
    rws2: { method: 'POST', path: '/rw/rapid/execution/cycle', fields: ['cycle'] },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'setcycle', fields: ['cycle'] },
    note: 'action style only.',
  },
  startProductionEntry: {
    tier: 'common', evidence: 'live',
    summary: 'Start from the production entry routine.',
    rws2: { method: 'POST', path: '/rw/rapid/execution/startprodentry' },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'startprodentry' },
    note: '2.0 wraps in mastership; 1.0 `?action=start-prod` never existed (live-disproved) - the real verb is startprodentry.',
  },
  stepRapid: {
    tier: 'common', evidence: { rws1: 'built', rws2: 'live' },
    summary: 'Single-step execution (step in / over / out).',
    // No dedicated /step resource - stepping is the start with a step
    // execmode. The `task` arg is ignored (start is global). RWS 1.0: ABB's
    // "Start RAPID Execution" page (RWS 1.0 Rev M) lists, all Required,
    // "execmode={continue | stepin | stepover | stepout | stepback | steplast | stepmotion}"
    // with regain, cycle, condition, stopatbp and alltaskbytsp on
    // POST /rw/rapid/execution?action=start.
    rws2: { method: 'POST', path: '/rw/rapid/execution/start', fields: ['execmode', 'regain', 'cycle', 'condition', 'stopatbp', 'alltaskbytsp'] },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'start', fields: ['regain', 'execmode', 'cycle', 'condition', 'stopatbp', 'alltaskbytsp'] },
    note: 'no /step resource (404); the start with execmode=stepin|stepover|stepout on both generations (RWS 1.0: ?action=start, ABB RWS 1.0 Rev M start page).',
  },
  holdToRun: {
    tier: 'niche', evidence: { rws1: 'live', rws2: 'built' },
    summary: 'Hold-to-run dead-man gating for stepped/continuous motion.',
    // Both generations post one field, `state` (press | held | release), on the
    // execution resource; neither uses `task`. 1.0 is the `holdtorun-state`
    // form RW 6.16.03 advertises on `GET /rw/rapid/execution?action=show`
    // (read 2026-09-29), as ABB's RWS 1.0 manual (Rev M, "Set Hold to Run
    // Cmd") documents it. The task-level `?action=holdtorun` with body
    // `action=` answered 400 on RW 6.16.
    rws2: { method: 'POST', path: '/rw/rapid/execution/holdtorun', fields: ['state'] },
    rws1: { method: 'POST', path: '/rw/rapid/execution', action: 'holdtorun-state', fields: ['state'] },
    note: '1.0 is the advertised execution?action=holdtorun-state form (RW 6.16.03; RWS 1.0 Rev M "Set Hold to Run Cmd"), accepted on RobotWare 6.16.03 (2026-10-09); both generations ignore `task`.',
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  getRapidTasks: {
    tier: 'common', evidence: 'live',
    summary: 'List the RAPID tasks.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks' },
    note: 'identical; RW6.16 quirk: a healthy controller can answer 200 with an empty list mid-boot.',
  },
  getRapidTask: {
    tier: 'common', evidence: 'live',
    summary: 'Read one RAPID task (state and properties).',
    // ABB: RWS 2.0 "Get RAPID Task State" (RAPID service, Rev L); RWS 1.0
    // "Get Task" (Rev M). RW 6.16.03 serves the task resource (its
    // ?action=show form, read 2026-09-29); RW 7.21.4 and 8.2.1 link
    // tasks/{task} from the task list (read 2026-09-29).
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}' },
    note: 'Same path. The plain GET body has not been captured on any build yet; the client reads the rap-task (or rap-task-li) entry and fails with PARSE_ERROR when neither is present.',
  },
  activateRapidTask: {
    tier: 'common', evidence: 'live',
    summary: 'Activate one RAPID task.',
    // 2.0: ABB documents and the controller serves the per-task resource
    // POST /rw/rapid/tasks/{task}/activate with no fields (RAPID_Service Rev L;
    // OPTIONS on RW 7.21.4 and 8.2.1, 2026-10-07/09). The client used to post
    // `task=` to the all-tasks resource /rw/rapid/tasks/activate, whose form
    // has no fields, so the controller either refused the field or acted on
    // more than the one task (spec check 2026-10-07). 1.0 = item URL + query action.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/activate' },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'activate' },
    note: '2.0 per-task resource, no body (wraps mastership); 1.0 item URL + query action. The documented all-tasks POST /rw/rapid/tasks/activate is not used until a MultiMove run shows its scope.',
  },
  deactivateRapidTask: {
    tier: 'common', evidence: 'live',
    summary: 'Deactivate one RAPID task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/deactivate' },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'deactivate' },
    note: 'mirror of activateRapidTask: 2.0 per-task /deactivate with no body (the client used to post task= to /rw/rapid/tasks/deactivate).',
  },
  activateAllRapidTasks: {
    tier: 'common', evidence: 'live',
    summary: 'Activate all RAPID tasks.',
    // 2.0 has no all-tasks path - it loops per-task activate client-side, so it
    // owns no path here. Only the 1.0 collection action is a real endpoint.
    rws1: { method: 'POST', path: '/rw/rapid/tasks', action: 'activate' },
    note: 'real all-tasks collection action exists only on 1.0; 2.0 iterates per-task client-side (no own path).',
  },
  deactivateAllRapidTasks: {
    tier: 'common', evidence: 'live',
    summary: 'Deactivate all RAPID tasks.',
    rws1: { method: 'POST', path: '/rw/rapid/tasks', action: 'deactivate' },
    note: 'mirror; 2.0 iterates per-task client-side (no own path).',
  },
  getTaskStructuralChangeCount: {
    tier: 'common', evidence: 'live',
    summary: 'Read the task structural-change counter.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/structural-changecount' },
    // RWS 1.0 reads it as a query on the task (Rev M "Get Structural Change
    // Count"); the 2.0 sub-path answers 404 on RW 6.16.03 (2026-10-09).
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}', query: 'resource=task-struc-change-count' },
    note: '2.0 sub-path vs 1.0 ?resource= on the task.',
  },
  getTaskChangeCount: {
    tier: 'common', evidence: 'live',
    summary: 'Read the task change counter (change-count span).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/structural-changecount' },
    note: 'same resource as getTaskStructuralChangeCount, other span (`change-count`). ABB gives both spans in the answer, so a logged 2xx counts for both rows. 2.0 only.',
  },
  getTaskMotion: {
    tier: 'common', evidence: 'live',
    summary: 'Read the task motion directory (links).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion' },
    note: 'both treat it as a directory of links.',
  },
  // The four task motion sub-resources ABB's RAPID service page documents
  // under /motion. RW 7.21.0, 7.21.4, 8.1.1 and 8.2.1 link all four from the
  // /motion directory and answer each one 200 (hal+json and XHTML alike);
  // OPTIONS on each answered 204 with Allow ",POST,OPTIONS" (2026-10-03,
  // scripts/probe-config-task-motion.mjs). RWS 1.0 not probed.
  getTaskRobTarget: {
    tier: 'common', evidence: 'live',
    summary: 'Read the task\'s current robtarget (mm, quaternion, robconf, external axes).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion/robtarget' },
    note: 'RWS 2.0 only. Class rapid-robtarget: x y z q1..q4 cf1 cf4 cf6 cfx eax_a..eax_f.',
  },
  getTaskJointTarget: {
    tier: 'common', evidence: 'live',
    summary: 'Read the task\'s current jointtarget (degrees; external axes 9E9 when absent).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion/jointtarget' },
    note: 'RWS 2.0 only. Class rapid-jointtarget: rax_1..rax_6 eax_a..eax_f.',
  },
  getTaskMechunits: {
    tier: 'common', evidence: 'live',
    summary: 'List the mechanical units the task drives, with mode and type.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion/mechunits' },
    note: 'RWS 2.0 only. One rapid-mechunit entry per unit: name, mode, type.',
  },
  getTaskExtJointState: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the state of the task\'s six external joints.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/motion/extjointstate' },
    note: 'RWS 2.0 only. Class rapid-extjointstate: j1..j6 (not_active on a robot with no external axis).',
  },
  getMotionPointer: {
    tier: 'common', evidence: 'built',
    summary: 'Read the per-task motion pointer.',
    // ABB serves both pointers in one resource: GET .../pcp answers a pcp-info
    // entry titled progpointer and one titled motionpointer (RWS 1.0 Rev M
    // "Get RAPID task Motion&Program pointer positions"; RWS 2.0 Rev L RAPID
    // service, /rw/rapid/tasks/{task}/pcp). The client used to read the
    // /motion link directory (1.0) and the per-task motion-pointer sync state
    // (2.0); neither holds the position. With no program started, RW 6.16.03
    // and 8.2.1 answered the motionpointer entry with an error link and no
    // position (2026-09-27). While a MoveAbsJ ran, the client read row 9 col 16
    // from a filled entry on RW 6.16.03 and 7.21.4 virtual controllers
    // (2026-10-18).
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/pcp' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/pcp' },
    note: 'same request as getProgramPointer; reads the entry titled motionpointer (row,col under beginposition or begposition, module under modulename or modulemame, routinename). RW 6.16.03 and 7.21.4 send the start as begposition in this entry; ABB\'s Rev M example keeps it under beginposition (2026-10-18). Stays built: it sends the same request as getProgramPointer, whose answer carries this entry with no position when no program has started, and the logs keep no answer body, so a logged 2xx does not show that a position was read. The parsed motion pointer (row 9 col 16) was logged on RW 6.16.03 and 7.21.4 virtual controllers.',
  },
  getTaskActivationRecord: {
    tier: 'niche', evidence: 'built',
    summary: 'Read the task activation record (stack frame).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/activation-record' },
    // RWS 1.0 reads it as a query on the task with a stack frame (Rev M "Get
    // Activation Record"); the 2.0 sub-path answers 404 on RW 6.16.03.
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}', query: 'resource=activation-record' },
    // ABB's answer is one rap-stackframe entry on both generations (RWS 1.0
    // Rev M, RWS 2.0 Rev L); the RWS 2.0 read used to look for a class ABB
    // does not use, so a 200 read as {}.
    note: '1.0 takes &stackframe=N (1 = current) and answers 400 "No such stack frame" when idle. The answer is one rap-stackframe entry (execlevel, beg-row, beg-col, end-row, end-col, stack-url, routine-url) on both generations.',
  },
  getTaskProgramInfo: {
    tier: 'common', evidence: 'live',
    summary: 'Read the loaded program info for a task.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/program' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/program' },
    note: '204 when no program; 1.0 `?json=1` representation is a broken template - XML only.',
  },
  loadProgram: {
    tier: 'common', evidence: 'live',
    summary: 'Load a program (.pgf) into a task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/load', fields: ['progpath', 'loadmode'] },
    // RWS 1.0 takes loadmode {add | replace} too (the RW 6.16.03 form and Rev M;
    // loadmode=add answered 204 on 2026-10-09). It used to be accepted and dropped.
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/program', action: 'loadprog', fields: ['progpath', 'loadmode'] },
    note: 'action names differ (load vs loadprog).',
  },
  unloadProgram: {
    tier: 'common', evidence: 'live',
    summary: 'Unload the program from a task.',
    // RWS 2.0 Rev L "Unload Program from a RAPID Task": POST, no body, 204,
    // "Mastership is required"; the optional mastership={implicit|explicit}
    // query is RobotWare 7 only (the RWS site's RobotWare 8 view drops it).
    // RWS 1.0 Rev M "Unload program from a rapid task": POST with
    // ?action=unloadprog, no data, 204. RW 6.16.03 serves the empty
    // unloadprog form on program?action=show (2026-10-09). The client's
    // unload answered 204 on RW 6.16.03 (RAPID mastership; Module1 went with
    // ZZ_PROBE, the system modules stayed), 7.21.4 (edit) and 8.2.1 (write
    // access), 2026-10-21.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/unload' },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/program', action: 'unloadprog' },
    note: 'counterpart of loadProgram: 2.0 /program/unload vs 1.0 ?action=unloadprog, no body on either. Held like loadProgram (RobotWare 6: RAPID mastership; 7: edit; 8: write access). unloadModule takes out one module only.',
  },
  getBuildErrors: {
    tier: 'common', evidence: 'live',
    summary: 'List the build errors of a task\'s program (module, row, column, error).',
    // ABB "Get Build Errors", RWS 1.0 Rev M and RWS 2.0 Rev L: the same
    // GET, optional start (default 1) and limit (at most 30) queries, prev and
    // next links, one rap-builderrs entry per error. RW 6.16.03's program
    // resource links it (rap-builderrs-li, 2026-09-29). RW 7.21.4 and 8.2.1
    // answered the bare GET 200 with an empty list and a self link ?limit=30
    // (2026-10-06). With a module that does not build, the client's read
    // listed its error on all three (row, column, text; RWS 2.0 also the
    // number and type_of_error), read as XHTML: RWS 2.0's hal+json form of it
    // is not JSON (2026-10-21).
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/program/builderror' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/program/builderror' },
    note: 'Same path; paged (start, limit at most 30, next link), every page read. Entries rap-builderrs: ModuleName, row, column, error (Rev L adds error-num). RWS 1.0 is read as XHTML, the form ABB documents: its program resource answers ?json=1 with an unrendered template.',
  },
  saveProgram: {
    tier: 'common', evidence: 'live',
    summary: 'Save the task program to disk.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/save', fields: ['path'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/program', action: 'save', fields: ['path'] },
    note: 'action style only.',
  },
  getProgramPointerSyncState: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the global program-pointer sync state.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/syncstate/program-pointer' },
    note: 'global (no {task} segment); ABB also documents a per-task sync state under /rw/rapid/tasks/{task}/syncstate, which the client does not read. 2.0 only.',
  },
  getMotionPointerSyncState: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the global motion-pointer sync state.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/syncstate/motion-pointer' },
    note: 'global; the per-task /rw/rapid/tasks/{task}/syncstate/motion-pointer (Rev L) is not read by the client: getMotionPointer reads the position from .../pcp. 2.0 only.',
  },
  getSpyStatus: {
    tier: 'niche', evidence: 'live',
    summary: 'Read the RAPID spy status.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/spy' },
    note: 'RWS 2.0 only.',
  },
  listServiceRoutines: {
    tier: 'common', evidence: 'live',
    summary: 'List a task\'s service routines.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/serviceroutine' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/serviceroutine' },
    note: 'same path; span names differ (2.0 routine_name/url_to_routine, 1.0 hyphenated) - both parse both.',
  },
  callServiceRoutine: {
    tier: 'niche', evidence: 'built',
    summary: 'Invoke a service routine (no such RWS 2.0 operation).',
    // Rev L documents the resource as a GET listing only, and the controller
    // advertises Allow GET,OPTIONS (RW 7.21.4 and 8.2.1, 2026-10-09). The
    // client throws UNSUPPORTED_OPERATION without sending; it used to POST and
    // get 405 because the resource is GET-only (spec check 2026-10-07). A
    // service routine runs by setting the program pointer to it and starting.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/serviceroutine', fields: ['routine'], gap: 'GET-only resource; nothing is sent (UNSUPPORTED_OPERATION)' },
    note: 'not an RWS operation on either generation: the service-routine resource is a GET listing (RWS 1.0 Rev M, RWS 2.0 Rev L). Run one with setPPToServiceRoutine and start. RWS 1.0 has no method; RobotManager refuses it there.',
  },
  listInstructionCategories: {
    tier: 'niche', evidence: 'live',
    summary: 'List RAPID instruction categories (pallet head).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/pallet-head' },
    note: 'undocumented, 2.0 only.',
  },
  listInstructions: {
    tier: 'niche', evidence: 'live',
    summary: 'List instructions within a category (pallet).',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/pallet/{category}' },
    note: 'undocumented, 2.0 only.',
  },
  getTaskSelection: {
    tier: 'common', evidence: 'live',
    summary: 'Read the selected-task set.',
    rws2: { method: 'GET', path: '/rw/rapid/taskselection' },
    // RWS 1.0 Rev M "Get user modify from taskpanel": the same resource and
    // the same rap-taskselection entries (name, state, motiontask, usermodify).
    rws1: { method: 'GET', path: '/rw/rapid/taskselection' },
    note: 'optional in IRWSAdapter; `/rw/rapid/taskpanel` is 404 everywhere - taskselection is the real resource. Same path and class on both generations; RW 6.16.03 answered T_ROB1 ON (2026-10-18).',
  },
  setTaskSelection: {
    tier: 'common', evidence: 'built',
    summary: 'Set the whole task selection at once (no such RWS operation).',
    // No controller resource takes this write: ABB's RWS 1.0 (Rev M) and RWS
    // 2.0 (Rev L) document only GET on /rw/rapid/taskselection, and RW 7.21.4
    // and 8.2.1 answer a POST with 405 -1073414146 (OPTIONS lists GET,OPTIONS
    // and a subscription form only; recorded 2026-10-11). ABB changes the
    // selection one task at a time (activate / deactivate a task "in the task
    // panel"). The client refuses before sending on both generations: the RWS
    // 1.0 adapter has no such method, so RobotManager refuses it there.
    rws2: {
      method: 'POST', path: '/rw/rapid/taskselection',
      gap: 'No operation sets the whole task selection on either generation: ABB documents only GET on /rw/rapid/taskselection (RWS 1.0 Rev M, RWS 2.0 Rev L), and RW 7.21.4 and 8.2.1 answer a POST with 405 -1073414146 "HTTP method not supported by resource" (OPTIONS: GET,OPTIONS; 2026-10-11). ABB changes the selection one task at a time: use activateRapidTask / deactivateRapidTask. The client refuses before sending, on RWS 1.0 too.',
    },
    note: 'no resource takes the write on either generation (gap): the selection is read with getTaskSelection and changed one task at a time with activateRapidTask / deactivateRapidTask, or at the FlexPendant task panel.',
  },
  listAliasIO: {
    tier: 'niche', evidence: { rws1: 'live', rws2: 'built' },
    summary: 'List RAPID alias-I/O signals.',
    rws2: { method: 'GET', path: '/rw/rapid/aliasio' },
    rws1: { method: 'GET', path: '/rw/rapid/aliasio' },
    // ABB's entries are rap-alias-io with alias-name, signal-name and type on
    // both generations (RWS 1.0 Rev M, RWS 2.0 Rev L). rap-aliasio-li is the
    // link to this resource in the /rw/rapid listing; the client used to read
    // that class, so a filled list read as [].
    note: 'identical path. One rap-alias-io entry per alias (alias-name, signal-name, type). The RWS 1.0 runs answered an empty list.',
  },

  // ── Modules ───────────────────────────────────────────────────────────────
  listModules: {
    tier: 'common', evidence: 'live',
    summary: 'List the modules in a task.',
    // task-scoped subtree (2.0) vs flat collection + query param (1.0).
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules' },
    rws1: { method: 'GET', path: '/rw/rapid/modules' },
    note: '1.0 is a flat collection scoped by `?task={task}` query; 2.0 is a task-scoped subtree.',
  },
  listModulesDetailed: {
    tier: 'common', evidence: 'live',
    summary: 'List modules with extended fields.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules' },
    rws1: { method: 'GET', path: '/rw/rapid/modules' },
    note: 'same endpoints as listModules, more fields parsed; 1.0 uses `?task={task}` query.',
  },
  loadModule: {
    tier: 'common', evidence: 'live',
    summary: 'Load a module into a task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/loadmod', fields: ['modulepath', 'replace'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'loadmod', fields: ['modulepath', 'replace'] },
    note: '2.0 strips `$` from the path (`HOME/x`); 1.0 wants literal `$HOME/x`. 2.0 `replace` optional.',
  },
  unloadModule: {
    tier: 'common', evidence: 'live',
    summary: 'Unload a module from a task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/unloadmod', fields: ['module'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}', action: 'unloadmod', fields: ['module'] },
    note: 'DELETE on the module URL is 405 on 2.0 - POST only.',
  },
  getModuleInfo: {
    tier: 'common', evidence: 'live',
    summary: 'Read one module\'s info.',
    // task-in-path (2.0) vs task-as-query (1.0). R1.getModule builds the
    // 2.0-shaped path inside the 1.0 mapper but is DEAD CODE (never called).
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}' },
    rws1: { method: 'GET', path: '/rw/rapid/modules/{module}' },
    note: 'task-in-path (2.0) vs `?task={task}` query (1.0). R1.getModule\'s 2.0-shaped 1.0 path is dead code.',
  },
  saveModule: {
    tier: 'common', evidence: 'live',
    summary: 'Save one module to disk.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/modules/{module}/save', fields: ['name', 'path'] },
    rws1: { method: 'POST', path: '/rw/rapid/modules/{module}', action: 'save', fields: ['name', 'path'] },
    note: '1.0 scopes with `?task={task}` query. Volume form differs: 2.0 `TEMP:` colon-root only (subdirs 400) vs 1.0 `$TEMP`/full dirs. Ext: 2.0 always `.modx`, 1.0 always `.mod`. 1.0 task-level `?action=savemod` is DEAD (400 ARG_ERROR).',
  },
  listModuleRoutines: {
    tier: 'common', evidence: 'live',
    summary: 'List routines in a module.',
    // RWS 2.0: the module-scoped symbol search, as on 1.0. ABB's "Get Routine
    // Information" (GET .../modules/{module}/routine, RAPID service Rev L) is
    // linked from the module body on RW 7.21.4 and 8.2.1 (read 2026-09-29) but
    // is not a listing: RW 7.21.4 answered a plain GET 400 "Row or Column
    // invalid/missing" (2026-10-01). RW 7.21.4 answered the non-recursive
    // module search with the module's PROC, symtyp prc (2026-09-29).
    rws2: { method: 'POST', path: '/rw/rapid/symbols/search', fields: ['view', 'blockurl', 'symtyp', 'recursive'] },
    // RWS 1.0 has no routine sub-resource the controller links: the RW 6.16.03
    // module body carries no routine link (read 2026-09-29), and the path used
    // before (/rw/rapid/modules/{task}/{module}/routines, errors swallowed into
    // []) was never verified. The routines come from the module-scoped symbol
    // search instead, which RW 6.16.03 answers with the module's PROC entries
    // (symtyp prc; live-read 2026-09-29).
    rws1: { method: 'POST', path: '/rw/rapid/symbols', action: 'search-symbols', fields: ['task', 'view', 'symtyp', 'blockurl', 'recursive'] },
    note: 'Both generations = the module-scoped symbol search (blockurl RAPID/{task}/{module}), kept to prc/fun/trp hits directly in the module. 2.0 sends view=block, symtyp=any, recursive=FALSE and reads every entry of the answer by symtyp, whatever its class. 2.0 GET .../modules/{module}/routine reads the routine at a text position (400 "Row or Column invalid/missing" without one, RW 7.21.4, 2026-10-01) and is not used. The 1.0 row documents the request; the call itself is built from the searchRapidSymbols row.',
  },
  getModuleText: {
    tier: 'common', evidence: 'live',
    summary: 'Read module text from program memory.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/text' },
    // RWS 1.0 is a FLAT module collection scoped by ?task= query, whole text
    // selected by ?resource=module-text (the query is added by the adapter).
    // Live-verified on the RobotWare 6.16 virtual controller (2026-08-11): 200.
    rws1: { method: 'GET', path: '/rw/rapid/modules/{module}' },
    note: 'RWS 2.0 task-in-path /text; RWS 1.0 flat /rw/rapid/modules/{module}?resource=module-text&task={task}.',
  },
  setModuleText: {
    tier: 'common', evidence: 'live',
    summary: 'Replace module text in program memory.',
    // `task` appears BOTH as a path segment and as a body field.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/modules/{module}/text', fields: ['task', 'text', 'path'] },
    // RWS 1.0: the flat module resource with ?action=set-module-text, scoped by
    // ?task= like the module save. The form RW 6.16.03 serves on
    // `modules/{module}?action=show` (read 2026-09-29) lists `task` and `text`.
    rws1: { method: 'POST', path: '/rw/rapid/modules/{module}', action: 'set-module-text', fields: ['task', 'text'] },
    note: 'run live on 1.0 (RW 6.16.03, 2026-10-09) and on 2.0 (RW 7.21.4, 2026-10-11, text read back); 2.0 `task` is both a path segment and a body field. 1.0 is the flat /rw/rapid/modules/{module}?task={task}&action=set-module-text (form on RW 6.16.03, 2026-09-29: task, text; no path field).',
  },
  getModuleTextRange: {
    tier: 'common', evidence: 'live',
    summary: 'Read a text range from a module.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/text/range' },
    // RWS 1.0: same flat /rw/rapid/modules/{module} URL, range selected purely by
    // the startrow/startcol/endrow/endcol query params (NO resource verb),
    // scoped by task. endcol=-1 means end-of-line. Live-verified RW6.16 (2026-08-11).
    rws1: { method: 'GET', path: '/rw/rapid/modules/{module}' },
    note: 'read uses query params (startrow/startcol/endrow/endcol); the write below uses form fields. RWS 1.0 is the flat /rw/rapid/modules/{module}?task={task}&startrow=..&endcol=-1 form (no resource verb).',
  },
  setModuleTextRange: {
    tier: 'common', evidence: 'live',
    summary: 'Replace a text range in a module.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/modules/{module}/text/range', fields: ['task', 'replace-mode', 'query-mode', 'startrow', 'startcol', 'endrow', 'endcol', 'text'] },
    // RWS 1.0: same flat module resource, ?action=set-text-range; the RW 6.16.03
    // form (2026-09-29) lists the same eight fields as the 2.0 form, in this order.
    rws1: { method: 'POST', path: '/rw/rapid/modules/{module}', action: 'set-text-range', fields: ['task', 'replace-mode', 'query-mode', 'startrow', 'startcol', 'endrow', 'endcol', 'text'] },
    note: '2.0: the controller\'s own form action advertises `/textrange` (no slash) which 404s - `/text/range` is correct. 1.0 is /rw/rapid/modules/{module}?task={task}&action=set-text-range (form on RW 6.16.03, 2026-09-29). Run live on 1.0 (RW 6.16.03, 2026-10-09) and on 2.0 (RW 7.21.4, 2026-10-11, text read back).',
  },
  searchModuleText: {
    tier: 'common', evidence: 'live',
    summary: 'Search module text.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/text/search' },
    note: 'query param is `text`; the documented `searchstring` is rejected. 2.0 only.',
  },
  getModuleChangeCount: {
    tier: 'common', evidence: 'live',
    summary: 'Read a module\'s change counter.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/changecount' },
    note: '2.0 only.',
  },
  getModuleSyncPersStatus: {
    tier: 'niche', evidence: 'live',
    summary: 'Read a module\'s persistent-variable sync status.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/sync-pers' },
    note: '2.0 only.',
  },
  getModuleExtension: {
    tier: 'niche', evidence: 'live',
    summary: 'Read a module\'s extension info.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/module-extension' },
    note: '2.0 only.',
  },
  // The next five are linked from the module resource on RW 7.21.4+417 and
  // 8.2.1+1023 (2026-09-29: rap-module-mod-possible-li, rap-module-symbol-li,
  // rap-module-possible-attributes-li, rap-module-object-li) and from /rw/rapid
  // (rap-modules-li). ABB's RAPID Service page names them (Get Mod Possible
  // All, Get Mod Possible, Get Symbol Information, Get Module Possible
  // Attributes, Get RAPID Object); their item classes are not recorded, so the
  // client returns every entry as read.
  getModPossibleAll: {
    tier: 'niche', evidence: 'live',
    summary: 'Read whether modification (ModPos) is possible across all modules.',
    rws2: { method: 'GET', path: '/rw/rapid/modules' },
    note: '2.0 only. The same path on 1.0 is the module list (listModules, ?task=); a different operation.',
  },
  getModuleModPossible: {
    tier: 'niche', evidence: 'live',
    summary: 'Read whether modification is possible in one module.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/mod-possible' },
    note: '2.0 only. A bare GET was refused 400 asking for endrow on RW 7.21.0 (2026-05-04): pass the range as query parameters.',
  },
  getModuleSymbolInfo: {
    tier: 'niche', evidence: 'live',
    summary: 'Read a module\'s symbol resource.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/symbol' },
    note: '2.0 only. listModuleSymbols reads the same symbols through symbols/search.',
  },
  getModuleAttributes: {
    tier: 'niche', evidence: 'live',
    summary: 'Read a module\'s possible attributes.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/attributes' },
    note: '2.0 only. Requires ?attribute= (Rev L: noview, nostepin, viewonly, readonly, systemmod; several as [a,b]). The 400 text names attrib, but attrib= is refused the same way and attribute= answers 200 (RW 7.21.4, 8.2.1, 2026-10-09).',
  },
  getModuleObject: {
    tier: 'niche', evidence: 'live',
    summary: 'Read a module\'s RAPID object resource.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/modules/{module}/object' },
    note: '2.0 only. A bare GET answered with the object at row 1 column 1 on RW 7.21.0 (2026-05-04).',
  },
  modifyPosition: {
    tier: 'niche', evidence: 'built',
    summary: 'Modify a position (ModPos) in a module.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/modules/{module}/modify-position', fields: ['startrow', 'startcol', 'endrow', 'endcol', 'checklimit', 'checkdeactaxes', 'allowdeact', 'text'] },
    note: 'built-not-run; needs RAPID mastership; endrow/col default to start. 2.0 only.',
  },

  // ── Symbols / variables ───────────────────────────────────────────────────
  getRapidVariable: {
    tier: 'core', evidence: 'live',
    summary: 'Read a RAPID symbol\'s value.',
    // SUFFIX vs PREFIX: 2.0 puts `/data` AFTER the symburl, 1.0 BEFORE it.
    rws2: { method: 'GET', path: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data' },
    rws1: { method: 'GET', path: '/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}' },
    note: 'suffix vs prefix: 2.0 `…/{symburl}/data`, 1.0 `…/data/{symburl}`.',
  },
  setRapidVariable: {
    tier: 'core', evidence: 'live',
    summary: 'Write a RAPID symbol\'s value.',
    rws2: { method: 'POST', path: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data', fields: ['value'] },
    rws1: { method: 'POST', path: '/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}', action: 'set', fields: ['value'] },
    note: '2.0 plain POST, 1.0 `?action=set`; same suffix/prefix inversion as getRapidVariable.',
  },
  getRapidSymbolProperties: {
    tier: 'common', evidence: 'live',
    summary: 'Read a RAPID symbol\'s properties.',
    rws2: { method: 'GET', path: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/properties' },
    rws1: { method: 'GET', path: '/rw/rapid/symbol/properties/RAPID/{task}/{module}/{symbol}' },
    note: 'same suffix/prefix inversion (2.0 `…/properties`, 1.0 `properties/…`).',
  },
  searchRapidSymbols: {
    tier: 'common', evidence: 'live',
    summary: 'Search RAPID symbols.',
    // Scoping is by `blockurl` on both: 2.0 refuses a `task` field (400); 1.0
    // accepts `task` but ignores it.
    rws2: { method: 'POST', path: '/rw/rapid/symbols/search', fields: ['view', 'symtyp', 'recursive', 'vartyp', 'dattyp', 'regexp', 'blockurl'] },
    rws1: { method: 'POST', path: '/rw/rapid/symbols', action: 'search-symbols', fields: ['task', 'view', 'vartyp', 'symtyp', 'dattyp', 'regexp', 'blockurl', 'recursive'] },
    note: '1.0 action is the plural `search-symbols` (the controller\'s own form id); the singular `search-symbol` is refused 400 -1073445879 for every body on RW 6.16.03 (live-verified 2026-09-29). 1.0 `task=` is accepted and ignored: a `blockurl=RAPID` search does not reach task symbols, so the client sends `blockurl=RAPID/{task}` by default. 2.0 refuses a `task` field (400). RW 6.16.03 pages a large result (86 or 95 entries, with a next link); the client reads the first page only.',
  },
  validateRapidValue: {
    tier: 'common', evidence: 'live',
    summary: 'Validate a value against a RAPID data type.',
    // RWS 2.0: ABB's RAPID service (RWS 2.0 reference, Rev L) documents
    // POST /rw/rapid/symbols/validate, a global resource like the 1.0 one. The
    // old 2.0 row (/rw/rapid/symbol/RAPID/{task}/data?action=validate, fields
    // value and dattyp) is in no ABB document and was never sent to a
    // controller. ABB's page names no body fields and no 2.0 OPTIONS form has
    // been read, so the 2.0 fields are the 1.0 form's (task, value, datatype).
    // The functional tests' traces log 204 for it on RW 7.21.4 and 8.2.1.
    rws2: { method: 'POST', path: '/rw/rapid/symbols/validate', fields: ['task', 'value', 'datatype'] },
    rws1: { method: 'POST', path: '/rw/rapid/symbol/data', action: 'validate', fields: ['task', 'value', 'datatype'] },
    note: '2.0 POST /rw/rapid/symbols/validate (ABB RAPID service, Rev L), 1.0 POST /rw/rapid/symbol/data?action=validate; both global, task in the body. 2.0 field names taken from the 1.0 form until the 2.0 OPTIONS form is read; the 2.0 request answered 204 in the functional traces.',
  },

  // ── UI instructions ───────────────────────────────────────────────────────
  getActiveUiInstruction: {
    tier: 'common', evidence: 'live',
    summary: 'Read the active UI instruction.',
    rws2: { method: 'GET', path: '/rw/rapid/uiinstr/active' },
    rws1: { method: 'GET', path: '/rw/rapid/uiinstr/active' },
    note: 'identical; `GET …/active/params` is 404 everywhere (no read side for params).',
  },
  setUiInstructionParam: {
    tier: 'common', evidence: { rws1: 'live', rws2: 'built' },
    summary: 'Answer a UI instruction parameter.',
    rws2: { method: 'POST', path: '/rw/rapid/uiinstr/active/param/{stackurl}/{uiparam}', fields: ['value'] },
    rws1: { method: 'POST', path: '/rw/rapid/uiinstr/active/param/{stackurl}/{uiparam}', action: 'set', fields: ['value'] },
    note: 'action-suffix only; both encodeURIComponent the stackurl.',
  },

  // ── Program pointer (pcp) & breakpoints ────────────────────────────────────
  getProgramPointer: {
    tier: 'common', evidence: 'live',
    summary: 'Read the program pointer for a task.',
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/pcp' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/pcp' },
    note: 'identical; both tolerate the controller\'s `modulemame` span typo, and read the start under `beginposition` or `begposition`.',
  },
  setProgramPointer: {
    tier: 'common', evidence: 'live',
    summary: 'Set the program pointer to a routine.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/routine', fields: ['routine', 'module', 'userlevel'] },
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp', action: 'set-pp-routine', fields: ['module', 'routine'] },
    note: '1.0 requires `module` (throws without) and both are mandatory; no row/col on either (2.0 form has none - use cursor). '
      + 'To a service routine in Auto on RobotWare 8 no run has shown it works; the client does not send it there (setPPToServiceRoutine).',
  },
  setPPToCursor: {
    tier: 'common', evidence: 'live',
    summary: 'Set the program pointer to a module cursor position.',
    // RWS 2.0: the controller form (RW 7.21.4 and 8.2.1, 2026-10-07/09) and
    // Rev L name the fields module, line, column. The client used to send
    // begin-position-row / begin-position-col, which the form does not list.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/cursor', fields: ['module', 'line', 'column'] },
    // RWS 1.0: ?action=set-pp-cursor with module, line, column and routine, as
    // ABB's RWS 1.0 manual (Rev M, "Set the Program pointer(PP) position to
    // cursor") writes it. The RW 6.16.03 form spells the action set-pp-curser,
    // which the controller refuses whatever the body ("Invalid argument");
    // set-pp-cursor without a routine answers "Routine name is missing.", and
    // with one it moved the program pointer (204, 2026-10-10).
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp', action: 'set-pp-cursor', fields: ['module', 'line', 'column', 'routine'] },
    note: '1.0 needs the routine (the adapter finds the one enclosing the row when the caller gives none); the 1.0 form misspells the action set-pp-curser.',
  },
  ppPrevInst: {
    tier: 'common', evidence: 'live',
    summary: 'Move the program pointer to the previous instruction (manual mode).',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/prev-inst' },
    // RWS 1.0: the empty `set-pp-prev-inst` form RW 6.16.03 serves on
    // `pcp?action=show` (read 2026-09-29).
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp', action: 'set-pp-prev-inst' },
    note: '2.0 /pcp/prev-inst subresource vs 1.0 ?action=set-pp-prev-inst (RW 6.16.03 form, no fields). Manual mode. Run live on 1.0 (RW 6.16.03, 2026-10-09).',
  },
  ppNextInst: {
    tier: 'common', evidence: 'live',
    summary: 'Move the program pointer to the next instruction (manual mode).',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/next-inst' },
    // RWS 1.0: the empty `set-pp-next-inst` form RW 6.16.03 serves on
    // `pcp?action=show` (read 2026-09-29).
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp', action: 'set-pp-next-inst' },
    note: '2.0 /pcp/next-inst subresource vs 1.0 ?action=set-pp-next-inst (RW 6.16.03 form, no fields). Manual mode. Run live on 1.0 (RW 6.16.03, 2026-10-09).',
  },
  setPPToRoutineFromUrl: {
    tier: 'niche', evidence: 'built',
    summary: 'Set the program pointer to a routine by URL.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/routine-from-url', fields: ['routineurl', 'userlevel'] },
    note: '2.0 only in this client. routineurl in the shape ABB documents, /RAPID/{task}/{module}/{routine}, passed as given; userlevel always sent, false unless asked. That exact form has not been sent yet; other forms got 400 on RW 7.21.4 and 8.2.1 (2026-10-11).',
  },
  resetTaskProgramPointer: {
    tier: 'common', evidence: 'live',
    summary: 'Reset the program pointer for one task.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/pcp/reset' },
    note: '2.0 only; per-task counterpart of the global execution/resetpp (resetRapid).',
  },
  listBreakpoints: {
    tier: 'common', evidence: 'live',
    summary: 'List breakpoints in a task.',
    // Both under /program; 2.0 plural, 1.0 singular. The old 1.0 row
    // `/rw/rapid/tasks/{task}/breakpoints` answers 404 -1073414146 on
    // RW 6.16.03, and so does the 2.0 spelling; `program/breakpoint` answers
    // 200, paged (self link `?limit=120`) (2026-09-29).
    rws2: { method: 'GET', path: '/rw/rapid/tasks/{task}/program/breakpoints' },
    rws1: { method: 'GET', path: '/rw/rapid/tasks/{task}/program/breakpoint' },
    note: '2.0 `program/breakpoints` (plural), 1.0 `program/breakpoint` (singular, paged limit=120, RW 6.16.03 2026-09-29). 2.0 entries are read as ABB documents them, class rap-program-breakpoint with module-name, start-row and start-col (Rev L); the earlier guessed class is still read after. Only empty lists have been captured live.',
  },
  setBreakpoint: {
    tier: 'common', evidence: 'live',
    summary: 'Set a breakpoint.',
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/breakpoints', fields: ['module', 'row', 'column'] },
    // RWS 1.0: ?action=set on the singular resource. The RW 6.16.03 form's only
    // input carries no name attributes (2026-09-29), so the field names are the
    // ones ABB's RWS 1.0 manual documents.
    rws1: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/breakpoint', action: 'set', fields: ['module', 'row', 'column'] },
    note: 'field names are `row`/`column` (begin-position-* rejected on 2.0). 1.0 is program/breakpoint?action=set; its RW 6.16.03 form has no field names, so ABB\'s documented names are used. Run live on 1.0 (RW 6.16.03, 2026-10-09). 2.0: the POST answered 2xx on RW 7.21.4 and 8.2.1 (2026-10-11) but the breakpoint list answered empty after it on both; whether the set took effect is not known.',
  },
  removeBreakpoint: {
    tier: 'common', evidence: 'built',
    summary: 'Remove a breakpoint.',
    // RWS 2.0: POST the `remove` sub-resource. RW 7.21.4 and RW 8.2.1 both
    // answer OPTIONS on it with `Allow: POST,OPTIONS` and the form
    // `clear-breakpoint` naming module, row and `columno` (read 2026-09-29),
    // but the controller refuses `columno` (400 "Column parameter invalid or
    // missing", 2026-10-11) and ABB documents `column`, so `column` is sent.
    // The old DELETE on program/breakpoints answered 405. RW 6.16.03
    // advertises no remove form, so there is no 1.0 spec.
    rws2: { method: 'POST', path: '/rw/rapid/tasks/{task}/program/breakpoints/remove', fields: ['module', 'row', 'column'] },
    note: '2.0 POST program/breakpoints/remove: fields module, row, column as ABB documents them (RWS 2.0 Rev L "Clear Break Points"; `all=true` clears every breakpoint). The controller\'s own OPTIONS form on RW 7.21.4 and 8.2.1 spells the third field `columno`, and that spelling is refused with 400 -1073445879 "Column parameter invalid or missing" (recorded 2026-10-11): the documented name is sent. DELETE answers 405. No 1.0 form on RW 6.16.03.',
  },
};
