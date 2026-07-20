import { describe, it, expect } from 'vitest';
import { XhtmlParser } from '../src/XhtmlParser.js';

describe('XhtmlParser', () => {
  describe('getState', () => {
    it('extracts span values from the first <li class=…>', () => {
      const xml = `
        <html><body>
          <li class="pnl-ctrlstate" title="ctrlstate">
            <span class="ctrlstate">motoron</span>
          </li>
        </body></html>`;
      expect(new XhtmlParser(xml).getState('pnl-ctrlstate')).toEqual({
        _title: 'ctrlstate',
        ctrlstate: 'motoron',
      });
    });

    it('returns empty object when the class is absent', () => {
      expect(new XhtmlParser('<html></html>').getState('not-there')).toEqual({});
    });

    it('captures href with rel="self" as _href', () => {
      const xml = `
        <li class="ios-signal-li">
          <a href="/rw/iosystem/signals/Local/DRV_1/DI_1" rel="self"/>
          <span class="name">DI_1</span>
        </li>`;
      const state = new XhtmlParser(xml).getState('ios-signal-li');
      expect(state._href).toBe('/rw/iosystem/signals/Local/DRV_1/DI_1');
      expect(state.name).toBe('DI_1');
    });
  });

  describe('getAllStates', () => {
    it('returns one entry per matching <li>', () => {
      const xml = `
        <li class="rap-task-li" title="T_ROB1"><span class="name">T_ROB1</span><span class="active">On</span></li>
        <li class="rap-task-li" title="T_ROB2"><span class="name">T_ROB2</span><span class="active">Off</span></li>`;
      const all = new XhtmlParser(xml).getAllStates('rap-task-li');
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({ name: 'T_ROB1', active: 'On' });
      expect(all[1]).toMatchObject({ name: 'T_ROB2', active: 'Off' });
    });
  });

  describe('get', () => {
    it('returns the first span value for a class anywhere in the document', () => {
      const xml = `<div><span class="value">42</span></div>`;
      expect(new XhtmlParser(xml).get('value')).toBe('42');
    });

    it('returns undefined when not found', () => {
      expect(new XhtmlParser('<html/>').get('value')).toBeUndefined();
    });
  });

  describe('getError', () => {
    it('parses ABB error status blocks', () => {
      const xml = `
        <div class="status">
          <span class="code">-1073445862</span>
          <span class="msg">Requested resource is held by someone else</span>
        </div>`;
      expect(new XhtmlParser(xml).getError()).toEqual({
        code: '-1073445862',
        msg: 'Requested resource is held by someone else',
      });
    });

    it('returns null when no error block is present', () => {
      expect(new XhtmlParser('<html/>').getError()).toBeNull();
    });

    it('returns an empty msg when the error block has a code but no msg span', () => {
      const xml = '<div class="status"><span class="code">-1073445859</span></div>';
      expect(new XhtmlParser(xml).getError()).toEqual({ code: '-1073445859', msg: '' });
    });

    it('ignores positive code spans (ABB error codes are negative; positive codes appear in elog entries)', () => {
      const xml = '<li class="elog-message-li"><span class="code">10205</span><span class="msg">not an error block</span></li>';
      expect(new XhtmlParser(xml).getError()).toBeNull();
    });

    it('returns the first error block when several are present', () => {
      const xml = `
        <span class="code">-1073445862</span><span class="msg">first</span>
        <span class="code">-1073445879</span><span class="msg">second</span>`;
      expect(new XhtmlParser(xml).getError()).toEqual({ code: '-1073445862', msg: 'first' });
    });

    it('keeps HTML entities in msg undecoded and stops at the first tag', () => {
      const xml = '<span class="code">-1073445879</span><span class="msg">path &quot;HOME/x.mod&quot; invalid</span>';
      expect(new XhtmlParser(xml).getError()?.msg).toBe('path &quot;HOME/x.mod&quot; invalid');
    });

    it('extracts the error from a full RWS 2.0 response document with surrounding state', () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml"><body>
        <div class="state"><ul>
          <li class="pnl-opmode"><span class="opmode">AUTO</span></li>
        </ul></div>
        <div class="status"><h3>Error</h3>
          <span class="code">-1073445862</span>
          <span class="msg">Requested resource is held by someone else</span>
        </div></body></html>`;
      const err = new XhtmlParser(xml).getError();
      expect(err?.code).toBe('-1073445862');
      expect(err?.msg).toContain('held by someone else');
    });
  });

  describe('class-attribute matching (RWS 2.0 emits exact classes)', () => {
    it('getAllStates requires an exact class match - extra class tokens do not match', () => {
      const xml = `
        <li class="rap-task-li selected"><span class="name">T_SKIP</span></li>
        <li class="rap-task-li"><span class="name">T_ROB1</span></li>`;
      const all = new XhtmlParser(xml).getAllStates('rap-task-li');
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('T_ROB1');
    });

    it('get returns an empty string for an empty span (not undefined)', () => {
      expect(new XhtmlParser('<span class="dim"></span>').get('dim')).toBe('');
    });

    it('getAllStates skips spans that carry extra attributes (value capture is attribute-free)', () => {
      const xml = '<li class="elog-message-li"><span class="arg1" type="string">SYS</span><span class="code">10205</span></li>';
      const state = new XhtmlParser(xml).getState('elog-message-li');
      expect(state.arg1).toBeUndefined();
      expect(state.code).toBe('10205');
    });
  });
});
