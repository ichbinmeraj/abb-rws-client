import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2 } from '../src/RwsClient2.js';
import { RWS1Adapter } from '../src/RWS1Adapter.js';
import type { RwsClient } from '../src/RwsClient.js';
import { parseElogMessages, parseRapidSymbolProperties, parseRapidSymbolSearch } from '../src/ResponseParser.js';
import { RwsError } from '../src/types.js';
import { setLogger, type Logger } from '../src/Logger.js';

// Symbol kinds, oversize reads and single event-log reads, from the
// functional runs of 2026-09-30 and the bodies recorded from RobotWare
// 6.16.03, 7.21.4 and 8.2.1 virtual controllers on 2026-09-29. Bodies marked "recorded" are the controller's
// answers as captured; the others are rebuilt from recorded fields and say so.

/** A local HTTP server for RwsClient2; `respond` returns [status, content type, body]. */
async function withServer(
  respond: (method: string, url: string) => [number, string, string],
  run: (client: RwsClient2) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    const [status, type, body] = respond(req.method ?? '', req.url ?? '');
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(new RwsClient2(`http://127.0.0.1:${port}`, 'u', 'p'));
  } finally { server.close(); }
}

/** A fake RwsClient for RWS1Adapter: answers each request from `respond`. */
function fakeRws1(respond: (url: string) => { status: number; body: string }): { client: RwsClient; urls: string[] } {
  const urls: string[] = [];
  const client = {
    request: async (_m: string, url: string) => { urls.push(url); return respond(url); },
  } as unknown as RwsClient;
  return { client, urls };
}

const HAL = 'application/hal+json;v=2.0';
const XHTML = 'application/xhtml+xml;v=2.0';
const hal = (body: string) => (): [number, string, string] => [200, HAL, body];

// ─── RWS 1.0 symbol properties: CONST, FUNC and the rdonly span ─────────────

describe('parseRapidSymbolProperties (RW 6.16.03 kinds)', () => {
  // Recorded 2026-09-29 on RW 6.16.03: GET /rw/rapid/symbol/properties/RAPID/ROB_1.
  const VAR_BODY = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rapid</title><base href="http://127.0.0.1:4578/rw/rapid/"/></head><body><div class="state"><a href="symbol/properties/RAPID/ROB_1" rel="self"></a><ul><li class="rap-sympropvar" title="RAPID/ROB_1"><a href="symbol/data/RAPID/ROB_1" rel="data"></a><span class="symburl">RAPID/ROB_1</span><span class="name"></span><span class="symtyp">var</span><span class="named">true</span><span class="dattyp">mecunit</span><span class="ndim">0</span><span class="dim"></span><span class="local">true</span><span class="rdonly">false</span><span class="taskvar">false</span><span class="typurl">RAPID/mecunit</span></li></ul></div></body></html>';

  /**
   * A CONST as read live 2026-09-30 on RW 6.16.03: class rap-sympropconstant,
   * the spans symburl, name (empty), symtyp, named, linked, local, typurl,
   * dattyp and ndim in that order, no rdonly and no dim. Rebuilt in the
   * recorded VAR body's envelope.
   */
  const constBody = (li: string): string => VAR_BODY.replace(/<li class="rap-sympropvar".*<\/li>/, li);
  const CONST_ARRAY = constBody('<li class="rap-sympropconstant" title="RAPID/T_ROB1/ZZ_PROBE_TRIAGE/zz_probe_triage_ca"><span class="symburl">RAPID/T_ROB1/ZZ_PROBE_TRIAGE/zz_probe_triage_ca</span><span class="name"></span><span class="symtyp">con</span><span class="named">true</span><span class="linked">true</span><span class="local">false</span><span class="typurl">RAPID/num</span><span class="dattyp">num</span><span class="ndim">1</span></li>');

  it('reads a CONST (rap-sympropconstant) instead of throwing PARSE_ERROR', () => {
    const p = parseRapidSymbolProperties(CONST_ARRAY);
    expect(p).toMatchObject({
      symburl: 'RAPID/T_ROB1/ZZ_PROBE_TRIAGE/zz_probe_triage_ca',
      symtyp: 'con', dattyp: 'num', ndim: 1, dim: '', named: true, linked: true, local: false, ro: false, typurl: 'RAPID/num',
    });
  });

  it('reads a FUNC (rap-sympropfunction, the search class without -li)', () => {
    const body = constBody('<li class="rap-sympropfunction" title="RAPID/DOutput"><span class="symburl">RAPID/DOutput</span><span class="name"></span><span class="symtyp">fun</span><span class="named">true</span><span class="linked">true</span><span class="local">true</span><span class="typurl">RAPID/dionum</span><span class="dattyp">dionum</span><span class="npar">1</span></li>');
    expect(parseRapidSymbolProperties(body)).toMatchObject({ symburl: 'RAPID/DOutput', symtyp: 'fun', dattyp: 'dionum' });
  });

  it('reads the ro flag from the rdonly span the controller sends', () => {
    expect(parseRapidSymbolProperties(VAR_BODY)).toMatchObject({ symtyp: 'var', dattyp: 'mecunit', local: true, ro: false });
    expect(parseRapidSymbolProperties(VAR_BODY.replace('<span class="rdonly">false</span>', '<span class="rdonly">true</span>')).ro).toBe(true);
  });
});

