import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseControllerStatus, classifyControllerError, codeForControllerCode } from '../src/ControllerError.js';
import { decodeElogArgs } from '../src/types.js';
import type { RwsErrorCode } from '../src/types.js';

interface Fixture {
  protocol: string;
  scenario: string;
  request: { method: string; path: string; body?: string };
  response: { status: number; contentType: string; body: string };
}

function loadFixtures(): Fixture[] {
  const root = path.join(__dirname, 'fixtures', 'errors');
  const out: Fixture[] = [];
  for (const proto of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, proto))) {
      out.push(JSON.parse(fs.readFileSync(path.join(root, proto, file), 'utf8')));
    }
  }
  return out;
}

/**
 * Expected classification per captured scenario. Every entry is backed by a
 * raw payload captured live 2026-08-02 (RW6.16 IRC5 VC + RW7.21 OmniCore VC).
 */
const EXPECTED: Record<string, { code: RwsErrorCode; controllerCode: number }> = {
  // RWS 1.0
  'rws1/403-mastership-held-json':        { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445862 },
  'rws1/403-mastership-held-xhtml':       { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445862 },
  'rws1/403-signal-write-no-rmmp-json':   { code: 'GRANT_DENIED',        controllerCode: -1073445881 },
  'rws1/404-module-json':                 { code: 'MODULE_NOT_FOUND',    controllerCode: -1073414146 },
  'rws1/404-module-xhtml':                { code: 'MODULE_NOT_FOUND',    controllerCode: -1073414146 },
  'rws1/404-signal-json':                 { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073445866 },
  'rws1/404-file':                        { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073414146 },
  'rws1/404-symbol-json':                 { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073414146 },
  'rws1/400-exec-start-wrong-state-json': { code: 'WRONG_MODE',          controllerCode: -1073442809 },
  // -1073445879 SYS_CTRL_E_INVALIDARG: a value the controller refused. It was
  // unmapped (UNKNOWN) until 1.4.0.
  'rws1/400-cfg-write-invalid-json':      { code: 'INVALID_ARGUMENT',    controllerCode: -1073445879 },
  'rws1/400-cfg-write-invalid-xhtml':     { code: 'INVALID_ARGUMENT',    controllerCode: -1073445879 },
  'rws1/400-jog-invalid-input-json':      { code: 'INVALID_ARGUMENT',    controllerCode: -1073445879 },
  // Codes the map used to miss, so a 400 fell through to UNKNOWN and callers
  // lost their error branch. Captured 2026-08-06 on RW6.16 and RW7.21.
  'rws1/400-unload-unknown-module':       { code: 'MODULE_NOT_FOUND',    controllerCode: -1073442816 },
  'rws1/400-loadmod-missing-path':        { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073438708 },
  // RWS 2.0
  'rws2/403-speedratio-no-mastership-haljson': { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445859 },
  'rws2/403-speedratio-no-mastership-xhtml':   { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445859 },
  'rws2/403-mastership-held-haljson':          { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445862 },
  'rws2/403-mastership-held-xhtml':            { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445862 },
  // RWS2 reports a blocked exec start with the generic held/blocked code,
  // NOT the RWS1 wrong-state code - named accordingly
  'rws2/403-exec-start-blocked-haljson':       { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073445862 },
  'rws2/403-signal-write-no-rmmp-haljson':     { code: 'GRANT_DENIED',        controllerCode: -1073445881 },
  'rws2/400-module-missing-haljson':           { code: 'MODULE_NOT_FOUND',    controllerCode: -1073442813 },
  'rws2/400-module-missing-xhtml':             { code: 'MODULE_NOT_FOUND',    controllerCode: -1073442813 },
  'rws2/404-signal-haljson':                   { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073445866 },
  'rws2/404-file-haljson':                     { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073438713 },
  // A RAPID start from a RobotWare 8 station that has not declared motion
  // control (SYS_CTRL_E_NOT_ALLOWED_TO_MOVE_ROBOT), captured 2026-10-18 on
  // RW 8.2.1+1023. It was unmapped (UNKNOWN) until then.
  'rws2/403-exec-start-motion-control-off-xhtml': { code: 'GRANT_DENIED',    controllerCode: -1073435864 },
  // RW8 Control Station Service, captured 2026-09-15 on RW8.1.1+614. All the
  // write-access refusals are the RW8 spelling of "acquire mastership first"
  // and must not read as UAS/RMMP permission problems.
  'rws2/403-writeaccess-held-by-other-station-haljson': { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073435870 },
  'rws2/403-writeaccess-not-held-haljson':              { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073435873 },
  'rws2/403-session-not-registered-haljson':            { code: 'MASTERSHIP_REQUIRED', controllerCode: -1073435871 },
  'rws2/403-station-already-registered-haljson':        { code: 'UNKNOWN',             controllerCode: -1073435874 },
  'rws2/400-station-id-not-braced-haljson':             { code: 'INVALID_ARGUMENT',    controllerCode: -1073435867 },
  // Two HTTP 500s that carry a real diagnosis. A start refused because MOTION
  // mastership is held (by anyone, the caller included) and the RW8.1.x RMMP
  // service, which the controller itself files as "not supported in this
  // version". Captured 2026-09-15 on RW7.21 and RW8.1.1.
  'rws2/500-exec-start-motion-mastership-held-haljson': { code: 'MASTERSHIP_REQUIRED',   controllerCode: -1073445844 },
  'rws2/500-rmmp-service-not-supported-haljson':        { code: 'UNSUPPORTED_OPERATION', controllerCode: -1073445885 },
  // A bad volume answers 400 on RWS 2.0 and 404 on RWS 1.0, so the same
  // listDirectory call reported RESOURCE_NOT_FOUND on RW6 and UNKNOWN on
  // RW7/RW8 until this code was mapped.
  'rws2/400-bad-volume-haljson':               { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073438716 },
  'rws2/400-bad-volume-xhtml':                 { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073438716 },
  // Same controller code as rws1/400-unload-unknown-module: one meaning
  // (SYS_CTRL_E_NO_SUCH_SYMBOL, the RAPID symbol was not found), asked here for
  // a data symbol instead of a module. Pinning both proves the number alone is
  // not classified on.
  'rws2/404-symbol-not-found-haljson':         { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073442816 },
  // A UAS-gated resource. Without this code mapped a 403 fell to UNKNOWN,
  // because the HTTP fallback only promotes 404.
  'rws2/403-uas-not-allowed-haljson':          { code: 'GRANT_DENIED',        controllerCode: -1073445867 },
  // A RAPID value write too large for one request (SYS_CTRL_E_BUFFER_OVERFLOW),
  // captured 2026-09-29 on RW 7.21.4 writing a num array value (the probe's
  // zz_a10k array): a write of 7900 num elements fails this way, 7800
  // succeeds, and RW 8.2.1 answers the same. It was unmapped (UNKNOWN) until then.
  'rws2/500-symbol-write-buffer-overflow-xhtml': { code: 'INVALID_ARGUMENT',  controllerCode: -1073445865 },
};

