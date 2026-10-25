import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyControllerError, codeForControllerCode } from '../src/ControllerError.js';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RobotManager } from '../src/RobotManager.js';
import { RwsError } from '../src/types.js';

/**
 * Three controller codes the functional runs of 2026-09-30 met typed
 * UNKNOWN, now typed from ABB's return-code list and the recorded answers:
 *
 * - -1073442803 SYS_CTRL_E_RAPID_SYNTAX_ERROR: RW 7.21.4 loads a module
 *   with a syntax error (loadmod 200) and refuses the program pointer move to
 *   one of its routines with 400, "Syntax error", icode -520.
 * - -1073442802 SYS_CTRL_E_RAPID_SEMANTIC_ERROR, "org_code: -519": a value of
 *   the wrong type written to a RAPID symbol, 400 on RW 6.16.03, 7.21.4 and
 *   8.2.1; the symbol keeps its value.
 * - -1073438712 SYS_CTRL_E_DIR_EXIST: a directory create whose name is taken,
 *   409 on RW 7.21.4 and 8.2.1, 400 on RW 6.16.03.
 *
 * The RWS 2.0 bodies are the ones recorded, up to and including the message;
 * the closing tags after it are rebuilt. The recording of the two RW 6.16.03
 * bodies stops inside the controller's build path, so their message is the
 * text the client kept from it (build path already stripped).
 */

const x2 = (base: string, code: number, msg: string, spaced = false): string => spaced
  ? `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <base href="${base}"/> </head> <body> <div class="status"> <span class="code">${code}</span> <span class="msg">${msg}</span> </div> </body> </html>`
  : `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="${base}"/></head><body><div class="status"><span class="code">${code}</span><span class="msg">${msg}</span></div></body></html>`;

const PP_SYNTAX_RW7 = x2('https://127.0.0.1:5466/', -1073442803, 'rws_resource_rapid_task_pcp.cpp[1180] Syntax error code:-1073442803 icode:-520');
const WRONG_TYPE_RW7 = x2('https://127.0.0.1:5466/rw/rapid/', -1073442802, 'ERROR: da_rapid_symbol.cpp[424]: org_code: -519 new_code: 0xc004900e; ');
const WRONG_TYPE_RW8 = x2('https://127.0.0.1:80/rw/rapid/', -1073442802, 'ERROR: da_rapid_symbol.cpp[384]: org_code: -519 new_code: 0xc004900e; ');
const WRONG_TYPE_RW6 = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rw</title><base href="http://127.0.0.1:56791/rw/rapid/"/></head>'
  + '<body><div class="status"><span class="code">-1073442802</span><span class="msg">ERROR: org_code: -519 new_code: 0xc004900e; </span></div></body></html>';
const DIR_EXISTS_RW7 = x2('https://127.0.0.1:5466/', -1073438712, 'rapi_file_resource.cpp[527] Given directory name directory is already exist -1073438712 400', true);
const DIR_EXISTS_RW8 = x2('https://127.0.0.1:80/', -1073438712, 'rapi_file_resource.cpp[538] Given directory name directory is already exist -1073438712 400', true);
const DIR_EXISTS_RW6 = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <title>Error</title> <base href="http://127.0.0.1:56791/" /> </head> <body> '
  + '<div class="status"> <span class="code">-1073438712</span> <span class="msg">Given directory name directory is already exist -1073438712 -1</span> </div> </body> </html>';

const SYMBOL_RWS2 = '/rw/rapid/symbol/RAPID/T_ROB1/ZZ_PROBE_RD/zz_probe_rd_varr/data';
const SYMBOL_RWS1 = '/rw/rapid/symbol/data/RAPID/T_ROB1/ZZ_PROBE_RD/zz_probe_rd_varr?action=set';

describe('-1073442803 SYS_CTRL_E_RAPID_SYNTAX_ERROR (a program pointer move, RW 7.21.4)', () => {
  it('is WRONG_MODE with a wrong-state refusal that says the program has syntax errors', () => {
    const info = classifyControllerError({
      httpStatus: 400, body: PP_SYNTAX_RW7, method: 'POST', path: '/rw/rapid/tasks/T_ROB1/pcp/routine', context: { generation: 'rw7' },
    });
    expect(info.code).toBe('WRONG_MODE');
    expect(info.controllerCode).toBe(-1073442803);
    expect(info.controllerMsg).toBe('Syntax error code:-1073442803 icode:-520');
    expect(info.refusal).toMatchObject({
      kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool', evidence: 'vc',
      controller: { code: -1073442803, name: 'SYS_CTRL_E_RAPID_SYNTAX_ERROR', icode: -520, http: 400 },
    });
    expect(info.message).toMatch(/refused to move the program pointer: the loaded RAPID program has syntax errors/);
    expect(info.message).toContain('HTTP 400 from POST /rw/rapid/tasks/T_ROB1/pcp/routine');
    expect(info.message).not.toMatch(/grant|RMMP/i);
  });
});