// ─── RWS 1.0 symbol search: constant-li and function-li hits ────────────────

describe('parseRapidSymbolSearch (RW 6.16.03 constant and function hits)', () => {
  // The classes and fields are the `_type` names and fields of hits recorded
  // 2026-09-29 on RW 6.16.03 under `?json=1`, written as the XHTML list the
  // client reads.
  const SEARCH_BODY = '<html><body><div class="state"><ul>'
    + '<li class="rap-sympropvar-li" title="RAPID/T_ROB1/user/reg5"><span class="symburl">RAPID/T_ROB1/user/reg5</span><span class="name">reg5</span><span class="symtyp">var</span><span class="named">true</span><span class="dattyp">num</span><span class="ndim">0</span><span class="dim"></span><span class="local">false</span><span class="rdonly">false</span><span class="taskvar">false</span><span class="typurl">RAPID/num</span></li>'
    + '<li class="rap-sympropconstant-li" title="RAPID/edge"><span class="symburl">RAPID/edge</span><span class="name">edge</span><span class="symtyp">con</span><span class="named">true</span><span class="linked">true</span><span class="local">true</span><span class="typurl">RAPID/dionum</span><span class="dattyp">dionum</span><span class="ndim">0</span></li>'
    + '<li class="rap-sympropfunction-li" title="RAPID/DOutput"><span class="symburl">RAPID/DOutput</span><span class="name">DOutput</span><span class="symtyp">fun</span><span class="named">true</span><span class="linked">true</span><span class="local">true</span><span class="typurl">RAPID/dionum</span><span class="dattyp">dionum</span><span class="npar">1</span></li>'
    + '<li class="rap-symproppers-li" title="RAPID/T_ROB1/BASE/load0"><span class="symburl">RAPID/T_ROB1/BASE/load0</span><span class="name">load0</span><span class="symtyp">per</span><span class="named">true</span><span class="dattyp">loaddata</span><span class="ndim">0</span><span class="dim"></span><span class="local">false</span><span class="rdonly">false</span><span class="taskpers">false</span><span class="typurl">RAPID/loaddata</span></li>'
    + '</ul></div></body></html>';

  it('keeps CONST and FUNC hits, in document order', () => {
    expect(parseRapidSymbolSearch(SEARCH_BODY).map(s => [s.name, s.symtyp, s.dattyp])).toEqual([
      ['reg5', 'var', 'num'], ['edge', 'con', 'dionum'], ['DOutput', 'fun', 'dionum'], ['load0', 'per', 'loaddata'],
    ]);
  });
});

// ─── RWS 2.0 symbol properties: CONST and FUNC ──────────────────────────────

