import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COLLECTIONS = ['events', 'ledger', 'automations', 'autonomy', 'settings'] as const;
export type Collection = (typeof COLLECTIONS)[number];

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Append-only, record-encrypted log per collection. Each record is sealed with AES-256-GCM under the
 * data key, with the collection name as associated data, so records cannot be moved between files
 * unnoticed. Destroying the key makes every record unreadable (crypto-shredding).
 *
 * MVP storage. The target is SQLCipher; see docs/plan for the spike that decides it.
 */
export class EncryptedStore {
  constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('Data key must be 32 bytes.');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  append(collection: Collection, record: unknown): void {
    appendFileSync(this.fileFor(collection), `${this.seal(collection, JSON.stringify(record))}\n`, { mode: 0o600 });
  }

  readAll<T = unknown>(collection: Collection): T[] {
    const path = this.fileFor(collection);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n');
    const records: T[] = [];
    lines.forEach((line, index) => {
      if (line.length === 0) return;
      try {
        records.push(JSON.parse(this.open(collection, line)) as T);
      } catch (error) {
        // A last line with no newline is a write interrupted by a crash. Skip it.
        if (index === lines.length - 1) return;
        throw new Error(`Corrupt record in ${collection} at line ${index + 1}.`, { cause: error });
      }
    });
    return records;
  }

  /** Atomically replaces a whole collection. Used for small collections such as settings. */
  replaceAll(collection: Collection, records: readonly unknown[]): void {
    const path = this.fileFor(collection);
    const tmp = `${path}.tmp`;
    const body = records.map(record => `${this.seal(collection, JSON.stringify(record))}\n`).join('');
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  }

  wipe(): void {
    for (const collection of COLLECTIONS) {
      const path = this.fileFor(collection);
      rmSync(path, { force: true });
      rmSync(`${path}.tmp`, { force: true });
    }
  }

  private fileFor(collection: Collection): string {
    return join(this.dir, `${collection}.log`);
  }

  private seal(collection: Collection, plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(collection));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  private open(collection: Collection, line: string): string {
    const buffer = Buffer.from(line, 'base64');
    if (buffer.length < IV_BYTES + TAG_BYTES) throw new Error('Record is too short.');
    const decipher = createDecipheriv(ALGORITHM, this.key, buffer.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(collection));
    decipher.setAuthTag(buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const body = Buffer.concat([decipher.update(buffer.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    return body.toString('utf8');
  }
}
