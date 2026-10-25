/**
 * Where discovery runs: today only "inside WSL or not".
 *
 * Inside WSL the Linux listening-port sources (`/proc/net/tcp`, `ss`) list only the Linux side's
 * sockets. A Linux listener makes the scan look complete while RobotStudio virtual controllers on
 * Windows are missing, so the result carries a plain note instead of a silent empty list. With
 * WSL 2 in NAT mode 127.0.0.1 inside WSL does not reach Windows; with mirrored networking it does.
 *
 * Nothing in this file opens a socket or starts a process: it reads one environment variable and
 * checks whether one or two files exist.
 */

import * as fs from 'fs';
import type { DiscoveryEnvironment } from './types.js';

/** What `detectEnvironment` reads; tests pass fakes. */
export interface EnvironmentProbe {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Defaults to `fs.existsSync`. Must not throw; a throw counts as "missing". */
  exists?: (path: string) => boolean;
}

/**
 * Files the WSL interop handler registers. `WSLInterop` is the long-standing name; newer WSL
 * releases that start systemd register `WSLInterop-late` instead.
 */
export const WSL_INTEROP_FILES: readonly string[] = [
  '/proc/sys/fs/binfmt_misc/WSLInterop',
  '/proc/sys/fs/binfmt_misc/WSLInterop-late',
];

/** The note a result carries when discovery runs inside WSL. */
export const WSL_NOTE =
  'Running inside WSL: RobotStudio VCs on Windows may not be visible from here. '
  + 'Run discovery on Windows, or enter 127.0.0.1:<port> if WSL shares localhost with Windows '
  + '(mirrored networking).';

/**
 * true when this process runs inside WSL (Windows Subsystem for Linux): on Linux, with
 * `WSL_DISTRO_NAME` set (WSL sets it in every distribution's environment) or a WSL interop
 * registration present under `/proc/sys/fs/binfmt_misc`. Always false on other platforms.
 */
export function isWsl(probe: EnvironmentProbe = {}): boolean {
  const platform = probe.platform ?? process.platform;
  if (platform !== 'linux') { return false; }
  const env = probe.env ?? process.env;
  const distro = env['WSL_DISTRO_NAME'];
  if (typeof distro === 'string' && distro.trim() !== '') { return true; }
  const exists = probe.exists ?? fs.existsSync;
  return WSL_INTEROP_FILES.some(file => {
    try { return exists(file); } catch { return false; }
  });
}

/** Facts about where discovery runs, for `FindControllersResult.environment`. */
export function detectEnvironment(probe: EnvironmentProbe = {}): DiscoveryEnvironment {
  return { wsl: isWsl(probe) };
}

/** The notes the environment adds to a result (the WSL hint, or nothing). */
export function environmentNotes(environment: DiscoveryEnvironment): string[] {
  return environment.wsl ? [WSL_NOTE] : [];
}
