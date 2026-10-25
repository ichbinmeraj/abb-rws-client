import { Logger } from '../Logger.js';
import { CFG_ELOG_DIPC } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { decodeEntities, elogMsgtype } from '../ResponseParser.js';
import { cfgTypeFrom } from '../commonReads.js';
import { decodeElogArgs, RwsError, type CfgTypeInfo, type CfgValidateRequest, type DipcQueueInfo, type ElogMessage } from '../types.js';
import { cfgInstanceAttributes, nextPagePath, parse } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * One event-log entry (listing `elog-message-li` or single `elog-message`)
 * as an ElogMessage. The text fields are entity-decoded (`&amp;` last): the
 * hal+json strings carry XML entities, e.g. `task&apos;s` in a description,
 * on RW 7.21.4+417 and 8.2.1+1023 (live-verified 2026-09-29), and the XHTML
 * parser does not decode span values either, so both paths decode here, once.
 */
function elogMessageFrom(m: Record<string, string>, seqnum: number): ElogMessage {
  const text = (v: string | undefined): string => decodeEntities(v ?? '');
  return {
    seqnum,
    code:         Number(m['code']    ?? 0),
    msgtype:      elogMsgtype(m['msgtype']),
    timestamp:    m['tstamp']  ?? '',
    srcName:      m['src-name'] ?? '',
    title:        m['title'] !== undefined ? text(m['title']) : `Event ${m['code']}`,
    desc:         text(m['desc']),
    causes:       text(m['causes']),
    consequences: text(m['conseqs']),
    actions:      text(m['actions']),
    args:         decodeElogArgs(m),
  };
}

/**
 * The seqnum a single `elog-message` entry says it holds: the trailing number
 * of its `_title` (`/rw/elog/0/85`, `/rw/elog/seqnum/85`), else of its own
 * self link (`0/85?lang=en`). Null when neither names one.
 */
