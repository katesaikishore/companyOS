import type { AutomationView, AutonomyLevel, EffectClass, GateRequirement, Param, RunRecord, RunResult, Step, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, emptyState, levelMeter, pageHeader, panel } from '../components/ui.js';
import { formatRate, formatWhen, noticedPerWeek, plural, titleCase } from '../format.js';
import { LEVEL_NAMES, levelLabel, paramFor, runOutcomeLabel, stepDetail, stepTitle } from '../labels.js';
import { call, go, pending, requestRender, state, type StoredRun } from '../store.js';

type AutomationTab = 'workflow' | 'autonomy';

const TABS: readonly { id: AutomationTab; label: string }[] = [
  { id: 'workflow', label: 'Workflow' },
  { id: 'autonomy', label: 'Autonomy' },
];

/**
 * The effects that always ask, at every level, in the design's order. Mirrors FLOOR_EFFECTS in packages/core/src/types.ts.
 * The renderer imports only types from core, so the list is kept here and must change with it.
 */
const FLOOR_ROWS: readonly { effect: EffectClass; label: string }[] = [
  { effect: 'money', label: 'Money and payments' },
  { effect: 'external_effect', label: 'Messages to new recipients' },
  { effect: 'deletion', label: 'Deleting anything' },
  { effect: 'permission', label: 'Credentials and permissions' },
  { effect: 'install', label: 'Installs and accepting terms' },
];

const RUN_HINT_ID = 'automation-run-hint';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function automationsView(status: TwinStatus): HTMLElement {
  if (status.automations.length === 0) {
    return h(
      'div',
      { class: 'auto-screen', 'data-testid': 'view-automations' },
      routineHeader(),
      panel(
        { testid: 'automations-empty' },
        emptyState(
          'No automations yet.',
          'Accept a suggestion to create a draft. Nothing runs until you raise its level.',
          h('div', { class: 'actions' }, button('Review suggestions', { variant: 'primary', onClick: () => go('#/suggestions') })),
        ),
      ),
    );
  }
  // The list route selects the first routine, as the design does, so the page is never blank.
  return routinesScreen(status, status.automations[0]?.automation.id, 'view-automations');
}

export function automationDetailView(status: TwinStatus, id: string): HTMLElement {
  return routinesScreen(status, id, 'view-automation');
}

function routineHeader(): HTMLElement {
  return pageHeader('Automations', 'Accepted routines. Each starts as a draft and moves up a level only when you raise it.');
}

/** The routine list beside the selected routine. Both routes use it, so moving between them does not change the layout. */
function routinesScreen(status: TwinStatus, selectedId: string | undefined, testid: string): HTMLElement {
  const selected = status.automations.find(item => item.automation.id === selectedId);
  return h(
    'div',
    { class: 'auto-screen', 'data-testid': testid },
    routineHeader(),
    h(
      'div',
      { class: 'auto-body' },
      routineList(status.automations, selected?.automation.id),
      selected ? routineDetail(selected) : missingDetail(),
    ),
  );
}

function routineList(views: readonly AutomationView[], selectedId: string | undefined): HTMLElement {
  return h('nav', { class: 'auto-list', 'aria-label': 'Automations' }, ...views.map(view => routineLink(view, view.automation.id === selectedId)));
}

function routineLink(view: AutomationView, current: boolean): HTMLElement {
  const { automation } = view;
  const level = view.state.level;
  return h(
    'a',
    {
      class: current ? 'auto-item is-selected' : 'auto-item',
      href: `#/automations/${encodeURIComponent(automation.id)}`,
      'aria-current': current ? 'page' : undefined,
      'data-testid': 'automation-card',
      'data-automation-id': automation.id,
    },
    h('span', { class: 'auto-item-name' }, automation.name),
    h(
      'span',
      { class: 'auto-item-level' },
      levelMeter(level),
      h('span', { class: 'mono', 'data-testid': 'automation-level' }, levelLabel(level)),
    ),
  );
}

function missingDetail(): HTMLElement {
  return h(
    'div',
    { class: 'auto-detail' },
    panel({ testid: 'automation-missing' }, emptyState('Automation not found.', 'It may have been removed. Pick another routine from the list.')),
  );
}