describe('classifyControllerError - fixture-driven (live-captured payloads)', () => {
  const fixtures = loadFixtures();

  it('has a fixture for every expectation and vice versa', () => {
    const names = fixtures.map(f => `${f.protocol}/${f.scenario}`).sort();
    expect(names).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [key, want] of Object.entries(EXPECTED)) {
    it(`${key} → ${want.code} (${want.controllerCode})`, () => {
      const f = fixtures.find(x => `${x.protocol}/${x.scenario}` === key)!;
      expect(f, `fixture ${key} missing`).toBeDefined();
      const info = classifyControllerError({
        httpStatus: f.response.status,
        body: f.response.body,
        method: f.request.method,
        path: f.request.path,
      });
      expect(info.code).toBe(want.code);
      expect(info.controllerCode).toBe(want.controllerCode);
      expect(info.controllerMsg ?? '').not.toContain('BUILDAGENTS');   // path noise stripped
      expect(info.message).toContain(f.request.path.split('?')[0]);    // says WHAT failed
      // Compatibility: downstream code (RobotManager mkdir recovery, the VS
      // Code extension's hint branches) matches on "HTTP <status>" in messages
      expect(info.message).toContain(`HTTP ${f.response.status}`);
    });
  }

  it('never blames credentials for a 403', () => {
    for (const f of fixtures.filter(x => x.response.status === 403)) {
      const info = classifyControllerError({
        httpStatus: f.response.status, body: f.response.body,
        method: f.request.method, path: f.request.path,
      });
      expect(info.message.toLowerCase()).not.toContain('username');
      expect(info.message.toLowerCase()).not.toContain('password');
    }
  });

  it('gives actionable guidance for the permission family', () => {
    // Until 1.4.0 this asserted RMMP or UAS advice for a refused signal write.
    // That advice was wrong: RMMP is a manual-mode privilege of RobotWare 6/7
    // only, and ABB names the controller's safety access restriction for this
    // code; a common cause is the signal's access level, which the integrator
    // owns. The refusal now says so and never advises RMMP here.
    const rejected = fixtures.find(x => x.scenario === '403-signal-write-no-rmmp-json')!;
    const info = classifyControllerError({
      httpStatus: rejected.response.status, body: rejected.response.body,
      method: rejected.request.method, path: rejected.request.path,
    });
    expect(info.message).toMatch(/access level/);
    expect(info.message).not.toMatch(/RMMP/);
    expect(info.refusal).toMatchObject({ kind: 'access-restricted', grantor: 'integrator' });

    const held = fixtures.find(x => x.scenario === '403-mastership-held-json')!;
    const heldInfo = classifyControllerError({
      httpStatus: held.response.status, body: held.response.body,
      method: held.request.method, path: held.request.path,
    });
    expect(heldInfo.message.toLowerCase()).toContain('mastership');
  });
});

describe('parseControllerStatus', () => {
  it('reads the RWS 1.0 ?json=1 shape (_embedded.status)', () => {
    const r = parseControllerStatus('{"_embedded":{"status":{"code":-42,"msg":"x.cpp[1] Boom code:-42 icode:-1"}}}');
    expect(r.code).toBe(-42);
    expect(r.msg).toContain('Boom');
  });

  it('reads the RWS 2.0 hal+json shape (top-level status)', () => {
    const r = parseControllerStatus('{"status":{"code":-7,"msg":"y.cpp[2] Nope code:-7 icode:-1"}}');
    expect(r.code).toBe(-7);
  });

  it('reads the XHTML status div shape', () => {
    const r = parseControllerStatus('<html><body><div class="status"><span class="code">-9</span><span class="msg">z.cpp[3] Denied</span></div></body></html>');
    expect(r.code).toBe(-9);
    expect(r.msg).toContain('Denied');
  });

  it('returns nulls for unparseable bodies', () => {
    const r = parseControllerStatus('<html>totally unrelated</html>');
    expect(r.code).toBeNull();
    expect(r.msg).toBeNull();
  });
});

describe('classifyControllerError - fallbacks', () => {
  it('maps a bare 404 with no parseable body by path: modules → MODULE_NOT_FOUND', () => {
    const info = classifyControllerError({
      httpStatus: 404, body: '', method: 'GET', path: '/rw/rapid/tasks/T_ROB1/modules/Foo',
    });
    expect(info.code).toBe('MODULE_NOT_FOUND');
  });

  it('maps a bare 404 elsewhere to RESOURCE_NOT_FOUND', () => {
    const info = classifyControllerError({
      httpStatus: 404, body: '', method: 'GET', path: '/rw/iosystem/signals/x',
    });
    expect(info.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('keeps the provided fallback for unclassifiable statuses', () => {
    const info = classifyControllerError({
      httpStatus: 500, body: 'garbage', method: 'POST', path: '/x', fallback: 'CONTROLLER_BUSY',
    });
    expect(info.code).toBe('CONTROLLER_BUSY');
    expect(info.controllerCode).toBeNull();
  });
});

describe('decodeElogArgs', () => {
  it('reads the hal+json argv array kept as a string by the parser', () => {
    expect(decodeElogArgs({
      argc: '2',
      argv: '[{"type":"long","value":100},{"type":"string","value":"Default User"}]',
    })).toEqual([
      { type: 'long', value: '100' },
      { type: 'string', value: 'Default User' },
    ]);
  });

  it('reads an argv array handed over already parsed (RWS 1.0 ?json=1)', () => {
    expect(decodeElogArgs({
      argc: '1',
      argv: [{ type: 'float', value: 1.5 }],
    })).toEqual([{ type: 'float', value: '1.5' }]);
  });

  it('falls back to the arg1..argN span form', () => {
    expect(decodeElogArgs({ argc: '2', arg1: 'SYS', arg2: 'Default User' }))
      .toEqual([{ type: '', value: 'SYS' }, { type: '', value: 'Default User' }]);
  });

  it('returns an empty array when there are no arguments', () => {
    expect(decodeElogArgs({ argc: '0' })).toEqual([]);
    expect(decodeElogArgs({})).toEqual([]);
  });
});

describe('SYS_CTRL_E_BUFFER_OVERFLOW (-1073445865)', () => {
  it('says the request was too large and keeps the phrase callers match on', () => {
    const f = loadFixtures().find(x => x.scenario === '500-symbol-write-buffer-overflow-xhtml')!;
    const info = classifyControllerError({
      httpStatus: f.response.status, body: f.response.body, method: f.request.method, path: f.request.path,
    });
    expect(info.message).toMatch(/^Too much data for one RWS request \(SYS_CTRL_E_BUFFER_OVERFLOW\): HTTP 500 from POST \/rw\/rapid\/symbol\/RAPID\/T_ROB1\/ZZ_PROBE\/zz_a10k\/data/);
    expect(info.refusal).toBeUndefined();
  });

  // RW 6.16.03 (2026-10-03): a RAPID array read too large for one answer is
  // HTTP 400 with RobotWare 6's generic -1073414146, the same status and code
  // as a missing symbol; only the message tells them apart. The message is the
  // part the client parsed from the live answer (the build path before it is
  // left out).
  const rw6Status = (msg: string): string =>
    `<html><body><div class="status"><span class="code">-1073414146</span><span class="msg">${msg}</span></div></body></html>`;
  const rw6Read = '/rw/rapid/symbol/data/RAPID/T_ROB1/ZZ_PROBE_RDBIG/zz_probe_rdbig_num_over';

  it('types an RWS 1.0 read too large for one answer as INVALID_ARGUMENT, not a missing resource', () => {
    const info = classifyControllerError({
      httpStatus: 400, method: 'GET', path: rw6Read,
      body: rw6Status('Buffer not enough to hold data code:-1073414146 icode:-1'),
    });
    expect(info.code).toBe('INVALID_ARGUMENT');
    expect(info.controllerCode).toBe(-1073414146);
    expect(info.message).toMatch(/^Too much data for one RWS request/);
    expect(info.message).toContain('HTTP 400 from GET /rw/rapid/symbol/data/');
  });

  it('keeps a missing RWS 1.0 symbol (same status, same code) as RESOURCE_NOT_FOUND', () => {
    const info = classifyControllerError({
      httpStatus: 400, method: 'GET', path: rw6Read,
      body: rw6Status('Symbol not found code:-1073414146 icode:-1'),
    });
    expect(info.code).toBe('RESOURCE_NOT_FOUND');
    expect(info.message).toMatch(/^Resource does not exist on the controller/);
  });

  it('codeForControllerCode maps it for answers that carry the code outside a status block', () => {
    expect(codeForControllerCode(-1073445865)).toBe('INVALID_ARGUMENT');
    expect(codeForControllerCode(-1073442816)).toBe('RESOURCE_NOT_FOUND');
    expect(codeForControllerCode(-1)).toBeNull();
  });
});