function entrySeqnum(m: Record<string, string>): number | null {
  for (const s of [m['_title'], m['_href']]) {
    const hit = /(?:^|\/)(?:\d+|seqnum)\/(\d+)\s*(?:[?#].*)?$/.exec(s ?? '');
    if (hit) { return Number(hit[1]); }
  }
  return null;
}

/**
 * A single-message answer as the message stored under `seqnum`, or null. The
 * controller can answer a seqnum it does not hold with 200 and ANOTHER message
 * (see getEventLogMessage), so an entry that names a different seqnum is
 * null, never that message relabelled with the requested number.
 */
function singleElogMessage(body: string, seqnum: number, read: string): ElogMessage | null {
  const m = parse(body).getState('elog-message');
  if (!m['code']) { return null; }
  const held = entrySeqnum(m);
  if (held !== null && held !== seqnum) {
    Logger.trace?.('elog', `${read}: the controller answered with message ${held}, not ${seqnum}; returning null`, { requested: seqnum, answered: held });
    return null;
  }
  return elogMessageFrom(m, seqnum);
}

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
      // msgtype: a missing or non-numeric field reads as 0 = unknown, never
      // 1 = info (see elogMsgtype; RW6 Message Get could omit a parameter -
      // ABB RobotWare release notes 6.15.04 §4 Corrections, a title only, so
      // the affected range is not stated and "before 6.15.04" is inferred
      // from the fix version; release notes, 2026-09-29). Applied on RWS 2.0
      // too so both protocols agree.
      const out: ElogMessage[] = [];
      const visited = new Set<string>();
      // Newest-first needs the v=2.1 media type (documented in the RWS 2.0
      // reference, Rev L). Under v=2.0 the controller refuses order=lifo
      // outright: 400 "LIFO is not supported in v=2.0, Use v=2.1 to list Elog
      // messages in LIFO order." The response is still labelled v=2.0.
      // Live-verified 2026-08-06 on RW7.21 and RW8.1.1.
      //
      // Paging newest-first does NOT follow the emitted `next` link: under
      // v=2.1 it never advances (`start=2^32-limit` serves page 1 again, with
      // the same link), and its `elogseqnum=` form is refused 400. Instead each
      // further page asks for `elogseqnum` = (lowest seqnum so far) - 1, which
      // returns the newest stored entries at or below that number, so seqnum
      // gaps are fine. The walk stops on an empty page or one with no new
      // seqnum. The further pages carry no `order`: that is the shape verified
      // (v=2.1 lists newest-first by default). Oldest-first (v=2.0) keeps
      // following `next`, which advances there. Live-verified 2026-09-29 on
      // RW 7.21.4+417 and 8.2.1+1023.
      const newest = order === 'newest';
      const accept = newest ? 'application/hal+json;v=2.1' : undefined;
      const first = R2.elogMessages(domain, lang);
      const seen = new Set<number>();
      let path = newest ? `${first}&order=lifo` : first;
      for (let page = 0; path && page < maxPages; page++) {
        if (visited.has(path)) { break; }   // guard against a self-referential `next`
        visited.add(path);
        let body: string;
        if (newest && page > 0) {
          // An `elogseqnum` page below the oldest stored entry (a cleared or
          // wrapped log whose oldest seqnum is above 1) has no capture: every
          // captured v=2.1 elogseqnum answer was 200, and v=2.0 elogseqnum=99999
          // answered 200 with an empty body (RW 7.21.4, 2026-09-29). So a
          // failure on such a page ends the walk with the entries already read
          // instead of throwing them away.
          try {
            body = await this.req('GET', path, undefined, undefined, undefined, [], accept);
          } catch (e) {
            Logger.warn(`getEventLog(${domain}, newest): page ${page + 1} failed (${e instanceof Error ? e.message : String(e)}); returning the ${out.length} entries read`);
            break;
          }
        } else {
          body = await this.req('GET', path, undefined, undefined, undefined, [], accept);
        }
        const p = parse(body);
        let lowest = Number.POSITIVE_INFINITY;
        let fresh = 0;
        for (const m of p.getAllStates('elog-message-li')) {
          const parts = (m['_title'] ?? '').split('/');
          const msg = elogMessageFrom(m, Number(parts[parts.length - 1] ?? 0));
          if (newest) {
            if (seen.has(msg.seqnum)) { continue; }
            seen.add(msg.seqnum);
            fresh++;
            if (msg.seqnum < lowest) { lowest = msg.seqnum; }
          }
          out.push(msg);
        }
        if (newest) {
          path = fresh > 0 && Number.isFinite(lowest) && lowest > 1
            ? `${first}&elogseqnum=${lowest - 1}`
            : '';
        } else {
          path = nextPagePath(body, buildPath(CFG_ELOG_DIPC.getEventLog.rws2 as PathSpec, { domain }));
        }
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
     *  2026-08-04 (RW7.21), class elog-message, `_title` `/rw/elog/{d}/{n}`.
     *  Returns null when the domain holds no message under that seqnum.
     *
     *  A seqnum the domain does not hold is NOT answered 204 or 404 on
     *  RW 7.21.4+417 and 8.2.1+1023: it answers 200 with the nearest older
     *  message of the domain, as RWS 1.0 does on RW 6.16.03, and that
     *  entry's `_title` and self link name the seqnum it really holds.
     *  Recorded 2026-09-29: `/rw/elog/10/106` answered the entry titled
     *  `/rw/elog/10/105` (self `10/105?lang=en`) on 7.21.4, `/rw/elog/10/62`
     *  and `/10/63` the entry titled `/rw/elog/10/61` on 8.2.1. Live-verified
     *  again 2026-09-30 by the functional suite (04-elog) in domain 0: a
     *  seqnum 10000 past the newest answered 200 with the newest entry
     *  (10186 titled 186 on 7.21.4, 10102 titled 102 on 8.2.1), and a seqnum
     *  held by another domain with the nearest older domain-0 entry (32
     *  titled 30 on 7.21.4, 49 titled 47 on 8.2.1), while
     *  `/rw/elog/seqnum/{n}` returned the genuine entry. So the entry's own
     *  seqnum (its `_title`, else its self link) is compared with the
     *  requested one, and a different message is null, never returned under
     *  the requested number. */
    async getEventLogMessage(domain: number, seqnum: number, lang = 'en'): Promise<ElogMessage | null> {
      try {
        const body = await this.req('GET', `${buildPath(CFG_ELOG_DIPC.getEventLogMessage.rws2 as PathSpec, { domain, seqnum })}?lang=${encodeURIComponent(lang)}`);
        return singleElogMessage(body, seqnum, `getEventLogMessage(${domain}, ${seqnum})`);
      } catch { return null; }
    }

    /** One event-log message by global sequence number (across domains).
     *  Live-verified 2026-08-04 (RW7.21): GET /rw/elog/seqnum/{n}; the entry's
     *  `_title` is `/rw/elog/seqnum/{n}` (RW 7.21.4 and 8.2.1, 2026-09-29).
     *  The same seqnum check as getEventLogMessage applies: what this
     *  resource answers for a seqnum past the newest is not recorded, so an
     *  entry naming another seqnum is null here too. */
    async getEventLogMessageBySeqnum(seqnum: number, lang = 'en'): Promise<ElogMessage | null> {
      try {
        const body = await this.req('GET', `${buildPath(CFG_ELOG_DIPC.getEventLogMessageBySeqnum.rws2 as PathSpec, { seqnum })}?lang=${encodeURIComponent(lang)}`);
        return singleElogMessage(body, seqnum, `getEventLogMessageBySeqnum(${seqnum})`);
      } catch { return null; }
    }

    /** Dump the full event log to a file in system-dump format (diagnostics/support).
     *  POST /rw/elog/saveraw, field `path`. The path is normalized to the
     *  fileservice-URI form the controller requires ('TEMP/x' works as input);
     *  bare volume roots answer "Virtual root does not exist". Live round-tripped
     *  2026-08-04 (RW7.21): 202 Accepted, dump file created.
     */
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
     * A count the controller does not report is null, not 0.
     */
    async listEventLogDomains(): Promise<Array<{ domain: number; events: number | null; bufferSize: number | null }>> {
      const p = parse(await this.req('GET', buildPath(CFG_ELOG_DIPC.listEventLogDomains.rws2 as PathSpec)));
      return p.getAllStates('elog-domain-li').map(d => ({
        domain: Number(d['_title'] ?? 0),
        events: d['numevts'] !== undefined && d['numevts'] !== '' && Number.isFinite(Number(d['numevts'])) ? Number(d['numevts']) : null,
        bufferSize: d['buffsize'] !== undefined && d['buffsize'] !== '' && Number.isFinite(Number(d['buffsize'])) ? Number(d['buffsize']) : null,
      }));
    }

    async listCfgDomains(): Promise<string[]> {
      const p = parse(await this.req('GET', buildPath(CFG_ELOG_DIPC.listCfgDomains.rws2 as PathSpec)));
      return p.getAllStates('cfg-domain-li').map(d => d['_title'] ?? d['name']).filter(Boolean) as string[];
    }

    /**
     * The data types of a CFG domain, following the controller's pagination
     * (70 per page; `nextPagePath` in core.ts resolves each `next` href against
     * the response's base, `/rw/cfg/`).
     */
    async listCfgTypes(domain: string): Promise<string[]> {
      // Live-verified class: cfg-dt-li (datatype-li). Paginated - controller returns 70/page.
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
      // Paginated: controller returns 70/page with a `next` link relative to the
      // response's base (/rw/cfg/), not to this request's parent; nextPagePath
      // resolves it against the base. Before that fix page 2 was requested at a
      // doubled path, answered 404, and the catch below returned only 70 rows
      // (RW 8.2.1+1023, 94 EIO_SIGNAL instances, live-verified 2026-09-29).
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
      return cfgInstanceAttributes(html);
    }

    /**
     * Update attributes on an existing configuration instance. Holds `edit`
     * mastership (RW8: write access) around the write; a hold the caller or
     * RobotManager already has is reused.
     *
     * ABB's documents disagree on whether RWS 2.0 CFG writes need a hold: the
     * RWS 2.0 CFG service lists "Pre-requisites: None" and ABB's own CFG sample
     * writes with none, while the PC SDK says writing the configuration domain
     * needs mastership of the configuration resource (RWS 2.0's `edit`). The
     * hold is taken until a live run settles it. The same applies to every
     * CFG write below.
     *
     * Live-verified 2026-07-09 on OmniCore VC RW7.21 with a probe script:
     *   ✓ POST /rw/cfg/{domain}/{type}/instances/{instance}
     *     body: each attribute in BRACKET representation `Attr=[value,1]` joined
     *     by '&', values literal (not percent-encoded), Content-Type
     *     application/x-www-form-urlencoded;v=2.0 → 204. Partial attribute sets
     *     are accepted; unknown attribute names → 400 "Error set attribute".
     *   ✗ POST /rw/cfg/{domain}/{type}/{instance} (no /instances/) → 404
     */
    async setCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
      const body = Object.entries(attrs).map(([k, v]) => `${k}=[${v},1]`).join('&');
      await this.withAccess(['cfg'], () => this.req(
        'POST',
        buildPath(CFG_ELOG_DIPC.setCfgInstance.rws2 as PathSpec, { domain, type, instance }),
        undefined,
        body,
        'application/x-www-form-urlencoded;v=2.0',
      ));
    }

    /**
     * Create a new configuration instance, then apply `attrs`. Requires 'edit'
     * mastership. Live-verified 2026-07-09 on OmniCore VC RW7.21:
     *   ✓ POST /rw/cfg/{domain}/{type}/instances/create-default  body name={instance} → 201,
     *     followed by the setCfgInstance shape above for the attribute values.
     *   ✗ POST /rw/cfg/{domain}/{type}/{instance}/create → 404 (endpoint doesn't exist)
     */
    async createCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void> {
      // One hold around the create and the attribute set.
      await this.withAccess(['cfg'], async () => {
        await this.req('POST', buildPath(CFG_ELOG_DIPC.createCfgInstance.rws2 as PathSpec, { domain, type }),
          undefined, `name=${instance}`, 'application/x-www-form-urlencoded;v=2.0');
        if (Object.keys(attrs).length > 0) {
          await this.setCfgInstance(domain, type, instance, attrs);
        }
      });
    }

    /**
     * Delete a configuration instance. Holds `edit` mastership (RW8: write
     * access), as setCfgInstance does.
     * Live-verified 2026-07-09 on OmniCore VC RW7.21:
     *   ✓ DELETE /rw/cfg/{domain}/{type}/instances/{instance} → 204 (readback → 404)
     */
    async removeCfgInstance(domain: string, type: string, instance: string): Promise<void> {
      await this.withAccess(['cfg'], () =>
        this.req('DELETE', buildPath(CFG_ELOG_DIPC.removeCfgInstance.rws2 as PathSpec, { domain, type, instance })));
    }

    /**
     * One configuration type: `GET /rw/cfg/{domain}/{type}`, CFG_Service
     * Rev L "Get CFG Type": the type's attribute count (`cfg-dt-attributes-li`
     * / `cfg-no-of-attributes`) and instance count (`cfg-dt-instances-li` /
     * `cfg-no-of-instances`). RW 7.21.4+417 and 8.2.1+1023 link every type
     * from their domain listings (read 2026-09-29); the type's own body is
     * ABB's documented shape, not yet captured. PARSE_ERROR when neither item
     * is present; an unknown type is the controller's typed refusal.
     */
    async getCfgType(domain: string, type: string): Promise<CfgTypeInfo> {
      if (!domain || !type) {
        throw new RwsError('RWS2 getCfgType: domain and type must not be empty', 'INVALID_ARGUMENT');
      }
      const p = parse(await this.req('GET', buildPath(CFG_ELOG_DIPC.getCfgType.rws2 as PathSpec, { domain, type })));
      return cfgTypeFrom(p.getAllEntries(), domain, type, 'RWS2 getCfgType');
    }

    /** Attribute schema of a cfg type (name, type, min/max, mandatory per
     *  attribute). Live-verified 2026-08-04 (RW7.21), class cfg-dt-attribute;
     *  RW 7.21.4 and 8.2.1 answer 200 (2026-09-29). */
    async listCfgTypeAttributes(domain: string, type: string): Promise<Array<Record<string, string>>> {
      const p = parse(await this.req(
        'GET', buildPath(CFG_ELOG_DIPC.listCfgTypeAttributes.rws2 as PathSpec, { domain, type })));
      return p.getAllStates('cfg-dt-attribute');
    }

    /** Load a CFG file. Holds `edit` mastership (RW8: write access), as
     *  setCfgInstance does: neither ABB RWS page lists a hold for the load. */
    async loadCfgFile(filepath: string, action: 'add' | 'replace' | 'add-with-reset' = 'replace'): Promise<void> {
      // Official RWS 2.0 endpoint is /rw/cfg/load (was posting to /rw/cfg, which
      // is the collection resource). Cross-checked vs 3HAC073675-001 Rev L.
      const { path, body } = R2.loadCfgFile(filepath, action);
      await this.withAccess(['cfg'], () => this.req('POST', path, body));
    }

    /** Save a CFG domain to a file. Holds `edit` mastership (RW8: write access),
     *  as setCfgInstance does: neither ABB RWS page lists a hold for the save.
     */
    async saveCfgFile(domain: string, filepath: string): Promise<void> {
      // /rw/cfg/{domain}/save returns 405 on the controller; the real endpoint is
      // /saveas (live-verified 2026-08-03 on RW7.21 VC - the controller confirms
      // the body param is `filepath`).
      const { path, body } = R2.saveCfgFile(domain, filepath);
      await this.withAccess(['cfg'], () => this.req('POST', path, body));
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
        // Reading a DIPC message is a GET on the queue with ABB's `timeout`
        // query parameter, the wait in ms (default 0). Our old POST
        // /{queue}/read 404s; live-verified 2026-08-03 that the GET returns
        // the message in a <li class="dipc-read"> element (data in dipc-data),
        // consumed on read. (The message class is `dipc-read`, not
        // `dipc-message` - the old name never matched, so every read returned
        // null.)
        //
        // The controller may stay silent for the whole wait, so the wait is
        // passed to req as a hold: this request's idle timeout and deadline
        // are extended by it. Without that, a wait longer than the client's
        // own timeout was cut off, and a message that arrived after the cut
        // was consumed by a read nobody was listening to.
        const waitMs = R2.dipcReadTimeoutMs(timeoutMs);
        const p = parse(await this.req(
          'GET', R2.readDipcMessage(queue, waitMs),
          undefined, undefined, undefined, [], undefined, undefined, waitMs,
        ));
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
    async getDipcQueueInfo(queue: string): Promise<DipcQueueInfo | null> {
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
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async validateCfgInstances(request: CfgValidateRequest): Promise<boolean> {
      // The form's `operation` is 0 (add) or 1 (delete) and nothing else:
      // ABB's RWS 2.0 (Rev L, CFG Service) documents "{0 | 1} 0 represents add
      // and 1 represents delete", and RW 7.21.4 and 8.2.1 answer any other
      // value (delete, remove, add, modify, create, set were tried on
      // 2026-10-11) with 400 -1073445879 "Invalid operation parameter value".
      // Refused here before anything is sent.
      const op = request.operation as unknown;
      if (op !== 0 && op !== 1) {
        throw new RwsError(
          `validateCfgInstances: operation must be 0 (validate an add) or 1 (validate a delete), not ${JSON.stringify(op)}; the controller refuses every other value`,
          'INVALID_ARGUMENT');
      }
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

    /**
     * Validate a configuration file already on the controller without loading
     * it (a load dry-run): POST /rw/cfg/validate with `filepath` and
     * `action-type`, ABB's CFG service "Validate CFG File" (Rev L). ABB's sample
     * sends a bare volume path (`filepath=$TEMP/a.cfg`), not a fileservice URI,
     * and documents a 200 answer with one `cfg-validate` item per domain.
     *
     * Live on RW 7.21.4 (2026-09-30): `filepath=$TEMP/<file>&action-type=add`
     * answered 200 with the documented `cfg-validate` EIO item, sent under an
     * edit hold because a load followed. ABB lists no prerequisite for the
     * validation itself, so this method takes no hold. Without a hold, RW
     * 7.21.4 and 8.2.1 passed a one-signal EIO file and refused a file with no
     * header 400 -1073437686 "Wrong layout of version string", loading
     * nothing (2026-10-01).
     *
     * Resolves when the controller accepts the file: a 204, or a 2xx answer
     * with at least one `cfg-validate` item and no error status. Throws a
     * typed `RwsError` when it refuses (the controller's error answer),
     * `INVALID_ARGUMENT` when a 2xx answer carries an error status, and
     * `UNKNOWN` when a 2xx answer carries neither an error status nor a
     * `cfg-validate` item: an answer this client does not recognise never
     * counts as a pass, because a caller loads the file next. Other item
     * classes beside a `cfg-validate` item are logged, not refused.
     *
     * @param filepath   a bare controller path, e.g. `$TEMP/x.cfg`
     * @param actionType how the file WOULD be loaded: 'add' | 'replace' | 'add-with-reset'
     */
    async validateCfgFile(filepath: string, actionType: 'add' | 'replace' | 'add-with-reset' = 'add'): Promise<void> {
      const path = buildPath(CFG_ELOG_DIPC.validateCfgFile.rws2 as PathSpec);
      const body = await this.req('POST', path, { filepath, 'action-type': actionType });
      if (body.trim() === '') { return; }
      const parsed = parse(body);
      const err = parsed.getError();
      if (err) {
        const code = Number(err.code);
        // req() resolves on any 2xx without saying which, so no status is claimed.
        throw new RwsError(
          `RWS2 validateCfgFile: the controller did not accept ${filepath} (a 2xx answer with an error status): ${err.msg || `code ${err.code}`}`,
          'INVALID_ARGUMENT', undefined, body, Number.isFinite(code) ? code : undefined, err.msg || undefined,
        );
      }
      if (parsed.getAllStates('cfg-validate').length === 0) {
        throw new RwsError(
          `RWS2 validateCfgFile: the controller answered for ${filepath} with neither a cfg-validate item nor an error status; `
          + 'an unrecognised answer is not counted as a pass',
          'UNKNOWN', undefined, body,
        );
      }
      const others = [...new Set([...body.matchAll(/<li class="([^"]+)"/g)].map(m => m[1]))].filter(c => c !== 'cfg-validate');
      if (others.length) {
        Logger.warn(`RWS2 validateCfgFile: ${filepath} passed; the answer also carries item class ${others.map(c => `"${c}"`).join(', ')}, `
          + 'which ABB\'s page does not document');
      }
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
  listEventLogDomains(): Promise<Array<{ domain: number; events: number | null; bufferSize: number | null }>>;
  listCfgDomains(): Promise<string[]>;
  listCfgTypes(domain: string): Promise<string[]>;
  listCfgInstances(domain: string, type: string): Promise<string[]>;
  getCfgInstance(domain: string, type: string, instance: string): Promise<Record<string, string>>;
  setCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void>;
  createCfgInstance(domain: string, type: string, instance: string, attrs: Record<string, string>): Promise<void>;
  removeCfgInstance(domain: string, type: string, instance: string): Promise<void>;
  getCfgType(domain: string, type: string): Promise<CfgTypeInfo>;
  listCfgTypeAttributes(domain: string, type: string): Promise<Array<Record<string, string>>>;
  loadCfgFile(filepath: string, action?: 'add' | 'replace' | 'add-with-reset'): Promise<void>;
  saveCfgFile(domain: string, filepath: string): Promise<void>;
  listDipcQueues(): Promise<Array<{ name: string; size?: number }>>;
  createDipcQueue(name: string, options?: { maxsize?: number; maxmessages?: number }): Promise<void>;
  sendDipcMessage(queue: string, payload: string, type?: 'string' | 'num' | 'dnum' | 'bool'): Promise<void>;
  readDipcMessage(queue: string, timeoutMs?: number): Promise<{ payload: string; type: string } | null>;
  removeDipcQueue(name: string): Promise<void>;
  getDipcQueueInfo(queue: string): Promise<DipcQueueInfo | null>;
  validateCfgInstances(request: CfgValidateRequest): Promise<boolean>;
  validateCfgFile(filepath: string, actionType?: 'add' | 'replace' | 'add-with-reset'): Promise<void>;
}

/** Guard: the mixin class must provide every CfgElogDipcMethods member (never exported). */
type _CfgElogDipcMethodsComplete = InstanceType<ReturnType<typeof cfgElogDipcOps>> extends CfgElogDipcMethods ? true : never;
const _cfgElogDipcComplete: _CfgElogDipcMethodsComplete = true;
void _cfgElogDipcComplete;

export function CfgElogDipcOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<CfgElogDipcMethods> {
  return cfgElogDipcOps(Base) as unknown as TBase & GConstructor<CfgElogDipcMethods>;
}
