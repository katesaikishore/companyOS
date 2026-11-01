import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  TASK_GAP_MS,
  classifyApp,
  dayKeyOf,
  decisionFits,
  parseTaskDecision,
  tasksForDay,
  type DayTasksView,
  type TaskDecision,
  type TwinEvent,
} from '../src';
import { at } from './fixtures';

const DAY = dayKeyOf(at(0, 12));
const NEXT_DAY = dayKeyOf(at(1, 12));
const MINUTE = 60_000;

let sequence = 0;

/** A focus event as the store holds it: a lower-case app name and its window class. */
function focus(ts: number, app: string): TwinEvent {
  sequence += 1;
  return { id: `t${sequence}`, ts, kind: 'focus', app, windowClass: classifyApp(app) };
}

function idle(ts: number): TwinEvent {
  sequence += 1;
  return { id: `t${sequence}`, ts, kind: 'idle_start' };
}

function view(events: readonly TwinEvent[], decisions: readonly TaskDecision[] = [], day = DAY): DayTasksView {
  return tasksForDay(events, decisions, day, DEFAULT_CONFIG.idleGapMs);
}

/** A decision as the page sends it, checked by the same parser the engine uses. */
function decide(input: Record<string, unknown>, day = DAY): TaskDecision {
  return parseTaskDecision({ day, ...input });
}

/**
 * Three tasks on one day: Excel, then Slack after a short break, then Chrome after an hour away. Each one is a separate
 * task because the apps share nothing, and the breaks differ, so the decision tests can merge and split them.
 */
function threeTasks(): TwinEvent[] {
  return [
    focus(at(0, 9), 'microsoft excel'),
    focus(at(0, 9, 10), 'microsoft excel'),
    idle(at(0, 9, 12)),
    focus(at(0, 9, 20), 'slack'),
    focus(at(0, 9, 30), 'slack'),
    idle(at(0, 9, 35)),
    focus(at(0, 10, 30), 'google chrome'),
  ];
}

