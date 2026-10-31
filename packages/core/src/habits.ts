import type { HabitsView, SessionMinutesView, StretchMinutesView, UsualAppView, UsualHoursView } from './contract';
import { segment, type Segment } from './segment';
import { DEFAULT_CONFIG, type TwinEvent, type WindowClass } from './types';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * How far back the habits look. A design value: four weeks, the span of the activity grid, so each weekday recurs
 * about four times.
 */
export const HABITS_WINDOW_DAYS = 28;
/** Observed days needed before any habit is shown. A design value: one working week. */
export const MIN_OBSERVED_DAYS = 5;
/** Observed days a weekday needs before its usual hours are named. A design value: one day is a single sample. */
export const MIN_WEEKDAY_DAYS = 2;
/** Work segments needed before their median length is shown. A design value. */
export const MIN_SEGMENTS = 5;
/** App switches a window class needs before its most used app is named. A design value. */
export const MIN_CLASS_EVENTS = 5;
/** Stretches a window class needs before its median time in one app is shown. A design value. */
export const MIN_STRETCHES = 5;

/** An app switch: a focus event that names its app and window class. Titles and content never reach an event. */
type AppSwitch = TwinEvent & { app: string; windowClass: WindowClass };

/** A local calendar day with at least one app switch, and the times of its first and last switch. */
interface DaySpan {
  /** 0 is Monday, as in the activity grid. */
  weekday: number;
  firstTs: number;
  lastTs: number;
}

/** Consecutive switches into one app, kept as one run from the time of its first switch. */
interface AppRun {
  app: string;
  windowClass: WindowClass;
  startTs: number;
}

/**
 * How the person usually works, over the last four weeks. The result depends only on the events and the time it is
 * given, so the same input always gives the same summary. Nothing is stored. Until enough days are observed, the
 * summary says so and names no habit, rather than guessing one. It reads app names, window classes and times only.
 */
export function habits(events: readonly TwinEvent[], now: number, idleGapMs = DEFAULT_CONFIG.idleGapMs): HabitsView {
  const since = now - HABITS_WINDOW_DAYS * DAY_MS;
  const inWindow = events.filter(event => event.ts >= since && event.ts <= now);
  const switches = inWindow.filter(isAppSwitch);
  const spans = daySpans(switches);
  if (spans.length < MIN_OBSERVED_DAYS) {
    return {
      state: 'not_enough_data',
      windowDays: HABITS_WINDOW_DAYS,
      observedDays: spans.length,
      requiredDays: MIN_OBSERVED_DAYS,
    };
  }
  // The idle gap is the one the person configured, so segments match the routines and the readiness figures.
  const segments = segment(inWindow, idleGapMs);
  return {
    state: 'ready',
    windowDays: HABITS_WINDOW_DAYS,
    observedDays: spans.length,
    usualHours: usualHours(spans),
    sessionMinutes: sessionMinutes(segments),
    usualAppPerKind: usualAppPerKind(switches),
    stretchMinutes: stretchMinutes(segments),
  };
}

/** Only a focus event that names its app and window class counts, as in segmentation. */
function isAppSwitch(event: TwinEvent): event is AppSwitch {
  return event.kind === 'focus' && !!event.app && !!event.windowClass;
}

/** Groups the switches by local calendar day, so a day means the day the person lived, not the UTC day. */
function daySpans(switches: readonly AppSwitch[]): DaySpan[] {
  const spans = new Map<string, DaySpan>();
  for (const event of switches) {
    const date = new Date(event.ts);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const span = spans.get(key);
    if (span) {
      span.firstTs = Math.min(span.firstTs, event.ts);
      span.lastTs = Math.max(span.lastTs, event.ts);
    } else {
      spans.set(key, { weekday: mondayFirst(date), firstTs: event.ts, lastTs: event.ts });
    }
  }
  return [...spans.values()];
}

