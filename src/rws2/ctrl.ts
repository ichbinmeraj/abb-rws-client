import { Logger } from '../Logger.js';
import { CTRL, SYSTEM_MASTERSHIP, USERS_UAS } from '../paths/index.js';
import { virtualTimePercent, virtualTimeRunningUnsupported } from '../paths/ctrl.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { RwsError, type DiagnosticsInfo, type ReturnCodeInfo, type RobotWareCompatibility } from '../types.js';
import { compatibilityFrom, compatibilityVersion, envName, envValueFrom, progressIdFrom } from '../commonReads.js';
import { controllerJobName, type ControllerJobName } from '../controllerJobs.js';
import { parse, requireState } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';
import type { SystemMethods } from './system.js';

/**
 * Controller domain (`/ctrl`): backup/restore, safety, virtual time, certstore, registry, compress, diagnostics, options.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function ctrlOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    /**
     * Set the virtual-time timeslice (VC only; form field `vttimeslice`).
     */
    async setVirtualTimeTimeslice(vttimeslice: number): Promise<void> {
      await this.req('POST', buildPath(CTRL.setVirtualTimeTimeslice.rws2 as PathSpec), { vttimeslice: String(vttimeslice) });
    }

    /** Safety controller mode, e.g. 'active' (class safetymodestatus). */
    async getSafetyMode(): Promise<{ mode: string; userdata?: string }> {
      const p = parse(await this.req('GET', buildPath(CTRL.getSafetyMode.rws2 as PathSpec)));
      const d = p.getState('safetymodestatus');
      return { mode: d['safetymode'] ?? 'unknown', userdata: d['userdata'] };
    }

    /**
     * Safety violation counters (class safety-violationinfo).
     */
    async getSafetyViolationInfo(): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(CTRL.getSafetyViolationInfo.rws2 as PathSpec)));
      return p.getState('safety-violationinfo');
    }

    /**
     * Safety configuration load status (class scorch-load-status).
     */
    async getSafetyLoadStatus(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(CTRL.getSafetyLoadStatus.rws2 as PathSpec)));
      return p.getState('scorch-load-status')['status'] ?? 'unknown';
    }

    /** Safety configuration status at startup. The controller misspells the
     *  class as startup-safety-config-load-satus (missing 't' - live RW7.21);
     *  the corrected spelling is read as fallback. */
    async getSafetyStartupStatus(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(CTRL.getSafetyStartupStatus.rws2 as PathSpec)));
      let d = p.getState('startup-safety-config-load-satus');
      if (!('config-status-at-startup' in d)) { d = p.getState('startup-safety-config-load-status'); }
      return d['config-status-at-startup'] ?? 'unknown';
    }

    /**
     * Safety-configuration change count. GET /ctrl/safety/config/changecount,
     * class safety-config-change-count, field `count`.
     *
     * Observed: RW 7.21.4+417 and 8.2.1+1023 (2026-09-29) both answered 200
     * with `count` 1; no change was made in between, so the count has not been
     * seen to move.
     *
     * Inferred, not observed: from ABB RobotWare release notes 7.20.0 §1.2
     * ("RWS APIs for Safety controller functions"), which list it as new in
     * 7.20, the number goes up when the safety configuration changes (so a
     * caller could poll it and re-read the configuration only when it moved),
     * and a controller older than 7.20 lacks the resource, most likely
     * answering 404 (`RESOURCE_NOT_FOUND`). Neither has been checked live.
     *
     * @throws RwsError `PARSE_ERROR` when the answer carries no numeric count.
     */
    async getSafetyConfigChangeCount(): Promise<number> {
      const p = parse(await this.req('GET', buildPath(CTRL.getSafetyConfigChangeCount.rws2 as PathSpec)));
      const d = requireState(p, ['safety-config-change-count'], 'getSafetyConfigChangeCount');
      const raw = (d['count'] ?? '').trim();
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) {
        throw new RwsError(`RWS2 getSafetyConfigChangeCount: count is not a number (${d['count'] ?? 'absent'})`, 'PARSE_ERROR');
      }
      return n;
    }

    /**
     * The loaded safety configuration. GET /ctrl/safety/config.
     *
     * ABB's Controller_Service.yaml (Rev L, "Get Safety Configurations") answers
     * two entries: class safety-ctrl-configuration-status with `config-status`
     * (e.g. SCORCH_CONFIG_LOADED), and class safety-ctrl-configuration with
     * sw-major-ver / sw-minor-ver / sw-rev, file-major-ver / file-minor-ver /
     * file-rev, creation-date, created-by, config-name and checksum (base64).
     * `status` is the first, `configuration` the second as read (span names
     * kept). The resource is advertised under /ctrl/safety on RW 7.21.4+417 and
     * 8.2.1+1023 (crawl 2026-09-30); a RobotWare 7.21.0 VC answered
     * SCORCH_CONFIG_LOADED, created by ABB, on 2026-05-04, and RW 7.21.4 and
     * 8.2.1 answered SCORCH_CONFIG_LOADED with both entries on 2026-10-01.
     *
     * Read-only: the POST on the same path loads a safety configuration file
     * and is not wrapped.
     *
     * @throws RwsError `PARSE_ERROR` when neither entry is in the answer.
     */
    async getSafetyConfig(): Promise<{ status: string; configuration: Record<string, string> }> {
      const p = parse(await this.req('GET', buildPath(CTRL.getSafetyConfig.rws2 as PathSpec)));
      const status = p.getState('safety-ctrl-configuration-status');
      const configuration = p.getState('safety-ctrl-configuration');
      if (Object.keys(status).length === 0 && Object.keys(configuration).length === 0) {
        throw new RwsError(
          'RWS2 getSafetyConfig: response carried no safety-ctrl-configuration-status / safety-ctrl-configuration block - unparseable or truncated',
          'PARSE_ERROR',
        );
      }
      return { status: status['config-status'] ?? 'unknown', configuration };
    }

    /** Current virtual-time timeslice (VC only; class ctrl-vttimeslice). */
    async getVirtualTimeTimeslice(): Promise<number> {
      const p = parse(await this.req('GET', buildPath(CTRL.getVirtualTimeTimeslice.rws2 as PathSpec)));
      return Number(p.getState('ctrl-vttimeslice')['vttimeslice'] ?? 0);
    }

    /**
     * Read one controller registry file (cfgrules, cfgtext, devices, elogtext,
     * elogrules, hw-compatibility, option, rapid-metadata, rapid-text,
     * rw-services, uastext). The content is returned inline as the file's own
     * XML text (class ctrl-reg-file-li). The existing getRegistry() only lists
     * the root; these are the actual files.
     */
    async getRegistryFile(name: string): Promise<string> {
      const p = parse(await this.req('GET', buildPath(CTRL.getRegistryFile.rws2 as PathSpec, { name })));
      const d = p.getState('ctrl-reg-file-li');
      return d[name] ?? Object.values(d).find(v => typeof v === 'string' && v.startsWith('<?xml')) ?? '';
    }

    /**
     * The LDAP sub-resources the controller advertises. This listing answers 200
     * for a normal user even where the resources themselves do not, so it is the
     * one part of the LDAP surface that can be verified without the option
     * installed. Live-verified 2026-08-06 on RW7.21 and RW8.1.1.
     */
    async listLdapResources(): Promise<string[]> {
      const p = parse(await this.req('GET', buildPath(USERS_UAS.listLdapResources.rws2 as PathSpec)));
      const names: string[] = [];
      for (const t of ['enabled', 'searchpassword', 'configuration', 'settings', 'certificate', 'verify']) {
        const title = p.getState(`uas-ldap-${t}-li`)['_title'];
        if (title) { names.push(title); }
      }
      return names;
    }

    /**
     * Read one LDAP resource, e.g. `getLdapResource('configuration')`.
     *
     * Deliberately a pass-through: it returns whatever fields the controller
     * sends rather than mapping them onto a shape of our own. The field names
     * could not be learned here, because both VCs refuse every `/uas/ldap/*`
     * read with HTTP 403 (`SYS_CTRL_E_UAS_REJECT`) in both representations, even
     * for a user holding UAS_UAS_ADMINISTRATION, and neither carries an LDAP
     * option - so the feature is unlicensed rather than merely ungranted. Its
     * `OPTIONS` answers 204 with an `Allow` header and no form, so the usual
     * trick of reading the controller's own field list does not work either.
     *
     * The resource names and classes below were read off a live `GET /uas/ldap`,
     * which does answer 200, so they are observed rather than guessed. The
     * per-field shape is whatever the controller returns.
     *
     * NOT verified against a controller with LDAP licensed. On these VCs it
     * throws GRANT_DENIED, which is the honest answer.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async getLdapResource(name: string): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(USERS_UAS.getLdapResource.rws2 as PathSpec, { name })));
      // List entries carry the `-li` suffix; detail resources on RWS 2.0
      // sometimes drop it (elog-message-li vs elog-message), so accept both.
      const d = p.getState(`uas-ldap-${name}-li`);
      return Object.keys(d).length ? d : p.getState(`uas-ldap-${name}`);
    }

    /**
     * Translate a controller status code into the controller's own description.
     *
     * Every RwsError carries a `controllerCode` such as -1073442816, and the
     * controller ships the dictionary for them: this returns ABB's symbolic name
     * (`SYS_CTRL_E_NO_SUCH_SYMBOL`), a severity and a sentence of prose. Useful
     * for anything that reports an error to a human, and for codes this client
     * has never seen. Returns null when the controller does not know the code -
     * the dictionary is per-generation, so an RW8 code is unknown to RW7.
     *
     * Live-verified 2026-08-06 on RW6.16, RW7.21 and RW8.1.1, class err-desc.
     */
    async describeReturnCode(code: number): Promise<ReturnCodeInfo | null> {
      try {
        const p = parse(await this.req('GET', `/rw/retcode?code=${code}`));
        const d = p.getState('err-desc');
        if (!d['name']) { return null; }
        return {
          code:        Number(d['code'] ?? code),
          name:        d['name'] ?? '',
          severity:    d['severity'] ?? '',
          description: d['description'] ?? '',
        };
      } catch { return null; }
    }

    /**
     * Backup progress/state, e.g. 'Backup Ready'. `createBackup` answers 202 and
     * runs asynchronously, so this is how a caller knows it finished.
     * Live-verified 2026-08-06 on RW7.21 and RW8.1.1, class ctrl-backup-state.
     */
    async getBackupState(): Promise<string> {
      const p = parse(await this.req('GET', buildPath(CTRL.getBackupState.rws2 as PathSpec)));
      return p.getState('ctrl-backup-state')['backup-state'] ?? '';
    }

    /**
     * Names under a certificate-store path. `listCertificateStores()` gives the
     * top level ('controller', 'system'); passing one of those gives its stores
     * ('trust_ca_store' for controller, 'robapi_store' and 'rws_store' for
     * system). Live-verified 2026-08-06 on RW7.21 and RW8.1.1,
     * class ctrl-certstore-li.
     */
    async listCertificateStores(path = ''): Promise<string[]> {
      const suffix = path ? `/${path.replace(/^\/+/, '')}` : '';
      const p = parse(await this.req('GET', buildPath(CTRL.listCertificateStores.rws2 as PathSpec) + suffix));
      return p.getAllStates('ctrl-certstore-li')
        .map(s => s['store-name'] ?? s['_title'] ?? '')
        .filter(Boolean);
    }

    /**
     * The PEM certificates held in one store, e.g.
     * `getCertificates('system/rws_store')` for the certificate RWS itself
     * presents. Live-verified 2026-08-06, class ctrl-certstore-cert.
     */
    async getCertificates(storePath: string): Promise<string[]> {
      const p = parse(await this.req('GET', `/ctrl/certstore/${storePath.replace(/^\/+/, '')}`));
      return p.getAllStates('ctrl-certstore-cert')
        .map(s => s['cert-pem'] ?? '')
        .filter(Boolean);
    }

    async listBackups(): Promise<Array<{ name: string; created?: string; size?: number }>> {
      // Backups live under /fileservice/BACKUP - list that volume
      try {
        const p = parse(await this.req('GET', '/fileservice/BACKUP'));
        return p.getAllStates('fs-dir').map(d => ({
          name: d['_title'] ?? '',
          created: d['fs-cdate'],
        }));
      } catch { return []; }
    }

    async createBackup(name: string): Promise<void> {
      const { path, body } = R2.createBackup(name);
      await this.req('POST', path, body);
    }

    /**
     * Restore a backup. Holds `edit` mastership (RW8: write access) around the
     * request: ABB's RobotWare 7 RWS page says "The user must have the
     * mastership on edit domain", and its RobotWare 8 page asks for write
     * access. The hold is released when the request returns, like every other
     * per-operation hold. Never run on our controllers.
     *
     * The backup is kept unless `opts.deleteBackup` is true: ABB's restore
     * form defaults `delete-dir` to true, which deletes the backup after the
     * restore, so the client always sends it, false unless the caller asks.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async restoreBackup(name: string, opts?: { deleteBackup?: boolean }): Promise<void> {
      const { path, body } = R2.restoreBackup(name, opts?.deleteBackup === true);
      await this.withAccess(['rapid'], () => this.req('POST', path, body));
    }

    /** Validate a backup without restoring it. Resolves when the controller
     *  reports the backup valid and restorable (HTTP 200); throws otherwise.
     *  Live-verified 2026-08-04 (RW7.21) against a freshly created backup.
     */
    async checkRestore(name: string): Promise<void> {
      const { path, body } = R2.checkRestore(name);
      await this.req('POST', path, body);
    }

    /**
     * List asynchronous long-running operations (backup, saveraw, ...). Each entry
     * is one /progress/{id} resource. GET /progress, live-verified 2026-08-04
     * (RW7.21): list items are class progress-li with the id in the self href and
     * the operation name as the title; state is only in the detail resource.
     */
    async listProgress(): Promise<Array<{ id: string; state: string; operation?: string }>> {
      try {
        const p = parse(await this.req('GET', '/progress'));
        return p.getAllStates('progress-li').map(e => ({
          id:        (e['_href'] ?? '').split('/').filter(Boolean).pop() ?? e['_title'] ?? '',
          state:     e['state'] ?? '',
          operation: e['_title'],
        }));
      } catch { return []; }
    }

    /**
     * Poll one long-running operation. GET /progress/{id}, live-verified 2026-08-04
     * (RW7.21): class progress with spans state (e.g. 'pending') and code.
     * `startJob` returns the id. ABB's job states are
     * `pending` while it runs and `ready` when it is done, with the
     * controller's return code in `details.code` (negative when the job
     * failed). `null` when the read is refused or carries no progress entry.
     */
    async getProgress(id: string): Promise<{ state: string; details?: Record<string, string> } | null> {
      try {
        const p = parse(await this.req('GET', `/progress/${encodeURIComponent(id)}`));
        const progress = p.getState('progress');
        const d = Object.keys(progress).length ? progress : p.getState('progress-ev');
        if (!Object.keys(d).length) { return null; }
        return { state: d['state'] ?? '', details: d };
      } catch { return null; }
    }

    /**
     * Is a backup running? Reads the state text at GET /ctrl/backup/state
     * (class ctrl-backup-state, field backup-state), the resource
     * `getBackupState` reads. This used to read /ctrl/backup, which is a
     * listing of links with no progress fields, so `active` was always false
     * and a caller polling after `createBackup` stopped at the first poll
     * (spec check 2026-10-07, RW 7.21.4 and 8.2.1).
     *
     * State texts seen on RW 7.21 / 8.x: 'Init State' and 'Backup in
     * Progress' while a backup runs; 'Backup Ready' or 'None' when idle;
     * 'Error during backup' or 'Invalid' after a failure. Note that the
     * state is still 'Backup Ready' from the previous backup for a moment
     * after `createBackup` answers 202, so a poller should expect at least
     * one busy reading, or watch the backup folder, before trusting idle.
     *
     * `progress` has no RWS 2.0 source and stays undefined.
     */
    async getBackupStatus(): Promise<{ active: boolean; progress?: number; phase?: string; failed?: boolean }> {
      const p = parse(await this.req('GET', buildPath(CTRL.getBackupStatus.rws2 as PathSpec)));
      const phase = p.getState('ctrl-backup-state')['backup-state'] ?? '';
      const text = phase.toLowerCase();
      // Whole-word matches on the texts seen live, not substrings: 'Invalid'
      // must not read as busy and a future wording must not read as idle by
      // accident. An unknown or empty text reads as failed, not idle: idle
      // would end a caller's poll early (the shape of the bug this replaces),
      // busy would keep it polling until its own limit; failed makes the
      // surprise visible in `phase`.
      const busy = text === 'init state' || text === 'backup in progress';
      const idle = text === 'backup ready' || text === 'none';
      return { active: busy, phase, failed: !busy && !idle };
    }

    /**
     * Safety controller status. /ctrl/safety itself is only a directory of links
     * (no aggregate state - it never carried a `ctrl-safety` class, so this used
     * to report 'unknown' always; corrected 2026-08 by reading the live tree).
     * The real state lives in the sub-resources, so this composes the mode with
     * the violation and load-status readings.
     */
    async getSafetyStatus(): Promise<{ state: string; details?: Record<string, string> }> {
      try {
        const [mode, violation, load] = await Promise.all([
          this.getSafetyMode().catch(() => ({ mode: 'unknown' } as { mode: string; userdata?: string })),
          this.getSafetyViolationInfo().catch(() => ({} as Record<string, string>)),
          this.getSafetyLoadStatus().catch(() => 'unknown'),
        ]);
        return {
          state: mode.mode,
          details: { safetymode: mode.mode, ...(mode.userdata ? { userdata: mode.userdata } : {}),
            'load-status': load, ...violation },
        };
      } catch { return { state: 'unavailable' }; }
    }

    /**
     * Safety zones: no RWS document has such a resource. ABB's Controller
     * service lists mode, violation, load, config and cbc under /ctrl/safety,
     * and RW 7.21.4 and 8.2.1 answer /ctrl/safety/zones with the same 404
     * "Resource is not supported on virtual controller" they give any made-up
     * /ctrl path, so the 404 says nothing about real hardware (spec check
     * 2026-10-07). Answers [] without a request. Kept for source compatibility;
     * to be retired at the next major version.
     * @deprecated There is no RWS resource behind this method.
     */
    async listSafetyZones(): Promise<Array<Record<string, string>>> {
      return [];
    }

    /**
     * RWS 2.0 has no operation that starts a cyclic brake check: ABB documents
     * only the status read (GET /ctrl/safety/cbc?drivenum=), and OPTIONS on
     * /ctrl/safety/cyclic-brake-check gives the VC's generic 404 for an unknown
     * /ctrl resource, not a "not on a VC" refusal (RW 7.21.4 and 8.2.1,
     * 2026-10-07). A brake check is started from RAPID or the FlexPendant.
     * Throws `RwsError` `UNSUPPORTED_OPERATION` before anything is sent; use
     * getCyclicBrakeCheckStatus(drivenum) to read whether one is due.
     */
    async runCyclicBrakeCheck(): Promise<void> {
      throw new RwsError(
        'RWS 2.0 has no operation that starts a cyclic brake check (it is started from RAPID or the FlexPendant); read its status with getCyclicBrakeCheckStatus(drivenum)',
        'UNSUPPORTED_OPERATION',
      );
    }

    /**
     * Cyclic brake check status for one drive unit. The resource REQUIRES the
     * `drivenum` query parameter (the controller advertises `cbc?drivenum=1` in
     * its own /ctrl/safety listing); class cbc-status carries
     * next-brake-check-time, last-brake-check-status and status (e.g. 'required').
     * Live-verified 2026-08 on RW7.21.
     */
    async getCyclicBrakeCheckStatus(drivenum = 1): Promise<{ status: string; lastStatus: string; nextCheckTime: number }> {
      const p = parse(await this.req('GET', `${buildPath(CTRL.getCyclicBrakeCheckStatus.rws2 as PathSpec)}?drivenum=${drivenum}`));
      const d = p.getState('cbc-status');
      return {
        status: d['status'] ?? 'unknown',
        lastStatus: d['last-brake-check-status'] ?? 'unknown',
        nextCheckTime: Number(d['next-brake-check-time'] ?? 0),
      };
    }

    /**
     * Virtual time of a virtual controller. /ctrl/virtualtime is a directory of
     * four sub-resources (vttime, vtstate, vtspeed, vttimeslice); this reads the
     * first three (RW 7.21.4 and 8.2.1, re-read 2026-10-07; Rev L agrees):
     *   /vttime  class ctrl-vttime,  field vtcounter:   milliseconds since the VC started
     *   /vtstate class ctrl-vtstate, field vtcurrstate: VTSTOP | VTFREERUN | VTRUNSLICE | VTNEXTEVENT
     *   /vtspeed class ctrl-vtspeed, field vtcurrspeed: percent of real time (100 = real time, -1 = full speed)
     * `running` is true for any state but VTSTOP (the read answers VTFREERUN
     * while running; this used to compare to 'running' and was always false).
     * `speed` is the factor the client's contract promises (1 = real time;
     * `Infinity` for -1); `state` carries the controller's own word. `time`
     * is in milliseconds (it used to be documented as microseconds).
     */
    async getVirtualTime(): Promise<{ time: number; running: boolean; speed?: number; state?: string; timeSlice?: number }> {
      const fetch = async (sub: string) => {
        try {
          const p = parse(await this.req('GET', `/ctrl/virtualtime/${sub}`));
          return p.getState(`ctrl-${sub}`) || {};
        } catch { return {}; }
      };
      const [time, state, speed] = await Promise.all([
        fetch('vttime'),
        fetch('vtstate'),
        fetch('vtspeed'),
      ]);
      const st = String(state['vtcurrstate'] ?? state['state'] ?? '').toUpperCase();
      const pct = speed['vtcurrspeed'] !== undefined ? Number(speed['vtcurrspeed']) : undefined;
      return {
        time:    Number(time['vtcounter'] ?? time['time'] ?? 0),
        running: st !== '' && st !== 'VTSTOP',
        speed:   pct === undefined || Number.isNaN(pct) ? undefined : pct < 0 ? Infinity : pct / 100,
        ...(st ? { state: st } : {}),
      };
    }

    /** Factor in, percent on the wire (100 = real time); `Infinity` sends -1,
     *  the controller's "as fast as possible". 0, a negative value or NaN is
     *  refused before sending: pause with RobotStudio's Simulation tab. The
     *  field is Rev L's `vtspeed`, with no action; the form's vtcurrspeed is
     *  refused with 400 "Invalid data value" on RW 7.21 and 8.2.
     */
    async setVirtualTimeScale(scale: number): Promise<void> {
      await this.req('POST', buildPath(CTRL.setVirtualTimeScale.rws2 as PathSpec), { vtspeed: String(virtualTimePercent(scale, 'RWS2')) });
    }

    /**
     * Sends nothing and throws `UNSUPPORTED_OPERATION`: pause and resume the
     * virtual clock from RobotStudio's Simulation tab.
     * @deprecated Kept so code written for 1.3.x still compiles; removed at the next major version (2.0).
     */
    async setVirtualTimeRunning(_running: boolean): Promise<void> {
      throw virtualTimeRunningUnsupported();
    }

    /**
     * Certificate STORES the controller exposes ('controller' and 'system' on a
     * stock RW7/RW8). The class is ctrl-certstore-li with a `store-name` span -
     * the previously parsed `ctrl-cert-li` is not emitted anywhere, so this
     * always returned an empty list (corrected 2026-08 from the live response).
     * Certificates themselves live under /ctrl/certstore/{store}.
     */
    async listCertificates(): Promise<Array<{ name: string; subject?: string; expires?: string }>> {
      try {
        const p = parse(await this.req('GET', buildPath(CTRL.listCertificateStores.rws2 as PathSpec)));
        return p.getAllStates('ctrl-certstore-li').map(c => ({
          name: c['store-name'] ?? c['name'] ?? c['_title'] ?? '',
          subject: c['subject'],
          expires: c['expires'] ?? c['valid-to'],
        })).filter(c => c.name);
      } catch { return []; }
    }

    /**
     * Add a PEM certificate to one store. ABB's "Add Certificate" (Rev L) and
     * the controller's form on RW 7.21.4 and 8.2.1 (ctrl-certstore-add,
     * 2026-10-07) take one form field, `filepath`: a /fileservice/ path of a
     * PEM file already on the controller. So this uploads the PEM to a
     * temporary file in $TEMP, posts the form to /ctrl/certstore/{store}, and
     * deletes the temporary file whether or not the add succeeded. The method
     * used to POST the PEM itself as application/x-pem-file to a path no
     * document or form describes.
     *
     * @param name the store path, e.g. 'controller/trust_ca_store' or
     *   'system/rws_store' (the values `listCertificateStores` gives; slashes
     *   kept). The parameter keeps its old name for source compatibility.
     * @throws RwsError `INVALID_ARGUMENT` before anything is sent for an empty
     *   store path or PEM. Built-not-run: whether RobotWare 8 also needs
     *   write access, and the success status (Rev L: 204), are unverified.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async uploadCertificate(name: string, pem: string): Promise<void> {
      const store = String(name ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
      if (!store) {
        throw new RwsError("RWS2 uploadCertificate: the store path is empty (for example 'controller/trust_ca_store')", 'INVALID_ARGUMENT');
      }
      if (typeof pem !== 'string' || pem.trim() === '') {
        throw new RwsError('RWS2 uploadCertificate: the PEM text is empty', 'INVALID_ARGUMENT');
      }
      const tmp = `$TEMP/abb-rws-cert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pem`;
      await this.req('PUT', `/fileservice/${tmp}`, undefined, pem, 'text/plain;v=2.0');
      try {
        await this.req('POST', `/ctrl/certstore/${store}`, { filepath: R2.toFileserviceUri(tmp) });
      } finally {
        await this.req('DELETE', `/fileservice/${tmp}`).catch(() => {});
      }
    }

    /**
     * Remove every certificate from one store: POST
     * /ctrl/certstore/{scope}/{store}/clear with an empty form, the one removal
     * ABB documents (Rev L "Remove Certificate") and the controller serves (RW
     * 7.21.4 and 8.2.1, 2026-10-07). There is no resource for a single
     * certificate. Built-not-run.
     * @throws RwsError `INVALID_ARGUMENT` before sending for an empty scope or store.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async clearCertificateStore(scope: string, store: string): Promise<void> {
      const s = String(scope ?? '').replace(/^\/+|\/+$/g, '');
      const t = String(store ?? '').replace(/^\/+|\/+$/g, '');
      if (!s || !t) {
        throw new RwsError("RWS2 clearCertificateStore: scope and store are both needed (for example 'controller', 'trust_ca_store')", 'INVALID_ARGUMENT');
      }
      await this.req('POST', `/ctrl/certstore/${s}/${t}/clear`, {});
    }

    /**
     * One certificate cannot be removed over RWS: no Allow header under
     * /ctrl/certstore lists DELETE on RW 7.21.4 or 8.2.1, and Rev L has no
     * per-certificate resource (spec check 2026-10-07). Throws `RwsError`
     * `UNSUPPORTED_OPERATION` before anything is sent; `clearCertificateStore`
     * empties a whole store. Kept so the public surface does not change.
     * @deprecated Use clearCertificateStore(scope, store).
     */
    async removeCertificate(name: string): Promise<void> {
      throw new RwsError(
        `RWS 2.0 has no operation that removes one certificate ('${name}'); clearCertificateStore(scope, store) removes every certificate in a store`,
        'UNSUPPORTED_OPERATION',
      );
    }

    /**
     * The registry files the controller exposes, as {name: resourceName}. The
     * root emits one `ctrl-reg-{name}-li` entry per file (cfgrules, cfgtext,
     * devices, elogtext, elogrules, hw-compatibility, option, rapid-metadata,
     * rapid-text, rw-services, uastext) - there is no `ctrl-registry` class, so
     * this used to return {} always (corrected 2026-08). Read a file's contents
     * with getRegistryFile().
     */
    async getRegistry(): Promise<Record<string, string>> {
      try {
        const body = await this.req('GET', buildPath(CTRL.getRegistry.rws2 as PathSpec));
        const out: Record<string, string> = {};
        for (const m of body.matchAll(/"_type"\s*:\s*"ctrl-reg-([a-z-]+)-li"[^}]*?"_title"\s*:\s*"([^"]*)"/g)) {
          out[m[2] || m[1]] = m[1];
        }
        if (Object.keys(out).length === 0) {
          // XHTML representation fallback (older RW7 releases negotiate XHTML).
          for (const m of body.matchAll(/class="ctrl-reg-([a-z-]+)-li"[^>]*title="([^"]*)"/g)) { out[m[2] || m[1]] = m[1]; }
        }
        return out;
      } catch { return {}; }
    }

    /**
     * Compress a file or directory into an archive. The controller form fields
     * are `srcpath` / `dstpath` (the spec's `source`/`destination` are rejected
     * with "Source path is missing"), and the values must be fileservice URIs.
     *
     * The controller answers 202 and builds the archive after that; this
     * resolves at the 202 and returns nothing, as in 1.4.0. To wait for the
     * archive, start it with `startJob('compressPath', source, destination)`,
     * which returns the job's progress id.
     */
    async compressPath(source: string, destination: string): Promise<void> {
      await this.startJob('compressPath', source, destination);
    }

    /**
     * Decompress an archive created by compressPath (same field and URI
     * rules). Wait for the compress job first: start it with `startJob`.
     * Returns nothing, as in 1.4.0; `startJob('decompressPath', ...)` returns
     * this job's progress id.
     *
     * @experimental Built from the controller form; never run against an RWS 2.0 controller.
     */
    async decompressPath(source: string, destination: string): Promise<void> {
      await this.startJob('decompressPath', source, destination);
    }

    /**
     * Start a controller job, `compressPath` or `decompressPath` (the same
     * request, fields and URI rules as that method), and return its progress
     * id, read from the `Location: /progress/{id}` header ABB documents
     * (Rev L), or `undefined` when the answer has none. The controller answers
     * 202 and runs the job after that: poll `getProgress(id)` until its
     * `state` is no longer `pending` (ABB's finished state is `ready`);
     * `details.code` is then the controller's return code, negative when the
     * job failed.
     *
     * @throws RwsError `INVALID_ARGUMENT` for a name that is not one of these
     *   jobs, before sending; otherwise the controller's typed error.
     */
    async startJob(name: ControllerJobName, source: string, destination: string): Promise<string | undefined> {
      const row = CTRL[controllerJobName(name, 'RWS2 startJob')];
      let location: string | undefined;
      await this.req('POST', buildPath(row.rws2 as PathSpec), {
        srcpath: R2.toFileserviceUri(source), dstpath: R2.toFileserviceUri(destination),
      }, undefined, undefined, [], undefined, (_status, headers) => {
        const h = headers['location'];
        location = Array.isArray(h) ? h[0] : h;
      });
      return progressIdFrom(location);
    }

    /**
     * The name and description of a controller return code, GET
     * /rw/retcode?code=N. The controller serves English only (Rev L
     * Retcode_Service.yaml); the `lang` query this used to append is
     * undocumented and ignored, and it went out unencoded (spec check
     * 2026-10-07/09, RW 7.21.4 and 8.2.1). It is no longer sent.
     * @param lang kept for source compatibility; ignored.
     * @deprecated the `lang` parameter: the controller answers English only.
     */
    async getReturnCode(code: number, lang = 'en'): Promise<{ code: number; title: string; desc: string } | null> {
      void lang;
      try {
        // Class is err-desc with spans name / code / severity / description -
        // NOT rw-retcode with title/desc, which is never emitted (fixed 2026-08;
        // this used to return null for every code). `title` keeps carrying the
        // symbolic name (e.g. SYS_CTRL_E_MASTER_REJECT) for source compatibility.
        const p = parse(await this.req('GET', `/rw/retcode?code=${code}`));
        const d = p.getState('err-desc');
        if (!d['description'] && !d['name']) { return null; }
        return { code, title: d['name'] ?? '', desc: d['description'] ?? '' };
      } catch { return null; }
    }

    /**
     * Installed RobotWare options. /ctrl/options answers 200 with NO content on
     * RW7/RW8 (it is a verify-one-option endpoint: /ctrl/options/{option}), so
     * this used to return an empty list. The actual installed-option list is
     * /rw/system/options, class sys-option-li with an `option` span - live-verified
     * 2026-08 (fixed endpoint and class).
     */
    async listControllerOptions(): Promise<Array<{ name: string; description?: string }>> {
      const p = parse(await this.req('GET', buildPath(SYSTEM_MASTERSHIP.listControllerOptions.rws2 as PathSpec)));
      return p.getAllStates('sys-option-li').map(o => ({
        name: o['option'] ?? o['name'] ?? '',
        description: o['description'],
      })).filter(o => o.name);
    }

    /** Verify one controller feature. /ctrl/features is a verify-style endpoint
     *  (`/ctrl/features/{id}`) and returns no list of its own, so the bare listing
     *  is empty on RW7/RW8 - pass a feature id to check it. */
    async listFeatures(): Promise<Array<Record<string, string>>> {
      const p = parse(await this.req('GET', buildPath(CTRL.listFeatures.rws2 as PathSpec)));
      return p.getAllStates('ctrl-feature');
    }

    /**
     * Is one controller feature present? GET /ctrl/features/{feature}, with
     * `?robno=` when a robot number is given (the controller defaults to 1).
     *
     * ABB's Controller_Service.yaml (Rev L, "Verify Option Resource") answers
     * 204 when the feature is present for that robot and 404 when it is not;
     * the id is case sensitive (ABB's example:
     * `abb.robotics.robotcontrol.controllerhw.m28.01`). listFeatures' bare
     * listing is always empty, so asking by id is the only way to find out.
     * /ctrl/features is linked from /ctrl on RW 7.21.4+417 and 8.2.1+1023
     * (2026-09-29); both answered 404 (false) for an id no controller has and
     * for ABB's example id above (2026-10-01). No id answered true yet.
     *
     * Every 404 reads as false, including one from a controller that has no
     * /ctrl/features resource at all: ABB documents 404 as "not present", and
     * a missing service is not told apart from a missing feature.
     *
     * @returns true on any 2xx answer, false on any 404.
     * @throws RwsError `INVALID_ARGUMENT`, before anything is sent, for an
     *   empty id or a robot number that is not a positive integer; any other
     *   failure is thrown as the controller answered it.
     */
    async verifyControllerFeature(featureId: string, robno?: number): Promise<boolean> {
      if (typeof featureId !== 'string' || featureId.trim() === '') {
        throw new RwsError('RWS2 verifyControllerFeature: feature id is empty', 'INVALID_ARGUMENT');
      }
      if (robno !== undefined && (!Number.isInteger(robno) || robno < 1)) {
        throw new RwsError(`RWS2 verifyControllerFeature: robno must be a positive integer (got ${robno})`, 'INVALID_ARGUMENT');
      }
      const path = buildPath(CTRL.verifyControllerFeature.rws2 as PathSpec, { feature: featureId });
      try {
        await this.req('GET', robno === undefined ? path : `${path}?robno=${robno}`);
        return true;
      } catch (e) {
        if (e instanceof RwsError && e.httpStatus === 404) { return false; }
        throw e;
      }
    }

    /**
     * Saved controller diagnostics. GET /ctrl/diagnostics.
     *
     * A controller with nothing saved answers HTTP 400 "No Diagnostics Saved on
     * controller yet" (the RW 7.21 and 8.1.1 virtual controllers, 2026-08-09;
     * RW 7.21.4 and 8.2.1, 2026-09-29) - that is an empty state, not a
     * failure, so it is reported as `{ empty: true, entries: [] }` rather than
     * thrown. The listing of a saved bundle (`ctrl-diagnostics-li`) is read
     * as built from the controller form.
     *
     * @experimental Built from the controller form; no logged 2xx on an RWS 2.0 controller (the virtual controllers gave only the empty-state 400).
     */
    async getDiagnostics(): Promise<DiagnosticsInfo> {
      let xml: string;
      try {
        xml = await this.req('GET', buildPath(CTRL.getDiagnostics.rws2 as PathSpec));
      } catch (e) {
        if (e instanceof RwsError && e.httpStatus === 400
            && /no diagnostics saved/i.test(e.controllerMsg ?? e.message)) {
          return { empty: true, entries: [] };
        }
        throw e;
      }
      const p = parse(xml);
      const entries = p.getAllStates('ctrl-diagnostics-li');
      return { empty: entries.length === 0, entries };
    }

    /**
     * Ask the controller to save a diagnostics bundle.
     * POST /ctrl/diagnostics/save, form field `dstpath`.
     *
     * ABB's Controller_Service.yaml (Rev L) documents one required body field,
     * `dstpath`, "Fully qualified file name to save the diagnostic log", and
     * its samples send dstpath=/fileservice/$TEMP/sysdump/diagnostics.log. The
     * method used to send `data`, which the controller does not read: every
     * 2026-08-09 attempt (empty body, data=, path=, filepath=) answered 400 "No
     * destination path in the data parameter", where "data parameter" is the
     * controller's word for the form body as a whole, as in its "backup data
     * parameter is invalid". The client sends `dstpath` since a spec check
     * (2026-10-07). ABB marks the operation not supported on a virtual
     * controller, and the OPTIONS form on RW 7.21.4 and 8.2.1 lists no inputs;
     * run against RWS 2.0 (RobotWare 7.21.4).
     *
     * @param destination a controller path such as '$TEMP/diagnostics.log',
     *   sent as a /fileservice/ URI. It is optional in the signature for source
     *   compatibility, but ABB marks it required: without it `RwsError`
     *   `INVALID_ARGUMENT` is thrown before anything is sent.
     *
     * RobotWare 7.15.0: ABB lists "System failure when requesting a system
     * diagnostics" among the corrections in 7.15.1 (ABB RobotWare release notes
     * 7.15.1 §3 Corrections, p.3; title only - no trigger, condition or
     * interface is named, and whether an RWS request is one of the affected
     * paths is not stated) (release notes, 2026-09-29). When the version
     * `connect()` cached is 7.15.0 this method warns before sending and still
     * sends: the note does not say RWS is affected, and a caller who wants the
     * bundle on that release should get it. No version is fetched for this.
     */
    async saveDiagnostics(destination?: string): Promise<void> {
      if (typeof destination !== 'string' || destination.trim() === '') {
        throw new RwsError("RWS2 saveDiagnostics: a destination file is needed (ABB marks dstpath required; for example '$TEMP/diagnostics.log')", 'INVALID_ARGUMENT');
      }
      const rw = this.cachedRobotWareVersion();
      if (rw !== null && /^7\.15\.0(?:[^0-9]|$)/.test(rw)) {
        Logger.warn(`RWS2 saveDiagnostics: RobotWare ${rw} - ABB's 7.15.1 release notes list "System failure when requesting a system diagnostics" as corrected in 7.15.1; sending the request anyway`);
      }
      await this.req('POST', buildPath(CTRL.saveDiagnostics.rws2 as PathSpec), { dstpath: R2.toFileserviceUri(destination) });
    }

    /**
     * Controller language. POST /ctrl/lang, form field `lang`
     * (live-read 2026-08-09).
     *
     * Write-only in practice: the Allow header claims `GET,POST,OPTIONS` but GET
     * answers 405 on both RW7.21 and RW8.1.1. The Allow header is wrong; this is
     * recorded rather than worked around.
     */
    async setControllerLanguage(lang: string): Promise<void> {
      await this.req('POST', buildPath(CTRL.setControllerLanguage.rws2 as PathSpec), { lang });
    }

    /**
     * One controller environment variable, such as `HOME`, `TEMP` or
     * `SYSTEM` (a leading `$` is accepted and dropped). ABB's "Get Controller
     * Environment Variable" (Rev L Controller service): `GET /ctrl/${ENVNAME}`,
     * the `$` sent as `%24`, answered with one `ctrl-env` entry whose
     * `value` is returned. An unknown name is the controller's 404. RW 7.21.4
     * and 8.2.1 virtual controllers answered `TEMP`, `HOME` and `BACKUP`
     * (2026-10-18).
     *
     * @throws RwsError `INVALID_ARGUMENT` for an empty name, before sending;
     *   `PARSE_ERROR` when the answer has no `ctrl-env` value.
     */
    async getEnv(name: string): Promise<string> {
      const bare = envName(name, 'RWS2 getEnv');
      const p = parse(await this.req('GET', buildPath(CTRL.getEnv.rws2 as PathSpec, { name: bare })));
      return envValueFrom(p.getAllEntries(), `RWS2 getEnv(${bare})`);
    }

    /**
     * Whether the controller hardware can run a RobotWare version: ABB's
     * "Check Robotware Version Compatibility" (Rev L Controller service),
     * `GET /ctrl/compatibility/{robotware version}`, answered with one
     * `ctrl-compatibility` entry whose `status` is `true` or `false`. ABB
     * lists it for real controllers only; the virtual controllers answer 404.
     *
     * @param robotWareVersion the version to check, as ABB's example writes
     *   it (`7.16`). Without it, the version the controller runs: the
     *   `rwversion` `connect()` read from `GET /rw/system` (for example
     *   `8.2.1+1023`), or one read of `/rw/system` first when there is none,
     *   sent as the controller wrote it.
     * @throws RwsError `INVALID_ARGUMENT` for an empty version, before
     *   sending; the controller's typed error when it refuses the read (never
     *   `compatible: false`); `PARSE_ERROR` when the answer has no
     *   `ctrl-compatibility` status of true or false, or, without a version,
     *   when `/rw/system` names no RobotWare version.
     * @experimental Built from ABB's Rev L page; never run against an RWS 2.0 controller.
     */
    async getCompatibility(robotWareVersion?: string): Promise<RobotWareCompatibility> {
      const version = await compatibilityVersion(robotWareVersion, async () =>
        this.cachedRobotWareVersion() ?? (await (this as unknown as SystemMethods).getSystemInfo()).rwVersion,
      'RWS2 getCompatibility');
      const p = parse(await this.req('GET', buildPath(CTRL.getCompatibility.rws2 as PathSpec, { version })));
      return compatibilityFrom(p.getAllEntries(), `RWS2 getCompatibility(${version})`);
    }
  };
}

