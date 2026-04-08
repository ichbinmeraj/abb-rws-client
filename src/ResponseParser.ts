/**
 * ResponseParser — pure functions that parse RWS 1.0 XML/XHTML responses into typed objects.
 *
 * RWS returns XHTML with <li class="..."> elements containing <span class="..."> children.
 * Parsing uses regex + string methods only — no external XML libraries.
 * All functions throw RwsError('PARSE_ERROR') on malformed or missing data.
 */

import { RwsError } from './types.js';
import type {
  ControllerState,
  OperationMode,
  ExecutionState,
  JointTarget,
  RobTarget,
  Signal,
  RapidTask,
} from './types.js';

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Decode the minimum set of HTML entities that may appear in RWS span values.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Find the first <li> whose class attribute contains `liClass` as a whole word,
 * then within that block find the first <span> whose class attribute contains
 * `spanClass` as a whole word. Returns the trimmed inner text, or undefined.
 *
 * Uses the \b word boundary so 'rap-task-li' does not match 'rap-task-li-selected'.
 * The 'is' flag makes '.' match newlines and matching case-insensitive.
 */
function extractSpanValue(xml: string, liClass: string, spanClass: string): string | undefined {
  // Phase 1: find the <li> block
  const liPattern = new RegExp(
    `<li[^>]*class="[^"]*\\b${liClass}\\b[^"]*"[^>]*>(.*?)</li>`,
    'is',
  );
  const liMatch = xml.match(liPattern);
  if (!liMatch) return undefined;

  const liContent = liMatch[1];

  // Phase 2: find the <span> within that block
  const spanPattern = new RegExp(
    `<span[^>]*class="[^"]*\\b${spanClass}\\b[^"]*"[^>]*>(.*?)</span>`,
    'is',
  );
  const spanMatch = liContent.match(spanPattern);
  if (!spanMatch) return undefined;

  return decodeEntities(spanMatch[1].trim());
}

/**
 * Like extractSpanValue but searches the entire xml string for a <span> with the given class.
 * Used for flat responses that have no <li> wrapper.
 */
function extractSpanValueFlat(xml: string, spanClass: string): string | undefined {
  const spanPattern = new RegExp(
    `<span[^>]*class="[^"]*\\b${spanClass}\\b[^"]*"[^>]*>(.*?)</span>`,
    'is',
  );
  const spanMatch = xml.match(spanPattern);
  if (!spanMatch) return undefined;
  return decodeEntities(spanMatch[1].trim());
}

function requireSpan(xml: string, liClass: string, spanClass: string, context: string): string {
  const val = extractSpanValue(xml, liClass, spanClass);
  if (val === undefined || val === '') {
    throw new RwsError(
      `PARSE_ERROR: missing <span class="${spanClass}"> in <li class="${liClass}"> (${context})`,
      'PARSE_ERROR',
    );
  }
  return val;
}

function requireFloat(raw: string, field: string): number {
  const n = parseFloat(raw);
  if (isNaN(n)) {
    throw new RwsError(`PARSE_ERROR: expected float for "${field}", got "${raw}"`, 'PARSE_ERROR');
  }
  return n;
}

// ─── Public parsers ──────────────────────────────────────────────────────────

const VALID_CONTROLLER_STATES: ReadonlySet<string> = new Set([
  'init',
  'motoroff',
  'motoron',
  'guardstop',
  'emergencystop',
  'emergencystopreset',
  'sysfail',
]);

/**
 * Parse a /rw/panel/ctrlstate XML response into a ControllerState.
 * XML: <li class="rap-ctrlstate"><span class="ctrlstate">motoron</span></li>
 */
export function parseControllerState(xml: string): ControllerState {
  const raw = requireSpan(xml, 'rap-ctrlstate', 'ctrlstate', 'parseControllerState');
  if (!VALID_CONTROLLER_STATES.has(raw)) {
    throw new RwsError(`PARSE_ERROR: unknown controller state "${raw}"`, 'PARSE_ERROR');
  }
  return raw as ControllerState;
}

const VALID_OPERATION_MODES: ReadonlySet<string> = new Set(['AUTO', 'MANR', 'MANF']);

/**
 * Parse a /rw/panel/opmode XML response into an OperationMode.
 * XML: <li class="rap-opmode"><span class="opmode">AUTO</span></li>
 */
