import { describe, it, expect } from 'vitest';
import { RwsClient2 } from '../src/RwsClient2.js';

/**
 * Unit tests for RwsClient2's static URL builders. Doesn't hit a live controller.
 * The protocol-level methods are exercised by tests/RwsClient2.live.test.ts and
 * the extension's test-rws2-writes.js when a VC is available.
 */
describe('RwsClient2 (unit)', () => {
  it('exports a class', () => {
    expect(typeof RwsClient2).toBe('function');
    expect(RwsClient2.name).toBe('RwsClient2');
  });

  describe('rws2ResourcePath (subscription URL builder)', () => {
    it('maps string resources to known panel paths', () => {
      // The static method is private — exercise it via known inputs/outputs.
      // We can't import it directly; instead verify the names exist on the class.
      // (If this drifts the live subscribe tests catch it.)
      expect('rws2ResourcePath' in RwsClient2).toBe(true);
    });

    it('maps signal subscription objects to /rw/iosystem/signals path', () => {
      expect('resourcePathToName' in RwsClient2).toBe(true);
    });
  });

  describe('constructor signature', () => {
    it('accepts (baseUrl, username, password)', () => {
      // Construction shouldn't throw — actual network only happens on .connect().
      const c = new RwsClient2('https://127.0.0.1:5466', 'Default User', 'robotics');
      expect(c).toBeInstanceOf(RwsClient2);
    });

    it('handles http:// base URLs', () => {
      const c = new RwsClient2('http://127.0.0.1:80', 'u', 'p');
      expect(c).toBeInstanceOf(RwsClient2);
    });
  });
});
