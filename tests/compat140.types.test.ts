import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * Code written against 1.4.0 still compiles. vitest does not type-check, so
 * this compiles tests/fixtures/compat-1.4.0.ts against src with the
 * TypeScript compiler and the package's own compiler options, and expects no
 * error in it. The fixture covers the signatures that changed after 1.4.0:
 * getCompatibility (version optional, result keeps compatible and details;
 * an IRWSAdapter of another make answering 1.4.0's { compatible, details? }),
 * registerUser's locale (optional, a string), compressPath, decompressPath
 * and saveSystemInfo (an IRWSAdapter of another make whose methods return
 * Promise<void>, one that passes an inner adapter's promise on, and callers
 * that pass the promise on as a Promise<void>), an adapter whose subscribe
 * switches exhaustively over SubscriptionResource (the 1.5.0 kinds are in
 * AnySubscriptionResource), and getRobotType's result.
 * Its `@ts-expect-error` controls fail the compile when a type is widened too
 * far.
 */

describe('1.4.0 code compiles against this source', () => {
  it('tests/fixtures/compat-1.4.0.ts has no type error', async () => {
    const ts = (await import('typescript')).default;
    const configPath = path.resolve('tsconfig.json');
    const config = ts.readConfigFile(configPath, f => ts.sys.readFile(f));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    const fixture = path.resolve('tests/fixtures/compat-1.4.0.ts');
    const options = { ...parsed.options, noEmit: true, declaration: false, declarationMap: false, sourceMap: false, rootDir: undefined };
    const program = ts.createProgram([fixture], options);
    const source = program.getSourceFile(fixture);
    expect(source, 'the fixture is part of the program').toBeDefined();
    const diagnostics = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ].map(d => {
      const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
      return `line ${where}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
    expect(diagnostics).toEqual([]);
  }, 120_000);

  it('the check can fail: a 1.4.0 adapter is refused by a type that does not take void', async () => {
    const ts = (await import('typescript')).default;
    const file = 'probe.ts';
    const text = [
      'interface Narrow { compressPath?(s: string, d: string): Promise<string | undefined>; }',
      'export class Old implements Narrow { async compressPath(_s: string, _d: string): Promise<void> {} }',
    ].join('\n');
    const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'] };
    const host = ts.createCompilerHost(options);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang, ...rest) => name === file
      ? ts.createSourceFile(name, text, lang)
      : read(name, lang, ...rest);
    const program = ts.createProgram([file], options, host);
    const errors = program.getSemanticDiagnostics(program.getSourceFile(file));
    expect(errors.length).toBeGreaterThan(0);
  }, 60_000);
});
