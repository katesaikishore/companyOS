const root = document.getElementById('app') as HTMLElement;
const bridge = window.twin;

const LEVEL_LABELS: Record<number, string> = {
  0: 'Observe',
  1: 'Suggest',
  2: 'Draft',
  3: 'One-click run',
  4: 'Unattended',
  5: 'External (not available)',
};

let notice: string | undefined;
let busy = false;
/** True while the settings form has edits that are not saved yet. Background refreshes must not discard them. */
let formDirty = false;

function markDirty(): void {
  formDirty = true;
}
let last: TwinStatus | undefined;

type Child = Node | string | false | undefined;

/** DOM builder. Text goes through textContent, so app names from the device are never parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el) Reflect.set(el, key, value);
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child !== undefined && child !== false) el.append(child);
  }
  return el;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Runs a bridge call with a busy flag and a visible error, then redraws from fresh status. */
async function act<T>(task: () => Promise<T>, done?: (result: T) => string | undefined): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const result = await task();
    notice = done?.(result);
  } catch (error) {
    notice = message(error);
  } finally {
    busy = false;
    await refresh();
  }
}

async function refresh(): Promise<void> {
  last = await bridge.status();
  render(last);
}

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function header(status: TwinStatus): HTMLElement {
  const captureLabel: Record<TwinStatus['capture']['state'], string> = {
    capturing: 'Capturing',
    paused: 'Paused',
    idle: 'Idle',
    locked: 'Screen locked',
    unsupported: 'Not available',
  };
  const paused = status.capture.state === 'paused';
  return h(
    'header',
    { class: 'top' },
    h('div', {}, h('h1', {}, 'companyOS Twin'), h('p', { class: 'muted' }, 'Private by design. Your twin lives on this device.')),
    h(
      'div',
      { class: 'row' },
      h('span', { class: status.capture.state === 'capturing' ? 'pill ok' : 'pill', title: status.capture.detail }, captureLabel[status.capture.state]),
      status.capture.state !== 'unsupported' &&
        h(
          'button',
          {
            onclick: () => act(() => bridge.setPaused(!paused)),
          },
          paused ? 'Resume' : 'Pause',
        ),
    ),
  );
}

function routines(status: TwinStatus): HTMLElement {
  const body =
    status.suggestions.length === 0
      ? h('p', { class: 'muted' }, 'No repeated routines yet. The twin needs a few days of repetition before it suggests one.')
      : h(
          'div',
          {},
          ...status.suggestions.map(suggestion =>
            h(
              'div',
              { class: 'card' },
              h(
                'div',
                { class: 'chain' },
                suggestion.steps
                  .map(step => (step.alternatives > 1 ? `${step.app} (+${step.alternatives - 1})` : step.app))
                  .join('  →  '),
              ),
              h(
                'div',
                { class: 'muted' },
                `Seen on ${suggestion.days} days across ${suggestion.support} work sessions`,
              ),
              h(
                'div',
                { class: 'row' },
                h(
                  'button',
                  {
                    class: 'primary',
                    onclick: () => act(() => bridge.acceptRoutine(suggestion.routineId), () => 'Saved as a draft. Nothing runs until you raise its level.'),
                  },
                  'Accept as draft',
                ),
                status.config.cloudEnabled &&
                  status.apiKeyConfigured &&
                  h(
                    'button',
                    {
                      onclick: () =>
                        act(
                          async () => {
                            const name = await bridge.requestName(suggestion.routineId);
                            if (!name) return undefined;
                            return bridge.acceptRoutine(suggestion.routineId, name.name);
                          },
                          () => 'Named with Claude from an anonymised trace and saved as a draft.',
                        ),
                    },
                    'Name with Claude and accept',
                  ),
              ),
            ),
          ),
        );
  return h('section', {}, h('h2', {}, 'Detected routines'), body);
}

