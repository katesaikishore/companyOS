import { describe, expect, it } from 'vitest';
import { ICS_MAX_OCCURRENCES, parseIcs, type IcsWindow } from '../../src/connectors/ics';

const ALL: IcsWindow = { from: Date.UTC(2000, 0, 1), to: Date.UTC(2100, 0, 1) };

/** One VEVENT with the given property lines. */
function vevent(lines: string[]): string[] {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

/** A whole calendar, with CRLF line endings as RFC 5545 requires. */
function ics(...blocks: string[][]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//companyOS test//EN', ...blocks.flat(), 'END:VCALENDAR'].join('\r\n');
}

describe('parseIcs: reading lines', () => {
  it('joins folded lines: a CRLF followed by a space or a tab continues the line', () => {
    const text = ics(
      vevent([
        'UID:fold-1',
        'DTSTART:20260302T090000Z',
        'SUMMARY:Plan',
        ' ning review',
        'DESCRIPTION:one',
        '\ttwo',
      ]),
    );
    const [item] = parseIcs(text, ALL);
    expect(item?.title).toBe('Planning review');
    expect(item?.text).toBe('onetwo');
  });

  it('reads the text escapes \\n, \\, \\; and \\\\', () => {
    const text = ics(
      vevent([
        'UID:esc-1',
        'DTSTART:20260302T090000Z',
        'SUMMARY:Escapes\\, \\; and \\\\',
        'DESCRIPTION:Line one\\nLine two\\, with a comma\\; and a semicolon\\\\ and a backslash',
      ]),
    );
    const [item] = parseIcs(text, ALL);
    expect(item?.title).toBe('Escapes, ; and \\');
    expect(item?.text).toBe('Line one\nLine two, with a comma; and a semicolon\\ and a backslash');
  });

  it('reads the event location', () => {
    const text = ics(
      vevent(['UID:loc-1', 'DTSTART:20260302T090000Z', 'SUMMARY:Lunch', 'LOCATION:Room 4\\, level 2']),
    );
    expect(parseIcs(text, ALL)[0]?.location).toBe('Room 4, level 2');
  });

  it('does not take the description of a VALARM as the event description', () => {
    const text = ics(
      vevent([
        'UID:alarm-1',
        'DTSTART:20260302T090000Z',
        'SUMMARY:Call',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:Reminder text',
        'TRIGGER:-PT10M',
        'END:VALARM',
        'DESCRIPTION:The real notes',
      ]),
    );
    expect(parseIcs(text, ALL)[0]?.text).toBe('The real notes');
  });
});

describe('parseIcs: times', () => {
  it('converts TZID times with Intl, in summer and in winter, quoted or not', () => {
    const text = ics(
      vevent(['UID:tz-1', 'DTSTART;TZID=Europe/London:20260705T090000', 'SUMMARY:Summer London']),
      vevent(['UID:tz-2', 'DTSTART;TZID=America/New_York:20260105T090000', 'SUMMARY:Winter New York']),
      vevent(['UID:tz-3', 'DTSTART;TZID="Europe/Paris":20260105T090000', 'SUMMARY:Quoted Paris']),
    );
    const items = parseIcs(text, ALL);
    expect(items.map((item) => [item.title, item.ts])).toEqual([
      ['Quoted Paris', Date.UTC(2026, 0, 5, 8)],
      ['Winter New York', Date.UTC(2026, 0, 5, 14)],
      ['Summer London', Date.UTC(2026, 6, 5, 8)],
    ]);
  });

  it('reads a zone that Intl does not know as UTC, and says so in the item text', () => {
    const [item] = parseIcs(
      ics(vevent(['UID:x-1', 'DTSTART;TZID=Mars/Olympus_Base:20260305T090000', 'SUMMARY:Ares'])),
      ALL,
    );
    expect(item?.ts).toBe(Date.UTC(2026, 2, 5, 9));
    expect(item?.text).toContain('not known');
    expect(item?.text).toContain('read as UTC');
  });

  it('reads UTC values, floating values and all-day dates', () => {
    const text = ics(
      vevent(['UID:u-1', 'DTSTART:20260305T090000Z', 'SUMMARY:Utc']),
      vevent(['UID:f-1', 'DTSTART:20260306T090000', 'SUMMARY:Floating']),
      vevent(['UID:a-1', 'DTSTART;VALUE=DATE:20260307', 'SUMMARY:All day', 'DESCRIPTION:Holiday']),
    );
    const items = parseIcs(text, ALL);
    // Floating and all-day values are this machine's local time, so the expected values use the local constructor.
    expect(items.map((item) => item.ts)).toEqual([
      Date.UTC(2026, 2, 5, 9),
      new Date(2026, 2, 6, 9).getTime(),
      new Date(2026, 2, 7).getTime(),
    ]);
    expect(items[2]?.text).toBe('All-day event.\n\nHoliday');
  });
});

describe('parseIcs: recurrence', () => {
  it('expands a weekly rule with COUNT, and gives every occurrence a stable, hashed sourceId', () => {
    const text = ics(
      vevent(['UID:weekly-1', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Standup']),
    );
    const items = parseIcs(text, ALL);
    expect(items.map((item) => item.ts)).toEqual([
      Date.UTC(2026, 2, 2, 9),
      Date.UTC(2026, 2, 9, 9),
      Date.UTC(2026, 2, 16, 9),
    ]);
    expect(new Set(items.map((item) => item.sourceId)).size).toBe(3);
    for (const item of items) {
      expect(item.sourceId).toMatch(/^[0-9a-f]{32}$/);
      expect(item.sourceId).not.toContain('weekly-1');
    }
    // Reading the same text again gives the same ids, so a second import does not duplicate.
    expect(parseIcs(text, ALL).map((item) => item.sourceId)).toEqual(items.map((item) => item.sourceId));
  });

  it('expands DAILY with INTERVAL, and UNTIL is inclusive', () => {
    const text = ics(
      vevent(['UID:daily-1', 'DTSTART:20260301T090000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20260307T090000Z']),
    );
    expect(parseIcs(text, ALL).map((item) => item.ts)).toEqual([
      Date.UTC(2026, 2, 1, 9),
      Date.UTC(2026, 2, 3, 9),
      Date.UTC(2026, 2, 5, 9),
      Date.UTC(2026, 2, 7, 9),
    ]);
  });

  it('expands WEEKLY with BYDAY, and DTSTART counts as the first occurrence', () => {
    const text = ics(
      vevent(['UID:byday-1', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4', 'SUMMARY:Gym']),
    );
    expect(parseIcs(text, ALL).map((item) => item.ts)).toEqual([
      Date.UTC(2026, 2, 2, 9),
      Date.UTC(2026, 2, 4, 9),
      Date.UTC(2026, 2, 6, 9),
      Date.UTC(2026, 2, 9, 9),
    ]);
  });

  it('expands MONTHLY, and skips a month that has no such day', () => {
    const text = ics(vevent(['UID:month-1', 'DTSTART:20260131T090000Z', 'RRULE:FREQ=MONTHLY;COUNT=3']));
    expect(parseIcs(text, ALL).map((item) => item.ts)).toEqual([
      Date.UTC(2026, 0, 31, 9),
      Date.UTC(2026, 2, 31, 9),
      Date.UTC(2026, 4, 31, 9),
    ]);
  });

  it('skips EXDATE occurrences, and COUNT still counts them', () => {
    const text = ics(
      vevent([
        'UID:ex-1',
        'DTSTART:20260302T090000Z',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'EXDATE:20260309T090000Z',
        'SUMMARY:Week off',
      ]),
    );
    expect(parseIcs(text, ALL).map((item) => item.ts)).toEqual([Date.UTC(2026, 2, 2, 9), Date.UTC(2026, 2, 16, 9)]);
  });

  it('bounds the expansion to 500 occurrences per event, and says so in the text', () => {
    const text = ics(vevent(['UID:many-1', 'DTSTART:20260101T090000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Every day']));
    const items = parseIcs(text, { from: Date.UTC(2026, 0, 1), to: Date.UTC(2030, 0, 1) });
    expect(ICS_MAX_OCCURRENCES).toBe(500);
    expect(items).toHaveLength(500);
    expect(items.every((item) => item.text.includes('Only the first 500 occurrences'))).toBe(true);
  });

  it('does not expand a rule outside the supported subset, and says so in the text', () => {
    const text = ics(vevent(['UID:year-1', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=YEARLY;COUNT=5', 'SUMMARY:Anniversary']));
    const items = parseIcs(text, ALL);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toContain('not expanded');
  });

  it('lets a RECURRENCE-ID override replace its occurrence in the series', () => {
    const text = ics(
      vevent(['UID:series-1', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Series']),
      vevent(['UID:series-1', 'RECURRENCE-ID:20260303T090000Z', 'DTSTART:20260303T150000Z', 'SUMMARY:Moved']),
    );
    const items = parseIcs(text, ALL);
    expect(items.map((item) => [item.title, item.ts])).toEqual([
      ['Series', Date.UTC(2026, 2, 2, 9)],
      ['Moved', Date.UTC(2026, 2, 3, 15)],
      ['Series', Date.UTC(2026, 2, 4, 9)],
    ]);
  });
});

describe('parseIcs: the window and malformed input', () => {
  it('keeps only occurrences that start in the window: from inclusive, to exclusive', () => {
    const start = Date.UTC(2026, 2, 2, 9);
    const text = ics(vevent(['UID:win-1', 'DTSTART:20260302T090000Z', 'SUMMARY:One']));
    expect(parseIcs(text, { from: start, to: start + 1 })).toHaveLength(1);
    expect(parseIcs(text, { from: start - 1, to: start })).toHaveLength(0);
    expect(parseIcs(text, { from: Date.UTC(2025, 0, 1), to: Date.UTC(2025, 11, 31) })).toHaveLength(0);
  });

  it('excludes events outside the window, including the ones of a recurring series', () => {
    const text = ics(
      vevent(['UID:old-1', 'DTSTART:20250101T090000Z', 'SUMMARY:Last year']),
      vevent(['UID:series-2', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Series']),
    );
    const items = parseIcs(text, { from: Date.UTC(2026, 2, 9), to: Date.UTC(2026, 2, 10) });
    expect(items.map((item) => item.ts)).toEqual([Date.UTC(2026, 2, 9, 9)]);
  });

  it('skips a malformed event, and an event that is never closed, and returns the others', () => {
    const text = ics(
      vevent(['UID:ok-1', 'DTSTART:20260302T090000Z', 'SUMMARY:First']),
      vevent(['UID:bad-1', 'DTSTART:not-a-date', 'SUMMARY:Broken start']),
      vevent(['UID:bad-2', 'DTSTART:20260302T090000Z', 'RECURRENCE-ID:nonsense', 'SUMMARY:Broken override']),
      vevent(['UID:ok-2', 'DTSTART:20260303T090000Z', 'SUMMARY:Third']),
      ['BEGIN:VEVENT', 'UID:open-1', 'DTSTART:20260304T090000Z', 'SUMMARY:Never closed'],
    );
    expect(parseIcs(text, ALL).map((item) => item.title)).toEqual(['First', 'Third']);
  });

  it('returns nothing for an empty window or a text with no events', () => {
    expect(parseIcs(ics(vevent(['UID:e', 'DTSTART:20260302T090000Z'])), { from: 5, to: 5 })).toEqual([]);
    expect(parseIcs('', ALL)).toEqual([]);
  });
});
