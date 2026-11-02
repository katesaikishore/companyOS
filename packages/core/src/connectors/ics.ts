import { buildItem, connectorSourceId, parseParameters, type ConnectorItem } from './types';

/**
 * Reads an iCalendar (RFC 5545) text and returns its events that fall in a time window, as calendar items.
 *
 * Handled: line folding, property parameters, UTC times ending in Z, floating times (read as this machine's local time),
 * all-day dates (read as local midnight, and the text says "All-day event."), TZID zones (converted with Intl; a zone
 * Intl does not know is read as UTC, and the item text says so), text escapes (\n, \, \; and \\), and EXDATE.
 *
 * A recurring event is expanded for FREQ=DAILY, FREQ=WEEKLY (with an optional BYDAY) and FREQ=MONTHLY, using INTERVAL,
 * COUNT and UNTIL. The expansion is bounded to the window and to 500 occurrences per event: an event with more
 * occurrences in the window imports its first 500, and its text says so. A rule that uses any other part is not
 * expanded: only DTSTART is imported, and the text says so. A RECURRENCE-ID override replaces the matching occurrence of
 * its series. An event that cannot be read is skipped, and the others are still returned.
 *
 * An occurrence is in the window when it starts at or after window.from and before window.to (milliseconds). sourceId is
 * a hash of the UID and the occurrence's start, so reading the same file again gives the same ids.
 */

/** The time range an import keeps, in milliseconds. */
export interface IcsWindow {
  from: number;
  to: number;
}

/** The most occurrences one recurring event contributes to a window. */
export const ICS_MAX_OCCURRENCES = 500;

const DAY_MS = 86_400_000;
/** The most steps one rule may take, so a rule that never reaches the window still ends. */
const MAX_RECURRENCE_STEPS = 1_000_000;
/** Wall-clock time and UTC never differ by more than 14 hours, so a day this far outside the window cannot be inside it. */
const OFFSET_MARGIN_MS = 2 * DAY_MS;
/** Most zone formatters kept at once. A file can name many zones, so the cache is cleared when it is full. */
const MAX_CACHED_ZONES = 256;

type Zone = { kind: 'date' } | { kind: 'floating' } | { kind: 'utc' } | { kind: 'zoned'; tzid: string; known: boolean };

interface IcsDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  zone: Zone;
}

interface Wall {
  hour: number;
  minute: number;
  second: number;
}

interface ContentLine {
  name: string;
  params: Map<string, string>;
  value: string;
}

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY';

interface Recurrence {
  freq: Freq;
  interval: number;
  count: number | null;
  until: IcsDate | null;
  /** Monday is 0. Null when BYDAY is absent. */
  weekdays: readonly number[] | null;
}

type RuleOutcome = { kind: 'once' } | { kind: 'repeat'; rule: Recurrence } | { kind: 'unsupported' };

/** Occurrences to leave out: exact instants for timed values, wall-clock day numbers for all-day values. */
interface Exclusions {
  instants: Set<number>;
  days: Set<number>;
}

interface EventRecord {
  /** The UID, or a stand-in built from the summary and start when there is none. Never shown, only hashed. */
  key: string;
  summary: string;
  location: string;
  description: string;
  start: IcsDate;
  recurrenceId: IcsDate | null;
  outcome: RuleOutcome;
  exdates: IcsDate[];
}

interface Expansion {
  instants: number[];
  capped: boolean;
}

const WEEKDAY_INDEX = new Map<string, number>([
  ['MO', 0],
  ['TU', 1],
  ['WE', 2],
  ['TH', 3],
  ['FR', 4],
  ['SA', 5],
  ['SU', 6],
]);
const SUPPORTED_RULE_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i;
const formatters = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Parses an iCalendar text and returns the events in the window, sorted by start. A VEVENT nested in another component
 * such as VALARM is not read as an event, and its properties are not taken as the event's own.
 */
