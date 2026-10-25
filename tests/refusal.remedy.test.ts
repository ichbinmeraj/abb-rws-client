import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyControllerError } from '../src/ControllerError.js';
import {
  asLostRefusal, builtRefusal, confirmationFor, defaultRemedies, explainRefusal, refusalFor, remedy, withReport,
  REFUSAL_CODES, SYS_CTRL_E_FAIL, type ControllerAnswer,
} from '../src/refusal.js';
import { rmmpUnsupportedOnRw8, waitForRmmp, type RmmpPort } from '../src/access/rmmp.js';
import { virtualTimeRunningUnsupported } from '../src/paths/ctrl.js';
import { AccessManager } from '../src/access/AccessManager.js';
import { RobotManager } from '../src/RobotManager.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RWS2Adapter } from '../src/RWS2Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import type { IRWSAdapter } from '../src/IRWSAdapter.js';
import {
  RwsError, type RefusalContext, type RefusalHolder, type RefusalKind, type RefusalRemedy, type RwsRefusal,
} from '../src/types.js';

/**
 * Every refusal carries a next step (`refusal.remedy`, `refusal.otherRemedies`):
 * what to do, who does it, and for a step a tool can take after a person
 * confirms, the call. The client builds remedies and never runs one. These
 * tests hold the mapping of every refusal kind, the rules every remedy
 * follows, the confirmation text, and that nothing in the client sets motion
 * control to true.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The 26 remedy kinds, read from the RemedyKind union in src/types.ts. */
function remedyKindsInTypes(): string[] {
  const src = fs.readFileSync(path.join(root, 'src/types.ts'), 'utf8');
  const block = /export type RemedyKind =([\s\S]*?);/.exec(src)![1];
  return [...block.matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
}
const REMEDY_KINDS = new Set(remedyKindsInTypes());
const ACTORS = new Set(['person-confirms-in-a-tool', 'person-at-this-tool', 'person-at-pendant', 'other-station', 'administrator', 'integrator', 'none']);
const SCOPES = new Set(['session', 'station', 'controller', 'user', 'configuration', 'operation']);
const EVIDENCE = new Set(['abb', 'vc', 'field', 'unverified']);

// ─── A copy of the daemon's refusal filter (abb-rws-daemon src/errorMap.ts) ──
// The daemon passes a refusal on as bounded JSON: depth 4, 32 items, 1000
// characters a string, one line, secrets and transport keys dropped. A remedy
// must pass whole.

const SECRET_KEY = /(^|[-_])(pin|pincode|passcode|password|passwd|pwd|secret|token|credentials?|api-?key|cookie|authorization)([-_]|$)/i;
const SESSION_COOKIE = /^(-?http-session-?|abbcx)$/i;
const STATION_ID_KEY = /station[-_]?id$/i;
function isSecretKey(key: string): boolean {
  const parts = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  return SECRET_KEY.test(parts) || SESSION_COOKIE.test(key) || STATION_ID_KEY.test(parts);
}
const looksEncoded = (t: string): boolean => /[0-9+/=]/.test(t) || (/[A-Z]/.test(t.slice(1)) && /[a-z]/.test(t));
function redactSecrets(text: string): string {
  return text
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2***')
    .replace(/\b(Basic|Bearer)(\s+)([A-Za-z0-9+/._~-]{8,}=*)/g,
      (whole, scheme: string, gap: string, token: string) => (looksEncoded(token) ? `${scheme}${gap}***` : whole))
    .replace(/\bDigest\s+[^\r\n]*\b(?:username|response)\s*=[^\r\n]*/gi, 'Digest ***')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, '$1***@')
    .replace(/"([^"\s]{1,64})"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]*)/g,
      (whole, key: string, sep: string) => (isSecretKey(key) ? `"${key}"${sep}"***"` : whole))
    .replace(/([A-Za-z0-9_.-]{1,64})=("[^"]*"|'[^']*'|\{[^}\s]*\}|[^\s&;,"'})\]]*)/g,
      (whole, key: string) => (isSecretKey(key) ? `${key}=***` : whole));
}
function servedText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const one = redactSecrets(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}
const TRANSPORT_KEY = /^(raw-?headers|headers|req|request|res|response|socket|agent)$/i;
function refusalValue(v: unknown, depth: number, parent: string | null): unknown {
  if (v === null) { return null; }
  switch (typeof v) {
    case 'string': return servedText(v, 1000);
    case 'number': return Number.isFinite(v) ? v : undefined;
    case 'boolean': return v;
    case 'object': {
      if (depth >= 4) { return undefined; }
      if (Array.isArray(v)) {
        return v.slice(0, 32).map(x => refusalValue(x, depth + 1, parent)).filter(x => x !== undefined);
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v).slice(0, 32)) {
        if (isSecretKey(k) || TRANSPORT_KEY.test(k)) { continue; }
        if (parent === 'holder' && k === 'id') { continue; }
        const c = refusalValue(x, depth + 1, k);
        if (c !== undefined) { out[k] = c; }
      }
      return out;
    }
    default: return undefined;
  }
}

// ─── The checks every refusal's remedies pass ───────────────────────────────

const allRemedies = (r: RwsRefusal): RefusalRemedy[] => [r.remedy!, ...(r.otherRemedies ?? [])];

/**
 * A holder name that must never appear in a remedy's words. The FlexPendant's
 * station name is also a word of the client's own, so for it only the quoted
 * name the controller supplies is checked.
 */
const HOLDER_NAMES = ['Zebra Line 9 PLC', "'FlexPendant'"];

interface Seen { ctx: RefusalContext; answer?: ControllerAnswer }

/** The rules every refusal's remedies follow; returns what broke, empty when nothing did. */
function remedyViolations(r: RwsRefusal, seen: Seen): string[] {
  const bad: string[] = [];
  const must = (ok: boolean, what: string): void => { if (!ok) { bad.push(what); } };
  if (!r.remedy) { return ['no remedy']; }
  const list = allRemedies(r);
  for (const x of list) {
    const k = x.kind;
    must(REMEDY_KINDS.has(k), `kind ${k} is not a RemedyKind`);
    must(ACTORS.has(x.byWhom), `${k}: actor ${x.byWhom}`);
    must(SCOPES.has(x.appliesTo.scope), `${k}: scope ${x.appliesTo.scope}`);
    must(EVIDENCE.has(x.evidence), `${k}: evidence ${x.evidence}`);
    must(x.afterwards === 'run-again' || x.afterwards === 'nothing', `${k}: afterwards`);
    must(x.label.length > 0 && x.detail.length > 0 && x.basis.length > 0, `${k}: empty text`);
    // call if and only if a person confirms in a tool
    must((x.call !== undefined) === (x.byWhom === 'person-confirms-in-a-tool'), `${k}: call vs byWhom ${x.byWhom}`);
    // safetyDeclaration if and only if declare-motion-control, and only `true`
    must((x.safetyDeclaration === true) === (k === 'declare-motion-control'), `${k}: safetyDeclaration`);
    must(x.safetyDeclaration === undefined || x.safetyDeclaration === true, `${k}: safetyDeclaration value`);
    must(x.appliesTo.generation === r.generation, `${k}: generation ${x.appliesTo.generation} vs ${r.generation}`);
    if (r.controller.request) { must(x.appliesTo.operation === r.controller.request, `${k}: operation`); }
    // The client's own words: no holder name the controller supplied.
    if (seen.ctx.holder?.name) {
      for (const name of HOLDER_NAMES) { must(!x.label.includes(name) && !x.detail.includes(name), `${k}: names the holder ${name}`); }
    }
    // One line, under 1000 characters, unchanged by the daemon's text rules.
    for (const s of [x.label, x.detail, x.basis, x.appliesTo.operation ?? '']) {
      must(s.length < 1000 && !/[\r\n]/.test(s) && servedText(s, 1000) === s, `${k}: text the daemon would change: ${s}`);
    }
    // declare-motion-control: RobotWare 8, motion-control-off, setAllowMotionControl(true) only.
    if (k === 'declare-motion-control') {
      must(r.generation === 'rw8', 'declare-motion-control off RobotWare 8');
      must(r.kind === 'motion-control-off', `declare-motion-control on ${r.kind}`);
      must(x.call?.method === 'setAllowMotionControl' && 'allow' in x.call && x.call.allow === true, 'declare-motion-control call');
      must(x.appliesTo.scope === 'station', 'declare-motion-control scope');
    }
    if (x.call?.method === 'setAllowMotionControl') { must(k === 'declare-motion-control', `setAllowMotionControl on ${k}`); }
    // request-rmmp: RobotWare 6/7, manual mode, an operation RMMP covers.
    if (k === 'request-rmmp') {
      must(r.generation !== 'rw8', 'request-rmmp on RobotWare 8');
      must(!/^AUTO$/i.test(String(seen.ctx.opmode ?? '')), 'request-rmmp in AUTO');
      const p = seen.answer?.path ?? '';
      must(!/\/execution\/(start|startprodentry|resetpp)|action=(start|resetpp)|\/iosystem\/signals\/|\/jog|ctrl-?state/i.test(p),
        `request-rmmp for ${p}`);
      const exec = x.call && 'level' in x.call && x.call.level === 'exec';
      if (/\/pcp/.test(p)) {
        must(/\/pcp\/routine(-from-url)?(\?|$)/.test(p) && r.generation === 'rw7' && exec === true, `request-rmmp for the pointer move ${p}`);
      }
      if (exec) { must(r.generation === 'rw7', 'request-rmmp exec off RobotWare 7'); }
      must(r.kind !== 'option-missing', 'request-rmmp for a missing option');
    }
    // A jog is done in manual mode at the FlexPendant: never "switch to Auto".
    if (/\/jog|action=jog/i.test(seen.answer?.path ?? '')) {
      must(!(k === 'mode' && x.label === 'Switch to Auto'), 'a jog told to switch to Auto');
    }
  }
  if (/\/jog|action=jog/i.test(seen.answer?.path ?? '')) {
    must(!/from this tool in Auto|to a remote tool in Auto/.test(`${r.sentence} ${r.fix}`), 'a jog sentence that offers Auto');
  }
  // A refusal with a call remedy also has one without a call.
  if (list.some(x => x.call)) { must(list.some(x => !x.call), 'no remedy without a call'); }
  // The primary declaration only for the controller's own -1073435864.
  if (r.remedy.kind === 'declare-motion-control') {
    const inner = r.controller.code === SYS_CTRL_E_FAIL ? -1073435864 : r.controller.code;
    must(inner === -1073435864, 'declare-motion-control primary without the controller answer -1073435864');
  }
  // Every remedy field passes the daemon's filter whole.
  const plain = JSON.parse(JSON.stringify({ remedy: r.remedy, otherRemedies: r.otherRemedies ?? [] }));
  must(JSON.stringify(refusalValue(plain, 0, null)) === JSON.stringify(plain), 'the daemon filter drops or changes a remedy field');
  return bad;
}

