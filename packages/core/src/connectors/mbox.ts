import { buildItem, connectorSourceId, parseParameters, type ConnectorItem } from './types';

/**
 * Reads an mbox text (the format Thunderbird and most mail exports write) and returns one mail item per message.
 *
 * A message starts at a line beginning "From ", and body lines escaped as ">From " are restored to "From ". The title is
 * the Subject, with RFC 2047 encoded words decoded. The ts is the Date header. The sender is never read and never stored.
 *
 * The text is the first text/plain part, in document order. A multipart message is searched through its nested parts,
 * and attachments are skipped; a part marked inline is read even when it has a file name. The body is decoded from quoted-printable or base64 and from its charset, and it is cut to
 * the item limit. A message whose only text is HTML is skipped and counted in skippedHtmlOnly, and so is a message with no
 * readable Date header (skippedNoDate). A message with no text part keeps its subject and has an empty text.
 *
 * The first maxMessages messages of the file are read, in file order. Text before the first "From " line is not a
 * message, unless the file has no such line at all, in which case the whole text is read as one message. sourceId is a
 * hash of the Message-ID, or of the Subject, Date and position when there is no Message-ID. A message that repeats an
 * earlier sourceId is returned once.
 */

export interface MboxOptions {
  /** The most messages to read from the start of the file. A value that is not a finite number reads none. */
  maxMessages: number;
}

export interface MboxResult {
  items: ConnectorItem[];
  /** Messages read, which is at most maxMessages. */
  messages: number;
  /** Messages skipped because their only text is HTML. */
  skippedHtmlOnly: number;
  /** Messages skipped because they have no Date header that can be read. */
  skippedNoDate: number;
}

/** The most levels of multipart nesting that are searched for a text part. */
const MAX_NESTING = 8;
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

interface Entity {
  headers: Map<string, string>;
  /** The lower-case media type. An empty string means the default, text/plain. */
  type: string;
  params: Map<string, string>;
  disposition: string;
  dispositionParams: Map<string, string>;
  encoding: string;
  body: string;
}

interface Found {
  plain: Entity | null;
  html: boolean;
}

type Outcome = { kind: 'item'; item: ConnectorItem } | { kind: 'htmlOnly' } | { kind: 'noDate' };

/** Returns the mail items of an mbox text. See the module comment for what is read and what is skipped. */
export function parseMbox(text: string, options: MboxOptions): ConnectorItem[] {
  return parseMboxWithStats(text, options).items;
}

/** The same as parseMbox, with counts of what was read and what was skipped. */
export function parseMboxWithStats(text: string, options: MboxOptions): MboxResult {
  const result: MboxResult = { items: [], messages: 0, skippedHtmlOnly: 0, skippedNoDate: 0 };
  const limit = Number.isFinite(options.maxMessages) ? Math.max(0, Math.floor(options.maxMessages)) : 0;
  if (limit === 0) return result;

  const seen = new Set<string>();
  splitMessages(text)
    .slice(0, limit)
    .forEach((raw, position) => {
      result.messages += 1;
      const outcome = readMessage(raw, position);
      if (outcome.kind === 'htmlOnly') {
        result.skippedHtmlOnly += 1;
      } else if (outcome.kind === 'noDate') {
        result.skippedNoDate += 1;
      } else if (!seen.has(outcome.item.sourceId)) {
        seen.add(outcome.item.sourceId);
        result.items.push(outcome.item);
      }
    });
  return result;
}

/**
 * Splits the text at "From " lines and restores escaped ">From " lines. Each message comes back as its lines joined with
 * "\n". When there is no "From " line, the whole text is one message.
 */
function splitMessages(text: string): string[] {
  const messages: string[][] = [];
  const whole: string[] = [];
  let current: string[] | null = null;
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (rawLine.startsWith('From ')) {
      current = [];
      messages.push(current);
      continue;
    }
    const line = rawLine.replace(/^>(>*From )/, '$1');
    if (current) current.push(line);
    else whole.push(line);
  }
  if (messages.length === 0) return whole.join('\n').trim() === '' ? [] : [whole.join('\n')];
  return messages.map((lines) => lines.join('\n'));
}

function readMessage(raw: string, position: number): Outcome {
  const message = parseEntity(raw);
  const dateText = message.headers.get('date') ?? '';
  const ts = Date.parse(dateText);
  if (!Number.isFinite(ts)) return { kind: 'noDate' };

  const found: Found = { plain: null, html: false };
  scan(message, 0, found);
  if (!found.plain && found.html) return { kind: 'htmlOnly' };

  const subjectRaw = message.headers.get('subject') ?? '';
  const messageId = (message.headers.get('message-id') ?? '').trim();
  const sourceId =
    messageId !== ''
      ? connectorSourceId('mail', messageId)
      : connectorSourceId('mail', subjectRaw, dateText, String(position));
  const item = buildItem({
    source: 'mail',
    sourceId,
    ts,
    title: decodeHeaderWords(subjectRaw),
    text: found.plain ? decodeBody(found.plain) : '',
  });
  return item ? { kind: 'item', item } : { kind: 'noDate' };
}

