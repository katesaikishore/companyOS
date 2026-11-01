import type { TwinConfig, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, chip, exclusionEditor, toggleRow } from '../components/ui.js';
import { formatBytes } from '../format.js';
import { layaState, layaStateLabel } from '../labels.js';
import { act, bridge, confirmDeleteAll, pending, saveConfig, setNotice, state } from '../store.js';
import { openSetup } from './setup.js';

type Theme = TwinConfig['theme'];
type InstalledModel = TwinStatus['config']['installedModels'][number];
type SectionId = 'capture' | 'automations' | 'models' | 'appearance' | 'data';

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'capture', label: 'Capture' },
  { id: 'automations', label: 'Automations' },
  { id: 'models', label: 'Models' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Your data' },
];

const THEMES: Array<{ value: Theme; label: string; testid: string }> = [
  { value: 'system', label: 'System', testid: 'settings-theme-system' },
  { value: 'light', label: 'Light', testid: 'settings-theme-light' },
  { value: 'dark', label: 'Dark', testid: 'settings-theme-dark' },
];

const LEVELS: Array<{ value: 3 | 4; label: string; note?: string }> = [
  { value: 3, label: 'Level 3 · Run with you', note: 'One click per run' },
  { value: 4, label: 'Level 4 · On its own', note: 'Only after the gate passes' },
];

/** A section counts as the one being read once its top has moved above this line, in pixels. */
const READING_LINE_PX = 120;

let activeSection: SectionId = 'capture';
let followingScroll = false;

export function settingsView(status: TwinStatus): HTMLElement {
  const config = status.config;
  followScroll();
  return h(
    'div',
    { class: 'stack settings settings-view', 'data-testid': 'view-settings' },
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
    h(
      'div',
      { class: 'settings-layout' },
      sectionNav(),
      h(
        'div',
        { class: 'settings-card' },
        capturePanel(config.watchBrowsers, config.excludedApps, config.idleGapMs),
        automationsPanel(config),
        modelsPanel(status),
        appearancePanel(config.theme),
        dataPanel(),
      ),
    ),
  );
}

function sectionDomId(id: SectionId): string {
  return `settings-${id}`;
}

function sectionNav(): HTMLElement {
  return h(
    'nav',
    { class: 'settings-nav', 'aria-label': 'Settings sections' },
    ...SECTIONS.map(section =>
      h(
        'button',
        {
          type: 'button',
          class: 'settings-nav-item',
          'data-section': section.id,
          'aria-current': section.id === activeSection ? 'true' : undefined,
          onclick: () => {
            activeSection = section.id;
            markNav();
            document.getElementById(sectionDomId(section.id))?.scrollIntoView();
          },
        },
        section.label,
      ),
    ),
  );
}

function markNav(): void {
  document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach(item => {
    if (item.dataset.section === activeSection) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  });
}

/**
 * Keeps the nav's current section in step with the page as it scrolls. Installed once, because the view is rebuilt on
 * every refresh and each rebuild would otherwise add another listener.
 */
function followScroll(): void {
  if (followingScroll) return;
  followingScroll = true;
  document.addEventListener(
    'scroll',
    () => {
      let next: SectionId | undefined;
      for (const section of SECTIONS) {
        const el = document.getElementById(sectionDomId(section.id));
        if (el && el.getBoundingClientRect().top <= READING_LINE_PX) next = section.id;
      }
      if (next && next !== activeSection) {
        activeSection = next;
        markNav();
      }
    },
    { capture: true, passive: true },
  );
}

interface SectionOptions {
  id: SectionId;
  testid: string;
  title: string;
  note?: string;
  /** Lays the children out as one column with no dividers, for forms. */
  stack?: boolean;
}

function sectionCard(options: SectionOptions, ...children: Child[]): HTMLElement {
  const domId = sectionDomId(options.id);
  return h(
    'section',
    { class: 'settings-section', id: domId, 'data-testid': options.testid, 'aria-labelledby': `${domId}-title` },
    h(
      'header',
      { class: 'settings-head' },
      h('h2', { class: 'settings-title', id: `${domId}-title` }, options.title),
      options.note ? h('p', { class: 'settings-note' }, options.note) : undefined,
    ),
    h('div', { class: options.stack ? 'settings-body is-stack' : 'settings-body' }, ...children),
  );
}

function row(...children: Child[]): HTMLElement {
  return h('div', { class: 'settings-row' }, ...children);
}

function block(...children: Child[]): HTMLElement {
  return h('div', { class: 'settings-row is-block' }, ...children);
}

function textBlock(title: string, note: string): HTMLElement {
  return h(
    'div',
    { class: 'settings-text' },
    h('span', { class: 'settings-row-title' }, title),
    h('span', { class: 'settings-row-note' }, note),
  );
}

