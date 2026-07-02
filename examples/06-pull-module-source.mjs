// Download a loaded module's RAPID source from the controller.
//
// This is the typical "git workflow" entry point: pull what's currently
// running, diff against your repo, push back when ready.
//
// Run: RWS_HOST=192.168.125.1 node examples/06-pull-module-source.mjs MotionTest

import { RobotManager } from 'abb-rws-client';
import * as fs from 'node:fs/promises';

const moduleName = process.argv[2] ?? 'user';
const host = process.env.RWS_HOST || '127.0.0.1';
const port = process.env.RWS_PORT ? Number(process.env.RWS_PORT) : undefined;

// RobotManager auto-detects RWS 1.0 vs 2.0 and exposes getModuleSource()
// uniformly over both protocols (it reads via the controller's fileservice).
const robot = new RobotManager();
await robot.connect(host, process.env.RWS_USER || 'Admin', process.env.RWS_PASS || 'robotics', port);

const source = await robot.getModuleSource('T_ROB1', moduleName);
if (!source) {
  console.error(`✗ Module '${moduleName}' not found (or empty) in task T_ROB1.`);
  await robot.disconnect();
  process.exit(1);
}

await fs.writeFile(`${moduleName}.mod`, source, 'utf8');
console.log(`✓ Wrote ${moduleName}.mod (${source.length} bytes)`);
console.log('Now: git diff, edit, git commit, push back via loadModule.');

await robot.disconnect();