export function parseOperationMode(xml: string): OperationMode {
  const raw = requireSpan(xml, 'rap-opmode', 'opmode', 'parseOperationMode');
  // RWS may return lower-case variants; normalise to upper
  const upper = raw.toUpperCase();
  if (!VALID_OPERATION_MODES.has(upper)) {
    throw new RwsError(`PARSE_ERROR: unknown operation mode "${raw}"`, 'PARSE_ERROR');
  }
  return upper as OperationMode;
}

/**
 * Parse a /rw/rapid/execution XML response into an ExecutionState.
 * XML: <li class="rap-execution"><span class="excstate">running</span></li>
 *
 * Note: some firmware versions emit the <li> with class "rap-execution-state" — we
 * try both and also fall back to a flat span search.
 */
export function parseExecutionState(xml: string): ExecutionState {
  let raw =
    extractSpanValue(xml, 'rap-execution', 'excstate') ??
    extractSpanValue(xml, 'rap-execution-state', 'excstate') ??
    extractSpanValueFlat(xml, 'excstate');

  if (!raw) {
    throw new RwsError(
      'PARSE_ERROR: missing excstate in execution response',
      'PARSE_ERROR',
    );
  }
  raw = raw.toLowerCase();
  if (raw !== 'running' && raw !== 'stopped') {
    throw new RwsError(`PARSE_ERROR: unknown execution state "${raw}"`, 'PARSE_ERROR');
  }
  return raw as ExecutionState;
}

/**
 * Parse a /rw/mechunit/{unit}/joint-target XML response into a JointTarget.
 * XML: <li class="rap-jointtarget">
 *        <span class="rax_1">10.00</span> ... <span class="rax_6">-90.00</span>
 *      </li>
 */
export function parseJointTarget(xml: string): JointTarget {
  const axes = ['rax_1', 'rax_2', 'rax_3', 'rax_4', 'rax_5', 'rax_6'] as const;

  // Find the containing <li> block first
  const liPattern = /<li[^>]*class="[^"]*\brap-jointtarget\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const liMatch = xml.match(liPattern);
  if (!liMatch) {
    throw new RwsError('PARSE_ERROR: missing <li class="rap-jointtarget">', 'PARSE_ERROR');
  }
  const block = liMatch[1];

  const result: Partial<JointTarget> = {};
  for (const ax of axes) {
    const spanPattern = new RegExp(
      `<span[^>]*class="[^"]*\\b${ax}\\b[^"]*"[^>]*>(.*?)</span>`,
      'is',
    );
    const m = block.match(spanPattern);
    if (!m) {
      throw new RwsError(`PARSE_ERROR: missing <span class="${ax}">`, 'PARSE_ERROR');
    }
    result[ax] = requireFloat(m[1].trim(), ax);
  }
  return result as JointTarget;
}

/**
 * Parse a /rw/mechunit/{unit}/robtarget XML response into a RobTarget.
 * XML: <li class="rap-robtarget">
 *        <span class="x">...</span><span class="y">...</span>...
 *      </li>
 */
export function parseRobTarget(xml: string): RobTarget {
  const liPattern = /<li[^>]*class="[^"]*\brap-robtarget\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const liMatch = xml.match(liPattern);
  if (!liMatch) {
    throw new RwsError('PARSE_ERROR: missing <li class="rap-robtarget">', 'PARSE_ERROR');
  }
  const block = liMatch[1];

  function getField(cls: string): number {
    const spanPattern = new RegExp(
      `<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`,
      'is',
    );
    const m = block.match(spanPattern);
    if (!m) throw new RwsError(`PARSE_ERROR: missing <span class="${cls}">`, 'PARSE_ERROR');
    return requireFloat(m[1].trim(), cls);
  }

  return {
    x: getField('x'),
    y: getField('y'),
    z: getField('z'),
    q1: getField('q1'),
    q2: getField('q2'),
    q3: getField('q3'),
    q4: getField('q4'),
  };
}

/**
 * Parse a single I/O signal from a /rw/iosystem/signals/... XML response.
 * XML: <li class="ios-signal-li">
 *        <span class="name">DI_1</span>
 *        <span class="lvalue">0</span>
 *        <span class="type">DI</span>
 *      </li>
 *
 * Can also be called with a single <li> block extracted by parseSignalList.
 */
