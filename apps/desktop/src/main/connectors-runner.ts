import type { Stats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FOLDER_MAX_BYTES,
  folderItem,
  parseGitLog,
  parseIcs,
  parseMbox,
  selectFolderEntries,
  type ConnectorItem,
  type TwinConfig,
} from '@companyos/twin-core';
import {
  FOLDER_READ_FAILED_MESSAGE,
  GIT_LOG_FAILED_MESSAGE,
  GIT_LOG_LIMIT_MESSAGE,
  GIT_NOT_REPOSITORY_MESSAGE,
  listFolderFiles,
  readGitLog,
} from './connectors-local';
import type { LocalConnectorKind } from './connectors-validate';

/**
 * Reads one local source and stores what it finds. A source is a folder, a Git repository, a calendar file or a mail
 * archive that the person chose. Each import reads the whole source first, and only then replaces the items the source
 * held before. So a read that fails keeps the old items, and a file that was deleted leaves no item behind. A folder too large
 * to read in full is refused, not cut short. Nothing here writes to the source, and nothing here opens a network connection.
 */

type ConnectorSource = TwinConfig['connectors'][number];

/** The part of the engine this module uses. The desktop runtime passes its agent, and the tests pass a fake. */
export interface ConnectorStore {
  readonly configuration: TwinConfig;
  ingestConnectorItems(sourceKey: string, items: readonly ConnectorItem[]): number;
  removeConnectorItems(sourceKey: string): number;
  updateConfig(patch: Partial<TwinConfig>): TwinConfig;
}

export interface LocalImportDeps {
  agent: ConnectorStore;
  /** Milliseconds since the epoch. Sets the calendar window and the time of the import. */
  now: () => number;
}

export type LocalImportOutcome = { ok: true; count: number } | { ok: false; message: string };

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

export const CALENDAR_MAX_BYTES = 10 * MB;
export const MAIL_MAX_BYTES = 50 * MB;
/** A calendar import keeps events from this many days before the import to this many days after it. */
export const CALENDAR_DAYS_BACK = 180;
export const CALENDAR_DAYS_AHEAD = 365;
export const MAIL_MAX_MESSAGES = 5000;
/** A folder import reads at most this many supported files. A folder with more is refused, so its earlier items stay. */
export const FOLDER_MAX_FILES = 5000;
/** A folder import keeps at most this many characters of item text. A folder with more is refused, as above. */
export const FOLDER_MAX_CHARS = 64_000_000;
/** Items are stored in batches, so a large import does not hold the main process for one long write. */
const STORE_BATCH = 200;

export const IMPORT_FAILED_MESSAGE = 'The source could not be read. Its items were not changed.';
export const STORE_FAILED_MESSAGE = 'The items could not be stored. Import the source again.';
export const SOURCE_FILE_FAILED_MESSAGE = 'The file could not be read.';
export const CALENDAR_TOO_LARGE_MESSAGE = 'The calendar file is larger than 10 MB, so it was not read.';
export const MAIL_TOO_LARGE_MESSAGE = 'The mail archive is larger than 50 MB, so it was not read.';
export const SOURCE_PATH_MISSING_MESSAGE = 'The chosen folder or file could not be found.';
export const SOURCE_MISSING_MESSAGE = 'That source is no longer saved.';
export const SOURCE_PATH_KIND_MESSAGE = 'Choose a folder for this source.';
export const SOURCE_PATH_FILE_MESSAGE = 'Choose a file for this source.';
export const FOLDER_TOO_MANY_MESSAGE =
  'This folder has more files than one import reads, so the import was not saved. The earlier import is kept.';

