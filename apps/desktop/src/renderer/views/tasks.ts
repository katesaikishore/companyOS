import type { AssignedTaskView, OperatorStepView, OperatorTaskView, ProposedTask, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, chip, emptyState, pageHeader, panel, panelHead, type ChipTone } from '../components/ui.js';
import { formatWhen, plural } from '../format.js';
import { levelLabel } from '../labels.js';
import { act, bridge, go, pending, requestRender, state } from '../store.js';

/**
 * The Tasks page: the person tells the twin what to do in an app, and the operator works through it one step at a time
 * with agent-desktop. A step that waits for the person shows here with Approve and Decline. Every value comes from the
 * status; the page holds only what is being typed.
 */

const GOAL_KEY = 'task:goal';
const APP_KEY = 'task:app';
const KEY_KEY = 'task:key';
const MAX_GOAL = 500;

const OUTCOME: Record<OperatorStepView['outcome'], { label: string; tone: ChipTone }> = {
  landed: { label: 'done', tone: 'teal' },
  unverified: { label: 'done, not checked', tone: 'neutral' },
  not_landed: { label: 'did not land', tone: 'warn' },
  may_have_landed: { label: 'may have landed', tone: 'warn' },
  held: { label: 'held for you', tone: 'violet' },
  refused: { label: 'refused', tone: 'danger' },
  finished: { label: 'end', tone: 'ink' },
  invalid: { label: 'could not run', tone: 'warn' },
  no_answer: { label: 'no answer', tone: 'danger' },
};

const RESULT: Record<NonNullable<OperatorTaskView['result']>['status'], string> = {
  done: 'Finished',
  failed: 'Could not finish',
  refused: 'Refused',
  declined: 'Stopped at a step you declined',
  stopped: 'Stopped',
  step_limit: 'Stopped at the step limit',
};

export function tasksView(status: TwinStatus): HTMLElement {
  const operator = status.operator;
  return h(
    'div',
    { class: 'stack tasks-view', 'data-testid': 'view-tasks' },
    pageHeader('Tasks', 'Tell the twin what to do in an app. It works one small step at a time, through agent-desktop.'),
    operator.pending ? approvalPanel(operator.pending) : undefined,
    operator.state === 'idle' ? proposalsPanel(status) : undefined,
    operator.state === 'idle' ? taskForm(status) : runningPanel(operator),
    operator.steps.length > 0 ? stepsPanel(operator) : undefined,
    operator.state === 'idle' && operator.result ? resultPanel(operator) : undefined,
    assignedPanel(status),
    modelPanel(status),
    rulesPanel(),
  );
}

function approvalPanel(waiting: NonNullable<OperatorTaskView['pending']>): HTMLElement {
  return panel(
    { testid: 'task-approval', extra: 'task-approval' },
    panelHead('Waiting for you', 'Nothing happens until you answer.'),
    h('p', { 'data-testid': 'task-approval-step' }, waiting.text),
    waiting.detail !== undefined
      ? h('pre', { class: 'task-approval-text', style: { whiteSpace: 'pre-wrap' }, 'data-testid': 'task-approval-text' }, waiting.detail)
      : undefined,
    h('p', { class: 'muted small' }, waiting.why),
    h(
      'div',
      { class: 'actions' },
      button('Approve this step', {
        variant: 'primary',
        testid: 'task-approve',
        disabled: pending('task-answer'),
        onClick: () => void act('task-answer', () => bridge().answerTaskStep(waiting.id, true)),
      }),
      button('Decline', {
        testid: 'task-decline',
        disabled: pending('task-answer'),
        onClick: () => void act('task-answer', () => bridge().answerTaskStep(waiting.id, false)),
      }),
    ),
  );
}

