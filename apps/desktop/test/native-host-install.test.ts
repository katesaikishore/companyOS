import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  browserCapturePaths,
  EXTENSION_ID,
  firefoxManifestFor,
  installNativeHost,
  isBrowserCaptureSupported,
  isFirefoxExtensionId,
  isNativeHostPlatform,
  launcherScript,
  nativeHostPlan,
  registerArgs,
  removeNativeHost,
  unregisterArgs,
  windowsRegistryKey,
} from '../src/main/native-host-install';

// Path and manifest generation only. Nothing here runs reg.exe, and the Windows cases build paths with the Windows
// rules on any system. The one install round trip writes to a temporary folder on Linux.

const DESCRIPTION = 'companyOS Twin browser bridge. Receives browser names and URL templates only.';
const WIN_USER_DATA = 'C:\\Users\\kate\\AppData\\Roaming\\companyOS';
const WIN_HOME = 'C:\\Users\\kate';
const WIN_RUNTIME = 'C:\\Program Files\\companyOS\\companyOS.exe';
const WIN_HOST = 'C:\\Program Files\\companyOS\\resources\\browser-ext\\native-host\\host.js';
const FIREFOX_ID = 'twin@example.com';

describe('browser capture gates', () => {
  it('keeps the runtime off on Windows until the bridge has a named-pipe transport', () => {
    expect(isBrowserCaptureSupported('darwin')).toBe(true);
    expect(isBrowserCaptureSupported('linux')).toBe(true);
    expect(isBrowserCaptureSupported('win32')).toBe(false);
  });

  it('accepts Windows as a platform the native host can be registered on', () => {
    expect(isNativeHostPlatform('win32')).toBe(true);
    expect(isNativeHostPlatform('darwin')).toBe(true);
    expect(isNativeHostPlatform('freebsd')).toBe(false);
  });
});

describe('paths', () => {
  it('puts the Windows launcher in the browser folder as a batch file', () => {
    const paths = browserCapturePaths(WIN_USER_DATA, 'win32');
    expect(paths.folder).toBe('C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser');
    expect(paths.launcher).toBe('C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser\\companyos-twin-host.cmd');
  });

  it('keeps the macOS and Linux launcher as a shell script', () => {
    expect(browserCapturePaths('/data/companyOS', 'linux').launcher).toBe('/data/companyOS/browser/companyos-twin-host');
    expect(browserCapturePaths('/data/companyOS', 'darwin').launcher).toBe('/data/companyOS/browser/companyos-twin-host');
  });
});

