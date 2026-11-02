/**
 * Log mel filterbank features for the speaker model. The steps are the ones Kaldi's fbank uses, with snip-edges on, so the
 * model sees the same numbers it was trained on: 25 ms Hamming frames every 10 ms, DC removed per frame, pre-emphasis 0.97,
 * a 512-point power spectrum, 80 triangular mel bins from 20 Hz to Nyquist, and a log floor at float epsilon. Cepstral mean
 * normalisation then subtracts each bin's mean over the segment. Samples are scaled to the 16-bit range first, as the
 * speaker model's own front end does. The arithmetic is plain TypeScript, so it runs in the speaker process and in tests.
 *
 * The output is not checked against Kaldi's own output here, since no reference file is shipped. Tests check its shape,
 * its determinism, and where a tone lands on the mel scale.
 */

export const FBANK_SAMPLE_RATE = 16_000;
/** 25 ms, in samples. */
export const FBANK_FRAME_LENGTH = 400;
/** 10 ms, in samples. */
export const FBANK_FRAME_SHIFT = 160;
export const FBANK_MEL_BINS = 80;

const FFT_SIZE = 512;
const SPECTRUM_BINS = FFT_SIZE / 2;
const LOW_FREQ_HZ = 20;
const PREEMPHASIS = 0.97;
/** Samples are in [-1, 1] in the app. The speaker front end works on 16-bit values. */
const PCM_SCALE = 32_768;
/** The smallest value a mel energy can take before the log, which is float32 epsilon as in Kaldi. */
const LOG_FLOOR = 1.1920929e-7;

export interface FbankFeatures {
  /** Frames in the output. Zero when the samples are shorter than one frame. */
  frames: number;
  /** Always FBANK_MEL_BINS. */
  bins: number;
  /** Row-major, frames x bins. */
  data: Float32Array;
}

/** A radix-2 complex FFT of a fixed size, with its twiddles and bit-reversal table computed once. */
class Fft {
  private readonly reversed: Uint32Array;
  private readonly cosines: Float64Array;
  private readonly sines: Float64Array;

  constructor(private readonly size: number) {
    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let value = i;
      let reversed = 0;
      for (let bit = 0; bit < bits; bit++) {
        reversed = (reversed << 1) | (value & 1);
        value >>= 1;
      }
      this.reversed[i] = reversed;
    }
    this.cosines = new Float64Array(size / 2);
    this.sines = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) {
      this.cosines[k] = Math.cos((2 * Math.PI * k) / size);
      this.sines[k] = -Math.sin((2 * Math.PI * k) / size);
    }
  }

  /** In place. The real and imaginary parts are both of length `size`. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i];
      if (j > i) {
        const r = re[i];
        re[i] = re[j];
        re[j] = r;
        const m = im[i];
        im[i] = im[j];
        im[j] = m;
      }
    }
    for (let length = 2; length <= n; length <<= 1) {
      const half = length >> 1;
      const step = n / length;
      for (let start = 0; start < n; start += length) {
        for (let k = 0; k < half; k++) {
          const wr = this.cosines[k * step];
          const wi = this.sines[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

function melOf(hz: number): number {
  return 1127 * Math.log(1 + hz / 700);
}

interface Tables {
  window: Float64Array;
  /** FBANK_MEL_BINS rows of SPECTRUM_BINS weights, row-major. */
  filters: Float64Array;
  fft: Fft;
}

let tables: Tables | undefined;

function getTables(): Tables {
  if (tables) return tables;
  // Symmetric Hamming window, as Kaldi's 'hamming' type.
  const window = new Float64Array(FBANK_FRAME_LENGTH);
  for (let n = 0; n < FBANK_FRAME_LENGTH; n++) {
    window[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (FBANK_FRAME_LENGTH - 1));
  }
  // Triangular mel filters on the mel scale, with edges at equal steps in mel, as Kaldi builds them.
  const filters = new Float64Array(FBANK_MEL_BINS * SPECTRUM_BINS);
  const low = melOf(LOW_FREQ_HZ);
  const high = melOf(FBANK_SAMPLE_RATE / 2);
  const delta = (high - low) / (FBANK_MEL_BINS + 1);
  const binWidthHz = FBANK_SAMPLE_RATE / FFT_SIZE;
  for (let bin = 0; bin < FBANK_MEL_BINS; bin++) {
    const left = low + bin * delta;
    const center = left + delta;
    const right = center + delta;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const mel = melOf(i * binWidthHz);
      if (mel > left && mel < right) {
        filters[bin * SPECTRUM_BINS + i] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
      }
    }
  }
  tables = { window, filters, fft: new Fft(FFT_SIZE) };
  return tables;
}

/** Number of frames the samples give, with snip-edges: a frame must lie entirely inside the samples. */
export function fbankFrameCount(sampleCount: number): number {
  if (sampleCount < FBANK_FRAME_LENGTH) return 0;
  return 1 + Math.floor((sampleCount - FBANK_FRAME_LENGTH) / FBANK_FRAME_SHIFT);
}

/** The log mel energies of every frame, before mean normalisation. Exposed so tests can see where a tone lands. */
export function logMelFrames(samples: ArrayLike<number>): FbankFeatures {
  const { window, filters, fft } = getTables();
  const frames = fbankFrameCount(samples.length);
  const data = new Float32Array(frames * FBANK_MEL_BINS);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const power = new Float64Array(SPECTRUM_BINS);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * FBANK_FRAME_SHIFT;
    let mean = 0;
    for (let n = 0; n < FBANK_FRAME_LENGTH; n++) {
      const value = samples[start + n] * PCM_SCALE;
      re[n] = value;
      mean += value;
    }
    mean /= FBANK_FRAME_LENGTH;
    for (let n = 0; n < FBANK_FRAME_LENGTH; n++) re[n] -= mean;
    for (let n = FBANK_FRAME_LENGTH - 1; n > 0; n--) re[n] -= PREEMPHASIS * re[n - 1];
    re[0] -= PREEMPHASIS * re[0];
    for (let n = 0; n < FBANK_FRAME_LENGTH; n++) re[n] *= window[n];
    re.fill(0, FBANK_FRAME_LENGTH);
    im.fill(0);
    fft.transform(re, im);
    for (let i = 0; i < SPECTRUM_BINS; i++) power[i] = re[i] * re[i] + im[i] * im[i];
    for (let bin = 0; bin < FBANK_MEL_BINS; bin++) {
      let energy = 0;
      const row = bin * SPECTRUM_BINS;
      for (let i = 0; i < SPECTRUM_BINS; i++) energy += filters[row + i] * power[i];
      data[frame * FBANK_MEL_BINS + bin] = Math.log(Math.max(energy, LOG_FLOOR));
    }
  }
  return { frames, bins: FBANK_MEL_BINS, data };
}

/**
 * The model's input: log mel features with each bin's mean over the segment removed. Refuses nothing: a segment too short
 * for one frame gives zero frames, and the caller decides what that means.
 */
export function fbankFeatures(samples: ArrayLike<number>): FbankFeatures {
  const raw = logMelFrames(samples);
  const { frames, data } = raw;
  for (let bin = 0; bin < FBANK_MEL_BINS; bin++) {
    let mean = 0;
    for (let frame = 0; frame < frames; frame++) mean += data[frame * FBANK_MEL_BINS + bin];
    mean /= Math.max(frames, 1);
    for (let frame = 0; frame < frames; frame++) data[frame * FBANK_MEL_BINS + bin] -= mean;
  }
  return raw;
}