/** The messages a read may end with. Anything else an error carries is replaced by IMPORT_FAILED_MESSAGE. */
const KNOWN_MESSAGES: ReadonlySet<string> = new Set([
  FOLDER_READ_FAILED_MESSAGE,
  GIT_NOT_REPOSITORY_MESSAGE,
  GIT_LOG_FAILED_MESSAGE,
  GIT_LOG_LIMIT_MESSAGE,
  SOURCE_FILE_FAILED_MESSAGE,
  CALENDAR_TOO_LARGE_MESSAGE,
  MAIL_TOO_LARGE_MESSAGE,
  FOLDER_TOO_MANY_MESSAGE,
]);

/**
 * Imports one local source. Resolves to the number of items stored, or to a fixed sentence. A cloud source is refused,
 * since its reads are made elsewhere. The source's lastImportedAt is set through the agent's config on success.
 */
export async function runLocalSource(source: ConnectorSource, deps: LocalImportDeps): Promise<LocalImportOutcome> {
  const now = deps.now();
  let items: ConnectorItem[];
  try {
    items = await readItems(source, now);
  } catch (error) {
    // Nothing is stored yet, so the items the source held are still there.
    return { ok: false, message: knownMessage(error) };
  }
  try {
    return await storeItems(source, items, now, deps.agent);
  } catch {
    return { ok: false, message: STORE_FAILED_MESSAGE };
  }
}

/**
 * Replaces the source's items with the new ones and records the import time. The earlier items go only after the new ones
 * were read. A source that was removed meanwhile is cleared again, so no item is left without its source.
 */
async function storeItems(
  source: ConnectorSource,
  items: readonly ConnectorItem[],
  now: number,
  agent: ConnectorStore,
): Promise<LocalImportOutcome> {
  // The engine refuses items for a source that is not saved, so that is checked before anything is written.
  if (!isSaved(agent, source.id)) return { ok: false, message: SOURCE_MISSING_MESSAGE };
  agent.removeConnectorItems(source.id);
  let count = 0;
  for (let start = 0; start < items.length; start += STORE_BATCH) {
    count += agent.ingestConnectorItems(source.id, items.slice(start, start + STORE_BATCH));
    if (start + STORE_BATCH < items.length) await yieldTurn();
  }
  if (!isSaved(agent, source.id)) {
    agent.removeConnectorItems(source.id);
    return { ok: false, message: SOURCE_MISSING_MESSAGE };
  }
  const saved = agent.configuration.connectors;
  agent.updateConfig({ connectors: saved.map(item => (item.id === source.id ? { ...item, lastImportedAt: now } : item)) });
  return { ok: true, count };
}

function isSaved(agent: ConnectorStore, id: string): boolean {
  return agent.configuration.connectors.some(item => item.id === id);
}

/**
 * Checks a path the person chose before it is saved: it must exist, be a folder for a folder or Git source and a file for a
 * calendar or mail source, and a file must be within its size limit. Resolves to a fixed sentence, or to undefined when the
 * path is fine.
 */
export async function checkSourcePath(kind: LocalConnectorKind, path: string): Promise<string | undefined> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch {
    return SOURCE_PATH_MISSING_MESSAGE;
  }
  if (kind === 'folder' || kind === 'git') return info.isDirectory() ? undefined : SOURCE_PATH_KIND_MESSAGE;
  if (!info.isFile()) return SOURCE_PATH_FILE_MESSAGE;
  if (kind === 'calendar' && info.size > CALENDAR_MAX_BYTES) return CALENDAR_TOO_LARGE_MESSAGE;
  if (kind === 'mail' && info.size > MAIL_MAX_BYTES) return MAIL_TOO_LARGE_MESSAGE;
  return undefined;
}

