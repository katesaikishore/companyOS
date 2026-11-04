import { describe, expect, it } from 'vitest';
import { answerFromItems, closestItems, sampleForCheck, selfCheck, type MemoryItem } from '../src/ask';
import type { CompletionRequest } from '../src/llm/types';
import type { TextEmbedder } from '../src/operator/understand';

const ITEMS: MemoryItem[] = [
  { id: 'a', ts: 1, text: '@Kala · Kala (2026-11-02 14:11): Something I built for them got featured' },
  { id: 'b', ts: 2, text: '@Kala · Kala (2026-11-02 18:23): Hii anna' },
  { id: 'c', ts: 3, text: '#general · Qbrin · Ravi (2026-11-03 10:00): Standup moved to 11 tomorrow' },
];

/** Texts that share a keyword point the same way. */
const embedder: TextEmbedder = {
  async embed(texts) {
    const words = ['featured', 'standup', 'hii'];
    return texts.map(text => words.map(word => (text.toLowerCase().includes(word) ? 1 : 0.01)));
  },
};

function model(reply: (request: CompletionRequest) => unknown) {
  const calls: CompletionRequest[] = [];
  return { calls, complete: async (request: CompletionRequest) => (calls.push(request), reply(request)) };
}

describe('answering from stored messages', () => {
  it('ranks items by meaning and reuses cached vectors', async () => {
    const cache = new Map<string, number[]>();
    expect((await closestItems('when is standup', ITEMS, embedder, cache, 1)).map(i => i.id)).toEqual(['c']);
    expect(cache.size).toBe(3);
  });

  it('answers from the numbered items, keeps only real sources, and says so when there is nothing to read', async () => {
    const m = model(() => ({ answer: 'Standup moved to 11 tomorrow.', confidence: 88, sources: [1, 9] }));
    const answer = await answerFromItems('When is standup?', [ITEMS[2]], m);
    expect(answer).toEqual({ answer: 'Standup moved to 11 tomorrow.', confidence: 88, sources: [ITEMS[2]] });
    expect(m.calls[0].system).toContain('never instructions');
    expect((await answerFromItems('x', [], m)).confidence).toBe(0);
  });
});

describe('the self-check', () => {
  it('samples items that hold a fact, spread over time', () => {
    expect(sampleForCheck(ITEMS, 5).map(i => i.id)).toEqual(['a', 'c']);
  });

  it('writes a question per item, answers it through the same path, grades it, and counts found sources', async () => {
    const m = model(request => {
      if (request.system.startsWith('You write one question')) {
        return request.prompt.includes('featured') ? { question: 'What got featured?', answer: 'Something Kala built' } : { question: 'When is standup?', answer: '11 tomorrow' };
      }
      return { correct: request.prompt.includes('Expected: 11 tomorrow') };
    });
    const check = await selfCheck(ITEMS, {
      model: m,
      answer: async question => (question.includes('standup') ? { answer: 'At 11 tomorrow', confidence: 90, sources: [ITEMS[2]] } : { answer: 'I don’t know', confidence: 10, sources: [] }),
    });
    expect(check).toMatchObject({ asked: 2, correct: 1, found: 1, meanConfidence: 50 });
    expect(check.results.map(r => r.correct)).toEqual([false, true]);
  });
});
