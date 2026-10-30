import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedStore } from '../src';

const CANARY = 'legacy-canary-5519';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'twin-migrate-'));
}

/** Seals one record the way the MVP's record log did: AES-256-GCM, collection name as associated data. */
function sealLegacy(key: Buffer, collection: string, record: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(collection));
  const body = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function writeLegacyLog(dir: string, collection: string, key: Buffer, records: unknown[]): void {
  const body = records.map(record => `${sealLegacy(key, collection, record)}\n`).join('');
  writeFileSync(join(dir, `${collection}.log`), body, { mode: 0o600 });
}

describe('import of the MVP record logs', () => {
  it('imports every collection in order, deletes the old logs and keeps the data after a reopen', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    writeLegacyLog(dir, 'events', key, [{ kind: 'focus', app: CANARY }, { kind: 'focus', app: 'Slack' }]);
    writeLegacyLog(dir, 'settings', key, [{ v: 1 }, { v: 2 }]);
    writeLegacyLog(dir, 'ledger', key, [{ host: 'huggingface.co' }]);

    const store = new EncryptedStore(dir, key);
    expect(store.readAll('events')).toEqual([{ kind: 'focus', app: CANARY }, { kind: 'focus', app: 'Slack' }]);
    expect(store.readAll('settings')).toEqual([{ v: 1 }, { v: 2 }]);
    expect(store.readAll('ledger')).toEqual([{ host: 'huggingface.co' }]);
    expect(store.readAll('automations')).toEqual([]);
    store.close();

    expect(readdirSync(dir).filter(name => name.endsWith('.log'))).toEqual([]);
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name)).includes(CANARY)).toBe(false);
    }

    const reopened = new EncryptedStore(dir, key);
    expect(reopened.readAll('events')).toHaveLength(2);
    reopened.close();
  });

  it('keeps the old logs and writes no database when the key cannot open them', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    writeLegacyLog(dir, 'events', key, [{ a: 1 }]);
    expect(() => new EncryptedStore(dir, randomBytes(32))).toThrow(/Corrupt record in events/);
    expect(existsSync(join(dir, 'events.log'))).toBe(true);
    expect(existsSync(join(dir, 'twin.db'))).toBe(false);

    const store = new EncryptedStore(dir, key);
    expect(store.readAll('events')).toEqual([{ a: 1 }]);
    store.close();
  });

  it('skips a final legacy record cut short by a crash', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    writeLegacyLog(dir, 'events', key, [{ a: 1 }]);
    appendFileSync(join(dir, 'events.log'), 'AAAA');
    const store = new EncryptedStore(dir, key);
    expect(store.readAll('events')).toEqual([{ a: 1 }]);
    store.close();
  });

  it('retries an import that was interrupted before it was complete', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    writeLegacyLog(dir, 'events', key, [{ a: 1 }]);
    writeFileSync(join(dir, 'twin.db.migrating'), 'partial import');
    const store = new EncryptedStore(dir, key);
    expect(store.readAll('events')).toEqual([{ a: 1 }]);
    store.close();
    expect(existsSync(join(dir, 'twin.db.migrating'))).toBe(false);
  });

  it('removes legacy logs that an import left behind after it had finished', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    writeLegacyLog(dir, 'events', key, [{ a: 1 }]);
    new EncryptedStore(dir, key).close();
    writeLegacyLog(dir, 'events', key, [{ a: 1 }]);
    const store = new EncryptedStore(dir, key);
    expect(store.readAll('events')).toEqual([{ a: 1 }]);
    store.close();
    expect(existsSync(join(dir, 'events.log'))).toBe(false);
  });
});
