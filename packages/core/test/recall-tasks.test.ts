import { describe, expect, it } from 'vitest';
import type { Automation } from '../src/automation';
import { normalizeAppName } from '../src/classify';
import { assignRecallTasks, RECALL_TASK_WINDOW_DAYS, routineApps, taskRunsByDay, TASK_RUN_DAYS } from '../src/recall-tasks';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 2, 12, 0).getTime();

function automation(id: string, steps: Automation['steps'], minutesPerWeek?: number): Automation {
  return {
    id,
    name: `Routine ${id}`,
    version: 1,
    routineId: `routine-${id}`,
    params: [],
    steps,
    ...(minutesPerWeek === undefined ? {} : { estimate: { minutesPerWeek, occurrencesPerWeek: 3 } }),
  };
}

describe('routineApps', () => {
  it('names every app a step opens, normalised, and expands a parameter to its options', () => {
    const routine: Automation = {
      ...automation('a', [
        { op: 'focus_app', app: 'Microsoft Excel' },
        { op: 'open_url', app: '$p1', url: 'https://example.com' },
      ]),
      params: [{ name: 'p1', options: ['Google Chrome', 'Safari'], default: 'Google Chrome' }],
    };
    const apps = routineApps(routine);
    expect(apps).toEqual(
      expect.arrayContaining([normalizeAppName('Microsoft Excel'), normalizeAppName('Google Chrome'), normalizeAppName('Safari')]),
    );
    expect(apps).toHaveLength(3);
  });
});

describe('assignRecallTasks', () => {
  it('assigns nothing when Recall has seen none of a routine’s apps in the window', () => {
    const routine = automation('a', [{ op: 'focus_app', app: 'Slack' }]);
    const tasks = assignRecallTasks([{ automation: routine, level: 2 }], [], NOW);
    expect(tasks).toEqual([]);
  });

  it('ignores observations older than the window', () => {
    const routine = automation('a', [{ op: 'focus_app', app: 'Slack' }]);
    const old = [{ app: 'slack', count: 40, recent: 0, latest: NOW - (RECALL_TASK_WINDOW_DAYS + 1) * DAY }];
    expect(assignRecallTasks([{ automation: routine, level: 2 }], old, NOW)).toEqual([]);
  });

  it('ranks by recency-weighted observations times the time the routine saves', () => {
    const quick = automation('quick', [{ op: 'focus_app', app: 'Slack' }], 10);
    const slow = automation('slow', [{ op: 'focus_app', app: 'Slack' }], 60);
    const evidence = [{ app: 'slack', count: 4, recent: 4, latest: NOW - 1000 }];
    const tasks = assignRecallTasks(
      [
        { automation: quick, level: 3 },
        { automation: slow, level: 4 },
      ],
      evidence,
      NOW,
    );
    expect(tasks.map(task => task.automationId)).toEqual(['slow', 'quick']);
    expect(tasks[0].observations).toBe(4);
    expect(tasks[0].priority).toBe(240);
    expect(tasks[0].level).toBe(4);
  });

  it('counts an observation older than a day at half weight', () => {
    const routine = automation('a', [{ op: 'focus_app', app: 'Slack' }]);
    const older = [{ app: 'slack', count: 4, recent: 0, latest: NOW - 3 * DAY }];
    const tasks = assignRecallTasks([{ automation: routine, level: 2 }], older, NOW);
    expect(tasks[0].priority).toBe(2);
  });

  it('weights each observation by its own age, so one recent glance does not count older ones in full', () => {
    const routine = automation('a', [{ op: 'focus_app', app: 'Slack' }]);
    const mixed = [{ app: 'slack', count: 1001, recent: 1, latest: NOW - 1000 }];
    const tasks = assignRecallTasks([{ automation: routine, level: 2 }], mixed, NOW);
    expect(tasks[0].observations).toBe(1001);
    expect(tasks[0].priority).toBe(501);
  });
});

describe('taskRunsByDay', () => {
  it('returns one count per local day, today last, and counts only runs on that day', () => {
    const runs = [
      { ts: NOW, mode: 'supervised' as const, level: 3 as const, status: 'completed' as const, postconditionsPassed: 1, postconditionsFailed: 0, reverted: false },
      { ts: NOW - 2 * DAY, mode: 'unattended' as const, level: 4 as const, status: 'failed' as const, postconditionsPassed: 0, postconditionsFailed: 1, reverted: false },
      { ts: NOW - 100 * DAY, mode: 'supervised' as const, level: 3 as const, status: 'completed' as const, postconditionsPassed: 1, postconditionsFailed: 0, reverted: false },
    ];
    const counts = taskRunsByDay([{ state: { runs } }], NOW);
    expect(counts.length).toBe(TASK_RUN_DAYS);
    expect(counts.at(-1)).toBe(1);
    expect(counts.at(-3)).toBe(1);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(2);
  });
});
