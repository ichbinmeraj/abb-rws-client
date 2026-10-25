import { CTRL, SYSTEM_MASTERSHIP } from '../paths/index.js';
import { PANEL } from '../paths/panel.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import { type ControllerClock, type ControllerIdentity, type RestartMode, type SystemInfo } from '../types.js';
import { parse } from './core.js';
import { robotTypesFrom } from '../commonReads.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * System domain (`/rw/system`): system info, identity, clock, restart, license, products, energy.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function systemOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    async getSystemInfo(): Promise<SystemInfo> {
      const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getSystemInfo.rws2 as PathSpec)));
      const d = p.getState('sys-system');
      // Type-name drift between representations (live-verified 2026-07-09, RW7.21):
      // XHTML lists options as class="sys-option"; HAL JSON nests them under the
      // sys-options-li resource as _type="sys-options". Collect both.
      const opts = [...p.getAllStates('sys-option'), ...p.getAllStates('sys-options')]
        .map(o => o['option']).filter(Boolean) as string[];
      return { name: d['name'] ?? '', rwVersion: d['rwversion'] ?? '', sysid: d['sysid'] ?? '', startTime: d['starttm'] ?? '', options: opts };
    }

    async getControllerIdentity(): Promise<ControllerIdentity> {
      const p = parse(await this.req('GET', buildPath(CTRL.getControllerIdentity.rws2 as PathSpec)));
      const d = p.getState('ctrl-identity-info');
      return { name: d['ctrl-name'] ?? '', id: '', type: d['ctrl-type'] ?? '', mac: '' };
    }

    async getControllerClock(): Promise<ControllerClock> {
      const p = parse(await this.req('GET', buildPath(CTRL.getControllerClock.rws2 as PathSpec)));
      return { datetime: p.getState('ctrl-clock-info')['datetime'] ?? '' };
    }

    /**
     * `PUT /ctrl/clock`, the method ABB documents ("Set the Clock of the
     * Controller", RWS 2.0 Rev L, Controller Service), with "Supported only in
     * RC": a virtual controller answers 405 -1073414146 "HTTP method not
     * supported by resource" (RW 7.21.4 and 8.2.1, 2026-10-11). Times are UTC.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void> {
      // PUT /ctrl/clock - field names confirmed from RwsClient ResourceMapper
      return this.req('PUT', buildPath(CTRL.setControllerClock.rws2 as PathSpec), {
        'sys-clock-year':  String(year),
        'sys-clock-month': String(month),
        'sys-clock-day':   String(day),
        'sys-clock-hour':  String(hour),
        'sys-clock-min':   String(min),
        'sys-clock-sec':   String(sec),
      }).then(() => {});
    }

    /**
     * Restart the controller. Requires `edit` mastership - live-verified
     * 2026-08-02 on OmniCore VC RW7.21: bare POST /ctrl/restart → 403
     * "Restart failed for given restart mode -1073445859"; the same POST with
     * edit mastership held is accepted. Held around the call; no release
     * afterwards - the controller is going down and takes the session with it.
     * A refused restart releases the hold as usual: keeping edit mastership
     * then would block every other client until this session times out.
     */
    async restartController(mode: RestartMode = 'restart'): Promise<void> {
      // 'rapid' is renamed to 'edit' internally
      await this.withAccess(['rapid'], async () => {
        await this.req('POST', buildPath(PANEL.restartController.rws2 as PathSpec), { 'restart-mode': mode });
      }, { releaseOnSuccess: false });
    }

    /**
     * Reset accumulated system energy counters. POST, no body.
     */
    async resetEnergy(): Promise<void> {
      await this.req('POST', buildPath(SYSTEM_MASTERSHIP.resetEnergy.rws2 as PathSpec));
    }

    /** Number of controller restarts. GET /ctrl/restart/restartcount, live-verified
     *  2026-08-04 (RW7.21, class ctrl / span restart-count). */
    async getRestartCount(): Promise<number> {
      const p = parse(await this.req('GET', buildPath(CTRL.getRestartCount.rws2 as PathSpec)));
      return Number(p.getState('ctrl')['restart-count'] ?? p.get('restart-count') ?? 0);
    }

    async getLicenseInfo(): Promise<{ entries: Array<Record<string, string>> }> {
      const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getLicenseInfo.rws2 as PathSpec)));
      return { entries: p.getAllStates('sys-license') };
    }

    async listProducts(): Promise<Array<Record<string, string>>> {
      const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.listProducts.rws2 as PathSpec)));
      // Live-verified class: sys-product-li (with -li suffix). Each product has a _title
      // (the product name e.g. "RobotControl") plus version and version-name spans.
      return p.getAllStates('sys-product-li').map(p => ({
        name: p['_title'] ?? '',
        version: p['version'] ?? '',
        versionName: p['version-name'] ?? '',
      }));
    }

    /** The robot types (ABB Rev L "Get Robot Type": one `sys-robottype`
     *  entry per robot, span `robot-type` with a hyphen, live-verified):
     *  `type` the first robot's, `types` every robot's, in the controller's
     *  order. 1.4.x kept the first only. */
    async getRobotType(): Promise<{ type: string; variant?: string; types: string[] }> {
      const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getRobotType.rws2 as PathSpec)));
      return robotTypesFrom(p.getAllEntries());
    }

    async getEnergyStats(): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getEnergyStats.rws2 as PathSpec)));
      // Live-verified class: sys-energy-state (not sys-energy)
      return p.getState('sys-energy-state');
    }

    /**
     * Copy the system's installation files (RMF, RSF, RLF) into a controller
     * directory; the caller removes them afterwards (ABB Rev L, "Supported
     * only in RC"). POST /ctrl/system/info, form fields `path` and, optional,
     * `file-type` (live-read 2026-08-09). ABB's `file-type` takes values such
     * as `FileType_RMF` or `[FileType_RMF,FileType_RSF]`; without it the
     * controller copies every type (`FileType_ALL`). This method sends
     * `file-type` only when `fileType` is given and not empty.
     *
     * Returns nothing, as in 1.4.0. ABB's 200 answer lists the copied files
     * (one `ctrl-system-info-li` per file, the name in the title and a
     * `/fileservice/` link); list the `path` directory to see them.
     *
     * Despite the name this is NOT a getter - GET answers 405 and the resource
     * only accepts POST. Use `getSystemInfo()` for the in-memory system facts.
     *
     * Not available on a virtual controller: both VCs answer 403 "Functionality
     * is not supported on the current platform" (RW7.21 and RW8.1.1,
     * 2026-08-09), surfacing as `RwsError` UNSUPPORTED_OPERATION (refusal
     * kind `rc-only` when the caller knows it is a virtual controller). Kept because the
     * form is real and physical controllers do implement it.
     *
     * @experimental Built from the controller form; no logged 2xx on an RWS 2.0 controller.
     */
    async saveSystemInfo(path: string, fileType?: string): Promise<void> {
      const form: Record<string, string> = { path };
      if (fileType !== undefined && fileType !== '') { form['file-type'] = fileType; }
      await this.req('POST', buildPath(CTRL.saveSystemInfo.rws2 as PathSpec), form);
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface SystemMethods {
  getSystemInfo(): Promise<SystemInfo>;
  getControllerIdentity(): Promise<ControllerIdentity>;
  getControllerClock(): Promise<ControllerClock>;
  setControllerClock(year: number, month: number, day: number, hour: number, min: number, sec: number): Promise<void>;
  restartController(mode?: RestartMode): Promise<void>;
  resetEnergy(): Promise<void>;
  getRestartCount(): Promise<number>;
  getLicenseInfo(): Promise<{ entries: Array<Record<string, string>> }>;
  listProducts(): Promise<Array<Record<string, string>>>;
  getRobotType(): Promise<{ type: string; variant?: string; types: string[] }>;
  getEnergyStats(): Promise<Record<string, string>>;
  saveSystemInfo(path: string, fileType?: string): Promise<void>;
}

/** Guard: the mixin class must provide every SystemMethods member (never exported). */
type _SystemMethodsComplete = InstanceType<ReturnType<typeof systemOps>> extends SystemMethods ? true : never;
const _systemComplete: _SystemMethodsComplete = true;
void _systemComplete;

export function SystemOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<SystemMethods> {
  return systemOps(Base) as unknown as TBase & GConstructor<SystemMethods>;
}
