import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyControllerError } from '../src/ControllerError.js';
import {
  CFG_REFUSAL_CODES, explainRefusal, hexCode, innerCodeOf, refusalFor, REFUSAL_CODES, SYS_CTRL_E_FAIL,
  type ControllerAnswer,
} from '../src/refusal.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError, type RefusalContext, type RwsRefusal } from '../src/types.js';

/**
 * A configuration file the controller refuses to load. A load with `add` of
 * a domain the same controller had just saved was refused on the three
 * virtual controllers (2026-10-12): RobotWare 7.21.4 and 8.2.1 answered
 * `POST /rw/cfg/load` 400 -1073437689 (SYS_CTRL_E_CFG_NAME_EXIST, "Name
 * already exists in database (for named instances)") for an MMC and an EIO
 * file; RobotWare 6.16.03 answered `POST /rw/cfg?action=load` 400 with
 * -1073437689 for the MMC file and -1073437688
 * (SYS_CTRL_E_CFG_DATA_INCORRECT, "Cfg file contains errors.") for the EIO
 * file, both with "org_code: 3500 new_code: 0xc0048410" in the message,
 * which names a held resource. The client logged the code and the message,
 * not the bodies; the bodies below put them in each generation's error
 * shape (tests/fixtures/errors). Which outer code RobotWare 6.16.03 sent was
 * not kept, so both are covered: the configuration code itself, and the
 * generic -1073414146 with the code in the message. Before 1.5.0 these were
 * `UNKNOWN` errors.
 */

const NAME_EXIST = -1073437689;
const DATA_INCORRECT = -1073437688;

/** An RWS 2.0 hal+json error body (the shape of tests/fixtures/errors/rws2). */
const halError = (code: number, msg: string): string =>
  `{ "_links":{ "base": { "href": "https://127.0.0.1:5466/" } } ,"status" : {"code":${code}, "msg":"${msg}"}}`;

/** An RWS 1.0 `?json=1` error body (the shape of tests/fixtures/errors/rws1). */
const rws1Error = (code: number, msg: string): string =>
  `{"_links":{"base": { "href": "http://127.0.0.1:42179/" }},"_embedded" :{ "status" : {"code":${code}, "msg": ${JSON.stringify(msg)}}, "_state":[  ] }}`;

/** RobotWare 6's message, with the build path the controller puts in front (stripped by the client). */
const rw6Msg = (code: number): string =>
  `C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rws_cfg\\rws_component_cfg.cpp[512]: org_code: 3500 new_code: 0xc0048410;  code:${code} icode:-1`;

function classify(status: number, body: string, method: string, path: string, context: RefusalContext = {}) {
  return classifyControllerError({ httpStatus: status, body, method, path, context });
}

/** A remedy a consumer can show: one line under 1000 characters, no call, a known actor and evidence. */
function expectPlainRemedy(r: RwsRefusal): void {
  expect(r.remedy).toBeDefined();
  for (const x of [r.remedy!, ...(r.otherRemedies ?? [])]) {
    expect(x.kind).toBe('fix-input');
    expect(x.byWhom).toBe('person-at-this-tool');
    expect(x.call).toBeUndefined();
    expect(['abb', 'vc', 'field', 'unverified']).toContain(x.evidence);
    for (const s of [x.label, x.detail, x.basis]) {
      expect(s).not.toMatch(/[\r\n]/);
      expect(s.length).toBeLessThan(1000);
    }
    expect(x.appliesTo.operation).toBe(r.controller.request);
  }
}

