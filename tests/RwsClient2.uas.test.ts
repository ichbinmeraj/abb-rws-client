import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RwsError } from '../src/types.js';
import { setLogger } from '../src/Logger.js';
import { USERS_UAS } from '../src/paths/index.js';

/**
 * UAS user and role reads (RWS 2.0 only): the users and roles listings, one
 * user's or role's sub-resources, grants, roles, enabled flag, description and
 * password-change property.
 *
 * The 200 bodies are ABB's own examples (UAS_Service Rev L) - no controller has
 * answered one yet, because the OmniCore Default User lacks the UAS
 * administration grant. The 403 bodies are the ones RW 7.21.4 and 8.2.1 answer
 * that user on /uas/users and /uas/roles (read 2026-09-29), and they must come
 * out as GRANT_DENIED.
 */

interface Recorded { method: string; url: string }

type Reply = { status: number; type?: 'hal' | 'xhtml'; body?: string };

async function startServer(reply: (url: string) => Reply): Promise<{ server: http.Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '' });
      const r = reply(req.url ?? '');
      const headers: Record<string, string> = {};
      if (r.type === 'hal') { headers['Content-Type'] = 'application/hal+json;v=2.0'; }
      if (r.type === 'xhtml') { headers['Content-Type'] = 'application/xhtml+xml;v=2.0'; }
      res.writeHead(r.status, headers);
      res.end(r.body ?? '');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const client = (port: number): RwsClient2 =>
  new RwsClient2(`http://127.0.0.1:${port}`, 'Default User', 'robotics');

const page = (base: string, inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">`
  + `<head><base href="${base}"/></head><body><div class="state">${inner}</div></body></html>`;

async function rejection(p: Promise<unknown>): Promise<RwsError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(RwsError); return e as RwsError; }
  throw new Error('expected a rejection');
}

/** The Default User's refusal, as RW 7.21.4 answered it in each representation (2026-09-29). */
const REFUSAL_HAL = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/" } } ,"status" : {"code":-1073445867, "msg": "rapi_uas_resource.cpp[239] The user is not allowed access -1073445867 -757"}}';
const REFUSAL_XHTML = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"> <head> <base href="https://127.0.0.1:5466/"/> </head> <body> <div class="status"> <span class="code">-1073445867</span> <span class="msg">rapi_uas_resource.cpp[239] The user is not allowed access -1073445867 -757</span></div> </body></html>';

describe('UAS path rows', () => {
  it('are RWS 2.0 only, GETs under /uas', () => {
    const ops = [
      'listUasUsers', 'getUasUser', 'listUasUserGrants', 'listUasUserRoles', 'isUasUserEnabled',
      'getUasUserDescription', 'isUasUserPasswordChangeAllowed', 'listUasRoles', 'getUasRole',
      'listUasRoleGrants', 'getUasRoleDescription',
    ];
    for (const op of ops) {
      const row = USERS_UAS[op];
      expect(row, op).toBeDefined();
      expect(row.rws1, `${op} has no RWS 1.0 form`).toBeUndefined();
      expect(row.rws2?.method).toBe('GET');
      expect(row.rws2?.path.startsWith('/uas/')).toBe(true);
    }
  });
});

