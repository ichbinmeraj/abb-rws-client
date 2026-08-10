/**
 * Redact secret values from a form-urlencoded request body before it is handed
 * to a trace logger.
 *
 * RWS write bodies are `application/x-www-form-urlencoded`, and a few carry
 * secrets: changePassword (`old-password` / `new-password`), control-station
 * registration (`pincode`), and operation-mode lock (`pin`). The transport
 * traces every request body (first 200 chars) into the logger's structured
 * `data`, and a host that persists trace output to disk (the RAPID Live VS Code
 * extension writes a log file) would otherwise store these in cleartext at rest,
 * where they ride along in shared support/bug-report logs.
 *
 * Only the VALUE of a key whose NAME is a secret is masked; every other field is
 * preserved so traces stay useful. Matching is on the key, anchored to `-`/`_`
 * or string ends, so enum VALUES that merely contain a substring (`execmode=
 * stepin`, an LDAP `searchpassword` class) are never touched.
 */
const SECRET_KEY = /(^|[-_])(pin|pincode|passcode|password|secret|token|credential|apikey|api-key)([-_]|$)/i;

export function redactBody(body: string | undefined): string | undefined {
  if (!body) { return body; }
  // Only touch things that look like form-urlencoded `key=value&...` bodies.
  if (!body.includes('=')) { return body; }
  return body.replace(/([^&=]+)=([^&]*)/g, (whole, key: string, _value: string) => {
    let name = key;
    try { name = decodeURIComponent(key); } catch { /* keep raw key on malformed % */ }
    return SECRET_KEY.test(name) ? `${key}=***` : whole;
  });
}
