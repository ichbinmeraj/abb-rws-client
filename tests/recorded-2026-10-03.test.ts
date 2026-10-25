import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { RwsError } from '../src/types.js';
import { isJointValuePresent } from '../src/mechunit.js';
import { ALL_TABLES, type PathSpec } from '../src/paths/index.js';

// The reads probed on 2026-10-03 with scripts/probe-config-task-motion.mjs
// (GET and OPTIONS only) against RobotWare 6.16.03, 7.21.0, 7.21.4, 8.1.1 and
// 8.2.1 virtual controllers. Every body below is the controller's answer as
// captured.

/** A fake RwsClient for RWS1Adapter: answers each request from `respond`. */
function fakeRws1(respond: (url: string) => { status: number; body: string }): { client: RwsClient; urls: string[] } {
  const urls: string[] = [];
  const client = {
    request: async (_m: string, url: string) => { urls.push(url); return respond(url); },
  } as unknown as RwsClient;
  return { client, urls };
}

const rws1 = (client: RwsClient): RWS1Adapter =>
  new RWS1Adapter(client, { host: '127.0.0.1', port: 80, username: 'u', password: 'p' });

/** A local server for RwsClient2: `respond` gets the method and URL; every URL asked is recorded. */
async function withServer(
  respond: (method: string, url: string) => [number, string, string],
  run: (client: RwsClient2, urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? '');
    const [status, type, body] = respond(req.method ?? '', req.url ?? '');
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p'), urls);
  } finally { server.close(); }
}

const HAL = 'application/hal+json;v=2.0';
const XHTML = 'application/xhtml+xml;v=2.0';

// ─── RWS 1.0: I/O configuration reads (RW 6.16.03) ──────────────────────────