describe('grouping a day into tasks', () => {
  it('makes a run in one app one task, named after that app', () => {
    const result = view([focus(at(0, 9), 'microsoft excel'), focus(at(0, 9, 5), 'microsoft excel'), focus(at(0, 9, 20), 'microsoft excel')]);

    expect(result.day).toBe(DAY);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      name: 'Microsoft Excel',
      renamed: false,
      apps: ['microsoft excel'],
      startTs: at(0, 9),
      endTs: at(0, 9, 20),
      confirmed: false,
    });
    expect(result.tasks[0].segments).toHaveLength(1);
  });

  it('keeps one task across a short break in the same app', () => {
    const result = view([focus(at(0, 9), 'microsoft excel'), idle(at(0, 9, 5)), focus(at(0, 9, 12), 'microsoft excel')]);

    expect(TASK_GAP_MS).toBe(30 * MINUTE);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].segments).toHaveLength(2);
    expect(result.tasks[0].name).toBe('Microsoft Excel');
  });

  it('keeps tasks together when the break is exactly 30 minutes', () => {
    // The break runs from the idle start at 09:05 to the focus at 09:35: exactly 30 minutes.
    const result = view([focus(at(0, 9), 'microsoft excel'), idle(at(0, 9, 5)), focus(at(0, 9, 35), 'microsoft excel')]);

    expect(result.tasks).toHaveLength(1);
  });

  it('splits tasks when the break is more than 30 minutes', () => {
    // The break runs from the idle start at 09:05 to the focus at 09:36: 31 minutes.
    const result = view([focus(at(0, 9), 'microsoft excel'), idle(at(0, 9, 5)), focus(at(0, 9, 36), 'microsoft excel')]);

    expect(result.tasks.map(task => task.startTs)).toEqual([at(0, 9), at(0, 9, 36)]);
  });

  it('measures a break from the idle start, not from the start of the stretch before it', () => {
    // Idle starts at 09:05, five minutes into the stretch. The break is 26 minutes, so the task is kept whole.
    const result = view([focus(at(0, 9), 'microsoft excel'), idle(at(0, 9, 5)), focus(at(0, 9, 31), 'microsoft excel')]);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ startTs: at(0, 9), endTs: at(0, 9, 31) });
  });

  it('does not count a long stretch in one app as a break when no idle signal closes it', () => {
    // Word, then Excel from 09:00 to 11:05 with no idle event: the focus change at 11:05 starts the next segment, so the
    // break is nothing and the two stretches are one task.
    const result = view([focus(at(0, 8, 50), 'microsoft word'), focus(at(0, 9), 'microsoft excel'), focus(at(0, 11, 5), 'microsoft word')]);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ startTs: at(0, 8, 50), endTs: at(0, 11, 5) });
  });

  it('keeps one task across a 7-minute break after a stretch that switched between two apps', () => {
    // Word, then Excel, then idle at 09:45. Back at 09:50 in Word. The break runs from 09:45 to 09:52.
    const result = view([
      focus(at(0, 9), 'microsoft word'),
      focus(at(0, 9, 2), 'microsoft excel'),
      idle(at(0, 9, 45)),
      focus(at(0, 9, 52), 'microsoft word'),
    ]);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ name: 'Microsoft Word and Microsoft Excel', startTs: at(0, 9), endTs: at(0, 9, 52) });
  });

  it('ends the first task when its last stretch went idle, and starts the next task at its return', () => {
    // Excel for five minutes, idle, then Excel again after 36 minutes away: two tasks, the first ending at the idle start.
    const result = view([focus(at(0, 9), 'microsoft excel'), idle(at(0, 9, 5)), focus(at(0, 9, 41), 'microsoft excel')]);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({ startTs: at(0, 9), endTs: at(0, 9, 5) });
    expect(result.tasks[1]).toMatchObject({ startTs: at(0, 9, 41), endTs: at(0, 9, 41) });
  });

  it('splits tasks when the apps share less than half of each segment', () => {
    // Excel and Outlook, then Slack and Chrome: no app in common.
    const nothingShared = view([
      focus(at(0, 9), 'microsoft excel'),
      focus(at(0, 9, 5), 'microsoft outlook'),
      idle(at(0, 9, 10)),
      focus(at(0, 9, 15), 'slack'),
      focus(at(0, 9, 20), 'google chrome'),
    ]);
    expect(nothingShared.tasks).toHaveLength(2);

    // One app of two in each segment is half of each, so the two segments are one task.
    const halfOfEach = view([
      focus(at(0, 9), 'microsoft excel'),
      focus(at(0, 9, 5), 'microsoft outlook'),
      idle(at(0, 9, 10)),
      focus(at(0, 9, 15), 'microsoft excel'),
      focus(at(0, 9, 20), 'slack'),
    ]);
    expect(halfOfEach.tasks).toHaveLength(1);

    // One app shared, but the first segment has four: one of four is less than half, so they split.
    const oneOfFour = view([
      focus(at(0, 9), 'microsoft excel'),
      focus(at(0, 9, 3), 'microsoft outlook'),
      focus(at(0, 9, 6), 'slack'),
      focus(at(0, 9, 9), 'google chrome'),
      idle(at(0, 9, 12)),
      focus(at(0, 9, 15), 'microsoft excel'),
    ]);
    expect(oneOfFour.tasks).toHaveLength(2);
  });

  it('names a task by its two most used apps, most used first', () => {
    const result = view([
      focus(at(0, 9), 'microsoft excel'),
      focus(at(0, 9, 5), 'slack'),
      focus(at(0, 9, 10), 'microsoft excel'),
      focus(at(0, 9, 15), 'slack'),
      focus(at(0, 9, 20), 'microsoft excel'),
      focus(at(0, 9, 25), 'microsoft outlook'),
    ]);

    expect(result.tasks[0].name).toBe('Microsoft Excel and Slack');
    expect(result.tasks[0].apps).toEqual(['microsoft excel', 'slack', 'microsoft outlook']);
  });

  it('keeps each local day its own, so a break across midnight does not join two days', () => {
    const events = [focus(at(0, 23, 50), 'microsoft excel'), focus(at(1, 0, 10), 'microsoft excel')];

    expect(view(events, [], DAY).tasks.map(task => task.startTs)).toEqual([at(0, 23, 50)]);
    expect(view(events, [], NEXT_DAY).tasks.map(task => task.startTs)).toEqual([at(1, 0, 10)]);
  });

  it('gives the same tasks whatever order the events arrive in', () => {
    const events = threeTasks();

    expect(view([...events].reverse())).toEqual(view(events));
  });
});

