import { RwsError, type SignalCategoryInfo, type SystemSignalBinding } from './types.js';
import type { IRWSAdapter } from './IRWSAdapter.js';

/**
 * The signals the controller's configuration binds to a system action:
 * SYSSIG_IN (a signal that starts, stops, turns motors on, ...) and
 * SYSSIG_OUT (a signal the controller drives with its state). Writing a
 * system input is operating the robot, not setting an I/O value, so a tool
 * that offers signal writes asks here first (1.6.0).
 *
 * Both domains are read. RobotWare 7 and 8 keep the bindings under SYS (RW
 * 7.21.4 and 8.2.1 list `MotLmpPB` there) and still serve the EIO types,
 * empty. RobotWare 6.16.03 keeps them under EIO and answers the SYS types
 * 400 "Invalid type id" (all recorded 2026-09-29).
 */
const SOURCES = [
  { domain: 'SYS', type: 'SYSSIG_IN', category: 'system-input' },
  { domain: 'SYS', type: 'SYSSIG_OUT', category: 'system-output' },
  { domain: 'EIO', type: 'SYSSIG_IN', category: 'system-input' },
  { domain: 'EIO', type: 'SYSSIG_OUT', category: 'system-output' },
] as const;

/** The controller's code for a CFG type the domain does not have (RW 6.16.03 SYS/SYSSIG_*). */
export const CFG_INVALID_TYPE_ID = -1073437695;

/**
 * Every system-signal binding, from the four CFG lists. The signal is the
 * `Signal` attribute (RW 6.16.03, whose instances have no title) or the
 * `Name` attribute (RW 7.21.4 and 8.2.1); the action is `Action` on an input
 * and `Status` on an output. Fails closed: a refusal other than "Invalid type
 * id", an answer that is not a listing, an instance that names no signal, or
 * inputs or outputs that neither domain serves throws, so a caller never
 * reads a partial list as "no system inputs". UNSUPPORTED_OPERATION when the
 * adapter has no listCfgInstancesDetailed.
 */
export async function readSystemSignals(adapter: IRWSAdapter): Promise<readonly SystemSignalBinding[]> {
  if (!adapter.listCfgInstancesDetailed) {
    throw new RwsError('listSystemSignals: this adapter cannot list CFG instances with their attributes', 'UNSUPPORTED_OPERATION');
  }
  const out: SystemSignalBinding[] = [];
  const served = new Set<string>();
  for (const source of SOURCES) {
    let instances;
    try {
      instances = await adapter.listCfgInstancesDetailed(source.domain, source.type);
    } catch (e) {
      if (e instanceof RwsError && e.controllerCode === CFG_INVALID_TYPE_ID) { continue; }
      throw e;
    }
    served.add(source.category);
    for (const instance of instances) {
      const signal = instance.attributes['Signal'] || instance.attributes['Name'];
      if (!signal) {
        throw new RwsError(
          `listSystemSignals: a ${source.domain}/${source.type} instance (${instance.name || 'no name'}) names no signal`,
          'PARSE_ERROR',
        );
      }
      const action = (source.category === 'system-input' ? instance.attributes['Action'] : instance.attributes['Status']) ?? '';
      out.push(Object.freeze({ signal, category: source.category, action, domain: source.domain }));
    }
  }
  for (const category of ['system-input', 'system-output'] as const) {
    if (!served.has(category)) {
      const type = category === 'system-input' ? 'SYSSIG_IN' : 'SYSSIG_OUT';
      throw new RwsError(`listSystemSignals: neither SYS nor EIO serves ${type} ("Invalid type id" from both), so no signal can be called plain`, 'UNSUPPORTED_OPERATION');
    }
  }
  return Object.freeze(out);
}

/**
 * One signal's category from the bindings. Names match without regard to
 * case, and a signal bound as an input anywhere is a system input, even when
 * it is also bound as an output. `actions` lists every distinct action and
 * status it is bound to, in the order read.
 */
export function signalCategoryOf(bindings: readonly SystemSignalBinding[], name: string): SignalCategoryInfo {
  const key = name.toLowerCase();
  const mine = bindings.filter(b => b.signal.toLowerCase() === key);
  const category = mine.some(b => b.category === 'system-input') ? 'system-input'
    : mine.length > 0 ? 'system-output' : 'plain';
  return Object.freeze({ category, actions: Object.freeze([...new Set(mine.map(b => b.action).filter(Boolean))]) });
}
