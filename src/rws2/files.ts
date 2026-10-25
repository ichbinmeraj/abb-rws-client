import { FILES_VISION } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { fileMetadataFromHeaders } from '../commonReads.js';
import { RwsError, type FileEntry, type FileMetadata } from '../types.js';
import { parse } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * File service (`/fileservice`) and vision (`/rw/vision`) domains.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function filesOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    /**
     * Refresh the connected integrated-vision camera(s). POST, no body.
     */
    async refreshVisionCameras(): Promise<void> {
      await this.req('POST', buildPath(FILES_VISION.refreshVisionCameras.rws2 as PathSpec));
    }

    async listDirectory(path: string): Promise<FileEntry[]> {
      const p = parse(await this.req('GET', `/fileservice/${this.rws2Path(path)}`));
      const dirs  = p.getAllStates('fs-dir').map(d => ({ name: d['_title'] ?? '', type: 'dir' as const, modified: d['fs-mdate'] }));
      const files = p.getAllStates('fs-file').map(f => ({ name: f['_title'] ?? '', type: 'file' as const, size: f['fs-size'] ? +f['fs-size'] : undefined, created: f['fs-cdate'], modified: f['fs-mdate'], readonly: f['fs-readonly'] === 'true' }));
      return [...dirs, ...files];
    }

    readFile(path: string): Promise<string> { return this.req('GET', `/fileservice/${this.rws2Path(path)}`); }

    /**
     * A file's metadata without downloading it: `HEAD /fileservice/{path}`,
     * ABB's file service page Rev L, "Get File Meta Data" (documented answer
     * 204). RW 7.21.4+417 and 8.2.1+1023 list HEAD in a file's `Allow` header
     * (read 2026-09-29); no HEAD answer has been captured, so every response
     * header is kept in `fields` (cookies left out) and `Last-Modified`,
     * `Content-Type` and, on a 200, `Content-Length` are named. A missing
     * file is the controller's typed refusal (a HEAD answer has no body, so
     * the error carries the status alone).
     */
    async getFileMetadata(path: string): Promise<FileMetadata> {
      if (typeof path !== 'string' || path.trim() === '') {
        throw new RwsError('RWS2 getFileMetadata: the file path must not be empty', 'INVALID_ARGUMENT');
      }
      // The verb comes from the table row; the URL is built like readFile's,
      // because buildPath would %2F the slashes of a multi-segment file path.
      const verb = (FILES_VISION.getFileMetadata.rws2 as PathSpec).method;
      let status = 0;
      let headers: Record<string, string | string[] | undefined> = {};
      await this.req(verb, `/fileservice/${this.rws2Path(path)}`, undefined, undefined, undefined, [], undefined,
        (s, h) => { status = s; headers = h; });
      return fileMetadataFromHeaders(path, status, headers);
    }

    uploadFile(path: string, content: string): Promise<void> {
      // RWS 2.0 requires the versioned content type: 'text/plain;v=2.0' or
      // 'application/octet-stream;v=2.0'. Plain 'text/plain' returns HTTP 415.
      return this.req('PUT', `/fileservice/${this.rws2Path(path)}`, undefined, content, 'text/plain;v=2.0').then(() => {});
    }

    deleteFile(path: string): Promise<void> {
      return this.req('DELETE', `/fileservice/${this.rws2Path(path)}`).then(() => {});
    }

    /**
     * Create a directory under `parentPath`. Live-verified RWS 2.0 API:
     *   POST /fileservice/{parent}/create
     *   body: fs-newname={dirName}
     *
     * The earlier shape (`/fileservice/{parent}/{dirName}/create` with no body)
     * returned 404 because the controller treated `{parent}/{dirName}` as the
     * parent and looked for an already-existing `{dirName}` segment.
     */
    createDirectory(parentPath: string, dirName: string): Promise<void> {
      return this.req('POST', `/fileservice/${this.rws2Path(parentPath)}/create`, { 'fs-newname': dirName }).then(() => {});
    }

    /**
     * Copy a file within its directory. The body field is `fs-newname` (a bare
     * target NAME, like rename) plus an optional `fs-overwrite` - the previously
     * sent `destination` is rejected with HTTP 400 "Invalid/No Query Parameter",
     * so this never worked on RWS 2.0 (fixed 2026-08 after reading the endpoint's
     * own OPTIONS form; verified live: copy created with matching content).
     *
     * The endpoint is **same-directory only** (like RWS 1.0). A destination in a
     * different directory cannot be honoured, so rather than silently copying next
     * to the source it throws INVALID_ARGUMENT; pass a same-directory destination.
     */
    copyFile(sourcePath: string, destPath: string, overwrite = false): Promise<void> {
      const dirOf = (p: string): string => {
        const norm = p.replace(/^\//, ''); const i = norm.lastIndexOf('/');
        return i === -1 ? '' : norm.slice(0, i);
      };
      const destDir = dirOf(destPath);
      if (destDir !== '' && destDir !== dirOf(sourcePath)) {
        return Promise.reject(new RwsError(
          `copyFile: RWS 2.0 can only copy within the source directory. Source dir '${dirOf(sourcePath)}' ` +
          `!= destination dir '${destDir}'. Pass a same-directory destination, or copy-then-move.`,
          'INVALID_ARGUMENT',
        ));
      }
      const destName = destPath.replace(/^.*[\\/]/, '');
      const body: Record<string, string> = { 'fs-newname': destName };
      if (overwrite) { body['fs-overwrite'] = 'true'; }
      return this.req('POST', `/fileservice/${this.rws2Path(sourcePath)}/copy`, body).then(() => {});
    }

    /** Rename a file in place (same directory). The body field is `fs-newname` -
     *  the published spec's `new-filename` is rejected. Live-verified 2026-08-04
     *  (RW7.21) with a create/rename/read-back round trip. */
    renameFile(path: string, newName: string): Promise<void> {
      const { path: p, body } = R2.renameFile(this.rws2Path(path), newName);
      return this.req('POST', p, body).then(() => {});
    }

    /**
     * List connected Integrated Vision cameras. The /rw/vision root carries a
     * `number-of-cameras-li` state plus one link per camera resource - there is no
     * `vision-system-li` class (that name was a guess and never matched, so this
     * always returned an empty list; corrected 2026-08 after reading the real
     * response on RW7.21 and RW8.1.1, both reporting 0 cameras on a VC).
     */
    async listVisionSystems(): Promise<Array<{ name: string; status?: string }>> {
      try {
        const p = parse(await this.req('GET', buildPath(FILES_VISION.listVisionSystems.rws2 as PathSpec)));
        // Prefer explicit camera entries when a controller has cameras attached.
        const cams = [...p.getAllStates('vision-system-li'), ...p.getAllStates('camera-info-li')]
          .map(s => ({ name: s['_title'] ?? s['name'] ?? '', status: s['status'] }))
          .filter(c => c.name && !c.name.includes('{'));
        return cams;
      } catch { return []; }
    }

    /** How many Integrated Vision cameras the controller reports
     *  (class number-of-cameras-li). 0 on a VC without cameras. */
    async getVisionCameraCount(): Promise<number> {
      try {
        const p = parse(await this.req('GET', buildPath(FILES_VISION.getVisionCameraCount.rws2 as PathSpec)));
        return Number(p.getState('number-of-cameras-li')['number-of-cameras'] ?? 0);
      } catch { return 0; }
    }

    /**
     * One camera's details: GET /rw/vision/{camera}/info, ABB's documented
     * child (Integrated_Vision_Service.yaml Rev L, class camera-info-li). The
     * bare /rw/vision/{name} this used to read is not routed on RW 7.21.4 or
     * 8.2.1 (spec check 2026-10-07). The class names are ABB's example: no VC
     * carries the option, so `camera-info` is read as well in case the
     * controller drops the -li suffix on the single resource.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async getVisionSystemInfo(name: string): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(FILES_VISION.getVisionSystemInfo.rws2 as PathSpec, { name })));
      const d = p.getState('camera-info-li');
      return Object.keys(d).length ? d : p.getState('camera-info');
    }

    /**
     * A camera's job: RWS 2.0 has one job name per camera at
     * GET /rw/vision/{camera}/job-name (Rev L, class vision-camera-job, field
     * jobname), not a list. Answers one entry, or [] when the camera reports no
     * job. The `jobs` path this used to read is not routed (404) on either
     * OmniCore build (spec check 2026-10-07). `active` is not part of the
     * resource and is left out.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async listVisionJobs(system: string): Promise<Array<{ name: string; active?: boolean }>> {
      const p = parse(await this.req('GET', buildPath(FILES_VISION.listVisionJobs.rws2 as PathSpec, { system })));
      const name = (p.getState('vision-camera-job')['jobname'] ?? '').trim();
      return name ? [{ name }] : [];
    }

    /**
     * RWS 2.0 documents no way to trigger a vision job (Rev L has 13 paths and
     * no trigger), and the path this used to POST sits under the unrouted
     * `jobs` segment (404 on RW 7.21.4 and 8.2.1, 2026-10-07). Throws
     * `RwsError` `UNSUPPORTED_OPERATION` before anything is sent; the method
     * stays so the public surface does not change.
     */
    async triggerVisionJob(system: string, job: string): Promise<void> {
      throw new RwsError(
        `RWS 2.0 has no operation to trigger a vision job (asked for '${job}' on '${system}'): ABB's Integrated Vision service documents job-name, status and info reads only`,
        'UNSUPPORTED_OPERATION',
      );
    }

    /**
     * Controller file volumes (TEMP, HOME, BACKUP, ...). The root lists them as
     * `fs-dir` entries - `fs-volume` is not a class the controller emits, so this
     * silently fell through to the hardcoded list every time (corrected 2026-08).
     * The hardcoded list remains only as a last-resort fallback.
     */
    async listFileVolumes(): Promise<string[]> {
      try {
        const p = parse(await this.req('GET', buildPath(FILES_VISION.listFileVolumes.rws2 as PathSpec)));
        const names = p.getAllStates('fs-dir').map(v => v['_title'] ?? v['name']).filter(Boolean) as string[];
        if (names.length > 0) { return names; }
        return ['HOME', 'BACKUP', 'DATA', 'ADDINDATA', 'PRODUCTS', 'RAMDISK', 'TEMP'];
      } catch {
        return ['HOME', 'BACKUP', 'DATA', 'ADDINDATA', 'PRODUCTS', 'RAMDISK', 'TEMP'];
      }
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface FilesMethods {
  refreshVisionCameras(): Promise<void>;
  listDirectory(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  getFileMetadata(path: string): Promise<FileMetadata>;
  uploadFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  createDirectory(parentPath: string, dirName: string): Promise<void>;
  copyFile(sourcePath: string, destPath: string, overwrite?: boolean): Promise<void>;
  renameFile(path: string, newName: string): Promise<void>;
  listVisionSystems(): Promise<Array<{ name: string; status?: string }>>;
  getVisionCameraCount(): Promise<number>;
  getVisionSystemInfo(name: string): Promise<Record<string, string>>;
  listVisionJobs(system: string): Promise<Array<{ name: string; active?: boolean }>>;
  triggerVisionJob(system: string, job: string): Promise<void>;
  listFileVolumes(): Promise<string[]>;
}

/** Guard: the mixin class must provide every FilesMethods member (never exported). */
type _FilesMethodsComplete = InstanceType<ReturnType<typeof filesOps>> extends FilesMethods ? true : never;
const _filesComplete: _FilesMethodsComplete = true;
void _filesComplete;

export function FilesOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<FilesMethods> {
  return filesOps(Base) as unknown as TBase & GConstructor<FilesMethods>;
}