function automationCard(view: AutomationView): HTMLElement {
  const { automation, state, promotion } = view;
  const runs = state.runs.length;
  const passRate = promotion.passRate;
  const level = state.level;
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'row' },
      h('strong', {}, automation.name),
      h('span', { class: 'pill' }, `Level ${level} · ${LEVEL_LABELS[level] ?? ''}`),
    ),
    h('div', { class: 'chain' }, automation.steps.filter(step => step.op === 'focus_app').map(step => step.app).join('  →  ')),
    h('div', { class: 'muted' }, `${runs} runs · pass rate ${percent(passRate)} · effects: ${state.effects.join(', ')}`),
    h(
      'div',
      { class: 'row' },
      h('button', { onclick: () => act(() => bridge.dryRun(automation.id), describeRun) }, 'Dry run'),
      h(
        'button',
        {
          class: 'primary',
          disabled: level < 3,
          onclick: () => act(() => bridge.supervisedRun(automation.id), describeRun),
        },
        'Run with approval',
      ),
      h(
        'label',
        { class: 'row' },
        'Level',
        h(
          'select',
          {
            onchange: (event: Event) =>
              act(() => bridge.setLevel(automation.id, Number((event.target as HTMLSelectElement).value) as 0 | 1 | 2 | 3)),
          },
          ...[0, 1, 2, 3].map(value =>
            h('option', { value: String(value), selected: value === level }, `${value} · ${LEVEL_LABELS[value]}`),
          ),
        ),
      ),
      runs > 0 && h('button', { class: 'danger', onclick: () => act(() => bridge.revertLast(automation.id), () => 'Last run marked as reverted. Level dropped to 3.') }, 'Undo last run'),
      promotion.eligible &&
        h('button', { onclick: () => act(() => bridge.promote(automation.id), () => 'Promoted to unattended runs.') }, 'Allow unattended runs'),
    ),
    !promotion.eligible &&
      level === 3 &&
      h(
        'details',
        {},
        h('summary', {}, 'What is still needed before unattended runs'),
        h('ul', { class: 'reasons' }, ...promotion.reasons.map(reason => h('li', {}, reason))),
      ),
  );
}

function describeRun(result: RunResult): string {
  const lines = result.steps.map(step => `${step.index + 1}. ${step.op} ${step.app}: ${step.outcome} (${step.reason})`);
  return `Run ${result.status}.\n${lines.join('\n')}`;
}

function automations(status: TwinStatus): HTMLElement {
  const body =
    status.automations.length === 0
      ? h('p', { class: 'muted' }, 'Accepted routines appear here. Each starts as a draft.')
      : h('div', {}, ...status.automations.map(automationCard));
  return h('section', {}, h('h2', {}, 'Automations'), body);
}

function usage(status: TwinStatus): HTMLElement {
  const rows =
    status.usage.length === 0
      ? h('p', { class: 'muted' }, 'Nothing recorded in the last 7 days.')
      : h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', {}, 'Kind'), h('th', {}, 'Switches'))),
          h(
            'tbody',
            {},
            ...status.usage.map(entry => h('tr', {}, h('td', {}, entry.app), h('td', {}, entry.windowClass), h('td', {}, String(entry.events)))),
          ),
        );
  return h('section', {}, h('h2', {}, 'Recent app use (7 days)'), rows);
}