/**
 * Public surface this mixin contributes. A NAMED interface is required so the
 * composed `RwsClient2` declaration never describes an anonymous mixin class
 * (TS4094 on Rws2Core's protected members). The test suite calls every method,
 * so a signature that drifts from the implementation is caught at build time.
 */
export interface CtrlMethods {
  setVirtualTimeTimeslice(vttimeslice: number): Promise<void>;
  getSafetyMode(): Promise<{ mode: string; userdata?: string }>;
  getSafetyViolationInfo(): Promise<Record<string, string>>;
  getSafetyLoadStatus(): Promise<string>;
  getSafetyStartupStatus(): Promise<string>;
  getSafetyConfigChangeCount(): Promise<number>;
  getSafetyConfig(): Promise<{ status: string; configuration: Record<string, string> }>;
  getVirtualTimeTimeslice(): Promise<number>;
  getRegistryFile(name: string): Promise<string>;
  listLdapResources(): Promise<string[]>;
  getLdapResource(name: string): Promise<Record<string, string>>;
  describeReturnCode(code: number): Promise<ReturnCodeInfo | null>;
  getBackupState(): Promise<string>;
  listCertificateStores(path?: string): Promise<string[]>;
  getCertificates(storePath: string): Promise<string[]>;
  listBackups(): Promise<Array<{ name: string; created?: string; size?: number }>>;
  createBackup(name: string): Promise<void>;
  restoreBackup(name: string, opts?: { deleteBackup?: boolean }): Promise<void>;
  checkRestore(name: string): Promise<void>;
  listProgress(): Promise<Array<{ id: string; state: string; operation?: string }>>;
  getProgress(id: string): Promise<{ state: string; details?: Record<string, string> } | null>;
  getBackupStatus(): Promise<{ active: boolean; progress?: number; phase?: string; failed?: boolean }>;
  getSafetyStatus(): Promise<{ state: string; details?: Record<string, string> }>;
  listSafetyZones(): Promise<Array<Record<string, string>>>;
  runCyclicBrakeCheck(): Promise<void>;
  getCyclicBrakeCheckStatus(drivenum?: number): Promise<{ status: string; lastStatus: string; nextCheckTime: number }>;
  getVirtualTime(): Promise<{ time: number; running: boolean; speed?: number; state?: string; timeSlice?: number }>;
  setVirtualTimeScale(scale: number): Promise<void>;
  /** @deprecated Sends nothing and throws `UNSUPPORTED_OPERATION`; pause and resume the virtual clock from RobotStudio's Simulation tab. Removed in 2.0. */
  setVirtualTimeRunning(running: boolean): Promise<void>;
  listCertificates(): Promise<Array<{ name: string; subject?: string; expires?: string }>>;
  uploadCertificate(name: string, pem: string): Promise<void>;
  clearCertificateStore(scope: string, store: string): Promise<void>;
  removeCertificate(name: string): Promise<void>;
  getRegistry(): Promise<Record<string, string>>;
  compressPath(source: string, destination: string): Promise<void>;
  decompressPath(source: string, destination: string): Promise<void>;
  startJob(name: ControllerJobName, source: string, destination: string): Promise<string | undefined>;
  getReturnCode(code: number, lang?: string): Promise<{ code: number; title: string; desc: string } | null>;
  listControllerOptions(): Promise<Array<{ name: string; description?: string }>>;
  listFeatures(): Promise<Array<Record<string, string>>>;
  verifyControllerFeature(featureId: string, robno?: number): Promise<boolean>;
  getDiagnostics(): Promise<DiagnosticsInfo>;
  saveDiagnostics(destination?: string): Promise<void>;
  setControllerLanguage(lang: string): Promise<void>;
  getEnv(name: string): Promise<string>;
  getCompatibility(robotWareVersion?: string): Promise<RobotWareCompatibility>;
}

/** Guard: the mixin class must provide every CtrlMethods member (never exported). */
type _CtrlMethodsComplete = InstanceType<ReturnType<typeof ctrlOps>> extends CtrlMethods ? true : never;
const _ctrlComplete: _CtrlMethodsComplete = true;
void _ctrlComplete;

export function CtrlOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<CtrlMethods> {
  return ctrlOps(Base) as unknown as TBase & GConstructor<CtrlMethods>;
}
