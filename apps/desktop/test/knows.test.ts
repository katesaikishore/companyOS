import { describe, expect, it } from 'vitest';
import type { DeclinedRoutineView, RoutineStepView, RoutineView } from '@companyos/twin-core';
import {
  COPY,
  KIND_NAMES,
  clockOf,
  declinedKindLabel,
  declinedMeta,
  notEnoughLine,
  routineStatusLabel,
  sessionLine,
  stepLabel,
  stretchLine,
  tasksLine,
  usualAppLine,
  usualHoursLine,
  weekdayName,
} from '../src/renderer/knows-model';

const NOW = new Date(2026, 9, 31, 12).getTime();

describe('clockOf and usualHoursLine', () => {
  it('writes an hour with a fraction as a clock time', () => {
    expect(clockOf(9)).toBe('09:00');
    expect(clockOf(9.5)).toBe('09:30');
    expect(clockOf(17.25)).toBe('17:15');
    expect(clockOf(23.5)).toBe('23:30');
  });

  it('names the usual hours of a weekday once enough days are seen', () => {
    expect(usualHoursLine({ weekday: 0, days: 4, enoughData: true, startHour: 9, endHour: 17.5 })).toBe('09:00 to 17:30');
  });

  it('names no hour until enough days are seen', () => {
    expect(usualHoursLine({ weekday: 5, days: 1, enoughData: false, startHour: null, endHour: null })).toBe('Not enough days yet');
  });

  it('names weekdays Monday first', () => {
    expect(weekdayName(0)).toBe('Mon');
    expect(weekdayName(6)).toBe('Sun');
  });
});

describe('sessionLine, stretchLine and usualAppLine', () => {
  it('give the median session, or say there is not enough yet', () => {
    expect(sessionLine({ segments: 12, medianMinutes: 45 })).toBe('About 45 min, over 12 sessions');
    expect(sessionLine({ segments: 2, medianMinutes: null })).toBe('Not enough sessions yet');
    expect(sessionLine({ segments: 1, medianMinutes: 0.4 })).toBe('Under a minute, over 1 session');
  });

  it('give the median stretch before switching, or say there is not enough yet', () => {
    expect(stretchLine({ windowClass: 'editor', stretches: 9, medianMinutes: 12.4 })).toBe('About 12 min');
    expect(stretchLine({ windowClass: 'editor', stretches: 1, medianMinutes: null })).toBe('Not enough yet');
  });

  it('names the app a kind of work uses most, in title case, with its share', () => {
    expect(usualAppLine({ windowClass: 'spreadsheet', switches: 20, app: 'microsoft excel', sharePct: 80 })).toBe(
      'Microsoft Excel, 80% of switches',
    );
  });

  it('names every kind of work in plain words', () => {
    expect(KIND_NAMES.spreadsheet).toBe('Spreadsheets');
    expect(Object.values(KIND_NAMES)).toHaveLength(9);
  });
});

describe('notEnoughLine', () => {
  it('says how many days were seen and how many are needed, and names no habit', () => {
    expect(notEnoughLine({ observedDays: 2, requiredDays: 5 })).toBe(
      'The twin has seen 2 days. It needs 5 days before it describes how you work.',
    );
    expect(notEnoughLine({ observedDays: 1, requiredDays: 5 })).toBe(
      'The twin has seen 1 day. It needs 5 days before it describes how you work.',
    );
  });
});