/** Recorded: GET /rw/iosystem/signals/Local/DRV_1/DRV1TESTE2?resource=config. */
const RW6_SIGNAL_CONFIG = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>io</title><base href=\"http://127.0.0.1:39127/rw/iosystem/\"/></head><body><div class=\"state\"><a href=\"signals/Local/DRV_1/DRV1TESTE2\" rel=\"self\"></a><a href=\"signals/Local/DRV_1/DRV1TESTE2?action=show\" rel=\"action\"></a> <ul><li class=\"ios-signal-config-general\" title=\"Local/DRV_1/DRV1TESTE2\"> <span class=\"cfgname\">EIO_SIGNAL</span> <span class=\"name\">DRV1TESTE2</span> <span class=\"signaltype\">DO</span> <span class=\"device\">DRV_1</span> <span class=\"label\">Activate ENABLE2 glitch test at Contactor Board</span> <span class=\"devicemap\">3</span> <span class=\"category\">safety</span> <span class=\"access\">ReadOnly</span> <span class=\"default\">0.000000</span> <span class=\"filtpas\">0</span> <span class=\"filtact\">0</span> <span class=\"invert\">0</span> <span class=\"enctype\">TWO_COMP</span> <span class=\"maxlog\">0.000000</span> <span class=\"maxphys\">0.000000</span> <span class=\"maxphyslimit\">0.000000</span> <span class=\"maxbitval\">0</span> <span class=\"minlog\">0.000000</span> <span class=\"minphys\">0.000000</span> <span class=\"minphyslimit\">0.000000</span> <span class=\"minbitval\">0</span> <span class=\"safelevel\">DefaultSafeLevel</span> <span class=\"size\">23</span> <span class=\"transfertodevice\"></span> <span class=\"transferfromdevice\"></span> <span class=\"transferinputoffset\">-1</span> <span class=\"transferoutputoffset\">-1</span></li><li class=\"ios-signal-config-runtime\" title=\"Local/DRV_1/DRV1TESTE2\"> <span class=\"signalname\">DRV1TESTE2</span> <span class=\"signalbits\">1</span> <span class=\"rapid\">0</span> <span class=\"localmanual\">0</span> <span class=\"localauto\">0</span> <span class=\"remotemanual\">0</span> <span class=\"remoteauto\">0</span> <span class=\"setbydevicetransfer\">0</span></li></ul></div></body></html>";
/** Recorded: GET /rw/iosystem/networks/Local?resource=config. */
const RW6_NETWORK_CONFIG = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>io</title><base href=\"http://127.0.0.1:39127/rw/iosystem/\"/></head><body><div class=\"state\"><a href=\"networks/Local\" rel=\"self\"></a><a href=\"networks/Local?action=show\" rel=\"action\"></a><ul><li class=\"ios-network-config-general\" title=\"Local\"> <span class=\"cfgname\">INDUSTRIAL_NETWORK</span> <span class=\"name\">Local</span> <span class=\"connection\"></span> <span class=\"label\">Local</span> <span class=\"address\"></span> <span class=\"cfgpath\"></span> <span class=\"baudrate\">500</span> <span class=\"subnetmask\"></span> <span class=\"gateway\"></span> <span class=\"stationname\">irc5-pnio</span> <span class=\"simulated\">0</span> <span class=\"nesteddiagnosis\">0</span></li><li class=\"ios-network-config-runtime\" title=\"Local\"> <span class=\"networkname\">Local</span> <span class=\"networktype\">Local</span><span class=\"networkaddress\">-</span></li></ul></div></body></html>";
/** Recorded: GET /rw/iosystem/devices/DRV_1?resource=config. */
const RW6_DEVICE_CONFIG = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>io</title><base href=\"http://127.0.0.1:39127/rw/iosystem/\"/></head><body><div class=\"state\"><a href=\"devices/Local/DRV_1\" rel=\"self\"></a><a href=\"devices/Local/DRV_1?action=show\" rel=\"action\"></a><ul><li class=\"ios-device-config-general\" title=\"Local/DRV_1\"> <span class=\"cfgname\">LOCAL_DEVICE</span> <span class=\"name\">DRV_1</span> <span class=\"network\">Local</span> <span class=\"statewhenstartup\">Deactivated</span> <span class=\"trustlevel\">SafetyTrustLevel</span> <span class=\"simulated\">0</span> <span class=\"vendorname\">ABB</span> <span class=\"productname\">Local network device</span> <span class=\"recoverytime\">5000</span> <span class=\"label\">D611 Cont. board</span> <span class=\"outputsize\">0</span> <span class=\"inputsize\">0</span></li><li class=\"ios-device-config-runtime\" title=\"Local/DRV_1\"> <span class=\"unitname\">DRV_1</span> <span class=\"networkname\">Local</span> <span class=\"inputbits\">32</span> <span class=\"outputbits\">32</span> <span class=\"rapid\">1</span> <span class=\"localmanual\">1</span> <span class=\"localauto\">1</span> <span class=\"remotemanual\">1</span><span class=\"remoteauto\">1</span> <span class=\"unitaddress\">-</span> <span class=\"denydeactivate\">0</span></li></ul></div></body></html>";
/**
 * Recorded: the same signal read with `&json=1`. Both classes are packed into
 * one object with duplicate `_type` and `_title` keys, which is why the
 * client reads the XHTML form.
 */
