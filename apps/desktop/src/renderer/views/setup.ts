import type { HardwareProfile, ModelFit, ModelSpec, SetupPlan, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { twinCompanion } from '../components/companion.js';
import { button, chip, exclusionEditor, fact, logo, progressBar, toggleRow } from '../components/ui.js';
import { formatBytes } from '../format.js';
import { browserCaptureNote, fitLabel, modelFraction, modelState, modelStateLabel } from '../labels.js';
import { act, bridge, call, errorText, go, pending, requestRender, saveConfig, state } from '../store.js';

const TITLES = ['Welcome', 'What companyOS can see', 'Your device and models', 'Start observing'];

/** Opens the wizard at a step. The step-3 device check runs when that step is shown. */
export function openSetup(step: number): void {
  state.wizardForced = true;
  goStep(step);
}

export function goStep(step: number): void {
  state.wizardStep = Math.min(4, Math.max(1, step));
  state.altOpen = false;
  if (state.wizardStep === 3) void loadPlan();
  requestRender();
}

export async function loadPlan(): Promise<void> {
  if (state.setup.loading || state.setup.plan) return;
  state.setup = { loading: true };
  requestRender();
  try {
    const [hardware, plan] = await Promise.all([bridge().hardware(), bridge().setupPlan()]);
    state.setup = { loading: false, hardware, plan };
  } catch (error) {
    state.setup = { loading: false, error: errorText(error) };
  }
  requestRender();
}

function retryPlan(): void {
  state.setup = { loading: false };
  void loadPlan();
}

async function startObserving(): Promise<void> {
  await act('start', async () => {
    await bridge().completeSetup();
    state.wizardForced = false;
    state.wizardStep = 1;
    go('#/overview');
  });
}

function closeSetup(): void {
  state.wizardForced = false;
  state.wizardStep = 1;
  go('#/settings');
  requestRender();
}

export function setupView(status: TwinStatus): HTMLElement {
  const step = state.wizardStep;
  return h(
    'div',
    { class: 'setup', 'data-testid': 'setup-root' },
    rail(step),
    h(
      'section',
      { class: 'setup-main' },
      h('div', { class: 'setup-card' }, stepBody(step, status), footer(step, status)),
    ),
  );
}

function rail(step: number): HTMLElement {
  return h(
    'aside',
    { class: 'setup-rail' },
    h('div', { class: 'brand' }, logo(26), h('span', { class: 'brand-name' }, 'companyOS')),
    h(
      'ol',
      { class: 'rail-steps' },
      ...TITLES.map((label, index) => {
        const number = index + 1;
        const done = number < step;
        const current = number === step;
        return h(
          'li',
          {
            class: done ? 'rail-step is-done' : current ? 'rail-step is-current' : 'rail-step',
            'aria-current': current ? 'step' : undefined,
          },
          h('span', { class: 'rail-marker mono' }, done ? '✓' : String(number)),
          h('span', null, label),
        );
      }),
    ),
    h(
      'p',
      { class: 'rail-foot' },
      'Everything is captured, stored and understood on this device. You can pause, exclude or delete at any time.',
    ),
  );
}

function stepBody(step: number, status: TwinStatus): HTMLElement {
  const content = step === 1 ? welcome() : step === 2 ? permissions(status) : step === 3 ? devices(status) : finish(status);
  return h(
    'div',
    { class: 'setup-step', 'data-testid': 'setup-step', 'data-step': String(step) },
    h('span', { class: 'mono small muted' }, `Step ${step} of 4`),
    h('h1', { class: 'setup-title' }, TITLES[step - 1] ?? ''),
    ...content,
  );
}

function welcome(): Child[] {
  return [
    h('div', { class: 'companion-stage' }, twinCompanion()),
    h('p', { class: 'lede' }, 'Your twin learns from the shape of your work, not its contents.'),
    h(
      'ul',
      { class: 'promises' },
      h('li', null, 'Raw data stays on this device.'),
      h('li', null, 'You choose what is watched.'),
      h('li', null, 'Nothing runs until you say so.'),
    ),
  ];
}

function permissions(status: TwinStatus): Child[] {
  const config = status.config;
  return [
    h('p', { class: 'lede' }, "It learns from the shape of your work, not its contents. Grant only what you're comfortable with."),
    h(
      'div',
      { class: 'setup-two' },
      h(
        'div',
        { class: 'perm-list' },
        permRow('App names', 'required', 'Recorded from the active app. On macOS, the first capture asks for Automation permission.', chip('Always on', 'teal')),
        permRow(
          'Browsers',
          'off by default',
          browserCaptureNote(status.browserCaptureSupported),
          toggleRow({
            testid: 'setup-browsers',
            label: 'Watch browsers',
            checked: config.watchBrowsers,
            onChange: checked => void saveConfig('setup-browsers', { watchBrowsers: checked }),
          }),
        ),
        permRow('Screenshots', 'not in this version', 'This version does not take screenshots.', chip('Not in this version')),
        permRow('Key contents', 'never recorded', 'The twin does not record what you type.', chip('Never recorded')),
      ),
      h(
        'aside',
        { class: 'never-panel', 'aria-labelledby': 'never-title' },
        h('h2', { class: 'panel-title', id: 'never-title' }, 'Never recorded'),
        h(
          'ul',
          { class: 'never-list' },
          ...['Which keys you press', 'Password and secure fields', 'Web pages in private and incognito windows', 'Apps you exclude'].map(item =>
            h('li', null, item),
          ),
        ),
        exclusionEditor('exclusions:setup', config.excludedApps, 'setup-exclusions', next =>
          void saveConfig('exclusions:setup', { excludedApps: next }),
        ),
      ),
    ),
  ];
}

function permRow(name: string, tag: string, description: string, control: Child): HTMLElement {
  return h(
    'div',
    { class: 'perm-row' },
    h(
      'div',
      { class: 'perm-text' },
      h('div', { class: 'perm-title' }, h('span', { class: 'perm-name' }, name), h('span', { class: 'mono small muted' }, tag)),
      h('p', { class: 'muted small' }, description),
    ),
    h('div', { class: 'perm-control' }, control),
  );
}

function devices(status: TwinStatus): Child[] {
  const hardware = state.setup.hardware;
  const plan = state.setup.plan;
  const parts: Child[] = [
    h('p', { class: 'lede' }, 'companyOS picks models that fit this device. Nothing downloads until you install one.'),
  ];
  if (hardware) parts.push(h('p', { class: 'mono small hw-line', 'data-testid': 'setup-hardware' }, hardwareLine(hardware)));
  if (state.setup.loading && !plan) parts.push(h('p', { class: 'muted' }, 'Checking this device…'));
  if (state.setup.error) {
    parts.push(
      h(
        'div',
        { class: 'box box-warn' },
        h('span', { class: 'box-body' }, state.setup.error),
        button('Try again', { testid: 'setup-plan-retry', onClick: retryPlan }, 'btn-small'),
      ),
    );
  }
  if (plan) {
    if (plan.warnings.length > 0) {
      parts.push(h('ul', { class: 'warnings' }, ...plan.warnings.map(warning => h('li', null, warning))));
    }
    if (plan.chat) {
      parts.push(modelCard('chat', plan.chat.spec, plan.chat, status));
    } else {
      parts.push(
        h(
          'div',
          { class: 'box box-warn', 'data-testid': 'setup-no-chat' },
          h('span', { class: 'box-body' }, 'No chat model fits this device. The twin will use simple rule-based labels until you install one.'),
        ),
      );
    }
    parts.push(modelCard('embedding', plan.embedding, undefined, status));
    parts.push(h('div', { class: 'actions' }, installRecommendedButton(plan, status)));
    parts.push(alternativesBlock(plan, status));
  }
  return parts;
}

function hardwareLine(hardware: HardwareProfile): string {
  const cpu = hardware.platform === 'darwin' && hardware.arch === 'arm64' ? 'Apple silicon' : hardware.cpuModel || hardware.arch;
  const memory = `${formatBytes(hardware.memoryBytes)}${hardware.unifiedMemory ? ' unified memory' : ' memory'}`;
  return [cpu, memory, `${hardware.cpuCores} cores`, `${formatBytes(hardware.freeDiskBytes)} free`].join(' · ');
}

function needsInstall(status: TwinStatus, modelId: string): boolean {
  const current = modelState(status, modelId);
  return current === 'not_installed' || current === 'cancelled' || current === 'failed';
}

function modelCard(kind: 'chat' | 'embedding', spec: ModelSpec, fit: ModelFit | undefined, status: TwinStatus): HTMLElement {
  const current = modelState(status, spec.id);
  const downloading = current === 'downloading';
  const installKey = `install:${spec.id}`;
  return h(
    'article',
    {
      class: 'model-card',
      'data-testid': kind === 'chat' ? 'setup-plan-chat' : 'setup-plan-embedding',
      'data-model-id': spec.id,
      'data-state': current,
    },
    h(
      'div',
      { class: 'model-head' },
      h(
        'div',
        null,
        h('span', { class: 'eyebrow' }, kind === 'chat' ? 'Chat model' : 'Embedding model'),
        h('h3', { class: 'model-name' }, spec.name),
      ),
      h('span', { class: 'model-status mono small', 'data-label-model': spec.id }, modelStateLabel(status, spec.id)),
    ),
    h('p', { class: 'mono small muted' }, `${spec.params} · ${spec.quantization} · ${formatBytes(spec.sizeBytes)}`),
    kind === 'chat' && fit
      ? h('p', { class: 'model-fit' }, h('strong', null, 'Fits your device. '), fit.reason)
      : h('p', { class: 'muted small' }, spec.summary),
    h('dl', { class: 'facts' }, fact('Licence', spec.license), fact('Source', 'huggingface.co')),
    downloading
      ? progressBar(modelFraction(status, spec.id), {
          'data-testid': 'download-progress',
          'data-model-id': spec.id,
          'data-progress-model': spec.id,
        })
      : undefined,
    h(
      'div',
      { class: 'model-actions' },
      downloading
        ? button('Cancel', {
            variant: 'secondary',
            testid: 'cancel-download',
            onClick: () => void call(`cancel:${spec.id}`, twin => twin.cancelDownload(spec.id)),
          })
        : undefined,
      current === 'not_installed' || current === 'cancelled' || current === 'failed'
        ? button(current === 'not_installed' ? 'Install' : 'Retry install', {
            variant: 'secondary',
            testid: 'install-model',
            disabled: pending(installKey),
            onClick: () => void call(installKey, twin => twin.installModel(spec.id)),
          })
        : undefined,
    ),
  );
}

function installRecommendedButton(plan: SetupPlan, status: TwinStatus): HTMLElement {
  const ids = [plan.chat?.spec.id, plan.embedding.id].filter((id): id is string => id !== undefined);
  const pendingIds = (current: TwinStatus): string[] => ids.filter(id => needsInstall(current, id));
  return button('Install recommended', {
    variant: 'primary',
    testid: 'setup-install-recommended',
    disabled: pendingIds(status).length === 0 || pending('install-recommended'),
    onClick: () =>
      void call('install-recommended', async twin => {
        // One after the other, so the chat model finishes before the embedding model starts.
        for (const id of pendingIds(state.status ?? status)) {
          await twin.installModel(id);
        }
      }),
  });
}

function alternativesBlock(plan: SetupPlan, status: TwinStatus): HTMLElement {
  const open = state.altOpen;
  return h(
    'div',
    { class: 'alternatives' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-link',
        'aria-expanded': String(open),
        'data-testid': 'setup-alternatives-toggle',
        onclick: () => {
          state.altOpen = !open;
          requestRender();
        },
      },
      open ? 'Hide other models' : 'Choose a different model',
    ),
    open
      ? h(
          'ul',
          { class: 'alt-list', 'data-testid': 'setup-alternatives' },
          ...plan.alternatives.map(fit => alternativeRow(fit, plan, status)),
        )
      : undefined,
  );
}

