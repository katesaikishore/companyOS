import type { DraftStep, SuggestionView, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, chip, emptyState, pageHeader, panel } from '../components/ui.js';
import { formatWhen, plural, titleCase } from '../format.js';
import { effectLabel, effectsAreLocal } from '../labels.js';
import { call, pending, requestRender, state } from '../store.js';

export function suggestionsView(status: TwinStatus): HTMLElement {
  const list = status.suggestions;
  const header = pageHeader(
    'Suggestions',
    'Routines the twin thinks it could take off your hands. Nothing runs unless you start it, or you have turned on unattended runs for an automation at level 4.',
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
          'The twin needs the same sequence on at least three different days to notice one.',
          h(
            'div',
            { class: 'sg-empty-actions' },
            h('a', { class: 'btn btn-primary sg-link', href: '#/automations' }, 'Go to automations'),
          ),
        ),
      ),
    );
  }

  const current = list.find(item => item.routineId === state.selectedSuggestion) ?? list[0];
  return h(
    'div',
    { class: 'stack sg-view', 'data-testid': 'view-suggestions' },
    header,
    h(
      'div',
      { class: 'sg-layout' },
      h(
        'div',
        { class: 'sg-side' },
        h(
          'section',
          { class: 'sg-list', 'aria-label': 'Suggested routines' },
          ...list.map(item => suggestionCard(item, item.routineId === current.routineId)),
        ),
        h('p', { class: 'muted small sg-note' }, 'Dismissed routines are hidden from Suggestions and not suggested again.'),
      ),
      detailCard(current),
    ),
  );
}

function suggestionCard(item: SuggestionView, selected: boolean): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: selected ? 'sg-card is-selected' : 'sg-card',
      'aria-pressed': String(selected),
      'data-testid': 'suggestion-card',
      'data-routine-id': item.routineId,
      onclick: () => {
        state.selectedSuggestion = item.routineId;
        requestRender();
      },
    },
    h('span', { class: 'sg-card-top' }, chip('L1 · not started', 'neutral'), scorePill(item.score)),
    h('span', { class: 'sg-name' }, item.name),
    appChain(item.drafted),
    figures(item),
  );
}

function detailCard(item: SuggestionView): HTMLElement {
  const touches = item.effects.some(effect => effect !== 'read_only');
  const acceptKey = `accept:${item.routineId}`;
  const dismissKey = `dismiss:${item.routineId}`;
  const busy = pending(acceptKey) || pending(dismissKey);
  const parameterLines = item.parameters.map(param => `${param.name}: ${param.options.join(', ')}`);
  return h(
    'article',
    { class: 'panel sg-detail', 'data-testid': 'suggestion-detail', 'aria-labelledby': 'suggestion-title' },
    h(
      'div',
      { class: 'sg-detail-head' },
      h('span', { class: 'sg-card-top' }, chip('L1 · not started', 'neutral'), scorePill(item.score)),
      h('h2', { class: 'sg-detail-title', id: 'suggestion-title' }, item.name),
      appChain(item.drafted),
      figures(item),
      h(
        'p',
        { class: 'sg-detail-lede' },
        'The steps were the same each time; only the apps that varied are shown as options.',
      ),
    ),
    h(
      'div',
      { class: 'sg-body' },
      h(
        'div',
        { class: 'sg-section' },
        h('h3', { class: 'sg-label' }, 'Drafted steps'),
        h('ol', { class: 'sg-steps' }, ...item.drafted.map((step, index) => draftRow(step, index))),
      ),
      h(
        'div',
        { class: 'sg-section' },
        h('h3', { class: 'sg-label' }, 'Changes each time'),
        parameterLines.length > 0
          ? h('span', { class: 'sg-params mono' }, ...parameterLines.map(line => h('span', null, line)))
          : h('span', { class: 'sg-plain' }, 'Nothing. Every run is the same.'),
      ),
      touches
        ? h(
            'div',
            { class: 'box box-warn sg-touch', 'data-testid': 'suggestion-touches' },
            h('span', { class: 'box-title' }, 'What it touches'),
            h(
              'span',
              { class: 'box-body' },
              'Writes or sends through apps outside your device. Capped at one-click runs; it can never run unattended.',
            ),
          )
        : h(
            'div',
            { class: 'box sg-touch sg-touch-clear' },
            h('span', { class: 'box-title' }, 'What it touches'),
            h('span', { class: 'box-body' }, 'Nothing. Every step is read only.'),
          ),
    ),
    h(
      'div',
      { class: 'sg-foot' },
      h(
        'div',
        { class: 'sg-foot-text' },
        h('span', null, 'Nothing runs until you raise it. Steps that focus mail or chat, or open a link, file or shortcut, ask you first.'),
      ),
      h(
        'div',
        { class: 'sg-foot-actions' },
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
    ),
  );
}

function draftRow(step: DraftStep, index: number): HTMLElement {
  const app = titleCase(step.app);
  const local = effectsAreLocal([step.effect]);
  return h(
    'li',
    { class: 'sg-step' },
    h('span', { class: 'sg-step-num mono' }, String(index + 1).padStart(2, '0')),
    h(
      'span',
      { class: 'sg-step-text' },
      step.kind === 'act'
        ? h('span', null, 'Bring ', h('strong', null, app), ' to the front')
        : h('span', null, 'Check that ', h('strong', null, app), ' is in front'),
      step.alternatives > 0 ? h('span', { class: 'muted small' }, `${plural(step.alternatives, 'other app')} seen here`) : undefined,
    ),
    h('span', { class: local ? 'sg-effect sg-effect-local mono' : 'sg-effect sg-effect-ask mono' }, effectLabel(step.effect)),
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

/** Times seen, when it was last seen, and the hand-time estimate. The estimate is not measured from the person. */
function figures(item: SuggestionView): HTMLElement {
  return h(
    'span',
    { class: 'sg-figures' },
    figure('Seen', `${item.support}× · ${plural(item.days, 'day')}`),
    figure('Last seen', formatWhen(item.lastSeenAt)),
    figure('By hand (est.)', `~${Math.round(item.minutesPerWeek)} min / wk`),
  );
}

function figure(label: string, value: string): HTMLElement {
  return h('span', { class: 'sg-figure' }, h('span', { class: 'sg-figure-label' }, label), h('span', { class: 'sg-figure-value' }, value));
}
