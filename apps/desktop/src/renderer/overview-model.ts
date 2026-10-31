import type { NetworkEntry } from '@companyos/twin-core';
import { DAY_MS, plural, titleCase } from './format.js';

export const RHYTHM_DAYS: readonly string[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The hours the rhythm grid shows, one column each. */
export const RHYTHM_HOURS: readonly number[] = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
/** How many days the network strip covers. The last one is today. */
export const NETWORK_DAYS = 14;

const MONTH_NAMES: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The sentence under the page title: the app switches recorded, and that the data stays encrypted. */
export function summaryLine(recordedFocusEvents: number, observedDays: number): string {
  const privacy = 'Your data stays encrypted on this device.';
  if (recordedFocusEvents === 0) return `No app switches recorded yet. ${privacy}`;
  const span = observedDays === 0 ? 'today' : `over ${plural(observedDays, 'day')}`;
  return `${plural(recordedFocusEvents, 'app switch', 'app switches')} ${span}. ${privacy}`;
}

/** Network calls made in the seven days up to now. */
export function networkCallsThisWeek(network: readonly { ts: number }[], now: number): number {
  const weekAgo = now - 7 * DAY_MS;
  return network.filter(entry => entry.ts >= weekAgo).length;
}

export interface NetworkDay {
  /** The day as a short date, such as "24 Oct". */
  label: string;
  downloads: number;
  checks: number;
}

export interface NetworkSummary {
  calls: number;
  bytes: number;
  downloads: number;
  checks: number;
  /** The hosts called in the window, sorted. */
  hosts: string[];
  /** One entry per day, oldest first. */
  days: NetworkDay[];
}

/** The calls made in the last NETWORK_DAYS days, counted by local calendar day. */
export function networkSummary(network: readonly NetworkEntry[], now: number): NetworkSummary {
  const today = new Date(now);
  const days: NetworkDay[] = [];
  const slotOf = new Map<string, number>();
  for (let back = NETWORK_DAYS - 1; back >= 0; back -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    slotOf.set(day.toDateString(), days.length);
    days.push({ label: `${day.getDate()} ${MONTH_NAMES[day.getMonth()]}`, downloads: 0, checks: 0 });
  }

  const hosts = new Set<string>();
  let calls = 0;
  let bytes = 0;
  for (const entry of network) {
    const slot = slotOf.get(new Date(entry.ts).toDateString());
    if (slot === undefined) continue;
    const day = days[slot];
    calls += 1;
    bytes += entry.bytes;
    hosts.add(entry.host);
    if (entry.purpose === 'model_download') day.downloads += 1;
    else day.checks += 1;
  }

  return {
    calls,
    bytes,
    downloads: days.reduce((sum, day) => sum + day.downloads, 0),
    checks: days.reduce((sum, day) => sum + day.checks, 0),
    hosts: [...hosts].sort(),
    days,
  };
}

/** The apps a routine opens, in order, with an app repeated in a row shown once. Only act steps move focus. */
export function routineChain(steps: readonly { kind: 'act' | 'check'; app: string }[]): string[] {
  const apps: string[] = [];
  for (const step of steps) {
    if (step.kind !== 'act') continue;
    const name = titleCase(step.app);
    if (apps[apps.length - 1] !== name) apps.push(name);
  }
  return apps;
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
