import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError, type UserRegistration } from '../src/types.js';

/**
 * Unit tests for the endpoint-completion additions (2026-08-09).
 *
 * Each assertion encodes something a live controller actually told us during
 * the endpoint-completion crawl - the request shapes here are the ones RW7.21
 * and RW8.1.1 accepted, and the refusals are the ones they returned.
 */

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface Recorded { method: string; url: string; body: string }

async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    void collectBody(req).then(body => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      handle(req, res, body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

/** The requests other than the edit-mastership request and release the
 *  client now holds around each of these writes (no connect() here, so the
 *  RobotWare 7 mastership path is taken). */
const withoutAccess = (requests: Recorded[]): Recorded[] =>
  requests.filter(r => !r.url.startsWith('/rw/mastership/'));

const client = (port: number): RwsClient2 =>
  new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics');

const xhtml = (inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">`
  + `<head><base href="http://x/"/></head><body><div class="state">${inner}</div></body></html>`;

describe('endpoint completion - panel and controller', () => {
  it('setPanelLanguage posts lang-code, the field the OPTIONS form advertises', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).setPanelLanguage('de');
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/rw/panel/lang');
      expect(requests[0].body).toBe('lang-code=de');
    } finally { server.close(); }
  });

  it('setControllerLanguage posts lang (a DIFFERENT field name from the panel one)', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).setControllerLanguage('de');
      expect(requests[0].url).toBe('/ctrl/lang');
      expect(requests[0].body).toBe('lang=de');
    } finally { server.close(); }
  });

  it('setExternalEmergencyStop posts state=on / state=off (the circuit), and maps active to off and reset to on', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      const c = client(port);
      await c.setExternalEmergencyStop('off');
      await c.setExternalEmergencyStop('on');
      await c.setExternalEmergencyStop('active');
      await c.setExternalEmergencyStop('reset');
      expect(requests.map(r => r.url)).toEqual(Array(4).fill('/rw/panel/external-emergency-stop'));
      expect(requests.map(r => r.body)).toEqual(['state=off', 'state=on', 'state=off', 'state=on']);
    } finally { server.close(); }
  });
});

describe('endpoint completion - paths that notes get wrong', () => {
  it('keyless motor-on posts under ctrl-state, with an empty body', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).setKeylessMotorOn();
      // /rw/panel/keyless-motoron - the shape most notes record - 404s on every
      // generation; the live resource is under ctrl-state and takes no fields.
      // It is held under edit mastership, like the ordinary motors-on.
      expect(requests.map(r => r.url)).toEqual([
        '/rw/mastership/edit/request', '/rw/panel/ctrl-state/keyless-motoron', '/rw/mastership/edit/release',
      ]);
      const [post] = withoutAccess(requests);
      expect(post.method).toBe('POST');
      expect(post.url).toBe('/rw/panel/ctrl-state/keyless-motoron');
      expect(post.body).toBe('');
    } finally { server.close(); }
  });

  it('setModuleText posts task/text and omits path when not given', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).setModuleText('T_ROB1', 'Module1', 'MODULE m\nENDMODULE');
      expect(requests.map(r => r.url)).toEqual([
        '/rw/mastership/edit/request', '/rw/rapid/tasks/T_ROB1/modules/Module1/text', '/rw/mastership/edit/release',
      ]);
      const [post] = withoutAccess(requests);
      expect(post.url).toBe('/rw/rapid/tasks/T_ROB1/modules/Module1/text');
      expect(post.body).toBe('task=T_ROB1&text=MODULE+m%0AENDMODULE');
    } finally { server.close(); }
  });

  it('setModuleTextRange targets /text/range, NOT the textrange the form claims', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).setModuleTextRange(
        'T_ROB1', 'Module1', { startRow: 1, startCol: 1, endRow: 2, endCol: 5 }, 'x',
      );
      // The controller's own form says action="…/textrange"; that path 404s on
      // both RW7.21 and RW8.1.1. The slashed path is the real one.
      const [post] = withoutAccess(requests);
      expect(post.url).toBe('/rw/rapid/tasks/T_ROB1/modules/Module1/text/range');
      expect(post.url).not.toContain('textrange');
      expect(post.body).toContain('replace-mode=After');
      expect(post.body).toContain('query-mode=Force');
      expect(post.body).toContain('startrow=1');
      expect(post.body).toContain('endcol=5');
      expect(requests.map(r => r.url)).toEqual([
        '/rw/mastership/edit/request', post.url, '/rw/mastership/edit/release',
      ]);
    } finally { server.close(); }
  });
});