describe('RwsClient2.getRapidSymbolProperties (RW 7.21.4 / 8.2.1 kinds)', () => {
  // Fields of TUNE_KP and BitRSh as the RW 7.21.4 and 8.2.1 symbol search
  // recorded them on 2026-09-29 (rap-sympropconstant-li,
  // rap-sympropfunction-li), under the properties `_type` without `-li`.
  const CONST_HAL = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "symbol/RAPID/TUNE_KP/data" } }  , "state" : [ { "_type" : "rap-sympropconstant", "_title" : "RAPID/TUNE_KP", "symburl" : "RAPID/TUNE_KP", "name" : "TUNE_KP", "symtyp" : "con", "named" : "true", "linked" : "true", "local" : "true", "typurl" : "RAPID/tunetype", "dattyp" : "tunetype", "ndim" : "0", "dim" : "" } ]}';
  const FUNC_HAL = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" } }  , "state" : [ { "_type" : "rap-sympropfunction", "_title" : "RAPID/BitRSh", "symburl" : "RAPID/BitRSh", "name" : "BitRSh", "symtyp" : "fun", "named" : "true", "linked" : "true", "local" : "true", "typurl" : "RAPID/byte", "dattyp" : "byte", "npar" : "2" } ]}';

  it('reads a CONST instead of an all-empty record (hal+json)', async () => {
    await withServer(hal(CONST_HAL), async client => {
      expect(await client.getRapidSymbolProperties('T_ROB1', 'M', 'TUNE_KP')).toMatchObject({
        symburl: 'RAPID/TUNE_KP', symtyp: 'con', dattyp: 'tunetype', ndim: 0, linked: true, local: true, typurl: 'RAPID/tunetype',
      });
    });
  });

  it('reads a CONST from the XHTML representation too', async () => {
    const xhtml = '<html><body><div class="state"><ul><li class="rap-sympropconstant" title="RAPID/T_ROB1/M/c1"><span class="symburl">RAPID/T_ROB1/M/c1</span><span class="symtyp">con</span><span class="dattyp">string</span><span class="ndim">0</span></li></ul></div></body></html>';
    await withServer(() => [200, XHTML, xhtml], async client => {
      expect(await client.getRapidSymbolProperties('T_ROB1', 'M', 'c1')).toMatchObject({ symtyp: 'con', dattyp: 'string' });
    });
  });

  it('reads a FUNC', async () => {
    await withServer(hal(FUNC_HAL), async client => {
      expect(await client.getRapidSymbolProperties('T_ROB1', 'M', 'BitRSh')).toMatchObject({ symtyp: 'fun', dattyp: 'byte' });
    });
  });

  it('is PARSE_ERROR when the answer has no symbol-properties block, as on RWS 1.0', async () => {
    await withServer(hal('{ "_links" : { "base" : { "href" : "https://x/rw/rapid/" } }, "state" : [ ] }'), async client => {
      await expect(client.getRapidSymbolProperties('T_ROB1', 'M', 'x')).rejects.toMatchObject({ code: 'PARSE_ERROR' });
    });
  });
});

// ─── RWS 2.0 symbol search: constant-li and function-li hits ────────────────

