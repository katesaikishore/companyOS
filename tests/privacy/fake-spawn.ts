import { EventEmitter } from 'node:events';

/** Every process the app asked to start, with its arguments. These count as outbound payloads. */
export const spawnLog: Array<{ command: string; args: string[] }> = [];

/**
 * Stands in for cross-spawn in the suite. It records the command line, then answers like a completed OpenMausBot
 * job. The OpenMausBot handoff passes the prompt as an argument, so the recorded arguments are what leaves the app.
 */
export function fakeSpawn(command: string, args: readonly string[] = []) {
  spawnLog.push({ command, args: [...args] });
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const child = Object.assign(new EventEmitter(), { stdout, kill: () => true });
  setImmediate(() => {
    stdout.emit('data', JSON.stringify({ state: 'completed', reply: 'Handed off.' }));
    child.emit('close', 0);
  });
  return child;
}
