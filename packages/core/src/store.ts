import Database from 'better-sqlite3-multiple-ciphers';
import { createDecipheriv } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const COLLECTIONS = ['events', 'ledger', 'automations', 'autonomy', 'settings'] as const;
export type Collection = (typeof COLLECTIONS)[number];

const DATABASE_FILE = 'twin.db';
const MIGRATION_FILE = `${DATABASE_FILE}.migrating`;
const BUSY_TIMEOUT_MS = 5_000;
const UNREADABLE = 'The encrypted store cannot be read. The key is wrong or the file was modified.';

/** Layout of the MVP's record logs, read only to import them once. */
const LEGACY_ALGORITHM = 'aes-256-gcm';
const LEGACY_IV_BYTES = 12;
const LEGACY_TAG_BYTES = 16;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY,
    collection TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS records_by_collection ON records (collection, id);
`;

/**
 * The twin's encrypted store: one SQLCipher database (SQLCipher 4 format, through SQLite3 Multiple Ciphers) opened
 * with the 32-byte data key. Each record is stored as its JSON text, in insertion order, under its collection.
 *
 * SQLCipher encrypts every page of the main file, the journal and the WAL, and authenticates each page with an HMAC.
 * A changed byte makes the page unreadable, so the read fails instead of returning altered data. Destroying the key
 * makes every file unreadable (crypto-shredding).
 */
export class EncryptedStore {
  private db: Database.Database | null;
  private readonly path: string;

  constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('Data key must be 32 bytes.');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, DATABASE_FILE);
    this.db = this.openWithMigration();
  }

  append(collection: Collection, record: unknown): void {
    this.guard(() => {
      const insert = this.conn().prepare('INSERT INTO records (collection, body) VALUES (?, ?)');
      insert.run(collection, JSON.stringify(record));
    });
  }

  readAll<T = unknown>(collection: Collection): T[] {
    return this.guard(() => {
      const rows = this.conn()
        .prepare('SELECT body FROM records WHERE collection = ? ORDER BY id')
        .all(collection) as Array<{ body: string }>;
      return rows.map(row => JSON.parse(row.body) as T);
    });
  }

  /** Atomically replaces a whole collection. Used for small collections such as settings. */
  replaceAll(collection: Collection, records: readonly unknown[]): void {
    this.guard(() => {
      const db = this.conn();
      const insert = db.prepare('INSERT INTO records (collection, body) VALUES (?, ?)');
      // One transaction: if any record fails to serialise, the old contents are kept.
      db.transaction(() => {
        db.prepare('DELETE FROM records WHERE collection = ?').run(collection);
        for (const record of records) insert.run(collection, JSON.stringify(record));
      })();
    });
  }

  /** Bytes on disk for the database and its WAL. Shown to the person; the content stays encrypted. */
  sizeBytes(): number {
    return [this.path, `${this.path}-wal`].reduce(
      (total, file) => total + (existsSync(file) ? statSync(file).size : 0),
      0,
    );
  }

  /** Closes the connection. Pages in the WAL are written into the main file first. */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Closes the store and deletes the database with its side files and any legacy logs. The store is not reopened:
   * the caller destroys the key next, and a new file must not be created under a key that is about to go.
   */
  wipe(): void {
    this.close();
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`, join(this.dir, MIGRATION_FILE)]) {
      rmSync(file, { force: true });
    }
    this.removeLegacyFiles();
  }

  private conn(): Database.Database {
    if (!this.db) throw new Error('The store is closed.');
    return this.db;
  }

  /** SQLCipher reports a wrong key or an altered page as NOTADB or CORRUPT. Both mean the store cannot be trusted. */
  private guard<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      throw asStoreError(error);
    }
  }

  /**
   * Opens the database. A store from the MVP's record logs is imported once, when no database exists yet. The import
   * is written to a side file and renamed into place only when complete. An interrupted import is retried on the next
   * start, and the old logs are deleted last.
   */
  private openWithMigration(): Database.Database {
    rmSync(join(this.dir, MIGRATION_FILE), { force: true });
    const hasLogs = COLLECTIONS.some(collection => existsSync(join(this.dir, `${collection}.log`)));
    if (existsSync(this.path)) {
      // The database is complete, so legacy files still present belong to an import that finished but did not clean up.
      this.removeLegacyFiles();
    } else if (hasLogs) {
      this.importLegacyLogs();
    }
    return this.connect(this.path);
  }

  private importLegacyLogs(): void {
    // Every log is read before anything is written, so a log that cannot be opened leaves the old files untouched.
    const rows: Array<[Collection, unknown]> = [];
    for (const collection of COLLECTIONS) {
      for (const record of readLegacyLog(join(this.dir, `${collection}.log`), collection, this.key)) {
        rows.push([collection, record]);
      }
    }
    const staged = this.connect(join(this.dir, MIGRATION_FILE));
    try {
      const insert = staged.prepare('INSERT INTO records (collection, body) VALUES (?, ?)');
      staged.transaction(() => {
        for (const [collection, record] of rows) insert.run(collection, JSON.stringify(record));
      })();
    } finally {
      staged.close();
    }
    renameSync(join(this.dir, MIGRATION_FILE), this.path);
    this.removeLegacyFiles();
  }

  /** The MVP's `<collection>.log` files and their `.tmp` leftovers. Removed only after the database is in place. */
  private removeLegacyFiles(): void {
    for (const collection of COLLECTIONS) {
      rmSync(join(this.dir, `${collection}.log`), { force: true });
      rmSync(join(this.dir, `${collection}.log.tmp`), { force: true });
    }
  }

  private connect(path: string): Database.Database {
    if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
    const db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
    try {
      db.pragma("cipher = 'sqlcipher'");
      db.pragma('legacy = 4');
      // Raw key form (x'' with 64 hex digits): the 32 random bytes are the key, so no passphrase derivation runs on
      // each open. Passed to key() rather than in PRAGMA text, so an error cannot echo the key back.
      const keyText = Buffer.from(`x'${this.key.toString('hex')}'`);
      try {
        db.key(keyText);
      } finally {
        keyText.fill(0);
      }
      // Reading the schema decrypts and authenticates the first page, so a wrong key fails here.
      db.prepare('SELECT count(*) FROM sqlite_schema').get();
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      // Deleted records (pruning, excluded apps) are overwritten in the pages, not left in free space.
      db.pragma('secure_delete = ON');
      db.exec(SCHEMA);
      return db;
    } catch (error) {
      db.close();
      throw asStoreError(error);
    }
  }
}

