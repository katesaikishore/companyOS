import Database from 'better-sqlite3-multiple-ciphers';
import { createDecipheriv } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureKind } from './types';

/**
 * 'handoffs' is no longer written, since the OpenMausBot integration was removed. Its rows from earlier versions are
 * pruned once they are past the retention window, and the data export carries the rest as stored. Nothing else reads them.
 * 'renamedAutomations' holds the ids of automations the person renamed. Their names are typed, so the export replaces them.
 * 'screenText' and 'audioText' hold captured text. They are written only through appendCapture, which indexes the text
 * for search in the same transaction, so the index cannot fall out of step with the records.
 */
export const COLLECTIONS = [
  'events',
  'ledger',
  'automations',
  'autonomy',
  'settings',
  'handoffs',
  'taskDecisions',
  'renamedAutomations',
  'screenText',
  'audioText',
] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** The collections that hold captured text. Their rows are changed only by appendCapture, pruneCapture and deleteAllCapture. */
export const CAPTURE_COLLECTIONS = ['screenText', 'audioText'] as const;
export type CaptureCollection = (typeof CAPTURE_COLLECTIONS)[number];

const CAPTURE_COLLECTION_OF: Readonly<Record<CaptureKind, CaptureCollection>> = { screen: 'screenText', audio: 'audioText' };

/** The most hits one search returns. A larger limit is cut down to this. */
export const MAX_CAPTURE_HITS = 500;
const CAPTURE_SNIPPET_TOKENS = 12;
const CAPTURE_SCAN_CHARS = 240;

/**
 * One captured item to store. The text goes into the search index only. body is stored as JSON and should not repeat
 * the text.
 */
export interface CaptureRecord {
  collection: CaptureCollection;
  kind: CaptureKind;
  /**
   * The item's id. For a screen item, pass the id of its image file as well (the same value as body.mediaId), so a
   * search hit can name its image.
   */
  id: string;
  ts: number;
  app: string | null;
  text: string;
  body: unknown;
}

export interface CaptureQuery {
  /**
   * Words to find. Each is matched as a whole phrase, and the last one also as a prefix. An empty list returns the
   * newest items in range.
   */
  terms: string[];
  kind?: CaptureKind;
  /** Inclusive bounds, in ms. */
  from: number;
  to: number;
  app?: string;
  /** At most this many hits, newest first. Capped at MAX_CAPTURE_HITS. */
  limit: number;
}

export interface CaptureHit {
  kind: CaptureKind;
  id: string;
  ts: number;
  app: string | null;
  /** A short piece of the stored text: around the first match when there is one, otherwise from the start. */
  snippet: string;
}

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
 * The search index for captured text. It is created by the first capture write, not when the store opens, so a store
 * that never holds captured text has no index and is unchanged. Each row's rowid is the id of its row in records, so the
 * two are removed together.
 */
