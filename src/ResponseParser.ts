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
  ExecutionInfo,
  JointTarget,
  RobTarget,
  CartesianFull,
  Signal,
  RapidTask,
  IoNetwork,
  IoDevice,
  SystemInfo,
  ControllerIdentity,
  ElogMessage,
  FileEntry,
  CollisionDetectionState,
  RapidSymbolProperties,
  ControllerClock,
  UiInstruction,
  RapidSymbolInfo,
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
 * XML: <li class="pnl-ctrlstate"><span class="ctrlstate">motoron</span></li>
 */
export function parseControllerState(xml: string): ControllerState {
  const raw = requireSpan(xml, 'pnl-ctrlstate', 'ctrlstate', 'parseControllerState');
  if (!VALID_CONTROLLER_STATES.has(raw)) {
    throw new RwsError(`PARSE_ERROR: unknown controller state "${raw}"`, 'PARSE_ERROR');
  }
  return raw as ControllerState;
}

const VALID_OPERATION_MODES: ReadonlySet<string> = new Set(['AUTO', 'MANR', 'MANF']);

/**
 * Parse a /rw/panel/opmode XML response into an OperationMode.
 * XML: <li class="pnl-opmode"><span class="opmode">AUTO</span></li>
 */
export function parseOperationMode(xml: string): OperationMode {
  const raw = requireSpan(xml, 'pnl-opmode', 'opmode', 'parseOperationMode');
  // RWS may return lower-case variants; normalise to upper
  const upper = raw.toUpperCase();
  if (!VALID_OPERATION_MODES.has(upper)) {
    throw new RwsError(`PARSE_ERROR: unknown operation mode "${raw}"`, 'PARSE_ERROR');
  }
  return upper as OperationMode;
}

/**
 * Parse a /rw/rapid/execution XML response into an ExecutionState.
 * XML: <li class="rap-execution"><span class="ctrlexecstate">stopped</span><span class="cycle">forever</span></li>
 *
 * Note: some firmware versions emit the <li> with class "rap-execution-state" — we
 * try both and also fall back to a flat span search.
 */
export function parseExecutionState(xml: string): ExecutionState {
  return parseExecutionInfo(xml).state;
}

/**
 * Parse a /rw/rapid/execution XML response into ExecutionInfo (state + cycle).
 */
