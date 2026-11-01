import type { TaskDecision, TaskView, TwinStatus } from '@companyos/twin-core';
import { h, mount, type Child } from '../dom.js';
import { button, emptyState, pageHeader, panel, type ButtonOptions } from '../components/ui.js';
import { titleCase } from '../format.js';
import { appsLine, confirmedLine, reviewTitle, splitChoices, timeRange } from '../review-model.js';
import { call, pending, state } from '../store.js';
import { appColour } from '../tones.js';

/** The longest name the person can give a task. The engine checks the same limit. */
const NAME_MAX = 60;
/** Apps shown as marks on a task before the rest collapse into a count. */
const MARKS_SHOWN = 3;
/**
 * Keys for an edit in progress. While one is set the page keeps its DOM, so a poll cannot wipe a name being typed or a
 * split point being chosen. Any answer clears both, so the page is drawn again from the result.
 */
const RENAME_EDIT = 'review-rename';
const SPLIT_CHOICE = 'review-split';

const REVIEW_NOTE = 'Grouped from app names and timing on this device. Confirm each task, or rename, merge or split it.';

/** Today's tasks as cards, one per task in time order. Every control is a native element, so the keyboard reaches all of them. */
export function reviewView(status: TwinStatus): HTMLElement {
  const day = status.tasks;
  return h(
    'div',
    { class: 'rv-view', 'data-testid': 'view-review' },
    pageHeader(reviewTitle(day.tasks.length), REVIEW_NOTE, h('span', { class: 'rv-count mono' }, confirmedLine(day.tasks))),
    day.tasks.length === 0
      ? panel(
          { testid: 'review-empty' },
          emptyState(
            'Nothing to review yet.',
            'The twin groups a day into tasks once there are app switches to group. Your tasks will appear here.',
          ),
        )
      : h(
          'section',
          { class: 'rv-list', 'aria-label': 'Tasks for today', 'data-testid': 'review-list' },
          ...day.tasks.map((task, index) => taskCard(day.day, task, day.tasks[index + 1])),
        ),
  );
}

/** One task as a card: its name, apps, time range and state, then the answers the person can give. */
function taskCard(day: string, task: TaskView, next: TaskView | undefined): HTMLElement {
  const slot = h('div', { class: 'rv-name-slot' }, nameHeading(task));
  return h(
    'article',
    { class: 'rv-card', 'data-testid': 'review-task', 'data-task-id': task.id, 'aria-labelledby': nameIdOf(task) },
    h(
      'div',
      { class: 'rv-head' },
      marks(task.apps),
      h('div', { class: 'rv-copy' }, slot, h('p', { class: 'rv-meta mono' }, `${timeRange(task)} · ${appsLine(task.apps)}`)),
      h(
        'span',
        { class: task.confirmed ? 'chip chip-teal' : 'chip chip-neutral', 'data-testid': 'review-state' },
        task.confirmed ? 'Confirmed' : 'Not confirmed',
      ),
    ),
    h('div', { class: 'rv-actions' }, ...actions(day, task, next, slot)),
  );
}

function nameIdOf(task: TaskView): string {
  return `rv-name-${task.id}`;
}

function nameHeading(task: TaskView): HTMLElement {
  return h('h2', { class: 'rv-name', id: nameIdOf(task) }, task.name);
}

/** Letter marks in each app's own colour, as the Overview draws them. A count covers the apps past the first few. */
function marks(apps: readonly string[]): HTMLElement {
  const shown = apps.slice(0, MARKS_SHOWN);
  const hidden = apps.length - shown.length;
  return h(
    'span',
    { class: 'rv-marks', 'aria-hidden': 'true' },
    ...shown.map(app => h('span', { class: `rv-mark app-${appColour(app)}` }, titleCase(app).charAt(0))),
    hidden > 0 ? h('span', { class: 'rv-more mono' }, `+${hidden}`) : undefined,
  );
}

