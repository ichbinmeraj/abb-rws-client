import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import { RwsError } from '../src/types.js';

/**
 * Simulation-panel methods - VC-only endpoints (RobotWare 7 virtual controllers).
 * Wire shapes live-verified 2026-07-09 on an OmniCore VC RW7.21:
 * the stop endpoints take a single `state` key whose polarity is INVERTED from
 * the Swagger example - state=off ENGAGES the stop (opens the safety chain),
 * state=on RELEASES it. Teleport posts rob_joint/ext_joint bracket lists.
 */

const FORM_CT = 'application/x-www-form-urlencoded;v=2.0';

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface RecordedRequest { method: string; url: string; body: string; contentType: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    void collectBody(req).then(body => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', body,
        contentType: (req.headers['content-type'] ?? '') as string,
      });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const ok204 = (_req: http.IncomingMessage, res: http.ServerResponse): void => { res.writeHead(204); res.end(); };

async function withClient(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  run: (client: RwsClient2, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const { server, port, requests } = await startServer(handle);
  try {
    await run(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p'), requests);
  } finally { server.close(); }
}

describe('RwsClient2 simulation panel (VC-only)', () => {
  it('simEmergencyStop engages the e-stop (state=off - inverted polarity)', () =>
    withClient(ok204, async (client, requests) => {
      await client.simEmergencyStop();
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/rw/panel/emergency-stop');
      expect(requests[0].body).toBe('state=off');
      expect(requests[0].contentType).toBe(FORM_CT);
    }));

  it('simResetEmergencyStop releases the e-stop (state=on)', () =>
    withClient(ok204, async (client, requests) => {
      await client.simResetEmergencyStop();
      expect(requests[0].url).toBe('/rw/panel/emergency-stop');
      expect(requests[0].body).toBe('state=on');
    }));

  it('simGeneralStop engages by default and releases with engage=false', () =>
    withClient(ok204, async (client, requests) => {
      await client.simGeneralStop();
      await client.simGeneralStop(false);
      expect(requests.map(r => [r.url, r.body])).toEqual([
        ['/rw/panel/general-stop', 'state=off'],
        ['/rw/panel/general-stop', 'state=on'],
      ]);
    }));

  it('simAutoStop engages by default and releases with engage=false', () =>
    withClient(ok204, async (client, requests) => {
      await client.simAutoStop();
      await client.simAutoStop(false);
      expect(requests.map(r => [r.url, r.body])).toEqual([
        ['/rw/panel/auto-stop', 'state=off'],
        ['/rw/panel/auto-stop', 'state=on'],
      ]);
    }));

  it('simEnableSwitch maps on/off directly (no inversion on this endpoint)', () =>
    withClient(ok204, async (client, requests) => {
      await client.simEnableSwitch(true);
      await client.simEnableSwitch(false);
      expect(requests.map(r => [r.url, r.body])).toEqual([
        ['/rw/panel/enable-switch', 'state=on'],
        ['/rw/panel/enable-switch', 'state=off'],
      ]);
    }));

  it('teleportMechunit posts literal bracket lists with zeroed ext axes by default', () =>
    withClient(ok204, async (client, requests) => {
      await client.teleportMechunit('ROB_1', [10, 15, -10, 20, 30, 45]);
      expect(requests[0].url).toBe('/rw/motionsystem/mechunits/ROB_1/position');
      expect(requests[0].body).toBe('rob_joint=[10,15,-10,20,30,45]&ext_joint=[0,0,0,0,0,0]');
      expect(requests[0].contentType).toBe(FORM_CT);
    }));

  it('teleportMechunit forwards explicit external-axis values', () =>
    withClient(ok204, async (client, requests) => {
      await client.teleportMechunit('ROB_1', [0, 0, 0, 0, 0, 0], [90, 0, 0, 0, 0, 0]);
      expect(requests[0].body).toBe('rob_joint=[0,0,0,0,0,0]&ext_joint=[90,0,0,0,0,0]');
    }));

  it('teleportMechunit rejects a wrong joint count before anything hits the wire', () =>
    withClient(ok204, async (client, requests) => {
      await expect(client.teleportMechunit('ROB_1', [1, 2, 3])).rejects.toBeInstanceOf(RwsError);
      expect(requests.length).toBe(0);
    }));

  it('translates the 404 a real controller returns into a clear VC-only RwsError', async () => {
    const notFound = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
      res.writeHead(404, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end('{ "_links":{}, "status" : {"code":-1073445859, "msg":"Resource not found"}}');
    };
    await withClient(notFound, async client => {
      const err = await client.simEmergencyStop().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).httpStatus).toBe(404);
      expect((err as RwsError).message).toMatch(/virtual controller/i);
    });
    await withClient(notFound, async client => {
      const err = await client.teleportMechunit('ROB_1', [0, 0, 0, 0, 0, 0]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).message).toMatch(/virtual controller/i);
    });
  });

  it('other HTTP errors (e.g. 403) pass through untranslated', async () => {
    await withClient((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end('{ "_links":{}, "status" : {"code":-1073445860, "msg":"not allowed in current opmode"}}');
    }, async client => {
      const err = await client.simEmergencyStop().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).httpStatus).toBe(403);
      expect((err as RwsError).message).not.toMatch(/virtual controller/i);
      expect((err as RwsError).rwsDetail).toContain('not allowed');
    });
  });

  it('stays off the RWS 1.0 surface (RwsClient/RWS1Adapter must not gain sim methods)', async () => {
    const { RwsClient } = await import('../src/RwsClient.js');
    for (const name of ['simEmergencyStop', 'simResetEmergencyStop', 'simEnableSwitch',
      'simGeneralStop', 'simAutoStop', 'teleportMechunit']) {
      expect(name in RwsClient.prototype).toBe(false);
      expect(name in RWS1Adapter.prototype).toBe(false);
    }
  });
});
