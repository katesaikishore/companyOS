import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Seals the captured screen images. The media key is derived from the data key with its own label, so the encrypted
 * store and the image files never share a key. Destroying the data key makes both unreadable.
 *
 * A sealed file is one version byte, a 12-byte IV, a 16-byte GCM tag, then the ciphertext. The associated data is the
 * file's id, so a file copied under another id does not open.
 */
const MEDIA_VERSION = 1;
const MEDIA_INFO = 'companyos.media.v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_END = 1;
const IV_END = VERSION_END + IV_BYTES;
const HEADER_BYTES = IV_END + TAG_BYTES;
const UNREADABLE = 'The captured image cannot be read. The key is wrong or the file was modified.';

/** Thrown for any sealed file that does not open. The message never says what was in the file. */
export class MediaDecryptError extends Error {
  constructor() {
    super(UNREADABLE);
    this.name = 'MediaDecryptError';
  }
}

/** The 32-byte key for the image files, derived from the data key. Deriving it again gives the same key. */
export function deriveMediaKey(dataKey: Buffer): Buffer {
  requireKey(dataKey, 'Data key');
  return Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), Buffer.from(MEDIA_INFO), KEY_BYTES));
}

/** Seals one image. `aad` is the file's id. The result is the bytes to write to disk. */
export function sealMedia(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  requireKey(key, 'Media key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([MEDIA_VERSION]), iv, cipher.getAuthTag(), body]);
}

/**
 * Opens one sealed image. Throws MediaDecryptError when the key is wrong, the id differs, the version is unknown, or any
 * byte was changed or cut off. The bytes are authenticated before anything is returned.
 */
export function openMedia(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  requireKey(key, 'Media key');
  if (blob.length < HEADER_BYTES || blob[0] !== MEDIA_VERSION) throw new MediaDecryptError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(VERSION_END, IV_END));
    decipher.setAAD(aad);
    decipher.setAuthTag(blob.subarray(IV_END, HEADER_BYTES));
    return Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    throw new MediaDecryptError();
  }
}

function requireKey(key: Buffer, label: string): void {
  if (key.length !== KEY_BYTES) throw new Error(`${label} must be ${KEY_BYTES} bytes.`);
}
