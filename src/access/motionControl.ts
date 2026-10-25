/**
 * RobotWare 8's motion-control allowance, as `RobotManager` reaches it on the
 * RWS 2.0 client it manages: the withdrawal step, the read that sends nothing
 * while the session is not registered, the FlexPendant connection reads, and
 * whether this client may have an allowance standing (`maybeDeclared`).
 *
 * The client never allows motion control on its own. Withdrawing is the safe
 * direction, and the client does it on its own: as the first request of a
 * disconnect, at the next registration of the same station and after a
 * re-issued session when an earlier withdrawal did not go through, at a
 * registration that finds an allowance this client did not make in this run
 * (`leftover`), and (when turned on) on an operating-mode change or a
 * FlexPendant take-back.
 *
 * Internal: not exported from the package, except the `LocalStationStatus`
 * type, which `RobotManager.getLocalStationStatus()` returns.
 */

/** What starts a withdrawal. `leftover`: a registration read the station allowed, and this client made no allowance in this run. */
export type WithdrawalTrigger = 'disconnect' | 'registration' | 'leftover' | 'reissue' | 'mode-change' | 'take-back';

/** How a withdrawal ended: sent and taken, refused or unanswered, or nothing to withdraw. */
export type WithdrawalOutcome = 'withdrawn' | 'failed' | 'nothing';

/** The two RobotWare 8 FlexPendant connection reads; null where a read failed or did not parse. */
export interface LocalStationStatus {
  /** `GET /rw/controlstation/local/isconnected`, field `control-station-local-isconnected`. */
  flexPendantConnected: boolean | null;
  /** `GET /rw/controlstation/tpu/safety/protocol/status`, field `is-connected`. */
  safetyProtocolConnected: boolean | null;
}

/** What an RWS 2.0 client of this package offers its manager about the allowance. */
export interface MotionControlPort {
  /**
   * Withdraw an allowance this client may have made: one POST
   * `allow-motion-control=false`, registering first when needed, within a
   * short deadline. Sends nothing when nothing may stand. Never throws.
   */
  withdraw(trigger: WithdrawalTrigger): Promise<WithdrawalOutcome>;
  /** The allowance read once; null, and nothing sent, while the session is not a registered control station. */
  read(): Promise<boolean | null>;
  /** The two FlexPendant connection reads. Never throws. */
  localStationStatus(): Promise<LocalStationStatus>;
  /** True from the moment a POST `true` is sent until a POST `false` is taken or a registered session reads false. */
  maybeDeclared(): boolean;
}

/**
 * The withdrawals on an operating-mode change and on a FlexPendant take-back.
 * Built and held off in this release: they are turned on once a run on a
 * controller shows what a withdrawal does to a running program. Tests turn
 * them on.
 */
export const MOTION_CONTROL_WITHDRAWAL_TRIGGERS: { modeChange: boolean; takeBack: boolean } = {
  modeChange: false,
  takeBack: false,
};

const ports = new WeakMap<object, MotionControlPort>();

/** Record that `owner` (an RWS 2.0 client or adapter of this package) offers `port`. */
export function bindMotionControl(owner: object, port: MotionControlPort): void {
  ports.set(owner, port);
}

/** The motion-control port of `owner`, if it has one. */
export function motionControlOf(owner: object | null | undefined): MotionControlPort | undefined {
  return owner ? ports.get(owner) : undefined;
}
