import type { FileHitView, FileSearchView, OperatorTaskView, TaskPlanView } from '@companyos/twin-core';
import { h, mount } from './dom.js';
import { bridge, errorText } from './store.js';

/**
 * The bar, opened with Ctrl+Space to find files or Ctrl+Shift+Space to give the agent a task; Tab switches between the two.
 * To find files, the words go to the app, where they are read as a search and the index of the person's files answers:
 * Enter opens the selected result, Cmd+Enter shows it in Finder. To do a task, Enter sends the words to the local model,
 * which plans the task, and the operator does it with agent-desktop. The bar steps aside while the task works, and comes
 * back when a step needs the person's yes and when the task ends. Escape hides the bar.
 */

/** How often the bar reads the task's state while it runs. */
const TASK_POLL_MS = 700;
/** How long the plan stays in view before the bar steps aside for the operator's app. */
const PLAN_SHOWN_MS = 1500;
const SHOWN_TASK_STEPS = 6;
/** Steps shown under a step that waits, so the question and its buttons keep the room. */
const SHOWN_WAITING_STEPS = 3;
const FIND_HINT = 'Find a file or photo: “my passport size photo”, “invoices from Acme last month”…';
const DO_HINT = 'Tell the agent what to do: “open slides.new in Chrome and title it My Portfolio”…';

/** The pause after the last key before searching. A search takes milliseconds, so the bar follows the typing closely. */
const DEBOUNCE_MS = 120;

const view = {
  mode: 'find' as 'find' | 'do',
  task: {
    starting: false,
    plan: undefined as TaskPlanView | undefined,
    operator: undefined as OperatorTaskView | undefined,
    error: undefined as string | undefined,
    /**
     * Whether the last task's plan, steps and result show while no task runs. They show when the bar comes back to say how
     * a task ended, and are cleared when the person opens the bar themselves or starts typing a new task.
     */
    past: false,
  },
  query: '',
  searching: false,
  result: undefined as FileSearchView | undefined,
  error: undefined as string | undefined,
  selected: 0,
  /** Previews by path, filled in after the results show. */
  previews: {} as Record<string, string>,
};
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let taskTimer: ReturnType<typeof setTimeout> | undefined;

const input = h('input', {
  class: 'search-input',
  type: 'text',
  placeholder: FIND_HINT,
  'aria-label': 'Search your files, or give the agent a task',
  'data-testid': 'search-input',
  spellcheck: false,
  oninput: () => {
    view.query = input.value;
    if (view.mode === 'do') {
      // Typing a new task clears the one that ended, so the bar shows only what is happening now.
      if (view.task.past && !busy(view.task.operator)) {
        view.task = { ...view.task, plan: undefined, error: undefined, past: false };
        render();
      }
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // Cleared as it fires, so Enter after the results arrive opens the selection instead of searching again.
      timer = undefined;
      void run();
    }, DEBOUNCE_MS);
  },
  onkeydown: (event: KeyboardEvent) => onKey(event),
});

async function run(): Promise<void> {
  const query = view.query.trim();
  const mine = ++generation;
  if (query.length < 2) {
    view.result = undefined;
    view.error = undefined;
    // A search still running belongs to an older query, so its "searching" note goes too.
    view.searching = false;
    render();
    return;
  }
  view.searching = true;
  render();
  try {
    const result = await bridge().searchFiles(query);
    if (mine !== generation) return;
    view.result = result;
    view.error = undefined;
    view.selected = 0;
    void loadPreviews(result, mine);
  } catch (error) {
    if (mine !== generation) return;
    view.error = errorText(error);
  } finally {
    if (mine === generation) {
      view.searching = false;
      render();
    }
  }
}

/** Asks for the previews this search still lacks, and shows them when they come, unless a newer search has started. */
async function loadPreviews(result: FileSearchView, mine: number): Promise<void> {
  const missing = result.hits.map(hit => hit.path).filter(path => !(path in view.previews));
  if (missing.length === 0) return;
  try {
    const previews = await bridge().filePreviews(missing);
    Object.assign(view.previews, previews);
    if (mine === generation) render();
  } catch {
    // A result without a preview still opens.
  }
}

function open(hit: FileHitView | undefined, reveal: boolean): void {
  if (!hit) return;
  void bridge().openIndexedFile(hit.path, reveal);
  void bridge().hideSearch();
}

/** Switches between finding files and doing a task, keeping the words typed so far. */
function setMode(mode: 'find' | 'do'): void {
  if (view.mode === mode) return;
  view.mode = mode;
  input.placeholder = mode === 'do' ? DO_HINT : FIND_HINT;
  if (mode === 'find' && view.query.trim().length >= 2) void run();
  if (mode === 'do') void readTask();
  render();
}