/** The answers offered for a task. Confirm is hidden once the task is confirmed, and merge needs a task after it. */
function actions(day: string, task: TaskView, next: TaskView | undefined, slot: HTMLElement): Child[] {
  const confirmKey = `review:confirm:${task.id}`;
  const mergeKey = `review:merge:${task.id}`;
  return [
    task.confirmed
      ? undefined
      : taskButton('Confirm', `Confirm ${task.name}`, {
          variant: 'primary',
          testid: 'review-confirm',
          disabled: pending(confirmKey),
          onClick: () => decide(confirmKey, { day, kind: 'confirm', taskId: task.id }),
        }),
    taskButton('Rename', `Rename ${task.name}`, {
      variant: 'secondary',
      testid: 'review-rename',
      onClick: () => editName(slot, day, task),
    }),
    next
      ? taskButton('Merge with next', `Merge ${task.name} with the next task`, {
          variant: 'secondary',
          testid: 'review-merge',
          disabled: pending(mergeKey),
          onClick: () => decide(mergeKey, { day, kind: 'merge', taskId: task.id, nextTaskId: next.id }),
        })
      : undefined,
    task.segments.length > 1 ? splitControl(day, task) : undefined,
  ];
}

/** A small button whose accessible name says which task it acts on, so the identical labels in a list still read apart. */
function taskButton(label: string, accessibleName: string, options: ButtonOptions): HTMLButtonElement {
  const element = button(label, options, 'btn-small');
  element.setAttribute('aria-label', accessibleName);
  return element;
}

/** A split point chosen from the stretches after the first, and the button that makes the split. */
function splitControl(day: string, task: TaskView): HTMLElement {
  const select = h(
    'select',
    {
      class: 'input rv-select',
      'data-testid': 'review-split-at',
      'aria-label': `Split point for ${task.name}`,
      onfocus: () => state.dirty.add(SPLIT_CHOICE),
      onblur: () => state.dirty.delete(SPLIT_CHOICE),
    },
    ...splitChoices(task).map(choice => h('option', { value: choice.id }, choice.label)),
  );
  const key = `review:split:${task.id}`;
  return h(
    'span',
    { class: 'rv-split' },
    h('span', { class: 'rv-split-label' }, 'Split at'),
    select,
    taskButton('Split', `Split ${task.name} at the chosen point`, {
      variant: 'secondary',
      testid: 'review-split',
      disabled: pending(key),
      onClick: () => decide(key, { day, kind: 'split', taskId: task.id, segmentId: select.value }),
    }),
  );
}

/**
 * Puts a name field where the name was. Enter saves, Escape cancels, and a cleared name takes the rule-based name back.
 * Focus goes back to the Rename button when the edit ends without a save.
 */
function editName(slot: HTMLElement, day: string, task: TaskView): void {
  state.dirty.add(RENAME_EDIT);
  const restore = (): void => {
    state.dirty.delete(RENAME_EDIT);
    mount(slot, nameHeading(task));
    slot.closest('article')?.querySelector<HTMLElement>('[data-testid="review-rename"]')?.focus();
  };
  const save = (): void => {
    const name = input.value.trim();
    if (name === task.name) {
      restore();
      return;
    }
    decide(`review:rename:${task.id}`, { day, kind: 'rename', taskId: task.id, name });
  };
  const input = h('input', {
    type: 'text',
    class: 'input rv-input',
    value: task.name,
    maxlength: NAME_MAX,
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Task name',
    'data-testid': 'review-name-input',
    onkeydown: (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        save();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        restore();
      }
    },
  });
  mount(
    slot,
    input,
    taskButton('Save', `Save the name of ${task.name}`, { variant: 'primary', testid: 'review-name-save', onClick: save }),
    taskButton('Cancel', `Cancel renaming ${task.name}`, { variant: 'ghost', testid: 'review-name-cancel', onClick: restore }),
  );
  input.focus();
  input.select();
}

/** Sends one decision and drops any edit in progress, so the page is drawn again from the answer. */
function decide(key: string, decision: TaskDecision): void {
  state.dirty.delete(RENAME_EDIT);
  state.dirty.delete(SPLIT_CHOICE);
  void call(key, twin => twin.decideTask(decision));
}