export function parseIcs(text: string, window: IcsWindow): ConnectorItem[] {
  if (!Number.isFinite(window.from) || !Number.isFinite(window.to) || window.to <= window.from) return [];

  const records: EventRecord[] = [];
  for (const props of collectEvents(text)) {
    try {
      const record = buildRecord(props);
      if (record) records.push(record);
    } catch {
      // A malformed event is skipped. The others are still read.
    }
  }

  // An override names the occurrence of its series that it replaces, so that occurrence is not imported twice.
  const replaced = new Map<string, Exclusions>();
  for (const record of records) {
    if (record.recurrenceId === null) continue;
    let set = replaced.get(record.key);
    if (!set) {
      set = emptyExclusions();
      replaced.set(record.key, set);
    }
    addKey(set, record.recurrenceId);
  }

  const items = new Map<string, ConnectorItem>();
  for (const record of records) {
    try {
      for (const item of itemsOf(record, window, replaced.get(record.key))) {
        if (!items.has(item.sourceId)) items.set(item.sourceId, item);
      }
    } catch {
      // A record that cannot be expanded is skipped. The others are still returned.
    }
  }
  return [...items.values()].sort((a, b) => a.ts - b.ts || compareText(a.sourceId, b.sourceId));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Joins folded lines: a CRLF followed by a space or a tab continues the line, and that one character is removed. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const last = lines.length - 1;
    if ((line.startsWith(' ') || line.startsWith('\t')) && last >= 0) {
      lines[last] = `${lines[last] ?? ''}${line.slice(1)}`;
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** Returns the properties of each VEVENT, for events that are closed by END:VEVENT. */
function collectEvents(text: string): ContentLine[][] {
  const events: ContentLine[][] = [];
  const stack: string[] = [];
  let current: ContentLine[] | null = null;
  for (const line of unfold(text)) {
    const parsed = parseContentLine(line);
    if (!parsed) continue;
    if (parsed.name === 'BEGIN') {
      const component = parsed.value.trim().toUpperCase();
      stack.push(component);
      if (component === 'VEVENT') current = [];
      continue;
    }
    if (parsed.name === 'END') {
      const component = parsed.value.trim().toUpperCase();
      const index = stack.lastIndexOf(component);
      if (index >= 0) stack.length = index;
      if (component === 'VEVENT' && current) {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (current && stack[stack.length - 1] === 'VEVENT') current.push(parsed);
  }
  return events;
}

/** Splits `NAME;PARAM=VALUE:value` at the first colon that is not inside quotes. */
function parseContentLine(line: string): ContentLine | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const { head, params } = parseParameters(line.slice(0, colon));
  return { name: head.toUpperCase(), params, value: line.slice(colon + 1) };
}

function buildRecord(props: ContentLine[]): EventRecord | null {
  const first = (name: string): ContentLine | undefined => props.find((prop) => prop.name === name);
  const dtstart = first('DTSTART');
  if (!dtstart) return null;
  const start = parseIcsDate(dtstart.value, dtstart.params);
  if (!start) return null;

  const recurrenceProp = first('RECURRENCE-ID');
  let recurrenceId: IcsDate | null = null;
  if (recurrenceProp) {
    recurrenceId = parseIcsDate(recurrenceProp.value, recurrenceProp.params);
    if (!recurrenceId) return null;
  }

  const exdates: IcsDate[] = [];
  for (const prop of props) {
    if (prop.name !== 'EXDATE') continue;
    for (const piece of prop.value.split(',')) {
      const date = parseIcsDate(piece, prop.params);
      if (date) exdates.push(date);
    }
  }

  const summary = unescapeText(first('SUMMARY')?.value ?? '');
  const uid = (first('UID')?.value ?? '').trim();
  return {
    key: uid !== '' ? uid : `anon|${summary}|${dtstart.value}`,
    summary,
    location: unescapeText(first('LOCATION')?.value ?? ''),
    description: unescapeText(first('DESCRIPTION')?.value ?? ''),
    start,
    recurrenceId,
    outcome: parseRule(first('RRULE')?.value),
    exdates,
  };
}

/** Reads a DATE, a floating or UTC DATE-TIME, or a DATE-TIME with a TZID. Returns null when the value is not valid. */
function parseIcsDate(value: string, params: Map<string, string>): IcsDate | null {
  const match = DATE_TIME.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hasTime = match[4] !== undefined;
  const hour = hasTime ? Number(match[4]) : 0;
  const minute = hasTime ? Number(match[5]) : 0;
  const second = hasTime && match[6] !== undefined ? Number(match[6]) : 0;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let zone: Zone;
  if (!hasTime) {
    zone = { kind: 'date' };
  } else if (match[7] !== undefined) {
    zone = { kind: 'utc' };
  } else {
    const tzid = params.get('tzid');
    zone = tzid ? { kind: 'zoned', tzid, known: formatterFor(tzid) !== null } : { kind: 'floating' };
  }
  return { year, month, day, hour, minute, second, zone };
}

/** Reads an RRULE. Anything outside the supported subset is 'unsupported', so the event is not expanded. */
function parseRule(value: string | undefined): RuleOutcome {
  if (value === undefined || value.trim() === '') return { kind: 'once' };
  const parts = new Map<string, string>();
  for (const piece of value.toUpperCase().split(';')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) return { kind: 'unsupported' };
    const key = piece.slice(0, eq).trim();
    if (!SUPPORTED_RULE_PARTS.has(key) || parts.has(key)) return { kind: 'unsupported' };
    parts.set(key, piece.slice(eq + 1).trim());
  }

  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return { kind: 'unsupported' };

  const intervalText = parts.get('INTERVAL') ?? '1';
  if (!/^\d+$/.test(intervalText) || Number(intervalText) < 1) return { kind: 'unsupported' };
  const interval = Number(intervalText);

  const countText = parts.get('COUNT');
  let count: number | null = null;
  if (countText !== undefined) {
    if (!/^\d+$/.test(countText) || Number(countText) < 1) return { kind: 'unsupported' };
    count = Number(countText);
  }

  const untilText = parts.get('UNTIL');
  let until: IcsDate | null = null;
  if (untilText !== undefined) {
    until = parseIcsDate(untilText, new Map<string, string>());
    if (!until) return { kind: 'unsupported' };
  }

  let weekdays: number[] | null = null;
  const bydayText = parts.get('BYDAY');
  if (bydayText !== undefined) {
    if (freq !== 'WEEKLY') return { kind: 'unsupported' };
    const days: number[] = [];
    for (const token of bydayText.split(',')) {
      const index = WEEKDAY_INDEX.get(token.trim());
      if (index === undefined) return { kind: 'unsupported' };
      days.push(index);
    }
    weekdays = [...new Set(days)].sort((a, b) => a - b);
  }

  // Weeks are counted from Monday. Another week start changes which days an interval skips, so it is not expanded.
  const wkst = parts.get('WKST');
  if (wkst !== undefined && wkst !== 'MO' && weekdays !== null && interval > 1) return { kind: 'unsupported' };

  return { kind: 'repeat', rule: { freq, interval, count, until, weekdays } };
}

function itemsOf(record: EventRecord, window: IcsWindow, replaced: Exclusions | undefined): ConnectorItem[] {
  const isOverride = record.recurrenceId !== null;
  const rule = !isOverride && record.outcome.kind === 'repeat' ? record.outcome.rule : null;
  const excluded = isOverride ? emptyExclusions() : exclusionsFor(record.exdates, replaced);
  const expansion = expand(record.start, rule, excluded, window);
  const keyInstant = record.recurrenceId !== null ? instantOfDate(record.recurrenceId) : null;
  const text = eventText(record, expansion.capped);
  const items: ConnectorItem[] = [];
  for (const instant of expansion.instants) {
    const item = buildItem({
      source: 'calendar',
      sourceId: connectorSourceId('ics', record.key, String(keyInstant ?? instant)),
      ts: instant,
      title: record.summary,
      text,
      location: record.location,
    });
    if (item) items.push(item);
  }
  return items;
}

/** The notes that say how an event was read, then its own description. */
function eventText(record: EventRecord, capped: boolean): string {
  const notes: string[] = [];
  if (record.start.zone.kind === 'date') notes.push('All-day event.');
  if (record.start.zone.kind === 'zoned' && !record.start.zone.known) {
    notes.push('The time zone of this event is not known, so its times are read as UTC.');
  }
  if (record.recurrenceId === null && record.outcome.kind === 'unsupported') {
    notes.push('This event repeats with a rule that is not expanded, so only its first occurrence is imported.');
  }
  if (capped) notes.push(`Only the first ${ICS_MAX_OCCURRENCES} occurrences in the window are imported.`);
  return [notes.join(' '), record.description].filter((part) => part !== '').join('\n\n');
}

/**
 * Lists the occurrences of one event that start in the window. DTSTART is always the first occurrence. COUNT counts every
 * occurrence the rule produces, including excluded ones and those before the window. Days that the rule skips, such as a
 * month with no 31st, are not occurrences.
 */
function expand(start: IcsDate, rule: Recurrence | null, excluded: Exclusions, window: IcsWindow): Expansion {
  const startDay = dayNumber(start.year, start.month, start.day);
  const wall: Wall = { hour: start.hour, minute: start.minute, second: start.second };
  const timeOfDay = (start.zone.kind === 'date' ? 0 : (wall.hour * 3600 + wall.minute * 60 + wall.second) * 1000);
  const days: Iterable<number> = rule ? candidateDays(startDay, rule) : [startDay];
  const until = rule?.until ?? null;
  const untilDay = until ? dayNumber(until.year, until.month, until.day) : null;
  const untilInstant =
    until && until.zone.kind !== 'date'
      ? instantOfDate(until.zone.kind === 'floating' ? { ...until, zone: start.zone } : until)
      : null;
  const limit = rule?.count ?? null;

  const instants: number[] = [];
  let produced = 0;
  let steps = 0;
  for (const day of days) {
    steps += 1;
    if (steps > MAX_RECURRENCE_STEPS) break;
    if (limit !== null && produced >= limit) break;
    produced += 1;
    if (untilDay !== null && day > untilDay) break;

    // Wall-clock time read as UTC is close to the real instant, so most days outside the window are skipped without
    // converting the zone.
    const approx = day * DAY_MS + timeOfDay;
    if (approx + OFFSET_MARGIN_MS < window.from) continue;
    if (approx - OFFSET_MARGIN_MS >= window.to) break;

    const instant = instantOfWall(day, wall, start.zone);
    if (untilInstant !== null && day === untilDay && instant > untilInstant) break;
    if (instant < window.from || instant >= window.to) continue;
    if (excluded.days.has(day) || excluded.instants.has(instant)) continue;
    if (instants.length === ICS_MAX_OCCURRENCES) return { instants, capped: true };
    instants.push(instant);
  }
  return { instants, capped: false };
}

/** Day numbers (days since the epoch, as a UTC date) of each occurrence, in ascending order. */
function* candidateDays(start: number, rule: Recurrence): Generator<number> {
  const { freq, interval } = rule;
  if (freq === 'DAILY') {
    for (let k = 0; k < MAX_RECURRENCE_STEPS; k += 1) yield start + k * interval;
    return;
  }
  if (freq === 'WEEKLY') {
    const weekdays = rule.weekdays;
    if (weekdays === null) {
      for (let k = 0; k < MAX_RECURRENCE_STEPS; k += 1) yield start + 7 * interval * k;
      return;
    }
    yield start;
    const weekStart = start - mondayIndex(start);
    for (let week = 0; week < MAX_RECURRENCE_STEPS; week += 1) {
      const base = weekStart + 7 * interval * week;
      for (const weekday of weekdays) {
        const day = base + weekday;
        if (day > start) yield day;
      }
    }
    return;
  }
  const { y, mo, d } = civil(start);
  const firstMonth = y * 12 + (mo - 1);
  for (let k = 0; k < MAX_RECURRENCE_STEPS; k += 1) {
    const total = firstMonth + k * interval;
    const year = Math.floor(total / 12);
    const month = total - year * 12 + 1;
    if (d <= daysInMonth(year, month)) yield dayNumber(year, month, d);
  }
}

function exclusionsFor(exdates: readonly IcsDate[], replaced: Exclusions | undefined): Exclusions {
  const set = emptyExclusions();
  for (const date of exdates) addKey(set, date);
  if (replaced) {
    for (const instant of replaced.instants) set.instants.add(instant);
    for (const day of replaced.days) set.days.add(day);
  }
  return set;
}

function emptyExclusions(): Exclusions {
  return { instants: new Set<number>(), days: new Set<number>() };
}

function addKey(set: Exclusions, date: IcsDate): void {
  if (date.zone.kind === 'date') set.days.add(dayNumber(date.year, date.month, date.day));
  else set.instants.add(instantOfDate(date));
}

/** Undoes the escapes of a TEXT value: \n and \N give a newline; \, \; and \\ give the character. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match: string, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

function instantOfDate(date: IcsDate): number {
  return instantFor(date.year, date.month, date.day, date.hour, date.minute, date.second, date.zone);
}

function instantOfWall(day: number, wall: Wall, zone: Zone): number {
  const { y, mo, d } = civil(day);
  return instantFor(y, mo, d, wall.hour, wall.minute, wall.second, zone);
}

function instantFor(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: Zone): number {
  switch (zone.kind) {
    case 'utc':
      return Date.UTC(y, mo - 1, d, h, mi, s);
    case 'date':
    case 'floating':
      return new Date(y, mo - 1, d, h, mi, s).getTime();
    case 'zoned': {
      const formatter = formatterFor(zone.tzid);
      const wall = Date.UTC(y, mo - 1, d, h, mi, s);
      if (!formatter) return wall;
      const first = wall - zoneOffsetMs(formatter, wall);
      return wall - zoneOffsetMs(formatter, first);
    }
  }
}

/** The zone's offset from UTC at an instant, in milliseconds, read from Intl. */
function zoneOffsetMs(formatter: Intl.DateTimeFormat, instant: number): number {
  const parts = formatter.formatToParts(new Date(instant));
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const wallAsUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
  return wallAsUtc - Math.floor(instant / 1000) * 1000;
}

/** An Intl formatter for a zone name, or null when Intl does not know the name. */
function formatterFor(tzid: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(tzid);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    formatter = null;
  }
  if (formatters.size >= MAX_CACHED_ZONES) formatters.clear();
  formatters.set(tzid, formatter);
  return formatter;
}

function dayNumber(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function civil(day: number): { y: number; mo: number; d: number } {
  const date = new Date(day * DAY_MS);
  return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** Monday is 0 and Sunday is 6. Day 0 was a Thursday. */
function mondayIndex(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

/** The number of days in a month. The month is 1-based. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
