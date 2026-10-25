#!/usr/bin/env node
/**
 * `npm run readme:gen` / `npm run readme:check` - the README's operation
 * tables and its "Known limits" section, generated from the path tables.
 *
 *   node scripts/gen-readme-tables.mjs          # rewrite the generated block in README.md
 *   node scripts/gen-readme-tables.mjs --check  # exit 1 when README.md differs from the tables
 *
 * The block sits between the BEGIN and END marker comments in README.md and is
 * never edited by hand: change a row's `tier` or `evidence` in src/paths, then
 * regenerate. Reads the tables from dist/ (the npm scripts build first).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = join(root, 'README.md');
const BEGIN = '<!-- BEGIN GENERATED: operations (npm run readme:gen; do not edit by hand) -->';
const END = '<!-- END GENERATED: operations -->';

const { ALL_TABLES, evidenceOf } = await import(new URL('../dist/paths/index.js', import.meta.url).href);

const DOMAIN_TITLES = {
  panel: 'Panel',
  rapid: 'RAPID',
  motion: 'Motion system',
  io: 'I/O',
  cfgElogDipc: 'Configuration, event log and DIPC',
  ctrl: 'Controller',
  systemMastership: 'System, mastership and control station',
  usersUas: 'Users and UAS',
  filesVision: 'Files, subscriptions and vision',
};
const TIERS = ['core', 'common', 'niche'];
const GENS = [['rws1', 'RWS 1.0'], ['rws2', 'RWS 2.0']];

/** A table cell must not break the row. */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function side(op, gen) {
  const spec = op[gen];
  if (spec === undefined) { return '-'; }
  if (spec.gap !== undefined) { return 'unsupported'; }
  return evidenceOf(op, gen);
}

/**
 * The second limit line, from the tables: the operations that are built on one
 * generation and live on the other, so a reader does not take "built" for
 * "never run anywhere".
 */
function crossGeneration(rows) {
  const names = (built, live) => rows
    .filter((r) => side(r.op, built) === 'built' && side(r.op, live) === 'live')
    .map((r) => `\`${r.name}\``).sort((a, b) => a.localeCompare(b));
  const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const live2 = names('rws1', 'rws2');
  const live1 = names('rws2', 'rws1');
  const parts = [];
  if (live2.length > 0) { parts.push(`${list(live2)} are live on RWS 2.0 and built on RWS 1.0`); }
  if (live1.length > 0) { parts.push(`${list(live1)} are live on RWS 1.0 and built on RWS 2.0`); }
  return 'Each operation in the lists below has no logged 2xx on the generation it is listed under.'
    + (parts.length > 0 ? ` Some have one on the other generation: ${parts.join('; ')}.` : '')
    + ' A logged run moves an operation to `live` in a later release.';
}

/**
 * Limits that are not a single built-only row, which the path tables cannot say. Plain
 * sentences: what does not work or is unverified, on which generation, and what to do.
 */
