import { describe, expect, it } from 'vitest';
import { LayaDecisionModel } from '../src/main/decision-laya';
import type { LayaRuntime } from '../src/main/laya';
import type { DecisionRequest } from '@companyos/twin-core';

/** A runtime that answers the one question it is asked with the given answer, and records the call. */
function fakeRuntime(answer: unknown, calls: Array<{ state: unknown; questions: unknown }>): LayaRuntime {
  return {
    async systemOne(state: unknown, questions: Record<string, unknown>) {
      calls.push({ state, questions });
      return { model: 'laya', answers: Object.fromEntries(Object.keys(questions).map(key => [key, answer])), usage: { input_tokens: 1, output_tokens: 0 } };
    },
    async close() {},
  } as unknown as LayaRuntime;
}

const choiceRequest: DecisionRequest = {
  state: { apps: ['arc', 'linear'] },
  question: {
    kind: 'choice',
    instructions: 'Which kind of work?',
    options: [
      { id: 'Documents', description: 'word processors' },
      { id: 'Other', description: 'none of the above' },
    ],
  },
};

describe('LayaDecisionModel', () => {
  it('abstains as no_model when there is no runtime', async () => {
    const model = new LayaDecisionModel({ runtime: async () => undefined });
    expect(await model.decide(choiceRequest)).toEqual({ status: 'abstained', reason: 'no_model' });
  });

  it('sends the state and the question in the bundle shape, and maps a choice answer', async () => {
    const calls: Array<{ state: unknown; questions: unknown }> = [];
    const answer = { type: 'choice', choice: 'Documents', probabilities: { Documents: 0.7, Other: 0.3 }, confidence: 0.4, answer_confidence: 0.7, rl_agent: { act_probability: 1 } };
    const model = new LayaDecisionModel({ runtime: async () => fakeRuntime(answer, calls) });
    const result = await model.decide(choiceRequest);
    expect(calls[0].state).toEqual({ apps: ['arc', 'linear'] });
    expect(calls[0].questions).toEqual({
      question: { type: 'choice', instructions: 'Which kind of work?', criteria: { Documents: 'word processors', Other: 'none of the above' } },
    });
    // Laya's answer_confidence is the probability of the reported answer. It is used, not the entropy-based confidence.
    expect(result).toEqual({
      status: 'answered',
      answer: { kind: 'choice', choice: 'Documents', probabilities: { Documents: 0.7, Other: 0.3 }, confidence: 0.7 },
    });
  });

  it('maps score and noul answers', async () => {
    const score = new LayaDecisionModel({
      runtime: async () => fakeRuntime({ type: 'score', score: 1.4, legend: {}, probabilities: { low: 0.6, high: 0.4 }, confidence: 0.2, answer_confidence: 0.6, rl_agent: { act_probability: 1 } }, []),
    });
    expect(
      await score.decide({ state: 'x', question: { kind: 'score', instructions: 'How urgent?', levels: ['low', 'high'] } }),
    ).toEqual({ status: 'answered', answer: { kind: 'score', score: 1.4, probabilities: { low: 0.6, high: 0.4 }, confidence: 0.6 } });

    const noul = new LayaDecisionModel({
      runtime: async () => fakeRuntime({ type: 'noul', noul: 0.91, answer_confidence: 0.91, rl_agent: { act_probability: 1 } }, []),
    });
    expect(await noul.decide({ state: 'x', question: { kind: 'noul', instructions: 'Is it urgent?' } })).toEqual({
      status: 'answered',
      answer: { kind: 'noul', probability: 0.91, confidence: 0.91 },
    });
  });

  it('abstains as invalid_question when the answer is of another kind', async () => {
    const model = new LayaDecisionModel({
      runtime: async () => fakeRuntime({ type: 'noul', noul: 0.9, answer_confidence: 0.9, rl_agent: { act_probability: 1 } }, []),
    });
    expect(await model.decide(choiceRequest)).toEqual({ status: 'abstained', reason: 'invalid_question' });
  });

  it('abstains as unavailable when the model throws', async () => {
    const broken = {
      async systemOne() {
        throw new Error('onnx failed');
      },
      async close() {},
    } as unknown as LayaRuntime;
    const model = new LayaDecisionModel({ runtime: async () => broken });
    expect(await model.decide(choiceRequest)).toEqual({ status: 'abstained', reason: 'unavailable' });
  });

  it('abstains as unavailable when the model does not answer in time', async () => {
    const slow = {
      systemOne: () => new Promise(() => undefined),
      async close() {},
    } as unknown as LayaRuntime;
    const model = new LayaDecisionModel({ runtime: async () => slow, timeoutMs: 20 });
    expect(await model.decide(choiceRequest)).toEqual({ status: 'abstained', reason: 'unavailable' });
  });

  it('abstains as unavailable when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new LayaDecisionModel({ runtime: async () => fakeRuntime({}, []) });
    expect(await model.decide(choiceRequest, controller.signal)).toEqual({ status: 'abstained', reason: 'unavailable' });
  });
});
