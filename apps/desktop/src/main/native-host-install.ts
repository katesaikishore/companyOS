import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, win32, type PlatformPath } from 'node:path';

/** The name the extension and the native messaging manifests both use. Chrome, Edge and Firefox look the host up by it. */
export const NATIVE_HOST_NAME = 'com.companyos.twin';

/**
 * The ID Chrome gives the unpacked extension in apps/browser-ext/src/manifest.json, which is derived from its
 * "key". scripts/build.mjs checks that this value still matches the key.
 */
export const EXTENSION_ID = 'bpgbkfplkfblaedljnikfhkebkkleini';

/** The browsers that can load the host. Firefox names its extension by an add-on ID, not by a key. */
export type NativeBrowser = 'chrome' | 'edge' | 'firefox';

/** The platforms the browser bridge runs on. Its socket is a Unix socket, so only these two turn capture on. */
type BridgePlatform = 'darwin' | 'linux';

/** The platforms that can register the native host. Windows does it per user, in the registry. */
export type NativeHostPlatform = BridgePlatform | 'win32';

/** Where each browser keeps its per-user manifest on macOS and Linux, relative to the home folder. */
const MANIFEST_FOLDERS: Readonly<Record<BridgePlatform, Readonly<Record<NativeBrowser, readonly string[]>>>> = {
  darwin: {
    chrome: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'],
    edge: ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'],
    firefox: ['Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts'],
  },
  linux: {
    chrome: ['.config', 'google-chrome', 'NativeMessagingHosts'],
    edge: ['.config', 'microsoft-edge', 'NativeMessagingHosts'],
    firefox: ['.mozilla', 'native-messaging-hosts'],
  },
};

/** The key under HKEY_CURRENT_USER where each browser reads the path of the host's manifest. Windows only. */
const REGISTRY_PARENTS: Readonly<Record<NativeBrowser, string>> = {
  chrome: 'SOFTWARE\\Google\\Chrome\\NativeMessagingHosts',
  edge: 'SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts',
  firefox: 'SOFTWARE\\Mozilla\\NativeMessagingHosts',
};

const BROWSERS: readonly NativeBrowser[] = ['chrome', 'edge', 'firefox'];

/** A Firefox add-on ID is either a name with a domain, or a GUID in braces. */
const FIREFOX_ID_PATTERN =
  /^(?:\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}|[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+)$/;

/**
 * Whether the app turns browser capture on here. The bridge still listens on a Unix socket, which Windows does not
 * have, so Windows stays off until the bridge has a named-pipe transport. Registration for Windows is below.
 */
export function isBrowserCaptureSupported(platform: NodeJS.Platform = process.platform): platform is BridgePlatform {
  return platform === 'darwin' || platform === 'linux';
}

/** Whether a native host can be registered on this platform. Windows is included; see isBrowserCaptureSupported. */
export function isNativeHostPlatform(platform: NodeJS.Platform): platform is NativeHostPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

/** Path rules for the platform the paths are for, so Windows paths can be built and tested on any system. */
function pathsFor(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix;
}

/** Everything the bridge, the launcher and the manifests share. All of it sits inside the app's data folder. */
export function browserCapturePaths(
  userData: string,
  platform: NodeJS.Platform = process.platform,
): {
  folder: string;
  launcher: string;
  socketPath: string;
  tokenPath: string;
} {
  const paths = pathsFor(platform);
  const folder = paths.join(userData, 'browser');
  return {
    folder,
    launcher: paths.join(folder, platform === 'win32' ? 'companyos-twin-host.cmd' : 'companyos-twin-host'),
    socketPath: paths.join(folder, 'bridge.sock'),
    tokenPath: paths.join(folder, 'bridge.token'),
  };
}

/**
 * The host script the launcher runs. A packaged app ships it in its resources folder. From source, it sits in
 * apps/browser-ext/native-host, three folders above the compiled main process (apps/desktop/dist/main).
 */
export function nativeHostScript(options: { packaged: boolean; resourcesPath: string; mainDir: string }): string {
  return options.packaged
    ? join(options.resourcesPath, 'browser-ext', 'native-host', 'host.js')
    : join(options.mainDir, '..', '..', '..', 'browser-ext', 'native-host', 'host.js');
}

