/**
 * The single discovery probe: one unauthenticated `GET /rw/system` on one (host, port, scheme).
 *
 * Every discovery path sends exactly this request and nothing else before a login:
 * `Accept: application/xhtml+xml;v=2.0`, `User-Agent: abb-rws-client/<version> discovery`
 * and `Connection: close`, plus the TLS handshake on HTTPS. No credentials are ever sent here.
 *
 * The socket is opened by hand (TCP first, then TLS on top) so the outcome can tell apart
 * "nothing listens" (`refused`), "the port is open but does not speak TLS" (`tls-failed`, the
 * signal for trying plain HTTP on a remote host), "the port is open but did not answer the TLS
 * handshake" (`tls-timeout`, the same signal: a plain-HTTP server waits silently for its request
 * line) and "the certificate failed verification under strictTls" (`tls-unverified`, checked
 * before any HTTP byte is sent).
 *
 * The request is written on that same socket by hand, and the answer's status line and headers
 * are read from it by hand, never through `http.request`. A host can give every `http.request`
 * an agent of its own: the VS Code extension host does by default (`http.proxySupport`), and Node
 * then sends the request through that agent and ignores a socket handed in as `createConnection`.
 * The request went out as plain HTTP on a second connection, so every RWS 2.0 controller (HTTPS)
 * looked like "not RWS" inside VS Code, while plain Node found them (seen 2026-10-06 with five VCs).
 *
 * Observed 2026-10-03 on RobotStudio VCs RW 6.16.03, 7.21.0, 7.21.4, 8.1.1 and 8.2.1 over
 * loopback: RW 6 answers `401` with `Digest realm="validusers@robapi.abb"` over HTTP, RW 7 and
 * RW 8 answer `401` with `Basic realm="validusers@robapi.abb"` over HTTPS with a self-signed
 * certificate for 127.0.0.1, and no unauthenticated answer sets a cookie, so a probe owes no
 * `/logout`. The realm of a real controller is not verified here, so a Digest or Basic 401 with
 * another realm is still reported (`other-401`) instead of dropped.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import { buildPath, type PathSpec } from '../paths/index.js';
import { SYSTEM_MASTERSHIP } from '../paths/systemMastership.js';
import { Logger } from '../Logger.js';
import { CLIENT_VERSION } from '../version.js';
import { strictTlsCaOption } from '../tlsTrust.js';
import type { ProbeOptions, ProbeOutcome } from './types.js';

/** The realm every RobotStudio VC sends in its 401 (RW 6.16.03 to 8.2.1, observed 2026-10-03). */
export const RWS_REALM = 'validusers@robapi.abb';

/** `GET /rw/system`, the same row for both generations, from the path table. */
const PROBE_PATH = buildPath(SYSTEM_MASTERSHIP.getSystemInfo.rws2 as PathSpec);

/** The Accept header every probe sends (the RWS 2.0 media type; RWS 1.0 answers 401 regardless). */
const PROBE_ACCEPT = 'application/xhtml+xml;v=2.0';

/**
 * `abb-rws-client/<version> discovery`, so a network administrator can trace a probe to this
 * client. The version is fixed at build time (`src/version.ts`, written from `package.json`), so
 * a bundle with no `package.json` next to the module, such as the VS Code extension's, sends it
 * too.
 */
export function defaultUserAgent(): string {
  return `abb-rws-client/${CLIENT_VERSION} discovery`;
}

/** One parsed `Digest` or `Basic` challenge. */
interface Challenge {
  authType: 'digest' | 'basic';
  realm?: string;
}

const REALM_RE = /(?:^|[\s,])realm\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/i;
const SCHEME_AT_START_RE = /^\s*(digest|basic)(?=\s|,|$)/i;
const SCHEME_LATER_RE = /,\s*(digest|basic)(?=\s|,|$)/gi;

