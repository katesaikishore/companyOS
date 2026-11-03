import type { AutomationView, LiveRunView, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, emptyState, pageHeader } from '../components/ui.js';
import { levelLabel } from '../labels.js';
import { call, go, pending, requestRender, setNotice, state } from '../store.js';

const KEY = 'swarm';
/** The most automations one swarm starts. Mirrors SWARM_MAX in the main process. */
const SWARM_MAX = 9;
const NAME_MAX = 60;

/**
 * Swarms: pick automations at level 3 or above, start them together, and watch every cursor. Each card is one run: the
 * colour of its cursor on screen, its swarm, the step it is on, and what that step does, as the cursor's label says.
 */
export function swarmView(status: TwinStatus): HTMLElement {
  const ready = status.automations.filter(view => view.state.level >= 3);
  const live = status.liveRuns ?? [];
  return h(
    'div',
    { class: 'ov-page', 'data-testid': 'view-swarm' },
    pageHeader(
      'Swarm',
      'Start several automations at once. Each moves its own cursor, labelled with what it is doing; they take turns at the keyboard and mouse, one step at a time.',
    ),
    h('div', { class: 'swarm-grid' }, pickCard(ready), liveCard(live)),
  );
}

function pickCard(ready: readonly AutomationView[]): HTMLElement {
  // Picks of automations that are no longer ready are dropped, so a stale pick never starts.
  for (const id of [...state.swarmPick]) if (!ready.some(view => view.automation.id === id)) state.swarmPick.delete(id);
  const picked = [...state.swarmPick];
  const canStart = picked.length >= 2 && picked.length <= SWARM_MAX && !pending(KEY);
  return h(
    'section',
    { class: 'ov-card swarm-card', 'aria-label': 'Start a swarm', 'data-testid': 'swarm-pick' },
    h('h2', { class: 'swarm-title' }, 'Start a swarm'),
    ready.length < 2
      ? emptyState(
          'Two automations at level 3 are needed.',
          'A swarm starts automations at level 3 or above. Raise at least two, then come back.',
          h('div', { class: 'actions' }, button('Open automations', { onClick: () => go('#/automations') })),
        )
      : h(
          'div',
          null,
          h(
            'ul',
            { class: 'swarm-list' },
            ...ready.map(view =>
              h(
                'li',
                null,
                h(
                  'label',
                  { class: 'swarm-pick-row' },
                  h('input', {
                    type: 'checkbox',
                    checked: state.swarmPick.has(view.automation.id),
                    disabled: !state.swarmPick.has(view.automation.id) && picked.length >= SWARM_MAX,
                    'data-testid': 'swarm-pick-item',
                    onchange: (event: Event) => {
                      if ((event.currentTarget as HTMLInputElement).checked) state.swarmPick.add(view.automation.id);
                      else state.swarmPick.delete(view.automation.id);
                      requestRender();
                    },
                  }),
                  h('span', { class: 'swarm-pick-name' }, view.automation.name),
                  h('span', { class: 'swarm-pick-meta mono' }, `${view.automation.steps.length} steps · ${levelLabel(view.state.level)}`),
                ),
              ),
            ),
          ),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, 'Swarm name (optional)'),
            h('input', {
              type: 'text',
              class: 'input',
              value: state.swarmName,
              maxlength: NAME_MAX,
              placeholder: 'Month-end close',
              autocomplete: 'off',
              'data-testid': 'swarm-name',
              oninput: (event: Event) => {
                state.swarmName = (event.currentTarget as HTMLInputElement).value;
                // Unsaved only while the field holds text, as the other forms do.
                if (state.swarmName.trim()) state.dirty.add(KEY);
                else state.dirty.delete(KEY);
              },
            }),
          ),
          h(
            'div',
            { class: 'actions' },
            button(picked.length < 2 ? 'Pick at least two' : `Start ${picked.length} together`, {
              variant: 'primary',
              testid: 'swarm-start',
              disabled: !canStart,
              onClick: () =>
                void call(KEY, async twin => {
                  const name = state.swarmName.trim() || undefined;
                  state.dirty.delete(KEY);
                  state.swarmPick.clear();
                  state.swarmName = '';
                  // Not awaited: the swarm works on while the page is free to start another, and the live view follows them all.
                  twin.runSwarm(picked, name).catch((error: unknown) => {
                    setNotice(error instanceof Error ? error.message : 'The swarm could not start.');
                    requestRender();
                  });
                }),
            }),
          ),
          h('p', { class: 'swarm-note' }, 'companyOS asks once, naming every automation. You can allow all their steps or be asked for each run. You can start another swarm while one works.'),
        ),
  );
}

function liveCard(live: readonly LiveRunView[]): HTMLElement {
  const running = live.filter(run => run.state === 'running').length;
  return h(
    'section',
    { class: 'ov-card swarm-card', 'aria-label': 'Live cursors', 'data-testid': 'swarm-live' },
    h('h2', { class: 'swarm-title' }, running > 0 ? `Live cursors · ${running} working` : 'Live cursors'),
    live.length === 0
      ? emptyState('No runs right now.', 'Each run in a swarm shows here with its cursor colour and the step it is on.')
      : h('ul', { class: 'swarm-runs' }, ...live.map(runRow)),
  );
}

function runRow(run: LiveRunView): HTMLElement {
  const fraction = run.steps > 0 ? Math.min(1, run.step / run.steps) : 0;
  return h(
    'li',
    { class: `swarm-run is-${run.state}`, 'data-testid': 'swarm-run' },
    h('span', { class: 'swarm-dot', style: { background: run.colour }, 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'swarm-run-copy' },
      h('span', { class: 'swarm-run-name' }, run.name, run.swarm ? h('span', { class: 'swarm-run-swarm' }, run.swarm) : undefined),
      h('span', { class: 'swarm-run-doing', 'data-testid': 'swarm-run-doing' }, run.doing),
      h(
        'span',
        { class: 'swarm-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(run.steps), 'aria-valuenow': String(run.step) },
        h('span', { class: 'swarm-bar-fill', style: { width: `${Math.round(fraction * 100)}%`, background: run.colour } }),
      ),
    ),
    h('span', { class: 'swarm-run-step mono' }, run.state === 'running' ? `step ${run.step} of ${run.steps}` : stateLabel(run.state)),
  );
}

function stateLabel(state: LiveRunView['state']): string {
  return state === 'completed' ? 'done' : state === 'blocked' ? 'stopped' : 'failed';
}
