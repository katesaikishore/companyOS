import { buildItem, connectorSourceId, type ConnectorItem } from './types';

/**
 * Pure logic for the folder connector. The desktop app lists the files of a folder it was given, and this module decides
 * which of them are imported and turns each one into an item. Nothing here touches the disk.
 *
 * A file is kept when its extension is .md, .markdown, .txt, .html or .htm, when no segment of its path starts with a dot,
 * when it is at most 1 MB, and when its sourceId is not already known. Markdown and plain text keep their text as it is.
 * HTML has its scripts, styles and tags removed and its entities decoded.
 *
 * A changed file has a new modification time, so it has a new sourceId and is imported again. The earlier version is not
 * removed by this module; the integrator decides what to do with it.
 */

export interface FolderEntry {
  /** The path inside the folder, with "/" between segments. */
  relativePath: string;
  /** The modification time, in milliseconds since the epoch. */
  mtimeMs: number;
  /** The size in bytes. */
  size: number;
}

export const FOLDER_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt', '.html', '.htm'];
/** Files larger than this are not imported. */
export const FOLDER_MAX_BYTES = 1024 * 1024;

/** The entries to import: supported files of the right size whose sourceId is not in the known set. */
export function selectFolderEntries(entries: readonly FolderEntry[], known: ReadonlySet<string>): FolderEntry[] {
  return entries.filter((entry) => isFolderCandidate(entry) && !known.has(folderSourceId(entry)));
}

/** A hash of the path and the modification time, so the same file version gives the same id on every import. */
export function folderSourceId(entry: FolderEntry): string {
  return connectorSourceId('folder', normalisePath(entry.relativePath), String(entry.mtimeMs));
}

/**
 * Builds the item for one file. The title is the file name without its extension, the ts is the modification time, and
 * the location is the path inside the folder. An HTML file's text is its visible text.
 */
export function folderItem(entry: FolderEntry, content: string): ConnectorItem {
  const name = fileName(entry.relativePath);
  const extension = extensionOf(name);
  const body = content.replace(/^﻿/, '');
  const text = extension === '.html' || extension === '.htm' ? htmlToText(body) : body;
  const item = buildItem({
    source: 'folder',
    sourceId: folderSourceId(entry),
    ts: entry.mtimeMs,
    title: name.slice(0, name.length - extension.length),
    text,
    location: normalisePath(entry.relativePath),
  });
  if (!item) throw new Error('The file has no valid modification time.');
  return item;
}

/**
 * The visible text of an HTML document. Comments, scripts, styles, templates and the head are removed. Block-level tags
 * become line breaks, other tags become spaces, and entities are decoded after the tags are removed, so an escaped "&lt;"
 * stays text.
 */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*$/i, ' ');
  text = text.replace(/<\/?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/?[a-z!][^>]*>/gi, ' ');
  text = decodeEntities(text);
  return text
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

/** Decodes the named entities above and numeric references. An entity that is not known is left as it is. */
function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (match: string, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid = Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? match;
  });
}

function isFolderCandidate(entry: FolderEntry): boolean {
  const segments = entry.relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return false;
  if (!Number.isFinite(entry.size) || entry.size < 0 || entry.size > FOLDER_MAX_BYTES) return false;
  return FOLDER_EXTENSIONS.includes(extensionOf(fileName(entry.relativePath)));
}

function normalisePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function fileName(relativePath: string): string {
  return relativePath.split(/[\\/]/).pop() ?? relativePath;
}

/** The lower-case extension with its dot, or '' when the name has none. A name that starts with a dot has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}
