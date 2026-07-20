// Acquire Remote Mastership Privilege (RMMP) before doing modify ops.
//
// Without RMMP, AUTO-mode modify operations (start RAPID, set PP, write
// variables, etc.) return HTTP 403 even when mastership is acquired. RMMP
// is a separate user-level grant: requesting it triggers a popup on the
// FlexPendant; the operator taps Allow once and you have write access.
//
// This is what RobotStudio Online does - that's why it "just works".
//
// Run: RWS_HOST=127.0.0.1 RWS_PORT=5466 node examples/05-remote-control-rmmp.mjs

import { RobotManager } from 'abb-rws-client';

const host = process.env.RWS_HOST || '127.0.0.1';
const port = process.env.RWS_PORT ? Number(process.env.RWS_PORT) : undefined;

// RobotManager auto-detects the protocol (RWS 1.0 vs 2.0) and, when port is
// omitted, probes the common VC/controller ports.
const robot = new RobotManager();
await robot.connect(host, process.env.RWS_USER || 'Admin', process.env.RWS_PASS || 'robotics', port);

// 1) Check current RMMP state
let priv = await robot.getRmmpPrivilege();
console.log(`Current RMMP: ${priv}`);

// 2) If no privilege, request it. The FlexPendant pops up; operator approves.
if (priv === 'none') {
  console.log('Requesting RMMP - operator must approve on the FlexPendant…');
  await robot.requestRmmp('modify');

  // Poll until the operator approves (or 30s timeout)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    priv = await robot.getRmmpPrivilege();
    if (priv === 'modify' || priv === 'exclusive') { break; }
    process.stdout.write('.');
  }
  console.log();
}

if (priv === 'modify' || priv === 'exclusive') {
  console.log(`✓ ${priv} privilege granted. Modify ops will now work in AUTO.`);
  // Example: PP-to-Main + start
  // await robot.resetRapid();
  // await robot.startRapid();
} else {
  console.log(`✗ Operator did not grant RMMP. Cannot do modify ops.`);
}

await robot.disconnect();