export interface NativeHostOptions {
  /** The app's data folder (Electron's userData). */
  userData: string;
  /** The home folder, where the macOS and Linux manifest folders live. */
  home: string;
  /** The runtime that runs the host script: the app's own binary, run with ELECTRON_RUN_AS_NODE. */
  runtime: string;
  hostScript: string;
  platform?: NodeJS.Platform;
  /**
   * The Firefox add-on ID. Firefox gets a manifest only when this is set, because the Firefox extension and its ID
   * are not in this repository yet.
   */
  firefoxExtensionId?: string;
  /** Windows only. Runs reg.exe with these arguments. Tests pass a stand-in so nothing is written to the registry. */
  runRegistry?: RegistryRunner;
}

/** Runs reg.exe with a list of arguments, never through a shell. */
export type RegistryRunner = (args: readonly string[]) => void;

export interface NativeHostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins?: string[];
  allowed_extensions?: string[];
}

export interface ManifestFile {
  browser: NativeBrowser;
  /** Where the manifest is written. On Windows the registry points at this file. */
  file: string;
  manifest: NativeHostManifest;
}

export interface NativeHostPlan {
  /** The file browsers start. Every manifest's path is this file. */
  launcher: string;
  manifests: ManifestFile[];
}

interface NativeHostLocations {
  launcher: string;
  files: Readonly<Record<NativeBrowser, string>>;
}

/** Where every browser's manifest goes on this platform. The Firefox location is listed even when no ID is set. */
function nativeHostLocations(options: { userData: string; home: string; platform: NativeHostPlatform }): NativeHostLocations {
  const { platform } = options;
  const paths = browserCapturePaths(options.userData, platform);
  if (platform === 'win32') {
    // Windows finds the manifest through the registry, so the files sit in the browser folder. Chrome and Edge share one.
    const chromeFile = win32.join(paths.folder, `${NATIVE_HOST_NAME}.json`);
    return {
      launcher: paths.launcher,
      files: {
        chrome: chromeFile,
        edge: chromeFile,
        firefox: win32.join(paths.folder, `${NATIVE_HOST_NAME}.firefox.json`),
      },
    };
  }
  const place = (browser: NativeBrowser): string =>
    posix.join(options.home, ...MANIFEST_FOLDERS[platform][browser], `${NATIVE_HOST_NAME}.json`);
  return { launcher: paths.launcher, files: { chrome: place('chrome'), edge: place('edge'), firefox: place('firefox') } };
}

/** The manifests that install would write, with their contents. Pure, so the tests can check every path. */
export function nativeHostPlan(options: {
  userData: string;
  home: string;
  platform: NativeHostPlatform;
  firefoxExtensionId?: string;
}): NativeHostPlan {
  const { launcher, files } = nativeHostLocations(options);
  const manifests: ManifestFile[] = [
    { browser: 'chrome', file: files.chrome, manifest: manifestFor(launcher) },
    { browser: 'edge', file: files.edge, manifest: manifestFor(launcher) },
  ];
  if (options.firefoxExtensionId !== undefined) {
    manifests.push({
      browser: 'firefox',
      file: files.firefox,
      manifest: firefoxManifestFor(launcher, options.firefoxExtensionId),
    });
  }
  return { launcher, manifests };
}

/**
 * Writes the launcher and the manifests, then registers them on Windows. A browser only sees the host after it is
 * written, so this runs only when the person switches browser capture on. Returns the manifest files it wrote.
 */
export function installNativeHost(options: NativeHostOptions): string[] {
  const platform = options.platform ?? process.platform;
  if (!isNativeHostPlatform(platform)) throw new Error('Browser capture is not available on this system yet.');
  const paths = browserCapturePaths(options.userData, platform);
  const plan = nativeHostPlan({
    userData: options.userData,
    home: options.home,
    platform,
    firefoxExtensionId: options.firefoxExtensionId,
  });

  mkdirSync(paths.folder, { recursive: true, mode: 0o700 });
  chmodSync(paths.folder, 0o700);
  writeFileSync(
    paths.launcher,
    launcherScript({
      platform,
      runtime: options.runtime,
      hostScript: options.hostScript,
      socketPath: paths.socketPath,
      tokenPath: paths.tokenPath,
    }),
    { mode: 0o700 },
  );
  chmodSync(paths.launcher, 0o700);

  const pathRules = pathsFor(platform);
  const written = new Set<string>();
  for (const { file, manifest } of plan.manifests) {
    mkdirSync(pathRules.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    written.add(file);
  }

  if (platform === 'win32') {
    const run = options.runRegistry ?? runRegistry;
    for (const { browser, file } of plan.manifests) run(registerArgs(windowsRegistryKey(browser), file));
  }
  return [...written];
}

/** Removes the registry entries (Windows), the manifests and the launcher. The bridge's socket and token are removed by the bridge itself. */
export function removeNativeHost(options: {
  userData: string;
  home: string;
  platform?: NodeJS.Platform;
  runRegistry?: RegistryRunner;
}): void {
  const platform = options.platform ?? process.platform;
  if (!isNativeHostPlatform(platform)) return;
  const { launcher, files } = nativeHostLocations({ userData: options.userData, home: options.home, platform });
  if (platform === 'win32') {
    const run = options.runRegistry ?? runRegistry;
    for (const browser of BROWSERS) {
      // A key that was never written is not an error worth reporting.
      try {
        run(unregisterArgs(windowsRegistryKey(browser)));
      } catch {
        // Not registered for this browser.
      }
    }
  }
  for (const file of Object.values(files)) rmSync(file, { force: true });
  rmSync(launcher, { force: true });
}

/** The HKCU key a browser reads the host's manifest path from. Its default value is the path. */
export function windowsRegistryKey(browser: NativeBrowser): string {
  return `HKCU\\${REGISTRY_PARENTS[browser]}\\${NATIVE_HOST_NAME}`;
}

/** reg.exe arguments that set the key's default value to the manifest file. Each argument is one list entry. */
export function registerArgs(key: string, manifestFile: string): string[] {
  return ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestFile, '/f'];
}

