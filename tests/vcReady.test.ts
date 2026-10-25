import { describe, it, expect } from 'vitest';
import { assessController, checkControllers, laneOf, parseField, parseLanes, renderTable, summarise } from '../scripts/vc-ready.mjs';

interface ProbeTarget { port: number; tls: boolean; gen: 1 | 2; auth: 'basic' | 'digest' }
type Probe = (target: ProbeTarget, path: string) => Promise<{ status: number; body: string; error?: string }>;

/**
 * Offline checks of `scripts/vc-ready.mjs`: lane classification, the three
 * reads per controller, the table, the JSON shape and the exit code, with the
 * wire replaced by injected answers. Nothing here opens a socket.
 */

const rw6: ProbeTarget = { port: 2302, tls: false, gen: 1, auth: 'digest' };
const rw7: ProbeTarget = { port: 5466, tls: true, gen: 2, auth: 'basic' };
const rw8: ProbeTarget = { port: 9403, tls: true, gen: 2, auth: 'basic' };

const halSystem = (rw: string, name = 'IRB1600_6_120_5'): string =>
  `{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","name":"${name}","rwversion":"${rw}"}]}`;
const halOpmode = (mode: string): string =>
  `{"state":[{"_type":"pnl-opmode","opmode":"${mode}"}]}`;
const halCtrl = (state: string): string =>
  `{"state":[{"_type":"pnl-ctrlstate","ctrlstate":"${state}"}]}`;
const xhtmlSystem = (rw: string, name: string): string =>
  `<html><body><div class="state"><ul><li class="sys-system"><span class="name">${name}</span><span class="rwversion">${rw}</span></li></ul></div></body></html>`;
const xhtmlOpmode = (mode: string): string => `<html><body><span class="opmode">${mode}</span></body></html>`;
const xhtmlCtrl = (state: string): string => `<html><body><span class="ctrlstate">${state}</span></body></html>`;

/** A probe over canned answers per path; records what was asked. */
function canned(answers: Record<string, { status: number; body?: string }>, log: string[] = []): Probe {
  return async (target, path) => {
    log.push(`${target.port} ${path}`);
    const a = answers[path];
    return a ? { status: a.status, body: a.body ?? '' } : { status: 404, body: '' };
  };
}

describe('vc-ready: fields and lanes', () => {
  it('reads a field from hal+json and from the RWS 1.0 XHTML span', () => {
    expect(parseField(halSystem('7.21.4+417'), 'rwversion')).toBe('7.21.4+417');
    expect(parseField(xhtmlSystem('6.16.3007', 'IRB120'), 'rwversion')).toBe('6.16.3007');
    expect(parseField(xhtmlOpmode('AUTO'), 'opmode')).toBe('AUTO');
    expect(parseField('', 'opmode')).toBeNull();
  });

  it('lanes: RWS 1.0 is rw6; RWS 2.0 by RobotWare major; unknown otherwise', () => {
    expect(laneOf(1, null)).toBe('rw6');
    expect(laneOf(2, '7.21.4+417')).toBe('rw7');
    expect(laneOf(2, '8.2.1+1023')).toBe('rw8');
    expect(laneOf(2, null)).toBeNull();
    expect(laneOf(2, '9.0.0')).toBeNull();
  });

  it('parseLanes takes a comma list, ignores unknown words, defaults to all three', () => {
    expect(parseLanes(undefined)).toEqual(['rw6', 'rw7', 'rw8']);
    expect(parseLanes('rw8, RW7,bogus')).toEqual(['rw8', 'rw7']);
  });
});

