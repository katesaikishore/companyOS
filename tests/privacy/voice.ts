import { unitVector } from '@companyos/twin-core';

/** The length of a voice embedding. The speaker model is not run in this suite, so the planted voices have this length too. */
const EMBEDDING_LENGTH = 256;

/**
 * A stand-in voice embedding: a unit vector from a fixed sequence, so every run plants the same voice. The speaker model is
 * replaced, and only the vector matters here. Its values give the voiceprint canary, which is a number and so is never a
 * word the twin would keep for its own reasons.
 */
export function plantedVoice(seed: number = 1): Float32Array {
  const raw = new Float32Array(EMBEDDING_LENGTH);
  let state = seed;
  for (let i = 0; i < raw.length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    raw[i] = state / 0x7fffffff - 0.5;
  }
  const unit = unitVector(raw);
  if (!unit) throw new Error('The planted voice is not a usable vector.');
  return unit;
}