/** reg.exe arguments that remove the key. */
export function unregisterArgs(key: string): string[] {
  return ['delete', key, '/f'];
}

/** Runs reg.exe from the system folder, so a program earlier on PATH cannot stand in for it. */
const runRegistry: RegistryRunner = args => {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  execFileSync(win32.join(systemRoot, 'System32', 'reg.exe'), [...args], { stdio: 'ignore', windowsHide: true });
};

/** The manifest allows one extension, by its ID, and no other. */
export function manifestFor(launcher: string): NativeHostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: 'companyOS Twin browser bridge. Receives browser names and URL templates only.',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

/** The Firefox manifest allows one add-on, by its ID. Firefox reads the same host from the location in its own folder. */
export function firefoxManifestFor(launcher: string, extensionId: string): NativeHostManifest {
  if (!isFirefoxExtensionId(extensionId)) throw new Error('The Firefox add-on ID is not in a valid form.');
  return {
    name: NATIVE_HOST_NAME,
    description: 'companyOS Twin browser bridge. Receives browser names and URL templates only.',
    path: launcher,
    type: 'stdio',
    allowed_extensions: [extensionId],
  };
}

export function isFirefoxExtensionId(id: string): boolean {
  return FIREFOX_ID_PATTERN.test(id);
}

export interface LauncherOptions {
  /** The platform the launcher is written for. Windows gets a batch file, everything else a shell script. */
  platform?: NodeJS.Platform;
  runtime: string;
  hostScript: string;
  socketPath: string;
  tokenPath: string;
}

/**
 * Browsers start the host from the path in the manifest, with no environment of their own. The launcher sets the
 * socket and token paths, and runs the app's runtime as plain Node, so no separate Node install is needed.
 */
export function launcherScript(options: LauncherOptions): string {
  return options.platform === 'win32' ? windowsLauncher(options) : posixLauncher(options);
}

function posixLauncher(options: LauncherOptions): string {
  return [
    '#!/bin/sh',
    '# Written by companyOS Twin while browser capture is on. Browsers start the native host through this file.',
    'export ELECTRON_RUN_AS_NODE=1',
    `export COMPANYOS_TWIN_SOCKET=${shellQuote(options.socketPath)}`,
    `export COMPANYOS_TWIN_TOKEN=${shellQuote(options.tokenPath)}`,
    `exec ${shellQuote(options.runtime)} ${shellQuote(options.hostScript)} "$@"`,
    '',
  ].join('\n');
}

/**
 * The Windows launcher is a batch file. Echo is off, because anything written to stdout would corrupt the native
 * messaging frames. The browser's own arguments are passed on.
 */
function windowsLauncher(options: LauncherOptions): string {
  return [
    '@echo off',
    'rem Written by companyOS Twin while browser capture is on. Browsers start the native host through this file.',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `set "COMPANYOS_TWIN_SOCKET=${cmdValue(options.socketPath)}"`,
    `set "COMPANYOS_TWIN_TOKEN=${cmdValue(options.tokenPath)}"`,
    `"${cmdValue(options.runtime)}" "${cmdValue(options.hostScript)}" %*`,
    '',
  ].join('\r\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Makes a value safe inside a double-quoted cmd.exe string. A percent sign would otherwise start a variable. */
function cmdValue(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error('A path for the browser host has a character the launcher cannot hold.');
  return value.replace(/%/g, '%%');
}