/** Plans the typed task and starts it. The plan shows for a moment, then the bar steps aside for the operator's app. */
async function startTask(): Promise<void> {
  const goal = input.value.trim();
  if (goal.length < 3 || view.task.starting || busy(view.task.operator)) return;
  view.task = { starting: true, plan: undefined, operator: undefined, error: undefined, past: true };
  render();
  try {
    view.task.plan = await bridge().runPrompt(goal);
    view.task.starting = false;
    render();
    void readTask();
    setTimeout(() => void bridge().hideSearch(), PLAN_SHOWN_MS);
  } catch (error) {
    view.task.starting = false;
    view.task.error = errorText(error);
    render();
  }
}

function busy(task: OperatorTaskView | undefined): boolean {
  return task !== undefined && task.state !== 'idle';
}

/** Reads the task's state, and keeps reading it while the task runs. */
async function readTask(): Promise<void> {
  if (taskTimer) clearTimeout(taskTimer);
  taskTimer = undefined;
  try {
    view.task.operator = (await bridge().status()).operator;
  } catch {
    return;
  }
  render();
  if (view.mode === 'do' && busy(view.task.operator)) taskTimer = setTimeout(() => void readTask(), TASK_POLL_MS);
}

function answer(approve: boolean): void {
  const pending = view.task.operator?.pending;
  if (!pending) return;
  void bridge()
    .answerTaskStep(pending.id, approve)
    .then(() => {
      void readTask();
      // The operator's app goes back in front to carry on.
      if (approve) void bridge().hideSearch();
    });
}

