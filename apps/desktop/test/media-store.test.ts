import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveMediaKey, MediaDecryptError } from '@companyos/twin-core';
import { MediaStore } from '../src/main/media-store';

/** Planted in the image bytes. It must never appear in a stored file. Never printed. */
const CANARY = 'SCREEN_OCR_CANARY_4471';
const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function jpegBytes(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(CANARY)]);
}

describe('MediaStore', () => {
  let base: string;
  let dir: string;
  let store: MediaStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'media-store-test-'));
    dir = join(base, 'media');
    store = new MediaStore(dir, deriveMediaKey(randomBytes(32)));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function fileOf(id: string): string {
    return join(dir, `${id}.bin`);
  }

  function ageFile(path: string): void {
    const old = new Date(Date.now() - TWO_HOURS_MS);
    utimesSync(path, old, old);
  }

  it('reads back the same image that was written', async () => {
    await store.write(ID_A, jpegBytes());
    expect((await store.read(ID_A)).equals(jpegBytes())).toBe(true);
  });

  it('keeps no readable image bytes on disk', async () => {
    await store.write(ID_A, jpegBytes());
    expect(readFileSync(fileOf(ID_A)).includes(Buffer.from(CANARY))).toBe(false);
  });

  it('keeps the folder and each file readable by this user only', async () => {
    if (process.platform === 'win32') return;
    await store.write(ID_A, jpegBytes());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(fileOf(ID_A)).mode & 0o777).toBe(0o600);
  });

  it('does not open under another id, so a copied file is refused', async () => {
    await store.write(ID_A, jpegBytes());
    copyFileSync(fileOf(ID_A), fileOf(ID_B));
    await expect(store.read(ID_B)).rejects.toBeInstanceOf(MediaDecryptError);
  });

  it('does not open with another key', async () => {
    await store.write(ID_A, jpegBytes());
    const other = new MediaStore(dir, deriveMediaKey(randomBytes(32)));
    await expect(other.read(ID_A)).rejects.toBeInstanceOf(MediaDecryptError);
  });

  it('does not open a file with one changed byte', async () => {
    await store.write(ID_A, jpegBytes());
    const bytes = readFileSync(fileOf(ID_A));
    bytes[bytes.length - 1] ^= 0x01;
    writeFileSync(fileOf(ID_A), bytes);
    await expect(store.read(ID_A)).rejects.toBeInstanceOf(MediaDecryptError);
  });

  it('refuses an id that is not 32 lower-case hex characters, so no path can be built from it', async () => {
    await expect(store.write('../escape', jpegBytes())).rejects.toThrow('The image id is not valid.');
    await expect(store.read('A'.repeat(32))).rejects.toThrow('The image id is not valid.');
  });

  it('removes the named files and ignores an id with no file', async () => {
    await store.write(ID_A, jpegBytes());
    await store.write(ID_B, jpegBytes());
    await store.remove([ID_A, ID_C]);
    expect(existsSync(fileOf(ID_A))).toBe(false);
    expect(existsSync(fileOf(ID_B))).toBe(true);
  });

  it('reconcile keeps live and young files, and removes old unreferenced files and old temporary files', async () => {
    await store.write(ID_A, jpegBytes());
    await store.write(ID_B, jpegBytes());
    await store.write(ID_C, jpegBytes());
    ageFile(fileOf(ID_A));
    ageFile(fileOf(ID_B));
    const temp = join(dir, `${ID_C}.abcdef.tmp`);
    writeFileSync(temp, 'partial');
    ageFile(temp);
    const unrelated = join(dir, 'notes.bin');
    writeFileSync(unrelated, 'not ours');
    ageFile(unrelated);

    const removed = await store.reconcile(new Set([ID_A]));

    expect(removed).toBe(2);
    expect(existsSync(fileOf(ID_A))).toBe(true);
    expect(existsSync(fileOf(ID_B))).toBe(false);
    expect(existsSync(fileOf(ID_C))).toBe(true);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('sizeBytes adds up the files on disk', async () => {
    await store.write(ID_A, jpegBytes());
    await store.write(ID_B, jpegBytes());
    expect(await store.sizeBytes()).toBe(statSync(fileOf(ID_A)).size + statSync(fileOf(ID_B)).size);
  });

  it('sizeBytes is zero when the folder does not exist', async () => {
    expect(await store.sizeBytes()).toBe(0);
  });

  it('wipe removes the folder, and a later write makes it again', async () => {
    await store.write(ID_A, jpegBytes());
    await store.wipe();
    expect(existsSync(dir)).toBe(false);
    await store.write(ID_B, jpegBytes());
    expect(existsSync(fileOf(ID_B))).toBe(true);
  });
});
