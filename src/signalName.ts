import { RwsError } from './types.js';

/**
 * An I/O signal name as the controller forms it: letters, digits and
 * underscores, alone or as `network/device/signal`.
 *
 * Both subscribers write the name into the subscription body verbatim -
 * semicolons there must stay literal, so nothing is percent-encoded - and the
 * RWS 2.0 one into a DELETE path as well. A '&' or '=' would add form fields
 * to the body; a '?', '#' or '..' segment would aim the path at a different
 * resource once the URL is parsed. One pattern for both generations, since
 * `IRWSAdapter.subscribe` hands a caller's names to either.
 */
const SIGNAL_NAME = /^(?:[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/)?[A-Za-z0-9_]+$/;

/** Refuse anything that is not an I/O signal name with INVALID_ARGUMENT. */
export function assertSignalName(name: unknown): void {
  if (typeof name !== 'string' || !SIGNAL_NAME.test(name)) {
    throw new RwsError(
      `signal name ${JSON.stringify(name)} is not an I/O signal name: letters, digits and underscores only, optionally as network/device/signal`,
      'INVALID_ARGUMENT',
    );
  }
}
