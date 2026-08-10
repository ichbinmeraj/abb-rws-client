import { CTRL, SYSTEM_MASTERSHIP } from '../paths/index.js';
import { PANEL } from '../paths/panel.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import { type ControllerClock, type ControllerIdentity, type RestartMode, type SystemInfo } from '../types.js';
import { parse } from './core.js';
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
     * edit mastership held is accepted. Acquired internally; no release
     * afterwards - the controller is going down and takes the session with it.
     */
    async restartController(mode: RestartMode = 'restart'): Promise<void> {
      await this.requestMastership('rapid');   // 'rapid' is renamed to 'edit' internally
      try {
        await this.req('POST', buildPath(PANEL.restartController.rws2 as PathSpec), { 'restart-mode': mode });
        // Success: no release - the controller is going down and takes the
        // session (and its mastership) with it.
      } catch (e) {
        // Refused restart (wrong mode, busy, ...): keeping edit mastership here
        // would block every other client until this session times out.
        await this.releaseMastership('rapid').catch(() => {});
        throw e;
      }
    }

    /** Reset accumulated system energy counters. POST, no body. */
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

    async getRobotType(): Promise<{ type: string; variant?: string }> {
      const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getRobotType.rws2 as PathSpec)));
      const d = p.getState('sys-robottype');
      // Live-verified: span class is 'robot-type' (with hyphen), not 'robottype'
      return { type: d['robot-type'] ?? d['robottype'] ?? d['type'] ?? '', variant: d['variant'] };
    }

    async getEnergyStats(): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.getEnergyStats.rws2 as PathSpec)));
      // Live-verified class: sys-energy-state (not sys-energy)
      return p.getState('sys-energy-state');
    }

    /**
     * Write a system-information report to a file on the controller.
     * POST /ctrl/system/info, form fields `path`, `file-type` (live-read
     * 2026-08-09).
     *
     * Despite the name this is NOT a getter - GET answers 405 and the resource
     * only accepts POST. Use `getSystemInfo()` for the in-memory system facts.
     *
     * Not available on a virtual controller: both VCs answer 403 "Functionality
     * is not supported on the current platform" (live-verified 2026-08-09 on
     * RW7.21 and RW8.1.1), surfacing as `RwsError` GRANT_DENIED. Kept because the
     * form is real and physical controllers do implement it.
     */
    async saveSystemInfo(path: string, fileType: string): Promise<void> {
      await this.req('POST', buildPath(CTRL.saveSystemInfo.rws2 as PathSpec), { path, 'file-type': fileType });
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
  getRobotType(): Promise<{ type: string; variant?: string }>;
  getEnergyStats(): Promise<Record<string, string>>;
  saveSystemInfo(path: string, fileType: string): Promise<void>;
}

/** Guard: the mixin class must provide every SystemMethods member (never exported). */
type _SystemMethodsComplete = InstanceType<ReturnType<typeof systemOps>> extends SystemMethods ? true : never;
const _systemComplete: _SystemMethodsComplete = true;
void _systemComplete;

export function SystemOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<SystemMethods> {
  return systemOps(Base) as unknown as TBase & GConstructor<SystemMethods>;
}
