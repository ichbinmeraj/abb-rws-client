/**
 * The requests a log file records, for scripts/evidence-index.mjs. Four line
 * shapes are read:
 *
 * - functional-test traces: `{ cat: 'http.res', data: { protocol, method, path, status } }`;
 * - broker logs with a `wire` list: `{ wire: [{ m, p, status, reqBody? }] }`;
 * - one request per line: `{ method, path, status, reqBody? }`;
 * - hand-probe logs: `{ req: 'POST /rw/...', body?, status }`, after a
 *   `{ step: 'start', label: '<RobotWare version> <system>' }` line that names
 *   the build (RobotWare 6 is RWS 1.0; 7 and 8 are RWS 2.0). A `req` that is
 *   not a method and a path (`GET lock-state`) is a probe step, not a request.
 *
 * Each request comes back as `{ gen, method, url, status, body, source }`;
 * `gen` is null when nothing in the line or the file names it.
 *
 * `requestsFromTextTrace` reads the client's text trace instead (see there).
 */
import { sep } from 'node:path';

/**
 * The requests a text trace records: the client's trace lines
 * (`<time> trace http.res RWS1 POST /users/rmmp?json=1 → 202 {"protocol":"rws1",...}`),
 * one per line in a trace file, or each one a JSON string in a run's result
 * file. Only `http.res` lines are read, from the JSON object at their end
 * (protocol, method, path, status); a line without that object is skipped.
 * No request body is kept, as for the JSON trace lines.
 */
export function requestsFromTextTrace(text, source) {
  const out = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line.includes('http.res')) { continue; }
    if (line.startsWith('"')) {
      try { line = JSON.parse(line.replace(/,$/, '')); } catch { continue; }
      if (typeof line !== 'string') { continue; }
    }
    const at = line.indexOf(' http.res ');
    const brace = at < 0 ? -1 : line.indexOf('{', at);
    if (brace < 0) { continue; }
    let d;
    try { d = JSON.parse(line.slice(brace)); } catch { continue; }
    if ((d.protocol === 'rws1' || d.protocol === 'rws2') && typeof d.method === 'string'
      && typeof d.path === 'string' && typeof d.status === 'number') {
      out.push({ gen: d.protocol, method: d.method, url: d.path, status: d.status, body: null, source });
    }
  }
  return out;
}

/** The generation a log line belongs to: its own field, its headers, else its file's path. */
export function generationOf(j, file) {
  if (j.gen === 'rws1' || j.gen === 'rws2') { return j.gen; }
  const hdr = JSON.stringify([j.reqHeaders ?? null, j.accept ?? null]);
  if (/v=2\.0|hal\+json/.test(hdr)) { return 'rws2'; }
  if (/v=1\.0|Digest/.test(hdr)) { return 'rws1'; }
  const parts = file.split(sep).join('/').toLowerCase();
  const base = parts.slice(parts.lastIndexOf('/') + 1);
  if (/rw6|irc5|rws1/.test(base)) { return 'rws1'; }
  if (/rw7|rw8|rws2/.test(base)) { return 'rws2'; }
  if (/rws1|rw6/.test(parts)) { return 'rws1'; }
  if (/rws2|rw7|rw8/.test(parts)) { return 'rws2'; }
  return null;
}

/** A logged request body, when the line has one (never a response body). */
export function requestBody(j) {
  if (typeof j.reqBody === 'string') { return j.reqBody; }
  if (typeof j.body === 'string' && /^[\w-]+=/.test(j.body) && !/[{<]/.test(j.body)) { return j.body; }
  return null;
}

/** The generation a `start` line's RobotWare label names, else null. */
function generationOfLabel(label) {
  const m = /^(\d+)\.\d+/.exec(typeof label === 'string' ? label : '');
  if (m === null) { return null; }
  if (m[1] === '6') { return 'rws1'; }
  if (m[1] === '7' || m[1] === '8') { return 'rws2'; }
  return null;
}

/** Every request one log file's text records, in order. */
export function requestsFromLog(text, file, source) {
  const out = [];
  let labelGen = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) { continue; }
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.cat === 'http.res' && j.data) {
      out.push({ gen: j.data.protocol, method: j.data.method, url: j.data.path, status: j.data.status, body: null, source });
      continue;
    }
    if (Array.isArray(j.wire)) {
      const gen = generationOf(j, file);
      for (const w of j.wire) { out.push({ gen, method: w.m, url: w.p, status: w.status, body: requestBody(w), source }); }
      continue;
    }
    if (typeof j.method === 'string' && typeof j.path === 'string' && typeof j.status === 'number') {
      out.push({ gen: generationOf(j, file), method: j.method, url: j.path, status: j.status, body: requestBody(j), source });
      continue;
    }
    if (j.step === 'start' && j.label !== undefined) { labelGen = generationOfLabel(j.label); continue; }
    if (typeof j.req === 'string' && typeof j.status === 'number') {
      const m = /^([A-Z]+) (\/\S*)$/.exec(j.req);
      if (m === null) { continue; }
      out.push({ gen: generationOf(j, file) ?? labelGen, method: m[1], url: m[2], status: j.status, body: requestBody(j), source });
    }
  }
  return out;
}