describe('listUasUsers', () => {
  it('reads ABB\'s example and follows the next page', async () => {
    // ABB UAS_Service Rev L, "Get Users Resources" example, split over two pages.
    const first = page('http://x/uas/users/',
      '<a href="?start=1&amp;limit=2" rel="self"/><a href="?start=2&amp;limit=2" rel="next"/><ul>'
      + '<li class="user" title="Default User"><span class="name">Default User</span>'
      + '<span class="description">New description</span><a href="Default%20User" rel="self"></a></li>'
      + '<li class="user" title="abc"><span class="name">abc</span><span class="description">Some description</span>'
      + '<a href="abc" rel="self"></a></li></ul>');
    const second = page('http://x/uas/users/',
      '<a href="?start=2&amp;limit=2" rel="self"/><ul>'
      + '<li class="user" title="xyz"><span class="name">xyz</span><span class="description">User description</span>'
      + '<a href="xyz" rel="self"></a></li></ul>');
    const { server, port, requests } = await startServer(url => ({
      status: 200, type: 'xhtml', body: url.includes('start=2') ? second : first,
    }));
    try {
      expect(await client(port).listUasUsers()).toEqual([
        { name: 'Default User', description: 'New description' },
        { name: 'abc', description: 'Some description' },
        { name: 'xyz', description: 'User description' },
      ]);
      // An XHTML answer to the first hal+json GET is retried once as XHTML (the
      // client's negotiation fallback), so compare the distinct URLs.
      expect([...new Set(requests.map(r => r.url))]).toEqual(['/uas/users', '/uas/users/?start=2&limit=2']);
    } finally { server.close(); }
  });

  it('reads the hal+json form, falling back to the title for the name', async () => {
    const body = JSON.stringify({
      _links: { base: { href: 'https://127.0.0.1/uas/users/' }, self: { href: '' } },
      state: [{ _type: 'user', _title: 'Operator' }, { _type: 'user', _title: 'x', name: 'Admin', description: 'd' }],
    });
    const { server, port } = await startServer(() => ({ status: 200, type: 'hal', body }));
    try {
      expect(await client(port).listUasUsers()).toEqual([
        { name: 'Operator', description: undefined },
        { name: 'Admin', description: 'd' },
      ]);
    } finally { server.close(); }
  });

  it('the Default User\'s 403 -1073445867 is GRANT_DENIED, in both representations', async () => {
    for (const r of [{ type: 'hal' as const, body: REFUSAL_HAL }, { type: 'xhtml' as const, body: REFUSAL_XHTML }]) {
      const { server, port } = await startServer(() => ({ status: 403, ...r }));
      try {
        const e = await rejection(client(port).listUasUsers());
        expect(e.code).toBe('GRANT_DENIED');
        expect(e.httpStatus).toBe(403);
      } finally { server.close(); }
    }
  });
});

describe('listUasRoles', () => {
  it('reads ABB\'s example (class role-grants, span rolename)', async () => {
    // ABB UAS_Service Rev L, "Get Roles List" example.
    const body = page('http://x/uas/roles/', '<a href="" rel="self"></a><ul>'
      + '<li class="role-grants" title="0"><span class="rolename">rolename</span><span class="description">somedescription</span><a href="rolename" rel="self"></a></li>'
      + '<li class="role-grants" title="1"><span class="rolename">rolename1</span><span class="description">newdescription</span><a href="rolename1" rel="self"></a></li>'
      + '</ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).listUasRoles()).toEqual([
        { name: 'rolename', description: 'somedescription' },
        { name: 'rolename1', description: 'newdescription' },
      ]);
      expect(requests.every(r => r.method === 'GET' && r.url === '/uas/roles')).toBe(true);
    } finally { server.close(); }
  });

  it('accepts the schema\'s user-role-li class too, and never uses the index title as a name', async () => {
    const body = page('http://x/uas/roles/',
      '<ul><li class="user-role-li" title="0"><span class="rolename">Operator</span></li>'
      + '<li class="role-grants" title="1"></li></ul>');
    const { server, port } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).listUasRoles()).toEqual([{ name: 'Operator', description: undefined }]);
    } finally { server.close(); }
  });

  it('the Default User\'s 403 is GRANT_DENIED', async () => {
    const { server, port } = await startServer(() => ({ status: 403, type: 'hal', body: REFUSAL_HAL }));
    try {
      expect((await rejection(client(port).listUasRoles())).code).toBe('GRANT_DENIED');
    } finally { server.close(); }
  });
});

