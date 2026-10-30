import type { NetworkEntry } from '@companyos/twin-core';
import { autoUpdater } from 'electron-updater';

/**
 * The HTTPS folder that holds the update feed (latest.yml and the installers). If it is unset, no feed exists and the
 * app never checks for updates.
 */
export const UPDATE_FEED_VARIABLE = 'COMPANYOS_UPDATE_URL';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Writes one entry to the network ledger. The desktop app passes the runtime's recorder, so no check goes unlisted. */
export type NetworkRecorder = (entry: NetworkEntry) => void;

export type UpdateDecision =
  | { enabled: true; feedUrl: string }
  | { enabled: false; reason: 'not-packaged' | 'no-feed' | 'invalid-feed' };

/**
 * The channel file electron-updater reads first on this platform. These are the names electron-builder writes:
 * latest.yml on Windows, latest-mac.yml on macOS and latest-linux.yml on Linux, with the architecture added when it is
 * not x64.
 */
export function channelFileName(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'win32') return 'latest.yml';
  if (platform === 'darwin') return 'latest-mac.yml';
  return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
}

/** The host and path of the channel file, as electron-updater builds them: the feed folder always ends in a slash. */
function channelRequest(feedUrl: string): { host: string; path: string } {
  const folder = new URL(feedUrl);
  if (!folder.pathname.endsWith('/')) folder.pathname += '/';
  const channel = new URL(channelFileName(process.platform, process.arch), folder);
  return { host: channel.host, path: channel.pathname };
}

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
 * when the app quits. It never restarts the app by itself. Each check is written to the ledger through `record`.
 */
export function startAutoUpdates(
  isPackaged: boolean,
  record: NetworkRecorder,
  env: NodeJS.ProcessEnv = process.env,
): UpdateDecision {
  const decision = resolveUpdateFeed(isPackaged, env);
  if (!decision.enabled) return decision;

  autoUpdater.setFeedURL({ provider: 'generic', url: decision.feedUrl });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // An unhandled 'error' event would throw. A failed check is simply tried again on the next timer.
  autoUpdater.on('error', () => undefined);

  const request = channelRequest(decision.feedUrl);
  const check = () => {
    // electron-updater does not report the size of the channel file, so bytes stays at zero.
    const entry = (outcome: NetworkEntry['outcome']): NetworkEntry => ({
      ts: Date.now(),
      purpose: 'update_check',
      ...request,
      bytes: 0,
      outcome,
    });
    void autoUpdater
      .checkForUpdates()
      .then(() => record(entry('ok')), () => record(entry('failed')))
      .catch(() => undefined);
  };
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  return decision;
}