const RW6_SIGNAL_CONFIG_JSON = "{\"_links\":{\"base\": { \"href\": \"http://127.0.0.1:39127/rw/iosystem/\" },\"self\" : { \"href\" : \"signals/Local/DRV_1/DRV1TESTE2&json=1\" }},\"_embedded\" :{  \"_state\": [ { \"config-properties-general\":\"ios-signal-config-general:\",\"_type\":\"ios-signal-config\",\"_title\":\"Local/DRV_1/DRV1TESTE2\",\"cfgname\":\"EIO_SIGNAL\",\"name\":\"DRV1TESTE2\",\"signaltype\":\"DO\",\"device\":\"DRV_1\",\"label\":\"Activate ENABLE2 glitch test at Contactor Board\",\"devicemap\":\"3\",\"category\":\"safety\",\"access\":\"ReadOnly\",\"default\":\"0.000000\",\"filtpas\":\"0\",\"filtact\":\"0\",\"invert\":\"0\",\"enctype\":\"TWO_COMP\",\"maxlog\":\"0.000000\",\"maxphys\":\"0.000000\",\"maxphyslimit\":\"0.000000\",\"maxbitval\":\"0\",\"minlog\":\"0.000000\",\"minphys\":\"0.000000\",\"minphyslimit\":\"0.000000\",\"minbitval\":\"0\",\"safelevel\":\"DefaultSafeLevel\",\"size\":\"23\",\"transfertodevice\":\"\",\"transferfromdevice\":\"\",\"transferinputoffset\":\"-1\",\"transferoutputoffset\":\"-1\",\"config-properties-runtime\":\"ios-signal-config-runtime:\",\"_type\":\"ios-signal-config\",\"_title\":\"Local/DRV_1/DRV1TESTE2\",\"signalname\":\"DRV1TESTE2\",\"signalbits\":\"1\", \"rapid\":\"0\",\"localmanual\":\"0\",\"localauto\":\"0\",\"remotemanual\":\"0\",\"remoteauto\":\"0\",\"setbydevicetransfer\":\"0\" }  ] }}";

