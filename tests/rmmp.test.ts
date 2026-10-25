import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  waitForRmmp, rmmpLevel, normaliseRmmpPrivilege, isRmmpGranted, isRmmpPending, rmmpWaitOptions,
  RMMP_DENIED_CODE, type RmmpPort,
} from '../src/access/rmmp.js';
import { setLogger } from '../src/Logger.js';
import { RwsError } from '../src/types.js';

/**
 * The RMMP wait (ABB: a request is deleted after 10 s unless polled; the
 * operator grants or denies it at the FlexPendant). A scripted port stands in
 * for the controller: `polls` and `reads` are answered in order, the last
 * answer repeating.
 */

interface Script {
  polls?: Array<string | RwsError | Error>;
  reads?: Array<string | Error>;
  request?: () => Promise<void>;
  cancel?: () => Promise<void>;
}

function port(script: Script): { port: RmmpPort; wire: string[] } {
  const wire: string[] = [];
  let p = 0;
  let r = 0;
  const next = <T>(list: T[] | undefined, i: number, fallback: T): T =>
    list && list.length > 0 ? list[Math.min(i, list.length - 1)] : fallback;
  return {
    wire,
    port: {
      request: async level => { wire.push(`request ${level}`); await script.request?.(); },
      poll: async () => {
        wire.push('poll');
        const a = next(script.polls, p++, 'PENDING');
        if (a instanceof Error) { throw a; }
        return a;
      },
      read: async () => {
        wire.push('read');
        const a = next(script.reads, r++, 'pending modify');
        if (a instanceof Error) { throw a; }
        return a;
      },
      cancel: async () => { wire.push('cancel'); await script.cancel?.(); },
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); setLogger({ info() {}, warn() {}, error() {}, show() {} }); });
afterEach(() => { vi.useRealTimers(); });

