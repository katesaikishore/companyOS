import type { AutomationView } from './agent';
import { LOCAL_EFFECTS } from './autonomy';
import { effectOfOp } from './classify';
import type {
  AppReadinessGate,
  AppReadinessRoutineView,
  AppReadinessRow,
  AppReadinessStatus,
  AppReadinessView,
} from './contract';
import { DEFAULT_MINING, minedKeyOf, recurringUnknownApps, stepKey, type Routine } from './mine';
import { segment, type Segment } from './segment';
import type { TwinEvent, WindowClass } from './types';

const DAY_MS = 86_400_000;

/**
 * The window the switch figures cover. Routines are mined over a longer window, and each switch is matched against them
 * there, so a switch in this window can belong to a routine that was first seen earlier.
 */
export const READINESS_DAYS = 7;

/**
 * The attribution rule. It is deterministic. No model is consulted and no confidence is estimated.
 * - automatable: a mined routine covers the switch, and every routine covering it has only local, reversible steps.
 * - approval: a mined routine covers the switch, and one of the routines covering it has a step that is not local and
 *   reversible. Mail and chat steps are always such a step, so a routine with one of them is an approval.
 * - notYet: no mined routine covers the switch. Every switch of an app that no routine uses is in this group.
 * A routine covers a switch when one of its occurrences includes that switch. Occurrences are found the way mining
 * finds them, in the same stretches of work, so the figures and the routines agree.
 */
export type ReadinessGroup = 'automatable' | 'approval' | 'notYet';

export interface ReadinessInput {
  /** The time the window ends. */
  now: number;
  /**
   * The events the routines were mined from: focus switches, and the idle and lock markers that end a stretch of work.
   * Switches older than the window still shape the stretches, but they are not counted.
   */
  events: readonly TwinEvent[];
  /** The gap that ends a stretch of work. The same value mining uses. */
  idleGapMs: number;
  /** Routines mined from the events. */
  routines: readonly Routine[];
  /** Automations accepted from routines, with their autonomy state and promotion result. */
  automations: readonly AutomationView[];
  /** Routines the person dismissed. They still count in the figures, and the routine list marks them. */
  dismissedRoutineIds: readonly string[];
}

/**
 * Whole percentages for a list of counts. They sum to exactly 100 unless every count is zero. Each share rounds down
 * first, then the points left over go to the largest remainders. A tie goes to the earlier count, so the result never varies.
 */
export function wholePercentages(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return counts.map(() => 0);
  const shares = counts.map(count => (count * 100) / total);
  const percentages = shares.map(share => Math.floor(share));
  const order = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  let left = 100 - percentages.reduce((sum, value) => sum + value, 0);
  for (const { index } of order) {
    if (left === 0) break;
    percentages[index] += 1;
    left -= 1;
  }
  return percentages;
}

/** Switch counts in each group. */
interface Counts {
  automatable: number;
  approval: number;
  notYet: number;
}

/** One app's switches in the window, with their ids for matching against the routines. */
interface Tally {
  windowClass: WindowClass;
  switchIds: string[];
  counts: Counts;
}

/** Which switches the routines cover, and which of those a routine with a step that is not local covers. */
interface Coverage {
  covered: Set<string>;
  asks: Set<string>;
  byRoutine: Map<string, Set<string>>;
}

/** Consecutive switches under one mining key, merged the way mining merges them. */
interface Run {
  key: string;
  events: TwinEvent[];
}

/** A routine as one app's list shows it, with the accepted automation when there is one. */
interface Learned {
  view: AppReadinessRoutineView;
  automation?: AutomationView;
}

/**
 * How much of each app's repeated work could run on its own over the last seven days. Every figure comes from the
 * events and routines passed in. Each row's percentages sum to 100, and so does the overall split.
 */
