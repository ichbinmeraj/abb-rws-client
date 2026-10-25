import { describe, it, expect, vi, afterEach, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * The shared session file (~/.abb-rws-session) against a minimal RWS 1.0
 * controller (Digest login, session cookies, /logout). A saved cookie is
 * reused only by a connect with the credentials that created it; every other
 * connect logs in with the credentials it was given and reports a refusal.
 */

// A temporary home directory: the session file must never be the real one here.
const home = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'abb-rws-home-'));
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

const { RobotManager } = await import('../src/RobotManager.js');
const { RWS1Adapter } = await import('../src/RWS1Adapter.js');

const SESSION = path.join(home, '.abb-rws-session');
const USER = 'Default User';
const PASSWORD = 'robotics';
const REALM = 'validusers@robapi.abb';

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

interface Seen { method: string; url: string; cookie: string; signedIn: boolean }

/** A minimal IRC5: Digest sign-in, session cookies, /logout, the controller state. */
async function startController(): Promise<{
  port: number; seen: Seen[]; live: Set<string>; close: () => void;
}> {
  const seen: Seen[] = [];
  const live = new Set<string>();
  let next = 1;
  const server = http.createServer((req, res) => {
    const cookie = String(req.headers['cookie'] ?? '');
    const session = cookie.match(/-http-session-=([^;]+)/)?.[1];
    let signedIn = false;
    if (!session || !live.has(session)) {
      const auth = String(req.headers['authorization'] ?? '');
      const p: Record<string, string> = {};
      for (const m of auth.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) { p[m[1]] = m[2] ?? m[3] ?? ''; }
      const ha1 = md5(`${p['username']}:${REALM}:${p['username'] === USER ? PASSWORD : '\u0000'}`);
      const ha2 = md5(`${req.method}:${p['uri']}`);
      const want = md5(`${ha1}:${p['nonce']}:${p['nc']}:${p['cnonce']}:${p['qop']}:${ha2}`);
      if (!auth.startsWith('Digest ') || p['response'] !== want) {
        seen.push({ method: req.method ?? '', url: req.url ?? '', cookie, signedIn });
        res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="n${next}", qop="auth"` });
        res.end();
        return;
      }
      const id = `S${next++}`;
      live.add(id);
      signedIn = true;
      res.setHeader('Set-Cookie', [`-http-session-=${id}; path=/`, `ABBCX=${id}; path=/`]);
    }
    seen.push({ method: req.method ?? '', url: req.url ?? '', cookie, signedIn });
    const current = (res.getHeader('Set-Cookie') as string[] | undefined)?.[0]?.match(/=([^;]+)/)?.[1] ?? session!;
    if (req.url === '/logout') { live.delete(current); res.writeHead(204); res.end(); return; }
    if ((req.url ?? '').startsWith('/rw/panel/ctrlstate')) {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml' });
      res.end('<html><body><div class="state"><ul><li class="pnl-ctrlstate" title="ctrlstate"><span class="ctrlstate">motoron</span></li></ul></div></body></html>');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen, live, close: () => server.close() };
}

const readFile = (): Record<string, string> => {
  try { return JSON.parse(fs.readFileSync(SESSION, 'utf8')) as Record<string, string>; } catch { return {}; }
};

describe('~/.abb-rws-session: a saved cookie is reused only with the credentials that created it', () => {
  let ctrl: Awaited<ReturnType<typeof startController>>;
  const managers: Array<InstanceType<typeof RobotManager>> = [];
  const manager = (): InstanceType<typeof RobotManager> => { const m = new RobotManager(); managers.push(m); return m; };

  beforeEach(async () => {
    ctrl = await startController();
    vi.spyOn(RobotManager, 'probeSpecificPort').mockResolvedValue({ port: ctrl.port, useHttps: false, authType: 'digest' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(RobotManager.prototype as any, 'fetchAll').mockResolvedValue(undefined);
    vi.spyOn(RWS1Adapter.prototype, 'subscribe').mockRejectedValue(new Error('no ws'));
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) { await m.disconnect().catch(() => {}); }
    vi.restoreAllMocks();
    ctrl.close();
    fs.rmSync(SESSION, { force: true });
  });

  afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('a connect with another password logs in with it, is refused as AUTH_FAILED and never sends the saved cookie', async () => {
    const a = manager();
    await a.connect('127.0.0.1', USER, PASSWORD, ctrl.port);
    const planted = [...ctrl.live][0];
    expect(planted).toBeDefined();
    // The first manager's cookie is in the file, as every connect saves it.
    expect(Object.values(readFile()).some(v => v.includes(`-http-session-=${planted}`))).toBe(true);

    const mark = ctrl.seen.length;
    const b = manager();
    await expect(b.connect('127.0.0.1', USER, 'wrong-password', ctrl.port)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(b.state.connected).toBe(false);
    const sent = ctrl.seen.slice(mark);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter(s => s.cookie.includes(planted))).toEqual([]);

    // The failed connect's disconnect did not log the other session out.
    await b.disconnect();
    expect(ctrl.live.has(planted)).toBe(true);
    expect(a.state.connected).toBe(true);
  });

  it('a connect as another user logs in with its own credentials and never sends the saved cookie', async () => {
    const a = manager();
    await a.connect('127.0.0.1', USER, PASSWORD, ctrl.port);
    const planted = [...ctrl.live][0];
    const mark = ctrl.seen.length;
    await expect(manager().connect('127.0.0.1', 'Operator', PASSWORD, ctrl.port)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(ctrl.seen.slice(mark).filter(s => s.cookie.includes(planted))).toEqual([]);
  });

  it('the same credentials still reuse the saved session (no new sign-in)', async () => {
    const a = manager();
    await a.connect('127.0.0.1', USER, PASSWORD, ctrl.port);
    const planted = [...ctrl.live][0];
    const mark = ctrl.seen.length;
    await manager().connect('127.0.0.1', USER, PASSWORD, ctrl.port);
    const sent = ctrl.seen.slice(mark);
    expect(sent[0].cookie).toContain(`-http-session-=${planted}`);
    expect(sent.some(s => s.signedIn)).toBe(false);
  });

  it('keys the entry by host:port and a verifier, never the password; entries of the old host:port form are neither read nor removed', async () => {
    const legacy = `127.0.0.1:${ctrl.port}`;
    fs.writeFileSync(SESSION, JSON.stringify({ [legacy]: '-http-session-=LEGACY; ABBCX=LEGACY' }));
    const a = manager();
    await a.connect('127.0.0.1', USER, PASSWORD, ctrl.port);
    expect(ctrl.seen.filter(s => s.cookie.includes('LEGACY'))).toEqual([]);
    const text = fs.readFileSync(SESSION, 'utf8');
    expect(text).not.toContain(PASSWORD);
    const keys = Object.keys(readFile());
    expect(keys).toContain(legacy);
    expect(keys.filter(k => k !== legacy)).toEqual([expect.stringMatching(new RegExp(`^127\\.0\\.0\\.1:${ctrl.port}#[0-9a-f]{32}$`))]);
    expect(readFile()[legacy]).toBe('-http-session-=LEGACY; ABBCX=LEGACY');
  });

  it('disconnect logs the session out and removes its entry; other entries stay', async () => {
    fs.writeFileSync(SESSION, JSON.stringify({ 'other:80': '-http-session-=KEEP' }));
    const a = manager();
    await a.connect('127.0.0.1', USER, PASSWORD, ctrl.port);
    const planted = [...ctrl.live][0];
    expect(Object.keys(readFile())).toHaveLength(2);

    await a.disconnect();
    expect(ctrl.live.has(planted)).toBe(false);
    expect(ctrl.seen.some(s => s.url === '/logout' && s.cookie.includes(planted))).toBe(true);
    expect(readFile()).toEqual({ 'other:80': '-http-session-=KEEP' });
  });

  it('disconnect leaves an entry another manager has since replaced with its own cookie', async () => {
    const a = manager();
    await a.connect('127.0.0.1', USER, PASSWORD, ctrl.port);
    const [key] = Object.keys(readFile());
    fs.writeFileSync(SESSION, JSON.stringify({ [key]: '-http-session-=NEWER; ABBCX=NEWER' }));
    await a.disconnect();
    expect(readFile()).toEqual({ [key]: '-http-session-=NEWER; ABBCX=NEWER' });
  });
});
