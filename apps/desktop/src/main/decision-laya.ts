import type { Answer, Question } from '@receptron/laya';
import type { AbstainReason, DecisionAnswer, DecisionModel, DecisionQuestion, DecisionRequest, DecisionResult } from '@companyos/twin-core';
import type { LayaRuntime } from './laya';

/** Longest wait for one answer. Past this the caller keeps its rule-based result. */
export const LAYA_TIMEOUT_MS = 8_000;

export interface LayaDecisionModelOptions {
  /** The loaded model, or undefined when it is not installed or cannot load. */
  runtime: () => Promise<LayaRuntime | undefined>;
  timeoutMs?: number;
}

const abstain = (reason: AbstainReason): DecisionResult => ({ status: 'abstained', reason });

/** The engine's question as Laya's request shape. The option ids and their descriptions are what the model reads. */
function toLayaQuestion(question: DecisionQuestion): Question {
  switch (question.kind) {
    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries(question.options.map(option => [option.id, option.description ?? null])),
      };
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: [...question.levels] };
    case 'noul':
      return {
        type: 'noul',
        instructions: question.instructions,
        criteria: { true: question.whenTrue, false: question.whenFalse },
      };
  }
}

/**
 * Laya's answer as the engine's answer. Laya's confidence is answer_confidence, the probability of the reported answer,
 * which is the quantity its temperatures are fitted for. An answer of a different kind from the question is abstained.
 */
function toAnswer(question: DecisionQuestion, answer: Answer): DecisionResult {
  if (answer.type !== question.kind) return abstain('invalid_question');
  switch (answer.type) {
    case 'choice': {
      const out: DecisionAnswer = {
        kind: 'choice',
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.answer_confidence,
      };
      return { status: 'answered', answer: out };
    }
    case 'score':
      return {
        status: 'answered',
        answer: { kind: 'score', score: answer.score, probabilities: answer.probabilities, confidence: answer.answer_confidence },
      };
    case 'noul':
      return { status: 'answered', answer: { kind: 'noul', probability: answer.noul, confidence: answer.answer_confidence } };
  }
}

/**
 * The Laya bundle behind the engine's decision seam. It sends the state and one question, and it abstains rather than
 * throwing when the model is missing, does not answer in time, or fails. The answer is advice: the engine decides what
 * to do with it, and policy never reads it.
 */
export class LayaDecisionModel implements DecisionModel {
  readonly id = 'laya';

  constructor(private readonly options: LayaDecisionModelOptions) {}

  /**
   * The timeout covers loading the model as well as the answer. The first load of the bundle reads about 1.7 GB, which
   * took two minutes on the check machine with a cold disk cache. A caller that waits past the limit gets an abstention,
   * and the load carries on in the background, so a later call finds the model ready.
   */
  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    if (signal?.aborted) return abstain('unavailable');
    const answer = this.ask(request);
    answer.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>(resolve => {
      timer = setTimeout(() => resolve('expired'), this.options.timeoutMs ?? LAYA_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([answer, expired]);
      return outcome === 'expired' ? abstain('unavailable') : outcome;
    } catch {
      return abstain('unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  private async ask(request: DecisionRequest): Promise<DecisionResult> {
    const runtime = await this.options.runtime().catch(() => undefined);
    if (!runtime) return abstain('no_model');
    const outcome = await runtime.systemOne(request.state, { question: toLayaQuestion(request.question) });
    const answer = outcome.answers.question;
    return answer ? toAnswer(request.question, answer) : abstain('invalid_question');
  }
}