/**
 * Every `Digest` or `Basic` challenge in the `WWW-Authenticate` values of one answer, in order.
 * The scheme token is matched case-insensitively (RFC 7235); the realm is unquoted and unescaped.
 * Other schemes (Bearer, Negotiate, ...) are skipped.
 */
export function parseChallenges(values: readonly string[]): Challenge[] {
  const out: Challenge[] = [];
  for (const value of values) {
    const starts: Array<{ at: number; scheme: string }> = [];
    const first = SCHEME_AT_START_RE.exec(value);
    if (first) starts.push({ at: first.index + first[0].length, scheme: first[1] });
    SCHEME_LATER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SCHEME_LATER_RE.exec(value)) !== null) {
      starts.push({ at: m.index + m[0].length, scheme: m[1] });
    }
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1].at : value.length;
      const params = value.slice(starts[i].at, end);
      const r = REALM_RE.exec(params);
      const realm = r ? (r[1] !== undefined ? r[1].replace(/\\(.)/g, '$1') : r[2]) : undefined;
      out.push({
        authType: starts[i].scheme.toLowerCase() === 'digest' ? 'digest' : 'basic',
        ...(realm !== undefined ? { realm } : {}),
      });
    }
  }
  return out;
}

/**
 * Classify one HTTP answer. Pure.
 * @param status HTTP status code.
 * @param authValues each `WWW-Authenticate` header value as received, in order.
 * @param tlsFingerprint SHA-256 of the leaf certificate, HTTPS only.
 */
export function classifyAnswer(status: number | undefined, authValues: readonly string[], tlsFingerprint?: string): ProbeOutcome {
  if (status !== 401) return { kind: 'not-rws' };
  const challenges = parseChallenges(authValues);
  if (challenges.length === 0) return { kind: 'not-rws' };
  const challenge = authValues.join(', ');
  const fp = tlsFingerprint !== undefined ? { tlsFingerprint } : {};
  const rws = challenges.find(c => c.realm === RWS_REALM);
  if (rws) return { kind: 'rws', authType: rws.authType, realm: RWS_REALM, ...fp, challenge };
  const c = challenges[0];
  return { kind: 'other-401', authType: c.authType, ...(c.realm !== undefined ? { realm: c.realm } : {}), ...fp, challenge };
}

/**
 * Map an outcome to the legacy `RobotManager` probe result, with the legacy rule unchanged: any
 * 401 whose `WWW-Authenticate` value starts with `Digest` or `Basic` (case-sensitive, realm not
 * checked) is a hit; everything else is `null`.
 */
export function toLegacyProbeResult(
  port: number, useHttps: boolean, outcome: ProbeOutcome,
): { port: number; useHttps: boolean; authType: 'digest' | 'basic' } | null {
  if (outcome.kind !== 'rws' && outcome.kind !== 'other-401') return null;
  const value = outcome.challenge ?? '';
  if (value.startsWith('Digest')) return { port, useHttps, authType: 'digest' };
  if (value.startsWith('Basic')) return { port, useHttps, authType: 'basic' };
  return null;
}

/** Normalise a SHA-256 fingerprint for comparison: hex digits only, upper case. */
export function normaliseFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/** true when both fingerprints are present and name the same certificate (separators and case ignored). */
export function sameFingerprint(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = normaliseFingerprint(a);
  return x.length > 0 && x === normaliseFingerprint(b);
}

/** An answer whose status line and headers run longer than this is not an RWS 401. */
export const MAX_ANSWER_HEAD_BYTES = 16 * 1024;

/** How every HTTP/1.x status line starts. */
const HTTP_1_PREFIX = 'HTTP/1.';

/** Any control character, which cannot appear in a request line or a header value. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * The probe request as sent: `GET /rw/system HTTP/1.1` with `Host`, `Accept`, `User-Agent` (none
 * for an empty string) and `Connection: close`. The port is left out of `Host` when it is the
 * scheme's default; an IPv6 literal is bracketed. Undefined when the host or the User-Agent holds
 * a control character, so no request can be built from them.
 */
