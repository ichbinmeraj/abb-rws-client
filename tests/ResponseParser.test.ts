import { describe, it, expect } from 'vitest';
import {
  parseControllerState,
  parseOperationMode,
  parseExecutionState,
  parseJointTarget,
  parseRobTarget,
  parseSignal,
  parseSignalList,
  parseRapidTasks,
  parseSubscriptionId,
} from '../src/ResponseParser.js';
import { RwsError } from '../src/types.js';

// ─── Realistic RWS 1.0 XML fixtures ──────────────────────────────────────────
// These reflect the actual XHTML structure returned by ABB IRC5 / RobotStudio.

// Fixtures use the actual class names returned by IRC5 / RobotWare 6 controllers.
const CONTROLLER_STATE_MOTORON = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
<div class="state">
<ul>
<li class="pnl-ctrlstate" title="ctrlstate">
  <span class="ctrlstate">motoron</span>
</li>
</ul>
</div>
</body>
</html>`;

const CONTROLLER_STATE_MOTOROFF = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><div class="state"><ul>
<li class="pnl-ctrlstate" title="ctrlstate"><span class="ctrlstate">motoroff</span></li>
</ul></div></body></html>`;

const CONTROLLER_STATE_GUARDSTOP = `<li class="pnl-ctrlstate"><span class="ctrlstate">guardstop</span></li>`;
const CONTROLLER_STATE_EMERGSTOP = `<li class="pnl-ctrlstate"><span class="ctrlstate">emergencystop</span></li>`;
const CONTROLLER_STATE_EMERGRESET = `<li class="pnl-ctrlstate"><span class="ctrlstate">emergencystopreset</span></li>`;
const CONTROLLER_STATE_SYSFAIL = `<li class="pnl-ctrlstate"><span class="ctrlstate">sysfail</span></li>`;
const CONTROLLER_STATE_INIT = `<li class="pnl-ctrlstate"><span class="ctrlstate">init</span></li>`;

const OPERATION_MODE_AUTO = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><div class="state"><ul>
<li class="pnl-opmode" title="opmode"><span class="opmode">AUTO</span></li>
</ul></div></body></html>`;

const OPERATION_MODE_MANR = `<li class="pnl-opmode"><span class="opmode">MANR</span></li>`;
const OPERATION_MODE_MANF = `<li class="pnl-opmode"><span class="opmode">MANF</span></li>`;

// IRC5 returns <span class="ctrlexecstate"> (not "excstate") and value "stop" (not "stopped").
const EXECUTION_STATE_RUNNING = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><div class="state"><ul>
<li class="rap-execution" title="execution"><span class="ctrlexecstate">running</span></li>
</ul></div></body></html>`;

const EXECUTION_STATE_STOPPED = `<li class="rap-execution" title="execution"><span class="ctrlexecstate">stop</span></li>`;

// IRC5 joint target: li class "ms-jointtarget", path /rw/motionsystem/mechunits/{u}/jointtarget
const JOINT_TARGET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><div class="state"><ul>
<li class="ms-jointtarget" title="ROB_1">
  <span class="rax_1">10.00</span>
  <span class="rax_2">-20.50</span>
  <span class="rax_3">30.25</span>
  <span class="rax_4">0.00</span>
  <span class="rax_5">45.75</span>
  <span class="rax_6">-90.00</span>
</li>
</ul></div></body></html>`;

// IRC5 robtarget: li class "ms-robtargets", path /rw/motionsystem/mechunits/{u}/robtarget
const ROB_TARGET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><div class="state"><ul>
<li class="ms-robtargets" title="ROB_1">
  <span class="x">512.34</span>
  <span class="y">-123.45</span>
  <span class="z">800.00</span>
  <span class="q1">1.00</span>
  <span class="q2">0.00</span>
  <span class="q3">0.00</span>
  <span class="q4">0.00</span>
</li>
</ul></div></body></html>`;

const SIGNAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><div class="state"><ul>
<li class="ios-signal-li">
  <span class="name">DI_1</span>
  <span class="lvalue">1</span>
  <span class="type">DI</span>
</li>
</ul></div></body></html>`;

const SIGNAL_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><div class="state"><ul>
<li class="ios-signal-li">
  <span class="name">DI_1</span>
  <span class="lvalue">1</span>
  <span class="type">DI</span>
</li>
<li class="ios-signal-li">
  <span class="name">DO_1</span>
  <span class="lvalue">0</span>
  <span class="type">DO</span>
</li>
<li class="ios-signal-li">
  <span class="name">AI_1</span>
  <span class="lvalue">3.14</span>
  <span class="type">AI</span>
</li>
</ul></div></body></html>`;

// IRC5 uses "stop" for excstate and "On"/"Off" for active.
const RAPID_TASKS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><div class="state"><ul>
<li class="rap-task-li" title="T_ROB1">
  <span class="name">T_ROB1</span>
  <span class="type">norm</span>
  <span class="taskstate">init</span>
  <span class="excstate">running</span>
  <span class="active">On</span>
  <span class="motiontask">TRUE</span>
