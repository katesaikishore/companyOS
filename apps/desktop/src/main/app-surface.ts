import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { surfaceOf, type AppSurface } from '@companyos/twin-core';

/** Application names: letters, digits, spaces and a few punctuation marks, up to 80 characters. */
export const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .\-()]{0,79}$/u;
const READ_TIMEOUT_MS = 15_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/**
 * The visible controls of one application, read with the agent-desktop program the person set in Settings. The program is
 * called with a fixed argument list and no shell, and only its snapshot is read. Only control names and roles come back.
 */
export function readSurface(binary: string, app: string): Promise<AppSurface> {
  if (!isAbsolute(binary)) return Promise.reject(new Error('The agent-desktop program path must be absolute.'));
  if (!APP_NAME.test(app)) return Promise.reject(new Error('That application name is not allowed.'));
  return new Promise((resolve, reject) => {
    execFile(binary, ['snapshot', '--app', app, '--compact'], { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_SNAPSHOT_BYTES }, (error, stdout) => {
      if (error) {
        reject(new Error('agent-desktop could not read that application.'));
        return;
      }
      try {
        resolve(surfaceOf(app, JSON.parse(stdout)));
      } catch {
        reject(new Error('agent-desktop gave a snapshot that could not be read.'));
      }
    });
  });
}
