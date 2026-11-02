import { isAbsolute } from 'node:path';

/**
 * The messages between the main process and the speaker process. Kept apart from the worker, which loads onnxruntime at
 * import, so the checks can be tested without it. The main process is trusted, but a malformed message must never reach the
 * model, so each side checks what it receives.
 */

/** The length of one embedding the speaker model outputs. Matches SPEAKER_EMBEDDING_DIM in the engine. */
export const SPEAKER_EMBEDDING_VALUES = 256;
/** Sixty seconds of 16 kHz mono audio, as 32-bit floats. Capture cuts segments at thirty seconds. */
export const MAX_SPEAKER_SAMPLES = 16_000 * 60;
const MAX_PATH_CHARS = 1_024;

export type SpeakerRequest = { type: 'load'; id: number; modelsDir: string } | { type: 'embed'; id: number; samples: ArrayBuffer };

export type SpeakerReply =
  | { type: 'loaded'; id: number }
  | { type: 'embedded'; id: number; vector: ArrayBuffer }
  | { type: 'failed'; id: number; stage: 'load' | 'embed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Returns the request when its shape is right, and undefined for anything else. */
export function parseSpeakerRequest(value: unknown): SpeakerRequest | undefined {
  if (!isRecord(value) || !Number.isInteger(value.id)) return undefined;
  const id = value.id as number;
  if (value.type === 'load') {
    const { modelsDir } = value;
    if (typeof modelsDir !== 'string' || modelsDir.length > MAX_PATH_CHARS || !isAbsolute(modelsDir)) return undefined;
    return { type: 'load', id, modelsDir };
  }
  if (value.type === 'embed') {
    const { samples } = value;
    if (!(samples instanceof ArrayBuffer)) return undefined;
    if (samples.byteLength === 0 || samples.byteLength % 4 !== 0 || samples.byteLength > MAX_SPEAKER_SAMPLES * 4) return undefined;
    return { type: 'embed', id, samples };
  }
  return undefined;
}

/** Returns the reply when its shape is right. An embedding must have exactly SPEAKER_EMBEDDING_VALUES values. */
export function parseSpeakerReply(value: unknown): SpeakerReply | undefined {
  if (!isRecord(value) || typeof value.id !== 'number') return undefined;
  const id = value.id;
  if (value.type === 'loaded') return { type: 'loaded', id };
  if (value.type === 'embedded') {
    const { vector } = value;
    if (!(vector instanceof ArrayBuffer) || vector.byteLength !== SPEAKER_EMBEDDING_VALUES * 4) return undefined;
    return { type: 'embedded', id, vector };
  }
  if (value.type === 'failed' && (value.stage === 'load' || value.stage === 'embed')) return { type: 'failed', id, stage: value.stage };
  return undefined;
}