describe('stepLabel and routineStatusLabel', () => {
  it('names a browser step by its site', () => {
    const step: RoutineStepView = { app: 'google chrome', site: 'docs.example.com/doc', alternatives: 0 };
    expect(stepLabel(step)).toBe('Google Chrome · docs.example.com/doc');
  });

  it('says how many other apps a step can be', () => {
    expect(stepLabel({ app: 'microsoft excel', alternatives: 1 })).toBe('Microsoft Excel or 1 other app');
    expect(stepLabel({ app: 'slack', alternatives: 2 })).toBe('Slack or 2 other apps');
  });

  it('shows a suggestion as waiting, and an accepted routine at its level', () => {
    const suggested: RoutineView = { routineId: 'a1b2c3d4e5f6', name: 'Sheet', status: 'suggested', steps: [] };
    const accepted: RoutineView = {
      routineId: 'b1b2c3d4e5f6',
      name: 'Invoice',
      status: 'accepted',
      steps: [],
      automationId: 'auto_b1b2c3d4e5f6',
      level: 2,
    };
    expect(routineStatusLabel(suggested)).toBe('Suggested');
    expect(routineStatusLabel(accepted)).toBe('Automation · L2 · Draft');
  });
});

describe('declined routines', () => {
  it('names a dismissal and an offer that was declined', () => {
    expect(declinedKindLabel({ routineId: 'a', dismissed: true, declines: 1 })).toBe('Not a routine');
    expect(declinedKindLabel({ routineId: 'a', dismissed: false, declines: 1 })).toBe('Not now');
  });

  it('gives the count in a row, and when the latest answer was', () => {
    const at = new Date(2026, 9, 30, 17, 0).getTime();
    const threeInARow: DeclinedRoutineView = { routineId: 'a', dismissed: false, declines: 3, at };
    expect(declinedMeta(threeInARow, NOW)).toBe('Said no 3 times in a row · Yesterday 17:00');
    expect(declinedMeta({ routineId: 'a', dismissed: true, declines: 1, at: NOW - 60_000 }, NOW)).toBe('Said no once · Today 11:59');
  });

  it('is empty for a dismissal kept by an earlier version, which has no count or time', () => {
    expect(declinedMeta({ routineId: 'a', dismissed: true, declines: 0 }, NOW)).toBe('');
  });
});

describe('tasksLine', () => {
  it('says there is nothing to review, or counts the tasks and the ones still to confirm', () => {
    expect(tasksLine([])).toBe('Nothing to review yet.');
    expect(tasksLine([{ confirmed: true }, { confirmed: false }, { confirmed: false }])).toBe('3 tasks today · 2 tasks to confirm');
    expect(tasksLine([{ confirmed: true }])).toBe('1 task today · All confirmed');
  });
});

describe('the wording of the page', () => {
  // Mood, focus, stress, productivity, engagement, idle time and scores are never described, and the copy uses no gendered pronoun.
  const BANNED =
    /\b(focus\w*|mood\w*|stress\w*|productiv\w*|distract\w*|engag\w*|scor\w*|idle\w*|good|bad|efficien\w*|happy|tired|calm\w*|confiden\w*|he|she|his|her|hers|him|himself|herself)\b/i;

  it('uses no mood, focus or score words, and no gendered pronouns, in any fixed or generated line', () => {
    const generated = [
      usualHoursLine({ weekday: 0, days: 4, enoughData: true, startHour: 9, endHour: 17 }),
      sessionLine({ segments: 12, medianMinutes: 45 }),
      stretchLine({ windowClass: 'editor', stretches: 9, medianMinutes: 12 }),
      usualAppLine({ windowClass: 'spreadsheet', switches: 20, app: 'microsoft excel', sharePct: 80 }),
      notEnoughLine({ observedDays: 2, requiredDays: 5 }),
      stepLabel({ app: 'google chrome', site: 'docs.example.com/doc', alternatives: 1 }),
      declinedMeta({ routineId: 'a', dismissed: false, declines: 2, at: NOW }, NOW),
      tasksLine([{ confirmed: false }]),
    ];
    for (const text of [...Object.values(COPY), ...Object.values(KIND_NAMES), ...generated]) {
      expect(text).not.toMatch(BANNED);
    }
  });

  it('carries the privacy line at the top of the page', () => {
    expect(COPY.note).toBe('Everything here stays on this device, encrypted. Delete everything in Settings removes it.');
  });
});
