/**
 * Planted canaries for the privacy leak suite (plan 9.2). Each canary is planted on one ingest surface, and none
 * may appear on any output surface. They are upper case with underscores and digits, so the URL template never
 * keeps one as a "plain word", and they never collide with real data. The one exception is encodedForms, which
 * carries punctuation on purpose: its raw, base64, base64url, hex and percent forms all differ.
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
  secureFieldUrl: 'CANARY_SECURE_URL_B3E61D',
  excludedAppUrl: 'CANARY_EXCLUDED_URL_6F0A4C',
  fieldValue: 'CANARY_FIELD_VALUE_A7621B',
  typedText: 'CANARY_TYPED_TEXT_3E94F5',
  clipboard: 'CANARY_CLIPBOARD_C58D10',
  routineName: 'CANARY_ROUTINE_NAME_6A2C5D',
  encodedForms: 'CANARY_FORMS_?>?/B2F90',
} as const;

export type CanaryName = keyof typeof CANARIES;

export type Encoding = 'raw' | 'base64' | 'base64url' | 'hex' | 'percent';

/**
 * Base64 text of a copy that starts `shift` bytes into a longer stream, for shift 0, 1 and 2. Only the characters that
 * the copy alone fixes are kept: the bytes before the copy change the first characters, and the bytes after it change
 * the last partial one. Base64url has the same character positions, so it is cut the same way.
 */
function base64Needles(bytes: Buffer, alphabet: 'base64' | 'base64url'): string[] {
  return [0, 1, 2].map(shift => {
    const text = Buffer.concat([Buffer.alloc(shift), bytes]).toString(alphabet);
    return text.slice(Math.ceil((8 * shift) / 6), Math.floor((8 * (shift + bytes.length)) / 6));
  });
}

/**
 * The forms a copy of a canary can take in stored or sent bytes. Base64 and base64url are matched at each of the three
 * byte alignments, because a copy can start at any position in a longer stream. Matching is case-insensitive.
 */
export function encodingsOf(canary: string): Array<{ encoding: Encoding; needle: string }> {
  const bytes = Buffer.from(canary, 'utf8');
  const candidates: Array<{ encoding: Encoding; needle: string }> = [
    { encoding: 'raw', needle: canary },
    ...base64Needles(bytes, 'base64').map(needle => ({ encoding: 'base64' as const, needle })),
    ...base64Needles(bytes, 'base64url').map(needle => ({ encoding: 'base64url' as const, needle })),
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
      // A form can match at more than one alignment, so each form is reported once per surface.
      const reported = new Set<Encoding>();
      for (const { encoding, needle } of encodingsOf(canary)) {
        if (reported.has(encoding) || !haystack.includes(needle.toLowerCase())) continue;
        reported.add(encoding);
        leaks.push({ surface: surface.name, canary: name, encoding });
      }
    }
  }
  return leaks;
}

export function describeLeak(leak: Leak): string {
  return `${leak.surface} contains ${leak.canary} (${leak.encoding})`;
}