async function readItems(source: ConnectorSource, now: number): Promise<ConnectorItem[]> {
  const path = source.path;
  if (path === undefined || path === '') throw new Error(SOURCE_FILE_FAILED_MESSAGE);
  switch (source.kind) {
    case 'folder':
      return readFolderItems(path);
    case 'git':
      return parseGitLog(await readGitLog(path));
    case 'calendar': {
      const text = await readText(path, CALENDAR_MAX_BYTES, CALENDAR_TOO_LARGE_MESSAGE);
      return parseIcs(text, { from: now - CALENDAR_DAYS_BACK * DAY_MS, to: now + CALENDAR_DAYS_AHEAD * DAY_MS });
    }
    case 'mail': {
      const text = await readText(path, MAIL_MAX_BYTES, MAIL_TOO_LARGE_MESSAGE);
      return parseMbox(text, { maxMessages: MAIL_MAX_MESSAGES });
    }
    default:
      throw new Error(IMPORT_FAILED_MESSAGE);
  }
}

/** The limits of a folder read. The import uses the defaults; a test may pass smaller ones. */
export interface FolderReadLimits {
  /** Directory entries the walk visits. */
  scanLimit?: number;
  /** Supported files one import reads. */
  maxFiles?: number;
  /** Characters of item text one import keeps. */
  maxChars?: number;
}

/**
 * The items of a folder's supported files, each at most 1 MB. A file that cannot be read now is skipped, as the others are
 * read. A folder that cannot be read in full, or holds too many files or too much text, is refused with
 * FOLDER_TOO_MANY_MESSAGE. Refusing keeps the earlier items, where a part of the folder would replace them.
 */
export async function readFolderItems(root: string, limits: FolderReadLimits = {}): Promise<ConnectorItem[]> {
  const maxFiles = limits.maxFiles ?? FOLDER_MAX_FILES;
  const maxChars = limits.maxChars ?? FOLDER_MAX_CHARS;
  const listing = await listFolderFiles(root, { limit: limits.scanLimit });
  const entries = selectFolderEntries(listing.files, new Set());
  if (listing.truncated || entries.length > maxFiles) throw new Error(FOLDER_TOO_MANY_MESSAGE);

  const items: ConnectorItem[] = [];
  let chars = 0;
  for (const entry of entries) {
    let file: CappedFile;
    try {
      file = await readCapped(join(root, entry.relativePath), FOLDER_MAX_BYTES);
    } catch {
      continue;
    }
    if (file.kind !== 'ok') continue;
    let item: ConnectorItem;
    try {
      item = folderItem(entry, decodeText(file.bytes));
    } catch {
      // An entry without a usable modification time is skipped.
      continue;
    }
    chars += item.text.length;
    if (chars > maxChars) throw new Error(FOLDER_TOO_MANY_MESSAGE);
    items.push(item);
  }
  return items;
}

async function readText(path: string, maxBytes: number, tooLarge: string): Promise<string> {
  const file = await readCapped(path, maxBytes);
  if (file.kind === 'too-large') throw new Error(tooLarge);
  return decodeText(file.bytes);
}

/**
 * The text of a file's bytes. UTF-8 when the bytes are valid UTF-8, otherwise Windows-1252, which older text and mail files
 * are often saved in. The two encodings are fixed, so a file never chooses its own decoder.
 */
function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

type CappedFile = { kind: 'ok'; bytes: Buffer } | { kind: 'too-large' };

/**
 * The bytes of a regular file, or 'too-large' when it is over maxBytes. At most maxBytes + 1 bytes are read, so a file that
 * grows while it is read is still refused. A file that cannot be opened, or is not a regular file, is a fixed failure.
 */
async function readCapped(path: string, maxBytes: number): Promise<CappedFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    throw new Error(SOURCE_FILE_FAILED_MESSAGE);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(SOURCE_FILE_FAILED_MESSAGE);
    if (info.size > maxBytes) return { kind: 'too-large' };
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return { kind: 'too-large' };
    return { kind: 'ok', bytes: buffer.subarray(0, filled) };
  } finally {
    await handle.close();
  }
}

function knownMessage(error: unknown): string {
  if (error instanceof Error && KNOWN_MESSAGES.has(error.message)) return error.message;
  return IMPORT_FAILED_MESSAGE;
}

function yieldTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
