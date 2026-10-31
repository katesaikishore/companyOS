import type { DraftStep } from '@companyos/twin-core';
import { DAY_MS, formatWhen, plural } from './format.js';

/** Counts spelled out in the hero title, up to twelve. Larger counts keep their digits. */
const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

export const RHYTHM_DAYS: readonly string[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The hours the rhythm grid shows, one column each. */
export const RHYTHM_HOURS: readonly number[] = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

/** The hero title. It counts the routines the twin has found and not yet accepted or dismissed. */
export function foundTitle(found: number): string {
  if (found <= 0) return 'No routines found yet.';
  if (found === 1) return 'One routine found.';
  const count = found < COUNT_WORDS.length ? COUNT_WORDS[found] : String(found);
  return `${count} routines found.`;
}

/** The last sentence of the hero lede. It says when a run can start, and that is all it says. */
const RUN_RULE = 'Nothing runs unless you start it, or you have turned on unattended runs for an automation at level 4.';

/**
 * The lede under the hero title. It states only the counts the engine reports, then when a run can start.
 */
export function heroLede(recordedFocusEvents: number, observedDays: number): string {
  if (recordedFocusEvents === 0) {
    return `Your twin has not recorded any app switches yet. It learns from app switches and their timing. ${RUN_RULE}`;
  }
  const span = observedDays === 0 ? 'today' : `over ${plural(observedDays, 'day')}`;
  return `Your twin noticed ${plural(recordedFocusEvents, 'app switch', 'app switches')} ${span}. ${RUN_RULE}`;
}

/**
 * Automations at each autonomy level, L0 to L5, by position. Level 5 is never counted: external runs are not built,
 * so it stays at zero whatever the automations hold.
 */
export function ladderCounts(automations: readonly { state: { level: number } }[]): number[] {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const { state } of automations) {
    if (state.level >= 0 && state.level <= 4) counts[state.level] += 1;
  }
  return counts;
}

/** Network calls made in the seven days up to now. */
export function networkCallsThisWeek(network: readonly { ts: number }[], now: number): number {
  const weekAgo = now - 7 * DAY_MS;
  return network.filter(entry => entry.ts >= weekAgo).length;
}

/** Intensity buckets for the rhythm grid: 0 is empty, 3 is the busiest cell shown. */
export function rhythmLevels(activity: readonly (readonly number[])[]): { level: number; count: number }[][] {
  const counts = RHYTHM_DAYS.map((_, day) => RHYTHM_HOURS.map(hour => activity[day]?.[hour] ?? 0));
  const max = Math.max(0, ...counts.flat());
  return counts.map(row =>
    row.map(count => {
      if (count <= 0 || max === 0) return { level: 0, count };
      const ratio = count / max;
      if (ratio <= 0.34) return { level: 1, count };
      if (ratio <= 0.67) return { level: 2, count };
      return { level: 3, count };
    }),
  );
}

/** The apps a routine opens, in order. Checks are left out, and an app repeated straight after itself is shown once. */
export function routineApps(steps: readonly DraftStep[]): { app: string; alternatives: number }[] {
  const apps: { app: string; alternatives: number }[] = [];
  for (const step of steps) {
    if (step.kind !== 'act' || apps.at(-1)?.app === step.app) continue;
    apps.push({ app: step.app, alternatives: step.alternatives });
  }
  return apps;
}

/**
 * How often a suggestion repeated in the 30-day window, across how many days, and the estimate of the hand time it
 * takes. The estimate is labelled as one.
 */
export function routineEvidence(support: number, days: number, minutesPerWeek: number): string {
  return `${plural(support, 'time', 'times')} in the last 30 days, across ${plural(days, 'day')} · about ${Math.round(minutesPerWeek)} min / week by hand (estimate)`;
}

/** When a routine last began, in words such as "Today 09:14" or "Tue 11:40". */
export function lastSeenLabel(ts: number, now: number = Date.now()): string {
  const when = formatWhen(ts, now).replace(/^(Today|Yesterday)/, word => word.toLowerCase());
  return `Last seen ${when}`;
}

/** Minutes a week shown as hours with one decimal place. The unit is printed beside the figure. */
export function hoursBack(minutesPerWeek: number): string {
  return (minutesPerWeek / 60).toFixed(1);
}
