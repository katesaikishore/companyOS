/**
 * URL templates for browser capture. A template keeps the host and the shape of the path, and nothing else.
 * This file has no imports, so the browser extension compiles it as is (see apps/browser-ext/scripts/build.mjs).
 */

/** Plain lowercase words, such as "doc" or "wiki", are kept. Anything else in the path is not. */
const PLAIN_SEGMENT = /^[a-z]{1,12}$/;

/** Deeper segments are dropped, so a template cannot describe a whole document or a long address. */
const MAX_SEGMENTS = 4;

/**
 * Returns the template of an http(s) URL, such as "docs.example.com/doc/:id/edit".
 *
 * Query strings, fragments, user information and ports are dropped. Every path segment that is not a plain
 * lowercase word becomes :id. That covers numeric ids, UUIDs, hashes and slugs such as "jane-doe", which often
 * carry a name or a title. Other schemes (chrome://, edge://, file://, about:) and input that does not parse
 * return undefined, so no template is produced for them.
 */
export function urlTemplate(raw: string): string | undefined {
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
    .slice(0, MAX_SEGMENTS)
    .map(segment => (PLAIN_SEGMENT.test(segment) ? segment : ':id'));
  return [url.hostname.toLowerCase(), ...segments].join('/');
}