export function parseSignal(xml: string): Signal {
  const nameRaw =
    extractSpanValue(xml, 'ios-signal-li', 'name') ??
    extractSpanValueFlat(xml, 'name');
  const lvalueRaw =
    extractSpanValue(xml, 'ios-signal-li', 'lvalue') ??
    extractSpanValueFlat(xml, 'lvalue');
  const typeRaw =
    extractSpanValue(xml, 'ios-signal-li', 'type') ??
    extractSpanValueFlat(xml, 'type');

  if (!nameRaw) throw new RwsError('PARSE_ERROR: missing signal name', 'PARSE_ERROR');
  if (lvalueRaw === undefined) throw new RwsError('PARSE_ERROR: missing signal lvalue', 'PARSE_ERROR');
  if (!typeRaw) throw new RwsError('PARSE_ERROR: missing signal type', 'PARSE_ERROR');

  const validTypes = new Set(['DI', 'DO', 'AI', 'AO', 'GI', 'GO']);
  if (!validTypes.has(typeRaw)) {
    throw new RwsError(`PARSE_ERROR: unknown signal type "${typeRaw}"`, 'PARSE_ERROR');
  }

  return {
    name: nameRaw,
    value: lvalueRaw,
    type: typeRaw as Signal['type'],
    lvalue: lvalueRaw,
  };
}

/**
 * Parse a list of I/O signals from a /rw/iosystem/signals XML response.
 * Extracts every <li class="ios-signal-li"> block and calls parseSignal on each.
 */
export function parseSignalList(xml: string): Signal[] {
  const blocks = [
    ...xml.matchAll(/<li[^>]*class="[^"]*\bios-signal-li\b[^"]*"[^>]*>.*?<\/li>/gis),
  ];
  return blocks.map(([block]) => parseSignal(block));
}

/**
 * Parse a /rw/rapid/tasks XML response into an array of RapidTask objects.
 * XML: multiple <li class="rap-task-li"> elements.
 */
export function parseRapidTasks(xml: string): RapidTask[] {
  const blocks = [
    ...xml.matchAll(/<li[^>]*class="[^"]*\brap-task-li\b[^"]*"[^>]*>.*?<\/li>/gis),
  ];

  if (blocks.length === 0) {
    throw new RwsError('PARSE_ERROR: no <li class="rap-task-li"> found', 'PARSE_ERROR');
  }

  return blocks.map(([block]) => {
    function getSpan(cls: string): string {
      const m = block.match(
        new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'),
      );
      return m ? decodeEntities(m[1].trim()) : '';
    }

    const name = getSpan('name');
    if (!name) throw new RwsError('PARSE_ERROR: RAPID task missing name', 'PARSE_ERROR');

    const excstateRaw = getSpan('excstate').toLowerCase();
    if (excstateRaw !== 'running' && excstateRaw !== 'stopped') {
      throw new RwsError(
        `PARSE_ERROR: unknown excstate "${excstateRaw}" in task "${name}"`,
        'PARSE_ERROR',
      );
    }

    return {
      name,
      type: getSpan('type'),
      taskstate: getSpan('taskstate'),
      excstate: excstateRaw as ExecutionState,
      active: getSpan('active').toLowerCase() === 'true',
      motiontask: getSpan('motiontask').toLowerCase() === 'true',
    };
  });
}

/**
 * Extract the subscription ID from a Location header value returned by POST /subscription.
 *
 * The caller should pass the raw Location header string, e.g.:
 *   'http://192.168.125.1/subscription/1'
 * Returns '1'.
 *
 * If passed full XML instead (some firmware versions put the ID in the body),
 * the function also tries to extract a numeric trailing path segment.
 */
export function parseSubscriptionId(locationOrXml: string): string {
  // Try to extract from a URL path like http://host/subscription/42
  const urlMatch = locationOrXml.match(/\/subscription\/(\d+)/);
  if (urlMatch) return urlMatch[1];

  // Fallback: look for a self-link in the XML body
  const hrefMatch = locationOrXml.match(/href="[^"]*\/subscription\/(\d+)"/i);
  if (hrefMatch) return hrefMatch[1];

  throw new RwsError(
    `PARSE_ERROR: cannot extract subscription ID from "${locationOrXml}"`,
    'PARSE_ERROR',
  );
}
