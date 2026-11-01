import { describe, expect, it } from 'vitest';
import { FrameDeduper, fingerprintBitmap } from '../src/frame-dedupe';

/** A solid BGRA frame. */
function solid(width: number, height: number, value: number): Buffer {
  return Buffer.alloc(width * height * 4, value);
}

/** A copy of a frame with one rectangle (inclusive corners) set to a value. */
function withBlock(bitmap: Buffer, width: number, x0: number, y0: number, x1: number, y1: number, value: number): Buffer {
  const copy = Buffer.from(bitmap);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) copy.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 4);
  }
  return copy;
}

describe('fingerprintBitmap', () => {
  it('gives sixteen lower-case hex characters', () => {
    expect(fingerprintBitmap(solid(1920, 1080, 40), 1920, 1080)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('matches for an unchanged frame, even when it is a new buffer', () => {
    const first = solid(640, 360, 90);
    const second = Buffer.from(first);
    expect(fingerprintBitmap(second, 640, 360)).toBe(fingerprintBitmap(first, 640, 360));
  });

  it('changes when a large part of the screen changes', () => {
    const width = 640;
    const before = solid(width, 360, 20);
    const after = withBlock(before, width, 0, 0, 319, 179, 230);
    expect(fingerprintBitmap(after, width, 360)).not.toBe(fingerprintBitmap(before, width, 360));
  });

  it('works for a frame smaller than the sample grid', () => {
    const tiny = solid(10, 5, 200);
    expect(fingerprintBitmap(tiny, 10, 5)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a bitmap whose length does not match its size, with a fixed message', () => {
    expect(() => fingerprintBitmap(solid(10, 10, 0).subarray(1), 10, 10)).toThrow('The frame bitmap does not match its size.');
  });

  it('refuses a size that is not a positive whole number', () => {
    expect(() => fingerprintBitmap(Buffer.alloc(0), 0, 0)).toThrow('The frame size is not valid.');
    expect(() => fingerprintBitmap(solid(4, 4, 0), 2.5, 4)).toThrow('The frame size is not valid.');
  });
});

describe('FrameDeduper', () => {
  it('keeps the first frame and skips a repeat of the last kept frame', () => {
    const deduper = new FrameDeduper();
    expect(deduper.shouldKeep('0123456789abcdef')).toBe(true);
    expect(deduper.shouldKeep('0123456789abcdef')).toBe(false);
    expect(deduper.shouldKeep('0123456789abcdef')).toBe(false);
  });

  it('keeps a changed frame, and then a return to an earlier one', () => {
    const deduper = new FrameDeduper();
    expect(deduper.shouldKeep('aaaaaaaaaaaaaaaa')).toBe(true);
    expect(deduper.shouldKeep('bbbbbbbbbbbbbbbb')).toBe(true);
    expect(deduper.shouldKeep('bbbbbbbbbbbbbbbb')).toBe(false);
    expect(deduper.shouldKeep('aaaaaaaaaaaaaaaa')).toBe(true);
  });

  it('refuses a fingerprint that is not sixteen hex characters', () => {
    const deduper = new FrameDeduper();
    expect(() => deduper.shouldKeep('not-a-fingerprint')).toThrow('The frame fingerprint is not valid.');
    expect(() => deduper.shouldKeep('0123456789ABCDEF')).toThrow('The frame fingerprint is not valid.');
  });
});
