import { MOTION } from '../paths/index.js';
import { PANEL } from '../paths/panel.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { RwsError, type CollisionDetectionState, type ControllerState, type OperationMode } from '../types.js';
import { parse, requireState } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * Panel domain (`/rw/panel`): controller state, operation mode, speed ratio, collision detection, sim panel.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function panelOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    async getControllerState(): Promise<ControllerState> {
      const p = parse(await this.req('GET', R2.controllerState()));
      const d = requireState(p, ['pnl-ctrlstate'], 'getControllerState');
      return (d['ctrlstate'] ?? 'init') as ControllerState;
    }

    /** Set the motor state. Sent as is: no mastership or write access is taken
     *  here, and ABB's RWS 2.0 reference lists no mastership prerequisite for
     *  the ctrl-state resource. `RobotManager.setMotorsOff` sends 'motoroff'
     *  first and takes access only when the controller refuses it as not held. */
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
     *     (read at the time as "RWS 1.0 wire format - OmniCore kept the legacy
     *     path"; that reading was wrong, see the 2026-09-27 lines below)
     *     Requires `edit` mastership: 403 "user does not have required
     *     mastership" without it.
     *   ✗ POST /rw/panel/speedratio  body speedratio=N  → 400 "Invalid input form data"
     *   ✗ POST /rw/panel/speedratio/set                 → 404 (path doesn't exist)
     * Re-verified 2026-09-27 on RW 7.21 and RW 8.1.1 (AUTO, edit mastership /
     * write access held, value restored afterwards):
     *   ✓ POST /rw/panel/speedratio  body speed-ratio=N  → 204, value changes
     *     (the documented plain POST; the controller's own OPTIONS form is
     *     `action="speedratio"` with input `speed-ratio`, 0-100)
     *   ✓ POST /rw/panel/speedratio?action=nosuchaction  body speed-ratio=N → 204
     *     (the `action` query is not checked at all)
     *   ✗ speedratio=N → 400 with or without the action; /set → 404 (as before)
     * So the 2026-05-07 ✓ line held because of the field name, not the action:
     * OmniCore did not keep a legacy `?action=` requirement, the query is
     * ignored. The request this method sends carries the action from the path
     * table and works; it is not changed.
     * Raw-logged again 2026-09-29 on RW 7.21.4+417 and 8.2.1+1023: this exact
     * request (`?action=setspeedratio`, `speed-ratio=N`) and
     * `?action=nosuchaction` → 204; `speedratio=N` → 400 and `/set` → 404 on
     * both. Without the hold the write is refused 403 -1073445859 on 7.21.4
     * and 403 -1073435873 on 8.2.1.
     *
     * Holds `edit` mastership (RW8: write access) around the write. A hold this
     * session already has, a caller's included, is reused and not ended.
     */
    async setSpeedRatio(ratio: number): Promise<void> {
      // Build (and therefore validate) before taking write access: a rejected
      // argument should cost no controller round trip, and on RW8 a failure to
      // take write access would otherwise mask the real complaint.
      const { path, body } = R2.setSpeedRatio(ratio);
      // 'rapid' is renamed to 'edit' internally
      await this.withAccess(['rapid'], () => this.req('POST', path, body));
    }

    async getCollisionDetectionState(): Promise<CollisionDetectionState> {
      const p = parse(await this.req('GET', R2.collisionDetectionState()));
      return (p.getState('pnl-coldetstate')['coldetstate'] ?? 'INIT') as CollisionDetectionState;
    }

    /** Answered 204 on RobotWare 7.21.4, 8.1.1 and 8.2.1 virtual controllers (2026-10-10). */
    lockOperationMode(pin: string, permanent = false): Promise<void> {
      // POST /rw/panel/opmode/lock with pin and permanent flag
      const { path, body } = R2.lockOperationMode(pin, permanent);
      return this.req('POST', path, body).then(() => {});
    }

    /** Unlock the operation-mode selector with the PIN the lock set. The
     *  controller form (RW 7.21.4, 8.2.1) and Rev L require `pin`; without
     *  one, `RwsError` `INVALID_ARGUMENT` is thrown before anything is sent
     *  (the method used to post an empty body). The parameter is optional in
     *  the signature only for source compatibility. Answered 204 on RobotWare
     *  7.21.4, 8.1.1 and 8.2.1 virtual controllers (2026-10-10).
     */
    unlockOperationMode(pin?: string): Promise<void> {
      if (typeof pin !== 'string' || pin.trim() === '') {
        return Promise.reject(new RwsError('RWS2 unlockOperationMode: the PIN the lock set is needed (the controller form requires pin)', 'INVALID_ARGUMENT'));
      }
      const { path, body } = R2.unlockOperationMode(pin);
      return this.req('POST', path, body).then(() => {});
    }

    /**
     * Acknowledge a pending change of operating mode: POST
     * `/rw/panel/opmode/acknowledge` with `opmode`, the resource ABB's RWS 2.0
     * pages document for confirming a mode change.
     *
     * The confirmation is the person's at the FlexPendant;
     * `RobotManager.setOperationMode` does not send it.
     *
     * @param wireMode target mode, e.g. 'auto'.
     * @experimental Built from ABB's documented form.
     */
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
     * after the call returns 200 OK; the operator approves it at the FlexPendant
     * before the mode flips, and this client does not send that confirmation.
     *
     * RobotWare 8: the switch is sent inside control-station write access,
     * taken here when this session does not hold it already (a hold of the
     * caller's or of RobotManager is reused, nothing more is requested). ABB
     * lists setting operating modes among what needs write access (PC SDK,
     * Control Station), and RW 8.2.1 refused the bare switch with 403
     * -1073435873 "User does not have write access", with and without the
     * station registered (2026-10-12). With the hold, RW 8.2.1 took the switch to
     * MANR from the adapter and to AUTO through RobotManager, one write-access
     * request and release each (2026-10-13). RobotWare 7 sends it as before,
     * with no mastership of its own (RobotManager holds edit for a switch to Auto).
     */
    setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void> {
      const wire = mode === 'AUTO' ? 'auto' : mode === 'MANR' ? 'man' : 'manf';
      const send = (): Promise<void> => this.req('POST', buildPath(PANEL.setOperationMode.rws2 as PathSpec), { opmode: wire }).then(() => {});
      const major = Number((this.cachedRobotWareVersion() ?? '').split('.')[0]);
      return major >= 8 ? this.withAccess(['rapid'], send) : send();
    }

    /**
     * Engage the (internal) emergency stop - controller state goes to
     * `emergencystop`. Live-verified 2026-07-09 on OmniCore VC RW7.21:
     *   POST /rw/panel/emergency-stop  body `state=off` → 204.
     * The polarity is INVERTED from the ABB Swagger example: state=off OPENS the
     * safety chain (engages the stop), state=on closes it again. Fully reversible
     * on a VC via {@link simResetEmergencyStop} - no physical reset step exists
     * there (unlike real hardware, which latches until the button is released).
     */
    simEmergencyStop(): Promise<void> {
      return this.simPost('simEmergencyStop', buildPath(PANEL.simEmergencyStop.rws2 as PathSpec), { state: 'off' });
    }

    /** Release the simulated emergency stop (`state=on`) - controller returns to
     *  `motoroff`. See {@link simEmergencyStop} for the polarity note. */
    simResetEmergencyStop(): Promise<void> {
      return this.simPost('simResetEmergencyStop', buildPath(PANEL.simEmergencyStop.rws2 as PathSpec), { state: 'on' });
    }

    /**
     * Engage the general stop (controller state → `guardstop`); pass `false` to
     * release it again (→ `motoroff`). Live-verified 2026-07-09 on OmniCore VC
     * RW7.21: POST /rw/panel/general-stop, `state=off` engages / `state=on`
     * releases (same inverted polarity as the e-stop endpoints).
     */
    simGeneralStop(engage = true): Promise<void> {
      return this.simPost('simGeneralStop', buildPath(PANEL.simGeneralStop.rws2 as PathSpec), { state: engage ? 'off' : 'on' });
    }

    /**
     * Engage the automatic stop (controller state → `guardstop`); pass `false` to
     * release it. Live-verified 2026-07-09 on OmniCore VC RW7.21:
     * POST /rw/panel/auto-stop, `state=off` engages / `state=on` releases.
     */
    simAutoStop(engage = true): Promise<void> {
      return this.simPost('simAutoStop', buildPath(PANEL.simAutoStop.rws2 as PathSpec), { state: engage ? 'off' : 'on' });
    }

    /**
     * Press (`true`) or release (`false`) the simulated three-position enabling
     * device. Live-verified 2026-07-09 on OmniCore VC RW7.21:
     *   POST /rw/panel/enable-switch  body `state=on|off` → 204.
     * This endpoint's polarity is direct (no inversion). In AUTO the controller
     * accepts the call as a no-op; driving motors on requires manual mode.
     * ABB says the VC switches the motors on implicitly, but on RW 7.21.4 in
     * MANR the controller state went from guardstop to motoroff and never read
     * motoron (read at 0.5, 1, 2 and 5 s, 2026-10-13); holding Enable on the
     * virtual FlexPendant did give motoron. On RobotWare 8 the guard stop after
     * a mode change needs Reset at the pendant before Enable.
     */
    simEnableSwitch(on: boolean): Promise<void> {
      return this.simPost('simEnableSwitch', buildPath(PANEL.simEnableSwitch.rws2 as PathSpec), { state: on ? 'on' : 'off' });
    }

    /**
     * Teleport a mechanical unit to absolute joint values (degrees) - the VC
     * equivalent of dragging the robot in RobotStudio; no motors, mastership, or
     * program stop needed. Live-verified 2026-07-09 on OmniCore VC RW7.21:
     *   POST /rw/motionsystem/mechunits/{mechunit}/position
     *   body `rob_joint=[j1,j2,j3,j4,j5,j6]&ext_joint=[e1,e2,e3,e4,e5,e6]` → 204
     * BOTH keys are required by the controller (omitting either → 400
     * "No rob_joint parameter"), which is why `extJoints` defaults to six zeros.
     * The readback (`getJointPositions`) may show sub-µdeg float rounding.
     * Caveat (live-verified 2026-07-09): while an operation-mode change is
     * pending (opmode AUTO_CH - FlexPendant acknowledge outstanding) the endpoint
     * answers 403 "Operation not allowed for user in current operation mode".
     */
    async teleportMechunit(mechunit: string, joints: number[], extJoints?: number[]): Promise<void> {
      if (joints.length !== 6 || (extJoints !== undefined && extJoints.length !== 6)) {
        throw new RwsError(
          'teleportMechunit: exactly 6 robot joint values (and 6 external-axis values, if given) are required',
          'UNKNOWN',
        );
      }
      const ext = extJoints ?? [0, 0, 0, 0, 0, 0];
      await this.simPost(
        'teleportMechunit',
        buildPath(MOTION.teleportMechunit.rws2 as PathSpec, { mechunit }),
        undefined,
        `rob_joint=[${joints.join(',')}]&ext_joint=[${ext.join(',')}]`,
      );
    }

    async getEnableRequest(): Promise<{ state: string; raw: Record<string, string> }> {
      const p = parse(await this.req('GET', buildPath(PANEL.getEnableRequest.rws2 as PathSpec)));
      const d = p.getState('pnl-enreq') || p.getState('pnl-enreq-li');
      return { state: d['state'] ?? d['enreq'] ?? 'unknown', raw: d };
    }

    /**
     * Panel language. POST /rw/panel/lang, form field `lang-code`
     * (live-read 2026-08-09 on RW7.21 and RW8.1.1; `Allow: POST,OPTIONS`).
     *
     * There is no getter: GET answers 405 even though the Allow header
     * mistakenly lists an empty first entry (`,POST,OPTIONS`). Read the active
     * language from `getControllerLanguage()`-adjacent system resources instead.
     */
    async setPanelLanguage(langCode: string): Promise<void> {
      await this.req('POST', buildPath(PANEL.setPanelLanguage.rws2 as PathSpec), { 'lang-code': langCode });
    }

    /**
     * Motors on WITHOUT the key switch, via the Keyless Mode Switch option.
     * POST /rw/panel/ctrl-state/keyless-motoron - `Allow: POST,OPTIONS`, and the
     * form carries NO fields (`<form id="keyless" method="post"
     * action="ctrl-state/keyless-motoron"></form>`), so this sends an empty body.
     *
     * Note the path: the resource lives UNDER `ctrl-state`, not beside it.
     * `/rw/panel/keyless-motoron` - the shape most notes record - answers 404 on
     * every generation. Live-read 2026-08-09 on RW7.21 and RW8.1.1. RWS 1.0
     * has it elsewhere: ABB's RWS 1.0 manual (Rev M, "Keyless motor ON")
     * documents `POST /rw/cfg?action=keyless` with `state=run`, which
     * `RWS1Adapter.setKeylessMotorOn` sends.
     *
     * It energises the drives. Reversible with `setControllerState('motoroff')`.
     * Run against RWS 2.0 (RobotWare 7.21.4).
     *
     * Holds `edit` mastership (RW8: write access) around the POST, as
     * `RobotManager.setMotorsOn` does for the ordinary motors-on. ABB's RWS
     * pages list no prerequisite for this resource; whether the controller
     * needs any hold here is not established, so the hold a motors-on takes
     * is taken.
     */
    async setKeylessMotorOn(): Promise<void> {
      await this.withAccess(['rapid'], () => this.req('POST', buildPath(PANEL.setKeylessMotorOn.rws2 as PathSpec)));
    }

    /**
     * Simulated EXTERNAL emergency stop. POST /rw/panel/external-emergency-stop,
     * form field `state`, values `on` (circuit closed) and `off` (circuit
     * open, the stop is active); the older `active` / `reset` names are
     * mapped to off / on. Sibling of the already-covered
     * e-stop simulation; this one models the external circuit rather than the
     * pendant button.
     *
     * Absent on RWS 1.0 - the IRC5 controllers answer 404 for this path.
     */
    async setExternalEmergencyStop(state: 'on' | 'off' | 'active' | 'reset'): Promise<void> {
      // The form field is the circuit, not the stop: `on` = closed (no stop,
      // the controller reads motoroff), `off` = open (the controller reads
      // emergencystop). The controller's own OPTIONS form lists on and off, and
      // ABB's sample call sends state=on (RWS 2.0 Rev L, Panel Service). The
      // client used to send active and reset, which RW 7.21.4 and 8.2.1 refuse
      // with 400 -1073445879 "Invalid state value" (recorded 2026-10-11); they
      // are still accepted here and mapped: active = off, reset = on. After
      // off, only on clears the stop on the VC.
      const wire = state === 'active' ? 'off' : state === 'reset' ? 'on' : state;
      await this.req('POST', buildPath(PANEL.setExternalEmergencyStop.rws2 as PathSpec), { state: wire });
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface PanelMethods {
  getControllerState(): Promise<ControllerState>;
  setControllerState(state: 'motoron' | 'motoroff'): Promise<void>;
  getOperationMode(): Promise<OperationMode>;
  getSpeedRatio(): Promise<number>;
  setSpeedRatio(ratio: number): Promise<void>;
  getCollisionDetectionState(): Promise<CollisionDetectionState>;
  lockOperationMode(pin: string, permanent?: boolean): Promise<void>;
  unlockOperationMode(pin?: string): Promise<void>;
  acknowledgeOperationMode(wireMode: string): Promise<void>;
  getOperationModeLockState(): Promise<string>;
  setOperationMode(mode: 'AUTO' | 'MANR' | 'MANF'): Promise<void>;
  simEmergencyStop(): Promise<void>;
  simResetEmergencyStop(): Promise<void>;
  simGeneralStop(engage?: boolean): Promise<void>;
  simAutoStop(engage?: boolean): Promise<void>;
  simEnableSwitch(on: boolean): Promise<void>;
  teleportMechunit(mechunit: string, joints: number[], extJoints?: number[]): Promise<void>;
  getEnableRequest(): Promise<{ state: string; raw: Record<string, string> }>;
  setPanelLanguage(langCode: string): Promise<void>;
  setKeylessMotorOn(): Promise<void>;
  setExternalEmergencyStop(state: 'active' | 'reset'): Promise<void>;
}

/** Guard: the mixin class must provide every PanelMethods member (never exported). */
type _PanelMethodsComplete = InstanceType<ReturnType<typeof panelOps>> extends PanelMethods ? true : never;
const _panelComplete: _PanelMethodsComplete = true;
void _panelComplete;

export function PanelOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<PanelMethods> {
  return panelOps(Base) as unknown as TBase & GConstructor<PanelMethods>;
}
