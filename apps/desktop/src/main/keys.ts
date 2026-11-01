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
  // Without a keyring, Electron on Linux falls back to a fixed key built into Chromium. That is obfuscation, not protection.
  // COMPANYOS_TEST_BASIC_STORE=1 exists only so the headless smoke test can run; never set it for real data.
  const basic = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
  if (basic && process.env.COMPANYOS_TEST_BASIC_STORE !== '1') throw new SecureStorageUnavailableError();
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

const API_KEY_FILE = 'api-key.bin';

/** A new bearer token for the local API: 32 random bytes as hex, so it can be pasted into a header as it is. */
function newApiToken(): string {
  return randomBytes(32).toString('hex');
}

/** The local API's bearer token. Created on first use, and sealed like the data key, so it is never written in clear. */
export async function loadOrCreateApiToken(userData: string): Promise<string> {
  const path = join(userData, API_KEY_FILE);
  const existing = await readSealed(path);
  if (existing) return existing.toString('utf8');
  const token = newApiToken();
  await writeSealed(path, Buffer.from(token, 'utf8'));
  return token;
}

/** Replaces the local API's bearer token. The caller swaps it in at once, so the old token stops working straight away. */
export async function rotateApiToken(userData: string): Promise<string> {
  const token = newApiToken();
  await writeSealed(join(userData, API_KEY_FILE), Buffer.from(token, 'utf8'));
  return token;
}

/** Removes every sealed secret. Without the data key the stored records are unreadable. */
export function destroyStoredSecrets(userData: string): void {
  rmSync(join(userData, 'data-key.bin'), { force: true });
  rmSync(join(userData, 'api-key.bin'), { force: true });
}