describe('RMMP level and state vocabulary (ABB: modify | exec)', () => {
  it('accepts modify and exec, maps the deprecated exclusive to exec, and refuses anything else', () => {
    expect(rmmpLevel('modify')).toBe('modify');
    expect(rmmpLevel('exec')).toBe('exec');
    expect(rmmpLevel('exclusive')).toBe('exec');
    expect(() => rmmpLevel('all')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('reads ABB\'s four states: none, pending modify, modify, exec', () => {
    expect(normaliseRmmpPrivilege('None')).toBe('none');
    expect(normaliseRmmpPrivilege(' Pending  Modify ')).toBe('pending modify');
    expect(isRmmpPending('pending modify')).toBe(true);
    expect(isRmmpGranted('modify')).toBe(true);
    expect(isRmmpGranted('EXEC')).toBe(true);
    expect(isRmmpGranted('none')).toBe(false);
    expect(isRmmpGranted('pending modify')).toBe(false);
  });

  it('checks the wait options before anything is sent: a poll interval inside ABB\'s 10 s window', () => {
    expect(rmmpWaitOptions({})).toEqual({ waitMs: 30_000, pollMs: 1_000 });
    expect(() => rmmpWaitOptions({ pollMs: 10_000 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => rmmpWaitOptions({ pollMs: 50 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => rmmpWaitOptions({ waitMs: -1 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('waitForRmmp', () => {
  it('pending, then granted: polls every second, reads the privilege on every poll, decides from it, sends no cancel', async () => {
    const { port: p, wire } = port({ polls: ['PENDING', 'PENDING', 'GRANTED'], reads: ['pending modify', 'pending modify', 'modify'] });
    const onPending = vi.fn();
    const done = waitForRmmp(p, 'modify', { onPending });
    await vi.advanceTimersByTimeAsync(3000);
    const r = await done;
    expect(r).toMatchObject({ outcome: 'granted', privilege: 'modify' });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(wire).toEqual(['request modify', 'poll', 'read', 'poll', 'read', 'poll', 'read']);
  });

  it('keeps polling inside ABB\'s 10 s window for as long as the wait lasts', async () => {
    const { port: p, wire } = port({ polls: ['PENDING'] });
    const done = waitForRmmp(p, 'modify', { waitMs: 25_000, pollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(26_000);
    await done;
    expect(wire.filter(w => w === 'poll')).toHaveLength(25);
  });

  it('pending until the wait runs out: expired, and the request is cancelled', async () => {
    const { port: p, wire } = port({ polls: ['PENDING'] });
    const done = waitForRmmp(p, 'modify', { waitMs: 5_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const r = await done;
    expect(r.outcome).toBe('expired');
    expect(r.detail).toContain('held the RMMP request pending for 5 s');
    expect(wire.at(-1)).toBe('cancel');
  });

  it('the request is gone without a grant (NO SUCH REQUEST, privilege none): expired, cancelled', async () => {
    const { port: p, wire } = port({ polls: ['PENDING', 'NO SUCH REQUEST'], reads: ['none'] });
    const done = waitForRmmp(p, 'modify');
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await done;
    expect(r).toMatchObject({ outcome: 'expired', privilege: 'none' });
    expect(r.detail).toMatch(/denied it or it expired/);
    expect(wire).toEqual(['request modify', 'poll', 'read', 'poll', 'read', 'cancel']);
  });

  it('NO SUCH REQUEST alone is not expiry: a privilege that reads as granted wins', async () => {
    const { port: p } = port({ polls: ['NO SUCH REQUEST'], reads: ['modify'] });
    const done = waitForRmmp(p, 'modify');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await done).outcome).toBe('granted');
  });

  it('a poll answered with SYS_CTRL_E_DENIED: denied, never re-requested', async () => {
    const denied = new RwsError('The request was denied', 'GRANT_DENIED', 403, undefined, RMMP_DENIED_CODE);
    const { port: p, wire } = port({ polls: ['PENDING', denied] });
    const done = waitForRmmp(p, 'modify');
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await done).outcome).toBe('denied');
    expect(wire.filter(w => w.startsWith('request'))).toHaveLength(1);
  });

  it('a poll text that says denied, with no grant: denied', async () => {
    const { port: p } = port({ polls: ['DENIED'], reads: ['none'] });
    const done = waitForRmmp(p, 'modify');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await done).outcome).toBe('denied');
  });

  it('a failed state read is thrown (never taken as none), after the request is cancelled', async () => {
    const readError = new RwsError('boom', 'NETWORK_ERROR');
    const { port: p, wire } = port({ polls: ['GRANTED'], reads: [readError] });
    const done = waitForRmmp(p, 'modify');
    const settled = done.then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toBe(readError);
    expect(wire).toEqual(['request modify', 'poll', 'read', 'cancel']);
  });

  it('a failed poll is decided from the state read: still pending keeps waiting', async () => {
    const { port: p, wire } = port({ polls: [new RwsError('timeout', 'NETWORK_ERROR'), 'PENDING', 'GRANTED'], reads: ['pending modify', 'modify'] });
    const done = waitForRmmp(p, 'modify');
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await done).outcome).toBe('granted');
    expect(wire).toEqual(['request modify', 'poll', 'read', 'poll', 'read']);
  });

  it('a failed poll with no grant and nothing pending is thrown, after a cancel', async () => {
    const pollError = new RwsError('timeout', 'NETWORK_ERROR');
    const { port: p, wire } = port({ polls: [pollError], reads: ['none'] });
    const settled = waitForRmmp(p, 'modify').then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toBe(pollError);
    expect(wire.at(-1)).toBe('cancel');
  });

  it('an abort while pending: cancelled, and the request is cancelled', async () => {
    const { port: p, wire } = port({ polls: ['PENDING'] });
    const abort = new AbortController();
    const done = waitForRmmp(p, 'modify', { signal: abort.signal });
    await vi.advanceTimersByTimeAsync(2_500);
    abort.abort();
    const r = await done;
    expect(r.outcome).toBe('cancelled');
    expect(wire).toEqual(['request modify', 'poll', 'read', 'poll', 'read', 'cancel']);
  });

  it('aborted before it starts: nothing is sent', async () => {
    const { port: p, wire } = port({});
    const abort = new AbortController();
    abort.abort();
    expect((await waitForRmmp(p, 'modify', { signal: abort.signal })).outcome).toBe('cancelled');
    expect(wire).toEqual([]);
  });

  it('a refused request is thrown as the controller answered it; nothing else is sent', async () => {
    const refused = new RwsError('Rejected', 'GRANT_DENIED', 403, undefined, -1073445800);
    const { port: p, wire } = port({ request: async () => { throw refused; } });
    await expect(waitForRmmp(p, 'modify')).rejects.toBe(refused);
    expect(wire).toEqual(['request modify']);
  });

  it('a cancel that fails is reported in the outcome, not thrown', async () => {
    const { port: p } = port({ polls: ['PENDING'], cancel: async () => { throw new Error('socket closed'); } });
    const done = waitForRmmp(p, 'modify', { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await done;
    expect(r.outcome).toBe('expired');
    expect(r.detail).toContain('The cancel did not go through');
  });
});