/**
 * Finds the first plain-text part, in document order, and notes whether an HTML part exists. A part found in an earlier
 * position wins, so a text/plain part after a text/html part is still the body.
 */
function scan(entity: Entity, depth: number, found: Found): void {
  if (depth > MAX_NESTING || isAttachment(entity)) return;
  if (entity.type.startsWith('multipart/')) {
    for (const part of multipartParts(entity)) {
      scan(part, depth + 1, found);
      if (found.plain) return;
    }
    return;
  }
  if (entity.type === '' || entity.type === 'text/plain') {
    if (!found.plain) found.plain = entity;
  } else if (entity.type === 'text/html') {
    found.html = true;
  }
}

function isAttachment(entity: Entity): boolean {
  // A part marked inline is body text, even when it has a file name.
  if (entity.disposition === 'inline') return false;
  return (
    entity.disposition === 'attachment' ||
    entity.dispositionParams.has('filename') ||
    (entity.disposition === '' && entity.params.has('name'))
  );
}

/** Splits a multipart body at its boundary lines. The part before the first boundary is a preamble and is not read. */
function multipartParts(entity: Entity): Entity[] {
  const boundary = entity.params.get('boundary');
  if (!boundary) return [];
  const delimiter = `--${boundary}`;
  const parts: string[][] = [];
  let current: string[] | null = null;
  for (const line of entity.body.split('\n')) {
    const marker = line.replace(/[ \t]+$/, '');
    if (marker === delimiter || marker === `${delimiter}--`) {
      if (current) parts.push(current);
      if (marker !== delimiter) {
        current = null;
        break;
      }
      current = [];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) parts.push(current);
  return parts.map((lines) => parseEntity(lines.join('\n')));
}

/** Reads one message or one MIME part: its headers up to the first blank line, and the body after it. */
function parseEntity(raw: string): Entity {
  const lines = raw.split('\n');
  const blank = lines.findIndex((line) => line.trim() === '');
  const headers = readHeaders(blank < 0 ? lines : lines.slice(0, blank));
  const body = blank < 0 ? '' : lines.slice(blank + 1).join('\n');
  const contentType = parseParameters(headers.get('content-type') ?? '');
  const disposition = parseParameters(headers.get('content-disposition') ?? '');
  return {
    headers,
    type: contentType.head.toLowerCase(),
    params: contentType.params,
    disposition: disposition.head.toLowerCase(),
    dispositionParams: disposition.params,
    encoding: (headers.get('content-transfer-encoding') ?? '').trim().toLowerCase(),
    body,
  };
}

/** Reads header lines, joining folded continuation lines. The first header of each name is kept. */
function readHeaders(lines: readonly string[]): Map<string, string> {
  const entries: Array<[string, string]> = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && entries.length > 0) {
      const last = entries[entries.length - 1];
      if (last) last[1] += line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) entries.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1)]);
  }
  const headers = new Map<string, string>();
  for (const [name, value] of entries) {
    if (!headers.has(name)) headers.set(name, value.trim());
  }
  return headers;
}

function decodeBody(entity: Entity): string {
  const charset = entity.params.get('charset');
  if (entity.encoding === 'base64') {
    return decodeCharset(Buffer.from(entity.body.replace(/\s+/g, ''), 'base64'), charset);
  }
  if (entity.encoding === 'quoted-printable') {
    const bytes = decodeQuotedPrintable(Buffer.from(entity.body.replace(/[ \t]+(?=\n)/g, ''), 'utf8'));
    return decodeCharset(bytes, charset);
  }
  return decodeCharset(Buffer.from(entity.body, 'utf8'), charset);
}

/** Decodes bytes with a charset label. An unknown label falls back to UTF-8, and bad bytes become U+FFFD. */
function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset && charset.trim() !== '' ? charset.trim() : 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Quoted-printable at byte level: =XX is a byte, and a "=" at the end of a line is a soft line break. */
function decodeQuotedPrintable(bytes: Uint8Array): Buffer {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte !== 0x3d) {
      out.push(byte);
      continue;
    }
    let next = i + 1;
    while (bytes[next] === 0x20 || bytes[next] === 0x09) next += 1;
    if (bytes[next] === 0x0d && bytes[next + 1] === 0x0a) {
      i = next + 1;
      continue;
    }
    if (bytes[next] === 0x0a) {
      i = next;
      continue;
    }
    const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    out.push(byte);
  }
  return Buffer.from(out);
}

/** Decodes RFC 2047 encoded words in a header value, such as =?UTF-8?Q?Caf=C3=A9?=. */
function decodeHeaderWords(value: string): string {
  return value
    .replace(/\?=\s+(?==\?)/g, '?=')
    .replace(ENCODED_WORD, (_match: string, charset: string, encoding: string, data: string) => {
      const label = charset.split('*')[0] ?? '';
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : decodeQuotedPrintable(Buffer.from(data.replace(/_/g, ' '), 'utf8'));
      return decodeCharset(bytes, label);
    });
}
