import type { DecisionAnswer, DecisionModel, DecisionQuestion, DecisionResult } from './decision';

/**
 * Chooses which on-screen element a goal should act on, through a decision model. It only chooses. It never clicks, types
 * or presses a key, so the caller decides what to do with the outcome. The gates follow the ones in agent-desktop's JEV
 * helper, so a choice that a person would be asked to confirm is also one this picker will not act on.
 */

/** Confidence an ordinary step needs before it runs. A design value, taken from JEV. */
export const PICK_CONFIDENCE = 0.7;
/** Confidence a step rated hard to undo needs. A design value, taken from JEV. */
export const PICK_DESTRUCTIVE_CONFIDENCE = 0.9;
/** Below this confidence nothing is offered, not even a suggestion. A design value, taken from JEV. */
export const PICK_FLOOR = 0.55;
/** At or above this confidence the risk is not rated, as in JEV, because the step already needs the higher bar. */
const UNRATED_CONFIDENCE = PICK_DESTRUCTIVE_CONFIDENCE;
/** The most elements one choice carries. The rest are cut, and the outcome says so. */
export const PICK_MAX_OPTIONS = 40;

/** An element of the screen that can be acted on. */
export interface PickCandidate {
  ref: string;
  role: string;
  name: string;
  /** The nearest named part of the screen the element sits in, such as a sidebar or a sheet. */
  region?: string;
  actions: readonly string[];
}

export type PickReason =
  | 'act'
  | 'no_candidates'
  | 'model_abstained'
  | 'not_answered'
  | 'chose_none'
  | 'unknown_option'
  | 'low_confidence'
  | 'needs_confirmation';

export interface PickOutcome {
  /** `act` when the caller may take the step on `ref`. Anything else means nothing may run. */
  decision: 'act' | 'stop';
  reason: PickReason;
  ref?: string;
  confidence?: number;
  /** The next most likely element, so a stop can say what else was considered. */
  runnerUp?: { ref: string; probability: number };
  /** True when the screen had more elements than one choice carries. */
  truncated: boolean;
}

/** Roles that name a part of the screen, so an element can say where it is. */
const REGION_ROLES = new Set(['sidebar', 'toolbar', 'sheet', 'popover', 'alert', 'menu', 'list', 'outline', 'table', 'group', 'window']);

/**
 * The actionable elements of an agent-desktop snapshot (`snapshot -i`), in reading order. An element counts when it has a
 * ref and at least one available action. The region is the nearest named ancestor in one of REGION_ROLES.
 */
export function candidatesOf(snapshot: unknown, limit: number = PICK_MAX_OPTIONS): { candidates: PickCandidate[]; truncated: boolean } {
  const all: PickCandidate[] = [];
  const walk = (node: SnapshotNode, region: string | undefined): void => {
    const here = REGION_ROLES.has(node.role ?? '') && node.name ? `${node.role} "${node.name}"` : region;
    if (node.ref_id && node.available_actions?.length) {
      all.push({
        ref: node.ref_id,
        role: node.role ?? 'element',
        name: node.name ?? '',
        ...(region ? { region } : {}),
        actions: node.available_actions,
      });
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  walk(treeOf(snapshot), undefined);
  return { candidates: all.slice(0, limit), truncated: all.length > limit };
}

interface SnapshotNode {
  role?: string;
  name?: string;
  ref_id?: string;
  available_actions?: string[];
  children?: SnapshotNode[];
}

function treeOf(snapshot: unknown): SnapshotNode {
  const data = (snapshot as { data?: { tree?: SnapshotNode } } | null)?.data;
  return data?.tree ?? {};
}

/** Asks the model which candidate matches the goal, and gates the answer. The model is never told to act. */
export async function pickTarget(
  goal: string,
  candidates: readonly PickCandidate[],
  model: DecisionModel,
  truncated = false,
): Promise<PickOutcome> {
  if (candidates.length === 0) return stop('no_candidates', truncated);

  // Options are named c0, c1 and so on, so the model never sees a ref. A ref is mapped back after the answer.
  const byOption = new Map(candidates.map((candidate, index) => [`c${index}`, candidate]));
  const question: DecisionQuestion = {
    kind: 'choice',
    instructions:
      `Which element should be acted on to: ${goal}? Pick the element that does exactly what the goal asks. ` +
      'Pick "none" when no element does.',
    options: [
      ...[...byOption].map(([id, candidate]) => ({ id, description: describe(candidate) })),
      { id: 'none', description: 'no element does what the goal asks' },
    ],
  };
  const result = await model.decide({ state: { goal, options: candidates.length }, question });
  const answer = answerOf(result, 'choice');
  if (!answer) return stop(abstainedOf(result), truncated);
  if (answer.choice === 'none') return stop('chose_none', truncated);

  const chosen = byOption.get(answer.choice);
  if (!chosen) return stop('unknown_option', truncated);
  const confidence = answer.confidence;
  const runnerUp = best(answer.probabilities, answer.choice, byOption);
  const named = { ref: chosen.ref, confidence, runnerUp, truncated };

  if (confidence < PICK_FLOOR) return { decision: 'stop', reason: 'low_confidence', ...named };
  if (confidence < PICK_CONFIDENCE) return { decision: 'stop', reason: 'needs_confirmation', ...named };
  if (confidence < UNRATED_CONFIDENCE && (await hardToUndo(goal, chosen, model))) {
    return { decision: 'stop', reason: 'needs_confirmation', ...named };
  }
  return { decision: 'act', reason: 'act', ...named };
}

/**
 * Rates whether the step is hard to undo. A reply that does not give a number, or an abstention, counts as hard to undo,
 * as JEV does, so the step then needs the higher bar.
 */
async function hardToUndo(goal: string, candidate: PickCandidate, model: DecisionModel): Promise<boolean> {
  const result = await model.decide({
    state: { goal, element: describe(candidate) },
    question: {
      kind: 'noul',
      instructions: 'Is clicking this element hard to undo, such as deleting, sending, paying, overwriting or quitting?',
      whenTrue: 'hard to undo',
      whenFalse: 'easy to undo',
    },
  });
  const answer = answerOf(result, 'noul');
  if (!answer) return true;
  return answer.probability >= 0.5;
}

function answerOf<K extends DecisionAnswer['kind']>(result: DecisionResult, kind: K): Extract<DecisionAnswer, { kind: K }> | undefined {
  if (result.status !== 'answered' || result.answer.kind !== kind) return undefined;
  return result.answer as Extract<DecisionAnswer, { kind: K }>;
}

function abstainedOf(result: DecisionResult): PickReason {
  if (result.status === 'answered') return 'not_answered';
  return 'model_abstained';
}

function best(probabilities: Readonly<Record<string, number>>, chosen: string, byOption: ReadonlyMap<string, PickCandidate>): PickOutcome['runnerUp'] {
  let top: { ref: string; probability: number } | undefined;
  for (const [option, probability] of Object.entries(probabilities)) {
    const candidate = byOption.get(option);
    if (option === chosen || !candidate) continue;
    if (!top || probability > top.probability) top = { ref: candidate.ref, probability };
  }
  return top;
}

function describe(candidate: PickCandidate): string {
  const where = candidate.region ? ` in ${candidate.region}` : '';
  return `${candidate.role} "${candidate.name}"${where}`;
}

function stop(reason: PickReason, truncated: boolean): PickOutcome {
  return { decision: 'stop', reason, truncated };
}