function taskForm(status: TwinStatus): HTMLElement {
  const form = state.task;
  const ready = status.operator.ready;
  const chutes = status.config.operatorModel === 'chutes';
  const goal = h('textarea', {
    class: 'input task-goal',
    rows: 3,
    maxlength: MAX_GOAL,
    placeholder: 'For example: open a new TextEdit document and type this week’s deadlines',
    'aria-label': 'What should the twin do?',
    'data-testid': 'task-goal',
    oninput: () => {
      state.task.goal = goal.value;
      state.dirty.add(GOAL_KEY);
    },
    onblur: () => state.dirty.delete(GOAL_KEY),
  });
  goal.value = form.goal;
  const app = h('input', {
    class: 'input task-app',
    type: 'text',
    maxlength: 80,
    value: form.app,
    'aria-label': 'App to start in',
    'data-testid': 'task-app',
    oninput: () => {
      state.task.app = app.value;
      state.dirty.add(APP_KEY);
    },
    onblur: () => state.dirty.delete(APP_KEY),
  });
  const share = h('input', {
    type: 'checkbox',
    checked: form.shareMemory,
    'data-testid': 'task-share-memory',
    onchange: () => {
      state.task.shareMemory = share.checked;
    },
  });

  const blocked = !ready.agentDesktop
    ? 'Set the agent-desktop program path in Settings first.'
    : chutes && !ready.chutesKey
      ? 'Save a Chutes key below, or switch the model to this Mac.'
      : undefined;
  return panel(
    { testid: 'task-form' },
    panelHead('New task'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'What should the twin do?'), goal),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'App to start in'), app),
    chutes
      ? h('label', { class: 'field-inline' }, share, h('span', null, ' For this task only, also send the text in the app\u2019s fields and memory notes from my screen text'))
      : undefined,
    blocked ? h('p', { class: 'muted small', 'data-testid': 'task-blocked' }, blocked) : undefined,
    h(
      'div',
      { class: 'actions' },
      button('Start task', {
        variant: 'primary',
        testid: 'task-start',
        disabled: pending('task-start') || blocked !== undefined,
        onClick: () =>
          void act('task-start', async () => {
            const shareMemory = chutes && state.task.shareMemory;
            // The opt-in covers one task. The box is clear again for the next one.
            state.task.shareMemory = false;
            await bridge().startTask({ goal: state.task.goal, app: state.task.app, shareMemory });
            state.dirty.delete(GOAL_KEY);
            state.dirty.delete(APP_KEY);
          }),
      }),
      !ready.agentDesktop ? button('Open Settings', { onClick: () => go('#/settings') }) : undefined,
    ),
  );
}

/**
 * Tasks proposed from what was on screen in the last day. The twin groups the screen text by meaning and names one next
 * step for each piece of work, all on this Mac. A proposal runs only when the person presses Run, and then every step goes
 * through the same checks as a task typed in the box.
 */
function proposalsPanel(status: TwinStatus): HTMLElement {
  const proposals = state.proposals;
  const capturing = status.config.screenCaptureEnabled;
  const find = button(proposals === undefined ? 'Find tasks from my screen' : 'Look again', {
    variant: proposals === undefined ? 'primary' : undefined,
    testid: 'task-propose',
    disabled: pending('task-propose') || !capturing,
    onClick: () =>
      void act('task-propose', async () => {
        state.proposals = await bridge().proposeTasks();
      }),
  });
  return panel(
    { testid: 'task-proposals' },
    panelHead('From your screen', 'What you worked on in the last day, and one next step for each. Worked out on this Mac.'),
    !capturing
      ? h('p', { class: 'muted small' }, 'Turn on screen text in Settings, so the twin has something to understand.')
      : pending('task-propose')
        ? h('p', { class: 'muted small', 'data-testid': 'task-proposing' }, 'Reading your screen text and working out the tasks…')
        : proposals === undefined
          ? undefined
          : proposals.length === 0
            ? h('p', { class: 'muted small', 'data-testid': 'task-proposals-empty' }, 'No clear next step in the last day of screen text.')
            : h('ul', { class: 'ov-wait-list', 'data-testid': 'task-proposal-list' }, ...proposals.map(task => proposalRow(task, status))),
    h('div', { class: 'actions' }, find),
  );
}

function proposalRow(task: ProposedTask, status: TwinStatus): HTMLElement {
  const blocked = !status.operator.ready.agentDesktop || (status.config.operatorModel === 'chutes' && !status.operator.ready.chutesKey);
  return h(
    'li',
    { class: 'ov-wait-row', 'data-testid': 'task-proposal' },
    h(
      'span',
      { class: 'ov-wait-copy' },
      h('span', { class: 'ov-wait-name' }, task.goal),
      h('span', { class: 'ov-wait-meta mono' }, `${task.topic} · ${task.app} · ${plural(task.evidence, 'read')} · ${formatWhen(task.lastSeen)}`),
    ),
    button('Edit', {
      testid: 'task-proposal-edit',
      onClick: () => {
        state.task.goal = task.goal;
        state.task.app = task.app;
        state.dirty.delete(GOAL_KEY);
        state.dirty.delete(APP_KEY);
        requestRender();
      },
    }),
    button('Run', {
      variant: 'primary',
      testid: 'task-proposal-run',
      disabled: pending('task-start') || blocked,
      onClick: () => void act('task-start', () => bridge().startTask({ goal: task.goal, app: task.app })),
    }),
  );
}

function runningPanel(operator: OperatorTaskView): HTMLElement {
  return panel(
    { testid: 'task-running' },
    panelHead('Working on it', operator.app ? `In ${operator.app}` : undefined),
    h('p', { 'data-testid': 'task-running-goal' }, operator.goal ?? ''),
    h(
      'div',
      { class: 'actions' },
      chip(operator.state === 'waiting' ? 'waiting for you' : 'running', operator.state === 'waiting' ? 'violet' : 'teal', 'task-state'),
      button('Stop task', {
        variant: 'danger-outline',
        testid: 'task-stop',
        disabled: pending('task-stop'),
        onClick: () => void act('task-stop', () => bridge().stopTask()),
      }),
    ),
  );
}

