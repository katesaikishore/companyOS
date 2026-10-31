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
