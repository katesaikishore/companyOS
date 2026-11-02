import { normalizeAppName } from '../classify';
import type { Routine } from '../mine';

/**
 * The company brain: the routines the twin has mined, and the rule that gives each spreadsheet task either to one of them
 * or to the person. Matching is lexical and deterministic, with no embedding model, so the same tasks and routines always
 * give the same allocations. A task that no routine covers well enough is left to the person and is never automated.
 */

/** The target of a task the person keeps. Routine ids are 12 hex digits, so this can never be one. */
export const PERSON = 'you';

/** Confidence at or above which a task is given to a routine. A design value, not a measured one. */
export const AUTOMATE_MIN_CONFIDENCE = 0.5;

/** Terms shorter than this carry too little to match on. A design value. */
const MIN_TERM_LENGTH = 3;

/** Words that carry no meaning for matching. A design value. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'your', 'our', 'are', 'was', 'will', 'has', 'have',
  'not', 'all', 'any', 'each', 'per', 'about', 'then', 'than', 'when', 'where',
]);

/**
 * The words a person uses for an application, mapped to the term the routines use for it. A design value. "Sheet" and
 * "Microsoft Excel" must meet at one term, so a task that says sheet can match a routine that opens Excel. The map runs
 * before the length check, so "dm" still reaches "slack".
 */
const SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['sheet', 'excel'], ['spreadsheet', 'excel'], ['workbook', 'excel'], ['csv', 'excel'], ['table', 'excel'],
  ['mail', 'outlook'], ['email', 'outlook'], ['emails', 'outlook'], ['inbox', 'outlook'],
  ['doc', 'word'], ['docs', 'word'], ['document', 'word'], ['memo', 'word'], ['letter', 'word'],
  ['chat', 'slack'], ['message', 'slack'], ['messages', 'slack'], ['dm', 'slack'],
  ['ticket', 'jira'], ['tickets', 'jira'], ['issue', 'jira'], ['issues', 'jira'],
  ['invoice', 'invoice'], ['invoices', 'invoice'],
]);

const NO_ROUTINE_REASON = 'No routine covers this task, so it is left to you.';

/** What the brain works from: the routines it may give work to. */
export interface CompanyBrain {
  readonly routines: readonly Routine[];
}

/** The brain over a set of routines. It copies the list, so later changes to the caller's array do not reach the brain. */
export function buildBrain(routines: readonly Routine[]): CompanyBrain {
  return { routines: [...routines] };
}

/** A spreadsheet task: an id the caller keeps, and the free text the person wrote. */
export interface BrainTask {
  id: string;
  text: string;
}

/** What the brain decided for one task. */
export interface Allocation {
  taskId: string;
  /** The routine id the task goes to, or PERSON. */
  target: string;
  /** 0..1: share of the task's terms that the best routine covers. */
  confidence: number;
  /** The best-matching routine id, even when the target is PERSON. Undefined when no routine shares a term. */
  matchedRoutine?: string;
  /** The terms that matched, in task order. */
  matchedTerms: string[];
  /** One short plain sentence a person can read, for example "excel, word covered by routine r-3 (2 of 3 terms)". Never echo more than the matched terms and the routine id. */
  reason: string;
}

/** Summary of a set of allocations, for showing how far the brain takes the work over. */
export interface Understanding {
  tasks: number;
  /** Tasks given to a routine. */
  automated: number;
  /** automated / tasks. 0 when there are no tasks. */
  coverage: number;
  /** Mean confidence over all tasks. 0 when there are no tasks. */
  meanConfidence: number;
  /** Tasks that have an expected target in the labels. */
  labelled: number;
  /** Share of labelled tasks whose target equals the expected target. Undefined when nothing is labelled. */
  agreement?: number;
}

/**
 * The terms of a text, in first-seen order and each once: lowercase words of letters and digits, with the synonym map
 * applied, and short words and stop-words dropped. Tasks and routines both go through this, so their terms meet.
 */
function termsOf(text: string): string[] {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const term = SYNONYMS.get(word) ?? word;
    if (term.length < MIN_TERM_LENGTH || STOP_WORDS.has(term)) continue;
    terms.add(term);
  }
  return [...terms];
}

/**
 * The terms a routine can do: the words of each step's application, site and address shape, and of every application
 * seen at a step. Application names go through normalizeAppName first, so "Excel.exe" reads as "excel" and not "exe".
 */
