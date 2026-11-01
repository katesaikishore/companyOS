import type { HardwareProfile, LayaBundleView, ModelFit, ModelSpec, SetupPlan, TwinStatus } from '@companyos/twin-core';
import { SPEECH_MODEL_ID } from '../speech-model.js';
import { h, type Child } from '../dom.js';
import { twinCompanion } from '../components/companion.js';
import { button, chip, exclusionEditor, fact, logo, progressBar, toggleRow } from '../components/ui.js';
import { formatBytes, formatDecimalBytes } from '../format.js';
import { browserCaptureNote, fitLabel, layaFraction, layaState, layaStateLabel, modelFraction, modelState, modelStateLabel } from '../labels.js';
import { act, bridge, call, errorText, go, pending, requestRender, saveConfig, state } from '../store.js';

const TITLES = ['Welcome', 'What companyOS can see', 'Recall', 'Your device and models', 'Decision model (optional)', 'Start observing'];
const LAST_STEP = TITLES.length;

/** Opens the wizard at a step. The step-3 device check runs when that step is shown. */
export function openSetup(step: number): void {
  state.wizardForced = true;
  goStep(step);
}

export function goStep(step: number): void {
  state.wizardStep = Math.min(LAST_STEP, Math.max(1, step));
  state.altOpen = false;
  if (state.wizardStep === 4) void loadPlan();
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
      'Your activity is captured, stored and analyzed on this device. Nothing leaves the device except model and update requests, which carry no activity. You can pause, exclude or delete at any time.',
    ),
  );
}

function stepBody(step: number, status: TwinStatus): HTMLElement {
  const content = stepContent(step, status);
  return h(
    'div',
    { class: 'setup-step', 'data-testid': 'setup-step', 'data-step': String(step) },
    h('span', { class: 'mono small muted' }, `Step ${step} of ${LAST_STEP}`),
    h('h1', { class: 'setup-title' }, TITLES[step - 1] ?? ''),
    ...content,
  );
}

