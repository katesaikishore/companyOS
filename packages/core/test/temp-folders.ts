import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/** Anything a test opens that must be closed before its folder is removed, such as a TwinAgent or a store. */
export interface Closable {
  close(): void;
}

/**
 * Temporary folders for one test file. Call it once, at the top level of the file, not inside a describe.
 * The folders made by folder() and the objects passed to track() are cleaned up when the file's tests finish.
 * Objects close first, because Windows will not delete a store that is still open. Closing twice is safe.
 * Every object is closed and every folder is removed, even if one of them fails. The first failure is then thrown.
 */
export function tempFolders(): { folder(prefix: string): string; track<T extends Closable>(value: T): T } {
  const folders: string[] = [];
  const opened: Closable[] = [];
  afterAll(() => {
    let failure: unknown;
    for (const value of opened.splice(0).reverse()) {
      try {
        value.close();
      } catch (error) {
        failure ??= error;
      }
    }
    for (const folder of folders.splice(0)) {
      try {
        rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  });
  return {
    folder(prefix) {
      const folder = mkdtempSync(join(tmpdir(), prefix));
      folders.push(folder);
      return folder;
    },
    track(value) {
      opened.push(value);
      return value;
    },
  };
}