describe('decisions applied in order', () => {
  it('confirms, renames, merges and leaves a stale decision out', () => {
    const events = threeTasks();
    const [first, second, third] = view(events).tasks;
    const decisions = [
      decide({ kind: 'confirm', taskId: first.id }),
      decide({ kind: 'rename', taskId: second.id, name: 'Team sync' }),
      decide({ kind: 'merge', taskId: second.id, nextTaskId: third.id }),
      // The third task was merged into the second, so this rename finds nothing and is skipped.
      decide({ kind: 'rename', taskId: third.id, name: 'Lunch' }),
    ];

    const result = view(events, decisions).tasks;

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: first.id, name: 'Microsoft Excel', renamed: false, confirmed: true });
    expect(result[1]).toMatchObject({
      id: second.id,
      name: 'Team sync',
      renamed: true,
      confirmed: true,
      startTs: at(0, 9, 20),
      endTs: at(0, 10, 30),
    });
    expect(result[1].segments).toHaveLength(2);
    expect(result[1].apps).toEqual(['slack', 'google chrome']);
  });

  it('splits a task at a later stretch, keeps the name with the earlier part, and confirms both', () => {
    const events = [
      focus(at(0, 9), 'microsoft excel'),
      focus(at(0, 9, 5), 'slack'),
      idle(at(0, 9, 10)),
      focus(at(0, 9, 20), 'microsoft excel'),
    ];
    const [whole] = view(events).tasks;
    expect(whole.name).toBe('Microsoft Excel and Slack');
    const later = whole.segments[1].id;

    const result = view(events, [decide({ kind: 'rename', taskId: whole.id, name: 'Budget' }), decide({ kind: 'split', taskId: whole.id, segmentId: later })]).tasks;

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: whole.id, name: 'Budget', renamed: true, confirmed: true });
    expect(result[0].segments).toHaveLength(1);
    expect(result[1]).toMatchObject({ id: later, name: 'Microsoft Excel', renamed: false, confirmed: true, startTs: at(0, 9, 20) });
  });

  it('puts back the rule-based name when a rename is cleared', () => {
    const events = threeTasks();
    const [first] = view(events).tasks;

    const renamed = view(events, [decide({ kind: 'rename', taskId: first.id, name: 'Budget' })]).tasks[0];
    const cleared = view(events, [decide({ kind: 'rename', taskId: first.id, name: 'Budget' }), decide({ kind: 'rename', taskId: first.id, name: '' })]).tasks[0];

    expect(renamed.name).toBe('Budget');
    expect(cleared).toMatchObject({ name: 'Microsoft Excel', renamed: false, confirmed: true });
  });

  it('ignores a decision made for another day', () => {
    const events = threeTasks();
    const [first] = view(events).tasks;

    const result = view(events, [decide({ kind: 'confirm', taskId: first.id }, NEXT_DAY)]).tasks;

    expect(result.every(task => !task.confirmed)).toBe(true);
  });

  it('accepts a decision that fits the tasks, and refuses one that does not', () => {
    const events = threeTasks();
    const [first, second, third] = view(events).tasks;

    expect(decisionFits(events, [], DEFAULT_CONFIG.idleGapMs, decide({ kind: 'confirm', taskId: first.id }))).toBe(true);
    expect(decisionFits(events, [], DEFAULT_CONFIG.idleGapMs, decide({ kind: 'confirm', taskId: 'nothere-9' }))).toBe(false);
    // Only the next task can be merged in, and a split cannot start at the first stretch.
    expect(decisionFits(events, [], DEFAULT_CONFIG.idleGapMs, decide({ kind: 'merge', taskId: first.id, nextTaskId: third.id }))).toBe(false);
    expect(decisionFits(events, [], DEFAULT_CONFIG.idleGapMs, decide({ kind: 'merge', taskId: first.id, nextTaskId: second.id }))).toBe(true);
    expect(decisionFits(events, [], DEFAULT_CONFIG.idleGapMs, decide({ kind: 'split', taskId: first.id, segmentId: first.id }))).toBe(false);
  });
});

describe('the shape of a decision', () => {
  it('refuses any field the page should not send, and does not echo the typed value', () => {
    expect(() => parseTaskDecision({ day: DAY, kind: 'confirm', taskId: 'abc-0' })).not.toThrow();

    let message = '';
    try {
      parseTaskDecision({ day: DAY, kind: 'confirm', taskId: 'abc-0', title: 'Quarterly plan' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('That task change is not valid.');
  });

  it('refuses a name over 60 characters and accepts an empty one', () => {
    expect(() => parseTaskDecision({ day: DAY, kind: 'rename', taskId: 'abc-0', name: 'x'.repeat(61) })).toThrow();
    expect(() => parseTaskDecision({ day: DAY, kind: 'rename', taskId: 'abc-0', name: '' })).not.toThrow();
  });

  it('refuses a day or a task id in the wrong form', () => {
    expect(() => parseTaskDecision({ day: '01/10/2026', kind: 'confirm', taskId: 'abc-0' })).toThrow();
    expect(() => parseTaskDecision({ day: DAY, kind: 'confirm', taskId: 'Microsoft Excel' })).toThrow();
    expect(() => parseTaskDecision({ day: DAY, kind: 'confirm', taskId: 'a>b-0' })).toThrow();
  });
});