describe('endpoint completion - signal-search-ex', () => {
  const signals = xhtml(
    '<ul><li class="ios-signal-li" title="n/d/sigA"><span class="name">sigA</span>'
    + '<span class="type">DI</span><span class="lvalue">1</span></li></ul>',
  );

  it('sends one criteria set unsuffixed', async () => {
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' }); res.end(signals);
    });
    try {
      const out = await client(port).searchSignalsEx([{ type: 'DI', device: 'd1' }]);
      expect(requests[0].url).toBe('/rw/iosystem/signals/signal-search-ex');
      expect(requests[0].body).toBe('device=d1&type=DI');
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('sigA');
    } finally { server.close(); }
  });

  it('suffixes the SECOND criteria set with 2 - the narrowing set', async () => {
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' }); res.end(signals);
    });
    try {
      await client(port).searchSignalsEx([{ type: 'DI' }, { type: 'DO', blocked: false }]);
      expect(requests[0].body).toBe('type=DI&type2=DO&blocked2=false');
    } finally { server.close(); }
  });

  it('maps categoryPon onto the form field category-pon', async () => {
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' }); res.end(signals);
    });
    try {
      await client(port).searchSignalsEx([{ categoryPon: 'x' }]);
      expect(requests[0].body).toBe('category-pon=x');
    } finally { server.close(); }
  });

  it('refuses a third criteria set - the form has only two', async () => {
    const { server, port } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await expect(
        client(port).searchSignalsEx([{ type: 'DI' }, { type: 'DO' }, { type: 'AI' }]),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally { server.close(); }
  });

  it('refuses an empty criteria list rather than sending a bare POST', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await expect(client(port).searchSignalsEx([])).rejects.toBeInstanceOf(RwsError);
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });
});

describe('endpoint completion - validate-instances', () => {
  it('derives instancescount and sends the numeric operation verbatim', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      const ok = await client(port).validateCfgInstances({
        operation: 1, domain: 'EIO', type: 'EIO_SIGNAL', instances: ['a', 'b'],
      });
      expect(requests[0].url).toBe('/rw/cfg/validate-instances');
      expect(requests[0].body).toBe(
        'operation=1&cfgdomain=EIO&cfgtype=EIO_SIGNAL&instancescount=2&instances=a&instances=b',
      );
      // 204 = every named instance is valid
      expect(ok).toBe(true);
    } finally { server.close(); }
  });

  it('reports invalid when the controller answers 200 with a complaint body', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<span class="msg">Instance name not found</span>'));
    });
    try {
      const ok = await client(port).validateCfgInstances({
        operation: 1, domain: 'EIO', type: 'EIO_SIGNAL', instances: ['nope'],
      });
      expect(ok).toBe(false);
    } finally { server.close(); }
  });
});