function openLimits(rows) {
  return [
    "Every logged success comes from RobotStudio virtual controllers; a real controller may refuse what a virtual one accepted (the operating-mode switch, for one, which ABB ties to Local Client privileges), so try a write on a virtual controller first and take the controller's refusal as final.",
    crossGeneration(rows),
    "`getMotionPointer` stays in both lists although its request answers 2xx: it sends the same `GET /rw/rapid/tasks/{task}/pcp` as `getProgramPointer`, and that answer carries the motionpointer entry with no position when no program has started. The logs keep no answer body, so a logged 2xx does not show that a motion pointer with a position was read, and the evidence index does not credit it. On RobotWare 6.16.03 and 7.21.4 virtual controllers it read row 9 col 16 while a MoveAbsJ ran. On RobotWare 8 no program ran for it: the start was refused without the motion-control declaration.",
    "RobotWare 6 (RWS 1.0): ABB's RWS 1.0 has no breakpoint removal (`removeBreakpoint`), no per-task program-pointer reset (`resetTaskProgramPointer`; `resetRapid` resets every task), no write for the whole task selection (`setTaskSelection`; change one task at a time with `activateRapidTask` / `deactivateRapidTask`) and no service-routine call (`callServiceRoutine`; use `setPPToServiceRoutine`, then start). ABB does document Modify Position on RWS 1.0, but the client has no RWS 1.0 form for `modifyPosition` yet; modify positions at the FlexPendant. The operating-mode acknowledge is left out on purpose. The client refuses all of these before sending. The RWS 1.0 forms for `setSignalSimulated`, `unblockSignals` and `setIoDeviceLState` are built from ABB's RWS 1.0 pages and not yet run: the RobotWare 6.16.03 virtual controller at hand has only drive and safety-panel I/O, nothing safe to change. The RWS 1.0 forms for `setKeylessMotorOn` and `setMechunitBaseFrame` ran on that virtual controller: the motors went from off to on, and the unit's own frame was written back unchanged.",
    "RobotWare 6: `registerUser` and `impersonateUser` are built for RWS 2.0 only, although ABB's RWS 1.0 documents both (`POST /users`, `POST /users?action=impersonate`); `changePassword` is RWS 2.0 only because RWS 1.0 has no password operation. On RobotWare 6 the three are refused with `UNSUPPORTED_OPERATION` before sending; manage users from RobotStudio or the FlexPendant. `restoreBackup` is live on RobotWare 6 and keeps the backup unless `deleteBackup` is asked for.",
    "RobotWare 6: the client sends no virtual-time write in this release. `setVirtualTimeScale` is refused before sending, although ABB's RWS 1.0 documents the speed write for virtual controllers. The virtual-time reads work on both generations. Change the simulation speed in RobotStudio.",
    "Remote jog: ABB's jog pages for RobotWare 6 and 7 ask for a local client with mastership, and this client connects as a remote one. RobotWare 6 refused the jog in Auto, the only mode tried. RobotWare 7.21.4 refused it in manual reduced speed with the motors on; Auto was tried only with the motors off. On a RobotWare 8.2.1 virtual controller, jogs in manual reduced speed were accepted with the motion-control declaration made, and refused in Auto. Elsewhere, jog from the FlexPendant.",
    "RobotWare 7: a 7.21.4 virtual controller in manual reduced speed refused `requestRmmp('exec')` with 403 -1073445800 (enabling device released), both with its enable switch on and with Enable held at the virtual FlexPendant (manual reduced speed and motors on read back). `exec` asked for while this session holds `modify` resolves `held-lower` and sends nothing. A granted `modify` was still held after 180 s, until `cancelRmmp()`; a longer hold was not measured, and ABB states no lifetime. Request `modify`, or do the `exec` steps at the FlexPendant. RobotWare 6: `exec` has not been sent.",
    "RobotWare 8: a RAPID start from this client needs motion control allowed for its control station (`setAllowMotionControl(true)`, after a person's confirmation). A RobotWare 8.2.1 virtual controller refused `startRapid` without it (403 -1073435864), also for a program that does not move the robot, and ran the program with it. The client explains that refusal as `GRANT_DENIED`, `refusal.kind` `motion-control-off`, on every call that starts RAPID, and never allows motion control on its own. The refusal carries `remedy.kind` `declare-motion-control`. `disconnect()` withdraws an allowance. Another station, which registers with its own id, read it as not allowed.",
    "RobotWare 8: a motion-control allowance belongs to the control station, not the session (8.2.1 virtual controller): a second session with the same station id reads it, and a process killed after allowing left it standing for that station for more than 7 minutes, so with a fixed station id a process that starts after a crash finds it allowed, and the client withdraws it at that process's first registration. Not measured: how long it lasts after a crash, whether a mode change, the FlexPendant taking write access, Remote Access off or a restart ends it, or what a withdrawal does to a running program. The client withdraws an allowance it may have left at the next registration of the same station and after a re-issued session; the withdrawals on a mode change and a FlexPendant take-back are built and off in this release.",
    "RobotWare 8: a virtual controller in guard stop refused both `setKeylessMotorOn` and the remote motors-on (403 -1073445806); switch the motors on at the FlexPendant. `startProductionEntry` and `stepRapid` have not run on RobotWare 8; they are live on RobotWare 7. `setUiInstructionParam` has no logged 2xx on RWS 2.0: RobotWare 7 refused the parameter names tried, and `TPAnswer` was not among them; it is live on RobotWare 6.",
    "RobotWare 8: `disableExternalControl` and `registerControlStationLocal` are accepted only from a local control station (the FlexPendant), so a remote client gets a refusal, explained as `refusal.kind` `local-only`; Remote Access is the pendant's to switch.",
    "RobotWare 8: `uploadCertificate`, `clearCertificateStore`, `impersonateUser` and `changePassword` have not been sent, so the write access each needs is unrecorded; the client sends them without a hold and the controller decides. `registerUser`, sent without a hold, answered 201 on an 8.2.1 virtual controller (2026-10-21). `restoreBackup` has not been sent on RWS 2.0; the client holds write access around it, as ABB's RobotWare 8 page asks.",
    "RobotWare 8: an 8.2.1 virtual controller left speed ratio out of `RobotManager`'s subscription group on some days while the create answered 201, so speed-ratio events did not arrive; the same request bound it on other days, and the cause is not known. The client now creates the group once more with that resource in its other spelling and, if it is still left out, polls everything at the full rate. In a test run on 2026-10-22 that virtual controller left speed ratio out of every group that asked for `/rw/panel/speedratio;speedratio` (24), and each group created with `/rw/panel/speedratio` bound it; the full-rate polling, for a resource left out in both spellings, has not run against a controller.",
    "RobotWare 8: ABB documents no RWS way to send the write-access watchdog command, so a RAPID start under the client's write access while HeartBeat is enforced is warned about, not blocked; start from the FlexPendant if the controller stops execution.",
    "Both generations: `setTaskSelection` is refused before sending (`UNSUPPORTED_OPERATION`): ABB has no write for the whole task selection (`/rw/rapid/taskselection` is a read on RWS 1.0 and 2.0); change one task at a time with `activateRapidTask` / `deactivateRapidTask`. `setControllerClock` got 405 from the virtual controllers (RobotWare 6.16.03, 7.21.4 and 8.2.1); ABB lists the clock write for real controllers only, which has not been tried. `getCompatibility` sends ABB's `/ctrl/compatibility/{robotware version}`, which ABB lists for real controllers only; the virtual controllers answer 404, so it has not run.",
    "RWS 2.0: a switch to Auto is confirmed by the person at the FlexPendant, and `setOperationMode` does not send that confirmation. `RwsClient2.acknowledgeOperationMode` posts ABB's documented `/rw/panel/opmode/acknowledge` and is `@experimental`. The client reads no controller state before a switch: a RobotWare 8.2.1 virtual controller in guard stop accepted it in both directions (Auto to manual reduced speed and back).",
    "RWS 2.0: `setPPToRoutineFromUrl` takes the routine URL in ABB's documented shape (`/RAPID/{task}/{module}/{routine}`) and always sends `userlevel` (false unless asked). That exact form has not been sent to a controller yet; the other forms tried on RobotWare 7 and 8 were refused (400). Use `setPPToRoutine`.",
    "RobotWare 7 (seen once, on 7.21.4): a module named like one of its own global symbols, ignoring case, breaks ABB's unique-name rule. The controller loaded it with errors under a renamed name (`<NAME>#2`), and `unloadModule` by the original name was refused (403 -1073414145, its reason written in the event log). `loadProgram` reports the name the controller gave the module, and that refusal of `unloadModule` carries the newest event-log message, which may be about something else. Unload the module by the name `listModules` reports, and name modules so they do not clash. Not tried on RobotWare 6 or 8.",
  ];
}

