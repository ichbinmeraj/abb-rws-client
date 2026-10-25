import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// A temporary home directory: the session file must never be the real one here.
const home = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'abb-rws-home-'));
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

// A plain (spyable) copy of fs - the builtin namespace is frozen under vitest.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual };
});

const { RobotManager } = await import('../src/RobotManager.js');

const SESSION = path.join(home, '.abb-rws-session');
const save = (host = 'vc:80', cookie = 'ABBCX=1'): void =>
  (new RobotManager() as unknown as { saveSessionCookie(h: string, c: string): void })
    .saveSessionCookie(host, cookie);

afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('~/.abb-rws-session holds live session cookies: owner-only', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(SESSION, { force: true });
  });

  it('is written in the home directory', () => {
    save();
    expect(JSON.parse(fs.readFileSync(SESSION, 'utf8'))).toEqual({ 'vc:80': 'ABBCX=1' });
  });

  it('is created with mode 0600', () => {
    const write = vi.spyOn(fs, 'writeFileSync');
    save();
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(`${SESSION}.`), expect.any(String), expect.objectContaining({ mode: 0o600 }),
    );
    if (process.platform !== 'win32') {
      expect(fs.statSync(SESSION).mode & 0o777).toBe(0o600);
    }
  });

  it('on POSIX, is chmod-ed to 0600 after every save; not on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {});
      save();
      expect(chmod).toHaveBeenCalledWith(SESSION, 0o600);

      Object.defineProperty(process, 'platform', { value: 'win32' });
      chmod.mockClear();
      save();
      expect(chmod).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it.skipIf(process.platform === 'win32')('tightens an existing world-readable file even when the rename loses', () => {
    fs.writeFileSync(SESSION, '{}');
    fs.chmodSync(SESSION, 0o644);
    // A concurrent writer wins the rename: only the chmod can fix the mode.
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EPERM'); });
    save();
    expect(fs.statSync(SESSION).mode & 0o777).toBe(0o600);
  });
});