function stepsPanel(operator: OperatorTaskView): HTMLElement {
  return panel(
    { testid: 'task-steps' },
    panelHead('Steps', operator.state === 'idle' ? 'Last task' : undefined),
    h(
      'ol',
      { class: 'task-steps' },
      ...operator.steps.map(step => {
        const outcome = OUTCOME[step.outcome];
        return h(
          'li',
          { 'data-testid': 'task-step', 'data-outcome': step.outcome },
          h('span', null, step.text),
          ' ',
          chip(outcome.label, outcome.tone),
          step.why ? h('span', { class: 'muted small' }, ` ${step.why}`) : undefined,
        );
      }),
    ),
  );
}

function resultPanel(operator: OperatorTaskView): HTMLElement {
  const result = operator.result!;
  return panel(
    { testid: 'task-result' },
    panelHead(RESULT[result.status]),
    result.summary ? h('p', null, result.summary) : undefined,
  );
}

function modelPanel(status: TwinStatus): HTMLElement {
  const running = status.operator.state !== 'idle';
  // Tasks are worked out by the Chutes model; the local model is no longer offered for them.
  const parts: Child[] = [
    panelHead('Model for tasks'),
    h(
      'p',
      { class: 'muted small', 'data-testid': 'task-chutes-note' },
      'Tasks are planned and worked out by a large model on Chutes, which reaches the app through agent-desktop. Each step sends the task’s goal, the window title and the app’s control names to llm.chutes.ai. A task from the bar is planned there too, from its goal and the names of the apps that are running. The text in the app’s fields and memory notes from your screen go only when you tick the box for a task. Every call shows in the network ledger, with whether it carried screen text.',
    ),
    status.operator.ready.chutesKey ? keySaved(running) : keyForm(),
  ];
  return panel({ testid: 'task-model-panel' }, ...parts);
}

function keySaved(running: boolean): HTMLElement {
  return h(
    'div',
    { class: 'actions' },
    chip('Key saved in the keychain', 'teal', 'task-key-saved'),
    button('Remove key', {
      testid: 'task-key-remove',
      disabled: running || pending('task-key'),
      onClick: () => void act('task-key', () => bridge().clearChutesKey()),
    }),
  );
}

function keyForm(): HTMLElement {
  const input = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: 'cpk_…',
    'aria-label': 'Chutes API key',
    'data-testid': 'task-key-input',
    oninput: () => state.dirty.add(KEY_KEY),
    onblur: () => state.dirty.delete(KEY_KEY),
  });
  return h(
    'div',
    { class: 'actions' },
    input,
    button('Save key', {
      testid: 'task-key-save',
      disabled: pending('task-key'),
      onClick: () =>
        void act('task-key', async () => {
          const key = input.value.trim();
          input.value = '';
          state.dirty.delete(KEY_KEY);
          await bridge().setChutesKey(key);
        }),
    }),
  );
}

function rulesPanel(): HTMLElement {
  return panel(
    { testid: 'task-rules' },
    panelHead('What the twin may do on its own'),
    h(
      'ul',
      { class: 'muted small' },
      h('li', null, 'In TextEdit, Notes and Stickies, steps run on their own unless they may send, share, delete or sign in.'),
      h('li', null, 'In every other app, each step waits for you.'),
      h('li', null, 'Password managers, terminals and script tools are never used, and passwords are never typed.'),
      h('li', null, 'Stop task, or Stop all automations, ends a task at once.'),
    ),
  );
}

/** Shown beside each score, because the number is a weighted count and not a measure of importance. */
const PRIORITY_NOTE = 'Recall observations of this routine’s apps, weighted by recency and by the time it saves.';

/** The tasks Recall has assigned, highest priority first. Each one runs through its automation and its level. */
function assignedPanel(status: TwinStatus): HTMLElement {
  const tasks = status.assignedTasks ?? [];
  return panel(
    { testid: 'tasks-list-card' },
    panelHead('Assigned by Recall', 'Ranked by what Recall saw of each routine’s apps in the last seven days. A routine runs at its own level.'),
    tasks.length === 0
      ? emptyState(
          'No tasks assigned yet.',
          'A task appears when Recall has seen the apps of one of your automations in the last seven days. Screen capture must be on, and microphone text counts for the app that was in front.',
          h('div', { class: 'actions' }, button('Open Settings', { onClick: () => go('#/settings') })),
        )
      : h('ul', { class: 'ov-wait-list', 'data-testid': 'tasks-list' }, ...tasks.map((task, index) => taskRow(task, index + 1))),
  );
}

/** One assigned task: its rank, what Recall saw, its level, and a link to the automation that runs it. */
function taskRow(task: AssignedTaskView, rank: number): HTMLElement {
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
  );
}
