import { IO } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { RwsError, type IoDevice, type IoNetwork, type Signal, type SignalSearchExCriteria } from '../types.js';
import { ACCEPT_XHTML, nextPagePath, parse } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * I/O domain (`/rw/iosystem`): signals, networks, devices.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function ioOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    /**
     * Every configured IO signal, following the controller's pagination.
     *
     * The controller caps a page at 100 signals and IGNORES a larger `limit`:
     * asking for 200, 500 or 1000 all return 100 plus a `next` link. Reading a
     * single page therefore silently truncated the list (100 of 130 on a stock
     * VC). This now walks `next` to the end, like listCfgTypes already did.
     * Live-verified 2026-08 on RW7.21 and RW8.1.1.
     *
     * @param start Index of the first signal (default 0).
     * @param limit Page size hint; the controller may cap it (default 200).
     * @param maxPages Safety bound on how many pages to walk (default 50).
     */
    async listAllSignals(start = 0, limit = 200, maxPages = 50): Promise<Signal[]> {
      const out: Signal[] = [];
      const visited = new Set<string>();
      let path = `${buildPath(IO.listAllSignals.rws2 as PathSpec)}?start=${start}&limit=${limit}`;
      for (let page = 0; path && page < maxPages; page++) {
        // A controller that advertises a `next` pointing back at the current page
        // would otherwise spin until maxPages, silently duplicating entries.
        if (visited.has(path)) { break; }
        visited.add(path);
        const body = await this.req('GET', path);
        const p = parse(body);
        for (const s of p.getAllStates('ios-signal-li')) {
          const name  = s['name'] ?? s['_title']?.split('/').pop() ?? '';
          const parts = (s['_title'] ?? '').split('/');
          if (parts.length >= 3) { this.sigCoords.set(name, { n: parts[0], d: parts[1] }); }
          out.push({ name, value: s['lvalue'] ?? '0', type: (s['type'] ?? 'DI') as Signal['type'], lvalue: s['lvalue'] ?? '0' });
        }
        path = nextPagePath(body, buildPath(IO.listAllSignals.rws2 as PathSpec));
      }
      return out;
    }

    async readSignal(network: string, device: string, name: string): Promise<Signal> {
      const p = parse(await this.req('GET', buildPath(IO.readSignal.rws2 as PathSpec, { network, device, name })));
      const d = p.getState('ios-signal-li');
      return { name: d['name'] ?? name, value: d['lvalue'] ?? '0', type: (d['type'] ?? 'DI') as Signal['type'], lvalue: d['lvalue'] ?? '0' };
    }

    /**
     * Search IO signals by criteria instead of paging through the full list.
     * `name` is a SUBSTRING match (not a wildcard - '*' matches nothing); criteria
     * compose as AND. Live-verified 2026-08-04 (RW7.21): type filter alone found
     * every DO, device filter scoped correctly. Hits populate the same
     * network/device cache writeSignal uses.
     */
    async searchSignals(criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Promise<Signal[]> {
      const { path, body } = R2.searchSignals(criteria);
      return this.parseSignalList(await this.req('POST', path, body));
    }

    /** Configuration properties of one signal (EIO_SIGNAL instance: category,
     *  device mapping, access, ...). Live-verified 2026-08-04 (RW7.21), class
     *  ios-signal-config-general. */
    async getSignalConfig(network: string, device: string, name: string): Promise<Record<string, string>> {
      const p = parse(await this.req(
        'GET', buildPath(IO.getSignalConfig.rws2 as PathSpec, { network, device, name })));
      return p.getState('ios-signal-config-general');
    }

    /** Simulate (force) or un-simulate an IO signal's logical state. Reversible;
     *  the controller form takes `lstate` = 'simulated' | 'not simulated'. */
    async setSignalSimulated(network: string, device: string, name: string, simulated: boolean): Promise<void> {
      const { path, body } = R2.setSignalSimulated(network, device, name, simulated);
      await this.req('POST', path, body);
    }

    /** Release blocked/forced signals (POST /rw/iosystem/signals/unblock-signal). */
    async unblockSignals(): Promise<void> {
      await this.req('POST', buildPath(IO.unblockSignals.rws2 as PathSpec));
    }

    /** Start or stop an IO network (`lstate` = start | stop). Changes IO availability. */
    async setNetworkLState(network: string, start: boolean): Promise<void> {
      const { path, body } = R2.setNetworkLState(network, start);
      await this.req('POST', path, body);
    }

    /** Enable or disable an IO device (`lstate` = enable | disable). Changes IO availability. */
    async setIoDeviceLState(network: string, device: string, enable: boolean): Promise<void> {
      const { path, body } = R2.setIoDeviceLState(network, device, enable);
      await this.req('POST', path, body);
    }

    /** Search the hardware device tree for a node. The controller field is
     *  `property` (singular, not the OPTIONS-advertised `properties`); the value is
     *  a device-tree node path. Returns the matching device rows. */
    async searchDevices(property: string): Promise<Array<Record<string, string>>> {
      const { path, body } = R2.searchDevices(property);
      const p = parse(await this.req('POST', path, body));
      return p.getAllStates('dev-id-li');
    }

    /** Device groups the controller reports, e.g. HW_DEVICES and SW_RESOURCES. */
    async listDeviceGroups(): Promise<string[]> {
      const p = parse(await this.req('GET', '/rw/devices'));
      return p.getAllStates('dev-group-li')
        .concat(p.getAllStates('dev-id-li'))
        .map(s => s['_title'] ?? '')
        .filter(Boolean);
    }

    /**
     * Devices in one controller device group: HW_DEVICES lists the drive links,
     * mechanical units and FlexPendant; SW_RESOURCES lists RobAPI, System, RAPID
     * and the rest. Distinct from `listDevices`, which lists I/O devices on a
     * fieldbus network.
     * Live-verified 2026-08-06 on RW7.21 and RW8.1.1, class dev-id-li.
     */
    async listControllerDevices(group: string): Promise<Array<{ id: string; name: string }>> {
      const p = parse(await this.req('GET', `/rw/devices/${encodeURIComponent(group)}`));
      return p.getAllStates('dev-id-li').map(s => ({
        id: s['_title'] ?? '',
        name: s['name'] ?? '',
      }));
    }

    /** Detail of one IO network (name, pstate, lstate). Live-verified 2026-08-04
     *  (RW7.21), class ios-network-li. */
    async getIoNetwork(network: string): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(IO.getIoNetwork.rws2 as PathSpec, { network })));
      return p.getState('ios-network-li');
    }

    /** Configuration of one IO network (its cfg instance). Live-verified
     *  2026-08-04 (RW7.21), class ios-network-config-general. */
    async getIoNetworkConfig(network: string): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(IO.getIoNetworkConfig.rws2 as PathSpec, { network })));
      return p.getState('ios-network-config-general');
    }

    /** Detail of one IO device. Live-verified 2026-08-04 (RW7.21), class
     *  ios-device-li. */
    async getIoDeviceInfo(network: string, device: string): Promise<Record<string, string>> {
      const p = parse(await this.req(
        'GET', buildPath(IO.getIoDeviceInfo.rws2 as PathSpec, { network, device })));
      return p.getState('ios-device-li');
    }

    /** Configuration of one IO device (its cfg instance). Live-verified
     *  2026-08-04 (RW7.21), class ios-device-config-general. */
    async getIoDeviceConfig(network: string, device: string): Promise<Record<string, string>> {
      const p = parse(await this.req(
        'GET', buildPath(IO.getIoDeviceConfig.rws2 as PathSpec, { network, device })));
      return p.getState('ios-device-config-general');
    }

    writeSignal(network: string, device: string, name: string, value: string): Promise<void> {
      let n = network, d = device;
      if (!n || !d) {
        const c = this.sigCoords.get(name);
        if (!c) {
          // Without coordinates the URL would degenerate to /signals///{name}/set-value.
          return Promise.reject(new RwsError(
            `writeSignal: network/device unknown for signal "${name}" - pass them explicitly or call listAllSignals() first`,
            'UNKNOWN',
          ));
        }
        n = c.n; d = c.d;
      }
      const { path, body } = R2.setSignalValue(n, d, name, value);
      return this.req('POST', path, body).then(() => {});
    }

    async listNetworks(): Promise<IoNetwork[]> {
      const p = parse(await this.req('GET', buildPath(IO.listNetworks.rws2 as PathSpec)));
      // Live: <li class="ios-network-li" title="IntegratedIONetwork">
      //   <span class="name">IntegratedIONetwork</span><span class="pstate">running</span><span class="lstate">started</span>
      return p.getAllStates('ios-network-li').map(n => ({
        name:   n['name']   ?? n['_title'] ?? '',
        pstate: n['pstate'] ?? '',
        lstate: n['lstate'] ?? '',
      }));
    }

    async listDevices(network: string): Promise<IoDevice[]> {
      const p = parse(await this.req('GET', `${buildPath(IO.listDevices.rws2 as PathSpec)}?network=${encodeURIComponent(network)}`));
      // Live: <li class="ios-device-li" title="IntBus/EPanel">
      //   <span class="name">EPanel</span><span class="lstate">enabled</span><span class="pstate">running</span><span class="address"></span>
      return p.getAllStates('ios-device-li').map(d => ({
        name:    d['name']    ?? d['_title']?.split('/').pop() ?? '',
        network,
        lstate:  d['lstate']  ?? '',
        pstate:  d['pstate']  ?? '',
        address: d['address'] ?? '',
      }));
    }

    /**
     * List the top-level device groupings (typically HW_DEVICES, SW_RESOURCES).
     * This is the entry point for the controller's hardware inventory tree.
     * Drill into each group with `getDeviceTree(group)`.
     */
    async listSystemDevices(): Promise<Array<{ id: string; name: string }>> {
      const p = parse(await this.req('GET', '/rw/devices'));
      return p.getAllStates('dev-id-li').map(d => ({
        id:   d['_title'] ?? '',
        name: d['name']   ?? '',
      }));
    }

    /** Drill into a device group (e.g. 'HW_DEVICES'). Returns sub-tree as raw XHTML map.
     *  Accept is pinned to XHTML so the promised raw format never changes under
     *  the HAL JSON negotiation. */
    async getDeviceTree(group: string): Promise<string> {
      return this.req('GET', `/rw/devices/${encodeURIComponent(group)}`,
        undefined, undefined, undefined, [], ACCEPT_XHTML);
    }

    /**
     * List ALL configured I/O devices across every network in one call.
     * (`listDevices(network)` is the per-network variant - both are fine; this
     * one's handy when you want a flat overview without enumerating networks first.)
     */
    async listAllIoDevices(): Promise<Array<{ name: string; network: string; lstate: string; pstate: string; address: string }>> {
      const p = parse(await this.req('GET', buildPath(IO.listAllIoDevices.rws2 as PathSpec)));
      return p.getAllStates('ios-device-li').map(d => {
        const title = d['_title'] ?? '';
        const network = title.split('/')[0] ?? '';
        return {
          name:    d['name']   ?? '',
          network,
          lstate:  d['lstate'] ?? '',
          pstate:  d['pstate'] ?? '',
          address: d['address'] ?? '',
        };
      });
    }

    /**
     * Extended signal search. POST /rw/iosystem/signals/signal-search-ex.
     *
     * The OPTIONS form advertises each criterion twice (`name`/`name2`,
     * `device`/`device2`, ...), so the controller accepts up to two criteria sets.
     * The second set NARROWS the first - it is a logical AND, not a union.
     * Live-verified 2026-08-09 on RW8.1.1: DI alone 33 signals, DO alone 39,
     * DI∩DI 33, DI∩DO 0. The form has no third set, so more than two criteria
     * cannot be expressed and this refuses them client-side rather than silently
     * dropping the extras.
     *
     * Note the controller does NOT glob: `name: '*'` matches nothing. Pass no
     * criteria fields at all to list everything.
     */
    async searchSignalsEx(criteria: SignalSearchExCriteria[]): Promise<Signal[]> {
      if (criteria.length === 0 || criteria.length > 2) {
        throw new RwsError(
          `signal-search-ex takes 1 or 2 criteria sets, got ${criteria.length}`,
          'INVALID_ARGUMENT',
        );
      }
      const parts: string[] = [];
      criteria.forEach((c, i) => {
        const sfx = i === 0 ? '' : '2';
        const put = (k: string, v: string | undefined): void => {
          if (v !== undefined && v !== '') { parts.push(`${k}${sfx}=${encodeURIComponent(v)}`); }
        };
        put('name', c.name);
        put('device', c.device);
        put('network', c.network);
        put('category', c.category);
        put('category-pon', c.categoryPon);
        put('type', c.type);
        if (c.invert !== undefined) { parts.push(`invert${sfx}=${c.invert}`); }
        if (c.blocked !== undefined) { parts.push(`blocked${sfx}=${c.blocked}`); }
      });
      const html = await this.req(
        'POST', buildPath(IO.searchSignalsEx.rws2 as PathSpec),
        undefined, parts.join('&'), 'application/x-www-form-urlencoded;v=2.0',
      );
      return this.parseSignalList(html);
    }

    /**
     * Search I/O devices by criteria. Distinct from `searchDevices`, which
     * searches the `/rw/devices` hardware tree - this searches the I/O device
     * collection. Uses the `?action=search` query-action (the `/device-search`
     * and `/search` sub-paths 405 on RW7.21); at least one of `name` or `lstate`
     * is required. Live-verified on OmniCore RW7.21 (2026-08-11).
     */
    async searchIoDevices(criteria: { name?: string; lstate?: 'enabled' | 'disabled' | 'unknown'; network?: string }): Promise<IoDevice[]> {
      if (!criteria.name && !criteria.lstate) {
        throw new RwsError('searchIoDevices: at least one of name or lstate is required', 'INVALID_ARGUMENT');
      }
      const body: Record<string, string> = {};
      if (criteria.name)    { body['name'] = criteria.name; }
      if (criteria.lstate)  { body['lstate'] = criteria.lstate; }
      if (criteria.network) { body['network'] = criteria.network; }
      const p = parse(await this.req('POST', buildPath(IO.searchIoDevices.rws2 as PathSpec), body));
      return p.getAllStates('ios-device-li').map(d => {
        const network = (d['_title'] ?? '').split('/')[0] ?? '';
        return { name: d['name'] ?? '', network, lstate: d['lstate'] ?? '', pstate: d['pstate'] ?? '', address: d['address'] ?? '' };
      });
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface IoMethods {
  listAllSignals(start?: number, limit?: number, maxPages?: number): Promise<Signal[]>;
  readSignal(network: string, device: string, name: string): Promise<Signal>;
  searchSignals(criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Promise<Signal[]>;
  getSignalConfig(network: string, device: string, name: string): Promise<Record<string, string>>;
  setSignalSimulated(network: string, device: string, name: string, simulated: boolean): Promise<void>;
  unblockSignals(): Promise<void>;
  setNetworkLState(network: string, start: boolean): Promise<void>;
  setIoDeviceLState(network: string, device: string, enable: boolean): Promise<void>;
  searchDevices(property: string): Promise<Array<Record<string, string>>>;
  listDeviceGroups(): Promise<string[]>;
  listControllerDevices(group: string): Promise<Array<{ id: string; name: string }>>;
  getIoNetwork(network: string): Promise<Record<string, string>>;
  getIoNetworkConfig(network: string): Promise<Record<string, string>>;
  getIoDeviceInfo(network: string, device: string): Promise<Record<string, string>>;
  getIoDeviceConfig(network: string, device: string): Promise<Record<string, string>>;
  writeSignal(network: string, device: string, name: string, value: string): Promise<void>;
  listNetworks(): Promise<IoNetwork[]>;
  listDevices(network: string): Promise<IoDevice[]>;
  listSystemDevices(): Promise<Array<{ id: string; name: string }>>;
  getDeviceTree(group: string): Promise<string>;
  listAllIoDevices(): Promise<Array<{ name: string; network: string; lstate: string; pstate: string; address: string }>>;
  searchSignalsEx(criteria: SignalSearchExCriteria[]): Promise<Signal[]>;
  searchIoDevices(criteria: { name?: string; lstate?: 'enabled' | 'disabled' | 'unknown'; network?: string }): Promise<IoDevice[]>;
}

/** Guard: the mixin class must provide every IoMethods member (never exported). */
type _IoMethodsComplete = InstanceType<ReturnType<typeof ioOps>> extends IoMethods ? true : never;
const _ioComplete: _IoMethodsComplete = true;
void _ioComplete;

export function IoOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<IoMethods> {
  return ioOps(Base) as unknown as TBase & GConstructor<IoMethods>;
}
