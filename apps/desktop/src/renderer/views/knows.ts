import type { DeclinedRoutineView, HabitsView, RoutineStepView, RoutineView, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, chip, emptyState, pageHeader, panel, panelHead, type ButtonOptions } from '../components/ui.js';
import { plural } from '../format.js';
import {
  COPY,
  KIND_NAMES,
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
} from '../knows-model.js';
import { call, pending } from '../store.js';

type ReadyHabits = Extract<HabitsView, { state: 'ready' }>;

/**
 * What the twin holds about the person, on one page: the routines it knows, the habits it has seen, what the person said
 * no to, and today's tasks. Every value comes from the status the page is given. Each action is one bridge call.
 */
export function knowsView(status: TwinStatus): HTMLElement {
  const { routines, declined } = status.knownRoutines;
  const now = Date.now();
  return h(
    'div',
    { class: 'kn-view', 'data-testid': 'view-knows' },
    pageHeader(COPY.title, COPY.note),
    h(
      'div',
      { class: 'kn-grid' },
      h('div', { class: 'kn-col' }, routinesPanel(routines), declinedPanel(declined, now)),
      h('div', { class: 'kn-col' }, habitsPanel(status.habits), tasksPanel(status)),
    ),
  );
}

/** A titled panel. Its title labels the panel for assistive tech, as the other pages do. */
function section(testid: string, title: string, note: string | undefined, ...children: Child[]): HTMLElement {
  const id = `${testid}-title`;
  return panel({ testid, extra: 'kn-panel', labelledBy: id }, panelHead(title, note, id), ...children);
}

function routinesPanel(routines: readonly RoutineView[]): HTMLElement {
  return section(
    'knows-routines',
    COPY.routines,
    routines.length > 0 ? plural(routines.length, 'routine') : undefined,
    routines.length === 0
      ? emptyState(COPY.routinesEmpty, COPY.routinesEmptyText)
      : h('ul', { class: 'kn-list' }, ...routines.map(routineRow)),
  );
}

/** One routine: its name, its status, its steps with sites, and when it usually happens. Only a suggestion can be forgotten. */
function routineRow(view: RoutineView): HTMLElement {
  return h(
    'li',
    { class: 'kn-row', 'data-testid': 'knows-routine', 'data-routine-id': view.routineId },
    h(
      'div',
      { class: 'kn-row-head' },
      h('h3', { class: 'kn-row-name' }, view.name),
      chip(routineStatusLabel(view), view.status === 'accepted' ? 'teal' : 'neutral', 'knows-routine-status'),
    ),
    h('p', { class: 'kn-steps' }, ...stepChain(view.steps)),
    view.when ? h('p', { class: 'kn-when' }, view.when) : undefined,
    h('div', { class: 'kn-row-actions' }, view.status === 'suggested' ? forgetButton(view) : openAutomationLink(view)),
  );
}

/** The steps in order, joined with arrows. The arrows are for sight; each step is read on its own. */
function stepChain(steps: readonly RoutineStepView[]): Child[] {
  return steps.flatMap((step, index) => [
    index > 0 ? h('span', { class: 'kn-arrow', 'aria-hidden': 'true' }, '→') : undefined,
    h('span', { class: 'kn-step' }, stepLabel(step)),
  ]);
}

/** Dismisses a suggestion, as "Not a routine" does on the Suggestions page. The routine is then listed under declines. */
function forgetButton(view: RoutineView): HTMLButtonElement {
  const key = `forget:${view.routineId}`;
  return rowButton(COPY.forget, `${COPY.forget} ${view.name}`, {
    variant: 'secondary',
    testid: 'knows-forget',
    disabled: pending(key),
    onClick: () => void call(key, twin => twin.dismissRoutine(view.routineId)),
  });
}

/** An accepted routine is an automation now, so its level and runs are managed on its own page. */
function openAutomationLink(view: RoutineView): HTMLElement | undefined {
  if (view.automationId === undefined) return undefined;
  return h(
    'a',
    {
      class: 'btn btn-secondary btn-small',
      href: `#/automations/${encodeURIComponent(view.automationId)}`,
      'data-testid': 'knows-automation',
      'aria-label': `${COPY.openAutomation} ${view.name}`,
    },
    COPY.openAutomation,
  );
}