describe('the configuration codes', () => {
  it('carry ABB\'s names and INVALID_ARGUMENT, apart from the access codes', () => {
    expect(CFG_REFUSAL_CODES.get(NAME_EXIST)).toEqual({ name: 'SYS_CTRL_E_CFG_NAME_EXIST', code: 'INVALID_ARGUMENT' });
    expect(CFG_REFUSAL_CODES.get(DATA_INCORRECT)).toEqual({ name: 'SYS_CTRL_E_CFG_DATA_INCORRECT', code: 'INVALID_ARGUMENT' });
    expect(REFUSAL_CODES.has(NAME_EXIST)).toBe(false);
    expect(REFUSAL_CODES.has(DATA_INCORRECT)).toBe(false);
    expect(hexCode(NAME_EXIST)).toBe('0xC004A407');
    expect(hexCode(DATA_INCORRECT)).toBe('0xC004A408');
  });
});

describe('a load refused because a named instance already exists', () => {
  it('RobotWare 7.21.4 and 8.2.1: POST /rw/cfg/load 400 -1073437689 is INVALID_ARGUMENT with a refusal', () => {
    for (const generation of ['rw7', 'rw8'] as const) {
      const info = classify(400, halError(NAME_EXIST, 'rws_resource_cfg.cpp[1310] code:-1073437689 icode:-1'), 'POST', '/rw/cfg/load', { generation });
      expect(info.code).toBe('INVALID_ARGUMENT');
      expect(info.controllerCode).toBe(NAME_EXIST);
      expect(info.controllerMsg).toBe('code:-1073437689 icode:-1');
      const r = info.refusal!;
      expect(r).toMatchObject({ kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool', generation, evidence: 'vc' });
      expect(r.controller).toMatchObject({ request: 'POST /rw/cfg/load', http: 400, code: NAME_EXIST, hex: '0xC004A407', name: 'SYS_CTRL_E_CFG_NAME_EXIST' });
      expect(r.sentence).toBe(
        'The controller refused to load the configuration file: a named instance in the file already exists on the controller '
        + '(ABB: "Name already exists in database (for named instances)"). The controller does not say which one. '
        + 'A domain saved from this controller holds every instance of that domain, so loading it back with add is refused.');
      expect(info.message).toContain('Controller: HTTP 400 from POST /rw/cfg/load, code -1073437689 (0xC004A407, SYS_CTRL_E_CFG_NAME_EXIST): code:-1073437689 icode:-1');
      expect(r.remedy!.detail).toMatch(/^Load a file that holds only instances the controller does not have yet, or remove the existing instance first/);
      expect(r.remedy!.evidence).toBe('unverified');
      expectPlainRemedy(r);
      expect(info.message).not.toMatch(/RMMP|mastership|write access/i);
    }
  });

  it('RobotWare 6.16.03: POST /rw/cfg?action=load, with the wrapper that names a held resource', () => {
    const info = classify(400, rws1Error(NAME_EXIST, rw6Msg(NAME_EXIST)), 'POST', '/rw/cfg?action=load&json=1', { generation: 'rw6' });
    expect(info.code).toBe('INVALID_ARGUMENT');
    expect(info.controllerCode).toBe(NAME_EXIST);
    expect(info.controllerMsg).toBe('org_code: 3500 new_code: 0xc0048410; code:-1073437689 icode:-1');
    const r = info.refusal!;
    expect(r.kind).toBe('invalid-argument');
    expect(r.controller.request).toBe('POST /rw/cfg');
    expect(r.sentence).toMatch(/^The controller refused to load the configuration file: a named instance in the file already exists/);
    expect(r.sentence).toMatch(/The new_code 0xC0048410 in the message names a held resource; RobotWare 6 puts it in this answer, and it is not the cause\.$/);
    expect(r.sentence).not.toMatch(/already holds/);
    expectPlainRemedy(r);
  });

  it('wrapped under RobotWare 6\'s generic code, the code: annotation wins over the hex new_code', () => {
    const msg = 'org_code: 3500 new_code: 0xc0048410; code:-1073437689 icode:-1';
    expect(innerCodeOf(msg)).toBe(NAME_EXIST);
    const info = classify(400, rws1Error(SYS_CTRL_E_FAIL, msg), 'POST', '/rw/cfg?action=load&json=1', { generation: 'rw6' });
    expect(info.code).toBe('INVALID_ARGUMENT');
    expect(info.refusal?.kind).toBe('invalid-argument');
    expect(info.refusal?.sentence).not.toMatch(/already holds/);
    expect(info.message).toContain('code -1073414146 (0xC004FFFE, SYS_CTRL_E_FAIL), inner code -1073437689 (0xC004A407, SYS_CTRL_E_CFG_NAME_EXIST)');
  });

  it('a validation (the load\'s dry run) is named as one', () => {
    const r = refusalFor({ http: 400, code: NAME_EXIST, msg: 'code:-1073437689 icode:-1', method: 'POST', path: '/rw/cfg/validate' }, { generation: 'rw7' });
    expect(r?.refusal.sentence).toMatch(/^The controller refused to validate the configuration file: a named instance/);
    const r1 = refusalFor({ http: 400, code: NAME_EXIST, msg: null, method: 'POST', path: '/rw/cfg?action=validate&json=1' }, { generation: 'rw6' });
    expect(r1?.refusal.sentence).toMatch(/refused to validate the configuration file/);
  });

  it('outside a file load it is the instance name that is taken', () => {
    const info = classify(400, halError(NAME_EXIST, 'code:-1073437689 icode:-1'), 'POST', '/rw/cfg/EIO/EIO_SIGNAL/instances/create-default', { generation: 'rw8', robot: 'IRB_1300' });
    expect(info.code).toBe('INVALID_ARGUMENT');
    const r = info.refusal!;
    expect(r).toMatchObject({ kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool', evidence: 'abb' });
    expect(r.sentence).toBe(
      'Controller \'IRB_1300\' refused to change system parameters: an instance of that name already exists '
      + '(ABB: "Name already exists in database (for named instances)"). Use a name no instance of that type has, or change the existing instance instead.');
    expectPlainRemedy(r);
  });
});

describe('a load refused because the file contains errors', () => {
  it('RobotWare 6.16.03, EIO: -1073437688 is INVALID_ARGUMENT, and says what RobotWare 7 and 8 answered instead', () => {
    const info = classify(400, rws1Error(DATA_INCORRECT, rw6Msg(DATA_INCORRECT)), 'POST', '/rw/cfg?action=load&json=1', { generation: 'rw6' });
    expect(info.code).toBe('INVALID_ARGUMENT');
    expect(info.controllerCode).toBe(DATA_INCORRECT);
    const r = info.refusal!;
    expect(r).toMatchObject({ kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool', evidence: 'vc' });
    expect(r.controller).toMatchObject({ code: DATA_INCORRECT, hex: '0xC004A408', name: 'SYS_CTRL_E_CFG_DATA_INCORRECT' });
    expect(r.sentence).toBe(
      'The controller refused to load the configuration file: it says the file contains errors (ABB: "Cfg file contains errors."), '
      + 'and does not say which line. On RobotWare 6.16.03 a domain saved from the same controller and loaded back with add got this answer, '
      + 'where RobotWare 7.21.4 and 8.2.1 answered that a named instance already exists. '
      + 'The new_code 0xC0048410 in the message names a held resource; RobotWare 6 puts it in this answer, and it is not the cause.');
    expect(r.remedy!.detail).toBe('Check the file. If it is a domain saved from this controller, load a file that holds only instances the controller does not have yet. Then load it again.');
    expectPlainRemedy(r);
    expect(info.message).not.toMatch(/RMMP/);
  });

  it('on RobotWare 7 or 8 the RobotWare 6 observation is left out', () => {
    for (const generation of ['rw7', 'rw8'] as const) {
      const r = refusalFor({ http: 400, code: DATA_INCORRECT, msg: 'code:-1073437688 icode:-1', method: 'POST', path: '/rw/cfg/load' }, { generation });
      expect(r?.code).toBe('INVALID_ARGUMENT');
      expect(r?.refusal.sentence).toBe('The controller refused to load the configuration file: it says the file contains errors (ABB: "Cfg file contains errors."), and does not say which line.');
    }
  });

  it('outside a file load it is the configuration data that is refused', () => {
    const r = refusalFor({ http: 400, code: DATA_INCORRECT, msg: null, method: 'POST', path: '/rw/cfg/MOC/ARM/instances/rob1_1' }, { generation: 'rw7' });
    expect(r?.refusal.sentence).toBe('The controller refused to change system parameters: it says the configuration data contains errors (ABB: "Cfg file contains errors.").');
    expectPlainRemedy(r!.refusal);
  });
});

describe('through the client', () => {
  it('RWS1Adapter.loadCfgFile throws the refusal, with the controller\'s answer kept', async () => {
    const body = rws1Error(NAME_EXIST, rw6Msg(NAME_EXIST));
    const fake = {
      requestMastership: async () => {},
      releaseMastership: async () => {},
      request: async (method: string, url: string) =>
        method === 'POST' && url.startsWith('/rw/cfg?action=load') ? { status: 400, body } : { status: 204, body: '' },
    };
    const err = await new RWS1Adapter(fake as unknown as RwsClient).loadCfgFile('$TEMP/MMC.cfg', 'add').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    const e = err as RwsError;
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(e.httpStatus).toBe(400);
    expect(e.controllerCode).toBe(NAME_EXIST);
    expect(e.refusal?.kind).toBe('invalid-argument');
    expect(e.refusal?.generation).toBe('rw6');
    expect(e.message).toMatch(/^The controller refused to load the configuration file: a named instance in the file already exists/);
  });

  it('explainRefusal with the operating mode keeps it a refusal of the file, never RMMP advice', () => {
    const a: ControllerAnswer = { http: 400, code: NAME_EXIST, msg: 'code:-1073437689 icode:-1', method: 'POST', path: '/rw/cfg/load' };
    const r = refusalFor(a, { generation: 'rw7' })!;
    const err = new RwsError(r.message, r.code, 400, undefined, NAME_EXIST, a.msg ?? undefined, r.refusal);
    const out = explainRefusal(err, { opmode: 'MANR', robot: 'IRB_1300' });
    expect(out.refusal?.kind).toBe('invalid-argument');
    expect(out.refusal?.sentence).toMatch(/^Controller 'IRB_1300' refused to load the configuration file/);
    expect(out.message).not.toMatch(/RMMP/);
    expect(out.code).toBe('INVALID_ARGUMENT');
  });
});

/**
 * A file whose first line is not a version header (`ZZ_PROBE this is not a
 * configuration file`), validated on the three virtual controllers on
 * 2026-10-24 (and on 7.21.4 and 8.2.1 on 2026-10-01): 400 -1073437686
 * (SYS_CTRL_E_CFG_VERSION). RobotWare 7.21.4 and 8.2.1 answered
 * `POST /rw/cfg/validate` with the XHTML status block below (logged up to its
 * closing tags); RobotWare 6.16.03 answered `POST /rw/cfg?action=validate`
 * with code -1073437686 and a message the client kept as
 * "org_code: -26 new_code: 0xc004a40a; code:-1073437686 icode:-1". A file
 * starting `EIO:CFG_1.0:6:1::` (6.16.03) or `EIO:CFG_1.0:7:0::` (7.21.4,
 * 8.2.1) passed. Before, this was an `UNKNOWN` error with no refusal.
 */
const CFG_VERSION = -1073437686;

/** RWS 2.0's answer, as RobotWare 7.21.4 and 8.2.1 gave it. */
const rws2VersionBody = (port: number): string =>
  '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:'
  + `${port}/"/></head><body><div class="status"><span class="code">-1073437686</span>`
  + '<span class="msg">rws_resource_cfg.cpp[549] Wrong layout of version string code:-1073437686 icode:-26</span></div></body></html>';

/** RobotWare 6's message for it, with the build path the client strips. */
const RW6_VERSION_MSG = 'C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rws_cfg\\rws_resource_cfg.cpp[643]: '
  + 'org_code: -26 new_code: 0xc004a40a;  code:-1073437686 icode:-1';

describe('a file whose version header is malformed', () => {
  it('carries ABB\'s name and INVALID_ARGUMENT, as the other configuration codes do', () => {
    expect(CFG_REFUSAL_CODES.get(CFG_VERSION)).toEqual({ name: 'SYS_CTRL_E_CFG_VERSION', code: 'INVALID_ARGUMENT' });
    expect(REFUSAL_CODES.has(CFG_VERSION)).toBe(false);
    expect(hexCode(CFG_VERSION)).toBe('0xC004A40A');
  });

  it('RobotWare 7.21.4 and 8.2.1: POST /rw/cfg/validate 400 -1073437686 is INVALID_ARGUMENT with a refusal', () => {
    for (const [generation, port] of [['rw7', 5466], ['rw8', 80]] as const) {
      const info = classify(400, rws2VersionBody(port), 'POST', '/rw/cfg/validate', { generation });
      expect(info.code).toBe('INVALID_ARGUMENT');
      expect(info.controllerCode).toBe(CFG_VERSION);
      expect(info.controllerMsg).toBe('Wrong layout of version string code:-1073437686 icode:-26');
      const r = info.refusal!;
      expect(r).toMatchObject({ kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool', generation, evidence: 'vc' });
      expect(r.controller).toMatchObject({ request: 'POST /rw/cfg/validate', http: 400, code: CFG_VERSION, hex: '0xC004A40A', name: 'SYS_CTRL_E_CFG_VERSION', icode: -26 });
      expect(r.sentence).toBe(
        'The controller refused to validate the configuration file: the file\'s version header is malformed '
        + '(ABB: "Invalid cfg domain version or invalid layout of version string.").');
      expect(r.missing).toBe('a configuration file with a well-formed version header');
      expect(r.remedy!.detail).toBe(
        'Check the file\'s first line, its version header: it names the domain and the format version '
        + '(an EIO file starts EIO:CFG_1.0:7:0::, which RobotWare 7.21.4 and 8.2.1 took). Then validate it again.');
      expect(r.remedy!.evidence).toBe('vc');
      expect(r.remedy!.basis).toMatch(/^retcode -1073437686 on validations of a file with no version header/);
      expectPlainRemedy(r);
      expect(info.message).toContain('Controller: HTTP 400 from POST /rw/cfg/validate, code -1073437686 (0xC004A40A, SYS_CTRL_E_CFG_VERSION)');
      expect(info.message).not.toMatch(/RMMP|mastership|write access/i);
    }
  });

  it('RobotWare 6.16.03: POST /rw/cfg?action=validate, with RobotWare 6\'s example header', () => {
    const info = classify(400, rws1Error(CFG_VERSION, RW6_VERSION_MSG), 'POST', '/rw/cfg?action=validate&json=1', { generation: 'rw6' });
    expect(info.code).toBe('INVALID_ARGUMENT');
    expect(info.controllerCode).toBe(CFG_VERSION);
    expect(info.controllerMsg).toBe('org_code: -26 new_code: 0xc004a40a; code:-1073437686 icode:-1');
    const r = info.refusal!;
    expect(r.kind).toBe('invalid-argument');
    expect(r.controller.request).toBe('POST /rw/cfg');
    expect(r.sentence).toBe(
      'The controller refused to validate the configuration file: the file\'s version header is malformed '
      + '(ABB: "Invalid cfg domain version or invalid layout of version string.").');
    expect(r.remedy!.detail).toContain('(a RobotWare 6 EIO file starts EIO:CFG_1.0:6:1::)');
    expectPlainRemedy(r);
  });

  it('wrapped under RobotWare 6\'s generic code, the code: annotation names it', () => {
    const msg = 'org_code: -26 new_code: 0xc004a40a; code:-1073437686 icode:-1';
    expect(innerCodeOf(msg)).toBe(CFG_VERSION);
    const info = classify(400, rws1Error(SYS_CTRL_E_FAIL, msg), 'POST', '/rw/cfg?action=validate&json=1', { generation: 'rw6' });
    expect(info.code).toBe('INVALID_ARGUMENT');
    expect(info.refusal?.sentence).toMatch(/version header is malformed/);
    expect(info.message).toContain('inner code -1073437686 (0xC004A40A, SYS_CTRL_E_CFG_VERSION)');
  });

  it('a load is named as one; without a known generation the remedy gives no example header', () => {
    const r = refusalFor({ http: 400, code: CFG_VERSION, msg: 'Wrong layout of version string code:-1073437686 icode:-26', method: 'POST', path: '/rw/cfg/load' }, {});
    expect(r?.code).toBe('INVALID_ARGUMENT');
    expect(r?.refusal.sentence).toMatch(/^The controller refused to load the configuration file: the file's version header is malformed/);
    expect(r?.refusal.remedy!.detail).toBe('Check the file\'s first line, its version header: it names the domain and the format version. Then load it again.');
    expectPlainRemedy(r!.refusal);
  });

  it('outside a file load it is the configuration data that is refused', () => {
    const r = refusalFor({ http: 400, code: CFG_VERSION, msg: null, method: 'POST', path: '/rw/cfg/EIO/EIO_SIGNAL/instances/create-default' }, { generation: 'rw7' });
    expect(r?.code).toBe('INVALID_ARGUMENT');
    expect(r?.refusal).toMatchObject({ kind: 'invalid-argument', evidence: 'abb' });
    expect(r?.refusal.sentence).toBe(
      'The controller refused to change system parameters: it says a configuration version or the layout of a version string is wrong '
      + '(ABB: "Invalid cfg domain version or invalid layout of version string.").');
    expectPlainRemedy(r!.refusal);
  });

  it('through the RWS 1.0 adapter: validateCfgFile throws the refusal', async () => {
    const body = rws1Error(CFG_VERSION, RW6_VERSION_MSG);
    const fake = {
      request: async (method: string, url: string) =>
        method === 'POST' && url.startsWith('/rw/cfg?action=validate') ? { status: 400, body } : { status: 204, body: '' },
    };
    const err = await new RWS1Adapter(fake as unknown as RwsClient).validateCfgFile('$TEMP/ZZ_PROBE_BAD.cfg', 'add').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    const e = err as RwsError;
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(e.httpStatus).toBe(400);
    expect(e.controllerCode).toBe(CFG_VERSION);
    expect(e.refusal?.kind).toBe('invalid-argument');
    expect(e.refusal?.generation).toBe('rw6');
    expect(e.message).toMatch(/^The controller refused to validate the configuration file: the file's version header is malformed/);
  });

  it('through the RWS 2.0 client: validateCfgFile throws the refusal', async () => {
    let port = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/rw/cfg/validate') {
          res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
          res.end(rws2VersionBody(port));
          return;
        }
        res.writeHead(204, { 'Set-Cookie': '-http-session-=S1; path=/' });
        res.end();
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    try {
      const client = new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p', { timeout: 3000 });
      const err = await client.validateCfgFile('$TEMP/ZZ_PROBE_BAD.cfg', 'add').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      const e = err as RwsError;
      expect(e.code).toBe('INVALID_ARGUMENT');
      expect(e.httpStatus).toBe(400);
      expect(e.controllerCode).toBe(CFG_VERSION);
      expect(e.refusal?.kind).toBe('invalid-argument');
      expect(e.refusal?.controller.name).toBe('SYS_CTRL_E_CFG_VERSION');
      expect(e.message).toMatch(/refused to validate the configuration file: the file's version header is malformed/);
    } finally {
      await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
    }
  });
});