function vocabularyOf(routine: Routine): Set<string> {
  const vocabulary = new Set<string>();
  for (const step of routine.steps) {
    for (const name of [step.app, ...step.options]) {
      for (const term of termsOf(normalizeAppName(name))) vocabulary.add(term);
    }
    for (const place of [step.site, step.urlTemplate]) {
      if (place) for (const term of termsOf(place)) vocabulary.add(term);
    }
  }
  return vocabulary;
}

/** A routine and the task terms it covers, in task order. */
interface Match {
  routine: Routine;
  matched: string[];
}

/**
 * True when the challenger beats the current best. More covered terms win first. Every routine is measured against the
 * same terms, so comparing counts orders them the same as comparing shares, and counts avoid float ties. Then the higher
 * score wins, then the lower id in string order, so the result does not depend on the order of the routines.
 */
function beats(challenger: Match, current: Match): boolean {
  if (challenger.matched.length !== current.matched.length) return challenger.matched.length > current.matched.length;
  if (challenger.routine.score !== current.routine.score) return challenger.routine.score > current.routine.score;
  return challenger.routine.id < current.routine.id;
}

/** The best routine for the terms, or undefined when no routine covers any of them. Routines with no steps never match. */
function bestRoutine(terms: readonly string[], routines: readonly Routine[]): Match | undefined {
  let best: Match | undefined;
  for (const routine of routines) {
    if (routine.steps.length === 0) continue;
    const vocabulary = vocabularyOf(routine);
    const matched = terms.filter(term => vocabulary.has(term));
    if (matched.length === 0) continue;
    const candidate: Match = { routine, matched };
    if (!best || beats(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * The allocation of one task. The task goes to the routine that covers the largest share of its terms, when that share
 * reaches minConfidence. Otherwise the person keeps it, and the near miss is still named, so it can be seen why. A task
 * with no usable terms, such as one made of stop-words, is left to the person with no routine named.
 */
export function allocateTask(
  task: BrainTask,
  brain: CompanyBrain,
  minConfidence: number = AUTOMATE_MIN_CONFIDENCE,
): Allocation {
  const terms = termsOf(task.text);
  const best = terms.length === 0 ? undefined : bestRoutine(terms, brain.routines);
  if (!best) {
    return { taskId: task.id, target: PERSON, confidence: 0, matchedTerms: [], reason: NO_ROUTINE_REASON };
  }
  // Rounded before the threshold check, so the confidence shown is the one that was compared.
  const confidence = Math.round((best.matched.length / terms.length) * 100) / 100;
  const id = best.routine.id;
  const covers = `${best.matched.join(', ')} (${best.matched.length} of ${terms.length} terms)`;
  if (confidence >= minConfidence) {
    return {
      taskId: task.id,
      target: id,
      confidence,
      matchedRoutine: id,
      matchedTerms: best.matched,
      reason: `Routine ${id} covers ${covers}.`,
    };
  }
  return {
    taskId: task.id,
    target: PERSON,
    confidence,
    matchedRoutine: id,
    matchedTerms: best.matched,
    reason: `Closest routine ${id} covers ${covers}, below the threshold, so this is left to you.`,
  };
}

/**
 * The allocations of a list of tasks, in input order. A task id may appear once. The allocations are looked up by id,
 * so a repeated id would make two of them look like one, and the whole list is refused.
 */
export function allocateTasks(
  tasks: readonly BrainTask[],
  brain: CompanyBrain,
  minConfidence: number = AUTOMATE_MIN_CONFIDENCE,
): Allocation[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error('Task ids must be unique.');
    seen.add(task.id);
  }
  return tasks.map(task => allocateTask(task, brain, minConfidence));
}

/**
 * How far the brain takes the work over, and how well its targets agree with the labels. `expected` maps a task id to its
 * expected target (a routine id, or PERSON). Labels for tasks that are not in the allocations are ignored.
 */
export function understanding(allocations: readonly Allocation[], expected?: ReadonlyMap<string, string>): Understanding {
  const tasks = allocations.length;
  const automated = allocations.filter(allocation => allocation.target !== PERSON).length;
  let confidenceTotal = 0;
  let labelled = 0;
  let agreed = 0;
  for (const allocation of allocations) {
    confidenceTotal += allocation.confidence;
    const wanted = expected?.get(allocation.taskId);
    if (wanted === undefined) continue;
    labelled += 1;
    if (wanted === allocation.target) agreed += 1;
  }
  return {
    tasks,
    automated,
    coverage: tasks === 0 ? 0 : automated / tasks,
    meanConfidence: tasks === 0 ? 0 : confidenceTotal / tasks,
    labelled,
    ...(labelled === 0 ? {} : { agreement: agreed / labelled }),
  };
}