describe('manifest locations', () => {
  it('writes Chrome and Edge manifests in their Linux folders, and Firefox only when an ID is given', () => {
    const plan = nativeHostPlan({ userData: '/home/kate/.config/companyOS', home: '/home/kate', platform: 'linux' });
    expect(plan.launcher).toBe('/home/kate/.config/companyOS/browser/companyos-twin-host');
    expect(plan.manifests.map(({ browser, file }) => [browser, file])).toEqual([
      ['chrome', '/home/kate/.config/google-chrome/NativeMessagingHosts/com.companyos.twin.json'],
      ['edge', '/home/kate/.config/microsoft-edge/NativeMessagingHosts/com.companyos.twin.json'],
    ]);

    const withFirefox = nativeHostPlan({
      userData: '/home/kate/.config/companyOS',
      home: '/home/kate',
      platform: 'linux',
      firefoxExtensionId: FIREFOX_ID,
    });
    expect(withFirefox.manifests[2]).toEqual({
      browser: 'firefox',
      file: '/home/kate/.mozilla/native-messaging-hosts/com.companyos.twin.json',
      manifest: {
        name: 'com.companyos.twin',
        description: DESCRIPTION,
        path: withFirefox.launcher,
        type: 'stdio',
        allowed_extensions: [FIREFOX_ID],
      },
    });
  });

  it('writes the macOS manifests in the Application Support folders', () => {
    const plan = nativeHostPlan({
      userData: '/Users/kate/Library/Application Support/companyOS',
      home: '/Users/kate',
      platform: 'darwin',
      firefoxExtensionId: FIREFOX_ID,
    });
    expect(plan.manifests.map(({ file }) => file)).toEqual([
      '/Users/kate/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.companyos.twin.json',
      '/Users/kate/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.companyos.twin.json',
      '/Users/kate/Library/Application Support/Mozilla/NativeMessagingHosts/com.companyos.twin.json',
    ]);
  });

  it('keeps the Chrome and Edge manifest contents the same as before Windows support', () => {
    const plan = nativeHostPlan({ userData: '/home/kate/.config/companyOS', home: '/home/kate', platform: 'linux' });
    expect(plan.manifests[0].manifest).toEqual({
      name: 'com.companyos.twin',
      description: DESCRIPTION,
      path: plan.launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
    expect(plan.manifests[1].manifest).toEqual(plan.manifests[0].manifest);
  });
});

describe('Windows plan', () => {
  it('points the Chrome, Edge and Firefox manifests at the launcher', () => {
    const plan = nativeHostPlan({
      userData: WIN_USER_DATA,
      home: WIN_HOME,
      platform: 'win32',
      firefoxExtensionId: FIREFOX_ID,
    });
    expect(plan.launcher).toBe('C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser\\companyos-twin-host.cmd');
    expect(plan.manifests.map(({ browser, file }) => [browser, file])).toEqual([
      ['chrome', 'C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser\\com.companyos.twin.json'],
      ['edge', 'C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser\\com.companyos.twin.json'],
      ['firefox', 'C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser\\com.companyos.twin.firefox.json'],
    ]);
    for (const { manifest } of plan.manifests) expect(manifest.path).toBe(plan.launcher);
    expect(plan.manifests[0].manifest.allowed_origins).toEqual([`chrome-extension://${EXTENSION_ID}/`]);
    expect(plan.manifests[2].manifest.allowed_extensions).toEqual([FIREFOX_ID]);
  });

  it('registers each browser under its own HKCU key, with the manifest path as the default value', () => {
    expect(windowsRegistryKey('chrome')).toBe('HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\com.companyos.twin');
    expect(windowsRegistryKey('edge')).toBe('HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\com.companyos.twin');
    expect(windowsRegistryKey('firefox')).toBe('HKCU\\SOFTWARE\\Mozilla\\NativeMessagingHosts\\com.companyos.twin');

    const plan = nativeHostPlan({ userData: WIN_USER_DATA, home: WIN_HOME, platform: 'win32' });
    const [chrome, edge] = plan.manifests.map(({ browser, file }) => registerArgs(windowsRegistryKey(browser), file));
    const chromeFile = plan.manifests[0].file;
    expect(chrome).toEqual([
      'add',
      'HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\com.companyos.twin',
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      chromeFile,
      '/f',
    ]);
    expect(edge[0]).toBe('add');
    expect(edge[1]).toBe('HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\com.companyos.twin');
  });

  it('keeps a path with spaces as one registry argument', () => {
    const userData = 'C:\\Users\\Kate Smith\\AppData\\Roaming\\companyOS';
    const plan = nativeHostPlan({ userData, home: 'C:\\Users\\Kate Smith', platform: 'win32' });
    const args = registerArgs(windowsRegistryKey('chrome'), plan.manifests[0].file);
    expect(args[args.length - 2]).toBe('C:\\Users\\Kate Smith\\AppData\\Roaming\\companyOS\\browser\\com.companyos.twin.json');
  });

  it('builds the unregister command for each key', () => {
    expect(unregisterArgs(windowsRegistryKey('firefox'))).toEqual([
      'delete',
      'HKCU\\SOFTWARE\\Mozilla\\NativeMessagingHosts\\com.companyos.twin',
      '/f',
    ]);
  });
});

describe('Windows launcher', () => {
  it('is a batch file with echo off, CRLF line endings, and the browser arguments passed on', () => {
    const script = launcherScript({
      platform: 'win32',
      runtime: WIN_RUNTIME,
      hostScript: WIN_HOST,
      socketPath: 'C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser\\bridge.sock',
      tokenPath: 'C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser\\bridge.token',
    });
    const lines = script.split('\r\n');
    expect(lines[0]).toBe('@echo off');
    expect(script).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(script).toContain('set "COMPANYOS_TWIN_TOKEN=C:\\Users\\kate\\AppData\\Roaming\\companyOS\\browser\\bridge.token"');
    expect(lines[lines.length - 2]).toBe(`"${WIN_RUNTIME}" "${WIN_HOST}" %*`);
    expect(script.endsWith('\r\n')).toBe(true);
    expect(script).not.toMatch(/[^\r]\n/);
  });

  it('doubles percent signs so cmd.exe does not expand them', () => {
    const script = launcherScript({
      platform: 'win32',
      runtime: 'C:\\Users\\100%\\companyOS.exe',
      hostScript: WIN_HOST,
      socketPath: 's',
      tokenPath: 't',
    });
    expect(script).toContain('"C:\\Users\\100%%\\companyOS.exe"');
  });

  it('refuses a path with a double quote, which cmd.exe cannot hold', () => {
    expect(() =>
      launcherScript({ platform: 'win32', runtime: 'C:\\a"b\\companyOS.exe', hostScript: WIN_HOST, socketPath: 's', tokenPath: 't' }),
    ).toThrow('the launcher cannot hold');
  });
});

describe('POSIX launcher', () => {
  it('quotes a single quote in a path so the shell reads it as one word', () => {
    const script = launcherScript({
      runtime: "/opt/it's/companyOS",
      hostScript: '/app/host.js',
      socketPath: '/data/bridge.sock',
      tokenPath: '/data/bridge.token',
    });
    expect(script.split('\n')[0]).toBe('#!/bin/sh');
    expect(script).toContain(`exec '/opt/it'\\''s/companyOS' '/app/host.js' "$@"`);
    expect(script).toContain("export COMPANYOS_TWIN_TOKEN='/data/bridge.token'");
  });
});

describe('Firefox manifest', () => {
  it('accepts a name with a domain or a GUID in braces', () => {
    expect(isFirefoxExtensionId('twin@example.com')).toBe(true);
    expect(isFirefoxExtensionId('{8f7c3a2e-1b4d-4e6f-9a0b-c1d2e3f4a5b6}')).toBe(true);
  });

  it('refuses an ID in any other form', () => {
    expect(isFirefoxExtensionId('')).toBe(false);
    expect(isFirefoxExtensionId('twin')).toBe(false);
    expect(isFirefoxExtensionId('twin@')).toBe(false);
    expect(isFirefoxExtensionId('bad id@example.com')).toBe(false);
    expect(() => firefoxManifestFor('/x/launcher', 'bad id')).toThrow('not in a valid form');
  });
});

// The expected paths use forward slashes. On the Windows runner the paths written by the install have mixed
// separators, so the comparison fails there. The block is skipped on Windows only; it still runs on Linux and macOS.
describe.skipIf(process.platform === 'win32')('install and remove on Linux', () => {
  let root: string;
  let home: string;
  let userData: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'twin-native-host-'));
    home = join(root, 'home');
    userData = join(root, 'userData');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the launcher and the manifests, then removes them', () => {
    const written = installNativeHost({
      userData,
      home,
      runtime: '/opt/companyOS/companyOS',
      hostScript: '/opt/companyOS/host.js',
      platform: 'linux',
      firefoxExtensionId: FIREFOX_ID,
    });
    const launcher = join(userData, 'browser', 'companyos-twin-host');
    const chrome = join(home, '.config', 'google-chrome', 'NativeMessagingHosts', 'com.companyos.twin.json');
    const firefox = join(home, '.mozilla', 'native-messaging-hosts', 'com.companyos.twin.json');

    expect([...written].sort()).toEqual(
      [
        chrome,
        join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts', 'com.companyos.twin.json'),
        firefox,
      ].sort(),
    );
    expect(readFileSync(launcher, 'utf8')).toContain(`exec '/opt/companyOS/companyOS' '/opt/companyOS/host.js' "$@"`);
    expect(statSync(launcher).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(chrome, 'utf8')).path).toBe(launcher);
    expect(JSON.parse(readFileSync(firefox, 'utf8')).allowed_extensions).toEqual([FIREFOX_ID]);

    removeNativeHost({ userData, home, platform: 'linux' });
    expect(existsSync(launcher)).toBe(false);
    expect(existsSync(chrome)).toBe(false);
    expect(existsSync(firefox)).toBe(false);
    expect(() => removeNativeHost({ userData, home, platform: 'linux' })).not.toThrow();
  });

  it('writes no Firefox manifest when no add-on ID is given', () => {
    installNativeHost({
      userData,
      home,
      runtime: '/opt/companyOS/companyOS',
      hostScript: '/opt/companyOS/host.js',
      platform: 'linux',
    });
    expect(existsSync(join(home, '.mozilla', 'native-messaging-hosts', 'com.companyos.twin.json'))).toBe(false);
  });

  it('refuses a platform with no native host', () => {
    expect(() =>
      installNativeHost({
        userData,
        home,
        runtime: '/opt/companyOS/companyOS',
        hostScript: '/opt/companyOS/host.js',
        platform: 'freebsd' as NodeJS.Platform,
      }),
    ).toThrow('not available');
  });
});
