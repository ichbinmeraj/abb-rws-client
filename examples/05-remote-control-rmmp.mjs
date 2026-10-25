// Request manual-mode privileges (RMMP) from the operator at the FlexPendant.
//
// RMMP (Request Manual Mode Privileges) is ABB's manual-mode counterpart of a
// mastership request: in manual mode a remote client gets mastership - and so
// can jog - only after an operator at the FlexPendant grants RMMP. In AUTO it
// is not used. RobotWare 7 accepts a request only in MANR; RobotWare 8 has no
// RMMP (it uses control-station write access instead).
//
// requestRmmp() sends the request, polls it so it outlives ABB's 10 s window,
// and resolves once the operator grants or denies it, or the wait runs out
// (the request is then cancelled).
//
// Run: RWS_HOST=127.0.0.1 RWS_PORT=5466 node examples/05-remote-control-rmmp.mjs

import { RobotManager } from 'abb-rws-client';

const host = process.env.RWS_HOST || '127.0.0.1';
const port = process.env.RWS_PORT ? Number(process.env.RWS_PORT) : undefined;

// RobotManager auto-detects the protocol (RWS 1.0 vs 2.0) and, when port is
// omitted, probes the common VC/controller ports.
const robot = new RobotManager();
await robot.connect(host, process.env.RWS_USER || 'Admin', process.env.RWS_PASS || 'robotics', port);

try {
  console.log(`Current RMMP: ${await robot.getRmmpPrivilege()}`);
  const result = await robot.requestRmmp('modify', {
    waitMs: 30_000,
    onPending: () => console.log('Waiting for the operator at the FlexPendant to press Grant...'),
  });
  console.log(`${result.outcome}: ${result.detail}`);
  if (result.outcome === 'granted') {
    // Manual-mode work goes here, for example one jog with motors on:
    // await robot.jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, 1], speed: 10, incMode: 'Small' });
    await robot.cancelRmmp();   // give the privilege back when done
  }
} finally {
  await robot.disconnect();     // also cancels a privilege still held
}
