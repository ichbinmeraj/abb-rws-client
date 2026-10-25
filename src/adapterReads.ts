/**
 * The reads `RobotManager.read(name, ...args)` reaches on the connected
 * adapter: one small generic read path instead of one manager wrapper per
 * read. Each entry is a method this package's adapters already have, with the
 * signature they have; the manager calls it by name and passes its answer and
 * its errors through unchanged. Reads only: a write keeps its own manager
 * method, which takes the access it needs (`appealWriteAccessRelease` among
 * them).
 *
 * Adding a read here is one line in `AdapterReads` and one in
 * `ADAPTER_READ_NAMES`; nothing else changes.
 */

import type { ElogMessage, RapidBuildError, ReturnCodeInfo } from './types.js';

/** The event-log domains and how many messages each holds (null: not reported). */
export interface EventLogDomain { domain: number; events: number | null; bufferSize: number | null }

/**
 * The reads `RobotManager.read` takes, by name, with their arguments and
 * answers. Which generation has each is said per entry; an adapter without
 * the method answers `UNSUPPORTED_OPERATION` and nothing is sent.
 */
export interface AdapterReads {
  /** One event-log message by domain and sequence number; null when the domain holds no message under it. Both generations. */
  getEventLogMessage(domain: number, seqnum: number, lang?: string): Promise<ElogMessage | null>;
  /** One event-log message by its sequence number, whatever its domain (`GET /rw/elog/seqnum/{n}`). RWS 2.0. */
  getEventLogMessageBySeqnum(seqnum: number, lang?: string): Promise<ElogMessage | null>;
  /** The event-log domains (`GET /rw/elog`); RobotWare 6 reports no counts (null). Both generations. */
  listEventLogDomains(): Promise<EventLogDomain[]>;
  /** This session's control-station type: `none`, `remote` or `local` (`GET /rw/controlstation/type`). RobotWare 8. */
  getControlStationType(): Promise<string>;
  /** This session's control-station id, `none` before it registers (`GET /rw/controlstation/id`). RobotWare 8. */
  getControlStationId(): Promise<string>;
  /** Whether a local control station (the FlexPendant) is connected (`GET /rw/controlstation/local/isconnected`). RobotWare 8. */
  isLocalControlStationConnected(): Promise<boolean>;
  /** The FlexPendant safety-protocol status (`GET /rw/controlstation/tpu/safety/protocol/status`). RobotWare 8. */
  getTpuSafetyProtocolStatus(): Promise<boolean>;
  /** The count of write-access release appeals (`GET .../writeaccess/release/appeal/changecount`). RobotWare 8. */
  getWriteAccessAppealChangeCount(): Promise<number>;
  /** The grants of the logged-in user (RWS 1.0 `GET /users/grants`, RWS 2.0 `GET /uas/user/grants`). Both generations. */
  listCurrentUserGrants(): Promise<string[]>;
  /** Whether the logged-in user holds one grant (`GET /users/grant-exists`). RWS 2.0. */
  checkGrantExists(grant: string): Promise<boolean>;
  /** A controller return code in words, with its severity (`GET /rw/retcode?code=N`); null when the controller does not know it. Both generations. */
  describeReturnCode(code: number): Promise<ReturnCodeInfo | null>;
  /**
   * The build errors of a task's program, every page (`GET .../program/builderror`); `[]` when it builds. Both generations
   * (run on RW 6.16.03, 7.21.4 and 8.2.1, 2026-10-21).
   */
  getBuildErrors(task: string): Promise<RapidBuildError[]>;
  /**
   * Whether the most recent RAPID execution stop was caused by an error (`GET /rw/rapid/execution/execerrorstate`).
   * RobotWare 8.2 and later: RobotWare 7 answers 404, RWS 1.0 has no such read (run on RW 8.2.1, 2026-10-21).
   */
  getExecutionErrorState(): Promise<boolean>;
}

/** A read's name. */
export type AdapterReadName = keyof AdapterReads;

/** Every name in `AdapterReads`, checked against it at compile time both ways. */
export const ADAPTER_READ_NAMES = [
  'getEventLogMessage',
  'getEventLogMessageBySeqnum',
  'listEventLogDomains',
  'getControlStationType',
  'getControlStationId',
  'isLocalControlStationConnected',
  'getTpuSafetyProtocolStatus',
  'getWriteAccessAppealChangeCount',
  'listCurrentUserGrants',
  'checkGrantExists',
  'describeReturnCode',
  'getBuildErrors',
  'getExecutionErrorState',
] as const satisfies readonly AdapterReadName[];

/** Compile-time check: no `AdapterReads` member is missing from the list. */
type MissingName = Exclude<AdapterReadName, typeof ADAPTER_READ_NAMES[number]>;
const _complete: [MissingName] extends [never] ? true : MissingName = true;
void _complete;

/** True when `name` is one of the reads `RobotManager.read` takes. */
export function isAdapterReadName(name: unknown): name is AdapterReadName {
  return typeof name === 'string' && (ADAPTER_READ_NAMES as readonly string[]).includes(name);
}
