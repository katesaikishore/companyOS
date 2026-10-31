import type { RawSignal } from '../src';

/** Local time, so day boundaries match what the person sees. October 2026. */
export function at(dayIndex: number, hour: number, minute = 0): number {
  return new Date(2026, 9, 1 + dayIndex, hour, minute).getTime();
}

export const SECRET_QUERY = 'SECRET123456';

/**
 * One working day: spreadsheet, then mail, then chat, then the browser, then an idle break.
 * Also includes an excluded password manager and an app the twin should ignore.
 */
export function workday(dayIndex: number): RawSignal[] {
  const sheet = dayIndex % 5 === 0 ? 'LibreOffice Calc' : 'Microsoft Excel';
  return [
    { kind: 'focus', ts: at(dayIndex, 9), app: sheet },
    { kind: 'focus', ts: at(dayIndex, 9, 20), app: 'Microsoft Outlook' },
    { kind: 'focus', ts: at(dayIndex, 9, 30), app: 'Slack' },
    { kind: 'focus', ts: at(dayIndex, 9, 40), app: '1Password' },
    { kind: 'focus', ts: at(dayIndex, 9, 45), app: `Random App ${dayIndex}` },
    {
      kind: 'focus',
      ts: at(dayIndex, 10),
      app: 'Google Chrome',
      url: `https://docs.example.com/doc/1ab2cd3ef4567890/edit?token=${SECRET_QUERY}#top`,
    },
    { kind: 'idle_start', ts: at(dayIndex, 10, 10) },
    { kind: 'idle_end', ts: at(dayIndex, 13) },
  ];
}

export function workdays(count: number): RawSignal[] {
  return Array.from({ length: count }, (_, day) => workday(day)).flat();
}

/**
 * Two browser sequences in one day. In the morning Chrome visits mail, then a sheet, with no other app between them.
 * In the afternoon Chrome visits an issue tracker, then the same sheet. Each sequence is a spreadsheet, two browser
 * visits, then chat. The sheet URL carries a query string, so the fixture also checks that it never reaches a key.
 */
export function siteWorkday(dayIndex: number): RawSignal[] {
  return [
    { kind: 'focus', ts: at(dayIndex, 9), app: 'Microsoft Excel' },
    { kind: 'focus', ts: at(dayIndex, 9, 10), app: 'Google Chrome', url: 'https://mail.google.com/mail/u/0/#inbox' },
    {
      kind: 'focus',
      ts: at(dayIndex, 9, 20),
      app: 'Google Chrome',
      url: `https://docs.google.com/spreadsheets/d/1ab2cd3ef4567890?token=${SECRET_QUERY}`,
    },
    { kind: 'focus', ts: at(dayIndex, 9, 30), app: 'Slack' },
    { kind: 'idle_start', ts: at(dayIndex, 9, 40) },
    { kind: 'focus', ts: at(dayIndex, 14), app: 'Microsoft Excel' },
    { kind: 'focus', ts: at(dayIndex, 14, 10), app: 'Google Chrome', url: 'https://jira.example.com/browse/ABC-123' },
    {
      kind: 'focus',
      ts: at(dayIndex, 14, 20),
      app: 'Google Chrome',
      url: 'https://docs.google.com/spreadsheets/d/9zz8yy7xx',
    },
    { kind: 'focus', ts: at(dayIndex, 14, 30), app: 'Slack' },
    { kind: 'idle_start', ts: at(dayIndex, 14, 40) },
  ];
}

export function siteWorkdays(count: number): RawSignal[] {
  return Array.from({ length: count }, (_, day) => siteWorkday(day)).flat();
}
