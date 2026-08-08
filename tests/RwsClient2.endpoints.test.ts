import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';

/**
 * Unit tests for the endpoint-completion additions (2026-08-09).
 *
 * Each assertion encodes something a live controller actually told us during
 * the endpoint-completion crawl - the request shapes here are the ones RW7.21
 * and RW8.1.1 accepted, and the refusals are the ones they returned. The live
 * evidence is recorded in docs/tasks/endpoint-completion.md.
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

  it('setExternalEmergencyStop posts state', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).setExternalEmergencyStop('active');
      expect(requests[0].url).toBe('/rw/panel/external-emergency-stop');
      expect(requests[0].body).toBe('state=active');
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
      expect(requests[0].url)
        .toBe('/rw/rapid/tasks/T_ROB1/modules/Module1/modify-position');
      expect(requests[0].body).toBe('startrow=12&startcol=5&endrow=12&endcol=5');
    } finally { server.close(); }
  });

  it('modifyPosition passes the optional flags through under their form names', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).modifyPosition('T', 'M', {
        startRow: 1, startCol: 2, endRow: 3, endCol: 4,
        checkLimit: true, checkDeactAxes: false, allowDeact: true, text: 'note',
      });
      expect(requests[0].body).toContain('checklimit=true');
      expect(requests[0].body).toContain('checkdeactaxes=false');
      expect(requests[0].body).toContain('allowdeact=true');
      expect(requests[0].body).toContain('text=note');
    } finally { server.close(); }
  });

  it('resetTaskProgramPointer targets the per-task pcp, not the global resetpp', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).resetTaskProgramPointer('T_ROB1');
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/rw/rapid/tasks/T_ROB1/pcp/reset');
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

describe('endpoint completion - users and UAS', () => {
  it('registerUser omits ulocale when no locale is given', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).registerUser({ application: 'app', username: 'u', location: 'loc' });
      expect(requests[0].url).toBe('/users/register');
      expect(requests[0].body).toBe('application=app&username=u&location=loc');
    } finally { server.close(); }
  });

  it('registerUser sends ulocale when a locale is given', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).registerUser({ application: 'app', username: 'u', location: 'loc', locale: 'en-GB' });
      expect(requests[0].body).toContain('ulocale=en-GB');
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

  it('changePassword uses the hyphenated form field names', async () => {
    const { server, port, requests } = await startServer((_q, res) => { res.writeHead(204); res.end(); });
    try {
      await client(port).changePassword('old', 'new');
      expect(requests[0].url).toBe('/uas/user/password');
      expect(requests[0].body).toBe('old-password=old&new-password=new');
    } finally { server.close(); }
  });
});
