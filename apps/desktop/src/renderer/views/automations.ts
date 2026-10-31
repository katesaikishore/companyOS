import type { AgentDelegationResult, AutomationView, AutonomyLevel, GateRequirement, HandoffView, Param, RunRecord, RunResult, Step, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, emptyState, levelMeter, pageHeader, panel } from '../components/ui.js';
import { formatRate, formatWhen, handoffStateLabel, noticedPerWeek, plural, summarySourceLabel, titleCase } from '../format.js';
import { LEVEL_NAMES, levelLabel, paramFor, runOutcomeLabel, stepDetail, stepTitle } from '../labels.js';
import { call, go, pending, requestRender, setNotice, state } from '../store.js';

type AutomationTab = 'workflow' | 'autonomy' | 'delegate';

const TABS: readonly { id: AutomationTab; label: string }[] = [
  { id: 'workflow', label: 'Workflow' },
  { id: 'autonomy', label: 'Autonomy' },
  { id: 'delegate', label: 'Delegate to agents' },
];

/** Steps that ask first while supervised. Unattended runs refuse them. */
const ASKS_FIRST = ['Steps that focus mail or chat', 'Steps that open a link, file or shortcut'] as const;

const RUN_HINT_ID = 'automation-run-hint';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The tab the detail shows. It lives here, not in the store, so a refresh of the status keeps the tab the person chose. */
let activeTab: AutomationTab = 'workflow';

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
      selected ? routineDetail(status, selected) : missingDetail(),
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

function routineDetail(status: TwinStatus, view: AutomationView): HTMLElement {
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
        state.runResults.set(automation.id, await twin.supervisedRun(automation.id));
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
        h('h2', { class: 'auto-detail-name' }, automation.name),
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
              state.runResults.set(automation.id, await twin.dryRun(automation.id));
            }),
        }),
        runButton,
        canRun ? undefined : h('span', { class: 'auto-sr', id: RUN_HINT_ID, 'data-testid': 'automation-run-hint' }, 'Runs need level 3 or higher. Raise the routine with Set level below.'),
      ),
    ),
    result ? resultPanel(result) : undefined,
    ladderSection(view),
    tabStrip(),
    tabBody(status, view),
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
          'aria-selected': String(tab.id === activeTab),
          onclick: () => {
            activeTab = tab.id;
            requestRender();
          },
        },
        tab.label,
      ),
    ),
  );
}

function tabBody(status: TwinStatus, view: AutomationView): HTMLElement {
  switch (activeTab) {
    case 'workflow':
      return h('div', { class: 'auto-two' }, workflowPanel(view), runsPanel(view));
    case 'autonomy':
      return h('div', { class: 'auto-two' }, gatePanel(view), floorPanel());
    case 'delegate':
      return agentDelegationPanel(view, status.config.openMausBotTarget, status.handoffs.find(item => item.automationId === view.automation.id));
  }
}

