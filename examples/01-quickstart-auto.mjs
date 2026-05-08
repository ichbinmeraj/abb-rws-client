// Auto-detect protocol — works for both IRC5 (RWS 1.0) and OmniCore (RWS 2.0).
// Useful when your code has to support both controller generations.

import { createClient, RwsClient2 } from 'abb-rws-client';

const client = await createClient({
  host: process.env.RWS_HOST || '127.0.0.1',
  // username/password default to 'Admin' / 'robotics' (built-in admin account, full UAS grants)
});

console.log(`Connected via ${client instanceof RwsClient2 ? 'RWS 2.0' : 'RWS 1.0'}`);

const state = await client.getControllerState();   // 'motoron' | 'motoroff' | 'init' | …
const mode  = await client.getOperationMode();     // 'AUTO' | 'MANR' | 'MANF'
const speed = await client.getSpeedRatio();
const exec  = await client.getRapidExecutionState();

console.log({ state, mode, speed, execstate: exec });

await client.disconnect();