describe('endpoint completion - motion and RAPID', () => {
  it('collision-prediction modelname defaults to robot 0 and sends robotnumber', async () => {
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<ul><li class="ms-collision-prediction-model-name"><span class="modelname">m1</span></li></ul>'));
    });
    try {
      const name = await client(port).getCollisionPredictionModelName();
      expect(requests[0].url).toBe('/rw/motionsystem/collisionprediction/modelname?robotnumber=0');
      expect(name).toBe('m1');
    } finally { server.close(); }
  });

  it('modifyPosition defaults end position to the start position', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).modifyPosition('T_ROB1', 'Module1', { startRow: 12, startCol: 5 });
      expect(requests.map(r => r.url)).toEqual([
        '/rw/mastership/edit/request',
        '/rw/rapid/tasks/T_ROB1/modules/Module1/modify-position',
        '/rw/mastership/edit/release',
      ]);
      const [post] = withoutAccess(requests);
      expect(post.body).toBe('startrow=12&startcol=5&endrow=12&endcol=5');
    } finally { server.close(); }
  });

  it('modifyPosition passes the optional flags through under their form names', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).modifyPosition('T', 'M', {
        startRow: 1, startCol: 2, endRow: 3, endCol: 4,
        checkLimit: true, checkDeactAxes: false, allowDeact: true, text: 'note',
      });
      const [post] = withoutAccess(requests);
      expect(post.body).toContain('checklimit=true');
      expect(post.body).toContain('checkdeactaxes=false');
      expect(post.body).toContain('allowdeact=true');
      expect(post.body).toContain('text=note');
    } finally { server.close(); }
  });

  it('resetTaskProgramPointer targets the per-task pcp, not the global resetpp', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).resetTaskProgramPointer('T_ROB1');
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
        'POST /rw/mastership/edit/request',
        'POST /rw/rapid/tasks/T_ROB1/pcp/reset',
        'POST /rw/mastership/edit/release',
      ]);
    } finally { server.close(); }
  });
});

describe('endpoint completion - diagnostics', () => {
  // The real 400 body, as captured from RW7.21 and RW8.1.1 on 2026-08-09. The
  // controller's status parser needs BOTH the code and msg spans.
  const errBody = (msg: string): string => xhtml(
    `<div class="status"><span class="code">-1073414146</span><span class="msg">${msg}</span></div>`,
  );

  it('treats "No Diagnostics Saved" (400) as an empty state, not an error', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(errBody('rapi_ctrl_resource.cpp[5401] No Diagnostics Saved on controller yet'));
    });
    try {
      const d = await client(port).getDiagnostics();
      expect(d.empty).toBe(true);
      expect(d.entries).toEqual([]);
    } finally { server.close(); }
  });

  it('still throws on a 400 that is NOT the empty-diagnostics case', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(errBody('Something else went wrong'));
    });
    try {
      await expect(client(port).getDiagnostics()).rejects.toBeInstanceOf(RwsError);
    } finally { server.close(); }
  });
});

