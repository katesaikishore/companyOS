import { createHmac, randomUUID } from 'node:crypto';
import { classifyApp, isBrowserApp, isExcludedApp, normalizeAppName } from './classify';
import { RawSignalSchema, type TwinEvent } from './types';

/** The first path segment is kept only when it is a plain lowercase word, such as "doc" or "wiki". */
const PLAIN_WORD = /^[a-z]{1,12}$/;

/**
 * Keeps the host and the first path segment, and nothing else. Later segments are where names, ids and
 * titles tend to live (for example "/in/jane-doe"), so they are never stored.
 */
export function templateUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const first = url.pathname.split('/').find(Boolean);
  const shape = first === undefined ? '' : `/${PLAIN_WORD.test(first) ? first : ':id'}`;
  return `${url.hostname.toLowerCase()}${shape}`;
}

/** Keyed, deterministic pseudonyms. Use them for any data that leaves the store, such as future aggregates. */
export class Pseudonymizer {
  constructor(private readonly key: Buffer) {
    if (key.length < 16) throw new Error('Pseudonymisation key is too short.');
  }

  token(kind: string, value: string): string {
    const digest = createHmac('sha256', this.key).update(`${kind}\u0000${value}`).digest('base64url');
    return `${kind}_${digest.slice(0, 12)}`;
  }
}

export interface NormalizeOptions {
  excludedApps: readonly string[];
  /** Off by default: browser private windows cannot be detected yet, so browser focus is not recorded. */
  watchBrowsers: boolean;
  newId?: () => string;
}

/**
 * Turns one raw capture signal into a stored event, or returns null when the signal must be dropped.
 * Secure input, private windows, excluded apps and (unless enabled) browsers never produce an event.
 */
export function normalizeSignal(input: unknown, options: NormalizeOptions): TwinEvent | null {
  // A schema error names the offending keys, so a title sent as a key would reach the error text. Report only the fact.
  const parsed = RawSignalSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid capture signal: it has a field or value the twin does not accept.');
  const signal = parsed.data;
  if (signal.secureInput || signal.isPrivateWindow) return null;

  const id = (options.newId ?? randomUUID)();
  if (signal.kind !== 'focus') {
    return { id, ts: signal.ts, kind: signal.kind };
  }

  if (!signal.app || isExcludedApp(signal.app, options.excludedApps)) return null;
  if (!options.watchBrowsers && isBrowserApp(signal.app)) return null;
  const windowClass = classifyApp(signal.app);

  const urlTemplate = signal.url && windowClass === 'browser' ? templateUrl(signal.url) : undefined;
  return {
    id,
    ts: signal.ts,
    kind: 'focus',
    app: normalizeAppName(signal.app),
    windowClass,
    ...(urlTemplate ? { urlTemplate } : {}),
  };
}

const KEY_PLACEHOLDER = '[key]';
const CARD_PLACEHOLDER = '[card number]';
/** A card number: 13 to 19 digits, with a single space or dash allowed between them. */
const CARD_NUMBER = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
/** Known vendor key shapes: AWS access keys, GitHub, OpenAI and Anthropic style keys, Slack and Google API keys. */
const VENDOR_KEY =
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}/g;
/** A JSON web token: three base64url parts, the first starting as a JSON header. */
const JSON_WEB_TOKEN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
/** A run of 20 or more characters with no space, holding both a letter and a digit: a random key, a token or a hash. */
const KEY_LIKE_RUN = /(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{20,}(?![A-Za-z0-9_+/=-])/g;

/**
 * Replaces key-like tokens and card-like numbers in text the person typed, before it is stored. The rules are broad on
 * purpose: a false match loses a little text, and a missed key or card keeps a secret. They are not a password detector,
 * so a password typed into an ordinary text box is caught only when it has one of these shapes.
 */
export function redactTypedText(text: string): string {
  return text
    .replace(PRIVATE_KEY_HEADER, KEY_PLACEHOLDER)
    .replace(VENDOR_KEY, KEY_PLACEHOLDER)
    .replace(JSON_WEB_TOKEN, KEY_PLACEHOLDER)
    .replace(KEY_LIKE_RUN, KEY_PLACEHOLDER)
    .replace(CARD_NUMBER, CARD_PLACEHOLDER);
}
