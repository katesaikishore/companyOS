import { h, mount } from './dom.js';
import { call, go, state } from './store.js';

interface Command {
  title: string;
  detail: string;
  run: () => void;
}

let palette: HTMLDialogElement | undefined;
let search: HTMLInputElement | undefined;
let results: HTMLElement | undefined;
let activeIndex = 0;

function availableCommands(): Command[] {
  const pages: Command[] = [
    { title: 'Your twin', detail: 'Open overview', run: () => go('#/overview') },
    { title: 'Recall', detail: 'Search the text the twin read or heard', run: () => go('#/recall') },
    { title: 'Suggestions', detail: 'Review routines the twin noticed', run: () => go('#/suggestions') },
    { title: 'Automations', detail: 'Review accepted routines and runs', run: () => go('#/automations') },
    { title: 'What the twin knows', detail: 'See routines, habits and declines', run: () => go('#/knows') },
    { title: 'Network ledger', detail: 'Review model downloads and network calls', run: () => go('#/ledger') },
    { title: 'Settings', detail: 'Change capture, autonomy, and appearance', run: () => go('#/settings') },
  ];

  const status = state.status;
  if (!status) return pages;
  const paused = status.capture.state === 'paused';
  const actions: Command[] = [];
  if (status.capture.state !== 'unsupported') {
    actions.push({
      title: paused ? 'Resume capture' : 'Pause capture',
      detail: 'Change whether this device records app switches',
      run: () => void call('capture', twin => twin.setPaused(!paused)),
    });
  }
  actions.push({
    title: 'Stop all automations',
    detail: 'Immediately stop runs and keep automations disabled',
    run: () => void call('stop-all', twin => twin.stopAllAutomations()),
  });
  const routines: Command[] = status.automations.map(view => ({
    title: view.automation.name,
    detail: 'Open automation details',
    run: () => go(`#/automations/${encodeURIComponent(view.automation.id)}`),
  }));
  const suggestions: Command[] = status.suggestions.map(suggestion => ({
    title: suggestion.name,
    detail: 'Review suggested routine',
    run: () => {
      state.selectedSuggestion = suggestion.routineId;
      go('#/suggestions');
    },
  }));
  return [...pages, ...actions, ...routines, ...suggestions];
}

function filteredCommands(): Command[] {
  const query = search?.value.trim().toLocaleLowerCase() ?? '';
  return availableCommands().filter(command => `${command.title} ${command.detail}`.toLocaleLowerCase().includes(query));
}

function renderResults(): void {
  if (!results) return;
  const commands = filteredCommands();
  activeIndex = Math.min(activeIndex, Math.max(0, commands.length - 1));
  if (commands.length === 0) {
    mount(results, h('p', { class: 'command-empty' }, 'No matching commands.'));
    search?.removeAttribute('aria-activedescendant');
    return;
  }

  mount(
    results,
    ...commands.map((command, index) =>
      h(
        'button',
        {
          type: 'button',
          class: index === activeIndex ? 'command-row is-active' : 'command-row',
          id: `command-option-${index}`,
          role: 'option',
          'aria-selected': String(index === activeIndex),
          onclick: () => runCommand(command),
        },
        h('span', { class: 'command-row-copy' },
          h('span', { class: 'command-title' }, command.title),
          h('span', { class: 'command-detail' }, command.detail),
        ),
        h('span', { class: 'command-return', 'aria-hidden': 'true' }, '↵'),
      ),
    ),
  );
  search?.setAttribute('aria-activedescendant', `command-option-${activeIndex}`);
}

function runCommand(command: Command): void {
  palette?.close();
  command.run();
}

function createPalette(): HTMLDialogElement {
  const input = h('input', {
    type: 'search',
    class: 'command-input',
    placeholder: 'Search pages, routines, and actions…',
    autocomplete: 'off',
    spellcheck: false,
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'true',
    'aria-label': 'Search commands',
    'aria-controls': 'command-results',
    oninput: () => {
      activeIndex = 0;
      renderResults();
    },
    onkeydown: (event: KeyboardEvent) => {
      const count = filteredCommands().length;
      if (event.key === 'ArrowDown' && count > 0) {
        event.preventDefault();
        activeIndex = (activeIndex + 1) % count;
        renderResults();
      } else if (event.key === 'ArrowUp' && count > 0) {
        event.preventDefault();
        activeIndex = (activeIndex - 1 + count) % count;
        renderResults();
      } else if (event.key === 'Enter' && count > 0) {
        event.preventDefault();
        runCommand(filteredCommands()[activeIndex]);
      }
    },
  });
  search = input;
  results = h('div', { class: 'command-results', id: 'command-results', role: 'listbox', 'aria-label': 'Commands' });
  const dialog = h(
    'dialog',
    {
      class: 'command-dialog',
      'aria-label': 'Command palette',
      onclose: () => {
        input.value = '';
        activeIndex = 0;
      },
      onclick: (event: MouseEvent) => {
        if (event.target === event.currentTarget && event.currentTarget instanceof HTMLDialogElement) {
          event.currentTarget.close();
        }
      },
    },
    h('div', { class: 'command-box' },
      h('div', { class: 'command-heading' },
        h('span', { class: 'eyebrow' }, 'Quick actions'),
        h('kbd', { class: 'command-esc' }, 'ESC'),
      ),
      input,
      results,
      h('div', { class: 'command-foot' }, '↑↓ move · Enter open'),
    ),
  );
  document.body.append(dialog);
  return dialog;
}

export function openCommandPalette(): void {
  palette ??= createPalette();
  if (palette.open) return;
  activeIndex = 0;
  renderResults();
  palette.showModal();
  search?.focus();
}