describe('getUasUser / getUasRole - sub-resource links', () => {
  it('lists the user\'s sub-resources and encodes the name (ABB "Get User Properties" example)', async () => {
    const body = page('http://x/uas/users/Default%20User/', '<a href="" rel="self"></a><ul>'
      + '<li class="user-description-li" title="description"><a href= "description" rel="self"/></li>'
      + '<li class="user-password-change-li"\ntitle="password-change-allow"><a href= "password-change-allow" rel="self"/></li>'
      + '<li class="user-enable-li" title="enable"><a href= "enable" rel="self"/></li>'
      + '<li class="user-role-li" title="roles"><a href= "roles" rel="self"/></li>'
      + '<li class="user-grant-li" title="grants"><a href= "grants" rel="self"/></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).getUasUser('Default User')).toEqual(
        ['description', 'password-change-allow', 'enable', 'roles', 'grants']);
      expect(requests[0]).toEqual({ method: 'GET', url: '/uas/users/Default%20User' });
    } finally { server.close(); }
  });

  it('reads the hal+json embedded resources too', async () => {
    const body = JSON.stringify({
      _links: { base: { href: 'https://127.0.0.1/uas/roles/myrole/' }, self: { href: '' } },
      _embedded: { resources: [
        { _links: { self: { href: 'description' } }, _type: 'role-description-li', _title: 'description' },
        { _links: { self: { href: 'grants' } }, _type: 'role-grants-li', _title: 'grants' },
      ] },
    });
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'hal', body }));
    try {
      expect(await client(port).getUasRole('myrole')).toEqual(['description', 'grants']);
      expect(requests[0].url).toBe('/uas/roles/myrole');
    } finally { server.close(); }
  });

  it('PARSE_ERROR when a 200 lists no sub-resources', async () => {
    const { server, port } = await startServer(() => ({ status: 200, type: 'xhtml', body: page('http://x/', '<ul></ul>') }));
    try {
      expect((await rejection(client(port).getUasUser('u1'))).code).toBe('PARSE_ERROR');
      expect((await rejection(client(port).getUasRole('r1'))).code).toBe('PARSE_ERROR');
    } finally { server.close(); }
  });

  it('an empty name is INVALID_ARGUMENT and sends nothing, for every named read', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body: '' }));
    try {
      const c = client(port);
      for (const p of [
        c.getUasUser(''), c.listUasUserGrants(' '), c.listUasUserRoles(''), c.isUasUserEnabled(''),
        c.getUasUserDescription(''), c.isUasUserPasswordChangeAllowed(''),
        c.getUasRole(''), c.listUasRoleGrants(''), c.getUasRoleDescription(''),
      ]) {
        expect((await rejection(p)).code).toBe('INVALID_ARGUMENT');
      }
      expect(requests).toEqual([]);
    } finally { server.close(); }
  });

  it('\'.\' and \'..\' are INVALID_ARGUMENT and send nothing (dot segments would leave the resource)', async () => {
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body: '' }));
    try {
      const c = client(port);
      for (const p of [
        c.getUasUser('..'), c.listUasUserGrants('..'), c.listUasUserRoles('.'), c.isUasUserEnabled('..'),
        c.getUasUserDescription('.'), c.isUasUserPasswordChangeAllowed('..'),
        c.getUasRole('.'), c.listUasRoleGrants('..'), c.getUasRoleDescription('..'),
      ]) {
        expect((await rejection(p)).code).toBe('INVALID_ARGUMENT');
      }
      expect(requests).toEqual([]);
    } finally { server.close(); }
  });
});

describe('grants of a user and of a role', () => {
  it('user grants: class uas-grant, span grantname (ABB "Get All Grants for an User" example)', async () => {
    const body = page('http://x/uas/users/user1/grants/', '<ul>'
      + '<li class="uas-grant" title="0"><span class="grantname">UAS_CFG_WRITE</span></li>'
      + '<li class="uas-grant" title="1"><span class="grantname">UAS_REMOTE_WARMSTART</span></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).listUasUserGrants('user1')).toEqual(['UAS_CFG_WRITE', 'UAS_REMOTE_WARMSTART']);
      expect(requests[0].url).toBe('/uas/users/user1/grants');
    } finally { server.close(); }
  });

  it('user grants in hal+json, the shape RW 7.21.4 serves for the current user', async () => {
    const body = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/uas/users/u/grants/" }, "self" : { "href" : "" } }  , "state" : [  { "_type" : "uas-grant", "_title" : "0","grantname" : "UAS_CFG_WRITE" } , { "_type" : "uas-grant", "_title" : "1","grantname" : "UAS_BACKUP" } ]}';
    const { server, port } = await startServer(() => ({ status: 200, type: 'hal', body }));
    try {
      expect(await client(port).listUasUserGrants('u')).toEqual(['UAS_CFG_WRITE', 'UAS_BACKUP']);
    } finally { server.close(); }
  });

  it('role grants: span grant, not grantname (ABB "Get Grants of an Existing Role" example)', async () => {
    const body = page('http://x/uas/roles/myrole/grants/', '<ul>'
      + '<li class="uas-grant" title="0"><span class="grant">UAS_BACKUP</span></li>'
      + '<li class="uas-grant" title="1"><span class="grant">UAS_KL_MODE_SELECTOR</span></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).listUasRoleGrants('myrole')).toEqual(['UAS_BACKUP', 'UAS_KL_MODE_SELECTOR']);
      expect(requests[0].url).toBe('/uas/roles/myrole/grants');
    } finally { server.close(); }
  });

  it('a role with no grants is an empty list', async () => {
    const { server, port } = await startServer(() => ({ status: 200, type: 'xhtml', body: page('http://x/', '<ul></ul>') }));
    try {
      expect(await client(port).listUasRoleGrants('empty')).toEqual([]);
    } finally { server.close(); }
  });
});

