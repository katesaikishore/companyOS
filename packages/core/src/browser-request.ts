import { timingSafeEqual } from 'node:crypto';
import { normalizeAppName } from './classify';

/**
 * The checks the browser bridge runs on each request, and the rules that keep one browser's visit from counting
 * twice. Pure functions with no I/O, so the desktop app and the tests run the same code.
 */

/** The most characters one request line may hold. Longer lines are refused before they are parsed. */
export const MAX_REQUEST_CHARS = 1024;
/** Unix socket paths are limited to about 104 bytes on macOS. The limit leaves room for the terminator. */
export const MAX_SOCKET_PATH_BYTES = 100;

const MAX_TEMPLATE_CHARS = 300;
const MAX_TOKEN_CHARS = 128;
const REQUEST_FIELDS = new Set(['browser', 'template', 'token', 'type']);
/** A host, then up to four path segments, each a plain lowercase word or :id. Matches what urlTemplate returns. */
const TEMPLATE_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\/(?::id|[a-z]{1,12})){0,4}$/;

/** The browsers the bridge reports. Chrome and Edge are the only ones with a native messaging host. */
export type BridgedBrowser = 'chrome' | 'edge';

export interface VisitRequest {
  browser: BridgedBrowser;
  template: string;
  token: string;
}

/** The names each bridged browser goes by in the OS and in the engine, lowercase as normalizeAppName returns them. */
const BRIDGED_APP_NAMES: Readonly<Record<BridgedBrowser, readonly string[]>> = {
  chrome: ['chrome', 'google chrome', 'google-chrome'],
  edge: ['msedge', 'microsoft edge', 'microsoft-edge', 'edge'],
};

/** Returns the request only when it has exactly the expected fields and valid values. Anything else is refused. */
export function parseVisitRequest(line: string): VisitRequest | undefined {
  if (line.length > MAX_REQUEST_CHARS) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !REQUEST_FIELDS.has(key))) return undefined;

  const browser = fields.browser === 'chrome' ? 'chrome' : fields.browser === 'edge' ? 'edge' : undefined;
  const { template, token, type } = fields;
  if (type !== 'visit' || !browser) return undefined;
  if (typeof template !== 'string' || template.length > MAX_TEMPLATE_CHARS || !TEMPLATE_PATTERN.test(template)) {
    return undefined;
  }
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return undefined;
  return { browser, template, token };
}

/** Compares the given token with the expected one in constant time. Different lengths never match. */
export function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The bridged browser an app name refers to, or undefined for every other app. */
export function bridgedBrowserOf(app: string): BridgedBrowser | undefined {
  const name = normalizeAppName(app);
  return (Object.keys(BRIDGED_APP_NAMES) as BridgedBrowser[]).find(browser => BRIDGED_APP_NAMES[browser].includes(name));
}

/**
 * The app the capture poll should record for the front app it read. When the bridge has reported a visit for Chrome
 * or Edge recently, the bridge sees that tab, so a polled focus for the browser is dropped. Otherwise one visit counts twice.
 */
export function polledFocusApp(app: string | undefined, bridgeReported: boolean): string | undefined {
  if (app && bridgeReported && bridgedBrowserOf(app)) return undefined;
  return app;
}

/** Why a socket path cannot be used, or undefined when it fits. Checked before anything is written to disk. */
export function socketPathProblem(socketPath: string): string | undefined {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes <= MAX_SOCKET_PATH_BYTES) return undefined;
  return `Watch browsers cannot start here. The app's data folder path is too long for the local browser socket (${bytes} bytes, limit ${MAX_SOCKET_PATH_BYTES}).`;
}
