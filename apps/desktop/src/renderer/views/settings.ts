import type { TwinConfig, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, exclusionEditor, panel, panelHead, toggleRow } from '../components/ui.js';
import { formatBytes } from '../format.js';
import { act, bridge, confirmDeleteAll, pending, saveConfig, setNotice } from '../store.js';
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
    capturePanel(config.watchBrowsers, config.excludedApps),
    automationsPanel(config),
    modelsPanel(status),
    setupPanel(),
    dataPanel(),
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

function capturePanel(watchBrowsers: boolean, excluded: readonly string[]): HTMLElement {
  return panel({ testid: 'settings-capture', labelledBy: 'capture-title' },
    panelHead('Capture', undefined, 'capture-title'),
    toggleRow({
      testid: 'settings-browsers',
      label: 'Watch browsers',
      note: 'Only the app name is recorded, not the page or the window. Private windows cannot be told apart yet. Off by default.',
      checked: watchBrowsers,
      onChange: checked => void saveConfig('browsers', { watchBrowsers: checked }),
    }),
    h('h3', { class: 'eyebrow' }, 'Excluded apps'),
    h(
      'p',
      { class: 'muted small' },
      'The twin forgets anything recorded from an excluded app, and never records it again.',
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
      note: 'When off, no automation runs, on any level.',
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
