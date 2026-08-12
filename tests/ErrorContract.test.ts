import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RobotManager } from '../src/RobotManager.js';
import { MultiRobotManager } from '../src/MultiRobotManager.js';
import { RwsError } from '../src/types.js';

/**
 * Every public method throws RwsError with a typed `code`. That rule existed
 * from the start, but roughly a hundred call sites threw a plain Error, so
 * `catch (e) { if (e.code === ...) }` quietly matched nothing on those paths.
 */
describe('typed-error contract', () => {
  it('no source file throws a plain Error on a public path', () => {
    const dir = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      // MdnsDiscovery's throws are packet-parse guards inside its own
      // try/catch - they never surface to a caller.
      if (file === 'MdnsDiscovery.ts') { continue; }
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.includes('throw new Error(')) { offenders.push(`${file}:${i + 1}`); }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('RobotManager rejects with NOT_CONNECTED before connect', async () => {
    const m = new RobotManager();
    await expect(m.refreshIoSignals()).rejects.toBeInstanceOf(RwsError);
    await m.refreshIoSignals().catch((e: RwsError) => {
      expect(e.code).toBe('NOT_CONNECTED');
    });
  });

  it('MultiRobotManager reports no active robot as NOT_CONNECTED', async () => {
    const multi = new MultiRobotManager();
    expect(multi.active).toBeFalsy();
    await expect(multi.listDirectory('HOME')).rejects.toBeInstanceOf(RwsError);
    await multi.listDirectory('HOME').catch((e: RwsError) => {
      expect(e.code).toBe('NOT_CONNECTED');
    });
  });
});