export function computeReadiness(input: ReadinessInput): AppReadinessView {
  const since = input.now - READINESS_DAYS * DAY_MS;
  const stretches = segment(input.events, input.idleGapMs);
  const coverage = coverRoutines(stretches, input.routines, recurringUnknownApps(stretches, DEFAULT_MINING));

  const total = emptyCounts();
  const tallies = new Map<string, Tally>();
  for (const event of stretches.flatMap(stretch => stretch.events)) {
    if (event.ts < since || !event.app || !event.windowClass) continue;
    const group = groupOf(event.id, coverage);
    total[group] += 1;
    const tally = tallies.get(event.app) ?? { windowClass: event.windowClass, switchIds: [], counts: emptyCounts() };
    tally.counts[group] += 1;
    tally.switchIds.push(event.id);
    tallies.set(event.app, tally);
  }

  const rows = [...tallies].map(([app, tally]) => rowFor(app, tally, input, coverage)).sort(byWeight);
  const [automatablePct, approvalPct, notYetPct] = wholePercentages([total.automatable, total.approval, total.notYet]);
  return {
    switches: total.automatable + total.approval + total.notYet,
    apps: rows.length,
    automatablePct,
    approvalPct,
    notYetPct,
    rows,
  };
}

function emptyCounts(): Counts {
  return { automatable: 0, approval: 0, notYet: 0 };
}

function groupOf(id: string, coverage: Coverage): ReadinessGroup {
  if (!coverage.covered.has(id)) return 'notYet';
  return coverage.asks.has(id) ? 'approval' : 'automatable';
}

/** The row for one app: its split, the reason for it, and the routines it appears in. */
function rowFor(app: string, tally: Tally, input: ReadinessInput, coverage: Coverage): AppReadinessRow {
  const { counts } = tally;
  const [automatablePct, approvalPct, notYetPct] = wholePercentages([counts.automatable, counts.approval, counts.notYet]);
  const learned = input.routines
    .filter(routine => appsOf(routine).includes(app))
    .map(routine => learnedOf(routine, tally.switchIds, coverage, input))
    .sort(byLearned);
  const gate = gateOf(learned.find(item => item.automation));
  return {
    app,
    windowClass: tally.windowClass,
    switches: counts.automatable + counts.approval + counts.notYet,
    automatablePct,
    approvalPct,
    notYetPct,
    status: statusOf(counts),
    reason: reasonOf(counts),
    routines: learned.length,
    learned: learned.map(item => item.view),
    ...(gate ? { gate } : {}),
  };
}

/** One routine as an app's list shows it. Its switch count is the app's switches in the window that the routine covers. */
function learnedOf(routine: Routine, switchIds: readonly string[], coverage: Coverage, input: ReadinessInput): Learned {
  const covered = coverage.byRoutine.get(routine.id) ?? new Set<string>();
  const automation = input.automations.find(view => view.automation.routineId === routine.id);
  const status: AppReadinessRoutineView['status'] = automation
    ? 'accepted'
    : input.dismissedRoutineIds.includes(routine.id)
      ? 'dismissed'
      : 'suggested';
  return {
    view: {
      routineId: routine.id,
      sequence: sequenceOf(routine),
      days: routine.days,
      switches: switchIds.filter(id => covered.has(id)).length,
      kind: routineIsLocal(routine) ? 'automatable' : 'approval',
      status,
      ...(automation
        ? { automationId: automation.automation.id, automationName: automation.automation.name, level: automation.state.level }
        : {}),
    },
    automation,
  };
}

/** The gate of an accepted automation. Its requirements are the promotion result the automation already carries. */
function gateOf(item: Learned | undefined): AppReadinessGate | undefined {
  const automation = item?.automation;
  if (!automation) return undefined;
  return {
    automationId: automation.automation.id,
    automationName: automation.automation.name,
    level: automation.state.level,
    requirements: automation.promotion.requirements,
  };
}

/**
 * Matches every routine against the stretches the way mining does, and records which switches each routine covers.
 * A routine covers a switch only inside one of its occurrences, so a switch outside any repeated sequence is not covered.
 */
