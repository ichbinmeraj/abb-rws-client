/**
 * The controller jobs `startJob(name, source, destination)` starts and
 * returns the progress id of. ABB documents each as a request the controller
 * answers 202 and runs after that, naming the job in
 * `Location: /progress/{id}` (RWS 1.0 Rev M "Compress/Decompress Resource",
 * RWS 2.0 Rev L Controller service, compress and decompress). Each name is
 * the operation's row in the controller path table (`CTRL`) and the name of
 * the method that starts the same job and returns nothing, as in 1.4.0. To
 * wait for a job, poll `getProgress(id)` until its `state` is no longer
 * `pending` (ABB's finished state is `ready`); `details.code` is then the
 * controller's return code, negative when the job failed.
 */

import { RwsError } from './types.js';

/** The jobs `startJob` starts; each takes a source and a destination path. */
export const CONTROLLER_JOB_NAMES = ['compressPath', 'decompressPath'] as const;

/** A job's name: its path-table row and the method that starts it without an id. */
export type ControllerJobName = typeof CONTROLLER_JOB_NAMES[number];

/**
 * `name` when it is one of the jobs `startJob` starts.
 * @throws RwsError `INVALID_ARGUMENT` otherwise; nothing is sent.
 */
export function controllerJobName(name: unknown, who: string): ControllerJobName {
  if (typeof name === 'string' && (CONTROLLER_JOB_NAMES as readonly string[]).includes(name)) {
    return name as ControllerJobName;
  }
  throw new RwsError(
    `${who}: ${JSON.stringify(name)} is not one of the jobs startJob starts (${CONTROLLER_JOB_NAMES.join(', ')}); nothing was sent`,
    'INVALID_ARGUMENT');
}