/** `handoff` is the newest handoff for this routine, read from the twin's stored handoffs, so it survives a restart. */
function agentDelegationPanel(view: AutomationView, target: string, handoff: HandoffView | undefined): HTMLElement {
  const automation = view.automation;
  const key = `agent-task:${automation.id}`;
  const brief = state.agentTaskBriefs.get(automation.id) ?? '';
  const configured = Boolean(target.trim());
  const busy = pending(key) || handoff?.state === 'sending';
  const handoffId = handoff?.id;
  let submitButton: HTMLButtonElement | undefined;
  const taskBrief = h('textarea', {
    class: 'input task-brief auto-brief',
    rows: 4,
    maxlength: 500,
    placeholder: 'Describe the outcome you want and any constraints.',
    'aria-label': 'Task outcome for OpenMausBot',
    'data-testid': 'agent-task-brief',
    value: brief,
    oninput: (event: Event) => {
      const value = (event.currentTarget as HTMLTextAreaElement).value;
      state.agentTaskBriefs.set(automation.id, value);
      if (submitButton) submitButton.disabled = !value.trim() || busy;
    },
  });
  // Until the send is on record, the button waits for the answer to the native confirmation. After that, it waits for the job.
  const waitingLabel = handoff?.state === 'sending' ? 'Waiting for OpenMausBot…' : 'Waiting for your confirmation…';
  submitButton = button(busy ? waitingLabel : 'Create task tree', {
    variant: 'primary',
    testid: 'agent-task-submit',
    disabled: !brief.trim() || busy,
    onClick: () =>
      void call(key, async twin => {
        const sent = await twin.delegateRoutine(automation.id, state.agentTaskBriefs.get(automation.id) ?? '');
        // A cancelled confirmation is not recorded, so the page says so here instead of showing a handoff.
        if (cancelledByPerson(sent)) setNotice(sent.summary, 'info');
      }),
  });
  const harnessLink = h(
    'a',
    {
      class: 'auto-link',
      href: '#/harness',
      'data-testid': 'agent-task-harness',
      onclick: () => {
        state.selectedHandoff = handoffId;
      },
    },
    'Open agent harness',
  );

  return card(
    { testid: 'automation-agent-delegation', labelledBy: 'agent-delegation-title', extra: 'auto-delegate' },
    h(
      'div',
      { class: 'auto-stack-sm' },
      h('h3', { class: 'auto-card-title', id: 'agent-delegation-title' }, 'Delegate a task tree'),
      h(
        'p',
        { class: 'auto-card-note' },
        configured
          ? `Start a multi-agent job from this routine with a clear outcome. Configured OpenMausBot target: ${target}. The job receives this brief plus the routine name, app sequence and estimated cadence.`
          : 'Start a multi-agent job from this routine with a clear outcome. Connect an existing OpenMausBot lead bot or room in Settings to enable handoffs.',
      ),
    ),
    configured ? h('label', { class: 'auto-field' }, h('span', { class: 'auto-field-label' }, 'Task outcome'), taskBrief) : undefined,
    h(
      'div',
      { class: 'auto-delegate-foot' },
      configured ? h('span', { class: 'auto-delegate-note' }, 'Sent after one confirmation. Excludes activity history, screenshots and window contents.') : undefined,
      configured ? harnessLink : undefined,
      configured ? submitButton : button('Configure OpenMausBot', { onClick: () => go('#/settings') }),
    ),
    handoff ? agentTaskResultPanel(handoff) : undefined,
  );
}

/** True only when the person refused the native confirmation. A job that ends as cancelled is a handoff the twin recorded. */
function cancelledByPerson(result: Pick<AgentDelegationResult, 'state'> & { cancelledByPerson?: boolean }): boolean {
  return result.state === 'cancelled' && result.cancelledByPerson === true;
}

/**
 * The newest handoff for the routine: its state, thread, reply and job tree, as the twin kept them. The reply is labelled
 * by its source, so the person can tell OpenMausBot's words from companyOS's own message.
 */
function agentTaskResultPanel(handoff: HandoffView): HTMLElement {
  return h('div', { class: 'agent-task-result', 'data-testid': 'agent-task-result' },
    h('div', { class: 'run-result-head mono' },
      h('strong', null, handoffStateLabel(handoff.state)),
      handoff.threadId ? ` · ${handoff.threadId}` : '',
      ` · sent ${formatWhen(handoff.sentAt)}`,
    ),
    handoff.state === 'sending'
      ? h('p', { class: 'small' }, 'Waiting for OpenMausBot to reply.')
      : h('div', null,
          h('span', { class: 'muted small', 'data-testid': 'agent-task-source' }, summarySourceLabel(handoff.localFailure)),
          h('p', { class: 'small' }, handoff.summary || 'No reply text was returned.'),
        ),
    handoff.taskTree
      ? h('details', { class: 'agent-task-tree' },
          h('summary', null, 'Show task hierarchy'),
          h('pre', { class: 'code-block' }, handoff.taskTree),
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
          { class: 'run-step mono' },
          `${index + 1}. ${step.op} ${step.app} · ${step.outcome}${step.reason ? ` — ${step.reason}` : ''}`,
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
      h('h3', { class: 'auto-card-title', id: 'floor-title' }, 'Asks first when supervised'),
      h('span', { class: 'auto-card-note' }, 'Checked by a local policy engine before every step.'),
    ),
    h('ul', { class: 'auto-floor' }, ...ASKS_FIRST.map(item => h('li', { class: 'auto-floor-item' }, lockIcon(), h('span', null, item)))),
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