describe('RWS1Adapter I/O configuration reads (RW 6.16.03, ?resource=config)', () => {
  it('getSignalConfig reads the signal with ?resource=config as XHTML and returns the general entry', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: RW6_SIGNAL_CONFIG }));
    const cfg = await rws1(client).getSignalConfig('Local', 'DRV_1', 'DRV1TESTE2');
    expect(urls).toEqual(['/rw/iosystem/signals/Local/DRV_1/DRV1TESTE2?resource=config']);
    expect(cfg).toMatchObject({
      _title: 'Local/DRV_1/DRV1TESTE2', cfgname: 'EIO_SIGNAL', name: 'DRV1TESTE2', signaltype: 'DO',
      device: 'DRV_1', devicemap: '3', category: 'safety', access: 'ReadOnly', transfertodevice: '',
    });
    expect(cfg['_type']).toBeUndefined();
    // The runtime class is a separate entry and is not mixed in.
    expect(cfg['signalbits']).toBeUndefined();
    expect(cfg['localauto']).toBeUndefined();
  });

  it('the ?json=1 form of the same read merges both classes, so it is not the one read', () => {
    const parsed = JSON.parse(RW6_SIGNAL_CONFIG_JSON) as { _embedded: { _state: Array<Record<string, string>> } };
    const [only] = parsed._embedded._state;
    expect(parsed._embedded._state).toHaveLength(1);
    expect(only['_type']).toBe('ios-signal-config');
    expect(only['config-properties-general']).toBe('ios-signal-config-general:');
    expect(only['signalbits']).toBe('1');
  });

  it('getIoNetworkConfig reads the network with ?resource=config and returns the general entry', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: RW6_NETWORK_CONFIG }));
    const cfg = await rws1(client).getIoNetworkConfig('Local');
    expect(urls).toEqual(['/rw/iosystem/networks/Local?resource=config']);
    expect(cfg).toMatchObject({ _title: 'Local', cfgname: 'INDUSTRIAL_NETWORK', name: 'Local', baudrate: '500', simulated: '0' });
    expect(cfg['networktype']).toBeUndefined();
  });

  it('getIoDeviceConfig names the device without its network and returns the general entry', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: RW6_DEVICE_CONFIG }));
    const cfg = await rws1(client).getIoDeviceConfig('Local', 'DRV_1');
    expect(urls).toEqual(['/rw/iosystem/devices/DRV_1?resource=config']);
    expect(cfg).toMatchObject({
      _title: 'Local/DRV_1', cfgname: 'LOCAL_DEVICE', name: 'DRV_1', network: 'Local',
      vendorname: 'ABB', productname: 'Local network device', label: 'D611 Cont. board',
    });
    expect(cfg['inputbits']).toBeUndefined();
  });

  it('encodes the names into the path', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: RW6_SIGNAL_CONFIG }));
    await rws1(client).getSignalConfig('Net 1', 'Dev/1', 'di 1').catch(() => undefined);
    expect(urls[0]).toBe('/rw/iosystem/signals/Net%201/Dev%2F1/di%201?resource=config');
  });

  it('refuses an empty name with INVALID_ARGUMENT before anything is sent', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: RW6_SIGNAL_CONFIG }));
    const a = rws1(client);
    for (const call of [
      () => a.getSignalConfig('', 'DRV_1', 'DRV1TESTE2'),
      () => a.getSignalConfig('Local', ' ', 'DRV1TESTE2'),
      () => a.getSignalConfig('Local', 'DRV_1', ''),
      () => a.getIoNetworkConfig(''),
      () => a.getIoDeviceConfig('Local', ''),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(urls).toEqual([]);
  });

  it('an answer with no general entry is PARSE_ERROR, never another entry', async () => {
    const runtimeOnly = RW6_SIGNAL_CONFIG.replace(/<li class="ios-signal-config-general"[\s\S]*?<\/li>/, '');
    const { client } = fakeRws1(() => ({ status: 200, body: runtimeOnly }));
    await expect(rws1(client).getSignalConfig('Local', 'DRV_1', 'DRV1TESTE2')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('passes the controller refusal through', async () => {
    // The session throws the classified error for a status of 400 or more, as
    // it did for RW 6.16.03's 404 -1073414146 on the RWS 2.0 /config sub-path.
    const client = {
      request: async () => { throw new RwsError('Resource does not exist on the controller: HTTP 404', 'RESOURCE_NOT_FOUND', 404); },
    } as unknown as RwsClient;
    await expect(rws1(client).getIoNetworkConfig('NoSuchNet')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', httpStatus: 404 });
  });

  it('the path table carries the RWS 1.0 rows the adapter reads', () => {
    const io = ALL_TABLES['io'];
    expect((io['getSignalConfig'].rws1 as PathSpec).path).toBe('/rw/iosystem/signals/{network}/{device}/{name}');
    expect((io['getIoNetworkConfig'].rws1 as PathSpec).path).toBe('/rw/iosystem/networks/{network}');
    expect((io['getIoDeviceConfig'].rws1 as PathSpec).path).toBe('/rw/iosystem/devices/{device}');
  });
});

// ─── RWS 1.0: the operating-mode acknowledge stays out ───────────────────────

describe('RWS 1.0 operating-mode acknowledge (deliberately not wrapped)', () => {
  it('RWS1Adapter has no acknowledge, and the path table records the form as a deliberate gap', () => {
    const { client } = fakeRws1(() => ({ status: 200, body: '' }));
    expect((rws1(client) as unknown as Record<string, unknown>)['acknowledgeOperationMode']).toBeUndefined();
    const spec = ALL_TABLES['panel']['acknowledgeOperationMode'].rws1 as PathSpec;
    expect(spec).toMatchObject({ method: 'POST', path: '/rw/panel/opmode', action: 'acknowledge' });
    expect(spec.gap ?? '').toMatch(/FlexPendant/);
  });
});

// ─── RWS 2.0: task motion sub-reads (RW 7.21.4 hal+json, RW 8.2.1 XHTML) ─────

/** Recorded on RW 7.21.4: GET /rw/rapid/tasks/T_ROB1/motion/robtarget (hal+json). */
const RW7_ROBTARGET = "{ \"_links\" : { \"base\" : { \"href\" : \"https://127.0.0.1:9403/rw/rapid/\" }, \"self\" : { \"href\" : \"tasks/T_ROB1/motion/robtarget\" } }  , \"state\" : [ { \"_type\" : \"rapid-robtarget\", \"_title\" : \"robtarget\", \"x\" : \"806.29\", \"y\" : \"0.00\", \"z\" : \"929.00\", \"q1\" : \"0.5\", \"q2\" : \"1.28138E-7\", \"q3\" : \"0.866025\", \"q4\" : \"7.39805E-8\", \"cf1\" : \"0\", \"cf4\" : \"0\", \"cf6\" : \"0\", \"cfx\" : \"0\", \"eax_a\" : \"9E+9\", \"eax_b\" : \"9E+9\", \"eax_c\" : \"9E+9\", \"eax_d\" : \"9E+9\", \"eax_e\" : \"9E+9\", \"eax_f\" : \"9E+9\" } ]}";
/** Recorded on RW 7.21.4: GET .../motion/jointtarget (hal+json). */
const RW7_JOINTTARGET = "{ \"_links\" : { \"base\" : { \"href\" : \"https://127.0.0.1:9403/rw/rapid/\" }, \"self\" : { \"href\" : \"tasks/T_ROB1/motion/jointtarget\" } }  , \"state\" : [ { \"_type\" : \"rapid-jointtarget\", \"_title\" : \"jointtarget\", \"rax_1\" : \"0\", \"rax_2\" : \"0\", \"rax_3\" : \"0\", \"rax_4\" : \"0\", \"rax_5\" : \"30\", \"rax_6\" : \"1.69551E-5\", \"eax_a\" : \"9E+9\", \"eax_b\" : \"9E+9\", \"eax_c\" : \"9E+9\", \"eax_d\" : \"9E+9\", \"eax_e\" : \"9E+9\", \"eax_f\" : \"9E+9\" } ]}";
/** Recorded on RW 7.21.4: GET .../motion/mechunits (hal+json). */
const RW7_MECHUNITS = "{ \"_links\" : { \"base\" : { \"href\" : \"https://127.0.0.1:9403/rw/rapid/\" }, \"self\" : { \"href\" : \"tasks/T_ROB1/motion/mechunits\" } }  , \"state\" : [ { \"_type\" : \"rapid-mechunit\", \"_title\" : \"ROB_1\", \"name\" : \"ROB_1\", \"mode\" : \"active\", \"type\" : \"tcp_robot\" } ]}";
/** Recorded on RW 7.21.4: GET .../motion/extjointstate (hal+json). */
const RW7_EXTJOINTSTATE = "{ \"_links\" : { \"base\" : { \"href\" : \"https://127.0.0.1:9403/rw/rapid/\" }, \"self\" : { \"href\" : \"tasks/T_ROB1/motion/extjointstate\" } }  , \"state\" : [ { \"_type\" : \"rapid-extjointstate\", \"_title\" : \"extjointstate\", \"j1\" : \"not_active\", \"j2\" : \"not_active\", \"j3\" : \"not_active\", \"j4\" : \"not_active\", \"j5\" : \"not_active\", \"j6\" : \"not_active\" } ]}";
/** Recorded on RW 8.2.1: the same four as XHTML. */
const RW8_ROBTARGET_X = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><base href=\"https://127.0.0.1:9805/rw/rapid/\"/></head><body><div class=\"state\"> <a href=\"tasks/T_ROB1/motion/robtarget\" rel=\"self\"/> <ul> <li class=\"rapid-robtarget\" title=\"robtarget\"> <span class=\"x\">806.29</span> <span class=\"y\">0.00</span> <span class=\"z\">929.00</span> <span class=\"q1\">0.5</span> <span class=\"q2\">1.55145E-8</span> <span class=\"q3\">0.866025</span> <span class=\"q4\">8.95729E-9</span> <span class=\"cf1\">0</span> <span class=\"cf4\">0</span> <span class=\"cf6\">0</span> <span class=\"cfx\">0</span> <span class=\"eax_a\">9E+9</span> <span class=\"eax_b\">9E+9</span> <span class=\"eax_c\">9E+9</span> <span class=\"eax_d\">9E+9</span> <span class=\"eax_e\">9E+9</span> <span class=\"eax_f\">9E+9</span> </li> </ul></div></body></html>";
const RW8_JOINTTARGET_X = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><base href=\"https://127.0.0.1:9805/rw/rapid/\"/></head><body><div class=\"state\"> <a href=\"tasks/T_ROB1/motion/jointtarget\" rel=\"self\"/> <ul> <li class=\"rapid-jointtarget\" title=\"jointtarget\"> <span class=\"rax_1\">0</span> <span class=\"rax_2\">0</span> <span class=\"rax_3\">0</span> <span class=\"rax_4\">0</span> <span class=\"rax_5\">30</span> <span class=\"rax_6\">2.05286E-6</span> <span class=\"eax_a\">9E+9</span> <span class=\"eax_b\">9E+9</span> <span class=\"eax_c\">9E+9</span> <span class=\"eax_d\">9E+9</span> <span class=\"eax_e\">9E+9</span> <span class=\"eax_f\">9E+9</span> </li> </ul></div></body></html>";
const RW8_MECHUNITS_X = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><base href=\"https://127.0.0.1:9805/rw/rapid/\"/></head><body><div class=\"state\"> <a href=\"tasks/T_ROB1/motion/mechunits\" rel=\"self\"/> <ul> <li class=\"rapid-mechunit\" title=\"ROB_1\"> <span class=\"name\">ROB_1</span> <span class=\"mode\">active</span> <span class=\"type\">tcp_robot</span> </li> </ul></div></body></html>";
const RW8_EXTJOINTSTATE_X = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><base href=\"https://127.0.0.1:9805/rw/rapid/\"/></head><body><div class=\"state\"> <a href=\"tasks/T_ROB1/motion/extjointstate\" rel=\"self\"/> <ul> <li class=\"rapid-extjointstate\" title=\"extjointstate\"> <span class=\"j1\">not_active</span> <span class=\"j2\">not_active</span> <span class=\"j3\">not_active</span> <span class=\"j4\">not_active</span> <span class=\"j5\">not_active</span> <span class=\"j6\">not_active</span> </li> </ul></div></body></html>";

const BY_SUB: Record<string, { hal: string; xhtml: string }> = {
  robtarget: { hal: RW7_ROBTARGET, xhtml: RW8_ROBTARGET_X },
  jointtarget: { hal: RW7_JOINTTARGET, xhtml: RW8_JOINTTARGET_X },
  mechunits: { hal: RW7_MECHUNITS, xhtml: RW8_MECHUNITS_X },
  extjointstate: { hal: RW7_EXTJOINTSTATE, xhtml: RW8_EXTJOINTSTATE_X },
};

/** Serve the recorded sub-resource as hal+json (RW 7.21.4 bodies) or as XHTML only (RW 8.2.1 bodies). */
const motionServer = (form: 'hal' | 'xhtml') => (_m: string, url: string): [number, string, string] => {
  const sub = /\/motion\/([a-z]+)$/.exec(url)?.[1] ?? '';
  const rec = BY_SUB[sub];
  if (!rec) { return [404, HAL, '{}']; }
  return form === 'hal' ? [200, HAL, rec.hal] : [200, XHTML, rec.xhtml];
};

describe('RwsClient2 task motion sub-reads', () => {
  for (const form of ['hal', 'xhtml'] as const) {
    describe(form === 'hal' ? 'hal+json (RW 7.21.4)' : 'XHTML (RW 8.2.1)', () => {
      it('getTaskRobTarget reads position, orientation, configuration and the external-axis markers', async () => {
        await withServer(motionServer(form), async (c, urls) => {
          const r = await c.getTaskRobTarget('T_ROB1');
          expect(urls.at(-1)).toBe('/rw/rapid/tasks/T_ROB1/motion/robtarget');
          expect(r.x).toBeCloseTo(806.29, 2);
          expect(r.y).toBe(0);
          expect(r.z).toBe(929);
          expect(r.q1).toBe(0.5);
          expect(r.q3).toBeCloseTo(0.866025, 6);
          expect(Math.abs(r.q2)).toBeLessThan(1e-6);
          expect([r.cf1, r.cf4, r.cf6, r.cfx]).toEqual([0, 0, 0, 0]);
          expect(r.eax).toHaveLength(6);
          for (const e of r.eax) { expect(isJointValuePresent(e)).toBe(false); }
        });
      });

      it('getTaskJointTarget reads the six robot axes in degrees and the external-axis markers', async () => {
        await withServer(motionServer(form), async (c, urls) => {
          const j = await c.getTaskJointTarget('T_ROB1');
          expect(urls.at(-1)).toBe('/rw/rapid/tasks/T_ROB1/motion/jointtarget');
          expect(j.rax.slice(0, 5)).toEqual([0, 0, 0, 0, 30]);
          expect(Math.abs(j.rax[5])).toBeLessThan(1e-4);
          for (const e of j.eax) { expect(isJointValuePresent(e)).toBe(false); }
        });
      });

      it('getTaskMechunits lists each unit with its mode and type', async () => {
        await withServer(motionServer(form), async (c, urls) => {
          expect(await c.getTaskMechunits('T_ROB1')).toEqual([{ name: 'ROB_1', mode: 'active', type: 'tcp_robot' }]);
          expect(urls.at(-1)).toBe('/rw/rapid/tasks/T_ROB1/motion/mechunits');
        });
      });

      it('getTaskExtJointState names the six external joints and their states', async () => {
        await withServer(motionServer(form), async (c, urls) => {
          expect(await c.getTaskExtJointState('T_ROB1')).toEqual({
            j1: 'not_active', j2: 'not_active', j3: 'not_active', j4: 'not_active', j5: 'not_active', j6: 'not_active',
          });
          expect(urls.at(-1)).toBe('/rw/rapid/tasks/T_ROB1/motion/extjointstate');
        });
      });
    });
  }

  it('refuses an empty task with INVALID_ARGUMENT before anything is sent', async () => {
    await withServer(motionServer('hal'), async (c, urls) => {
      for (const call of [
        () => c.getTaskRobTarget(''), () => c.getTaskJointTarget(' '),
        () => c.getTaskMechunits(''), () => c.getTaskExtJointState(''),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(urls).toEqual([]);
    });
  });

  it('an answer without the class, or with a field that is not a number, is PARSE_ERROR', async () => {
    const dir = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:9403/rw/rapid/" } }, "_embedded" : { "resources" : [] }}';
    await withServer(() => [200, HAL, dir], async c => {
      await expect(c.getTaskRobTarget('T_ROB1')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
      await expect(c.getTaskJointTarget('T_ROB1')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
      await expect(c.getTaskExtJointState('T_ROB1')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
      expect(await c.getTaskMechunits('T_ROB1')).toEqual([]);
    });
    await withServer(() => [200, HAL, RW7_ROBTARGET.replace('"x" : "806.29"', '"x" : "n/a"')], async c => {
      await expect(c.getTaskRobTarget('T_ROB1')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    });
  });

  it('passes the controller refusal through as a typed RwsError', async () => {
    await withServer(() => [404, HAL, '{"status":{"code":-1073445866,"msg":"Resource not found"}}'], async c => {
      const err = await c.getTaskRobTarget('NO_TASK').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).httpStatus).toBe(404);
    });
  });

  it('the path table carries the four rows, RWS 2.0 only', () => {
    const rapid = ALL_TABLES['rapid'];
    for (const [op, sub] of [['getTaskRobTarget', 'robtarget'], ['getTaskJointTarget', 'jointtarget'],
      ['getTaskMechunits', 'mechunits'], ['getTaskExtJointState', 'extjointstate']] as const) {
      expect(rapid[op].rws2 as PathSpec).toEqual({ method: 'GET', path: `/rw/rapid/tasks/{task}/motion/${sub}` });
      expect(rapid[op].rws1).toBeUndefined();
    }
  });
});
