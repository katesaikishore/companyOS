import type { TwinConfig, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, exclusionEditor, panel, panelHead, toggleRow } from '../components/ui.js';
import { browserCaptureNote } from '../labels.js';
import { formatBytes } from '../format.js';
import { act, bridge, confirmDeleteAll, pending, saveConfig, setNotice, state } from '../store.js';
import { openSetup } from './setup.js';

type Theme = TwinConfig['theme'];

const THEMES: Array<{ value: Theme; label: string; testid: string }> = [
  { value: 'system', label: 'System', testid: 'settings-theme-system' },
  { value: 'light', label: 'Light', testid: 'settings-theme-light' },
  { value: 'dark', label: 'Dark', testid: 'settings-theme-dark' },
];

export function settingsView(status: TwinStatus): HTMLElement {
  const config = status.config;
  return h(
    'div',
    { class: 'stack settings', 'data-testid': 'view-settings' },
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        { class: 'page-head-text' },
        h('h1', { class: 'page-title' }, 'Settings'),
        h('p', { class: 'page-sub' }, 'Choose what the twin may watch, what it may run, and what stays on this device.'),
      ),
    ),
    appearancePanel(config.theme),
    capturePanel(config.watchBrowsers, config.excludedApps, status.browserCaptureSupported),
    automationsPanel(config),
    openMausBotPanel(config),
    modelsPanel(status),
    setupPanel(),
    dataPanel(),
  );
}

function openMausBotPanel(config: TwinConfig): HTMLElement {
  const key = 'openmausbot-settings';
  const command = h('input', {
    class: 'input',
    type: 'text',
    maxlength: 512,
    autocomplete: 'off',
    spellcheck: false,
    value: config.openMausBotCommand,
    'aria-label': 'OpenMausBot CLI executable',
    'data-testid': 'settings-openmausbot-command',
    oninput: () => state.dirty.add(key),
  });
  const target = h('input', {
    class: 'input',
    type: 'text',
    maxlength: 120,
    autocomplete: 'off',
    spellcheck: false,
    value: config.openMausBotTarget,
    placeholder: 'Existing lead bot or room',
    'aria-label': 'OpenMausBot lead bot or room',
    'data-testid': 'settings-openmausbot-target',
    oninput: () => state.dirty.add(key),
  });
  return panel({ testid: 'settings-openmausbot', labelledBy: 'openmausbot-title' },
    panelHead('OpenMausBot agents', 'Delegate a task from any accepted routine to its existing agent harness.', 'openmausbot-title'),
    h('p', { class: 'muted small' }, 'Install the CLI with `npm install -g openmausbot` (Node.js 24+) and configure its models, lead bot or room, and connected apps in OpenMausBot. companyOS starts one job and waits for its nested agent tasks.'),
    h('label', { class: 'field-row' },
      h('span', { class: 'toggle-label' }, 'CLI executable'),
      command,
    ),
    h('label', { class: 'field-row' },
      h('span', { class: 'toggle-label' }, 'Lead bot or room'),
      target,
    ),
    h('p', { class: 'muted small' }, 'A handoff sends the task brief, routine name, app sequence and estimated cadence after a native confirmation. The prompt excludes activity history, screenshots, window contents and companyOS credentials. OpenMausBot may use its own configured credentials and permissions, outside companyOS autonomy controls. Handoffs are kept on this device for 90 days, or until you delete everything.'),
    h('div', { class: 'actions' }, button('Save OpenMausBot settings', {
      testid: 'settings-openmausbot-save',
      disabled: pending(key),
      onClick: () => {
        state.dirty.delete(key);
        void act(key, async () => {
          await bridge().updateConfig({ openMausBotCommand: command.value.trim(), openMausBotTarget: target.value.trim() });
        });
      },
    })),
  );
}

function appearancePanel(current: Theme): HTMLElement {
  return panel({ testid: 'settings-appearance', labelledBy: 'appearance-title' },
    panelHead('Appearance', undefined, 'appearance-title'),
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Theme' },
      ...THEMES.map(option =>
        h(
          'button',
          {
            type: 'button',
            class: option.value === current ? 'seg is-on' : 'seg',
            'aria-pressed': String(option.value === current),
            'data-testid': option.testid,
            onclick: () => void saveConfig('theme', { theme: option.value }),
          },
          option.label,
        ),
      ),
    ),
  );
}