describe('RwsClient2.searchRapidSymbols (RW 7.21.4 / 8.2.1 constant and function hits)', () => {
  // Entries recorded 2026-09-29 on RW 7.21.4 (the same five on RW 8.2.1).
  const SEARCH_HAL = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" } }, "_embedded" : { "resources" : ['
    + '{ "_links" : { "self" : { "href" : "symbol/RAPID/SC1CBCWAR/properties" } }, "_type" : "rap-sympropvar-li", "_title" : "RAPID/SC1CBCWAR", "symburl" : "RAPID/SC1CBCWAR", "name" : "SC1CBCWAR", "symtyp" : "var", "named" : "true", "dattyp" : "signaldo", "ndim" : "0", "dim" : "", "local" : "true", "rdonly" : "false", "taskvar" : "false", "typurl" : "RAPID/signaldo" } , '
    + '{ "_links" : { "self" : { "href" : "symbol/RAPID/TUNE_KP/properties" } }, "_type" : "rap-sympropconstant-li", "_title" : "RAPID/TUNE_KP", "symburl" : "RAPID/TUNE_KP", "name" : "TUNE_KP", "symtyp" : "con", "named" : "true", "linked" : "true", "local" : "true", "typurl" : "RAPID/tunetype", "dattyp" : "tunetype", "ndim" : "0", "dim" : "" } , '
    + '{ "_links" : { "self" : { "href" : "symbol/RAPID/BitRSh/properties" } }, "_type" : "rap-sympropfunction-li", "_title" : "RAPID/BitRSh", "symburl" : "RAPID/BitRSh", "name" : "BitRSh", "symtyp" : "fun", "named" : "true", "linked" : "true", "local" : "true", "typurl" : "RAPID/byte", "dattyp" : "byte", "npar" : "2","key" : "100" } , '
    + '{ "_links" : { "self" : { "href" : "symbol/RAPID/SocketAccept/properties" } }, "_type" : "rap-sympropproc-li", "_title" : "RAPID/SocketAccept", "symburl" : "RAPID/SocketAccept", "name" : "SocketAccept", "symtyp" : "prc", "named" : "true", "local" : "true", "npar" : "4","key" : "60" } , '
    + '{ "_links" : { "self" : { "href" : "symbol/RAPID/motionprocessmode/properties" } }, "_type" : "rap-sympropalias-li", "_title" : "RAPID/motionprocessmode", "symburl" : "RAPID/motionprocessmode", "name" : "motionprocessmode", "symtyp" : "ali", "named" : "true", "linked" : "true", "local" : "true", "typurl" : "RAPID/num", "dattyp" : "num","key" : "20" } '
    + '] } }';

  it('returns CONST and FUNC hits with the VAR and PROC ones (aliases are still not listed)', async () => {
    await withServer(hal(SEARCH_HAL), async client => {
      const hits = await client.searchRapidSymbols({ task: 'T_ROB1', blockurl: 'RAPID' });
      expect(hits.map(h => [h.name, h.symtyp, h.dattyp]).sort()).toEqual([
        ['BitRSh', 'fun', 'byte'], ['SC1CBCWAR', 'var', 'signaldo'], ['SocketAccept', 'prc', ''], ['TUNE_KP', 'con', 'tunetype'],
      ]);
    });
  });

  it('reads the same classes from an XHTML answer', async () => {
    const xhtml = '<html><body><div class="state"><ul>'
      + '<li class="rap-sympropconstant-li" title="RAPID/T_ROB1/M/c1"><span class="symburl">RAPID/T_ROB1/M/c1</span><span class="name">c1</span><span class="symtyp">con</span><span class="dattyp">num</span></li>'
      + '<li class="rap-sympropfunction-li" title="RAPID/T_ROB1/M/f1"><span class="symburl">RAPID/T_ROB1/M/f1</span><span class="name">f1</span><span class="symtyp">fun</span><span class="dattyp">num</span></li>'
      + '</ul></div></body></html>';
    await withServer(() => [200, XHTML, xhtml], async client => {
      expect((await client.searchRapidSymbols({ task: 'T_ROB1', blockurl: 'RAPID/T_ROB1/M' })).map(h => [h.name, h.symtyp])).toEqual([['c1', 'con'], ['f1', 'fun']]);
    });
  });
});

// ─── RWS 2.0 symbol read: an answer with no value is an error ───────────────

