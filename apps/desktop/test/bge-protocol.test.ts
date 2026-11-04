import { describe, expect, it } from 'vitest';
import { BGE_VECTOR_VALUES, MAX_BGE_TEXT_CHARS, MAX_BGE_TEXTS, parseBgeReply, parseBgeRequest } from '../src/main/bge-protocol';

describe('the embedding process’s messages', () => {
  it('takes a load from an absolute folder and a batch of texts within the limits, and nothing else', () => {
    expect(parseBgeRequest({ type: 'load', id: 1, modelsDir: '/Users/k/models' })).toEqual({ type: 'load', id: 1, modelsDir: '/Users/k/models' });
    expect(parseBgeRequest({ type: 'load', id: 1, modelsDir: 'models' })).toBeUndefined();
    expect(parseBgeRequest({ type: 'embed', id: 2, texts: ['an invoice', 'a payslip'] })).toEqual({ type: 'embed', id: 2, texts: ['an invoice', 'a payslip'] });
    expect(parseBgeRequest({ type: 'embed', id: 2, texts: [] })).toBeUndefined();
    expect(parseBgeRequest({ type: 'embed', id: 2, texts: Array.from({ length: MAX_BGE_TEXTS + 1 }, () => 'x') })).toBeUndefined();
    expect(parseBgeRequest({ type: 'embed', id: 2, texts: ['x'.repeat(MAX_BGE_TEXT_CHARS + 1)] })).toBeUndefined();
    expect(parseBgeRequest({ type: 'embed', id: 2, texts: [7] })).toBeUndefined();
    expect(parseBgeRequest({ type: 'embed', texts: ['x'] })).toBeUndefined();
  });

  it('takes vectors only in whole BGE vectors, and a failure only with its stage', () => {
    const two = new Float32Array(BGE_VECTOR_VALUES * 2).buffer;
    expect(parseBgeReply({ type: 'embedded', id: 3, vectors: two })).toEqual({ type: 'embedded', id: 3, vectors: two });
    expect(parseBgeReply({ type: 'embedded', id: 3, vectors: new Float32Array(384).buffer })).toBeUndefined();
    expect(parseBgeReply({ type: 'failed', id: 3, stage: 'embed' })).toEqual({ type: 'failed', id: 3, stage: 'embed' });
    expect(parseBgeReply({ type: 'failed', id: 3, stage: 'the file text' })).toBeUndefined();
    expect(parseBgeReply({ type: 'loaded', id: 4 })).toEqual({ type: 'loaded', id: 4 });
  });
});
