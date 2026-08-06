import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseControllerStatus, classifyControllerError } from '../src/ControllerError.js';
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
  'rws1/400-cfg-write-invalid-json':      { code: 'UNKNOWN',             controllerCode: -1073445879 },
  'rws1/400-cfg-write-invalid-xhtml':     { code: 'UNKNOWN',             controllerCode: -1073445879 },
  'rws1/400-jog-invalid-input-json':      { code: 'UNKNOWN',             controllerCode: -1073445879 },
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
  // A bad volume answers 400 on RWS 2.0 and 404 on RWS 1.0, so the same
  // listDirectory call reported RESOURCE_NOT_FOUND on RW6 and UNKNOWN on
  // RW7/RW8 until this code was mapped.
  'rws2/400-bad-volume-haljson':               { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073438716 },
  'rws2/400-bad-volume-xhtml':                 { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073438716 },
  // Same controller code as rws1/400-unload-unknown-module, different meaning.
  // Pinning both proves the number alone is not classified on.
  'rws2/404-symbol-overloaded-code-haljson':   { code: 'RESOURCE_NOT_FOUND',  controllerCode: -1073442816 },
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
    const rmmp = fixtures.find(x => x.scenario === '403-signal-write-no-rmmp-json')!;
    const info = classifyControllerError({
      httpStatus: rmmp.response.status, body: rmmp.response.body,
      method: rmmp.request.method, path: rmmp.request.path,
    });
    // The fix for a Rejected write is RMMP (FlexPendant approval) or a UAS grant
    expect(info.message).toMatch(/RMMP|FlexPendant|UAS/);

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
