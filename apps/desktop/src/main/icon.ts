import { nativeImage, type NativeImage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/** The PNG sizes written by scripts/make-icons.mjs from build/icon.svg. electron-builder ships them inside the app. */
const ICON_DIR = join(__dirname, '..', '..', 'build', 'icons');
const FALLBACK_COLOUR: [number, number, number] = [14, 107, 92];

/**
 * The tray icon: 16 px, with a 32 px version for high-density screens. If the files are missing, a plain square
 * of the same colour is used, so the tray still appears.
 */
export function trayImage(): NativeImage {
  try {
    const image = nativeImage.createEmpty();
    image.addRepresentation({ scaleFactor: 1, buffer: readFileSync(join(ICON_DIR, '16x16.png')) });
    image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(join(ICON_DIR, '32x32.png')) });
    if (!image.isEmpty()) return image;
  } catch {
    // Fall through to the plain square below.
  }
  return nativeImage.createFromBuffer(solidPng(16, FALLBACK_COLOUR));
}

/**
 * The window icon for Windows and Linux. macOS takes the Dock icon from the app bundle, so it does not use this.
 * Undefined when the file is missing, which leaves the window with the default icon.
 */
export function windowIconPath(): string | undefined {
  const file = join(ICON_DIR, '256x256.png');
  return existsSync(file) ? file : undefined;
}

/** A plain coloured PNG, used only when the icon files are missing. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

export function solidPng(size: number, [red, green, blue]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type RGB

  const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB pixels
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
