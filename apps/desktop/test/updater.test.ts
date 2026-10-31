import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoUpdater } from 'electron-updater';
import { channelFileName, resolveUpdateFeed, startAutoUpdates, UPDATE_FEED_VARIABLE } from '../src/main/updater';

vi.mock('electron-updater', () => ({
  autoUpdater: {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    on: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: false,
  },
}));

const withFeed = (value: string) => ({ [UPDATE_FEED_VARIABLE]: value });
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Lets the promise chain of a finished check run to its end. */
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Replaces both timers with stubs, so nothing is left running and each scheduled check can be called by hand. */
function stubTimers() {
  const unref = vi.fn();
  const setTimeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(() => ({ unref }) as unknown as NodeJS.Timeout);
  const setIntervalSpy = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation(() => ({ unref }) as unknown as NodeJS.Timeout);
  return { unref, setTimeoutSpy, setIntervalSpy };
}

describe('resolveUpdateFeed', () => {
  it('never updates an unpackaged build, even when a feed is set', () => {
    expect(resolveUpdateFeed(false, withFeed('https://updates.example.com/companyos'))).toEqual({
      enabled: false,
      reason: 'not-packaged',
    });
  });

  it('stays off in a packaged build with no feed, or a blank one', () => {
    expect(resolveUpdateFeed(true, {})).toEqual({ enabled: false, reason: 'no-feed' });
    expect(resolveUpdateFeed(true, withFeed('   '))).toEqual({ enabled: false, reason: 'no-feed' });
  });

  it('accepts an HTTPS feed and trims surrounding space', () => {
    expect(resolveUpdateFeed(true, withFeed('  https://updates.example.com/companyos/  '))).toEqual({
      enabled: true,
      feedUrl: 'https://updates.example.com/companyos/',
    });
  });

  it('treats a missing variable as no feed, whatever else the environment holds', () => {
    expect(resolveUpdateFeed(true, { COMPANYOS_OTHER: 'https://updates.example.com/companyos' })).toEqual({
      enabled: false,
      reason: 'no-feed',
    });
    expect(resolveUpdateFeed(true, { [UPDATE_FEED_VARIABLE]: undefined })).toEqual({
      enabled: false,
      reason: 'no-feed',
    });
  });

  it('reads the variable from the process environment when no environment is passed', () => {
    const previous = process.env[UPDATE_FEED_VARIABLE];
    try {
      delete process.env[UPDATE_FEED_VARIABLE];
      expect(resolveUpdateFeed(true)).toEqual({ enabled: false, reason: 'no-feed' });

      process.env[UPDATE_FEED_VARIABLE] = 'https://updates.example.com/companyos';
      expect(resolveUpdateFeed(true)).toEqual({ enabled: true, feedUrl: 'https://updates.example.com/companyos' });
    } finally {
      if (previous === undefined) delete process.env[UPDATE_FEED_VARIABLE];
      else process.env[UPDATE_FEED_VARIABLE] = previous;
    }
  });

  it('keeps the feed as the URL parser normalises it', () => {
    expect(resolveUpdateFeed(true, withFeed('HTTPS://Updates.Example.com:8443/companyos'))).toEqual({
      enabled: true,
      feedUrl: 'https://updates.example.com:8443/companyos',
    });
    expect(resolveUpdateFeed(true, withFeed('https://updates.example.com'))).toEqual({
      enabled: true,
      feedUrl: 'https://updates.example.com/',
    });
  });

  it.each([
    ['plain HTTP', 'http://updates.example.com/companyos'],
    ['a file path', 'file:///Users/someone/feed'],
    ['an FTP address', 'ftp://updates.example.com/companyos'],
    ['a data URL', 'data:text/plain,feed'],
    ['not a URL', 'updates.example.com'],
    ['only the scheme', 'https://'],
    ['credentials in the URL', 'https://user:pass@updates.example.com/companyos'],
    ['only a user name in the URL', 'https://user@updates.example.com/companyos'],
    ['a query string', 'https://updates.example.com/companyos?token=abc'],
  ])('rejects a feed with %s', (_label, value) => {
    expect(resolveUpdateFeed(true, withFeed(value))).toEqual({ enabled: false, reason: 'invalid-feed' });
  });
});

describe('channelFileName', () => {
  it.each([
    ['win32', 'x64', 'latest.yml'],
    ['darwin', 'arm64', 'latest-mac.yml'],
    ['linux', 'x64', 'latest-linux.yml'],
    ['linux', 'arm64', 'latest-linux-arm64.yml'],
  ])('names the channel file for %s on %s', (platform, arch, file) => {
    expect(channelFileName(platform, arch)).toBe(file);
  });
});

describe('startAutoUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets no feed and schedules no check when the build is not packaged', () => {
    const { setTimeoutSpy, setIntervalSpy } = stubTimers();
    const record = vi.fn();
    startAutoUpdates(false, record, withFeed('https://updates.example.com/companyos'));
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('sets no feed, schedules no check and writes no ledger entry when no feed is configured', () => {
    const { setTimeoutSpy, setIntervalSpy } = stubTimers();
    const record = vi.fn();
    const decision = startAutoUpdates(true, record, {});
    expect(decision).toEqual({ enabled: false, reason: 'no-feed' });
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('sets the feed, enables downloads and schedules checks on unref-ed timers when a feed is set', () => {
    const { unref, setTimeoutSpy, setIntervalSpy } = stubTimers();
    const decision = startAutoUpdates(true, vi.fn(), withFeed('https://updates.example.com/companyos'));
    expect(decision).toEqual({ enabled: true, feedUrl: 'https://updates.example.com/companyos' });
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example.com/companyos',
    });
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), FIRST_CHECK_MS);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), CHECK_EVERY_MS);
    expect(unref).toHaveBeenCalledTimes(2);
  });

  it('writes an update-check entry for a check when a feed is set', async () => {
    const { setTimeoutSpy } = stubTimers();
    vi.mocked(autoUpdater.checkForUpdates).mockResolvedValue(null);
    const record = vi.fn();
    startAutoUpdates(true, record, withFeed('https://updates.example.com/companyos'));

    const [check] = setTimeoutSpy.mock.calls[0] as unknown as [() => void];
    check();
    await settle();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      ts: expect.any(Number),
      purpose: 'update_check',
      host: 'updates.example.com',
      path: `/companyos/${channelFileName(process.platform, process.arch)}`,
      bytes: 0,
      outcome: 'ok',
    });
  });

  it('writes a failed update-check entry when the check rejects', async () => {
    const { setTimeoutSpy } = stubTimers();
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValue(new Error('offline'));
    const record = vi.fn();
    startAutoUpdates(true, record, withFeed('https://updates.example.com/companyos/'));

    const [check] = setTimeoutSpy.mock.calls[0] as unknown as [() => void];
    check();
    await settle();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'update_check',
        host: 'updates.example.com',
        path: `/companyos/${channelFileName(process.platform, process.arch)}`,
        outcome: 'failed',
      }),
    );
  });
});
