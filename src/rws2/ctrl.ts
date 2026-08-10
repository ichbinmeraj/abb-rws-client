import { CTRL, SYSTEM_MASTERSHIP, USERS_UAS } from '../paths/index.js';
import { buildPath, type PathSpec } from '../paths/PathSpec.js';
import * as R2 from '../ResourceMapper2.js';
import { RwsError, type DiagnosticsInfo, type ReturnCodeInfo } from '../types.js';
import { parse } from './core.js';
import type { GConstructor, Rws2Base } from './mixin.js';

/**
 * Controller domain (`/ctrl`): backup/restore, safety, virtual time, certstore, registry, compress, diagnostics, options.
 * Endpoint methods for this RWS domain, composed onto `Rws2Core` as a mixin.
 */
function ctrlOps<TBase extends Rws2Base>(Base: TBase) {
  return class extends Base {
    /** Set the virtual-time timeslice (VC only; form field `vttimeslice`). */
    async setVirtualTimeTimeslice(vttimeslice: number): Promise<void> {
      await this.req('POST', buildPath(CTRL.setVirtualTimeTimeslice.rws2 as PathSpec), { vttimeslice: String(vttimeslice) });
    }

    /** Safety controller mode, e.g. 'active' (class safetymodestatus). */
    async getSafetyMode(): Promise<{ mode: string; userdata?: string }> {
      const p = parse(await this.req('GET', buildPath(CTRL.getSafetyMode.rws2 as PathSpec)));
      const d = p.getState('safetymodestatus');
      return { mode: d['safetymode'] ?? 'unknown', userdata: d['userdata'] };
    }

    /** Safety violation counters (class safety-violationinfo). */
    async getSafetyViolationInfo(): Promise<Record<string, string>> {
      const p = parse(await this.req('GET', buildPath(CTRL.getSafetyViolationInfo.rws2 as PathSpec)));
      return p.getState('safety-violationinfo');
    }

    /** Safety configuration load status (class scorch-load-status). */
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

    async restoreBackup(name: string): Promise<void> {
      const { path, body } = R2.restoreBackup(name);
      await this.req('POST', path, body);
    }

    /** Validate a backup without restoring it. Resolves when the controller
     *  reports the backup valid and restorable (HTTP 200); throws otherwise.
     *  Live-verified 2026-08-04 (RW7.21) against a freshly created backup. */
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

    /** Poll one long-running operation. GET /progress/{id}, live-verified 2026-08-04
     *  (RW7.21): class progress with spans state (e.g. 'pending') and code. */
    async getProgress(id: string): Promise<{ state: string; details?: Record<string, string> } | null> {
      try {
        const p = parse(await this.req('GET', `/progress/${encodeURIComponent(id)}`));
        const d = p.getState('progress') || p.getState('progress-ev');
        if (!Object.keys(d).length) { return null; }
        return { state: d['state'] ?? '', details: d };
      } catch { return null; }
    }

    async getBackupStatus(): Promise<{ active: boolean; progress?: number; phase?: string }> {
      const p = parse(await this.req('GET', buildPath(CTRL.getBackupStatus.rws2 as PathSpec)));
      const d = p.getState('ctrl-backup-info-li') || p.getState('ctrl-backup-info');
      const phase = d['progress-state'] ?? d['phase'] ?? '';
      return {
        active: phase !== '' && phase !== 'idle' && phase !== 'finished',
        progress: d['progress'] ? +d['progress'] : undefined,
        phase,
      };
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

    /** Safety zones. NOTE: /ctrl/safety/zones does not exist on RobotWare 7/8
     *  (HTTP 404 - the safety tree exposes mode/cbc/config/violation/load
     *  instead), so this returns an empty list. Kept for source compatibility. */
    async listSafetyZones(): Promise<Array<Record<string, string>>> {
      try {
        const p = parse(await this.req('GET', buildPath(CTRL.listSafetyZones.rws2 as PathSpec)));
        return p.getAllStates('ctrl-safety-zone-li');
      } catch { return []; }
    }

    /**
     * Trigger a cyclic brake check. CAUTION: /ctrl/safety/cyclic-brake-check
     * answers 404 "Resource is not supported on virtual controller" (live-probed
     * 2026-08, RW7.21), and /ctrl/safety/cbc is GET-only (405 on POST). The brake
     * check is normally started from RAPID; this call is retained for real
     * hardware, where the resource may exist. Use getCyclicBrakeCheckStatus() to
     * read whether a check is required or when the last one ran.
     */
    async runCyclicBrakeCheck(): Promise<void> {
      await this.req('POST', buildPath(CTRL.runCyclicBrakeCheck.rws2 as PathSpec));
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

    async getVirtualTime(): Promise<{ time: number; running: boolean; speed?: number; timeSlice?: number }> {
      // Live-verified: /ctrl/virtualtime is a directory of 4 sub-resources (vttime, vtspeed, vtstate, vttimeslice).
      // Fetch each and assemble the result.
      // Live-verified field names (RobotWare 7.21):
      //   /vttime  → class="ctrl-vttime"  → span "vtcounter"   (microseconds since boot)
      //   /vtstate → class="ctrl-vtstate" → span "vtcurrstate" ("running"/"stopped")
      //   /vtspeed → class="ctrl-vtspeed" → span "vtcurrspeed" (1.0=real, 10=10x)
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
      return {
        time:    Number(time['vtcounter'] ?? time['time'] ?? 0),
        running: (state['vtcurrstate'] ?? state['state'] ?? '').toLowerCase() === 'running',
        speed:   speed['vtcurrspeed'] !== undefined ? +speed['vtcurrspeed'] : undefined,
      };
    }

    async setVirtualTimeRunning(running: boolean): Promise<void> {
      await this.req('POST', buildPath(CTRL.setVirtualTimeRunning.rws2 as PathSpec), { vtcurrstate: running ? 'running' : 'stopped' });
    }

    async setVirtualTimeScale(scale: number): Promise<void> {
      await this.req('POST', buildPath(CTRL.setVirtualTimeScale.rws2 as PathSpec), { vtcurrspeed: String(scale) });
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

    async uploadCertificate(name: string, pem: string): Promise<void> {
      await this.req('POST', buildPath(CTRL.uploadCertificate.rws2 as PathSpec, { name }), undefined, pem, 'application/x-pem-file');
    }

    async removeCertificate(name: string): Promise<void> {
      await this.req('DELETE', buildPath(CTRL.removeCertificate.rws2 as PathSpec, { name }));
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

    /** Compress a file or directory into a zip. The controller form fields are
     *  `srcpath` / `dstpath` (the spec's `source`/`destination` are rejected with
     *  "Source path is missing"), and the values must be fileservice URIs.
     *  Live round-tripped 2026-08 (RW7.21): compress then decompress in TEMP. */
    async compressPath(source: string, destination: string): Promise<void> {
      await this.req('POST', buildPath(CTRL.compressPath.rws2 as PathSpec), {
        srcpath: R2.toFileserviceUri(source), dstpath: R2.toFileserviceUri(destination),
      });
    }

    /** Decompress a zip created by compressPath (same field and URI rules). */
    async decompressPath(source: string, destination: string): Promise<void> {
      await this.req('POST', buildPath(CTRL.decompressPath.rws2 as PathSpec), {
        srcpath: R2.toFileserviceUri(source), dstpath: R2.toFileserviceUri(destination),
      });
    }

    async getReturnCode(code: number, lang = 'en'): Promise<{ code: number; title: string; desc: string } | null> {
      try {
        // Class is err-desc with spans name / code / severity / description -
        // NOT rw-retcode with title/desc, which is never emitted (fixed 2026-08;
        // this used to return null for every code). `title` keeps carrying the
        // symbolic name (e.g. SYS_CTRL_E_MASTER_REJECT) for source compatibility.
        const p = parse(await this.req('GET', `/rw/retcode?code=${code}&lang=${lang}`));
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
     * Saved controller diagnostics. GET /ctrl/diagnostics.
     *
     * A controller with nothing saved answers HTTP 400 "No Diagnostics Saved on
     * controller yet" (live-verified 2026-08-09 on both RW7.21 and RW8.1.1) -
     * that is an empty state, not a failure, so it is reported as
     * `{ empty: true, entries: [] }` rather than thrown.
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
     * POST /ctrl/diagnostics/save.
     *
     * Not reachable on the virtual controllers. The OPTIONS form advertises the
     * action with NO fields (`<form id="save" method="post" action=""/>`), yet
     * every request answers 400 "No destination path in the data parameter" -
     * with an empty body, with `data=`, `path=` or `filepath=` form fields, and
     * with JSON or text/plain bodies (those add a 406 on top). Live-probed
     * 2026-08-09 across both RW7.21 and RW8.1.1; nothing the controller describes
     * satisfies it, so the destination is passed some way the VC does not expose.
     *
     * Kept because the path and method are real and a physical controller may
     * accept it; expect `RwsError` with httpStatus 400 on a VC.
     */
    async saveDiagnostics(destination?: string): Promise<void> {
      await this.req(
        'POST', buildPath(CTRL.saveDiagnostics.rws2 as PathSpec),
        destination === undefined ? undefined : { data: destination },
      );
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
  restoreBackup(name: string): Promise<void>;
  checkRestore(name: string): Promise<void>;
  listProgress(): Promise<Array<{ id: string; state: string; operation?: string }>>;
  getProgress(id: string): Promise<{ state: string; details?: Record<string, string> } | null>;
  getBackupStatus(): Promise<{ active: boolean; progress?: number; phase?: string }>;
  getSafetyStatus(): Promise<{ state: string; details?: Record<string, string> }>;
  listSafetyZones(): Promise<Array<Record<string, string>>>;
  runCyclicBrakeCheck(): Promise<void>;
  getCyclicBrakeCheckStatus(drivenum?: number): Promise<{ status: string; lastStatus: string; nextCheckTime: number }>;
  getVirtualTime(): Promise<{ time: number; running: boolean; speed?: number; timeSlice?: number }>;
  setVirtualTimeRunning(running: boolean): Promise<void>;
  setVirtualTimeScale(scale: number): Promise<void>;
  listCertificates(): Promise<Array<{ name: string; subject?: string; expires?: string }>>;
  uploadCertificate(name: string, pem: string): Promise<void>;
  removeCertificate(name: string): Promise<void>;
  getRegistry(): Promise<Record<string, string>>;
  compressPath(source: string, destination: string): Promise<void>;
  decompressPath(source: string, destination: string): Promise<void>;
  getReturnCode(code: number, lang?: string): Promise<{ code: number; title: string; desc: string } | null>;
  listControllerOptions(): Promise<Array<{ name: string; description?: string }>>;
  listFeatures(): Promise<Array<Record<string, string>>>;
  getDiagnostics(): Promise<DiagnosticsInfo>;
  saveDiagnostics(destination?: string): Promise<void>;
  setControllerLanguage(lang: string): Promise<void>;
}

/** Guard: the mixin class must provide every CtrlMethods member (never exported). */
type _CtrlMethodsComplete = InstanceType<ReturnType<typeof ctrlOps>> extends CtrlMethods ? true : never;
const _ctrlComplete: _CtrlMethodsComplete = true;
void _ctrlComplete;

export function CtrlOps<TBase extends Rws2Base>(Base: TBase): TBase & GConstructor<CtrlMethods> {
  return ctrlOps(Base) as unknown as TBase & GConstructor<CtrlMethods>;
}
