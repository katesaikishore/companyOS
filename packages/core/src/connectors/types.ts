import { createHash } from 'node:crypto';

/**
 * The shape every local connector produces. A connector only parses what the person chose to share (a calendar file, a
 * folder of notes, a Git repository's history, an mbox export). It opens no network connection, and the desktop app
 * decides which files and repositories it reads.
 *
 * Items pass through the redaction module at ingest, so a connector may keep text that a later step removes. A connector
 * never stores a sender address, a token or a credential it happens to see.
 */

/** Where an item came from. Each connector module produces one of these. */
export const CONNECTOR_KINDS = ['calendar', 'folder', 'git', 'mail', 'issue'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** One imported item. The integrator stores it through the normal ingest path. */
export interface ConnectorItem {
  source: ConnectorKind;
  /** Stable for the same item across imports, so importing again does not duplicate it. A hash, never a raw identifier. */
  sourceId: string;
  /** Milliseconds since the epoch: the event start, the file's modification time, the message date or the commit date. */
  ts: number;
  /** One line, at most CONNECTOR_TITLE_MAX characters. */
  title: string;
  /** At most CONNECTOR_TEXT_MAX characters. A longer text is cut and ends with CONNECTOR_TRUNCATION_MARK. */
  text: string;
  /** Where the item can be found again, such as a file's path inside its folder or an event's location. */
  location?: string;
}

export const CONNECTOR_TITLE_MAX = 200;
export const CONNECTOR_TEXT_MAX = 20_000;
/** A location names a place, so it is shorter than a text. */
export const CONNECTOR_LOCATION_MAX = 500;
/** Appended to a title, text or location that was cut to fit its limit. */
export const CONNECTOR_TRUNCATION_MARK = ' [truncated]';

/** What a parser knows about one item before the limits are applied. */
export interface ConnectorItemFields {
  source: ConnectorKind;
  sourceId: string;
  ts: number;
  title: string;
  text: string;
  location?: string | undefined;
}

/**
 * Builds an item with the limits applied: the title becomes one line of at most 200 characters (or "(untitled)" when it is
 * empty), the text is cleaned of control characters and cut at 20000 with a marker, and the location is one line of at
 * most 500. Returns null when ts is not a finite number, so the caller skips the item.
 */
export function buildItem(fields: ConnectorItemFields): ConnectorItem | null {
  if (!Number.isFinite(fields.ts)) return null;
  const title = oneLine(fields.title);
  const item: ConnectorItem = {
    source: fields.source,
    sourceId: fields.sourceId,
    ts: fields.ts,
    title: title === '' ? '(untitled)' : truncateText(title, CONNECTOR_TITLE_MAX),
    text: truncateText(cleanText(fields.text), CONNECTOR_TEXT_MAX),
  };
  const location = oneLine(fields.location ?? '');
  if (location !== '') item.location = truncateText(location, CONNECTOR_LOCATION_MAX);
  return item;
}

/**
 * Cuts a value to at most `max` UTF-16 units, ending it with CONNECTOR_TRUNCATION_MARK when it was cut. The cut never
 * leaves half of a surrogate pair.
 */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  let head = value.slice(0, Math.max(0, max - CONNECTOR_TRUNCATION_MARK.length));
  const last = head.charCodeAt(head.length - 1);
  if (head.length > 0 && last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head + CONNECTOR_TRUNCATION_MARK;
}

/** Line endings become "\n", and control characters other than tab and newline are removed. */
export function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

/** Collapses every run of whitespace and control characters to one space. */
export function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
}

/**
 * A stable source id for an item that has no id of its own: the first 32 hex characters of a SHA-256 over the parts. The
 * parts are JSON-encoded first, so the boundary between two parts cannot be moved to make two items collide.
 */
export function connectorSourceId(...parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * Splits text on a separator that is not inside a double-quoted run. Used for parameter lists such as
 * `TZID="Europe/London";VALUE=DATE` and for header parameters.
 */
export function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === separator && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Removes one pair of surrounding double quotes, if present. */
export function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Parses `head;KEY=value;KEY2="quoted;value"` into the head and a map of lower-case keys. A parameter without `=` is
 * ignored. A Map is used so that a key such as `__proto__` cannot change an object's prototype.
 */
export function parseParameters(text: string): { head: string; params: Map<string, string> } {
  const [head = '', ...rest] = splitOutsideQuotes(text, ';');
  const params = new Map<string, string>();
  for (const piece of rest) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    params.set(piece.slice(0, eq).trim().toLowerCase(), unquote(piece.slice(eq + 1).trim()));
  }
  return { head: head.trim(), params };
}
