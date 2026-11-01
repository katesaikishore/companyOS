import { describe, expect, it } from 'vitest';
import type { TaskView } from '@companyos/twin-core';
import { appsLine, confirmedLine, reviewTitle, splitChoices, tasksNote, timeRange } from '../src/renderer/review-model';
import { routeFromHash, routeKey } from '../src/renderer/store';

/** Local time, as the person sees it. October 2026. */
function clockAt(hour: number, minute = 0): number {
  return new Date(2026, 9, 1, hour, minute).getTime();
}

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'a-0',
    name: 'Microsoft Excel',
    renamed: false,
    apps: ['microsoft excel'],
    startTs: clockAt(9),
    endTs: clockAt(9, 30),
    segments: [{ id: 'a-0', startTs: clockAt(9) }],
    confirmed: false,
    ...overrides,
  };
}

describe('review header', () => {
  it('counts the day in tasks, with the right plural', () => {
    expect(reviewTitle(0)).toBe('Today in 0 tasks');
    expect(reviewTitle(1)).toBe('Today in 1 task');
    expect(reviewTitle(3)).toBe('Today in 3 tasks');
  });

  it('says how many tasks are confirmed', () => {
    expect(confirmedLine([task({ confirmed: true }), task({ id: 'b-1' }), task({ id: 'c-2' })])).toBe('1 of 3 confirmed');
  });
});

describe('task rows', () => {
  it('gives a time range in clock times', () => {
    expect(timeRange({ startTs: clockAt(9), endTs: clockAt(10, 40) })).toBe('09:00–10:40');
  });

  it('lists the apps most used first, title-cased, and counts those past four', () => {
    expect(appsLine(['microsoft excel', 'slack'])).toBe('Microsoft Excel, Slack');
    expect(appsLine(['microsoft excel', 'slack', 'google chrome', 'notion', 'zoom'])).toBe(
      'Microsoft Excel, Slack, Google Chrome, Notion and 1 more app',
    );
    expect(appsLine(['slack', 'zoom', 'notion', 'figma', 'sketch', 'whatsapp'])).toBe('Slack, Zoom, Notion, Figma and 2 more apps');
  });

  it('offers a split at each stretch after the first, by its start time', () => {
    const split = task({
      segments: [
        { id: 'a-0', startTs: clockAt(9) },
        { id: 'b-1', startTs: clockAt(10, 15) },
        { id: 'c-2', startTs: clockAt(11) },
      ],
    });

    expect(splitChoices(split)).toEqual([
      { id: 'b-1', label: '10:15' },
      { id: 'c-2', label: '11:00' },
    ]);
    expect(splitChoices(task())).toEqual([]);
  });

  it('says how many tasks still need confirming on the Overview tile', () => {
    expect(tasksNote([task(), task({ id: 'b-1' })])).toBe('2 tasks to confirm');
    expect(tasksNote([task({ confirmed: true }), task({ id: 'b-1' })])).toBe('1 task to confirm');
    expect(tasksNote([task({ confirmed: true })])).toBe('All confirmed');
  });
});

describe('review route', () => {
  it('opens the review from the hash, and round-trips it', () => {
    expect(routeFromHash('#/review')).toEqual({ name: 'review' });
    expect(routeKey({ name: 'review' })).toBe('#/review');
  });
});