function coverRoutines(
  stretches: readonly Segment[],
  routines: readonly Routine[],
  recurring: ReadonlySet<string>,
): Coverage {
  const runs = stretches.map(stretch => runsOf(stretch, recurring));
  const coverage: Coverage = { covered: new Set(), asks: new Set(), byRoutine: new Map() };
  for (const routine of routines) {
    const pattern = routine.steps.map(step => stepKey(step));
    const ids = new Set<string>();
    for (const stretchRuns of runs) {
      for (let start = 0; start + pattern.length <= stretchRuns.length; start++) {
        if (!pattern.every((key, offset) => stretchRuns[start + offset].key === key)) continue;
        for (let offset = 0; offset < pattern.length; offset++) {
          for (const event of stretchRuns[start + offset].events) ids.add(event.id);
        }
      }
    }
    coverage.byRoutine.set(routine.id, ids);
    const local = routineIsLocal(routine);
    for (const id of ids) {
      coverage.covered.add(id);
      if (!local) coverage.asks.add(id);
    }
  }
  return coverage;
}

/**
 * Collapses a stretch into runs of one mining key, as mining does. Apps that mining does not read are skipped and
 * do not break a run.
 */
function runsOf(stretch: Segment, recurring: ReadonlySet<string>): Run[] {
  const runs: Run[] = [];
  for (const event of stretch.events) {
    if (!event.app || !event.windowClass) continue;
    const key = minedKeyOf(
      { windowClass: event.windowClass, app: event.app, urlTemplate: event.urlTemplate },
      recurring,
    );
    if (key === undefined) continue;
    const last = runs.at(-1);
    if (last && last.key === key) last.events.push(event);
    else runs.push({ key, events: [event] });
  }
  return runs;
}

/** Every app a routine's steps may focus, at any position. */
function appsOf(routine: Routine): string[] {
  return [...new Set(routine.steps.flatMap(step => [step.app, ...step.options]))];
}

/**
 * True when every step is local and reversible. Focusing an app is read-only, except for mail and chat, which always
 * ask. A routine that contains one of them is therefore not local.
 */
function routineIsLocal(routine: Routine): boolean {
  return appsOf(routine).every(app => LOCAL_EFFECTS.includes(effectOfOp('focus_app', app)));
}

/** The steps as app names, in order. Apps seen at one position are joined with " or ". */
function sequenceOf(routine: Routine): string {
  return routine.steps.map(step => [...new Set([step.app, ...step.options])].join(' or ')).join(' → ');
}

/** The badge for an app. An app with both automatable and other switches is "partly". */
function statusOf(counts: Counts): AppReadinessStatus {
  if (counts.automatable > 0) return counts.approval === 0 && counts.notYet === 0 ? 'automatable' : 'partly';
  return counts.approval > 0 ? 'approval' : 'not_yet';
}

/** The reason for an app's split, in plain words. Only the parts the app has are named. */
function reasonOf(counts: Counts): string {
  const sentences: string[] = [];
  if (counts.automatable > 0) {
    sentences.push(
      counts.approval === 0 && counts.notYet === 0
        ? 'Only local, reversible steps'
        : 'Local, reversible steps can run on their own',
    );
  }
  if (counts.approval > 0) sentences.push('Mail and chat steps always ask');
  if (counts.notYet > 0) {
    sentences.push(
      counts.automatable === 0 && counts.approval === 0 ? 'No repeated sequence yet' : 'The rest has no repeated sequence yet',
    );
  }
  return sentences.length === 0 ? 'No repeated sequence yet.' : `${sentences.join('. ')}.`;
}

/** Most switches first, then most days, then by sequence. The order never depends on the input order. */
function byLearned(a: Learned, b: Learned): number {
  return (
    b.view.switches - a.view.switches ||
    b.view.days - a.view.days ||
    compareText(a.view.sequence, b.view.sequence) ||
    compareText(a.view.routineId, b.view.routineId)
  );
}

/** Most automatable first, then most switches, then by app name. */
function byWeight(a: AppReadinessRow, b: AppReadinessRow): number {
  return b.automatablePct - a.automatablePct || b.switches - a.switches || compareText(a.app, b.app);
}

/** A plain comparison. Locale collation could order names differently on each machine. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
