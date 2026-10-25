import { Logger } from '../Logger.js';
import { IO } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { RwsError, type IoDevice, type IoNetwork, type Signal, type SignalSearchExCriteria } from '../types.js';
import { withReport } from '../refusal.js';
import { ACCEPT_XHTML, nextPagePath, parse, signalLocation } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * Most pages a signal search follows before it stops with a warning: 100
 * pages of 100 hits. No controller seen so far has more than a few hundred
 * signals, so reaching it means a `next` chain that never ends.
 */
const SEARCH_MAX_PAGES = 100;

/**
 * Identity of one search page for the revisit guard: the `start` offset in
 * the page path (0 when absent). The bare search path and
 * `signal-search?start=0&limit=100` are the same page.
 */
function searchPageKey(pagePath: string): string {
  const query = pagePath.split('?')[1] ?? '';
  for (const kv of query.split('&')) {
    const [k, v] = kv.split('=');
    if (k === 'start') { return String(Number(v ?? '0') || 0); }
  }
  return '0';
}

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
          const loc = signalLocation(s);
          if (loc && name) { this.sigCoords.set(name, loc); }
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
     * Criteria compose as AND. Live-verified 2026-08-04 (RW7.21): type filter
     * alone found every DO, device filter scoped correctly. Hits populate the
     * same network/device cache writeSignal uses.
     *
     * `name` is a case-insensitive PREFIX match, not a substring match (the
     * wording up to 2026-09-29 was wrong): `IIO_do` finds IIO_do1..8 and
     * `IIO_DO8` finds IIO_do8, but `do8` and `O_do8` find nothing. There is no
     * glob or regex - `*`, `?` and `.*` match nothing. `device`, `network` and
     * `category` match whole values only (RW 8.1.1: `device=IntegratedIO` 0
     * hits against `IntegratedIOInternalDevice` 26, `network=Int` 0 against
     * `IntBus` 30, `category=int` 0 against `internal` 68); `device` and
     * `category` ignore case (`device=integratedIOInternalDevice` 26), the
     * case of `network` is untested. Sending no criteria at all returns every
     * signal. Verified 2026-09-27 on RW 6.16, 7.21 and 8.1.1 virtual
     * controllers.
     *
     * On the `category` criterion: ABB's RobotWare 7.3.1 notes (§3.1
     * Incompatibilities, RobotWare 7.3.2 release notes p.4; release notes,
     * 2026-09-29) say that RobotWare 7, unlike RobotWare 6, does not set a
     * signal's Category by default - stated there for the FlexPendant IO app's
     * Safety-signals list, not for RWS search. The consequence for this method
     * is ours: a `category` criterion can only match signals whose Category
     * was configured, and on the RW 8.1.1 virtual controller 73 of 141 signals
     * carry an empty Category (2026-09-27), so it finds fewer signals than a
     * RobotWare 6 user would expect.
     *
     * The controller pages the hits at 100 with a `next` link regardless of
     * the criteria (an empty search on RW 8.1.1: 100, then 41, 2026-09-27); a
     * search with 100 hits or fewer carries no `next` (every filtered search
     * captured on 2026-09-27 and 2026-09-29 was under 100 and had none). Every
     * page is read, so the result is the whole hit set; see
     * `searchSignalPages`.
     */
    async searchSignals(criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Promise<Signal[]> {
      const { path, body } = R2.searchSignals(criteria);
      return this.searchSignalPages('searchSignals', path, body);
    }

    /**
     * POST one signal search and follow the controller's `next` links until
     * the last page, re-sending the same criteria body to each page path.
     *
     * RWS 2.0 pages a search at 100 hits like the plain signal list (see
     * `listAllSignals`, whose walk this mirrors): the first answer carries
     * `next` = `signals/signal-search?start=100&limit=100` (or
     * `signal-search-ex`), relative to the response base `/rw/iosystem/`,
     * which is also the base the signal list's links use - hence the same
     * `nextPagePath` resolution against the signals collection path. A POST of
     * the same body to that path answered 200 with the remaining hits and a
     * `first` link but no `next` (RW 8.1.1, 2026-09-27: empty search 100 then
     * 41; `invert=false` on signal-search-ex the same way). Up to 1.3.x only
     * the first page was read, so a search matching more than 100 signals
     * silently returned 100.
     *
     * Stops with a `Logger.warn` at `SEARCH_MAX_PAGES` (10 000 signals), and
     * on a `next` that points back at a page already read (a controller that
     * did so would otherwise duplicate hits until the cap). Pages are told
     * apart by their `start` offset, not by the literal path: the first page
     * is requested at the bare search path while the controller names it
     * `?start=0&limit=100` in its `first` link (RW 8.1.1, 2026-09-27), so a
     * `next` at `?start=0&limit=100` is the first page again, not a new one.
     * A page after the first that fails is not swallowed: the whole search
     * throws, the same as any other RWS error, rather than returning a
     * partial hit set.
     */
    private async searchSignalPages(
      what: string,
      path: string,
      body: Record<string, string> | undefined,
      rawBody?: string,
      rawContentType?: string,
    ): Promise<Signal[]> {
      const out: Signal[] = [];
      const visited = new Set<string>();
      let next = path;
      for (let page = 0; next; page++) {
        if (page >= SEARCH_MAX_PAGES) {
          Logger.warn(`RWS2 ${what}: stopped after ${SEARCH_MAX_PAGES} pages (${out.length} signals) `
            + `with a further page still advertised at ${next} - the result is incomplete`);
          break;
        }
        const key = searchPageKey(next);
        if (visited.has(key)) {
          Logger.warn(`RWS2 ${what}: the controller's next link points back at ${next}, `
            + `a page already read - stopping after ${page} page(s) (${out.length} signals)`);
          break;
        }
        visited.add(key);
        const res = await this.req('POST', next, body, rawBody, rawContentType);
        out.push(...this.parseSignalList(res));
        next = nextPagePath(res, buildPath(IO.listAllSignals.rws2 as PathSpec));
      }
      return out;
    }

    /** Configuration properties of one signal (EIO_SIGNAL instance: category,
     *  device mapping, access, ...). Live-verified 2026-08-04 (RW7.21), class
     *  ios-signal-config-general; read again on RW 7.21.0, 7.21.4, 8.1.1 and
     *  8.2.1 on 2026-10-03 (an unknown signal is refused 400 -1073445879,
     *  INVALID_ARGUMENT). */
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

    /**
     * Release blocked/forced signals (POST /rw/iosystem/signals/unblock-signal).
     */
    async unblockSignals(): Promise<void> {
      await this.req('POST', buildPath(IO.unblockSignals.rws2 as PathSpec));
    }

    /**
     * Start or stop an IO network (`lstate` = start | stop). Changes IO availability.
     */
    async setNetworkLState(network: string, start: boolean): Promise<void> {
      const { path, body } = R2.setNetworkLState(network, start);
      await this.req('POST', path, body);
    }

    /**
     * Enable or disable an IO device (`lstate` = enable | disable). Changes IO availability.
     */
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
     *  2026-08-04 (RW7.21), class ios-network-config-general; read again on
     *  RW 7.21.0, 7.21.4, 8.1.1 and 8.2.1 on 2026-10-03. */
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
     *  2026-08-04 (RW7.21), class ios-device-config-general; read again on
     *  RW 7.21.0, 7.21.4, 8.1.1 and 8.2.1 on 2026-10-03. */
    async getIoDeviceConfig(network: string, device: string): Promise<Record<string, string>> {
      const p = parse(await this.req(
        'GET', buildPath(IO.getIoDeviceConfig.rws2 as PathSpec, { network, device })));
      return p.getState('ios-device-config-general');
    }

    /**
     * Set a signal's value (`POST .../set-value` with `lvalue`).
     *
     * With `network` and `device` both given, the value is written at
     * `/rw/iosystem/signals/{network}/{device}/{name}/set-value`. With either
     * left empty (as `RobotManager.writeIoSignal` does), the client finds where
     * the signal lives, from the signal itself:
     *  1. from what `listAllSignals`, `searchSignals` and `searchSignalsEx`
     *     already read; otherwise
     *  2. with one read by bare name, `GET /rw/iosystem/signals/{name}`, which
     *     answered 200 on RobotWare 6.16, 7.21 and 8.1.1 virtual controllers
     *     (observed 2026-09-27). Its entry's title is `network/device/name`
     *     for a signal bound to a device and the bare name for a signal with
     *     no device. The answer is remembered for later writes.
     *
     * A device-bound signal is then written at its full path, as before. A
     * signal with no device - on RobotWare 7 and 8 the safety controller's
     * SCnCBC* signals, on 8.1.1 also CollaborativeOperationIsActive - is
     * written at `/rw/iosystem/signals/{name}/set-value`: the controller's own
     * resource path for that signal with ABB's `set-value` action appended. Up
     * to 1.3.x every such signal, and every signal not listed first, was
     * refused before sending.
     *
     * That device-less write form has run against RobotWare 8.2.1.
     * Whatever the controller answers is passed on unchanged,
     * and the write is never retried in another form.
     *
     * No mastership or write access is taken: ABB's IO Service lists none for
     * a signal write. The signal's access level decides, and the controller
     * refuses a write the level does not allow (403 `-1073445881`).
     *
     * Refused before any write is sent: a name that is not a bare signal name
     * (letters, digits and underscores; pass network and device separately
     * instead) with `INVALID_ARGUMENT`; a lookup the controller refuses, with
     * that answer's code (`RESOURCE_NOT_FOUND` for an unknown name); and an
     * answer that does not say where the signal lives, with `PARSE_ERROR`. A
     * remembered location the controller answers 404 for is forgotten, so the
     * next write looks the signal up again.
     */
    async writeSignal(network: string, device: string, name: string, value: string): Promise<void> {
      if (network && device) {
        const { path, body } = R2.setSignalValue(network, device, name, value);
        await this.req('POST', path, body);
        return;
      }
      const loc = this.sigCoords.get(name) ?? await this.lookUpSignal(name);
      const { path, body } = loc.n && loc.d
        ? R2.setSignalValue(loc.n, loc.d, name, value)
        : R2.setSignalValueByName(name, value);
      try {
        await this.req('POST', path, body);
      } catch (e) {
        if (e instanceof RwsError && e.httpStatus === 404) { this.sigCoords.delete(name); }
        throw e;
      }
    }

    /**
     * Where a signal lives, read from the signal itself by its bare name, and
     * remembered for `writeSignal`. See `writeSignal` for the refusals.
     */
    private async lookUpSignal(name: string): Promise<{ n: string; d: string }> {
      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new RwsError(
          `writeSignal: ${JSON.stringify(name)} is not a bare I/O signal name (letters, digits and underscores); `
          + 'pass the network and device as their own arguments instead',
          'INVALID_ARGUMENT',
        );
      }
      let body: string;
      try {
        body = await this.req('GET', R2.signalByName(name));
      } catch (e) {
        throw withReport(e, `writeSignal: nothing was written; reading signal "${name}" by name, to learn its network and device, failed.`);
      }
      const entry = parse(body).getAllStates('ios-signal-li')
        .find(s => (s['name'] ?? s['_title']?.split('/').pop() ?? '').toLowerCase() === name.toLowerCase());
      const loc = entry ? signalLocation(entry) : null;
      if (!loc) {
        throw new RwsError(
          `writeSignal: nothing was written; the controller's answer for signal "${name}" does not say which `
          + 'network and device it is on, or that it has none - pass them as their own arguments',
          'PARSE_ERROR',
        );
      }
      this.sigCoords.set(name, loc);
      return loc;
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
     *
     * `name` / `name2` are case-insensitive PREFIX matches, not substring
     * matches; `device`, `network` and `category` match whole values, ignoring
     * case (network re-checked 2026-09-29 on RW 7.21.4+417 and 8.2.1+1023);
     * the second set narrows the first. `invert` (`invert2` for the second
     * set) negates its own criteria set: `type=DO` with `invert=true` gives
     * every signal that is not a DO, and `invert=true` with no other criterion
     * gives nothing (live-verified 2026-09-29 on RW 6.16.03, 7.21.4 and
     * 8.2.1). Verified 2026-09-27 on RW 6.16 (`?action=signal-searchex`), 7.21
     * and 8.1.1. The
     * controller pages the hits at 100 with a `next` link (RW 8.1.1,
     * 2026-09-27: `invert=false` answered 100 plus `next`); every page is read
     * now, see `searchSignalPages`.
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
      return this.searchSignalPages(
        'searchSignalsEx', buildPath(IO.searchSignalsEx.rws2 as PathSpec),
        undefined, parts.join('&'), 'application/x-www-form-urlencoded;v=2.0',
      );
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