export function generate(tables) {
  const rows = [];
  for (const [domain, table] of Object.entries(tables)) {
    for (const [name, op] of Object.entries(table)) { rows.push({ domain, name, op }); }
  }
  const out = [];
  out.push(BEGIN);
  out.push('');
  out.push('## Operations by tier');
  out.push('');
  out.push('Every RWS operation the client knows is one row of its path tables (`src/paths`).');
  out.push('Each row has a **tier** - `core` (what every robot application needs), `common`');
  out.push('(what a cell tool reaches for regularly) or `niche` (options, commissioning,');
  out.push('diagnostics, virtual-controller simulation) - and, per generation, its **evidence**:');
  out.push('`live` when a probe log or a functional-test trace holds that request with a 2xx');
  out.push('answer (nothing else counts; `tests/fixtures/evidence-index.json` lists one logged');
  out.push('success per live side), `built` when there is no logged success. `unsupported` is');
  out.push('an operation that generation does not have, or that its controller refuses; the');
  out.push('client refuses it before sending, and the row records why.');
  out.push('');
  out.push('`IRWSAdapterCore` declares the core and common operations that have run on every');
  out.push('generation they have; `IRWSAdapter` declares every operation, with the never-run');
  out.push('ones marked `@experimental`.');
  out.push('');

  // Counts per tier and evidence.
  const count = {};
  for (const { op } of rows) {
    const ev = typeof op.evidence === 'string' ? op.evidence : 'mixed';
    count[op.tier] ??= { live: 0, built: 0, mixed: 0, total: 0 };
    count[op.tier][ev] += 1;
    count[op.tier].total += 1;
  }
  out.push('| Tier | Rows | Live on every generation it has | Built, never run | Live on one generation only |');
  out.push('|------|-----:|-----:|-----:|-----:|');
  let total = 0;
  for (const t of TIERS) {
    const c = count[t] ?? { live: 0, built: 0, mixed: 0, total: 0 };
    total += c.total;
    out.push(`| ${t} | ${c.total} | ${c.live} | ${c.built} | ${c.mixed} |`);
  }
  out.push(`| **all** | **${total}** | | | |`);
  out.push('');

  for (const [domain, title] of Object.entries(DOMAIN_TITLES)) {
    const mine = rows.filter((r) => r.domain === domain);
    if (mine.length === 0) { continue; }
    mine.sort((a, b) => TIERS.indexOf(a.op.tier) - TIERS.indexOf(b.op.tier) || a.name.localeCompare(b.name));
    out.push(`<details><summary>${title} (${mine.length})</summary>`);
    out.push('');
    out.push('| Operation | Tier | RWS 1.0 | RWS 2.0 | What it does |');
    out.push('|-----------|------|---------|---------|--------------|');
    for (const { name, op } of mine) {
      out.push(`| \`${name}\` | ${op.tier} | ${side(op, 'rws1')} | ${side(op, 'rws2')} | ${cell(op.summary)} |`);
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }

  // Known limits.
  // A write to the user service or UAS. An RMMP request and a session registration
  // (free-text labels for this session) change no UAS data.
  const isUasWrite = (r, gen) => r.domain === 'usersUas' && r.op[gen] !== undefined
    && r.op[gen].method !== 'GET' && !r.op[gen].path.startsWith('/users/rmmp')
    && r.op[gen].path !== '/users/register';
  out.push('## Known limits');
  out.push('');
  out.push('These operations have no logged success on the generation named: no probe log and');
  out.push('no functional-test trace holds the request with a 2xx answer. They are built from');
  out.push('the controller\'s own form or ABB\'s documentation, in the client so the surface is');
  out.push('complete, and marked `@experimental`; try one on a virtual controller before relying');
  out.push('on it. An unlogged record of a past run does not count.');
  out.push('');
  out.push('### Open at this release');
  out.push('');
  for (const line of openLimits(rows)) out.push(`- ${line}`);
  out.push('');
  for (const [gen, label] of GENS) {
    const built = rows.filter((r) => side(r.op, gen) === 'built' && !isUasWrite(r, gen));
    out.push(`### ${label} (${built.length})`);
    out.push('');
    for (const { name, op } of built.sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`- \`${name}\` (${op.tier}) - ${cell(op.summary)}`);
    }
    out.push('');
  }
  const uas = rows.filter((r) => GENS.some(([g]) => isUasWrite(r, g) && side(r.op, g) === 'built'));
  out.push(`### UAS writes never sent (${uas.length})`);
  out.push('');
  out.push('Built from the controller\'s forms; a UAS change on a controller is not made from a');
  out.push('test, so none of these has been sent.');
  out.push('');
  for (const { name, op } of uas.sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`- \`${name}\` - ${cell(op.summary)}`);
  }
  out.push('');
  const gaps = rows.filter((r) => GENS.some(([g]) => side(r.op, g) === 'unsupported'));
  out.push(`### Unsupported (${gaps.length})`);
  out.push('');
  out.push('The generation named has no such operation, or its controller refuses it; the');
  out.push('client refuses before sending and records the reason.');
  out.push('');
  for (const { name, op } of gaps.sort((a, b) => a.name.localeCompare(b.name))) {
    const why = GENS.filter(([g]) => side(op, g) === 'unsupported').map(([g, label]) => `${label}: ${cell(op[g].gap)}`);
    out.push(`- \`${name}\` - ${why.join('; ')}`);
  }
  out.push('');
  out.push(END);
  return out.join('\n');
}

const readme = readFileSync(readmePath, 'utf8');
const eol = readme.includes('\r\n') ? '\r\n' : '\n';
const text = readme.replace(/\r\n/g, '\n');
const b = text.indexOf(BEGIN);
const e = text.indexOf(END);
if (b < 0 || e < b) {
  console.error(`README.md has no generated block (${BEGIN} ... ${END})`);
  process.exit(1);
}
const next = text.slice(0, b) + generate(ALL_TABLES) + text.slice(e + END.length);
if (process.argv.includes('--check')) {
  if (next !== text) {
    console.error('README.md operation tables are out of date with src/paths: run `npm run readme:gen`.');
    process.exit(1);
  }
  console.log('README.md operation tables match src/paths.');
} else {
  writeFileSync(readmePath, next.replace(/\n/g, eol));
  console.log('README.md operation tables regenerated.');
}