function checkRemedies(r: RwsRefusal, seen: Seen, where: string): void {
  expect(remedyViolations(r, seen), where).toEqual([]);
}

// ─── 1. A matrix through refusalFor, and every recorded fixture ─────────────

const OPS: Array<[string, string, ('on' | 'off')?]> = [
  ['POST', '/rw/rapid/execution/start'],
  ['POST', '/rw/rapid/execution?action=start'],
  ['POST', '/rw/rapid/execution/startprodentry'],
  ['POST', '/rw/rapid/execution/resetpp'],
  ['POST', '/rw/rapid/execution/holdtorun'],
  ['POST', '/rw/rapid/tasks/T_ROB1/pcp/routine'],
  ['POST', '/rw/rapid/tasks/T_ROB1/pcp/routine-from-url'],
  ['POST', '/rw/rapid/tasks/T_ROB1/pcp/cursor'],
  ['POST', '/rw/rapid/tasks/T_ROB1/pcp?action=set-pp-routine'],
  ['POST', '/rw/mastership/edit/request'],
  ['POST', '/rw/mastership/rapid?action=request'],
  ['POST', '/rw/controlstation/writeaccess/request'],
  ['POST', '/rw/controlstation/register/remote'],
  ['POST', '/rw/controlstation/allowmotioncontrol'],
  ['POST', '/rw/panel/speedratio'],
  ['POST', '/rw/panel/ctrl-state', 'on'],
  ['POST', '/rw/panel/ctrl-state', 'off'],
  ['POST', '/rw/panel/opmode/unlock'],
  ['POST', '/rw/iosystem/signals/Local/DRV_1/DO1/set-value'],
  ['POST', '/rw/motionsystem/ROB_1/jog'],
  ['POST', '/users/rmmp'],
  ['GET', '/users/rmmp/poll'],
  ['POST', '/rw/rapid/symbol/RAPID/T_ROB1/M/x/data'],
  ['POST', '/rw/rapid/tasks/T_ROB1/loadmod'],
];

const CODES: Array<number | null> = [...REFUSAL_CODES.keys(), -1073414145, -1073400000, null];
const GENS: Array<'rw6' | 'rw7' | 'rw8' | undefined> = ['rw6', 'rw7', 'rw8', undefined];
const MODES = ['AUTO', 'MANR', 'MANF', 'AUTO_CH', undefined];
const STATES = ['motoron', 'motoroff', 'guardstop', 'emergencystop', undefined];
const HOLDERS: Array<RefusalHolder | undefined> = [
  undefined, { kind: 'local' }, { kind: 'remote', application: 'RobotStudio', id: '17' }, { kind: 'internal' }, { kind: 'self' },
  { kind: 'unknown', name: 'FlexPendant' }, { kind: 'unknown', name: 'Zebra Line 9 PLC' }, { kind: 'remote', application: 'TPU' },
];
const RMMP: Array<RefusalContext['rmmp']> = [undefined, 'none', 'pending', 'granted'];

