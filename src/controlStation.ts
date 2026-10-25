import { RwsError } from './types.js';

/**
 * The control station this client registers as on a RobotWare 8 controller.
 *
 * RobotWare 8 replaces mastership with control-station write access: before a
 * session may request write access it registers as a remote control station
 * (`POST /rw/controlstation/register/remote`), and the controller shows the
 * station's name as the write-access holder. Registration binds one HTTP
 * session, so the client registers again on every new session; the identity
 * it registers with is what these options fix.
 *
 * Supply all three values from your own configuration, and keep them stable:
 * generate the id once (for example `{${crypto.randomUUID()}}`), store it, and
 * pass the same value on every run, so the controller sees one station rather
 * than a new one per process or reconnect. The client keeps both the id and
 * the PIN out of its logs.
 *
 * Used on RobotWare 8 only. RobotWare 6 and 7 have no control stations and
 * ignore it.
 *
 * Without this option the client keeps its earlier behaviour: an anonymous
 * station named `abb-rws-client` with an id generated for each client instance
 * and the PIN `1234`, noted once per client instance in the log.
 */
export interface ControlStationIdentity {
  /**
   * The name the controller shows as the write-access holder (for example
   * `RWS Daemon on cell-7-pc`). Must not be empty.
   */
  name: string;
  /**
   * A braced GUID, 38 characters: `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`.
   * ABB's Control Station Service gives the id as 38 characters long, and
   * length is what the controller was seen to check: RW 8.2.1 registered
   * every 38-character id tried (a braced non-hex string, braced hex without
   * hyphens, a braced lower-case GUID, an unbraced 38-character string) and
   * refused 10, 37 and 39 characters, and an unbraced 36-character GUID, with
   * 400 `-1073435867` "Control station id not allowed" (live-verified
   * 2026-09-29; the accepted character set was not tested; RW 8.1.1 refused
   * an unbraced GUID the same way, 2026-09-15 and 2026-09-27). The
   * braced-GUID form is this client's own convention, and any other form is
   * refused here, before anything is sent.
   */
  id: string;
  /**
   * The PIN sent with the registration: digits only, at most 11 (ABB documents
   * an integer "with up to 11 digits"). RW 8.1.1 and RW 8.2.1 virtual
   * controllers refused `abcd` and a 12-digit value with 400 `-1073445879`,
   * and registered `1234` and an empty value (8.1.1 also `9999`;
   * live-verified 2026-09-15, 2026-09-27 and, on 8.2.1, 2026-09-29). Whether
   * a controller with a PIN configured refuses a wrong one has not been
   * tested.
   */
  pincode: string;
  /**
   * Ask the controller to release write access automatically when the station
   * is lost. Default false.
   *
   * Sent as the optional `release-write-access-when-lost=TRUE` field of the
   * registration, which ABB documents in the RobotWare 8 Control Station
   * Service (typed `{TRUE|FALSE}`, default false): the controller then
   * "decides to release Write Access automatically if the last session
   * connected to the station is lost". ABB does not define what counts as
   * lost. Pending live confirmation: this client has not yet sent the field to
   * a controller, so both the accepted value form and the effect are
   * unconfirmed. When false or omitted the field is not sent and the
   * controller's default applies. Either way the client still releases write
   * access itself at the end of every operation that took it.
   */
  releaseWriteAccessWhenLost?: boolean;
}

/** `{8-4-4-4-12}` hex digits, braces included: the 38-character form. */
const BRACED_GUID = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;

/** Digits only, at most 11. */
const PINCODE = /^[0-9]{0,11}$/;

/**
 * Check a caller-supplied station identity and return a normalised copy.
 * Throws `INVALID_ARGUMENT` naming the field that is wrong; neither the id nor
 * the PIN is ever echoed. `where` names the option in the message, for example
 * `ConnectOptions.controlStation`.
 *
 * @internal
 */
export function checkControlStationIdentity(identity: unknown, where: string): ControlStationIdentity {
  const bad = (what: string): RwsError => new RwsError(`${where}${what}`, 'INVALID_ARGUMENT');
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    throw bad(' must be an object { name, id, pincode, releaseWriteAccessWhenLost? }');
  }
  const { name, id, pincode, releaseWriteAccessWhenLost } = identity as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '') {
    throw bad('.name must be a non-empty string: the name the controller shows as the write-access holder');
  }
  if (typeof id !== 'string' || !BRACED_GUID.test(id)) {
    throw bad('.id must be a braced GUID of 38 characters, {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}, generated once and stored; the controller refuses an id that is not 38 characters long, and this client requires the braced-GUID form');
  }
  if (typeof pincode !== 'string' || !PINCODE.test(pincode)) {
    throw bad('.pincode must be a string of digits, at most 11 (ABB documents an integer with up to 11 digits)');
  }
  if (releaseWriteAccessWhenLost !== undefined && typeof releaseWriteAccessWhenLost !== 'boolean') {
    throw bad('.releaseWriteAccessWhenLost must be true or false when given');
  }
  return { name, id, pincode, releaseWriteAccessWhenLost: releaseWriteAccessWhenLost === true };
}
