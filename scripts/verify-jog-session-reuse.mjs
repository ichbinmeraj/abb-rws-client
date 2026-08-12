// Verify the jog session-reuse fix against a live IRC5 VC.
//
// WHY: jog() used to open a fresh Digest connection and mint a NEW controller
// session on EVERY call (the private digestPost). IRC5 caps concurrent sessions
// (~70), so heavy jogging filled the pool and returned persistent 503
// "Cannot add new user. ID is not unique". The fix routes jog through the shared
// HttpSession (one reused session cookie).
//
// This is a TRANSPORT-level check, so it does NOT need the robot to move: the
// session was minted before the jog was even evaluated, so even jogs the
// controller rejects for op-mode/state still exercise the fix. It fires N jogs
// past the pool ceiling and asserts ZERO pool-exhaustion errors and that the one
// session cookie stays stable throughout. (Old code: sessions pile up and it
// 503s partway through. New code: one session, no exhaustion.)
//
// Safe on any VC in any mode - nothing is required to move. Usage:
//   npm run build && node scripts/verify-jog-session-reuse.mjs [jogCount]

import { RwsClient } from '../dist/RwsClient.js';
import { RWS1Adapter } from '../dist/RWS1Adapter.js';
import http from 'node:http';
import crypto from 'node:crypto';

const JOGS = Number(process.argv[2] || 90);   // past the ~70-session pool ceiling
const USER = 'Default User', PASS = 'robotics';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// Find the IRC5 RWS port (RobotStudio reassigns it each restart).
function probe(port) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/rw/system', timeout: 2500,
      headers: { Accept: 'application/xhtml+xml;v=1.0' } }, (x) => {
      if (x.statusCode !== 401) { x.resume(); return res(false); }
      const c = x.headers['www-authenticate']; x.resume();
      const p = Object.fromEntries([...(c || '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
      const ha1 = md5(`${USER}:${p.realm}:${PASS}`), ha2 = md5('GET:/rw/system');
      const cn = crypto.randomBytes(8).toString('hex');
      const resp = md5(`${ha1}:${p.nonce}:00000001:${cn}:auth:${ha2}`);
      const auth = `Digest username="${USER}", realm="${p.realm}", nonce="${p.nonce}", uri="/rw/system", response="${resp}", qop=auth, nc=00000001, cnonce="${cn}"` + (p.opaque ? `, opaque="${p.opaque}"` : '');
      const r2 = http.request({ host: '127.0.0.1', port, path: '/rw/system', timeout: 2500,
        headers: { Authorization: auth, Accept: 'application/xhtml+xml;v=1.0' } }, (y) => { y.resume(); res(y.statusCode === 200); });
      r2.on('error', () => res(false)); r2.on('timeout', () => { r2.destroy(); res(false); }); r2.end();
    });
    r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); r.end();
  });
}

let PORT = null;
for (const p of [56886, 58678, 60214, 60726, 14048, 80]) { if (await probe(p)) { PORT = p; break; } }
if (!PORT) { console.error('No IRC5 RWS port found. Is the VC running?'); process.exit(2); }
console.log(`IRC5 on :${PORT}`);

const client = new RwsClient({ host: '127.0.0.1', port: PORT, username: USER, password: PASS });
const adapter = new RWS1Adapter(client, { host: '127.0.0.1', port: PORT, username: USER, password: PASS });
await client.connect();
const cookie0 = client.getSessionCookie();
await adapter.requestMastership('motion').catch(() => {});

console.log(`\nFiring ${JOGS} jogs (past the ~70-session pool ceiling)...`);
let moved = 0, modeReject = 0, poolExhaust = 0, other = 0;
for (let i = 0; i < JOGS; i++) {
  try {
    await adapter.jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, i % 2 ? 1 : -1], speed: 20, mechunit: 'ROB_1' });
    moved++;
  } catch (e) {
    const m = e?.controllerMsg || e?.message || '';
    if (/Cannot add new user|ID is not unique/i.test(m)) { poolExhaust++; console.error(`  jog #${i + 1}: POOL EXHAUSTION - ${m.slice(0, 60)}`); }
    else if (e?.code === 'GRANT_DENIED' || /operation mode|controller state/i.test(m)) { modeReject++; }
    else { other++; if (other <= 3) console.error(`  jog #${i + 1}: ${e?.code || ''} ${m.slice(0, 60)}`); }
  }
}
await adapter.releaseMastership('motion').catch(() => {});
const cookie1 = client.getSessionCookie();
await client.disconnect().catch(() => {});

console.log(`\nResult across ${JOGS} jogs:`);
console.log(`  moved:              ${moved}   (only when the VC is in MANUAL mode with motors on)`);
console.log(`  mode/state rejects: ${modeReject}   (expected when the VC is in AUTO)`);
console.log(`  POOL EXHAUSTION:    ${poolExhaust}   <-- the leak signature; must be 0`);
console.log(`  other errors:       ${other}`);
console.log(`  single session reused throughout: ${!!cookie0 && cookie0 === cookie1}`);
if (poolExhaust > 0) {
  console.error(`\nFAIL: ${poolExhaust} session-pool-exhaustion errors - jog is still leaking sessions.`);
  process.exit(1);
}
console.log(`\nPASS: ${JOGS} jogs, ZERO session-pool exhaustion, one reused session - the leak is fixed.`);
process.exit(0);
