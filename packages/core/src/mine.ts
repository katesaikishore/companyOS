import { createHash } from 'node:crypto';
import { isShellApp, isSiteLikeName, isSystemProcess, normalizeAppName } from './classify';
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
  /** The same value as site. Kept for readers that already use it. */
  urlTemplate?: string;
  /** The site a browser step visited, as urlTemplate gives it: the host and the first path segment. */
  site?: string;
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
  /** When the latest occurrence began, in ms. */
  lastSeenAt: number;
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

/** The name an unknown app keys under: its normalised name, with any '>' removed, because keys are joined with it. */
function unknownName(app: string): string {
  return normalizeAppName(app).replace(/>/g, '');
}

/**
 * The key that tells one step from another. A window class alone would merge every browser visit, so a browser step
 * also carries its site. 'other' apps are keyed by name, so two of them never merge. Keys are joined with '>', so any
 * '>' in a name or a site is removed.
 */
export function stepKey(step: { windowClass: WindowClass; app: string; urlTemplate?: string }): string {
  const base = step.windowClass === 'other' ? `other:${unknownName(step.app)}` : step.windowClass;
  const key = step.urlTemplate ? `${base}@${step.urlTemplate}` : base;
  return key.replace(/>/g, '');
}

/**
 * The unknown apps that recur: used in at least minSupport stretches of work, on at least minDays days. An app seen once,
 * or on one day, is noise. As a step it would also break the routine around it, so it is not mined.
 */
export function recurringUnknownApps(segments: readonly Segment[], options: MiningOptions): Set<string> {
  const seen = new Map<string, { segments: Set<string>; days: Set<string> }>();
  for (const segment of segments) {
    const day = dayOf(segment.startTs);
    for (const event of segment.events) {
      if (!event.app || event.windowClass !== 'other' || unknownName(event.app) === '') continue;
      const key = stepKey({ windowClass: event.windowClass, app: event.app, urlTemplate: event.urlTemplate });
      const entry = seen.get(key) ?? { segments: new Set<string>(), days: new Set<string>() };
      entry.segments.add(segment.id);
      entry.days.add(day);
      seen.set(key, entry);
    }
  }
  return new Set(
    [...seen]
      .filter(([, entry]) => entry.segments.size >= options.minSupport && entry.days.size >= options.minDays)
      .map(([key]) => key),
  );
}

/**
 * The key a focus event is mined under, or undefined when mining does not read it. A system process, a shell and a
 * terminal are never read, whether the catalogue lists them or not, since a shell or terminal can run commands. A
 * catalogued app is read as before. An unknown app is read only when it recurs, and never when its name carries a host.
 * Readiness uses this too, so the two read the same events.
 */
export function minedKeyOf(
  step: { windowClass: WindowClass; app: string; urlTemplate?: string },
  recurring: ReadonlySet<string>,
): string | undefined {
  if (isSystemProcess(step.app) || isShellApp(step.app)) return undefined;
  if (step.windowClass !== 'other') return stepKey(step);
  if (isSiteLikeName(step.app)) return undefined;
  const key = stepKey(step);
  return recurring.has(key) ? key : undefined;
}

/** True for the key of a browser step, with or without a site. */
function isBrowserKey(key: string): boolean {
  return key === 'browser' || key.startsWith('browser@');
}

/**
 * The key a focus event joins when it follows a run keyed `last`, or undefined when it starts a new run. A browser visit
 * with no site joins a browser run whatever its site, and a visit with a site takes over a browser run that has none yet.
 * So a new tab between two site visits does not split them. Any other event joins only a run with the same key.
 */
export function joinedKey(last: string, key: string): string | undefined {
  if (last === key) return key;
  if (!isBrowserKey(last) || !isBrowserKey(key)) return undefined;
  if (key === 'browser') return last;
  if (last === 'browser') return key;
  return undefined;
}

/**
 * Collapses consecutive focus events into steps. Two events join one step when joinedKey says so, so a run on one site
 * is one step, and a visit with no site does not split a run of site visits. Apps that mining does not read are skipped
 * (see minedKeyOf). Each step keeps the time it started and the time the next app took focus, so routine durations can
 * be estimated.
 */
function collapse(segment: Segment, recurring: ReadonlySet<string>): Step[] {
  const steps: Step[] = [];
  const events = segment.events;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!event.app || !event.windowClass) continue;
    const key = minedKeyOf(
      { windowClass: event.windowClass, app: event.app, urlTemplate: event.urlTemplate },
      recurring,
    );
    if (key === undefined) continue;
    const endTs = events[index + 1]?.ts ?? segment.endTs;
    const last = steps[steps.length - 1];
    const joined = last ? joinedKey(stepKey(last), key) : undefined;
    if (last && joined !== undefined) {
      // A visit with a site gives its site to a browser step that has none, so the step is keyed by that site from then on.
      if (event.urlTemplate && last.urlTemplate === undefined) last.urlTemplate = event.urlTemplate;
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
      ...(urlTemplate ? { urlTemplate, site: urlTemplate } : {}),
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
    lastSeenAt: group.occurrences.reduce((latest, occurrence) => Math.max(latest, occurrence[0].startTs), 0),
  };
}

/**
 * Finds contiguous sequences of steps that recur across segments and days.
 * Routines are keyed by step (see stepKey), so an app that changes at a position (Excel vs Calc)
 * becomes an option at that position rather than splitting the routine. An unknown app is keyed
 * by its name instead, so it never becomes an option.
 * Only maximal routines are returned: a shorter routine that sits inside a longer one with
 * the same support is dropped.
 */
export function mineRoutines(segments: readonly Segment[], options: MiningOptions = DEFAULT_MINING): Routine[] {
  const groups = new Map<string, Group>();
  const recurring = recurringUnknownApps(segments, options);

  for (const segment of segments) {
    const steps = collapse(segment, recurring);
    const day = dayOf(segment.startTs);
    const seenInSegment = new Set<string>();
    for (let length = options.minLength; length <= options.maxLength; length++) {
      for (let start = 0; start + length <= steps.length; start++) {
        const window = steps.slice(start, start + length);
        const key = window.map(step => stepKey(step)).join('>');
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
