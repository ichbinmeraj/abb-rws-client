import { RwsClient2 } from './RwsClient2.js';
import type { IRWSAdapter } from './IRWSAdapter.js';

/**
 * RWS 2.0 adapter that satisfies the `IRWSAdapter` unified interface.
 *
 * Thin wrapper over `RwsClient2` - the protocol-level client. They expose the
 * same public surface (the protocol method set IS the IRWSAdapter contract for
 * RWS 2.0); this class just brands the type with `implements IRWSAdapter` so
 * code that's polymorphic over RWS 1.0 + 2.0 (e.g. RobotManager) can hold
 * either an `RWS1Adapter` or `RWS2Adapter` in a single typed reference.
 *
 * Use directly when you want the unified-adapter API:
 *   `const a: IRWSAdapter = new RWS2Adapter('https://controller', 'Admin', 'robotics');`
 *
 * Use `RwsClient2` directly if you only ever target RWS 2.0 and don't need
 * the abstraction layer.
 */
export class RWS2Adapter extends RwsClient2 implements IRWSAdapter {}
