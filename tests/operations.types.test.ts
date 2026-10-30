import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * RobotManager.call is typed from the generated routes (1.6.0). vitest does
 * not type-check, so this compiles tests/fixtures/call-types.ts against src
 * with the package's own compiler options, as compat140.types.test.ts does,
 * and expects no error: its `@ts-expect-error` lines fail the compile when a
 * wrong call is accepted.
 */

describe('RobotManager.call types', () => {
  it('tests/fixtures/call-types.ts has no type error', async () => {
    const ts = (await import('typescript')).default;
    const configPath = path.resolve('tsconfig.json');
    const config = ts.readConfigFile(configPath, f => ts.sys.readFile(f));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    const fixture = path.resolve('tests/fixtures/call-types.ts');
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
});
