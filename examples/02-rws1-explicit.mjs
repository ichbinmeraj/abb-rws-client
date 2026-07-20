// Explicit RWS 1.0 client - for IRC5 controllers (RobotWare 6.x).
// Use this when you only target RWS 1.0 and don't need protocol detection.

import { RwsClient } from 'abb-rws-client';

const client = new RwsClient({
  host: process.env.RWS_HOST || '192.168.125.1',
  port: 80,
  username: 'Admin',
  password: 'robotics',
});

await client.connect();

// Controller / panel
console.log('state:', await client.getControllerState());
console.log('opmode:', await client.getOperationMode());

// Motion
console.log('joints:', await client.getJointPositions());
console.log('cartesian:', await client.getCartesianPosition());

// RAPID
console.log('tasks:', (await client.getRapidTasks()).map(t => t.name));
console.log('modules:', await client.listModules('T_ROB1'));

// I/O
console.log('signals (first 5):', (await client.listAllSignals(0, 5)).map(s => `${s.name}=${s.value}`));

await client.disconnect();
