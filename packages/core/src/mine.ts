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

/**
 * When a routine's occurrences began, in local time. Each occurrence counts once, by the start of its first step.
 * weekdays holds seven counts, Monday first. The hours cover the 10th to the 90th percentile of the start hour, in
 * whole hours: fromHour is the first of them, and toHour is the hour after the last, so 9 and 10 give 9 to 11.
 */
export interface RoutineWhen {
  weekdays: number[];
  fromHour: number;
  toHour: number;
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
  /** When the occurrences began, in local time. See RoutineWhen. */
  when: RoutineWhen;
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

/**
 * The id of a routine: the first 12 hex digits of the SHA-256 of its signature. The signature is the step keys of the
 * routine joined with '>', so a stored signature names its routine by hash, and the same routine keeps its id.
 */
export function routineIdOf(signature: string): string {
  return createHash('sha256').update(signature).digest('hex').slice(0, 12);
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
    id: routineIdOf(key),
    steps,
    support,
    days,
    score: Number((Math.min(1, support / 10) * Math.min(1, days / 7)).toFixed(3)),
    segmentIds: [...group.segments],
    durationMs: Math.round(durationMs),
    occurrencesPerWeek: Number((support / Math.max(1, weeks)).toFixed(2)),
    lastSeenAt: group.occurrences.reduce((latest, occurrence) => Math.max(latest, occurrence[0].startTs), 0),
    when: whenOf(group.occurrences),
  };
}

/** The weekday counts and the usual hours of the occurrences. Local time, so a Monday is a Monday for the person. */
function whenOf(occurrences: readonly Step[][]): RoutineWhen {
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const hours: number[] = [];
  for (const occurrence of occurrences) {
    const start = new Date(occurrence[0].startTs);
    weekdays[(start.getDay() + 6) % 7] += 1;
    hours.push(start.getHours());
  }
  hours.sort((a, b) => a - b);
  return { weekdays, fromHour: nearestRank(hours, 10), toHour: nearestRank(hours, 90) + 1 };
}

/** The value at a percentile, by nearest rank: the smallest value that at least that share of the sorted values reach. */
function nearestRank(sorted: readonly number[], percent: number): number {
  return sorted[Math.ceil((percent * sorted.length) / 100) - 1];
}

/** A range of hours at most this wide is named as a time of day. Wider, the hours spread too far to name one. */
const MAX_BAND_HOURS = 6;
/** A range of hours at most this wide is also given exactly, as in "around 9 to 11 am". */
const MAX_EXACT_HOURS = 3;
/** The share of occurrences a weekday group needs before the routine is said to fall on it. */
const GROUP_SHARE = 80;
/** The share of occurrences that the named days must cover. */
const NAMED_SHARE = 70;

const WEEKDAY_NAMES = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const GROUPS = {
  weekdays: { adjective: 'weekday', plural: 'weekdays' },
  weekends: { adjective: 'weekend', plural: 'weekends' },
} as const;
const BANDS = {
  morning: { plural: 'mornings', phrase: 'in the morning' },
  afternoon: { plural: 'afternoons', phrase: 'in the afternoon' },
  evening: { plural: 'evenings', phrase: 'in the evening' },
  night: { plural: 'nights', phrase: 'at night' },
} as const;

/**
 * Plain text for when a routine usually happens, such as "Usually weekday mornings, around 9 to 11 am" or "Mostly
 * Mondays and Wednesdays, in the afternoon". The days are named as a group when most occurrences fall in it. Hours
 * that spread too wide are left out, rather than named loosely.
 */
export function describeWhen(when: RoutineWhen): string {
  if (sum(when.weekdays) === 0) return 'No usual time yet.';
  const width = when.toHour - when.fromHour;
  const band = width <= MAX_BAND_HOURS ? bandOf(when.fromHour, when.toHour) : undefined;
  const exact = width <= MAX_EXACT_HOURS ? `around ${clockRange(when.fromHour, when.toHour)}` : undefined;
  const group = weekdayGroup(when.weekdays);
  if (group) {
    const subject = band ? `${GROUPS[group].adjective} ${BANDS[band].plural}` : GROUPS[group].plural;
    return `Usually ${subject}${exact ? `, ${exact}` : ''}`;
  }
  const days = namedDays(when.weekdays);
  const lead = days ? `Mostly ${days}` : 'Spread across the week';
  const time = exact ?? (band ? BANDS[band].phrase : undefined);
  return time ? `${lead}, ${time}` : lead;
}

/** The weekday group the routine falls on: most occurrences in it, and four or more weekdays or both weekend days seen. */
function weekdayGroup(counts: readonly number[]): 'weekdays' | 'weekends' | undefined {
  const total = sum(counts);
  const weekdays = counts.slice(0, 5);
  const weekend = counts.slice(5);
  if (isShare(sum(weekdays), total, GROUP_SHARE) && weekdays.filter(count => count > 0).length >= 4) return 'weekdays';
  if (isShare(sum(weekend), total, GROUP_SHARE) && weekend.every(count => count > 0)) return 'weekends';
  return undefined;
}

/** The days that cover most occurrences, in week order. Undefined when four or more are needed, so the week is spread. */
function namedDays(counts: readonly number[]): string | undefined {
  const chosen = coveringDays(counts);
  return chosen.length >= 4 ? undefined : joinNames(chosen.map(day => WEEKDAY_NAMES[day]));
}

/** The fewest days, busiest first, whose occurrences reach NAMED_SHARE of the total. Returned in week order. */
function coveringDays(counts: readonly number[]): number[] {
  const total = sum(counts);
  const ranked = counts
    .map((count, day) => ({ day, count }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count || a.day - b.day);
  const chosen: number[] = [];
  let covered = 0;
  for (const item of ranked) {
    if (isShare(covered, total, NAMED_SHARE)) break;
    chosen.push(item.day);
    covered += item.count;
  }
  return chosen.sort((a, b) => a - b);
}

/** "Mondays", "Mondays and Wednesdays", "Mondays, Wednesdays and Fridays". */
function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The time of day a range of hours falls in, judged by its middle. Night is what the other bands leave. */
function bandOf(fromHour: number, toHour: number): keyof typeof BANDS {
  const middle = (fromHour + toHour) / 2;
  if (middle >= 5 && middle < 12) return 'morning';
  if (middle >= 12 && middle < 17) return 'afternoon';
  if (middle >= 17 && middle < 21) return 'evening';
  return 'night';
}

/**
 * The hours of a range in words, such as "9 to 11 am", or "11 am to 1 pm" when the range crosses a period. The period is
 * said once when both ends share it. toHour is the hour after the range, so 9 to 11 covers 9:00 to 11:00.
 */
function clockRange(fromHour: number, toHour: number): string {
  const end = toHour % 24;
  const samePeriod = (fromHour < 12) === (end < 12);
  const plain = fromHour % 12 !== 0 && end % 12 !== 0 && samePeriod;
  if (plain) return `${fromHour % 12} to ${end % 12} ${end < 12 ? 'am' : 'pm'}`;
  return `${clockWord(fromHour)} to ${clockWord(toHour)}`;
}

/** A clock hour in words: "9 am", "2 pm", "noon" or "midnight". */
function clockWord(hour: number): string {
  if (hour % 24 === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return `${hour % 12} ${hour % 24 < 12 ? 'am' : 'pm'}`;
}

/** True when part is at least the given percentage of whole. Integers only, so rounding never decides a boundary. */
function isShare(part: number, whole: number, percent: number): boolean {
  return part * 100 >= whole * percent;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