describe('RwsClient2.getRapidVariable (over-ceiling reads)', () => {
  // Recorded 2026-09-29 on RW 7.21.4: a num array over the read ceiling,
  // GET .../ZZ_PROBE/zz_n110/data, 200 with 363 bytes.
  const OVER_RW7 = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "symbol//data" } }  , "state" : [ { "pgmname_ret" : { "_links": { "error": { "href": "https://127.0.0.1:5466/rw/retcode?code=-1073445865&json=1" } } } } , { "pgmname_ret2" : { "_links": { "error": { "href": "https://127.0.0.1:5466/rw/retcode?code=-1073445865" } } } } ]}';
  // Recorded 2026-09-29 on RW 8.2.1: the same read, 200 with an empty value and no link.
  const OVER_RW8 = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:80/rw/rapid/" }, "self" : { "href" : "symbol/RAPID/T_ROB1/ZZ_PROBE/zz_n110/data" } }  , "state" : [ { "_type" : "rap-data", "_title" : "RAPID/T_ROB1/ZZ_PROBE/zz_n110", "value" : "" } , { "_type" : "rap-data-decl-pos", "_title" : "decl-pos", "begin-row" : "5", "begin-coloumn" : "3", "end-row" : "5", "end-coloumn" : "25" }, { "_type" : "rap-data-initval-pos", "_title" : "initval_pos", "begin-row" : "0", "begin-coloumn" : "0", "end-row" : "0", "end-coloumn" : "0" } ]}';
  // Recorded 2026-09-29 on RW 7.21.4: a mecunit VAR, an empty value beside an error link.
  const MECUNIT_RW7 = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "symbol/RAPID/ROB_1/data" } }  , "state" : [ { "_type" : "rap-data", "_title" : "RAPID/ROB_1", "value" : "" } , { "pgmname_ret2" : { "_links": { "error": { "href": "https://127.0.0.1:5466/rw/retcode?code=-1073445879" } } } } ]}';
  // Recorded 2026-09-29 on RW 7.21.4: an ordinary num read.
  const NUM_RW7 = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "symbol/RAPID/T_ROB1/ZZ_PROBE/zz_probe_v/data" } }  , "state" : [ { "_type" : "rap-data", "_title" : "RAPID/T_ROB1/ZZ_PROBE/zz_probe_v", "value" : "1" } , { "_type" : "rap-data-decl-pos", "_title" : "decl-pos", "begin-row" : "2", "begin-coloumn" : "3", "end-row" : "2", "end-coloumn" : "26" }, { "_type" : "rap-data-initval-pos", "_title" : "initval_pos", "begin-row" : "2", "begin-coloumn" : "25", "end-row" : "2", "end-coloumn" : "25" } ]}';

  it('RW 7.21.4: no value and an error link to -1073445865 is an RwsError, not an empty value', async () => {
    await withServer(hal(OVER_RW7), async client => {
      const err = await client.getRapidVariable('T_ROB1', 'ZZ_PROBE', 'zz_n110').then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(RwsError);
      expect(err).toMatchObject({ code: 'INVALID_ARGUMENT', httpStatus: 200, controllerCode: -1073445865 });
      expect((err as RwsError).message).toMatch(/too large for one RWS read/);
      expect((err as RwsError).message).toContain('HTTP 200 from GET /rw/rapid/symbol/RAPID/T_ROB1/ZZ_PROBE/zz_n110/data');
    });
  });

  it('RW 8.2.1: an empty value with no link still reads as empty (the controller gives nothing to tell it apart)', async () => {
    await withServer(hal(OVER_RW8), async client => {
      expect(await client.getRapidVariable('T_ROB1', 'ZZ_PROBE', 'zz_n110')).toBe('');
    });
  });

  it('a present value is returned even beside an error link (a mecunit VAR reads empty)', async () => {
    await withServer(hal(MECUNIT_RW7), async client => {
      expect(await client.getRapidVariable('T_ROB1', 'M', 'ROB_1')).toBe('');
    });
    await withServer(hal(NUM_RW7), async client => {
      expect(await client.getRapidVariable('T_ROB1', 'ZZ_PROBE', 'zz_probe_v')).toBe('1');
    });
  });

  it('no value and no link is PARSE_ERROR', async () => {
    await withServer(hal('{ "_links" : { "base" : { "href" : "https://x/rw/rapid/" } }, "state" : [ ] }'), async client => {
      await expect(client.getRapidVariable('T_ROB1', 'M', 'x')).rejects.toMatchObject({ code: 'PARSE_ERROR', httpStatus: 200 });
    });
  });
});

// ─── RWS 2.0 single event-log message: another seqnum's entry is null ───────