const CAPTURE_INDEX = `
  CREATE VIRTUAL TABLE IF NOT EXISTS capture_fts USING fts5(
    text, kind UNINDEXED, recordId UNINDEXED, ts UNINDEXED, app UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
  );
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
    if (isCaptureCollection(collection)) throw captureWriteError();
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
    if (isCaptureCollection(collection)) throw captureWriteError();
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

  /**
   * Stores one captured item and indexes its text, in one transaction: a record never exists without its index row.
   * The text is not stored anywhere else, so pruning and deleting remove it completely.
   */
  appendCapture(record: CaptureRecord): void {
    if (CAPTURE_COLLECTION_OF[record.kind] !== record.collection) {
      throw new Error('Capture kind does not match its collection.');
    }
    if (!Number.isSafeInteger(record.ts)) throw new Error('Capture time must be a whole number of milliseconds.');
    this.guard(() => {
      const db = this.conn();
      db.transaction(() => {
        db.exec(CAPTURE_INDEX);
        const row = db
          .prepare('INSERT INTO records (collection, body) VALUES (?, ?)')
          .run(record.collection, JSON.stringify(record.body));
        db.prepare('INSERT INTO capture_fts (rowid, text, kind, recordId, ts, app) VALUES (?, ?, ?, ?, ?, ?)').run(
          row.lastInsertRowid,
          record.text,
          record.kind,
          record.id,
          record.ts,
          record.app,
        );
      })();
    });
  }

  /**
   * Searches captured text, newest first. Terms are matched as phrases, so search syntax typed by the person is never
   * parsed. With no terms, every item in range is returned.
   */
  searchCapture(query: CaptureQuery): CaptureHit[] {
    const limit = captureLimit(query.limit);
    const terms = query.terms.map(term => term.trim()).filter(term => term.length > 0);
    const where = ['ts >= ?', 'ts <= ?'];
    const values: Array<string | number> = [query.from, query.to];
    if (query.kind !== undefined) {
      where.push('kind = ?');
      values.push(query.kind);
    }
    if (query.app !== undefined) {
      where.push('app = ?');
      values.push(query.app);
    }
    let snippet = `substr(text, 1, ${CAPTURE_SCAN_CHARS})`;
    if (terms.length > 0) {
      where.unshift('capture_fts MATCH ?');
      values.unshift(phraseQuery(terms));
      snippet = `snippet(capture_fts, 0, '', '', '…', ${CAPTURE_SNIPPET_TOKENS})`;
    }
    return this.guard(() => {
      // A store with no capture has no index, so nothing can match.
      if (!this.hasCaptureIndex()) return [];
      return this.conn()
        .prepare(
          `SELECT kind, recordId AS id, ts, app, ${snippet} AS snippet
           FROM capture_fts WHERE ${where.join(' AND ')}
           ORDER BY ts DESC, rowid DESC LIMIT ?`,
        )
        .all(...values, limit) as CaptureHit[];
    });
  }

  /**
   * Deletes captured items older than the cutoff, with their text. Returns the image ids of the deleted screen items,
   * so the caller can delete the image files too.
   */
  pruneCapture(cutoffMs: number): { removed: number; mediaIds: string[] } {
    return this.guard(() => {
      const db = this.conn();
      // One transaction: the images are listed before their rows go, and the rows and index go together.
      return db.transaction((): { removed: number; mediaIds: string[] } => {
        if (!this.hasCaptureIndex()) return { removed: 0, mediaIds: [] };
        const mediaIds = (
          db
            .prepare(
              `SELECT json_extract(r.body, '$.mediaId') AS mediaId FROM capture_fts f JOIN records r ON r.id = f.rowid
               WHERE f.kind = 'screen' AND f.ts < ? AND json_extract(r.body, '$.mediaId') IS NOT NULL`,
            )
            .all(cutoffMs) as Array<{ mediaId: string }>
        ).map(row => row.mediaId);
        const removed = db
          .prepare('DELETE FROM records WHERE id IN (SELECT rowid FROM capture_fts WHERE ts < ?)')
          .run(cutoffMs).changes;
        db.prepare('DELETE FROM capture_fts WHERE ts < ?').run(cutoffMs);
        return { removed, mediaIds };
      })();
    });
  }

  /** Deletes every captured item and its text. Returns the image ids, so the caller can delete the image files too. */
  deleteAllCapture(): { mediaIds: string[] } {
    return this.guard(() => {
      const db = this.conn();
      return db.transaction(() => {
        const mediaIds = (
          db
            .prepare(
              `SELECT json_extract(body, '$.mediaId') AS mediaId FROM records
               WHERE collection = 'screenText' AND json_extract(body, '$.mediaId') IS NOT NULL`,
            )
            .all() as Array<{ mediaId: string }>
        ).map(row => row.mediaId);
        db.prepare(`DELETE FROM records WHERE collection IN ('screenText', 'audioText')`).run();
        if (this.hasCaptureIndex()) db.prepare('DELETE FROM capture_fts').run();
        return { mediaIds };
      })();
    });
  }

  /**
   * Deletes the captured items of one app, with their text and index rows. Returns their image ids, so the caller can
   * delete the image files too. The name is compared as stored, which is the name the agent normalised.
   */
  deleteCaptureForApp(app: string): { mediaIds: string[] } {
    return this.guard(() => {
      const db = this.conn();
      return db.transaction((): { mediaIds: string[] } => {
        if (!this.hasCaptureIndex()) return { mediaIds: [] };
        // The images are listed before their rows go, in the same transaction.
        const mediaIds = (
          db
            .prepare(
              `SELECT json_extract(r.body, '$.mediaId') AS mediaId FROM capture_fts f JOIN records r ON r.id = f.rowid
               WHERE f.app = ? AND json_extract(r.body, '$.mediaId') IS NOT NULL`,
            )
            .all(app) as Array<{ mediaId: string }>
        ).map(row => row.mediaId);
        db.prepare('DELETE FROM records WHERE id IN (SELECT rowid FROM capture_fts WHERE app = ?)').run(app);
        db.prepare('DELETE FROM capture_fts WHERE app = ?').run(app);
        return { mediaIds };
      })();
    });
  }

  /** The distinct app names of the stored captured items. Lets the agent find the items of an app that is now excluded. */
  captureApps(): string[] {
    return this.guard(() => {
      if (!this.hasCaptureIndex()) return [];
      return (
        this.conn().prepare('SELECT DISTINCT app FROM capture_fts WHERE app IS NOT NULL').all() as Array<{ app: string }>
      ).map(row => row.app);
    });
  }

  /**
   * Replaces the image reference of the given screen items with null. Their text stays. Call it once the image files
   * are deleted, so the store no longer names an image that is gone. The ids are image ids: for a screen item, its item
   * id is the same value.
   */
  clearCaptureMedia(mediaIds: readonly string[]): void {
    if (mediaIds.length === 0) return;
    this.guard(() => {
      this.conn()
        .prepare(
          `UPDATE records SET body = json_set(body, '$.mediaId', json('null'))
           WHERE collection = 'screenText' AND json_extract(body, '$.mediaId') IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify(mediaIds));
    });
  }

  /** How many captured items are stored, by kind. */
  captureCounts(): { screen: number; audio: number } {
    return this.guard(() => {
      const rows = this.conn()
        .prepare(
          `SELECT collection, count(*) AS n FROM records
           WHERE collection IN ('screenText', 'audioText') GROUP BY collection`,
        )
        .all() as Array<{ collection: CaptureCollection; n: number }>;
      const count = (collection: CaptureCollection): number => rows.find(row => row.collection === collection)?.n ?? 0;
      return { screen: count('screenText'), audio: count('audioText') };
    });
  }

  /** The oldest screen items that have an image, oldest first. Used to keep the image folder under its size cap. */
  oldestScreenMedia(limit: number): Array<{ id: string; mediaId: string; ts: number }> {
    const max = captureLimit(limit);
    return this.guard(() => {
      if (!this.hasCaptureIndex()) return [];
      return this.conn()
        .prepare(
          `SELECT f.recordId AS id, json_extract(r.body, '$.mediaId') AS mediaId, f.ts AS ts FROM capture_fts f JOIN records r ON r.id = f.rowid
           WHERE f.kind = 'screen' AND json_extract(r.body, '$.mediaId') IS NOT NULL ORDER BY f.ts ASC, f.rowid ASC LIMIT ?`,
        )
        .all(max) as Array<{ id: string; mediaId: string; ts: number }>;
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

  /** Whether the search index exists. Only a capture write creates it, so a store without captured text has none. */
  private hasCaptureIndex(): boolean {
    return this.conn().prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'capture_fts'`).get() !== undefined;
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

function isCaptureCollection(collection: Collection): collection is CaptureCollection {
  return (CAPTURE_COLLECTIONS as readonly string[]).includes(collection);
}

function captureWriteError(): Error {
  return new Error('Captured text is written through appendCapture, not append or replaceAll.');
}

/** A search or listing limit. Must be a whole number of at least 1, and is capped at MAX_CAPTURE_HITS. */
function captureLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('The limit must be a whole number of at least 1.');
  return Math.min(limit, MAX_CAPTURE_HITS);
}

/**
 * Builds an FTS5 query from words. Each word is a quoted phrase, with inner quotes doubled, so FTS operators such as
 * AND, NEAR, * or column filters typed by the person are only ever text. The last word also matches as a prefix.
 */
function phraseQuery(terms: string[]): string {
  return terms
    .map((term, index) => `"${term.replace(/"/g, '""')}"${index === terms.length - 1 ? '*' : ''}`)
    .join(' ');
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
