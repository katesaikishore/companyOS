import type { TaskView } from '@companyos/twin-core';
import { clock, plural, titleCase } from './format.js';

/** Apps a task lists by name before the rest are counted. */
const APPS_SHOWN = 4;

/** The page title: how many tasks the day has. */
export function reviewTitle(count: number): string {
  return `Today in ${plural(count, 'task')}`;
}

/** How many tasks the person has confirmed, for the header, such as "2 of 5 confirmed". */
export function confirmedLine(tasks: readonly TaskView[]): string {
  return `${tasks.filter(task => task.confirmed).length} of ${tasks.length} confirmed`;
}

/** A task's time range, such as "09:00–10:40". */
export function timeRange(task: Pick<TaskView, 'startTs' | 'endTs'>): string {
  return `${clock(task.startTs)}–${clock(task.endTs)}`;
}

/** The apps a task used, most used first and title-cased. Past four, the rest are counted. */
export function appsLine(apps: readonly string[]): string {
  const shown = apps.slice(0, APPS_SHOWN).map(titleCase);
  const rest = apps.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${plural(rest, 'more app', 'more apps')}` : shown.join(', ');
}

/**
 * Where a task can be split: the start of each stretch after the first, as a clock time. The first stretch has nothing
 * before it to split off, so it is not offered.
 */
export function splitChoices(task: TaskView): Array<{ id: string; label: string }> {
  return task.segments.slice(1).map(segment => ({ id: segment.id, label: clock(segment.startTs) }));
}

/** The line under today's tile on the Overview. */
export function tasksNote(tasks: readonly TaskView[]): string {
  const open = tasks.filter(task => !task.confirmed).length;
  return open === 0 ? 'All confirmed' : plural(open, 'task to confirm', 'tasks to confirm');
}
