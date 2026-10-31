// Manifest generation for the browser extension. One source manifest (src/manifest.json) feeds two builds:
//
// - Chrome and Edge: the source manifest, unchanged. Its "key" fixes the extension ID the desktop app registers, and
//   "incognito": "not_allowed" keeps the extension out of private windows.
// - Firefox: the same manifest, adjusted for Firefox. Firefox does not run MV3 service workers, so the background is
//   loaded as a module script. Firefox does not read "key" or "incognito", so both are dropped, and the add-on ID
//   goes in browser_specific_settings. The privacy checks in background.js still run in private windows.

/** The add-on ID Firefox uses for the extension. It is fixed once the add-on is published, so change it only before that. */
export const FIREFOX_GECKO_ID = '{ee76d911-7587-44ca-8031-1d0b85037be4}';

/** Firefox 128 is the oldest release this build is written for (ESR). Module background scripts need a release at least this new. */
export const FIREFOX_MIN_VERSION = '128.0';

/** Firefox shows at most this many characters of the description in the add-on manager. */
export const FIREFOX_DESCRIPTION_LIMIT = 132;

const SERVICE_WORKER = 'background.js';

/** A gecko ID is either a UUID in braces or an email-style name. */
const GECKO_ID_PATTERN = /^(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[^@\s]+@[^@\s]+)$/i;

/** Checks the source manifest for the Chrome and Edge build and returns it. Fails the build if a privacy rule is missing. */
export function chromeManifest(source) {
  if (typeof source.key !== 'string' || source.key.length === 0) {
    throw new Error('The Chrome manifest needs a "key": the extension ID is derived from it.');
  }
  if (source.incognito !== 'not_allowed') {
    throw new Error('The Chrome manifest must set "incognito": "not_allowed" so private windows are never read.');
  }
  if (!source.background || source.background.service_worker !== SERVICE_WORKER) {
    throw new Error(`The Chrome manifest must run ${SERVICE_WORKER} as its service worker.`);
  }
  return source;
}

/**
 * Returns the Firefox manifest derived from the source manifest. The source is not changed.
 * Only the background, the add-on ID and the minimum version differ from Chrome. Permissions and the rest are kept.
 */
export function firefoxManifest(source, { geckoId = FIREFOX_GECKO_ID, minVersion = FIREFOX_MIN_VERSION } = {}) {
  if (!GECKO_ID_PATTERN.test(geckoId)) {
    throw new Error(`"${geckoId}" is not a valid Firefox add-on ID.`);
  }
  if (!source.background || source.background.service_worker !== SERVICE_WORKER) {
    throw new Error(`The source manifest must run ${SERVICE_WORKER} as its service worker, so the Firefox build can load it as a script.`);
  }
  if (typeof source.description === 'string' && source.description.length > FIREFOX_DESCRIPTION_LIMIT) {
    throw new Error(`The description is ${source.description.length} characters; Firefox shows at most ${FIREFOX_DESCRIPTION_LIMIT}.`);
  }

  // Drop the Chrome-only keys, then keep everything else in the source order.
  const { key, incognito, background, ...shared } = source;
  return {
    ...shared,
    background: { scripts: [SERVICE_WORKER], type: background.type ?? 'module' },
    browser_specific_settings: { gecko: { id: geckoId, strict_min_version: minVersion } },
  };
}