function routineSub(view: AutomationView): string {
  const parts = [levelLabel(view.state.level)];
  const occurrences = view.automation.estimate?.occurrencesPerWeek;
  if (occurrences !== undefined) parts.push(`${formatRate(occurrences)}× / wk`);
  parts.push(plural(view.automation.steps.length, 'step'));
  return parts.join(' · ');
}

function routineDetail(view: AutomationView): HTMLElement {
  const automation = view.automation;
  const level = view.state.level;
  const canRun = level >= 3;
  const result = state.runResults.get(automation.id);
  const pauseKey = `level:${automation.id}`;
  const runKey = `run:${automation.id}`;
  const dryKey = `dry:${automation.id}`;
  const runButton = button(canRun ? 'Run now' : 'Raise to level 3 to run', {
    testid: 'automation-run',
    variant: 'primary',
    disabled: !canRun || pending(runKey),
    onClick: () =>
      void call(runKey, async twin => {
        keepResult(automation.id, await twin.supervisedRun(automation.id));
      }),
  });
  if (!canRun) runButton.setAttribute('aria-describedby', RUN_HINT_ID);

  return h(
    'section',
    { class: 'auto-detail', 'aria-label': automation.name },
    h(
      'div',
      { class: 'auto-detail-head' },
      h(
        'div',
        { class: 'auto-detail-title' },
        nameBlock(view),
        h('span', { class: 'auto-detail-sub mono' }, routineSub(view)),
      ),
      h(
        'div',
        { class: 'actions auto-detail-actions' },
        button('Pause', {
          testid: 'automation-pause',
          disabled: pending(pauseKey),
          onClick: () => void call(pauseKey, twin => twin.setLevel(automation.id, 2)),
        }),
        button('Dry run', {
          testid: 'automation-run-dry',
          disabled: pending(dryKey),
          onClick: () =>
            void call(dryKey, async twin => {
              keepResult(automation.id, await twin.dryRun(automation.id));
            }),
        }),
        runButton,
        canRun ? undefined : h('span', { class: 'auto-sr', id: RUN_HINT_ID, 'data-testid': 'automation-run-hint' }, 'Runs need level 3 or higher. Raise the routine with Set level below.'),
      ),
    ),
    ladderSection(view),
    tabStrip(),
    result ? resultStrip(result) : undefined,
    tabBody(view),
  );
}

/** Keeps a run's result with the time it arrived. The strip shows that time, so a repeat run redraws it. */
function keepResult(automationId: string, result: RunResult): void {
  state.runResults.set(automationId, { ...result, at: Date.now() });
}

/** The name with its Rename control. While the person edits the name, the form takes its place. */
function nameBlock(view: AutomationView): HTMLElement {
  const automation = view.automation;
  if (state.renaming?.automationId === automation.id) return renameForm(view);
  return h(
    'div',
    { class: 'auto-name-row' },
    h('h2', { class: 'auto-detail-name' }, automation.name),
    button('Rename', { testid: 'automation-rename', variant: 'ghost', onClick: () => startRename(view) }, 'btn-small'),
  );
}

function renameKey(automationId: string): string {
  return `rename:${automationId}`;
}

/**
 * Opens the name for editing. The form is marked as unsaved straight away, so a refresh does not rebuild it and lose
 * what the person types. Saving or cancelling clears the mark.
 */
function startRename(view: AutomationView): void {
  state.renaming = { automationId: view.automation.id, draft: view.automation.name };
  requestRender();
  state.dirty.add(renameKey(view.automation.id));
  const input = document.querySelector<HTMLInputElement>('[data-testid="automation-name-input"]');
  input?.focus();
  input?.select();
}

/** The name as an editable field, with Save and Cancel. Enter saves and Escape cancels. */
function renameForm(view: AutomationView): HTMLElement {
  const automation = view.automation;
  const key = renameKey(automation.id);
  const draft = state.renaming?.draft ?? automation.name;
  let saveButton: HTMLButtonElement | undefined;
  const cancel = (): void => {
    state.renaming = undefined;
    state.dirty.delete(key);
    requestRender();
  };
  const submit = (): void => {
    const name = input.value.trim();
    if (!name) return;
    void call(key, async twin => {
      await twin.renameAutomation(automation.id, name);
      state.renaming = undefined;
      state.dirty.delete(key);
    });
  };
  const input = h('input', {
    type: 'text',
    class: 'input auto-name-input',
    value: draft,
    maxlength: 80,
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Automation name',
    'data-testid': 'automation-name-input',
    oninput: (event: Event) => {
      const value = (event.currentTarget as HTMLInputElement).value;
      if (state.renaming) state.renaming.draft = value;
      state.dirty.add(key);
      if (saveButton) saveButton.disabled = !value.trim() || pending(key);
    },
    onkeydown: (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') cancel();
    },
  });
  saveButton = button('Save', {
    variant: 'primary',
    testid: 'automation-name-save',
    disabled: !draft.trim() || pending(key),
    onClick: submit,
  });
  return h(
    'form',
    {
      class: 'auto-name-form',
      'data-testid': 'automation-name-form',
      'aria-label': 'Rename automation',
      onsubmit: (event: Event) => {
        event.preventDefault();
        submit();
      },
    },
    input,
    saveButton,
    button('Cancel', { testid: 'automation-name-cancel', onClick: cancel }, 'btn-small'),
  );
}

