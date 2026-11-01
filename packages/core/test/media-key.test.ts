import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MediaDecryptError, deriveMediaKey, openMedia, sealMedia } from '../src';

/** Planted image bytes. A JPEG starts with FF D8 FF, so the sealed file must not start that way. */
const CANARY = 'media-canary-2208';
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PLAIN = Buffer.concat([JPEG_START, Buffer.from(CANARY), randomBytes(48)]);
/** version (1) + IV (12) + tag (16) */
const HEADER_BYTES = 29;

function aad(mediaId: string): Buffer {
  return Buffer.from(`media:${mediaId}`);
}

describe('media key', () => {
  it('derives a 32-byte key that is the same for one data key and different for another', () => {
    const dataKey = randomBytes(32);
    const key = deriveMediaKey(dataKey);
    expect(key).toHaveLength(32);
    expect(deriveMediaKey(dataKey).equals(key)).toBe(true);
    expect(deriveMediaKey(randomBytes(32)).equals(key)).toBe(false);
  });

  it('is never the data key itself, so the image key is not the store key', () => {
    const dataKey = randomBytes(32);
    expect(deriveMediaKey(dataKey).equals(dataKey)).toBe(false);
  });

  it('rejects a data key that is not 32 bytes', () => {
    expect(() => deriveMediaKey(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('sealed images', () => {
  it('opens to the same bytes when the key and the id match', () => {
    const key = deriveMediaKey(randomBytes(32));
    const sealed = sealMedia(key, PLAIN, aad('media-1'));
    expect(openMedia(key, sealed, aad('media-1')).equals(PLAIN)).toBe(true);
  });

  it('stores no image bytes in readable form, and does not start like a JPEG', () => {
    const key = deriveMediaKey(randomBytes(32));
    const sealed = sealMedia(key, PLAIN, aad('media-1'));
    expect(sealed.includes(CANARY)).toBe(false);
    expect(sealed.includes(JPEG_START)).toBe(false);
    expect(sealed.length).toBe(PLAIN.length + HEADER_BYTES);
  });

  it('seals the same image differently each time, because each seal has its own IV', () => {
    const key = deriveMediaKey(randomBytes(32));
    const first = sealMedia(key, PLAIN, aad('media-1'));
    const second = sealMedia(key, PLAIN, aad('media-1'));
    expect(first.equals(second)).toBe(false);
  });

  it('refuses a wrong key without saying what the file held', () => {
    const sealed = sealMedia(deriveMediaKey(randomBytes(32)), PLAIN, aad('media-1'));
    const attempt = () => openMedia(deriveMediaKey(randomBytes(32)), sealed, aad('media-1'));
    expect(attempt).toThrow(MediaDecryptError);
    expect(attempt).toThrow('The captured image cannot be read. The key is wrong or the file was modified.');
    try {
      attempt();
    } catch (error) {
      expect(String(error).includes(CANARY)).toBe(false);
    }
  });

  it('refuses a file opened under another media id, so files cannot be swapped between items', () => {
    const key = deriveMediaKey(randomBytes(32));
    const sealed = sealMedia(key, PLAIN, aad('media-1'));
    expect(() => openMedia(key, sealed, aad('media-2'))).toThrow(MediaDecryptError);
  });

  it('refuses a file with any one byte changed or cut off', () => {
    const key = deriveMediaKey(randomBytes(32));
    const sealed = sealMedia(key, PLAIN, aad('media-1'));
    for (let index = 0; index < sealed.length; index++) {
      const tampered = Buffer.from(sealed);
      tampered[index] ^= 0x01;
      expect(() => openMedia(key, tampered, aad('media-1')), `byte ${index}`).toThrow(MediaDecryptError);
    }
    expect(() => openMedia(key, sealed.subarray(0, sealed.length - 1), aad('media-1'))).toThrow(MediaDecryptError);
    expect(() => openMedia(key, sealed.subarray(0, HEADER_BYTES - 1), aad('media-1'))).toThrow(MediaDecryptError);
    expect(() => openMedia(key, Buffer.alloc(0), aad('media-1'))).toThrow(MediaDecryptError);
  });

  it('refuses a file whose version byte is not known', () => {
    const key = deriveMediaKey(randomBytes(32));
    const sealed = sealMedia(key, PLAIN, aad('media-1'));
    const future = Buffer.from(sealed);
    future[0] = 2;
    expect(() => openMedia(key, future, aad('media-1'))).toThrow(MediaDecryptError);
  });

  it('rejects a key that is not 32 bytes, when sealing or opening', () => {
    expect(() => sealMedia(randomBytes(16), PLAIN, aad('media-1'))).toThrow(/32 bytes/);
    const key = deriveMediaKey(randomBytes(32));
    const sealed = sealMedia(key, PLAIN, aad('media-1'));
    expect(() => openMedia(randomBytes(16), sealed, aad('media-1'))).toThrow(/32 bytes/);
  });
});
