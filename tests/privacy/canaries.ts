/**
 * Planted canaries for the privacy leak suite (plan 9.2). Each canary is planted on one ingest surface, and none
 * may appear on any output surface. They are upper case with underscores and digits, so the URL template never
 * keeps one as a "plain word", and they never collide with real data.
 */
export const CANARIES = {
  windowTitle: 'CANARY_WINDOW_TITLE_7F3A91',
  documentTitle: 'CANARY_DOCUMENT_TITLE_4B12E0',
  urlQuery: 'CANARY_URL_QUERY_2B8E40',
  urlFragment: 'CANARY_URL_FRAGMENT_9C1D27',
  urlUserinfo: 'CANARY_URL_USERINFO_44AE19',
  urlPathSegment: 'CANARY_URL_PATH_E05B63',
  privateWindowUrl: 'CANARY_PRIVATE_URL_8D0F7A',
  overlongUrl: 'CANARY_OVERLONG_URL_19B6E2',
  secureFieldValue: 'CANARY_SECURE_VALUE_0D8C2E',
  fieldValue: 'CANARY_FIELD_VALUE_A7621B',
  typedText: 'CANARY_TYPED_TEXT_3E94F5',
  clipboard: 'CANARY_CLIPBOARD_C58D10',
  routineName: 'CANARY_ROUTINE_NAME_6A2C5D',
} as const;

export type CanaryName = keyof typeof CANARIES;

export type Encoding = 'raw' | 'base64' | 'base64url' | 'hex' | 'percent';

/**
 * The forms a copy of a canary can take in stored or sent bytes. Base64 is matched at byte alignment zero only, so a
 * copy embedded at another alignment is not found. Matching is case-insensitive.
 */
export function encodingsOf(canary: string): Array<{ encoding: Encoding; needle: string }> {
  const bytes = Buffer.from(canary, 'utf8');
  const candidates: Array<{ encoding: Encoding; needle: string }> = [
    { encoding: 'raw', needle: canary },
    { encoding: 'base64', needle: bytes.toString('base64').replace(/=+$/, '') },
    { encoding: 'base64url', needle: bytes.toString('base64url').replace(/=+$/, '') },
    { encoding: 'hex', needle: bytes.toString('hex') },
    { encoding: 'percent', needle: encodeURIComponent(canary) },
  ];
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = candidate.needle.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One named place the suite inspects, such as a store file, the console or an outbound request. */
export interface Surface {
  name: string;
  text: string;
}

export interface Leak {
  surface: string;
  canary: string;
  encoding: Encoding;
}

/** Every canary that appears on every surface, in any of its encodings. */
export function findLeaks(surfaces: readonly Surface[], canaries: Readonly<Record<string, string>> = CANARIES): Leak[] {
  const leaks: Leak[] = [];
  for (const surface of surfaces) {
    const haystack = surface.text.toLowerCase();
    for (const [name, canary] of Object.entries(canaries)) {
      for (const { encoding, needle } of encodingsOf(canary)) {
        if (haystack.includes(needle.toLowerCase())) leaks.push({ surface: surface.name, canary: name, encoding });
      }
    }
  }
  return leaks;
}

export function describeLeak(leak: Leak): string {
  return `${leak.surface} contains ${leak.canary} (${leak.encoding})`;
}
