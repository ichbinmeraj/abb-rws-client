// Multi-robot orchestration — manages multiple controllers in one process.
// The MultiRobotManager keeps one robot "active" at a time (handy for UIs)
// while still polling state for all of them.

import { MultiRobotManager } from 'abb-rws-client';

const multi = MultiRobotManager.fromConfigs([
  { id: 'irb120-cell-A', name: 'Cell A IRB120',  host: '127.0.0.1', port: 5466,  useHttps: true,  username: 'Admin', password: 'robotics' },
  { id: 'irb1200-cell-B', name: 'Cell B IRB1200', host: '127.0.0.1', port: 80,    useHttps: false, username: 'Admin', password: 'robotics' },
]);

// Single sink for connection failures across all robots.
multi.onError(async (msg, actions) => {
  console.error(`[MultiRobot] ${msg} — actions: ${actions.join(', ')}`);
  return undefined; // headless: just log, don't auto-reconnect
});

multi.onDidChange(() => {
  const a = multi.active;
  if (a) {
    console.log(`[${multi.activeId}] state=${a.state.ctrlstate} mode=${a.state.opmode}`);
  }
});

// Connect each robot independently — failures don't stop the others.
for (const { id } of multi.entries) {
  await multi.connectRobot(id).catch(e => console.warn(`Could not connect ${id}: ${e.message}`));
}

// Run for 30s, observing state changes, then clean shutdown.
await new Promise(r => setTimeout(r, 30_000));

for (const { id } of multi.entries) {
  await multi.disconnectRobot(id).catch(() => {});
}
