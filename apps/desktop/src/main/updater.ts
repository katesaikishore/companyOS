import { autoUpdater } from 'electron-updater';

/**
 * The HTTPS folder that holds the update feed (latest.yml and the installers). If it is unset, no feed exists and the
 * app never checks for updates.
 */
export const UPDATE_FEED_VARIABLE = 'COMPANYOS_UPDATE_URL';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateDecision =
  | { enabled: true; feedUrl: string }
  | { enabled: false; reason: 'not-packaged' | 'no-feed' | 'invalid-feed' };

/**
 * Decides whether automatic updates run. Only packaged builds with a feed URL update. The feed must be HTTPS, with no
 * credentials and no query string, so nothing about the person or a secret ends up in the address.
 */
export function resolveUpdateFeed(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): UpdateDecision {
  if (!isPackaged) return { enabled: false, reason: 'not-packaged' };
  const value = env[UPDATE_FEED_VARIABLE]?.trim();
  if (!value) return { enabled: false, reason: 'no-feed' };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { enabled: false, reason: 'invalid-feed' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search) {
    return { enabled: false, reason: 'invalid-feed' };
  }
  return { enabled: true, feedUrl: url.href };
}

/**
 * Starts background update checks when a feed is configured. A new version downloads in the background and installs
 * when the app quits. It never restarts the app by itself.
 */
export function startAutoUpdates(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): UpdateDecision {
  const decision = resolveUpdateFeed(isPackaged, env);
  if (!decision.enabled) return decision;

  autoUpdater.setFeedURL({ provider: 'generic', url: decision.feedUrl });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // An unhandled 'error' event would throw. A failed check is simply tried again on the next timer.
  autoUpdater.on('error', () => undefined);

  const check = () => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  };
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  return decision;
}