describe('endpoint completion - subscription group editing', () => {
  it('updateSubscriptionGroup PUTs the same body shape the create POST uses', async () => {
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<ul><li class="pnl-speedratio-ev"><span class="speedratio">100</span></li></ul>'));
    });
    try {
      const body = await client(port).updateSubscriptionGroup('/subscription/2', ['speedratio']);
      expect(requests[0].method).toBe('PUT');
      expect(requests[0].url).toBe('/subscription/2');
      expect(requests[0].body).toBe('resources=1&1=/rw/panel/speedratio;speedratio&1-p=1');
      // The PUT response carries the added resource's initial value event.
      expect(body).toContain('speedratio');
    } finally { server.close(); }
  });

  it('keeps semicolons literal in the PUT body', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      await client(port).updateSubscriptionGroup('/subscription/2', [{ type: 'signal', name: 'sigA' }]);
      expect(requests[0].body).toContain(';state');
      expect(requests[0].body).not.toContain('%3B');
    } finally { server.close(); }
  });

  it('unsubscribeResource DELETEs the group path plus the SUFFIXED resource path', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      await client(port).unsubscribeResource('/subscription/2', 'speedratio');
      expect(requests[0].method).toBe('DELETE');
      // The controller stores membership as the exact string it was given, so
      // the ;stateParam suffix must survive into the DELETE.
      expect(requests[0].url).toBe('/subscription/2/rw/panel/speedratio;speedratio');
    } finally { server.close(); }
  });

  it('unsubscribeResource of every mastership domain DELETEs edit, then motion', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      await client(port).unsubscribeResource('/subscription/2', { type: 'mastership' });
      expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
        'DELETE /subscription/2/rw/mastership/edit',
        'DELETE /subscription/2/rw/mastership/motion',
      ]);
    } finally { server.close(); }
  });

  it('rejects a resource that maps to no RWS 2.0 path', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client(port).unsubscribeResource('/subscription/2', 'nonsense' as any),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  // Signal names go into the body and the DELETE path unencoded (semicolons
  // must stay literal), so a name carrying '&', '=', '?', '#' or '..' would add
  // form fields or aim the request at another resource.
  const BAD_SIGNAL_NAMES = [
    'a&resources=9&9=/rw/panel/ctrl-state', 'di=1', 'di?x=1', 'di#frag', '../../x', 'Local/../di_1',
    'di;lvalue', 'di%2e', 'di 1', 'DRV_1/di_1', 'a/b/c/d', '', 'dí_1',
  ];

  it('updateSubscriptionGroup refuses an invalid signal name before sending anything', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      for (const name of BAD_SIGNAL_NAMES) {
        await expect(
          client(port).updateSubscriptionGroup('/subscription/2', ['speedratio', { type: 'signal', name }]),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('accepts a flat signal name and the network/device/signal form', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      await client(port).updateSubscriptionGroup('/subscription/2',
        [{ type: 'signal', name: 'di_1' }, { type: 'signal', name: 'Local/DRV_1/DO10_1' }]);
      expect(requests[0].body).toBe(
        'resources=1&1=/rw/iosystem/signals/di_1;state&1-p=1'
        + '&resources=2&2=/rw/iosystem/signals/Local/DRV_1/DO10_1;state&2-p=1');
      await client(port).unsubscribeResource('/subscription/2', { type: 'signal', name: 'Local/DRV_1/DO10_1' });
      expect(requests[1].url).toBe('/subscription/2/rw/iosystem/signals/Local/DRV_1/DO10_1;state');
    } finally { server.close(); }
  });

  it('unsubscribeResource refuses an invalid signal name before sending anything', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      for (const name of BAD_SIGNAL_NAMES) {
        await expect(
          client(port).unsubscribeResource('/subscription/2', { type: 'signal', name }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('unsubscribeResource refuses any resource path that would leave the group', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      // A RAPID symbol path is not validated as a signal name - the DELETE
      // target check is what stops it: '..' segments collapse during URL
      // parsing, '?' and '#' split the path.
      for (const name of ['T_ROB1/../../../../subscription/3', 'T_ROB1/M/x?y', 'T_ROB1/M/x#y']) {
        await expect(
          client(port).unsubscribeResource('/subscription/2', { type: 'persvar', name }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('subscribe refuses an invalid signal name before the subscription POST', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(201); res.end(); });
    try {
      await expect(
        client(port).subscribe([{ type: 'signal', name: 'di_1&2=/rw/panel/opmode' }], () => {}),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('updateSubscriptionGroup refuses an empty resource list', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(); });
    try {
      await expect(
        client(port).updateSubscriptionGroup('/subscription/2', []),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });
});

describe('RW8 control-station write access', () => {
  // RW8 clears control-station write access as a side effect of any write, so
  // the release that follows is refused with this exact body. Captured live
  // 2026-08-09 from RW8.1.1.
  const spocRefusal = xhtml(
    '<div class="status"><span class="code">-1073435873</span>'
    + '<span class="msg">The control station does not have SPoC. code:-1073435873 icode:-20107</span></div>',
  );

  /** Mastership 410 GONE makes the client switch to the control-station path. */
  function rw8Server() {
    return startServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
      if (url === '/rw/controlstation/register/remote') { res.writeHead(204); res.end(); return; }
      if (url === '/rw/controlstation/writeaccess/request') { res.writeHead(204); res.end(); return; }
      if (url === '/rw/controlstation/writeaccess/release') {
        res.writeHead(403, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end(spocRefusal);
        return;
      }
      res.writeHead(204); res.end();
    });
  }

  it('releaseMastership does not throw when RW8 says the station has no SPoC', async () => {
    const { server, port, requests } = await rw8Server();
    try {
      const c = client(port);
      await c.requestMastership('motion');
      // Must not reject: the grant is already gone, and throwing here would
      // surface from the caller's finally and mask their real result.
      await expect(c.releaseMastership('motion')).resolves.toBeUndefined();
      expect(requests.some(r => r.url === '/rw/controlstation/writeaccess/release')).toBe(true);
    } finally { server.close(); }
  });

  it('still throws on a release 403 that is NOT the SPoC condition', async () => {
    const { server, port } = await startServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
      if (url === '/rw/controlstation/writeaccess/release') {
        res.writeHead(403, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end(xhtml('<div class="status"><span class="code">-1073445867</span><span class="msg">The user is not allowed access</span></div>'));
        return;
      }
      res.writeHead(204); res.end();
    });
    try {
      const c = client(port);
      await c.requestMastership('motion');
      await expect(c.releaseMastership('motion')).rejects.toBeInstanceOf(RwsError);
    } finally { server.close(); }
  });

  it('routes to the control station after mastership answers 410 GONE', async () => {
    const { server, port, requests } = await rw8Server();
    try {
      await client(port).requestMastership('motion');
      const paths = requests.map(r => r.url);
      expect(paths).toContain('/rw/controlstation/register/remote');
      expect(paths).toContain('/rw/controlstation/writeaccess/request');
    } finally { server.close(); }
  });
});

describe('endpoint completion - users and UAS', () => {
  it('registerUser sends ABB\'s four fields, ulocale last (remote and local)', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(201); res.end(); });
    try {
      await client(port).registerUser({ application: 'app', username: 'u', location: 'loc', locale: 'remote' });
      await client(port).registerUser({ application: 'app', username: 'u', location: 'loc', locale: 'local' });
      expect(requests.map(r => r.url)).toEqual(['/users/register', '/users/register']);
      expect(requests[0].body).toBe('application=app&username=u&location=loc&ulocale=remote');
      expect(requests[1].body).toBe('application=app&username=u&location=loc&ulocale=local');
    } finally { server.close(); }
  });

  it('registerUser sends a given locale string as it is, as 1.4.0 did: the controller decides', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(201); res.end(); });
    try {
      for (const locale of ['en-GB', 'Remote', '']) {
        await client(port).registerUser({ application: 'app', username: 'u', location: 'loc', locale });
      }
      expect(requests.map(r => r.body)).toEqual([
        'application=app&username=u&location=loc&ulocale=en-GB',
        'application=app&username=u&location=loc&ulocale=Remote',
        'application=app&username=u&location=loc&ulocale=',
      ]);
    } finally { server.close(); }
  });

  it('registerUser refuses a locale that is not a string (a type error) before sending', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(201); res.end(); });
    try {
      for (const locale of [null, 1, { v: 'remote' }]) {
        const reg = { application: 'app', username: 'u', location: 'loc', locale } as unknown as UserRegistration;
        const err = await client(port).registerUser(reg).catch((e: unknown) => e as RwsError);
        expect(err, String(locale)).toBeInstanceOf(RwsError);
        expect(err).toMatchObject({ code: 'INVALID_ARGUMENT' });
        expect((err as RwsError).message).toMatch(/must be a string.*'local' and 'remote'.*Nothing was sent\./);
      }
      expect(requests).toEqual([]);
    } finally { server.close(); }
  });

  it('a 400 to a locale other than local or remote names ABB\'s two values; code, status and answer kept', async () => {
    // -1073445879 SYS_CTRL_E_INVALIDARG: what a controller answers to such a
    // value is not measured (registerUser has not run); this is a code the
    // client explains as an invalid argument.
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<div class="status"><span class="code">-1073445879</span><span class="msg">Invalid argument</span></div>'));
    });
    try {
      const err = await client(port).registerUser({ application: 'app', username: 'u', location: 'loc', locale: 'Remote' })
        .catch((e: unknown) => e as RwsError);
      expect(err).toBeInstanceOf(RwsError);
      expect(err).toMatchObject({ code: 'INVALID_ARGUMENT', httpStatus: 400, controllerCode: -1073445879 });
      expect(err.message.startsWith("registerUser sent ulocale 'Remote', and ABB's values are 'local' and 'remote'")).toBe(true);
      expect(err.message).toContain('Invalid argument');
      expect(err.refusal?.remedy).toMatchObject({ kind: 'fix-input', detail: expect.stringContaining("'local' and 'remote'") });
      expect(err.refusal?.sentence.startsWith('registerUser sent ulocale')).toBe(true);
      expect(err.refusal?.controller.code).toBe(-1073445879);

      // ABB's own value refused: the controller's answer as it is, no note.
      const plain = await client(port).registerUser({ application: 'app', username: 'u', location: 'loc', locale: 'remote' })
        .catch((e: unknown) => e as RwsError);
      expect(plain).toMatchObject({ code: 'INVALID_ARGUMENT', controllerCode: -1073445879 });
      expect(plain.message).not.toContain('registerUser sent ulocale');
    } finally { server.close(); }
  });

  it('a refusal other than a 400 is passed on as it is, whatever the locale', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(403, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<div class="status"><span class="code">-1073445867</span><span class="msg">The user is not allowed access</span></div>'));
    });
    try {
      const err = await client(port).registerUser({ application: 'app', username: 'u', location: 'loc', locale: 'Remote' })
        .catch((e: unknown) => e as RwsError);
      expect(err).toMatchObject({ httpStatus: 403, controllerCode: -1073445867 });
      expect(err.message).not.toContain('registerUser sent ulocale');
    } finally { server.close(); }
  });

  it('registerUser without a locale sends what 1.4.0 sent: three fields, no ulocale', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(201); res.end(); });
    try {
      // The 1.4.0 shape: locale optional and typed string.
      const reg: { application: string; username: string; location: string; locale?: string } = { application: 'app', username: 'u', location: 'loc' };
      const typed: UserRegistration = reg;
      await client(port).registerUser(typed);
      await client(port).registerUser({ ...typed, locale: undefined });
      expect(requests.map(r => r.url)).toEqual(['/users/register', '/users/register']);
      expect(requests[0].body).toBe('application=app&username=u&location=loc');
      expect(requests[1].body).toBe('application=app&username=u&location=loc');
    } finally { server.close(); }
  });

  it('the 400 RW 7.21.4 and 8.2.1 gave a registration without a locale is a refused input, explained with ABB\'s two values (2026-10-21)', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<div class="status"><span class="code">-1073414146</span><span class="msg">UserRegistration failed:locale name is empty or exceeded size of ulocale</span></div>'));
    });
    try {
      const err = await client(port).registerUser({ application: 'app', username: 'u', location: 'loc' })
        .catch((e: unknown) => e as RwsError);
      expect(err).toBeInstanceOf(RwsError);
      // It said RESOURCE_NOT_FOUND, "Resource does not exist on the controller", before.
      expect(err).toMatchObject({ code: 'INVALID_ARGUMENT', httpStatus: 400, controllerCode: -1073414146 });
      expect(err.message.startsWith("registerUser sent no ulocale, which ABB marks required, with the values 'local' and 'remote'")).toBe(true);
      expect(err.message).toContain('locale name is empty');
      expect(err.message).not.toContain('Resource does not exist');
    } finally { server.close(); }
  });

  it('isPasswordChangeAllowed reads the controller flag', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
      res.end(xhtml('<ul><li class="uas-password-change"><span class="password-change-allow">TRUE</span></li></ul>'));
    });
    try {
      expect(await client(port).isPasswordChangeAllowed()).toBe(true);
    } finally { server.close(); }
  });

  it('isPasswordChangeAllowed reads the password-change-allowed span RW 7.21.4 answers (2026-10-01)', async () => {
    // The live hal+json answer for the Default User, minus the base link; it
    // carries no password-change-allow field, which the method read alone before.
    const live = (v: string): string => JSON.stringify({
      _links: { self: { href: '' } },
      state: [{ _type: 'password-change-allow', _title: 'pass-change-allow', 'password-change-allowed': v }],
    });
    let value = 'true';
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end(live(value));
    });
    try {
      expect(await client(port).isPasswordChangeAllowed()).toBe(true);
      value = 'false';
      expect(await client(port).isPasswordChangeAllowed()).toBe(false);
    } finally { server.close(); }
  });

  it('changePassword uses the hyphenated form field names', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).changePassword('old', 'new');
      expect(requests[0].url).toBe('/uas/user/password');
      expect(requests[0].body).toBe('old-password=old&new-password=new');
    } finally { server.close(); }
  });
});

