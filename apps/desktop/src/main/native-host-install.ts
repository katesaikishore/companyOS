import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The name the extension and the native messaging manifests both use. Chrome and Edge look the host up by it. */
export const NATIVE_HOST_NAME = 'com.companyos.twin';

/**
 * The ID Chrome gives the unpacked extension in apps/browser-ext/src/manifest.json, which is derived from its
 * "key". scripts/build.mjs checks that this value still matches the key.
 */
export const EXTENSION_ID = 'bpgbkfplkfblaedljnikfhkebkkleini';

type Platform = 'darwin' | 'linux';

/** Where Chrome and Edge keep their per-user native messaging manifests, relative to the home folder. */
const MANIFEST_FOLDERS: Readonly<Record<Platform, Readonly<Record<'chrome' | 'edge', readonly string[]>>>> = {
  darwin: {
    chrome: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'],
    edge: ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'],
  },
  linux: {
    chrome: ['.config', 'google-chrome', 'NativeMessagingHosts'],
    edge: ['.config', 'microsoft-edge', 'NativeMessagingHosts'],
  },
};

/** Browser capture is available on macOS and Linux. Windows needs a registry entry, which is not written yet. */
export function isBrowserCaptureSupported(platform: NodeJS.Platform = process.platform): platform is Platform {
  return platform === 'darwin' || platform === 'linux';
}

/** Everything the bridge, the launcher and the manifests share. All of it sits inside the app's data folder. */
export function browserCapturePaths(userData: string): {
  folder: string;
  launcher: string;
  socketPath: string;
  tokenPath: string;
} {
  const folder = join(userData, 'browser');
  return {
    folder,
    launcher: join(folder, 'companyos-twin-host'),
    socketPath: join(folder, 'bridge.sock'),
    tokenPath: join(folder, 'bridge.token'),
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
  /** The home folder, where the browsers' manifest folders live. */
  home: string;
  /** The runtime that runs the host script: the app's own binary, run with ELECTRON_RUN_AS_NODE. */
  runtime: string;
  hostScript: string;
  platform?: NodeJS.Platform;
}

/**
 * Writes the launcher and one manifest per browser. A browser only sees the host after it is written, so this
 * runs only when the person switches browser capture on. Returns the manifest files it wrote.
 */
export function installNativeHost(options: NativeHostOptions): string[] {
  const platform = options.platform ?? process.platform;
  if (!isBrowserCaptureSupported(platform)) throw new Error('Browser capture is not available on this system yet.');
  const paths = browserCapturePaths(options.userData);

  mkdirSync(paths.folder, { recursive: true, mode: 0o700 });
  chmodSync(paths.folder, 0o700);
  writeFileSync(
    paths.launcher,
    launcherScript({
      runtime: options.runtime,
      hostScript: options.hostScript,
      socketPath: paths.socketPath,
      tokenPath: paths.tokenPath,
    }),
    { mode: 0o700 },
  );
  chmodSync(paths.launcher, 0o700);

  const written: string[] = [];
  for (const browser of ['chrome', 'edge'] as const) {
    const folder = join(options.home, ...MANIFEST_FOLDERS[platform][browser]);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(file, `${JSON.stringify(manifestFor(paths.launcher), null, 2)}\n`, { mode: 0o644 });
    written.push(file);
  }
  return written;
}

/** Removes the manifests and the launcher. The bridge's socket and token are removed by the bridge itself. */
export function removeNativeHost(options: { userData: string; home: string; platform?: NodeJS.Platform }): void {
  const platform = options.platform ?? process.platform;
  if (!isBrowserCaptureSupported(platform)) return;
  for (const browser of ['chrome', 'edge'] as const) {
    rmSync(join(options.home, ...MANIFEST_FOLDERS[platform][browser], `${NATIVE_HOST_NAME}.json`), { force: true });
  }
  rmSync(browserCapturePaths(options.userData).launcher, { force: true });
}

/** The manifest allows one extension, by its ID, and no other. */
function manifestFor(launcher: string): object {
  return {
    name: NATIVE_HOST_NAME,
    description: 'companyOS Twin browser bridge. Receives browser names and URL templates only.',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

/**
 * Browsers start the host from the path in the manifest, with no environment of their own. The launcher sets the
 * socket and token paths, and runs the app's runtime as plain Node, so no separate Node install is needed.
 */
function launcherScript(options: { runtime: string; hostScript: string; socketPath: string; tokenPath: string }): string {
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