describe('listUasUserRoles', () => {
  it('reads ABB\'s "Get Roles in an User" example', async () => {
    const body = page('http://x/uas/users/user1/roles/', '<ul>'
      + '<li class="user-role" title="0"><span class="rolename">newRole</span></li>'
      + '<li class="user-role" title="1"><span class="rolename">newRole2</span></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).listUasUserRoles('user1')).toEqual(['newRole', 'newRole2']);
      expect(requests[0].url).toBe('/uas/users/user1/roles');
    } finally { server.close(); }
  });
});

describe('isUasUserEnabled / isUasUserPasswordChangeAllowed - strict booleans', () => {
  it('reads ABB\'s "Get User Enabled" example', async () => {
    const body = page('http://x/uas/users/user1/enable/',
      '<ul><li class="user-enabled" title="enabled"><span class="enabled">true</span></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).isUasUserEnabled('user1')).toBe(true);
      expect(requests[0].url).toBe('/uas/users/user1/enable');
    } finally { server.close(); }
  });

  it('reads false in hal+json', async () => {
    const body = JSON.stringify({ _links: {}, state: [{ _type: 'user-enabled', _title: 'enabled', enabled: false }] });
    const { server, port } = await startServer(() => ({ status: 200, type: 'hal', body }));
    try {
      expect(await client(port).isUasUserEnabled('user1')).toBe(false);
    } finally { server.close(); }
  });

  it('reads ABB\'s "Get Password Change Property" example', async () => {
    const body = page('http://x/uas/users/user1/password-change-allow/',
      '<ul><li class="password-change-allow" title="pass-change-allow"><span class="password-change-allow">true</span></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).isUasUserPasswordChangeAllowed('user1')).toBe(true);
      expect(requests[0].url).toBe('/uas/users/user1/password-change-allow');
    } finally { server.close(); }
  });

  it('reads the span RW 7.21.4 answers, password-change-allowed (2026-10-01)', async () => {
    // The live hal+json answer for the Default User, minus the base link.
    const live = (v: string): string => JSON.stringify({
      _links: { self: { href: '' } },
      state: [{ _type: 'password-change-allow', _title: 'pass-change-allow', 'password-change-allowed': v }],
    });
    const { server, port } = await startServer(url => ({ status: 200, type: 'hal', body: live(url.includes('/no/') ? 'false' : 'true') }));
    try {
      expect(await client(port).isUasUserPasswordChangeAllowed('Default User')).toBe(true);
      expect(await client(port).isUasUserPasswordChangeAllowed('no')).toBe(false);
    } finally { server.close(); }
  });

  it('PARSE_ERROR, not false, for a missing block or a value that is not true or false', async () => {
    // Keyed by user name: an XHTML answer to a hal+json GET is retried once.
    const bodies: Record<string, string> = {
      noblock: page('http://x/', '<ul><li class="other" title="x"><span class="enabled">true</span></li></ul>'),
      maybe: page('http://x/', '<ul><li class="user-enabled" title="enabled"><span class="enabled">maybe</span></li></ul>'),
      nospan: page('http://x/', '<ul><li class="password-change-allow" title="p"></li></ul>'),
    };
    const { server, port } = await startServer(url => ({ status: 200, type: 'xhtml', body: bodies[url.split('/')[3]] }));
    try {
      expect((await rejection(client(port).isUasUserEnabled('noblock'))).code).toBe('PARSE_ERROR');
      expect((await rejection(client(port).isUasUserEnabled('maybe'))).code).toBe('PARSE_ERROR');
      expect((await rejection(client(port).isUasUserPasswordChangeAllowed('nospan'))).code).toBe('PARSE_ERROR');
    } finally { server.close(); }
  });
});