function alternativeRow(fit: ModelFit, plan: SetupPlan, status: TwinStatus): HTMLElement {
  const spec = fit.spec;
  const current = modelState(status, spec.id);
  const recommended = plan.chat?.spec.id === spec.id;
  let action: Child;
  if (recommended) action = chip('Recommended above', 'teal');
  else if (current === 'installed') action = chip('Installed', 'teal');
  else if (current === 'downloading') action = chip('Downloading');
  else {
    action = button('Install', {
      variant: 'secondary',
      testid: 'install-alternative',
      disabled: fit.fit === 'too_large' || pending(`install:${spec.id}`),
      onClick: () => void call(`install:${spec.id}`, twin => twin.installModel(spec.id)),
    }, 'btn-small');
  }
  return h(
    'li',
    { class: 'alt-row', 'data-model-id': spec.id, 'data-fit': fit.fit },
    h(
      'div',
      { class: 'alt-main' },
      h('span', { class: 'mono' }, spec.name),
      h('span', { class: 'muted small' }, `${spec.params} · ${spec.quantization} · ${formatBytes(spec.sizeBytes)}`),
    ),
    h('span', { class: `fit fit-${fit.fit}` }, fitLabel(fit.fit)),
    action,
  );
}

function finish(status: TwinStatus): Child[] {
  const captured = status.capture.state;
  const captureValue = captured === 'paused' ? 'paused' : captured === 'unsupported' ? 'not available' : 'on';
  return [
    h('p', { class: 'lede' }, 'The twin is ready to start. Nothing runs until you raise an automation.'),
    h(
      'ul',
      { class: 'summary-list' },
      summaryRow('Encryption key', 'Held by the OS keychain'),
      summaryRow('Models installed', String(status.config.installedModels.length)),
      summaryRow('Capture', captureValue),
    ),
  ];
}

