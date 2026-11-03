import { describe, expect, it } from 'vitest';
import { weekAhead, type CapturedText } from '../src/week/ahead';

// Monday 2 November 2026, in local time: "Mon" is today, "Tue" is tomorrow.
const NOW = new Date(2026, 10, 2, 9, 0);
const capture = (id: number, text: string, app = 'Mail'): CapturedText => ({ id, ts: 1000 + id, app, text });

// The text of the week-ahead demo frames, as OCR would read it.
const WEEK_TABLE = capture(
  1,
  [
    'Your Week Ahead',
    'You have 3 deadlines this week.',
    'Two are already behind schedule.',
    'Mon Q3 review prep + team sync',
    'Tue Client presentation. Final draft due.',
    'Wed Leadership meeting. Come with numbers.',
    'Thu Follow ups + approvals needed',
    'Fri Report out. Clear the inbox.',
    'Sarah is waiting on your sign off.',
    'She asked twice. The Acme proposal needs one more revision.',
  ].join('\n'),
  'Notes',
);

describe('weekAhead', () => {
  it('places the week table on the right days and keeps the requests that have no date', () => {
    const items = weekAhead([WEEK_TABLE], NOW);
    const dated = items.filter(item => item.day !== null).map(item => [item.day, item.kind, item.text]);
    expect(dated).toEqual([
      ['2026-11-02', 'meeting', 'Mon Q3 review prep + team sync'],
      ['2026-11-03', 'meeting', 'Tue Client presentation.'],
      ['2026-11-03', 'deadline', 'Final draft due.'],
      ['2026-11-04', 'meeting', 'Wed Leadership meeting.'],
      ['2026-11-05', 'request', 'Thu Follow ups + approvals needed'],
    ]);
    const undated = items.filter(item => item.day === null).map(item => item.text);
    expect(undated).toEqual(['Sarah is waiting on your sign off.', 'She asked twice.']);
  });

  it('reads today, tomorrow and a named weekday that follows "on" or "due"', () => {
    const items = weekAhead(
      [capture(2, 'Send the draft due today. Sam meeting tomorrow. Final report due Friday.')],
      NOW,
    );
    expect(items.map(item => [item.day, item.kind, item.text])).toEqual([
      ['2026-11-02', 'deadline', 'Send the draft due today.'],
      ['2026-11-03', 'meeting', 'Sam meeting tomorrow.'],
      ['2026-11-06', 'deadline', 'Final report due Friday.'],
    ]);
  });

  it('does not read the word "sat" as a day', () => {
    expect(weekAhead([capture(3, 'Ideas sat in the inbox. Team meeting at noon.')], NOW)).toEqual([]);
  });

  it('reads a request addressed to the person, with no date needed', () => {
    const items = weekAhead([capture(4, 'Jordan: Just assigned you new tasks. Please check PM tool.', 'Slack')], NOW);
    expect(items).toMatchObject([{ kind: 'request', day: null, app: 'Slack' }]);
  });

  it('drops a repeat on the same day and cuts a long sentence', () => {
    const long = `Due Friday ${'x'.repeat(300)}`;
    const items = weekAhead([capture(5, `${long}\nDue Friday\nDue Friday`)], NOW);
    expect(items).toHaveLength(2);
    expect(items[0].text.length).toBeLessThanOrEqual(160);
    expect(items[0].text.endsWith('…')).toBe(true);
  });

  it('keeps the source of each item so it can be checked', () => {
    const items = weekAhead([WEEK_TABLE], NOW);
    expect(items.every(item => item.sourceId === 1 && item.app === 'Notes')).toBe(true);
  });
});