function appearancePanel(current: Theme): HTMLElement {
  return sectionCard(
    { id: 'appearance', testid: 'settings-appearance', title: 'Appearance' },
    block(
      h(
        'div',
        { class: 'settings-themes', role: 'group', 'aria-label': 'Theme' },
        ...THEMES.map(option =>
          h(
            'button',
            {
              type: 'button',
              class: option.value === current ? 'settings-theme is-on' : 'settings-theme',
              'aria-pressed': String(option.value === current),
              'data-testid': option.testid,
              onclick: () => void saveConfig('theme', { theme: option.value }),
            },
            h('span', { class: `settings-theme-swatch is-${option.value}`, 'aria-hidden': 'true' }),
            h('span', { class: 'settings-theme-label' }, option.label),
          ),
        ),
      ),
    ),
  );
}

function capturePanel(watchBrowsers: boolean, excluded: readonly string[], idleGapMs: number): HTMLElement {
  return sectionCard(
    { id: 'capture', testid: 'settings-capture', title: 'Capture', note: 'App names and timing only. No titles, keystrokes or screenshots.' },
    row(
      toggleRow({
        testid: 'settings-browsers',
        label: 'Watch browsers',
        note: 'Off by default. Browser names are recorded like app names.',
        checked: watchBrowsers,
        onChange: checked => void saveConfig('browsers', { watchBrowsers: checked }),
      }),
    ),
    block(
      textBlock(
        'Excluded apps',
        'The twin forgets anything it recorded from an excluded app and never records it again. Handoff records saved by an earlier version may still name the app until they are removed after 90 days, or until you delete everything.',
      ),
      exclusionEditor('exclusions:settings', excluded, 'settings-exclusions', next =>
        void saveConfig('exclusions:settings', { excludedApps: next }),
      ),
    ),
    row(
      textBlock('Idle gap', 'A pause this long ends a work segment. Allowed 1 to 60 minutes.'),
      h('span', { class: 'settings-value mono' }, `${Math.round(idleGapMs / 60_000)} min`),
    ),
  );
}

function automationsPanel(config: TwinConfig): HTMLElement {
  const current = Math.max(3, Math.min(4, config.maxAutonomyLevel));
  return sectionCard(
    { id: 'automations', testid: 'settings-automations', title: 'Automations' },
    row(
      toggleRow({
        testid: 'settings-automations-toggle',
        label: 'Automations on',
        note: 'When off, no automation runs, on any level.',
        checked: config.automationsEnabled,
        onChange: checked => void saveConfig('automations', { automationsEnabled: checked }),
      }),
    ),
    block(
      h('span', { class: 'settings-row-title' }, 'Highest level the twin may reach'),
      h(
        'div',
        {
          class: 'settings-levels',
          role: 'group',
          'aria-label': 'Highest level the twin may reach',
          'data-testid': 'settings-max-level',
        },
        ...LEVELS.map(level => levelButton(level, current)),
      ),
    ),
    row(
      toggleRow({
        testid: 'settings-unattended',
        label: 'Allow unattended runs at level 4',
        note: 'Local and reversible steps only. Needs the highest level set to 4.',
        checked: config.allowUnattended,
        onChange: checked => void saveConfig('unattended', { allowUnattended: checked }),
      }),
    ),
    agentDesktopBlock(config.agentDesktopPath),
  );
}

/** The optional agent-desktop program for focus and key steps. Blank keeps the built-in adapters. */
function agentDesktopBlock(path: string): HTMLElement {
  const key = 'agent-desktop-settings';
  const program = h('input', {
    class: 'input mono',
    type: 'text',
    maxlength: 512,
    autocomplete: 'off',
    spellcheck: false,
    value: path,
    placeholder: 'Leave empty to use the built-in adapters',
    'aria-label': 'Agent-desktop program path',
    'data-testid': 'settings-agent-desktop-path',
    oninput: () => state.dirty.add(key),
  });
  return block(
    h('label', { class: 'settings-field' }, h('span', { class: 'settings-field-label' }, 'Agent-desktop program'), program),
    h(
      'p',
      { class: 'settings-note' },
      'Optional, and not bundled with companyOS. With a path set, the program counts an app\'s windows before a focus on every platform, and it presses keys on macOS and Windows. A focus is blocked, and so is a key press on macOS and Windows, when the path is not an existing file, and the run says why. On Linux, focus and key presses use the built-in adapters. The program knows an app by its process name, and companyOS records the window class, so for an app whose two names differ the program cannot count its windows, and a focus is not refused for having several.',
    ),
    h(
      'div',
      { class: 'actions' },
      button('Save program path', {
        variant: 'primary',
        testid: 'settings-agent-desktop-save',
        disabled: pending(key),
        onClick: () => {
          state.dirty.delete(key);
          void act(key, async () => {
            await bridge().updateConfig({ agentDesktopPath: program.value.trim() });
          });
        },
      }),
    ),
  );
}