function tabStrip(): HTMLElement {
  return h(
    'div',
    { class: 'auto-tabs', role: 'tablist', 'aria-label': 'Automation details' },
    ...TABS.map(tab =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'auto-tab',
          'aria-selected': String(tab.id === state.automationTab),
          onclick: () => {
            state.automationTab = tab.id;
            requestRender();
          },
        },
        tab.label,
      ),
    ),
  );
}

function tabBody(view: AutomationView): HTMLElement {
  switch (state.automationTab) {
    case 'workflow':
      return h('div', { class: 'auto-two' }, workflowPanel(view), runsPanel(view));
    case 'autonomy':
      return h('div', { class: 'auto-two' }, gatePanel(view), floorPanel());
  }
}

/**
 * The last result as a strip under the tabs, so it shows at every tab and inside the window. The label and the time share
 * one line; the full text sits in a box with a max height and its own scroll.
 */
function resultStrip(result: StoredRun): HTMLElement {
  return h(
    'section',
    { class: 'auto-result run-panel', 'data-testid': 'run-panel' },
    h(
      'div',
      { class: 'auto-result-line' },
      h('span', { class: 'eyebrow' }, 'Last result'),
      h('span', { class: 'mono muted' }, formatWhen(result.at)),
    ),
    h(
      'div',
      { class: 'run-result auto-result-text', 'data-testid': 'run-result' },
      h(
        'div',
        { class: 'run-result-head mono' },
        h('strong', null, result.status),
        ` · ${result.postconditionsPassed} checks passed, ${result.postconditionsFailed} failed`,
      ),
      ...result.steps.map((step, index) =>
        h(
          'div',
          { class: 'run-step mono' },
          // The executor's own refusal, when it gave one, is more specific than the generic reason.
          `${index + 1}. ${step.op} ${step.app} · ${step.outcome}${(step.failureReason ?? step.reason) ? ` — ${step.failureReason ?? step.reason}` : ''}`,
        ),
      ),
    ),
  );
}

/** A titled block in the design's card style. The optional extra class sets its flex share in a two-column row. */
function card(options: { testid?: string; labelledBy?: string; extra?: string }, ...children: Child[]): HTMLElement {
  return h(
    'section',
    {
      class: options.extra ? `auto-card ${options.extra}` : 'auto-card',
      'data-testid': options.testid,
      'aria-labelledby': options.labelledBy,
    },
    ...children,
  );
}

interface LadderCell {
  code: string;
  name: string;
  description: string;
  tone: 'passed' | 'now' | 'eligible' | 'locked' | 'next';
}

function ladderCells(view: AutomationView): LadderCell[] {
  const level = view.state.level;
  const eligible = view.promotion.eligible;
  const occurrences = view.automation.estimate?.occurrencesPerWeek;
  const descriptions = [
    'Watches structure only.',
    occurrences !== undefined ? noticedPerWeek(occurrences) : 'Noticed in your routines.',
    'Prepared, not run.',
    'One click, you confirm.',
    'Unattended. Local and reversible.',
    'Sends or writes elsewhere.',
  ];
  return LEVEL_NAMES.map((name, index) => {
    let tone: LadderCell['tone'];
    if (index === 5) tone = 'locked';
    else if (index < level) tone = 'passed';
    else if (index === level) tone = 'now';
    else if (index === 4 && eligible) tone = 'eligible';
    else tone = 'next';
    return { code: `L${index}`, name, description: descriptions[index] ?? '', tone };
  });
}

