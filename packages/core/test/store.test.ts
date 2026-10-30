import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedStore } from '../src';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'twin-store-'));
}

describe('EncryptedStore', () => {
  it('round-trips records', () => {
    const store = new EncryptedStore(freshDir(), randomBytes(32));
    store.append('events', { a: 1 });
    store.append('events', { a: 2 });
    expect(store.readAll('events')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('never writes plaintext to disk', () => {
    const dir = freshDir();
    const store = new EncryptedStore(dir, randomBytes(32));
    store.append('events', { secret: 'plaintext-canary-7731' });
    const raw = readFileSync(join(dir, 'events.log'), 'utf8');
    expect(raw).not.toContain('plaintext-canary-7731');
  });

  it('cannot be read with another key', () => {
    const dir = freshDir();
    new EncryptedStore(dir, randomBytes(32)).append('events', { a: 1 });
    expect(() => new EncryptedStore(dir, randomBytes(32)).readAll('events')).toThrow(/Corrupt record/);
  });

  it('detects tampering in the middle of the log', () => {
    const dir = freshDir();
    const store = new EncryptedStore(dir, randomBytes(32));
    store.append('events', { a: 1 });
    store.append('events', { a: 2 });
    const path = join(dir, 'events.log');
    const [first, second] = readFileSync(path, 'utf8').split('\n');
    const flipped = Buffer.from(first, 'base64');
    flipped[flipped.length - 1] ^= 0xff;
    writeFileSync(path, `${flipped.toString('base64')}\n${second}\n`);
    expect(() => store.readAll('events')).toThrow(/Corrupt record/);
  });

  it('ignores a final record cut short by a crash', () => {
    const dir = freshDir();
    const store = new EncryptedStore(dir, randomBytes(32));
    store.append('events', { a: 1 });
    appendFileSync(join(dir, 'events.log'), 'AAAA');
    expect(store.readAll('events')).toEqual([{ a: 1 }]);
  });

  it('binds records to their collection', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const store = new EncryptedStore(dir, key);
    store.append('events', { a: 1 });
    writeFileSync(join(dir, 'ledger.log'), readFileSync(join(dir, 'events.log')));
    expect(() => store.readAll('ledger')).toThrow(/Corrupt record/);
  });

  it('replaces a whole collection atomically', () => {
    const store = new EncryptedStore(freshDir(), randomBytes(32));
    store.append('settings', { v: 1 });
    store.replaceAll('settings', [{ v: 2 }]);
    expect(store.readAll('settings')).toEqual([{ v: 2 }]);
  });

  it('wipe removes all files', () => {
    const dir = freshDir();
    const store = new EncryptedStore(dir, randomBytes(32));
    store.append('events', { a: 1 });
    store.wipe();
    expect(existsSync(join(dir, 'events.log'))).toBe(false);
    expect(store.readAll('events')).toEqual([]);
  });

  it('requires a 32-byte key', () => {
    expect(() => new EncryptedStore(freshDir(), randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('crash recovery', () => {
  it('cuts a torn tail so the next record starts on a fresh line', () => {
    const dir = freshDir();
    const store = new EncryptedStore(dir, randomBytes(32));
    store.append('events', { a: 1 });
    appendFileSync(join(dir, 'events.log'), 'QUJDREVG');
    store.append('events', { a: 2 });
    expect(store.readAll('events')).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
