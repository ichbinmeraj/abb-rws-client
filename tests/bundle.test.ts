import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';
import type { HttpSession } from '../src/HttpSession.js';

/**
 * The client inside a CommonJS bundle, built the way the VS Code extension builds
 * it (esbuild, `format: 'cjs'`, `platform: 'node'`, `ws` bundled in). A CJS bundle
 * has no `import.meta` (esbuild turns it into `{}`), so code that reads it works
 * under vitest and in Node ESM and fails only in the shipped extension. Two such
 * reads did: the discovery User-Agent lost its version, and every RWS 1.0
 * subscription failed with NETWORK_ERROR because `ws` could not be loaded.
 *
 * esbuild is a devDependency of its own (until 1.5.1 it came only through
 * vitest's vite, and these tests skipped without it): a checkout that cannot
 * import it fails this file at once rather than leaving the shipped shape
 * untested.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Bundle {
  defaultUserAgent(): string;
  WsSubscriber: new (session: HttpSession, host: string, port: number) => {
    subscribe(resources: string[], handler: () => void): Promise<() => Promise<void>>;
  };
}

describe('the client in a CommonJS bundle (as the VS Code extension ships it)', () => {
  let dir = '';
  let bundle: Bundle;
  let code = '';
  let warnings: string[] = [];

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: [
          "export * from './src/index.ts';",
          "export { defaultUserAgent } from './src/discovery/probe.ts';",
          "export { WsSubscriber } from './src/WsSubscriber.ts';",
        ].join('\n'),
        resolveDir: ROOT,
        sourcefile: 'bundle-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      write: false,
      logLevel: 'silent',
    });
    code = result.outputFiles[0].text;
    warnings = result.warnings.map(w => w.text);
    dir = mkdtempSync(path.join(tmpdir(), 'abb-rws-bundle-'));
    const file = path.join(dir, 'client.cjs');
    writeFileSync(file, code);
    bundle = createRequire(import.meta.url)(file) as Bundle;
  }, 30000);

  afterAll(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); }
  });

  it('nothing in the client reads import.meta', () => {
    expect(warnings.filter(w => w.includes('import.meta'))).toEqual([]);
    expect(code).not.toMatch(/\bimport_meta\d*\b/);
  });

  it('the discovery User-Agent carries the version', async () => {
    const { CLIENT_VERSION } = await import('../src/version.js');
    expect(bundle.defaultUserAgent()).toBe(`abb-rws-client/${CLIENT_VERSION} discovery`);
  });

  it('an RWS 1.0 subscription opens its WebSocket with the session Cookie', async () => {
    const wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      handleProtocols: protocols => protocols.values().next().value ?? false,
    });
    await new Promise<void>(resolve => wss.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    const upgrade = new Promise<{ cookie?: string; protocol?: string }>(resolve => {
      wss.once('connection', (_socket, req) => resolve({
        cookie: req.headers.cookie,
        protocol: req.headers['sec-websocket-protocol'],
      }));
    });
    const cookie = 'ABBCX=abc123; -http-session-=xyz789';
    const session = {
      post: async () => ({
        status: 201,
        body: '',
        headers: new Headers({ location: `http://127.0.0.1:${port}/subscription/42` }),
      }),
      delete: async () => ({ status: 200, body: '', headers: new Headers() }),
      getCookieHeader: () => cookie,
    } as unknown as HttpSession;

    try {
      const subscriber = new bundle.WsSubscriber(session, '127.0.0.1', port);
      const stop = await subscriber.subscribe(['execution'], () => undefined);
      const seen = await upgrade;
      expect(seen.cookie).toBe(cookie);
      expect(seen.protocol).toBe('robapi2_subscription');
      await stop();
    } finally {
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
  });
});
