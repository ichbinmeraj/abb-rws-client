import { describe, it, expect } from 'vitest';
import {
  parseControllerState,
  parseOperationMode,
  parseExecutionState,
  parseExecutionInfo,
  parseJointTarget,
  parseRobTarget,
  parseCartesianFull,
  parseSignal,
  parseSignalList,
  parseRapidTasks,
  parseSpeedRatio,
  parseRapidSymbolValue,
  parseRapidSymbolProperties,
  parseNetworks,
  parseDevices,
  parseSystemInfo,
  parseControllerIdentity,
  parseControllerClock,
  parseActiveUiInstruction,
  parseRapidSymbolSearch,
  parseElogMessages,
  parseDirectory,
  parseCollisionDetectionState,
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
  it('parses x, y, z, q1-q4 as numbers', () => {
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

// ─── Fixtures mirroring live IRC5 RW6.16 bodies (captured 2026-07-09) ─────────
// Whitespace-compacted but structurally identical to the controller output.

const SPEED_RATIO_XML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="state">
<a href="" rel="self"></a><a href="?action=show" rel="action"></a>
<ul><li class="pnl-speedratio" title="speedratio"><span class="speedratio">100</span></li></ul>
</div></body></html>`;

// Live-verified 2026-07-09: RW6.16 emits a trailing space inside the span class
// attribute - class="coldetstate " - the parser must still match it.
const COLDET_XML = `<li class="pnl-coldetstate" title="collisiondetectstate"><span class="coldetstate ">INIT</span></li>`;

const EXECUTION_FULL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="state">
<ul><li class="rap-execution" title="execution"><span class="ctrlexecstate">stopped</span><span class="cycle">forever</span></li></ul>
</div></body></html>`;

// Symbol data responses carry extra rap-data-decl-pos / rap-data-initval-pos <li>s.
const RAPID_SYMBOL_DATA_XML = `<ul>
<li class="rap-data" title="RAPID/T_ROB1/user/reg1"><span class="value">42</span></li>
<li class="rap-data-decl-pos" title="decl-pos"><span class="begin-row">8</span><span class="begin-coloumn">2</span></li>
<li class="rap-data-initval-pos" title="initval_pos"><span class="begin-row">8</span></li>
</ul>`;

const SYMBOL_PROPERTIES_VAR_XML = `<ul><li class="rap-sympropvar" title="RAPID/T_ROB1/user/reg1">
<a href="symbol/data/RAPID/T_ROB1/user/reg1" rel="data"></a>
<span class="symburl">RAPID/T_ROB1/user/reg1</span><span class="name"></span>
<span class="symtyp">var</span><span class="named">true</span><span class="dattyp">num</span>
<span class="ndim">0</span><span class="dim"></span><span class="local">false</span>
<span class="rdonly">false</span><span class="taskvar">false</span><span class="typurl">RAPID/num</span>
</li></ul>`;

// Live-verified 2026-07-09: persistents come back as rap-symproppers, constants
// as rap-sympropconstant (e.g. RAPID/T_ROB1/BASE/tool0, RAPID/pi).
const SYMBOL_PROPERTIES_PERS_XML = `<ul><li class="rap-symproppers" title="RAPID/T_ROB1/BASE/tool0">
<span class="symburl">RAPID/T_ROB1/BASE/tool0</span><span class="symtyp">per</span>
<span class="named">true</span><span class="dattyp">tooldata</span><span class="ndim">0</span>
<span class="local">false</span><span class="rdonly">false</span><span class="taskpers">false</span>
<span class="typurl">RAPID/tooldata</span></li></ul>`;

const SYMBOL_PROPERTIES_READONLY_XML = `<ul><li class="rap-sympropvar" title="RAPID/T_ROB1/user/lockedVar">
<span class="symburl">RAPID/T_ROB1/user/lockedVar</span><span class="symtyp">var</span>
<span class="named">true</span><span class="dattyp">num</span><span class="ndim">0</span>
<span class="local">false</span><span class="rdonly">true</span><span class="taskvar">false</span>
<span class="typurl">RAPID/num</span></li></ul>`;

const CARTESIAN_XML = `<ul><li class="ms-mechunit-cartesian" title="cartesian">
<span class="x">815.0001</span> <span class="y">0</span> <span class="z">961.5</span>
<span class="q1">0.7071068</span> <span class="q2">0</span> <span class="q3">0.7071068</span> <span class="q4">0</span>
<span class="j1">0</span> <span class="j4">0</span> <span class="j6">0</span> <span class="jx">0</span>
</li></ul>`;

const NETWORKS_XML = `<ul>
<li class="ios-network-li" title="EtherNetIP"><a href="networks/EtherNetIP" rel="self"></a>
<span class="name">EtherNetIP</span><span class="pstate">running</span><span class="lstate">started</span></li>
<li class="ios-network-li" title="Local"><a href="networks/Local" rel="self"></a>
<span class="name">Local</span><span class="pstate">running</span><span class="lstate">started</span></li>
<li class="ios-network-li" title="Virtual"><a href="networks/Virtual" rel="self"></a>
<span class="name">Virtual</span><span class="pstate">running</span><span class="lstate">started</span></li>
</ul>`;

const DEVICES_XML = `<ul>
<li class="ios-device-li" title="Local/DRV_1"><a href="devices/Local/DRV_1" rel="self"></a>
<span class="name">DRV_1</span><span class="lstate">enabled</span><span class="pstate">running</span><span class="address">-</span></li>
<li class="ios-device-li" title="Local/PANEL"><a href="devices/Local/PANEL" rel="self"></a>
<span class="name">PANEL</span><span class="lstate">enabled</span><span class="pstate">running</span><span class="address">-</span></li>
</ul>`;

const SYSTEM_XML = `<ul>
<li class="sys-system-li" title="system">
<span class="name">IRB1600_6_120</span> <span class="rwversion">6.16.2027</span>
<span class="sysid">{5AC2ABEE-DF73-432B-B77B-BF89B4697EC0}</span>
<span class="starttm">2026-07-08 T 18:09:31</span> <span class="rwversionname">6.16.02.00</span>
</li>
<li class="sys-options-li" title="options"><a href="options" rel="self"></a><ul>
<li class="sys-option-li" title="0"><span class="option">RobotWare Base</span></li>
<li class="sys-option-li" title="1"><span class="option">English</span></li>
<li class="sys-option-li" title="2"><span class="option">Axis Calibration</span></li>
</ul></li>
</ul>`;

// Live-verified 2026-07-09: a virtual controller reports no ctrl-id / ctrl-mac spans.
const IDENTITY_XML = `<ul><li class="ctrl-identity-info" title="identity">
<span class="ctrl-name">DESKTOP-64BUNCK</span><span class="ctrl-type">Virtual Controller</span>
<span class="ctrl-level">System Level</span></li></ul>`;

const CLOCK_XML = `<ul><li class="ctrl-clock-info" title="clock"><span class="datetime">2026-07-09 T 02:55:41</span></li></ul>`;

const ELOG_XML = `<ul>
<li class="elog-message-li" title="/rw/elog/0/18"><a href="0/18?lang=en" rel="self"></a>
<span class="msgtype">1</span><span class="code">10205</span><span class="src-name">MC0</span>
<span class="tstamp">2026-07-09 T 01:29:56</span><span class="title">Configuration parameter changed</span>
<span class="desc">A configuration parameter has been changed in domain: SYS by Default User.</span>
<span class="conseqs"></span><span class="causes"></span><span class="actions"></span></li>
<li class="elog-message-li" title="/rw/elog/0/17"><a href="0/17?lang=en" rel="self"></a>
<span class="msgtype">2</span><span class="code">10014</span><span class="src-name">MC0</span>
<span class="tstamp">2026-07-09 T 01:18:04</span><span class="title">System failure state</span>
<span class="desc">Impossible to continue.</span>
<span class="conseqs"></span><span class="causes"></span><span class="actions"></span></li>
</ul>`;

const DIRECTORY_XML = `<ul>
<li class="fs-file" title="user.sys"><a href="user.sys" rel="self"></a>
<span class="fs-cdate">2026-07-08 T 18:09:17</span><span class="fs-mdate">2026-07-08 T 18:09:17</span>
<span class="fs-size">458</span><span class="fs-readonly">false</span></li>
<li class="fs-dir" title="Dispense"><a href="Dispense" rel="self"></a>
<span class="fs-cdate">2026-07-01 T 09:00:00</span><span class="fs-mdate">2026-07-02 T 09:00:00</span></li>
<li class="fs-file" title="MainModule.mod"><a href="MainModule.mod" rel="self"></a>
<span class="fs-cdate">2026-07-08 T 18:09:17</span><span class="fs-mdate">2026-07-08 T 19:00:00</span>
<span class="fs-size">1024</span><span class="fs-readonly">true</span></li>
</ul>`;

const UIINSTR_XML = `<ul><li class="rap-uiactive-li" title="active">
<span class="instr">TPReadNum</span><span class="event">POST</span>
<span class="stack">RAPID/T_ROB1/%$104</span><span class="execlv">Normal</span>
<span class="msg">&quot;Enter count:&quot;</span></li></ul>`;

const SYMBOL_SEARCH_XML = `<ul>
<li class="rap-sympropvar-li" title="RAPID/T_ROB1/user/counter">
<span class="name">counter</span><span class="symtyp">per</span><span class="dattyp">num</span>
<span class="ndim">0</span><span class="local">false</span><span class="rdonly">false</span>
<span class="taskvar">false</span></li>
<li class="rap-sympropvar-li" title="RAPID/T_ROB1/user/limits">
<span class="name">limits</span><span class="symtyp">con</span><span class="dattyp">num</span>
<span class="ndim">1</span><span class="local">true</span><span class="rdonly">true</span>
<span class="taskvar">false</span></li>
</ul>`;

describe('parseSpeedRatio', () => {
  it('parses the ratio as a number from a live-shaped response', () => {
    expect(parseSpeedRatio(SPEED_RATIO_XML)).toBe(100);
  });

  it('throws PARSE_ERROR when the span is missing', () => {
    expect(() => parseSpeedRatio('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });

  it('throws PARSE_ERROR for a non-numeric ratio', () => {
    const xml = '<li class="pnl-speedratio"><span class="speedratio">fast</span></li>';
    expect(() => parseSpeedRatio(xml)).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseCollisionDetectionState', () => {
  it('parses INIT from a live-shaped response (trailing space in class attr)', () => {
    expect(parseCollisionDetectionState(COLDET_XML)).toBe('INIT');
  });

  it('normalises lowercase values', () => {
    const xml = '<li class="pnl-coldetstate"><span class="coldetstate">triggered</span></li>';
    expect(parseCollisionDetectionState(xml)).toBe('TRIGGERED');
  });

  it('falls back to INIT for unknown states instead of throwing', () => {
    const xml = '<li class="pnl-coldetstate"><span class="coldetstate">FUTURE_STATE</span></li>';
    expect(parseCollisionDetectionState(xml)).toBe('INIT');
  });

  it('throws PARSE_ERROR when the li is missing entirely', () => {
    expect(() => parseCollisionDetectionState('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseExecutionInfo', () => {
  it('parses state and cycle from a live-shaped response', () => {
    expect(parseExecutionInfo(EXECUTION_FULL_XML)).toEqual({ state: 'stopped', cycle: 'forever' });
  });

  it('defaults cycle to asis when the span is absent', () => {
    const xml = '<li class="rap-execution"><span class="ctrlexecstate">running</span></li>';
    expect(parseExecutionInfo(xml)).toEqual({ state: 'running', cycle: 'asis' });
  });

  it('accepts the rap-execution-state li variant', () => {
    const xml = '<li class="rap-execution-state"><span class="ctrlexecstate">stop</span><span class="cycle">once</span></li>';
    expect(parseExecutionInfo(xml)).toEqual({ state: 'stopped', cycle: 'once' });
  });

  it('throws PARSE_ERROR for an unknown execution state', () => {
    const xml = '<li class="rap-execution"><span class="ctrlexecstate">paused</span></li>';
    expect(() => parseExecutionInfo(xml)).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseRapidSymbolValue', () => {
  it('returns the raw value string, ignoring decl-pos sibling blocks', () => {
    expect(parseRapidSymbolValue(RAPID_SYMBOL_DATA_XML)).toBe('42');
  });

  it('decodes HTML entities in string values', () => {
    const xml = '<li class="rap-data"><span class="value">&quot;a &amp; b&quot;</span></li>';
    expect(parseRapidSymbolValue(xml)).toBe('"a & b"');
  });

  it('throws PARSE_ERROR when the value span is missing', () => {
    expect(() => parseRapidSymbolValue('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseRapidSymbolProperties', () => {
  it('parses a VAR properties response (live shape)', () => {
    const p = parseRapidSymbolProperties(SYMBOL_PROPERTIES_VAR_XML);
    expect(p.symburl).toBe('RAPID/T_ROB1/user/reg1');
    expect(p.symtyp).toBe('var');
    expect(p.named).toBe(true);
    expect(p.dattyp).toBe('num');
    expect(p.ndim).toBe(0);
    expect(p.local).toBe(false);
    expect(p.taskvar).toBe(false);
    expect(p.typurl).toBe('RAPID/num');
  });

  it('takes symburl from the li title attribute', () => {
    expect(parseRapidSymbolProperties(SYMBOL_PROPERTIES_VAR_XML).symburl).toBe(
      'RAPID/T_ROB1/user/reg1',
    );
  });

  // Live-verified 2026-07-09 on IRC5 RW6.16: persistents (tool0) return
  // <li class="rap-symproppers"> - the parser only matches rap-sympropvar and
  // currently throws PARSE_ERROR for them.
  it.fails('parses a PERS properties response (rap-symproppers li)', () => {
    const p = parseRapidSymbolProperties(SYMBOL_PROPERTIES_PERS_XML);
    expect(p.symtyp).toBe('per');
    expect(p.dattyp).toBe('tooldata');
  });

  // Live-verified 2026-07-09: RW6.16 emits <span class="rdonly">, never "ro" -
  // the ro field therefore never reflects the controller's readonly flag.
  it.fails('maps the live rdonly span onto the ro field', () => {
    expect(parseRapidSymbolProperties(SYMBOL_PROPERTIES_READONLY_XML).ro).toBe(true);
  });

  it('throws PARSE_ERROR when no properties li is present', () => {
    expect(() => parseRapidSymbolProperties('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseCartesianFull', () => {
  it('parses pose and configuration flags from a live-shaped response', () => {
    const c = parseCartesianFull(CARTESIAN_XML);
    expect(c.x).toBeCloseTo(815.0001);
    expect(c.y).toBe(0);
    expect(c.z).toBe(961.5);
    expect(c.q1).toBeCloseTo(0.7071068);
    expect(c.q3).toBeCloseTo(0.7071068);
    expect(c.j1).toBe(0);
    expect(c.j4).toBe(0);
    expect(c.j6).toBe(0);
    expect(c.jx).toBe(0);
  });

  it('throws PARSE_ERROR when a configuration span is missing', () => {
    const noJx = CARTESIAN_XML.replace('<span class="jx">0</span>', '');
    expect(() => parseCartesianFull(noJx)).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseNetworks', () => {
  it('parses all networks with name/pstate/lstate (live shape)', () => {
    const nets = parseNetworks(NETWORKS_XML);
    expect(nets).toHaveLength(3);
    expect(nets[0]).toEqual({ name: 'EtherNetIP', pstate: 'running', lstate: 'started' });
    expect(nets.map((n) => n.name)).toEqual(['EtherNetIP', 'Local', 'Virtual']);
  });

  it('returns an empty array when no networks are present', () => {
    expect(parseNetworks('<html></html>')).toEqual([]);
  });
});

describe('parseDevices', () => {
  it('parses devices and derives the network from the title attribute (live shape)', () => {
    const devs = parseDevices(DEVICES_XML);
    expect(devs).toHaveLength(2);
    expect(devs[0]).toEqual({
      name: 'DRV_1',
      network: 'Local',
      lstate: 'enabled',
      pstate: 'running',
      address: '-',
    });
    expect(devs[1].name).toBe('PANEL');
  });

  it('returns an empty array when no devices are present', () => {
    expect(parseDevices('<html></html>')).toEqual([]);
  });
});

describe('parseSystemInfo', () => {
  it('parses name, rwversion, sysid, start time, and options (live shape)', () => {
    const info = parseSystemInfo(SYSTEM_XML);
    expect(info.name).toBe('IRB1600_6_120');
    expect(info.rwVersion).toBe('6.16.2027');
    expect(info.sysid).toBe('{5AC2ABEE-DF73-432B-B77B-BF89B4697EC0}');
    expect(info.startTime).toBe('2026-07-08 T 18:09:31');
    expect(info.options).toEqual(['RobotWare Base', 'English', 'Axis Calibration']);
  });

  it('throws PARSE_ERROR when sys-system-li is missing', () => {
    expect(() => parseSystemInfo('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseControllerIdentity', () => {
  it('parses name and type; id/mac are empty on virtual controllers (live shape)', () => {
    const id = parseControllerIdentity(IDENTITY_XML);
    expect(id.name).toBe('DESKTOP-64BUNCK');
    expect(id.type).toBe('Virtual Controller');
    expect(id.id).toBe('');
    expect(id.mac).toBe('');
  });

  it('throws PARSE_ERROR when the identity li is missing', () => {
    expect(() => parseControllerIdentity('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseControllerClock', () => {
  it('parses the datetime string (live shape)', () => {
    expect(parseControllerClock(CLOCK_XML)).toEqual({ datetime: '2026-07-09 T 02:55:41' });
  });

  it('falls back to a flat datetime span without the li wrapper', () => {
    expect(parseControllerClock('<span class="datetime">2026-01-01 T 00:00:00</span>')).toEqual({
      datetime: '2026-01-01 T 00:00:00',
    });
  });

  it('throws PARSE_ERROR when datetime is missing', () => {
    expect(() => parseControllerClock('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    );
  });
});

describe('parseElogMessages', () => {
  it('parses messages with seqnum extracted from the title attribute (live shape)', () => {
    const msgs = parseElogMessages(ELOG_XML);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seqnum).toBe(18);
    expect(msgs[0].code).toBe(10205);
    expect(msgs[0].msgtype).toBe(1);
    expect(msgs[0].timestamp).toBe('2026-07-09 T 01:29:56');
    expect(msgs[0].srcName).toBe('MC0');
    expect(msgs[0].title).toBe('Configuration parameter changed');
    expect(msgs[0].desc).toContain('SYS by Default User');
    expect(msgs[1].seqnum).toBe(17);
    expect(msgs[1].msgtype).toBe(2);
  });

  it('returns empty strings for empty conseqs/causes/actions spans', () => {
    const msgs = parseElogMessages(ELOG_XML);
    expect(msgs[0].causes).toBe('');
    expect(msgs[0].consequences).toBe('');
    expect(msgs[0].actions).toBe('');
  });

  it('returns an empty array when the log is empty', () => {
    expect(parseElogMessages('<html></html>')).toEqual([]);
  });
});

describe('parseDirectory', () => {
  it('parses files with size/dates/readonly and lists directories first (live shape)', () => {
    const entries = parseDirectory(DIRECTORY_XML);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ name: 'Dispense', type: 'dir' });
    expect(entries[1]).toMatchObject({
      name: 'user.sys',
      type: 'file',
      size: 458,
      readonly: false,
      created: '2026-07-08 T 18:09:17',
    });
    expect(entries[2]).toMatchObject({ name: 'MainModule.mod', size: 1024, readonly: true });
  });

  it('directories carry no size field', () => {
    const dir = parseDirectory(DIRECTORY_XML).find((e) => e.type === 'dir');
    expect(dir).toBeDefined();
    expect((dir as { size?: number }).size).toBeUndefined();
  });

  it('returns an empty array for an empty directory', () => {
    expect(parseDirectory('<html></html>')).toEqual([]);
  });
});

describe('parseActiveUiInstruction', () => {
  it('parses an active TPReadNum instruction with entity-decoded message', () => {
    expect(parseActiveUiInstruction(UIINSTR_XML)).toEqual({
      instr: 'TPReadNum',
      event: 'POST',
      stack: 'RAPID/T_ROB1/%$104',
      execlv: 'Normal',
      msg: '"Enter count:"',
    });
  });

  it('returns null when no rap-uiactive-li block is present', () => {
    expect(parseActiveUiInstruction('<html></html>')).toBeNull();
  });

  it('returns null when the li exists but has no instr span', () => {
    const xml = '<li class="rap-uiactive-li"><span class="event"></span></li>';
    expect(parseActiveUiInstruction(xml)).toBeNull();
  });
});

describe('parseRapidSymbolSearch', () => {
  it('parses matching symbols with symburl from the title attribute', () => {
    const syms = parseRapidSymbolSearch(SYMBOL_SEARCH_XML);
    expect(syms).toHaveLength(2);
    expect(syms[0]).toEqual({
      symburl: 'RAPID/T_ROB1/user/counter',
      name: 'counter',
      symtyp: 'per',
      dattyp: 'num',
      ndim: 0,
      local: false,
      ro: false,
      taskvar: false,
    });
  });

  it('reads the rdonly span for the ro flag and parses ndim', () => {
    const syms = parseRapidSymbolSearch(SYMBOL_SEARCH_XML);
    expect(syms[1].ro).toBe(true);
    expect(syms[1].ndim).toBe(1);
    expect(syms[1].local).toBe(true);
  });

  it('returns an empty array when nothing matches', () => {
    expect(parseRapidSymbolSearch('<html></html>')).toEqual([]);
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
