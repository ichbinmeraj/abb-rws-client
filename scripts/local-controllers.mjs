/**
 * Finding the RobotStudio virtual controllers on this PC, for the scripts in
 * this folder (conformance, soak, functional fixtures).
 *
 * Everything goes through the client's own `findControllers` from the built
 * package in dist/: this PC's loopback only (`loopbackOnly`; the client refuses
 * any other target before sending anything), no service address, no mDNS, on
 * Windows only the ports of the virtual-controller processes, and one probe at
 * a time at least 1 s apart (to keep the load on the virtual controllers low).
 * Ports move on every VC start, so none is hard-coded: RWS_TEST_PORT_RW6 /
 * RWS_TEST_PORT_RW7 / RWS_TEST_PORT_RW8 name ports that are probed as well and
 * come first.
 *
 * Test infrastructure only - never shipped in the package.
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Hard refusal: these scripts reach local virtual controllers only. */
export function assertLocalhost(host, who = 'this script') {
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`${who} refuses non-localhost host ${JSON.stringify(host)} - it only ever reaches local virtual controllers`);
  }
}

/** The options of every discovery run here. */
export const LOCAL_DISCOVERY = Object.freeze({
  loopbackOnly: true,
  serviceAddress: false,
  mdns: false,
  filterToVcProcesses: true,
  pacing: { local: { concurrency: 1, minGapMs: 1000 } },
});

/** The RobotStudio process that serves RWS for each generation. */
export const VC_IMAGE = Object.freeze({ rws1: 'robvc.exe', rws2: 'vrchost64.exe' });

/** The env-named ports: port -> lane ('rw6' | 'rw7' | 'rw8'). Invalid values are reported through `say` and ignored. */
export function envPorts(say = () => {}) {
  const out = new Map();
  for (const lane of ['rw6', 'rw7', 'rw8']) {
    const name = `RWS_TEST_PORT_${lane.toUpperCase()}`;
    const raw = process.env[name];
    if (!raw) { continue; }
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) { say(`${name}=${raw} is not a port - ignored`); continue; }
    if (!out.has(port)) { out.set(port, lane); }
  }
  return out;
}

/**
 * One paced discovery of this PC through `client.findControllers`, with
 * `ports` probed as well. Returns `{ rows, result }`: `rows` are the RWS
 * controllers found on 127.0.0.1 (realm verified, generation and scheme
 * known); every host in `result` has passed `assertLocalhost`.
 */
export async function findLocalControllers(client, { identify = 'none', ports = [] } = {}) {
  const manual = [...new Set(ports)].map(port => ({ host: '127.0.0.1', port }));
  const result = await client.findControllers({
    ...LOCAL_DISCOVERY,
    identify,
    ...(manual.length > 0 ? { manual } : {}),
  });
  for (const c of result.controllers) {
    assertLocalhost(c.host);
    for (const a of c.addresses ?? []) { assertLocalhost(a.host); }
  }
  const rows = result.controllers.filter(c => c.host === '127.0.0.1' && c.identified && c.probe !== null
    && c.https !== null && (c.generation === 'rws1' || c.generation === 'rws2'));
  return { rows, result };
}

/** The RobotWare major an entry is known to run (RWS 1.0 is 6), Infinity when unknown. */
export function rwMajor(row) {
  if (row.generation === 'rws1') { return 6; }
  const m = /^\s*(\d+)\./.exec(row.rwVersion ?? '');
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** Sort order for picking: env-named ports first, then RobotWare major, then port. */
export function byPreference(named) {
  const rank = row => (named.has(row.port) ? 0 : 1);
  return (a, b) => rank(a) - rank(b) || rwMajor(a) - rwMajor(b) || a.port - b.port;
}

/** Is `row` served by this generation's virtual-controller process (true when the OS named no owner)? */
export function isVcOf(row, generation) {
  const image = row.process?.image;
  return image === undefined || image.toLowerCase() === VC_IMAGE[generation];
}
