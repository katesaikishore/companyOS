import { isAbsolute } from 'node:path';

/**
 * The messages between the main process and the text embedding process. Kept apart from the worker, which loads the model
 * runtime at import, so the checks can be tested without it. Each side checks what it receives: file text is personal
 * data, and a malformed message must never reach the model.
 */

/** The length of one BGE base vector. Matches BGE_DIMENSIONS in the engine. */
export const BGE_VECTOR_VALUES = 768;
/** The most texts embedded in one request. The file index sends batches of this size. */
export const MAX_BGE_TEXTS = 64;
/** The longest text sent. The model reads 512 tokens, about 2,000 characters; the rest is cut before it is sent. */
export const MAX_BGE_TEXT_CHARS = 4_000;
const MAX_PATH_CHARS = 1_024;

export type BgeRequest = { type: 'load'; id: number; modelsDir: string } | { type: 'embed'; id: number; texts: string[] };

export type BgeReply =
  | { type: 'loaded'; id: number }
  /** The vectors one after another, BGE_VECTOR_VALUES 32-bit floats each, in the order of the texts. */
  | { type: 'embedded'; id: number; vectors: ArrayBuffer }
  | { type: 'failed'; id: number; stage: 'load' | 'embed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Returns the request when its shape is right, and undefined for anything else. */
export function parseBgeRequest(value: unknown): BgeRequest | undefined {
  if (!isRecord(value) || !Number.isInteger(value.id)) return undefined;
  const id = value.id as number;
  if (value.type === 'load') {
    const { modelsDir } = value;
    if (typeof modelsDir !== 'string' || modelsDir.length > MAX_PATH_CHARS || !isAbsolute(modelsDir)) return undefined;
    return { type: 'load', id, modelsDir };
  }
  if (value.type === 'embed') {
    const { texts } = value;
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_BGE_TEXTS) return undefined;
    if (!texts.every(text => typeof text === 'string' && text.length <= MAX_BGE_TEXT_CHARS)) return undefined;
    return { type: 'embed', id, texts: texts as string[] };
  }
  return undefined;
}

/** Returns the reply when its shape is right, and undefined for anything else. */
export function parseBgeReply(value: unknown): BgeReply | undefined {
  if (!isRecord(value) || !Number.isInteger(value.id)) return undefined;
  const id = value.id as number;
  if (value.type === 'loaded') return { type: 'loaded', id };
  if (value.type === 'embedded') {
    const { vectors } = value;
    if (!(vectors instanceof ArrayBuffer) || vectors.byteLength === 0 || vectors.byteLength % (BGE_VECTOR_VALUES * 4) !== 0) return undefined;
    return { type: 'embedded', id, vectors };
  }
  if (value.type === 'failed' && (value.stage === 'load' || value.stage === 'embed')) return { type: 'failed', id, stage: value.stage };
  return undefined;
}
