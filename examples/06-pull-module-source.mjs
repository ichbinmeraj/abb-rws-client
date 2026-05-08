// Download a loaded module's RAPID source from the controller.
//
// This is the typical "git workflow" entry point: pull what's currently
// running, diff against your repo, push back when ready.
//
// Run: RWS_HOST=192.168.125.1 node examples/06-pull-module-source.mjs MotionTest

import { createClient } from 'abb-rws-client';
import { RobotManager, RWS2Adapter } from 'abb-rws-client';
import * as fs from 'node:fs/promises';

const moduleName = process.argv[2] ?? 'user';

const client = await createClient({
  host: process.env.RWS_HOST || '127.0.0.1',
  port: Number(process.env.RWS_PORT) || undefined,
});

// Wrap with RobotManager only if you need lifecycle features. For a one-shot
// pull, the raw client is enough.
const isRws2 = client.constructor.name === 'RwsClient2';
let source;
if (isRws2) {
  // RwsClient2 doesn't expose getModuleSource directly — go through the adapter.
  const robot = new RobotManager({ adapter: new RWS2Adapter(client) });
  await robot.start();
  source = await robot.getModuleSource('T_ROB1', moduleName);
  await robot.stop();
} else {
  // RWS 1.0 has it on the client.
  source = await client.getModuleSource?.('T_ROB1', moduleName) ?? '';
}

await fs.writeFile(`${moduleName}.mod`, source, 'utf8');
console.log(`✓ Wrote ${moduleName}.mod (${source.length} bytes)`);
console.log('Now: git diff, edit, git commit, push back via loadModule.');

await client.disconnect();
