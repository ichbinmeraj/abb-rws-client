/**
 * Pluggable logger interface used by RobotManager, MultiRobotManager, and
 * both protocol clients (HTTP req/res tracing flows through here too).
 *
 * The lib ships with a no-op default. Hosts (e.g. the VS Code extension) can
 * install their own backend by calling `setLogger(myImpl)`. The extension
 * routes log lines into a VS Code output channel AND a persistent file; a
 * CLI might just `console.log`.
 *
 * Methods:
 *   - info(msg):                   lifecycle events (connect/disconnect/poll)
 *   - warn(msg):                   recoverable issues (subscription fallback)
 *   - error(msg, err?):            failures the user needs to see
 *   - trace(category, msg, data?): structured debug lines (HTTP req/res, WS frames,
 *                                  command dispatches). Optional — implementers can
 *                                  ignore for terse output. Categories used by the
 *                                  lib: 'http.req', 'http.res', 'http.err', 'ws',
 *                                  'subscription', 'mastership'.
 *   - show():                      bring the log surface to the front
 */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
  trace?(category: string, msg: string, data?: unknown): void;
  show(): void;
}

const noopLogger: Logger = {
  info()  { /* no-op */ },
  warn()  { /* no-op */ },
  error() { /* no-op */ },
  trace() { /* no-op */ },
  show()  { /* no-op */ },
};

let activeLogger: Logger = noopLogger;

/** Install a custom logger. Call once at startup; subsequent calls replace it. */
export function setLogger(impl: Logger): void {
  activeLogger = impl;
}

/**
 * Internal accessor used throughout the lib. Goes through getters so a later
 * `setLogger()` call takes effect for code that imported `Logger` earlier.
 */
export const Logger: Logger = {
  info(msg)               { activeLogger.info(msg); },
  warn(msg)               { activeLogger.warn(msg); },
  error(msg, err)         { activeLogger.error(msg, err); },
  trace(category, msg, d) { activeLogger.trace?.(category, msg, d); },
  show()                  { activeLogger.show(); },
};
