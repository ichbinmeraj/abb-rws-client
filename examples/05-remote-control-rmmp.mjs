// Acquire Remote Mastership Privilege (RMMP) before doing modify ops.
//
// Without RMMP, AUTO-mode modify operations (start RAPID, set PP, write
// variables, etc.) return HTTP 403 even when mastership is acquired. RMMP
// is a separate user-level grant: requesting it triggers a popup on the
// FlexPendant; the operator taps Allow once and you have write access.
//
// This is what RobotStudio Online does — that's why it "just works".

import { RobotManager, RWS2Adapter, RwsClient2 } from 'abb-rws-client';

const client = new RwsClient2({
  host: process.env.RWS_HOST || '127.0.0.1',
  port: Number(process.env.RWS_PORT) || 5466,
  username: process.env.RWS_USER || 'Admin',
  password: process.env.RWS_PASS || 'robotics',
});
await client.connect();

const robot = new RobotManager({ adapter: new RWS2Adapter(client) });
await robot.start();

// 1) Check current RMMP state
let priv = await robot.getRmmpPrivilege();
console.log(`Current RMMP: ${priv}`);

// 2) If no privilege, request it. The FlexPendant pops up; operator approves.
if (priv === 'none') {
  console.log('Requesting RMMP — operator must approve on the FlexPendant…');
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

await robot.stop();
await client.disconnect();