/** The design marks only the current level, the locked top level and an eligible promotion. Other rungs show their code alone. */
function ladderLabel(cell: LadderCell): string {
  switch (cell.tone) {
    case 'now':
      return `${cell.code} · now`;
    case 'eligible':
      return `${cell.code} · eligible`;
    case 'locked':
      return `${cell.code} · locked`;
    case 'passed':
    case 'next':
      return cell.code;
  }
}

/** The ladder and the level control stay above the tabs, as the design has them. */
function ladderSection(view: AutomationView): HTMLElement {
  return h(
    'section',
    { class: 'auto-ladder-wrap', 'data-testid': 'automation-autonomy', 'aria-label': 'Autonomy' },
    h('ol', { class: 'auto-ladder', 'aria-label': 'Autonomy ladder' }, ...ladderCells(view).map(ladderRung)),
    levelControl(view),
  );
}

function ladderRung(cell: LadderCell): HTMLElement {
  return h(
    'li',
    {
      class: `auto-rung is-${cell.tone}`,
      'data-ladder-state': cell.tone,
      'aria-disabled': cell.tone === 'locked' ? 'true' : undefined,
    },
    h('span', { class: 'auto-rung-code mono' }, ladderLabel(cell)),
    h('span', { class: 'auto-rung-name' }, cell.name),
    h('span', { class: 'auto-rung-desc' }, cell.description),
  );
}

function levelControl(view: AutomationView): HTMLElement {
  const automation = view.automation;
  const level = view.state.level;
  const key = `level:${automation.id}`;
  const select = h(
    'select',
    {
      class: 'select',
      'data-testid': 'automation-level',
      'aria-label': 'Autonomy level',
      disabled: pending(key),
      onchange: () => {
        const next = Number(select.value);
        if (next === level || next > 3) return;
        void call(key, twin => twin.setLevel(automation.id, next as AutonomyLevel));
      },
    },
    ...[0, 1, 2, 3, 4].map(index =>
      h(
        'option',
        { value: String(index), disabled: index === 4 && level !== 4 },
        `L${index} · ${LEVEL_NAMES[index] ?? ''}${index === 4 ? ' (earned by promotion)' : ''}`,
      ),
    ),
  );
  select.value = String(level);
  return h('div', { class: 'level-control' }, h('span', { class: 'muted small' }, 'Set level'), select);
}

function workflowPanel(view: AutomationView): HTMLElement {
  const { steps, params } = view.automation;
  return card(
    { testid: 'automation-steps', labelledBy: 'steps-title', extra: 'auto-col-wide' },
    h('div', { class: 'auto-card-head' }, h('span', { class: 'auto-card-note', id: 'steps-title' }, 'Compiled from the routine. Each step is checked before it runs.')),
    h('ol', { class: 'auto-steps' }, ...steps.map((step, index) => workflowRow(step, index, params))),
  );
}

function workflowRow(step: Step, index: number, params: readonly Param[]): HTMLElement {
  const detail = stepDetail(step, params);
  // A fixed app reads in title case, as the design shows it. A parameter's label is already a sentence, so it is left as it is.
  const title = step.op === 'focus_app' && !paramFor(step, params) ? titleCase(step.app) : stepTitle(step, params);
  return h(
    'li',
    { class: 'auto-step' },
    h('span', { class: 'auto-step-num mono muted' }, String(index + 1).padStart(2, '0')),
    h('span', { class: 'auto-step-op mono muted' }, step.op),
    h(
      'span',
      { class: 'auto-step-app' },
      h('span', null, title),
      detail ? h('span', { class: 'auto-step-detail mono muted' }, detail) : undefined,
    ),
  );
}

function runsPanel(view: AutomationView): HTMLElement {
  const recent = view.state.runs.slice(-5).reverse();
  return card(
    { testid: 'automation-runs', labelledBy: 'runs-title', extra: 'auto-col-narrow' },
    h('div', { class: 'auto-card-head' }, h('h3', { class: 'auto-card-title', id: 'runs-title' }, 'Recent runs')),
    recent.length === 0
      ? h('p', { class: 'auto-empty muted' }, view.state.level < 3 ? 'No runs yet. Raise it to L3 to run it with one click.' : 'No runs yet.')
      : h('ul', { class: 'auto-runs' }, ...recent.map((run, index) => runRow(view.automation.id, run, index === 0))),
  );
}

