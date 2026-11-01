/**
 * A seam for a small on-device model that answers typed questions about a state. It does not plan, write text or act.
 *
 * Nothing in the engine calls it yet. The runner plans, and the approval gates in policy.ts stay deterministic. A
 * model that implements this interface may only advise: a caller must treat an abstention as "use the rules", and must
 * never let an answer widen what a policy decision allows.
 *
 * Core stays free of native code. The desktop app supplies any real implementation.
 */

/** The three kinds of question. `noul` is a yes/no question: the answer is the probability that it is true. */
export type DecisionQuestionKind = 'choice' | 'score' | 'noul';

export interface DecisionOption {
  id: string;
  description?: string;
}

/** Pick one of the options. */
export interface ChoiceQuestion {
  kind: 'choice';
  instructions: string;
  options: readonly DecisionOption[];
}

/** Rate on an ordered scale. Index 0 is the lowest level. */
export interface ScoreQuestion {
  kind: 'score';
  instructions: string;
  levels: readonly string[];
}

/** A yes/no question. */
export interface NoulQuestion {
  kind: 'noul';
  instructions: string;
  whenTrue?: string;
  whenFalse?: string;
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** What the question is about. Text, or a plain object of facts. It must not carry data the caller may not share. */
export type DecisionState = string | Readonly<Record<string, unknown>>;

export interface DecisionRequest {
  state: DecisionState;
  question: DecisionQuestion;
}

export type DecisionAnswer =
  | {
      kind: 'choice';
      choice: string;
      /** Probability of each option id. */
      probabilities: Readonly<Record<string, number>>;
      /** Probability of the chosen option, from 0 to 1. */
      confidence: number;
    }
  | {
      kind: 'score';
      /** The expected level, from 0 to levels - 1. */
      score: number;
      /** Probability of each level, by its index. */
      probabilities: Readonly<Record<string, number>>;
      /** Probability of the most likely level, from 0 to 1. */
      confidence: number;
    }
  | {
      kind: 'noul';
      /** Probability that the answer is yes. */
      probability: number;
      /** The larger of the probability and its complement, from 0.5 to 1. */
      confidence: number;
    };

export type AbstainReason = 'no_model' | 'unavailable' | 'low_confidence' | 'invalid_question';

export type DecisionResult =
  | { status: 'answered'; answer: DecisionAnswer }
  | { status: 'abstained'; reason: AbstainReason };

export interface DecisionModel {
  /** A short name for logs and tests, such as "rules". */
  readonly id: string;
  /** Answers one request, or abstains. It never throws for a question it cannot answer. */
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult>;
}

/** The default. It always abstains, so behaviour is exactly what the rules did before a decision model existed. */
export class AbstainingDecisionModel implements DecisionModel {
  readonly id = 'rules';

  async decide(): Promise<DecisionResult> {
    return { status: 'abstained', reason: 'no_model' };
  }
}

export const DEFAULT_DECISION_MODEL: DecisionModel = new AbstainingDecisionModel();
