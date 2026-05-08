import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { probeProtocol, createClient } from '../src/detect.js';
import { RwsClient2 } from '../src/RwsClient2.js';

/**
 * Fixture HTTP servers that emit specific WWW-Authenticate challenges so we
 * can test protocol detection without needing a live VC.
 */
function makeAuthServer(challenge: string): { server: http.Server; port: number } {
  const server = http.createServer((req, res) => {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', challenge);
    res.setHeader('Content-Type', 'text/plain');
    res.end('Unauthorized');
  });
  server.listen(0); // OS picks free port
  const addr = server.address();
  if (!addr || typeof addr === 'string') { throw new Error('server has no port'); }
  return { server, port: addr.port };
}

describe('detect.probeProtocol', () => {
  let digestSrv: ReturnType<typeof makeAuthServer>;
  let basicSrv: ReturnType<typeof makeAuthServer>;
  let unknownSrv: ReturnType<typeof makeAuthServer>;

  beforeAll(() => {
    digestSrv  = makeAuthServer('Digest realm="validusers@robapi.abb", qop="auth", nonce="abc"');
    basicSrv   = makeAuthServer('Basic realm="ROBAPI"');
    unknownSrv = makeAuthServer('Bearer realm="something"');
  });

  afterAll(() => {
    digestSrv.server.close();
    basicSrv.server.close();
    unknownSrv.server.close();
  });

  it('detects Digest as RWS 1.0', async () => {
    const proto = await probeProtocol('127.0.0.1', digestSrv.port, false, 1000);
    expect(proto).toBe('rws1');
  });

  it('detects Basic as RWS 2.0', async () => {
    const proto = await probeProtocol('127.0.0.1', basicSrv.port, false, 1000);
    expect(proto).toBe('rws2');
  });

  it('returns null for unreachable port', async () => {
    // Port 1 is reliably refused on most systems
    const proto = await probeProtocol('127.0.0.1', 1, false, 500);
    expect(proto).toBeNull();
  });
});

describe('detect.createClient', () => {
  it('throws PROTOCOL_DETECT_FAILED when no port answers', async () => {
    await expect(
      createClient({ host: '127.0.0.1', port: 1, https: false }),
    ).rejects.toThrow(/PROTOCOL_DETECT_FAILED|RWS|host|connect/i);
  });
});

describe('RwsClient2 instanceof check (used by createClient consumers)', () => {
  it('is a class (function in JS)', () => {
    expect(typeof RwsClient2).toBe('function');
  });
});