export function parseExecutionInfo(xml: string): ExecutionInfo {
  let raw =
    extractSpanValue(xml, 'rap-execution', 'ctrlexecstate') ??
    extractSpanValue(xml, 'rap-execution', 'excstate') ??
    extractSpanValue(xml, 'rap-execution-state', 'ctrlexecstate') ??
    extractSpanValue(xml, 'rap-execution-state', 'excstate') ??
    extractSpanValueFlat(xml, 'ctrlexecstate') ??
    extractSpanValueFlat(xml, 'excstate');

  if (!raw) {
    throw new RwsError(
      'PARSE_ERROR: missing ctrlexecstate/excstate in execution response',
      'PARSE_ERROR',
    );
  }
  raw = raw.toLowerCase();
  if (raw === 'stop') raw = 'stopped';
  if (raw !== 'running' && raw !== 'stopped') {
    throw new RwsError(`PARSE_ERROR: unknown execution state "${raw}"`, 'PARSE_ERROR');
  }

  const cycle =
    extractSpanValue(xml, 'rap-execution', 'cycle') ??
    extractSpanValue(xml, 'rap-execution-state', 'cycle') ??
    extractSpanValueFlat(xml, 'cycle') ??
    'asis';

  return { state: raw as ExecutionState, cycle };
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
  const liPattern = /<li[^>]*class="[^"]*\bms-jointtarget\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const liMatch = xml.match(liPattern);
  if (!liMatch) {
    throw new RwsError('PARSE_ERROR: missing <li class="ms-jointtarget">', 'PARSE_ERROR');
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
  const liPattern = /<li[^>]*class="[^"]*\bms-robtargets\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const liMatch = xml.match(liPattern);
  if (!liMatch) {
    throw new RwsError('PARSE_ERROR: missing <li class="ms-robtargets">', 'PARSE_ERROR');
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
  // Individual signal endpoint returns <li class="ios-signal">
  // Signal list endpoint returns <li class="ios-signal-li">
  const nameRaw =
    extractSpanValue(xml, 'ios-signal', 'name') ??
    extractSpanValue(xml, 'ios-signal-li', 'name') ??
    extractSpanValueFlat(xml, 'name');
  const lvalueRaw =
    extractSpanValue(xml, 'ios-signal', 'lvalue') ??
    extractSpanValue(xml, 'ios-signal-li', 'lvalue') ??
    extractSpanValueFlat(xml, 'lvalue');
  const typeRaw =
    extractSpanValue(xml, 'ios-signal', 'type') ??
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

    let excstateRaw = getSpan('excstate').toLowerCase();
    // Normalise known variants
    if (excstateRaw === 'stop') excstateRaw = 'stopped';
    if (excstateRaw === 'read') excstateRaw = 'stopped'; // 'read' = ready/idle on some firmware
    // Treat any unrecognised state as 'stopped' so fetchAll never crashes
    if (excstateRaw !== 'running' && excstateRaw !== 'stopped') {
      excstateRaw = 'stopped';
    }

    // 'active' may be 'On'/'Off' or 'true'/'false' depending on firmware version
    const activeRaw = getSpan('active').toLowerCase();
    const active = activeRaw === 'true' || activeRaw === 'on';

    return {
      name,
      type: getSpan('type'),
      taskstate: getSpan('taskstate'),
      excstate: excstateRaw as ExecutionState,
      active,
      motiontask: getSpan('motiontask').toLowerCase() === 'true',
    };
  });
}

/**
 * Parse a /rw/panel/speedratio response into a number (0–100).
 * XML: <li class="pnl-speedratio"><span class="speedratio">100</span></li>
 */
export function parseSpeedRatio(xml: string): number {
  const raw = requireSpan(xml, 'pnl-speedratio', 'speedratio', 'parseSpeedRatio');
  return requireFloat(raw, 'speedratio');
}

/**
 * Parse a /rw/rapid/symbol/data/... response — returns the raw value string.
 * XML: <li class="rap-data"><span class="value">42</span></li>
 * The caller interprets the string (number, bool, array, record, etc.).
 */
export function parseRapidSymbolValue(xml: string): string {
  const val = extractSpanValue(xml, 'rap-data', 'value');
  if (val === undefined) {
    throw new RwsError('PARSE_ERROR: missing <span class="value"> in rap-data', 'PARSE_ERROR');
  }
  return val;
}

/**
 * Parse a /rw/motionsystem/mechunits/{unit}/cartesian response into a CartesianFull.
 * XML: <li class="ms-mechunit-cartesian">
 *        <span class="x">...</span>...<span class="j1">0</span>...
 *      </li>
 */
export function parseCartesianFull(xml: string): CartesianFull {
  const liPattern = /<li[^>]*class="[^"]*\bms-mechunit-cartesian\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const liMatch = xml.match(liPattern);
  if (!liMatch) {
    throw new RwsError('PARSE_ERROR: missing <li class="ms-mechunit-cartesian">', 'PARSE_ERROR');
  }
  const block = liMatch[1];

  function getField(cls: string): number {
    const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
    if (!m) throw new RwsError(`PARSE_ERROR: missing <span class="${cls}"> in cartesian`, 'PARSE_ERROR');
    return requireFloat(m[1].trim(), cls);
  }

  return {
    x: getField('x'), y: getField('y'), z: getField('z'),
    q1: getField('q1'), q2: getField('q2'), q3: getField('q3'), q4: getField('q4'),
    j1: getField('j1'), j4: getField('j4'), j6: getField('j6'), jx: getField('jx'),
  };
}

/**
 * Parse a /rw/iosystem/networks response into an array of IoNetwork.
 * XML: <li class="ios-network-li"><span class="name">...</span>...</li>
 */
