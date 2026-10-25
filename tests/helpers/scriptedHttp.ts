/**
 * A local HTTP server that answers from a script, for the RWS 1.0 transport
 * tests. HttpSession sends through fetch or, on a port fetch refuses, through
 * node:http; a stubbed global fetch would reach only the first, and a real
 * server takes both, on the wire as a controller sees them.
 *
 * `once(...)` queues answers taken one per request, in order, like a mock's
 * `mockResolvedValueOnce`; `always(...)` (or `alwaysBy(...)`, chosen per
 * request) answers every request after the queue runs out, like
 * `mockImplementation`. A request with neither gets a 599, so a
 * test that sends more than it scripted fails visibly. Every request is
 * recorded (method, path, headers, body bytes, which connection carried it).
 *
 * Test infrastructure only - never shipped in the package.
 */
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { FETCH_BAD_PORTS } from '../../src/badPorts.js';
import { listenOnRefusedPort } from './refusedPorts.js';

/**
 * Listen on 127.0.0.1 and return the port. `port` 0 takes a free port that
 * fetch accepts: the operating system picks free ports from its dynamic
 * range, which starts at 1024 on some Windows machines (1024-15000 on the
 * development PC, 2026-10-23) and so holds bad ports such as 1720, 5060,
 * 6000 or 10080. A session on one of those goes through node:http instead
 * of fetch (src/badPorts.ts), so a test that meant a plain port would test
 * the other path now and then; such a port is let go and another taken. A
 * fixed port is taken as it is, and one that is taken rejects with the
 * listen error. `'fetch-refused'` takes the first free port of the ones
 * fetch refuses (tests/helpers/refusedPorts.ts), and rejects, naming them,
 * when none is free.
 */
export async function listenOnPort(server: http.Server, port: number | 'fetch-refused' = 0): Promise<number> {
  if (port === 'fetch-refused') { return listenOnRefusedPort(server); }
  const listen = (p: number): Promise<number> => new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
  if (port !== 0) { return listen(port); }
  for (let tries = 0; ; tries += 1) {
    const bound = await listen(0);
    if (!FETCH_BAD_PORTS.has(bound) || tries >= 50) { return bound; }
    await new Promise<void>(r => server.close(() => r()));
  }
}

export interface RecordedRequest {
  method: string;
  /** Path and query as sent. */
  path: string;
  /** Node's lower-cased request headers. */
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** 1 for the first connection the server accepted, 2 for the next, ... */
  connection: number;
  /** Date.now() when the request arrived. */
  at: number;
}

/**
 * One scripted answer: a status with optional body and headers (an array
 * value sends that header once per entry, as Set-Cookie needs), 'destroy' to
 * drop the connection without answering, or a function that answers by hand.
 */
export type Answer =
  | { status: number; body?: string; headers?: Record<string, string | string[]> }
  | 'destroy'
  | ((req: http.IncomingMessage, res: http.ServerResponse, recorded: RecordedRequest) => void);

export interface ScriptedServer {
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  /** Connections accepted so far. */
  readonly connections: number;
  /** Connections accepted and still open. */
  readonly openConnections: number;
  once(...answers: Answer[]): ScriptedServer;
  always(answer: Answer): ScriptedServer;
  /** Like always(), choosing the answer per request. */
  alwaysBy(choose: (recorded: RecordedRequest) => Answer): ScriptedServer;
  close(): Promise<void>;
}

/** Shorthand for `{ status, body, headers }`. */
export const answer = (
  status: number, body = '', headers: Record<string, string | string[]> = {},
): Answer => ({ status, body, headers });

/**
 * Start a scripted server on 127.0.0.1. `port` 0 (the default) takes a free
 * port that fetch accepts (see listenOnPort); a fixed port that is taken
 * rejects with the listen error; `'fetch-refused'` takes a free port that
 * fetch refuses, so the session under test sends through node:http.
 */
export async function scriptedServer(port: number | 'fetch-refused' = 0): Promise<ScriptedServer> {
  const queue: Answer[] = [];
  let fallback: ((recorded: RecordedRequest) => Answer) | undefined;
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const connectionIds = new WeakMap<Socket, number>();
  let accepted = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
        connection: connectionIds.get(req.socket) ?? 0,
        at: Date.now(),
      };
      requests.push(recorded);
      const next = queue.length > 0 ? queue.shift()! : fallback?.(recorded);
      if (next === undefined) {
        res.writeHead(599, { 'Content-Type': 'text/plain' });
        res.end(`no scripted answer for ${recorded.method} ${recorded.path}`);
        return;
      }
      if (next === 'destroy') { req.socket.destroy(); return; }
      if (typeof next === 'function') { next(req, res, recorded); return; }
      const body = next.status === 204 || next.status === 304 ? '' : (next.body ?? '');
      const headers: http.OutgoingHttpHeaders = { ...(next.headers ?? {}) };
      if (body.length > 0 && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/xhtml+xml';
      }
      res.writeHead(next.status, headers);
      res.end(body);
    });
  });
  server.on('connection', (s: Socket) => {
    accepted += 1;
    connectionIds.set(s, accepted);
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  const bound = await listenOnPort(server, port);

  const api: ScriptedServer = {
    port: bound,
    baseUrl: `http://127.0.0.1:${bound}`,
    requests,
    get connections() { return accepted; },
    get openConnections() { return sockets.size; },
    once(...answers: Answer[]) { queue.push(...answers); return api; },
    always(a: Answer) { fallback = () => a; return api; },
    alwaysBy(choose) { fallback = choose; return api; },
    async close() {
      for (const s of sockets) { s.destroy(); }
      await new Promise<void>(r => server.close(() => r()));
    },
  };
  return api;
}