/** The usual start and end hour for each weekday, Monday first. A weekday with too few days gets no hour. */
function usualHours(spans: readonly DaySpan[]): UsualHoursView[] {
  return Array.from({ length: 7 }, (_, weekday) => {
    const days = spans.filter(span => span.weekday === weekday);
    const enoughData = days.length >= MIN_WEEKDAY_DAYS;
    return {
      weekday,
      days: days.length,
      enoughData,
      startHour: enoughData ? roundTo(median(days.map(span => hourOf(span.firstTs))), 2) : null,
      endHour: enoughData ? roundTo(median(days.map(span => hourOf(span.lastTs))), 2) : null,
    };
  });
}

/** The length runs from the first app switch of a segment to its last, so a segment with one switch has length zero. */
function sessionMinutes(segments: readonly Segment[]): SessionMinutesView {
  const lengths = segments.map(work => (work.endTs - work.startTs) / MINUTE_MS);
  return {
    segments: segments.length,
    medianMinutes: segments.length >= MIN_SEGMENTS ? roundTo(median(lengths), 1) : null,
  };
}

/**
 * For each window class seen often enough, the app used most and its share of the class's switches. The class order is
 * by switches, then by name, so the list never depends on the order of the events.
 */
function usualAppPerKind(switches: readonly AppSwitch[]): UsualAppView[] {
  const appsByClass = new Map<WindowClass, Map<string, number>>();
  for (const event of switches) {
    const counts = appsByClass.get(event.windowClass) ?? new Map<string, number>();
    counts.set(event.app, (counts.get(event.app) ?? 0) + 1);
    appsByClass.set(event.windowClass, counts);
  }
  const views: UsualAppView[] = [];
  for (const [windowClass, counts] of appsByClass) {
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (total < MIN_CLASS_EVENTS) continue;
    // A tie goes to the name that sorts first, so the answer does not depend on the order of the events.
    const [app, count] = [...counts].sort(([a, x], [b, y]) => y - x || compareText(a, b))[0];
    views.push({ windowClass, switches: total, app, sharePct: Math.round((count * 100) / total) });
  }
  return views.sort((a, b) => b.switches - a.switches || compareText(a.windowClass, b.windowClass));
}

/**
 * For each window class, the time the person stayed in one app before switching to another. A stretch runs from the
 * first switch into an app to the first switch into the next app, inside one segment. The last app of a segment has no
 * switch after it, so nothing ends its stretch and it is not counted.
 */
function stretchMinutes(segments: readonly Segment[]): StretchMinutesView[] {
  const durationsByClass = new Map<WindowClass, number[]>();
  for (const work of segments) {
    const runs = appRuns(work.events);
    for (let index = 0; index + 1 < runs.length; index++) {
      const run = runs[index];
      const durations = durationsByClass.get(run.windowClass) ?? [];
      durations.push((runs[index + 1].startTs - run.startTs) / MINUTE_MS);
      durationsByClass.set(run.windowClass, durations);
    }
  }
  return [...durationsByClass]
    .map(([windowClass, durations]) => ({
      windowClass,
      stretches: durations.length,
      medianMinutes: durations.length >= MIN_STRETCHES ? roundTo(median(durations), 1) : null,
    }))
    .sort((a, b) => b.stretches - a.stretches || compareText(a.windowClass, b.windowClass));
}

/** Consecutive switches into the same app, merged into one run. Other events are skipped. */
function appRuns(events: readonly TwinEvent[]): AppRun[] {
  const runs: AppRun[] = [];
  for (const event of events) {
    if (!isAppSwitch(event) || runs.at(-1)?.app === event.app) continue;
    runs.push({ app: event.app, windowClass: event.windowClass, startTs: event.ts });
  }
  return runs;
}

/** Monday is 0. */
function mondayFirst(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** The local hour of a time, with the minutes as a fraction, so 09:30 is 9.5. */
function hourOf(ts: number): number {
  const date = new Date(ts);
  return date.getHours() + date.getMinutes() / 60;
}

/** The middle value, or the mean of the two middle values. Null for an empty list. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Rounds to a number of decimal places. Null stays null, so a missing median needs no separate branch. */
function roundTo(value: number | null, places: number): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** A plain comparison. Locale collation could order names differently on each machine. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
