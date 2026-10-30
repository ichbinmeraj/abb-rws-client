/**
 * Compiled by tests/operations.types.test.ts against src: RobotManager.call
 * is typed from the routes. Each `@ts-expect-error` line must be an error, so
 * the types cannot widen to anything-goes without the test failing.
 */
import { RobotManager, OPERATIONS, operationArgs, type OperationArgs, type OperationKey, type Signal } from '../../src/index.js';

declare const m: RobotManager;

export async function typed(): Promise<void> {
  // A manager route: the RobotManager method's parameters and answer.
  await m.call('rapid.setRapidVariable', ['T_ROB1', 'MainModule', 'nCount', '5']);
  // @ts-expect-error a number where the method declares a string
  await m.call('rapid.setRapidVariable', ['T_ROB1', 'MainModule', 'nCount', 5]);
  // @ts-expect-error too few arguments
  await m.call('rapid.setRapidVariable', ['T_ROB1']);

  // An adapter route.
  const signal: Signal = await m.call('io.readSignalByName', ['diStart']);
  void signal;
  // @ts-expect-error the answer is a Signal, not a number
  const wrong: number = await m.call('io.readSignalByName', ['diStart']);
  void wrong;

  // Motors on and off: the state picks the RobotManager method.
  const done: void = await m.call('panel.setControllerState', ['motoron']);
  void done;
  // @ts-expect-error not a motors state
  await m.call('panel.setControllerState', ['motorup']);

  // A composite: the module push takes a path on this PC and a task.
  await m.call('rapid.pushModule', ['C:/cell/Main.mod', 'T_ROB1', { stopIfRunning: true }]);

  // @ts-expect-error not an operation key
  await m.call('rapid.noSuchOperation', []);

  // The catalogue's keys are the keys call takes.
  const key: OperationKey = OPERATIONS['ctrl.listBackups'].key;
  void key;
  const args: OperationArgs<'cfgElogDipc.getCfgInstance'> = ['EIO', 'EIO_SIGNAL', 'diStart'];
  void args;
  // @ts-expect-error a key that is not an operation
  const bad: OperationKey = 'panel.nope';
  void bad;
  void operationArgs('rapid.getRapidVariable', { task: 'T_ROB1', module: 'MainModule', symbol: 'nCount' });
}
