import { spawn } from 'node:child_process';

/**
 * Whether macOS secure event input is on, which means a password or other secure field may hold focus. macOS writes a
 * session entry with the process id of the app that turned secure input on, and it removes the entry when the app turns
 * it off. The check fails closed: an error, a timeout or a failed probe counts as secure input on, so screen capture
 * stops rather than read a password field. Other systems have no such state to read, so they report 'unknown'.
 */
const IOREG = '/usr/sbin/ioreg';
const PROBE_TIMEOUT_MS = 10_000;
const SECURE_INPUT_PID = /"kCGSSessionSecureInputPID"=(\d+)/;
/** Enough of the last output to hold the whole match when it is split across two reads. */
const MATCH_TAIL_CHARS = 64;

export function secureInputState(): Promise<boolean | 'unknown'> {
  if (process.platform !== 'darwin') return Promise.resolve('unknown');
  return new Promise(resolve => {
    let tail = '';
    let settled = false;
    // The output is read as it arrives and not kept, so a large registry dump never sits in memory.
    const child = spawn(IOREG, ['-l', '-w0'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
    const finish = (secure: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(secure);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const window = tail + chunk;
      const match = SECURE_INPUT_PID.exec(window);
      // A process id of zero would mean secure input is off, so only a positive id counts.
      if (match) finish(Number(match[1]) > 0);
      else tail = window.slice(-MATCH_TAIL_CHARS);
    });
    // A missing binary or a failed run gives an error or a non-zero exit. Its text is never read or sent anywhere.
    child.on('error', () => finish(true));
    child.on('close', code => finish(code !== 0));
  });
}
