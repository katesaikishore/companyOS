import type { AssignedTaskView, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, emptyState, pageHeader } from '../components/ui.js';
import { formatWhen, plural } from '../format.js';
import { levelLabel } from '../labels.js';
import { go } from '../store.js';

/** Shown beside each score, because the number is a weighted count and not a measure of importance. */
const PRIORITY_NOTE = 'Recall observations of this routine’s apps, weighted by recency and by the time it saves.';

/** The tasks Recall has assigned, highest priority first. Each one runs through its automation and its level. */
export function tasksView(status: TwinStatus): HTMLElement {
  const tasks = status.assignedTasks ?? [];
  return h(
    'div',
    { class: 'ov-page', 'data-testid': 'view-tasks' },
    pageHeader(
      'Tasks',
      'Ranked by what Recall saw of each routine’s apps in the last seven days. A routine runs at its own level.',
    ),
    h(
      'section',
      { class: 'ov-card', 'data-testid': 'tasks-list-card', 'aria-label': 'Assigned tasks' },
      tasks.length === 0
        ? emptyState(
            'No tasks assigned yet.',
            'A task appears when Recall has seen the apps of one of your automations in the last seven days. Screen capture must be on, and microphone text counts for the app that was in front.',
            h('div', { class: 'actions' }, button('Open Settings', { onClick: () => go('#/settings') })),
          )
        : h('ul', { class: 'ov-wait-list', 'data-testid': 'tasks-list' }, ...tasks.map((task, index) => taskRow(task, index + 1))),
    ),
  );
}

/** One assigned task: its rank, what Recall saw, its level, and a link to the automation that runs it. */
export function taskRow(task: AssignedTaskView, rank: number): HTMLElement {
  return h(
    'li',
    { class: 'ov-wait-row', 'data-testid': 'task-row' },
    h('span', { class: 'ov-app-more mono' }, `#${rank}`),
    h(
      'span',
      { class: 'ov-wait-copy' },
      h('span', { class: 'ov-wait-name' }, task.name),
      h(
        'span',
        { class: 'ov-wait-meta mono' },
        `${plural(task.observations, 'observation')} · ${formatWhen(task.latest)} · ${levelLabel(task.level)}`,
      ),
    ),
    h('span', { class: 'ov-signal mono', title: PRIORITY_NOTE }, `priority ${task.priority}`),
    button('Open', { onClick: () => go(`#/automations/${encodeURIComponent(task.automationId)}`) }, 'ov-accept'),
  );
}
