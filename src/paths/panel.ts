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
    summary: 'Read the controller motor state (motoron / motoroff / init / …).',
    // The ONLY hyphen rename in the panel domain: 2.0 `ctrl-state`, 1.0
    // `ctrlstate`. Note the subscription state-param and response span stay
    // unhyphenated (`ctrlstate`) on BOTH - see subscribeControllerState.
    rws2: { method: 'GET', path: '/rw/panel/ctrl-state' },
    rws1: { method: 'GET', path: '/rw/panel/ctrlstate' },
    note: 'ctrl-state vs ctrlstate hyphen rename; subscription param stays ctrlstate on both.',
  },
  setControllerState: {
    summary: 'Set the motor state. Requires mastership (acquired one layer up).',
    rws2: { method: 'POST', path: '/rw/panel/ctrl-state', fields: ['ctrl-state'] },
    rws1: { method: 'POST', path: '/rw/panel/ctrlstate', action: 'setctrlstate', fields: ['ctrl-state'] },
    note: '2.0 plain POST vs 1.0 ?action=setctrlstate; same body field.',
  },

  // ── Operation mode ────────────────────────────────────────────────────────
  getOperationMode: {
    summary: 'Read the operation mode (AUTO / MANR / MANF).',
    rws2: { method: 'GET', path: '/rw/panel/opmode' },
    rws1: { method: 'GET', path: '/rw/panel/opmode' },
  },
  setOperationMode: {
    summary: 'Switch the operation mode. Virtual controllers only.',
    // Wire value differs: 2.0 `manf`, 1.0 `manfs`; both lowercase on write,
    // uppercase on read. VC-only (real hardware uses the key switch).
    rws2: { method: 'POST', path: '/rw/panel/opmode', fields: ['opmode'] },
    rws1: { method: 'POST', path: '/rw/panel/opmode', fields: ['opmode'] },
    note: 'wire value manf (2.0) vs manfs (1.0); VC-only.',
  },
  acknowledgeOperationMode: {
    summary: 'Confirm a pending operation-mode switch.',
    rws2: { method: 'POST', path: '/rw/panel/opmode/acknowledge', fields: ['opmode'] },
    note: 'RWS 2.0 only (OPTIONS-verified RW7.21).',
  },
  getOperationModeLockState: {
    summary: 'Read whether the operation-mode key switch is locked.',
    rws2: { method: 'GET', path: '/rw/panel/opmode/lock-state' },
    note: 'RWS 2.0 only; 404 on RW6.16.',
  },
  lockOperationMode: {
    summary: 'Lock the FlexPendant key switch with a PIN.',
    rws2: { method: 'POST', path: '/rw/panel/opmode/lock', fields: ['pin', 'permanent'] },
    rws1: { method: 'POST', path: '/rw/panel/opmode', action: 'lock', fields: ['pin', 'permanent'] },
    note: '2.0 sub-path /lock vs 1.0 ?action=lock.',
  },
  unlockOperationMode: {
    summary: 'Unlock the FlexPendant key switch.',
    rws2: { method: 'POST', path: '/rw/panel/opmode/unlock' },
    rws1: { method: 'POST', path: '/rw/panel/opmode', action: 'unlock' },
  },

  // ── Speed ratio ───────────────────────────────────────────────────────────
  getSpeedRatio: {
    summary: 'Read the speed override (0-100).',
    rws2: { method: 'GET', path: '/rw/panel/speedratio' },
    rws1: { method: 'GET', path: '/rw/panel/speedratio' },
  },
  setSpeedRatio: {
    summary: 'Set the speed override. AUTO mode only.',
    // The outlier 2.0 write: it KEPT the 1.0-style ?action= query form. The
    // modern shapes were live-disproved - plain POST -> 400, /set -> 404.
    rws2: { method: 'POST', path: '/rw/panel/speedratio', action: 'setspeedratio', fields: ['speed-ratio'] },
    rws1: { method: 'POST', path: '/rw/panel/speedratio', action: 'setspeedratio', fields: ['speed-ratio'] },
    note: 'the one 2.0 panel write still using ?action= (plain POST -> 400, /set -> 404).',
  },

  // ── Collision detection ───────────────────────────────────────────────────
  getCollisionDetectionState: {
    summary: 'Read the collision-detection state (INIT / TRIGGERED / …).',
    rws2: { method: 'GET', path: '/rw/panel/coldetstate' },
    rws1: { method: 'GET', path: '/rw/panel/coldetstate' },
  },

  // ── Enable request ────────────────────────────────────────────────────────
  getEnableRequest: {
    summary: 'Read the enable-request state.',
    rws2: { method: 'GET', path: '/rw/panel/enreq' },
    note: 'RWS 2.0 only.',
  },

  // ── Language ──────────────────────────────────────────────────────────────
  setPanelLanguage: {
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
    summary: 'Motors on without the key switch (Keyless Mode Switch option).',
    // Lives UNDER ctrl-state. The commonly-recorded /rw/panel/keyless-motoron
    // 404s on every generation - a 404 disproves a path, never a capability.
    rws2: { method: 'POST', path: '/rw/panel/ctrl-state/keyless-motoron' },
    note: 'RWS 2.0 only; under ctrl-state. Built-not-run (energises drives).',
  },
  setExternalEmergencyStop: {
    summary: 'Simulate the external emergency-stop circuit.',
    rws2: { method: 'POST', path: '/rw/panel/external-emergency-stop', fields: ['state'] },
    note: 'RWS 2.0 only. Built-not-run.',
  },
  simEmergencyStop: {
    summary: 'Simulate the emergency stop (VC only). INVERTED polarity: state=off engages.',
    rws2: { method: 'POST', path: '/rw/panel/emergency-stop', fields: ['state'] },
    note: 'VC only; state=off ENGAGES the stop.',
  },
  simGeneralStop: {
    summary: 'Simulate the general stop (VC only). INVERTED polarity.',
    rws2: { method: 'POST', path: '/rw/panel/general-stop', fields: ['state'] },
    note: 'VC only; state=off ENGAGES.',
  },
  simAutoStop: {
    summary: 'Simulate the auto stop (VC only). INVERTED polarity.',
    rws2: { method: 'POST', path: '/rw/panel/auto-stop', fields: ['state'] },
    note: 'VC only; state=off ENGAGES.',
  },
  simEnableSwitch: {
    summary: 'Simulate the enable switch (VC only). DIRECT polarity: state=on pressed.',
    rws2: { method: 'POST', path: '/rw/panel/enable-switch', fields: ['state'] },
    note: 'VC only; DIRECT polarity, unlike the three stop endpoints.',
  },

  // ── Restart (straddles domains) ───────────────────────────────────────────
  restartController: {
    summary: 'Restart the controller.',
    // The only panel operation whose 2.0 path LEAVES /rw/panel. 2.0 needs edit
    // mastership (bare POST -> 403); 1.0 does not. Mode sets differ (6 vs 4).
    rws2: { method: 'POST', path: '/ctrl/restart', fields: ['restart-mode'] },
    rws1: { method: 'POST', path: '/rw/panel', action: 'restart', fields: ['restart-mode'] },
    note: '2.0 path moves to /ctrl/restart (6 modes incl shutdown/xstart); 1.0 stays /rw/panel (4 modes).',
  },
};