function capturePanel(watchBrowsers: boolean, excluded: readonly string[], bridgeSupported: boolean): HTMLElement {
  return panel({ testid: 'settings-capture', labelledBy: 'capture-title' },
    panelHead('Capture', undefined, 'capture-title'),
    toggleRow({
      testid: 'settings-browsers',
      label: 'Watch browsers',
      note: `${browserCaptureNote(bridgeSupported)} Off by default.`,
      checked: watchBrowsers,
      onChange: checked => void saveConfig('browsers', { watchBrowsers: checked }),
    }),
    h('h3', { class: 'eyebrow' }, 'Excluded apps'),
    h(
      'p',
      { class: 'muted small' },
      'The twin forgets anything it recorded from an excluded app and never records it again. Handoffs you already sent still name the app until they expire or you delete everything.',
    ),
    exclusionEditor('exclusions:settings', excluded, 'settings-exclusions', next =>
      void saveConfig('exclusions:settings', { excludedApps: next }),
    ),
  );
}

function automationsPanel(config: TwinConfig): HTMLElement {
  const maxLevel = config.maxAutonomyLevel;
  const select = h(
    'select',
    {
      class: 'select',
      'data-testid': 'settings-max-level',
      'aria-label': 'Highest level the twin may reach',
      onchange: () => {
        const value = Number(select.value);
        if (value === 3 || value === 4) void saveConfig('max-level', { maxAutonomyLevel: value });
      },
    },
    h('option', { value: '3' }, 'Level 3 · Run with you'),
    h('option', { value: '4' }, 'Level 4 · On its own'),
  );
  select.value = String(Math.max(3, Math.min(4, maxLevel)));
  return panel({ testid: 'settings-automations', labelledBy: 'automations-title' },
    panelHead('Automations', undefined, 'automations-title'),
    toggleRow({
      testid: 'settings-automations-toggle',
      label: 'Automations on',
      note: 'When off, no automation runs, on any level. It does not stop tasks you send to OpenMausBot.',
      checked: config.automationsEnabled,
      onChange: checked => void saveConfig('automations', { automationsEnabled: checked }),
    }),
    toggleRow({
      testid: 'settings-unattended',
      label: 'Allow unattended runs at level 4 (local and reversible steps only)',
      checked: config.allowUnattended,
      onChange: checked => void saveConfig('unattended', { allowUnattended: checked }),
    }),
    h(
      'div',
      { class: 'field-row' },
      h('span', { class: 'toggle-label' }, 'Highest level the twin may reach'),
      select,
    ),
  );
}

function modelsPanel(status: TwinStatus): HTMLElement {
  const installed = status.config.installedModels;
  return panel({ testid: 'settings-models', labelledBy: 'models-title' },
    panelHead('Models', undefined, 'models-title'),
    installed.length === 0
      ? h('p', { class: 'muted' }, 'No models installed. The twin uses simple rule-based labels until you install one.')
      : h(
          'div',
          { class: 'model-list' },
          ...installed.map(model =>
            h(
              'div',
              { class: 'model-row', 'data-model-id': model.id },
              h(
                'div',
                { class: 'model-main' },
                h('span', { class: 'mono' }, model.id),
                h('span', { class: 'muted small' }, `${formatBytes(model.bytes)} · checksum verified · ${model.sha256.slice(0, 12)}…`),
              ),
              button('Remove', {
                testid: 'settings-model-remove',
                disabled: pending(`remove:${model.id}`),
                onClick: () => void act(`remove:${model.id}`, () => bridge().removeModel(model.id)),
              }),
            ),
          ),
        ),
    h(
      'div',
      { class: 'actions' },
      button('Choose models again', { onClick: () => void openSetup(3) }),
    ),
  );
}

function setupPanel(): HTMLElement {
  return panel({ testid: 'settings-setup', labelledBy: 'setup-title' },
    panelHead('Setup', 'Walk through the first-run steps again.', 'setup-title'),
    h('div', { class: 'actions' }, button('Run setup again', { onClick: () => void openSetup(1) })),
  );
}

function dataPanel(): HTMLElement {
  const exportKey = 'export';
  return panel({ testid: 'settings-data', labelledBy: 'data-title' },
    panelHead('Data', 'Export writes an unencrypted file. Keep it somewhere private.', 'data-title'),
    h(
      'div',
      { class: 'actions' },
      button('Export my data', {
        testid: 'settings-export',
        disabled: pending(exportKey),
        onClick: () =>
          void act(exportKey, async () => {
            const path = await bridge().exportData();
            if (path) setNotice(`Saved to ${path}`, 'info');
          }),
      }),
      button('Delete everything', { variant: 'danger-outline', testid: 'settings-delete', onClick: confirmDeleteAll }),
    ),
  );
}