function asStoreError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' ? new Error(UNREADABLE, { cause: error }) : error;
}

/**
 * Reads one legacy record log. Each line is an AES-256-GCM record sealed with the collection name as associated data.
 * A last line with no newline is a write cut short by a crash, so it is skipped, but only after an earlier record has
 * opened under this key. Otherwise the key is wrong (or the file is not a log), and the error keeps the log in place.
 */
function readLegacyLog(path: string, collection: Collection, key: Buffer): unknown[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  const records: unknown[] = [];
  lines.forEach((line, index) => {
    if (line.length === 0) return;
    try {
      records.push(JSON.parse(openLegacyRecord(key, collection, line)));
    } catch (error) {
      const tornTail = index === lines.length - 1 && records.length > 0;
      if (!tornTail) throw new Error(`Corrupt record in ${collection} at line ${index + 1}.`, { cause: error });
    }
  });
  return records;
}

function openLegacyRecord(key: Buffer, collection: Collection, line: string): string {
  const buffer = Buffer.from(line, 'base64');
  if (buffer.length < LEGACY_IV_BYTES + LEGACY_TAG_BYTES) throw new Error('Record is too short.');
  const decipher = createDecipheriv(LEGACY_ALGORITHM, key, buffer.subarray(0, LEGACY_IV_BYTES));
  decipher.setAAD(Buffer.from(collection));
  decipher.setAuthTag(buffer.subarray(LEGACY_IV_BYTES, LEGACY_IV_BYTES + LEGACY_TAG_BYTES));
  const body = Buffer.concat([decipher.update(buffer.subarray(LEGACY_IV_BYTES + LEGACY_TAG_BYTES)), decipher.final()]);
  return body.toString('utf8');
}
