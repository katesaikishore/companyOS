import type { AgentDelegationResult, AutomationView, AutonomyLevel, Param, RunRecord, RunResult, Step, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, chip, emptyState, pageHeader, panel, panelHead, progressBar } from '../components/ui.js';
import { DAY_MS, clamp01, formatRate, formatWhen, percent, plural } from '../format.js';
import {
  GATE,
  LEVEL_NAMES,
  effectsAreLocal,
  gateFraction,
  levelLabel,
  levelTone,
  paramFor,
  passRate,
  runOutcomeLabel,
} from '../labels.js';
import { call, go, pending, state } from '../store.js';

export function automationsView(status: TwinStatus): HTMLElement {
  const header = pageHeader('Automations', 'Accepted routines. Each starts as a draft and moves up a level only when you raise it.');
  if (status.automations.length === 0) {
    return h(
      'div',
      { class: 'stack', 'data-testid': 'view-automations' },
      header,
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
  return h(
    'div',
    { class: 'stack', 'data-testid': 'view-automations' },
    header,
    h('div', { class: 'auto-grid' }, ...status.automations.map(automationCard)),
  );
}

function automationCard(view: AutomationView): HTMLElement {
  const runs = view.state.runs;
  const rate = passRate(runs);
  const level = view.state.level;
  return h(
    'a',
    {
      class: 'panel auto-card',
      href: `#/automations/${encodeURIComponent(view.automation.id)}`,
      'data-testid': 'automation-card',
      'data-automation-id': view.automation.id,
    },
    h(
      'span',
      { class: 'auto-card-head' },
      h('span', { class: 'auto-name' }, view.automation.name),
      chip(levelLabel(level), levelTone(level), 'automation-level'),
    ),
    h(
      'span',
      { class: 'auto-card-meta mono small muted' },
      plural(runs.length, 'run'),
      ' · ',
      rate === undefined ? 'no checks yet' : `${percent(rate)} checks passed`,
    ),
  );
}

export function automationDetailView(status: TwinStatus, id: string): HTMLElement {
  const view = status.automations.find(item => item.automation.id === id);
  const crumb = h('a', { class: 'crumb', href: '#/automations' }, 'Automations');
  if (!view) {
    return h(
      'div',
      { class: 'stack', 'data-testid': 'view-automation' },
      crumb,
      panel({}, emptyState('Automation not found.', 'It may have been removed. Go back to the list.')),
    );
  }

  const automation = view.automation;
  const level = view.state.level;
  const canRun = level >= 3;
  const result = state.runResults.get(automation.id);
  const pauseKey = `level:${automation.id}`;
  const runKey = `run:${automation.id}`;
  const dryKey = `dry:${automation.id}`;

  return h(
    'div',
    { class: 'stack', 'data-testid': 'view-automation' },
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        { class: 'page-head-text' },
        crumb,
        h('h1', { class: 'page-title' }, automation.name),
        h('p', { class: 'page-meta mono' }, `v${automation.version} · ${plural(view.state.runs.length, 'run')}`),
      ),
      h(
        'div',
        { class: 'actions' },
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
              state.runResults.set(automation.id, await twin.dryRun(automation.id));
            }),
        }),
        button('Run now', {
          testid: 'automation-run',
          variant: 'primary',
          disabled: !canRun || pending(runKey),
          onClick: () =>
            void call(runKey, async twin => {
              state.runResults.set(automation.id, await twin.supervisedRun(automation.id));
            }),
        }),
        canRun ? undefined : h('span', { class: 'muted small', 'data-testid': 'automation-run-hint' }, 'Raise to level 3 to run'),
      ),
    ),
    result ? resultPanel(result) : undefined,
    autonomyPanel(view),
    agentDelegationPanel(view, status.config.openMausBotTarget),
    h(
      'div',
      { class: 'split' },
      h('div', { class: 'stack' }, workflowPanel(view), runsPanel(view)),
      h('div', { class: 'stack' }, gatePanel(view), floorPanel()),
    ),
  );
}