export function probeRequest(host: string, port: number, https: boolean, userAgent: string): string | undefined {
  if (CONTROL_RE.test(host) || CONTROL_RE.test(userAgent)) return undefined;
  const name = net.isIP(host) === 6 ? `[${host}]` : host;
  const lines = [
    `GET ${PROBE_PATH} HTTP/1.1`,
    `Host: ${port === (https ? 443 : 80) ? name : `${name}:${port}`}`,
    `Accept: ${PROBE_ACCEPT}`,
  ];
  if (userAgent !== '') lines.push(`User-Agent: ${userAgent}`);
  lines.push('Connection: close', '', '');
  return lines.join('\r\n');
}

/**
 * The status code and every `WWW-Authenticate` value (in order, trimmed) of an answer's head: the
 * status line and the header lines, without the blank line that ends them. Lines may end in CRLF
 * or a bare LF. Undefined when the status line is not HTTP/1.x.
 */
export function parseAnswerHead(head: string): { status: number; authValues: string[] } | undefined {
  const lines = head.split(/\r?\n/);
  const m = /^HTTP\/1\.\d (\d{3})(?: |$)/.exec(lines[0]);
  if (!m) return undefined;
  const authValues: string[] = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === 'www-authenticate') {
      authValues.push(line.slice(colon + 1).trim());
    }
  }
  return { status: Number(m[1]), authValues };
}

/**
 * Probe one (host, port, scheme) with one unauthenticated `GET /rw/system`. Never rejects.
 *
 * - `host` should be an IP literal (names are resolved by the caller, IPv4 first). An IPv6
 *   literal connects over IPv6; anything else is connected over IPv4 only (`family: 4`).
 * - HTTPS: the socket is opened without certificate verification, the leaf certificate's SHA-256
 *   is recorded, and under `strictTls` the request is sent only when the certificate verified
 *   (chain and host name) against the authorities the client's requests trust (tlsTrust.ts);
 *   otherwise the outcome is `tls-unverified` and no HTTP byte is sent.
 * - `timeoutMs` covers connect, handshake and the answer's headers together.
 * - `signal`: an already aborted signal opens no socket. An abort in flight destroys the socket.
 * - The promise settles only after the socket has closed, so a caller that awaits every probe
 *   knows no socket is left open.
 */
