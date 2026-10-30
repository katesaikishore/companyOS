import { createHash } from 'node:crypto';
import type { Segment } from './segment';
import type { WindowClass } from './types';

export interface MiningOptions {
  minLength: number;
  maxLength: number;
  /** Distinct segments a routine must appear in. */
  minSupport: number;
  /** Distinct local days a routine must appear on. */
  minDays: number;
}

export const DEFAULT_MINING: MiningOptions = { minLength: 3, maxLength: 6, minSupport: 3, minDays: 3 };

export interface RoutineStep {
  windowClass: WindowClass;
  /** Most common application at this position. */
  app: string;
  urlTemplate?: string;
  /** Applications observed at this position. More than one means the step is a parameter. */
  options: string[];
}

export interface Routine {
  id: string;
  steps: RoutineStep[];
  support: number;
  days: number;
  /** 0..1. Rises with support and with the number of distinct days. */
  score: number;
  segmentIds: string[];
  /** Mean time from the first to the last step of one occurrence. */
  durationMs: number;
  occurrencesPerWeek: number;
}

interface Step {
  windowClass: WindowClass;
  app: string;
  urlTemplate?: string;
  startTs: number;
  endTs: number;
}

interface Group {
  segments: Set<string>;
  days: Set<string>;
  occurrences: Step[][];
}

/**
 * Collapses consecutive focus events of the same window class. 'other' apps are not mined. Each step keeps the
 * time it started and the time the next app took focus, so routine durations can be estimated.
 */
function collapse(segment: Segment): Step[] {
  const steps: Step[] = [];
  const events = segment.events;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!event.app || !event.windowClass || event.windowClass === 'other') continue;
    const endTs = events[index + 1]?.ts ?? segment.endTs;
    const last = steps[steps.length - 1];
    if (last && last.windowClass === event.windowClass) {
      last.endTs = endTs;
      continue;
    }
    steps.push({
      windowClass: event.windowClass,
      app: event.app,
      ...(event.urlTemplate ? { urlTemplate: event.urlTemplate } : {}),
      startTs: event.ts,
      endTs,
    });
  }
  return steps;
}

function dayOf(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function countBy<T>(items: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function mostCommon<T>(items: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestCount = 0;
  for (const [item, count] of countBy(items)) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}

function toRoutine(key: string, group: Group, weeks: number): Routine {
  const length = key.split('>').length;
  const steps: RoutineStep[] = [];
  for (let position = 0; position < length; position++) {
    const observed = group.occurrences.map(occurrence => occurrence[position]);
    const appCounts = countBy(observed.map(step => step.app));
    const options = [...appCounts.keys()].sort(
      (a, b) => (appCounts.get(b) ?? 0) - (appCounts.get(a) ?? 0) || a.localeCompare(b),
    );
    const urlTemplate = mostCommon(observed.map(step => step.urlTemplate).filter((t): t is string => !!t));
    steps.push({
      windowClass: observed[0].windowClass,
      app: options[0],
      ...(urlTemplate ? { urlTemplate } : {}),
      options: options.slice(0, 5),
    });
  }

  const support = group.segments.size;
  const days = group.days.size;
  const durations = group.occurrences.map(occurrence => occurrence[occurrence.length - 1].endTs - occurrence[0].startTs);
  const durationMs = durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length);
  return {
    id: createHash('sha256').update(key).digest('hex').slice(0, 12),
    steps,
    support,
    days,
    score: Number((Math.min(1, support / 10) * Math.min(1, days / 7)).toFixed(3)),
    segmentIds: [...group.segments],
    durationMs: Math.round(durationMs),
    occurrencesPerWeek: Number((support / Math.max(1, weeks)).toFixed(2)),
  };
}

/**
 * Finds contiguous sequences of window classes that recur across segments and days.
 * Routines are keyed by window class, so an app that changes at a position (Excel vs Calc)
 * becomes an option at that position rather than splitting the routine.
 * Only maximal routines are returned: a shorter routine that sits inside a longer one with
 * the same support is dropped.
 */
export function mineRoutines(segments: readonly Segment[], options: MiningOptions = DEFAULT_MINING): Routine[] {
  const groups = new Map<string, Group>();

  for (const segment of segments) {
    const steps = collapse(segment);
    const day = dayOf(segment.startTs);
    const seenInSegment = new Set<string>();
    for (let length = options.minLength; length <= options.maxLength; length++) {
      for (let start = 0; start + length <= steps.length; start++) {
        const window = steps.slice(start, start + length);
        const key = window.map(step => step.windowClass).join('>');
        if (seenInSegment.has(key)) continue;
        seenInSegment.add(key);

        const group = groups.get(key) ?? { segments: new Set(), days: new Set(), occurrences: [] };
        group.segments.add(segment.id);
        group.days.add(day);
        group.occurrences.push(window);
        groups.set(key, group);
      }
    }
  }

  const frequent = [...groups.entries()]
    .filter(([, group]) => group.segments.size >= options.minSupport && group.days.size >= options.minDays)
    .sort(([a, ga], [b, gb]) => b.length - a.length || gb.segments.size - ga.segments.size);

  const maximal: Array<[string, Group]> = [];
  for (const candidate of frequent) {
    const [key, group] = candidate;
    const dominated = maximal.some(
      ([longerKey, longer]) =>
        longerKey.length > key.length &&
        longer.segments.size === group.segments.size &&
        `>${longerKey}>`.includes(`>${key}>`),
    );
    if (!dominated) maximal.push(candidate);
  }

  const starts = segments.map(segment => segment.startTs);
  const ends = segments.map(segment => segment.endTs);
  const spanMs = starts.length ? Math.max(...ends) - Math.min(...starts) : 0;
  const weeks = Math.max(1, spanMs / (7 * 86_400_000));
  return maximal.map(([key, group]) => toRoutine(key, group, weeks)).sort((a, b) => b.score - a.score);
}