function agentDelegationPanel(view: AutomationView, target: string): HTMLElement {
  const automation = view.automation;
  const key = `agent-task:${automation.id}`;
  const brief = state.agentTaskBriefs.get(automation.id) ?? '';
  const result = state.agentTaskResults.get(automation.id);
  const configured = Boolean(target.trim());
  let submitButton: HTMLButtonElement | undefined;
  const taskBrief = h('textarea', {
    class: 'input task-brief',
    rows: 4,
    maxlength: 500,
    placeholder: 'Describe the outcome you want and any constraints.',
    'aria-label': 'Task outcome for OpenMausBot',
    'data-testid': 'agent-task-brief',
    value: brief,
    oninput: (event: Event) => {
      const value = (event.currentTarget as HTMLTextAreaElement).value;
      state.agentTaskBriefs.set(automation.id, value);
      if (submitButton) submitButton.disabled = !value.trim() || pending(key);
    },
  });
  submitButton = button(pending(key) ? 'Waiting for OpenMausBot…' : 'Create task tree', {
    variant: 'primary',
    testid: 'agent-task-submit',
    disabled: !brief.trim() || pending(key),
    onClick: () =>
      void call(key, async twin => {
        state.agentTaskResults.set(automation.id, await twin.delegateRoutine(automation.id, state.agentTaskBriefs.get(automation.id) ?? ''));
      }),
  });

  return panel({ testid: 'automation-agent-delegation', labelledBy: 'agent-delegation-title' },
    h(
      'div',
      { class: 'panel-head wrap' },
      h('h2', { class: 'panel-title', id: 'agent-delegation-title' }, 'Delegate a task tree'),
      h('span', { class: 'panel-note' }, 'Start a multi-agent job from this routine with a clear outcome.'),
    ),
    h('p', { class: 'muted small' },
      configured
        ? `Configured OpenMausBot target: ${target}. The job receives this brief plus the routine name, app sequence and estimated cadence.`
        : 'Connect an existing OpenMausBot lead bot or room in Settings to enable handoffs.',
    ),
    configured ? taskBrief : undefined,
    h('div', { class: 'actions' },
      configured
        ? submitButton
        : button('Configure OpenMausBot', { onClick: () => go('#/settings') }),
    ),
    result ? agentTaskResultPanel(result) : undefined,
  );
}

function agentTaskResultPanel(result: AgentDelegationResult): HTMLElement {
  return h('div', { class: 'agent-task-result', 'data-testid': 'agent-task-result' },
    h('div', { class: 'run-result-head mono' }, h('strong', null, result.state), result.threadId ? ` · ${result.threadId}` : ''),
    h('p', { class: 'small' }, result.summary),
    result.taskTree
      ? h('details', { class: 'agent-task-tree' },
          h('summary', null, 'Show task hierarchy'),
          h('pre', { class: 'code-block' }, result.taskTree),
        )
      : undefined,
  );
}