function privacy(status: TwinStatus): HTMLElement {
  const cloud = h('input', { type: 'checkbox', checked: status.config.cloudEnabled, id: 'cloud' });
  const unattended = h('input', { type: 'checkbox', checked: status.config.allowUnattended, id: 'unattended' });
  const browsers = h('input', { type: 'checkbox', checked: status.config.watchBrowsers, id: 'browsers' });
  const maxLevel = h(
    'select',
    { id: 'maxlevel' },
    h('option', { value: '3', selected: status.config.maxAutonomyLevel === 3 }, 'Up to level 3 (one-click)'),
    h('option', { value: '4', selected: status.config.maxAutonomyLevel === 4 }, 'Up to level 4 (unattended, local)'),
  );
  const excluded = h('textarea', { id: 'excluded' }, status.config.excludedApps.join(', '));
  const apiKey = h('input', { type: 'password', id: 'apikey', placeholder: 'sk-ant-…', autocomplete: 'off' });

  return h(
    'section',
    { oninput: markDirty, onchange: markDirty },
    h('h2', {}, 'Privacy and settings'),
    h(
      'div',
      { class: 'card' },
      h('label', { class: 'check' }, cloud, 'Allow Claude to name routines from anonymised traces. Off by default.'),
      h('label', { class: 'check' }, unattended, 'Allow unattended runs at level 4, for local and reversible steps only.'),
      h(
        'label',
        { class: 'check' },
        browsers,
        'Watch browsers. Only the app name is recorded, not the page or the window, and private windows cannot be told apart yet. Off by default.',
      ),
      h('label', { class: 'row' }, 'Highest level the twin may reach', maxLevel),
      h(
        'label',
        {},
        'Never watch these apps (comma separated, as you see them, for example Microsoft Edge or msedge). Anything already recorded is deleted.',
        excluded,
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            onclick: () =>
              act(
                () =>
                  bridge.updateConfig({
                    cloudEnabled: cloud.checked,
                    allowUnattended: unattended.checked,
                    maxAutonomyLevel: Number(maxLevel.value) as 3 | 4,
                    watchBrowsers: browsers.checked,
                    excludedApps: excluded.value
                      .split(',')
                      .map(name => name.trim())
                      .filter(name => name.length > 0),
                  }),
                () => {
                  formDirty = false;
                  return 'Settings saved.';
                },
              ),
          },
          'Save settings',
        ),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'muted' },
        status.apiKeyConfigured ? 'A Claude API key is stored in the OS keychain.' : 'No Claude API key is stored.',
      ),
      h('label', {}, 'Claude API key (stored encrypted, never shown again)', apiKey),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            onclick: () =>
              act(
                async () => {
                  const value = apiKey.value;
                  apiKey.value = '';
                  return bridge.setApiKey(value);
                },
                () => 'Key saved.',
              ),
          },
          'Save key',
        ),
      ),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { onclick: () => act(() => bridge.exportData(), path => (path ? `Exported to ${path}. The file is not encrypted.` : undefined)) }, 'Export my data'),
      h('button', { class: 'danger', onclick: () => act(() => bridge.deleteAll(), () => undefined) }, 'Delete everything'),
    ),
  );
}

function ledger(status: TwinStatus): HTMLElement {
  const body =
    status.ledger.length === 0
      ? h('p', { class: 'muted' }, 'No cloud calls yet. Every call the twin makes will be listed here.')
      : h(
          'ul',
          { class: 'reasons' },
          ...status.ledger
            .slice()
            .reverse()
            .map(entry =>
              h(
                'li',
                {},
                `${new Date(entry.ts).toLocaleString()} · ${entry.purpose} · ${entry.model} · ${entry.outcome}` +
                  (entry.fieldsSent.length ? ` · sent: ${entry.fieldsSent.join(', ')}` : ''),
              ),
            ),
        );
  return h('section', {}, h('h2', {}, 'Cloud calls'), h('p', { class: 'muted' }, `${status.recordedFocusEvents} app switches recorded in the last 90 days.`), body);
}

function render(status: TwinStatus): void {
  const noticeBar = notice
    ? h(
        'div',
        { class: 'notice', role: 'status' },
        h('span', {}, notice),
        h('button', { onclick: () => { notice = undefined; if (last) render(last); } }, 'Dismiss'),
      )
    : undefined;

  const parts = [
    header(status),
    noticeBar,
    routines(status),
    automations(status),
    usage(status),
    privacy(status),
    ledger(status),
  ];
  root.replaceChildren(...parts.filter((part): part is HTMLElement => part !== undefined));
}

// Refresh in the background, but not while the person is typing in a form.
setInterval(() => {
  const active = document.activeElement;
  if (busy || formDirty || (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT'))) return;
  void refresh();
}, 5000);

void refresh().catch(error => {
  root.replaceChildren(h('p', { class: 'notice' }, message(error)));
});