</li>
<li class="rap-task-li" title="T_ROB2">
  <span class="name">T_ROB2</span>
  <span class="type">norm</span>
  <span class="taskstate">init</span>
  <span class="excstate">stop</span>
  <span class="active">Off</span>
  <span class="motiontask">FALSE</span>
</li>
</ul></div></body></html>`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseControllerState', () => {
  it('parses motoron', () => {
    expect(parseControllerState(CONTROLLER_STATE_MOTORON)).toBe('motoron');
  });

  it('parses motoroff', () => {
    expect(parseControllerState(CONTROLLER_STATE_MOTOROFF)).toBe('motoroff');
  });

  it('parses all 7 valid controller states', () => {
    expect(parseControllerState(CONTROLLER_STATE_INIT)).toBe('init');
    expect(parseControllerState(CONTROLLER_STATE_GUARDSTOP)).toBe('guardstop');
    expect(parseControllerState(CONTROLLER_STATE_EMERGSTOP)).toBe('emergencystop');
    expect(parseControllerState(CONTROLLER_STATE_EMERGRESET)).toBe('emergencystopreset');
    expect(parseControllerState(CONTROLLER_STATE_SYSFAIL)).toBe('sysfail');
  });

  it('throws RwsError PARSE_ERROR when li is missing', () => {
    expect(() => parseControllerState('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });

  it('throws RwsError PARSE_ERROR for unknown state values', () => {
    const xml = '<li class="pnl-ctrlstate"><span class="ctrlstate">unknown_state</span></li>';
    expect(() => parseControllerState(xml)).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });

  it('throws a RwsError instance (not plain Error)', () => {
    expect(() => parseControllerState('<html></html>')).toThrow(RwsError);
  });
});

describe('parseOperationMode', () => {
  it('parses AUTO', () => {
    expect(parseOperationMode(OPERATION_MODE_AUTO)).toBe('AUTO');
  });

  it('parses MANR', () => {
    expect(parseOperationMode(OPERATION_MODE_MANR)).toBe('MANR');
  });

  it('parses MANF', () => {
    expect(parseOperationMode(OPERATION_MODE_MANF)).toBe('MANF');
  });

  it('normalises lowercase to uppercase', () => {
    const xml = '<li class="pnl-opmode"><span class="opmode">auto</span></li>';
    expect(parseOperationMode(xml)).toBe('AUTO');
  });

  it('throws PARSE_ERROR for unknown mode', () => {
    const xml = '<li class="pnl-opmode"><span class="opmode">SUPER_AUTO</span></li>';
    expect(() => parseOperationMode(xml)).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseExecutionState', () => {
  it('parses running', () => {
    expect(parseExecutionState(EXECUTION_STATE_RUNNING)).toBe('running');
  });

  it('parses stopped', () => {
    expect(parseExecutionState(EXECUTION_STATE_STOPPED)).toBe('stopped');
  });

  it('normalises uppercase', () => {
    const xml = '<li class="rap-execution"><span class="ctrlexecstate">RUNNING</span></li>';
    expect(parseExecutionState(xml)).toBe('running');
  });

  it('normalises "stop" to "stopped"', () => {
    const xml = '<li class="rap-execution"><span class="ctrlexecstate">stop</span></li>';
    expect(parseExecutionState(xml)).toBe('stopped');
  });

  it('throws PARSE_ERROR when excstate span is missing', () => {
    expect(() => parseExecutionState('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseJointTarget', () => {
  it('parses all 6 axes as numbers', () => {
    const jt = parseJointTarget(JOINT_TARGET_XML);
    expect(jt.rax_1).toBe(10.0);
    expect(jt.rax_2).toBe(-20.5);
    expect(jt.rax_3).toBe(30.25);
    expect(jt.rax_4).toBe(0.0);
    expect(jt.rax_5).toBe(45.75);
    expect(jt.rax_6).toBe(-90.0);
  });

  it('parses negative values correctly', () => {
    const jt = parseJointTarget(JOINT_TARGET_XML);
    expect(jt.rax_2).toBeLessThan(0);
    expect(jt.rax_6).toBeLessThan(0);
  });

  it('returns numbers (not strings)', () => {
    const jt = parseJointTarget(JOINT_TARGET_XML);
    expect(typeof jt.rax_1).toBe('number');
  });

  it('throws PARSE_ERROR when the li block is missing', () => {
    expect(() => parseJointTarget('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });

  it('throws PARSE_ERROR when a specific axis span is missing', () => {
    const noRax6 = `<li class="ms-jointtarget">
      <span class="rax_1">0</span><span class="rax_2">0</span>
      <span class="rax_3">0</span><span class="rax_4">0</span>
      <span class="rax_5">0</span>
    </li>`;
    expect(() => parseJointTarget(noRax6)).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseRobTarget', () => {
  it('parses x, y, z, q1–q4 as numbers', () => {
    const rt = parseRobTarget(ROB_TARGET_XML);
    expect(rt.x).toBeCloseTo(512.34);
    expect(rt.y).toBeCloseTo(-123.45);
    expect(rt.z).toBe(800.0);
    expect(rt.q1).toBe(1.0);
    expect(rt.q2).toBe(0.0);
    expect(rt.q3).toBe(0.0);
    expect(rt.q4).toBe(0.0);
  });

  it('throws PARSE_ERROR when li block is missing', () => {
    expect(() => parseRobTarget('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseSignal', () => {
  it('parses name, value (lvalue), and type', () => {
    const sig = parseSignal(SIGNAL_XML);
    expect(sig.name).toBe('DI_1');
    expect(sig.value).toBe('1');
    expect(sig.lvalue).toBe('1');
    expect(sig.type).toBe('DI');
  });

  it('value and lvalue are the same field', () => {
    const sig = parseSignal(SIGNAL_XML);
    expect(sig.value).toBe(sig.lvalue);
  });

  it('throws PARSE_ERROR on missing name', () => {
    const xml = '<li class="ios-signal-li"><span class="lvalue">1</span><span class="type">DI</span></li>';
    expect(() => parseSignal(xml)).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });

  it('throws PARSE_ERROR on unknown signal type', () => {
    const xml = '<li class="ios-signal-li"><span class="name">x</span><span class="lvalue">0</span><span class="type">XX</span></li>';
    expect(() => parseSignal(xml)).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseSignalList', () => {
  it('parses all 3 signals from the list XML', () => {
    const list = parseSignalList(SIGNAL_LIST_XML);
    expect(list).toHaveLength(3);
  });

  it('first signal is DI_1 with value 1', () => {
    const list = parseSignalList(SIGNAL_LIST_XML);
    expect(list[0].name).toBe('DI_1');
    expect(list[0].value).toBe('1');
    expect(list[0].type).toBe('DI');
  });

  it('second signal is DO_1', () => {
    const list = parseSignalList(SIGNAL_LIST_XML);
    expect(list[1].name).toBe('DO_1');
    expect(list[1].type).toBe('DO');
  });

  it('third signal is AI_1 with float value', () => {
    const list = parseSignalList(SIGNAL_LIST_XML);
    expect(list[2].name).toBe('AI_1');
    expect(list[2].value).toBe('3.14');
    expect(list[2].type).toBe('AI');
  });

  it('returns empty array when no signals present', () => {
    expect(parseSignalList('<html></html>')).toEqual([]);
  });
});

describe('parseRapidTasks', () => {
  it('parses 2 tasks', () => {
    const tasks = parseRapidTasks(RAPID_TASKS_XML);
    expect(tasks).toHaveLength(2);
  });

  it('parses first task T_ROB1 correctly', () => {
    const tasks = parseRapidTasks(RAPID_TASKS_XML);
    const t = tasks[0];
    expect(t.name).toBe('T_ROB1');
    expect(t.type).toBe('norm');
    expect(t.excstate).toBe('running');
    expect(t.active).toBe(true);
    expect(t.motiontask).toBe(true);
  });

  it('parses second task T_ROB2 with stopped excstate (normalised from "stop")', () => {
    const tasks = parseRapidTasks(RAPID_TASKS_XML);
    const t = tasks[1];
    expect(t.name).toBe('T_ROB2');
    expect(t.excstate).toBe('stopped');
    expect(t.active).toBe(false);
    expect(t.motiontask).toBe(false);
  });

  it('parses boolean fields correctly (case-insensitive)', () => {
    const xml = `<li class="rap-task-li">
      <span class="name">T1</span><span class="type">NORMAL</span>
      <span class="taskstate">STARTED</span><span class="excstate">running</span>
      <span class="active">true</span><span class="motiontask">false</span>
    </li>`;
    const tasks = parseRapidTasks(xml);
    expect(tasks[0].active).toBe(true);
    expect(tasks[0].motiontask).toBe(false);
  });

  it('throws PARSE_ERROR when no tasks are found', () => {
    expect(() => parseRapidTasks('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseSubscriptionId', () => {
  it('extracts subscription ID from a full HTTP URL', () => {
    expect(parseSubscriptionId('http://192.168.125.1/subscription/42')).toBe('42');
  });

  it('extracts subscription ID from a WebSocket URL', () => {
    expect(parseSubscriptionId('ws://192.168.125.1/subscription/7')).toBe('7');
  });

  it('extracts subscription ID from a path-only string', () => {
    expect(parseSubscriptionId('/subscription/123')).toBe('123');
  });

  it('extracts subscription ID from an XML href attribute', () => {
    const xml = `<a rel="self" href="http://host/subscription/99"/>`;
    expect(parseSubscriptionId(xml)).toBe('99');
  });

  it('throws PARSE_ERROR when no ID can be found', () => {
    expect(() => parseSubscriptionId('http://host/other/path')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});