describe('descriptions', () => {
  it('reads ABB\'s "Get User Description" example', async () => {
    const body = page('http://x/uas/users/user1/description/',
      '<ul><li class="user-description" title="description"><span class="description">Administrative user for local client</span></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).getUasUserDescription('user1')).toBe('Administrative user for local client');
      expect(requests[0].url).toBe('/uas/users/user1/description');
    } finally { server.close(); }
  });

  it('reads ABB\'s "Get Role Description" example', async () => {
    const body = page('http://x/uas/roles/myrole/description/',
      '<ul><li class="role-description" title="description"><span class="description">New description</span></li></ul>');
    const { server, port, requests } = await startServer(() => ({ status: 200, type: 'xhtml', body }));
    try {
      expect(await client(port).getUasRoleDescription('myrole')).toBe('New description');
      expect(requests[0].url).toBe('/uas/roles/myrole/description');
    } finally { server.close(); }
  });

  it('an empty description reads as \'\'; a missing block is PARSE_ERROR', async () => {
    const bodies: Record<string, string> = {
      roles: page('http://x/', '<ul><li class="role-description" title="description"><span class="description"></span></li></ul>'),
      users: page('http://x/', '<ul></ul>'),
    };
    const { server, port } = await startServer(url => ({ status: 200, type: 'xhtml', body: bodies[url.split('/')[2]] }));
    try {
      expect(await client(port).getUasRoleDescription('r')).toBe('');
      expect((await rejection(client(port).getUasUserDescription('u'))).code).toBe('PARSE_ERROR');
    } finally { server.close(); }
  });

  it('a 403 on a named read is GRANT_DENIED', async () => {
    const { server, port } = await startServer(() => ({ status: 403, type: 'xhtml', body: REFUSAL_XHTML }));
    try {
      expect((await rejection(client(port).getUasUserDescription('u'))).code).toBe('GRANT_DENIED');
    } finally { server.close(); }
  });
});

describe('paged UAS listings - a next link that never ends', () => {
  /** A hal+json listing page with the given entries and `next` href (none when omitted). */
  const halPage = (base: string, type: string, names: string[], next?: string): string => JSON.stringify({
    _links: { base: { href: base }, ...(next !== undefined ? { next: { href: next } } : {}) },
    state: names.map(n => (type === 'user' ? { _type: type, _title: n, name: n } : { _type: type, _title: n, rolename: n })),
  });

  function captureWarnings(): string[] {
    const warnings: string[] = [];
    setLogger({ info() {}, warn(m: string) { warnings.push(m); }, error() {}, show() {} });
    return warnings;
  }
  afterEach(() => { setLogger({ info() {}, warn() {}, error() {}, show() {} }); });

  it('stops when a page\'s next link points at itself, reading each entry once', async () => {
    const warnings = captureWarnings();
    const { server, port, requests } = await startServer(url => ({
      status: 200, type: 'hal',
      body: url.includes('start=2')
        ? halPage('https://127.0.0.1/uas/users/', 'user', ['xyz'], '?start=2&limit=2')
        : halPage('https://127.0.0.1/uas/users/', 'user', ['abc', 'def'], '?start=2&limit=2'),
    }));
    try {
      expect((await client(port).listUasUsers()).map(u => u.name)).toEqual(['abc', 'def', 'xyz']);
      expect(requests.map(r => r.url)).toEqual(['/uas/users', '/uas/users/?start=2&limit=2']);
      expect(warnings.some(w => w.includes('listUasUsers') && w.includes('points back'))).toBe(true);
    } finally { server.close(); }
  });

  it('stops when two pages link to each other', async () => {
    captureWarnings();
    const { server, port, requests } = await startServer(url => ({
      status: 200, type: 'hal',
      body: url.includes('start=2')
        ? halPage('https://127.0.0.1/uas/roles/', 'user-role-li', ['b'], '/uas/roles')
        : halPage('https://127.0.0.1/uas/roles/', 'user-role-li', ['a'], '?start=2&limit=2'),
    }));
    try {
      expect((await client(port).listUasRoles()).map(r => r.name)).toEqual(['a', 'b']);
      expect(requests.map(r => r.url)).toEqual(['/uas/roles', '/uas/roles/?start=2&limit=2']);
    } finally { server.close(); }
  });

  it('stops at 50 pages with a warning when every page links to a new one', async () => {
    const warnings = captureWarnings();
    const { server, port, requests } = await startServer(url => {
      const n = Number(/start=(\d+)/.exec(url)?.[1] ?? '0');
      return { status: 200, type: 'hal', body: halPage('https://127.0.0.1/uas/users/', 'user', [`u${n}`], `?start=${n + 1}&limit=1`) };
    });
    try {
      expect(await client(port).listUasUsers()).toHaveLength(50);
      // Count the user-list pages only: under a loaded test run a stray request
      // from outside this test (a GET /rw/system) can reach this server. Distinct
      // pages: a GET on a keep-alive socket the server just closed is sent once
      // more on a fresh connection, at most once.
      const pages = requests.filter(r => r.url.startsWith('/uas/users'));
      expect(new Set(pages.map(r => r.url)).size).toBe(50);
      expect(pages.length).toBeLessThanOrEqual(51);
      expect(warnings.some(w => w.includes('listUasUsers') && w.includes('50 pages'))).toBe(true);
    } finally { server.close(); }
  }, 20_000);
});
