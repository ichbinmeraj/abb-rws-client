// Verify the jog session-reuse fix against a live IRC5 VC.
//
// WHY: jog() used to open a fresh Digest connection and mint a NEW controller
// session on every call. IRC5 caps concurrent sessions (~70), so heavy jogging
// eventually filled the pool and returned persistent 503. The fix routes jog
// through the shared HttpSession (one reused session). This script jogs the
// wrist a tiny amount MANY times (past the old pool limit) and reports whether
// any 503 occurred - with the fix, none should.
//
// THIS MOVES THE ROBOT (small ±axis-6 wrist jogs). Run only against a VC you
// control, in MANUAL mode, with motors on. You may need to approve a
// "remote modify" popup on the FlexPendant once.
//
// Usage:  node scripts/verify-jog-session-reuse.mjs [jogCount]
//   (build first: npm run build)

import { RwsClient } from '../dist/RwsClient.js';
import { RWS1Adapter } from '../dist/RWS1Adapter.js';
import http from 'node:http';
import crypto from 'node:crypto';

const JOGS = Number(process.argv[2] || 80);   // past the ~70 session-pool limit
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

const mode = await adapter.getOperationMode();
console.log(`operation mode: ${mode}`);
if (!/MAN/i.test(mode)) { console.error('Controller must be in MANUAL mode to jog. Aborting.'); process.exit(3); }

// RMMP (remote modify) - approve the FlexPendant popup if prompted.
try {
  const priv = await adapter.getRmmpPrivilege().catch(() => 'none');
  if (priv === 'none') {
    await adapter.requestRmmp('modify');
    console.error('Requested remote-modify (RMMP). Approve the popup on the FlexPendant, then re-run.');
    process.exit(4);
  }
  if (String(priv).startsWith('pending')) { console.error('RMMP still pending - approve the FlexPendant popup, then re-run.'); process.exit(4); }
} catch { /* some VCs don't require RMMP */ }

await adapter.requestMastership('motion');
console.log(`\nJogging axis 6 by a tiny ±angle ${JOGS}x (past the ~70 session-pool limit)...`);

let ok = 0, busy = 0, otherErr = 0, ccountSeen = [];
for (let i = 0; i < JOGS; i++) {
  const dir = i % 2 === 0 ? 1 : -1;      // alternate so the wrist stays near home
  try {
    await adapter.jog({ mode: 'Joint', axes: [0, 0, 0, 0, 0, dir], speed: 20, mechunit: 'ROB_1' });
    ok++;
  } catch (e) {
    if (e?.code === 'CONTROLLER_BUSY' || e?.httpStatus === 503) { busy++; console.error(`  jog #${i + 1}: 503 CONTROLLER_BUSY`); }
    else { otherErr++; console.error(`  jog #${i + 1}: ${e?.code || ''} ${e?.message || e}`); }
  }
}

await adapter.releaseMastership('motion').catch(() => {});
await client.disconnect().catch(() => {});

console.log(`\nResult: ${ok}/${JOGS} jogs OK, ${busy} × 503 CONTROLLER_BUSY, ${otherErr} other errors`);
if (busy > 0) {
  console.error('\nFAIL: 503s appeared - the session pool is still filling. The leak is NOT fixed on this rig.');
  process.exit(1);
}
console.log('\nPASS: no session-pool 503s across ' + JOGS + ' jogs - the session is being reused. Fix verified.');
process.exit(0);
