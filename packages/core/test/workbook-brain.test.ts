import { describe, expect, it } from 'vitest';
import type { Routine } from '../src/mine';
import {
  AUTOMATE_MIN_CONFIDENCE,
  PERSON,
  allocateTask,
  allocateTasks,
  buildBrain,
  understanding,
  type Allocation,
  type BrainTask,
} from '../src/workbook/brain';

/** A mined routine with the fields the brain reads. Each step is one application, optionally with a site. */
function routine(id: string, steps: { app: string; site?: string }[], score = 0.8): Routine {
  return {
    id,
    steps: steps.map(step => ({
      windowClass: 'other' as const,
      app: step.app,
      options: [step.app],
      ...(step.site ? { site: step.site, urlTemplate: step.site } : {}),
    })),
    support: 10,
    days: 5,
    score,
    segmentIds: [],
    durationMs: 60_000,
    occurrencesPerWeek: 2,
    lastSeenAt: 0,
    when: { weekdays: [1, 1, 1, 1, 1, 0, 0], fromHour: 9, toHour: 10 },
  };
}

const EXCEL_WORD = routine('a1b2c3d4e5f6', [{ app: 'Microsoft Excel' }, { app: 'Microsoft Word' }]);
const CHAT_JIRA = routine('0f0f0f0f0f0f', [
  { app: 'Slack' },
  { app: 'Google Chrome', site: 'jira.atlassian.net' },
], 0.6);
const brain = buildBrain([EXCEL_WORD, CHAT_JIRA]);

function task(id: string, text: string): BrainTask {
  return { id, text };
}

describe('allocateTask', () => {
  it('gives a task to the routine that covers its terms, at the threshold', () => {
    // "send" is not covered and "excel" is, so the share is one of two terms: exactly the threshold.
    const allocation = allocateTask(task('t1', 'Send the sheet to Excel'), brain);
    expect(allocation.target).toBe('a1b2c3d4e5f6');
    expect(allocation.confidence).toBe(AUTOMATE_MIN_CONFIDENCE);
    expect(allocation.matchedRoutine).toBe('a1b2c3d4e5f6');
    expect(allocation.matchedTerms).toEqual(['excel']);
    expect(allocation.reason).toBe('Routine a1b2c3d4e5f6 covers excel (1 of 2 terms).');
  });

  it('gives a task to a routine when two of four terms are covered', () => {
    const allocation = allocateTask(task('t2', 'Post the Slack update in Chrome'), brain);
    expect(allocation.target).toBe('0f0f0f0f0f0f');
    expect(allocation.matchedTerms).toEqual(['slack', 'chrome']);
    expect(allocation.confidence).toBe(0.5);
  });

  it('keeps a near miss with the person and still names the closest routine', () => {
    const allocation = allocateTask(task('t3', 'Triage the open Jira tickets'), brain);
    expect(allocation.target).toBe(PERSON);
    expect(allocation.matchedRoutine).toBe('0f0f0f0f0f0f');
    expect(allocation.confidence).toBe(0.33);
    expect(allocation.reason).toContain('below the threshold');
    // The reason names matched terms only, never the rest of the task.
    expect(allocation.reason).not.toContain('open');
  });

  it('leaves a task with no covered term to the person, with no routine named', () => {
    const allocation = allocateTask(task('t4', 'Decide the Q3 hiring plan'), brain);
    expect(allocation).toEqual({
      taskId: 't4',
      target: PERSON,
      confidence: 0,
      matchedTerms: [],
      reason: 'No routine covers this task, so it is left to you.',
    });
  });

  it('leaves a task made only of stop-words and short words to the person', () => {
    const allocation = allocateTask(task('t5', 'the and for it'), brain);
    expect(allocation.target).toBe(PERSON);
    expect(allocation.matchedRoutine).toBeUndefined();
  });

  it('maps the words a person uses for an application to the routine term', () => {
    // "spreadsheet" is the synonym of "excel", so the task has two terms and covers one of them.
    const allocation = allocateTask(task('t6', 'Refresh the spreadsheet'), brain);
    expect(allocation.target).toBe('a1b2c3d4e5f6');
    expect(allocation.matchedTerms).toEqual(['excel']);
  });

  it('reads a routine app name that carries an extension as its plain name', () => {
    const exe = routine('bbbbbbbbbbbb', [{ app: 'Excel.exe' }]);
    const allocation = allocateTask(task('t7', 'Excel figures'), buildBrain([exe]));
    expect(allocation.target).toBe('bbbbbbbbbbbb');
    expect(allocation.matchedTerms).toEqual(['excel']);
    // The extension is not a term, so a task that only says "exe" finds no routine.
    expect(allocateTask(task('t7b', 'Run the exe'), buildBrain([exe])).matchedRoutine).toBeUndefined();
  });

  it('skips a routine with no steps', () => {
    const empty = routine('dddddddddddd', [], 1);
    const allocation = allocateTask(task('t8', 'Total the excel figures'), buildBrain([empty]));
    expect(allocation.target).toBe(PERSON);
    expect(allocation.matchedRoutine).toBeUndefined();
  });

  it('keeps a partial match with the person when the threshold is higher than its confidence', () => {
    const allocation = allocateTask(task('t9', 'Refresh the spreadsheet'), brain, 1);
    expect(allocation.target).toBe(PERSON);
    expect(allocation.matchedRoutine).toBe('a1b2c3d4e5f6');
    expect(allocation.confidence).toBe(0.5);
  });
});

