import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedStore } from '../src';

const PAGE_BYTES = 4096;
const CANARY = 'plaintext-canary-7731';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'twin-store-'));
}

/** Raw bytes of every file in the store folder: the database, its WAL and shared memory. */
function rawFiles(dir: string): Buffer[] {
  return readdirSync(dir).map(name => readFileSync(join(dir, name)));
}

describe('EncryptedStore', () => {
  it('round-trips records, in order, across a reopen', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const store = new EncryptedStore(dir, key);
    store.append('events', { a: 1 });
    store.append('events', { a: 2 });
    expect(store.readAll('events')).toEqual([{ a: 1 }, { a: 2 }]);
    store.close();
    expect(new EncryptedStore(dir, key).readAll('events')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('never writes plaintext to disk, including the WAL', () => {
    const dir = freshDir();
    const store = new EncryptedStore(dir, randomBytes(32));
    store.append('events', { secret: CANARY });
    const open = rawFiles(dir);
    // The WAL exists while the store is open, so the check covers it as well as the main file.
    expect(open.length).toBeGreaterThan(1);
    store.close();
    for (const raw of [...open, ...rawFiles(dir)]) {
      expect(raw.includes(CANARY)).toBe(false);
      expect(raw.includes('CREATE TABLE')).toBe(false);
      expect(raw.includes('records_by_collection')).toBe(false);
      expect(raw.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    }
  });

  it('cannot be read with another key', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    new EncryptedStore(dir, key).append('events', { a: 1 });
    expect(() => new EncryptedStore(dir, randomBytes(32))).toThrow(/cannot be read/);
    const store = new EncryptedStore(dir, key);
    expect(store.readAll('events')).toEqual([{ a: 1 }]);
    store.close();
  });

  it('is unreadable once the only copy of its key is gone (crypto-shredding)', () => {
    const dir = freshDir();
    const store = new EncryptedStore(dir, randomBytes(32));
    store.append('events', { secret: CANARY });
    store.close();
    // Crypto-shredding: once the key is gone, nothing can reopen the file. A test cannot remove the keychain entry,
    // so it checks the same property with a key that did not write the file.
    expect(() => new EncryptedStore(dir, randomBytes(32))).toThrow(/cannot be read/);
    for (const raw of rawFiles(dir)) expect(raw.includes(CANARY)).toBe(false);
  });

  it('detects a changed byte in any data page', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const store = new EncryptedStore(dir, key);
    for (let i = 0; i < 100; i++) store.append('events', { i, pad: 'x'.repeat(200) });
    store.close();
    const path = join(dir, 'twin.db');
    const original = readFileSync(path);
    const pages = original.length / PAGE_BYTES;
    expect(pages).toBeGreaterThan(3);
    for (let page = 2; page <= pages; page++) {
      const tampered = Buffer.from(original);
      tampered[(page - 1) * PAGE_BYTES + 100] ^= 0x01;
      writeFileSync(path, tampered);
      const reopened = new EncryptedStore(dir, key);
      try {
        expect(() => reopened.readAll('events'), `page ${page}`).toThrow(/cannot be read/);
      } finally {
        reopened.close();
      }
    }
  });

  it('detects a changed byte in the schema page when the store opens', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    new EncryptedStore(dir, key).close();
    const path = join(dir, 'twin.db');
    const original = readFileSync(path);
    const tampered = Buffer.from(original);
    tampered[100] ^= 0x01;
    writeFileSync(path, tampered);
    expect(() => new EncryptedStore(dir, key)).toThrow(/cannot be read/);
  });

  it('ignores a partly written transaction left at the end of the WAL', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const store = new EncryptedStore(dir, key);
    store.append('events', { a: 1 });
    appendFileSync(join(dir, 'twin.db-wal'), randomBytes(1000));
    const other = new EncryptedStore(dir, key);
    expect(other.readAll('events')).toEqual([{ a: 1 }]);
    other.close();
    // A later write must not be lost behind the damaged bytes.
    store.append('events', { a: 2 });
    store.close();
    expect(new EncryptedStore(dir, key).readAll('events')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('shares one database between two engine instances on the same folder', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const first = new EncryptedStore(dir, key);
    const second = new EncryptedStore(dir, key);
    first.append('events', { n: 1 });
    second.append('events', { n: 2 });
    expect(first.readAll('events')).toEqual([{ n: 1 }, { n: 2 }]);
    expect(second.readAll('events')).toEqual([{ n: 1 }, { n: 2 }]);
    first.close();
    second.close();
  });

  it('replaces a whole collection atomically', () => {
    const store = new EncryptedStore(freshDir(), randomBytes(32));
    store.append('settings', { v: 1 });
    store.replaceAll('settings', [{ v: 2 }]);
    expect(store.readAll('settings')).toEqual([{ v: 2 }]);
    store.close();
  });

  it('keeps the old contents when a replacement fails part way', () => {
    const store = new EncryptedStore(freshDir(), randomBytes(32));
    store.append('settings', { v: 1 });
    // BigInt cannot be serialised, so the second record fails after the first has been written.
    expect(() => store.replaceAll('settings', [{ v: 2 }, { v: 3n }])).toThrow();
    expect(store.readAll('settings')).toEqual([{ v: 1 }]);
    store.close();
  });

  it('wipe removes the database and its side files, and leaves the store closed', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const store = new EncryptedStore(dir, key);
    store.append('events', { a: 1 });
    store.wipe();
    expect(readdirSync(dir)).toEqual([]);
    expect(() => store.readAll('events')).toThrow(/closed/);
    expect(existsSync(join(dir, 'twin.db'))).toBe(false);
    expect(new EncryptedStore(dir, key).readAll('events')).toEqual([]);
  });

  it('requires a 32-byte key', () => {
    expect(() => new EncryptedStore(freshDir(), randomBytes(16))).toThrow(/32 bytes/);
  });
});
