/**
 * Sealed storage for each connector's tokens. Every token is sealed before it reaches the disk. The integrator supplies
 * the seal with Electron's safeStorage. Nothing here writes a token in clear, and a failed write leaves the last good file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CloudConnectorError, type Tokens } from './oauth';
import { isCloudProviderId, type CloudProviderId } from './providers';

export interface TokenStore {
  save(providerId: CloudProviderId, tokens: Tokens): Promise<void>;
  /** Undefined when nothing is stored for the provider, which means it is not connected. */
  load(providerId: CloudProviderId): Promise<Tokens | undefined>;
  /** Deletes the provider's stored tokens. Disconnecting a connector calls this. */
  remove(providerId: CloudProviderId): Promise<void>;
}

export interface FileTokenStoreOptions {
  /** Folder for the sealed files. Created with owner-only permissions when missing. */
  directory: string;
  seal(plain: Buffer): Buffer;
  open(sealed: Buffer): Buffer;
  /** Runs before every seal and open. It throws when secure storage is unavailable, as the key store does, so nothing is written unprotected. */
  guard?: () => void;
}

const UNREADABLE = 'The saved connection could not be opened. Connect the account again.';

function parseStored(plain: string): Tokens {
  const unreadable = (): CloudConnectorError => new CloudConnectorError('store', UNREADABLE);
  let value: unknown;
  try {
    value = JSON.parse(plain) as unknown;
  } catch {
    throw unreadable();
  }
  if (typeof value !== 'object' || value === null) throw unreadable();
  const fields = value as Record<string, unknown>;
  const { accessToken, refreshToken, expiresAt } = fields;
  if (typeof accessToken !== 'string' || accessToken === '') throw unreadable();
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) throw unreadable();
  if (refreshToken !== undefined && typeof refreshToken !== 'string') throw unreadable();
  return refreshToken === undefined ? { accessToken, expiresAt } : { accessToken, refreshToken, expiresAt };
}

/** A file store with one sealed file per provider. The file is named by the provider id, which is checked first. */
export function createFileTokenStore(options: FileTokenStoreOptions): TokenStore {
  const { directory, seal, open, guard } = options;

  const pathFor = (providerId: CloudProviderId): string => {
    if (!isCloudProviderId(providerId)) throw new CloudConnectorError('store', 'That connector is not known.');
    return join(directory, `${providerId}.bin`);
  };

  return {
    async save(providerId, tokens) {
      const path = pathFor(providerId);
      guard?.();
      const plain = Buffer.from(
        JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }),
        'utf8',
      );
      const sealed = seal(plain);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Written beside the target and then renamed, so a failed write leaves the previous file in place.
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, sealed, { mode: 0o600 });
      renameSync(temporary, path);
    },

    async load(providerId) {
      const path = pathFor(providerId);
      if (!existsSync(path)) return undefined;
      guard?.();
      let plain: string;
      try {
        plain = open(readFileSync(path)).toString('utf8');
      } catch {
        throw new CloudConnectorError('store', UNREADABLE);
      }
      return parseStored(plain);
    },

    async remove(providerId) {
      const path = pathFor(providerId);
      rmSync(path, { force: true });
      rmSync(`${path}.tmp`, { force: true });
    },
  };
}