export function probeOne(host: string, port: number, https: boolean, opts: ProbeOptions): Promise<ProbeOutcome> {
  const label = `${host}:${port}/${https ? 'https' : 'http'}`;
  return new Promise<ProbeOutcome>(resolve => {
    const { signal } = opts;
    if (signal?.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }

    let settled = false;
    let tcpConnected = false;
    let tlsDone = false;
    let raw: net.Socket | undefined;
    let secure: tls.TLSSocket | undefined;
    let fingerprint: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => finish({ kind: 'aborted' });

    function finish(outcome: ProbeOutcome): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      Logger.trace?.('discovery', `probe ${label}: ${outcome.kind}`);
      secure?.destroy();
      const sock = raw;
      if (!sock || sock.closed) {
        resolve(outcome);
        return;
      }
      sock.once('close', () => resolve(outcome));
      sock.destroy();
    }

    /** An error or close after TCP connected: a failed handshake, or an answer that is not HTTP. */
    function failAfterConnect(): void {
      finish(https && !tlsDone ? { kind: 'tls-failed' } : { kind: 'not-rws' });
    }

    /** Write the GET on `sock` (the TCP socket, or the TLS socket on it) and read the answer's head. */
    function sendGet(sock: net.Socket): void {
      const request = probeRequest(host, port, https, opts.userAgent ?? defaultUserAgent());
      if (request === undefined) {
        failAfterConnect();
        return;
      }
      // latin1 maps each byte to one character, so a head split across chunks joins unchanged.
      let head = '';
      sock.on('data', (chunk: Buffer) => {
        if (settled) return;
        head += chunk.toString('latin1');
        for (;;) {
          // Empty lines before a status line are skipped, as Node's own parser does.
          head = head.replace(/^(?:\r?\n)+/, '');
          // An answer whose first bytes already differ from "HTTP/1." is not HTTP: no need to wait.
          if (!HTTP_1_PREFIX.startsWith(head.slice(0, HTTP_1_PREFIX.length))) {
            finish({ kind: 'not-rws' });
            return;
          }
          const blank = /\r?\n\r?\n/.exec(head);
          const length = blank ? blank.index : head.length;
          if (length > MAX_ANSWER_HEAD_BYTES) {
            finish({ kind: 'not-rws' });
            return;
          }
          if (!blank) return;
          const answer = parseAnswerHead(head.slice(0, blank.index));
          if (answer && answer.status >= 100 && answer.status < 200 && answer.status !== 101) {
            // An interim answer (100 Continue, 103 Early Hints) comes before the final one: read on.
            head = head.slice(blank.index + blank[0].length);
            continue;
          }
          // The answer is in the head; the body is never read.
          finish(answer ? classifyAnswer(answer.status, answer.authValues, fingerprint) : { kind: 'not-rws' });
          return;
        }
      });
      sock.write(request, 'latin1');
    }

    function startTls(sock: net.Socket): void {
      // Under strictTls the certificate is checked against the same authorities
      // as the client's requests (tlsTrust.ts), not only Node's default ones.
      const tlsOpts: tls.ConnectionOptions = {
        socket: sock, host, rejectUnauthorized: false, ...(opts.strictTls ? strictTlsCaOption() : {}),
      };
      // SNI carries host names only, never an IP literal (RFC 6066).
      if (net.isIP(host) === 0) tlsOpts.servername = host;
      try {
        secure = tls.connect(tlsOpts);
      } catch {
        failAfterConnect();
        return;
      }
      const s = secure;
      s.on('error', () => { if (!settled) failAfterConnect(); });
      s.once('secureConnect', () => {
        if (settled) return;
        tlsDone = true;
        const cert = s.getPeerCertificate();
        fingerprint = cert && typeof cert.fingerprint256 === 'string' && cert.fingerprint256 !== ''
          ? cert.fingerprint256 : undefined;
        if (opts.strictTls && !s.authorized) {
          const error = s.authorizationError ? String(s.authorizationError) : 'certificate not verified';
          finish({ kind: 'tls-unverified', ...(fingerprint !== undefined ? { fingerprint } : {}), error });
          return;
        }
        sendGet(s);
      });
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    // A port that accepted TCP and then said nothing to the TLS ClientHello is told apart from a
    // silent connect: a plain-HTTP server waiting for its request line does exactly that (the
    // RW 6.16.03 VC, observed 2026-10-03), so a caller can still try plain HTTP there.
    timer = setTimeout(
      () => finish(https && tcpConnected && !tlsDone ? { kind: 'tls-timeout' } : { kind: 'timeout' }),
      opts.timeoutMs,
    );

    try {
      raw = net.connect({ host, port, family: net.isIP(host) === 6 ? 6 : 4 });
    } catch {
      // A port outside 0-65535 throws synchronously: nothing can answer there.
      finish({ kind: 'refused' });
      return;
    }
    const sock = raw;
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (!tcpConnected) finish(err.code === 'ETIMEDOUT' ? { kind: 'timeout' } : { kind: 'refused' });
      else failAfterConnect();
    });
    sock.once('close', () => {
      if (settled) return;
      if (!tcpConnected) finish({ kind: 'refused' });
      else failAfterConnect();
    });
    sock.once('connect', () => {
      // A host can defer the connect (the VS Code extension host does while it loads system
      // certificates), so it may complete after the probe already ended: close it, send nothing.
      if (settled) {
        sock.destroy();
        return;
      }
      tcpConnected = true;
      if (https) startTls(sock);
      else sendGet(sock);
    });
  });
}