function resultPanel(result: RunResult): HTMLElement {
  return panel(
    { testid: 'run-panel', extra: 'run-panel' },
    h('span', { class: 'eyebrow' }, 'Last result'),
    h(
      'div',
      { class: 'run-result', 'data-testid': 'run-result' },
      h(
        'div',
        { class: 'run-result-head mono' },
        h('strong', null, result.status),
        ` · ${result.postconditionsPassed} checks passed, ${result.postconditionsFailed} failed`,
      ),
      ...result.steps.map((step, index) =>
        h(
          'div',
          { class: 'run-step mono small' },
          `${index + 1}. ${step.op} ${step.app} · ${step.outcome}${step.reason ? ` — ${step.reason}` : ''}`,
        ),
      ),
    ),
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
    occurrences !== undefined ? `Noticed ${formatRate(occurrences)} times a week.` : 'Noticed in your routines.',
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

function ladderLabel(cell: LadderCell): string {
  switch (cell.tone) {
    case 'passed':
      return `${cell.code} · passed`;
    case 'now':
      return `${cell.code} · now`;
    case 'eligible':
      return `${cell.code} · eligible`;
    case 'locked':
      return `${cell.code} · not for this one`;
    case 'next':
      return `${cell.code} · not yet`;
  }
}

function autonomyPanel(view: AutomationView): HTMLElement {
  return panel({ testid: 'automation-autonomy', labelledBy: 'autonomy-title' },
    h(
      'div',
      { class: 'panel-head wrap' },
      h('h2', { class: 'panel-title', id: 'autonomy-title' }, 'Autonomy'),
      h('span', { class: 'panel-note' }, 'Earned, not granted. You hold the level; your employer cannot raise it.'),
    ),
    h(
      'div',
      { class: 'ladder' },
      ...ladderCells(view).map(cell =>
        h(
          'div',
          {
            class: `ladder-cell tone-${cell.tone}`,
            'data-ladder-state': cell.tone,
            'aria-disabled': cell.tone === 'locked' ? 'true' : undefined,
          },
          h('span', { class: 'mono small ladder-code' }, ladderLabel(cell)),
          h('span', { class: 'ladder-name' }, cell.name),
          h('span', { class: 'small ladder-desc' }, cell.description),
        ),
      ),
    ),
    levelControl(view),
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
  return panel({ testid: 'automation-steps', labelledBy: 'steps-title' },
    h(
      'div',
      { class: 'panel-head wrap' },
      h('h2', { class: 'panel-title', id: 'steps-title' }, 'Workflow'),
      h('span', { class: 'panel-note' }, 'Compiled from the routine. Each step is checked before it runs.'),
    ),
    h('div', { class: 'step-list' }, ...steps.map((step, index) => workflowRow(step, index, params))),
  );
}

function workflowRow(step: Step, index: number, params: readonly Param[]): HTMLElement {
  const param = paramFor(step, params);
  const varies: Child = param ? h('span', { class: 'mono small muted' }, `varies: ${param.options.join(' or ')}`) : undefined;
  const isAct = step.op === 'focus_app';
  const title = isAct ? (param ? 'App chosen for this run' : step.app) : 'Expected app is in front';
  const detail: Child = isAct ? varies : param ? varies : h('span', { class: 'mono small muted' }, step.app);
  return h(
    'div',
    { class: 'step-row' },
    h('span', { class: 'mono small muted' }, String(index + 1).padStart(2, '0')),
    h('span', { class: isAct ? 'kind kind-act' : 'kind kind-check' }, isAct ? 'act' : 'check'),
    h('span', { class: 'step-app' }, h('span', null, title), detail),
    h('span', { class: 'mono small muted' }, step.op),
  );
}

function runsPanel(view: AutomationView): HTMLElement {
  const recent = view.state.runs.slice(-5).reverse();
  return panel({ testid: 'automation-runs', labelledBy: 'runs-title' },
    panelHead('Recent runs', undefined, 'runs-title'),
    recent.length === 0
      ? h('p', { class: 'muted pad' }, 'No runs yet.')
      : h('div', { class: 'run-table' }, ...recent.map((run, index) => runRow(view.automation.id, run, index === 0))),
  );
}

function runRow(id: string, run: RunRecord, newest: boolean): HTMLElement {
  const checks = run.postconditionsPassed + run.postconditionsFailed;
  const action: Child = newest && !run.reverted
    ? button('Undo', { testid: 'automation-revert', onClick: () => void call(`revert:${id}`, twin => twin.revertLast(id)) }, 'btn-small')
    : run.reverted
      ? h('span', { class: 'muted small' }, 'Undone')
      : undefined;
  return h(
    'div',
    { class: 'run-row' },
    h('span', { class: 'mono small muted' }, formatWhen(run.ts)),
    h('span', { class: 'mono small' }, run.mode),
    h('span', { class: 'run-outcome' }, runOutcomeLabel(run)),
    h('span', { class: 'mono small muted' }, checks > 0 ? `${run.postconditionsPassed}/${checks} checks` : 'no checks'),
    action,
  );
}

interface GateCriterion {
  label: string;
  value: string;
  fraction: number;
}

function gatePanel(view: AutomationView): HTMLElement {
  const { state: autonomy, promotion } = view;
  const now = Date.now();
  const windowStart = now - GATE.windowDays * DAY_MS;
  const recent = autonomy.runs.filter(run => run.ts >= windowStart);
  const supervised = autonomy.runs.filter(run => run.mode === 'supervised' && run.level === 3).length;
  const rate = passRate(recent);
  const undos = recent.filter(run => run.reverted).length;
  const local = effectsAreLocal(autonomy.effects);

  const criteria: GateCriterion[] = [
    {
      label: 'Runs you supervised',
      value: `${supervised} / ${GATE.supervisedRuns}`,
      fraction: gateFraction(supervised, GATE.supervisedRuns),
    },
    {
      label: 'Runs in 14 days',
      value: `${recent.length} / ${GATE.runsInWindow}`,
      fraction: gateFraction(recent.length, GATE.runsInWindow),
    },
    {
      label: 'Checks passed',
      value: rate === undefined ? 'no checks yet' : `${percent(rate)} / ${percent(GATE.passRate)}`,
      fraction: rate === undefined ? 0 : clamp01(rate / GATE.passRate),
    },
    { label: 'Your corrections or undos', value: String(undos), fraction: undos === 0 ? 1 : 0 },
    { label: 'Effects local and reversible', value: local ? 'yes' : 'no', fraction: local ? 1 : 0 },
  ];

  return panel({ testid: 'automation-gate', labelledBy: 'gate-title', extra: 'gate' },
    h(
      'div',
      { class: 'gate-head' },
      h('h2', { class: 'panel-title', id: 'gate-title' }, `Promotion gate · to L4`),
      h('span', { class: 'panel-note' }, `All five must hold over the last ${GATE.windowDays} days.`),
    ),
    ...criteria.map(criterion =>
      h(
        'div',
        { class: 'gate-row' },
        h('div', { class: 'gate-line' }, h('span', null, criterion.label), h('span', { class: 'mono small teal' }, criterion.value)),
        progressBar(criterion.fraction),
      ),
    ),
    button('Let it run on its own', {
      variant: 'teal',
      testid: 'automation-promote',
      disabled: !promotion.eligible || pending(`promote:${autonomy.automationId}`),
      onClick: () => void call(`promote:${autonomy.automationId}`, twin => twin.promote(autonomy.automationId)),
    }, 'btn-block'),
    promotion.eligible
      ? undefined
      : h(
          'ul',
          { class: 'reasons', 'data-testid': 'automation-reasons' },
          ...promotion.reasons.map(reason => h('li', null, reason)),
        ),
    h('p', { class: 'muted small' }, 'Any failed check or any undo drops it back to L3 at once.'),
  );
}

function floorPanel(): HTMLElement {
  return panel({ testid: 'automation-floor', labelledBy: 'floor-title', extra: 'panel-warn' },
    h('h2', { class: 'floor-title', id: 'floor-title' }, 'Always asks, at any level'),
    h(
      'ul',
      { class: 'floor-list' },
      ...['Money and payments', 'Messages to new recipients', 'Deleting anything', 'Credentials and permissions', 'Installs and accepting terms'].map(
        item => h('li', null, item),
      ),
    ),
    h('p', { class: 'small floor-foot' }, 'Checked by a local policy engine before every step.'),
  );
}