export function parseNetworks(xml: string): IoNetwork[] {
  const blocks = [...xml.matchAll(/<li[^>]*class="[^"]*\bios-network-li\b[^"]*"[^>]*>.*?<\/li>/gis)];
  return blocks.map(([block]) => {
    function get(cls: string): string {
      const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
      return m ? decodeEntities(m[1].trim()) : '';
    }
    return { name: get('name'), pstate: get('pstate'), lstate: get('lstate') };
  });
}

/**
 * Parse a /rw/iosystem/devices?network=... response into an array of IoDevice.
 * XML: <li class="ios-device-li" title="Local/DRV_1"><span class="name">...</span>...</li>
 */
export function parseDevices(xml: string): IoDevice[] {
  const blocks = [...xml.matchAll(/<li[^>]*class="[^"]*\bios-device-li\b[^"]*"[^>]*title="([^"]*)"[^>]*>.*?<\/li>/gis)];
  return blocks.map(([block, titleAttr]) => {
    function get(cls: string): string {
      const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
      return m ? decodeEntities(m[1].trim()) : '';
    }
    // title is "Network/DeviceName"
    const parts = titleAttr.split('/');
    const network = parts.length >= 2 ? parts[0] : '';
    return {
      name: get('name'),
      network,
      lstate: get('lstate'),
      pstate: get('pstate'),
      address: get('address'),
    };
  });
}

/**
 * Parse a /rw/system response into SystemInfo.
 * XML: <li class="sys-system-li">...</li> + <li class="sys-option-li">...</li>
 */
export function parseSystemInfo(xml: string): SystemInfo {
  const sysPattern = /<li[^>]*class="[^"]*\bsys-system-li\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const sysMatch = xml.match(sysPattern);
  if (!sysMatch) throw new RwsError('PARSE_ERROR: missing sys-system-li', 'PARSE_ERROR');
  const block = sysMatch[1];

  function get(cls: string): string {
    const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
    return m ? decodeEntities(m[1].trim()) : '';
  }

  const options = [...xml.matchAll(/<li[^>]*class="[^"]*\bsys-option-li\b[^"]*"[^>]*>.*?<span[^>]*class="[^"]*\boption\b[^"]*"[^>]*>(.*?)<\/span>.*?<\/li>/gis)]
    .map(([, opt]) => decodeEntities(opt.trim()))
    .filter(Boolean);

  return {
    name: get('name'),
    rwVersion: get('rwversion') || `${get('major')}.${get('minor')}.${get('build')}`,
    sysid: get('sysid'),
    startTime: get('starttm'),
    options,
  };
}

/**
 * Parse a /ctrl/identity response into ControllerIdentity.
 * XML: <li class="ctrl-identity-info"><span class="ctrl-name">...</span>...</li>
 */
export function parseControllerIdentity(xml: string): ControllerIdentity {
  const liPattern = /<li[^>]*class="[^"]*\bctrl-identity-info\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const liMatch = xml.match(liPattern);
  if (!liMatch) throw new RwsError('PARSE_ERROR: missing ctrl-identity-info', 'PARSE_ERROR');
  const block = liMatch[1];

  function get(cls: string): string {
    const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
    return m ? decodeEntities(m[1].trim()) : '';
  }

  return {
    name: get('ctrl-name'),
    id: get('ctrl-id'),
    type: get('ctrl-type'),
    mac: get('ctrl-mac'),
  };
}

/**
 * Parse a /rw/elog/{domain} response into an array of ElogMessage.
 * XML: <li class="elog-message-li" title="/rw/elog/0/14073">...</li>
 */