function onKey(event: KeyboardEvent): void {
  const hits = view.result?.hits ?? [];
  if (event.key === 'Escape') {
    event.preventDefault();
    void bridge().hideSearch();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    setMode(view.mode === 'find' ? 'do' : 'find');
  } else if (view.mode === 'do') {
    if (event.key === 'Enter') {
      event.preventDefault();
      // A waiting step is allowed with Cmd+Enter only, so Enter cannot say yes by accident.
      if (event.metaKey && view.task.operator?.pending) answer(true);
      else if (!event.metaKey) void startTask();
    }
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (hits.length === 0) return;
    view.selected = (view.selected + (event.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    render();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      void run();
      return;
    }
    open(hits[view.selected], event.metaKey);
  }
}

function planLine(result: FileSearchView): string {
  const plan = result.plan;
  const parts = [
    plan.kind === 'image' ? 'photos' : plan.kind === 'document' ? 'documents' : 'any file',
    plan.shape !== 'any' ? `${plan.shape} shape` : '',
    plan.about ? `about “${plan.about}”` : '',
    plan.names.length ? `naming ${plan.names.join(', ')}` : '',
    plan.mine ? `yours${plan.me ? ` (${plan.me})` : ''}` : '',
  ].filter(Boolean);
  return `${parts.join(' · ')} — ${result.hits.length} of ${result.indexed} files in ${result.ms} ms${result.meaning ? '' : ', by name and text only'}`;
}

function row(hit: FileHitView, index: number): HTMLElement {
  const selected = index === view.selected;
  return h(
    'li',
    {
      class: `search-hit${selected ? ' is-selected' : ''}`,
      'data-testid': 'search-hit',
      onclick: () => open(hit, false),
      onmouseenter: () => {
        view.selected = index;
        render();
      },
    },
    view.previews[hit.path]
      ? h('img', { class: 'search-preview', src: view.previews[hit.path], alt: '' })
      : h('span', { class: 'search-preview search-icon' }, hit.kind === 'image' ? 'IMG' : hit.kind === 'document' ? 'DOC' : 'FILE'),
    h(
      'span',
      { class: 'search-copy' },
      h('span', { class: 'search-name' }, hit.name),
      h('span', { class: 'search-meta' }, `${hit.folder} · ${new Date(hit.mtime).toLocaleDateString()}`),
      hit.why.length ? h('span', { class: 'search-why' }, hit.why.join(' · ')) : undefined,
    ),
  );
}

const OUTCOME_WORDS: Record<OperatorTaskView['steps'][number]['outcome'], string> = {
  landed: 'done',
  unverified: 'done',
  may_have_landed: 'may have worked',
  not_landed: 'did not work',
  held: 'waiting for you',
  refused: 'refused',
  finished: 'finished',
  invalid: 'not understood',
  no_answer: 'no answer from the model',
};

const RESULT_WORDS: Record<NonNullable<OperatorTaskView['result']>['status'], string> = {
  done: 'Done',
  failed: 'It could not finish',
  refused: 'It refused a step',
  declined: 'You said no to a step',
  stopped: 'Stopped',
  step_limit: 'It ran out of steps',
};

function modes(): HTMLElement {
  const chip = (mode: 'find' | 'do', label: string) =>
    h('button', { class: `search-mode${view.mode === mode ? ' is-on' : ''}`, 'data-testid': `bar-mode-${mode}`, onclick: () => setMode(mode) }, label);
  return h('div', { class: 'search-modes' }, chip('find', 'Find files'), chip('do', 'Do a task'), h('span', { class: 'search-note' }, 'Tab switches'));
}

function taskPanel(): HTMLElement {
  const { starting, plan, operator, error, past } = view.task;
  const running = busy(operator);
  const pending = operator?.pending;
  // While no task runs, the last one shows only when the bar came back to report it.
  const shown = running || past;
  const planLine = plan ? (plan.planned ? `Plan · ${plan.steps.length} steps · starts in ${plan.app}` : `No plan from the model · starts in ${plan.app}`) : '';
  return h(
    'div',
    { class: 'task-panel', 'data-testid': 'bar-task' },
    error ? h('p', { class: 'search-note' }, error) : undefined,
    starting ? h('p', { class: 'search-note' }, 'The local model is planning the task…') : undefined,
    // A step that waits for the person comes first, with its buttons, so it is never below the fold.
    pending
      ? h(
          'div',
          { class: 'task-pending', 'data-testid': 'bar-pending' },
          h('p', {}, pending.text),
          pending.detail ? h('pre', { class: 'task-detail' }, pending.detail) : undefined,
          h('p', { class: 'search-note' }, pending.why),
          h(
            'div',
            { class: 'task-actions' },
            h('button', { class: 'task-allow', 'data-testid': 'bar-allow', onclick: () => answer(true) }, 'Allow (⌘Enter)'),
            h('button', { class: 'task-deny', 'data-testid': 'bar-deny', onclick: () => answer(false) }, 'Don’t allow'),
          ),
        )
      : undefined,
    shown && operator?.result && !running
      ? h('p', { class: 'task-result', 'data-testid': 'bar-result' }, `${RESULT_WORDS[operator.result.status]}${operator.result.summary ? `: ${operator.result.summary}` : '.'}`)
      : undefined,
    shown && (plan || running)
      ? h(
          'div',
          { class: 'task-head' },
          plan ? h('p', { class: 'search-note' }, planLine) : h('p', { class: 'search-note' }, `Working in ${operator?.app ?? 'the app'}`),
          running ? h('button', { class: 'task-deny', 'data-testid': 'bar-stop', onclick: () => void bridge().stopTask().then(() => readTask()) }, 'Stop the task') : undefined,
        )
      : undefined,
    // The plan's steps show while nothing waits; while a step waits, the plan stays one line so the question has the room.
    shown && plan && plan.steps.length > 0 && !pending ? h('ol', { class: 'task-steps' }, ...plan.steps.map(step => h('li', {}, step))) : undefined,
    shown && operator && operator.steps.length > 0
      ? h(
          'ol',
          { class: 'task-steps task-done' },
          ...operator.steps.slice(pending ? -SHOWN_WAITING_STEPS : -SHOWN_TASK_STEPS).map(step => h('li', { value: String(step.n) }, `${step.text} · ${OUTCOME_WORDS[step.outcome]}`)),
        )
      : undefined,
    !starting && !shown && !error ? h('p', { class: 'search-note' }, 'Enter plans the task and starts it · the agent asks before it sends, pays or deletes · Esc closes') : undefined,
  );
}

function render(): void {
  const root = document.getElementById('search');
  if (!root) return;
  if (view.mode === 'do') {
    mount(root, h('div', { class: 'search-card', 'data-testid': 'search-root' }, modes(), input, taskPanel()));
    input.focus();
    return;
  }
  const result = view.result;
  mount(
    root,
    h(
      'div',
      { class: 'search-card', 'data-testid': 'search-root' },
      modes(),
      input,
      view.error
        ? h('p', { class: 'search-note' }, view.error)
        : view.searching
          ? h('p', { class: 'search-note' }, 'Reading your words and looking through your files…')
          : result
            ? h('p', { class: 'search-note' }, planLine(result))
            : h('p', { class: 'search-note' }, 'Enter opens · ⌘Enter shows in Finder · Esc closes'),
      result && result.hits.length > 0 ? h('ul', { class: 'search-hits' }, ...result.hits.map(row)) : undefined,
      result && result.hits.length === 0 && !view.searching ? h('p', { class: 'search-note' }, 'Nothing matched.') : undefined,
    ),
  );
  input.focus();
}

bridge().onSearchOpened((mode, reason) => {
  // Previews are made again each time the bar opens, so a file that changed since never shows an old picture.
  view.previews = {};
  setMode(mode);
  // Opened by the person, the bar starts clean; brought back by a task, it shows that task's question or how it ended.
  view.task.past = reason === 'task';
  if (reason === 'shortcut' && !busy(view.task.operator)) view.task.plan = undefined;
  if (mode === 'do') void readTask();
  input.select();
  input.focus();
});
render();
