import { CFG_ELOG_DIPC } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { decodeElogArgs, type CfgValidateRequest, type ElogMessage } from '../types.js';
import { nextPagePath, parse } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * Configuration (`/rw/cfg`), event log (`/rw/elog`) and DIPC (`/rw/dipc`) domains.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function cfgElogDipcOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    /**
     * Event-log messages for a domain, following the controller's pagination.
     *
     * The controller serves 50 messages per page and advertises a `next` link;
     * reading one page returned 50 of the 146 messages a live controller held.
     * This walks `next` until the log is exhausted. Note that a domain can hold
     * far more than one page - use listEventLogDomains() to see the counts, and
     * `maxPages` to bound the walk.
     *
     * @param domain Log domain (0 = the common controller log).
     * @param lang Message language (default 'en').
     * @param maxPages Safety bound on pages to walk (default 20, so up to ~1000).
     */
    async getEventLog(
      domain = 0, lang = 'en', maxPages = 20, order: 'oldest' | 'newest' = 'oldest',
    ): Promise<ElogMessage[]> {
      // lang required to get title/desc/causes/actions (confirmed by live probe)
      const out: ElogMessage[] = [];
      const visited = new Set<string>();
      // Newest-first needs the undocumented v=2.1 media type. Under v=2.0 the
      // controller refuses order=lifo outright: 400 "LIFO is not supported in
      // v=2.0, Use v=2.1 to list Elog messages in LIFO order." The event log is
      // the only resource that accepts v=2.1 - every other one answers 406 - and
      // the response is still labelled v=2.0. Live-verified 2026-08-06 on RW7.21
      // and RW8.1.1.
      const newest = order === 'newest';
      const accept = newest ? 'application/hal+json;v=2.1' : undefined;
      let path = newest ? `${R2.elogMessages(domain, lang)}&order=lifo` : R2.elogMessages(domain, lang);
      for (let page = 0; path && page < maxPages; page++) {
        if (visited.has(path)) { break; }   // guard against a self-referential `next`
        visited.add(path);
        const body = await this.req('GET', path, undefined, undefined, undefined, [], accept);
        const p = parse(body);
        for (const m of p.getAllStates('elog-message-li')) {
          const parts = (m['_title'] ?? '').split('/');
          out.push({
            seqnum:       Number(parts[parts.length - 1] ?? 0),
            code:         Number(m['code']    ?? 0),
            msgtype:      Number(m['msgtype'] ?? 1) as 1 | 2 | 3,
            timestamp:    m['tstamp']  ?? '',
            srcName:      m['src-name'] ?? '',
            title:        m['title']   ?? `Event ${m['code']}`,
            desc:         m['desc']    ?? '',
            causes:       m['causes']  ?? '',
            consequences: m['conseqs'] ?? '',
            actions:      m['actions'] ?? '',
            args:         decodeElogArgs(m),
          });
        }
        path = nextPagePath(body, buildPath(CFG_ELOG_DIPC.getEventLog.rws2 as PathSpec, { domain }));
      }
      return out;
    }

    clearEventLog(domain = 0): Promise<void> {
      const { path } = R2.clearElogDomain(domain);
      return this.req('POST', path).then(() => {});
    }

    clearAllEventLogs(): Promise<void> {
      // Live confirmed: POST /rw/elog/clearall → 204
      const { path } = R2.clearAllElogs();
      return this.req('POST', path).then(() => {});
    }

    /** One event-log message by domain and sequence number. Live-verified
     *  2026-08-04 (RW7.21), class elog-message. Returns null when unknown. */
    async getEventLogMessage(domain: number, seqnum: number, lang = 'en'): Promise<ElogMessage | null> {
      try {
        const p = parse(await this.req('GET', `${buildPath(CFG_ELOG_DIPC.getEventLogMessage.rws2 as PathSpec, { domain, seqnum })}?lang=${encodeURIComponent(lang)}`));
        const m = p.getState('elog-message');
        if (!m['code']) { return null; }
        return {
          seqnum, code: Number(m['code'] ?? 0), msgtype: Number(m['msgtype'] ?? 1) as 1 | 2 | 3,
          timestamp: m['tstamp'] ?? '', srcName: m['src-name'] ?? '',
          title: m['title'] ?? `Event ${m['code']}`, desc: m['desc'] ?? '',
          causes: m['causes'] ?? '', consequences: m['conseqs'] ?? '', actions: m['actions'] ?? '',
          args: decodeElogArgs(m),
        };
      } catch { return null; }
    }

    /** One event-log message by global sequence number (across domains).
     *  Live-verified 2026-08-04 (RW7.21): GET /rw/elog/seqnum/{n}. */
    async getEventLogMessageBySeqnum(seqnum: number, lang = 'en'): Promise<ElogMessage | null> {
      try {
        const p = parse(await this.req('GET', `${buildPath(CFG_ELOG_DIPC.getEventLogMessageBySeqnum.rws2 as PathSpec, { seqnum })}?lang=${encodeURIComponent(lang)}`));
        const m = p.getState('elog-message');
        if (!m['code']) { return null; }
        return {
          seqnum, code: Number(m['code'] ?? 0), msgtype: Number(m['msgtype'] ?? 1) as 1 | 2 | 3,
          timestamp: m['tstamp'] ?? '', srcName: m['src-name'] ?? '',
          title: m['title'] ?? `Event ${m['code']}`, desc: m['desc'] ?? '',
          causes: m['causes'] ?? '', consequences: m['conseqs'] ?? '', actions: m['actions'] ?? '',
          args: decodeElogArgs(m),
        };
      } catch { return null; }
    }

    /** Dump the full event log to a file in system-dump format (diagnostics/support).
     *  POST /rw/elog/saveraw, field `path`. The path is normalized to the
     *  fileservice-URI form the controller requires ('TEMP/x' works as input);
     *  bare volume roots answer "Virtual root does not exist". Live round-tripped
     *  2026-08-04 (RW7.21): 202 Accepted, dump file created. */
    saveEventLogRaw(destination: string): Promise<void> {
      const { path, body } = R2.saveEventLogRaw(destination);
      return this.req('POST', path, body).then(() => {});
    }

    /**
     * List the event-log domains the controller actually serves, with how many
     * events each holds and its buffer size. Discovered by crawling the /rw/elog
     * root, which advertises a domain per entry (class elog-domain-li). Useful
     * because getEventLog() defaults to domain 0, while a live controller also
     * carries messages in other domains (0, 1 and 9 were populated on RW7.21).
     */
    async listEventLogDomains(): Promise<Array<{ domain: number; events: number; bufferSize: number }>> {
      const p = parse(await this.req('GET', buildPath(CFG_ELOG_DIPC.listEventLogDomains.rws2 as PathSpec)));
      return p.getAllStates('elog-domain-li').map(d => ({
        domain: Number(d['_title'] ?? 0),
        events: Number(d['numevts'] ?? 0),
        bufferSize: Number(d['buffsize'] ?? 0),
      }));
    }

    async listCfgDomains(): Promise<string[]> {
      const p = parse(await this.req('GET', buildPath(CFG_ELOG_DIPC.listCfgDomains.rws2 as PathSpec)));
      return p.getAllStates('cfg-domain-li').map(d => d['_title'] ?? d['name']).filter(Boolean) as string[];
    }

    /**
     * Next-page path from a paginated list response, resolved relative to the
     * parent of the current request path (matches the controller's relative
     * hrefs; live-verified on the XHTML `rel="next"` links and, 2026-07-09 on
     * RW7.21, on the HAL `_links.next.href` form). Both representations XML-escape
     * ampersands in the href - even inside JSON strings - hence the unescape.
     * Returns '' when there is no further page.
     */
    async listCfgTypes(domain: string): Promise<string[]> {
      // Live-verified class: cfg-dt-li (datatype-li). Paginated - controller returns 70/page.
      // Pagination quirk: the `rel="next"` href is relative to the response's <base href>
      // which is /rw/cfg/, NOT to /rw/. Resolve relative to the current request's parent path.
      const types: string[] = [];
      let path = buildPath(CFG_ELOG_DIPC.listCfgTypes.rws2 as PathSpec, { domain });
      let pages = 0;
      while (path && pages < 50) {
        const html = await this.req('GET', path);
        const p = parse(html);
        types.push(...p.getAllStates('cfg-dt-li').map(t => t['_title'] ?? t['name']).filter(Boolean) as string[]);
        path = nextPagePath(html, path);
        pages++;
      }
      return types;
    }

    async listCfgInstances(domain: string, type: string): Promise<string[]> {
      // Live-verified: instances live under /{domain}/{type}/instances (with /instances/ suffix).
      // Each is class="cfg-dt-instance-li" with the instance name as the title attribute.
      // Paginated: controller returns 70/page with `rel="next"` link.
      // Note: a few "types" returned by listCfgTypes are placeholders (e.g. SYS/SYSTEM_NAME)
      // that error with HTTP 400 "Invalid type id" - return [] silently for those.
      const instances: string[] = [];
      let path = buildPath(CFG_ELOG_DIPC.listCfgInstances.rws2 as PathSpec, { domain, type });
      let pages = 0;
      while (path && pages < 50) {
        let html: string;
        try { html = await this.req('GET', path); }
        catch { return instances; } // invalid type or no permission - silent empty
        const p = parse(html);
        instances.push(...p.getAllStates('cfg-dt-instance-li').map(i => i['_title'] ?? '').filter(Boolean));
        path = nextPagePath(html, path);
        pages++;
      }
      return instances;
    }

    async getCfgInstance(domain: string, type: string, instance: string): Promise<Record<string, string>> {
      // Live-verified: /{domain}/{type}/instances/{instance}
      // Returns an outer cfg-dt-instance li with NESTED cfg-ia-t li elements.
      // Each attribute: <li class="cfg-ia-t" title="ATTR_NAME"><span class="value">VALUE</span></li>
      const html = await this.req('GET', buildPath(CFG_ELOG_DIPC.getCfgInstance.rws2 as PathSpec, { domain, type, instance }));
      const p = parse(html);
      const attribs = p.getAllStates('cfg-ia-t');
      const result: Record<string, string> = {};
      for (const attr of attribs) {
        const name = attr['_title'];
        const value = attr['value'] ?? '';
        if (name) { result[name] = value; }
      }
      return result;
    }

    /**
     * Update attributes on an existing configuration instance. Requires 'edit'
     * mastership (callers hold it; RobotManager wraps these with mastership).
     *
     * Live-verified 2026-07-09 on OmniCore VC RW7.21 via probe-cfg-rws2.mjs:
     *   ✓ POST /rw/cfg/{domain}/{type}/instances/{instance}
     *     body: each attribute in BRACKET representation `Attr=[value,1]` joined
     *     by '&', values literal (not percent-encoded), Content-Type
     *     application/x-www-form-urlencoded;v=2.0 → 204. Partial attribute sets
     *     are accepted; unknown attribute names → 400 "Error set attribute".
     *   ✗ POST /rw/cfg/{domain}/{type}/{instance} (no /instances/) → 404
     */
    async setCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
      const body = Object.entries(attrs).map(([k, v]) => `${k}=[${v},1]`).join('&');
      await this.req(
        'POST',
        buildPath(CFG_ELOG_DIPC.setCfgInstance.rws2 as PathSpec, { domain, type, instance }),
        undefined,
        body,
        'application/x-www-form-urlencoded;v=2.0',
      );
    }

    /**
     * Create a new configuration instance, then apply `attrs`. Requires 'edit'
     * mastership. Live-verified 2026-07-09 on OmniCore VC RW7.21:
     *   ✓ POST /rw/cfg/{domain}/{type}/instances/create-default  body name={instance} → 201,
     *     followed by the setCfgInstance shape above for the attribute values.
     *   ✗ POST /rw/cfg/{domain}/{type}/{instance}/create → 404 (endpoint doesn't exist)
     */
    async createCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
      await this.req('POST', buildPath(CFG_ELOG_DIPC.createCfgInstance.rws2 as PathSpec, { domain, type }),
        undefined, `name=${instance}`, 'application/x-www-form-urlencoded;v=2.0');
      if (Object.keys(attrs).length > 0) {
        await this.setCfgInstance(domain, type, instance, attrs);
      }
    }

    /**
     * Delete a configuration instance. Requires 'edit' mastership.
     * Live-verified 2026-07-09 on OmniCore VC RW7.21:
     *   ✓ DELETE /rw/cfg/{domain}/{type}/instances/{instance} → 204 (readback → 404)
     */
    async removeCfgInstance(domain: string, type: string, instance: string): Promise<void> {
      await this.req('DELETE', buildPath(CFG_ELOG_DIPC.removeCfgInstance.rws2 as PathSpec, { domain, type, instance }));
    }

    /** Attribute schema of a cfg type (name, type, min/max, mandatory per
     *  attribute). Live-verified 2026-08-04 (RW7.21), class cfg-dt-attribute. */
    async listCfgTypeAttributes(domain: string, type: string): Promise<Array<Record<string, string>>> {
      const p = parse(await this.req(
        'GET', buildPath(CFG_ELOG_DIPC.listCfgTypeAttributes.rws2 as PathSpec, { domain, type })));
      return p.getAllStates('cfg-dt-attribute');
    }

    async loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset' = 'replace'): Promise<void> {
      // Official RWS 2.0 endpoint is /rw/cfg/load (was posting to /rw/cfg, which
      // is the collection resource). Cross-checked vs 3HAC073675-001 Rev L.
      const { path, body } = R2.loadCfgFile(filepath, action);
      await this.req('POST', path, body);
    }

    async saveCfgFile(domain: string, filepath: string): Promise<void> {
      // /rw/cfg/{domain}/save returns 405 on the controller; the real endpoint is
      // /saveas (live-verified 2026-08-03 on RW7.21 VC - the controller confirms
      // the body param is `filepath`).
      const { path, body } = R2.saveCfgFile(domain, filepath);
      await this.req('POST', path, body);
    }

    async listDipcQueues(): Promise<Array<{ name: string; size?: number }>> {
      const p = parse(await this.req('GET', buildPath(CFG_ELOG_DIPC.listDipcQueues.rws2 as PathSpec)));
      return p.getAllStates('dipc-queue-li').map(q => ({
        name: q['queue-name'] ?? q['_title'] ?? '',
        size: q['queue-size'] ? +q['queue-size'] : undefined,
      }));
    }

    async createDipcQueue(name: string, options: { maxsize?: number; maxmessages?: number } = {}): Promise<void> {
      const { path, body } = R2.createDipcQueue(name, options);
      await this.req('POST', path, body);
    }

    async sendDipcMessage(queue: string, payload: string, type: 'string' | 'num' | 'dnum' | 'bool' = 'string'): Promise<void> {
      const msgtype = type === 'string' ? '0' : type === 'num' ? '1' : type === 'dnum' ? '2' : '3';
      const { path, body } = R2.sendDipcMessage(queue, payload, msgtype);
      await this.req('POST', path, body);
    }

    async readDipcMessage(queue: string, timeoutMs = 0): Promise<{ payload: string; type: string } | null> {
      try {
        // Reading a DIPC message is a GET on the queue with a dipc-timeout query
        // param. Our old POST /{queue}/read 404s; live-verified 2026-08-03 that
        // GET /rw/dipc/{queue}?dipc-timeout=N returns the message in a
        // <li class="dipc-read"> element (data in dipc-data), consumed on read.
        // (The message class is `dipc-read`, not `dipc-message` - the old name
        // never matched, so every read returned null.)
        const p = parse(await this.req('GET', R2.readDipcMessage(queue, timeoutMs)));
        const d = p.getState('dipc-read');
        if (!d['dipc-data']) { return null; }
        return { payload: d['dipc-data'], type: d['dipc-msgtype'] ?? 'string' };
      } catch { return null; }
    }

    async removeDipcQueue(name: string): Promise<void> {
      const { path } = R2.removeDipcQueue(name);
      await this.req('DELETE', path);
    }

    /** Read a DIPC queue's info (depth, max message size, slot id). Returns null if
     *  the queue is unknown. GET /rw/dipc/{q}/information, live-verified 2026-08-04
     *  (RW7.21, class dipc-queue). */
    async getDipcQueueInfo(queue: string): Promise<{ name: string; size?: number; maxMsgSize?: number; slotId?: string } | null> {
      try {
        const p = parse(await this.req('GET', buildPath(CFG_ELOG_DIPC.getDipcQueueInfo.rws2 as PathSpec, { queue })));
        const d = p.getState('dipc-queue');
        if (!d['queue-name'] && !d['_title']) { return null; }
        return {
          name:       d['queue-name'] ?? d['_title'] ?? queue,
          size:       d['queue-size']         ? +d['queue-size']         : undefined,
          maxMsgSize: d['queue-max-msg-size']  ? +d['queue-max-msg-size'] : undefined,
          slotId:     d['queue-slot-id'],
        };
      } catch { return null; }
    }

    /**
     * Validate CFG instances that already exist on the controller.
     * POST /rw/cfg/validate-instances, form fields
     * `operation`, `cfgdomain`, `cfgtype`, `instances`, `instancescount`
     * (live-read 2026-08-09 on RW7.21 and RW8.1.1).
     *
     * This is NOT a dry run for instances you are about to create. Live-verified
     * on RW8.1.1: an existing signal name answers 204 (valid), while a synthetic
     * name - or a full `-Name "..." -SignalType "..."` instance body - answers 200
     * with "Instance name not found, or the type is not named".
     *
     * `instancescount` is derived from the array rather than taken from the
     * caller, so the count can never disagree with the payload.
     *
     * @returns `true` when the controller accepted every named instance (204).
     */
    async validateCfgInstances(request: CfgValidateRequest): Promise<boolean> {
      const parts = [
        `operation=${request.operation}`,
        `cfgdomain=${encodeURIComponent(request.domain)}`,
        `cfgtype=${encodeURIComponent(request.type)}`,
        `instancescount=${request.instances.length}`,
        ...request.instances.map(i => `instances=${encodeURIComponent(i)}`),
      ];
      const html = await this.req(
        'POST', buildPath(CFG_ELOG_DIPC.validateCfgInstances.rws2 as PathSpec),
        undefined, parts.join('&'), 'application/x-www-form-urlencoded;v=2.0',
      );
      // 204 carries no body; a 200 body means the controller reported a problem.
      return html.trim().length === 0;
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface CfgElogDipcMethods {
  getEventLog(domain?: number, lang?: string, maxPages?: number, order?: 'oldest' | 'newest'): Promise<ElogMessage[]>;
  clearEventLog(domain?: number): Promise<void>;
  clearAllEventLogs(): Promise<void>;
  getEventLogMessage(domain: number, seqnum: number, lang?: string): Promise<ElogMessage | null>;
  getEventLogMessageBySeqnum(seqnum: number, lang?: string): Promise<ElogMessage | null>;
  saveEventLogRaw(destination: string): Promise<void>;
  listEventLogDomains(): Promise<Array<{ domain: number; events: number; bufferSize: number }>>;
  listCfgDomains(): Promise<string[]>;
  listCfgTypes(domain: string): Promise<string[]>;
  listCfgInstances(domain: string, type: string): Promise<string[]>;
  getCfgInstance(domain: string, type: string, instance: string): Promise<Record<string, string>>;
  setCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void>;
  createCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void>;
  removeCfgInstance(domain: string, type: string, instance: string): Promise<void>;
  listCfgTypeAttributes(domain: string, type: string): Promise<Array<Record<string, string>>>;
  loadCfgFile(filepath: string, action?: 'add' | 'replace' | 'add-with-reset'): Promise<void>;
  saveCfgFile(domain: string, filepath: string): Promise<void>;
  listDipcQueues(): Promise<Array<{ name: string; size?: number }>>;
  createDipcQueue(name: string, options?: { maxsize?: number; maxmessages?: number }): Promise<void>;
  sendDipcMessage(queue: string, payload: string, type?: 'string' | 'num' | 'dnum' | 'bool'): Promise<void>;
  readDipcMessage(queue: string, timeoutMs?: number): Promise<{ payload: string; type: string } | null>;
  removeDipcQueue(name: string): Promise<void>;
  getDipcQueueInfo(queue: string): Promise<{ name: string; size?: number; maxMsgSize?: number; slotId?: string } | null>;
  validateCfgInstances(request: CfgValidateRequest): Promise<boolean>;
}

/** Guard: the mixin class must provide every CfgElogDipcMethods member (never exported). */
type _CfgElogDipcMethodsComplete = InstanceType<ReturnType<typeof cfgElogDipcOps>> extends CfgElogDipcMethods ? true : never;
const _cfgElogDipcComplete: _CfgElogDipcMethodsComplete = true;
void _cfgElogDipcComplete;

export function CfgElogDipcOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<CfgElogDipcMethods> {
  return cfgElogDipcOps(Base) as unknown as TBase & GConstructor<CfgElogDipcMethods>;
}