describe('endpoint completion - 2026-08-11 sweep (RWS 2.0 wire-forms)', () => {
  it('compressPath POSTs /ctrl/compress with srcpath/dstpath normalised to fileservice URIs', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).compressPath('$TEMP/a.txt', '$TEMP/a.rzo');
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/ctrl/compress');
      const b = new URLSearchParams(requests[0].body);
      // The spec's source/destination are wrong; the controller wants srcpath/dstpath.
      expect(b.get('srcpath')).toBe('/fileservice/$TEMP/a.txt');
      expect(b.get('dstpath')).toBe('/fileservice/$TEMP/a.rzo');
    } finally { server.close(); }
  });

  it('decompressPath targets the DISTINCT /ctrl/decompress endpoint (RWS 1.0 reuses compress?action=dcomp)', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).decompressPath('/fileservice/$TEMP/a.rzo', '$TEMP/');
      expect(requests[0].url).toBe('/ctrl/decompress');
      expect(requests[0].url).not.toContain('action=');
      expect(new URLSearchParams(requests[0].body).get('srcpath')).toBe('/fileservice/$TEMP/a.rzo');
    } finally { server.close(); }
  });

  it('searchIoDevices POSTs ?action=search and derives network from the ios-device-li title', async () => {
    const body = '<html><body><ul><li class="ios-device-li" title="EtherNetIP/DRV_1">'
      + '<span class="name">DRV_1</span><span class="lstate">enabled</span>'
      + '<span class="pstate">running</span><span class="address">2</span></li></ul></body></html>';
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(200); res.end(body); });
    try {
      const devs = await client(port).searchIoDevices({ lstate: 'enabled', network: 'EtherNetIP' });
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/rw/iosystem/devices?action=search');
      const b = new URLSearchParams(requests[0].body);
      expect(b.get('lstate')).toBe('enabled');
      expect(b.get('network')).toBe('EtherNetIP');
      // network is _title.split('/')[0] - the only place this derivation is exercised.
      expect(devs[0]).toMatchObject({ name: 'DRV_1', network: 'EtherNetIP', lstate: 'enabled' });
    } finally { server.close(); }
  });

  it('searchIoDevices rejects an empty query with INVALID_ARGUMENT before any request', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      const err = await client(port).searchIoDevices({}).then(() => null, (e: unknown) => e as RwsError);
      expect(err).toBeInstanceOf(RwsError);
      expect(err!.code).toBe('INVALID_ARGUMENT');
      expect(requests).toHaveLength(0);
    } finally { server.close(); }
  });

  it('pollRmmp GETs /users/rmmp/poll and returns the status field', async () => {
    const body = '{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"user-rmmp-poll","_title":"rmmp","status":"NO SUCH REQUEST"}]}';
    const { server, port, requests } = await startServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' }); res.end(body);
    });
    try {
      expect(await client(port).pollRmmp()).toBe('NO SUCH REQUEST');
      expect(requests[0].method).toBe('GET');
      expect(requests[0].url).toBe('/users/rmmp/poll');
    } finally { server.close(); }
  });

  it('pollRmmp reports the RW 8.1.1 "service not supported" 500 as unsupported, not as none', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(500, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073445885,"msg":"Unspecified Error"}}');
    });
    try {
      // -1073445885 SYS_CTRL_E_SERVICE_NOT_SUPPORTED: the controller has no RMMP.
      // It used to read as 'none', i.e. "no privilege held".
      expect(await client(port).pollRmmp()).toBe('unsupported');
    } finally { server.close(); }
  });

  it('pollRmmp throws any other 500 instead of reporting none', async () => {
    const { server, port } = await startServer((_q, res) => {
      res.writeHead(500, { 'Content-Type': 'application/hal+json;v=2.0' });
      res.end('{"_links":{"base":{"href":"https://x/"}},"status":{"code":-1073414146,"msg":"Unspecified Error"}}');
    });
    try {
      await expect(client(port).pollRmmp()).rejects.toBeInstanceOf(RwsError);
    } finally { server.close(); }
  });

  it('cancelRmmp POSTs the RWS 2.0 path-action /users/rmmp/cancel (not the 1.0 query-action)', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).cancelRmmp();
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/users/rmmp/cancel');
      expect(requests[0].url).not.toContain('action=cancel');
    } finally { server.close(); }
  });
});