describe('-1073442802 SYS_CTRL_E_RAPID_SEMANTIC_ERROR (a wrong-typed value write, org_code -519)', () => {
  for (const [label, body, path, generation] of [
    ['RW 7.21.4', WRONG_TYPE_RW7, SYMBOL_RWS2, 'rw7'],
    ['RW 8.2.1', WRONG_TYPE_RW8, SYMBOL_RWS2, 'rw8'],
    ['RW 6.16.03', WRONG_TYPE_RW6, SYMBOL_RWS1, 'rw6'],
  ] as const) {
    it(`${label}: INVALID_ARGUMENT, the value does not fit the symbol's data type`, () => {
      const info = classifyControllerError({ httpStatus: 400, body, method: 'POST', path, context: { generation } });
      expect(info.code).toBe('INVALID_ARGUMENT');
      expect(info.controllerCode).toBe(-1073442802);
      expect(info.controllerMsg).toBe('org_code: -519 new_code: 0xc004900e;');
      expect(info.refusal).toMatchObject({
        kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool', evidence: 'vc',
        controller: { name: 'SYS_CTRL_E_RAPID_SEMANTIC_ERROR' },
      });
      expect(info.message).toMatch(/refused to change a RAPID variable: the value does not fit the symbol's data type/);
      expect(info.message).toContain(`HTTP 400 from POST ${path.split('?')[0]}`);
    });
  }
});

describe('-1073438712 SYS_CTRL_E_DIR_EXIST (a directory create whose name is taken)', () => {
  for (const [label, status, body, path] of [
    ['RW 7.21.4', 409, DIR_EXISTS_RW7, '/fileservice/HOME/create'],
    ['RW 8.2.1', 409, DIR_EXISTS_RW8, '/fileservice/HOME/create'],
    ['RW 6.16.03', 400, DIR_EXISTS_RW6, '/fileservice/$HOME'],
  ] as const) {
    it(`${label} (HTTP ${status}): INVALID_ARGUMENT, "already exists", no refusal`, () => {
      const info = classifyControllerError({ httpStatus: status, body, method: 'POST', path });
      expect(info.code).toBe('INVALID_ARGUMENT');
      expect(info.controllerCode).toBe(-1073438712);
      expect(info.refusal).toBeUndefined();
      expect(info.message).toMatch(new RegExp(`^Directory already exists on the controller \\(SYS_CTRL_E_DIR_EXIST\\): HTTP ${status} from POST `));
      expect(info.message).toContain(path);
      // RobotManager's mkdir -p treats an existing directory as done by this phrase.
      expect(info.message).toMatch(/already exists/);
    });
  }

  it('codeForControllerCode maps it for answers that carry the code outside a status block', () => {
    expect(codeForControllerCode(-1073438712)).toBe('INVALID_ARGUMENT');
  });

  it('RobotManager.createDirectory (mkdir -p) walks past a parent that exists on RobotWare 6 (400, not 409)', async () => {
    // $HOME/a exists, $HOME/a/b does not: the create in $HOME/a/b answers 404,
    // the walk then meets RW 6.16.03's 400 -1073438712 for $HOME/a, which it
    // used to throw (it matched only "already exists" or 409).
    const existing = new Set(['$HOME/a']);
    const created: string[] = [];
    const fail = (status: number, body: string, path: string): RwsError => {
      const info = classifyControllerError({ httpStatus: status, body, method: 'POST', path });
      return new RwsError(info.message, info.code, status, body, info.controllerCode ?? undefined, info.controllerMsg ?? undefined);
    };
    const adapter = {
      createDirectory: async (parent: string, dir: string): Promise<void> => {
        const full = `${parent}/${dir}`;
        if (existing.has(full)) { throw fail(400, DIR_EXISTS_RW6, `/fileservice/${parent}`); }
        if (parent !== '$HOME' && !existing.has(parent)) {
          throw new RwsError(`Resource does not exist on the controller: HTTP 404 from POST /fileservice/${parent}`, 'RESOURCE_NOT_FOUND', 404);
        }
        existing.add(full);
        created.push(full);
      },
    };
    const mgr = new RobotManager();
    (mgr as unknown as { adapter: unknown }).adapter = adapter;
    await mgr.createDirectory('$HOME/a/b', 'c');
    expect(created).toEqual(['$HOME/a/b', '$HOME/a/b/c']);
  });

  it('RwsClient2.createDirectory on a taken name throws it typed (the recorded RW 7.21.4 409)', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(409, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end(DIR_EXISTS_RW7);
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const c = new RwsClient2(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'u', 'p');
      const err = await c.createDirectory('HOME', 'ZZ_PROBE_FILES').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect(err).toMatchObject({ code: 'INVALID_ARGUMENT', httpStatus: 409, controllerCode: -1073438712 });
      expect((err as RwsError).message).toMatch(/already exists/);
    } finally { server.close(); }
  });
});
