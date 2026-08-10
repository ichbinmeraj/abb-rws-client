import * as R2 from '../ResourceMapper2.js';
import { PANEL } from '../paths/panel.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import type {
  ControllerState, OperationMode, CollisionDetectionState,
} from '../types.js';
import { parse, requireState } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * Panel domain - `/rw/panel`: controller state (motors on/off), operation mode,
 * speed ratio, collision-detection state, and the operation-mode lock. Mirrors
 * the `PANEL` path table.
 */
function panelOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    async getControllerState(): Promise<ControllerState> {
      const p = parse(await this.req('GET', R2.controllerState()));
      const d = requireState(p, ['pnl-ctrlstate'], 'getControllerState');
      return (d['ctrlstate'] ?? 'init') as ControllerState;
    }

    setControllerState(state: 'motoron' | 'motoroff'): Promise<void> {
      const { path, body } = R2.setControllerState(state);
      return this.req('POST', path, body).then(() => {});
    }

    async getOperationMode(): Promise<OperationMode> {
      const p = parse(await this.req('GET', R2.operationMode()));
      const d = requireState(p, ['pnl-opmode'], 'getOperationMode');
      return (d['opmode'] ?? 'MANR') as OperationMode;
    }

    async getSpeedRatio(): Promise<number> {
      const p = parse(await this.req('GET', R2.speedRatio()));
      const d = requireState(p, ['pnl-speedratio'], 'getSpeedRatio');
      return Number(d['speedratio'] ?? 100);
    }

    /**
     * Set the speed ratio (0-100). Live-verified format on OmniCore VC RW7.21
     * via scripts/probe-speedratio.js (2026-05-07):
     *   ✓ POST /rw/panel/speedratio?action=setspeedratio  body speed-ratio=N
     *     (RWS 1.0 wire format - OmniCore kept the legacy path)
     *     Requires `edit` mastership: 403 "user does not have required
     *     mastership" without it.
     *   ✗ POST /rw/panel/speedratio  body speedratio=N  → 400 "Invalid input form data"
     *   ✗ POST /rw/panel/speedratio/set                 → 404 (path doesn't exist)
     *
     * Acquires `edit` mastership internally and releases it after.
     */
    async setSpeedRatio(ratio: number): Promise<void> {
      // Build (and therefore validate) before taking write access: a rejected
      // argument should cost no controller round trip, and on RW8 a failure to
      // take write access would otherwise mask the real complaint.
      const { path, body } = R2.setSpeedRatio(ratio);
      await this.requestMastership('rapid');   // 'rapid' is renamed to 'edit' internally
      try {
        await this.req('POST', path, body);
      } finally {
        await this.releaseMastership('rapid').catch(() => {});
      }
    }

    async getCollisionDetectionState(): Promise<CollisionDetectionState> {
      const p = parse(await this.req('GET', R2.collisionDetectionState()));
      return (p.getState('pnl-coldetstate')['coldetstate'] ?? 'INIT') as CollisionDetectionState;
    }

    lockOperationMode(pin: string, permanent = false): Promise<void> {
      // POST /rw/panel/opmode/lock with pin and permanent flag
      const { path, body } = R2.lockOperationMode(pin, permanent);
      return this.req('POST', path, body).then(() => {});
    }

    unlockOperationMode(): Promise<void> {
      const { path } = R2.unlockOperationMode();
      return this.req('POST', path).then(() => {});
    }

    /** Acknowledge a pending operation-mode switch (after the mode selector is turned).
     *  OPTIONS-verified 2026-08-04 (RW7.21). @param wireMode target mode, e.g. 'auto'. */
    acknowledgeOperationMode(wireMode: string): Promise<void> {
      const { path, body } = R2.acknowledgeOperationMode(wireMode);
      return this.req('POST', path, body).then(() => {});
    }

    /** Lock state of the operation-mode selector ('locked' | 'unlocked').
     *  Live-verified 2026-08-04 (RW7.21), class pnl-opmode-lockstate-li. */
    async getOperationModeLockState(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(PANEL.getOperationModeLockState.rws2 as PathSpec)));
      return p.getState('pnl-opmode-lockstate-li')['lockstate'] ?? 'unknown';
    }

    /**
     * Switch the controller's operation mode. **Virtual controllers only** -
     * real hardware respects the FlexPendant key switch.
     *
     * Endpoint + wire format - ALL live-verified on OmniCore VC RW7.x via
     * scripts/probe-opmode-write.js (2026-05-07):
     *   ✓ POST /rw/panel/opmode  body opmode=auto  → AUTO (200 OK)
     *   ✓ POST /rw/panel/opmode  body opmode=man   → MANR (200 OK)
     *   ✓ POST /rw/panel/opmode  body opmode=manf  → MANF (200 OK) - NOTE: `manf`,
     *      NOT `manfs` as RWS 1.0 uses. RWS 2.0 dropped the 's'.
     *   ✗ POST /rw/panel/opmode/set                → 404 (path doesn't exist)
     *   ✗ POST /rw/panel/opmode  body opmode=AUTO  → 400 invalid value
     *   ✗ POST /rw/panel/opmode  body opmode=manr  → 400 invalid value
     *
     * The wire value is lowercase and uses the RWS 1.0 abbreviations *except*
     * for MANF (`manf` on RWS 2.0 vs `manfs` on RWS 1.0). And NEITHER matches
     * the GET-response casing (`AUTO`/`MANR`/`MANF`). This asymmetry is one
     * of the documented protocol quirks of RWS 2.0.
     *
     * Side note: the controller pops up a confirmation dialog on the FlexPendant
     * after the call returns 200 OK; the operator must approve before the mode
     * actually flips. There is no API path to bypass this - UAS-grant changes
     * are FlexPendant-only by design.
     */
    setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void> {
      const wire = mode === 'AUTO' ? 'auto' : mode === 'MANR' ? 'man' : 'manf';
      return this.req('POST', buildPath(PANEL.setOperationMode.rws2 as PathSpec), { opmode: wire }).then(() => {});
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required: the
 * composed `RwsClient2` emits a `.d.ts`, and a class extending an *anonymous*
 * mixin class can't describe Rws2Core's protected/private members there
 * (TS4094). Listing the public methods here keeps them - and only them - on the
 * client. Co-located with the implementation; the test suite calls every method,
 * so a signature that drifts from the class is caught at build time.
 */
export interface PanelMethods {
  getControllerState(): Promise<ControllerState>;
  setControllerState(state: 'motoron' | 'motoroff'): Promise<void>;
  getOperationMode(): Promise<OperationMode>;
  getSpeedRatio(): Promise<number>;
  setSpeedRatio(ratio: number): Promise<void>;
  getCollisionDetectionState(): Promise<CollisionDetectionState>;
  lockOperationMode(pin: string, permanent?: boolean): Promise<void>;
  unlockOperationMode(): Promise<void>;
  acknowledgeOperationMode(wireMode: string): Promise<void>;
  getOperationModeLockState(): Promise<string>;
  setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void>;
}

/** Compile-time guard: the mixin class must provide every method `PanelMethods`
 *  promises. Internal (never exported), so it emits no declaration. */
type _PanelComplete = InstanceType<ReturnType<typeof panelOps>> extends PanelMethods ? true : never;
const _panelComplete: _PanelComplete = true;
void _panelComplete;

export function PanelOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<PanelMethods> {
  return panelOps(Base) as unknown as TBase & GConstructor<PanelMethods>;
}
