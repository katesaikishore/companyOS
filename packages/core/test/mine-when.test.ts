import { describe, expect, it } from 'vitest';
import {
  describeWhen,
  mineRoutines,
  normalizeSignal,
  segment,
  type RawSignal,
  type Routine,
  type RoutineWhen,
  type TwinEvent,
} from '../src';
import { at } from './fixtures';

const GAP = 60 * 60_000;

/** A day index, an hour and optionally a minute. Day 0 is 1 October 2026, a Thursday. */
type Start = readonly [day: number, hour: number, minute?: number];

/**
 * One stretch of work for each start: a spreadsheet, then mail, then chat, then idle. Each stretch begins at its start,
 * so one routine can begin at different times on different days.
 */
function stretches(starts: readonly Start[]): RawSignal[] {
  return starts.flatMap(([day, hour, minute = 0]): RawSignal[] => [
    { kind: 'focus', ts: at(day, hour, minute), app: 'Microsoft Excel' },
    { kind: 'focus', ts: at(day, hour, minute + 20), app: 'Microsoft Outlook' },
    { kind: 'focus', ts: at(day, hour, minute + 30), app: 'Slack' },
    { kind: 'idle_start', ts: at(day, hour, minute + 40) },
  ]);
}

/** The three-step routine mined from the stretches. */
function routineFrom(starts: readonly Start[]): Routine {
  const events = stretches(starts)
    .map((signal, index) => normalizeSignal(signal, { excludedApps: [], watchBrowsers: true, newId: () => `e${index}` }))
    .filter((event): event is TwinEvent => event !== null);
  const routine = mineRoutines(segment(events, GAP)).find(candidate => candidate.steps.length === 3);
  if (!routine) throw new Error('The stretches should mine a three-step routine.');
  return routine;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('Routine.when', () => {
  it('counts each occurrence on its weekday, Monday first, and the counts add up to the support', () => {
    // Days 4, 11 and 18 are Mondays (5, 12 and 19 October 2026). Days 6, 13 and 20 are Wednesdays.
    const routine = routineFrom([
      [4, 9],
      [6, 9],
      [11, 9],
      [13, 9],
      [18, 9],
      [20, 9],
    ]);

    expect(routine.when.weekdays).toEqual([3, 0, 3, 0, 0, 0, 0]);
    expect(sum(routine.when.weekdays)).toBe(routine.support);
  });

  it('puts a Sunday last in the week', () => {
    // Days 3, 10 and 17 are Sundays (4, 11 and 18 October 2026).
    expect(routineFrom([[3, 9], [10, 9], [17, 9]]).when.weekdays).toEqual([0, 0, 0, 0, 0, 0, 3]);
  });

  it('takes the hour an occurrence began, not the hour it ended', () => {
    // Each stretch begins at 9:55 and runs past ten, so its start hour is 9.
    const routine = routineFrom([[0, 9, 55], [1, 9, 55], [2, 9, 55]]);

    expect(routine.when).toMatchObject({ fromHour: 9, toHour: 10 });
  });

  it('covers the 10th to the 90th percentile of the start hour, so one late outlier does not widen it', () => {
    const hours = [9, 9, 9, 10, 10, 10, 10, 11, 11, 15];
    const routine = routineFrom(hours.map((hour, day) => [day, hour] as const));

    // The 10th percentile is 9 and the 90th is 11, so the range runs from 9 up to, and including, 11: toHour is 12.
    expect(routine.when).toEqual({ weekdays: [1, 1, 1, 2, 2, 2, 1], fromHour: 9, toHour: 12 });
  });

  it('gives the same summary every time for the same timestamps', () => {
    const starts: Start[] = [
      [0, 9],
      [1, 10],
      [2, 9],
    ];

    expect(routineFrom(starts).when).toEqual(routineFrom(starts).when);
  });
});

describe('describeWhen', () => {
  const summary = (weekdays: number[], fromHour: number, toHour: number): RoutineWhen => ({ weekdays, fromHour, toHour });

  it.each<[string, RoutineWhen, string]>([
    [
      'weekdays only, in a clear band',
      summary([2, 2, 2, 2, 2, 0, 0], 9, 11),
      'Usually weekday mornings, around 9 to 11 am',
    ],
    [
      'weekends only, in a band that reaches noon',
      summary([0, 0, 0, 0, 0, 3, 3], 10, 12),
      'Usually weekend mornings, around 10 am to noon',
    ],
    [
      'two named days, too wide for exact hours',
      summary([4, 0, 3, 0, 0, 0, 0], 13, 17),
      'Mostly Mondays and Wednesdays, in the afternoon',
    ],
    [
      'three named days, in a clear band',
      summary([3, 0, 3, 0, 3, 0, 0], 9, 11),
      'Mostly Mondays, Wednesdays and Fridays, around 9 to 11 am',
    ],
    ['a single named day', summary([5, 0, 0, 0, 0, 0, 0], 9, 11), 'Mostly Mondays, around 9 to 11 am'],
    [
      'mixed days, spread across the week',
      summary([1, 1, 1, 1, 1, 1, 1], 9, 10),
      'Spread across the week, around 9 to 10 am',
    ],
    [
      'weekdays in a clear afternoon band',
      summary([2, 2, 2, 2, 2, 0, 0], 14, 17),
      'Usually weekday afternoons, around 2 to 5 pm',
    ],
    [
      'weekdays in a band too wide for exact hours',
      summary([2, 2, 2, 2, 2, 0, 0], 9, 13),
      'Usually weekday mornings',
    ],
    [
      'weekdays with hours spread too wide to name',
      summary([2, 2, 2, 2, 2, 0, 0], 8, 18),
      'Usually weekdays',
    ],
    [
      'weekdays late at night, across midnight',
      summary([2, 2, 2, 2, 2, 0, 0], 22, 24),
      'Usually weekday nights, around 10 pm to midnight',
    ],
    [
      'one named day in the small hours',
      summary([0, 0, 0, 0, 0, 0, 4], 0, 3),
      'Mostly Sundays, around midnight to 3 am',
    ],
  ])('%s', (_, input, text) => {
    expect(describeWhen(input)).toBe(text);
  });

  it('says so when no occurrence is recorded', () => {
    expect(describeWhen(summary([0, 0, 0, 0, 0, 0, 0], 9, 11))).toBe('No usual time yet.');
  });
});
