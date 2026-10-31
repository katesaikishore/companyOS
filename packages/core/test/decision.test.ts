import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AbstainingDecisionModel,
  DEFAULT_DECISION_MODEL,
  type DecisionModel,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
} from '../src';

const QUESTIONS: Record<string, DecisionQuestion> = {
  choice: { kind: 'choice', instructions: 'Which team?', options: [{ id: 'billing', description: 'Money' }, { id: 'support' }] },
  score: { kind: 'score', instructions: 'How urgent?', levels: ['low', 'medium', 'high'] },
  noul: { kind: 'noul', instructions: 'Will this customer leave?', whenTrue: 'Yes', whenFalse: 'No' },
};

describe('the default DecisionModel', () => {
  it('abstains on every kind of question, and says why', async () => {
    for (const question of Object.values(QUESTIONS)) {
      const result = await DEFAULT_DECISION_MODEL.decide({ state: { ticket: 'My invoice is wrong' }, question });
      expect(result).toEqual({ status: 'abstained', reason: 'no_model' });
    }
  });

  it('abstains for text state, an empty object, and an invalid question alike', async () => {
    const model = new AbstainingDecisionModel();
    const bad = { state: '', question: { kind: 'choice', instructions: '', options: [] } } satisfies DecisionRequest;
    expect(await model.decide({ state: 'plain text', question: QUESTIONS.noul })).toMatchObject({ status: 'abstained' });
    expect(await model.decide({ state: {}, question: QUESTIONS.score })).toMatchObject({ status: 'abstained' });
    expect(await model.decide(bad)).toMatchObject({ status: 'abstained' });
  });

  it('leaves the request untouched and does not read the signal', async () => {
    const request: DecisionRequest = { state: { a: 1 }, question: QUESTIONS.choice };
    const before = JSON.stringify(request);
    const controller = new AbortController();
    controller.abort();
    const result = await DEFAULT_DECISION_MODEL.decide(request, controller.signal);
    expect(result.status).toBe('abstained');
    expect(JSON.stringify(request)).toBe(before);
  });

  it('is named "rules", so a log line says which path answered', () => {
    expect(DEFAULT_DECISION_MODEL.id).toBe('rules');
  });

  it('can be replaced by a model that answers, and the result types narrow', async () => {
    const answering: DecisionModel = {
      id: 'fake',
      decide: async (): Promise<DecisionResult> => ({
        status: 'answered',
        answer: { kind: 'noul', probability: 0.8, confidence: 0.8 },
      }),
    };
    const result = await answering.decide({ state: 'x', question: QUESTIONS.noul });
    if (result.status !== 'answered') throw new Error('expected an answer');
    expect(result.answer.kind).toBe('noul');
    if (result.answer.kind === 'noul') expect(result.answer.probability).toBe(0.8);
  });
});

/** Every .ts file under a folder, so the check below sees files added later too. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('the engine does not call a decision model yet', () => {
  it('no source file other than the module and its export reads decision.ts', () => {
    const src = join(__dirname, '..', 'src');
    const users = sourceFiles(src)
      .filter(file => !file.endsWith('decision.ts') && !file.endsWith('index.ts'))
      .filter(file => /from ['"](?:\.\.?\/)+decision['"]/.test(readFileSync(file, 'utf8')));
    expect(users).toEqual([]);
  });
});
