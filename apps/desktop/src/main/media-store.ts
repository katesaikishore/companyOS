import { openMedia, sealMedia } from '@companyos/twin-core';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Keeps the captured screen images as sealed files, one per image, in the media folder. Each file is written to a
 * temporary name and then renamed, so a crash never leaves a half-written image under its real name. The folder and the
 * files are readable by this user only. A file that does not open is reported with a fixed message, never its contents.
 */
const MEDIA_ID = /^[0-9a-f]{32}$/;
const FILE_SUFFIX = '.bin';
const TEMP_SUFFIX = '.tmp';
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
/** A file this young may belong to a write that has not yet reached the store, so reconcile leaves it alone. */
const DEFAULT_MIN_AGE_MS = 3_600_000;

/** The id is the file's associated data, so a file moved under another id does not open. */
function associatedData(mediaId: string): Buffer {
  return Buffer.from(`media:${mediaId}`);
}

export class MediaStore {
  constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {}

  /** Seals one JPEG and stores it under its id. */
  async write(mediaId: string, jpeg: Buffer): Promise<void> {
    const path = this.pathFor(mediaId);
    await mkdir(this.dir, { recursive: true, mode: FOLDER_MODE });
    const sealed = sealMedia(this.key, jpeg, associatedData(mediaId));
    const temp = `${path}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`;
    await writeFile(temp, sealed, { mode: FILE_MODE, flag: 'wx' });
    await rename(temp, path);
  }

  /** Opens one stored JPEG. Throws when the file is missing, the key is wrong or the file was changed. */
  async read(mediaId: string): Promise<Buffer> {
    const sealed = await readFile(this.pathFor(mediaId));
    return openMedia(this.key, sealed, associatedData(mediaId));
  }

  /** Deletes the files for these ids. An id with no file is skipped. */
  async remove(mediaIds: string[]): Promise<void> {
    await Promise.all(mediaIds.filter(id => MEDIA_ID.test(id)).map(id => rm(this.pathFor(id), { force: true })));
  }

  /**
   * Deletes files that no stored row names, and temporary files left by a crash. A file newer than minAgeMs is kept, so
   * a write that is still in progress is not removed. Returns how many files were deleted.
   */
  async reconcile(liveIds: Set<string>, minAgeMs = DEFAULT_MIN_AGE_MS): Promise<number> {
    const names = await readdir(this.dir).catch(() => []);
    const now = Date.now();
    let removed = 0;
    for (const name of names) {
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile() || now - info.mtimeMs < minAgeMs) continue;
      // Only names this store would write are touched. Anything else in the folder is left as it is.
      const stem = name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : '';
      const orphan = MEDIA_ID.test(stem) && !liveIds.has(stem);
      if (orphan || name.endsWith(TEMP_SUFFIX)) {
        await rm(path, { force: true });
        removed++;
      }
    }
    return removed;
  }

  /** The bytes the folder uses on disk. */
  async sizeBytes(): Promise<number> {
    const names = await readdir(this.dir).catch(() => []);
    const sizes = await Promise.all(
      names.map(async name => (await stat(join(this.dir, name)).catch(() => undefined))?.size ?? 0),
    );
    return sizes.reduce((total, size) => total + size, 0);
  }

  /** Removes the whole folder. A later write makes it again. */
  async wipe(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private pathFor(mediaId: string): string {
    if (!MEDIA_ID.test(mediaId)) throw new Error('The image id is not valid.');
    return join(this.dir, `${mediaId}${FILE_SUFFIX}`);
  }
}
