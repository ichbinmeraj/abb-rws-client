/**
 * Panel domain path table (`/rw/panel`) - the canonical example for the others.
 *
 * Every path and quirk below is live-verified against the VCs (IRC5 RW6.16,
 * OmniCore RW7.21 / RW8.1.1). Where a comment states a controller behaviour, it
 * was observed, not read from the ABB PDF (which has errors). Anomalies worth
 * carrying forward are stated on the operation, not hidden.
 */

import type { DomainTable } from './PathSpec.js';

export const PANEL: DomainTable = {
  // ── Controller state ──────────────────────────────────────────────────────
  getControllerState: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read the controller motor state (motoron / motoroff / init / …).',
    // The ONLY hyphen rename in the panel domain: 2.0 `ctrl-state`, 1.0
    // `ctrlstate`. Note the subscription state-param and response span stay
    // unhyphenated (`ctrlstate`) on BOTH - see subscribeControllerState.
    rws2: { method: 'GET', path: '/rw/panel/ctrl-state' },
    rws1: { method: 'GET', path: '/rw/panel/ctrlstate' },
    note: 'ctrl-state vs ctrlstate hyphen rename; subscription param stays ctrlstate on both.',
  },
  setControllerState: {
    tier: 'core', evidence: 'live', effect: 'write',
    summary: 'Set the motor state. Requires mastership (acquired one layer up).',
    rws2: { method: 'POST', path: '/rw/panel/ctrl-state', fields: ['ctrl-state'] },
    rws1: { method: 'POST', path: '/rw/panel/ctrlstate', action: 'setctrlstate', fields: ['ctrl-state'] },
    note: '2.0 plain POST vs 1.0 ?action=setctrlstate; same body field.',
  },

  // ── Operation mode ────────────────────────────────────────────────────────
  getOperationMode: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read the operation mode (AUTO / MANR / MANF).',
    rws2: { method: 'GET', path: '/rw/panel/opmode' },
    rws1: { method: 'GET', path: '/rw/panel/opmode' },
  },
  setOperationMode: {
    tier: 'core', evidence: 'live', effect: 'write',
    summary: 'Switch the operation mode. Virtual controllers only.',
    // Wire value differs: 2.0 `manf`, 1.0 `manfs`; both lowercase on write,
    // uppercase on read. VC-only (real hardware uses the key switch).
    rws2: { method: 'POST', path: '/rw/panel/opmode', fields: ['opmode'] },
    rws1: {
      method: 'POST', path: '/rw/panel/opmode', fields: ['opmode'],
      gap: 'RWS 1.0 has no operating-mode change: ABB\'s manual (Rev M) has none, the RW 6.16.03 form offers only lock, unlock and acknowledge, and POST opmode= answers 400 "NO/Invalid action parameter" (also with ?action=setopmode or set, 2026-10-09). The client refuses before sending.',
    },
    note: 'RWS 2.0 only; on an IRC5 the key switch changes the mode. RobotWare 8 needs control-station write access for the switch (403 -1073435873 without it, RW 8.2.1, 2026-10-12); the client holds it there. With it held, RW 8.2.1 accepted the switch request (2026-10-13); a switch to AUTO then waits in AUTO_CH until a person confirms it at the FlexPendant.',
  },
  acknowledgeOperationMode: {
    tier: 'common', evidence: 'built', effect: 'write',
    summary: 'Confirm a pending operation-mode switch.',
    rws2: { method: 'POST', path: '/rw/panel/opmode/acknowledge', fields: ['opmode'] },
    // RW 6.16.03's opmode form offers lock, unlock and acknowledge. The
    // acknowledge is left out on purpose: confirming a change of operating
    // mode is the person's confirmation at the FlexPendant, which RobotWare
    // asks for so that someone at the robot sees the change. RWS1Adapter has
    // no method for it, and RobotManager.setOperationMode does not send it.
    rws1: {
      method: 'POST', path: '/rw/panel/opmode', action: 'acknowledge', fields: ['opmode'],
      gap: 'deliberately not wrapped: the operating-mode confirmation belongs to the person at the FlexPendant',
    },
    note: 'RWS 2.0 method (OPTIONS-verified RW7.21), kept off IRWSAdapter; the RWS 1.0 form exists and is deliberately not wrapped. The confirmation is the person\'s at the FlexPendant; RobotManager.setOperationMode does not send it.',
  },
  getOperationModeLockState: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read whether the operation-mode key switch is locked.',
    rws2: { method: 'GET', path: '/rw/panel/opmode/lock-state' },
    note: 'RWS 2.0 only; 404 on RW6.16.',
  },
  lockOperationMode: {
    tier: 'niche', evidence: { rws2: 'live', rws1: 'built' }, effect: 'write',
    summary: 'Lock the operating-mode selection with a PIN.',
    rws2: { method: 'POST', path: '/rw/panel/opmode/lock', fields: ['pin', 'permanent'] },
    rws1: { method: 'POST', path: '/rw/panel/opmode', action: 'lock', fields: ['pin', 'permanent'] },
    note: '2.0 sub-path /lock vs 1.0 ?action=lock. 2.0 answered 204 with permanent=1 on RW 7.21.4, 8.1.1 and 8.2.1 VCs (2026-10-10); without permanent it is 400 "Data parameter permanent is missing". 1.0 was sent on RW 6.16.03 (2026-10-13, permanent=0) and refused 403 -1073445867 SYS_CTRL_E_UAS_REJECT "The required option is missing" (icode -7701): the ABB Rev M page names two UAS grants for the lock and no option, so the option the VC lacks is not named. No logged 2xx on 1.0.',
  },
  unlockOperationMode: {
    tier: 'niche', evidence: { rws2: 'live', rws1: 'built' }, effect: 'write',
    summary: 'Unlock the operating-mode selection with the PIN the lock set.',
    // The unlock form has a `pin` field on RW 6.16.03, 7.21.4 and 8.2.1, and
    // Rev L and the RWS site mark it required; the client used to post an
    // empty body (spec check 2026-10-07). The PIN is the one the lock set.
    rws2: { method: 'POST', path: '/rw/panel/opmode/unlock', fields: ['pin'] },
    rws1: { method: 'POST', path: '/rw/panel/opmode', action: 'unlock', fields: ['pin'] },
    note: '2.0 sub-path /unlock vs 1.0 ?action=unlock; both take the `pin` the lock set (required by the controller form and Rev L). 2.0 answered 204 on RW 7.21.4, 8.1.1 and 8.2.1 VCs (2026-10-10). 1.0 was sent on RW 6.16.03 (2026-10-13) and refused 403 -1073445867 "The required option is missing" (icode -7701), as the lock was. No logged 2xx on 1.0.',
  },

  // ── Speed ratio ───────────────────────────────────────────────────────────
  getSpeedRatio: {
    tier: 'core', evidence: 'live', effect: 'read',
    summary: 'Read the speed override (0-100).',
    rws2: { method: 'GET', path: '/rw/panel/speedratio' },
    rws1: { method: 'GET', path: '/rw/panel/speedratio' },
  },
  setSpeedRatio: {
    tier: 'core', evidence: 'live', effect: 'write',
    summary: 'Set the speed override. AUTO mode only.',
    // The 2.0 write is the documented plain POST /rw/panel/speedratio with
    // `speed-ratio=N` (204; the controller's own OPTIONS form advertises it),
    // and the `?action=` query is not checked: `?action=setspeedratio` and
    // `?action=nosuchaction` both answer 204 and set the value. Verified
    // 2026-09-27 on RW 7.21 and 8.1.1. The earlier note here ("plain POST ->
    // 400") was wrong: the 400 "Invalid input form data" came from the field
    // name `speedratio`, which fails with or without the action; `/set` is
    // still 404. The action stays in this row because the request works and
    // matches the 1.0 row; it is not needed on 2.0. Raw-logged again
    // 2026-09-29 on RW 7.21.4+417 and 8.2.1+1023 (same answers; without the
    // hold 403 -1073445859 on 7.21.4 and 403 -1073435873 on 8.2.1).
    rws2: { method: 'POST', path: '/rw/panel/speedratio', action: 'setspeedratio', fields: ['speed-ratio'] },
    rws1: { method: 'POST', path: '/rw/panel/speedratio', action: 'setspeedratio', fields: ['speed-ratio'] },
    note: '2.0 accepts the plain POST with speed-ratio (204) and ignores ?action; the action kept here is harmless, not required (verified 2026-09-27, RW 7.21 and 8.1.1; 2026-09-29, RW 7.21.4 and 8.2.1). Field speedratio -> 400 either way; /set -> 404.',
  },

  // ── Collision detection ───────────────────────────────────────────────────
  getCollisionDetectionState: {
    tier: 'common', evidence: 'live', effect: 'read',
    summary: 'Read the collision-detection state (INIT / TRIGGERED / …).',
    rws2: { method: 'GET', path: '/rw/panel/coldetstate' },
    rws1: { method: 'GET', path: '/rw/panel/coldetstate' },
  },

  // ── Enable request ────────────────────────────────────────────────────────
  getEnableRequest: {
    tier: 'niche', evidence: 'live', effect: 'read',
    summary: 'Read the enable-request state.',
    rws2: { method: 'GET', path: '/rw/panel/enreq' },
    note: 'RWS 2.0 only.',
  },

  // ── Language ──────────────────────────────────────────────────────────────
  setPanelLanguage: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Set the panel language.',
    // Field is lang-code here; the /ctrl language sibling uses `lang`.
    rws2: { method: 'POST', path: '/rw/panel/lang', fields: ['lang-code'] },
    // RWS 1.0 query-action form, same lang-code field. Live-verified RW6.16
    // (2026-08-11): 204.
    rws1: { method: 'POST', path: '/rw/panel', action: 'setlang', fields: ['lang-code'] },
    note: 'No getter (GET -> 405). Field lang-code, unlike /ctrl/lang which uses lang. RWS 2.0 path /rw/panel/lang; RWS 1.0 query-action /rw/panel?action=setlang.',
  },

  // ── Keyless / e-stop simulations ──────────────────────────────────────────
  setKeylessMotorOn: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Motors on without the key switch (Keyless Mode Switch option).',
    // Lives UNDER ctrl-state. The commonly-recorded /rw/panel/keyless-motoron
    // 404s on every generation - a 404 disproves a path, never a capability.
    rws2: { method: 'POST', path: '/rw/panel/ctrl-state/keyless-motoron' },
    // RWS 1.0 Rev M "Keyless motor ON": not under /rw/panel at all, but a
    // query action on the configuration root with state=run, 204.
    rws1: { method: 'POST', path: '/rw/cfg', action: 'keyless', fields: ['state'] },
    note: 'RWS 2.0 under ctrl-state, no body; RWS 1.0 /rw/cfg?action=keyless with state=run. Energises the drives: run live on RW 7.21.4 (2026-10-11, motors on read back, then off). RW 6.16.03 virtual controller: 204 under RAPID mastership with the motors off, motors read on 1.1 s later (2026-10-18).',
  },
  setExternalEmergencyStop: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Simulate the external emergency-stop circuit.',
    rws2: { method: 'POST', path: '/rw/panel/external-emergency-stop', fields: ['state'] },
    note: 'RWS 2.0 only. Run live on RW 7.21.4 (2026-10-11): the controller takes `state=on` (circuit closed, ctrlstate motoroff) and `state=off` (circuit open, ctrlstate emergencystop); the client sends on and off since 2026-10-12 (active and reset, which answer 400 Invalid state value, are mapped to off and on).',
  },
  simEmergencyStop: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Simulate the emergency stop (VC only). INVERTED polarity: state=off engages.',
    rws2: { method: 'POST', path: '/rw/panel/emergency-stop', fields: ['state'] },
    note: 'VC only; state=off ENGAGES the stop.',
  },
  simGeneralStop: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Simulate the general stop (VC only). INVERTED polarity.',
    rws2: { method: 'POST', path: '/rw/panel/general-stop', fields: ['state'] },
    note: 'VC only; state=off ENGAGES.',
  },
  simAutoStop: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Simulate the auto stop (VC only). INVERTED polarity.',
    rws2: { method: 'POST', path: '/rw/panel/auto-stop', fields: ['state'] },
    note: 'VC only; state=off ENGAGES.',
  },
  simEnableSwitch: {
    tier: 'niche', evidence: 'live', effect: 'write',
    summary: 'Simulate the enable switch (VC only). DIRECT polarity: state=on pressed.',
    rws2: { method: 'POST', path: '/rw/panel/enable-switch', fields: ['state'] },
    note: 'VC only; DIRECT polarity, unlike the three stop endpoints.',
  },

  // ── Restart (straddles domains) ───────────────────────────────────────────
  restartController: {
    tier: 'common', evidence: 'live', effect: 'write',
    summary: 'Restart the controller.',
    // The only panel operation whose 2.0 path LEAVES /rw/panel. 2.0 needs edit
    // mastership (bare POST -> 403); 1.0 does not. Mode sets differ (6 vs 4).
    rws2: { method: 'POST', path: '/ctrl/restart', fields: ['restart-mode'] },
    rws1: { method: 'POST', path: '/rw/panel', action: 'restart', fields: ['restart-mode'] },
    note: '2.0 path moves to /ctrl/restart (6 modes incl shutdown/xstart); 1.0 stays /rw/panel (4 modes).',
  },
};
