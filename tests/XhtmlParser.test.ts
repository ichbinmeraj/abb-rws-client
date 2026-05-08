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
  });
});