export function parseElogMessages(xml: string): ElogMessage[] {
  const blocks = [...xml.matchAll(/<li[^>]*class="[^"]*\belog-message-li\b[^"]*"[^>]*title="([^"]*)"[^>]*>.*?<\/li>/gis)];
  return blocks.map(([block, titleAttr]) => {
    function get(cls: string): string {
      const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
      return m ? decodeEntities(m[1].trim()) : '';
    }
    // Extract seqnum from title: "/rw/elog/0/14073" → 14073
    const seqMatch = titleAttr.match(/\/(\d+)$/);
    const seqnum = seqMatch ? parseInt(seqMatch[1], 10) : 0;
    return {
      seqnum,
      code: parseInt(get('code'), 10) || 0,
      msgtype: parseInt(get('msgtype'), 10) || 1,
      timestamp: get('tstamp'),
      srcName: get('src-name'),
      title: get('title'),
      desc: get('desc'),
      causes: get('causes'),
      consequences: get('conseqs'),
      actions: get('actions'),
    };
  });
}

/**
 * Parse a /fileservice/{path} directory listing response into FileEntry[].
 * XML: <li class="fs-file" title="filename.mod">...</li>
 *      <li class="fs-dir"  title="DirName">...</li>
 */
export function parseDirectory(xml: string): FileEntry[] {
  const fileBlocks = [...xml.matchAll(/<li[^>]*class="[^"]*\bfs-file\b[^"]*"[^>]*title="([^"]*)"[^>]*>.*?<\/li>/gis)];
  const dirBlocks  = [...xml.matchAll(/<li[^>]*class="[^"]*\bfs-dir\b[^"]*"[^>]*title="([^"]*)"[^>]*>.*?<\/li>/gis)];

  function get(block: string, cls: string): string {
    const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
    return m ? decodeEntities(m[1].trim()) : '';
  }

  const files: FileEntry[] = fileBlocks.map(([block, name]) => ({
    name,
    type: 'file' as const,
    size: get(block, 'fs-size') ? parseInt(get(block, 'fs-size'), 10) : undefined,
    created: get(block, 'fs-cdate') || undefined,
    modified: get(block, 'fs-mdate') || undefined,
    readonly: get(block, 'fs-readonly') === 'true',
  }));

  const dirs: FileEntry[] = dirBlocks.map(([block, name]) => ({
    name,
    type: 'dir' as const,
    created: get(block, 'fs-cdate') || undefined,
    modified: get(block, 'fs-mdate') || undefined,
  }));

  return [...dirs, ...files];
}

const VALID_COLLISION_STATES: ReadonlySet<string> = new Set([
  'INIT', 'TRIGGERED', 'CONFIRMED', 'TRIGGERED_ACK',
]);

/**
 * Parse a /rw/panel/coldetstate response into a CollisionDetectionState.
 * XML: <li class="pnl-coldetstate"><span class="coldetstate">INIT</span></li>
 */
export function parseCollisionDetectionState(xml: string): CollisionDetectionState {
  const raw = requireSpan(xml, 'pnl-coldetstate', 'coldetstate', 'parseCollisionDetectionState');
  const upper = raw.toUpperCase();
  if (!VALID_COLLISION_STATES.has(upper)) {
    // Return INIT as safe fallback for unknown values (firmware may add new states)
    return 'INIT';
  }
  return upper as CollisionDetectionState;
}

/**
 * Parse a /rw/rapid/symbol/properties/... response into RapidSymbolProperties.
 * XML: <li class="rap-sympropvar" title="RAPID/T_ROB1/user/reg1">...</li>
 */
export function parseRapidSymbolProperties(xml: string): RapidSymbolProperties {
  const liPattern = /<li[^>]*class="[^"]*\brap-sympropvar\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const liMatch = xml.match(liPattern);
  if (!liMatch) {
    throw new RwsError('PARSE_ERROR: missing <li class="rap-sympropvar">', 'PARSE_ERROR');
  }
  const block = liMatch[1];

  function get(cls: string): string {
    const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
    return m ? decodeEntities(m[1].trim()) : '';
  }

  // Extract symburl from the <li title="..."> attribute
  const titleMatch = xml.match(/<li[^>]*class="[^"]*\brap-sympropvar\b[^"]*"[^>]*title="([^"]*)"[^>]*>/i);
  const symburl = titleMatch ? titleMatch[1] : get('symburl');

  return {
    symburl,
    symtyp: get('symtyp'),
    named: get('named').toLowerCase() === 'true',
    dattyp: get('dattyp'),
    ndim: parseInt(get('ndim') || '0', 10),
    dim: get('dim'),
    heap: get('heap').toLowerCase() === 'true',
    linked: get('linked').toLowerCase() === 'true',
    local: get('local').toLowerCase() === 'true',
    ro: get('ro').toLowerCase() === 'true',
    taskvar: get('taskvar').toLowerCase() === 'true',
    storage: get('storage'),
    typurl: get('typurl'),
  };
}

