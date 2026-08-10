import { Rws2Core } from './rws2/core.js';
import { PanelOps } from './rws2/panel.js';

/**
 * RWS 2.0 protocol client for ABB OmniCore controllers (RobotWare 7.x / 8.x).
 *
 * The transport, connection, subscription, and write-access (mastership /
 * control-station) machinery lives in {@link Rws2Core}; the endpoint methods are
 * organised into per-domain mixins under `src/rws2/` and composed onto this
 * class. Splitting by RWS domain (panel, rapid, motion, io, ...) mirrors how ABB
 * organises RWS itself, so a protocol change lands in one obvious module. The
 * public surface is unchanged: every method that was on `RwsClient2` is still a
 * method on `RwsClient2`.
 *
 * If you don't know which protocol your controller uses, prefer
 * `createClient(host)` from this package - it probes the auth challenge and
 * returns the right client.
 */
export class RwsClient2 extends PanelOps(Rws2Core) {}
