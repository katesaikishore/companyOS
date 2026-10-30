import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super('Secure storage is not available on this system, so the twin will not start. Install or unlock a keyring and restart.');
    this.name = 'SecureStorageUnavailableError';
  }
}

/**
 * Wraps secrets with the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret or KWallet on Linux).
 * If the OS cannot protect a secret, nothing is written. The app fails closed.
 */
async function requireSecureStorage(): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new SecureStorageUnavailableError();
}

async function readSealed(path: string): Promise<Buffer | undefined> {
  if (!existsSync(path)) return undefined;
  await requireSecureStorage();
  const { result } = await safeStorage.decryptStringAsync(readFileSync(path));
  return Buffer.from(result, 'base64');
}

async function writeSealed(path: string, value: Buffer): Promise<void> {
  await requireSecureStorage();
  writeFileSync(path, await safeStorage.encryptStringAsync(value.toString('base64')), { mode: 0o600 });
}

/** The 32-byte data key that encrypts the twin on this device. Created on first run. */
export async function loadOrCreateDataKey(userData: string): Promise<Buffer> {
  const path = join(userData, 'data-key.bin');
  const existing = await readSealed(path);
  if (existing) return existing;
  const key = randomBytes(32);
  await writeSealed(path, key);
  return key;
}

export function destroyDataKey(userData: string): void {
  rmSync(join(userData, 'data-key.bin'), { force: true });
}

export async function loadApiKey(userData: string): Promise<string | undefined> {
  return (await readSealed(join(userData, 'api-key.bin')))?.toString('utf8');
}

export async function saveApiKey(userData: string, key: string): Promise<void> {
  await writeSealed(join(userData, 'api-key.bin'), Buffer.from(key, 'utf8'));
}
