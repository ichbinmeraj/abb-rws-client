// Explicit RWS 2.0 client — for OmniCore controllers (RobotWare 7.x).
// Use this when you only target RWS 2.0 and don't need protocol detection.

import { RwsClient2 } from 'abb-rws-client';

// RWS 2.0 wants a base URL (scheme + host + port) instead of separate fields.
// Real OmniCore: https://<host>:443     |   VC: https://127.0.0.1:5466
const client = new RwsClient2(
  process.env.RWS_URL || 'https://127.0.0.1:5466',
  'Admin',
  'robotics',
);

await client.connect();

console.log('state:', await client.getControllerState());
console.log('opmode:', await client.getOperationMode());
console.log('joints:', await client.getJointPositions());
console.log('tasks:', (await client.getRapidTasks()).map(t => t.name));

// RWS 2.0 symbol API: suffix-style (different from RWS 1.0).
// Read a known-good symbol from BASE module:
const tool0 = await client.getRapidVariable('T_ROB1', 'BASE', 'tool0');
console.log('tool0:', tool0.slice(0, 60), '…');

await client.disconnect();
