import { createHmac, randomUUID } from 'node:crypto';
import { classifyApp, isExcludedApp, normalizeAppName } from './classify';
import { RawSignalSchema, type TwinEvent } from './types';

/** Path segments that look like identifiers are replaced by :id. Over-redacting is the safe failure. */
const ID_LIKE =
  /^(\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{16,}|[^/]+@[^/]+\.[^/]+)$/i;

/** Keeps host and path shape only. Query, fragment and credentials are dropped. */
export function templateUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map(segment => (ID_LIKE.test(segment) ? ':id' : segment));
  return [url.hostname.toLowerCase(), ...segments].join('/');
}

/** Keyed, deterministic pseudonyms. Used wherever data leaves the store (cloud traces, aggregates). */
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
  newId?: () => string;
}

/**
 * Turns one raw capture signal into a stored event, or returns null when the signal must be dropped.
 * Secure input, private windows and excluded apps never produce an event.
 */
export function normalizeSignal(input: unknown, options: NormalizeOptions): TwinEvent | null {
  const signal = RawSignalSchema.parse(input);
  if (signal.secureInput || signal.isPrivateWindow) return null;

  const id = (options.newId ?? randomUUID)();
  if (signal.kind !== 'focus') {
    return { id, ts: signal.ts, kind: signal.kind };
  }

  if (!signal.app || isExcludedApp(signal.app, options.excludedApps)) return null;
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
