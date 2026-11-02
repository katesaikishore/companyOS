import { describe, expect, it } from 'vitest';
import { MAX_SPEAKER_SAMPLES, SPEAKER_EMBEDDING_VALUES, parseSpeakerReply, parseSpeakerRequest } from '../src/main/speaker-protocol';

const MODELS = process.platform === 'win32' ? 'C:\\models' : '/models';
const samples = (count: number): ArrayBuffer => new Float32Array(count).buffer;

describe('speaker process requests', () => {
  it('accepts a load with an absolute models folder, and an embed with whole float samples', () => {
    expect(parseSpeakerRequest({ type: 'load', id: 1, modelsDir: MODELS })).toEqual({ type: 'load', id: 1, modelsDir: MODELS });
    expect(parseSpeakerRequest({ type: 'embed', id: 2, samples: samples(16_000) })).toMatchObject({ type: 'embed', id: 2 });
  });

  it('refuses a relative or over-long models folder', () => {
    expect(parseSpeakerRequest({ type: 'load', id: 1, modelsDir: 'models' })).toBeUndefined();
    expect(parseSpeakerRequest({ type: 'load', id: 1, modelsDir: `/${'a'.repeat(1_100)}` })).toBeUndefined();
    expect(parseSpeakerRequest({ type: 'load', id: 1, modelsDir: 7 })).toBeUndefined();
  });

  it('refuses samples that are empty, not whole floats, not a buffer, or longer than the limit', () => {
    expect(parseSpeakerRequest({ type: 'embed', id: 1, samples: new ArrayBuffer(0) })).toBeUndefined();
    expect(parseSpeakerRequest({ type: 'embed', id: 1, samples: new ArrayBuffer(6) })).toBeUndefined();
    expect(parseSpeakerRequest({ type: 'embed', id: 1, samples: new Uint8Array(8) })).toBeUndefined();
    expect(parseSpeakerRequest({ type: 'embed', id: 1, samples: samples(MAX_SPEAKER_SAMPLES + 1) })).toBeUndefined();
    expect(parseSpeakerRequest({ type: 'embed', id: 1, samples: samples(MAX_SPEAKER_SAMPLES) })).toBeDefined();
  });

  it('refuses an unknown type, or an id that is not a whole number', () => {
    expect(parseSpeakerRequest({ type: 'transcribe', id: 1 })).toBeUndefined();
    expect(parseSpeakerRequest({ type: 'embed', id: 1.5, samples: samples(4) })).toBeUndefined();
    expect(parseSpeakerRequest(null)).toBeUndefined();
  });
});

describe('speaker process replies', () => {
  it('accepts a loaded, a failed reply with a stage, and an embedding of exactly 256 values', () => {
    expect(parseSpeakerReply({ type: 'loaded', id: 3 })).toEqual({ type: 'loaded', id: 3 });
    expect(parseSpeakerReply({ type: 'failed', id: 3, stage: 'embed' })).toEqual({ type: 'failed', id: 3, stage: 'embed' });
    const vector = new Float32Array(SPEAKER_EMBEDDING_VALUES).buffer;
    expect(parseSpeakerReply({ type: 'embedded', id: 4, vector })).toMatchObject({ type: 'embedded', id: 4 });
  });

  it('refuses an embedding of the wrong length, and a failure with an unknown stage', () => {
    expect(parseSpeakerReply({ type: 'embedded', id: 4, vector: new Float32Array(12).buffer })).toBeUndefined();
    expect(parseSpeakerReply({ type: 'failed', id: 4, stage: 'transcribe' })).toBeUndefined();
    expect(parseSpeakerReply({ type: 'embedded', id: 4, vector: [0.1, 0.2] })).toBeUndefined();
    expect(parseSpeakerReply({ type: 'loaded' })).toBeUndefined();
  });
});