function runTone(run: RunRecord): 'good' | 'bad' | 'neutral' {
  if (run.status === 'failed' || run.postconditionsFailed > 0) return 'bad';
  return run.status === 'completed' ? 'good' : 'neutral';
}

function runRow(id: string, run: RunRecord, newest: boolean): HTMLElement {
  const checks = run.postconditionsPassed + run.postconditionsFailed;
  const tone = runTone(run);
  const action: Child = newest && !run.reverted
    ? button('Undo', { testid: 'automation-revert', onClick: () => void call(`revert:${id}`, twin => twin.revertLast(id)) }, 'btn-small')
    : run.reverted
      ? h('span', { class: 'auto-run-undone muted' }, 'Undone')
      : undefined;
  const outcome = checks > 0 ? `${runOutcomeLabel(run)} · ${run.postconditionsPassed}/${checks}` : runOutcomeLabel(run);
  return h(
    'li',
    { class: 'auto-run' },
    h('span', { class: `auto-run-dot is-${tone}`, 'aria-hidden': 'true' }),
    h('span', { class: 'auto-run-when mono' }, formatWhen(run.ts)),
    h('span', { class: `auto-run-outcome mono is-${tone}` }, outcome),
    action,
  );
}

function gatePanel(view: AutomationView): HTMLElement {
  const { state: autonomy, promotion } = view;
  const reached = autonomy.level >= 4;
  const promoteKey = `promote:${autonomy.automationId}`;
  return card(
    { testid: 'automation-gate', labelledBy: 'gate-title', extra: 'auto-col-wide' },
    h(
      'div',
      { class: 'auto-card-head' },
      h('h3', { class: 'auto-card-title', id: 'gate-title' }, 'Promotion gate to L4'),
      h('span', { class: 'auto-card-note' }, 'Earned, not granted. You hold the level; your employer cannot raise it.'),
    ),
    reached
      ? h('p', { class: 'auto-empty muted' }, 'This automation is already at L4.')
      : h('ul', { class: 'auto-gate' }, ...promotion.requirements.map(gateRow)),
    promotion.eligible || reached
      ? undefined
      : h(
          'ul',
          { class: 'auto-reasons', 'data-testid': 'automation-reasons' },
          ...promotion.reasons.map(reason => h('li', null, reason)),
        ),
    h(
      'div',
      { class: 'auto-foot' },
      h('span', { class: 'auto-foot-note' }, 'Any failed check or any undo drops it back to L3 at once.'),
      button('Let it run on its own', {
        variant: 'primary',
        testid: 'automation-promote',
        disabled: autonomy.level >= 4 || !promotion.eligible || pending(promoteKey),
        onClick: () => void call(promoteKey, twin => twin.promote(autonomy.automationId)),
      }),
    ),
  );
}

function gateRow(requirement: GateRequirement): HTMLElement {
  return h(
    'li',
    { class: 'auto-gate-row' },
    h('span', { class: requirement.met ? 'auto-gate-mark is-met' : 'auto-gate-mark', 'aria-hidden': 'true' }, requirement.met ? '✓' : ''),
    h('span', { class: 'auto-gate-label' }, h('span', { class: 'auto-sr' }, requirement.met ? 'Met: ' : 'Not met: '), requirement.label),
    h('span', { class: 'auto-gate-value mono' }, requirement.value),
  );
}

function floorPanel(): HTMLElement {
  return card(
    { testid: 'automation-floor', labelledBy: 'floor-title', extra: 'auto-col-narrow' },
    h(
      'div',
      { class: 'auto-card-head' },
      h('h3', { class: 'auto-card-title', id: 'floor-title' }, 'Always asks, at any level'),
      h('span', { class: 'auto-card-note' }, 'Checked by a local policy engine before every step.'),
    ),
    h('ul', { class: 'auto-floor' }, ...FLOOR_ROWS.map(row => h('li', { class: 'auto-floor-item' }, lockIcon(), h('span', null, row.label)))),
  );
}

function svgElement(tag: string, attributes: Record<string, string>): SVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/** The padlock beside each step that asks first. Its colour comes from CSS, so both themes follow. */
function lockIcon(): SVGSVGElement {
  const icon = svgElement('svg', {
    class: 'auto-floor-icon',
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }) as SVGSVGElement;
  icon.append(
    svgElement('rect', { x: '5', y: '11', width: '14', height: '10', rx: '2' }),
    svgElement('path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }),
  );
  return icon;
}