describe('RwsClient2 single event-log reads (a seqnum the domain does not hold)', () => {
  // Recorded 2026-09-29 on RW 7.21.4: GET /rw/elog/10/106?lang=en answered 200
  // with the entry of 105 (title and self link say 105), the same body as
  // GET /rw/elog/10/105. The argument value is shortened.
  const RW7_10_105 = '{ "_links" : { "base" : { "href":"https://127.0.0.1:5466/rw/elog/" },"self" : { "href" : "10/105?lang=en" } } ,"status" : {"code":294912} , "state" : [ { "_type":"elog-message", "_title":"/rw/elog/10/105"  ,"msgtype":"3", "code":"100000", "tstamp":"2026-09-29 T 18:04:57", "title":"Internal error", "desc":"", "conseqs":"", "causes":"", "actions":"", "argc":"1" ,"argv":[ {"type":"string","value":"(shortened)"} ] } ]}';
  // Recorded 2026-09-29 on RW 8.2.1: GET /rw/elog/10/62 and /rw/elog/10/63
  // answered 200 with the entry of 61. The argument value is shortened.
  const RW8_10_61 = '{ "_links" : { "base" : { "href":"https://127.0.0.1:80/rw/elog/" },"self" : { "href" : "10/61?lang=en" } } ,"status" : {"code":294912} , "state" : [ { "_type":"elog-message", "_title":"/rw/elog/10/61"  ,"msgtype":"3", "code":"100000", "tstamp":"2026-09-29 T 15:26:28", "title":"Internal error", "desc":"", "conseqs":"", "causes":"", "actions":"", "argc":"1" ,"argv":[ {"type":"string","value":"(shortened)"} ] } ]}';
  // Recorded 2026-09-29 on RW 8.2.1: GET /rw/elog/0/85 (then the newest
  // domain-0 message) and GET /rw/elog/seqnum/85.
  const RW8_0_85 = '{ "_links" : { "base" : { "href":"https://127.0.0.1:80/rw/elog/" },"self" : { "href" : "0/85?lang=en" } } ,"status" : {"code":294912} , "state" : [ { "_type":"elog-message", "_title":"/rw/elog/0/85"  ,"msgtype":"1", "code":"10064", "tstamp":"2026-09-29 T 15:28:21", "title":"A module has been erased.", "desc":"Module ZZ_PROBE in task T_ROB1 has been erased by Default User.", "conseqs":"", "causes":"", "actions":"", "argc":"3" ,"argv":[ {"type":"string","value":"ZZ_PROBE"} , {"type":"string","value":"T_ROB1"} , {"type":"string","value":"Default User"} ] } ]}';
  const RW8_SEQNUM_85 = '{ "_links" : { "base" : { "href":"https://127.0.0.1:80/rw/elog/" },"self" : { "href" : "seqnum/85?lang=en" } } ,"status" : {"code":294912} , "state" : [ { "_type":"elog-message", "_title":"/rw/elog/seqnum/85"  ,"msgtype":"1", "code":"10064", "tstamp":"2026-09-29 T 15:28:21", "title":"A module has been erased.", "desc":"Module ZZ_PROBE in task T_ROB1 has been erased by Default User.", "conseqs":"", "causes":"", "actions":"", "argc":"3" ,"argv":[ {"type":"string","value":"ZZ_PROBE"} , {"type":"string","value":"T_ROB1"} , {"type":"string","value":"Default User"} ] } ]}';

  it('RW 7.21.4: a seqnum answered with the nearest older entry is null; that entry reads under its own seqnum', async () => {
    await withServer(hal(RW7_10_105), async client => {
      expect(await client.getEventLogMessage(10, 106)).toBeNull();
      expect(await client.getEventLogMessage(10, 105)).toMatchObject({ seqnum: 105, code: 100000, msgtype: 3, title: 'Internal error' });
    });
  });

  it('RW 8.2.1: 62 and 63, answered with the entry of 61, are null', async () => {
    await withServer(hal(RW8_10_61), async client => {
      expect(await client.getEventLogMessage(10, 62)).toBeNull();
      expect(await client.getEventLogMessage(10, 63)).toBeNull();
      expect((await client.getEventLogMessage(10, 61))?.seqnum).toBe(61);
    });
  });

  it('RW 8.2.1: a seqnum past the newest, answered with the newest message, is null (functional run 2026-09-30: 10085 read as 85)', async () => {
    const urls: string[] = [];
    await withServer((_m, url) => { urls.push(url); return [200, HAL, RW8_0_85]; }, async client => {
      expect(await client.getEventLogMessage(0, 10085, 'en')).toBeNull();
      expect(urls[0]).toBe('/rw/elog/0/10085?lang=en');
      expect(await client.getEventLogMessage(0, 85, 'en')).toMatchObject({
        seqnum: 85, code: 10064, msgtype: 1, title: 'A module has been erased.',
        args: [{ type: 'string', value: 'ZZ_PROBE' }, { type: 'string', value: 'T_ROB1' }, { type: 'string', value: 'Default User' }],
      });
    });
  });

  it('by global seqnum: the entry is returned under its own seqnum, and an entry naming another seqnum is null', async () => {
    await withServer(hal(RW8_SEQNUM_85), async client => {
      expect(await client.getEventLogMessageBySeqnum(85)).toMatchObject({ seqnum: 85, code: 10064 });
      expect(await client.getEventLogMessageBySeqnum(10085)).toBeNull();
    });
  });

  it('XHTML (rebuilt from the recorded fields): the li title is checked the same way', async () => {
    const xhtml = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:5466/rw/elog/"/></head><body><div class="state">'
      + '<ul><li class="elog-message" title="/rw/elog/0/30"><a href="0/30?lang=en" rel="self"></a><span class="msgtype">1</span><span class="code">10040</span><span class="title">Program loaded</span></li></ul>'
      + '</div></body></html>';
    await withServer(() => [200, XHTML, xhtml], async client => {
      expect(await client.getEventLogMessage(0, 32)).toBeNull();
      expect(await client.getEventLogMessage(0, 30)).toMatchObject({ seqnum: 30, code: 10040, title: 'Program loaded' });
    });
  });

  it('an entry that names no seqnum is still returned under the requested one; a self link alone is checked', async () => {
    await withServer(hal('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"elog-message","msgtype":"1","code":"10046","title":"System reset"}]}'), async client => {
      expect(await client.getEventLogMessage(0, 7)).toMatchObject({ seqnum: 7, code: 10046 });
    });
    await withServer(hal('{"_links":{"base":{"href":"https://x/rw/elog/"}},"state":[{"_links":{"self":{"href":"0/5?lang=en"}},"_type":"elog-message","msgtype":"1","code":"10046","title":"System reset"}]}'), async client => {
      expect(await client.getEventLogMessage(0, 7)).toBeNull();
      expect((await client.getEventLogMessage(0, 5))?.seqnum).toBe(5);
    });
  });

  it('traces which message the controller answered with', async () => {
    const lines: Array<{ category: string; msg: string; data: unknown }> = [];
    const noop = (): void => { /* no-op */ };
    const capture: Logger = { info: noop, warn: noop, error: noop, show: noop, trace: (category, msg, data) => { lines.push({ category, msg, data }); } };
    setLogger(capture);
    try {
      await withServer(hal(RW8_0_85), async client => {
        expect(await client.getEventLogMessage(0, 10085)).toBeNull();
      });
    } finally {
      setLogger({ info: noop, warn: noop, error: noop, show: noop, trace: noop });
    }
    const elog = lines.filter(l => l.category === 'elog');
    expect(elog).toHaveLength(1);
    expect(elog[0].msg).toBe('getEventLogMessage(0, 10085): the controller answered with message 85, not 10085; returning null');
    expect(elog[0].data).toEqual({ requested: 10085, answered: 85 });
  });
});