function stepContent(step: number, status: TwinStatus): Child[] {
  switch (step) {
    case 1:
      return welcome();
    case 2:
      return permissions(status);
    case 3:
      return recallStep(status);
    case 4:
      return devices(status);
    case 5:
      return decisionModel(status);
    default:
      return finish(status);
  }
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
      h('li', null, 'Nothing runs unless you start it, or you have turned on unattended runs for an automation at level 4.'),
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
        config.screenCaptureEnabled
          ? permRow('Screen text', 'on', 'Screen text is being recorded. The Recall step and Settings change it.', chip('On', 'teal'))
          : permRow('Screenshots', 'not in this version', 'This version does not take screenshots.', chip('Not in this version')),
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

/**
 * The Recall step: screen text and microphone text. Both start off, and each switch saves at once, as the browser
 * switch does. Nothing is recorded until the person turns one on here or in Settings.
 */
function recallStep(status: TwinStatus): Child[] {
  const config = status.config;
  // Microphone text needs the speech model, which is installed in Settings. The switch stays off until it is.
  const speechInstalled = config.installedModels.some(model => model.id === SPEECH_MODEL_ID);
  return [
    h(
      'p',
      { class: 'lede' },
      'Recall searches text the twin reads on the screen or hears on the microphone. Both are off, and nothing is recorded until you turn one on.',
    ),
    h(
      'div',
      { class: 'perm-list' },
      permRow(
        'Screen text',
        'off by default',
        `Reads the whole primary display when what is on it changes. A browser, an excluded app or a password field is skipped only when it has focus, so a window of one visible behind another app can still be read. Images are kept ${config.frameRetentionDays} days.`,
        toggleRow({
          testid: 'setup-screen',
          label: 'Read text on screen',
          checked: config.screenCaptureEnabled,
          onChange: checked => void saveConfig('setup-screen', { screenCaptureEnabled: checked }),
        }),
      ),
      permRow(
        'Microphone text',
        'off by default',
        speechInstalled
          ? 'Turns speech into text on this device. It also hears people nearby and on calls, so check the recording rules where you work.'
          : 'Needs the speech model, which you install in Settings under Screen and audio.',
        toggleRow({
          testid: 'setup-audio',
          label: 'Transcribe the microphone',
          checked: config.audioCaptureEnabled && speechInstalled,
          disabled: !speechInstalled,
          onChange: checked => void saveConfig('setup-audio', { audioCaptureEnabled: checked }),
        }),
      ),
    ),
    h('p', { class: 'muted small' }, 'You can change either later in Settings, under Screen and audio.'),
  ];
}

function permRow(name: string, tag: string, description: string, control: Child): HTMLElement {
  return h(
    'div',
    { class: 'perm-row' },
    h(
      'div',
      { class: 'perm-head' },
      h('div', { class: 'perm-title' }, h('span', { class: 'perm-name' }, name), h('span', { class: 'mono small muted' }, tag)),
      h('div', { class: 'perm-control' }, control),
    ),
    h('p', { class: 'muted small' }, description),
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
    const models: Child[] = [];
    if (plan.chat) {
      models.push(modelCard(plan.chat.spec, plan.chat, status));
    } else {
      models.push(
        h(
          'div',
          { class: 'box box-warn', 'data-testid': 'setup-no-chat' },
          h('span', { class: 'box-body' }, 'No chat model fits this device. The twin will use simple rule-based labels until you install one.'),
        ),
      );
    }
    parts.push(h('div', { class: 'model-grid' }, ...models));
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

function modelCard(spec: ModelSpec, fit: ModelFit, status: TwinStatus): HTMLElement {
  const current = modelState(status, spec.id);
  const downloading = current === 'downloading';
  const installKey = `install:${spec.id}`;
  return h(
    'article',
    {
      class: 'model-card',
      'data-testid': 'setup-plan-chat',
      'data-model-id': spec.id,
      'data-state': current,
    },
    h(
      'div',
      { class: 'model-head' },
      h(
        'div',
        null,
        h('span', { class: 'eyebrow' }, 'Chat model'),
        h('h3', { class: 'model-name' }, spec.name),
      ),
      h('span', { class: 'model-status mono small', 'data-label-model': spec.id }, modelStateLabel(status, spec.id)),
    ),
    h('p', { class: 'mono small muted' }, `${spec.params} · ${spec.quantization} · ${formatBytes(spec.sizeBytes)}`),
    h('p', { class: 'model-fit' }, h('strong', null, 'Fits your device. '), fit.reason),
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
  const ids = [plan.chat?.spec.id].filter((id): id is string => id !== undefined);
  const pendingIds = (current: TwinStatus): string[] => ids.filter(id => needsInstall(current, id));
  return button('Install recommended', {
    variant: 'primary',
    testid: 'setup-install-recommended',
    disabled: pendingIds(status).length === 0 || pending('install-recommended'),
    onClick: () =>
      void call('install-recommended', async twin => {
        // One after the other, in case the plan holds more than one model.
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
      'div',
      { class: 'actions' },
      installRecommendedButton(plan, status),
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

/**
 * The optional decision-model download (Laya). It is offered once, with its size and what it is for. Without it, or
 * until it is installed, the kind labels on suggestions come from the rules, as they always did.
 */
function decisionModel(status: TwinStatus): Child[] {
  const laya = status.laya;
  return [
    h(
      'p',
      { class: 'lede' },
      `An optional small model that answers choice, score and yes/no questions on this device. It is about ${formatDecimalBytes(laya.totalBytes)}, and the twin works without it.`,
    ),
    h('p', { class: 'muted small', 'data-testid': 'setup-laya-note' }, 'It labels a routine that includes an app companyOS does not know. Skipping it keeps the rule-based labels, which work without it.'),
    layaCard(laya),
  ];
}

function layaCard(laya: LayaBundleView): HTMLElement {
  const current = layaState(laya);
  const downloading = current === 'downloading';
  const hardware = state.setup.hardware;
  const diskNote = `Needs about ${formatDecimalBytes(laya.requiredFreeBytes)} of free disk space${
    hardware ? `. This device has ${formatDecimalBytes(hardware.freeDiskBytes)} free` : ''
  }.`;
  const startLabel = laya.hasPartial ? 'Resume download' : current === 'failed' ? 'Try again' : `Download (about ${formatDecimalBytes(laya.totalBytes)})`;
  return h(
    'article',
    { class: 'model-card', 'data-testid': 'setup-laya', 'data-state': current },
    h(
      'div',
      { class: 'model-head' },
      h('div', null, h('span', { class: 'eyebrow' }, 'Decision model'), h('h3', { class: 'model-name' }, 'Laya')),
      h('span', { class: 'model-status mono small', 'data-label-laya': 'true', 'data-testid': 'laya-status' }, layaStateLabel(laya)),
    ),
    h('p', { class: 'mono small muted' }, `ONNX · ${formatDecimalBytes(laya.totalBytes)} · 5 files`),
    h('p', { class: 'muted small' }, 'Picks between options in one pass. It does not write text or take actions, and the approval steps stay as they are.'),
    h(
      'dl',
      { class: 'facts' },
      fact('Licence', 'Apache-2.0'),
      fact('Source', `huggingface.co · ${laya.repo}`),
      fact('Checked', 'SHA-256 of each file, from a fixed commit'),
    ),
    downloading
      ? progressBar(layaFraction(laya), { 'data-testid': 'laya-progress', 'data-progress-laya': 'true' })
      : undefined,
    current === 'failed' && laya.message
      ? h('div', { class: 'box box-warn', 'data-testid': 'laya-error' }, h('span', { class: 'box-body' }, laya.message))
      : undefined,
    current === 'unsupported'
      ? h('p', { class: 'muted small', 'data-testid': 'laya-unsupported' }, 'Not available on this system. Its runtime has no build for it.')
      : h('p', { class: 'muted small' }, laya.hasPartial && !downloading
          ? 'What was downloaded is kept. Resume continues from it, or delete it.'
          : diskNote),
    h(
      'div',
      { class: 'model-actions' },
      downloading
        ? button('Cancel', { variant: 'secondary', testid: 'laya-cancel', onClick: () => void call('laya-cancel', twin => twin.cancelLaya()) })
        : undefined,
      current === 'not_installed' || current === 'cancelled' || current === 'failed'
        ? button(startLabel, {
            variant: 'secondary',
            testid: 'laya-install',
            disabled: pending('laya-install'),
            onClick: () => void call('laya-install', twin => twin.installLaya()),
          })
        : undefined,
      !downloading && (current === 'installed' || laya.hasPartial)
        ? button(current === 'installed' ? 'Remove' : 'Delete partial download', {
            variant: 'ghost',
            testid: 'laya-remove',
            disabled: pending('laya-remove'),
            onClick: () => void call('laya-remove', twin => twin.removeLaya()),
          })
        : undefined,
    ),
  );
}

function layaSummary(laya: LayaBundleView): string {
  switch (layaState(laya)) {
    case 'installed':
      return 'Installed. It labels routines with unknown apps.';
    case 'downloading':
      return 'Downloading';
    case 'unsupported':
      return 'Not available, rules are used';
    default:
      return laya.hasPartial ? 'Partly downloaded, rules are used' : 'Not installed, rules are used';
  }
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
      summaryRow('Decision model', layaSummary(status.laya)),
      summaryRow('Capture', captureValue),
      summaryRow('Screen text', status.config.screenCaptureEnabled ? 'on' : 'off'),
      summaryRow('Microphone text', status.config.audioCaptureEnabled ? 'on' : 'off'),
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

  if (step === LAST_STEP) {
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
  if (step === 4) {
    right.push(h('span', { class: 'muted small' }, 'You can install a model later in Settings.'));
    right.push(button('Skip for now', { variant: 'ghost', testid: 'setup-skip', onClick: () => goStep(5) }));
  }
  if (step === 5) {
    const layaCurrent = layaState(status.laya);
    if (layaCurrent === 'downloading') right.push(h('span', { class: 'muted small' }, 'The download keeps going if you continue.'));
    else if (layaCurrent !== 'installed') {
      right.push(h('span', { class: 'muted small' }, 'You can download it later from Settings.'));
      right.push(button('Skip, use rules', { variant: 'ghost', testid: 'setup-laya-skip', onClick: () => goStep(step + 1) }));
    }
  }
  right.push(
    button(step === 4 && noChat ? 'Continue without a model' : 'Continue', {
      variant: 'primary',
      testid: 'setup-next',
      onClick: () => goStep(step + 1),
    }),
  );
  return h('footer', { class: 'setup-foot' }, h('div', { class: 'foot-left' }, ...left), h('div', { class: 'foot-right' }, ...right));
}
