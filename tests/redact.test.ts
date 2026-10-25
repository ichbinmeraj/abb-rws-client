import { describe, it, expect } from 'vitest';
import { redactBody } from '../src/redact.js';

describe('redactBody - secret masking for trace logs', () => {
  it('masks password fields (changePassword)', () => {
    expect(redactBody('old-password=hunter2&new-password=s3cr3t'))
      .toBe('old-password=***&new-password=***');
  });

  it('masks pin, pincode and the control-station id (opmode lock, control-station register)', () => {
    expect(redactBody('pin=1234&permanent=false')).toBe('pin=***&permanent=false');
    // The station id is the identity a caller stores and registers with on
    // every run, so it stays out of traces like the PIN; the name stays.
    expect(redactBody('control-station-name=cs&control-station-id=%7B6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b%7D&pincode=9999'))
      .toBe('control-station-name=cs&control-station-id=***&pincode=***');
    expect(redactBody('control-station-id=x&release-write-access-when-lost=TRUE'))
      .toBe('control-station-id=***&release-write-access-when-lost=TRUE');
  });

  it('masks only the exact control-station-id key, not other id fields', () => {
    expect(redactBody('mastershipid=12&task-id=T_ROB1')).toBe('mastershipid=12&task-id=T_ROB1');
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
