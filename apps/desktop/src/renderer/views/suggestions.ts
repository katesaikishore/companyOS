import type { DraftStep, SuggestionView, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, chip, emptyState, pageHeader, panel } from '../components/ui.js';
import { plural } from '../format.js';
import { effectLabel } from '../labels.js';
import { call, pending, requestRender, state } from '../store.js';

export function suggestionsView(status: TwinStatus): HTMLElement {
  const list = status.suggestions;
  const header = pageHeader('Suggestions', 'Routines the twin thinks it could take off your hands. Nothing runs unless you start it, or you have turned on unattended runs for an automation at level 4.');
  if (list.length === 0) {
    return h(
      'div',
      { class: 'stack', 'data-testid': 'view-suggestions' },
      header,
      panel(
        { testid: 'suggestions-empty' },
        emptyState(
          'No new routines yet.',
          'The twin needs the same sequence on at least three different days to notice one.',
        ),
      ),
    );
  }

  const current = list.find(item => item.routineId === state.selectedSuggestion) ?? list[0];
  return h(
    'div',
    { class: 'stack', 'data-testid': 'view-suggestions' },
    header,
    h(
      'div',
      { class: 'suggest-layout' },
      h(
        'div',
        { class: 'suggest-list' },
        ...list.map(item => suggestionCard(item, item.routineId === current.routineId)),
        h(
          'p',
          { class: 'muted small suggest-note' },
          "Dismissed suggestions teach the twin what isn't a routine. They are not shown again.",
        ),
      ),
      detailCard(current),
    ),
  );
}

function suggestionCard(item: SuggestionView, selected: boolean): HTMLElement {
  const lastWeek = Math.round((item.support / Math.max(item.days, 1)) * 7);
  return h(
    'button',
    {
      type: 'button',
      class: selected ? 'suggest-card is-selected' : 'suggest-card',
      'aria-pressed': String(selected),
      'data-testid': 'suggestion-card',
      'data-routine-id': item.routineId,
      onclick: () => {
        state.selectedSuggestion = item.routineId;
        requestRender();
      },
    },
    h('span', { class: 'suggest-name' }, item.name),
    h('span', { class: 'muted small' }, `${lastWeek} times last week`),
    h('span', { class: 'offer mono small' }, `About ${Math.round(item.minutesPerWeek)} min / week by hand (estimate)`),
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
    { class: 'panel detail', 'data-testid': 'suggestion-detail', 'aria-labelledby': 'suggestion-title' },
    h(
      'div',
      { class: 'detail-head' },
      chip('L1 · not started', 'teal'),
      h('h2', { class: 'detail-title', id: 'suggestion-title' }, item.name),
      h(
        'p',
        { class: 'detail-lede' },
        `You did this ${item.support} times across ${item.days} days. The steps were the same each time; only the apps that varied are shown as options.`,
      ),
    ),
    h(
      'div',
      { class: 'detail-section' },
      h('h3', { class: 'eyebrow' }, 'Drafted steps'),
      h('div', { class: 'step-table' }, ...item.drafted.map(draftRow)),
    ),
    h(
      'div',
      { class: 'detail-boxes' },
      h(
        'div',
        { class: 'box box-inset' },
        h('span', { class: 'box-title' }, 'Changes each time'),
        parameterLines.length > 0
          ? h('span', { class: 'mono small box-lines' }, ...parameterLines.map(line => h('span', null, line)))
          : h('span', { class: 'small muted' }, 'Nothing. Every run is the same.'),
      ),
      touches
        ? h(
            'div',
            { class: 'box box-warn', 'data-testid': 'suggestion-touches' },
            h('span', { class: 'box-title' }, 'What it touches'),
            h(
              'span',
              { class: 'box-body' },
              'Writes or sends through apps outside your device. Capped at one-click runs; it can never run unattended.',
            ),
          )
        : undefined,
    ),
    h(
      'div',
      { class: 'detail-foot' },
      button('Accept as draft', {
        variant: 'primary',
        testid: 'suggestion-accept',
        disabled: busy,
        onClick: () => void call(acceptKey, twin => twin.acceptRoutine(item.routineId)),
      }),
      button('Not a routine', {
        variant: 'ghost',
        testid: 'suggestion-dismiss',
        disabled: busy,
        onClick: () => void call(dismissKey, twin => twin.dismissRoutine(item.routineId)),
      }),
      h('span', { class: 'muted small foot-note' }, 'Nothing runs until you raise it. You confirm every step on the first runs.'),
    ),
  );
}

function draftRow(step: DraftStep): HTMLElement {
  return h(
    'div',
    { class: 'step-row' },
    h('span', { class: step.kind === 'act' ? 'kind kind-act' : 'kind kind-check' }, step.kind),
    h(
      'span',
      { class: 'step-app' },
      h('span', null, step.app),
      step.alternatives > 0 ? h('span', { class: 'muted small' }, `${plural(step.alternatives, 'other app')} seen here`) : undefined,
    ),
    h('span', { class: 'mono small muted' }, effectLabel(step.effect)),
  );
}
