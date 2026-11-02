/**
 * The week ahead, from text the person captured on this device. It finds the deadlines, meetings and requests that name a
 * day, and the requests that wait on the person without a date. It reads and lists only. It sends nothing, changes nothing
 * outside the app, and needs no model: a line of text either names a day or it does not.
 */

export interface CapturedText {
  id: number;
  ts: number;
  app: string;
  text: string;
}

export interface WeekItem {
  kind: 'deadline' | 'meeting' | 'request';
  /** The sentence it came from, cut to a short length. */
  text: string;
  /** The day it falls on, as YYYY-MM-DD in local time. Null for a request with no date. */
  day: string | null;
  sourceId: number;
  app: string;
  ts: number;
}

const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
/** Full day names anywhere, and short names only after a word that makes them a day ("on Tue"), so "sat" in a sentence is not a day. */
const DAY_FULL = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const DAY_SHORT_IN_CONTEXT = /\b(?:on|by|this|next|due|from|until)\s+(mon|tues?|wed|thu(?:rs)?|fri|sat|sun)\b/i;
const LINE_STARTS_WITH_DAY = /^\s*(mon|tues?|wed|thu(?:rs)?|fri|sat|sun)(?:day)?\b/i;
const RELATIVE_DAY = /\b(today|tomorrow)\b/i;
const REQUEST = /\b(waiting on you|waiting for you|asked (?:me|you|twice|again)|sign[- ]?off|approvals? (?:needed|required)|assigned (?:you|me)|needs your)\b/i;
const MEETING = /\b(meeting|presentation|standup|sync|interview|review prep)\b/i;
const DEADLINE = /\b(due|deadline|behind schedule|by (?:mon|tue|wed|thu|fri|sat|sun|today|tomorrow))\b/i;
const MAX_TEXT = 160;

function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The next date that falls on the named weekday, counting today as day 0. */
function nextOccurrence(weekday: number, now: Date): Date {
  const ahead = (weekday - now.getDay() + 7) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
}

function dayIndexOf(name: string): number | undefined {
  return WEEKDAY_INDEX[name.slice(0, 3).toLowerCase()];
}

/** The day a sentence names: today, tomorrow, or a weekday, as YYYY-MM-DD. */
function dayOf(sentence: string, now: Date): string | null {
  const relative = RELATIVE_DAY.exec(sentence);
  if (relative) {
    const offset = relative[1].toLowerCase() === 'tomorrow' ? 1 : 0;
    return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  }
  const named = DAY_FULL.exec(sentence) ?? DAY_SHORT_IN_CONTEXT.exec(sentence);
  if (!named) return null;
  const index = dayIndexOf(named[1]);
  return index === undefined ? null : localDay(nextOccurrence(index, now));
}

/** The day a line starts with, such as "Tue" at the start of a week table row. */
function lineDayOf(line: string, now: Date): string | null {
  const start = LINE_STARTS_WITH_DAY.exec(line);
  const index = start ? dayIndexOf(start[1]) : undefined;
  return index === undefined ? null : localDay(nextOccurrence(index, now));
}

function classify(sentence: string): WeekItem['kind'] | null {
  if (REQUEST.test(sentence)) return 'request';
  if (MEETING.test(sentence)) return 'meeting';
  if (DEADLINE.test(sentence)) return 'deadline';
  return null;
}

/**
 * The items in captured text that name a day, and the requests that wait on the person. A line that starts with a day name
 * gives that day to the sentences below it on the same line, so a week table reads correctly. Duplicates on the same day are dropped.
 */
export function weekAhead(captures: readonly CapturedText[], now: Date): WeekItem[] {
  const items: WeekItem[] = [];
  const seen = new Set<string>();
  for (const capture of captures) {
    for (const line of capture.text.split(/\r?\n/)) {
      const lineDay = lineDayOf(line, now);
      for (const raw of line.split(/(?<=[.!?])\s+/)) {
        const sentence = raw.trim();
        if (sentence.length === 0) continue;
        const kind = classify(sentence);
        if (kind === null) continue;
        const day = dayOf(sentence, now) ?? lineDay;
        if (day === null && kind !== 'request') continue;
        const text = sentence.length > MAX_TEXT ? `${sentence.slice(0, MAX_TEXT - 1)}…` : sentence;
        const key = `${kind}|${day ?? ''}|${text.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ kind, text, day, sourceId: capture.id, app: capture.app, ts: capture.ts });
      }
    }
  }
  return items.sort((a, b) => (a.day ?? '9999').localeCompare(b.day ?? '9999') || a.ts - b.ts);
}