describe('1. every refusal refusalFor builds carries a valid remedy', () => {
  it('the RemedyKind union has the 26 kinds of the design, and the constructors make each of them', () => {
    expect(REMEDY_KINDS.size).toBe(26);
    const made = new Set<string>();
    const all: RefusalRemedy[] = [
      remedy.declareMotionControl(), remedy.requestRmmp('rw7', 'modify'), remedy.requestRmmp('rw7', 'exec'), remedy.grantRmmpAtPendant('rw6'),
      remedy.remoteAccessOn(), remedy.releasePendantWriteAccess(), remedy.releasePendantMastership('rw6'), remedy.holderReleases('rw8'),
      remedy.holderReleases('rw7'), remedy.releaseOwnHold('rw7'), remedy.stopProgramFirst('rw7'), remedy.motorsOnCall('rw7'),
      remedy.motorsOnAtPendant('rw8', 'reset'), remedy.motorsOnAtPendant('rw7', 'enabling-device'), remedy.motorsOnAtPendant(null, 'either'),
      remedy.resetSafetyStop('rw8'), remedy.mode('rw7', 'MANR'), remedy.mode('rw7', 'AUTO'), remedy.mode(null, null), remedy.confirmModeChange('rw8'),
      remedy.doAtPendant('rw6'), remedy.grantMissing('rw7'), remedy.signalAccessLevel('rw7'), remedy.runAgain('rw8'), remedy.reconnect('rw7'),
      remedy.fixInput('rw6'), remedy.checkState('rw7'), remedy.wait('rw6'), remedy.nothingNeeded('rw8'), remedy.optionMissing('rw7'),
      remedy.notAvailable('rw8'), remedy.report('rw7'), remedy.noneKnown(null),
    ];
    for (const r of all) { made.add(r.kind); }
    expect(made).toEqual(REMEDY_KINDS);
  });

  it('a matrix of code x operation x generation x mode, with the controller state, holder and RMMP rotated', () => {
    let n = 0;
    let checked = 0;
    const problems: string[] = [];
    for (const code of CODES) {
      for (const [method, p, motors] of OPS) {
        for (const generation of GENS) {
          for (const opmode of MODES) {
            n++;
            const ctx: RefusalContext = {
              ...(generation ? { generation } : {}), ...(opmode ? { opmode } : {}),
              ...(STATES[n % STATES.length] ? { ctrlstate: STATES[n % STATES.length] } : {}),
              ...(HOLDERS[n % HOLDERS.length] ? { holder: HOLDERS[n % HOLDERS.length] } : {}),
              ...(RMMP[n % RMMP.length] ? { rmmp: RMMP[n % RMMP.length] } : {}),
              robot: 'IRB_1300', user: 'Operator',
            };
            for (const http of [403, 400, 500]) {
              const answer: ControllerAnswer = {
                http, code, msg: code === null ? null : `Refused code:${code} icode:-1`, method, path: p, ...(motors ? { motors } : {}),
              };
              const out = refusalFor(answer, ctx);
              if (!out) { continue; }
              checked++;
              for (const v of remedyViolations(out.refusal, { ctx, answer })) {
                problems.push(`${http} ${code} ${method} ${p} ${JSON.stringify(ctx)}: ${v}`);
              }
            }
          }
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(10_000);
  });

  it('the codes that depend on the holder, the RMMP state, the controller state or the mode, crossed in full', () => {
    let checked = 0;
    const problems: string[] = [];
    const run = (code: number, ctx: RefusalContext, method: string, p: string, motors?: 'on' | 'off'): void => {
      const answer: ControllerAnswer = { http: 403, code, msg: `x code:${code}`, method, path: p, ...(motors ? { motors } : {}) };
      const out = refusalFor(answer, ctx);
      if (!out) { return; }
      checked++;
      for (const v of remedyViolations(out.refusal, { ctx, answer })) { problems.push(`${code} ${p} ${JSON.stringify(ctx)}: ${v}`); }
    };
    const base = (generation: typeof GENS[number], opmode: string | undefined): RefusalContext =>
      ({ ...(generation ? { generation } : {}), ...(opmode ? { opmode } : {}) });
    for (const [method, p, motors] of OPS) {
      for (const generation of GENS) {
        for (const opmode of MODES) {
          // held by another: the holder and this session's RMMP decide
          for (const code of [-1073445862, -1073435870]) {
            for (const holder of HOLDERS) {
              for (const rmmp of RMMP) {
                run(code, { ...base(generation, opmode), ...(holder ? { holder } : {}), ...(rmmp ? { rmmp } : {}) }, method, p, motors);
              }
            }
          }
          // the controller state decides
          for (const code of [-1073442809, -1073445806, -1073445881]) {
            for (const ctrlstate of STATES) { run(code, { ...base(generation, opmode), ...(ctrlstate ? { ctrlstate } : {}) }, method, p, motors); }
          }
          // the mode decides
          for (const code of [-1073445860, -1073445800, -1073435864, -1073445863, -1073445870, -1073445869]) {
            run(code, base(generation, opmode), method, p, motors);
          }
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(30_000);
  }, 60_000);

  it('410 Gone, a missing option, an option not opted, a platform restriction and SYS_CTRL_E_FAIL', () => {
    const msgs: Array<[number, number | null, string]> = [
      [410, null, ''], [410, -1073445881, 'Gone'],
      [403, -1073445881, 'Option is missing code:-1073445881 icode:-7301'],
      [403, -1, 'Collision Detection is not opted during system setup'],
      [403, -1073445881, 'Functionality is not supported on the current platform'],
      [403, SYS_CTRL_E_FAIL, 'Rejected code:-1073445881 icode:-2'],
      [403, SYS_CTRL_E_FAIL, 'x code:-1073435864'],
      [400, SYS_CTRL_E_FAIL, 'org_code: -4502 new_code: 0xc004841c; code:-1073414146 icode:-1073445860'],
    ];
    for (const [http, code, msg] of msgs) {
      for (const [method, p, motors] of OPS) {
        for (const generation of GENS) {
          for (const virtual of [true, false, undefined]) {
            const ctx: RefusalContext = { ...(generation ? { generation } : {}), ...(virtual !== undefined ? { virtual } : {}), opmode: 'MANR' };
            const answer: ControllerAnswer = { http, code, msg, method, path: p, ...(motors ? { motors } : {}) };
            const out = refusalFor(answer, ctx);
            if (out) { checkRemedies(out.refusal, { ctx, answer }, `${http} ${code} ${msg} ${p}`); }
          }
        }
      }
    }
  });

  it('every recorded error fixture (tests/fixtures/errors) that is a refusal carries a valid remedy', () => {
    const dir = path.join(root, 'tests/fixtures/errors');
    let refusals = 0;
    for (const gen of fs.readdirSync(dir)) {
      for (const f of fs.readdirSync(path.join(dir, gen))) {
        const fx = JSON.parse(fs.readFileSync(path.join(dir, gen, f), 'utf8')) as {
          request: { method: string; path: string }; response: { status: number; body: string };
        };
        for (const generation of gen === 'rws1' ? ['rw6'] as const : ['rw7', 'rw8'] as const) {
          for (const opmode of ['AUTO', 'MANR']) {
            const context: RefusalContext = { generation, opmode };
            const info = classifyControllerError({
              httpStatus: fx.response.status, body: fx.response.body, method: fx.request.method, path: fx.request.path, context,
            });
            if (!info.refusal) { continue; }
            refusals++;
            checkRemedies(info.refusal, { ctx: context, answer: { http: fx.response.status, code: null, msg: null, ...fx.request } }, `${gen}/${f}`);
          }
        }
      }
    }
    expect(refusals).toBeGreaterThan(20);
  });
});

// ─── 2. One case per row of the mapping ─────────────────────────────────────

const ans = (code: number | null, p: string, over: Partial<ControllerAnswer> = {}): ControllerAnswer => ({
  http: 403, code, msg: code === null ? null : `Refused code:${code} icode:-1`, method: 'POST', path: p, ...over,
});
function kindsOf(a: ControllerAnswer, ctx: RefusalContext): { kind: RefusalKind; remedy: string; others: string[]; r: RwsRefusal } {
  const out = refusalFor(a, ctx);
  expect(out, `no refusal for ${a.code} ${a.path}`).not.toBeNull();
  const r = out!.refusal;
  checkRemedies(r, { ctx, answer: a }, `${a.code} ${a.path}`);
  return { kind: r.kind, remedy: r.remedy!.kind, others: (r.otherRemedies ?? []).map(x => x.kind), r };
}

describe('2. the mapping, one case per row', () => {
  const WA = '/rw/controlstation/writeaccess/request';
  const MS = '/rw/mastership/edit/request';

  it('held-by-other', () => {
    // RobotWare 8, the FlexPendant named as holder
    expect(kindsOf(ans(-1073435870, WA), { generation: 'rw8', holder: { kind: 'unknown', name: 'FlexPendant' } }))
      .toMatchObject({ kind: 'held-by-other', remedy: 'release-pendant-write-access', others: [] });
    // RobotWare 8, another station or unnamed: the holder releases; the FlexPendant can always take it back
    for (const holder of [{ kind: 'unknown' as const, name: 'Zebra Line 9 PLC' }, undefined]) {
      const k = kindsOf(ans(-1073435870, WA), { generation: 'rw8', ...(holder ? { holder } : {}) });
      expect(k).toMatchObject({ kind: 'held-by-other', remedy: 'holder-releases' });
      expect(k.r.remedy!.byWhom).toBe('other-station');
      expect(k.r.remedy!.detail).toMatch(/FlexPendant can always take write access back/);
    }
    // RobotWare 6/7: the pendant (local, RobotWare 7's with application TPU)
    expect(kindsOf(ans(-1073445862, MS), { generation: 'rw7', opmode: 'AUTO', holder: { kind: 'local' } }).remedy).toBe('release-pendant-mastership');
    expect(kindsOf(ans(-1073445862, MS), { generation: 'rw7', opmode: 'AUTO', holder: { kind: 'local', application: 'TPU' } }).remedy)
      .toBe('release-pendant-mastership');
    // RobotWare 6/7: remote (a remote holder with application TPU has not
    // been seen, and is not taken for the pendant), PLC, unknown or not named
    for (const holder of [{ kind: 'remote' as const }, { kind: 'remote' as const, application: 'TPU' }, { kind: 'plc' as const }, { kind: 'unknown' as const }, undefined]) {
      expect(kindsOf(ans(-1073445862, MS), { generation: 'rw6', opmode: 'AUTO', ...(holder ? { holder } : {}) }).remedy).toBe('holder-releases');
    }
    // RobotWare 6/7: the controller itself (an operation in progress)
    expect(kindsOf(ans(-1073445862, MS), { generation: 'rw7', opmode: 'AUTO', holder: { kind: 'internal' } }).remedy).toBe('wait');
  });

  it('not-held, not-registered, lost', () => {
    expect(kindsOf(ans(-1073445859, '/rw/panel/speedratio'), { generation: 'rw7' })).toMatchObject({ kind: 'not-held', remedy: 'report' });
    expect(kindsOf(ans(-1073435871, WA), { generation: 'rw8' })).toMatchObject({ kind: 'not-registered', remedy: 'run-again' });
    expect(kindsOf(ans(-1073435873, '/rw/panel/speedratio'), { generation: 'rw8', registered: false }))
      .toMatchObject({ kind: 'not-registered', remedy: 'run-again' });
    const lost = refusalFor(ans(-1073435873, '/rw/panel/speedratio'), { generation: 'rw8' }, { lost: 'the FlexPendant took it' })!.refusal;
    expect(lost).toMatchObject({ kind: 'lost', remedy: { kind: 'run-again', byWhom: 'person-at-this-tool' } });
  });

  it('remote-access-off', () => {
    const k = kindsOf(ans(-1073435872, WA, { http: 400 }), { generation: 'rw8' });
    expect(k).toMatchObject({ kind: 'remote-access-off', remedy: 'remote-access-on', others: [] });
    expect(k.r.remedy!.byWhom).toBe('person-at-pendant');
    expect(k.r.remedy!.detail).toMatch(/Messages button for more than one second/);
  });

  it('motion-control-off: the controller answered -1073435864, on a start, a step, the production entry and a jog', () => {
    for (const p of ['/rw/rapid/execution/start', '/rw/rapid/execution/startprodentry', '/rw/rapid/execution/holdtorun', '/rw/motionsystem/ROB_1/jog']) {
      const k = kindsOf(ans(-1073435864, p), { generation: 'rw8' });
      expect(k, p).toMatchObject({ kind: 'motion-control-off', remedy: 'declare-motion-control', others: ['do-at-pendant'] });
      expect(k.r.remedy).toMatchObject({
        byWhom: 'person-confirms-in-a-tool', call: { method: 'setAllowMotionControl', allow: true }, safetyDeclaration: true,
        appliesTo: { generation: 'rw8', scope: 'station', operation: `POST ${p}` }, afterwards: 'run-again',
      });
      expect(k.r.remedy!.detail).toBe('A person who has an emergency stop and a normal stop within reach allows motion control for this control station. '
        + 'A station that registers on its own, such as another tool, did not share it on RobotWare 8.2.1. Or start or jog at the FlexPendant.');
    }
  });

  it('motion-control-off from the reading before a jog: check first; allowing it is another way', () => {
    const e = (RobotManager as unknown as { jogMotionControlOffRefusal(e: RwsError, by?: string): RwsError })
      .jogMotionControlOffRefusal(new RwsError('Refused', 'UNKNOWN', 403, undefined, -1073445881, 'Rejected'));
    const r = e.refusal!;
    expect(r).toMatchObject({ kind: 'motion-control-off', evidence: 'unverified' });
    expect(r.remedy).toMatchObject({ kind: 'check-state', evidence: 'unverified' });
    expect(r.remedy!.detail).toMatch(/did not say why/);
    expect(r.otherRemedies!.map(x => x.kind)).toEqual(['declare-motion-control', 'do-at-pendant']);
    expect(r.sentence).toMatch(/may be the reason/);
    checkRemedies(r, { ctx: { generation: 'rw8' } }, 'jog reading');
  });

  it('motion-held and external-client-motion', () => {
    expect(kindsOf(ans(-1073445844, '/rw/rapid/execution/start', { http: 500 }), { generation: 'rw7' }))
      .toMatchObject({ kind: 'motion-held', remedy: 'release-own-hold' });
    const ext = kindsOf(ans(-1073445845, '/rw/rapid/execution/start'), { generation: 'rw7' });
    expect(ext).toMatchObject({ kind: 'external-client-motion', remedy: 'holder-releases' });
    expect(ext.r.remedy!.detail).toMatch(/external client/);
  });

  it('rmmp-required: an operation RMMP covers asks for it at the covering level; one it does not cover goes to the FlexPendant', () => {
    expect(kindsOf(ans(-1073445862, MS), { generation: 'rw7', opmode: 'MANR' }))
      .toMatchObject({ kind: 'rmmp-required', remedy: 'request-rmmp', others: ['do-at-pendant'] });
    expect(kindsOf(ans(-1073445862, MS), { generation: 'rw7', opmode: 'MANR' }).r.remedy!.call).toEqual({ method: 'requestRmmp', level: 'modify' });
    expect(kindsOf(ans(-1073445862, '/rw/rapid/tasks/T_ROB1/pcp/routine'), { generation: 'rw7', opmode: 'MANR' }).r.remedy!.call)
      .toEqual({ method: 'requestRmmp', level: 'exec' });
    for (const p of ['/rw/rapid/execution/start', '/rw/rapid/execution?action=start', '/rw/rapid/execution/resetpp', '/rw/rapid/tasks/T_ROB1/pcp/cursor',
      '/rw/rapid/tasks/T_ROB1/pcp?action=set-pp-routine']) {
      for (const generation of ['rw6', 'rw7'] as const) {
        const k = kindsOf(ans(-1073445862, p), { generation, opmode: 'MANR' });
        expect(k, `${generation} ${p}`).toMatchObject({ kind: 'rmmp-required', remedy: 'do-at-pendant', others: ['mode'] });
        expect(k.r.otherRemedies![0].label).toBe('Switch to Auto');
        // The sentence follows the same rule: it no longer offers what cannot help.
        expect(k.r.sentence).not.toMatch(/requestRmmp|press Grant/);
        expect(k.r.sentence).toMatch(/does not cover this operation/);
      }
    }
  });

  it('a jog refused as held in manual mode on RobotWare 6/7 goes to the FlexPendant only: no Auto, no RMMP', () => {
    for (const jogPath of ['/rw/motionsystem/ROB_1/jog', '/rw/motionsystem/jog', '/rw/motionsystem?action=jog']) {
      const cases: Array<[RefusalContext, RefusalKind]> = [
        [{ generation: 'rw6', opmode: 'MANR' }, 'rmmp-required'],
        [{ generation: 'rw6', opmode: 'MANF' }, 'rmmp-required'],
        [{ generation: 'rw7', opmode: 'MANR' }, 'rmmp-required'],
        [{ generation: 'rw7', opmode: 'MANF' }, 'rmmp-wrong-mode'],
        [{ generation: 'rw7', opmode: 'MANR', rmmp: 'pending' }, 'rmmp-pending'],
      ];
      for (const [ctx, kind] of cases) {
        const k = kindsOf(ans(-1073445862, jogPath), { ...ctx, robot: 'cell-7' });
        const where = `${jogPath} ${JSON.stringify(ctx)}`;
        expect(k, where).toMatchObject({ kind, remedy: 'do-at-pendant', others: [] });
        expect(k.r.remedy!.detail, where).toMatch(/^Jog at the FlexPendant/);
        expect(`${k.r.sentence} ${k.r.fix}`, where).not.toMatch(/Auto|requestRmmp|press Grant/);
        expect(k.r.fix, where).toMatch(/^Jog at the FlexPendant: ABB's jog pages require a local client with mastership/);
      }
    }
  });

  it('rmmp-pending, rmmp-denied, rmmp-expired', () => {
    expect(kindsOf(ans(-1073445862, MS), { generation: 'rw7', opmode: 'MANR', rmmp: 'pending' }))
      .toMatchObject({ kind: 'rmmp-pending', remedy: 'grant-rmmp-at-pendant' });
    const denied = kindsOf(ans(-1073445863, '/users/rmmp/poll', { method: 'GET' }), { generation: 'rw7', opmode: 'MANR' });
    expect(denied).toMatchObject({ kind: 'rmmp-denied', remedy: 'grant-rmmp-at-pendant', others: ['request-rmmp'] });
    expect(denied.r.remedy!.detail).toMatch(/said no\. Speak to them first/);
    expect(kindsOf(ans(-1073445870, '/users/rmmp/poll', { method: 'GET' }), { generation: 'rw6', opmode: 'MANR' }))
      .toMatchObject({ kind: 'rmmp-expired', remedy: 'request-rmmp', others: ['do-at-pendant'] });
  });

  it('rmmp-wrong-mode', () => {
    // RobotWare 7 MANF, an operation RMMP covers: to MANR, then RMMP
    expect(kindsOf(ans(-1073445862, MS), { generation: 'rw7', opmode: 'MANF' }))
      .toMatchObject({ kind: 'rmmp-wrong-mode', remedy: 'mode', others: ['request-rmmp'] });
    // ... and one it does not cover
    const start = kindsOf(ans(-1073445862, '/rw/rapid/execution/start'), { generation: 'rw7', opmode: 'MANF' });
    expect(start).toMatchObject({ kind: 'rmmp-wrong-mode', remedy: 'do-at-pendant', others: ['mode'] });
    expect(start.r.sentence).not.toMatch(/Then this tool can ask/);
    // -1073445800 in MANR: the enabling device, by the person at the pendant
    const manr = kindsOf(ans(-1073445800, '/users/rmmp'), { generation: 'rw7', opmode: 'MANR' });
    expect(manr).toMatchObject({ kind: 'rmmp-wrong-mode', remedy: 'check-state', others: ['do-at-pendant'] });
    expect(manr.r.remedy!.byWhom).toBe('person-at-pendant');
    // -1073445800 outside MANR: to MANR
    const auto = kindsOf(ans(-1073445800, '/users/rmmp'), { generation: 'rw7', opmode: 'AUTO' });
    expect(auto).toMatchObject({ kind: 'rmmp-wrong-mode', remedy: 'mode' });
    expect(auto.r.remedy!.label).toBe('Switch to manual reduced speed (MANR)');
  });

  it('grant-missing', () => {
    const k = kindsOf(ans(-1073445867, '/rw/panel/speedratio'), { generation: 'rw7', user: 'Operator' });
    expect(k).toMatchObject({ kind: 'grant-missing', remedy: 'grant-missing' });
    expect(k.r.remedy).toMatchObject({ byWhom: 'administrator', appliesTo: { scope: 'user' } });
    expect(k.r.remedy!.detail).not.toMatch(/relax|remove the grant/i);
  });

  it('wrong-mode', () => {
    expect(kindsOf(ans(-1073445860, '/rw/panel/speedratio'), { generation: 'rw7', opmode: 'MANR' })).toMatchObject({ kind: 'wrong-mode', remedy: 'mode' });
    expect(kindsOf(ans(-1073435895, '/rw/panel/speedratio'), { generation: 'rw8', opmode: 'AUTO' })).toMatchObject({ kind: 'wrong-mode', remedy: 'mode' });
    // RobotWare 7 manual, pointer to a routine: RMMP exec (never granted on our virtual controllers)
    const routine = kindsOf(ans(-1073445860, '/rw/rapid/tasks/T_ROB1/pcp/routine'), { generation: 'rw7', opmode: 'MANR' });
    expect(routine).toMatchObject({ kind: 'wrong-mode', remedy: 'request-rmmp', others: ['do-at-pendant', 'mode'] });
    expect(routine.r.remedy!.call).toEqual({ method: 'requestRmmp', level: 'exec' });
    expect(routine.r.remedy!.detail).toMatch(/has not granted exec/);
    // RobotWare 7 manual PP to Main; RobotWare 6 manual pointer moves; RobotWare 7 other pointer moves
    for (const [generation, p] of [['rw7', '/rw/rapid/execution/resetpp'], ['rw6', '/rw/rapid/tasks/T_ROB1/pcp?action=set-pp-routine'],
      ['rw6', '/rw/rapid/execution?action=resetpp'], ['rw7', '/rw/rapid/tasks/T_ROB1/pcp/cursor']] as const) {
      const k = kindsOf(ans(-1073445860, p), { generation, opmode: 'MANR' });
      expect(k, p).toMatchObject({ kind: 'wrong-mode', remedy: 'do-at-pendant', others: ['mode'] });
      expect(k.r.sentence, p).not.toMatch(/requestRmmp/);
    }
    // A jog outside manual mode (jogModeRefusal): to MANR
    const jog = (RobotManager as unknown as { jogModeRefusal(e: RwsError, mode: string, g: string): RwsError })
      .jogModeRefusal(new RwsError('x', 'UNKNOWN', 403), 'AUTO', 'rw8').refusal!;
    expect(jog).toMatchObject({ kind: 'wrong-mode', remedy: { kind: 'mode', label: 'Switch to manual reduced speed (MANR)' } });
    // A write-access request while a mode change waits (AUTO_CH)
    expect(kindsOf(ans(-1073414145, WA), { generation: 'rw8', opmode: 'AUTO_CH' })).toMatchObject({ kind: 'wrong-mode', remedy: 'confirm-mode-change' });
  });

  it('wrong-state: the motors off', () => {
    const start = '/rw/rapid/execution/start';
    // RobotWare 8: the Reset at the FlexPendant
    const rw8 = kindsOf(ans(-1073442809, start), { generation: 'rw8', ctrlstate: 'motoroff', opmode: 'AUTO' });
    expect(rw8).toMatchObject({ kind: 'wrong-state', remedy: 'motors-on', others: [] });
    expect(rw8.r.remedy!.byWhom).toBe('person-at-pendant');
    expect(rw8.r.remedy!.detail).toMatch(/Reset/);
    // RobotWare 6/7 manual: the enabling device
    const manr = kindsOf(ans(-1073442809, start), { generation: 'rw7', ctrlstate: 'motoroff', opmode: 'MANR' });
    expect(manr.r.remedy).toMatchObject({ kind: 'motors-on', byWhom: 'person-at-pendant' });
    expect(manr.r.remedy!.detail).toMatch(/enabling device/);
    // RobotWare 6/7 Auto: setMotorsOn after a person confirms, or at the controller
    for (const generation of ['rw6', 'rw7'] as const) {
      const auto = kindsOf(ans(-1073442809, start), { generation, ctrlstate: 'motoroff', opmode: 'AUTO' });
      expect(auto).toMatchObject({ remedy: 'motors-on', others: ['motors-on'] });
      expect(auto.r.remedy).toMatchObject({ byWhom: 'person-confirms-in-a-tool', call: { method: 'setMotorsOn' } });
      expect(auto.r.otherRemedies![0].byWhom).toBe('person-at-pendant');
    }
    // A jog in Auto with the motors off: at the FlexPendant, in MANR with the enabling device
    const jogAuto = kindsOf(ans(-1073445806, '/rw/motionsystem/ROB_1/jog'), { generation: 'rw7', ctrlstate: 'motoroff', opmode: 'AUTO' });
    expect(jogAuto).toMatchObject({ remedy: 'do-at-pendant' });
    // A jog refused while the motors read off (jogMotorsOffRefusal): the enabling device
    const jog = (RobotManager as unknown as { jogMotorsOffRefusal(e: RwsError, c: string, g: string): RwsError })
      .jogMotorsOffRefusal(new RwsError('x', 'UNKNOWN', 403), 'motoroff', 'rw7').refusal!;
    expect(jog.remedy).toMatchObject({ kind: 'motors-on', byWhom: 'person-at-pendant' });
    expect(jog.remedy!.detail).toMatch(/enabling device/);
  });

  it('wrong-state: a safety stop, the state not known, a running program, the program itself, an unlock with no lock', () => {
    for (const ctrlstate of ['guardstop', 'emergencystop']) {
      expect(kindsOf(ans(-1073445806, '/rw/rapid/execution/start'), { generation: 'rw8', ctrlstate })).toMatchObject({ remedy: 'reset-safety-stop' });
    }
    expect(kindsOf(ans(-1073442809, '/rw/rapid/execution/start'), { generation: 'rw7' })).toMatchObject({ kind: 'wrong-state', remedy: 'check-state' });
    expect(kindsOf(ans(-1073445806, '/rw/rapid/execution/start'), { generation: 'rw8' })).toMatchObject({ kind: 'wrong-state', remedy: 'check-state' });
    for (const [code, p] of [[-1073442803, '/rw/rapid/tasks/T_ROB1/pcp/routine'], [-1073442802, '/rw/rapid/tasks/T_ROB1/pcp/routine'],
      [-1073442812, '/rw/rapid/tasks/T_ROB1/program?action=save']] as const) {
      expect(kindsOf(ans(code, p, { http: 400 }), { generation: 'rw7' })).toMatchObject({ kind: 'wrong-state', remedy: 'fix-input' });
    }
    expect(kindsOf(ans(-1073435886, '/rw/panel/opmode/unlock'), { generation: 'rw8' })).toMatchObject({ kind: 'wrong-state', remedy: 'nothing-needed' });
  });

  it('wrong-state: a program running (programRunningRefusal) asks to stop it first; RobotWare 8 service routine in Auto goes to the FlexPendant', async () => {
    const mgr = new RobotManager();
    const fake = { requestMastership: async () => {}, releaseMastership: async () => {} } as unknown as IRWSAdapter;
    const e = (mgr as unknown as { programRunningRefusal(a: IRWSAdapter, op: string, nd: string, e: unknown): RwsError })
      .programRunningRefusal(fake, 'unloadModule', 'Nothing was unloaded.', new RwsError('x', 'UNKNOWN', 403, undefined, -1073442809, 'x'));
    expect(e.refusal).toMatchObject({ kind: 'wrong-state', remedy: { kind: 'stop-program-first', call: { method: 'stopRapid' } } });
    expect(e.refusal!.otherRemedies!.map(x => x.kind)).toEqual(['do-at-pendant']);
    checkRemedies(e.refusal!, { ctx: {} }, 'programRunningRefusal');

    const adapter = new RWS2Adapter('http://127.0.0.1:1', 'u', 'p');
    (adapter as unknown as Record<string, unknown>).writeAccessMode = 'controlstation';
    (adapter as unknown as { getOperationMode(): Promise<string> }).getOperationMode = async () => 'AUTO';
    const rw8 = new RobotManager();
    (rw8 as unknown as { adapter: unknown }).adapter = adapter;
    const sr = await rw8.setPPToServiceRoutine('T_ROB1', 'calib').then(() => null, (x: unknown) => x as RwsError);
    expect(sr!.refusal).toMatchObject({ kind: 'wrong-state', remedy: { kind: 'do-at-pendant' } });
    expect(sr!.refusal!.otherRemedies![0]).toMatchObject({ kind: 'mode', label: 'Switch to manual reduced speed (MANR)' });
    checkRemedies(sr!.refusal!, { ctx: { generation: 'rw8', opmode: 'AUTO' } }, 'setPPToServiceRoutine');
  });

  it('safety-state, access-restricted, local-only', () => {
    expect(kindsOf(ans(-1073445806, '/rw/panel/ctrl-state', { motors: 'on' }), { generation: 'rw8' })).toMatchObject({ kind: 'safety-state', remedy: 'reset-safety-stop' });
    expect(kindsOf(ans(-1073445881, '/rw/panel/ctrlstate?action=setctrlstate', { motors: 'on' }), { generation: 'rw6' }))
      .toMatchObject({ kind: 'safety-state', remedy: 'reset-safety-stop' });
    const io = kindsOf(ans(-1073445881, '/rw/iosystem/signals/Local/DRV_1/DO1/set-value'), { generation: 'rw7', opmode: 'MANR' });
    expect(io).toMatchObject({ kind: 'access-restricted', remedy: 'signal-access-level' });
    expect(io.r.remedy!.byWhom).toBe('integrator');
    for (const code of [-1073435869, -1073435856, -1073445868, -1073445875, -1073445810]) {
      expect(kindsOf(ans(code, '/rw/controlstation/disableexternalcontrol'), { generation: 'rw8' })).toMatchObject({ kind: 'local-only', remedy: 'do-at-pendant' });
    }
    expect(kindsOf(ans(-1073445860, '/rw/motionsystem/ROB_1/jog'), { generation: 'rw7', opmode: 'MANR' })).toMatchObject({ kind: 'local-only', remedy: 'do-at-pendant' });
  });

  it('vc-only, rc-only, unsupported (RMMP on RobotWare 8 names Remote Access and write access), by-design', () => {
    const plat = ans(-1073445881, '/ctrl/system/info', { msg: 'Functionality is not supported on the current platform' });
    expect(kindsOf(plat, { virtual: true })).toMatchObject({ kind: 'rc-only', remedy: 'not-available' });
    expect(kindsOf(plat, { virtual: false })).toMatchObject({ kind: 'vc-only', remedy: 'not-available' });
    expect(kindsOf(ans(-1073445885, '/users/rmmp', { http: 500 }), { generation: 'rw8' })).toMatchObject({ kind: 'unsupported', remedy: 'not-available' });
    const rmmp8 = rmmpUnsupportedOnRw8('requestRmmp', '8.2.1').refusal!;
    expect(rmmp8.remedy).toMatchObject({ kind: 'not-available', byWhom: 'none' });
    expect(rmmp8.remedy!.detail).toMatch(/Remote Access.*write access/);
    checkRemedies(rmmp8, { ctx: { generation: 'rw8' } }, 'rmmpUnsupportedOnRw8');
    expect(kindsOf(ans(-1073445881, '/rw/rapid/tasks/activate'), { generation: 'rw7' })).toMatchObject({ kind: 'by-design', remedy: 'not-available' });
    expect(kindsOf(ans(-1073445813, '/users/impersonate'), { generation: 'rw7' })).toMatchObject({ kind: 'by-design', remedy: 'not-available' });
    expect(kindsOf(ans(-1073435874, '/rw/controlstation/register/remote'), { generation: 'rw8' })).toMatchObject({ kind: 'by-design', remedy: 'reconnect' });
  });

  it('option-missing, invalid-argument, watchdog-expired, unknown', () => {
    expect(kindsOf(ans(-1073445881, '/x', { msg: 'Option is missing code:-1073445881 icode:-7301' }), {})).toMatchObject({ kind: 'option-missing', remedy: 'option-missing' });
    for (const [code, p] of [[-1073445879, '/rw/panel/speedratio'], [-1073445827, '/users/grant-exists?grant=UAS_NOPE'], [-1073436654, '/rw/motionsystem/mechunits/ROB_1'],
      [-1073435867, '/rw/controlstation/register/remote']] as const) {
      expect(kindsOf(ans(code, p, { http: 400 }), { generation: 'rw7' })).toMatchObject({ kind: 'invalid-argument', remedy: 'fix-input' });
    }
    expect(defaultRemedies('watchdog-expired', 'rw7', 'this-tool', 'mastership').remedy.kind).toBe('run-again');
    expect(kindsOf(ans(-1073445873, '/rw/panel/speedratio'), { generation: 'rw7' })).toMatchObject({ kind: 'unknown', remedy: 'reconnect' });
    expect(kindsOf(ans(-1073445872, '/rw/mastership/rapid?action=request'), { generation: 'rw6' })).toMatchObject({ kind: 'unknown', remedy: 'nothing-needed' });
    expect(kindsOf(ans(null, '/rw/panel/speedratio'), {})).toMatchObject({ kind: 'unknown', remedy: 'none-known' });
    expect(kindsOf(ans(-1073400000, '/rw/panel/speedratio'), {})).toMatchObject({ kind: 'unknown', remedy: 'none-known' });
  });
});

// ─── 3. Every build site outside refusalFor carries a remedy ────────────────

describe('3. every builtRefusal / refusalError call site yields a remedy', () => {
  it('the call sites in src are the ones this test covers', () => {
    const counts: Record<string, number> = {};
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
    for (const f of walk(path.join(root, 'src'))) {
      if (f.endsWith(`${path.sep}refusal.ts`)) { continue; }
      const n = (fs.readFileSync(f, 'utf8').match(/\b(builtRefusal|refusalError)\(/g) ?? []).length;
      if (n) { counts[path.relative(root, f).split(path.sep).join('/')] = n; }
    }
    expect(counts).toEqual({
      'src/RWS1Adapter.ts': 1,                // setVirtualTimeScale
      'src/RobotManager.ts': 7,               // programRunningRefusal, unloadModule (event log), setPPToServiceRoutine, notOnRws1, jogModeRefusal, jogMotorsOffRefusal, jogMotionControlOffRefusal
      'src/access/AccessManager.ts': 1,       // lostInOperation
      'src/access/rmmp.ts': 3,                // rmmpUnsupportedOnRw8, rmmpOutcomeRefusal (2)
      'src/paths/ctrl.ts': 1,                 // virtualTimeRunningUnsupported
    });
  });

  it('each of them, called', async () => {
    const vt = virtualTimeRunningUnsupported().refusal!;
    expect(vt.remedy?.kind).toBe('not-available');
    checkRemedies(vt, { ctx: {} }, 'virtualTimeRunningUnsupported');

    const rws1 = await new RWS1Adapter({} as unknown as RwsClient).setVirtualTimeScale(2).then(() => null, (e: unknown) => e as RwsError);
    expect(rws1!.refusal?.remedy?.kind).toBe('not-available');
    checkRemedies(rws1!.refusal!, { ctx: { generation: 'rw6' } }, 'setVirtualTimeScale');

    const am = new AccessManager({
      label: 'T', locks: () => ['writeaccess'], lockOf: () => 'writeaccess', domainOf: () => 'rapid',
      request: async () => {}, release: async () => {}, generation: () => 'rw8',
    });
    const lost = (am as unknown as { lostInOperation(l: unknown): RwsError }).lostInOperation({ lock: 'writeaccess', reason: 'unknown', detail: 'x' });
    expect(lost.refusal).toMatchObject({ kind: 'lost', remedy: { kind: 'run-again' } });
    checkRemedies(lost.refusal!, { ctx: { generation: 'rw8' } }, 'lostInOperation');

    const notOn = new RobotManager();
    (notOn as unknown as { adapter: unknown }).adapter = new RWS1Adapter({} as unknown as RwsClient);
    const w = await notOn.resetMastershipWatchdog().then(() => null, (e: unknown) => e as RwsError);
    expect(w!.refusal?.remedy?.kind).toBe('not-available');
    checkRemedies(w!.refusal!, { ctx: { generation: 'rw6' } }, 'notOnRws1');

    // rmmpOutcomeRefusal: denied, expired, and a request the controller never showed as waiting
    const port = (poll: () => Promise<string>, read: () => Promise<string>): RmmpPort => ({
      request: async () => {}, poll, read, cancel: async () => {},
    });
    const denied = await waitForRmmp(port(async () => { throw new RwsError('d', 'GRANT_DENIED', 403, undefined, -1073445863); }, async () => 'none'),
      'exec', { waitMs: 2000, pollMs: 250 }, 'rw7');
    expect(denied.refusal).toMatchObject({ kind: 'rmmp-denied', remedy: { kind: 'grant-rmmp-at-pendant' } });
    expect(denied.refusal!.otherRemedies![0].call).toEqual({ method: 'requestRmmp', level: 'exec' });
    checkRemedies(denied.refusal!, { ctx: { generation: 'rw7', opmode: 'MANR' } }, 'rmmp denied');
    let reads = 0;
    const expired = await waitForRmmp(port(async () => 'NO SUCH REQUEST', async () => (++reads === 1 ? 'pending modify' : 'none')),
      'modify', { waitMs: 3000, pollMs: 250 }, 'rw7');
    expect(expired.refusal).toMatchObject({ kind: 'rmmp-expired', remedy: { kind: 'request-rmmp', call: { method: 'requestRmmp', level: 'modify' } } });
    checkRemedies(expired.refusal!, { ctx: { generation: 'rw7', opmode: 'MANR' } }, 'rmmp expired');
    const never = await waitForRmmp(port(async () => 'whatever', async () => 'none'), 'modify', { waitMs: 300, pollMs: 250 }, 'rw7');
    expect(never.refusal).toMatchObject({ kind: 'unknown', remedy: { kind: 'none-known' } });
    checkRemedies(never.refusal!, { ctx: { generation: 'rw7' } }, 'rmmp never stood');
  });

  it('unloadModule (event log): the listed name gives fix-input, otherwise check-state; one remedy, stamped with the refusal', async () => {
    const UNLOAD = '/rw/rapid/tasks/T_ROB1/unloadmod';
    const reasonInLog = (context?: RefusalContext): RwsError => {
      const body = JSON.stringify({ status: { code: -1073414145, msg: 'Reason written in elog code:-1073414145 icode:-1' } });
      const info = classifyControllerError({ httpStatus: 403, body, method: 'POST', path: UNLOAD, ...(context ? { context } : {}) });
      return new RwsError(info.message, info.code, 403, body, info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
    };
    const unload = async (listed: string[], refused: RwsError): Promise<RwsError> => {
      const adapter = {
        requestMastership: async () => {}, releaseMastership: async () => {},
        getRapidExecutionState: async () => 'stopped',
        unloadModule: async () => { throw refused; },
        listModules: async () => listed,
        getEventLog: async () => [],
      } as unknown as IRWSAdapter;
      const mgr = new RobotManager();
      const m = mgr as unknown as { adapter: IRWSAdapter; _state: Record<string, unknown> };
      m.adapter = adapter;
      Object.assign(m._state, { connected: true, modulesByTask: { T_ROB1: listed }, systemInfo: { name: 'IRB_1300', rwVersion: '6.16.3' } });
      return mgr.unloadModule('T_ROB1', 'Probe').then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as RwsError);
    };
    for (const context of [undefined, { generation: 'rw6' as const }]) {
      for (const [listed, kind] of [[['BASE', 'Probe#2'], 'fix-input'], [['BASE', 'Probe'], 'check-state']] as const) {
        const e = await unload([...listed], reasonInLog(context));
        const r = e.refusal!;
        const where = `${JSON.stringify(context)} ${listed.join(',')}`;
        expect(r.sentence, where).toMatch(/wrote its reason in the event log/);
        expect(r.remedy, where).toMatchObject({ kind, appliesTo: { generation: r.generation, operation: `POST ${UNLOAD}` } });
        expect(r.remedy!.detail, where).toMatch(kind === 'fix-input' ? /Probe#2/ : /event log/);
        expect(r.otherRemedies, where).toBeUndefined();
        checkRemedies(r, { ctx: context ?? {}, answer: { http: 403, code: -1073414145, msg: null, method: 'POST', path: UNLOAD } }, `unloadModule ${where}`);
      }
    }
    // Other ways of the controller's first explanation do not carry over.
    const withOthers = reasonInLog();
    withOthers.refusal!.otherRemedies = [remedy.noneKnown(null)];
    expect((await unload(['BASE', 'Probe'], withOthers)).refusal!.otherRemedies).toBeUndefined();
  });

  it('a built refusal without a remedy gets the default for its kind, stamped with its generation', () => {
    const kinds: RefusalKind[] = ['held-by-other', 'not-held', 'not-registered', 'lost', 'remote-access-off', 'motion-control-off', 'motion-held',
      'external-client-motion', 'rmmp-required', 'rmmp-pending', 'rmmp-denied', 'rmmp-expired', 'rmmp-wrong-mode', 'grant-missing', 'wrong-mode',
      'wrong-state', 'safety-state', 'access-restricted', 'local-only', 'vc-only', 'rc-only', 'by-design', 'option-missing', 'watchdog-expired',
      'unsupported', 'invalid-argument', 'unknown'];
    for (const kind of kinds) {
      for (const generation of ['rw6', 'rw7', 'rw8', null] as const) {
        const r = builtRefusal({ kind, condition: 'none', generation, missing: 'm', grantor: null, fix: 'f', sentence: 's', evidence: 'vc' });
        if (kind === 'motion-control-off' && generation !== 'rw8') { continue; }   // only RobotWare 8 refuses for motion control
        checkRemedies(r, { ctx: generation ? { generation } : {} }, `built ${kind} ${generation}`);
        // Built without the controller's answer: never the primary declaration.
        expect(r.remedy!.kind).not.toBe('declare-motion-control');
      }
    }
  });
});

// ─── 5, 6. explainRefusal, withReport, asLostRefusal ────────────────────────

describe('5, 6. the remedy follows the context, and survives a report', () => {
  const asError = (a: ControllerAnswer, ctx: RefusalContext): RwsError => {
    const info = classifyControllerError({ httpStatus: a.http, body: JSON.stringify({ status: { code: a.code, msg: a.msg } }), method: a.method, path: a.path, context: ctx });
    return new RwsError(info.message, info.code, a.http, undefined, info.controllerCode ?? undefined, info.controllerMsg ?? undefined, info.refusal);
  };

  it('explainRefusal: an unnamed RobotWare 8 holder, then the FlexPendant named', () => {
    const e = asError(ans(-1073435870, '/rw/controlstation/writeaccess/request'), { generation: 'rw8' });
    expect(e.refusal!.remedy!.kind).toBe('holder-releases');
    const named = explainRefusal(e, { holder: { kind: 'unknown', name: 'FlexPendant' } });
    expect(named.refusal!.remedy!.kind).toBe('release-pendant-write-access');
    expect(named.refusal!.remedy!.detail).not.toContain("'FlexPendant'");
    // In manual mode on RobotWare 7, a held lock becomes an RMMP step.
    const held = asError(ans(-1073445862, '/rw/mastership/edit/request'), { generation: 'rw7' });
    expect(held.refusal!.remedy!.kind).toBe('holder-releases');
    expect(explainRefusal(held, { opmode: 'MANR' }).refusal!.remedy!.kind).toBe('request-rmmp');
  });

  it('withReport keeps the remedy; asLostRefusal rebuilds it as run-again', () => {
    const e = asError(ans(-1073435864, '/rw/rapid/execution/start'), { generation: 'rw8' });
    const reported = withReport(e, 'loadProgram: done before it: uploaded the file.');
    expect(reported.refusal!.remedy).toEqual(e.refusal!.remedy);
    expect(reported.refusal!.otherRemedies).toEqual(e.refusal!.otherRemedies);
    const notHeld = asError(ans(-1073435873, '/rw/panel/speedratio'), { generation: 'rw8' });
    expect(notHeld.refusal!.remedy!.kind).toBe('report');
    const lost = asLostRefusal(notHeld, 'the FlexPendant took it') as RwsError;
    expect(lost.refusal).toMatchObject({ kind: 'lost', remedy: { kind: 'run-again' } });
  });
});

// ─── 7. confirmationFor ─────────────────────────────────────────────────────

describe('7. confirmationFor: the text a tool shows before a remedy\'s call', () => {
  const declare = remedy.declareMotionControl('rw8');
  const target = { name: 'IRB1600_6_120', label: 'IRB1600_6_120 (127.0.0.1:80)' };

  it('declare-motion-control: the robot, every robot and axis, both stops, the normal stop; a typed name', () => {
    const c = confirmationFor(declare, target)!;
    expect(c.title).toBe('Allow Motion Control on IRB1600_6_120 (127.0.0.1:80)');
    expect(c.lines).toEqual([
      'You confirm that an emergency stop and a normal stop are within your reach, for every robot and axis IRB1600_6_120 moves. '
        + "IRB1600_6_120 takes this as this control station's confirmation that both stops are available (ABB, Control Station Service: Allow Motion Control).",
      "A normal stop is the FlexPendant's Stop button held for more than 1 second, or a safe input set up for it. "
        + 'It is a category 1 stop and ends in guard stop (ABB, RobotWare 8 product specification).',
      'Allowing it moves nothing by itself.',
    ]);
    expect(c.confirmLabel).toBe('Both stops are within my reach');
    expect(c.typeName).toBe(true);
    expect(c.typePrompt).toBe("Type the robot's name to confirm that both stops are within your reach: IRB1600_6_120");
    for (const l of c.lines) { expect(l).not.toMatch(/[\r\n]/); }
  });

  it('the virtual-controller line only when virtual is true; the FlexPendant line only when it reads not connected', () => {
    const vc = confirmationFor(declare, { ...target, virtual: true })!.lines;
    expect(vc).toHaveLength(4);
    expect(vc[2]).toMatch(/^This is a virtual controller\./);
    // Until a run has shown the normal stop on the virtual FlexPendant, the line names neither stop.
    expect(vc[2]).not.toMatch(/emergency stop|Stop button/);
    expect(confirmationFor(declare, { ...target, virtual: false })!.lines).toHaveLength(3);
    expect(confirmationFor(declare, { ...target, virtual: null })!.lines).toHaveLength(3);
    const fp = confirmationFor(declare, { ...target, flexPendantConnected: false })!.lines;
    expect(fp).toContain('The FlexPendant reads as not connected. Its stops are not available.');
    expect(confirmationFor(declare, { ...target, flexPendantConnected: null })!.lines).toHaveLength(3);
    expect(confirmationFor(declare, { ...target, flexPendantConnected: true })!.lines).toHaveLength(3);
    // The last line is always the client's "moves nothing".
    expect(fp.at(-1)).toBe('Allowing it moves nothing by itself.');
  });

  it('setMotorsOn, requestRmmp and stopRapid; null for a remedy without a call', () => {
    const motors = confirmationFor(remedy.motorsOnCall('rw7'), target)!;
    expect(motors.lines).toEqual(['Switches the motors on at IRB1600_6_120. In Auto a running program can move the robot.']);
    expect(motors.typeName).toBe(true);
    expect(motors.typePrompt).toMatch(/IRB1600_6_120$/);
    const rmmp = confirmationFor(remedy.requestRmmp('rw7', 'exec'), target)!;
    expect(rmmp.confirmLabel).toBe('Ask the operator at the FlexPendant of IRB1600_6_120 for exec');
    expect(rmmp).toMatchObject({ typeName: false, typePrompt: null });
    const stop = confirmationFor(remedy.stopProgramFirst('rw7'), target)!;
    expect(stop.confirmLabel).toBe('Stop RAPID on IRB1600_6_120');
    expect(stop.lines).toEqual(['This is a program stop, not a normal stop.']);
    expect(stop).toMatchObject({ typeName: false, typePrompt: null });
    for (const r of [remedy.doAtPendant('rw8'), remedy.remoteAccessOn(), remedy.noneKnown(null), remedy.motorsOnAtPendant('rw8', 'reset')]) {
      expect(confirmationFor(r, target)).toBeNull();
    }
  });
});

// ─── 8. The motion-control sentence ─────────────────────────────────────────

describe('8. the motion-control-off sentence names no method and no session; fix names the call', () => {
  it('for a start, a jog and through the jog refusal of RobotManager', () => {
    const sentences: string[] = [];
    for (const p of ['/rw/rapid/execution/start', '/rw/motionsystem/ROB_1/jog']) {
      const r = refusalFor(ans(-1073435864, p), { generation: 'rw8', robot: 'IRB1600' })!.refusal;
      sentences.push(r.sentence);
      expect(r.fix).toBe('A person who has checked both stops allows motion control (setAllowMotionControl(true)). This client never does it on its own.');
    }
    expect(sentences[0]).toBe("Controller 'IRB1600' refused to start the RAPID program: motion control is not allowed for this control station. "
      + 'ABB requires a station that jogs or starts RAPID to have an emergency stop and a normal stop, '
      + "and treats allowing motion control as the station's confirmation that both are available. "
      + 'A RAPID start needs it even for a program that does not move the robot.');
    for (const by of ['code', 'reading']) {
      const e = (RobotManager as unknown as { jogMotionControlOffRefusal(e: RwsError, by: string): RwsError })
        .jogMotionControlOffRefusal(new RwsError('x', 'UNKNOWN', 403, undefined, -1073435864), by);
      sentences.push(e.refusal!.sentence);
      expect(e.refusal!.fix).toMatch(/setAllowMotionControl\(true\)/);
    }
    for (const s of sentences) {
      expect(s).not.toMatch(/setAllowMotionControl|session|declaration/);
    }
  });
});

// ─── 9. Static guard: nothing in the client sets motion control to true ─────

/** The source without comments. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** The source without comments and string literals, so only code is scanned. */
function codeOnly(src: string): string {
  return withoutComments(src)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('9. static guard: the allow-motion-control write', () => {
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
  const rel = (f: string): string => path.relative(root, f).split(path.sep).join('/');
  const sources = files(path.join(root, 'src')).map(f => ({ file: rel(f), raw: fs.readFileSync(f, 'utf8') }));

  it('the allow-motion-control body is built in ResourceMapper2 only', () => {
    const withBody = sources.filter(s => /['"]allow-motion-control['"]\s*:|allow-motion-control=/.test(withoutComments(s.raw))).map(s => s.file);
    expect(withBody).toEqual(['src/ResourceMapper2.ts']);
  });

  it('setAllowMotionControl( is called only by the RobotManager wrapper, the RWS 2.0 core (its set and its withdrawal) and defined in ResourceMapper2', () => {
    const calls: Record<string, string[]> = {};
    for (const s of sources) {
      const code = codeOnly(s.raw);
      const found = [...code.matchAll(/(\w+(?:\.\w+)*)?\.?setAllowMotionControl\(\s*([^)]*)\)/g)].map(m => m[0]);
      if (found.length) { calls[s.file] = found; }
    }
    expect(Object.keys(calls).sort()).toEqual(['src/ResourceMapper2.ts', 'src/RobotManager.ts', 'src/rws2/core.ts']);
    // No literal true reaches it, anywhere in the code.
    for (const [file, list] of Object.entries(calls)) {
      for (const c of list) { expect(`${file}: ${c}`).not.toMatch(/setAllowMotionControl\(\s*true\b/); }
    }
    // The wrapper passes the caller's value on; nothing else in RobotManager calls it.
    expect(calls['src/RobotManager.ts'].filter(c => !/setAllowMotionControl\(allow: boolean\)/.test(c)))
      .toEqual(['adapter.setAllowMotionControl(allow)']);
  });
});
