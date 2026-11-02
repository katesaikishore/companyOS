/**
 * Seals the cloud connectors' tokens with the operating system's keychain (Electron's safeStorage), before they reach the disk.
 * The guard is the synchronous form of requireSecureStorage in keys.ts: it refuses the basic plain-text backend on Linux, so a
 * token is never written where the keychain cannot protect it. The one exception is the same test-only switch keys.ts has.
 */
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { CloudConnectorError } from './oauth';
import { createFileTokenStore, type TokenStore } from './token-store';

/** The folder under the user data folder that holds one sealed file per connected account. */
export const CLOUD_TOKEN_FOLDER = 'connectors-cloud';

export const SECURE_STORAGE_MESSAGE =
  'Secure storage is not available on this system, so this sign-in cannot be saved. Install or unlock a keyring and try again.';

/** Throws when the operating system cannot protect a value. Called before every seal and open. */
export function requireSealedStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new CloudConnectorError('store', SECURE_STORAGE_MESSAGE);
  // Without a keyring, Electron on Linux falls back to a fixed key built into Chromium. That is obfuscation, not protection.
  // COMPANYOS_TEST_BASIC_STORE=1 exists only so the headless smoke test can run. A packaged app never honours it.
  const basic = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
  const allowBasic = !app.isPackaged && process.env.COMPANYOS_TEST_BASIC_STORE === '1';
  if (basic && !allowBasic) throw new CloudConnectorError('store', SECURE_STORAGE_MESSAGE);
}

/** Seals a plain buffer with the keychain. The guard runs first, so nothing is sealed by a backend that cannot protect it. */
export function sealWithSafeStorage(plain: Buffer): Buffer {
  requireSealedStorage();
  return safeStorage.encryptString(plain.toString('base64'));
}

export function openWithSafeStorage(sealed: Buffer): Buffer {
  requireSealedStorage();
  return Buffer.from(safeStorage.decryptString(sealed), 'base64');
}

/** The token store the app uses: sealed files in the user data folder, guarded as above. */
export function createCloudTokenStore(userData: string): TokenStore {
  return createFileTokenStore({
    directory: join(userData, CLOUD_TOKEN_FOLDER),
    seal: sealWithSafeStorage,
    open: openWithSafeStorage,
    guard: requireSealedStorage,
  });
}