function declinedPanel(declined: readonly DeclinedRoutineView[], now: number): HTMLElement {
  return section(
    'knows-declined',
    COPY.declined,
    declined.length > 0 ? plural(declined.length, 'routine') : undefined,
    declined.length === 0
      ? emptyState(COPY.declinedEmpty, COPY.declinedEmptyText)
      : h('ul', { class: 'kn-list' }, ...declined.map(item => declinedRow(item, now))),
  );
}

/** One routine the person said no to, with its count in a row and when. Reset clears the decline and the wait. */
function declinedRow(view: DeclinedRoutineView, now: number): HTMLElement {
  const name = view.name ?? COPY.unseen;
  const meta = declinedMeta(view, now);
  const key = `reset:${view.routineId}`;
  return h(
    'li',
    { class: 'kn-row', 'data-testid': 'knows-declined', 'data-routine-id': view.routineId },
    h(
      'div',
      { class: 'kn-row-head' },
      h('h3', { class: 'kn-row-name' }, name),
      chip(declinedKindLabel(view), 'neutral', 'knows-declined-kind'),
    ),
    meta ? h('p', { class: 'kn-meta' }, meta) : undefined,
    h(
      'div',
      { class: 'kn-row-actions' },
      rowButton(COPY.reset, `${COPY.reset} ${name}`, {
        variant: 'secondary',
        testid: 'knows-reset',
        disabled: pending(key),
        onClick: () => void call(key, twin => twin.resetDecline(view.routineId)),
      }),
    ),
  );
}

function habitsPanel(habits: HabitsView): HTMLElement {
  return section(
    'knows-habits',
    COPY.habits,
    `Last ${plural(habits.windowDays, 'day')}`,
    habits.state === 'not_enough_data'
      ? h('p', { class: 'kn-note', 'data-testid': 'knows-habits-empty' }, notEnoughLine(habits))
      : habitsBody(habits),
  );
}

/** The usual hours, the typical session, the usual app for each kind of work, and the stretch before switching. */
function habitsBody(habits: ReadyHabits): HTMLElement {
  return h(
    'div',
    { class: 'kn-habits', 'data-testid': 'knows-habits-ready' },
    block(
      COPY.usualHours,
      h(
        'dl',
        { class: 'kn-pairs' },
        ...habits.usualHours.map(day =>
          h(
            'div',
            { class: 'kn-pair' },
            h('dt', { class: 'mono' }, weekdayName(day.weekday)),
            h('dd', { class: day.enoughData ? 'mono' : 'kn-quiet' }, usualHoursLine(day)),
          ),
        ),
      ),
    ),
    block(COPY.session, h('p', { class: 'kn-value' }, sessionLine(habits.sessionMinutes))),
    block(
      COPY.usualApps,
      habits.usualAppPerKind.length === 0
        ? h('p', { class: 'kn-quiet' }, COPY.noSwitches)
        : h(
            'dl',
            { class: 'kn-pairs' },
            ...habits.usualAppPerKind.map(item => pair(KIND_NAMES[item.windowClass], usualAppLine(item))),
          ),
    ),
    block(
      COPY.stretch,
      habits.stretchMinutes.length === 0
        ? h('p', { class: 'kn-quiet' }, COPY.noStretch)
        : h(
            'dl',
            { class: 'kn-pairs' },
            ...habits.stretchMinutes.map(item => pair(KIND_NAMES[item.windowClass], stretchLine(item))),
          ),
    ),
  );
}

function block(title: string, ...children: Child[]): HTMLElement {
  return h('div', { class: 'kn-block' }, h('h3', { class: 'kn-label' }, title), ...children);
}

function pair(term: string, value: string): HTMLElement {
  return h('div', { class: 'kn-pair' }, h('dt', null, term), h('dd', null, value));
}

/** Today's task count, with the link to the review where the person confirms them. */
function tasksPanel(status: TwinStatus): HTMLElement {
  return section(
    'knows-tasks',
    COPY.tasks,
    undefined,
    h('p', { class: 'kn-value', 'data-testid': 'knows-tasks-count' }, tasksLine(status.tasks.tasks)),
    h(
      'div',
      { class: 'kn-row-actions' },
      h('a', { class: 'btn btn-secondary btn-small', href: '#/review', 'data-testid': 'knows-review' }, COPY.openReview),
    ),
  );
}

/** A small button whose accessible name says which routine it acts on, so the same labels in a list still read apart. */
function rowButton(label: string, accessibleName: string, options: ButtonOptions): HTMLButtonElement {
  const element = button(label, options, 'btn-small');
  element.setAttribute('aria-label', accessibleName);
  return element;
}