function levelButton(level: (typeof LEVELS)[number], current: number): HTMLElement {
  const on = level.value === current;
  return h(
    'button',
    {
      type: 'button',
      class: on ? 'settings-level is-on' : 'settings-level',
      'aria-pressed': String(on),
      'data-testid': `settings-max-level-${level.value}`,
      onclick: () => {
        if (!on) void saveConfig('max-level', { maxAutonomyLevel: level.value });
      },
    },
    h('span', { class: 'settings-level-label' }, level.label),
    level.note ? h('span', { class: 'settings-level-note' }, level.note) : undefined,
  );
}

function modelsPanel(status: TwinStatus): HTMLElement {
  const installed = status.config.installedModels;
  return sectionCard(
    {
      id: 'models',
      testid: 'settings-models',
      title: 'Models',
      note: 'Open-weight models, downloaded and checked against pinned SHA-256 digests.',
    },
    installed.length === 0
      ? row(h('p', { class: 'muted small' }, 'No models installed. The twin uses simple rule-based labels until you install one.'))
      : installed.map(model => modelRow(model)),
    layaRow(status.laya),
    row(
      h(
        'div',
        { class: 'actions', 'data-testid': 'settings-setup' },
        button('Choose models again', { onClick: () => void openSetup(3) }),
        button('Decision model', { testid: 'settings-laya-setup', onClick: () => void openSetup(4) }),
        button('Run setup again', { onClick: () => void openSetup(1) }),
      ),
    ),
  );
}

/** The optional decision model. Its row is always shown, so a partial download is never hidden from the person who owns the disk. */
function layaRow(laya: TwinStatus['laya']): HTMLElement {
  const current = layaState(laya);
  const removable = current === 'installed' || laya.hasPartial;
  return h(
    'div',
    { class: 'settings-row settings-model', 'data-testid': 'settings-laya', 'data-state': current },
    h(
      'div',
      { class: 'settings-model-main' },
      h('span', { class: 'mono settings-model-id' }, 'laya-onnx (decision model, not used yet)'),
      h('span', { class: 'settings-row-note mono', 'data-label-laya': 'true' }, layaStateLabel(laya)),
    ),
    current === 'downloading'
      ? button('Cancel', { testid: 'settings-laya-cancel', onClick: () => void act('laya-cancel', () => bridge().cancelLaya()) })
      : undefined,
    removable && current !== 'downloading'
      ? button(current === 'installed' ? 'Remove' : 'Delete partial download', {
          testid: 'settings-laya-remove',
          disabled: pending('laya-remove'),
          onClick: () => void act('laya-remove', () => bridge().removeLaya()),
        })
      : undefined,
  );
}

function modelRow(model: InstalledModel): HTMLElement {
  return h(
    'div',
    { class: 'settings-row settings-model', 'data-model-id': model.id },
    h(
      'div',
      { class: 'settings-model-main' },
      h('span', { class: 'mono settings-model-id' }, model.id),
      h('span', { class: 'settings-row-note mono' }, `${formatBytes(model.bytes)} · checksum verified · ${model.sha256.slice(0, 12)}…`),
    ),
    chip('installed', 'teal'),
    button('Remove', {
      testid: 'settings-model-remove',
      disabled: pending(`remove:${model.id}`),
      onClick: () => void act(`remove:${model.id}`, () => bridge().removeModel(model.id)),
    }),
  );
}

function dataPanel(): HTMLElement {
  const exportKey = 'export';
  return sectionCard(
    {
      id: 'data',
      testid: 'settings-data',
      title: 'Your data',
      note: 'Encrypted on this device with AES-256-GCM. The key is held by your OS keychain.',
    },
    row(
      textBlock('Export my data', 'Export writes an unencrypted file. Keep it somewhere private.'),
      button('Export my data', {
        testid: 'settings-export',
        disabled: pending(exportKey),
        onClick: () =>
          void act(exportKey, async () => {
            const path = await bridge().exportData();
            if (path) setNotice(`Saved to ${path}`, 'info');
          }),
      }),
    ),
    row(
      textBlock('Delete everything', 'Removes every record, automation and setting. This cannot be undone.'),
      button('Delete everything', { variant: 'danger-outline', testid: 'settings-delete', onClick: confirmDeleteAll }),
    ),
  );
}
