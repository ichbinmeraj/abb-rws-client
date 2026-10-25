import { describe, it, expect } from 'vitest';
import { detectEnvironment, environmentNotes, isWsl, WSL_NOTE } from '../../src/discovery/environment.js';

const none = (): boolean => false;

describe('discovery environment: WSL detection', () => {
  it('is WSL on Linux when WSL_DISTRO_NAME is set', () => {
    expect(isWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, exists: none })).toBe(true);
  });

  it('is WSL on Linux when the WSL interop registration exists', () => {
    const seen: string[] = [];
    const exists = (p: string): boolean => { seen.push(p); return p === '/proc/sys/fs/binfmt_misc/WSLInterop'; };
    expect(isWsl({ platform: 'linux', env: {}, exists })).toBe(true);
    expect(seen[0]).toBe('/proc/sys/fs/binfmt_misc/WSLInterop');
  });

  it('also accepts the WSLInterop-late registration of newer WSL releases', () => {
    const exists = (p: string): boolean => p.endsWith('WSLInterop-late');
    expect(isWsl({ platform: 'linux', env: {}, exists })).toBe(true);
  });

  it('is not WSL on plain Linux', () => {
    expect(isWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: '  ' }, exists: none })).toBe(false);
  });

  it('a throwing file check counts as missing', () => {
    const exists = (): boolean => { throw new Error('EACCES'); };
    expect(isWsl({ platform: 'linux', env: {}, exists })).toBe(false);
  });

  it('is never WSL off Linux, and then reads no file', () => {
    let reads = 0;
    const exists = (): boolean => { reads++; return true; };
    for (const platform of ['win32', 'darwin'] as const) {
      expect(isWsl({ platform, env: { WSL_DISTRO_NAME: 'Ubuntu' }, exists })).toBe(false);
    }
    expect(reads).toBe(0);
  });

  it('detectEnvironment and environmentNotes carry the WSL hint', () => {
    const env = detectEnvironment({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Debian' }, exists: none });
    expect(env).toEqual({ wsl: true });
    expect(environmentNotes(env)).toEqual([WSL_NOTE]);
    expect(WSL_NOTE).toMatch(/^Running inside WSL: RobotStudio VCs on Windows may not be visible from here\./);
    expect(environmentNotes({ wsl: false })).toEqual([]);
  });
});