describe('vc-ready: one controller', () => {
  it('is ready when /rw/system, opmode and ctrl-state all answer 2xx, and logs out once', async () => {
    const log: string[] = [];
    const probe = canned({
      '/rw/system': { status: 200, body: halSystem('8.2.1+1023', 'OmniCore_8') },
      '/rw/panel/opmode': { status: 200, body: halOpmode('AUTO') },
      '/rw/panel/ctrl-state': { status: 200, body: halCtrl('motoron') },
      '/logout': { status: 204 },
    }, log);
    const row = await assessController(rw8, probe);
    expect(row).toMatchObject({
      lane: 'rw8', port: 9403, robotware: '8.2.1+1023', system: 'OmniCore_8', opmode: 'AUTO', ctrlstate: 'motoron', ready: true,
    });
    expect(log).toEqual(['9403 /rw/system', '9403 /rw/panel/opmode', '9403 /rw/panel/ctrl-state', '9403 /logout']);
  });

  it('RWS 1.0 answers are read from XHTML, the state from /rw/panel/ctrlstate (no hyphen), and land in rw6', async () => {
    const log: string[] = [];
    const probe = canned({
      '/rw/system': { status: 200, body: xhtmlSystem('6.16.3007', 'IRB1600_6_120_5') },
      '/rw/panel/opmode': { status: 200, body: xhtmlOpmode('AUTO') },
      '/rw/panel/ctrlstate': { status: 200, body: xhtmlCtrl('motoron') },
    }, log);
    const row = await assessController(rw6, probe);
    expect(row).toMatchObject({ lane: 'rw6', robotware: '6.16.3007', system: 'IRB1600_6_120_5', ctrlstate: 'motoron', ready: true });
    expect(log).toContain('2302 /rw/panel/ctrlstate');
    expect(log).not.toContain('2302 /rw/panel/ctrl-state');
  });

  it('is not ready when a read fails, and says which; the logout still goes out', async () => {
    const log: string[] = [];
    const probe = canned({
      '/rw/system': { status: 200, body: halSystem('7.21.4+417') },
      '/rw/panel/opmode': { status: 503 },
      '/rw/panel/ctrl-state': { status: 200, body: halCtrl('motoron') },
    }, log);
    const row = await assessController(rw7, probe);
    expect(row.ready).toBe(false);
    expect(row.opmode).toBeNull();
    expect(row.problem).toMatch(/opmode.*503/);
    expect(log.at(-1)).toBe('5466 /logout');
  });

  it('a controller that does not answer at all is not ready and has no lane', async () => {
    const row = await assessController(rw7, async () => ({ status: 0, error: 'ECONNREFUSED', body: '' }));
    expect(row).toMatchObject({ lane: null, ready: false });
    expect(row.problem).toMatch(/ECONNREFUSED/);
  });
});

describe('vc-ready: the fleet, the table and the exit code', () => {
  const fleet = async (): Promise<ReturnType<typeof summarise>> => {
    const byPort: Record<number, Record<string, { status: number; body?: string }>> = {
      2302: {
        '/rw/system': { status: 200, body: xhtmlSystem('6.16.3007', 'IRB120') },
        '/rw/panel/opmode': { status: 200, body: xhtmlOpmode('AUTO') },
        '/rw/panel/ctrlstate': { status: 200, body: xhtmlCtrl('motoron') },
      },
      5466: {
        '/rw/system': { status: 200, body: halSystem('7.21.4+417', 'OmniCore_7') },
        '/rw/panel/opmode': { status: 200, body: halOpmode('MANR') },
        '/rw/panel/ctrl-state': { status: 200, body: halCtrl('motoroff') },
      },
      9403: {
        '/rw/system': { status: 0 },
      },
    };
    const probe: Probe = async (t, p) => {
      const a = byPort[t.port]?.[p];
      if (!a) { return { status: 404, body: '' }; }
      return a.status === 0 ? { status: 0, error: 'ETIMEDOUT', body: '' } : { status: a.status, body: a.body ?? '' };
    };
    const rows = await checkControllers([rw6, rw7, rw8], probe);
    return summarise(rows, ['rw6', 'rw7', 'rw8']);
  };

  it('summarises ready and down lanes; exit 0 only when every requested lane is ready', async () => {
    const s = await fleet();
    expect(s.ready).toEqual(['rw6', 'rw7']);
    expect(s.down).toEqual(['rw8']);
    expect(s.exitCode).toBe(1);
    const rows = s.rows;
    expect(summarise(rows, ['rw6', 'rw7']).exitCode).toBe(0);
    expect(summarise(rows, ['rw8']).exitCode).toBe(1);
    // A lane with no controller at all is down too.
    expect(summarise(rows.filter(r => r.lane !== 'rw7'), ['rw7']).down).toEqual(['rw7']);
  });

  it('renders one line per controller plus the lane verdicts, and the JSON names every lane', async () => {
    const s = await fleet();
    const text = renderTable(s);
    expect(text).toMatch(/lane\s+port\s+RobotWare\s+system\s+opmode\s+ctrlstate\s+ready/);
    expect(text).toMatch(/rw6\s+2302\s+6\.16\.3007\s+IRB120\s+AUTO\s+motoron\s+yes/);
    expect(text).toMatch(/rw7\s+5466\s+7\.21\.4\+417\s+OmniCore_7\s+MANR\s+motoroff\s+yes/);
    expect(text).toMatch(/-\s+9403\s+-\s+-\s+-\s+-\s+no/);
    expect(text).toMatch(/rw8: down/);
    expect(s.lanes).toEqual({ rw6: 'ready', rw7: 'ready', rw8: 'down' });
  });
});