// ─── RWS 1.0 single event-log message: XML entities in the JSON text ────────

describe('RWS1Adapter.getEventLogMessage text entities (RW 6.16.03 ?json=1)', () => {
  // Rebuilt: the envelope and field order of a recorded RW 6.16.03 ?json=1
  // elog-message (2026-09-29), around the desc the functional run read live on
  // 2026-09-30 through GET /rw/elog/0/{seq}?lang=en&json=1. The seqnum, code,
  // timestamp and title of that message were not recorded; the ones below are
  // illustrative.
  const PROGRAM_STARTED = '{"_links":{"base": { "href":"http://127.0.0.1:4578/rw/elog/" }},"_embedded" :{  "_state":[ {"_type":"elog-message","_title":"/rw/elog/0/12" ,"msgtype":"1", "code":"10151", "src-name":"MC0", "tstamp":"2026-09-30 T 19:24:10", "title":"Program started", "desc":"Execution of task T_ROB1 has been started from the first instruction of the task&apos;s entry routine. The originator is an external client.", "conseqs":"", "causes":"", "actions":"", "argc":"0" } ] }}';
  const DECODED_DESC = "Execution of task T_ROB1 has been started from the first instruction of the task's entry routine. The originator is an external client.";

  it('decodes &apos; in the desc instead of returning it escaped', async () => {
    const { client, urls } = fakeRws1(() => ({ status: 200, body: PROGRAM_STARTED }));
    const m = await new RWS1Adapter(client).getEventLogMessage(0, 12, 'en');
    expect(urls[0]).toBe('/rw/elog/0/12?lang=en&json=1');
    expect(m).toMatchObject({ seqnum: 12, code: 10151, msgtype: 1, title: 'Program started', desc: DECODED_DESC });
  });

  it('reads the same text as the XHTML listing of the same message', async () => {
    // The listing entry rebuilt from the same fields, as GET /rw/elog/0?lang=en serves them.
    const listing = '<html><body><div class="state"><ul><li class="elog-message-li" title="/rw/elog/0/12"><span class="msgtype">1</span><span class="code">10151</span>'
      + '<span class="title">Program started</span><span class="desc">Execution of task T_ROB1 has been started from the first instruction of the task&apos;s entry routine. The originator is an external client.</span>'
      + '<span class="conseqs"></span><span class="causes"></span><span class="actions"></span><span class="argc">0</span></li></ul></div></body></html>';
    const [listed] = parseElogMessages(listing);
    const { client } = fakeRws1(() => ({ status: 200, body: PROGRAM_STARTED }));
    const single = await new RWS1Adapter(client).getEventLogMessage(0, 12, 'en');
    for (const f of ['title', 'desc', 'causes', 'consequences', 'actions'] as const) {
      expect(single?.[f], f).toBe(listed[f]);
    }
  });

  it('decodes title, causes, consequences and actions too, `&amp;` last (synthetic fields in the recorded envelope)', async () => {
    const body = PROGRAM_STARTED
      .replace('"title":"Program started"', '"title":"Task&apos;s start"')
      .replace('"conseqs":""', '"conseqs":"&quot;main&quot; &lt;x&gt;"')
      .replace('"causes":""', '"causes":"A &amp; B"')
      .replace('"actions":""', '"actions":"Keep the value &amp;lt; 10."');
    const { client } = fakeRws1(() => ({ status: 200, body }));
    expect(await new RWS1Adapter(client).getEventLogMessage(0, 12)).toMatchObject({
      title: "Task's start", desc: DECODED_DESC, causes: 'A & B',
      consequences: '"main" <x>', actions: 'Keep the value &lt; 10.',
    });
  });

  it('keeps the `Event <code>` title for an entry without a title, and plain text unchanged', async () => {
    const body = PROGRAM_STARTED.replace('"title":"Program started", ', '').replace(/"desc":"[^"]*"/, '"desc":"The speed has been adjusted to 100% by Default User."');
    const { client } = fakeRws1(() => ({ status: 200, body }));
    expect(await new RWS1Adapter(client).getEventLogMessage(0, 12)).toMatchObject({
      title: 'Event 10151', desc: 'The speed has been adjusted to 100% by Default User.',
    });
  });
});
