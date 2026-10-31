import type { DraftStep, SuggestionView, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, chip, emptyState, pageHeader, panel } from '../components/ui.js';
import { plural, titleCase } from '../format.js';
import { effectLabel, effectsAreLocal } from '../labels.js';
import { call, pending } from '../store.js';

export function suggestionsView(status: TwinStatus): HTMLElement {
  const list = status.suggestions;
  const header = pageHeader(
    'Suggestions',
    'Routines the twin thinks it could take off your hands. Nothing runs until you say so.',
    h('span', { class: 'sg-count mono' }, `${list.length} waiting`),
  );
  if (list.length === 0) {
    return h(
      'div',
      { class: 'stack sg-view', 'data-testid': 'view-suggestions' },
      header,
      panel(
        { testid: 'suggestions-empty', extra: 'sg-empty' },
        emptyState(
          'No new routines yet.',
          'The twin needs about three days of repetition to notice one.',
          h(
            'div',
            { class: 'sg-empty-actions' },
            h('a', { class: 'btn btn-primary sg-link', href: '#/automations' }, 'Go to automations'),
          ),
        ),
      ),
    );
  }

  return h(
    'div',
    { class: 'stack sg-view', 'data-testid': 'view-suggestions' },
    header,
    h('section', { class: 'sg-list', 'aria-label': 'Suggested routines' }, ...list.map(suggestionCard)),
  );
}

/** One routine as a card: its figures, drafted steps, what it touches, and the two answers the person can give. */
function suggestionCard(item: SuggestionView): HTMLElement {
  const touches = item.effects.some(effect => effect !== 'read_only');
  const acceptKey = `accept:${item.routineId}`;
  const dismissKey = `dismiss:${item.routineId}`;
  const busy = pending(acceptKey) || pending(dismissKey);
  const titleId = `suggestion-title-${item.routineId}`;
  // The parameter name is an internal id, so only the options the person picks from are shown.
  const parameterLines = item.parameters.map(param => param.options.join(' or '));
  return h(
    'article',
    { class: 'sg-card', 'data-testid': 'suggestion-card', 'data-routine-id': item.routineId, 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'sg-card-head' },
      h('span', { class: 'sg-card-top' }, chip('L1 · not started', 'neutral'), scorePill(item.score)),
      h('h2', { class: 'sg-name', id: titleId }, item.name),
      appChain(item.drafted),
      figures(item),
    ),
    h(
      'div',
      { class: 'sg-body' },
      h(
        'div',
        { class: 'sg-section' },
        h('h3', { class: 'sg-label' }, 'Drafted steps'),
        h('ol', { class: 'sg-steps' }, ...draftRows(item.drafted)),
      ),
      h(
        'div',
        { class: 'sg-section' },
        h('h3', { class: 'sg-label' }, 'Changes each time'),
        parameterLines.length > 0
          ? h('span', { class: 'sg-params' }, ...parameterLines.map(line => h('span', null, line)))
          : h('span', { class: 'sg-plain' }, 'Nothing. Every run is the same.'),
      ),
      touches
        ? h(
            'p',
            { class: 'sg-touch sg-touch-ask', 'data-testid': 'suggestion-touches' },
            'Writes or sends through apps outside your device. Capped at one-click runs; it can never run unattended.',
          )
        : h('p', { class: 'sg-touch sg-touch-clear', 'data-testid': 'suggestion-touches' }, 'Nothing. Every step is read only.'),
    ),
    h(
      'div',
      { class: 'sg-foot' },
      h('span', { class: 'sg-foot-text' }, 'You confirm every step on the first runs.'),
      button('Not a routine', {
        variant: 'secondary',
        testid: 'suggestion-dismiss',
        disabled: busy,
        onClick: () => void call(dismissKey, twin => twin.dismissRoutine(item.routineId)),
      }),
      button('Accept as draft', {
        variant: 'primary',
        testid: 'suggestion-accept',
        disabled: busy,
        onClick: () => void call(acceptKey, twin => twin.acceptRoutine(item.routineId)),
      }),
    ),
  );
}

/** One row per app the routine focuses. The check after each focus is part of the row's wording, so it is not listed again. */
function draftRows(steps: readonly DraftStep[]): HTMLElement[] {
  return steps.filter(step => step.kind === 'act').map((step, index) => draftRow(step, index));
}

function draftRow(step: DraftStep, index: number): HTMLElement {
  const local = effectsAreLocal([step.effect]);
  return h(
    'li',
    { class: 'sg-step' },
    h('span', { class: 'sg-step-num mono' }, String(index + 1).padStart(2, '0')),
    h('span', { class: 'sg-step-text' }, 'Bring ', h('strong', null, titleCase(step.app)), ' to the front, then check it is there'),
    h(
      'span',
      { class: local ? 'sg-effect sg-effect-local mono' : 'sg-effect sg-effect-ask mono' },
      local ? effectLabel(step.effect) : 'asks you',
    ),
  );
}

/** The apps a routine moves focus through, in order. Repeats in a row are shown once. */
function appChain(steps: readonly DraftStep[]): HTMLElement | undefined {
  const apps: string[] = [];
  for (const step of steps) {
    if (step.kind === 'act' && apps[apps.length - 1] !== step.app) apps.push(step.app);
  }
  if (apps.length === 0) return undefined;
  return h(
    'span',
    { class: 'sg-apps' },
    ...apps.flatMap((app, index) => (index === 0 ? [appMark(app)] : [arrow(), appMark(app)])),
  );
}

function appMark(app: string): HTMLElement {
  const name = titleCase(app);
  return h(
    'span',
    { class: 'sg-app' },
    h('span', { class: 'sg-app-mark', 'aria-hidden': 'true' }, name.charAt(0)),
    h('span', { class: 'sg-app-name' }, name),
  );
}

function arrow(): HTMLElement {
  return h('span', { class: 'sg-arrow', 'aria-hidden': 'true' }, '→');
}

function scorePill(score: number): HTMLElement {
  return h('span', { class: 'sg-score mono' }, `score ${score.toFixed(2)}`);
}

/** Times seen and the hand-time estimate. The estimate is not measured from the person, so it carries a tilde. */
function figures(item: SuggestionView): HTMLElement {
  return h(
    'span',
    { class: 'sg-figures' },
    figure('Seen', `${item.support}× · ${plural(item.days, 'day')}`),
    figure('By hand', `~${Math.round(item.minutesPerWeek)} min / wk`),
  );
}

function figure(label: string, value: string): HTMLElement {
  return h('span', { class: 'sg-figure' }, h('span', { class: 'sg-figure-label' }, label), h('span', { class: 'sg-figure-value' }, value));
}
