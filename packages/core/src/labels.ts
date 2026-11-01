import type { WindowClass } from './types';
import { normalizeAppName } from './classify';
import type { ChoiceQuestion, DecisionModel, DecisionResult } from './decision';

/**
 * A kind of work a routine can be labelled with, shown beside its suggestion. The first eight match the catalogue's window
 * classes. 'Other' means none of them fits, which includes an app the catalogue does not know.
 */
export const KIND_LABELS = ['Web', 'Code', 'Spreadsheets', 'Documents', 'Email', 'Messages', 'Terminal', 'Design', 'Mixed', 'Other'] as const;
export type KindLabel = (typeof KIND_LABELS)[number];

const KIND_DESCRIPTIONS: Readonly<Record<KindLabel, string>> = {
  Web: 'web browsers',
  Code: 'code editors and software development tools',
  Spreadsheets: 'spreadsheets and data tables',
  Documents: 'word processors, notes and documents',
  Email: 'email and calendar apps',
  Messages: 'chat and messaging apps',
  Terminal: 'terminals and command-line tools',
  Design: 'design, drawing and presentation tools',
  Mixed: 'several different kinds of work, with no one kind in charge',
  Other: 'none of the above, or an app that is not known',
};

const RULE_KIND: Readonly<Partial<Record<WindowClass, KindLabel>>> = {
  browser: 'Web',
  editor: 'Code',
  spreadsheet: 'Spreadsheets',
  document: 'Documents',
  mail: 'Email',
  chat: 'Messages',
  terminal: 'Terminal',
  design: 'Design',
};

/**
 * The least confidence at which a model's label is shown. Below it the rule-based label is kept. Set from the accuracy
 * check against the catalogue (scripts/laya-check, docs/research/laya-decision-layer.md). On 57 catalogue names with the
 * current labels: at 0.7, 95% of the labels shown matched the catalogue's kind, for 35% of the names. At 0.5 the shown
 * labels were 86% correct, for 51% of the names. The check is one model on one machine, so the number may move.
 */
export const KIND_MIN_CONFIDENCE = 0.7;

/** One step of a routine: the app and the window class the catalogue gives it. Only these two fields are read. */
export interface KindStep {
  app: string;
  windowClass: WindowClass;
}

/** Why the label came from the rules. Undefined when the model's label is shown. */
export type KindFallback = 'all_known' | 'no_model' | 'unavailable' | 'low_confidence' | 'other' | 'invalid';

export interface KindLabeling {
  kind: KindLabel;
  source: 'model' | 'rule';
  /** The model's probability for its label. Only when source is model. */
  confidence?: number;
  reason?: KindFallback;
}

/** The rule-based label for one window class. */
export function ruleKindOfClass(windowClass: WindowClass): KindLabel {
  return RULE_KIND[windowClass] ?? 'Other';
}

/**
 * The rule-based label of a routine. A kind is named only when it is more than half of the steps that have a kind: a
 * routine that is one kind of work is that kind, and a routine that mixes kinds is 'Mixed', rather than whichever kind
 * came first. A routine with no kind at all, such as one made only of unknown apps, is 'Other'.
 */
export function ruleKindOfSteps(steps: readonly KindStep[]): KindLabel {
  const counts = new Map<KindLabel, number>();
  for (const step of steps) {
    const kind = ruleKindOfClass(step.windowClass);
    if (kind === 'Other') continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return 'Other';
  for (const [kind, count] of counts) {
    if (count * 2 > total) return kind;
  }
  return counts.size === 1 ? [...counts.keys()][0] : 'Mixed';
}

/** True when a routine has a step the catalogue does not know. Only these routines are sent to the model. */
export function hasUnknownStep(steps: readonly KindStep[]): boolean {
  return steps.some(step => step.windowClass === 'other');
}

const KIND_INSTRUCTIONS =
  'These apps were used one after another in a repeated routine at work. Which kind of work do they belong to? Choose the one kind that fits best.';

/** The question put to the model. It names only the labels and what they mean. */
export function kindQuestion(): ChoiceQuestion {
  return {
    kind: 'choice',
    instructions: KIND_INSTRUCTIONS,
    options: KIND_LABELS.map(id => ({ id, description: KIND_DESCRIPTIONS[id] })),
  };
}

/**
 * Labels one routine. A routine whose steps are all known gets its rule-based label and the model is not asked. Otherwise
 * the model answers with the app names only, and its label is shown when it is one of the kinds, is not 'Other', and is
 * at least KIND_MIN_CONFIDENCE. Anything else, including an abstention, an error or a timeout, keeps the rule-based label.
 *
 * The label is for display only. Policy, approvals and what a routine may do never read it, so a model cannot widen them.
 */
export async function labelKind(steps: readonly KindStep[], model: DecisionModel, signal?: AbortSignal): Promise<KindLabeling> {
  const rule = (reason: KindFallback): KindLabeling => ({ kind: ruleKindOfSteps(steps), source: 'rule', reason });
  if (!hasUnknownStep(steps)) return rule('all_known');

  const apps = [...new Set(steps.map(step => normalizeAppName(step.app)))];
  let result: DecisionResult;
  try {
    result = await model.decide({ state: { apps }, question: kindQuestion() }, signal);
  } catch {
    return rule('unavailable');
  }
  if (result.status === 'abstained') return rule(result.reason === 'no_model' ? 'no_model' : 'unavailable');

  const answer = result.answer;
  if (answer.kind !== 'choice' || !(KIND_LABELS as readonly string[]).includes(answer.choice)) return rule('invalid');
  if (answer.choice === 'Other') return rule('other');
  if (!(answer.confidence >= KIND_MIN_CONFIDENCE)) return rule('low_confidence');
  return { kind: answer.choice as KindLabel, source: 'model', confidence: answer.confidence };
}

export interface KindLabelJobDeps {
  /** Routines that may need a label: detected, neither accepted nor dismissed, and not yet labelled by the model. */
  routines(): ReadonlyArray<{ routineId: string; steps: readonly KindStep[] }>;
  /** Stores a label. Called only for a model label or a rule label with a reason the model can change later. */
  setKind(routineId: string, labeling: KindLabeling): void;
  model: DecisionModel;
  /** False when the model is not installed. Nothing is asked then. */
  available(): boolean;
  /** False on battery or while the person is busy. The job waits. */
  allowed(): boolean;
  /** Most routines labelled in one pass. */
  perPass?: number;
}

/**
 * Labels routines a few at a time, in the background. A pass stops early when the model is unavailable, so a missing or
 * failing model costs one call per pass. A routine whose answer was "no model" or "unavailable" is not stored, so it is
 * tried again once the model is there.
 */
export class KindLabelJob {
  private running = false;

  constructor(private readonly deps: KindLabelJobDeps) {}

  /** True while a pass is asking the model. A caller that frees the model waits for this to be false. */
  get busy(): boolean {
    return this.running;
  }

  /** Labels up to perPass routines and returns how many were stored. Never throws. */
  async pass(signal?: AbortSignal): Promise<number> {
    if (this.running || !this.deps.available() || !this.deps.allowed()) return 0;
    this.running = true;
    let stored = 0;
    try {
      for (const routine of this.deps.routines().slice(0, this.deps.perPass ?? 5)) {
        if (signal?.aborted) break;
        const labeling = await labelKind(routine.steps, this.deps.model, signal);
        if (labeling.reason === 'no_model' || labeling.reason === 'unavailable') break;
        this.deps.setKind(routine.routineId, labeling);
        stored++;
      }
      return stored;
    } catch {
      return stored;
    } finally {
      this.running = false;
    }
  }
}
