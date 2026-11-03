import { z } from 'zod';
import type { LocalCompleter } from './types';

/**
 * Longest wait for one plan, counted from the moment it is asked, so it includes any wait behind a naming request. The
 * model is loaded before this starts. A plan is a few numbers, which a 1.7B model writes in a few seconds on CPU.
 */
export const PLAN_TIMEOUT_MS = 60_000;
/** Room for {"run": [ ... ]} with a few numbers, pretty-printed. Short on purpose: a cut-off answer is a model error. */
const PLAN_MAX_TOKENS = 48;
/** The most automations shown to the model. The rest are left out, lowest priority first. */
export const PLAN_MAX_CANDIDATES = 9;
/** The most runs one plan may start together. */
export const PLAN_MAX_RUNS = 3;
/** Longest automation or app name shown to the model, in characters, so the prompt stays well under the worker's limit. */
const MAX_SHOWN_CHARS = 40;

/** One automation the planner may choose: its id, what the person sees, and what Recall saw of its apps. */
export interface PlanCandidate {
  automationId: string;
  name: string;
  apps: readonly string[];
  /** Recall observations of the routine's apps in the last seven days. Zero when Recall saw none. */
  observations: number;
  /** The Recall ranking's score. Higher comes first. */
  priority: number;
  /** Estimated minutes a week the routine saves, when known. */
  minutesPerWeek?: number;
}

export type PlanFallbackReason = 'no_model' | 'timeout' | 'model_error' | 'invalid_output';

/**
 * The automations to run, in the order given, and where the choice came from: the local model, or the Recall ranking
 * when the model was missing, slow, failed or answered something unusable.
 */
export type RunPlan =
  | { source: 'model'; automationIds: string[] }
  | { source: 'rules'; reason: PlanFallbackReason; automationIds: string[] };

export interface PlanRunsOptions {
  /** The local model. Without one, the Recall ranking decides. */
  completer?: LocalCompleter;
  timeoutMs?: number;
  /** The most runs to start. Capped at PLAN_MAX_RUNS. */
  maxRuns?: number;
}

/**
 * The instructions for planning. The model is told what it sees, which is the person's own automations with their apps
 * and how often Recall saw those apps, and that it can only pick numbers from the list.
 */
export const PLANNER_SYSTEM_PROMPT = [
  'You help a person decide which of their own computer routines to run now.',
  'You see a numbered list of routines, with the apps each one uses and how often those apps were seen this week.',
  'Pick the routines most worth running now: ones seen often and ones that save more time.',
  'Reply with JSON of the form {"run": [numbers]}, using only numbers from the list.',
].join(' ');

/** Plain text for the prompt: control characters and chat markers removed, cut to a fixed length. */
function shown(text: string): string {
  const plain = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/<\|[^|]*\|>|<\/?think>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length <= MAX_SHOWN_CHARS ? plain : `${plain.slice(0, MAX_SHOWN_CHARS - 1)}…`;
}

/**
 * The candidates the planner may choose from, highest priority first and at most PLAN_MAX_CANDIDATES. Ties keep the
 * order they were given in.
 */
export function planCandidates(candidates: readonly PlanCandidate[]): PlanCandidate[] {
  return [...candidates]
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.priority - a.candidate.priority || a.index - b.index)
    .slice(0, PLAN_MAX_CANDIDATES)
    .map(entry => entry.candidate);
}

/**
 * The user message: the numbered routines with their apps, Recall counts and time saved. Abstract data only. No window
 * titles, screen text, field values or addresses reach the model.
 */
export function planPrompt(candidates: readonly PlanCandidate[], maxRuns: number): string {
  const lines = candidates.map((candidate, index) => {
    const apps = candidate.apps.length > 0 ? candidate.apps.map(shown).join(', ') : 'no app named';
    const seen = candidate.observations === 1 ? 'seen once this week' : `seen ${candidate.observations} times this week`;
    const saves = candidate.minutesPerWeek ? `, saves about ${Math.round(candidate.minutesPerWeek)} minutes a week` : '';
    return `${index + 1}. ${shown(candidate.name)} (apps: ${apps}; ${seen}${saves})`;
  });
  const most = maxRuns === 1 ? 'one routine' : `between one and ${maxRuns} routines`;
  return ['Routines:', ...lines, `Choose ${most} to run now. /no_think`].join('\n');
}

/** The JSON Schema the model is held to: an array of one to maxRuns numbers, each one of the listed positions. */
export function planJsonSchema(count: number, maxRuns: number): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties: {
      run: {
        type: 'array',
        items: { enum: Array.from({ length: count }, (_, index) => index + 1) },
        minItems: 1,
        maxItems: maxRuns,
      },
    },
    required: ['run'],
    additionalProperties: false,
  };
}

/** Checks what the model produced, again after the grammar: a strict object of listed positions, repeats dropped. */
function checkedPositions(answer: unknown, count: number, maxRuns: number): number[] | undefined {
  const schema = z
    .object({ run: z.array(z.number().int().min(1).max(count)).min(1).max(maxRuns) })
    .strict();
  const parsed = schema.safeParse(answer);
  if (!parsed.success) return undefined;
  return [...new Set(parsed.data.run)];
}

/**
 * Asks the local model which candidates to run now. The candidates are cut to the highest-priority few first. The model
 * can only answer with their positions, and its answer is checked again. Without a model, or on a timeout, an error or
 * an unusable answer, the Recall ranking decides: the highest-priority candidates, up to maxRuns. This never throws.
 */
export async function planRuns(candidates: readonly PlanCandidate[], options: PlanRunsOptions = {}): Promise<RunPlan> {
  const listed = planCandidates(candidates);
  const maxRuns = Math.max(1, Math.min(options.maxRuns ?? PLAN_MAX_RUNS, PLAN_MAX_RUNS, listed.length));
  const byRules = (reason: PlanFallbackReason): RunPlan => ({
    source: 'rules',
    reason,
    automationIds: listed.slice(0, maxRuns).map(candidate => candidate.automationId),
  });
  if (listed.length === 0) return { source: 'rules', reason: 'no_model', automationIds: [] };
  const completer = options.completer;
  if (!completer) return byRules('no_model');

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('expired');
    }, options.timeoutMs ?? PLAN_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() =>
        completer.complete({
          system: PLANNER_SYSTEM_PROMPT,
          prompt: planPrompt(listed, maxRuns),
          schema: planJsonSchema(listed.length, maxRuns),
          maxTokens: PLAN_MAX_TOKENS,
          signal: controller.signal,
        }),
      ),
      expired,
    ]);
    if (answer === 'expired') return byRules('timeout');
    const positions = checkedPositions(answer, listed.length, maxRuns);
    if (!positions) return byRules('invalid_output');
    return { source: 'model', automationIds: positions.map(position => listed[position - 1].automationId) };
  } catch {
    // The error text is dropped on purpose, as the namer does. It can name files or processes.
    return byRules(controller.signal.aborted ? 'timeout' : 'model_error');
  } finally {
    clearTimeout(timer);
  }
}