/**
 * Parse a GET /ctrl/clock response into ControllerClock.
 * XML: <li class="ctrl-clock-info"><span class="datetime">2015-06-18 T 12:56:07</span></li>
 */
export function parseControllerClock(xml: string): ControllerClock {
  const val = extractSpanValue(xml, 'ctrl-clock-info', 'datetime') ?? extractSpanValueFlat(xml, 'datetime');
  if (!val) {
    throw new RwsError('PARSE_ERROR: missing datetime in ctrl-clock-info', 'PARSE_ERROR');
  }
  return { datetime: val };
}

/**
 * Parse a GET /rw/rapid/uiinstr/active response into a UiInstruction.
 * XML: <li class="rap-uiactive-li"><span class="instr">TPReadNum</span>...</li>
 * Returns null if no UI instruction is currently active.
 */
export function parseActiveUiInstruction(xml: string): UiInstruction | null {
  const liPattern = /<li[^>]*class="[^"]*\brap-uiactive-li\b[^"]*"[^>]*>(.*?)<\/li>/is;
  const liMatch = xml.match(liPattern);
  if (!liMatch) return null;
  const block = liMatch[1];

  function get(cls: string): string {
    const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
    return m ? decodeEntities(m[1].trim()) : '';
  }

  const instr = get('instr');
  if (!instr) return null; // no active instruction

  return {
    instr,
    event: get('event'),
    stack: get('stack'),
    execlv: get('execlv'),
    msg: get('msg'),
  };
}

/**
 * Parse a RAPID symbol search response into RapidSymbolInfo[].
 * XML: multiple <li class="rap-sympropvar-li"> elements.
 */
export function parseRapidSymbolSearch(xml: string): RapidSymbolInfo[] {
  const blocks = [...xml.matchAll(/<li[^>]*class="[^"]*\brap-sympropvar-li\b[^"]*"[^>]*>.*?<\/li>/gis)];
  return blocks.map(([block]) => {
    function get(cls: string): string {
      const m = block.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</span>`, 'is'));
      return m ? decodeEntities(m[1].trim()) : '';
    }
    // Extract symburl from title attr or span
    const titleMatch = block.match(/<li[^>]*title="([^"]*)"[^>]*>/i);
    const symburl = titleMatch ? titleMatch[1] : get('symburl');
    return {
      symburl,
      name: get('name'),
      symtyp: get('symtyp'),
      dattyp: get('dattyp'),
      ndim: parseInt(get('ndim') || '0', 10),
      local: get('local').toLowerCase() === 'true',
      ro: get('rdonly').toLowerCase() === 'true' || get('ro').toLowerCase() === 'true',
      taskvar: get('taskvar').toLowerCase() === 'true',
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
  // IRC5 RWS 1.0 may return /subscription/{id} or /poll/{id}
  const urlMatch = locationOrXml.match(/\/(?:subscription|poll)\/(\d+)/);
  if (urlMatch) return urlMatch[1];

  // Fallback: look for a self-link in the XML body
  const hrefMatch = locationOrXml.match(/href="[^"]*\/(?:subscription|poll)\/(\d+)"/i);
  if (hrefMatch) return hrefMatch[1];

  throw new RwsError(
    `PARSE_ERROR: cannot extract subscription ID from "${locationOrXml}"`,
    'PARSE_ERROR',
  );
}