describe('choosing among routines', () => {
  it('prefers the routine with the higher score when the covered counts tie', () => {
    const low = routine('aaaaaaaaaaaa', [{ app: 'Microsoft Excel' }], 0.4);
    const high = routine('bbbbbbbbbbbb', [{ app: 'Microsoft Excel' }], 0.9);
    const allocation = allocateTask(task('t10', 'Excel totals'), buildBrain([low, high]));
    expect(allocation.target).toBe('bbbbbbbbbbbb');
  });

  it('prefers the lower id when the score also ties, whatever the order of the routines', () => {
    const first = routine('bbbbbbbbbbbb', [{ app: 'Microsoft Excel' }], 0.5);
    const second = routine('aaaaaaaaaaaa', [{ app: 'Microsoft Excel' }], 0.5);
    const forward = allocateTask(task('t11', 'Excel totals'), buildBrain([first, second]));
    const backward = allocateTask(task('t11', 'Excel totals'), buildBrain([second, first]));
    expect(forward.target).toBe('aaaaaaaaaaaa');
    expect(backward.target).toBe('aaaaaaaaaaaa');
  });

  it('does not change the brain when the caller later edits its routine list', () => {
    const list = [EXCEL_WORD];
    const copied = buildBrain(list);
    list.push(CHAT_JIRA);
    expect(copied.routines).toHaveLength(1);
  });
});

describe('allocateTasks', () => {
  it('keeps the input order', () => {
    const allocations = allocateTasks([
      task('x', 'Decide the hiring plan'),
      task('y', 'Refresh the spreadsheet'),
    ], brain);
    expect(allocations.map(allocation => allocation.taskId)).toEqual(['x', 'y']);
  });

  it('refuses a repeated task id', () => {
    expect(() => allocateTasks([task('same', 'Excel'), task('same', 'Slack')], brain)).toThrow(
      'Task ids must be unique.',
    );
  });
});

describe('understanding', () => {
  it('reports zeros for an empty list', () => {
    expect(understanding([])).toEqual({
      tasks: 0,
      automated: 0,
      coverage: 0,
      meanConfidence: 0,
      labelled: 0,
    });
  });

  it('reports coverage, mean confidence and agreement over the labelled tasks', () => {
    const allocations: Allocation[] = allocateTasks([
      task('a', 'Refresh the spreadsheet'),
      task('b', 'Post the Slack update in Chrome'),
      task('c', 'Decide the hiring plan'),
      task('d', 'Triage the open Jira tickets'),
    ], brain);
    const expected = new Map([
      ['a', 'a1b2c3d4e5f6'],
      ['b', PERSON],
      ['c', PERSON],
      ['d', '0f0f0f0f0f0f'],
      ['missing', PERSON],
    ]);
    const summary = understanding(allocations, expected);
    expect(summary.tasks).toBe(4);
    expect(summary.automated).toBe(2);
    expect(summary.coverage).toBe(0.5);
    expect(summary.meanConfidence).toBeCloseTo((0.5 + 0.5 + 0 + 0.33) / 4, 5);
    expect(summary.labelled).toBe(4);
    // "b" is automated but labelled as the person's, and "d" is kept but labelled as the routine's.
    expect(summary.agreement).toBe(0.5);
  });

  it('leaves agreement undefined when nothing is labelled', () => {
    const summary = understanding(allocateTasks([task('a', 'Refresh the spreadsheet')], brain));
    expect(summary.agreement).toBeUndefined();
    expect(summary.labelled).toBe(0);
  });
});
