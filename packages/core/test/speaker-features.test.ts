import { describe, expect, it } from 'vitest';
import {
  FBANK_FRAME_LENGTH,
  FBANK_FRAME_SHIFT,
  FBANK_MEL_BINS,
  FBANK_SAMPLE_RATE,
  fbankFeatures,
  fbankFrameCount,
  logMelFrames,
} from '../src/speaker/features';

/** A sine wave of the given frequency, as float samples in [-1, 1]. Deterministic. */
function tone(hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(FBANK_SAMPLE_RATE * seconds));
  for (let n = 0; n < out.length; n++) out[n] = amplitude * Math.sin((2 * Math.PI * hz * n) / FBANK_SAMPLE_RATE);
  return out;
}

/** White-ish noise from a fixed generator, so the test is repeatable. */
function noise(seconds: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(FBANK_SAMPLE_RATE * seconds));
  let state = seed;
  for (let n = 0; n < out.length; n++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[n] = (state / 0x7fffffff - 0.5) * 0.4;
  }
  return out;
}

/** The mel of a frequency, as Kaldi defines it. */
const mel = (hz: number): number => 1127 * Math.log(1 + hz / 700);

/** The index of the mel bin whose centre is nearest a frequency, from the same edges the filterbank uses. */
function nearestBin(hz: number): number {
  const low = mel(20);
  const delta = (mel(FBANK_SAMPLE_RATE / 2) - low) / (FBANK_MEL_BINS + 1);
  let best = 0;
  for (let bin = 0; bin < FBANK_MEL_BINS; bin++) {
    const centre = low + (bin + 1) * delta;
    if (Math.abs(centre - mel(hz)) < Math.abs(low + (best + 1) * delta - mel(hz))) best = bin;
  }
  return best;
}

describe('fbank framing', () => {
  it('uses 25 ms frames every 10 ms, with snip-edges: a frame must lie entirely inside the samples', () => {
    expect(FBANK_FRAME_LENGTH).toBe(400);
    expect(FBANK_FRAME_SHIFT).toBe(160);
    expect(fbankFrameCount(399)).toBe(0);
    expect(fbankFrameCount(400)).toBe(1);
    expect(fbankFrameCount(559)).toBe(1);
    expect(fbankFrameCount(560)).toBe(2);
    expect(fbankFrameCount(16_000)).toBe(98);
  });

  it('gives one row of 80 mel bins per frame', () => {
    const features = fbankFeatures(tone(440, 1));
    expect(features.bins).toBe(80);
    expect(features.frames).toBe(98);
    expect(features.data).toHaveLength(98 * 80);
    expect(Array.from(features.data).every(Number.isFinite)).toBe(true);
  });

  it('gives no frames for a segment shorter than one frame, rather than failing', () => {
    const features = fbankFeatures(new Float32Array(100));
    expect(features.frames).toBe(0);
    expect(features.data).toHaveLength(0);
  });
});

describe('fbank values', () => {
  it('removes each bin mean over the segment (cepstral mean normalisation)', () => {
    const { frames, data } = fbankFeatures(noise(1.5, 3));
    for (let bin = 0; bin < FBANK_MEL_BINS; bin += 7) {
      let sum = 0;
      for (let frame = 0; frame < frames; frame++) sum += data[frame * FBANK_MEL_BINS + bin];
      expect(Math.abs(sum / frames)).toBeLessThan(1e-4);
    }
  });

  it('puts a steady 1 kHz tone in the mel bin that covers 1 kHz', () => {
    const { data } = logMelFrames(tone(1000, 1));
    const frame = 40;
    let peak = 0;
    for (let bin = 1; bin < FBANK_MEL_BINS; bin++) {
      if (data[frame * FBANK_MEL_BINS + bin] > data[frame * FBANK_MEL_BINS + peak]) peak = bin;
    }
    expect(Math.abs(peak - nearestBin(1000))).toBeLessThanOrEqual(1);
  });

  it('puts a higher tone in a higher bin', () => {
    const peakOf = (hz: number): number => {
      const { data } = logMelFrames(tone(hz, 1));
      const frame = 40;
      let peak = 0;
      for (let bin = 1; bin < FBANK_MEL_BINS; bin++) {
        if (data[frame * FBANK_MEL_BINS + bin] > data[frame * FBANK_MEL_BINS + peak]) peak = bin;
      }
      return peak;
    };
    expect(peakOf(3000)).toBeGreaterThan(peakOf(500));
  });

  it('is the same every time for the same samples', () => {
    const samples = noise(0.8, 5);
    const first = fbankFeatures(samples).data;
    const second = fbankFeatures(samples).data;
    expect(Array.from(second)).toEqual(Array.from(first));
  });

  it('gives the log floor for silence, not minus infinity', () => {
    const { data } = logMelFrames(new Float32Array(FBANK_SAMPLE_RATE / 4));
    for (const value of data.slice(0, FBANK_MEL_BINS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeCloseTo(Math.log(1.1920929e-7), 3);
    }
  });
});
