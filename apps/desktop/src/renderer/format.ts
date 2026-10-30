export const DAY_MS = 86_400_000;

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${UNITS[unit]}`;
}

/** Minutes shown as hours with one decimal place. */
export function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} h`;
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function plural(count: number, singular: string, pluralForm: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today 09:14", "Yesterday 18:02", "Tue 11:40", or a date for anything older. */
export function formatWhen(ts: number, now: number = Date.now()): string {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return `Today ${clock(ts)}`;
  if (day === startOfDay(now - DAY_MS)) return `Yesterday ${clock(ts)}`;
  const d = new Date(ts);
  if (today - day < 6 * DAY_MS) return `${WEEKDAYS[d.getDay()]} ${clock(ts)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(ts)}`;
}

export function formatRate(perWeek: number): string {
  return perWeek < 1 ? perWeek.toFixed(1) : String(Math.round(perWeek));
}

/** An app name in title case, such as "Microsoft Word". Names are stored and compared in lower case, so only the display changes. */
export function titleCase(name: string): string {
  return name.replace(/(^|[\s-])(\S)/g, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** App names joined as a routine shows them: " → " between steps and " or " between options. Only the names change case. */
export function titleCaseSequence(sequence: string): string {
  // The split keeps each join, so the odd parts are joins and the even parts are names.
  return sequence
    .split(/( → | or )/)
    .map((part, index) => (index % 2 === 0 ? titleCase(part) : part))
    .join('');
}

/** How often something was noticed. It reads "about once a week" when the rate rounds to one. */
export function noticedPerWeek(perWeek: number): string {
  const rate = formatRate(perWeek);
  return Number(rate) === 1 ? 'Noticed about once a week.' : `Noticed ${rate} times a week.`;
}

/** The source of a summary: OpenMausBot's reply, or companyOS's own message when companyOS itself failed. */
export function summarySourceLabel(localFailure: boolean): string {
  return localFailure ? 'From companyOS' : 'From OpenMausBot';
}

/** A handoff state in words. Each state reads as itself, except unknown, which reads as a neutral status. */
export function handoffStateLabel(state: string): string {
  return state === 'unknown' ? 'Status unknown' : state;
}
