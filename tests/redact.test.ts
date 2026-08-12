import { describe, it, expect } from 'vitest';
import { redactBody } from '../src/redact.js';

describe('redactBody - secret masking for trace logs', () => {
  it('masks password fields (changePassword)', () => {
    expect(redactBody('old-password=hunter2&new-password=s3cr3t'))
      .toBe('old-password=***&new-password=***');
  });

  it('masks pin and pincode (opmode lock, control-station register)', () => {
    expect(redactBody('pin=1234&permanent=false')).toBe('pin=***&permanent=false');
    expect(redactBody('control-station-name=cs&control-station-id=id&pincode=9999'))
      .toBe('control-station-name=cs&control-station-id=id&pincode=***');
  });

  it('preserves non-secret fields verbatim', () => {
    const body = 'regain=continue&execmode=continue&cycle=asis&condition=none';
    expect(redactBody(body)).toBe(body);
  });

  it('does NOT redact enum VALUES that merely contain a secret substring', () => {
    // `stepin` is an execmode value, `searchpassword` an LDAP class - both are
    // values, not keys, and must survive so traces stay useful.
    expect(redactBody('execmode=stepin')).toBe('execmode=stepin');
    expect(redactBody('class=searchpassword&x=1')).toBe('class=searchpassword&x=1');
  });

  it('handles empty / non-form bodies without throwing', () => {
    expect(redactBody(undefined)).toBeUndefined();
    expect(redactBody('')).toBe('');
    expect(redactBody('a-plain-string-no-equals')).toBe('a-plain-string-no-equals');
  });

  it('masks only the secret field in a mixed body', () => {
    expect(redactBody('user=admin&new-password=abc%20def&role=op'))
      .toBe('user=admin&new-password=***&role=op');
  });
});
