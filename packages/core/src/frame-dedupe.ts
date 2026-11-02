import { createHash } from 'node:crypto';

/** Every frame is reduced to this grid before it is hashed. */
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;
const CHANNELS = 4;
const FINGERPRINT_CHARS = 16;
const FINGERPRINT = /^[0-9a-f]{16}$/;

/**
 * A short fingerprint of what a frame shows. The BGRA pixels are box-averaged down to a 64 by 36 grid, and the grid is
 * hashed, so two reads of an unchanged screen match. Only the hash is kept, never the grid or the frame. A change that
 * moves the average of any cell changes the fingerprint.
 */
export function fingerprintBitmap(bgra: Buffer, width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('The frame size is not valid.');
  }
  if (bgra.length !== width * height * CHANNELS) throw new Error('The frame bitmap does not match its size.');

  const grid = Buffer.alloc(SAMPLE_WIDTH * SAMPLE_HEIGHT * CHANNELS);
  const sums = [0, 0, 0, 0];
  for (let cellY = 0; cellY < SAMPLE_HEIGHT; cellY++) {
    const top = Math.floor((cellY * height) / SAMPLE_HEIGHT);
    const bottom = Math.max(top + 1, Math.floor(((cellY + 1) * height) / SAMPLE_HEIGHT));
    for (let cellX = 0; cellX < SAMPLE_WIDTH; cellX++) {
      const left = Math.floor((cellX * width) / SAMPLE_WIDTH);
      const right = Math.max(left + 1, Math.floor(((cellX + 1) * width) / SAMPLE_WIDTH));
      sums.fill(0);
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const at = (y * width + x) * CHANNELS;
          for (let channel = 0; channel < CHANNELS; channel++) sums[channel] += bgra[at + channel];
        }
      }
      const count = (bottom - top) * (right - left);
      const out = (cellY * SAMPLE_WIDTH + cellX) * CHANNELS;
      for (let channel = 0; channel < CHANNELS; channel++) grid[out + channel] = Math.floor(sums[channel] / count);
    }
  }
  return createHash('sha256').update(grid).digest('hex').slice(0, FINGERPRINT_CHARS);
}

/**
 * Keeps a frame only when it differs from the last frame kept. The first frame is always kept. A frame that repeats the
 * last kept one is skipped, so an idle screen costs no OCR and no storage. Call it once a frame is going to be stored: a
 * fingerprint that was accepted here is the reference for the next frame, even if the frame is then dropped.
 */
export class FrameDeduper {
  private lastKept: string | undefined;

  shouldKeep(fingerprint: string): boolean {
    if (!FINGERPRINT.test(fingerprint)) throw new Error('The frame fingerprint is not valid.');
    if (fingerprint === this.lastKept) return false;
    this.lastKept = fingerprint;
    return true;
  }

  /** Forgets the last kept frame, so the next identical frame is read again. Used when a kept frame is then dropped. */
  reset(): void {
    this.lastKept = undefined;
  }
}
