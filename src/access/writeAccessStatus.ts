/**
 * The strict reading of RobotWare 8's control-station write-access status
 * (`GET /rw/controlstation/writeaccess/status`), for
 * `RobotManager.getWriteAccessStatus`.
 *
 * `RwsClient2.getWriteAccessStatus()` keeps its own reading: it turns an absent
 * field into `false` / `'none'`, and the holder lookups inside the client rely
 * on that shape. This reading reports only what the answer said and leaves
 * every other field null, so "nobody holds write access" is never stated for
 * an answer that did not say it.
 *
 * Internal: not exported from the package; the result type
 * (`WriteAccessStatus`) is.
 */

import { parseBody, pickEntry } from '../commonReads.js';
import type { WriteAccessStatus } from '../types.js';

/**
 * The status entry's class, the same in the hal+json and XHTML answers. The
 * fields are texts: RobotWare 8.1.1+614 and 8.2.1+1023 answered
 * `"control-station-write-access-held": "true"` with the holder's id and name
 * while a station held write access, and `"false"` with id and name `none`
 * once it was released, `control-station-external-control-enabled` `"true"`
 * throughout (hal+json, read 2026-10-05 and 2026-10-06); 8.2.1+1023 served the
 * same four fields as spans in its XHTML answer (2026-09-29).
 */
export const WRITE_ACCESS_STATUS_CLASS = 'controlstation-write-access-status';

const HELD = 'control-station-write-access-held';
const HOLDER_ID = 'held-by-control-station-Id';
const HOLDER_NAME = 'held-by-control-station-name';
const EXTERNAL_CONTROL = 'control-station-external-control-enabled';

/** True only for the text `true`, false only for the text `false`, else null. */
function flag(v: string | undefined): boolean | null {
  return v === 'true' ? true : v === 'false' ? false : null;
}

/** The text as given, or null when absent, empty or the controller's `none`. */
function named(v: string | undefined): string | null {
  return v === undefined || v === '' || v === 'none' ? null : v;
}

/**
 * The write-access status in `body` (hal+json or XHTML). `ownStationId` is the
 * control-station id this client registers as; it is only compared with the
 * holder id, and neither id is in the result.
 *
 * Throws `RwsError` `PARSE_ERROR` when the answer carries no status entry at
 * all (an empty body included). An entry that is present but lacks a field
 * gives null for that field.
 */
export function writeAccessStatusFrom(body: string, ownStationId: string, what: string): WriteAccessStatus {
  const d = pickEntry(parseBody(body).getAllEntries(), [WRITE_ACCESS_STATUS_CLASS], what);
  const held = flag(d[HELD]);
  const holderId = named(d[HOLDER_ID]);
  let heldByMe: boolean | null;
  if (held === null) {
    heldByMe = null;
  } else if (held === false) {
    heldByMe = false;
  } else {
    heldByMe = holderId === null ? null : holderId.toLowerCase() === ownStationId.toLowerCase();
  }
  return {
    held,
    heldByMe,
    heldByName: named(d[HOLDER_NAME]),
    externalControlEnabled: flag(d[EXTERNAL_CONTROL]),
  };
}

// ─── Which client reads the status for which owner ──────────────────────────

const readers = new WeakMap<object, () => Promise<WriteAccessStatus>>();

/** Record that `owner` (an RWS 2.0 client or adapter) reads the status with `read`. */
export function bindWriteAccessStatusReader(owner: object, read: () => Promise<WriteAccessStatus>): void {
  readers.set(owner, read);
}

/** The strict status read of `owner`, if it has one (RWS 2.0 clients built by this package). */
export function writeAccessStatusReaderOf(owner: object | null | undefined): (() => Promise<WriteAccessStatus>) | undefined {
  return owner ? readers.get(owner) : undefined;
}