function summaryRow(label: string, value: string): HTMLElement {
  return h('li', { class: 'summary-row' }, h('span', { class: 'muted' }, label), h('span', { class: 'mono' }, value));
}

function footer(step: number, status: TwinStatus): HTMLElement {
  const completed = status.config.setupCompleted;
  const left: Child[] = [button('Back', { testid: 'setup-back', disabled: step === 1, onClick: () => goStep(step - 1) })];
  if (completed) left.push(button('Close setup', { variant: 'ghost', testid: 'setup-close', onClick: closeSetup }));

  if (step === 4) {
    return h(
      'footer',
      { class: 'setup-foot' },
      h('div', { class: 'foot-left' }, ...left),
      h(
        'div',
        { class: 'foot-right' },
        button('Start observing', {
          variant: 'primary',
          testid: 'setup-start-observing',
          disabled: pending('start'),
          onClick: () => void startObserving(),
        }),
      ),
    );
  }

  const hasPlan = state.setup.plan !== undefined;
  const noChat = hasPlan && state.setup.plan?.chat === undefined;
  const right: Child[] = [];
  if (step === 2) right.push(h('span', { class: 'muted small' }, 'You can change these later in Settings.'));
  if (step === 3) {
    right.push(h('span', { class: 'muted small' }, 'You can install a model later in Settings.'));
    right.push(button('Skip for now', { variant: 'ghost', testid: 'setup-skip', onClick: () => goStep(4) }));
  }
  right.push(
    button(step === 3 && noChat ? 'Continue without a model' : 'Continue', {
      variant: 'primary',
      testid: 'setup-next',
      onClick: () => goStep(step + 1),
    }),
  );
  return h('footer', { class: 'setup-foot' }, h('div', { class: 'foot-left' }, ...left), h('div', { class: 'foot-right' }, ...right));
}
